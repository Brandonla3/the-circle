// NCAA D1 Softball player stats — leaderboards + cross-category player profiles.
//
//   GET /api/player-stats                            -> { categories: [...] }
//   GET /api/player-stats?category=home-runs         -> leaderboard rows
//   GET /api/player-stats?profile=1&name=...&team=...&side=batting|pitching
//                                                    -> merged player profile
//
// Data flows through the same ncaa-api.henrygd.me wrapper that
// app/api/standings/route.js and app/api/rpi/route.js already use. The wrapper
// mirrors ncaa.com URLs:
//
//   https://ncaa-api.henrygd.me/stats/softball/d1/current/individual/{statId}
//
// NCAA uses opaque numeric stat IDs (e.g. 271 for batting average) that drift
// between seasons, so rather than hardcoding them we discover them once at
// cold start by scraping the category sidebar at ncaa.com/stats/softball/d1
// and caching the {label -> id} map in module scope.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// Curated stat slugs we expose to the UI. `labels` is a list of possible NCAA
// sidebar labels we'll accept (via substring match) — NCAA varies between
// abbreviated ("ERA") and long ("Earned Run Average") wording depending on
// page, so we provide multiple aliases per category. `short` is the column
// header we expect henrygd to surface for the primary stat.
const CATEGORY_BATTING = [
  { slug: 'batting-avg',   short: 'BA',   labels: ['Batting Average', 'Batting Avg', 'Batting Pct', 'Avg'] },
  { slug: 'home-runs',     short: 'HR',   labels: ['Home Runs Per Game', 'Home Runs', 'HR'] },
  { slug: 'rbi',           short: 'RBI',  labels: ['Runs Batted In Per Game', 'Runs Batted In', 'RBI Per Game', 'RBI'] },
  { slug: 'hits',          short: 'H',    labels: ['Hits Per Game', 'Hits'] },
  { slug: 'runs-scored',   short: 'R',    labels: ['Runs', 'Runs Scored', 'Runs Scored Per Game', 'Runs Per Game'] },
  { slug: 'stolen-bases',  short: 'SB',   labels: ['Stolen Bases Per Game', 'Stolen Bases', 'Stolen Base Pct'] },
  { slug: 'on-base-pct',   short: 'OBP',  labels: ['On Base Percentage', 'On Base Pct', 'OBP'] },
  { slug: 'slugging-pct',  short: 'SLG',  labels: ['Slugging Percentage', 'Slugging Pct', 'SLG'] },
  { slug: 'doubles',       short: '2B',   labels: ['Doubles Per Game', 'Doubles'] },
  { slug: 'triples',       short: '3B',   labels: ['Triples Per Game', 'Triples'] },
  { slug: 'walks',         short: 'BB',   labels: ['Walks Drawn Per Game', 'Walks Per Game', 'Walks'] },
];

const CATEGORY_PITCHING = [
  { slug: 'era',              short: 'ERA',  labels: ['Earned Run Average', 'Earned Run Avg', 'ERA'] },
  { slug: 'wins',             short: 'W',    labels: ['Victories', 'Pitching Wins', 'Wins'] },
  { slug: 'strikeouts',       short: 'SO',   labels: ['Strikeouts', 'Total Strikeouts', 'Strikeouts Per Game'] },
  { slug: 'saves',            short: 'SV',   labels: ['Saves', 'Saves Per Game'] },
  { slug: 'whip',             short: 'WHIP', labels: ['WHIP', 'Walks Hits Per Innings Pitched'] },
  { slug: 'k-per-7',          short: 'K/7',  labels: ['Strikeouts Per Seven Innings', 'Strikeouts Per 7 Innings', 'Strikeouts/7', 'K/7'] },
  { slug: 'innings-pitched',  short: 'IP',   labels: ['Innings Pitched', 'Innings'] },
  { slug: 'shutouts',         short: 'SHO',  labels: ['Shutouts', 'Shutouts Per Game'] },
];

const ALL_CATEGORIES = [
  ...CATEGORY_BATTING.map((c) => ({ ...c, side: 'batting' })),
  ...CATEGORY_PITCHING.map((c) => ({ ...c, side: 'pitching' })),
];

// Module-scope caches.
let categoryMap = null;            // Map<slug, { id, label, short, side }>
let categoryMapPromise = null;     // dedupe in-flight discovery
const leaderboardCache = new Map();
const LEADERBOARD_TTL_MS = 10 * 60 * 1000;

const META_KEYS = new Set([
  'Rank', 'RANK', 'rank',
  'Name', 'NAME', 'name', 'Player',
  'Team', 'TEAM', 'team', 'School', 'school',
  'Cl', 'CL', 'Class', 'class',
  'Pos', 'POS', 'Position', 'position',
]);

function normalizeLabel(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizePlayerKey(name, team) {
  const strip = (s) => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const norm = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${norm(name)}|${norm(team)}`;
}

// Best-effort: derive an NCAA Turner CDN logo URL from the team display name.
// NCAA hosts logos at a SEO-slug path; this matches for most schools but will
// 404 silently for some (e.g. Texas A&M). The client img tag handles failures.
function teamLogoFromName(name) {
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
// NCAA.com's root stats page may render an empty sidebar client-side, whereas
// an individual stat page typically renders the full category list server-side.
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

async function discoverCategoryIds() {
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
    //   Pass 1 — exact normalized equality. Every curated category gets a shot
    //   before we fall back to fuzzier logic. This ensures a short unambiguous
    //   label like "WHIP" claims its ID before a long alias from a different
    //   category accidentally substring-matches it.
    //   Pass 2 — substring containment, but with a length guard so short NCAA
    //   labels (e.g. "Hits") can't be swallowed by a longer curated alias
    //   (e.g. "Walks Hits Per Innings Pitched").
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

function normalizeRow(row, cat) {
  const get = (...keys) => {
    for (const k of keys) {
      if (row[k] != null && row[k] !== '') return row[k];
    }
    return '';
  };
  const teamName = get('Team', 'TEAM', 'team', 'School', 'school');
  // Pull the primary stat: try the curated short header first, then fall back
  // to scanning the row for the first numeric-looking non-metadata value.
  let primary = get(cat.short, cat.label || '');
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
    gp: get('G', 'GP', 'gp'),
    primary,
    raw: row,
  };
}

async function fetchLeaderboard(slug) {
  const cached = leaderboardCache.get(slug);
  if (cached && Date.now() - cached.ts < LEADERBOARD_TTL_MS) return cached.data;

  const map = await discoverCategoryIds();
  const cat = map.get(slug);
  if (!cat) throw new Error(`Unknown category: ${slug}`);

  const url = `https://ncaa-api.henrygd.me/stats/softball/d1/current/individual/${cat.id}`;
  const r = await fetch(url, {
    headers: { ...HEADERS, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`henrygd HTTP ${r.status} for ${slug}`);
  const json = await r.json();

  const rows = (json.data || []).map((row) => normalizeRow(row, cat));
  const data = {
    slug,
    label: cat.label,
    short: cat.short,
    side: cat.side,
    statId: cat.id,
    title: json.title || cat.label,
    updated: json.updated || '',
    rows,
  };
  leaderboardCache.set(slug, { ts: Date.now(), data });
  return data;
}

async function fetchProfile({ name, team, side }) {
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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get('profile');

  try {
    if (profile) {
      const data = await fetchProfile({
        name: searchParams.get('name') || '',
        team: searchParams.get('team') || '',
        side: searchParams.get('side') || 'batting',
      });
      return new Response(JSON.stringify(data), {
        status: data.error ? 404 : 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600',
        },
      });
    }

    // Diagnostic endpoint — returns what discovery actually found so we can
    // iterate on the label-matching logic without flying blind.
    if (searchParams.get('debug')) {
      try {
        const map = await discoverCategoryIds();
        const matched = ALL_CATEGORIES
          .filter((c) => map.has(c.slug))
          .map((c) => ({
            slug: c.slug,
            side: c.side,
            tried: c.labels,
            matchedNcaaLabel: map.get(c.slug).label,
            statId: map.get(c.slug).id,
          }));
        const missing = ALL_CATEGORIES
          .filter((c) => !map.has(c.slug))
          .map((c) => ({ slug: c.slug, side: c.side, tried: c.labels }));
        return new Response(JSON.stringify({
          ok: true,
          attempts: map._attempts || [],
          discoveredCount: map._discoveredCount || 0,
          rawDiscovered: map._raw || {},
          curatedMatched: matched,
          curatedMissing: missing,
        }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          error: e.message,
          debug: e.debug || null,
        }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const slug = searchParams.get('category');
    if (!slug) {
      // Index of categories the UI can show.
      const map = await discoverCategoryIds();
      const categories = ALL_CATEGORIES
        .filter((c) => map.has(c.slug))
        .map((c) => ({
          slug: c.slug,
          label: map.get(c.slug).label,
          short: c.short,
          side: c.side,
        }));
      return new Response(JSON.stringify({ categories }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600, s-maxage=600',
        },
      });
    }

    const data = await fetchLeaderboard(slug);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600, s-maxage=600',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, debug: e.debug || undefined }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
