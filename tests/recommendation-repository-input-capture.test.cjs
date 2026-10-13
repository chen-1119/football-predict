'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Repository}=require('../scripts/recommendationPlatform/repository.cjs');
const {joinOfficialHandicap}=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs');
const {validInputCapture}=require('../scripts/recommendationPlatform/inputCapture.cjs');
const {makeDecision,validDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {hash}=require('../src/services/publishedForecastPolicy.cjs');
const {createCollectorKeyPair,buildCollectorCommitment,signCollectorCommitment,sha256CollectorJson}=require('../src/services/collectorAttestation.cjs');
const {SPORTTERY_CALCULATOR_URL,SPORTTERY_CURRENT_URL}=require('../scripts/sportteryEndpointContract.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');
const stamp=v=>new Date(v).toISOString(),pair=createCollectorKeyPair({keyId:'capture-test',independenceDomain:'capture-fixture'});
function source(){return match(1,NOW,{handicapLine:-1,handicapOdds:{odds1:2.4,oddsX:3.3,odds2:2.1},
  handicapOddsSource:'sporttery:HHAD',handicapOddsReceivedAt:stamp(NOW-16*60000),
  probabilityModel:{version:'test',generatedAt:stamp(NOW),oneXTwo:{final:{home:45.5,draw:28,away:26.5}},calculationTrace:{poisson:{lambdas:{home:1.6,away:1.3}}}}});}
function snapshot(receivedAt=NOW+500,mutate=()=>{}){
  const m=source();
  return {endpoints:['calculator','current'].map(method=>{
    const row={matchId:'1',matchDate:'2026-09-17',matchTime:'23:00:00',businessDate:m.businessDate,
      homeTeamAllName:m.homeTeamName,awayTeamAllName:m.awayTeamName,matchStatus:'Selling',sellStatus:1,
      oddsList:[{poolCode:'HHAD',h:2.4,d:3.3,a:2.1,goalLine:'-1'}],poolList:[{poolCode:'HHAD',poolStatus:'Selling',bettingAllup:1}]};
    const payload={success:true,value:{matchInfoList:[{subMatchList:[row]}]}},url=method==='calculator'?SPORTTERY_CALCULATOR_URL:SPORTTERY_CURRENT_URL;
    const e={method,page:null,ok:true,url,payload,requestedAt:stamp(receivedAt-1000),receivedAt:stamp(receivedAt),sourceCycleId:'capture-cycle',
      sourceRequest:{method:'GET',url,page:null,role:method},httpStatus:200,contentType:'application/json',rawSha256:'b'.repeat(64),rawBytes:500,headersSha256:'a'.repeat(64)};
    mutate(e,method);e.canonicalPayloadSha256=sha256CollectorJson(e.payload);
    const commitment=buildCollectorCommitment({endpoint:{url:e.url,method:'GET',page:null,role:method},collectorCycleId:e.sourceCycleId,
      requestedAt:e.requestedAt,receivedAt:e.receivedAt,response:{httpStatus:e.httpStatus,contentType:e.contentType,rawSha256:e.rawSha256,rawBytes:e.rawBytes,headersSha256:e.headersSha256},
      payload:e.payload,canonicalPayloadSha256:e.canonicalPayloadSha256});
    e.collectorAttestation=signCollectorCommitment(commitment,{keyId:pair.keyId,privateKeyPem:pair.privateKeyPem});return e;
  })};
}
async function captured(s=snapshot()){
  let now=NOW,queries=0,readAt=null;const original=source();
  const client={query:async sql=>{
    queries++;now+=500;
    if(sql.includes('match_snapshots'))return {rows:[{payload:original}]};
    if(sql.includes('market_latest'))return {rows:[]};
    throw Error('Unexpected SQL');
  }};
  const repo=new Repository(client,{clock:()=>now,readOfficialSnapshot:()=>{readAt=now;return s;},trustRegistry:pair.registry});
  return {inputs:await repo.currentInputs(NOW),original,now,queries,readAt};
}
test('actual repository captures later source bytes after SQL and preserves the original model and parent',async()=>{
  const {inputs,original,now,queries,readAt}=await captured();
  assert.equal(queries,2);assert.equal(readAt,NOW+1000);assert.equal(inputs.inputKnowledgeAt,stamp(now));
  assert.equal(inputs.current[0].handicapOddsReceivedAt,stamp(NOW+500));
  assert.equal(original.handicapOddsReceivedAt,stamp(NOW-16*60000));
  assert.deepEqual(inputs.current[0].probabilityModel,original.probabilityModel);
  assert.equal(inputs.inputCapture.currentHash,hash([original]));
  assert.equal(inputs.inputCapture.joinedInputHash,hash(inputs.current));
  assert.equal(inputs.inputCapture.officialHandicap.reasonCounts['hhad-applied'],1);
  assert.equal(validInputCapture(inputs.inputCapture,stamp(now)),true);
});
test('the old asOf rejects the same newly acquired source; audit distinguishes this from missing source',()=>{
  const audit={};joinOfficialHandicap([source()],snapshot(),{now:NOW,trustRegistry:pair.registry,audit});
  assert.equal(audit.status,'source-unavailable');
  assert.equal(audit.endpoints.calculator.reason,'endpoint-acquired-after-asof');
});
test('future, expired and invalid signed sources retain rejection diagnostics',async()=>{
  const corrupted=snapshot(NOW);corrupted.endpoints[0].collectorAttestation.signature='bad';
  for(const [s,reason] of [[snapshot(NOW+1001),'endpoint-acquired-after-asof'],[snapshot(NOW-16*60000),'endpoint-expired'],
    [corrupted,'collector-attestation-invalid']]){
    const {inputs,original}=await captured(s),audit=inputs.inputCapture.officialHandicap;
    assert.equal(audit.status,'source-unavailable');
    assert.equal(audit.endpoints.calculator.reason,reason);
    assert.equal(inputs.current[0].handicapOddsReceivedAt,undefined);
    assert.equal(original.handicapOddsReceivedAt,stamp(NOW-16*60000));assert.equal(inputs.inputCapture.currentHash,hash([original]));
    assert.equal(validInputCapture(inputs.inputCapture,stamp(NOW+1000)),true);
  }
});
test('individually signed endpoint pairs from different collector cycles are not joined',async()=>{
  const {inputs,original}=await captured(snapshot(NOW,(e,method)=>{if(method==='current')e.sourceCycleId='other-cycle';}));
  assert.equal(inputs.inputCapture.officialHandicap.status,'source-cycle-conflict');
  assert.equal(inputs.current[0].handicapOddsReceivedAt,undefined);
  assert.equal(original.handicapOddsReceivedAt,stamp(NOW-16*60000));assert.equal(inputs.inputCapture.currentHash,hash([original]));
});
test('frozen capture digest binds the decision and cannot be replaced with a rehashed diagnostic',async()=>{
  const {inputs,now}=await captured();
  const d=makeDecision(inputs.current[0],{now,publication:publication(NOW),inputCapture:inputs.inputCapture}).decision;
  assert.ok(d&&validDecision(d));assert.equal(d.inputCaptureHash,hash(inputs.inputCapture));
  const forged=structuredClone(d);forged.inputCapture.joinedInputHash='d'.repeat(64);
  forged.inputCaptureHash=hash(forged.inputCapture);const {recordHash,...body}=forged;forged.recordHash=hash(body);
  assert.equal(validDecision(forged),false);assert.equal(validDecision(d),true);
});
test('capture clock and malformed digest cannot be used as admission credentials',async()=>{
  const {inputs,now}=await captured();
  for(const mutate of [c=>c.capturedAt=stamp(now+1),c=>c.startedAt=stamp(now+1),c=>c.joinedInputHash='bad',
    c=>c.officialHandicap.reasonCounts['hhad-applied']=Infinity,c=>c.officialHandicap.samples=Array(33).fill({sourceMatchId:'1',reason:'hhad-applied'}),
    c=>c.officialHandicap.endpoints.current.sourceCycleId='x'.repeat(1024*1024),c=>c.officialHandicap.endpoints.current.extra='unbound']){
    const c=structuredClone(inputs.inputCapture);mutate(c);assert.equal(validInputCapture(c,stamp(now)),false);
    assert.throws(()=>makeDecision(inputs.current[0],{now,publication:publication(NOW),inputCapture:c}),{code:'INPUT_CAPTURE_INVALID'});
  }
});
test('blank signed cycles and oversized unverified metadata remain bounded and cannot refresh quotes',async()=>{
  for(const cycle of [' ','','x'.repeat(1024*1024)]){
    const s=snapshot(NOW,(e)=>{e.sourceCycleId=cycle;});
    const {inputs,original}=await captured(s),audit=inputs.inputCapture.officialHandicap;
    assert.equal(audit.status,'source-unavailable');assert.equal(audit.endpoints.calculator.reason,'endpoint-cycle-invalid');
    assert.equal(audit.endpoints.calculator.sourceCycleId,null);
    assert.ok(Buffer.byteLength(JSON.stringify(inputs.inputCapture))<16384);
    assert.equal(validInputCapture(inputs.inputCapture,stamp(NOW+1000)),true);
    assert.equal(inputs.current[0].handicapOddsReceivedAt,undefined);
    assert.equal(original.handicapOddsReceivedAt,stamp(NOW-16*60000));assert.equal(inputs.inputCapture.currentHash,hash([original]));
  }
});
test('current input audit counts are not capped by the independent source endpoint row limit',()=>{
  const rows=[...Array.from({length:513},(_,i)=>({...source(),id:'locked'+i,sourceMatchId:'locked'+i,status:'LIVE'})),source()];
  const audit={};joinOfficialHandicap(rows,snapshot(NOW),{now:NOW+1000,trustRegistry:pair.registry,audit});
  const c={version:'current-input-capture-v1',startedAt:stamp(NOW),capturedAt:stamp(NOW+1000),
    currentHash:hash(rows),marketSignalHash:hash([]),joinedInputHash:hash(rows),officialHandicap:audit};
  assert.equal(audit.reasonCounts['not-open-prospective-input'],513);assert.equal(audit.samples.length,32);
  assert.equal(validInputCapture(c,stamp(NOW+1000)),true);
});
test('multibyte diagnostic identifiers obey the UTF8 byte cap without dropping an unrelated valid event',()=>{
  const rows=[...Array.from({length:32},()=>({...source(),sourceMatchId:'球'.repeat(255),status:'LIVE'})),source()],audit={};
  const joined=joinOfficialHandicap(rows,snapshot(NOW),{now:NOW+1000,trustRegistry:pair.registry,audit});
  assert.equal(audit.samples.length,32);assert.ok(audit.samples.every(v=>v.sourceMatchId===''));
  assert.equal(audit.reasonCounts['hhad-applied'],1);assert.equal(joined.at(-1).handicapOddsReceivedAt,stamp(NOW));
  const c={version:'current-input-capture-v1',startedAt:stamp(NOW),capturedAt:stamp(NOW+1000),
    currentHash:hash(rows),marketSignalHash:hash([]),joinedInputHash:hash(joined),officialHandicap:audit};
  assert.ok(Buffer.byteLength(JSON.stringify(c),'utf8')<=16384);assert.equal(validInputCapture(c,stamp(NOW+1000)),true);
});
test('old decisions without capture remain byte-identical and valid',()=>{
  const input=match(),context={now:NOW,publication:publication(NOW)};
  const first=makeDecision(input,context).decision,second=makeDecision(input,context).decision;
  assert.deepEqual(first,second);assert.equal(validDecision(first),true);
  assert.equal(Object.hasOwn(first,'inputCapture'),false);assert.equal(Object.hasOwn(first,'inputCaptureHash'),false);
  assert.equal(makeDecision(input,{...context,now:NaN}).reason,'clock-invalid');
});
