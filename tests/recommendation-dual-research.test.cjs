'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {match,publication,validators}=require('./recommendationFixture.cjs');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {collectResults}=require('../scripts/recommendationPlatform/results.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {createDualResearchRecord,validDualResearchRecord,settleDualResearch,summarizeDualResearch,buildDualResearchReport}=require('../scripts/recommendationPlatform/dualChoiceResearch.cjs');
const NOW=Date.parse('2026-09-17T13:00:00Z');
function frozen(line=1,id=1,patch={}){
  const m=match(id,NOW,{handicapLine:line,handicapOdds:{odds1:2.05,oddsX:3.4,odds2:2.75},
    handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString(),...patch});
  m.probabilityModel.calculationTrace={poisson:{lambdas:{home:2.2,away:.6}}};
  return makeDecision(m,{now:NOW,publication:publication(NOW)}).decision;
}
function event(decision,home,away,state='FINAL'){
  return {sourceMatchId:decision.sourceMatchId,eventVersion:decision.eventVersion,
    homeTeamId:decision.homeTeamId,awayTeamId:decision.awayTeamId,
    eventId:'result-test',revision:1,state,scoreHome:home,scoreAway:away};
}

test('prospective dual choice freezes two different markets, exact SP and coherent union probability',()=>{
  const d=frozen(-2),before=JSON.stringify(d),r=createDualResearchRecord(d,NOW);
  assert(validDecision(d));assert(r);assert(validDualResearchRecord(r,d));
  assert.deepEqual(r.selections.map(s=>s.market),['HAD','HHAD']);
  assert.equal(r.selections[0].odds,d.quoteOdds[r.selections[0].tipCode]);
  assert.equal(r.selections[1].odds,d.handicapAnalysis.marketReference.odds[r.selections[1].tipCode]);
  assert.equal(r.totalStake,2);assert.equal(r.unionProbability,1);
  assert(r.bothProbability>0);assert(r.unionProbability<r.hadProbability+r.hhadProbability);
  assert.equal(JSON.stringify(d),before);
});
test('missing or stale second quote, watch inputs and elapsed cutoff create no research selection',()=>{
  assert.equal(createDualResearchRecord(frozen(1,1,{handicapOddsUpdatedAt:new Date(NOW-16*60000).toISOString()}),NOW),null);
  assert.equal(createDualResearchRecord(frozen(1,1,{handicapOdds:null}),NOW),null);
  assert.equal(createDualResearchRecord(frozen(1),NOW+16*60000),null);
  const m=withVerifiedInputEvidence(match(2,NOW,{handicapLine:1,handicapOdds:{odds1:2.05,oddsX:3.4,odds2:2.75},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString()}),{eloHome:0,eloAway:0});
  m.probabilityModel.calculationTrace={poisson:{lambdas:{home:2.2,away:.6}}};
  const watch=makeDecision(m,{now:NOW,publication:publication(NOW)}).decision;
  assert(watch);assert.equal(createDualResearchRecord(watch,NOW),null);
});
test('tampering with one SP, stake or union probability fails even after rehashing the outer record',()=>{
  const d=frozen(),r=createDualResearchRecord(d,NOW);
  for(const mutate of [v=>v.selections[1].odds=7,v=>v.totalStake=1,v=>v.unionProbability=.99]){
    const copy=structuredClone(r);mutate(copy);
    const {recordHash,...body}=copy;copy.recordHash=hash(body);
    assert.equal(validDualResearchRecord(copy,d),false);
    assert.throws(()=>settleDualResearch(copy,d,event(d,1,0)),/Invalid dual-choice/);
  }
});
test('same-match stake accounting pays each independent SP and never multiplies the two',()=>{
  const d=frozen(1),r=createDualResearchRecord(d,NOW);
  const both=settleDualResearch(r,d,event(d,2,0));
  assert.equal(both.state,'WON');assert.deepEqual(both.selections.map(s=>s.state),['WON','WON']);
  assert.equal(both.grossReturn,3.85);assert.equal(both.netProfit,1.85);
  const one=settleDualResearch(r,d,event(d,0,0));
  assert.equal(one.state,'WON');assert.deepEqual(one.selections.map(s=>s.state),['LOST','WON']);
  assert.equal(one.grossReturn,2.05);assert.equal(one.netProfit,.05);
  const none=settleDualResearch(r,d,event(d,0,3));
  assert.equal(none.state,'LOST');assert.equal(none.grossReturn,0);assert.equal(none.netProfit,-2);
  const voided=settleDualResearch(r,d,event(d,null,null,'VOID'));
  assert.equal(voided.state,'VOID');assert.equal(voided.grossReturn,2);assert.equal(voided.netProfit,0);
  assert.equal(settleDualResearch(r,d,undefined).state,'PENDING');
  assert.equal(settleDualResearch(r,d,{...event(d,2,0),homeTeamId:'wrong'}).state,'DISPUTED');
});
test('summary excludes pending, void and disputed from return and hit-rate denominators',()=>{
  const d=frozen(),r=createDualResearchRecord(d,NOW);
  const rows=[event(d,2,0),event(d,0,3),undefined,event(d,null,null,'VOID'),{...event(d,2,0),homeTeamId:'wrong'}]
    .map(e=>({record:r,settlement:settleDualResearch(r,d,e)}));
  const s=summarizeDualResearch(rows);
  assert.equal(s.observed,5);assert.equal(s.settled,2);assert.equal(s.won,1);assert.equal(s.lost,1);
  assert.equal(s.pending,1);assert.equal(s.void,1);assert.equal(s.disputed,1);assert.equal(s.hitRate,.5);
  assert.equal(s.totalStakeCommitted,10);assert.equal(s.settledStake,4);assert.equal(s.grossReturn,3.85);
  assert.equal(s.netProfit,-.15);assert.equal(s.roi,-.15/4);assert.equal(s.voidRefund,2);assert.equal(s.pendingExposure,2);
  assert.equal(s.selectionHitRate,.5);
});
test('report uses verified result heads and never marks research as formally promoted',()=>{
  const d=frozen(),r=createDualResearchRecord(d,NOW);
  const final={...match(1,NOW),status:'FINISHED',testOfficial:true,scoreHome:2,scoreAway:0,resultRevision:1};
  const {updates}=collectResults([final],new Map(),validators,NOW+9*3600000);
  const report=buildDualResearchReport([r],[d],updates,NOW+9*3600000);
  assert.equal(report.all.won,1);assert.equal(report.last7.won,1);assert.equal(report.invalidRecords,0);
  assert.equal(report.validation.formalPromotion,false);assert.equal(report.validation.readyForIndependentReview,false);
  assert.equal(buildDualResearchReport([r],[d],[{...updates[0],stateHash:'tampered'}],NOW+9*3600000).all.pending,1);
});
test('runtime research transaction is independent and idempotent by exact event',async()=>{
  const d=frozen(),stored=[];
  const ports={clock:()=>NOW,async transaction(lane,action){
    assert.equal(lane,'dual-research');
    return action({async decisions(){return [d];},async insertDualResearch(r){
      if(stored.some(x=>x.sourceMatchId===r.sourceMatchId&&x.eventVersion===r.eventVersion))return false;
      stored.push(r);return true;},async savepoint(action){return {value:await action()};},async issue(){throw new Error('No issue expected');}});
  }};
  const disabled=createRuntime({clock:()=>NOW,async transaction(){throw new Error('Disabled research must not read or write PostgreSQL');}},
    {dualResearchEnabled:false});
  assert.deepEqual(await disabled.research([d.decisionId]),{ok:true,enabled:false,created:0,eligible:0,issues:0});
  const prior=process.env.ENABLE_DUAL_RESEARCH;
  try{
    delete process.env.ENABLE_DUAL_RESEARCH;
    const defaultDisabled=createRuntime({clock:()=>NOW,async transaction(){throw new Error('Default-off research must not use PostgreSQL');}});
    assert.equal((await defaultDisabled.research([d.decisionId])).enabled,false);
    process.env.ENABLE_DUAL_RESEARCH='true';
    assert.equal((await createRuntime({clock:()=>NOW,async transaction(){throw new Error('Only 1 enables research');}}).research([d.decisionId])).enabled,false);
  }finally{
    if(prior===undefined)delete process.env.ENABLE_DUAL_RESEARCH;
    else process.env.ENABLE_DUAL_RESEARCH=prior;
  }
  const runtime=createRuntime(ports,{dualResearchEnabled:true}),first=await runtime.research([d.decisionId]),second=await runtime.research([d.decisionId]);
  assert.equal(first.ok,true);assert.equal(first.created,1);assert.equal(second.created,0);assert.equal(stored.length,1);
  assert.equal(first.enabled,true);
  assert(validDualResearchRecord(stored[0],d));
  const failed=createRuntime({clock:()=>NOW,transaction:async()=>{throw Object.assign(new Error('research only'),{code:'42P01'});}},{dualResearchEnabled:true});
  assert.deepEqual(await failed.research([d.decisionId]),{ok:false,enabled:true,errorCode:'42P01'});
  const missingTable=createRuntime({clock:()=>NOW,transaction:async(_lane,action)=>action({
    async decisions(){return [d];},async insertDualResearch(){throw Object.assign(new Error('missing migration'),{code:'42P01'});},
    async savepoint(action){try{return {value:await action()};}catch(error){return {error};}},async issue(){throw new Error('Schema errors must be visible');},
  })},{dualResearchEnabled:true});
  assert.deepEqual(await missingTable.research([d.decisionId]),{ok:false,enabled:true,errorCode:'42P01'});
});
