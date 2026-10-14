'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const p=require('../scripts/releaseWorkerCodeRepair.cjs'),base=require('../scripts/releaseWorkerPreflight.cjs');
const code=require('../scripts/nativeCodeReleaseDataPlane.cjs'),hex=n=>String(n).repeat(64),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture() {
  const now=Date.now(),clock=ago=>new Date(now-ago).toISOString(),service={ActiveState:'active',MainPID:'42',ExecMainStartTimestamp:new Date(now-7200000).toUTCString()};
  const identity=(n,ago)=>({mode:'active-generation',generationId:'g-'+hex(n),manifestHash:hex(n),sourceCycleId:'cycle-'+n,committedAt:clock(ago)});
  const failure={ok:false,error:'REFERENCE_DECISION_INDEX_LIMIT',errorCode:null};
  const incident={workerMainPid:'42',workerStartedAt:new Date(service.ExecMainStartTimestamp).toISOString(),cycleStartedAt:clock(180000),cycleFinishedAt:clock(120000),
    journalPid:'44',journalTimestampUs:String((now-120050)*1000),journalMessageSha256:hash(JSON.stringify(failure,null,2)),failure};
  const proof={sourceBytes:1029795266,sourceSha256:hex(8),corpusSha256:hex(9),records:7964,serializedChars:34963149,serializedBytes:35495897,
    compressedIndexBytes:17620517,maxRecordBytes:4572,originalIndexBound:33554432,originalCountBound:100000,originalAttestationAll:true};
  const authorization={version:'worker-code-repair-v7',reason:'reference-decision-index-limit',bindingPolicy:'fresh-reference-index-limit-and-exact-corpus-before-lease-v1',
    createdAt:clock(600000),expiresAt:new Date(now+3600000).toISOString(),baseRuntimeSha256:hex(1),incident,referenceIndex:proof,
    indexSources:p.REFERENCE_INDEX_SOURCES.map(path=>({path,sha256:hex(4)})),
    files:p.REFERENCE_INDEX_TARGETS.map(path=>({path,beforeSha256:hex(2),afterSha256:hex(3)})),
    dataContract:[...p.DATA_FILES,'server/postgres/migrations/001_core.sql'].sort().map(path=>({path,sha256:hex(4)})),
    publication:{databaseOid:'42',committed:identity(1,3600000),rawPrevious:identity(2,1800000),rawCurrent:identity(3,900000)}};
  const worker={checkedAt:clock(0),serviceBefore:service,serviceAfter:service,processMatches:true,status:{pid:42,checkedAt:clock(1000),ok:false,phase:'failed',lastCycle:{ok:false,
    startedAt:clock(60000),finishedAt:clock(2000),phase:'official-result-failed',errorCode:'SYNC_WORKER_COMMAND_FAILED',error:'npm run reconcile:fast-results-generation exited with 1'}}};
  const actual={...incident,cycleStartedAt:worker.status.lastCycle.startedAt,cycleFinishedAt:worker.status.lastCycle.finishedAt,journalPid:'45',journalTimestampUs:String((now-2050)*1000)};
  const observed={runtimeSha256:hex(1),completeSha256:hex(1),recoveryPending:false,files:authorization.files.map(r=>({path:r.path,sha256:r.beforeSha256})),
    dataContract:structuredClone(authorization.dataContract),migrationNames:['001_core.sql'],indexSources:structuredClone(authorization.indexSources),referenceIndex:{...proof,sourceBytes:proof.sourceBytes+100,sourceSha256:hex(7)},
    publication:{...authorization.publication,rawPrevious:identity(5,600000),rawCurrent:identity(6,300000)},
    journal:JSON.stringify(failure,null,2).split('\n').map(message=>({unit:'football-sync-worker.service',pid:actual.journalPid,timestampUs:actual.journalTimestampUs,timestampMs:Number(actual.journalTimestampUs)/1000,message}))};
  return {now,authorization,worker,observed,actual};
}
test('exact repeated index-limit scope retains failed health and all cutover gates',()=>{
  const f=fixture(),r=p.evaluateWorkerCodeRepair(f.authorization,f.worker,f.observed);
  a.equal(r.ok,true);a.equal(r.repairPreparationAllowed,true);a.equal(r.workerHealthy,false);a.equal(r.workerReport.ok,false);
  a.deepEqual(r.workerReport.blockers,['worker-latest-official-cycle-failed']);a.equal(r.readyToCutover,false);a.equal(r.productionWrites,0);
  a.deepEqual(p.repeatedRepairIncident(f.authorization,f.worker,f.observed.journal),f.actual);
  a.equal(base.evaluateWorkerPreflight(f.worker).ok,false);
});
test('old incident versions cannot admit this fault; healthy worker uses the original route',()=>{
  const f=fixture();
  for(const version of ['worker-code-repair-v1','worker-code-repair-v2','worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5','worker-code-repair-v6'])
    a.equal(p.evaluateWorkerCodeRepair({...f.authorization,version},f.worker,f.observed).ok,false);
  const worker=structuredClone(f.worker);worker.status.ok=true;worker.status.lastCycle.ok=true;
  const s=p.selectWorkerCodeRepairPreparation(f.authorization,worker,()=>{throw Error('healthy route must not read historical incident');});
  a.equal(s.useRepair,false);a.equal(s.report.ok,true);a.equal(s.report.readyToCutover,false);
});
const invalidAuth=[v=>v.reason='ignore-worker',v=>v.bindingPolicy='any-index-failure',v=>v.files.shift(),v=>v.files.reverse(),
  v=>v.files[0].afterSha256=v.files[0].beforeSha256,v=>v.indexSources.shift(),v=>v.indexSources[0].sha256=hex(5),v=>v.dataContract=[],
  v=>v.referenceIndex.records=100001,v=>v.referenceIndex.serializedChars=33554432,v=>v.referenceIndex.compressedIndexBytes=33554433,
  v=>v.referenceIndex.originalIndexBound*=2,v=>v.referenceIndex.originalCountBound++,v=>v.referenceIndex.originalAttestationAll=false,
  v=>v.referenceIndex.sourceBytes=2*1024**3+1,v=>v.referenceIndex.extra=true,v=>v.incident.failure.error='Invalid string length',
  v=>v.incident.failure.errorCode='OOM',v=>v.incident.workerMainPid='99',v=>v.incident.journalMessageSha256=hex(5),
  v=>v.expiresAt=new Date(Date.now()-1).toISOString(),v=>v.publication.databaseOid='other',v=>v.extra=true];
for(const [i,change] of invalidAuth.entries())test('reject signed scope mutation '+i,()=>{
  const f=fixture();change(f.authorization);a.equal(p.evaluateWorkerCodeRepair(f.authorization,f.worker,f.observed).ok,false);
});
const invalidObserved=[v=>v.journal.pop(),v=>v.journal.push(v.journal[0]),v=>v.journal[0].pid='99',v=>v.journal[0].timestampUs='1792000000000000',
  v=>v.journal[0].timestampMs++,v=>v.journal[0].unit='other.service',v=>v.journal[2].message='  "error": "some-other-fault",',
  v=>v.journal.reverse(),v=>v.referenceIndex.corpusSha256=hex(6),v=>v.referenceIndex.serializedBytes++,v=>v.referenceIndex.records++,
  v=>v.indexSources[2].sha256=hex(6),v=>v.files[0].sha256=hex(6),v=>v.publication.committed.sourceCycleId='other',
  v=>v.publication.rawPrevious.committedAt=new Date(Date.now()-7200000).toISOString(),v=>v.recoveryPending=true,
  v=>v.completeSha256=hex(6),v=>v.migrationNames.push('002_unreviewed.sql')];
for(const [i,change] of invalidObserved.entries())test('reject current observation mutation '+i,()=>{
  const f=fixture();f.observed=structuredClone(f.observed);change(f.observed);a.equal(p.evaluateWorkerCodeRepair(f.authorization,f.worker,f.observed).ok,false);
});
test('seal binds the actual corpus, whole source hash, fresh incident and immutable generation evidence',()=>{
  const f=fixture(),state={key:hex(4),sha:hex(5),oldSha:hex(1),createdAt:new Date(f.now-60000).toISOString(),oldDatabaseOid:'42',dataPlane:'code-only',
    repairCapturePolicy:f.authorization.bindingPolicy,committedGenerationRepairAuthorizationHash:hex(6)};
  const context=identity=>({pointer:identity,manifest:{generationId:identity.generationId,manifestHash:identity.manifestHash,sourceCycleId:identity.sourceCycleId,files:[{path:'matches-current.json',bytes:2}]}});
  const contexts=Object.fromEntries(Object.entries(f.observed.publication).filter(([key])=>key!=='databaseOid').map(([key,value])=>[key,context(value)]));
  const body={sha:state.sha,oldSha:state.oldSha,stateHash:hash(JSON.stringify(state)),authorizationHash:hex(6),checkedAt:new Date(f.now).toISOString(),
    worker:f.worker,observed:f.observed,publication:f.observed.publication,route:'repair',incident:f.actual,
    generationEvidence:Object.fromEntries(Object.entries(contexts).map(([key,value])=>[key,code.generationVerificationEvidence(value)]))};
  const sealed=code.sealFreshRepairCapture(state,body);
  a.deepEqual(code.assertFreshRepairCapture(state,sealed,f.authorization,hex(6)),body);
  const session={identity:body.publication.committed,publication:{context:contexts.committed,pairing:{reason:'exact-committed-postgres-generation'}}};
  a.equal(code.assertRepairPair(state,session,contexts.rawCurrent,contexts.rawPrevious,f.authorization,hex(6),sealed).productionWrites,0);
  for(const edit of [v=>v.body.observed.referenceIndex.sourceSha256=hex(2),v=>v.body.observed.referenceIndex.corpusSha256=hex(2),
    v=>v.body.incident.journalPid='99',v=>v.hmac=hex(2),v=>v.body.generationEvidence.rawCurrent.bytes++]) {
    const x=structuredClone(sealed);edit(x);a.throws(()=>code.assertFreshRepairCapture(state,x,f.authorization,hex(6)));
  }
  a.throws(()=>code.assertRepairPair(state,session,{...contexts.rawCurrent,pointer:body.publication.rawPrevious},contexts.rawPrevious,f.authorization,hex(6),sealed));
});
test('actual serialized probe executes complete five-line locator, dependency and corpus bindings',()=>{
  for(const variant of ['exact','locator-duplicate','journal-missing','source-drift','corpus-drift','pg-commit-drift']) {
    const f=fixture(),files=new Map(),root='/opt/football-predict';
    for(const row of f.authorization.files){const bytes=Buffer.from(row.path);row.beforeSha256=hash(bytes);files.set(root+'/'+row.path,bytes);}
    f.observed.files=f.authorization.files.map(r=>({path:r.path,sha256:r.beforeSha256}));
    for(const row of [...f.authorization.dataContract,...f.authorization.indexSources]){const bytes=Buffer.from(row.path);row.sha256=hash(bytes);files.set(root+'/'+row.path,bytes);}
    if(variant==='source-drift')files.set(root+'/'+f.authorization.indexSources[0].path,Buffer.from('different'));
    for(const name of ['.release-bundle-sha256','.release-live-complete'])files.set(root+'/'+name,Buffer.from(hex(1)+'\n'));
    files.set('/var/lib/football-predict/sync-worker-status.json',Buffer.from(JSON.stringify(f.worker.status)));
    files.set('/proc/42/cmdline',Buffer.from('/opt/node/bin/node\0'+root+'/scripts/runSyncWorker.cjs\0'));
    for(const name of ['current','previous'])files.set('/var/lib/football-predict/data-generations/'+name+'.json',Buffer.from(JSON.stringify({schemaVersion:1,...f.observed.publication[name==='current'?'rawCurrent':'rawPrevious']})));
    const stat=file=>({isDirectory:()=>!files.has(file),isSymbolicLink:()=>false,isFile:()=>files.has(file),nlink:1,ino:1,size:files.get(file)?.length||0,mtimeMs:1,ctimeMs:1});
    const fixtureFs={constants:require('node:fs').constants,realpathSync:v=>v,readlinkSync:()=>root,lstatSync:file=>{
      if(file.startsWith('/var/lib/football-release/'))throw Object.assign(Error('absent'),{code:'ENOENT'});return stat(file);},
      fstatSync:stat,openSync:file=>{a(files.has(file));return file;},closeSync:()=>{},readFileSync:(file,enc)=>enc?files.get(file).toString():files.get(file),readdirSync:()=>['001_core.sql']};
    const rows=f.observed.journal.map(r=>({_SYSTEMD_UNIT:r.unit,_PID:r.pid,MESSAGE:r.message,__REALTIME_TIMESTAMP:r.timestampUs}));
    const fixtureChild={execFileSync:(command,args)=>{
      if(command==='systemctl')return Object.entries(f.worker.serviceAfter).map(([key,value])=>key+'='+value).join('\n');
      if(command==='/usr/sbin/runuser') {const c=variant==='pg-commit-drift'?f.observed.publication.rawCurrent:f.observed.publication.committed;
        return JSON.stringify({databaseOid:'42',readOnly:'on',meta:Object.fromEntries(['data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at'].map((key,i)=>[key,c[['mode','generationId','manifestHash','sourceCycleId','committedAt'][i]]]))});}
      a.equal(command,'/usr/bin/journalctl');a(args.includes('--lines=64'));
      if(!args.some(s=>s.startsWith('--grep'))) {
        const us=BigInt(rows[0].__REALTIME_TIMESTAMP),epoch=n=>'@'+(n/1000000n).toString()+'.'+(n%1000000n).toString().padStart(6,'0');
        a(args.includes('--since='+epoch(us)));a(args.includes('--until='+epoch(us+1n)));
      }
      const selected=args.some(s=>s.startsWith('--grep'))?(variant==='locator-duplicate'?[rows[2],rows[2]]:[rows[2]]):(variant==='journal-missing'?rows.slice(1):rows);
      return selected.map(r=>JSON.stringify(r)).join('\n');
    }};
    // The complete collector is exercised; only the expensive streaming input
    // is supplied as the independently tested numeric corpus fixture here.
    const source=p.buildWorkerCodeRepairProbe(f.authorization).replace('referenceProof=collectReferenceIndexProof(root);',
      'referenceProof=JSON.parse('+JSON.stringify(JSON.stringify({...f.observed.referenceIndex,...(variant==='corpus-drift'?{corpusSha256:hex(2)}:{})}))+');');
    const output=[],process={exitCode:0},requireFixture=name=>name==='node:fs'?fixtureFs:name==='node:path'?require('node:path').posix:name==='node:child_process'?fixtureChild:require(name);
    new vm.Script(source).runInNewContext({require:requireFixture,process,console:{log:s=>output.push(s)},Date});
    a.equal(output.length,1);const result=JSON.parse(output[0]);a.equal(result.ok,variant==='exact',JSON.stringify(result));
    a.equal(result.readyToCutover,false);a.equal(result.productionWrites,0);a.equal(process.exitCode,variant==='exact'?0:1);
  }
});
