'use strict';
// Synthetic signed quotes and a disposable local schema. No production journal,
// socket, account, database or release key is read or written.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs'),f=require('../tests/fixtures/signed-live-had.cjs');
const {createResearchWriteService}=require('../server/researchWriteService.cjs'),retry=require('../server/researchPublicationRetry.cjs'),recovery=require('../server/researchPublicationInputRecovery.cjs');
async function verify(pool){
 const schema='research_input_recovery_'+process.pid+'_'+Date.now(),sql=s=>s.replaceAll('football.',schema+'.'),q=(s,args)=>pool.query(sql(s),args);
 const signed=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-publish-retry'}),snapshotPath=path.join(path.dirname(signed.registryPath),'retry-snapshot.json'),previous=process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;
 process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=snapshotPath;let clock=f.NOW+100,holder;
 const mapped={async connect(){const c=await pool.connect();return{release:e=>c.release(e),async query(s,args){const out=await c.query(sql(s),args);if(s==='SELECT clock_timestamp() AS now')return{rows:[{now:new Date(clock++)}]};return out;}};}};
 try{
  await pool.query('CREATE SCHEMA '+schema);await q('CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)');await q('CREATE TABLE football.match_snapshots(dataset text,payload json)');
  const matches=[{...f.source(1),buyEndTime:'2026-09-17 22:00:00'}],source=f.snapshot(matches,{pair:signed.keyPair,mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach(r=>{r.homeTeamId=10;r.awayTeamId=11;})});fs.writeFileSync(snapshotPath,JSON.stringify(source.snapshot));
  const nested=structuredClone(matches[0]);delete nested.buyEndTime;
  const broken={...matches[0],prospectiveForecastInput:nested};
  await q("INSERT INTO football.match_snapshots VALUES('current',$1::json)",[JSON.stringify(broken)]);
  const m=matches[0],singles=[{eventId:String(m.sourceMatchId),matchNum:m.matchNo,businessDate:m.businessDate,kickoff:m.kickoffTime,market:'HAD',handicap:null,selection:'h',scores:[[2,0],[3,1]],confidence:'低',reason:'Synthetic independent research',analysisUrl:'https://example.com/preview',teams:[m.homeTeamName,m.awayTeamName],orderedTeamIds:[10,11],sp:1.8,modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'}];
  const frozenAt=f.stamp(f.NOW-60000),archive=JSON.stringify({version:1,reportKind:'on-demand-prematch-supplement',predictionScope:'chat-only manual research',businessDate:m.businessDate,frozenAt,singles});
  const draft={version:3,reportKind:'manual-prematch-batch',predictionScope:'reviewed-online-reference',businessDate:m.businessDate,frozenAt,singles,originalArchive:archive,originalArchiveSha256:p.sha(archive)},json=JSON.stringify(draft),original={version:'research-broker-request-v1',action:'publish',draftHash:p.hash(draft),json,sha256:p.sha(json)},originalRequestJson=JSON.stringify(original),originalRequestSha256=p.sha(originalRequestJson);
  const service=createResearchWriteService({pool:mapped,runExclusive:fn=>fn()});holder=await pool.connect();await holder.query("SELECT pg_advisory_lock(hashtext('football-postgres-projection-sync-v1'))");
  await a.rejects(service.execute(Buffer.from(originalRequestJson)),{code:'55P03'});a.equal(Number((await q('SELECT count(*) AS n FROM football.private_model_artifacts')).rows[0].n),0);
  const receipt={version:'research-broker-result-v1',requestSha:originalRequestSha256,releaseSha:'a'.repeat(64),finishedAt:new Date().toISOString(),code:1,overflow:false,stdout:'',stderr:JSON.stringify({ok:false,error:'55P03',retryWriteAutomatically:false})+'\n',automaticWriteRetry:false},receiptJson=JSON.stringify(receipt),intent=JSON.stringify({version:'research-broker-intent-v1',requestSha:originalRequestSha256,releaseSha:receipt.releaseSha,admittedAt:receipt.finishedAt,automaticWriteRetry:false});
  const request={version:original.version,action:'publication-retry',originalRequestJson,originalRequestSha256,failedReceiptSha256:p.sha(receiptJson)};retry.verifyFailure(request,file=>Buffer.from(file.endsWith('.receipt.json')?receiptJson:intent));
  await holder.query("SELECT pg_advisory_unlock(hashtext('football-postgres-projection-sync-v1'))");holder.release();holder=null;
  await a.rejects(service.execute(Buffer.from(JSON.stringify(request))),{code:'REVIEWED_ANALYSIS_PROSPECTIVE'});
  a.equal(Number((await q('SELECT count(*) AS n FROM football.private_model_artifacts')).rows[0].n),0);
  const priorRetryRequestJson=JSON.stringify(request),priorRetryRequestSha256=p.sha(priorRetryRequestJson);
  const last={...receipt,requestSha:priorRetryRequestSha256,finishedAt:new Date().toISOString(),stderr:JSON.stringify({ok:false,error:'REVIEWED_ANALYSIS_PROSPECTIVE',retryWriteAutomatically:false})+'\n'};
  const lastJson=JSON.stringify(last),lastIntent=JSON.stringify({version:'research-broker-intent-v1',requestSha:priorRetryRequestSha256,releaseSha:last.releaseSha,admittedAt:last.finishedAt,automaticWriteRetry:false});
  const recoveryRequest={version:original.version,action:'publication-input-recovery',priorRetryRequestJson,priorRetryRequestSha256,failedRetryReceiptSha256:p.sha(lastJson)};
  const read=file=>{const base='/var/lib/football-research-broker/';const files={[base+originalRequestSha256+'.receipt.json']:receiptJson,[base+originalRequestSha256+'.intent.json']:intent,[base+retry.journalId(request)+'.receipt.json']:lastJson,[base+retry.journalId(request)+'.intent.json']:lastIntent};a.ok(files[file]);return Buffer.from(files[file]);};
  recovery.verifyFailures(recoveryRequest,read,{releaseSha:'b'.repeat(64),repairSourceSha256:p.sha(fs.readFileSync(path.join(__dirname,'syncData.cjs')))});
  const raw={...nested,homeTeam:m.homeTeamName,awayTeam:m.awayTeamName,buyEndTime:''};
  const enriched=require('./syncData.cjs').enrichRawMatchWithPredictionSnapshot(raw,new Map([[m.sourceMatchId,m]]),[]);
  a.equal(enriched.buyEndTime,m.buyEndTime);
  const fixed=require('../src/services/prospectiveForecastInput.cjs').attachProspectiveForecastInputs([m],[{...nested,buyEndTime:enriched.buyEndTime}],f.NOW)[0];
  a.equal(require('../src/services/prdPaperRecommendation.cjs').quoteInput(fixed).buyEndTime,m.buyEndTime);
  await q("UPDATE football.match_snapshots SET payload=$1::json WHERE dataset='current'",[JSON.stringify(fixed)]);
  const result=await service.execute(Buffer.from(JSON.stringify(recoveryRequest)));a.equal(result.verified,true);a.equal(result.explicitInputRecovery,true);a.equal(result.submitted,true);a.equal(result.records.length,1);
  const key=result.recordKey,before=(await q('SELECT artifact_key,payload::text AS json FROM football.private_model_artifacts ORDER BY artifact_key')).rows;a.equal(before.length,2);
  const saved=JSON.parse(before.find(r=>r.artifact_key===key).json);a.deepEqual(saved.draft,draft);a.equal(JSON.stringify(saved.draft),json);a.deepEqual(p.make(saved.draft,{...saved.inputs,trustRegistry:source.registry,asOf:saved.record.createdAt}),saved.record);
  const repeat=await service.execute(Buffer.from(JSON.stringify(recoveryRequest)));a.equal(repeat.submitted,false);a.equal(repeat.payloadSha256,result.payloadSha256);a.deepEqual((await q('SELECT artifact_key,payload::text AS json FROM football.private_model_artifacts ORDER BY artifact_key')).rows,before);
  a.equal(JSON.stringify(receipt),receiptJson);a.equal(JSON.stringify(last),lastJson);a.equal(request.originalRequestJson,originalRequestJson);a.equal(recoveryRequest.priorRetryRequestJson,priorRetryRequestJson);
  return{ok:true,scope:'disposable-native-postgres',realOriginalLockTimeout55P03:true,realPriorRetryProspectiveRefusal:true,bothFailuresZeroWrites:true,actualProducerRepair:true,stableSingleRecoveryJournal:true,originalRequestBytesUnchanged:true,freshReadBeforeRetry:true,normalSignedPublisherAndSecondAck:true,completeSignedReplay:true,duplicateDoesNotWrite:true,failedReceiptPreserved:true,productionWrites:0,productionRootBrokerVerified:false};
 }finally{if(holder){await holder.query("SELECT pg_advisory_unlock_all()");holder.release();}if(previous===undefined)delete process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;else process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=previous;try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{signed.cleanup();}}
}
if(require.main===module){const u=new URL(process.env.RESEARCH_REPORT_TEST_DATABASE_URL||'invalid:');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Explicit disposable local database required');const pool=new(require('pg').Pool)({connectionString:u.href,ssl:false,max:4});verify(pool).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
