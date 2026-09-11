"use strict";
// Actual recovery CLI/file operations and real PostgreSQL catalog/renames.
// Only service management/HTTP are fixtures; no production connection accepted.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process"), { Client } = require("pg");
const { createFixture, mapped, write, readTreeId } = require("./verifyReleaseRecovery.cjs");
const { nativeEnvironment, writeNativeSnapshot } = require("./nativeReleaseJournal.cjs");
const { switchNativeDatabase, fenceNativeDatabaseConnections } = require("./nativeDatabaseCutover.cjs");
async function main() {
  assert.equal(process.platform, "win32");
  const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.username, "q2_test");
  assert.ok(Number(url.port) > 1024 && url.port !== "5432"); assert.match(url.pathname, /^\/q2_evidence_native_[a-f0-9]+$/);
  const connect = async database => { const next = new URL(url); next.pathname = "/" + database;
    const client = new Client({ connectionString: next.href, ssl: false, connectionTimeoutMillis: 3000 }); await client.connect(); return client; };
  const admin = await connect("postgres"), results = [];
  const candidate = "football_release_aaaaaaaaaaaa_1789120000", archive = "football_legacy_bbbbbbbbbbbb_1789120000";
  const names = ["football", candidate, archive];
  const topology = async () => (await admin.query("SELECT datname AS name,oid::text AS oid,datallowconn AS allowed FROM pg_database WHERE datname=ANY($1::text[]) ORDER BY datname", [names])).rows;
  try {
    const identity = (await admin.query("SELECT current_setting('data_directory') AS directory, host(inet_server_addr()) AS address, (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id")).rows[0];
    const dir = fs.realpathSync(identity.directory), parent = path.dirname(dir);
    assert.equal(path.basename(dir), "data"); assert.ok(path.basename(parent).startsWith("football-native-pg-"));
    assert.equal(path.dirname(parent).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.equal(identity.address, "127.0.0.1");
    const psql = path.join(path.dirname((await admin.query("SELECT setting FROM pg_config() WHERE name='BINDIR'")).rows[0].setting), "bin", "psql.exe");
    assert.ok(fs.statSync(psql).isFile());
    await admin.query("CREATE ROLE football NOLOGIN");
    const original = fs.readFileSync(path.join(__dirname, "../deploy/light-server/football-release-recovery.cjs"), "utf8");
    const bypass = "    if (TEST_MODE) return this.state.nativeDatabaseTopology;";
    assert.equal(original.split(bypass).length, 2);
    const fenceBoundary = "    if (TEST_MODE) return; // native-connection-fence fixture boundary";
    assert.equal(original.split(fenceBoundary).length, 2);
    const querySource = original.replace(bypass, "    // QA executes the original catalog query against the disposable cluster.").replace(fenceBoundary, "");
    for (const [phase, active, kind] of [["prepared", false, "initial-cutover"], ["prepared", true, "initial-cutover"],
      ["swap-complete", true, "initial-cutover"], ["committed", true, "initial-cutover"], ["swap-complete", true, "runtime-only"]]) {
      assert.deepEqual(await topology(), []);
      await admin.query("CREATE DATABASE football OWNER football");
      if (kind === "initial-cutover") await admin.query('CREATE DATABASE "' + candidate + '" OWNER football');
      for (const database of kind === "initial-cutover" ? ["football", candidate] : ["football"]) {
        const client = await connect(database);
        try { await client.query("CREATE TABLE evidence(id integer PRIMARY KEY,payload text); INSERT INTO evidence VALUES(1,'original frozen draw 原始推荐')"); }
        finally { await client.end(); }
      }
      const f = createFixture(phase, { acceptedUi: true });
      try {
        const before = await topology(), oid = name => before.find(row => row.name === name).oid;
        const contract = { version: "native-app-data-forward-v1", kind, clusterId: identity.cluster_id,
          oldDatabaseOid: oid("football"), newDatabaseOid: kind === "runtime-only" ? oid("football") : oid(candidate),
          candidateDatabase: kind === "runtime-only" ? null : candidate, archiveDatabase: kind === "runtime-only" ? null : archive,
          compatibleRuntimeSha256: f.frontend.runtimeSha256 };
        for (const name of ["sqlite", "external-model-artifacts"]) {
          const target = path.resolve(f.current, name); assert.equal(path.dirname(target), path.resolve(f.current));
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
        }
        const nativeEnv = nativeEnvironment("KEEP_SETTING=yes\n");
        writeNativeSnapshot({ stagingDir: f.current, contract, environment: nativeEnv }); write(path.join(f.current, "transaction-version"), "4\n");
        const statePath = mapped(f.root, "/mock-systemd.json"), state = JSON.parse(fs.readFileSync(statePath));
        state.nativeHealth = true; delete state.nativeDatabaseTopology; write(statePath, JSON.stringify(state));
        const writer = await connect("football");
        try { await writer.query("INSERT INTO evidence VALUES(2,'new settled result after journal'); INSERT INTO evidence VALUES(3,'new model ledger entry')"); }
        finally { await writer.end(); }
        if (kind === "initial-cutover") {
          // Both databases receive the final source state before fencing.
          const staged = await connect(candidate);
          try { await staged.query("INSERT INTO evidence VALUES(2,'new settled result after journal'); INSERT INTO evidence VALUES(3,'new model ledger entry')"); }
          finally { await staged.end(); }
          const heldSource = await connect("football"), heldCandidate = await connect(candidate);
          try {
            assert.equal((await fenceNativeDatabaseConnections(admin, contract)).newConnectionsBlocked, true);
            await assert.rejects(connect("football"), /not currently accepting connections/);
            await assert.rejects(connect(candidate), /not currently accepting connections/);
            assert.equal((await heldSource.query("SELECT count(*)::int AS n FROM evidence")).rows[0].n, 3);
            assert.equal((await heldCandidate.query("SELECT count(*)::int AS n FROM evidence")).rows[0].n, 3);
          } finally { await heldSource.end(); await heldCandidate.end(); }
          if (active) await switchNativeDatabase(admin, contract);
        }
        const pointer = mapped(f.root, "/var/lib/football-predict/data-generations/current.json");
        write(pointer, '{"generationId":"new-generation-after-journal"}\n');
        const pointerBytes = fs.readFileSync(pointer), expectedTopology = (await topology()).map(row => row.name === "football" ? { ...row, allowed: true } : row);
        const childFile = path.join(f.root, "real-database-recovery.cjs"), credentials = { PGHOST: url.hostname, PGPORT: url.port, PGUSER: url.username, PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: "5" };
        // Redirection is confined to this generated test process. SQL text is
        // the production reader's unmodified SQL; all non-psql calls reject.
        const prelude = `const qaCp=require('node:child_process'),qaOriginal=qaCp.spawnSync;qaCp.spawnSync=(file,args,options)=>{if(file!=='/usr/sbin/runuser'||args.slice(0,4).join('|')!=='-u|postgres|--|/usr/bin/psql')throw Error('QA unexpected external command');return qaOriginal(${JSON.stringify(psql)},args.slice(4),{...options,env:{...process.env,...JSON.stringify_NOT_USED}});};\n`;
        // Credentials are inherited by the disposable child, never written to
        // the fixture, log or report.
        write(childFile, prelude.replace("...JSON.stringify_NOT_USED", "PGHOST:process.env.PGHOST,PGPORT:process.env.PGPORT,PGUSER:process.env.PGUSER,PGPASSWORD:process.env.PGPASSWORD") + querySource.replace(/^#![^\n]*\n/, ""));
        const result = spawnSync(process.execPath, [childFile], { env: { ...process.env, ...credentials,
          FOOTBALL_RELEASE_RECOVERY_TEST_MODE: "1", FOOTBALL_RELEASE_RECOVERY_TEST_ROOT: f.root }, encoding: "utf8", windowsHide: true, timeout: 30000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(readTreeId(f.app), phase === "committed" ? "new" : "old"); assert.equal(fs.existsSync(f.current), false);
        assert.deepEqual(await topology(), expectedTopology); assert.deepEqual(fs.readFileSync(pointer), pointerBytes);
        assert.equal(fs.readFileSync(mapped(f.root, "/etc/football-predict/env"), "utf8"), active ? nativeEnv : "RELEASE_STATE=old\n");
        const reader = await connect("football");
        try { assert.deepEqual((await reader.query("SELECT id,payload FROM evidence ORDER BY id")).rows,
          [{ id: 1, payload: "original frozen draw 原始推荐" }, { id: 2, payload: "new settled result after journal" }, { id: 3, payload: "new model ledger entry" }]); }
        finally { await reader.end(); }
        results.push({ phase, active, kind, ok: true });
      } finally {
        const resolved = fs.realpathSync(f.root); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
        assert.ok(path.basename(resolved).startsWith("football-release-recovery-")); fs.rmSync(resolved, { recursive: true });
        for (const row of await topology()) await admin.query('DROP DATABASE "' + row.name + '"');
      }
    }
    console.log(JSON.stringify({ ok: true, checks: results.length, results, actualRecoveryCli: true, actualDatabaseQueriesAndRenames: true,
      serviceManagementAndHttp: "fixtures", productionWrites: 0 }));
  } finally { await admin.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
