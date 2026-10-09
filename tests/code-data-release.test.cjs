'use strict';
const { test } = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const policy = require('../scripts/releaseDataPlanePolicy.cjs');
const { planCapacity } = require('../scripts/nativeReleaseCapacity.cjs');
const { validate } = require('../scripts/runReleaseCapacityPreflight.cjs');
const root = path.resolve(__dirname, '..');
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
