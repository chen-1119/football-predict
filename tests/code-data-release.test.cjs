'use strict';
const { test } = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const policy = require('../scripts/releaseDataPlanePolicy.cjs');
const { planCapacity } = require('../scripts/nativeReleaseCapacity.cjs');
const { validate } = require('../scripts/runReleaseCapacityPreflight.cjs');
const root = path.resolve(__dirname, '..');
for (const mode of ['exact', 'identity', 'tamper', 'oversize']) test('code lease uses PG-bound immutable current: ' + mode, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-generation-'));
  try {
    const rows = [{ id: 'fixture', kickoffTime: '2030-01-01T20:00:00+08:00', buyEndTime: '2030-01-01 19:30:00' }];
    const bytes = Buffer.from(JSON.stringify(rows)), file = path.join(dir, 'matches-current.json'); fs.writeFileSync(file, bytes);
    const identity = { mode: 'active-generation', generationId: 'g-fixture', manifestHash: 'a'.repeat(64), sourceCycleId: 'fixture-cycle' };
    const manifest = { ...identity, files: [{ path: 'matches-current.json', bytes: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') }] };
    const session = { identity, publication: { context: { generationDir: dir, manifest } }, publicDataDir: '/must-not-read-mutable-projection' };
    if (mode === 'identity') manifest.generationId = 'other-generation';
    if (mode === 'tamper') fs.writeFileSync(file, Buffer.from(bytes.toString().replace('19:30', '19:31')));
    if (mode === 'oversize') manifest.files[0].bytes = 32 * 1024 * 1024 + 1;
    const read = () => require('../scripts/nativeCodeReleaseDataPlane.cjs').leaseCurrent(session);
    if (mode === 'exact') {
      const current = read(); a.deepEqual(current, rows);
      const t = require('../scripts/releaseTransitionLease.cjs');
      const lease = t.createTransitionLease(current, { refreshAt:'2030-01-01T00:00:00Z', verifierRuntimeMaxSeconds:300, preverifyRefreshBudgetSeconds:570, atomicSwapMarginSeconds:30 });
      a.equal(t.verifyTransitionLease(current, lease, { verifiedAt:'2030-01-01T00:01:00Z' }).ok, true);
      a.throws(() => t.verifyTransitionLease([{ ...rows[0], buyEndTime:'2030-01-01 19:00:00' }], lease, { verifiedAt:'2030-01-01T00:01:00Z' }), /data changed/);
    } else a.throws(read);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('lease captures committed generation before service stop and seed rejects identity drift', () => {
  const shell = fs.readFileSync(path.join(root, 'deploy/light-server/release-native.sh'), 'utf8');
  const begin = shell.indexOf('CODE_CUTOVER_STARTED_SECONDS=$SECONDS'), capture = shell.indexOf('lease-input "$BUNDLE_SHA256"', begin);
  const create = shell.indexOf('--current "$NATIVE_STATE_DIR/code-lease-current.json"', capture), stop = shell.indexOf('stop_worker_for_release_window', create);
  a(begin >= 0 && capture > begin && create > capture && stop > create);
  const source = fs.readFileSync(path.join(root, 'scripts/nativeCodeReleaseDataPlane.cjs'), 'utf8');
  a(source.includes('assertSamePublication(leaseInput.identity, session.identity)'));
});
function pauseFixture(run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'code-pause-')),modPath=require.resolve('../deploy/light-server/football-release-recovery.cjs');
  const saved=[process.env.FOOTBALL_RELEASE_RECOVERY_TEST_MODE,process.env.FOOTBALL_RELEASE_RECOVERY_TEST_ROOT];
  process.env.FOOTBALL_RELEASE_RECOVERY_TEST_MODE='1';process.env.FOOTBALL_RELEASE_RECOVERY_TEST_ROOT=dir;delete require.cache[modPath];
  try {
    const mod=require(modPath),currentDir=path.join(dir,'var/lib/football-release/recovery/current');fs.mkdirSync(currentDir,{recursive:true,mode:0o700});
    const transaction={currentDir,bundleSha:'a'.repeat(64),native:{}},files=[
      ['run/football-release-fast-watcher-pause.env','RELAY_FAST_WATCHER_ENABLED=0\n'],
      ['run/systemd/system/football-predict.service.d/90-release-fast-watcher-pause.conf','[Service]\nEnvironmentFile=\nEnvironmentFile=/etc/football-predict/env\nEnvironmentFile=/run/football-release-fast-watcher-pause.env\n']
    ].map(([p,body])=>({file:path.join(dir,p),body}));
    let reloads=0; const system={daemonReload(){reloads++;}};
    const install=()=>{for(const f of files){fs.mkdirSync(path.dirname(f.file),{recursive:true});fs.writeFileSync(f.file,f.body);}};
    return run({mod,transaction,files,install,system,reloads:()=>reloads});
  } finally {
    delete require.cache[modPath];for(const [i,key] of ['FOOTBALL_RELEASE_RECOVERY_TEST_MODE','FOOTBALL_RELEASE_RECOVERY_TEST_ROOT'].entries()){
      if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];
    }
    a.equal(fs.realpathSync(dir).toLowerCase(),path.resolve(dir).toLowerCase());a.ok(path.basename(dir).startsWith('code-pause-'));fs.rmSync(dir,{recursive:true});
  }
}
test('cold recovery cleans a durable owned pause after the writer process is gone',()=>pauseFixture(x=>{
  x.mod.recordWatcherPauseIntent(x.transaction,x.transaction.bundleSha);x.install();
  a.equal(x.mod.restoreOwnedWatcherPause(x.transaction,x.system),true);a.equal(x.reloads(),1);
  for(const f of x.files)a.equal(fs.existsSync(f.file),false);
  a.equal(x.mod.restoreOwnedWatcherPause(x.transaction,x.system),false);
}));
test('legacy recovery without ownership leaves existing pause untouched',()=>pauseFixture(x=>{
  x.install();a.equal(x.mod.restoreOwnedWatcherPause(x.transaction,x.system),false);for(const f of x.files)a.ok(fs.existsSync(f.file));
}));
test('pause intent refuses a pre-existing override',()=>pauseFixture(x=>{
  x.install();a.throws(()=>x.mod.recordWatcherPauseIntent(x.transaction,x.transaction.bundleSha),/existing override/);
}));
test('pause intent refuses another transaction and duplicate claim',()=>pauseFixture(x=>{
  a.throws(()=>x.mod.recordWatcherPauseIntent(x.transaction,'b'.repeat(64)),/current native/);
  x.mod.recordWatcherPauseIntent(x.transaction,x.transaction.bundleSha);a.throws(()=>x.mod.recordWatcherPauseIntent(x.transaction,x.transaction.bundleSha),/EEXIST/);
}));
test('changed override preserves both files before any deletion',()=>pauseFixture(x=>{
  x.mod.recordWatcherPauseIntent(x.transaction,x.transaction.bundleSha);x.install();fs.appendFileSync(x.files[1].file,'changed');
  a.throws(()=>x.mod.restoreOwnedWatcherPause(x.transaction,x.system),/changed/);for(const f of x.files)a.ok(fs.existsSync(f.file));a.equal(x.reloads(),0);
}));
test('partial completed pause install can recover after a crash',()=>pauseFixture(x=>{
  x.mod.recordWatcherPauseIntent(x.transaction,x.transaction.bundleSha);x.install();fs.unlinkSync(x.files[1].file);
  a.equal(x.mod.restoreOwnedWatcherPause(x.transaction,x.system),true);a.equal(fs.existsSync(x.files[0].file),false);
}));
test('recovery refuses a changed pause ownership identity',()=>pauseFixture(x=>{
  x.mod.recordWatcherPauseIntent(x.transaction,x.transaction.bundleSha);x.install();
  a.throws(()=>x.mod.restoreOwnedWatcherPause({...x.transaction,bundleSha:'b'.repeat(64)},x.system),/identity mismatch/);
}));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-release-'));
  for (const name of [...policy.FIXED, 'server/postgres/migrations/001_core.sql']) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), name + '\n');
  }
  return dir;
}
function pair(run) { const x = fixture(), y = fixture(); try { return run(x, y); } finally { fs.rmSync(x, { recursive: true }); fs.rmSync(y, { recursive: true }); } }
test('same storage contract selects code-only while a new HTTP module is allowed', () => pair((x, y) => {
  fs.writeFileSync(path.join(y, 'server/newRoute.cjs'), 'module.exports = {};');
  a.equal(policy.classify(policy.capture(x), policy.capture(y)).mode, 'code-only');
}));
for (const name of policy.FIXED) test('changed contract routes to migration: ' + name, () => pair((x, y) => {
  fs.appendFileSync(path.join(y, name), 'changed'); a.equal(policy.classify(policy.capture(x), policy.capture(y)).mode, 'database');
}));
test('adding migration routes to database lane', () => pair((x, y) => {
  fs.writeFileSync(path.join(y, 'server/postgres/migrations/002_new.sql'), 'CREATE TABLE x();');
  a.equal(policy.classify(policy.capture(x), policy.capture(y)).mode, 'database');
}));
test('editing an existing migration routes to database lane', () => pair((x, y) => {
  fs.appendFileSync(path.join(y, 'server/postgres/migrations/001_core.sql'), 'changed');
  a.equal(policy.classify(policy.capture(x), policy.capture(y)).mode, 'database');
}));
test('unknown migration-directory file is rejected', () => pair((x, y) => {
  fs.writeFileSync(path.join(y, 'server/postgres/migrations/hidden.js'), 'x'); a.throws(() => policy.capture(y));
}));
test('missing migration is rejected', () => pair((x, y) => {
  fs.unlinkSync(path.join(y, 'server/postgres/migrations/001_core.sql')); a.throws(() => policy.capture(y));
}));
test('contract hashes are insensitive only to CRLF serialization', () => pair((x, y) => {
  for (const name of policy.FIXED) fs.writeFileSync(path.join(y, name), name + '\r\n');
  a.equal(policy.classify(policy.capture(x), policy.capture(y)).mode, 'code-only');
}));
test('forged inventory and outside path are rejected', () => pair(x => {
  const p = policy.capture(x); p.entries[0].path = '../outside'; a.throws(() => policy.validate(p));
}));
function observation(db = 8e9, free = 100e9) { return { observedAt: new Date().toISOString(), databaseBytes: db,
  generationBytes: 1e9, applicationBytes: 2e9, volumes: Object.fromEntries(['postgres', 'native', 'application'].map(k => [k, { device: '1', availableBytes: free }])) }; }
test('code capacity is independent of database size and reserves no clone or dump', () => {
  const small = planCapacity(observation(), 'code-only'), large = planCapacity(observation(800e9), 'code-only');
  a.deepEqual(small, large); a.equal(small.demands.postgres, 0); a.equal(small.demands.native, 4e9);
  a.equal(small.spaceReserved, false); a.equal(small.deletionAuthorized, false);
});
test('database lane retains the old budget and remains distinct', () => {
  a.equal(planCapacity(observation()).demands.postgres, 24e9);
  a(planCapacity(observation()).checks[0].requiredBytes > planCapacity(observation(), 'code-only').checks[0].requiredBytes);
});
test('separate PG volume still needs free reserve even without new copy', () => {
  const o = observation(); o.volumes.postgres = { device: '2', availableBytes: 1 }; a.equal(planCapacity(o, 'code-only').ok, false);
});
test('unknown capacity lane rejects rather than using cheap budget', () => a.throws(() => planCapacity(observation(), 'force')));
test('remote cheap budget must bind the expected candidate and actual baseline', () => pair(x => {
  const p = policy.capture(x), o = observation(), selection = policy.classify(p, p), capacity = planCapacity(o, 'code-only');
  const r = { version: 'release-capacity-preflight-v1', sourceHash: 'a'.repeat(64), observation: o,
    capacity, ok: true, productionWrites: 0, spaceReserved: false, readyToCutover: false,
    dataPlane: { baseline: p, candidate: p, selection } };
  a.equal(validate(r, r.sourceHash, Date.now(), p).ok, true);
  a.throws(() => validate(r, r.sourceHash)); delete r.dataPlane; a.throws(() => validate(r, r.sourceHash, Date.now(), p));
}));

// Execute the actual new role operator with an injected transport. SQL effects
// and failure cleanup are asserted here; Linux fixture covers actual PG ACLs.
function roleFixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-role-')), queries = [];
  let created = false;
  const state = { dataPlane: 'code-only', accessSuffix: 'a'.repeat(12) + '_1791500000', clusterId: '1234567890123456789', maintenanceOid: '1', oldDatabaseOid: '2' };
  class Pool {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM pg_stat_activity')) return { rows: [{ n: options.sessions || 0 }] };
      if (sql.includes('FROM pg_roles')) return { rows: [{ n: created ? 1 : 0 }] };
      if (sql.includes('CREATE ROLE')) created = true;
      if (sql.includes('has_table_privilege')) return { rows: [{ n: options.writeGrant || 0 }] };
      if (sql.includes('has_function_privilege')) return sql.includes('count(*)')
        ? { rows: [{ n: options.definer || 0 }] } : { rows: options.definer ? [{ oid: '123', nspname: 'unsafe' }] : [] };
      if (sql.includes('DROP ROLE')) { if (options.dropFails) throw new Error('unexpected dependency'); created = false; }
      return { rows: [] };
    }
    async end() {}
  }
  const filename = path.join(root, 'scripts/nativeCodeReleaseDataPlane.cjs'), m = new Module(filename, module);
  const ordinary = Module.createRequire(filename);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m.require = name => name === './nativeReleasePostgresTransport.cjs' ? { NativeReleasePostgresPool: Pool }
    : name === './nativeReleaseDataPlane.cjs' ? { write: (p, v) => fs.writeFileSync(p, JSON.stringify(v), { flag: 'wx' }), read: p => JSON.parse(fs.readFileSync(p)) }
      : ordinary(name);
  m._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { state, directory, queries, api: m.exports, created: () => created, close: () => fs.rmSync(directory, { recursive: true }) };
}
test('candidate receives select-only expiring access and retires without DROP OWNED', async () => {
  const f = roleFixture(); try {
    const r = await f.api.candidateAccess(f.state, f.directory); a.equal(r.readOnly, true);
    a(Date.parse(r.expiresAt) <= Date.now() + 15 * 60000); a(f.queries.some(q => q.includes('GRANT SELECT')));
    await f.api.retire(f.state, f.directory); a.equal(f.created(), false);
    a(!f.queries.some(q => /CREATE DATABASE|DROP OWNED|pg_terminate_backend|GRANT (INSERT|UPDATE|ALL)/.test(q)));
  } finally { f.close(); }
});
for (const option of ['writeGrant', 'definer']) test('unsafe candidate privilege fails with retained retirement identity: ' + option, async () => {
  const f = roleFixture({ [option]: 1 }); try {
    await a.rejects(f.api.candidateAccess(f.state, f.directory)); a(fs.existsSync(path.join(f.directory, 'candidate-access-intent.json')));
    await f.api.retire(f.state, f.directory); a.equal(f.created(), false);
  } finally { f.close(); }
});
test('active reader blocks retirement without terminating sessions', async () => {
  const f = roleFixture({ sessions: 1 }); try {
    await f.api.candidateAccess(f.state, f.directory); await a.rejects(f.api.retire(f.state, f.directory), /sessions remain/);
    a.equal(f.created(), true); a(!f.queries.some(q => q.includes('DROP ROLE')));
  } finally { f.close(); }
});
test('unknown role dependencies preserve failure without broad cleanup', async () => {
  const f = roleFixture({ dropFails: true }); try {
    await f.api.candidateAccess(f.state, f.directory); await a.rejects(f.api.retire(f.state, f.directory), /dependency/);
    a(!f.queries.some(q => q.includes('DROP OWNED'))); a(!fs.existsSync(path.join(f.directory, 'candidate-access-dropped.json')));
  } finally { f.close(); }
});
test('same-name notifier with a changed body rejects before permission mutation', async () => {
  const f = roleFixture(), calls = []; try {
    const source = { query: async sql => { calls.push(sql); return { rows: [{ oid: '42', nspname: 'football',
      proname: 'wake_recommendation_workers', owner: 'football', pronargs: 0, returns: 'trigger',
      proconfig: ['search_path=pg_catalog'], proacl: null, definition: 'unreviewed changed body' }] }; } };
    await a.rejects(f.api.restrictKnownWakeTrigger(source, 'reader', f.directory), /notifier definition drift/);
    a.equal(calls.length, 1); a(!calls.some(sql => sql.includes('REVOKE')));
    a(!fs.existsSync(path.join(f.directory, 'candidate-function-hardening-intent.json')));
  } finally { f.close(); }
});
