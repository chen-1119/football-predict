'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const pinApi=require('./releaseSshHostKeyPin.cjs'),{planCapacity}=require('./nativeReleaseCapacity.cjs');
const dataPolicy=require('./releaseDataPlanePolicy.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function validate(report,sourceHash,now=Date.now(),expectedCandidate=null){
  assert.equal(report.version,'release-capacity-preflight-v1');assert.equal(report.sourceHash,sourceHash);
  assert.equal(report.productionWrites,0);assert.equal(report.spaceReserved,false);assert.equal(report.readyToCutover,false);
  const age=now-Date.parse(report.observation.observedAt);assert(Number.isFinite(age)&&age>=-5000&&age<=60000,'capacity-observation-stale');
  let mode='database';
  if(expectedCandidate){
    assert.deepEqual(report.dataPlane?.candidate,expectedCandidate,'capacity-candidate-contract-mismatch');
    const selection=dataPolicy.classify(report.dataPlane.baseline,expectedCandidate);
    assert.deepEqual(report.dataPlane.selection,selection);mode=selection.mode;
  } else assert.equal(report.dataPlane,undefined,'unbound-data-plane-report');
  const expected=planCapacity(report.observation,mode);assert.deepEqual(report.capacity,expected,'capacity-recompute-mismatch');
  assert.equal(report.ok,expected.ok);return report;
}
function runLiveCapacityPreflight(){
  const rootDir=path.resolve(__dirname,'..'),tmpDir=path.join(rootDir,'.codex-tmp');
  const host=process.env.RELEASE_DEPLOY_HOST||'134.175.132.183',user=process.env.RELEASE_DEPLOY_USER||'ubuntu';
  assert.match(user,/^[a-z_][a-z0-9_-]*$/i);const port=Number(process.env.RELEASE_DEPLOY_PORT||22);
  const keyPath=path.resolve(process.env.RELEASE_DEPLOY_KEY||path.join(tmpDir,'football.pem'));
  assert(fs.statSync(keyPath).isFile());const pin=pinApi.resolveReleaseSshHostKeyPin({rootDir,tmpDir,host,port});
  const source=fs.readFileSync(path.join(__dirname,'nativeReleaseCapacity.cjs'),'utf8');
  const policySource=fs.readFileSync(path.join(__dirname,'releaseDataPlanePolicy.cjs'),'utf8');
  const candidate=dataPolicy.capture(rootDir),sourceHash=hash(source+policySource+JSON.stringify(candidate));
  // Send the reviewed local observer, loading only built-ins remotely. No APP code or credentials are read.
  const program='const m={exports:{}},p={exports:{}};(function(module,exports){'+source+'\n})(m,m.exports);(function(module,exports){'+policySource+'\n})(p,p.exports);const candidate='+JSON.stringify(candidate)+';const baseline=p.exports.capture("/opt/football-predict");const selection=p.exports.classify(baseline,candidate);const observation=m.exports.observeCapacity();const capacity=m.exports.planCapacity(observation,selection.mode);console.log(JSON.stringify({version:"release-capacity-preflight-v1",sourceHash:'+JSON.stringify(sourceHash)+',dataPlane:{baseline,candidate,selection},observation,capacity,ok:capacity.ok,productionWrites:0,spaceReserved:false,readyToCutover:false}));';
  const child=spawnSync('ssh',['-p',String(port),...pinApi.buildPinnedSshBaseOptions({keyPath,pin}),`${user}@${host}`,
    'sudo','-n','/usr/bin/env','-i','PATH=/usr/bin:/bin','/opt/node-v22.22.1/bin/node','-'],
  {input:program,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:65536});
  assert(!child.error&&!child.signal&&child.status===0,'capacity-transport-unavailable');
  return validate(JSON.parse(child.stdout),sourceHash,Date.now(),candidate);
}
module.exports={runLiveCapacityPreflight,validate};
if(require.main===module){try{const report=runLiveCapacityPreflight();console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}
catch{console.error(JSON.stringify({ok:false,reason:'capacity-preflight-unavailable',productionWrites:0,readyToCutover:false}));process.exitCode=1;}}
