// Big 12 softball stats source.
//
// Thin wrapper around the shared Sidearm stats fetcher. The Big 12's
// big12sports.com site serves full conference stats at
//   https://big12sports.com/stats.aspx?path=softball&year=YYYY
// as plain HTML tables with six target captions (Overall Batting/
// Pitching/Field Stats and Individual Hitting/Pitching/Fielding Stats).
// See app/api/_sidearm-stats.js for the parsing details.
//
// Covers all 11 Big 12 softball programs (Arizona, Arizona State,
// Baylor, BYU, Houston, Iowa State, Kansas, Oklahoma State, Texas Tech,
// UCF, Utah) in a single HTTP request.
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { createSidearmStatsFetcher } from './_sidearm-stats.js';

export const getBig12TeamStats = createSidearmStatsFetcher({
  origin: 'https://big12sports.com',
  confName: 'Big 12',
});
