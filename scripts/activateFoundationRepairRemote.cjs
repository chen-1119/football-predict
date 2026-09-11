'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {remote,environment}=require('./repairRemoteTransport.cjs');
const {verify,hash}=require('./foundationRepairPolicy.cjs');
const local=path.resolve(process.argv[2]),bytes=fs.readFileSync(local+'/capsule.json');
verify(bytes,fs.readFileSync(local+'/capsule.sig'),fs.readFileSync(environment().RELEASE_SIGNING_PUBLIC_KEY));
const id=hash(bytes);assert.equal(path.basename(local),'capsule-'+id);
const r=remote(String.raw`const cp=require('node:child_process'),fs=require('node:fs'),assert=require('node:assert/strict');
const id=CAPSULE_ID,dir='/var/lib/football-release/foundation-repairs/'+id;
const c=require(dir+'/controller.cjs'),p=c.load(dir);c.unchanged(p);
const prepared=JSON.parse(fs.readFileSync(dir+'/prepared.json','utf8'));assert.equal(prepared.ok,true);
assert.equal(fs.existsSync(dir+'/activation-started.json'),false);
const unit='football-foundation-activate-'+id.slice(0,12),node='/opt/node-v22.22.1/bin/node';
const result=cp.execFileSync('/usr/bin/systemd-run',['--unit='+unit,'--property=Type=exec','--property=RuntimeMaxSec=3600',
  '--property=TimeoutStopSec=180','--property=MemoryMax=2G','--property=MemorySwapMax=256M','--property=Nice=10',
  '--property=ExecStopPost='+node+' '+dir+'/controller.cjs recover '+dir,
  '/usr/bin/flock','-n','/run/lock/football-release.lock',node,dir+'/controller.cjs','activate',dir],{encoding:'utf8'});
console.log(JSON.stringify({ok:true,dispatched:true,accepted:false,unit,directory:dir,result}));`.replace('CAPSULE_ID',JSON.stringify(id)),{prefix:'foundation-activation-dispatch'});
console.log(JSON.stringify(r));if(r.exitCode!==0)process.exitCode=1;
