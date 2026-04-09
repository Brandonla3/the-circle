// ACC softball schedule source.
//
// Thin wrapper around the shared Sidearm Sports fetcher — theacc.com
// runs on the same responsive-calendar.ashx endpoint that powers
// big12sports.com and friends (see _sidearm-schedule.js for the full
// endpoint shape and self-gating semantics).
//
// Softball sport_id is 15. All 15 current ACC softball members are
// covered in a single request: Boston College, California, Clemson,
// Duke, Florida State, Georgia Tech, Louisville, NC State, North
// Carolina, Notre Dame, Pitt, Stanford, Syracuse, Virginia, Virginia
// Tech. (SMU and Wake Forest are the ACC members that don't sponsor
// softball.)
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { createSidearmScheduleFetcher } from './_sidearm-schedule.js';

export const getAccTeamSchedule = createSidearmScheduleFetcher({
  origin: 'https://theacc.com',
  sportId: 15,
  idPrefix: 'acc',
});
