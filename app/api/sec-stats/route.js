export const dynamic = 'force-dynamic';
export const revalidate = 0;

// SEC softball full-roster stats endpoint.
//
// Thin wrapper around the shared WMT Games conference stats fetcher
// (see app/api/_wmt-stats.js for the data-source story, discovery
// flow, and caching). SEC was the first conference we scraped via WMT
// so it gets its own API endpoint for backward compatibility; all other
// WMT-hosted conferences flow through team-stats/route.js via the
// shared helper.
//
// Endpoint shapes:
//   GET /api/sec-stats            → full conference payload (all teams)
//   GET /api/sec-stats?team=Name  → one team's slice
//   GET /api/sec-stats?debug=1    → full payload with cache metadata

import {
  getConferenceStatsCached,
  getConferenceTeamStats,
} from '../_wmt-stats.js';

// Back-compat re-export for internal callers that import from sec-stats.
// New code should import getConferenceTeamStats directly from _wmt-stats.js.
export async function getSecTeamStats(teamNameOrVariants) {
  return getConferenceTeamStats('SEC', teamNameOrVariants);
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
    const payload = await getConferenceStatsCached('SEC');
    if (!payload) {
      return Response.json({ error: 'SEC stats payload unavailable' }, { status: 502 });
    }
    if (debug) {
      return Response.json(
        { ...payload, _meta: { cacheHit: true, cachedAt: new Date().toISOString() } },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(payload, {
      headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800' },
    });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
