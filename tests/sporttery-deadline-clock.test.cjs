'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {sportteryDeadlineClock}=require('../src/services/sportteryDeadlineClock.cjs');
const {eventFromMatch,buildPrematchV3Assessment}=require('../src/services/prematchV3Assessment.cjs');
const {validateResponse,verifyOnlineRead,validateTransport,VERSION}=require('../scripts/readPrematchV3OnlineInputs.cjs');
const crypto=require('node:crypto');
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
// Synthetic source clocks; never historical business predictions or accuracy data.
const match=()=>({id:'sporttery_123',sourceMatchId:'123',businessDate:'2026-10-06',
 kickoffTime:'2026-10-07T02:45:00+08:00',eventVersion:'2026-10-06T18:45:00Z',
 buyEndTime:'2026-10-06 22:00:00',predictionMeta:{cutoffTime:'2026-10-06 22:00:00'},
 homeTeamId:'home',awayTeamId:'away',status:'SCHEDULED',isOnSale:true});
const response=m=>({version:VERSION,readOnly:'on',productionWrites:0,businessDate:'2026-10-06',
 observedAt:'2026-10-06T10:00:00.000000001Z',generation:{data_generation_id:'synthetic',manifest_hash:'a'.repeat(64)},
 matches:[m],modelArtifactInventory:[],modelArtifacts:[]});

test('documented Beijing buyEndTime and exact copied cutoff alias normalize without changing original values',()=>{
 const m=match(),before=JSON.stringify(m),buy=sportteryDeadlineClock(m,m.buyEndTime);
 assert.equal(buy.instant,'2026-10-06T22:00:00+08:00');
 assert.deepEqual(buy.normalization,{field:'buyEndTime',raw:m.buyEndTime,instant:buy.instant,timeZone:'Asia/Shanghai',basis:'sporttery-buyEndTime-contract',copiedFrom:null});
 for(const field of ['cutoffAt','cutoffTime','predictionMeta.cutoffTime']){
  const alias=sportteryDeadlineClock(m,m.buyEndTime,{field});assert.equal(alias.instant,buy.instant);assert.equal(alias.normalization.copiedFrom,'buyEndTime');
 }
 const validation=validateResponse(response(m),'2026-10-06');assert.equal(validation.clockNormalizations.length,2);
 assert.equal(JSON.stringify(m),before);
});

test('other providers, incomplete identity and nonidentical local cutoff aliases never inherit the Sporttery time zone',()=>{
 const m=match();
 for(const patch of [{id:'other_123'},{sourceMatchId:'124'},{id:'123'},{id:null},{sourceMatchId:null},{sourceMatchId:123},{sourceMatchId:'abc'}]){
  assert.equal(sportteryDeadlineClock({...m,...patch},m.buyEndTime).instant,null);
 }
 for(const value of ['2026-10-06 21:59:59','2026-10-06T22:00:00','2026-10-06 22:00:00.000']){
  assert.equal(sportteryDeadlineClock(m,value,{field:'predictionMeta.cutoffTime'}).instant,null);
 }
 assert.throws(()=>validateResponse(response({...m,predictionMeta:{cutoffTime:'2026-10-06 22:01:00'}}),'2026-10-06'),/V3_READER_MATCH_CUTOFF/);
});

test('explicit zoned clocks keep original nanoseconds and zone bytes without source-zone inference',()=>{
 const raw='2026-10-06T21:59:59.123456789+09:00';
 assert.deepEqual(sportteryDeadlineClock({id:'other'},raw),{instant:raw,normalization:null});
 const m={...match(),cutoffAt:'2026-10-06T13:59:59.999999999Z'};
 assert.equal(eventFromMatch(m).cutoffAt,m.cutoffAt);
});

test('invalid calendar, hours, whitespace and unsupported local formats fail closed',()=>{
 for(const raw of ['2026-02-29 22:00:00','2026-02-30 22:00:00','2026-13-06 22:00:00','0000-01-01 22:00:00',
  '2026-10-06 24:00:00','2026-10-06 22:60:00','2026-10-06 22:00:60','2026-10-06 22:00',' 2026-10-06 22:00:00','2026-10-06 22:00:00 ',null,123]){
  assert.equal(sportteryDeadlineClock(match(),raw).instant,null);
 }
 assert.equal(sportteryDeadlineClock(match(),'2024-02-29 22:00:00').instant,'2024-02-29T22:00:00+08:00');
});

test('22:00 sale deadline remains earlier than next-day kickoff and later zoned aliases; exact boundary is closed',()=>{
 const m={...match(),cutoffTime:'2026-10-07T02:45:00+08:00'},before=JSON.stringify(m);
 assert.equal(eventFromMatch(m).cutoffAt,'2026-10-06T22:00:00+08:00');
 const at=buildPrematchV3Assessment(m,{asOf:'2026-10-06T14:00:00Z'});
 assert(at.blockers.includes('event-or-sale-clock-ineligible'));assert.equal(at.comparisons.teamOnly,null);
 const after=buildPrematchV3Assessment(m,{asOf:'2026-10-06T14:00:00.000000001Z'});
 assert(after.blockers.includes('event-or-sale-clock-ineligible'));assert.equal(after.formalEligible,false);
 assert.equal(JSON.stringify(m),before);
});

test('conflicting explicit aliases or absent sale clocks cannot manufacture a deadline',()=>{
 const m=match();
 assert.equal(eventFromMatch({...m,cutoffAt:'2026-10-06T13:59:59Z',cutoffTime:'2026-10-06T14:00:00Z'}).cutoffAt,null);
 assert.equal(eventFromMatch({...m,buyEndTime:undefined,predictionMeta:{}}).cutoffAt,null);
 assert.equal(eventFromMatch({...m,predictionMeta:{cutoffTime:'2026-10-06 22:00:01'}}).cutoffAt,null);
});

test('raw response signature remains bound to original local clock bytes, not a rewritten ISO payload',()=>{
 const value=response(match()),raw=Buffer.from(JSON.stringify(value));
 const transport={hostKeyPinVerified:true,hostKeyFingerprint:'SHA256:'+'a'.repeat(43),
  startedAt:'2026-10-06T10:00:00Z',finishedAt:'2026-10-06T10:00:01Z',
  remoteResponseSha256:digest(raw),remoteResponseFile:'synthetic.remote-response.json',bytes:raw.length};
 Object.assign(transport,validateTransport(transport,value.observedAt));
 const envelope={...value,transport};assert.equal(verifyOnlineRead(envelope,{date:value.businessDate,rawResponse:raw}),true);
 const rewritten=structuredClone(envelope);rewritten.matches[0].buyEndTime='2026-10-06T22:00:00+08:00';
 assert.equal(verifyOnlineRead(rewritten,{date:value.businessDate,rawResponse:raw}),false);
 assert.equal(digest(raw),transport.remoteResponseSha256);
});
