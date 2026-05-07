// Big 12 softball schedule source.
//
// Thin wrapper around the shared Sidearm Sports fetcher — the Big 12's
// big12sports.com site runs on the same responsive-calendar.ashx
// endpoint as every other Sidearm conference (see _sidearm-schedule.js
// for the full story on the endpoint shape, self-gating behavior, and
// why we don't use the iCal subscription feed).
//
// Softball sport_id is 12. Current Big 12 softball-sponsoring schools
// (Arizona, Arizona State, Baylor, BYU, Houston, Iowa State, Kansas,
// Oklahoma State, Texas Tech, UCF, Utah — Cincinnati, Colorado, Kansas
// State, TCU and West Virginia don't sponsor softball) are all covered
// in a single request.
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { createSidearmScheduleFetcher } from './_sidearm-schedule.js';

export const getBig12TeamSchedule = createSidearmScheduleFetcher({
  origin: 'https://big12sports.com',
  sportId: 12,
  idPrefix: 'big12',
  referer: 'https://big12sports.com/calendar.aspx?path=softball',
});
