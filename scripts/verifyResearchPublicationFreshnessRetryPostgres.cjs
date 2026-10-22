'use strict';
// Real transactions in an explicitly disposable local database; all sources,
// clocks, release identities and collector keys are synthetic test inputs.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs'),f=require('../tests/fixtures/reviewed-official-event.cjs');
const retry=require('../server/researchPublicationFreshnessRetry.cjs');
const {transaction}=require('./recommendationPlatform/leagueBaselineRuntime.cjs');
async function verify(pool){
 const schema='freshness_retry_'+process.pid+'_'+Date.now(),sql=s=>s.replaceAll('football.',schema+'.'),q=(s,args)=>pool.query(sql(s),args);
 const signed=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-freshness-retry'});
 const snapshotPath=path.join(path.dirname(signed.registryPath),'freshness-snapshot.json'),previous=process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;
 process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=snapshotPath;
 let clock=f.NOW+100,nativeReads=0,readWrites=0,writeCommits=0,loseCommit=false;
 const mapped={async connect(){const c=await pool.connect();let readOnly=false,inserted=false;return {release:e=>c.release(e),async query(s,args){
  if(s.startsWith('BEGIN')){readOnly=s.includes('READ ONLY');inserted=false;}
  if(s.includes('match_snapshots')){nativeReads++;throw Error('No native event table exists in this V4 fixture');}
  if(readOnly&&/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(s))readWrites++;
  if(/^\s*INSERT\b/.test(s))inserted=true;
  const out=await c.query(sql(s),args);
  if(s==='SELECT clock_timestamp() AS now')return {rows:[{now:new Date(clock++)}]};
  if(s==='COMMIT'&&inserted){writeCommits++;if(loseCommit){loseCommit=false;throw Error('Synthetic lost COMMIT reply');}}
  return out;
 }};}};
 try{
  await pool.query('CREATE SCHEMA '+schema);
  await q('CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)');
  const v=f.setup(signed.keyPair),freshBytes=JSON.stringify(v.snapshot),stale=structuredClone(v.snapshot);
  for(const e of stale.endpoints){e.requestedAt=f.stamp(f.NOW-61000);e.receivedAt=f.stamp(f.NOW-60000);f.resign(e,signed.keyPair);}
  fs.writeFileSync(snapshotPath,JSON.stringify(stale));
  const json=JSON.stringify(v.draft),original={version:'research-broker-request-v1',action:'publish',draftHash:p.hash(v.draft),json,sha256:p.sha(json)};
  const originalRequestJson=JSON.stringify(original),originalRequestSha256=p.sha(originalRequestJson);
  // Reproduce the exact original V4 policy failure before any INSERT, inside
  // the publisher's actual SERIALIZABLE transaction and projection lock.
  // The new fresh-input waiter is deliberately not used for this old failure.
  await a.rejects(transaction(mapped,false,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-postgres-projection-sync-v1']);
   const at=(await c.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
   p.make(v.draft,{matches:[],snapshot:stale,trustRegistry:signed.keyPair.registry,asOf:at});
  }),{code:retry.ERROR});
  a.equal(Number((await q('SELECT count(*) AS n FROM football.private_model_artifacts')).rows[0].n),0);
  a.equal(writeCommits,0);
  const releaseSha='a'.repeat(64),finishedAt=f.stamp(clock++);
  const intentJson=JSON.stringify({version:'research-broker-intent-v1',requestSha:originalRequestSha256,releaseSha,admittedAt:f.stamp(f.NOW),automaticWriteRetry:false});
  const receiptJson=JSON.stringify({version:'research-broker-result-v1',requestSha:originalRequestSha256,releaseSha,finishedAt,code:1,overflow:false,stdout:'',stderr:JSON.stringify({ok:false,error:retry.ERROR,retryWriteAutomatically:false})+'\n',automaticWriteRetry:false})+'\n';
  const request={version:original.version,action:retry.ACTION,originalRequestJson,originalRequestSha256,failedReceiptSha256:p.sha(receiptJson)};
  retry.verifyFailure(request,file=>{const base='/var/lib/football-research-broker/'+originalRequestSha256;a.ok([base+'.intent.json',base+'.receipt.json'].includes(file));return Buffer.from(file.endsWith('.receipt.json')?receiptJson:intentJson);},{releaseSha:'b'.repeat(64),freshInputSourceSha256:retry.REQUIRED_FRESH_INPUT_SHA256},f.stamp(clock++));
  fs.writeFileSync(snapshotPath,freshBytes);
  const service=require('../server/researchWriteService.cjs').createResearchWriteService({pool:mapped,runExclusive:fn=>fn()});
  const raw=Buffer.from(JSON.stringify(request)),result=await service.execute(raw);
  a.equal(result.verified,true);a.equal(result.explicitFreshnessRetry,true);a.equal(result.submitted,true);a.equal(result.records.length,2);
  a.equal(result.originalRequestSha256,originalRequestSha256);a.equal(writeCommits,2,'record and ACK must commit separately');
  const key=result.recordKey,rows=async()=>(await q('SELECT artifact_key,payload::text AS json,payload_sha256 FROM football.private_model_artifacts ORDER BY artifact_key')).rows;
  const saved=await rows();a.equal(saved.length,2);
  const freeze=JSON.parse(saved.find(r=>r.artifact_key===key).json);
  a.equal(JSON.stringify(freeze.draft),json);a.deepEqual(p.make(freeze.draft,{...freeze.inputs,trustRegistry:signed.keyPair.registry,asOf:freeze.record.createdAt}),freeze.record);
  const ack=JSON.parse(saved.find(r=>r.artifact_key===key+'-ack').json);a.equal(ack.recordKey,key);a.equal(ack.storedSha256,result.payloadSha256);a.equal(ack.recordHash,freeze.record.contentHash);
  a.equal(JSON.stringify(freeze.inputs.snapshot),freshBytes);a.equal(freeze.record.draftHash,original.draftHash);
  const duplicate=await service.execute(raw);a.equal(duplicate.submitted,false);a.equal(duplicate.verified,true);a.deepEqual(await rows(),saved);a.equal(writeCommits,2);
  const read=await service.execute(Buffer.from(JSON.stringify({version:original.version,action:'publication-read',recordKey:key,draftHash:original.draftHash})));
  a.equal(read.verified,true);a.equal(read.payloadSha256,result.payloadSha256);a.equal(read.ackSha256,result.ackSha256);
  // Only disposable fixture rows are changed to exercise partial outcomes.
  await q('DELETE FROM football.private_model_artifacts WHERE artifact_key=$1',[key+'-ack']);
  const partialBefore=await rows(),partial=await service.execute(raw);a.equal(partial.state,'record-present-ack-missing');a.equal(partial.submitted,false);a.deepEqual(await rows(),partialBefore);
  await q('DELETE FROM football.private_model_artifacts WHERE artifact_key=$1',[key]);
  const savedAck=saved.find(r=>r.artifact_key===key+'-ack'),ackObject=JSON.parse(savedAck.json);
  await q('INSERT INTO football.private_model_artifacts VALUES($1,$2,$3,$4,$5::json,$6,$7)',[key+'-ack',ackObject.version,ackObject.createdAt,ackObject.createdAt,savedAck.json,savedAck.payload_sha256,Buffer.byteLength(savedAck.json)]);
  const orphanBefore=await rows(),orphan=await service.execute(raw);a.equal(orphan.state,'orphan-ack-unverified');a.equal(orphan.submitted,false);a.deepEqual(await rows(),orphanBefore);
  await q('TRUNCATE football.private_model_artifacts');loseCommit=true;
  await a.rejects(service.execute(raw),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});
  const unknownBefore=await rows();a.equal(unknownBefore.length,1);
  const unknown=await service.execute(raw);a.equal(unknown.state,'record-present-ack-missing');a.equal(unknown.submitted,false);a.deepEqual(await rows(),unknownBefore);
  a.equal(request.originalRequestJson,originalRequestJson);a.equal(p.sha(receiptJson),request.failedReceiptSha256);a.equal(fs.readFileSync(snapshotPath,'utf8'),freshBytes);a.equal(nativeReads,0);a.equal(readWrites,0);
  return {ok:true,scope:'disposable-postgres-synthetic-clock',realV4FreshnessFailureInTransaction:true,originalFailureZeroRows:true,exactOriginalRequestPreserved:true,freshDualSignedSource:true,normalExplicitRetry:true,separateCommitAndAck:true,completeSignedReplay:true,independentRead:true,duplicateZeroAdditionalWrites:true,partialRecordRefused:true,orphanAckRefused:true,unknownCommitReadFirst:true,nativeReads,readWrites,productionWrites:0,productionRootBrokerVerified:false};
 }finally{
  if(previous===undefined)delete process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;else process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=previous;
  try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{signed.cleanup();}
 }
}
if(require.main===module){const value=process.env.RESEARCH_REPORT_TEST_DATABASE_URL,u=new URL(value||'invalid:');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Explicit disposable local recommendation_test required');const pool=new(require('pg').Pool)({connectionString:value,ssl:false,max:4});verify(pool).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
