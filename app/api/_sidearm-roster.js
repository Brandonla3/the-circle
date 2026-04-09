// Sidearm Sports school-level roster fetcher.
//
// Almost every Power-5 school athletic site runs on Sidearm Sports and
// exposes a versioned JSON API that ships full roster data — including
// jersey numbers and player headshot URLs — with no authentication:
//
//   Step 1 (sport discovery — varies per school):
//     GET {origin}/api/v2/sports
//     → array of sport objects; find the one where
//       globalSportNameSlug === "softball" → pluck its .id (site-specific,
//       e.g. OU=10, UT=12, OSU=30, Boise=9).
//
//   Step 2 (roster):
//     GET {origin}/api/v2/rosters?sportId={id}
//     → { items: [{ players: [{ firstName, lastName, jerseyNumber,
//                               image: { absoluteUrl }, positions: [...] }] }] }
//
// The sportId is stable within a season (it maps to the school's configured
// sport, not a season-specific roster), so we cache it for 24 h and only
// re-discover when the cache expires. The roster itself is also cached at
// 24 h because coaches don't change mid-season and our only use case is
// jersey + photo enrichment for Player Compare.
//
// NOT a route — Next.js only treats literal route.js files as endpoints.

const SPORT_ID_TTL_MS  = 24 * 60 * 60 * 1000; // 24 h
const ROSTER_TTL_MS    = 24 * 60 * 60 * 1000; // 24 h
const FETCH_TIMEOUT_MS = 10_000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json',
};

// Per-origin caches.
// sportIdCache:  origin → { fetchedAt, id }
// rosterCache:   origin → { fetchedAt, players }
const sportIdCache = new Map();
const rosterCache  = new Map();

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`Sidearm roster ${r.status}: ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Discover the school-specific softball sport id. Cached per origin.
async function discoverSoftballSportId(origin) {
  const cached = sportIdCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < SPORT_ID_TTL_MS) return cached.id;

  let data;
  try {
    data = await fetchJson(`${origin}/api/v2/sports`);
  } catch {
    return null;
  }
  const sports = Array.isArray(data) ? data : (data?.items || []);
  const match = sports.find(
    (s) => s.globalSportNameSlug === 'softball' || s.globalSportSlug === 'softball',
  );
  const id = match?.id ?? null;
  sportIdCache.set(origin, { fetchedAt: Date.now(), id });
  return id;
}

// Normalize one Sidearm player object into the full shape used throughout the app.
function normalizePlayer(p) {
  const firstName = (p.firstName || '').trim();
  const lastName  = (p.lastName  || '').trim();
  const name = [firstName, lastName].filter(Boolean).join(' ') || p.name || '';

  // positionShort is the reliable v2 field; fall back to legacy positions array.
  let position = p.positionShort || null;
  if (!position) {
    if (Array.isArray(p.positions) && p.positions.length > 0) {
      position = p.positions[0].abbreviation || p.positions[0].name || null;
    } else if (typeof p.position === 'string') {
      position = p.position || null;
    }
  }

  const photoUrl = p.image?.absoluteUrl || p.headshot?.url || null;

  // Height — combine feet + inches into a display string, e.g. "5'4\""
  const hFt = p.heightFeet  != null ? Number(p.heightFeet)  : null;
  const hIn = p.heightInches != null ? Number(p.heightInches) : null;
  const heightDisplay = (hFt != null && hIn != null)
    ? `${hFt}'${String(hIn).padStart(2, '0')}"`
    : null;

  // Bats/Throws — stored in custom2 on most Sidearm softball sites ("L/R", "R/R", etc.)
  const batThrows = p.custom2 && p.custom2.trim() ? p.custom2.trim() : null;

  return {
    firstName,
    lastName,
    name,
    jerseyNumber:   p.jerseyNumber != null ? String(p.jerseyNumber) : null,
    position,
    photoUrl,
    hometown:       (p.hometown       || '').trim() || null,
    highSchool:     (p.highSchool      || '').trim() || null,
    previousSchool: (p.previousSchool  || '').trim() || null,
    heightFeet:     hFt,
    heightInches:   hIn,
    heightDisplay,
    weight:         p.weight != null ? String(p.weight) : null,
    academicYear:   p.academicYearShort || null,  // "Fr." "So." "Jr." "Sr."
    batThrows,
  };
}

// Fetch and normalize the softball roster for one school. Returns an array
// of normalized player objects, or null on any error so the caller can
// gracefully fall back to the ESPN roster path.
async function fetchSidearmRosterPlayers(origin) {
  // Check roster cache first — avoiding the sport-id lookup on warm paths.
  const cached = rosterCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROSTER_TTL_MS) return cached.players;

  const sportId = await discoverSoftballSportId(origin);
  if (!sportId) return null;

  let data;
  try {
    data = await fetchJson(`${origin}/api/v2/rosters?sportId=${sportId}`);
  } catch {
    return null;
  }

  // Sidearm rosters come back as { items: [ { players: [...] } ] }.
  // The outer `items` array typically has one entry (the active season).
  const items = Array.isArray(data?.items) ? data.items : [];
  const rawPlayers = [];
  for (const item of items) {
    if (Array.isArray(item.players)) rawPlayers.push(...item.players);
  }
  if (rawPlayers.length === 0) return null;

  const players = rawPlayers.map(normalizePlayer).filter((p) => p.name.length > 0);
  rosterCache.set(origin, { fetchedAt: Date.now(), players });
  return players;
}

// Build a lookup map from normalized full-name → player for quick name-join.
// Returns null if the origin doesn't resolve or has no players.
export async function buildSidearmRosterIndex(origin) {
  if (!origin) return null;
  const players = await fetchSidearmRosterPlayers(origin).catch(() => null);
  if (!players || players.length === 0) return null;
  const map = new Map();
  for (const p of players) {
    if (p.name) map.set(p.name.toLowerCase(), p);
  }
  return { players, map };
}

// Exported for direct use in tests or one-off lookups.
export { fetchSidearmRosterPlayers };
