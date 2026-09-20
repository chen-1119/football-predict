'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {marginDistribution,buildHandicapMarginDecision,validHandicapMarginDecision}=require('../src/services/handicapMarginDecision.cjs');
const {buildHandicapCalibration,calibrateHandicapProbabilities,lineGroup}=require('../src/services/handicapCalibration.cjs');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {settleHandicapDecision,handicapSummary}=require('../scripts/recommendationPlatform/results.cjs');

const NOW=Date.parse('2026-09-20T02:00:00Z');
const PUB={generationId:'g',manifestHash:'a'.repeat(64),sourceCycleId:'cycle'};
function model(home,away){
  return {version:'test-model',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:{home:.62,draw:.23,away:.15}},
    calculationTrace:{poisson:{lambdas:{home,away}},expectedGoals:{values:{finalHome:home,finalAway:away}}}};
}
function match(home=2.2,away=.6,line=-1){
  return {id:'sporttery_1',sourceMatchId:'1',businessDate:'2026-09-20',status:'SCHEDULED',
    homeTeamId:'h1',awayTeamId:'a1',homeTeamName:'Home',awayTeamName:'Away',
    kickoffTime:'2026-09-20T10:00:00Z',eventVersion:'2026-09-20T10:00:00Z',buyEndTime:'2026-09-20T09:30:00Z',
    odds:{odds1:1.7,oddsX:3.5,odds2:4.8},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(NOW).toISOString(),
    handicapLine:line,handicapOdds:{odds1:2.05,oddsX:3.4,odds2:2.75},handicapOddsSource:'sporttery:HHAD',
    handicapOddsUpdatedAt:new Date(NOW).toISOString(),probabilityModel:model(home,away),predictions:[]};
}
test('home -1 can resolve to handicap draw when exactly one-goal margin is most likely',()=>{
  const h=buildHandicapMarginDecision(match(1.2,.1,-1),{now:NOW,cutoffTime:'2026-09-20T09:30:00Z',straightTipCode:'1'});
  assert.equal(h.tipCode,'X'); assert.equal(h.relation,'home-land-on-line'); assert.ok(h.exactMarginProbability>.34);
});
test('strong home -1 resolves to handicap win when cover probability leads',()=>{
  const h=buildHandicapMarginDecision(match(2.2,.6,-1),{now:NOW,cutoffTime:'2026-09-20T09:30:00Z',straightTipCode:'1'});
  assert.equal(h.tipCode,'1'); assert.equal(h.relation,'home-cover'); assert.ok(h.coverProbability>h.landOnLineProbability);
});
test('strong away against +1 resolves to handicap away when two-goal cover leads',()=>{
  const h=buildHandicapMarginDecision(match(.7,1.8,1),{now:NOW,cutoffTime:'2026-09-20T09:30:00Z',straightTipCode:'2'});
  assert.equal(h.tipCode,'2'); assert.equal(h.relation,'away-cover');
});
test('minus two uses exact two-goal margin for handicap draw and three-plus for cover',()=>{
  const h=buildHandicapMarginDecision(match(2.8,.5,-2),{now:NOW,cutoffTime:'2026-09-20T09:30:00Z',straightTipCode:'1'});
  assert.equal(h.exactMargin,2); assert.equal(h.tipCode,'1'); assert.ok(h.coverProbability>h.landOnLineProbability);
});
test('handicap probabilities are normalized from the full goal-margin matrix',()=>{
  const d=marginDistribution(1.75,1.1,-1); const sum=d.probabilities['1']+d.probabilities.X+d.probabilities['2'];
  assert.ok(Math.abs(sum-1)<1e-6); assert.ok(d.tailMass<1e-8);
});
test('fractional three-way handicap line is refused instead of inventing a draw state',()=>{
  const m=match();m.handicapLine=-1.5;assert.equal(buildHandicapMarginDecision(m,{now:NOW,cutoffTime:'2026-09-20T09:30:00Z',straightTipCode:'1'}),null);
});
test('stale HHAD price removes only market reference, not the score-distribution analysis',()=>{
  const m=match();m.handicapOddsUpdatedAt='2026-09-20T00:00:00Z';
  const h=buildHandicapMarginDecision(m,{now:NOW,cutoffTime:'2026-09-20T09:30:00Z',straightTipCode:'1'});
  assert.ok(h);assert.equal(h.marketReference,null);
});
test('unified decision stores handicap analysis and validates it',()=>{
  const d=makeDecision(match(),{now:NOW,publication:PUB}).decision;
  assert.ok(d.handicapAnalysis);assert.equal(d.handicapAnalysis.tipCode,'1');assert.equal(validHandicapMarginDecision(d.handicapAnalysis),true);assert.equal(validDecision(d),true);
});
test('HHAD-only input change creates a new immutable decision id',()=>{
  const a=makeDecision(match(2.2,.6,-1),{now:NOW,publication:PUB}).decision;
  const b=makeDecision(match(2.2,.6,-2),{now:NOW,publication:PUB}).decision;
  assert.notEqual(a.decisionId,b.decisionId);assert.equal(a.hadInputHash,b.hadInputHash);
});
test('settlement distinguishes landing on -1 from covering -1',()=>{
  const d=makeDecision(match(1.2,.1,-1),{now:NOW,publication:PUB}).decision;
  const base={sourceMatchId:'1',eventVersion:d.eventVersion,homeTeamId:'h1',awayTeamId:'a1',state:'FINAL',eventId:'r1',revision:1};
  const one=settleHandicapDecision(d,{...base,scoreHome:1,scoreAway:0});
  assert.equal(one.actual,'X');assert.equal(one.state,'WON');
  const two=settleHandicapDecision(d,{...base,scoreHome:2,scoreAway:0});
  assert.equal(two.actual,'1');assert.equal(two.state,'LOST');
});
test('handicap review statistics are isolated from straight-result settlement',()=>{
  const d=makeDecision(match(1.2,.1,-1),{now:NOW,publication:PUB}).decision;
  const rows=[{decision:d,settlement:{state:'WON'},handicapSettlement:{state:'WON'}},{decision:d,settlement:{state:'WON'},handicapSettlement:{state:'LOST'}}];
  const s=handicapSummary(rows);assert.equal(s.published,2);assert.equal(s.settled,2);assert.equal(s.won,1);assert.equal(s.hitRate,.5);
});

function calibrationFixture(count,{line=-2,raw={'1':.35,X:.25,'2':.40},score=[3,0]}={}){
  const decisions=[],heads=new Map();
  for(let i=0;i<count;i++){
    const sourceMatchId='cal'+i,eventVersion='2026-08-'+String((i%28)+1).padStart(2,'0')+'T10:00:00.000Z';
    const decisionId='d'+i,businessDate='2026-08-'+String((i%28)+1).padStart(2,'0');
    decisions.push({decisionId,sourceMatchId,eventVersion,businessDate,publishedAt:eventVersion,homeTeamId:'h'+i,awayTeamId:'a'+i,tipCode:'1',
      handicapAnalysis:{version:'handicap-margin-v1',handicapLine:line,rawProbabilities:raw,probabilities:raw,tipCode:'2'}});
    const eventKey=JSON.stringify([sourceMatchId,eventVersion]);
    heads.set(eventKey,{eventKey,state:'FINAL',sourceMatchId,eventVersion,scoreHome:score[0],scoreAway:score[1],homeTeamId:'h'+i,awayTeamId:'a'+i});
  }
  return {decisions,heads};
}
test('large home-give bucket detects historical let-away overprediction and can flip a close new call',()=>{
  const {decisions,heads}=calibrationFixture(24);
  const profile=buildHandicapCalibration(decisions,heads,'2026-09-20');
  const key='home-give-2|straight:1';
  assert.equal(profile.groups[key].active,true);
  assert.ok(profile.groups[key].bias['2']>0);
  const adjusted=calibrateHandicapProbabilities({'1':.35,X:.25,'2':.40},-2,'1',profile);
  assert.equal(adjusted.applied,true);
  assert.ok(adjusted.probabilities['1']>adjusted.probabilities['2']);
});
test('insufficient samples are reported but never change the live probabilities',()=>{
  const {decisions,heads}=calibrationFixture(10);
  const profile=buildHandicapCalibration(decisions,heads,'2026-09-20');
  const adjusted=calibrateHandicapProbabilities({'1':.35,X:.25,'2':.40},-2,'1',profile);
  assert.equal(profile.groups['home-give-2|straight:1'].active,false);
  assert.equal(adjusted.applied,false);
  assert.deepEqual(adjusted.probabilities,{'1':.35,X:.25,'2':.40});
});
test('handicap strength buckets separate one, two and three-plus goals and both signs',()=>{
  assert.equal(lineGroup(-1),'home-give-1');assert.equal(lineGroup(-2),'home-give-2');assert.equal(lineGroup(-4),'home-give-3plus');
  assert.equal(lineGroup(1),'home-receive-1');assert.equal(lineGroup(2),'home-receive-2');assert.equal(lineGroup(4),'home-receive-3plus');
});

test('many samples from only one match day cannot activate calibration',()=>{
  const {decisions,heads}=calibrationFixture(24);
  for(const d of decisions)d.businessDate='2026-08-01';
  const profile=buildHandicapCalibration(decisions,heads,'2026-09-20');
  assert.equal(profile.groups['home-give-2|straight:1'].active,false);
  assert.equal(profile.groups['home-give-2|straight:1'].reason,'insufficient-sample-days');
});
test('one corrupt historical decision is excluded without blocking calibration of valid rows',()=>{
  const {decisions,heads}=calibrationFixture(24);
  decisions.push({decisionId:'broken',businessDate:'2026-08-01',publishedAt:'bad',eventVersion:'bad',handicapAnalysis:{handicapLine:-2,probabilities:{'1':.3,X:.2,'2':.5}},tipCode:'1'});
  const profile=buildHandicapCalibration(decisions,heads,'2026-09-20');
  assert.equal(profile.sampleRows,24);
});
