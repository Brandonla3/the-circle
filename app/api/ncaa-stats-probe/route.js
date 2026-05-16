// One-off probe for figuring out where D1 softball leaderboard data actually
// lives now that NCAA.com renders its stat tables client-side and stats.ncaa.org
// blocks Vercel IPs.
//
//   GET /api/ncaa-stats-probe?statId=271
//
// Tries: NCAA.com page + JSON endpoint patterns, drupalSettings extraction,
// ESPN softball leaders endpoint, Boost Sport API (per-conference). Returns
// status / counts / excerpts for each so we can see which one actually
// returns leaderboard rows from inside the Vercel runtime.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchHtml(url, accept = 'text/html') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: accept,
        Referer: 'https://www.ncaa.com/',
      },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    const text = await r.text();
    return { ok: r.ok, status: r.status, contentType: r.headers.get('content-type'), text };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

// Pull the drupalSettings JSON blob from an NCAA.com page. It's typically
// emitted as <script type="application/json" data-drupal-selector="drupal-settings-json">{...}</script>
function extractDrupalSettings(html) {
  const m = html.match(
    /<script[^>]*data-drupal-selector="drupal-settings-json"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (m) return m[1];
  // Older / inline form.
  const m2 = html.match(/drupalSettings\s*=\s*({[\s\S]*?});/);
  return m2 ? m2[1] : null;
}

// Look for any URL pattern in HTML that smells like a leaderboard JSON endpoint.
function findDataUrls(html) {
  const candidates = new Set();
  const patterns = [
    /https?:\/\/[^"\s]*?\/stats[^"\s]*\.json[^"\s]*/gi,
    /https?:\/\/[^"\s]*?\/leader[^"\s]*?\.json[^"\s]*/gi,
    /https?:\/\/data\.ncaa\.com\/[^"\s]+/gi,
    /https?:\/\/[^"\s]*?casablanca[^"\s]+/gi,
    /https?:\/\/www\.ncaa\.com\/services\/[^"\s]+/gi,
    /https?:\/\/[^"\s]*?\/json\/[^"\s]*?stats[^"\s]*/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      let u = m[0].replace(/[\\,)};"']+$/g, '');
      if (u.length < 250) candidates.add(u);
    }
  }
  return [...candidates].slice(0, 30);
}

async function probeNcaaPage(statId) {
  const url = `https://www.ncaa.com/stats/softball/d1/current/individual/${statId}`;
  const r = await fetchHtml(url);
  if (!r.ok) return { kind: 'ncaa-page', url, ...r };
  const ds = extractDrupalSettings(r.text);
  const dataUrls = findDataUrls(r.text);
  return {
    kind: 'ncaa-page',
    url,
    status: r.status,
    bytes: r.text.length,
    drupalSettingsLen: ds ? ds.length : 0,
    drupalSettingsHead: ds ? ds.slice(0, 1500) : null,
    dataUrls,
  };
}

// Common NCAA.com / Casablanca JSON URL patterns to try.
function candidateJsonUrls(statId) {
  return [
    `https://www.ncaa.com/casablanca/stats/softball/d1/current/individual/${statId}.json`,
    `https://www.ncaa.com/casablanca/stats/softball/d1/2026/individual/${statId}.json`,
    `https://www.ncaa.com/json/stats/softball/d1/current/individual/${statId}`,
    `https://www.ncaa.com/services/stats-leader/api/stats/softball/d1/current/individual/${statId}`,
    `https://data.ncaa.com/casablanca/stats/softball/d1/current/individual/${statId}.json`,
    `https://data.ncaa.com/casablanca/stats/softball/d1/2026/individual/${statId}.json`,
  ];
}

async function probeJsonCandidate(url) {
  const r = await fetchHtml(url, 'application/json');
  let parsed = null;
  let rowsLike = 0;
  if (r.ok && r.text) {
    try {
      const j = JSON.parse(r.text);
      const arr = j.data || j.players || j.results || j.rows || (Array.isArray(j) ? j : null);
      if (Array.isArray(arr)) rowsLike = arr.length;
      parsed = JSON.stringify(j).slice(0, 500);
    } catch {
      parsed = `(non-JSON, head: ${r.text.slice(0, 200)})`;
    }
  }
  return {
    kind: 'json-candidate',
    url,
    status: r.status,
    contentType: r.contentType,
    bytes: r.text ? r.text.length : 0,
    rowsLike,
    parsedHead: parsed,
    error: r.error,
  };
}

// ESPN national leaders. ESPN groups all college softball under
// /sports/baseball/college-softball, same as the scoreboard route.
function candidateEspnUrls() {
  return [
    'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball/leaders',
    'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball/statistics/leaders',
    'https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/leaders',
    'https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/seasons/2026/types/2/leaders',
  ];
}

// Boost Sport API — already used by the weekly cron for Big Ten. Worth probing
// without a conference param to see if it serves national, and also with
// `Big Ten` to verify the cron path still works from Vercel.
function candidateBoostUrls() {
  const base = 'https://engage-api.boostsport.ai/api/sport/sb/stats/table';
  const common =
    'seasons=2026&view=table&type=player&split=all&teams=all&section=batters&level=season&limit=50&orderBy=ba&order=desc';
  return [
    `${base}?${common}`,                                   // no conference
    `${base}?conference=Big%20Ten&${common}`,              // verified conf
    `${base}?conference=SEC&${common}`,
    `${base}?conference=All%20D1&${common}`,
    `${base}?conference=NCAA&${common}`,
  ];
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const statId = searchParams.get('statId') || '271';

  const ncaaPage = await probeNcaaPage(statId);

  // Run remaining probes in parallel — they're independent.
  const [jsonResults, espnResults, boostResults] = await Promise.all([
    Promise.all(candidateJsonUrls(statId).map(probeJsonCandidate)),
    Promise.all(candidateEspnUrls().map(probeJsonCandidate)),
    Promise.all(candidateBoostUrls().map(probeJsonCandidate)),
  ]);

  return new Response(
    JSON.stringify(
      {
        statId,
        ncaaPage,
        ncaaJsonCandidates: jsonResults,
        espnCandidates: espnResults,
        boostCandidates: boostResults,
      },
      null,
      2,
    ),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
