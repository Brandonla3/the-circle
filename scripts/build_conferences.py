"""
Regenerate app/api/_conferences.js from the NCAA Statistics export spreadsheet.

Usage:
    python scripts/build_conferences.py [path/to/NCAA Statistics.xlsx]

Default spreadsheet path:
    C:/Users/brand/OneDrive/Desktop/NCAA Statistics (1).xlsx

How to refresh the data each season:
    1. Re-export the NCAA Statistics report (Org / Conference / Active columns
       are the only ones we read).
    2. Save the .xlsx anywhere on disk.
    3. Run this script with the new path. It overwrites _conferences.js.
    4. `node scripts/test_conferences.mjs` to confirm 0 lookup failures, then
       commit the new _conferences.js.

The script also runs an audit against ESPN's softball /teams feed, reporting:
    - matched_in_espn  : how many spreadsheet schools resolve via ESPN.location
    - missing_from_espn: schools the spreadsheet has but ESPN doesn't carry
                         (typically newer reclassifying programs)
"""
import json, pandas as pd, re, unicodedata, sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_XLSX = r'C:/Users/brand/OneDrive/Desktop/NCAA Statistics (1).xlsx'
ESPN_CACHE = REPO / '.next' / 'espn-teams.json'

# NCAA's Statistics export uses periods+abbreviations for state names
# (Conn., Mich., St., etc.) where ESPN spells them out. Order matters:
# longer patterns first to avoid prefix collisions.
NCAA_ABBREV_EXPAND = [
  (r'\bSt\.', 'State'),
  (r'\bConn\.', 'Connecticut'),
  (r'\bMich\.', 'Michigan'),
  (r'\bMass\.', 'Massachusetts'),
  (r'\bIll\.', 'Illinois'),
  (r'\bInd\.', 'Indiana'),
  (r'\bKy\.', 'Kentucky'),
  (r'\bColo\.', 'Colorado'),
  (r'\bMo\.', 'Missouri'),
  (r'\bGa\.', 'Georgia'),
  (r'\bFla\.', 'Florida'),
  (r'\bLa\.', 'Louisiana'),
  (r'\bAla\.', 'Alabama'),
  (r'\bAriz\.', 'Arizona'),
  (r'\bArk\.', 'Arkansas'),
  (r'\bTenn\.', 'Tennessee'),
  (r'\bCalif\.', 'California'),
  (r'\bCaro\.', 'Carolina'),
  (r'\bTex\.', 'Texas'),
  (r'\bMd\.', 'Maryland'),
  (r'\bN\.\s?C\.', 'North Carolina'),
  (r'\bN\.\s?D\.', 'North Dakota'),
  (r'\bN\.\s?M\.', 'New Mexico'),
  (r'\bN\.\s?Y\.', 'New York'),
  (r'\bN\.\s?J\.', 'New Jersey'),
  (r'\bS\.\s?C\.', 'South Carolina'),
  (r'\bS\.\s?D\.', 'South Dakota'),
  (r'\bMinn\.', 'Minnesota'),
  (r'\bWash\.', 'Washington'),
  (r'\bWis\.', 'Wisconsin'),
  (r'\bVa\.', 'Virginia'),
  (r'\bVt\.', 'Vermont'),
  (r'\bDel\.', 'Delaware'),
  (r'\bOkla\.', 'Oklahoma'),
  (r'\bMiss\.', 'Mississippi'),
  (r'\bNeb\.', 'Nebraska'),
  (r'\bMt\.', 'Mount'),
  (r'\bMont\.', 'Montana'),
  (r'\bCol\.', 'College'),
  (r'\bU\.', 'University'),
  (r'\bVal\.', 'Valley'),
]

# Reverse aliases: keys are the EXPANDED / ESPN spelling, values are the
# spreadsheet's abbreviated Org name. Used at index-build time so callers
# can pass the long ESPN spelling and still find the conference.
REVERSE_ALIASES = {
  'Cal': 'California',  # UC Berkeley uses "Cal" in casual writing
  'Charleston Southern': 'Charleston So.',
  'East Tennessee State': 'ETSU',
  'Fairleigh Dickinson': 'FDU',
  'Florida Gulf Coast': 'FGCU',
  'Florida International': 'FIU',
  'IU Indianapolis': 'IU Indy',
  "Mount St. Mary's": 'Mount St. Mary`s',
  'Pennsylvania': 'Penn',
  'Prairie View A&M': 'Prairie View',
  'SIU Edwardsville': 'SIUE',
}

# Forward aliases: spreadsheet Org (lowercased, backticks stripped) -> the
# ESPN/common spelling. Used so the abbreviation expander still finds these
# rare cases (Hawai`i diacritic, A&M-Corpus Christi missing the "Texas",
# etc.).
HARD_ALIASES = {
  'a&m-corpus christi': 'Texas A&M-Corpus Christi',
  'east texas a&m': 'East Texas A&M',
  'lmu (ca)': 'Loyola Marymount',
  'saint marys (ca)': "Saint Mary's",
  'saint josephs': "Saint Joseph's",
  'saint peters': "Saint Peter's",
  'queens (nc)': 'Queens',
  'st. thomas (mn)': 'St. Thomas',
  'st. johns (ny)': "St. John's",
  'south fla.': 'South Florida',
  'fla. atlantic': 'Florida Atlantic',
  'middle tenn.': 'Middle Tennessee',
  'central conn. st.': 'Central Connecticut',
  'central mich.': 'Central Michigan',
  'central ark.': 'Central Arkansas',
  'eastern ill.': 'Eastern Illinois',
  'eastern ky.': 'Eastern Kentucky',
  'mississippi val.': 'Mississippi Valley State',
  'n.c. a&t': 'North Carolina A&T',
  'n.c. central': 'North Carolina Central',
  'north ala.': 'North Alabama',
  'northern colo.': 'Northern Colorado',
  'northern ky.': 'Northern Kentucky',
  'san jose st.': 'San Jose State',
  'southeast mo. st.': 'Southeast Missouri State',
  'southeastern la.': 'Southeastern Louisiana',
  'southern ill.': 'Southern Illinois',
  'southern ind.': 'Southern Indiana',
  'southern u.': 'Southern',
  'tarleton st.': 'Tarleton State',
  'usc upstate': 'USC Upstate',
  'uc san diego': 'UC San Diego',
  'csu bakersfield': 'Cal State Bakersfield',
  'west ga.': 'West Georgia',
  'western caro.': 'Western Carolina',
  'western ill.': 'Western Illinois',
  'western mich.': 'Western Michigan',
  'col. of charleston': 'Charleston',
  'lamar university': 'Lamar',
  'army west point': 'Army',
  'hawaii': "Hawai'i",
  'ark.-pine bluff': 'Arkansas-Pine Bluff',
  'alcorn': 'Alcorn State',
}

def expand_abbrev(s):
  for pat, repl in NCAA_ABBREV_EXPAND:
    s = re.sub(pat, repl, s)
  return s

def norm(s):
  if not s: return ''
  s = unicodedata.normalize('NFKD', str(s)).encode('ascii','ignore').decode('ascii')
  s = s.lower()
  s = s.replace('&', ' and ')
  s = s.replace('`', '')
  s = re.sub(r'[^a-z0-9 ]', ' ', s)
  s = re.sub(r'\s+', ' ', s).strip()
  return s

def main():
  xlsx_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XLSX
  print(f'Reading: {xlsx_path}', file=sys.stderr)

  df = pd.read_excel(xlsx_path)
  needed = {'Org', 'Conference'}
  if not needed.issubset(df.columns):
    sys.exit(f'spreadsheet missing required columns: {needed - set(df.columns)}')
  if 'Active' in df.columns:
    df = df[df['Active'] == True]
  ncaa = list(df[['Org','Conference']].itertuples(index=False, name=None))
  print(f'Active D-I softball schools: {len(ncaa)}', file=sys.stderr)

  # ESPN audit (optional — needs the cached teams JSON)
  if ESPN_CACHE.exists():
    espn_data = json.loads(ESPN_CACHE.read_text())
    espn_teams = [w['team'] for w in espn_data['sports'][0]['leagues'][0]['teams']]
    espn_by_norm = {}
    for t in espn_teams:
      for f in ('location','displayName','shortDisplayName','name','nickname','abbreviation'):
        n = norm(t.get(f))
        if n and n not in espn_by_norm: espn_by_norm[n] = t

    matched, unmatched = 0, []
    for org, _ in ncaa:
      ak = org.lower().strip().replace('`', '')
      n = (norm(HARD_ALIASES[ak]) if ak in HARD_ALIASES else None) or norm(org) or norm(expand_abbrev(org))
      if any(x in espn_by_norm for x in [norm(HARD_ALIASES.get(ak,'')), norm(org), norm(expand_abbrev(org))] if x):
        matched += 1
      else:
        unmatched.append(org)
    print(f'ESPN audit: {matched}/{len(ncaa)} match in ESPN /teams feed', file=sys.stderr)
    if unmatched:
      print(f'  Not in ESPN feed (likely newer/dropped programs):', file=sys.stderr)
      for o in unmatched: print(f'    {o}', file=sys.stderr)
  else:
    print(f'(skipping ESPN audit — {ESPN_CACHE} not found)', file=sys.stderr)

  ncaa_sorted = sorted(ncaa, key=lambda r: r[0].lower())
  out_path = REPO / 'app' / 'api' / '_conferences.js'

  js = []
  js.append("// AUTO-GENERATED — DO NOT EDIT BY HAND.")
  js.append(f"// Source: {xlsx_path}")
  js.append("// Regenerate via: python scripts/build_conferences.py [xlsx-path]")
  js.append("//")
  js.append("// This file ships the canonical school -> conference table for D-I softball.")
  js.append("// It is the source of truth for any place the app displays a conference label.")
  js.append("//")
  js.append("// 308 NCAA Org strings preserve the spreadsheet's exact spelling, including")
  js.append("// backtick-as-apostrophe (Saint Mary`s) and abbreviated state names (St., Mich.,")
  js.append("// Conn.). The matcher in lookupConference normalizes all of those at runtime.")
  js.append("")
  js.append("// NCAA Org -> conference (verbatim from the spreadsheet).")
  js.append("export const NCAA_TEAM_CONFERENCES = Object.freeze({")
  for org, conf in ncaa_sorted:
    org_esc = org.replace('\\','\\\\').replace('`','\\u0060').replace("'", "\\'")
    js.append(f"  '{org_esc}': '{conf}',")
  js.append("});")
  js.append("")
  js.append("// Tier set for the StandingsView 'Major Only' filter.")
  js.append("export const POWER_CONFERENCES = new Set(['SEC', 'ACC', 'Big 12', 'Big Ten']);")
  js.append("")
  js.append("// All Division I softball conferences from the spreadsheet, ordered by")
  js.append("// member count (descending).")
  conf_counts = df['Conference'].value_counts()
  js.append("export const ALL_CONFERENCES = Object.freeze([")
  for conf, n in conf_counts.items():
    js.append(f"  {{ name: '{conf}', size: {n} }},")
  js.append("]);")
  js.append("")
  js.append("// NCAA abbreviates state names with periods. Expand them BEFORE the")
  js.append("// generic normalizer so 'San Jose St.' resolves to 'san jose state'.")
  js.append("// Order matters: longer patterns first to avoid prefix collisions.")
  js.append("const NCAA_ABBREV_EXPAND = [")
  for pat, repl in NCAA_ABBREV_EXPAND:
    js.append(f"  [/{pat}/g, '{repl}'],")
  js.append("];")
  js.append("")
  js.append("// Genuinely-different names where the NCAA spelling and the ESPN/common")
  js.append("// spelling diverge beyond what the abbreviation table can fix. Keys are")
  js.append("// the spreadsheet Org spelling (lowercased, backticks stripped). Values")
  js.append("// are what ESPN's team directory typically calls the same school.")
  js.append("const HARD_ALIASES = Object.freeze({")
  for k in sorted(HARD_ALIASES):
    v = HARD_ALIASES[k]
    js.append(f"  '{k.replace(chr(39), chr(92)+chr(39))}': '{v.replace(chr(39), chr(92)+chr(39))}',")
  js.append("});")
  js.append("")
  js.append("// Reverse aliases: keys are the EXPANDED ESPN-style spelling, values are")
  js.append("// the spreadsheet's abbreviated Org. The index-builder also adds entries")
  js.append("// for each of these so callers passing ESPN's long form (e.g.")
  js.append("// 'Charleston Southern', 'IU Indianapolis') resolve to the right row.")
  js.append("const REVERSE_ALIASES = Object.freeze({")
  for espn_name in sorted(REVERSE_ALIASES):
    org = REVERSE_ALIASES[espn_name]
    js.append(f"  '{espn_name.replace(chr(39), chr(92)+chr(39)).replace(chr(96), chr(92)+'u0060')}': '{org.replace(chr(39), chr(92)+chr(39)).replace(chr(96), chr(92)+'u0060')}',")
  js.append("});")
  js.append("")
  js.append("function expandAbbrev(s) {")
  js.append("  let out = s;")
  js.append("  for (const [pat, repl] of NCAA_ABBREV_EXPAND) out = out.replace(pat, repl);")
  js.append("  return out;")
  js.append("}")
  js.append("")
  js.append("function normalize(s) {")
  js.append("  if (!s) return '';")
  js.append("  return s")
  js.append("    .normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '')")
  js.append("    .toLowerCase()")
  js.append("    .replace(/&/g, ' and ')")
  js.append("    .replace(/`/g, '')")
  js.append("    .replace(/[^a-z0-9 ]/g, ' ')")
  js.append("    .replace(/\\s+/g, ' ')")
  js.append("    .trim();")
  js.append("}")
  js.append("")
  js.append("// Build the runtime lookup index ONCE at module load. Each NCAA Org gets")
  js.append("// indexed under multiple normalized variants so callers can hit it with")
  js.append("// whichever team-name shape they happen to have (ESPN displayName, ESPN")
  js.append("// location, NCAA Org, henrygd school slug, etc.).")
  js.append("const lookupIndex = (() => {")
  js.append("  const idx = new Map();")
  js.append("  const add = (key, conf) => {")
  js.append("    const n = normalize(key);")
  js.append("    if (n && !idx.has(n)) idx.set(n, conf);")
  js.append("  };")
  js.append("  for (const [org, conf] of Object.entries(NCAA_TEAM_CONFERENCES)) {")
  js.append("    add(org, conf);")
  js.append("    add(expandAbbrev(org), conf);")
  js.append("    const aliasKey = org.toLowerCase().replace(/`/g, '');")
  js.append("    const aliased = HARD_ALIASES[aliasKey];")
  js.append("    if (aliased) add(aliased, conf);")
  js.append("  }")
  js.append("  // Reverse aliases: ESPN-style spelling -> abbreviated spreadsheet Org.")
  js.append("  // Look up the conf via the spreadsheet form, then index the ESPN form.")
  js.append("  for (const [espnName, org] of Object.entries(REVERSE_ALIASES)) {")
  js.append("    const conf = NCAA_TEAM_CONFERENCES[org];")
  js.append("    if (conf) add(espnName, conf);")
  js.append("  }")
  js.append("  return idx;")
  js.append("})();")
  js.append("")
  js.append("// Look up the conference for any team-name spelling. Returns null if no")
  js.append("// D-I softball program matches.")
  js.append("//")
  js.append("// IMPORTANT: callers should pass a clean school name (e.g. 'Oklahoma',")
  js.append("// not 'Oklahoma Sooners'). This function does NOT do substring fallback")
  js.append("// because schools-named-after-other-schools (Loyola Maryland, Eastern")
  js.append("// Michigan, Northern Illinois, Charleston Southern, etc.) collide with")
  js.append("// shorter D-I program names and a substring matcher routes them to the")
  js.append("// wrong conference. ESPN's `team.location` field is always mascot-free,")
  js.append("// so prefer that over `team.displayName` when the caller has both.")
  js.append("export function lookupConference(name) {")
  js.append("  if (!name) return null;")
  js.append("  const n = normalize(name);")
  js.append("  if (lookupIndex.has(n)) return lookupIndex.get(n);")
  js.append("  const expanded = normalize(expandAbbrev(name));")
  js.append("  if (lookupIndex.has(expanded)) return lookupIndex.get(expanded);")
  js.append("  return null;")
  js.append("}")
  js.append("")

  out_path.write_text('\n'.join(js), encoding='utf-8')
  print(f'Wrote {out_path} ({len(out_path.read_text())} bytes)', file=sys.stderr)
  print(f'  {len(ncaa)} schools, {df["Conference"].nunique()} conferences', file=sys.stderr)

if __name__ == '__main__':
  main()
