// Shared NCAA individual-leaderboard helpers. Used by both
// /api/player-stats (thin HTTP wrapper) and /api/team-stats
// (via aggregateNcaaPlayerStats, which walks every leaderboard to
// collect a single team's players).
//
// Data comes from the same ncaa-api.henrygd.me wrapper that standings,
// rpi, and team-stats all use:
//
//   https://ncaa-api.henrygd.me/stats/softball/d1/current/individual/{statId}
//
// NCAA uses opaque numeric stat IDs (e.g. 271 for batting average) that
// drift between seasons. Unlike the TEAM sidebar (which is client-side
// rendered and impossible to scrape — see team-stats/route.js), the
// individual stat index on /stats/softball/d1 embeds a full <option>
// dropdown listing every category, so pattern-based discovery works here.
// We still keep the two-pass label matcher from the original implementation
// in case NCAA's label wording shifts.
//
// Caches live at module scope for the lifetime of a warm Vercel instance.

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// Curated stat slugs we expose to the UI. `labels` is a list of possible
// NCAA sidebar labels we'll accept (via substring match) — NCAA varies
// between abbreviated ("ERA") and long ("Earned Run Average") wording
// depending on page, so we provide multiple aliases per category. `short`
// is the pretty column header the UI should show. `col` is the EXACT
// column name henrygd uses for the primary stat value in each leaderboard
// row, verified by probing each row shape; NCAA names these inconsistently
// (e.g. OBP is under "PCT", SLG is under "SLG PCT" with a space), so the
// old fallback that scanned for the first non-meta key was returning the
// wrong column for several slugs.
export const CATEGORY_BATTING = [
  { slug: 'batting-avg',   short: 'BA',   col: 'BA',      labels: ['Batting Average', 'Batting Avg', 'Batting Pct', 'Avg'] },
  { slug: 'home-runs',     short: 'HR',   col: 'HR',      labels: ['Home Runs', 'Home Runs Per Game', 'HR'] },
  { slug: 'rbi',           short: 'RBI',  col: 'RBI',     labels: ['RBIs', 'Runs Batted In', 'Runs Batted In Per Game', 'RBI Per Game', 'RBI'] },
  { slug: 'hits',          short: 'H',    col: 'H',       labels: ['Hits', 'Hits Per Game'] },
  { slug: 'runs-scored',   short: 'R',    col: 'R',       labels: ['Runs', 'Runs Scored', 'Runs Scored Per Game', 'Runs Per Game'] },
  { slug: 'stolen-bases',  short: 'SB',   col: 'SB',      labels: ['Stolen Bases', 'Stolen Bases Per Game', 'Stolen Base Pct'] },
  { slug: 'on-base-pct',   short: 'OBP',  col: 'PCT',     labels: ['On Base Percentage', 'On Base Pct', 'OBP'] },
  { slug: 'slugging-pct',  short: 'SLG',  col: 'SLG PCT', labels: ['Slugging Percentage', 'Slugging Pct', 'SLG'] },
  { slug: 'doubles',       short: '2B',   col: '2B',      labels: ['Doubles', 'Doubles Per Game'] },
  { slug: 'triples',       short: '3B',   col: '3B',      labels: ['Triples', 'Triples Per Game'] },
];

// Note: `whip` was previously in this list mapped to discovered stat id
// 1237, but the henrygd wrapper returns HTTP 500 "Could not parse data"
// for that endpoint — there is no working individual-level WHIP leaderboard
// on NCAA for softball. The Leaders sub-tab was silently showing dashes
// for WHIP before the extraction; dropping it makes that explicit so the
// rest of the list is honestly 17/17 rather than lying about 17 of 18.
export const CATEGORY_PITCHING = [
  { slug: 'era',              short: 'ERA',  col: 'ERA', labels: ['Earned Run Average', 'Earned Run Avg', 'ERA'] },
  { slug: 'wins',             short: 'W',    col: 'W',   labels: ['Victories', 'Pitching Wins', 'Wins'] },
  { slug: 'strikeouts',       short: 'SO',   col: 'SO',  labels: ['Strikeouts', 'Total Strikeouts', 'Strikeouts Per Game'] },
  { slug: 'saves',            short: 'SV',   col: 'SV',  labels: ['Saves', 'Saves Per Game'] },
  { slug: 'k-per-7',          short: 'K/7',  col: 'K/7', labels: ['Strikeouts Per Seven Innings', 'Strikeouts Per 7 Innings', 'Strikeouts/7', 'K/7'] },
  { slug: 'innings-pitched',  short: 'IP',   col: 'IP',  labels: ['Innings Pitched', 'Innings'] },
  { slug: 'shutouts',         short: 'SHO',  col: 'SHO', labels: ['Shutouts', 'Shutouts Per Game'] },
];

export const ALL_CATEGORIES = [
  ...CATEGORY_BATTING.map((c) => ({ ...c, side: 'batting' })),
  ...CATEGORY_PITCHING.map((c) => ({ ...c, side: 'pitching' })),
];

export const META_KEYS = new Set([
  'Rank', 'RANK', 'rank',
  'Name', 'NAME', 'name', 'Player',
  'Team', 'TEAM', 'team', 'School', 'school',
  'Cl', 'CL', 'Class', 'class',
  'Pos', 'POS', 'Position', 'position',
]);

// Module-scope caches.
let categoryMap = null;            // Map<slug, { id, label, short, side }>
let categoryMapPromise = null;     // dedupe in-flight discovery
const leaderboardCache = new Map();// keyed by `${slug}:p${page}`
const LEADERBOARD_TTL_MS = 60 * 60 * 1000; // NCAA publishes stats once daily

// Throttle/retry config mirrors team-stats/route.js so warm Vercel
// instances treat both players and teams the same way.
const NCAA_RETRY_DELAYS_MS = [500, 1000, 2000];

function normalizeLabel(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizePlayerKey(name, team) {
  const strip = (s) => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const norm = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${norm(name)}|${norm(team)}`;
}

// Best-effort: derive an NCAA Turner CDN logo URL from the team display name.
// NCAA hosts logos at a SEO-slug path; this matches for most schools but will
// 404 silently for some (e.g. Texas A&M). The client img tag handles failures.
export function teamLogoFromName(name) {
  if (!name) return null;
  const slug = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return null;
  return `https://i.turner.ncaa.com/sites/default/files/images/logos/schools/bgl/${slug}.svg`;
}

// Collect every (id -> label) pair from a chunk of HTML. We try several
// patterns because NCAA.com's stat index varies: sometimes it's rendered as
// <a href="...individual/NNN">Label</a>, sometimes as <option value="NNN">,
// and the URL prefix can be /current/, /2026/, or a relative path.
function extractLabelsFromHtml(html) {
  const found = new Map(); // id (string) -> label (string)

  const addMatch = (id, rawLabel) => {
    if (!id || !rawLabel) return;
    const label = rawLabel
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label || label.length < 2) return;
    // Keep the longest label we've seen for a given id (more descriptive).
    const prev = found.get(id);
    if (!prev || label.length > prev.length) found.set(id, label);
  };

  const patterns = [
    // <a href="...anything.../individual/NNN...">Label</a>
    /href="[^"]*?\/individual\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    // <option value="NNN">Label</option>  (dropdown form)
    /<option[^>]*\bvalue="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi,
    // <option value="...individual/NNN...">Label</option>
    /<option[^>]*\bvalue="[^"]*?\/individual\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/option>/gi,
    // data-stat-id="NNN" ... >Label<
    /data-stat-id="(\d+)"[^>]*>([\s\S]*?)</gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) addMatch(m[1], m[2]);
  }
  return found;
}

async function fetchWithTimeout(url, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { headers: HEADERS, cache: 'no-store', signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// Try several source URLs in order; the first one that yields any labels wins.
// NCAA.com's root stats page embeds a full <option> dropdown listing every
// category, so the generic <option value="NNN"> pattern scoops up all of them
// in one fetch. Individual stat pages by themselves don't expose the sidebar
// server-side (same client-rendering issue as the team-level sidebar), but
// the root page is enough.
async function discoverRawLabels() {
  const sources = [
    'https://www.ncaa.com/stats/softball/d1',
    'https://www.ncaa.com/stats/softball/d1/current/individual/271',
    'https://www.ncaa.com/stats/softball/d1/current/individual/200',
  ];
  const merged = new Map();
  const attempts = [];
  for (const url of sources) {
    try {
      const r = await fetchWithTimeout(url, 10000);
      const ok = r.ok;
      const html = ok ? await r.text() : '';
      const found = ok ? extractLabelsFromHtml(html) : new Map();
      attempts.push({ url, status: r.status, labelsFound: found.size });
      for (const [id, label] of found) {
        if (!merged.has(id)) merged.set(id, label);
      }
      if (merged.size >= 10) break; // enough coverage, stop probing
    } catch (e) {
      attempts.push({ url, status: 'error', error: String(e.message || e) });
    }
  }
  return { merged, attempts };
}

export async function discoverCategoryIds() {
  if (categoryMap) return categoryMap;
  if (categoryMapPromise) return categoryMapPromise;
  categoryMapPromise = (async () => {
    const { merged, attempts } = await discoverRawLabels();
    if (merged.size === 0) {
      const err = new Error('Failed to parse any NCAA stat categories');
      err.debug = { attempts };
      throw err;
    }

    // Index normalized NCAA labels -> id so we can do lenient matching.
    const normToId = new Map();
    const byId = {};
    for (const [id, label] of merged) {
      byId[id] = label;
      const norm = normalizeLabel(label);
      if (!normToId.has(norm)) normToId.set(norm, id);
    }

    // Two-pass matching with ID uniqueness:
    //   Pass 1 — exact normalized equality. Every curated category gets a
    //   shot before we fall back to fuzzier logic. This ensures a short
    //   unambiguous label like "WHIP" claims its ID before a long alias
    //   from a different category accidentally substring-matches it.
    //   Pass 2 — substring containment, but with a length guard so short
    //   NCAA labels (e.g. "Hits") can't be swallowed by a longer curated
    //   alias (e.g. "Walks Hits Per Innings Pitched").
    //
    // `usedIds` enforces that each NCAA stat ID is claimed by at most one
    // curated slug, so collisions surface as "missing" in debug instead of
    // silently pointing two slugs at the same wrong leaderboard.
    const MIN_SUBSTR_LEN = 6;
    const map = new Map();
    const usedIds = new Set();

    const claim = (slug, cat, id) => {
      usedIds.add(id);
      map.set(slug, {
        id,
        label: byId[id] || cat.labels[0],
        short: cat.short,
        side: cat.side,
      });
    };

    // Pass 1: exact match.
    for (const cat of ALL_CATEGORIES) {
      for (const alias of cat.labels) {
        const a = normalizeLabel(alias);
        if (!a) continue;
        const id = normToId.get(a);
        if (id && !usedIds.has(id)) {
          claim(cat.slug, cat, id);
          break;
        }
      }
    }

    // Pass 2: substring match with length guard, only for still-unmatched.
    for (const cat of ALL_CATEGORIES) {
      if (map.has(cat.slug)) continue;
      let hit = null;
      for (const alias of cat.labels) {
        const a = normalizeLabel(alias);
        if (!a || a.length < MIN_SUBSTR_LEN) continue;
        for (const [nLabel, id] of normToId) {
          if (usedIds.has(id)) continue;
          if (nLabel.length < MIN_SUBSTR_LEN) continue;
          if (nLabel.includes(a) || a.includes(nLabel)) {
            hit = id;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) claim(cat.slug, cat, hit);
    }

    if (map.size === 0) {
      const err = new Error('No curated categories matched any NCAA sidebar label');
      err.debug = { attempts, discoveredCount: merged.size, sampleLabels: Array.from(merged.values()).slice(0, 20) };
      throw err;
    }

    categoryMap = map;
    categoryMap._attempts = attempts;
    categoryMap._discoveredCount = merged.size;
    categoryMap._raw = Object.fromEntries(merged);
    return map;
  })();
  try {
    return await categoryMapPromise;
  } finally {
    categoryMapPromise = null;
  }
}

export function normalizeRow(row, cat) {
  const get = (...keys) => {
    for (const k of keys) {
      if (row[k] != null && row[k] !== '') return row[k];
    }
    return '';
  };
  const teamName = get('Team', 'TEAM', 'team', 'School', 'school');
  // Prefer the explicit column hint if the curated category has one; fall
  // back to the old scan-for-first-non-meta-key heuristic for any future
  // slug without a hint.
  let primary = '';
  if (cat.col && row[cat.col] != null && row[cat.col] !== '') {
    primary = row[cat.col];
  }
  if (!primary) primary = get(cat.short, cat.label || '');
  if (!primary) {
    for (const [k, v] of Object.entries(row)) {
      if (META_KEYS.has(k)) continue;
      if (v != null && v !== '') { primary = v; break; }
    }
  }
  return {
    rank: get('Rank', 'RANK', 'rank'),
    name: get('Name', 'NAME', 'name', 'Player'),
    team: teamName,
    teamLogo: teamLogoFromName(teamName),
    cls: get('Cl', 'CL', 'Class', 'class'),
    position: get('Pos', 'POS', 'Position', 'position'),
    // Batting leaderboards expose games under G/GP; pitching leaderboards
    // use App (appearances) instead, which is the closest equivalent to
    // games-pitched-in for softball relievers.
    gp: get('G', 'GP', 'gp', 'App', 'APP'),
    primary,
    raw: row,
  };
}

// Retry wrapper for the individual-leaderboard wrapper. Retries on
// 428/429/5xx/network errors with exponential backoff; gives up on 404
// and other 4xx. Matches team-stats fetchNcaaWithRetry.
async function fetchWithRetry(url) {
  for (let attempt = 0; attempt <= NCAA_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, NCAA_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const r = await fetch(url, {
        headers: { ...HEADERS, Accept: 'application/json' },
        cache: 'no-store',
      });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      if (r.status !== 428 && r.status !== 429 && r.status < 500) return null;
    } catch (e) {
      // network error — retry
    }
  }
  return null;
}

// Strip HTML tags + decode common entities from a cell/header chunk.
function decodeHtmlText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse a NCAA.com individual-stats page HTML and return the first stats
// table that looks like a leaderboard (has Name + Team columns and rows).
// NCAA.com renders these tables server-side under a Drupal block — same
// pages used for category discovery — so this works whenever the dropdown
// scrape works.
function parseNcaaStatsHtml(html) {
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRegex.exec(html)) !== null) {
    const inner = m[1];
    const theadMatch = inner.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
    const tbodyMatch = inner.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!theadMatch || !tbodyMatch) continue;

    const headers = [...theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
      .map((h) => decodeHtmlText(h[1]));
    if (headers.length < 4) continue;

    const lower = new Set(headers.map((h) => h.toLowerCase()));
    if (!lower.has('name') && !lower.has('player')) continue;
    if (!lower.has('team') && !lower.has('school')) continue;

    const rowMatches = [...tbodyMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rowMatches.length === 0) continue;

    const rows = rowMatches
      .map((rm) => {
        // NCAA sometimes renders the rank cell as <th> and the rest as <td>,
        // so accept either and read them in document order. Team cells often
        // wrap a logo <img> plus a link — stripping tags leaves just the
        // team text, which is what normalizeRow expects.
        const cells = [...rm[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
          .map((c) => decodeHtmlText(c[1]));
        if (cells.length === 0) return null;
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i] || ''; });
        return obj;
      })
      .filter(Boolean);

    if (rows.length === 0) continue;
    return { headers, rows };
  }
  return null;
}

// Total pages on NCAA.com are reflected in the pager — find the highest
// /pN suffix referenced for this stat ID. Falls back to 1 if no pager.
function parseNcaaTotalPages(html, statId) {
  const re = new RegExp(`\\/individual\\/${statId}\\/p(\\d+)`, 'gi');
  let max = 1;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// Direct NCAA.com fallback for when the henrygd.me JSON wrapper is failing
// or has stopped parsing a specific stat. Same data, just from the source
// HTML. Returns null when the page is unreachable or doesn't contain a
// parseable stats table.
async function fetchLeaderboardFromNcaaCom(statId, page = 1) {
  const suffix = page > 1 ? `/p${page}` : '';
  const url = `https://www.ncaa.com/stats/softball/d1/current/individual/${statId}${suffix}`;
  try {
    const r = await fetchWithTimeout(url, 12000);
    if (!r.ok) return null;
    const html = await r.text();
    const table = parseNcaaStatsHtml(html);
    if (!table || table.rows.length === 0) return null;
    return {
      rows: table.rows,
      totalPages: parseNcaaTotalPages(html, statId),
    };
  } catch {
    return null;
  }
}

// Fetch a single page of one individual leaderboard. Cached per-(slug, page)
// so repeated calls across teams only hit the wrapper once per TTL window.
//
// Two-stage fetch: try the henrygd.me JSON wrapper first (fast, structured),
// and on null fall through to scraping NCAA.com's server-rendered HTML
// directly. The wrapper has periodic outages and individual stat IDs that
// it can't parse (see WHIP note above), and when both stats-section APIs
// went down on 2026-05-16 the front-end showed "Failed to fetch
// leaderboard batting-avg" with no recourse — the direct fallback exists
// so a wrapper outage no longer takes the Players tab down.
export async function fetchLeaderboardPage(slug, page = 1) {
  const key = `${slug}:p${page}`;
  const cached = leaderboardCache.get(key);
  if (cached && Date.now() - cached.ts < LEADERBOARD_TTL_MS) return cached.data;

  const map = await discoverCategoryIds();
  const cat = map.get(slug);
  if (!cat) throw new Error(`Unknown category: ${slug}`);

  const suffix = page > 1 ? `/p${page}` : '';
  const wrapperUrl = `https://ncaa-api.henrygd.me/stats/softball/d1/current/individual/${cat.id}${suffix}`;
  const json = await fetchWithRetry(wrapperUrl);

  let rows;
  let totalPages;
  let updated = '';
  let title = cat.label;
  let source = 'henrygd';

  if (json) {
    rows = (json.data || []).map((row) => normalizeRow(row, cat));
    totalPages = json.pages || 1;
    updated = json.updated || '';
    title = json.title || cat.label;
  } else {
    const fallback = await fetchLeaderboardFromNcaaCom(cat.id, page);
    if (!fallback) {
      // Don't cache failures — let the next request retry both paths.
      return null;
    }
    rows = fallback.rows.map((row) => normalizeRow(row, cat));
    totalPages = fallback.totalPages;
    source = 'ncaa.com';
  }

  const data = {
    slug,
    label: cat.label,
    short: cat.short,
    side: cat.side,
    statId: cat.id,
    title,
    updated,
    page,
    totalPages,
    rows,
    source,
  };
  leaderboardCache.set(key, { ts: Date.now(), data });
  return data;
}

// Page-1 alias for backwards compatibility with the original
// player-stats/route.js signature. Existing callers expect
// fetchLeaderboard(slug) to return the top-50 leaderboard.
export async function fetchLeaderboard(slug) {
  return fetchLeaderboardPage(slug, 1);
}

// Fetch pages 1..maxPages of one leaderboard and return the concatenated
// rows. Used by team-stats to collect every player on a given team across
// every stat. Stops early when the wrapper reports we've hit the last
// page. On page-1 fetch failure returns null; on later-page failures
// returns whatever was collected so far.
export async function fetchLeaderboardAllPages(slug, maxPages = 4) {
  const firstPage = await fetchLeaderboardPage(slug, 1);
  if (!firstPage) return null;
  const merged = {
    ...firstPage,
    page: 'all',
    totalPages: firstPage.totalPages,
    rows: [...firstPage.rows],
  };
  const lastPage = Math.min(maxPages, firstPage.totalPages || 1);
  for (let p = 2; p <= lastPage; p++) {
    const next = await fetchLeaderboardPage(slug, p);
    if (!next || !next.rows || next.rows.length === 0) break;
    merged.rows.push(...next.rows);
  }
  return merged;
}

export async function fetchProfile({ name, team, side }) {
  if (!name) throw new Error('name required');
  if (side !== 'batting' && side !== 'pitching') {
    throw new Error('side must be batting or pitching');
  }
  const cats = side === 'batting' ? CATEGORY_BATTING : CATEGORY_PITCHING;
  const targetKey = normalizePlayerKey(name, team);
  const nameOnly = normalizePlayerKey(name, '').split('|')[0];

  // Each leaderboard call is independently cached, so a warm profile fetch
  // resolves entirely from in-memory cache after the first cold pass.
  const results = await Promise.all(
    cats.map((c) =>
      fetchLeaderboard(c.slug).catch((e) => ({ error: e.message, slug: c.slug }))
    )
  );

  let player = null;
  const appearsIn = [];
  const merged = {};

  for (const board of results) {
    if (!board || board.error || !board.rows) continue;
    let row = board.rows.find((r) => normalizePlayerKey(r.name, r.team) === targetKey);
    if (!row) {
      // Last-resort name-only fallback (rare; team strings are stable in a
      // single response so this mostly catches diacritic/punct edge cases).
      row = board.rows.find(
        (r) => normalizePlayerKey(r.name, '').split('|')[0] === nameOnly
      );
    }
    if (!row) continue;

    if (!player) {
      player = {
        name: row.name,
        team: row.team,
        teamLogo: row.teamLogo,
        cls: row.cls,
        position: row.position,
        gp: row.gp,
      };
    }
    appearsIn.push({
      slug: board.slug,
      label: board.label,
      short: board.short,
      rank: row.rank,
      value: row.primary,
    });
    Object.assign(merged, row.raw);
  }

  if (!player) {
    return { error: `No leaderboard rows found for ${name}${team ? ` (${team})` : ''}` };
  }

  const stats = [];
  for (const [k, v] of Object.entries(merged)) {
    if (META_KEYS.has(k)) continue;
    if (v == null || v === '') continue;
    stats.push({ label: k, value: v });
  }

  return { player, side, appearsIn, stats };
}
