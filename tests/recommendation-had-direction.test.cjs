'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {selectHadDirection,validHadDirectionSelection}=require('../src/services/hadDirectionSelection.cjs');
const {makeDecision,validDecision,chooseCombo}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectionFor}=require('../scripts/recommendationPlatform/comboSelections.cjs');
const {selectionQuality}=require('../src/services/recommendationSelectionQuality.cjs');
const {buildQualityReport}=require('../scripts/recommendationPlatform/qualityReport.cjs');
const {withVerifiedInputEvidence}=require('./fixtures/recommendation-input-helper.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');

function prepared(id,probabilities,odds){
  const m=match(id);
  m.odds={odds1:odds['1'],oddsX:odds.X,odds2:odds['2']};
  m.oddsUpdatedAt=new Date(NOW).toISOString();
  m.probabilityModel.oneXTwo.final={home:probabilities['1']*100,draw:probabilities.X*100,away:probabilities['2']*100};
  return withVerifiedInputEvidence(m);
}
function decisionFor(id,p,odds){
  const d=makeDecision(prepared(id,p,odds),{now:NOW,publication:publication(NOW)}).decision;
  assert.ok(d);assert.ok(validDecision(d));return d;
}

test('favorite remains selected when no draw or nonfavorite clears the value override gate',()=>{
  const s=selectHadDirection({'1':.50,X:.28,'2':.22},{'1':1.80,X:3.50,'2':4.50});
  assert.equal(s.tipCode,'1');assert.equal(s.mode,'model-leader');assert.equal(s.marketRole,'favorite');
});
test('balanced draw may override a slightly higher favorite when price edge is materially stronger',()=>{
  const p={'1':.40,X:.35,'2':.25},odds={'1':2.00,X:3.40,'2':4.00};
  const s=selectHadDirection(p,odds);
  assert.equal(s.tipCode,'X');assert.equal(s.mode,'market-edge-override');assert.equal(s.category,'balanced-draw');
  assert.equal(s.marketRole,'draw');assert.ok(s.selected.probabilityEdge>.06);assert.ok(s.selected.expectedValue>.18);
  assert.equal(validHadDirectionSelection(s,p,odds),true);
});
test('nonfavorite may override the market favorite only when probability, edge and EV all clear the guarded gate',()=>{
  const p={'1':.40,X:.25,'2':.35},odds={'1':1.90,X:3.40,'2':3.80};
  const s=selectHadDirection(p,odds);
  assert.equal(s.tipCode,'2');assert.equal(s.mode,'market-edge-override');assert.equal(s.category,'upset-signal');
  assert.equal(s.marketRole,'nonfavorite');assert.ok(s.selected.leaderDeficit<=.10);
});
test('extreme long shot is not promoted merely because its arithmetic EV is large',()=>{
  const p={'1':.40,X:.26,'2':.34},odds={'1':1.75,X:3.60,'2':5.00};
  const s=selectHadDirection(p,odds);
  assert.equal(s.tipCode,'1');assert.equal(s.mode,'model-leader');
});
test('a large probability gap cannot be overridden just to manufacture a cold pick',()=>{
  const p={'1':.58,X:.24,'2':.18},odds={'1':1.65,X:3.80,'2':5.20};
  const s=selectHadDirection(p,odds);
  assert.equal(s.tipCode,'1');assert.equal(s.overrideCandidates.length,0);
});
test('unified published decision can freeze a value draw while preserving the full probability vector',()=>{
  const d=decisionFor(21,{'1':.40,X:.35,'2':.25},{'1':2.00,X:3.40,'2':4.00});
  assert.equal(d.tipCode,'X');assert.equal(d.directionSelection.mode,'market-edge-override');
  assert.equal(d.directionSelection.modelLeaderCode,'1');assert.equal(d.modelProbability,.35);
  assert.deepEqual(d.probabilities,{'1':.4,X:.35,'2':.25});
});
test('unified published decision can freeze a nonfavorite away outcome',()=>{
  const d=decisionFor(22,{'1':.40,X:.25,'2':.35},{'1':1.90,X:3.40,'2':3.80});
  assert.equal(d.tipCode,'2');assert.equal(d.directionSelection.category,'upset-signal');
  assert.equal(d.odds,3.8);
});
test('HAD combo selection reuses the frozen single direction instead of reverting to the model argmax',()=>{
  const d=decisionFor(23,{'1':.40,X:.35,'2':.25},{'1':2.00,X:3.40,'2':4.00});
  const selection=selectionFor(d,'HAD');
  assert.equal(d.directionSelection.modelLeaderCode,'1');
  assert.equal(selection.tipCode,'X');assert.equal(selection.modelProbability,.35);assert.equal(selection.odds,3.4);
});
test('guarded value override is not rejected merely because selected probability is below the model leader',()=>{
  const d=decisionFor(24,{'1':.40,X:.35,'2':.25},{'1':2.00,X:3.40,'2':4.00});
  const selection=selectionFor(d,'HAD'),quality=selectionQuality(d,selection);
  assert.ok(quality.probabilityLead<0);
  assert.equal(quality.directionSelectionMode,'market-edge-override');
  assert.equal(quality.marketRole,'draw');
  assert.equal(quality.reasons.includes('model-lead-too-thin'),false);
  assert.equal(quality.qualified,true);
});
test('two-leg combo can contain a guarded draw without changing its direction',()=>{
  const a=decisionFor(31,{'1':.40,X:.35,'2':.25},{'1':2.00,X:3.40,'2':4.00});
  const b=decisionFor(32,{'1':.55,X:.25,'2':.20},{'1':1.80,X:3.50,'2':4.50});
  const c=chooseCombo([a,b],2,NOW,{admit:item=>selectionQuality(item.decision,item.selection).qualified});
  assert.ok(c);const index=c.legs.findIndex(d=>d.decisionId===a.decisionId);
  assert.ok(index>=0);assert.equal(c.selections[index].tipCode,'X');
});

test('frozen review separates model leaders from value overrides and favorite/draw/nonfavorite roles',()=>{
  const favorite=decisionFor(41,{'1':.55,X:.25,'2':.20},{'1':1.80,X:3.50,'2':4.50});
  const draw=decisionFor(42,{'1':.40,X:.35,'2':.25},{'1':2.00,X:3.40,'2':4.00});
  const upset=decisionFor(43,{'1':.40,X:.25,'2':.35},{'1':1.90,X:3.40,'2':3.80});
  const rows=[favorite,draw,upset].map(d=>({decision:d,settlement:{state:'WON',actual:d.tipCode,score:'1-0',resultEventId:'result-'+d.sourceMatchId}}));
  const report=buildQualityReport(rows,{asOf:Date.parse('2026-09-17T18:00:00Z')});
  assert.equal(report.byDirectionSelectionMode['model-leader'].settled,1);
  assert.equal(report.byDirectionSelectionMode['market-edge-override'].settled,2);
  assert.equal(report.byMarketRole.favorite.settled,1);
  assert.equal(report.byMarketRole.draw.settled,1);
  assert.equal(report.byMarketRole.nonfavorite.settled,1);
});

test('draw override stays off when the frozen market has a clearly dominant favorite',()=>{
  const p={'1':.40,X:.35,'2':.25},odds={'1':1.70,X:3.50,'2':4.80};
  const selection=selectHadDirection(p,odds);
  assert.equal(selection.tipCode,'1');
  assert.equal(selection.mode,'model-leader');
  assert.ok(Math.max(...Object.values(require('../src/services/hadDirectionSelection.cjs').devig(odds)))>.50);
});

test('near-tied low-confidence model remains watch-like and cannot manufacture an upset override',()=>{
  const p={'1':.371,X:.262,'2':.367},odds={'1':2.00,X:3.50,'2':3.06};
  const selected=selectHadDirection(p,odds);
  assert.equal(selected.tipCode,'1');
  assert.equal(selected.mode,'model-leader');
  assert.equal(selected.overrideCandidates.length,0);
});
