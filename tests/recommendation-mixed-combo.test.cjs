'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeDecision,validDecision,chooseCombo,freezeCombo,product}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectionFor,validSelection,validCombo,candidatesFor}=require('../scripts/recommendationPlatform/comboSelections.cjs');
const {key,settleCombo,handicapBreakdown,marketBaseline,dailySummary}=require('../scripts/recommendationPlatform/results.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {match,publication,validators,memoryPorts}=require('./recommendationFixture.cjs');
const NOW=Date.parse('2026-09-17T13:00:00Z');
function input(id=1,patch={}){
  const m=match(id,NOW,{handicapLine:1,handicapOdds:{odds1:2.05,oddsX:3.4,odds2:2.75},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(NOW).toISOString(),...patch});
  m.probabilityModel.calculationTrace={poisson:{lambdas:{home:2.2,away:.6}}};
  return m;
}
const decide=m=>makeDecision(m,{now:NOW,publication:publication(NOW)}).decision;
const plain=id=>decide(match(id,NOW));
const mixed=()=>chooseCombo([decide(input(1)),plain(2)],2,NOW);
function heads(combo,scores){return new Map(combo.legs.map((d,i)=>[key(d),{sourceMatchId:d.sourceMatchId,eventVersion:d.eventVersion,homeTeamId:d.homeTeamId,awayTeamId:d.awayTeamId,state:'FINAL',eventId:`r${i}`,revision:0,scoreHome:scores[i][0],scoreAway:scores[i][1]}]));}
function legacy(combo){
  const c=structuredClone(combo);delete c.selections;delete c.selectionIds;
  c.version='unified-combo-v1';c.rankingMethod='sum-log-unchanged-model-probability';
  c.id=`combo_${hash([c.version,c.businessDate,c.size,c.decisionIds])}`;
  return c;
}

test('mixed market ranking uses independent probability while preserving immutable HAD parents',()=>{
  const d=decide(input()),before=JSON.stringify(d),c=chooseCombo([d,plain(2)],2,NOW);
  assert.equal(c.version,'unified-combo-v2');assert.deepEqual(c.selections.map(s=>s.market),['HHAD','HAD']);
  const s=c.selections[0];assert.equal(s.probabilityBasis,'unconditional');assert.equal(s.modelProbability,d.handicapAnalysis.overallProbabilities[s.tipCode]);
  assert.equal(s.odds,d.handicapAnalysis.marketReference.odds[s.tipCode]);assert.equal(s.decisionRecordHash,d.recordHash);
  assert.equal(c.rawTotalOdds,2.05*1.8);assert.equal(c.jointProbability,null);assert.equal(JSON.stringify(d),before);
  assert.equal(validSelection(s,d),true);assert.equal(validCombo(c),true);assert.ok(freezeCombo(c,NOW));
});
test('a structurally certain companion probability never becomes 100 percent combo success',()=>{
  const d=decide(input());assert.equal(d.handicapAnalysis.modelProbability,1);
  const selected=selectionFor(d,'HHAD');assert.ok(selected.modelProbability<1);assert.equal(selected.modelProbability,d.handicapAnalysis.overallProbabilities[selected.tipCode]);
});
test('unchanged HHAD input keeps one decision identity on retry while stored times stay immutable',()=>{
  const m=input(),a=decide(m),b=makeDecision(m,{now:NOW+1000,publication:publication(NOW+1000)}).decision;
  assert.equal(a.decisionId,b.decisionId);assert.equal(a.handicapAnalysis.inputHash,b.handicapAnalysis.inputHash);
  assert.equal(validDecision(a),true);assert.equal(validDecision(b),true);
});
test('HHAD settles the frozen integer handicap and corrects without rewriting the combination',()=>{
  const c=freezeCombo(mixed(),NOW),before=JSON.stringify(c),h=heads(c,[[0,0],[1,0]]);
  assert.equal(c.selections[0].handicapLine,1);assert.equal(settleCombo(c,h).state,'WON');
  assert.equal(settleCombo(c,h).legs[0].actual,'1');
  h.get(key(c.legs[0])).scoreAway=2;assert.equal(settleCombo(c,h).state,'LOST');
  assert.equal(JSON.stringify(c),before);
});
test('minus-one independent direction may differ from the companion and uses its own SP and draw boundary',()=>{
  const d=decide(input(1,{handicapLine:-1,odds:{odds1:1.1,oddsX:3.5,odds2:4.5}}));
  const c=chooseCombo([d,plain(2)],2,NOW),index=c.legs.findIndex(l=>l.decisionId===d.decisionId),selected=c.selections[index];
  assert.equal(d.handicapAnalysis.tipCode,'1');assert.equal(selected.market,'HHAD');assert.equal(selected.tipCode,'2');assert.equal(selected.odds,2.75);
  const h=heads(c,c.legs.map(l=>l.decisionId===d.decisionId?[0,0]:[1,0]));
  assert.equal(settleCombo(c,h).state,'WON');
  h.get(key(d)).scoreHome=1;
  const result=settleCombo(c,h);assert.equal(result.legs[index].actual,'X');assert.equal(result.state,'LOST');
});
test('wrong event result and void outcomes remain isolated for mixed selections',()=>{
  const c=mixed(),h=heads(c,[[0,0],[1,0]]);h.get(key(c.legs[0])).homeTeamId='wrong';
  assert.equal(settleCombo(c,h).state,'DISPUTED');
  h.set(key(c.legs[0]),{...heads(c,[[0,0],[1,0]]).get(key(c.legs[0])),state:'VOID'});assert.equal(settleCombo(c,h).state,'VOID');
});
test('stale HHAD alone is excluded without making a fresh HAD quote stale',()=>{
  const d=decide(input(1,{handicapOddsUpdatedAt:new Date(NOW-16*60000).toISOString()}));
  assert.ok(validDecision(d));assert.deepEqual(candidatesFor(d,NOW).map(x=>x.selection.market),['HAD']);
});
test('absent, future and unverified HHAD quotes cannot enter the candidate pool',()=>{
  for(const patch of [{handicapOdds:null},{handicapOddsUpdatedAt:new Date(NOW+1000).toISOString()},{handicapOddsSource:'500.com:HHAD'}]){
    const d=decide(input(1,patch));assert.ok(d);assert.equal(candidatesFor(d,NOW).some(x=>x.selection.market==='HHAD'),false);
  }
});
test('HHAD quote age is checked independently again at freeze time',()=>{
  const d=decide(input(1,{handicapOddsUpdatedAt:new Date(NOW-14*60000).toISOString()})),c=chooseCombo([d,plain(2)],2,NOW);
  assert.equal(c.selections[0].market,'HHAD');assert.equal(freezeCombo(c,NOW+2*60000),null);
});
test('a match cannot fill two legs through HAD and HHAD or repeated input rows',()=>{
  const d=decide(input());assert.equal(candidatesFor(d,NOW).length,2);
  assert.equal(chooseCombo([d,d],2,NOW),null);
  assert.equal(chooseCombo([d,decide(input(2,{awayTeamId:'h1'}))],2,NOW),null);
});
test('the selected market exact SP product must cross the floor before display rounding',()=>{
  function ds(odds){return [1,2].map(id=>decide(input(id,{odds:{odds1:1.01,oddsX:3.5,odds2:4.5},handicapOdds:{odds1:odds,oddsX:3.4,odds2:2.75}})));}
  assert.equal(chooseCombo(ds(1.58),2,NOW),null);
  const c=chooseCombo(ds(1.59),2,NOW);assert.equal(c.totalOdds,2.53);assert.equal(product(c.selections).passes(2.5),true);
});
test('equal model scores use stable match and market identity rather than the lowest SP',()=>{
  const had=(id,sp)=>decide(match(id,NOW,{odds:{odds1:sp,oddsX:3.5,odds2:4.5}}));
  const decisions=[had(1,1.7),had(2,2.5),had(3,1.8)];
  const selected=chooseCombo(decisions,2,NOW);
  assert.deepEqual(selected.legs.map(d=>d.sourceMatchId),['1','2']);
  assert.equal(selected.rawTotalOdds,4.25);
  assert.equal(validCombo(selected),true);
  assert.deepEqual(chooseCombo(decisions.slice().reverse(),2,NOW).legs.map(d=>d.sourceMatchId),['1','2']);
  assert.deepEqual(chooseCombo([had(1,1.7),had(2,2),had(3,2.3)],2,NOW).legs.map(d=>d.sourceMatchId),['1','2']);
  const frozen=freezeCombo(selected,NOW),before=JSON.stringify(frozen);
  assert.equal(validCombo(frozen,{frozen:true}),true);
  chooseCombo([had(1,1.7),had(2,2),had(3,2.3)],2,NOW);
  assert.equal(JSON.stringify(frozen),before);
});
test('model score still ranks first and SP only excludes combinations below the floor',()=>{
  const had=(id,sp,home=55)=>{
    const m=match(id,NOW,{odds:{odds1:sp,oddsX:3.5,odds2:4.5}});
    m.probabilityModel.oneXTwo.final={home,draw:25,away:75-home};
    return decide(m);
  };
  const stronger=chooseCombo([had(1,1.7),had(2,2.5),had(3,1.8,56)],2,NOW);
  assert.deepEqual(stronger.legs.map(d=>d.sourceMatchId),['1','3']);
  const floor=chooseCombo([had(1,1.4),had(2,1.6),had(3,1.8)],2,NOW);
  assert.deepEqual(floor.legs.map(d=>d.sourceMatchId).sort(),['1','3']);
  assert.equal(floor.rawTotalOdds,2.52);
});
test('selection tampering is rejected even if the outer frozen record is rehashed',()=>{
  for(const field of ['odds','handicapLine','modelProbability','decisionRecordHash','quoteObservedAt']){
    const c=structuredClone(freezeCombo(mixed(),NOW));
    c.selections[0][field]=typeof c.selections[0][field]==='number'?c.selections[0][field]+.1:'tampered';
    const {recordHash,...body}=c;c.recordHash=hash(body);
    assert.equal(validCombo(c,{frozen:true}),false);assert.throws(()=>settleCombo(c,new Map()),/Invalid frozen combo/);
  }
});
test('a rescheduled or foreign-day selection cannot be frozen from a prior preview',()=>{
  const c=structuredClone(mixed());c.businessDate='2026-09-18';assert.equal(freezeCombo(c,NOW),null);
  assert.equal(freezeCombo(mixed(),NOW+24*3600000),null);
});
test('existing v1 frozen HAD records retain the original hash and settlement interpretation',()=>{
  const c=freezeCombo(legacy(chooseCombo([plain(1),plain(2)],2,NOW)),NOW),before=JSON.stringify(c);
  assert.equal(validCombo(c,{frozen:true}),true);assert.equal(settleCombo(c,heads(c,[[1,0],[1,0]])).state,'WON');
  assert.equal(JSON.stringify(c),before);assert.equal(c.version,'unified-combo-v1');assert.equal(c.selections,undefined);
});
test('runtime binds selections to persisted decisions and preserves a previously frozen daily record',async()=>{
  const p=memoryPorts();p.now=NOW;p.current=[input(1),match(2,NOW),match(3,NOW)];const r=createRuntime(p,{validators});
  const cycle=await r.publishingCycle();assert.equal(cycle.combinations.ok,true);assert.equal(p.state.combos.length,2);
  assert.ok(p.state.combos.some(c=>c.selections.some(s=>s.market==='HHAD')));
  assert.equal(p.state.view.excludedCorruptRecords,0);
  const before=JSON.stringify(p.state.combos);p.now+=60000;p.current=[match(4,p.now),match(5,p.now),match(6,p.now)];
  await r.publishingCycle();assert.equal(JSON.stringify(p.state.combos),before);
});
test('review separates standalone, conditional and both-hit denominators by model version',()=>{
  const row=(version,had,hh)=>({decision:{businessDate:'2026-09-17',handicapAnalysis:{version,tipCode:'1'}},settlement:{state:had},handicapSettlement:{state:hh}});
  const rows=[row('handicap-margin-v1','WON','LOST'),row('handicap-margin-v2','WON','WON'),row('handicap-margin-v2','LOST','WON'),row('handicap-margin-v2','WON','LOST'),row('handicap-margin-v2','PENDING','PENDING'),row('handicap-margin-v3','WON','WON')];
  const s=handicapBreakdown(rows);assert.equal(s.standaloneV1.settled,1);assert.equal(s.companionV2All.hitRate,2/3);
  assert.equal(s.companionV2WhenHadWon.hitRate,.5);assert.equal(s.companionV2BothWon.hitRate,1/3);assert.equal(s.companionV2BothWon.pending,1);
  assert.equal(s.companionV3All.settled,1);assert.equal(s.companionV3All.hitRate,1);
});
test('frozen market baseline and daily statistics do not treat pending events as losses',()=>{
  const d=plain(1),rows=[{decision:d,settlement:{state:'WON',actual:'1'}},{decision:d,settlement:{state:'PENDING'}}];
  const baseline=marketBaseline(rows);assert.equal(baseline.settled,1);assert.equal(baseline.won,1);assert.equal(baseline.pending,1);
  const daily=dailySummary(rows,[]);assert.equal(daily.length,1);assert.equal(daily[0].single.hitRate,1);assert.equal(daily[0].marketBaseline.hitRate,1);
});
