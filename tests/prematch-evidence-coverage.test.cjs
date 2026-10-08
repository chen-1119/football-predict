'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarizePrematchEvidence:summarize}=require('../src/services/prematchEvidenceCoverage.cjs');
const {outcomeProjection}=require('../src/services/prematchV3Assessment.cjs');
const asOf='2026-10-08T08:00:00Z',cutoff='2026-10-08T14:00:00Z';
const xi=()=>Array.from({length:11},(_,i)=>({playerId:String(i+1)}));
const evidence=()=>({source:'club-test',sourcePublishedAt:'2026-10-08T07:00:00Z',receivedAt:'2026-10-08T07:01:00Z',verified:true,home:xi(),away:xi()});
const run=signal=>summarize({signal,asOf,cutoff});
test('an injury gap stays unknown with no fabricated probability deduction',()=>{
 const r=run({});assert.equal(r.sides.home.injuryPlayers,null);assert.equal(r.degraded,true);assert.equal(r.numericProbabilityAdjustment,null);assert.equal(r.formalEligible,false);
});
test('a summary and formation do not constitute a confirmed XI',()=>{
 const r=run({confirmedLineup:{...evidence(),home:[],away:[],summary:{zh:'confirmed'},homeFormation:'4-4-2'}});
 assert.equal(r.confirmedBoth,false);
});
test('eleven duplicate players cannot constitute a confirmed XI',()=>{
 const r=run({confirmedLineup:{...evidence(),home:Array(11).fill({playerId:'1'})}});
 assert.equal(r.confirmedBoth,false);assert.equal(r.sides.away.lineupStatus,'confirmed');
});
test('probable lineups remain projected even if their publisher is verified',()=>{
 const r=run({projectedRoster:evidence()});assert.equal(r.projectedAny,true);assert.equal(r.confirmedBoth,false);
});
test('known official XI supersedes the projection per team and preserves discrepancy count',()=>{
 const projected=evidence();projected.home[0]={playerId:'12'};
 const r=run({projectedRoster:projected,confirmedLineup:evidence()});
 assert.equal(r.confirmedBoth,true);assert.equal(r.sides.home.conflicts,1);
});
test('a report published early but received after cutoff stays display only',()=>{
 const r=summarize({signal:{confirmedLineup:{...evidence(),receivedAt:'2026-10-08T14:01:00Z'}},asOf:'2026-10-08T15:00:00Z',cutoff});
 assert.equal(r.confirmedBoth,false);assert.equal(r.windows.confirmed,'display-only');
});
test('future sub-millisecond receipts and missing receive clocks are not usable',()=>{
 for(const receivedAt of ['2026-10-08T08:00:00.000000001Z',undefined])
  assert.equal(run({projectedRoster:{...evidence(),receivedAt}}).projectedAny,false);
});
test('unknown cutoff and stale observations do not authorize current evidence',()=>{
 assert.equal(summarize({signal:{projectedRoster:evidence()},asOf}).projectedAny,false);
 assert.equal(run({projectedRoster:{...evidence(),sourcePublishedAt:'2026-10-06T07:00:00Z',receivedAt:'2026-10-06T07:01:00Z'}}).projectedAny,false);
});
test('injury provider duplicates count once and an empty response never proves health',()=>{
 const e=evidence();e.home=[{player:{id:9}},{player:{id:9}}];e.away=[];
 const r=run({injuries:e});assert.equal(r.sides.home.injuryPlayers,1);assert.equal(r.sides.away.injuryPlayers,null);
});
test('all market projections derive from the same score distribution',()=>{
 for(const line of [-2,-1,0,1,2]){
  const r=outcomeProjection({home:1.7,away:.9},line);
  assert(Math.abs(Object.values(r.totalGoals).reduce((a,b)=>a+b,0)-Object.values(r.probabilities).reduce((a,b)=>a+b,0))<1e-12);
  const win=r.scoreDistribution.rows.filter(s=>s.home+line>s.away).reduce((n,s)=>n+s.probability,0);
  assert(Math.abs(win-r.hhAd.probabilities['1'])<1e-12);
 }
});

test('missing injuries use an unchanged validated baseline in research only',()=>{
 const f=require('./fixtures/prematch-v3-synthetic.cjs');
 const m=f.clone(f.match),original=JSON.stringify(f.match);
 m.externalSignals.prematchV3.teamObservations=m.externalSignals.prematchV3.teamObservations.filter(row=>row.family!=='injuries');
 const r=f.build(m);
 assert.equal(r.researchFallback.mode,'baseline-only');
 assert.deepEqual(r.researchFallback.projection,r.comparisons.baseline);
 assert.equal(r.comparisons.teamOnly,null);
 assert.equal(r.factorUse.injuries.usedInTeamEffects,false);
 assert.equal(r.factorUse.weather.reason,'not-in-feature-schema');
 assert.equal(r.factorUse.xg.usedInTeamEffects,false);
 assert(r.researchFallback.omittedFeatures.some(x=>x.includes('injuries')));
 assert.equal(r.formalEligible,false);assert.equal(r.primary,null);
 assert.equal(JSON.stringify(f.match),original);
});

test('a missing model or invalid event cannot be rescued by news or a market price',()=>{
 const f=require('./fixtures/prematch-v3-synthetic.cjs');
 for(const [m,o] of [[f.match,{asOf:f.asOf}], [{...f.match,isOnSale:false},f.options],
  [{...f.match,externalSignals:{}},f.options]]) {
  const r=f.build(m,o); assert.equal(r.researchFallback.mode,'unavailable');
  assert.equal(r.researchFallback.projection,null);
 }
});

test('quality integration requires a timed actual XI; generic verified news is still projected',()=>{
 const {buildQuality}=require('../scripts/syncPreMatchSignals.cjs');
 const match={kickoffTime:'2026-10-08T15:00:00Z',buyEndTime:cutoff};
 const quality=signal=>buildQuality({match,signal,asOf,teamHistory:{home:null,away:null}});
 assert.equal(quality({lineups:evidence()}).components.lineup.confirmed,false);
 assert.equal(quality({confirmedLineup:evidence()}).components.lineup.confirmed,true);
 assert.equal(quality({confirmedLineup:{...evidence(),receivedAt:undefined}}).components.lineup.confirmed,false);
 assert.equal(quality({injuries:{...evidence(),home:[],away:[],summary:{zh:'all fit'}}}).evidenceCoverage.sides.home.injuryStatus,'unknown');
});
