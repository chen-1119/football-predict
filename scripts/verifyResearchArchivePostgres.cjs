'use strict';
// This verifier writes synthetic evidence only to a unique disposable test schema.
const a=require('node:assert/strict');
const {createResearchArchiveRead}=require('../server/researchArchiveRead.cjs');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs');
const {readPublication}=require('./recommendationPlatform/reviewedAnalysisRuntime.cjs');
const f=require('../tests/fixtures/signed-live-had.cjs');
async function verify(pool){
 const schema=`research_archive_verify_${process.pid}_${Date.now()}`;
 const signed=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-archive-test'});
 const q=(sql,args)=>pool.query(sql.replaceAll('football.',`${schema}.`),args);
 const mapped={async connect(){const c=await pool.connect();return {query:(s,args)=>c.query(s.replaceAll('football.',`${schema}.`),args),release:e=>c.release(e)};}};
 try{
  await pool.query(`CREATE SCHEMA ${schema}`);
  await q(`CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,
   generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)`);
  const matches=[f.source(1),f.source(2),f.source(3)];
  const {snapshot,registry}=f.snapshot(matches,{pair:signed.keyPair,mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;})});
  const at=f.stamp(f.NOW),storedAt=f.stamp(f.NOW+1),ackAt=f.stamp(f.NOW+2);
  const draft={version:1,reportKind:'weekday-2000-selected-two',predictionScope:'chat-only research',businessDate:'2026-09-17',frozenAt:f.stamp(f.NOW-60000),
   singles:matches.map((m,i)=>({eventId:String(m.sourceMatchId),matchNum:m.matchNo,businessDate:m.businessDate,kickoff:m.kickoffTime,
    market:'HAD',handicap:null,selection:'h',scores:[[2,0],[3,1]],confidence:'中',reason:'Synthetic integration fixture',analysisUrl:'https://example.com/preview',
    teams:[m.homeTeamName,m.awayTeamName],orderedTeamIds:[10+i*2,11+i*2],sp:1.8,modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'}))};
  const record=p.make(draft,{matches,snapshot,trustRegistry:registry,asOf:at});
  const key='reviewed-analysis-2026-09-17-selected-two';
  const freeze=p.seal({version:'reviewed-analysis-freeze-v1',createdAt:at,record,draft,inputs:{matches,snapshot},storedAt});
  const original=JSON.stringify(freeze),digest=p.sha(original);
  const ack=p.seal({version:'reviewed-analysis-ack-v1',createdAt:ackAt,recordKey:key,storedSha256:digest,recordHash:record.contentHash});
  const insert=async(k,value)=>{const json=JSON.stringify(value);await q(`INSERT INTO football.private_model_artifacts VALUES($1,$2,$3,$3,$4::json,$5,$6)`,[k,value.version,value.createdAt,json,p.sha(json),Buffer.byteLength(json)]);};
  await insert(key,freeze);await insert(key+'-ack',ack);
  const reader=createResearchArchiveRead({pool:mapped,replay:readPublication});
  const result=await reader.artifact(key);
  a.equal(result.verified,true);a.equal(result.record.json,original);a.equal(result.record.sha256,digest);a.equal(result.productionWrites,0);
  const index=await reader.day('2026-09-17');a.equal(index.existingBatchCount,1);a.equal(index.publications[0].verified,false);
  // Complete signed v3 freeze and original second ACK, disposable schema only.
  const originalArchive=JSON.stringify({version:1,reportKind:'on-demand-prematch-supplement',predictionScope:'chat-only manual research',businessDate:draft.businessDate,frozenAt:draft.frozenAt,singles:draft.singles});
  const v3={...draft,version:3,reportKind:'manual-prematch-batch',predictionScope:'reviewed-online-reference',originalArchive,originalArchiveSha256:p.sha(originalArchive)};
  const record3=p.make(v3,{matches,snapshot,trustRegistry:registry,asOf:at});
  const key3='reviewed-analysis-'+v3.businessDate+'-batch-'+p.hash(v3);
  const freeze3=p.seal({version:'reviewed-analysis-freeze-v1',createdAt:at,record:record3,draft:v3,inputs:{matches,snapshot},storedAt});
  const ack3=p.seal({version:'reviewed-analysis-ack-v1',createdAt:ackAt,recordKey:key3,storedSha256:p.sha(JSON.stringify(freeze3)),recordHash:record3.contentHash});
  await insert(key3,freeze3);await insert(key3+'-ack',ack3);
  let brokerHeld=false;
  const service=require('../server/researchWriteService.cjs').createResearchWriteService({pool:mapped,runExclusive:async action=>{a.equal(brokerHeld,false);brokerHeld=true;try{return await action();}finally{brokerHeld=false;}}});
  const request={version:'research-broker-request-v1',action:'publish',json:JSON.stringify(v3),sha256:p.sha(JSON.stringify(v3)),draftHash:p.hash(v3)};
  const duplicate=await service.execute(Buffer.from(JSON.stringify(request)));
  a.equal(duplicate.submitted,false);a.equal(duplicate.verified,true);a.equal(duplicate.records.length,3);a.equal(brokerHeld,false);
  await q('DELETE FROM football.private_model_artifacts WHERE artifact_key=$1',[key3+'-ack']);
  const missing=await service.execute(Buffer.from(JSON.stringify(request)));a.equal(missing.state,'record-present-ack-missing');a.equal(missing.submitted,false);
  a.equal(Number((await q('SELECT count(*) AS n FROM football.private_model_artifacts WHERE artifact_key=$1',[key3])).rows[0].n),1);
  await insert(key3+'-ack',ack3);
  const cannotWrite=createResearchArchiveRead({pool:mapped,replay:async c=>c.query('DELETE FROM football.private_model_artifacts')});
  await a.rejects(cannotWrite.artifact(key),{code:'25006'});
  a.equal((await reader.artifact(key)).verified,true);
  await q('DELETE FROM football.private_model_artifacts WHERE artifact_key=$1',[key+'-ack']);
  a.equal((await reader.artifact(key)).state,'record-present-ack-missing');
  await insert(key+'-ack',ack);
  await q("UPDATE football.private_model_artifacts SET payload_sha256=repeat('0',64) WHERE artifact_key=$1",[key]);
  await a.rejects(reader.artifact(key),/payload SHA-256 mismatch/);
  return {ok:true,scope:'disposable-local-schema',signedReplay:true,originalBytes:true,readOnlyWriteRejected:true,missingAckRejected:true,tamperRejected:true,brokerExistingPublicationReplay:true,brokerMissingAckNoRewrite:true,productionRowsWritten:0};
 }finally{try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{signed.cleanup();}}
}
if(require.main===module){const url=process.env.RESEARCH_ARCHIVE_TEST_DATABASE_URL;if(!url)throw Error('Explicit disposable database required');const u=new URL(url);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Local recommendation_test only');const pool=new(require('pg').Pool)({connectionString:url,ssl:false,max:2});verify(pool).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
