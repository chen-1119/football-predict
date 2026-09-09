"use strict";
// Native PostgreSQL audit storage. Raw JSON text is hash-bound; never roundtrip
// it through jsonb or refresh historical timestamps during migration.
const crypto = require("node:crypto");
const { createPostgresPool, withPostgresTransaction } = require("../server/postgresStore.cjs");
const HARD_MAX_BYTES = 16 * 1024 * 1024;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = message => { throw new Error("PostgreSQL private artifact: " + message); };
const keyOf = value => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) fail("invalid artifact key");
  return value;
};
const maxOf = value => {
  const n = Number(value ?? HARD_MAX_BYTES);
  if (!Number.isSafeInteger(n) || n < 1024 || n > HARD_MAX_BYTES) fail("invalid maximum payload size");
  return n;
};
const isoOf = (value, label) => {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (typeof normalized !== "string" || !Number.isFinite(Date.parse(normalized))
    || new Date(normalized).toISOString() !== normalized) fail("invalid " + label);
  return normalized;
};
function verifyRow(row, artifactKey, maxBytes = HARD_MAX_BYTES) {
  const key = keyOf(artifactKey), maximum = maxOf(maxBytes);
  if (!row || row.artifact_key !== key) fail("required artifact missing or key mismatched");
  if (typeof row.artifact_version !== "string" || !row.artifact_version.trim()
    || row.artifact_version.length > 128 || /[\u0000-\u001f\u007f]/.test(row.artifact_version)) fail("invalid artifact version");
  if (typeof row.payload_json !== "string") fail("raw JSON text required");
  const bytes = Buffer.byteLength(row.payload_json), declared = Number(row.payload_bytes);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > maximum || declared !== bytes) fail("payload byte count mismatch");
  if (!/^[a-f0-9]{64}$/.test(row.payload_sha256 || "") || sha(row.payload_json) !== row.payload_sha256) fail("payload SHA-256 mismatch");
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { fail("invalid JSON payload"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("JSON object required");
  return { storage: "postgres", artifactKey: key, artifactVersion: row.artifact_version,
    generatedAt: isoOf(row.generated_at, "generatedAt"), updatedAt: isoOf(row.updated_at, "updatedAt"),
    payload, payloadJson: row.payload_json, payloadSha256: row.payload_sha256, payloadBytes: bytes,
    integrity: { hashVerified: true, sizeVerified: true } };
}
const SELECT = `SELECT artifact_key, artifact_version, generated_at, updated_at,
  payload::text AS payload_json, payload_sha256, payload_bytes
  FROM football.private_model_artifacts WHERE artifact_key = $1`;
async function usingPool(options, operation) {
  const pool = options.pool || createPostgresPool({ applicationName: "football-private-artifact" });
  try { return await operation(pool); } finally { if (!options.pool) await pool.end(); }
}
async function readPrivateModelArtifact(options) {
  const key = keyOf(options.artifactKey), maximum = maxOf(options.maxBytes);
  return usingPool(options, async pool => {
    const result = await pool.query(SELECT, [key]);
    if (result.rows.length !== 1) fail("required artifact missing");
    return verifyRow(result.rows[0], key, maximum);
  });
}
async function writePrivateModelArtifact(options) {
  const key = keyOf(options.artifactKey), maximum = maxOf(options.maxBytes);
  const payloadJson = JSON.stringify(options.payload);
  const row = { artifact_key: key, artifact_version: options.artifactVersion || options.payload?.version,
    generated_at: options.generatedAt || options.payload?.evaluatedAt || options.payload?.generatedAt,
    updated_at: new Date().toISOString(), payload_json: payloadJson,
    payload_sha256: typeof payloadJson === "string" ? sha(payloadJson) : "",
    payload_bytes: typeof payloadJson === "string" ? Buffer.byteLength(payloadJson) : 0 };
  return storeExactRow({ ...options, row, maxBytes: maximum, existingPolicy: "replace" });
}
// Migration preserves all seven original fields. Existing rows are accepted
// only when identical; an import must never overwrite a newer native write.
async function importPrivateModelArtifact(options) {
  if (options.existingPolicy !== undefined) fail("migration cannot override conflict policy");
  return storeExactRow({ ...options, existingPolicy: "identical" });
}
async function storeExactRow(options) {
  const expected = verifyRow(options.row, options.row?.artifact_key, options.maxBytes);
  return usingPool(options, pool => withPostgresTransaction(pool, async client => {
    // Coordinate with the legacy projector during staged migration.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["football-postgres-projection-sync-v1"]);
    if (options.existingPolicy === "identical") {
      const existing = await client.query(SELECT + " FOR UPDATE", [expected.artifactKey]);
      if (existing.rows.length) {
        const prior = verifyRow(existing.rows[0], expected.artifactKey, options.maxBytes);
        if (JSON.stringify(prior) !== JSON.stringify(expected)) fail("migration conflicts with existing PostgreSQL audit");
        return { ...prior, imported: false };
      }
    }
    const result = await client.query(`INSERT INTO football.private_model_artifacts
      (artifact_key, artifact_version, generated_at, updated_at, payload, payload_sha256, payload_bytes)
      VALUES ($1,$2,$3,$4,$5::json,$6,$7)
      ON CONFLICT (artifact_key) DO UPDATE SET artifact_version=EXCLUDED.artifact_version,
        generated_at=EXCLUDED.generated_at, updated_at=EXCLUDED.updated_at,
        payload=EXCLUDED.payload, payload_sha256=EXCLUDED.payload_sha256, payload_bytes=EXCLUDED.payload_bytes
      RETURNING artifact_key, artifact_version, generated_at, updated_at,
        payload::text AS payload_json, payload_sha256, payload_bytes`,
    [expected.artifactKey, expected.artifactVersion, expected.generatedAt, expected.updatedAt,
      expected.payloadJson, expected.payloadSha256, expected.payloadBytes]);
    const stored = verifyRow(result.rows[0], expected.artifactKey, options.maxBytes);
    if (JSON.stringify(stored) !== JSON.stringify(expected)) fail("transactional roundtrip changed audit evidence");
    return { ...stored, imported: options.existingPolicy === "identical" };
  }));
}
module.exports = { readPrivateModelArtifact, writePrivateModelArtifact, importPrivateModelArtifact, verifyRow };
