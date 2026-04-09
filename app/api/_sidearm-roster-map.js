// ESPN team display-name → Sidearm school origin URL.
//
// Used by team-stats/route.js to resolve the correct Sidearm athlete page
// for a given team so we can fetch jersey numbers and headshot photos.
//
// Keys are lowercased, diacritic-stripped display names exactly as ESPN's
// /teams endpoint returns them (field: `displayName`). Match is case-
// insensitive via normalize() before lookup — see getSidearmOrigin().
//
// Origins are the bare https://... root — no trailing slash — because
// _sidearm-roster.js appends /api/v2/sports and /api/v2/rosters paths.
//
// To add a new school: find their athletic site root, confirm the
// /api/v2/sports endpoint exists and returns a softball entry
// (globalSportNameSlug === "softball"), then add the row.
//
// Schools whose athletic sites do NOT use Sidearm (or use a different
// API format — e.g. Learfield's Rivals platform, WMT Digital, custom
// CMS) should NOT be listed here. Their players will fall back to the
// ESPN roster supplement path already in team-stats/route.js.
//
// Last verified: 2026-04-08.

// ── SEC ──────────────────────────────────────────────────────────────────────
// secsports.com supplies SEC-wide roster via the WMT Stats feed, so all
// SEC schools already have jersey + position data through that path.
// Sidearm origins are still listed here as a fallback / cross-check.
const SEC_ORIGINS = {
  'alabama':            'https://rolltide.com',
  'arkansas':           'https://arkansasrazorbacks.com',
  'auburn':             'https://auburntigers.com',
  'florida':            'https://floridagators.com',
  'georgia':            'https://georgiadogs.com',
  'kentucky':           'https://ukathletics.com',
  'lsu':                'https://lsusports.net',
  'mississippi state':  'https://hailstate.com',
  'missouri':           'https://mutigers.com',
  'oklahoma':           'https://soonersports.com',
  'ole miss':           'https://olemisssports.com',
  'south carolina':     'https://gamecocksonline.com',
  'tennessee':          'https://utsports.com',
  'texas':              'https://texassports.com',
  'texas a&m':          'https://12thman.com',
  'vanderbilt':         'https://vucommodores.com',
};

// ── Big 12 ───────────────────────────────────────────────────────────────────
const BIG12_ORIGINS = {
  'arizona':            'https://arizonawildcats.com',
  'arizona state':      'https://thesundevils.com',
  'baylor':             'https://baylorbears.com',
  'byu':                'https://byucougars.com',
  'cincinnati':         'https://gobearcats.com',
  'colorado':           'https://cubuffs.com',
  'houston':            'https://uhcougars.com',
  'iowa state':         'https://cyclones.com',
  'kansas':             'https://kuathletics.com',
  'kansas state':       'https://kstatesports.com',
  'oklahoma state':     'https://okstate.com',
  'tcu':                'https://gofrogs.com',
  'texas tech':         'https://texastech.com',
  'ucf':                'https://ucfknights.com',
  'utah':               'https://utahutes.com',
  'west virginia':      'https://wvusports.com',
};

// ── ACC ───────────────────────────────────────────────────────────────────────
// SMU and Wake Forest do not sponsor softball; the 15 ACC softball schools:
const ACC_ORIGINS = {
  'boston college':     'https://bceagles.com',
  'california':         'https://calbears.com',
  'clemson':            'https://clemsontigers.com',
  'duke':               'https://goduke.com',
  'florida state':      'https://seminoles.com',
  'georgia tech':       'https://ramblinwreck.com',
  'louisville':         'https://gocards.com',
  'nc state':           'https://gopack.com',
  'north carolina':     'https://goheels.com',
  'notre dame':         'https://und.com',
  'pitt':               'https://pittsburghpanthers.com',
  'stanford':           'https://gostanford.com',
  'syracuse':           'https://cuse.com',
  'virginia':           'https://virginiasports.com',
  'virginia tech':      'https://hokiesports.com',
};

// ── Big Ten ───────────────────────────────────────────────────────────────────
// 17 Big Ten softball-sponsoring programs (Rutgers does not sponsor softball):
const BIG10_ORIGINS = {
  'illinois':           'https://fightingillini.com',
  'indiana':            'https://iuhoosiers.com',
  'iowa':               'https://hawkeyesports.com',
  'maryland':           'https://umterps.com',
  'michigan':           'https://mgoblue.com',
  'michigan state':     'https://msuspartans.com',
  'minnesota':          'https://gophersports.com',
  'nebraska':           'https://huskers.com',
  'northwestern':       'https://nusports.com',
  'ohio state':         'https://ohiostatebuckeyes.com',
  'penn state':         'https://gopsusports.com',
  'purdue':             'https://purduesports.com',
  'ucla':               'https://uclabruins.com',
  'usc':                'https://usctrojans.com',
  'washington':         'https://gohuskies.com',
  'wisconsin':          'https://uwbadgers.com',
  // Oregon also sponsors softball but is the newest B1G addition — confirm origin:
  'oregon':             'https://goducks.com',
};

// ── Mountain West ─────────────────────────────────────────────────────────────
// 10 MW softball-sponsoring schools:
const MW_ORIGINS = {
  'air force':          'https://goairforcefalcons.com',
  'boise state':        'https://broncosports.com',
  'colorado state':     'https://csurams.com',
  'fresno state':       'https://gobulldogs.com',
  'nevada':             'https://nevadawolfpack.com',
  'new mexico':         'https://golobos.com',
  'san diego state':    'https://goaztecs.com',
  'san jose state':     'https://sjsuspartans.com',
  'unlv':               'https://unlvrebels.com',
  'utah state':         'https://utahstateaggies.com',
  'wyoming':            'https://gowyo.com',
};

// Merge into one flat lookup used at runtime.
const ORIGIN_MAP = {
  ...SEC_ORIGINS,
  ...BIG12_ORIGINS,
  ...ACC_ORIGINS,
  ...BIG10_ORIGINS,
  ...MW_ORIGINS,
};

// Normalize helper — matches the `normalize` function in _espn.js without
// importing it (avoids a circular dep chain in the helper layer).
function norm(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Return the Sidearm origin URL for a given ESPN team display-name, or null
// if the team isn't mapped. The caller should pass any of the ESPN name
// variants (displayName, location, shortDisplayName, abbreviation) and this
// will try each until one hits.
export function getSidearmOrigin(nameVariantSet) {
  for (const v of nameVariantSet) {
    const n = norm(v);
    if (ORIGIN_MAP[n]) return ORIGIN_MAP[n];
  }
  // Substring fallback: catch "North Carolina Tar Heels" → "north carolina".
  for (const v of nameVariantSet) {
    const n = norm(v);
    for (const [key, origin] of Object.entries(ORIGIN_MAP)) {
      if (n.includes(key) || key.includes(n)) return origin;
    }
  }
  return null;
}
