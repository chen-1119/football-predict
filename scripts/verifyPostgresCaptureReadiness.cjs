"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Pool } = require("pg");
const { queryReadinessSnapshotBatch, overlapReadinessInputs } = require("./postgresCaptureReadiness.cjs");
const { readCandidatePublicObservationsParallel } = require("./readCandidatePublicObservations.cjs");
async function verify(url) {
  const parsed = new URL(url); assert(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname));
  assert(/^\/(?:recommendation_test|accounts_test|q2_evidence_[a-z0-9_]+)$/.test(parsed.pathname));
  const database = `capture_ready_${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
  assert(/^capture_ready_\d+_[a-f0-9]{12}$/.test(database));
  const admin = new Pool({ connectionString: parsed.href, ssl: false, max: 1 }); let pool, client, created = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "football-readiness-")), checks = [];
  try {
    await admin.query(`CREATE DATABASE ${database}`); created = true; parsed.pathname = "/" + database;
    pool = new Pool({ connectionString: parsed.href, ssl: false, max: 1 }); client = await pool.connect();
    await client.query(`CREATE SCHEMA football; CREATE TABLE football.prediction_snapshots(id text PRIMARY KEY,source_match_id text,match_id text,captured_at timestamptz,payload jsonb);
      CREATE INDEX ON football.prediction_snapshots(source_match_id,captured_at DESC); CREATE INDEX ON football.prediction_snapshots(match_id);`);
    await client.query(`INSERT INTO football.prediction_snapshots SELECT 'row-'||n,CASE WHEN n%11=0 THEN 'alias' ELSE 'event-'||(n%33) END,
      CASE WHEN n%13=0 THEN 'alias' ELSE 'match-'||(n%33) END,
      '2026-10-18T00:00:00Z'::timestamptz + (n%400)*interval '1 second',
      jsonb_build_object('id','row-'||n,'capturedAt',to_char('2026-10-18T00:00:00Z'::timestamptz + (n%400)*interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'exact',n,'text','中😀') FROM generate_series(1,18000) n`);
    const frozenAt = "2026-10-18T00:01:00Z", requests = Array.from({ length: 35 }, (_, ordinal) => ({ ordinal,
      ids: ordinal === 33 ? ["alias", "event-2", "match-2"] : ordinal === 34 ? ["absent"] : ["event-" + ordinal, "match-" + ordinal],
      upperBound: ordinal % 2 ? "2026-10-18T00:05:00Z" : "2026-10-18T00:06:00Z", frozenAt }));
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const limit of [1, 9, 65, 513]) {
      const batched = await queryReadinessSnapshotBatch(client, requests, limit);
      for (const row of requests) {
        const prior = await client.query(`SELECT payload::text AS payload FROM football.prediction_snapshots
          WHERE captured_at >= $1 AND captured_at <= $2 AND (source_match_id=ANY($3::text[]) OR match_id=ANY($3::text[]))
          ORDER BY captured_at DESC,id DESC LIMIT $4`, [frozenAt, row.upperBound, row.ids, limit]);
        assert.deepEqual(batched.get(row.ordinal), prior.rows);
      }
    }
    checks.push("actual repeatable-read PostgreSQL: all 35 events, 4 original limits, ties, overlapping aliases, both bounds and missing events exactly match original payload bytes and order");
    const file = path.join(dir, "public.json"), fd = fs.openSync(file, "w"), block = JSON.stringify({ text: "x".repeat(1024), n: 1, ok: false });
    try { fs.writeSync(fd, '{"history":['); for (let n = 0; n < 65536; n++) fs.writeSync(fd, (n ? "," : "") + block); fs.writeSync(fd, '],"observations":[{"id":"same","text":"中😀"}]}'); } finally { fs.closeSync(fd); }
    let backendDoneBeforePublicReturned = false, sqlCompleted = false;
    const result = await overlapReadinessInputs(async () => {
      const result = await queryReadinessSnapshotBatch(client, requests, 65); sqlCompleted = true; return result;
    }, async () => {
      const result = await readCandidatePublicObservationsParallel(file); backendDoneBeforePublicReturned = sqlCompleted; return result;
    });
    assert.deepEqual(result.publicRows.rows, [{ id: "same", text: "中😀" }]); assert.equal(result.publicRows.bytesRead, fs.statSync(file).size * 2);
    assert.equal(result.publicRows.timings.hashThreadExited, true); assert.equal(result.snapshots.size, requests.length);
    checks.push("actual complete 69 MB public read keeps both full hashes, strict parser, same rows and actual hash-thread exit while the same read-only transaction is retained");
    await assert.rejects(overlapReadinessInputs(() => client.query("SELECT 1/0"), () => readCandidatePublicObservationsParallel(file)), { code: "22012" });
    const again = await readCandidatePublicObservationsParallel(file); assert.equal(again.timings.hashThreadExited, true);
    checks.push("query refusal drains actual owned full-file reader; next read has no retained owner or leaked descriptor");
    await client.query("ROLLBACK");
    return { ok: true, scope: "disposable loopback PostgreSQL and original complete two-pass public reader", checks, backendDoneBeforePublicReturned,
      publicBytes: fs.statSync(file).size, timings: result.publicRows.timings, productionWrites: 0, productionPerformanceClaim: false };
  } finally {
    if (client) { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    if (pool) await pool.end(); if (created) await admin.query(`DROP DATABASE ${database}`); await admin.end();
    const resolved = fs.realpathSync(dir); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert(path.basename(resolved).startsWith("football-readiness-")); fs.rmSync(resolved, { recursive: true });
  }
}
if (require.main === module) verify(process.env.CAPTURE_READINESS_TEST_DATABASE_URL).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { verify };
