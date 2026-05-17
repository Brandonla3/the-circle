import { getNcaaBracket, ncaaToScheduleData } from '../_ncaa.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Tournament schedule for the front-end. Backed by NCAA's GraphQL bracket
// (see ../_ncaa.js) — one fetch returns every game's state, teams, scores,
// logos, venue, etc. Returns the legacy ESPN-shaped `{ rounds }` object the
// page already knows how to render.

let cache = null;
const CACHE_TTL_MS = 60 * 1000;

async function getSchedule() {
  if (cache && Date.now() - cache.t < CACHE_TTL_MS) return cache.data;
  const champ = await getNcaaBracket();
  const data  = ncaaToScheduleData(champ);
  cache = { t: Date.now(), data };
  return data;
}

export async function GET() {
  try {
    const data = await getSchedule();
    const hasLive = data.rounds.some((r) =>
      r.groups.some((g) =>
        g.games.some((ev) => ev.status?.type?.state === 'in'),
      ),
    );
    const maxAge = hasLive ? 30 : 60;
    return Response.json(data, {
      headers: {
        'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
      },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
