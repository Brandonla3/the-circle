#!/usr/bin/env node
// Generates a CSV audit of all 308 D1 softball teams and their data sources.
// Usage: node scripts/audit_data_sources.mjs > audit.csv

import { NCAA_TEAM_CONFERENCES } from '../app/api/_conferences.js';

// ── Sidearm roster access (from _sidearm-roster-map.js, verified 2026-04-09) ─
const SIDEARM_TEAMS = new Set([
  // SEC (10)
  'Alabama', 'Florida', 'Georgia', 'Mississippi St.', 'Missouri',
  'Oklahoma', 'Ole Miss', 'Tennessee', 'Texas', 'Texas A&M',
  // Big 12 (7)
  'Baylor', 'Houston', 'Iowa St.', 'Kansas', 'Oklahoma St.', 'Texas Tech', 'Utah',
  // ACC (8)
  'Boston College', 'Duke', 'Florida St.', 'Louisville', 'NC State',
  'North Carolina', 'Pittsburgh', 'Syracuse',
  // Big Ten (10)
  'Indiana', 'Michigan', 'Michigan St.', 'Minnesota', 'Northwestern',
  'Ohio St.', 'Oregon', 'UCLA', 'Washington', 'Wisconsin',
  // Mountain West (3)
  'Boise St.', 'Colorado St.', 'Fresno St.',
]);

// ── WMT Digital schools (no server-side API — Sidearm returns HTML) ─────────
const WMT_DIGITAL_TEAMS = new Set([
  // SEC
  'Arkansas', 'Auburn', 'Kentucky', 'LSU', 'South Carolina', // Vanderbilt not in softball
  // Big 12
  'Arizona', 'Nevada',
  // ACC
  'California', 'Georgia Tech', 'Notre Dame',
  // Big Ten
  'Illinois', 'Maryland',
  // Mountain West
  'UNLV', 'Utah St.', // Nevada already listed under Big 12, Wyoming not in MW softball
]);

// ── Static roster (hand-curated) ────────────────────────────────────────────
const STATIC_ROSTER_TEAMS = new Set(['LSU']);

// ── SEC WMT stats (full team+individual stats via wmt.games) ────────────────
const SEC_TEAMS = new Set([
  'Alabama', 'Arkansas', 'Auburn', 'Florida', 'Georgia', 'Kentucky', 'LSU',
  'Mississippi St.', 'Missouri', 'Oklahoma', 'Ole Miss', 'South Carolina',
  'Tennessee', 'Texas', 'Texas A&M',
]);

// ── Conferences with dedicated schedule scrapers ────────────────────────────
const SCHEDULE_SCRAPER_CONFS = new Set(['SEC', 'Big 12', 'ACC', 'Big Ten', 'Mountain West']);

// ── Conferences with dedicated standings scrapers ───────────────────────────
const STANDINGS_SCRAPER_CONFS = new Set(['SEC', 'Big 12', 'ACC', 'Big Ten', 'Mountain West']);

// ── Data source logic ───────────────────────────────────────────────────────
// ESPN: universal for all D1 teams (scores, rankings, team directory, basic roster)
// NCAA leaderboards: universal for all D1 teams (national stat leaderboards)
// Conference data: from _conferences.js (all 308 teams)

function getRosterSource(team, conf) {
  const sources = [];
  sources.push('ESPN');  // ESPN basic roster is always attempted
  if (SIDEARM_TEAMS.has(team)) sources.push('Sidearm API');
  if (STATIC_ROSTER_TEAMS.has(team)) sources.push('Static (hand-curated)');
  if (WMT_DIGITAL_TEAMS.has(team)) sources.push('WMT Digital (no API)');
  if (sources.length === 1) sources.push('ESPN only');
  return sources.filter(s => s !== 'ESPN').join(' + ') || 'ESPN only';
}

function getPhotoSource(team, conf) {
  if (STATIC_ROSTER_TEAMS.has(team)) return 'Static CDN + ESPN';
  if (SIDEARM_TEAMS.has(team)) return 'Sidearm + ESPN';
  return 'ESPN';
}

function getStatsSource(team, conf) {
  const sources = ['NCAA leaderboards'];
  if (SEC_TEAMS.has(team)) sources.push('SEC WMT (full roster stats)');
  return sources.join(' + ');
}

function getScheduleSource(team, conf) {
  if (SCHEDULE_SCRAPER_CONFS.has(conf)) return `${conf} scraper + ESPN`;
  return 'ESPN';
}

function getStandingsSource(team, conf) {
  if (STANDINGS_SCRAPER_CONFS.has(conf)) return `${conf} scraper`;
  return 'NCAA scoreboard aggregation';
}

function getConferenceDataSource(team, conf) {
  return '_conferences.js (NCAA spreadsheet)';
}

// ── Generate CSV ────────────────────────────────────────────────────────────
const header = [
  'Team',
  'Conference',
  'Scores Source',
  'Roster Source',
  'Profile Photos',
  'Player Stats Source',
  'Team Stats Source',
  'Schedule Source',
  'Standings Source',
  'Conference Data Source',
  'Has Sidearm Roster',
  'Has Static Roster',
  'Has SEC WMT Stats',
  'Has Conference Schedule Scraper',
  'Has Conference Standings Scraper',
  'Notes',
];

function escCsv(s) {
  if (typeof s !== 'string') return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const rows = [];

// Sort teams alphabetically
const teams = Object.entries(NCAA_TEAM_CONFERENCES).sort((a, b) => a[0].localeCompare(b[0]));

for (const [team, conf] of teams) {
  const hasSidearm = SIDEARM_TEAMS.has(team);
  const hasStatic = STATIC_ROSTER_TEAMS.has(team);
  const hasSecWmt = SEC_TEAMS.has(team);
  const hasScheduleScraper = SCHEDULE_SCRAPER_CONFS.has(conf);
  const hasStandingsScraper = STANDINGS_SCRAPER_CONFS.has(conf);
  const isWmt = WMT_DIGITAL_TEAMS.has(team);

  let notes = [];
  if (isWmt && !hasSidearm && !hasStatic) notes.push('WMT Digital — no server-side roster API');
  if (hasSecWmt) notes.push('Full individual stats via SEC WMT feed');
  if (hasStatic) notes.push('Hand-curated roster with CDN photo URLs');

  rows.push([
    team,
    conf,
    'ESPN',                              // Scores
    getRosterSource(team, conf),         // Roster
    getPhotoSource(team, conf),          // Photos
    getStatsSource(team, conf),          // Player Stats
    getStatsSource(team, conf),          // Team Stats (same source)
    getScheduleSource(team, conf),       // Schedule
    getStandingsSource(team, conf),      // Standings
    getConferenceDataSource(team, conf), // Conference Data
    hasSidearm ? 'Yes' : 'No',
    hasStatic ? 'Yes' : 'No',
    hasSecWmt ? 'Yes' : 'No',
    hasScheduleScraper ? 'Yes' : 'No',
    hasStandingsScraper ? 'Yes' : 'No',
    notes.join('; '),
  ]);
}

// Output
console.log(header.map(escCsv).join(','));
for (const row of rows) {
  console.log(row.map(escCsv).join(','));
}

// Summary stats to stderr
const total = teams.length;
const sidearmCount = teams.filter(([t]) => SIDEARM_TEAMS.has(t)).length;
const staticCount = teams.filter(([t]) => STATIC_ROSTER_TEAMS.has(t)).length;
const secWmtCount = teams.filter(([t]) => SEC_TEAMS.has(t)).length;
const wmtDigitalCount = teams.filter(([t]) => WMT_DIGITAL_TEAMS.has(t)).length;
const schedConfs = [...new Set(teams.map(([,c]) => c))].filter(c => SCHEDULE_SCRAPER_CONFS.has(c));
const schedTeams = teams.filter(([,c]) => SCHEDULE_SCRAPER_CONFS.has(c)).length;
const standTeams = teams.filter(([,c]) => STANDINGS_SCRAPER_CONFS.has(c)).length;

process.stderr.write(`
=== DATA SOURCE AUDIT SUMMARY ===
Total D1 teams:                    ${total}
Teams with Sidearm roster API:     ${sidearmCount} (${(sidearmCount/total*100).toFixed(1)}%)
Teams with static roster:          ${staticCount}
Teams with WMT Digital (no API):   ${wmtDigitalCount}
Teams with SEC WMT full stats:     ${secWmtCount}
Teams with conference schedule:    ${schedTeams} across ${schedConfs.length} conferences (${schedConfs.join(', ')})
Teams with conference standings:   ${standTeams} across ${schedConfs.length} conferences
Teams with ESPN-only roster:       ${total - sidearmCount - staticCount - wmtDigitalCount}
Conferences total:                 ${new Set(teams.map(([,c]) => c)).size}
`);
