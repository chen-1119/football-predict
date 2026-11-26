'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const policy=require('../scripts/releaseWorkerCodeRepair.cjs');
const evidence=require('../scripts/syncMetaIncidentEvidence.cjs');
const hex=n=>String(n).repeat(64);
function fixture() {
  const now=Date.now(), iso=ago=>new Date(now-ago).toISOString();
  const service={ActiveState:'active',MainPID:'42',ExecMainStartTimestamp:iso(7200000)};
  const cycle={ok:false,phase:'official-result-failed',startedAt:iso(120000),finishedAt:iso(2000),
    errorCode:'SYNC_WORKER_COMMAND_FAILED',error:'npm run validate:data exited with 1'};
  const worker={checkedAt:iso(0),serviceBefore:{...service},serviceAfter:{...service},processMatches:true,
    status:{pid:42,checkedAt:iso(1000),ok:true,phase:'official-result',lastCycle:cycle,eventCycle:cycle}};
  const journal=[{unit:'football-sync-worker.service',pid:'43',message:evidence.MESSAGE,
    timestampUs:String((now-2050)*1000),timestampMs:now-2050}];
  const meta={path:'/opt/football-predict/public/data/sync-meta.json',bytes:1093306,sha256:hex('a'),stableIdentity:true};
  const identity=(n,ago)=>({mode:'active-generation',generationId:'g-'+hex(n),manifestHash:hex(n),sourceCycleId:'cycle-'+n,committedAt:iso(ago)});
  const auth={version:'worker-code-repair-v9',reason:'sync-meta-strategy-summary-size',
    bindingPolicy:'fresh-sync-meta-size-incident-before-lease-v1',createdAt:iso(600000),expiresAt:iso(-3600000),
    baseRuntimeSha256:hex('b'),incident:evidence.incidentAnchor({worker,journal,meta}),
    files:policy.SYNC_META_TARGETS.map(path=>({path,beforeSha256:hex('c'),afterSha256:hex('d')})),
    addedSources:policy.SYNC_META_ADDED.map(path=>({path,sha256:hex('e')})),
    unchangedSources:policy.SYNC_META_UNCHANGED.map(path=>({path,sha256:hex('f')})),
    dataContract:[...policy.DATA_FILES,'server/postgres/migrations/001_core.sql'].sort().map(path=>({path,sha256:hex(1)})),
    publication:{databaseOid:'42',committed:identity(2,3600000),rawPrevious:identity(3,1800000),rawCurrent:identity(4,900000)}};
  const observed={runtimeSha256:auth.baseRuntimeSha256,completeSha256:auth.baseRuntimeSha256,recoveryPending:false,
    files:auth.files.map(row=>({path:row.path,sha256:row.beforeSha256})),dataContract:structuredClone(auth.dataContract),
    migrationNames:['001_core.sql'],publication:structuredClone(auth.publication),journal,meta,
    unchangedSources:structuredClone(auth.unchangedSources),addedSourcesAbsent:[...policy.SYNC_META_ADDED]};
  return {auth,worker,observed};
}
const evaluate=f=>policy.evaluateWorkerCodeRepair(f.auth,f.worker,f.observed);
test('incident preparation retains failed worker and cannot grant cutover',()=>{
  const result=evaluate(fixture());assert.equal(result.ok,true);assert.equal(result.repairPreparationAllowed,true);
  assert.equal(result.workerHealthy,false);assert.equal(result.workerReport.ok,false);assert.equal(result.readyToCutover,false);assert.equal(result.productionWrites,0);
});
for(const [name,change] of [
  ['changed release',f=>f.observed.completeSha256=hex(9)],
  ['pending recovery',f=>f.observed.recoveryPending=true],
  ['changed PG commit',f=>f.observed.publication.committed.sourceCycleId='different'],
  ['different PG database',f=>f.observed.publication.databaseOid='43'],
  ['backward raw clock',f=>f.observed.publication.rawCurrent.committedAt=f.auth.publication.rawPrevious.committedAt],
  ['different fault',f=>f.observed.journal[0].message='timeout'],
  ['changed current meta',f=>f.observed.meta.sha256=hex(9)],
  ['meta under original bound',f=>f.observed.meta.bytes=1000000],
  ['changed validator',f=>f.observed.unchangedSources[0].sha256=hex(9)],
  ['new file already installed',f=>f.observed.addedSourcesAbsent.pop()],
  ['missing new source pin',f=>f.auth.addedSources.pop()],
  ['missing unchanged source pin',f=>f.auth.unchangedSources.pop()],
  ['changed original runtime source',f=>f.observed.files[0].sha256=hex(9)],
  ['wrong worker process',f=>f.worker.processMatches=false],
  ['wrong failed command',f=>f.worker.status.lastCycle.error='node scripts/syncData.cjs exited with 1'],
  ['expired scope',f=>f.auth.expiresAt=new Date(Date.parse(f.worker.checkedAt)-1).toISOString()],
  ['extra scope capability',f=>f.auth.force=true],
  ['old version scope reused',f=>f.auth.version='worker-code-repair-v8'],
  ['unknown data contract',f=>f.auth.dataContract.push({path:'scripts/validateData.cjs',sha256:hex(1)})],
]) test(`rejects ${name}`,()=>{const f=fixture();change(f);assert.equal(evaluate(f).ok,false);});
test('healthy worker uses the original path without incident reader',()=>{
  const f=fixture();f.worker.status.lastCycle.ok=true;
  const selected=policy.selectWorkerCodeRepairPreparation(f.auth,f.worker,()=>{throw Error('stale incident read');});
  assert.equal(selected.useRepair,false);assert.equal(selected.report.ok,true);
});
test('serialized probe includes all new evidence dependencies and fails closed for malformed observations',()=>{
  const f=fixture(),out=[];
  const source=policy.buildWorkerCodeRepairProbe(f.auth).replace('try {const auth=',
    'collectWorkerPreflight=()=>JSON.parse(fixtureWorker);collectWorkerCodeRepair=()=>JSON.parse(fixtureObserved);try {const auth=');
  const context={require,process:{},console:{log:x=>out.push(JSON.parse(x))},Date,
    fixtureWorker:JSON.stringify(f.worker),fixtureObserved:JSON.stringify(f.observed)};
  new vm.Script(source).runInNewContext(context);assert.equal(out[0].repairPreparationAllowed,true);
  out.length=0;f.observed.meta.stableIdentity=false;context.fixtureObserved=JSON.stringify(f.observed);
  new vm.Script(source).runInNewContext({...context});assert.equal(out[0].ok,false);
});
