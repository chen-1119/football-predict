'use strict';
const assert=require('node:assert/strict');
const {withVerifiedInputEvidence}=require('../tests/fixtures/recommendation-input-helper.cjs');
const {makeDecision}=require('./recommendationPlatform/decision.cjs');
const {createRuntime}=require('./recommendationPlatform/runtime.cjs');
const {bindPublicReferenceDecision}=require('../src/services/publicReferenceDecision.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {LEGACY_VERSION}=require('../src/services/recommendationSelectionQuality.cjs');

const at=Date.parse('2026-09-26T09:00:00Z'),now=at+2000;
const publication={generationId:'cross-track-test',manifestHash:'a'.repeat(64),committedAt:new Date(at).toISOString()};
function match(id){
 return withVerifiedInputEvidence({id:`sporttery_${id}`,sourceMatchId:id,businessDate:'2026-09-26',
  status:'SCHEDULED',homeTeamId:`home-${id}`,awayTeamId:`away-${id}`,
  homeTeamName:`Home ${id}`,awayTeamName:`Away ${id}`,
  kickoffTime:'2026-09-26T14:00:00Z',eventVersion:'2026-09-26T14:00:00Z',
  probabilityModel:{generatedAt:new Date(at).toISOString(),oneXTwo:{final:{home:56,draw:26,away:18}}},
  odds:{odds1:2.2,oddsX:3.4,odds2:3.8},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(at).toISOString()});
}
const conflicting=match('cross'),ordinary=match('ordinary'),legacyThin=match('legacy-thin');
legacyThin.probabilityModel.oneXTwo.final={home:37.1,draw:26.2,away:36.7};
const rebuilt=require('../tests/fixtures/recommendation-input-helper.cjs').withVerifiedInputEvidence(legacyThin);
conflicting.predictions=[{marketType:'BEST',recommendationAction:'reference',oddsPoolCode:'HAD',tipCode:'2',odds:3.8}];
conflicting.predictionMeta={decisionGeneratedAt:new Date(at).toISOString(),decisionId:'reference-cross',
 modelVersion:conflicting.probabilityModel.version,policyVersion:'reference-test-v1',
 featureSnapshot:{sourceMatchId:'cross',kickoffTime:conflicting.kickoffTime,
  capturedAt:new Date(at-1000).toISOString()}};
const parent=bindPublicReferenceDecision(conflicting,null,new Date(at+1000).toISOString());
const crossDecision=makeDecision(conflicting,{now:at,publication}).decision;
const ordinaryDecision=makeDecision(ordinary,{now:at,publication}).decision;
const v2Thin=makeDecision(rebuilt,{now:at,publication}).decision;
const legacyBody={...v2Thin,selectionPolicyVersion:LEGACY_VERSION};delete legacyBody.recordHash;
legacyBody.inputHash=hash({hadInputHash:v2Thin.hadInputHash,handicapInputHash:v2Thin.handicapAnalysis?.inputHash||null,
 selectionPolicyVersion:LEGACY_VERSION,modelInputEvidenceHash:v2Thin.inputEvidence.model.inputEvidence.contentHash});
legacyBody.decisionId=`decision_${hash([legacyBody.version,legacyBody.sourceMatchId,legacyBody.eventVersion,legacyBody.market,legacyBody.inputHash])}`;
legacyBody.id=legacyBody.decisionId;
const legacyDecision={...legacyBody,recordHash:hash(legacyBody)};
assert.ok(crossDecision&&ordinaryDecision&&v2Thin);
let projected=null;
const lanes={combos:{status:'ok',previews:[]}};
const repo={
 publication:async()=>publication,currentInputs:async()=>({current:[parent,ordinary,rebuilt],receiptHashes:new Set()}),
 latest:async()=>[crossDecision,ordinaryDecision,legacyDecision],resultHeads:async()=>[],decisions:async()=>[],
 insertDecision:async d=>d,savepoint:async fn=>({value:await fn()}),issue:async()=>{},
 frozenCombos:async()=>[],dualResearchV2:async()=>[],todayTargets:async()=>[
  {dataset:'current',payload:parent},{dataset:'current',payload:ordinary},{dataset:'current',payload:rebuilt}],
 lanes:async()=>lanes,saveLane:async(lane,value)=>{lanes[lane]=value;},
 saveView:async value=>{projected=value;},
};
const ports={clock:()=>now,transaction:async(_lane,action)=>action(repo)};
(async()=>{
 const comboResult=await createRuntime(ports).combos();
 assert.equal(comboResult.ok,true);
 assert.equal(comboResult.value.previews.length,0,'a cross-track direction cannot form a new two-leg combo');
 const viewResult=await createRuntime(ports).view();
 assert.equal(viewResult.ok,true);
 assert.ok(projected);
 const cross=projected.current.find(r=>r.decision.sourceMatchId==='cross');
 const ordinaryRow=projected.current.find(r=>r.decision.sourceMatchId==='ordinary');
 const legacyRow=projected.current.find(r=>r.decision.sourceMatchId==='legacy-thin');
 assert.equal(cross.selectionQuality.status,'watch');
 assert.equal(cross.selectionQuality.crossTrack.referenceTipCode,'2');
 assert.equal(cross.selectionQuality.crossTrack.knownAtPublication,false);
 assert.equal(ordinaryRow.selectionQuality.qualified,true);
 assert.equal(legacyRow.selectionQuality.qualified,false,'old thin decisions receive current-view risk warning');
 assert.ok(legacyRow.selectionQuality.reasons.includes('model-lead-too-thin'));
 assert.equal(projected.review.singles.find(r=>r.decision.sourceMatchId==='legacy-thin').selectionQuality.qualified,true,
  'old frozen decision remains qualified under its historical v1 policy');
 assert.equal(projected.review.singles.find(r=>r.decision.sourceMatchId==='cross').selectionQuality.qualified,true,
  'historical publication quality remains as recorded, with no result-phase rewrite');
 assert.equal(projected.coverage.qualifiedCount,1);
 console.log(JSON.stringify({ok:true,checks:12,currentConflict:'watch',historicalRecord:'unchanged'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
