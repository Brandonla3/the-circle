// Nightly cache warmer for team-stats.
//
// Vercel Cron fires this at 05:00 UTC every day (midnight-1 AM CDT).
// NCAA publishes updated stats overnight, so by 5 AM the leaderboards
// are stable and we can pre-fetch the full season stats for every ranked
// team. With s-maxage=1800 on /api/team-stats, the Vercel CDN edge holds
// each response for 30 minutes and serves it to all users without hitting
// the origin. stale-while-revalidate=3600 means users never wait on a
// cold Lambda even after the s-maxage window.
//
// Why this matters:
//   Cold /api/team-stats on Vercel takes 10–18 seconds (NCAA leaderboard
//   scans are slow and throttled). The cron pre-warms the CDN edge cache
//   so every scorecard open during the day is an instant edge hit.
//
// Security: Vercel automatically sends Authorization: Bearer <CRON_SECRET>
// when invoking cron routes. Set CRON_SECRET in project env vars. Any
// request that doesn't carry the right secret gets a 401 so the endpoint
// can't be spammed by external callers.

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5-minute timeout for the full sweep

const DELAY_BETWEEN_TEAMS_MS = 2500; // give NCAA wrapper time to breathe
const ESPN_RANKINGS_URL =
  'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball/rankings';
const ESPN_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball/scoreboard?limit=50';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetch the top 25 ranked teams' ESPN IDs from the current poll.
async function getRankedTeamIds() {
  try {
    const r = await fetch(ESPN_RANKINGS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const poll = data.rankings?.[0];
    if (!poll?.ranks) return [];
    return poll.ranks
      .map((r) => r.team?.id ? String(r.team.id) : null)
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Also grab team IDs from today's scheduled games so we warm teams that
// are playing even if they're not in the top 25.
async function getTodayGameTeamIds() {
  try {
    const r = await fetch(ESPN_SCOREBOARD_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const ids = new Set();
    for (const ev of data.events || []) {
      for (const comp of ev.competitions || []) {
        for (const c of comp.competitors || []) {
          if (c.team?.id) ids.add(String(c.team.id));
        }
      }
    }
    return [...ids];
  } catch {
    return [];
  }
}

export async function GET(request) {
  // Verify the Vercel cron secret to block external callers.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const start = Date.now();
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  // Collect team IDs: ranked + today's games, deduped.
  const [ranked, today] = await Promise.all([getRankedTeamIds(), getTodayGameTeamIds()]);
  const seen = new Set();
  const teamIds = [];
  for (const id of [...ranked, ...today]) {
    if (!seen.has(id)) { seen.add(id); teamIds.push(id); }
  }

  const results = { ok: [], skipped: [], failed: [] };

  for (const teamId of teamIds) {
    try {
      const url = `${baseUrl}/api/team-stats?teamId=${teamId}`;
      const r = await fetch(url, {
        // No Authorization header — hits the route as a normal user request,
        // which populates the CDN edge cache (s-maxage=1800).
        headers: { 'User-Agent': 'TheCircle-CronWarmer/1.0' },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) {
        results.ok.push(teamId);
      } else {
        results.failed.push({ teamId, status: r.status });
      }
    } catch (e) {
      results.failed.push({ teamId, error: e.message });
    }
    // Brief pause between teams so we don't slam NCAA all at once.
    await sleep(DELAY_BETWEEN_TEAMS_MS);
  }

  return Response.json({
    warmed: results.ok.length,
    failed: results.failed.length,
    totalTeams: teamIds.length,
    ranked: ranked.length,
    todayGames: today.length,
    elapsedMs: Date.now() - start,
    details: results,
  });
}
