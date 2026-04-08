export const dynamic = 'force-dynamic';
export const revalidate = 0;

const URLS = [
  'https://www.espn.com/college-softball/standings',
  'https://www.espn.com/college-softball/standings/_/group/9', // sometimes scoped URL works when root doesn't
];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

async function fetchHtml(url) {
  const r = await fetch(url, { headers: HEADERS, redirect: 'follow', cache: 'no-store' });
  return { status: r.status, ok: r.ok, html: await r.text(), finalUrl: r.url };
}

function extractBlob(html) {
  // Try a few patterns ESPN has used over the years.
  const patterns = [
    /window\['__espnfitt__'\]\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\["__espnfitt__"\]\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /__espnfitt__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try { return JSON.parse(m[1]); } catch (_) { /* try next */ }
    }
  }
  return null;
}

function parseConferences(blob) {
  const conferences = [];
  const seen = new Set();
  const tryExtract = (node) => {
    if (!node || typeof node !== 'object') return;
    const rows = node.standings?.rows || node.rows;
    const cols = node.standings?.headers || node.standings?.cols || node.cols;
    const name = node.name || node.displayName || node.shortName;
    if (Array.isArray(rows) && rows.length && name) {
      const key = `${name}-${rows.length}`;
      if (seen.has(key)) return;
      seen.add(key);
      const teams = rows.map((row) => {
        const team = row.team || {};
        const stats = (row.stats || row.values || []).map((s) =>
          typeof s === 'object' ? (s.displayValue ?? s.value ?? '') : s
        );
        return {
          id: team.id || team.uid,
          name: team.displayName || team.name || team.location || '',
          abbreviation: team.abbreviation || team.abbrev,
          logo: team.logo || team.logos?.[0]?.href,
          stats,
        };
      });
      conferences.push({
        name,
        abbreviation: node.abbrev || node.abbreviation,
        headers: Array.isArray(cols)
          ? cols.map((c) => (typeof c === 'object' ? c.text || c.label || c.title || '' : c))
          : [],
        teams,
      });
    }
  };
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 14) return;
    tryExtract(node);
    if (Array.isArray(node)) node.forEach((c) => walk(c, depth + 1));
    else for (const k of Object.keys(node)) walk(node[k], depth + 1);
  };
  walk(blob);
  return conferences;
}

export async function GET() {
  const debug = [];
  for (const url of URLS) {
    try {
      const { status, ok, html, finalUrl } = await fetchHtml(url);
      debug.push({ url, status, finalUrl, htmlLen: html?.length || 0 });
      if (!ok) continue;
      const blob = extractBlob(html);
      if (!blob) {
        debug.push({ note: 'no blob found at ' + url });
        continue;
      }
      const conferences = parseConferences(blob);
      if (conferences.length === 0) {
        debug.push({ note: 'blob found but no conferences parsed at ' + url });
        continue;
      }
      return Response.json(
        { conferences },
        { headers: { 'Cache-Control': 'public, max-age=300' } }
      );
    } catch (e) {
      debug.push({ url, error: e.message });
    }
  }
  return Response.json({ error: 'Could not fetch or parse standings', debug }, { status: 502 });
}
