'use strict';
// Preparation of V4 during the fixed r903 missing-original incident. No
// missing original is admitted and no alternate data-pair lease is granted.
const fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict');
const workerPolicy=require('./releaseWorkerPreflight.cjs');
const AUTH_ENTRY='deploy/light-server/manual-official-recovery-authorization.json',OLD_AUTH='deploy/light-server/worker-code-repair-authorization.json';
const VERSION='manual-official-preparation-authorization-v1',ENVELOPE='manual-official-preparation-observation-v1';
const BASE='3d2c8be0f468de1c3a5bdf9f975375ac4688d4c09b7b4ebe7dd0e4aba664d927';
const SCHEDULE_VERSION='official-schedule-preparation-authorization-v2',SCHEDULE_BASE='3ffad537a605bc5463031bd29819daee2ced39b66020c8745c4d65b636bb9e3d';
const DISPLAY_VERSION='official-analysis-display-preparation-authorization-v3',DISPLAY_BASE='e35a072fa0586d884606240fa517cd19f553210b8261ed9269d2c8cee7ebdd6c';
const FRESH_VERSION='official-publication-freshness-preparation-authorization-v4',FRESH_BASE='1966b7304fa907a4363fd8692c818bdb88f4e3281e8259f7d0df8b8fd3ffc137';
const FRESH_FILES=['scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs','scripts/recommendationPlatform/reviewedOfficialFreshness.cjs','scripts/researchBrokerWorker.cjs','scripts/researchReleaseBroker.cjs','scripts/researchSocketServer.py','server/researchBrokerClient.cjs','server/researchBrokerJournal.cjs','server/researchPublicationFreshnessRetry.cjs','server/researchWriteHttp.cjs','server/researchWriteService.cjs'];
const CURRENT={bytes:7758090,sha256:'b86ab357fc1d63a93eaf31e15066cd14ebc0c2e76cf70ec46f390e60f6d48b7a'};
const WAREHOUSE={bytes:1101391274,sha256:'3c9ef2ea5d9052fe6a7027d9d4db63cdd30e71a2fb08abe220b9b8601e10e1a4'};
const MESSAGE='PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING';
const PRELUDE={policy:'existing-nonfatal-cloudflare-fetch-failure-v1',command:'node scripts/syncCloudflareSportteryEvidence.cjs',executable:'/opt/node-v22.22.1/bin/node'};
const READER_ROOTS=['deploy/light-server/collector-trust-registry.json','package.json','scripts/nativeCodeReleaseDataPlane.cjs','scripts/releaseDataPlanePolicy.cjs','scripts/runSyncWorker.cjs','scripts/syncCloudflareSportteryEvidence.cjs','scripts/verifyNativeDeploymentCore.cjs','server/postgresStore.cjs','src/services/publicReferenceDecision.cjs'];
function hash(value){return require('node:crypto').createHash('sha256').update(value).digest('hex');}
function validate(auth,now){
 const a=require('node:assert/strict');
 a.deepEqual(Object.keys(auth).sort(),['baseRuntimeSha256','baselineClosure','createdAt','current','dataContract','expiresAt','files','gap','incident','optionalPreludePolicy','publication','reason','version','warehouse']);
 const fresh=auth.version===FRESH_VERSION,display=auth.version===DISPLAY_VERSION||fresh,schedule=auth.version===SCHEDULE_VERSION||display;
 if(fresh){a.equal(auth.reason,'restore-official-publication-freshness-preserving-r910-original-gap');a.equal(auth.baseRuntimeSha256,FRESH_BASE);}
 else if(display){a.equal(auth.reason,'restore-official-analysis-display-preserving-r909-original-gap');a.equal(auth.baseRuntimeSha256,DISPLAY_BASE);}
 else if(schedule){a.equal(auth.reason,'restore-signed-official-schedule-preserving-r906-original-gap');a.equal(auth.baseRuntimeSha256,SCHEDULE_BASE);}
 else{a.equal(auth.version,VERSION);a.equal(auth.reason,'install-independent-official-editorial-authority-preserving-r903-original-gap');a.equal(auth.baseRuntimeSha256,BASE);}
 a.equal(auth.optionalPreludePolicy,PRELUDE.policy);
 const start=Date.parse(auth.createdAt),end=Date.parse(auth.expiresAt);a(Number.isFinite(now)&&Number.isFinite(start)&&Number.isFinite(end)&&start<=now+5000&&now<end&&end>start&&end-start<=7200000,'authorization clock');
 a.deepEqual(auth.current,CURRENT);a.deepEqual(auth.warehouse,WAREHOUSE);a.equal(auth.gap.length,29);let previous='';
 for(const r of auth.gap){a.deepEqual(Object.keys(r).sort(),['recordHash','recordSha256','sourceMatchId']);a.match(r.sourceMatchId,/^[1-9]\d{0,19}$/);a(r.sourceMatchId>previous);previous=r.sourceMatchId;for(const k of ['recordHash','recordSha256'])a.match(r[k],/^[a-f0-9]{64}$/);}
 const i=auth.incident;a.deepEqual(Object.keys(i).sort(),['cycleFinishedAt','cycleStartedAt','journalMessageSha256','journalPid','journalTimestampUs','workerMainPid','workerStartedAt']);
 a.equal(i.workerMainPid,fresh?'623688':display?'485456':schedule?'397815':'2990491');a.equal(i.workerStartedAt,fresh?'2026-10-22T02:37:06.000Z':display?'2026-10-21T19:49:58.000Z':schedule?'2026-10-21T15:55:29.000Z':'2026-10-18T04:49:51.000Z');a.match(i.journalPid,/^[1-9]\d*$/);a.notEqual(i.journalPid,i.workerMainPid);a.match(i.journalTimestampUs,/^[1-9]\d{15}$/);a.equal(i.journalMessageSha256,hash(MESSAGE));
 for(const k of ['cycleStartedAt','cycleFinishedAt'])a.equal(new Date(i[k]).toISOString(),i[k]);
 a(Date.parse(i.cycleStartedAt)>=Date.parse(i.workerStartedAt)&&Date.parse(i.cycleFinishedAt)>=Date.parse(i.cycleStartedAt)&&Date.parse(i.cycleFinishedAt)<=start);
 const stamp=Number(i.journalTimestampUs)/1000;a(stamp>=Date.parse(i.cycleStartedAt)&&stamp<=Date.parse(i.cycleFinishedAt));
 for(const [list,changed]of [[auth.files,true],[auth.baselineClosure,false],[auth.dataContract,false]]){
  a(Array.isArray(list)&&list.length>0&&list.length<=256);let previous='';
  for(const r of list){a.deepEqual(Object.keys(r).sort(),changed?['afterSha256','beforeSha256','path']:['path','sha256']);a(typeof r.path==='string'&&(/^(?:scripts|server|src|deploy|services|collectors)\/[a-zA-Z0-9_./-]+$/.test(r.path)||(!changed&&r.path==='package.json'))&&!r.path.split('/').includes('..')&&r.path>previous,'source path closure bound: '+r.path);previous=r.path;
   if(changed){a(r.beforeSha256===null||/^[a-f0-9]{64}$/.test(r.beforeSha256));a.match(r.afterSha256,/^[a-f0-9]{64}$/);}else a.match(r.sha256,/^[a-f0-9]{64}$/);
  }
 }
 for(const name of ['scripts/manualOfficialReleaseRecovery.cjs','scripts/manualOfficialPublicCarryForward.cjs','scripts/recommendationPlatform/reviewedOfficialEvent.cjs','server/researchOfficialEventRead.cjs'])a(auth.files.some(r=>r.path===name));
 if(schedule)for(const name of ['server/officialScheduleRead.cjs','server/officialScheduleHttp.cjs','src/services/officialSchedule.cjs','src/hooks/useOfficialSchedule.ts','src/components/recommendations/OfficialSchedule.tsx','src/pages/PredictionsList.tsx'])a(auth.files.some(r=>r.path===name),'schedule source closure required');
 if(display)for(const name of ['src/components/recommendations/OfficialSchedule.css','src/components/recommendations/OfficialEditorialReferences.tsx','src/pages/BestTips.tsx'])a(auth.files.some(r=>r.path===name),'analysis display source closure required');
 if(fresh)for(const name of FRESH_FILES)a(auth.files.some(r=>r.path===name),'publication freshness source closure required');
 for(const name of READER_ROOTS)a(auth.baselineClosure.some(r=>r.path===name));
 a.deepEqual(Object.keys(auth.publication).sort(),['committedAt','databaseOid','generationId','manifestHash','mode','sourceCycleId']);
 a.equal(auth.publication.databaseOid,'28598409');a.equal(auth.publication.mode,'active-generation');a.match(auth.publication.manifestHash,/^[a-f0-9]{64}$/);a.equal(auth.publication.generationId,'g-'+auth.publication.manifestHash);a.equal(new Date(auth.publication.committedAt).toISOString(),auth.publication.committedAt);a(typeof auth.publication.sourceCycleId==='string'&&auth.publication.sourceCycleId.length>0&&auth.publication.sourceCycleId.length<=256);
 return auth;
}
function preludeFrame(journal,worker,target){
 const a=require('node:assert/strict'),rows=new Set(),found=[],cycle=worker.status.lastCycle;
 for(let index=0;index<journal.length;index++){
  const row=journal[index];if(row.message!=='  "ok": false,'||row.command!==PRELUDE.command)continue;
  const group=journal.slice(index-1,index+4);a.equal(group.length,5);a.equal(group[0].message,'{');a.equal(group[4].message,'}');
  for(const r of group)for(const key of ['unit','pid','timestampUs','command','executable'])a.equal(r[key],row[key]);
  a.equal(row.unit,'football-sync-worker.service');a.equal(row.executable,PRELUDE.executable);a.match(row.pid,/^[1-9]\d*$/);a.notEqual(row.pid,worker.serviceAfter.MainPID);a.notEqual(row.pid,target.pid);
  const text=group.map(r=>r.message).join('\n'),value=JSON.parse(text);
  a.deepEqual(Object.keys(value).sort(),['checkedAt','error','ok']);a.equal(value.ok,false);a.equal(value.error,'fetch failed');a.equal(new Date(value.checkedAt).toISOString(),value.checkedAt);a.equal(JSON.stringify(value,null,2),text);
  const clock=Date.parse(value.checkedAt),stamp=Number(row.timestampUs)/1000;a(Number.isFinite(stamp)&&clock>=Date.parse(cycle.startedAt)&&clock<=stamp&&stamp-clock<=1000&&stamp<=Date.parse(cycle.finishedAt)&&BigInt(row.timestampUs)<BigInt(target.timestampUs));
  found.push({pid:row.pid,journalTimestampUs:row.timestampUs,command:row.command,executable:row.executable,checkedAt:value.checkedAt,ok:false,error:value.error,frameSha256:hash(text),fatal:false});
  group.forEach(r=>rows.add(r));
 }
 a(found.length<=1,'multiple optional failure frames');return {rows,actualPrelude:found};
}
function assertCycle(auth,worker,journal){
 const a=require('node:assert/strict'),i=auth.incident,c=worker.status.lastCycle,now=Date.parse(worker.checkedAt);
 a.equal(worker.processMatches,true);a.equal(worker.serviceBefore.MainPID,i.workerMainPid);a.equal(worker.serviceAfter.MainPID,i.workerMainPid);
 for(const s of [worker.serviceBefore,worker.serviceAfter]){a.equal(s.ActiveState,'active');a.equal(new Date(s.ExecMainStartTimestamp).toISOString(),i.workerStartedAt);}
 a.equal(c.ok,false);a.notEqual(c.skipped,true);a.equal(c.phase,'official-result-failed');a.equal(c.errorCode,'SYNC_WORKER_COMMAND_FAILED');a.equal(c.error,'node scripts/syncData.cjs exited with 1');
 const begin=Date.parse(c.startedAt),end=Date.parse(c.finishedAt);a(Number.isFinite(begin)&&Number.isFinite(end)&&begin<=end&&end<=now&&now-end<=3600000);
 const exact=c.startedAt===i.cycleStartedAt&&c.finishedAt===i.cycleFinishedAt;
 a(exact||(begin>=Date.parse(i.cycleFinishedAt)&&end>Date.parse(i.cycleFinishedAt)),'repeated incident overlaps or regresses');
 a(Array.isArray(journal)&&journal.length>0&&journal.length<2000,'full cycle journal unavailable or truncated');
 const targets=journal.filter(r=>r.pid!==i.workerMainPid&&r.message===MESSAGE);a.equal(targets.length,1);
 const row=targets[0];a.match(row.pid,/^[1-9]\d*$/);a.match(row.timestampUs,/^[1-9]\d{15}$/);a.equal(row.unit,'football-sync-worker.service');
 a(['node scripts/syncData.cjs','/opt/node-v22.22.1/bin/node scripts/syncData.cjs'].includes(row.command));a.equal(row.executable,PRELUDE.executable);
 const stamp=Number(row.timestampUs)/1000;a(stamp>=begin&&stamp<=end);
 if(exact){a.equal(row.pid,i.journalPid);a.equal(row.timestampUs,i.journalTimestampUs);}else a(BigInt(row.timestampUs)>BigInt(i.journalTimestampUs));
 const phase=worker.status.pipeline?.find(s=>s.id==='official-result-fast');a.equal(phase?.fatal,false);a(phase.operations.includes('sync:cloudflare-sporttery-evidence'));
 const prelude=preludeFrame(journal,worker,row);
 for(const r of journal){a.equal(r.unit,'football-sync-worker.service');a(Number(r.timestampUs)/1000>=begin&&Number(r.timestampUs)/1000<=end);
  a(!/password|TOKEN|SECRET|DATABASE_URL|postgres(?:ql)?:\/\/|Bearer/i.test(r.message),'excluded sensitive journal material');
  if(r.pid!==i.workerMainPid&&r!==row&&!prelude.rows.has(r))a(!/(?:\bERROR\b|\bFATAL\b|\bError:|Unhandled|PUBLIC_REFERENCE_|"ok"\s*:\s*false\b|"error"\s*:)/.test(r.message),'additional child failure');
 }
 return {cycleStartedAt:c.startedAt,cycleFinishedAt:c.finishedAt,journalPid:row.pid,journalTimestampUs:row.timestampUs,journalMessageSha256:hash(row.message),workerMainPid:i.workerMainPid,workerStartedAt:i.workerStartedAt,actualPrelude:prelude.actualPrelude};
}
function evaluate(auth,worker,observed){
 const a=require('node:assert/strict'),report=evaluateWorkerPreflight(worker);
 const result={version:ENVELOPE,checkedAt:worker.checkedAt,preparationAllowed:false,workerReport:report,workerHealthy:report.ok,readyToCutover:false,productionWrites:0,blockers:[]};
 let stage='authorization';
 try{
  validate(auth,Date.parse(worker.checkedAt));a.equal(report.ok,false,'healthy worker uses ordinary route');
  validate(auth,Date.parse(observed.completedAt));
  a(Date.parse(observed.completedAt)>=Date.parse(worker.checkedAt)&&Date.parse(observed.completedAt)-Date.parse(worker.checkedAt)<=60000,'observation completion clock');
  stage='original-worker-report';
  a.deepEqual([...report.blockers].sort(),['worker-latest-official-cycle-failed','worker-official-recovery-unproven'].filter(k=>report.blockers.includes(k)).sort());
  a(report.blockers.includes('worker-official-recovery-unproven'));a(report.statusAgeSeconds<=300);
  stage='runtime-identity';
  a.equal(observed.runtimeSha256,auth.baseRuntimeSha256);a.equal(observed.completeSha256,auth.baseRuntimeSha256);a.equal(observed.recoveryPending,false);a.equal(observed.oldAuthorizationPresent,false);
  stage='source-closure-and-data-contract';
  a.deepEqual(observed.files,auth.files.map(r=>({path:r.path,sha256:r.beforeSha256})));a.deepEqual(observed.baselineClosure,auth.baselineClosure);a.deepEqual(observed.dataContract,auth.dataContract);
  stage='originals-and-ordinary-publication';
  a.deepEqual(observed.current,CURRENT);a.deepEqual(observed.warehouse,WAREHOUSE);a.deepEqual(observed.gap,auth.gap);a.deepEqual(observed.publication,auth.publication);a.equal(observed.indexMatches,0);
  a.equal(observed.globalArchiveAccepted,true);a.equal(observed.servingHealthAccepted,true);a.equal(observed.ordinaryPointerAffinity,true);
  stage='actual-full-cycle-journal';
  result.actualIncident=assertCycle(auth,worker,observed.journal);result.preparationAllowed=true;
 }catch{result.blockers.push('manual-official-preparation-binding-rejected');result.failureStage=stage;}
 return result;
}
function collect(auth,worker){
 const fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict'),cp=require('node:child_process');
 const {Buffer}=require('node:buffer');
 const root='/opt/football-predict';a.equal(fs.realpathSync(root),root);
 const present=file=>{try{fs.lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
 let streamIdentity=null;
 function plain(relative,max=4*1024*1024,stream=false){
  const file=path.join(root,relative);let directory=path.dirname(file);while(directory!==root){const s=fs.lstatSync(directory);a(s.isDirectory()&&!s.isSymbolicLink());const parent=path.dirname(directory);a.notEqual(parent,directory);directory=parent;}
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(fd);a(before.isFile()&&before.size<=max);let value;
   if(stream){const digest=require('node:crypto').createHash('sha256'),buffer=Buffer.alloc(1024*1024);let bytes=0,n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){digest.update(buffer.subarray(0,n));bytes+=n;}a.equal(bytes,before.size);value={bytes,sha256:digest.digest('hex')};}
   else value=fs.readFileSync(fd);
   const after=fs.fstatSync(fd),named=fs.lstatSync(file);for(const k of ['dev','ino','size','mtimeMs','ctimeMs'])a.equal(before[k],after[k]);a.equal(named.dev,before.dev);a.equal(named.ino,before.ino);a(!named.isSymbolicLink());if(stream)streamIdentity=Object.fromEntries(['dev','ino','size','mtimeMs','ctimeMs'].map(k=>[k,before[k]]));return value;
  }finally{fs.closeSync(fd);}
 }
 const identity=()=>({runtimeSha256:plain('.release-bundle-sha256',128).toString().trim(),completeSha256:plain('.release-live-complete',128).toString().trim(),
  recoveryPending:present('/var/lib/football-release/recovery/current')||present('/var/lib/football-release/reference-repairs/current'),oldAuthorizationPresent:present(path.join(root,OLD_AUTH))});
 const before=identity(),files=auth.files.map(r=>({path:r.path,sha256:present(path.join(root,r.path))?hash(plain(r.path)):null}));
 const closure=new Map();function visit(relative){if(closure.has(relative))return;const bytes=plain(relative);closure.set(relative,hash(bytes));for(const m of bytes.toString().matchAll(/require\(['"](\.[^'"]+)['"]\)/g)){const file=require.resolve(path.resolve(root,path.dirname(relative),m[1]));a(file.startsWith(root+path.sep));visit(path.relative(root,file).split(path.sep).join('/'));}}
 for(const name of READER_ROOTS)visit(name);const baselineClosure=[...closure].map(([path,sha256])=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:1);
 // Pins precede execution of any installed policy/decision/authority module.
 a.deepEqual(files,auth.files.map(r=>({path:r.path,sha256:r.beforeSha256})));
 a.deepEqual(baselineClosure,auth.baselineClosure);
 const packageScripts=JSON.parse(plain('package.json')).scripts;a.equal(packageScripts['sync:cloudflare-sporttery-evidence'],PRELUDE.command);a.equal(packageScripts['sync:data'],'node scripts/syncData.cjs');
 const dataContract=JSON.parse(JSON.stringify(require(root+'/scripts/releaseDataPlanePolicy.cjs').capture(root).entries));
 const currentBytes=plain('public/data/matches-current.json',8388608),current={bytes:currentBytes.length,sha256:hash(currentBytes)},matches=JSON.parse(currentBytes);a(Array.isArray(matches)&&matches.length<=512);
 const gap=matches.filter(m=>m.predictionMeta?.publicReferenceDecision).map(m=>{const r=m.predictionMeta.publicReferenceDecision;a(require(root+'/src/services/publicReferenceDecision.cjs').attestPublicReferenceDecision(r,m));a.equal(r.version,'public-reference-decision-v2');a(r.evidenceBinding);return {sourceMatchId:String(m.sourceMatchId),recordHash:r.contentHash,recordSha256:hash(JSON.stringify(r))};}).sort((a,b)=>a.sourceMatchId<b.sourceMatchId?-1:1);
 const warehouse=plain('public/data/prediction-snapshots.json',2147483648,true);
 const c=worker.status.lastCycle,output=cp.execFileSync('/usr/bin/journalctl',['--unit=football-sync-worker.service','--since='+c.startedAt,'--until='+c.finishedAt,'--lines=2000','--output=json','--no-pager'],{encoding:'utf8',timeout:8000,maxBuffer:8*1024*1024});
 const journal=output.trim()?output.trim().split('\n').map(line=>{const r=JSON.parse(line);return {unit:r._SYSTEMD_UNIT,pid:r._PID,timestampUs:r.__REALTIME_TIMESTAMP,message:r.MESSAGE,command:r._CMDLINE||null,executable:r._EXE||null};}):[];
 a(journal.every(r=>typeof r.message==='string'&&!/password|TOKEN|SECRET|DATABASE_URL|postgres(?:ql)?:\/\/|Bearer/i.test(r.message)),'excluded sensitive journal material');
 const child="('use strict');const a=require('node:assert/strict'),fs=require('node:fs'),root='/opt/football-predict',pool=new(require(root+'/node_modules/pg').Pool)({host:'/var/run/postgresql',user:'football',database:'football',max:1,connectionTimeoutMillis:5000});(async()=>{const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query('SET LOCAL statement_timeout=8000');await c.query('SET LOCAL lock_timeout=2000');const id=(await c.query(\"SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_setting('transaction_read_only') AS readonly\")).rows[0];a.equal(id.oid,'28598409');a.equal(id.readonly,'on');const meta=Object.fromEntries((await c.query('SELECT key,value FROM football.projection_meta WHERE key=ANY($1::text[])',[['data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at']])).rows.map(r=>[r.key,r.value]));const publication={databaseOid:id.oid,mode:meta.data_publication_mode,generationId:meta.data_generation_id,manifestHash:meta.manifest_hash,sourceCycleId:meta.data_generation_source_cycle_id,committedAt:meta.committed_at};const ptr=JSON.parse(fs.readFileSync('/var/lib/football-predict/data-generations/current.json'));const ordinaryPointerAffinity=['generationId','manifestHash','sourceCycleId','committedAt'].every(k=>ptr[k]===publication[k]);a(ordinaryPointerAffinity);const rows=(await c.query(\"SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513\")).rows.map(r=>r.payload);a(rows.length<=512&&Buffer.byteLength(JSON.stringify(rows))<=8388608);await require(root+'/scripts/nativeCodeReleaseDataPlane.cjs').readCodeCutoverArchiveAuthority(c,rows,Date.now());const indexMatches=(await c.query('SELECT id FROM football.source_snapshots WHERE id=ANY($1::text[])',["+JSON.stringify(gap.map(r=>'public-reference-index:row:'+r.recordHash))+"])).rows.length;a.equal(indexMatches,0);await c.query('ROLLBACK');const response=await fetch('http://127.0.0.1:8788/api/v1/health',{signal:AbortSignal.timeout(15000)});a.equal(response.status,200);require(root+'/scripts/verifyNativeDeploymentCore.cjs').requireHealth(await response.json());console.log(JSON.stringify({publication,ordinaryPointerAffinity,indexMatches,globalArchiveAccepted:true,servingHealthAccepted:true}));}finally{c.release();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1}).finally(()=>pool.end());";
 const result=cp.spawnSync('/usr/sbin/runuser',['-u','football','--','/opt/node-v22.22.1/bin/node','-'],{input:child,encoding:'utf8',timeout:35000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH:root+'/deploy/light-server/collector-trust-registry.json'}});a.equal(result.status,0,'ordinary publication/global archive/serving gates rejected');
 const gate=JSON.parse(result.stdout);a.deepEqual(identity(),before);a.equal(hash(plain('public/data/matches-current.json',8388608)),current.sha256);
 a.deepEqual(auth.files.map(r=>({path:r.path,sha256:present(path.join(root,r.path))?hash(plain(r.path)):null})),files,'source changed during observation');
 a.deepEqual(baselineClosure.map(r=>({path:r.path,sha256:hash(plain(r.path))})),baselineClosure,'reader closure changed during observation');
 const finalWarehouse=fs.lstatSync(root+'/public/data/prediction-snapshots.json');a(!finalWarehouse.isSymbolicLink());a.deepEqual(Object.fromEntries(['dev','ino','size','mtimeMs','ctimeMs'].map(k=>[k,finalWarehouse[k]])),streamIdentity,'warehouse identity changed after hash');
 const after=collectWorkerPreflight();a.deepEqual(after.serviceBefore,worker.serviceAfter);a.deepEqual(after.serviceAfter,worker.serviceAfter);a.equal(after.processMatches,true);a.deepEqual(after.status.lastCycle,worker.status.lastCycle);
 return {...before,files,baselineClosure,dataContract,current,gap,warehouse,warehouseIdentity:streamIdentity,journal,...gate,completedAt:after.checkedAt};
}
function candidateAuthorization(root,auth){
 validate(auth,Date.now());a.equal(fs.existsSync(path.join(root,OLD_AUTH)),false,'old and manual authorization conflict');
 for(const r of auth.files)a.equal(hash(fs.readFileSync(path.join(root,r.path))),r.afterSha256,'candidate source differs');
 a.deepEqual(require('./releaseDataPlanePolicy.cjs').capture(root).entries,auth.dataContract,'manual preparation requires unchanged data contract');return auth;
}
function buildProbe(auth){
 validate(auth,Date.now());const source="'use strict';\nconst AUTH_ENTRY="+JSON.stringify(AUTH_ENTRY)+',OLD_AUTH='+JSON.stringify(OLD_AUTH)+',VERSION='+JSON.stringify(VERSION)+',ENVELOPE='+JSON.stringify(ENVELOPE)+',BASE='+JSON.stringify(BASE)+',SCHEDULE_VERSION='+JSON.stringify(SCHEDULE_VERSION)+',SCHEDULE_BASE='+JSON.stringify(SCHEDULE_BASE)+',DISPLAY_VERSION='+JSON.stringify(DISPLAY_VERSION)+',DISPLAY_BASE='+JSON.stringify(DISPLAY_BASE)+',FRESH_VERSION='+JSON.stringify(FRESH_VERSION)+',FRESH_BASE='+JSON.stringify(FRESH_BASE)+',FRESH_FILES='+JSON.stringify(FRESH_FILES)+',CURRENT='+JSON.stringify(CURRENT)+',WAREHOUSE='+JSON.stringify(WAREHOUSE)+',MESSAGE='+JSON.stringify(MESSAGE)+',PRELUDE='+JSON.stringify(PRELUDE)+',READER_ROOTS='+JSON.stringify(READER_ROOTS)+';\n'
  +[workerPolicy.evaluateWorkerPreflight,workerPolicy.collectWorkerPreflight,hash,validate,preludeFrame,assertCycle,evaluate,collect].map(fn=>fn.toString()).join('\n')
  +'\ntry{const auth='+JSON.stringify(auth)+';const worker=collectWorkerPreflight(),base=evaluateWorkerPreflight(worker);if(base.ok){console.log(JSON.stringify(base));}else{const report=evaluate(auth,worker,collect(auth,worker));console.log(JSON.stringify(report));if(!report.preparationAllowed)process.exitCode=1;}}catch{console.log(JSON.stringify({version:ENVELOPE,preparationAllowed:false,workerHealthy:false,readyToCutover:false,productionWrites:0,blockers:[\'manual-official-preparation-observation-unavailable\']}));process.exitCode=1;}';
 a(Buffer.byteLength(source)<120000,'fixed SSH probe bound');return source;
}
const {evaluateWorkerPreflight,collectWorkerPreflight}=workerPolicy;
module.exports={AUTH_ENTRY,OLD_AUTH,VERSION,ENVELOPE,BASE,SCHEDULE_VERSION,SCHEDULE_BASE,DISPLAY_VERSION,DISPLAY_BASE,FRESH_VERSION,FRESH_BASE,FRESH_FILES,CURRENT,WAREHOUSE,MESSAGE,PRELUDE,READER_ROOTS,hash,validate,preludeFrame,assertCycle,evaluate,collect,candidateAuthorization,buildProbe};
if(require.main===module){
 try{a.equal(process.argv.length,3);const root=path.resolve(process.argv[2]),file=path.join(root,AUTH_ENTRY);if(!fs.existsSync(file))throw Error('explicit manual authorization required');const st=fs.lstatSync(file);a(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=65536);const auth=candidateAuthorization(root,JSON.parse(fs.readFileSync(file)));new(require('node:vm').Script)(buildProbe(auth)).runInNewContext({require,process,console,Date});}
 catch{console.log(JSON.stringify({version:ENVELOPE,preparationAllowed:false,readyToCutover:false,productionWrites:0,blockers:['manual-official-preparation-entry-rejected']}));process.exitCode=1;}
}
