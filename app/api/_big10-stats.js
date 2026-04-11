// Big Ten softball stats source.
//
// bigten.org runs on Boost Sport AI's conference CMS (Next.js + SSR).
// Unlike SEC/MW (WMT Games) and Big 12/ACC (Sidearm plain HTML),
// the Boost stats page renders its table data client-side from a
// backend API at `b1gbeprod.boostsport.ai`.
//
// Discovery strategy — runs on first cold call, cached at module scope:
//
//   1) Fetch bigten.org/sb/stats/ HTML and parse __NEXT_DATA__.
//   2) Scan `props.pageProps.fallback` for ANY cache key whose value
//      has the distinctive Boost stats shape. Boost uses the same
//      "row.data = [{stat_key: value}, ...]" pattern for stats that
//      it uses for standings (see _big10-schedule.js + conference-
//      standings/route.js), so if the stats page SSR-prefetches its
//      own data into the fallback map, we can read it without ever
//      touching the API directly.
//   3) If no stats-shaped fallback value is found, fall through to
//      an API-URL probe: pull the buildId from __NEXT_DATA__, fetch
//      the `_buildManifest.js`, grep for a `stats-*.js` chunk filename,
//      fetch the chunk, and extract the actual API base URL from the
//      string literals in the compiled JS. Cache whatever works.
//
// Returns the same shape as getBig12TeamStats / getAccTeamStats so the
// team-stats route can use it without any code changes downstream.
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { normalizeTeamKey } from './_wmt.js';

const STATS_URL = 'https://bigten.org/sb/stats/';
const TTL_MS = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

let payloadCache = null;
let payloadCacheAt = 0;
let payloadInFlight = null;

// ---------------------------------------------------------------------------
// HTTP + parsing helpers
// ---------------------------------------------------------------------------

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`B1G stats ${r.status}: ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonMaybe(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      // Sometimes servers return JSON with text/plain. Try parsing anyway.
      const text = await r.text();
      try { return JSON.parse(text); } catch { return null; }
    }
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractNextData(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Row flattening + classification
// ---------------------------------------------------------------------------
//
// Boost Sport rows use the shape:
//   {
//     market: 'Oregon', alias: 'ORE', team_rank: 3, ...,
//     data: [{batting_average: '.345'}, {home_runs: 42}, {on_base_percentage: '.421'}, ...]
//   }
//
// For player rows, they use first_name/last_name/position and the same
// `data: [...]` array with per-stat objects. We flatten `row.data` onto
// the top level and then map snake_case field names onto the canonical
// labels the rest of the app expects (AVG/ERA/etc.).

function flattenRowData(row) {
  if (!row || typeof row !== 'object') return {};
  const flat = { ...row };
  delete flat.data;
  if (Array.isArray(row.data)) {
    for (const entry of row.data) {
      if (entry && typeof entry === 'object') {
        for (const [k, v] of Object.entries(entry)) {
          flat[k] = v;
        }
      }
    }
  }
  return flat;
}

// Heuristic: does this object look like a stats row? We check for a
// handful of canonical Boost field names that are common across every
// softball stats source. Matching any 2 flags it as a stats row.
const STAT_FIELD_HINTS = new Set([
  // batting
  'batting_average', 'avg', 'ba',
  'on_base_percentage', 'obp',
  'slugging_percentage', 'slg',
  'home_runs', 'hr',
  'runs_batted_in', 'rbi',
  'stolen_bases', 'sb',
  'hits', 'h',
  'at_bats', 'ab',
  'doubles', '2b',
  'triples', '3b',
  'walks', 'bb',
  'strikeouts', 'so', 'k',
  'runs', 'r',
  'games', 'games_played', 'gp', 'g',
  // pitching
  'earned_run_average', 'era',
  'innings_pitched', 'ip',
  'wins', 'w',
  'losses', 'l',
  'saves', 'sv',
  'shutouts', 'sho',
  'walks_hits_per_innings_pitched', 'whip',
  'earned_runs', 'er',
  'strikeouts_per_seven', 'k7', 'k_per_7',
  // fielding
  'fielding_percentage', 'fpct', 'fpct_',
  'put_outs', 'po',
  'assists', 'a',
  'errors', 'e',
]);

function countStatFields(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let hits = 0;
  for (const k of Object.keys(obj)) {
    if (STAT_FIELD_HINTS.has(k.toLowerCase())) hits++;
  }
  return hits;
}

// Scan the __NEXT_DATA__ fallback map for any key whose value contains
// stats-like rows. Returns an array of { key, rows, kind } entries.
// `kind` is 'team' or 'player' depending on whether rows have market/
// alias (team) or first_name/last_name (player) fields.
function findStatsFallbackKeys(fallback) {
  if (!fallback || typeof fallback !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(fallback)) {
    // Boost wraps SWR/SSR payloads in either { data: [...] } or directly
    // as an array. Try both shapes.
    const rows = Array.isArray(value) ? value
      : Array.isArray(value?.data) ? value.data
      : null;
    if (!rows || rows.length === 0) continue;
    // Check the shape of the first row after flattening row.data.
    const flat = flattenRowData(rows[0]);
    const statHits = countStatFields(flat);
    if (statHits < 2) continue;
    const isPlayer = !!(flat.first_name || flat.last_name || flat.player_name);
    const isTeam = !!(flat.market || flat.alias || flat.school || flat.team);
    if (!isPlayer && !isTeam) continue;
    out.push({
      key,
      kind: isPlayer ? 'player' : 'team',
      rows,
      statHits,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boost → canonical label mapping
// ---------------------------------------------------------------------------
//
// We normalize into the same label shape that the WMT and Sidearm paths
// use so team-stats/route.js's normalizeWmtBattingTotals /
// normalizeWmtPitchingTotals helpers accept these rows verbatim.
// The shared `pickLabel()` in route.js already tries multiple candidates
// per canonical key (BA → ['BA', 'AVG', ...]) so we output Boost's
// snake_case keys under short aliases that pickLabel will find.

function mapBoostBattingRow(flat, teamName) {
  if (!flat) return null;
  // Pick the first non-null of a list of candidate field names.
  const pick = (...names) => {
    for (const n of names) {
      if (flat[n] != null && flat[n] !== '') return flat[n];
    }
    return null;
  };
  return {
    Player:  pick('player_name', 'name', 'full_name') || (flat.first_name && flat.last_name ? `${flat.first_name} ${flat.last_name}` : (flat.last_name || flat.first_name || null)),
    Team:    teamName,
    '#':     pick('jersey_number', 'jersey', 'number'),
    Pos:     pick('position', 'primary_position', 'pos'),
    Yr:      pick('eligibility', 'class_year', 'year', 'yr'),
    G:       pick('games_played', 'games', 'gp', 'g'),
    AB:      pick('at_bats', 'ab'),
    R:       pick('runs', 'r'),
    H:       pick('hits', 'h'),
    '2B':    pick('doubles', '2b'),
    '3B':    pick('triples', '3b'),
    HR:      pick('home_runs', 'hr'),
    RBI:     pick('runs_batted_in', 'rbi'),
    BB:      pick('walks', 'base_on_balls', 'bb'),
    SO:      pick('strikeouts', 'so', 'k'),
    SB:      pick('stolen_bases', 'sb'),
    AVG:     pick('batting_average', 'avg', 'ba'),
    OBP:     pick('on_base_percentage', 'obp'),
    SLG:     pick('slugging_percentage', 'slg'),
  };
}

function mapBoostPitchingRow(flat, teamName) {
  if (!flat) return null;
  const pick = (...names) => {
    for (const n of names) {
      if (flat[n] != null && flat[n] !== '') return flat[n];
    }
    return null;
  };
  return {
    Player:  pick('player_name', 'name', 'full_name') || (flat.first_name && flat.last_name ? `${flat.first_name} ${flat.last_name}` : (flat.last_name || flat.first_name || null)),
    Team:    teamName,
    '#':     pick('jersey_number', 'jersey', 'number'),
    Pos:     'P',
    Yr:      pick('eligibility', 'class_year', 'year', 'yr'),
    App:     pick('appearances', 'games', 'gp', 'g', 'app'),
    IP:      pick('innings_pitched', 'ip'),
    W:       pick('wins', 'w'),
    L:       pick('losses', 'l'),
    SV:      pick('saves', 'sv'),
    SHO:     pick('shutouts', 'sho'),
    H:       pick('hits_allowed', 'hits', 'h'),
    R:       pick('runs_allowed', 'runs', 'r'),
    ER:      pick('earned_runs', 'er'),
    BB:      pick('walks_allowed', 'walks', 'bb'),
    SO:      pick('strikeouts_pitching', 'strikeouts', 'so', 'k'),
    ERA:     pick('earned_run_average', 'era'),
    WHIP:    pick('walks_hits_per_innings_pitched', 'whip'),
    'K/7':   pick('strikeouts_per_seven', 'k7', 'k_per_7'),
  };
}

// Team totals use the same flattened row shape, only keyed by market/alias
// instead of player name. Same mapping idea; the canonical labels match.
function mapBoostTeamBattingTotals(flat) {
  if (!flat) return null;
  const pick = (...names) => {
    for (const n of names) {
      if (flat[n] != null && flat[n] !== '') return flat[n];
    }
    return null;
  };
  return {
    Team:  pick('market', 'name', 'school', 'alias'),
    G:     pick('games_played', 'games', 'g'),
    AB:    pick('at_bats', 'ab'),
    R:     pick('runs', 'r'),
    H:     pick('hits', 'h'),
    '2B':  pick('doubles', '2b'),
    '3B':  pick('triples', '3b'),
    HR:    pick('home_runs', 'hr'),
    RBI:   pick('runs_batted_in', 'rbi'),
    BB:    pick('walks', 'base_on_balls', 'bb'),
    SO:    pick('strikeouts', 'so', 'k'),
    SB:    pick('stolen_bases', 'sb'),
    AVG:   pick('batting_average', 'avg', 'ba'),
    OBP:   pick('on_base_percentage', 'obp'),
    SLG:   pick('slugging_percentage', 'slg'),
  };
}

function mapBoostTeamPitchingTotals(flat) {
  if (!flat) return null;
  const pick = (...names) => {
    for (const n of names) {
      if (flat[n] != null && flat[n] !== '') return flat[n];
    }
    return null;
  };
  return {
    Team:  pick('market', 'name', 'school', 'alias'),
    G:     pick('games_played', 'games', 'g'),
    IP:    pick('innings_pitched', 'ip'),
    W:     pick('wins', 'w'),
    L:     pick('losses', 'l'),
    SV:    pick('saves', 'sv'),
    SHO:   pick('shutouts', 'sho'),
    H:     pick('hits_allowed', 'hits', 'h'),
    R:     pick('runs_allowed', 'runs', 'r'),
    ER:    pick('earned_runs', 'er'),
    BB:    pick('walks_allowed', 'walks', 'bb'),
    SO:    pick('strikeouts_pitching', 'strikeouts', 'so', 'k'),
    ERA:   pick('earned_run_average', 'era'),
    WHIP:  pick('walks_hits_per_innings_pitched', 'whip'),
    'K/7': pick('strikeouts_per_seven', 'k7', 'k_per_7'),
  };
}

// Classify a stats-shaped fallback value into batting/pitching/fielding
// by looking at which stat fields are present in the flattened first row.
// Returns 'batting' | 'pitching' | 'fielding' | null.
function classifyStatsRows(rows) {
  if (!rows || rows.length === 0) return null;
  const flat = flattenRowData(rows[0]);
  const has = (k) => flat[k] != null;
  const battingScore =
    (has('batting_average') || has('avg') || has('ba') ? 3 : 0) +
    (has('home_runs') || has('hr') ? 1 : 0) +
    (has('runs_batted_in') || has('rbi') ? 1 : 0) +
    (has('on_base_percentage') || has('obp') ? 1 : 0) +
    (has('slugging_percentage') || has('slg') ? 1 : 0);
  const pitchingScore =
    (has('earned_run_average') || has('era') ? 3 : 0) +
    (has('innings_pitched') || has('ip') ? 2 : 0) +
    (has('wins') || has('w') ? 1 : 0) +
    (has('walks_hits_per_innings_pitched') || has('whip') ? 1 : 0);
  const fieldingScore =
    (has('fielding_percentage') || has('fpct') ? 3 : 0) +
    (has('put_outs') || has('po') ? 1 : 0) +
    (has('assists') || has('a') ? 1 : 0) +
    (has('errors') || has('e') ? 1 : 0);
  const max = Math.max(battingScore, pitchingScore, fieldingScore);
  if (max < 3) return null;
  if (max === pitchingScore) return 'pitching';
  if (max === battingScore) return 'batting';
  return 'fielding';
}

// ---------------------------------------------------------------------------
// Runtime API URL discovery (Strategy B)
// ---------------------------------------------------------------------------
//
// If the fallback map doesn't contain stats data, the stats are fetched
// client-side from a Boost Sport AI API. We discover the URL by:
//   1) Finding the buildId in __NEXT_DATA__
//   2) Fetching `/_next/static/{buildId}/_buildManifest.js`
//   3) Grepping for a `stats-*.js` chunk filename (matching on the
//      filename directly — the previous probe regex used an outer
//      [...array...] matcher that broke on ] inside `[sport]` dynamic
//      route patterns).
//   4) Fetching that chunk and extracting URL string literals that look
//      like backend API endpoints.
//   5) Returning the most promising candidates in priority order.

async function discoverBoostApiUrls(html, nextData) {
  const buildId = nextData?.buildId;
  if (!buildId) return [];
  const manifestUrl = `https://bigten.org/_next/static/${buildId}/_buildManifest.js`;
  let manifestJs;
  try { manifestJs = await fetchText(manifestUrl); }
  catch { return []; }

  // Match the stats chunk filename directly — avoids the [^\]]+ bug
  // that trips on ] inside Next.js dynamic route brackets like [sport].
  const chunkMatches = [...manifestJs.matchAll(/(static\/chunks\/pages\/[^"']*stat[^"']*\.js)/gi)];
  const chunkPaths = [...new Set(chunkMatches.map((m) => m[1]))];
  if (chunkPaths.length === 0) return [];

  const apiUrls = new Set();
  for (const path of chunkPaths.slice(0, 5)) {
    try {
      const chunkUrl = `https://bigten.org/_next/${path}`;
      const js = await fetchText(chunkUrl);
      // Grep for anything that looks like a URL path or full URL leading
      // to a stats endpoint. We keep the net wide and filter later.
      const urlRe = /["'`](https?:\/\/[^"'`\s]*(?:boostsport\.ai|bigten\.org)[^"'`\s]*|\/api\/v[0-9][^"'`\s]*|\/v[0-9]\/[^"'`\s]*)["'`]/g;
      let m;
      while ((m = urlRe.exec(js)) !== null) {
        const u = m[1];
        if (u.length > 400) continue;
        if (/stat|cume|season|batting|pitching|fielding/i.test(u)) apiUrls.add(u);
      }
    } catch {
      /* ignore chunk fetch failures */
    }
  }
  return Array.from(apiUrls);
}

// ---------------------------------------------------------------------------
// Strategy orchestration
// ---------------------------------------------------------------------------

async function fetchAndParsePayload() {
  const html = await fetchText(STATS_URL);
  const nextData = extractNextData(html);
  if (!nextData) throw new Error('B1G stats: __NEXT_DATA__ missing');

  // Strategy A: SSR fallback map scan.
  const fallback = nextData?.props?.pageProps?.fallback || {};
  const fallbackHits = findStatsFallbackKeys(fallback);

  // Build the per-team index from whatever we found.
  // Boost payload names teams as "Minnesota Golden Gophers" (full) but ESPN
  // passes variants like "minnesota" and "minnesota gophers" (no "golden").
  // We index each team under ALL of its normalized name fragments so any
  // reasonable ESPN variant lands on the right entry.
  const teams = new Map();
  const ensureTeam = (displayName, marketName) => {
    if (!displayName) return null;
    const key = normalizeTeamKey(displayName);
    if (!key) return null;
    let t = teams.get(key);
    if (!t) {
      t = {
        key,
        name: displayName,
        totals: { batting: null, pitching: null, fielding: null },
        players: { hitting: [], pitching: [], fielding: [] },
      };
      teams.set(key, t);
    }
    // Also index by the shorter market/location name (e.g. "minnesota") and
    // by each word-prefix that's 4+ chars (e.g. "washington" from "Washington Huskies").
    // This way ESPN variants without the mascot still resolve.
    const extras = new Set();
    if (marketName) extras.add(normalizeTeamKey(marketName));
    // First word of displayName (e.g. "minnesota" from "Minnesota Golden Gophers")
    extras.add(normalizeTeamKey(displayName.split(' ')[0]));
    for (const xk of extras) {
      if (xk && xk.length >= 4 && !teams.has(xk)) teams.set(xk, t);
    }
    return t;
  };

  let matched = 0;
  for (const hit of fallbackHits) {
    const kind = classifyStatsRows(hit.rows); // 'batting' | 'pitching' | 'fielding'
    if (!kind) continue;
    if (hit.kind === 'team') {
      // Team totals rows. One row per Big Ten school.
      for (const row of hit.rows) {
        const flat = flattenRowData(row);
        const displayName = flat.name || flat.market || flat.school || flat.alias;
        const marketName  = flat.market || flat.school || null;
        const t = ensureTeam(displayName, marketName);
        if (!t) continue;
        if (kind === 'batting') t.totals.batting = mapBoostTeamBattingTotals(flat);
        else if (kind === 'pitching') t.totals.pitching = mapBoostTeamPitchingTotals(flat);
        else t.totals.fielding = flat; // fielding passes through unmapped
        matched++;
      }
    } else {
      // Player rows. Each row references a team via market/school/alias.
      for (const row of hit.rows) {
        const flat = flattenRowData(row);
        const displayName =
          flat.team_name || flat.team_market || flat.market ||
          flat.school || flat.team || flat.alias;
        const marketName =
          flat.team_market || flat.market || flat.school || null;
        const t = ensureTeam(displayName, marketName);
        if (!t) continue;
        if (kind === 'batting') {
          const mapped = mapBoostBattingRow(flat, t.name);
          if (mapped?.Player) t.players.hitting.push(mapped);
        } else if (kind === 'pitching') {
          const mapped = mapBoostPitchingRow(flat, t.name);
          if (mapped?.Player) t.players.pitching.push(mapped);
        } else {
          t.players.fielding.push(flat);
        }
        matched++;
      }
    }
  }

  // Strategy B: API URL discovery. Only run if strategy A found nothing
  // — runtime chunk-grepping is expensive and we don't want to do it on
  // every cold cache.
  let discoveredUrls = null;
  if (matched === 0) {
    discoveredUrls = await discoverBoostApiUrls(html, nextData);
    // Best-effort: try each discovered URL until one returns JSON we can
    // recognize as Boost stats data. We don't know the exact query string
    // params, so we try a few common ones alongside.
    const sport = 'sb';
    const season = new Date().getUTCMonth() >= 7
      ? new Date().getUTCFullYear() + 1
      : new Date().getUTCFullYear();
    const expansions = (u) => {
      const withQ = u.includes('?');
      const sep = withQ ? '&' : '?';
      return [
        u,
        `${u}${sep}sport=${sport}&season=${season}`,
        `${u}${sep}sport_alias=${sport}&season=${season}`,
        `${u}${sep}conference_alias=b1g&sport=${sport}&season=${season}`,
      ];
    };
    const candidates = [];
    for (const u of discoveredUrls || []) {
      candidates.push(...expansions(u));
    }
    for (const url of candidates.slice(0, 20)) {
      const absolute = url.startsWith('http') ? url : `https://b1gbeprod.boostsport.ai${url}`;
      const json = await fetchJsonMaybe(absolute);
      const rows = Array.isArray(json) ? json
        : Array.isArray(json?.data) ? json.data
        : null;
      if (!rows || rows.length === 0) continue;
      const flat = flattenRowData(rows[0]);
      if (countStatFields(flat) < 2) continue;
      const kind = classifyStatsRows(rows);
      if (!kind) continue;
      for (const row of rows) {
        const rflat = flattenRowData(row);
        const displayName =
          rflat.team_name || rflat.team_market || rflat.market ||
          rflat.school || rflat.team || rflat.alias;
        const marketName =
          rflat.team_market || rflat.market || rflat.school || null;
        const isPlayer = !!(rflat.first_name || rflat.last_name || rflat.player_name);
        const t = ensureTeam(displayName, marketName);
        if (!t) continue;
        if (isPlayer) {
          if (kind === 'batting') {
            const mapped = mapBoostBattingRow(rflat, t.name);
            if (mapped?.Player) t.players.hitting.push(mapped);
          } else if (kind === 'pitching') {
            const mapped = mapBoostPitchingRow(rflat, t.name);
            if (mapped?.Player) t.players.pitching.push(mapped);
          }
        } else {
          if (kind === 'batting') t.totals.batting = mapBoostTeamBattingTotals(rflat);
          else if (kind === 'pitching') t.totals.pitching = mapBoostTeamPitchingTotals(rflat);
        }
      }
    }
  }

  return {
    conference: 'Big Ten',
    sourceUrl: STATS_URL,
    teams,
    meta: {
      fallbackHits: fallbackHits.length,
      discoveredUrls: discoveredUrls ? discoveredUrls.length : 0,
      teamCount: teams.size,
    },
  };
}

async function getPayloadCached() {
  if (payloadCache && Date.now() - payloadCacheAt < TTL_MS) return payloadCache;
  if (payloadInFlight) return payloadInFlight;
  payloadInFlight = (async () => {
    try {
      const payload = await fetchAndParsePayload();
      payloadCache = payload;
      payloadCacheAt = Date.now();
      return payload;
    } finally {
      payloadInFlight = null;
    }
  })();
  return payloadInFlight;
}

// ---------------------------------------------------------------------------
// Hardcoded alias map — ESPN name variant → Boost payload normalizeTeamKey.
//
// Boost names all Big Ten teams as "School Mascot" (full name, e.g.
// "Minnesota Golden Gophers") while ESPN uses shorter forms ("Minnesota
// Gophers", "Minnesota"). normalizeTeamKey strips spaces, so the keys below
// must be the ALL-LOWERCASE NO-SPACE form of the Boost full name.
//
// Verified 2026-04-11 against bigten.org/sb/stats/ __NEXT_DATA__.
// ---------------------------------------------------------------------------
const BIG10_ALIAS_MAP = {
  // Illinois
  'illinois':               'illinoisfightingillini',
  'illinoisillini':         'illinoisfightingillini',
  'illinoisfightingillini': 'illinoisfightingillini',
  'fightingillini':         'illinoisfightingillini',
  // Indiana
  'indiana':                'indianahoosiers',
  'indianahoosiers':        'indianahoosiers',
  'hoosiers':               'indianahoosiers',
  // Iowa
  'iowa':                   'iowahawkeyes',
  'iowahawkeyes':           'iowahawkeyes',
  'hawkeyes':               'iowahawkeyes',
  // Maryland
  'maryland':               'marylandterrapins',
  'marylandterrapins':      'marylandterrapins',
  'terrapins':              'marylandterrapins',
  'terps':                  'marylandterrapins',
  // Michigan
  'michigan':               'michiganwolverines',
  'michiganwolverines':     'michiganwolverines',
  'wolverines':             'michiganwolverines',
  // Michigan State
  'michiganstate':          'michiganstatespartans',
  'michiganstatespartans':  'michiganstatespartans',
  'spartans':               'michiganstatespartans',
  // Minnesota
  'minnesota':              'minnesotagoldengophers',
  'minnesotagophers':       'minnesotagoldengophers',
  'minnesotagoldengophers': 'minnesotagoldengophers',
  'goldengophers':          'minnesotagoldengophers',
  'gophers':                'minnesotagoldengophers',
  // Nebraska
  'nebraska':               'nebraskahuskers',
  'nebraskacornhuskers':    'nebraskahuskers',
  'nebraskahuskers':        'nebraskahuskers',
  'huskers':                'nebraskahuskers',
  'cornhuskers':            'nebraskahuskers',
  // Northwestern
  'northwestern':           'northwesternwildcats',
  'northwesternwildcats':   'northwesternwildcats',
  // Ohio State
  'ohiostate':              'ohiostatebuckeyes',
  'ohiostatebuckeyes':      'ohiostatebuckeyes',
  'buckeyes':               'ohiostatebuckeyes',
  // Oregon
  'oregon':                 'oregonducks',
  'oregonducks':            'oregonducks',
  'ducks':                  'oregonducks',
  // Penn State
  'pennstate':              'pennstatenittanylions',
  'pennstatenittanylions':  'pennstatenittanylions',
  'nittanylions':           'pennstatenittanylions',
  // Purdue
  'purdue':                 'purdueboilermakers',
  'purdueboilermakers':     'purdueboilermakers',
  'boilermakers':           'purdueboilermakers',
  // Rutgers
  'rutgers':                'rutgersscarletknights',
  'rutgersscarletknights':  'rutgersscarletknights',
  'scarletknights':         'rutgersscarletknights',
  // UCLA
  'ucla':                   'uclabruins',
  'uclabruins':             'uclabruins',
  'bruins':                 'uclabruins',
  // Washington
  'washington':             'washingtonhuskies',
  'washingtonhuskies':      'washingtonhuskies',
  'huskies':                'washingtonhuskies',
  // Wisconsin
  'wisconsin':              'wisconsinbadgers',
  'wisconsinbadgers':       'wisconsinbadgers',
  'badgers':                'wisconsinbadgers',
};

// Public API. Accepts either a single name or an array of name variants,
// returns the same shape as the Big 12 / ACC / SEC stats fetchers.
export async function getBig10TeamStats(nameVariants) {
  const variants = Array.isArray(nameVariants) ? nameVariants : [nameVariants];
  const keys = new Set(variants.map(normalizeTeamKey).filter(Boolean));
  if (keys.size === 0) return null;
  let payload;
  try {
    payload = await getPayloadCached();
  } catch {
    return null;
  }

  let match = null;

  // 1. Exact key match against the dynamically-built teams map.
  for (const [k, t] of payload.teams) {
    if (keys.has(k)) { match = t; break; }
  }

  // 2. Alias map: deterministic ESPN variant → Boost full-name key.
  //    Runs before prefix scan to avoid false positives (e.g. "michigan"
  //    prefix-matching "michiganstate").
  if (!match) {
    for (const qk of keys) {
      const aliasKey = BIG10_ALIAS_MAP[qk];
      if (aliasKey) {
        match = payload.teams.get(aliasKey) || null;
        if (match) break;
      }
    }
  }

  // 3. Prefix fallback for any future teams not yet in the alias map.
  if (!match) {
    outer: for (const [k, t] of payload.teams) {
      for (const qk of keys) {
        if (k.startsWith(qk) || qk.startsWith(k)) { match = t; break outer; }
      }
    }
  }

  if (!match) return null;
  return {
    key: match.key,
    name: match.name,
    conference: 'Big Ten',
    totals: match.totals,
    players: match.players,
    sourceUrl: payload.sourceUrl,
  };
}
