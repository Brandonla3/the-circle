export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Scrapes https://www.ncaa.com/brackets/softball/d1/<year> and pulls out:
//   - regional host cities, in bracket order
//   - the team advancing from each regional (the winner the front-end shows
//     in the Super Regional card)
//   - the Super Regional matchups (which two teams play each other)
//
// NCAA's bracket page is the source of truth — the previous ESPN-derived
// approach lagged real-time updates and surfaced eliminated teams. When this
// scrape succeeds the front-end uses these team names directly; on failure
// it falls back to the W-L tally over ESPN data.
//
// Hit `/api/ncaa-bracket?debug=1` to see exactly what was extracted (host
// list, raw matches, sample HTML lengths) so the parser can be tuned
// against real markup without redeploying.

const PAGE_URLS = ['https://www.ncaa.com/brackets/softball/d1'];
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

let cache = null;
const TTL_MS = 10 * 60 * 1000; // 10 minutes — short enough to follow live updates

async function fetchText(url) {
  const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

const HOST_BLOCKLIST = new Set([
  'super', 'ncaa', 'the', 'a', 'no', 'all', 'each', 'one',
  'this', 'host', 'regional', 'women', 'womens', 'men',
]);

function isPlausibleHost(name) {
  const t = name.trim();
  if (t.length < 3 || t.length > 40) return false;
  if (HOST_BLOCKLIST.has(t.toLowerCase())) return false;
  if (!/^[A-Z]/.test(t)) return false;
  return true;
}

// Strip script/style blocks and tags so we can grep for text content.
function stripToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

// "{City} Regional" mentions, in document order, deduped.
function extractHostsInOrder(html) {
  const body = stripToText(html);
  const re = /\b([A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*){0,2})\s+Regional\b/g;
  const hosts = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const host = decodeEntities(m[1]).trim();
    if (isPlausibleHost(host)) hosts.push(host);
  }
  const seen = new Set();
  return hosts.filter((h) => {
    const k = h.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Walk every <script type="application/json"> block and recursively look for
// objects that smell like a bracket node — anything with a team name plus a
// regional/host reference. Returns a list of { host, team, round } records.
function extractJsonRecords(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      walkJson(data, out, 0);
    } catch {
      // ignore unparseable blocks
    }
  }
  return out;
}

function walkJson(node, out, depth) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) {
    for (const v of node) walkJson(v, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  // Plausible bracket-node fingerprints. NCAA's Drupal bracket modules
  // historically use a mix of these shapes; we don't depend on any one.
  const teamName =
    node.teamName ||
    node.team_name ||
    node.team?.name ||
    node.team?.displayName ||
    node.winner?.name ||
    node.winner?.team ||
    null;
  const hostRef =
    node.regional ||
    node.regionalName ||
    node.regional_name ||
    node.host ||
    node.bracketHost ||
    node.parentRegional ||
    null;
  const round =
    node.round ||
    node.roundName ||
    node.bracketRound ||
    null;

  if (teamName && hostRef) {
    out.push({
      host: String(hostRef).replace(/\s+regional\b/i, '').trim(),
      team: String(teamName).trim(),
      round: round ? String(round) : null,
    });
  }

  for (const v of Object.values(node)) walkJson(v, out, depth + 1);
}

// Reduce extracted records to a per-host winner map, preferring records
// whose round names look like "Super Regional" / "Regional Final" (i.e. the
// team that advanced) over generic regional listings.
function recordsToWinners(records) {
  const winners = {};
  for (const r of records) {
    if (!r.host || !r.team) continue;
    const roundPriority =
      r.round && /super\s*regional|regional\s*final|champion/i.test(r.round) ? 2 :
      r.round && /regional/i.test(r.round) ? 1 : 0;
    const existing = winners[r.host];
    if (!existing || roundPriority > existing.priority) {
      winners[r.host] = { team: r.team, priority: roundPriority };
    }
  }
  const out = {};
  for (const [host, v] of Object.entries(winners)) out[host] = v.team;
  return out;
}

function pairAdjacent(items) {
  const out = [];
  for (let i = 0; i + 1 < items.length; i += 2) out.push([items[i], items[i + 1]]);
  return out;
}

async function fetchBracket(debug) {
  const year = new Date().getUTCFullYear();
  const diag = { tried: [], pageBytes: 0, jsonBlocks: 0, jsonRecords: 0 };
  for (const base of PAGE_URLS) {
    for (const url of [`${base}/${year}`, base]) {
      diag.tried.push(url);
      try {
        const html = await fetchText(url);
        diag.pageBytes = html.length;
        diag.jsonBlocks = (html.match(/<script[^>]*type=["']application\/json["']/gi) || []).length;

        const hosts = extractHostsInOrder(html);
        const pairings = pairAdjacent(hosts);
        const records = extractJsonRecords(html);
        diag.jsonRecords = records.length;
        const winners = recordsToWinners(records);

        if (hosts.length >= 4 || Object.keys(winners).length >= 1) {
          return {
            pairings,
            hosts,
            winners,
            year,
            source: url,
            fetchedAt: new Date().toISOString(),
            _diag: debug ? diag : undefined,
          };
        }
      } catch (e) {
        diag.lastError = String(e.message || e);
      }
    }
  }
  return {
    pairings: [],
    hosts: [],
    winners: {},
    year,
    source: null,
    fetchedAt: new Date().toISOString(),
    _diag: diag,
  };
}

async function getBracket(debug) {
  if (!debug && cache && Date.now() - cache.t < TTL_MS) return cache.data;
  const data = await fetchBracket(debug);
  if (!debug) cache = { t: Date.now(), data };
  return data;
}

export async function GET(request) {
  try {
    const debug = new URL(request.url).searchParams.has('debug');
    const data = await getBracket(debug);
    return Response.json(data, {
      headers: {
        'Cache-Control': debug
          ? 'no-store'
          : 'public, s-maxage=600, stale-while-revalidate=1200',
      },
    });
  } catch (e) {
    return Response.json(
      { pairings: [], hosts: [], winners: {}, error: e.message },
      { status: 500 },
    );
  }
}
