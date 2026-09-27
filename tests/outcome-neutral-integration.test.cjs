'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeDecision,validDecision,chooseCombo}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectionQuality,prospectiveRiskReasons,isQualifiedSelection}=require('../src/services/recommendationSelectionQuality.cjs');
const {classifyOutcomeResearch}=require('../src/services/outcomeCategoryResearch.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {NOW,match,publication,memoryPorts}=require('./recommendationFixture.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {VERSION}=require('../src/services/primaryDirectionAdmission.cjs');
const inputs=(id,p,odds={odds1:1.7,oddsX:3.9,odds2:5.0})=>withVerifiedInputEvidence(match(id,NOW,{odds,
 probabilityModel:{generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:p}}}));
const make=m=>makeDecision(m,{now:NOW,publication:publication(NOW)}).decision;
function asLegacy(d){
 const r=structuredClone(d);delete r.primaryAdmissionVersion;
 r.inputHash=hash({hadInputHash:r.hadInputHash,handicapInputHash:r.handicapAnalysis?.inputHash||null,
  selectionPolicyVersion:r.selectionPolicyVersion,modelInputEvidenceHash:r.inputEvidence?.model?.inputEvidence?.contentHash||null,
  supplementaryPolicyVersion:r.supplementaryPolicyVersion,supplementaryResearchHash:r.supplementaryResearch?.contentHash||null});
 r.id=r.decisionId='decision_'+hash([r.version,r.sourceMatchId,r.eventVersion,r.market,r.inputHash]);
 delete r.recordHash;r.recordHash=hash(r);return r;
}
test('verified 37pct draw with three-point lead is admitted without changing its vector',()=>{
 const d=make(inputs(1,{home:34,draw:37,away:29}));assert(validDecision(d));assert.equal(d.tipCode,'X');
 const q=selectionQuality(d);assert(q.qualified);assert.equal(q.primaryAdmissionVersion,VERSION);assert(q.warnings.includes('close-model-lead'));
 assert.deepEqual(prospectiveRiskReasons(q),[]);assert.deepEqual(d.probabilities,{'1':.34,X:.37,'2':.29});
});
test('verified close nonfavorite leader follows the same path as a favorite or draw',()=>{
 const d=make(inputs(2,{home:35,draw:27,away:38}));assert(validDecision(d));assert.equal(d.tipCode,'2');
 const q=selectionQuality(d);assert(q.qualified);assert.equal(q.marketFavorite,false);assert(d.odds>2.60);
 const r=classifyOutcomeResearch({decision:d,selectionQuality:q});assert.equal(r.category,'upset-signal');assert.equal(r.candidateCode,d.tipCode);
 assert.equal(r.researchOnly,true);assert.equal(r.formalPromotionEligible,false);
});
test('a near-draw runner-up must not replace an already-published nonfavorite category',()=>{
 const d=make(inputs(2,{home:28,draw:35,away:37}));const r=classifyOutcomeResearch(d);
 assert.equal(d.tipCode,'2');assert.equal(r.candidateCode,'2');assert.equal(r.category,'upset-signal');
});
test('the runtime does not reapply the legacy six-point gate after new admission',async()=>{
 const ports=memoryPorts();ports.current=[inputs(1,{home:34,draw:37,away:29}),inputs(2,{home:35,draw:27,away:38}),inputs(3,{home:62,draw:21,away:17})];
 const cycle=await createRuntime(ports).publishingCycle();
 assert(cycle.publication.ok&&cycle.combinations.ok&&cycle.projection.ok);
 const rows=ports.state.view.current;assert.equal(rows.length,3);assert(rows.every(r=>r.selectionQuality.qualified));
 assert.equal(ports.state.view.previews.length,2);
 const three=ports.state.view.previews.find(c=>c.size===3);assert(three.rawTotalOdds>=5);
 assert(three.selections.some(s=>s.market==='HAD'&&s.tipCode==='X'));assert(three.selections.some(s=>s.market==='HAD'&&s.tipCode==='2'));
});
test('legacy immutable records retain original rejection rules and are not silently upgraded',()=>{
 const d=make(inputs(1,{home:34,draw:37,away:29})),old=asLegacy(d),before=JSON.stringify(old);
 assert(validDecision(old));assert(!selectionQuality(old).qualified);assert(selectionQuality(old).reasons.includes('model-lead-too-thin'));
 assert.equal(JSON.stringify(old),before);assert.notEqual(old.decisionId,d.decisionId);
});
test('the new admission policy cannot be added to a frozen record without invalidating its binding',()=>{
 const old=asLegacy(make(inputs(1,{home:34,draw:37,away:29})));
 const tampered={...old,primaryAdmissionVersion:VERSION};delete tampered.recordHash;tampered.recordHash=hash(tampered);
 assert.equal(validDecision(tampered),false);
});
test('incomplete independent history remains watch even with a unique cold or draw primary',()=>{
 for(const p of [{home:34,draw:37,away:29},{home:35,draw:27,away:38}]){
  const d=make(withVerifiedInputEvidence(match(1,NOW,{probabilityModel:{generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:p}}}),{eloHome:0,eloAway:0}));
  assert(validDecision(d));assert.equal(selectionQuality(d).qualified,false);
 }
});
test('strong favorites stay selected; no draw or upset quota can replace them',()=>{
 const ds=[1,2,3].map(id=>make(inputs(id,{home:62,draw:21,away:17})));
 const c=chooseCombo(ds,3,NOW,{admit:isQualifiedSelection});
 assert.equal(c,null);assert(ds.every(d=>d.tipCode==='1'));
});
