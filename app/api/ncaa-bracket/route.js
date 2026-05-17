export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Hits the same NCAA GraphQL persisted-query endpoint that powers
// https://www.ncaa.com/brackets/softball/d1/<year>. This is authoritative —
// every team has `isWinner` and `eliminated` flags maintained by NCAA, so the
// app no longer has to infer the regional winner from ESPN scores (which lag
// the real bracket and produced eliminated teams in earlier iterations).
//
// Section IDs encode the round:
//   101–116  Regionals (16)
//   201–208  Super Regionals (8)
//   301–302  WCWS brackets
//   401      WCWS Finals
// The standard bracket structure feeds R101+R102 → SR201, R103+R104 → SR202,
// and so on. We expose both the per-regional winner and the SR matchups so
// the front-end can render correct teams and correct pairings.

const GQL_ENDPOINT      = 'https://sdataprod.ncaa.com/';
const GQL_META          = 'GetBracketChampionship_ncaa';
const GQL_SHA           = '0f017b52a0eb4f83e33ca93e1278190edcf2e4bfba8202d300350c7cf29db1f7';
const CHAMPIONSHIP_ID   = 6410;
const SPORT_URL         = 'softball';
const DIVISION          = 1;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:            'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer:           'https://www.ncaa.com/brackets/softball/d1/',
  Origin:            'https://www.ncaa.com',
};

let cache = null;
const TTL_MS = 60 * 1000; // 1 min — keep up with live games

async function fetchBracket(year) {
  const variables = JSON.stringify({
    championshipId: CHAMPIONSHIP_ID,
    sportUrl: SPORT_URL,
    division: DIVISION,
    year,
    staticTestEnv: null,
  });
  const extensions = JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: GQL_SHA },
  });
  const url = `${GQL_ENDPOINT}?meta=${GQL_META}&extensions=${encodeURIComponent(extensions)}&variables=${encodeURIComponent(variables)}`;
  const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const norm = (s) => (s || '').toLowerCase().replace(/\bregional\b/g, '').replace(/[^a-z0-9]+/g, '');

function teamObj(t) {
  if (!t) return null;
  return {
    name:           t.nameShort || t.nameFull || 'TBD',
    nameFull:       t.nameFull || '',
    seed:           t.seed ?? null,
    record:         t.record || '',
    sectionRecord: t.sectionRecord || '',
    isWinner:       Boolean(t.isWinner),
    eliminated:     Boolean(t.eliminated),
    logoUrl:        t.logoUrl ? `https://www.ncaa.com${t.logoUrl}` : null,
    color:          t.color || '',
  };
}

function processBracket(raw) {
  const champ = raw?.data?.championships?.[0];
  if (!champ) throw new Error('No championship data in NCAA response');

  // sectionId -> { id, title, cityKey }
  const sectionInfo = new Map();
  for (const s of (champ.sections || [])) {
    const title = (s.title || '').trim();
    sectionInfo.set(s.sectionId, { id: s.sectionId, title, cityKey: norm(title) });
  }

  // sectionId -> Map<teamName, mergedTeamRecord>
  // Roll every game's team state forward so eliminated/isWinner reflect the
  // team's CURRENT status across all games at that site.
  const sectionTeams = new Map();
  // sectionId -> array of raw games (kept so we can check liveness below)
  const sectionGames = new Map();
  for (const g of (champ.games || [])) {
    const sid = g.sectionId;
    if (!sectionTeams.has(sid)) sectionTeams.set(sid, new Map());
    if (!sectionGames.has(sid)) sectionGames.set(sid, []);
    sectionGames.get(sid).push(g);
    const bucket = sectionTeams.get(sid);
    for (const t of (g.teams || [])) {
      const o = teamObj(t);
      if (!o || !o.name || o.name === 'TBD') continue;
      const prior = bucket.get(o.name);
      if (!prior) {
        bucket.set(o.name, o);
      } else {
        // Latest wins; once eliminated, stay eliminated.
        prior.eliminated = prior.eliminated || o.eliminated;
        prior.isWinner   = prior.isWinner   || o.isWinner;
        if (o.seed != null) prior.seed = o.seed;
        if (o.logoUrl)      prior.logoUrl = o.logoUrl;
        if (o.record)       prior.record = o.record;
        if (o.sectionRecord) prior.sectionRecord = o.sectionRecord;
      }
    }
  }

  // Per-regional winner: the single non-eliminated team in a regional section,
  // provided the regional has actually finished. "Finished" means:
  //   - No game is currently in progress (gameState 'I'), even an
  //     if-necessary Game 7 — if it's being played, the regional isn't done.
  //   - No required (non-if-necessary) game is still scheduled (gameState
  //     'P'). A scheduled if-necessary game may end up unneeded; we let the
  //     surviving=1 check below decide.
  const regionals = {};
  const winners   = {};
  for (const [sid, info] of sectionInfo.entries()) {
    if (sid < 101 || sid >= 200) continue;
    const teams = [...(sectionTeams.get(sid) || new Map()).values()];
    const games = sectionGames.get(sid) || [];
    const requiredPending = games.some(
      (g) => g.gameState === 'I' || (g.gameState === 'P' && !g.isIfNecessary),
    );
    const surviving = teams.filter((t) => !t.eliminated);
    const winner =
      !requiredPending && surviving.length === 1 ? surviving[0] : null;
    regionals[sid] = {
      sectionId: sid,
      title:     info.title,
      cityKey:   info.cityKey,
      teams,
      winner,
      inProgress: requiredPending,
    };
    if (winner) winners[info.cityKey] = winner;
  }

  // Super Regional sections: pair each with the two regionals that feed in.
  // Standard NCAA bracket structure pairs (101+102) → 201, (103+104) → 202, …
  const srMatchups = [];
  for (const [sid, info] of sectionInfo.entries()) {
    if (sid < 201 || sid >= 300) continue;
    const teams = [...(sectionTeams.get(sid) || new Map()).values()];
    const idx     = sid - 201;
    const rTopId  = 101 + idx * 2;
    const rBotId  = 102 + idx * 2;
    const rTop    = regionals[rTopId] || null;
    const rBot    = regionals[rBotId] || null;
    srMatchups.push({
      sectionId: sid,
      title:     info.title,
      cityKey:   info.cityKey,
      teams,
      regionals: [
        rTop ? { sectionId: rTop.sectionId, title: rTop.title, cityKey: rTop.cityKey } : null,
        rBot ? { sectionId: rBot.sectionId, title: rBot.title, cityKey: rBot.cityKey } : null,
      ],
    });
  }

  // Pairings as [cityKey1, cityKey2] — what the front-end consumes for pod layout.
  const pairings = srMatchups
    .map((sr) => [sr.regionals[0]?.cityKey, sr.regionals[1]?.cityKey])
    .filter((p) => p[0] || p[1]);

  // Plain-name pairings for legacy/display use (e.g. "Athens", "Tallahassee").
  const pairingNames = srMatchups
    .map((sr) => [
      sr.regionals[0]?.title?.replace(/\s*Regional\s*$/i, '') || null,
      sr.regionals[1]?.title?.replace(/\s*Regional\s*$/i, '') || null,
    ])
    .filter((p) => p[0] || p[1]);

  return {
    title: champ.title,
    year:  champ.year,
    fetchedAt: new Date().toISOString(),
    winners,        // { cityKey: TeamObj }
    pairings,       // [[cityKey1, cityKey2], ...]
    pairingNames,   // [[name1, name2], ...]
    regionals,      // { sectionId: { teams, winner, ... } }
    srMatchups,     // [{ sectionId, teams, regionals: [{...}, {...}] }, ...]
  };
}

async function getBracket() {
  if (cache && Date.now() - cache.t < TTL_MS) return cache.data;
  const year = new Date().getUTCFullYear();
  // Fall back to the prior year in the off-season so the route doesn't 4xx
  // before next year's bracket is staged.
  let raw;
  try {
    raw = await fetchBracket(year);
    if (!raw?.data?.championships?.[0]) throw new Error('empty championships');
  } catch {
    raw = await fetchBracket(year - 1);
  }
  const data = processBracket(raw);
  cache = { t: Date.now(), data };
  return data;
}

export async function GET() {
  try {
    const data = await getBracket();
    return Response.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    });
  } catch (e) {
    return Response.json(
      { error: e.message, winners: {}, pairings: [], pairingNames: [], regionals: {}, srMatchups: [] },
      { status: 500 },
    );
  }
}
