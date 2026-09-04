const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  HHAD_COMPANION_AUDIT_KEY,
  PRIVATE_MODEL_ARTIFACT_TABLE,
  assertPrivateModelArtifactTable,
  ensurePrivateModelArtifactTable,
  readPrivateModelArtifact,
  writePrivateModelArtifact,
} = require("./privateModelArtifactStore.cjs");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-private-model-artifact-"));
const dbPath = path.join(tempDir, "football.db");
const generatedAt = "2026-07-13T06:00:00.000Z";
const payload = {
  version: "hhad-companion-shadow-evaluation-v1",
  evaluatedAt: generatedAt,
  counts: { finalRevisions: 1, settlementRows: 1 },
  finalExposureRows: [{ matchId: "fixture-1", tip: "1" }],
  settlementRows: [{ matchId: "fixture-1", status: "won" }],
};

try {
  let db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  ensurePrivateModelArtifactTable(db);
  assert.equal(assertPrivateModelArtifactTable(db), true);
  db.close();

  const first = writePrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
    artifactVersion: payload.version,
    generatedAt,
    payload,
    busyTimeoutMs: 500,
  });
  assert.equal(first.integrity.hashVerified, true);
  assert.equal(first.integrity.sizeVerified, true);
  assert.match(first.payloadSha256, /^[0-9a-f]{64}$/);

  const firstRead = readPrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
    busyTimeoutMs: 500,
  });
  assert.deepEqual(firstRead.payload, payload);
  assert.equal(firstRead.payloadSha256, first.payloadSha256);

  const updatedPayload = {
    ...payload,
    counts: { finalRevisions: 2, settlementRows: 1 },
    finalExposureRows: [...payload.finalExposureRows, { matchId: "fixture-2", tip: "0" }],
  };
  writePrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
    artifactVersion: updatedPayload.version,
    generatedAt,
    payload: updatedPayload,
  });
  db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${PRIVATE_MODEL_ARTIFACT_TABLE}`).get().count, 1,
    "upsert must retain one keyed row");
  db.close();

  assert.throws(() => readPrivateModelArtifact({
    dbPath,
    artifactKey: "missing-private-artifact",
  }), /required artifact is missing/);
  assert.throws(() => writePrivateModelArtifact({
    dbPath,
    artifactKey: "oversized-private-artifact",
    artifactVersion: "fixture-v1",
    generatedAt,
    payload: { version: "fixture-v1", generatedAt, padding: "x".repeat(2048) },
    maxBytes: 1024,
  }), /exceeds the 1024-byte limit/);

  const lock = new DatabaseSync(dbPath);
  lock.exec("BEGIN IMMEDIATE");
  assert.throws(() => writePrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
    artifactVersion: payload.version,
    generatedAt,
    payload,
    busyTimeoutMs: 100,
  }), /transactional upsert failed/);
  lock.exec("ROLLBACK");
  lock.close();
  assert.deepEqual(readPrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
  }).payload, updatedPayload, "a busy write must leave the previous committed row intact");

  db = new DatabaseSync(dbPath);
  const tamperedJson = JSON.stringify({ ...updatedPayload, counts: { finalRevisions: 999 } });
  db.prepare(`
    UPDATE ${PRIVATE_MODEL_ARTIFACT_TABLE}
    SET payload_json = ?, payload_bytes = ?
    WHERE artifact_key = ?
  `).run(tamperedJson, Buffer.byteLength(tamperedJson), HHAD_COMPANION_AUDIT_KEY);
  db.close();
  assert.throws(() => readPrivateModelArtifact({
    dbPath,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
  }), /SHA-256 mismatch/, "payload tampering must fail closed");

  console.log(JSON.stringify({
    ok: true,
    checks: 12,
    table: PRIVATE_MODEL_ARTIFACT_TABLE,
    artifactKey: HHAD_COMPANION_AUDIT_KEY,
    payloadBytes: first.payloadBytes,
    payloadSha256: first.payloadSha256,
  }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
