// Big 12 softball schedule source.
//
// big12sports.com is a Sidearm Sports property (Microsoft-IIS + ASP.NET +
// knockout/require.js front-end). The /calendar.aspx page server-renders
// only a single placeholder row — the real games are lazy-loaded via a
// Knockout view-model after hydration. The endpoint it calls is:
//
//   /services/responsive-calendar.ashx
//     ?start=YYYY-MM-DD
//     &end=YYYY-MM-DD HH:mm:ss
//     &sport_id=12          (softball)
//     &school_id=0          (0 = all Big 12 schools)
//
// It returns a flat JSON array of game objects — one per school per game,
// so a Big-12-vs-Big-12 matchup shows up twice (once for each school as
// `school`, the other as `opponent`). That's actually fine for our use
// case because we always filter by the requesting team's name variants
// against `ev.school.title`.
//
// Why this beats ESPN for Big 12 teams (same reasons as SEC):
//
//   1. One request per cache cycle covers all 11 softball-sponsoring
//      Big 12 programs (Arizona, Arizona State, Baylor, BYU, Houston,
//      Iowa State, Kansas, Oklahoma State, Texas Tech, UCF, Utah) —
//      Cincinnati, Colorado, Kansas State, TCU and West Virginia don't
//      sponsor softball.
//   2. Ships broadcast label, tournament flag, conference flag, venue
//      location, and a boxscore URL for every completed game even when
//      the game wasn't televised.
//   3. Status model is explicit: `status` is one of O (over/played, has
//      result), A (available/upcoming), C (cancelled), P (postponed).
//
// We exclude the iCal subscription feed (/services/
// responsive-calendar-subscription.ashx/calendar.ics) even though it's
// simpler — the ICS only contains FUTURE events, so teams past their
// current date would get a dwindling schedule as the season progresses.
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { normalizeTeamKey } from './_wmt.js';

const SPORT_ID_SOFTBALL = 12;
const API_BASE = 'https://big12sports.com';
const LOGO_BASE = `${API_BASE}/images/logos`;
const TTL_MS = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
};

let eventsCache = null;
let eventsCacheAt = 0;
let eventsInFlight = null;

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`Big12 API ${r.status}: ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Build the date window. College softball runs early-February through
// late-May, plus occasional fall exhibitions. Query a year-wide window
// so we catch every regular-season, tournament and postseason game, and
// the endpoint happily returns everything in a single response.
function getSeasonWindow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  // If we're in June–December, the published "season" is next year's.
  const seasonYear = now.getUTCMonth() >= 5 ? year + 1 : year;
  return {
    start: `${seasonYear}-01-01`,
    end: `${seasonYear}-07-31 23:59:59`,
  };
}

async function fetchAllEventsForCurrentSeason() {
  const { start, end } = getSeasonWindow();
  const params = new URLSearchParams({
    start,
    end,
    sport_id: String(SPORT_ID_SOFTBALL),
    school_id: '0',
  });
  const url = `${API_BASE}/services/responsive-calendar.ashx?${params.toString()}`;
  const data = await fetchJson(url);
  const events = Array.isArray(data) ? data : [];
  return { events };
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

// Map Big 12 status + result_text to the same {state, completed, detail}
// shape the ESPN path and SEC path emit, so the UI renders either source
// with one code path.
function mapStatus(ev) {
  const s = ev.status;
  if (s === 'O') {
    // "Over" / played — has a result.
    return {
      state: 'post',
      completed: true,
      detail: ev.result_text || 'Final',
    };
  }
  if (s === 'C') {
    return { state: 'post', completed: true, detail: 'Cancelled' };
  }
  if (s === 'P') {
    return { state: 'pre', completed: false, detail: 'Postponed' };
  }
  // "A" = Available/upcoming; and any unexpected value falls through here.
  return {
    state: 'pre',
    completed: false,
    detail: ev.result_text || ev.time || null,
  };
}

// Sidearm ships opponent logos as a filename inside /images/logos/. The
// `url` field is typically null on the JSON response, but the filename
// always resolves to the real asset. Skip the placeholder "0.png".
function opponentLogo(ev) {
  const img = ev.opponent?.image;
  if (!img) return null;
  if (img.url) return img.url.startsWith('http') ? img.url : `${API_BASE}${img.url}`;
  const file = img.filename;
  if (!file || file === '0.png') return null;
  const path = img.path || '/images/logos';
  const base = path.startsWith('/') ? `${API_BASE}${path}` : LOGO_BASE;
  return `${base}/${file}`;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize one Big 12 API event into the shared schedule shape. We
// always treat `ev.school` as "us" — the feed emits one event per Big 12
// school per game, so a single call already guarantees correct self-side
// attribution and we just need to filter by the name variant set.
function normalizeEventForTeam(ev, nameKeySet) {
  const selfName = ev.school?.title;
  if (!selfName) return null;
  const selfKey = normalizeTeamKey(selfName);
  if (!selfKey || !nameKeySet.has(selfKey)) return null;

  const status = mapStatus(ev);
  const finished = status.state === 'post' && ev.status === 'O';

  const selfScore = toNum(ev.result?.team_score);
  const oppScore = toNum(ev.result?.opponent_score);
  const resultStatus = ev.result?.status;
  let result = null;
  if (finished) {
    if (resultStatus === 'W' || resultStatus === 'L' || resultStatus === 'T') {
      result = resultStatus;
    } else if (selfScore != null && oppScore != null) {
      result = selfScore > oppScore ? 'W' : selfScore < oppScore ? 'L' : 'T';
    }
  }

  const li = ev.location_indicator;
  const homeAway = li === 'H' ? 'home' : li === 'A' ? 'away' : li === 'N' ? 'neutral' : null;
  const neutralSite = li === 'N';

  return {
    id: `big12-${ev.id}`,
    date: ev.date_utc || ev.date || null,
    status,
    homeAway,
    neutralSite,
    opponent: {
      id: ev.opponent?.id ? String(ev.opponent.id) : null,
      name: ev.opponent?.title || null,
      abbreviation: ev.opponent?.abbreviation || null,
      logo: opponentLogo(ev),
      rank: null,
    },
    score:
      finished && selfScore != null && oppScore != null
        ? { self: selfScore, opp: oppScore, display: `${selfScore}-${oppScore}` }
        : null,
    result,
    venue: null,
    venueCity: ev.location || null,
    broadcast: ev.media?.tv || ev.media?.radio || null,
    isConference: !!ev.is_conference,
    isExhibition: ev.type === 'E',
    tournamentTitle: ev.tournament?.title || null,
  };
}

// Public entry point for team-stats/route.js. Returns a normalized,
// chronologically-sorted schedule array for the team matching any of
// `nameVariants`, or null if no events match (which means the team isn't
// in the Big 12 payload — caller should fall back to the ESPN path).
export async function getBig12TeamSchedule(nameVariants) {
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
