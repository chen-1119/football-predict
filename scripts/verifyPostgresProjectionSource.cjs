"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path"), os = require("node:os");
const { syncPostgresProjectionFromSource } = require("./postgresProjectionSync.cjs");
// Invoked by the audit suite only after it proves an empty disposable database
// and blocks all SQLite module loads. These are direct synthetic row sources,
// not a claim that the live generation producer has already been migrated.
async function verifyProjectionSource(pool) {
  const checks = [], at = "2026-09-09T00:01:00.000Z";
  const sha = x => crypto.createHash("sha256").update(x).digest("hex");
  const publication = { mode: "active-generation", generationId: "g-" + sha("synthetic-generation"),
    manifestHash: sha("synthetic-manifest"), sourceCycleId: "synthetic-native-cycle", committedAt: at };
  const source = ({ revision = 1, failFinal = false } = {}) => {
    const match = { id: "synthetic-native-match", sourceMatchId: "synthetic-native", status: "SCHEDULED", kickoffTime: at };
    const rows = {
      match_snapshots: [{ id: "current:" + match.id, dataset: "current", match_id: match.id,
        source_match_id: match.sourceMatchId, kickoff_time: at, status: match.status, payload: JSON.stringify(match) }],
      source_snapshots: [{ id: "public-reference-decisions:current", source: "sporttery:public-reference-index",
        captured_at: at, payload: JSON.stringify({ revision, note: "native raw JSON" }, null, 2) }],
      odds_snapshots: [], prediction_snapshots: [],
    };
    let closed = false, validated = 0;
    return { kind: "native-generation", path: "generation:" + publication.generationId, bytes: 0,
      publication, fingerprint: sha(JSON.stringify(rows)),
      meta: Object.fromEntries(Object.entries({ data_publication_mode: publication.mode,
        data_generation_id: publication.generationId, manifest_hash: publication.manifestHash,
        data_generation_source_cycle_id: publication.sourceCycleId, committed_at: at, exported_at: at })
        .map(([key, value]) => [key, { key, value, updated_at: at }])),
      tableRows(table) { assert.ok(!closed); assert.ok(Object.hasOwn(rows, table)); return rows[table]; },
      activeIds(table) { return rows[table].map(r => r.id); }, hasPrivateAudit() { return false; },
      assertUnchanged() { validated++; if (failFinal && validated > 1) throw Error("native source changed before commit"); },
      close() { assert.equal(closed, false); closed = true; }, state() { return { closed, validated }; }, rows,
    };
  };
  const options = { pool, mode: "backfill", aiArenaPath: path.join(os.tmpdir(), crypto.randomBytes(12).toString("hex") + ".absent.json") };
  const first = source(), result = await syncPostgresProjectionFromSource(first, options);
  assert.equal(result.ok, true); assert.equal(result.rowCounts.match_snapshots, 1);
  assert.equal(result.rowCounts.source_snapshots, 1); assert.equal(first.state().closed, true);
  const stored = (await pool.query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id='public-reference-decisions:current'")).rows[0];
  assert.equal(stored.payload, first.rows.source_snapshots[0].payload);
  checks.push({ name: "direct row source writes raw JSON without a SQLite database", ok: true });
  const record = (await pool.query("SELECT payload FROM football.projection_runs WHERE run_id=$1", [result.runId])).rows[0];
  assert.equal(record.payload.sourceKind, "native-generation"); assert.equal(record.payload.sqliteBytes, 0);
  checks.push({ name: "publication receipt reports native source and zero SQLite bytes", ok: true });
  const same = source(), skipped = await syncPostgresProjectionFromSource(same, { ...options, mode: "incremental" });
  assert.equal(skipped.skipped, true); assert.equal(same.state().closed, true);
  assert.equal(same.state().validated, 2);
  checks.push({ name: "identical source skips work but validates and closes source", ok: true });
  const changed = source({ revision: 2 });
  const updated = await syncPostgresProjectionFromSource(changed, { ...options, mode: "incremental" });
  assert.equal(updated.skipped, false);
  assert.equal((await pool.query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id='public-reference-decisions:current'")).rows[0].payload,
    changed.rows.source_snapshots[0].payload);
  checks.push({ name: "incremental path keeps old-clock public reference updates", ok: true });
  const before = (await pool.query("SELECT run_id FROM football.projection_runs ORDER BY committed_at DESC,run_id DESC LIMIT 1")).rows[0].run_id;
  const invalidated = source({ revision: 3, failFinal: true });
  await assert.rejects(syncPostgresProjectionFromSource(invalidated, options), /native source changed before commit/);
  assert.equal(invalidated.state().closed, true);
  assert.equal((await pool.query("SELECT run_id FROM football.projection_runs ORDER BY committed_at DESC,run_id DESC LIMIT 1")).rows[0].run_id, before);
  assert.equal((await pool.query("SELECT payload::text AS payload FROM football.source_snapshots WHERE id='public-reference-decisions:current'")).rows[0].payload,
    changed.rows.source_snapshots[0].payload);
  checks.push({ name: "source invalidation rolls back rows and release receipt atomically", ok: true });
  await assert.rejects(syncPostgresProjectionFromSource({ kind: "unknown" }, options), /invalid complete/);
  checks.push({ name: "unknown or incomplete source is rejected", ok: true });
  return { ok: true, checks, scope: "real PostgreSQL writer with synthetic native source provider; live producer and cutover still required" };
}
module.exports = { verifyProjectionSource };
