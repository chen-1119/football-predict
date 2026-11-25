const {test}=require('node:test'),assert=require('node:assert/strict');
const {publicationRefreshBlocked,nativePublicationReadError,publicationTransitionHealth}=require('../server/publicationRefreshPolicy.cjs');
const status={available:true,baseReady:false,baseBlockedReason:'postgres-generation-mismatch',counts:{currentMatches:64,historyMatches:2296},syncMetaUpdatedAt:'2026-09-19T02:15:49.712Z'};
const fallback={ok:false,status:{serviceOk:false,dataFresh:false,recommendationReliable:false},sync:{workerState:'health-refresh-failed'},data:{currentCount:0,historyCount:0},storage:{sqlite:null}};
// Exercise the normal response builder without starting HTTP, PostgreSQL or a worker.
test('a fresh source cannot renew an older served generation', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../server/index.cjs'), 'utf8');
  // Feed the fallback channel the same isolated clock expressions as the real
  // source builder, including an unrelated update in the shared external file.
  const fallbackClocks = /const fiveHundredFreshness = ([^;]+);\s*const fiveHundredDetailsFreshness = ([^;]+);/.exec(source);
  assert.ok(fallbackClocks);
  const fallbackContext = {
    source500:{rows:150},source500Details:{},external:{updatedAt:'2026-11-23T01:52:30Z'},
    maxAgeMinutes:20,sourceFreshness: clock => clock ?? null
  };
  for (const expression of fallbackClocks.slice(1)) assert.equal(vm.runInNewContext(expression,fallbackContext),null);
  const start = source.indexOf('const buildPublicV1Health = async');
  const end = source.indexOf('const getPublicV1Health = async', start);
  assert(start >= 0 && end > start);
  const now = Date.parse('2026-11-23T01:52:30Z');
  const when = secondsAgo => new Date(now - secondsAgo * 1000).toISOString();
  const health = {
    meta: { updatedAt: when(1), api:{transport:'direct',currentFreshnessTime:when(0),currentStale:false},
      fastResultPublication:{publishedAt:when(0)}, files:{current:63} }, sources: { ok: true, sourceScores: {
      sporttery: { updatedAt: when(1), stale: false }, 'five-hundred': { updatedAt: when(1), stale: false }
    }, fallbackCoverage: { usable: true, primaryStale: true, updatedAt: when(1) } },
    currentRead: { count: 63, stale: false, fileUpdatedAt:when(0), checkedAt: when(0), dbUpdatedAt: when(0) },
    storage: { fastResultIntegrity: { valid: true } }, fastResultWatcher: {}
  };
  const build = vm.runInNewContext(source.slice(start, end) + '\n buildPublicV1Health', {
    getPublicV1HealthBase: async () => ({ health }), buildCurrentRecommendationCoverage: async () => ({ projectionParity: {} }),
    currentMetaTime: meta => Date.parse(meta.updatedAt), currentPublicationAgeSeconds: require('../server/publicationRefreshPolicy.cjs').currentPublicationAgeSeconds,
    boundedRuntimeEnv: (_env, _name, config) => config.fallback, Date: class extends Date { static now() { return now; } },
    timestampMs: value => Date.parse(value || '') || 0, buildModelEvaluationHealth: () => ({}),
    installedSignedTrainingAsset: null, publicSourceHealth: x => x, process: { env: {} },
    require: name => { assert.equal(name, '../scripts/predictionExecutionCapture.cjs'); return { predictionCaptureStorageHealth: () => ({}) }; }
  });
  for (const timestamp of [when(1_987_588), undefined, 'invalid', when(-1)]) {
    health.meta.api.sourceUpdatedAt = timestamp;
    const result = await build();
    assert.equal(result.status.primarySourceFresh, true);
    assert.equal(result.status.currentPublicationFresh, false);
    assert.equal(result.status.fallbackDataFresh, false);
    assert.equal(result.status.dataFresh, false);
  }
  health.meta.api.sourceUpdatedAt = when(3600);
  let result = await build();
  assert.equal(result.status.sourceDataFresh, false);
  assert.equal(result.status.fallbackDataFresh, true);
  health.sources.fallbackCoverage = null;
  assert.equal((await build()).status.dataFresh, false);
  health.sources.fallbackCoverage = {usable:true, primaryStale:true};
  assert.equal((await build()).status.dataFresh, false);
  health.sources.fallbackCoverage.updatedAt = when(-1);
  assert.equal((await build()).status.dataFresh, false);
  health.meta.api.sourceUpdatedAt = when(600);
  result = await build();
  assert.equal(result.status.sourceDataFresh, true);
  assert.equal(result.data.currentAgeSeconds, 600);
  health.currentRead.count = 0;
  assert.equal((await build()).status.dataFresh, false);
  health.meta.files.current = 0;
  assert.equal((await build()).status.dataFresh, true);
  health.currentRead.stale = true;
  assert.equal((await build()).status.dataFresh, false);
  health.currentRead = {count:63,stale:false,fileUpdatedAt:when(0)};
  health.meta.files.current = 63;
  health.meta.api.sourceUpdatedAt = when(0);
  health.meta.sourceAttempt = {transport:'relay',relayCurrentLaneCapturedAt:when(90000),relayResultLaneCapturedAt:when(0)};
  assert.equal((await build()).status.dataFresh, false);
  delete health.meta.sourceAttempt.relayCurrentLaneCapturedAt;
  assert.equal((await build()).status.dataFresh, false);
  health.meta.sourceAttempt.relayCurrentLaneCapturedAt = when(600);
  assert.equal((await build()).status.sourceDataFresh, true);
  health.meta.api.currentStale = true;
  assert.equal((await build()).status.dataFresh, false);
});
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
 const evaluate=(dataSync,currentUser={id:'qa'})=>vm.runInNewContext(logic+'; dataStatus',{dataSync,currentUser,isAccessVerified:Boolean(currentUser)});
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
    if(name==='./dataGenerationBundle.cjs')return {sqlitePublicationMatches:(a,b)=>a.generationId===b.generationId&&a.manifestHash===b.manifestHash,resolveCommittedPostgresPublication:()=>{validations++;return {identity:current,context:{generationId:current.generationId}};},acquireGenerationReadLease:()=>{leases++;return {path:'temporary-test-lease'};}};
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
