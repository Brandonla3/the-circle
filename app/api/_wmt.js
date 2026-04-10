// Shared helpers for scraping wmt.games conference stats pages.
//
// WMT Games powers the in-iframe stats widgets on several major softball
// conference sites (SEC and Mountain West, at least). Each conference
// page is a Nuxt 3 SSR route at wmt.games/conference/{slug}/{ncaaSeasonId}
// and the entire dataset is embedded in the `<script id="__NUXT_DATA__">`
// hydration blob — no XHR, no auth. This module:
//
//   1) parses the Nuxt devalue payload format,
//   2) extracts the stats-table shapes WMT uses (Overall/Individual/…),
//   3) normalizes rows into {columnLabel: value} objects so the UI can
//      render any column without knowing WMT's opaque "column-N" keys,
//   4) groups the Individual tables by team so a single per-team view
//      can stitch every stat together.
//
// This file is NOT a route — Next.js only treats literal `route.js`
// files as HTTP endpoints, so a plain helper file lives safely next
// to the routes that import it.

// ---------------------------------------------------------------------------
// Nuxt 3 devalue parser
// ---------------------------------------------------------------------------
//
// Nuxt 3 uses `devalue` to serialize SSR state: a flat array where the
// root is element 0 and every other element is either a primitive or a
// reference to another element by integer index. Objects store their
// values as {key: indexRef} maps; arrays store each slot as an indexRef
// (when it's a number) or a literal (when it's a string/null/etc).
//
// A small handful of leading strings are reserved markers for special
// wrappers (Reactive/ShallowReactive/Ref/Date/…). For our read-only
// scraping use-case we only need to unwrap the reactivity markers and
// Dates — everything else we encounter is a plain object or array.
//
// The resolver memoizes by index and installs the output container in
// the memo BEFORE recursing so cyclic graphs terminate. Nuxt's pinia
// state is a graph (not a tree) because many objects reference the
// same sport/season/team records.

const DEVALUE_WRAPPERS = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'Object', 'NoSerialize']);

export function parseDevalue(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(data)) throw new Error('devalue: root must be an array');
  const memo = new Map();

  function resolve(idx) {
    if (memo.has(idx)) return memo.get(idx);
    const v = data[idx];
    if (v === null || typeof v !== 'object') {
      memo.set(idx, v);
      return v;
    }
    if (Array.isArray(v)) {
      // Reactivity / identity wrappers: ["Reactive", <innerIdx>] etc.
      if (v.length === 2 && typeof v[0] === 'string' && DEVALUE_WRAPPERS.has(v[0])) {
        const target = resolve(v[1]);
        memo.set(idx, target);
        return target;
      }
      if (v.length === 2 && v[0] === 'Date') {
        const raw = data[v[1]];
        const d = new Date(raw);
        memo.set(idx, d);
        return d;
      }
      const out = [];
      memo.set(idx, out);
      for (const el of v) {
        if (typeof el === 'number') out.push(resolve(el));
        else out.push(el);
      }
      return out;
    }
    const out = {};
    memo.set(idx, out);
    for (const [k, ref] of Object.entries(v)) {
      if (typeof ref === 'number') out[k] = resolve(ref);
      else out[k] = ref;
    }
    return out;
  }

  return resolve(0);
}

export function extractNuxtData(html) {
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NUXT_DATA__ script not found');
  return parseDevalue(m[1]);
}

// ---------------------------------------------------------------------------
// Table normalization
// ---------------------------------------------------------------------------
//
// WMT's table shape is:
//   {
//     title: 'Batting',
//     head: [{key, label, helpText, type, sortable, fixed}, ...],
//     body: [[{value, sortValue, key, hidden}, ...], ...]
//   }
//
// Many `head.key` values are opaque placeholders like "column-4" /
// "column-5". Labels, on the other hand, are the short human-readable
// column names (AVG, AB, HR…) that we want to render directly. We key
// the output by label so the UI doesn't need to know about the opaque
// keys, and we keep the helpText and column type alongside so we can
// render tooltips + align numerics.

export function normalizeWmtTable(tbl) {
  const headEntries = (tbl?.head || []).map((h) => ({
    label: h.label,
    key: h.key,
    helpText: h.helpText || null,
    type: h.type || null,
    sortable: !!h.sortable,
  }));
  const keyToLabel = new Map(headEntries.map((h) => [h.key, h.label]));

  const rows = (tbl?.body || []).map((row) => {
    const obj = {};
    if (!Array.isArray(row)) return obj;
    for (const cell of row) {
      const label = keyToLabel.get(cell?.key);
      if (label == null) continue;
      // Prefer `value` (the display string, e.g. ".428" with leading
      // dot stripped) over `sortValue` (numeric form). The UI renders
      // strings as-is, which matches how wmt.games presents them.
      obj[label] = cell.value;
      // Also stash the sortValue under a `__sort` sidecar so the UI can
      // sort numerically without re-parsing every cell.
      if (cell.sortValue !== undefined && cell.sortValue !== cell.value) {
        obj.__sort ||= {};
        obj.__sort[label] = cell.sortValue;
      }
    }
    return obj;
  });

  return {
    title: tbl?.title || null,
    columns: headEntries,
    rows,
  };
}

// ---------------------------------------------------------------------------
// End-to-end fetch
// ---------------------------------------------------------------------------
//
// Given a wmt.games conference URL and the Nuxt pinia store key that
// wraps the conference data (format: "conference-teams-{slug}-{id}"),
// fetch the page, parse the hydration blob, and return the normalized
// Overall + Individual tables.
//
// The pinia key format is load-bearing: it's how WMT tags the chunk of
// state that belongs to a specific conference/season combo. The caller
// is responsible for constructing the key because slug naming isn't
// fully derivable from the URL (e.g. 'sec' vs 'secsports').

const WMT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchWmtConferenceStats(url, conferenceKey) {
  const r = await fetchWithTimeout(url, { headers: WMT_HEADERS });
  if (!r.ok) throw new Error(`WMT HTTP ${r.status}`);
  const html = await r.text();
  const nuxt = extractNuxtData(html);
  const container = nuxt?.data?.[conferenceKey];
  if (!container) {
    const keys = Object.keys(nuxt?.data || {});
    throw new Error(`WMT payload missing key "${conferenceKey}". Available: ${keys.join(', ') || 'none'}`);
  }
  const tabs = container.tabs || [];

  // Overall tab: three team-level tables (Batting/Pitching/Fielding),
  // each with one row per team.
  const overall = tabs.find((t) => t?.title === 'Overall');
  const teamTotals = {};
  for (const tbl of overall?.tables || []) {
    const norm = normalizeWmtTable(tbl);
    if (!norm.title) continue;
    teamTotals[norm.title.toLowerCase()] = norm;
  }

  // Individual tab: three child sections (Hitting/Pitching/Fielding),
  // each with one full-roster table.
  const individualTab = tabs.find((t) => t?.title === 'Individual');
  const individual = {};
  for (const child of individualTab?.children || []) {
    const tbl = (child?.tables || [])[0];
    if (!tbl) continue;
    const norm = normalizeWmtTable(tbl);
    individual[(child.title || '').toLowerCase()] = norm;
  }

  return {
    season: container.season || null,
    teamTotals,       // { batting, pitching, fielding } — each a {title, columns, rows} table
    individual,       // { hitting, pitching, fielding } — same shape
    sourceUrl: url,
  };
}

// ---------------------------------------------------------------------------
// Team-name keys
// ---------------------------------------------------------------------------
//
// Match the normalization used in _espn.js so WMT's team strings ("Texas
// A&M") line up with ESPN's team directory without manual aliases.

export function normalizeTeamKey(s) {
  return (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Group the Individual tables by team. Returns a Map keyed by the
// normalized team name, with each entry holding the per-side row lists
// and a `displayName` recovered from the first row we see for that team.

export function groupWmtIndividualByTeam(stats) {
  const groups = new Map();
  for (const side of ['hitting', 'pitching', 'fielding']) {
    const tbl = stats?.individual?.[side];
    if (!tbl) continue;
    for (const row of tbl.rows) {
      const rawName = row['Team'];
      const key = normalizeTeamKey(rawName);
      if (!key) continue;
      let entry = groups.get(key);
      if (!entry) {
        entry = { key, displayName: rawName, hitting: [], pitching: [], fielding: [] };
        groups.set(key, entry);
      }
      entry[side].push(row);
    }
  }
  return groups;
}

// Similar grouping but for the team-level Overall tables — keys by
// team name so a single per-team lookup can pull every Overall row.

export function groupWmtTeamTotals(stats) {
  const groups = new Map();
  for (const side of ['batting', 'pitching', 'fielding']) {
    const tbl = stats?.teamTotals?.[side];
    if (!tbl) continue;
    for (const row of tbl.rows) {
      const rawName = row['Team'];
      const key = normalizeTeamKey(rawName);
      if (!key) continue;
      let entry = groups.get(key);
      if (!entry) {
        entry = { key, displayName: rawName, batting: null, pitching: null, fielding: null };
        groups.set(key, entry);
      }
      entry[side] = row;
    }
  }
  return groups;
}
