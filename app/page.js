'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Trophy, TrendingUp, X, ChevronLeft, ChevronRight, Zap, Activity, Users } from 'lucide-react';

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
  const pollRef = useRef(null);

  const fetchScores = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const r = await fetch(proxy(`${ESPN_SITE}/scoreboard?dates=${fmtDate(date)}&limit=200`));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setGames(d.events || []);
      setLastUpdate(new Date());
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [date]);

  const fetchRankings = useCallback(async () => {
    try {
      const r = await fetch(proxy(`${ESPN_SITE}/rankings`));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRankings(await r.json());
    } catch (e) { setError(e.message); }
  }, []);

  const fetchGameDetail = async (eventId) => {
    setGameDetail(null);
    try {
      const r = await fetch(proxy(`${ESPN_WEBAPI}/summary?event=${eventId}`));
      setGameDetail(await r.json());
    } catch (e) { setGameDetail({ error: e.message }); }
  };

  useEffect(() => { fetchScores(); fetchRankings(); }, [fetchScores, fetchRankings]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const hasLive = games.some((g) => g.status?.type?.state === 'in');
    if (hasLive && tab === 'scores') {
      pollRef.current = setInterval(() => fetchScores(true), 20000);
    }
    return () => pollRef.current && clearInterval(pollRef.current);
  }, [games, tab, fetchScores]);

  const shiftDate = (days) => { const d = new Date(date); d.setDate(d.getDate() + days); setDate(d); };
  const liveCount = games.filter((g) => g.status?.type?.state === 'in').length;
  const finalCount = games.filter((g) => g.status?.type?.state === 'post').length;

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
            <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <button onClick={() => shiftDate(-1)} className="p-2 rounded-full border border-white/10 hover:border-white/30 text-white/60 hover:text-white transition"><ChevronLeft className="h-4 w-4" /></button>
                <div className="px-4 py-2 text-center min-w-[260px]">
                  <div className="text-[10px] mono tracking-[0.25em] uppercase text-white/40">{liveCount > 0 ? 'Live Now' : 'Date'}</div>
                  <div className="display text-white text-xl">{prettyDate(date)}</div>
                </div>
                <button onClick={() => shiftDate(1)} className="p-2 rounded-full border border-white/10 hover:border-white/30 text-white/60 hover:text-white transition"><ChevronRight className="h-4 w-4" /></button>
                <button onClick={() => setDate(new Date())} className="ml-2 px-3 py-1.5 text-[10px] mono uppercase tracking-widest rounded-full border border-white/10 text-white/60 hover:text-white hover:border-white/30 transition">Today</button>
              </div>
              <div className="text-[10px] mono tracking-widest uppercase text-white/30">
                {lastUpdate && `Updated ${lastUpdate.toLocaleTimeString()}`} {liveCount > 0 && '· Auto-refresh 20s'}
              </div>
            </div>

            {loading && games.length === 0 ? (
              <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading scoreboard…</div>
            ) : games.length === 0 ? (
              <div className="text-center py-20">
                <div className="display text-white/20 text-4xl mb-2">No games scheduled</div>
                <div className="text-white/40 text-sm">Try a different date — softball season runs Feb–June.</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {games.map((g, i) => (
                  <GameCard key={g.id} game={g} index={i} onClick={() => { setSelectedGame(g); fetchGameDetail(g.id); }} />
                ))}
              </div>
            )}

            {(liveCount > 0 || finalCount > 0) && (
              <div className="mt-10 pt-6 border-t border-white/5 flex gap-8 text-[10px] mono uppercase tracking-widest text-white/30">
                <span>{games.length} Total</span>
                <span className="text-red-400/60">{liveCount} Live</span>
                <span>{finalCount} Final</span>
              </div>
            )}
          </div>
        )}

        {tab === 'rankings' && <RankingsView rankings={rankings} lastUpdate={lastUpdate} />}
        {tab === 'standings' && <StandingsView />}
        {tab === 'leaders' && <LeadersView onSelectPlayer={setSelectedPlayer} />}
        {tab === 'stats' && <StatsView onSelectTeam={setSelectedTeam} />}
      </main>

      {selectedGame && <GameModal game={selectedGame} detail={gameDetail} rankings={rankings} onRefresh={() => fetchGameDetail(selectedGame.id)} onClose={() => { setSelectedGame(null); setGameDetail(null); }} />}
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
      <div className={`flex items-center justify-between py-2 ${dim ? 'opacity-40' : ''}`}>
        <div className="flex items-center gap-3 min-w-0">
          {t.logo && <img src={t.logo} alt="" className="h-7 w-7 object-contain" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {rank && rank < 99 && <span className="text-[10px] mono text-white/40">#{rank}</span>}
              <span className="text-white font-semibold truncate text-sm">{t.shortDisplayName || t.displayName}</span>
            </div>
            <div className="text-[10px] text-white/30 mono uppercase">{team?.records?.[0]?.summary || ''}</div>
          </div>
        </div>
        <div className={`mono text-2xl font-bold tabular-nums ${winner === side ? 'text-white' : 'text-white/70'}`}>{team?.score ?? '—'}</div>
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
      className="card-enter group relative rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.03] to-transparent p-5 cursor-pointer hover:border-white/30 hover:from-white/[0.06] transition-all"
      style={{ animationDelay: `${Math.min(index * 40, 400)}ms`, ...coverageGlow }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isLive && <span className="live-dot h-1.5 w-1.5 rounded-full bg-red-500"></span>}
          <span className={`text-[10px] mono uppercase tracking-widest ${isLive ? 'text-red-400' : isFinal ? 'text-white/50' : 'text-white/30'}`}>{detail}</span>
          {isTop10 && (
            <span className="text-[9px] mono uppercase tracking-widest px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,107,26,0.12)', color: '#ff6b1a', border: '1px solid rgba(255,107,26,0.3)' }}>
              Top 10
            </span>
          )}
        </div>
        {comp.broadcasts?.[0]?.names?.[0] && <span className="text-[9px] mono uppercase text-white/30">{comp.broadcasts[0].names[0]}</span>}
      </div>
      <div className="space-y-1">
        <TeamRow team={away} side="away" />
        <div className="h-px bg-white/5"></div>
        <TeamRow team={home} side="home" />
      </div>
      {isLive && comp.situation && (
        <div className="mt-3 pt-3 border-t border-white/5 flex items-center gap-4">
          <Diamond
            onFirst={!!comp.situation.onFirst}
            onSecond={!!comp.situation.onSecond}
            onThird={!!comp.situation.onThird}
            size={56}
          />
          <CountOuts
            balls={comp.situation.balls}
            strikes={comp.situation.strikes}
            outs={comp.situation.outs}
          />
          <div className="flex-1 min-w-0">
            {comp.situation.batter?.athlete && (
              <div className="text-[10px] mono uppercase tracking-widest text-white/40">At Bat</div>
            )}
            {comp.situation.batter?.athlete && (
              <div className="text-white text-xs font-semibold truncate">{comp.situation.batter.athlete.shortName || comp.situation.batter.athlete.displayName}</div>
            )}
            {comp.situation.pitcher?.athlete && (
              <div className="text-white/50 text-[10px] mono truncate">P: {comp.situation.pitcher.athlete.shortName || comp.situation.pitcher.athlete.displayName}</div>
            )}
          </div>
        </div>
      )}
      {comp.venue?.fullName && (
        <div className="mt-3 pt-3 border-t border-white/5 text-[10px] text-white/30 mono uppercase tracking-wide truncate">
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

function StatsView({ onSelectTeam }) {
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
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
  if (loading) return <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading teams…</div>;
  if (err) return <div className="text-center py-20 text-red-400">Error: {err}</div>;
  return (
    <div>
      <div className="mb-6 border-b border-white/10 pb-3">
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40">Directory</div>
        <h2 className="display text-white text-3xl font-bold">D1 Teams <span className="text-white/30 text-lg">· {teams.length}</span></h2>
        <p className="text-white/40 text-xs mt-1">Click any team to view its full roster.</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {teams.map((t, i) => (
          <button
            key={t.id}
            onClick={() => onSelectTeam && onSelectTeam(t)}
            className="card-enter flex items-center gap-3 p-3 rounded-lg border border-white/5 hover:border-white/30 hover:bg-white/[0.03] transition text-left"
            style={{ animationDelay: `${Math.min(i * 8, 600)}ms`, borderLeft: `3px solid ${t.color ? '#' + t.color : '#ff6b1a'}` }}
          >
            {t.logos?.[0]?.href && <img src={t.logos[0].href} alt="" className="h-8 w-8 object-contain flex-shrink-0" />}
            <div className="min-w-0">
              <div className="text-white text-xs font-semibold truncate">{t.shortDisplayName || t.displayName}</div>
              <div className="text-[9px] mono text-white/30 uppercase truncate">{t.abbreviation}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TeamModal({ team, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null);
    fetch(`/api/team-roster?teamId=${encodeURIComponent(team.id)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || j.error) setErr(j.error || `HTTP ${r.status}`);
        else setData(j);
      })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [team.id]);

  // Esc closes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const logo = data?.team?.logo || team?.logos?.[0]?.href;
  const displayName = data?.team?.displayName || team?.displayName;
  const abbrev = data?.team?.abbreviation || team?.abbreviation;
  const color = data?.team?.color || (team?.color ? `#${team.color}` : '#ff6b1a');

  // Group athletes by primary position bucket so scouts can scan quickly.
  const grouped = (() => {
    if (!data?.athletes) return null;
    const buckets = {
      Pitchers: [],
      Catchers: [],
      Infielders: [],
      Outfielders: [],
      'Utility / Other': [],
    };
    for (const a of data.athletes) {
      const pos = (a.position || '').toUpperCase();
      if (pos === 'P' || pos === 'RHP' || pos === 'LHP') buckets.Pitchers.push(a);
      else if (pos === 'C') buckets.Catchers.push(a);
      else if (pos === '1B' || pos === '2B' || pos === '3B' || pos === 'SS' || pos === 'IF') buckets.Infielders.push(a);
      else if (pos === 'OF' || pos === 'LF' || pos === 'CF' || pos === 'RF') buckets.Outfielders.push(a);
      else buckets['Utility / Other'].push(a);
    }
    return buckets;
  })();

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
            <div className="min-w-0">
              <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-1">Roster</div>
              <div className="display text-white text-3xl font-bold leading-tight truncate">{displayName || 'Team'}</div>
              <div className="text-white/50 text-xs mono mt-1">
                {abbrev && <span>{abbrev}</span>}
                {data?.meta?.rosterSize != null && <span className="text-white/30"> · {data.meta.rosterSize} players</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="p-6">
          {!data && !err && (
            <div className="text-center py-12 text-white/30 mono text-xs tracking-widest uppercase">Loading roster…</div>
          )}
          {err && (
            <div className="text-center py-12">
              <div className="text-white/40 text-sm mb-2">Couldn't load roster.</div>
              <div className="text-white/30 text-xs mono">{err}</div>
            </div>
          )}
          {data && grouped && (
            <div className="space-y-8">
              {Object.entries(grouped).map(([label, list]) => {
                if (list.length === 0) return null;
                return (
                  <div key={label}>
                    <div className="text-[10px] mono tracking-[0.25em] uppercase text-white/40 mb-3">{label} <span className="text-white/20">· {list.length}</span></div>
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
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((a) => (
                            <tr key={a.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                              <td className="py-2 px-3 text-white/50 tabular-nums">{a.jersey || '—'}</td>
                              <td className="py-2 px-3 text-white whitespace-nowrap">{a.name}</td>
                              <td className="text-center py-2 px-2 text-white/60">{a.position || '—'}</td>
                              <td className="text-center py-2 px-2 text-white/60">{a.classYear || '—'}</td>
                              <td className="text-center py-2 px-2 text-white/50">{[a.bats, a.throws].filter(Boolean).join('/') || '—'}</td>
                              <td className="text-center py-2 px-2 text-white/50">{a.heightDisplay || '—'}</td>
                              <td className="text-center py-2 px-2 text-white/50">{a.weightDisplay || '—'}</td>
                              <td className="py-2 px-3 text-white/50 truncate max-w-[180px]">{a.birthPlace || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-6 pb-6 pt-4 border-t border-white/5 text-[10px] mono uppercase tracking-widest text-white/30">
          Roster via ESPN · Press Esc to close
        </div>
      </div>
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

// Curated categories the Team Compare tab scouts. Must stay in sync with the
// slugs the player-stats route actually matches — these are the same slugs
// surfaced in the Players tab. `lowerIsBetter` flags the two pitching stats
// (ERA, WHIP) where a smaller number is the good number; everything else
// higher-wins.
const COMPARE_BATTING = [
  { slug: 'batting-avg',  short: 'BA'  },
  { slug: 'home-runs',    short: 'HR'  },
  { slug: 'rbi',          short: 'RBI' },
  { slug: 'hits',         short: 'H'   },
  { slug: 'runs-scored',  short: 'R'   },
  { slug: 'stolen-bases', short: 'SB'  },
  { slug: 'on-base-pct',  short: 'OBP' },
  { slug: 'slugging-pct', short: 'SLG' },
  { slug: 'doubles',      short: '2B'  },
  { slug: 'triples',      short: '3B'  },
];
// `whip` previously lived in this list but the henrygd wrapper returns 500
// "Could not parse data" for NCAA stat id 1237 (individual WHIP), which is
// the only id NCAA exposes for it in softball. The Leaders sub-tab row
// showed dashes for both teams; dropping it makes the list honest.
const COMPARE_PITCHING = [
  { slug: 'era',             short: 'ERA',  lowerIsBetter: true },
  { slug: 'wins',            short: 'W'    },
  { slug: 'strikeouts',      short: 'K'    },
  { slug: 'saves',           short: 'SV'   },
  { slug: 'k-per-7',         short: 'K/7'  },
  { slug: 'innings-pitched', short: 'IP'   },
  { slug: 'shutouts',        short: 'SHO'  },
];

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

function TeamCompareTab({ home, away, rankings }) {
  const [leaders, setLeaders] = useState(null); // { [slug]: { rows, short, label } }
  const [homeStats, setHomeStats] = useState(null);  // /api/team-stats payload for home
  const [awayStats, setAwayStats] = useState(null);  // /api/team-stats payload for away
  const [homeStatsErr, setHomeStatsErr] = useState(null);
  const [awayStatsErr, setAwayStatsErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [subTab, setSubTab] = useState('totals'); // 'totals' | 'leaders' | 'players'

  const homeName = home?.team?.displayName || home?.team?.name || '';
  const awayName = away?.team?.displayName || away?.team?.name || '';
  const homeId = home?.team?.id ? String(home.team.id) : null;
  const awayId = away?.team?.id ? String(away.team.id) : null;

  // Fetch NCAA leaders (existing) + team box-score aggregates for both teams.
  // Dependency list is JUST the team ids so the effect doesn't accidentally
  // re-fire every time the parent GameModal re-renders with new prop object
  // references (which it does whenever the scoreboard polls or the summary
  // fetch resolves). Earlier versions depended on derived name strings too
  // and got caught by that exact flicker loop.
  useEffect(() => {
    let cancelled = false;
    const allSlugs = [...COMPARE_BATTING, ...COMPARE_PITCHING].map((c) => c.slug);
    setLoading(true); setErr(null);
    setHomeStats(null); setAwayStats(null);
    setHomeStatsErr(null); setAwayStatsErr(null);
    Promise.all(
      allSlugs.map((slug) =>
        fetch(`/api/player-stats?category=${encodeURIComponent(slug)}`)
          .then((r) => r.json())
          .then((d) => ({ slug, data: d }))
          .catch((e) => ({ slug, data: { error: e.message } }))
      )
    )
      .then((catResults) => {
        if (cancelled) return;
        const map = {};
        for (const { slug, data } of catResults) {
          if (data && !data.error) map[slug] = data;
        }
        setLeaders(map);
      })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    // Fire team-stats independently so slow box-score aggregation doesn't
    // block the leaders section from rendering. Errors are recorded in
    // per-team error state so the UI can show them instead of silently
    // leaving the column stuck on "Loading…".
    if (homeId) {
      fetch(`/api/team-stats?teamId=${encodeURIComponent(homeId)}`)
        .then(async (r) => {
          const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          if (cancelled) return;
          if (!r.ok || j.error) setHomeStatsErr(j.error || `HTTP ${r.status}`);
          else setHomeStats(j);
        })
        .catch((e) => { if (!cancelled) setHomeStatsErr(e.message); });
    }
    if (awayId) {
      fetch(`/api/team-stats?teamId=${encodeURIComponent(awayId)}`)
        .then(async (r) => {
          const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          if (cancelled) return;
          if (!r.ok || j.error) setAwayStatsErr(j.error || `HTTP ${r.status}`);
          else setAwayStats(j);
        })
        .catch((e) => { if (!cancelled) setAwayStatsErr(e.message); });
    }
    return () => { cancelled = true; };
  }, [homeId, awayId]);

  // ESPN already attaches season records, rank, and conference metadata to the
  // scoreboard competitor objects, so we read straight off `home`/`away` rather
  // than going through /api/standings (which depends on an unreliable upstream
  // and was returning stale data).
  const extractEspn = (competitor) => {
    if (!competitor) return null;
    const t = competitor.team || {};
    const records = Array.isArray(competitor.records) ? competitor.records : [];
    const byType = (type) =>
      records.find((r) => (r.type || r.name || '').toLowerCase() === type) ||
      records.find((r) => (r.type || r.name || '').toLowerCase().includes(type));
    const total = byType('total') || records[0] || null;
    const conf = byType('vsconf') || byType('conf');
    const home = byType('home');
    const road = byType('road') || byType('away');
    const streak = byType('streak');
    // Parse "W-L" summary into numbers so we can show a pct.
    const parseWL = (summary) => {
      if (!summary) return { w: null, l: null };
      const m = String(summary).match(/^(\d+)-(\d+)/);
      return m ? { w: parseInt(m[1], 10), l: parseInt(m[2], 10) } : { w: null, l: null };
    };
    const totalWL = parseWL(total?.summary);
    const pct = totalWL.w != null && (totalWL.w + totalWL.l) > 0
      ? totalWL.w / (totalWL.w + totalWL.l)
      : null;
    return {
      name: t.displayName || t.name || '',
      logo: t.logo || t.logos?.[0]?.href || null,
      conference: competitor.conference?.name || t.conferenceAbbreviation || '',
      total: total?.summary || '',
      totalW: totalWL.w,
      totalL: totalWL.l,
      pct,
      conf: conf?.summary || '',
      home: home?.summary || '',
      road: road?.summary || '',
      streak: streak?.summary || streak?.displayValue || '',
      curatedRank: competitor?.curatedRank?.current || null,
    };
  };

  // The top player on a given team in a given category, matched by normalized
  // team name. The leaderboard is already rank-sorted, so .find() gives us #1.
  const findLeader = (slug, teamName) => {
    const data = leaders?.[slug];
    if (!data?.rows || !teamName) return null;
    const key = normalizeTeamName(teamName);
    if (!key) return null;
    return data.rows.find((r) => normalizeTeamName(r.team) === key)
      || data.rows.find((r) => {
        const n = normalizeTeamName(r.team);
        return n.includes(key) || key.includes(n);
      }) || null;
  };

  // Pull poll rank/trend for a team out of the rankings prop (fallback if the
  // scoreboard's curatedRank isn't set on this competitor).
  const pollRank = (teamName) => {
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
  };

  const awayEspn = extractEspn(away);
  const homeEspn = extractEspn(home);
  const awayRank = awayEspn?.curatedRank
    ? { current: awayEspn.curatedRank, previous: null }
    : pollRank(awayName);
  const homeRank = homeEspn?.curatedRank
    ? { current: homeEspn.curatedRank, previous: null }
    : pollRank(homeName);

  const pctStr = (n) => (n != null ? n.toFixed(3).replace(/^0/, '') : '—');

  if (err) {
    return <EmptyState text={`Error loading team compare: ${err}`} />;
  }

  // ---------------- Render helpers ----------------
  // Everything below is plain functions that RETURN JSX, not inner React
  // components. That matters because inner arrow-function components
  // (`const Foo = () => ...`) are a new function identity on every parent
  // render, which makes React treat every render as "different component
  // type" and unmount + remount the whole inner tree. That was surfacing
  // as the sub-tab resetting every 4-5s when the team-stats fetch resolved.
  // Render helpers sidestep the issue because their returned JSX is just
  // reconciled positionally.

  const renderTeamHeader = (data, rank, align) => {
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

  // Decide who's better in a given stat row. Returns 'home' | 'away' | null.
  const pickWinner = (awayLeader, homeLeader, lowerIsBetter) => {
    const a = awayLeader ? parseFloat(awayLeader.primary) : NaN;
    const h = homeLeader ? parseFloat(homeLeader.primary) : NaN;
    if (!Number.isFinite(a) && !Number.isFinite(h)) return null;
    if (!Number.isFinite(a)) return 'home';
    if (!Number.isFinite(h)) return 'away';
    if (a === h) return null;
    return (lowerIsBetter ? a < h : a > h) ? 'away' : 'home';
  };

  const renderLeaderCell = (leader, align, isWinner) => {
    if (!leader) {
      return <div className={`text-white/20 text-xs mono ${align === 'right' ? 'text-right' : 'text-left'}`}>—</div>;
    }
    const winnerStyle = isWinner ? { color: '#ff6b1a' } : {};
    return (
      <div className={`min-w-0 ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <div className={`text-sm font-semibold truncate ${isWinner ? '' : 'text-white'}`} style={winnerStyle}>
          <span className={`mono text-[10px] mr-1.5 ${isWinner ? 'text-white/50' : 'text-white/40'}`}>#{leader.rank}</span>
          {leader.name}
        </div>
        <div className={`mono text-[11px] tabular-nums font-bold ${isWinner ? '' : 'text-white/50'}`} style={winnerStyle}>{leader.primary}</div>
      </div>
    );
  };

  const renderStatRow = (slug, short, lowerIsBetter) => {
    const awayLeader = findLeader(slug, awayName);
    const homeLeader = findLeader(slug, homeName);
    const winner = pickWinner(awayLeader, homeLeader, lowerIsBetter);
    return (
      <div key={slug} className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center py-2.5 border-b border-white/5">
        {renderLeaderCell(awayLeader, 'right', winner === 'away')}
        <div className="text-center text-[10px] mono uppercase tracking-widest text-white/40 w-14">{short}</div>
        {renderLeaderCell(homeLeader, 'left', winner === 'home')}
      </div>
    );
  };

  // Pick winner on a numeric team total stat. Handles lower-is-better (ERA, WHIP).
  const pickNumericWinner = (awayVal, homeVal, lowerIsBetter) => {
    const a = parseFloat(awayVal);
    const h = parseFloat(homeVal);
    if (!Number.isFinite(a) && !Number.isFinite(h)) return null;
    if (!Number.isFinite(a)) return 'home';
    if (!Number.isFinite(h)) return 'away';
    if (a === h) return null;
    return (lowerIsBetter ? a < h : a > h) ? 'away' : 'home';
  };

  const renderTotalRow = (key, label, short, get, lowerIsBetter) => {
    const av = awayStats ? get(awayStats) : null;
    const hv = homeStats ? get(homeStats) : null;
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

  // ---------------- Totals sub-tab ----------------
  const renderTotals = () => {
    // If both teams have definite errors, surface them.
    if (homeStatsErr && awayStatsErr && !homeStats && !awayStats) {
      return (
        <div className="text-center py-10">
          <div className="text-white/40 text-sm mb-2">Couldn't load team stats for either team.</div>
          <div className="text-white/30 text-xs mono">{awayName}: {awayStatsErr}</div>
          <div className="text-white/30 text-xs mono">{homeName}: {homeStatsErr}</div>
        </div>
      );
    }
    if (!homeStats && !awayStats) {
      return <div className="text-white/30 mono text-xs tracking-widest uppercase text-center py-10">Loading team totals…</div>;
    }

    const coverageLine = (s) => {
      if (!s?.meta) return null;
      const wb = s.meta.gamesWithBatting ?? 0;
      const wp = s.meta.gamesWithPitching ?? 0;
      const total = s.meta.completedEvents ?? 0;
      return `${wb}/${total} batting · ${wp}/${total} pitching`;
    };

    const errNote = (teamLabel, errMsg) => errMsg
      ? <span className="text-red-400/70"> · {teamLabel} failed: {errMsg}</span>
      : null;

    return (
      <div className="space-y-6">
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Season</div>
          {renderTotalRow('record',  'Record',       'W-L',  (s) => s.teamMeta ? `${s.teamMeta.wins}-${s.teamMeta.losses}` : null)}
          {renderTotalRow('rs',      'Runs Scored',  'RS',   (s) => s.teamMeta?.runsFor ?? null)}
          {renderTotalRow('ra',      'Runs Allowed', 'RA',   (s) => s.teamMeta?.runsAgainst ?? null, true)}
          {renderTotalRow('diff',    'Run Diff',     'DIFF', (s) => {
            const rf = s.teamMeta?.runsFor;
            const ra = s.teamMeta?.runsAgainst;
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
          {renderTotalRow('hr',  'Box HR',       'HR',  (s) => s.totals?.batting?.HR)}
          {renderTotalRow('rbi', 'Box RBI',      'RBI', (s) => s.totals?.batting?.RBI)}
          {renderTotalRow('bb',  'Box BB',       'BB',  (s) => s.totals?.batting?.BB)}
          {renderTotalRow('bk',  'Box K',        'K',   (s) => s.totals?.batting?.K, true)}
        </div>

        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Team Pitching</div>
          {renderTotalRow('era',  'Earned Run Avg',   'ERA',  (s) => s.totals?.pitching?.ERA, true)}
          {renderTotalRow('whip', 'WHIP',             'WHIP', (s) => s.totals?.pitching?.WHIP, true)}
          {renderTotalRow('k7',   'K per 7 Innings',  'K/7',  (s) => s.totals?.pitching?.['K/7'])}
          {renderTotalRow('ip',   'Innings Pitched',  'IP',   (s) => s.totals?.pitching?.IP)}
          {renderTotalRow('tk',   'Total Strikeouts', 'SO',   (s) => s.totals?.pitching?.K)}
          {renderTotalRow('er',   'Box Earned Runs',  'ER',   (s) => s.totals?.pitching?.ER, true)}
        </div>

        <div className="text-[10px] mono text-white/30 text-center leading-relaxed">
          Season / run totals are authoritative from ESPN. Rates (BA, OBP, ERA, WHIP, K/7)
          are computed from summed box-score counting stats — accurate even when
          box-score coverage is partial.<br />
          <span className="text-white/20">
            Coverage — {awayName}: {coverageLine(awayStats) || (awayStatsErr ? 'error' : '…')}
            {errNote(awayName, awayStatsErr)}
            {' · '}
            {homeName}: {coverageLine(homeStats) || (homeStatsErr ? 'error' : '…')}
            {errNote(homeName, homeStatsErr)}
          </span>
        </div>
      </div>
    );
  };

  // ---------------- Leaders sub-tab ----------------
  const renderLeaders = () => (
    <div className="space-y-8">
      <div>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Top Hitters</div>
        {loading && !leaders ? (
          <div className="text-white/30 mono text-xs tracking-widest uppercase text-center py-6">Loading leaders…</div>
        ) : (
          <div>
            {COMPARE_BATTING.map((c) => renderStatRow(c.slug, c.short, c.lowerIsBetter))}
          </div>
        )}
      </div>

      <div>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-3">Ace Pitchers</div>
        {loading && !leaders ? (
          <div className="text-white/30 mono text-xs tracking-widest uppercase text-center py-6">Loading leaders…</div>
        ) : (
          <div>
            {COMPARE_PITCHING.map((c) => renderStatRow(c.slug, c.short, c.lowerIsBetter))}
          </div>
        )}
      </div>
    </div>
  );

  // ---------------- Players sub-tab ----------------
  const renderRosterTable = (stats, group) => {
    const rows = stats?.players?.[group] || [];
    if (rows.length === 0) {
      // Empty roster usually means ESPN had no box-score data for this team
      // in any of the season's games. Use the response meta to spell out
      // exactly what was found so the user knows whether the issue is
      // "schedule had zero completed games" vs "schedule had games but
      // none had box scores for this team".
      const m = stats?.meta;
      let detail = 'ESPN returned no box-score data for this team.';
      if (m) {
        if (m.completedEvents === 0) {
          detail = `ESPN's schedule for this team has 0 completed games (${m.scheduleEvents || 0} total scheduled).`;
        } else if (group === 'batting' && m.gamesWithBatting === 0) {
          detail = `0 of ${m.completedEvents} completed games had box-score batting data for this team.`;
        } else if (group === 'pitching' && m.gamesWithPitching === 0) {
          detail = `0 of ${m.completedEvents} completed games had box-score pitching data for this team.`;
        }
      }
      return (
        <div className="rounded-lg border border-white/5 bg-white/[0.01] p-4 text-center">
          <div className="text-white/40 text-xs mb-1">No box-score data</div>
          <div className="text-white/30 text-[10px] mono">{detail}</div>
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
                  <th className="text-center py-1.5 px-1 font-normal">BB</th>
                  <th className="text-center py-1.5 px-1 font-normal">ERA</th>
                  <th className="text-center py-1.5 px-1 font-normal">WHIP</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                <td className="py-1.5 px-2 text-white whitespace-nowrap truncate max-w-[140px]">{p.name}</td>
                <td className="text-center py-1.5 px-1 text-white/50 tabular-nums">{p.games}</td>
                {isBatting ? (
                  <>
                    <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{p.AB}</td>
                    <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{p.H}</td>
                    <td className="text-center py-1.5 px-1 text-white tabular-nums">{p.HR}</td>
                    <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{p.RBI}</td>
                    <td className="text-center py-1.5 px-1 text-white font-bold tabular-nums">{p.BA}</td>
                  </>
                ) : (
                  <>
                    <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{p.IP}</td>
                    <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{p.K}</td>
                    <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{p.BB}</td>
                    <td className="text-center py-1.5 px-1 text-white font-bold tabular-nums">{p.ERA}</td>
                    <td className="text-center py-1.5 px-1 text-white/70 tabular-nums">{p.WHIP}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // Render a single team's side of the Players comparison. Shows an error
  // message if that team's fetch failed instead of an invisible empty column.
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
    return renderRosterTable(stats, group);
  };

  const renderPlayers = () => {
    // Both teams failed — show the most prominent error state.
    if (homeStatsErr && awayStatsErr && !homeStats && !awayStats) {
      return (
        <div className="text-center py-10">
          <div className="text-white/40 text-sm mb-2">Couldn't load player stats for either team.</div>
          <div className="text-white/30 text-xs mono">{awayName}: {awayStatsErr}</div>
          <div className="text-white/30 text-xs mono">{homeName}: {homeStatsErr}</div>
        </div>
      );
    }
    // Neither team loaded yet (both still pending).
    if (!homeStats && !awayStats && !homeStatsErr && !awayStatsErr) {
      return <div className="text-white/30 mono text-xs tracking-widest uppercase text-center py-10">Loading player stats…</div>;
    }

    return (
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
          Per-player stats from ESPN box scores. G is the number of box-scored
          games a player appears in — may be fewer than their actual games if
          ESPN only shipped a linescore for some of them.
        </div>
      </div>
    );
  };

  const SUB_TABS = [
    { id: 'totals',  label: 'Team Totals' },
    { id: 'leaders', label: 'NCAA Leaders' },
    { id: 'players', label: 'Player Compare' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center pb-5 border-b border-white/10">
        {renderTeamHeader(awayEspn, awayRank, 'right')}
        <div className="text-white/30 mono text-[10px] uppercase tracking-[0.3em]">vs</div>
        {renderTeamHeader(homeEspn, homeRank, 'left')}
      </div>

      <div className="flex gap-1 p-1 rounded-full border border-white/10 bg-white/[0.02] w-fit mx-auto">
        {SUB_TABS.map((t) => (
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

      {subTab === 'totals' && renderTotals()}
      {subTab === 'leaders' && renderLeaders()}
      {subTab === 'players' && renderPlayers()}

      <div className="text-[10px] mono uppercase tracking-widest text-white/30 text-center pt-4 border-t border-white/5">
        Records via ESPN · Leaders from NCAA · Box scores via ESPN
      </div>
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
        Auto-refresh every 15s
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
        const r = await fetch('/api/standings');
        const json = await r.json().catch(() => ({}));
        if (!r.ok || json.error) {
          setDebug(json.debug || null);
          throw new Error(json.error || `HTTP ${r.status}`);
        }
        setData(json);
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
    return <EmptyState text="No standings parsed from ESPN's page. They may have changed their HTML structure." />;
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
          <select
            id="leaders-category"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!categories || sideCats.length === 0}
            className="appearance-none pl-4 pr-10 py-2 rounded-lg border border-white/10 bg-white/[0.03] hover:border-white/30 focus:border-white/40 focus:outline-none text-white text-sm mono tracking-wide cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ colorScheme: 'dark' }}
          >
            {!categories && <option>Loading categories…</option>}
            {categories && sideCats.length === 0 && <option>No {side} categories available</option>}
            {sideCats.map((c) => (
              <option key={c.slug} value={c.slug}>{c.label}</option>
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

function PlayerModal({ player, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [photo, setPhoto] = useState(null);      // ESPN headshot lookup result
  const [photoBroken, setPhotoBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null);
    const url = `/api/player-stats?profile=1&name=${encodeURIComponent(player.name)}&team=${encodeURIComponent(player.team || '')}&side=${encodeURIComponent(player.side || 'batting')}`;
    fetch(url)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || j.error) setErr(j.error || `HTTP ${r.status}`);
        else setData(j);
      })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [player.name, player.team, player.side]);

  // ESPN headshot lookup (separate from profile fetch so it doesn't block stats).
  useEffect(() => {
    let cancelled = false;
    setPhoto(null); setPhotoBroken(false);
    if (!player.name || !player.team) return;
    const url = `/api/player-photo?name=${encodeURIComponent(player.name)}&team=${encodeURIComponent(player.team)}`;
    fetch(url)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j && !j.error) setPhoto(j); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [player.name, player.team]);

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
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-2">{player.side === 'pitching' ? 'Pitching Profile' : 'Batting Profile'}</div>
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
        </div>

        <div className="p-6 pt-0">
          {!data && !err && (
            <div className="text-center py-12 text-white/30 mono text-xs tracking-widest uppercase">Loading profile…</div>
          )}
          {err && (
            <div className="text-center py-12">
              <div className="text-white/40 text-sm mb-2">No NCAA leaderboard data for this player.</div>
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
          Aggregated from NCAA.com season leaderboards · Press Esc to close
        </div>
      </div>
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="text-center py-12 text-white/30 text-sm">{text}</div>;
}
