'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const p=require('./releaseWorkerCodeRepair.cjs'), worker=require('./releaseWorkerPreflight.cjs');
function verifyReleaseWorkerCodeRepair() {
  let checks=0; const check=fn=>{fn();checks++;}, hex=n=>String(n).repeat(64);
  const service={ActiveState:'active',MainPID:'42',ExecMainStartTimestamp:'Sun 2026-10-11 09:00:00 UTC'};
  const auth={version:'worker-code-repair-v1',reason:'reference-array-string-limit',createdAt:'2026-10-11T10:00:00Z',expiresAt:'2026-10-11T12:00:00Z',
    baseRuntimeSha256:hex(1),files:p.TARGETS.map(name=>({path:name,beforeSha256:hex(2),afterSha256:hex(3)})),
    dataContract:[...p.DATA_FILES,'server/postgres/migrations/001_core.sql'].sort().map(name=>({path:name,sha256:hex(4)}))};
  const observation={checkedAt:'2026-10-11T10:20:00Z',serviceBefore:service,serviceAfter:service,processMatches:true,
    status:{pid:42,checkedAt:'2026-10-11T10:19:00Z',ok:true,phase:'official-result',lastCycle:{ok:false,phase:'official-result-failed',
      startedAt:'2026-10-11T10:10:00Z',finishedAt:'2026-10-11T10:15:00Z',errorCode:'SYNC_WORKER_COMMAND_FAILED',error:'node scripts/syncData.cjs exited with 1'}}};
  const extra={runtimeSha256:hex(1),completeSha256:hex(1),recoveryPending:false,
    files:auth.files.map(row=>({path:row.path,sha256:row.beforeSha256})),dataContract:auth.dataContract,migrationNames:['001_core.sql'],
    journal:[{unit:'football-sync-worker.service',pid:'43',message:'Invalid string length',timestampMs:Date.parse('2026-10-11T10:14:59Z')}]};
  const run=(a=auth,w=observation,e=extra)=>p.evaluateWorkerCodeRepair(a,w,e);
  check(()=>{const r=run();assert.equal(r.ok,true);assert.equal(r.repairPreparationAllowed,true);assert.equal(r.workerHealthy,false);
    assert.equal(r.workerReport.ok,false);assert.deepEqual(r.workerReport.blockers,['worker-official-recovery-unproven']);assert.equal(r.readyToCutover,false);assert.equal(r.productionWrites,0);});
  check(()=>assert.equal(run(auth,{...observation,status:{...observation.status,ok:false,phase:'failed'}}).ok,true));
  for(const patch of [{version:'other'},{reason:'ignore-worker'}, {baseRuntimeSha256:'bad'}, {createdAt:'2026-10-11T11:00:00Z'},
    {expiresAt:'2026-10-11T10:19:00Z'}, {expiresAt:'2026-10-12T10:00:00Z'}, {bypass:true},
    {files:auth.files.slice(0,1)}, {files:[...auth.files].reverse()}, {dataContract:auth.dataContract.slice(1)}])
    check(()=>assert.equal(run({...auth,...patch}).ok,false));
  for(const patch of [{runtimeSha256:hex(5)}, {completeSha256:hex(5)}, {recoveryPending:true}, {files:[]}, {dataContract:[]},
    {migrationNames:['001_core.sql','002_unknown.sql']}, {journal:[]},
    {journal:[{...extra.journal[0],message:'fetch failed'}]}, {journal:[{...extra.journal[0],unit:'other.service'}]},
    {journal:[{...extra.journal[0],timestampMs:Date.parse('2026-10-11T10:09:00Z')}]},
    {journal:[{...extra.journal[0],timestampMs:Date.parse('2026-10-11T10:16:00Z')}]}])
    check(()=>assert.equal(run(auth,observation,{...extra,...patch}).ok,false));
  for(const patch of [{processMatches:false}, {serviceAfter:{...service,MainPID:'44'}},
    {status:{...observation.status,pid:44}}, {status:{...observation.status,checkedAt:'2026-10-11T10:00:00Z'}},
    {status:{...observation.status,lastCycle:{...observation.status.lastCycle,error:'another command'}}},
    {status:{...observation.status,lastCycle:{...observation.status.lastCycle,phase:'slow-enrichment-failed'}}},
    {status:{...observation.status,lastCycle:{...observation.status.lastCycle,finishedAt:'2026-10-11T11:00:00Z'}}}])
    check(()=>assert.equal(run(auth,{...observation,...patch}).ok,false));
  check(()=>assert.equal(worker.evaluateWorkerPreflight(observation).ok,false));
  // Execute the serialized probe with the same pure policy and bounded fake
  // observation; this cannot restart units or write a production file.
  check(()=>{
    const source=p.buildWorkerCodeRepairProbe({...auth,createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()});
    new vm.Script(source);assert(!source.includes('systemctl\",[\"start'));assert(source.includes('repairPreparationAllowed'));
    const original=p.buildWorkerCodeRepairProbe.toString();assert(original.includes('base.ok?base:'));
  });
  check(()=>{
    const root=path.resolve(__dirname,'..'),native=fs.readFileSync(path.join(root,'deploy/light-server/release-native.sh'),'utf8');
    const client=fs.readFileSync(path.join(root,'scripts/deployReleaseBundle.cjs'),'utf8');
    assert(native.indexOf('scripts/releaseWorkerCodeRepair.cjs')<native.indexOf('native_data allocate'));
    assert(client.indexOf('signed worker code repair authorization rejected')<client.indexOf('const remotePreflight = runCommand'));
    assert(client.indexOf('const remotePreflight = runCommand')<client.indexOf('for (const artifact of (activateOnly ? [] : uploads))'));
    assert(client.includes('shellQuote(buildReadOnlyWorkerProbe())'));assert(client.includes('validateEmergencyCodeAuthorization'));
    assert(native.includes('native_code_verify_cutover_lease'));assert(native.includes('native_data final'));
  });
  return {ok:true,checks,synthetic:true,productionWrites:0,workerHealthPromoted:false};
}
module.exports={verifyReleaseWorkerCodeRepair};
if(require.main===module)console.log(JSON.stringify(verifyReleaseWorkerCodeRepair()));
