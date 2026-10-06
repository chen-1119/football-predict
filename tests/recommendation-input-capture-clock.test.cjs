'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {NOW,match,memoryPorts,validators}=require('./recommendationFixture.cjs');
const stamp=v=>new Date(v).toISOString();
const capture=(startedAt,knownAt)=>({version:'current-input-capture-v1',startedAt:stamp(startedAt),capturedAt:stamp(knownAt),
  currentHash:'a'.repeat(64),marketSignalHash:'b'.repeat(64),joinedInputHash:'c'.repeat(64),officialHandicap:{
    version:'official-handicap-input-audit-v1',asOf:stamp(knownAt),snapshotHash:null,status:'source-unavailable',
    endpoints:{calculator:{reason:'endpoint-missing-or-ambiguous'},current:{reason:'endpoint-missing-or-ambiguous'}},reasonCounts:{},samples:[]}});

function delayedInput({delay=1000,quoteOffset=0,cutoff=NOW+60000,captureOffset=0}={}){
  const p=memoryPorts(),transaction=p.transaction.bind(p);
  p.transaction=(lane,action)=>transaction(lane,repo=>{
    repo.currentInputs=async startedAt=>{
      p.now+=delay;
      const quoteAt=p.now+quoteOffset;
      return {current:[match(1,NOW,{buyEndTime:stamp(cutoff),oddsUpdatedAt:stamp(quoteAt)})],
        receiptHashes:new Set(),inputKnowledgeAt:stamp(p.now+captureOffset),
        inputCapture:capture(startedAt,p.now)};
    };
    return action(repo);
  });
  return {p,r:createRuntime(p,{validators})};
}

test('quote acquired during awaited input reads uses the real later decision clock',async()=>{
  const {p,r}=delayedInput();
  const result=await r.publish();
  assert.equal(result.ok,true);
  assert.equal(p.state.decisions.length,1);
  assert.equal(p.state.decisions[0].publishedAt,stamp(NOW+1000));
  assert.equal(p.state.decisions[0].quoteObservedAt,stamp(NOW+1000));
  assert.equal(p.state.lanes.publish.inputCapture.capturedAt,stamp(NOW+1000));
  assert.equal(p.state.decisions[0].inputCapture.capturedAt,stamp(NOW+1000));
  assert.equal(require('../scripts/recommendationPlatform/decision.cjs').validDecision(p.state.decisions[0]),true);
});

test('rechecking the later clock rejects an input whose sales cutoff crossed during reads',async()=>{
  const {p,r}=delayedInput({delay:2000,cutoff:NOW+1000});
  await r.publish();
  assert.equal(p.state.decisions.length,0);
});

test('a genuinely future quote is still rejected at the actual completed clock',async()=>{
  const {p,r}=delayedInput({quoteOffset:1});
  await r.publish();
  assert.equal(p.state.decisions.length,0);
});

test('claimed future input capture fails closed instead of advancing to its timestamp',async()=>{
  const {p,r}=delayedInput({captureOffset:1});
  const result=await r.publish();
  assert.equal(result.ok,false);
  assert.equal(result.errorCode,'INPUT_CAPTURE_CLOCK_INVALID');
  assert.equal(p.state.decisions.length,0);
});

test('a clock regression aborts the publication transaction',async()=>{
  const {p,r}=delayedInput({delay:-1});
  const result=await r.publish();
  assert.equal(result.ok,false);
  assert.equal(result.errorCode,'INPUT_CAPTURE_CLOCK_INVALID');
  assert.equal(p.state.decisions.length,0);
});
