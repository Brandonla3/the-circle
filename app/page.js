'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Trophy, TrendingUp, X, ChevronLeft, ChevronRight, Zap } from 'lucide-react';

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
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const fetchScores = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const r = await fetch(proxy(`${ESPN_SITE}/scoreboard?dates=${fmtDate(date)}&groups=100&limit=200`));
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
          <nav className="flex gap-1 mt-10 border-b border-white/5 -mb-px">
            {[{id:'scores',label:'Scoreboard',icon:Zap},{id:'rankings',label:'Rankings',icon:Trophy},{id:'stats',label:'Teams',icon:TrendingUp}].map((t) => {
              const Icon = t.icon; const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} className={`relative px-5 py-3 flex items-center gap-2 text-sm transition-colors ${active ? 'text-white' : 'text-white/40 hover:text-white/70'}`}>
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

        {tab === 'rankings' && <RankingsView rankings={rankings} />}
        {tab === 'stats' && <StatsView />}
      </main>

      {selectedGame && <GameModal game={selectedGame} detail={gameDetail} onClose={() => { setSelectedGame(null); setGameDetail(null); }} />}

      <footer className="border-t border-white/5 mt-16 py-6 px-6 text-center text-[10px] mono tracking-widest uppercase text-white/20">
        Data via ESPN · Built for Daladier
      </footer>
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

  return (
    <div onClick={onClick} className="card-enter group relative rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.03] to-transparent p-5 cursor-pointer hover:border-white/30 hover:from-white/[0.06] transition-all" style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isLive && <span className="live-dot h-1.5 w-1.5 rounded-full bg-red-500"></span>}
          <span className={`text-[10px] mono uppercase tracking-widest ${isLive ? 'text-red-400' : isFinal ? 'text-white/50' : 'text-white/30'}`}>{detail}</span>
        </div>
        {comp.broadcasts?.[0]?.names?.[0] && <span className="text-[9px] mono uppercase text-white/30">{comp.broadcasts[0].names[0]}</span>}
      </div>
      <div className="space-y-1">
        <TeamRow team={away} side="away" />
        <div className="h-px bg-white/5"></div>
        <TeamRow team={home} side="home" />
      </div>
      {comp.venue?.fullName && (
        <div className="mt-3 pt-3 border-t border-white/5 text-[10px] text-white/30 mono uppercase tracking-wide truncate">
          {comp.venue.fullName}{comp.venue.address?.city ? ` · ${comp.venue.address.city}` : ''}
        </div>
      )}
    </div>
  );
}

function RankingsView({ rankings }) {
  if (!rankings) return <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading rankings…</div>;
  const polls = rankings.rankings || [];
  if (polls.length === 0) return <div className="text-center py-20 text-white/30">No rankings available (off-season).</div>;
  return (
    <div className="space-y-12">
      {polls.map((poll) => (
        <div key={poll.id || poll.name}>
          <div className="mb-6 flex items-end justify-between border-b border-white/10 pb-3">
            <div>
              <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40">Poll</div>
              <h2 className="display text-white text-3xl font-bold">{poll.name}</h2>
            </div>
            {poll.shortName && <div className="text-white/30 text-xs mono">{poll.shortName}</div>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(poll.ranks || []).slice(0, 25).map((r, i) => (
              <div key={r.team?.id || i} className="card-enter flex items-center gap-4 py-3 px-4 rounded-lg border border-white/5 hover:border-white/20 hover:bg-white/[0.03] transition" style={{ animationDelay: `${i * 20}ms` }}>
                <div className={`display text-3xl font-black w-10 ${r.current <= 5 ? '' : 'text-white/40'}`} style={r.current <= 5 ? { color: '#ff6b1a' } : {}}>{r.current}</div>
                {r.team?.logos?.[0]?.href && <img src={r.team.logos[0].href} alt="" className="h-8 w-8 object-contain" />}
                <div className="flex-1 min-w-0">
                  <div className="text-white font-semibold text-sm truncate">{r.team?.name || r.team?.displayName}</div>
                  <div className="text-[10px] mono text-white/40 uppercase">{r.recordSummary || ''}</div>
                </div>
                <div className="text-right">
                  <div className="mono text-white/80 text-sm">{r.points?.toFixed?.(0) || r.points || ''}</div>
                  {typeof r.previous === 'number' && r.previous !== r.current && (
                    <div className={`text-[10px] mono ${r.previous > r.current ? 'text-emerald-400' : 'text-red-400'}`}>
                      {r.previous > r.current ? '▲' : '▼'}{Math.abs(r.previous - r.current)}
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

function StatsView() {
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
        <p className="text-white/40 text-xs mt-1">Click any team to view their ESPN profile with full stats, schedule & roster.</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {teams.map((t, i) => (
          <a key={t.id} href={t.links?.find((l) => l.rel?.includes('clubhouse'))?.href || `https://www.espn.com/college-sports/softball/team/_/id/${t.id}`} target="_blank" rel="noreferrer" className="card-enter flex items-center gap-3 p-3 rounded-lg border border-white/5 hover:border-white/30 hover:bg-white/[0.03] transition" style={{ animationDelay: `${Math.min(i * 8, 600)}ms`, borderLeft: `3px solid ${t.color ? '#' + t.color : '#ff6b1a'}` }}>
            {t.logos?.[0]?.href && <img src={t.logos[0].href} alt="" className="h-8 w-8 object-contain flex-shrink-0" />}
            <div className="min-w-0">
              <div className="text-white text-xs font-semibold truncate">{t.shortDisplayName || t.displayName}</div>
              <div className="text-[9px] mono text-white/30 uppercase truncate">{t.abbreviation}</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function GameModal({ game, detail, onClose }) {
  const comp = game.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === 'home');
  const away = comp?.competitors?.find((c) => c.homeAway === 'away');
  const maxInnings = Math.max(home?.linescores?.length || 0, away?.linescores?.length || 0, 7);
  const innings = Array.from({ length: maxInnings }, (_, i) => i + 1);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 p-6" style={{ background: '#141210' }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-full hover:bg-white/10 text-white/60 hover:text-white"><X className="h-4 w-4" /></button>
        <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40 mb-1">{game.status?.type?.shortDetail}</div>
        <div className="display text-white text-2xl font-bold mb-5">
          {away?.team?.displayName} <span className="text-white/30">@</span> {home?.team?.displayName}
        </div>
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {detail.leaders.slice(0, 2).map((teamLeaders, idx) => (
                <div key={idx} className="space-y-2">
                  <div className="text-white/70 text-xs font-semibold">{teamLeaders.team?.displayName}</div>
                  {(teamLeaders.leaders || []).slice(0, 3).map((cat, j) => {
                    const l = cat.leaders?.[0]; if (!l) return null;
                    return (
                      <div key={j} className="flex items-center justify-between text-xs py-1 border-b border-white/5">
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
        {comp?.venue?.fullName && (
          <div className="mt-5 pt-4 border-t border-white/5 text-[10px] mono uppercase tracking-widest text-white/30">
            {comp.venue.fullName}{comp.venue.address?.city ? ` · ${comp.venue.address.city}, ${comp.venue.address.state || ''}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
