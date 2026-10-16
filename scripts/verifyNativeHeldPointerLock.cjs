"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {commitDataGeneration,acquirePointerCommitLock,storePaths,inspectPointerCommitLockActivity}=require("../server/dataGenerationStore.cjs");
const {acquireGenerationReadLease,acquireCommittedPostgresPublicationReadLease,resolveCommittedPostgresPublication}=require("../server/dataGenerationBundle.cjs");
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
  const context=generation.context,identity={mode:"active-generation",generationId:context.generationId,
    manifestHash:context.manifestHash,sourceCycleId:context.sourceCycleId,committedAt:new Date().toISOString()};
  const pairedOptions={storeDir,publicDataDir:path.join(root,"public-data"),postgresIdentity:identity,validatePayloadSemantics:false};
  const target=path.join(context.generationDir,"matches.json"),size=fs.statSync(target).size;
  const originalOpen=fs.openSync,originalRead=fs.readSync,originalClose=fs.closeSync,fds=new Map();let bytes=0,readsHeld=true;
  const observe=action=>{
    bytes=0;readsHeld=true;
    fs.openSync=function(file,...args){const fd=originalOpen.call(fs,file,...args);if(typeof file==='string'&&path.resolve(file)===target)fds.set(fd,true);return fd;};
    fs.readSync=function(fd,...args){const n=originalRead.call(fs,fd,...args);if(fds.has(fd)&&n){bytes+=n;const state=inspectPointerCommitLockActivity({lockDir,staleMs:Number.MAX_SAFE_INTEGER});readsHeld=readsHeld&&state.active&&state.owner.pid===process.pid;}return n;};
    fs.closeSync=function(fd,...args){fds.delete(fd);return originalClose.call(fs,fd,...args);};
    try{return action();}finally{fs.openSync=originalOpen;fs.readSync=originalRead;fs.closeSync=originalClose;}
  };
  // Count actual payload I/O rather than a declared audit field or mocked hash.
  const old=observe(()=>{const p=resolveCommittedPostgresPublication(pairedOptions);return acquireGenerationReadLease({storeDir,generationId:context.generationId,context:p.context});});
  assert.equal(bytes,size*2);old.release();
  const paired=observe(()=>acquireCommittedPostgresPublicationReadLease(pairedOptions));
  assert.equal(bytes,size);assert.equal(readsHeld,true);assert.equal(paired.publication.context.generationId,context.generationId);
  assert.equal(fs.existsSync(paired.lease.path),true);assert.equal(inspectPointerCommitLockActivity({lockDir}).active,false);
  assert.equal(paired.lease.release(),true);assert.equal(paired.lease.release(),false);
  const readerDir=path.join(storePaths(storeDir).root,'readers'),beforeReaders=fs.readdirSync(readerDir);
  for(const invalid of [{...identity,sourceCycleId:'wrong'},{...identity,manifestHash:'0'.repeat(64)},
    {...identity,committedAt:'not-a-clock'},{...identity,generationId:'g-'+ '0'.repeat(64)}]){
    assert.throws(()=>acquireCommittedPostgresPublicationReadLease({...pairedOptions,postgresIdentity:invalid}));
    assert.deepEqual(fs.readdirSync(readerDir),beforeReaders);assert.equal(inspectPointerCommitLockActivity({lockDir}).active,false);
  }
  held=acquirePointerCommitLock({lockDir,timeoutMs:100});
  const borrowed=acquireCommittedPostgresPublicationReadLease({...pairedOptions,pointerLockHandle:held});
  assert.equal(inspectPointerCommitLockActivity({lockDir}).active,true);borrowed.lease.release();
  assert.throws(()=>acquireCommittedPostgresPublicationReadLease({...pairedOptions,pointerLockHandle:{owner:{...held.owner,token:'foreign'},release(){}}}),{code:'GENERATION_READER_POINTER_LOCK_MISMATCH'});
  held.release();held=null;
  const originalWrite=fs.writeFileSync;fs.writeFileSync=function(file,...args){if(typeof file==='string'&&path.dirname(file)===readerDir)throw new Error('fixture lease write refused');return originalWrite.call(fs,file,...args);};
  try{assert.throws(()=>acquireCommittedPostgresPublicationReadLease(pairedOptions),/fixture lease write refused/);}finally{fs.writeFileSync=originalWrite;}
  assert.equal(inspectPointerCommitLockActivity({lockDir}).active,false);assert.deepEqual(fs.readdirSync(readerDir),beforeReaders);
  // A successful previous validation never authorizes changed bytes later.
  const originalBytes=fs.readFileSync(target);fs.writeFileSync(target,Buffer.from('{}\n'));
  assert.equal(fs.statSync(target).size,originalBytes.length);
  assert.throws(()=>acquireCommittedPostgresPublicationReadLease(pairedOptions),{code:'FILE_HASH_MISMATCH'});
  assert.deepEqual(fs.readdirSync(readerDir),beforeReaders);fs.writeFileSync(target,originalBytes);
  const final=acquireCommittedPostgresPublicationReadLease(pairedOptions);final.lease.release();
  console.log(JSON.stringify({ok:true,expiredObserverWithActualOwnerAccepted:true,foreignTokenRejected:true,releasedHandleRejected:true,
    pairedPublicationPayloadHashedOnceUnderActualPointerLock:true,identityAndLaterCorruptionRejected:true,leaseFailureReleasesOwnedLock:true,
    borrowedPointerLockRetained:true,noCrossRequestValidationCache:true,productionWrites:0}));
}finally{
  if(held)held.release();
  assert.equal(path.dirname(fs.realpathSync(root)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(root).startsWith("football-held-pointer-"));fs.rmSync(root,{recursive:true,force:true});
}
