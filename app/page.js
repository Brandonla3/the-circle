'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Trophy, TrendingUp, X, ChevronLeft, ChevronRight, Zap, Activity, Users } from 'lucide-react';
import { lookupConference } from './api/_conferences.js';

const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball';
const ESPN_WEBAPI = 'https://site.web.api.espn.com/apis/site/v2/sports/baseball/college-softball';
const proxy = (url) => `/api/espn?url=${encodeURIComponent(url)}`;

const fmtDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};
const prettyDate = (d) =>
  d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

export default function Page() {
  const [tab, setTab] = useState('scores');
  const [date, setDate] = useState(new Date());
  const [games, setGames] = useState([]);
  const [rankings, setRankings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [selectedGame, setSelectedGame] = useState(null);
  const [gameDetail, setGameDetail] = useState(null);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [error, setError] = useState(null);
  // Scoreboard filters: mode = 'all' | 'top25' | 'conference' | 'team'.
  // Conference/team filters store their selected value alongside so a single
  // URL-style `filter` object captures the whole scoreboard view state.
  const [filterMode, setFilterMode] = useState('all');
  const [filterConference, setFilterConference] = useState('');
  const [filterTeam, setFilterTeam] = useState('');
  const pollRef = useRef(null);
  // Ref so onGameRefresh can always see the current selectedGame without
  // being recreated on every render (which would reset the 15s interval).
  const selectedGameRef = useRef(null);

  const fetchScores = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      const r = await fetch(proxy(`${ESPN_SITE}/scoreboard?dates=${fmtDate(date)}&limit=200`));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const events = d.events || [];
      setGames(events);
      // Keep selectedGame in sync with the fresh scoreboard payload so the
      // live situation (base runners, count, outs) stays current even when
      // the game detail endpoint doesn't carry situation data.
      if (selectedGameRef.current) {
        const updated = events.find((g) => g.id === selectedGameRef.current.id);
        if (updated) setSelectedGame(updated);
      }
      if (!silent) setLastUpdate(new Date());
    } catch (e) { if (!silent) setError(e.message); }
    finally { if (!silent) setLoading(false); }
  }, [date]);

  const fetchRankings = useCallback(async () => {
    try {
      const r = await fetch(proxy(`${ESPN_SITE}/rankings`));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRankings(await r.json());
    } catch (e) { setError(e.message); }
  }, []);

  // silent=true keeps the existing detail visible while the refresh is
  // in-flight (no blink), used by the 15s live-refresh interval.
  const fetchGameDetail = useCallback(async (eventId, silent = false) => {
    if (!silent) setGameDetail(null);
    try {
      const r = await fetch(proxy(`${ESPN_WEBAPI}/summary?event=${eventId}`));
      const j = await r.json();
      setGameDetail(j);
    } catch (e) { if (!silent) setGameDetail({ error: e.message }); }
  }, []);

  useEffect(() => { fetchScores(); fetchRankings(); }, [fetchScores, fetchRankings]);

  // Derive hasLive as a boolean ref so the polling effect only re-fires when
  // the live/not-live state actually changes, not on every games array update.
  const hasLiveRef = useRef(false);
  const hasLive = games.some((g) => g.status?.type?.state === 'in');
  hasLiveRef.current = hasLive;

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (hasLive && tab === 'scores') {
      // 45s is fast enough for live softball updates without causing frequent
      // re-renders that visibly flash the background behind open modals.
      pollRef.current = setInterval(() => fetchScores(true), 45000);
    }
    return () => pollRef.current && clearInterval(pollRef.current);
  }, [hasLive, tab, fetchScores]);

  const shiftDate = (days) => { const d = new Date(date); d.setDate(d.getDate() + days); setDate(d); };
  const liveCount = games.filter((g) => g.status?.type?.state === 'in').length;
  const finalCount = games.filter((g) => g.status?.type?.state === 'post').length;

  // Build a conference + team index from the games list so the filter selects
  // reflect whatever's actually on the slate for the current date. Using
  // `team.location` is important — lookupConference expects a mascot-free name.
  const scoreboardIndex = React.useMemo(() => {
    const confs = new Set();
    const teams = new Map(); // canonical name -> { name, logo }
    for (const g of games) {
      const comp = g.competitions?.[0]; if (!comp) continue;
      for (const c of comp.competitors || []) {
        const t = c?.team; if (!t) continue;
        const conf = lookupConference(t.location) || lookupConference(t.displayName) || lookupConference(t.shortDisplayName);
        if (conf) confs.add(conf);
        const name = t.displayName || t.shortDisplayName;
        if (name && !teams.has(name)) teams.set(name, { name, logo: t.logos?.[0]?.href || t.logo || null });
      }
    }
    return {
      conferences: Array.from(confs).sort((a, b) => a.localeCompare(b)),
      teams: Array.from(teams.values()).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [games]);

  // Filter the games list down to what the user asked for. Each mode picks
  // competitors off the game and tests them; any-match wins so a Top-25 team
  // playing an unranked opponent still surfaces.
  const filteredGames = React.useMemo(() => {
    if (filterMode === 'all') return games;
    return games.filter((g) => {
      const comp = g.competitions?.[0]; if (!comp) return false;
      const competitors = comp.competitors || [];
      if (filterMode === 'top25') {
        return competitors.some((c) => {
          const rank = c?.curatedRank?.current;
          return typeof rank === 'number' && rank > 0 && rank <= 25;
        });
      }
      if (filterMode === 'conference') {
        if (!filterConference) return true;
        return competitors.some((c) => {
          const t = c?.team; if (!t) return false;
          const conf = lookupConference(t.location) || lookupConference(t.displayName) || lookupConference(t.shortDisplayName);
          return conf === filterConference;
        });
      }
      if (filterMode === 'team') {
        if (!filterTeam) return true;
        return competitors.some((c) => {
          const t = c?.team; if (!t) return false;
          return (t.displayName === filterTeam) || (t.shortDisplayName === filterTeam);
        });
      }
      return true;
    });
  }, [games, filterMode, filterConference, filterTeam]);

  // Reset the dependent filter value when switching modes so a stale
  // conference/team selection doesn't hide all games after a mode flip.
  const changeFilterMode = (next) => {
    setFilterMode(next);
    if (next !== 'conference') setFilterConference('');
    if (next !== 'team') setFilterTeam('');
  };

  // Keep the ref in sync so onGameRefresh can access the current game id
  // without being recreated (which would reset the modal's 15s interval).
  selectedGameRef.current = selectedGame;

  // Stable callbacks for GameModal — never recreated so the live interval
  // inside GameModal keeps its 15s cadence even when selectedGame updates.
  const onGameRefresh = useCallback(() => {
    if (selectedGameRef.current) fetchGameDetail(selectedGameRef.current.id, true);
  }, [fetchGameDetail]);
  const onGameClose = useCallback(() => {
    setSelectedGame(null);
    setGameDetail(null);
  }, []);

  return (
    <div className="min-h-screen w-full">
      <header className="relative border-b border-white/10" style={{ background: 'linear-gradient(180deg,#141210 0%,#0a0908 100%)' }}>
        <div className="max-w-7xl mx-auto px-6 py-8 relative">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="h-2 w-2 rounded-full" style={{ background: '#ff6b1a' }}></div>
                <span className="text-[10px] tracking-[0.3em] uppercase text-white/50 mono">NCAA Division I · Women's Softball</span>
              </div>
              <h1 className="display text-white text-6xl md:text-7xl font-black leading-none">
                The <em style={{ color: '#ff6b1a', fontStyle: 'italic' }}>Circle</em>.
              </h1>
              <p className="text-white/40 text-sm mt-3 max-w-md">A live scouting dashboard. Scores, rankings, and stats pulled direct from the source.</p>
            </div>
            <div className="flex items-center gap-3">
              {liveCount > 0 && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-full border border-red-500/30 bg-red-500/10">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-red-500"></span>
                  <span className="text-red-400 text-xs mono font-bold">{liveCount} LIVE</span>
                </div>
              )}
              <button onClick={() => { fetchScores(); fetchRankings(); }} className="p-2.5 rounded-full border border-white/10 hover:border-white/40 hover:bg-white/5 transition-all">
                <RefreshCw className={`h-4 w-4 text-white/70 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
          <nav className="flex gap-1 mt-10 border-b border-white/5 -mb-px overflow-x-auto">
            {[
              {id:'scores',label:'Scoreboard',icon:Zap},
              {id:'rankings',label:'Rankings',icon:Trophy},
              {id:'standings',label:'Standings',icon:Activity},
              {id:'leaders',label:'Players',icon:Users},
              {id:'stats',label:'Teams',icon:TrendingUp},
            ].map((t) => {
              const Icon = t.icon; const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} className={`relative px-5 py-3 flex items-center gap-2 text-sm transition-colors whitespace-nowrap ${active ? 'text-white' : 'text-white/40 hover:text-white/70'}`}>
                  <Icon className="h-3.5 w-3.5" />
                  <span className="tracking-wide uppercase text-xs font-semibold">{t.label}</span>
                  {active && <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ background: '#ff6b1a' }}></div>}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {error && (
          <div className="mb-6 p-4 rounded-lg border border-red-500/30 bg-red-500/5 text-red-300 text-sm">
            Error: {error}
          </div>
        )}

        {tab === 'scores' && (
          <div>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <button onClick={() => shiftDate(-1)} className="p-2 rounded-full border border-white/10 hover:border-white/30 text-white/60 hover:text-white transition"><ChevronLeft className="h-4 w-4" /></button>
                <div className="px-3 py-1.5 text-center min-w-[220px]">
                  <div className="text-[9px] mono tracking-[0.25em] uppercase text-white/40">{liveCount > 0 ? 'Live Now' : 'Date'}</div>
                  <div className="display text-white text-base md:text-lg">{prettyDate(date)}</div>
                </div>
                <button onClick={() => shiftDate(1)} className="p-2 rounded-full border border-white/10 hover:border-white/30 text-white/60 hover:text-white transition"><ChevronRight className="h-4 w-4" /></button>
                <button onClick={() => setDate(new Date())} className="ml-1 px-3 py-1.5 text-[10px] mono uppercase tracking-widest rounded-full border border-white/10 text-white/60 hover:text-white hover:border-white/30 transition">Today</button>
              </div>
              <div className="text-[9px] mono tracking-widest uppercase text-white/30">
                {lastUpdate && `Updated ${lastUpdate.toLocaleTimeString()}`} {liveCount > 0 && '· Auto 20s'}
              </div>
            </div>

            <ScoreboardFilterBar
              mode={filterMode}
              onChangeMode={changeFilterMode}
              conference={filterConference}
              onChangeConference={setFilterConference}
              team={filterTeam}
              onChangeTeam={setFilterTeam}
              conferenceOptions={scoreboardIndex.conferences}
              teamOptions={scoreboardIndex.teams}
              matchCount={filteredGames.length}
              totalCount={games.length}
            />

            {loading && games.length === 0 ? (
              <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading scoreboard…</div>
            ) : games.length === 0 ? (
              <div className="text-center py-20">
                <div className="display text-white/20 text-4xl mb-2">No games scheduled</div>
                <div className="text-white/40 text-sm">Try a different date — softball season runs Feb–June.</div>
              </div>
            ) : filteredGames.length === 0 ? (
              <div className="text-center py-16">
                <div className="display text-white/20 text-3xl mb-2">No games match this filter</div>
                <div className="text-white/40 text-sm">{games.length} games on this slate — try a different filter.</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {filteredGames.map((g, i) => (
                  <GameCard key={g.id} game={g} index={i} onClick={() => { setSelectedGame(g); fetchGameDetail(g.id); }} />
                ))}
              </div>
            )}

            {(liveCount > 0 || finalCount > 0) && (
              <div className="mt-8 pt-4 border-t border-white/5 flex gap-6 text-[9px] mono uppercase tracking-widest text-white/30">
                <span>{games.length} Total</span>
                <span className="text-red-400/60">{liveCount} Live</span>
                <span>{finalCount} Final</span>
                {filterMode !== 'all' && <span>· {filteredGames.length} Filtered</span>}
              </div>
            )}
          </div>
        )}

        {tab === 'rankings' && <RankingsView rankings={rankings} lastUpdate={lastUpdate} />}
        {tab === 'standings' && <StandingsView />}
        {tab === 'leaders' && <LeadersView onSelectPlayer={setSelectedPlayer} />}
        {tab === 'stats' && <StatsView onSelectTeam={setSelectedTeam} />}
      </main>

      {selectedGame && <GameModal game={selectedGame} detail={gameDetail} rankings={rankings} onRefresh={onGameRefresh} onClose={onGameClose} />}
      {selectedPlayer && <PlayerModal player={selectedPlayer} onClose={() => setSelectedPlayer(null)} />}
      {selectedTeam && <TeamModal team={selectedTeam} onClose={() => setSelectedTeam(null)} />}

      <footer className="border-t border-white/5 mt-16 py-6 px-6 text-center text-[10px] mono tracking-widest uppercase text-white/20">
        Data via ESPN & NCAA.com · Built for Daladier
      </footer>
    </div>
  );
}

function Diamond({ onFirst, onSecond, onThird, size = 64 }) {
  const lit = '#ff6b1a';
  const dim = 'rgba(255,255,255,0.12)';
  const stroke = 'rgba(255,255,255,0.35)';
  // Diamond rotated 45deg. Bases sit at the four points of the rhombus.
  // Home = bottom, 1B = right, 2B = top, 3B = left.
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-label="Baserunners">
      <polygon points="50,18 82,50 50,82 18,50" fill="none" stroke={stroke} strokeWidth="2" />
      {/* 2B (top) */}
      <rect x="42" y="10" width="16" height="16" transform="rotate(45 50 18)" fill={onSecond ? lit : dim} stroke={stroke} strokeWidth="1.5" />
      {/* 3B (left) */}
      <rect x="10" y="42" width="16" height="16" transform="rotate(45 18 50)" fill={onThird ? lit : dim} stroke={stroke} strokeWidth="1.5" />
      {/* 1B (right) */}
      <rect x="74" y="42" width="16" height="16" transform="rotate(45 82 50)" fill={onFirst ? lit : dim} stroke={stroke} strokeWidth="1.5" />
      {/* Home (bottom) */}
      <polygon points="50,74 58,82 50,90 42,82" fill="rgba(255,255,255,0.5)" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}

function CountOuts({ balls = 0, strikes = 0, outs = 0 }) {
  const Dot = ({ on, color }) => (
    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: on ? color : 'rgba(255,255,255,0.15)' }} />
  );
  return (
    <div className="flex flex-col gap-1 mono text-[10px] uppercase tracking-widest text-white/50">
      <div className="flex items-center gap-2">
        <span className="w-3">B</span>
        <span className="flex gap-1">{[0,1,2].map((i) => <Dot key={i} on={i < balls} color="#22c55e" />)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-3">S</span>
        <span className="flex gap-1">{[0,1].map((i) => <Dot key={i} on={i < strikes} color="#eab308" />)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-3">O</span>
        <span className="flex gap-1">{[0,1].map((i) => <Dot key={i} on={i < outs} color="#ef4444" />)}</span>
      </div>
    </div>
  );
}

// Filter bar that sits above the scoreboard grid. Three modes:
//   - top25: show only games where at least one team is ranked 1-25
//   - conference: show only games involving teams from the selected conference
//   - team: show only games involving the selected team
// The secondary select (conference/team) appears inline next to the mode
// pills when its mode is active, so the bar is compact on mobile. Uses a
// solid-dark select background so iOS Safari doesn't flash a white <option>
// panel — `colorScheme: 'dark'` alone isn't enough on older iOS versions.
function ScoreboardFilterBar({
  mode, onChangeMode,
  conference, onChangeConference,
  team, onChangeTeam,
  conferenceOptions, teamOptions,
  matchCount, totalCount,
}) {
  const modes = [
    { id: 'all',        label: 'All' },
    { id: 'top25',      label: 'Top 25' },
    { id: 'conference', label: 'Conference' },
    { id: 'team',       label: 'Team' },
  ];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex gap-1 p-1 rounded-full border border-white/10 bg-white/[0.02]">
        {modes.map((m) => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => onChangeMode(m.id)}
              className={`px-3 py-1.5 rounded-full text-[10px] mono uppercase tracking-widest transition ${active ? 'text-white' : 'text-white/40 hover:text-white/70'}`}
              style={active ? { background: '#ff6b1a' } : {}}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {mode === 'conference' && (
        <div className="relative">
          <select
            value={conference}
            onChange={(e) => onChangeConference(e.target.value)}
            className="appearance-none pl-3 pr-9 py-1.5 rounded-full border border-white/10 text-white text-[10px] mono uppercase tracking-widest cursor-pointer focus:outline-none focus:border-white/40"
            style={{ background: '#1a1815', colorScheme: 'dark' }}
          >
            <option value="" style={{ background: '#1a1815', color: 'white' }}>All Conferences</option>
            {conferenceOptions.map((c) => (
              <option key={c} value={c} style={{ background: '#1a1815', color: 'white' }}>{c}</option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-white/50">
            <svg width="8" height="5" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
        </div>
      )}

      {mode === 'team' && (
        <div className="relative">
          <select
            value={team}
            onChange={(e) => onChangeTeam(e.target.value)}
            className="appearance-none pl-3 pr-9 py-1.5 rounded-full border border-white/10 text-white text-[10px] mono uppercase tracking-widest cursor-pointer focus:outline-none focus:border-white/40 max-w-[240px]"
            style={{ background: '#1a1815', colorScheme: 'dark' }}
          >
            <option value="" style={{ background: '#1a1815', color: 'white' }}>All Teams</option>
            {teamOptions.map((t) => (
              <option key={t.name} value={t.name} style={{ background: '#1a1815', color: 'white' }}>{t.name}</option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-white/50">
            <svg width="8" height="5" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
        </div>
      )}

      <div className="ml-auto text-[9px] mono uppercase tracking-widest text-white/30">
        {mode === 'all' ? `${totalCount} games` : `${matchCount} of ${totalCount}`}
      </div>
    </div>
  );
}

function GameCard({ game, index, onClick }) {
  const comp = game.competitions?.[0]; if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === 'home');
  const away = comp.competitors?.find((c) => c.homeAway === 'away');
  const state = game.status?.type?.state;
  const detail = game.status?.type?.shortDetail || game.status?.type?.detail;
  const isLive = state === 'in'; const isFinal = state === 'post';
  const winner = isFinal ? (Number(home?.score) > Number(away?.score) ? 'home' : 'away') : null;

  const TeamRow = ({ team, side }) => {
    const t = team?.team || {};
    const rank = team?.curatedRank?.current;
    const dim = winner && winner !== side;
    return (
      <div className={`flex items-center justify-between py-1.5 ${dim ? 'opacity-40' : ''}`}>
        <div className="flex items-center gap-2 min-w-0">
          {t.logo && <img src={t.logo} alt="" className="h-5 w-5 object-contain flex-shrink-0" />}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {rank && rank < 99 && <span className="text-[9px] mono text-white/40">#{rank}</span>}
              <span className="text-white font-semibold truncate text-xs">{t.shortDisplayName || t.displayName}</span>
            </div>
            <div className="text-[9px] text-white/30 mono uppercase truncate">{team?.records?.[0]?.summary || ''}</div>
          </div>
        </div>
        <div className={`mono text-lg font-bold tabular-nums flex-shrink-0 pl-2 ${winner === side ? 'text-white' : 'text-white/70'}`}>{team?.score ?? '—'}</div>
      </div>
    );
  };

  // Glow when at least one team is ranked in the AP/USA Top 10.
  const homeRank = home?.curatedRank?.current;
  const awayRank = away?.curatedRank?.current;
  const isTop10 = (homeRank && homeRank <= 10) || (awayRank && awayRank <= 10);
  const coverageGlow = isTop10
    ? { boxShadow: '0 0 0 1px rgba(255,107,26,0.35), 0 0 24px -4px rgba(255,107,26,0.35)', borderColor: 'rgba(255,107,26,0.45)' }
    : {};

  return (
    <div
      onClick={onClick}
      className="card-enter group relative rounded-lg border border-white/10 bg-gradient-to-br from-white/[0.03] to-transparent p-3 cursor-pointer hover:border-white/30 hover:from-white/[0.06] transition-all"
      style={{ animationDelay: `${Math.min(index * 40, 400)}ms`, ...coverageGlow }}
    >
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {isLive && <span className="live-dot h-1.5 w-1.5 rounded-full bg-red-500 flex-shrink-0"></span>}
          <span className={`text-[9px] mono uppercase tracking-widest truncate ${isLive ? 'text-red-400' : isFinal ? 'text-white/50' : 'text-white/30'}`}>{detail}</span>
          {isTop10 && (
            <span className="text-[8px] mono uppercase tracking-widest px-1 py-0.5 rounded flex-shrink-0" style={{ background: 'rgba(255,107,26,0.12)', color: '#ff6b1a', border: '1px solid rgba(255,107,26,0.3)' }}>
              T10
            </span>
          )}
        </div>
        {comp.broadcasts?.[0]?.names?.[0] && <span className="text-[8px] mono uppercase text-white/30 flex-shrink-0 truncate max-w-[60px]">{comp.broadcasts[0].names[0]}</span>}
      </div>
      <div>
        <TeamRow team={away} side="away" />
        <div className="h-px bg-white/5"></div>
        <TeamRow team={home} side="home" />
      </div>
      {isLive && comp.situation && (
        <div className="mt-2 pt-2 border-t border-white/5 flex items-center gap-3">
          <Diamond
            onFirst={!!comp.situation.onFirst}
            onSecond={!!comp.situation.onSecond}
            onThird={!!comp.situation.onThird}
            size={40}
          />
          <CountOuts
            balls={comp.situation.balls}
            strikes={comp.situation.strikes}
            outs={comp.situation.outs}
          />
          <div className="flex-1 min-w-0">
            {comp.situation.batter?.athlete && (
              <div className="text-[9px] mono uppercase tracking-widest text-white/40">At Bat</div>
            )}
            {comp.situation.batter?.athlete && (
              <div className="text-white text-[11px] font-semibold truncate">{comp.situation.batter.athlete.shortName || comp.situation.batter.athlete.displayName}</div>
            )}
            {comp.situation.pitcher?.athlete && (
              <div className="text-white/50 text-[9px] mono truncate">P: {comp.situation.pitcher.athlete.shortName || comp.situation.pitcher.athlete.displayName}</div>
            )}
          </div>
        </div>
      )}
      {comp.venue?.fullName && (
        <div className="mt-2 pt-2 border-t border-white/5 text-[9px] text-white/30 mono uppercase tracking-wide truncate">
          {comp.venue.fullName}{comp.venue.address?.city ? ` · ${comp.venue.address.city}` : ''}
        </div>
      )}
    </div>
  );
}

// Normalize a team name for cross-source lookups (NCAA standings vs ESPN
// rankings vs scoreboard display names). Strips diacritics, punctuation,
// and common suffixes like "Aggies" / "Tigers" that vary between feeds.
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function RankingsView({ rankings, lastUpdate }) {
  if (!rankings) return <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading rankings…</div>;
  const polls = rankings.rankings || [];
  if (polls.length === 0) return <div className="text-center py-20 text-white/30">No rankings available (off-season).</div>;

  const formatUpdated = (poll) => {
    // ESPN's rankings payload puts the publish date in a few different shapes
    // depending on the poll; try each and fall back to our own fetch time.
    const raw = poll?.date || poll?.lastUpdated || poll?.publishDate || poll?.headline;
    const d = raw ? new Date(raw) : lastUpdate;
    if (!d || isNaN(d.getTime?.() ?? NaN)) return null;
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  };

  return (
    <div className="space-y-12">
      {polls.map((poll) => {
        const updated = formatUpdated(poll);
        return (
          <div key={poll.id || poll.name}>
            <div className="mb-6 flex items-end justify-between border-b border-white/10 pb-3">
              <div>
                <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40">Poll</div>
                <h2 className="display text-white text-3xl font-bold">D1 Softball Top 25</h2>
                {updated && <div className="text-white/40 text-xs mono mt-1">Last updated {updated}</div>}
              </div>
              {poll.shortName && <div className="text-white/30 text-xs mono">{poll.shortName}</div>}
            </div>
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full mono text-xs">
                <thead>
                  <tr className="bg-white/[0.02] text-white/40 uppercase tracking-wider">
                    <th className="text-left py-2 px-3 font-normal w-12">#</th>
                    <th className="text-left py-2 px-3 font-normal">Team</th>
                    <th className="text-center py-2 px-2 font-normal">Record</th>
                    <th className="text-center py-2 px-2 font-normal">Points</th>
                    <th className="text-center py-2 px-2 font-normal">Prev</th>
                    <th className="text-center py-2 px-2 font-normal">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {(poll.ranks || []).slice(0, 25).map((r, i) => {
                    const moved = typeof r.previous === 'number' && r.previous !== r.current;
                    const up = moved && r.previous > r.current;
                    return (
                      <tr key={r.team?.id || i} className="card-enter border-t border-white/5 hover:bg-white/[0.02]" style={{ animationDelay: `${i * 15}ms` }}>
                        <td className="py-2 px-3">
                          <span className={`display text-2xl font-black ${r.current <= 5 ? '' : 'text-white/40'}`} style={r.current <= 5 ? { color: '#ff6b1a' } : {}}>{r.current}</span>
                        </td>
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2 min-w-0">
                            {r.team?.logos?.[0]?.href && <img src={r.team.logos[0].href} alt="" className="h-5 w-5 object-contain" />}
                            <span className="text-white truncate">{r.team?.name || r.team?.displayName}</span>
                          </div>
                        </td>
                        <td className="text-center py-2 px-2 text-white/70 tabular-nums whitespace-nowrap">{r.recordSummary || '—'}</td>
                        <td className="text-center py-2 px-2 text-white/80 tabular-nums">{r.points?.toFixed?.(0) || r.points || '—'}</td>
                        <td className="text-center py-2 px-2 text-white/50 tabular-nums">{typeof r.previous === 'number' ? r.previous : '—'}</td>
                        <td className="text-center py-2 px-2 tabular-nums">
                          {moved ? (
                            <span className={`mono text-[11px] ${up ? 'text-emerald-400' : 'text-red-400'}`}>
                              {up ? '▲' : '▼'}{Math.abs(r.previous - r.current)}
                            </span>
                          ) : (
                            <span className="text-white/20">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Defaults for the Teams tab conference multi-filter. These are the "power
// four" D-I softball leagues — what most users care about out of the box.
// Users can add/remove via the filter dropdown; the selection is persisted
// in localStorage so it survives reloads.
const TEAMS_DEFAULT_CONFERENCES = ['SEC', 'Big 12', 'Big Ten', 'ACC'];
const TEAMS_CONF_STORAGE_KEY = 'teamsTab.conferenceFilter.v1';

function StatsView({ onSelectTeam }) {
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  // Selected conference names. `null` means "show all" — empty array is a
  // distinct state meaning "user explicitly cleared every filter".
  // Initial value is read lazily from localStorage so the first render
  // already has the user's saved selection (no flash of the default set).
  const [selectedConfs, setSelectedConfs] = useState(() => {
    if (typeof window === 'undefined') return TEAMS_DEFAULT_CONFERENCES;
    try {
      const raw = window.localStorage.getItem(TEAMS_CONF_STORAGE_KEY);
      if (raw == null) return TEAMS_DEFAULT_CONFERENCES;
      const parsed = JSON.parse(raw);
      if (parsed === null) return null; // explicit "all teams"
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return TEAMS_DEFAULT_CONFERENCES;
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(proxy(`${ESPN_SITE}/teams?limit=400`));
        const d = await r.json();
        const list = d.sports?.[0]?.leagues?.[0]?.teams || [];
        setTeams(list.map((x) => x.team).filter(Boolean));
      } catch (e) { setErr(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  // Persist selection whenever it changes. `null` (show all) is stored as
  // the literal "null" string so we can round-trip it cleanly.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(TEAMS_CONF_STORAGE_KEY, JSON.stringify(selectedConfs));
    } catch {}
  }, [selectedConfs]);

  // Click-outside to close the filter popover.
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e) => {
      if (filterRef.current && !filterRef.current.contains(e.target)) setFilterOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [filterOpen]);

  // Decorate every team with its canonical conference once, then derive
  // the per-conference histogram and the filtered list from that. Doing
  // this in one pass (instead of recomputing conference inside the JSX
  // map) keeps the filter dropdown totals in lockstep with the grid.
  const decorated = React.useMemo(() => {
    return teams.map((t) => ({
      team: t,
      conference:
        lookupConference(t.location) ||
        lookupConference(t.displayName) ||
        lookupConference(t.shortDisplayName) ||
        null,
    }));
  }, [teams]);

  const conferenceCounts = React.useMemo(() => {
    const counts = new Map();
    for (const { conference } of decorated) {
      const key = conference || '(No conference)';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [decorated]);

  const visible = React.useMemo(() => {
    if (selectedConfs === null) return decorated;
    if (selectedConfs.length === 0) return [];
    const set = new Set(selectedConfs);
    return decorated.filter(({ conference }) => conference && set.has(conference));
  }, [decorated, selectedConfs]);

  const toggleConf = (name) => {
    setSelectedConfs((prev) => {
      const base = prev === null ? [] : prev;
      if (base.includes(name)) return base.filter((c) => c !== name);
      return [...base, name];
    });
  };
  const selectAll = () => setSelectedConfs(null);
  const clearAll = () => setSelectedConfs([]);
  const resetDefaults = () => setSelectedConfs(TEAMS_DEFAULT_CONFERENCES);

  if (loading) return <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading teams…</div>;
  if (err) return <div className="text-center py-20 text-red-400">Error: {err}</div>;

  const filterLabel =
    selectedConfs === null
      ? 'All Conferences'
      : selectedConfs.length === 0
        ? 'No Conferences'
        : selectedConfs.length === 1
          ? selectedConfs[0]
          : `${selectedConfs.length} Conferences`;

  return (
    <div>
      <div className="mb-6 border-b border-white/10 pb-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40">Directory</div>
          <h2 className="display text-white text-3xl font-bold">
            D1 Teams <span className="text-white/30 text-lg">· {visible.length}{visible.length !== teams.length ? ` of ${teams.length}` : ''}</span>
          </h2>
          <p className="text-white/40 text-xs mt-1">Click any team to view its full roster.</p>
        </div>

        <div className="relative" ref={filterRef}>
          <button
            onClick={() => setFilterOpen((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 hover:border-white/30 text-white/70 hover:text-white text-[10px] mono uppercase tracking-widest transition"
            style={{ background: '#1a1815' }}
          >
            <span>Filter · {filterLabel}</span>
            <svg className="w-3 h-3 opacity-60" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
          {filterOpen && (
            <div
              className="absolute right-0 mt-2 w-72 rounded-lg border border-white/15 shadow-2xl z-20"
              style={{ background: '#1a1815' }}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <div className="text-[9px] mono uppercase tracking-widest text-white/40">Conferences</div>
                <div className="flex gap-2 text-[9px] mono uppercase tracking-widest">
                  <button onClick={selectAll} className="text-white/50 hover:text-white transition">All</button>
                  <span className="text-white/20">·</span>
                  <button onClick={clearAll} className="text-white/50 hover:text-white transition">None</button>
                  <span className="text-white/20">·</span>
                  <button onClick={resetDefaults} className="text-white/50 hover:text-white transition">Default</button>
                </div>
              </div>
              <div className="max-h-80 overflow-y-auto py-1">
                {conferenceCounts.map(([name, count]) => {
                  const checked = selectedConfs === null || (selectedConfs || []).includes(name);
                  const isUnknown = name === '(No conference)';
                  return (
                    <button
                      key={name}
                      onClick={() => !isUnknown && toggleConf(name)}
                      disabled={isUnknown}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-white/5 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className="w-3.5 h-3.5 flex-shrink-0 rounded border flex items-center justify-center"
                          style={checked ? { background: '#ff6b1a', borderColor: '#ff6b1a' } : { borderColor: 'rgba(255,255,255,0.25)' }}
                        >
                          {checked && (
                            <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                        </div>
                        <span className="text-white text-[11px] truncate">{name}</span>
                      </div>
                      <span className="text-white/30 text-[9px] mono ml-2">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">
          No teams match the current filter.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {visible.map(({ team: t, conference }, i) => (
            <button
              key={t.id}
              onClick={() => onSelectTeam && onSelectTeam(t)}
              className="card-enter flex items-center gap-3 p-3 rounded-lg border border-white/5 hover:border-white/30 hover:bg-white/[0.03] transition text-left"
              style={{ animationDelay: `${Math.min(i * 8, 600)}ms`, borderLeft: `3px solid ${t.color ? '#' + t.color : '#ff6b1a'}` }}
            >
              {t.logos?.[0]?.href && <img src={t.logos[0].href} alt="" className="h-8 w-8 object-contain flex-shrink-0" />}
              <div className="min-w-0">
                <div className="text-white text-xs font-semibold truncate">{t.shortDisplayName || t.displayName}</div>
                <div className="text-[9px] mono text-white/30 uppercase truncate">
                  {conference || t.abbreviation || '—'}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TEAM_MODAL_SUB_TABS = [
  { id: 'roster',   label: 'Roster' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'totals',   label: 'Team Totals' },
  { id: 'players',  label: 'Full Roster Stats' },
];

function TeamModal({ team, onClose }) {
  const [subTab, setSubTab] = useState('roster');
  const [roster, setRoster] = useState(null);
  const [rosterErr, setRosterErr] = useState(null);
  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);
  const [selectedPlayer, setSelectedPlayer] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setRoster(null); setRosterErr(null);
    setStats(null); setStatsErr(null);

    // Roster: Sidearm school sites (photos, full bio, every player on squad).
    fetch(`/api/team-roster?teamId=${encodeURIComponent(team.id)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || j.error) setRosterErr(j.error || `HTTP ${r.status}`);
        else setRoster(j);
      })
      .catch((e) => { if (!cancelled) setRosterErr(e.message); });

    // Stats: conference feeds (WMT/Sidearm stats tables).
    fetch(`/api/team-stats?teamId=${encodeURIComponent(team.id)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || j.error) setStatsErr(j.error || `HTTP ${r.status}`);
        else setStats(j);
      })
      .catch((e) => { if (!cancelled) setStatsErr(e.message); });

    return () => { cancelled = true; };
  }, [team.id]);

  // Esc closes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const logo = team?.logos?.[0]?.href;
  const displayName = team?.displayName;
  const abbrev = team?.abbreviation;
  const color = team?.color ? `#${team.color}` : '#ff6b1a';
  // Canonical conference from the NCAA Statistics table. Use the team prop's
  // own location/displayName because it's available before any fetch resolves.
  const conference =
    lookupConference(team?.location) ||
    lookupConference(team?.displayName) ||
    lookupConference(team?.shortDisplayName) ||
    null;


  // ---------------- Render helpers ----------------
  // Plain functions that return JSX — NOT `const Foo = () => ...` inner
  // components. Inner components create a new function identity every
  // parent render, which makes React unmount + remount the entire sub-
  // tree. That surfaced as the sub-tab reset loop in TeamCompareTab
  // (commit 89f70cd) and would do the same here the moment team-stats
  // resolves and triggers a re-render.

  const renderRosterView = () => {
    // Primary source: Sidearm school roster (full squad, photos, bio data).
    // Enrichment: stats players (from conference feed) fill in stats-only
    // players who didn't make the Sidearm roster cut.
    // Show loading until at least one source resolves.
    const sidearmAthletes = roster?.athletes;
    const sidearmAvailable = roster?.meta?.available;

    // Build a name→player map from stats for enrichment and fallback.
    const statsPlayerMap = new Map();
    if (stats?.players) {
      for (const p of [...(stats.players.batting || []), ...(stats.players.pitching || [])]) {
        if (p.name) statsPlayerMap.set(p.name.toLowerCase(), p);
      }
    }

    // Merge: start from Sidearm athletes, enrich with stats; then append
    // any stats-only players (appeared in stats but not on Sidearm roster).
    let source = null;
    if (sidearmAthletes && sidearmAthletes.length > 0) {
      const seenNames = new Set();
      const merged = sidearmAthletes.map((a) => {
        seenNames.add(a.name?.toLowerCase());
        const sp = statsPlayerMap.get(a.name?.toLowerCase());
        return {
          ...a,
          // Fill in stats fields so clicking opens a full PlayerModal
          side: (['P','RHP','LHP'].includes((a.position || '').toUpperCase())) ? 'pitching' : 'batting',
          games: sp?.games ?? null, AB: sp?.AB ?? null, H: sp?.H ?? null,
          R: sp?.R ?? null, HR: sp?.HR ?? null, RBI: sp?.RBI ?? null,
          BB: sp?.BB ?? null, K: sp?.K ?? null, SB: sp?.SB ?? null,
          '2B': sp?.['2B'] ?? null, '3B': sp?.['3B'] ?? null,
          BA: sp?.BA ?? null, OBP: sp?.OBP ?? null, SLG: sp?.SLG ?? null,
          IP: sp?.IP ?? null, W: sp?.W ?? null, L: sp?.L ?? null,
          SV: sp?.SV ?? null, SHO: sp?.SHO ?? null, ERA: sp?.ERA ?? null,
          WHIP: sp?.WHIP ?? null, 'K/7': sp?.['K/7'] ?? null,
        };
      });
      // Append stats-only players not on Sidearm roster
      for (const sp of statsPlayerMap.values()) {
        if (!seenNames.has(sp.name?.toLowerCase())) {
          merged.push({ ...sp, side: sp.side || 'batting' });
        }
      }
      source = merged;
    } else if (statsPlayerMap.size > 0) {
      // No Sidearm roster — fall back to stats players only
      source = Array.from(statsPlayerMap.values()).map((p) => ({
        ...p,
        side: (['P','RHP','LHP'].includes((p.position || '').toUpperCase())) ? 'pitching' : 'batting',
      }));
    }

    // Still loading: both fetches pending
    if (!source && !rosterErr && !statsErr) {
      return <div className="text-center py-12 text-white/30 mono text-xs tracking-widest uppercase">Loading roster…</div>;
    }
    // No data at all
    if (!source || source.length === 0) {
      const note = roster?.meta?.note;
      return (
        <div className="text-center py-12">
          <div className="text-white/40 text-sm mb-2">Roster not available.</div>
          <div className="text-white/30 text-xs mono">{note || rosterErr || statsErr || 'No roster data from conference site.'}</div>
        </div>
      );
    }

    // Group by position bucket.
    const buckets = {
      Pitchers: [],
      Catchers: [],
      Infielders: [],
      Outfielders: [],
      'Utility / Other': [],
    };
    for (const p of source) {
      const pos = (p.position || '').toUpperCase();
      if (['P','RHP','LHP'].includes(pos)) buckets.Pitchers.push(p);
      else if (pos === 'C') buckets.Catchers.push(p);
      else if (['1B','2B','3B','SS','IF'].includes(pos)) buckets.Infielders.push(p);
      else if (['OF','LF','CF','RF'].includes(pos)) buckets.Outfielders.push(p);
      else buckets['Utility / Other'].push(p);
    }
    // Sort each bucket by jersey number ascending; null jersey sorts last.
    for (const list of Object.values(buckets)) {
      list.sort((a, b) => {
        const aj = parseInt(a.jersey ?? '999', 10);
        const bj = parseInt(b.jersey ?? '999', 10);
        return aj - bj || (a.name || '').localeCompare(b.name || '');
      });
    }

    return (
      <div className="space-y-8">
        {/* Legend */}
        <div className="flex items-center gap-5 text-[10px] mono text-white/40">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm flex-shrink-0" style={{background:'rgba(176,148,96,0.25)',border:'1px solid rgba(176,148,96,0.5)'}} />
            Senior
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm flex-shrink-0" style={{background:'rgba(160,32,32,0.25)',border:'1px solid rgba(160,32,32,0.5)'}} />
            Freshman
          </div>
        </div>
        {Object.entries(buckets).map(([label, list]) => {
          if (list.length === 0) return null;
          return (
            <div key={label}>
              <div className="text-[10px] mono tracking-[0.25em] uppercase text-white/40 mb-3">
                {label} <span className="text-white/20">· {list.length}</span>
              </div>
              <div className="overflow-x-auto rounded-lg border border-white/5">
                <table className="w-full mono text-xs">
                  <thead>
                    <tr className="bg-white/[0.02] text-white/40 uppercase tracking-wider">
                      <th className="text-left py-2 px-3 font-normal w-10">#</th>
                      <th className="text-left py-2 px-3 font-normal">Player</th>
                      <th className="text-center py-2 px-2 font-normal">Pos</th>
                      <th className="text-center py-2 px-2 font-normal">Class</th>
                      <th className="text-center py-2 px-2 font-normal">B/T</th>
                      <th className="text-center py-2 px-2 font-normal">Ht</th>
                      <th className="text-center py-2 px-2 font-normal">Wt</th>
                      <th className="text-left py-2 px-3 font-normal">Hometown</th>
                      <th className="text-left py-2 px-3 font-normal">Prep</th>
                      <th className="text-left py-2 px-3 font-normal">Transfer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => {
                      // Normalize fields across stats-player and ESPN-athlete shapes.
                      const playerName = p.name || p.displayName || '';
                      const jersey    = p.jersey ?? null;
                      const pos       = p.position || '';
                      const cls       = p.classYear || null;
                      // batThrows: stats players have a combined field; ESPN has separate bats/throws.
                      const bt        = p.batThrows || ([p.bats, p.throws].filter(Boolean).join('/')) || null;
                      const ht        = p.heightDisplay || null;
                      const wt        = p.weight || p.weightDisplay || null;
                      // hometown: stats players have p.hometown; ESPN athletes have p.birthPlace (already a string).
                      const hometown  = p.hometown || p.birthPlace || null;
                      const side      = (['P','RHP','LHP'].includes(pos.toUpperCase())) ? 'pitching' : 'batting';
                      return (
                        <tr key={p.id || playerName} style={classYearStyle(cls)} className="border-t border-white/5 hover:bg-white/[0.02]">
                          <td className="py-2 px-3 text-white/50 tabular-nums">{jersey || '—'}</td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-2">
                              {p.photoUrl ? (
                                <img
                                  src={p.photoUrl}
                                  alt={playerName}
                                  className="h-7 w-7 rounded-full object-cover flex-shrink-0 border border-white/10"
                                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                />
                              ) : (
                                <div className="h-7 w-7 rounded-full bg-white/5 flex-shrink-0" />
                              )}
                              <span
                                className="text-white whitespace-nowrap cursor-pointer hover:text-white/70"
                                onClick={() => setSelectedPlayer({
                                  name: playerName,
                                  team: displayName,
                                  side,
                                  jersey,
                                  photoUrl: p.photoUrl || null,
                                  position: pos || null,
                                  classYear: cls,
                                  hometown,
                                  highSchool: p.highSchool || null,
                                  previousSchool: p.previousSchool || null,
                                  heightDisplay: ht,
                                  weight: wt,
                                  batThrows: bt,
                                })}
                              >
                                {playerName}
                              </span>
                            </div>
                          </td>
                          <td className="text-center py-2 px-2 text-white/60">{pos || '—'}</td>
                          <td className="text-center py-2 px-2 text-white/60">{cls || '—'}</td>
                          <td className="text-center py-2 px-2 text-white/50">{bt || '—'}</td>
                          <td className="text-center py-2 px-2 text-white/50">{ht || '—'}</td>
                          <td className="text-center py-2 px-2 text-white/50">{wt || '—'}</td>
                          <td className="py-2 px-3 text-white/50 truncate max-w-[180px]">{hometown || '—'}</td>
                          <td className="py-2 px-3 text-white/50 truncate max-w-[160px]">{p.highSchool || '—'}</td>
                          <td className="py-2 px-3 text-white/50 whitespace-nowrap">
                            {p.previousSchool
                              ? <span className="text-orange-400 text-[11px] font-medium">{p.previousSchool}</span>
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderTotalsView = () => renderSingleTeamTotals(stats, statsErr);

  const renderScheduleView = () => {
    if (statsErr) {
      return (
        <div className="text-center py-12">
          <div className="text-white/40 text-sm mb-2">Couldn't load schedule.</div>
          <div className="text-white/30 text-xs mono">{statsErr}</div>
        </div>
      );
    }
    if (!stats) {
      return <div className="text-center py-12 text-white/30 mono text-xs tracking-widest uppercase">Loading schedule…</div>;
    }
    return renderTeamSchedule(stats);
  };

  const renderPlayersView = () => {
    if (statsErr) {
      return (
        <div className="text-center py-12">
          <div className="text-white/40 text-sm mb-2">Couldn't load player stats.</div>
          <div className="text-white/30 text-xs mono">{statsErr}</div>
        </div>
      );
    }
    if (!stats) {
      return <div className="text-center py-12 text-white/30 mono text-xs tracking-widest uppercase">Loading full roster stats…</div>;
    }
    // When a rich conference feed (WMT-hosted conferences like SEC, Mountain
    // West) is available, render the full-roster tables with every column
    // the source publishes. Otherwise fall back to the narrow per-stat
    // tables built from WMT's normalized shape.
    if (stats.conferenceStats) {
      return renderWmtFullRoster(stats.conferenceStats);
    }
    return (
      <div className="space-y-6">
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Batters</div>
          {renderPlayerTable(stats, 'batting', (p) => setSelectedPlayer({ ...p, team: p.team || displayName }))}
        </div>
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Pitchers</div>
          {renderPlayerTable(stats, 'pitching', (p) => setSelectedPlayer({ ...p, team: p.team || displayName }))}
        </div>
        <div className="text-[10px] mono text-white/30 text-center">
          Stats from NCAA leaderboards + full school roster via Sidearm. Click any player for their profile.
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-2xl border border-white/10" style={{ background: '#141210' }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="sticky top-4 float-right mr-4 z-10 p-2 rounded-full bg-black/40 hover:bg-white/10 text-white/60 hover:text-white">
          <X className="h-4 w-4" />
        </button>

        <div className="px-6 pt-6 pb-5 border-b border-white/10" style={{ borderTop: `3px solid ${color}` }}>
          <div className="flex items-center gap-4">
            {logo && (
              <img
                src={logo}
                alt=""
                className="h-14 w-14 object-contain flex-shrink-0"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-1">
                {conference || 'Team'}
              </div>
              <div className="display text-white text-3xl font-bold leading-tight truncate">{displayName || 'Team'}</div>
              <div className="text-white/50 text-xs mono mt-1">
                {abbrev && <span>{abbrev}</span>}
                {stats?.players && <span className="text-white/30"> · {[...(stats.players.batting||[]), ...(stats.players.pitching||[])].length} players</span>}
                {stats?.teamMeta?.wins != null && stats?.teamMeta?.losses != null && (
                  <span className="text-white/30"> · {stats.teamMeta.wins}-{stats.teamMeta.losses}</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 pt-5 pb-1 flex justify-center">
          <div className="flex gap-1 p-1 rounded-full border border-white/10 bg-white/[0.02] w-fit">
            {TEAM_MODAL_SUB_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setSubTab(t.id)}
                className={`px-4 py-1.5 rounded-full text-[10px] mono uppercase tracking-widest transition ${subTab === t.id ? 'text-white' : 'text-white/40 hover:text-white/70'}`}
                style={subTab === t.id ? { background: '#ff6b1a' } : {}}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6">
          {subTab === 'roster' && renderRosterView()}
          {subTab === 'schedule' && renderScheduleView()}
          {subTab === 'totals' && renderTotalsView()}
          {subTab === 'players' && renderPlayersView()}
        </div>

        <div className="px-6 pb-6 pt-4 border-t border-white/5 text-[10px] mono uppercase tracking-widest text-white/30 text-center">
          Data via conference sites · Press Esc to close
        </div>
      </div>
      {selectedPlayer && (
        <PlayerModal
          player={selectedPlayer}
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </div>
  );
}

function GameModal({ game, detail, rankings, onRefresh, onClose }) {
  const isLive = game.status?.type?.state === 'in';
  const [modalTab, setModalTab] = useState(isLive ? 'live' : 'linescore');
  const comp = game.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === 'home');
  const away = comp?.competitors?.find((c) => c.homeAway === 'away');

  // Auto-refresh while live
  useEffect(() => {
    if (!isLive || !onRefresh) return;
    const id = setInterval(onRefresh, 15000);
    return () => clearInterval(id);
  }, [isLive, onRefresh]);

  // Detect what coverage ESPN actually returned for this game so we can hide
  // tabs that would just show "not available." Linescore is always shown
  // because it's built from the scoreboard payload.
  const hasSituation = !!(detail?.situation || comp?.situation);
  const hasBox = (detail?.boxscore?.players || []).some((t) => (t.statistics || []).some((s) => (s.athletes || []).length));
  const hasPlays = (detail?.plays || []).length > 0;
  const hasScoring = (detail?.scoringPlays || (detail?.plays || []).filter((p) => p.scoringPlay)).length > 0;
  const hasWinProb = (detail?.winprobability || []).length > 0;
  const hasInfo = !!(detail?.gameInfo || detail?.pickcenter);
  // If the summary hasn't loaded yet, optimistically show all tabs so they don't flicker.
  const loaded = !!detail && !detail.error;

  const tabs = [
    ...(isLive && (hasSituation || !loaded) ? [{ id: 'live', label: 'Live' }] : []),
    { id: 'linescore', label: 'Linescore' },
    ...(!loaded || hasBox ? [{ id: 'box', label: 'Box Score' }] : []),
    ...(!loaded || hasPlays ? [{ id: 'pbp', label: 'Play-by-Play' }] : []),
    ...(!loaded || hasScoring ? [{ id: 'scoring', label: 'Scoring Plays' }] : []),
    ...(!loaded || hasWinProb ? [{ id: 'winprob', label: 'Win Probability' }] : []),
    { id: 'compare', label: 'Team Compare' },
    { id: 'players', label: 'Player Compare' },
    ...(!loaded || hasInfo ? [{ id: 'info', label: 'Game Info' }] : []),
  ];

  // If the active tab got hidden after data loaded, fall back to linescore.
  useEffect(() => {
    if (loaded && !tabs.find((t) => t.id === modalTab)) setModalTab('linescore');
  }, [loaded, tabs, modalTab]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl border border-white/10" style={{ background: '#141210' }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="sticky top-4 float-right mr-4 z-10 p-2 rounded-full bg-black/40 hover:bg-white/10 text-white/60 hover:text-white">
          <X className="h-4 w-4" />
        </button>

        <div className="px-6 pt-6 pb-4">
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-1">{game.status?.type?.shortDetail}</div>
          <div className="display text-white text-2xl md:text-3xl font-bold mb-1">
            {away?.team?.displayName} <span className="text-white/30">@</span> {home?.team?.displayName}
          </div>
          <div className="mono text-white/40 text-sm">
            {away?.team?.abbreviation} {away?.score ?? '—'} <span className="text-white/20 mx-2">·</span> {home?.team?.abbreviation} {home?.score ?? '—'}
          </div>
        </div>

        <div className="px-6 border-b border-white/10 flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setModalTab(t.id)}
              className={`relative px-4 py-3 text-[11px] mono uppercase tracking-widest whitespace-nowrap transition-colors ${modalTab === t.id ? 'text-white' : 'text-white/40 hover:text-white/70'}`}
            >
              {t.label}
              {modalTab === t.id && <div className="absolute bottom-0 left-0 right-0 h-0.5" style={{ background: '#ff6b1a' }}></div>}
            </button>
          ))}
        </div>

        <div className="p-6">
          {!detail ? (
            <div className="text-center py-12 text-white/30 mono text-xs tracking-widest uppercase">Loading game data…</div>
          ) : detail.error ? (
            <div className="text-center py-12 text-red-400 text-sm">Error: {detail.error}</div>
          ) : (
            <>
              {loaded && tabs.length <= 2 && (
                <div className="mb-4 p-3 rounded-lg border border-white/10 bg-white/[0.02] text-[11px] text-white/50">
                  ESPN has limited coverage for this game — only the linescore is available. Box score, play-by-play, and live situation data are typically only published for televised games.
                </div>
              )}
              {modalTab === 'live' && <LiveTab game={game} detail={detail} />}
              {modalTab === 'linescore' && <LinescoreTab home={home} away={away} detail={detail} />}
              {modalTab === 'box' && <BoxScoreTab detail={detail} />}
              {modalTab === 'pbp' && <PlayByPlayTab detail={detail} />}
              {modalTab === 'scoring' && <ScoringPlaysTab detail={detail} />}
              {modalTab === 'winprob' && <WinProbabilityTab detail={detail} />}
              {modalTab === 'compare' && <TeamCompareTab home={home} away={away} rankings={rankings} />}
              {modalTab === 'players' && <PlayerCompareTab home={home} away={away} rankings={rankings} />}
              {modalTab === 'info' && <GameInfoTab detail={detail} />}
            </>
          )}
        </div>

        {comp?.venue?.fullName && (
          <div className="px-6 pb-6 pt-4 border-t border-white/5 text-[10px] mono uppercase tracking-widest text-white/30">
            {comp.venue.fullName}{comp.venue.address?.city ? ` · ${comp.venue.address.city}, ${comp.venue.address.state || ''}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

function LinescoreTab({ home, away, detail }) {
  const maxInnings = Math.max(home?.linescores?.length || 0, away?.linescores?.length || 0, 7);
  const innings = Array.from({ length: maxInnings }, (_, i) => i + 1);
  return (
    <div>
      <div className="overflow-x-auto mb-6">
        <table className="w-full mono text-sm">
          <thead>
            <tr className="text-white/30 text-[10px] uppercase tracking-widest">
              <th className="text-left py-2 pr-4">Team</th>
              {innings.map((i) => <th key={i} className="px-2 text-center w-8">{i}</th>)}
              <th className="px-2 text-center font-bold text-white/60">R</th>
              <th className="px-2 text-center text-white/60">H</th>
              <th className="px-2 text-center text-white/60">E</th>
            </tr>
          </thead>
          <tbody>
            {[away, home].map((t, ti) => (
              <tr key={ti} className="border-t border-white/5">
                <td className="py-2 pr-4 text-white font-semibold">{t?.team?.abbreviation || t?.team?.shortDisplayName}</td>
                {innings.map((i) => { const ls = t?.linescores?.[i - 1]; return <td key={i} className="px-2 text-center text-white/70">{ls?.value ?? ''}</td>; })}
                <td className="px-2 text-center text-white font-bold">{t?.score ?? '—'}</td>
                <td className="px-2 text-center text-white/60">{t?.hits ?? '—'}</td>
                <td className="px-2 text-center text-white/60">{t?.errors ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail?.leaders && detail.leaders.length > 0 && (
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Game Leaders</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {detail.leaders.slice(0, 2).map((teamLeaders, idx) => (
              <div key={idx} className="space-y-2">
                <div className="text-white/70 text-xs font-semibold">{teamLeaders.team?.displayName}</div>
                {(teamLeaders.leaders || []).slice(0, 4).map((cat, j) => {
                  const l = cat.leaders?.[0]; if (!l) return null;
                  return (
                    <div key={j} className="flex items-center justify-between text-xs py-1.5 border-b border-white/5">
                      <span className="text-white/40 uppercase mono text-[10px]">{cat.shortDisplayName}</span>
                      <span className="text-white">{l.athlete?.shortName} <span className="mono text-white/50 ml-2">{l.displayValue}</span></span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BoxScoreTab({ detail }) {
  const players = detail?.boxscore?.players || [];
  if (players.length === 0) return <EmptyState text="Box score not available for this game." />;
  return (
    <div className="space-y-8">
      {players.map((teamData, ti) => {
        const teamName = teamData.team?.displayName || teamData.team?.name;
        return (
          <div key={ti}>
            <div className="display text-white text-xl font-bold mb-3 flex items-center gap-2">
              {teamData.team?.logo && <img src={teamData.team.logo} alt="" className="h-6 w-6" />}
              {teamName}
            </div>
            {(teamData.statistics || []).map((statGroup, sgi) => {
              const labels = statGroup.labels || [];
              const athletes = statGroup.athletes || [];
              const groupName = statGroup.name || statGroup.text || (sgi === 0 ? 'Batting' : 'Pitching');
              if (athletes.length === 0) return null;
              return (
                <div key={sgi} className="mb-5">
                  <div className="text-[10px] mono tracking-[0.25em] uppercase text-white/40 mb-2">{groupName}</div>
                  <div className="overflow-x-auto rounded-lg border border-white/5">
                    <table className="w-full mono text-xs">
                      <thead>
                        <tr className="bg-white/[0.02]">
                          <th className="text-left py-2 px-3 text-white/40 font-normal uppercase tracking-wider">Player</th>
                          {labels.map((lbl, li) => (
                            <th key={li} className="text-center py-2 px-2 text-white/40 font-normal uppercase tracking-wider">{lbl}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {athletes.map((a, ai) => (
                          <tr key={ai} className="border-t border-white/5 hover:bg-white/[0.02]">
                            <td className="py-2 px-3 text-white whitespace-nowrap">
                              {a.athlete?.shortName || a.athlete?.displayName}
                              {a.position?.abbreviation && <span className="text-white/30 ml-2 text-[10px]">{a.position.abbreviation}</span>}
                            </td>
                            {(a.stats || []).map((s, si) => (
                              <td key={si} className="text-center py-2 px-2 text-white/80 tabular-nums">{s}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function PlayByPlayTab({ detail }) {
  const plays = detail?.plays || [];
  if (plays.length === 0) return <EmptyState text="Play-by-play not available for this game." />;
  const byPeriod = {};
  plays.forEach((p) => {
    const period = p.period?.displayValue || p.period?.number || 'Unknown';
    if (!byPeriod[period]) byPeriod[period] = [];
    byPeriod[period].push(p);
  });
  return (
    <div className="space-y-6">
      {Object.entries(byPeriod).map(([period, periodPlays]) => (
        <div key={period}>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-2 sticky top-0 bg-[#141210] py-1">{period}</div>
          <div className="space-y-2">
            {periodPlays.map((p, i) => (
              <div key={p.id || i} className={`p-3 rounded-lg border text-xs ${p.scoringPlay ? 'border-orange-500/30 bg-orange-500/5' : 'border-white/5 bg-white/[0.02]'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="text-white/80 flex-1">{p.text}</div>
                  {p.scoringPlay && (
                    <div className="mono text-[10px] whitespace-nowrap" style={{ color: '#ff6b1a' }}>
                      {p.awayScore}–{p.homeScore}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScoringPlaysTab({ detail }) {
  const plays = detail?.scoringPlays || (detail?.plays || []).filter((p) => p.scoringPlay);
  if (!plays || plays.length === 0) return <EmptyState text="No scoring plays recorded yet." />;
  return (
    <div className="space-y-3">
      {plays.map((p, i) => (
        <div key={p.id || i} className="p-4 rounded-lg border border-white/10 bg-gradient-to-br from-orange-500/[0.04] to-transparent">
          <div className="flex items-start justify-between gap-4 mb-2">
            <div className="text-[10px] mono tracking-widest uppercase text-white/40">{p.period?.displayValue || `Inning ${p.period?.number || ''}`}</div>
            <div className="mono text-sm font-bold" style={{ color: '#ff6b1a' }}>{p.awayScore}–{p.homeScore}</div>
          </div>
          <div className="text-white text-sm">{p.text}</div>
          {p.team?.displayName && <div className="text-[10px] text-white/30 mono uppercase mt-2">{p.team.displayName}</div>}
        </div>
      ))}
    </div>
  );
}

function WinProbabilityTab({ detail }) {
  const wp = detail?.winprobability || [];
  if (wp.length === 0) return <EmptyState text="Win probability data not available for this game." />;
  const w = 800, h = 240, pad = 30;
  const points = wp.map((p, i) => ({
    x: pad + (i / Math.max(wp.length - 1, 1)) * (w - pad * 2),
    y: pad + (1 - (p.homeWinPercentage ?? 0.5)) * (h - pad * 2),
  }));
  const path = points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');
  const areaPath = `${path} L ${points[points.length - 1].x} ${h - pad} L ${pad} ${h - pad} Z`;
  const homeName = detail?.boxscore?.teams?.find((t) => t.homeAway === 'home')?.team?.abbreviation || 'HOME';
  const awayName = detail?.boxscore?.teams?.find((t) => t.homeAway === 'away')?.team?.abbreviation || 'AWAY';
  return (
    <div>
      <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-4">Home Win Probability</div>
      <div className="rounded-xl border border-white/10 p-4 bg-white/[0.02]">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto">
          <line x1={pad} x2={w - pad} y1={h / 2} y2={h / 2} stroke="rgba(255,255,255,0.1)" strokeDasharray="4 4" />
          <text x={pad + 4} y={h / 2 - 4} fill="rgba(255,255,255,0.3)" fontSize="10" fontFamily="monospace">50%</text>
          <text x={pad} y={pad - 8} fill="rgba(255,255,255,0.5)" fontSize="11" fontFamily="monospace">{homeName} 100%</text>
          <text x={pad} y={h - 8} fill="rgba(255,255,255,0.5)" fontSize="11" fontFamily="monospace">{awayName} 100%</text>
          <path d={areaPath} fill="#ff6b1a" fillOpacity="0.12" />
          <path d={path} fill="none" stroke="#ff6b1a" strokeWidth="2.5" strokeLinejoin="round" />
        </svg>
        <div className="mt-3 text-[10px] mono uppercase tracking-widest text-white/30 text-center">{wp.length} plays tracked</div>
      </div>
    </div>
  );
}

// --- Shared render helpers -------------------------------------------------
// Lowercase functions that return JSX, NOT `const Foo = () => ...` inner
// components. The latter pattern gives React a new function identity on
// every parent render which unmounts/remounts the whole inner tree — that
// was the bug fixed in commit 89f70cd for TeamCompareTab, and TeamModal
// runs into the exact same trap once it grows sub-tabs. Keeping these at
// module scope means both components can share them without either
// accidentally recreating the tree.

const fmtOrDash = (v) => (v == null || v === '' ? '—' : v);

// Empty-state copy for the player-stats table. NCAA-aware: reads the new
// meta.ncaaPlayerStats block the team-stats route emits so we can explain
// *why* a team has zero rows (timed out, partial scan, genuinely no top-50
// appearances) rather than the misleading "ESPN box-score" wording the old
// ESPN-sourced path used.
function playerTableEmptyDetail(stats, group) {
  const ps = stats?.meta?.ncaaPlayerStats;
  if (!ps) return 'No player stats available for this team.';
  if (ps.error) return ps.error;
  if (ps.timeExhausted) return 'NCAA leaderboard scan timed out; refresh to retry.';
  if (ps.slugsOk != null && ps.attempted != null && ps.slugsOk < ps.attempted) {
    return `Partial NCAA scan: only ${ps.slugsOk}/${ps.attempted} leaderboards fetched.`;
  }
  if (ps.playerCount === 0) {
    return 'No players from this team appear in any NCAA top-50 individual leaderboard.';
  }
  const side = group === 'batting' ? 'batting' : 'pitching';
  return `No ${side} entries from this team in the top-50 ${side} leaderboards.`;
}

// Render one team's batting or pitching table. Used by both the Team
// Compare tab (side-by-side for home/away) and the Team modal (single
// column). Pitching columns surface {G, IP, K, W, ERA, SHO} — NCAA
// individual leaderboards don't ship raw BB (walks allowed) or a working
// WHIP for softball at the individual level, so those were dropped from
// the column set rather than displayed as permanent dashes.
// Returns an inline style object that applies a dim background tint to table rows
// for Seniors (warm silver) and Freshmen (dim red). Applies to all player tables
// and the roster view so class status is scannable at a glance.
function classYearStyle(classYear) {
  const yr = (classYear || '').trim().toLowerCase().replace(/\.$/, '');
  if (yr === 'sr' || yr === 'senior')
    return { background: 'rgba(176, 148, 96, 0.07)', borderLeft: '2px solid rgba(176, 148, 96, 0.22)' };
  if (yr === 'fr' || yr === 'freshman')
    return { background: 'rgba(160, 32, 32, 0.07)', borderLeft: '2px solid rgba(160, 32, 32, 0.22)' };
  return {};
}

function renderPlayerTable(stats, group, onSelectPlayer) {
  const rows = stats?.players?.[group] || [];
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-white/5 bg-white/[0.01] p-4 text-center">
        <div className="text-white/40 text-xs mb-1">No player stats</div>
        <div className="text-white/30 text-[10px] mono">{playerTableEmptyDetail(stats, group)}</div>
      </div>
    );
  }
  const isBatting = group === 'batting';
  return (
    <div className="overflow-x-auto rounded-lg border border-white/5">
      <table className="w-full mono text-[11px]">
        <thead>
          <tr className="bg-white/[0.02] text-white/40 uppercase tracking-wider">
            <th className="text-left py-1.5 px-2 font-normal">Player</th>
            <th className="text-center py-1.5 px-1 font-normal">G</th>
            {isBatting ? (
              <>
                <th className="text-center py-1.5 px-1 font-normal">AB</th>
                <th className="text-center py-1.5 px-1 font-normal">H</th>
                <th className="text-center py-1.5 px-1 font-normal">HR</th>
                <th className="text-center py-1.5 px-1 font-normal">RBI</th>
                <th className="text-center py-1.5 px-1 font-normal">BA</th>
              </>
            ) : (
              <>
                <th className="text-center py-1.5 px-1 font-normal">IP</th>
                <th className="text-center py-1.5 px-1 font-normal">K</th>
                <th className="text-center py-1.5 px-1 font-normal">W</th>
                <th className="text-center py-1.5 px-1 font-normal">ERA</th>
                <th className="text-center py-1.5 px-1 font-normal">SHO</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr
              key={p.id}
              style={classYearStyle(p.classYear)}
              className={`border-t border-white/5 hover:bg-white/[0.02]${onSelectPlayer ? ' cursor-pointer hover:bg-white/[0.04]' : ''}`}
              onClick={onSelectPlayer ? () => onSelectPlayer({
                // identity + display
                name: p.name,
                team: p.team,
                side: group,
                jersey: p.jersey,
                photoUrl: p.photoUrl,
                position: p.position,
                classYear: p.classYear,
                hometown: p.hometown || null,
                highSchool: p.highSchool || null,
                previousSchool: p.previousSchool || null,
                heightDisplay: p.heightDisplay || null,
                weight: p.weight || null,
                batThrows: p.batThrows || null,
                // batting stats — passed so buildRowStats() can render them
                // without falling back to the NCAA leaderboards API
                games: p.games,
                AB: p.AB, H: p.H, R: p.R, HR: p.HR, RBI: p.RBI,
                BB: p.BB, K: p.K, SB: p.SB,
                '2B': p['2B'], '3B': p['3B'],
                BA: p.BA, OBP: p.OBP, SLG: p.SLG,
                // pitching stats
                IP: p.IP, W: p.W, L: p.L, SV: p.SV,
                SHO: p.SHO, ERA: p.ERA, WHIP: p.WHIP,
                'K/7': p['K/7'],
              }) : undefined}
            >
              <td className="py-1 px-2 whitespace-nowrap max-w-[160px]">
                <div className="flex items-center gap-1.5">
                  {p.photoUrl ? (
                    <img
                      src={p.photoUrl}
                      alt={p.name}
                      className="h-6 w-6 rounded-full object-cover flex-shrink-0 border border-white/10"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  ) : null}
                  <span className="text-white truncate">{p.name}</span>
                  {p.jersey ? (
                    <span className="text-white/30 text-[10px] flex-shrink-0">#{p.jersey}</span>
                  ) : null}
                </div>
              </td>
              <td className="text-center py-1.5 px-1 text-white/50 tabular-nums">{fmtOrDash(p.games)}</td>
              {isBatting ? (
                <>
                  <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{fmtOrDash(p.AB)}</td>
                  <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{fmtOrDash(p.H)}</td>
                  <td className="text-center py-1.5 px-1 text-white tabular-nums">{fmtOrDash(p.HR)}</td>
                  <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{fmtOrDash(p.RBI)}</td>
                  <td className="text-center py-1.5 px-1 text-white font-bold tabular-nums">{fmtOrDash(p.BA)}</td>
                </>
              ) : (
                <>
                  <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{fmtOrDash(p.IP)}</td>
                  <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{fmtOrDash(p.K)}</td>
                  <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{fmtOrDash(p.W)}</td>
                  <td className="text-center py-1.5 px-1 text-white font-bold tabular-nums">{fmtOrDash(p.ERA)}</td>
                  <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{fmtOrDash(p.SHO)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Render a single full-roster stats table from a wmt.games-normalized table.
// The row objects are keyed by column label (not opaque `column-N` ids) and
// the column list is the ordered, label+helpText pairs from the source. We
// skip the first "Team" column because the modal is already scoped to one
// team — that duplicated column would just waste horizontal space.
function renderWmtFullRosterTable(title, rows, columns, emptyCopy) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-white/5 bg-white/[0.01] p-4 text-center">
        <div className="text-white/40 text-xs mb-1">No {title.toLowerCase()} stats</div>
        <div className="text-white/30 text-[10px] mono">{emptyCopy}</div>
      </div>
    );
  }
  const visibleCols = (columns || []).filter((c) => {
    const label = (c?.label || '').toLowerCase();
    return label !== 'team'; // modal is already team-scoped
  });
  return (
    <div className="overflow-x-auto rounded-lg border border-white/5">
      <table className="mono text-[11px] min-w-full whitespace-nowrap">
        <thead>
          <tr className="bg-white/[0.02] text-white/40 uppercase tracking-wider">
            {visibleCols.map((c) => {
              const isPlayer = (c.label || '').toLowerCase() === 'player';
              return (
                <th
                  key={c.key || c.label}
                  className={`py-1.5 px-2 font-normal ${isPlayer ? 'text-left sticky left-0 bg-[#141210]' : 'text-center'}`}
                  title={c.helpText || undefined}
                >
                  {c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={classYearStyle(row['Yr'])} className="border-t border-white/5 hover:bg-white/[0.02]">
              {visibleCols.map((c) => {
                const isPlayer = (c.label || '').toLowerCase() === 'player';
                const v = row[c.label];
                return (
                  <td
                    key={c.key || c.label}
                    className={
                      isPlayer
                        ? 'py-1.5 px-2 text-white text-left sticky left-0 bg-[#141210]'
                        : 'py-1.5 px-2 text-white/70 text-center tabular-nums'
                    }
                  >
                    {fmtOrDash(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Full-roster stats view driven by the conference-level wmt.games payload.
// Renders all three sides (Hitting / Pitching / Fielding) with the entire
// column set the source publishes — OPS, TB, HBP, GDP, SH, SF, SB-ATT on
// the batting side; KL, WP, BK, BF, NP/STK on the pitching side; DP, SBA,
// CSB, PB, CI on the fielding side. This is strictly more than the NCAA
// top-50 leaderboard fallback.
function renderWmtFullRoster(secWmt) {
  const cols = secWmt?.columns || {};
  const players = secWmt?.players || {};
  return (
    <div className="space-y-8">
      <div>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">
          Hitting <span className="text-white/20">· {(players.hitting || []).length}</span>
        </div>
        {renderWmtFullRosterTable('Hitting', players.hitting, cols.hitting, 'No hitters on the current SEC roster feed.')}
      </div>
      <div>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">
          Pitching <span className="text-white/20">· {(players.pitching || []).length}</span>
        </div>
        {renderWmtFullRosterTable('Pitching', players.pitching, cols.individualPitching, 'No pitchers on the current SEC roster feed.')}
      </div>
      <div>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">
          Fielding <span className="text-white/20">· {(players.fielding || []).length}</span>
        </div>
        {renderWmtFullRosterTable('Fielding', players.fielding, cols.individualFielding, 'No fielders on the current SEC roster feed.')}
      </div>
      <div className="text-[10px] mono text-white/30 text-center leading-relaxed">
        Full roster · every player who has appeared this season. Source:
        secsports.com stats feed (wmt.games).
      </div>
    </div>
  );
}

// Render a team's season schedule grouped by month. Status-aware: posted
// games show the result (W/L) and score, upcoming games show the formatted
// date/time from ESPN's status.shortDetail, in-progress games show the
// live detail string. Opponents with a team id link to the opponent's
// modal via a custom event that the Teams view listens for.
const SCHEDULE_MONTH_FMT = { month: 'long', year: 'numeric' };
const SCHEDULE_DAY_FMT = { weekday: 'short', month: 'short', day: 'numeric' };
function renderTeamSchedule(stats) {
  const games = stats?.schedule || [];
  if (games.length === 0) {
    return (
      <div className="rounded-lg border border-white/5 bg-white/[0.01] p-6 text-center">
        <div className="text-white/40 text-sm mb-1">No games scheduled</div>
        <div className="text-white/30 text-[10px] mono">No schedule data from conference feed for this team.</div>
      </div>
    );
  }
  // Group by YYYY-MM so months render in chronological order regardless of
  // how the source ordered them.
  const byMonth = new Map();
  for (const g of games) {
    if (!g.date) continue;
    const d = new Date(g.date);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, { date: d, games: [] });
    byMonth.get(key).games.push(g);
  }
  const months = Array.from(byMonth.entries()).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="space-y-6">
      {months.map(([key, { date, games: monthGames }]) => (
        <div key={key}>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">
            {date.toLocaleDateString('en-US', SCHEDULE_MONTH_FMT)}
            <span className="text-white/20"> · {monthGames.length}</span>
          </div>
          <div className="rounded-lg border border-white/5 overflow-hidden">
            {monthGames.map((g) => renderScheduleRow(g))}
          </div>
        </div>
      ))}
    </div>
  );
}

function renderScheduleRow(g) {
  const d = g.date ? new Date(g.date) : null;
  const dayLabel = d ? d.toLocaleDateString('en-US', SCHEDULE_DAY_FMT) : '—';
  const state = g.status?.state;
  const isFinal = state === 'post';
  const isLive = state === 'in';
  // W / L / T / (location prefix)
  let resultBadge = null;
  if (isFinal && g.result) {
    const cls =
      g.result === 'W' ? 'bg-emerald-500/20 text-emerald-300' :
      g.result === 'L' ? 'bg-rose-500/20 text-rose-300' :
      'bg-white/10 text-white/60';
    resultBadge = (
      <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] mono font-bold tracking-wider ${cls}`}>
        {g.result}
      </span>
    );
  } else if (isLive) {
    resultBadge = (
      <span className="inline-block px-1.5 py-0.5 rounded text-[9px] mono font-bold tracking-wider bg-orange-500/20 text-orange-300 animate-pulse">
        LIVE
      </span>
    );
  }
  const locPrefix = g.neutralSite ? 'vs' : g.homeAway === 'away' ? '@' : 'vs';
  const rightText = isFinal && g.score
    ? g.score.display
    : (g.status?.detail || '—');
  return (
    <div key={g.id} className="grid grid-cols-[auto_1fr_auto] gap-3 items-center px-4 py-2.5 border-t border-white/5 first:border-t-0 hover:bg-white/[0.02]">
      <div className="flex items-center gap-2 w-[6.5rem] flex-shrink-0">
        <div className="text-[10px] mono text-white/40 uppercase tracking-wider w-16">{dayLabel}</div>
        <div className="w-7">{resultBadge}</div>
      </div>
      <div className="flex items-center gap-2 min-w-0">
        {g.opponent?.logo && (
          <img
            src={g.opponent.logo}
            alt=""
            className="h-5 w-5 object-contain flex-shrink-0"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        )}
        <div className="text-[10px] mono text-white/40 uppercase w-5 flex-shrink-0">{locPrefix}</div>
        <div className="text-sm text-white truncate">
          {g.opponent?.rank != null && (
            <span className="text-white/40 mono text-[10px] mr-1">#{g.opponent.rank}</span>
          )}
          {g.opponent?.name || 'TBD'}
        </div>
        {g.broadcast && (
          <div className="text-[9px] mono text-white/30 uppercase tracking-wider hidden sm:inline-block border border-white/10 rounded px-1.5 py-0.5">
            {g.broadcast}
          </div>
        )}
      </div>
      <div className={`text-xs mono tabular-nums whitespace-nowrap text-right ${isFinal ? 'text-white' : 'text-white/40'}`}>
        {rightText}
      </div>
    </div>
  );
}

// Single-team totals panel. For the head-to-head Team Compare view use the
// renderTotalRow closure inside TeamCompareTab — this is the standalone
// variant for TeamModal.
function renderSingleTeamTotals(stats, err) {
  if (err) {
    return (
      <div className="text-center py-8">
        <div className="text-white/40 text-sm mb-2">Couldn't load team totals.</div>
        <div className="text-white/30 text-xs mono">{err}</div>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="text-white/30 mono text-xs tracking-widest uppercase text-center py-8">
        Loading team totals…
      </div>
    );
  }
  const meta = stats.teamMeta || {};
  const batting = stats.totals?.batting || {};
  const pitching = stats.totals?.pitching || {};
  // Runs Scored = batting totals R; Runs Allowed = pitching totals R.
  // ESPN records previously supplied these; now they come from the conf feed.
  const runsFor     = batting.R     ?? meta.runsFor     ?? null;
  const runsAgainst = pitching.R    ?? meta.runsAgainst ?? null;
  const runDiff =
    runsFor != null && runsAgainst != null ? runsFor - runsAgainst : null;

  const row = (key, label, short, value, rank) => (
    <div key={key} className="grid grid-cols-[auto_1fr_auto] gap-4 items-baseline py-1.5 border-b border-white/5">
      <div className="mono uppercase tracking-wider text-white/40 text-[10px] w-12">{short}</div>
      <div className="text-[11px] text-white/60">{label}</div>
      <div className="text-right whitespace-nowrap">
        <span className="text-sm text-white tabular-nums">{fmtOrDash(value)}</span>
        {rank && rank !== '-' && (
          <span className="text-[10px] mono text-white/30 ml-2">#{rank}</span>
        )}
      </div>
    </div>
  );

  const recordValue =
    meta.wins != null && meta.losses != null ? `${meta.wins}-${meta.losses}` : null;
  const diffValue = runDiff != null ? (runDiff > 0 ? `+${runDiff}` : String(runDiff)) : null;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Season</div>
        {row('record', 'Record',       'W-L',  recordValue)}
        {row('rs',     'Runs Scored',  'RS',   runsFor)}
        {row('ra',     'Runs Allowed', 'RA',   runsAgainst)}
        {row('diff',   'Run Diff',     'DIFF', diffValue)}
        {row('strk',   'Streak',       'STRK', meta.streak)}
      </div>

      <div>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Team Batting</div>
        {row('ba',   'Batting Average', 'BA',  batting.BA,     batting.BA_rank)}
        {row('obp',  'On-Base Pct',     'OBP', batting.OBP,    batting.OBP_rank)}
        {row('slg',  'Slugging Pct',    'SLG', batting.SLG,    batting.SLG_rank)}
        {row('hr',   'Home Runs',       'HR',  batting.HR,     batting.HR_rank)}
        {row('rbi',  'Runs Batted In',  'RBI', batting.RBI,    batting.RBI_rank)}
        {row('r',    'Runs',            'R',   batting.R,      batting.R_rank)}
        {row('h',    'Hits',            'H',   batting.H,      batting.H_rank)}
        {row('sb',   'Stolen Bases',    'SB',  batting.SB,     batting.SB_rank)}
        {row('2b',   'Doubles',         '2B',  batting['2B'],  batting['2B_rank'])}
        {row('3b',   'Triples',         '3B',  batting['3B'],  batting['3B_rank'])}
      </div>

      <div>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Team Pitching</div>
        {row('era',  'Earned Run Average', 'ERA',  pitching.ERA,     pitching.ERA_rank)}
        {row('whip', 'WHIP',               'WHIP', pitching.WHIP,    pitching.WHIP_rank)}
        {row('k7',   'K per 7 Innings',    'K/7',  pitching['K/7'],  pitching['K/7_rank'])}
        {row('sho',  'Shutouts',           'SHO',  pitching.SHO,     pitching.SHO_rank)}
      </div>

      <div className="text-[10px] mono text-white/30 text-center leading-relaxed pt-2">
        Totals via NCAA team leaderboards. Ranks are D1 season-to-date.
      </div>
    </div>
  );
}

// Map the NCAA short-code column headers to human-readable names. Several
// codes (R, H, BB, SO) mean different things for batters vs pitchers, so the
// lookup is side-aware.
const COMMON_STAT_LABELS = {
  'G':    'Games',
  'GP':   'Games Played',
  'GS':   'Games Started',
  'Pct':  'Winning Percentage',
  'PCT':  'Winning Percentage',
  'W%':   'Winning Percentage',
};
const BATTING_STAT_LABELS = {
  'AB':    'At Bats',
  'R':     'Runs Scored',
  'H':     'Hits',
  '2B':    'Doubles',
  '3B':    'Triples',
  'HR':    'Home Runs',
  'RBI':   'Runs Batted In',
  'RBIs':  'Runs Batted In',
  'BB':    'Walks',
  'SO':    'Strikeouts',
  'K':     'Strikeouts',
  'SB':    'Stolen Bases',
  'CS':    'Caught Stealing',
  'HBP':   'Hit By Pitch',
  'HP':    'Hit By Pitch',
  'SH':    'Sacrifice Hits',
  'SF':    'Sacrifice Flies',
  'TB':    'Total Bases',
  'GDP':   'Grounded Into DP',
  'BA':    'Batting Average',
  'AVG':   'Batting Average',
  'OBP':   'On Base Percentage',
  'SLG':   'Slugging Percentage',
  'OPS':   'On-base Plus Slugging',
  'SB%':   'Stolen Base Percentage',
  'SBPct': 'Stolen Base Percentage',
  'BB/G':  'Walks Per Game',
  'H/G':   'Hits Per Game',
  'R/G':   'Runs Per Game',
  'HR/G':  'Home Runs Per Game',
  'RBI/G': 'RBI Per Game',
  'SB/G':  'Stolen Bases Per Game',
  '2B/G':  'Doubles Per Game',
  '3B/G':  'Triples Per Game',
};
const PITCHING_STAT_LABELS = {
  'IP':    'Innings Pitched',
  'W':     'Wins',
  'L':     'Losses',
  'APP':   'Appearances',
  'App':   'Appearances',
  'CG':    'Complete Games',
  'SV':    'Saves',
  'SHO':   'Shutouts',
  'SO':    'Strikeouts',
  'K':     'Strikeouts',
  'H':     'Hits Allowed',
  'R':     'Runs Allowed',
  'ER':    'Earned Runs',
  'BB':    'Walks Allowed',
  'HB':    'Hit Batters',
  'WP':    'Wild Pitches',
  'BK':    'Balks',
  'BF':    'Batters Faced',
  'ERA':   'Earned Run Average',
  'WHIP':  'Walks + Hits per Inning',
  'OBA':   'Opponent Batting Average',
  'K/7':   'Strikeouts Per 7 Innings',
  'SO/7':  'Strikeouts Per 7 Innings',
  'BB/7':  'Walks Per 7 Innings',
  'H/7':   'Hits Per 7 Innings',
  'K:BB':  'Strikeout-to-Walk Ratio',
  'K/BB':  'Strikeout-to-Walk Ratio',
};
function fullStatName(short, side) {
  if (!short) return short;
  const sideMap = side === 'pitching' ? PITCHING_STAT_LABELS : BATTING_STAT_LABELS;
  return sideMap[short] || COMMON_STAT_LABELS[short] || short;
}

// Shared helpers used by both Team Compare and Player Compare modal tabs.
// Extract season records, ranks, and conference metadata directly off the
// ESPN scoreboard competitor object so the tab headers can render instantly
// from the props that opened the modal — no API call needed.
function extractEspnCompetitor(competitor) {
  if (!competitor) return null;
  const t = competitor.team || {};
  const records = Array.isArray(competitor.records) ? competitor.records : [];
  const byType = (type) =>
    records.find((r) => (r.type || r.name || '').toLowerCase() === type) ||
    records.find((r) => (r.type || r.name || '').toLowerCase().includes(type));
  const total = byType('total') || records[0] || null;
  const conf = byType('vsconf') || byType('conf');
  const homeRec = byType('home');
  const road = byType('road') || byType('away');
  const streak = byType('streak');
  const parseWL = (summary) => {
    if (!summary) return { w: null, l: null };
    const m = String(summary).match(/^(\d+)-(\d+)/);
    return m ? { w: parseInt(m[1], 10), l: parseInt(m[2], 10) } : { w: null, l: null };
  };
  const totalWL = parseWL(total?.summary);
  const pct = totalWL.w != null && (totalWL.w + totalWL.l) > 0
    ? totalWL.w / (totalWL.w + totalWL.l)
    : null;
  // Canonical conference lookup from the spreadsheet table. ESPN's location
  // field is mascot-free which is what lookupConference wants; fall back to
  // displayName for the rare team where location is missing.
  const canonicalConf =
    lookupConference(t.location) ||
    lookupConference(t.displayName) ||
    lookupConference(t.shortDisplayName) ||
    null;
  return {
    name: t.displayName || t.name || '',
    logo: t.logo || t.logos?.[0]?.href || null,
    conference: canonicalConf || competitor.conference?.name || t.conferenceAbbreviation || '',
    total: total?.summary || '',
    totalW: totalWL.w,
    totalL: totalWL.l,
    pct,
    conf: conf?.summary || '',
    home: homeRec?.summary || '',
    road: road?.summary || '',
    streak: streak?.summary || streak?.displayValue || '',
    curatedRank: competitor?.curatedRank?.current || null,
  };
}

function getTeamPollRank(rankings, teamName) {
  const poll = rankings?.rankings?.[0];
  if (!poll || !teamName) return null;
  const key = normalizeTeamName(teamName);
  const r = (poll.ranks || []).find((x) => {
    const n = normalizeTeamName(x.team?.name || x.team?.displayName);
    return n === key;
  });
  if (!r) return null;
  return {
    current: r.current,
    previous: typeof r.previous === 'number' ? r.previous : null,
  };
}

const pctStr = (n) => (n != null ? n.toFixed(3).replace(/^0/, '') : '—');

function renderCompareHeader(awayEspn, awayRank, homeEspn, homeRank) {
  const headerCol = (data, rank, align) => {
    if (!data) return null;
    return (
      <div className={`${align === 'right' ? 'text-right' : 'text-left'} min-w-0`}>
        <div className={`flex items-center gap-3 mb-2 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
          {data.logo && (
            <img
              src={data.logo}
              alt=""
              className="h-10 w-10 object-contain flex-shrink-0"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}
          <div className="min-w-0">
            <div className="display text-white text-xl font-bold truncate">{data.name}</div>
            {data.conference && (
              <div className="text-[10px] mono uppercase tracking-widest text-white/40">{data.conference}</div>
            )}
          </div>
        </div>
        <div className={`flex flex-wrap gap-x-3 gap-y-1 text-[11px] mono ${align === 'right' ? 'justify-end' : ''}`}>
          {rank && (
            <span className="tabular-nums font-bold" style={{ color: '#ff6b1a' }}>#{rank.current}</span>
          )}
          {data.total ? (
            <>
              <span className="text-white tabular-nums">{data.total}</span>
              {data.pct != null && <span className="text-white/60 tabular-nums">{pctStr(data.pct)}</span>}
              {data.streak && <span className="text-white/60">{data.streak}</span>}
              {data.conf && <span className="text-white/40">Conf {data.conf}</span>}
              {data.home && <span className="text-white/40">Home {data.home}</span>}
              {data.road && <span className="text-white/40">Away {data.road}</span>}
            </>
          ) : (
            <span className="text-white/30">no season data</span>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center pb-5 border-b border-white/10">
      {headerCol(awayEspn, awayRank, 'right')}
      <div className="text-white/30 mono text-[10px] uppercase tracking-[0.3em]">vs</div>
      {headerCol(homeEspn, homeRank, 'left')}
    </div>
  );
}

// Build a synthetic teamMeta from scoreboard ESPN records so the Season
// section of Team Totals renders W-L and streak instantly, with no API call.
// The remaining ESPN-derived fields (runs scored/allowed) come from the
// /api/team-stats response when the quick fetch resolves a few seconds later.
function buildEspnFallback(espn) {
  if (!espn) return null;
  return {
    teamMeta: {
      wins: espn.totalW,
      losses: espn.totalL,
      runsFor: null,
      runsAgainst: null,
      streak: espn.streak || null,
    },
    totals: { batting: {}, pitching: {} },
  };
}

// Pick winner on a numeric team total stat. Handles lower-is-better (ERA, WHIP).
function pickNumericWinner(awayVal, homeVal, lowerIsBetter) {
  const a = parseFloat(awayVal);
  const h = parseFloat(homeVal);
  if (!Number.isFinite(a) && !Number.isFinite(h)) return null;
  if (!Number.isFinite(a)) return 'home';
  if (!Number.isFinite(h)) return 'away';
  if (a === h) return null;
  return (lowerIsBetter ? a < h : a > h) ? 'away' : 'home';
}

function TeamCompareTab({ home, away, rankings }) {
  const [homeQuick, setHomeQuick] = useState(null);
  const [awayQuick, setAwayQuick] = useState(null);
  const [homeStatsErr, setHomeStatsErr] = useState(null);
  const [awayStatsErr, setAwayStatsErr] = useState(null);

  const homeName = home?.team?.displayName || home?.team?.name || '';
  const awayName = away?.team?.displayName || away?.team?.name || '';
  const homeId = home?.team?.id ? String(home.team.id) : null;
  const awayId = away?.team?.id ? String(away.team.id) : null;

  // Fetch /api/team-stats — now powered by conference scrapes (WMT Games)
  // instead of NCAA leaderboards, so the full payload is ~1-3s cold and
  // ~10ms warm. No more split quick/full paths.
  useEffect(() => {
    let cancelled = false;
    setHomeQuick(null); setAwayQuick(null);
    setHomeStatsErr(null); setAwayStatsErr(null);

    const fetchStats = (teamId, setStats, setErr) => {
      fetch(`/api/team-stats?teamId=${encodeURIComponent(teamId)}`)
        .then(async (r) => {
          const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          if (cancelled) return;
          if (!r.ok || j.error) setErr(j.error || `HTTP ${r.status}`);
          else setStats(j);
        })
        .catch((e) => { if (!cancelled) setErr(e.message); });
    };

    if (homeId) fetchStats(homeId, setHomeQuick, setHomeStatsErr);
    if (awayId) fetchStats(awayId, setAwayQuick, setAwayStatsErr);
    return () => { cancelled = true; };
  }, [homeId, awayId]);

  const awayEspn = extractEspnCompetitor(away);
  const homeEspn = extractEspnCompetitor(home);
  const awayRank = awayEspn?.curatedRank
    ? { current: awayEspn.curatedRank, previous: null }
    : getTeamPollRank(rankings, awayName);
  const homeRank = homeEspn?.curatedRank
    ? { current: homeEspn.curatedRank, previous: null }
    : getTeamPollRank(rankings, homeName);

  // Instant-render fallback: ESPN scoreboard records (W-L, streak) appear
  // immediately, with API-derived fields (RS, RA, batting/pitching) filling
  // in 2-4s later when the quick fetch resolves.
  const awayData = awayQuick || buildEspnFallback(awayEspn);
  const homeData = homeQuick || buildEspnFallback(homeEspn);

  const renderTotalRow = (key, label, short, get, lowerIsBetter) => {
    const av = awayData ? get(awayData) : null;
    const hv = homeData ? get(homeData) : null;
    const winner = pickNumericWinner(av, hv, lowerIsBetter);
    const fmt = (v) => (v == null || v === '' ? '—' : v);
    const cls = (side) =>
      winner === side
        ? 'text-sm font-bold tabular-nums'
        : 'text-sm tabular-nums text-white/70';
    const style = (side) => (winner === side ? { color: '#ff6b1a' } : {});
    return (
      <div key={key} className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center py-2 border-b border-white/5">
        <div className={`text-right ${cls('away')}`} style={style('away')}>{fmt(av)}</div>
        <div className="text-center">
          <div className="text-[10px] mono uppercase tracking-widest text-white/40">{short}</div>
          <div className="text-[9px] mono uppercase text-white/30">{label}</div>
        </div>
        <div className={`text-left ${cls('home')}`} style={style('home')}>{fmt(hv)}</div>
      </div>
    );
  };

  const errNote = (teamLabel, errMsg) => errMsg
    ? <span className="text-red-400/70"> · {teamLabel} failed: {errMsg}</span>
    : null;

  return (
    <div className="space-y-6">
      {renderCompareHeader(awayEspn, awayRank, homeEspn, homeRank)}

      <div className="space-y-6">
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Season</div>
          {renderTotalRow('record',  'Record',       'W-L',  (s) => s.teamMeta && s.teamMeta.wins != null ? `${s.teamMeta.wins}-${s.teamMeta.losses}` : null)}
          {renderTotalRow('rs',      'Runs Scored',  'RS',   (s) => s.totals?.batting?.R ?? s.teamMeta?.runsFor ?? null)}
          {renderTotalRow('ra',      'Runs Allowed', 'RA',   (s) => s.totals?.pitching?.R ?? s.teamMeta?.runsAgainst ?? null, true)}
          {renderTotalRow('diff',    'Run Diff',     'DIFF', (s) => {
            const rf = s.totals?.batting?.R ?? s.teamMeta?.runsFor;
            const ra = s.totals?.pitching?.R ?? s.teamMeta?.runsAgainst;
            if (rf == null || ra == null) return null;
            const d = rf - ra;
            return d > 0 ? `+${d}` : String(d);
          })}
          {renderTotalRow('strk',    'Streak',       'STRK', (s) => s.teamMeta?.streak ?? null)}
        </div>

        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Team Batting</div>
          {renderTotalRow('ba',  'Batting Avg',  'BA',  (s) => s.totals?.batting?.BA)}
          {renderTotalRow('obp', 'On-Base Pct',  'OBP', (s) => s.totals?.batting?.OBP)}
          {renderTotalRow('slg', 'Slugging Pct', 'SLG', (s) => s.totals?.batting?.SLG)}
          {renderTotalRow('hr',  'Home Runs',    'HR',  (s) => s.totals?.batting?.HR)}
          {renderTotalRow('rbi', 'Runs Batted In','RBI',(s) => s.totals?.batting?.RBI)}
          {renderTotalRow('h',   'Hits',         'H',   (s) => s.totals?.batting?.H)}
          {renderTotalRow('sb',  'Stolen Bases', 'SB',  (s) => s.totals?.batting?.SB)}
        </div>

        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Team Pitching</div>
          {renderTotalRow('era',  'Earned Run Avg',   'ERA',  (s) => s.totals?.pitching?.ERA, true)}
          {renderTotalRow('whip', 'WHIP',             'WHIP', (s) => s.totals?.pitching?.WHIP, true)}
          {renderTotalRow('k7',   'K per 7 Innings',  'K/7',  (s) => s.totals?.pitching?.['K/7'])}
          {renderTotalRow('sho',  'Shutouts',         'SHO',  (s) => s.totals?.pitching?.SHO)}
        </div>

        <div className="text-[10px] mono text-white/30 text-center leading-relaxed">
          Records and run totals via ESPN. Team batting and pitching totals
          via NCAA team leaderboards (season totals, every D1 team).
          {(awayStatsErr || homeStatsErr) && (
            <span className="text-white/20 block mt-1">
              {errNote(awayName, awayStatsErr)}
              {homeStatsErr && awayStatsErr && ' · '}
              {errNote(homeName, homeStatsErr)}
            </span>
          )}
        </div>
      </div>

      <div className="text-[10px] mono uppercase tracking-widest text-white/30 text-center pt-4 border-t border-white/5">
        Records via ESPN · Stats via NCAA
      </div>
    </div>
  );
}

// Player Compare is its own top-level modal tab. Lazy-loaded — the full
// /api/team-stats fetch (including the slow NCAA player-leaderboard scan)
// only fires when the user actually clicks this tab, so it doesn't slow
// down Team Compare.
function PlayerCompareTab({ home, away, rankings }) {
  const [homeStats, setHomeStats] = useState(null);
  const [awayStats, setAwayStats] = useState(null);
  const [homeStatsErr, setHomeStatsErr] = useState(null);
  const [awayStatsErr, setAwayStatsErr] = useState(null);
  const [selectedPlayer, setSelectedPlayer] = useState(null);

  const homeName = home?.team?.displayName || home?.team?.name || '';
  const awayName = away?.team?.displayName || away?.team?.name || '';
  const homeId = home?.team?.id ? String(home.team.id) : null;
  const awayId = away?.team?.id ? String(away.team.id) : null;

  useEffect(() => {
    let cancelled = false;
    setHomeStats(null); setAwayStats(null);
    setHomeStatsErr(null); setAwayStatsErr(null);

    const fetchFull = (teamId, setStats, setErr) => {
      fetch(`/api/team-stats?teamId=${encodeURIComponent(teamId)}`)
        .then(async (r) => {
          const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          if (cancelled) return;
          if (!r.ok || j.error) setErr(j.error || `HTTP ${r.status}`);
          else setStats(j);
        })
        .catch((e) => { if (!cancelled) setErr(e.message); });
    };

    if (homeId) fetchFull(homeId, setHomeStats, setHomeStatsErr);
    if (awayId) fetchFull(awayId, setAwayStats, setAwayStatsErr);
    return () => { cancelled = true; };
  }, [homeId, awayId]);

  const awayEspn = extractEspnCompetitor(away);
  const homeEspn = extractEspnCompetitor(home);
  const awayRank = awayEspn?.curatedRank
    ? { current: awayEspn.curatedRank, previous: null }
    : getTeamPollRank(rankings, awayName);
  const homeRank = homeEspn?.curatedRank
    ? { current: homeEspn.curatedRank, previous: null }
    : getTeamPollRank(rankings, homeName);

  const renderPlayerColumn = (teamLabel, stats, errMsg, group) => {
    if (errMsg) {
      return (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-center">
          <div className="text-red-300 text-xs mb-1">Couldn't load {teamLabel} stats</div>
          <div className="text-red-400/60 text-[10px] mono">{errMsg}</div>
        </div>
      );
    }
    if (!stats) {
      return <div className="text-white/30 mono text-xs tracking-widest uppercase text-center py-4">Loading…</div>;
    }
    return renderPlayerTable(stats, group, (p) => setSelectedPlayer({ ...p, team: p.team || teamLabel }));
  };

  const bothFailed = homeStatsErr && awayStatsErr && !homeStats && !awayStats;
  const neitherStarted = !homeStats && !awayStats && !homeStatsErr && !awayStatsErr;

  return (
    <div className="space-y-6">
      {renderCompareHeader(awayEspn, awayRank, homeEspn, homeRank)}

      {bothFailed ? (
        <div className="text-center py-10">
          <div className="text-white/40 text-sm mb-2">Couldn't load player stats for either team.</div>
          <div className="text-white/30 text-xs mono">{awayName}: {awayStatsErr}</div>
          <div className="text-white/30 text-xs mono">{homeName}: {homeStatsErr}</div>
        </div>
      ) : neitherStarted ? (
        <div className="text-white/30 mono text-xs tracking-widest uppercase text-center py-10">Loading player stats…</div>
      ) : (
        <div className="space-y-8">
          <div>
            <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Batters</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <div className="text-[10px] mono text-white/50 mb-2 uppercase tracking-wider">{awayName}</div>
                {renderPlayerColumn(awayName, awayStats, awayStatsErr, 'batting')}
              </div>
              <div>
                <div className="text-[10px] mono text-white/50 mb-2 uppercase tracking-wider">{homeName}</div>
                {renderPlayerColumn(homeName, homeStats, homeStatsErr, 'batting')}
              </div>
            </div>
          </div>

          <div>
            <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Pitchers</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <div className="text-[10px] mono text-white/50 mb-2 uppercase tracking-wider">{awayName}</div>
                {renderPlayerColumn(awayName, awayStats, awayStatsErr, 'pitching')}
              </div>
              <div>
                <div className="text-[10px] mono text-white/50 mb-2 uppercase tracking-wider">{homeName}</div>
                {renderPlayerColumn(homeName, homeStats, homeStatsErr, 'pitching')}
              </div>
            </div>
          </div>

          <div className="text-[10px] mono text-white/30 text-center">
            SEC teams use the full secsports.com roster feed (all players who appeared this season).
            Other conferences use NCAA individual leaderboards. Missing stat cells render as —.
          </div>
        </div>
      )}

      <div className="text-[10px] mono uppercase tracking-widest text-white/30 text-center pt-4 border-t border-white/5">
        Records via ESPN · Stats via NCAA
      </div>
      {selectedPlayer && (
        <PlayerModal
          player={selectedPlayer}
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </div>
  );
}

function LiveTab({ game, detail }) {
  // Prefer the richer situation from the summary endpoint, fall back to scoreboard.
  const sit = detail?.situation || game.competitions?.[0]?.situation;
  const comp = game.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === 'home');
  const away = comp?.competitors?.find((c) => c.homeAway === 'away');
  const lastPlay = sit?.lastPlay?.text || detail?.plays?.[detail.plays.length - 1]?.text;
  const dueUp = detail?.situation?.dueUp || sit?.dueUp;
  const probables = detail?.boxscore?.teams?.flatMap?.((t) => t.probableStarter || []) || [];

  if (!sit) return <EmptyState text="Live situation not available yet — waiting for first pitch." />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center rounded-2xl border border-orange-500/20 bg-gradient-to-br from-orange-500/[0.06] to-transparent p-6">
        <div className="flex flex-col items-center">
          <Diamond
            onFirst={!!sit.onFirst}
            onSecond={!!sit.onSecond}
            onThird={!!sit.onThird}
            size={140}
          />
          <div className="mt-3 text-[10px] mono uppercase tracking-[0.3em] text-white/40">
            {game.status?.type?.shortDetail}
          </div>
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="text-[10px] mono uppercase tracking-[0.3em] text-white/40">Count</div>
          <div className="display text-white text-6xl font-black tabular-nums">
            {sit.balls ?? 0}<span className="text-white/30">–</span>{sit.strikes ?? 0}
          </div>
          <div className="flex gap-1.5">
            {[0,1,2].map((i) => (
              <span key={i} className="h-2.5 w-2.5 rounded-full" style={{ background: i < (sit.outs ?? 0) ? '#ef4444' : 'rgba(255,255,255,0.12)' }} />
            ))}
          </div>
          <div className="text-[10px] mono uppercase tracking-widest text-white/40">{sit.outs ?? 0} Out{(sit.outs ?? 0) === 1 ? '' : 's'}</div>
        </div>
        <div className="space-y-3">
          {sit.batter?.athlete && (
            <PlayerLine label="At Bat" athlete={sit.batter.athlete} note={sit.batter.summary} />
          )}
          {sit.pitcher?.athlete && (
            <PlayerLine label="Pitching" athlete={sit.pitcher.athlete} note={sit.pitcher.summary} />
          )}
        </div>
      </div>

      {lastPlay && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-2">Last Play</div>
          <div className="text-white text-sm">{lastPlay}</div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <RunnerCard base="3B" runner={sit.onThird} />
        <RunnerCard base="2B" runner={sit.onSecond} />
        <RunnerCard base="1B" runner={sit.onFirst} />
      </div>

      {dueUp && dueUp.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Due Up</div>
          <div className="flex flex-wrap gap-3">
            {dueUp.map((d, i) => (
              <div key={i} className="text-xs text-white/80">
                <span className="text-white/40 mono mr-1">{i + 1}.</span>
                {d.athlete?.shortName || d.athlete?.displayName}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mono text-xs">
        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
          <div className="text-[10px] uppercase tracking-widest text-white/40">{away?.team?.abbreviation}</div>
          <div className="display text-white text-3xl font-black tabular-nums">{away?.score ?? '0'}</div>
          <div className="text-white/40 text-[10px] uppercase">H {away?.hits ?? '–'} · E {away?.errors ?? '–'}</div>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
          <div className="text-[10px] uppercase tracking-widest text-white/40">{home?.team?.abbreviation}</div>
          <div className="display text-white text-3xl font-black tabular-nums">{home?.score ?? '0'}</div>
          <div className="text-white/40 text-[10px] uppercase">H {home?.hits ?? '–'} · E {home?.errors ?? '–'}</div>
        </div>
      </div>

      <div className="text-[10px] mono uppercase tracking-widest text-white/30 text-center">
        Situation refreshes every 15s · Scoreboard every 45s
      </div>
    </div>
  );
}

function PlayerLine({ label, athlete, note }) {
  return (
    <div>
      <div className="text-[10px] mono uppercase tracking-widest text-white/40">{label}</div>
      <div className="text-white text-sm font-semibold">{athlete.shortName || athlete.displayName}</div>
      {note && <div className="text-white/50 text-[10px] mono">{note}</div>}
    </div>
  );
}

function RunnerCard({ base, runner }) {
  const occupied = !!runner;
  return (
    <div className={`rounded-lg border p-3 ${occupied ? 'border-orange-500/40 bg-orange-500/5' : 'border-white/5 bg-white/[0.02]'}`}>
      <div className="text-[10px] mono uppercase tracking-widest" style={{ color: occupied ? '#ff6b1a' : 'rgba(255,255,255,0.3)' }}>{base}</div>
      <div className={`text-sm mt-1 ${occupied ? 'text-white' : 'text-white/30'}`}>
        {occupied ? (runner.athlete?.shortName || runner.athlete?.displayName || 'Runner on') : 'Empty'}
      </div>
    </div>
  );
}

function GameInfoTab({ detail }) {
  const gi = detail?.gameInfo;
  const venue = gi?.venue || detail?.header?.competitions?.[0]?.venue;
  const weather = gi?.weather;
  const attendance = gi?.attendance;
  const officials = gi?.officials || [];
  const broadcasts = detail?.header?.competitions?.[0]?.broadcasts || [];
  const odds = detail?.pickcenter?.[0];

  if (!gi && !venue && !odds) return <EmptyState text="Game info not available." />;

  return (
    <div className="space-y-6 text-sm">
      {venue && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-2">Venue</div>
          <div className="text-white font-semibold">{venue.fullName}</div>
          {venue.address && (
            <div className="text-white/50 text-xs mono">
              {venue.address.city}{venue.address.state ? `, ${venue.address.state}` : ''}
            </div>
          )}
          {typeof venue.capacity === 'number' && (
            <div className="text-white/40 text-[10px] mono uppercase mt-1">Capacity {venue.capacity.toLocaleString()}</div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {weather && (
          <InfoCard label="Weather">
            <div className="text-white">{weather.displayValue || weather.summary}</div>
            {typeof weather.temperature === 'number' && <div className="text-white/50 text-xs mono">{weather.temperature}°</div>}
          </InfoCard>
        )}
        {attendance != null && (
          <InfoCard label="Attendance">
            <div className="text-white tabular-nums">{Number(attendance).toLocaleString()}</div>
          </InfoCard>
        )}
        {broadcasts.length > 0 && (
          <InfoCard label="Broadcast">
            <div className="text-white">{broadcasts.flatMap((b) => b.media?.shortName || b.names || []).join(' · ')}</div>
          </InfoCard>
        )}
      </div>

      {odds && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-2">Odds</div>
          {odds.details && <div className="text-white">{odds.details}</div>}
          {odds.overUnder != null && <div className="text-white/60 text-xs mono">O/U {odds.overUnder}</div>}
          {odds.provider?.name && <div className="text-white/30 text-[10px] mono uppercase mt-1">{odds.provider.name}</div>}
        </div>
      )}

      {officials.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-2">Officials</div>
          <div className="grid grid-cols-2 gap-2">
            {officials.map((o, i) => (
              <div key={i} className="text-xs">
                <span className="text-white/40 mono mr-2 uppercase">{o.position?.displayName || o.position?.name}</span>
                <span className="text-white">{o.fullName || o.displayName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, children }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="text-[10px] mono tracking-[0.25em] uppercase text-white/40 mb-1">{label}</div>
      {children}
    </div>
  );
}

// Major D1 softball conferences. Used to filter the full ESPN standings payload
// down to the conferences most fans actually care about.
const MAJOR_CONFERENCES = [
  'SEC', 'Southeastern',
  'ACC', 'Atlantic Coast',
  'Big 12',
  'Big Ten',
  'Pac-12', 'Pac 12',
  'American', 'AAC',
  'Big East',
  'Mountain West', 'MWC',
  'Conference USA', 'C-USA',
  'Sun Belt',
];

function StandingsView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const [debug, setDebug] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        // Pull both sources in parallel. The official conference feeds
        // (/api/conference-standings) cover SEC/Big 12/ACC/Big Ten/MW with
        // up-to-the-minute data scraped from each league's own site. The
        // NCAA-derived feed (/api/standings) fills in every other league.
        // Official wins on any name collision so we aren't double-listing.
        const [officialRes, ncaaRes] = await Promise.all([
          fetch('/api/conference-standings').then((r) => r.json()).catch(() => ({ conferences: [] })),
          fetch('/api/standings').then((r) => r.json()).catch(() => ({ conferences: [] })),
        ]);
        const official = officialRes.conferences || [];
        // NCAA fallback can legitimately return { error, debug } when the
        // scoreboard scan times out — treat that as an empty fallback list
        // rather than a hard failure, so the official feeds still render.
        const ncaa = Array.isArray(ncaaRes.conferences) ? ncaaRes.conferences : [];
        const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const taken = new Set();
        for (const c of official) {
          taken.add(norm(c.name));
          taken.add(norm(c.abbreviation));
        }
        const merged = [
          ...official,
          ...ncaa.filter((c) => !taken.has(norm(c.name)) && !taken.has(norm(c.abbreviation))),
        ];
        if (merged.length === 0 && ncaaRes.error) {
          setDebug(ncaaRes.debug || null);
          throw new Error(ncaaRes.error);
        }
        setData({ conferences: merged, officialCount: official.length });
      } catch (e) { setError(e.message); }
    })();
  }, []);

  if (error) return (
    <div className="py-20 text-center">
      <div className="text-red-400 text-sm mb-4">Error loading standings: {error}</div>
      {debug && (
        <pre className="inline-block text-left text-[10px] mono text-white/40 bg-white/[0.02] border border-white/5 rounded-lg p-4 max-w-2xl overflow-x-auto">
          {JSON.stringify(debug, null, 2)}
        </pre>
      )}
    </div>
  );
  if (!data) return <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading standings…</div>;

  const conferences = data.conferences || [];
  if (conferences.length === 0) {
    return <EmptyState text="No standings available right now. Check back in a few minutes." />;
  }

  const isMajor = (g) =>
    MAJOR_CONFERENCES.some((m) =>
      (g.name || '').toLowerCase().includes(m.toLowerCase()) ||
      (g.abbreviation || '').toLowerCase() === m.toLowerCase()
    );

  const visible = showAll ? conferences : conferences.filter(isMajor);
  const display = visible.length > 0 ? visible : conferences;

  return (
    <div className="space-y-12">
      <div className="flex items-end justify-between border-b border-white/10 pb-3">
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40">D1 Softball</div>
          <h2 className="display text-white text-3xl font-bold">Conference Standings</h2>
        </div>
        <button
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] mono uppercase tracking-widest px-3 py-1.5 rounded-full border border-white/10 text-white/60 hover:text-white hover:border-white/30 transition"
        >
          {showAll ? 'Major Only' : `Show All (${conferences.length})`}
        </button>
      </div>

      {display.map((g, gi) => (
        <ConferenceTable key={(g.abbreviation || g.name) + gi} group={g} index={gi} />
      ))}
    </div>
  );
}

function ConferenceTable({ group, index }) {
  const headers = group.headers && group.headers.length ? group.headers : ['Team', 'Conf', 'Overall'];
  return (
    <div className="card-enter" style={{ animationDelay: `${Math.min(index * 60, 500)}ms` }}>
      <div className="mb-3 flex items-end justify-between">
        <div className="display text-white text-xl font-bold">{group.name}</div>
        {group.abbreviation && <div className="text-[10px] mono uppercase text-white/30">{group.abbreviation}</div>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full mono text-xs">
          <thead>
            <tr className="bg-white/[0.02] text-white/40 uppercase tracking-wider">
              <th className="text-left py-2 px-3 font-normal">#</th>
              <th className="text-left py-2 px-3 font-normal">Team</th>
              {headers.map((h, hi) => (
                <th key={hi} className="text-center py-2 px-2 font-normal whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.teams.map((t, i) => (
              <tr key={t.id || i} className="border-t border-white/5 hover:bg-white/[0.02]">
                <td className="py-2 px-3 text-white/40 tabular-nums">{i + 1}</td>
                <td className="py-2 px-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {t.logo && <img src={t.logo} alt="" className="h-5 w-5 object-contain" />}
                    <span className="text-white truncate">{t.name}</span>
                  </div>
                </td>
                {(t.stats || []).map((s, si) => (
                  <td key={si} className="text-center py-2 px-2 text-white/70 tabular-nums whitespace-nowrap">{s || '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeadersView({ onSelectPlayer }) {
  const [categories, setCategories] = useState(null);
  const [side, setSide] = useState('batting');
  const [slug, setSlug] = useState('batting-avg');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  // Pull the curated category index once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/player-stats')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setCategories(d.categories || []); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);

  // Fetch the active leaderboard whenever the category changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null); setData(null);
    fetch(`/api/player-stats?category=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setErr(d.error);
        else setData(d);
      })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  const switchSide = (next) => {
    if (next === side) return;
    setSide(next);
    const first = (categories || []).find((c) => c.side === next);
    if (first) setSlug(first.slug);
  };

  const sideCats = (categories || []).filter((c) => c.side === side);

  // Slugs where stat/G is a meaningful derived column. Rate stats (BA, OBP,
  // SLG, ERA, WHIP, K/7) are already rates so /G is nonsense, and pitching
  // counting stats divide by pitching appearances which is less intuitive
  // than the already-shown K/7. Batting counting stats are the sweet spot.
  const PER_GAME_SLUGS = new Set([
    'home-runs', 'rbi', 'hits', 'runs-scored', 'stolen-bases', 'doubles', 'triples',
  ]);
  const showPerGame = PER_GAME_SLUGS.has(slug);
  const perGame = (primary, gp) => {
    const p = parseFloat(primary);
    const g = parseInt(gp, 10);
    if (!isFinite(p) || !g) return '—';
    return (p / g).toFixed(2);
  };

  return (
    <div>
      <div className="mb-6 border-b border-white/10 pb-3 flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40">Season Leaders</div>
          <h2 className="display text-white text-3xl font-bold">Player {side === 'batting' ? 'Batting' : 'Pitching'} Leaders</h2>
          <div className="text-white/40 text-xs mono mt-1">Source: NCAA.com · Click any player for a full profile</div>
        </div>
        <div className="flex gap-1 p-1 rounded-full border border-white/10 bg-white/[0.02]">
          {['batting', 'pitching'].map((s) => (
            <button
              key={s}
              onClick={() => switchSide(s)}
              className={`px-4 py-1.5 rounded-full text-[10px] mono uppercase tracking-widest transition ${side === s ? 'text-white' : 'text-white/40 hover:text-white/70'}`}
              style={side === s ? { background: '#ff6b1a' } : {}}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <label htmlFor="leaders-category" className="text-[10px] mono tracking-[0.25em] uppercase text-white/40">Stat</label>
        <div className="relative">
          {/* Solid-dark background + per-option inline style is what kills the
              white flash on iOS Safari — colorScheme alone is not respected by
              older iOS releases and Tailwind's bg-white/[0.03] renders as
              actual white when Safari paints the native picker. */}
          <select
            id="leaders-category"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!categories || sideCats.length === 0}
            className="appearance-none pl-4 pr-10 py-2 rounded-lg border border-white/10 hover:border-white/30 focus:border-white/40 focus:outline-none text-white text-sm mono tracking-wide cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ background: '#1a1815', colorScheme: 'dark' }}
          >
            {!categories && <option style={{ background: '#1a1815', color: 'white' }}>Loading categories…</option>}
            {categories && sideCats.length === 0 && <option style={{ background: '#1a1815', color: 'white' }}>No {side} categories available</option>}
            {sideCats.map((c) => (
              <option key={c.slug} value={c.slug} style={{ background: '#1a1815', color: 'white' }}>{c.label}</option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-white/50">
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      {err && (
        <div className="max-w-xl mx-auto text-center py-16">
          <div className="display text-white/30 text-3xl mb-3">Leaders unavailable</div>
          <div className="text-white/50 text-sm">{err}</div>
        </div>
      )}

      {!err && loading && (
        <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading {data?.label || 'leaders'}…</div>
      )}

      {!err && !loading && data && data.rows && data.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full mono text-xs">
            <thead>
              <tr className="bg-white/[0.02] text-white/40 uppercase tracking-wider">
                <th className="text-left py-2 px-3 font-normal w-12">#</th>
                <th className="text-left py-2 px-3 font-normal">Player</th>
                <th className="text-left py-2 px-3 font-normal">Team</th>
                <th className="text-center py-2 px-2 font-normal">Cl</th>
                <th className="text-center py-2 px-2 font-normal">Pos</th>
                <th className="text-center py-2 px-2 font-normal">G</th>
                <th className="text-center py-2 px-2 font-normal text-white/70">{data.short || data.label}</th>
                {showPerGame && <th className="text-center py-2 px-2 font-normal text-white/40">/G</th>}
              </tr>
            </thead>
            <tbody>
              {data.rows.slice(0, 50).map((row, i) => {
                const rankNum = parseInt(row.rank, 10);
                const isTop5 = !isNaN(rankNum) && rankNum <= 5;
                return (
                  <tr
                    key={`${row.name}-${row.team}-${i}`}
                    onClick={() => onSelectPlayer && onSelectPlayer({ name: row.name, team: row.team, side, slug, primaryShort: data.short, primaryValue: row.primary })}
                    className="card-enter border-t border-white/5 hover:bg-white/[0.03] cursor-pointer"
                    style={{ animationDelay: `${Math.min(i * 12, 500)}ms` }}
                  >
                    <td className="py-2 px-3">
                      <span className={`display text-2xl font-black ${isTop5 ? '' : 'text-white/40'}`} style={isTop5 ? { color: '#ff6b1a' } : {}}>{row.rank}</span>
                    </td>
                    <td className="py-2 px-3 text-white whitespace-nowrap">{row.name}</td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2 min-w-0">
                        {row.teamLogo && (
                          <img
                            src={row.teamLogo}
                            alt=""
                            className="h-5 w-5 object-contain"
                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                          />
                        )}
                        <span className="text-white/70 truncate">{row.team}</span>
                      </div>
                    </td>
                    <td className="text-center py-2 px-2 text-white/50">{row.cls || '—'}</td>
                    <td className="text-center py-2 px-2 text-white/50">{row.position || '—'}</td>
                    <td className="text-center py-2 px-2 text-white/60 tabular-nums">{row.gp || '—'}</td>
                    <td className="text-center py-2 px-2 text-white font-bold tabular-nums">{row.primary || '—'}</td>
                    {showPerGame && (
                      <td className="text-center py-2 px-2 text-white/60 tabular-nums">{perGame(row.primary, row.gp)}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!err && !loading && data && (!data.rows || data.rows.length === 0) && (
        <EmptyState text="No leaderboard rows yet. Likely off-season or NCAA hasn't published this category yet." />
      )}

      {data?.updated && (
        <div className="mt-4 text-[10px] mono uppercase tracking-widest text-white/30">
          Updated {data.updated}
        </div>
      )}
    </div>
  );
}

// Build a stats array from a WMT/Sidearm player row so PlayerModal can
// render stats without hitting NCAA leaderboards.
function buildRowStats(player) {
  const side = player.side || 'batting';
  const entries = side === 'pitching'
    ? [
        ['ERA',  player.ERA],
        ['IP',   player.IP],
        ['W',    player.W],
        ['L',    player.L],
        ['SV',   player.SV],
        ['SHO',  player.SHO],
        ['K',    player.K],
        ['BB',   player.BB],
        ['H',    player.H],
        ['ER',   player.ER],
        ['WHIP', player.WHIP],
        ['K/7',  player['K/7']],
        ['App',  player.games],
      ]
    : [
        ['BA',  player.BA],
        ['OBP', player.OBP],
        ['SLG', player.SLG],
        ['HR',  player.HR],
        ['RBI', player.RBI],
        ['H',   player.H],
        ['AB',  player.AB],
        ['R',   player.R],
        ['2B',  player['2B']],
        ['3B',  player['3B']],
        ['BB',  player.BB],
        ['K',   player.K],
        ['SB',  player.SB],
        ['G',   player.games],
      ];
  return entries
    .filter(([, v]) => v != null && v !== '')
    .map(([label, value]) => ({ label, value: String(value) }));
}

function PlayerModal({ player, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [photo, setPhoto] = useState(null);      // Sidearm/roster photo result
  const [photoBroken, setPhotoBroken] = useState(false);

  useEffect(() => {
    setData(null); setErr(null);
    // If the player row already carries WMT/conference stats, use them
    // directly — no NCAA leaderboard fetch needed.
    const side = player.side || 'batting';
    const hasBatting  = player.BA != null || player.AB != null || player.HR != null;
    const hasPitching = player.ERA != null || player.IP != null;
    if (hasBatting || hasPitching) {
      const stats = buildRowStats(player);
      setData({
        stats,
        appearsIn: [],
        side,
        player: {
          name:     player.name,
          team:     player.team,
          position: player.position,
          cls:      player.classYear,
          gp:       player.games,
        },
      });
      return;
    }
    // Fallback: fetch from NCAA leaderboards (players not in a conference feed).
    let cancelled = false;
    const url = `/api/player-stats?profile=1&name=${encodeURIComponent(player.name)}&team=${encodeURIComponent(player.team || '')}&side=${encodeURIComponent(side)}`;
    fetch(url)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || j.error) setErr(j.error || `HTTP ${r.status}`);
        else setData(j);
      })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [player.name, player.team, player.side, player.BA, player.ERA]);

  // ESPN headshot lookup (separate from profile fetch so it doesn't block stats).
  useEffect(() => {
    let cancelled = false;
    setPhoto(null); setPhotoBroken(false);
    // If the player row already has a Sidearm photo, use it directly.
    if (player.photoUrl) {
      setPhoto({ matched: true, photoUrl: player.photoUrl, teamLogo: null });
      return;
    }
    if (!player.name || !player.team) return;
    const url = `/api/player-photo?name=${encodeURIComponent(player.name)}&team=${encodeURIComponent(player.team)}`;
    fetch(url)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j && !j.error) setPhoto(j); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [player.name, player.team, player.photoUrl]);

  // Esc closes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl border border-white/10" style={{ background: '#141210' }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="sticky top-4 float-right mr-4 z-10 p-2 rounded-full bg-black/40 hover:bg-white/10 text-white/60 hover:text-white">
          <X className="h-4 w-4" />
        </button>

        <div className="px-6 pt-6 pb-4">
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-2">
            {player.position ? `${player.position} · ` : ''}{player.side === 'pitching' ? 'Pitching Profile' : 'Batting Profile'}
            {player.jersey ? <span className="ml-2 opacity-60">#{player.jersey}</span> : null}
          </div>
          <div className="flex items-center gap-5">
            {/* Headshot column: ESPN photo if we matched, else team logo, else nothing. */}
            {photo?.matched && photo.photoUrl && !photoBroken ? (
              <div className="relative flex-shrink-0">
                <img
                  src={photo.photoUrl}
                  alt={data?.player?.name || player.name}
                  className="h-20 w-20 rounded-full object-cover border-2 border-white/10"
                  style={{ background: '#1f1d1a' }}
                  onError={() => setPhotoBroken(true)}
                />
                {(photo?.teamLogo || data?.player?.teamLogo) && (
                  <img
                    src={photo.teamLogo || data.player.teamLogo}
                    alt=""
                    className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full object-contain p-0.5 border border-white/20"
                    style={{ background: '#0a0908' }}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
              </div>
            ) : (data?.player?.teamLogo || photo?.teamLogo) ? (
              <img
                src={data?.player?.teamLogo || photo.teamLogo}
                alt=""
                className="h-16 w-16 object-contain flex-shrink-0"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            ) : null}

            <div className="min-w-0">
              <div className="display text-white text-3xl font-bold leading-tight truncate">{data?.player?.name || player.name}</div>
              <div className="text-white/50 text-sm mono truncate">
                {data?.player?.team || player.team}
                {(data?.player?.position || photo?.position) && <span className="text-white/30"> · {data?.player?.position || photo.position}</span>}
                {data?.player?.cls && <span className="text-white/30"> · {data.player.cls}</span>}
                {photo?.jersey && <span className="text-white/30"> · #{photo.jersey}</span>}
                {data?.player?.gp && <span className="text-white/30"> · {data.player.gp} G</span>}
              </div>
            </div>
          </div>
          {/* Bio details row */}
          {(player.classYear || player.hometown || player.highSchool || player.previousSchool || player.heightDisplay || player.batThrows) && (
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs mono">
              {player.classYear && (() => {
                const yr = (player.classYear || '').trim().toLowerCase().replace(/\.$/, '');
                const isSr = yr === 'sr' || yr === 'senior';
                const isFr = yr === 'fr' || yr === 'freshman';
                return (
                  <span style={isSr ? { color: 'rgba(200,170,110,0.9)' } : isFr ? { color: 'rgba(200,80,80,0.85)' } : { color: 'rgba(255,255,255,0.4)' }}>
                    <span style={{ color: 'rgba(255,255,255,0.25)', marginRight: '4px' }}>CLASS</span>{player.classYear}
                  </span>
                );
              })()}
              {player.heightDisplay && (
                <span className="text-white/40">
                  <span className="text-white/25 mr-1">HT</span>{player.heightDisplay}
                  {player.weight ? <span className="text-white/25 mx-1">·</span> : null}
                  {player.weight ? <span className="text-white/25 mr-1">WT</span> : null}
                  {player.weight ? player.weight + ' lbs' : null}
                </span>
              )}
              {player.batThrows && (
                <span className="text-white/40"><span className="text-white/25 mr-1">B/T</span>{player.batThrows}</span>
              )}
              {player.hometown && (
                <span className="text-white/40"><span className="text-white/25 mr-1">FROM</span>{player.hometown}</span>
              )}
              {player.highSchool && (
                <span className="text-white/40"><span className="text-white/25 mr-1">PREP</span>{player.highSchool}</span>
              )}
              {player.previousSchool && (
                <span className="text-orange-400/80"><span className="text-orange-400/40 mr-1">TRANSFER</span>{player.previousSchool}</span>
              )}
            </div>
          )}
        </div>

        <div className="p-6 pt-0">
          {!data && !err && (
            <div className="text-center py-12 text-white/30 mono text-xs tracking-widest uppercase">Loading profile…</div>
          )}
          {err && (
            <div className="text-center py-12">
              <div className="text-white/40 text-sm mb-2">No stats available for this player.</div>
              <div className="text-white/30 text-xs mono">{err}</div>
            </div>
          )}
          {data && (
            <>
              {player.primaryShort && player.primaryValue && (
                <div className="mb-6 p-5 rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent flex items-center gap-5">
                  <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40">{player.primaryShort}</div>
                  <div className="display text-5xl font-black tabular-nums" style={{ color: '#ff6b1a' }}>{player.primaryValue}</div>
                </div>
              )}

              {data.stats && data.stats.length > 0 && (
                <div className="mb-6">
                  <div className="text-[10px] mono tracking-[0.25em] uppercase text-white/40 mb-3">Season Stat Line</div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {data.stats.map((s, i) => {
                      const full = fullStatName(s.label, data.side || player.side);
                      const hasExpansion = full !== s.label;
                      return (
                        <div key={`${s.label}-${i}`} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                          <div className="text-[10px] leading-tight text-white/60">{full}</div>
                          {hasExpansion && (
                            <div className="text-[9px] mono tracking-[0.2em] uppercase text-white/30 mt-0.5">{s.label}</div>
                          )}
                          <div className="text-white tabular-nums mono text-lg font-bold mt-1">{s.value}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {data.appearsIn && data.appearsIn.length > 0 && (
                <div>
                  <div className="text-[10px] mono tracking-[0.25em] uppercase text-white/40 mb-3">Leaderboard Appearances</div>
                  <div className="flex flex-wrap gap-2">
                    {data.appearsIn.map((a) => (
                      <div
                        key={a.slug}
                        className="px-3 py-2 rounded-lg border border-white/10 bg-white/[0.02] text-xs flex items-center gap-2"
                      >
                        <span className="text-white/40 mono uppercase tracking-wider text-[10px]">#{a.rank}</span>
                        <span className="text-white/80">{a.short || a.label}</span>
                        <span className="text-white mono tabular-nums font-bold">{a.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 pb-6 pt-4 border-t border-white/5 text-[10px] mono uppercase tracking-widest text-white/30">
          {data && !data.appearsIn?.length ? 'Stats via conference feed' : 'Aggregated from NCAA.com season leaderboards'} · Press Esc to close
        </div>
      </div>
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="text-center py-12 text-white/30 text-sm">{text}</div>;
}
