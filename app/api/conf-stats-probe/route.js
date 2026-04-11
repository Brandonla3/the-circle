// Conference stats URL probe.
//
// Fetches the four conference stats pages provided by the user and
// returns enough of their HTML/structure so we can figure out how
// each one serves its stats data (inline HTML tables, iframe embed,
// __NEXT_DATA__ hydration blob, Sidearm .ashx endpoint, etc.).
//
//   GET /api/conf-stats-probe?conf=big12
//   GET /api/conf-stats-probe?conf=acc
//   GET /api/conf-stats-probe?conf=big10
//   GET /api/conf-stats-probe?conf=mw
//   GET /api/conf-stats-probe?conf=all
//
// Returns per-conference:
//   - status          HTTP status from the fetch
//   - contentType     the content-type header
//   - htmlLength      total bytes of HTML
//   - iframes         all <iframe src="..."> URLs found
//   - nextData        first 4KB of __NEXT_DATA__ blob if present
//   - nuxtData        first 4KB of __NUXT_DATA__ blob if present
//   - ashxLinks       any .ashx URLs found in the HTML
//   - servicesLinks   any /services/ URLs found in the HTML
//   - apiLinks        any /api/v2/ URLs found in the HTML
//   - wmtLinks        any wmt.games URLs found in the HTML
//   - tableCount      number of <table> elements found
//   - htmlSnippet     first 8KB of HTML for manual inspection

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CONFS = {
  big12: 'https://big12sports.com/stats.aspx?path=softball&year=2026',
  acc: 'https://theacc.com/stats.aspx?path=softball&year=2026',
  big10: 'https://bigten.org/sb/stats/',
  mw: 'https://themw.com/sports/softball/stats/',
};

// Match our schedule scrapers' user-agent (known to work on Vercel).
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

function extractAll(html, re) {
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] || m[0]);
    if (out.length > 20) break; // cap
  }
  return out;
}

function extractBlob(html, id) {
  const re = new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`);
  const m = html.match(re);
  if (!m) return null;
  return m[1].slice(0, 4000);
}

async function probeConference(slug, url) {
  const out = {
    slug,
    url,
    status: null,
    contentType: null,
    htmlLength: 0,
    iframes: [],
    nextData: null,
    nuxtData: null,
    ashxLinks: [],
    servicesLinks: [],
    apiLinks: [],
    wmtLinks: [],
    tableCount: 0,
    sidearmStatsScripts: [],
    htmlSnippet: null,
    error: null,
  };
  try {
    const r = await fetch(url, {
      headers: HEADERS,
      cache: 'no-store',
      redirect: 'follow',
    });
    out.status = r.status;
    out.contentType = r.headers.get('content-type') || null;
    if (!r.ok) return out;
    const html = await r.text();
    out.htmlLength = html.length;
    out.iframes = extractAll(html, /<iframe[^>]*src="([^"]+)"/g);
    out.nextData = extractBlob(html, '__NEXT_DATA__');
    out.nuxtData = extractBlob(html, '__NUXT_DATA__');
    out.ashxLinks = [...new Set(extractAll(html, /(https?:\/\/[^"'\s]+\.ashx[^"'\s]*)/g))];
    out.servicesLinks = [...new Set(extractAll(html, /([\w./:-]+\/services\/[\w./?=&-]+)/g))];
    out.apiLinks = [...new Set(extractAll(html, /([\w./:-]+\/api\/[\w./?=&-]+)/g))];
    out.wmtLinks = [...new Set(extractAll(html, /(https?:\/\/wmt\.games\/[^"'\s]+)/g))];
    out.tableCount = (html.match(/<table\b/gi) || []).length;
    // Sidearm often ships stats via inline <script> with `sport-stats` or `statsLoader`.
    out.sidearmStatsScripts = extractAll(html, /(statsLoader|sport-stats|stats-data|statsCache|statsUrl)[\s\S]{0,200}/g).slice(0, 5);
    out.htmlSnippet = html.slice(0, 8000);
  } catch (e) {
    out.status = 'error';
    out.error = String(e.message || e);
  }
  return out;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const which = searchParams.get('conf') || 'all';

  const toRun = which === 'all' ? Object.keys(CONFS) : [which];
  const results = {};
  for (const slug of toRun) {
    if (!CONFS[slug]) {
      results[slug] = { error: `unknown conf slug: ${slug}` };
      continue;
    }
    results[slug] = await probeConference(slug, CONFS[slug]);
  }

  return Response.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
