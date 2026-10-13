'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectionQuality,publishedSelectionQuality}=require('../src/services/recommendationSelectionQuality.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {buildDataCoverage}=require('../scripts/dataCoverage.cjs');
const {bindPublicReferenceDecision}=require('../src/services/publicReferenceDecision.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');

// Synthetic frozen arithmetic; these are never source or live-match evidence.
const at=Date.parse('2026-10-05T10:00:00Z');
const publication={generationId:'coherent-quality-test',manifestHash:'a'.repeat(64),committedAt:new Date(at).toISOString()};
function match(id,{handicap=true}={}){
 const value={id:`sporttery_${id}`,sourceMatchId:id,businessDate:'2026-10-05',status:'SCHEDULED',
  homeTeamId:`home-${id}`,awayTeamId:`away-${id}`,homeTeamName:`Home ${id}`,awayTeamName:`Away ${id}`,
  kickoffTime:'2026-10-05T16:00:00Z',eventVersion:'2026-10-05T16:00:00Z',
  probabilityModel:{generatedAt:new Date(at).toISOString(),oneXTwo:{final:{home:45.6,draw:26.4,away:28}},
   calculationTrace:{poisson:{lambdas:{home:1.7175,away:1.3237}}}},
  odds:{odds1:1.32,oddsX:4.7,odds2:6.3},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(at).toISOString(),
  ...(handicap?{handicapLine:-1,handicapOdds:{odds1:2.09,oddsX:3.5,odds2:2.74},
   handicapOddsSource:'sporttery:HHAD',handicapOddsPoolCode:'HHAD',handicapOddsObservedAt:new Date(at).toISOString()}:{}),
 };
 return withVerifiedInputEvidence(value);
}
function decision(id,options={}){
 const result=makeDecision(match(id,options),{now:at,publication,...(options.primaryPolicy?{primaryPolicy:options.primaryPolicy}:{})});
 assert.equal(result.reason,null);assert.ok(validDecision(result.decision));return result.decision;
}
test('HHAD primary is assessed independently from its lower-probability HAD companion',()=>{
 const d=decision('hhad');
 assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.tipCode,'2');
 const had=selectionQuality(d),primary=publishedSelectionQuality(d,{now:at});
 assert.equal(had.qualified,false);assert.ok(had.reasons.includes('model-lead-too-thin'));
 assert.equal(primary.assessmentBasis,'coherent-primary-anchor-v1');assert.equal(primary.qualified,true);
 assert.ok(Math.abs(primary.expectedValue-(.544*2.74-1))<1e-9);
 assert.ok(Math.abs(primary.probabilityLead-(.544-Math.max(d.handicapAnalysis.overallProbabilities['1'],d.handicapAnalysis.overallProbabilities.X)))<1e-9);
 assert.notEqual(primary.marketProbability,had.marketProbability);assert.equal(primary.marketRole,null);
});
test('HAD-only coherent primary retains the original market arithmetic',()=>{
 const d=decision('had',{handicap:false});
 assert.equal(d.coherentPrimary.anchorMarket,'HAD');
 const {assessmentBasis,...primary}=publishedSelectionQuality(d,{now:at});
 assert.equal(assessmentBasis,'coherent-primary-anchor-v1');assert.deepEqual(primary,selectionQuality(d));
});
test('the 15-minute quote boundary remains exact and future clocks fail closed',()=>{
 const d=decision('clocks');
 assert.equal(publishedSelectionQuality(d,{now:at+15*60000}).qualified,true);
 for(const now of [at+15*60000+1,at-1,NaN]){
  const q=publishedSelectionQuality(d,{now});assert.equal(q.qualified,false);assert.ok(q.reasons.includes('quote-stale'));
  assert.ok(Math.abs(q.expectedValue-(.544*2.74-1))<1e-9);
 }
});
test('missing or tampered HHAD evidence never falls back to the HAD companion',()=>{
 const d=decision('missing');
 for(const mutate of [x=>{x.handicapAnalysis.marketReference=null;},x=>{x.handicapAnalysis.marketReference.source='unverified';},x=>{x.coherentPrimary.anchorCode='X';}]){
  const bad=structuredClone(d);mutate(bad);
  assert.equal(validDecision(bad),false);
  const q=publishedSelectionQuality(bad,{now:at});
  assert.equal(q.qualified,false);assert.equal(q.expectedValue,null);assert.equal(q.marketProbability,null);
  assert.ok(q.reasons.includes('anchor-market-unavailable'));assert.ok(!q.reasons.includes('model-lead-too-thin'));
 }
});
test('a well-priced primary still requires the unchanged real-input sample gate',()=>{
 const input=withVerifiedInputEvidence(match('samples'),{eloHome:1,eloAway:1,formHome:1,formAway:1});
 const d=makeDecision(input,{now:at,publication}).decision;
 assert.ok(validDecision(d));const q=publishedSelectionQuality(d,{now:at});
 assert.equal(q.qualified,false);assert.ok(q.reasons.includes('team-samples-insufficient'));
});
test('independent archived policy and frozen bytes are unchanged',()=>{
 const d=decision('legacy',{primaryPolicy:'independent-market-primary-v1'}),before=hash(d);
 assert.deepEqual(publishedSelectionQuality(d,{now:at+86400000}),selectionQuality(d));
 assert.equal(hash(d),before);assert.equal(Object.hasOwn(publishedSelectionQuality(d),'assessmentBasis'),false);
 const coherent=decision('immutable'),original=hash(coherent);publishedSelectionQuality(coherent,{now:at});
 assert.equal(hash(coherent),original);
});
test('current view and day coverage use primary quality while historical HAD cohorts remain unchanged',async()=>{
 const input=match('runtime'),d=makeDecision(input,{now:at,publication}).decision;
 let center;const lanes={combos:{status:'ok',previews:[]}};
 const repo={latest:async()=>[d],resultHeads:async()=>[],frozenCombos:async()=>[],decisions:async()=>[],
  dualResearchV2:async()=>[],todayTargets:async()=>[{dataset:'current',payload:input}],lanes:async()=>lanes,
  issue:async()=>{},saveView:async value=>{center=value;},saveLane:async(lane,value)=>{lanes[lane]=value;}};
 const runtime=createRuntime({clock:()=>at+1000,transaction:async(_lane,action)=>action(repo)});
 const result=await runtime.view();assert.equal(result.ok,true);
 assert.equal(center.current[0].selectionQuality.qualified,true);
 assert.equal(center.current[0].selectionQuality.assessmentBasis,'coherent-primary-anchor-v1');
 assert.equal(center.coverage.qualifiedCount,1);
 assert.deepEqual(center.review.singles[0].selectionQuality,selectionQuality(d));
 assert.equal(center.review.singles[0].selectionQuality.qualified,false);
 assert.equal(center.review.statistics.qualifiedSingle.pending,0);
 assert.equal(center.review.statistics.single.pending,1);
 assert.equal(hash(center.current[0].decision),hash(d));
});
test('coverage preserves an explicit primary-quote failure rather than claiming missing model evidence',()=>{
 const input=match('coverage'),d=makeDecision(input,{now:at,publication}).decision;
 const quality=publishedSelectionQuality(d,{now:at+15*60000+1});
 const coverage=buildDataCoverage({targetRows:[input],singles:[{decision:d,selectionQuality:quality}],now:at+15*60000+1});
 assert.equal(coverage.qualifiedCount,0);assert.equal(coverage.missing[0].reasonCode,'quote-stale');
});
test('an HHAD primary keeps the existing HAD cross-track gate as a separate reason',async()=>{
 const input=match('cross-primary'),d=makeDecision(input,{now:at,publication}).decision;
 input.predictions=[{marketType:'BEST',recommendationAction:'reference',oddsPoolCode:'HAD',tipCode:'1',odds:1.32}];
 input.predictionMeta={decisionGeneratedAt:new Date(at).toISOString(),decisionId:'cross-reference',
  modelVersion:input.probabilityModel.version,policyVersion:'synthetic-cross-test-v1',
  featureSnapshot:{sourceMatchId:input.sourceMatchId,kickoffTime:input.kickoffTime,capturedAt:new Date(at-1000).toISOString()}};
 const target=bindPublicReferenceDecision(input,null,new Date(at+500).toISOString());
 assert.ok(target.predictionMeta.publicReferenceDecision?.evidenceBinding);
 let center;const lanes={combos:{status:'ok',previews:[]}};
 const repo={latest:async()=>[d],resultHeads:async()=>[],frozenCombos:async()=>[],decisions:async()=>[],
  dualResearchV2:async()=>[],todayTargets:async()=>[{dataset:'current',payload:target}],lanes:async()=>lanes,
  issue:async()=>{},saveView:async value=>{center=value;},saveLane:async(lane,value)=>{lanes[lane]=value;}};
 const result=await createRuntime({clock:()=>at+1000,transaction:async(_lane,action)=>action(repo)}).view();
 assert.equal(result.ok,true);const quality=center.current[0].selectionQuality;
 assert.equal(quality.qualified,false);assert.deepEqual(quality.reasons,['cross-track-direction-conflict']);
 assert.equal(quality.crossTrack.market,'HAD');assert.equal(quality.crossTrack.referenceTipCode,'1');
 assert.ok(Math.abs(quality.expectedValue-(.544*2.74-1))<1e-9);
 assert.equal(center.coverage.qualifiedCount,0);
});
