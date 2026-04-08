// Diagnostic route for figuring out which ESPN endpoints actually return
// season stats for D1 softball (team-level and per-athlete). I can't curl
// ESPN from the dev sandbox, so the flow is: deploy, hit this URL, paste
// the JSON back, and then build the real /api/team-stats route against
// whatever endpoint actually has data.
//
//   GET /api/team-stats-probe
//     -> probes with Tennessee (team=Tennessee) and whichever roster
//        athlete comes back first
//
//   GET /api/team-stats-probe?team=Oklahoma
//     -> probe a specific school
//
//   GET /api/team-stats-probe?teamId=2633&athleteId=4567
//     -> probe explicit ids (skips directory + roster lookup)
//
// For each candidate URL, the response includes:
//   status        HTTP status or 'error'
//   topKeys       top-level JSON keys (so I can see the overall shape)
//   hasStats      best-effort boolean — did we find anything that looks
//                 like stat categories or stat values
//   sample        a trimmed snippet of the response for a sense of shape
//   error         fetch exception message if any

import {
  ESPN_SITE,
  ESPN_HEADERS,
  getTeamDirectory,
  findTeam,
  findTeamById,
  getRoster,
} from '../_espn.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_TEAM_NAME = 'Tennessee';
const SEASON = new Date().getUTCFullYear();

// Trim a JSON tree so the probe response doesn't include the full 500 KB
// payload for every candidate. Keeps a couple of layers deep.
function trim(value, depth = 0, maxDepth = 3, maxArray = 3, maxStringLen = 200) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > maxStringLen ? value.slice(0, maxStringLen) + '…' : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= maxDepth) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((v) => trim(v, depth + 1, maxDepth, maxArray, maxStringLen));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = trim(v, depth + 1, maxDepth, maxArray, maxStringLen);
  }
  return out;
}

// Heuristic: does this response look like it contains stat data we could use?
function looksLikeStats(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const hay = JSON.stringify(raw).slice(0, 50000).toLowerCase();
  // A real softball stats payload will mention categories like batting/pitching
  // and canonical abbreviations.
  const needles = ['batting', 'pitching', 'avg', 'era', 'whip', 'categories', 'splits', 'statistics'];
  let hits = 0;
  for (const n of needles) {
    if (hay.includes(n)) hits++;
  }
  return hits >= 3;
}

async function probeUrl(label, url) {
  const meta = { label, url, status: null, topKeys: null, hasStats: false, sample: null, error: null };
  try {
    const r = await fetch(url, { headers: ESPN_HEADERS, cache: 'no-store' });
    meta.status = r.status;
    if (!r.ok) return meta;
    const raw = await r.json().catch(() => null);
    if (!raw) { meta.error = 'JSON parse failed'; return meta; }
    meta.topKeys = Object.keys(raw).slice(0, 20);
    meta.hasStats = looksLikeStats(raw);
    meta.sample = trim(raw);
  } catch (e) {
    meta.status = 'error';
    meta.error = String(e.message || e);
  }
  return meta;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const teamName = searchParams.get('team') || DEFAULT_TEAM_NAME;
  let teamId = searchParams.get('teamId');
  let athleteId = searchParams.get('athleteId');

  let resolvedTeam = null;
  const resolution = {};

  try {
    if (!teamId) {
      const dir = await getTeamDirectory();
      resolvedTeam = findTeam(dir, teamName);
      if (!resolvedTeam) {
        return Response.json(
          { error: `team '${teamName}' not found in ESPN directory`, knownTeamsSample: dir.teams.slice(0, 10).map((t) => t.displayName) },
          { status: 404 }
        );
      }
      teamId = String(resolvedTeam.id);
      resolution.resolvedFromName = teamName;
      resolution.teamDisplayName = resolvedTeam.displayName;
    } else {
      const dir = await getTeamDirectory();
      resolvedTeam = findTeamById(dir, teamId);
      if (resolvedTeam) resolution.teamDisplayName = resolvedTeam.displayName;
    }

    if (!athleteId) {
      try {
        const rosterEntry = await getRoster(teamId);
        const first = rosterEntry.athletes.find((a) => a.id);
        if (first) {
          athleteId = String(first.id);
          resolution.resolvedAthleteFromRoster = first.displayName;
          resolution.rosterSize = rosterEntry.athletes.length;
        }
      } catch (e) {
        resolution.rosterError = String(e.message || e);
      }
    }

    // Candidate endpoints. Each is a best-guess shape ESPN has used for other
    // sports; any that return 200 with stat-shaped data is a candidate for
    // the real /api/team-stats route.
    const teamCandidates = [
      ['site.web.v3 team statistics',
        `https://site.web.api.espn.com/apis/common/v3/sports/baseball/college-softball/teams/${teamId}/statistics`],
      ['site.web.v3 team summary',
        `https://site.web.api.espn.com/apis/common/v3/sports/baseball/college-softball/teams/${teamId}/summary`],
      ['site.api.v2 team statistics',
        `${ESPN_SITE}/teams/${teamId}/statistics`],
      ['site.api.v2 team (bare)',
        `${ESPN_SITE}/teams/${teamId}`],
      ['site.api.v2 team schedule',
        `${ESPN_SITE}/teams/${teamId}/schedule`],
      ['core.v2 team statistics (regular season)',
        `https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/seasons/${SEASON}/types/2/teams/${teamId}/statistics?lang=en&region=us`],
      ['core.v2 team record',
        `https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/seasons/${SEASON}/types/2/teams/${teamId}/record?lang=en&region=us`],
      ['site.web.v2 standings',
        'https://site.web.api.espn.com/apis/v2/sports/baseball/college-softball/standings'],
    ];

    const athleteCandidates = athleteId
      ? [
          ['site.web.v3 athlete statistics',
            `https://site.web.api.espn.com/apis/common/v3/sports/baseball/college-softball/athletes/${athleteId}/statistics`],
          ['site.web.v3 athlete overview',
            `https://site.web.api.espn.com/apis/common/v3/sports/baseball/college-softball/athletes/${athleteId}/overview`],
          ['site.web.v3 athlete gamelog',
            `https://site.web.api.espn.com/apis/common/v3/sports/baseball/college-softball/athletes/${athleteId}/gamelog`],
          ['core.v2 athlete statistics (regular season)',
            `https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/seasons/${SEASON}/types/2/athletes/${athleteId}/statistics?lang=en&region=us`],
          ['core.v2 athlete eventlog',
            `https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-softball/seasons/${SEASON}/athletes/${athleteId}/eventlog?lang=en&region=us`],
        ]
      : [];

    // Fire everything in parallel — it's 13 requests, all ESPN, and ESPN
    // doesn't aggressively rate-limit like the NCAA wrapper does.
    const all = [...teamCandidates, ...athleteCandidates];
    const results = await Promise.all(all.map(([label, url]) => probeUrl(label, url)));

    // Also probe the NCAA henrygd team leaderboard endpoint with a known
    // stat ID (271 = batting average, proven to exist from our earlier
    // player-stats discovery). Using the team-level variant for comparison.
    const ncaaTeamUrl = 'https://ncaa-api.henrygd.me/stats/softball/d1/current/team/514';
    const ncaaResult = await probeUrl('ncaa-api.henrygd.me team/514 (total HR)', ncaaTeamUrl);

    const summary = {
      totalProbed: all.length + 1,
      succeeded: [...results, ncaaResult].filter((r) => r.status === 200).length,
      withStatLikeData: [...results, ncaaResult].filter((r) => r.hasStats).length,
    };

    return Response.json(
      {
        resolution,
        teamId,
        athleteId,
        season: SEASON,
        summary,
        teamProbes: results.slice(0, teamCandidates.length),
        athleteProbes: results.slice(teamCandidates.length),
        ncaaProbe: ncaaResult,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
