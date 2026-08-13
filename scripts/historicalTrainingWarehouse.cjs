"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const {
  DATASET_CONFIGS,
  EVENT_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  HistoricalEventConflictError,
  importHistoricalEvents,
  sha256,
  stableStringify,
} = require("./historicalEventStore.cjs");

const WAREHOUSE_SCHEMA_VERSION = "historical-training-sqlite-v3-availability-commitment";
const QUERY_SCHEMA_VERSION = "historical-training-asof-v1";
const EVENT_PAYLOAD_ENCODING = "deflate-raw-json-v1";
const DEFAULT_RESULT_DELAY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DATE_ONLY_DELAY_MS = 48 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;
const IMPORT_STRATEGY_VERSION = "historical-training-import-strategy-v1";
const AVAILABILITY_POLICY_VERSION = "derived-result-availability-v1";
const AVAILABILITY_COMMITMENT_VERSION = "historical-availability-commitment-v1";
const WAREHOUSE_ROOT_HASH_ALGORITHM = "sha256(sorted(sourceEventId:eventSha256:availableAt:availabilityCommitmentSha256))";
const PARSER_REVISION = `historical-event-csv-parser:${MANIFEST_SCHEMA_VERSION}`;
const ADAPTER_REVISION = `historical-event-adapters:${EVENT_SCHEMA_VERSION}:v1`;
const FORBIDDEN_FEATURE_KEYS = /(?:shots?|target|fouls?|corners?|yellow|red|halftime|htresult)/i;

class HistoricalWarehouseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HistoricalWarehouseError";
    this.code = details.code || "HISTORICAL_WAREHOUSE_ERROR";
    Object.assign(this, details);
  }
}

const canonicalIso = (value, label) => {
  const parsed = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new HistoricalWarehouseError(`${label} must be a canonical UTC ISO timestamp`, {
      code: "INVALID_TIMESTAMP",
    });
  }
  return value;
};

const canonicalJson = (value) => stableStringify(value);
const jsonHash = (value) => sha256(Buffer.from(canonicalJson(value), "utf8"));

const normalizedTimezoneOffset = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^z$/i.test(raw)) return "Z";
  const match = raw.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) {
    throw new HistoricalWarehouseError("timezoneOffset must be Z or a numeric UTC offset", {
      code: "INVALID_TIMEZONE_OFFSET",
    });
  }
  return `${match[1]}${match[2]}:${match[3]}`;
};

const datasetIdentity = (dataset) => {
  const config = dataset && typeof dataset === "object"
    ? dataset
    : DATASET_CONFIGS[String(dataset || "")];
  const sourceDataset = String(config?.sourceDataset || "").trim();
  const adapter = String(config?.adapter || "").trim();
  if (!sourceDataset || !adapter) {
    throw new HistoricalWarehouseError("historical dataset configuration is missing sourceDataset or adapter", {
      code: "INVALID_DATASET",
    });
  }
  return { sourceDataset, adapter };
};

const importStrategyFor = ({
  dataset,
  timezoneOffset,
  resultDelayMs,
  parserRevision = PARSER_REVISION,
  adapterRevision = ADAPTER_REVISION,
} = {}) => {
  const identity = datasetIdentity(dataset);
  const normalizedResultDelayMs = Math.max(
    60 * 60 * 1000,
    Math.trunc(Number(resultDelayMs) || DEFAULT_RESULT_DELAY_MS),
  );
  return {
    version: IMPORT_STRATEGY_VERSION,
    warehouseSchemaVersion: WAREHOUSE_SCHEMA_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    parserRevision: String(parserRevision || "").trim(),
    adapterRevision: String(adapterRevision || "").trim(),
    adapter: identity.adapter,
    sourceDataset: identity.sourceDataset,
    timezoneOffset: normalizedTimezoneOffset(timezoneOffset),
    availabilityPolicy: {
      version: AVAILABILITY_POLICY_VERSION,
      mode: "derived",
      kickoffDelayMs: normalizedResultDelayMs,
      dateOnlyDelayMs: DEFAULT_DATE_ONLY_DELAY_MS,
      strictPromotionEligible: false,
    },
  };
};

const validateImportStrategy = (strategy, expectedHash = null) => {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
    throw new HistoricalWarehouseError("import strategy is missing or invalid", { code: "QUERY_INTEGRITY_FAILURE" });
  }
  let timezoneOffsetIsCanonical = false;
  try {
    timezoneOffsetIsCanonical = strategy.timezoneOffset === null
      || normalizedTimezoneOffset(strategy.timezoneOffset) === strategy.timezoneOffset;
  } catch {
    // Stored strategy metadata is content-addressed. A malformed offset is an
    // integrity failure, not a recoverable CLI/input-validation error.
    timezoneOffsetIsCanonical = false;
  }
  const policy = strategy.availabilityPolicy;
  const valid = strategy.version === IMPORT_STRATEGY_VERSION
    && strategy.warehouseSchemaVersion === WAREHOUSE_SCHEMA_VERSION
    && strategy.eventSchemaVersion === EVENT_SCHEMA_VERSION
    && Boolean(String(strategy.parserRevision || "").trim())
    && Boolean(String(strategy.adapterRevision || "").trim())
    && Boolean(String(strategy.adapter || "").trim())
    && Boolean(String(strategy.sourceDataset || "").trim())
    && timezoneOffsetIsCanonical
    && policy?.version === AVAILABILITY_POLICY_VERSION
    && policy?.mode === "derived"
    && Number.isSafeInteger(policy?.kickoffDelayMs)
    && policy.kickoffDelayMs >= 60 * 60 * 1000
    && policy?.dateOnlyDelayMs === DEFAULT_DATE_ONLY_DELAY_MS
    && policy?.strictPromotionEligible === false;
  const strategyHash = jsonHash(strategy);
  if (!valid || (expectedHash && strategyHash !== expectedHash)) {
    throw new HistoricalWarehouseError("import strategy failed integrity checks", {
      code: "QUERY_INTEGRITY_FAILURE",
    });
  }
  return strategyHash;
};

const availabilityCommitmentFor = ({ sourceEventId, eventSha256, availableAt, importStrategySha256 }) => jsonHash({
  version: AVAILABILITY_COMMITMENT_VERSION,
  sourceEventId,
  eventSha256,
  availableAt,
  importStrategySha256,
});

async function preflightSourceHash(options) {
  if (options.filePath) {
    const hasher = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(options.filePath)) hasher.update(chunk);
    return hasher.digest("hex");
  }
  if (typeof options.input === "string" || Buffer.isBuffer(options.input)) {
    return sha256(Buffer.isBuffer(options.input) ? options.input : Buffer.from(options.input, "utf8"));
  }
  return null;
}

function encodeEventPayload(event) {
  const eventJson = canonicalJson(event);
  const raw = Buffer.from(eventJson, "utf8");
  const payload = zlib.deflateRawSync(raw, { level: 9 });
  return {
    encoding: EVENT_PAYLOAD_ENCODING,
    payload,
    eventJsonSha256: sha256(raw),
    eventJsonBytes: raw.length,
    eventPayloadBytes: payload.length,
  };
}

function decodeEventPayload(row) {
  try {
    if (row.event_payload_encoding !== EVENT_PAYLOAD_ENCODING) {
      throw new Error("unsupported payload encoding");
    }
    const payload = Buffer.from(row.event_payload);
    if (payload.length !== Number(row.event_payload_bytes)) throw new Error("compressed byte count mismatch");
    const raw = zlib.inflateRawSync(payload, { maxOutputLength: 1024 * 1024 });
    if (raw.length !== Number(row.event_json_bytes)) throw new Error("raw byte count mismatch");
    if (sha256(raw) !== row.event_json_sha256) throw new Error("raw content hash mismatch");
    const event = JSON.parse(raw.toString("utf8"));
    if (canonicalJson(event) !== raw.toString("utf8")) throw new Error("event JSON is not canonical");
    return event;
  } catch (error) {
    throw new HistoricalWarehouseError("compressed event payload failed integrity checks", {
      code: "QUERY_INTEGRITY_FAILURE",
      cause: error,
    });
  }
}

const transact = (db, operation) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
};

function ensureHistoricalTrainingSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 15000;
    CREATE TABLE IF NOT EXISTS historical_training_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS historical_event_imports (
      import_id TEXT PRIMARY KEY NOT NULL,
      source_dataset TEXT NOT NULL,
      source_file_path TEXT,
      source_file_sha256 TEXT,
      manifest_json TEXT,
      manifest_sha256 TEXT,
      manifest_root_hash TEXT,
      import_strategy_json TEXT NOT NULL,
      import_strategy_sha256 TEXT NOT NULL,
      availability_mode TEXT NOT NULL CHECK(availability_mode IN ('derived','explicit')),
      status TEXT NOT NULL CHECK(status IN ('staging','active','duplicate','blocked')),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      input_rows INTEGER NOT NULL DEFAULT 0,
      accepted_rows INTEGER NOT NULL DEFAULT 0,
      duplicate_rows INTEGER NOT NULL DEFAULT 0,
      rejected_rows INTEGER NOT NULL DEFAULT 0,
      conflict_rows INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS historical_event_payloads (
      import_id TEXT NOT NULL REFERENCES historical_event_imports(import_id) ON DELETE CASCADE,
      source_event_id TEXT NOT NULL,
      event_sha256 TEXT NOT NULL,
      event_payload BLOB NOT NULL,
      event_payload_encoding TEXT NOT NULL CHECK(event_payload_encoding='${EVENT_PAYLOAD_ENCODING}'),
      event_json_sha256 TEXT NOT NULL,
      event_json_bytes INTEGER NOT NULL CHECK(event_json_bytes > 0),
      event_payload_bytes INTEGER NOT NULL CHECK(event_payload_bytes > 0),
      available_at TEXT NOT NULL,
      availability_commitment_sha256 TEXT NOT NULL,
      PRIMARY KEY(import_id, source_event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS historical_events (
      source_event_id TEXT PRIMARY KEY NOT NULL,
      import_id TEXT NOT NULL REFERENCES historical_event_imports(import_id),
      inserted_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS historical_events_asof_idx
      ON historical_event_payloads(available_at, source_event_id);
    CREATE TABLE IF NOT EXISTS historical_event_conflicts (
      conflict_id INTEGER PRIMARY KEY,
      import_id TEXT NOT NULL REFERENCES historical_event_imports(import_id) ON DELETE CASCADE,
      source_event_id TEXT,
      conflict_type TEXT NOT NULL,
      existing_event_sha256 TEXT,
      incoming_event_sha256 TEXT,
      incoming_event_payload BLOB,
      incoming_event_json_sha256 TEXT,
      detected_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS historical_event_rejections (
      rejection_id INTEGER PRIMARY KEY,
      import_id TEXT NOT NULL REFERENCES historical_event_imports(import_id) ON DELETE CASCADE,
      source_row_number INTEGER,
      reason TEXT NOT NULL,
      message TEXT,
      raw_row_sha256 TEXT,
      detected_at TEXT NOT NULL
    ) STRICT;
  `);
  const prior = db.prepare("SELECT value FROM historical_training_meta WHERE key = 'schema_version'").get();
  if (prior && prior.value !== WAREHOUSE_SCHEMA_VERSION) {
    throw new HistoricalWarehouseError(`unsupported warehouse schema ${prior.value}`, {
      code: "SCHEMA_VERSION_MISMATCH",
    });
  }
  db.prepare(`
    INSERT INTO historical_training_meta(key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO NOTHING
  `).run(WAREHOUSE_SCHEMA_VERSION);
}

function openWarehouse(dbPath, { readOnly = false } = {}) {
  const resolved = path.resolve(String(dbPath || ""));
  if (!readOnly) fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (readOnly && !fs.existsSync(resolved)) {
    throw new HistoricalWarehouseError(`warehouse does not exist: ${resolved}`, { code: "WAREHOUSE_MISSING" });
  }
  const db = new DatabaseSync(resolved, readOnly ? { readOnly: true } : {});
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 15000;");
  if (!readOnly) ensureHistoricalTrainingSchema(db);
  return { db, dbPath: resolved };
}

function assertWarehouseSchema(db) {
  const schema = db.prepare("SELECT value FROM historical_training_meta WHERE key='schema_version'").get();
  if (schema?.value !== WAREHOUSE_SCHEMA_VERSION) {
    throw new HistoricalWarehouseError("warehouse schema is missing or unsupported", {
      code: "SCHEMA_VERSION_MISMATCH",
    });
  }
}

function semanticEventHash(event) {
  const semantic = { ...event };
  delete semantic.eventSha256;
  delete semantic.sourceRowNumber;
  delete semantic.rawRowSha256;
  return jsonHash(semantic);
}

function availabilityFor(event, importStrategy, verifiedStrategyHash = null) {
  const strategyHash = verifiedStrategyHash || validateImportStrategy(importStrategy);
  const policy = importStrategy.availabilityPolicy;
  if (event.kickoff) {
    const kickoffMs = Date.parse(event.kickoff);
    if (!Number.isFinite(kickoffMs)) throw new HistoricalWarehouseError("event kickoff is invalid", { code: "INVALID_EVENT" });
    return {
      availableAt: new Date(kickoffMs + policy.kickoffDelayMs).toISOString(),
      provenance: {
        source: "derived-kickoff-conservative-delay",
        policyVersion: policy.version,
        importStrategySha256: strategyHash,
        delayMs: policy.kickoffDelayMs,
        explicitObservation: false,
        strictPromotionEligible: false,
      },
    };
  }
  const dateMs = Date.parse(`${event.date}T00:00:00.000Z`);
  if (!Number.isFinite(dateMs)) throw new HistoricalWarehouseError("event date is invalid", { code: "INVALID_EVENT" });
  return {
    availableAt: new Date(dateMs + policy.dateOnlyDelayMs).toISOString(),
    provenance: {
      source: "derived-date-plus-two-days",
      policyVersion: policy.version,
      importStrategySha256: strategyHash,
      delayMs: policy.dateOnlyDelayMs,
      explicitObservation: false,
      strictPromotionEligible: false,
    },
  };
}

function assertNoForbiddenFeatureKeys(value, location = "feature") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FEATURE_KEYS.test(key)) {
      throw new HistoricalWarehouseError(`forbidden post-match feature key at ${location}.${key}`, {
        code: "POST_MATCH_FEATURE_LEAKAGE",
      });
    }
    assertNoForbiddenFeatureKeys(child, `${location}.${key}`);
  }
}

function trainingProjection(event, availableAt, availabilityProvenance = null) {
  const projection = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    sourceEventId: event.sourceEventId,
    sourceDataset: event.sourceDataset,
    competition: event.competition,
    date: event.date,
    kickoff: event.kickoff,
    kickoffLocalTime: event.kickoffLocalTime,
    availableAt,
    availabilityProvenance,
    homeTeam: { raw: event.homeTeamRaw, normalized: event.homeTeamNormalized },
    awayTeam: { raw: event.awayTeamRaw, normalized: event.awayTeamNormalized },
    historicalOutcome: { homeGoals: event.score.home, awayGoals: event.score.away },
    neutral: event.neutral,
  };
  if (event.preMatchOdds) projection.preMatchOdds = event.preMatchOdds;
  assertNoForbiddenFeatureKeys(projection);
  return projection;
}

function storedAvailabilityProvenance(event, availableAt, importStrategy, importStrategySha256 = null) {
  const expected = availabilityFor(event, importStrategy, importStrategySha256);
  if (expected.availableAt !== availableAt) {
    throw new HistoricalWarehouseError("stored result availability does not match the committed import policy", {
      code: "QUERY_INTEGRITY_FAILURE",
    });
  }
  return expected.provenance;
}

function validateEvent(event, importStrategy, importStrategySha256 = null) {
  if (!event || event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new HistoricalWarehouseError("unsupported historical event schema", { code: "INVALID_EVENT" });
  }
  if (!/^[a-f0-9]{64}$/.test(String(event.sourceEventId || ""))
      || !/^[a-f0-9]{64}$/.test(String(event.eventSha256 || ""))) {
    throw new HistoricalWarehouseError("event identity/hash is invalid", { code: "INVALID_EVENT" });
  }
  const recomputed = semanticEventHash(event);
  if (recomputed !== event.eventSha256) {
    throw new HistoricalWarehouseError("event content SHA-256 mismatch", { code: "EVENT_HASH_MISMATCH" });
  }
  const availability = availabilityFor(event, importStrategy, importStrategySha256);
  const projection = trainingProjection(event, availability.availableAt, availability.provenance);
  return {
    availableAt: availability.availableAt,
    projection,
    encoded: encodeEventPayload(event),
  };
}

function stagedSourceEventRootHash(db, importId) {
  const hasher = crypto.createHash("sha256");
  hasher.update(`${EVENT_SCHEMA_VERSION}\0`);
  for (const row of db.prepare(`
    SELECT source_event_id, event_sha256 FROM historical_event_payloads
    WHERE import_id = ? ORDER BY source_event_id
  `).iterate(importId)) {
    hasher.update(`${row.source_event_id}:${row.event_sha256}\n`);
  }
  return hasher.digest("hex");
}

function stagedAvailabilityRootHash(db, importId, importStrategySha256, { verifyCommitments = false } = {}) {
  const hasher = crypto.createHash("sha256");
  hasher.update(`${WAREHOUSE_SCHEMA_VERSION}\0${importStrategySha256}\0`);
  for (const row of db.prepare(`
    SELECT source_event_id, event_sha256, available_at, availability_commitment_sha256
    FROM historical_event_payloads WHERE import_id = ? ORDER BY source_event_id
  `).iterate(importId)) {
    const expectedCommitment = availabilityCommitmentFor({
      sourceEventId: row.source_event_id,
      eventSha256: row.event_sha256,
      availableAt: row.available_at,
      importStrategySha256,
    });
    if (verifyCommitments && row.availability_commitment_sha256 !== expectedCommitment) {
      throw new HistoricalWarehouseError("stored availability commitment failed integrity checks", {
        code: "QUERY_INTEGRITY_FAILURE",
      });
    }
    hasher.update(`${row.source_event_id}:${row.event_sha256}:${row.available_at}:${expectedCommitment}\n`);
  }
  return hasher.digest("hex");
}

function warehouseManifestFor(sourceManifest, importStrategy, importStrategySha256, availabilityRootHash) {
  return {
    ...sourceManifest,
    sourceEventRootHash: sourceManifest.rootHash,
    sourceRootHashAlgorithm: sourceManifest.rootHashAlgorithm || "sha256(sorted(sourceEventId:eventSha256))",
    warehouseSchemaVersion: WAREHOUSE_SCHEMA_VERSION,
    importStrategy,
    importStrategySha256,
    availabilityMode: importStrategy.availabilityPolicy.mode,
    rootHash: availabilityRootHash,
    rootHashAlgorithm: WAREHOUSE_ROOT_HASH_ALGORITHM,
  };
}

function verifyActiveImportIntegrity(db, row, expected = {}) {
  if (!row || row.status !== "active") {
    throw new HistoricalWarehouseError("active import is missing", { code: "QUERY_INTEGRITY_FAILURE" });
  }
  const manifestJson = String(row.manifest_json || "");
  const strategyJson = String(row.import_strategy_json || "");
  let manifest;
  let strategy;
  try {
    manifest = JSON.parse(manifestJson);
    strategy = JSON.parse(strategyJson);
  } catch (error) {
    throw new HistoricalWarehouseError("active import metadata is not valid JSON", {
      code: "QUERY_INTEGRITY_FAILURE",
      cause: error,
    });
  }
  const strategyHash = validateImportStrategy(strategy, row.import_strategy_sha256);
  const envelopeValid = canonicalJson(manifest) === manifestJson
    && canonicalJson(strategy) === strategyJson
    && sha256(Buffer.from(manifestJson, "utf8")) === row.manifest_sha256
    && manifest.warehouseSchemaVersion === WAREHOUSE_SCHEMA_VERSION
    && manifest.eventSchemaVersion === EVENT_SCHEMA_VERSION
    && manifest.sourceDataset === row.source_dataset
    && manifest.sourceFileSha256 === row.source_file_sha256
    && manifest.importStrategySha256 === strategyHash
    && canonicalJson(manifest.importStrategy) === strategyJson
    && manifest.availabilityMode === row.availability_mode
    && manifest.rootHash === row.manifest_root_hash
    && manifest.rootHashAlgorithm === WAREHOUSE_ROOT_HASH_ALGORITHM
    && (!expected.sourceDataset || row.source_dataset === expected.sourceDataset)
    && (!expected.sourceFileSha256 || row.source_file_sha256 === expected.sourceFileSha256)
    && (!expected.importStrategySha256 || strategyHash === expected.importStrategySha256);
  if (!envelopeValid) {
    throw new HistoricalWarehouseError("active import manifest/strategy envelope failed integrity checks", {
      code: "QUERY_INTEGRITY_FAILURE",
    });
  }

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM historical_event_payloads WHERE import_id=?) AS payload_rows,
      (SELECT COUNT(*) FROM historical_event_rejections WHERE import_id=?) AS rejection_rows
  `).get(row.import_id, row.import_id);
  if (Number(counts.payload_rows) !== Number(manifest.rows)
      || Number(row.accepted_rows) !== Number(manifest.rows)
      || Number(row.input_rows) !== Number(manifest.inputRows)
      || Number(row.duplicate_rows) !== Number(manifest.duplicateRows)
      || Number(row.rejected_rows) !== Number(manifest.rejected)
      || Number(counts.rejection_rows) !== Number(manifest.rejected)) {
    throw new HistoricalWarehouseError("active import row/manifest coverage counts do not match", {
      code: "QUERY_INTEGRITY_FAILURE",
    });
  }

  const sourceRootHash = stagedSourceEventRootHash(db, row.import_id);
  const availabilityRootHash = stagedAvailabilityRootHash(db, row.import_id, strategyHash, {
    verifyCommitments: true,
  });
  const uncovered = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM historical_event_payloads incoming
    LEFT JOIN historical_events active_event
      ON active_event.source_event_id=incoming.source_event_id
    LEFT JOIN historical_event_payloads active_payload
      ON active_payload.import_id=active_event.import_id
     AND active_payload.source_event_id=active_event.source_event_id
    LEFT JOIN historical_event_imports active_import
      ON active_import.import_id=active_event.import_id
    WHERE incoming.import_id=? AND (
      active_event.source_event_id IS NULL
      OR active_payload.event_sha256 IS NULL
      OR active_payload.event_sha256<>incoming.event_sha256
      OR COALESCE(active_import.status, '')<>'active'
    )
  `).get(row.import_id)?.count || 0);
  if (manifest.sourceEventRootHash !== sourceRootHash
      || manifest.rootHash !== availabilityRootHash
      || uncovered > 0) {
    throw new HistoricalWarehouseError("active import root hash or active-event coverage failed integrity checks", {
      code: "QUERY_INTEGRITY_FAILURE",
    });
  }
  return { manifest, strategy, strategyHash };
}

async function importHistoricalCsvToWarehouse(options = {}) {
  const startedAt = canonicalIso(options.createdAt || new Date().toISOString(), "createdAt");
  const completedAt = canonicalIso(options.completedAt || startedAt, "completedAt");
  const batchSize = Math.max(1, Math.min(10000, Math.trunc(Number(options.batchSize) || DEFAULT_BATCH_SIZE)));
  const importStrategy = importStrategyFor({
    dataset: options.dataset,
    timezoneOffset: options.timezoneOffset,
    resultDelayMs: options.resultDelayMs,
    parserRevision: options.parserRevision,
    adapterRevision: options.adapterRevision,
  });
  const importStrategySha256 = validateImportStrategy(importStrategy);
  const strategyJson = canonicalJson(importStrategy);
  const importId = String(options.importId || crypto.randomUUID());
  const sourceFilePath = options.filePath ? path.resolve(options.filePath) : null;
  const preflightHash = await preflightSourceHash(options);
  const expectedSourceDataset = importStrategy.sourceDataset;
  const { db, dbPath } = openWarehouse(options.dbPath);
  let buffered = [];
  let stagedRows = 0;
  let conflictCallbackRows = 0;
  const insertStage = db.prepare(`
    INSERT INTO historical_event_payloads
      (import_id, source_event_id, event_sha256, event_payload, event_payload_encoding,
       event_json_sha256, event_json_bytes, event_payload_bytes,
        available_at, availability_commitment_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const flush = () => {
    if (!buffered.length) return;
    const rows = buffered;
    buffered = [];
    transact(db, () => {
      for (const row of rows) insertStage.run(...row);
    });
    stagedRows += rows.length;
    if (typeof options.onProgress === "function") options.onProgress({ importId, stagedRows });
  };
  try {
    if (preflightHash && expectedSourceDataset) {
      const prior = db.prepare(`
        SELECT * FROM historical_event_imports
        WHERE status='active' AND source_dataset=? AND source_file_sha256=?
          AND import_strategy_sha256=?
        ORDER BY completed_at DESC LIMIT 1
      `).get(expectedSourceDataset, preflightHash, importStrategySha256);
      if (prior) {
        const { manifest } = verifyActiveImportIntegrity(db, prior, {
          sourceDataset: expectedSourceDataset,
          sourceFileSha256: preflightHash,
          importStrategySha256,
        });
        return {
          ok: true,
          idempotent: true,
          preflight: true,
          importId: prior.import_id,
          priorImportId: prior.import_id,
          manifest,
          dbPath,
        };
      }
    }
    db.prepare(`
      INSERT INTO historical_event_imports
        (import_id, source_dataset, source_file_path, source_file_sha256,
         import_strategy_json, import_strategy_sha256, availability_mode, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'derived', 'staging', ?)
    `).run(
      importId,
      expectedSourceDataset,
      sourceFilePath,
      preflightHash,
      strategyJson,
      importStrategySha256,
      startedAt,
    );

    let manifest;
    try {
      manifest = await importHistoricalEvents({
        dataset: options.dataset,
        filePath: options.filePath,
        input: options.input,
        timezoneOffset: importStrategy.timezoneOffset,
        createdAt: startedAt,
        onEvent: (event) => {
          const { availableAt, encoded } = validateEvent(event, importStrategy, importStrategySha256);
          const availabilityCommitmentSha256 = availabilityCommitmentFor({
            sourceEventId: event.sourceEventId,
            eventSha256: event.eventSha256,
            availableAt,
            importStrategySha256,
          });
          buffered.push([
            importId,
            event.sourceEventId,
            event.eventSha256,
            encoded.payload,
            encoded.encoding,
            encoded.eventJsonSha256,
            encoded.eventJsonBytes,
            encoded.eventPayloadBytes,
            availableAt,
            availabilityCommitmentSha256,
          ]);
          if (buffered.length >= batchSize) flush();
        },
        onRejected: (row) => db.prepare(`
          INSERT INTO historical_event_rejections
            (import_id, source_row_number, reason, message, raw_row_sha256, detected_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(importId, row.sourceRowNumber || null, row.reason, row.message || null, row.rawRowSha256 || null, completedAt),
        onConflict: (row) => {
          conflictCallbackRows += 1;
          db.prepare(`
            INSERT INTO historical_event_conflicts
              (import_id, source_event_id, conflict_type, existing_event_sha256,
               incoming_event_sha256, detected_at)
            VALUES (?, ?, 'within-source', ?, ?, ?)
          `).run(importId, row.sourceEventId, row.firstEventSha256, row.conflictingEventSha256, completedAt);
        },
      });
      flush();
    } catch (error) {
      buffered = [];
      const partial = error.partialManifest || {};
      db.prepare("DELETE FROM historical_event_payloads WHERE import_id = ?").run(importId);
      db.prepare(`
        UPDATE historical_event_imports SET status='blocked', completed_at=?, conflict_rows=?,
          input_rows=?, accepted_rows=?, duplicate_rows=?, rejected_rows=?,
          error_code=?, error_message=? WHERE import_id=?
      `).run(
        completedAt,
        conflictCallbackRows,
        Number(partial.inputRows || 0),
        Number(partial.rows || stagedRows),
        Number(partial.duplicateRows || 0),
        Number(partial.rejected || 0),
        error.code || "IMPORT_FAILED",
        String(error.message || error),
        importId,
      );
      throw error;
    }

    const sourceManifest = manifest;
    const sourceFileSha256 = String(sourceManifest.sourceFileSha256 || "");
    const computedSourceRoot = stagedSourceEventRootHash(db, importId);
    if (!/^[a-f0-9]{64}$/.test(sourceFileSha256)
        || (preflightHash && sourceFileSha256 !== preflightHash)
        || computedSourceRoot !== sourceManifest.rootHash
        || stagedRows !== sourceManifest.rows) {
      throw new HistoricalWarehouseError("source manifest does not match staged event content", {
        code: "MANIFEST_CONTENT_MISMATCH",
      });
    }
    const availabilityRootHash = stagedAvailabilityRootHash(db, importId, importStrategySha256, {
      verifyCommitments: true,
    });
    manifest = warehouseManifestFor(
      sourceManifest,
      importStrategy,
      importStrategySha256,
      availabilityRootHash,
    );
    const manifestSha256 = jsonHash(manifest);

    const exactPrior = db.prepare(`
      SELECT * FROM historical_event_imports
      WHERE status='active' AND source_dataset=? AND source_file_sha256=?
        AND import_strategy_sha256=? AND manifest_root_hash=?
      ORDER BY completed_at DESC LIMIT 1
    `).get(manifest.sourceDataset, sourceFileSha256, importStrategySha256, manifest.rootHash);
    const sameFileDifferentManifest = db.prepare(`
      SELECT import_id, manifest_root_hash, import_strategy_sha256 FROM historical_event_imports
      WHERE status='active' AND source_dataset=? AND source_file_sha256=?
        AND (import_strategy_sha256<>? OR manifest_root_hash<>?)
      LIMIT 1
    `).get(manifest.sourceDataset, sourceFileSha256, importStrategySha256, manifest.rootHash);

    const crossConflicts = [...db.prepare(`
      SELECT s.source_event_id, active.event_sha256 AS existing_hash,
             s.event_sha256 AS incoming_hash, s.event_payload, s.event_json_sha256
      FROM historical_event_payloads s
      JOIN historical_events e USING(source_event_id)
      JOIN historical_event_payloads active
        ON active.import_id=e.import_id AND active.source_event_id=e.source_event_id
      WHERE s.import_id=? AND s.event_sha256<>active.event_sha256
      ORDER BY s.source_event_id
    `).iterate(importId)];
    const rejectCount = Number(manifest.rejected || 0);
    const blocked = Boolean(sameFileDifferentManifest)
      || crossConflicts.length > 0
      || (!options.allowRejectedRows && rejectCount > 0);

    if (blocked) {
      transact(db, () => {
        if (sameFileDifferentManifest) db.prepare(`
          INSERT INTO historical_event_conflicts
            (import_id, conflict_type, existing_event_sha256, incoming_event_sha256, detected_at)
          VALUES (?, 'source-file-manifest', ?, ?, ?)
        `).run(importId, sameFileDifferentManifest.manifest_root_hash, manifest.rootHash, completedAt);
        const insertConflict = db.prepare(`
          INSERT INTO historical_event_conflicts
            (import_id, source_event_id, conflict_type, existing_event_sha256,
             incoming_event_sha256, incoming_event_payload, incoming_event_json_sha256, detected_at)
          VALUES (?, ?, 'cross-import', ?, ?, ?, ?, ?)
        `);
        for (const row of crossConflicts) insertConflict.run(
          importId, row.source_event_id, row.existing_hash, row.incoming_hash,
          row.event_payload, row.event_json_sha256, completedAt,
        );
        db.prepare("DELETE FROM historical_event_payloads WHERE import_id=?").run(importId);
      db.prepare(`
        UPDATE historical_event_imports SET source_dataset=?, source_file_sha256=?, manifest_json=?, manifest_sha256=?,
            manifest_root_hash=?, status='blocked', completed_at=?, input_rows=?, accepted_rows=?,
            duplicate_rows=?, rejected_rows=?, conflict_rows=?, error_code=?, error_message=?
          WHERE import_id=?
        `).run(
          manifest.sourceDataset, sourceFileSha256, canonicalJson(manifest), manifestSha256, manifest.rootHash, completedAt,
          manifest.inputRows, manifest.rows, manifest.duplicateRows, rejectCount,
          crossConflicts.length + (sameFileDifferentManifest ? 1 : 0),
          crossConflicts.length || sameFileDifferentManifest ? "HISTORICAL_EVENT_CONFLICT" : "REJECTED_ROWS_PRESENT",
          "import quarantined; active training events were not changed", importId,
        );
      });
      throw new HistoricalWarehouseError("historical import was quarantined", {
        code: "IMPORT_QUARANTINED",
        importId,
        conflicts: crossConflicts.length + (sameFileDifferentManifest ? 1 : 0),
        rejectedRows: rejectCount,
      });
    }

    if (exactPrior) {
      verifyActiveImportIntegrity(db, exactPrior, {
        sourceDataset: manifest.sourceDataset,
        sourceFileSha256,
        importStrategySha256,
      });
      transact(db, () => {
        db.prepare("DELETE FROM historical_event_payloads WHERE import_id=?").run(importId);
        db.prepare(`
          UPDATE historical_event_imports SET source_dataset=?, source_file_sha256=?, manifest_json=?, manifest_sha256=?,
            manifest_root_hash=?, status='duplicate', completed_at=?, input_rows=?, accepted_rows=?,
            duplicate_rows=?, rejected_rows=?, conflict_rows=0 WHERE import_id=?
        `).run(
          manifest.sourceDataset, sourceFileSha256, canonicalJson(manifest), manifestSha256, manifest.rootHash, completedAt,
          manifest.inputRows, manifest.rows, manifest.duplicateRows, rejectCount, importId,
        );
      });
      return { ok: true, idempotent: true, importId, priorImportId: exactPrior.import_id, manifest, dbPath };
    }

    let insertedRows = 0;
    transact(db, () => {
      const insertActive = db.prepare(`
        INSERT INTO historical_events(source_event_id, import_id, inserted_at)
        SELECT source_event_id, ?, ?
        FROM historical_event_payloads WHERE import_id=?
        ON CONFLICT(source_event_id) DO NOTHING
      `);
      insertedRows = Number(insertActive.run(
        importId, completedAt, importId,
      ).changes || 0);
      db.prepare(`
          UPDATE historical_event_imports SET source_dataset=?, source_file_sha256=?, manifest_json=?, manifest_sha256=?,
            manifest_root_hash=?, status='active', completed_at=?, input_rows=?, accepted_rows=?,
            duplicate_rows=?, rejected_rows=?, conflict_rows=0 WHERE import_id=?
      `).run(
        manifest.sourceDataset, sourceFileSha256, canonicalJson(manifest), manifestSha256, manifest.rootHash, completedAt,
        manifest.inputRows, manifest.rows, manifest.duplicateRows, rejectCount, importId,
      );
      const activated = db.prepare("SELECT * FROM historical_event_imports WHERE import_id=?").get(importId);
      verifyActiveImportIntegrity(db, activated, {
        sourceDataset: manifest.sourceDataset,
        sourceFileSha256,
        importStrategySha256,
      });
    });
    return {
      ok: true,
      idempotent: false,
      importId,
      insertedRows,
      existingRows: manifest.rows - insertedRows,
      manifest,
      manifestSha256,
      dbPath,
    };
  } catch (error) {
    try {
      const current = db.prepare("SELECT status FROM historical_event_imports WHERE import_id=?").get(importId);
      if (current?.status === "staging") {
        transact(db, () => {
          db.prepare("DELETE FROM historical_event_payloads WHERE import_id=?").run(importId);
          db.prepare(`
            UPDATE historical_event_imports SET status='blocked', completed_at=?,
              error_code=?, error_message=? WHERE import_id=?
          `).run(completedAt, error.code || "IMPORT_FAILED", String(error.message || error), importId);
        });
      }
    } catch {
      // Preserve the original failure; an unfinalized staging import is never query-visible.
    }
    if (error instanceof HistoricalWarehouseError || error instanceof HistoricalEventConflictError) throw error;
    throw new HistoricalWarehouseError(String(error.message || error), { code: error.code || "IMPORT_FAILED", cause: error });
  } finally {
    try { db.close(); } catch { /* no-op */ }
  }
}

function queryHistoricalEventsAsOf({
  dbPath,
  forecastTime,
  limit = 100000,
  sourceDataset = null,
  allowDerivedAvailability = false,
} = {}) {
  const forecast = canonicalIso(forecastTime, "forecastTime");
  const normalizedSourceDataset = sourceDataset
    ? DATASET_CONFIGS[String(sourceDataset)]?.sourceDataset || String(sourceDataset)
    : null;
  const safeLimit = Math.max(1, Math.min(1000000, Math.trunc(Number(limit) || 100000)));
  const derivedAvailabilityAllowed = allowDerivedAvailability === true;
  const { db, dbPath: resolved } = openWarehouse(dbPath, { readOnly: true });
  try {
    assertWarehouseSchema(db);
    const clauses = ["p.available_at<=?", "i.status='active'"];
    const params = [forecast];
    if (normalizedSourceDataset) {
      clauses.push("i.source_dataset=?");
      params.push(normalizedSourceDataset);
    }
    if (!derivedAvailabilityAllowed) clauses.push("i.availability_mode<>'derived'");
    const rows = db.prepare(`
      SELECT e.source_event_id, e.import_id, p.event_sha256, p.event_payload,
             p.event_payload_encoding, p.event_json_sha256, p.event_json_bytes,
             p.event_payload_bytes, p.available_at, p.availability_commitment_sha256
      FROM historical_events e
      JOIN historical_event_payloads p
        ON p.import_id=e.import_id AND p.source_event_id=e.source_event_id
      JOIN historical_event_imports i ON i.import_id=e.import_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY p.available_at, e.source_event_id LIMIT ?
    `).all(...params, safeLimit);
    let derivedRowsExcluded = 0;
    if (!derivedAvailabilityAllowed) {
      const exclusionClauses = ["p.available_at<=?", "i.status='active'", "i.availability_mode='derived'"];
      const exclusionParams = [forecast];
      if (normalizedSourceDataset) {
        exclusionClauses.push("i.source_dataset=?");
        exclusionParams.push(normalizedSourceDataset);
      }
      derivedRowsExcluded = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM historical_events e
        JOIN historical_event_payloads p
          ON p.import_id=e.import_id AND p.source_event_id=e.source_event_id
        JOIN historical_event_imports i ON i.import_id=e.import_id
        WHERE ${exclusionClauses.join(" AND ")}
      `).get(...exclusionParams)?.count || 0);
    }
    const verifiedImports = new Map();
    const events = rows.map((row) => {
      if (!verifiedImports.has(row.import_id)) {
        const importRow = db.prepare("SELECT * FROM historical_event_imports WHERE import_id=?").get(row.import_id);
        verifiedImports.set(row.import_id, verifyActiveImportIntegrity(db, importRow));
      }
      const verifiedImport = verifiedImports.get(row.import_id);
      const expectedAvailabilityCommitment = availabilityCommitmentFor({
        sourceEventId: row.source_event_id,
        eventSha256: row.event_sha256,
        availableAt: row.available_at,
        importStrategySha256: verifiedImport.strategyHash,
      });
      if (row.availability_commitment_sha256 !== expectedAvailabilityCommitment) {
        throw new HistoricalWarehouseError("as-of row availability commitment failed integrity checks", {
          code: "QUERY_INTEGRITY_FAILURE",
        });
      }
      const sourceEvent = decodeEventPayload(row);
      const parsed = trainingProjection(
        sourceEvent,
        row.available_at,
        storedAvailabilityProvenance(
          sourceEvent,
          row.available_at,
          verifiedImport.strategy,
          verifiedImport.strategyHash,
        ),
      );
      assertNoForbiddenFeatureKeys(parsed);
      if (semanticEventHash(sourceEvent) !== row.event_sha256
          || parsed.sourceEventId !== row.source_event_id
          || parsed.availableAt !== row.available_at
          || parsed.availableAt > forecast) {
        throw new HistoricalWarehouseError("stored as-of projection failed integrity checks", { code: "QUERY_INTEGRITY_FAILURE" });
      }
      return parsed;
    });
    return {
      version: QUERY_SCHEMA_VERSION,
      forecastTime: forecast,
      sourceDataset: normalizedSourceDataset,
      queryPolicy: derivedAvailabilityAllowed ? "exploratory-derived-opt-in" : "strict-explicit-observation-only",
      rows: events.length,
      events,
      integrity: {
        asOfVerified: true,
        projectionOnly: true,
        forbiddenPostMatchFieldsExcluded: true,
        availabilityCommitmentVerified: true,
        derivedAvailabilityAllowed,
        derivedRowsExcluded,
      },
      dbPath: resolved,
    };
  } finally {
    try { db.close(); } catch { /* no-op */ }
  }
}

function historicalWarehouseStatus(dbPath) {
  const { db, dbPath: resolved } = openWarehouse(dbPath, { readOnly: true });
  try {
    assertWarehouseSchema(db);
    const scalar = (sql) => Number(db.prepare(sql).get()?.count || 0);
    const storage = db.prepare(`
      SELECT COALESCE(SUM(p.event_json_bytes), 0) AS raw_bytes,
             COALESCE(SUM(p.event_payload_bytes), 0) AS compressed_bytes
      FROM historical_event_payloads p
      JOIN historical_event_imports i USING(import_id)
      WHERE i.status='active'
    `).get();
    const rawBytes = Number(storage.raw_bytes || 0);
    const compressedBytes = Number(storage.compressed_bytes || 0);
    return {
      version: WAREHOUSE_SCHEMA_VERSION,
      dbPath: resolved,
      events: scalar("SELECT COUNT(*) AS count FROM historical_events"),
      imports: Object.fromEntries(db.prepare(`
        SELECT status, COUNT(*) AS count FROM historical_event_imports GROUP BY status ORDER BY status
      `).all().map((row) => [row.status, Number(row.count)])),
      conflicts: scalar("SELECT COUNT(*) AS count FROM historical_event_conflicts"),
      rejections: scalar("SELECT COUNT(*) AS count FROM historical_event_rejections"),
      stagingRows: scalar(`
        SELECT COUNT(*) AS count FROM historical_event_payloads p
        JOIN historical_event_imports i USING(import_id) WHERE i.status='staging'
      `),
      storage: {
        encoding: EVENT_PAYLOAD_ENCODING,
        rawEventJsonBytes: rawBytes,
        compressedEventBytes: compressedBytes,
        payloadCompressionRatio: rawBytes > 0 ? compressedBytes / rawBytes : null,
        bytesSaved: Math.max(0, rawBytes - compressedBytes),
        databaseBytes: fs.statSync(resolved).size,
      },
    };
  } finally {
    try { db.close(); } catch { /* no-op */ }
  }
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_RESULT_DELAY_MS,
  EVENT_PAYLOAD_ENCODING,
  HistoricalWarehouseError,
  QUERY_SCHEMA_VERSION,
  WAREHOUSE_SCHEMA_VERSION,
  ensureHistoricalTrainingSchema,
  encodeEventPayload,
  historicalWarehouseStatus,
  importHistoricalCsvToWarehouse,
  queryHistoricalEventsAsOf,
  semanticEventHash,
  trainingProjection,
};
