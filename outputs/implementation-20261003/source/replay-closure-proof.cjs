'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const {auditOfficialClosedSchedule,captureOfficialClosedSchedule,auditPublishedOfficialClosedSchedule}=require(path.join(root,'scripts/officialClosedScheduleEvidence.cjs'));
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const proofPath=path.join(__dirname,'remote-empty-current-proof.json');
const raw=fs.readFileSync(proofPath),captured=JSON.parse(raw);
const snapshot={capturedAt:captured.source.capturedAt,sourceCycleId:captured.source.sourceCycleId,endpoints:captured.endpoints};
const projectionPath=path.join(__dirname,'replay-input-two-endpoint-projection.json');
if(fs.existsSync(projectionPath))throw Error('exclusive replay input already exists');
fs.writeFileSync(projectionPath,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
const registryPath=path.join(root,'deploy/light-server/collector-trust-registry.json');
const registry=JSON.parse(fs.readFileSync(registryPath,'utf8'));
const now=new Date().toISOString();
const atObservation=auditOfficialClosedSchedule(snapshot,{asOf:captured.observedAt,trustRegistry:registry});
const atReplay=auditOfficialClosedSchedule(snapshot,{asOf:now,trustRegistry:registry});
const closure=captureOfficialClosedSchedule({snapshotPath:projectionPath,trustRegistryPath:registryPath,asOf:captured.observedAt,
  publicationSourceCycleId:'local-readonly-replay-not-production',currentListEvaluatedAt:captured.observedAt});
const syncMeta={sourceCycleId:'local-readonly-replay-not-production',files:{current:0},currentListPolicy:{evaluatedAt:captured.observedAt,officialClosedSchedule:closure}};
const published=auditPublishedOfficialClosedSchedule(syncMeta,{asOf:captured.observedAt,trustRegistryPath:registryPath});
const publishedExpired=auditPublishedOfficialClosedSchedule(syncMeta,{asOf:now,trustRegistryPath:registryPath});
if(!atObservation.emptyCurrentIntegrityEligible||atReplay.emptyCurrentIntegrityEligible||!published.emptyCurrentIntegrityEligible||publishedExpired.emptyCurrentIntegrityEligible)throw Error('unexpected replay boundary');
const testRaw=cp.execFileSync(process.execPath,['tests/official-closed-schedule-evidence.test.cjs'],{cwd:root,encoding:'utf8'});
for(const file of ['scripts/officialClosedScheduleEvidence.cjs','scripts/syncData.cjs','scripts/validateData.cjs'])cp.execFileSync(process.execPath,['--check',file],{cwd:root});
const files=['scripts/officialClosedScheduleEvidence.cjs','scripts/syncData.cjs','scripts/validateData.cjs','tests/official-closed-schedule-evidence.test.cjs'];
const receipt={version:'closure-real-proof-replay-v1',replayedAt:now,node:process.version,productionWrites:false,providerRequests:0,
  sourceEvidence:{file:path.basename(proofPath),sha256:sha(raw),observedAt:captured.observedAt,transport:captured.transport,
    originalRemoteSnapshot:captured.source},
  distinction:'The replay input is the exported two-endpoint projection, not the full original remote snapshot. Its separate file hash must not be substituted for the remote full snapshot hash.',
  trustRegistry:{path:path.relative(root,registryPath),sha256:sha(fs.readFileSync(registryPath))},
  atObservation,atReplay,publishedProjectionAsOfObservation:published,publishedProjectionNow:publishedExpired,
  projectedProofBytes:Buffer.byteLength(JSON.stringify(closure.proof)),sourceCapturedAtPreserved:closure.proof.snapshot.capturedAt===captured.source.capturedAt,
  tests:JSON.parse(testRaw),syntaxChecks:files.slice(0,3).map(file=>({file,ok:true})),
  codeFiles:files.map(file=>({file,sha256:sha(fs.readFileSync(path.join(root,file)))})),
  notDeployed:true,sourceFreshnessPromoted:false,recommendationEligible:false,independentCollectorRedundancyEligible:false};
fs.writeFileSync(path.join(__dirname,'closure-proof-replay.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({ok:true,atObservation:atObservation.emptyCurrentIntegrityEligible,atReplay:atReplay.emptyCurrentIntegrityEligible,
  projectedProofBytes:receipt.projectedProofBytes,checks:receipt.tests.checks,receipt:'outputs/implementation-20261003/source/closure-proof-replay.json'},null,2));
