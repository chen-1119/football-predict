'use strict';
// Native integration only: explicit loopback test DB and disposable schema.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runPostgresMigrations}=require('../server/postgresStore.cjs');
const {commitCurrentDataGeneration}=require('../server/dataGenerationBundle.cjs');
const {createPostgresGenerationSource}=require('../scripts/postgresGenerationSource.cjs');
const {syncPostgresProjectionFromSource}=require('../scripts/postgresProjectionSync.cjs');
const {buildPublicReferenceArchive,buildPublicReferenceIndex,SOURCE_ID,INDEX_ID,INDEX_PREFIX}=require('../server/publicReferenceArchive.cjs');
async function verify(pool){
 const database=(await pool.query('SELECT current_database() AS name')).rows[0].name;
 assert(['recommendation_test','accounts_test'].includes(database),'Disposable test DB required');
 const schema=`generation_native_${process.pid}_${Date.now()}`;assert(/^generation_native_\d+_\d+$/.test(schema));
 const map=sql=>sql.replace(/\bfootball\b/g,schema);
 const q=(sql,args)=>pool.query(map(sql),args);
 const mapped={query:q,async connect(){const client=await pool.connect();return{query:(sql,args)=>client.query(map(sql),args),release:()=>client.release()};}};
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'football-pg-generation-native-'));
 const storeDir=path.join(temp,'store'),publicDataDir=path.join(temp,'public');fs.mkdirSync(publicDataDir);
 const {fixture,trust,auditAt}=require('../scripts/verifyPublicReferencePairs.cjs');
 // Force the real file-payload path, including multibyte UTF-8 boundaries.
 const fixtures=[fixture({id:'887101',mutateSource:source=>{source.probabilityModel.padding='球队⚽'.repeat(250000);}}),fixture({id:'887102'}),fixture({id:'887103'})];
 const snapshot={updatedAt:auditAt,retentionDays:31,rows:[],publicReferenceDecisions:fixtures.map(f=>f.record),publicReferenceEvidence:fixtures.map(f=>f.entry)};
 const meta={source:'sporttery',sourceCycleId:'native-pg-reference',updatedAt:auditAt},external={updatedAt:auditAt,source:'external',matches:{}};
 const payloads={'matches-current.json':[fixtures[1].match],'matches-history.json':[],'sync-meta.json':meta,'external-signals.json':external,'odds-history.json':{rows:[]},'prediction-snapshots.json':snapshot,'model-calibration.json':{version:'qa',generatedAt:auditAt}};
 const publish=()=>{for(const[name,payload]of Object.entries(payloads))fs.writeFileSync(path.join(publicDataDir,name),JSON.stringify(payload));return commitCurrentDataGeneration({storeDir,publicDataDir,sourceCycleId:meta.sourceCycleId,committedAt:auditAt});};
 const source=()=>createPostgresGenerationSource({storeDir,publicDataDir});
 const sync=(options={})=>syncPostgresProjectionFromSource(source(),{pool:mapped,mode:'incremental',aiArenaPath:path.join(temp,'absent-arena.json'),...options});
 const rows=()=>q('SELECT id,source,captured_at,payload::text AS payload FROM football.source_snapshots ORDER BY id');
 const state=async()=>({sources:(await rows()).rows,meta:(await q('SELECT key,value,updated_at FROM football.projection_meta ORDER BY key')).rows,runs:(await q('SELECT to_jsonb(r)::text AS row FROM football.projection_runs r ORDER BY run_id')).rows,publications:(await q('SELECT to_jsonb(p)::text AS row FROM football.publications p ORDER BY publication_id')).rows,frozen:(await q('SELECT to_jsonb(f)::text AS row FROM football.frozen_recommendations f ORDER BY decision_id')).rows});
 const passed=[];
 try{
  await runPostgresMigrations(mapped);
  await q("INSERT INTO football.source_snapshots(id,source,payload) VALUES('independent:keep','qa','{\"keep\":true}'::json),($1,'stale','{}'::json)",[INDEX_PREFIX+'stale']);
  publish();
  const archive=buildPublicReferenceArchive(snapshot),index=buildPublicReferenceIndex(archive);
  const expected=new Map([[SOURCE_ID,JSON.stringify(archive)],[INDEX_ID,JSON.stringify(index.manifest)],...index.shards.map(s=>[s.id,JSON.stringify(s.payload)])]);
  const first=await sync();assert.equal(first.ok,true);assert.equal(first.skipped,false);assert.equal(first.rowCounts.source_snapshots,expected.size+2);
  const actual=(await rows()).rows;
  for(const[id,payload]of expected)assert.equal(actual.find(r=>r.id===id)?.payload,payload,'Exact native JSON bytes '+id);
  assert.equal(actual.find(r=>r.id==='independent:keep')?.payload,'{"keep":true}');assert(!actual.some(r=>r.id===INDEX_PREFIX+'stale'));
  assert.equal(actual.length,expected.size+3);assert.equal(JSON.parse(actual.find(r=>r.id===INDEX_ID).payload).rowCount,3);
  assert(Buffer.byteLength(expected.get(SOURCE_ID))>1024*1024);
  passed.push('real streamed immutable generation sourceRows commit exact multi-MiB Unicode archive and odd-leaf index bytes through PostgreSQL json');
  passed.push('source inventory preserves independent entries and removes stale managed shards');
  const before=await state(),again=await sync();assert.equal(before.frozen.length,1);assert.equal(again.skipped,true);assert.deepEqual(await state(),before);
  passed.push('unchanged generation is idempotent with stable committed sources and receipts');
  snapshot.publicReferenceEvidence[1].evidence.probabilityModel.version='invalid-binding';meta.sourceCycleId+='-invalid';publish();
  await assert.rejects(sync(),/PUBLIC_REFERENCE_EVIDENCE_BINDING_INVALID/);assert.deepEqual(await state(),before);
  passed.push('invalid bound evidence rolls back all PostgreSQL projection changes and preserves the last receipt');
  snapshot.publicReferenceEvidence[1].evidence.probabilityModel.version='synthetic-model';meta.sourceCycleId+='-late-failure';publish();
  let assembled=false;const temporaryNames=[];
  const failingPool={query:q,async connect(){const client=await mapped.connect();return{release:()=>client.release(),async query(sql,args){
   if(sql.includes('string_agg(piece'))assembled=true;
   if(sql.startsWith('CREATE TEMP TABLE projection_json_parts_'))temporaryNames.push(sql.match(/CREATE TEMP TABLE (projection_json_parts_[a-f0-9]+)/)[1]);
   if(sql.includes('SELECT id, state_key, captured_at, first_seen_at, last_seen_at, seen_count FROM football.prediction_snapshots'))throw new Error('injected-after-streamed-source');
   return client.query(sql,args);
  }};}};
  await assert.rejects(syncPostgresProjectionFromSource(source(),{pool:failingPool,mode:'incremental',aiArenaPath:path.join(temp,'absent-arena.json')}),/injected-after-streamed-source/);
  assert.equal(assembled,true);assert.deepEqual(await state(),before);
  assert.equal((await q("SELECT count(*)::int AS count FROM pg_class WHERE relname=ANY($1::text[]) AND relpersistence='t'",[temporaryNames])).rows[0].count,0);
  passed.push('failure after real segmented JSON assembly rolls back source rows, metadata, receipts and temporary parts');
  const added=fixture({id:'887104'});
  payloads['matches-current.json'].push(added.match);snapshot.publicReferenceDecisions.push(added.record);snapshot.publicReferenceEvidence.push(added.entry);
  meta.sourceCycleId+='-before-commit';publish();
  const nextArchive=buildPublicReferenceArchive(snapshot),nextIndex=buildPublicReferenceIndex(nextArchive);
  const nextExpected=new Map([[SOURCE_ID,JSON.stringify(nextArchive)],[INDEX_ID,JSON.stringify(nextIndex.manifest)],...nextIndex.shards.map(s=>[s.id,JSON.stringify(s.payload)])]);
  let verified=0;
  const verifyPending=async(client,context)=>{
   assert.equal(context.skipped,false);assert.equal(context.sourceFingerprint,sourceFingerprint);assert.equal(context.publication.generationId,publication.generationId);
   assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'serializable');
   const projected=(await client.query('SELECT id,payload::text AS payload FROM football.source_snapshots')).rows;
   for(const[id,payload]of nextExpected)assert.equal(projected.find(r=>r.id===id)?.payload,payload,'Uncommitted native JSON bytes '+id);
   const current=(await client.query("SELECT publication_id FROM football.publications WHERE state='current'")).rows;
   assert.deepEqual(current,[{publication_id:publication.generationId}]);
   assert.equal((await client.query("SELECT value FROM football.projection_meta WHERE key='data_generation_id'")).rows[0].value,publication.generationId);
   const receipt=(await client.query('SELECT publication_id,source_fingerprint FROM football.projection_runs WHERE run_id=$1',[context.runId])).rows;
   assert.deepEqual(receipt,[{publication_id:publication.generationId,source_fingerprint:sourceFingerprint}]);
   const frozen=(await client.query('SELECT match_id,publication_id,direction FROM football.frozen_recommendations ORDER BY match_id')).rows;
   assert.deepEqual(frozen,[fixtures[1].match,added.match].map(m=>({match_id:m.id,publication_id:publication.generationId,direction:m.archivedPreMatchPrediction.prediction.tipCode})));
   verified++;
  };
  const pendingSource=source(),{fingerprint:sourceFingerprint,publication}=pendingSource;pendingSource.close();
  await assert.rejects(sync({beforeCommit:async(client,context)=>{await verifyPending(client,context);throw new Error('injected-frozen-validation-before-commit');}}),/injected-frozen-validation-before-commit/);
  assert.equal(verified,1);assert.deepEqual(await state(),before);
  passed.push('actual archive/index/shards, frozen decisions, publication and receipt validate before COMMIT; callback rejection rolls them all back');
  const accepted=await sync({beforeCommit:verifyPending});assert.equal(accepted.skipped,false);assert.equal(verified,2);assert.equal((await state()).frozen.length,2);
  let skippedVerified=false;
  const skipped=await sync({beforeCommit:async(client,context)=>{assert.equal(context.skipped,true);assert.equal(context.previousRunId,accepted.runId);assert.equal((await client.query('SELECT count(*)::int AS count FROM football.frozen_recommendations')).rows[0].count,2);skippedVerified=true;}});
  assert.equal(skipped.skipped,true);assert.equal(skippedVerified,true);
  passed.push('successful explicit validation commits normally and unchanged-source calls still execute the requested verifier');
  const match=payloads['matches-current.json'][0];
  const readFrozen=async()=> (await q('SELECT decision_id,decision_hash,publication_id,payload::text AS payload,to_jsonb(f)::text AS record FROM football.frozen_recommendations f WHERE match_id=$1',[match.id])).rows;
  const [originalFrozen]=await readFrozen();assert.ok(originalFrozen);
  const originalReview=(await q('SELECT review_id,observation_id,payload::text AS payload FROM football.post_match_reviews WHERE match_id=$1 AND decision_id=$2',[match.id,originalFrozen.decision_id])).rows[0];assert.ok(originalReview);
  const archivedBytes=JSON.stringify(match.archivedPreMatchPrediction);
  match.predictionMeta={...match.predictionMeta,modelVersion:'current-meta-after-freeze',currentDiagnostic:'must-not-rewrite-frozen'};
  match.scoreHome=2;match.scoreAway=1;match.resultProvenance={...match.resultProvenance,scoreHome:2,scoreAway:1};match.resultObservedAt='2026-09-07T15:01:00.000Z';
  match.postMatchReview=require('../scripts/syncData.cjs').buildPostMatchReview(match,match.resultObservedAt,new Map());
  assert.equal(JSON.stringify(match.archivedPreMatchPrediction),archivedBytes);assert.equal(match.postMatchReview.predictionReview.referenceBestStatus,'LOST');
  meta.sourceCycleId+='-mutable-meta-and-corrected-result';publish();const corrected=await sync();assert.equal(corrected.skipped,false);
  const currentFrozen=await readFrozen();assert.equal(currentFrozen.length,1);const [preservedFrozen]=currentFrozen;
  assert.equal(preservedFrozen.decision_id,originalFrozen.decision_id);assert.equal(preservedFrozen.decision_hash,originalFrozen.decision_hash);assert.equal(preservedFrozen.payload,originalFrozen.payload);
  assert.equal(preservedFrozen.publication_id,corrected.publication.generationId);assert.notEqual(preservedFrozen.publication_id,originalFrozen.publication_id);
  const {protectedFrozenRecommendationHash}=require('../scripts/nativeReleaseDataPlane.cjs');assert.equal(protectedFrozenRecommendationHash(preservedFrozen.record),protectedFrozenRecommendationHash(originalFrozen.record));
  const reviewed=(await q('SELECT r.review_id,r.observation_id,r.payload::text AS review,o.result_identity,o.payload::text AS observation FROM football.post_match_reviews r JOIN football.result_observations o ON o.observation_id=r.observation_id WHERE r.match_id=$1 AND r.decision_id=$2',[match.id,originalFrozen.decision_id])).rows;
  assert.equal(reviewed.length,1);assert.equal(reviewed[0].review_id,originalReview.review_id);assert.notEqual(reviewed[0].observation_id,originalReview.observation_id);assert.equal(reviewed[0].result_identity,'2:1|sporttery');
  assert.equal(JSON.parse(reviewed[0].observation).scoreHome,2);assert.equal(JSON.parse(reviewed[0].review).predictionReview.referenceBestStatus,'LOST');
  passed.push('same archived decision preserves its original frozen payload and hash despite new current metadata, while publication, corrected result and review advance');
  return{ok:true,checks:passed.length,passed,scope:'loopback-disposable-schema',database,schema,archiveRows:nextIndex.manifest.rowCount,sourceRows:(await rows()).rows.length,productionWrites:0};
 }finally{
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  trust.cleanup();const resolved=fs.realpathSync(temp);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert(path.basename(resolved).startsWith('football-pg-generation-native-'));fs.rmSync(resolved,{recursive:true,force:true});
 }
}
async function main(){
 const url=process.env.POSTGRES_GENERATION_TEST_DATABASE_URL;
 assert(url,'Explicit POSTGRES_GENERATION_TEST_DATABASE_URL required');const parsed=new URL(url);
 assert(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)&&['/recommendation_test','/accounts_test'].includes(parsed.pathname),'Only loopback disposable PostgreSQL allowed');
 const {Pool}=require('pg'),pool=new Pool({connectionString:url,max:4});try{console.log(JSON.stringify(await verify(pool),null,2));}finally{await pool.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
module.exports={verify};
