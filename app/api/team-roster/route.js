// Return a team's full roster from the school's Sidearm Sports API.
//
// No ESPN fallback. If the school isn't in the Sidearm directory, the
// response is explicit about it so the caller can surface the gap clearly.
//
//   GET /api/team-roster?teamId=2633
//   GET /api/team-roster?team=Tennessee
//
// Response:
//   {
//     team: { id, name, displayName, abbreviation, color, logo, ... },
//     athletes: [{ name, position, jersey, classYear, photoUrl, hometown, ... }],
//     meta: { source: 'sidearm', available: true|false, rosterSize, note? }
//   }

import { getTeamDirectory, findTeam, findTeamById } from '../_espn.js';
import { getSidearmOrigin } from '../_sidearm-roster-map.js';
import { buildSidearmRosterIndex } from '../_sidearm-roster.js';
import { getStaticRoster } from '../_static-rosters.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function mapTeamMeta(t) {
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
    logo: t.logos?.[0]?.href || null,
  };
}

function mapSidearmPlayer(p) {
  return {
    id: p.name?.toLowerCase().replace(/\s+/g, '-') || null,
    name: p.name,
    firstName: p.firstName || null,
    lastName: p.lastName || null,
    position: p.position || null,
    jersey: p.jerseyNumber || null,
    classYear: p.academicYear || null,
    heightDisplay: p.heightDisplay || null,
    weight: p.weight || null,
    hometown: p.hometown || null,
    highSchool: p.highSchool || null,
    previousSchool: p.previousSchool || null,
    batThrows: p.batThrows || null,
    photoUrl: p.photoUrl || null,
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
    // Resolve team name variants from the ESPN team directory.
    // ESPN is used only for ID↔name resolution — the scoreboard sends ESPN
    // team IDs and we need the name to look up the Sidearm origin.
    const dir = await getTeamDirectory();
    const espnTeam = teamIdQ ? findTeamById(dir, teamIdQ) : findTeam(dir, teamNameQ);
    if (!espnTeam) {
      return Response.json(
        { error: 'team not found', query: { teamId: teamIdQ, team: teamNameQ } },
        { status: 404 }
      );
    }

    const nameVariantSet = new Set(
      [espnTeam.displayName, espnTeam.name, espnTeam.shortDisplayName, espnTeam.location, espnTeam.nickname]
        .filter(Boolean)
    );

    const origin = getSidearmOrigin(nameVariantSet);

    // No Sidearm API? Try the manually-compiled static roster (LSU, South Carolina, Kentucky).
    if (!origin) {
      const staticRoster = getStaticRoster(nameVariantSet);
      if (staticRoster) {
        const athletes = staticRoster.players.map(mapSidearmPlayer);
        return Response.json(
          {
            team: mapTeamMeta(espnTeam),
            athletes,
            meta: {
              source: 'static',
              available: true,
              rosterSize: athletes.length,
              note: 'Roster compiled from official school site — not live Sidearm API.',
            },
          },
          { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' } }
        );
      }
      return Response.json({
        team: mapTeamMeta(espnTeam),
        athletes: [],
        meta: {
          source: 'static',
          available: false,
          note: `${espnTeam.displayName} is not in the Sidearm directory and has no static roster — roster unavailable`,
        },
      });
    }

    const rosterIndex = await buildSidearmRosterIndex(origin);
    if (!rosterIndex || rosterIndex.players.length === 0) {
      return Response.json({
        team: mapTeamMeta(espnTeam),
        athletes: [],
        meta: {
          source: 'sidearm',
          available: false,
          note: `Sidearm roster fetch returned no players for ${espnTeam.displayName} (${origin})`,
        },
      });
    }

    const athletes = rosterIndex.players.map(mapSidearmPlayer);

    return Response.json(
      {
        team: mapTeamMeta(espnTeam),
        athletes,
        meta: {
          source: 'sidearm',
          available: true,
          rosterSize: athletes.length,
          origin,
        },
      },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
