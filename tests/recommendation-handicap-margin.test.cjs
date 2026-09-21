'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {marginDistribution,conditionalHandicapDistribution,coherentHandicapDistribution,buildHandicapMarginDecision,validHandicapMarginDecision}=require('../src/services/handicapMarginDecision.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
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
    const body={decisionId,sourceMatchId,eventVersion,businessDate,publishedAt:eventVersion.replace('T10:','T09:'),homeTeamId:'h'+i,awayTeamId:'a'+i,tipCode:'1',
      handicapAnalysis:{version:'handicap-margin-v2',companionPolicyVersion:'straight-conditioned-margin-v1',straightTipCode:'1',handicapLine:line,companionRawProbabilities:raw,rawProbabilities:raw,probabilities:raw,tipCode:'2'}};
    decisions.push({...body,recordHash:hash(body)});
    const eventKey=JSON.stringify([sourceMatchId,eventVersion]);
    heads.set(eventKey,{eventKey,state:'FINAL',sourceMatchId,eventVersion,observedAt:eventVersion.replace('T10:','T12:'),scoreHome:score[0],scoreAway:score[1],homeTeamId:'h'+i,awayTeamId:'a'+i});
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
  for(const d of decisions){d.businessDate='2026-08-01';const {recordHash,...body}=d;d.recordHash=hash(body);}
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

test('home-win plus minus-one never publishes handicap-away as the companion pick',()=>{
  const h=buildHandicapMarginDecision(match(.6,.2,-1),{now:NOW,cutoffTime:'2026-09-20T09:30:00Z',straightTipCode:'1'});
  assert.equal(h.overallTipCode,'X');
  assert.equal(h.tipCode,'X');
  assert.equal(h.probabilities['2'],0);
  assert.equal(h.probabilityBasis,'conditional-on-straight-primary');
});
test('home-win plus minus-two may legitimately resolve to handicap-away when the model expects only a one-goal win',()=>{
  const h=buildHandicapMarginDecision(match(.6,.1,-2),{now:NOW,cutoffTime:'2026-09-20T09:30:00Z',straightTipCode:'1'});
  assert.equal(h.tipCode,'2');
  assert.ok(h.probabilities['2']>.7);
  assert.equal(h.relation,'home-not-cover');
});
test('conditional margin support is mathematically coherent with the frozen straight pick',()=>{
  const home=conditionalHandicapDistribution(.6,.2,-1,'1');
  assert.equal(home.probabilities['2'],0);
  const away=conditionalHandicapDistribution(.6,1.8,1,'2');
  assert.equal(away.probabilities['1'],0);
});
test('calibration v2 ignores matches where the frozen HAD thesis missed',()=>{
  const {decisions,heads}=calibrationFixture(24);
  const first=decisions[0],eventKey=JSON.stringify([first.sourceMatchId,first.eventVersion]);
  const old=heads.get(eventKey);heads.set(eventKey,{...old,scoreHome:0,scoreAway:1});
  const profile=buildHandicapCalibration(decisions,heads,'2026-09-20');
  assert.equal(profile.sampleRows,23);
  assert.equal(profile.version,'handicap-calibration-v2');
});

test('one coherent score matrix reproduces final HAD and both conditional and unconditional HHAD',()=>{
  const had={home:.51,draw:.30,away:.19};
  const matrix=coherentHandicapDistribution(.6,.2,-1,had,'1');
  for(const [code,expected] of [['1',.51],['X',.30],['2',.19]]){
    assert.ok(Math.abs(Object.values(matrix.jointProbabilities[code]).reduce((s,p)=>s+p,0)-expected)<1e-12);
  }
  assert.equal(matrix.probabilities['2'],.49);
  assert.equal(matrix.conditionalProbabilities['2'],0);
  assert.ok(matrix.conditionalProbabilities.X>matrix.probabilities.X);
  const m=match(.6,.2,-1);m.probabilityModel.oneXTwo.final=had;
  const h=buildHandicapMarginDecision(m,{now:NOW,cutoffTime:m.buyEndTime,straightTipCode:'1'});
  assert.equal(h.version,'handicap-margin-v3');assert.deepEqual(h.overallProbabilities,matrix.probabilities);
  assert.deepEqual(h.probabilities,matrix.conditionalProbabilities);assert.equal(validHandicapMarginDecision(h),true);
});
test('coherence refuses unsupported score regions instead of adding synthetic mass',()=>{
  assert.equal(coherentHandicapDistribution(0,0,-1,{home:.5,draw:.3,away:.2},'1'),null);
  const m=match();delete m.probabilityModel.oneXTwo;
  assert.equal(buildHandicapMarginDecision(m,{now:NOW,cutoffTime:m.buyEndTime,straightTipCode:'1'}),null);
});
test('conditional calibration keeps HAD marginal fixed and updates unconditional HHAD in the same matrix',()=>{
  const matrix=coherentHandicapDistribution(2,.7,-2,{home:.6,draw:.25,away:.15},'1',{'1':.4,X:.35,'2':.25});
  assert.deepEqual(matrix.conditionalProbabilities,{'1':.4,X:.35,'2':.25});
  assert.deepEqual(matrix.probabilities,{'1':.24,X:.21,'2':.55});
  for(const code of ['1','X','2'])assert.ok(Math.abs(Object.values(matrix.jointProbabilities[code]).reduce((s,p)=>s+p,0)-matrix.straightProbabilities[code])<1e-12);
  assert.equal(coherentHandicapDistribution(2,.7,-1,{home:.6,draw:.25,away:.15},'1',{'1':.4,X:.35,'2':.25}),null);
});
test('coherent records reject altered overall probabilities, basis, hash, clocks and incomplete evidence',()=>{
  const m=match(),h=buildHandicapMarginDecision(m,{now:NOW,cutoffTime:m.buyEndTime,straightTipCode:'1'});
  const mutations=[
    v=>{v.overallProbabilities['1']+=.02;v.overallProbabilities['2']-=.02;},
    v=>{v.straightProbabilities['1']+=.02;v.straightProbabilities['2']-=.02;},
    v=>{v.distributionBasis='bare-poisson';},v=>{v.inputHash='f'.repeat(64);},
    v=>{v.computedAt=v.cutoffTime;},v=>{delete v.straightConditionedMass;},
    v=>{delete v.overallRawProbabilities.X;},v=>{v.coverProbability+=.01;},
    v=>{v.marketReference.handicapLine=-2;},v=>{v.marketReference.source='500.com:HHAD';},
    v=>{v.marketReference.observedAt=new Date(NOW+1).toISOString();},
    v=>{delete v.marketReference.odds.X;},
  ];
  for(const mutate of mutations){const changed=structuredClone(h);mutate(changed);assert.equal(validHandicapMarginDecision(changed),false);}
});
test('only complete fresh official quotes with the same explicit HHAD line enter evidence',()=>{
  for(const mutate of [m=>{m.handicapOddsSource='500.com:HHAD';},m=>{delete m.handicapOdds.oddsX;},m=>{m.handicapOddsUpdatedAt=new Date(NOW+1).toISOString();}]){
    const m=match();mutate(m);const h=buildHandicapMarginDecision(m,{now:NOW,cutoffTime:m.buyEndTime,straightTipCode:'1'});
    assert.ok(h);assert.equal(h.marketReference,null);
  }
  const m=match();delete m.handicapOdds;m.externalSignals={bookmakerOdds:{hhad:{odds1:2,oddsX:3,odds2:4,source:'sporttery:HHAD',observedAt:new Date(NOW).toISOString()}}};
  assert.equal(buildHandicapMarginDecision(m,{now:NOW,cutoffTime:m.buyEndTime,straightTipCode:'1'}).marketReference,null);
});
test('calibration counts each event once, excludes tampered records and excludes results after fit time',()=>{
  const {decisions,heads}=calibrationFixture(24),first=decisions[0];
  decisions.push({...first});
  decisions[1].handicapAnalysis.companionRawProbabilities={'1':.4,X:.2,'2':.4};
  const secondKey=JSON.stringify([decisions[2].sourceMatchId,decisions[2].eventVersion]);
  heads.get(secondKey).observedAt='2026-10-01T00:00:00Z';
  const p=buildHandicapCalibration(decisions,heads,'2026-09-20',{asOf:NOW});
  assert.equal(p.sampleRows,22);
});
test('late training results unavailable at holdout start cannot activate calibration',()=>{
  const {decisions,heads}=calibrationFixture(24);
  for(const e of heads.values())e.observedAt='2026-09-01T00:00:00Z';
  const p=buildHandicapCalibration(decisions,heads,'2026-09-20',{asOf:NOW});
  assert.equal(p.sampleRows,24);assert.equal(p.groups['home-give-2|straight:1'].active,false);
  assert.equal(p.groups['home-give-2|straight:1'].reason,'insufficient-time-forward-window');
});
test('profile hash tampering and profiles fitted in the future never change a new prediction',()=>{
  const {decisions,heads}=calibrationFixture(24),profile=buildHandicapCalibration(decisions,heads,'2026-09-20',{asOf:NOW});
  const broken=structuredClone(profile);broken.groups['home-give-2|straight:1'].weight=.65;
  assert.equal(calibrateHandicapProbabilities({'1':.35,X:.25,'2':.40},-2,'1',broken).applied,false);
  const future=buildHandicapCalibration(decisions,heads,'2026-09-20',{asOf:NOW+1});
  const m=match(2,.7,-2),h=buildHandicapMarginDecision(m,{now:NOW,cutoffTime:m.buyEndTime,straightTipCode:'1',calibrationProfile:future});
  assert.equal(h.historicalCalibration.applied,false);
});
test('unchanged calibration samples keep profile and handicap identity across retry clocks',()=>{
  const {decisions,heads}=calibrationFixture(24),a=buildHandicapCalibration(decisions,heads,'2026-09-20',{asOf:NOW}),b=buildHandicapCalibration(decisions,heads,'2026-09-20',{asOf:NOW+1000});
  assert.equal(a.profileHash,b.profileHash);assert.notEqual(a.asOf,b.asOf);
  const m=match(2,.7,-2),h1=buildHandicapMarginDecision(m,{now:NOW,cutoffTime:m.buyEndTime,straightTipCode:'1',calibrationProfile:a}),h2=buildHandicapMarginDecision(m,{now:NOW+1000,cutoffTime:m.buyEndTime,straightTipCode:'1',calibrationProfile:b});
  assert.equal(h1.historicalCalibration.applied,true);assert.equal(h1.inputHash,h2.inputHash);
  assert.equal(validHandicapMarginDecision(h1),true);assert.equal(validHandicapMarginDecision(h2),true);
});
test('rounded percentage HAD input uses exactly the publication policy normalization',()=>{
  const m=match();m.probabilityModel.oneXTwo.final={home:55.1,draw:25,away:19.8};
  const d=makeDecision(m,{now:NOW,publication:PUB}).decision;
  assert.ok(d.handicapAnalysis);assert.deepEqual(d.handicapAnalysis.straightProbabilities,d.probabilities);
  assert.equal(validDecision(d),true);
});
test('frozen PR37 v2 evidence remains valid without recalculating it as coherent v3',()=>{
  const legacy=require('./fixtures/handicap-margin-v2.json');
  assert.equal(legacy.inputHash,'043dc2474fe8928a6b572dce2bc5643c3b7604cea8c6ba70966f1589f3dd24a7');
  assert.equal(validHandicapMarginDecision(legacy),true);
  const changed=structuredClone(legacy);changed.overallProbabilities['1']+=.02;changed.overallProbabilities['2']-=.02;
  assert.equal(validHandicapMarginDecision(changed),false);
});
test('legacy v1 frozen analysis retains its original unconditional meaning',()=>{
  const raw=marginDistribution(2.2,.6,-1).probabilities;
  const legacy={version:'handicap-margin-v1',market:'HHAD',handicapLine:-1,tipCode:'1',rawProbabilities:raw,probabilities:raw,modelProbability:raw['1'],lambdas:{home:2.2,away:.6},exactMargin:1,inputHash:'a'.repeat(64)};
  assert.equal(validHandicapMarginDecision(legacy),true);
});
