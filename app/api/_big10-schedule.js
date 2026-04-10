// Big Ten softball schedule source.
//
// bigten.org runs on Boost Sport AI's conference CMS (Next.js + a
// "Contentstack"-style cache key fallback map). The /sb/schedule/ page
// is server-rendered and embeds the entire season's game list inside
// its __NEXT_DATA__ JSON under the fallback key:
//
//   #sport:"sb",season:2026,contentTypeUid:"schedule",
//
// which resolves to a flat array of ~700 game objects for the full
// Big Ten softball season (16–17 softball-sponsoring programs, ~42
// games per team, one entry per game). Each row ships:
//
//   - teams.away_team[0] + teams.home_team[0] with market/name/alias/logo
//   - results.{status, away_points, home_points}  (status: COMPLETE,
//     SCHEDULED, POSTPONED, CANCELED)
//   - info.venue and info.notes
//   - datetime (ISO)
//   - links.tv / streaming / radio (arrays of broadcast objects)
//   - flags (e.g. conference, tournament — nullable)
//   - ranking (AP poll rank if applicable)
//
// Self-gating: the fallback array only contains games where at least
// one participant is a Big Ten program (non-Big-Ten teams never appear
// as the 'self' side since the feed is scoped to the conference's own
// CMS). We still filter on market/name match so a non-Big-Ten team
// never accidentally resolves here.
//
// Why we scrape the HTML rather than call the Boost Sport API directly:
// the backing endpoints at b1gbedev.boostsport.ai require auth headers
// we don't have, and the server-rendered page already includes the
// whole dataset inline — one HTTP GET of the same URL a visitor would
// see gives us everything we need with zero auth.
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { normalizeTeamKey } from './_wmt.js';

const SCHEDULE_URL = 'https://bigten.org/sb/schedule/';
const TTL_MS = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Encoding': 'gzip, deflate',
};

let eventsCache = null;
let eventsCacheAt = 0;
let eventsInFlight = null;

async function fetchHtml(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`B1G ${r.status}: ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Extract the __NEXT_DATA__ blob and reach into the pageProps.fallback
// cache for the schedule key matching this season. We look the key up by
// substring rather than pin it to a specific year so the module keeps
// working across season rollovers without a deploy.
function parseScheduleFromHtml(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
  if (!m) throw new Error('B1G: __NEXT_DATA__ not found');
  const data = JSON.parse(m[1]);
  const fallback = data?.props?.pageProps?.fallback;
  if (!fallback || typeof fallback !== 'object') {
    throw new Error('B1G: pageProps.fallback missing');
  }
  const key = Object.keys(fallback).find(
    (k) => k.includes('sport:"sb"') && k.includes('contentTypeUid:"schedule"'),
  );
  if (!key) throw new Error('B1G: schedule fallback key not found');
  const arr = fallback[key];
  if (!Array.isArray(arr)) throw new Error('B1G: schedule payload not an array');
  return arr;
}

async function fetchAllEvents() {
  const html = await fetchHtml(SCHEDULE_URL);
  return parseScheduleFromHtml(html);
}

async function getEventsCached() {
  if (eventsCache && Date.now() - eventsCacheAt < TTL_MS) return eventsCache;
  if (eventsInFlight) return eventsInFlight;
  eventsInFlight = (async () => {
    try {
      const events = await fetchAllEvents();
      eventsCache = events;
      eventsCacheAt = Date.now();
      return events;
    } finally {
      eventsInFlight = null;
    }
  })();
  return eventsInFlight;
}

// Map Boost Sport game status to the shared {state, completed, detail}
// shape used by the ESPN / SEC / Sidearm paths so the TeamModal renders
// either source with one code path.
function mapStatus(g) {
  const s = (g.results?.status || '').toUpperCase();
  if (s === 'COMPLETE') {
    return { state: 'post', completed: true, detail: 'Final' };
  }
  if (s === 'CANCELED' || s === 'CANCELLED') {
    return { state: 'post', completed: true, detail: 'Cancelled' };
  }
  if (s === 'POSTPONED') {
    return { state: 'pre', completed: false, detail: 'Postponed' };
  }
  // SCHEDULED and anything unexpected → upcoming.
  return { state: 'pre', completed: false, detail: null };
}

function pickFirstBroadcast(links) {
  if (!links) return null;
  const pick = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const item = arr[0];
    if (typeof item === 'string') return item;
    return item?.title || item?.name || item?.network || item?.label || null;
  };
  return pick(links.tv) || pick(links.streaming) || pick(links.radio) || null;
}

function teamMatches(team, nameKeySet) {
  if (!team) return false;
  const candidates = [team.market, team.name, team.title, team.alias];
  for (const c of candidates) {
    if (!c) continue;
    const k = normalizeTeamKey(c);
    if (k && nameKeySet.has(k)) return true;
  }
  return false;
}

// The Boost Sport feed contains every Big Ten game, which means
// non-conference opponents (e.g. Fresno State that played Oregon)
// appear in the away_team/home_team slots. We must only treat the
// matched side as "us" if it's actually a Big Ten program — otherwise
// a non-B1G team will silently accept a truncated schedule composed
// only of its B1G crossover games.
function isBig10Team(team) {
  if (!team) return false;
  if (team.conference === 'Big Ten') return true;
  if (team.conf?.title?.includes('Big Ten')) return true;
  return false;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize one Boost Sport game into the shared schedule shape. We
// inspect both away_team[0] and home_team[0] — the requesting team can
// be on either side.
function normalizeEventForTeam(g, nameKeySet) {
  const away = g.teams?.away_team?.[0] || null;
  const home = g.teams?.home_team?.[0] || null;
  if (!away || !home) return null;

  let selfSide = null;
  if (teamMatches(home, nameKeySet) && isBig10Team(home)) selfSide = 'home';
  else if (teamMatches(away, nameKeySet) && isBig10Team(away)) selfSide = 'away';
  if (!selfSide) return null;

  const selfTeam = selfSide === 'home' ? home : away;
  const oppTeam = selfSide === 'home' ? away : home;

  const status = mapStatus(g);
  const finished = status.state === 'post' && (g.results?.status || '').toUpperCase() === 'COMPLETE';

  const selfScore = toNum(selfSide === 'home' ? g.results?.home_points : g.results?.away_points);
  const oppScore = toNum(selfSide === 'home' ? g.results?.away_points : g.results?.home_points);

  let result = null;
  if (finished && selfScore != null && oppScore != null) {
    result = selfScore > oppScore ? 'W' : selfScore < oppScore ? 'L' : 'T';
  }

  // Boost Sport doesn't have a neutral_site flag per event. Fall back to
  // inferring it from the title text if absolutely needed, but leaving
  // false is safe — the UI will still render the opponent and venue.
  const neutral = false;
  const homeAway = selfSide === 'home' ? 'home' : 'away';

  return {
    id: `b1g-${g.id || g.uid}`,
    date: g.datetime || null,
    status,
    homeAway,
    neutralSite: neutral,
    opponent: {
      id: oppTeam.id != null ? String(oppTeam.id) : null,
      name: oppTeam.market || oppTeam.name || null,
      abbreviation: oppTeam.alias || null,
      logo: oppTeam.logo?.url || null,
      rank: null,
    },
    score:
      finished && selfScore != null && oppScore != null
        ? { self: selfScore, opp: oppScore, display: `${selfScore}-${oppScore}` }
        : null,
    result,
    venue: g.info?.venue || null,
    venueCity: null,
    broadcast: pickFirstBroadcast(g.links),
    isConference: oppTeam.conference === 'Big Ten',
    isExhibition:
      !!(selfSide === 'home'
        ? g.results?.home_team_is_exhibition
        : g.results?.away_team_is_exhibition),
    tournamentTitle: g.tournament?.title || null,
  };
}

// Public entry point for team-stats/route.js. Returns a normalized,
// chronologically-sorted schedule array for the team matching any of
// `nameVariants`, or null if no events match (team isn't in the Big
// Ten payload — caller should fall back to the ESPN path).
export async function getBig10TeamSchedule(nameVariants) {
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
  for (const g of events) {
    const norm = normalizeEventForTeam(g, keys);
    if (norm) out.push(norm);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return out;
}
