export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Major D1 softball conferences. Slug format matches d1softball.com URLs:
// https://d1softball.com/conference/<slug>/
const CONFERENCES = [
  { name: 'SEC', slug: 'southeastern-conference' },
  { name: 'ACC', slug: 'atlantic-coast-conference' },
  { name: 'Big 12', slug: 'big-12-conference' },
  { name: 'Big Ten', slug: 'big-ten-conference' },
  { name: 'Pac-12', slug: 'pac-12-conference' },
  { name: 'American', slug: 'american-athletic-conference' },
  { name: 'Big East', slug: 'big-east-conference' },
  { name: 'Mountain West', slug: 'mountain-west-conference' },
  { name: 'Conference USA', slug: 'conference-usa' },
  { name: 'Sun Belt', slug: 'sun-belt-conference' },
];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function stripTags(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse a single HTML table into { headers: [], rows: [[]] }
function parseTable(tableHtml) {
  const rowMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows = rowMatches.map((m) => {
    const cellHtml = m[1];
    const cells = [...cellHtml.matchAll(/<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => c[2]);
    return cells;
  });
  if (rows.length === 0) return null;
  let headerRow = null;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 3); i++) {
    if (/<th[\s>]/i.test(rowMatches[i][1])) {
      headerRow = rows[i].map(stripTags);
      headerIdx = i;
      break;
    }
  }
  const dataRows = rows.slice(headerIdx + 1).filter((r) => r.length > 1);
  return { headers: headerRow || [], rows: dataRows };
}

// Score how "standings-like" a table looks. Higher = more likely.
function scoreTable(parsed) {
  if (!parsed || parsed.rows.length < 4) return 0;
  let score = 0;
  const headerStr = parsed.headers.join(' ').toLowerCase();
  if (/team|school/.test(headerStr)) score += 3;
  if (/conf|conference/.test(headerStr)) score += 3;
  if (/overall|record/.test(headerStr)) score += 3;
  if (/\bw\b|\bl\b|wins|losses/.test(headerStr)) score += 2;
  if (/pct|percent|gb|streak/.test(headerStr)) score += 2;
  if (parsed.rows.length >= 6 && parsed.rows.length <= 20) score += 2;
  // First column should look like team names (have alpha chars)
  const firstColSample = parsed.rows.slice(0, 3).map((r) => stripTags(r[0] || '')).join(' ');
  if (/[A-Za-z]{3,}/.test(firstColSample)) score += 1;
  return score;
}

function extractStandingsFromHtml(html) {
  const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  let best = null;
  let bestScore = 0;
  for (const t of tables) {
    const parsed = parseTable(t[1]);
    const s = scoreTable(parsed);
    if (s > bestScore) {
      best = parsed;
      bestScore = s;
    }
  }
  return bestScore >= 5 ? best : null;
}

function rowsToTeams(parsed) {
  return parsed.rows
    .map((cells) => {
      const stripped = cells.map(stripTags);
      const logoMatch = cells[0]?.match(/<img[^>]+src=["']([^"']+)["']/i);
      return {
        name: stripped[0] || '',
        logo: logoMatch?.[1],
        stats: stripped.slice(1),
      };
    })
    .filter((t) => t.name && !/^total/i.test(t.name));
}

async function fetchConference(conf) {
  const url = `https://d1softball.com/conference/${conf.slug}/`;
  try {
    const r = await fetch(url, { headers: HEADERS, redirect: 'follow', cache: 'no-store' });
    if (!r.ok) return { name: conf.name, error: `HTTP ${r.status}`, url };
    const html = await r.text();
    const parsed = extractStandingsFromHtml(html);
    if (!parsed) return { name: conf.name, error: 'No standings table found', url };
    return {
      name: conf.name,
      abbreviation: conf.name,
      headers: parsed.headers.slice(1),
      teams: rowsToTeams(parsed),
      source: 'd1softball.com',
      sourceUrl: url,
    };
  } catch (e) {
    return { name: conf.name, error: e.message, url };
  }
}

export async function GET() {
  const results = await Promise.all(CONFERENCES.map(fetchConference));
  const conferences = results.filter((r) => !r.error && r.teams?.length);
  const failures = results.filter((r) => r.error || !r.teams?.length);
  if (conferences.length === 0) {
    return Response.json(
      { error: 'Could not parse standings from any conference', debug: failures },
      { status: 502 }
    );
  }
  return Response.json(
    { conferences, failures: failures.length ? failures : undefined },
    { headers: { 'Cache-Control': 'public, max-age=600' } }
  );
}
