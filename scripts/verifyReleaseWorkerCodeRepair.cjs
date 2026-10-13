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
  const now=Date.now(), identity=(n,ago)=>({mode:'active-generation',generationId:'g-'+hex(n),manifestHash:hex(n),
    sourceCycleId:'cycle-'+n,committedAt:new Date(now-ago).toISOString()});
  const pairAuth={...auth,version:'worker-code-repair-v2',reason:'postgres-committed-generation-pairing',
    createdAt:new Date(now-600000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),
    files:p.PAIR_TARGETS.map(name=>({path:name,beforeSha256:hex(2),afterSha256:hex(3)})),
    publication:{databaseOid:'42',committed:identity(1,3600000),rawPrevious:identity(2,1800000),rawCurrent:identity(3,900000)}};
  const pairWorker={...observation,checkedAt:new Date(now).toISOString(),serviceBefore:{...service,ExecMainStartTimestamp:new Date(now-7200000).toUTCString()},
    serviceAfter:{...service,ExecMainStartTimestamp:new Date(now-7200000).toUTCString()},
    status:{...observation.status,checkedAt:new Date(now-1000).toISOString(),lastCycle:{...observation.status.lastCycle,
      startedAt:new Date(now-60000).toISOString(),finishedAt:new Date(now-2000).toISOString()}}};
  const pairExtra={...extra,files:pairAuth.files.map(r=>({path:r.path,sha256:r.beforeSha256})),publication:pairAuth.publication,
    journal:[{unit:'football-sync-worker.service',pid:'43',timestampMs:now-2050,
      message:'SQLite publication identity matches neither the serving generation nor its immutable previous generation'}]};
  check(()=>{const r=run(pairAuth,pairWorker,pairExtra);assert.equal(r.ok,true);assert.equal(r.workerHealthy,false);assert.equal(r.readyToCutover,false);});
  const writerAuth={...pairAuth,version:'worker-code-repair-v3',reason:'postgres-source-file-assembly-timeout',
    files:p.WRITER_TARGETS.map(name=>({path:name,beforeSha256:hex(2),afterSha256:hex(3)}))};
  const writerWorker={...pairWorker,status:{...pairWorker.status,lastCycle:{...pairWorker.status.lastCycle,error:'npm run postgres:sync exited with 1'}}};
  const writerExtra={...pairExtra,files:writerAuth.files.map(r=>({path:r.path,sha256:r.beforeSha256})),journal:[{...pairExtra.journal[0],message:'  "error": "Query read timeout",'}]};
  check(()=>{const r=run(writerAuth,writerWorker,writerExtra);assert.equal(r.ok,true);assert.equal(r.workerHealthy,false);assert.equal(r.readyToCutover,false);assert.equal(r.productionWrites,0);});
  check(()=>{const recovered={...writerWorker,status:{...writerWorker.status,lastCycle:{...writerWorker.status.lastCycle,ok:true}}};
    const selection=p.selectWorkerCodeRepairPreparation(writerAuth,recovered,()=>{throw Error('inactive incident must not be read');});
    assert.equal(selection.useRepair,false);assert.equal(selection.report.ok,true);assert.equal(selection.report.readyToCutover,false);});
  check(()=>{const selection=p.selectWorkerCodeRepairPreparation(writerAuth,writerWorker,()=>writerExtra);assert.equal(selection.useRepair,true);assert.equal(selection.report.workerHealthy,false);});
  check(()=>{const selection=p.selectWorkerCodeRepairPreparation(writerAuth,writerWorker,()=>({...writerExtra,journal:[]}));assert.equal(selection.useRepair,false);assert.equal(selection.report.ok,false);});
  check(()=>{const selection=p.selectWorkerCodeRepairPreparation(writerAuth,{...writerWorker,processMatches:false},()=>writerExtra);assert.equal(selection.useRepair,false);assert.equal(selection.report.ok,false);});
  for(const key of ['rawCurrent','rawPrevious'])check(()=>{const x=JSON.parse(JSON.stringify(writerAuth));x.publication.committed={...x.publication[key]};const e={...writerExtra,publication:x.publication};assert.equal(run(x,writerWorker,e).ok,true);x.publication.committed.sourceCycleId='different';assert.equal(run(x,writerWorker,e).ok,false);});
  for(const change of [e=>e.journal[0].message='fetch failed',e=>e.journal[0].timestampMs=now-120000,e=>e.files[0].sha256=hex(8),e=>e.publication={...e.publication,databaseOid:'other'},e=>e.recoveryPending=true])
    check(()=>{const e=JSON.parse(JSON.stringify(writerExtra));change(e);assert.equal(run(writerAuth,writerWorker,e).ok,false);});
  check(()=>assert.equal(run(writerAuth,pairWorker,writerExtra).ok,false));
  check(()=>{new vm.Script(p.buildWorkerCodeRepairProbe(writerAuth));assert(p.buildWorkerCodeRepairProbe(writerAuth).includes('WRITER_TARGETS='));});
  const snapshotAuth={...writerAuth,version:'worker-code-repair-v4',reason:'model-artifact-generation-snapshot-race',files:p.SNAPSHOT_TARGETS.map(name=>({path:name,beforeSha256:hex(2),afterSha256:hex(3)}))};
  const snapshotWorker={...writerWorker,status:{...writerWorker.status,lastCycle:{...writerWorker.status.lastCycle,error:'npm run datastore:generation exited with 1'}}};
  const snapshotExtra={...writerExtra,files:snapshotAuth.files.map(r=>({path:r.path,sha256:r.beforeSha256})),journal:[{...writerExtra.journal[0],message:'  "error": "source file size changed before staging: model-evaluation.json",'}]};
  check(()=>assert.equal(run(snapshotAuth,snapshotWorker,snapshotExtra).ok,true));
  for(const key of ['rawCurrent','rawPrevious'])check(()=>{const x=JSON.parse(JSON.stringify(snapshotAuth));x.publication.committed={...x.publication[key]};const e={...snapshotExtra,publication:x.publication};assert.equal(run(x,snapshotWorker,e).ok,true);x.publication.committed.manifestHash=hex(8);assert.equal(run(x,snapshotWorker,e).ok,false);});
  check(()=>assert.equal(run(snapshotAuth,writerWorker,snapshotExtra).ok,false));
  check(()=>assert.equal(run(snapshotAuth,snapshotWorker,{...snapshotExtra,journal:writerExtra.journal}).ok,false));
  check(()=>assert.equal(run({...snapshotAuth,files:snapshotAuth.files.slice(1)},snapshotWorker,snapshotExtra).ok,false));
  const faultIdentity={sourceMatchId:'2041926',eventVersion:new Date(now-86400000).toISOString(),
    resultIdentity:'4:2|sporttery:official-api',observedAt:new Date(now-7200000).toISOString(),settledAt:new Date(now-7200000).toISOString()};
  const fault={ok:false,code:'POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE',
    error:'Existing stable review id is not a safe result-only canonical rebase',reviewId:'review:'+hex(5),
    existingMatchId:'sporttery_2041926',incomingMatchId:'fivehundred_2041926',
    existingObservationId:'result:'+hex(6),incomingObservationId:'result:'+hex(7),
    existingIdentity:faultIdentity,incomingIdentity:{...faultIdentity}};
  const incident={workerMainPid:'42',workerStartedAt:new Date(writerWorker.serviceAfter.ExecMainStartTimestamp).toISOString(),
    cycleStartedAt:writerWorker.status.lastCycle.startedAt,cycleFinishedAt:writerWorker.status.lastCycle.finishedAt,
    journalPid:'43',journalTimestampUs:String((now-2050)*1000),
    journalMessageSha256:require('node:crypto').createHash('sha256').update(JSON.stringify(fault,null,2)).digest('hex'),failure:fault};
  const resultAuth={...writerAuth,version:'worker-code-repair-v5',reason:'official-result-canonical-identity-regression',incident,
    files:p.RESULT_IDENTITY_TARGETS.map(name=>({path:name,beforeSha256:hex(2),afterSha256:hex(name==='scripts/postgresProjectionSync.cjs'?2:3)}))};
  const resultJournal=(i=incident)=>JSON.stringify(i.failure,null,2).split('\n').map(message=>({unit:'football-sync-worker.service',
    pid:i.journalPid,timestampUs:i.journalTimestampUs,timestampMs:Number(i.journalTimestampUs)/1000,message}));
  const resultExtra={...writerExtra,files:resultAuth.files.map(r=>({path:r.path,sha256:r.beforeSha256})),journal:resultJournal()};
  check(()=>{const r=run(resultAuth,writerWorker,resultExtra);assert.equal(r.ok,true);assert.equal(r.workerHealthy,false);
    assert.deepEqual(r.workerReport.blockers,['worker-official-recovery-unproven']);assert.equal(r.readyToCutover,false);assert.equal(r.productionWrites,0);});
  check(()=>assert.equal(run(resultAuth,{...writerWorker,status:{...writerWorker.status,ok:false,phase:'failed'}},resultExtra).ok,true));
  for(const key of ['rawCurrent','rawPrevious'])check(()=>{const a=structuredClone(resultAuth);a.publication.committed={...a.publication[key]};
    assert.equal(run(a,writerWorker,{...resultExtra,publication:a.publication}).ok,true);});
  for(const mutate of [a=>a.files.shift(),a=>a.files.reverse(),a=>a.files[0].afterSha256=a.files[0].beforeSha256,
    a=>a.files[3].afterSha256=hex(3),a=>a.reason='postgres-source-file-assembly-timeout',a=>delete a.incident,
    a=>a.incident.workerMainPid='99',a=>a.incident.workerStartedAt=new Date(now-14400000).toISOString(),
    a=>a.incident.cycleStartedAt=new Date(now-61000).toISOString(),a=>a.incident.cycleFinishedAt=new Date(now-2500).toISOString(),
    a=>a.incident.journalPid='99',a=>a.incident.journalTimestampUs=String((now-2100)*1000),a=>a.incident.journalMessageSha256=hex(9),
    a=>a.incident.failure.code='SOME_OTHER_FAILURE',a=>a.incident.failure.reviewId='review:'+hex(8),
    a=>a.incident.failure.existingMatchId='fivehundred_2041926',a=>a.incident.failure.incomingMatchId='sporttery_2041926',
    a=>a.incident.failure.incomingIdentity.sourceMatchId='2041927',a=>a.incident.failure.incomingIdentity.eventVersion=new Date(now-85000000).toISOString(),
    a=>a.incident.failure.incomingIdentity.resultIdentity='2:4|sporttery:official-api',a=>a.incident.failure.incomingIdentity.observedAt=new Date(now-7000000).toISOString(),
    a=>a.incident.failure.incomingIdentity.settledAt=new Date(now-7000000).toISOString(),
    a=>a.incident.failure.incomingObservationId=a.incident.failure.existingObservationId,
    a=>a.incident.failure.bypass=true,a=>a.incident.extra=true])check(()=>{
      const a=structuredClone(resultAuth);mutate(a);assert.equal(run(a,writerWorker,resultExtra).ok,false);
    });
  for(const mutate of [e=>e.journal.pop(),e=>e.journal.push(e.journal[0]),e=>e.journal[5].pid='99',e=>e.journal[5].unit='other.service',
    e=>e.journal[5].timestampUs=String((now-2100)*1000),e=>e.journal[5].timestampMs++,e=>e.journal[5].message='  "existingMatchId": "sporttery_2041927",',
    e=>e.journal[4].message=e.journal[3].message,e=>e.journal.reverse(),e=>e.publication={...e.publication,databaseOid:'43'},
    e=>e.files[3].sha256=hex(8),e=>e.completeSha256=hex(8),e=>e.recoveryPending=true])check(()=>{
      const e=structuredClone(resultExtra);mutate(e);assert.equal(run(resultAuth,writerWorker,e).ok,false);
    });
  check(()=>assert.equal(run(resultAuth,{...writerWorker,processMatches:false},resultExtra).ok,false));
  check(()=>assert.equal(run(resultAuth,{...writerWorker,checkedAt:new Date(now+3600001).toISOString(),
    status:{...writerWorker.status,checkedAt:new Date(now+3600000).toISOString()}},resultExtra).ok,false));
  check(()=>{const recovered={...writerWorker,status:{...writerWorker.status,lastCycle:{...writerWorker.status.lastCycle,ok:true}}};
    const selected=p.selectWorkerCodeRepairPreparation(resultAuth,recovered,()=>{throw Error('do not read stale result incident');});
    assert.equal(selected.useRepair,false);assert.equal(selected.report.ok,true);});
  const freshAuth={...resultAuth,version:'worker-code-repair-v6',bindingPolicy:'fresh-raw-and-repeated-exact-failure-before-lease-v1',
    incident:{...incident,cycleStartedAt:new Date(now-180000).toISOString(),cycleFinishedAt:new Date(now-120000).toISOString(),
      journalTimestampUs:String((now-120050)*1000)}};
  const freshPublication={...resultAuth.publication,rawPrevious:identity(4,600000),rawCurrent:identity(5,300000)};
  const freshExtra={...resultExtra,publication:freshPublication};
  check(()=>{const r=run(freshAuth,writerWorker,freshExtra);assert.equal(r.ok,true);assert.equal(r.workerHealthy,false);
    assert.equal(r.workerReport.ok,false);assert.equal(r.readyToCutover,false);assert.equal(r.productionWrites,0);});
  check(()=>assert.equal(run(resultAuth,writerWorker,freshExtra).ok,false));
  check(()=>assert.equal(run({...freshAuth,version:'worker-code-repair-v5'},writerWorker,freshExtra).ok,false));
  check(()=>assert.equal(run({...freshAuth,bindingPolicy:'allow-any-failure'},writerWorker,freshExtra).ok,false));
  check(()=>{const a=structuredClone(freshAuth);delete a.bindingPolicy;assert.equal(run(a,writerWorker,freshExtra).ok,false);});
  check(()=>{const recovered={...writerWorker,status:{...writerWorker.status,lastCycle:{...writerWorker.status.lastCycle,ok:true}}};
    const selected=p.selectWorkerCodeRepairPreparation(freshAuth,recovered,()=>{throw Error('v6 healthy route must not load incident');});
    assert.equal(selected.useRepair,false);assert.equal(selected.report.ok,true);});
  for(const mutate of [e=>e.publication.committed={...e.publication.rawCurrent},e=>e.publication.databaseOid='43',
    e=>e.publication.rawCurrent.committedAt=new Date(now-1000000).toISOString(),
    e=>e.publication.rawPrevious.committedAt=freshAuth.publication.rawPrevious.committedAt,
    e=>e.journal[0].pid='99',e=>e.journal[0].timestampUs=String((now-119000)*1000),e=>e.journal.pop(),
    e=>e.journal[6].message='  "incomingMatchId": "fivehundred_2041927",',e=>e.journal[8].message='  "incomingObservationId": "result:'+hex(8)+'",',
    e=>e.files[0].sha256=hex(8),e=>e.files[3].sha256=hex(8),e=>e.dataContract=[],e=>e.migrationNames=[],e=>e.recoveryPending=true])check(()=>{
    const e=structuredClone(freshExtra);mutate(e);assert.equal(run(freshAuth,writerWorker,e).ok,false);
  });
  for(const mutate of [w=>w.serviceAfter.MainPID='99',w=>w.serviceAfter.ExecMainStartTimestamp=new Date(now-7200001).toISOString(),
    w=>w.status.lastCycle.startedAt=new Date(now-121000).toISOString(),w=>w.status.lastCycle.finishedAt=new Date(now+1).toISOString(),
    w=>w.status.lastCycle.phase='other-failed',w=>w.status.checkedAt=new Date(now-601000).toISOString(),w=>w.processMatches=false])check(()=>{
    const w=structuredClone(writerWorker);mutate(w);assert.equal(run(freshAuth,w,freshExtra).ok,false);
  });
  check(()=>assert.equal(run({...freshAuth,expiresAt:new Date(now-1).toISOString()},writerWorker,freshExtra).ok,false));
  for(const patch of [{publication:{...pairAuth.publication,databaseOid:'bad'}},
    {publication:{...pairAuth.publication,committed:pairAuth.publication.rawCurrent}},
    {publication:{...pairAuth.publication,rawPrevious:pairAuth.publication.rawCurrent}},
    {publication:{...pairAuth.publication,rawCurrent:{...pairAuth.publication.rawCurrent,manifestHash:hex(6)}}},
    {publication:{...pairAuth.publication,rawPrevious:{...pairAuth.publication.rawPrevious,committedAt:'not-a-clock'}}},
    {files:pairAuth.files.slice(1)}, {reason:'ignore-database-divergence'}, {expiresAt:new Date(now-1).toISOString()}, {bypass:true}])
    check(()=>assert.equal(run({...pairAuth,...patch},pairWorker,pairExtra).ok,false));
  for(const patch of [{publication:{...pairAuth.publication,databaseOid:'43'}}, {journal:extra.journal}])
    check(()=>assert.equal(run(pairAuth,pairWorker,{...pairExtra,...patch}).ok,false));
  const code=require('./nativeCodeReleaseDataPlane.cjs');
  const state={dataPlane:'code-only',oldSha:pairAuth.baseRuntimeSha256,oldDatabaseOid:'42',committedGenerationRepairAuthorizationHash:hex(9)};
  const session={identity:pairAuth.publication.committed,publication:{context:{pointer:pairAuth.publication.committed},pairing:{reason:'exact-committed-postgres-generation'}}};
  const admit=(s=state,se=session,c=pairAuth.publication.rawCurrent,pr=pairAuth.publication.rawPrevious,h=hex(9))=>
    code.assertRepairPair(s,se,{pointer:c},{pointer:pr},pairAuth,h);
  check(()=>{const r=admit();assert.equal(r.productionWrites,0);assert.equal(r.reason,'exact-signed-incident-pair');});
  check(()=>assert.equal(code.assertRepairPair(state,session,{pointer:resultAuth.publication.rawCurrent},
    {pointer:resultAuth.publication.rawPrevious},resultAuth,hex(9)).productionWrites,0));
  for(const s of [{...state,dataPlane:'database'},{...state,oldSha:hex(7)},{...state,oldDatabaseOid:'43'},
    {...state,committedGenerationRepairAuthorizationHash:hex(7)}]) check(()=>assert.throws(()=>admit(s)));
  check(()=>assert.throws(()=>admit(state,{...session,identity:pairAuth.publication.rawPrevious})));
  check(()=>assert.throws(()=>admit(state,{...session,publication:{...session.publication,pairing:{reason:'previous'}}})));
  check(()=>assert.throws(()=>admit(state,session,pairAuth.publication.rawPrevious)));
  check(()=>assert.throws(()=>admit(state,session,pairAuth.publication.rawCurrent,pairAuth.publication.committed)));
  check(()=>assert.throws(()=>admit(state,session,pairAuth.publication.rawCurrent,pairAuth.publication.rawPrevious,hex(6))));
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
    const original=p.buildWorkerCodeRepairProbe.toString();assert(original.includes('selectWorkerCodeRepairPreparation'));
  });
  // Exercise the actual serialized collector/evaluator in the same VM context
  // as the native entry. fs.readdirSync returns a host-realm Array here.
  for(const variant of ['exact','extra-migration','no-journal','writer-exact','writer-aligned','writer-recovered','snapshot-exact','snapshot-aligned',
    'result-exact','result-aligned','result-recovered','result-missing','result-mixed-pid','result-mixed-clock','result-truncated','result-different-record',
    'fresh-exact','fresh-repeated','fresh-recovered','fresh-locator-empty','fresh-locator-multiple','fresh-locator-outside',
    'fresh-missing','fresh-mixed-pid','fresh-mixed-clock','fresh-truncated','fresh-different-record','fresh-commit-changed']) check(()=>{
    const crypto=require('node:crypto'), now=Date.now(), hexHash=b=>crypto.createHash('sha256').update(b).digest('hex');
    const start=new Date(now-60000).toISOString(),end=new Date(now-2000).toISOString();
    const isFresh=variant.startsWith('fresh'),isResult=variant.startsWith('result')||isFresh;
    const localAuth=JSON.parse(JSON.stringify(isFresh?freshAuth:isResult?resultAuth:variant.startsWith('writer')?writerAuth:variant.startsWith('snapshot')?snapshotAuth:auth));
    if(variant.endsWith('aligned'))localAuth.publication.committed={...localAuth.publication.rawCurrent};
    localAuth.createdAt=new Date(now-600000).toISOString();localAuth.expiresAt=new Date(now+3600000).toISOString();
    const files=new Map();for(const row of localAuth.files){const b=Buffer.from('old:'+row.path);files.set('/opt/football-predict/'+row.path,b);row.beforeSha256=hexHash(b);
      if(isResult&&row.path==='scripts/postgresProjectionSync.cjs')row.afterSha256=row.beforeSha256;}
    for(const row of localAuth.dataContract){const b=Buffer.from('unchanged:'+row.path);files.set('/opt/football-predict/'+row.path,b);row.sha256=hexHash(b);}
    for(const name of ['.release-bundle-sha256','.release-live-complete'])files.set('/opt/football-predict/'+name,Buffer.from(localAuth.baseRuntimeSha256+'\n'));
    const status={pid:42,checkedAt:new Date(now-1000).toISOString(),ok:false,phase:'failed',lastCycle:{ok:false,phase:'official-result-failed',startedAt:start,finishedAt:end,errorCode:'SYNC_WORKER_COMMAND_FAILED',error:variant.startsWith('writer')||isResult?'npm run postgres:sync exited with 1':variant.startsWith('snapshot')?'npm run datastore:generation exited with 1':'node scripts/syncData.cjs exited with 1'}};
    if(isResult)Object.assign(localAuth.incident,{workerStartedAt:new Date(new Date(now-3600000).toUTCString()).toISOString(),
      cycleStartedAt:start,cycleFinishedAt:end,journalTimestampUs:String((now-2050)*1000)});
    const liveIncident=isResult?structuredClone(localAuth.incident):null;
    if(isFresh&&variant!=='fresh-exact')Object.assign(localAuth.incident,{cycleStartedAt:new Date(now-180000).toISOString(),
      cycleFinishedAt:new Date(now-120000).toISOString(),journalTimestampUs:String((now-120050)*1000),journalPid:'44'});
    if(variant.endsWith('recovered')){status.ok=true;status.phase='official-result';status.lastCycle.ok=true;}
    const livePublication=isFresh?structuredClone(freshPublication):localAuth.publication;
    if(livePublication)for(const name of ['current','previous'])files.set('/var/lib/football-predict/data-generations/'+name+'.json',Buffer.from(JSON.stringify({schemaVersion:1,...livePublication[name==='current'?'rawCurrent':'rawPrevious']})));
    files.set('/var/lib/football-predict/sync-worker-status.json',Buffer.from(JSON.stringify(status)));
    files.set('/proc/42/cmdline',Buffer.from('/opt/node/bin/node\0/opt/football-predict/scripts/runSyncWorker.cjs\0'));
    const fixtureFs={realpathSync:file=>file,readlinkSync:()=>'/opt/football-predict',openSync:file=>{assert(files.has(file));return file;},closeSync:()=>{},
      constants:{O_RDONLY:0,O_NOFOLLOW:0},readFileSync:(file,encoding)=>encoding?files.get(file).toString():files.get(file),
      fstatSync:file=>({isFile:()=>true,nlink:1,size:files.get(file).length,ino:1,mtimeMs:1,ctimeMs:1}),
      lstatSync:file=>{if(file.startsWith('/var/lib/football-release/'))throw Object.assign(Error('absent'),{code:'ENOENT'});return {isDirectory:()=>true,isSymbolicLink:()=>false};},
      readdirSync:()=>variant==='extra-migration'?['001_core.sql','002_unknown.sql']:['001_core.sql']};
    const fixtureChild={execFileSync:(cmd,args)=>{
      if(cmd==='systemctl')return 'ActiveState=active\nMainPID=42\nExecMainStartTimestamp='+new Date(now-3600000).toUTCString()+'\n';
      assert(!variant.endsWith('recovered'),'healthy native probe must not collect the old incident');
      if(cmd==='/usr/sbin/runuser'){const c=variant==='fresh-commit-changed'?livePublication.rawCurrent:localAuth.publication.committed;return JSON.stringify({databaseOid:localAuth.publication.databaseOid,readOnly:'on',meta:{data_publication_mode:c.mode,data_generation_id:c.generationId,manifest_hash:c.manifestHash,data_generation_source_cycle_id:c.sourceCycleId,committed_at:c.committedAt}});}
      assert.equal(cmd,'/usr/bin/journalctl');
      if(isResult) {
        assert(args.includes('--lines=64'));
        const rows=resultJournal(liveIncident).map(r=>({_SYSTEMD_UNIT:r.unit,_PID:r.pid,MESSAGE:r.message,__REALTIME_TIMESTAMP:r.timestampUs}));
        if(isFresh&&args.some(a=>a.startsWith('--grep'))) {
          assert(args.includes('--since='+status.lastCycle.startedAt));assert(args.includes('--until='+status.lastCycle.finishedAt));
          const code=rows.find(r=>r.MESSAGE==='  "code": "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE",');
          if(variant==='fresh-locator-empty')return '';
          if(variant==='fresh-locator-outside')code.__REALTIME_TIMESTAMP=String((now-119000)*1000);
          return (variant==='fresh-locator-multiple'?[code,code]:[code]).map(r=>JSON.stringify(r)).join('\n')+'\n';
        }
        assert(!args.some(a=>a.startsWith('--grep')));
        assert(args.includes('--since=@'+Math.floor(Number(liveIncident.journalTimestampUs)/1000000)));
        if(variant.endsWith('missing'))rows.pop();
        if(variant.endsWith('mixed-pid'))rows[5]._PID='99';
        if(variant.endsWith('mixed-clock'))rows[5].__REALTIME_TIMESTAMP=String((now-2100)*1000);
        if(variant.endsWith('truncated'))while(rows.length<64)rows.push(rows[0]);
        if(variant.endsWith('different-record'))rows[4].MESSAGE='  "reviewId": "review:'+hex(9)+'",';
        return rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
      }
      assert(args.includes('--lines=4'));
      return variant==='no-journal'?'':JSON.stringify({_SYSTEMD_UNIT:'football-sync-worker.service',_PID:'43',MESSAGE:variant.startsWith('writer')?'  "error": "Query read timeout",':variant.startsWith('snapshot')?'  "error": "source file size changed before staging: model-evaluation.json",':'Invalid string length',__REALTIME_TIMESTAMP:String((now-2050)*1000)})+'\n';
    }};
    const fixtureRequire=name=>name==='node:fs'?fixtureFs:name==='node:child_process'?fixtureChild:name==='node:path'?path.posix:require(name);
    const output=[],fixtureProcess={exitCode:0};
    new vm.Script(p.buildWorkerCodeRepairProbe(localAuth)).runInNewContext({require:fixtureRequire,process:fixtureProcess,console:{log:line=>output.push(line)},Date});
    assert.equal(output.length,1);const report=JSON.parse(output[0]);
    const accepted=['exact','writer-exact','writer-aligned','writer-recovered','snapshot-exact','snapshot-aligned',
      'result-exact','result-aligned','result-recovered','fresh-exact','fresh-repeated','fresh-recovered'].includes(variant);
    assert.equal(report.ok,accepted,JSON.stringify(report));if(!variant.endsWith('recovered'))assert.equal(report.workerHealthy,false);assert.equal(report.readyToCutover,false);assert.equal(report.productionWrites,0);
    assert.equal(fixtureProcess.exitCode,accepted?0:1);
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
  // Exercise the real client invocation without SSH: long signed probes must
  // remain byte-exact on stdin and never become a Windows process argument.
  const transportClient=fs.readFileSync(path.join(__dirname,'deployReleaseBundle.cjs'),'utf8');
  const transportStart=transportClient.indexOf('const remotePreflight = runCommand');
  const transportEnd=transportClient.indexOf('const remotePreflightOutput =',transportStart);
  assert(transportStart>=0&&transportEnd>transportStart);
  const transportSource=transportClient.slice(transportStart,transportEnd)+'\nresult=remotePreflight;';
  for(const status of [0,27,null])check(()=>{
    const command='set -euo pipefail; '+"printf '%s' '真实签名数据 $() ` quoted "+'x'.repeat(65536)+"'; exit 27";
    let captured;
    const context={sshOptions:['-p','22','-o','StrictHostKeyChecking=yes'],sshTarget:'ubuntu@fixed-host',remotePreflightCommand:command,
      runCommand:(name,args,options)=>{captured={name,args:[...args],options};return{status,error:status===null?'transport unavailable':null};}};
    new vm.Script(transportSource).runInNewContext(context);
    assert.equal(captured.name,'ssh');
    assert.deepEqual(captured.args,['-p','22','-o','StrictHostKeyChecking=yes','ubuntu@fixed-host','/bin/bash -se']);
    assert.equal(captured.options.input,command+'\n');
    assert(Buffer.byteLength(captured.options.input)>65536);
    assert(captured.args.every(arg=>arg.length<100));
    assert.equal(context.result.status,status);
  });
  // Run the real native capture and root-only journal reader/writer in a VM.
  // Raw contexts come from the real all-file verifier over small local files;
  // only service observations and the private Linux journal filesystem are
  // simulated. No production connection or service action exists in this test.
  const generations=require('../server/dataGenerationStore.cjs'),os=require('node:os'),crypto=require('node:crypto');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'football-v6-capture-'));
  try {
    const contexts={};
    for(const [name,ago] of [['committed',3600000],['rawPrevious',600000],['rawCurrent',300000]]) {
      const payload=Buffer.from(JSON.stringify({matches:[],name}));
      const manifest=generations.buildManifest({sourceCycleId:'capture-'+name,
        files:[{relativePath:'matches-current.json',bytes:payload,rows:0}],coreFiles:['matches-current.json']});
      const generationDir=path.join(scratch,manifest.generationId);fs.mkdirSync(generationDir);
      fs.writeFileSync(path.join(generationDir,generations.MANIFEST_FILE),JSON.stringify(manifest),{flag:'wx'});
      fs.writeFileSync(path.join(generationDir,'matches-current.json'),payload,{flag:'wx'});
      contexts[name]={...generations.validateGenerationDirectory({generationDir}),
        pointer:{schemaVersion:1,generationId:manifest.generationId,manifestHash:manifest.manifestHash,
          sourceCycleId:manifest.sourceCycleId,committedAt:new Date(now-ago).toISOString()}};
    }
    const nativeSource=fs.readFileSync(path.join(__dirname,'nativeCodeReleaseDataPlane.cjs'),'utf8');
    const policySource=fs.readFileSync(path.join(__dirname,'releaseWorkerCodeRepair.cjs'),'utf8');
    const driverSource=fs.readFileSync(path.join(__dirname,'nativeReleaseDataPlane.cjs'),'utf8');
    const rootFunctions=driverSource.slice(driverSource.indexOf('function secureDirectory('),driverSource.indexOf('function topology('));
    const runCaptureFixture=(variant='repair')=>{
      const localAuth=structuredClone(freshAuth),identity=c=>({mode:'active-generation',...Object.fromEntries(
        ['generationId','manifestHash','sourceCycleId','committedAt'].map(k=>[k,c.pointer[k]]))});
      localAuth.publication.committed=identity(contexts.committed);
      const publication={databaseOid:'42',committed:identity(contexts.committed),rawCurrent:identity(contexts.rawCurrent),rawPrevious:identity(contexts.rawPrevious)};
      const state={...structuredClone(stateForCapture()),sha:hex('a'),key:hex('b'),createdAt:new Date(now-60000).toISOString(),
        committedGenerationRepairAuthorizationHash:crypto.createHash('sha256').update(JSON.stringify(localAuth)).digest('hex'),
        repairCapturePolicy:localAuth.bindingPolicy};
      function stateForCapture(){return {dataPlane:'code-only',oldSha:localAuth.baseRuntimeSha256,oldDatabaseOid:'42'};}
      const directory='/var/lib/football-release/native/'+state.sha,authFile='/candidate/deploy/light-server/worker-code-repair-authorization.json';
      const files=new Map([[directory+'/state.json',Buffer.from(JSON.stringify(state))],[authFile,Buffer.from(JSON.stringify(localAuth))]]);
      const events=[],metadata=new Map();let held=false,collects=0;
      const stat=file=>{if(files.has(file))return {isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,
        uid:0,nlink:1,mode:0o600,size:files.get(file).length,ino:1,dev:1,...metadata.get(file)};
      if(file.endsWith('.json'))throw Object.assign(Error('absent'),{code:'ENOENT'});
      return {isDirectory:()=>true,isFile:()=>false,isSymbolicLink:()=>false,uid:0,mode:0o700};};
      const fixtureFs={constants:fs.constants,lstatSync:stat,fstatSync:fd=>stat(fd.file),existsSync:file=>files.has(file),
        readFileSync:(fd,encoding)=>{const bytes=files.get(typeof fd==='string'?fd:fd.file);assert(bytes);return encoding?bytes.toString():bytes;},
        openSync:(file,flag,mode)=>{if(flag==='wx'){assert(!files.has(file),'create-only write');assert.equal(mode,0o600);files.set(file,Buffer.alloc(0));events.push(['wx',file]);}
          else stat(file);return {file};},writeFileSync:(fd,value)=>{files.set(fd.file,Buffer.from(value));events.push(['write',fd.file]);},
        fsyncSync:fd=>events.push(['fsync',fd.file]),closeSync:()=>{}};
      const context=vm.createContext({Buffer,Date,process:{},console});
      const realm=value=>{context.fixtureJson=JSON.stringify(value);return new vm.Script('JSON.parse(fixtureJson)').runInContext(context);};
      let fixturePolicy,fixtureWorker,fixtureDriver;
      const fixtureGenerations={...generations,
        resolveCurrentGeneration:()=>{assert.equal(held,false,'current payload hashing must precede pointer lock');
          return {...generations.validateGenerationDirectory({generationDir:contexts.rawCurrent.generationDir}),pointer:contexts.rawCurrent.pointer};},
        resolvePreviousGeneration:()=>{assert.equal(held,false,'previous payload hashing must precede pointer lock');
          return {...generations.validateGenerationDirectory({generationDir:contexts.rawPrevious.generationDir}),pointer:contexts.rawPrevious.pointer};},
        storePaths:()=>({currentPointer:'current',previousPointer:'previous',pointerLockDir:'lock'}),
        acquirePointerCommitLock:()=>{assert.equal(held,false);held=true;events.push(['lock']);return {release:()=>{held=false;events.push(['unlock']);}};},
        readPointer:file=>{assert.equal(held,true);return variant==='pointer-moved'&&file==='current'
          ? {...contexts.rawCurrent.pointer,sourceCycleId:'moved'} : contexts[file==='current'?'rawCurrent':'rawPrevious'].pointer;}};
      const fixtureRequire=name=>name==='node:fs'?fixtureFs:name==='node:path'?path.posix:
        name==='./releaseWorkerCodeRepair.cjs'?fixturePolicy:name==='./releaseWorkerPreflight.cjs'?fixtureWorker:
        name==='./nativeReleaseDataPlane.cjs'?fixtureDriver:name==='../server/dataGenerationStore.cjs'?fixtureGenerations:require(name);
      context.require=fixtureRequire;
      const compile=(source,name)=>{const module={exports:{}};
        new vm.Script('(function(require,module,exports,__dirname){'+source+'\n})',{filename:name}).runInContext(context)(fixtureRequire,module,module.exports,'/candidate/scripts');
        return module.exports;};
      const liveWorker=structuredClone(writerWorker);
      if(variant==='ordinary'){liveWorker.status.lastCycle.ok=true;publication.committed=identity(contexts.rawCurrent);}
      fixtureWorker={evaluateWorkerPreflight:new vm.Script('('+worker.evaluateWorkerPreflight.toString()+')').runInContext(context),
        collectWorkerPreflight:()=>realm(liveWorker),buildReadOnlyWorkerProbe:()=>''};
      fixturePolicy=compile(policySource,'serialized-policy.cjs');
      fixturePolicy.candidateAuthorization=(_root,a)=>fixturePolicy.validateWorkerCodeRepairAuthorization(a,Date.now());
      fixturePolicy.collectWorkerCodeRepair=()=>{collects++;assert.notEqual(variant,'ordinary','healthy capture must not collect stale incident');
        return realm({...freshExtra,publication,files:localAuth.files.map(r=>({path:r.path,sha256:r.beforeSha256}))});};
      fixtureDriver=compile("const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');"+rootFunctions+
        '\nmodule.exports={secureDirectory,read,write};','serialized-root-journal.cjs');
      const subject=compile(nativeSource,'serialized-native-code.cjs');
      const session={identity:publication.committed,publication:{context:variant==='ordinary'?contexts.rawCurrent:contexts.committed,
        pairing:{reason:'exact-committed-postgres-generation'}}};
      session.publication.context=structuredClone(session.publication.context);
      if(variant==='already-captured')files.set(directory+'/code-repair-capture.json',Buffer.from('{}'));
      if(variant==='partial-input')files.set(directory+'/code-lease-current.json',Buffer.from('{}'));
      if(variant==='state-drift')files.set(directory+'/state.json',Buffer.from(JSON.stringify({...state,key:hex('c')})));
      const capture=()=>subject.captureFreshRepairPair(realm(state),realm(session),directory,scratch);
      return {subject,capture,state:realm(state),session:realm(session),authorization:realm(localAuth),events,files,metadata,directory,
        get collects(){return collects;},get held(){return held;},driver:fixtureDriver,realm,publication};
    };
    for(const variant of ['repair','ordinary'])check(()=>{
      const f=runCaptureFixture(variant),r=f.capture();assert.equal(f.held,false);assert.equal(r.capture.body.route,variant);
      assert.equal(f.collects,variant==='ordinary'?0:1);assert.equal(r.capture.body.generationEvidence.rawCurrent.files,1);
      assert.equal(r.capture.body.generationEvidence.rawCurrent.bytes,fs.statSync(path.join(contexts.rawCurrent.generationDir,'matches-current.json')).size);
      const proofFile=f.directory+'/code-repair-capture.json';
      assert(f.events.some(e=>e[0]==='wx'&&e[1]===proofFile));
      assert(f.events.findIndex(e=>e[0]==='fsync'&&e[1]===proofFile)<f.events.findIndex(e=>e[0]==='fsync'&&e[1]===f.directory));
      assert(f.events.findIndex(e=>e[0]==='fsync'&&e[1]===f.directory)<f.events.findIndex(e=>e[0]==='unlock'));
      const before=Buffer.from(f.files.get(proofFile)),count=f.collects;
      assert.throws(f.capture,/re-capture is forbidden/);assert.equal(f.collects,count);assert.deepEqual(f.files.get(proofFile),before);
      const input={sha:f.state.sha,identity:f.session.identity,capturedAt:r.capture.body.checkedAt,
        repairCaptureSha256:crypto.createHash('sha256').update(JSON.stringify(r.capture)).digest('hex'),
        archiveReadiness:{checkedAt:new Date(now).toISOString(),requiredThrough:new Date(now+900000).toISOString(),leaseSeconds:900,pendingRows:0}};
      f.driver.write(f.directory+'/code-lease-input.json',f.realm(input));
      assert.deepEqual(f.subject.readFreshRepairCapture(f.state,f.authorization,f.state.committedGenerationRepairAuthorizationHash),r.capture);
      assert.equal(f.subject.assertRepairPair(f.state,f.session,contexts.rawCurrent,contexts.rawPrevious,
        f.authorization,f.state.committedGenerationRepairAuthorizationHash,r.capture).productionWrites,0);
      for(const [name,value] of [['nlink',2],['uid',1000],['mode',0o644],['isSymbolicLink',()=>true]]) {
        f.metadata.set(proofFile,{[name]:value});assert.throws(()=>f.subject.readFreshRepairCapture(f.state,f.authorization,f.state.committedGenerationRepairAuthorizationHash));
      }
      f.metadata.clear();
      f.files.set(f.directory+'/code-lease-input.json',Buffer.from(JSON.stringify({...input,repairCaptureSha256:hex('f')})));
      assert.throws(()=>f.subject.readFreshRepairCapture(f.state,f.authorization,f.state.committedGenerationRepairAuthorizationHash));
      for(const change of [v=>v.body.publication.rawCurrent.sourceCycleId='other',v=>v.body.generationEvidence.rawCurrent.bytes++,v=>v.sha256=hex('f'),v=>v.hmac=hex('f')]) {
        const changed=f.realm(r.capture);change(changed);
        assert.throws(()=>f.subject.assertFreshRepairCapture(f.state,changed,f.authorization,f.state.committedGenerationRepairAuthorizationHash));
      }
      for(const field of ['generationId','manifestHash','sourceCycleId','committedAt']) {
        assert.throws(()=>f.subject.assertRepairPair(f.state,f.session,{...contexts.rawCurrent,pointer:{...contexts.rawCurrent.pointer,[field]:'changed'}},contexts.rawPrevious,
          f.authorization,f.state.committedGenerationRepairAuthorizationHash,r.capture));
      }
      assert.throws(()=>f.subject.assertRepairPair(f.state,{...f.session,identity:contexts.rawPrevious.pointer},contexts.rawCurrent,contexts.rawPrevious,
        f.authorization,f.state.committedGenerationRepairAuthorizationHash,r.capture));
      assert.throws(()=>f.subject.assertFreshRepairCapture(f.realm({...f.state,sha:hex('d')}),r.capture,f.authorization,f.state.committedGenerationRepairAuthorizationHash));
      assert.throws(()=>f.subject.assertFreshRepairCapture(f.state,r.capture,f.authorization,hex('d')));
    });
    for(const variant of ['pointer-moved','already-captured','partial-input','state-drift'])check(()=>{
      const f=runCaptureFixture(variant);assert.throws(f.capture);assert.equal(f.held,false);assert.equal(f.events.some(e=>e[0]==='wx'),false);
    });
    check(()=>{const file=path.join(contexts.rawCurrent.generationDir,'matches-current.json'),before=fs.readFileSync(file);
      try {fs.writeFileSync(file,Buffer.alloc(before.length,32));const f=runCaptureFixture();assert.throws(f.capture,/hash mismatch/);
        assert.equal(f.events.some(e=>e[0]==='lock'||e[0]==='wx'),false);assert.equal(f.collects,0);
      } finally {fs.writeFileSync(file,before);}});
  } finally {
    assert.equal(path.dirname(path.resolve(scratch)),path.resolve(os.tmpdir()));
    assert(path.basename(scratch).startsWith('football-v6-capture-'));
    fs.rmSync(scratch,{recursive:true});
  }
  return {ok:true,checks,synthetic:true,productionWrites:0,workerHealthPromoted:false};
}
module.exports={verifyReleaseWorkerCodeRepair};
if(require.main===module)console.log(JSON.stringify(verifyReleaseWorkerCodeRepair()));
