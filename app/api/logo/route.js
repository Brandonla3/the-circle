export const dynamic = 'force-dynamic';

// Server-side image proxy for NCAA team logos. Two callable shapes:
//
//   /api/logo?team=<seoname>
//       Tries each known NCAA path for the team's softball logo
//       (-wsb sport suffix, plain, .svg variants) and returns the first
//       one that succeeds. This is the resilient path — the team slug is
//       all the caller needs to know.
//
//   /api/logo?u=<full-url>
//       Backwards-compatible single-URL proxy.
//
//   /api/logo?team=<seoname>&diag=1
//       Returns JSON: { tried: [...], picked: 'url-or-null', referer }
//       so we can inspect exactly which URL pattern NCAA accepts without
//       needing browser devtools or a JSON paste-back.

const NCAA_BASE = 'https://www.ncaa.com/sites/default/files/images/logos/schools';

// A real-browser-looking request. NCAA's CDN refuses hotlinks via Referer.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'image/png,image/jpeg,image/svg+xml,image/webp,image/*,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer:           'https://www.ncaa.com/brackets/softball/d1/',
};

function candidatesForTeam(slug) {
  if (!slug) return [];
  const s = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!s) return [];
  const letter = s[0];
  // Order by what NCAA's GraphQL actually ships (Alabama uses the
  // sport-suffixed PNG), then by progressively more generic fallbacks.
  return [
    `${NCAA_BASE}/${letter}/${s}-wsb.70.png`,
    `${NCAA_BASE}/${letter}/${s}-wsb.png`,
    `${NCAA_BASE}/${letter}/${s}.svg`,
    `${NCAA_BASE}/${letter}/${s}.png`,
    `${NCAA_BASE}/${s}.svg`,
    `${NCAA_BASE}/${s}.png`,
  ];
}

async function attempt(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
    if (r.ok) return r;
    return { ok: false, status: r.status, url };
  } catch (e) {
    return { ok: false, status: 0, url, error: String(e?.message || e) };
  }
}

export async function GET(request) {
  const url  = new URL(request.url);
  const u    = url.searchParams.get('u');
  const team = url.searchParams.get('team');
  const diag = url.searchParams.has('diag');

  const candidates = [];
  if (u && /^https:\/\/(?:www\.)?ncaa\.com\//i.test(u)) candidates.push(u);
  if (team) candidates.push(...candidatesForTeam(team));
  if (!candidates.length) return new Response('no url or team', { status: 400 });

  const tried = [];
  for (const c of candidates) {
    const r = await attempt(c);
    if (r?.ok) {
      if (diag) {
        return Response.json({
          tried: [...tried, { url: c, status: r.status, ok: true }],
          picked: c,
          referer: HEADERS.Referer,
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const buf = await r.arrayBuffer();
      return new Response(buf, {
        headers: {
          'Content-Type':  r.headers.get('content-type') || 'image/png',
          'Cache-Control': 'public, max-age=86400, s-maxage=86400, immutable',
        },
      });
    }
    tried.push({ url: c, status: r.status, error: r.error });
  }

  if (diag) {
    return Response.json({ tried, picked: null, referer: HEADERS.Referer }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response('not found', { status: 404 });
}
