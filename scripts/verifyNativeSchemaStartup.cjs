"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const pg = require("../server/postgresStore.cjs");
const expected = pg.listMigrationFiles().map(file => ({ version: file.replace(/\.sql$/i, ""),
  sha256: pg.migrationSha256(fs.readFileSync(path.join(__dirname, "../server/postgres/migrations", file), "utf8")) }));
async function check(rows, accepted) {
  const queries = [], released = [];
  const client = { query: async sql => { queries.push(sql); return { rows }; }, release: error => released.push(error) };
  const promise = pg.verifyPostgresSchemaCurrent({ connect: async () => client });
  if (accepted) { const result = await promise; assert.equal(result.readOnly, true); assert.deepEqual(result.applied, []); }
  else await assert.rejects(promise, { code: "POSTGRES_NATIVE_SCHEMA_MISMATCH" });
  assert.equal(released.length, 1);
  assert.deepEqual(queries.slice(0, 2), ["BEGIN ISOLATION LEVEL REPEATABLE READ", "SET TRANSACTION READ ONLY"]);
  assert.ok(queries.every(sql => !/CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|advisory/i.test(sql)));
  assert.equal(queries.at(-1), accepted ? "COMMIT" : "ROLLBACK");
}
(async () => {
  await check(expected, true); await check(expected.slice(1), false);
  await check([...expected, { version: "999_unknown", sha256: "0".repeat(64) }], false);
  await check(expected.map((row, i) => i ? row : { ...row, sha256: "0".repeat(64) }), false);
  const server = fs.readFileSync(path.join(__dirname, "../server/index.cjs"), "utf8");
  assert.match(server, /storageMode\.postgresOnly\s*\? await require\("\.\/postgresStore\.cjs"\)\.verifyPostgresSchemaCurrent\(postgresPool\)\s*: await runPostgresMigrations\(postgresPool\)/);
  let realReadonlyRole = false;
  if (process.env.EVIDENCE_TEST_POSTGRES_URL) {
    const { Pool } = require("pg"), crypto = require("node:crypto"), os = require("node:os");
    const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname)); assert.match(url.pathname, /^\/q2_evidence_native_[a-f0-9]{10}$/);
    const admin = new Pool({ connectionString: url.href, ssl: false, max: 1 });
    const role = "q2_native_reader_" + crypto.randomBytes(6).toString("hex"), password = crypto.randomBytes(24).toString("hex");
    let created = false, reader;
    try {
      const info = (await admin.query("SELECT current_setting('data_directory') AS directory, (SELECT count(*)::int FROM pg_tables WHERE schemaname='football') AS tables")).rows[0];
      const parent = path.dirname(path.resolve(info.directory));
      assert.equal(path.dirname(parent).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
      assert.ok(path.basename(parent).startsWith("football-native-pg-")); assert.equal(info.tables, 0);
      await pg.runPostgresMigrations(admin);
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); created = true;
      await admin.query(`GRANT USAGE ON SCHEMA football TO "${role}"; GRANT SELECT ON football.schema_migrations TO "${role}"`);
      url.username = role; url.password = password; reader = new Pool({ connectionString: url.href, ssl: false, max: 1 });
      assert.equal((await pg.verifyPostgresSchemaCurrent(reader)).verified, expected.length);
      await assert.rejects(reader.query("CREATE SCHEMA forbidden_native_startup"), { code: "42501" });
      await assert.rejects(reader.query("DELETE FROM football.schema_migrations"), { code: "42501" });
      realReadonlyRole = true;
    } finally {
      if (reader) await reader.end();
      if (created) await admin.query(`REVOKE SELECT ON football.schema_migrations FROM "${role}"; REVOKE USAGE ON SCHEMA football FROM "${role}"; DROP ROLE "${role}"`);
      await admin.end();
    }
  }
  console.log(JSON.stringify({ ok: true, checks: realReadonlyRole ? 8 : 5, migrations: expected.length, realReadonlyRole,
    productionWrites: 0, scope: realReadonlyRole ? "isolated PostgreSQL role accepts startup verification and rejects DDL/data writes" : "read-only startup query contract; not production acceptance" }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
