'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectionFor}=require('../scripts/recommendationPlatform/comboSelections.cjs');
const {coherentHandicapDistribution}=require('../src/services/handicapMarginDecision.cjs');
const {selectCoherentPrimary,validCoherentPrimary,conflicts}=require('../src/services/coherentPrimarySelection.cjs');
const {settleHandicapDecision,settleDecision,collectResults}=require('../scripts/recommendationPlatform/results.cjs');
const {buildPublishedScoreDistribution}=require('../src/services/publishedScoreDistribution.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {NOW,match,publication,validators}=require('./recommendationFixture.cjs');
const codes=['1','X','2'];
function source(line,p={home:45.5,draw:28,away:26.5}){
  return match(1,NOW,{handicapLine:line,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.1},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString(),
    probabilityModel:{version:'test',generatedAt:new Date(NOW).toISOString(),oneXTwo:{final:p},calculationTrace:{poisson:{lambdas:{home:1.6,away:1.3}}}}});
}
const make=m=>makeDecision(m,{now:NOW,publication:publication(NOW)}).decision;
function rehash(d){delete d.recordHash;d.recordHash=hash(d);return d;}
test('home -1 anchors handicap away; companion excludes home win and retains true unconditional probabilities',()=>{
  const m=source(-1),before=JSON.stringify(m),d=make(m),c=d.coherentPrimary;
  assert(validDecision(d));assert.equal(c.anchorMarket,'HHAD');assert.equal(c.hhadCode,'2');assert.equal(c.hadCode,'X');
  assert.equal(d.modelProbability,.28);assert.equal(d.odds,d.quoteOdds.X);assert.equal(c.anchorProbability,.545);
  assert(c.companionConditionalProbability>d.modelProbability);assert(!conflicts(d.tipCode,c.hhadCode,-1));assert.equal(JSON.stringify(m),before);
  assert.equal(selectionFor(d,'HHAD').tipCode,c.hhadCode);assert.equal(selectionFor(d,'HAD').tipCode,c.hadCode);
});
test('away leader against +1 receiving handicap cannot be paired with the receiving-side win',()=>{
  const d=make(source(1,{home:25,draw:30,away:45}));
  assert(validDecision(d));assert.equal(d.coherentPrimary.anchorMarket,'HHAD');assert.equal(d.coherentPrimary.hhadCode,'1');assert.equal(d.tipCode,'X');
});
test('strong HAD leader stays primary and selects the highest compatible handicap joint mass',()=>{
  const d=make(source(-1,{home:80,draw:12,away:8}));
  assert(validDecision(d));assert.equal(d.coherentPrimary.anchorMarket,'HAD');assert.equal(d.tipCode,'1');
  assert(['1','X'].includes(d.coherentPrimary.hhadCode));
});
test('missing or stale HHAD prices cannot become an anchor or a combo leg',()=>{
  for(const patch of [{handicapOddsSource:'unknown'},{handicapOddsUpdatedAt:new Date(NOW-16*60000).toISOString()}]){
    const d=make({...source(-1),...patch});assert(validDecision(d));assert.equal(d.coherentPrimary.anchorMarket,'HAD');assert.equal(d.tipCode,'1');
    assert.equal(d.coherentPrimary.hhadCode,null);assert.equal(selectionFor(d,'HHAD'),null);assert.equal(settleHandicapDecision(d,null),null);
  }
});
test('every integer line and diverse HAD probabilities produce compatible pairs from one matrix',()=>{
  for(const line of [-3,-2,-1,1,2,3])for(const p of [{'1':.45,X:.28,'2':.27},{'1':.2,X:.5,'2':.3},{'1':.1,X:.15,'2':.75},{'1':1/3,X:1/3,'2':1/3}]){
    const a=coherentHandicapDistribution(1.8,1.2,line,p,'1',null,'adaptive-tail-v1');
    const c=selectCoherentPrimary(p,a.probabilities,a.jointProbabilities,line,true);
    assert(c);assert(!conflicts(c.hadCode,c.hhadCode,line));assert(c.jointProbability>0);
    assert(validCoherentPrimary(JSON.parse(JSON.stringify(c)),p,a.probabilities,line,true));
    assert.equal(c.anchorProbability,Math.max(...Object.values(p),...Object.values(a.probabilities)));
    const column=codes.map(code=>c.anchorMarket==='HAD'?a.jointProbabilities[c.hadCode][code]:a.jointProbabilities[code][c.hhadCode]);
    assert.equal(c.jointProbability,Math.max(...column));
  }
});
test('tampering with anchor, joint mass, companion or probabilities fails even after rehashing',()=>{
  const d=make(source(-1));
  for(const modify of [c=>c.anchorMarket='HAD',c=>c.hadCode='1',c=>c.jointProbability+=.01,c=>c.jointProbabilities.X['2']+=.02]){
    const copy=structuredClone(d);modify(copy.coherentPrimary);assert.equal(validDecision(rehash(copy)),false);
  }
});
test('settlement and aligned scores use the stored compatible pair; old independent records remain valid',()=>{
  const m=source(-1),d=make(m),legacy=makeDecision(m,{now:NOW,publication:publication(NOW),primaryPolicy:'independent-market-primary-v1'}).decision;
  assert(validDecision(legacy));assert.equal(legacy.tipCode,'1');assert.equal(legacy.coherentPrimary,undefined);
  const event=collectResults([{...m,status:'FINISHED',testOfficial:true,scoreHome:1,scoreAway:1,resultRevision:0}],new Map(),validators,Date.parse(m.kickoffTime)+3*3600000).updates[0];
  assert.equal(settleDecision(d,event).state,'WON');assert.equal(settleHandicapDecision(d,event).state,'WON');
  assert.equal(settleDecision(legacy,event).state,'LOST');assert.equal(settleHandicapDecision(legacy,event).state,'WON');
  const scores=buildPublishedScoreDistribution(d);assert.equal(scores.status,'available');assert(scores.alignedScores.length);
  assert(scores.alignedScores.every(s=>s.hadCode===d.tipCode&&s.hhadCode===d.coherentPrimary.hhadCode));
});
