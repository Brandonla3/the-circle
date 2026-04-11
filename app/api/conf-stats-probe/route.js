// Conference stats URL probe (enhanced).
//
// Fetches the four conference stats pages the user provided and returns
// targeted extractions tailored to each one's format:
//
//   Big 12 / ACC  — Sidearm plain HTML tables. Return the first N
//                    tables' class/id + thead labels + first 3 rows.
//   Big Ten        — Boost Sport AI CMS with client-rendered stats from
//                    an API. Return the whole __NEXT_DATA__ JSON (parsed)
//                    and let us search for stats-related keys.
//   Mountain West  — WordPress site with an inline `stats-data` script.
//                    Return the full content of that script.
//
//   GET /api/conf-stats-probe?conf=all
//   GET /api/conf-stats-probe?conf=big12
//   GET /api/conf-stats-probe?conf=acc
//   GET /api/conf-stats-probe?conf=big10
//   GET /api/conf-stats-probe?conf=mw

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CONFS = {
  big12: {
    url: 'https://big12sports.com/stats.aspx?path=softball&year=2026',
    type: 'sidearm-tables',
  },
  acc: {
    url: 'https://theacc.com/stats.aspx?path=softball&year=2026',
    type: 'sidearm-tables',
  },
  big10: {
    url: 'https://bigten.org/sb/stats/',
    type: 'boost-nextdata',
  },
  mw: {
    url: 'https://themw.com/sports/softball/stats/',
    type: 'wp-statsdata-script',
  },
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Strip HTML tags + decode common entities, collapse whitespace.
function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract <table>...</table> blocks with their opening tag. Capped so
// we don't OOM on pages with 100+ tables.
function extractTables(html, maxTables = 30) {
  const out = [];
  const re = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ attrs: m[1], inner: m[2] });
    if (out.length >= maxTables) break;
  }
  return out;
}

function parseSidearmTables(html) {
  const tables = extractTables(html, 40);
  return tables.map((t, idx) => {
    // Pull class and id out of the opening-tag attrs.
    const cls = (t.attrs.match(/class="([^"]*)"/) || [])[1] || null;
    const id = (t.attrs.match(/id="([^"]*)"/) || [])[1] || null;
    // Also pull data-* attributes for hints like data-stat-type.
    const dataAttrs = [];
    const dre = /data-[a-z-]+="[^"]*"/gi;
    let dm;
    while ((dm = dre.exec(t.attrs)) !== null) dataAttrs.push(dm[0]);
    // Find caption (Sidearm stats tables usually have one).
    const capMatch = t.inner.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const caption = capMatch ? stripTags(capMatch[1]) : null;
    // thead → column labels.
    const theadMatch = t.inner.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
    let headers = null;
    if (theadMatch) {
      const ths = [];
      const thRe = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
      let tm;
      while ((tm = thRe.exec(theadMatch[1])) !== null) {
        ths.push(stripTags(tm[1]));
      }
      headers = ths;
    }
    // tbody → first 3 data rows as arrays of cell text.
    const tbodyMatch = t.inner.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    let rows = null;
    if (tbodyMatch) {
      rows = [];
      const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let trm;
      while ((trm = trRe.exec(tbodyMatch[1])) !== null) {
        const cells = [];
        const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let tdm;
        while ((tdm = tdRe.exec(trm[1])) !== null) {
          cells.push(stripTags(tdm[1]));
        }
        rows.push(cells);
        if (rows.length >= 3) break;
      }
    }
    return { idx, id, cls, caption, dataAttrs, headers, rowCount: rows?.length || 0, firstRows: rows };
  });
}

function parseBoostNextData(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { error: '__NEXT_DATA__ not found' };
  let parsed;
  try { parsed = JSON.parse(m[1]); }
  catch (e) { return { error: `parse: ${e.message}`, rawLength: m[1].length }; }
  // Walk the tree and find every key that looks stats-related.
  const interesting = {};
  function walk(obj, path = '$', depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === 'object') {
        walk(obj[0], `${path}[0]`, depth + 1);
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      const kl = k.toLowerCase();
      if (/stat|batting|pitching|fielding|players?|roster/.test(kl)) {
        interesting[`${path}.${k}`] = {
          type: Array.isArray(v) ? `array[${v.length}]` : typeof v,
          sample: typeof v === 'object' && v !== null
            ? (Array.isArray(v)
                ? (v.length > 0 ? JSON.stringify(v[0]).slice(0, 400) : '[]')
                : JSON.stringify(v).slice(0, 400))
            : String(v).slice(0, 200),
        };
      }
      if (typeof v === 'object' && v !== null) {
        walk(v, `${path}.${k}`, depth + 1);
      }
    }
  }
  walk(parsed);
  // Also return the top-level keys.
  const topKeys = Object.keys(parsed);
  const pagePropsKeys = parsed?.props?.pageProps ? Object.keys(parsed.props.pageProps) : null;
  // Grab buildId and runtime config so we can figure out API calls.
  const buildId = parsed.buildId || null;
  const runtimeConfig = parsed.runtimeConfig || parsed?.props?.pageProps?.runtimeConfig || null;
  return { topKeys, pagePropsKeys, buildId, runtimeConfig, interesting };
}

function parseWpStatsData(html) {
  // The "stats-data" script tag may look like:
  //   <script id="stats-data" type="application/json">{...}</script>
  // or embedded in an attribute. Try a few patterns.
  const patterns = [
    /<script[^>]*id=["']stats-data["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]*class=["'][^"']*stats-data[^"']*["'][^>]*>([\s\S]*?)<\/script>/i,
    /<[^>]*data-stats=["']([^"']+)["']/,
    /"stats-data"\s*:\s*(\{[\s\S]+?\})/,
    /window\.statsData\s*=\s*(\{[\s\S]+?\});/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) {
      return { matched: p.source, content: m[1].slice(0, 20000) };
    }
  }
  // Also search for any inline JSON that looks like stats.
  const jsonMatches = [...html.matchAll(/(\{[^{}]*?"(?:batting|pitching|stats|players?)"[\s\S]*?\})/gi)]
    .slice(0, 3)
    .map((m) => m[1].slice(0, 1500));
  // Also collect any wmt.digital / wmt.games URLs in the page.
  const wmtUrls = [...new Set([...html.matchAll(/(https?:\/\/(?:wmt\.games|wmt\.digital|themw\.com\/wp-json)\/[^"'\s<>]+)/gi)].map((m) => m[1]))];
  return { matched: null, content: null, jsonMatches, wmtUrls };
}

async function probeConference(slug, cfg) {
  const out = {
    slug,
    url: cfg.url,
    type: cfg.type,
    status: null,
    htmlLength: 0,
    error: null,
  };
  try {
    const r = await fetch(cfg.url, { headers: HEADERS, cache: 'no-store', redirect: 'follow' });
    out.status = r.status;
    if (!r.ok) return out;
    const html = await r.text();
    out.htmlLength = html.length;

    if (cfg.type === 'sidearm-tables') {
      out.tables = parseSidearmTables(html);
      out.totalTables = (html.match(/<table\b/gi) || []).length;
      // Also grab the main nav / heading text so we can understand layout.
      const mainHeading = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
      out.mainHeading = mainHeading ? stripTags(mainHeading) : null;
    } else if (cfg.type === 'boost-nextdata') {
      out.boost = parseBoostNextData(html);
    } else if (cfg.type === 'wp-statsdata-script') {
      out.wp = parseWpStatsData(html);
    }
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
