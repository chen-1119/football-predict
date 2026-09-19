const {test}=require('node:test'),assert=require('node:assert/strict');
const {publicationRefreshBlocked,nativePublicationReadError,publicationTransitionHealth}=require('../server/publicationRefreshPolicy.cjs');
const status={available:true,baseReady:false,baseBlockedReason:'postgres-generation-mismatch',counts:{currentMatches:64,historyMatches:2296},syncMetaUpdatedAt:'2026-09-19T02:15:49.712Z'};
const fallback={ok:false,status:{serviceOk:false,dataFresh:false,recommendationReliable:false},sync:{workerState:'health-refresh-failed'},data:{currentCount:0,historyCount:0},storage:{sqlite:null}};
test('committed native projection can refresh while enrichment keeps the sync lock',()=>{
 assert.equal(publicationRefreshBlocked({postgresOnly:true,pointerLocked:false,syncLocked:true}),false);
 assert.equal(publicationRefreshBlocked({postgresOnly:true,pointerLocked:true,syncLocked:true}),true);
});
test('legacy paired stores still wait for the complete sync publication',()=>{
 assert.equal(publicationRefreshBlocked({postgresOnly:false,pointerLocked:false,syncLocked:true}),true);
 assert.equal(publicationRefreshBlocked({postgresOnly:false,pointerLocked:true,syncLocked:false}),true);
 assert.equal(publicationRefreshBlocked({postgresOnly:false,pointerLocked:false,syncLocked:false}),false);
});
test('active verified-pair refresh reports a retryable switch without erasing database counts',()=>{
 const e=nativePublicationReadError(status,true);assert.equal(e.statusCode,503);assert.equal(e.code,'POSTGRES_PUBLICATION_TRANSITION');
 const h=publicationTransitionHealth(fallback,e);assert.equal(h.data.currentCount,64);assert.equal(h.data.historyCount,2296);assert.equal(h.sync.workerState,'publication-transition');assert.equal(h.status.serviceOk,true);
 assert.equal(h.ok,false);assert.equal(h.status.dataFresh,false);assert.equal(h.status.recommendationReliable,false);assert.equal(h.storage.postgres.baseReady,false);
 assert.equal(fallback.data.currentCount,0);
});
test('offline database and failed validation remain real errors even if a refresh was attempted',()=>{
 for(const s of [{...status,available:false},{...status,baseReady:true},{...status,baseBlockedReason:'invalid-manifest'}]){
  const e=nativePublicationReadError(s,true);assert.equal(e.code,'POSTGRES_REQUIRED_READ_UNAVAILABLE');assert.equal(publicationTransitionHealth(fallback,e),fallback);
 }
 const e=nativePublicationReadError(status,false);assert.equal(e.code,'POSTGRES_REQUIRED_READ_UNAVAILABLE');assert.equal(publicationTransitionHealth(fallback,e),fallback);
});
test('a known empty PostgreSQL dataset is reported as zero, not resurrected from old files',()=>{
 const h=publicationTransitionHealth(fallback,nativePublicationReadError({...status,counts:{currentMatches:0,historyMatches:2300}},true));assert.equal(h.data.currentCount,0);assert.equal(h.data.historyCount,2300);
});
test('read failure marker survives the frontend fetch error and marks a cold page as syncing',()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync(require('path').join(__dirname,'../src/components/Navbar.tsx'),'utf8');
 const start=source.indexOf('  const publicationTransition = [');const end=source.indexOf('  const dataStatusLabel =',start);
 const logic=source.slice(start,end).replace('const dataStatus: DataStatus','const dataStatus');
 const evaluate=(dataSync,currentUser={id:'qa'})=>vm.runInNewContext(logic+'; dataStatus',{dataSync,currentUser});
 assert.equal(evaluate({error:'HTTP 503 [POSTGRES_PUBLICATION_TRANSITION]',currentLoaded:false,currentCount:0}),'syncing');
 assert.equal(evaluate({error:'HTTP 503 [POSTGRES_REQUIRED_READ_UNAVAILABLE]',currentLoaded:false,currentCount:0}),'error');
 assert.equal(evaluate({error:'HTTP 503 [POSTGRES_PUBLICATION_TRANSITION]'},null),'locked');
 assert.equal(evaluate({currentLoaded:true,currentCount:64,recommendationReliable:false}),'watch');
});
test('resolver polls only identity before commit, then validates the advanced generation in full',async()=>{
 const fs=require('fs'),vm=require('vm'),path=require('path');
 const code=fs.readFileSync(path.join(__dirname,'../server/publicationResolverWorker.cjs'),'utf8');
 async function resolve(current){let validations=0,leases=0;const cached={generationId:'verified-old',manifestHash:'old-hash'};
  const message=await new Promise((resolve,reject)=>{
   vm.runInNewContext(code,{require(name){
    if(name==='node:worker_threads')return {parentPort:{postMessage:resolve},workerData:{requirePostgresPair:true,cachedPostgresIdentity:cached,ownerPid:1}};
    if(name==='./dataGenerationBundle.cjs')return {sqlitePublicationMatches:(a,b)=>a.generationId===b.generationId&&a.manifestHash===b.manifestHash,resolveServingPublicationForSqliteIdentity:()=>{validations++;return {identity:current,context:{generationId:current.generationId}};},acquireGenerationReadLease:()=>{leases++;return {path:'temporary-test-lease'};}};
    if(name==='./sqliteStore.cjs')return {};
    if(name==='./postgresStore.cjs')return {postgresEnabled:()=>true,createPostgresPool:()=>({end:async()=>{}})};
    if(name==='./postgresProjectionStore.cjs')return {readPostgresPublicationIdentity:async()=>({available:true,publication:current})};
    throw Error(name);
   }},{timeout:1000});
  });return {message,validations,leases};
 }
 const before=await resolve({generationId:'verified-old',manifestHash:'old-hash'});assert.equal(before.message.unchangedPostgresIdentity,true);assert.equal(before.validations,0);assert.equal(before.leases,0);
 const after=await resolve({generationId:'new-committed',manifestHash:'new-hash'});assert.equal(after.message.ok,true);assert.equal(after.message.publication.identity.generationId,'new-committed');assert.equal(after.validations,1);assert.equal(after.leases,1);
});
