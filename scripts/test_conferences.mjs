// Spot-check the conference lookup table against a curated set of teams
// covering the recent realignment moves, reverse aliases, and known
// not-in-spreadsheet cases.
//
// Run from the repo root: node scripts/test_conferences.mjs
import { lookupConference } from '../app/api/_conferences.js';

const cases = [
  ['Oklahoma', 'SEC'],          // moved from Big 12 to SEC
  ['Texas', 'SEC'],             // moved from Big 12 to SEC
  ['UCLA', 'Big Ten'],          // moved from Pac-12 to Big Ten
  ['USC', null],                // doesn't field D-I softball
  ['Oregon', 'Big Ten'],
  ['Washington', 'Big Ten'],
  ['Stanford', 'ACC'],
  ['Cal', 'ACC'],
  ['Tennessee', 'SEC'],
  ['Florida', 'SEC'],
  ['Texas A&M', 'SEC'],
  ['LSU', 'SEC'],
  ['Northwestern', 'Big Ten'],
  ['Michigan', 'Big Ten'],
  ['Florida State', 'ACC'],
  ['Clemson', 'ACC'],
  ['Virginia Tech', 'ACC'],
  ['Kansas', 'Big 12'],
  ['Baylor', 'Big 12'],
  ['Iowa State', 'Big 12'],
  ['BYU', 'Big 12'],
  ['UCF', 'Big 12'],
  ['Cincinnati', null],
  ['Air Force', null],
  ['Loyola Maryland', null],    // doesn't field D-I softball
  ['Eastern Michigan', null],   // dropped softball after 2018
  ['Charleston Southern', 'Big South'], // reverse alias
  ['IU Indianapolis', 'Horizon'], // reverse alias
  ['Fairleigh Dickinson', 'NEC'], // reverse alias
  ['East Tennessee State', 'SoCon'], // reverse alias
  ['Florida Gulf Coast', 'ASUN'], // reverse alias
  ['Pennsylvania', 'Ivy League'], // reverse alias
  ['NotARealTeam', null],
];

let pass = 0;
let fail = 0;
const failures = [];
for (const [name, expected] of cases) {
  const got = lookupConference(name);
  const ok = got === expected;
  const mark = ok ? 'OK ' : 'FAIL';
  const gotStr = (got || '(null)').padEnd(15);
  const expStr = expected || '(null)';
  console.log(`  ${mark} ${name.padEnd(22)} -> ${gotStr} expected ${expStr}`);
  if (ok) pass++;
  else { fail++; failures.push([name, expected, got]); }
}
console.log();
console.log(`${pass}/${pass+fail} pass`);
if (fail) process.exit(1);
