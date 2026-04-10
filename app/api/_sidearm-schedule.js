// Shared Sidearm Sports schedule fetcher.
//
// Sidearm powers most non-SEC P5 conference sites (big12sports.com,
// theacc.com, and others). They all expose the same lazy-loaded
// Knockout view-model that calls:
//
//   {origin}/services/responsive-calendar.ashx
//     ?start=YYYY-MM-DD
//     &end=YYYY-MM-DD HH:mm:ss
//     &sport_id=N
//     &school_id=0        (0 = all schools in that conference)
//
// The payload is a flat JSON array of game objects — one per school per
// game, so a conference-vs-conference matchup appears twice (once for
// each school as `school`, the other as `opponent`). We always filter
// by the requesting team's name variants against ev.school.title, which
// self-gates cleanly: the endpoint only emits events whose `school`
// side is a member of that conference, so a non-empty match is also
// the membership test.
//
// This module factors out everything generic so adding a new Sidearm
// conference is ~20 lines in a thin wrapper — see _big12-schedule.js
// and _acc-schedule.js.

import { normalizeTeamKey } from './_wmt.js';

const TTL_MS = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
};

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`Sidearm ${r.status}: ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// College softball runs early-February through late-May, plus occasional
// fall exhibitions. Query a year-wide window so we catch every regular,
// tournament and postseason game. Sidearm happily returns everything in
// a single response for that range.
function getSeasonWindow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const seasonYear = now.getUTCMonth() >= 5 ? year + 1 : year;
  return {
    start: `${seasonYear}-01-01`,
    end: `${seasonYear}-07-31 23:59:59`,
  };
}

function mapStatus(ev) {
  const s = ev.status;
  if (s === 'O') {
    return { state: 'post', completed: true, detail: ev.result_text || 'Final' };
  }
  if (s === 'C') {
    return { state: 'post', completed: true, detail: 'Cancelled' };
  }
  if (s === 'P') {
    return { state: 'pre', completed: false, detail: 'Postponed' };
  }
  // "A" = Available/upcoming; and any unexpected value falls through.
  return {
    state: 'pre',
    completed: false,
    detail: ev.result_text || ev.time || null,
  };
}

function opponentLogo(ev, origin) {
  const img = ev.opponent?.image;
  if (!img) return null;
  if (img.url) return img.url.startsWith('http') ? img.url : `${origin}${img.url}`;
  const file = img.filename;
  if (!file || file === '0.png') return null;
  const path = img.path || '/images/logos';
  return `${origin}${path}/${file}`;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeEventForTeam(ev, nameKeySet, { idPrefix, origin }) {
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

  return {
    id: `${idPrefix}-${ev.id}`,
    date: ev.date_utc || ev.date || null,
    status,
    homeAway,
    neutralSite: li === 'N',
    opponent: {
      id: ev.opponent?.id ? String(ev.opponent.id) : null,
      name: ev.opponent?.title || null,
      abbreviation: ev.opponent?.abbreviation || null,
      logo: opponentLogo(ev, origin),
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

// Factory — returns a getTeamSchedule(nameVariants) fn bound to a single
// Sidearm property. Each caller gets its own module-scope cache, so the
// ACC and Big 12 fetchers never collide and warm-path calls skip the
// upstream entirely.
export function createSidearmScheduleFetcher({ origin, sportId, idPrefix }) {
  let eventsCache = null;
  let eventsCacheAt = 0;
  let eventsInFlight = null;

  async function fetchAll() {
    const { start, end } = getSeasonWindow();
    const params = new URLSearchParams({
      start,
      end,
      sport_id: String(sportId),
      school_id: '0',
    });
    const url = `${origin}/services/responsive-calendar.ashx?${params.toString()}`;
    const data = await fetchJson(url);
    return Array.isArray(data) ? data : [];
  }

  async function getEventsCached() {
    if (eventsCache && Date.now() - eventsCacheAt < TTL_MS) return eventsCache;
    if (eventsInFlight) return eventsInFlight;
    eventsInFlight = (async () => {
      try {
        const events = await fetchAll();
        eventsCache = events;
        eventsCacheAt = Date.now();
        return events;
      } finally {
        eventsInFlight = null;
      }
    })();
    return eventsInFlight;
  }

  return async function getTeamSchedule(nameVariants) {
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
      const norm = normalizeEventForTeam(ev, keys, { idPrefix, origin });
      if (norm) out.push(norm);
    }
    if (out.length === 0) return null;
    out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    return out;
  };
}
