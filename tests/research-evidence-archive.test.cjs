'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const fixture=require('./fixtures/reviewed-research.cjs');
const {createResearchWriteService,decodeRequest,MAX_REQUEST_BYTES}=require('../server/researchWriteService.cjs');
const {requestJournalIdentity,replayEnvelope}=require('../scripts/researchReleaseBroker.cjs');
const {decodeBrokerResponse}=require('../server/researchBrokerClient.cjs');
function setup({loseCommit=false}={}){
 const packet=fixture.setup().packets[0],json=JSON.stringify(packet),sha256=policy.sha(json),key='team-evidence-'+packet.contentHash;
 const request={version:'research-broker-request-v1',action:'evidence-archive',json,sha256};
 const read={version:request.version,action:'evidence-read',key,sha256};
 let held=false,clock=fixture.NOW,committed=new Map(),pending=null,writes=0,connections=0;
 const pool={async connect(){assert.equal(held,true);connections++;return {release(){},async query(sql,params=[]){
  if(sql.startsWith('BEGIN')){pending=new Map(committed);return {rows:[]};}
  if(sql==='COMMIT'){const changed=pending.size!==committed.size;committed=pending;pending=null;if(loseCommit&&changed)throw Error('lost COMMIT reply');return {rows:[]};}
  if(sql==='ROLLBACK'){pending=null;return {rows:[]};}
  if(sql.startsWith('SET ')||sql.includes('pg_advisory'))return {rows:[]};
  if(sql.includes('clock_timestamp'))return {rows:[{now:fixture.stamp(++clock)}]};
  const rows=pending||committed;
  if(sql.includes('INSERT INTO football.private_model_artifacts')){
   assert.equal(sql.includes('ON CONFLICT'),false);assert.equal(rows.has(params[0]),false);writes++;
   const [artifact_key,artifact_version,generated_at,updated_at,payload_json,payload_sha256,payload_bytes]=params;
   rows.set(artifact_key,{artifact_key,artifact_version,generated_at,updated_at,payload_json,payload_sha256,payload_bytes});return {rows:[]};
  }
  const found=rows.get(params[0]);
  if(sql.includes('octet_length'))return {rows:found?[{payload_bytes:found.payload_bytes,actual_bytes:Buffer.byteLength(found.payload_json)}]:[]};
  if(sql.startsWith('SELECT'))return {rows:found?[structuredClone(found)]:[]};throw Error('unexpected SQL');
 }}}};
 const service=createResearchWriteService({pool,runExclusive:async action=>{assert.equal(held,false);held=true;try{return await action();}finally{held=false;}}});
 return {packet,request,read,key,sha256,service,raw:value=>Buffer.from(JSON.stringify(value)),counts:()=>({writes,connections}),rows:()=>committed};
}
test('research evidence archive is insert-only, read back in a separate transaction, never publication',async()=>{
 const value=setup(),result=await value.service.execute(value.raw(value.request));
 assert.equal(result.verified,true);assert.equal(result.commitAcknowledged,true);assert.equal(result.published,false);assert.equal(result.archiveOnly,true);
 assert.equal(result.submitted,true);assert.deepEqual(value.counts(),{writes:1,connections:3});
 const exact=value.rows().get(value.key).payload_json;assert.equal(exact,value.request.json);
 const prior=await value.service.execute(value.raw(value.request));assert.equal(prior.submitted,false);assert.equal(value.counts().writes,1);
 assert.equal((await value.service.execute(value.raw(value.read))).verified,true);
});
test('unknown COMMIT is not retried; independent read can observe the exact original',async()=>{
 const value=setup({loseCommit:true});await assert.rejects(value.service.execute(value.raw(value.request)),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});
 assert.equal(value.counts().writes,1);const observed=await value.service.execute(value.raw(value.read));assert.equal(observed.verified,true);assert.equal(observed.published,false);
});
test('evidence not-observed is distinct from a committed archive',async()=>{
 const value=setup(),result=await value.service.execute(value.raw(value.read));assert.equal(result.state,'not-observed');assert.equal(result.verified,false);assert.equal(value.counts().writes,0);
});
for(const [label,change]of [
 ['wrong payload hash',value=>value.read.sha256='0'.repeat(64)],
 ['changed stored bytes',value=>value.rows().get(value.key).payload_json+=' '],
 ['future archive clock',value=>value.rows().get(value.key).updated_at=fixture.stamp(fixture.NOW+60000)],
 ['wrong artifact version',value=>value.rows().get(value.key).artifact_version='other'],
])test('archive read refuses '+label,async()=>{
 const value=setup();await value.service.execute(value.raw(value.request));change(value);await assert.rejects(value.service.execute(value.raw(value.read)));assert.equal(value.counts().writes,1);
});
test('evidence requests preserve old 1MiB limit, canonical UTF8, hash and identity checks',()=>{
 const value=setup();assert.deepEqual(decodeRequest(value.raw(value.request)),value.request);assert.deepEqual(decodeRequest(value.raw(value.read)),value.read);
 for(const changed of [{...value.read,key:'arbitrary'}, {...value.read,path:'/tmp/x'}, {...value.request,sha256:'0'.repeat(64)}, {...value.request,json:JSON.stringify(value.packet,null,2),sha256:policy.sha(JSON.stringify(value.packet,null,2))}])assert.throws(()=>decodeRequest(value.raw(changed)));
 assert.throws(()=>decodeRequest(Buffer.alloc(MAX_REQUEST_BYTES+1)),{code:'RESEARCH_REQUEST_BOUND'});
});
test('evidence mutation has durable intent; evidence reads use new observations',()=>{
 const value=setup(),raw=value.raw(value.request),read=value.raw(value.read);
 assert.equal(requestJournalIdentity(raw).journalId,requestJournalIdentity(raw).journalId);
 assert.notEqual(requestJournalIdentity(read).journalId,requestJournalIdentity(read).journalId);
 assert.equal(requestJournalIdentity(read).readOnly,true);
});
test('broker response binds evidence archive identity without claiming recommendation publication',async()=>{
 const value=setup(),result={ok:true,...await value.service.execute(value.raw(value.request))},raw=value.raw(value.request),releaseSha='a'.repeat(64),finishedAt=fixture.stamp(fixture.NOW+1000);
 const envelope={version:'research-broker-result-v1',requestSha:policy.sha(raw),releaseSha,finishedAt,automaticWriteRetry:false,code:0,overflow:false,stderr:'',stdout:JSON.stringify(result)};
 const decode=body=>decodeBrokerResponse(Buffer.from(JSON.stringify(body)),raw,{releaseSha},fixture.NOW,fixture.NOW+2000);
 assert.equal(decode(envelope).verified,true);
 const replay=replayEnvelope(Buffer.from(JSON.stringify(envelope)),policy.sha(raw),releaseSha,fixture.stamp(fixture.NOW+1500));assert.equal(decode(replay).replayedReceipt,true);
 for(const patch of [{published:true},{key:'team-evidence-'+'0'.repeat(64)},{payloadSha256:'0'.repeat(64)},{observedAt:fixture.stamp(fixture.NOW+1001)},{commitAcknowledged:false},{verified:false}])assert.throws(()=>decode({...envelope,stdout:JSON.stringify({...result,...patch})}),{code:'RESEARCH_BROKER_RESPONSE_UNVERIFIED'});
});
