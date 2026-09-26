'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {buildPublishedScoreDistribution}=require('../src/services/publishedScoreDistribution.cjs');
const {collectResults,settleSupplementaryResearch,supplementarySummary,key}=require('../scripts/recommendationPlatform/results.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {NOW,match,publication,validators,memoryPorts}=require('./recommendationFixture.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
function source(){return match(1,NOW,{handicapLine:-1,handicapOdds:{odds1:2,oddsX:3,odds2:3},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString(),
  probabilityModel:{version:'test',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}},calculationTrace:{poisson:{lambdas:{home:2.8,away:1.8}}}}});}
const decision=()=>makeDecision(source(),{now:NOW,publication:publication(NOW)}).decision;
function event(d,home,away,revision=0,previous=new Map(),patch={}){
  const now=Date.parse(d.kickoffTime)+3*3600000;
  return collectResults([{...d,status:'FINISHED',testOfficial:true,scoreHome:home,scoreAway:away,resultRevision:revision,...patch}],previous,validators,now).updates[0];
}
function legacy(d){
  const row=structuredClone(d);delete row.supplementaryPolicyVersion;delete row.supplementaryResearch;
  row.inputHash=hash({hadInputHash:row.hadInputHash,handicapInputHash:row.handicapAnalysis?.inputHash||null,selectionPolicyVersion:row.selectionPolicyVersion,modelInputEvidenceHash:row.inputEvidence.model.inputEvidence?.contentHash||null});
  row.decisionId=row.id=`decision_${hash([row.version,row.sourceMatchId,row.eventVersion,row.market,row.inputHash])}`;
  const {recordHash,...body}=row;row.recordHash=hash(body);return row;
}
test('freeze the displayed aligned score and full-matrix TTG mode with unpriced research evidence',()=>{
  const d=decision(),r=d.supplementaryResearch,p=buildPublishedScoreDistribution(d);
  assert(validDecision(d));assert(Object.isFrozen(r));assert(Object.isFrozen(r.totalGoals.distribution));
  assert.equal(r.exactScore.label,p.alignedScores[0].label);assert.equal(r.exactScore.probability,p.alignedScores[0].probability);
  assert.equal(r.totalGoals.label,[...p.totalGoals].sort((a,b)=>b.probability-a.probability)[0].label);
  assert.deepEqual(r.totalGoals.distribution,p.totalGoals);assert.equal(r.odds,null);assert.equal(r.formalPromotionEligible,false);
  assert.equal(makeDecision(source(),{now:NOW+1000,publication:publication(NOW)}).decision.decisionId,d.decisionId);
});
test('old decisions remain valid, but are excluded from prospective score and TTG statistics',()=>{
  const d=decision(),old=legacy(d);assert(validDecision(old));assert.notEqual(old.decisionId,d.decisionId);
  assert.equal(buildPublishedScoreDistribution(old).status,'available');assert.equal(settleSupplementaryResearch(old,event(old,1,0)),null);
  const s=supplementarySummary([{decision:d,supplementarySettlement:settleSupplementaryResearch(d,null)},{decision:old}]);
  assert.equal(s.exactScore.published,1);assert.equal(s.exactScore.pending,1);assert.equal(s.totalGoals.hitRate,null);
  assert.equal(s.excludedWithoutFrozenPicks,1);assert.equal(s.roi,null);
});
test('rehashed tampered picks, probabilities, policies and promotion flags are rejected',()=>{
  for(const edit of [r=>r.exactScore.label='9-9',r=>r.totalGoals.label='7+',r=>r.exactScore.probability=.99,
    r=>r.odds=5,r=>r.formalPromotionEligible=true,r=>r.totalGoals.distribution[0].probability=.8]){
    const bad=structuredClone(decision());edit(bad.supplementaryResearch);
    const {contentHash,...research}=bad.supplementaryResearch;bad.supplementaryResearch.contentHash=hash(research);
    const {recordHash,...body}=bad;bad.recordHash=hash(body);assert.equal(validDecision(bad),false);
  }
});
test('official revisions settle exact scores and 7+ totals without modifying frozen selections',()=>{
  const d=decision(),original=JSON.stringify(d),r=d.supplementaryResearch;
  const first=event(d,r.exactScore.home,r.exactScore.away),a=settleSupplementaryResearch(d,first);
  assert.equal(a.exactScore.state,'WON');
  const correction=event(d,5,3,1,new Map([[key(d),first]])),b=settleSupplementaryResearch(d,correction);
  assert.equal(b.totalGoals.actual,'7+');assert.equal(b.totalGoals.state,r.totalGoals.label==='7+'?'WON':'LOST');
  assert.equal(b.exactScore.revision,1);assert.equal(JSON.stringify(d),original);
});
test('pending, void, disputed and wrong-identity results never become losses',()=>{
  const d=decision();
  assert.equal(settleSupplementaryResearch(d,null).totalGoals.state,'PENDING');
  const voided=event(d,0,0,0,new Map(),{resultDisposition:'VOID'});
  assert.equal(settleSupplementaryResearch(d,voided).exactScore.state,'VOID');
  const wrong=event(d,1,0,0,new Map(),{homeTeamId:'wrong'});
  assert.equal(settleSupplementaryResearch(d,wrong).exactScore.state,'DISPUTED');
  const invalid={...event(d,1,0),scoreHome:NaN};
  assert.equal(settleSupplementaryResearch(d,invalid).totalGoals.state,'DISPUTED');
  const rows=[null,voided,wrong].map(e=>({decision:d,supplementarySettlement:settleSupplementaryResearch(d,e)}));
  const s=supplementarySummary(rows);assert.equal(s.exactScore.settled,0);assert.equal(s.exactScore.hitRate,null);
});
test('runtime publishes and settles the new research cohort using only final official results',async()=>{
  const p=memoryPorts();p.current=[source()];const runtime=createRuntime(p,{validators});
  await runtime.publishingCycle();const d=p.state.decisions[0],r=d.supplementaryResearch;
  assert(r);assert.equal(p.state.view.review.statistics.supplementary.exactScore.pending,1);
  p.now=Date.parse(d.kickoffTime)+3*3600000;
  p.history=[{...source(),testOfficial:true,status:'FINISHED',scoreHome:r.exactScore.home,scoreAway:r.exactScore.away}];
  await runtime.settlementCycle();
  assert.equal(p.state.view.review.statistics.supplementary.exactScore.won,1);
  assert.equal(p.state.view.review.singles[0].supplementarySettlement.exactScore.state,'WON');
});
test('frontend preserves frozen research and rejects changed picks, promotion flags or settlements',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../src/services/recommendationCenterView.ts'),'utf8'),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Date});
  const {parseRecommendationCenter,parseRecommendationSingleRow}=module.exports;
  const p=memoryPorts();p.current=[source()];const runtime=createRuntime(p,{validators});await runtime.publishingCycle();
  const payload={recommendationCenter:p.state.view};
  const parsed=parseRecommendationCenter(payload);assert.equal(parsed.current[0].decision.supplementaryResearch.version,'supplementary-research-v1');
  assert.equal(parsed.review.statistics.supplementary.exactScore.pending,1);
  for(const edit of [row=>row.decision.supplementaryResearch.formalPromotionEligible=true,
    row=>row.decision.supplementaryResearch.odds=2.5,row=>row.decision.supplementaryResearch.exactScore.label='9-9',
    row=>row.supplementarySettlement.exactScore.state='WON']){
    const bad=structuredClone(payload);edit(bad.recommendationCenter.current[0]);assert.throws(()=>parseRecommendationCenter(bad));
  }
  const d=p.state.decisions[0],r=d.supplementaryResearch;p.now=Date.parse(d.kickoffTime)+3*3600000;
  p.history=[{...source(),testOfficial:true,status:'FINISHED',scoreHome:r.exactScore.home,scoreAway:r.exactScore.away}];
  await runtime.settlementCycle();assert.equal(parseRecommendationCenter({recommendationCenter:p.state.view}).review.singles[0].supplementarySettlement.exactScore.state,'WON');
  const {buildRecommendationReviewPage,parseReviewQuery}=require('../server/recommendationReviewPage.cjs');
  const page=buildRecommendationReviewPage({decisions:p.state.decisions,combos:[],resultEvents:p.state.results},parseReviewQuery(new URL('https://example.test/review')),p.now);
  assert.equal(parseRecommendationSingleRow(page.rows[0]).supplementarySettlement.exactScore.state,'WON');
  const bad=structuredClone(page.rows[0]);bad.supplementarySettlement.totalGoals.actual='99';assert.throws(()=>parseRecommendationSingleRow(bad));
});
