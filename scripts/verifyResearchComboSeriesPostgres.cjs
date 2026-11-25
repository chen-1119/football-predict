'use strict';
// Real disposable PostgreSQL; synthetic signed events and clock only.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs'),f=require('../tests/fixtures/reviewed-official-event.cjs');
const series=require('../server/researchComboSeries.cjs');
async function verify(pool){
 const schema='combo_series_verify_'+process.pid+'_'+Date.now();
 const signed=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-combo-series'});
 const snapshotPath=path.join(path.dirname(signed.registryPath),'snapshot.json'),previous=process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;
 process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=snapshotPath;
 let clock=f.NOW+100,dropCommit=false,nativeReads=0,readWrites=0;
 const q=(sql,args)=>pool.query(sql.replaceAll('football.',schema+'.'),args);
 const mapped={async connect(){const c=await pool.connect();let readonly=false;return{release:e=>c.release(e),async query(sql,args){
  if(sql.startsWith('BEGIN'))readonly=sql.includes('READ ONLY');
  if(sql.includes('match_snapshots')){nativeReads++;throw Error('Unexpected native event read');}
  if(readonly&&/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(sql))readWrites++;
  const result=await c.query(sql.replaceAll('football.',schema+'.'),args);
  if(sql==='SELECT clock_timestamp() AS now')return{rows:[{now:new Date(clock++)}]};
  if(sql==='COMMIT'&&!readonly&&dropCommit){dropCommit=false;throw Error('Injected lost COMMIT reply');}return result;
 }};}};
 function archive(d){const old=JSON.parse(d.originalArchive);old.singles=d.singles.map(({classification,...r})=>{void classification;return r;});d.originalArchive=JSON.stringify(old);d.originalArchiveSha256=p.sha(d.originalArchive);return d;}
 const wire=(action,r)=>{const json=JSON.stringify(r);return Buffer.from(JSON.stringify({version:'research-broker-request-v1',action,json,sha256:p.sha(json),...(action==='publish'?{draftHash:p.hash(r)}:{})}));};
 try{
  await pool.query('CREATE SCHEMA '+schema);
  await q('CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)');
  await q('CREATE TABLE football.daily_featured_combo_state(id integer PRIMARY KEY,payload json NOT NULL)');
  await q('CREATE TABLE football.projection_meta(key text PRIMARY KEY,value text NOT NULL)');
  for(const [k,v]of Object.entries({data_publication_mode:'active-generation',data_generation_id:'g-'+'a'.repeat(64),manifest_hash:'a'.repeat(64),data_generation_source_cycle_id:'synthetic-cycle',committed_at:f.stamp(f.NOW-1000)}))await q('INSERT INTO football.projection_meta VALUES($1,$2)',[k,v]);
  const v=f.setup(signed.keyPair),third={...structuredClone(v.draft.singles[0]),eventId:'3',matchNum:'周四003',teams:['Synthetic Home Three','Synthetic Away Three'],orderedTeamIds:[14,15]};
  v.draft.singles.push(third);archive(v.draft);
  for(const e of v.snapshot.endpoints){const rows=e.payload.value.matchInfoList[0].subMatchList,row=structuredClone(rows[0]);Object.assign(row,{matchId:3,matchNumStr:third.matchNum,homeTeamAllName:third.teams[0],awayTeamAllName:third.teams[1],homeTeamId:14,awayTeamId:15});rows.push(row);f.resign(e,signed.keyPair);}
  const snapshotBytes=JSON.stringify(v.snapshot);fs.writeFileSync(snapshotPath,snapshotBytes);
  const service=require('../server/researchWriteService.cjs').createResearchWriteService({pool:mapped,runExclusive:fn=>fn()});
  const base=await service.execute(wire('publish',v.draft));a.equal(base.verified,true);
  const tx=require('./recommendationPlatform/leagueBaselineRuntime.cjs').transaction,runtime=require('./recommendationPlatform/reviewedAnalysisRuntime.cjs');
  const projection=await tx(mapped,true,c=>runtime.projection(c,v.draft.businessDate,f.stamp(clock+1)));
  await q('INSERT INTO football.daily_featured_combo_state VALUES(1,$1::json)',[JSON.stringify({recommendationCenter:{reviewedAnalysis:projection}})]);
  await tx(mapped,false,c=>require('../server/researchFrozenCombos.cjs').freezeOriginalGroups(c,projection,f.stamp(clock+10),{anchor:true}));clock+=20;
  const originals=(await q('SELECT artifact_key,payload::text AS json,payload_sha256 FROM football.private_model_artifacts ORDER BY artifact_key')).rows;
  const center=(await q('SELECT payload::text AS json FROM football.daily_featured_combo_state')).rows[0].json;
  const ids=v.draft.singles.map(d=>d.eventId),request={version:'reviewed-combo-series-request-v1',businessDate:v.draft.businessDate,label:'Synthetic evening',draft:v.draft,draftHash:p.hash(v.draft),bases:ids.map(eventId=>({eventId,baseRecordKey:base.recordKey,basePayloadSha256:base.payloadSha256})),groups:[{size:2,band:2.5,eventIds:ids.slice(0,2)},{size:3,band:5,eventIds:ids}]};
  a.equal((await service.execute(wire('combo-series-read',request))).state,'not-observed');
  const changed=structuredClone(request);changed.draft.singles[0].reason='Changed original analysis';archive(changed.draft);changed.draftHash=p.hash(changed.draft);
  await a.rejects(service.execute(wire('combo-series-publish',changed)),{code:'RESEARCH_COMBO_SERIES_ORIGINAL_DIRECTION'});
  const closed=structuredClone(v.snapshot);for(const e of closed.endpoints){e.payload.value.matchInfoList[0].subMatchList[0].sellStatus=2;f.resign(e,signed.keyPair);}fs.writeFileSync(snapshotPath,JSON.stringify(closed));
  await a.rejects(service.execute(wire('combo-series-publish',request)));a.equal((await service.execute(wire('combo-series-read',request))).state,'not-observed');
  fs.writeFileSync(snapshotPath,snapshotBytes);const before=clock;clock=f.NOW+31000;
  await a.rejects(service.execute(wire('combo-series-publish',request)));clock=before;
  const success=await service.execute(wire('combo-series-publish',request));a.equal(success.verified,true);a.equal(success.submitted,true);a.equal(success.groups.length,2);a.equal(success.groups[0].product,3.456);a.equal(success.groups[1].product,6.2208);
  a.equal(series.validateResponse(request,success,f.stamp(clock+1)),true);
  const tampered=structuredClone(success);tampered.groups[0].product=10; a.throws(()=>series.validateResponse(request,tampered,f.stamp(clock+1)));
  const view=await series.readDay(mapped,request.businessDate);a.equal(view.series.length,1);a.equal(view.series[0].openEventIds.length,3);
  a.equal((await service.execute(wire('combo-series-publish',request))).submitted,false);
  const reorder=structuredClone(request);reorder.groups.reverse();reorder.groups.forEach(g=>g.eventIds.reverse());a.equal(series.validate(reorder),series.validate(request));
  const journal=require('./researchReleaseBroker.cjs').requestJournalIdentity;
  a.equal(journal(wire('combo-series-publish',request)).journalId,journal(wire('combo-series-publish',reorder)).journalId);
  await a.rejects(service.execute(wire('combo-series-publish',reorder)),{code:'RESEARCH_COMBO_SERIES_IMMUTABLE_CONFLICT'});
  const relabel=structuredClone(request);relabel.label='Another label';await a.rejects(service.execute(wire('combo-series-publish',relabel)),{code:'RESEARCH_COMBO_SERIES_IMMUTABLE_CONFLICT'});
  const subset=structuredClone(request);subset.groups=[subset.groups[1]];await a.rejects(service.execute(wire('combo-series-publish',subset)),{code:'RESEARCH_COMBO_SERIES_DAY_BOUND'});
  fs.writeFileSync(snapshotPath,JSON.stringify(closed));const frozen=await series.readDay(mapped,request.businessDate);a.equal(frozen.series[0].openEventIds.includes(ids[0]),false);a.deepEqual(frozen.series[0].groups,success.groups);
  fs.writeFileSync(snapshotPath,snapshotBytes);clock=Date.parse(v.draft.singles[0].kickoff)+1;const started=await series.readDay(mapped,request.businessDate);a.equal(started.series[0].openEventIds.length,0);a.deepEqual(started.series[0].groups,success.groups);clock=before+200;
  for(const row of originals){const current=(await q('SELECT payload::text AS json,payload_sha256 FROM football.private_model_artifacts WHERE artifact_key=$1',[row.artifact_key])).rows[0];a.equal(current.json,row.json);a.equal(current.payload_sha256,row.payload_sha256);}a.equal((await q('SELECT payload::text AS json FROM football.daily_featured_combo_state')).rows[0].json,center);
  // Remove only this disposable schema's new series, retaining original bases.
  await q('DELETE FROM football.private_model_artifacts WHERE artifact_version IN ($1,$2)',[series.VERSION,series.ACK_VERSION]);dropCommit=true;
  await a.rejects(service.execute(wire('combo-series-publish',request)),{code:'REVIEW_REVISION_COMMIT_UNKNOWN_READ_FIRST'});
  const unknown=await service.execute(wire('combo-series-read',request));a.equal(unknown.state,'record-present-ack-missing');a.equal(unknown.verified,false);a.equal((await service.execute(wire('combo-series-publish',request))).submitted,false);a.equal((await series.readDay(mapped,request.businessDate)).series.length,0);
  await q("UPDATE football.private_model_artifacts SET payload_sha256=repeat('0',64) WHERE artifact_version=$1",[series.VERSION]);await a.rejects(series.readDay(mapped,request.businessDate));
  a.equal(nativeReads,0);a.equal(readWrites,0);
  return{ok:true,scope:'disposable-pg16-synthetic-clock',separateCommitAndAck:true,originalFrozenBytesPreserved:true,closedAndStaleRefused:true,reorderedAndChangedRequestsCannotRetry:true,crossSeriesDuplicateRefused:true,unknownCommitReadFirst:true,unacknowledgedHidden:true,tamperRefused:true,nativeReads,readWrites,productionWrites:0};
 }finally{if(previous===undefined)delete process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;else process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=previous;try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{signed.cleanup();}}
}
if(require.main===module){const url=process.env.RESEARCH_REPORT_TEST_DATABASE_URL,u=new URL(url||'invalid:');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Explicit local disposable recommendation_test required');const pool=new(require('pg').Pool)({connectionString:url,ssl:false,max:4});verify(pool).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
