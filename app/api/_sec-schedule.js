// SEC softball schedule source.
//
// The SEC conference site (secsports.com) exposes a JSON:API-style endpoint
// at /api/schedule-events that the Sport/SportScheduleIndex Vue component
// consumes after hydration. It's strictly better than the ESPN team
// schedule feed for SEC teams because:
//
//   1. It covers the entire conference in one request (one cache, one TTL
//      refresh, every SEC team benefits) whereas ESPN requires a per-team
//      call that is slow and frequently misses broadcasts/venues/scores
//      for softball games that weren't televised.
//   2. It ships richer metadata: is_conference flag, AP rank, winner flag,
//      embedded broadcast list, SEC's own tournament titles/rounds, and
//      even the wmt.games match-info block with team records and game
//      leaders. We surface the simple fields now and have room to expose
//      the rich ones later without changing the shape.
//   3. It returns a normalized school_id that we can cross-reference with
//      the wmt.games stats payload if we want to link into a boxscore
//      later on.
//
// Season discovery: the /api/schedules endpoint lists every season the
// conference site has ever had data for. We pick whichever one brackets
// "now" between its start_datetime and end_datetime, falling back to the
// most-recently-started schedule so offseason traffic still resolves to
// the upcoming season.
//
// Pagination: the events endpoint caps per_page at 200. Full 2026 SEC
// softball season is ~630 events (15 teams × ~42 games, counted once
// per event), so we paginate 4 pages on cold start and cache the result
// in module scope for 15 minutes.
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { normalizeTeamKey } from './_wmt.js';

const SPORT_ID_SOFTBALL = 10;
const API_BASE = 'https://www.secsports.com/api';
const TTL_MS = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json',
};

let seasonCache = null;
let seasonCacheAt = 0;
let eventsCache = null;
let eventsCacheAt = 0;
let eventsInFlight = null;

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`SEC API ${r.status}: ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Resolve the current SEC softball season_id by looking at the schedules
// endpoint and picking whichever schedule's start/end range contains now.
// Offseason (June–Jan) falls back to the most recent schedule by start
// date so the upcoming season is ready to serve as soon as the conference
// publishes it.
async function getCurrentSeasonId() {
  if (seasonCache && Date.now() - seasonCacheAt < TTL_MS) return seasonCache;
  const url = `${API_BASE}/schedules?filter%5Bsport_id%5D=${SPORT_ID_SOFTBALL}&per_page=50`;
  const j = await fetchJson(url);
  const rows = Array.isArray(j?.data) ? j.data : [];
  const now = Date.now();
  const inWindow = rows.find((s) => {
    const a = s.start_datetime ? new Date(s.start_datetime).getTime() : null;
    const b = s.end_datetime ? new Date(s.end_datetime).getTime() : null;
    return a != null && b != null && a <= now && now <= b;
  });
  const chosen =
    inWindow
    || rows
        .slice()
        .sort((a, b) => new Date(b.start_datetime || 0) - new Date(a.start_datetime || 0))[0];
  if (!chosen?.season_id) throw new Error('SEC schedules: no season id found');
  seasonCache = chosen.season_id;
  seasonCacheAt = Date.now();
  return seasonCache;
}

// Fetch every SEC softball event for the current season. Paginated because
// the API caps per_page at 200; the full conference season is ~630 events.
// The result is cached at module scope for 15 minutes so warm serverless
// instances skip the upstream call entirely.
async function fetchAllEventsForCurrentSeason() {
  const seasonId = await getCurrentSeasonId();
  const include = [
    'firstOpponent.school',
    'firstOpponent.officialLogo',
    'firstOpponent.customLogo',
    'secondOpponent.school',
    'secondOpponent.officialLogo',
    'secondOpponent.customLogo',
    'scheduleEventBroadcasts',
    'schedule.sport',
  ].join(',');
  const baseParams =
    `per_page=200&sort=datetime` +
    `&filter%5Bschedule.sport_id%5D=${SPORT_ID_SOFTBALL}` +
    `&filter%5Bschedule.season_id%5D=${seasonId}` +
    `&include=${encodeURIComponent(include)}`;

  const firstUrl = `${API_BASE}/schedule-events?${baseParams}&page=1`;
  const first = await fetchJson(firstUrl);
  const all = Array.isArray(first?.data) ? [...first.data] : [];
  const lastPage = first?.meta?.last_page || 1;
  for (let page = 2; page <= lastPage; page++) {
    const url = `${API_BASE}/schedule-events?${baseParams}&page=${page}`;
    const pageJson = await fetchJson(url);
    if (Array.isArray(pageJson?.data)) all.push(...pageJson.data);
  }
  return { seasonId, events: all };
}

async function getEventsCached() {
  if (eventsCache && Date.now() - eventsCacheAt < TTL_MS) return eventsCache;
  if (eventsInFlight) return eventsInFlight;
  eventsInFlight = (async () => {
    try {
      const payload = await fetchAllEventsForCurrentSeason();
      eventsCache = payload;
      eventsCacheAt = Date.now();
      return payload;
    } finally {
      eventsInFlight = null;
    }
  })();
  return eventsInFlight;
}

// Map SEC status strings to the same {state, completed, detail} shape the
// ESPN-derived events use, so the UI can render either source with one
// code path.
function mapStatus(ev) {
  const raw = (ev.status || '').toLowerCase();
  if (raw === 'completed' || raw === 'final') {
    return { state: 'post', completed: true, detail: ev.result_text || 'Final' };
  }
  if (raw === 'in_progress' || raw === 'live' || raw === 'in-progress') {
    return { state: 'in', completed: false, detail: ev.status_text || 'Live' };
  }
  if (raw === 'canceled' || raw === 'cancelled') {
    return { state: 'post', completed: true, detail: 'Canceled' };
  }
  if (raw === 'postponed') {
    return { state: 'pre', completed: false, detail: 'Postponed' };
  }
  // "scheduled" and everything else treated as upcoming.
  return {
    state: 'pre',
    completed: false,
    detail: ev.status_text || ev.tba_text || null,
  };
}

// Extract the display name for an opponent side. SEC stores it either in
// the loaded relationship object (when the opponent is a tracked team) or
// as a flat string on the event (for non-conference opponents that don't
// have a record in the opponents table).
function opponentName(side /* 'first' | 'second' */, ev) {
  const rel = ev[`${side}_opponent`];
  return rel?.name || rel?.long_name || ev[`${side}_opponent_name`] || null;
}

function opponentLogo(side, ev) {
  const rel = ev[`${side}_opponent`];
  return rel?.official_logo?.src || rel?.custom_logo?.src || null;
}

function opponentSchoolId(side, ev) {
  const rel = ev[`${side}_opponent`];
  return rel?.school?.id || rel?.school_id || null;
}

function opponentRanking(side, ev) {
  const v = ev[`${side}_opponent_ranking`];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 99 ? n : null;
}

function toNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize one SEC API event into the same shape the TeamModal Schedule
// tab already renders, resolving "self" vs "opponent" from a set of name
// variants (the team the modal is currently showing).
function normalizeEventForTeam(ev, nameKeySet) {
  const firstName = opponentName('first', ev);
  const secondName = opponentName('second', ev);
  const firstKey = normalizeTeamKey(firstName || '');
  const secondKey = normalizeTeamKey(secondName || '');

  let selfSide = null;
  if (firstKey && nameKeySet.has(firstKey)) selfSide = 'first';
  else if (secondKey && nameKeySet.has(secondKey)) selfSide = 'second';
  if (!selfSide) return null;

  const oppSide = selfSide === 'first' ? 'second' : 'first';
  const selfScore = toNum(ev[`${selfSide}_opponent_score`]);
  const oppScore = toNum(ev[`${oppSide}_opponent_score`]);
  const selfWinner = ev[`${selfSide}_opponent_winner`];
  const selfHome = ev[`${selfSide}_opponent_home_team`];
  const status = mapStatus(ev);
  const finished = status.state === 'post' && !/canceled/i.test(status.detail || '');

  let result = null;
  if (finished) {
    if (typeof selfWinner === 'boolean') {
      result = selfWinner ? 'W' : selfScore != null && oppScore != null && selfScore === oppScore ? 'T' : 'L';
    } else if (selfScore != null && oppScore != null) {
      result = selfScore > oppScore ? 'W' : selfScore < oppScore ? 'L' : 'T';
    }
  }

  const neutral = !!ev.neutral;
  const homeAway = neutral ? 'neutral' : selfHome ? 'home' : 'away';

  const broadcasts = Array.isArray(ev.schedule_event_broadcasts) ? ev.schedule_event_broadcasts : [];
  // SEC ships broadcast data in source_label/media_label (e.g. "SECN+",
  // "ESPN2"). Fall through a few field names because different event
  // types (regular season vs tournament) use slightly different keys.
  const broadcast =
    broadcasts[0]?.media_label ||
    broadcasts[0]?.source_label ||
    broadcasts[0]?.broadcaster_name ||
    broadcasts[0]?.name ||
    null;

  return {
    id: `sec-${ev.id}`,
    date: ev.datetime || null,
    status,
    homeAway,
    neutralSite: neutral,
    opponent: {
      id: opponentSchoolId(oppSide, ev) ? String(opponentSchoolId(oppSide, ev)) : null,
      name: opponentName(oppSide, ev),
      abbreviation: null,
      logo: opponentLogo(oppSide, ev),
      rank: opponentRanking(oppSide, ev),
    },
    score:
      finished && selfScore != null && oppScore != null
        ? { self: selfScore, opp: oppScore, display: `${selfScore}-${oppScore}` }
        : null,
    result,
    venue: ev.venue || null,
    venueCity: ev.location || null,
    broadcast,
    // SEC-only extras that the UI can surface later without another fetch:
    isConference: !!ev.is_conference,
    isExhibition: !!ev.is_exhibition,
    tournamentTitle: ev.tournament_title || null,
  };
}

// Public entry point for team-stats/route.js. Returns a normalized,
// chronologically-sorted schedule array for the team matching any of
// `nameVariants`, or null if no events match (which means the team isn't
// in the SEC payload — caller should fall back to the ESPN path).
export async function getSecTeamSchedule(nameVariants) {
  const variants = Array.isArray(nameVariants) ? nameVariants : [nameVariants];
  const keys = new Set(variants.map(normalizeTeamKey).filter(Boolean));
  if (keys.size === 0) return null;

  let payload;
  try {
    payload = await getEventsCached();
  } catch {
    return null;
  }
  const out = [];
  for (const ev of payload.events) {
    const norm = normalizeEventForTeam(ev, keys);
    if (norm) out.push(norm);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return out;
}
