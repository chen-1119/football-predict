const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let DatabaseSync = null;
let sqliteLoadError = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  sqliteLoadError = error;
}

const PRIVATE_MODEL_ARTIFACT_TABLE = "private_model_artifacts";
const HHAD_COMPANION_AUDIT_KEY = "hhad-companion-audit";
const PRIVATE_MODEL_ARTIFACT_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_PRIVATE_MODEL_ARTIFACT_MAX_BYTES = PRIVATE_MODEL_ARTIFACT_HARD_MAX_BYTES;
const DEFAULT_PRIVATE_MODEL_ARTIFACT_BUSY_TIMEOUT_MS = 10000;

const fail = (message, cause = null) => {
  const error = new Error(`private model artifact store: ${message}`);
  if (cause) error.cause = cause;
  throw error;
};

const asPositiveInteger = (value, label, { min, max }) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
};

const resolveMaxBytes = (value = process.env.PRIVATE_MODEL_ARTIFACT_MAX_BYTES
  || DEFAULT_PRIVATE_MODEL_ARTIFACT_MAX_BYTES) => asPositiveInteger(value, "maxBytes", {
  min: 1024,
  max: PRIVATE_MODEL_ARTIFACT_HARD_MAX_BYTES,
});

const resolveBusyTimeoutMs = (value = process.env.PRIVATE_MODEL_ARTIFACT_BUSY_TIMEOUT_MS
  || process.env.SQLITE_BUSY_TIMEOUT_MS
  || DEFAULT_PRIVATE_MODEL_ARTIFACT_BUSY_TIMEOUT_MS) => asPositiveInteger(value, "busyTimeoutMs", {
  min: 100,
  max: 120000,
});

const requireSqlite = () => {
  if (!DatabaseSync) {
    fail(sqliteLoadError?.message || "node:sqlite is unavailable; Node.js 22+ is required");
  }
  return DatabaseSync;
};

const normalizeArtifactKey = (value) => {
  const key = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(key)) {
    fail("artifactKey must match ^[a-z0-9][a-z0-9._-]{0,127}$");
  }
  return key;
};

const normalizeArtifactVersion = (value) => {
  const version = String(value || "").trim();
  if (!version || version.length > 128 || /[\u0000-\u001f\u007f]/.test(version)) {
    fail("artifactVersion must be a non-empty control-free string of at most 128 characters");
  }
  return version;
};

const canonicalIso = (value, label) => {
  if (typeof value !== "string") fail(`${label} must be a canonical UTC ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
};

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const serializePayload = (payload, maxBytes) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("payload must be a JSON object");
  }
  let payloadJson;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (error) {
    fail("payload is not JSON serializable", error);
  }
  if (!payloadJson) fail("payload serialization produced no bytes");
  const payloadBuffer = Buffer.from(payloadJson, "utf8");
  if (payloadBuffer.length > maxBytes) {
    fail(`payload exceeds the ${maxBytes}-byte limit`);
  }
  return {
    payloadJson,
    payloadBytes: payloadBuffer.length,
    payloadSha256: sha256(payloadBuffer),
  };
};

const assertDatabaseFile = (dbPath) => {
  const resolved = path.resolve(String(dbPath || ""));
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    fail(`SQLite database is missing: ${resolved}`, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0) {
    fail(`SQLite database must be a non-empty, singly linked regular file: ${resolved}`);
  }
  return resolved;
};

const applyConnectionPolicy = (db, busyTimeoutMs) => {
  db.exec(`
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA foreign_keys = ON;
  `);
};

const requiredColumns = new Map([
  ["artifact_key", { type: "TEXT", notnull: 1, pk: 1 }],
  ["artifact_version", { type: "TEXT", notnull: 1, pk: 0 }],
  ["generated_at", { type: "TEXT", notnull: 1, pk: 0 }],
  ["updated_at", { type: "TEXT", notnull: 1, pk: 0 }],
  ["payload_json", { type: "TEXT", notnull: 1, pk: 0 }],
  ["payload_sha256", { type: "TEXT", notnull: 1, pk: 0 }],
  ["payload_bytes", { type: "INTEGER", notnull: 1, pk: 0 }],
]);

const assertPrivateModelArtifactTable = (db) => {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(PRIVATE_MODEL_ARTIFACT_TABLE);
  if (!table?.sql || !/\bSTRICT\s*$/i.test(String(table.sql).trim())) {
    fail(`${PRIVATE_MODEL_ARTIFACT_TABLE} is missing or is not STRICT`);
  }
  const columns = new Map(db.prepare(`PRAGMA table_info(${PRIVATE_MODEL_ARTIFACT_TABLE})`).all()
    .map((column) => [column.name, column]));
  for (const [name, expected] of requiredColumns) {
    const column = columns.get(name);
    if (!column
        || String(column.type || "").toUpperCase() !== expected.type
        || Number(column.notnull) !== expected.notnull
        || Number(column.pk) !== expected.pk) {
      fail(`${PRIVATE_MODEL_ARTIFACT_TABLE}.${name} has an unsafe schema`);
    }
  }
  return true;
};

const ensurePrivateModelArtifactTable = (db) => {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    fail("a live DatabaseSync connection is required to ensure the schema");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PRIVATE_MODEL_ARTIFACT_TABLE} (
      artifact_key TEXT PRIMARY KEY NOT NULL
        CHECK(length(artifact_key) BETWEEN 1 AND 128),
      artifact_version TEXT NOT NULL
        CHECK(length(artifact_version) BETWEEN 1 AND 128),
      generated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
        CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
      payload_sha256 TEXT NOT NULL
        CHECK(length(payload_sha256) = 64
          AND payload_sha256 = lower(payload_sha256)
          AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
      payload_bytes INTEGER NOT NULL
        CHECK(payload_bytes > 0 AND payload_bytes <= ${PRIVATE_MODEL_ARTIFACT_HARD_MAX_BYTES})
        CHECK(length(CAST(payload_json AS BLOB)) = payload_bytes)
    ) STRICT;
  `);
  return assertPrivateModelArtifactTable(db);
};

const parseAndVerifyRow = (row, { artifactKey, maxBytes }) => {
  if (!row) fail(`required artifact is missing: ${artifactKey}`);
  if (row.artifact_key !== artifactKey) fail("artifact key changed during the transactional read");
  normalizeArtifactVersion(row.artifact_version);
  canonicalIso(row.generated_at, "stored generatedAt");
  canonicalIso(row.updated_at, "stored updatedAt");
  const payloadJson = String(row.payload_json || "");
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const declaredBytes = Number(row.payload_bytes);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > maxBytes) {
    fail(`stored payload size is outside the ${maxBytes}-byte limit`);
  }
  if (payloadBytes !== declaredBytes) fail("stored payload byte count mismatch");
  const payloadSha256 = sha256(Buffer.from(payloadJson, "utf8"));
  if (!/^[0-9a-f]{64}$/.test(String(row.payload_sha256 || ""))
      || payloadSha256 !== row.payload_sha256) {
    fail("stored payload SHA-256 mismatch");
  }
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (error) {
    fail("stored payload is not valid JSON", error);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("stored payload is not a JSON object");
  }
  return {
    artifactKey,
    artifactVersion: row.artifact_version,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
    payload,
    payloadBytes,
    payloadSha256,
    integrity: {
      hashVerified: true,
      sizeVerified: true,
    },
  };
};

const selectArtifact = (db, artifactKey) => db.prepare(`
  SELECT artifact_key, artifact_version, generated_at, updated_at,
         payload_json, payload_sha256, payload_bytes
  FROM ${PRIVATE_MODEL_ARTIFACT_TABLE}
  WHERE artifact_key = ?
`).get(artifactKey);

const withTransaction = (db, beginStatement, operation) => {
  let active = false;
  try {
    db.exec(beginStatement);
    active = true;
    const result = operation();
    db.exec("COMMIT");
    active = false;
    return result;
  } catch (error) {
    if (active) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; callers fail closed either way.
      }
    }
    throw error;
  }
};

const writePrivateModelArtifact = ({
  dbPath,
  artifactKey,
  artifactVersion,
  generatedAt,
  payload,
  maxBytes,
  busyTimeoutMs,
}) => {
  const key = normalizeArtifactKey(artifactKey);
  const version = normalizeArtifactVersion(artifactVersion || payload?.version);
  const generated = canonicalIso(generatedAt || payload?.evaluatedAt || payload?.generatedAt, "generatedAt");
  const max = resolveMaxBytes(maxBytes);
  const timeout = resolveBusyTimeoutMs(busyTimeoutMs);
  const serialized = serializePayload(payload, max);
  const resolvedDbPath = assertDatabaseFile(dbPath);
  const Sqlite = requireSqlite();
  const db = new Sqlite(resolvedDbPath);
  try {
    applyConnectionPolicy(db, timeout);
    return withTransaction(db, "BEGIN IMMEDIATE", () => {
      ensurePrivateModelArtifactTable(db);
      const updatedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO ${PRIVATE_MODEL_ARTIFACT_TABLE}
          (artifact_key, artifact_version, generated_at, updated_at,
           payload_json, payload_sha256, payload_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_key) DO UPDATE SET
          artifact_version = excluded.artifact_version,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json,
          payload_sha256 = excluded.payload_sha256,
          payload_bytes = excluded.payload_bytes
      `).run(
        key,
        version,
        generated,
        updatedAt,
        serialized.payloadJson,
        serialized.payloadSha256,
        serialized.payloadBytes
      );
      const stored = parseAndVerifyRow(selectArtifact(db, key), { artifactKey: key, maxBytes: max });
      if (stored.payloadSha256 !== serialized.payloadSha256
          || stored.payloadBytes !== serialized.payloadBytes
          || stored.artifactVersion !== version
          || stored.generatedAt !== generated) {
        fail("transactional upsert verification mismatch");
      }
      return { ...stored, dbPath: resolvedDbPath, busyTimeoutMs: timeout };
    });
  } catch (error) {
    if (/^private model artifact store:/.test(String(error?.message || ""))) throw error;
    fail(`transactional upsert failed for ${key}`, error);
  } finally {
    try {
      db.close();
    } catch {
      // A failed close cannot make a failed transaction look successful.
    }
  }
};

const readPrivateModelArtifact = ({
  dbPath,
  artifactKey,
  maxBytes,
  busyTimeoutMs,
}) => {
  const key = normalizeArtifactKey(artifactKey);
  const max = resolveMaxBytes(maxBytes);
  const timeout = resolveBusyTimeoutMs(busyTimeoutMs);
  const resolvedDbPath = assertDatabaseFile(dbPath);
  const Sqlite = requireSqlite();
  const db = new Sqlite(resolvedDbPath, { readOnly: true });
  try {
    applyConnectionPolicy(db, timeout);
    return withTransaction(db, "BEGIN", () => {
      assertPrivateModelArtifactTable(db);
      return {
        ...parseAndVerifyRow(selectArtifact(db, key), { artifactKey: key, maxBytes: max }),
        dbPath: resolvedDbPath,
        busyTimeoutMs: timeout,
      };
    });
  } catch (error) {
    if (/^private model artifact store:/.test(String(error?.message || ""))) throw error;
    fail(`transactional read failed for ${key}`, error);
  } finally {
    try {
      db.close();
    } catch {
      // Reads fail closed before returning any unverified payload.
    }
  }
};

module.exports = {
  DEFAULT_PRIVATE_MODEL_ARTIFACT_BUSY_TIMEOUT_MS,
  DEFAULT_PRIVATE_MODEL_ARTIFACT_MAX_BYTES,
  HHAD_COMPANION_AUDIT_KEY,
  PRIVATE_MODEL_ARTIFACT_HARD_MAX_BYTES,
  PRIVATE_MODEL_ARTIFACT_TABLE,
  assertPrivateModelArtifactTable,
  ensurePrivateModelArtifactTable,
  readPrivateModelArtifact,
  writePrivateModelArtifact,
};
