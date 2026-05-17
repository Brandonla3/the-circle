// Shared NCAA GraphQL bracket fetch + ESPN-shape transform.
//
// Hits the same persisted-query endpoint the official bracket page uses:
//   GetBracketChampionship_ncaa @ sdataprod.ncaa.com
// One GraphQL call returns every game, every team's win/elimination state,
// every venue, and every logo URL — all replacing the prior ESPN day-by-day
// scoreboard scrape.
//
// gameToEvent / ncaaToScheduleData transform NCAA's response into the same
// shape ESPN was returning, so the front-end and the rest of the bracket
// renderer don't have to know the source changed.
//
// Module-scope cache is shared across all routes that import this file,
// so /api/cws-bracket and /api/ncaa-bracket fetch the upstream once.

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

async function fetchYear(year) {
  const variables = JSON.stringify({
    championshipId: CHAMPIONSHIP_ID,
    sportUrl:       SPORT_URL,
    division:       DIVISION,
    year,
    staticTestEnv:  null,
  });
  const extensions = JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: GQL_SHA },
  });
  const url =
    `${GQL_ENDPOINT}?meta=${GQL_META}` +
    `&extensions=${encodeURIComponent(extensions)}` +
    `&variables=${encodeURIComponent(variables)}`;
  const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching NCAA bracket`);
  return r.json();
}

// Returns the championship object (data.championships[0]).
export async function getNcaaBracket() {
  if (cache && Date.now() - cache.t < TTL_MS) return cache.data;
  const year = new Date().getUTCFullYear();
  let raw;
  try {
    raw = await fetchYear(year);
    if (!raw?.data?.championships?.[0]) throw new Error('empty championships');
  } catch {
    raw = await fetchYear(year - 1);
  }
  const champ = raw?.data?.championships?.[0];
  if (!champ) throw new Error('No NCAA championship data');
  cache = { t: Date.now(), data: champ };
  return champ;
}

// Section IDs encode the round:
//   101–116  Regionals
//   201–208  Super Regionals
//   301–302  WCWS brackets
//   401      WCWS Finals
export function sectionToRound(sid) {
  if (sid >= 300) return 'WCWS';
  if (sid >= 200) return 'Super Regionals';
  if (sid >= 100) return 'Regionals';
  return 'Tournament';
}

const STATE_MAP = { F: 'post', I: 'in', P: 'pre' };

const absLogo = (p) => {
  if (!p) return null;
  return /^https?:/i.test(p) ? p : `https://www.ncaa.com${p}`;
};

function competitorFor(t, homeAway) {
  if (!t) return null;
  const full  = t.nameFull  || t.nameShort || 'TBD';
  const short = t.nameShort || t.nameFull  || 'TBD';
  const logo  = absLogo(t.logoUrl);
  return {
    homeAway,
    team: {
      id:               full,
      displayName:      full,
      shortDisplayName: short,
      logo,
      logos:            logo ? [{ href: logo }] : [],
      color:            t.color || undefined,
    },
    score:        t.score ?? null,
    winner:       Boolean(t.isWinner),
    eliminated:   Boolean(t.eliminated),
    curatedRank:  { current: typeof t.seed === 'number' ? t.seed : 99 },
    records:      t.record ? [{ summary: t.record }] : [],
  };
}

function gameDate(g) {
  if (g.startTimeEpoch) {
    const ms = Number(g.startTimeEpoch) * 1000;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  if (g.startDate) {
    const d = new Date(g.startDate);
    if (!Number.isNaN(d.valueOf())) return d.toISOString();
  }
  return '';
}

// Transform an NCAA game into an ESPN-shaped event the front-end already
// knows how to render. Adds two NCAA-specific fields (`isIfNecessary`,
// `sectionId`) the SR / regional logic looks at.
export function gameToEvent(g, sectionTitle) {
  const date = gameDate(g);
  const top  = g.teams?.find((t) =>  t.isTop) || null;
  const bot  = g.teams?.find((t) => !t.isTop) || null;
  const competitors = [
    competitorFor(top, 'away'),
    competitorFor(bot, 'home'),
  ].filter(Boolean);
  const state = STATE_MAP[g.gameState] || 'pre';
  const sectionCity = sectionTitle
    ? sectionTitle.replace(/\s*Super\s*Regional\s*$/i, '').replace(/\s*Regional\s*$/i, '').trim()
    : '';

  return {
    id:        String(g.contestId ?? `${g.sectionId}-${date}`),
    date,
    name:      `${top?.nameShort || 'TBD'} vs ${bot?.nameShort || 'TBD'}`,
    shortName: `${top?.nameShort || 'TBD'} @ ${bot?.nameShort || 'TBD'}`,
    status: {
      type: {
        state,
        completed:   state === 'post',
        description: g.statusCodeDisplay || (state === 'post' ? 'Final' : state === 'in' ? 'In Progress' : 'Scheduled'),
        detail:      g.finalMessage || g.currentPeriod || g.statusCodeDisplay || '',
        shortDetail: g.currentPeriod || g.statusCodeDisplay || (state === 'post' ? 'Final' : ''),
      },
    },
    competitions: [{
      id:    String(g.contestId ?? ''),
      date,
      competitors,
      venue: {
        fullName: g.location?.venue || sectionTitle || '',
        address: {
          city:  g.location?.city || sectionCity || '',
          state: g.location?.stateUsps || '',
        },
      },
      notes: sectionTitle ? [{ headline: sectionTitle, text: sectionTitle }] : [],
    }],
    season:         { type: 3 }, // postseason
    isIfNecessary:  Boolean(g.isIfNecessary),
    sectionId:      g.sectionId,
  };
}

// Build the legacy `{ rounds: [{ round, groups: [{ date, games }] }] }` shape.
export function ncaaToScheduleData(champ) {
  const titleById = new Map();
  for (const s of (champ.sections || [])) {
    titleById.set(s.sectionId, (s.title || '').trim());
  }

  const roundMap = new Map();
  for (const g of (champ.games || [])) {
    const round = sectionToRound(g.sectionId);
    if (!roundMap.has(round)) roundMap.set(round, new Map());
    const event   = gameToEvent(g, titleById.get(g.sectionId));
    const dateKey = (event.date || '').slice(0, 10) || 'unknown';
    const dateMap = roundMap.get(round);
    if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
    dateMap.get(dateKey).push(event);
  }

  const ROUND_ORDER = ['Regionals', 'Super Regionals', 'WCWS', 'Tournament'];
  const rounds = [];
  for (const roundName of ROUND_ORDER) {
    if (!roundMap.has(roundName)) continue;
    const dateMap = roundMap.get(roundName);
    const dates   = Array.from(dateMap.keys()).sort();
    const groups  = dates.map((dk) => ({
      date:  dk,
      games: dateMap.get(dk).sort((a, b) => new Date(a.date) - new Date(b.date)),
    }));
    rounds.push({ round: roundName, groups });
  }

  return {
    rounds,
    total:     (champ.games || []).length,
    fetchedAt: new Date().toISOString(),
  };
}

const norm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/\bregional\b/g, '')
    .replace(/[^a-z0-9]+/g, '');

// Per-regional winner + SR matchup extraction, factored out so /api/ncaa-bracket
// and the front-end can share one source of truth.
export function buildWinnersAndMatchups(champ) {
  const titleById = new Map();
  for (const s of (champ.sections || [])) {
    titleById.set(s.sectionId, { title: (s.title || '').trim() });
  }

  // sectionId -> Map<teamName, teamRecord>
  const sectionTeams = new Map();
  const sectionGames = new Map();
  for (const g of (champ.games || [])) {
    const sid = g.sectionId;
    if (!sectionTeams.has(sid)) sectionTeams.set(sid, new Map());
    if (!sectionGames.has(sid)) sectionGames.set(sid, []);
    sectionGames.get(sid).push(g);
    for (const t of (g.teams || [])) {
      const name = t.nameShort || t.nameFull;
      if (!name || name === 'TBD') continue;
      const bucket = sectionTeams.get(sid);
      const prior  = bucket.get(name);
      const o = {
        name,
        nameFull:      t.nameFull || name,
        seed:          typeof t.seed === 'number' ? t.seed : null,
        record:        t.record || '',
        sectionRecord: t.sectionRecord || '',
        isWinner:      Boolean(t.isWinner),
        eliminated:    Boolean(t.eliminated),
        logoUrl:       absLogo(t.logoUrl),
        color:         t.color || '',
      };
      if (!prior) {
        bucket.set(name, o);
      } else {
        prior.eliminated = prior.eliminated || o.eliminated;
        prior.isWinner   = prior.isWinner   || o.isWinner;
        if (o.seed != null)  prior.seed = o.seed;
        if (o.logoUrl)       prior.logoUrl = o.logoUrl;
        if (o.record)        prior.record = o.record;
        if (o.sectionRecord) prior.sectionRecord = o.sectionRecord;
      }
    }
  }

  const regionals = {};
  const winners   = {};
  for (const [sid, info] of titleById.entries()) {
    if (sid < 101 || sid >= 200) continue;
    const teams = [...(sectionTeams.get(sid) || new Map()).values()];
    const games = sectionGames.get(sid) || [];
    // A regional is decided iff no game is live AND no required (non-if-
    // necessary) game is still scheduled. A live if-necessary Game 7 counts
    // as blocking — if it's being played, it's being played.
    const requiredPending = games.some(
      (g) => g.gameState === 'I' || (g.gameState === 'P' && !g.isIfNecessary),
    );
    const surviving = teams.filter((t) => !t.eliminated);
    const winner    = !requiredPending && surviving.length === 1 ? surviving[0] : null;
    const cityKey   = norm(info.title);
    regionals[sid] = {
      sectionId:  sid,
      title:      info.title,
      cityKey,
      teams,
      winner,
      inProgress: requiredPending,
    };
    if (winner) winners[cityKey] = winner;
  }

  const srMatchups = [];
  for (const [sid, info] of titleById.entries()) {
    if (sid < 201 || sid >= 300) continue;
    const teams  = [...(sectionTeams.get(sid) || new Map()).values()];
    const idx    = sid - 201;
    const rTopId = 101 + idx * 2;
    const rBotId = 102 + idx * 2;
    const rTop   = regionals[rTopId] || null;
    const rBot   = regionals[rBotId] || null;
    srMatchups.push({
      sectionId: sid,
      title:     info.title,
      cityKey:   norm(info.title),
      teams,
      regionals: [
        rTop ? { sectionId: rTop.sectionId, title: rTop.title, cityKey: rTop.cityKey } : null,
        rBot ? { sectionId: rBot.sectionId, title: rBot.title, cityKey: rBot.cityKey } : null,
      ],
    });
  }

  const pairings = srMatchups
    .map((sr) => [sr.regionals[0]?.cityKey, sr.regionals[1]?.cityKey])
    .filter((p) => p[0] || p[1]);

  return { winners, pairings, regionals, srMatchups };
}
