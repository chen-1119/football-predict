'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const lane=require('../scripts/sportteryFastResultLane.cjs');
const {initialEndpointDefinitions}=require('../scripts/collectSportterySnapshot.cjs');
const before='2026-10-08T02:59:59.999Z',open='2026-10-08T03:00:00.000Z';
const endpoint=(method,clock=open)=>({id:method,method,page:method==='result'?1:null,ok:true,rows:1,
  requestedAt:clock,receivedAt:clock,fetchedAt:clock,sourceCycleId:'synthetic-'+method,
  payload:{value:{matchInfoList:[{businessDate:'2026-10-08',subMatchList:[{matchId:'opening-fixture',matchStatus:'11',sectionsNo999:'1:0'}]}]}}});
const snapshot=clock=>({endpoints:['current','calculator'].map(m=>endpoint(m,clock)),maxAgeMinutes:20});
test('daily opening is a once-per-day collection trigger independent of result changes',()=>{
  assert.equal(lane.fastLaneOpeningState({nowMs:Date.parse(before)}).openingDue,false);
  assert.equal(lane.fastLaneOpeningState({nowMs:Date.parse(open)}).openingDue,true);
  assert.equal(lane.fastLaneOpeningState({nowMs:Date.parse(open),lastConfirmedBusinessDate:'2026-10-08'}).openingDue,false);
  assert.equal(lane.fastLaneOpeningState({nowMs:Date.parse('2026-10-09T03:00:00Z'),lastConfirmedBusinessDate:'2026-10-08'}).openingDue,true);
  const d=lane.fastLanePublishDecision({fingerprint:'same',lastUploadedResultFingerprint:'same',lastUploadOkAt:open,
    openingDue:true,nowMs:Date.parse(open)});
  assert.equal(d.publish,true);assert.equal(d.currentHeartbeatDue,false);assert.equal(d.reason,'daily-market-opening');
});
test('only original fresh post-opening clocks can mark a successful opening collection',()=>{
  assert.equal(lane.confirmedFastLaneOpeningDate({snapshot:snapshot(open),nowMs:Date.parse(open)}),'2026-10-08');
  const crossing=snapshot(open);crossing.endpoints[0].requestedAt=before;
  assert.equal(lane.confirmedFastLaneOpeningDate({snapshot:crossing,nowMs:Date.parse(open)}),null);
  const clockless=snapshot(open);delete clockless.endpoints[1].requestedAt;
  assert.equal(lane.confirmedFastLaneOpeningDate({snapshot:clockless,nowMs:Date.parse(open)}),null);
  assert.equal(lane.confirmedFastLaneOpeningDate({snapshot:snapshot(open),nowMs:Date.parse(open)+900001}),null);
  assert.equal(lane.confirmedFastLaneOpeningDate({snapshot:snapshot(open),nowMs:Date.parse(before)}),null);
  const future=snapshot('2026-10-08T03:00:01Z');
  assert.equal(lane.confirmedFastLaneOpeningDate({snapshot:future,nowMs:Date.parse(open)}),null);
});
test('schedule mode keeps the signed current body and skips only calculator collection',()=>{
  assert.deepEqual(initialEndpointDefinitions({methodsInput:'schedule-only'}).map(e=>e.method),['current']);
  assert.deepEqual(initialEndpointDefinitions({methodsInput:'none'}).map(e=>e.method),['calculator','current']);
  assert.deepEqual(initialEndpointDefinitions({methodsInput:'schedule-only',skipInitial:true}),[]);
  const current=endpoint('current',before),probe=endpoint('result',before);
  const merged=lane.createFastUploadSnapshot({probeSnapshot:{endpoints:[probe]},companionSnapshot:{endpoints:[current]},fingerprint:'fixture',now:before});
  assert.deepEqual(merged.endpoints.map(e=>e.method),['current','result']);
  assert.strictEqual(merged.endpoints[0].payload,current.payload);
  assert.equal(merged.endpoints[0].requestedAt,before);assert.equal(merged.producer.companionMode,'schedule-current-on-change');
});
function isolatedCycle(clock,{waf=false,uploadFails=false,companionClock=clock}={}){
  const file=path.resolve(__dirname,'../scripts/runSportteryFastResultLane.cjs'),localRequire=createRequire(file);
  const calls=[],result={endpoints:[endpoint('result',clock)]};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return Date.parse(clock);}}
  const mock={...lane,writeJsonAtomic(){},cleanupFiles:async()=>{},
    async runCollector(o){calls.push(o.methods);if(o.skipInitial){if(waf)throw Error('HTTP 567 official-waf');return result;}
      return {endpoints:(o.methods==='schedule-only'?['current']:['current','calculator']).map(m=>endpoint(m,companionClock))};},
    async postSnapshot(o){calls.push('upload');if(uploadFails)throw Error('remote-upload-rejected');return {status:200};}};
  function requireMock(name){if(name==='./sportteryFastResultLane.cjs')return mock;
    if(name==='./syncCloudflareSportteryEvidence.cjs')return {run:async()=>{throw Error('unexpected cloud collection');}};
    return localRequire(name);}
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:requireMock,module,exports:module.exports,__dirname:path.dirname(file),
    Date:Clock,process:{argv:['node',file,'--once'],env:{SPORTTERY_FAST_RESULT_PUSH_BASE_URL:'http://127.0.0.1:1',
      SPORTTERY_FAST_RESULT_ADMIN_TOKEN:'synthetic-only'},pid:9876},setTimeout,clearTimeout,Buffer});
  const fingerprint=lane.resultFingerprint(result.endpoints[0]);
  return {calls,run:previous=>module.exports.runCycle({lastObservedResultFingerprint:fingerprint,lastUploadedResultFingerprint:fingerprint,
    lastUploadOkAt:clock,...previous})};
}
test('real runCycle queues opening refresh even with an unchanged result and recent heartbeat',async()=>{
  const fixture=isolatedCycle(open),r=await fixture.run({});
  assert.deepEqual(fixture.calls,['result','none','upload']);assert.equal(r.uploaded,true);
  assert.equal(r.state.lastConfirmedOpeningBusinessDate,'2026-10-08');
  const second=isolatedCycle(open),s=await second.run({lastConfirmedOpeningBusinessDate:'2026-10-08'});
  assert.deepEqual(second.calls,['result']);assert.equal(s.status,'unchanged');
});
test('before opening result changes still upload alongside schedule-only current',async()=>{
  const fixture=isolatedCycle(before),r=await fixture.run({lastUploadedResultFingerprint:'old'});
  assert.deepEqual(fixture.calls,['result','schedule-only','upload']);assert.equal(r.uploaded,true);
  assert.equal(r.state.lastConfirmedOpeningBusinessDate,undefined);
});
test('WAF fallback uses opening trigger without bypassing normal result failure backoff',async()=>{
  const fixture=isolatedCycle(open,{waf:true}),r=await fixture.run({});
  assert.deepEqual(fixture.calls,['result','none','upload']);assert.equal(r.ok,false);
  assert.equal(r.state.consecutiveFailures,1);assert.ok(r.delayMs>=30000);
  assert.equal(r.state.lastConfirmedOpeningBusinessDate,'2026-10-08');
});
test('failed upload or a pre-opening acquisition does not consume the first price cycle',async()=>{
  const rejected=isolatedCycle(open,{uploadFails:true}),r=await rejected.run({});
  assert.equal(r.ok,false);assert.equal(r.state.lastConfirmedOpeningBusinessDate,undefined);
  const crossing=isolatedCycle(open,{companionClock:before}),s=await crossing.run({});
  assert.equal(s.uploaded,true);assert.equal(s.state.lastConfirmedOpeningBusinessDate,undefined);
});
