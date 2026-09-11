"use strict";
// Only the fresh, loopback Windows cluster created by the existing QA harness
// is accepted. No production host, existing database or default port is used.
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs"), os = require("node:os");
const { Client } = require("pg"), { switchNativeDatabase } = require("./nativeDatabaseCutover.cjs");
async function main() {
  assert.equal(process.platform, "win32");
  const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.username, "q2_test");
  assert.ok(Number(url.port) > 1024 && url.port !== "5432"); assert.match(url.pathname, /^\/q2_evidence_native_[a-f0-9]+$/);
  const connect = async database => { const next = new URL(url); next.pathname = "/" + database; const c = new Client({ connectionString: next.href, ssl: false, connectionTimeoutMillis: 3000 }); await c.connect(); return c; };
  const admin = await connect(url.pathname.slice(1));
  try {
    const r = (await admin.query("SELECT current_setting('data_directory') AS directory, host(inet_server_addr()) AS address, (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id")).rows[0];
    const dir = fs.realpathSync(r.directory), parent = path.dirname(dir);
    assert.equal(path.basename(dir), "data"); assert.ok(path.basename(parent).startsWith("football-native-pg-"));
    assert.equal(path.dirname(parent).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.equal(r.address, "127.0.0.1");
    await admin.query("CREATE ROLE football NOLOGIN");
    const maint = await connect("postgres"), results = [];
    const candidate = "football_release_aaaaaaaaaaaa_1789120000", archive = "football_legacy_bbbbbbbbbbbb_1789120000";
    const names = ["football", candidate, archive];
    const rows = async () => (await maint.query("SELECT datname AS name,oid::text AS oid,datallowconn AS allowed FROM pg_database WHERE datname=ANY($1::text[]) ORDER BY datname", [names])).rows;
    const one = async (name, run) => {
      assert.deepEqual(await rows(), []);
      await maint.query("CREATE DATABASE football OWNER football"); await maint.query('CREATE DATABASE "' + candidate + '" OWNER football');
      for (const [database, payload] of [["football", "original frozen draw\n原始推荐"], [candidate, "native candidate\n新投影"]]) {
        const c = await connect(database); try { await c.query("CREATE TABLE evidence(payload text)"); await c.query("INSERT INTO evidence VALUES($1)", [payload]); } finally { await c.end(); }
      }
      const before = await rows(), oid = n => before.find(row => row.name === n).oid;
      const contract = { version: "native-app-data-forward-v1", kind: "initial-cutover", clusterId: r.cluster_id, oldDatabaseOid: oid("football"), newDatabaseOid: oid(candidate), candidateDatabase: candidate, archiveDatabase: archive, compatibleRuntimeSha256: "a".repeat(64) };
      try { await run({ contract, before }); results.push({ name, ok: true }); }
      finally { for (const row of await rows()) await maint.query('DROP DATABASE "' + row.name + '"'); }
    };
    try {
      await one("wrong database OID rejects before changes", async ({ contract, before }) => {
        await assert.rejects(switchNativeDatabase(maint, { ...contract, newDatabaseOid: "1" }), /identity changed/); assert.deepEqual(await rows(), before);
      });
      await one("wrong cluster rejects before changes", async ({ contract, before }) => {
        await assert.rejects(switchNativeDatabase(maint, { ...contract, clusterId: "9999999999999999999" }), /cluster changed/); assert.deepEqual(await rows(), before);
      });
      for (const database of ["football", candidate]) await one("connected " + database + " rejects without termination", async ({ contract, before }) => {
        const held = await connect(database);
        try { await assert.rejects(switchNativeDatabase(maint, contract), /have not drained/); assert.equal((await held.query("SELECT 1 AS alive")).rows[0].alive, 1); assert.deepEqual(await rows(), before); }
        finally { await held.end(); }
      });
      for (const point of ["first-rename", "second-rename"]) await one("real transaction rolls back after " + point, async ({ contract, before }) => {
        const exact = point === "first-rename" ? 'ALTER DATABASE football RENAME TO "' + archive + '"' : 'ALTER DATABASE "' + candidate + '" RENAME TO football';
        const intercepted = { query: async (...args) => { const result = await maint.query(...args); if (args[0] === exact) throw new Error("injected-after-rename"); return result; } };
        await assert.rejects(switchNativeDatabase(intercepted, contract), /injected-after-rename/); assert.deepEqual(await rows(), before);
        const old = await connect("football"); try { assert.equal((await old.query("SELECT payload FROM evidence")).rows[0].payload, "original frozen draw\n原始推荐"); } finally { await old.end(); }
      });
      for (const uncertain of [false, true]) await one(uncertain ? "lost commit acknowledgement retains observable committed OIDs" : "atomic switch preserves old archive and new writes", async ({ contract }) => {
        const intercepted = { query: async (...args) => { const result = await maint.query(...args); if (args[0] === "COMMIT") throw new Error("injected-lost-commit-acknowledgement"); return result; } };
        if (uncertain) await assert.rejects(switchNativeDatabase(intercepted, contract), /lost-commit-acknowledgement/);
        else { const result = await switchNativeDatabase(maint, contract); assert.equal(result.ok, true); assert.equal(result.databaseDrops, 0); assert.equal(result.terminatedConnections, 0); }
        const after = await rows(); assert.deepEqual(after, [{ name: "football", oid: contract.newDatabaseOid, allowed: true }, { name: archive, oid: contract.oldDatabaseOid, allowed: false }]);
        const active = await connect("football");
        try { assert.equal((await active.query("SELECT payload FROM evidence")).rows[0].payload, "native candidate\n新投影"); await active.query("INSERT INTO evidence VALUES('new settled result')"); } finally { await active.end(); }
        await assert.rejects(switchNativeDatabase(maint, contract), /already committed/); assert.deepEqual(await rows(), after);
        const reader = await connect("football"); try { assert.equal((await reader.query("SELECT count(*)::int AS count FROM evidence")).rows[0].count, 2); } finally { await reader.end(); }
      });
    } finally { await maint.end(); }
    console.log(JSON.stringify({ ok: true, checks: results.length, results, realPostgresRenameAndRollback: true, applicationRecoveryTested: false, productionWrites: 0 }));
  } finally { await admin.end(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
