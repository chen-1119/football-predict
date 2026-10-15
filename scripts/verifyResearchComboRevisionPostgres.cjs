'use strict';
// Native disposable PostgreSQL, signed synthetic quotes, explicit test clock.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs'),f=require('../tests/fixtures/signed-live-had.cjs');
const combos=require('../server/researchComboRevision.cjs'),archive=require('../services/recommendation/comboArchive.cjs');
async function verify(pool){
 const schema='research_combo_revision_'+process.pid+'_'+Date.now(),q=(s,args)=>pool.query(s.replaceAll('football.',schema+'.'),args);
 const signed=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-combo-review'});
 const snapshotPath=path.join(path.dirname(signed.registryPath),'combo-snapshot.json'),previous=process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;
 process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=snapshotPath;
 let clock=f.NOW+100,dropCommit=false;
 const mapped={async connect(){const c=await pool.connect();let readonly=false;return {release:e=>c.release(e),async query(s,args){
  if(s.startsWith('BEGIN'))readonly=s.includes('READ ONLY');const out=await c.query(s.replaceAll('football.',schema+'.'),args);
  if(s==='SELECT clock_timestamp() AS now')return {rows:[{now:new Date(clock++)}]};
  if(s==='COMMIT'&&!readonly&&dropCommit){dropCommit=false;throw Error('Injected unknown COMMIT');}return out;
 }};}};
 try{
  await pool.query('CREATE SCHEMA '+schema);
  await q('CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)');
  await q('CREATE TABLE football.match_snapshots(dataset text,payload json)');
  await q('CREATE TABLE football.daily_featured_combo_state(id integer PRIMARY KEY,payload json NOT NULL)');
  const matches=[f.source(1),f.source(2),f.source(3)],source=f.snapshot(matches,{pair:signed.keyPair,mutate:e=>e.payload.value.matchInfoList[0].subMatchList.forEach((r,i)=>{r.homeTeamId=10+i*2;r.awayTeamId=11+i*2;})});
  fs.writeFileSync(snapshotPath,JSON.stringify(source.snapshot));
  for(const m of matches)await q("INSERT INTO football.match_snapshots VALUES('current',$1::json)",[JSON.stringify(m)]);
  const singles=matches.map((m,i)=>({eventId:String(m.sourceMatchId),matchNum:m.matchNo,businessDate:m.businessDate,kickoff:m.kickoffTime,market:'HAD',handicap:null,selection:'h',scores:[[2,0],[3,1]],confidence:'中',reason:'Synthetic original',analysisUrl:'https://example.com/preview',teams:[m.homeTeamName,m.awayTeamName],orderedTeamIds:[10+i*2,11+i*2],sp:1.8,modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'}));
  function draft(rows,at){const frozenAt=f.stamp(at),json=JSON.stringify({version:1,reportKind:'on-demand-prematch-supplement',predictionScope:'chat-only manual research',businessDate:singles[0].businessDate,frozenAt,singles:rows});
   return {version:3,reportKind:'manual-prematch-batch',predictionScope:'reviewed-online-reference',businessDate:singles[0].businessDate,frozenAt,singles:rows,originalArchive:json,originalArchiveSha256:p.sha(json)};}
  async function insert(key,v){const json=JSON.stringify(v);await q('INSERT INTO football.private_model_artifacts VALUES($1,$2,$3,$4,$5::json,$6,$7)',[key,v.version,v.createdAt,v.storedAt||v.createdAt,json,p.sha(json),Buffer.byteLength(json)]);return {key,sha256:p.sha(json),json};}
  const first=draft(singles,f.NOW-60000),record=p.make(first,{matches,snapshot:source.snapshot,trustRegistry:source.registry,asOf:f.stamp(f.NOW)});
  const baseKey='reviewed-analysis-'+first.businessDate+'-batch-'+p.hash(first),freeze=p.seal({version:'reviewed-analysis-freeze-v1',createdAt:record.createdAt,record,draft:first,inputs:{matches,snapshot:source.snapshot},storedAt:f.stamp(f.NOW+1)});
  const original=await insert(baseKey,freeze);await insert(baseKey+'-ack',p.seal({version:'reviewed-analysis-ack-v1',createdAt:f.stamp(f.NOW+2),recordKey:baseKey,storedSha256:original.sha256,recordHash:record.contentHash}));
  const view=p.seal({version:'reviewed-analysis-view-v1',businessDate:first.businessDate,createdAt:record.createdAt,commitObservedAt:f.stamp(f.NOW+2),updatedAt:f.stamp(f.NOW+3),publicationHash:record.contentHash,draftHash:record.draftHash,originalFrozenAt:first.frozenAt,records:record.records,combos:p.combinations(record.records,2),threeCombos:p.combinations(record.records,3),formalEligible:false});
  const savedArchive=archive.prepare(view,{generationId:'g-'+'a'.repeat(64),committedAt:f.stamp(f.NOW+3)},f.stamp(f.NOW+4));
  const archived=await insert(savedArchive.key,savedArchive.archive),store=combos.createComboRevisionStore({pool:mapped,runExclusive:action=>action()});
  function request(size,revision=1,previousRevisionHash=null){const group=(size===2?view.combos:view.threeCombos)[0],ids=group.legs.map(l=>l.eventId),rows=ids.map(id=>({...singles.find(s=>s.eventId===id),selection:'a',sp:4.5,scores:[[0,1],[1,2]],reason:'Synthetic new evidence'}));
   const d=draft(rows,clock-1);return {version:'reviewed-combo-request-v1',size,band:2.5,baseArchiveKey:archived.key,baseArchiveSha256:archived.sha256,bases:ids.map(eventId=>({eventId,baseRecordKey:baseKey,basePayloadSha256:original.sha256})),revision,previousRevisionHash,draft:d,draftHash:p.hash(d)};}
  const one=request(2),saved=await store.publish(one);a.equal(saved.verified,true);a.equal(saved.combo.product,20.25);a.equal(saved.originalCombo.product,3.24);
  a.equal((await store.publish(one)).submitted,false);a.equal(saved.independentEventIncrement,0);
  const changed=structuredClone(one);changed.band=5;await a.rejects(store.publish(changed));
  const liveId=one.bases[0].eventId;
  await q("UPDATE football.match_snapshots SET payload=$1::json WHERE payload->>'sourceMatchId'=$2",[JSON.stringify({...matches.find(m=>String(m.sourceMatchId)===liveId),status:'LIVE'}),liveId]);
  clock+=100;const second=request(2,2,saved.payloadSha256);await a.rejects(store.publish(second));a.equal((await store.read(second)).state,'not-observed');
  // No leg, price, direction or record was overwritten by the refused update.
  a.equal((await store.read(one)).combo.product,20.25);
  await q("UPDATE football.match_snapshots SET payload=$1::json WHERE payload->>'sourceMatchId'=$2",[JSON.stringify(matches.find(m=>String(m.sourceMatchId)===liveId)),liveId]);
  dropCommit=true;await a.rejects(store.publish(second),{code:'REVIEW_REVISION_COMMIT_UNKNOWN_READ_FIRST'});a.equal((await store.read(second)).state,'record-present-ack-missing');a.equal((await store.publish(second)).submitted,false);
  clock+=100;const three=request(3);a.equal((await store.publish(three)).combo.product,91.125);
  const c=await mapped.connect();try{const projected=await require('../server/researchReviewProjection.cjs').projection(c,view,f.stamp(clock+100));a.equal(projected.combos.length,2);a.equal(projected.pending.length,1);a.equal(projected.independentEventIncrement,0);}finally{c.release();}
  a.equal((await q('SELECT payload::text AS json FROM football.private_model_artifacts WHERE artifact_key=$1',[baseKey])).rows[0].json,original.json);
  a.equal((await q('SELECT payload::text AS json FROM football.private_model_artifacts WHERE artifact_key=$1',[archived.key])).rows[0].json,archived.json);
  const frozen=require('../server/researchFrozenCombos.cjs'),authority=require('../server/recommendationAuthority.cjs'),updatedAt=f.stamp(clock+200);
  const reader=await mapped.connect();let originalView;
  try{await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const replay=await require('./recommendationPlatform/reviewedAnalysisRuntime.cjs').projection(reader,first.businessDate,updatedAt);
   originalView=await frozen.freezeOriginalGroups(reader,replay,updatedAt);a.equal(originalView.comboFreezePolicy,'persisted-original-groups-v1');await reader.query('ROLLBACK');
  }finally{reader.release();}
  const center={version:'recommendation-center-v1',businessDate:first.businessDate,updatedAt,current:[],previews:[],todayCombos:[],todayDualResearch:[],
   strategySwitch:{version:'trained-strategy-switch-v1',activeReferenceStrategy:'league-trained-baseline-v1',legacyPublicationEnabled:false,legacyFallbackEnabled:false,formalEligible:false,modelAdoptionCount:0},reviewedAnalysis:originalView};
  await q('INSERT INTO football.daily_featured_combo_state VALUES(1,$1::json)',[JSON.stringify({recommendationCenter:center})]);
  async function readAuthority(){const c=await mapped.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const v=await authority.readPublicationAuthority(c,{policy:authority.TRAINED_ONLY_POLICY,asOf:f.stamp(clock+300)});await c.query('ROLLBACK');return v;}finally{c.release();}}
  a.equal((await readAuthority()).activeValidation.ok,true);
  await q("UPDATE football.match_snapshots SET payload=$1::json WHERE payload->>'sourceMatchId'=$2",[JSON.stringify({...matches[0],status:'LIVE'}),String(matches[0].sourceMatchId)]);
  a.equal((await readAuthority()).activeValidation.ok,true);
  const changedView=JSON.parse(JSON.stringify(originalView));changedView.combos.find(g=>g.legs.length).legs[0].sp=99;
  const {contentHash:ignored,...body}=changedView;void ignored;center.reviewedAnalysis=p.seal(body);
  await q('UPDATE football.daily_featured_combo_state SET payload=$1::json WHERE id=1',[JSON.stringify({recommendationCenter:center})]);
  await a.rejects(readAuthority(),/REVIEWED_VIEW_REPLAY/);
  return {ok:true,scope:'disposable-postgres-synthetic-clock',twoAndThreeVersioned:true,startedLegFreezesEntireGroup:true,unknownCommitReadFirst:true,originalBytesPreserved:true,projectionVerified:true,frozenAuthorityReadVerified:true,historicalViewSurvivesLaterLiveLeg:true,changedFrozenPriceRejected:true,productionWrites:0,actualProductionBrokerVerified:false};
 }finally{if(previous===undefined)delete process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;else process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=previous;try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{signed.cleanup();}}
}
if(require.main===module){const u=new URL(process.env.RESEARCH_REPORT_TEST_DATABASE_URL||'invalid:');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Explicit disposable local database required');const pool=new(require('pg').Pool)({connectionString:u.href,ssl:false,max:4});verify(pool).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
