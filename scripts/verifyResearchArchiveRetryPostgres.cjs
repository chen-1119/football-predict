'use strict';
// A disposable local schema and synthetic immutable report. No production
// journal, socket, account, database or signing key is used.
const a=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createResearchWriteService}=require('../server/researchWriteService.cjs'),retry=require('../server/researchArchiveRetry.cjs');
const sha=x=>createHash('sha256').update(x).digest('hex');
async function verify(pool){
 const schema='archive_retry_'+process.pid+'_'+Date.now(),sql=s=>s.replaceAll('football.',schema+'.'),q=(s,args)=>pool.query(sql(s),args);
 let holder,writes=0;const mapped={async connect(){const c=await pool.connect();return{release:e=>c.release(e),async query(s,args){if(/^INSERT|^UPDATE|^DELETE/.test(s.trim()))writes++;return c.query(sql(s),args);}};}};
 try{
  await pool.query('CREATE SCHEMA '+schema);await q('CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)');
  const report={version:'cloud-research-report-v1',businessDate:'2026-10-17',reportKind:'weekend-2200-full',generatedAt:'2026-10-17T14:05:35.808Z',contents:{text:'Synthetic exact archive 中文 😀\n'+ '原始字节 '.repeat(3000),verified:false}},json=JSON.stringify(report,null,2)+'\n';
  const original={version:'research-broker-request-v1',action:'archive',json,sha256:sha(json)},originalRequestJson=JSON.stringify(original),originalRequestSha256=sha(originalRequestJson),service=createResearchWriteService({pool:mapped,runExclusive:fn=>fn()});
  holder=await pool.connect();await holder.query("SELECT pg_advisory_lock(hashtext('football-postgres-projection-sync-v1'))");
  await a.rejects(service.execute(Buffer.from(originalRequestJson)),{code:'55P03'});a.equal(writes,0);a.equal(Number((await q('SELECT count(*) AS n FROM football.private_model_artifacts')).rows[0].n),0);
  const receipt={version:'research-broker-result-v1',requestSha:originalRequestSha256,releaseSha:'a'.repeat(64),finishedAt:new Date().toISOString(),code:1,overflow:false,stdout:'',stderr:JSON.stringify({ok:false,error:'55P03',retryWriteAutomatically:false})+'\n',automaticWriteRetry:false},receiptJson=JSON.stringify(receipt),intent=JSON.stringify({version:'research-broker-intent-v1',requestSha:originalRequestSha256,releaseSha:receipt.releaseSha,admittedAt:receipt.finishedAt,automaticWriteRetry:false});
  const request={version:original.version,action:'archive-retry',originalRequestJson,originalRequestSha256,failedReceiptSha256:sha(receiptJson)};retry.verifyFailure(request,file=>Buffer.from(file.endsWith('.receipt.json')?receiptJson:intent));
  await holder.query("SELECT pg_advisory_unlock(hashtext('football-postgres-projection-sync-v1'))");holder.release();holder=null;
  const result=await service.execute(Buffer.from(JSON.stringify(request)));a.equal(result.state,'report-archived');a.equal(result.explicitRetry,true);a.equal(result.submitted,true);a.equal(result.inserted,true);a.equal(result.commitAcknowledged,true);a.equal(result.originalJson,json);a.equal(result.sha256,sha(json));a.equal(result.bytes,Buffer.byteLength(json));a.equal(writes,1);
  const before=(await q('SELECT artifact_key,payload::text AS json,payload_sha256,updated_at FROM football.private_model_artifacts')).rows;a.equal(before.length,1);a.equal(before[0].json,json);
  const repeat=await service.execute(Buffer.from(JSON.stringify(request)));a.equal(repeat.submitted,false);a.equal(repeat.inserted,false);a.equal(repeat.commitAcknowledged,undefined);a.equal(repeat.receivedAt,result.receivedAt);a.equal(writes,1);a.deepEqual((await q('SELECT artifact_key,payload::text AS json,payload_sha256,updated_at FROM football.private_model_artifacts')).rows,before);
  const other={...original,json:json+' ',sha256:sha(json+' ')},otherBytes=JSON.stringify(other),conflict={...request,originalRequestJson:otherBytes,originalRequestSha256:sha(otherBytes)};
  await a.rejects(service.execute(Buffer.from(JSON.stringify(conflict))),{code:'REPORT_IMMUTABLE_CONFLICT'});a.equal(writes,1);
  a.equal(JSON.stringify(receipt),receiptJson);a.equal(request.originalRequestJson,originalRequestJson);
  return{ok:true,scope:'disposable-native-postgres',realOriginalLockTimeout55P03:true,originalRequestBytesUnchanged:true,freshReadBeforeRetry:true,normalSerializableArchiveCommit:true,independentFullUtf8Readback:true,duplicateDoesNotWrite:true,immutableConflictRefused:true,failedReceiptPreserved:true,productionWrites:0,productionRootBrokerVerified:false};
 }finally{if(holder){await holder.query('SELECT pg_advisory_unlock_all()');holder.release();}await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}
}
if(require.main===module){const u=new URL(process.env.RESEARCH_REPORT_TEST_DATABASE_URL||'invalid:');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Explicit disposable local database required');const pool=new(require('pg').Pool)({connectionString:u.href,ssl:false,max:4});verify(pool).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
