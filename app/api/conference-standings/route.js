export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Pull live conference standings directly from each league's own website.
// Every league publishes the data differently — this module encapsulates
// the source-specific fetch+parse and maps every row into the same shape
// that the existing StandingsView already knows how to render.
//
// Output shape (matches /api/standings):
//   {
//     conferences: [{
//       name, abbreviation,
//       headers: ['Conf', 'Conf Pct', 'Overall', 'Pct', 'Home', 'Away', 'Streak', 'L10'],
//       teams: [{ name, logo, stats: [conf, confPct, ovr, ovrPct, home, away, streak, l10] }],
//       source: 'secsports.com' | 'big12sports.com' | 'theacc.com' | 'bigten.org' | 'themw.com',
//       updated: ISO timestamp,
//     }],
//     errors: { [conference]: 'reason' },  // present only if a source failed
//     meta: { elapsedMs }
//   }
//
// Every source is cached at the module level. Warm Vercel instances skip
// the upstream request entirely for 10 minutes. Partial failures don't
// invalidate the whole response — if (say) ACC 502s the other four still
// return, with the ACC entry surfaced under `errors`.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const JSON_HEADERS = { ...HEADERS, 'Accept': 'application/json' };

const TTL_MS = 10 * 60 * 1000;
const sourceCache = new Map(); // conferenceKey -> { fetchedAt, payload }

// Common table headers we want the UI to render. Each source maps into
// this fixed 8-column layout so StandingsView can render mixed conferences
// without needing per-conference logic.
const HEADERS_ROW = ['Conf', 'Conf Pct', 'Overall', 'Pct', 'Home', 'Away', 'Streak', 'L10'];

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

function cached(key) {
  const entry = sourceCache.get(key);
  if (entry && Date.now() - entry.fetchedAt < TTL_MS) return entry.payload;
  return null;
}

function store(key, payload) {
  sourceCache.set(key, { fetchedAt: Date.now(), payload });
  return payload;
}

// Pct formatter that matches NCAA/ESPN style (".857", "1.000", "—").
function fmtPct(w, l) {
  const total = (Number(w) || 0) + (Number(l) || 0);
  if (!total) return '—';
  const p = (Number(w) || 0) / total;
  const s = p.toFixed(3);
  return p >= 1 ? '1.000' : s.replace(/^0/, '');
}

function fmtRecord(w, l) {
  if (w == null && l == null) return '—';
  return `${w ?? 0}-${l ?? 0}`;
}

function fmtStreak(type, count) {
  if (!type || count == null) return '—';
  // Normalize word-form streak types ("win"/"loss") to the single-letter
  // convention the rest of the app uses ("W"/"L"). SEC is the only source
  // that sends word-form today, but the normalization is harmless elsewhere.
  const t = String(type).toLowerCase();
  const letter = t.startsWith('w') ? 'W' : t.startsWith('l') ? 'L' : t.startsWith('t') ? 'T' : String(type)[0].toUpperCase();
  return `${letter}${count}`;
}

// ---------------------------------------------------------------------------
// SEC — secsports.com
// ---------------------------------------------------------------------------
// The standings page is an Inertia.js Vue SPA that lazy-loads data from
// `/api/schedules/{id}/standings`. The schedule id changes each season, so
// we look it up from `/api/schedules` and cache the current id in-memory.

const SEC_SPORT_ID = 10; // softball, pulled from /api/sports

let secScheduleIdCache = null;
let secScheduleIdAt = 0;

async function getSecScheduleId() {
  if (secScheduleIdCache && Date.now() - secScheduleIdAt < TTL_MS) return secScheduleIdCache;
  const r = await fetchWithTimeout('https://www.secsports.com/api/schedules?per_page=100', { headers: JSON_HEADERS });
  if (!r.ok) throw new Error(`SEC schedules HTTP ${r.status}`);
  const j = await r.json();
  const softball = (j.data || []).filter((d) => d.sport_id === SEC_SPORT_ID);
  // Prefer the current flagged schedule; fall back to the most recent.
  const current = softball.find((d) => d.current) || softball.sort((a, b) => b.id - a.id)[0];
  if (!current) throw new Error('SEC: no softball schedule found');
  secScheduleIdCache = current.id;
  secScheduleIdAt = Date.now();
  return current.id;
}

async function fetchSEC() {
  const hit = cached('sec'); if (hit) return hit;
  const scheduleId = await getSecScheduleId();
  const url = `https://www.secsports.com/api/schedules/${scheduleId}/standings?include[]=school.logo`;
  const r = await fetchWithTimeout(url, { headers: JSON_HEADERS });
  if (!r.ok) throw new Error(`SEC standings HTTP ${r.status}`);
  const j = await r.json();
  const rows = (j.data || []).map((row) => {
    const school = row.school || {};
    // SEC attaches a full school name like "Oklahoma Sooners". Strip
    // trailing mascot terms when they look like mascots so the display
    // matches the other conferences. Keep it simple — any trailing word
    // after a space that isn't part of a known city/region pair is dropped.
    const name = (school.short_name || school.name || '').replace(/\s+(Sooners|Tigers|Gators|Bulldogs|Volunteers|Aggies|Wildcats|Rebels|Razorbacks|Commodores|Crimson Tide|Gamecocks|Cardinals|Longhorns)$/i, '').trim() || school.name;
    return {
      name: name || school.name,
      logo: school.logo?.src || null,
      stats: [
        fmtRecord(row.conference_wins, row.conference_loses),
        row.conference_win_pct != null ? String(row.conference_win_pct).replace(/^0/, '') : fmtPct(row.conference_wins, row.conference_loses),
        fmtRecord(row.overall_wins, row.overall_loses),
        row.overall_win_pct != null ? String(row.overall_win_pct).replace(/^0/, '') : fmtPct(row.overall_wins, row.overall_loses),
        fmtRecord(row.home_wins, row.home_loses),
        fmtRecord(row.road_wins, row.road_loses),
        fmtStreak(row.streak_type, row.streak),
        '—',
      ],
      // Sort key that the outer wrapper can use for ordering.
      _sort: [-(Number(row.conference_wins) || 0), (Number(row.conference_loses) || 0)],
    };
  });
  // Sort by conf wins desc, then conf losses asc.
  rows.sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1]);
  rows.forEach((r) => delete r._sort);
  const payload = {
    name: 'SEC',
    abbreviation: 'SEC',
    headers: HEADERS_ROW,
    teams: rows,
    source: 'secsports.com',
    updated: new Date().toISOString(),
  };
  return store('sec', payload);
}

// ---------------------------------------------------------------------------
// Big Ten — bigten.org
// ---------------------------------------------------------------------------
// Next.js SSR page with the full standings payload embedded in the
// `__NEXT_DATA__` script tag. No network call required beyond the HTML fetch.

async function fetchBigTen() {
  const hit = cached('btn'); if (hit) return hit;
  const year = new Date().getFullYear();
  const url = `https://bigten.org/sb/standings/${year}/`;
  const r = await fetchWithTimeout(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`Big Ten HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Big Ten: __NEXT_DATA__ missing');
  const data = JSON.parse(m[1]);
  const fallback = data?.props?.pageProps?.fallback || {};
  const standingsKey = Object.keys(fallback).find((k) => k.includes('standings/table'));
  if (!standingsKey) throw new Error('Big Ten: no standings/table key in fallback');
  const standings = fallback[standingsKey]?.data || [];
  // Each row has a `data` array of single-key objects — flatten them.
  const rows = standings.map((row) => {
    const s = Object.assign({}, ...(row.data || []));
    return {
      name: row.market || row.alias || '',
      logo: null,
      stats: [
        s.conf_record || '—',
        s.conf_pct || '—',
        s.ovr_record || '—',
        s.ovr_pct || '—',
        s.home_record || s.conf_home_record || '—',
        s.away_record || s.conf_away_record || '—',
        s.streak || s.conf_streak || '—',
        s.last10_record || '—',
      ],
      _rank: Number(row.team_rank) || 999,
    };
  });
  rows.sort((a, b) => a._rank - b._rank);
  rows.forEach((r) => delete r._rank);
  const payload = {
    name: 'Big Ten',
    abbreviation: 'B1G',
    headers: HEADERS_ROW,
    teams: rows,
    source: 'bigten.org',
    updated: new Date().toISOString(),
  };
  return store('btn', payload);
}

// ---------------------------------------------------------------------------
// Mountain West — themw.com
// ---------------------------------------------------------------------------
// WordPress site with a custom REST endpoint at /wp-json/v1/standings. The
// sport category id (21) and default season term id are baked into the
// <standings-page> element on the standings page itself — we parse them
// from HTML once per TTL so a season rollover doesn't require a redeploy.

const MW_SPORT_CATEGORY = 21; // softball, stable since 2013

let mwSeasonCache = null;
let mwSeasonAt = 0;

async function getMwSeasonId() {
  if (mwSeasonCache && Date.now() - mwSeasonAt < TTL_MS) return mwSeasonCache;
  const r = await fetchWithTimeout('https://themw.com/standings/sport/softball/', { headers: HEADERS });
  if (!r.ok) throw new Error(`MW page HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/default-season="(\d+)"/);
  if (!m) throw new Error('MW: default-season attribute missing');
  mwSeasonCache = m[1];
  mwSeasonAt = Date.now();
  return m[1];
}

async function fetchMW() {
  const hit = cached('mw'); if (hit) return hit;
  const seasonId = await getMwSeasonId();
  const url = `https://themw.com/wp-json/v1/standings?sport_category=${MW_SPORT_CATEGORY}&season=${seasonId}`;
  const r = await fetchWithTimeout(url, { headers: JSON_HEADERS });
  if (!r.ok) throw new Error(`MW standings HTTP ${r.status}`);
  const j = await r.json();
  const rows = (j.data || []).map((row) => {
    const school = row.school || {};
    return {
      name: school.name || '',
      logo: school.logo?.url || null,
      stats: [
        fmtRecord(row.conference_wins, row.conference_loses),
        row.conference_wins_pct ? String(row.conference_wins_pct).replace(/^0/, '') : fmtPct(row.conference_wins, row.conference_loses),
        fmtRecord(row.overall_wins, row.overall_loses),
        row.overall_wins_pct ? String(row.overall_wins_pct).replace(/^0/, '') : fmtPct(row.overall_wins, row.overall_loses),
        '—',
        '—',
        fmtStreak(row.streak_type, row.streak),
        '—',
      ],
      _rank: Number(row.conference_rank) || 999,
    };
  });
  rows.sort((a, b) => a._rank - b._rank);
  rows.forEach((r) => delete r._rank);
  const payload = {
    name: 'Mountain West',
    abbreviation: 'MW',
    headers: HEADERS_ROW,
    teams: rows,
    source: 'themw.com',
    updated: new Date().toISOString(),
  };
  return store('mw', payload);
}

// ---------------------------------------------------------------------------
// Big 12 and ACC — SIDEARM Sports CMS HTML tables
// ---------------------------------------------------------------------------
// Both sites are server-rendered with `<table class="sidearm-standings-table">`
// and duplicate every cell for responsive layouts (one `hide-on-large` and
// one `hide-on-medium-down`). We take the `hide-on-medium-down` cells in
// order — those are the full-width desktop cells — and map them positionally.
//
// Column order varies slightly between the two sites, so each parser passes
// its own field-index map. We deliberately do NOT use a full HTML parser
// here — the tables are trivially regular and a small HTML-tag stripper is
// all we need.

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull the logo href out of a `<td>` cell's `<img>`, if any.
function extractLogoFromTd(html) {
  const m = html.match(/<img[^>]*src=['"]([^'"]+)['"]/);
  if (!m) return null;
  const src = m[1];
  if (src.startsWith('http')) return src;
  return src; // callers will prefix with the origin
}

// Given a full HTML document, return the first `<table>` whose opening tag
// contains `sidearm-standings-table`. Returns the inner HTML (between tbody
// tags) or the full <table>…</table> block if tbody is absent.
function extractSidearmTable(html) {
  const tableMatch = html.match(/<table[^>]*class="[^"]*sidearm-standings-table[^"]*"[\s\S]*?<\/table>/);
  if (!tableMatch) return null;
  const table = tableMatch[0];
  const tbodyMatch = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  return tbodyMatch ? tbodyMatch[1] : table;
}

// Iterate `<tr>` blocks in a tbody fragment.
function iterRows(tbodyHtml) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(tbodyHtml))) rows.push(m[1]);
  return rows;
}

// Pull cells with the `hide-on-medium-down` class from a row — these are
// the full desktop-layout cells, which contain every column.
function extractDesktopCells(rowHtml) {
  const cells = [];
  const tdRe = /<td[^>]*class="[^"]*hide-on-medium-down[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = tdRe.exec(rowHtml))) cells.push(m[1]);
  return cells;
}

async function fetchSidearm({ url, origin, conferenceName, abbreviation, columnMap, key }) {
  const hit = cached(key); if (hit) return hit;
  const r = await fetchWithTimeout(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${conferenceName} HTTP ${r.status}`);
  const html = await r.text();
  const tbody = extractSidearmTable(html);
  if (!tbody) throw new Error(`${conferenceName}: standings table missing`);
  const rowHtmls = iterRows(tbody);
  const teams = [];
  for (const rowHtml of rowHtmls) {
    const cells = extractDesktopCells(rowHtml);
    if (cells.length === 0) continue;
    // The first desktop cell is the team cell — it contains the logo <img>
    // and a text anchor for the school name. Parse both out of the raw HTML.
    const teamCellHtml = cells[0];
    const logoRaw = extractLogoFromTd(teamCellHtml);
    const logo = logoRaw
      ? (logoRaw.startsWith('http') ? logoRaw : `${origin}${logoRaw.startsWith('/') ? '' : '/'}${logoRaw}`)
      : null;
    const name = stripTags(teamCellHtml);
    // Map the remaining cells into the fixed 8-column display row.
    const get = (idx) => (idx != null && cells[idx] != null ? stripTags(cells[idx]) : '—');
    teams.push({
      name,
      logo,
      stats: [
        get(columnMap.confRec),
        get(columnMap.confPct),
        get(columnMap.ovrRec),
        get(columnMap.ovrPct),
        get(columnMap.home),
        get(columnMap.away),
        get(columnMap.streak),
        get(columnMap.last10),
      ],
    });
  }
  const payload = {
    name: conferenceName,
    abbreviation,
    headers: HEADERS_ROW,
    teams,
    source: new URL(url).hostname,
    updated: new Date().toISOString(),
  };
  return store(key, payload);
}

async function fetchBig12() {
  // Big 12 hide-on-medium-down cell order (seen on live page):
  //   0 team, 1 confRec, 2 confPct, 3 confHome, 4 confAway, 5 confStreak,
  //   6 ovrRec, 7 ovrPct, 8 ovrHome, 9 ovrAway, 10 ovrNeutral, 11 ovrStreak
  return fetchSidearm({
    url: 'https://big12sports.com/standings.aspx?path=softball',
    origin: 'https://big12sports.com',
    conferenceName: 'Big 12',
    abbreviation: 'Big 12',
    columnMap: {
      confRec: 1, confPct: 2,
      ovrRec: 6, ovrPct: 7,
      home: 8, away: 9,
      streak: 11, last10: null,
    },
    key: 'big12',
  });
}

async function fetchACC() {
  // ACC hide-on-medium-down cell order:
  //   0 team, 1 confRec, 2 confPct, 3 confRsRa, 4 confHome, 5 confAway, 6 confStreak,
  //   7 ovrRec, 8 ovrPct, 9 ovrRsRa, 10 ovrHome, 11 ovrAway, 12 ovrNeutral, 13 ovrLast10, 14 ovrStreak
  return fetchSidearm({
    url: 'https://theacc.com/standings.aspx?path=softball',
    origin: 'https://theacc.com',
    conferenceName: 'ACC',
    abbreviation: 'ACC',
    columnMap: {
      confRec: 1, confPct: 2,
      ovrRec: 7, ovrPct: 8,
      home: 10, away: 11,
      streak: 14, last10: 13,
    },
    key: 'acc',
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const only = (searchParams.get('only') || '').toLowerCase();
  const debug = searchParams.get('debug');

  const sources = [
    { key: 'sec',    run: fetchSEC },
    { key: 'big12',  run: fetchBig12 },
    { key: 'acc',    run: fetchACC },
    { key: 'btn',    run: fetchBigTen },
    { key: 'mw',     run: fetchMW },
  ];
  const enabled = only ? sources.filter((s) => s.key === only) : sources;

  const started = Date.now();
  const results = await Promise.all(
    enabled.map((s) => s.run().then(
      (payload) => ({ key: s.key, ok: true, payload }),
      (err) => ({ key: s.key, ok: false, error: err?.message || String(err) }),
    )),
  );
  const elapsedMs = Date.now() - started;

  const conferences = [];
  const errors = {};
  for (const r of results) {
    if (r.ok) conferences.push(r.payload);
    else errors[r.key] = r.error;
  }

  const body = {
    conferences,
    errors: Object.keys(errors).length ? errors : undefined,
    meta: {
      elapsedMs,
      sources: results.map((r) => ({ key: r.key, ok: r.ok, error: r.ok ? undefined : r.error })),
      generatedAt: new Date().toISOString(),
    },
  };

  if (debug) {
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json(body, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  });
}
