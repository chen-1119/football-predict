'use strict';
// Only an explicit local disposable database and synthetic collector/clock.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs'),f=require('../tests/fixtures/reviewed-official-event.cjs');
async function verify(pool){
 const schema='official_event_verify_'+process.pid+'_'+Date.now();
 const signed=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-official-event'});
 const snapshotPath=path.join(path.dirname(signed.registryPath),'official-snapshot.json'),previous=process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;
 process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=snapshotPath;
 let clock=f.NOW+100,dropCommit=false,nativeReads=0,readWrites=0;
 const q=(sql,args)=>pool.query(sql.replaceAll('football.',schema+'.'),args);
 const mapped={async connect(){const client=await pool.connect();let readonly=false;return {release:error=>client.release(error),async query(sql,args){
  if(sql.startsWith('BEGIN'))readonly=sql.includes('READ ONLY');
  if(sql.includes('match_snapshots')){nativeReads++;throw Error('No native event table is provided for this test');}
  if(readonly&&/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(sql))readWrites++;
  const result=await client.query(sql.replaceAll('football.',schema+'.'),args);
  if(sql==='SELECT clock_timestamp() AS now')return {rows:[{now:new Date(clock++)}]};
  if(sql==='COMMIT'&&!readonly&&dropCommit){dropCommit=false;throw Error('Injected lost COMMIT reply');}return result;
 }};}};
 try{
  await pool.query('CREATE SCHEMA '+schema);
  await q('CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)');
  await q('CREATE TABLE football.daily_featured_combo_state(id integer PRIMARY KEY,payload json NOT NULL)');
  await q('CREATE TABLE football.projection_meta(key text PRIMARY KEY,value text NOT NULL)');
  for(const [key,value]of Object.entries({data_publication_mode:'active-generation',data_generation_id:'g-'+'a'.repeat(64),manifest_hash:'a'.repeat(64),data_generation_source_cycle_id:'synthetic-cycle',committed_at:f.stamp(f.NOW-1000)}))await q('INSERT INTO football.projection_meta VALUES($1,$2)',[key,value]);
  // There is deliberately no native match table, model or evidence graph.
  const v=f.setup(signed.keyPair),snapshotBytes=JSON.stringify(v.snapshot);fs.writeFileSync(snapshotPath,snapshotBytes);
  const service=require('../server/researchWriteService.cjs').createResearchWriteService({pool:mapped,runExclusive:action=>action()});
  function wire(action,json,draftHash){return Buffer.from(JSON.stringify({version:'research-broker-request-v1',action,json,sha256:p.sha(json),...(draftHash?{draftHash}:{})}));}
  const result=await service.execute(wire('publish',JSON.stringify(v.draft),p.hash(v.draft)));
  a.equal(result.verified,true);a.equal(result.submitted,true);a.equal(result.records.length,2);a.equal(result.modelAdoption,false);
  const rows=await q('SELECT artifact_key,payload::text AS json,payload_sha256 FROM football.private_model_artifacts ORDER BY artifact_key');a.equal(rows.rows.length,2);
  const firstBytes=rows.rows.map(row=>[row.artifact_key,row.json]);
  const duplicate=await service.execute(wire('publish',JSON.stringify(v.draft),p.hash(v.draft)));a.equal(duplicate.submitted,false);
  const dto=await require('../server/researchOfficialEventRead.cjs').read(mapped,v.draft.businessDate);
  a.equal(dto.officialEventIds.length,2);a.equal(dto.original.records[1].sp,1.92);a.equal(dto.modelAdoption,false);a.equal(dto.formalEligible,false);
  a.deepEqual(dto.officialEventIds,v.draft.singles.map(r=>r.eventId));a.equal(dto.revisions.singles.length,0);
  function updateArchive(d){const archive=JSON.parse(d.originalArchive);archive.frozenAt=d.frozenAt;archive.singles=d.singles.map(({classification,...r})=>{void classification;return r;});d.originalArchive=JSON.stringify(archive);d.originalArchiveSha256=p.sha(d.originalArchive);return d;}
  const changed=structuredClone(v.draft);changed.singles=[{...changed.singles[0],selection:'a',sp:4.5,scores:[[0,1],[1,2]],reason:'Synthetic new verified research'}];
  changed.frozenAt=f.stamp(f.NOW+1);updateArchive(changed);
  const request={version:'reviewed-single-request-v1',baseRecordKey:result.recordKey,basePayloadSha256:result.payloadSha256,eventId:changed.singles[0].eventId,revision:1,previousRevisionHash:null,draft:changed,draftHash:p.hash(changed)};
  const badSnapshot=structuredClone(v.snapshot);for(const endpoint of badSnapshot.endpoints){Object.assign(endpoint.payload.value.matchInfoList[0].subMatchList[0],{homeTeamId:20,awayTeamId:21});f.resign(endpoint,signed.keyPair);}
  const badDraft=updateArchive({...structuredClone(changed),singles:changed.singles.map(r=>({...r,orderedTeamIds:[20,21]}))});
  fs.writeFileSync(snapshotPath,JSON.stringify(badSnapshot));
  await a.rejects(service.execute(wire('revision-publish',JSON.stringify({...request,draft:badDraft,draftHash:p.hash(badDraft)}))),{code:'REVIEW_REVISION_EVENT_CHANGED'});
  fs.writeFileSync(snapshotPath,snapshotBytes);
  const revision=await service.execute(wire('revision-publish',JSON.stringify(request)));a.equal(revision.verified,true);a.equal(revision.originalDecision.selection,'h');a.equal(revision.latestDecision.selection,'a');a.equal(revision.independentEventIncrement,0);
  const latest=await require('../server/researchOfficialEventRead.cjs').read(mapped,v.draft.businessDate);a.equal(latest.revisions.singles.length,1);a.equal(latest.revisions.singles[0].decision.selection,'a');
  for(const [key,json]of firstBytes)a.equal((await q('SELECT payload::text AS json FROM football.private_model_artifacts WHERE artifact_key=$1',[key])).rows[0].json,json);
  const runtime=require('./recommendationPlatform/reviewedAnalysisRuntime.cjs'),tx=require('./recommendationPlatform/leagueBaselineRuntime.cjs').transaction;
  const candidate=await tx(mapped,true,client=>runtime.projection(client,v.draft.businessDate,f.stamp(clock+1)));
  await q('INSERT INTO football.daily_featured_combo_state VALUES(1,$1::json)',[JSON.stringify({recommendationCenter:{reviewedAnalysis:candidate}})]);
  const frozen=await tx(mapped,false,client=>require('../server/researchFrozenCombos.cjs').freezeOriginalGroups(client,candidate,f.stamp(clock+10),{anchor:true}));
  clock+=20;
  a.equal(frozen.comboFreezePolicy,'persisted-original-groups-v1');a.equal(frozen.comboFreeze[0].frozen,false);
  const originalGroup=frozen.combos.find(g=>g.legs.length===2);a(originalGroup);
  const groupMeta=frozen.comboFreeze.find(g=>g.size===2&&g.band===originalGroup.band);
  const comboDraft=updateArchive({...structuredClone(v.draft),frozenAt:f.stamp(f.NOW+2)});
  Object.assign(comboDraft.singles[0],{market:'HHAD',handicap:-1,selection:'a',sp:1.92,scores:[[1,1],[1,2]],reason:'Synthetic revised handicap market'});updateArchive(comboDraft);
  const comboRequest={version:'reviewed-combo-request-v1',size:2,band:originalGroup.band,baseArchiveKey:groupMeta.sourceArchiveKey,baseArchiveSha256:groupMeta.sourceArchiveSha256,
   bases:originalGroup.legs.map(l=>({eventId:l.eventId,baseRecordKey:result.recordKey,basePayloadSha256:result.payloadSha256})),revision:1,previousRevisionHash:null,
   draft:comboDraft,draftHash:p.hash(comboDraft)};
  const combo=await service.execute(wire('combo-revision-publish',JSON.stringify(comboRequest)));a.equal(combo.verified,true);a.equal(combo.originalSettlementPreserved,true);
  const withCombo=await require('../server/researchOfficialEventRead.cjs').read(mapped,v.draft.businessDate);
  a.equal(withCombo.revisions.combos.length,1);a.equal(withCombo.revisions.combos[0].frozen,false);a.equal(withCombo.original.combos[0].product,originalGroup.product);
  const poolClosed=structuredClone(v.snapshot);for(const endpoint of poolClosed.endpoints){const pool=endpoint.payload.value.matchInfoList[0].subMatchList[0].poolList.find(p=>p.poolCode==='HHAD');Object.assign(pool,{poolStatus:'Closed',cbtValue:2,cbtAllUp:0});f.resign(endpoint,signed.keyPair);}fs.writeFileSync(snapshotPath,JSON.stringify(poolClosed));
  const marketClosed=await require('../server/researchOfficialEventRead.cjs').read(mapped,v.draft.businessDate);
  a.equal(marketClosed.revisions.combos[0].frozen,true);a.equal(marketClosed.original.comboFreeze[0].frozen,false);a.equal(marketClosed.original.combos[0].product,originalGroup.product);
  const closed=structuredClone(v.snapshot);for(const endpoint of closed.endpoints){endpoint.payload.value.matchInfoList[0].subMatchList[0].sellStatus=2;f.resign(endpoint,signed.keyPair);}fs.writeFileSync(snapshotPath,JSON.stringify(closed));
  const closedView=await require('../server/researchOfficialEventRead.cjs').read(mapped,v.draft.businessDate);a.equal(closedView.revisions.combos[0].frozen,true);a.equal(closedView.original.combos[0].product,originalGroup.product);
  fs.writeFileSync(snapshotPath,snapshotBytes);
  a.equal(fs.readFileSync(snapshotPath,'utf8'),snapshotBytes);
  // Only this fixture's own rows are removed to exercise unknown COMMIT.
  await q('TRUNCATE football.private_model_artifacts');dropCommit=true;
  await a.rejects(service.execute(wire('publish',JSON.stringify(v.draft),p.hash(v.draft))),{code:'LEAGUE_MODEL_COMMIT_UNKNOWN'});
  a.equal(Number((await q('SELECT count(*) AS n FROM football.private_model_artifacts')).rows[0].n),1);
  const read=await service.execute(Buffer.from(JSON.stringify({version:'research-broker-request-v1',action:'publication-read',recordKey:result.recordKey,draftHash:p.hash(v.draft)})));
  a.equal(read.state,'record-present-ack-missing');a.equal(read.verified,false);a.equal(read.retryWriteAutomatically,false);
  a.equal((await service.execute(wire('publish',JSON.stringify(v.draft),p.hash(v.draft)))).submitted,false);
  await a.rejects(require('../server/researchOfficialEventRead.cjs').read(mapped,v.draft.businessDate),/ACK_MISSING/);
  await q("UPDATE football.private_model_artifacts SET payload_sha256=repeat('0',64)");
  await a.rejects(require('../server/researchOfficialEventRead.cjs').read(mapped,v.draft.businessDate),/payload SHA-256 mismatch/);
  a.equal(nativeReads,0);a.equal(readWrites,0);
  return {ok:true,scope:'disposable-postgres-synthetic-clock',normalBrokerService:true,separateCommitAndAck:true,originalBytesPreserved:true,v4RevisionReadback:true,changedOfficialTeamIdsRefused:true,absentNativeComboAnchorAndRevision:true,revisedMarketClosesIndependently:true,closedLegFreezesOriginalProduct:true,unknownCommitReadFirst:true,missingAckAndTamperRefused:true,nativeReads,readWrites,productionWrites:0,productionRootBrokerVerified:false};
 }finally{
  if(previous===undefined)delete process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;else process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=previous;
  try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{signed.cleanup();}
 }
}
if(require.main===module){const value=process.env.RESEARCH_REPORT_TEST_DATABASE_URL,u=new URL(value||'invalid:');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Explicit local disposable recommendation_test required');const pool=new(require('pg').Pool)({connectionString:value,ssl:false,max:4});verify(pool).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
