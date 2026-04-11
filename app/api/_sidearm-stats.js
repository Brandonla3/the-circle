// Shared Sidearm Sports conference stats scraper.
//
// Sidearm powers big12sports.com and theacc.com (and many others). Each
// conference's softball stats live at a single server-rendered page:
//
//   {origin}/stats.aspx?path=softball&year=YYYY
//
// The page contains ~100 <table> elements, but the six we care about are
// identified by their <caption>:
//
//   "Overall Batting Stats"      — per-team batting totals (1 row per team)
//   "Overall Pitching Stats"     — per-team pitching totals
//   "Overall Field Stats"        — per-team fielding totals
//   "Individual Hitting Stats"   — per-player hitting (all players, full roster)
//   "Individual Pitching Stats"  — per-player pitching
//   "Individual Fielding Stats"  — per-player fielding
//
// The remaining 90+ tables are narrow per-stat leaderboards (Batting
// Average, Hits, Home Runs, etc.) which duplicate data from the six
// above. We ignore them.
//
// Team rows have the team name in the second column. Player rows have
// the player name in the format "Last, First (Full Team Name)" or
// "First Last (Full Team Name)"; we split on the trailing "(Team)"
// suffix to group players under their team.
//
// This file is NOT a route — Next.js only treats literal route.js files
// as HTTP endpoints, so this helper module lives safely alongside them.

import { normalizeTeamKey } from './_wmt.js';

const TTL_MS = 15 * 60 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TheCircle/1.0)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Captions (lowercased) we care about → internal table key.
const TARGET_CAPTIONS = {
  'overall batting stats':     'teamBatting',
  'overall pitching stats':    'teamPitching',
  'overall field stats':       'teamFielding',
  'overall fielding stats':    'teamFielding', // alt spelling
  'individual hitting stats':  'playerBatting',
  'individual batting stats':  'playerBatting', // alt spelling
  'individual pitching stats': 'playerPitching',
  'individual fielding stats': 'playerFielding',
};

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse the six target tables out of the raw HTML. Returns a map of
// internal key → { headers: string[], rows: Record<string,string>[] }.
// Tables are matched by caption (case-insensitive); extra tables are
// skipped and a target key is only filled once (first-match wins).
function parseSidearmTables(html) {
  const out = {};
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const inner = m[1];
    const capMatch = inner.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    if (!capMatch) continue;
    const caption = stripTags(capMatch[1]).toLowerCase();
    const target = TARGET_CAPTIONS[caption];
    if (!target || out[target]) continue;

    // Headers from thead (first <tr>).
    const theadMatch = inner.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
    const headers = [];
    if (theadMatch) {
      const firstRowMatch = theadMatch[1].match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
      const firstRow = firstRowMatch ? firstRowMatch[1] : theadMatch[1];
      const thRe = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
      let tm;
      while ((tm = thRe.exec(firstRow)) !== null) {
        headers.push(stripTags(tm[1]));
      }
    }

    // Rows from tbody.
    const tbodyMatch = inner.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    const rows = [];
    if (tbodyMatch) {
      const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let trm;
      while ((trm = trRe.exec(tbodyMatch[1])) !== null) {
        const cells = [];
        const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let tdm;
        while ((tdm = tdRe.exec(trm[1])) !== null) {
          cells.push(stripTags(tdm[1]));
        }
        if (cells.length === 0) continue;
        const obj = {};
        for (let i = 0; i < headers.length && i < cells.length; i++) {
          obj[headers[i]] = cells[i];
        }
        rows.push(obj);
      }
    }

    out[target] = { headers, rows };
  }
  return out;
}

// Parse "Last, First (Team)" or "First Last (Team)" → { name, team }.
// The name is flipped to "First Last" for consistent display with the
// rest of the app. Returns { name: raw, team: null } when no trailing
// "(Team)" suffix is present.
function parsePlayerNameAndTeam(raw) {
  if (!raw) return { name: '', team: null };
  const m = String(raw).match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { name: String(raw).trim(), team: null };
  let name = m[1].trim();
  const team = m[2].trim();
  const commaMatch = name.match(/^([^,]+),\s*(.+)$/);
  if (commaMatch) {
    name = `${commaMatch[2].trim()} ${commaMatch[1].trim()}`;
  }
  return { name, team };
}

// Group the parsed tables into a per-team Map so a single team lookup
// can pull totals + players in one shot.
function buildPerTeamIndex(parsed) {
  const teams = new Map();
  const ensureTeam = (displayName) => {
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
    return t;
  };

  for (const row of parsed.teamBatting?.rows || []) {
    const t = ensureTeam(row['Team']);
    if (t) t.totals.batting = row;
  }
  for (const row of parsed.teamPitching?.rows || []) {
    const t = ensureTeam(row['Team']);
    if (t) t.totals.pitching = row;
  }
  for (const row of parsed.teamFielding?.rows || []) {
    const t = ensureTeam(row['Team']);
    if (t) t.totals.fielding = row;
  }

  const pushPlayer = (sourceKey, destKey) => {
    for (const row of parsed[sourceKey]?.rows || []) {
      const { name, team: teamName } = parsePlayerNameAndTeam(row['Player']);
      const t = ensureTeam(teamName);
      if (!t) continue;
      // Replace the combined "Player (Team)" cell with the clean name so
      // downstream normalizers pick it up via the 'Player'/'Name' labels.
      t.players[destKey].push({ ...row, Player: name, Name: name, Team: teamName });
    }
  };
  pushPlayer('playerBatting',  'hitting');
  pushPlayer('playerPitching', 'pitching');
  pushPlayer('playerFielding', 'fielding');

  return teams;
}

// ---------------------------------------------------------------------------
// Individual school stats pages
// ---------------------------------------------------------------------------
//
// Sidearm school sites (goducks.com, iuhoosiers.com, etc.) expose a
// server-rendered stats page at {origin}/sports/softball/stats. The page
// has one "Batting" table and one "Pitching" table; player names are in
// "Last, First" format with no "(Team)" suffix (only one team per page).
//
// Used as a reliable fallback for Big Ten teams when the Boost API is
// unavailable, and as primary source for schools without a conference
// stats feed.
//
// Returns the same shape as createSidearmStatsFetcher's getTeamStats, or
// null on any error.

const schoolStatsCache = new Map();
const SCHOOL_STATS_TTL = 15 * 60 * 1000;

const SCHOOL_BATTING_CAPS = new Set([
  'batting', 'hitting', 'batting stats', 'hitting stats',
  'cumulative batting stats', 'cumulative hitting stats',
  'overall batting stats',
]);
const SCHOOL_PITCHING_CAPS = new Set([
  'pitching', 'pitching stats', 'cumulative pitching stats',
  'overall pitching stats',
]);

function detectSchoolTableType(headers) {
  const hs = new Set(headers.map((h) => h.toLowerCase()));
  if ((hs.has('era') || hs.has('earned_run_average')) && (hs.has('ip') || hs.has('innings_pitched'))) return 'pitching';
  if (hs.has('avg') || hs.has('ba') || hs.has('obp') || hs.has('ob%') || hs.has('batting_average')) return 'batting';
  return null;
}

// Sum the first integer from a compound cell value ("97-112" → 97) across
// all player rows. Accepts multiple column name candidates (tries in order).
function schoolSumInt(rows, ...cols) {
  let total = 0;
  for (const r of rows) {
    for (const col of cols) {
      const v = r[col];
      if (v == null || v === '' || v === '-') continue;
      const mch = String(v).match(/^(\d+)/);
      if (mch) { total += parseInt(mch[1], 10); break; }
    }
  }
  return total;
}

// Sum IP values handling softball's ".1"/".2" partial-inning notation.
function schoolSumIp(rows) {
  let outs = 0;
  for (const r of rows) {
    const v = r['IP'];
    if (!v) continue;
    const parts = String(v).split('.');
    outs += (parseInt(parts[0], 10) || 0) * 3 + (parseInt(parts[1] || '0', 10) || 0);
  }
  const full = Math.floor(outs / 3);
  const rem = outs % 3;
  return rem === 0 ? `${full}` : `${full}.${rem}`;
}

// Compute a synthetic team batting totals row from individual player rows.
// Returns null when there are no player rows or all counting stats are zero.
function computedBattingTotals(players) {
  if (!players.length) return null;
  const ab = schoolSumInt(players, 'AB');
  if (ab === 0) return null;
  const h   = schoolSumInt(players, 'H');
  const bb  = schoolSumInt(players, 'BB');
  const hr  = schoolSumInt(players, 'HR');
  const rbi = schoolSumInt(players, 'RBI');
  const r   = schoolSumInt(players, 'R');
  const d   = schoolSumInt(players, '2B');
  const t   = schoolSumInt(players, '3B');
  const sb  = schoolSumInt(players, 'SB', 'SB-ATT');
  const hbp = schoolSumInt(players, 'HBP');
  const sf  = schoolSumInt(players, 'SF');

  const fmt3 = (n) => n.toFixed(3).replace(/^0\./, '.');
  const avg = fmt3(h / ab);
  const obpDenom = ab + bb + hbp + sf;
  const obp = obpDenom > 0 ? fmt3((h + bb + hbp) / obpDenom) : '.000';
  const tb  = h + d + 2 * t + 3 * hr;
  const slg = fmt3(tb / ab);

  return {
    AB: String(ab), H: String(h), BB: String(bb), HR: String(hr),
    RBI: String(rbi), R: String(r), '2B': String(d), '3B': String(t),
    SB: String(sb), 'SB-ATT': `${sb}-?`,
    AVG: avg, OBP: obp, SLG: slg,
  };
}

// Compute a synthetic team pitching totals row from individual player rows.
function computedPitchingTotals(players) {
  if (!players.length) return null;
  const ip    = schoolSumIp(players);
  const ipNum = parseFloat(ip);
  if (!ipNum) return null;
  const er  = schoolSumInt(players, 'ER');
  const h   = schoolSumInt(players, 'H');
  const bb  = schoolSumInt(players, 'BB');
  const k   = schoolSumInt(players, 'SO', 'K');
  const w   = schoolSumInt(players, 'W');
  const l   = schoolSumInt(players, 'L');
  const sv  = schoolSumInt(players, 'SV');
  const sho = schoolSumInt(players, 'SHO');
  const r2  = schoolSumInt(players, 'R');

  const era  = ((er * 7) / ipNum).toFixed(2);
  const whip = ((h + bb) / ipNum).toFixed(2);

  return {
    IP: ip, ER: String(er), H: String(h), BB: String(bb), SO: String(k),
    W: String(w), L: String(l), SV: String(sv), SHO: String(sho), R: String(r2),
    ERA: era, WHIP: whip,
  };
}

// Labels (lowercased, exact or prefix) that identify a totals/summary row.
const TOTALS_LABELS = new Set([
  'totals', 'total', 'team', 'season', 'season totals', 'combined',
  'team totals', 'overall', 'overall totals',
]);

function isTotalsName(nameLo) {
  if (TOTALS_LABELS.has(nameLo)) return true;
  if (nameLo.startsWith('team total') || nameLo.startsWith('season total')) return true;
  return false;
}

function parseSchoolStatsHtml(html, teamDisplayName) {
  const totals = { batting: null, pitching: null };
  const players = { hitting: [], pitching: [] };

  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const inner = m[1];
    const capMatch = inner.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const caption = capMatch ? stripTags(capMatch[1]).toLowerCase() : '';

    // Parse headers
    const theadMatch = inner.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
    const headers = [];
    if (theadMatch) {
      const firstRowM = theadMatch[1].match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
      const firstRow = firstRowM ? firstRowM[1] : theadMatch[1];
      const thRe = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
      let tm;
      while ((tm = thRe.exec(firstRow)) !== null) headers.push(stripTags(tm[1]));
    }
    if (headers.length < 3) continue;

    // Determine table type
    let type = SCHOOL_BATTING_CAPS.has(caption) ? 'batting'
             : SCHOOL_PITCHING_CAPS.has(caption) ? 'pitching'
             : detectSchoolTableType(headers);
    if (!type) continue;

    // Skip if already filled from a better-captioned table
    if (type === 'batting' && players.hitting.length > 0) continue;
    if (type === 'pitching' && players.pitching.length > 0) continue;

    // Find the name column header (typically "Player" or second column)
    const nameHeader = headers.find((h) => /^(player|name|athlete)$/i.test(h)) || headers[1];

    // Parse rows from tbody
    const tbodyM = inner.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!tbodyM) continue;
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let trm;
    while ((trm = trRe.exec(tbodyM[1])) !== null) {
      const cells = [];
      const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let tdm;
      while ((tdm = tdRe.exec(trm[1])) !== null) cells.push(stripTags(tdm[1]));
      if (cells.length < 3) continue;
      const obj = {};
      for (let i = 0; i < headers.length && i < cells.length; i++) obj[headers[i]] = cells[i];

      // Totals row detection — expanded label set via isTotalsName()
      const rawName = (obj[nameHeader] || cells[1] || '').trim();
      const nameLo = rawName.toLowerCase();
      if (isTotalsName(nameLo)) {
        if (type === 'batting') totals.batting = obj;
        else totals.pitching = obj;
        continue;
      }
      if (!rawName || /^-+$/.test(rawName)) continue;

      // Flip "Last, First" → "First Last"
      let playerName = rawName;
      if (rawName.includes(',')) {
        const [last, ...rest] = rawName.split(',');
        playerName = `${rest.join(',').trim()} ${last.trim()}`.trim();
      }
      if (!playerName) continue;

      const row = { ...obj, Player: playerName, Name: playerName, Team: teamDisplayName };
      if (type === 'batting') players.hitting.push(row);
      else players.pitching.push(row);
    }
  }

  // Fallback: if no explicit totals row was found but we have player rows,
  // compute team totals by summing counting stats. This handles school pages
  // that omit the totals row or use an unexpected label.
  if (!totals.batting && players.hitting.length > 0) {
    totals.batting = computedBattingTotals(players.hitting);
  }
  if (!totals.pitching && players.pitching.length > 0) {
    totals.pitching = computedPitchingTotals(players.pitching);
  }

  return { totals, players };
}

export async function fetchSchoolSoftballStats(origin, teamDisplayName, conference = 'Big Ten') {
  const cached = schoolStatsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < SCHOOL_STATS_TTL) return cached.data;

  const url = `${origin}/sports/softball/stats`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    let html;
    try {
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(`school stats ${r.status}: ${url}`);
      html = await r.text();
    } finally {
      clearTimeout(t);
    }

    const { totals, players } = parseSchoolStatsHtml(html, teamDisplayName);
    if (players.hitting.length === 0 && players.pitching.length === 0) return null;

    const data = {
      key: normalizeTeamKey(teamDisplayName),
      name: teamDisplayName,
      conference,
      totals,
      players: { hitting: players.hitting, pitching: players.pitching, fielding: [] },
      sourceUrl: url,
    };
    schoolStatsCache.set(origin, { fetchedAt: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

// Pick the year the current softball season belongs to. Season runs Feb–
// June; after August we assume we're looking at the upcoming season (same
// logic the Sidearm schedule scraper uses for its year window).
function currentSeasonYear() {
  const now = new Date();
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 7 ? year + 1 : year;
}

// Factory: returns an async getTeamStats(nameVariants) fn bound to a
// single Sidearm conference. Each caller gets its own module-scope
// cache, so the ACC and Big 12 fetchers never collide and warm-path
// calls skip the upstream entirely (15-min TTL).
export function createSidearmStatsFetcher({ origin, confName, sportPath = 'softball' }) {
  let payloadCache = null;
  let payloadCacheAt = 0;
  let payloadInFlight = null;

  async function fetchAndParse() {
    const year = currentSeasonYear();
    const url = `${origin}/stats.aspx?path=${encodeURIComponent(sportPath)}&year=${year}`;
    const r = await fetch(url, { headers: HEADERS, cache: 'no-store', redirect: 'follow' });
    if (!r.ok) throw new Error(`Sidearm stats ${r.status}: ${url}`);
    const html = await r.text();
    const parsed = parseSidearmTables(html);
    const teams = buildPerTeamIndex(parsed);
    return { conference: confName, sourceUrl: url, teams };
  }

  async function getPayloadCached() {
    if (payloadCache && Date.now() - payloadCacheAt < TTL_MS) return payloadCache;
    if (payloadInFlight) return payloadInFlight;
    payloadInFlight = (async () => {
      try {
        const payload = await fetchAndParse();
        payloadCache = payload;
        payloadCacheAt = Date.now();
        return payload;
      } finally {
        payloadInFlight = null;
      }
    })();
    return payloadInFlight;
  }

  return async function getTeamStats(nameVariants) {
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
    for (const [k, t] of payload.teams) {
      if (keys.has(k)) { match = t; break; }
    }
    if (!match) return null;
    return {
      key: match.key,
      name: match.name,
      conference: confName,
      totals: match.totals,
      players: {
        hitting:  match.players.hitting,
        pitching: match.players.pitching,
        fielding: match.players.fielding,
      },
      sourceUrl: payload.sourceUrl,
    };
  };
}
