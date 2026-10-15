'use strict';
// Isolated Linux kernel fixture. Never opens the production lock or database.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),a=require('node:assert/strict');
function verify(){
 a.equal(process.platform,'linux');a.equal(process.getuid(),0);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-baseline-authority-lock-')),lock=path.join(dir,'release.lock'),file=path.join(dir,'child.cjs'),modulePath=path.resolve(__dirname,'baselineAuthorityReplayRepair.cjs');
 try{
  fs.writeFileSync(lock,'');
  const code=`const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict'),m=require(${JSON.stringify(modulePath)}),lock=${JSON.stringify(lock)};const proof=m.heldAncestorLock(process.pid,lock);a.equal(proof.ownerPid,process.pid);a.throws(()=>m.heldAncestorLock(1,lock));const st=fs.statSync(lock),fd=fs.readdirSync('/proc/self/fd').map(Number).find(n=>{try{const s=fs.fstatSync(n);return s.dev===st.dev&&s.ino===st.ino}catch{return false}});a(Number.isSafeInteger(fd));const nested=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`const m=require(${JSON.stringify(modulePath)});process.stdout.write(JSON.stringify(m.heldAncestorLock(Number(process.argv[1]),${JSON.stringify(lock)})));`)},String(process.pid)],{stdio:['ignore','pipe','pipe',fd],encoding:'utf8'});a.equal(nested.status,0,nested.stderr);a.equal(JSON.parse(nested.stdout).ownerPid,process.pid);a.equal(cp.spawnSync('/usr/bin/flock',['-n','-E','75',lock,'/usr/bin/true']).status,75);console.log('ancestor-exclusive-lock-confirmed');`;
  fs.writeFileSync(file,code);
  const plain=cp.spawnSync(process.execPath,['-e',`try{require(${JSON.stringify(modulePath)}).heldAncestorLock(process.pid,${JSON.stringify(lock)});process.exit(7)}catch{process.stdout.write('rejected')}`],{encoding:'utf8'});a.equal(plain.status,0);a.equal(plain.stdout,'rejected');
  const shared=cp.spawnSync('/usr/bin/flock',['--no-fork','--shared',lock,process.execPath,file],{encoding:'utf8'});a.notEqual(shared.status,0);
  const exclusive=cp.spawnSync('/usr/bin/flock',['--no-fork','--exclusive',lock,process.execPath,file],{encoding:'utf8'});a.equal(exclusive.status,0,exclusive.stderr);a.match(exclusive.stdout,/ancestor-exclusive-lock-confirmed/);
  const shellChild=path.join(dir,'shell-child.cjs');
  fs.writeFileSync(shellChild,`const a=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process'),m=require(${JSON.stringify(modulePath)}),lock=${JSON.stringify(lock)},owner=Number(process.argv[2]);const p=m.heldAncestorLock(owner,lock);a.equal(p.ownerPid,owner);a.equal(cp.spawnSync('/usr/bin/flock',['-n','-E','75',lock,'/usr/bin/true']).status,75);const detached=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs'),m=require(${JSON.stringify(modulePath)});fs.openSync(${JSON.stringify(lock)},'r');try{m.heldAncestorLock(Number(process.argv[1]),${JSON.stringify(lock)});process.exit(9)}catch{process.stdout.write('unlocked-inode-rejected')}`)},String(owner)],{encoding:'utf8',stdio:['ignore','pipe','pipe']});a.equal(detached.status,0,detached.stderr);a.equal(detached.stdout,'unlocked-inode-rejected');console.log('actual-shell-fd9-and-command-substitution-confirmed');`);
  const shell=cp.spawnSync('/bin/bash',['-c','set -e; exec 9>"$1"; /usr/bin/flock -n 9; proof="$("$2" "$3" "$$")"; printf "%s\\n" "$proof"','bash',lock,process.execPath,shellChild],{encoding:'utf8'});a.equal(shell.status,0,shell.stderr);a.match(shell.stdout,/actual-shell-fd9-and-command-substitution-confirmed/);
  a.equal(cp.spawnSync('/usr/bin/flock',['-n',lock,'/usr/bin/true']).status,0);
  return{ok:true,scope:'isolated-linux-root-ancestor-exclusive-flock',unheldRejected:true,sharedRejected:true,wrongAncestorRejected:true,inheritedChildVerified:true,actualShellFd9Verified:true,independentlyOpenedInodeRejected:true,competitorRejected:true,productionWrites:0};
 }finally{a(dir.startsWith(path.join(os.tmpdir(),'football-baseline-authority-lock-')));fs.rmSync(dir,{recursive:true,force:true});}
}
if(require.main===module){try{console.log(JSON.stringify(verify()));}catch(e){console.error(e);process.exitCode=1;}}
module.exports={verify};
