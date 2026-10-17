'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const policy = require('./releaseDataPlanePolicy.cjs');
const { NativeReleasePostgresPool } = require('./nativeReleasePostgresTransport.cjs');
const LIVE = '/opt/football-predict', STORE = '/var/lib/football-predict';
const pool = (s, name, oid) => new NativeReleasePostgresPool({ database: name, databaseOid: oid, clusterId: s.clusterId });
const driver = () => require('./nativeReleaseDataPlane.cjs');
const WAKE_TRIGGER_DEFINITION_SHA = 'b0a62d41d43b46a2b76a0745b3d1781f8348645b0e5a2d95a18482ebfe6a1e31';
async function restrictKnownWakeTrigger(source, role, directory) {
  const unsafe = (await source.query(`SELECT p.oid::text AS oid,n.nspname,p.proname,pg_get_userbyid(p.proowner) AS owner,
    p.pronargs,p.prorettype::regtype::text AS returns,p.proconfig,p.proacl,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE')`, [role])).rows;
  if (!unsafe.length) return;
  // A trigger function is NOT harmless: a reader could attach it to its own
  // TEMP table. Remove PUBLIC EXECUTE only for the exact reviewed notifier;
  // unknown definer functions or changed bodies still fail before mutation.
  assert.equal(unsafe.length, 1, 'unknown callable security-definer functions');
  const f = unsafe[0]; assert.match(f.oid, /^[1-9][0-9]*$/);
  assert.equal(f.nspname, 'football'); assert.equal(f.proname, 'wake_recommendation_workers');
  assert.equal(f.owner, 'football'); assert.equal(f.pronargs, 0); assert.equal(f.returns, 'trigger');
  assert.deepEqual(f.proconfig, ['search_path=pg_catalog']);
  assert.equal(crypto.createHash('sha256').update(f.definition).digest('hex'), WAKE_TRIGGER_DEFINITION_SHA, 'notifier definition drift');
  driver().write(path.join(directory, 'candidate-function-hardening-intent.json'), { role, oid: f.oid,
    function: 'football.wake_recommendation_workers()', definitionSha256: WAKE_TRIGGER_DEFINITION_SHA, previousAcl: f.proacl,
    operation: 'REVOKE EXECUTE FROM PUBLIC', persistentPermissionHardening: true, businessRowsChanged: 0 });
  await source.query('REVOKE EXECUTE ON FUNCTION football.wake_recommendation_workers() FROM PUBLIC');
  const after = (await source.query(`SELECT pg_get_functiondef($1::oid) AS definition,
    has_function_privilege($2,$1::oid,'EXECUTE') AS candidate_execute,
    has_function_privilege('football',$1::oid,'EXECUTE') AS owner_execute`, [f.oid, role])).rows[0];
  assert.equal(after.definition, f.definition); assert.equal(after.candidate_execute, false); assert.equal(after.owner_execute, true);
  driver().write(path.join(directory, 'candidate-function-hardened.json'), { ok: true, oid: f.oid,
    definitionSha256: WAKE_TRIGGER_DEFINITION_SHA, candidateExecute: false, productionOwnerExecute: true,
    persistentPermissionHardening: true, businessRowsChanged: 0 });
}
async function verifySchema(state) {
  const p = pool(state, 'football', state.oldDatabaseOid);
  try {
    await require('../server/postgresStore.cjs').verifyPostgresSchemaCurrent(p);
    const client = await p.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const catalog = await require('./postgresReleaseMirror.cjs').assertMirrorSourceCatalog(client);
      if (state.schemaCatalogHash) assert.equal(catalog.catalogHash, state.schemaCatalogHash, 'code release schema changed since allocation');
      await client.query('ROLLBACK');
      return { ok: true, databaseOid: state.oldDatabaseOid, catalogHash: catalog.catalogHash, databaseWrites: 0 };
    } finally { client.release(); }
  } finally { await p.end(); }
}
async function tryAllocate(sha, directory) {
  const candidateRoot = path.resolve(__dirname, '..');
  const plan = policy.classify(policy.capture(LIVE), policy.capture(candidateRoot));
  const authorizationFile = path.join(candidateRoot, 'deploy/light-server/code-release-activation-authorization.json');
  const emergency = fs.existsSync(authorizationFile)
    ? require('./releaseTransitionLease.cjs').readEmergencyCodeAuthorization(authorizationFile,
      { at: new Date().toISOString(), dataPlane: plan.mode }) : null;
  if (plan.mode !== 'code-only') return null;
  const d = driver(), oldIdentity = d.readOldRuntimeIdentity();
  assert.equal(oldIdentity.bundleMarker, oldIdentity.liveMarker, 'code release requires completed baseline');
  assert(/^FOOTBALL_STORAGE_MODE=postgres-only\s*$/m.test(fs.readFileSync('/etc/football-predict/env', 'utf8')));
  const before = d.topology();
  const state = { version: 'native-release-preparation-v1', sha, oldSha: oldIdentity.bundleMarker,
    kind: 'runtime-only', dataPlane: 'code-only', compatibility: plan, clusterId: before.clusterId,
    maintenanceOid: before.databases.postgres, oldDatabaseOid: before.databases.football,
    candidateDatabase: 'football', candidateOid: before.databases.football, archiveDatabase: null,
    accessSuffix: sha.slice(0, 12) + '_' + Math.floor(Date.now() / 1000),
    legacyBaselineSha256: null, key: crypto.randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
  if (emergency) state.emergencyActivationAuthorizationHash = emergency.authorizationHash;
  const repairFile=path.join(candidateRoot,'deploy/light-server/worker-code-repair-authorization.json');
  if(fs.existsSync(repairFile)) {
    const policy=require('./releaseWorkerCodeRepair.cjs');
    const repair=policy.candidateAuthorization(candidateRoot,JSON.parse(fs.readFileSync(repairFile)));
    const selection=policy.selectWorkerCodeRepairPreparation(repair,
      require('./releaseWorkerPreflight.cjs').collectWorkerPreflight(),policy.collectWorkerCodeRepair);
    assert.equal(selection.report.ok,true,'worker preparation changed before allocation');
    if(selection.useRepair && ['worker-code-repair-v2','worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5','worker-code-repair-v6','worker-code-repair-v7'].includes(repair.version)) {
      assert.equal(repair.baseRuntimeSha256,state.oldSha);
      assert.equal(repair.publication.databaseOid,state.oldDatabaseOid);
      state.committedGenerationRepairAuthorizationHash=crypto.createHash('sha256').update(fs.readFileSync(repairFile)).digest('hex');
      if(['worker-code-repair-v6','worker-code-repair-v7'].includes(repair.version)) state.repairCapturePolicy=repair.bindingPolicy;
    }
  }
  state.schemaCatalogHash = (await verifySchema(state)).catalogHash;
  const capacity = require('./nativeReleaseCapacity.cjs').assertNativeReleaseCapacity('code-only');
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 }); d.secureDirectory(path.dirname(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  state.contract = require('./nativeReleaseJournal.cjs').contractFor({ kind: 'runtime-only', oldIdentity,
    topology: before, nativeAlreadyActive: true });
  d.write(path.join(directory, 'capacity-before-allocation.json'), capacity);
  d.write(path.join(directory, 'allocation-intent.json'), state);
  d.write(path.join(directory, 'state.json'), state);
  // Build gets no database connection or serving credential. Prebuilt dist is
  // mandatory; npm ci/prune run with ignored lifecycle scripts in the sandbox.
  fs.writeFileSync(path.join(directory, 'build.env'), 'FOOTBALL_STORAGE_MODE=postgres-only\n', { flag: 'wx', mode: 0o600 });
  return { ok: true, directory, kind: state.kind, dataPlane: state.dataPlane,
    candidateDatabasesCreated: 0, databaseCopies: 0, productionWrites: 0 };
}
function leaseCurrent(session) {
  const context = session.publication?.context, identity = session.identity;
  assert.equal(identity?.mode, 'active-generation');
  for (const key of ['generationId', 'manifestHash', 'sourceCycleId'])
    assert.equal(context?.manifest?.[key], identity[key], 'lease generation identity mismatch');
  const entry = context.manifest.files.find(row => row.path === 'matches-current.json');
  assert(entry && entry.bytes > 0 && entry.bytes <= 32 * 1024 * 1024, 'lease current bound');
  return require('../server/dataGenerationStore.cjs').readGenerationFile(context, 'matches-current.json', { parseJson: true });
}
// Ordinary readers may serve the immutable previous generation while the
// normal publisher finishes its PostgreSQL projection. A code cutover must
// wait for the actual current pointer to match before pausing that publisher.
function assertCodeCurrentPublication(session, storeDir = STORE) {
  const generations = require('../server/dataGenerationStore.cjs');
  const same = require('./codeReleaseAcceptance.cjs').assertSamePublication;
  assert.equal(session.identity?.mode, 'active-generation');
  same(session.publication?.context?.pointer, session.identity);
  const held = generations.acquirePointerCommitLock({
    lockDir: generations.storePaths(storeDir).pointerLockDir, timeoutMs: 10000, staleMs: 60000 });
  try {
    // Resolve both immutable generations under the real pointer lock. A
    // malformed pointer, missing generation or altered payload is never busy.
    const current = generations.resolveCurrentGeneration({ storeDir });
    const fields = ['generationId', 'manifestHash', 'sourceCycleId', 'committedAt'];
    if (fields.every(field => current.pointer[field] === session.identity[field])) return;
    const previous = generations.resolvePreviousGeneration({ storeDir });
    same(previous.pointer, session.identity);
    assert.notEqual(current.pointer.generationId, previous.pointer.generationId, 'code current publication identity invalid');
    assert(Date.parse(current.pointer.committedAt) > Date.parse(previous.pointer.committedAt),
      'code current publication clock invalid');
    const error = new Error('current generation awaits its natural PostgreSQL projection before cutover');
    error.code = 'NATIVE_CURRENT_PUBLICATION_PENDING';
    throw error;
  } finally { held.release(); }
}
const FRESH_REPAIR_CAPTURE_FILE='code-repair-capture.json';
const jsonHash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicationIdentity=pointer=>({mode:'active-generation',...Object.fromEntries(
  ['generationId','manifestHash','sourceCycleId','committedAt'].map(key=>[key,pointer[key]]))});
function generationVerificationEvidence(context) {
  const manifest=context?.manifest;
  assert(manifest && Array.isArray(manifest.files) && manifest.files.length>0);
  let bytes=0;
  for(const entry of manifest.files) {assert(Number.isSafeInteger(entry.bytes)&&entry.bytes>=0);bytes+=entry.bytes;}
  assert(Number.isSafeInteger(bytes));
  // These contexts are returned only after the existing resolver has hashed
  // every actual payload file. Bind the complete manifest, not just a pointer.
  return {generationId:manifest.generationId,manifestHash:manifest.manifestHash,sourceCycleId:manifest.sourceCycleId,
    files:manifest.files.length,bytes,verifiedManifestSha256:jsonHash(manifest),
    verification:'dataGenerationStore.validateGenerationDirectory:all-file-bytes'};
}
function sealFreshRepairCapture(state,body) {
  assert.match(state.key||'',/^[a-f0-9]{64}$/);
  const sha256=jsonHash(body);
  return {version:'code-repair-capture-v1',body,sha256,
    hmac:crypto.createHmac('sha256',state.key).update('code-repair-capture-v1\0'+sha256).digest('hex')};
}
function assertFreshRepairCapture(state,capture,authorization,authorizationHash) {
  const repair=require('./releaseWorkerCodeRepair.cjs');
  assert(['worker-code-repair-v6','worker-code-repair-v7'].includes(authorization.version));
  assert.equal(state.repairCapturePolicy,authorization.bindingPolicy);
  assert.deepEqual(capture,sealFreshRepairCapture(state,capture.body),'repair capture content or state MAC changed');
  const body=capture.body;
  assert.equal(body.stateHash,jsonHash(state));assert.equal(body.sha,state.sha);assert.equal(body.oldSha,state.oldSha);
  assert.equal(body.authorizationHash,authorizationHash);assert.equal(authorizationHash,state.committedGenerationRepairAuthorizationHash);
  assert.equal(body.publication.databaseOid,state.oldDatabaseOid);
  repair.validateRepairPublication(body.publication,true);
  const clock=Date.parse(body.checkedAt);assert(Number.isFinite(clock)&&clock<=Date.now());
  assert(clock>=Date.parse(state.createdAt)&&clock>=Date.parse(body.worker.checkedAt));
  assert(clock-Date.parse(body.worker.checkedAt)<=60000,'captured worker observation stale');
  assert(['repair','ordinary'].includes(body.route));
  if(body.route==='repair') {
    const report=repair.evaluateWorkerCodeRepair(authorization,body.worker,body.observed);
    assert.equal(report.ok,true);assert.equal(report.workerHealthy,false);
    assert.deepEqual(body.publication,body.observed.publication);
    assert.deepEqual(body.incident,repair.repeatedRepairIncident(authorization,body.worker,body.observed.journal));
  } else {
    assert.equal(body.observed,null);assert.equal(body.incident,null);
    assert.equal(require('./releaseWorkerPreflight.cjs').evaluateWorkerPreflight(body.worker).ok,true);
    require('./codeReleaseAcceptance.cjs').assertSamePublication(body.publication.committed,body.publication.rawCurrent);
  }
  for(const name of ['committed','rawCurrent','rawPrevious']) {
    const evidence=body.generationEvidence[name],identity=body.publication[name];
    for(const key of ['generationId','manifestHash','sourceCycleId']) assert.equal(evidence[key],identity[key]);
    assert(Number.isSafeInteger(evidence.files)&&evidence.files>0&&Number.isSafeInteger(evidence.bytes)&&evidence.bytes>=0);
    assert.match(evidence.verifiedManifestSha256||'',/^[a-f0-9]{64}$/);
    assert.equal(evidence.verification,'dataGenerationStore.validateGenerationDirectory:all-file-bytes');
  }
  return body;
}
function readFreshRepairCapture(state,authorization,authorizationHash) {
  assert.match(state.sha||'',/^[a-f0-9]{64}$/);
  const directory='/var/lib/football-release/native/'+state.sha;
  // The existing root-owned reader checks every parent, plain/nlink/uid/mode,
  // O_NOFOLLOW and inode. The writer uses wx + file and parent-directory fsync.
  const capture=driver().read(path.join(directory,FRESH_REPAIR_CAPTURE_FILE));
  const body=assertFreshRepairCapture(state,capture,authorization,authorizationHash);
  const input=driver().read(path.join(directory,'code-lease-input.json'));
  assert.equal(input.sha,state.sha);assert.equal(input.repairCaptureSha256,jsonHash(capture));
  assert.equal(input.capturedAt,body.checkedAt);
  require('./codeReleaseAcceptance.cjs').assertSamePublication(input.identity,body.publication.committed);
  assertCodeArchiveCoverageClock(input.archiveReadiness,Date.now());
  return capture;
}
function assertRepairPair(state, session, current, previous, authorization, authorizationHash, freshCapture=null) {
  const repair=require('./releaseWorkerCodeRepair.cjs');
  repair.validateWorkerCodeRepairAuthorization(authorization,Date.now());
  assert(['worker-code-repair-v2','worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5','worker-code-repair-v6','worker-code-repair-v7'].includes(authorization.version));
  assert.equal(authorizationHash,state.committedGenerationRepairAuthorizationHash);
  assert.equal(authorization.baseRuntimeSha256,state.oldSha);
  assert.equal(authorization.publication.databaseOid,state.oldDatabaseOid);
  assert.equal(state.dataPlane,'code-only');
  const same=require('./codeReleaseAcceptance.cjs').assertSamePublication;
  const fresh=['worker-code-repair-v6','worker-code-repair-v7'].includes(authorization.version)
    ? assertFreshRepairCapture(state,freshCapture,authorization,authorizationHash) : null;
  const publication=fresh?fresh.publication:authorization.publication;
  same(publication.committed,session.identity);
  same(session.publication?.context?.pointer,session.identity);
  assert.equal(session.publication?.pairing?.reason,'exact-committed-postgres-generation');
  same(publication.rawCurrent,current.pointer);
  same(publication.rawPrevious,previous.pointer);
  if(fresh) {
    assert.deepEqual(generationVerificationEvidence(current),fresh.generationEvidence.rawCurrent);
    assert.deepEqual(generationVerificationEvidence(previous),fresh.generationEvidence.rawPrevious);
    assert.deepEqual(generationVerificationEvidence(session.publication.context),fresh.generationEvidence.committed);
  }
  return {version:'signed-committed-generation-repair-pair-v1',reason:'exact-signed-incident-pair',
    committed:session.identity,rawCurrent:current.pointer,rawPrevious:previous.pointer,productionWrites:0,
    ...(fresh?{captureSha256:jsonHash(freshCapture),bindingPolicy:authorization.bindingPolicy,route:fresh.route}:{})};
}
function assertCodePublicationForState(state,session,storeDir=STORE,pointerLockHandle=null) {
  if(!state.committedGenerationRepairAuthorizationHash) return assertCodeCurrentPublication(session,storeDir);
  // Only the incident-bound, signed code-only route can retain the exact PG
  // commit while unaccepted raw generations await repair. Neither pointer nor
  // database metadata is changed; ordinary cutovers retain the affinity gate.
  const file=path.join(__dirname,'../deploy/light-server/worker-code-repair-authorization.json');
  const bytes=fs.readFileSync(file),authorization=JSON.parse(bytes),generations=require('../server/dataGenerationStore.cjs');
  require('./releaseWorkerCodeRepair.cjs').candidateAuthorization(path.resolve(__dirname,'..'),authorization);
  const freshCapture=['worker-code-repair-v6','worker-code-repair-v7'].includes(authorization.version)
    ? readFreshRepairCapture(state,authorization,crypto.createHash('sha256').update(bytes).digest('hex')) : null;
  const held=pointerLockHandle||generations.acquirePointerCommitLock({lockDir:generations.storePaths(storeDir).pointerLockDir,timeoutMs:10000,staleMs:60000});
  try {
    return assertRepairPair(state,session,generations.resolveCurrentGeneration({storeDir}),
      generations.resolvePreviousGeneration({storeDir}),authorization,crypto.createHash('sha256').update(bytes).digest('hex'),freshCapture);
  } finally {if(!pointerLockHandle)held.release();}
}
function assertFreshCaptureAbsent(directory) {
  // A partial first capture is terminal too. Never repair/replace these files
  // in place or restart preparation with a newer pair or a later lease clock.
  for(const name of [FRESH_REPAIR_CAPTURE_FILE,'code-lease-input.json','code-lease-current.json','code-transition-lease.json']) {
    try {fs.lstatSync(path.join(directory,name));} catch(error) {if(error.code==='ENOENT')continue;throw error;}
    throw new Error('fresh repair capture already exists; re-capture is forbidden');
  }
}
function captureFreshRepairPair(state,session,directory,storeDir=STORE) {
  const repair=require('./releaseWorkerCodeRepair.cjs'),generations=require('../server/dataGenerationStore.cjs');
  const same=require('./codeReleaseAcceptance.cjs').assertSamePublication;
  assert.equal(directory,'/var/lib/football-release/native/'+state.sha);
  assertFreshCaptureAbsent(directory);
  assert.deepEqual(driver().read(path.join(directory,'state.json')),state,'allocation state changed before capture');
  const file=path.join(__dirname,'../deploy/light-server/worker-code-repair-authorization.json');
  const bytes=fs.readFileSync(file),authorization=repair.candidateAuthorization(path.resolve(__dirname,'..'),JSON.parse(bytes));
  const authorizationHash=crypto.createHash('sha256').update(bytes).digest('hex');
  assert(['worker-code-repair-v6','worker-code-repair-v7'].includes(authorization.version));
  assert.equal(authorizationHash,state.committedGenerationRepairAuthorizationHash);
  assert.equal(state.repairCapturePolicy,authorization.bindingPolicy);
  assert.equal(authorization.baseRuntimeSha256,state.oldSha);
  assert.equal(authorization.publication.databaseOid,state.oldDatabaseOid);
  // Expensive immutable payload hashing is outside the global pointer lock.
  // The protected PG session has separately validated and retained its exact
  // committed generation. Removal/mutation of a raw generation fails closed.
  const current=generations.resolveCurrentGeneration({storeDir});
  const previous=generations.resolvePreviousGeneration({storeDir});
  const worker=require('./releaseWorkerPreflight.cjs').collectWorkerPreflight();
  let observed=null;
  const selected=repair.selectWorkerCodeRepairPreparation(authorization,worker,(auth,w)=>{
    observed=repair.collectWorkerCodeRepair(auth,w);return observed;
  });
  assert.equal(selected.report.ok,true,'fresh worker repair observation rejected');
  const publication=repair.validateRepairPublication({databaseOid:state.oldDatabaseOid,
    committed:publicationIdentity(session.identity),rawCurrent:publicationIdentity(current.pointer),rawPrevious:publicationIdentity(previous.pointer)},true);
  same(session.publication?.context?.pointer,session.identity);
  assert.equal(session.publication?.pairing?.reason,'exact-committed-postgres-generation');
  if(selected.useRepair) assert.deepEqual(observed.publication,publication,'fresh capture and read-only observation disagree');
  else if(['generationId','manifestHash','sourceCycleId','committedAt'].some(key=>current.pointer[key]!==session.identity[key])) {
    // Reuse the unchanged ordinary pending/malformed distinction. A recovered
    // worker never reads, or falls back to, the earlier incident authorization.
    assertCodeCurrentPublication(session,storeDir);
    throw new Error('ordinary current publication changed during capture');
  }
  const paths=generations.storePaths(storeDir);
  const held=generations.acquirePointerCommitLock({lockDir:paths.pointerLockDir,timeoutMs:10000,staleMs:60000});
  try {
    same(generations.readPointer(paths.currentPointer),current.pointer);
    same(generations.readPointer(paths.previousPointer),previous.pointer);
    const body={sha:state.sha,oldSha:state.oldSha,stateHash:jsonHash(state),authorizationHash,
      checkedAt:new Date().toISOString(),route:selected.useRepair?'repair':'ordinary',publication,worker,observed,
      incident:selected.useRepair?repair.repeatedRepairIncident(authorization,worker,observed.journal):null,
      generationEvidence:{committed:generationVerificationEvidence(session.publication.context),
        rawCurrent:generationVerificationEvidence(current),rawPrevious:generationVerificationEvidence(previous)}};
    const capture=sealFreshRepairCapture(state,body);
    const incidentPair=assertRepairPair(state,session,current,previous,authorization,authorizationHash,capture);
    driver().write(path.join(directory,FRESH_REPAIR_CAPTURE_FILE),capture);
    return {capture,incidentPair};
  } finally {held.release();}
}
// A reader briefly competes with the normal publisher/retention pointer lock.
// Retry the complete read session, never reuse its old PostgreSQL snapshot.
// This is preparation while live services remain running. The fresh transition
// lease and its unchanged 900s cutover budget are created only after it succeeds.
async function retryLeaseRead(operation, delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  clock = () => require('node:perf_hooks').performance.now(), report = () => {}) {
  const started = clock(); let previous = started, lastError = null, lastReason = null;
  const elapsed = () => {
    const current = clock(); assert(Number.isFinite(current) && current >= previous, 'lease preparation clock invalid');
    previous = current; return current - started;
  };
  assert(Number.isFinite(started));
  for (let attempt = 1; attempt <= 61; attempt++) {
    const operationRemainingMs = 600_000 - elapsed();
    if (operationRemainingMs <= 0) {
      const error = new Error('lease preparation contention deadline exceeded' + (lastReason ? ': ' + lastReason : ''), { cause: lastError });
      error.code = 'NATIVE_LEASE_PREPARATION_TIMEOUT';
      throw error;
    }
    try { return await operation({ remainingMs: operationRemainingMs }); }
    catch (error) {
      const busy = error?.code === 'POINTER_LOCK_TIMEOUT'
        || error?.code === 'NATIVE_RESULT_ARCHIVE_PENDING'
        || error?.code === 'NATIVE_CURRENT_PUBLICATION_PENDING'
        || error?.message === 'native receipt read barrier busy; retry after projection completes';
      if (!busy || attempt === 61) throw error;
      lastError = error;
      lastReason = error.code === 'POINTER_LOCK_TIMEOUT' ? 'pointer-lock-busy'
        : error.code === 'NATIVE_RESULT_ARCHIVE_PENDING' ? 'result-archive-pending'
          : error.code === 'NATIVE_CURRENT_PUBLICATION_PENDING' ? 'current-publication-pending' : 'projection-receipt-barrier-busy';
      const elapsedMs = elapsed(), remaining = 600_000 - elapsedMs;
      report({ version: 'code-release-preparation-wait-v1', attempt, elapsedMs,
        remainingMs: Math.max(0, remaining), reason: lastReason,
        pendingRows: lastReason === 'result-archive-pending' && Number.isInteger(error.pendingRows)
          && error.pendingRows >= 1 && error.pendingRows <= 512 ? error.pendingRows : null });
      if (remaining <= 0) {
        const timeout = new Error('lease preparation contention deadline exceeded: ' + lastReason, { cause: error });
        timeout.code = 'NATIVE_LEASE_PREPARATION_TIMEOUT';
        throw timeout;
      }
      await delay(Math.min(10_000, remaining));
    }
  }
}
// A kickoff can precede the next complete worker projection. Check the actual
// PG rows before pausing that worker; waiting after pause cannot close the gap.
// Reuse the final API archive predicate, never manufacture an archive or accept
// an invalid existing one. The candidate/final health checks remain mandatory.
function assertResultArchivesReady(rows, nowMs) {
  assert(Array.isArray(rows) && rows.length <= 512, 'archive preparation row bound');
  assert(Number.isFinite(nowMs), 'archive preparation clock invalid');
  assert(Buffer.byteLength(JSON.stringify(rows)) <= 32 * 1024 * 1024, 'archive preparation byte bound');
  const parity = require('../server/recommendationProjectionParity.cjs');
  const pending = [];
  for (const match of rows) {
    assert(match && typeof match === 'object' && !Array.isArray(match), 'archive preparation row invalid');
    if (!parity.isResultPhase(match, nowMs) || !parity.hasDirectionalEvidence(match)) continue;
    if (match.archivedPreMatchPrediction == null) pending.push(parity.canonicalId(match));
    else assert(parity.validateArchivedDecision(match).valid, 'archive preparation existing archive invalid');
  }
  if (pending.length) {
    const error = new Error('result-phase archive pending natural projection before cutover');
    error.code = 'NATIVE_RESULT_ARCHIVE_PENDING';
    error.pendingRows = pending.length;
    throw error;
  }
  return { checkedRows: rows.length, pendingRows: 0 };
}
// Code deployment pauses the only normal archive producer. A row which is
// pre-match at capture can enter result phase while that producer is stopped.
// Prove the exact same archive predicate across the complete cutover lifetime
// (including its reserved final-readiness time) before touching service state. This is a
// data-readiness check, not a schedule window: a valid existing archive permits
// the crossing, and a directionless result still needs no invented archive.
const CODE_ARCHIVE_LEASE_SECONDS = 900;
function assertCodeCutoverArchivesReady(rows, nowMs) {
  assert(Number.isSafeInteger(nowMs), 'code archive preparation clock invalid');
  const throughMs = nowMs + CODE_ARCHIVE_LEASE_SECONDS * 1000;
  assert(Number.isSafeInteger(throughMs) && Number.isFinite(new Date(throughMs).getTime()),
    'code archive preparation horizon invalid');
  const ready = assertResultArchivesReady(rows, throughMs);
  return { ...ready, checkedAt: new Date(nowMs).toISOString(),
    requiredThrough: new Date(throughMs).toISOString(),
    leaseSeconds: CODE_ARCHIVE_LEASE_SECONDS };
}
function assertCodeArchiveCoverageClock(readiness, nowMs) {
  assert(Number.isSafeInteger(nowMs), 'code archive completion clock invalid');
  const checkedAtMs = Date.parse(readiness?.checkedAt), throughMs = Date.parse(readiness?.requiredThrough);
  assert(Number.isFinite(checkedAtMs) && Number.isFinite(throughMs)
    && readiness.leaseSeconds === CODE_ARCHIVE_LEASE_SECONDS && readiness.pendingRows === 0
    && throughMs - checkedAtMs === CODE_ARCHIVE_LEASE_SECONDS * 1000,
  'code archive coverage clock proof invalid');
  assert(nowMs >= checkedAtMs && nowMs < throughMs, 'code archive coverage clock expired');
}
function verifyCodeCutoverCompletionClock(state, directory) {
  assert.equal(state.dataPlane, 'code-only');
  const input = driver().read(path.join(directory, 'code-lease-input.json'));
  assert.equal(input.sha, state.sha);
  // The existing native journal reader is limited to 1MiB. This is the
  // already bounded full current input (up to 32MiB), not a small journal.
  driver().secureDirectory(directory);
  const currentFile = path.join(directory, 'code-lease-current.json'), before = fs.lstatSync(currentFile);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === 0
    && !(before.mode & 0o077) && before.size > 0 && before.size <= 32 * 1024 * 1024 + 1, 'code lease current file invalid');
  const fd = fs.openSync(currentFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fs.fstatSync(fd); assert.equal(opened.ino, before.ino); assert.equal(opened.dev, before.dev);
    bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
    assert.equal(bytes.length, before.size); assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
  } finally { fs.closeSync(fd); }
  const current = JSON.parse(bytes);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex'), input.currentHash);
  const lease = driver().read(path.join(directory, 'code-transition-lease.json'));
  assert.equal(lease.minimumHorizonSeconds, CODE_ARCHIVE_LEASE_SECONDS);
  const verifiedAt = new Date().toISOString();
  assertCodeArchiveCoverageClock(input.archiveReadiness, Date.parse(verifiedAt));
  const transitions = require('./releaseTransitionLease.cjs');
  const emergency = state.emergencyActivationAuthorizationHash
    ? transitions.readEmergencyCodeAuthorization(path.join(__dirname, '../deploy/light-server/code-release-activation-authorization.json'),
      { at: verifiedAt, dataPlane: state.dataPlane }) : null;
  if (emergency) assert.equal(emergency.authorizationHash, state.emergencyActivationAuthorizationHash);
  // Verify the original persisted input, not the live generation. The normal
  // worker has restarted by this point and may legitimately publish new data.
  return transitions.verifyTransitionLease(current, lease, { verifiedAt, requiredMarginSeconds: 30,
    emergencyAuthorization: emergency?.authorization || null, dataPlane: state.dataPlane });
}
async function captureLeaseInput(state, directory) {
  return retryLeaseRead(({ remainingMs }) => captureLeaseInputOnce(state, directory,
    { receiptWaitMs: Math.min(60_000, Math.floor(remainingMs)) }), undefined, undefined,
    diagnostic => process.stderr.write(JSON.stringify(diagnostic) + '\n'));
}
async function readCodeCutoverArchiveAuthority(client, rows, nowMs) {
  const authority = require('../server/recommendationAuthority.cjs');
  const verified = await authority.readPublicationAuthority(client, { policy: authority.TRAINED_ONLY_POLICY, asOf: nowMs });
  const projected = rows.map(row => authority.projectRetiredCurrent(row, verified));
  return { ...assertCodeCutoverArchivesReady(projected, nowMs),
    publicationAuthority: authority.summarizeAuthority(verified),
    retiredLegacyArchiveMissingRows: projected.filter(row => row?.recommendationAuthority?.legacyArchiveState === 'missing').length };
}
async function captureLeaseInputOnce(state, directory, { receiptWaitMs = 2000 } = {}) {
  assert.equal(state.dataPlane, 'code-only');
  if(state.repairCapturePolicy) assertFreshCaptureAbsent(directory);
  if (state.emergencyActivationAuthorizationHash) {
    const authorization = require('./releaseTransitionLease.cjs').readEmergencyCodeAuthorization(
      path.join(__dirname, '../deploy/light-server/code-release-activation-authorization.json'),
      { at: new Date().toISOString(), dataPlane: state.dataPlane });
    assert.equal(authorization.authorizationHash, state.emergencyActivationAuthorizationHash, 'emergency activation authorization changed');
  }
  const old = driver().readOldRuntimeIdentity();
  assert.equal(old.bundleMarker, state.oldSha); assert.equal(old.liveMarker, state.oldSha);
  const source = pool(state, 'football', state.oldDatabaseOid); let session;
  try {
    session = await require('./postgresRuntimeReadSession.cjs').openPostgresRuntimeReadSession({ pool: source,
      storeDir: STORE, publicDataDir: LIVE + '/public/data', protectReceipt: true, receiptWaitMs });
    await session.guardedFinals();
    const current = leaseCurrent(session);
    await session.client.query("SET LOCAL statement_timeout = '8000ms'");
    const archiveRows = await session.client.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' ORDER BY match_id LIMIT 513");
    const archiveReadiness = await readCodeCutoverArchiveAuthority(session.client, archiveRows.rows.map(row => row.payload), Date.now());
    const fresh=state.repairCapturePolicy?captureFreshRepairPair(state,session,directory):null;
    const incidentPair=fresh?fresh.incidentPair:assertCodePublicationForState(state,session);
    // The lease and seed must describe the same PostgreSQL-bound immutable
    // generation. The mutable APP projection may have different cutoff clocks.
    driver().write(path.join(directory, 'code-lease-current.json'), current);
    const proof = { sha: state.sha, identity: session.identity,
      currentHash: crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex'), capturedAt: fresh?fresh.capture.body.checkedAt:new Date().toISOString(), archiveReadiness,
      ...(fresh?{repairCaptureSha256:jsonHash(fresh.capture)}:{}),
      ...(incidentPair?{incidentPair}:{}) };
    driver().write(path.join(directory, 'code-lease-input.json'), proof);
    return { ok: true, identity: session.identity, productionWrites: 0 };
  } finally { if (session) await session.close(); await source.end(); }
}
async function seed(state, directory) {
  assert.equal(state.dataPlane, 'code-only');
  await verifySchema(state);
  const source = pool(state, 'football', state.oldDatabaseOid); let session;
  try {
    session = await require('./postgresRuntimeReadSession.cjs').openPostgresRuntimeReadSession({ pool: source,
      // Keep one bounded FIFO position while an already admitted projection drains.
      // This consumes the original cutover lease; no lease is refreshed and any
      // publication identity advance still rejects below before candidate copying.
      storeDir: STORE, publicDataDir: LIVE + '/public/data', protectReceipt: true, receiptWaitMs: 60_000 });
    await session.guardedFinals();
    const leaseInput = driver().read(path.join(directory, 'code-lease-input.json'));
    assert.equal(leaseInput.sha, state.sha);
    require('./codeReleaseAcceptance.cjs').assertSamePublication(leaseInput.identity, session.identity);
    // A move after capture fails before candidate copying. The original lease
    // and its 900-second clock are never refreshed inside the paused phase.
    assertCodePublicationForState(state,session);
    const store = path.join(directory, 'code-seed-store');
    const generation = await driver().copyGenerationAsService(session.identity, store);
    const proof = { ok: true, sha: state.sha, seed: true, dataPlane: 'code-only', store,
      identity: session.identity, generation, backup: null, mirror: null,
      databaseCopies: 0, productionWrites: 0, completedAt: new Date().toISOString() };
    driver().write(path.join(directory, 'seed-accepted.json'), proof); return proof;
  } finally { if (session) await session.close(); await source.end(); }
}
async function candidateAccess(state, directory) {
  assert.equal(state.dataPlane, 'code-only');
  const role = 'football_candidate_' + state.accessSuffix;
  assert.match(role, /^football_candidate_[a-f0-9]{12}_[0-9]{1,10}$/);
  const password = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const admin = pool(state, 'postgres', state.maintenanceOid), source = pool(state, 'football', state.oldDatabaseOid);
  // Commit the cleanup identity BEFORE any role mutation. Failure after a grant
  // still leaves enough information for deterministic retirement.
  driver().write(path.join(directory, 'candidate-access-intent.json'), { role, database: 'football', expiresAt });
  try {
    assert.equal((await admin.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=$1', [role])).rows[0].n, 0);
    await admin.query(`SET password_encryption='scram-sha-256'; CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '${password}' VALID UNTIL '${expiresAt}'`);
    await admin.query(`GRANT CONNECT ON DATABASE football TO "${role}"; ALTER ROLE "${role}" SET default_transaction_read_only=on; ALTER ROLE "${role}" SET statement_timeout='120s'`);
    await source.query(`GRANT USAGE ON SCHEMA football TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA football TO "${role}"`);
    // Defense beyond default_transaction_read_only: a caller may SET it off.
    const unsafe = (await source.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='football' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`, [role])).rows[0].n;
    assert.equal(unsafe, 0, 'candidate acquired production write privileges');
    await restrictKnownWakeTrigger(source, role, directory);
    const funcs = (await source.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE')`, [role])).rows[0].n;
    assert.equal(funcs, 0, 'candidate can execute custom security-definer function');
    const environmentFile = path.join(directory, 'candidate.env');
    const lines = Object.entries(require('./nativeReleaseJournal.cjs').NATIVE_SELECTORS).map(([k, v]) => k + '=' + v);
    lines.push('FOOTBALL_POSTGRES_URL=postgresql://' + role + ':' + password + '@127.0.0.1:5432/football', 'FOOTBALL_POSTGRES_SSL_MODE=disable');
    fs.writeFileSync(environmentFile, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    const proof = { ok: true, role, database: 'football', environmentFile, readOnly: true, expiresAt, productionWritePrivileges: 0 };
    driver().write(path.join(directory, 'candidate-access.json'), proof); return proof;
  } finally { await source.end(); await admin.end(); }
}
async function retire(state, directory) {
  assert.equal(state.dataPlane, 'code-only'); const file = path.join(directory, 'candidate-access-intent.json');
  if (!fs.existsSync(file)) return { ok: true, roleCreated: false };
  const { role } = driver().read(file); assert.equal(role, 'football_candidate_' + state.accessSuffix);
  const admin = pool(state, 'postgres', state.maintenanceOid), source = pool(state, 'football', state.oldDatabaseOid);
  try {
    assert.equal((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1', [role])).rows[0].n, 0, 'candidate sessions remain');
    if ((await admin.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=$1', [role])).rows[0].n) {
      // Never DROP OWNED in the serving database. Unexpected dependencies fail
      // the ordinary DROP ROLE and remain as evidence for recovery.
      await source.query(`REVOKE SELECT ON ALL TABLES IN SCHEMA football FROM "${role}"; REVOKE USAGE ON SCHEMA football FROM "${role}"`);
      await admin.query(`REVOKE CONNECT ON DATABASE football FROM "${role}"; DROP ROLE "${role}"`);
    }
    const proof = { ok: true, role, terminatedConnections: 0, databaseRowsChanged: 0 };
    const receipt = path.join(directory, 'candidate-access-dropped.json');
    if (!fs.existsSync(receipt)) driver().write(receipt, proof);
    return proof;
  } finally { await source.end(); await admin.end(); }
}
function retireSeed(sha) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0); assert.match(sha, /^[a-f0-9]{64}$/);
  const d = driver(), directory = '/var/lib/football-release/native/' + sha;
  const state = d.read(path.join(directory, 'state.json'));
  assert.equal(state.sha, sha); assert.equal(state.dataPlane, 'code-only');
  const live = d.readOldRuntimeIdentity(); assert.equal(live.bundleMarker, sha); assert.equal(live.liveMarker, sha);
  assert.equal(fs.existsSync('/var/lib/football-release/recovery/current'), false, 'recovery still active');
  assert.equal(d.read(path.join(directory, 'candidate-access-dropped.json')).ok, true);
  const proof = d.read(path.join(directory, 'seed-accepted.json')), target = path.join(directory, 'code-seed-store');
  assert.equal(proof.store, target); assert.equal(proof.dataPlane, 'code-only');
  assert.equal(fs.realpathSync(target), target); d.secureDirectory(target);
  const before = fs.lstatSync(target), entries = []; let bytes = 0;
  function visit(file) {
    const s = fs.lstatSync(file); assert(!s.isSymbolicLink() && s.dev === before.dev && s.uid === 0 && !(s.mode & 0o022));
    assert(entries.length < 100000); entries.push([path.relative(target, file), s.ino, s.size, s.mtimeMs]);
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else { assert(s.isFile() && s.nlink === 1); bytes += s.size; }
  }
  visit(target);
  const intent = { sha, target, entries: entries.length, bytes, metadataHash: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
  d.write(path.join(directory, 'code-seed-retirement-intent.json'), intent);
  assert.equal(fs.lstatSync(target).ino, before.ino);
  // Root-owned disposable snapshot only. Database, signatures, state, frozen
  // records and recovery evidence are outside this exact directory.
  fs.rmSync(target, { recursive: true });
  d.write(path.join(directory, 'code-seed-retired.json'), { ...intent, removed: true, completedAt: new Date().toISOString() });
  return { ok: true, bytes, removed: true };
}
module.exports = { tryAllocate, verifySchema, seed, candidateAccess, retire, retireSeed, restrictKnownWakeTrigger, leaseCurrent, assertCodeCurrentPublication, assertCodePublicationForState, assertRepairPair, captureLeaseInput, retryLeaseRead, assertResultArchivesReady, assertCodeCutoverArchivesReady, readCodeCutoverArchiveAuthority, assertCodeArchiveCoverageClock, verifyCodeCutoverCompletionClock, generationVerificationEvidence, sealFreshRepairCapture, assertFreshRepairCapture, readFreshRepairCapture, assertFreshCaptureAbsent, captureFreshRepairPair };
if (require.main === module) {
  (async () => {
    assert.equal(process.argv.length, 4); const action = process.argv[2], sha = process.argv[3];
    assert(['retire-seed', 'lease-input', 'complete-clock'].includes(action)); assert.match(sha, /^[a-f0-9]{64}$/);
    if (action === 'retire-seed') return retireSeed(sha);
    assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
    const directory = '/var/lib/football-release/native/' + sha, state = driver().read(path.join(directory, 'state.json'));
    assert.equal(state.sha, sha);
    if (action === 'complete-clock') return verifyCodeCutoverCompletionClock(state, directory);
    return captureLeaseInput(state, directory);
  })().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
