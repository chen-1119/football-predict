'use strict';
const test=require('node:test'),a=require('node:assert/strict'),p=require('../scripts/manualOfficialReleaseRecovery.cjs');
function fixture(){
 const checkedAt='2026-10-20T16:00:00.000Z',start='2026-10-20T15:50:00.000Z',end='2026-10-20T15:55:00.000Z';
 const incident={workerMainPid:'2990491',workerStartedAt:'2026-10-18T04:49:51.000Z',cycleStartedAt:start,cycleFinishedAt:end,journalPid:'4094260',
  journalTimestampUs:String(BigInt(Date.parse(end)-200)*1000n),journalMessageSha256:p.hash(p.MESSAGE)};
 const files=['scripts/manualOfficialReleaseRecovery.cjs','scripts/manualOfficialPublicCarryForward.cjs','scripts/recommendationPlatform/reviewedOfficialEvent.cjs','server/researchOfficialEventRead.cjs'].sort().map(path=>({path,beforeSha256:null,afterSha256:'b'.repeat(64)}));
 const gap=Array.from({length:29},(_,i)=>({sourceMatchId:String(i+1),recordHash:'c'.repeat(64),recordSha256:'d'.repeat(64)})).sort((a,b)=>a.sourceMatchId<b.sourceMatchId?-1:1);
 const publication={databaseOid:'28598409',mode:'active-generation',generationId:'g-'+'a'.repeat(64),manifestHash:'a'.repeat(64),sourceCycleId:'synthetic-cycle',committedAt:'2026-10-18T10:03:47.828Z'};
 const auth={version:p.VERSION,reason:'install-independent-official-editorial-authority-preserving-r903-original-gap',createdAt:'2026-10-20T15:59:00.000Z',expiresAt:'2026-10-20T17:59:00.000Z',
  optionalPreludePolicy:p.PRELUDE.policy,
  baseRuntimeSha256:p.BASE,files,baselineClosure:p.READER_ROOTS.map(path=>({path,sha256:'e'.repeat(64)})).sort((a,b)=>a.path<b.path?-1:1),
  dataContract:[{path:'server/postgresStore.cjs',sha256:'f'.repeat(64)}],current:{...p.CURRENT},warehouse:{...p.WAREHOUSE},gap,incident,publication};
 const service={ActiveState:'active',MainPID:incident.workerMainPid,ExecMainStartTimestamp:'Sun 2026-10-18 04:49:51 UTC'};
 const worker={checkedAt,serviceBefore:{...service},serviceAfter:{...service},processMatches:true,status:{pid:2990491,checkedAt,ok:true,phase:'official-result',pipeline:[{id:'official-result-fast',fatal:false,operations:['sync:cloudflare-sporttery-evidence']}],
  lastCycle:{ok:false,skipped:false,phase:'official-result-failed',startedAt:start,finishedAt:end,errorCode:'SYNC_WORKER_COMMAND_FAILED',error:'node scripts/syncData.cjs exited with 1'}}};
 const observed={runtimeSha256:p.BASE,completeSha256:p.BASE,recoveryPending:false,oldAuthorizationPresent:false,files:files.map(r=>({path:r.path,sha256:r.beforeSha256})),
  baselineClosure:structuredClone(auth.baselineClosure),dataContract:structuredClone(auth.dataContract),current:{...p.CURRENT},warehouse:{...p.WAREHOUSE},gap:structuredClone(gap),publication:{...publication},
  indexMatches:0,globalArchiveAccepted:true,servingHealthAccepted:true,ordinaryPointerAffinity:true,completedAt:checkedAt,journal:[{unit:'football-sync-worker.service',pid:incident.journalPid,timestampUs:incident.journalTimestampUs,message:p.MESSAGE,command:'node scripts/syncData.cjs',executable:p.PRELUDE.executable}]};
 return {auth,worker,observed};
}
test('manual preparation preserves the false worker report and grants no cutover or repair-pair authority',()=>{
 const v=fixture(),before=JSON.stringify(v),report=p.evaluate(v.auth,v.worker,v.observed);
 a.equal(report.preparationAllowed,true);a.equal(report.workerReport.ok,false);a.equal(report.workerHealthy,false);a.equal(report.readyToCutover,false);a.equal(report.productionWrites,0);
 a.equal(report.ok,undefined);a.equal(JSON.stringify(v),before);a.equal(report.committedGenerationRepairAuthorizationHash,undefined);a.equal(report.repairCapturePolicy,undefined);
});
const negatives=[
 ['expired authorization',v=>v.auth.expiresAt=v.worker.checkedAt],
 ['future authorization',v=>v.auth.createdAt='2026-10-20T16:10:00.000Z'],
 ['extended authorization',v=>v.auth.expiresAt='2026-10-21T00:00:00.000Z'],
 ['authorization expires during collection',v=>v.observed.completedAt=v.auth.expiresAt],
 ['wrong completed release',v=>v.observed.completeSha256='0'.repeat(64)],
 ['pending recovery',v=>v.observed.recoveryPending=true],
 ['old and manual authorizations coexist',v=>v.observed.oldAuthorizationPresent=true],
 ['PID reuse with different start clock',v=>v.worker.serviceAfter.ExecMainStartTimestamp='Sun 2026-10-18 04:49:52 UTC'],
 ['additional worker blocker',v=>v.worker.processMatches=false],
 ['skipped cycle',v=>v.worker.status.lastCycle.skipped=true],
 ['different command failure',v=>v.worker.status.lastCycle.error='npm run postgres:sync exited with 1'],
 ['changed original source',v=>v.observed.baselineClosure[0].sha256='0'.repeat(64)],
 ['changed data contract',v=>v.observed.dataContract[0].sha256='0'.repeat(64)],
 ['changed complete mutable file',v=>v.observed.current.sha256='0'.repeat(64)],
 ['changed complete warehouse',v=>v.observed.warehouse.sha256='0'.repeat(64)],
 ['missing original set decreased',v=>v.observed.gap.pop()],
 ['missing original set increased',v=>v.observed.gap.push(v.observed.gap[0])],
 ['record bytes changed',v=>v.observed.gap[0].recordSha256='0'.repeat(64)],
 ['existing index is not classified missing',v=>v.observed.indexMatches=1],
 ['ordinary affinity failure',v=>v.observed.ordinaryPointerAffinity=false],
 ['global archive failure',v=>v.observed.globalArchiveAccepted=false],
 ['normal health failure',v=>v.observed.servingHealthAccepted=false],
 ['wrong journal child',v=>v.observed.journal[0].pid='123'],
 ['changed journal microsecond',v=>v.observed.journal[0].timestampUs=String(BigInt(v.observed.journal[0].timestampUs)+1n)],
 ['absent target failure',v=>v.observed.journal=[]],
 ['duplicate target failure',v=>v.observed.journal.push({...v.observed.journal[0]})],
 ['additional child error',v=>v.observed.journal.push({...v.observed.journal[0],message:'Error: a second failure'})],
 ['compact JSON failure from unknown child',v=>v.observed.journal.push({...v.observed.journal[0],pid:'4095555',command:'node scripts/unknown.cjs',message:'{"ok":false}'})],
 ['spaced JSON failure from unknown child',v=>v.observed.journal.push({...v.observed.journal[0],pid:'4095555',command:'node scripts/unknown.cjs',message:'{"ok"   :   false}'})],
 ['tabbed JSON failure from unknown child',v=>v.observed.journal.push({...v.observed.journal[0],pid:'4095555',command:'node scripts/unknown.cjs',message:'{"ok"\t:\tfalse}'})],
 ['truncated cycle journal',v=>v.observed.journal=Array(2000).fill(v.observed.journal[0])],
 ['overlapping repeated cycle',v=>v.worker.status.lastCycle.finishedAt='2026-10-20T15:56:00.000Z'],
 ['future failed cycle',v=>v.worker.status.lastCycle.finishedAt='2026-10-20T16:01:00.000Z'],
 ['healthy worker cannot be promoted through incident route',v=>{v.worker.status.lastCycle={ok:true,skipped:false,phase:'complete'};}],
];
for(const [label,change]of negatives)test('manual preparation refuses '+label,()=>{const v=fixture();change(v);a.equal(p.evaluate(v.auth,v.worker,v.observed).preparationAllowed,false);});
test('an explicitly bound later identical fault gets a new observation without renewing the signed authorization',()=>{
 const v=fixture(),before=JSON.stringify(v.auth);Object.assign(v.worker.status.lastCycle,{startedAt:'2026-10-20T15:55:01.000Z',finishedAt:'2026-10-20T15:59:59.000Z'});
 Object.assign(v.observed.journal[0],{pid:'4099999',timestampUs:String(BigInt(Date.parse('2026-10-20T15:59:58.900Z'))*1000n)});
 const report=p.evaluate(v.auth,v.worker,v.observed);a.equal(report.preparationAllowed,true);a.equal(report.actualIncident.journalPid,'4099999');a.equal(JSON.stringify(v.auth),before);
});
function withPrelude(){
 const v=fixture(),text=JSON.stringify({ok:false,checkedAt:'2026-10-20T15:50:02.000Z',error:'fetch failed'},null,2);
 const rows=text.split('\n').map(message=>({unit:'football-sync-worker.service',pid:'4091111',timestampUs:String(BigInt(Date.parse('2026-10-20T15:50:02.001Z'))*1000n),message,command:p.PRELUDE.command,executable:p.PRELUDE.executable}));
 v.observed.journal.unshift(...rows);return v;
}
test('one exact existing nonfatal Cloudflare failure is recorded without erasing worker failure',()=>{
 const v=withPrelude(),report=p.evaluate(v.auth,v.worker,v.observed);a.equal(report.preparationAllowed,true);a.equal(report.workerReport.ok,false);a.equal(report.actualIncident.actualPrelude.length,1);a.equal(report.actualIncident.actualPrelude[0].fatal,false);a.equal(report.actualIncident.actualPrelude[0].error,'fetch failed');
});
for(const [label,change]of [
 ['incomplete JSON frame',v=>v.observed.journal.shift()],
 ['noncontiguous JSON frame',v=>v.observed.journal.splice(2,0,{...v.observed.journal[0],message:'other stdout'})],
 ['extra JSON field',v=>v.observed.journal.splice(4,0,{...v.observed.journal[0],message:'  "extra": true,'})],
 ['changed command',v=>v.observed.journal.slice(0,5).forEach(r=>r.command='node scripts/unknown.cjs')],
 ['changed executable',v=>v.observed.journal.slice(0,5).forEach(r=>r.executable='/bin/unknown')],
 ['second frame',v=>v.observed.journal.splice(5,0,...v.observed.journal.slice(0,5).map(r=>({...r,pid:'4091112'})))],
 ['different failure text',v=>v.observed.journal[3].message='  "error": "different error"'],
 ['frame outside cycle',v=>v.observed.journal[2].message='  "checkedAt": "2026-10-20T15:49:59.000Z",'],
 ['frame after fatal target',v=>{v.observed.journal.slice(0,5).forEach(r=>r.timestampUs=String(BigInt(Date.parse('2026-10-20T15:54:59.900Z'))*1000n));v.observed.journal[2].message='  "checkedAt": "2026-10-20T15:54:59.899Z",';}],
 ['fatal prelude pipeline changed',v=>v.worker.status.pipeline[0].fatal=true],
 ['excluded sensitive journal row',v=>v.observed.journal.push({...v.observed.journal[0],pid:'2990491',message:'SECRET=excluded-fixture-only'})]
])test('optional prelude rejects '+label,()=>{const v=withPrelude();change(v);a.equal(p.evaluate(v.auth,v.worker,v.observed).preparationAllowed,false);});
test('the complete fixed SSH probe compiles before any transport',()=>{
 const v=fixture(),now=Date.now();v.auth.createdAt=new Date(now).toISOString();v.auth.expiresAt=new Date(now+60000).toISOString();const source=p.buildProbe(v.auth);new(require('node:vm').Script)(source);a(Buffer.byteLength(source)<120000);
});
// Exercise the actual collector in the same VM realm as the signed CLI. Only
// operating-system I/O is replaced; Buffer is deliberately not a VM global.
function collectInEntryRealm(change){
 const path=require('node:path').posix,root='/opt/football-predict',v=fixture(),files=new Map(),fds=new Map(),reads=[],calls=[];
 const put=(relative,value)=>files.set(path.join(root,relative),Buffer.from(value));
 for(const name of p.READER_ROOTS)put(name,'// fixture reader '+name);
 put('package.json',JSON.stringify({scripts:{'sync:cloudflare-sporttery-evidence':p.PRELUDE.command,'sync:data':'node scripts/syncData.cjs'}}));
 put('.release-bundle-sha256',p.BASE);put('.release-live-complete',p.BASE);
 put('public/data/matches-current.json','[]');put('public/data/prediction-snapshots.json','["streamed original fixture"]');
 v.auth.baselineClosure=p.READER_ROOTS.map(name=>({path:name,sha256:p.hash(files.get(path.join(root,name)))})).sort((x,y)=>x.path<y.path?-1:1);
 const directories=new Set([root]);for(const file of files.keys()){let dir=path.dirname(file);while(dir!==root){directories.add(dir);dir=path.dirname(dir);}}
 const ino=new Map([...files.keys()].map((name,i)=>[name,i+100]));let next=10;
 function stat(name){
  if(!files.has(name)&&!directories.has(name))throw Object.assign(Error('missing fixture'),{code:'ENOENT'});
  return {dev:1,ino:ino.get(name)||1,size:files.get(name)?.length||0,mtimeMs:1,ctimeMs:1,nlink:1,isFile:()=>files.has(name),isDirectory:()=>directories.has(name),isSymbolicLink:()=>false};
 }
 const fakeFs={constants:require('node:fs').constants,realpathSync:name=>name,lstatSync:stat,
  openSync(name,flags){a.equal(flags,this.constants.O_RDONLY|this.constants.O_NOFOLLOW);stat(name);fds.set(++next,{name,offset:0});return next;},
  fstatSync:fd=>stat(fds.get(fd).name),closeSync:fd=>fds.delete(fd),
  readFileSync(fd){const name=fds.get(fd).name;reads.push(name);return Buffer.from(files.get(name));},
  readSync(fd,buffer,offset,length,position){a(Buffer.isBuffer(buffer));a.equal(buffer.length,1024*1024);a.equal(position,null);const row=fds.get(fd),bytes=files.get(row.name),n=Math.min(length,bytes.length-row.offset);bytes.copy(buffer,offset,row.offset,row.offset+n);row.offset+=n;reads.push(row.name);return n;}};
 const fakeCp={execFileSync(command,args,options){a.equal(command,'/usr/bin/journalctl');a(args.includes('--lines=2000'));a.equal(options.maxBuffer,8*1024*1024);calls.push('journal');return '';},
  spawnSync(command,args,options){a.equal(command,'/usr/sbin/runuser');a.deepEqual(Array.from(args),['-u','football','--','/opt/node-v22.22.1/bin/node','-']);a(options.input.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));a.equal(options.timeout,35000);calls.push('publication-readonly');return {status:0,stdout:JSON.stringify({publication:v.auth.publication,ordinaryPointerAffinity:true,indexMatches:0,globalArchiveAccepted:true,servingHealthAccepted:true})};}};
 const fakeRequire=id=>{
  if(id==='node:fs')return fakeFs;if(id==='node:path')return path;if(id==='node:child_process')return fakeCp;
  if(id===root+'/scripts/releaseDataPlanePolicy.cjs')return {capture:()=>({entries:v.auth.dataContract})};
  if(['node:assert/strict','node:crypto','node:buffer'].includes(id))return require(id);
  throw Error('unexpected collector dependency: '+id);
 };
 fakeRequire.resolve=file=>file;
 if(change)change({fakeFs,files,root,stat,v,calls});
 const code='const OLD_AUTH='+JSON.stringify(p.OLD_AUTH)+',PRELUDE='+JSON.stringify(p.PRELUDE)+',READER_ROOTS='+JSON.stringify(p.READER_ROOTS)+';'
  +'const auth='+JSON.stringify(v.auth)+',worker='+JSON.stringify(v.worker)+';'
  +p.hash.toString()+'\nfunction collectWorkerPreflight(){return JSON.parse('+JSON.stringify(JSON.stringify(v.worker))+');}\n'
  +p.collect.toString()+'\ncollect(auth,worker);';
 const context={require:fakeRequire,process:{env:{}},console,Date};a.equal(Object.hasOwn(context,'Buffer'),false);
 const observed=new(require('node:vm').Script)(code).runInNewContext(context);
 a.equal(fds.size,0);return {observed,reads,calls,files,root};
}
test('signed CLI VM collector streams complete bytes without a Buffer global and reaches read-only gates',()=>{
 const out=collectInEntryRealm(),bytes=out.files.get(out.root+'/public/data/prediction-snapshots.json');
 a.equal(out.observed.warehouse.bytes,bytes.length);a.equal(out.observed.warehouse.sha256,p.hash(bytes));
 a.deepEqual(out.calls,['journal','publication-readonly']);a.equal(out.observed.globalArchiveAccepted,true);
 a(out.reads.filter(name=>name.endsWith('/prediction-snapshots.json')).length>=2);
});
test('VM collector still rejects stream mutation, symlinks and changed source pins',()=>{
 a.throws(()=>collectInEntryRealm(({fakeFs,root,stat})=>{const original=fakeFs.readSync;let streamed=false;fakeFs.readSync=function(...args){streamed=true;return original.apply(this,args);};fakeFs.lstatSync=name=>{const result=stat(name);if(streamed&&name===root+'/public/data/prediction-snapshots.json')result.ino++;return result;};}),{code:'ERR_ASSERTION'});
 a.throws(()=>collectInEntryRealm(({fakeFs,root,stat})=>{fakeFs.lstatSync=name=>({...stat(name),isSymbolicLink:()=>name===root+'/public/data'});}),{code:'ERR_ASSERTION'});
 a.throws(()=>collectInEntryRealm(({files,root})=>files.set(root+'/scripts/nativeCodeReleaseDataPlane.cjs',Buffer.from('// changed source'))),{code:'ERR_ASSERTION'});
});
module.exports={fixture};

function scheduleFixture(){
 const v=fixture(),shift=Date.parse('2026-10-21T17:00:00.000Z')-Date.parse(v.worker.checkedAt),clock=s=>new Date(Date.parse(s)+shift).toISOString();
 Object.assign(v.auth,{version:p.SCHEDULE_VERSION,reason:'restore-signed-official-schedule-preserving-r906-original-gap',baseRuntimeSha256:p.SCHEDULE_BASE,
  createdAt:clock(v.auth.createdAt),expiresAt:clock(v.auth.expiresAt)});
 Object.assign(v.auth.incident,{workerMainPid:'397815',workerStartedAt:'2026-10-21T15:55:29.000Z',cycleStartedAt:clock(v.auth.incident.cycleStartedAt),cycleFinishedAt:clock(v.auth.incident.cycleFinishedAt),journalTimestampUs:String(BigInt(v.auth.incident.journalTimestampUs)+BigInt(shift)*1000n)});
 for(const path of ['server/officialScheduleRead.cjs','server/officialScheduleHttp.cjs','src/services/officialSchedule.cjs','src/hooks/useOfficialSchedule.ts','src/components/recommendations/OfficialSchedule.tsx','src/pages/PredictionsList.tsx'])v.auth.files.push({path,beforeSha256:null,afterSha256:'b'.repeat(64)});
 v.auth.files.sort((x,y)=>x.path<y.path?-1:1);v.observed.files=v.auth.files.map(r=>({path:r.path,sha256:r.beforeSha256}));
 for(const service of [v.worker.serviceBefore,v.worker.serviceAfter])Object.assign(service,{MainPID:'397815',ExecMainStartTimestamp:'Wed 2026-10-21 15:55:29 UTC'});
 v.worker.status.pid=397815;v.worker.checkedAt=clock(v.worker.checkedAt);v.worker.status.checkedAt=v.worker.checkedAt;
 v.worker.status.lastCycle.startedAt=clock(v.worker.status.lastCycle.startedAt);v.worker.status.lastCycle.finishedAt=clock(v.worker.status.lastCycle.finishedAt);
 Object.assign(v.observed,{runtimeSha256:p.SCHEDULE_BASE,completeSha256:p.SCHEDULE_BASE,completedAt:v.worker.checkedAt});v.observed.journal[0].timestampUs=v.auth.incident.journalTimestampUs;
 return v;
}
test('r906 schedule preparation is a separately named exact baseline and keeps original29 plus failed worker intact',()=>{
 const v=scheduleFixture(),before=JSON.stringify(v),report=p.evaluate(v.auth,v.worker,v.observed);
 a.equal(report.preparationAllowed,true);a.equal(report.workerHealthy,false);a.equal(report.readyToCutover,false);a.equal(report.productionWrites,0);a.equal(JSON.stringify(v),before);
});
for(const [label,change]of [
 ['old version reused',v=>v.auth.version=p.VERSION],['old reason reused',v=>v.auth.reason='install-independent-official-editorial-authority-preserving-r903-original-gap'],
 ['unrelated baseline',v=>v.auth.baseRuntimeSha256='0'.repeat(64)],['old903 runtime',v=>v.observed.runtimeSha256=p.BASE],
 ['old worker ID',v=>v.auth.incident.workerMainPid='2990491'],['different worker incarnation',v=>v.worker.serviceAfter.ExecMainStartTimestamp='Wed 2026-10-21 15:55:30 UTC'],
 ['missing UI source binding',v=>v.auth.files=v.auth.files.filter(r=>r.path!=='src/pages/PredictionsList.tsx')],
 ['expired scope',v=>v.auth.expiresAt=v.worker.checkedAt],['changed baseline bytes',v=>v.observed.files[0].sha256='0'.repeat(64)],
 ['changed original29',v=>v.observed.gap.pop()],['invented original companion',v=>v.observed.indexMatches=1],['changed warehouse',v=>v.observed.warehouse.sha256='0'.repeat(64)],
 ['healthy worker disguised',v=>v.worker.status.lastCycle.ok=true],['another child error',v=>v.observed.journal.push({...v.observed.journal[0],message:'Error: different failure'})],
 ['changed DB affinity',v=>v.observed.ordinaryPointerAffinity=false],['health failure',v=>v.observed.servingHealthAccepted=false],
 ['data contract change',v=>v.observed.dataContract=[]],['pending controller recovery',v=>v.observed.recoveryPending=true]
])test('r906 preparation refuses '+label,()=>{const v=scheduleFixture();change(v);a.equal(p.evaluate(v.auth,v.worker,v.observed).preparationAllowed,false);});
test('new r906 CLI probe includes version and fixed baseline in its isolated realm',()=>{
 const v=scheduleFixture(),original=Date.now;Date.now=()=>Date.parse(v.worker.checkedAt);
 try{const source=p.buildProbe(v.auth);new(require('node:vm').Script)(source);a(source.includes('const AUTH_ENTRY='));a(source.includes(p.SCHEDULE_BASE));a(source.includes(p.SCHEDULE_VERSION));}finally{Date.now=original;}
});

function displayFixture(){
 const v=scheduleFixture(),shift=Date.parse('2026-10-22T01:07:51.000Z')-Date.parse(v.worker.checkedAt),clock=s=>new Date(Date.parse(s)+shift).toISOString();
 Object.assign(v.auth,{version:p.DISPLAY_VERSION,reason:'restore-official-analysis-display-preserving-r909-original-gap',baseRuntimeSha256:p.DISPLAY_BASE,createdAt:clock(v.auth.createdAt),expiresAt:clock(v.auth.expiresAt)});
 Object.assign(v.auth.incident,{workerMainPid:'485456',workerStartedAt:'2026-10-21T19:49:58.000Z',cycleStartedAt:clock(v.auth.incident.cycleStartedAt),cycleFinishedAt:clock(v.auth.incident.cycleFinishedAt),journalTimestampUs:String(BigInt(v.auth.incident.journalTimestampUs)+BigInt(shift)*1000n)});
 for(const path of ['src/components/recommendations/OfficialSchedule.css','src/components/recommendations/OfficialEditorialReferences.tsx','src/pages/BestTips.tsx'])v.auth.files.push({path,beforeSha256:null,afterSha256:'b'.repeat(64)});
 v.auth.files.sort((x,y)=>x.path<y.path?-1:1);v.observed.files=v.auth.files.map(r=>({path:r.path,sha256:r.beforeSha256}));
 for(const service of [v.worker.serviceBefore,v.worker.serviceAfter])Object.assign(service,{MainPID:'485456',ExecMainStartTimestamp:'Wed 2026-10-21 19:49:58 UTC'});
 v.worker.status.pid=485456;v.worker.checkedAt=clock(v.worker.checkedAt);v.worker.status.checkedAt=v.worker.checkedAt;
 v.worker.status.lastCycle.startedAt=clock(v.worker.status.lastCycle.startedAt);v.worker.status.lastCycle.finishedAt=clock(v.worker.status.lastCycle.finishedAt);
 Object.assign(v.observed,{runtimeSha256:p.DISPLAY_BASE,completeSha256:p.DISPLAY_BASE,completedAt:v.worker.checkedAt});v.observed.journal[0].timestampUs=v.auth.incident.journalTimestampUs;
 return v;
}
test('r909 display preparation has independent runtime identity and never asserts worker recovery',()=>{
 const v=displayFixture(),before=JSON.stringify(v),result=p.evaluate(v.auth,v.worker,v.observed);
 a.equal(result.preparationAllowed,true);a.equal(result.workerHealthy,false);a.equal(result.readyToCutover,false);a.equal(JSON.stringify(v),before);
 const original=Date.now;Date.now=()=>Date.parse(v.worker.checkedAt);
 try{const source=p.buildProbe(v.auth);new(require('node:vm').Script)(source);a(source.includes(p.DISPLAY_VERSION));a(source.includes(p.DISPLAY_BASE));}finally{Date.now=original;}
});
for(const [label,change]of [
 ['r906 version',v=>v.auth.version=p.SCHEDULE_VERSION],['r906 runtime',v=>v.observed.runtimeSha256=p.SCHEDULE_BASE],
 ['r906 worker',v=>v.auth.incident.workerMainPid='397815'],['changed incarnation',v=>v.worker.serviceAfter.ExecMainStartTimestamp='Wed 2026-10-21 19:49:59 UTC'],
 ['missing stylesheet binding',v=>v.auth.files=v.auth.files.filter(r=>r.path!=='src/components/recommendations/OfficialSchedule.css')],
 ['expired authorization',v=>v.auth.expiresAt=v.worker.checkedAt],['modified original',v=>v.observed.current.sha256='0'.repeat(64)],
 ['extra missing record',v=>v.observed.gap.push({...v.observed.gap[0],sourceMatchId:'999'})],['different error',v=>v.observed.journal[0].message='other error'],
 ['skipped cycle',v=>v.worker.status.lastCycle.skipped=true],['changed DB',v=>v.observed.publication.databaseOid='1'],['pending recovery',v=>v.observed.recoveryPending=true]
])test('r909 display preparation rejects '+label,()=>{const v=displayFixture();change(v);a.equal(p.evaluate(v.auth,v.worker,v.observed).preparationAllowed,false);});
