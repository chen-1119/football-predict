'use strict';
const test=require('node:test'),a=require('node:assert/strict'),{PassThrough}=require('node:stream');
const {POLICY:p,validate,readProof,authorityRoute}=require('../scripts/baselineAuthorityReplayRepair.cjs');
function state(){return{baselineSha:p.baselineSha,candidateSha:'a'.repeat(64),ownerPid:22,flock:{ownerPid:20,device:'1',inode:'2'},bootId:'00000000-0000-0000-0000-000000000000',wallMs:1900000000000,monotonicNs:'1000000000',oldError:'RECOMMENDATION_AUTHORITY_REVIEWED_VIEW_REPLAY',candidateVerified:true,originalRecords:13,oid:p.oid,readonly:'on',payloadSha:p.payloadSha,ackSha:p.ackSha,dataPlane:'code-only',api:{MainPID:String(p.apiPid),InvocationID:p.apiInvocation,ActiveState:'active',User:'football',ControlPID:'0',ControlGroup:'/system.slice/football-predict.service',NoNewPrivileges:'yes'},worker:{MainPID:String(p.workerPid),InvocationID:p.workerInvocation,ActiveState:'active'},publication:{mode:'active-generation',generationId:'g-'+'b'.repeat(64),manifestHash:'b'.repeat(64),sourceCycleId:'synthetic',committedAt:'2030-01-01T00:00:00.000Z'}};}
test('the exact broken baseline admits only readonly preparation with all false health flags retained',()=>{const v=validate(state(),'initial');a.equal(v.baselineHealthy,false);a.equal(v.productionDataWrites,0);a.equal(v.workerBlockersBypassed,false);a.equal(v.candidateHealthStillRequired,true);});
for(const[name,change]of [['other release',s=>s.baselineSha='c'.repeat(64)],['other API incarnation',s=>s.api.InvocationID='other'],['other worker',s=>s.worker.MainPID='10'],['different database',s=>s.oid='1'],['write transaction',s=>s.readonly='off'],['changed original',s=>s.payloadSha='0'.repeat(64)],['changed ACK',s=>s.ackSha='0'.repeat(64)],['different failure',s=>s.oldError='SOME_OTHER_FAILURE'],['failed candidate',s=>s.candidateVerified=false],['changed denominator',s=>s.originalRecords=14],['migration',s=>s.dataPlane='migration'],['arbitrary program',s=>s.program='/bin/sh'],['incomplete generation',s=>s.publication.sourceCycleId='']])test('reject '+name,()=>{const s=state();change(s);a.throws(()=>validate(s,'initial'));});
function paused(){const initial=state(),proof=validate(initial,'initial'),s=structuredClone(initial);s.api.MainPID='2000000';s.api.InvocationID='f'.repeat(32);s.worker.MainPID='0';s.worker.ActiveState='inactive';s.wallMs+=1000;s.monotonicNs='2000000000';return{s,proof};}
test('the controlled replacement is bounded by the same boot, parent flock and two clocks',()=>{const {s,proof}=paused();a.equal(validate(s,'paused',proof).preparationOnly,true);});
for(const[name,change]of [['wall expiry',s=>s.wallMs+=900001],['monotonic expiry',s=>s.monotonicNs='902000000001'],['wall rollback',s=>s.wallMs-=2000],['monotonic rollback',s=>s.monotonicNs='0'],['other lock',s=>s.flock.inode='3'],['other boot',s=>s.bootId='11111111-1111-1111-1111-111111111111'],['other parent',s=>s.ownerPid=23],['running worker',s=>s.worker.MainPID=String(p.workerPid)],['unreplaced API',s=>s.api.MainPID=String(p.apiPid)]])test('paused proof rejects '+name,()=>{const {s,proof}=paused();change(s);a.throws(()=>validate(s,'paused',proof));});
test('proof wire preserves JSON and rejects oversize bytes before execution',async()=>{const good=new PassThrough(),read=readProof(good);good.end(Buffer.from('{"proof":1}'));a.deepEqual(await read,{proof:1});const bad=new PassThrough(),rejected=readProof(bad);bad.end(Buffer.alloc(8193));await a.rejects(rejected,/BOUND/);});
test('proof wire times out when the root producer never finishes',async()=>{const input=new PassThrough();await a.rejects(readProof(input),/TIMEOUT/);});
test('a verified current healthy authority requests the original normal health gate without a repair proof',()=>{
 const healthy={mode:'reviewed-and-trained',activeValidation:{ok:true},availableForCurrentDay:true,businessDate:'2026-10-16',currentBusinessDate:'2026-10-16'};
 a.equal(authorityRoute(healthy,undefined,'initial'),'normal-health-required');
 a.equal(authorityRoute(null,'RECOMMENDATION_AUTHORITY_REVIEWED_VIEW_REPLAY','initial'),'repair');
 a.equal(authorityRoute(null,'RECOMMENDATION_AUTHORITY_REVIEWED_VIEW_REPLAY','paused'),'repair');
});
test('unknown failures, stale or invalid authority, and a recovered paused repair cannot choose the normal route',()=>{
 const healthy={mode:'reviewed-and-trained',activeValidation:{ok:true},availableForCurrentDay:true,businessDate:'2026-10-16',currentBusinessDate:'2026-10-16'};
 for(const error of ['RECOMMENDATION_AUTHORITY_CENTER_CLOCK','BASELINE_PEER_EXIT',null,''])a.throws(()=>authorityRoute(healthy,error,'initial'));
 for(const change of [v=>v.activeValidation.ok=false,v=>v.mode='untrusted',v=>v.availableForCurrentDay=false,v=>v.businessDate='2026-10-15']){const v=structuredClone(healthy);change(v);a.throws(()=>authorityRoute(v,undefined,'initial'));}
 a.throws(()=>authorityRoute(null,undefined,'initial'));a.throws(()=>authorityRoute(healthy,undefined,'paused'));
});
test('the actual shell branch requires normal health after status 3 and retains rejection for every other failure',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'baseline-normal-route-'));
 try{
  fs.mkdirSync(path.join(root,'bin'));fs.mkdirSync(path.join(root,'app'));
  fs.writeFileSync(path.join(root,'app/.release-bundle-sha256'),p.baselineSha+'\n');
  fs.writeFileSync(path.join(root,'bin/node'),'#!/bin/sh\nprintf \'{"fixture":true}\'\nexit "$FIXTURE_STATUS"\n',{mode:0o755});
  const source=fs.readFileSync(path.join(__dirname,'../deploy/light-server/release-native.sh'),'utf8').replace(/\r\n?/g,'\n');
  const start=source.indexOf('  NATIVE_BASELINE_AUTHORITY_REPAIR_PROOF=""\n'),end=source.indexOf('  prepare_managed_tree_topology_for_transaction',start);a(start>0&&end>start);
  let bash='/bin/bash';
  if(process.platform==='win32'){
   const configured=process.env.VERIFY_BASH_EXECUTABLE||process.env.RELEASE_TEST_BASH;
   const found=cp.spawnSync('where.exe',['git.exe'],{encoding:'utf8',timeout:5000,windowsHide:true});
   bash=configured||String(found.stdout||'').trim().split(/\r?\n/).filter(Boolean).flatMap(file=>[path.resolve(path.dirname(file),'../bin/bash.exe'),path.resolve(path.dirname(file),'../usr/bin/bash.exe')]).find(file=>fs.existsSync(file));
  }
  a(bash&&fs.existsSync(bash),'real Bash is required; shell cases are never skipped');
  const shellPath=p=>process.platform==='win32'?path.resolve(p).replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase()):p;
  const script='log(){ printf "%s\\n" "$*"; }; wait_for_health(){ printf "NORMAL_HEALTH_REQUIRED\\n"; return "$FIXTURE_HEALTH_STATUS"; }; run(){\n'+source.slice(start,end)+'\nprintf "FINAL_PROOF=%s\\n" "$NATIVE_BASELINE_AUTHORITY_REPAIR_PROOF";\n}; run';
  const execute=(status,health)=>cp.spawnSync(bash,['-c',script],{encoding:'utf8',timeout:5000,windowsHide:true,env:{...process.env,NATIVE_PLANNED_CODE:'1',APP_DIR:shellPath(path.join(root,'app')),NODE_HOME:shellPath(root),TRUSTED_SOURCE_DIR:shellPath(root),BUNDLE_SHA256:'a'.repeat(64),HOST:'127.0.0.1',PORT:'8788',FIXTURE_STATUS:String(status),FIXTURE_HEALTH_STATUS:String(health)}});
  const normal=execute(3,0);a.equal(normal.status,0,normal.stderr);a.match(normal.stdout,/NORMAL_HEALTH_REQUIRED/);a.match(normal.stdout,/FINAL_PROOF=\n/);a.doesNotMatch(normal.stdout,/baseline business health remains false/);
  const rejected=execute(3,1);a.notEqual(rejected.status,0);a.match(rejected.stdout,/NORMAL_HEALTH_REQUIRED/);a.doesNotMatch(rejected.stdout,/FINAL_PROOF/);
  const repair=execute(0,1);a.equal(repair.status,0,repair.stderr);a.doesNotMatch(repair.stdout,/NORMAL_HEALTH_REQUIRED/);a.match(repair.stdout,/FINAL_PROOF=\{"fixture":true\}/);
  for(const status of [1,2,4,124]){const result=execute(status,0);a.notEqual(result.status,0);a.doesNotMatch(result.stdout,/NORMAL_HEALTH_REQUIRED|FINAL_PROOF/);}
 }finally{a.equal(path.dirname(fs.realpathSync(root)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());fs.rmSync(root,{recursive:true});}
});
