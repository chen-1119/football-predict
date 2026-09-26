'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const c=require('../scripts/candidateProspectiveLedger.cjs');
const continuity=require('../scripts/candidateReleaseContinuity.cjs');
const template=require('./fixtures/candidate-retired-decision-snapshot.json');

const FROZEN='2026-07-27T00:00:00.000Z',KICKOFF='2026-07-27T01:00:00.000Z';
const CAPTURED='2026-07-27T00:55:00.000Z',RETIRED='2026-07-27T00:56:00.000Z';
const SETTLED='2026-07-27T03:01:00.000Z';
const candidate={id:'market-temperature-1_25',role:'shadow-feature-candidate',
  featureSet:['sporttery-market','temperature-calibration'],weights:{market:1,model:0,temperature:1.25}};
const candidates=[{id:'market-baseline',role:'baseline',featureSet:[],weights:{market:1,model:0}},candidate];
const implementation={sourceHashes:{'scripts/runModelBacktest.cjs':'1'.repeat(64),
  'scripts/candidateProspectiveLedger.cjs':'2'.repeat(64)},dependencyLockHash:'3'.repeat(64)};
const replacement={...implementation,sourceHashes:{...implementation.sourceHashes,
  'scripts/candidateProspectiveLedger.cjs':'9'.repeat(64)}};
const common={candidates,selectedCandidate:candidate,implementationCommitment:implementation,trustedCollectorCount:2};
const active=r=>r.ledgers.find(l=>l.ledgerId===r.activeLedgerId);
const events=(l,type)=>l.events.filter(e=>e.type===type);
const at=(value,delta)=>new Date(Date.parse(value)+delta).toISOString();
function snapshot(id,kickoff=KICKOFF){
  const capturedAt=at(kickoff,-20*60000);
  const replacements=new Map([
    [template.sourceMatchId,id],[template.matchId,`sporttery_${id}`],
    [template.sourceCycleId,`cycle-${id}`],[template.kickoffTime,kickoff],[template.capturedAt,capturedAt],
  ]);
  const copy=value=>Array.isArray(value)?value.map(copy):value&&typeof value==='object'
    ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,copy(v)]))
    : replacements.has(value)?replacements.get(value):value;
  return copy(template);
}
function match(id,{kickoff=KICKOFF,final=false,scoreHome=2,scoreAway=1,observedAt=at(kickoff,2*3600000)}={}){
  return {id:`sporttery_${id}`,sourceMatchId:id,leagueName:'测试联赛',kickoffTime:kickoff,
    status:final?'FINISHED':'SCHEDULED',scoreHome:final?scoreHome:null,scoreAway:final?scoreAway:null,
    resultObservedAt:final?observedAt:null,resultProvenance:final?{
      official:true,trusted:true,provider:'sporttery',observedAt,eventVersion:kickoff,
    }:null};
}
function initial({formal=false}={}){
  return c.updateCandidateProspectiveLedger({...common,evaluatedAt:FROZEN,
    robustness:{selectedCandidate:{id:candidate.id},candidateReadyForProspectiveTest:formal,
      family:{inventoryHash:c.candidateInventory(candidates,implementation).hash}}}).registry;
}
function captured({count=1,formal=false}={}){
  return c.updateCandidateProspectiveLedger({...common,priorRegistry:initial({formal}),evaluatedAt:CAPTURED,
    matches:Array.from({length:count},(_,i)=>match(`old-${i}`)),
    snapshots:Array.from({length:count},(_,i)=>snapshot(`old-${i}`))}).registry;
}
function retire(registry,{evaluatedAt=RETIRED,matches=[]}={}){
  const result=c.updateCandidateProspectiveLedger({...common,implementationCommitment:replacement,
    priorRegistry:registry,matches,evaluatedAt});
  assert.equal(result.chainValid,true,result.blockers.join(','));
  return result;
}
function assertPrefix(before,after){
  assert.deepEqual(after.header,before.header);
  assert.equal(after.headerHash,before.headerHash);
  assert.deepEqual(after.events.slice(0,before.events.length),before.events);
  assert.equal(after.events[before.events.length]?.previousHash,before.rootHash);
}

test('settlement heartbeat closes only frozen retired decisions and preserves each version and event prefix',()=>{
  const registry=retire(captured()).registry,before=JSON.stringify(registry),old=registry.ledgers[0];
  const current=structuredClone(active(registry));
  const releaseIdentity={bundleSha256:'b'.repeat(64),releaseSequence:1};
  const baseline=continuity.registrySnapshot(registry,{capturedAt:RETIRED,releaseIdentity});
  const result=c.settleCandidateProspectiveRegistry({priorRegistry:registry,
    matches:[match('old-0',{final:true}),match('unseen',{final:true})],evaluatedAt:SETTLED});
  assert.equal(result.chainValid,true);assert.equal(result.changed,true);
  assert.equal(result.settlementsAdded,1);assert.equal(result.retiredSettlementsAdded,1);assert.equal(result.eventsAdded,1);
  assert.equal(JSON.stringify(registry),before,'the caller input remains unchanged');
  const retired=result.registry.ledgers[0];assertPrefix(old,retired);
  assert.deepEqual(active(result.registry),current);
  const settlement=events(retired,'settlement')[0];
  assert.equal(settlement.decisionEventHash,events(old,'decision')[0].eventHash);
  assert.equal(settlement.candidateRevisionId,old.header.candidateRevisionId);
  assert.equal(settlement.resultObservedAt,at(KICKOFF,2*3600000));
  assert.equal(settlement.recordedAt,SETTLED);
  const oldAudit=c.auditLedger(retired,{evaluatedAt:SETTLED});
  assert.equal(oldAudit.cohort.shadow.settled,1);assert.equal(oldAudit.state,'RETIRED');
  assert.equal(oldAudit.formalPromotionEligible,false);assert(oldAudit.blockers.includes('candidate-retired'));
  assert.equal(result.audit.cohort.shadow.settled,0);assert.equal(result.audit.cohort.formal.settled,0);
  const report=continuity.verifyContinuity(baseline,result.registry,{checkedAt:SETTLED,releaseIdentity});
  assert.equal(report.ok,true,report.blockers.join(','));
  const again=c.settleCandidateProspectiveRegistry({priorRegistry:result.registry,
    matches:[match('old-0',{final:true})],evaluatedAt:at(SETTLED,60000)});
  assert.equal(again.changed,false);assert.equal(again.eventsAdded,0);assert.equal(again.settlementsAdded,0);
  assert.deepEqual(again.registry,result.registry);
});

test('the update entry point settles a ledger retired in the same call without copying its samples',()=>{
  const registry=captured(),before=JSON.stringify(registry);
  const result=retire(registry,{evaluatedAt:SETTLED,matches:[match('old-0',{final:true})]});
  assert.equal(result.retiredSettlementsAdded,1);assert.equal(JSON.stringify(registry),before);
  assertPrefix(registry.ledgers[0],result.registry.ledgers[0]);
  assert.deepEqual(result.registry.ledgers[0].events.slice(registry.ledgers[0].events.length).map(e=>e.type),['retirement','settlement']);
  assert.equal(result.audit.cohort.shadow.admitted,0);assert.equal(result.audit.cohort.formal.admitted,0);
  const next=c.updateCandidateProspectiveLedger({...common,implementationCommitment:replacement,
    priorRegistry:result.registry,matches:[match('old-0',{final:true})],evaluatedAt:at(SETTLED,60000)});
  assert.equal(next.retiredSettlementsAdded,0);
  assert.deepEqual(next.registry.ledgers[0],result.registry.ledgers[0]);
});

for(const entry of ['settle','update']){
  test(`${entry}: historical results persist without an active candidate or with a retired active pointer`,()=>{
    for(const retiredPointer of [false,true]){
      const registry=retire(captured()).registry;
      registry.activeLedgerId=retiredPointer?registry.ledgers[0].ledgerId:null;
      const result=entry==='settle'
        ? c.settleCandidateProspectiveRegistry({priorRegistry:registry,matches:[match('old-0',{final:true})],evaluatedAt:SETTLED})
        : c.updateCandidateProspectiveLedger({priorRegistry:registry,matches:[match('old-0',{final:true})],evaluatedAt:SETTLED});
      assert.equal(result.chainValid,true);assert.equal(result.changed,true);assert.equal(result.retiredSettlementsAdded,1);
      assert.equal(result.audit,null);
      assert.equal(result.registry.ledgers.length,registry.ledgers.length);
      assert.deepEqual(result.registry.ledgers[0].events.slice(registry.ledgers[0].events.length).map(e=>e.type),['settlement']);
    }
  });
}

test('retired settlements reject untrusted, conflicting, wrong-version, missing-clock and future results',()=>{
  const registry=retire(captured()).registry;
  const valid=match('old-0',{final:true});
  for(const rows of [
    [{...valid,resultProvenance:{...valid.resultProvenance,trusted:false}}],
    [match('wrong-id',{final:true})],
    [match('old-0',{final:true,kickoff:at(KICKOFF,60000)})],
    [{...valid,resultObservedAt:null,resultProvenance:{...valid.resultProvenance,observedAt:null}}],
    [match('old-0',{final:true,observedAt:at(SETTLED,1)})],
    [valid,match('old-0',{final:true,scoreHome:0,scoreAway:1})],
    [{...valid,status:'SCHEDULED'}],
  ]){
    const result=c.settleCandidateProspectiveRegistry({priorRegistry:registry,matches:rows,evaluatedAt:SETTLED});
    assert.equal(result.chainValid,true);assert.equal(result.retiredSettlementsAdded,0);
    assert.deepEqual(result.registry,registry);
  }
});

test('a retired append cannot predate retirement or a previous settlement and a later retry remains possible',()=>{
  const registry=retire(captured({count:2}),{evaluatedAt:'2026-07-27T04:00:00.000Z'}).registry;
  const early=c.settleCandidateProspectiveRegistry({priorRegistry:registry,
    matches:[match('old-0',{final:true})],evaluatedAt:SETTLED});
  assert.equal(early.changed,false);assert.deepEqual(early.registry,registry);
  const first=c.settleCandidateProspectiveRegistry({priorRegistry:registry,
    matches:[match('old-0',{final:true})],evaluatedAt:'2026-07-27T05:00:00.000Z'});
  assert.equal(first.retiredSettlementsAdded,1);
  const backwards=c.settleCandidateProspectiveRegistry({priorRegistry:first.registry,
    matches:[match('old-1',{final:true})],evaluatedAt:'2026-07-27T04:30:00.000Z'});
  assert.equal(backwards.changed,false);assert.deepEqual(backwards.registry,first.registry);
  const later=c.settleCandidateProspectiveRegistry({priorRegistry:first.registry,
    matches:[match('old-1',{final:true})],evaluatedAt:'2026-07-27T05:30:00.000Z'});
  assert.equal(later.retiredSettlementsAdded,1);assert.equal(later.chainValid,true);
});

test('invalid old evidence fails closed without appending a result or repairing its hash',()=>{
  const registry=retire(captured()).registry;
  events(registry.ledgers[0],'decision')[0].baseModelProbabilities['1']=.99;
  const before=JSON.stringify(registry);
  for(const run of [c.settleCandidateProspectiveRegistry,c.updateCandidateProspectiveLedger]){
    const result=run({priorRegistry:registry,matches:[match('old-0',{final:true})],evaluatedAt:SETTLED});
    assert.equal(result.chainValid,false);assert.equal(result.changed,false);
    assert.equal(JSON.stringify(result.registry),before);
  }
});

test('retired formal results can cross a review checkpoint without a new review, activation or promotion',()=>{
  const registry=initial({formal:true}),ledger=active(registry);
  const windows=events(ledger,'activation')[0].windowBoundaries,finals=[];
  for(let i=0;i<600;i++){
    const kickoff=at(windows[Math.floor(i/100)].startAt,86400000+(i%100)*60000),id=`review-${i}`;
    const decision=c.buildDecisionEvent({ledger,match:match(id,{kickoff}),snapshot:snapshot(id,kickoff),
      evaluatedAt:at(kickoff,-5*60000),phase:'formal',trustedCollectorCount:2});
    assert.equal(decision.type,'decision');c.appendEvent(ledger,decision);
    finals.push(match(id,{kickoff,final:true,scoreHome:0,scoreAway:1}));
  }
  const now=at(finals.at(-1).kickoffTime,3*3600000);
  const first=c.settleCandidateProspectiveRegistry({priorRegistry:registry,matches:finals.slice(0,500),evaluatedAt:now});
  assert.equal(first.chainValid,true);assert.equal(events(active(first.registry),'review').length,1);
  const retired=retire(first.registry,{evaluatedAt:at(now,60000)}).registry,old=retired.ledgers[0];
  const oldReview=structuredClone(events(old,'review')[0]);
  const result=c.settleCandidateProspectiveRegistry({priorRegistry:retired,matches:finals,evaluatedAt:at(now,120000)});
  assert.equal(result.chainValid,true,result.blockers.join(','));assert.equal(result.retiredSettlementsAdded,100);
  const after=result.registry.ledgers[0];assertPrefix(old,after);
  assert.deepEqual(after.events.slice(old.events.length).map(e=>e.type),Array(100).fill('settlement'));
  assert.deepEqual(events(after,'review'),[oldReview]);
  const proof=c.buildReviewCheckpointEvidence(after,500,{totalCandidatesEverTested:oldReview.totalCandidatesEverTested});
  assert.equal(proof.auditHash,oldReview.checkpointAuditHash);
  assert.equal(c.sha256(proof.dataset),oldReview.datasetHash);
  assert.equal(proof.sourceBoundaryHash,oldReview.checkpointSourceBoundaryHash);
  const oldAudit=c.auditLedger(after,{evaluatedAt:at(now,120000)});
  assert.equal(oldAudit.cohort.formal.settled,600);assert.equal(oldAudit.promotionReviewReady,false);
  assert.equal(oldAudit.formalPromotionEligible,false);
  assert.equal(result.audit.cohort.formal.settled,0);assert.equal(result.audit.cohort.shadow.admitted,0);
});

test('the actual deadline command saves retired results before reporting no active ledger',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'football-retired-capture-'));
  try{
    for(const retiredPointer of [false,true]){
      const registry=retire(captured()).registry;
      registry.activeLedgerId=retiredPointer?registry.ledgers[0].ledgerId:null;
      const registryFile=path.join(temp,'registry.json'),statusFile=path.join(temp,'status.json');
      fs.writeFileSync(registryFile,JSON.stringify(registry));
      fs.writeFileSync(path.join(temp,'current.json'),'[]');
      fs.writeFileSync(path.join(temp,'history.json'),JSON.stringify([match('old-0',{final:true})]));
      const run=()=>spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/captureCandidateProspectiveDeadline.cjs'),'--deadline-only'],{
        encoding:'utf8',timeout:20000,env:{...process.env,FOOTBALL_STORAGE_MODE:'hybrid',SERVER_STORE_DIR:temp,
          DATASTORE_SQLITE_PATH:path.join(temp,'missing.db'),CANDIDATE_PROSPECTIVE_REGISTRY_FILE:registryFile,
          CANDIDATE_PROSPECTIVE_CURRENT_MATCHES_FILE:path.join(temp,'current.json'),
          CANDIDATE_PROSPECTIVE_HISTORY_MATCHES_FILE:path.join(temp,'history.json'),
          CANDIDATE_PROSPECTIVE_CAPTURE_STATUS_FILE:statusFile,CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT:SETTLED}});
      const first=run();assert.equal(first.status,0,first.stderr||first.error?.message);
      const saved=JSON.parse(fs.readFileSync(registryFile,'utf8')),status=JSON.parse(fs.readFileSync(statusFile,'utf8'));
      assert.equal(status.reason,'active-ledger-missing');assert.equal(status.changed,true);
      assert.equal(status.retiredSettlementsAdded,1);assert.equal(status.settlementEventsAdded,1);
      assert.equal(c.verifyRegistry(saved).valid,true);assertPrefix(registry.ledgers[0],saved.ledgers[0]);
      const bytes=fs.readFileSync(registryFile,'utf8');
      const repeat=run();assert.equal(repeat.status,0,repeat.stderr);
      assert.equal(fs.readFileSync(registryFile,'utf8'),bytes);
      assert.equal(JSON.parse(fs.readFileSync(statusFile,'utf8')).changed,false);
    }
  }finally{
    assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));
    assert(path.basename(temp).startsWith('football-retired-capture-'));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
