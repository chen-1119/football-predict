'use strict';
// Separate append-only revision lane; the original publisher and its daily
// projection/settlement remain unchanged. Requires the installed root broker.
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const original=require('../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs');
const {verifyRow}=require('../scripts/postgresPrivateModelArtifactStore.cjs');
const {SELECT}=require('../scripts/leagueBaselineRegistry.cjs');
const {loadCollectorTrustRegistry}=require('../src/services/collectorAttestation.cjs');
const {readLiveOfficialSnapshot}=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs');
const {epochNanoseconds:ns}=require('../src/services/prematchV3Clock.cjs');
const {reviewDisposition}=require('./researchRevisionPolicy.cjs');
const fail=code=>{throw Object.assign(Error(code),{code,retryWriteAutomatically:false});};
const VERSION='reviewed-single-revision-v1',ACK_VERSION='reviewed-single-revision-ack-v1',MAX_REVISIONS=16;
const trust=()=>loadCollectorTrustRegistry(process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH||require('node:path').resolve(__dirname,'../deploy/light-server/collector-trust-registry.json'));
function revisionKey(day,eventId,revision){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!/^[1-9]\d{0,19}$/.test(eventId||'')||!Number.isSafeInteger(revision)||revision<1||revision>MAX_REVISIONS)fail('REVIEW_REVISION_IDENTITY');
 return 'reviewed-single-'+day+'-'+eventId+'-v'+String(revision).padStart(2,'0');
}
function validate(r){
 if(!r||Object.keys(r).sort().join(',')!=='basePayloadSha256,baseRecordKey,draft,draftHash,eventId,previousRevisionHash,revision,version'||r.version!=='reviewed-single-request-v1'
  ||!/^reviewed-analysis-\d{4}-\d{2}-\d{2}-batch-[a-f0-9]{64}$/.test(r.baseRecordKey||'')
  ||['basePayloadSha256','draftHash'].some(k=>!/^[a-f0-9]{64}$/.test(r[k]||''))||r.draft?.version!==3||p.hash(r.draft)!==r.draftHash
  ||r.draft.singles?.length!==1||r.draft.singles[0].eventId!==r.eventId
  ||(r.revision===1?r.previousRevisionHash!==null:!/^[a-f0-9]{64}$/.test(r.previousRevisionHash||'')))fail('REVIEW_REVISION_REQUEST');
 const key=revisionKey(r.draft.businessDate,r.eventId,r.revision);
 if(!r.baseRecordKey.startsWith('reviewed-analysis-'+r.draft.businessDate+'-batch-'))fail('REVIEW_REVISION_DAY');
 return key;
}
async function now(c){const v=(await c.query('SELECT clock_timestamp() AS now')).rows[0]?.now;const at=v instanceof Date?v.toISOString():v;if(ns(at)===null)fail('REVIEW_REVISION_CLOCK');return at;}
async function transaction(pool,readonly,action){
 const c=await pool.connect();let committing=false,broken;
 try{await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE'+(readonly?' READ ONLY':''));await c.query("SET LOCAL statement_timeout='10000ms'");await c.query("SET LOCAL lock_timeout='2000ms'");await c.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
  const result=await action(c);committing=true;await c.query('COMMIT');return result;
 }catch(e){if(committing){broken=e;if(!readonly)fail('REVIEW_REVISION_COMMIT_UNKNOWN_READ_FIRST');}else{try{await c.query('ROLLBACK');}catch(x){broken=x;}}throw e;
 }finally{c.release(broken);}
}
async function row(c,key){
 const bounds=(await c.query('SELECT payload_bytes,octet_length(payload::text) AS bytes FROM football.private_model_artifacts WHERE artifact_key=$1',[key])).rows;
 if(!bounds.length)return null;
 if(bounds.length!==1||!Number.isSafeInteger(Number(bounds[0].payload_bytes))||Number(bounds[0].payload_bytes)<1||Number(bounds[0].payload_bytes)>8*1024*1024||Number(bounds[0].bytes)!==Number(bounds[0].payload_bytes))fail('REVIEW_REVISION_STORE_BOUND');
 const found=(await c.query(SELECT,[key])).rows;if(found.length!==1)fail('REVIEW_REVISION_STORE_IDENTITY');return verifyRow(found[0],key,8*1024*1024);
}
function checkSeal(value){const {contentHash,...body}=value||{};if(p.hash(body)!==contentHash)fail('REVIEW_REVISION_SEAL');}
function deadline(record,at){original.deadline(record,at);if(record.records.length!==1||ns(at)>=ns(record.records[0].eventVersion))fail('REVIEW_REVISION_ALREADY_STARTED');}
async function insert(c,key,value,at){
 const json=JSON.stringify(value);if(Buffer.byteLength(json)>8*1024*1024)fail('REVIEW_REVISION_STORE_BOUND');
 await c.query(`INSERT INTO football.private_model_artifacts(artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes)
 VALUES($1,$2,$3,$4,$5::json,$6,$7)`,[key,value.version,value.createdAt,at,json,p.sha(json),Buffer.byteLength(json)]);
 const saved=await row(c,key);if(saved.payloadJson!==json)fail('REVIEW_REVISION_ROUNDTRIP');return saved;
}
async function base(c,request,asOf){
 const saved=await row(c,request.baseRecordKey);if(!saved||saved.payloadSha256!==request.basePayloadSha256)fail('REVIEW_REVISION_BASE_CHANGED');
 const old=await original.readPublication(c,request.baseRecordKey,asOf);
 const first=old.v.record.records.filter(r=>r.eventId===request.eventId);if(first.length!==1)fail('REVIEW_REVISION_BASE_EVENT');return first[0];
}
async function verifyCommitted(c,key,asOf,depth=0){
 if(depth>=MAX_REVISIONS)fail('REVIEW_REVISION_CHAIN_BOUND');
 const saved=await row(c,key);if(!saved)return {state:'not-observed',key,verified:false,retryWriteAutomatically:false};
 const v=saved.payload;if(saved.artifactVersion!==VERSION||v.version!==VERSION)fail('REVIEW_REVISION_STORE_VERSION');checkSeal(v);validate(v.request);
 if(validate(v.request)!==key||v.createdAt!==v.record.createdAt||saved.generatedAt!==v.createdAt||saved.updatedAt!==v.storedAt||ns(v.storedAt)===null||ns(v.storedAt)<=ns(v.createdAt))fail('REVIEW_REVISION_CLOCK');
 const first=await base(c,v.request,asOf);
 if(v.originalDecisionHash!==p.hash(first))fail('REVIEW_REVISION_BASE_CHANGED');
 if(v.request.revision>1){
  const previous=await verifyCommitted(c,revisionKey(v.record.businessDate,v.request.eventId,v.request.revision-1),asOf,depth+1);
  if(!previous.verified||previous.payloadSha256!==v.request.previousRevisionHash||previous.basePayloadSha256!==v.request.basePayloadSha256||previous.baseRecordKey!==v.request.baseRecordKey||ns(previous.publishedAt)>=ns(v.createdAt))fail('REVIEW_REVISION_CHAIN');
 }
 const replay=p.make(v.request.draft,{...v.inputs,trustRegistry:trust(),asOf:v.createdAt});if(p.hash(replay)!==p.hash(v.record))fail('REVIEW_REVISION_REPLAY');
 const decision=v.record.records[0];if(decision.eventVersion!==first.eventVersion||decision.homeTeamId!==first.homeTeamId||decision.awayTeamId!==first.awayTeamId||decision.homeTeamName!==first.homeTeamName||decision.awayTeamName!==first.awayTeamName)fail('REVIEW_REVISION_EVENT_CHANGED');
 deadline(v.record,v.storedAt);
 const ack=await row(c,key+'-ack');if(!ack)return {state:'record-present-ack-missing',key,verified:false,retryWriteAutomatically:false};
 const a=ack.payload;checkSeal(a);if(ack.artifactVersion!==ACK_VERSION||a.version!==ACK_VERSION||ack.generatedAt!==a.createdAt||ack.updatedAt!==a.createdAt||a.recordKey!==key||a.storedSha256!==saved.payloadSha256||a.recordHash!==v.record.contentHash||ns(a.createdAt)===null||ns(a.createdAt)<ns(v.storedAt)||ns(a.createdAt)>ns(asOf)||ns(a.createdAt)-ns(v.storedAt)>30000000000n)fail('REVIEW_REVISION_ACK');deadline(v.record,a.createdAt);
 return {state:'committed-and-acknowledged',key,verified:true,payloadSha256:saved.payloadSha256,ackSha256:ack.payloadSha256,
  baseRecordKey:v.request.baseRecordKey,basePayloadSha256:v.request.basePayloadSha256,previousRevisionHash:v.request.previousRevisionHash,revision:v.request.revision,
  originalDecision:first,originalDecisionHash:v.originalDecisionHash,latestDecision:decision,publishedAt:v.createdAt,commitObservedAt:a.createdAt,
  originalSettlementPreserved:true,independentEventIncrement:0,formalEligible:false,modelAdoption:false,retryWriteAutomatically:false};
}
function createRevisionStore({pool,runExclusive}={}){
 if(!pool?.connect||typeof runExclusive!=='function')fail('REVIEW_REVISION_BROKER_REQUIRED');
 async function read(request){const key=validate(request);return transaction(pool,true,async c=>{
  const result=await verifyCommitted(c,key,await now(c));if(result.verified&&(result.basePayloadSha256!==request.basePayloadSha256||result.previousRevisionHash!==request.previousRevisionHash))fail('REVIEW_REVISION_IMMUTABLE_CONFLICT');
  const existing=await row(c,key);if(existing&&p.hash(existing.payload.request)!==p.hash(request))fail('REVIEW_REVISION_IMMUTABLE_CONFLICT');return result;
 });}
 async function publish(request){const key=validate(request);return runExclusive(async()=>{
  const before=await read(request);if(before.state!=='not-observed')return {...before,submitted:false};
  const stored=await transaction(pool,false,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-postgres-projection-sync-v1']);
   if(await row(c,key)||await row(c,key+'-ack'))fail('REVIEW_REVISION_EXISTS_READ_FIRST');
   const at=await now(c),first=await base(c,request,at);
   if(request.revision>1){const previous=await verifyCommitted(c,revisionKey(request.draft.businessDate,request.eventId,request.revision-1),at);if(!previous.verified||previous.payloadSha256!==request.previousRevisionHash||previous.basePayloadSha256!==request.basePayloadSha256)fail('REVIEW_REVISION_PREDECESSOR');}
   const all=(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513")).rows.map(r=>r.payload);if(all.length>512)fail('REVIEW_REVISION_MATCH_BOUND');
   const matches=all.filter(m=>String(m.sourceMatchId||'').replace(/^sporttery_/,'')===request.eventId),snapshot=readLiveOfficialSnapshot();
   const record=p.make(request.draft,{matches,snapshot,trustRegistry:trust(),asOf:at}),decision=record.records[0];
   if(decision.eventVersion!==first.eventVersion||decision.homeTeamId!==first.homeTeamId||decision.awayTeamId!==first.awayTeamId)fail('REVIEW_REVISION_EVENT_CHANGED');
   const observed={...decision,status:matches[0]?.status,isOnSale:true,observedAt:decision.quoteObservedAt};
   if(!reviewDisposition(first,observed,at).canRevisePrematch)fail('REVIEW_REVISION_NOT_OPEN');
   const storedAt=await now(c);deadline(record,storedAt);
   const value=p.seal({version:VERSION,createdAt:record.createdAt,storedAt,request,record,inputs:{matches,snapshot},originalDecisionHash:p.hash(first)});
   const saved=await insert(c,key,value,storedAt);deadline(record,await now(c));return saved;
  });
  await transaction(pool,false,async c=>{
   const saved=await row(c,key);if(saved?.payloadSha256!==stored.payloadSha256)fail('REVIEW_REVISION_COMMITTED_READBACK');
   const at=await now(c);deadline(saved.payload.record,at);if(ns(at)-ns(saved.payload.storedAt)>30000000000n)fail('REVIEW_REVISION_ACK_CLOCK');
   const ack=p.seal({version:ACK_VERSION,createdAt:at,recordKey:key,storedSha256:saved.payloadSha256,recordHash:saved.payload.record.contentHash});await insert(c,key+'-ack',ack,at);deadline(saved.payload.record,await now(c));
  });
  const result=await read(request);if(!result.verified)fail('REVIEW_REVISION_READBACK_UNVERIFIED');return {...result,submitted:true};
 });}
 return {read,publish};
}
module.exports={VERSION,ACK_VERSION,MAX_REVISIONS,revisionKey,validate,createRevisionStore,verifyCommitted};
