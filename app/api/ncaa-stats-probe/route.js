// One-off probe for figuring out what NCAA stat pages look like server-side.
// Useful when the henrygd wrapper goes down and we need to fall back to
// scraping NCAA.com (or stats.ncaa.org) directly but don't yet know which
// HTML markers carry the leaderboard data.
//
//   GET /api/ncaa-stats-probe?statId=271
//     -> fetches a small set of candidate URLs for batting-avg (271) and
//        returns, for each, status, body size, and a few "signal" excerpts
//        so I can see what's actually in there (table chunks, <script>
//        blobs that look like JSON, drupalSettings, etc.).
//
// Strip after the player-stats fallback is solid.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchSample(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    const text = await r.text();
    const len = text.length;

    // Pull a few diagnostic excerpts.
    const tables = [];
    const tableRe = /<table[^>]*>[\s\S]{0,2000}<\/table>/gi;
    let m;
    while ((m = tableRe.exec(text)) !== null && tables.length < 3) {
      tables.push(m[0].slice(0, 1200));
    }

    // Look for drupalSettings-style JSON blobs and any <script type="application/json">.
    const scripts = [];
    const scriptRe = /<script[^>]*>([\s\S]{0,4000}?)<\/script>/gi;
    while ((m = scriptRe.exec(text)) !== null && scripts.length < 8) {
      const body = m[1];
      if (/stat|player|rank|leader|data/i.test(body)) {
        scripts.push(body.slice(0, 800));
      }
    }

    const counts = {
      '<table': (text.match(/<table/gi) || []).length,
      '<tbody': (text.match(/<tbody/gi) || []).length,
      '<tr': (text.match(/<tr/gi) || []).length,
      '<option': (text.match(/<option/gi) || []).length,
      'drupalSettings': (text.match(/drupalSettings/gi) || []).length,
      '/individual/': (text.match(/\/individual\//gi) || []).length,
    };

    return {
      url,
      status: r.status,
      contentType: r.headers.get('content-type'),
      bytes: len,
      counts,
      sampleHead: text.slice(0, 600),
      tablesFound: tables.length,
      tableExcerpts: tables,
      scriptExcerpts: scripts,
    };
  } catch (e) {
    clearTimeout(t);
    return { url, error: String(e?.message || e) };
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const statId = searchParams.get('statId') || '271';

  const candidates = [
    `https://www.ncaa.com/stats/softball/d1/current/individual/${statId}`,
    `https://www.ncaa.com/stats/softball/d1/2026/individual/${statId}`,
    `https://www.ncaa.com/stats/softball/d1`,
    // stats.ncaa.org tends to have actual server-rendered tables.
    `https://stats.ncaa.org/rankings/change_sport_year_div`,
    `https://stats.ncaa.org/rankings/national_ranking?academic_year=2026.0&division=1.0&sport_code=W%2BSB&stat_seq=${statId}`,
  ];

  const results = [];
  for (const url of candidates) {
    results.push(await fetchSample(url));
  }

  return new Response(JSON.stringify({ statId, results }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
