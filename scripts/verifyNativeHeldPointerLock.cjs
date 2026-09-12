"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {commitDataGeneration,acquirePointerCommitLock,storePaths,inspectPointerCommitLockActivity}=require("../server/dataGenerationStore.cjs");
const {acquireGenerationReadLease}=require("../server/dataGenerationBundle.cjs");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"football-held-pointer-")),storeDir=path.join(root,"store");let held;
try {
  const generation=commitDataGeneration({storeDir,sourceCycleId:"native-held-lock-fixture",files:{"matches.json":{data:[],rows:0}},coreFiles:["matches.json"]});
  const lockDir=storePaths(storeDir).pointerLockDir;
  held=acquirePointerCommitLock({lockDir,timeoutMs:100});
  fs.writeFileSync(path.join(lockDir,"owner.json"),JSON.stringify({...held.owner,acquiredAt:new Date(Date.now()-180000).toISOString()}));
  assert.equal(inspectPointerCommitLockActivity({lockDir}).reason,"lock-stale");
  const options={storeDir,generationId:generation.context.generationId,context:generation.context,pointerLockHandle:held};
  const lease=acquireGenerationReadLease(options);lease.release();
  assert.throws(()=>acquireGenerationReadLease({...options,pointerLockHandle:{owner:{...held.owner,token:"00000000-0000-4000-8000-000000000000"},release(){}}}),error=>error.code==="GENERATION_READER_POINTER_LOCK_MISMATCH");
  held.release();held=null;
  assert.throws(()=>acquireGenerationReadLease(options),error=>error.code==="GENERATION_READER_POINTER_LOCK_MISMATCH");
  console.log(JSON.stringify({ok:true,expiredObserverWithActualOwnerAccepted:true,foreignTokenRejected:true,releasedHandleRejected:true,productionWrites:0}));
}finally{
  if(held)held.release();
  assert.equal(path.dirname(fs.realpathSync(root)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(root).startsWith("football-held-pointer-"));fs.rmSync(root,{recursive:true,force:true});
}
