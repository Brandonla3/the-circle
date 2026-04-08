// Resolve an NCAA player name + team to an ESPN athlete headshot URL.
//
//   GET /api/player-photo?name=Aubrey+Leach&team=Tennessee
//     -> { matched: true, photoUrl, athleteId, athleteName, position,
//          jersey, teamId, teamLogo }
//     -> { matched: false, reason, teamLogo? }
//
// Strategy:
//   1. Look up the ESPN team from a cached team directory (ESPN /teams endpoint,
//      indexed by normalized display/short/nickname/location so "Tennessee",
//      "Tennessee Volunteers", and "Volunteers" all resolve to the same team).
//   2. Fetch that team's roster (ESPN /teams/{id}/roster), cached per team.
//   3. Score each athlete against the incoming player name and pick the best
//      match. Scoring is tiered so exact full-name matches always beat looser
//      first+last-only or last-name+initial matches.
//   4. Extract the headshot URL from the athlete's `headshot.href`, falling
//      back to the standard ESPN CDN path keyed by athlete id.
//
// All state is module-scoped per Vercel instance. Team directory and roster
// caches survive between requests on warm instances, so the typical profile
// lookup resolves entirely from memory after the first cold call.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json',
};

const TEAM_DIR_TTL_MS = 24 * 60 * 60 * 1000;  // 24h, teams basically never change
const ROSTER_TTL_MS = 60 * 60 * 1000;          // 1h, rosters rarely change mid-season
const PHOTO_TTL_MS = 30 * 60 * 1000;           // 30m cache per (name, team) lookup

let teamDirCache = null;           // { fetchedAt, byName: Map<string, team>, teams: [...] }
let teamDirPromise = null;
const rosterCache = new Map();     // teamId -> { fetchedAt, athletes }
const photoCache = new Map();      // cacheKey -> { fetchedAt, result }

function normalize(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitName(s) {
  // Strip common suffixes so "Jessica Smith Jr." matches "Jessica Smith".
  return normalize(s)
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .split(' ')
    .filter(Boolean);
}

async function getTeamDirectory() {
  if (teamDirCache && Date.now() - teamDirCache.fetchedAt < TEAM_DIR_TTL_MS) {
    return teamDirCache;
  }
  if (teamDirPromise) return teamDirPromise;

  teamDirPromise = (async () => {
    const r = await fetch(`${ESPN_SITE}/teams?limit=400`, { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) throw new Error(`ESPN /teams HTTP ${r.status}`);
    const data = await r.json();
    const wrappers = data.sports?.[0]?.leagues?.[0]?.teams || [];
    const teams = [];
    const byName = new Map();
    for (const w of wrappers) {
      const t = w.team;
      if (!t) continue;
      teams.push(t);
      // Index every plausible name variant so different spellings collide on the same team.
      const variants = [
        t.displayName,
        t.name,
        t.shortDisplayName,
        t.nickname,
        t.location,
        t.abbreviation,
      ];
      for (const v of variants) {
        const key = normalize(v);
        if (key && !byName.has(key)) byName.set(key, t);
      }
    }
    teamDirCache = { fetchedAt: Date.now(), byName, teams };
    return teamDirCache;
  })();

  try {
    return await teamDirPromise;
  } finally {
    teamDirPromise = null;
  }
}

function findTeam(dir, teamName) {
  const key = normalize(teamName);
  if (!key) return null;
  if (dir.byName.has(key)) return dir.byName.get(key);
  // Substring fallback: "Saint Joseph's" vs "St. Joseph's", "NC State" vs "North Carolina State", etc.
  let best = null;
  let bestLen = 0;
  for (const [k, team] of dir.byName) {
    if (k.length < 3) continue;
    if (k.includes(key) || key.includes(k)) {
      // Prefer the longest-matching key so "texas" doesn't shadow "texas am".
      if (k.length > bestLen) { best = team; bestLen = k.length; }
    }
  }
  return best;
}

async function getRoster(teamId) {
  const cached = rosterCache.get(teamId);
  if (cached && Date.now() - cached.fetchedAt < ROSTER_TTL_MS) {
    return cached.athletes;
  }
  const r = await fetch(`${ESPN_SITE}/teams/${teamId}/roster`, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`ESPN /roster HTTP ${r.status}`);
  const data = await r.json();
  // ESPN returns athletes either as a flat array or grouped by position.
  let athletes = [];
  const raw = data.athletes;
  if (Array.isArray(raw)) {
    if (raw.length && Array.isArray(raw[0].items)) {
      for (const group of raw) {
        if (Array.isArray(group.items)) athletes.push(...group.items);
      }
    } else {
      athletes = raw;
    }
  }
  rosterCache.set(teamId, { fetchedAt: Date.now(), athletes });
  return athletes;
}

// Score an athlete against the target player name. 0 = no match.
// Higher is better; we pick the max across the roster.
function scoreMatch(athlete, targetParts) {
  if (!targetParts.length) return 0;
  const candidates = [
    athlete.displayName,
    athlete.fullName,
    `${athlete.firstName || ''} ${athlete.lastName || ''}`,
    athlete.shortName,
  ].filter(Boolean);

  let best = 0;
  const targetFull = targetParts.join(' ');
  const targetFirst = targetParts[0];
  const targetLast = targetParts[targetParts.length - 1];

  for (const name of candidates) {
    const parts = splitName(name);
    if (!parts.length) continue;
    const full = parts.join(' ');
    // Exact normalized full name
    if (full === targetFull) { best = Math.max(best, 100); continue; }
    const first = parts[0];
    const last = parts[parts.length - 1];
    // First + last match (ignoring middle names / initials on either side)
    if (first === targetFirst && last === targetLast) { best = Math.max(best, 85); continue; }
    // Last name + first-initial match — covers "A. Leach" vs "Aubrey Leach"
    if (last === targetLast && first[0] && first[0] === targetFirst[0]) { best = Math.max(best, 70); continue; }
    // Last name only — weakest, only used if nothing else hits.
    if (last === targetLast) { best = Math.max(best, 40); }
  }
  return best;
}

function findAthlete(athletes, playerName) {
  if (!Array.isArray(athletes) || athletes.length === 0) return null;
  const targetParts = splitName(playerName);
  if (targetParts.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const a of athletes) {
    const s = scoreMatch(a, targetParts);
    if (s > bestScore) { best = a; bestScore = s; }
  }
  // Require at least a last-name match. A lone last-name hit (score 40) can
  // still be wrong (two players with the same last name), so only return it
  // when it's unambiguous.
  if (!best || bestScore < 40) return null;
  if (bestScore === 40) {
    // Ambiguity guard: if more than one athlete scored 40, bail.
    let countAt40 = 0;
    for (const a of athletes) {
      if (scoreMatch(a, targetParts) >= 40) countAt40++;
    }
    if (countAt40 > 1) return null;
  }
  return { athlete: best, score: bestScore };
}

function extractPhotoUrl(athlete) {
  if (!athlete) return null;
  if (athlete.headshot?.href) return athlete.headshot.href;
  if (athlete.id) {
    return `https://a.espncdn.com/i/headshots/college-softball/players/full/${athlete.id}.png`;
  }
  return null;
}

function extractTeamLogo(team) {
  return team?.logos?.[0]?.href || team?.logo || null;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  const team = searchParams.get('team');

  if (!name) return Response.json({ error: 'name required' }, { status: 400 });
  if (!team) return Response.json({ error: 'team required' }, { status: 400 });

  const cacheKey = `${normalize(name)}|${normalize(team)}`;
  const cached = photoCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PHOTO_TTL_MS) {
    return Response.json(cached.result, {
      headers: { 'Cache-Control': 'public, max-age=1800, s-maxage=1800' },
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
    const dir = await getTeamDirectory();
    const espnTeam = findTeam(dir, team);
    if (!espnTeam) {
      return respond({ matched: false, reason: 'team not found' });
    }

    let athletes;
    try {
      athletes = await getRoster(espnTeam.id);
    } catch (e) {
      return respond({
        matched: false,
        reason: `roster fetch failed: ${e.message}`,
        teamId: espnTeam.id,
        teamLogo: extractTeamLogo(espnTeam),
      });
    }

    const match = findAthlete(athletes, name);
    if (!match) {
      return respond({
        matched: false,
        reason: 'athlete not found in roster',
        teamId: espnTeam.id,
        teamLogo: extractTeamLogo(espnTeam),
      });
    }

    const { athlete, score } = match;
    const photoUrl = extractPhotoUrl(athlete);

    return respond({
      matched: true,
      photoUrl,
      athleteId: athlete.id,
      athleteName: athlete.displayName || `${athlete.firstName || ''} ${athlete.lastName || ''}`.trim(),
      position: athlete.position?.abbreviation || athlete.position?.displayName || null,
      jersey: athlete.jersey || null,
      classYear: athlete.experience?.displayValue || null,
      teamId: espnTeam.id,
      teamLogo: extractTeamLogo(espnTeam),
      matchScore: score,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
