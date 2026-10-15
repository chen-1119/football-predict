'use strict';
// Isolated loopback test database only. No production probe or writer control.
const a=require('node:assert/strict'),{Pool}=require('pg');
const {KEY,receiptBarrierState,acquireReceiptReadBarrier}=require('./postgresReceiptBarrier.cjs');
async function verify(){
 const raw=process.env.RECEIPT_BARRIER_TEST_DATABASE_URL;a(raw,'explicit isolated DB URL required');const url=new URL(raw);a(['postgres:','postgresql:'].includes(url.protocol));a(['127.0.0.1','localhost','[::1]'].includes(url.hostname));a.equal(url.pathname,'/recommendation_test');
 const pool=new Pool({connectionString:raw,ssl:false,max:4,connectionTimeoutMillis:3000,query_timeout:8000,application_name:'receipt-barrier-isolated-verifier'}),clients=[];
 const schema='receipt_barrier_'+process.pid+'_'+Date.now();a(/^receipt_barrier_\d+_\d+$/.test(schema));let made=false;
 try{
  for(let i=0;i<4;i++)clients.push(await pool.connect());const[writer,reader,next,observer]=clients;
  a.equal((await observer.query('SELECT current_database() AS name')).rows[0].name,'recommendation_test');
  await observer.query('CREATE SCHEMA '+schema);made=true;await observer.query('CREATE TABLE '+schema+'.marker(value integer NOT NULL)');await observer.query('INSERT INTO '+schema+'.marker VALUES(0)');
  const readerPid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,nextPid=(await next.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await reader.query("SET lock_timeout='7s'");
  await writer.query('SELECT pg_advisory_lock(hashtext($1))',[KEY]);
  const nonblocking=receiptBarrierState();await a.rejects(acquireReceiptReadBarrier(reader,nonblocking),/barrier busy/);a.deepEqual(nonblocking,receiptBarrierState());
  const timeout=receiptBarrierState();await a.rejects(acquireReceiptReadBarrier(reader,timeout,50),e=>e.cause?.code==='55P03');a.deepEqual(timeout,receiptBarrierState());a.equal((await reader.query('SHOW lock_timeout')).rows[0].lock_timeout,'7s');
  a.equal((await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory'",[readerPid])).rows[0].n,0);
  await writer.query('BEGIN');await writer.query('UPDATE '+schema+'.marker SET value=1');
  const state=receiptBarrierState(),acquiring=acquireReceiptReadBarrier(reader,state,2000);let acquisitionError;acquiring.catch(e=>{acquisitionError=e;});
  const waitFor=async(pid,mode)=>{const start=Date.now();while(Date.now()-start<1000){if(acquisitionError)throw acquisitionError;const rows=(await observer.query("SELECT granted FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND mode=$2",[pid,mode])).rows;if(rows.some(r=>r.granted===false))return;await new Promise(r=>setTimeout(r,5));}throw Error('real queued lock not observed');};
  await waitFor(readerPid,'ShareLock');let nextGranted=false;const nextLock=next.query('SELECT pg_advisory_lock(hashtext($1))',[KEY]).then(()=>{nextGranted=true;});nextLock.catch(()=>{});await waitFor(nextPid,'ExclusiveLock');
  await writer.query('COMMIT');await writer.query('SELECT pg_advisory_unlock(hashtext($1))',[KEY]);await acquiring;
  a.equal(state.held,true);a.equal(nextGranted,false);a.equal((await reader.query('SHOW lock_timeout')).rows[0].lock_timeout,'7s');
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');a.equal((await reader.query('SELECT value FROM '+schema+'.marker')).rows[0].value,1);await reader.query('ROLLBACK');
  a.equal(nextGranted,false);a.equal((await reader.query('SELECT pg_advisory_unlock_shared(hashtext($1)) AS released',[KEY])).rows[0].released,true);await nextLock;a.equal(nextGranted,true);await next.query('SELECT pg_advisory_unlock(hashtext($1))',[KEY]);
  // Reproduce the production scheduling issue: a legitimate view transaction
  // lasts longer than the former 2s queue slice and another writer follows it.
  await writer.query('SELECT pg_advisory_lock(hashtext($1))',[KEY]);await writer.query('BEGIN');await writer.query('UPDATE '+schema+'.marker SET value=2');
  const longState=receiptBarrierState(),began=Date.now(),longAcquire=acquireReceiptReadBarrier(reader,longState,60000);longAcquire.catch(e=>{acquisitionError=e;});
  await waitFor(readerPid,'ShareLock');nextGranted=false;const afterReader=next.query('SELECT pg_advisory_lock(hashtext($1))',[KEY]).then(()=>{nextGranted=true;});afterReader.catch(()=>{});await waitFor(nextPid,'ExclusiveLock');
  await new Promise(r=>setTimeout(r,2200));a.equal(nextGranted,false);a.equal(longState.held,false);
  await writer.query('COMMIT');await writer.query('SELECT pg_advisory_unlock(hashtext($1))',[KEY]);await longAcquire;a(Date.now()-began>2000);a.equal(nextGranted,false);
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');a.equal((await reader.query('SELECT value FROM '+schema+'.marker')).rows[0].value,2);await reader.query('ROLLBACK');
  a.equal((await reader.query('SHOW lock_timeout')).rows[0].lock_timeout,'7s');a.equal((await reader.query('SELECT pg_advisory_unlock_shared(hashtext($1)) AS released',[KEY])).rows[0].released,true);await afterReader;await next.query('SELECT pg_advisory_unlock(hashtext($1))',[KEY]);
  return{ok:true,checks:6,actualPostgresLocks:true,queuedReaderPrecedesLaterWriter:true,retainsFifoBeyondFormerTwoSecondSlice:true,repeatableReadStartsAfterWriterCommit:true,timeoutRestoresOriginalSetting:true,timeoutLeavesNoQueuedOrGrantedLock:true,ordinaryDefaultStillNonblocking:true,productionWrites:0,fixtureOnly:true};
 }finally{
  for(const c of clients){try{await c.query('ROLLBACK');await c.query('SELECT pg_advisory_unlock_all()');}catch{/* only disposable fixture sessions */}}
  try { if(made&&clients[3])await clients[3].query('DROP SCHEMA '+schema+' CASCADE'); }
  finally { for(const c of clients)c.release();await pool.end(); }
 }
}
module.exports={verify};if(require.main===module)verify().then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1;});
