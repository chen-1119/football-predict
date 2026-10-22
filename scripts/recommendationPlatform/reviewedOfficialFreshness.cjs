'use strict';
// Passive V4 readiness only. This never collects, changes a snapshot, opens a
// write transaction or grants permission to reuse its observation in publish.
const {performance}=require('node:perf_hooks');
const p=require('./reviewedAnalysis.cjs');
const {epochNanoseconds:ns}=require('../../src/services/prematchV3Clock.cjs');
const {readLiveOfficialSnapshot}=require('./liveOfficialHandicap.cjs');
const WAIT_MS=10000,POLL_MS=250,READY_AGE_MS=15000;
const freshError='REVIEWED_ANALYSIS_OFFICIAL_EVENT_FRESH_CLOCK';
const budgetError=()=>Object.assign(Error('REVIEWED_ANALYSIS_OFFICIAL_FRESH_WAIT_BUDGET'),{code:'REVIEWED_ANALYSIS_OFFICIAL_FRESH_WAIT_BUDGET'});
function sourceAge(snapshot,asOf){
 const now=ns(asOf);p.check(now!==null,'OFFICIAL_EVENT_FRESH_CLOCK');let oldest=0n;
 for(const method of ['current','calculator']){
  const entries=snapshot?.endpoints?.filter(e=>e?.method===method);
  p.check(entries?.length===1,'OFFICIAL_EVENT_ENDPOINT');
  const requested=ns(entries[0].requestedAt),received=ns(entries[0].receivedAt);
  p.check(requested!==null&&received!==null&&requested<=received&&received<=now,'OFFICIAL_EVENT_FRESH_CLOCK');
  for(const at of [requested,received])if(now-at>oldest)oldest=now-at;
 }
 return oldest;
}
async function waitForFreshOfficialDraft(draft,{pool,trustRegistry,readSnapshot=readLiveOfficialSnapshot}){
 p.check(draft?.version===4&&typeof pool?.connect==='function'&&typeof readSnapshot==='function','OFFICIAL_FRESH_INPUT');
 const startedUtc=Date.now(),startedMono=performance.now();let lastUtc=startedUtc,lastMono=startedMono,lastDb=null;
 function remaining(){
  const utc=Date.now(),mono=performance.now();
  if(!Number.isFinite(utc)||!Number.isFinite(mono)||utc<lastUtc||mono<lastMono)throw budgetError();
  lastUtc=utc;lastMono=mono;
  const left=WAIT_MS-Math.max(utc-startedUtc,mono-startedMono);
  if(left<=0)throw budgetError();return left;
 }
 // Bound connection acquisition and SELECT as well as polling. A late pool
 // connection is released, and an interrupted SELECT destroys only its own
 // read connection. No database command or write is retried after failure.
 function bounded(work,onLate=()=>{}){
  const left=remaining();return new Promise((resolve,reject)=>{
   let done=false;const timer=setTimeout(()=>{done=true;reject(budgetError());},Math.ceil(left));
   Promise.resolve().then(work).then(value=>{
    if(done){onLate(value);return;}done=true;clearTimeout(timer);
    try{remaining();resolve(value);}catch(error){onLate(value);reject(error);}
   },error=>{if(!done){done=true;clearTimeout(timer);reject(error);}});
  });
 }
 for(;;){
  remaining();const snapshot=readSnapshot();remaining();
  const client=await bounded(()=>pool.connect(),late=>late.release(budgetError()));let broken,asOf;
  try{
   const result=await bounded(()=>client.query('SELECT clock_timestamp() AS now'));
   const at=result.rows[0]?.now;asOf=at instanceof Date?at.toISOString():at;
  }catch(error){broken=error;throw error;}finally{client.release(broken);}
  remaining();const db=ns(asOf);
  p.check(db!==null&&(lastDb===null||db>=lastDb),'OFFICIAL_EVENT_FRESH_CLOCK');lastDb=db;
  // A future, malformed or reversed endpoint clock is never a wait condition.
  // Other policy failures are also terminal. Only stale acquisition clocks or
  // a fully valid source with insufficient transport margin may wait.
  let age;
  try{p.make(draft,{matches:[],snapshot,trustRegistry,asOf});age=sourceAge(snapshot,asOf);}
  catch(error){if(error.code!==freshError)throw error;age=sourceAge(snapshot,asOf);if(age<=30000n*1000000n)throw error;}
  remaining();
  if(age<=BigInt(READY_AGE_MS)*1000000n)return;
  await bounded(()=>new Promise(resolve=>setTimeout(resolve,Math.min(POLL_MS,Math.floor(remaining())))));
 }
}
module.exports={WAIT_MS,POLL_MS,READY_AGE_MS,waitForFreshOfficialDraft};
