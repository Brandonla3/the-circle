// NCAA D1 Softball player stats — leaderboards + cross-category player profiles.
//
//   GET /api/player-stats                            -> { categories: [...] }
//   GET /api/player-stats?category=home-runs         -> leaderboard rows
//   GET /api/player-stats?profile=1&name=...&team=...&side=batting|pitching
//                                                    -> merged player profile
//   GET /api/player-stats?debug=1                    -> discovery diagnostics
//
// All of the real work lives in ../_ncaa-player.js so that
// /api/team-stats can reuse the same cached leaderboard fetcher when it
// aggregates per-player stats for a single team.

import {
  ALL_CATEGORIES,
  discoverCategoryIds,
  fetchLeaderboard,
  fetchProfile,
  listCachedSlugs,
} from '../_ncaa-player.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get('profile');

  try {
    if (profile) {
      const data = await fetchProfile({
        name: searchParams.get('name') || '',
        team: searchParams.get('team') || '',
        side: searchParams.get('side') || 'batting',
      });
      return new Response(JSON.stringify(data), {
        status: data.error ? 404 : 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200',
        },
      });
    }

    // Diagnostic endpoint — returns what discovery actually found so we can
    // iterate on the label-matching logic without flying blind.
    if (searchParams.get('debug')) {
      try {
        const map = await discoverCategoryIds();
        const matched = ALL_CATEGORIES
          .filter((c) => map.has(c.slug))
          .map((c) => ({
            slug: c.slug,
            side: c.side,
            tried: c.labels,
            matchedNcaaLabel: map.get(c.slug).label,
            statId: map.get(c.slug).id,
          }));
        const missing = ALL_CATEGORIES
          .filter((c) => !map.has(c.slug))
          .map((c) => ({ slug: c.slug, side: c.side, tried: c.labels }));
        return new Response(JSON.stringify({
          ok: true,
          attempts: map._attempts || [],
          discoveredCount: map._discoveredCount || 0,
          rawDiscovered: map._raw || {},
          curatedMatched: matched,
          curatedMissing: missing,
        }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          error: e.message,
          debug: e.debug || null,
        }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const slug = searchParams.get('category');
    if (!slug) {
      // Index of categories the UI can show. Source order:
      //   1. The nightly NCAA scrape — anything with rows shows up first.
      //   2. Categories not in the scrape today (BA / ERA / WHIP) fall
      //      through to live discovery so they're still listed and the
      //      wrapper will be tried on selection.
      // If both are empty, we still return the curated list so the
      // dropdown isn't empty.
      const cached = await listCachedSlugs();
      const cachedSet = new Set(cached.slugs.map((c) => c.slug));

      // Prefer cached-only when the nightly scrape ran successfully —
      // otherwise the dropdown would include stats that take ~10s to
      // resolve through the broken wrapper before "Leaders unavailable".
      // Fall back to discovery only if we have no cache at all.
      let availableSet;
      if (cachedSet.size > 0) {
        availableSet = cachedSet;
      } else {
        try {
          const map = await discoverCategoryIds();
          availableSet = new Set([...map.keys()]);
        } catch {
          availableSet = new Set(ALL_CATEGORIES.map((c) => c.slug));
        }
      }

      const categories = ALL_CATEGORIES
        .filter((c) => availableSet.has(c.slug))
        .map((c) => ({
          slug: c.slug,
          label: c.labels[0],
          short: c.short,
          side: c.side,
          cached: cachedSet.has(c.slug),
        }));

      return new Response(JSON.stringify({
        categories,
        scraped: cached.scraped,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200',
        },
      });
    }

    const data = await fetchLeaderboard(slug);
    if (!data) {
      return new Response(JSON.stringify({ error: `Failed to fetch leaderboard ${slug}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, debug: e.debug || undefined }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
