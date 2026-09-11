'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {remote}=require('./repairRemoteTransport.cjs');
const {evaluateWorkerPreflight,collectWorkerPreflight}=require('./releaseWorkerPreflight.cjs');
const id=process.argv[2];assert.match(id||'',/^[a-f0-9]{64}$/);
const code=String.raw`const fs=require('fs'),assert=require('node:assert/strict'),cp=require('child_process');
EVALUATOR
COLLECTOR
(async()=>{const id=CAPSULE_ID,dir='/var/lib/football-release/foundation-repairs/'+id;
const c=require(dir+'/controller.cjs'),plan=c.load(dir,false),accepted=JSON.parse(fs.readFileSync(dir+'/accepted.json','utf8'));
assert.equal(accepted.ok,true);assert.equal(accepted.repairSha256,id);
const marker=JSON.parse(fs.readFileSync('/opt/football-predict/.foundation-repair.json','utf8'));assert.equal(marker.phase,'accepted');assert.equal(marker.repairSha256,id);
for(const f of plan.files)assert.equal(cp.execFileSync('sha256sum',['/opt/football-predict/'+f.path],{encoding:'utf8'}).split(' ')[0],f.sha256);
const frontend=require('/usr/local/libexec/football-release-frontend/frontendReleaseController.cjs'),health=await frontend.health(frontend.publicBase());
const admission=evaluateWorkerPreflight(collectWorkerPreflight());
assert.equal(admission.ok,true,'ordinary early release admission is still blocked');
const pending=fs.existsSync('/var/lib/football-release/recovery/current');assert.equal(pending,false);
for(const k of ['serviceOk','dataFresh','sourceHealthOk','fastResultIntegrityOk','recommendationProjectionParityOk'])assert.equal(health.status[k],true);
assert.ok(health.status.officialSourceRedundancy?.collectorEvidenceStore?.trustedCollectorCount>=2,'current signed collector evidence is incomplete');
assert.equal(health.status.recommendationReliable,false);
const status=JSON.parse(fs.readFileSync('/var/lib/football-predict/sync-worker-status.json','utf8'));
console.log(JSON.stringify({ok:true,checkedAt:new Date().toISOString(),baseRuntimeSha256:plan.baseRuntimeSha256,repairSha256:id,
  acceptedAt:accepted.checkedAt,official:accepted.official,continuity:accepted.continuity,health:health.status,admission,
  latestWorker:{pid:status.pid,checkedAt:status.checkedAt,phase:status.phase,lastCycle:status.lastCycle,eventCycle:status.eventCycle},
  codeHashesVerified:plan.files.length,liveSnapshotBytes:fs.statSync('/opt/football-predict/public/data/prediction-snapshots.json').size,
  recoveryPending:pending,productionWrites:0,fullReleaseDeployed:false}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});`
.replace('EVALUATOR',()=>evaluateWorkerPreflight.toString()).replace('COLLECTOR',()=>collectWorkerPreflight.toString()).replace('CAPSULE_ID',JSON.stringify(id));
const r=remote(code,{prefix:'foundation-live-verification'});
if(r.exitCode!==0){console.log(JSON.stringify(r));process.exitCode=1;}else{
const v=JSON.parse(r.stdout);console.log(JSON.stringify({output:r.output,ok:v.ok,checkedAt:v.checkedAt,repairSha256:v.repairSha256,
  acceptedAt:v.acceptedAt,officialPublishedAt:v.official.event.finishedAt,continuity:v.continuity,
  health:{serviceOk:v.health.serviceOk,dataFresh:v.health.dataFresh,sourceHealthOk:v.health.sourceHealthOk,
    collectors:v.health.officialSourceRedundancy.collectorEvidenceStore.trustedCollectorCount,fastResultIntegrityOk:v.health.fastResultIntegrityOk,
    recommendationProjectionParityOk:v.health.recommendationProjectionParityOk,modelRiskStable:v.health.modelRiskStable,recommendationReliable:v.health.recommendationReliable},
  admission:v.admission,liveSnapshotBytes:v.liveSnapshotBytes,codeHashesVerified:v.codeHashesVerified,recoveryPending:v.recoveryPending,fullReleaseDeployed:false}));}
