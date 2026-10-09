'use strict';
// Actual PostgreSQL permissions in a disposable UNIX-socket-only cluster.
// No production SQL, systemd, published data or deployment transaction.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), Module = require('node:module');
const { spawnSync } = require('node:child_process');
async function run(sourceFile = path.join(__dirname, 'nativeCodeReleaseDataPlane.cjs')) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const pg = require('/opt/football-predict/node_modules/pg');
  const base = fs.mkdtempSync('/var/tmp/football-code-pg-'), data = path.join(base, 'data'), socket = path.join(base, 'socket');
  fs.chmodSync(base, 0o755);
  const command = (exe, args, options = {}) => {
    const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 40000, maxBuffer: 65536, ...options });
    assert.equal(r.status, 0, r.stderr || r.error?.message || 'fixture command failed'); return r.stdout.trim();
  };
  const uid = Number(command('/usr/bin/id', ['-u', 'postgres'])), gid = Number(command('/usr/bin/id', ['-g', 'postgres']));
  for (const dir of [data, socket]) { fs.mkdirSync(dir, { mode: 0o700 }); fs.chownSync(dir, uid, gid); }
  const bindir = command('/usr/bin/pg_config', ['--bindir']); assert.match(bindir, /^\/usr\/lib\/postgresql\/[0-9]+\/bin$/);
  const ctl = (name, args) => command('/usr/sbin/runuser', ['-u', 'postgres', '--', path.join(bindir, name), ...args]);
  let started = false, admin, db, reader;
  const checks = [];
  const s = { dataPlane: 'code-only', accessSuffix: 'abcdef123456_1791500000', clusterId: '1234567890123456789', maintenanceOid: '1', oldDatabaseOid: '2' };
  try {
    ctl('initdb', ['-D', data, '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--locale=C']);
    ctl('pg_ctl', ['-D', data, '-l', path.join(data, 'qa.log'), '-o', "-c listen_addresses='' -c unix_socket_directories='" + socket + "' -c shared_buffers=16MB -c max_connections=20", '-w', 'start']); started = true;
    admin = new pg.Pool({ host: socket, user: 'postgres', database: 'postgres', max: 1 });
    const actual = (await admin.query("SELECT current_setting('data_directory') AS dir,inet_server_addr() AS ip")).rows[0];
    assert.equal(actual.dir, data); assert.equal(actual.ip, null);
    await admin.query('CREATE ROLE football LOGIN; CREATE SCHEMA fixture_unused');
    await admin.query('CREATE DATABASE football OWNER football');
    db = new pg.Pool({ host: socket, user: 'postgres', database: 'football', max: 1 });
    await db.query("CREATE SCHEMA football AUTHORIZATION football; CREATE TABLE football.frozen(id integer PRIMARY KEY, direction text); ALTER TABLE football.frozen OWNER TO football; INSERT INTO football.frozen VALUES(1,'original'); REVOKE ALL ON SCHEMA football FROM PUBLIC; REVOKE ALL ON football.frozen FROM PUBLIC");
    const directory = path.join(base, 'state'); fs.mkdirSync(directory, { mode: 0o700 });
    const seedSha = 'a'.repeat(64), seedState = path.join(base, 'native', seedSha);
    fs.mkdirSync(seedState, { recursive: true, mode: 0o700 });
    const m = new Module(sourceFile, module); m.filename = sourceFile; m.paths = [];
    const builtin = Module.createRequire(__filename);
    class IsolatedPool {
      constructor({ database }) { assert(['football', 'postgres'].includes(database)); this.p = new pg.Pool({ host: socket, user: 'postgres', database, max: 1 }); }
      query(...args) { return this.p.query(...args); }
      end() { return this.p.end(); }
    }
    m.require = name => {
      if (name.startsWith('node:')) return builtin(name);
      if (name === './releaseDataPlanePolicy.cjs') return {}; // allocation is not invoked in this ACL fixture
      if (name === './nativeReleasePostgresTransport.cjs') return { NativeReleasePostgresPool: IsolatedPool };
      if (name === './nativeReleaseJournal.cjs') return { NATIVE_SELECTORS: {} };
      if (name === './nativeReleaseDataPlane.cjs') return {
        write: (file, value) => { assert([directory, seedState].includes(path.dirname(file))); fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); },
        read: file => { assert([directory, seedState].includes(path.dirname(file))); return JSON.parse(fs.readFileSync(file)); },
        readOldRuntimeIdentity: () => ({ bundleMarker: seedSha, liveMarker: seedSha }),
        secureDirectory: target => { assert.equal(target, path.join(seedState, 'code-seed-store')); },
      };
      throw new Error('fixture unexpected dependency: ' + name);
    };
    const rawSource = fs.readFileSync(sourceFile, 'utf8');
    assert.equal(rawSource.split("'/var/lib/football-release/native/'").length, 2);
    assert.equal(rawSource.split("'/var/lib/football-release/recovery/current'").length, 2);
    m._compile(rawSource.replace("'/var/lib/football-release/native/'", JSON.stringify(path.join(base, 'native') + '/'))
      .replace("'/var/lib/football-release/recovery/current'", JSON.stringify(path.join(base, 'recovery-current'))), sourceFile);
    const access = await m.exports.candidateAccess(s, directory);
    reader = new pg.Client({ host: socket, user: access.role, database: 'football' }); await reader.connect();
    assert.equal((await reader.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    assert.equal((await reader.query('SELECT direction FROM football.frozen')).rows[0].direction, 'original');
    checks.push('actual isolated PG reader loads original row with default read-only');
    // Prove ACLs, not merely the overridable default_transaction_read_only.
    await reader.query('SET default_transaction_read_only=off');
    for (const sql of ["UPDATE football.frozen SET direction='changed'", 'DELETE FROM football.frozen', "INSERT INTO football.frozen VALUES(2,'new')", 'TRUNCATE football.frozen', 'ALTER TABLE football.frozen ADD COLUMN bad text', 'SET ROLE football']) {
      await assert.rejects(reader.query(sql));
    }
    assert.equal((await db.query('SELECT direction FROM football.frozen')).rows[0].direction, 'original');
    checks.push('INSERT UPDATE DELETE TRUNCATE DDL and SET ROLE denied even with read-only default disabled');
    await assert.rejects(m.exports.retire(s, directory), /sessions remain/);
    checks.push('active sessions block retirement without termination');
    await reader.end(); reader = null;
    await m.exports.retire(s, directory);
    assert.equal((await admin.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=$1', [access.role])).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM football.frozen')).rows[0].n, 1);
    checks.push('ordinary revoke and DROP ROLE leave original table and row intact');
    await m.exports.retire(s, directory); checks.push('retirement observation is idempotent');
    const snapshot = path.join(seedState, 'code-seed-store'); fs.mkdirSync(snapshot, { mode: 0o700 });
    const writeSeed = (name, value) => fs.writeFileSync(path.join(seedState, name), JSON.stringify(value), { mode: 0o600 });
    writeSeed('state.json', { sha: seedSha, dataPlane: 'code-only' }); writeSeed('candidate-access-dropped.json', { ok: true });
    writeSeed('seed-accepted.json', { store: snapshot, dataPlane: 'code-only' });
    const outside = path.join(base, 'preserve'); fs.writeFileSync(outside, 'original'); fs.symlinkSync(outside, path.join(snapshot, 'escape'));
    assert.throws(() => m.exports.retireSeed(seedSha)); assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
    fs.unlinkSync(path.join(snapshot, 'escape')); fs.writeFileSync(path.join(snapshot, 'generation'), 'copy', { mode: 0o600 });
    fs.mkdirSync(path.join(base, 'recovery-current')); assert.throws(() => m.exports.retireSeed(seedSha), /recovery still active/);
    fs.rmdirSync(path.join(base, 'recovery-current'));
    assert.equal(m.exports.retireSeed(seedSha).removed, true); assert.equal(fs.existsSync(snapshot), false);
    assert(fs.existsSync(path.join(seedState, 'seed-accepted.json'))); assert(fs.existsSync(path.join(seedState, 'code-seed-retired.json')));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'original'); checks.push('exact disposable seed retires only after completion; links and active recovery are rejected');
    return { ok: true, checks, fixtureOnly: true, postgresAclTested: true, productionWrites: 0,
      sourceSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex') };
  } finally {
    if (reader) await reader.end(); if (db) await db.end(); if (admin) await admin.end();
    if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) ctl('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    assert.equal(fs.realpathSync(base), base); assert.equal(path.dirname(base), '/var/tmp'); assert(path.basename(base).startsWith('football-code-pg-'));
    fs.rmSync(base, { recursive: true });
  }
}
module.exports = { run };
if (require.main === module) run(process.argv[2]).then(r => console.log(JSON.stringify(r)))
  .catch(e => { console.error(e.stack); process.exitCode = 1; });
