export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Pull full-roster SEC softball stats directly from the data source
// secsports.com iframes on its Stats page:
//   https://www.secsports.com/sport/softball/stats
//     -> iframes https://www.secsports.com/team-stats-iframe/{ncaa_season_id}
//       -> iframes https://wmt.games/conference/sec/{ncaa_season_id}
//
// WMT's conference page ships the full dataset in the Nuxt hydration
// blob (see app/api/_wmt.js for the devalue parser and table
// normalization helpers). For the 2026 season that's:
//
//   - Overall team totals:   15 teams x (25 batting / 24 pitching / 14 fielding) cols
//   - Individual full roster: 148 hitters / 41 pitchers / 200 fielders,
//                             every player who has appeared for any SEC
//                             team this season (not a top-N leaderboard).
//
// This is strictly better than what we get from NCAA.com individual
// leaderboards because NCAA only surfaces players who qualify for the
// minimum and crack the top ~50 in some category. WMT exposes every
// contributor with a richer column set (OPS, TB, HBP, GDP, SH, SF,
// SB-ATT, KL, WP, BK, BF, NP/STK…).
//
// We discover the current ncaa_season_id from the SEC Inertia page
// (season rollover is handled automatically) and cache both the id and
// the full payload at module scope. Warm Vercel instances serve from
// memory for 15 minutes.

import { fetchWmtConferenceStats, groupWmtIndividualByTeam, groupWmtTeamTotals, normalizeTeamKey } from '../_wmt.js';

const SEC_STATS_PAGE = 'https://www.secsports.com/sport/softball/stats';
const SEC_SPORT_ID = 10; // softball

const TTL_MS = 15 * 60 * 1000;
let seasonIdCache = null;
let seasonIdAt = 0;
let statsCache = null;
let statsCacheAt = 0;

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

async function getCurrentSecSeasonId() {
  if (seasonIdCache && Date.now() - seasonIdAt < TTL_MS) return seasonIdCache;
  const r = await fetch(SEC_STATS_PAGE, {
    cache: 'no-store',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
      'Accept': 'text/html',
    },
  });
  if (!r.ok) throw new Error(`SEC stats page HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/data-page="([^"]+)"/);
  if (!m) throw new Error('SEC stats page: data-page attribute missing');
  const page = JSON.parse(decodeHtmlEntities(m[1]));
  const sport = page?.props?.sport;
  if (!sport || sport.id !== SEC_SPORT_ID) {
    throw new Error(`SEC stats page: sport mismatch (expected ${SEC_SPORT_ID})`);
  }
  const seasons = sport.sport_ncaa_seasons || [];
  // Prefer the explicitly-flagged default; fall back to the highest
  // ncaa_season_id since they increase monotonically each season.
  const current = seasons.find((s) => s.default)
    || [...seasons].sort((a, b) => (b.ncaa_season_id || 0) - (a.ncaa_season_id || 0))[0];
  if (!current?.ncaa_season_id) throw new Error('SEC stats page: no current ncaa_season_id found');
  seasonIdCache = current.ncaa_season_id;
  seasonIdAt = Date.now();
  return seasonIdCache;
}

async function buildPayload() {
  const seasonId = await getCurrentSecSeasonId();
  const url = `https://wmt.games/conference/sec/${seasonId}`;
  const conferenceKey = `conference-teams-sec-${seasonId}`;
  const stats = await fetchWmtConferenceStats(url, conferenceKey);

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
    conference: 'SEC',
    seasonId,
    season: stats.season,
    sourceUrl: url,
    columns: {
      // Column definitions (label + helpText + type) for each table so
      // the UI can render headers with tooltips without re-parsing the
      // WMT schema on the client.
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

// In-memory promise dedupe so a burst of cold requests collapses into a
// single upstream fetch.
let buildInFlight = null;

async function getSecStatsCached() {
  if (statsCache && Date.now() - statsCacheAt < TTL_MS) return statsCache;
  if (buildInFlight) return buildInFlight;
  buildInFlight = (async () => {
    try {
      const payload = await buildPayload();
      statsCache = payload;
      statsCacheAt = Date.now();
      return payload;
    } finally {
      buildInFlight = null;
    }
  })();
  return buildInFlight;
}

// Helper used by /api/team-stats to fetch a single team's SEC WMT view
// without going through the route handler. Returns null if the team
// isn't in the SEC payload (so callers can fall back cleanly).
export async function getSecTeamStats(teamNameOrVariants) {
  const payload = await getSecStatsCached().catch(() => null);
  if (!payload) return null;
  const variants = Array.isArray(teamNameOrVariants) ? teamNameOrVariants : [teamNameOrVariants];
  const keys = new Set(variants.map(normalizeTeamKey).filter(Boolean));
  if (keys.size === 0) return null;
  const match = payload.teams.find((t) => keys.has(t.key));
  if (!match) return null;
  return {
    ...match,
    columns: payload.columns,
    seasonId: payload.seasonId,
    sourceUrl: payload.sourceUrl,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const team = searchParams.get('team');
  const debug = searchParams.get('debug');
  try {
    if (team) {
      const single = await getSecTeamStats(team);
      if (!single) {
        return Response.json({ error: `SEC team not found: ${team}` }, { status: 404 });
      }
      return Response.json(single, {
        headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800' },
      });
    }
    const payload = await getSecStatsCached();
    if (debug) {
      return Response.json({
        ...payload,
        _meta: {
          cacheHit: true,
          cachedAt: new Date(statsCacheAt).toISOString(),
          seasonId: seasonIdCache,
        },
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800' },
    });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
