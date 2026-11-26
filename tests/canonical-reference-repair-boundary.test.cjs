'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const repair=require('../scripts/releaseWorkerCodeRepair.cjs'),base=require('../scripts/releaseWorkerPreflight.cjs'),code=require('../scripts/nativeCodeReleaseDataPlane.cjs');
const hex=number=>String(number).repeat(64),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(){
 const now=Date.now(),clock=ago=>new Date(now-ago).toISOString();
 const service={ActiveState:'active',MainPID:'42',ExecMainStartTimestamp:new Date(now-7200000).toUTCString()};
 const identity={sourceMatchId:'2042204',eventVersion:clock(86400000),resultIdentity:'3:3|sporttery:official-api',observedAt:clock(7200000),settledAt:clock(7200000)};
 const failure={ok:false,code:'POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE',error:'Existing stable review id is not a safe result-only canonical rebase',reviewId:'review:'+hex(5),existingMatchId:'sporttery_2042204',incomingMatchId:'fivehundred_2042204',existingObservationId:'result:'+hex(6),incomingObservationId:'result:'+hex(7),existingIdentity:identity,incomingIdentity:{...identity}};
 const incident={workerMainPid:'42',workerStartedAt:new Date(service.ExecMainStartTimestamp).toISOString(),cycleStartedAt:clock(180000),cycleFinishedAt:clock(120000),journalPid:'43',journalTimestampUs:String((now-120050)*1000),journalMessageSha256:hash(JSON.stringify(failure,null,2)),failure};
 const generation=(number,age)=>({mode:'active-generation',generationId:'g-'+hex(number),manifestHash:hex(number),sourceCycleId:'cycle-'+number,committedAt:clock(age)});
 const authorization={version:'worker-code-repair-v8',reason:'official-result-canonical-identity-with-preserved-reference',bindingPolicy:'fresh-exact-identity-failure-and-unchanged-reference-before-lease-v1',createdAt:clock(600000),expiresAt:new Date(now+3600000).toISOString(),baseRuntimeSha256:hex(1),incident,
  files:repair.CANONICAL_REFERENCE_TARGETS.map(path=>({path,beforeSha256:hex(2),afterSha256:hex(path==='scripts/postgresProjectionSync.cjs'?2:3)})),
  dataContract:[...repair.DATA_FILES,'server/postgres/migrations/001_core.sql'].sort().map(path=>({path,sha256:hex(4)})),
  publication:{databaseOid:'42',committed:generation(1,3600000),rawPrevious:generation(2,1800000),rawCurrent:generation(3,900000)},
  canonicalReference:{version:'canonical-reference-preservation-proof-v1',sourceMatchId:'2042204',eventVersion:identity.eventVersion,referenceBytes:4436,referenceContentHash:hex(8),referenceSha256:hex(9)},
  canonicalReferenceSources:repair.CANONICAL_REFERENCE_SOURCES.map(path=>({path,sha256:hex(4)}))};
 const worker={checkedAt:clock(0),serviceBefore:service,serviceAfter:service,processMatches:true,status:{pid:42,checkedAt:clock(1000),ok:true,phase:'official-result',lastCycle:{ok:false,startedAt:clock(60000),finishedAt:clock(2000),phase:'official-result-failed',errorCode:'SYNC_WORKER_COMMAND_FAILED',error:'npm run postgres:sync exited with 1'}}};
 const actual={...incident,cycleStartedAt:worker.status.lastCycle.startedAt,cycleFinishedAt:worker.status.lastCycle.finishedAt,journalPid:'44',journalTimestampUs:String((now-2050)*1000)};
 const observed={runtimeSha256:hex(1),completeSha256:hex(1),recoveryPending:false,files:authorization.files.map(row=>({path:row.path,sha256:row.beforeSha256})),dataContract:structuredClone(authorization.dataContract),migrationNames:['001_core.sql'],publication:{...authorization.publication,rawPrevious:generation(5,600000),rawCurrent:generation(6,300000)},canonicalReference:structuredClone(authorization.canonicalReference),canonicalReferenceSources:structuredClone(authorization.canonicalReferenceSources),journal:JSON.stringify(failure,null,2).split('\n').map(message=>({unit:'football-sync-worker.service',pid:actual.journalPid,timestampUs:actual.journalTimestampUs,timestampMs:Number(actual.journalTimestampUs)/1000,message}))};
 return{now,authorization,worker,observed:structuredClone(observed),actual};
}
test('incident-bound reference preservation never promotes worker health or cutover readiness',()=>{
 const data=fixture(),result=repair.evaluateWorkerCodeRepair(data.authorization,data.worker,data.observed);
 assert.equal(result.ok,true);assert.equal(result.workerHealthy,false);assert.equal(result.readyToCutover,false);assert.equal(result.productionWrites,0);
 assert.deepEqual(result.workerReport.blockers,['worker-official-recovery-unproven']);assert.equal(base.evaluateWorkerPreflight(data.worker).ok,false);
 assert.deepEqual(repair.repeatedRepairIncident(data.authorization,data.worker,data.observed.journal),data.actual);
 new vm.Script(repair.buildWorkerCodeRepairProbe(data.authorization));
});
test('duplicate failure and recovery alarms require exactly the same failed cycle',()=>{
 const data=fixture();data.worker.status.ok=false;data.worker.status.phase='failed';data.worker.status.eventCycle=structuredClone(data.worker.status.lastCycle);
 const result=repair.evaluateWorkerCodeRepair(data.authorization,data.worker,data.observed);
 assert.equal(result.ok,true);assert.equal(result.workerHealthy,false);assert.equal(result.readyToCutover,false);
 assert.deepEqual(result.workerReport.blockers,['worker-latest-official-cycle-failed','worker-official-recovery-unproven']);
 for(const change of [value=>value.startedAt=new Date(Date.now()-300000).toISOString(),value=>value.error='other failure',value=>value.finishedAt=new Date(Date.now()-200000).toISOString()]){
  const changed=structuredClone(data);change(changed.worker.status.eventCycle);assert.equal(repair.evaluateWorkerCodeRepair(changed.authorization,changed.worker,changed.observed).ok,false);
 }
 data.worker.processMatches=false;assert.equal(repair.evaluateWorkerCodeRepair(data.authorization,data.worker,data.observed).ok,false);
});
test('reference collection runs in the production VM without ambient Buffer',()=>{
 const data=fixture(),identity=data.authorization.incident.failure.existingIdentity,reference={version:'public-reference-decision-v2',evidenceBinding:{verified:true},contentHash:hex(8)};
 const row={sourceMatchId:identity.sourceMatchId,eventVersion:identity.eventVersion,scoreHome:3,scoreAway:3,resultSource:'sporttery:official-api',resultObservedAt:identity.observedAt,settledAt:identity.settledAt,predictionMeta:{publicReferenceDecision:reference}};
 const incoming={...row,id:'fivehundred_2042204'},stored={...row,id:'sporttery_2042204'},bytes=Buffer.from(JSON.stringify([incoming])),stat={isFile:()=>true,nlink:1,size:bytes.length,dev:1,ino:2,mtimeMs:3,ctimeMs:4};
 let attestations=0;
 const localRequire=name=>{
  if(name==='node:fs')return{constants:{O_RDONLY:0,O_NOFOLLOW:1},openSync:()=>4,fstatSync:()=>stat,readFileSync:()=>bytes,closeSync:()=>{},lstatSync:()=>stat};
  if(name==='node:child_process')return{execFileSync:(command,args)=>{assert(args.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT payload::text FROM football.match_snapshots WHERE dataset=\'history\' AND source_match_id=\'2042204\'; ROLLBACK;'));return JSON.stringify(stored);}};
  if(name==='/fixture/src/services/publicReferenceDecision.cjs')return{attestPublicReferenceDecision:()=>{attestations++;return true;}};
  return require(name);
 };
 const source=[repair.validateResultIdentityIncident,repair.validateCanonicalReferenceProof,repair.collectCanonicalReferenceProof].map(value=>value.toString()).join('\n')+'\ncollectCanonicalReferenceProof("/fixture",'+JSON.stringify(data.authorization.incident)+')';
 const result=vm.runInNewContext(source,{require:localRequire});
 assert.equal(result.referenceSha256,hash(JSON.stringify(reference)));assert.equal(result.referenceBytes,Buffer.byteLength(JSON.stringify(reference)));assert.equal(attestations,2);
});
test('preparation transport retains failed worker and rejects malformed envelopes',()=>{
 const data=fixture(),report=repair.evaluateWorkerCodeRepair(data.authorization,data.worker,data.observed),validate=require('../scripts/runReleaseWorkerPreflight.cjs').validateRepairPreparationReport;
 assert.equal(validate(report,0,data.now),report);
 for(const change of [value=>value.ok=false,value=>value.workerHealthy=true,value=>value.readyToCutover=true,value=>value.productionWrites=1,value=>value.workerReport.ok=true,value=>value.workerReport.blockers=[],value=>value.repairPreparationAllowed=false,value=>value.checkedAt=new Date(data.now-61000).toISOString()]){
  const changed=structuredClone(report);change(changed);assert.throws(()=>validate(changed,0,data.now));
 }
 assert.throws(()=>validate(report,1,data.now));
});
const invalidAuthorization=[value=>value.reason='ignore-worker',value=>value.bindingPolicy='ignore-reference',value=>value.files.shift(),value=>value.files.reverse(),
 value=>value.files[0].afterSha256=value.files[0].beforeSha256,value=>value.files[3].afterSha256=hex(3),value=>value.canonicalReferenceSources.pop(),
 value=>value.canonicalReference.referenceBytes=65537,value=>value.canonicalReference.referenceContentHash='invalid',value=>value.canonicalReference.sourceMatchId='2042205',
 value=>value.canonicalReference.eventVersion=new Date().toISOString(),value=>value.canonicalReference.extra=true,value=>value.canonicalReferenceSources[0].sha256=hex(5),
 value=>delete value.canonicalReference,value=>value.version='worker-code-repair-v6',value=>value.incident.failure.incomingIdentity.resultIdentity='4:3|sporttery:official-api',
 value=>value.incident.workerMainPid='99',value=>value.incident.journalMessageSha256=hex(9),value=>value.expiresAt=new Date(Date.now()-1).toISOString(),value=>value.extra=true];
for(const [index,change] of invalidAuthorization.entries())test('reject authorization mutation '+index,()=>{
 const data=fixture();change(data.authorization);assert.equal(repair.evaluateWorkerCodeRepair(data.authorization,data.worker,data.observed).ok,false);
});
const invalidObserved=[value=>delete value.canonicalReference,value=>value.canonicalReference.referenceSha256=hex(5),value=>value.canonicalReference.referenceBytes++,
 value=>value.canonicalReferenceSources[0].sha256=hex(5),value=>value.journal.pop(),value=>value.journal.reverse(),value=>value.journal[0].pid='99',
 value=>value.journal[0].timestampMs++,value=>value.files[3].sha256=hex(5),value=>value.recoveryPending=true,value=>value.completeSha256=hex(5),
 value=>value.publication.committed.sourceCycleId='other',value=>value.publication.rawCurrent.committedAt=new Date(Date.now()-7200000).toISOString()];
for(const [index,change] of invalidObserved.entries())test('reject observed mutation '+index,()=>{
 const data=fixture();change(data.observed);assert.equal(repair.evaluateWorkerCodeRepair(data.authorization,data.worker,data.observed).ok,false);
});
test('healthy worker returns to ordinary checks and never relies on incident authorization',()=>{
 const data=fixture();data.worker.status.lastCycle.ok=true;
 const result=repair.selectWorkerCodeRepairPreparation(data.authorization,data.worker,()=>{throw Error('inactive incident');});
 assert.equal(result.useRepair,false);assert.equal(result.report.ok,true);assert.equal(result.report.readyToCutover,false);
});
test('sealed fresh capture binds reference proof and retains full generation validation',()=>{
 const data=fixture(),state={key:hex(4),sha:hex(5),oldSha:hex(1),createdAt:new Date(data.now-60000).toISOString(),oldDatabaseOid:'42',dataPlane:'code-only',repairCapturePolicy:data.authorization.bindingPolicy,committedGenerationRepairAuthorizationHash:hex(6)};
 const context=identity=>({pointer:identity,manifest:{generationId:identity.generationId,manifestHash:identity.manifestHash,sourceCycleId:identity.sourceCycleId,files:[{path:'matches-current.json',bytes:2}]}});
 const contexts=Object.fromEntries(Object.entries(data.observed.publication).filter(([key])=>key!=='databaseOid').map(([key,value])=>[key,context(value)]));
 const body={sha:state.sha,oldSha:state.oldSha,stateHash:hash(JSON.stringify(state)),authorizationHash:hex(6),checkedAt:new Date(data.now).toISOString(),worker:data.worker,observed:data.observed,publication:data.observed.publication,route:'repair',incident:data.actual,generationEvidence:Object.fromEntries(Object.entries(contexts).map(([key,value])=>[key,code.generationVerificationEvidence(value)]))};
 const capture=code.sealFreshRepairCapture(state,body),session={identity:body.publication.committed,publication:{context:contexts.committed,pairing:{reason:'exact-committed-postgres-generation'}}};
 assert.deepEqual(code.assertFreshRepairCapture(state,capture,data.authorization,hex(6)),body);
 assert.equal(code.assertRepairPair(state,session,contexts.rawCurrent,contexts.rawPrevious,data.authorization,hex(6),capture).productionWrites,0);
 for(const edit of [value=>value.body.observed.canonicalReference.referenceSha256=hex(2),value=>value.hmac=hex(2),value=>value.body.generationEvidence.rawCurrent.bytes++]){
  const changed=structuredClone(capture);edit(changed);assert.throws(()=>code.assertFreshRepairCapture(state,changed,data.authorization,hex(6)));
 }
 const changed=structuredClone(body);changed.observed.canonicalReference.referenceSha256=hex(2);
 assert.throws(()=>code.assertFreshRepairCapture(state,code.sealFreshRepairCapture(state,changed),data.authorization,hex(6)));
});
