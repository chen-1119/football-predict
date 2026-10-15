'use strict';
// Synthetic data in an explicit loopback test DB; never a production probe.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {Pool}=require('pg');
const {createFileJsonPayload}=require('../scripts/postgresFileJsonPayload.cjs');
const {insertBatches}=require('../scripts/postgresProjectionSync.cjs');
const {snapshotUpsertConflict}=require('../scripts/postgresSnapshotUpsert.cjs');
const {withPostgresTransaction}=require('../server/postgresStore.cjs');
const MEMORY_LIMIT=2304*1024*1024,TARGET_BYTES=512*1024*1024;
function containerEvidence(container){
 assert(/^[a-f0-9]{12,64}$/.test(container||''),'explicit disposable PostgreSQL container required');
 const raw=cp.execFileSync('docker',['inspect','--format','{{json .HostConfig}}',container],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 const config=JSON.parse(raw);assert.equal(config.Memory,MEMORY_LIMIT);assert.equal(config.MemorySwap,MEMORY_LIMIT);
 const events=Object.fromEntries(cp.execFileSync('docker',['exec',container,'/bin/cat','/sys/fs/cgroup/memory.events'],{encoding:'utf8',timeout:10000}).trim().split('\n').map(s=>{const [k,v]=s.split(' ');return[k,Number(v)];}));
 const peak=Number(cp.execFileSync('docker',['exec',container,'/bin/cat','/sys/fs/cgroup/memory.peak'],{encoding:'utf8',timeout:10000}).trim());
 assert(Number.isSafeInteger(peak)&&peak>0&&peak<=MEMORY_LIMIT);assert.equal(events.oom_kill,0);
 return {memoryLimitBytes:config.Memory,memorySwapLimitBytes:config.MemorySwap,peakBytes:peak,oomKills:events.oom_kill};
}
function fixture(directory,version){
 const file=path.join(directory,'source-'+version+'.json'),fd=fs.openSync(file,'wx');
 const digest=crypto.createHash('sha256');let bytes=0;
 const write=value=>{const b=Buffer.from(value);fs.writeSync(fd,b);digest.update(b);bytes+=b.length;};
 try{
  write('{ "version": "memory-fixture-v1", "rows": [');
  const record=JSON.stringify({text:'x'.repeat(1024*1024-100)+'汉字⚽'});let first=true;
  while(bytes<TARGET_BYTES){write((first?'':',')+record);first=false;}
  write('], "revision": '+version+' }\n');fs.fsyncSync(fd);
 }finally{fs.closeSync(fd);}
 return createFileJsonPayload(file,{bytes,sha256:digest.digest('hex')});
}
async function verify(pool,container){
 const name=(await pool.query('SELECT current_database() AS name')).rows[0].name;
 assert.equal(name,'recommendation_test');
 const beforeMemory=containerEvidence(container),schema='source_memory_'+process.pid+'_'+Date.now();
 assert(/^source_memory_\d+_\d+$/.test(schema));
 const map=sql=>sql.replace(/\bfootball\b/g,schema),q=(sql,args)=>pool.query(map(sql),args);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'football-source-memory-'));
 let aggregateStatements=0,failBeforeUpsert=false;
 const mapped={async connect(){const client=await pool.connect();return {release:error=>client.release(error),async query(sql,args){
  if(sql.includes("SELECT string_agg(piece, '' ORDER BY seq)"))aggregateStatements++;
  if(failBeforeUpsert&&sql.includes('INSERT INTO football.source_snapshots'))throw Error('injected-before-source-upsert');
  return client.query(map(sql),args);
 }};}};
 const put=(payload)=>withPostgresTransaction(mapped,client=>insertBatches({client,table:'source_snapshots',columns:['id','source','captured_at','payload'],rows:[{id:'memory:archive',source:'synthetic',captured_at:'2026-10-15T00:00:00.000Z',payload}],jsonColumns:['payload'],conflict:snapshotUpsertConflict('source_snapshots')}));
 // Verification must not recreate the overlapping large conversion we repair.
 const stored=async()=>{
  const size=(await q("SELECT ctid::text AS tuple,octet_length(payload::text) AS bytes FROM football.source_snapshots WHERE id='memory:archive'")).rows[0];
  const digest=(await q("SELECT encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS sha FROM football.source_snapshots WHERE id='memory:archive'")).rows[0];
  return {...size,...digest};
 };
 const passed=[];
 try{
  await q('CREATE SCHEMA football');
  await q('CREATE TABLE football.source_snapshots(id text PRIMARY KEY,source text,captured_at timestamptz,payload json NOT NULL)');
  const first=fixture(directory,1);assert(first.bytes>=TARGET_BYTES);
  assert.equal(await put(first),1);let state=await stored();assert.equal(Number(state.bytes),first.bytes);assert.equal(state.sha,first.sha256);
  passed.push('new 512-MiB original UTF8 JSON commits byte-exact under the actual 2304-MiB PostgreSQL/no-extra-swap limit');
  const aggregations=aggregateStatements,oldTuple=state.tuple;
  assert.equal(await put(first),1);state=await stored();assert.equal(state.tuple,oldTuple);assert.equal(aggregateStatements,aggregations);assert.equal(state.sha,first.sha256);
  passed.push('unchanged original file preserves physical row and logical row count without JSON assembly');
  const second=fixture(directory,2);assert.notEqual(second.sha256,first.sha256);
  assert.equal(await put(second),1);state=await stored();assert.equal(state.sha,second.sha256);assert.equal(Number(state.bytes),second.bytes);
  passed.push('changed payload replaces the same id/capture clock with exact bytes without overlapping old/new text comparison');
  failBeforeUpsert=true;
  await assert.rejects(put(first),/injected-before-source-upsert/);failBeforeUpsert=false;
  assert.deepEqual(await stored(),state);
  const remaining=(await q("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'projection_json_parts_%'")).rows[0].count;assert.equal(remaining,0);
  passed.push('failure after real staged JSON validation rolls back all source changes and temporary tables');
  const afterMemory=containerEvidence(container);
  return {ok:true,database:name,scope:'isolated-loopback-synthetic-schema',checks:passed.length,passed,inputBytes:first.bytes,beforeMemory,afterMemory,productionWrites:0};
 }finally{
  await q('DROP SCHEMA IF EXISTS football CASCADE');
  const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('football-source-memory-'));fs.rmSync(resolved,{recursive:true});
 }
}
module.exports={verify};
if(require.main===module){
 const url=process.env.POSTGRES_SOURCE_MEMORY_TEST_DATABASE_URL;assert(url,'explicit test URL required');const parsed=new URL(url);assert(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname));assert.equal(parsed.pathname,'/recommendation_test');
 const pool=new Pool({connectionString:url,max:2,query_timeout:120000,connectionTimeoutMillis:5000});
 verify(pool,process.env.POSTGRES_SOURCE_MEMORY_CONTAINER).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>pool.end());
}
