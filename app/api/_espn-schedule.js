// ESPN team schedule fetcher — used as a fallback when a conference's
// primary source (Sidearm, Boost, WMT) is unavailable.
//
// Endpoint: {ESPN_SITE}/teams/{teamId}/schedule
// Returns a flat events array where each event has one competition with
// two competitors (home/away). We identify the requesting team by matching
// competitors[].team.id against the ESPN teamId parameter, then build the
// same normalized schedule shape used by all other conference fetchers.
//
// NOT a route — Next.js only treats literal route.js files as endpoints.

import { ESPN_SITE, ESPN_HEADERS } from './_espn.js';

const TTL_MS = 15 * 60 * 1000;
const scheduleCache = new Map(); // teamId(string) -> { fetchedAt, schedule }

function mapStatus(competition) {
  const type = competition?.status?.type;
  if (!type) return { state: 'pre', completed: false, detail: null };
  return {
    state: type.state || 'pre',
    completed: type.completed || false,
    detail: type.shortDetail || type.detail || null,
  };
}

function normalizeEvent(event, teamIdStr) {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const self = competitors.find((c) => String(c.team?.id) === teamIdStr);
  const opp  = competitors.find((c) => String(c.team?.id) !== teamIdStr);
  if (!self || !opp) return null;

  const status   = mapStatus(competition);
  const finished = status.state === 'post' && status.completed;

  const selfScore = finished ? parseInt(self.score, 10) : null;
  const oppScore  = finished ? parseInt(opp.score,  10) : null;
  const scoresOk  = Number.isFinite(selfScore) && Number.isFinite(oppScore);

  let result = null;
  if (finished && scoresOk) {
    result = selfScore > oppScore ? 'W' : selfScore < oppScore ? 'L' : 'T';
  }

  const addr = competition.venue?.address;
  const venueCity = addr
    ? [addr.city, addr.state].filter(Boolean).join(', ')
    : null;

  return {
    id: `espn-${event.id}`,
    date: event.date || competition.date || null,
    status,
    homeAway: self.homeAway || null,
    neutralSite: competition.neutralSite || false,
    opponent: {
      id:           opp.team?.id ? String(opp.team.id) : null,
      name:         opp.team?.displayName || opp.team?.name || null,
      abbreviation: opp.team?.abbreviation || null,
      logo:         opp.team?.logo || null,
      rank:         opp.curatedRank?.current ?? null,
    },
    score: finished && scoresOk
      ? { self: selfScore, opp: oppScore, display: `${selfScore}-${oppScore}` }
      : null,
    result,
    venue:           competition.venue?.fullName || null,
    venueCity,
    broadcast:       competition.broadcasts?.[0]?.names?.[0] || null,
    isConference:    competition.conferenceCompetition || false,
    isExhibition:    false,
    tournamentTitle: null,
  };
}

export async function getEspnTeamSchedule(teamId) {
  const key = String(teamId);
  const cached = scheduleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.schedule;

  const r = await fetch(`${ESPN_SITE}/teams/${key}/schedule`, {
    headers: ESPN_HEADERS,
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`ESPN schedule HTTP ${r.status} for team ${key}`);
  const data = await r.json();

  const events = data.events || [];
  const schedule = [];
  for (const ev of events) {
    const norm = normalizeEvent(ev, key);
    if (norm) schedule.push(norm);
  }
  schedule.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

  const result = schedule.length > 0 ? schedule : null;
  scheduleCache.set(key, { fetchedAt: Date.now(), schedule: result });
  return result;
}
