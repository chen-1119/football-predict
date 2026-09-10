"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { Pool } = require("pg");
const { mirrorPostgresCandidate } = require("./postgresReleaseMirror.cjs");
const { openPostgresRuntimeReadSession } = require("./postgresRuntimeReadSession.cjs");
async function verifyPostgresReleaseMirror({ pool, storeDir, publicDataDir }) {
  const source = (await pool.query("SELECT current_database() AS name,host(inet_server_addr()) AS address")).rows[0];
  assert.match(source.name, /^q2_evidence_[a-z0-9_]+$/); assert.equal(source.address, "127.0.0.1");
  const name = `football_release_${crypto.randomBytes(6).toString("hex")}_${Math.floor(Date.now() / 1000)}`;
  let created = false, candidatePool, originalSourceMeta;
  const checks = [], key = crypto.randomBytes(32);
  const run = async (target = candidatePool) => {
    const session = await openPostgresRuntimeReadSession({ pool, storeDir, publicDataDir });
    try { return await mirrorPostgresCandidate({ sourceSession: session, candidatePool: target, key, expectedSourceDatabase: source.name }); }
    finally { await session.close(); }
  };
  const rows = async (target, table) => (await target.query(`SELECT row_to_json(t)::text AS raw FROM football.${table} t ORDER BY 1`)).rows;
  try {
    await pool.query(`CREATE DATABASE "${name}"`); created = true;
    const url = new URL(process.env.EVIDENCE_TEST_POSTGRES_URL); url.pathname = "/" + name;
    candidatePool = new Pool({ connectionString: url.href, ssl: false, max: 1 });
    await require("../server/postgresStore.cjs").runPostgresMigrations(candidatePool);
    // Empty-table and generated-column handling, raw text whitespace, original
    // clocks, bytea and composite primary keys are all real PostgreSQL values.
    await pool.query("INSERT INTO football.formal_review_daily(business_date,won,lost,source_revision) VALUES('2026-09-01',3,2,'qa')");
    await pool.query("INSERT INTO football.learning_model_artifacts(artifact_hash,artifact_type,media_type,artifact_bytes,byte_length,created_at,metadata_json,metadata_hash) VALUES($1,'candidate','application/octet-stream',$2,4,'2026-09-01T00:00:00.000Z',' {\"note\":\"原始\"} ',$3)", ["a".repeat(64), Buffer.from([0, 255, 12, 64]), "c".repeat(64)]);
    await pool.query("INSERT INTO football.research_source_contents(source_url,content_hash,raw,first_received_at,first_receipt_hash) VALUES($1,$2,$3,$4,$5)", ["https://example.invalid/含空格 a", "b".repeat(64), Buffer.from("[ ]"), "2026-09-01T00:00:00.000Z", "d".repeat(64)]);
    await pool.query("INSERT INTO football.data_source_conflicts(conflict_id,conflict_type,source_keys,payload) VALUES('qa-mirror-arrays','synthetic',$1,'{}')", [["a,b", '引号"和值']]);
    const first = await run(); assert.equal(first.mode, "full-seed"); assert.ok(first.copiedRows > 0);
    for (const table of ["prediction_snapshots", "learning_model_artifacts", "research_source_contents", "formal_review_daily", "data_source_conflicts"])
      assert.deepEqual(await rows(candidatePool, table), await rows(pool, table));
    checks.push({ name: "cold mirror preserves raw JSON, bytea, composite keys, generated totals and original clocks in an independent database", ok: true });
    const warm = await run(); assert.equal(warm.mode, "incremental"); assert.equal(warm.copiedRows, 0); assert.equal(warm.copiedPayloadBytes, 0); assert.equal(warm.removedCandidateRows, 0);
    checks.push({ name: "unchanged warm candidate reads transaction identities only and copies zero payload bytes", ok: true });
    const before = await rows(pool, "prediction_snapshots");
    await candidatePool.query("UPDATE football.prediction_snapshots SET payload='{\"tipCode\":\"1\"}'::json");
    const repaired = await run(); assert.equal(repaired.copiedRows, 1);
    assert.deepEqual(await rows(candidatePool, "prediction_snapshots"), before); assert.deepEqual(await rows(pool, "prediction_snapshots"), before);
    checks.push({ name: "candidate-only changed draw is replaced from original source without touching production or trusting old capture clocks", ok: true });
    originalSourceMeta = (await pool.query("SELECT payload::text AS raw FROM football.source_snapshots WHERE id='sync-meta:current'")).rows[0].raw;
    await pool.query("UPDATE football.source_snapshots SET payload='{ \"oldClockNewContent\": true }'::json WHERE id='sync-meta:current'");
    const changed = await run(); assert.equal(changed.copiedRows, 1);
    assert.deepEqual(await rows(candidatePool, "source_snapshots"), await rows(pool, "source_snapshots"));
    await candidatePool.query("INSERT INTO football.projection_meta(key,value,updated_at) VALUES('qa-extra','remove-me',now())");
    const deleted = await run(); assert.equal(deleted.removedCandidateRows, 1); assert.equal(deleted.copiedRows, 0);
    checks.push({ name: "same-clock source updates transfer only changed rows and candidate-only rows are removed", ok: true });
    const snapshot = await openPostgresRuntimeReadSession({ pool, storeDir, publicDataDir });
    const concurrent = new Pool({ connectionString: process.env.EVIDENCE_TEST_POSTGRES_URL, ssl: false, max: 1 });
    const sourceBeforeConcurrent = await rows(concurrent, "source_snapshots");
    try {
      await concurrent.query("UPDATE football.source_snapshots SET payload='{\"concurrent\":true}'::json WHERE id='sync-meta:current'");
      const frozen = await mirrorPostgresCandidate({ sourceSession: snapshot, candidatePool, key, expectedSourceDatabase: source.name });
      assert.equal(frozen.copiedRows, 0); assert.deepEqual(await rows(candidatePool, "source_snapshots"), sourceBeforeConcurrent);
    } finally { await snapshot.close(); await concurrent.end(); }
    assert.equal((await run()).copiedRows, 1);
    checks.push({ name: "concurrent source updates cannot mix a candidate snapshot; the next pass advances exactly one row", ok: true });
    const originalHead = (await candidatePool.query("SELECT payload,mac FROM football_release_private.mirror_head")).rows[0];
    await candidatePool.query("UPDATE football_release_private.mirror_head SET mac=$1", ["0".repeat(64)]);
    await assert.rejects(run(), /head authentication failed/);
    await candidatePool.query("UPDATE football_release_private.mirror_head SET mac=$1", [originalHead.mac]);
    const originalState = (await candidatePool.query("SELECT * FROM football_release_private.mirror_rows LIMIT 1")).rows[0];
    await candidatePool.query("UPDATE football_release_private.mirror_rows SET mac=$1 WHERE table_name=$2 AND key_json=$3", ["0".repeat(64), originalState.table_name, originalState.key_json]);
    await assert.rejects(run(), /row authentication failed/);
    await candidatePool.query("UPDATE football_release_private.mirror_rows SET mac=$1 WHERE table_name=$2 AND key_json=$3", [originalState.mac, originalState.table_name, originalState.key_json]);
    await assert.rejects(run(pool), /independent candidate database required/);
    const otherConnectionToSource = new Pool({ connectionString: process.env.EVIDENCE_TEST_POSTGRES_URL, ssl: false, max: 1 });
    try { await assert.rejects(run(otherConnectionToSource), /independent candidate database required/); }
    finally { await otherConnectionToSource.end(); }
    checks.push({ name: "unauthenticated mirror receipts and a production database target are refused", ok: true });
    const forged = { ...JSON.parse((await candidatePool.query("SELECT payload FROM football_release_private.mirror_head")).rows[0].payload), sourceTx: "999999999999" };
    await candidatePool.query("UPDATE football_release_private.mirror_head SET payload=$1,mac=$2", [JSON.stringify(forged), crypto.createHmac("sha256", key).update(JSON.stringify(forged)).digest("hex")]);
    const reseeded = await run(); assert.equal(reseeded.mode, "full-seed"); assert.equal(reseeded.copiedRows, reseeded.inspectedRows);
    checks.push({ name: "transaction identity horizon changes force exact reseeding instead of unsafe xmin reuse", ok: true });
    return { ok: true, checks, productionWrites: 0, candidateDatabaseIsolated: true, warmCopiedPayloadBytes: warm.copiedPayloadBytes };
  } finally {
    // These three rows were created by this isolated test only.
    if (originalSourceMeta !== undefined) await pool.query("UPDATE football.source_snapshots SET payload=$1::json WHERE id='sync-meta:current'", [originalSourceMeta]);
    await pool.query("DELETE FROM football.formal_review_daily WHERE business_date='2026-09-01'; DELETE FROM football.learning_model_artifacts WHERE artifact_hash='" + "a".repeat(64) + "'; DELETE FROM football.research_source_contents WHERE content_hash='" + "b".repeat(64) + "';");
    await pool.query("DELETE FROM football.data_source_conflicts WHERE conflict_id='qa-mirror-arrays'");
    if (candidatePool) await candidatePool.end();
    if (created) { assert.match(name, /^football_release_[a-f0-9]{12}_[0-9]{1,10}$/); await pool.query(`DROP DATABASE "${name}"`); }
  }
}
module.exports = { verifyPostgresReleaseMirror };
