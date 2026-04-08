const WEB = 'https://site.web.api.espn.com/apis/site/v2/sports/baseball/college-softball';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const event = searchParams.get('event');
  if (!event) return Response.json({ error: 'missing event' }, { status: 400 });
  try {
    const r = await fetch(`${WEB}/summary?event=${event}`, { next: { revalidate: 30 } });
    if (!r.ok) return Response.json({ error: `ESPN ${r.status}` }, { status: 502 });
    return Response.json(await r.json());
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
