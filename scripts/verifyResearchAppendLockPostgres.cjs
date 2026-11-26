'use strict';
// Requires an isolated PostgreSQL cluster. Synthetic fixtures only. The CLI
// accepts only an explicit loopback recommendation_test database.
const a=require('node:assert/strict'),{createHash}=require('node:crypto');
const {acquireResearchAppendLock,PROJECTION_KEY,APPEND_KEY}=require('../server/researchAppendLock.cjs');
const {createResearchReportStore}=require('../server/researchReportStore.cjs');
const sha=s=>createHash('sha256').update(s).digest('hex');
async function verify(pool){
 const schema='research_append_'+process.pid+'_'+Date.now(),map=s=>s.replaceAll('football.',schema+'.');
 const mapped={async connect(){const c=await pool.connect();return {release:e=>c.release(e),query:(s,v)=>c.query(map(s),v)};}};
 const store=createResearchReportStore({pool:mapped,runExclusive:fn=>fn()});
 const report=slot=>Buffer.from(JSON.stringify({version:'cloud-research-report-v1',businessDate:'2026-10-26',reportKind:slot,
   generatedAt:'2026-10-26T03:00:00.000Z',contents:{text:'Synthetic append concurrency 原件\n'}},null,2)+'\n');
 const counts=async()=>Number((await pool.query('SELECT count(*) AS n FROM '+schema+'.private_model_artifacts')).rows[0].n);
 let reader,holder,waiter;
 const checks=[];
 try{
  await pool.query('CREATE SCHEMA '+schema);
  await pool.query('CREATE TABLE '+schema+'.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,payload_sha256 text NOT NULL,payload_bytes integer NOT NULL)');
  reader=await pool.connect();await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await reader.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))',[PROJECTION_KEY]);
  a.equal(Number((await reader.query('SELECT count(*) AS n FROM '+schema+'.private_model_artifacts')).rows[0].n),0);
  const raw=report('morning-1100-review-and-early'),saved=await store.archive(raw,sha(raw));
  a.equal(saved.commitAcknowledged,true);a.equal(saved.originalJson,raw.toString());a.equal(await counts(),1);
  a.equal(Number((await reader.query('SELECT count(*) AS n FROM '+schema+'.private_model_artifacts')).rows[0].n),0);
  checks.push('shared-reader-coexists-with-exact-archive-and-keeps-repeatable-snapshot');
  const legacy=await pool.connect();try{await legacy.query('BEGIN');await legacy.query("SET LOCAL lock_timeout='2000ms'");await a.rejects(acquireResearchAppendLock(legacy),{code:'55P03'});}finally{await legacy.query('ROLLBACK');legacy.release();}
  checks.push('legacy-native-write-remains-exclusive');
  // While the real shared reader is held, execute the existing real signed
  // publication/revision/ACK verifiers against separate synthetic schemas.
  for(const name of ['verifyResearchIndependentAppendPostgres','verifyResearchComboSeriesPostgres']){
   const r=await require('./'+name+'.cjs').verify(pool);a.equal(r.ok,true);checks.push(name+'-while-shared-reader-held');
  }
  // A queued native writer must not be starved by new shared append requests.
  waiter=await pool.connect();await waiter.query('BEGIN');
  const waiterPid=Number((await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const queued=waiter.query('SELECT pg_advisory_xact_lock(hashtext($1))',[PROJECTION_KEY]);
  let queuedSeen=false;
  for(let i=0;i<100;i++){if((await pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype=\'advisory\' AND NOT granted',[waiterPid])).rowCount){queuedSeen=true;break;}await new Promise(r=>setTimeout(r,10));}
  a.equal(queuedSeen,true);
  const queuedRaw=report('weekday-2000-selected-two');await a.rejects(store.archive(queuedRaw,sha(queuedRaw)),{code:'55P03'});a.equal(await counts(),1);
  await reader.query('ROLLBACK');reader.release();reader=null;await queued;await waiter.query('ROLLBACK');waiter.release();waiter=null;
  checks.push('queued-native-exclusive-writer-not-bypassed-and-refused-append-writes-zero');
  holder=await pool.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))',[PROJECTION_KEY]);
  const raw2=report('weekday-2000-selected-two');await a.rejects(store.archive(raw2,sha(raw2)),{code:'55P03'});a.equal(await counts(),1);
  checks.push('native-projection-exclusive-still-refuses-with-original-2s-limit');
  await holder.query('ROLLBACK');holder.release();holder=null;
  holder=await pool.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))',[APPEND_KEY]);
  await a.rejects(store.archive(raw2,sha(raw2)),{code:'55P03'});a.equal(await counts(),1);
  await holder.query('ROLLBACK');holder.release();holder=null;
  checks.push('independent-append-writer-serialized-and-no-partial-insert');
  const different=Buffer.from(raw2.toString().replace('Synthetic append concurrency','Different immutable report'));
  holder=await pool.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))',[APPEND_KEY]);
  const competing=Promise.allSettled([store.archive(raw2,sha(raw2)),store.archive(different,sha(different))]);
  let bothQueued=false;for(let i=0;i<100;i++){const n=Number((await pool.query("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND objsubid=1 AND objid=((hashtext($1)::bigint & 4294967295)::oid) AND NOT granted",[APPEND_KEY])).rows[0].n);if(n===2){bothQueued=true;break;}await new Promise(r=>setTimeout(r,10));}
  await holder.query('ROLLBACK');holder.release();holder=null;const simultaneous=await competing;a.equal(bothQueued,true);
  a.equal(simultaneous.filter(r=>r.status==='fulfilled').length,1);a.equal(await counts(),2);
  for(const r of simultaneous)if(r.status==='rejected')a(['23505','40001','55P03'].includes(r.reason.code));
  const winner=simultaneous[0].status==='fulfilled'?raw2:different;
  a.equal((await store.read('2026-10-26','weekday-2000-selected-two',sha(winner))).originalJson,winner.toString());
  checks.push('different-originals-same-slot-both-snapshots-before-mutex-release-one-winner-never-overwrite');
  for(const name of ['verifyResearchRevisionPostgres','verifyResearchComboRevisionPostgres','verifyResearchPublicationRetryPostgres','verifyResearchArchiveRetryPostgres']){const result=await require('./'+name+'.cjs').verify(pool);a.equal(result.ok,true);checks.push(name+'-original-contract-retained');}
  checks.push('original-explicit-retry-boundary-retained');
  return {ok:true,checks,productionWrites:0,isolatedFixtureWrites:true,secondAckProtocolUnchanged:true,globalExclusiveProtectionRetained:true};
 }finally{
  for(const c of [reader,holder,waiter])if(c){try{await c.query('ROLLBACK');}finally{c.release();}}
  await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
 }
}
if(require.main===module){const u=new URL(process.env.RESEARCH_REPORT_TEST_DATABASE_URL||'invalid:');if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/recommendation_test')throw Error('Explicit disposable local database required');const pool=new(require('pg').Pool)({connectionString:u.href,ssl:false,max:12});verify(pool).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
