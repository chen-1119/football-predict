'use strict';
// Actual Linux root filesystem and kernel flock checks in one unique 0700
// fixture. This never opens a production journal, lock, service or database.
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const broker=require('./researchReleaseBroker.cjs'),retry=require('../server/researchPublicationFreshnessRetry.cjs');
const p=require('./recommendationPlatform/reviewedAnalysis.cjs'),{journalBudget}=require('../server/researchBrokerJournal.cjs');
async function verify(){
 a.equal(process.platform,'linux');a.equal(process.getuid(),0);a.equal(process.env.RESEARCH_ISOLATED_ROOT_JOURNAL_TEST,'1');
 const dir=fs.mkdtempSync('/var/lib/football-research-freshness-fixture-');fs.chmodSync(dir,0o700);
 const roots=['original','retry','cases','budget'].map(n=>path.join(dir,n));for(const d of roots)fs.mkdirSync(d,{mode:0o700});
 const [originalDir,retryDir,casesDir,budgetDir]=roots;let checks=0;
 const refuses=(fn,code)=>{a.throws(fn,code?{code}:undefined);checks++;};
 const write=(file,bytes)=>{broker.syncNew(file,bytes);const s=fs.lstatSync(file);a.equal(s.uid,0);a.equal(s.mode&0o777,0o600);a.equal(s.nlink,1);a.deepEqual(fs.readFileSync(file),Buffer.from(bytes));};
 try{
  const source=fs.readFileSync(path.join(__dirname,'recommendationPlatform/reviewedOfficialFreshness.cjs'));
  a.equal(p.sha(source),retry.REQUIRED_FRESH_INPUT_SHA256);
  const installedSource=path.join(casesDir,'fresh-input.cjs');write(installedSource,source);
  const installed={releaseSha:'b'.repeat(64),freshInputSourceSha256:p.sha(broker.trustedFile(installedSource,8*1024*1024))};
  const draft={version:4,eventAuthority:'signed-official-events-v1',businessDate:'2026-10-22',singles:[]},json=JSON.stringify(draft);
  const input={version:'research-broker-request-v1',action:'publish',draftHash:p.hash(draft),json,sha256:p.sha(json)},originalRequestJson=JSON.stringify(input),originalRequestSha256=p.sha(originalRequestJson),oldRelease='a'.repeat(64);
  const clock=Date.now()-1000,intentBytes=Buffer.from(JSON.stringify({version:'research-broker-intent-v1',requestSha:originalRequestSha256,releaseSha:oldRelease,admittedAt:new Date(clock-1).toISOString(),automaticWriteRetry:false}));
  const receiptBytes=Buffer.from(JSON.stringify({version:'research-broker-result-v1',requestSha:originalRequestSha256,releaseSha:oldRelease,finishedAt:new Date(clock).toISOString(),code:1,overflow:false,stdout:'',stderr:JSON.stringify({ok:false,error:retry.ERROR,retryWriteAutomatically:false})+'\n',automaticWriteRetry:false})+'\n');
  const originalIntent=path.join(originalDir,originalRequestSha256+'.intent.json'),originalReceipt=path.join(originalDir,originalRequestSha256+'.receipt.json');write(originalIntent,intentBytes);write(originalReceipt,receiptBytes);
  const request={version:input.version,action:retry.ACTION,originalRequestJson,originalRequestSha256,failedReceiptSha256:p.sha(receiptBytes)};
  const readTrusted=(file,max)=>{const base='/var/lib/football-research-broker/'+originalRequestSha256;a.ok([base+'.intent.json',base+'.receipt.json'].includes(file));return broker.trustedFile(path.join(originalDir,path.basename(file)),max);};
  a.equal(retry.verifyFailure(request,readTrusted,installed).originalRequestSha256,originalRequestSha256);checks++;
  // These are real permission, owner, ancestor, symlink and link-count cases.
  for(const mode of [0o620,0o602]){fs.chmodSync(originalReceipt,mode);refuses(()=>retry.verifyFailure(request,readTrusted,installed),'RESEARCH_ROOT_OWNERSHIP');fs.chmodSync(originalReceipt,0o600);}
  fs.chownSync(originalReceipt,65534,65534);refuses(()=>retry.verifyFailure(request,readTrusted,installed),'RESEARCH_ROOT_OWNERSHIP');fs.chownSync(originalReceipt,0,0);
  fs.chmodSync(originalDir,0o720);refuses(()=>retry.verifyFailure(request,readTrusted,installed),'RESEARCH_ROOT_OWNERSHIP');fs.chmodSync(originalDir,0o700);
  fs.chownSync(originalDir,65534,65534);refuses(()=>retry.verifyFailure(request,readTrusted,installed),'RESEARCH_ROOT_OWNERSHIP');fs.chownSync(originalDir,0,0);
  const hard=path.join(casesDir,'receipt-hard');fs.linkSync(originalReceipt,hard);refuses(()=>retry.verifyFailure(request,readTrusted,installed),'RESEARCH_TRUSTED_FILE_BOUND');fs.unlinkSync(hard);
  const leaf=path.join(casesDir,'receipt-link');fs.symlinkSync(originalReceipt,leaf);refuses(()=>broker.trustedFile(leaf,4096),'RESEARCH_ROOT_OWNERSHIP');
  const ancestor=path.join(casesDir,'ancestor-link');fs.symlinkSync(originalDir,ancestor,'dir');refuses(()=>broker.trustedFile(path.join(ancestor,path.basename(originalReceipt)),4096),'RESEARCH_ROOT_OWNERSHIP');
  refuses(()=>broker.trustedFile(originalReceipt,1),'RESEARCH_TRUSTED_FILE_BOUND');
  refuses(()=>broker.trustedFile(originalDir,4096),'RESEARCH_TRUSTED_FILE_BOUND');
  const savedReceipt=path.join(casesDir,'saved-receipt');fs.renameSync(originalReceipt,savedReceipt);refuses(()=>retry.verifyFailure(request,readTrusted,installed));fs.renameSync(savedReceipt,originalReceipt);
  // O_EXCL preserves every already-created journal byte, including an unknown
  // attempt with no completion. No repeated call can enter another execution.
  const raw=Buffer.from(JSON.stringify(request)),id=broker.requestJournalIdentity(raw),intent=path.join(retryDir,id.journalId+'.intent.json'),receipt=path.join(retryDir,id.journalId+'.receipt.json');
  const args={intent,receipt,requestSha:id.requestSha,releaseSha:installed.releaseSha};a.equal(broker.readExistingJournal(args),null);
  journalBudget(retryDir,raw.length+4*1024*1024);checks++;
  const newIntent=Buffer.from(JSON.stringify({version:'research-broker-intent-v1',requestSha:id.requestSha,releaseSha:installed.releaseSha,admittedAt:new Date().toISOString(),automaticWriteRetry:false}));write(intent,newIntent);
  refuses(()=>broker.syncNew(intent,Buffer.from('replace')),'EEXIST');a.deepEqual(fs.readFileSync(intent),newIntent);
  refuses(()=>broker.readExistingJournal(args),'RESEARCH_PREVIOUS_REQUEST_UNCONFIRMED_READ_FIRST');
  const changed=broker.requestJournalIdentity(Buffer.from(JSON.stringify(request,null,2)));a.equal(changed.journalId,id.journalId);a.notEqual(changed.requestSha,id.requestSha);
  refuses(()=>broker.readExistingJournal({...args,requestSha:changed.requestSha}),'RESEARCH_PREVIOUS_REQUEST_UNCONFIRMED_READ_FIRST');
  const terminal=Buffer.from(JSON.stringify({version:'research-broker-result-v1',requestSha:id.requestSha,releaseSha:installed.releaseSha,finishedAt:new Date().toISOString(),code:1,overflow:false,stdout:'',stderr:'synthetic terminal refusal',automaticWriteRetry:false})+'\n');write(receipt,terminal);
  const replay=broker.readExistingJournal(args);a.equal(replay.resultCode,1);a.equal(replay.resultOverflow,false);a.deepEqual(Buffer.from(replay.envelope.originalReceiptBase64,'base64'),terminal);a.equal(replay.envelope.originalReceiptSha256,p.sha(terminal));checks++;
  refuses(()=>broker.readExistingJournal({...args,requestSha:changed.requestSha}),'RESEARCH_RECEIPT_BINDING');
  refuses(()=>broker.syncNew(receipt,Buffer.from('replace')),'EEXIST');a.deepEqual(fs.readFileSync(receipt),terminal);
  a.deepEqual(fs.readFileSync(originalIntent),intentBytes);a.deepEqual(fs.readFileSync(originalReceipt),receiptBytes);
  // Real directory/statfs admission retains the existing capacity and file
  // identity limits. No production capacity is assumed from this fixture.
  const budgetFile=path.join(budgetDir,'c'.repeat(64)+'.intent.json');write(budgetFile,'x');journalBudget(budgetDir,1);
  fs.chmodSync(budgetFile,0o640);refuses(()=>journalBudget(budgetDir,1),'RESEARCH_JOURNAL_FILE_IDENTITY');fs.chmodSync(budgetFile,0o600);
  fs.truncateSync(budgetFile,4*1024*1024+1);refuses(()=>journalBudget(budgetDir,1),'RESEARCH_JOURNAL_FILE_BOUND');fs.truncateSync(budgetFile,1);
  refuses(()=>journalBudget(budgetDir,5*1024*1024+1),'RESEARCH_JOURNAL_CAPACITY');
  // Kernel exclusivity is exercised by two real util-linux flock processes,
  // and the holder is checked through the production fdinfo validator.
  const lock=path.join(dir,'isolated.lock'),ready=path.join(dir,'lock-ready');write(lock,'lock');
  const lockModule=path.resolve(__dirname,'../server/researchReleaseLock.cjs');
  const program='const fs=require("node:fs");require('+JSON.stringify(lockModule)+').findHeldReleaseLock({lockPath:'+JSON.stringify(lock)+'});fs.writeFileSync('+JSON.stringify(ready)+',"held",{mode:0o600});setTimeout(()=>{},1500);';
  const child=cp.spawn('/usr/bin/flock',['--no-fork','--exclusive','--nonblock',lock,process.execPath,'-e',program],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  try{
   const start=Date.now();while(!fs.existsSync(ready)&&Date.now()-start<3000&&child.exitCode===null)await new Promise(r=>setTimeout(r,20));a.ok(fs.existsSync(ready),stderr);
   const denied=cp.spawnSync('/usr/bin/flock',['--no-fork','--exclusive','--nonblock',lock,process.execPath,'-e','process.exit(0)'],{encoding:'utf8',timeout:2000});a.equal(denied.status,1,denied.stderr);checks++;
   const done=await ended;a.equal(done.code,0,stderr);a.equal(done.signal,null);
   const allowed=cp.spawnSync('/usr/bin/flock',['--no-fork','--exclusive','--nonblock',lock,process.execPath,'-e','require('+JSON.stringify(lockModule)+').findHeldReleaseLock({lockPath:'+JSON.stringify(lock)+'})'],{encoding:'utf8',timeout:2000});a.equal(allowed.status,0,allowed.stderr);checks++;
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}}
  return {ok:true,scope:'isolated-linux-root-filesystem-and-flock',checks,realRootOwnerModeAncestorSymlinkHardlinkRefusals:true,actualSyncNewFileAndDirectoryFsync:true,exclusiveCreatePreservesOriginals:true,unknownIntentRefused:true,changedOuterCannotExecuteAgain:true,terminalReceiptReplayExact:true,originalFailureBytesPreserved:true,journalBudgetActualFilesystem:true,kernelExclusiveLock:true,productionRootBrokerEndToEnd:false,productionWrites:0};
 }finally{
  a.equal(fs.realpathSync(dir),dir);a.equal(path.dirname(dir),'/var/lib');a.ok(path.basename(dir).startsWith('football-research-freshness-fixture-'));fs.rmSync(dir,{recursive:true});
 }
}
if(require.main===module)verify().then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={verify};
