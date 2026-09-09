"use strict";
// Only an isolated, freshly initialized local QA database may run this suite.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), Module = require("node:module");
const { Pool } = require("pg");
const { runPostgresMigrations } = require("../server/postgresStore.cjs");
const native = require("./postgresPrivateModelArtifactStore.cjs");
const runtime = require("./runtimePrivateModelArtifactStore.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function run() {
  const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL || "");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/q2_evidence_[a-z0-9_]+$/);
  const pool = new Pool({ connectionString: url.href, ssl: false, max: 1 });
  const checks = [];
  const check = async (name, action) => { await action(); checks.push({ name, ok: true }); };
  const load = Module._load;
  let sqliteAttempts = 0;
  try {
    const empty = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='football'");
    assert.equal(empty.rows[0].n, 0, "refuse an existing football database");
    await runPostgresMigrations(pool);
    Module._load = function(name, ...args) {
      if (name === "node:sqlite" || /(?:^|\/)privateModelArtifactStore\.cjs$/.test(name)) {
        sqliteAttempts++; throw new Error("SQLite access is forbidden in native audit tests");
      }
      return load.call(this, name, ...args);
    };
    const key = "synthetic-native-audit", at = "2026-09-09T00:01:00.000Z";
    const payload = { version: "synthetic-native-v1", evaluatedAt: at, tip: "X", onlineEffect: "shadow", note: "合成测试" };
    let first;
    await check("native facade writes and reads without SQLite", async () => {
      first = await runtime.writePrivateModelArtifact({ pool, storage: "postgres", artifactKey: key, payload });
      const read = await runtime.readPrivateModelArtifact({ pool, storage: "postgres", artifactKey: key });
      assert.equal(read.storage, "postgres"); assert.equal(read.generatedAt, at);
      assert.deepEqual(read.payload, payload); assert.equal(read.payloadSha256, first.payloadSha256);
      assert.equal(read.updatedAt, first.updatedAt); assert.equal(read.integrity.hashVerified, true);
    });
    const raw = JSON.stringify(payload, null, 2) + "\n";
    const row = { artifact_key: "synthetic-import-audit", artifact_version: payload.version,
      generated_at: at, updated_at: "2026-09-09T00:02:00.000Z", payload_json: raw,
      payload_sha256: hash(raw), payload_bytes: Buffer.byteLength(raw) };
    await check("migration preserves all seven fields and raw Unicode JSON whitespace", async () => {
      const result = await native.importPrivateModelArtifact({ pool, row });
      assert.equal(result.imported, true); assert.equal(result.payloadJson, raw);
      assert.equal(result.payloadBytes, row.payload_bytes); assert.equal(result.payloadSha256, row.payload_sha256);
      assert.equal(result.updatedAt, row.updated_at); assert.equal(result.generatedAt, row.generated_at);
      const actual = (await pool.query("SELECT payload::text AS raw FROM football.private_model_artifacts WHERE artifact_key=$1", [row.artifact_key])).rows[0];
      assert.equal(actual.raw, raw);
    });
    await check("identical import is idempotent and does not refresh audit clock", async () => {
      const result = await native.importPrivateModelArtifact({ pool, row });
      assert.equal(result.imported, false); assert.equal(result.updatedAt, row.updated_at);
    });
    await check("conflicting migration cannot overwrite newer native audit", async () => {
      await assert.rejects(native.importPrivateModelArtifact({ pool, row: { ...row, updated_at: at } }), /migration conflicts/);
      const result = await native.readPrivateModelArtifact({ pool, artifactKey: row.artifact_key });
      assert.equal(result.updatedAt, row.updated_at); assert.equal(result.payloadJson, raw);
      await assert.rejects(native.importPrivateModelArtifact({ pool, row, existingPolicy: "replace" }), /cannot override/);
    });
    await check("missing artifact fails closed", async () => {
      await assert.rejects(native.readPrivateModelArtifact({ pool, artifactKey: "absent" }), /required artifact missing/);
    });
    await check("stored hash tampering is rejected", async () => {
      await pool.query("UPDATE football.private_model_artifacts SET payload_sha256=$1 WHERE artifact_key=$2", ["0".repeat(64), key]);
      await assert.rejects(native.readPrivateModelArtifact({ pool, artifactKey: key }), /SHA-256 mismatch/);
      await pool.query("UPDATE football.private_model_artifacts SET payload_sha256=$1 WHERE artifact_key=$2", [first.payloadSha256, key]);
    });
    await check("stored size tampering is rejected", async () => {
      await pool.query("UPDATE football.private_model_artifacts SET payload_bytes=payload_bytes+1 WHERE artifact_key=$1", [key]);
      await assert.rejects(native.readPrivateModelArtifact({ pool, artifactKey: key }), /byte count mismatch/);
      await pool.query("UPDATE football.private_model_artifacts SET payload_bytes=payload_bytes-1 WHERE artifact_key=$1", [key]);
    });
    await check("invalid migration metadata rejected before connection", async () => {
      const noConnection = { connect() { throw Error("must not connect"); } };
      for (const mutation of [{ artifact_key: "bad/key" }, { payload_sha256: "0".repeat(64) },
        { payload_bytes: row.payload_bytes + 1 }, { updated_at: "yesterday" }, { artifact_version: "\n" }])
        await assert.rejects(native.importPrivateModelArtifact({ pool: noConnection, row: { ...row, ...mutation } }),
          error => !error.message.includes("must not connect"));
    });
    await check("unknown backend and PostgreSQL outage never fall back to SQLite", async () => {
      await assert.rejects(runtime.readPrivateModelArtifact({ storage: "postgre", artifactKey: key }), /invalid PRIVATE/);
      await assert.rejects(runtime.readPrivateModelArtifact({ storage: "postgres", artifactKey: key,
        pool: { query() { throw Error("synthetic PostgreSQL unavailable"); } } }), /synthetic PostgreSQL unavailable/);
    });
    await check("changed RETURNING evidence rolls the transaction back", async () => {
      await pool.query(`CREATE FUNCTION football.qa_artifact_tamper() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.payload := '{"tampered":true}'::json; RETURN NEW; END $$;
        CREATE TRIGGER qa_artifact_tamper BEFORE INSERT OR UPDATE ON football.private_model_artifacts
        FOR EACH ROW EXECUTE FUNCTION football.qa_artifact_tamper();`);
      try {
        await assert.rejects(runtime.writePrivateModelArtifact({ storage: "postgres", pool, artifactKey: key,
          payload: { ...payload, note: "new" } }), /mismatch/);
      } finally { await pool.query("DROP TRIGGER qa_artifact_tamper ON football.private_model_artifacts; DROP FUNCTION football.qa_artifact_tamper();"); }
      const restored = await native.readPrivateModelArtifact({ pool, artifactKey: key });
      assert.equal(restored.updatedAt, first.updatedAt); assert.deepEqual(restored.payload, payload);
    });
    const projection = await require("./verifyPostgresProjectionSource.cjs").verifyProjectionSource(pool);
    assert.equal(sqliteAttempts, 0);
    return { ok: true, checks, projection, sqliteAttempts, productionWrites: 0, scope: "disposable native PostgreSQL; full retirement and deployment not implied" };
  } finally { Module._load = load; await pool.end(); }
}
module.exports = { run };
if (require.main === module) run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
