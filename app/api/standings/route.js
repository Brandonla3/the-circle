export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Aggregate D1 softball standings by walking NCAA's daily scoreboard JSON
// from the start of the season to today, tallying W/L per team and grouping
// by the conference NCAA already attaches to each team.
//
// We use the free ncaa-api.henrygd.me wrapper which proxies the live NCAA.com
// scoreboard data (the old data.ncaa.com/casablanca endpoints have been retired).
//   https://ncaa-api.henrygd.me/scoreboard/softball/d1/YYYY/MM/DD

const SEASON_START = { month: 2, day: 1 }; // Feb 1
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// Major D1 softball conferences we want to surface in the UI by default.
// Names here are normalized substrings — anything containing one of these
// (case-insensitive) gets bucketed under the matching display name.
const MAJOR_CONFS = [
  { display: 'SEC', match: ['southeastern', 'sec'] },
  { display: 'ACC', match: ['atlantic coast', 'acc'] },
  { display: 'Big 12', match: ['big 12'] },
  { display: 'Big Ten', match: ['big ten'] },
  { display: 'Pac-12', match: ['pac-12', 'pac 12'] },
  { display: 'American', match: ['american athletic', 'aac'] },
  { display: 'Big East', match: ['big east'] },
  { display: 'Mountain West', match: ['mountain west'] },
  { display: 'Conference USA', match: ['conference usa', 'c-usa', 'cusa'] },
  { display: 'Sun Belt', match: ['sun belt'] },
];

function pad(n) { return n < 10 ? `0${n}` : `${n}`; }

function dateRange(startY, startM, startD, end) {
  const dates = [];
  const cur = new Date(Date.UTC(startY, startM - 1, startD));
  while (cur <= end) {
    dates.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// --- Module-scope caches ---------------------------------------------------
//
// ncaa-api.henrygd.me rate-limits with HTTP 428 after ~5-6 parallel requests
// in a short window. A cold scan of 67 season dates at 20-way parallelism
// was losing ~60% of dates every request. We fix that on three levels:
//
//   1. Per-date memoization. Past dates never change, so once successfully
//      fetched we cache them for 24 hours. Recent dates (within 7 days) get
//      a short 10-minute TTL so in-progress games eventually roll in.
//   2. Aggregated-response cache. We cache the fully-tallied teams Map so
//      back-to-back requests skip all fetching and parsing work.
//   3. In-flight dedupe. If two requests arrive during a cold scan, they
//      share one promise instead of each running their own 67-day sweep.
//
// All state is per-Vercel-instance (module scope) and warm invocations
// reuse it. Cold starts re-populate incrementally; the time budget below
// ensures a slow cold start returns partial data rather than hitting
// Vercel's 10s hobby timeout.
const dayCache = new Map();              // 'YYYY-MM-DD' -> { fetchedAt, games }
const DAY_CACHE_MAX = 500;               // prevent unbounded growth on long-running instances
const PAST_DAY_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_DAY_TTL_MS = 10 * 60 * 1000;
const RECENT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

// Evict oldest entries when a Map exceeds its size cap.
function pruneMap(map, max) {
  if (map.size <= max) return;
  const excess = map.size - max;
  const iter = map.keys();
  for (let i = 0; i < excess; i++) map.delete(iter.next().value);
}

let teamsCache = null;                   // { fetchedAt, teams, allGamesCount, meta }
const TEAMS_CACHE_TTL_MS = 5 * 60 * 1000;

let teamsCachePromise = null;            // in-flight dedupe

// Total wall-clock budget for a cold scan so Vercel doesn't kill us mid-sweep.
// Anything not fetched within this window is skipped; subsequent requests will
// pick up the slack from the warm per-date cache.
const SCAN_BUDGET_MS = 7000;

// Retry policy for transient failures (428, 429, 5xx, network errors).
const RETRY_DELAYS_MS = [500, 1000, 2000];

function dayKey(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function dayCacheValid(entry, date) {
  if (!entry) return false;
  const age = Date.now() - entry.fetchedAt;
  const isRecent = Date.now() - date.getTime() < RECENT_THRESHOLD_MS;
  return age < (isRecent ? RECENT_DAY_TTL_MS : PAST_DAY_TTL_MS);
}

async function fetchDay(date) {
  const key = dayKey(date);
  const cached = dayCache.get(key);
  if (dayCacheValid(cached, date)) {
    return { games: cached.games, fromCache: true };
  }

  const url = `https://ncaa-api.henrygd.me/scoreboard/softball/d1/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;

  let lastStatus = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
      lastStatus = r.status;
      if (r.ok) {
        const raw = await r.json();
        const list = raw.games || raw.data || raw.scoreboard?.games || [];
        dayCache.set(key, { fetchedAt: Date.now(), games: list });
        pruneMap(dayCache, DAY_CACHE_MAX);
        return { games: list, fromCache: false };
      }
      // 404 → nothing scheduled that day, cache as empty so we don't retry.
      if (r.status === 404) {
        dayCache.set(key, { fetchedAt: Date.now(), games: [] });
        pruneMap(dayCache, DAY_CACHE_MAX);
        return { games: [], fromCache: false };
      }
      // 428/429/5xx → fall through to retry.
      if (r.status !== 428 && r.status !== 429 && r.status < 500) {
        // 4xx other than 428/429 — don't retry, treat as empty.
        return { games: [], fromCache: false, status: r.status };
      }
    } catch (e) {
      lastStatus = 'network';
    }
  }
  // All retries exhausted — return empty without caching so we try again next request.
  return { games: [], fromCache: false, status: lastStatus };
}

// Pull the team's conference name out of whatever shape NCAA used.
function getConf(side) {
  if (!side) return '';
  if (Array.isArray(side.conferences) && side.conferences.length) {
    const c = side.conferences[0];
    return c.conferenceName || c.name || '';
  }
  return side.conference || side.conferenceName || side.conferenceSeo || '';
}

function getTeamName(side) {
  return (
    side?.names?.full ||
    side?.names?.short ||
    side?.names?.seo ||
    side?.nameRaw ||
    side?.name ||
    side?.school ||
    ''
  );
}

function getTeamLogo(side) {
  const seo = side?.names?.seo;
  // NCAA hosts team logos at a predictable path keyed by SEO slug.
  return seo ? `https://i.turner.ncaa.com/sites/default/files/images/logos/schools/bgl/${seo}.svg` : null;
}

function isFinal(game) {
  const state = (game.gameState || game.gameStatus || '').toLowerCase();
  return state === 'final' || state === 'f' || state === 'final/' || state.includes('final');
}

function bucketConference(name) {
  const lower = (name || '').toLowerCase();
  for (const c of MAJOR_CONFS) {
    if (c.match.some((m) => lower.includes(m))) return c.display;
  }
  return name || 'Other';
}

// --- Aggregation helpers (hoisted so they're usable anywhere) -------------
const streak = (rec) => {
  if (!rec.length) return '';
  const last = rec[rec.length - 1];
  let n = 0;
  for (let i = rec.length - 1; i >= 0 && rec[i] === last; i--) n++;
  return `${last}${n}`;
};
const last10 = (rec) => {
  const slice = rec.slice(-10);
  const w = slice.filter((x) => x === 'W').length;
  return `${w}-${slice.length - w}`;
};
const pct = (w, l) => (w + l > 0 ? w / (w + l) : 0);

// Walk every season date, fetching in throttled batches with a wall-clock
// budget so Vercel's hobby-plan 10s timeout can't kill us mid-sweep. Dates
// not reached in this invocation will be picked up on subsequent requests
// because fetchDay's day-level cache accumulates across invocations.
async function doFullScan() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const dates = dateRange(year, SEASON_START.month, SEASON_START.day, now);

  const startTime = Date.now();
  const allGames = [];
  let datesFetched = 0;
  let datesFromCache = 0;
  let datesSkipped = 0;
  let timeExhausted = false;

  const batchSize = 4;         // well under the wrapper's rate-limit threshold
  const batchDelayMs = 150;

  for (let i = 0; i < dates.length; i += batchSize) {
    if (Date.now() - startTime > SCAN_BUDGET_MS) {
      timeExhausted = true;
      datesSkipped = dates.length - i;
      break;
    }
    const batch = dates.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(fetchDay));
    for (const d of results) {
      if (d.fromCache) datesFromCache++;
      else datesFetched++;
      for (const g of d.games || []) {
        const game = g.game || g;
        if (isFinal(game)) allGames.push(game);
      }
    }
    if (i + batchSize < dates.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }

  // Tally W/L per team from the accumulated final games.
  const teams = new Map();
  const ensure = (side) => {
    const name = getTeamName(side);
    if (!name) return null;
    if (!teams.has(name)) {
      teams.set(name, {
        name,
        logo: getTeamLogo(side),
        conf: getConf(side),
        w: 0, l: 0, cw: 0, cl: 0,
        recent: [],
      });
    } else {
      const t = teams.get(name);
      if (!t.conf) t.conf = getConf(side);
      if (!t.logo) t.logo = getTeamLogo(side);
    }
    return teams.get(name);
  };

  for (const g of allGames) {
    const home = g.home || g.homeTeam;
    const away = g.away || g.awayTeam;
    if (!home || !away) continue;
    const ht = ensure(home);
    const at = ensure(away);
    if (!ht || !at) continue;

    const homeScore = parseInt(home.score, 10);
    const awayScore = parseInt(away.score, 10);
    if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;

    const homeWon = home.winner === true || home.winner === 'true' || homeScore > awayScore;
    const sameConf = ht.conf && at.conf && ht.conf === at.conf;

    if (homeWon) {
      ht.w++; at.l++;
      if (sameConf) { ht.cw++; at.cl++; }
      ht.recent.push('W'); at.recent.push('L');
    } else {
      at.w++; ht.l++;
      if (sameConf) { at.cw++; ht.cl++; }
      at.recent.push('W'); ht.recent.push('L');
    }
  }

  return {
    teams,
    allGamesCount: allGames.length,
    meta: {
      totalDates: dates.length,
      datesFetched,
      datesFromCache,
      datesSkipped,
      timeExhausted,
      elapsedMs: Date.now() - startTime,
    },
  };
}

// Cache-aware entry point. Returns the most recent aggregated teams map, doing
// a fresh scan only if the cache is stale, and deduping concurrent cold scans.
// Partial scans (hit the time budget) are NOT cached — the next request will
// re-run doFullScan and pick up where we left off via the accumulating dayCache.
async function getAggregatedTeams() {
  if (teamsCache && Date.now() - teamsCache.fetchedAt < TEAMS_CACHE_TTL_MS) {
    return teamsCache;
  }
  if (teamsCachePromise) return teamsCachePromise;

  teamsCachePromise = (async () => {
    const result = await doFullScan();
    const payload = { fetchedAt: Date.now(), ...result };
    if (!result.meta.timeExhausted) {
      teamsCache = payload;
    }
    return payload;
  })();
  try {
    return await teamsCachePromise;
  } finally {
    teamsCachePromise = null;
  }
}

// Fetch one date and return a rich metadata object. Used by both the
// `?probe` and `?debug` diagnostic modes so we can see exactly what the
// upstream wrapper is returning without having to guess at its shape.
async function probeDay(date) {
  const url = `https://ncaa-api.henrygd.me/scoreboard/softball/d1/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
  const meta = {
    date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    url,
    status: null,
    topLevelKeys: null,
    gameCount: 0,
    finalCount: 0,
    rawFirstGame: null,
    error: null,
  };
  try {
    const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
    meta.status = r.status;
    if (!r.ok) return meta;
    const raw = await r.json();
    meta.topLevelKeys = Object.keys(raw || {});
    const games = raw.games || raw.data || raw.scoreboard?.games || [];
    meta.gameCount = Array.isArray(games) ? games.length : 0;
    let finals = 0;
    if (Array.isArray(games)) {
      games.forEach((g, idx) => {
        const game = g.game || g;
        if (isFinal(game)) finals++;
        if (idx === 0) meta.rawFirstGame = game;
      });
    }
    meta.finalCount = finals;
  } catch (e) {
    meta.status = 'error';
    meta.error = String(e.message || e);
  }
  return meta;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const flat = searchParams.get('flat');
  const debug = searchParams.get('debug');
  const probe = searchParams.get('probe');

  // Diagnostic: probe a single date and dump its raw wrapper response so we
  // can verify the shape of fields like gameState/home/away/score.
  if (probe) {
    const m = probe.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
      return Response.json({ error: 'probe must be YYYY-MM-DD' }, { status: 400 });
    }
    const date = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    const meta = await probeDay(date);
    return Response.json(meta, { headers: { 'Cache-Control': 'no-store' } });
  }

  // Diagnostic: sweep every date in the season, return fetch status + game
  // counts per date so we can see how much data we're actually pulling down.
  if (debug) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const dates = dateRange(year, SEASON_START.month, SEASON_START.day, now);

    const attempts = [];
    const batchSize = 15;
    for (let i = 0; i < dates.length; i += batchSize) {
      const batch = dates.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(probeDay));
      attempts.push(...results);
    }

    const ok = attempts.filter((a) => a.status === 200);
    const empty = ok.filter((a) => a.gameCount === 0);
    const withGames = ok.filter((a) => a.gameCount > 0);
    const errors = attempts.filter((a) => typeof a.status !== 'number' || (a.status !== 200 && a.status !== 404));
    const notFound = attempts.filter((a) => a.status === 404);
    const totalGames = attempts.reduce((s, a) => s + (a.gameCount || 0), 0);
    const totalFinals = attempts.reduce((s, a) => s + (a.finalCount || 0), 0);
    const sampleGame = withGames[0]?.rawFirstGame || null;

    return Response.json({
      now: now.toISOString(),
      dateRange: {
        start: dates[0] ? `${dates[0].getUTCFullYear()}-${pad(dates[0].getUTCMonth() + 1)}-${pad(dates[0].getUTCDate())}` : null,
        end: dates[dates.length - 1] ? `${dates[dates.length - 1].getUTCFullYear()}-${pad(dates[dates.length - 1].getUTCMonth() + 1)}-${pad(dates[dates.length - 1].getUTCDate())}` : null,
        count: dates.length,
      },
      summary: {
        attempted: attempts.length,
        ok: ok.length,
        notFound: notFound.length,
        errors: errors.length,
        datesWithGames: withGames.length,
        datesWithNoGames: empty.length,
        totalGames,
        totalFinals,
      },
      sampleGameDate: withGames[0]?.date || null,
      sampleGameKeys: sampleGame ? Object.keys(sampleGame) : null,
      sampleGame,
      firstFailedDates: errors.concat(notFound).slice(0, 10).map((a) => ({ date: a.date, status: a.status, error: a.error })),
      // Compact per-date list: date → status/gameCount/finalCount
      dates: attempts.map((a) => ({ date: a.date, status: a.status, g: a.gameCount, f: a.finalCount })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const { teams, allGamesCount, meta: scanMeta } = await getAggregatedTeams();
    const now = new Date();

    if (flat) {
      const flatTeams = Array.from(teams.values())
        .filter((t) => t.w + t.l > 0)
        .map((t) => ({
          name: t.name,
          logo: t.logo,
          conference: t.conf || '',
          conferenceDisplay: bucketConference(t.conf || ''),
          w: t.w,
          l: t.l,
          cw: t.cw,
          cl: t.cl,
          winPct: pct(t.w, t.l),
          streak: streak(t.recent),
          last10: last10(t.recent),
        }))
        .sort((a, b) => {
          if (b.winPct !== a.winPct) return b.winPct - a.winPct;
          if (b.w !== a.w) return b.w - a.w;
          return a.name.localeCompare(b.name);
        });

      return Response.json(
        {
          teams: flatTeams,
          meta: {
            source: 'data.ncaa.com',
            gamesParsed: allGamesCount,
            teamsFound: flatTeams.length,
            generatedAt: now.toISOString(),
            scan: scanMeta,
          },
        },
        { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' } }
      );
    }

    // Group teams by display conference, filtering out non-major buckets
    const buckets = new Map();
    for (const t of teams.values()) {
      if (!t.conf) continue;
      const display = bucketConference(t.conf);
      if (!MAJOR_CONFS.find((c) => c.display === display)) continue;
      if (!buckets.has(display)) buckets.set(display, []);
      buckets.get(display).push(t);
    }

    for (const arr of buckets.values()) {
      arr.sort((a, b) => {
        if (b.cw !== a.cw) return b.cw - a.cw;
        if (b.cw + b.cl !== a.cw + a.cl) return (b.cw + b.cl) - (a.cw + a.cl);
        const cpa = pct(a.cw, a.cl), cpb = pct(b.cw, b.cl);
        if (cpb !== cpa) return cpb - cpa;
        return pct(b.w, b.l) - pct(a.w, a.l);
      });
    }

    const conferences = MAJOR_CONFS
      .map((c) => ({ display: c.display, teams: buckets.get(c.display) || [] }))
      .filter((c) => c.teams.length > 0)
      .map((c) => ({
        name: c.display,
        abbreviation: c.display,
        headers: ['Conf', 'Pct', 'Overall', 'Pct', 'Streak', 'L10'],
        teams: c.teams.map((t) => {
          const cp = pct(t.cw, t.cl);
          const op = pct(t.w, t.l);
          return {
            name: t.name,
            logo: t.logo,
            stats: [
              `${t.cw}-${t.cl}`,
              cp ? cp.toFixed(3).replace(/^0/, '') : '.000',
              `${t.w}-${t.l}`,
              op ? op.toFixed(3).replace(/^0/, '') : '.000',
              streak(t.recent),
              last10(t.recent),
            ],
          };
        }),
      }));

    if (conferences.length === 0) {
      return Response.json(
        { error: 'No standings could be aggregated from NCAA.com', debug: { gamesParsed: allGamesCount, teamsFound: teams.size, scan: scanMeta } },
        { status: 502 }
      );
    }

    return Response.json(
      {
        conferences,
        meta: {
          source: 'data.ncaa.com',
          gamesParsed: allGamesCount,
          teamsFound: teams.size,
          generatedAt: now.toISOString(),
          scan: scanMeta,
        },
      },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
