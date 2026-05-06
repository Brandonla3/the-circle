export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Fetches the NCAA D1 Softball tournament bracket/schedule from ESPN's
// postseason scoreboard. Scans the full tournament window (mid-May through
// early June) and groups games by round: Regionals → Super Regionals →
// Women's College World Series.

const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'application/json',
};

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Tournament window: May 10 – June 10 of the current year.
// Regionals typically run weeks 1–2, Super Regionals week 3, WCWS weeks 4–5.
function getTournamentDates(year) {
  const dates = [];
  const cur = new Date(Date.UTC(year, 4, 10)); // May 10
  const end = new Date(Date.UTC(year, 5, 10)); // June 10
  while (cur <= end) {
    dates.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// Determine the tournament round from ESPN competition notes, falling back to
// date-based heuristics for the 2026 calendar (Regionals May 14–18,
// Super Regionals May 21–25, WCWS May 28–June 7).
function classifyRound(event) {
  const notes = event.competitions?.[0]?.notes || [];
  const noteText = notes.map((n) => (n.headline || n.text || '')).join(' ').toLowerCase();
  const name = (event.name || event.shortName || '').toLowerCase();

  if (
    noteText.includes('world series') ||
    noteText.includes('wcws') ||
    name.includes('world series')
  ) return 'WCWS';

  if (
    noteText.includes('super regional') ||
    name.includes('super regional')
  ) return 'Super Regionals';

  if (
    noteText.includes('regional') ||
    name.includes('regional') ||
    noteText.includes('ncaa') ||
    noteText.includes('tournament')
  ) return 'Regionals';

  // Date-based fallback for 2026 expected schedule.
  const d = new Date(event.date || 0);
  const md = d.getUTCMonth() * 100 + d.getUTCDate();
  if (md >= 528) return 'WCWS';           // May 28+
  if (md >= 521) return 'Super Regionals'; // May 21–27
  if (md >= 514) return 'Regionals';       // May 14–20

  return 'Tournament';
}

const ROUND_ORDER = ['Regionals', 'Super Regionals', 'WCWS', 'Tournament'];

// Module-scope response cache. Shared across warm Vercel instances so repeated
// hits within the TTL window skip all ESPN fetching.
let scheduleCache = null;
let scheduleCachePromise = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchTournamentSchedule() {
  const year = new Date().getUTCFullYear();
  const dates = getTournamentDates(year);
  const allEvents = [];
  const seen = new Set();

  // Fetch in small batches to avoid triggering ESPN rate limits.
  const batchSize = 4;
  const batchDelayMs = 120;

  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (date) => {
        try {
          const url = `${ESPN_SITE}/scoreboard?dates=${fmtDate(date)}&limit=200`;
          const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
          if (!r.ok) return [];
          const data = await r.json();
          return data.events || [];
        } catch {
          return [];
        }
      })
    );
    for (const events of results) {
      for (const ev of events) {
        // Deduplicate by event id; ESPN sometimes returns the same game across
        // adjacent date queries if it spans midnight.
        if (!seen.has(ev.id)) {
          seen.add(ev.id);
          // Only include postseason events (season.type === 3) or events during
          // the tournament window that have no explicit season type set.
          const seasonType = ev.season?.type ?? ev.competitions?.[0]?.season?.type;
          if (!seasonType || seasonType === 3) {
            allEvents.push(ev);
          }
        }
      }
    }
    if (i + batchSize < dates.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }

  // Group events by round → then by date.
  const roundMap = new Map();

  for (const ev of allEvents) {
    const round = classifyRound(ev);
    if (!roundMap.has(round)) roundMap.set(round, new Map());

    const dateKey = (ev.date || '').slice(0, 10); // YYYY-MM-DD
    const dateGroup = roundMap.get(round);
    if (!dateGroup.has(dateKey)) dateGroup.set(dateKey, []);
    dateGroup.get(dateKey).push(ev);
  }

  // Serialize into an ordered array of rounds, each containing ordered dates.
  const rounds = [];
  for (const roundName of ROUND_ORDER) {
    if (!roundMap.has(roundName)) continue;
    const dateMap = roundMap.get(roundName);
    const dates = Array.from(dateMap.keys()).sort();
    const groups = dates.map((dk) => ({
      date: dk,
      games: dateMap.get(dk).sort((a, b) => new Date(a.date) - new Date(b.date)),
    }));
    rounds.push({ round: roundName, groups });
  }

  return { rounds, total: allEvents.length, fetchedAt: new Date().toISOString() };
}

async function getSchedule() {
  if (scheduleCache && Date.now() - scheduleCache.fetchedAt < CACHE_TTL_MS) {
    return scheduleCache.data;
  }
  if (scheduleCachePromise) return scheduleCachePromise;

  scheduleCachePromise = (async () => {
    const data = await fetchTournamentSchedule();
    scheduleCache = { fetchedAt: Date.now(), data };
    return data;
  })();

  try {
    return await scheduleCachePromise;
  } finally {
    scheduleCachePromise = null;
  }
}

export async function GET() {
  try {
    const data = await getSchedule();
    const hasLive = data.rounds.some((r) =>
      r.groups.some((g) =>
        g.games.some((ev) => ev.status?.type?.state === 'in')
      )
    );
    // Short TTL when games are live, slightly longer otherwise.
    const maxAge = hasLive ? 30 : 300;
    return Response.json(data, {
      headers: {
        'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
      },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
