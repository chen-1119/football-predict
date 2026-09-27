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
 const payloads={'matches-current.json':[],'matches-history.json':[],'sync-meta.json':meta,'external-signals.json':external,'odds-history.json':{rows:[]},'prediction-snapshots.json':snapshot,'model-calibration.json':{version:'qa',generatedAt:auditAt}};
 const publish=()=>{for(const[name,payload]of Object.entries(payloads))fs.writeFileSync(path.join(publicDataDir,name),JSON.stringify(payload));return commitCurrentDataGeneration({storeDir,publicDataDir,sourceCycleId:meta.sourceCycleId,committedAt:auditAt});};
 const source=()=>createPostgresGenerationSource({storeDir,publicDataDir});
 const sync=()=>syncPostgresProjectionFromSource(source(),{pool:mapped,mode:'incremental',aiArenaPath:path.join(temp,'absent-arena.json')});
 const rows=()=>q('SELECT id,source,captured_at,payload::text AS payload FROM football.source_snapshots ORDER BY id');
 const state=async()=>({sources:(await rows()).rows,meta:(await q('SELECT key,value,updated_at FROM football.projection_meta ORDER BY key')).rows,runs:(await q('SELECT run_id,source_fingerprint FROM football.projection_runs ORDER BY run_id')).rows});
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
  const before=await state(),again=await sync();assert.equal(again.skipped,true);assert.deepEqual(await state(),before);
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
  return{ok:true,checks:passed.length,passed,scope:'loopback-disposable-schema',database,schema,archiveRows:3,sourceRows:actual.length,productionWrites:0};
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
