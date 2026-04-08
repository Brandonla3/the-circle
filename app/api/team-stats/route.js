// Aggregate a D1 softball team's season stats by walking their schedule,
// fetching each completed game's summary from ESPN, and summing counting
// stats from the box scores. Derives rate stats (BA, OBP, ERA, WHIP, K/7)
// from the summed counting stats so they're consistent across the whole
// season, not per-game snapshots.
//
//   GET /api/team-stats?teamId=611
//
// Response:
//   {
//     teamId, teamMeta: { wins, losses, gamesPlayed, runsFor, runsAgainst, streak },
//     totals: {
//       batting: { games, AB, R, H, RBI, HR, BB, K, BA, OBP },
//       pitching: { games, IP, W, L, SV, H, R, ER, BB, K, HR, ERA, WHIP, 'K/7' }
//     },
//     players: {
//       batting: [{ id, name, position, games, AB, R, H, RBI, HR, BB, K, BA, OBP }],
//       pitching: [{ id, name, position, games, IP, W, L, SV, H, R, ER, BB, K, HR, ERA, WHIP, 'K/7' }]
//     },
//     meta: { source, scheduleEvents, completedEvents, gamesProcessed,
//             gamesFailed, gamesSkipped, timeExhausted, elapsedMs }
//   }
//
// ESPN softball box scores don't break out 2B, 3B, SB, HBP, or SF, so SLG
// is not computable and OBP is an approximation that ignores HBP and SF.
// Everything else (BA, ERA, WHIP, K/7) is exact because it only needs the
// counting stats we already have.
//
// Caching:
//   - per-event summary: module-scope Map, 24h TTL for past events,
//     10min TTL for recent (last 7 days) so in-progress stats eventually roll in
//   - per-team aggregate: 5min TTL. Partial scans (time exhausted) are
//     NOT cached; subsequent requests pick up where we left off via the
//     accumulating per-event cache.
//   - in-flight dedupe so concurrent requests for the same team share one scan

import {
  ESPN_SITE,
  ESPN_HEADERS,
  normalize,
  getTeamDirectory,
  findTeam,
  findTeamById,
} from '../_espn.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// --- Caches ---------------------------------------------------------------
const eventSummaryCache = new Map(); // eventId -> { fetchedAt, summary, eventDate }
const teamStatsCache = new Map();    // teamId  -> { fetchedAt, data }
const inFlight = new Map();          // teamId  -> Promise

const EVENT_TTL_OLD_MS = 24 * 60 * 60 * 1000;
const EVENT_TTL_RECENT_MS = 10 * 60 * 1000;
const EVENT_RECENT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const TEAM_TTL_MS = 5 * 60 * 1000;
const SCAN_BUDGET_MS = 7000;
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 100;
const RETRY_DELAYS_MS = [500, 1000, 2000];

// --- Helpers --------------------------------------------------------------
function parseNum(s) {
  if (s == null || s === '' || s === '—') return 0;
  const n = parseFloat(String(s));
  return Number.isFinite(n) ? n : 0;
}

// Softball IP is encoded as "N.f" where f is outs in the current inning:
// "6.0" = 6 innings, "6.1" = 6⅓, "6.2" = 6⅔. Summing IP across games must
// go through outs to round-trip correctly.
function parseIPToOuts(ip) {
  const s = String(ip || '').trim();
  if (!s) return 0;
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return 0;
  const whole = parseInt(m[1], 10) * 3;
  const frac = m[2] ? Math.min(2, parseInt(m[2], 10)) : 0;
  return whole + frac;
}
function outsToIP(outs) {
  const whole = Math.floor(outs / 3);
  const frac = outs % 3;
  return `${whole}.${frac}`;
}
function outsToInnings(outs) {
  return outs / 3;
}

const fmt3 = (n) => (n > 0 ? n.toFixed(3).replace(/^0/, '') : '.000');
const fmt2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');

async function fetchWithRetry(url) {
  let lastStatus = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const r = await fetch(url, { headers: ESPN_HEADERS, cache: 'no-store' });
      lastStatus = r.status;
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      if (r.status < 500 && r.status !== 429) return null;
    } catch (e) {
      lastStatus = 'network';
    }
  }
  return null;
}

function eventCacheValid(entry) {
  if (!entry) return false;
  const age = Date.now() - entry.fetchedAt;
  const eventTs = entry.eventDate ? new Date(entry.eventDate).getTime() : 0;
  const isRecent = eventTs > 0 && Date.now() - eventTs < EVENT_RECENT_THRESHOLD_MS;
  const ttl = isRecent ? EVENT_TTL_RECENT_MS : EVENT_TTL_OLD_MS;
  return age < ttl;
}

async function fetchEventSummary(eventId, eventDate) {
  const id = String(eventId);
  const cached = eventSummaryCache.get(id);
  if (eventCacheValid(cached)) return cached.summary;
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/baseball/college-softball/summary?event=${id}`;
  const data = await fetchWithRetry(url);
  if (data) {
    eventSummaryCache.set(id, { fetchedAt: Date.now(), summary: data, eventDate });
  }
  return data;
}

// --- Box-score parsing ----------------------------------------------------
// Pull the batting + pitching stat lines for a single team out of one
// game's boxscore.players entry. Returns { batting: Map, pitching: Map }
// keyed by athlete id, each with per-game counting stats.
// Find the box-score entry for our team. Tries ID match first, then falls
// back to a normalized name match against any of the variants we know for
// this team. The ID-mismatch fallback exists because ESPN's college softball
// scoreboard endpoint and box-score endpoint sometimes use DIFFERENT team
// ids for the same school (Tennessee uses 611 in both, Oklahoma's scoreboard
// id ≠ its boxscore id, etc). Without the fallback, those teams aggregate
// to zero box scores. Returns { entry, matchedBy } or null.
function findTeamEntry(players, teamId, nameVariantSet) {
  // Pass 1: exact id match — fastest, works for the majority of teams.
  for (const p of players) {
    if (String(p.team?.id ?? '') === String(teamId)) {
      return { entry: p, matchedBy: 'id' };
    }
  }
  // Pass 2: normalized name match against any of the team's known aliases.
  if (nameVariantSet && nameVariantSet.size > 0) {
    for (const p of players) {
      const t = p.team || {};
      const candidates = [t.displayName, t.name, t.shortDisplayName, t.location, t.abbreviation, t.nickname];
      for (const c of candidates) {
        if (!c) continue;
        if (nameVariantSet.has(normalize(c))) {
          return { entry: p, matchedBy: 'name' };
        }
      }
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

function extractTeamFromBoxscore(summary, teamId, nameVariantSet) {
  const players = summary?.boxscore?.players || [];
  const matched = findTeamEntry(players, teamId, nameVariantSet);
  if (!matched) return null;
  const entry = matched.entry;

  const out = { batting: new Map(), pitching: new Map(), matchedBy: matched.matchedBy };

  for (const group of entry.statistics || []) {
    const labels = group.labels || [];
    const isPitching = labels.includes('IP');
    const isBatting = !isPitching && labels.includes('AB');
    if (!isBatting && !isPitching) continue;

    // Index of each label for O(1) lookup
    const idx = {};
    labels.forEach((l, i) => { idx[l] = i; });

    for (const ath of group.athletes || []) {
      const id = String(ath.athlete?.id || '');
      if (!id) continue;
      const stats = ath.stats || [];
      const g = (label) => (idx[label] != null ? stats[idx[label]] : null);

      if (isBatting) {
        const rec = out.batting.get(id) || {
          id,
          name: ath.athlete?.displayName || ath.athlete?.shortName || '',
          position: ath.athlete?.position?.abbreviation || null,
          games: 0,
          AB: 0, R: 0, H: 0, RBI: 0, HR: 0, BB: 0, K: 0,
        };
        rec.games += 1;
        rec.AB += parseNum(g('AB'));
        rec.R += parseNum(g('R'));
        rec.H += parseNum(g('H'));
        rec.RBI += parseNum(g('RBI'));
        rec.HR += parseNum(g('HR'));
        rec.BB += parseNum(g('BB'));
        rec.K += parseNum(g('K') ?? g('SO'));
        out.batting.set(id, rec);
      } else {
        const rec = out.pitching.get(id) || {
          id,
          name: ath.athlete?.displayName || ath.athlete?.shortName || '',
          position: ath.athlete?.position?.abbreviation || null,
          games: 0,
          IPouts: 0,
          W: 0, L: 0, SV: 0,
          H: 0, R: 0, ER: 0, BB: 0, K: 0, HR: 0,
        };
        rec.games += 1;
        rec.IPouts += parseIPToOuts(g('IP'));
        rec.H += parseNum(g('H'));
        rec.R += parseNum(g('R'));
        rec.ER += parseNum(g('ER'));
        rec.BB += parseNum(g('BB'));
        rec.K += parseNum(g('K') ?? g('SO'));
        rec.HR += parseNum(g('HR'));
        // ESPN doesn't consistently expose W/L/SV in the box score stat
        // line; we leave those at 0 and derive team totals from records.
        out.pitching.set(id, rec);
      }
    }
  }
  return out;
}

function mergePlayerMaps(target, incoming) {
  for (const [id, src] of incoming.batting) {
    const t = target.batting.get(id);
    if (!t) {
      target.batting.set(id, { ...src });
    } else {
      t.games += src.games;
      t.AB += src.AB; t.R += src.R; t.H += src.H;
      t.RBI += src.RBI; t.HR += src.HR; t.BB += src.BB; t.K += src.K;
    }
  }
  for (const [id, src] of incoming.pitching) {
    const t = target.pitching.get(id);
    if (!t) {
      target.pitching.set(id, { ...src });
    } else {
      t.games += src.games;
      t.IPouts += src.IPouts;
      t.W += src.W; t.L += src.L; t.SV += src.SV;
      t.H += src.H; t.R += src.R; t.ER += src.ER;
      t.BB += src.BB; t.K += src.K; t.HR += src.HR;
    }
  }
}

// Build player row with derived rate stats from summed counting stats.
function finalizeBatter(p) {
  const BA = p.AB > 0 ? p.H / p.AB : 0;
  // Approximate OBP since ESPN softball box scores don't expose HBP/SF.
  const OBP = (p.AB + p.BB) > 0 ? (p.H + p.BB) / (p.AB + p.BB) : 0;
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    games: p.games,
    AB: p.AB, R: p.R, H: p.H, RBI: p.RBI, HR: p.HR, BB: p.BB, K: p.K,
    BA: fmt3(BA),
    OBP: fmt3(OBP),
    BAraw: BA,
  };
}
function finalizePitcher(p) {
  const innings = outsToInnings(p.IPouts);
  // Softball is a 7-inning game, so per-7 scaling for ERA/K/7.
  const ERA = innings > 0 ? (p.ER * 7) / innings : 0;
  const WHIP = innings > 0 ? (p.BB + p.H) / innings : 0;
  const K7 = innings > 0 ? (p.K * 7) / innings : 0;
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    games: p.games,
    IP: outsToIP(p.IPouts),
    IPouts: p.IPouts,
    H: p.H, R: p.R, ER: p.ER, BB: p.BB, K: p.K, HR: p.HR,
    ERA: fmt2(ERA),
    WHIP: fmt2(WHIP),
    'K/7': fmt2(K7),
    ERAraw: ERA,
  };
}

function finalize(aggregated, recordStats) {
  const batting = [...aggregated.batting.values()].map(finalizeBatter);
  const pitching = [...aggregated.pitching.values()].map(finalizePitcher);
  batting.sort((a, b) => b.AB - a.AB); // most plate appearances first
  pitching.sort((a, b) => b.IPouts - a.IPouts);

  // Team batting totals: sum the counting stats, derive rates from sums.
  const tb = { AB: 0, R: 0, H: 0, RBI: 0, HR: 0, BB: 0, K: 0, games: 0 };
  for (const p of batting) {
    tb.AB += p.AB; tb.R += p.R; tb.H += p.H; tb.RBI += p.RBI;
    tb.HR += p.HR; tb.BB += p.BB; tb.K += p.K;
    tb.games = Math.max(tb.games, p.games);
  }
  const tbBA = tb.AB > 0 ? tb.H / tb.AB : 0;
  const tbOBP = (tb.AB + tb.BB) > 0 ? (tb.H + tb.BB) / (tb.AB + tb.BB) : 0;

  // Team pitching totals.
  const tp = { IPouts: 0, H: 0, R: 0, ER: 0, BB: 0, K: 0, HR: 0, games: 0 };
  for (const p of pitching) {
    tp.IPouts += p.IPouts;
    tp.H += p.H; tp.R += p.R; tp.ER += p.ER;
    tp.BB += p.BB; tp.K += p.K; tp.HR += p.HR;
    tp.games = Math.max(tp.games, p.games);
  }
  const tpInnings = outsToInnings(tp.IPouts);
  const tpERA = tpInnings > 0 ? (tp.ER * 7) / tpInnings : 0;
  const tpWHIP = tpInnings > 0 ? (tp.BB + tp.H) / tpInnings : 0;
  const tpK7 = tpInnings > 0 ? (tp.K * 7) / tpInnings : 0;

  // Record metadata from core.v2 records/0
  const teamMeta = {};
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

  return {
    teamMeta,
    totals: {
      batting: {
        games: tb.games,
        AB: tb.AB, R: tb.R, H: tb.H, RBI: tb.RBI,
        HR: tb.HR, BB: tb.BB, K: tb.K,
        BA: fmt3(tbBA),
        OBP: fmt3(tbOBP),
      },
      pitching: {
        games: tp.games,
        IP: outsToIP(tp.IPouts),
        H: tp.H, R: tp.R, ER: tp.ER, BB: tp.BB, K: tp.K, HR: tp.HR,
        ERA: fmt2(tpERA),
        WHIP: fmt2(tpWHIP),
        'K/7': fmt2(tpK7),
      },
    },
    players: { batting, pitching },
  };
}

// Look up the ESPN team in the directory by id and return the set of
// normalized name variants we'll use as a fallback when the box-score
// team id doesn't match the scoreboard team id (Oklahoma is a known
// case of this — same team, two different ids across endpoints).
async function getTeamNameVariantSet(teamId) {
  try {
    const dir = await getTeamDirectory();
    const team = findTeamById(dir, teamId);
    return buildTeamNameVariantSet(team);
  } catch (e) {
    return new Set();
  }
}

// --- Main computation -----------------------------------------------------
async function computeTeamStats(teamId) {
  const startTime = Date.now();
  const scheduleUrl = `${ESPN_SITE}/teams/${teamId}/schedule`;
  const [schedule, nameVariantSet] = await Promise.all([
    fetchWithRetry(scheduleUrl),
    getTeamNameVariantSet(teamId),
  ]);
  const events = schedule?.events || [];

  // Only completed regular-season games. ESPN tags these as state=post on the
  // competition status, but we also accept status.type.completed === true as
  // a fallback for non-standard shapes.
  const completed = events.filter((ev) => {
    const comp = ev.competitions?.[0];
    const st = comp?.status?.type || ev.status?.type;
    return st?.state === 'post' || st?.completed === true;
  });

  const aggregated = { batting: new Map(), pitching: new Map() };
  let gamesProcessed = 0;
  let gamesFailed = 0;
  let gamesSkipped = 0;
  let gamesWithBatting = 0;   // games that had at least one batter stat line for this team
  let gamesWithPitching = 0;  // games that had at least one pitcher stat line
  let gamesMatchedById = 0;
  let gamesMatchedByName = 0;
  let timeExhausted = false;

  for (let i = 0; i < completed.length; i += BATCH_SIZE) {
    if (Date.now() - startTime > SCAN_BUDGET_MS) {
      timeExhausted = true;
      gamesSkipped = completed.length - i;
      break;
    }
    const batch = completed.slice(i, i + BATCH_SIZE);
    const summaries = await Promise.all(
      batch.map((ev) => fetchEventSummary(ev.id, ev.date))
    );
    for (let k = 0; k < summaries.length; k++) {
      const s = summaries[k];
      if (!s) { gamesFailed++; continue; }
      const extracted = extractTeamFromBoxscore(s, teamId, nameVariantSet);
      if (extracted) {
        mergePlayerMaps(aggregated, extracted);
        gamesProcessed++;
        if (extracted.matchedBy === 'id') gamesMatchedById++;
        else if (extracted.matchedBy === 'name') gamesMatchedByName++;
        if (extracted.batting.size > 0) gamesWithBatting++;
        if (extracted.pitching.size > 0) gamesWithPitching++;
      } else {
        gamesFailed++;
      }
    }
    if (i + BATCH_SIZE < completed.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Supporting metadata (wins, losses, runs, streak) from the records endpoint.
  const season = new Date().getUTCFullYear();
  const recordsUrl = `https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/seasons/${season}/types/2/teams/${teamId}/records/0?lang=en&region=us`;
  const recordsRaw = await fetchWithRetry(recordsUrl);
  const recordStats = recordsRaw?.stats || null;

  const finalized = finalize(aggregated, recordStats);

  return {
    teamId: String(teamId),
    ...finalized,
    meta: {
      source: 'espn-boxscore',
      scheduleEvents: events.length,
      completedEvents: completed.length,
      gamesProcessed,
      gamesWithBatting,
      gamesWithPitching,
      gamesFailed,
      gamesSkipped,
      gamesMatchedById,
      gamesMatchedByName,
      timeExhausted,
      elapsedMs: Date.now() - startTime,
    },
  };
}

async function getTeamStats(teamId) {
  const id = String(teamId);
  const cached = teamStatsCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < TEAM_TTL_MS && !cached.data?.meta?.timeExhausted) {
    return cached.data;
  }
  if (inFlight.has(id)) return inFlight.get(id);

  const promise = (async () => {
    const data = await computeTeamStats(id);
    // Only cache complete scans for the full TTL. Partial scans get a short
    // grace so the next request re-runs and picks up where we left off.
    if (!data.meta.timeExhausted) {
      teamStatsCache.set(id, { fetchedAt: Date.now(), data });
    }
    return data;
  })();

  inFlight.set(id, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(id);
  }
}

// Debug-mode scan: same shape as computeTeamStats but captures rich
// per-event diagnostics so we can see WHY a team is showing up empty.
// Bypasses the team-stats cache (we want fresh data) but still uses the
// per-event summary cache so it doesn't re-hit ESPN if we already have it.
async function computeTeamStatsDebug(teamId) {
  const startTime = Date.now();
  const scheduleUrl = `${ESPN_SITE}/teams/${teamId}/schedule`;
  const [schedule, nameVariantSet, dirEntry] = await Promise.all([
    fetchWithRetry(scheduleUrl),
    getTeamNameVariantSet(teamId),
    (async () => {
      try { const dir = await getTeamDirectory(); return findTeamById(dir, teamId); }
      catch { return null; }
    })(),
  ]);
  const events = schedule?.events || [];

  const completed = events.filter((ev) => {
    const comp = ev.competitions?.[0];
    const st = comp?.status?.type || ev.status?.type;
    return st?.state === 'post' || st?.completed === true;
  });

  const eventDiagnostics = [];
  let gamesWithBatting = 0;
  let gamesWithPitching = 0;
  let gamesMatchedById = 0;
  let gamesMatchedByName = 0;
  let timeExhausted = false;
  let firstEventFullSnapshot = null;
  let firstEventWithAthletes = null;

  for (let i = 0; i < completed.length; i += BATCH_SIZE) {
    if (Date.now() - startTime > SCAN_BUDGET_MS) {
      timeExhausted = true;
      break;
    }
    const batch = completed.slice(i, i + BATCH_SIZE);
    const summaries = await Promise.all(
      batch.map((ev) => fetchEventSummary(ev.id, ev.date))
    );
    for (let k = 0; k < summaries.length; k++) {
      const ev = batch[k];
      const s = summaries[k];
      if (!s) {
        eventDiagnostics.push({
          eventId: String(ev.id),
          name: ev.shortName || ev.name,
          date: ev.date,
          summaryFetched: false,
          reason: 'fetch returned null',
        });
        continue;
      }
      const players = s.boxscore?.players || [];
      const teamSlots = players.map((p) => ({
        id: String(p.team?.id ?? ''),
        name: p.team?.displayName || p.team?.name || '',
        statsGroups: (p.statistics || []).map((g) => ({
          name: g.name || g.text || null,
          labels: g.labels || null,
          athleteCount: g.athletes?.length || 0,
        })),
      }));

      // Try the real extraction (id-first, name-fallback) and capture how
      // it matched (or failed) so we can see in the response which path
      // was needed for this team.
      const extracted = extractTeamFromBoxscore(s, teamId, nameVariantSet);
      const matchedBy = extracted?.matchedBy || null;
      const extractedBatting = extracted?.batting?.size || 0;
      const extractedPitching = extracted?.pitching?.size || 0;
      if (extracted) {
        if (matchedBy === 'id') gamesMatchedById++;
        else if (matchedBy === 'name') gamesMatchedByName++;
        if (extractedBatting > 0) gamesWithBatting++;
        if (extractedPitching > 0) gamesWithPitching++;
      }

      // Capture full structural snapshot of the FIRST event so we can see
      // exactly what other fields ESPN ships besides boxscore.players. Most
      // importantly: does boxscore.teams[] have stats data even when the
      // per-player breakdown is empty?
      if (!firstEventFullSnapshot) {
        const bs = s.boxscore || {};
        firstEventFullSnapshot = {
          eventId: String(ev.id),
          name: ev.shortName || ev.name,
          date: ev.date,
          summaryTopLevelKeys: Object.keys(s).slice(0, 30),
          boxscoreTopLevelKeys: Object.keys(bs).slice(0, 30),
          // boxscore.teams[] is per-team rollups; this is where some sports
          // ship team-level totals separate from per-player rows.
          boxscoreTeams: (bs.teams || []).map((t) => ({
            teamId: String(t.team?.id ?? ''),
            teamName: t.team?.displayName || t.team?.name || '',
            homeAway: t.homeAway || null,
            statisticsCount: Array.isArray(t.statistics) ? t.statistics.length : null,
            statisticsKeys: Array.isArray(t.statistics)
              ? t.statistics.slice(0, 50).map((st) => ({
                  name: st.name || null,
                  abbreviation: st.abbreviation || null,
                  displayValue: st.displayValue || null,
                  value: st.value ?? null,
                  label: st.label || null,
                }))
              : null,
          })),
          // Linescore innings and totals — sometimes lives at root or in boxscore
          linescore: bs.linescore || s.linescore || null,
          // Anything else interesting?
          hasLeaders: !!s.leaders,
          hasLeadersData: Array.isArray(s.leaders) ? s.leaders.length : null,
          hasGameInfo: !!s.gameInfo,
        };
      }
      // Also capture the first event we find that DOES have player athletes,
      // so we can compare its shape side-by-side.
      if (!firstEventWithAthletes && extracted && (extractedBatting > 0 || extractedPitching > 0)) {
        const bs = s.boxscore || {};
        firstEventWithAthletes = {
          eventId: String(ev.id),
          name: ev.shortName || ev.name,
          date: ev.date,
          extractedBatting,
          extractedPitching,
          boxscoreTeamsHaveStats: (bs.teams || []).some((t) => Array.isArray(t.statistics) && t.statistics.length > 0),
        };
      }

      eventDiagnostics.push({
        eventId: String(ev.id),
        name: ev.shortName || ev.name,
        date: ev.date,
        summaryFetched: true,
        boxscoreTeamCount: teamSlots.length,
        teamSlots,
        teamMatched: !!extracted,
        matchedBy,
        extractedBatting,
        extractedPitching,
      });
    }
    if (i + BATCH_SIZE < completed.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return {
    teamId: String(teamId),
    teamDisplayName: dirEntry?.displayName || null,
    season: new Date().getUTCFullYear(),
    scheduleUrl,
    nameVariants: Array.from(nameVariantSet),
    summary: {
      scheduleEvents: events.length,
      completedEvents: completed.length,
      diagnosed: eventDiagnostics.length,
      timeExhausted,
      elapsedMs: Date.now() - startTime,
      gamesWithBatting,
      gamesWithPitching,
      gamesMatchedById,
      gamesMatchedByName,
      gamesWhereTeamMatched: eventDiagnostics.filter((e) => e.teamMatched).length,
      gamesWhereTeamMissing: eventDiagnostics.filter((e) => e.summaryFetched && !e.teamMatched).length,
      gamesWhereSummaryFailed: eventDiagnostics.filter((e) => !e.summaryFetched).length,
    },
    scheduleSample: completed.slice(0, 5).map((ev) => ({
      id: String(ev.id),
      date: ev.date,
      shortName: ev.shortName,
      competitorIds: ev.competitions?.[0]?.competitors?.map((c) => String(c.team?.id || c.id || '')) || [],
      statusState: ev.competitions?.[0]?.status?.type?.state || null,
    })),
    firstEventFullSnapshot,
    firstEventWithAthletes,
    eventDiagnostics: eventDiagnostics.slice(0, 10),
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  let teamId = searchParams.get('teamId');
  const teamName = searchParams.get('team');
  const debug = searchParams.get('debug');

  // Allow ?team=Oklahoma so callers don't need to know the numeric ESPN id.
  // Resolves through the shared team directory the same way the player-photo
  // and team-roster routes do.
  if (!teamId && teamName) {
    try {
      const dir = await getTeamDirectory();
      const t = findTeam(dir, teamName);
      if (!t) {
        return Response.json(
          { error: `team '${teamName}' not found in ESPN directory` },
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
    if (debug) {
      const data = await computeTeamStatsDebug(teamId);
      return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
    }
    const data = await getTeamStats(teamId);
    return Response.json(data, {
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
