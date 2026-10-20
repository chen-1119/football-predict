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
module.exports={fixture};
