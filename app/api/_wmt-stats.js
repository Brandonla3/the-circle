// Shared WMT Games conference stats fetcher.
//
// WMT Games (wmt.games) powers the in-iframe stats widgets on several
// D-I softball conference sites. Each conference page at
//   https://wmt.games/conference/{slug}/{ncaa_season_id}
// serves the FULL stats payload — team totals + individual full-roster
// tables — inline in the Nuxt hydration blob. ONE HTTP request per
// conference gets the complete dataset, which is dramatically better
// than the NCAA leaderboard approach (14+17 separate requests, rate
// limited, 7s budget per scan, top-50 only).
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │  MANUAL MAINTENANCE — add new conferences here as they're verified.│
// │  Last verified: 2026-04-11                                           │
// │                                                                       │
// │  To add a new conference:                                             │
// │    1. Open https://wmt.games/conference/{slug}/{current_season_id}   │
// │    2. Confirm the page serves a __NUXT_DATA__ blob with stats tables │
// │    3. Check the pinia key in the dataset (usually 'conference-       │
// │       teams-{slug}-{id}')                                            │
// │    4. Add an entry below                                              │
// │  What breaks if a conference isn't covered:                           │
// │    • Teams in that conference show '—' for batting/pitching/player   │
// │      stats in Team Compare and Player Compare tabs                   │
// │    • ESPN records (W-L, streak) still render instantly — only the   │
// │      NCAA-sourced fields are empty                                    │
// └───────────────────────────────────────────────────────────────────────┘

import {
  fetchWmtConferenceStats,
  groupWmtIndividualByTeam,
  groupWmtTeamTotals,
  normalizeTeamKey,
} from './_wmt.js';

// Catalog of confirmed WMT-hosted conferences, keyed by the canonical
// conference name used in app/api/_conferences.js. Each entry has the
// wmt.games URL slug and the pinia key prefix used in the hydration
// blob (format: `conference-teams-{slug}-{ncaa_season_id}`).
//
// Adding a new conference is 1 line — the shared fetcher handles the
// rest. Unmatched conferences return null so the caller can fall back
// to empty stats.
export const WMT_CONFERENCES = {
  SEC: {
    slug: 'sec',
    pineKeyPrefix: 'conference-teams-sec',
    discoveryUrl: 'https://www.secsports.com/sport/softball/stats',
  },
  'Mountain West': {
    // Note: the URL slug is `mwc`, NOT `mw` — verified via probe
    // 2026-04-11 (wmt.games/conference/mw/17020 returns 404, but
    // /conference/mwc/17020 returns 200 with the full payload).
    slug: 'mwc',
    pineKeyPrefix: 'conference-teams-mwc',
    // MW's themw.com stats page is WordPress-rendered without the Inertia
    // data we use for SEC discovery; we fall back to the SEC discovery URL
    // because the ncaa_season_id is NCAA-wide (not SEC-specific) so the
    // same ID works for every WMT conference.
    discoveryUrl: 'https://www.secsports.com/sport/softball/stats',
  },
};

const TTL_MS = 15 * 60 * 1000;

// Shared season-id cache — the ncaa_season_id is NCAA-wide so every
// WMT conference can reuse the same discovery result.
let seasonIdCache = null;
let seasonIdAt = 0;

// Per-conference payload cache + in-flight dedupe.
const confCache = new Map();      // confName -> { fetchedAt, data }
const confInFlight = new Map();   // confName -> Promise

// Inertia.js serializes the data-page JSON into an HTML attribute with
// the usual entity escapes. Decode the handful we see in practice.
function decodeHtmlEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

// Discover the current ncaa_season_id from the SEC Inertia stats page.
// The SEC page is the most reliable discovery source because secsports.com
// ships the data as a clean JSON blob in an HTML data attribute. The ID
// is an NCAA-wide identifier so every WMT conference accepts it.
async function discoverCurrentSeasonId() {
  if (seasonIdCache && Date.now() - seasonIdAt < TTL_MS) return seasonIdCache;
  const r = await fetch('https://www.secsports.com/sport/softball/stats', {
    cache: 'no-store',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
      'Accept': 'text/html',
    },
  });
  if (!r.ok) throw new Error(`season discovery HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/data-page="([^"]+)"/);
  if (!m) throw new Error('season discovery: data-page attribute missing');
  const page = JSON.parse(decodeHtmlEntities(m[1]));
  const sport = page?.props?.sport;
  const seasons = sport?.sport_ncaa_seasons || [];
  const current = seasons.find((s) => s.default)
    || [...seasons].sort((a, b) => (b.ncaa_season_id || 0) - (a.ncaa_season_id || 0))[0];
  if (!current?.ncaa_season_id) throw new Error('season discovery: no current ncaa_season_id');
  seasonIdCache = current.ncaa_season_id;
  seasonIdAt = Date.now();
  return seasonIdCache;
}

// Fetch and normalize the full stats payload for one WMT conference.
// Returns an object with per-team rosters, team totals, and column
// definitions the UI can render directly.
async function buildConferencePayload(confName) {
  const conf = WMT_CONFERENCES[confName];
  if (!conf) return null;
  const seasonId = await discoverCurrentSeasonId();
  const url = `https://wmt.games/conference/${conf.slug}/${seasonId}`;
  const pineKey = `${conf.pineKeyPrefix}-${seasonId}`;
  const stats = await fetchWmtConferenceStats(url, pineKey);

  const indByTeam = groupWmtIndividualByTeam(stats);
  const totalsByTeam = groupWmtTeamTotals(stats);

  // Merge the per-team player rosters + totals under a single key set.
  const allKeys = new Set([...indByTeam.keys(), ...totalsByTeam.keys()]);
  const teams = [];
  for (const key of allKeys) {
    const ind = indByTeam.get(key);
    const tot = totalsByTeam.get(key);
    teams.push({
      key,
      name: ind?.displayName || tot?.displayName || key,
      totals: {
        batting: tot?.batting || null,
        pitching: tot?.pitching || null,
        fielding: tot?.fielding || null,
      },
      players: {
        hitting: ind?.hitting || [],
        pitching: ind?.pitching || [],
        fielding: ind?.fielding || [],
      },
    });
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));

  return {
    conference: confName,
    seasonId,
    season: stats.season,
    sourceUrl: url,
    columns: {
      batting: stats.teamTotals.batting?.columns || [],
      pitching: stats.teamTotals.pitching?.columns || [],
      fielding: stats.teamTotals.fielding?.columns || [],
      hitting: stats.individual.hitting?.columns || [],
      individualPitching: stats.individual.pitching?.columns || [],
      individualFielding: stats.individual.fielding?.columns || [],
    },
    teams,
    updated: new Date().toISOString(),
  };
}

// Cached conference payload with in-flight dedupe so a burst of cold
// requests for teams in the same conference collapses to a single upstream
// fetch. 15-minute TTL matches the existing SEC-only implementation.
export async function getConferenceStatsCached(confName) {
  const cached = confCache.get(confName);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.data;
  if (confInFlight.has(confName)) return confInFlight.get(confName);
  const promise = (async () => {
    try {
      const payload = await buildConferencePayload(confName);
      if (payload) confCache.set(confName, { fetchedAt: Date.now(), data: payload });
      return payload;
    } finally {
      confInFlight.delete(confName);
    }
  })();
  confInFlight.set(confName, promise);
  return promise;
}

// Main entry point for the team-stats route. Looks up a single team's
// stats in the given conference's WMT payload. Returns null if:
//   - confName isn't in the WMT catalog
//   - the conference payload failed to fetch
//   - the team name didn't match any team in the payload
//
// `teamNameOrVariants` accepts a single string or an array of variant
// strings (the team-stats route passes the full nameVariantSet so an ESPN
// "Miss St." matches a WMT "Mississippi St." via normalizeTeamKey).
export async function getConferenceTeamStats(confName, teamNameOrVariants) {
  if (!WMT_CONFERENCES[confName]) return null;
  const payload = await getConferenceStatsCached(confName).catch(() => null);
  if (!payload) return null;
  const variants = Array.isArray(teamNameOrVariants) ? teamNameOrVariants : [teamNameOrVariants];
  const keys = new Set(variants.map(normalizeTeamKey).filter(Boolean));
  if (keys.size === 0) return null;
  const match = payload.teams.find((t) => keys.has(t.key));
  if (!match) return null;
  return {
    ...match,
    conference: confName,
    columns: payload.columns,
    seasonId: payload.seasonId,
    sourceUrl: payload.sourceUrl,
  };
}

// True if the conference has a WMT stats source. Callers can use this
// to decide whether to even attempt a stats fetch.
export function hasConferenceStats(confName) {
  return !!WMT_CONFERENCES[confName];
}
