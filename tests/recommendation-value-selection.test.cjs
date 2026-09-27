'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chooseHadSelection,validHadSelection,THRESHOLDS}=require('../src/services/hadSelectionPolicy.cjs');
const {makeDecision,validDecision,chooseCombo}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectionQuality}=require('../src/services/recommendationSelectionQuality.cjs');
const {selectionFor}=require('../scripts/recommendationPlatform/comboSelections.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');

function prepared(id,probabilities,odds){
  const base=match(id,NOW,{odds:{odds1:odds['1'],oddsX:odds.X,odds2:odds['2']},oddsUpdatedAt:new Date(NOW).toISOString()});
  base.probabilityModel={...base.probabilityModel,generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:{home:probabilities['1']*100,draw:probabilities.X*100,away:probabilities['2']*100}}};
  return withVerifiedInputEvidence(base);
}
function publish(id,p,odds){return makeDecision(prepared(id,p,odds),{now:NOW,publication:publication(NOW)}).decision;}

test('normal strong favorite remains the published direction when no nonfavorite value gate passes',()=>{
  const evidence=chooseHadSelection({'1':.58,X:.25,'2':.17},{'1':1.65,X:3.8,'2':5});
  assert.equal(evidence.tipCode,'1');assert.equal(evidence.mode,'model-leader');assert.equal(evidence.selectionClass,'market-favorite');
  assert.equal(evidence.artificialDirectionQuota,false);assert.equal(validHadSelection(evidence,evidence.probabilities,evidence.quoteOdds),true);
});

test('balanced draw may replace a market favorite only with probability edge, positive EV and bounded leader gap',()=>{
  const evidence=chooseHadSelection({'1':.47,X:.35,'2':.18},{'1':1.8,X:3.8,'2':4.5});
  assert.equal(evidence.modelLeader,'1');assert.equal(evidence.marketLeader,'1');
  assert.equal(evidence.tipCode,'X');assert.equal(evidence.mode,'market-dislocation');assert.equal(evidence.selectionClass,'draw-value');
  assert(evidence.selectedMarketEdge>=THRESHOLDS.draw.minMarketEdge);
  assert(evidence.selectedExpectedValue>=THRESHOLDS.draw.minExpectedValue);
  assert(evidence.gapToModelLeader<=THRESHOLDS.draw.maxGapToModelLeader);
});

test('nonfavorite side may become formal when the same frozen model materially disagrees with the favorite price',()=>{
  const evidence=chooseHadSelection({'1':.44,X:.24,'2':.32},{'1':1.7,X:3.8,'2':5});
  assert.equal(evidence.tipCode,'2');assert.equal(evidence.selectionClass,'underdog-value');assert.equal(evidence.mode,'market-dislocation');
  assert(evidence.selectedMarketEdge>=THRESHOLDS.underdog.minMarketEdge);
});

test('positive EV alone cannot force a remote long shot when the model leader gap is too large',()=>{
  const evidence=chooseHadSelection({'1':.62,X:.22,'2':.16},{'1':1.6,X:5.2,'2':9});
  assert.equal(evidence.tipCode,'1');assert.equal(evidence.mode,'model-leader');
  assert.equal(evidence.considered.some(row=>row.code==='2'&&row.expectedValue>0&&row.qualifies===false),true);
});

test('if the model itself already leads on draw or nonfavorite, no artificial promotion path is needed',()=>{
  const draw=chooseHadSelection({'1':.30,X:.42,'2':.28},{'1':1.9,X:3.5,'2':4.2});
  assert.equal(draw.tipCode,'X');assert.equal(draw.mode,'model-leader');assert.equal(draw.selectionClass,'model-draw');
  const away=chooseHadSelection({'1':.30,X:.24,'2':.46},{'1':1.7,X:3.8,'2':5});
  assert.equal(away.tipCode,'2');assert.equal(away.mode,'model-leader');assert.equal(away.selectionClass,'model-underdog');
});

test('market ties never trigger a contrarian replacement merely to diversify the slate',()=>{
  const evidence=chooseHadSelection({'1':.45,X:.35,'2':.20},{'1':2.2,X:2.2,'2':4.4});
  assert.equal(evidence.tipCode,'1');assert.equal(evidence.mode,'model-leader');assert.equal(evidence.marketLeader,null);
});

test('published draw-value decision is immutable, valid and no longer rejected by the thin model-lead gate',()=>{
  const d=publish(101,{'1':.47,X:.35,'2':.18},{'1':1.8,X:3.8,'2':4.5});
  assert(d);assert.equal(d.tipCode,'X');assert.equal(d.hadSelection.selectionClass,'draw-value');assert.equal(validDecision(d),true);
  const quality=selectionQuality(d);
  assert.equal(quality.selectionMode,'market-dislocation');assert.equal(quality.selectionClass,'draw-value');
  assert.equal(quality.reasons.includes('model-lead-too-thin'),false);
  assert.equal(quality.qualified,true);
});

test('published underdog-value decision stays the same HAD direction in combo selection',()=>{
  const upset=publish(102,{'1':.44,X:.24,'2':.32},{'1':1.7,X:3.8,'2':5});
  const favorite=publish(103,{'1':.58,X:.25,'2':.17},{'1':1.65,X:3.8,'2':5});
  assert.equal(upset.tipCode,'2');
  const leg=selectionFor(upset,'HAD');assert(leg);assert.equal(leg.tipCode,'2');assert.equal(leg.odds,5);
  const combo=chooseCombo([upset,favorite],2,NOW);assert(combo);
  const selected=combo.selections.find(s=>s.decisionId===upset.decisionId);assert(selected);assert.equal(selected.tipCode,'2');
});

test('tampering a formal value direction or its bound price evidence invalidates the decision',()=>{
  const d=publish(104,{'1':.47,X:.35,'2':.18},{'1':1.8,X:3.8,'2':4.5});
  assert.equal(validDecision({...d,tipCode:'1'}),false);
  const changed=structuredClone(d);changed.hadSelection.selectedMarketEdge+=.01;
  const {recordHash,...body}=changed;changed.recordHash=require('../src/services/publishedForecastPolicy.cjs').hash(body);
  assert.equal(validDecision(changed),false);
});
