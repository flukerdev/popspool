// Pop's Pool — season refresh. Pulls live CFB data, simulates, writes public/data/standings.json
// Run: CFBD_KEY=xxx node scripts/refresh.mjs
import fs from 'fs';
import path from 'path';

const KEY = process.env.CFBD_KEY;
if (!KEY) { console.error('Missing CFBD_KEY'); process.exit(1); }

const API   = 'https://api.collegefootballdata.com';
const YEAR  = 2026;
const POOL  = ['Georgia', 'Auburn', 'Ole Miss'];
// Teams with no SP+ rating and no betting lines (D3). Remaining games use a fixed
// per-game win probability drawn from Beta(a,b); played games count as actual results.
const OFFGRID = { 'Huntingdon': { a: 5, b: 3, games: 10 } };
const ALLTEAMS = [...POOL, ...Object.keys(OFFGRID)];
const SIMS  = 60000;

// model constants
const HFA = 2.4;    // home field advantage, points
const MSD = 16.0;   // sd of a game's margin around expectation
const TSD = 9.5;    // sd of a game's total
const DT  = 51;     // default total when no over/under posted

const OUT  = path.join(process.cwd(), 'public', 'data');
const SNAP = path.join(OUT, 'snapshots');

async function cfbd(p, q) {
  const u = new URL(API + p);
  Object.entries(q || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- load
const teams = await cfbd('/teams', { year: YEAR });   // all divisions — D3 included
const LOGO = {}, COLOR = {};
for (const t of teams) {
  LOGO[t.school] = (t.logos || [])[0] || null;
  COLOR[t.school] = t.color || '#555';
}
const spRaw = await cfbd('/ratings/sp', { year: YEAR });
const RT = {}; for (const t of spRaw) if (t.rating != null) RT[t.team] = t.rating;

const gmap = {}, lmap = {};
for (const t of POOL) {
  for (const g of await cfbd('/games', { year: YEAR, team: t, seasonType: 'regular' })) gmap[g.id] = g;
  for (const l of await cfbd('/lines', { year: YEAR, team: t, seasonType: 'regular' })) lmap[l.id] = l;
}
const games = Object.values(gmap);

// off-grid teams: banked record + count of remaining games
const OFF = {};
for (const [team, cfg] of Object.entries(OFFGRID)) {
  const gs = await cfbd('/games', { year: YEAR, team, seasonType: 'regular' });
  let w = 0, l = 0;
  for (const g of gs) {
    if (!g.completed || g.homePoints == null) continue;
    const home = g.homeTeam === team;
    const me = home ? g.homePoints : g.awayPoints;
    const them = home ? g.awayPoints : g.homePoints;
    if (me > them) w++; else l++;
  }
  OFF[team] = { ...cfg, w, l, remaining: gs.length - w - l, scheduled: gs.length };
  console.log(`${team}: ${w}-${l}, ${OFF[team].remaining} remaining of ${gs.length}`);
}

// ---------------------------------------------------------------- rng
let seed = 20260911;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
// Gamma with integer shape = sum of exponentials; Beta from two Gammas.
const gammaInt = k => { let s = 0; for (let i = 0; i < k; i++) s -= Math.log(Math.max(rand(), 1e-12)); return s; };
const beta = (a, b) => { const x = gammaInt(a); return x / (x + gammaInt(b)); };
const binom = (n, p) => { let c = 0; for (let i = 0; i < n; i++) if (rand() < p) c++; return c; };

function expect(g) {
  const rec = lmap[g.id];
  let em = null, et = DT;
  if (rec && rec.lines && rec.lines.length) {
    const s = rec.lines.map(l => l.spread).filter(v => v != null);
    const o = rec.lines.map(l => l.overUnder).filter(v => v != null);
    if (s.length) em = -(s.reduce((a, b) => a + b, 0) / s.length);  // CFBD spread is home-perspective
    if (o.length) et = o.reduce((a, b) => a + b, 0) / o.length;
  }
  if (em == null) {
    const rh = RT[g.homeTeam] ?? -12, ra = RT[g.awayTeam] ?? -12;
    em = (rh - ra) + (g.neutralSite ? 0 : HFA);
  }
  return { em, et };
}
const EX = {}; for (const g of games) EX[g.id] = expect(g);

function simGame(e) {
  const m = e.em + gauss() * MSD;
  const t = Math.max(20, e.et + gauss() * TSD);
  let h = Math.max(0, Math.round((t + m) / 2)), a = Math.max(0, Math.round((t - m) / 2));
  if (h === a) { if (rand() < 0.5) h += 3; else a += 3; }
  return { h, a };
}

const find = (x, y) => games.find(g =>
  (g.homeTeam === x && g.awayTeam === y) || (g.homeTeam === y && g.awayTeam === x));
const gA = find('Georgia', 'Auburn'), gO = find('Georgia', 'Ole Miss'), gI = find('Alabama', 'Auburn');
const marginOf = (r, g, ref) => g.homeTeam === ref ? r.h - r.a : r.a - r.h;

const src = JSON.parse(fs.readFileSync('data/entries.json', 'utf8'));
const E = src.entries;

const SECSET = new Set(['Georgia','Alabama','Texas','Texas A&M','LSU','Ole Miss','Tennessee','Oklahoma',
  'Florida','South Carolina','Missouri','Auburn','Vanderbilt','Arkansas','Kentucky','Mississippi State']);
const secT = Object.keys(RT).filter(t => SECSET.has(t));
const secW = secT.map(t => Math.exp(RT[t] / 6));
const secS = secW.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- simulate
const S = {}; E.forEach(e => S[e.name] = { win: 0, alive: 0, winAlive: 0, rivals: 0, exact: 0 });
const recDist = {}; ALLTEAMS.forEach(t => recDist[t] = {});
const M = { a: [], o: [], i: [] };

for (let s = 0; s < SIMS; s++) {
  const rec = {}; ALLTEAMS.forEach(t => rec[t] = 0);
  const res = {};
  for (const [t, o] of Object.entries(OFF)) rec[t] = o.w + binom(o.remaining, beta(o.a, o.b));
  for (const g of games) {
    const r = (g.completed && g.homePoints != null) ? { h: g.homePoints, a: g.awayPoints } : simGame(EX[g.id]);
    res[g.id] = r;
    for (const t of POOL) {
      if (g.homeTeam === t && r.h > r.a) rec[t]++;
      if (g.awayTeam === t && r.a > r.h) rec[t]++;
    }
  }
  for (const t of ALLTEAMS) recDist[t][rec[t]] = (recDist[t][rec[t]] || 0) + 1;
  E.forEach(e => { if (rec[e.team] === e.wins) S[e.name].exact++; });
  const mA = marginOf(res[gA.id], gA, 'Georgia');
  const mO = marginOf(res[gO.id], gO, 'Georgia');
  const mI = marginOf(res[gI.id], gI, 'Alabama');
  M.a.push(mA); M.o.push(mO); M.i.push(mI);

  let x = rand() * secS, champ = secT[0];
  for (let i = 0; i < secT.length; i++) { x -= secW[i]; if (x <= 0) { champ = secT[i]; break; } }

  const sc = E.map(e => ({ n: e.name,
    d1: Math.abs(e.wins - rec[e.team]),
    d2: Math.abs(e.ugaAub - mA) + Math.abs(e.ugaOle - mO) + Math.abs(e.ironBowl - mI),
    d3: e.sec === champ ? 0 : 1 }));
  const m1 = Math.min(...sc.map(z => z.d1));
  const alive = sc.filter(z => z.d1 === m1);
  const aliveN = new Set(alive.map(z => z.n));
  alive.forEach(z => { S[z.n].alive++; S[z.n].rivals += alive.length - 1; });

  sc.sort((a, b) => a.d1 - b.d1 || a.d2 - b.d2 || a.d3 - b.d3);
  const top = sc[0];
  const tied = sc.filter(z => z.d1 === top.d1 && z.d2 === top.d2 && z.d3 === top.d3);
  tied.forEach(z => { S[z.n].win += 1 / tied.length; if (aliveN.has(z.n)) S[z.n].winAlive += 1 / tied.length; });
}

// ---------------------------------------------------------------- ownership windows
function windows(arr, field) {
  const vals = [...new Set(E.map(e => e[field]))].sort((a, b) => a - b);
  const o = {};
  for (const e of E) {
    const i = vals.indexOf(e[field]);
    const lo = i === 0 ? null : (vals[i - 1] + e[field]) / 2;
    const hi = i === vals.length - 1 ? null : (vals[i + 1] + e[field]) / 2;
    const share = E.filter(z => z[field] === e[field]).length;
    const p = arr.filter(m => (lo === null || m > lo) && (hi === null || m < hi)).length / arr.length / share;
    o[e.name] = { lo, hi, p: +(100 * p).toFixed(1) };
  }
  return o;
}
const W = { a: windows(M.a, 'ugaAub'), o: windows(M.o, 'ugaOle'), i: windows(M.i, 'ironBowl') };

const gameMeta = (g, ref, opp, label) => ({
  label, ref, opp, refLogo: LOGO[ref] || null, oppLogo: LOGO[opp] || null,
  played: !!(g.completed && g.homePoints != null),
  actual: (g.completed && g.homePoints != null) ? marginOf({ h: g.homePoints, a: g.awayPoints }, g, ref) : null,
  score: (g.completed && g.homePoints != null) ? `${g.homeTeam} ${g.homePoints}, ${g.awayTeam} ${g.awayPoints}` : null,
  date: (g.startDate || '').slice(0, 10),
  proj: +(M.a === null ? 0 : 0)
});

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

const rows = E.map(e => {
  const a = S[e.name];
  return {
    name: e.name, team: e.team, teamLogo: LOGO[e.team] || null, teamColor: COLOR[e.team] || '#555',
    pick: e.wins, sec: e.sec, secLogo: LOGO[e.sec] || null,
    games: OFFGRID[e.team] ? OFFGRID[e.team].games : 12,
    winPct: +(100 * a.win / SIMS).toFixed(1),
    alivePct: Math.round(100 * a.alive / SIMS),
    rivals: +(a.rivals / Math.max(1, a.alive)).toFixed(1),
    winIfAlive: +(100 * a.winAlive / Math.max(1, a.alive)).toFixed(1),
    picks: { a: e.ugaAub, o: e.ugaOle, i: e.ironBowl },
    scores: { a: e.sAub, o: e.sOle, i: e.sIron },
    recordProb: Math.round(100 * a.exact / SIMS),
    sameTeam: E.filter(z => z.team === e.team).length,
    sameRecord: E.filter(z => z.team === e.team && z.wins === e.wins).length,
    win_a: W.a[e.name], win_o: W.o[e.name], win_i: W.i[e.name]
  };
}).sort((x, y) => y.winPct - x.winPct);

// dense rank with ties
let rank = 0, prev = null;
rows.forEach((r, i) => { if (r.winPct !== prev) { rank = i + 1; prev = r.winPct; } r.rank = rank; });

const payload = {
  generated: new Date().toISOString(),
  season: YEAR,
  sims: SIMS,
  games: {
    a: { ...gameMeta(gA, 'Georgia', 'Auburn', 'Georgia vs Auburn'), proj: +mean(M.a).toFixed(1) },
    o: { ...gameMeta(gO, 'Georgia', 'Ole Miss', 'Georgia at Ole Miss'), proj: +mean(M.o).toFixed(1) },
    i: { ...gameMeta(gI, 'Alabama', 'Auburn', 'Iron Bowl'), proj: +mean(M.i).toFixed(1) }
  },
  teams: ALLTEAMS.map(t => ({
    name: t, logo: LOGO[t], color: COLOR[t], rating: RT[t] ?? null,
    games: OFFGRID[t] ? OFFGRID[t].games : 12,
    offGrid: !!OFFGRID[t],
    record: OFF[t] ? { w: OFF[t].w, l: OFF[t].l } : (() => {
      const gs = games.filter(g => (g.homeTeam === t || g.awayTeam === t) && g.completed && g.homePoints != null);
      const w = gs.filter(g => (g.homeTeam === t ? g.homePoints > g.awayPoints : g.awayPoints > g.homePoints)).length;
      return { w, l: gs.length - w };
    })(),
    dist: Object.entries(recDist[t]).map(([k, v]) => ({ wins: +k, p: +(100 * v / SIMS).toFixed(1) }))
      .sort((p, q) => p.wins - q.wins)
  })),
  pending: src.pending || [],
  entryCount: E.length + (src.pending || []).length,
  entries: rows
};

fs.mkdirSync(SNAP, { recursive: true });
fs.writeFileSync(path.join(OUT, 'standings.json'), JSON.stringify(payload));

const stamp = new Date().toISOString().slice(0, 10);
const SEASON_START = new Date('2026-08-24T00:00:00Z');   // Monday of week 1
const weekNo = Math.max(1, Math.floor((Date.now() - SEASON_START) / 6048e5) + 1);
fs.writeFileSync(path.join(SNAP, `${stamp}.json`),
  JSON.stringify({ date: stamp, week: weekNo, entries: rows.map(r => ({ n: r.name, w: r.winPct, r: r.rank })) }));

const hp = path.join(OUT, 'history.json');
const hist = fs.existsSync(hp) ? JSON.parse(fs.readFileSync(hp, 'utf8')) : [];
const idx = hist.findIndex(h => h.week === weekNo);
const entry = { date: stamp, week: weekNo, entries: rows.map(r => ({ n: r.name, w: r.winPct, r: r.rank })) };
if (idx >= 0) hist[idx] = entry; else hist.push(entry);
fs.writeFileSync(hp, JSON.stringify(hist));

console.log(`ok — ${rows.length} entries, ${SIMS} sims, leader ${rows[0].name} ${rows[0].winPct}%`);
console.log(`total win% = ${rows.reduce((a, b) => a + b.winPct, 0).toFixed(1)} (sanity: ~100)`);
