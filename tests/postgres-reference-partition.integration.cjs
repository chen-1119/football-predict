"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { runPostgresMigrations } = require("../server/postgresStore.cjs");
const { commitCurrentDataGeneration, CORE_FILES } = require("../server/dataGenerationBundle.cjs");
const { commitDataGeneration } = require("../server/dataGenerationStore.cjs");
const { createPostgresGenerationSource } = require("../scripts/postgresGenerationSource.cjs");
const { syncPostgresProjectionFromSource } = require("../scripts/postgresProjectionSync.cjs");
const { SOURCE_ID, INDEX_ID } = require("../server/publicReferenceArchive.cjs");
const partition = require("../server/referenceIntegrityPartition.cjs");
const originals = require("./fixtures/public-reference-unresolved-originals.json");

async function verify(pool) {
  const database = (await pool.query("SELECT current_database() AS name")).rows[0].name;
  assert(["recommendation_test", "accounts_test"].includes(database), "Disposable test DB required");
  const schema = `generation_partition_${process.pid}_${Date.now()}`;
  assert(/^generation_partition_\d+_\d+$/.test(schema));
  const mappedSql = sql => sql.replace(/\bfootball\b/g, schema);
  const query = (sql, args) => pool.query(mappedSql(sql), args);
  const mapped = { query, async connect() {
    const client = await pool.connect();
    return { query: (sql, args) => client.query(mappedSql(sql), args), release: () => client.release() };
  } };
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, "football-pg-partition-"));
  const storeDir = path.join(temporary, "store"), publicDataDir = path.join(temporary, "public");
  fs.mkdirSync(publicDataDir);
  const { fixture, trust, auditAt } = require("../scripts/verifyPublicReferencePairs.cjs");
  const complete = fixture({ id: "889101", mutateSource: source => {
    source.probabilityModel.padding = "完整原件⚽".repeat(150000);
  } });
  const second = fixture({ id: "889102" });
  const integrity = partition.buildReferenceIntegrity(originals);
  const originalJson = JSON.stringify(integrity);
  const meta = { source: "sporttery", sourceCycleId: "partition-postgres-original", updatedAt: auditAt };
  const snapshot = { version: 3, updatedAt: auditAt, rows: [],
    publicReferenceDecisions: [complete.record, second.record], publicReferenceEvidence: [complete.entry, second.entry] };
  const payloads = {
    "matches-current.json": [second.match], "matches-history.json": [], "sync-meta.json": meta,
    "external-signals.json": { updatedAt: auditAt, source: "external", matches: {} },
    "odds-history.json": { rows: [] }, "prediction-snapshots.json": snapshot,
    "model-calibration.json": { version: "partition-test", generatedAt: auditAt },
  };
  const publish = () => {
    for (const [name, payload] of Object.entries(payloads)) fs.writeFileSync(path.join(publicDataDir, name), JSON.stringify(payload));
    return commitCurrentDataGeneration({ storeDir, publicDataDir, sourceCycleId: meta.sourceCycleId, committedAt: auditAt });
  };
  const sync = (options = {}) => syncPostgresProjectionFromSource(createPostgresGenerationSource({ storeDir, publicDataDir }),
    { pool: mapped, mode: "incremental", aiArenaPath: path.join(temporary, "absent-arena.json"), ...options });
  const state = async () => {
    const result = {};
    for (const table of ["source_snapshots", "projection_meta", "projection_runs", "publications", "frozen_recommendations", "match_snapshots"]) {
      result[table] = (await query(`SELECT to_jsonb(item)::text AS row FROM football.${table} item ORDER BY to_jsonb(item)::text`)).rows;
    }
    return result;
  };
  const readIntegrity = async (client = mapped) => {
    const rows = (await client.query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id=$1", [partition.SOURCE_ID])).rows;
    assert.equal(rows.length, 1);
    const stored = JSON.parse(rows[0].payload);
    assert.equal(stored.originalJson, originalJson);
    assert.deepEqual(partition.validateStoredReferenceIntegrity(stored), integrity);
    assert.equal(JSON.parse(stored.originalJson).records.length, 29);
    return rows[0].payload;
  };
  const passed = [];
  try {
    await runPostgresMigrations(mapped);
    await query("INSERT INTO football.source_snapshots(id,source,payload) VALUES('independent:keep','test','{\"keep\":true}'::json)");
    publish();
    assert.equal((await sync()).ok, true);
    const before = await state();
    assert.equal(before.frozen_recommendations.length, 1);
    snapshot.version = 4;
    snapshot.publicReferenceIntegrity = integrity;
    payloads[partition.FILE_NAME] = integrity;
    meta.sourceCycleId += "-partitioned";
    publish();
    await assert.rejects(sync({ beforeCommit: async (client, context) => {
      assert.equal(context.skipped, false);
      await readIntegrity(client);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM football.frozen_recommendations")).rows[0].count, 1);
      throw new Error("injected-after-original-partition-projection");
    } }), /injected-after-original-partition-projection/);
    assert.deepEqual(await state(), before);
    passed.push("unresolved originals, complete pairs, publication and receipt roll back atomically on real PostgreSQL");

    assert.equal((await sync()).ok, true);
    const preservedBytes = await readIntegrity();
    const current = await state();
    const archive = (await query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id=$1", [SOURCE_ID])).rows[0].payload;
    assert(Buffer.byteLength(archive) > 1024 * 1024);
    for (const record of originals) assert.equal(archive.includes(record.contentHash), false);
    const index = JSON.parse((await query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id=$1", [INDEX_ID])).rows[0].payload);
    assert.equal(index.rowCount, 2);
    assert.equal(current.frozen_recommendations.length, 1);
    assert.equal(current.match_snapshots.length, 1);
    assert.equal((await query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id='independent:keep'")).rows[0].payload, '{"keep":true}');
    passed.push("all 29 exact original records survive separately without entering complete-pair index or frozen recommendations");
    assert.equal((await sync()).skipped, true);
    assert.deepEqual(await state(), current);
    passed.push("unchanged partitioned generation is idempotent without rewriting original bytes");
    const damagedUnchanged = JSON.parse(preservedBytes);
    damagedUnchanged.originalJson += " ";
    await query("UPDATE football.source_snapshots SET payload=$2::json WHERE id=$1", [partition.SOURCE_ID, JSON.stringify(damagedUnchanged)]);
    const damagedUnchangedState = await state();
    await assert.rejects(sync(), /REFERENCE_PARTITION_DATABASE_BYTES/);
    assert.deepEqual(await state(), damagedUnchangedState);
    await query("UPDATE football.source_snapshots SET payload=$2::json WHERE id=$1", [partition.SOURCE_ID, preservedBytes]);
    const originalStoredRow = (await query("SELECT id,source,captured_at,payload::text AS payload FROM football.source_snapshots WHERE id=$1", [partition.SOURCE_ID])).rows[0];
    await query("DELETE FROM football.source_snapshots WHERE id=$1", [partition.SOURCE_ID]);
    const missingUnchangedState = await state();
    await assert.rejects(sync(), /REFERENCE_PARTITION_DATABASE_MISSING/);
    assert.deepEqual(await state(), missingUnchangedState);
    await query("INSERT INTO football.source_snapshots(id,source,captured_at,payload) VALUES($1,$2,$3,$4::json)",
      [originalStoredRow.id, originalStoredRow.source, originalStoredRow.captured_at, originalStoredRow.payload]);
    passed.push("unchanged-source skipping cannot hide corrupt or deleted original bytes in PostgreSQL");

    snapshot.publicReferenceDecisions.shift(); snapshot.publicReferenceEvidence.shift();
    meta.sourceCycleId += "-retained";
    publish(); assert.equal((await sync()).ok, true);
    assert.equal(await readIntegrity(), preservedBytes);
    const retained = await state();
    passed.push("ordinary complete-pair retention cannot remove or rewrite any unresolved original");

    const missing = fixture({ id: "889103" });
    snapshot.publicReferenceDecisions.push(missing.record);
    meta.sourceCycleId += "-missing-new-companion";
    publish();
    await assert.rejects(sync(), /PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING/);
    assert.deepEqual(await state(), retained);
    snapshot.publicReferenceDecisions.pop();
    passed.push("a new missing companion still rejects the entire projection and leaves committed originals unchanged");

    meta.sourceCycleId += "-downgrade";
    const legacy = { ...payloads, "prediction-snapshots.json": { ...snapshot, version: 3 } };
    delete legacy[partition.FILE_NAME]; delete legacy["prediction-snapshots.json"].publicReferenceIntegrity;
    commitDataGeneration({ storeDir, sourceCycleId: meta.sourceCycleId, committedAt: auditAt, coreFiles: CORE_FILES,
      files: Object.fromEntries(Object.entries(legacy).map(([name, payload]) => [name, { bytes: JSON.stringify(payload), rows: 0 }])) });
    await assert.rejects(sync(), /REFERENCE_PARTITION_DOWNGRADE_FORBIDDEN/);
    assert.deepEqual(await state(), retained);
    passed.push("even a lower-level legacy-generation pointer switch cannot erase the PostgreSQL unresolved partition");

    meta.sourceCycleId += "-restore-partition";
    publish();
    const corrupted = JSON.parse(preservedBytes);
    corrupted.originalJson += " ";
    await query("UPDATE football.source_snapshots SET payload=$2::json WHERE id=$1", [partition.SOURCE_ID, JSON.stringify(corrupted)]);
    const corruptedState = await state();
    await assert.rejects(sync(), /REFERENCE_PARTITION_DATABASE_BYTES/);
    assert.deepEqual(await state(), corruptedState);
    passed.push("corrupted stored original bytes cannot be silently replaced by a later valid generation");
    return { ok: true, checks: passed.length, passed, scope: "loopback-disposable-schema", database, schema,
      originalRecords: 29, originalJsonBytes: Buffer.byteLength(originalJson), productionWrites: 0 };
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    trust.cleanup();
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
    assert(path.basename(resolved).startsWith("football-pg-partition-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function main() {
  const raw = process.env.POSTGRES_PARTITION_TEST_DATABASE_URL;
  assert(raw, "Explicit POSTGRES_PARTITION_TEST_DATABASE_URL required");
  const parsed = new URL(raw);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    && ["/recommendation_test", "/accounts_test"].includes(parsed.pathname), "Only loopback disposable PostgreSQL allowed");
  const { Pool } = require("pg"), pool = new Pool({ connectionString: raw, max: 4 });
  try { console.log(JSON.stringify(await verify(pool), null, 2)); } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { verify };
