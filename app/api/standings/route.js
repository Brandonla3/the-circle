export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Fetch ESPN's college softball standings web page and extract the embedded
// __espnfitt__ JSON blob, which contains standings broken down by conference.
export async function GET() {
  try {
    const r = await fetch('https://www.espn.com/college-softball/standings', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      cache: 'no-store',
    });
    if (!r.ok) {
      return Response.json({ error: `HTTP ${r.status}` }, { status: 502 });
    }
    const html = await r.text();
    const match = html.match(/window\['__espnfitt__'\]\s*=\s*(\{[\s\S]*?\});<\/script>/);
    if (!match) {
      return Response.json({ error: 'Could not locate __espnfitt__ blob' }, { status: 500 });
    }
    let blob;
    try {
      blob = JSON.parse(match[1]);
    } catch (e) {
      return Response.json({ error: 'Failed to parse __espnfitt__: ' + e.message }, { status: 500 });
    }

    // Walk the blob looking for any node that looks like a standings table.
    // ESPN typically nests these under page.content.standings.groups[].standings.
    const conferences = [];
    const seen = new Set();

    const tryExtractTable = (node) => {
      if (!node || typeof node !== 'object') return;
      // Common shape: { name, abbrev, standings: { rows: [...] } } with column headers under standings.headers
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
      if (!node || typeof node !== 'object' || depth > 12) return;
      tryExtractTable(node);
      if (Array.isArray(node)) {
        node.forEach((c) => walk(c, depth + 1));
      } else {
        for (const k of Object.keys(node)) walk(node[k], depth + 1);
      }
    };
    walk(blob);

    return Response.json(
      { conferences },
      { headers: { 'Cache-Control': 'public, max-age=300' } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
