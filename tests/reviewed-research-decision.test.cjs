'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const evidence=require('../scripts/recommendationPlatform/reviewedResearchEvidence.cjs');
const decision=require('../scripts/recommendationPlatform/reviewedResearchDecision.cjs');
const combos=require('../scripts/recommendationPlatform/reviewedResearchCombos.cjs');
const fixture=require('./fixtures/reviewed-research.cjs');
const official=require('./fixtures/reviewed-official-event.cjs');
function prepared(){const value=fixture.setup(),draft=decision.prepare({directions:value.directions,evidence:value.packets},value.context);
 return {...value,draft,context:{...value.context,evidenceByEvent:Object.fromEntries(value.packets.map(packet=>[packet.event.eventId,[packet]]))}};}
test('v5 joins frozen directions with actual signed HAD/HHAD quotes without inventing p or EV',()=>{
 const value=prepared(),result=decision.make(value.draft,value.context);
 assert.equal(value.draft.version,5);assert.ok(!JSON.stringify(value.draft).includes('rawBase64'));assert.ok(Buffer.byteLength(JSON.stringify(value.draft))<65536);
 assert.equal(result.draftHash,policy.hash(value.draft));assert.equal(result.records[0].sp,1.8);assert.equal(result.records[1].sp,1.92);
 assert.equal(result.records[1].market,'HHAD');assert.equal(result.records[1].selection,'a');assert.equal(result.records[1].handicap,-1);
 for(const record of result.records){assert.equal(record.comboEligible,true);assert.equal(record.research.lineupsConfirmed,false);assert.equal(record.modelProbability,null);assert.equal(record.expectedValue,null);}
 assert.equal(result.records[0].marketBaseline.kind,'normalized-inverse-sp');assert.equal(result.records[0].marketBaseline.handicap,null);assert.equal(result.records[1].marketBaseline.handicap,-1);
 const baseline=result.records[1].marketBaseline.probabilities;assert.ok(Math.abs(baseline.h+baseline.d+baseline.a-1)<1e-12);assert.ok(Math.abs(baseline.a-(1/1.92)/(1/3.15+1/3.25+1/1.92))<1e-12);
 assert.deepEqual(policy.make(value.draft,value.context),result);assert.equal(policy.validateDraft(value.draft,value.context.asOf),true);
});
for(const [name,change] of [
 ['SP as direction input',choice=>{choice.sp=2.86;}],
 ['market q as model p',choice=>{choice.modelProbability=.7;}],
 ['invented EV',choice=>{choice.expectedValue=.1;}],
 ['incompatible HAD score',choice=>{choice.scores=[[0,1],[2,1]];}],
 ['duplicate scores',choice=>{choice.scores=[[2,0],[2,0]];}],
 ['fractional handicap',choice=>{choice.market='HHAD';choice.handicap=-.5;}],
 ['invented evidence',choice=>{choice.basisIds=['not-in-packet'];}],
])test('direction fails closed for '+name,()=>{
 const value=fixture.setup(),choice=structuredClone(value.directions[0].choice);change(choice);
 assert.throws(()=>decision.choose(value.packets[0],choice,fixture.stamp(fixture.NOW-3000)));
});
test('missing injury evidence permits an honestly limited single but never a parlay leg',()=>{
 const value=fixture.setup(),input=value.inputs[0];input.observations=input.observations.filter(item=>item.kind!=='availability');
 const packet=evidence.create(input),chosen=decision.choose(packet,value.directions[0].choice,fixture.stamp(fixture.NOW-3000));
 assert.equal(chosen.confidence,'低');assert.equal(chosen.comboEligible,false);assert.ok(chosen.limitations.some(item=>item.includes('availability:home')));
});
test('availability crossing its age boundary downgrades the live record without changing the frozen direction',()=>{
 const value=fixture.setup();
 for(const source of value.inputs[0].sources)source.publishedAt=fixture.stamp(fixture.NOW-3*86400000-1000);
 fixture.rebuildRaw(value.inputs[0]);value.packets[0]=evidence.create(value.inputs[0]);
 value.directions[0]=decision.choose(value.packets[0],value.directions[0].choice,fixture.stamp(fixture.NOW-3000));
 assert.equal(value.directions[0].confidence,'中');assert.equal(value.directions[0].comboEligible,true);
 const original=JSON.stringify(value.directions[0]),draft=decision.prepare({directions:value.directions,evidence:value.packets},value.context);
 const result=decision.make(draft,{...value.context,evidenceByEvent:Object.fromEntries(value.packets.map(packet=>[packet.event.eventId,[packet]]))});
 assert.equal(result.records[0].confidence,'低');assert.equal(result.records[0].comboEligible,false);assert.equal(result.records[0].research.availabilityComplete,false);
 assert.equal(result.records[0].selection,value.directions[0].choice.selection);assert.equal(JSON.stringify(value.directions[0]),original);
 assert.ok(combos.combinations(result.records,2,value.context.asOf).every(combo=>combo.legs.length===0));
});
test('HHAD home minus one let-loss supports real loss or draw, not a two-goal home win',()=>{
 const value=fixture.setup(),choice=structuredClone(value.directions[1].choice);choice.scores=[[1,2],[2,2]];
 assert.equal(decision.choose(value.packets[1],choice,fixture.stamp(fixture.NOW-3000)).choice.selection,'a');choice.scores=[[2,0],[2,2]];
 assert.throws(()=>decision.choose(value.packets[1],choice,fixture.stamp(fixture.NOW-3000)),/SCORES/);
});
for(const [name,change] of [
 ['closed sale',value=>{for(const endpoint of value.context.snapshot.endpoints){endpoint.payload.value.matchInfoList[0].subMatchList[0].sellStatus=0;official.resign(endpoint,value.context.pair);}}],
 ['awaiting price',value=>{for(const endpoint of value.context.snapshot.endpoints){endpoint.payload.value.matchInfoList[0].subMatchList[0].oddsList[0].h=null;official.resign(endpoint,value.context.pair);}}],
 ['signature tamper',value=>{value.context.snapshot.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].oddsList[0].h=2;}],
 ['stale signed source',value=>{value.context.asOf=fixture.stamp(fixture.NOW+31000);}],
 ['missing persisted evidence',value=>{value.context.evidenceByEvent={};}],
 ['line mismatch',value=>{for(const endpoint of value.context.snapshot.endpoints){endpoint.payload.value.matchInfoList[0].subMatchList[1].oddsList[1].goalLine='1';official.resign(endpoint,value.context.pair);}}],
 ['postkickoff publication',value=>{value.context.asOf=value.draft.singles[0].kickoff;}],
 ['replaced frozen direction',value=>{value.draft.research.directions[0].choice.selection='a';}],
])test('publication rejects '+name,()=>{const value=prepared();change(value);assert.throws(()=>decision.make(value.draft,value.context));});
test('a fresh-looking source fetched before the direction cannot price that decision',()=>{
 const value=fixture.setup();value.directions=value.packets.map((packet,index)=>decision.choose(packet,value.directions[index].choice,fixture.stamp(fixture.NOW-500)));
 assert.throws(()=>decision.prepare({directions:value.directions,evidence:value.packets},value.context),/QUOTE_PRECEDES_DIRECTION/);
});
test('no quote still permits a research direction, not a publishable draft',()=>{
 const value=fixture.setup();assert.equal(value.directions.length,2);
 assert.throws(()=>decision.prepare({directions:value.directions,evidence:value.packets},{...value.context,snapshot:{endpoints:[]}}),/CURRENT/);
});
test('v5 combinations preserve exact frozen directions/prices and leave unmet bands empty',()=>{
 const value=prepared(),records=decision.make(value.draft,value.context).records;
 const result=combos.combinations(records,2,value.context.asOf);assert.equal(result[0].product,3.456);assert.equal(result[0].legs[1].selection,'a');
 assert.equal(result[0].legs[1].handicap,-1);assert.equal(result[1].product,null);assert.equal(result[2].product,null);
 assert.equal(result[0].expectedValue,null);assert.ok(result[0].legs.every(leg=>leg.singleHash.length===64));
 assert.deepEqual(policy.combinations(records,2,value.context.asOf),result);
});
test('weak, explicitly excluded, closed and legacy legs never enter the new strategy combinations',()=>{
 for(const change of [record=>{record.confidence='低';},record=>{record.comboEligible=false;},record=>{delete record.strategy;},record=>{record.cutoffAt=fixture.stamp(fixture.NOW);}]){
  const value=prepared(),records=decision.make(value.draft,value.context).records;change(records[0]);
  assert.ok(combos.combinations(records,2,value.context.asOf).every(combo=>combo.legs.length===0));
 }
});
test('combination requires a real observation clock and rejects duplicate events',()=>{
 const value=prepared(),records=decision.make(value.draft,value.context).records;
 assert.throws(()=>combos.combinations(records,2),/INPUT/);assert.throws(()=>combos.combinations([records[0],records[0]],2,value.context.asOf),/DUPLICATE_EVENT/);
});
test('original v4 deterministic replay remains unchanged and uses no research package',()=>{
 const value=official.setup(),first=policy.make(value.draft,value),second=policy.make(structuredClone(value.draft),value);
 assert.deepEqual(first,second);assert.equal(first.records[0].research,undefined);assert.equal(first.records[0].comboEligible,undefined);
});
module.exports={prepared};
