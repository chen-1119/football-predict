'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const opening=require('../src/services/sportteryOpeningPolicy.cjs');
const DAY='2026-09-17',OPEN=DAY+'T03:00:00.000Z';
test('the reviewed business date maps to Beijing 11 rather than fixture kickoff date',()=>{
  assert.equal(opening.openingAtForBusinessDate(DAY),OPEN);
  for(const date of ['2026-02-30','2026-13-01','2026-9-17',null,0])assert.equal(opening.openingAtForBusinessDate(date),null);
});
test('10:59 and one nanosecond before opening wait; the exact opening instant passes',()=>{
  for(const at of [DAY+'T02:59:00Z',DAY+'T02:59:59.999999999Z'])assert.equal(opening.assessOpening({businessDate:DAY,asOf:at}).reason,'opening-not-reached');
  for(const at of [OPEN,DAY+'T11:00:00+08:00',DAY+'T03:00:00.000000001Z'])assert.equal(opening.assessOpening({businessDate:DAY,asOf:at}).eligible,true);
});
test('a request crossing opening is rejected even when received at or after 11',()=>{
  assert.equal(opening.assessQuoteOpening({businessDate:DAY,asOf:DAY+'T03:01:00Z',requestedAt:DAY+'T02:59:59.999999999Z',receivedAt:OPEN}).reason,'quote-acquired-before-opening');
});
test('fresh request and receipt at opening qualify; uploaded early cached bytes do not',()=>{
  assert.equal(opening.assessQuoteOpening({businessDate:DAY,asOf:OPEN,requestedAt:OPEN,receivedAt:OPEN}).eligible,true);
  assert.equal(opening.assessQuoteOpening({businessDate:DAY,asOf:DAY+'T03:04:00Z',requestedAt:DAY+'T02:59:00Z',receivedAt:DAY+'T02:59:02Z',uploadedAt:DAY+'T03:03:00Z'}).eligible,false);
});
test('missing, malformed, regressing and one-nanosecond future acquisition clocks fail closed',()=>{
  for(const [requestedAt,receivedAt] of [[null,OPEN],[OPEN,null],['2026-02-30T03:00:00Z',OPEN],
    [DAY+'T03:00:00.000000001Z',OPEN],[OPEN,DAY+'T03:00:00.000000001Z']]){
    assert.equal(opening.assessQuoteOpening({businessDate:DAY,asOf:OPEN,requestedAt,receivedAt}).reason,'opening-clock-invalid');
  }
});
test('HHAD paper acquisition requires both of its signed-source clocks, independently of HAD',()=>{
  const fresh={requestedAt:OPEN,receivedAt:OPEN};
  const record={event:{businessDate:DAY},decisionAt:OPEN,markets:{HHAD:{quote:fresh}},privateInputs:{quoteSnapshot:{endpoints:[
    {method:'current',page:null,...fresh},{method:'calculator',page:null,...fresh}]}}};
  assert.equal(opening.assessPaperOpening(record,OPEN).eligible,true);
  record.privateInputs.quoteSnapshot.endpoints[0].requestedAt=DAY+'T02:59:59Z';
  assert.equal(opening.assessPaperOpening(record,OPEN).reason,'quote-acquired-before-opening');
  record.privateInputs.quoteSnapshot.endpoints=[];
  assert.equal(opening.assessPaperOpening(record,OPEN).reason,'opening-clock-invalid');
});
const {createRuntime}=require('../scripts/recommendationPlatform/runtime.cjs');
const {memoryPorts,publication}=require('./recommendationFixture.cjs');
const {source,snapshot}=require('./fixtures/signed-live-had.cjs');
const {joinOfficialHad}=require('../scripts/recommendationPlatform/liveOfficialHad.cjs');
const {joinOfficialHandicap}=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
async function runtimeAt(now,{requestedAt=now,receivedAt=now,suspended=false,withHHAD=false,calculatorRequestedAt=now}={}){
  const m=source(1,now-1000);m.oddsReceivedAt=new Date(now-1000).toISOString();m.oddsUpdatedAt=m.oddsReceivedAt;
  const signed=snapshot([m],{requestedAt,receivedAt,mutate:e=>{
    if(suspended)e.payload.value.matchInfoList[0].subMatchList[0].sellStatus=2;
  }}),ports=memoryPorts(),transaction=ports.transaction;ports.now=now;
  if(withHHAD){
    m.probabilityModel.calculationTrace={poisson:{lambdas:{home:1.8,away:1.2}}};
    const e=structuredClone(signed.snapshot.endpoints[0]),{SPORTTERY_CALCULATOR_URL}=require('../scripts/sportteryEndpointContract.cjs');
    e.method='calculator';e.url=SPORTTERY_CALCULATOR_URL;e.sourceRequest={method:'GET',url:e.url,page:null,role:'calculator'};
    e.requestedAt=new Date(calculatorRequestedAt).toISOString();
    const row=e.payload.value.matchInfoList[0].subMatchList[0];
    row.oddsList.push({poolCode:'HHAD',h:2.1,d:3.8,a:2.6,goalLine:'-1'});
    row.poolList.push({poolCode:'HHAD',poolStatus:'Selling',cbtValue:1,cbtAllUp:1,bettingAllup:1});
    const {buildCollectorCommitment,signCollectorCommitment,sha256CollectorJson}=require('../src/services/collectorAttestation.cjs');
    e.canonicalPayloadSha256=sha256CollectorJson(e.payload);
    const commitment=buildCollectorCommitment({endpoint:e.sourceRequest,collectorCycleId:e.sourceCycleId,requestedAt:e.requestedAt,receivedAt:e.receivedAt,
      response:{httpStatus:e.httpStatus,contentType:e.contentType,rawSha256:e.rawSha256,rawBytes:e.rawBytes,headersSha256:e.headersSha256},payload:e.payload,canonicalPayloadSha256:e.canonicalPayloadSha256});
    e.collectorAttestation=signCollectorCommitment(commitment,{keyId:signed.pair.keyId,privateKeyPem:signed.pair.privateKeyPem});
    signed.snapshot.endpoints.push(e);
  }
  ports.transaction=(lane,action)=>transaction(lane,repo=>{
    repo.trustRegistry=signed.registry;repo.publication=async()=>publication(now-1000);
    repo.currentInputs=async startedAt=>{
      const hh={},had={},first=joinOfficialHandicap([m],signed.snapshot,{now,trustRegistry:signed.registry,audit:hh});
      const joined=joinOfficialHad(first,signed.snapshot,{now,trustRegistry:signed.registry,audit:had});
      const next=opening.filterNewOpeningMarkets(joined.current,signed.snapshot,{asOf:new Date(now).toISOString(),trustRegistry:signed.registry});
      return {...joined,current:next,inputKnowledgeAt:new Date(now).toISOString(),inputCapture:{version:'current-input-capture-v2',
        startedAt:new Date(startedAt).toISOString(),capturedAt:new Date(now).toISOString(),currentHash:hash([m]),marketSignalHash:hash(signed.snapshot),
        joinedInputHash:hash(next),officialHad:had,officialHandicap:hh}};
    };return action(repo);
  });
  return {ports,runtime:createRuntime(ports)};
}
test('publish and combo lanes before 11 record explicit waiting without source-stale or new decisions',async()=>{
  const {ports,runtime}=await runtimeAt(Date.parse(OPEN)-1);
  const p=await runtime.publish(),c=await runtime.combos();
  assert.equal(p.ok,true);assert.equal(c.ok,true);assert.equal(p.value.openingStatus.reason,'opening-not-reached');
  assert.equal(c.value.openingStatus.status,'waiting-opening');assert.equal(ports.state.decisions.length,0);assert.equal(ports.state.combos.length,0);
  assert.equal(ports.calls.some(([method])=>method==='current'),false);
});
test('normal signed HAD at exact opening publishes without changing existing receipt versions',async()=>{
  const {ports,runtime}=await runtimeAt(Date.parse(OPEN));const p=await runtime.publish();
  assert.equal(p.ok,true);assert.equal(ports.state.decisions.length,1);
  assert.equal(ports.state.decisions[0].quoteProvenance.version,'signed-live-had-receipt-v2');
});
test('a signed pre-opening request cannot publish at 11 although its receipt arrives after opening',async()=>{
  const now=Date.parse(OPEN)+1000,{ports,runtime}=await runtimeAt(now,{requestedAt:Date.parse(OPEN)-1});
  const p=await runtime.publish();assert.equal(p.ok,true);assert.equal(ports.state.decisions.length,0);
  assert.equal(p.value.openingStatus.status,'waiting-opening-quotes');
  assert(ports.state.issues.some(i=>i.reason==='quote-acquired-before-opening'));
});
test('after 11 genuine provider suspension still blocks even with fresh signed numeric SPs',async()=>{
  const {ports,runtime}=await runtimeAt(Date.parse(OPEN)+1000,{suspended:true});const p=await runtime.publish();
  assert.equal(p.ok,true);assert.equal(ports.state.decisions.length,0);
  assert(ports.state.issues.some(i=>i.reason==='not-on-sale'));
});
test('fresh signed HHAD with separately verified current and calculator acquisitions can publish at 11',async()=>{
  const {ports,runtime}=await runtimeAt(Date.parse(OPEN),{withHHAD:true});const p=await runtime.publish();
  assert.equal(p.ok,true);assert.equal(ports.state.decisions.length,1);
  assert.equal(ports.state.decisions[0].handicapAnalysis.marketReference.quoteProvenance.version,'signed-live-handicap-v1');
  assert.equal(ports.state.decisions[0].inputCapture.officialHandicap.status,'source-verified');
});
test('an early HHAD calculator request is excluded without displacing the fresh eligible HAD market',async()=>{
  const {ports,runtime}=await runtimeAt(Date.parse(OPEN),{withHHAD:true,calculatorRequestedAt:Date.parse(OPEN)-1});
  const p=await runtime.publish();assert.equal(p.ok,true);assert.equal(ports.state.decisions.length,1);
  const decision=ports.state.decisions[0];assert.equal(decision.quoteProvenance.version,'signed-live-had-receipt-v2');
  assert.equal(decision.handicapAnalysis,null);assert.equal(decision.coherentPrimary.anchorMarket,'HAD');
});
const {Repository}=require('../scripts/recommendationPlatform/repository.cjs');
test('actual Repository excludes a legacy pre-opening HHAD atom only in the detached child and binds the filtered hash',async()=>{
  const now=Date.parse(OPEN)+1000,m=source(1,now-1000);
  m.oddsReceivedAt=m.oddsUpdatedAt=DAY+'T02:32:15Z';
  m.probabilityModel.calculationTrace={poisson:{lambdas:{home:1.8,away:1.2}}};
  Object.assign(m,{handicapOdds:{odds1:2.1,oddsX:3.8,odds2:2.6},handicapLine:'-1',handicapOddsSource:'sporttery:HHAD',
    handicapOddsPoolCode:'HHAD',handicapOddsReceivedAt:DAY+'T02:32:15Z',handicapOddsSourceUrl:'https://info.sporttery.cn/football/hhad',
    externalSignals:{bookmakerOdds:{hhad:{odds1:2.1,oddsX:3.8,odds2:2.6,handicapLine:-1,source:'sporttery:HHAD',receivedAt:DAY+'T02:32:15Z'}}}});
  const row={...m,prospectiveForecastInput:structuredClone(m)},before=hash(row),signed=snapshot([m],{requestedAt:now,receivedAt:now});
  const client={query:async sql=>{
    if(sql.includes('match_snapshots'))return {rows:[{payload:row}]};
    if(sql.includes('market_latest'))return {rows:[]};throw new Error('Unexpected synthetic SQL');
  }};
  const repo=new Repository(client,{clock:()=>now,readOfficialSnapshot:()=>signed.snapshot,trustRegistry:signed.registry}),inputs=await repo.currentInputs(now);
  const parent=inputs.current[0],child=parent.prospectiveForecastInput;
  assert.deepEqual(parent.handicapOdds,m.handicapOdds);assert.equal(parent.handicapLine,'-1');
  for(const field of ['handicapOdds','handicapLine','handicapOddsSource','handicapOddsPoolCode','handicapOddsReceivedAt','handicapOddsSourceUrl','handicapQuoteProvenance'])assert.equal(child[field],undefined);
  assert.equal(child.externalSignals.bookmakerOdds.hhad,undefined);assert(child.officialHadQuoteReceipt);
  assert.equal(inputs.inputCapture.currentHash,hash([row]));assert.equal(inputs.inputCapture.joinedInputHash,hash(inputs.current));assert.equal(hash(row),before);
  const ports=memoryPorts(),transaction=ports.transaction;ports.now=now;
  ports.transaction=(lane,action)=>transaction(lane,r=>{
    r.currentInputs=async()=>inputs;r.trustRegistry=signed.registry;r.publication=async()=>publication(now);return action(r);
  });
  assert.equal((await createRuntime(ports).publish()).ok,true);assert.equal(ports.state.decisions.length,1);
  assert.equal(ports.state.decisions[0].handicapAnalysis,null);assert.equal(hash(row),before);
});
test('post-opening calculator bytes with a tampered signature cannot restore a removed HHAD market',async()=>{
  const now=Date.parse(OPEN),{ports,runtime}=await runtimeAt(now,{withHHAD:true});
  const record=(await runtime.publish(),ports.state.decisions[0]);assert(record.handicapAnalysis?.marketReference);
  const m=source(1,now-1000),signed=snapshot([m],{requestedAt:now,receivedAt:now});
  m.handicapOdds={odds1:2.1,oddsX:3.8,odds2:2.6};m.handicapLine=-1;m.handicapOddsSource='sporttery:HHAD';
  const calc=structuredClone(signed.snapshot.endpoints[0]);calc.method='calculator';calc.url=require('../scripts/sportteryEndpointContract.cjs').SPORTTERY_CALCULATOR_URL;
  calc.sourceRequest={method:'GET',url:calc.url,page:null,role:'calculator'};signed.snapshot.endpoints.push(calc);
  const raw=hash(m),filtered=opening.filterNewOpeningMarkets([m],signed.snapshot,{asOf:OPEN,trustRegistry:signed.registry});
  assert.equal(filtered[0].handicapOdds,undefined);assert.equal(filtered[0].handicapLine,undefined);assert.equal(hash(m),raw);
});
