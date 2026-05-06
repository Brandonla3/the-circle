// NCAA.com softball schedule fetcher via the ncaa-api.henrygd.me proxy.
//
// data.ncaa.com/casablanca blocks server-side requests by IP. The
// ncaa-api.henrygd.me Cloudflare Worker proxies the same data and is
// already used by _ncaa-player.js for player stats — it works from Vercel.
//
// Strategy: fetch every day's scoreboard for the softball season window
// (Feb 1 – Jun 30) in parallel, flatten into a full-season game list, and
// cache for 15 minutes. Per-team schedule views are produced by filtering
// the cached list against the team's name variants.
//
// NOT a route — Next.js only treats literal route.js files as endpoints.

import { normalizeTeamKey } from './_wmt.js';

const BASE = 'https://ncaa-api.henrygd.me';
const TTL_MS = 15 * 60 * 1000;

// Mirror the browser-like User-Agent that _ncaa-player.js uses successfully.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
};

let allGamesCache = null;
let allGamesCacheAt = 0;
let allGamesInFlight = null;

function getSeasonWindow() {
  const now = new Date();
  const year = now.getUTCMonth() >= 5 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return {
    start: new Date(Date.UTC(year, 1, 1)),  // Feb 1
    end:   new Date(Date.UTC(year, 5, 30)), // Jun 30
  };
}

async function fetchDayGames(isoDate) {
  const [y, m, d] = isoDate.split('-');
  const url = `${BASE}/scoreboard/softball/d1/${y}/${m}/${d}/scoreboard.json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.games || []).map(({ game }) => ({ ...game, _date: isoDate }));
  } catch {
    clearTimeout(t);
    return [];
  }
}

async function fetchAllGames() {
  const { start, end } = getSeasonWindow();
  const dates = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  const results = await Promise.all(dates.map(fetchDayGames));
  return results.flat();
}

async function getAllGamesCached() {
  if (allGamesCache && Date.now() - allGamesCacheAt < TTL_MS) return allGamesCache;
  if (allGamesInFlight) return allGamesInFlight;
  allGamesInFlight = (async () => {
    try {
      const games = await fetchAllGames();
      allGamesCache = games;
      allGamesCacheAt = Date.now();
      return games;
    } finally {
      allGamesInFlight = null;
    }
  })();
  return allGamesInFlight;
}

// --- Normalization ---

function teamNameKeys(side) {
  if (!side?.names) return [];
  const { short, full, seo, char6 } = side.names;
  return [short, full, seo, char6]
    .filter(Boolean)
    .map(normalizeTeamKey)
    .filter(Boolean);
}

function matchesAny(side, nameKeySet) {
  return teamNameKeys(side).some((k) => nameKeySet.has(k));
}

function mapGameState(state) {
  if (!state) return { state: 'pre', completed: false, detail: null };
  const s = String(state).toLowerCase();
  if (s === 'final' || s.startsWith('f/')) {
    return { state: 'post', completed: true, detail: 'Final' };
  }
  if (s === 'live' || s === 'in progress') {
    return { state: 'in', completed: false, detail: 'Live' };
  }
  if (s === 'postponed') {
    return { state: 'pre', completed: false, detail: 'Postponed' };
  }
  if (s === 'cancelled' || s === 'canceled') {
    return { state: 'post', completed: true, detail: 'Cancelled' };
  }
  return { state: 'pre', completed: false, detail: state };
}

function normalizeGame(game, nameKeySet) {
  const away = game.away;
  const home = game.home;
  if (!away || !home) return null;

  let selfSide = null;
  if (matchesAny(home, nameKeySet))      selfSide = 'home';
  else if (matchesAny(away, nameKeySet)) selfSide = 'away';
  if (!selfSide) return null;

  const selfTeam = selfSide === 'home' ? home : away;
  const oppTeam  = selfSide === 'home' ? away : home;

  const status = mapGameState(game.gameState);
  const selfScore = status.completed ? parseInt(selfTeam.score, 10) : null;
  const oppScore  = status.completed ? parseInt(oppTeam.score,  10) : null;
  const scoresOk  = Number.isFinite(selfScore) && Number.isFinite(oppScore);

  let result = null;
  if (status.completed && scoresOk) {
    if (selfTeam.winner === true)     result = 'W';
    else if (oppTeam.winner === true) result = 'L';
    else result = selfScore > oppScore ? 'W' : selfScore < oppScore ? 'L' : 'T';
  }

  return {
    id:          `ncaa-${game.gameID}`,
    date:        game._date ? `${game._date}T00:00:00Z` : null,
    status,
    homeAway:    selfSide,
    neutralSite: false,
    opponent: {
      id:           null,
      name:         oppTeam.names?.full || oppTeam.names?.short || null,
      abbreviation: oppTeam.names?.char6 || null,
      logo:         null,
      rank:         null,
    },
    score: status.completed && scoresOk
      ? { self: selfScore, opp: oppScore, display: `${selfScore}-${oppScore}` }
      : null,
    result,
    venue:           game.arena?.name || null,
    venueCity:       game.arena?.location || game.location || null,
    broadcast:       game.network || game.broadcast?.network || null,
    isConference:    !!(game.conference?.some?.(
      (c) => c.conferenceSeo === 'big-12' || c.conferenceShort?.includes('Big 12'),
    )),
    isExhibition:    false,
    tournamentTitle: game.bracketRegion || null,
  };
}

export async function getNcaaTeamSchedule(nameVariants) {
  const variants = Array.isArray(nameVariants) ? nameVariants : [nameVariants];
  const keys = new Set(variants.map(normalizeTeamKey).filter(Boolean));
  if (keys.size === 0) return null;

  let games;
  try {
    games = await getAllGamesCached();
  } catch {
    return null;
  }

  const out = [];
  for (const g of games) {
    const norm = normalizeGame(g, keys);
    if (norm) out.push(norm);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return out;
}
