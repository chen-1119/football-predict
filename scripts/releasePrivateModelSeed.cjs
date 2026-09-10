"use strict";
// Release-only transport of an already verified private audit. Never creates
// new model evidence, changes its clock, or authorizes model promotion.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { HHAD_COMPANION_AUDIT_KEY: KEY } = require("./runtimePrivateModelArtifactStore.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const columns = ["artifact_key", "artifact_version", "generated_at", "updated_at", "payload_json", "payload_sha256", "payload_bytes"];
function directory(value) {
  const resolved = path.resolve(value);
  for (let dir = resolved;; dir = path.dirname(dir)) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-private-seed-directory");
    if (dir === path.dirname(dir)) break;
  }
  return resolved;
}
function plain(file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (optional && e.code === "ENOENT") return null; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe-private-seed-file");
  return stat;
}
function databasePath(storeDir) {
  const file = path.join(directory(storeDir), "football.db");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) plain(file + suffix, true);
  return file;
}
function evaluationBytes(storeDir) {
  const dir = directory(path.join(storeDir, "model-artifacts")), file = path.join(dir, "evaluation.json");
  const before = plain(file);
  if (before.size <= 0 || before.size > 64 * 1024 * 1024) throw new Error("private-seed-evaluation-size");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = plain(file);
    if (opened.ino !== before.ino || after.ino !== before.ino || bytes.length !== before.size
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("private-seed-evaluation-changed");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function validateReusablePrivateAudit({ storeDir, evaluation = null }) {
  const { readPrivateModelArtifact } = require("./privateModelArtifactStore.cjs");
  const dbPath = databasePath(storeDir);
  evaluation = evaluation || JSON.parse(evaluationBytes(storeDir));
  const record = readPrivateModelArtifact({ dbPath, artifactKey: KEY, busyTimeoutMs: 1000 });
  return validateAuditEvaluation(record, evaluation);
}
function validateAuditEvaluation(record, evaluation) {
  const { finalExposureRows, settlementRows, ...aggregate } = record.payload;
  if (record.artifactVersion !== aggregate.version || record.generatedAt !== aggregate.evaluatedAt
    || !Array.isArray(finalExposureRows) || !Array.isArray(settlementRows)
    || finalExposureRows.length !== Number(aggregate.counts?.finalRevisions || 0)
    || settlementRows.length !== Number(aggregate.counts?.settlementRows || 0)
    || !aggregate.version || !aggregate.gate
    || JSON.stringify(aggregate) !== JSON.stringify(evaluation?.hhadCompanionEvaluation)
    || JSON.stringify(evaluation?.sample?.hhadCompanion || null) !== JSON.stringify(aggregate.counts || null))
    throw new Error("private-seed-audit-evaluation-mismatch");
  return record;
}
function seedPrivateModelAudit({ sourceStore, candidateStore }) {
  const { DatabaseSync } = require("node:sqlite");
  const { PRIVATE_MODEL_ARTIFACT_TABLE: TABLE, ensurePrivateModelArtifactTable } = require("./privateModelArtifactStore.cjs");
  sourceStore = directory(sourceStore); candidateStore = directory(candidateStore);
  if (sourceStore === candidateStore || sourceStore.startsWith(candidateStore + path.sep)
    || candidateStore.startsWith(sourceStore + path.sep)) throw new Error("private-seed-stores-overlap");
  const sourceDb = databasePath(sourceStore), targetDb = databasePath(candidateStore);
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (plain(targetDb + suffix, true)) throw new Error("private-seed-destination-already-exists");
  let verified, row;
  try {
    // Candidate JSON was copied in the same stopped-worker/cache barrier.
    // Compare against it, never silently substitute newer live model JSON.
    const evaluation = JSON.parse(evaluationBytes(candidateStore));
    verified = validateReusablePrivateAudit({ storeDir: sourceStore, evaluation });
    const db = new DatabaseSync(sourceDb, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 1000; BEGIN");
      row = db.prepare(`SELECT ${columns.join(",")} FROM ${TABLE} WHERE artifact_key = ?`).get(KEY);
      db.exec("COMMIT");
    } finally { db.close(); }
    if (!row || row.artifact_key !== verified.artifactKey || row.artifact_version !== verified.artifactVersion
      || row.generated_at !== verified.generatedAt || row.updated_at !== verified.updatedAt
      || row.payload_bytes !== verified.payloadBytes || row.payload_sha256 !== verified.payloadSha256
      || Buffer.byteLength(row.payload_json, "utf8") !== verified.payloadBytes
      || hash(row.payload_json) !== verified.payloadSha256) throw new Error("private-seed-source-changed");
    const after = validateReusablePrivateAudit({ storeDir: sourceStore, evaluation });
    if (after.payloadSha256 !== verified.payloadSha256 || after.updatedAt !== verified.updatedAt
      || after.artifactVersion !== verified.artifactVersion || after.generatedAt !== verified.generatedAt)
      throw new Error("private-seed-source-changed");
  } catch (error) {
    // Incomplete legacy evidence requires a real backtest, not a fake empty
    // audit or an unconditional release failure. Destination remains absent.
    if (String(error.message).startsWith("unsafe-private-seed")) throw error;
    return { mode: "recompute", reason: String(error.code || error.message).slice(0, 160), seeded: false };
  }
  const fd = fs.openSync(targetDb, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0), 0o600);
  fs.closeSync(fd);
  // Only the new disposable candidate is writable. Preserve all seven source
  // columns, including exact JSON bytes and updated_at (no upsert/restamping).
  const db = new DatabaseSync(targetDb);
  try {
    db.exec("PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE");
    ensurePrivateModelArtifactTable(db);
    db.prepare(`INSERT INTO ${TABLE} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map(name => row[name]));
    db.exec("COMMIT");
  } finally { db.close(); }
  const result = validateReusablePrivateAudit({ storeDir: candidateStore });
  if (result.payloadSha256 !== verified.payloadSha256 || result.updatedAt !== verified.updatedAt)
    throw new Error("private-seed-copy-verification-failed");
  return { mode: "seeded", seeded: true, artifactKey: KEY, artifactVersion: result.artifactVersion,
    generatedAt: result.generatedAt, updatedAt: result.updatedAt, payloadSha256: result.payloadSha256,
    payloadBytes: result.payloadBytes, modelPromotionAuthorized: false };
}
async function validateReusablePrivateAuditPostgres({ storeDir, pool, evaluation = null }) {
  evaluation = evaluation || JSON.parse(evaluationBytes(storeDir));
  const record = await require("./postgresPrivateModelArtifactStore.cjs").readPrivateModelArtifact({ pool, artifactKey: KEY });
  return validateAuditEvaluation(record, evaluation);
}
async function seedPrivateModelAuditPostgres({ sourcePool, candidatePool, candidateStore }) {
  if (!sourcePool || !candidatePool || sourcePool === candidatePool) throw new Error("private-seed-independent-database-required");
  // Check the server's actual database identity, not only a caller's URL label.
  const identity = async pool => (await pool.query("SELECT current_database() AS name,inet_server_addr()::text AS address,inet_server_port() AS port")).rows[0];
  const source = await identity(sourcePool), target = await identity(candidatePool);
  if (!/^football_release_[a-f0-9]{12}_[0-9]{1,10}$/.test(target.name) || target.name === source.name)
    throw new Error("private-seed-independent-database-required");
  const record = await validateReusablePrivateAuditPostgres({ storeDir: candidateStore, pool: sourcePool });
  const row = { artifact_key: record.artifactKey, artifact_version: record.artifactVersion, generated_at: record.generatedAt,
    updated_at: record.updatedAt, payload_json: record.payloadJson, payload_sha256: record.payloadSha256, payload_bytes: record.payloadBytes };
  await require("./postgresPrivateModelArtifactStore.cjs").importPrivateModelArtifact({ pool: candidatePool, row });
  const verified = await validateReusablePrivateAuditPostgres({ storeDir: candidateStore, pool: candidatePool });
  if (JSON.stringify(verified) !== JSON.stringify(record)) throw new Error("private-seed-copy-verification-failed");
  return { mode: "seeded", seeded: true, storage: "postgres", candidateDatabase: target.name, artifactKey: KEY,
    artifactVersion: verified.artifactVersion, generatedAt: verified.generatedAt, updatedAt: verified.updatedAt,
    payloadSha256: verified.payloadSha256, payloadBytes: verified.payloadBytes, modelPromotionAuthorized: false };
}
module.exports = { seedPrivateModelAudit, validateReusablePrivateAudit, validateReusablePrivateAuditPostgres, seedPrivateModelAuditPostgres };
if (require.main === module) {
  if (process.argv.length !== 4 || process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("fixed-root-private-model-seed-required");
  console.log(JSON.stringify(seedPrivateModelAudit({ sourceStore: process.argv[2], candidateStore: process.argv[3] })));
}
