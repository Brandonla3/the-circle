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

// Curated stat slugs we expose to the UI. The `label` field is matched against
// NCAA.com's category sidebar to resolve the opaque stat ID. `short` is the
// column header we expect henrygd to surface for the primary stat.
const CATEGORY_BATTING = [
  { slug: 'batting-avg',   label: 'Batting Average',          short: 'BA'  },
  { slug: 'home-runs',     label: 'Home Runs',                short: 'HR'  },
  { slug: 'rbi',           label: 'Runs Batted In',           short: 'RBI' },
  { slug: 'hits',          label: 'Hits',                     short: 'H'   },
  { slug: 'runs-scored',   label: 'Runs Scored',              short: 'R'   },
  { slug: 'stolen-bases',  label: 'Stolen Bases',             short: 'SB'  },
  { slug: 'on-base-pct',   label: 'On Base Percentage',       short: 'OBP' },
  { slug: 'slugging-pct',  label: 'Slugging Percentage',      short: 'SLG' },
  { slug: 'doubles',       label: 'Doubles',                  short: '2B'  },
];

const CATEGORY_PITCHING = [
  { slug: 'era',              label: 'Earned Run Average',            short: 'ERA'  },
  { slug: 'wins',             label: 'Wins',                          short: 'W'    },
  { slug: 'strikeouts',       label: 'Strikeouts',                    short: 'SO'   },
  { slug: 'saves',            label: 'Saves',                         short: 'SV'   },
  { slug: 'whip',             label: 'WHIP',                          short: 'WHIP' },
  { slug: 'k-per-7',          label: 'Strikeouts Per Seven Innings',  short: 'K/7'  },
  { slug: 'innings-pitched',  label: 'Innings Pitched',               short: 'IP'   },
  { slug: 'shutouts',         label: 'Shutouts',                      short: 'SHO'  },
  { slug: 'opponent-ba',      label: 'Opponent Batting Average',      short: 'OBA'  },
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

async function discoverCategoryIds() {
  if (categoryMap) return categoryMap;
  if (categoryMapPromise) return categoryMapPromise;
  categoryMapPromise = (async () => {
    const url = 'https://www.ncaa.com/stats/softball/d1';
    const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) throw new Error(`NCAA stats index HTTP ${r.status}`);
    const html = await r.text();

    // Pull every "/stats/softball/d1/current/individual/NNN" link with its label.
    // The sidebar wraps each category in an <a>; we capture the id and the
    // visible text (which may include extra whitespace from layout markup).
    const linkRe =
      /href="\/stats\/softball\/d1\/current\/individual\/(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const labelToId = new Map();
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const id = m[1];
      const label = m[2]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const key = normalizeLabel(label);
      if (key && !labelToId.has(key)) labelToId.set(key, id);
    }
    if (labelToId.size === 0) {
      throw new Error('Failed to parse any NCAA stat categories from sidebar');
    }

    const map = new Map();
    for (const cat of ALL_CATEGORIES) {
      const id = labelToId.get(normalizeLabel(cat.label));
      if (id) map.set(cat.slug, { id, label: cat.label, short: cat.short, side: cat.side });
    }
    if (map.size === 0) {
      throw new Error('No curated categories matched any NCAA sidebar label');
    }
    categoryMap = map;
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
  let primary = get(cat.short, cat.label);
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

    const slug = searchParams.get('category');
    if (!slug) {
      // Index of categories the UI can show.
      const map = await discoverCategoryIds();
      const categories = ALL_CATEGORIES
        .filter((c) => map.has(c.slug))
        .map((c) => ({
          slug: c.slug,
          label: c.label,
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
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
