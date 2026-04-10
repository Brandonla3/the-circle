#!/usr/bin/env node
// Converts data_source_audit.csv to an Excel workbook with formatting.
// Usage: node scripts/audit_to_xlsx.mjs

import { readFileSync } from 'fs';
import XLSX from 'xlsx';

const csv = readFileSync('data_source_audit.csv', 'utf8');
const lines = csv.trim().split('\n');

// Parse CSV (handles quoted fields)
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(current); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current);
  return fields;
}

const header = parseCsvLine(lines[0]);
const data = lines.slice(1).map(parseCsvLine);

// Create workbook
const wb = XLSX.utils.book_new();

// Main audit sheet
const wsData = [header, ...data];
const ws = XLSX.utils.aoa_to_sheet(wsData);

// Set column widths
ws['!cols'] = [
  { wch: 22 },  // Team
  { wch: 16 },  // Conference
  { wch: 8 },   // Scores Source
  { wch: 32 },  // Roster Source
  { wch: 20 },  // Profile Photos
  { wch: 42 },  // Player Stats Source
  { wch: 42 },  // Team Stats Source
  { wch: 28 },  // Schedule Source
  { wch: 28 },  // Standings Source
  { wch: 32 },  // Conference Data Source
  { wch: 8 },   // Has Sidearm
  { wch: 8 },   // Has Static
  { wch: 8 },   // Has SEC WMT
  { wch: 8 },   // Has Schedule Scraper
  { wch: 8 },   // Has Standings Scraper
  { wch: 55 },  // Notes
];

XLSX.utils.book_append_sheet(wb, ws, 'All Teams');

// Summary sheet
const summaryData = [
  ['Data Source Audit Summary'],
  [],
  ['Metric', 'Count', 'Percentage'],
  ['Total D1 Teams', data.length, '100%'],
  ['ESPN (scores, roster, photos)', data.length, '100%'],
  ['NCAA Leaderboards (stats)', data.length, '100%'],
  ['Conference Data (_conferences.js)', data.length, '100%'],
  ['Sidearm Roster API', data.filter(r => r[10] === 'Yes').length, `${(data.filter(r => r[10] === 'Yes').length / data.length * 100).toFixed(1)}%`],
  ['SEC WMT Full Stats', data.filter(r => r[12] === 'Yes').length, `${(data.filter(r => r[12] === 'Yes').length / data.length * 100).toFixed(1)}%`],
  ['Conference Schedule Scraper', data.filter(r => r[13] === 'Yes').length, `${(data.filter(r => r[13] === 'Yes').length / data.length * 100).toFixed(1)}%`],
  ['Conference Standings Scraper', data.filter(r => r[14] === 'Yes').length, `${(data.filter(r => r[14] === 'Yes').length / data.length * 100).toFixed(1)}%`],
  ['Static Roster (hand-curated)', data.filter(r => r[11] === 'Yes').length, `${(data.filter(r => r[11] === 'Yes').length / data.length * 100).toFixed(1)}%`],
  ['ESPN-Only Roster', data.filter(r => r[3] === 'ESPN only').length, `${(data.filter(r => r[3] === 'ESPN only').length / data.length * 100).toFixed(1)}%`],
  [],
  ['Conferences with Dedicated Scrapers'],
  ['SEC', 'Big 12', 'ACC', 'Big Ten', 'Mountain West'],
  [],
  ['Data Tiers'],
  [],
  ['Tier', 'Description', 'Teams'],
  ['Tier 1 — SEC', 'ESPN + Sidearm/Static + NCAA + SEC WMT full stats + conference scrapers', '15'],
  ['Tier 2 — Power 5 non-SEC', 'ESPN + Sidearm (most) + NCAA + conference scrapers', '53'],
  ['Tier 3 — Mountain West', 'ESPN + some Sidearm + NCAA + conference scrapers', '10'],
  ['Tier 4 — All others', 'ESPN + NCAA leaderboards only', '230'],
];

const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
wsSummary['!cols'] = [{ wch: 35 }, { wch: 12 }, { wch: 12 }];
XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

// By-conference breakdown sheet
const confMap = new Map();
for (const row of data) {
  const conf = row[1];
  if (!confMap.has(conf)) confMap.set(conf, []);
  confMap.get(conf).push(row);
}
const confRows = [['Conference', 'Teams', 'Sidearm Roster', 'SEC WMT Stats', 'Schedule Scraper', 'Standings Scraper']];
for (const [conf, teams] of [...confMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  confRows.push([
    conf,
    teams.length,
    teams.filter(r => r[10] === 'Yes').length,
    teams.filter(r => r[12] === 'Yes').length,
    teams.filter(r => r[13] === 'Yes').length > 0 ? 'Yes' : 'No',
    teams.filter(r => r[14] === 'Yes').length > 0 ? 'Yes' : 'No',
  ]);
}
const wsConf = XLSX.utils.aoa_to_sheet(confRows);
wsConf['!cols'] = [{ wch: 20 }, { wch: 8 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 18 }];
XLSX.utils.book_append_sheet(wb, wsConf, 'By Conference');

// Write file
const outPath = 'data_source_audit.xlsx';
XLSX.writeFile(wb, outPath);
console.log(`Written to ${outPath}`);
console.log(`  Sheet 1: All Teams (${data.length} rows)`);
console.log(`  Sheet 2: Summary`);
console.log(`  Sheet 3: By Conference (${confMap.size} conferences)`);
