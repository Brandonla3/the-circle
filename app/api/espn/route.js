export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ALLOWED_HOSTS = ['site.api.espn.com', 'site.web.api.espn.com'];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('url');
  let parsed;
  try { parsed = target ? new URL(target) : null; } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) {
    return new Response(JSON.stringify({ error: 'invalid url' }), { status: 400 });
  }
  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)' },
      cache: 'no-store',
    });
    const data = await r.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
