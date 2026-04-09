// ESPN team display-name → Sidearm school origin URL.
//
// VERIFIED 2026-04-09 by hitting {origin}/api/v2/sports and confirming
// the response is JSON (not HTML/WMT) AND contains an entry with
// globalSportNameSlug === "softball".
//
// Schools that FAILED validation are intentionally omitted — they either
// run WMT Digital (returns HTML from /api/v2/sports), use Sidearm but
// haven't configured a softball sport, or are on a different platform
// entirely. For those schools the caller falls back to ESPN roster data.
//
// Non-working schools by reason (for future re-checks):
//
//   WMT Digital (HTML response):
//     SEC:     Arkansas, Auburn(*), Kentucky, LSU, South Carolina, Vanderbilt
//     Big 12:  Arizona, Nevada
//     ACC:     California, Georgia Tech, Notre Dame
//     Big Ten: Illinois, Maryland
//     MW:      Nevada, UNLV, Utah State, Wyoming
//
//   Sidearm present but no softball sport configured:
//     Big 12:  Arizona State, BYU, Cincinnati, Colorado, Kansas State,
//              TCU, UCF, West Virginia
//     ACC:     Clemson, Stanford, Virginia, Virginia Tech
//     Big Ten: Iowa, Nebraska, Penn State, Purdue, USC
//     MW:      Air Force, New Mexico, SDSU, San Jose State
//
// (*) Auburn returns Sidearm JSON but an empty sports array — misconfigured.
//
// Keys are lowercased, diacritic-stripped ESPN displayName values.
// getSidearmOrigin() matches case-insensitively; see that function below.
//
// Origins are the bare https://... root — no trailing slash.

// ── SEC (10 confirmed) ────────────────────────────────────────────────────────
const SEC_ORIGINS = {
  'alabama':            'https://rolltide.com',         // sportId=9
  'florida':            'https://floridagators.com',    // sportId=30
  'georgia':            'https://georgiadogs.com',      // sportId=13
  'mississippi state':  'https://hailstate.com',        // sportId=8
  'missouri':           'https://mutigers.com',         // sportId=9
  'oklahoma':           'https://soonersports.com',     // sportId=10
  'ole miss':           'https://olemisssports.com',    // sportId=8
  'tennessee':          'https://utsports.com',         // sportId=12
  'texas':              'https://texassports.com',      // sportId=10
  'texas a&m':          'https://12thman.com',          // sportId=11
};

// ── Big 12 (7 confirmed) ──────────────────────────────────────────────────────
const BIG12_ORIGINS = {
  'baylor':             'https://baylorbears.com',      // sportId=11
  'houston':            'https://uhcougars.com',        // sportId=7
  'iowa state':         'https://cyclones.com',         // sportId=7
  'kansas':             'https://kuathletics.com',      // sportId=8
  'oklahoma state':     'https://okstate.com',          // sportId=10
  'texas tech':         'https://texastech.com',        // sportId=9
  'utah':               'https://utahutes.com',         // sportId=10
};

// ── ACC (8 confirmed) ─────────────────────────────────────────────────────────
const ACC_ORIGINS = {
  'boston college':     'https://bceagles.com',         // sportId=19
  'duke':               'https://goduke.com',           // sportId=13
  'florida state':      'https://seminoles.com',        // sportId=11
  'louisville':         'https://gocards.com',          // sportId=12
  'nc state':           'https://gopack.com',           // sportId=13
  'north carolina':     'https://goheels.com',          // sportId=14
  'pitt':               'https://pittsburghpanthers.com', // sportId=11
  'syracuse':           'https://cuse.com',             // sportId=16
};

// ── Big Ten (10 confirmed) ────────────────────────────────────────────────────
const BIG10_ORIGINS = {
  'indiana':            'https://iuhoosiers.com',       // sportId=12
  'michigan':           'https://mgoblue.com',          // sportId=17
  'michigan state':     'https://msuspartans.com',      // sportId=12
  'minnesota':          'https://gophersports.com',     // sportId=12
  'northwestern':       'https://nusports.com',         // sportId=9
  'ohio state':         'https://ohiostatebuckeyes.com', // sportId=30
  'oregon':             'https://goducks.com',          // sportId=10
  'ucla':               'https://uclabruins.com',       // sportId=12
  'washington':         'https://gohuskies.com',        // sportId=12
  'wisconsin':          'https://uwbadgers.com',        // sportId=12
};

// ── Mountain West (3 confirmed) ───────────────────────────────────────────────
const MW_ORIGINS = {
  'boise state':        'https://broncosports.com',     // sportId=9
  'colorado state':     'https://csurams.com',          // sportId=15
  'fresno state':       'https://gobulldogs.com',       // sportId=10
};

// Merge into one flat lookup.
const ORIGIN_MAP = {
  ...SEC_ORIGINS,
  ...BIG12_ORIGINS,
  ...ACC_ORIGINS,
  ...BIG10_ORIGINS,
  ...MW_ORIGINS,
};

// Normalize helper — matches the `normalize` fn in _espn.js without importing it.
function norm(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Return the Sidearm origin for a given set of ESPN name variants, or null.
// Tries exact match first, then substring fallback for decorated names like
// "Florida State Seminoles" → "florida state".
export function getSidearmOrigin(nameVariantSet) {
  for (const v of nameVariantSet) {
    const n = norm(v);
    if (ORIGIN_MAP[n]) return ORIGIN_MAP[n];
  }
  // Substring fallback
  for (const v of nameVariantSet) {
    const n = norm(v);
    for (const [key, origin] of Object.entries(ORIGIN_MAP)) {
      if (n.includes(key) || key.includes(n)) return origin;
    }
  }
  return null;
}
