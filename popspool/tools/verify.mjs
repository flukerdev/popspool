import fs from 'fs';
const KEY=process.env.CFBD_KEY, API='https://api.collegefootballdata.com', YEAR=2026;
const POOL=['Georgia','Auburn','Ole Miss']; const N=+(process.env.NS||60000);
const HFA=2.4,MSD=16.0,TSD=9.5,DT=51;
async function cfbd(p,q){const u=new URL(API+p);Object.entries(q||{}).forEach(([k,v])=>u.searchParams.set(k,v));
 const r=await fetch(u,{headers:{Authorization:`Bearer ${KEY}`}});return r.json();}
const sp=await cfbd('/ratings/sp',{year:YEAR});const RT={};for(const t of sp)if(t.rating!=null)RT[t.team]=t.rating;
const gmm={},lnn={};
for(const t of POOL){for(const g of await cfbd('/games',{year:YEAR,team:t,seasonType:'regular'}))gmm[g.id]=g;
 for(const l of await cfbd('/lines',{year:YEAR,team:t,seasonType:'regular'}))lnn[l.id]=l;}
const games=Object.values(gmm);
let seed=+(process.env.SEED||777);
function rand(){seed|=0;seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}
function gauss(){const u=Math.max(rand(),1e-12),v=rand();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
function ex(g){const r=lnn[g.id];let em=null,et=DT;
 if(r&&r.lines&&r.lines.length){const s=r.lines.map(l=>l.spread).filter(v=>v!=null),o=r.lines.map(l=>l.overUnder).filter(v=>v!=null);
  if(s.length)em=-(s.reduce((a,b)=>a+b,0)/s.length); if(o.length)et=o.reduce((a,b)=>a+b,0)/o.length;}
 if(em==null){const rh=RT[g.homeTeam]??-12,ra=RT[g.awayTeam]??-12;em=(rh-ra)+(g.neutralSite?0:HFA);}
 return{em,et};}
const EX={};for(const g of games)EX[g.id]=ex(g);
function sg(e){const m=e.em+gauss()*MSD,t=Math.max(20,e.et+gauss()*TSD);
 let h=Math.max(0,Math.round((t+m)/2)),a=Math.max(0,Math.round((t-m)/2));
 if(h===a){if(rand()<0.5)h+=3;else a+=3;}return{h,a};}
const fd=(x,y)=>games.find(g=>(g.homeTeam===x&&g.awayTeam===y)||(g.homeTeam===y&&g.awayTeam===x));
const gA=fd('Georgia','Auburn'),gO=fd('Georgia','Ole Miss'),gI=fd('Alabama','Auburn');
const mf=(r,g,ref)=>g.homeTeam===ref?r.h-r.a:r.a-r.h;
const E=JSON.parse(fs.readFileSync('./data/entries.json','utf8')).entries;
const SEC=new Set(['Georgia','Alabama','Texas','Texas A&M','LSU','Ole Miss','Tennessee','Oklahoma','Florida','South Carolina','Missouri','Auburn','Vanderbilt','Arkansas','Kentucky','Mississippi State']);
const st=Object.keys(RT).filter(t=>SEC.has(t)),wt=st.map(t=>Math.exp(RT[t]/6)),ws=wt.reduce((a,b)=>a+b,0);
const S={};E.forEach(e=>S[e.name]={win:0,qual:0,winQ:0,winNQ:0,nq:0,comp:0});
for(let s=0;s<N;s++){
 const rec={Georgia:0,Auburn:0,'Ole Miss':0},res={};
 for(const g of games){const r=(g.completed&&g.homePoints!=null)?{h:g.homePoints,a:g.awayPoints}:sg(EX[g.id]);res[g.id]=r;
  for(const t of POOL){if(g.homeTeam===t&&r.h>r.a)rec[t]++;if(g.awayTeam===t&&r.a>r.h)rec[t]++;}}
 const mA=mf(res[gA.id],gA,'Georgia'),mO=mf(res[gO.id],gO,'Georgia'),mI=mf(res[gI.id],gI,'Alabama');
 let x=rand()*ws,ch=st[0];for(let i=0;i<st.length;i++){x-=wt[i];if(x<=0){ch=st[i];break;}}
 const sc=E.map(e=>({n:e.n||e.name,d1:Math.abs(e.wins-rec[e.team]),
  d2:Math.abs(e.ugaAub-mA)+Math.abs(e.ugaOle-mO)+Math.abs(e.ironBowl-mI),d3:e.sec===ch?0:1}));
 const m1=Math.min(...sc.map(z=>z.d1));
 const qual=sc.filter(z=>z.d1===m1);
 sc.sort((a,b)=>a.d1-b.d1||a.d2-b.d2||a.d3-b.d3);
 const t0=sc[0],tie=sc.filter(z=>z.d1===t0.d1&&z.d2===t0.d2&&z.d3===t0.d3);
 const qn=new Set(qual.map(z=>z.n));
 E.forEach(e=>{const nm=e.name; if(qn.has(nm)){S[nm].qual++;S[nm].comp+=qual.length-1;} else S[nm].nq++;});
 tie.forEach(z=>{const v=1/tie.length;S[z.n].win+=v; if(qn.has(z.n))S[z.n].winQ+=v; else S[z.n].winNQ+=v;});
}
console.log('seed',process.env.SEED||777,'sims',N,'\n');
console.log('ENTRY             WIN%  |  QUAL%  P(win|qual)  avgRivals |  P(win|notqual)  |  CHECK');
let tot=0;
E.map(e=>e.name).forEach(n=>{
 const q=S[n].qual/N, pwq=S[n].qual?S[n].winQ/S[n].qual:0, pwn=S[n].nq?S[n].winNQ/S[n].nq:0;
 const chk=100*(q*pwq+(1-q)*pwn), act=100*S[n].win/N; tot+=act;
 console.log(n.padEnd(17)+act.toFixed(1).padStart(5)+'  |'+(100*q).toFixed(0).padStart(6)+'%'+
  (100*pwq).toFixed(1).padStart(12)+'%'+(S[n].comp/S[n].qual).toFixed(1).padStart(10)+' |'+
  (100*pwn).toFixed(2).padStart(15)+'%  |'+chk.toFixed(1).padStart(7));});
console.log('\nTOTAL WIN% =',tot.toFixed(2),'(must be 100.00)');
