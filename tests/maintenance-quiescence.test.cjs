'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const source=fs.readFileSync(path.join(__dirname,'../deploy/light-server/release-from-bundle.sh'),'utf8').replace(/\r/g,'');
const start=source.indexOf('quiesce_managed_maintenance_for_sqlite_snapshot() {');
const body=source.slice(start,source.indexOf('\nenable_managed_timers_after_readiness()',start));
function run(state,status,{after='inactive',afterStatus=3,stopStatus=0}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-maintenance-test-'));
 try{
 const input=`set -euo pipefail
MANAGED_TIMERS=(fixture.timer)
systemctl() {
 local name="$2"
 if [ "$1" = stop ]; then printf '%s\\n' "$name" >> stops; [ ${stopStatus} = 0 ] || return ${stopStatus}; touch "$name.stopped"; return 0; fi
 if [ -e "$name.stopped" ]; then printf '%s\\n' '${after}'; return ${afterStatus}; fi
 printf '%s\\n' '${state}'; return ${status}
}
${body}
quiesce_managed_maintenance_for_sqlite_snapshot
`;
 const r=cp.spawnSync(process.platform==='win32'?'D:/app/Git/bin/bash.exe':'/bin/bash',['--noprofile','--norc','-s'],{cwd:dir,input,encoding:'utf8',timeout:5000,windowsHide:true});
 return {status:r.status,stops:fs.existsSync(path.join(dir,'stops'))?fs.readFileSync(path.join(dir,'stops'),'utf8').trim().split('\n'):[]};
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
for(const state of ['activating','deactivating'])test(state+' exit3 is stopped and strictly rechecked',()=>{const r=run(state,3);a.equal(r.status,0);a.equal(r.stops.length,5);});
test('active exit0 stops exact units',()=>a.equal(run('active',0).status,0));
test('inactive exit3 has no mutation',()=>{const r=run('inactive',3);a.equal(r.status,0);a.equal(r.stops.length,0);});
for(const [state,status]of [['unknown',4],['activating',0],['active',3],['inactive',0]])test('reject contradictory '+state+'/'+status,()=>a.notEqual(run(state,status).status,0));
test('stop failure aborts',()=>a.notEqual(run('activating',3,{stopStatus:1}).status,0));
test('remaining transition aborts',()=>a.notEqual(run('activating',3,{after:'activating'}).status,0));
test('failed terminal state is retained without resetting it',()=>a.equal(run('activating',3,{after:'failed'}).status,0));
