'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),vm=require('node:vm');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),f=require('./fixtures/reviewed-official-event.cjs');
const live=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs'),fresh=require('../scripts/recommendationPlatform/reviewedOfficialFreshness.cjs');
function age(v,ms){for(const e of v.snapshot.endpoints){e.requestedAt=f.stamp(f.NOW-ms);e.receivedAt=f.stamp(f.NOW-ms);f.resign(e,v.pair);}return v;}
function db(clock=()=>f.stamp(f.NOW)){
 const sql=[],released=[];let connects=0;
 return{sql,released,get connects(){return connects;},pool:{async connect(){connects++;return{async query(text){sql.push(text);a.equal(text,'SELECT clock_timestamp() AS now');return{rows:[{now:clock()}]};},release(error){released.push(error||null);}};}}};
}
function simulated({utcDelta=250,monoDelta=250,utcStart=0,monoStart=0}={}){
 let utc=utcStart,mono=monoStart,sleeps=0;
 const filename=path.resolve(__dirname,'../scripts/recommendationPlatform/reviewedOfficialFreshness.cjs'),native=Module.createRequire(filename),m={exports:{}};
 class Clock extends Date{static now(){return utc;}}
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:m,exports:m.exports,Date:Clock,Buffer,clearTimeout,
  setTimeout(fn,ms){if(ms===250){sleeps++;return setTimeout(()=>{utc+=utcDelta;mono+=monoDelta;fn();},0);}return setTimeout(fn,ms);},
  require:id=>id==='node:perf_hooks'?{performance:{now:()=>mono}}:native(id)});
 return{fresh:m.exports,get sleeps(){return sleeps;},set(du,dm){utc+=du;mono+=dm;}};
}
test('freshness policy keeps fixed 10 second wait and 15 second margin, returning no reusable snapshot',async()=>{
 a.equal(fresh.WAIT_MS,10000);a.equal(fresh.READY_AGE_MS,15000);a.equal(fresh.POLL_MS,250);
 const v=age(f.setup(),15000),d=db();const before=JSON.stringify(v);
 a.equal(await fresh.waitForFreshOfficialDraft(v.draft,{pool:d.pool,trustRegistry:v.trustRegistry,readSnapshot:()=>v.snapshot}),undefined);
 a.equal(d.connects,1);a.deepEqual(d.sql,['SELECT clock_timestamp() AS now']);a.deepEqual(d.released,[null]);a.equal(JSON.stringify(v),before);
});
test('real temporary natural file replacement is passively observed, with SELECT only and no transaction held',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reviewed-fresh-')),file=path.join(dir,'fast.json'),v=age(f.setup(),31000),d=db();
 fs.writeFileSync(file,JSON.stringify(v.snapshot));let replaced=false;
 const timer=setTimeout(()=>{const next=age(f.setup(v.pair),1000);fs.writeFileSync(file+'.next',JSON.stringify(next.snapshot));fs.renameSync(file+'.next',file);replaced=true;},80);
 try{
  await fresh.waitForFreshOfficialDraft(v.draft,{pool:d.pool,trustRegistry:v.trustRegistry,readSnapshot:()=>{a.equal(d.connects,d.released.length);return live.readLiveOfficialSnapshot({SPORTTERY_RELAY_FAST_LANE_SNAPSHOT:file});}});
  a.equal(replaced,true);a(d.connects>=2);a(d.sql.every(x=>x==='SELECT clock_timestamp() AS now'));a.equal(d.connects,d.released.length);
 }finally{clearTimeout(timer);fs.rmSync(dir,{recursive:true,force:true});}
});
for(const [name,change]of[
 ['bad signature',v=>v.snapshot.endpoints[0].collectorAttestation.signature='invalid'],
 ['closed event',v=>{for(const e of v.snapshot.endpoints){e.payload.value.matchInfoList[0].subMatchList[0].sellStatus=2;f.resign(e,v.pair);}}],
 ['lane identity mismatch',v=>{v.snapshot.endpoints[1].payload.value.matchInfoList[0].subMatchList[0].homeTeamId=999;f.resign(v.snapshot.endpoints[1],v.pair);}],
 ['future clock',v=>{v.snapshot.endpoints[0].receivedAt=f.stamp(f.NOW+1);f.resign(v.snapshot.endpoints[0],v.pair);}],
 ['malformed clock',v=>v.snapshot.endpoints[0].requestedAt='yesterday'],
 ['reversed clock',v=>{v.snapshot.endpoints[0].requestedAt=f.stamp(f.NOW);v.snapshot.endpoints[0].receivedAt=f.stamp(f.NOW-1);f.resign(v.snapshot.endpoints[0],v.pair);}],
])test(name+' rejects without waiting or any DB write',async()=>{
 const v=f.setup(),d=db(),s=simulated();change(v);
 await a.rejects(s.fresh.waitForFreshOfficialDraft(v.draft,{pool:d.pool,trustRegistry:v.trustRegistry,readSnapshot:()=>v.snapshot}));
 a.equal(d.connects,1);a.equal(s.sleeps,0);a.deepEqual(d.sql,['SELECT clock_timestamp() AS now']);
});
for(const [name,options]of[
 ['UTC budget',{utcDelta:10000,monoDelta:1}],
 ['monotonic budget',{utcDelta:1,monoDelta:10000}],
 ['UTC rollback',{utcDelta:-1,monoDelta:1}],
 ['monotonic rollback',{utcDelta:1,monoDelta:-1}],
])test(name+' cannot extend passive wait',async()=>{
 const v=age(f.setup(),31000),d=db(),s=simulated(options);
 await a.rejects(s.fresh.waitForFreshOfficialDraft(v.draft,{pool:d.pool,trustRegistry:v.trustRegistry,readSnapshot:()=>v.snapshot}),{code:'REVIEWED_ANALYSIS_OFFICIAL_FRESH_WAIT_BUDGET'});
 a.equal(d.connects,1);a.equal(s.sleeps,1);a.equal(d.connects,d.released.length);
});
test('a policy-valid 15001ms source waits for margin and never weakens the 30 second policy',async()=>{
 const v=age(f.setup(),15001),d=db(),s=simulated({utcDelta:10000,monoDelta:10000});
 a.equal(p.make(v.draft,v).records.length,2);
 await a.rejects(s.fresh.waitForFreshOfficialDraft(v.draft,{pool:d.pool,trustRegistry:v.trustRegistry,readSnapshot:()=>v.snapshot}),{code:'REVIEWED_ANALYSIS_OFFICIAL_FRESH_WAIT_BUDGET'});
 const stale=age(f.setup(),30001);a.throws(()=>p.make(stale.draft,stale),{code:'REVIEWED_ANALYSIS_OFFICIAL_EVENT_FRESH_CLOCK'});
});
test('DB clock rollback and query failure refuse without a publication attempt',async()=>{
 const v=age(f.setup(),31000),s=simulated();let tick=0;const d=db(()=>f.stamp(f.NOW-(tick++?1:0)));
 await a.rejects(s.fresh.waitForFreshOfficialDraft(v.draft,{pool:d.pool,trustRegistry:v.trustRegistry,readSnapshot:()=>v.snapshot}),{code:'REVIEWED_ANALYSIS_OFFICIAL_EVENT_FRESH_CLOCK'});
 let released;const error=Object.assign(Error('query refused'),{code:'55P03'}),pool={async connect(){return{query(){throw error;},release(e){released=e;}};}};
 await a.rejects(fresh.waitForFreshOfficialDraft(v.draft,{pool,trustRegistry:v.trustRegistry,readSnapshot:()=>v.snapshot}),error);a.equal(released,error);
});
test('a connection arriving after the budget is released and never queried',async()=>{
 const v=f.setup(),s=simulated();let released,queries=0;
 const pool={async connect(){s.set(10000,10000);return{query(){queries++;},release(error){released=error;}};}};
 await a.rejects(s.fresh.waitForFreshOfficialDraft(v.draft,{pool,trustRegistry:v.trustRegistry,readSnapshot:()=>v.snapshot}),{code:'REVIEWED_ANALYSIS_OFFICIAL_FRESH_WAIT_BUDGET'});
 a.equal(queries,0);a.equal(released.code,'REVIEWED_ANALYSIS_OFFICIAL_FRESH_WAIT_BUDGET');
});
