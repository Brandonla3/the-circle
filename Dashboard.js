export const revalidate = 15;
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || '';
  const url = `${BASE}/scoreboard?dates=${date}&groups=100&limit=200`;
  try {
    const r = await fetch(url, { next: { revalidate: 15 } });
    if (!r.ok) return Response.json({ error: `ESPN ${r.status}` }, { status: 502 });
    const data = await r.json();
    return Response.json(data, { headers: { 'Cache-Control': 's-maxage=15, stale-while-revalidate=30' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
