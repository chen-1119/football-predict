'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict');
const { verify, hash } = require('./foundationRepairPolicy.cjs');
const APP='/opt/football-predict', STORE='/var/lib/football-predict', RELEASE='/var/lib/football-release';
const NODE='/opt/node-v22.22.1/bin/node';
function run(command,args,options={}) {
  return cp.execFileSync(command,args,{encoding:'utf8',timeout:60000,maxBuffer:4*1024**2,...options});
}
function digest(filename) { return run('/usr/bin/sha256sum',['--',filename]).split(' ')[0]; }
function regular(filename) { const s=fs.lstatSync(filename);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,filename+' must be regular');return s; }
const UNITS=['football-cleanup.timer','football-monitor.timer','football-postgres-backup.timer',
  'football-cleanup.service','football-monitor.service','football-postgres-backup.service','football-postgres-cos-upload.service',
  'football-sync-worker.service','football-predict.service'];
function unitState(unit){return run('/usr/bin/systemctl',['show',unit,'--property=ActiveState','--value']).trim();}
function restartOriginal(states){
  for(const unit of [...UNITS].reverse())if(states[unit]==='active')run('/usr/bin/systemctl',['start',unit],{timeout:120000});
}
function tree(root) {
  const crypto=require('node:crypto'),entries=[];
  function walk(dir,relative='') {
    for(const name of fs.readdirSync(dir).sort()) {
      const file=path.join(dir,name),rel=relative?relative+'/'+name:name,s=fs.lstatSync(file);
      if(s.isSymbolicLink())entries.push({path:rel,link:fs.readlinkSync(file),mode:s.mode&0o777,uid:s.uid,gid:s.gid});
      else if(s.isDirectory()){entries.push({path:rel,directory:true,mode:s.mode&0o777,uid:s.uid,gid:s.gid});walk(file,rel);}
      else {assert.ok(s.isFile(),'unsupported backup entry: '+file);const fd=fs.openSync(file,'r'),h=crypto.createHash('sha256'),buf=Buffer.alloc(1024**2);
        try{let n;while((n=fs.readSync(fd,buf,0,buf.length,null)))h.update(buf.subarray(0,n));}finally{fs.closeSync(fd);}
        entries.push({path:rel,bytes:s.size,sha256:h.digest('hex'),mode:s.mode&0o777,uid:s.uid,gid:s.gid});}
    }
  }
  walk(root);return entries;
}
function captureObjects(plan=null) {
  const store=require(APP+'/server/dataGenerationStore.cjs'),context=store.resolveCurrentGeneration({storeDir:STORE});
  const selectedResult=store.readGenerationSelectedObject(context,'prediction-snapshots.json',{
    keys:['publicReferenceDecisions','publicReferenceEvidence'],maxSelectedChars:64*1024**2});
  const selected=selectedResult.value;
  const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
  const objectHash=x=>hash(JSON.stringify(stable(x)));
  const evidence=require(APP+'/src/services/publicReferenceEvidence.cjs').collectPublicReferenceEvidence(selected.publicReferenceDecisions,selected.publicReferenceEvidence);
  assert.ok(evidence.length>0,'empty active evidence is not a repair baseline');
  let mutable=null;
  if(plan) {
    assert.equal(selectedResult.evidence.sha256,plan.publication.sha256,'published snapshot changed');
    assert.equal(selectedResult.evidence.bytes,plan.publication.bytes);
    assert.equal(evidence.length,plan.publication.validBindings);
    mutable=require(APP+'/server/selectedJsonObjectFile.cjs').readSelectedJsonObjectFile({
      filePath:APP+'/public/data/prediction-snapshots.json',expectedBytes:plan.snapshot.bytes,expectedSha256:plan.snapshot.sha256,
      keys:['publicReferenceDecisions','publicReferenceEvidence'],maxSelectedChars:64*1024**2}).value;
    assert.equal(require(APP+'/src/services/publicReferenceEvidence.cjs').collectPublicReferenceEvidence(
      mutable.publicReferenceDecisions,mutable.publicReferenceEvidence).length,plan.snapshot.validBindings);
    for(const field of ['publicReferenceDecisions','publicReferenceEvidence']) {
      const retained=new Set(mutable[field].map(objectHash));
      for(const row of selected[field])assert.ok(retained.has(objectHash(row)),'published evidence absent from mutable history');
    }
  }
  const frozen={};
  for(const name of ['matches-current.json','matches-history.json']) {
    const payload=store.readGenerationFile(context,name,{parseJson:true}),rows=Array.isArray(payload)?payload:payload.matches;
    assert.ok(Array.isArray(rows));
    for(const row of rows)if(row.archivedPreMatchPrediction) {
      const id=JSON.stringify([String(row.sourceMatchId),row.eventVersion||null,row.kickoffTime]);
      assert.ok(!frozen[id],'duplicate frozen event');frozen[id]=objectHash(row.archivedPreMatchPrediction);
    }
  }
  assert.ok(Object.keys(frozen).length>0,'empty frozen archive');
  assert.deepEqual(store.resolveCurrentGeneration({storeDir:STORE}).pointer,context.pointer,'generation changed during capture');
  return {checkedAt:new Date().toISOString(),pointer:context.pointer,frozen,
    decisions:selected.publicReferenceDecisions.map(objectHash),evidence:selected.publicReferenceEvidence.map(objectHash),
    ...(mutable?{mutableDecisions:mutable.publicReferenceDecisions.map(objectHash),mutableEvidence:mutable.publicReferenceEvidence.map(objectHash)}:{})};
}
function compareObjects(before,after) {
  for(const [id,h]of Object.entries(before.frozen))assert.equal(after.frozen[id],h,'frozen object changed or missing: '+id);
  for(const field of ['decisions','evidence']){const retained=new Set(after[field]);for(const h of before[field])assert.ok(retained.has(h),'original '+field+' object missing');}
  for(const [from,to]of [['mutableDecisions','decisions'],['mutableEvidence','evidence']]) {
    if(!before[from])continue;const published=new Set(after[to]);for(const h of before[from])assert.ok(published.has(h),'original mutable '+to+' missing from new publication');
  }
  return {frozenPreserved:Object.keys(before.frozen).length,decisionsPreserved:before.decisions.length,evidencePreserved:before.evidence.length,
    mutableDecisionsPreserved:before.mutableDecisions?.length||0,mutableEvidencePreserved:before.mutableEvidence?.length||0,
    beforeGeneration:before.pointer,afterGeneration:after.pointer};
}
function replaceCode(filename,bytes,metadata) {
  const temp=filename+'.foundation-'+process.pid;
  const fd=fs.openSync(temp,'wx',metadata.mode&0o777);
  try{fs.writeFileSync(fd,bytes);fs.fchownSync(fd,metadata.uid,metadata.gid);fs.fchmodSync(fd,metadata.mode&0o777);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,filename);const d=fs.openSync(path.dirname(filename),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
}
function save(filename,value) {
  const fd=fs.openSync(filename,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const d=fs.openSync(path.dirname(filename),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
}
function load(dir, fresh=true) {
  assert.equal(process.getuid(),0);assert.equal(fs.realpathSync(dir),dir);
  assert.equal(path.dirname(dir),RELEASE+'/foundation-repairs');assert.match(path.basename(dir),/^[a-f0-9]{64}$/);
  const bytes=fs.readFileSync(dir+'/capsule.json');assert.equal(hash(bytes),path.basename(dir));
  const p=verify(bytes,fs.readFileSync(dir+'/capsule.sig'),fs.readFileSync('/etc/football-release/signing-public.pem'),fresh?Date.now():Date.parse(JSON.parse(bytes).createdAt));
  for(const [name,file]of [['controller','controller.cjs'],['policy','foundationRepairPolicy.cjs']])assert.equal(digest(dir+'/'+file),p[name].sha256);
  return p;
}
function unchanged(p) {
  assert.equal(fs.readFileSync(APP+'/.release-bundle-sha256','utf8').trim(),p.baseRuntimeSha256);
  assert.equal(fs.readFileSync(APP+'/.release-live-complete','utf8').trim(),p.baseRuntimeSha256);
  assert.equal(digest(RELEASE+'/frontend-state.json'),p.frontendStateSha256);
  assert.equal(fs.existsSync(RELEASE+'/recovery/current'),false,'normal recovery pending');
  assert.equal(fs.existsSync(APP+'/.foundation-repair.json'),false,'prior repair needs explicit reconciliation');
  for(const f of p.files) {
    const target=APP+'/'+f.path;
    if(f.beforeSha256===null)assert.equal(fs.existsSync(target),false,'new repair file already exists');
    else { regular(target);assert.equal(digest(target),f.beforeSha256,'live code changed: '+f.path); }
  }
  const snapshot=APP+'/public/data/prediction-snapshots.json';regular(snapshot);
  assert.equal(fs.statSync(snapshot).size,p.snapshot.bytes);assert.equal(digest(snapshot),p.snapshot.sha256);
}
async function prepare(dir,p) {
  unchanged(p);
  assert.equal(fs.existsSync(dir+'/prepare-started.json'),false,'no prepare replay');
  const free=fs.statfsSync(dir);assert.ok(free.bavail*free.bsize>40*1024**3,'insufficient backup reserve');
  const available=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB/m)[1]);
  assert.ok(available>2.5*1024**2,'insufficient host memory reserve');
  save(dir+'/prepare-started.json',{checkedAt:new Date().toISOString(),capsuleSha256:path.basename(dir),productionWrites:0});
  const candidate=dir+'/candidate';
  run('/usr/bin/cp',['-a','--reflink=auto','--',APP,candidate],{timeout:300000});fs.chmodSync(candidate,0o700);
  for(const f of p.files){const target=candidate+'/'+f.path;assert.equal(fs.realpathSync(path.dirname(target)),path.dirname(target));
    if(fs.existsSync(target))regular(target);fs.writeFileSync(target,Buffer.from(f.base64,'base64'),{mode:0o640});
    assert.equal(digest(target),f.sha256);run(NODE,['--check',target]);}
  for(const [name,file]of [['proof','proveFoundationRepair.cjs'],['policy','foundationRepairPolicy.cjs']])
    fs.writeFileSync(candidate+'/scripts/'+file,Buffer.from(p[name].base64,'base64'),{flag:'wx',mode:0o600});
  const output=run('/usr/bin/systemd-run',['--quiet','--wait','--pipe','--collect','--unit=football-foundation-proof-'+path.basename(dir).slice(0,12),
    '-p','PrivateNetwork=yes','-p','ProtectSystem=strict','-p','ReadWritePaths='+candidate,'-p','PrivateTmp=yes',
    '-p','MemoryMax=2G','-p','MemorySwapMax=0','-p','Nice=15','-p','NoNewPrivileges=yes',
    '-p','WorkingDirectory='+candidate,'-p','Environment=SERVER_STORE_DIR='+candidate+'/server-data',
    NODE,'--max-old-space-size=1152','--expose-gc',candidate+'/scripts/proveFoundationRepair.cjs',dir+'/capsule.json'],{timeout:240000});
  const proof=JSON.parse(fs.readFileSync(candidate+'/repair-proof.json','utf8'));
  assert.equal(proof.ok,true);assert.equal(proof.capsuleSha256,path.basename(dir));
  unchanged(p);
  save(dir+'/prepared.json',{checkedAt:new Date().toISOString(),ok:true,capsuleSha256:path.basename(dir),proofSha256:digest(candidate+'/repair-proof.json'),
    scope:'isolated conversion only; production code and data unchanged',productionWrites:0});
  console.log(JSON.stringify({ok:true,phase:'prepared',directory:dir,proof:JSON.parse(output.trim().split('\n').filter(x=>x.startsWith('{')).pop()),productionWrites:0}));
}
async function recover(dir,p) {
  if(fs.existsSync(dir+'/accepted.json')||fs.existsSync(dir+'/recovered.json')||!fs.existsSync(dir+'/activation-started.json'))return;
  const started=JSON.parse(fs.readFileSync(dir+'/activation-started.json','utf8'));
  // Code rollback only. Never overwrite new publications or the database with a stale backup.
  if(fs.existsSync(dir+'/code-swap-started.json')) {
    for(const unit of ['football-sync-worker.service','football-predict.service'])run('/usr/bin/systemctl',['stop',unit],{timeout:120000});
    assert.equal(unitState('football-sync-worker.service'),'inactive');assert.equal(unitState('football-predict.service'),'inactive');
    for(const f of p.files) {
      const target=APP+'/'+f.path,backup=dir+'/backup/app/'+f.path;
      const current=fs.existsSync(target)?digest(target):null;
      assert.ok([f.beforeSha256,f.sha256].includes(current),'refuse rollback over unrelated code');
      if(f.beforeSha256===null) {if(current===f.sha256)fs.renameSync(target,dir+'/rolled-back-chunkedJsonFile.cjs');}
      else {assert.equal(digest(backup),f.beforeSha256);replaceCode(target,fs.readFileSync(backup),fs.statSync(backup));}
    }
    if(fs.existsSync(APP+'/.foundation-repair.json'))fs.renameSync(APP+'/.foundation-repair.json',dir+'/rolled-back-marker.json');
  }
  restartOriginal(started.units);
  save(dir+'/recovered.json',{checkedAt:new Date().toISOString(),codeRestored:true,dataRestored:false,
    scope:'original service states restored; all databases, new observations and backups retained'});
}
async function activate(dir,p) {
  unchanged(p);assert.equal(fs.existsSync(dir+'/activation-started.json'),false,'activation must not replay');
  const prepared=JSON.parse(fs.readFileSync(dir+'/prepared.json','utf8'));
  assert.equal(prepared.ok,true);assert.equal(prepared.capsuleSha256,path.basename(dir));
  assert.equal(digest(dir+'/candidate/repair-proof.json'),prepared.proofSha256);
  // Validate BOTH the last published generation and the newer mutable history before downtime.
  const early=captureObjects(p);save(dir+'/objects-preflight.json',early);
  const units=Object.fromEntries(UNITS.map(u=>[u,unitState(u)]));
  assert.equal(units['football-predict.service'],'active');assert.equal(units['football-sync-worker.service'],'active');
  assert.ok(Object.values(units).every(s=>['active','inactive'].includes(s)),'unit transition in progress');
  save(dir+'/activation-started.json',{checkedAt:new Date().toISOString(),units,capsuleSha256:path.basename(dir)});
  try {
    for(const unit of UNITS)run('/usr/bin/systemctl',['stop',unit],{timeout:120000});
    for(const unit of UNITS)assert.equal(unitState(unit),'inactive','writer did not stop: '+unit);
    unchanged(p);
    const before=captureObjects(p);assert.deepEqual(before.frozen,early.frozen,'frozen baseline changed before pause');
    save(dir+'/objects-before.json',before);
    const backup=dir+'/backup';fs.mkdirSync(backup,{mode:0o700});
    for(const [source,name]of [[APP,'app'],[STORE,'store'],['/etc/football-predict','config']]) {
      run('/usr/bin/cp',['-a','--reflink=auto','--',source,backup+'/'+name],{timeout:600000});
      const original=tree(source),copy=tree(backup+'/'+name);assert.deepEqual(copy,original,'backup is not complete: '+name);
      save(backup+'/'+name+'-manifest.json',{checkedAt:new Date().toISOString(),source,entries:original});
    }
    const pg=backup+'/football.dump',fd=fs.openSync(pg,'wx',0o600);
    try{run('/usr/bin/sudo',['-u','postgres','/usr/bin/pg_dump','--format=custom','--compress=1','--no-owner','football'],
      {timeout:600000,stdio:['ignore',fd,'pipe']});fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    run('/usr/bin/pg_restore',['--list',pg],{timeout:120000,maxBuffer:16*1024**2});
    save(dir+'/backed-up.json',{checkedAt:new Date().toISOString(),directory:backup,snapshotSha256:digest(backup+'/app/public/data/prediction-snapshots.json'),
      postgresSha256:digest(pg),postgresBytes:fs.statSync(pg).size,manifests:['app','store','config'].map(n=>({name:n,sha256:digest(backup+'/'+n+'-manifest.json')}))});
    unchanged(p);
    save(dir+'/code-swap-started.json',{checkedAt:new Date().toISOString(),capsuleSha256:path.basename(dir)});
    for(const f of p.files){const target=APP+'/'+f.path,metadata=f.beforeSha256===null?fs.statSync(APP+'/server/dataGenerationStore.cjs'):fs.statSync(target);
      replaceCode(target,Buffer.from(f.base64,'base64'),metadata);assert.equal(digest(target),f.sha256);}
    save(APP+'/.foundation-repair.json',{version:'foundation-runtime-overlay-v1',phase:'awaiting-official-publication',
      baseRuntimeSha256:p.baseRuntimeSha256,repairSha256:path.basename(dir),backupDirectory:backup,appliedAt:new Date().toISOString(),modelPromotion:false});
    const workerAfter=new Date().toISOString();save(dir+'/activated.json',{checkedAt:workerAfter,baseRuntimeSha256:p.baseRuntimeSha256,repairSha256:path.basename(dir)});
    run('/usr/bin/systemctl',['start','football-predict.service'],{timeout:120000});
    run('/usr/bin/systemctl',['start','football-sync-worker.service'],{timeout:120000});
    const deadline=Date.now()+20*60000;let official=null;
    while(Date.now()<deadline) {
      await new Promise(r=>setTimeout(r,5000));
      const pid=Number(run('/usr/bin/systemctl',['show','football-sync-worker.service','--property=MainPID','--value']).trim());
      const s=JSON.parse(fs.readFileSync(STORE+'/sync-worker-status.json','utf8')),event=s.eventCycle;
      if(s.pid===pid&&s.lastCycle?.ok===false&&s.lastCycle.phase==='official-result-failed'
        &&Date.parse(s.lastCycle.startedAt)>=Date.parse(workerAfter))throw Error('new official cycle failed: '+s.lastCycle.error);
      if(s.pid===pid&&event?.ok===true&&event.phase==='official-result-published'&&Date.parse(event.startedAt)>=Date.parse(workerAfter)
        &&Date.parse(event.finishedAt)>=Date.parse(event.startedAt)&&Date.parse(event.finishedAt)<=Date.parse(s.checkedAt)) {
        official={pid,event,statusCheckedAt:s.checkedAt};break;
      }
    }
    assert.ok(official,'no new official publication within deadline');save(dir+'/official-publication.json',official);
    // Drain writers again so before/after generation and evidence checks describe a single publication.
    for(const unit of ['football-sync-worker.service','football-predict.service'])run('/usr/bin/systemctl',['stop',unit],{timeout:120000});
    const after=captureObjects(),continuity=compareObjects(before,after);save(dir+'/objects-after.json',after);
    for(const f of p.files)assert.equal(digest(APP+'/'+f.path),f.sha256);
    for(const unit of ['football-predict.service','football-sync-worker.service'])run('/usr/bin/systemctl',['start',unit],{timeout:120000});
    const c=require('/usr/local/libexec/football-release-frontend/frontendReleaseController.cjs');
    let health=null;for(let i=0;i<12;i++){try{health=await c.health(c.publicBase(),JSON.parse(fs.readFileSync(RELEASE+'/frontend-state.json','utf8')));break;}
      catch(e){if(i===11)throw e;await new Promise(r=>setTimeout(r,5000));}}
    for(const key of ['serviceOk','fastResultIntegrityOk','recommendationProjectionParityOk'])assert.equal(health.status[key],true,'health failed: '+key);
    assert.equal(health.status.recommendationReliable,false,'repair must not promote model');
    const acceptance={version:'foundation-repair-acceptance-v1',ok:true,checkedAt:new Date().toISOString(),baseRuntimeSha256:p.baseRuntimeSha256,
      repairSha256:path.basename(dir),official,continuity,health:health.status,backupDirectory:backup,fullReleaseDeployed:false,modelPromotion:false};
    // Restore scheduled maintenance only after the protected-object and health gates.
    restartOriginal(units);
    replaceCode(APP+'/.foundation-repair.json',Buffer.from(JSON.stringify({...acceptance,phase:'accepted'})+'\n'),fs.statSync(APP+'/.foundation-repair.json'));
    save(dir+'/accepted.json',acceptance);console.log(JSON.stringify(acceptance));
  }catch(e){save(dir+'/failed.json',{checkedAt:new Date().toISOString(),error:e.message});await recover(dir,p);throw e;}
}
async function main() {
  const [mode,dir]=process.argv.slice(2);assert.ok(['prepare','activate','recover','status'].includes(mode),'unsupported repair action');
  const p=load(dir,['prepare','activate'].includes(mode));
  if(mode==='prepare')return prepare(dir,p);
  if(mode==='activate')return activate(dir,p);
  if(mode==='recover')return recover(dir,p);
  const states=['prepare-started','prepared','activation-started','backed-up','activated','accepted','failed'];
  console.log(JSON.stringify({directory:dir,states:Object.fromEntries(states.filter(x=>fs.existsSync(dir+'/'+x+'.json')).map(x=>[x,JSON.parse(fs.readFileSync(dir+'/'+x+'.json','utf8'))]))}));
}
module.exports={load,unchanged,prepare,activate,recover,compareObjects};
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;});
