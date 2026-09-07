"use strict";
// Synthetic fixtures only. Exercise actual SQLite reads without production files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { bindPublicReferenceDecision: bind, pendingPublicReferenceEvidence: pending } = require("../src/services/publicReferenceDecision.cjs");
const { digest } = require("../src/services/publicReferenceEvidence.cjs");
const { buildPublicReferenceArchive: archive, buildPublicReferenceIndex: build, resolveIndexedPublicReferenceEvidence: resolve,
  resolvePublicReferenceEvidence: originalResolve, INDEX_ID, SOURCE_ID, MAX_AUDIT_BYTES } = require("../server/publicReferenceArchive.cjs");
const { readSqlitePublicReferenceEvidence: read } = require("../server/sqliteStore.cjs");
let checks = 0;
const test = (name, fn) => { try { fn(); checks++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };
const clone = value => JSON.parse(JSON.stringify(value));
const at = "2026-09-07T01:00:00.000Z", kickoff = "2026-09-07T12:00:00.000Z";
function fixture(id, padding = "") {
  const sourceMatchId = String(991001 + id);
  const published = bind({ id: `sporttery_${sourceMatchId}`, sourceMatchId, status: "SCHEDULED", businessDate: "2026-09-07",
    kickoffTime: kickoff, eventVersion: kickoff, buyEndTime: "2026-09-07T11:55:00.000Z",
    odds: { odds1: 2, oddsX: 3.4, odds2: 4 },
    predictions: [{ marketType: "BEST", recommendationAction: "reference", oddsPoolCode: "HAD", tipCode: "X", odds: 3.4 }],
    predictionMeta: { generatedAt: at, decisionId: `synthetic-index-${id}`, modelVersion: "synthetic", policyVersion: "synthetic",
      featureSnapshot: { version: "synthetic", capturedAt: at, sourceMatchId, kickoffTime: kickoff, modelInputs: { padding } } },
    probabilityModel: { version: "synthetic", generatedAt: at, oneXTwo: { final: { home: 35, draw: 40, away: 25 } } },
  }, null, "2026-09-07T01:00:01.000Z");
  return { record: published.predictionMeta.publicReferenceDecision, entry: pending(published) };
}
const pack = fixtures => archive({ publicReferenceDecisions: fixtures.map(f => f.record), publicReferenceEvidence: fixtures.map(f => f.entry).filter(Boolean) });
for (const count of [0, 1, 2, 3, 5, 8, 9]) test(`membership and exact response parity for ${count} rows`, () => {
  const source = pack(Array.from({ length: count }, (_, i) => fixture(i))), index = build(source);
  assert.equal(index.manifest.rowCount, count);
  for (const shard of index.shards) assert.deepEqual(resolve(index.manifest, shard.payload, shard.payload.record.contentHash), originalResolve(source, shard.payload.record.contentHash));
  assert.equal(resolve(index.manifest, null, "f".repeat(64)).reason, "reference-not-found");
  assert.equal(digest(source.rows), source.contentHash);
});
const source = pack([fixture(0), fixture(1), fixture(2)]), index = build(source);
const first = index.shards[0].payload, hash = first.record.contentHash;
for (const [name, change] of [
  ["wrong index", shard => { shard.index = 2; }],
  ["wrong sibling", shard => { shard.proof[0] = "f".repeat(64); }],
  ["short proof", shard => { shard.proof.pop(); }],
  ["changed direction", shard => { shard.record.prediction.tipCode = "1"; }],
  ["changed private model", shard => { shard.entry.evidence.probabilityModel.version = "tampered"; }],
  ["cross generation manifest", shard => { shard.manifestHash = "f".repeat(64); }],
]) test(name, () => { const bad = clone(first); change(bad); assert.equal(resolve(index.manifest, bad, hash).ok, false); });
test("manifest tampering rejected", () => { const bad = clone(index.manifest); bad.rowCount++; assert.equal(resolve(bad, first, hash).reason, "archive-integrity-invalid"); });
test("invalid hash and absent manifest fail closed", () => {
  assert.equal(resolve(index.manifest, first, "bad").reason, "invalid-reference-hash");
  assert.equal(resolve(null, first, hash).reason, "archive-unavailable");
  assert.equal(build(null), null);
});
test("duplicates and corrupt original archive rejected before projection", () => {
  const bad = clone(source); bad.rows.push(bad.rows[0]); bad.contentHash = digest(bad.rows);
  assert.throws(() => build(bad), /RECORD_INVALID/);
  const duplicate = clone(source); duplicate.evidence.push(duplicate.evidence[0]); duplicate.evidenceContentHash = digest(duplicate.evidence);
  assert.throws(() => build(duplicate), /DUPLICATE_EVIDENCE/);
  const corrupt = clone(source); corrupt.rows[0].prediction.tipCode = "1";
  assert.throws(() => build(corrupt), /ARCHIVE_INVALID/);
});
test("legacy records remain without retroactive evidence", () => {
  const { evidenceBinding, contentHash, integrityVerified, ...old } = fixture(0).record;
  old.version = "public-reference-decision-v1"; old.contentHash = digest(old);
  const legacy = build(pack([{ record: old }]));
  assert.equal(resolve(legacy.manifest, legacy.shards[0].payload, old.contentHash).reason, "evidence-not-recorded");
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "football-reference-index-"));
let db, scale;
try {
  const dbPath = path.join(temp, "synthetic.db"); db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE source_snapshots (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);");
  const identity = { mode: "active-generation", generationId: `g-${"a".repeat(64)}`, manifestHash: "b".repeat(64), sourceCycleId: "synthetic-index", committedAt: at };
  const meta = { data_publication_mode: identity.mode, data_generation_id: identity.generationId, manifest_hash: identity.manifestHash,
    data_generation_source_cycle_id: identity.sourceCycleId, committed_at: at };
  for (const [key, value] of Object.entries(meta)) db.prepare("INSERT INTO schema_meta VALUES (?, ?, ?)").run(key, value, at);
  const put = db.prepare("INSERT INTO source_snapshots VALUES (?, ?)");
  test("actual SQLite indexed query works beyond old 32 MiB archive cap", () => {
    const large = pack(Array.from({ length: 34 }, (_, i) => fixture(i, "x".repeat(1024 * 1024))));
    const archiveText = JSON.stringify(large), archiveBytes = Buffer.byteLength(archiveText);
    assert.ok(archiveBytes > MAX_AUDIT_BYTES);
    const started = performance.now(), built = build(large), buildMs = performance.now() - started;
    put.run(SOURCE_ID, archiveText); put.run(INDEX_ID, JSON.stringify(built.manifest));
    for (const row of built.shards) put.run(row.id, JSON.stringify(row.payload));
    const target = built.shards[17], selectedBytes = Buffer.byteLength(JSON.stringify(target.payload)) + Buffer.byteLength(JSON.stringify(built.manifest));
    assert.ok(selectedBytes < 2 * 1024 * 1024);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT payload FROM source_snapshots WHERE id = ? AND length(CAST(payload AS BLOB)) <= ? LIMIT 1").all(target.id, MAX_AUDIT_BYTES);
    assert.ok(plan.some(row => /SEARCH.*USING INDEX/.test(row.detail)));
    const before = performance.now(), result = read(dbPath, { publicationIdentity: identity, referenceHash: target.payload.record.contentHash });
    const readMs = performance.now() - before;
    assert.equal(result.ok, true, JSON.stringify({ reason: result.reason, publication: result.publication })); assert.deepEqual(result.record, target.payload.record);
    assert.equal(result.evidence.featureSnapshot.modelInputs.padding.length, 1024 * 1024);
    scale = { rows: 34, archiveBytes, selectedBytes, buildMs: Math.round(buildMs), readMs: Math.round(readMs), queryPlan: plan.map(row => row.detail) };
  });
} finally {
  db?.close();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("football-reference-index-")) throw new Error("unsafe fixture cleanup");
  fs.rmSync(resolved, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, checks, scale, scope: "synthetic SQLite; not production or PostgreSQL; membership is not independent source attestation" }, null, 2));
