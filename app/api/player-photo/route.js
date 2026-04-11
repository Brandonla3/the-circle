// Resolve a player name + team to a roster photo URL from the school's
// Sidearm Sports API. No ESPN fallback — if Sidearm doesn't have it, the
// response says so explicitly so the caller can show a clear placeholder.
//
//   GET /api/player-photo?name=Alyssa+Hastings&team=Tennessee
//     -> { matched: true, photoUrl, playerName, position, jersey, ... }
//     -> { matched: false, reason }

import { getTeamDirectory, findTeam } from '../_espn.js';
import { getSidearmOrigin } from '../_sidearm-roster-map.js';
import { buildSidearmRosterIndex } from '../_sidearm-roster.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PHOTO_TTL_MS = 30 * 60 * 1000;
const photoCache = new Map();

// Normalize a name string for fuzzy matching.
function norm(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Score a Sidearm player against a query name. Returns 0 when no match.
// Higher is better.
function scoreName(player, query) {
  const qn = norm(query);
  const pn = norm(player.name);

  if (pn === qn) return 100;                         // exact full name

  // "Lastname, Firstname" → try reversed
  const reversed = qn.includes(',')
    ? qn.split(',').map((s) => s.trim()).reverse().join(' ')
    : null;
  if (reversed && norm(player.name) === norm(reversed)) return 95;

  // First + last both present
  const qParts = qn.split(/\s+/);
  const first = qParts[0];
  const last  = qParts[qParts.length - 1];
  const pFirst = norm(player.firstName);
  const pLast  = norm(player.lastName);

  if (pFirst === first && pLast === last) return 90;
  if (pLast === last && pFirst.startsWith(first[0])) return 60;  // initial match
  if (pLast === last) return 40;                                  // last-name only

  return 0;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  const team = searchParams.get('team');

  if (!name) return Response.json({ error: 'name required' }, { status: 400 });
  if (!team) return Response.json({ error: 'team required' }, { status: 400 });

  const cacheKey = `${norm(name)}|${norm(team)}`;
  const cached = photoCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PHOTO_TTL_MS) {
    return Response.json(cached.result, {
      headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' },
    });
  }

  const respond = (result, status = 200) => {
    photoCache.set(cacheKey, { fetchedAt: Date.now(), result });
    return Response.json(result, {
      status,
      headers: { 'Cache-Control': 'public, max-age=1800, s-maxage=1800' },
    });
  };

  try {
    // Resolve team name variants for Sidearm origin lookup.
    const dir = await getTeamDirectory();
    const espnTeam = findTeam(dir, team);
    const nameVariantSet = espnTeam
      ? new Set([espnTeam.displayName, espnTeam.name, espnTeam.shortDisplayName, espnTeam.location, espnTeam.nickname].filter(Boolean))
      : new Set([team]);

    const origin = getSidearmOrigin(nameVariantSet);
    if (!origin) {
      return respond({
        matched: false,
        reason: `${team} is not in the Sidearm directory — no photo source available`,
      });
    }

    const rosterIndex = await buildSidearmRosterIndex(origin);
    if (!rosterIndex) {
      return respond({
        matched: false,
        reason: `Sidearm roster fetch failed for ${team} (${origin})`,
      });
    }

    // Try exact map lookup first, then scored scan.
    let best = rosterIndex.map.get(norm(name)) || null;
    let bestScore = best ? 100 : 0;

    if (!best) {
      for (const player of rosterIndex.players) {
        const score = scoreName(player, name);
        if (score > bestScore) { bestScore = score; best = player; }
      }
    }

    // Require at least a last-name match (score ≥ 40) to avoid false positives.
    if (!best || bestScore < 40) {
      return respond({
        matched: false,
        reason: `No Sidearm roster match for "${name}" on ${team}`,
      });
    }

    if (!best.photoUrl) {
      return respond({
        matched: false,
        reason: `${best.name} found in Sidearm roster but has no photo`,
      });
    }

    return respond({
      matched: true,
      photoUrl: best.photoUrl,
      playerName: best.name,
      position: best.position || null,
      jersey: best.jerseyNumber || null,
      classYear: best.academicYear || null,
      matchScore: bestScore,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
