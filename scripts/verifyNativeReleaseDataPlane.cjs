"use strict";
// Linux/root fixture: actual pg_dump/pg_restore, peer IPC, generation leases,
// HMAC mirror, and candidate role grants. Only the fixed socket/store boundary
// is relocated to a newly initialized, network-disabled disposable cluster.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto"), Module = require("node:module");
const { spawnSync } = require("node:child_process");
async function run() {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const base = fs.mkdtempSync("/var/lib/football-release/native-data-qa-"); fs.chmodSync(base, 0o755);
  const data = path.join(base, "data"), socket = path.join(base, "socket"), store = path.join(base, "store"), stateDir = path.join(base, "state");
  const id = (flag, name) => Number(spawnSync("/usr/bin/id", [flag, name], { encoding: "utf8" }).stdout.trim());
  for (const directory of [data, socket]) { fs.mkdirSync(directory, { mode: 0o700 }); fs.chownSync(directory, id("-u", "postgres"), id("-g", "postgres")); }
  fs.mkdirSync(store); fs.mkdirSync(stateDir, { mode: 0o700 });
  const bindir = spawnSync("/usr/bin/pg_config", ["--bindir"], { encoding: "utf8" }).stdout.trim(); assert.match(bindir, /^\/usr\/lib\/postgresql\/[0-9]+\/bin$/);
  const command = (name, args) => {
    const r = spawnSync("/usr/sbin/runuser", ["-u", "postgres", "--", path.join(bindir, name), ...args], { encoding: "utf8", timeout: 40000, maxBuffer: 65536 });
    assert.equal(r.status, 0, r.stderr || r.stdout); return r;
  };
  const checks = [], sourceHashes = {};
  const compile = (name, transform, special = {}) => {
    const filename = path.join(__dirname, name), raw = fs.readFileSync(filename, "utf8"); sourceHashes[name] = crypto.createHash("sha256").update(raw).digest("hex");
    const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(__dirname);
    const originalRequire = Module.createRequire(filename); m.require = name => special[name] || originalRequire(name);
    m._compile(transform(raw), filename); return m.exports;
  };
  let started = false, admin, source;
  try {
    command("initdb", ["-D", data, "--auth-local=peer", "--auth-host=reject", "--encoding=UTF8", "--locale=C"]);
    // Unix socket path is exclusive to this fixture; no TCP listener exists.
    command("pg_ctl", ["-D", data, "-l", path.join(data, "qa.log"), "-o", "-c listen_addresses='' -c unix_socket_directories='" + socket + "' -c shared_buffers=16MB -c max_connections=20", "-w", "start"]); started = true;
    const transport = compile("nativeReleasePostgresTransport.cjs", text => {
      assert.equal(text.split("/var/run/postgresql").length, 2); return text.replace("/var/run/postgresql", socket);
    });
    const connect = transport.NativeReleasePostgresPool.prototype.connect;
    transport.NativeReleasePostgresPool.prototype.connect = async function () {
      const client = await connect.call(this), query = client.query;
      client.query = async (sql, values = []) => { try { return await query(sql, values); } catch (error) {
        if (/^(SELECT|FETCH|DECLARE|CLOSE|INSERT INTO mirror_)/.test(sql)) error.message += " [fixture SQL: " + sql + "; parameters=" + values.length + "]";
        throw error;
      } }; return client;
    };
    const sql = query => {
      const r = spawnSync("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-X", "-q", "-t", "-A", "--set=ON_ERROR_STOP=1", "--dbname=postgres"],
        { input: query, env: { PATH: "/usr/bin:/bin", PGHOST: socket }, encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
      assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
    };
    const initial = sql("SELECT json_build_object('directory',current_setting('data_directory'),'clusterId',(SELECT system_identifier::text FROM pg_control_system()),'oid',(SELECT oid::text FROM pg_database WHERE datname='postgres'),'address',inet_server_addr())");
    assert.equal(initial.directory, data); assert.equal(initial.address, null);
    admin = new transport.NativeReleasePostgresPool({ database: "postgres", databaseOid: initial.oid, clusterId: initial.clusterId });
    await admin.query("CREATE ROLE football LOGIN"); await admin.query("CREATE DATABASE football OWNER football");
    const candidateDatabase = "football_release_" + crypto.randomBytes(6).toString("hex") + "_" + Math.floor(Date.now() / 1000);
    await admin.query('CREATE DATABASE "' + candidateDatabase + '" OWNER football');
    await admin.query('REVOKE ALL ON DATABASE "' + candidateDatabase + '" FROM PUBLIC');
    const dbs = Object.fromEntries((await admin.query("SELECT datname,oid::text FROM pg_database")).rows.map(row => [row.datname, row.oid]));
    const { commitDataGeneration } = require("../server/dataGenerationStore.cjs");
    const original = ' {"frozen":"原始推荐不变"}\n', at = "2026-09-12T00:00:00.000Z";
    const generation = commitDataGeneration({ storeDir: store, sourceCycleId: "isolated-native-data-plane", files: { "original.json": { bytes: original, rows: 1 } }, coreFiles: ["original.json"], committedAt: at });
    const identity = { mode: "active-generation", generationId: generation.pointer.generationId, manifestHash: generation.pointer.manifestHash, sourceCycleId: "isolated-native-data-plane", committedAt: at };
    const own = file => { const st = fs.lstatSync(file); assert.ok(!st.isSymbolicLink()); if (st.isDirectory()) for (const name of fs.readdirSync(file)) own(path.join(file, name)); fs.chownSync(file, id("-u", "football"), id("-g", "football")); };
    own(store);
    source = new transport.NativeReleasePostgresPool({ database: "football", databaseOid: dbs.football, clusterId: initial.clusterId });
    await require("../server/postgresStore.cjs").runPostgresMigrations(source);
    await source.query("REVOKE ALL ON ALL TABLES IN SCHEMA football FROM PUBLIC");
    const keys = ["data_publication_mode", "data_generation_id", "manifest_hash", "data_generation_source_cycle_id", "committed_at"];
    for (let i = 0; i < keys.length; i++) await source.query("INSERT INTO football.projection_meta(key,value,updated_at) VALUES($1,$2,$3)", [keys[i], Object.values(identity)[i], at]);
    await source.query("INSERT INTO football.private_model_artifacts(artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes) VALUES('original','v1',$1,$1,$2,$3,$4)",
      [at, original, crypto.createHash("sha256").update(original).digest("hex"), Buffer.byteLength(original)]);
    const state = { sha: crypto.randomBytes(32).toString("hex"), oldSha: "b".repeat(64), kind: "initial-cutover", clusterId: initial.clusterId,
      maintenanceOid: initial.oid, oldDatabaseOid: dbs.football, candidateOid: dbs[candidateDatabase], candidateDatabase,
      archiveDatabase: candidateDatabase.replace("football_release_", "football_legacy_"), key: crypto.randomBytes(32).toString("hex") };
    const driver = compile("nativeReleaseDataPlane.cjs", text => {
      const boundary = 'const ROOT = "/var/lib/football-release/native", STORE = "/var/lib/football-predict";'; assert.equal(text.split(boundary).length, 2);
      return text.replace(boundary, "const ROOT=" + JSON.stringify(base) + ",STORE=" + JSON.stringify(store) + ";").replaceAll('PGHOST: "/var/run/postgresql"', "PGHOST: " + JSON.stringify(socket));
    }, { "./nativeReleasePostgresTransport.cjs": transport });
    const proof = await driver.prepare(state, stateDir, true); assert.equal(proof.ok, true); assert.equal(proof.mirror.copiedRows, 0);
    assert.equal(proof.mirror.verifiedSeedRows, proof.mirror.inspectedRows); assert.equal(proof.generation.bytes > 0, true);
    assert.equal(fs.readFileSync(path.join(proof.store, "data-generations/generations", identity.generationId, "original.json"), "utf8"), original);
    checks.push("held-snapshot dump, restore, complete mirror and service-account generation copy preserve original bytes");
    const access = await driver.candidateAccess(state, stateDir, false);
    const candidate = new transport.NativeReleasePostgresPool({ database: candidateDatabase, databaseOid: state.candidateOid, clusterId: state.clusterId });
    try {
      await candidate.query('SET ROLE "' + access.role + '"');
      assert.equal((await candidate.query("SELECT payload::text raw FROM football.private_model_artifacts WHERE artifact_key='original'")).rows[0].raw, original);
      await assert.rejects(candidate.query("DELETE FROM football.private_model_artifacts"), /permission denied/);
      await candidate.query("RESET ROLE");
      await source.query('SET ROLE "' + access.role + '"');
      await assert.rejects(source.query("SELECT * FROM football.private_model_artifacts"), /permission denied/); await source.query("RESET ROLE");
    } finally { await candidate.end(); }
    await driver.dropCandidateAccess(state, stateDir, false); checks.push("candidate reader can read only its own restored database and cannot write");
    const builder = await driver.candidateAccess(state, stateDir, true);
    const writer = new transport.NativeReleasePostgresPool({ database: candidateDatabase, databaseOid: state.candidateOid, clusterId: state.clusterId });
    try { await writer.query('SET ROLE "' + builder.role + '"');
      await writer.query("UPDATE football.projection_meta SET value='candidate-only' WHERE key='data_generation_source_cycle_id'");
      assert.equal((await source.query("SELECT value FROM football.projection_meta WHERE key='data_generation_source_cycle_id'")).rows[0].value, identity.sourceCycleId);
    } finally { await writer.end(); }
    await driver.dropCandidateAccess(state, stateDir, true); checks.push("build writer changes only its independent candidate and both transient roles are removed");
    const refreshed = await driver.prepare(state, stateDir, false); assert.equal(refreshed.ok, true); assert.equal(refreshed.mirror.mode, "incremental");
    assert.equal(refreshed.mirror.copiedRows, 1); checks.push("authenticated final refresh removes candidate-only metadata edits");
    return { ok: true, checks, sourceHashes, fixtureDirectory: base, clusterId: initial.clusterId, productionWrites: 0, sqliteExports: 0,
      scope: "actual Linux data preparation; fixed paths/socket relocated, no production cutover or service management" };
  } finally {
    if (source) await source.end(); if (admin) await admin.end();
    if (started) { assert.equal(fs.realpathSync(data), data); assert.ok(path.basename(base).startsWith("native-data-qa-")); command("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]); }
  }
}
module.exports = { run };
if (require.main === module) run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.stack); process.exitCode = 1; });
