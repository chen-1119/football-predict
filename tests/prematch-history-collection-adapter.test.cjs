'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {adaptLedgerTeamHistory,VERSION}=require('../scripts/prematchHistoryCollectionAdapter.cjs');
const {VERSION:HISTORY_VERSION,targetsFor}=require('../scripts/readPrematchV3TeamHistory.cjs');
const {VERSION:READ_VERSION,validateTransport}=require('../scripts/readPrematchV3OnlineInputs.cjs');
const {eventFromMatch}=require('../src/services/prematchV3Assessment.cjs');
const {buildPrematchTeamSnapshot}=require('../src/services/prematchTeamEvidenceV3.cjs');
const {collectResults,validResultEvent}=require('../scripts/recommendationPlatform/results.cjs');
const {stableHash}=require('../src/services/webConsensusEvidence.cjs');
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const seal=body=>({...body,contentHash:stableHash(body)}),clone=value=>structuredClone(value);
const asOf='2026-10-06T07:05:00.000000100Z';
// Every provider, team and result fact in this file is synthetic. Raw receipt
// binding is the upstream orchestrator's responsibility, not source admission.
function transport(raw,{observedAt,finishedAt='2026-10-06T07:00:01Z'}={}){
 const t={hostKeyPinVerified:true,hostKeyFingerprint:'SHA256:'+'a'.repeat(43),startedAt:'2026-10-06T06:59:59Z',finishedAt,
  remoteResponseSha256:digest(raw),remoteResponseFile:'synthetic.remote-response.json',bytes:raw.length};
 return {...t,...validateTransport(t,observedAt)};
}
function ledgerHead(changes={}){
 const m={sourceMatchId:'122',eventVersion:'2026-10-01T14:00:00Z',kickoffTime:'2026-10-01T14:00:00Z',
  homeTeamId:'home',awayTeamId:'away',scoreHome:2,scoreAway:1,resultSource:'sporttery:official-api',...changes};
 const head=collectResults([m],new Map(),{isFinal:()=>true,isVoid:()=>false},Date.parse('2026-10-01T16:00:00Z')).updates[0];
 assert.equal(validResultEvent(head),true);return head;
}
function fixture(){
 const match={id:'sporttery_123',sourceMatchId:'123',businessDate:'2026-10-06',status:'SCHEDULED',isOnSale:true,
  eventVersion:'2026-10-06T18:45:00Z',kickoffTime:'2026-10-07T02:45:00+08:00',
  buyEndTime:'2026-10-06 22:00:00',predictionMeta:{cutoffTime:'2026-10-06 22:00:00'},
  homeTeamId:'home',awayTeamId:'away',homeTeamName:'Synthetic Home',awayTeamName:'Synthetic Away'};
 const originalInput={version:READ_VERSION,readOnly:'on',productionWrites:0,businessDate:'2026-10-06',
  observedAt:'2026-10-06T06:50:00Z',generation:{data_generation_id:'synthetic-current',manifest_hash:'a'.repeat(64)},
  matches:[match],modelArtifactInventory:[],modelArtifacts:[]};
 const inputRaw=Buffer.from(JSON.stringify(originalInput));
 // Input read has its own actual synthetic transport window.
 const inputTransport={...transport(inputRaw,{observedAt:'2026-10-06T07:00:00Z'}),startedAt:'2026-10-06T06:49:59Z',finishedAt:'2026-10-06T06:50:01Z'};
 Object.assign(inputTransport,validateTransport(inputTransport,originalInput.observedAt));
 const input={...originalInput,transport:inputTransport};
 const head=ledgerHead(),row={sourceMatchId:'122',kickoffTime:'2026-10-01T14:00:00.000000Z',homeTeamId:'home',awayTeamId:'away',
  homeTeamName:'Synthetic Home',awayTeamName:'Synthetic Away',scoreHome:2,scoreAway:1,historySnapshotBound:true,historySnapshotBinding:'single',
  historySourceMatchId:'122',historyKickoffTime:'2026-10-01T14:00:00Z',historyEventVersion:null,historyHomeTeamId:'home',historyAwayTeamId:'away',
  resultHead:head,resultHeadObservedAt:head.observedAt,resultObservedAt:null,resultSource:null,resultFinal:null,sourceResultPeriod:null};
 const originalHistory={version:HISTORY_VERSION,readOnly:'on',productionWrites:0,observedAt:'2026-10-06T07:00:00.000001Z',
  windowStartAt:'2026-06-08T07:00:00Z',windowEndAt:'2026-10-06T07:00:00Z',generation:{data_generation_id:'synthetic-history',manifest_hash:'b'.repeat(64)},
  rows:[{...row,teamId:'home',teamName:'Synthetic Home'},{...clone(row),teamId:'away',teamName:'Synthetic Away'}]};
 const historyRaw=Buffer.from(JSON.stringify(originalHistory));
 const history=seal({...originalHistory,targets:targetsFor(input),transport:transport(historyRaw,{observedAt:originalHistory.observedAt}),
  targetReadSha256:digest(Buffer.from(JSON.stringify(input))),targetReadRemoteSha256:digest(inputRaw),formalEligible:false,
  sourceAdmission:'stored-reference-only; PG presence does not authenticate provider data'});
 return {history,input,event:eventFromMatch(match),side:'home',asOf,inputRaw,historyRaw};
}
function reseal(value){const {contentHash,...body}=value;return seal(body);}
const adapt=(f,changes={})=>adaptLedgerTeamHistory({...f,...changes});

test('history adapter uses bound official ledger rows for each team and preserves original facts and source receipts',()=>{
 const f=fixture(),before=JSON.stringify(f);
 for(const [side,forGoals,againstGoals] of [['home',2,1],['away',1,2]]){
  const result=adapt(f,{side});assert.equal(result.version,VERSION);assert.equal(result.status,'captured');assert.equal(result.historyRows,1);
  assert.equal(result.formalEligible,false);assert.equal(result.completeTeamHistory,false);assert.equal(result.restDays,null);
  assert.match(result.sourceVerification,/unverified-external-source/);
  const observation=result.teamObservations[0],fact=observation.data.rows[0];
  assert.equal(observation.family,'history');assert.equal(observation.side,side);assert.equal(observation.teamId,f.event[side+'TeamId']);
  assert.equal(observation.sourceMatchId,f.event.sourceMatchId);assert.equal(observation.eventVersion,f.event.eventVersion);
  assert.equal(observation.providerObservedAt,f.history.observedAt);assert.equal(observation.receivedAt,f.history.transport.finishedAt);
  assert.equal(observation.clockBasis,'postgres-read-snapshot-observation');assert.equal(observation.sourcePublishedAt,null);
  assert.equal(fact.goalsFor,forGoals);assert.equal(fact.goalsAgainst,againstGoals);
  assert.equal(fact.providerObservedAt,f.history.rows[0].resultHead.observedAt);assert.equal(fact.receivedAt,f.history.transport.finishedAt);
  assert.equal(fact.clockBasis,'production-ledger-result-observed');assert.equal(fact.sourcePublishedAt,null);
  assert.equal(fact.source.receiptHash,f.history.contentHash);assert.equal(fact.source.rawPayloadHash,f.history.transport.remoteResponseSha256);
 }
 assert.equal(JSON.stringify(f),before);
});

test('target source, exact event nanoseconds, both team IDs and side are required',()=>{
 const f=fixture();
 for(const patch of [{sourceMatchId:'999'},{eventVersion:'2026-10-06T18:45:00.000000001Z'},
  {homeTeamId:'foreign'},{awayTeamId:'foreign'},{homeTeamId:'away',awayTeamId:'home'},
  {kickoffTime:'2026-10-06T18:45:00.000000001Z'}]){
  const result=adapt(f,{event:{...f.event,...patch}});assert.equal(result.status,'blocked');assert.deepEqual(result.teamObservations,[]);
 }
 for(const side of ['third',null,undefined])assert.equal(adapt(f,{side}).status,'blocked');
});

test('adapter cannot extend the target 22:00 sale deadline or accept closed target state',()=>{
 const f=fixture();
 const extended=adapt(f,{event:{...f.event,cutoffAt:'2026-10-06T18:45:00Z'},asOf:'2026-10-06T14:00:00.000000001Z'});
 assert.equal(extended.status,'blocked');
 for(const patch of [{status:'FINISHED'},{isOnSale:false},{saleStatus:'CLOSED'}]){
  const input=clone(f.input);Object.assign(input.matches[0],patch);
  assert.equal(adapt(f,{input,event:{...f.event,...patch}}).status,'blocked');
 }
 assert.equal(adapt(f,{asOf:f.event.cutoffAt}).status,'blocked');
});

test('only source-specific, exact row-bound FINAL results with original scores enter the history family',()=>{
 for(const patch of [{resultHead:ledgerHead({resultSource:'some-other-source'})},
  {resultHead:ledgerHead({sourceMatchId:'999'})},{resultHead:ledgerHead({homeTeamId:'foreign'})},
  {resultHead:ledgerHead({scoreAway:2})},{scoreHome:null},{historySnapshotBound:false},
  {historyKickoffTime:'2026-10-01T14:00:00.000000001Z'}]){
  const f=fixture();f.history.rows=f.history.rows.filter(r=>r.teamId==='home').map(r=>({...r,...patch}));f.history=reseal(f.history);
  const result=adapt(f);assert.equal(result.status,'blocked');assert.equal(result.reason,'no-bound-official-ledger-history');
 }
 const f=fixture();f.history.rows.forEach(r=>{r.resultHead.settlementOnly=true;});f.history=reseal(f.history);
 assert.equal(adapt(f).status,'blocked');
});

test('hash, readonly state, transport pin metadata and original target read binding fail closed',()=>{
 const f=fixture();
 const tampered=clone(f.history);tampered.rows[0].scoreHome=9;
 assert.equal(adapt(f,{history:tampered}).reason,'history-content-binding-invalid');
 for(const patch of [{formalEligible:true},{productionWrites:1},{readOnly:'off'},
  {targetReadRemoteSha256:'f'.repeat(64)},{transport:{...f.history.transport,hostKeyPinVerified:false}}]){
  const result=adapt(f,{history:reseal({...f.history,...patch})});assert.equal(result.status,'blocked');
 }
 for(const changes of [{history:null},{input:null},{event:null}])assert.equal(adapt(f,changes).status,'blocked');
});

test('new receipt, PG read and result observations remain actual knowledge clocks, never backdated or guessed publication clocks',()=>{
 const f=fixture();
 assert.equal(adapt(f,{asOf:'2026-10-06T07:00:00.999999999Z'}).status,'blocked');
 const skewed=clone(f.history);skewed.observedAt='2026-10-06T07:00:01.000000001Z';
 Object.assign(skewed.transport,validateTransport(skewed.transport,skewed.observedAt));
 assert.equal(adapt(f,{history:reseal(skewed)}).status,'blocked','PG read after local receipt cannot become an admissible family clock');
 const future=clone(f.history);future.rows.forEach(r=>{r.resultHead.observedAt='2026-10-06T07:00:01.000000001Z';});
 assert.equal(adapt(f,{history:reseal(future)}).status,'blocked');
});

test('sparse ledger history gives only known history features, not complete history, fatigue, players or xG',()=>{
 const f=fixture(),observations=['home','away'].flatMap(side=>adapt(f,{side}).teamObservations);
 const snapshot=buildPrematchTeamSnapshot({event:f.event,asOf:f.asOf,observations});
 assert.equal(snapshot.formalEligible,false);assert.equal(snapshot.features['home.history.sampleCount'],1);
 assert.equal(snapshot.features['home.history.goalsForPerMatch'],2);assert.equal(snapshot.features['away.history.goalsForPerMatch'],1);
 for(const [key,value] of Object.entries(snapshot.features))if(!key.includes('.history.'))assert.equal(value,null,key);
 for(const observation of observations){assert.equal(observation.sourcePublishedAt,null);assert.equal(observation.clockBasis,'postgres-read-snapshot-observation');}
 assert.equal(snapshot.observations[0].sourcePublishedAt,null);
 assert.equal(snapshot.observations[0].clockBasis,'postgres-read-snapshot-observation');
 assert.equal(snapshot.observations[0].data.rows[0].clockBasis,'production-ledger-result-observed');
 assert.equal(snapshot.observations[0].data.rows[0].sourcePublishedAt,null);
});

test('empty or duplicated history is unknown or invalid, never zero goals or extra independent samples',()=>{
 const f=fixture();f.history.rows=[];f.history=reseal(f.history);
 assert.equal(adapt(f).reason,'no-bound-official-ledger-history');assert.deepEqual(adapt(f).teamObservations,[]);
 const duplicate=fixture();duplicate.history.rows.push(clone(duplicate.history.rows[0]));duplicate.history=reseal(duplicate.history);
 assert.equal(adapt(duplicate).status,'blocked');
});
