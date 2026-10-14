'use strict';
// Real PostgreSQL transactions with synthetic signed evidence and an explicit
// synthetic clock. No live provider, production service, or root lock proof.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs'),f=require('../tests/fixtures/signed-live-had.cjs');
const {createRevisionStore,revisionKey}=require('../server/researchReviewedRevision.cjs');
async function verify(pool){
 const schema='research_revision_verify_'+process.pid+'_'+Date.now();
 const signed=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-review-revision'});
 const snapshotPath=path.join(path.dirname(signed.registryPath),'revision-snapshot.json');
 const previous=process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=snapshotPath;
 let clock=f.NOW+100,dropCommit=false;
 const q=(s,args)=>pool.query(s.replaceAll('football.',schema+'.'),args);
 const mapped={async connect(){const c=await pool.connect();let readonly=false;return {release:e=>c.release(e),async query(s,args){
  if(s.startsWith('BEGIN'))readonly=s.includes('READ ONLY');
  const result=await c.query(s.replaceAll('football.',schema+'.'),args);
  if(s==='SELECT clock_timestamp() AS now')return {rows:[{now:new Date(clock++)}]};
  if(s==='COMMIT'&&!readonly&&dropCommit){dropCommit=false;throw Error('Injected lost COMMIT reply');}return result;
 }};}};
 try{
  await pool.query('CREATE SCHEMA '+schema);
  await q(`CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)`);
  await q('CREATE TABLE football.match_snapshots(dataset text,payload json)');
  const matches=[f.source(1)];
  const source=f.snapshot(matches,{pair:signed.keyPair,mutate:e=>{e.payload.value.matchInfoList[0].subMatchList[0].homeTeamId=10;e.payload.value.matchInfoList[0].subMatchList[0].awayTeamId=11;}});
  fs.writeFileSync(snapshotPath,JSON.stringify(source.snapshot));
  await q("INSERT INTO football.match_snapshots VALUES('current',$1::json)",[JSON.stringify(matches[0])]);
  const single={eventId:String(matches[0].sourceMatchId),matchNum:matches[0].matchNo,businessDate:matches[0].businessDate,kickoff:matches[0].kickoffTime,
   market:'HAD',handicap:null,selection:'h',scores:[[2,0],[3,1]],confidence:'中',reason:'Synthetic original',analysisUrl:'https://example.com/preview',teams:[matches[0].homeTeamName,matches[0].awayTeamName],orderedTeamIds:[10,11],sp:1.8,modelVersion:null,modelProbability:null,formalEligible:false,classification:'manual-prematch-research'};
  function draft(selection,at,reason){const s={...single,selection,sp:selection==='h'?1.8:4.5,scores:selection==='h'?[[2,0],[3,1]]:[[0,1],[1,2]],reason};
   const frozenAt=f.stamp(at),archive=JSON.stringify({version:1,reportKind:'on-demand-prematch-supplement',predictionScope:'chat-only manual research',businessDate:s.businessDate,frozenAt,singles:[s]});
   return {version:3,reportKind:'manual-prematch-batch',predictionScope:'reviewed-online-reference',businessDate:s.businessDate,frozenAt,singles:[s],originalArchive:archive,originalArchiveSha256:p.sha(archive)};
  }
  const first=draft('h',f.NOW-60000,'Synthetic original'),record=p.make(first,{matches,snapshot:source.snapshot,trustRegistry:source.registry,asOf:f.stamp(f.NOW)});
  const baseKey='reviewed-analysis-'+single.businessDate+'-batch-'+p.hash(first),freeze=p.seal({version:'reviewed-analysis-freeze-v1',createdAt:record.createdAt,record,draft:first,inputs:{matches,snapshot:source.snapshot},storedAt:f.stamp(f.NOW+1)});
  const baseJson=JSON.stringify(freeze),baseHash=p.sha(baseJson);
  const ack=p.seal({version:'reviewed-analysis-ack-v1',createdAt:f.stamp(f.NOW+2),recordKey:baseKey,storedSha256:baseHash,recordHash:record.contentHash});
  async function insert(key,v){const json=JSON.stringify(v);await q('INSERT INTO football.private_model_artifacts VALUES($1,$2,$3,$4,$5::json,$6,$7)',[key,v.version,v.createdAt,v.storedAt||v.createdAt,json,p.sha(json),Buffer.byteLength(json)]);}
  await insert(baseKey,freeze);await insert(baseKey+'-ack',ack);
  const store=createRevisionStore({pool:mapped,runExclusive:action=>action()});
  function request(revision,previousRevisionHash,selection='a'){const d=draft(selection,f.NOW+50,'Synthetic changed review '+revision);return {version:'reviewed-single-request-v1',baseRecordKey:baseKey,basePayloadSha256:baseHash,eventId:single.eventId,revision,previousRevisionHash,draft:d,draftHash:p.hash(d)};}
  const one=request(1,null),changed=await store.publish(one);
  a.equal(changed.verified,true);a.equal(changed.originalDecision.selection,'h');a.equal(changed.latestDecision.selection,'a');a.equal(changed.independentEventIncrement,0);
  a.equal((await store.publish(one)).submitted,false);
  a.equal((await q('SELECT payload::text AS json,payload_sha256 FROM football.private_model_artifacts WHERE artifact_key=$1',[baseKey])).rows[0].json,baseJson);
  const conflict=request(1,null,'h');await a.rejects(store.publish(conflict),{code:'REVIEW_REVISION_IMMUTABLE_CONFLICT'});
  const bad=request(2,'0'.repeat(64));await a.rejects(store.publish(bad),{code:'REVIEW_REVISION_PREDECESSOR'});
  const two=request(2,changed.payloadSha256,'h'),next=await store.publish(two);a.equal(next.latestDecision.selection,'h');a.equal(next.revision,2);
  const third=request(3,next.payloadSha256);
  await q("UPDATE football.match_snapshots SET payload=$1::json",[JSON.stringify({...matches[0],status:'LIVE'})]);
  await a.rejects(store.publish(third));a.equal((await store.read(third)).state,'not-observed');
  await q("UPDATE football.match_snapshots SET payload=$1::json",[JSON.stringify(matches[0])]);
  dropCommit=true;await a.rejects(store.publish(third),{code:'REVIEW_REVISION_COMMIT_UNKNOWN_READ_FIRST'});
  a.equal((await store.read(third)).state,'record-present-ack-missing');a.equal((await store.publish(third)).submitted,false);
  a.equal(Number((await q('SELECT count(*) AS n FROM football.private_model_artifacts')).rows[0].n),7);
  await q("UPDATE football.private_model_artifacts SET payload_sha256=repeat('0',64) WHERE artifact_key=$1",[revisionKey(single.businessDate,single.eventId,1)]);
  await a.rejects(store.read(two),/payload SHA-256 mismatch/);
  return {ok:true,scope:'disposable-postgres-synthetic-clock',originalBytesPreserved:true,changedDirectionAndScores:true,exactPredecessor:true,liveUpdateRefused:true,unknownCommitReadOnlyRecovery:true,tamperedPredecessorRefused:true,independentEventIncrement:0,productionWrites:0,productionRootBrokerVerified:false};
 }finally{if(previous===undefined)delete process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;else process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=previous;try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{signed.cleanup();}}
}
if(require.main===module){const value=process.env.RESEARCH_REPORT_TEST_DATABASE_URL,u=new URL(value||'invalid:');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Explicit local disposable recommendation_test required');const pool=new(require('pg').Pool)({connectionString:value,ssl:false,max:4});verify(pool).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
