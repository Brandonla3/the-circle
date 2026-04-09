// Mountain West softball schedule source.
//
// themw.com runs on WordPress with the WMT Stats plugin (the same WMT
// Digital stack that powers the SEC conference sites we pull from for
// sec-stats). The schedule page is a thin shell that calls an
// authenticated-read-free REST endpoint after hydration:
//
//   /wp-json/v1/schedule-events
//     ?start_date=YYYY-MM-DD
//     &end_date=YYYY-MM-DD
//     &per_page=100
//     &page=N
//     &sport_categories[]=21   (WP term id for softball on themw.com)
//
// It returns { data: [event, ...], meta } paginated at 100 per page, so
// a full MW softball season (~390 events across 10 member programs
// plus non-conference opponents) needs 4 pages. Each event ships:
//
//   - home_opponent + road_opponent (school_category.id is non-null
//     only for actual MW programs — that's how we self-gate)
//   - result (win/lose/-), result_text ("Final" or time), home_result
//     and opponent_result (numeric scores as strings)
//   - location (venue city), broadcast_networks, links (boxscore URL)
//   - is_conference_event, is_exhibition_event, is_canceled_game,
//     is_postponed_game, is_upcoming_event, is_tba
//
// Self-gating: the feed contains events for non-MW programs that
// happened to play an MW opponent (e.g. Abilene Christian vs Utah
// State). We require the matching side AND that side's
// school_category.id to be non-null — a non-MW team's name might
// happen to match but its school_category.id will be null and we
// skip it, falling through to the ESPN path.
//
// event_status is always 'neutral' in the payload (Boost the WMT
// plugin doesn't populate it correctly for softball), so we determine
// home/away purely from which side (home_opponent vs road_opponent)
// matches the requesting team.
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { normalizeTeamKey } from './_wmt.js';

const API_BASE = 'https://themw.com';
const ENDPOINT = '/wp-json/v1/schedule-events';
const SPORT_CATEGORY_SOFTBALL = 21;
const PER_PAGE = 100;
const TTL_MS = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json',
};

let eventsCache = null;
let eventsCacheAt = 0;
let eventsInFlight = null;

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`MW ${r.status}: ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function getSeasonWindow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const seasonYear = now.getUTCMonth() >= 5 ? year + 1 : year;
  return {
    start: `${seasonYear}-01-01`,
    end: `${seasonYear}-07-31`,
  };
}

async function fetchAllEventsForCurrentSeason() {
  const { start, end } = getSeasonWindow();
  const all = [];
  // Cap at 10 pages as a sanity net; 4 is the expected value for a full
  // season (~390 events). If we ever hit 10 something is wrong upstream.
  for (let page = 1; page <= 10; page++) {
    const params = new URLSearchParams();
    params.set('start_date', start);
    params.set('end_date', end);
    params.set('per_page', String(PER_PAGE));
    params.set('page', String(page));
    params.append('sport_categories[]', String(SPORT_CATEGORY_SOFTBALL));
    const url = `${API_BASE}${ENDPOINT}?${params.toString()}`;
    const j = await fetchJson(url);
    const rows = Array.isArray(j?.data) ? j.data : [];
    all.push(...rows);
    if (rows.length < PER_PAGE) break;
  }
  return all;
}

async function getEventsCached() {
  if (eventsCache && Date.now() - eventsCacheAt < TTL_MS) return eventsCache;
  if (eventsInFlight) return eventsInFlight;
  eventsInFlight = (async () => {
    try {
      const events = await fetchAllEventsForCurrentSeason();
      eventsCache = events;
      eventsCacheAt = Date.now();
      return events;
    } finally {
      eventsInFlight = null;
    }
  })();
  return eventsInFlight;
}

function mapStatus(ev) {
  if (ev.is_canceled_game) {
    return { state: 'post', completed: true, detail: 'Cancelled' };
  }
  if (ev.is_postponed_game) {
    return { state: 'pre', completed: false, detail: 'Postponed' };
  }
  const r = (ev.result || '').toLowerCase();
  if (r === 'win' || r === 'lose' || r === 'tie') {
    return { state: 'post', completed: true, detail: ev.result_text || 'Final' };
  }
  // Upcoming — result is "-" or null.
  return {
    state: 'pre',
    completed: false,
    detail: ev.is_tba ? ev.tba_text || 'TBA' : ev.event_time || null,
  };
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isMwSide(side) {
  return !!side?.school_category?.id;
}

function matchesVariant(side, nameKeySet) {
  if (!side) return false;
  const candidates = [side.name, side.team_name, side.school_category?.name];
  for (const c of candidates) {
    if (!c) continue;
    const k = normalizeTeamKey(c);
    if (k && nameKeySet.has(k)) return true;
  }
  return false;
}

function firstBroadcast(ev) {
  const arr = ev.broadcast_networks;
  if (!Array.isArray(arr) || arr.length === 0) return ev.broadcast_guide_watch_label || null;
  const item = arr[0];
  if (typeof item === 'string') return item;
  return item?.name || item?.title || item?.label || null;
}

// Normalize one MW event into the shared schedule shape. Returns null if
// the requesting team isn't actually an MW member even if a name matches
// (prevents non-conference opponents from getting a truncated schedule).
function normalizeEventForTeam(ev, nameKeySet) {
  const home = ev.home_opponent || null;
  const road = ev.road_opponent || null;
  if (!home && !road) return null;

  let selfSide = null;
  if (matchesVariant(home, nameKeySet) && isMwSide(home)) selfSide = 'home';
  else if (matchesVariant(road, nameKeySet) && isMwSide(road)) selfSide = 'road';
  if (!selfSide) return null;

  const self = selfSide === 'home' ? home : road;
  const opp = selfSide === 'home' ? road : home;
  const selfScore = toNum(selfSide === 'home' ? ev.home_result : ev.opponent_result);
  const oppScore = toNum(selfSide === 'home' ? ev.opponent_result : ev.home_result);
  const status = mapStatus(ev);
  const finished = status.state === 'post' && !ev.is_canceled_game;

  let result = null;
  if (finished) {
    const r = (ev.result || '').toLowerCase();
    if (r === 'win') result = 'W';
    else if (r === 'lose') result = 'L';
    else if (r === 'tie') result = 'T';
    else if (selfScore != null && oppScore != null) {
      result = selfScore > oppScore ? 'W' : selfScore < oppScore ? 'L' : 'T';
    }
  }

  const homeAway = selfSide === 'home' ? 'home' : 'away';

  return {
    id: `mw-${ev.event_id}`,
    date: ev.event_date || null,
    status,
    homeAway,
    neutralSite: false,
    opponent: {
      id: opp?.school_category?.id != null ? String(opp.school_category.id) : null,
      name: opp?.name || null,
      abbreviation: null,
      logo: opp?.logo?.url || null,
      rank: null,
    },
    score:
      finished && selfScore != null && oppScore != null
        ? { self: selfScore, opp: oppScore, display: `${selfScore}-${oppScore}` }
        : null,
    result,
    venue: null,
    venueCity: ev.location || null,
    broadcast: firstBroadcast(ev),
    isConference: !!ev.is_conference_event,
    isExhibition: !!ev.is_exhibition_event,
    tournamentTitle: null,
  };
}

// Public entry point for team-stats/route.js. Returns a normalized,
// chronologically-sorted schedule array for the team matching any of
// `nameVariants`, or null if no events match (team isn't in the MW
// payload — caller should fall back to the ESPN path).
export async function getMwTeamSchedule(nameVariants) {
  const variants = Array.isArray(nameVariants) ? nameVariants : [nameVariants];
  const keys = new Set(variants.map(normalizeTeamKey).filter(Boolean));
  if (keys.size === 0) return null;

  let events;
  try {
    events = await getEventsCached();
  } catch {
    return null;
  }
  const out = [];
  for (const ev of events) {
    const norm = normalizeEventForTeam(ev, keys);
    if (norm) out.push(norm);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return out;
}
