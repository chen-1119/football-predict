'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalizeRows}=require('../collectors/market/policy.cjs');
const {projectSignalRows}=require('../collectors/market/signalBridge.cjs');
const {joinCurrentMarket}=require('../scripts/recommendationPlatform/currentInputs.cjs');
const {evaluateCurrent}=require('../scripts/recommendationPlatform/decision.cjs');
const {attachProspectiveForecastInputs}=require('../src/services/prospectiveForecastInput.cjs');
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {NOW,match,publication,memoryPorts,validators}=require('./recommendationFixture.cjs');
const stamp=ms=>new Date(ms).toISOString();
test('normal acquisition leaves renewal headroom inside quote TTL even with maximum jitter',()=>{
  const p=require('../collectors/market/policy.cjs'),cfg=p.config({});
  const seconds=p.adaptivePollSeconds([{kickoffTime:stamp(NOW+12*3600000)}],NOW,cfg);
  assert.ok(p.jitteredDelayMs(seconds,()=>1,cfg)+30000+60000<15*60000);
  assert.ok(p.failureDelaySeconds({code:'SOURCE_BLOCKED'},1)>=6*3600);
});
function signals(now=NOW){return [1,2,3].flatMap(id=>{
  const m=match(id),p=normalizeRows([{keys:[String(id)],signal:{source:'500.com:jczq',sourceMatchId:String(id),homeTeamName:m.homeTeamName,awayTeamName:m.awayTeamName,kickoffTime:m.kickoffTime,buyEndTime:'2026-09-17T14:00:00Z',bookmakerOdds:{had:m.odds}}}],stamp(now)).markets[0];
  return projectSignalRows([{payload:p.payload,content_hash:p.contentHash,latest_content_hash:p.contentHash,observation_id:`o-${id}`,first_seen_at:stamp(NOW),last_seen_at:stamp(now),updated_at:stamp(now),acquisition:{run_id:`run-${id}`,source:'500.com:jczq',status:'completed',started_at:stamp(NOW-1000),finished_at:stamp(NOW+1000),source_sha256:'b'.repeat(64),payload:{url:'https://trade.500.com/jczq/'}}}]);
});}
const rows=()=>[1,2,3].map(id=>attachProspectiveForecastInputs([match(id,NOW-86400000)],[match(id)],NOW)[0]);
const assess=(current,now)=>evaluateCurrent(current,{now,publication:publication(NOW)});
function livePorts(){const p=memoryPorts(),original=p.transaction.bind(p);p.current=rows();p.transaction=(lane,fn)=>original(lane,repo=>{
  repo.publication=async()=>publication(NOW);
  repo.currentInputs=async now=>joinCurrentMarket(await repo.current(),signals(p.quoteNow??p.now),now);
  return fn(repo);
});return p;}
test('warehouse refresh fixes expired embedded SP without editing the model or frozen parent',()=>{
  const current=rows(),before=structuredClone(current),now=NOW+20*60000;
  assert.equal(assess(current,now).decisions.length,0);
  const joined=joinCurrentMarket(current,signals(now),now),a=assess(joined.current,now);
  assert.equal(a.decisions.length,3);assert.deepEqual(current,before);
  assert.ok(a.decisions.every(d=>d.modelGeneratedAt===stamp(NOW)&&d.quoteObservedAt===stamp(now)&&joined.receiptHashes.has(d.quoteProvenance.receiptHash)));
});
test('invalid prospective identities and absent current models cannot borrow a frozen model',()=>{
  for(const patch of [null,{...match(),awayTeamId:'changed'}]){
    const current=rows().map(r=>({...r,prospectiveForecastInput:patch}));
    assert.equal(joinCurrentMarket(current,signals(),NOW).receiptHashes.size,0);
  }
});
test('event changes, opposite team names, duplicate source records and forged receipt fail binding',()=>{
  const changes=[s=>s.push(structuredClone(s[0])),s=>{s[0].signal.bookmakerOdds.had.lotterySpReceipt.receiptHash='x';},s=>{s[0].signal.bookmakerOdds.had.odds1=9;}];
  for(const change of changes){const s=signals();change(s);assert.equal(joinCurrentMarket([rows()[0]],s,NOW).receiptHashes.size,0);}
  for(const patch of [{kickoffTime:'2026-09-17T16:00:00Z',eventVersion:'2026-09-17T16:00:00Z'},{homeTeamName:'other'}]){
    const r={...match(),...patch};assert.equal(joinCurrentMarket([r],signals(),NOW).receiptHashes.size,0);
  }
});
test('fresh quotes do not override suspension, cutoff or stale model',()=>{
  for(const patch of [{saleStatus:'SUSPENDED'},{isOnSale:false},{status:'LIVE'},{buyEndTime:stamp(NOW)}]){
    const r={...match(),...patch};assert.equal(assess(joinCurrentMarket([r],signals(),NOW).current,NOW).decisions.length,0);
  }
  const now=NOW+4*3600000;
  assert.equal(assess(joinCurrentMarket([match()],signals(now),now).current,now).decisions.length,0);
});
test('missing, future and expired warehouse observations cannot advance the input clock',()=>{
  for(const [s,now] of [[[],NOW],[signals(NOW+1000),NOW],[signals(),NOW+16*60000]])assert.equal(joinCurrentMarket(rows(),s,now).receiptHashes.size,0);
});
test('both combos remain available across quote refreshes without a new base generation',async()=>{
  const p=livePorts(),r=createRuntime(p,{validators});p.now=NOW+20*60000;
  await r.publishingCycle();const saved=structuredClone(p.state.decisions);
  assert.deepEqual(p.state.view.previews.map(c=>c.size),[2,3]);
  assert.equal(p.state.lanes.combos.basePublicationAsOf,stamp(NOW));assert.equal(p.state.lanes.combos.inputAsOf,stamp(p.now));
  p.now+=16*60000;await r.publishingCycle();
  assert.deepEqual(p.state.view.previews.map(c=>c.size),[2,3]);assert.equal(p.state.decisions.length,6);
  assert.deepEqual(p.state.decisions.slice(0,3),saved);
  assert.ok(p.state.view.previews.every(c=>c.legs.every(d=>d.modelGeneratedAt===stamp(NOW)&&d.quoteObservedAt===stamp(p.now))));
});
test('collector outage eventually clears expired previews instead of refreshing old quotes',async()=>{
  const p=livePorts(),r=createRuntime(p,{validators});p.now=NOW+20*60000;p.quoteNow=p.now;
  await r.publishingCycle();assert.equal(p.state.view.previews.length,2);
  p.now+=16*60000;await r.publishingCycle();assert.equal(p.state.view.previews.length,0);assert.equal(p.state.lanes.combos.status,'error');
});
