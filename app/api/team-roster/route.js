// Return a D1 softball team's full ESPN roster so the client can render
// it inline in the Teams tab instead of linking out to espn.com.
//
//   GET /api/team-roster?teamId=2633           -> by ESPN team id
//   GET /api/team-roster?team=Tennessee        -> by name (resolved via directory)
//
// Response:
//   {
//     team: { id, name, displayName, logo, color, abbreviation, location, nickname },
//     athletes: [
//       { id, name, firstName, lastName, position, jersey, classYear,
//         heightIn, weight, birthPlace, photoUrl }
//     ]
//   }
//
// Both path modes hit the same underlying ESPN roster endpoint and share
// the module-scope cache via _espn.js.

import {
  getTeamDirectory,
  findTeam,
  findTeamById,
  getRoster,
  extractAthletePhoto,
  extractTeamLogo,
} from '../_espn.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function mapAthlete(a) {
  return {
    id: a.id,
    name: a.displayName || `${a.firstName || ''} ${a.lastName || ''}`.trim(),
    firstName: a.firstName || null,
    lastName: a.lastName || null,
    position: a.position?.abbreviation || a.position?.displayName || null,
    positionName: a.position?.displayName || null,
    jersey: a.jersey || null,
    classYear: a.experience?.displayValue || null,
    heightIn: a.height || null,
    heightDisplay: a.displayHeight || null,
    weight: a.weight || null,
    weightDisplay: a.displayWeight || null,
    birthPlace: a.birthPlace?.city
      ? `${a.birthPlace.city}${a.birthPlace.state ? ', ' + a.birthPlace.state : ''}`
      : null,
    bats: a.bats?.abbreviation || a.bats?.displayValue || null,
    throws: a.throws?.abbreviation || a.throws?.displayValue || null,
    photoUrl: extractAthletePhoto(a),
  };
}

function mapTeam(t) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name || null,
    displayName: t.displayName || null,
    shortDisplayName: t.shortDisplayName || null,
    abbreviation: t.abbreviation || null,
    location: t.location || null,
    nickname: t.nickname || null,
    color: t.color ? `#${t.color}` : null,
    alternateColor: t.alternateColor ? `#${t.alternateColor}` : null,
    logo: extractTeamLogo(t),
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const teamIdQ = searchParams.get('teamId');
  const teamNameQ = searchParams.get('team');

  if (!teamIdQ && !teamNameQ) {
    return Response.json({ error: 'teamId or team required' }, { status: 400 });
  }

  try {
    const dir = await getTeamDirectory();
    let espnTeam = null;
    if (teamIdQ) {
      espnTeam = findTeamById(dir, teamIdQ);
    } else {
      espnTeam = findTeam(dir, teamNameQ);
    }
    if (!espnTeam) {
      return Response.json(
        { error: 'team not found', query: { teamId: teamIdQ, team: teamNameQ } },
        { status: 404 }
      );
    }

    const rosterEntry = await getRoster(espnTeam.id);
    const athletes = (rosterEntry.athletes || []).map(mapAthlete);

    // ESPN sometimes enriches team info on the roster payload (records,
    // venue, etc.) so prefer the roster's team metadata if it's richer.
    const teamMetaBase = rosterEntry.teamMeta || espnTeam;

    return Response.json(
      {
        team: mapTeam({ ...espnTeam, ...teamMetaBase }),
        athletes,
        meta: {
          source: 'espn',
          rosterSize: athletes.length,
          fetchedAt: new Date(rosterEntry.fetchedAt).toISOString(),
        },
      },
      { headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
