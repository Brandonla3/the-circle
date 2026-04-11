// Per-team softball stats aggregator.
//
//   GET /api/team-stats?teamId=611
//   GET /api/team-stats?team=Oklahoma
//
// Data sources:
//   • Team Totals / Player rows — conference stats scrapes via WMT Games
//     (see app/api/_wmt-stats.js). A single HTTP request per conference
//     ships the FULL roster + team totals — no rate limiting, no top-50
//     slicing, no 7-second budgets. Teams in conferences not yet in the
//     WMT catalog show empty stats (UI falls back to "—" placeholders).
//   • Season record (W-L, runs for/against, streak) — ESPN core.v2
//     records endpoint. Always populated.
//   • Schedule + event counts — ESPN team schedule endpoint. Conference-
//     specific schedule scrapers (SEC, Big 12, ACC, Big Ten, Mountain
//     West) take priority over ESPN for schedule rendering because they
//     ship richer broadcast / venue metadata.
//
// NCAA leaderboards are NOT used here anymore. They were slow (~6-14s
// cold), rate-limited (ncaa-api.henrygd.me throttles at 5-6 concurrent),
// top-50-only (bench players invisible), and the user explicitly asked
// us to switch to conference scrapes. The WMT path is ~1-3s cold and
// covers every player on every team in the catalog.
//
// Response shape:
//   {
//     teamId, conference,
//     teamMeta: { wins, losses, gamesPlayed, runsFor, runsAgainst, streak, winPct },
//     totals: {
//       batting: { BA, OBP, SLG, HR, RBI, H, SB, ... },
//       pitching: { ERA, WHIP, 'K/7', SHO, ... }
//     },
//     players: {
//       batting: [{ id, name, position, classYear, games, AB, H, HR, RBI, BA, ... }],
//       pitching: [{ id, name, position, classYear, games, IP, K, W, ERA, SHO, ... }]
//     },
//     schedule: [...],  // per-game array for TeamModal
//     scheduleSource: 'sec' | 'big12' | 'acc' | 'big10' | 'mw' | 'espn',
//     conferenceStats: {...} | null,  // raw WMT payload for richer views
//     meta: { source, scheduleEvents, completedEvents, elapsedMs }
//   }

import {
  ESPN_SITE,
  ESPN_HEADERS,
  normalize,
  getTeamDirectory,
  findTeam,
  findTeamById,
} from '../_espn.js';
import {
  getConferenceTeamStats,
  hasConferenceStats,
  WMT_CONFERENCES,
} from '../_wmt-stats.js';
import { getSecTeamSchedule } from '../_sec-schedule.js';
import { getBig12TeamSchedule } from '../_big12-schedule.js';
import { getAccTeamSchedule } from '../_acc-schedule.js';
import { getBig10TeamSchedule } from '../_big10-schedule.js';
import { getMwTeamSchedule } from '../_mw-schedule.js';
import { lookupConference } from '../_conferences.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// --- Caches ---------------------------------------------------------------
function pruneMap(map, max) {
  if (map.size <= max) return;
  const excess = map.size - max;
  const iter = map.keys();
  for (let i = 0; i < excess; i++) map.delete(iter.next().value);
}

const teamStatsCache = new Map();    // teamId  -> { fetchedAt, data }
const TEAM_STATS_CACHE_MAX = 100;
const inFlight = new Map();          // teamId  -> Promise

// 30-minute in-process cache. Conference stats update once daily and
// the inner WMT cache is 15 min, so 30 min here is a comfortable
// overlap that avoids redundant re-scans from the same warm Lambda.
const TEAM_TTL_MS = 30 * 60 * 1000;
const ESPN_RETRY_DELAYS_MS = [500, 1000, 2000];

// Retry wrapper for ESPN endpoints (schedule, records). Backoff on 5xx
// and 429; treat 404 and other 4xx as permanent null.
async function fetchWithRetry(url) {
  for (let attempt = 0; attempt <= ESPN_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, ESPN_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const r = await fetch(url, { headers: ESPN_HEADERS, cache: 'no-store' });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      if (r.status < 500 && r.status !== 429) return null;
    } catch {
      // network error — fall through to retry
    }
  }
  return null;
}

function buildTeamNameVariantSet(espnTeam) {
  if (!espnTeam) return new Set();
  const variants = [
    espnTeam.displayName,
    espnTeam.name,
    espnTeam.shortDisplayName,
    espnTeam.location,
    espnTeam.nickname,
    espnTeam.abbreviation,
  ];
  const set = new Set();
  for (const v of variants) {
    const n = normalize(v || '');
    if (n) set.add(n);
  }
  return set;
}

// Look up the ESPN team in the directory by id and return the set of
// normalized name variants used for name-matching against WMT conference
// payloads (which key rows by school name, not by any numeric id).
async function getTeamInfo(teamId) {
  try {
    const dir = await getTeamDirectory();
    const team = findTeamById(dir, teamId);
    return {
      team,
      variants: buildTeamNameVariantSet(team),
    };
  } catch {
    return { team: null, variants: new Set() };
  }
}

// --- WMT row normalization -----------------------------------------------
//
// WMT team-totals and player-stats rows are keyed by the source column
// label (e.g. 'AVG', not 'BA'). The rest of the app — renderTotals() in
// page.js, etc. — expects canonical keys like BA/OBP/SLG/ERA/WHIP. These
// helpers map each WMT row into the canonical shape so the UI can render
// without knowing about WMT's naming.
//
// Each mapping accepts a list of candidate WMT labels to try in order,
// which handles small differences between conferences (e.g. 'K' vs 'SO',
// 'K/7' vs 'SO/7' vs 'K9').

function pickLabel(row, candidates) {
  if (!row) return null;
  for (const c of candidates) {
    if (row[c] != null && row[c] !== '') return row[c];
  }
  return null;
}

function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function toFloat(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeWmtBattingTotals(row) {
  if (!row) return {};
  return {
    BA:  pickLabel(row, ['BA', 'AVG']),
    OBP: pickLabel(row, ['OBP']),
    SLG: pickLabel(row, ['SLG']),
    HR:  toInt(pickLabel(row, ['HR'])),
    RBI: toInt(pickLabel(row, ['RBI'])),
    H:   toInt(pickLabel(row, ['H'])),
    R:   toInt(pickLabel(row, ['R'])),
    SB:  toInt(pickLabel(row, ['SB'])),
    '2B': toInt(pickLabel(row, ['2B'])),
    '3B': toInt(pickLabel(row, ['3B'])),
    BB:  toInt(pickLabel(row, ['BB'])),
    K:   toInt(pickLabel(row, ['SO', 'K'])),
    AB:  toInt(pickLabel(row, ['AB'])),
  };
}

function normalizeWmtPitchingTotals(row) {
  if (!row) return {};
  return {
    ERA:   pickLabel(row, ['ERA']),
    WHIP:  pickLabel(row, ['WHIP']),
    'K/7': pickLabel(row, ['K/7', 'SO/7', 'K9', 'SO/9']),
    SHO:   toInt(pickLabel(row, ['SHO'])),
    IP:    pickLabel(row, ['IP']),
    W:     toInt(pickLabel(row, ['W'])),
    L:     toInt(pickLabel(row, ['L'])),
    SV:    toInt(pickLabel(row, ['SV'])),
    K:     toInt(pickLabel(row, ['SO', 'K'])),
    BB:    toInt(pickLabel(row, ['BB'])),
    ER:    toInt(pickLabel(row, ['ER'])),
    H:     toInt(pickLabel(row, ['H'])),
    R:     toInt(pickLabel(row, ['R'])),
  };
}

function wmtNormalizeYear(yr) {
  const y = (yr || '').trim().toLowerCase();
  if (y === 'sr') return 'Sr.';
  if (y === 'jr') return 'Jr.';
  if (y === 'so') return 'So.';
  if (y === 'fr') return 'Fr.';
  return yr || null;
}

function normalizeWmtPlayers(wmtPlayers, teamDisplayName) {
  const batting = [];
  const pitching = [];

  for (const row of wmtPlayers?.hitting || []) {
    const rawName = pickLabel(row, ['Player', 'Name']);
    if (!rawName) continue;
    batting.push({
      id:         normalize(rawName),
      name:       rawName,
      team:       teamDisplayName,
      jersey:     pickLabel(row, ['#', 'No.', 'Jersey']),
      photoUrl:   null,
      position:   pickLabel(row, ['Pos']),
      classYear:  wmtNormalizeYear(pickLabel(row, ['Yr'])),
      hometown:       null,
      highSchool:     null,
      previousSchool: null,
      heightDisplay:  null,
      weight:         null,
      batThrows:      null,
      games: toInt(pickLabel(row, ['G', 'GP'])),
      AB:  toInt(pickLabel(row, ['AB'])),
      R:   toInt(pickLabel(row, ['R'])),
      H:   toInt(pickLabel(row, ['H'])),
      RBI: toInt(pickLabel(row, ['RBI'])),
      HR:  toInt(pickLabel(row, ['HR'])),
      BB:  toInt(pickLabel(row, ['BB'])),
      K:   toInt(pickLabel(row, ['SO', 'K'])),
      SB:  toInt(pickLabel(row, ['SB'])),
      '2B': toInt(pickLabel(row, ['2B'])),
      '3B': toInt(pickLabel(row, ['3B'])),
      BA:  pickLabel(row, ['BA', 'AVG']),
      OBP: pickLabel(row, ['OBP']),
      SLG: pickLabel(row, ['SLG']),
    });
  }

  for (const row of wmtPlayers?.pitching || []) {
    const rawName = pickLabel(row, ['Player', 'Name']);
    if (!rawName) continue;
    pitching.push({
      id:         normalize(rawName),
      name:       rawName,
      team:       teamDisplayName,
      jersey:     pickLabel(row, ['#', 'No.', 'Jersey']),
      photoUrl:   null,
      position:   'P',
      classYear:  wmtNormalizeYear(pickLabel(row, ['Yr'])),
      hometown:       null,
      highSchool:     null,
      previousSchool: null,
      heightDisplay:  null,
      weight:         null,
      batThrows:      null,
      games: toInt(pickLabel(row, ['App', 'G', 'GP'])),
      IP:    pickLabel(row, ['IP']),
      K:     toInt(pickLabel(row, ['SO', 'K'])),
      BB:    toInt(pickLabel(row, ['BB'])),
      ER:    toInt(pickLabel(row, ['ER'])),
      H:     toInt(pickLabel(row, ['H'])),
      R:     toInt(pickLabel(row, ['R'])),
      W:     toInt(pickLabel(row, ['W'])),
      L:     toInt(pickLabel(row, ['L'])),
      SV:    toInt(pickLabel(row, ['SV'])),
      SHO:   toInt(pickLabel(row, ['SHO'])),
      ERA:   pickLabel(row, ['ERA']),
      WHIP:  pickLabel(row, ['WHIP']),
      'K/7': pickLabel(row, ['K/7', 'SO/7', 'K9', 'SO/9']),
    });
  }

  // Sort: batters by BA desc; pitchers by ERA asc (nulls last).
  const baNum  = (p) => parseFloat(p.BA)  || 0;
  const eraNum = (p) => { const v = parseFloat(p.ERA); return Number.isFinite(v) ? v : 99; };
  batting.sort((a, b) => baNum(b) - baNum(a) || a.name.localeCompare(b.name));
  pitching.sort((a, b) => eraNum(a) - eraNum(b) || a.name.localeCompare(b.name));

  return { batting, pitching };
}

// --- Main computation -----------------------------------------------------
async function computeTeamStats(teamId) {
  const startTime = Date.now();
  const scheduleUrl = `${ESPN_SITE}/teams/${teamId}/schedule`;
  const season = new Date().getUTCFullYear();
  const recordsUrl = `https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/seasons/${season}/types/2/teams/${teamId}/records/0?lang=en&region=us`;

  // Resolve the team + variants first. We need the canonical conference
  // label (from _conferences.js) to pick the right WMT payload, and the
  // name variants so WMT's team-name keys match across spelling quirks.
  const { team, variants: nameVariantSet } = await getTeamInfo(teamId);
  const conference =
    lookupConference(team?.location) ||
    lookupConference(team?.displayName) ||
    lookupConference(team?.shortDisplayName) ||
    null;

  // Only fetch WMT stats if the team's conference has a confirmed WMT
  // source. Otherwise skip entirely — no point paying for a conference
  // payload we know won't match.
  const wmtStatsPromise = conference && hasConferenceStats(conference)
    ? getConferenceTeamStats(conference, Array.from(nameVariantSet)).catch(() => null)
    : Promise.resolve(null);

  const [
    schedule,
    recordsRaw,
    wmtStats,
    secSchedule,
    big12Schedule,
    accSchedule,
    big10Schedule,
    mwSchedule,
  ] = await Promise.all([
    fetchWithRetry(scheduleUrl),
    fetchWithRetry(recordsUrl),
    wmtStatsPromise,
    getSecTeamSchedule(Array.from(nameVariantSet)).catch(() => null),
    getBig12TeamSchedule(Array.from(nameVariantSet)).catch(() => null),
    getAccTeamSchedule(Array.from(nameVariantSet)).catch(() => null),
    getBig10TeamSchedule(Array.from(nameVariantSet)).catch(() => null),
    getMwTeamSchedule(Array.from(nameVariantSet)).catch(() => null),
  ]);

  const events = schedule?.events || [];
  const completed = events.filter((ev) => {
    const comp = ev.competitions?.[0];
    const st = comp?.status?.type || ev.status?.type;
    return st?.state === 'post' || st?.completed === true;
  });

  // Normalized per-game schedule for the TeamModal Schedule tab.
  const scheduleGames = events.map((ev) => {
    const comp = ev.competitions?.[0] || {};
    const st = comp.status?.type || ev.status?.type || {};
    const competitors = comp.competitors || [];
    const self = competitors.find((c) => String(c.team?.id) === String(teamId)) || null;
    const opp = competitors.find((c) => String(c.team?.id) !== String(teamId)) || null;
    const selfScore = self?.score?.value;
    const oppScore = opp?.score?.value;
    const finished = st.state === 'post' || st.completed === true;
    let result = null;
    if (finished && selfScore != null && oppScore != null) {
      result = selfScore > oppScore ? 'W' : selfScore < oppScore ? 'L' : 'T';
    }
    return {
      id: ev.id,
      date: ev.date || comp.date || null,
      status: {
        state: st.state || null,
        completed: !!st.completed,
        detail: st.shortDetail || st.detail || null,
      },
      homeAway: self?.homeAway || null,
      neutralSite: !!comp.neutralSite,
      opponent: opp
        ? {
            id: opp.team?.id ? String(opp.team.id) : null,
            name: opp.team?.displayName || opp.team?.shortDisplayName || null,
            abbreviation: opp.team?.abbreviation || null,
            logo: opp.team?.logos?.[0]?.href || opp.team?.logo || null,
            rank: opp.curatedRank?.current && opp.curatedRank.current < 99 ? opp.curatedRank.current : null,
          }
        : null,
      score: finished && selfScore != null && oppScore != null
        ? { self: selfScore, opp: oppScore, display: `${selfScore}-${oppScore}` }
        : null,
      result,
      venue: comp.venue?.fullName || null,
      venueCity:
        [comp.venue?.address?.city, comp.venue?.address?.state].filter(Boolean).join(', ') || null,
      broadcast: comp.broadcasts?.[0]?.media?.shortName
        || (comp.broadcasts?.[0]?.names?.[0] || null),
    };
  });

  // teamMeta comes from the ESPN core.v2 records endpoint — reliable for
  // every D1 team regardless of television coverage.
  const teamMeta = {};
  const recordStats = recordsRaw?.stats || null;
  if (recordStats) {
    for (const s of recordStats) {
      if (s.name === 'wins') teamMeta.wins = s.value;
      else if (s.name === 'losses') teamMeta.losses = s.value;
      else if (s.name === 'gamesPlayed') teamMeta.gamesPlayed = s.value;
      else if (s.name === 'pointsFor') teamMeta.runsFor = s.value;
      else if (s.name === 'pointsAgainst') teamMeta.runsAgainst = s.value;
      else if (s.name === 'streak') teamMeta.streak = s.displayValue || String(s.value);
      else if (s.name === 'winPercent') teamMeta.winPct = s.value;
    }
  }

  // Team totals + player rows come straight from WMT when available.
  // Everything is NULL for teams without WMT coverage — the UI
  // handles this by rendering "—" placeholders.
  const totals = {
    batting:  normalizeWmtBattingTotals(wmtStats?.totals?.batting),
    pitching: normalizeWmtPitchingTotals(wmtStats?.totals?.pitching),
  };
  const players = wmtStats
    ? normalizeWmtPlayers(wmtStats.players, wmtStats.name || team?.displayName || '')
    : { batting: [], pitching: [] };

  return {
    teamId: String(teamId),
    conference,
    teamMeta,
    totals,
    players,
    // Pass through the raw WMT payload for any richer views that want
    // the full conference-level column set (helpText, sortValue, etc).
    conferenceStats: wmtStats || null,
    // Normalized per-game schedule for the TeamModal Schedule sub-tab.
    // Conference feeds win over ESPN when the team is actually a member
    // of that conference (the conference scrapers self-gate on membership).
    schedule:
      wmtStats && secSchedule && secSchedule.length > 0
        ? secSchedule
        : big12Schedule && big12Schedule.length > 0
        ? big12Schedule
        : accSchedule && accSchedule.length > 0
        ? accSchedule
        : big10Schedule && big10Schedule.length > 0
        ? big10Schedule
        : mwSchedule && mwSchedule.length > 0
        ? mwSchedule
        : scheduleGames,
    scheduleSource:
      wmtStats && secSchedule && secSchedule.length > 0
        ? 'sec'
        : big12Schedule && big12Schedule.length > 0
        ? 'big12'
        : accSchedule && accSchedule.length > 0
        ? 'acc'
        : big10Schedule && big10Schedule.length > 0
        ? 'big10'
        : mwSchedule && mwSchedule.length > 0
        ? 'mw'
        : 'espn',
    meta: {
      source: wmtStats ? `espn-records+wmt-${wmtStats.conference || conference}` : 'espn-records-only',
      scheduleEvents: events.length,
      completedEvents: completed.length,
      elapsedMs: Date.now() - startTime,
      conference,
      conferenceHasStats: !!(conference && hasConferenceStats(conference)),
      wmtMatched: !!wmtStats,
    },
  };
}

async function getTeamStats(teamId) {
  const id = String(teamId);
  const cached = teamStatsCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < TEAM_TTL_MS) {
    return cached.data;
  }
  if (inFlight.has(id)) return inFlight.get(id);

  const promise = (async () => {
    const data = await computeTeamStats(id);
    teamStatsCache.set(id, { fetchedAt: Date.now(), data });
    pruneMap(teamStatsCache, TEAM_STATS_CACHE_MAX);
    return data;
  })();

  inFlight.set(id, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(id);
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  let teamId = searchParams.get('teamId');
  const teamName = searchParams.get('team');

  // Allow ?team=Oklahoma so callers don't need to know the numeric ESPN id.
  if (!teamId && teamName) {
    const safeName = String(teamName).slice(0, 100);
    try {
      const dir = await getTeamDirectory();
      const t = findTeam(dir, teamName);
      if (!t) {
        return Response.json(
          { error: `team '${safeName}' not found in ESPN directory` },
          { status: 404 }
        );
      }
      teamId = String(t.id);
    } catch (e) {
      return Response.json({ error: `team directory lookup failed: ${e.message}` }, { status: 500 });
    }
  }

  if (!teamId) {
    return Response.json({ error: 'teamId or team query param required' }, { status: 400 });
  }

  try {
    const data = await getTeamStats(teamId);
    return Response.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
