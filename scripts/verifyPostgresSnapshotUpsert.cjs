"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { snapshotUpsertConflict } = require("./postgresSnapshotUpsert.cjs");
const tables = ["match_snapshots", "source_snapshots", "odds_snapshots", "prediction_snapshots", "private_model_artifacts"];
function verifySnapshotSqlContract() {
  for (const table of tables) {
    const sql = snapshotUpsertConflict(table);
    assert.ok(sql.includes("IS DISTINCT FROM ROW("));
    assert.ok(sql.includes(`${table}.payload::text`));
    assert.ok(sql.includes("EXCLUDED.payload::text"));
    assert.ok(!sql.includes("::jsonb"));
  }
  assert.throws(() => snapshotUpsertConflict("source_snapshots; DROP SCHEMA football"));
  assert.throws(() => snapshotUpsertConflict("toString"));
  return 7;
}
// Called only after the integration harness has verified an empty disposable
// local q2_evidence_* database. Every inserted test row is rolled back.
async function verifySnapshotUpsertsInPostgres(pool) {
  const client = await pool.connect();
  let checks = 0;
  const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
  const id = `synthetic-noop-${crypto.randomBytes(8).toString("hex")}`;
  const at = "2026-09-07T00:00:00.000Z";
  try {
    await client.query("BEGIN");
    for (const table of tables) {
      const key = table === "private_model_artifacts" ? "artifact_key" : "id";
      const common = { [key]: id, payload: '{"z":1,"a":2}' };
      const row = { ...common, ...({
        match_snapshots: { dataset: "current", match_id: id, source_match_id: id, kickoff_time: at, status: "SCHEDULED" },
        source_snapshots: { source: "synthetic-noop", captured_at: null },
        odds_snapshots: { state_key: id, match_id: id, source_match_id: id, pool: "HAD", bookmaker: "synthetic", handicap_line: null, captured_at: at, first_seen_at: at, last_seen_at: at, seen_count: 2 },
        prediction_snapshots: { state_key: id, match_id: id, source_match_id: id, phase: "pre", captured_at: at, first_seen_at: at, last_seen_at: at, seen_count: 2 },
        private_model_artifacts: { artifact_version: "synthetic-noop-v1", generated_at: at, updated_at: at, payload_sha256: "a".repeat(64), payload_bytes: 13 },
      })[table] };
      const insert = async values => {
        const columns = Object.keys(values);
        return client.query(`INSERT INTO football.${table} (${columns.join(",")}) VALUES (${columns.map((column, i) => `$${i + 1}${column === "payload" ? "::json" : ""}`).join(",")}) ${snapshotUpsertConflict(table)}`, columns.map(k => values[k]));
      };
      const read = async () => (await client.query(`SELECT ctid::text AS tuple, payload::text AS payload FROM football.${table} WHERE ${key}=$1`, [id])).rows[0];
      eq((await insert(row)).rowCount, 1, `${table}: new rows insert`);
      const original = await read();
      eq((await insert(row)).rowCount, 0, `${table}: unchanged upsert skips UPDATE`);
      eq(await read(), original, `${table}: unchanged tuple and exact JSON bytes preserved`);
      const reordered = { ...row, payload: '{"a":2,"z":1}' };
      eq((await insert(reordered)).rowCount, 1, `${table}: JSON key order changes must update for hash parity`);
      eq((await read()).payload, reordered.payload, `${table}: incoming JSON key order retained`);
      eq((await insert(reordered)).rowCount, 0, `${table}: reimport of reordered bytes is no-op`);
      const changed = { ...reordered, payload: '{"a":3,"z":1}' };
      eq((await insert(changed)).rowCount, 1, `${table}: actual payload change retained`);
      if (table === "source_snapshots") {
        eq((await insert({ ...changed, captured_at: at })).rowCount, 1, "null to timestamp retained");
        eq((await insert(changed)).rowCount, 1, "timestamp to null retained");
        eq((await insert(changed)).rowCount, 0, "null equals null without forced update");
      } else if (["odds_snapshots", "prediction_snapshots"].includes(table)) {
        const dominated = { ...changed, first_seen_at: "2026-09-08T00:00:00Z", last_seen_at: "2026-09-06T00:00:00Z", seen_count: 1 };
        eq((await insert(dominated)).rowCount, 0, `${table}: dominated clocks/counts do not rewrite or regress`);
        const advanced = { ...changed, first_seen_at: "2026-09-06T00:00:00Z", last_seen_at: "2026-09-08T00:00:00Z", seen_count: 3 };
        eq((await insert(advanced)).rowCount, 1, `${table}: newer evidence metadata updates`);
        eq((await insert(changed)).rowCount, 0, `${table}: older replays remain no-op after clock merge`);
        const metadata = (await client.query(`SELECT first_seen_at,last_seen_at,seen_count FROM football.${table} WHERE id=$1`, [id])).rows[0];
        eq([metadata.first_seen_at.toISOString(),metadata.last_seen_at.toISOString(),metadata.seen_count], ["2026-09-06T00:00:00.000Z","2026-09-08T00:00:00.000Z",3], `${table}: monotonic metadata preserved`);
      } else if (table === "match_snapshots") {
        eq((await insert({ ...changed, status: "FINISHED" })).rowCount, 1, "match status-only change retained");
      } else {
        eq((await insert({ ...changed, artifact_version: "synthetic-noop-v2" })).rowCount, 1, "artifact version-only change retained");
        eq((await insert({ ...changed, artifact_version: "synthetic-noop-v2", payload_sha256: "b".repeat(64) })).rowCount, 1, "artifact hash-only change retained");
      }
    }
    return { checks, tables: tables.length, scope: "real local PostgreSQL transaction, rolled back; no production writes" };
  } finally { await client.query("ROLLBACK"); client.release(); }
}
module.exports = { verifySnapshotSqlContract, verifySnapshotUpsertsInPostgres };
if (require.main === module) console.log(JSON.stringify({ ok: true, checks: verifySnapshotSqlContract(), scope: "SQL construction only; real PostgreSQL cases run in verify:evidence-native-postgres" }));
