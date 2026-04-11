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

  // Targeted dumps of the pageProps keys most likely to contain stats.
  // The earlier generic regex-walk missed these because "data",
  // "metricSections", "qualifiers", and "schools" don't match the
  // stats/batting/pitching pattern.
  const pp = parsed?.props?.pageProps || {};
  const dumpKey = (k) => {
    const v = pp[k];
    if (v === undefined) return { present: false };
    return {
      present: true,
      type: Array.isArray(v) ? `array[${v.length}]` : typeof v,
      preview: JSON.stringify(v).slice(0, 10000),
    };
  };

  const pagePropsKeys = Object.keys(pp);
  const topKeys = Object.keys(parsed);
  const buildId = parsed.buildId || null;
  const runtimeConfig = parsed.runtimeConfig || pp.runtimeConfig || null;

  return {
    topKeys,
    pagePropsKeys,
    buildId,
    runtimeConfig,
    pagePropDumps: {
      data: dumpKey('data'),
      metricSections: dumpKey('metricSections'),
      qualifiers: dumpKey('qualifiers'),
      schools: dumpKey('schools'),
      teams: dumpKey('teams'),
    },
  };
}

function parseWpStatsData(html) {
  // Inline script tag patterns we've seen on WordPress/WMT sites.
  const patterns = [
    /<script[^>]*id=["']stats-data["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]*class=["'][^"']*stats-data[^"']*["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.statsData\s*=\s*(\{[\s\S]+?\});/,
    /var\s+statsData\s*=\s*(\{[\s\S]+?\});/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return { matched: p.source, content: m[1].slice(0, 20000) };
  }
  // Also surface any URLs on the page that look like they could point
  // at a stats data source (wmt.games, wmt.digital, themw.com/wp-json).
  const wmtUrls = [...new Set(
    [...html.matchAll(/(https?:\/\/(?:wmt\.games|wmt\.digital|themw\.com\/wp-json)\/[^"'\s<>]+)/gi)]
      .map((m) => m[1])
  )];
  return { matched: null, content: null, wmtUrls };
}

// Probe a set of candidate URLs directly. Each one is fetched with our
// standard headers and returns a short descriptor (status + first few
// KB of body). Used by the MW probe to figure out where the actual
// stats data lives (wmt.games direct, wp-json endpoint, etc).
async function probeCandidates(candidates) {
  const out = [];
  for (const { label, url } of candidates) {
    const row = { label, url, status: null, contentType: null, bodySnippet: null, bodyLength: 0, error: null };
    try {
      const r = await fetch(url, { headers: HEADERS, cache: 'no-store', redirect: 'follow' });
      row.status = r.status;
      row.contentType = r.headers.get('content-type') || null;
      if (r.ok) {
        const text = await r.text();
        row.bodyLength = text.length;
        row.bodySnippet = text.slice(0, 3000);
      }
    } catch (e) {
      row.status = 'error';
      row.error = String(e.message || e);
    }
    out.push(row);
  }
  return out;
}

// Fetch the Next.js JS chunks referenced by a page and grep for
// strings that look like API endpoint URLs. The Big Ten stats page
// loads its data client-side, so the fetch URL MUST be embedded
// somewhere in one of the static chunks.
async function grepBundlesForApiUrls(pageHtml, pageOrigin, buildId) {
  // Try several extraction strategies. Next.js ships chunks via
  // <script src>, <link rel="preload">, <link rel="modulepreload">,
  // and in a self.__next_f push runtime loader — we try all of them.
  const fromScriptSrc = [...pageHtml.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']*_next\/[^"']*\.js)["']/gi)].map((m) => m[1]);
  const fromPreload   = [...pageHtml.matchAll(/<link[^>]*\bhref\s*=\s*["']([^"']*_next\/[^"']*\.js)["']/gi)].map((m) => m[1]);
  const fromBareRef   = [...pageHtml.matchAll(/["'`]([^"'`\s]*_next\/static\/[^"'`\s]+\.js)["'`]/gi)].map((m) => m[1]);
  let scriptSrcs = [...new Set([...fromScriptSrc, ...fromPreload, ...fromBareRef])];

  // Fallback: if we found nothing, fetch the known _buildManifest.js
  // at the buildId path and parse its chunk list. Next.js always
  // ships this file at a predictable location.
  const manifestCandidates = [];
  // Route→chunks map pulled from the manifest, if available.
  let manifestRoutes = null;
  if (scriptSrcs.length === 0 && buildId) {
    const manifestUrl = `${pageOrigin}/_next/static/${buildId}/_buildManifest.js`;
    try {
      const r = await fetch(manifestUrl, { headers: HEADERS, cache: 'no-store' });
      if (r.ok) {
        const manifestJs = await r.text();
        manifestCandidates.push({ url: manifestUrl, size: manifestJs.length, snippet: manifestJs.slice(0, 9000) });
        // Extract any .js filenames mentioned in the manifest.
        const chunkPaths = [...new Set(
          [...manifestJs.matchAll(/["']([^"']*\.js)["']/g)].map((m) => m[1])
        )];
        // Resolve relative → absolute chunk paths. The manifest chunks
        // are already like "static/chunks/pages/foo.js" — prefix with
        // /_next/ to get /_next/static/chunks/pages/foo.js.
        scriptSrcs = chunkPaths.map((p) => {
          if (p.startsWith('http')) return p;
          if (p.startsWith('/')) return p;
          return `/_next/${p}`;
        });
        // Also try to pull the route→chunks map directly so we can
        // target the stats page's chunk specifically. Find any "/…/stats"
        // key in the manifest.
        const routeMatches = [...manifestJs.matchAll(/"(\/[^"]*stat[^"]*)"\s*:\s*\[([^\]]+)\]/gi)];
        manifestRoutes = routeMatches.map((m) => ({
          route: m[1],
          chunks: [...m[2].matchAll(/"([^"]+\.js)"/g)].map((x) => x[1]),
        }));
      }
    } catch {
      /* ignore */
    }
  }

  // Prioritize chunks whose filenames hint at stats / sb / pages.
  // Route-matched chunks from the manifest win over pattern-matched.
  const routeChunkSet = new Set(
    (manifestRoutes || []).flatMap((r) => r.chunks.map((c) => `/_next/${c}`))
  );
  const prioritized = scriptSrcs
    .map((s) => ({
      src: s,
      score: routeChunkSet.has(s) ? 3 :
             /stats|sport|softball/.test(s) ? 2 :
             /pages?|app|layout|common/.test(s) ? 1 : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((x) => x.src);

  const results = [];
  for (const relSrc of prioritized) {
    const url = relSrc.startsWith('http') ? relSrc : `${pageOrigin}${relSrc}`;
    try {
      const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
      if (!r.ok) {
        results.push({ url, status: r.status, hits: [] });
        continue;
      }
      const text = await r.text();
      // Extract anything that looks like an API endpoint path or URL.
      const hits = [...new Set([
        ...(text.match(/["'`](\/api\/v[0-9]\/[\w/.?=&%-]+)["'`]/g) || []).map((h) => h.slice(1, -1)),
        ...(text.match(/["'`](https?:\/\/[^"'`]*boostsport\.ai[^"'`]*)["'`]/g) || []).map((h) => h.slice(1, -1)),
        ...(text.match(/["'`](\/stats[\w/.?=&%-]*)["'`]/g) || []).map((h) => h.slice(1, -1)),
        ...(text.match(/["'`](cume-stats[\w/.?=&%-]*)["'`]/g) || []).map((h) => h.slice(1, -1)),
        ...(text.match(/["'`](sport-stats[\w/.?=&%-]*)["'`]/g) || []).map((h) => h.slice(1, -1)),
        ...(text.match(/["'`](\/[\w-]*-stats[\w/.?=&%-]*)["'`]/g) || []).map((h) => h.slice(1, -1)),
      ])].slice(0, 60);
      results.push({ url, status: 200, size: text.length, hits });
    } catch (e) {
      results.push({ url, status: 'error', error: String(e.message || e), hits: [] });
    }
  }
  return {
    scriptSrcsFound: scriptSrcs.length,
    fromScriptSrcCount: fromScriptSrc.length,
    fromPreloadCount: fromPreload.length,
    fromBareRefCount: fromBareRef.length,
    manifestCandidates,
    manifestRoutes,
    probed: results,
  };
}

// The ncaa_season_id is NCAA-wide so we can reuse one discovery for all
// WMT conferences. Secsports.com's Inertia blob ships the id inline.
async function discoverNcaaSeasonId() {
  try {
    const r = await fetch('https://www.secsports.com/sport/softball/stats', {
      headers: HEADERS,
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/data-page="([^"]+)"/);
    if (!m) return null;
    const decoded = m[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&#039;/g, "'").replace(/&#39;/g, "'");
    const page = JSON.parse(decoded);
    const seasons = page?.props?.sport?.sport_ncaa_seasons || [];
    const current = seasons.find((s) => s.default)
      || [...seasons].sort((a, b) => (b.ncaa_season_id || 0) - (a.ncaa_season_id || 0))[0];
    return current?.ncaa_season_id || null;
  } catch {
    return null;
  }
}

async function probeConference(slug, cfg, seasonId) {
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
      const mainHeading = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
      out.mainHeading = mainHeading ? stripTags(mainHeading) : null;
    } else if (cfg.type === 'boost-nextdata') {
      out.boost = parseBoostNextData(html);
      // Fetch and grep the Next.js JS bundles for the stats API URL.
      // Since the stats data isn't in __NEXT_DATA__, it must be
      // embedded in the client-side React code as a fetch string.
      const origin = new URL(cfg.url).origin;
      out.bundleGrep = await grepBundlesForApiUrls(html, origin, out.boost?.buildId);
      // Big Ten's stats come from its Boost Sport AI backend, not from
      // the Next.js hydration blob. The __NEXT_DATA__ confirmed the
      // BACKEND_HOST_URL is https://b1gbeprod.boostsport.ai. Probe a
      // list of common Boost API paths to find where the actual stats
      // data lives.
      const sid = seasonId || 17020;
      const big10Candidates = [
        // Try common Boost stats paths at the prod backend host.
        { label: 'b1gbeprod stats (root)',                    url: 'https://b1gbeprod.boostsport.ai/api/v1/stats' },
        { label: 'b1gbeprod stats by conf+sport+season',      url: `https://b1gbeprod.boostsport.ai/api/v1/stats?conference_alias=b1g&sport=sb&season=2026` },
        { label: 'b1gbeprod stats conf b1g sport sb',         url: `https://b1gbeprod.boostsport.ai/api/v1/stats/b1g/sb/2026` },
        { label: 'b1gbeprod sport-stats b1g sb',              url: `https://b1gbeprod.boostsport.ai/api/v1/sport-stats/b1g/sb/2026` },
        { label: 'b1gbeprod conference-stats b1g sb',         url: `https://b1gbeprod.boostsport.ai/api/v1/conference-stats/b1g/sb/2026` },
        { label: 'b1gbeprod team-stats b1g sb',               url: `https://b1gbeprod.boostsport.ai/api/v1/team-stats?conference_alias=b1g&sport_alias=sb&season=2026` },
        { label: 'b1gbeprod player-stats b1g sb',             url: `https://b1gbeprod.boostsport.ai/api/v1/player-stats?conference_alias=b1g&sport_alias=sb&season=2026` },
        { label: 'b1gbeprod cume-stats b1g sb',               url: `https://b1gbeprod.boostsport.ai/api/v1/cume-stats?conference_alias=b1g&sport_alias=sb&season=2026` },
        { label: 'b1gbeprod season-stats b1g sb',             url: `https://b1gbeprod.boostsport.ai/api/v1/season-stats?conference_alias=b1g&sport_alias=sb&season=2026` },
        // Alternate path shapes — REST-ish /sports/{alias}/stats style.
        { label: 'b1gbeprod sports sb stats',                 url: `https://b1gbeprod.boostsport.ai/api/v1/sports/sb/stats?season=2026` },
        { label: 'b1gbeprod sport sb conf b1g stats',         url: `https://b1gbeprod.boostsport.ai/api/v1/sport/sb/conference/b1g/stats?season=2026` },
        // Try the Next.js data route that SSR'd the page — Next ships
        // its getStaticProps / getServerSideProps blobs at _next/data.
        { label: 'bigten.org _next/data stats',               url: `https://bigten.org/_next/data/16IUQfy3_BdMXH8jkp5XJ/sb/stats.json` },
        { label: 'bigten.org _next/data stats with season',   url: `https://bigten.org/_next/data/16IUQfy3_BdMXH8jkp5XJ/sb/stats/2026.json` },
        // Also try hitting the cms.boostsport.ai delivery host.
        { label: 'cms.boostsport.ai stats b1g sb',            url: `https://cms.boostsport.ai/api/v1/stats?conference_alias=b1g&sport=sb&season=2026` },
      ];
      out.candidates = await probeCandidates(big10Candidates);
    } else if (cfg.type === 'wp-statsdata-script') {
      out.wp = parseWpStatsData(html);
      // MW stats aren't inline — they're loaded client-side. Probe a
      // short list of candidate endpoints to find the real source.
      // Every candidate is fetched with our server-side User-Agent so
      // Cloudflare doesn't block them the way it would a browser fetch
      // from this sandbox.
      const sid = seasonId || 17020;
      const mwCandidates = [
        { label: 'wmt.games sec (known-working reference)',            url: `https://wmt.games/conference/sec/${sid}` },
        { label: 'wmt.games mw',                                       url: `https://wmt.games/conference/mw/${sid}` },
        { label: 'wmt.games mountainwest',                             url: `https://wmt.games/conference/mountainwest/${sid}` },
        { label: 'wmt.games mwc',                                      url: `https://wmt.games/conference/mwc/${sid}` },
        { label: 'themw.com wp-json (root)',                           url: 'https://themw.com/wp-json/' },
        { label: 'themw.com wp-json v1 (existing schedule base)',      url: 'https://themw.com/wp-json/v1' },
        { label: 'themw.com wp-json v1 stats',                         url: 'https://themw.com/wp-json/v1/stats' },
        { label: 'themw.com wp-json v1 stats-events',                  url: 'https://themw.com/wp-json/v1/stats-events' },
        { label: 'themw.com wp-json v1 team-stats',                    url: 'https://themw.com/wp-json/v1/team-stats' },
        { label: 'themw.com wp-json v1 sport-stats',                   url: 'https://themw.com/wp-json/v1/sport-stats' },
        { label: 'themw.com wp-json v1 cume-stats',                    url: 'https://themw.com/wp-json/v1/cume-stats' },
        { label: 'themw.com wp-json v1 season-stats',                  url: 'https://themw.com/wp-json/v1/season-stats' },
        { label: 'themw.com wp-json v1 stat-data',                     url: 'https://themw.com/wp-json/v1/stat-data' },
        { label: 'themw.com wp-json v1 sport-statistics',              url: 'https://themw.com/wp-json/v1/sport-statistics' },
      ];
      out.candidates = await probeCandidates(mwCandidates);
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

  // Kick off the NCAA season id discovery in parallel with the probes —
  // only the MW branch uses it but it's cheap and serializable.
  const seasonIdPromise = discoverNcaaSeasonId();

  const results = {};
  for (const slug of toRun) {
    if (!CONFS[slug]) {
      results[slug] = { error: `unknown conf slug: ${slug}` };
      continue;
    }
    // Both MW and Big Ten probes now use the discovered seasonId.
    const seasonId = (slug === 'mw' || slug === 'big10') ? await seasonIdPromise : null;
    results[slug] = await probeConference(slug, CONFS[slug], seasonId);
  }
  results._meta = { seasonId: await seasonIdPromise };
  return Response.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
