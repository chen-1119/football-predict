'use strict';
// Incident-specific maintenance. This never dispatches or relaxes a full release.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict'), Module = require('node:module');
const crypto = require('node:crypto');
const policy = require('./officialClosureRepairPolicy.cjs');
const APP = '/opt/football-predict', STORE = '/var/lib/football-predict';
const ROOT = '/var/lib/football-release/closure-repairs', NODE = '/opt/node-v22.22.1/bin/node';
const ENTRY = '/usr/local/sbin/football-release', LOCK = '/run/lock/football-release.lock';
const RELAY = STORE + '/sporttery-relay-snapshot.json';
const REGISTRY = APP + '/deploy/light-server/collector-trust-registry.json';
const UNITS = Object.freeze(['football-cleanup.timer', 'football-monitor.timer', 'football-daily-prematch.timer',
  'football-featured-combo.timer', 'football-postgres-backup.timer', 'football-cleanup.service', 'football-monitor.service',
  'football-daily-prematch.service', 'football-postgres-backup.service', 'football-postgres-cos-upload.service',
  'football-market-collector.service', 'football-featured-combo.service', 'football-recommendation-settlement.service',
  'football-sync-worker.service', 'football-predict.service']);
const PROOF_CODE = ['scripts/validateData.cjs', 'scripts/currentMatchRetention.cjs', 'scripts/resultOnlyValidation.cjs',
  'scripts/sportteryEndpointContract.cjs', 'scripts/officialClosedScheduleEvidence.cjs', 'server/chunkedJsonFile.cjs',
  'server/relayCollectorEvidence.cjs', 'src/services/collectorAttestation.cjs', 'src/services/dualMarketDecisionBinding.cjs',
  'src/services/hhadCompanionShadow.cjs', 'src/services/matchLifecycle.cjs', 'src/services/strictInstant.cjs'];
const run = (name, args, options = {}) => cp.execFileSync(name, args, { encoding: 'utf8', timeout: 60000,
  maxBuffer: 8 * 1024 ** 2, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', PGHOST: '/var/run/postgresql' }, ...options });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const objectHash = value => policy.hash(JSON.stringify(stable(value)));
function regular(file, max = 64 * 1024 ** 2) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max, 'unsafe or oversized file: ' + file);
  assert.equal(fs.realpathSync(file), file, 'noncanonical file path'); return stat;
}
function bytes(file, max) { regular(file, max); return fs.readFileSync(file); }
const read = file => JSON.parse(bytes(file));
const digest = file => policy.hash(bytes(file));
const receipt = file => { const raw = bytes(file); return { path: file, bytes: raw.length, sha256: policy.hash(raw) }; };
function writeOnce(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function replace(file, raw, stat) {
  assert.equal(fs.realpathSync(path.dirname(file)), path.dirname(file));
  const temporary = file + '.closure-' + process.pid, fd = fs.openSync(temporary, 'wx', stat.mode & 0o777);
  try { fs.writeFileSync(fd, raw); fs.fchownSync(fd, stat.uid, stat.gid); fs.fchmodSync(fd, stat.mode & 0o777); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); const parent = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function renameDurable(source, target) {
  fs.renameSync(source, target);
  for (const directory of new Set([path.dirname(source), path.dirname(target)])) {
    const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
function syncBackupDirectories(dir, files) {
  const directories = new Set();
  for (const file of files) if (file.beforeSha256 !== null) {
    assert.ok(policy.FILES.includes(file.path), 'backup path outside reviewed file scope');
    for (let directory = path.dirname(dir + '/backup/' + file.path);; directory = path.dirname(directory)) {
      assert.ok(directory === dir || directory.startsWith(dir + '/'), 'backup directory escaped capsule');
      directories.add(directory); if (directory === dir) break;
    }
  }
  // Persist child entries before their parent links, including backup/scripts,
  // backup, and the capsule directory, before journaling a possible code swap.
  for (const directory of directories) {
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe backup directory');
    assert.equal(fs.realpathSync(directory), directory, 'aliased backup directory');
    const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
function assertStableFlags(before, after) { assert.deepEqual(after.flags, before.flags, 'production validation flags changed during maintenance'); }
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function unitStates() { return Object.fromEntries(UNITS.map(name => [name, Object.fromEntries(run('/usr/bin/systemctl',
  ['show', name, '--property=LoadState,ActiveState,MainPID,InvocationID,ExecMainStartTimestamp', '--no-pager']).trim().split('\n').map(line => line.split('=')))])); }
function assertDrained(states) { for (const [name, state] of Object.entries(states)) if (state.LoadState !== 'not-found') {
  assert.ok(['inactive', 'failed'].includes(state.ActiveState), 'writer active: ' + name);
  assert.ok(name.endsWith('.timer') ? !state.MainPID || state.MainPID === '0' : state.MainPID === '0', 'writer PID active: ' + name);
} }
function stopUnits(states) { for (const [name, state] of Object.entries(states)) if (state.LoadState !== 'not-found') run('/usr/bin/systemctl', ['stop', name], { timeout: 120000 }); assertDrained(unitStates()); }
function restoreUnits(states) { for (const [name, state] of Object.entries(states).reverse()) if (state.ActiveState === 'active') run('/usr/bin/systemctl', ['start', name], { timeout: 120000 });
  const after = unitStates(); for (const [name, state] of Object.entries(states)) if (state.ActiveState === 'active') assert.equal(after[name].ActiveState, 'active', 'service not restored: ' + name); }
function topology() { return JSON.parse(run('/usr/sbin/runuser', ['-u', 'postgres', '--', '/usr/bin/psql', '-X', '-q', '-t', '-A', '--set=ON_ERROR_STOP=1', '--dbname=football', '-c',
  "BEGIN READ ONLY; SELECT json_build_object('database',current_database(),'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system())); ROLLBACK;"], { timeout: 10000 })); }
async function frozen(context, identity) {
  const store = require(APP + '/server/dataGenerationStore.cjs'), stream = require(APP + '/server/streamedJsonObjectArrays.cjs').streamJsonObjectArrays;
  const entry = context.manifest.files.find(row => row.path === 'prediction-snapshots.json'); assert.ok(entry);
  const records = { recommendations: [], publicDecisions: [], publicEvidence: [], archives: [] };
  const ids = { publicDecisions: new Set(), publicEvidence: new Set() };
  stream(path.join(context.generationDir, entry.path), { keys: ['publicReferenceDecisions', 'publicReferenceEvidence'], allowNonArrays: true,
    expectedBytes: entry.bytes, expectedSha256: entry.sha256, onItem: (key, row) => {
      const field = key === 'publicReferenceDecisions' ? 'publicDecisions' : 'publicEvidence';
      const id = field === 'publicDecisions' ? row.contentHash : row.referenceHash;
      assert.ok(typeof id === 'string' && id && !ids[field].has(id)); ids[field].add(id);
      records[field].push({ id, hash: objectHash(row) }); assert.ok(records[field].length <= 100000);
    } });
  const archives = new Map();
  for (const file of ['matches-current.json', 'matches-history.json']) {
    const data = store.readGenerationFile(context, file, { parseJson: true });
    for (const row of Array.isArray(data) ? data : data.matches || []) if (row.archivedPreMatchPrediction) {
      const id = JSON.stringify([row.sourceMatchId, row.eventVersion || null, row.kickoffTime]), hash = objectHash(row.archivedPreMatchPrediction);
      assert.ok(!archives.has(id) || archives.get(id) === hash); archives.set(id, hash);
    }
  }
  records.archives = [...archives].map(([id, hash]) => ({ id, hash }));
  const { NativeReleasePostgresPool } = require(APP + '/scripts/nativeReleasePostgresTransport.cjs');
  const pool = new NativeReleasePostgresPool({ database: identity.database, databaseOid: identity.oid, clusterId: identity.systemIdentifier }); let client;
  try { client = await pool.connect(); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const publication = await require(APP + '/scripts/nativeReleaseDatabaseSession.cjs').publication(client);
    const rows = (await client.query('SELECT decision_id,to_jsonb(f)::text AS record FROM football.frozen_recommendations f ORDER BY decision_id COLLATE "C"')).rows;
    assert.ok(rows.length > 0 && rows.length <= 100000);
    const hashRow = require(APP + '/scripts/nativeReleaseDataPlane.cjs').protectedFrozenRecommendationHash;
    records.recommendations = rows.map(row => ({ id: row.decision_id, hash: hashRow(row.record) }));
    // Capture the served PostgreSQL archive in the same snapshot as its publication
    // and frozen ledger, in addition to immutable generation objects.
    const archiveRows = (await client.query("SELECT payload->'sourceMatchId' AS source_id,payload->>'eventVersion' AS event_version,payload->>'kickoffTime' AS kickoff,payload->'archivedPreMatchPrediction' AS archive FROM football.match_snapshots WHERE payload->'archivedPreMatchPrediction' IS NOT NULL AND (payload->'archivedPreMatchPrediction')::text<>'null' LIMIT 100001")).rows;
    assert.ok(archiveRows.length <= 100000);
    const pgArchiveIds = new Map();
    for (const row of archiveRows) { const id = 'postgres:' + JSON.stringify([row.source_id, row.event_version || null, row.kickoff]);
      const hash = objectHash(row.archive); assert.ok(!pgArchiveIds.has(id) || pgArchiveIds.get(id) === hash, 'conflicting PostgreSQL frozen archive');
      pgArchiveIds.set(id, hash); }
    records.archives.push(...[...pgArchiveIds].map(([id, hash]) => ({ id, hash })));
    const api = require(APP + '/server/publicReferenceArchive.cjs');
    const indexRow = (await client.query('SELECT payload::text AS payload FROM football.source_snapshots WHERE id=$1', [api.INDEX_ID])).rows[0];
    assert.ok(indexRow && Buffer.byteLength(indexRow.payload) <= api.MAX_AUDIT_BYTES, 'PostgreSQL reference index unavailable');
    const index = JSON.parse(indexRow.payload), pgDecisions = [], pgEvidence = [];
    for (const row of records.publicDecisions) {
      const shardRow = (await client.query('SELECT payload::text AS payload FROM football.source_snapshots WHERE id=$1', [api.indexRowId(row.id)])).rows[0];
      assert.ok(shardRow && Buffer.byteLength(shardRow.payload) <= api.MAX_AUDIT_BYTES, 'PostgreSQL reference shard unavailable');
      const shard = JSON.parse(shardRow.payload), proof = api.resolveIndexedPublicReferenceEvidence(index, shard, row.id);
      assert.equal(objectHash(shard.record), row.hash, 'served reference decision differs from immutable generation');
      pgDecisions.push({ id: 'postgres:' + row.id, hash: objectHash(shard.record) });
      if (shard.record.evidenceBinding) { assert.equal(proof.ok, true); const expected = records.publicEvidence.find(item => item.id === row.id);
        assert.ok(expected); assert.equal(objectHash(shard.entry), expected.hash, 'served reference evidence differs from immutable generation');
        pgEvidence.push({ id: 'postgres:' + row.id, hash: objectHash(shard.entry) });
      } else { assert.equal(proof.reason, 'evidence-not-recorded'); assert.equal(shard.entry, null); }
    }
    records.publicDecisions.push(...pgDecisions); records.publicEvidence.push(...pgEvidence);
    for (const list of Object.values(records)) list.sort((a, b) => a.id.localeCompare(b.id));
    return { records, publication };
  } finally { if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); } await pool.end(); }
}
function flags() {
  const text = bytes('/etc/football-predict/env').toString('utf8'), result = {};
  for (const key of ['WRITE_LEGACY_STATIC_PAYLOADS', 'MIRROR_PUBLISHED_DATA_TO_DIST', 'ALLOW_LARGE_STATIC_DIST']) {
    const matches = [...text.matchAll(new RegExp('^' + key + '=(.*)$', 'gm'))]; assert.ok(matches.length <= 1);
    result[key] = matches[0]?.[1].trim().replace(/^['"]|['"]$/g, '') ?? null;
    assert.ok([null, '0', '1'].includes(result[key]), 'unrecognized production validation flag');
  }
  // The proof supports the measured production static layout only; never change flags to make it pass.
  assert.equal(result.WRITE_LEGACY_STATIC_PAYLOADS, '0'); assert.equal(result.MIRROR_PUBLISHED_DATA_TO_DIST, '0'); return result;
}
function helper(raw) { const module = new Module(APP + '/scripts/officialClosedScheduleEvidence.cjs'); module.filename = module.id; module.paths = Module._nodeModulePaths(APP + '/scripts'); module._compile(raw.toString('utf8'), module.filename); return module.exports; }
function closure(raw, now = new Date().toISOString()) {
  const relayRaw = bytes(RELAY, 20 * 1024 ** 2), registryRaw = bytes(REGISTRY, 262144), snapshot = JSON.parse(relayRaw);
  const audit = helper(raw).auditOfficialClosedSchedule(snapshot, { asOf: now, trustRegistry: JSON.parse(registryRaw) });
  return { relay: { path: RELAY, bytes: relayRaw.length, sha256: policy.hash(relayRaw), capturedAt: snapshot.capturedAt, sourceCycleId: snapshot.sourceCycleId,
    emptyCurrentIntegrityEligible: audit.emptyCurrentIntegrityEligible, proofHash: objectHash(audit) },
    registry: { path: REGISTRY, bytes: registryRaw.length, sha256: policy.hash(registryRaw) }, audit };
}
function fault() {
  const info = require(APP + '/scripts/releaseWorkerPreflight.cjs').collectWorkerPreflight(), status = info.status;
  assert.equal(info.processMatches, true); assert.equal(info.serviceAfter.ActiveState, 'active'); assert.equal(status.pid, Number(info.serviceAfter.MainPID));
  assert.equal(status.lastCycle?.ok, false); assert.equal(status.lastCycle?.phase, 'official-result-failed');
  assert.equal(status.lastCycle.error, 'npm run validate:data exited with 1');
  const invocationId = run('/usr/bin/systemctl', ['show', 'football-sync-worker.service', '--property=InvocationID', '--value']).trim();
  const lines = run('/usr/bin/journalctl', ['-u', 'football-sync-worker.service', '--since', status.lastCycle.startedAt,
    '--until', status.lastCycle.finishedAt, '-n', '3000', '-o', 'json', '--no-pager']).trim().split('\n').filter(Boolean).map(JSON.parse);
  const assertion = 'matches-current.json must contain a non-empty array.';
  const entries = lines.filter(row => row._SYSTEMD_INVOCATION_ID === invocationId && row._SYSTEMD_UNIT === 'football-sync-worker.service'
    && String(row.MESSAGE).includes(assertion)).map(row => ({ pid: Number(row._PID), at: new Date(Number(row.__REALTIME_TIMESTAMP) / 1000).toISOString(), messageSha256: policy.hash(String(row.MESSAGE)) }));
  assert.ok(entries.length > 0, 'empty-list failure not bound to current worker invocation');
  return { pid: status.pid, invocationId, statusCheckedAt: status.checkedAt, lastCycleStartedAt: status.lastCycle.startedAt,
    lastCycleFinishedAt: status.lastCycle.finishedAt, phase: status.lastCycle.phase, error: status.lastCycle.error, assertion, journalEntries: entries };
}
function signedBaseline(installedFiles, dependencies, codeAppliedPlan = null) {
  const directory = '/var/lib/football-release/source-baselines/' + policy.BASE_RUNTIME;
  const manifestBytes = bytes(directory + '/manifest.json', 1024 * 1024);
  const key = crypto.createPublicKey(bytes('/etc/football-release/signing-public.pem', 16384));
  assert.equal(key.asymmetricKeyType, 'rsa'); assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072);
  const signature = bytes(directory + '/manifest.sig', 16384);
  assert.ok(crypto.verify('sha256', manifestBytes, key, signature), 'retained source baseline signature invalid');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.ok, true); assert.equal(manifest.manifestVersion, 3); assert.equal(manifest.site, 'football-predict');
  assert.equal(manifest.channel, 'production'); assert.equal(manifest.releaseSequence, 785); assert.equal(manifest.sha256, policy.BASE_RUNTIME);
  const archive = bytes(directory + '/original.tgz', 512 * 1024 ** 2);
  assert.equal(archive.length, manifest.bytes); assert.equal(policy.hash(archive), policy.BASE_RUNTIME, 'retained archive differs from signed runtime');
  assert.equal(manifest.archiveSourceEvidence?.archiveSha256, policy.BASE_RUNTIME);
  const entries = manifest.archiveSourceEvidence.inventory?.entries; assert.ok(Array.isArray(entries));
  const selected = [];
  for (const file of [...installedFiles, ...dependencies]) {
    const found = entries.filter(entry => entry.path === file.path);
    if (file.path === 'scripts/officialClosedScheduleEvidence.cjs') {
      assert.equal(found.length, 0, 'new helper unexpectedly exists in signed r785 inventory');
      assert.equal(file.sha256, codeAppliedPlan ? codeAppliedPlan.files.find(row => row.path === file.path).sha256 : null);
      selected.push({ path: file.path, sha256: null }); continue;
    }
    assert.equal(found.length, 1, 'signed baseline inventory missing or ambiguous: ' + file.path); assert.equal(found[0].kind, 'file');
    assert.match(found[0].sha256, /^[a-f0-9]{64}$/);
    const patch = codeAppliedPlan?.files.find(row => row.path === file.path);
    if (patch) assert.equal(patch.beforeSha256, found[0].sha256, 'signed before bytes disagree with r785 inventory');
    assert.equal(file.sha256, patch?.sha256 || found[0].sha256, 'installed source differs from authenticated baseline: ' + file.path);
    selected.push({ path: file.path, sha256: found[0].sha256 });
  }
  return { directory, manifestSha256: policy.hash(manifestBytes), signatureSha256: policy.hash(signature),
    archiveSha256: policy.BASE_RUNTIME, archiveBytes: archive.length, releaseSequence: 785, signatureVerified: true,
    historicalExpiryIgnoredForBaselineAuthenticationOnly: true, selected };
}
async function observe(helperRaw, { requireFault = true, codeAppliedPlan = null } = {}) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const runtime = bytes(APP + '/.release-bundle-sha256').toString().trim(), complete = bytes(APP + '/.release-live-complete').toString().trim();
  assert.equal(runtime, policy.BASE_RUNTIME); assert.equal(complete, runtime);
  for (const file of ['/var/lib/football-release/recovery/current', '/var/lib/football-release/reference-repairs/current']) assert.equal(exists(file), false, 'another repair pending');
  const state = read('/var/lib/football-release/frontend-state.json'), store = require(APP + '/server/dataGenerationStore.cjs');
  const context = store.resolveCurrentGeneration({ storeDir: STORE }), identity = topology(), captured = await frozen(context, identity);
  assert.deepEqual(store.resolveCurrentGeneration({ storeDir: STORE }).pointer, context.pointer, 'publication moved during inspection');
  const closed = closure(helperRaw), currentRaw = bytes(APP + '/public/data/matches-current.json');
  assert.deepEqual(JSON.parse(currentRaw), [], 'incident requires an explicit empty current array');
  const files = policy.FILES.map(file => ({ path: file, sha256: exists(APP + '/' + file) ? digest(APP + '/' + file) : null }));
  const dependencies = policy.DEPENDENCIES.map(file => ({ path: file, sha256: digest(APP + '/' + file) }));
  const baseline = signedBaseline(files, dependencies, codeAppliedPlan);
  return { checkedAt: new Date().toISOString(), productionWrites: 0, runtime, complete, frontendStateSha256: digest('/var/lib/football-release/frontend-state.json'),
    frontendSequence: state.frontendSequence, frontendSha256: state.frontendSha256, generation: context.pointer,
    postgres: { ...identity, publication: captured.publication }, files, dependencies, signedBaseline: baseline,
    frozenRecords: captured.records, relay: closed.relay, registry: closed.registry, closureAudit: closed.audit,
    entrypoint: { path: ENTRY, sha256: digest(ENTRY), base64: bytes(ENTRY).toString('base64') }, flags: flags(),
    workerFault: requireFault ? fault() : null };
}
function assertSameInput(before, after, { codeApplied = false, plan = null } = {}) {
  for (const key of ['runtime', 'complete', 'frontendStateSha256', 'frontendSequence', 'frontendSha256', 'generation', 'postgres', 'dependencies', 'signedBaseline', 'frozenRecords', 'flags']) assert.deepEqual(after[key], before[key], 'maintenance input changed: ' + key);
  if (!codeApplied) assert.deepEqual(after.files, before.files, 'code changed');
  else assert.deepEqual(after.files, plan.files.map(file => ({ path: file.path, sha256: file.sha256 })), 'patched code changed');
  assert.equal(after.registry.sha256, before.registry.sha256, 'trust registry changed');
  assert.equal(after.relay.sha256, before.relay.sha256, 'signed source snapshot changed; collect a new observation');
}
function load(dir, fresh = true) {
  assert.equal(process.getuid(), 0); assert.equal(fs.realpathSync(dir), dir); assert.equal(path.dirname(dir), ROOT); assert.match(path.basename(dir), /^[a-f0-9]{64}$/);
  const stat = fs.statSync(dir); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, 0o700);
  const raw = bytes(dir + '/capsule.json', 8 * 1024 ** 2); assert.equal(policy.hash(raw), path.basename(dir));
  const plan = policy.verify(raw, bytes(dir + '/capsule.sig'), bytes('/etc/football-release/signing-public.pem'), fresh ? Date.now() : Date.parse(JSON.parse(raw).createdAt));
  for (const [key, name] of [['controller', 'controller.cjs'], ['policy', 'officialClosureRepairPolicy.cjs'], ['proof', 'proof.cjs']]) assert.equal(digest(dir + '/' + name), plan.artifacts[key].sha256);
  return plan;
}
const candidateHelper = plan => Buffer.from(plan.files.find(file => file.path === 'scripts/officialClosedScheduleEvidence.cjs').base64, 'base64');
function ensureNoCurrent() { assert.equal(exists(ROOT + '/current'), false, 'prior closure repair unresolved'); }
function releaseWindow() { const api = require(APP + '/scripts/runReleaseWindowPreflight.cjs'), report = api.evaluateReleaseWindowObservation(api.collectReleaseWindowObservation(), Date.now(), { stage: 'before-upload', nativeFullRelease: true }); assert.equal(report.ok, true, 'maintenance window unavailable'); return report; }
function copyProofFile(candidate, relative, required = true) {
  const source = APP + '/' + relative; if (!fs.existsSync(source)) { assert.equal(required, false, 'proof input missing: ' + relative); return; }
  const raw = bytes(source, 128 * 1024 ** 2), target = candidate + '/' + relative; fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); writeOnce(target, raw);
}
async function prepare(dir, plan) {
  ensureNoCurrent(); const observed = await observe(candidateHelper(plan)); policy.validateObservation(observed); assertSameInput(plan.observation, observed); releaseWindow();
  assert.equal(fs.existsSync(dir + '/prepare-started.json'), false, 'prepare cannot replay');
  writeOnce(dir + '/prepare-started.json', { checkedAt: new Date().toISOString(), productionWrites: 0 });
  const candidate = dir + '/candidate'; fs.mkdirSync(candidate, { mode: 0o700 });
  for (const file of PROOF_CODE) if (file !== 'scripts/officialClosedScheduleEvidence.cjs') copyProofFile(candidate, file);
  writeOnce(candidate + '/scripts/validateData.baseline.cjs', bytes(APP + '/scripts/validateData.cjs'));
  for (const file of plan.files) { const target = candidate + '/' + file.path; fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, Buffer.from(file.base64, 'base64'), { mode: 0o600 }); assert.equal(digest(target), file.sha256); run(NODE, ['--check', target]); }
  for (const [name, relative] of [['proof', 'scripts/proveOfficialClosureRepair.cjs'], ['policy', 'scripts/officialClosureRepairPolicy.cjs']]) {
    writeOnce(candidate + '/' + relative, Buffer.from(plan.artifacts[name].base64, 'base64'));
    assert.equal(digest(candidate + '/' + relative), plan.artifacts[name].sha256);
  }
  for (const file of ['public/data/matches-current.json', 'public/data/matches-history.json', 'public/data/sync-meta.json', 'public/data/odds-history.json']) copyProofFile(candidate, file);
  fs.mkdirSync(candidate + '/server-data', { mode: 0o700 });
  if (fs.existsSync(STORE + '/matches-unresolved-archive.json')) writeOnce(candidate + '/server-data/matches-unresolved-archive.json', bytes(STORE + '/matches-unresolved-archive.json', 128 * 1024 ** 2));
  // Flags require no static mirrors. Copy only small actual dist entries to enforce their absence policy.
  if (fs.existsSync(APP + '/dist/data')) { fs.mkdirSync(candidate + '/dist/data', { recursive: true, mode: 0o700 }); for (const name of fs.readdirSync(APP + '/dist/data')) copyProofFile(candidate, 'dist/data/' + name); }
  fs.mkdirSync(candidate + '/proof-input', { mode: 0o700 }); writeOnce(candidate + '/proof-input/relay.json', bytes(RELAY, 20 * 1024 ** 2)); writeOnce(candidate + '/proof-input/registry.json', bytes(REGISTRY, 262144));
  const input = { version: 'official-closure-repair-proof-input-v1', capsuleSha256: path.basename(dir), candidate,
    relayPath: candidate + '/proof-input/relay.json', trustRegistryPath: candidate + '/proof-input/registry.json',
    baselineValidatorPath: candidate + '/scripts/validateData.baseline.cjs', flags: observed.flags, storeDir: candidate + '/server-data' };
  writeOnce(candidate + '/proof-input/request.json', input);
  run('/usr/bin/systemd-run', ['--quiet', '--wait', '--pipe', '--collect', '--unit=football-closure-proof-' + path.basename(dir).slice(0, 12),
    '-p', 'PrivateNetwork=yes', '-p', 'ProtectSystem=strict', '-p', 'ReadWritePaths=' + candidate,
    '-p', 'PrivateTmp=yes', '-p', 'NoNewPrivileges=yes', '-p', 'MemoryMax=1536M', '-p', 'RuntimeMaxSec=240',
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'TZ=UTC', NODE, candidate + '/scripts/proveOfficialClosureRepair.cjs',
    '--input', candidate + '/proof-input/request.json', '--output', candidate + '/repair-proof.json'], { timeout: 260000 });
  const proof = read(candidate + '/repair-proof.json'); assertProof(proof, dir, plan);
  assertSameInput(plan.observation, await observe(candidateHelper(plan)));
  const prepared = { ok: true, checkedAt: new Date().toISOString(), capsuleSha256: path.basename(dir), proofSha256: digest(candidate + '/repair-proof.json'), productionWrites: 0 };
  writeOnce(dir + '/prepared.json', prepared); return prepared;
}
function rollbackPlan(files, states) {
  return files.map(file => { const current = states[file.path]; assert.ok([file.beforeSha256, file.sha256].includes(current), 'refuse rollback over unrelated code: ' + file.path);
    return { path: file.path, action: current === file.beforeSha256 ? 'unchanged' : file.beforeSha256 === null ? 'quarantine' : 'restore', expected: file.beforeSha256 }; });
}
function assertProof(proof, dir, plan) {
  assert.equal(proof.version, 'official-closure-repair-proof-v1'); assert.equal(proof.ok, true); assert.equal(proof.capsuleSha256, path.basename(dir));
  for (const field of ['actualClockOnly', 'dataIntegrityPreserved', 'baselineRejected']) assert.equal(proof[field], true, 'incomplete candidate proof: ' + field);
  for (const field of ['productionWrites', 'postgresWrites', 'generationPublished', 'marketDataPromoted', 'recommendationsPromoted', 'sourceHealthPromoted']) assert.equal(proof[field], false, 'proof exceeded isolated scope: ' + field);
  assert.equal(proof.networkRequests, 0);
  assert.equal(proof.relay.sha256, plan.observation.relay.sha256); assert.equal(proof.registry.sha256, plan.observation.registry.sha256);
  assert.equal(proof.baselineValidator.sha256, plan.files.find(file => file.path === 'scripts/validateData.cjs').beforeSha256);
  assert.equal(proof.candidateValidator.sha256, plan.files.find(file => file.path === 'scripts/validateData.cjs').sha256);
  assert.deepEqual(proof.positive.map(row => [row.scope, row.expectedPass, row.passed, row.exitCode]), [['server-complete', true, true, 0], ['public-distribution', true, true, 0]]);
  assert.deepEqual(proof.negative.map(row => row.name).sort(), ['expired-envelope-with-unchanged-signed-payloads', 'missing-current-file', 'tampered-collector-signature'].sort());
  for (const row of proof.negative) assert.deepEqual(row.validators.map(result => [result.scope, result.expectedPass, result.passed, result.exitCode]), [['server-complete', false, true, 1], ['public-distribution', false, true, 1]]);
  assert.equal(proof.finalClosureAudit.emptyCurrentIntegrityEligible, true);
}
function clearCurrent(dir, terminal) { if (!exists(ROOT + '/current')) return; assert.equal(read(ROOT + '/current').capsuleSha256, path.basename(dir)); renameDurable(ROOT + '/current', dir + '/' + terminal + '-current.json'); }
async function recover(dir, plan) {
  if (exists(ROOT + '/current')) assert.equal(read(ROOT + '/current').capsuleSha256, path.basename(dir), 'another maintenance transaction owns recovery');
  if (fs.existsSync(dir + '/accepted.json') || fs.existsSync(dir + '/recovered.json')) { clearCurrent(dir, 'terminal'); return { recoveryRequired: false }; }
  if (!fs.existsSync(dir + '/activation-started.json')) { clearCurrent(dir, 'no-activation'); return { recoveryRequired: false }; }
  const started = read(dir + '/activation-started.json'); assert.equal(digest(ENTRY), plan.entrypointGuard.sha256, 'entrypoint recovery interlock drifted'); stopUnits(started.units);
  if (fs.existsSync(dir + '/code-swap-started.json')) {
    const actions = rollbackPlan(plan.files, Object.fromEntries(plan.files.map(file => [file.path, fs.existsSync(APP + '/' + file.path) ? digest(APP + '/' + file.path) : null])));
    for (const action of actions) if (action.action === 'restore') { const source = dir + '/backup/' + action.path; assert.equal(digest(source), action.expected); replace(APP + '/' + action.path, bytes(source), fs.statSync(source)); }
    else if (action.action === 'quarantine') renameDurable(APP + '/' + action.path, dir + '/rolled-back-' + path.basename(action.path));
    for (const file of plan.files) assert.equal(exists(APP + '/' + file.path) ? digest(APP + '/' + file.path) : null, file.beforeSha256, 'code recovery verification failed');
    if (exists(APP + '/.official-closure-repair.json')) { assert.equal(read(APP + '/.official-closure-repair.json').capsuleSha256, path.basename(dir)); renameDurable(APP + '/.official-closure-repair.json', dir + '/rolled-back-marker.json'); }
  }
  let continuity = null;
  if (exists(dir + '/protected-before.json')) {
    const before = read(dir + '/protected-before.json'), store = require(APP + '/server/dataGenerationStore.cjs'), identity = topology();
    for (const key of ['database', 'oid', 'systemIdentifier']) assert.equal(identity[key], before.postgres[key], 'database identity changed during recovery');
    const current = await frozen(store.resolveCurrentGeneration({ storeDir: STORE }), identity);
    continuity = policy.compareFrozen(before.frozenRecords, current.records);
  }
  restoreUnits(started.units);
  assert.equal(digest(ENTRY), plan.entrypointGuard.sha256, 'entrypoint recovery interlock drifted');
  const report = { checkedAt: new Date().toISOString(), codeRestored: true, dataRestored: false, continuity, servicesRestored: true, entrypointGuardPreserved: true };
  writeOnce(dir + '/recovered.json', report); clearCurrent(dir, 'recovered'); return report;
}
async function activate(dir, plan) {
  ensureNoCurrent(); assert.equal(fs.existsSync(dir + '/activation-started.json'), false, 'activation cannot replay');
  const prepared = read(dir + '/prepared.json'); assert.equal(prepared.ok, true); assert.equal(prepared.proofSha256, digest(dir + '/candidate/repair-proof.json'));
  assertProof(read(dir + '/candidate/repair-proof.json'), dir, plan);
  const before = await observe(candidateHelper(plan)); policy.validateObservation(before); assertSameInput(plan.observation, before); releaseWindow();
  assert.equal(digest(ENTRY), plan.entrypointGuard.beforeSha256); run('/usr/bin/bash', ['-n'], { input: Buffer.from(plan.entrypointGuard.base64, 'base64') });
  const units = unitStates(); for (const state of Object.values(units)) assert.ok(state.LoadState === 'not-found' || ['active', 'inactive', 'failed'].includes(state.ActiveState));
  assert.equal(units['football-sync-worker.service'].ActiveState, 'active'); assert.equal(units['football-predict.service'].ActiveState, 'active');
  writeOnce(dir + '/entrypoint-before', bytes(ENTRY)); replace(ENTRY, Buffer.from(plan.entrypointGuard.base64, 'base64'), regular(ENTRY)); assert.equal(digest(ENTRY), plan.entrypointGuard.sha256);
  writeOnce(ROOT + '/current', { capsuleSha256: path.basename(dir), directory: dir });
  writeOnce(dir + '/activation-started.json', { checkedAt: new Date().toISOString(), units });
  try {
    stopUnits(units); const paused = await observe(candidateHelper(plan), { requireFault: false }); assertSameInput(plan.observation, paused);
    assert.equal(closure(candidateHelper(plan)).audit.emptyCurrentIntegrityEligible, true, 'fresh official closure proof unavailable before swap');
    for (const file of plan.files) if (file.beforeSha256 !== null) { const source = APP + '/' + file.path, target = dir + '/backup/' + file.path; fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeOnce(target, bytes(source)); const stat = regular(source); fs.chownSync(target, stat.uid, stat.gid); fs.chmodSync(target, stat.mode & 0o777);
      const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } assert.equal(digest(target), file.beforeSha256); }
    syncBackupDirectories(dir, plan.files);
    writeOnce(dir + '/protected-before.json', { generation: paused.generation, postgres: paused.postgres, frozenRecords: paused.frozenRecords });
    writeOnce(dir + '/code-swap-started.json', { checkedAt: new Date().toISOString() });
    for (const file of plan.files) { const target = APP + '/' + file.path, stat = file.beforeSha256 === null ? regular(APP + '/scripts/validateData.cjs') : regular(target);
      replace(target, Buffer.from(file.base64, 'base64'), stat); assert.equal(digest(target), file.sha256); }
    writeOnce(APP + '/.official-closure-repair.json', { version: policy.VERSION, phase: 'awaiting-publication', capsuleSha256: path.basename(dir), baseRuntimeSha256: policy.BASE_RUNTIME, fullReleaseDeployed: false });
    const startedAt = new Date().toISOString(); writeOnce(dir + '/activated.json', { checkedAt: startedAt });
    // Keep unrelated publishers paused while this one normal worker proves its own publication.
    for (const unit of ['football-predict.service', 'football-sync-worker.service']) run('/usr/bin/systemctl', ['start', unit]);
    let official = null; const deadline = Date.now() + 12 * 60000;
    while (Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5000)); const status = read(STORE + '/sync-worker-status.json'), service = unitStates()['football-sync-worker.service'];
      if (status.lastCycle?.ok === false && status.lastCycle.phase === 'official-result-failed' && Date.parse(status.lastCycle.startedAt) >= Date.parse(startedAt)) throw Error('repaired official cycle failed');
      if (policy.assessOfficial(status, service, startedAt, before.workerFault.pid)) { official = { status, service, observedAt: new Date().toISOString() }; break; }
    }
    assert.ok(official, 'new official publication not proven'); writeOnce(dir + '/official-publication.json', official); stopUnits(units);
    // Acceptance reads the newly published generation and database; it never patches them.
    const after = await observe(candidateHelper(plan), { requireFault: false, codeAppliedPlan: plan }); const continuity = policy.compareFrozen(before.frozenRecords, after.frozenRecords);
    for (const key of ['oid', 'systemIdentifier', 'database']) assert.equal(after.postgres[key], before.postgres[key]);
    for (const key of ['generationId', 'manifestHash', 'sourceCycleId', 'committedAt']) assert.equal(after.postgres.publication[key], after.generation[key], 'PostgreSQL publication mismatch');
    assert.notEqual(after.generation.generationId, before.generation.generationId); assert.equal(after.frontendStateSha256, before.frontendStateSha256);
    assertStableFlags(before, after);
    assert.deepEqual(after.dependencies, before.dependencies); assert.equal(after.registry.sha256, before.registry.sha256);
    assert.equal(digest(ENTRY), plan.entrypointGuard.sha256);
    for (const file of plan.files) assert.equal(digest(APP + '/' + file.path), file.sha256);
    const store = require(APP + '/server/dataGenerationStore.cjs'), context = store.resolveCurrentGeneration({ storeDir: STORE });
    const sync = store.readGenerationFile(context, 'sync-meta.json', { parseJson: true }), current = store.readGenerationFile(context, 'matches-current.json', { parseJson: true });
    assert.deepEqual(current, []); const published = helper(candidateHelper(plan)).auditPublishedOfficialClosedSchedule(sync, { trustRegistryPath: REGISTRY, asOf: new Date().toISOString() });
    assert.equal(published.emptyCurrentIntegrityEligible, true); restoreUnits(units);
    const health = JSON.parse(run('/usr/bin/curl', ['-fsS', '--max-time', '15', 'https://134.175.132.183/api/v1/health']));
    for (const key of ['serviceOk', 'fastResultIntegrityOk', 'recommendationProjectionParityOk']) assert.equal(health.status[key], true);
    assert.equal(health.status.recommendationReliable, false); assert.equal((health.data?.currentRead || health.currentRead)?.source, 'postgres');
    assert.equal(health.storage?.sqlite?.available, false); assert.equal(health.storage?.postgres?.available, true);
    assert.notEqual(health.storage.postgres.baseReady, false); assert.ok(!health.storage.postgres.baseBlockedReason);
    const accepted = { ok: true, checkedAt: new Date().toISOString(), capsuleSha256: path.basename(dir), baseRuntimeSha256: policy.BASE_RUNTIME,
      continuity, generation: after.generation, postgres: after.postgres, published, health: health.status, fullReleaseDeployed: false, modelPromotion: false, dataRewrittenByRepair: false };
    replace(APP + '/.official-closure-repair.json', Buffer.from(JSON.stringify({ ...accepted, phase: 'accepted' }) + '\n'), regular(APP + '/.official-closure-repair.json'));
    writeOnce(dir + '/accepted.json', accepted); clearCurrent(dir, 'accepted'); return accepted;
  } catch (error) { if (!fs.existsSync(dir + '/failed.json')) writeOnce(dir + '/failed.json', { checkedAt: new Date().toISOString(), error: error.message }); await recover(dir, plan); throw error; }
}
async function supervise(dir) {
  const plan = load(dir), child = cp.spawn(NODE, [__filename, 'activate', dir], { detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'inherit', 'inherit'] });
  let interrupted = false; const signal = kind => { if (Number.isSafeInteger(child.pid)) try { process.kill(-child.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const stop = () => { interrupted = true; signal('SIGTERM'); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try { const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    if (interrupted || result.code !== 0) { signal('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 1000)); signal('SIGKILL'); await recover(dir, plan); throw Error('maintenance interrupted; recovery completed under publisher lock'); }
    return read(dir + '/accepted.json');
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
async function main() { const [mode, dir] = process.argv.slice(2); assert.ok(['prepare', 'activate', 'supervise', 'recover', 'status'].includes(mode));
  if (mode === 'supervise') return supervise(dir); const plan = load(dir, ['prepare', 'activate'].includes(mode));
  if (mode === 'prepare') return prepare(dir, plan); if (mode === 'activate') return activate(dir, plan); if (mode === 'recover') return recover(dir, plan);
  return { directory: dir, states: Object.fromEntries(['prepared', 'activation-started', 'activated', 'official-publication', 'accepted', 'failed', 'recovered'].filter(name => fs.existsSync(dir + '/' + name + '.json')).map(name => [name, read(dir + '/' + name + '.json')])) };
}
module.exports = { observe, assertSameInput, assertProof, load, prepare, activate, recover, rollbackPlan, assertDrained, assertStableFlags, syncBackupDirectories, closure, unitStates, frozen, helper, signedBaseline, ROOT, NODE, LOCK };
if (require.main === module) main().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
