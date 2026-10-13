'use strict';const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runOfficialArtifactGeneration,runWithSharedSlowArtifactLock,usesSharedSlowArtifact}=require('../scripts/runSyncWorker.cjs');
function gate(){let held=false;return{acquire:async()=>held?{acquired:false,reason:'busy'}:(held=true,{acquired:true,release:async()=>{held=false;}}),held:()=>held};}
test('model writers cannot change the evaluation file while generation captures it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-eval-snapshot-')),file=path.join(dir,'model-evaluation.json'),g=gate();fs.writeFileSync(file,'{"version":1}');
 try{await runOfficialArtifactGeneration({isInterrupted:()=>false,acquireLock:g.acquire,task:async()=>{
  const before=fs.readFileSync(file);const model=await runWithSharedSlowArtifactLock({enabled:true,script:'model:backtest',waitMs:0,acquireLock:g.acquire,isInterrupted:()=>false,task:async()=>{fs.writeFileSync(file,'{"version":2,"new":"larger"}');return{ok:true};}});
  a.equal(model.deferred,true);a.deepEqual(fs.readFileSync(file),before);
 }});a.equal(g.held(),false);
 const model=await runWithSharedSlowArtifactLock({enabled:true,script:'model:backtest',waitMs:0,acquireLock:g.acquire,isInterrupted:()=>false,task:async()=>{fs.writeFileSync(file,'{"version":2}');return{ok:true};}});a.equal(model.ok,true);a.equal(JSON.parse(fs.readFileSync(file)).version,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('an active model writer defers generation without starting it or stealing its lock',async()=>{
 const g=gate(),owner=await g.acquire();let ran=false;
 await a.rejects(runOfficialArtifactGeneration({isInterrupted:()=>false,acquireLock:g.acquire,task:async()=>{ran=true;}}),{code:'SYNC_WORKER_SHARED_ARTIFACT_BUSY'});a.equal(ran,false);a.equal(g.held(),true);await owner.release();
});
test('generation failure releases its own artifact lock',async()=>{const g=gate();await a.rejects(runOfficialArtifactGeneration({isInterrupted:()=>false,acquireLock:g.acquire,task:async()=>{throw Error('source hash rejected');}}),/source hash/);a.equal(g.held(),false);});
for(const script of ['model:backtest','model:learn','model:learn:autonomous','audit:capability','optimize:strategy'])test(script+' uses the shared artifact permit',()=>a.equal(usesSharedSlowArtifact(script),true));
