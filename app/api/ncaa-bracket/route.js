import { getNcaaBracket, buildWinnersAndMatchups } from '../_ncaa.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Exposes the NCAA bracket's per-regional winners and SR pairings, derived
// from the shared NCAA GraphQL fetch in ../_ncaa.js. The front-end overlays
// `winners` onto each regional pod's Super Regional card so the advancing
// team shows by name and logo without any score inference.

export async function GET() {
  try {
    const champ = await getNcaaBracket();
    const { winners, pairings, regionals, srMatchups } = buildWinnersAndMatchups(champ);
    return Response.json(
      {
        title:     champ.title,
        year:      champ.year,
        fetchedAt: new Date().toISOString(),
        winners,
        pairings,
        regionals,
        srMatchups,
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
      },
    );
  } catch (e) {
    return Response.json(
      { error: e.message, winners: {}, pairings: [], regionals: {}, srMatchups: [] },
      { status: 500 },
    );
  }
}
