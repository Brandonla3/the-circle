export const revalidate = 3600;
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball';

export async function GET() {
  try {
    const r = await fetch(`${BASE}/rankings`, { next: { revalidate: 3600 } });
    if (!r.ok) return Response.json({ error: `ESPN ${r.status}` }, { status: 502 });
    return Response.json(await r.json());
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
