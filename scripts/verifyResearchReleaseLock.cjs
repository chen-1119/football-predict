'use strict';
// Real Linux flock competition and crash lifetime, isolated temporary files.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),a=require('node:assert/strict');
async function verify(){
 a.equal(process.platform,'linux','Linux required: do not substitute a mocked lock');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-research-lock-test-')),lock=path.join(dir,'release.lock'),helper=path.join(dir,'holder.cjs'),signal=path.join(dir,'release-child');
 const modulePath=path.resolve(__dirname,'../server/researchReleaseLock.cjs');
 let holder,grandchildPid;
 try{
  fs.writeFileSync(lock,'');
  const refusal=cp.spawnSync(process.execPath,['-e',`try{require(${JSON.stringify(modulePath)}).findHeldReleaseLock({lockPath:${JSON.stringify(lock)},requireRoot:false});process.exit(9)}catch(e){process.stdout.write(e.code)}`],{encoding:'utf8'});
  a.equal(refusal.status,0);a.equal(refusal.stdout,'RESEARCH_RELEASE_LOCK_NOT_HELD');
  fs.writeFileSync(helper,`const fs=require('node:fs'),cp=require('node:child_process');const fd=require(${JSON.stringify(modulePath)}).findHeldReleaseLock({lockPath:${JSON.stringify(lock)},requireRoot:false});const child=cp.spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');const info=fs.readFileSync('/proc/self/fdinfo/3','utf8');if(!(info.includes('FLOCK')&&info.includes('ADVISORY')&&info.includes('WRITE'))){console.error('CHILD_FDINFO:'+info);process.exit(6);}console.log('CHILD:'+process.pid);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(signal)})){clearInterval(timer);process.exit(0);}},20);`)}],{stdio:['ignore','inherit','inherit',fd]});console.log('READY:'+process.pid);child.on('close',code=>process.exit(code));`);
  holder=cp.spawn('/usr/bin/flock',['--no-fork','--exclusive','--nonblock','--conflict-exit-code','75',lock,process.execPath,helper],{stdio:['ignore','pipe','pipe']});
  let text='',stderr='';holder.stderr.on('data',b=>{stderr+=b;});await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Holder timeout')),5000);holder.stdout.on('data',b=>{text+=b;if(/READY:\d+/.test(text)&&/CHILD:\d+/.test(text)){clearTimeout(timeout);resolve();}});holder.on('error',reject);holder.on('exit',code=>{if(!text.includes('CHILD:')){clearTimeout(timeout);reject(Error('Holder exited '+code+' '+stderr));}});});
  grandchildPid=Number(/CHILD:(\d+)/.exec(text)[1]);
  const competing=()=>cp.spawnSync('/usr/bin/flock',['-n','-E','75',lock,'/usr/bin/true']).status;
  a.equal(competing(),75,'Actual lock competitor must fail');
  holder.kill('SIGKILL');await new Promise(resolve=>holder.once('exit',resolve));
  a.equal(competing(),75,'Parent crash must not release a still-running child lock');
  fs.writeFileSync(signal,'release');
  const until=Date.now()+5000;while(competing()===75&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  a.equal(competing(),0,'Lock releases after child exit');
  grandchildPid=null;
  return {ok:true,scope:'isolated-linux-flock',heldFdVerified:true,unheldFdRefused:true,competitorRefused:true,parentCrashChildRetainsLock:true,releaseAfterChildExit:true,productionLockAccessed:false,productionWrites:0};
 }finally{
  holder?.kill('SIGTERM');if(grandchildPid)try{process.kill(grandchildPid,'SIGTERM');}catch{}
  a(dir.startsWith(path.join(os.tmpdir(),'football-research-lock-test-')));fs.rmSync(dir,{recursive:true,force:true});
 }
}
if(require.main===module)verify().then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={verify};
