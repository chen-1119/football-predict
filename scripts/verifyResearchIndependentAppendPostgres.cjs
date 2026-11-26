'use strict';
// Synthetic signed V4 evidence; caller owns an isolated PG cluster and holds
// the global shared reader throughout. No production identity or data is used.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs'),f=require('../tests/fixtures/reviewed-official-event.cjs');
async function verify(pool){
 const schema='independent_append_'+process.pid+'_'+Date.now(),sql=s=>s.replaceAll('football.',schema+'.'),q=(s,v)=>pool.query(sql(s),v);
 const signed=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-independent-append'});
 const snapshotPath=path.join(path.dirname(signed.registryPath),'snapshot.json'),previous=process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;
 process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=snapshotPath;let clock=f.NOW+100,dropCommit=false,nativeReads=0;
 const mapped={async connect(){const c=await pool.connect();let readonly=false;return {release:e=>c.release(e),async query(s,args){
  if(s.startsWith('BEGIN'))readonly=s.includes('READ ONLY');
  if(s.includes('match_snapshots')){nativeReads++;throw Error('Independent lane cannot read native events');}
  const r=await c.query(sql(s),args);if(s==='SELECT clock_timestamp() AS now')return {rows:[{now:new Date(clock++)}]};
  if(s==='COMMIT'&&!readonly&&dropCommit){dropCommit=false;throw Error('Injected lost COMMIT reply');}return r;
 }};}};
 function archive(d){const old=JSON.parse(d.originalArchive);old.singles=d.singles.map(({classification,...r})=>{void classification;return r;});d.originalArchive=JSON.stringify(old);d.originalArchiveSha256=p.sha(d.originalArchive);return d;}
 try{
  await pool.query('CREATE SCHEMA '+schema);await q('CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)');
  const source=f.setup(signed.keyPair);fs.writeFileSync(snapshotPath,JSON.stringify(source.snapshot));
  const service=require('../server/researchWriteService.cjs').createResearchWriteService({pool:mapped,runExclusive:fn=>fn()});
  const json=JSON.stringify(source.draft),input=Buffer.from(JSON.stringify({version:'research-broker-request-v1',action:'publish',json,sha256:p.sha(json),draftHash:p.hash(source.draft)}));
  const base=await service.execute(input);a.equal(base.verified,true);a.equal(base.submitted,true);
  const originals=(await q('SELECT artifact_key,payload::text AS json,payload_sha256 FROM football.private_model_artifacts ORDER BY artifact_key')).rows;a.equal(originals.length,2);
  const saved=JSON.parse(originals.find(r=>r.artifact_key===base.recordKey).json);a.equal(JSON.stringify(saved.draft),json);a.deepEqual(p.make(saved.draft,{...saved.inputs,trustRegistry:source.trustRegistry,asOf:saved.record.createdAt}),saved.record);
  const d=archive({...structuredClone(source.draft),singles:[{...structuredClone(source.draft.singles[0]),selection:'a',sp:4.5,scores:[[0,1],[1,2]],reason:'Synthetic new evidence'}]});
  const request={version:'reviewed-single-request-v1',baseRecordKey:base.recordKey,basePayloadSha256:base.payloadSha256,eventId:d.singles[0].eventId,revision:1,previousRevisionHash:null,draft:d,draftHash:p.hash(d)};
  const revisions=require('../server/researchReviewedRevision.cjs').createRevisionStore({pool:mapped,runExclusive:fn=>fn()});
  const revised=await revisions.publish(request);a.equal(revised.verified,true);a.equal(revised.latestDecision.selection,'a');a.equal(revised.originalDecision.selection,'h');a.equal(revised.independentEventIncrement,0);
  const runtime=require('./recommendationPlatform/reviewedAnalysisRuntime.cjs'),tx=require('./recommendationPlatform/leagueBaselineRuntime.cjs').transaction;
  const view=await tx(mapped,true,c=>runtime.projection(c,source.draft.businessDate,f.stamp(clock+1)));
  const prepared=require('../services/recommendation/comboArchive.cjs').prepare(view,{generationId:'g-'+'a'.repeat(64),committedAt:f.stamp(clock+2)},f.stamp(clock+3));clock+=10;
  const aj=JSON.stringify(prepared.archive);await q('INSERT INTO football.private_model_artifacts VALUES($1,$2,$3,$4,$5::json,$6,$7)',[prepared.key,prepared.archive.version,prepared.archive.createdAt,prepared.archive.createdAt,aj,p.sha(aj),Buffer.byteLength(aj)]);
  const comboDraft=archive(structuredClone(source.draft));
  const comboRequest={version:'reviewed-combo-request-v1',size:2,band:2.5,baseArchiveKey:prepared.key,baseArchiveSha256:p.sha(aj),bases:comboDraft.singles.map(s=>({eventId:s.eventId,baseRecordKey:base.recordKey,basePayloadSha256:base.payloadSha256})),revision:1,previousRevisionHash:null,draft:comboDraft,draftHash:p.hash(comboDraft)};
  const combos=require('../server/researchComboRevision.cjs').createComboRevisionStore({pool:mapped,runExclusive:fn=>fn()});
  const combo=await combos.publish(comboRequest);a.equal(combo.verified,true);a.equal(combo.combo.product,3.456);
  const next={...request,revision:2,previousRevisionHash:revised.payloadSha256};dropCommit=true;
  await a.rejects(revisions.publish(next),{code:'REVIEW_REVISION_COMMIT_UNKNOWN_READ_FIRST'});a.equal((await revisions.read(next)).state,'record-present-ack-missing');a.equal((await revisions.publish(next)).submitted,false);
  for(const original of originals){const row=(await q('SELECT payload::text AS json,payload_sha256 FROM football.private_model_artifacts WHERE artifact_key=$1',[original.artifact_key])).rows[0];a.equal(row.json,original.json);a.equal(row.payload_sha256,original.payload_sha256);}
  a.equal((await service.execute(input)).submitted,false);a.equal(nativeReads,0);
  const raceSchema=schema+'_race';let holder;
  try{
   await pool.query('CREATE SCHEMA '+raceSchema);await pool.query('CREATE TABLE '+raceSchema+'.private_model_artifacts (LIKE '+schema+'.private_model_artifacts INCLUDING ALL)');
   const racePool={async connect(){const c=await mapped.connect();return {release:e=>c.release(e),query:(s,v)=>c.query(s.replaceAll('football.',raceSchema+'.'),v)};}};
   const raceService=require('../server/researchWriteService.cjs').createResearchWriteService({pool:racePool,runExclusive:fn=>fn()});
   const other=archive(structuredClone(source.draft));other.singles[0].reason='Different immutable draft for the same events';archive(other);const otherJson=JSON.stringify(other),otherInput=Buffer.from(JSON.stringify({version:'research-broker-request-v1',action:'publish',json:otherJson,sha256:p.sha(otherJson),draftHash:p.hash(other)}));
   const {APPEND_KEY}=require('../server/researchAppendLock.cjs');holder=await pool.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))',[APPEND_KEY]);
   const competing=Promise.allSettled([raceService.execute(input),raceService.execute(otherInput)]);let bothQueued=false;
   for(let i=0;i<100;i++){const n=Number((await pool.query("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND objsubid=1 AND objid=((hashtext($1)::bigint & 4294967295)::oid) AND NOT granted",[APPEND_KEY])).rows[0].n);if(n===2){bothQueued=true;break;}await new Promise(r=>setTimeout(r,10));}
   await holder.query('ROLLBACK');holder.release();holder=null;const results=await competing;a.equal(bothQueued,true);a.equal(results.filter(r=>r.status==='fulfilled').length,1);
   const failed=results.find(r=>r.status==='rejected');a(['40001','55P03','23505','REVIEWED_ANALYSIS_EVENT_ALREADY_PUBLISHED'].includes(failed.reason.code),failed.reason.stack);
   const rows=(await pool.query('SELECT payload::text AS json FROM '+raceSchema+'.private_model_artifacts')).rows;a.equal(rows.length,2);const freeze=rows.map(r=>JSON.parse(r.json)).find(v=>v.version==='reviewed-analysis-freeze-v1');a.equal(JSON.stringify(freeze.draft),results[0].status==='fulfilled'?json:otherJson);
   const confirmed=await raceService.execute(results[0].status==='fulfilled'?input:otherInput);a.equal(confirmed.verified,true);a.equal(confirmed.submitted,false);
  }finally{if(holder){await holder.query('ROLLBACK');holder.release();}await pool.query('DROP SCHEMA IF EXISTS '+raceSchema+' CASCADE');}
  return {ok:true,v4FirstPublishAndSecondAck:true,v4SingleRevisionAndSecondAck:true,v4ComboRevisionAndSecondAck:true,completeOriginalSignedReplay:true,unknownCommitReadFirst:true,originalBytesPreserved:true,overlappingEventsDifferentDraftsBothQueuedBeforeReleaseOneExactAckedWinner:true,nativeReads,productionWrites:0};
 }finally{if(previous===undefined)delete process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;else process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=previous;try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{signed.cleanup();}}
}
module.exports={verify};
