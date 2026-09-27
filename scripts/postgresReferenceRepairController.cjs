'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const policy=require('./postgresReferenceRepairPolicy.cjs');
const APP='/opt/football-predict',STORE='/var/lib/football-predict',ROOT='/var/lib/football-release/reference-repairs',NODE='/opt/node-v22.22.1/bin/node';
const UNITS=Object.freeze(['football-cleanup.timer','football-monitor.timer','football-daily-prematch.timer','football-featured-combo.timer','football-postgres-backup.timer','football-cleanup.service','football-monitor.service','football-daily-prematch.service','football-postgres-backup.service','football-postgres-cos-upload.service','football-market-collector.service','football-featured-combo.service','football-recommendation-settlement.service','football-sync-worker.service','football-predict.service']);
const run=(command,args,options={})=>cp.execFileSync(command,args,{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C',TZ:'UTC',PGHOST:'/var/run/postgresql'},...options});
const digest=file=>run('/usr/bin/sha256sum',['--',file]).split(' ')[0];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const objectHash=v=>policy.hash(JSON.stringify(stable(v)));
function regular(file){const s=fs.lstatSync(file);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'unsafe repair file');return s;}
function save(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
function replace(file,bytes,st){const temporary=file+'.reference-repair-'+process.pid;const fd=fs.openSync(temporary,'wx',st.mode&0o777);try{fs.writeFileSync(fd,bytes);fs.fchownSync(fd,st.uid,st.gid);fs.fchmodSync(fd,st.mode&0o777);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
function topology(){return JSON.parse(run('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-t','-A','--set=ON_ERROR_STOP=1','--dbname=football','-c',"BEGIN READ ONLY; SELECT json_build_object('database',current_database(),'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system())); ROLLBACK;"],{timeout:10000}));}
function pgPool(identity,database='football',oid=identity.oid){const {NativeReleasePostgresPool}=require(APP+'/scripts/nativeReleasePostgresTransport.cjs');return new NativeReleasePostgresPool({database,databaseOid:oid,clusterId:identity.systemIdentifier});}
function captureReferenceObjects(context){
 const {streamJsonObjectArrays}=require(APP+'/server/streamedJsonObjectArrays.cjs');
 const {attestPublicReferenceDecision}=require(APP+'/src/services/publicReferenceDecision.cjs');
 const {verifyPublicReferenceEvidence}=require(APP+'/src/services/publicReferenceEvidence.cjs');
 const entry=context.manifest.files.find(x=>x.path==='prediction-snapshots.json');assert.ok(entry);
 const records=new Map(),publicDecisions=[],publicEvidence=[];let retainedChars=0;
 const pass=(keys,onItem)=>streamJsonObjectArrays(path.join(context.generationDir,entry.path),{keys,allowNonArrays:true,expectedBytes:entry.bytes,expectedSha256:entry.sha256,onItem});
 pass(['publicReferenceDecisions'],(_,row)=>{retainedChars+=JSON.stringify(row).length;assert.ok(attestPublicReferenceDecision(row,row));assert.ok(!records.has(row.contentHash));records.set(row.contentHash,row);publicDecisions.push({id:row.contentHash,hash:objectHash(row)});assert.ok(records.size<=100000);});
 const seen=new Set();pass(['publicReferenceEvidence'],(_,row)=>{retainedChars+=JSON.stringify(row).length;assert.ok(!seen.has(row.referenceHash));seen.add(row.referenceHash);assert.ok(verifyPublicReferenceEvidence(row,records.get(row.referenceHash)));publicEvidence.push({id:row.referenceHash,hash:objectHash(row)});});
 assert.equal(publicEvidence.length,publicDecisions.filter(x=>records.get(x.id).evidenceBinding).length);
 return{snapshot:{bytes:entry.bytes,sha256:entry.sha256,retainedChars,admissionLimitChars:320*1024*1024},publicDecisions:publicDecisions.sort((a,b)=>a.id.localeCompare(b.id)),publicEvidence:publicEvidence.sort((a,b)=>a.id.localeCompare(b.id))};
}
async function captureFrozen(context,identity){
 const refs=captureReferenceObjects(context),store=require(APP+'/server/dataGenerationStore.cjs'),archives=new Map();
 for(const name of ['matches-current.json','matches-history.json']){const value=store.readGenerationFile(context,name,{parseJson:true});for(const row of Array.isArray(value)?value:value.matches||[]){if(!row.archivedPreMatchPrediction)continue;const id=JSON.stringify([row.sourceMatchId,row.eventVersion||null,row.kickoffTime]),hash=objectHash(row.archivedPreMatchPrediction);assert.ok(!archives.has(id)||archives.get(id)===hash,'conflicting frozen archive');archives.set(id,hash);}}
 const pool=pgPool(identity);let client;try{client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const publication=await require(APP+'/scripts/nativeReleaseDatabaseSession.cjs').publication(client);
  const {protectedFrozenRecommendationHash}=require(APP+'/scripts/nativeReleaseDataPlane.cjs');
  const rows=(await client.query('SELECT decision_id,to_jsonb(f)::text AS record FROM football.frozen_recommendations f ORDER BY decision_id COLLATE "C"')).rows;assert.ok(rows.length>=198&&rows.length<=100000);
  const recommendations=rows.map(r=>({id:r.decision_id,hash:protectedFrozenRecommendationHash(r.record)}));
  return{...refs,publication,recommendations,archives:[...archives].map(([id,hash])=>({id,hash})).sort((a,b)=>a.id.localeCompare(b.id))};
 }finally{if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}await pool.end();}
}
function currentWindow(){const w=require(APP+'/scripts/runReleaseWindowPreflight.cjs');const report=w.evaluateReleaseWindowObservation(w.collectReleaseWindowObservation(),Date.now(),{stage:'before-upload',nativeFullRelease:true});assert.equal(report.ok,true,'repair release window closed');return report;}
function unitStates(){return Object.fromEntries(UNITS.map(u=>{const x=Object.fromEntries(run('/usr/bin/systemctl',['show',u,'--property=LoadState,ActiveState,MainPID','--no-pager']).trim().split('\n').map(s=>s.split('=')));return[u,x];}));}
function restoreUnits(states){for(const [unit,s]of Object.entries(states).reverse())if(s.ActiveState==='active')run('/usr/bin/systemctl',['start',unit],{timeout:120000});const actual=unitStates();for(const [unit,s]of Object.entries(states))if(s.ActiveState==='active')assert.equal(actual[unit].ActiveState,'active','original service not restored: '+unit);}
function stopUnits(states){for(const [unit,s]of Object.entries(states))if(s.LoadState!=='not-found')run('/usr/bin/systemctl',['stop',unit],{timeout:120000});for(const [unit,s]of Object.entries(unitStates()))if(s.LoadState!=='not-found')assert.ok(['inactive','failed'].includes(s.ActiveState)&&Number(s.MainPID)===0,'writer not drained: '+unit);}
function boundFaultLogs(rows,{pid,invocationId,startedAt,finishedAt,errorCode='POSTGRES_REFERENCE_ADMISSION_LIMIT'}){
 const start=Date.parse(startedAt),finish=Date.parse(finishedAt);assert.ok(Number.isFinite(start)&&Number.isFinite(finish)&&finish>=start);assert.match(invocationId||'',/^[a-f0-9]{32}$/);
 const pattern={POSTGRES_REFERENCE_ADMISSION_LIMIT:/"code"\s*:\s*"POSTGRES_REFERENCE_ADMISSION_LIMIT"/,PUBLICATION_SQLITE_IDENTITY_MISMATCH:/^SQLite publication identity matches neither the serving generation nor its immutable previous generation$/}[errorCode];assert.ok(pattern,'unsupported repair fault');
 const matches=rows.filter(r=>{const at=Number(r.__REALTIME_TIMESTAMP)/1000;return r._SYSTEMD_UNIT==='football-sync-worker.service'&&r._SYSTEMD_INVOCATION_ID===invocationId&&Number.isFinite(at)&&at>=start&&at<=finish&&pattern.test(String(r.MESSAGE||''));});
 assert.ok(matches.length>0,'native admission error not bound to this Worker invocation and failed cycle');
 return{source:'journald',errorCode,workerPid:pid,invocationId,cycleStartedAt:startedAt,cycleFinishedAt:finishedAt,entries:matches.map(r=>({pid:Number(r._PID),at:new Date(Number(r.__REALTIME_TIMESTAMP)/1000).toISOString(),messageSha256:policy.hash(String(r.MESSAGE))}))};
}
function faultObservation(incident){
 const {collectWorkerPreflight}=require(APP+'/scripts/releaseWorkerPreflight.cjs'),x=collectWorkerPreflight(),s=x.status;
 assert.equal(x.serviceBefore.ActiveState,'active');assert.equal(x.serviceAfter.ActiveState,'active');assert.equal(x.processMatches,true);
 assert.equal(s.pid,Number(x.serviceAfter.MainPID));assert.equal(x.serviceBefore.MainPID,x.serviceAfter.MainPID);
 assert.equal(s.lastCycle?.ok,false);assert.equal(s.lastCycle?.phase,'official-result-failed');
 const invocationId=run('/usr/bin/systemctl',['show','football-sync-worker.service','--property=InvocationID','--value']).trim();
 const logs=run('/usr/bin/journalctl',['-u','football-sync-worker.service','--since',s.lastCycle.startedAt,'--until',s.lastCycle.finishedAt,'-n','3000','-o','json','--no-pager'],{maxBuffer:8*1024*1024}).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
 const binding={pid:s.pid,invocationId,startedAt:s.lastCycle.startedAt,finishedAt:s.lastCycle.finishedAt};let mode='admission-failure',evidence,admissionEvidence;
 if(s.lastError?.command==='npm'&&JSON.stringify(s.lastError.args)==='["run","postgres:sync"]')evidence=boundFaultLogs(logs,binding);
 else{
  assert.equal(s.lastError?.command,'node');assert.deepEqual(s.lastError.args,['scripts/syncData.cjs']);mode='publication-lag-after-admission';
  evidence=boundFaultLogs(logs,{...binding,errorCode:'PUBLICATION_SQLITE_IDENTITY_MISMATCH'});
  assert.ok(incident.snapshot.retainedChars>incident.snapshot.admissionLimitChars);assert.ok(![incident.generation.generationId,incident.previousGeneration.generationId].includes(incident.postgres.publication.generationId));assert.ok(Date.parse(incident.postgres.publication.committedAt)<Date.parse(incident.previousGeneration.committedAt));
  const prior=run('/usr/bin/journalctl',['-u','football-sync-worker.service','--since',incident.generation.committedAt,'--until',s.lastCycle.startedAt,'--grep=POSTGRES_REFERENCE_ADMISSION_LIMIT','-n','8','-o','json','--no-pager']).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
  admissionEvidence=boundFaultLogs(prior,{...binding,startedAt:incident.generation.committedAt,finishedAt:s.lastCycle.startedAt});
 }
 assert.ok(Date.parse(s.checkedAt)>=Date.parse(String(x.serviceAfter.ExecMainStartTimestamp).replace(/\bCST$/,'+0800')));
 return{pid:s.pid,mode,faultCode:'POSTGRES_REFERENCE_ADMISSION_LIMIT',statusCheckedAt:s.checkedAt,lastCycleStartedAt:s.lastCycle.startedAt,lastCycleFinishedAt:s.lastCycle.finishedAt,evidence,...(admissionEvidence?{admissionEvidence}:{})};
}
async function observe({requireFault=true,requireWindow=true}={}){
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
 const runtime=fs.readFileSync(APP+'/.release-bundle-sha256','utf8').trim(),complete=fs.readFileSync(APP+'/.release-live-complete','utf8').trim();assert.equal(runtime,policy.BASE_RUNTIME);assert.equal(complete,runtime);
 assert.equal(fs.existsSync('/var/lib/football-release/recovery/current'),false,'ordinary release recovery pending');
 const env=fs.readFileSync('/etc/football-predict/env','utf8');for(const [name,value]of Object.entries(require(APP+'/scripts/nativeReleaseJournal.cjs').NATIVE_SELECTORS))assert.match(env,new RegExp('^'+name+'='+value+'\\s*$','m'),'native selector changed: '+name);
 const store=require(APP+'/server/dataGenerationStore.cjs'),context=store.resolveCurrentGeneration({storeDir:STORE}),previousGeneration=store.resolvePreviousGeneration({storeDir:STORE}).pointer,postgres=topology();
 const objects=await captureFrozen(context,postgres);assert.deepEqual(store.resolveCurrentGeneration({storeDir:STORE}).pointer,context.pointer,'generation changed during observation');
 const archiveApi=require(APP+'/scripts/releaseArchivePreflight.cjs'),manifest=read(require(APP+'/scripts/frozenArchiveRestoration.cjs').DEFAULT_PATH),archive=archiveApi.evaluateArchivePreflight(archiveApi.collectArchiveObservation(manifest.baseline.records.map(r=>r.sourceMatchId)),manifest);
 assert.equal(archive.ok,true);const worker=requireFault?faultObservation({generation:context.pointer,previousGeneration,postgres:{...postgres,publication:objects.publication},snapshot:objects.snapshot}):null,window=requireWindow?currentWindow():null;
 const files=policy.FILES.map(file=>({path:file,sha256:fs.existsSync(APP+'/'+file)?digest(APP+'/'+file):null}));
 regular(policy.ENTRYPOINT);const entryBytes=fs.readFileSync(policy.ENTRYPOINT);
 return{checkedAt:new Date().toISOString(),runtime,complete,generation:context.pointer,previousGeneration,snapshot:objects.snapshot,postgres:{...postgres,publication:objects.publication},frontendStateSha256:digest('/var/lib/football-release/frontend-state.json'),entrypoint:{path:policy.ENTRYPOINT,sha256:policy.hash(entryBytes),base64:entryBytes.toString('base64')},faultCode:requireFault?'POSTGRES_REFERENCE_ADMISSION_LIMIT':null,worker,window,archive:{...archive,baselineRows:manifest.baseline.records.length},files,frozen:{rootHash:objectHash(objects.recommendations),count:objects.recommendations.length,publicDecisionsRoot:objectHash(objects.publicDecisions),publicDecisionCount:objects.publicDecisions.length,publicEvidenceRoot:objectHash(objects.publicEvidence),publicEvidenceCount:objects.publicEvidence.length},frozenRecords:{recommendations:objects.recommendations,publicDecisions:objects.publicDecisions,publicEvidence:objects.publicEvidence,archives:objects.archives},productionWrites:0};
}
async function backupBudget(){const inputBytes=Object.fromEntries([[APP,'app'],[STORE,'store'],['/etc/football-predict','config']].map(([file,key])=>[key,Number(run('/usr/bin/du',['-sb','--',file]).split(/\s/)[0])]));assert.ok(Object.values(inputBytes).every(Number.isSafeInteger));
 const identity=topology(),pool=pgPool(identity);let databaseBytes;try{databaseBytes=Number((await pool.query("SELECT pg_database_size(current_database())::text AS bytes")).rows[0].bytes);}finally{await pool.end();}
 const context=require(APP+'/server/dataGenerationStore.cjs').resolveCurrentGeneration({storeDir:STORE}),generationBytes=context.manifest.files.reduce((n,f)=>n+f.bytes,0),snapshotBytes=context.manifest.files.find(f=>f.path==='prediction-snapshots.json').bytes;
 const components={fullFileBackup:Object.values(inputBytes).reduce((a,b)=>a+b,0),candidateApplication:inputBytes.app,postgresDumpUpperBudget:databaseBytes,candidatePostgres:databaseBytes,proofGeneration:generationBytes,streamScratch:3*snapshotBytes,walAndHostReserve:4*1024**3};const requiredBytes=Object.values(components).reduce((a,b)=>a+b,0),stat=fs.statfsSync('/var/lib/football-release'),availableBytes=stat.bavail*stat.bsize;
 return{ok:availableBytes>=requiredBytes,requiredBytes,availableBytes,components,scope:'pre-pause reserve; full file backup, complete dump, independent database, copied generation, scratch and WAL/headroom'};}
function assertSameInput(expected,actual){for(const key of ['runtime','complete','generation','previousGeneration','snapshot','postgres','frontendStateSha256','files','frozen','frozenRecords'])assert.deepEqual(actual[key],expected[key],'signed repair input changed: '+key);}
function load(dir,{fresh=true}={}){
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);assert.equal(path.dirname(dir),ROOT);assert.match(path.basename(dir),/^[a-f0-9]{64}$/);assert.equal(fs.realpathSync(dir),dir);
 const st=fs.statSync(dir);assert.equal(st.uid,0);assert.equal(st.mode&0o777,0o700);
 for(const name of ['capsule.json','capsule.sig','controller.cjs','postgresReferenceRepairPolicy.cjs','proof.cjs'])regular(dir+'/'+name);
 const bytes=fs.readFileSync(dir+'/capsule.json');assert.equal(policy.hash(bytes),path.basename(dir));const parsed=JSON.parse(bytes);
 const p=policy.verify(bytes,fs.readFileSync(dir+'/capsule.sig'),fs.readFileSync('/etc/football-release/signing-public.pem'),fresh?Date.now():Date.parse(parsed.createdAt));
 for(const [key,file]of [['controller','controller.cjs'],['policy','postgresReferenceRepairPolicy.cjs'],['proof','proof.cjs']])assert.equal(digest(dir+'/'+file),p.artifacts[key].sha256);
 return p;
}
async function prepare(dir,p){const current=await observe();policy.validateObservation(current,{fresh:true});assertSameInput(p.observation,current);const budget=await backupBudget();assert.equal(budget.ok,true,'insufficient measured repair backup/clone/scratch reserve: '+JSON.stringify(budget));if(!fs.existsSync(dir+'/prepared.json'))save(dir+'/prepared.json',{ok:true,checkedAt:current.checkedAt,capsuleSha256:path.basename(dir),budget,productionWrites:0,scope:'read-only preflight only; backup and isolated projection proof run after writers stop during activation'});return read(dir+'/prepared.json');}
function tree(root){const out=[];const walk=(dir,rel='')=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),key=rel?rel+'/'+name:name,s=fs.lstatSync(file),entry={path:key,mode:s.mode&0o777,uid:s.uid,gid:s.gid};if(s.isSymbolicLink())out.push({...entry,link:fs.readlinkSync(file)});else if(s.isDirectory()){out.push({...entry,directory:true});walk(file,key);}else{assert.ok(s.isFile());out.push({...entry,bytes:s.size,sha256:digest(file)});}}};walk(root);return out;}
async function backup(dir,p){
 const location=dir+'/backup';fs.mkdirSync(location,{mode:0o700});
 for(const [source,name]of [[APP,'app'],[STORE,'store'],['/etc/football-predict','config']]){run('/usr/bin/cp',['-a','--reflink=auto','--',source,location+'/'+name],{timeout:900000});const original=tree(source);assert.deepEqual(tree(location+'/'+name),original,'incomplete repair backup: '+name);save(location+'/'+name+'-manifest.json',{source,entries:original});}
 const pool=pgPool(p.observation.postgres);let client;try{client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=(await client.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot;assert.match(snapshot,/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/i);
  const file=location+'/football.dump',fd=fs.openSync(file,'wx',0o600);try{run('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/pg_dump','--format=custom','--compress=1','--no-owner','--no-acl','--snapshot='+snapshot,'--dbname=football'],{timeout:900000,stdio:['ignore',fd,'pipe']});fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  run('/usr/bin/pg_restore',['--list',file],{timeout:120000,maxBuffer:16*1024*1024});
  const proof={ok:true,checkedAt:new Date().toISOString(),postgres:{path:file,bytes:fs.statSync(file).size,sha256:digest(file),snapshot},manifests:['app','store','config'].map(n=>({name:n,sha256:digest(location+'/'+n+'-manifest.json')}))};save(dir+'/backed-up.json',proof);return proof;
 }finally{if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}await pool.end();}
}
async function isolatedProof(dir,p){
 const candidate=dir+'/candidate';run('/usr/bin/cp',['-a','--reflink=auto','--',dir+'/backup/app',candidate],{timeout:900000});
 for(const f of p.files){const file=candidate+'/'+f.path;assert.equal(fs.realpathSync(path.dirname(file)),path.dirname(file));fs.writeFileSync(file,Buffer.from(f.base64,'base64'));assert.equal(digest(file),f.sha256);run(NODE,['--check',file]);}
 // Existing signed publisher allocation creates an independent database, never a production alias.
 const native=require(APP+'/scripts/nativeReleaseDataPlane.cjs'),id=path.basename(dir),nativeDir='/var/lib/football-release/native/'+id;
 const allocated=await native.allocate(id,nativeDir);const state=native.read(nativeDir+'/state.json');assert.equal(allocated.kind,'runtime-only');
 assert.equal(state.oldDatabaseOid,p.observation.postgres.oid);assert.equal(state.clusterId,p.observation.postgres.systemIdentifier);
 save(dir+'/candidate-database.json',{nativeDir,database:state.candidateDatabase,oid:state.candidateOid,clusterId:state.clusterId});
 const fd=fs.openSync(dir+'/backup/football.dump','r');try{run('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/pg_restore','--exit-on-error','--single-transaction','--no-owner','--no-privileges','--role=football','--dbname='+state.candidateDatabase],{timeout:900000,stdio:[fd,'ignore','pipe']});}finally{fs.closeSync(fd);}
 await native.copyGenerationAsService({mode:'active-generation',...p.observation.generation},dir+'/proof-store');
 save(dir+'/proof-input.json',{capsuleSha256:id,candidate,store:dir+'/proof-store',candidateDatabase:state.candidateDatabase,candidateOid:state.candidateOid,clusterId:state.clusterId,expectedGeneration:p.observation.generation,expectedFrozen:p.observation.frozenRecords,sourcePostgres:p.observation.postgres});
 run('/usr/bin/systemd-run',['--wait','--collect','--pipe','--unit=football-reference-proof-'+id.slice(0,12),'-p','Type=exec','-p','RuntimeMaxSec=1800','-p','MemoryMax=1536M','-p','MemorySwapMax=256M','-p','PrivateNetwork=yes','-p','ProtectSystem=strict','-p','ReadWritePaths='+dir,'-p','PrivateTmp=yes','-p','NoNewPrivileges=yes','-p','WorkingDirectory='+candidate,'/usr/bin/env','-i','PATH=/usr/bin:/bin',NODE,'--max-old-space-size=1152',dir+'/proof.cjs',dir+'/proof-input.json'],{timeout:1830000,maxBuffer:65536});
 const result=read(dir+'/isolated-proof.json');assert.equal(result.ok,true);assert.equal(result.capsuleSha256,id);assert.equal(result.productionWrites,0);assert.equal(result.providerRequests,0);assert.equal(result.projectionSkipped,false);assert.equal(result.frozenPreserved,true);assert.equal(result.archiveIndexVerified,true);assert.equal(result.verificationInsideTransaction,true);save(dir+'/proof-accepted.json',{ok:true,sha256:digest(dir+'/isolated-proof.json'),result});return result;
}
function assessOfficial(status,service,after,oldPid,observedAt=new Date().toISOString()){const pid=Number(service.MainPID),cycle=status?.lastCycle,event=cycle?.officialPhase;
 const started=String(service.ExecMainStartTimestamp||'').replace(/\bCST$/,'+0800'),times=[after,started,cycle?.startedAt,event?.startedAt,event?.finishedAt,cycle?.finishedAt,status?.checkedAt,observedAt].map(Date.parse);
 const lateFailure=status?.eventCycle?.ok===false&&(Date.parse(status.eventCycle.startedAt)>=Date.parse(cycle?.startedAt)||Date.parse(status.eventCycle.finishedAt)>=Date.parse(cycle?.finishedAt));
 // systemctl's human timestamp discards milliseconds. Only that start clock
 // gets sub-second tolerance; the cycle must still begin at/after activation.
 const clocksValid=times.every(Number.isFinite)&&times[1]>=Math.floor(times[0]/1000)*1000&&times[2]>=times[0]&&times.slice(2).every((v,i)=>v>=times[i+1]);
 return Boolean(service.ActiveState==='active'&&Number.isSafeInteger(pid)&&pid>0&&pid!==oldPid&&status?.pid===pid&&status.ok===true&&status.lastError==null&&cycle?.ok===true&&cycle.skipped!==true&&event?.ok===true&&event.phase==='official-result-published'&&clocksValid&&!lateFailure);}
function projectProduction(dir,p){
 const proof=read(dir+'/isolated-proof.json');assert.equal(proof.ok,true);assert.equal(proof.verificationInsideTransaction,true);assert.equal(proof.productionWrites,0);assert.equal(proof.capsuleSha256,path.basename(dir));
 save(dir+'/production-input.json',{capsuleSha256:path.basename(dir),candidate:APP,store:STORE,expectedGeneration:p.observation.generation,expectedFrozen:p.observation.frozenRecords,isolatedArchiveSha256:proof.archiveSha256});
 save(dir+'/production-projection-started.json',{checkedAt:new Date().toISOString(),productionProjectionWrites:true,database:'football',oid:p.observation.postgres.oid,from:p.observation.postgres.publication,to:p.observation.generation,dataRollback:false});
 run(NODE,['--max-old-space-size=1152',dir+'/proof.cjs',dir+'/production-input.json','production-repair'],{timeout:1830000,maxBuffer:65536});
 const result=read(dir+'/production-projection.json');assert.equal(result.ok,true);assert.equal(result.productionProjectionWrites,true);assert.equal(result.verificationInsideTransaction,true);assert.equal(result.archiveSha256,proof.archiveSha256);assert.equal(result.frozenPreserved,true);return result;
}
function clearCurrent(dir,terminal){if(!fs.existsSync(ROOT+'/current'))return;const record=read(ROOT+'/current');assert.equal(record.capsuleSha256,path.basename(dir));assert.equal(record.directory,dir);fs.renameSync(ROOT+'/current',dir+'/'+terminal+'-current-'+Date.now()+'.json');}
function installEntryGuard(dir,p){const guard=p.entrypointGuard,current=digest(policy.ENTRYPOINT);assert.ok([guard.beforeSha256,guard.sha256].includes(current));const st=regular(policy.ENTRYPOINT);assert.equal(st.uid,0);assert.equal(st.gid,0);assert.equal(st.mode&0o022,0);
 if(!fs.existsSync(dir+'/entrypoint-before')){fs.writeFileSync(dir+'/entrypoint-before',fs.readFileSync(policy.ENTRYPOINT),{flag:'wx',mode:0o600});save(dir+'/entrypoint-guard-intent.json',{beforeSha256:guard.beforeSha256,sha256:guard.sha256,preserveOnRollback:true});}
 const bytes=Buffer.from(guard.base64,'base64'),target=dir+'/entrypoint-target';if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});run('/usr/bin/bash',['-n',target]);if(current!==guard.sha256)replace(policy.ENTRYPOINT,bytes,st);assert.equal(digest(policy.ENTRYPOINT),guard.sha256);
}
function stopProofUnit(dir){const id=path.basename(dir);assert.match(id,/^[a-f0-9]{64}$/);const unit='football-reference-proof-'+id.slice(0,12)+'.service';
 const state=()=>Object.fromEntries(run('/usr/bin/systemctl',['show',unit,'--property=LoadState,ActiveState,MainPID,ControlGroup','--no-pager']).trim().split('\n').map(x=>x.split('=')));
 if(state().LoadState==='not-found')return;run('/usr/bin/systemctl',['stop',unit],{timeout:120000});const after=state();assert.ok(after.LoadState==='not-found'||(['inactive','failed'].includes(after.ActiveState)&&Number(after.MainPID)===0),'isolated proof unit did not drain');
 if(after.ControlGroup){assert.equal(after.ControlGroup,'/system.slice/'+unit);const procs='/sys/fs/cgroup'+after.ControlGroup+'/cgroup.procs';if(fs.existsSync(procs))assert.equal(fs.readFileSync(procs,'utf8').trim(),'','isolated proof descendants remain');}
}
async function recover(dir,p){if(fs.existsSync(dir+'/accepted.json')||fs.existsSync(dir+'/recovered.json')){clearCurrent(dir,fs.existsSync(dir+'/accepted.json')?'accepted':'recovered');return{recoveryRequired:false};}if(!fs.existsSync(dir+'/activation-started.json'))return{recoveryRequired:false};
 const started=read(dir+'/activation-started.json');stopProofUnit(dir);stopUnits(started.units);
 if(fs.existsSync(dir+'/code-swap-started.json'))for(const f of p.files){const target=APP+'/'+f.path,current=fs.existsSync(target)?digest(target):null;assert.ok([f.beforeSha256,f.sha256].includes(current),'refuse rollback over unrelated code');if(f.beforeSha256===null){if(current!==null)fs.renameSync(target,dir+'/rolled-back-'+path.basename(f.path));}else{const old=dir+'/backup/app/'+f.path;assert.equal(digest(old),f.beforeSha256);replace(target,fs.readFileSync(old),regular(old));}}
 restoreUnits(started.units);const result={checkedAt:new Date().toISOString(),codeRestored:true,dataRestored:false,servicesRestored:true,entrypointGuardPreserved:digest(policy.ENTRYPOINT)===p.entrypointGuard.sha256};save(dir+'/recovered.json',result);clearCurrent(dir,'recovered');return result;
}
async function activate(dir,p){
 assert.equal(fs.existsSync(dir+'/activation-started.json'),false,'activation cannot replay');assert.equal(read(dir+'/prepared.json').ok,true);
 const before=await observe();assertSameInput(p.observation,before);const units=unitStates();assert.equal(units['football-predict.service'].ActiveState,'active');assert.equal(units['football-sync-worker.service'].ActiveState,'active');
 assert.ok(Object.values(units).every(s=>s.LoadState==='not-found'||['active','inactive','failed'].includes(s.ActiveState)));
 const budget=await backupBudget();assert.equal(budget.ok,true,'insufficient measured repair space reserve');assert.equal(fs.existsSync(ROOT+'/current'),false,'another reference repair is unresolved');
 save(dir+'/activation-started.json',{checkedAt:new Date().toISOString(),units,budget,productionWritersPaused:false,maintenanceRequired:true});
 try{
  installEntryGuard(dir,p);
  save(ROOT+'/current',{capsuleSha256:path.basename(dir),directory:dir});
  stopUnits(units);save(dir+'/writers-paused.json',{checkedAt:new Date().toISOString(),maintenanceRequired:true});const paused=await observe({requireFault:false});assertSameInput(p.observation,paused);
  const identity=topology(),pool=pgPool(identity);try{const busy=(await pool.query('SELECT pid FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[identity.database])).rows;assert.equal(busy.length,0,'unknown database sessions remain; no forced disconnect');}finally{await pool.end();}
  await backup(dir,p);await isolatedProof(dir,p);assertSameInput(p.observation,await observe({requireFault:false}));
  save(dir+'/code-swap-started.json',{checkedAt:new Date().toISOString()});for(const f of p.files){const target=APP+'/'+f.path,st=f.beforeSha256===null?regular(APP+'/scripts/postgresGenerationSource.cjs'):regular(target);replace(target,Buffer.from(f.base64,'base64'),st);assert.equal(digest(target),f.sha256);}
  const productionProjection=projectProduction(dir,p);currentWindow();
  const startedAt=new Date().toISOString();save(dir+'/activated.json',{checkedAt:startedAt,fullReleaseDeployed:false,baseRuntimeSha256:policy.BASE_RUNTIME});
  run('/usr/bin/systemctl',['start','football-predict.service']);run('/usr/bin/systemctl',['start','football-sync-worker.service']);
  let official=null;const window=currentWindow(),transition=Date.parse(window.nextTransition),deadline=Math.min(Date.now()+50*60000,Number.isFinite(transition)?transition-15*60000:Infinity);while(Date.now()<deadline){await new Promise(r=>setTimeout(r,5000));const status=read(STORE+'/sync-worker-status.json'),service=Object.fromEntries(run('/usr/bin/systemctl',['show','football-sync-worker.service','--property=ActiveState,MainPID,ExecMainStartTimestamp','--no-pager']).trim().split('\n').map(x=>x.split('=')));
   if(status.lastCycle?.ok===false&&Date.parse(status.lastCycle.startedAt)>=Date.parse(startedAt))throw Error('repaired Worker formal cycle failed');
   if(assessOfficial(status,service,startedAt,p.observation.worker.pid)){official={pid:status.pid,lastCycle:status.lastCycle,statusCheckedAt:status.checkedAt};break;}}
  assert.ok(official,'new Worker official cycle not proven');save(dir+'/official-publication.json',official);
  const after=await observe({requireFault:false,requireWindow:false});const continuity=policy.compareFrozen(p.observation.frozenRecords,after.frozenRecords);
  assert.equal(after.postgres.oid,p.observation.postgres.oid);assert.equal(after.postgres.systemIdentifier,p.observation.postgres.systemIdentifier);
  for(const key of ['generationId','manifestHash','sourceCycleId','committedAt'])assert.equal(after.postgres.publication[key],after.generation[key],'PG publication is not the repaired generation');
  assert.equal(after.frontendStateSha256,p.observation.frontendStateSha256);for(const f of p.files)assert.equal(digest(APP+'/'+f.path),f.sha256);
  restoreUnits(units);const health=JSON.parse(run('/usr/bin/curl',['-fsS','--max-time','15','http://127.0.0.1:8788/api/v1/health']));
  const status=health.status||{},pg=health.storage?.postgres,current=health.data?.currentRead||health.currentRead||{};for(const key of ['serviceOk','dataFresh','fastResultIntegrityOk','recommendationProjectionParityOk'])assert.equal(status[key],true,'post-repair health: '+key);assert.equal(status.recommendationReliable,false);assert.equal(health.storage?.sqlite?.available,false);assert.equal(pg?.available,true);assert.notEqual(pg.baseReady,false);assert.ok(!pg.baseBlockedReason);assert.equal(current.source,'postgres');
  const accepted={ok:true,checkedAt:new Date().toISOString(),baseRuntimeSha256:policy.BASE_RUNTIME,repairSha256:path.basename(dir),official,continuity,postgres:after.postgres,health:status,productionProjectionWrites:true,productionProjection,entrypointGuardSha256:digest(policy.ENTRYPOINT),entrypointGuardPreserved:true,fullReleaseDeployed:false,dataRestored:false,modelPromotion:false};assert.equal(accepted.entrypointGuardSha256,p.entrypointGuard.sha256);save(dir+'/accepted.json',accepted);clearCurrent(dir,'accepted');return accepted;
 }catch(error){if(!fs.existsSync(dir+'/failed.json'))save(dir+'/failed.json',{checkedAt:new Date().toISOString(),error:error.message});await recover(dir,p);throw error;}
}
async function supervise(dir){const p=load(dir);let interrupted=false;const child=cp.spawn(NODE,[__filename,'activate',dir],{detached:true,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C',TZ:'UTC'},stdio:['ignore','inherit','inherit']});
 const signal=kind=>{if(!Number.isSafeInteger(child.pid))return;try{process.kill(-child.pid,kind);}catch(e){if(e.code!=='ESRCH')throw e;}},stop=()=>{interrupted=true;signal('SIGTERM');};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});if(interrupted||result.code!==0){signal('SIGTERM');await new Promise(r=>setTimeout(r,1000));signal('SIGKILL');await recover(dir,p);throw Error('repair activation stopped; code recovery and services were verified before releasing the publisher lock');}return read(dir+'/accepted.json');}
 finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
async function main(){const [action,dir]=process.argv.slice(2);assert.ok(['prepare','activate','supervise','recover','status'].includes(action));if(action==='supervise')return supervise(dir);const p=load(dir,{fresh:['prepare','activate'].includes(action)});if(action==='prepare')return prepare(dir,p);if(action==='activate')return activate(dir,p);if(action==='recover')return recover(dir,p);return{directory:dir,states:['prepared','activation-started','backed-up','proof-accepted','activated','accepted','failed','recovered'].filter(n=>fs.existsSync(dir+'/'+n+'.json'))};}
module.exports={observe,prepare,activate,recover,load,assertSameInput,assessOfficial,boundFaultLogs,captureReferenceObjects,tree,unitStates,projectProduction};
if(require.main===module)main().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;});
