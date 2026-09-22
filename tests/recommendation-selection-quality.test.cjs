'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {makeDecision,validDecision,chooseCombo}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectionQuality,isQualifiedSelection}=require('../src/services/recommendationSelectionQuality.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {NOW,match,publication,memoryPorts}=require('./recommendationFixture.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const make=m=>makeDecision(m,{now:NOW,publication:publication(NOW)}).decision;
const verified=(id,options={},patch={})=>withVerifiedInputEvidence(match(id,NOW,patch),options);

test('missing, insufficient and unused team samples remain watch without changing the direction',()=>{
 for(const options of [{eloHome:0,eloAway:0},{eloHome:12,eloAway:0},{weights:{market:.1,teamStrength:.45,elo:0,poisson:.45},eloHome:50,eloAway:50}]){
  const d=make(verified(1,options));assert(validDecision(d));
  assert.equal(d.tipCode,'1');assert.equal(selectionQuality(d).qualified,false);
 }
 const m=match(1);delete m.probabilityModel.inputEvidence;delete m.probabilityModel.inputUsage;
 const d=make(m);assert(validDecision(d));assert.equal(selectionQuality(d).qualified,false);
});
test('both Elo or both actually weighted form samples satisfy the existing model readiness boundaries',()=>{
 assert(selectionQuality(make(verified(1,{eloHome:6,eloAway:6}))).qualified);
 assert(!selectionQuality(make(verified(1,{eloHome:6,eloAway:5}))).qualified);
 assert(selectionQuality(make(verified(1,{eloHome:0,eloAway:0,formHome:8,formAway:8,formWeight:.1}))).qualified);
 assert(!selectionQuality(make(verified(1,{eloHome:0,eloAway:0,formHome:8,formAway:8,formWeight:0}))).qualified);
 assert(!selectionQuality(make(verified(1,{eloHome:0,eloAway:0,formHome:8,formAway:8,formWeight:.1,weights:{market:.5,teamStrength:.5,elo:0,poisson:0}}))).qualified);
});
test('admission is outcome-neutral: draw below 50%, favorites and higher-SP directions are allowed',()=>{
 for(const [p,tip,odds] of [[{home:35,draw:40,away:25},'X',{odds1:2.1,oddsX:3.1,odds2:3.8}],[{home:70,draw:18,away:12},'1',{odds1:1.2,oddsX:5,odds2:8}],[{home:25,draw:30,away:45},'2',{odds1:1.6,oddsX:4,odds2:5}]]){
  const d=make(verified(1,{}, {probabilityModel:{generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:p}},odds}));
  assert(validDecision(d));assert.equal(d.tipCode,tip);const q=selectionQuality(d);assert(q.qualified);assert.equal(q.priceFilterApplied,false);
  assert(Math.abs(q.expectedValue-d.modelProbability*d.odds+1)<1e-12);
 }
});
test('input evidence and policy are identity-bound; PostgreSQL JSON key order preserves them',()=>{
 const a=make(verified(1)),b=make(verified(1,{eloHome:0,eloAway:0}));
 assert.notEqual(a.decisionId,b.decisionId);assert(validDecision(a));
 const reorder=x=>Array.isArray(x)?x.map(reorder):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().reverse().map(k=>[k,reorder(x[k])])):x;
 assert(validDecision(reorder(a)));assert(selectionQuality(reorder(a)).qualified);
 const corrupt=structuredClone(a);corrupt.inputEvidence.model.inputEvidence.samples.elo.home=900;assert(!validDecision(corrupt));
});
test('the production runtime withholds new combos for watch inputs while retaining reference publications',async()=>{
 const ports=memoryPorts();ports.current=[1,2,3].map(id=>verified(id,{eloHome:0,eloAway:0}));
 const rt=createRuntime(ports);const cycle=await rt.publishingCycle();
 assert(cycle.publication.ok&&cycle.combinations.ok&&cycle.projection.ok);
 assert.equal(ports.state.view.current.length,3);assert.equal(ports.state.view.previews.length,0);
 assert(ports.state.view.current.every(r=>r.selectionQuality.status==='watch'));
 assert.equal(ports.state.view.lanes.combos.watchCount,3);
 ports.current=[1,2,3].map(id=>verified(id));await rt.publishingCycle();
 assert.equal(ports.state.view.previews.length,2);assert.equal(ports.state.view.current.length,3);
 assert.equal(ports.state.view.review.statistics.single.published,3);
 assert.equal(ports.state.view.review.statistics.qualifiedSingle.published,3);
});
test('quality admission filters market legs without changing unconditional probabilities or frozen legacy records',()=>{
 const rows=[1,2,3].map(id=>make(verified(id)));
 const combo=chooseCombo(rows,3,NOW,{admit:isQualifiedSelection});assert(combo);
 assert(combo.selections.every(s=>s.probabilityBasis==='unconditional'));
 const old=require('./fixtures/recommendation-quality-legacy.json');
 const before=JSON.stringify(old);assert(validDecision(old));assert(!selectionQuality(old).qualified);
 assert.equal(JSON.stringify(old),before);
});
