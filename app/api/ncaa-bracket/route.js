export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Scrapes the NCAA D1 Softball bracket page to determine the canonical
// Super Regional pairings (which two regional sites' winners meet in each
// SR series). Returns an ordered list of [hostA, hostB] city pairs.
//
// The bracket is structured by seed line on NCAA.com — the rendered page
// lists regionals in bracket order, so adjacent regional mentions form a
// Super Regional matchup. We also try to pick up explicit "X vs Y" labels
// in the Super Regional column when present.

const PAGE_URLS = [
  'https://www.ncaa.com/brackets/softball/d1',
];
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

let cache = null;
const TTL_MS = 60 * 60 * 1000; // 1 hour

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

// Reject obvious non-host words that can precede "Regional" on the page
// (e.g. "Super Regional", "NCAA Regional", section headings).
const HOST_BLOCKLIST = new Set([
  'super',
  'ncaa',
  'the',
  'a',
  'no',
  'all',
  'each',
  'one',
  'this',
  'host',
  'regional',
]);

function isPlausibleHost(name) {
  const t = name.trim();
  if (t.length < 3 || t.length > 40) return false;
  if (HOST_BLOCKLIST.has(t.toLowerCase())) return false;
  // Must start with an uppercase letter.
  if (!/^[A-Z]/.test(t)) return false;
  return true;
}

// Pull "{City} Regional" occurrences from the HTML body in document order
// and dedupe while preserving order. NCAA bracket pages render regionals
// in bracket order, so adjacent entries form Super Regional matchups.
function extractHostsInOrder(html) {
  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  const hosts = [];
  // Capture 1–3 word host names (e.g. "Athens", "Baton Rouge", "College Station").
  const re = /\b([A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*){0,2})\s+Regional\b/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const host = decodeEntities(m[1]).trim();
    if (isPlausibleHost(host)) hosts.push(host);
  }

  const seen = new Set();
  return hosts.filter((h) => {
    const key = h.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Heuristic: pair adjacent hosts in bracket-document order.
// The NCAA bracket page renders 16 regionals in 8 SR pairs, so consecutive
// pairs of host mentions should correspond to one SR matchup each.
function pairAdjacent(hosts) {
  const out = [];
  for (let i = 0; i + 1 < hosts.length; i += 2) {
    out.push([hosts[i], hosts[i + 1]]);
  }
  return out;
}

async function fetchBracket() {
  const year = new Date().getUTCFullYear();
  const tried = [];
  for (const base of PAGE_URLS) {
    for (const url of [`${base}/${year}`, base]) {
      tried.push(url);
      try {
        const html = await fetchText(url);
        const hosts = extractHostsInOrder(html);
        const pairings = pairAdjacent(hosts);
        if (pairings.length >= 4) {
          return {
            pairings,
            hosts,
            year,
            source: url,
            fetchedAt: new Date().toISOString(),
          };
        }
      } catch {
        // try the next URL
      }
    }
  }
  return {
    pairings: [],
    hosts: [],
    year,
    source: null,
    tried,
    fetchedAt: new Date().toISOString(),
  };
}

async function getBracket() {
  if (cache && Date.now() - cache.t < TTL_MS) return cache.data;
  const data = await fetchBracket();
  cache = { t: Date.now(), data };
  return data;
}

export async function GET() {
  try {
    const data = await getBracket();
    return Response.json(data, {
      headers: {
        'Cache-Control':
          'public, s-maxage=3600, stale-while-revalidate=7200',
      },
    });
  } catch (e) {
    return Response.json(
      { pairings: [], hosts: [], error: e.message },
      { status: 500 },
    );
  }
}
