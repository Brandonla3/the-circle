'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Trophy, TrendingUp, X, ChevronLeft, ChevronRight, Zap, BarChart3, Activity } from 'lucide-react';

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
              {id:'rankings',label:'ESPN Rankings',icon:Trophy},
              {id:'ncaa',label:'NCAA RPI',icon:BarChart3, suffix:'*Weekly'},
              {id:'standings',label:'Standings',icon:Activity},
              {id:'stats',label:'Teams',icon:TrendingUp},
            ].map((t) => {
              const Icon = t.icon; const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} className={`relative px-5 py-3 flex items-center gap-2 text-sm transition-colors whitespace-nowrap ${active ? 'text-white' : 'text-white/40 hover:text-white/70'}`}>
                  <Icon className="h-3.5 w-3.5" />
                  <span className="tracking-wide uppercase text-xs font-semibold">{t.label}</span>
                  {t.suffix && <span className="text-[9px] mono text-white/30 normal-case tracking-normal">{t.suffix}</span>}
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
        {tab === 'nolan' && <RpiView source="nolan" />}
        {tab === 'ncaa' && <RpiView source="ncaa" />}
        {tab === 'standings' && <StandingsView />}
        {tab === 'stats' && <StatsView />}
      </main>

      {selectedGame && <GameModal game={selectedGame} detail={gameDetail} onRefresh={() => fetchGameDetail(selectedGame.id)} onClose={() => { setSelectedGame(null); setGameDetail(null); }} />}

      <footer className="border-t border-white/5 mt-16 py-6 px-6 text-center text-[10px] mono tracking-widest uppercase text-white/20">
        Data via ESPN, NCAA.com & WarrenNolan.com · Built for Daladier
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
      ))}
    </div>
  );
}

function RpiView({ source }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null); setData(null);
    fetch(`/api/rpi?source=${source}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { if (d.error) setErr(d.error); else setData(d); } })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source]);

  if (loading) return <div className="text-center py-20 text-white/30 mono text-xs tracking-widest uppercase">Loading {source === 'ncaa' ? 'NCAA' : 'Nolan'} RPI…</div>;
  if (err) return (
    <div className="max-w-xl mx-auto text-center py-16">
      <div className="display text-white/30 text-3xl mb-3">RPI unavailable</div>
      <div className="text-white/50 text-sm mb-2">{err}</div>
      {source === 'nolan' && (
        <div className="text-white/40 text-xs mt-4">
          Warren Nolan has noted he may not cover softball every season.<br />
          Check <a href="https://www.warrennolan.com/softball/2026/index" target="_blank" rel="noreferrer" className="underline" style={{ color: '#ff6b1a' }}>warrennolan.com</a> directly.
        </div>
      )}
    </div>
  );
  if (!data || !data.rows || data.rows.length === 0) {
    return (
      <div className="max-w-xl mx-auto text-center py-16">
        <div className="display text-white/30 text-3xl mb-3">No RPI data yet</div>
        <div className="text-white/50 text-sm">The source returned no rows. Likely off-season or coverage paused for this year.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-end justify-between border-b border-white/10 pb-3 flex-wrap gap-3">
        <div>
          <div className="text-[10px] mono tracking-[0.3em] uppercase text-white/40">{data.cadence || ''}</div>
          <h2 className="display text-white text-3xl font-bold">{data.title}</h2>
          <div className="text-white/40 text-xs mono mt-1">{data.source}{data.updated ? ` · Updated ${data.updated}` : ''}</div>
        </div>
        <div className="text-[10px] mono uppercase text-white/30">{data.rows.length} teams</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {data.rows.slice(0, 100).map((row, i) => {
          const isTop5 = Number(row.rank) <= 5;
          return (
            <div
              key={`${row.rank}-${row.team}-${i}`}
              className="card-enter flex items-center gap-4 py-3 px-4 rounded-lg border border-white/5 hover:border-white/20 hover:bg-white/[0.03] transition"
              style={{ animationDelay: `${Math.min(i * 15, 600)}ms` }}
            >
              <div className={`display text-3xl font-black w-12 ${isTop5 ? '' : 'text-white/40'}`} style={isTop5 ? { color: '#ff6b1a' } : {}}>
                {row.rank}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-semibold text-sm truncate">{row.team}</div>
                <div className="text-[10px] mono text-white/40 uppercase truncate">
                  {row.conference && <span>{row.conference}</span>}
                  {row.conference && row.record && <span className="mx-1">·</span>}
                  {row.record && <span>{row.record}</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="mono text-white text-sm font-bold tabular-nums">{row.rpi}</div>
                {row.previous && row.previous !== row.rank && (
                  <div className={`text-[10px] mono ${Number(row.previous) > Number(row.rank) ? 'text-emerald-400' : 'text-red-400'}`}>
                    {Number(row.previous) > Number(row.rank) ? '▲' : '▼'}{Math.abs(Number(row.previous) - Number(row.rank))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
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

function GameModal({ game, detail, onRefresh, onClose }) {
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
  const hasCompare = (detail?.boxscore?.teams || []).some((t) => (t.statistics || []).length);
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
    ...(!loaded || hasCompare ? [{ id: 'compare', label: 'Team Compare' }] : []),
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
              {modalTab === 'compare' && <TeamCompareTab detail={detail} />}
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

function TeamCompareTab({ detail }) {
  const teams = detail?.boxscore?.teams || [];
  if (teams.length < 2) return <EmptyState text="Team comparison data not available." />;
  const statKeys = new Set();
  teams.forEach((t) => (t.statistics || []).forEach((s) => statKeys.add(s.label || s.name)));
  const rows = Array.from(statKeys);
  const get = (team, key) => {
    const s = (team.statistics || []).find((x) => (x.label || x.name) === key);
    return s?.displayValue ?? s?.value ?? '—';
  };
  const away = teams.find((t) => t.homeAway === 'away') || teams[0];
  const home = teams.find((t) => t.homeAway === 'home') || teams[1];
  return (
    <div>
      <div className="grid grid-cols-3 gap-4 items-center mb-4 pb-3 border-b border-white/10">
        <div className="text-right">
          <div className="text-white font-semibold text-sm">{away.team?.abbreviation}</div>
          <div className="text-[10px] text-white/40 mono uppercase">Away</div>
        </div>
        <div className="text-center text-[10px] mono tracking-[0.3em] uppercase text-white/40">vs</div>
        <div>
          <div className="text-white font-semibold text-sm">{home.team?.abbreviation}</div>
          <div className="text-[10px] text-white/40 mono uppercase">Home</div>
        </div>
      </div>
      <div className="space-y-1">
        {rows.map((key) => (
          <div key={key} className="grid grid-cols-3 gap-4 items-center py-2 border-b border-white/5 text-sm">
            <div className="text-right mono text-white tabular-nums">{get(away, key)}</div>
            <div className="text-center text-[10px] mono uppercase tracking-wider text-white/40">{key}</div>
            <div className="mono text-white tabular-nums">{get(home, key)}</div>
          </div>
        ))}
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

function EmptyState({ text }) {
  return <div className="text-center py-12 text-white/30 text-sm">{text}</div>;
}
