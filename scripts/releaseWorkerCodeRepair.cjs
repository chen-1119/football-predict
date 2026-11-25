'use strict';
// A signed, incident-bound preparation route. It never changes worker health,
// starts a worker, writes data, or grants the actual cutover lease.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { evaluateWorkerPreflight, collectWorkerPreflight, buildReadOnlyWorkerProbe } = require('./releaseWorkerPreflight.cjs');
const { readStableMeta, verifySyncMetaFailure, incidentAnchor, verifyRepeatedIncident } = require('./syncMetaIncidentEvidence.cjs');
const {validateTimeoutAnchor,verifyTimeoutFrame,packTimeoutJournal,unpackTimeoutJournal,currentTimeoutAnchor,timeoutIncidentProof,collectTimeoutJournal,readCurrentTimeoutJournal,readTimeoutAttempt}=require('./workerTimeoutIncident.cjs');
const {streamInlineObjectEntries,inlineFailure,validateInlineAnchor,inlineIncidentAnchor,repeatedInlineIncident,validateInlineSource,assertInlineSourceContinuity,canonicalMapValuesLowerBound,readInlineSource}=require('./inlineRowIncidentEvidence.cjs');
const R941_BASE_RUNTIME_SHA256='d922357040c5f5fbedc19ec9d5a49a7bd5c3c674089df88b7037f6b98cf64db5';
const R941_BINDING_POLICY='fresh-r941-stability-incident-before-lease-v1';
const R941_STABILITY_TARGETS=[
  'scripts/postgresGenerationSource.cjs',
  'scripts/postgresProjectionSync.cjs',
  'scripts/syncPostgresProjection.cjs',
  'server/postgresProjectionStore.cjs',
  'scripts/runSyncWorker.cjs',
  'server/selectedJsonObjectFile.cjs',
  'server/collectorQuorumEvidence.cjs',
  'scripts/candidateProspectiveLedger.cjs',
  'scripts/captureCandidateProspectiveDeadline.cjs',
  'scripts/releaseWorkerCodeRepair.cjs',
  'scripts/nativeCodeReleaseDataPlane.cjs',
  'scripts/runReleaseWorkerPreflight.cjs',
  'scripts/deployReleaseBundle.cjs',
];
const R941_STABILITY_ADDED=[
  'scripts/postgresExternalGenerationRow.cjs',
  'scripts/streamedInlineObjectEntries.cjs',
  'scripts/inlineRowIncidentEvidence.cjs',
  'scripts/buildR941WorkerCodeRepairAuthorization.cjs',
];
const R941_STABILITY_UNCHANGED=[
  'scripts/workerTimeoutIncident.cjs',
  'scripts/releaseWorkerPreflight.cjs',
  'scripts/verifyNativeCodeServing.cjs',
  'scripts/committedGenerationRecoveryServingCore.cjs',
  'scripts/releaseDataPlanePolicy.cjs',
  'deploy/light-server/football-release',
  'deploy/light-server/release-native.sh',
];
function validateR941StabilityIncident(incident) {
  const assert=require('node:assert/strict');
  assert(incident && typeof incident==='object' && !Array.isArray(incident));
  assert(['external-inline-row-limit','deadline-recovery'].includes(incident.kind));
  if(incident.kind==='external-inline-row-limit') {
    assert.deepEqual(Object.keys(incident).sort(),['anchor','kind','source']);
    validateInlineAnchor(incident.anchor);
    validateInlineSource(incident.source);
    return incident;
  }
  validateTimeoutAnchor(incident);
  return incident;
}
const TIMEOUT_POLICY_TARGETS=['scripts/releaseWorkerCodeRepair.cjs','scripts/nativeCodeReleaseDataPlane.cjs',
  'scripts/verifyNativeCodeServing.cjs','scripts/runReleaseWorkerPreflight.cjs','scripts/deployReleaseBundle.cjs'];
const TIMEOUT_ADDED=['scripts/workerTimeoutIncident.cjs'];
const TIMEOUT_UNCHANGED=['scripts/runSyncWorker.cjs','scripts/captureCandidateProspectiveDeadline.cjs','scripts/releaseWorkerPreflight.cjs',
  'scripts/committedGenerationRecoveryServingCore.cjs','scripts/releaseDataPlanePolicy.cjs','deploy/light-server/football-release','deploy/light-server/release-native.sh'];
const TIMEOUT_RUNTIME={
  'scripts/reconcileFastResultGeneration.cjs':'3f356c61d0892087d65ea94c191195d50142637bfa22d927af5cad5cffb3d029',
  'server/streamedJsonObjectArrays.cjs':'945cd71e4e1f1c7266e16dd81d2fe8658735e38c3f4b36de2c0d9991e7d7d809',
  'scripts/candidateProspectiveLedger.cjs':'d6999fff2e21c3a87670c092bc598d694e482e1eebc70c10333ab13a5c9acae1'};
const TIMEOUT_REPLAYS={reconciliation:'a33a61ba085f94768b0c2987a0dbcee02aefdce8ea18db0b3d86e24bf7711bb7', deadline:null};
function timeoutPaths(kind) {
  const names=Object.keys(TIMEOUT_RUNTIME);
  return kind==='reconciliation-180s'?{patch:names.slice(0,2),retained:names.slice(2)}:{patch:names.slice(2),retained:names.slice(0,2)};
}
const AUTH_ENTRY = 'deploy/light-server/worker-code-repair-authorization.json';
const TARGETS = ['server/publicReferenceArchive.cjs', 'src/services/publicReferenceEvidence.cjs'];
const PAIR_TARGETS = ['scripts/postgresRuntimeReadSession.cjs', 'scripts/postgresModelInput.cjs',
  'server/dataGenerationBundle.cjs', 'server/publicationResolverWorker.cjs', 'server/index.cjs', ...TARGETS];
const WRITER_TARGETS = ['scripts/runSyncWorker.cjs', 'scripts/postgresProjectionSync.cjs',
  'scripts/releaseWorkerCodeRepair.cjs', 'scripts/nativeCodeReleaseDataPlane.cjs',
  'scripts/frontendRuntimeBoundary.cjs'];
const SNAPSHOT_TARGETS = [...WRITER_TARGETS];
// The producer repair must not change the projection's canonical-rebase guard.
const RESULT_IDENTITY_TARGETS = ['scripts/syncData.cjs', 'scripts/releaseWorkerCodeRepair.cjs',
  'scripts/nativeCodeReleaseDataPlane.cjs', 'scripts/postgresProjectionSync.cjs'];
const CANONICAL_REFERENCE_SOURCES = ['src/services/publicReferenceDecision.cjs', 'src/services/publicReferenceEvidence.cjs'];
const CANONICAL_REFERENCE_TARGETS = [...RESULT_IDENTITY_TARGETS,'scripts/verifyNativeCodeServing.cjs','scripts/runReleaseWorkerPreflight.cjs'];
const REFERENCE_INDEX_TARGETS = ['server/referencePairedBaseline.cjs', 'scripts/releaseWorkerCodeRepair.cjs',
  'scripts/nativeCodeReleaseDataPlane.cjs', 'scripts/verifyNativeCodeServing.cjs'];
const REFERENCE_INDEX_SOURCES = ['server/streamedJsonObjectArrays.cjs', 'src/services/publicReferenceDecision.cjs',
  'src/services/publicReferenceEvidence.cjs', 'scripts/reconcileFastResultGeneration.cjs'];
const DATA_FILES = ['server/postgresStore.cjs', 'server/storageMode.cjs',
  'deploy/light-server/candidate-revision-transition.json', 'deploy/light-server/native-release-policy.json',
  'deploy/light-server/recommendation-schema-bridge.cjs'];
const SYNC_META_TARGETS = ['scripts/syncData.cjs','scripts/optimizePredictionStrategy.cjs',
  'scripts/releaseWorkerCodeRepair.cjs','scripts/nativeCodeReleaseDataPlane.cjs','scripts/verifyNativeCodeServing.cjs',
  'scripts/runReleaseWorkerPreflight.cjs','scripts/deployReleaseBundle.cjs'];
const SYNC_META_ADDED = ['scripts/syncMetaStrategySummary.cjs','scripts/syncMetaIncidentEvidence.cjs'];
const SYNC_META_UNCHANGED = ['scripts/validateData.cjs','scripts/releaseWorkerPreflight.cjs','scripts/postgresProjectionSync.cjs'];

function validateSyncMetaAnchor(anchor) {
  const assert=require('node:assert/strict'),crypto=require('node:crypto');
  assert.deepEqual(Object.keys(anchor).sort(),['version','workerMainPid','workerStartedAt','cycleStartedAt','cycleFinishedAt','journalPid','journalTimestampUs','journalMessageSha256','metaBytes','metaSha256'].sort());
  assert.equal(anchor.version,'sync-meta-incident-anchor-v1');
  for(const key of ['workerMainPid','journalPid']) assert.match(anchor[key]||'',/^[1-9][0-9]*$/);
  assert.notEqual(anchor.workerMainPid,anchor.journalPid);
  for(const key of ['workerStartedAt','cycleStartedAt','cycleFinishedAt']) assert.equal(new Date(anchor[key]).toISOString(),anchor[key]);
  assert(Date.parse(anchor.workerStartedAt)<=Date.parse(anchor.cycleStartedAt));
  assert(Date.parse(anchor.cycleStartedAt)<=Date.parse(anchor.cycleFinishedAt));
  assert.match(anchor.journalTimestampUs||'',/^[1-9][0-9]{15}$/);
  const stamp=Number(anchor.journalTimestampUs)/1000;
  assert(stamp>=Date.parse(anchor.cycleStartedAt)&&stamp<=Date.parse(anchor.cycleFinishedAt));
  assert.equal(anchor.journalMessageSha256,crypto.createHash('sha256').update('sync-meta.json should stay below 1MB and only expose freshness summaries.').digest('hex'));
  assert(Number.isSafeInteger(anchor.metaBytes)&&anchor.metaBytes>1000000&&anchor.metaBytes<8388608);
  assert.match(anchor.metaSha256||'',/^[a-f0-9]{64}$/);
}

function validateRepairPublication(value, allowAligned = false) {
  const assert = require('node:assert/strict');
  assert.deepEqual(Object.keys(value).sort(), ['committed','databaseOid','rawCurrent','rawPrevious']);
  assert.match(value.databaseOid || '', /^[1-9][0-9]*$/);
  const keys = ['mode','generationId','manifestHash','sourceCycleId','committedAt'];
  for (const name of ['committed','rawCurrent','rawPrevious']) {
    const row=value[name]; assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
    assert.equal(row.mode,'active-generation'); assert.match(row.manifestHash||'',/^[a-f0-9]{64}$/);
    assert.equal(row.generationId,'g-'+row.manifestHash);
    assert.equal(typeof row.sourceCycleId,'string'); assert(row.sourceCycleId.length>0&&row.sourceCycleId.length<=256);
    assert(Number.isFinite(Date.parse(row.committedAt)) && new Date(row.committedAt).toISOString()===row.committedAt);
  }
  assert.notEqual(value.rawCurrent.generationId,value.rawPrevious.generationId);
  const aligned = [value.rawCurrent,value.rawPrevious].find(r=>r.generationId===value.committed.generationId);
  assert(Date.parse(value.rawPrevious.committedAt)<Date.parse(value.rawCurrent.committedAt));
  if(allowAligned && aligned) assert.deepEqual(value.committed,aligned);
  else {
    assert.notEqual(value.committed.generationId,value.rawCurrent.generationId);
    assert.notEqual(value.committed.generationId,value.rawPrevious.generationId);
    assert(Date.parse(value.committed.committedAt)<Date.parse(value.rawPrevious.committedAt));
  }
  return value;
}
function validateWorkerCodeRepairAuthorization(auth, now) {
  const assert = require('node:assert/strict');
  const sha = value => assert.match(value || '', /^[a-f0-9]{64}$/);
  const writer = auth.version === 'worker-code-repair-v3';
  const snapshot = auth.version === 'worker-code-repair-v4';
  const r941Stability = auth.version === 'worker-code-repair-v11';
  const timeoutRepair = auth.version === 'worker-code-repair-v10';
  const syncMeta = auth.version === 'worker-code-repair-v9';
  const canonicalReference = auth.version === 'worker-code-repair-v8';
  const referenceIndex = auth.version === 'worker-code-repair-v7';
  const freshCapture = auth.version === 'worker-code-repair-v6' || referenceIndex || canonicalReference || syncMeta || timeoutRepair || r941Stability;
  const resultIdentity = auth.version === 'worker-code-repair-v5' || auth.version === 'worker-code-repair-v6' || canonicalReference;
  const pair = auth.version === 'worker-code-repair-v2' || writer || snapshot || resultIdentity || referenceIndex || syncMeta || timeoutRepair || r941Stability;
  assert.deepEqual(Object.keys(auth).sort(), ['version','reason','createdAt','expiresAt','baseRuntimeSha256','files','dataContract',...(pair?['publication']:[]),...(resultIdentity||referenceIndex||syncMeta||timeoutRepair||r941Stability?['incident']:[]),...(freshCapture?['bindingPolicy']:[]),...(referenceIndex?['referenceIndex','indexSources']:[]),...(canonicalReference?['canonicalReference','canonicalReferenceSources']:[]),...(syncMeta||timeoutRepair||r941Stability?['addedSources','unchangedSources']:[]),...(timeoutRepair?['replayReceiptSha256']:[])].sort());
  assert.equal(auth.version, r941Stability ? 'worker-code-repair-v11' : timeoutRepair ? 'worker-code-repair-v10' : syncMeta ? 'worker-code-repair-v9' : canonicalReference ? 'worker-code-repair-v8' : referenceIndex ? 'worker-code-repair-v7' : freshCapture ? 'worker-code-repair-v6' : resultIdentity ? 'worker-code-repair-v5' : snapshot ? 'worker-code-repair-v4' : writer ? 'worker-code-repair-v3' : pair ? 'worker-code-repair-v2' : 'worker-code-repair-v1');
  if(freshCapture) assert.equal(auth.bindingPolicy, r941Stability ? R941_BINDING_POLICY : timeoutRepair ? 'fresh-r938-timeout-incident-before-lease-v1' : syncMeta ? 'fresh-sync-meta-size-incident-before-lease-v1' : canonicalReference ? 'fresh-exact-identity-failure-and-unchanged-reference-before-lease-v1' : referenceIndex ? 'fresh-reference-index-limit-and-exact-corpus-before-lease-v1' : 'fresh-raw-and-repeated-exact-failure-before-lease-v1');
  assert.equal(auth.reason, (timeoutRepair || r941Stability) ? auth.incident.kind : syncMeta ? 'sync-meta-strategy-summary-size' : canonicalReference ? 'official-result-canonical-identity-with-preserved-reference' : referenceIndex ? 'reference-decision-index-limit' : resultIdentity ? 'official-result-canonical-identity-regression' : snapshot ? 'model-artifact-generation-snapshot-race' : writer ? 'postgres-source-file-assembly-timeout' : pair ? 'postgres-committed-generation-pairing' : 'reference-array-string-limit');
  if(pair) validateRepairPublication(auth.publication,snapshot || writer || resultIdentity || referenceIndex || syncMeta || timeoutRepair || r941Stability);
  if(r941Stability) {
    assert.equal(auth.baseRuntimeSha256,R941_BASE_RUNTIME_SHA256);
    validateR941StabilityIncident(auth.incident);
    if(auth.incident.kind==='external-inline-row-limit') {
      for(const k of ['generationId','manifestHash','sourceCycleId','committedAt']) {
        assert.equal(auth.incident.source[k],auth.publication.rawCurrent[k]);
      }
    }
    for(const [key,names] of [['addedSources',R941_STABILITY_ADDED],['unchangedSources',R941_STABILITY_UNCHANGED]]) {
      assert.deepEqual(auth[key].map(row=>row.path),names);
      for(const row of auth[key]) {assert.deepEqual(Object.keys(row).sort(),['path','sha256']);sha(row.sha256);}
    }
  }
  if(timeoutRepair) {
    assert.equal(auth.baseRuntimeSha256,'5de9c543933c37b1b086c41862a17456f83227f555b7613b2058318d848a498c');
    validateTimeoutAnchor(auth.incident);
    const {patch,retained}=timeoutPaths(auth.incident.kind);
    for(const [key,names] of [['addedSources',TIMEOUT_ADDED],['unchangedSources',[...TIMEOUT_UNCHANGED,...retained]]]) {
      assert.deepEqual(auth[key].map(row=>row.path),names);
      for(const row of auth[key]) {assert.deepEqual(Object.keys(row).sort(),['path','sha256']);sha(row.sha256);}
    }
    const reviewed=TIMEOUT_REPLAYS[auth.incident.kind==='reconciliation-180s'?'reconciliation':'deadline'];
    sha(auth.replayReceiptSha256);
    assert.equal(auth.replayReceiptSha256,reviewed,'exact, independently reproduced candidate source receipt required');
    assert.deepEqual(auth.files.slice(0,patch.length).map(row=>row.afterSha256),patch.map(name=>TIMEOUT_RUNTIME[name]));
  }
  if(syncMeta) {
    validateSyncMetaAnchor(auth.incident);
    for(const [key,names] of [['addedSources',SYNC_META_ADDED],['unchangedSources',SYNC_META_UNCHANGED]]) {
      assert.deepEqual(auth[key].map(row=>row.path),names);
      for(const row of auth[key]) {assert.deepEqual(Object.keys(row).sort(),['path','sha256']);sha(row.sha256);}
    }
  }
  if(resultIdentity) validateResultIdentityIncident(auth.incident);
  if(canonicalReference) {
    validateCanonicalReferenceProof(auth.canonicalReference,auth.incident);
    assert.deepEqual(auth.canonicalReferenceSources.map(row=>row.path),CANONICAL_REFERENCE_SOURCES);
    for(const row of auth.canonicalReferenceSources) {assert.deepEqual(Object.keys(row).sort(),['path','sha256']);sha(row.sha256);}
  }
  if(referenceIndex) {
    validateReferenceIndexIncident(auth.incident);validateReferenceIndexProof(auth.referenceIndex);
    assert.deepEqual(auth.indexSources.map(row=>row.path),REFERENCE_INDEX_SOURCES);
    for(const row of auth.indexSources) {assert.deepEqual(Object.keys(row).sort(),['path','sha256']);sha(row.sha256);}
  }
  sha(auth.baseRuntimeSha256);
  const start = Date.parse(auth.createdAt), end = Date.parse(auth.expiresAt);
  assert(Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end)
    && start <= now + 5000 && now < end && end > start && end - start <= 2 * 3600000, 'repair authorization clock');
  assert.deepEqual(auth.files.map(row => row.path), r941Stability ? R941_STABILITY_TARGETS : timeoutRepair ? [...timeoutPaths(auth.incident.kind).patch,...TIMEOUT_POLICY_TARGETS] : syncMeta ? SYNC_META_TARGETS : canonicalReference ? CANONICAL_REFERENCE_TARGETS : referenceIndex ? REFERENCE_INDEX_TARGETS : resultIdentity ? RESULT_IDENTITY_TARGETS : snapshot ? SNAPSHOT_TARGETS : writer ? WRITER_TARGETS : pair ? PAIR_TARGETS : TARGETS);
  for (const row of auth.files) {
    assert.deepEqual(Object.keys(row).sort(), ['afterSha256','beforeSha256','path']);
    sha(row.beforeSha256); sha(row.afterSha256);
    if(resultIdentity && row.path === 'scripts/postgresProjectionSync.cjs') assert.equal(row.beforeSha256,row.afterSha256);
    else assert.notEqual(row.beforeSha256, row.afterSha256);
  }
  assert(Array.isArray(auth.dataContract) && auth.dataContract.length > DATA_FILES.length && auth.dataContract.length <= 256);
  let prior = '';
  for (const row of auth.dataContract) {
    assert.deepEqual(Object.keys(row).sort(), ['path','sha256']); sha(row.sha256);
    assert(row.path > prior && (DATA_FILES.includes(row.path) || /^server\/postgres\/migrations\/\d+_[a-z0-9_-]+\.sql$/.test(row.path)));
    prior = row.path;
  }
  for (const name of DATA_FILES) assert(auth.dataContract.some(row => row.path === name));
  return auth;
}

function validateReferenceIndexIncident(incident) {
  const assert=require('node:assert/strict'),crypto=require('node:crypto');
  assert.deepEqual(Object.keys(incident).sort(),['cycleFinishedAt','cycleStartedAt','failure','journalMessageSha256','journalPid','journalTimestampUs','workerMainPid','workerStartedAt']);
  for(const key of ['workerMainPid','journalPid'])assert.match(incident[key]||'',/^[1-9][0-9]*$/);
  assert.notEqual(incident.workerMainPid,incident.journalPid);
  for(const key of ['workerStartedAt','cycleStartedAt','cycleFinishedAt'])assert.equal(new Date(incident[key]).toISOString(),incident[key]);
  assert(Date.parse(incident.workerStartedAt)<=Date.parse(incident.cycleStartedAt));
  assert(Date.parse(incident.cycleStartedAt)<=Date.parse(incident.cycleFinishedAt));
  assert.match(incident.journalTimestampUs||'',/^[1-9][0-9]{15}$/);
  const stamp=Number(incident.journalTimestampUs)/1000;
  assert(stamp>=Date.parse(incident.cycleStartedAt)&&stamp<=Date.parse(incident.cycleFinishedAt));
  assert.deepEqual(incident.failure,{ok:false,error:'REFERENCE_DECISION_INDEX_LIMIT',errorCode:null});
  assert.equal(incident.journalMessageSha256,crypto.createHash('sha256').update(JSON.stringify(incident.failure,null,2)).digest('hex'));
  return incident;
}
function assertReferenceIndexJournal(incident,journal) {
  const assert=require('node:assert/strict');
  validateReferenceIndexIncident(incident);assert(Array.isArray(journal)&&journal.length===5);
  for(const row of journal) {
    assert.equal(row.unit,'football-sync-worker.service');assert.equal(row.pid,incident.journalPid);
    assert.equal(row.timestampUs,incident.journalTimestampUs);
    assert.equal(row.timestampMs,Number(incident.journalTimestampUs)/1000);
  }
  assert.equal(journal.map(row=>row.message).join('\n'),JSON.stringify(incident.failure,null,2));
}
function repeatedReferenceIndexIncident(signed,worker,journal) {
  const assert=require('node:assert/strict');
  validateReferenceIndexIncident(signed);
  const cycle=worker.status.lastCycle;
  assert.equal(worker.serviceAfter.MainPID,signed.workerMainPid);
  assert.equal(new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),signed.workerStartedAt);
  assert(Array.isArray(journal)&&journal.length===5);
  const actual={...signed,cycleStartedAt:cycle.startedAt,cycleFinishedAt:cycle.finishedAt,
    journalPid:journal[0].pid,journalTimestampUs:journal[0].timestampUs};
  assertReferenceIndexJournal(actual,journal);
  if(cycle.startedAt===signed.cycleStartedAt&&cycle.finishedAt===signed.cycleFinishedAt) {
    assert.equal(actual.journalPid,signed.journalPid);assert.equal(actual.journalTimestampUs,signed.journalTimestampUs);
  } else {
    assert(Date.parse(cycle.startedAt)>=Date.parse(signed.cycleFinishedAt),'repeated index failure overlaps signed cycle');
    assert(Date.parse(cycle.finishedAt)>Date.parse(signed.cycleFinishedAt),'repeated index failure regressed');
    assert(BigInt(actual.journalTimestampUs)>BigInt(signed.journalTimestampUs),'repeated index journal regressed');
  }
  return actual;
}
function repeatedRepairIncident(auth,worker,journal,meta) {
  const assert=require('node:assert/strict');
  if(auth.version==='worker-code-repair-v11') {
    validateR941StabilityIncident(auth.incident);
    if(auth.incident.kind==='deadline-recovery') return timeoutIncidentProof(auth,worker,journal,meta);
    validateInlineSource(meta);
    return {
      kind:'external-inline-row-limit',
      anchor:repeatedInlineIncident(auth.incident.anchor,worker,journal),
      source:meta,
    };
  }
  if(auth.version==='worker-code-repair-v10') return timeoutIncidentProof(auth,worker,journal,meta);
  if(auth.version==='worker-code-repair-v9') return verifyRepeatedIncident(auth.incident,{worker,journal,meta});
  if(auth.version==='worker-code-repair-v7')return repeatedReferenceIndexIncident(auth.incident,worker,journal);
  assert(['worker-code-repair-v6','worker-code-repair-v8'].includes(auth.version));
  return repeatedResultIdentityIncident(auth.incident,worker,journal);
}
function validateCanonicalReferenceProof(proof,incident) {
  const assert=require('node:assert/strict');
  assert.deepEqual(Object.keys(proof).sort(),['eventVersion','referenceBytes','referenceContentHash','referenceSha256','sourceMatchId','version']);
  assert.equal(proof.version,'canonical-reference-preservation-proof-v1');
  assert.equal(proof.sourceMatchId,incident.failure.existingIdentity.sourceMatchId);
  assert.equal(proof.eventVersion,incident.failure.existingIdentity.eventVersion);
  for(const key of ['referenceContentHash','referenceSha256'])assert.match(proof[key]||'',/^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(proof.referenceBytes)&&proof.referenceBytes>0&&proof.referenceBytes<=65536);
  return proof;
}
function collectCanonicalReferenceProof(root,incident) {
  const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
  const {Buffer}=require('node:buffer');
  validateResultIdentityIncident(incident);
  const identity=incident.failure.existingIdentity,sourceId=identity.sourceMatchId;
  const file=root+'/public/data/matches-history.json',descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let bytes,before;
  try {
    before=fs.fstatSync(descriptor);assert(before.isFile()&&before.nlink===1&&before.size<=256*1024*1024);
    bytes=fs.readFileSync(descriptor);const after=fs.fstatSync(descriptor);
    for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key]);
  } finally {fs.closeSync(descriptor);}
  const rows=JSON.parse(bytes).filter(row=>row.sourceMatchId===sourceId);
  assert.equal(rows.length,1,'unaccepted history identity ambiguous');const incoming=rows[0];
  const sql="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT payload::text FROM football.match_snapshots WHERE dataset='history' AND source_match_id='"+sourceId+"'; ROLLBACK;";
  const output=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-d','football','-c',sql],
    {encoding:'utf8',timeout:10000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',PGHOST:'/var/run/postgresql',PGUSER:'postgres',PGCONNECT_TIMEOUT:'5'}});
  const stored=JSON.parse(output.trim());
  assert.equal(incoming.id,incident.failure.incomingMatchId);assert.equal(stored.id,incident.failure.existingMatchId);
  for(const row of [incoming,stored]) {
    assert.equal(row.sourceMatchId,sourceId);assert.equal(new Date(row.eventVersion).toISOString(),identity.eventVersion);
    assert.equal(row.scoreHome+':'+row.scoreAway+'|'+row.resultSource,identity.resultIdentity);
    assert.equal(new Date(row.resultObservedAt).toISOString(),identity.observedAt);
    assert.equal(new Date(row.settledAt).toISOString(),identity.settledAt);
  }
  const reference=incoming.predictionMeta?.publicReferenceDecision,original=stored.predictionMeta?.publicReferenceDecision;
  assert.equal(reference?.version,'public-reference-decision-v2');assert(reference.evidenceBinding);
  const raw=JSON.stringify(reference);assert.equal(raw,JSON.stringify(original),'reference original changed');
  const attest=require(root+'/src/services/publicReferenceDecision.cjs').attestPublicReferenceDecision;
  assert(attest(reference,incoming)&&attest(original,stored),'reference original not attested');
  const after=fs.lstatSync(file);for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key],'unaccepted history changed during proof');
  return validateCanonicalReferenceProof({version:'canonical-reference-preservation-proof-v1',sourceMatchId:sourceId,eventVersion:identity.eventVersion,
    referenceContentHash:reference.contentHash,referenceSha256:crypto.createHash('sha256').update(raw).digest('hex'),referenceBytes:Buffer.byteLength(raw)},incident);
}
function validateReferenceIndexProof(proof) {
  const assert=require('node:assert/strict');
  assert.deepEqual(Object.keys(proof).sort(),['compressedIndexBytes','corpusSha256','maxRecordBytes','originalAttestationAll','originalCountBound','originalIndexBound','records','serializedBytes','serializedChars','sourceBytes','sourceSha256']);
  for(const key of ['corpusSha256','sourceSha256'])assert.match(proof[key]||'',/^[a-f0-9]{64}$/);
  for(const key of ['records','sourceBytes','serializedChars','serializedBytes','compressedIndexBytes','maxRecordBytes'])assert(Number.isSafeInteger(proof[key])&&proof[key]>0);
  assert.equal(proof.originalIndexBound,32*1024*1024);assert.equal(proof.originalCountBound,100000);
  assert.equal(proof.originalAttestationAll,true);assert(proof.records<=proof.originalCountBound);
  // The incident is specifically the old serialized index bound; count limits
  // and a compressed index that is still too large do not qualify.
  assert(proof.serializedChars>proof.originalIndexBound&&proof.serializedBytes>=proof.serializedChars);
  assert(proof.sourceBytes>=proof.serializedBytes&&proof.sourceBytes<=2*1024**3);
  assert(proof.compressedIndexBytes>proof.records*256&&proof.compressedIndexBytes<=proof.originalIndexBound);
  assert(proof.maxRecordBytes<=proof.originalIndexBound&&proof.maxRecordBytes<=proof.serializedBytes);
  return proof;
}
function assertReferenceIndexCorpus(signed,observed) {
  const assert=require('node:assert/strict');
  validateReferenceIndexProof(signed);validateReferenceIndexProof(observed);
  // The full JSON may acquire natural facts outside the reference array. Its
  // fresh whole-file SHA is retained in the capture; every complete reference
  // record, order, count and capacity measurement must remain byte-identical.
  for(const key of Object.keys(signed).filter(key=>!['sourceBytes','sourceSha256'].includes(key)))assert.deepEqual(observed[key],signed[key],'signed reference corpus changed');
}
function collectReferenceIndexProof(root) {
  const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
  const file=fs.realpathSync(root+'/public/data/prediction-snapshots.json');
  assert(file.startsWith(root+'/')||file.startsWith('/var/lib/football-predict/'));
  for(let dir=path.dirname(file);;dir=path.dirname(dir)) {
    const st=fs.lstatSync(dir);assert(st.isDirectory()&&!st.isSymbolicLink());
    if(dir===path.dirname(dir))break;
  }
  assert.equal(fs.lstatSync(file).nlink,1);
  const {streamJsonObjectArrays}=require(root+'/server/streamedJsonObjectArrays.cjs');
  const {attestPublicReferenceDecision}=require(root+'/src/services/publicReferenceDecision.cjs');
  return measureReferenceIndexProof(file,streamJsonObjectArrays,attestPublicReferenceDecision);
}
function measureReferenceIndexProof(file,streamJsonObjectArrays,attestPublicReferenceDecision) {
  const crypto=require('node:crypto'),z=require('node:zlib'),assert=require('node:assert/strict');
  const {Buffer}=require('node:buffer'),{performance}=require('node:perf_hooks');
  const seen=new Set(),digest=crypto.createHash('sha256'),started=performance.now();
  let records=0,serializedChars=0,serializedBytes=0,compressedIndexBytes=0,maxRecordBytes=0;
  const source=streamJsonObjectArrays(file,{keys:['publicReferenceDecisions'],allowNonArrays:true,onItem:(_key,record)=>{
    assert(performance.now()-started<=45000,'reference proof time bound');
    assert(records<100000&&attestPublicReferenceDecision(record,record),'original reference attestation or count rejected');
    assert(!seen.has(record.contentHash),'duplicate original reference');seen.add(record.contentHash);
    const text=JSON.stringify(record),raw=Buffer.from(text);
    assert(raw.length<=32*1024*1024,'original individual record bound');
    records++;serializedChars+=text.length;serializedBytes+=raw.length;maxRecordBytes=Math.max(maxRecordBytes,raw.length);
    compressedIndexBytes+=z.deflateRawSync(raw).length+256;
    digest.update(String(raw.length)+':');digest.update(raw);
  }});
  assert(performance.now()-started<=45000,'whole reference proof time bound');
  return validateReferenceIndexProof({sourceBytes:source.bytes,sourceSha256:source.sha256,corpusSha256:digest.digest('hex'),records,
    serializedChars,serializedBytes,compressedIndexBytes,maxRecordBytes,originalIndexBound:32*1024*1024,
    originalCountBound:100000,originalAttestationAll:true});
}

function validateResultIdentityIncident(incident) {
  const assert=require('node:assert/strict'), crypto=require('node:crypto');
  const {Buffer}=require('node:buffer');
  assert.deepEqual(Object.keys(incident).sort(),['cycleFinishedAt','cycleStartedAt','failure','journalMessageSha256','journalPid','journalTimestampUs','workerMainPid','workerStartedAt']);
  for(const key of ['workerMainPid','journalPid'])assert.match(incident[key]||'',/^[1-9][0-9]*$/);
  assert.notEqual(incident.workerMainPid,incident.journalPid);
  for(const key of ['workerStartedAt','cycleStartedAt','cycleFinishedAt'])assert.equal(new Date(incident[key]).toISOString(),incident[key]);
  assert(Date.parse(incident.workerStartedAt)<=Date.parse(incident.cycleStartedAt));
  assert(Date.parse(incident.cycleStartedAt)<=Date.parse(incident.cycleFinishedAt));
  assert.match(incident.journalTimestampUs||'',/^[1-9][0-9]{15}$/);
  const timestamp=Number(incident.journalTimestampUs)/1000;
  assert(timestamp>=Date.parse(incident.cycleStartedAt)&&timestamp<=Date.parse(incident.cycleFinishedAt));
  const failure=incident.failure;
  assert.deepEqual(Object.keys(failure),['ok','code','error','reviewId','existingMatchId','incomingMatchId','existingObservationId','incomingObservationId','existingIdentity','incomingIdentity']);
  assert.equal(failure.ok,false);assert.equal(failure.code,'POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE');
  assert.equal(failure.error,'Existing stable review id is not a safe result-only canonical rebase');
  assert.match(failure.reviewId||'',/^review:[a-f0-9]{64}$/);
  for(const key of ['existingObservationId','incomingObservationId'])assert.match(failure[key]||'',/^result:[a-f0-9]{64}$/);
  assert.notEqual(failure.existingObservationId,failure.incomingObservationId);
  const identity=failure.existingIdentity;
  assert.deepEqual(Object.keys(identity),['sourceMatchId','eventVersion','resultIdentity','observedAt','settledAt']);
  assert.match(identity.sourceMatchId||'',/^[1-9][0-9]{0,15}$/);
  assert.equal(failure.existingMatchId,'sporttery_'+identity.sourceMatchId);
  assert.equal(failure.incomingMatchId,'fivehundred_'+identity.sourceMatchId);
  assert.match(identity.resultIdentity||'',/^\d{1,2}:\d{1,2}\|sporttery:official-api$/);
  for(const key of ['eventVersion','observedAt','settledAt'])assert.equal(new Date(identity[key]).toISOString(),identity[key]);
  assert(Date.parse(identity.eventVersion)<=Date.parse(identity.observedAt));
  assert.equal(identity.observedAt,identity.settledAt);
  assert(Date.parse(identity.settledAt)<=timestamp);
  assert.deepEqual(failure.incomingIdentity,identity);
  const message=JSON.stringify(failure,null,2);
  assert.equal(message.split('\n').length,24);assert(Buffer.byteLength(message)<=4096);
  assert.equal(incident.journalMessageSha256,crypto.createHash('sha256').update(message).digest('hex'));
  return incident;
}

function assertResultIdentityJournal(incident,journal) {
  const assert=require('node:assert/strict');
  const {Buffer}=require('node:buffer');
  assert(Array.isArray(journal)&&journal.length===24);
  for(const row of journal) {
    assert.equal(row.unit,'football-sync-worker.service');assert.equal(row.pid,incident.journalPid);
    assert.equal(row.timestampUs,incident.journalTimestampUs);
    assert.equal(row.timestampMs,Number(incident.journalTimestampUs)/1000);
    assert.equal(typeof row.message,'string');assert(Buffer.byteLength(row.message)<=1024);
  }
  // Exact pretty-printed bytes reject missing/duplicated fields and spliced
  // records even when JSON.parse alone would accept the last duplicate key.
  assert.equal(journal.map(row=>row.message).join('\n'),JSON.stringify(incident.failure,null,2));
}

// v6 authorizes only another occurrence of the complete signed failure on the
// same worker incarnation. The actual child PID and microsecond clock must be
// obtained from journal records belonging to the latest completed failed cycle.
function repeatedResultIdentityIncident(signed,worker,journal) {
  const assert=require('node:assert/strict');
  validateResultIdentityIncident(signed);
  const cycle=worker.status.lastCycle;
  assert.equal(worker.serviceAfter.MainPID,signed.workerMainPid);
  assert.equal(new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),signed.workerStartedAt);
  assert(Array.isArray(journal)&&journal.length===24);
  const actual={...signed,cycleStartedAt:cycle.startedAt,cycleFinishedAt:cycle.finishedAt,
    journalPid:journal[0].pid,journalTimestampUs:journal[0].timestampUs};
  validateResultIdentityIncident(actual);assertResultIdentityJournal(actual,journal);
  if(cycle.startedAt===signed.cycleStartedAt && cycle.finishedAt===signed.cycleFinishedAt) {
    assert.equal(actual.journalPid,signed.journalPid);assert.equal(actual.journalTimestampUs,signed.journalTimestampUs);
  } else {
    assert(Date.parse(cycle.startedAt)>=Date.parse(signed.cycleFinishedAt),'repeated incident cycle overlaps signed cycle');
    assert(Date.parse(cycle.finishedAt)>Date.parse(signed.cycleFinishedAt),'repeated incident cycle regressed');
    assert(BigInt(actual.journalTimestampUs)>BigInt(signed.journalTimestampUs),'repeated incident journal regressed');
  }
  return actual;
}

function evaluateWorkerCodeRepair(auth, worker, observed) {
  const assert = require('node:assert/strict');
  const report = evaluateWorkerPreflight(worker);
  // A healthy worker follows the original route; the incident authorization
  // cannot hide an unrelated process/clock/status failure.
  const result = { version:'worker-code-repair-preparation-v1', checkedAt:worker.checkedAt,
    workerHealthy:report.ok, workerReport:report, ok:false, repairPreparationAllowed:false,
    readyToCutover:false, productionWrites:0, blockers:[],
    scope:'preparation only; worker failure retained; signed code-only classification, root lock, PG/catalog, capacity, source, cutover lease and final acceptance remain required' };
  try {
    const now = Date.parse(worker.checkedAt);
    validateWorkerCodeRepairAuthorization(auth, now);
    if (['worker-code-repair-v8','worker-code-repair-v9','worker-code-repair-v10','worker-code-repair-v11'].includes(auth.version) && report.blockers.length === 2) {
      assert.deepEqual(report.blockers, ['worker-latest-official-cycle-failed','worker-official-recovery-unproven']);
      assert.equal(worker.status.ok, false);
      assert.equal(worker.status.phase, 'failed');
      assert.deepEqual(worker.status.eventCycle, worker.status.lastCycle);
    } else {
      assert.equal(report.blockers.length, 1);
      assert(['worker-latest-official-cycle-failed','worker-official-recovery-unproven'].includes(report.blockers[0]));
    }
    assert(report.statusAgeSeconds <= 600, 'worker observation stale');
    const cycle = worker.status.lastCycle;
    const start = Date.parse(cycle?.startedAt), end = Date.parse(cycle?.finishedAt);
    assert.equal(cycle?.ok, false); assert.equal(cycle?.phase, 'official-result-failed');
    const r941Stability = auth.version === 'worker-code-repair-v11';
    const r941Deadline = r941Stability && auth.incident.kind === 'deadline-recovery';
    const r941Inline = r941Stability && auth.incident.kind === 'external-inline-row-limit';
    if(auth.version!=='worker-code-repair-v10' && !r941Deadline) assert.equal(cycle?.errorCode, 'SYNC_WORKER_COMMAND_FAILED');
    if(r941Deadline) {
      assert.equal(cycle?.errorCode, 'CANDIDATE_DEADLINE_HEARTBEAT_NOT_EXACT');
      assert.equal(cycle?.error, 'candidate deadline heartbeat is not exact: candidate-deadline-capture-failed');
    }
    const writer = auth.version === 'worker-code-repair-v3';
    const snapshot = auth.version === 'worker-code-repair-v4';
    const timeoutRepair = auth.version === 'worker-code-repair-v10';
    const syncMeta = auth.version === 'worker-code-repair-v9';
    const canonicalReference = auth.version === 'worker-code-repair-v8';
    const referenceIndex = auth.version === 'worker-code-repair-v7';
    const freshCapture = auth.version === 'worker-code-repair-v6' || referenceIndex || canonicalReference || syncMeta || timeoutRepair || r941Stability;
    const resultIdentity = auth.version === 'worker-code-repair-v5' || auth.version === 'worker-code-repair-v6' || canonicalReference;
    if(!timeoutRepair && !r941Deadline) assert.equal(cycle?.error, syncMeta ? 'npm run validate:data exited with 1' : referenceIndex ? 'npm run reconcile:fast-results-generation exited with 1' : snapshot ? 'npm run datastore:generation exited with 1' : writer || resultIdentity || r941Inline ? 'npm run postgres:sync exited with 1' : 'node scripts/syncData.cjs exited with 1');
    assert(Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= now
      && now - end <= 3600000 && start >= Date.parse(worker.serviceAfter.ExecMainStartTimestamp), 'failed cycle clock');
    assert.equal(observed.runtimeSha256, auth.baseRuntimeSha256);
    assert.equal(observed.completeSha256, auth.baseRuntimeSha256);
    assert.equal(observed.recoveryPending, false);
    assert.deepEqual(observed.files, auth.files.map(row => ({path:row.path,sha256:row.beforeSha256})));
    assert.deepEqual(observed.dataContract, auth.dataContract);
    const migrations = auth.dataContract.filter(row => row.path.startsWith('server/postgres/migrations/')).map(row => row.path.split('/').at(-1));
    assert.deepEqual(observed.migrationNames, migrations);
    if(['worker-code-repair-v2','worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5'].includes(auth.version)) assert.deepEqual(observed.publication,auth.publication);
    if(freshCapture) {
      validateRepairPublication(observed.publication,true);
      assert.equal(observed.publication.databaseOid,auth.publication.databaseOid);
      assert.deepEqual(observed.publication.committed,auth.publication.committed,'signed PostgreSQL commit changed');
      // Only natural forward movement may be freshly captured. A rollback of
      // either pointer does not qualify as this signed preparation scope.
      for(const name of ['rawCurrent','rawPrevious']) {
        const before=auth.publication[name],after=observed.publication[name];
        assert(Date.parse(after.committedAt)>=Date.parse(before.committedAt),'raw publication clock regressed');
        if(after.committedAt===before.committedAt) assert.deepEqual(after,before);
      }
      repeatedRepairIncident(auth,worker,observed.journal,observed.meta);
      if(r941Stability) {
        assert.deepEqual(observed.unchangedSources,auth.unchangedSources);
        assert.deepEqual(observed.addedSourcesAbsent,R941_STABILITY_ADDED);
        if(r941Inline) assertInlineSourceContinuity(auth.incident.source,observed.meta,observed.publication);
      }
      if(timeoutRepair) {
        assert.deepEqual(observed.unchangedSources,auth.unchangedSources);
        assert.deepEqual(observed.addedSourcesAbsent,TIMEOUT_ADDED);
      }
      if(syncMeta) {
        assert.deepEqual(observed.unchangedSources,auth.unchangedSources);
        assert.deepEqual(observed.addedSourcesAbsent,SYNC_META_ADDED);
      }
      if(canonicalReference) {
        assert.deepEqual(observed.canonicalReferenceSources,auth.canonicalReferenceSources);
        validateCanonicalReferenceProof(observed.canonicalReference,auth.incident);
        assert.deepEqual(observed.canonicalReference,auth.canonicalReference);
      }
      if(referenceIndex) {
        assert.deepEqual(observed.indexSources,auth.indexSources);
        assertReferenceIndexCorpus(auth.referenceIndex,observed.referenceIndex);
      }
    } else if(resultIdentity) {
      const incident=auth.incident;
      assert.equal(worker.serviceAfter.MainPID,incident.workerMainPid);
      assert.equal(new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),incident.workerStartedAt);
      assert.equal(cycle.startedAt,incident.cycleStartedAt);assert.equal(cycle.finishedAt,incident.cycleFinishedAt);
      assertResultIdentityJournal(incident,observed.journal);
    } else {
      assert(Array.isArray(observed.journal) && observed.journal.length > 0 && observed.journal.length <= 4);
      assert(observed.journal.some(row => row.unit === 'football-sync-worker.service'
      && /^[1-9][0-9]*$/.test(row.pid || '') && row.message === (snapshot ? '  "error": "source file size changed before staging: model-evaluation.json",' : writer ? '  "error": "Query read timeout",' : auth.version==='worker-code-repair-v2'
        ? 'SQLite publication identity matches neither the serving generation nor its immutable previous generation' : 'Invalid string length')
        && row.timestampMs >= start && row.timestampMs <= end), 'exact failure absent from current failed-cycle journal');
    }
    result.ok = true; result.repairPreparationAllowed = true;
  } catch { result.blockers.push('worker-code-repair-binding-rejected'); }
  return result;
}

function selectWorkerCodeRepairPreparation(auth, worker, readIncident) {
  const base = evaluateWorkerPreflight(worker);
  // Once a genuine publication has recovered, use the unchanged ordinary
  // affinity route. An inactive incident must not pin its earlier PG batch.
  if (base.ok) return { useRepair: false, report: base };
  if (typeof readIncident !== 'function') throw new Error('incident observation reader required');
  const report = evaluateWorkerCodeRepair(auth, worker, readIncident(auth, worker));
  return { useRepair: report.ok && report.repairPreparationAllowed === true, report };
}

function collectWorkerCodeRepair(auth, worker) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const assert = require('node:assert/strict'), cp = require('node:child_process');
  const root = '/opt/football-predict';
  assert.equal(fs.realpathSync(root), root);
  const plain = (relative, limit = 4 * 1024 * 1024) => {
    const file = path.join(root, relative);
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const st = fs.lstatSync(dir); assert(st.isDirectory() && !st.isSymbolicLink());
      if (dir === root) break; assert(dir !== path.dirname(dir));
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd); assert(before.isFile() && before.nlink === 1 && before.size <= limit);
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
      assert(before.ino === after.ino && before.size === bytes.length && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
      return bytes;
    } finally { fs.closeSync(fd); }
  };
  const present = file => {try {fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const identity = () => ({runtimeSha256:plain('.release-bundle-sha256',128).toString().trim(),
    completeSha256:plain('.release-live-complete',128).toString().trim(),
    recoveryPending:present('/var/lib/football-release/recovery/current')
      || present('/var/lib/football-release/reference-repairs/current')});
  const before = identity(), hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const files = auth.files.map(row => ({path:row.path,sha256:hash(plain(row.path))}));
  const dataContract = auth.dataContract.map(row => ({path:row.path,sha256:hash(plain(row.path).toString('utf8').replace(/\r\n/g,'\n'))}));
  // Native runs this reader in a VM realm. Copy the host fs array into the
  // reader's realm before the exact array comparison; names still must match.
  const migrationNames = Array.from(fs.readdirSync(root+'/server/postgres/migrations')).sort();
  const cycle = worker.status.lastCycle;
  const canonicalReference=auth.version==='worker-code-repair-v8';
  const r941Stability=auth.version==='worker-code-repair-v11';
  const r941Inline=r941Stability&&auth.incident.kind==='external-inline-row-limit';
  const r941Deadline=r941Stability&&auth.incident.kind==='deadline-recovery';
  const timeoutRepair=auth.version==='worker-code-repair-v10';
  const syncMeta=auth.version==='worker-code-repair-v9';
  const referenceIndex=auth.version==='worker-code-repair-v7';
  const freshCapture=auth.version==='worker-code-repair-v6'||referenceIndex||canonicalReference||syncMeta||timeoutRepair||r941Stability;
  const resultIdentity=auth.version==='worker-code-repair-v5'||auth.version==='worker-code-repair-v6'||canonicalReference;
  const completeIncident=resultIdentity||referenceIndex||syncMeta||timeoutRepair||r941Stability;
  let meta,unchangedSources,addedSourcesAbsent;
  if(r941Stability) {
    unchangedSources=auth.unchangedSources.map(row=>({path:row.path,sha256:hash(plain(row.path))}));
    assert.deepEqual(unchangedSources,auth.unchangedSources);
    addedSourcesAbsent=R941_STABILITY_ADDED.map(name=>{assert.equal(present(path.join(root,name)),false);return name;});
    meta=r941Inline?readInlineSource(root):readTimeoutAttempt(auth.incident);
  }
  if(timeoutRepair) {
    unchangedSources=auth.unchangedSources.map(row=>({path:row.path,sha256:hash(plain(row.path))}));
    assert.deepEqual(unchangedSources,auth.unchangedSources);
    addedSourcesAbsent=TIMEOUT_ADDED.map(name=>{assert.equal(present(path.join(root,name)),false);return name;});
    meta=readTimeoutAttempt(auth.incident);
  }
  if(syncMeta) {
    unchangedSources=auth.unchangedSources.map(row=>({path:row.path,sha256:hash(plain(row.path))}));
    assert.deepEqual(unchangedSources,auth.unchangedSources);
    addedSourcesAbsent=SYNC_META_ADDED.map(name=>{assert.equal(present(path.join(root,name)),false);return name;});
    meta=readStableMeta(root);
  }
  let indexSources,referenceProof;
  let canonicalReferenceSources,canonicalReferenceProof;
  if(canonicalReference) {
    canonicalReferenceSources=auth.canonicalReferenceSources.map(row=>({path:row.path,sha256:hash(plain(row.path))}));
    assert.deepEqual(canonicalReferenceSources,auth.canonicalReferenceSources,'reference source changed');
    canonicalReferenceProof=collectCanonicalReferenceProof(root,auth.incident);
    assert.deepEqual(canonicalReferenceProof,auth.canonicalReference,'reference original changed');
  }
  if(referenceIndex) {
    indexSources=auth.indexSources.map(row=>({path:row.path,sha256:hash(plain(row.path))}));
    assert.deepEqual(indexSources,auth.indexSources,'reference reader source changed');
    referenceProof=collectReferenceIndexProof(root);
    assertReferenceIndexCorpus(auth.referenceIndex,referenceProof);
  }
  let journal;
  if(timeoutRepair||r941Deadline) {
    journal=readCurrentTimeoutJournal(auth.incident,worker);
    timeoutIncidentProof(auth,worker,journal,meta);
  } else {
    const message = auth.version==='worker-code-repair-v4' ? '  "error": "source file size changed before staging: model-evaluation.json",' : auth.version==='worker-code-repair-v3' ? '  "error": "Query read timeout",' : auth.version==='worker-code-repair-v2'
      ? 'SQLite publication identity matches neither the serving generation nor its immutable previous generation' : 'Invalid string length';
    // Locate, rather than invent, the exact microsecond of a repeated fault.
    // A bounded grep only locates the record; admission still requires the full
    // original frame without grep (24 identity lines or five index-error lines).
    const initialAnchor=r941Inline?auth.incident.anchor:auth.incident;
    let journalTimestampUs=completeIncident?initialAnchor.journalTimestampUs:null;
    let journalPid=completeIncident?initialAnchor.journalPid:null;
    if(freshCapture) {
      const codeLine=syncMeta ? 'sync-meta.json should stay below 1MB and only expose freshness summaries.' : r941Inline ? '  "code": "POSTGRES_INLINE_ROW_LIMIT",' : referenceIndex ? '  "error": "REFERENCE_DECISION_INDEX_LIMIT",' : '  "code": "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE",';
      const located=cp.execFileSync('/usr/bin/journalctl',['--unit=football-sync-worker.service','--since='+cycle.startedAt,
        '--until='+cycle.finishedAt,'--grep=^'+codeLine+'$','--lines=64','--output=json','--no-pager'],
      {encoding:'utf8',timeout:8000,maxBuffer:128*1024});
      const rows=located.trim()?located.trim().split('\n').map(line=>JSON.parse(line)):[];
      assert.equal(rows.length,1,'latest failed cycle must contain one unambiguous result identity incident');
      const row=rows[0];assert.equal(row._SYSTEMD_UNIT,'football-sync-worker.service');assert.equal(row.MESSAGE,codeLine);
      assert.match(row._PID||'',/^[1-9][0-9]*$/);assert.match(row.__REALTIME_TIMESTAMP||'',/^[1-9][0-9]{15}$/);
      const time=Number(row.__REALTIME_TIMESTAMP)/1000;
      assert(time>=Date.parse(cycle.startedAt)&&time<=Date.parse(cycle.finishedAt),'located journal outside failed cycle');
      journalTimestampUs=row.__REALTIME_TIMESTAMP;journalPid=row._PID;
    }
    const journalSecond=completeIncident?Math.floor(Number(journalTimestampUs)/1000000):null;
    // This fault is followed immediately by the worker's large status frame.
    // Read the exact located microsecond for v7; keep the 64-row truncation
    // rejection and complete-frame check instead of admitting a clipped window.
    const epoch=us=>'@'+(us/1000000n).toString()+'.'+(us%1000000n).toString().padStart(6,'0');
    const journalArgs=referenceIndex||canonicalReference||syncMeta||r941Inline
      ? ['--unit=football-sync-worker.service','--since='+epoch(BigInt(journalTimestampUs)),'--until='+epoch(BigInt(journalTimestampUs)+1n),'--lines=64','--output=json','--no-pager']
      : completeIncident
      ? ['--unit=football-sync-worker.service','--since=@'+journalSecond,'--until=@'+(journalSecond+1),'--lines=64','--output=json','--no-pager']
      : ['--unit=football-sync-worker.service','--since='+cycle.startedAt, '--until='+cycle.finishedAt, '--grep=^'+message+'$','--lines=4','--output=json','--no-pager'];
    const lines = cp.execFileSync('/usr/bin/journalctl', journalArgs, {encoding:'utf8',timeout:8000,maxBuffer:128*1024});
    journal = lines.trim() ? lines.trim().split('\n').map(line => {
      const row=JSON.parse(line); return {unit:row._SYSTEMD_UNIT,pid:row._PID,message:row.MESSAGE,
        timestampMs:Number(row.__REALTIME_TIMESTAMP)/1000,...(completeIncident?{timestampUs:row.__REALTIME_TIMESTAMP}:{})};
    }) : [];
    if(completeIncident) {
      assert(journal.length<64,'incident journal window truncated');
      journal=journal.filter(row=>row.timestampUs===journalTimestampUs);
      assert.equal(journal[0]?.pid,journalPid);
      if(freshCapture) repeatedRepairIncident(auth,worker,journal,meta);
      else assertResultIdentityJournal(auth.incident,journal);
    }
  }
  let publication;
  if(['worker-code-repair-v2','worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5','worker-code-repair-v6','worker-code-repair-v7','worker-code-repair-v8','worker-code-repair-v9','worker-code-repair-v10','worker-code-repair-v11'].includes(auth.version)) {
    const keys=['data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at'];
    const sql="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; "+(syncMeta||timeoutRepair||r941Stability?"SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='2s'; ":'')+"SELECT json_build_object('databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'readOnly',current_setting('transaction_read_only'),'meta',(SELECT json_object_agg(key,value) FROM football.projection_meta WHERE key IN ('data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at'))); ROLLBACK;";
    const output=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-d','football','-c',sql],
      {encoding:'utf8',timeout:10000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',PGHOST:'/var/run/postgresql',PGUSER:'postgres',PGCONNECT_TIMEOUT:'5'}});
    const pg=JSON.parse(output.trim()); assert.equal(pg.readOnly,'on');
    const committed=Object.fromEntries(['mode','generationId','manifestHash','sourceCycleId','committedAt'].map((k,i)=>[k,pg.meta[keys[i]]]));
    const pointer=name=>{const file='/var/lib/football-predict/data-generations/'+name+'.json';
      assert.equal(fs.realpathSync(path.dirname(file)),path.dirname(file));const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {const s=fs.fstatSync(fd);assert(s.isFile()&&s.nlink===1&&s.size<8192);const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);assert(s.ino===after.ino&&s.size===bytes.length&&s.mtimeMs===after.mtimeMs);const row=JSON.parse(bytes);assert.equal(row.schemaVersion,1);return {mode:'active-generation',...Object.fromEntries(['generationId','manifestHash','sourceCycleId','committedAt'].map(k=>[k,row[k]]))};}finally{fs.closeSync(fd);}};
    publication=validateRepairPublication({databaseOid:pg.databaseOid,committed,rawCurrent:pointer('current'),rawPrevious:pointer('previous')},['worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5','worker-code-repair-v6','worker-code-repair-v7','worker-code-repair-v8','worker-code-repair-v9','worker-code-repair-v10','worker-code-repair-v11'].includes(auth.version));
    if(r941Inline) assertInlineSourceContinuity(auth.incident.source,meta,publication);
  }
  assert.deepEqual(identity(), before, 'runtime identity changed during incident read');
  const afterWorker=collectWorkerPreflight();
  assert.deepEqual(afterWorker.serviceBefore,worker.serviceAfter,'worker changed during incident read');
  assert.deepEqual(afterWorker.serviceAfter,worker.serviceAfter,'worker changed during incident read');
  assert.equal(afterWorker.processMatches,true);
  assert.deepEqual(afterWorker.status.lastCycle,worker.status.lastCycle,'failed cycle changed during incident read');
  if(referenceIndex) {
    assert.deepEqual(auth.indexSources.map(row=>({path:row.path,sha256:hash(plain(row.path))})),indexSources,'reference reader changed during proof');
    assert.deepEqual(auth.files.map(row=>({path:row.path,sha256:hash(plain(row.path))})),files,'repair source changed during proof');
  }
  if(canonicalReference) {
    assert.deepEqual(auth.canonicalReferenceSources.map(row=>({path:row.path,sha256:hash(plain(row.path))})),canonicalReferenceSources);
    assert.deepEqual(collectCanonicalReferenceProof(root,auth.incident),canonicalReferenceProof);
  }
  if(r941Stability) {
    if(r941Inline) assert.deepEqual(readInlineSource(root),meta,'inline source changed during incident read');
    else assert.equal(readTimeoutAttempt(auth.incident),meta,'deadline receipt changed during read');
    assert.deepEqual(auth.unchangedSources.map(row=>({path:row.path,sha256:hash(plain(row.path))})),unchangedSources);
    assert.deepEqual(auth.files.map(row=>({path:row.path,sha256:hash(plain(row.path))})),files);
    for(const name of R941_STABILITY_ADDED) assert.equal(present(path.join(root,name)),false);
  }
  if(timeoutRepair) {
    assert.equal(readTimeoutAttempt(auth.incident),meta,'deadline receipt changed during read');
    assert.deepEqual(auth.unchangedSources.map(row=>({path:row.path,sha256:hash(plain(row.path))})),unchangedSources);
    assert.deepEqual(auth.files.map(row=>({path:row.path,sha256:hash(plain(row.path))})),files);
    for(const name of TIMEOUT_ADDED) assert.equal(present(path.join(root,name)),false);
  }
  if(syncMeta) {
    assert.deepEqual(readStableMeta(root),meta,'sync metadata changed during incident read');
    assert.deepEqual(auth.unchangedSources.map(row=>({path:row.path,sha256:hash(plain(row.path))})),unchangedSources);
    assert.deepEqual(auth.files.map(row=>({path:row.path,sha256:hash(plain(row.path))})),files);
    for(const name of SYNC_META_ADDED) assert.equal(present(path.join(root,name)),false);
  }
  return {...before,files,dataContract,migrationNames,journal,...(publication?{publication}:{}),...(referenceIndex?{indexSources,referenceIndex:referenceProof}:{}),...(canonicalReference?{canonicalReferenceSources,canonicalReference:canonicalReferenceProof}:{}),...(syncMeta||timeoutRepair||r941Stability?{meta,unchangedSources,addedSourcesAbsent}:{})};
}

function candidateAuthorization(root, auth) {
  validateWorkerCodeRepairAuthorization(auth, Date.now());
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  for (const row of auth.files) {
    if (sha(fs.readFileSync(path.join(root,row.path))) !== row.afterSha256) throw Error('candidate repair file differs');
  }
  if(['worker-code-repair-v9','worker-code-repair-v10','worker-code-repair-v11'].includes(auth.version)) for(const row of [...auth.addedSources,...auth.unchangedSources]) {
    if(sha(fs.readFileSync(path.join(root,row.path)))!==row.sha256) throw Error('candidate sync-meta source differs');
  }
  if(auth.version==='worker-code-repair-v7')for(const row of auth.indexSources) {
    if(sha(fs.readFileSync(path.join(root,row.path)))!==row.sha256)throw Error('candidate reference reader differs');
  }
  if(auth.version==='worker-code-repair-v8')for(const row of auth.canonicalReferenceSources) {
    if(sha(fs.readFileSync(path.join(root,row.path)))!==row.sha256)throw Error('candidate reference source differs');
  }
  const contract = require('./releaseDataPlanePolicy.cjs').capture(root);
  if (JSON.stringify(contract.entries) !== JSON.stringify(auth.dataContract)) throw Error('repair candidate changes data contract');
  return auth;
}

function buildWorkerCodeRepairProbe(auth) {
  validateWorkerCodeRepairAuthorization(auth, Date.now());
  return "'use strict';\nconst TARGETS="+JSON.stringify(TARGETS)+",PAIR_TARGETS="+JSON.stringify(PAIR_TARGETS)+",WRITER_TARGETS="+JSON.stringify(WRITER_TARGETS)+",SNAPSHOT_TARGETS="+JSON.stringify(SNAPSHOT_TARGETS)+",RESULT_IDENTITY_TARGETS="+JSON.stringify(RESULT_IDENTITY_TARGETS)+",REFERENCE_INDEX_TARGETS="+JSON.stringify(REFERENCE_INDEX_TARGETS)+",REFERENCE_INDEX_SOURCES="+JSON.stringify(REFERENCE_INDEX_SOURCES)+",CANONICAL_REFERENCE_SOURCES="+JSON.stringify(CANONICAL_REFERENCE_SOURCES)+",CANONICAL_REFERENCE_TARGETS="+JSON.stringify(CANONICAL_REFERENCE_TARGETS)+",DATA_FILES="+JSON.stringify(DATA_FILES)+";\n"
    + 'const SYNC_META_TARGETS='+JSON.stringify(SYNC_META_TARGETS)+',SYNC_META_ADDED='+JSON.stringify(SYNC_META_ADDED)+',SYNC_META_UNCHANGED='+JSON.stringify(SYNC_META_UNCHANGED)+';\n'
    + 'const TIMEOUT_POLICY_TARGETS='+JSON.stringify(TIMEOUT_POLICY_TARGETS)+',TIMEOUT_ADDED='+JSON.stringify(TIMEOUT_ADDED)+',TIMEOUT_UNCHANGED='+JSON.stringify(TIMEOUT_UNCHANGED)+',TIMEOUT_RUNTIME='+JSON.stringify(TIMEOUT_RUNTIME)+',TIMEOUT_REPLAYS='+JSON.stringify(TIMEOUT_REPLAYS)+';\n'
    + 'const R941_BASE_RUNTIME_SHA256='+JSON.stringify(R941_BASE_RUNTIME_SHA256)+',R941_BINDING_POLICY='+JSON.stringify(R941_BINDING_POLICY)+',R941_STABILITY_TARGETS='+JSON.stringify(R941_STABILITY_TARGETS)+',R941_STABILITY_ADDED='+JSON.stringify(R941_STABILITY_ADDED)+',R941_STABILITY_UNCHANGED='+JSON.stringify(R941_STABILITY_UNCHANGED)+';\n'
    + [streamInlineObjectEntries,inlineFailure,validateInlineAnchor,inlineIncidentAnchor,repeatedInlineIncident,validateInlineSource,assertInlineSourceContinuity,canonicalMapValuesLowerBound,readInlineSource,validateR941StabilityIncident,timeoutPaths,validateTimeoutAnchor,verifyTimeoutFrame,packTimeoutJournal,unpackTimeoutJournal,currentTimeoutAnchor,timeoutIncidentProof,collectTimeoutJournal,readCurrentTimeoutJournal,readTimeoutAttempt,evaluateWorkerPreflight,collectWorkerPreflight,readStableMeta,verifySyncMetaFailure,incidentAnchor,verifyRepeatedIncident,validateSyncMetaAnchor,validateRepairPublication,validateResultIdentityIncident,assertResultIdentityJournal,repeatedResultIdentityIncident,validateReferenceIndexIncident,assertReferenceIndexJournal,repeatedReferenceIndexIncident,repeatedRepairIncident,validateReferenceIndexProof,assertReferenceIndexCorpus,measureReferenceIndexProof,collectReferenceIndexProof,validateCanonicalReferenceProof,collectCanonicalReferenceProof,validateWorkerCodeRepairAuthorization,evaluateWorkerCodeRepair,collectWorkerCodeRepair,selectWorkerCodeRepairPreparation].map(fn=>fn.toString()).join('\n')
    + '\ntry {const auth='+JSON.stringify(auth)+';const worker=collectWorkerPreflight();'
    + 'const {report}=selectWorkerCodeRepairPreparation(auth,worker,collectWorkerCodeRepair);console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}'
    + "catch {console.log(JSON.stringify({version:'worker-code-repair-preparation-v1',ok:false,workerHealthy:false,repairPreparationAllowed:false,blockers:['worker-code-repair-probe-unavailable'],readyToCutover:false,productionWrites:0}));process.exitCode=1;}";
}

module.exports={AUTH_ENTRY,TARGETS,PAIR_TARGETS,WRITER_TARGETS,SNAPSHOT_TARGETS,RESULT_IDENTITY_TARGETS,REFERENCE_INDEX_TARGETS,REFERENCE_INDEX_SOURCES,DATA_FILES,validateRepairPublication,validateResultIdentityIncident,assertResultIdentityJournal,repeatedResultIdentityIncident,validateReferenceIndexIncident,assertReferenceIndexJournal,repeatedReferenceIndexIncident,repeatedRepairIncident,validateReferenceIndexProof,assertReferenceIndexCorpus,measureReferenceIndexProof,collectReferenceIndexProof,validateWorkerCodeRepairAuthorization,evaluateWorkerCodeRepair,selectWorkerCodeRepairPreparation,collectWorkerCodeRepair,candidateAuthorization,buildWorkerCodeRepairProbe};
Object.assign(module.exports,{CANONICAL_REFERENCE_SOURCES,CANONICAL_REFERENCE_TARGETS,validateCanonicalReferenceProof,collectCanonicalReferenceProof});
Object.assign(module.exports,{TIMEOUT_POLICY_TARGETS,TIMEOUT_ADDED,TIMEOUT_UNCHANGED,TIMEOUT_RUNTIME,TIMEOUT_REPLAYS,timeoutPaths});
Object.assign(module.exports,{SYNC_META_TARGETS,SYNC_META_ADDED,SYNC_META_UNCHANGED,validateSyncMetaAnchor});
Object.assign(module.exports,{R941_BASE_RUNTIME_SHA256,R941_BINDING_POLICY,R941_STABILITY_TARGETS,R941_STABILITY_ADDED,R941_STABILITY_UNCHANGED,validateR941StabilityIncident});
if(require.main===module) {
  try {
    if(process.argv.length!==3)throw Error('exact signed source root required');
    const root=path.resolve(process.argv[2]), file=path.join(root,AUTH_ENTRY);
    let source=buildReadOnlyWorkerProbe();
    if(fs.existsSync(file)) {
      const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>16384)throw Error('repair authorization unsafe');
      source=buildWorkerCodeRepairProbe(candidateAuthorization(root,JSON.parse(fs.readFileSync(file))));
    }
    new (require('node:vm').Script)(source).runInNewContext({require,process,console,Date});
  } catch {console.log(JSON.stringify({ok:false,repairPreparationAllowed:false,readyToCutover:false,productionWrites:0,blockers:['worker-code-repair-entry-rejected']}));process.exitCode=1;}
}
