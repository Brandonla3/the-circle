// Full-season team schedule built from ESPN's daily scoreboard endpoint.
//
// The per-team ESPN schedule endpoint (teams/{id}/schedule) is unreliable
// for college softball. The daily scoreboard endpoint is the one the main
// app already calls successfully for live scores — we reuse it here by
// fetching every day of the season in parallel and filtering per team.
//
// Tries a single season-range request first (?dates=YYYYMMDD-YYYYMMDD).
// If ESPN returns events for that range we're done in one round-trip.
// If not (ESPN may not support ranges for this league), we fall back to
// one request per calendar day — all fired in parallel so the total wall
// time is bounded by the slowest single response, not by day count.
//
// NOT a route — Next.js only treats literal route.js files as endpoints.

import { normalizeTeamKey } from './_wmt.js';

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball/scoreboard';
const ESPN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json',
};
const TTL_MS = 15 * 60 * 1000;

let seasonCache = null;
let seasonCacheAt = 0;
let seasonInFlight = null;

function getSeasonWindow() {
  const now = new Date();
  const year = now.getUTCMonth() >= 7 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return { year, start: `${year}0201`, end: `${year}0630` };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

async function fetchScoreboardUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { headers: ESPN_HEADERS, signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) return [];
    const data = await r.json();
    return data.events || [];
  } catch {
    clearTimeout(t);
    return [];
  }
}

async function fetchAllEvents() {
  const { year, start, end } = getSeasonWindow();

  // One-shot range request — ESPN supports YYYYMMDD-YYYYMMDD for some leagues.
  const rangeEvents = await fetchScoreboardUrl(`${ESPN_SCOREBOARD}?dates=${start}-${end}&limit=9999`);
  if (rangeEvents.length > 0) return rangeEvents;

  // Fall back to parallel day-by-day requests.
  const startD = new Date(Date.UTC(year, 1, 1));  // Feb 1
  const endD   = new Date(Date.UTC(year, 5, 30)); // Jun 30
  const fetches = [];
  for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
    const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    fetches.push(fetchScoreboardUrl(`${ESPN_SCOREBOARD}?dates=${ymd}&limit=200`));
  }
  const results = await Promise.all(fetches);
  return results.flat();
}

async function getAllEventsCached() {
  if (seasonCache && Date.now() - seasonCacheAt < TTL_MS) return seasonCache;
  if (seasonInFlight) return seasonInFlight;
  seasonInFlight = (async () => {
    try {
      const events = await fetchAllEvents();
      seasonCache = events;
      seasonCacheAt = Date.now();
      return events;
    } finally {
      seasonInFlight = null;
    }
  })();
  return seasonInFlight;
}

function normalizeEvent(event, nameKeySet) {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const self = competitors.find((c) => {
    const k = normalizeTeamKey(c.team?.displayName || c.team?.name || '');
    return k && nameKeySet.has(k);
  });
  const opp = competitors.find((c) => {
    const k = normalizeTeamKey(c.team?.displayName || c.team?.name || '');
    return !(k && nameKeySet.has(k));
  });
  if (!self || !opp) return null;

  const statusType = competition.status?.type;
  const statusState = statusType?.state || 'pre';
  const completed   = statusType?.completed || false;
  const detail      = statusType?.shortDetail || statusType?.detail || null;

  const selfScore = completed ? parseInt(self.score, 10) : null;
  const oppScore  = completed ? parseInt(opp.score,  10) : null;
  const scoresOk  = Number.isFinite(selfScore) && Number.isFinite(oppScore);

  let result = null;
  if (completed && scoresOk) {
    if (self.winner === true)     result = 'W';
    else if (opp.winner === true) result = 'L';
    else result = selfScore > oppScore ? 'W' : selfScore < oppScore ? 'L' : 'T';
  }

  const addr = competition.venue?.address;
  return {
    id:          `espn-sb-${event.id}`,
    date:        event.date || competition.date || null,
    status:      { state: statusState, completed, detail },
    homeAway:    self.homeAway || null,
    neutralSite: competition.neutralSite || false,
    opponent: {
      id:           opp.team?.id ? String(opp.team.id) : null,
      name:         opp.team?.displayName || opp.team?.name || null,
      abbreviation: opp.team?.abbreviation || null,
      logo:         opp.team?.logo || null,
      rank:         opp.curatedRank?.current ?? null,
    },
    score: completed && scoresOk
      ? { self: selfScore, opp: oppScore, display: `${selfScore}-${oppScore}` }
      : null,
    result,
    venue:           competition.venue?.fullName || null,
    venueCity:       addr ? [addr.city, addr.state].filter(Boolean).join(', ') : null,
    broadcast:       competition.broadcasts?.[0]?.names?.[0] || null,
    isConference:    competition.conferenceCompetition || false,
    isExhibition:    false,
    tournamentTitle: null,
  };
}

export async function getEspnScoreboardSchedule(nameVariants) {
  const variants = Array.isArray(nameVariants) ? nameVariants : [nameVariants];
  const keys = new Set(variants.map(normalizeTeamKey).filter(Boolean));
  if (keys.size === 0) return null;

  let events;
  try {
    events = await getAllEventsCached();
  } catch {
    return null;
  }

  const out = [];
  for (const ev of events) {
    const norm = normalizeEvent(ev, keys);
    if (norm) out.push(norm);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return out;
}
