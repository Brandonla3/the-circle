// Shared ESPN helpers used by routes that resolve teams and athletes against
// ESPN's college-softball endpoints. Nothing in here is wired to Next.js
// routing — this file is a plain module imported by the sibling route.js
// files under app/api/. (Only a file literally named `route.js` becomes an
// HTTP route in the app router, so this helper file is safe to colocate here.)
//
// Module-scope caches live for the lifetime of a warm Vercel instance, so
// repeated lookups of the same team / player resolve entirely in memory.

export const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball';

export const ESPN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json',
};

const TEAM_DIR_TTL_MS = 24 * 60 * 60 * 1000;
const ROSTER_TTL_MS = 60 * 60 * 1000;

let teamDirCache = null;        // { fetchedAt, byName: Map, teams: [] }
let teamDirPromise = null;      // in-flight dedupe
const rosterCache = new Map();  // teamId -> { fetchedAt, athletes, teamMeta }

export function normalize(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitName(s) {
  // Strip common suffixes so "Jessica Smith Jr." matches "Jessica Smith".
  return normalize(s)
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .split(' ')
    .filter(Boolean);
}

export async function getTeamDirectory() {
  if (teamDirCache && Date.now() - teamDirCache.fetchedAt < TEAM_DIR_TTL_MS) {
    return teamDirCache;
  }
  if (teamDirPromise) return teamDirPromise;

  teamDirPromise = (async () => {
    const r = await fetch(`${ESPN_SITE}/teams?limit=400`, { headers: ESPN_HEADERS, cache: 'no-store' });
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

export function findTeam(dir, teamName) {
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

export function findTeamById(dir, teamId) {
  const id = String(teamId || '');
  if (!id) return null;
  return dir.teams.find((t) => String(t.id) === id) || null;
}

export async function getRoster(teamId) {
  const cached = rosterCache.get(teamId);
  if (cached && Date.now() - cached.fetchedAt < ROSTER_TTL_MS) {
    return cached;
  }
  const r = await fetch(`${ESPN_SITE}/teams/${teamId}/roster`, { headers: ESPN_HEADERS, cache: 'no-store' });
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
  const entry = {
    fetchedAt: Date.now(),
    athletes,
    teamMeta: data.team || null,
  };
  rosterCache.set(teamId, entry);
  return entry;
}

// Score an athlete against the target player name. Higher is better.
// Tiered scoring so exact full-name matches always beat looser fallbacks.
export function scoreMatch(athlete, targetParts) {
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
    if (full === targetFull) { best = Math.max(best, 100); continue; }
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first === targetFirst && last === targetLast) { best = Math.max(best, 85); continue; }
    if (last === targetLast && first[0] && first[0] === targetFirst[0]) { best = Math.max(best, 70); continue; }
    if (last === targetLast) { best = Math.max(best, 40); }
  }
  return best;
}

export function findAthlete(athletes, playerName) {
  if (!Array.isArray(athletes) || athletes.length === 0) return null;
  const targetParts = splitName(playerName);
  if (targetParts.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const a of athletes) {
    const s = scoreMatch(a, targetParts);
    if (s > bestScore) { best = a; bestScore = s; }
  }
  if (!best || bestScore < 40) return null;
  if (bestScore === 40) {
    // Ambiguity guard: if more than one athlete scored 40, bail — a bare
    // last-name collision is too risky to commit to.
    let countAt40 = 0;
    for (const a of athletes) {
      if (scoreMatch(a, targetParts) >= 40) countAt40++;
    }
    if (countAt40 > 1) return null;
  }
  return { athlete: best, score: bestScore };
}

// Only returns a URL that ESPN actually shipped in the roster payload.
// We deliberately do NOT synthesize a CDN URL like
//   https://a.espncdn.com/i/headshots/college-softball/players/full/{id}.png
// because ESPN typically does not publish headshots for college softball
// athletes and a synthesized URL would 404 for every player.
export function extractAthletePhoto(athlete) {
  if (!athlete) return null;
  if (athlete.headshot?.href) return athlete.headshot.href;
  return null;
}

export function extractTeamLogo(team) {
  return team?.logos?.[0]?.href || team?.logo || null;
}

// For debug / introspection.
export function dumpCacheStats() {
  return {
    teamDirCached: !!teamDirCache,
    teamDirFetchedAt: teamDirCache?.fetchedAt || null,
    teamDirSize: teamDirCache?.teams?.length || 0,
    rosterCacheSize: rosterCache.size,
  };
}
