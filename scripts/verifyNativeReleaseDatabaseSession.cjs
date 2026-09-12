"use strict";
// A fresh loopback QA cluster only. Tests the complete final mirror/connection
// admission fence/rename ordering against PostgreSQL, including late failures.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Pool, Client } = require("pg");
const { runPostgresMigrations } = require("../server/postgresStore.cjs");
const { NativeReleaseDatabaseSession } = require("./nativeReleaseDatabaseSession.cjs");
async function main() {
  assert.equal(process.platform, "win32");
  const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.username, "q2_test");
  assert.ok(Number(url.port) > 1024 && url.port !== "5432"); assert.match(url.pathname, /^\/q2_evidence_native_[a-f0-9]+$/);
  const config = database => { const u = new URL(url); u.pathname = "/" + database;
    return { connectionString: u.href, ssl: false, connectionTimeoutMillis: 1500, idleTimeoutMillis: 0, max: 1 }; };
  const admin = new Client(config("postgres")); await admin.connect();
  const candidate = "football_release_aaaaaaaaaaaa_1789120000", archive = "football_legacy_bbbbbbbbbbbb_1789120000";
  const names = ["football", candidate, archive], cases = [];
  try {
    const row = (await admin.query("SELECT current_setting('data_directory') directory,host(inet_server_addr()) address,(SELECT system_identifier::text FROM pg_control_system()) cluster_id")).rows[0];
    const dir = fs.realpathSync(row.directory), parent = path.dirname(dir);
    assert.equal(path.basename(dir), "data"); assert.ok(path.basename(parent).startsWith("football-native-pg-"));
    assert.equal(path.dirname(parent).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.equal(row.address, "127.0.0.1");
    assert.equal((await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname=ANY($1::text[])", [names])).rows[0].n, 0);
    await admin.query("CREATE ROLE football NOLOGIN");
    for (const scenario of ["success", "unexpected-reader", "barrier-lost-after-fence"]) {
      let session, outsider;
      try {
        await admin.query("CREATE DATABASE football OWNER football"); await admin.query('CREATE DATABASE "' + candidate + '" OWNER football');
        const sourcePool = new Pool(config("football")), candidatePool = new Pool(config(candidate));
        await runPostgresMigrations(sourcePool); await runPostgresMigrations(candidatePool);
        const identity = { mode: "active-generation", generationId: "g-" + "a".repeat(64), manifestHash: "a".repeat(64), sourceCycleId: "synthetic-native-publisher", committedAt: "2026-09-12T00:00:00.000Z" };
        const keys = ["data_publication_mode", "data_generation_id", "manifest_hash", "data_generation_source_cycle_id", "committed_at"];
        for (let i = 0; i < keys.length; i++) await sourcePool.query("INSERT INTO football.projection_meta(key,value,updated_at) VALUES($1,$2,$3)", [keys[i], Object.values(identity)[i], identity.committedAt]);
        const payload = ' {"tip":"X","note":"原始冻结推荐"}\n';
        const digest = require("node:crypto").createHash("sha256").update(payload).digest("hex");
        await sourcePool.query("INSERT INTO football.private_model_artifacts(artifact_key,artifact_version,generated_at,updated_at,payload,payload_sha256,payload_bytes) VALUES('original','v1',$1,$1,$2,$3,$4)", [identity.committedAt, payload, digest, Buffer.byteLength(payload)]);
        const topology = Object.fromEntries((await admin.query("SELECT datname,oid::text FROM pg_database WHERE datname=ANY($1::text[])", [names])).rows.map(r => [r.datname, r.oid]));
        const contract = { version: "native-app-data-forward-v1", kind: "initial-cutover", clusterId: row.cluster_id, oldDatabaseOid: topology.football,
          newDatabaseOid: topology[candidate], candidateDatabase: candidate, archiveDatabase: archive, compatibleRuntimeSha256: "b".repeat(64) };
        session = new NativeReleaseDatabaseSession({ sourcePool, candidatePool, administrator: admin, contract });
        assert.deepEqual(await session.beginSnapshot(), identity); assert.equal((await session.mirror()).ok, true); await session.releaseSnapshot();
        if (scenario === "unexpected-reader") { outsider = new Client(config("football")); await outsider.connect(); }
        let barrierChecks = 0;
        const options = { verifyDurableBarrier: async received => { assert.deepEqual(received, contract); barrierChecks++; },
          verifyGeneration: async received => { assert.deepEqual(received, identity);
            if (scenario === "barrier-lost-after-fence") throw Error("synthetic generation barrier lost"); },
          completeCandidate: async ({ client }) => {
            const result = (await client.query("SELECT payload::text raw,payload_sha256 FROM football.private_model_artifacts WHERE artifact_key='original'")).rows[0];
            assert.equal(result.raw, payload); assert.equal(result.payload_sha256, digest);
            const attempt = new Client(config("football")); await assert.rejects(attempt.connect(), /not currently accepting connections/); await attempt.end();
          } };
        if (scenario === "success") {
          const result = await session.finalMirrorAndSwitch(options); assert.equal(result.ok, true); assert.equal(barrierChecks, 2);
          assert.equal(result.mirror.mode, "incremental"); assert.equal(result.mirror.copiedRows, 0);
          const rows = (await admin.query("SELECT datname,oid::text,datallowconn FROM pg_database WHERE datname=ANY($1::text[])", [names])).rows;
          assert.equal(rows.find(r => r.datname === "football").oid, contract.newDatabaseOid);
          assert.equal(rows.find(r => r.datname === archive).datallowconn, false);
          assert.equal(rows.some(r => r.datname === candidate), false);
        } else {
          await assert.rejects(session.finalMirrorAndSwitch(options), scenario === "unexpected-reader" ? /unknown application/ : /synthetic generation/);
          const rows = (await admin.query("SELECT datname,oid::text,datallowconn FROM pg_database WHERE datname=ANY($1::text[])", [names])).rows;
          assert.equal(rows.find(r => r.datname === "football").oid, contract.oldDatabaseOid);
          assert.equal(rows.find(r => r.datname === "football").datallowconn, scenario === "unexpected-reader");
          assert.equal(rows.some(r => r.datname === archive), false);
        }
        cases.push({ name: scenario, ok: true });
      } finally {
        if (outsider) await outsider.end(); if (session) await session.close();
        for (const { datname } of (await admin.query("SELECT datname FROM pg_database WHERE datname=ANY($1::text[])", [names])).rows) {
          assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1", [datname])).rows[0].n, 0);
          await admin.query('DROP DATABASE "' + datname + '"');
        }
      }
    }
    console.log(JSON.stringify({ ok: true, cases, productionWrites: 0, sqliteExports: 0 }));
  } finally { await admin.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
