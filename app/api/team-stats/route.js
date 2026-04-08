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
const ncaaTeamLbCache = new Map();    // slug -> { fetchedAt, data }

// ncaa-api.henrygd.me throttles with HTTP 428 after ~5-6 parallel requests,
// same pattern the standings route documented in commit 5b32d2d. We batch
// at 4 concurrent with a small delay and retry transient failures.
const NCAA_BATCH_SIZE = 4;
const NCAA_BATCH_DELAY_MS = 150;
const NCAA_RETRY_DELAYS_MS = [500, 1000, 2000];
const NCAA_SCAN_BUDGET_MS = 7000;

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

async function fetchNcaaTeamLeaderboard(cat) {
  const cached = ncaaTeamLbCache.get(cat.slug);
  if (cached && Date.now() - cached.fetchedAt < NCAA_TEAM_LB_TTL_MS) return cached.data;

  if (!cat.id) return null;
  const url = `https://ncaa-api.henrygd.me/stats/softball/d1/current/team/${cat.id}`;
  const json = await fetchNcaaWithRetry(url);
  if (!json) return null;
  const data = {
    slug: cat.slug,
    id: cat.id,
    label: cat.label,
    short: cat.short,
    side: cat.side,
    lower: cat.lower,
    rows: json.data || [],
  };
  ncaaTeamLbCache.set(cat.slug, { fetchedAt: Date.now(), data });
  return data;
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
// list in throttled batches (4 concurrent with a short delay between
// batches) because the henrygd wrapper throttles with HTTP 428 above that
// threshold; fetchNcaaWithRetry handles the transient retries inside each
// batch. Cached results short-circuit the fetch entirely, so warm calls
// are essentially free. A 7s wall-clock budget matches standings/route.js
// so slow upstreams can't push this past Vercel's 10s request timeout.
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
    const batchResults = await Promise.all(batch.map((c) => fetchNcaaTeamLeaderboard(c)));
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
  const slugStatus = {};

  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    const lb = results[i];
    if (!lb) {
      // Upstream fetch failed, 4xx/5xx, unknown stat id, or we ran out
      // of time before this batch fired.
      if (!cat.id) slugStatus[cat.slug] = 'no-id';
      else if (timeExhausted && results[i] == null) slugStatus[cat.slug] = 'time-exhausted';
      else slugStatus[cat.slug] = 'fetch-failed';
      continue;
    }
    if (!lb.rows || lb.rows.length === 0) {
      slugStatus[cat.slug] = 'empty-leaderboard';
      continue;
    }
    const row = findNcaaTeamRow(lb.rows, nameVariantSet);
    if (!row) {
      slugStatus[cat.slug] = 'team-not-in-rows';
      continue;
    }
    const value = pickNcaaPrimaryValue(row, cat);
    if (value == null || value === '') {
      slugStatus[cat.slug] = 'no-value';
      continue;
    }
    found++;
    slugStatus[cat.slug] = 'ok';
    const target = cat.side === 'batting' ? batting : pitching;
    target[cat.short] = value;
    if (row.Rank || row.RANK || row.rank) {
      target[`${cat.short}_rank`] = row.Rank || row.RANK || row.rank;
    }
  }

  return {
    batting,
    pitching,
    found,
    attempted: cats.length,
    timeExhausted,
    elapsedMs: Date.now() - startTime,
    slugStatus,
  };
}

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
  // Kick off the NCAA team-stat fetch in parallel with the ESPN schedule
  // fetch — they're completely independent and the NCAA leaderboards are
  // cached for 10 min so warm calls are essentially free.
  const [schedule, nameVariantSet, ncaaTeamStatsP] = await Promise.all([
    fetchWithRetry(scheduleUrl),
    getTeamNameVariantSet(teamId),
    // Resolved later, after we have the variant set:
    getTeamNameVariantSet(teamId).then((vs) => aggregateNcaaTeamStats(teamId, vs)).catch(() => null),
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

  // Merge NCAA team-leaderboard values into totals. NCAA values are season
  // totals computed by NCAA themselves and cover every D1 team — they're
  // strictly better than ESPN box-score sums for the team-totals view, so
  // we OVERWRITE any ESPN-derived stat that NCAA also publishes.
  const ncaaTeamStats = await ncaaTeamStatsP;
  if (ncaaTeamStats) {
    if (ncaaTeamStats.batting && Object.keys(ncaaTeamStats.batting).length > 0) {
      finalized.totals.batting = { ...finalized.totals.batting, ...ncaaTeamStats.batting };
    }
    if (ncaaTeamStats.pitching && Object.keys(ncaaTeamStats.pitching).length > 0) {
      finalized.totals.pitching = { ...finalized.totals.pitching, ...ncaaTeamStats.pitching };
    }
  }

  return {
    teamId: String(teamId),
    ...finalized,
    meta: {
      source: 'espn-boxscore+ncaa-team',
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
      ncaaTeamStats: ncaaTeamStats
        ? {
            found: ncaaTeamStats.found,
            attempted: ncaaTeamStats.attempted,
            timeExhausted: ncaaTeamStats.timeExhausted,
            elapsedMs: ncaaTeamStats.elapsedMs,
            slugStatus: ncaaTeamStats.slugStatus,
            error: ncaaTeamStats.error,
          }
        : null,
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
