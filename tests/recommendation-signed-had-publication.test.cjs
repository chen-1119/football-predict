'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Repository}=require('../scripts/recommendationPlatform/repository.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {evaluateForecast,buildRecord,verifyRecord,hash}=require('../src/services/publishedForecastPolicy.cjs');
const {validInputCapture}=require('../scripts/recommendationPlatform/inputCapture.cjs');
const {publication,memoryPorts}=require('./recommendationFixture.cjs');
const {source,snapshot,stamp,NOW}=require('./fixtures/signed-live-had.cjs');
async function capture(rows=[source()],options={}){
  const s=snapshot(rows,options);const client={query:async sql=>{
    if(sql.includes('match_snapshots'))return {rows:rows.map(payload=>({payload}))};
    if(sql.includes('market_latest'))return {rows:[]};throw Error('Unexpected SQL');
  }};
  const repo=new Repository(client,{clock:()=>NOW,readOfficialSnapshot:()=>s.snapshot,trustRegistry:s.registry});
  return {...s,repo,inputs:await repo.currentInputs(NOW),rows};
}
test('actual Repository to normal runtime publishes signed fresh HAD with a still-valid old model and old generation',async()=>{
  const c=await capture();const before=hash(c.rows),ports=memoryPorts(),transaction=ports.transaction;
  ports.transaction=(lane,action)=>transaction(lane,repo=>{
    repo.currentInputs=n=>c.repo.currentInputs(n);repo.trustRegistry=c.registry;
    repo.publication=async()=>publication(NOW-30*60000);return action(repo);
  });
  const result=await createRuntime(ports).publish();assert.equal(result.ok,true);assert.equal(result.value.decisionIds.length,1);
  const d=ports.state.decisions[0];assert.ok(validDecision(d,{trustRegistry:c.registry}));
  assert.equal(d.quoteObservedAt,stamp(NOW-1000));assert.equal(d.modelGeneratedAt,stamp(NOW-30*60000));
  assert.equal(d.publication.generationId,'generation-test');assert.equal(d.sourceVerification,'trusted-collector-signed-live-had');
  assert.equal(d.inputCapture.version,'current-input-capture-v2');assert.ok(validInputCapture(d.inputCapture,d.publishedAt));
  assert.equal(result.value.quotePublicationLatency.rows[0].publicationLagMs,1000);assert.equal(hash(c.rows),before);
});
test('stale-generation gate still rejects a label-only quote, expired signature and an expired model',async()=>{
  for(const c of [await capture([source()],{receivedAt:NOW-16*60000}),await capture([source(1,NOW-4*3600000)])]){
    const ports=memoryPorts(),transaction=ports.transaction;
    ports.transaction=(lane,action)=>transaction(lane,repo=>{repo.currentInputs=async()=>c.inputs;repo.trustRegistry=c.registry;
      repo.publication=async()=>publication(NOW-30*60000);return action(repo);});
    const r=await createRuntime(ports).publish();assert.equal(r.ok,false);assert.equal(r.errorCode,'SOURCE_STALE');assert.equal(ports.state.decisions.length,0);
  }
});
test('signed negative sale observation rejects even a fresh PG SP and leaves the frozen parent untouched',async()=>{
  const m=source();m.oddsReceivedAt=stamp(NOW-2000);const frozen=hash(m);
  const c=await capture([m],{mutate:e=>{const r=e.payload.value.matchInfoList[0].subMatchList[0];r.matchStatus='Define';r.sellStatus='';r.poolList[0].poolStatus='OddsIn';}});
  assert.equal(c.inputs.inputCapture.officialHad.reasonCounts['event-not-selling'],1);assert.equal(c.inputs.receiptHashes.size,0);
  assert.equal(makeDecision(c.inputs.current[0],{now:NOW,publication:publication(NOW),trustRegistry:c.registry}).reason,'not-on-sale');
  assert.equal(hash(m),frozen);
});
test('reserved signed-live labels without valid receipts cannot fall back to the legacy source-label gate',()=>{
  for(const label of ['sporttery:HAD:signed-live','SPORTTERY:HAD:SIGNED-LIVE','sporttery:HAD:signed-live:replay']){
    const m={...source(),oddsSource:label,oddsReceivedAt:stamp(NOW)};
    assert.equal(evaluateForecast(m,{now:NOW,publication:publication(NOW)}).reason,'official-had-quote-unavailable');
  }
});
test('replay verifies source bytes and binds the signed receipt to the actual HAD input hash',async()=>{
  const c=await capture(),context={now:NOW,publication:publication(NOW),inputCapture:c.inputs.inputCapture,trustRegistry:c.registry};
  const d=makeDecision(c.inputs.current[0],context).decision;assert.ok(d&&validDecision(d,{trustRegistry:c.registry}));
  const forged=structuredClone(d);forged.hadInputHash='a'.repeat(64);
  const {recordHash,...body}=forged;forged.recordHash=hash(body);assert.equal(validDecision(forged,{trustRegistry:c.registry}),false);
  const price=structuredClone(d);price.quoteProvenance.endpoint.payload.value.matchInfoList[0].subMatchList[0].oddsList[0].h='2.01';
  const {receiptHash,...receipt}=price.quoteProvenance;price.quoteProvenance.receiptHash=hash(receipt);
  const {recordHash:r,...b}=price;price.recordHash=hash(b);assert.equal(validDecision(price,{trustRegistry:c.registry}),false);
  const candidate=evaluateForecast(c.inputs.current[0],context).candidate,record=buildRecord(candidate,NOW);
  assert.ok(verifyRecord(record,{trustRegistry:c.registry}));const bad=structuredClone(record);
  bad.quoteProvenance.identity.homeTeamId='other';const {receiptHash:rh,...rp}=bad.quoteProvenance;bad.quoteProvenance.receiptHash=hash(rp);
  const {recordHash:rr,...rb}=bad;bad.recordHash=hash(rb);assert.equal(verifyRecord(bad,{trustRegistry:c.registry}),false);
});
