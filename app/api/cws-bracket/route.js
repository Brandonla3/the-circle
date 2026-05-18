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

export async function GET(request) {
  try {
    // ?raw=1  -> the raw NCAA championship blob (lets us inspect team field
    //          names so logos / records / colors line up).
    // ?sample=1 -> just one team object so we can see exactly what NCAA
    //          provides for a single competitor.
    const url = new URL(request.url);
    if (url.searchParams.has('raw') || url.searchParams.has('sample')) {
      const { getNcaaBracket } = await import('../_ncaa.js');
      const champ = await getNcaaBracket();
      if (url.searchParams.has('sample')) {
        const games = champ?.games || [];
        // Collect a unique sample of teams across the first few games so we
        // can see exactly what fields NCAA ships per team.
        const seen = new Set();
        const teamSamples = [];
        for (const g of games) {
          for (const t of (g.teams || [])) {
            const name = t.nameFull || t.nameShort;
            if (!name || seen.has(name)) continue;
            seen.add(name);
            teamSamples.push(t);
            if (teamSamples.length >= 12) break;
          }
          if (teamSamples.length >= 12) break;
        }
        return Response.json(
          {
            teamSamples,
            sampleGame: games[0] || null,
            sectionsSample: champ?.sections?.slice(0, 3) || [],
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
      return Response.json(champ, { headers: { 'Cache-Control': 'no-store' } });
    }

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
