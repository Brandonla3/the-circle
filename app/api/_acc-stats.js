// ACC softball stats source.
//
// Thin wrapper around the shared Sidearm stats fetcher. The ACC's
// theacc.com site serves full conference stats at
//   https://theacc.com/stats.aspx?path=softball&year=YYYY
// as plain HTML tables with six target captions (Overall Batting/
// Pitching/Field Stats and Individual Hitting/Pitching/Fielding Stats).
// See app/api/_sidearm-stats.js for the parsing details.
//
// Covers all 15 ACC softball programs (Boston College, California,
// Clemson, Duke, Florida State, Georgia Tech, Louisville, NC State,
// North Carolina, Notre Dame, Pitt, Stanford, Syracuse, Virginia,
// Virginia Tech) in a single HTTP request.
//
// NOT a route — Next.js only treats literal route.js files as endpoints,
// so this helper module lives safely alongside them.

import { createSidearmStatsFetcher } from './_sidearm-stats.js';

export const getAccTeamStats = createSidearmStatsFetcher({
  origin: 'https://theacc.com',
  confName: 'ACC',
});
