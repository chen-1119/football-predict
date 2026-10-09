'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs');
const {validate}=require('../scripts/releaseOwnedWorkerStop.cjs');
const sha='a'.repeat(64),sourceHash='b'.repeat(64),unit='football-sync-worker.service';
function fixture(){const before={LoadState:'loaded',ActiveState:'active',SubState:'running',MainPID:'1234',ControlPID:'0',ControlGroup:'/system.slice/'+unit,InvocationID:'c'.repeat(32),Result:'success',Job:'0'};return {intent:{version:'owned-worker-stop-v1',sha,sourceHash,unit,createdAt:1000000,uptime:1000,before},current:{...before,ActiveState:'failed',SubState:'failed',MainPID:'0',Result:'timeout'},options:{sha,sourceHash,now:1060000,uptime:1060,populated:false,pidAlive:false}};}
test('own timeout remains failed while exact drained invocation is accepted',()=>{const f=fixture();a.equal(validate(f.intent,f.current,f.options).workerState,'failed-timeout-retained');a.equal(f.current.ActiveState,'failed');});
test('systemd empty Job serialization means no queued job',()=>{const f=fixture();f.intent.before.Job='';f.current.Job='';a.equal(validate(f.intent,f.current,f.options).writerDrained,true);});
for(const [name,change]of [
 ['foreign release',f=>f.options.sha='d'.repeat(64)],['foreign verifier',f=>f.options.sourceHash='d'.repeat(64)],
 ['restarted invocation',f=>f.current.InvocationID='d'.repeat(32)],['other failure',f=>f.current.Result='exit-code'],
 ['transition',f=>f.current.ActiveState='deactivating'],['main process',f=>f.current.MainPID='12'],
 ['control process',f=>f.current.ControlPID='12'],['pending job',f=>f.current.Job='55'],
 ['populated group',f=>f.options.populated=true],['original pid alive',f=>f.options.pidAlive=true],
 ['expired wall clock',f=>f.options.now=2000000],['expired monotonic clock',f=>f.options.uptime=2000],
 ['future clock',f=>f.options.now=999999],['foreign cgroup',f=>f.current.ControlGroup='/system.slice/another.service'],
 ['preexisting failure',f=>f.intent.before.ActiveState='failed'],['missing invocation',f=>f.intent.before.InvocationID=''],
 ['unowned unit',f=>f.intent.unit='another.service']
])test('reject '+name,()=>{const f=fixture();change(f);a.throws(()=>validate(f.intent,f.current,f.options));});
test('signed shell captures before its stop and never resets systemd failures',()=>{const s=fs.readFileSync(require.resolve('../deploy/light-server/release-from-bundle.sh'),'utf8');const begin=s.indexOf('stop_worker_for_release_window()'),end=s.indexOf('\nstop_service_for_release_window()',begin),body=s.slice(begin,end);a(body.indexOf('releaseOwnedWorkerStop.cjs" capture')<body.indexOf('WORKER_STOPPED_FOR_SWAP=1'));a(!body.includes('reset-failed'));a(s.includes('releaseOwnedWorkerStop.cjs" verify'));const module=fs.readFileSync(require.resolve('../scripts/releaseOwnedWorkerStop.cjs'),'utf8');a(!module.includes('reset-failed'));a(module.includes("fs.openSync(file,'wx',0o600)"));a(module.includes('fs.fsyncSync(fd)'));a(module.includes('a.deepEqual(state(),before);emptyGroup()'));});
