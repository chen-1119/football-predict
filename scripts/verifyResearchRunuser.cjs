'use strict';
// A unique disposable Linux systemd unit. No production unit, socket, database,
// signing key or credential is opened. This tests the actual UID transition.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),a=require('node:assert/strict'),crypto=require('node:crypto');
function verify(){
 a.equal(process.platform,'linux');a.equal(process.getuid(),0);a.equal(process.env.RESEARCH_ISOLATED_SYSTEMD_TEST,'1');
 const dir=fs.mkdtempSync('/var/lib/football-research-runuser-fixture-');fs.chmodSync(dir,0o755);
 const unit='football-research-runuser-fixture-'+process.pid+'-'+crypto.randomBytes(6).toString('hex'),lock=path.join(dir,'lock');
 const worker=path.join(dir,'child.cjs'),root=path.join(dir,'root.cjs'),uid=Number(cp.execFileSync('/usr/bin/id',['-u','nobody'],{encoding:'utf8'})),gid=Number(cp.execFileSync('/usr/bin/id',['-g','nobody'],{encoding:'utf8'}));
 a(uid>0&&gid>0);fs.writeFileSync(lock,'',{mode:0o644});
 try{
  fs.copyFileSync(path.resolve(__dirname,'../server/researchReleaseLock.cjs'),path.join(dir,'held-lock.cjs'));fs.chmodSync(path.join(dir,'held-lock.cjs'),0o644);
  fs.writeFileSync(worker,`const fs=require('node:fs'),a=require('node:assert/strict');a.equal(process.getuid(),${uid});a.equal(process.getgid(),${gid});const s=fs.readFileSync('/proc/self/status','utf8');a.match(s,/^NoNewPrivs:\\s+1$/m);a.match(s,/^CapEff:\\s+0+$/m);a.match(s,/^CapAmb:\\s+0+$/m);const info=fs.readFileSync('/proc/self/fdinfo/3','utf8');a.match(info,/FLOCK\\s+ADVISORY\\s+WRITE/);a.equal(fs.fstatSync(3).ino,fs.statSync(${JSON.stringify(lock)}).ino);a.equal(fs.readFileSync('/proc/self/cgroup','utf8'),'0::/system.slice/${unit}.service\\n');console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),capabilitiesCleared:true,nnp:true,inheritedLock:true,sameCgroup:true}));`,{mode:0o644});
  fs.writeFileSync(root,`const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict');a.equal(process.getuid(),0);const status=fs.readFileSync('/proc/self/status','utf8');a.match(status,/^NoNewPrivs:\\s+1$/m);const cap=BigInt('0x'+/^CapEff:\\s+(\\w+)$/m.exec(status)[1]);a.equal(cap&0xc0n,0xc0n);const fd=require(${JSON.stringify(path.join(dir,'held-lock.cjs'))}).findHeldReleaseLock({lockPath:${JSON.stringify(lock)}});const r=cp.spawnSync('/usr/sbin/runuser',['-u','nobody','--',${JSON.stringify(process.execPath)},${JSON.stringify(worker)}],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',stdio:['ignore','pipe','pipe',fd],timeout:15000});a.equal(r.status,0,r.stderr);process.stdout.write(r.stdout);`,{mode:0o644});
  const props=['User=root','Group='+gid,'NoNewPrivileges=true','RestrictSUIDSGID=true','KillMode=control-group','PrivateTmp=true','ProtectSystem=strict','ProtectHome=true','MemoryMax=512M','TasksMax=32',
   'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_SETGID CAP_SETUID CAP_SYS_PTRACE','AmbientCapabilities=CAP_SETUID CAP_SETGID'];
  const r=cp.spawnSync('/usr/bin/systemd-run',['--wait','--pipe','--collect','--unit='+unit,...props.flatMap(v=>['--property='+v]),'/usr/bin/flock','--no-fork','--exclusive','--nonblock',lock,process.execPath,root],{encoding:'utf8',timeout:45000,maxBuffer:65536});
  a.equal(r.status,0,r.stderr+'\n'+r.stdout);const result=JSON.parse(r.stdout.trim());a.equal(result.uid,uid);a.equal(result.gid,gid);
  return {ok:true,scope:'isolated-systemd-actual-runuser',...result,productionWrites:0,productionUnitAccessed:false};
 }finally{
  // Only this generated transient unit and verified fixture path may be removed.
  a.match(unit,/^football-research-runuser-fixture-\d+-[a-f0-9]{12}$/);
  cp.spawnSync('/usr/bin/systemctl',['stop',unit+'.service'],{timeout:10000,stdio:'ignore'});
  a(fs.realpathSync(dir)===dir&&path.dirname(dir)==='/var/lib'&&path.basename(dir).startsWith('football-research-runuser-fixture-'));
  fs.rmSync(dir,{recursive:true});
 }
}
if(require.main===module){try{console.log(JSON.stringify(verify()));}catch(e){console.error(e);process.exitCode=1;}}
module.exports={verify};
