// Resolve an NCAA player name + team to an ESPN athlete headshot URL.
//
//   GET /api/player-photo?name=Aubrey+Leach&team=Tennessee
//     -> { matched: true, photoUrl, athleteId, athleteName, ... } on success
//     -> { matched: false, reason, teamLogo? }                   on miss
//
//   GET /api/player-photo?name=...&team=...&debug=1
//     -> returns the full lookup trace (team resolved, roster size, match
//        score, raw athlete payload) so we can see why a lookup isn't
//        producing a photo.

import {
  normalize,
  splitName,
  scoreMatch,
  getTeamDirectory,
  findTeam,
  getRoster,
  findAthlete,
  extractAthletePhoto,
  extractTeamLogo,
} from '../_espn.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PHOTO_TTL_MS = 30 * 60 * 1000;
const photoCache = new Map();

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  const team = searchParams.get('team');
  const debug = searchParams.get('debug');

  if (!name) return Response.json({ error: 'name required' }, { status: 400 });
  if (!team) return Response.json({ error: 'team required' }, { status: 400 });

  const cacheKey = `${normalize(name)}|${normalize(team)}`;
  if (!debug) {
    const cached = photoCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < PHOTO_TTL_MS) {
      return Response.json(cached.result, {
        headers: { 'Cache-Control': 'public, max-age=1800, s-maxage=1800' },
      });
    }
  }

  const respond = (result, status = 200) => {
    if (!debug) {
      photoCache.set(cacheKey, { fetchedAt: Date.now(), result });
    }
    return Response.json(result, {
      status,
      headers: { 'Cache-Control': debug ? 'no-store' : 'public, max-age=1800, s-maxage=1800' },
    });
  };

  try {
    const dir = await getTeamDirectory();

    const espnTeam = findTeam(dir, team);
    if (!espnTeam) {
      return respond({
        matched: false,
        reason: 'team not found in ESPN directory',
        ...(debug && { debug: { teamQuery: team, normalized: normalize(team), dirSize: dir.teams.length } }),
      });
    }

    let rosterEntry;
    try {
      rosterEntry = await getRoster(espnTeam.id);
    } catch (e) {
      return respond({
        matched: false,
        reason: `roster fetch failed: ${e.message}`,
        teamId: espnTeam.id,
        teamLogo: extractTeamLogo(espnTeam),
      });
    }
    const athletes = rosterEntry.athletes;

    const match = findAthlete(athletes, name);
    if (!match) {
      return respond({
        matched: false,
        reason: 'athlete not found in roster',
        teamId: espnTeam.id,
        teamLogo: extractTeamLogo(espnTeam),
        ...(debug && {
          debug: {
            nameQuery: name,
            nameParts: splitName(name),
            rosterSize: athletes.length,
            rosterSample: athletes.slice(0, 5).map((a) => ({
              id: a.id,
              displayName: a.displayName,
              firstName: a.firstName,
              lastName: a.lastName,
              hasHeadshot: !!a.headshot?.href,
            })),
          },
        }),
      });
    }

    const { athlete, score } = match;
    const photoUrl = extractAthletePhoto(athlete);

    return respond({
      matched: true,
      photoUrl, // null if ESPN doesn't publish a headshot; client falls back to logo
      athleteId: athlete.id,
      athleteName: athlete.displayName || `${athlete.firstName || ''} ${athlete.lastName || ''}`.trim(),
      position: athlete.position?.abbreviation || athlete.position?.displayName || null,
      jersey: athlete.jersey || null,
      classYear: athlete.experience?.displayValue || null,
      teamId: espnTeam.id,
      teamLogo: extractTeamLogo(espnTeam),
      matchScore: score,
      ...(debug && {
        debug: {
          matchedAthlete: {
            id: athlete.id,
            displayName: athlete.displayName,
            firstName: athlete.firstName,
            lastName: athlete.lastName,
            headshotHref: athlete.headshot?.href || null,
            rawAthleteKeys: Object.keys(athlete),
          },
          rosterSize: athletes.length,
          rosterHeadshotCount: athletes.filter((a) => a.headshot?.href).length,
        },
      }),
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
