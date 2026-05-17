export const dynamic = 'force-dynamic';

// Proxies NCAA-hosted team logos so they render from our origin instead of
// being hotlinked. ncaa.com refuses image requests whose Referer isn't
// ncaa.com itself, which is why most logos disappeared after the switch to
// NCAA-only data. This route forwards the request with the right Referer
// and caches the bytes at the edge.
//
// Use: <img src={`/api/logo?u=${encodeURIComponent(ncaaLogoUrl)}`} />

const ALLOWED_HOST_RE = /^https:\/\/(?:www\.)?ncaa\.com\//i;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'image/png,image/jpeg,image/svg+xml,image/webp,image/*,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer:           'https://www.ncaa.com/brackets/softball/d1/',
};

export async function GET(request) {
  const url    = new URL(request.url);
  const target = url.searchParams.get('u');
  if (!target || !ALLOWED_HOST_RE.test(target)) {
    return new Response('bad url', { status: 400 });
  }
  try {
    const r = await fetch(target, { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) return new Response('upstream', { status: r.status });
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      headers: {
        'Content-Type':  r.headers.get('content-type') || 'image/png',
        // Logos rarely change — keep them in the edge for a day.
        'Cache-Control': 'public, max-age=86400, s-maxage=86400, immutable',
      },
    });
  } catch (e) {
    return new Response('error', { status: 500 });
  }
}
