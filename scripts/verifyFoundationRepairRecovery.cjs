'use strict';
// Failure injection exercises the actual controller against disposable Linux files.
// systemctl is replaced; the test can neither address production paths nor restart a real service.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),Module=require('node:module'),assert=require('node:assert/strict');
async function verifyRecovery(controllerSource,policy) {
  assert.equal(process.platform,'linux');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'foundation-recovery-test-'));
  const app=root+'/app',store=root+'/store',release=root+'/release',calls=[];
  for(const p of [app,store,release])fs.mkdirSync(p);
  fs.writeFileSync(store+'/new-observation.json','must retain this new publication');
  const states=new Map(),fakeCp={execFileSync(command,args){
    if(command==='/usr/bin/sha256sum')return crypto.createHash('sha256').update(fs.readFileSync(args[1])).digest('hex')+'  '+args[1];
    assert.equal(command,'/usr/bin/systemctl','test forbids external commands');calls.push(args);
    if(args[0]==='show')return(states.get(args[1])||'inactive')+'\n';
    if(args[0]==='stop'){states.set(args[1],'inactive');return '';}
    if(args[0]==='start'){states.set(args[1],'active');return '';}
    throw Error('unexpected systemctl command');
  }};
  const source=controllerSource.replace("const APP='/opt/football-predict', STORE='/var/lib/football-predict', RELEASE='/var/lib/football-release';",
    `const APP=${JSON.stringify(app)}, STORE=${JSON.stringify(store)}, RELEASE=${JSON.stringify(release)};`);
  assert.notEqual(source,controllerSource);
  const m=new Module(root+'/controller.cjs');m.filename=root+'/controller.cjs';
  m.require=name=>name==='node:child_process'?fakeCp:name==='./foundationRepairPolicy.cjs'?policy:require(name);
  m._compile(source,m.filename);const {recover,compareObjects}=m.exports;let cases=0;
  async function fixture(name,{swap=true,accepted=false,unrelated=false}={}) {
    const dir=release+'/'+name;fs.mkdirSync(dir);fs.mkdirSync(dir+'/backup');fs.mkdirSync(dir+'/backup/app');
    const p={files:[{path:'existing.cjs',beforeSha256:policy.hash('original'),sha256:policy.hash('patched')},
      {path:'new.cjs',beforeSha256:null,sha256:policy.hash('new reader')}]};
    fs.writeFileSync(dir+'/backup/app/existing.cjs','original');
    fs.writeFileSync(app+'/existing.cjs',unrelated?'unrelated':swap?'patched':'original');
    if(swap){fs.writeFileSync(app+'/new.cjs','new reader');fs.writeFileSync(app+'/.foundation-repair.json','{}');fs.writeFileSync(dir+'/code-swap-started.json','{}');}
    fs.writeFileSync(dir+'/activation-started.json',JSON.stringify({units:{'football-predict.service':'active','football-sync-worker.service':'active','football-monitor.timer':'inactive'}}));
    if(accepted)fs.writeFileSync(dir+'/accepted.json','{}');
    return {dir,p};
  }
  let f=await fixture('partial-swap');await recover(f.dir,f.p);
  assert.equal(fs.readFileSync(app+'/existing.cjs','utf8'),'original');assert.equal(fs.existsSync(app+'/new.cjs'),false);
  assert.equal(fs.readFileSync(store+'/new-observation.json','utf8'),'must retain this new publication');
  assert.equal(states.get('football-predict.service'),'active');assert.equal(states.has('football-monitor.timer'),false);cases++;
  const count=calls.length;await recover(f.dir,f.p);assert.equal(calls.length,count);cases++;
  f=await fixture('pre-swap',{swap:false});await recover(f.dir,f.p);assert.equal(fs.readFileSync(app+'/existing.cjs','utf8'),'original');cases++;
  f=await fixture('unrelated',{unrelated:true});await assert.rejects(()=>recover(f.dir,f.p),/unrelated code/);
  assert.equal(fs.readFileSync(app+'/existing.cjs','utf8'),'unrelated');assert.equal(fs.existsSync(f.dir+'/recovered.json'),false);cases++;
  f=await fixture('accepted',{accepted:true});await recover(f.dir,f.p);assert.equal(fs.readFileSync(app+'/existing.cjs','utf8'),'patched');cases++;
  const before={frozen:{event:'hash'},decisions:['d'],evidence:['e'],pointer:{id:'old'}},after={frozen:{event:'hash',new:'added'},decisions:['d','new'],evidence:['e','new'],pointer:{id:'new'}};
  assert.equal(compareObjects(before,after).frozenPreserved,1);cases++;
  for(const mutate of [x=>x.frozen.event='changed',x=>x.decisions=[],x=>x.evidence=[]]){const changed=structuredClone(after);mutate(changed);assert.throws(()=>compareObjects(before,changed));cases++;}
  const pending={...before,mutableDecisions:['d','pending-d'],mutableEvidence:['e','pending-e']};
  assert.throws(()=>compareObjects(pending,after),/mutable/);cases++;
  assert.equal(compareObjects(pending,{...after,decisions:['d','pending-d'],evidence:['e','pending-e']}).mutableEvidencePreserved,2);cases++;
  return {ok:true,cases,fixture:root,productionWrites:0,realServiceCalls:0};
}
module.exports={verifyRecovery};
