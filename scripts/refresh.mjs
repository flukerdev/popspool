// Pop's Pool — season refresh. Pulls live CFB data, simulates, writes public/data/standings.json
// Run: CFBD_KEY=xxx node scripts/refresh.mjs
import fs from 'fs';
import path from 'path';

const KEY = process.env.CFBD_KEY;
if (!KEY) { console.error('Missing CFBD_KEY'); process.exit(1); }

const API   = 'https://api.collegefootballdata.com';
const YEAR  = 2026;
const POOL  = ['Georgia', 'Auburn', 'Ole Miss'];
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
const teams = await cfbd('/teams/fbs', { year: YEAR });
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

// ---------------------------------------------------------------- rng
let seed = 20260911;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());

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
const S = {}; E.forEach(e => S[e.name] = { win: 0, alive: 0, winAlive: 0, rivals: 0 });
const recDist = { Georgia: {}, Auburn: {}, 'Ole Miss': {} };
const M = { a: [], o: [], i: [] };

for (let s = 0; s < SIMS; s++) {
  const rec = { Georgia: 0, Auburn: 0, 'Ole Miss': 0 }, res = {};
  for (const g of games) {
    const r = (g.completed && g.homePoints != null) ? { h: g.homePoints, a: g.awayPoints } : simGame(EX[g.id]);
    res[g.id] = r;
    for (const t of POOL) {
      if (g.homeTeam === t && r.h > r.a) rec[t]++;
      if (g.awayTeam === t && r.a > r.h) rec[t]++;
    }
  }
  for (const t of POOL) recDist[t][rec[t]] = (recDist[t][rec[t]] || 0) + 1;
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
    winPct: +(100 * a.win / SIMS).toFixed(1),
    alivePct: Math.round(100 * a.alive / SIMS),
    rivals: +(a.rivals / Math.max(1, a.alive)).toFixed(1),
    winIfAlive: +(100 * a.winAlive / Math.max(1, a.alive)).toFixed(1),
    picks: { a: e.ugaAub, o: e.ugaOle, i: e.ironBowl },
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
  teams: POOL.map(t => ({
    name: t, logo: LOGO[t], color: COLOR[t], rating: RT[t] ?? null,
    record: (() => {
      const gs = games.filter(g => (g.homeTeam === t || g.awayTeam === t) && g.completed && g.homePoints != null);
      const w = gs.filter(g => (g.homeTeam === t ? g.homePoints > g.awayPoints : g.awayPoints > g.homePoints)).length;
      return { w, l: gs.length - w };
    })(),
    dist: Object.entries(recDist[t]).map(([k, v]) => ({ wins: +k, p: +(100 * v / SIMS).toFixed(1) }))
      .sort((p, q) => p.wins - q.wins)
  })),
  pending: src.pending || [],
  entries: rows
};

fs.mkdirSync(SNAP, { recursive: true });
fs.writeFileSync(path.join(OUT, 'standings.json'), JSON.stringify(payload));

const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(SNAP, `${stamp}.json`),
  JSON.stringify({ date: stamp, entries: rows.map(r => ({ n: r.name, w: r.winPct, r: r.rank })) }));

const hp = path.join(OUT, 'history.json');
const hist = fs.existsSync(hp) ? JSON.parse(fs.readFileSync(hp, 'utf8')) : [];
const idx = hist.findIndex(h => h.date === stamp);
const entry = { date: stamp, entries: rows.map(r => ({ n: r.name, w: r.winPct, r: r.rank })) };
if (idx >= 0) hist[idx] = entry; else hist.push(entry);
fs.writeFileSync(hp, JSON.stringify(hist));

console.log(`ok — ${rows.length} entries, ${SIMS} sims, leader ${rows[0].name} ${rows[0].winPct}%`);
console.log(`total win% = ${rows.reduce((a, b) => a + b.winPct, 0).toFixed(1)} (sanity: ~100)`);
