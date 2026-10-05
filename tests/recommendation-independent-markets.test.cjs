'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeDecision:makePolicyDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
// Retain replay coverage of the archived independent-market policy.
const makeDecision=(m,o)=>makePolicyDecision(m,{...o,primaryPolicy:'independent-market-primary-v1'});
const {match,publication,NOW}=require('./recommendationFixture.cjs');
const {buildPublishedScoreDistribution}=require('../src/services/publishedScoreDistribution.cjs');
const {selectionQuality}=require('../src/services/recommendationSelectionQuality.cjs');
const {settleHandicapDecision,handicapBreakdown}=require('../scripts/recommendationPlatform/results.cjs');
const {scoreMatrix,poissonSupport}=require('../src/services/goalDistribution.cjs');
const {selectHadDirection,validHadDirectionSelection}=require('../src/services/hadDirectionSelection.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
function source(home=2.8,away=1.8,line=-1,p=[.55,.25,.2]){
  return match(1,NOW,{handicapLine:line,handicapOdds:{odds1:2.1,oddsX:3.4,odds2:2.9},
    handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString(),
    probabilityModel:{version:'synthetic-test',generatedAt:new Date(NOW).toISOString(),
      oneXTwo:{final:{home:p[0],draw:p[1],away:p[2]}},calculationTrace:{poisson:{lambdas:{home,away}}}}});
}
const publish=m=>makeDecision(m,{now:NOW,publication:publication(NOW)}).decision;

test('real PR94 serializer fixture remains byte-identical and keeps its original conditional picks',()=>{
  const fixture=require('./fixtures/recommendation-independent-legacy.json');
  const d=fixture.decision,original=JSON.stringify(d);
  assert(validDecision(d));assert.equal(d.primaryPickPolicyVersion,undefined);
  assert.equal(d.supplementaryResearch.version,'supplementary-research-v1');
  assert.equal(d.supplementaryResearch.exactScore.label,'3-1');
  assert.equal(hash(buildPublishedScoreDistribution(d)),fixture.projectedHash);
  assert.equal(JSON.stringify(d),original);
});

test('weak evidence preserves all four unique primaries and does not promote combo admission',()=>{
  const d=publish(source());assert.ok(validDecision(d));
  assert.equal(selectionQuality(d).qualified,false);
  assert.equal(d.tipCode,'1');assert.equal(d.handicapAnalysis.overallTipCode,'2');
  assert.equal(d.supplementaryResearch.exactScore.label,'2-2');
  assert.equal(d.supplementaryResearch.totalGoals.label,'4');
  assert.equal(d.supplementaryResearch.priceStatus,'official-sp-unavailable');
  assert.equal(d.supplementaryResearch.odds,null);
});

test('deep handicaps follow evidence: strong home -3 and strong away +3 can cover; weak home -2 does not',()=>{
  for(const [home,away,line,p,pick,score] of [
    [4.8,.3,-3,[.96,.03,.01],'1','4-0'],[.3,4.8,3,[.01,.03,.96],'2','0-4'],
    [.8,.7,-2,[.4,.35,.25],'2','0-0'],
  ]){
    const d=publish(source(home,away,line,p)),h=d.handicapAnalysis;
    assert(validDecision(d));assert.equal(h.overallTipCode,pick);
    assert.equal(d.supplementaryResearch.exactScore.label,score);
    assert.equal(h.overallProbabilities[pick],Math.max(...Object.values(h.overallProbabilities)));
  }
});

test('HHAD primary and settlement use the same full vector, separately from the conditional explanation',()=>{
  const d=publish(source()),h=d.handicapAnalysis;
  assert.notEqual(h.tipCode,h.overallTipCode);
  const event={sourceMatchId:d.sourceMatchId,eventVersion:d.eventVersion,homeTeamId:d.homeTeamId,
    awayTeamId:d.awayTeamId,state:'FINAL',eventId:'synthetic-result',revision:0,scoreHome:1,scoreAway:1};
  const result=settleHandicapDecision(d,event);
  assert.equal(result.state,'WON');
  const stats=handicapBreakdown([{decision:d,handicapSettlement:result,settlement:{state:'LOST'}}]);
  assert.equal(stats.independentPrimaryV1.won,1);assert.equal(stats.companionV3All.published,0);
});

test('goals and scores remain available without an official handicap line; no handicap is invented',()=>{
  const m=source(4.8,.3,undefined,[.96,.03,.01]);delete m.handicapLine;
  const d=publish(m),p=buildPublishedScoreDistribution(d,{limit:6561});
  assert.equal(d.handicapAnalysis,null);assert(validDecision(d));assert(d.supplementaryResearch);
  assert.equal(p.handicapLine,null);assert(p.topScores.every(r=>r.hhadCode===null));
  near(p.topScores.reduce((s,r)=>s+r.probability,0),1);
  const changed=source(1.2,1.1,undefined);delete changed.handicapLine;
  assert.notEqual(publish(changed).decisionId,d.decisionId);
  const missing=source(null,null);assert.equal(publish(missing).scoreModelInput,null);
  assert.equal(publish(missing).supplementaryResearch,null);
});

test('full-matrix probabilities reproduce HAD, independent HHAD, and every TTG bucket including 7+',()=>{
  for(const line of [-3,-2,-1,1,2,3]){
    const d=publish(source(4.8,1.2,line,[.8,.12,.08]));
    const p=buildPublishedScoreDistribution(d,{limit:6561});assert.equal(p.status,'available');
    near(p.topScores.reduce((s,r)=>s+r.probability,0),1);
    for(const code of ['1','X','2']){
      near(p.topScores.filter(r=>r.hadCode===code).reduce((s,r)=>s+r.probability,0),d.probabilities[code]);
      near(p.topScores.filter(r=>r.hhadCode===code).reduce((s,r)=>s+r.probability,0),d.handicapAnalysis.overallProbabilities[code],1e-6);
    }
    for(let total=0;total<8;total++)near(p.topScores.filter(r=>Math.min(7,r.home+r.away)===total).reduce((s,r)=>s+r.probability,0),p.totalGoals[total].probability);
    assert(p.totalGoals[7].probability>.2);assert(p.topScores.some(r=>r.home>=8));
  }
});

test('adaptive support preserves mean and mass up to the supported rate ceiling, with no 5/8/10-goal cap',()=>{
  for(const home of [0,.1,1.2,4.8,8,12])for(const away of [0,.3,2.5,8,12]){
    const rows=scoreMatrix(home,away);near(rows.reduce((s,r)=>s+r.probability,0),1,3e-12);
    near(rows.reduce((s,r)=>s+r.home*r.probability,0),home,1e-9);
    near(rows.reduce((s,r)=>s+r.away*r.probability,0),away,1e-9);
  }
  assert(poissonSupport(12).values.length>37);
  for(const invalid of [null,undefined,'',-1,NaN,Infinity,13])assert.equal(poissonSupport(invalid),null);
  const d=publish(source(12,12,-3,[.4,.2,.4]));assert(validDecision(d));
  assert(d.handicapAnalysis.tailMass<=3e-12);
  assert.equal(buildPublishedScoreDistribution(d).status,'available');
});

test('same-time tied HAD probabilities publish exactly one reproducible low-confidence direction',()=>{
  const d=publish(source(1.2,1.2,-1,[.4,.4,.2]));assert(validDecision(d));
  assert.equal(d.tipCode,'1');assert.equal(d.directionSelection.tieBreakPolicy,'stable-code-order');
  assert(selectionQuality(d).reasons.includes('model-lead-too-thin'));
  const old=selectHadDirection({'1':.4,X:.4,'2':.2},{'1':2,X:3,'2':4},{version:'had-direction-selection-v1'});
  assert.equal(old,null);
  const stable=selectHadDirection({'1':.6,X:.2,'2':.2},{'1':2,X:3,'2':4},{version:'had-direction-selection-v1'});
  assert(validHadDirectionSelection(stable,{'1':.6,X:.2,'2':.2},{'1':2,X:3,'2':4}));
});

test('new support and primary policies are bound to frozen hashes, and cutoff still blocks publication',()=>{
  const d=publish(source()),before=JSON.stringify(d);
  for(const edit of [r=>r.primaryPickPolicyVersion='unknown',r=>r.scoreModelInput.home=9,
    r=>r.handicapAnalysis.scoreSupportPolicy='unknown',r=>r.supplementaryResearch.exactScore.probability=.9]){
    const bad=structuredClone(d);edit(bad);const {recordHash,...body}=bad;bad.recordHash=hash(body);
    assert.equal(validDecision(bad),false);
  }
  assert.equal(makeDecision(source(),{now:Date.parse(d.cutoffTime),publication:publication(NOW)}).decision,null);
  assert.equal(JSON.stringify(d),before);
});

test('measured high goal rates survive form and calibration stages; ordinary inputs retain their values',()=>{
  const sync=require('../scripts/syncData.cjs');
  const {verifyModelInputUsage}=require('../src/services/modelInputUsage.cjs');
  const m={sourceMatchId:'synthetic-rates',kickoffTime:'2026-09-29T12:00:00Z',leagueId:'test',
    formSnapshot:{sampleSize:24,home:{sampleSize:12,goalsForAvg:8,goalsAgainstAvg:.6},
      away:{sampleSize:12,goalsForAvg:.6,goalsAgainstAvg:8}}};
  const r=sync.blendLambdasWithForm(m,4.8,.6);
  assert(r.homeLambda>4.8);near(r.awayLambda,.6);assert(verifyModelInputUsage(r.formUsage));
  assert.equal(r.formUsage.lambdaPolicy,'evidence-rate-support-v2');
  const usual=sync.blendLambdasWithForm({...m,formSnapshot:null},1.4,1.1);
  assert.equal(usual.homeLambda,1.4);assert.equal(usual.awayLambda,1.1);assert(verifyModelInputUsage(usual.formUsage));
});
