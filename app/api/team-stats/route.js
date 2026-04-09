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
import {
  ALL_CATEGORIES as NCAA_PLAYER_CATS,
  fetchLeaderboard as fetchNcaaPlayerLeaderboard,
  normalizePlayerKey,
} from '../_ncaa-player.js';
import { getSecTeamStats } from '../sec-stats/route.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// --- Caches ---------------------------------------------------------------
const teamStatsCache = new Map();    // teamId  -> { fetchedAt, data }
const inFlight = new Map();          // teamId  -> Promise

// --- NCAA team-leaderboard sourcing --------------------------------------
// The category sidebar on ncaa.com's stats pages is CLIENT-side rendered, so
// there is nothing to scrape server-side — every previous attempt to
// auto-discover team-level stat IDs hit the same wall (curl against
// /stats/softball/d1/current/team/<id> only yields that page's self-link +
// pagination anchors, and /stats/softball/d1 only has two featured links).
// The only approach that actually works is maintaining the slug → id map by
// hand. The IDs below were obtained by sweeping ncaa-api.henrygd.me directly
// across /stats/softball/d1/current/team/1..3500 on 2026-04-08 and recording
// every 200 response. If NCAA re-numbers a stat between seasons, `slugStatus`
// will start reporting `empty-leaderboard` for the affected slug and a
// quick re-sweep will give us the new id.
const NCAA_TEAM_LB_TTL_MS = 10 * 60 * 1000;
// Keyed by `${slug}:p${page}`. Each curated slug may end up with multiple
// cached page entries after a scan walks a leaderboard in search of a
// specific team.
const ncaaTeamLbCache = new Map();

// ncaa-api.henrygd.me throttles with HTTP 428 after ~5-6 parallel requests,
// same pattern the standings route documented in commit 5b32d2d. We batch
// at 4 concurrent with a small delay and retry transient failures.
const NCAA_BATCH_SIZE = 4;
const NCAA_BATCH_DELAY_MS = 150;
const NCAA_RETRY_DELAYS_MS = [500, 1000, 2000];
const NCAA_SCAN_BUDGET_MS = 7000;

// Each leaderboard page returns 50 rows. D1 softball has ~290 teams, so 7
// pages covers everyone; we cap at 8 as a safety margin in case NCAA grows
// the field. The per-leaderboard `pages` metadata from the wrapper still
// governs the actual walk — we just never fetch beyond this cap.
const NCAA_MAX_PAGES = 8;

const NCAA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// Fetch an NCAA wrapper URL with retries for 428/429/5xx/network errors.
// Returns parsed JSON on success, null on any non-recoverable failure or
// after all retries exhausted. Matches standings/route.js fetchDay.
async function fetchNcaaWithRetry(url) {
  for (let attempt = 0; attempt <= NCAA_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, NCAA_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const r = await fetch(url, { headers: NCAA_HEADERS, cache: 'no-store' });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      // 428/429/5xx → retry. Any other 4xx → give up, nothing to retry.
      if (r.status !== 428 && r.status !== 429 && r.status < 500) return null;
    } catch (e) {
      // network error — fall through to retry.
    }
  }
  return null;
}

// Ground-truth slug → { id, title, col } map. Totals are preferred over
// per-game variants where both exist because the head-to-head Team Compare
// view in page.js displays raw string values — totals compare more cleanly.
// `col` is the exact column name the leaderboard uses for the primary stat
// value, verified by probing each leaderboard's first data row. NCAA names
// these inconsistently (OBP is under "PCT", SLG is under "SLG PCT" with a
// space, doubles leaderboard is sorted per-game but we read the "2B" total
// column), so the generic candidate-list fallback in pickNcaaPrimaryValue
// would pick the wrong column for several slugs.
//
// Additional team stat IDs found during the sweep that we may want to
// curate later: 283 Fielding%, 284 Scoring (runs/game), 320 WL%, 345 HR/G,
// 347 3B/G, 348 SB/G, 350 Double Plays/G, 595 Hit Batters, 1188 K/BB Ratio,
// 1230 Hits Allowed/7, 1234 HBP, 1241 Sac Bunts, 1242 Sac Flies, 1300 RBI/G.
const NCAA_TEAM_STAT_IDS = {
  'team-batting-avg':  { id: 281,  title: 'Batting Average',            col: 'BA' },
  'team-on-base-pct':  { id: 862,  title: 'On Base Percentage',         col: 'PCT' },
  'team-slugging-pct': { id: 349,  title: 'Slugging Percentage',        col: 'SLG PCT' },
  'team-home-runs':    { id: 1228, title: 'Home Runs',                  col: 'HR' },
  'team-rbi':          { id: 1299, title: 'Runs Batted In',             col: 'RBI' },
  'team-runs-scored':  { id: 1238, title: 'Total Runs',                 col: 'R' },
  'team-hits':         { id: 1229, title: 'Hits',                       col: 'H' },
  'team-stolen-bases': { id: 1239, title: 'Total Stolen Bases',         col: 'SB' },
  'team-doubles':      { id: 346,  title: 'Doubles',                    col: '2B' },
  'team-triples':      { id: 1227, title: 'Triples',                    col: '3B' },
  'team-era':          { id: 282,  title: 'Earned Run Average',         col: 'ERA' },
  'team-whip':         { id: 1236, title: 'WHIP',                       col: 'WHIP' },
  'team-k-per-7':      { id: 864,  title: 'Strikeouts Per Seven Innings', col: 'K/7' },
  'team-shutouts':     { id: 1084, title: 'Shutouts',                   col: 'SHO' },
};

// Curated categories. `lower` marks pitching stats where smaller is better
// (used by the compare view to pick a winner). Three slugs from earlier
// curation lists were dropped because NCAA doesn't publish them at team
// level: `team-strikeouts` (overlaps functionally with team-k-per-7 at 864),
// `team-saves`, and `team-opponent-ba`.
const NCAA_TEAM_BATTING = [
  { slug: 'team-batting-avg',  short: 'BA'  },
  { slug: 'team-on-base-pct',  short: 'OBP' },
  { slug: 'team-slugging-pct', short: 'SLG' },
  { slug: 'team-home-runs',    short: 'HR'  },
  { slug: 'team-rbi',          short: 'RBI' },
  { slug: 'team-runs-scored',  short: 'R'   },
  { slug: 'team-hits',         short: 'H'   },
  { slug: 'team-stolen-bases', short: 'SB'  },
  { slug: 'team-doubles',      short: '2B'  },
  { slug: 'team-triples',      short: '3B'  },
];

const NCAA_TEAM_PITCHING = [
  { slug: 'team-era',     short: 'ERA',  lower: true },
  { slug: 'team-whip',    short: 'WHIP', lower: true },
  { slug: 'team-k-per-7', short: 'K/7'  },
  { slug: 'team-shutouts', short: 'SHO' },
];

const NCAA_ALL_TEAM_CATS = [
  ...NCAA_TEAM_BATTING.map((c) => ({
    ...c,
    side: 'batting',
    id: NCAA_TEAM_STAT_IDS[c.slug]?.id,
    label: NCAA_TEAM_STAT_IDS[c.slug]?.title,
    col: NCAA_TEAM_STAT_IDS[c.slug]?.col,
  })),
  ...NCAA_TEAM_PITCHING.map((c) => ({
    ...c,
    side: 'pitching',
    id: NCAA_TEAM_STAT_IDS[c.slug]?.id,
    label: NCAA_TEAM_STAT_IDS[c.slug]?.title,
    col: NCAA_TEAM_STAT_IDS[c.slug]?.col,
  })),
];

// Fetch a single page of one NCAA team leaderboard. Cached per-(slug, page)
// so repeated calls across teams only hit the wrapper once per TTL window.
async function fetchNcaaTeamLeaderboardPage(cat, page) {
  if (!cat.id) return null;
  const key = `${cat.slug}:p${page}`;
  const cached = ncaaTeamLbCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < NCAA_TEAM_LB_TTL_MS) return cached.data;

  const suffix = page > 1 ? `/p${page}` : '';
  const url = `https://ncaa-api.henrygd.me/stats/softball/d1/current/team/${cat.id}${suffix}`;
  const json = await fetchNcaaWithRetry(url);
  if (!json) return null;
  const data = {
    slug: cat.slug,
    id: cat.id,
    label: cat.label,
    short: cat.short,
    side: cat.side,
    lower: cat.lower,
    page: json.page || page,
    totalPages: json.pages || 1,
    rows: json.data || [],
  };
  ncaaTeamLbCache.set(key, { fetchedAt: Date.now(), data });
  return data;
}

// Walk an NCAA team leaderboard starting at page 1, looking for the target
// team. Stops as soon as the team is found, when we hit the wrapper's
// reported last page, or when we hit NCAA_MAX_PAGES. Each page is fetched
// sequentially within this helper — but the CALLER runs multiple slugs in
// parallel batches, so overall concurrency stays at NCAA_BATCH_SIZE.
//
// This is what gets teams like Oklahoma (rank 54 in Doubles per Game)
// unstuck — they're not in the first 50 rows, so a single-page fetch used
// to report team-not-in-rows for every leaderboard where the team isn't
// a leader.
async function fetchAndFindNcaaRow(cat, nameVariantSet) {
  let lastLb = null;
  let pagesFetched = 0;
  let fetchFailed = false;
  for (let page = 1; page <= NCAA_MAX_PAGES; page++) {
    const lb = await fetchNcaaTeamLeaderboardPage(cat, page);
    if (!lb) {
      if (page === 1) fetchFailed = true;
      break;
    }
    pagesFetched++;
    lastLb = lb;
    if (!lb.rows || lb.rows.length === 0) break;
    const row = findNcaaTeamRow(lb.rows, nameVariantSet);
    if (row) return { lb, row, pagesFetched, fetchFailed: false };
    if (page >= lb.totalPages) break;
  }
  return { lb: lastLb, row: null, pagesFetched, fetchFailed };
}

// Find a team's row in a single NCAA leaderboard. Pass 1 does an exact
// normalized match against any candidate column; Pass 2 falls back to
// substring containment so that suffix-appended leaderboard names (e.g.
// "Oklahoma Sooners" vs "Oklahoma") still resolve. Modeled on the
// substring fallback in `findTeam` in _espn.js.
function findNcaaTeamRow(rows, nameVariantSet) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const candidateCols = ['School', 'school', 'Team', 'TEAM', 'team', 'Name', 'NAME', 'name'];

  // Pass 1: exact normalized equality.
  for (const row of rows) {
    for (const col of candidateCols) {
      const c = row[col];
      if (!c) continue;
      if (nameVariantSet.has(normalize(c))) return row;
    }
  }
  // Pass 2: substring containment in either direction.
  for (const row of rows) {
    for (const col of candidateCols) {
      const c = row[col];
      if (!c) continue;
      const norm = normalize(c);
      if (!norm) continue;
      for (const v of nameVariantSet) {
        if (v.length < 4) continue;
        if (norm.includes(v) || v.includes(norm)) return row;
      }
    }
  }
  return null;
}

// Pluck the primary stat value out of a leaderboard row. Prefers the
// explicit column hint from NCAA_TEAM_STAT_IDS (`cat.col`) because NCAA's
// column naming is inconsistent across leaderboards — OBP is under "PCT",
// SLG is under "SLG PCT" with a space, etc. Without the hint, the generic
// candidate list would pick the first matching column (often a counting
// stat like H or AB), which is why an earlier run showed OBP as "483"
// (really the hit total) and SLG as "1129" (really the at-bat count).
function pickNcaaPrimaryValue(row, cat) {
  if (!row) return null;
  if (cat.col && row[cat.col] != null && row[cat.col] !== '') {
    return row[cat.col];
  }
  // Fallback candidate list for any slug that doesn't have a col hint.
  const candidates = [
    cat.short,
    cat.label,
    'BA', 'AVG', 'OBP', 'SLG',
    'HR', 'RBI', 'R', 'H', 'SB', '2B', '3B',
    'ERA', 'WHIP', 'SO', 'K', 'SHO', 'SV',
    'RPG', 'HRPG',
  ];
  for (const k of candidates) {
    if (row[k] != null && row[k] !== '') return row[k];
  }
  // Last resort: first non-meta key.
  const META = new Set(['Rank', 'RANK', 'rank', 'Team', 'TEAM', 'team', 'School', 'school', 'Conference', 'Conf', 'Cl', 'CL', 'G', 'GP']);
  for (const [k, v] of Object.entries(row)) {
    if (META.has(k)) continue;
    if (v != null && v !== '') return v;
  }
  return null;
}

// Aggregate NCAA team-level totals for one team. Walks the curated stat
// list in throttled batches (NCAA_BATCH_SIZE concurrent with a short delay
// between batches) because the henrygd wrapper throttles with HTTP 428
// above that threshold. Each slug inside a batch may step through multiple
// leaderboard pages via fetchAndFindNcaaRow — the wrapper returns only 50
// rows per page and D1 softball has ~290 teams, so teams outside the top
// 50 of a given stat were previously reporting team-not-in-rows. Cached
// results short-circuit the fetch entirely, so warm calls are free. A 7s
// wall-clock budget matches standings/route.js so slow upstreams can't
// push this past Vercel's 10s request timeout.
async function aggregateNcaaTeamStats(teamId, nameVariantSet) {
  if (!nameVariantSet || nameVariantSet.size === 0) {
    return {
      batting: {},
      pitching: {},
      found: 0,
      attempted: NCAA_ALL_TEAM_CATS.length,
      slugStatus: {},
      error: 'no team name variants',
    };
  }

  const cats = NCAA_ALL_TEAM_CATS;
  // results[i] = { lb, row, pagesFetched, fetchFailed } | null
  const results = new Array(cats.length).fill(null);
  const startTime = Date.now();
  let timeExhausted = false;

  for (let i = 0; i < cats.length; i += NCAA_BATCH_SIZE) {
    if (Date.now() - startTime > NCAA_SCAN_BUDGET_MS) {
      timeExhausted = true;
      break;
    }
    const batchEnd = Math.min(i + NCAA_BATCH_SIZE, cats.length);
    const batch = cats.slice(i, batchEnd);
    const batchResults = await Promise.all(
      batch.map((c) => fetchAndFindNcaaRow(c, nameVariantSet))
    );
    for (let k = 0; k < batch.length; k++) {
      results[i + k] = batchResults[k];
    }
    if (batchEnd < cats.length) {
      await new Promise((r) => setTimeout(r, NCAA_BATCH_DELAY_MS));
    }
  }

  const batting = {};
  const pitching = {};
  let found = 0;
  let totalPagesFetched = 0;
  const slugStatus = {};
  const pagesFetchedBySlug = {};

  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    const r = results[i];
    if (!r) {
      // Scan budget tripped before this slug's batch fired.
      slugStatus[cat.slug] = cat.id ? 'time-exhausted' : 'no-id';
      continue;
    }
    totalPagesFetched += r.pagesFetched || 0;
    if (r.pagesFetched > 0) pagesFetchedBySlug[cat.slug] = r.pagesFetched;
    if (r.fetchFailed || !r.lb) {
      slugStatus[cat.slug] = cat.id ? 'fetch-failed' : 'no-id';
      continue;
    }
    if (!r.lb.rows || r.lb.rows.length === 0) {
      slugStatus[cat.slug] = 'empty-leaderboard';
      continue;
    }
    if (!r.row) {
      // Walked every page the wrapper reports and still didn't find this
      // team — either the team genuinely isn't ranked (possible for some
      // esoteric stats) or the name-match logic needs another alias for
      // this particular school.
      slugStatus[cat.slug] = 'team-not-in-rows';
      continue;
    }
    const value = pickNcaaPrimaryValue(r.row, cat);
    if (value == null || value === '') {
      slugStatus[cat.slug] = 'no-value';
      continue;
    }
    found++;
    slugStatus[cat.slug] = 'ok';
    const target = cat.side === 'batting' ? batting : pitching;
    target[cat.short] = value;
    if (r.row.Rank || r.row.RANK || r.row.rank) {
      target[`${cat.short}_rank`] = r.row.Rank || r.row.RANK || r.row.rank;
    }
  }

  return {
    batting,
    pitching,
    found,
    attempted: cats.length,
    timeExhausted,
    elapsedMs: Date.now() - startTime,
    totalPagesFetched,
    pagesFetchedBySlug,
    slugStatus,
  };
}

// --- NCAA per-player aggregation -----------------------------------------
// For a given team, walk every curated NCAA individual leaderboard, collect
// rows where the team name matches, bucket by player, and merge each
// player's raw stat columns across every leaderboard they appear in. The
// result is shaped exactly like the old ESPN box-score finalizePlayers
// output so the existing UI table in TeamCompareTab renders unchanged.
//
// Coverage note: NCAA individual leaderboards are top-N only (50 rows per
// page). For elite teams like Oklahoma, most starters appear on page 1 of
// multiple stats (HR, RBI, BA, Hits), so a single-page scan across 17
// leaderboards captures the lineup. Role players and bench bats who
// aren't in any top-50 leaderboard will be missing — that's a real
// limitation, but it's strictly better than ESPN's college-softball box
// scores which ship zero stats for most non-televised games.
//
// No ESPN roster join: ESPN's college softball roster endpoint returns
// fossilized rosters (Oklahoma still lists Jocelyn Alo who graduated in
// 2022), with every jersey `null` and every position `"UN"`, so enriching
// NCAA rows against it gave worse data. Position and class year come
// straight from NCAA's leaderboard rows, which are current.
async function aggregateNcaaPlayerStats(teamId, nameVariantSet) {
  if (!nameVariantSet || nameVariantSet.size === 0) {
    return {
      batting: [],
      pitching: [],
      playerCount: 0,
      attempted: NCAA_PLAYER_CATS.length,
      slugsOk: 0,
      error: 'no team name variants',
    };
  }

  const startTime = Date.now();
  const cats = NCAA_PLAYER_CATS;
  const results = new Array(cats.length).fill(null);
  let timeExhausted = false;

  // Throttled batched fetch. Each batch fires NCAA_BATCH_SIZE requests to
  // the wrapper in parallel, waits for them, then delays before the next
  // batch. fetchNcaaPlayerLeaderboard has its own per-slug cache and retry
  // loop, so warm calls short-circuit and transient 428s recover.
  for (let i = 0; i < cats.length; i += NCAA_BATCH_SIZE) {
    if (Date.now() - startTime > NCAA_SCAN_BUDGET_MS) {
      timeExhausted = true;
      break;
    }
    const batchEnd = Math.min(i + NCAA_BATCH_SIZE, cats.length);
    const batch = cats.slice(i, batchEnd);
    const batchResults = await Promise.all(
      batch.map((c) => fetchNcaaPlayerLeaderboard(c.slug).catch(() => null))
    );
    for (let k = 0; k < batch.length; k++) {
      results[i + k] = batchResults[k];
    }
    if (batchEnd < cats.length) {
      await new Promise((r) => setTimeout(r, NCAA_BATCH_DELAY_MS));
    }
  }

  // byPlayer: key -> accumulator {
  //   key, name, team, cls, position, gp,
  //   sides: Set<'batting'|'pitching'>,
  //   rawMerged: { ... every raw column we've seen across leaderboards ... },
  //   appearances: Set<slug>,
  // }
  const byPlayer = new Map();
  let slugsOk = 0;
  const slugStatus = {};

  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    const lb = results[i];
    if (!lb) {
      slugStatus[cat.slug] = timeExhausted ? 'time-exhausted' : 'fetch-failed';
      continue;
    }
    if (!lb.rows || lb.rows.length === 0) {
      slugStatus[cat.slug] = 'empty';
      continue;
    }
    slugStatus[cat.slug] = 'ok';
    slugsOk++;
    for (const row of lb.rows) {
      // Match by normalized team name against any known variant for this team.
      const rowTeamNorm = normalize(row.team || '');
      if (!nameVariantSet.has(rowTeamNorm)) {
        // Substring fallback mirrors findNcaaTeamRow's Pass 2 so suffix
        // variants (e.g. "Oklahoma Sooners" vs "Oklahoma") still resolve.
        let hit = false;
        if (rowTeamNorm.length >= 4) {
          for (const v of nameVariantSet) {
            if (v.length < 4) continue;
            if (rowTeamNorm.includes(v) || v.includes(rowTeamNorm)) { hit = true; break; }
          }
        }
        if (!hit) continue;
      }

      const key = normalizePlayerKey(row.name, row.team);
      let rec = byPlayer.get(key);
      if (!rec) {
        rec = {
          key,
          name: row.name,
          team: row.team,
          cls: row.cls || null,
          position: row.position || null,
          gp: row.gp || null,
          sides: new Set(),
          rawMerged: {},
          appearances: new Set(),
        };
        byPlayer.set(key, rec);
      }
      rec.sides.add(cat.side);
      rec.appearances.add(cat.slug);
      // Prefer richer non-empty values as we merge across leaderboards.
      if (!rec.cls && row.cls) rec.cls = row.cls;
      if (!rec.position && row.position) rec.position = row.position;
      // `gp` varies between batting (G) and pitching (App) in NCAA's
      // source rows; keep the largest number we've seen so a pitcher's
      // appearance count doesn't overwrite their batting games.
      const curGp = parseInt(rec.gp, 10);
      const newGp = parseInt(row.gp, 10);
      if (Number.isFinite(newGp) && (!Number.isFinite(curGp) || newGp > curGp)) {
        rec.gp = String(newGp);
      }
      // Merge every raw column we've seen for this player. Later boards
      // don't overwrite earlier values unless the existing value is empty.
      for (const [k, v] of Object.entries(row.raw || {})) {
        if (v == null || v === '') continue;
        if (rec.rawMerged[k] == null || rec.rawMerged[k] === '') {
          rec.rawMerged[k] = v;
        }
      }
      // Also stash the category's primary-column value keyed by the
      // category slug for easy per-stat lookup in the final shape build.
      rec.rawMerged[`__slug_${cat.slug}`] = row.primary;
    }
  }

  // Shape each accumulator into the {id, name, games, AB, H, ...} records
  // the UI already knows how to render. Fields missing from NCAA (e.g.
  // pitcher BB, WHIP) come out as null and render as "—".
  const batting = [];
  const pitching = [];
  const num = (v) => {
    if (v == null || v === '') return null;
    return v;
  };

  for (const rec of byPlayer.values()) {
    const games = rec.gp || null;
    const raw = rec.rawMerged;
    const shared = {
      id: rec.key,
      name: rec.name,
      position: rec.position || null,
      classYear: rec.cls || null,
      games,
    };

    if (rec.sides.has('batting')) {
      batting.push({
        ...shared,
        AB:  num(raw.AB),
        R:   num(raw.R  ?? raw['__slug_runs-scored']),
        H:   num(raw.H  ?? raw['__slug_hits']),
        RBI: num(raw.RBI ?? raw['__slug_rbi']),
        HR:  num(raw.HR  ?? raw['__slug_home-runs']),
        BB:  num(raw.BB),
        K:   num(raw.SO),
        SB:  num(raw.SB  ?? raw['__slug_stolen-bases']),
        '2B': num(raw['2B'] ?? raw['__slug_doubles']),
        '3B': num(raw['3B'] ?? raw['__slug_triples']),
        BA:  num(raw.BA  ?? raw['__slug_batting-avg']),
        OBP: num(raw.PCT ?? raw['__slug_on-base-pct']),
        SLG: num(raw['SLG PCT'] ?? raw['__slug_slugging-pct']),
      });
    }

    if (rec.sides.has('pitching')) {
      pitching.push({
        ...shared,
        IP:  num(raw.IP  ?? raw['__slug_innings-pitched']),
        // NCAA ships strikeouts as SO; the UI column is labelled K.
        K:   num(raw.SO  ?? raw['__slug_strikeouts']),
        // BB (walks allowed) is not in any curated pitching leaderboard's
        // raw row for softball, so this falls to null and renders "—".
        BB:  num(raw.BB),
        ER:  num(raw.ER),
        H:   num(raw.H),
        R:   num(raw.R),
        W:   num(raw.W  ?? raw['__slug_wins']),
        L:   num(raw.L),
        SV:  num(raw.SV ?? raw['__slug_saves']),
        SHO: num(raw.SHO ?? raw['__slug_shutouts']),
        ERA: num(raw.ERA ?? raw['__slug_era']),
        // WHIP similarly unavailable from NCAA individual leaderboards.
        WHIP: num(raw.WHIP),
        'K/7': num(raw['K/7'] ?? raw['__slug_k-per-7']),
      });
    }
  }

  // Sort: batters by BA desc (fall back to name); pitchers by ERA asc.
  // Nullish rate stats sort to the bottom either way.
  const baNum = (p) => parseFloat(p.BA) || 0;
  const eraNum = (p) => parseFloat(p.ERA);
  batting.sort((a, b) => baNum(b) - baNum(a) || a.name.localeCompare(b.name));
  pitching.sort((a, b) => {
    const ae = eraNum(a);
    const be = eraNum(b);
    if (Number.isFinite(ae) && Number.isFinite(be)) return ae - be;
    if (Number.isFinite(ae)) return -1;
    if (Number.isFinite(be)) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    batting,
    pitching,
    playerCount: byPlayer.size,
    attempted: cats.length,
    slugsOk,
    slugStatus,
    timeExhausted,
    elapsedMs: Date.now() - startTime,
  };
}

const TEAM_TTL_MS = 5 * 60 * 1000;
const ESPN_RETRY_DELAYS_MS = [500, 1000, 2000];

// Retry wrapper for ESPN endpoints (schedule, records). Same backoff shape
// as the NCAA retry above but with ESPN-specific headers.
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
    } catch (e) {
      // network error — retry
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
// normalized name variants used for name-matching against NCAA leaderboards
// (which key rows by school name, not by any numeric id).
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
//
// Data sources after the Step 2 rewrite:
//   • Team Totals  — aggregateNcaaTeamStats (NCAA team leaderboards)
//   • Player rows  — aggregateNcaaPlayerStats (NCAA individual leaderboards)
//   • Schedule + event counts — ESPN team schedule endpoint (just for meta)
//   • Record (W/L/runs/streak) — ESPN core.v2 records endpoint
//
// ESPN box scores are gone entirely because for non-televised teams they
// ship zero player stats and only a `records` placeholder, leaving a whole
// 41-game Oklahoma season with empty rows. NCAA top-50 leaderboards cover
// every school's starters; the tradeoff is that role players who don't
// appear in any top-50 won't show up in Player Compare. That's an honest
// coverage limitation instead of misleading zeros.
async function computeTeamStats(teamId) {
  const startTime = Date.now();
  const scheduleUrl = `${ESPN_SITE}/teams/${teamId}/schedule`;
  const season = new Date().getUTCFullYear();
  const recordsUrl = `https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/seasons/${season}/types/2/teams/${teamId}/records/0?lang=en&region=us`;

  // Resolve the variant set first so both NCAA aggregations can use it.
  const nameVariantSet = await getTeamNameVariantSet(teamId);

  // ESPN calls + NCAA TEAM aggregation run in parallel. NCAA PLAYER
  // aggregation runs AFTER team stats because both hit the same henrygd
  // wrapper which throttles at ~5-6 concurrent requests — running team
  // and player scans at the same time exceeds that and we end up with
  // time-exhausted slugs on cold-start. Sequencing them keeps cold-start
  // total under Vercel's 10s limit while still letting warm-cache calls
  // finish in ~1s (both aggregators hit their caches).
  const [schedule, recordsRaw, ncaaTeamStats, secWmt] = await Promise.all([
    fetchWithRetry(scheduleUrl),
    fetchWithRetry(recordsUrl),
    aggregateNcaaTeamStats(teamId, nameVariantSet).catch(() => null),
    // Conference-specific full-roster feed. Currently only the SEC is wired
    // (via wmt.games, which ships the entire roster with a much richer
    // column set than NCAA's top-50 leaderboards). getSecTeamStats swallows
    // its own errors and returns null if the team isn't in the SEC payload,
    // so non-SEC schools fall through to the NCAA-only path below.
    getSecTeamStats(Array.from(nameVariantSet)).catch(() => null),
  ]);
  const ncaaPlayerStats = await aggregateNcaaPlayerStats(teamId, nameVariantSet).catch(() => null);

  const events = schedule?.events || [];
  const completed = events.filter((ev) => {
    const comp = ev.competitions?.[0];
    const st = comp?.status?.type || ev.status?.type;
    return st?.state === 'post' || st?.completed === true;
  });

  // Normalized per-game schedule for the TeamModal Schedule tab. The ESPN
  // site-API schedule response ships everything we need (opponent id +
  // logo + score + status + venue + broadcast) so no second network call
  // is required — we just flatten the competition shape into something
  // the UI can render directly.
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
        state: st.state || null,          // 'pre' | 'in' | 'post'
        completed: !!st.completed,
        detail: st.shortDetail || st.detail || null,
      },
      homeAway: self?.homeAway || null,    // 'home' | 'away'
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

  // teamMeta comes from the ESPN records endpoint — NCAA doesn't publish a
  // clean W/L/runs/streak rollup, and ESPN's core.v2 endpoint is reliable
  // for every D1 team regardless of television coverage.
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

  const totals = {
    batting: ncaaTeamStats?.batting || {},
    pitching: ncaaTeamStats?.pitching || {},
  };
  const players = {
    batting: ncaaPlayerStats?.batting || [],
    pitching: ncaaPlayerStats?.pitching || [],
  };

  return {
    teamId: String(teamId),
    teamMeta,
    totals,
    players,
    // Rich conference-level payload when available. Currently populated for
    // SEC teams from wmt.games — 25 batting / 24 pitching / 14 fielding team
    // columns and the full roster (not a top-N slice) with 24 hitting /
    // 31 pitching / 15 fielding player columns. The TeamModal renders this
    // directly when present and falls back to the NCAA path otherwise.
    secWmt: secWmt || null,
    // Normalized per-game schedule for the TeamModal Schedule sub-tab.
    schedule: scheduleGames,
    meta: {
      source: secWmt ? 'ncaa-team+ncaa-player+sec-wmt' : 'ncaa-team+ncaa-player',
      scheduleEvents: events.length,
      completedEvents: completed.length,
      elapsedMs: Date.now() - startTime,
      ncaaTeamStats: ncaaTeamStats
        ? {
            found: ncaaTeamStats.found,
            attempted: ncaaTeamStats.attempted,
            timeExhausted: ncaaTeamStats.timeExhausted,
            elapsedMs: ncaaTeamStats.elapsedMs,
            totalPagesFetched: ncaaTeamStats.totalPagesFetched,
            pagesFetchedBySlug: ncaaTeamStats.pagesFetchedBySlug,
            slugStatus: ncaaTeamStats.slugStatus,
            error: ncaaTeamStats.error,
          }
        : null,
      ncaaPlayerStats: ncaaPlayerStats
        ? {
            playerCount: ncaaPlayerStats.playerCount,
            attempted: ncaaPlayerStats.attempted,
            slugsOk: ncaaPlayerStats.slugsOk,
            timeExhausted: ncaaPlayerStats.timeExhausted,
            elapsedMs: ncaaPlayerStats.elapsedMs,
            slugStatus: ncaaPlayerStats.slugStatus,
            error: ncaaPlayerStats.error,
          }
        : null,
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
    const data = await getTeamStats(teamId);
    return Response.json(data, {
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
