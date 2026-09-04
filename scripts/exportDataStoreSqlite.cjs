const fs = require("node:fs");
const path = require("node:path");
const {
  PREDICTION_STATE_IDENTITY_VERSION,
  asText,
  canonicalOddsState,
  canonicalPredictionState,
  earliestIso,
  hashPayload,
  latestIso,
  mergeCanonicalOddsStates,
  mergeCanonicalPredictionStates,
  readJsonPayload,
  sourceMatchIdFor,
  timestampMs,
} = require("./sqliteWarehouse.cjs");
const {
  ensurePrivateModelArtifactTable,
} = require("./privateModelArtifactStore.cjs");
const {
  applyFastResultObservation,
  findFastResultObservation,
  trustedOfficialFinal,
} = require("./fastResultObservations.cjs");
const {
  resolveFastResultReceiptAuthorities,
} = require("./fastResultReceiptAuthority.cjs");
const {
  readFastResultReceiptState,
} = require("./fastResultReceiptIntegrity.cjs");
const {
  migrateLegacyFastResultIntegrity,
} = require("./publishOfficialResultsFast.cjs");
const {
  authorityHighWaterBindsResult,
  authorityHighWaterRow,
  authorityIdentityKey,
  loadAuthorityHighWater,
} = require("./fastResultAuthorityHighWater.cjs");
const {
  eventVersionOf,
} = require("../src/services/matchLifecycle.cjs");
const {
  assertActivePublicationUnchanged,
  commitWithActivePublicationPointerLock,
  readPublicationJson,
  resolveActivePublication,
} = require("../server/dataGenerationBundle.cjs");
const {
  acquirePointerCommitLock,
  storePaths,
} = require("../server/dataGenerationStore.cjs");
const {
  attachArchivedPreMatchPredictions,
} = require("./syncData.cjs");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  console.error("node:sqlite is unavailable. Use Node.js 22+ for SQLite export.");
  console.error(error.message || String(error));
  process.exit(1);
}

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.resolve(process.env.SQLITE_EXPORT_PUBLIC_DATA_DIR || path.join(rootDir, "public", "data"));
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data"));
const jsonlDbDir = path.join(storeDir, "db");
const dbPath = path.resolve(process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db"));
const oddsLimit = Math.max(1000, Number(process.env.SQLITE_EXPORT_ODDS_LIMIT || 50000));
const predictionLimit = Math.max(500, Number(process.env.SQLITE_EXPORT_PREDICTION_LIMIT || 10000));
const jsonlMatchLimit = Math.max(0, Number(process.env.SQLITE_IMPORT_JSONL_MATCH_LIMIT || 20000));
const jsonlOddsLimit = Math.max(0, Number(process.env.SQLITE_IMPORT_JSONL_ODDS_LIMIT || oddsLimit));
const jsonlPredictionLimit = Math.max(0, Number(process.env.SQLITE_IMPORT_JSONL_PREDICTION_LIMIT || predictionLimit));
const jsonlSyncLimit = Math.max(0, Number(process.env.SQLITE_IMPORT_JSONL_SYNC_LIMIT || 2000));
const oddsStateLimit = Math.max(1000, Number(process.env.SQLITE_ODDS_STATE_LIMIT || Math.max(oddsLimit, jsonlOddsLimit)));
const predictionStateLimit = Math.max(500, Number(process.env.SQLITE_PREDICTION_STATE_LIMIT || Math.max(50000, predictionLimit, jsonlPredictionLimit)));
const sqliteBusyTimeoutMs = Math.max(1000, Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 60000));
const sqliteExportAttempts = Math.max(1, Number(process.env.SQLITE_EXPORT_ATTEMPTS || 3));
const sqliteExportRetryDelayMs = Math.max(1000, Number(process.env.SQLITE_EXPORT_RETRY_DELAY_MS || 5000));
const sourcePointerReadOnly = process.env.SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY === "1";
const SQLITE_SCHEMA_VERSION = "football-sqlite-v2-incremental";
const ACTIVE_GENERATION_FAST_PATH_VERSION = "sqlite-active-generation-clone-fast-path-v1";
const expectedWarehousePolicy = Object.freeze({
  version: 3,
  mode: "incremental-upsert",
  oddsIdentity: "sourceMatchId+bookmaker+pool+line+threeOdds",
  predictionIdentity: "sourceMatchId+phase+signature+featureHash",
  predictionObservationPolicy: "firstSeenAt/lastSeenAt/seenCount are observation metadata, not independent samples",
  jsonlImport: "byte-cursor-v2",
  oddsStateLimit,
  predictionStateLimit,
});
const ACTIVE_GENERATION_FAST_PATH_META_KEYS = Object.freeze([
  "schema_version",
  "prediction_state_identity_version",
  "warehouse_policy",
  "data_publication_mode",
  "data_generation_id",
  "manifest_hash",
  "data_generation_source_cycle_id",
  "committed_at",
  "fast_result_generation_reconciliation",
]);
const ACTIVE_GENERATION_FAST_PATH_REQUIRED_TABLES = Object.freeze([
  "schema_meta",
  "source_snapshots",
  "match_snapshots",
  "odds_snapshots",
  "prediction_snapshots",
  "private_model_artifacts",
]);

const normalizedAbsolutePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
};

const sameResolvedPath = (left, right) => (
  normalizedAbsolutePath(left) === normalizedAbsolutePath(right)
);

const pathTargetsSameFile = (left, right) => {
  try {
    if (sameResolvedPath(fs.realpathSync(left), fs.realpathSync(right))) return true;
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return Number(leftStat.dev) === Number(rightStat.dev)
      && Number(leftStat.ino) === Number(rightStat.ino);
  } catch {
    return false;
  }
};

const jsonlFiles = {
  syncRuns: path.join(jsonlDbDir, "sync-runs.jsonl"),
  matchSnapshots: path.join(jsonlDbDir, "match-snapshots.jsonl"),
  oddsSnapshots: path.join(jsonlDbDir, "odds-snapshots.jsonl"),
  predictionRuns: path.join(jsonlDbDir, "prediction-runs.jsonl"),
};

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

// Resolve the publication exactly once.  When a generation pointer exists,
// every core input below is read from that immutable directory.  A missing
// pointer is the only condition that permits legacy mutable-file bootstrap;
// a corrupt pointer throws and prevents an unsafe fallback.
const inputPublication = resolveActivePublication({ storeDir, publicDataDir });
const generationInputActive = inputPublication.mode === "active-generation";
const inputSyncMeta = readPublicationJson(inputPublication, "sync-meta.json", null);
if (sourcePointerReadOnly && !generationInputActive) {
  throw new Error("read-only source-pointer export requires an immutable active generation");
}

const fastResultGenerationReconciliationStamp = (syncMeta) => {
  const reconciliation = syncMeta?.fastResultGenerationReconciliation;
  const revision = Number(syncMeta?.fastResultGenerationRevision || 0);
  if (
    reconciliation?.version !== "fast-result-generation-reconciliation-v1"
    || !Number.isSafeInteger(revision)
    || revision <= 0
    || Number(reconciliation.receiptRevision || 0) !== revision
  ) return "";
  return JSON.stringify({
    version: reconciliation.version,
    receiptRevision: revision,
    publishedAt: asText(reconciliation.publishedAt) || null,
    sourceCycleId: asText(reconciliation.sourceCycleId) || null,
    datasetRevision: asText(reconciliation.datasetRevision) || null,
  });
};

const inputFastResultGenerationReconciliationStamp = generationInputActive
  ? fastResultGenerationReconciliationStamp(inputSyncMeta)
  : "";

const readActiveGenerationFastPathMeta = (database) => {
  const placeholders = ACTIVE_GENERATION_FAST_PATH_META_KEYS.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT key, value FROM schema_meta WHERE key IN (${placeholders})`
  ).all(...ACTIVE_GENERATION_FAST_PATH_META_KEYS);
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value ?? "")]));
};

const activeGenerationFastPathMetaMismatch = (meta) => {
  const identityChecks = [
    ["data_publication_mode", inputPublication.identity.mode],
    ["data_generation_id", inputPublication.identity.generationId || ""],
    ["manifest_hash", inputPublication.identity.manifestHash || ""],
    ["data_generation_source_cycle_id", inputPublication.identity.sourceCycleId || ""],
    ["committed_at", inputPublication.identity.committedAt || ""],
    ["fast_result_generation_reconciliation", inputFastResultGenerationReconciliationStamp],
  ];
  for (const [key, expected] of identityChecks) {
    if (meta[key] !== String(expected)) return `identity-mismatch:${key}`;
  }
  if (meta.schema_version !== SQLITE_SCHEMA_VERSION) return "schema-version-mismatch";
  if (meta.prediction_state_identity_version !== PREDICTION_STATE_IDENTITY_VERSION) {
    return "prediction-identity-version-mismatch";
  }
  let warehousePolicy = null;
  try {
    warehousePolicy = JSON.parse(meta.warehouse_policy || "null");
  } catch {
    return "warehouse-policy-invalid";
  }
  const expectedPolicyKeys = Object.keys(expectedWarehousePolicy).sort();
  const actualPolicyKeys = warehousePolicy
    && typeof warehousePolicy === "object"
    && !Array.isArray(warehousePolicy)
    ? Object.keys(warehousePolicy).sort()
    : [];
  const policyMatches = actualPolicyKeys.length === expectedPolicyKeys.length
    && expectedPolicyKeys.every((key, index) => (
      actualPolicyKeys[index] === key
      && typeof warehousePolicy[key] === typeof expectedWarehousePolicy[key]
      && warehousePolicy[key] === expectedWarehousePolicy[key]
    ));
  return policyMatches ? null : "warehouse-policy-mismatch";
};

const inspectActiveGenerationFastPath = () => {
  const base = {
    version: ACTIVE_GENERATION_FAST_PATH_VERSION,
    requested: sourcePointerReadOnly,
    activeGeneration: generationInputActive,
    eligible: false,
    reason: null,
    preservesFastResultOverlay: true,
    publication: {
      mode: inputPublication.identity.mode,
      generationId: inputPublication.identity.generationId || null,
      manifestHash: inputPublication.identity.manifestHash || null,
      sourceCycleId: inputPublication.identity.sourceCycleId || null,
      committedAt: inputPublication.identity.committedAt || null,
    },
    cloneFileIdentity: null,
  };
  const reject = (reason) => Object.freeze({ ...base, reason });
  if (!sourcePointerReadOnly) return reject("source-pointer-is-writable");
  if (!generationInputActive) return reject("publication-is-not-active-generation");
  const liveDbPath = path.resolve(storeDir, "football.db");
  if (sameResolvedPath(dbPath, liveDbPath)) {
    return reject("clone-path-is-live-database");
  }
  if (!fs.existsSync(dbPath)) return reject("clone-database-missing");

  let probe = null;
  try {
    const stat = fs.lstatSync(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      return reject("clone-database-unsafe");
    }
    // A differently-spelled path (Windows case folding), a parent-directory
    // symlink, or a hard link must not turn the canonical live database into a
    // release clone.  Compare resolved targets and filesystem identity before
    // opening the candidate writable later in the process.
    if (pathTargetsSameFile(dbPath, liveDbPath)) {
      return reject("clone-path-is-live-database");
    }
    probe = new DatabaseSync(dbPath, { readOnly: true });
    const tablePlaceholders = ACTIVE_GENERATION_FAST_PATH_REQUIRED_TABLES.map(() => "?").join(", ");
    const presentTables = new Set(probe.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tablePlaceholders})`
    ).all(...ACTIVE_GENERATION_FAST_PATH_REQUIRED_TABLES).map((row) => String(row.name)));
    const missingTable = ACTIVE_GENERATION_FAST_PATH_REQUIRED_TABLES.find((name) => !presentTables.has(name));
    if (missingTable) return reject(`required-table-missing:${missingTable}`);
    const mismatch = activeGenerationFastPathMetaMismatch(readActiveGenerationFastPathMeta(probe));
    if (mismatch) return reject(mismatch);
    return Object.freeze({
      ...base,
      eligible: true,
      reason: "exact-active-generation-clone",
      cloneFileIdentity: Object.freeze({
        dev: Number(stat.dev),
        ino: Number(stat.ino),
        realPath: normalizedAbsolutePath(fs.realpathSync(dbPath)),
      }),
    });
  } catch (error) {
    return reject(`clone-probe-failed:${String(error?.code || error?.name || "unknown")}`);
  } finally {
    try { probe?.close(); } catch { /* preserve the eligibility decision */ }
  }
};

const activeGenerationFastPathFileMismatch = () => {
  const expected = activeGenerationFastPath.cloneFileIdentity;
  if (!expected) return "clone-file-identity-missing";
  try {
    const actual = fs.lstatSync(dbPath);
    if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1) {
      return "clone-database-unsafe";
    }
    if (
      Number(actual.dev) !== expected.dev
      || Number(actual.ino) !== expected.ino
      || normalizedAbsolutePath(fs.realpathSync(dbPath)) !== expected.realPath
    ) return "clone-file-changed";
    return null;
  } catch (error) {
    return `clone-file-recheck-failed:${String(error?.code || error?.name || "unknown")}`;
  }
};

// Decide before parsing any of the large base projection JSON files.  A
// release clone whose transactional schema metadata names this exact immutable
// generation already contains every base row.  Replaying it would only parse
// and compare tens of thousands of unchanged payloads and can also regress a
// newer fast-result overlay that intentionally lives above the base cycle.
const activeGenerationFastPath = inspectActiveGenerationFastPath();
if (process.env.SQLITE_EXPORT_LOG_PREFLIGHT === "1") {
  console.log(JSON.stringify({
    sqliteExportPreflight: {
      version: activeGenerationFastPath.version,
      requested: activeGenerationFastPath.requested,
      activeGeneration: activeGenerationFastPath.activeGeneration,
      eligible: activeGenerationFastPath.eligible,
      reason: activeGenerationFastPath.reason,
      publication: activeGenerationFastPath.publication,
    },
  }, null, 2));
}
const loadBaseProjection = !activeGenerationFastPath.eligible;
const readCoreJson = (relativePath, fallback) => readPublicationJson(
  inputPublication,
  relativePath,
  fallback,
);
const collectReleasedPayloads = () => {
  if (typeof global.gc === "function") global.gc();
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Older live caches predate the monotonic review clock.  Import them as the
// first known revision, using the review's own persisted generation time.  Do
// not use the export time and do not repair explicit invalid values: both
// would turn corrupt data into a fabricated revision instead of failing the
// readiness gate closed.
const normalizeLegacyReviewClock = (match) => {
  const review = match?.postMatchReview;
  if (!review || typeof review !== "object" || Array.isArray(review)) return match;

  const generatedAt = String(review.generatedAt || "").trim();
  if (!Number.isFinite(Date.parse(generatedAt))) return match;

  if (hasOwn(review, "settlement") && (
    !review.settlement
    || typeof review.settlement !== "object"
    || Array.isArray(review.settlement)
  )) return match;

  const settlement = review.settlement || {};
  const revisionMissing = !hasOwn(settlement, "resultRevision");
  const generatedAtMissing = !hasOwn(settlement, "reviewGeneratedAt");
  if (!revisionMissing && !generatedAtMissing) return match;

  return {
    ...match,
    postMatchReview: {
      ...review,
      settlement: {
        ...settlement,
        ...(revisionMissing ? { resultRevision: 1 } : {}),
        ...(generatedAtMissing ? { reviewGeneratedAt: generatedAt } : {}),
      },
    },
  };
};

// The mutable JSON feed can cross kickoff between sync cycles while its
// original pre-match snapshot is already immutable. Materialize that archive
// into the SQLite projection in memory so list/detail reads do not lose the
// frozen direction merely because the next full sync has not run yet. The
// helper only accepts same-event, pre-cutoff snapshots and preserves an
// existing valid archive, so this cannot manufacture or rewrite a decision.
const archiveProjectionObservedAt = new Date().toISOString();
const materializeArchiveProjection = (rows, predictionSnapshotsPayload) => (
  Array.isArray(rows)
    ? attachArchivedPreMatchPredictions(
        rows,
        predictionSnapshotsPayload,
        null,
        archiveProjectionObservedAt,
      )
    : null
);

const matchPayloadForJsonl = (row) => (
  row?.match && typeof row.match === "object" && !Array.isArray(row.match)
    ? row.match
    : row?.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? row.payload
      : row
);

const capturedAtFor = (row) => row?.capturedAt
  || row?.captureBucket
  || row?.oddsUpdatedAt
  || row?.updatedAt
  || row?.lastSeenAt
  || row?.finishedAt
  || row?.at
  || null;

const legacyDatasetFor = (row) => {
  const dataset = asText(row?.dataset || row?.phase || "snapshot")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `jsonl-${dataset || "snapshot"}`;
};

const syncMetaDataVersion = (meta) => {
  for (const value of [
    meta?.api?.currentFreshnessTime,
    meta?.api?.historyFreshnessTime,
    meta?.api?.freshnessTime,
    meta?.updatedAt,
    meta?.capturedAt,
    meta?.lastAttemptAt,
  ]) {
    const time = Date.parse(value || "");
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return "";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isSqliteBusy = (error) => {
  const message = String(error?.message || error || "");
  return error?.code === "SQLITE_BUSY" || /database is locked|database is busy|SQLITE_BUSY/i.test(message);
};

const closeDatabase = (database) => {
  try {
    database?.close();
  } catch {
    // Closing an already closed maintenance handle is harmless.
  }
};

const sqlQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

const tableExists = (db, table) => Boolean(db.prepare(
  "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
).get(table));

const tableColumns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));

const ensureBaseSchema = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_snapshots (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      captured_at TEXT,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_snapshots (
      id TEXT PRIMARY KEY,
      dataset TEXT NOT NULL,
      match_id TEXT,
      source_match_id TEXT,
      kickoff_time TEXT,
      status TEXT,
      payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_match_snapshots_match_id ON match_snapshots(match_id);
    CREATE INDEX IF NOT EXISTS idx_match_snapshots_source_match_id ON match_snapshots(source_match_id);
    CREATE INDEX IF NOT EXISTS idx_match_snapshots_dataset_source_match_id
      ON match_snapshots(dataset, source_match_id);
    CREATE INDEX IF NOT EXISTS idx_match_snapshots_kickoff_time ON match_snapshots(kickoff_time);
    CREATE INDEX IF NOT EXISTS idx_match_snapshots_dataset_kickoff
      ON match_snapshots(dataset, kickoff_time DESC, match_id);
  `);
  // This table is intentionally outside the incremental warehouse pruning
  // paths. Model audit writes own their rows and the exporter only ensures the
  // integrity-constrained schema exists.
  ensurePrivateModelArtifactTable(db);
};

const createOddsTable = (db, table = "odds_snapshots") => {
  db.exec(`
    CREATE TABLE ${table} (
      id TEXT PRIMARY KEY,
      state_key TEXT UNIQUE,
      match_id TEXT,
      source_match_id TEXT,
      pool TEXT,
      bookmaker TEXT,
      handicap_line REAL,
      captured_at TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL
    )
  `);
};

const createPredictionTable = (db, table = "prediction_snapshots") => {
  db.exec(`
    CREATE TABLE ${table} (
      id TEXT PRIMARY KEY,
      state_key TEXT UNIQUE,
      match_id TEXT,
      source_match_id TEXT,
      phase TEXT,
      captured_at TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL
    )
  `);
};

const ensureWarehouseIndexes = (db) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_odds_snapshots_match_id ON odds_snapshots(match_id);
    CREATE INDEX IF NOT EXISTS idx_odds_snapshots_source_pool_time
      ON odds_snapshots(source_match_id, pool, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_odds_snapshots_last_seen
      ON odds_snapshots(last_seen_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_match_id ON prediction_snapshots(match_id);
    CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_source_phase_time
      ON prediction_snapshots(source_match_id, phase, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_last_seen
      ON prediction_snapshots(last_seen_at DESC, id);
  `);
};

const trimStateMap = (states, limit) => {
  if (states.size <= limit * 2) return;
  const kept = Array.from(states.values())
    .sort((left, right) => timestampMs(right.lastSeenAt || right.capturedAt) - timestampMs(left.lastSeenAt || left.capturedAt))
    .slice(0, limit);
  states.clear();
  for (const state of kept) states.set(state.id, state);
};

const insertOddsStateStatement = (db, table) => db.prepare(`
  INSERT INTO ${table}
    (id, state_key, match_id, source_match_id, pool, bookmaker, handicap_line,
     captured_at, first_seen_at, last_seen_at, seen_count, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    state_key = excluded.state_key,
    match_id = excluded.match_id,
    source_match_id = excluded.source_match_id,
    pool = excluded.pool,
    bookmaker = excluded.bookmaker,
    handicap_line = excluded.handicap_line,
    captured_at = excluded.captured_at,
    first_seen_at = excluded.first_seen_at,
    last_seen_at = excluded.last_seen_at,
    seen_count = excluded.seen_count,
    payload = excluded.payload
  WHERE ${table}.state_key IS NOT excluded.state_key
     OR ${table}.match_id IS NOT excluded.match_id
     OR ${table}.source_match_id IS NOT excluded.source_match_id
     OR ${table}.pool IS NOT excluded.pool
     OR ${table}.bookmaker IS NOT excluded.bookmaker
     OR ${table}.handicap_line IS NOT excluded.handicap_line
     OR ${table}.captured_at IS NOT excluded.captured_at
     OR ${table}.first_seen_at IS NOT excluded.first_seen_at
     OR ${table}.last_seen_at IS NOT excluded.last_seen_at
     OR ${table}.seen_count IS NOT excluded.seen_count
     OR ${table}.payload <> excluded.payload
`);

const runOddsStateInsert = (statement, state) => statement.run(
  state.id,
  state.stateKey,
  state.matchId || null,
  state.sourceMatchId || null,
  state.pool || null,
  state.bookmaker || null,
  Number.isFinite(Number(state.handicapLine)) ? Number(state.handicapLine) : null,
  state.capturedAt || null,
  state.firstSeenAt || state.capturedAt || null,
  state.lastSeenAt || state.capturedAt || null,
  Math.max(1, Number(state.seenCount || 1)),
  JSON.stringify(state.payload)
);

const insertPredictionStateStatement = (db, table) => db.prepare(`
  INSERT INTO ${table}
    (id, state_key, match_id, source_match_id, phase, captured_at,
     first_seen_at, last_seen_at, seen_count, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    state_key = excluded.state_key,
    match_id = excluded.match_id,
    source_match_id = excluded.source_match_id,
    phase = excluded.phase,
    captured_at = excluded.captured_at,
    first_seen_at = excluded.first_seen_at,
    last_seen_at = excluded.last_seen_at,
    seen_count = excluded.seen_count,
    payload = excluded.payload
  WHERE ${table}.state_key IS NOT excluded.state_key
     OR ${table}.match_id IS NOT excluded.match_id
     OR ${table}.source_match_id IS NOT excluded.source_match_id
     OR ${table}.phase IS NOT excluded.phase
     OR ${table}.captured_at IS NOT excluded.captured_at
     OR ${table}.first_seen_at IS NOT excluded.first_seen_at
     OR ${table}.last_seen_at IS NOT excluded.last_seen_at
     OR ${table}.seen_count IS NOT excluded.seen_count
     OR ${table}.payload <> excluded.payload
`);

const runPredictionStateInsert = (statement, state) => statement.run(
  state.id,
  state.stateKey,
  state.matchId || null,
  state.sourceMatchId || null,
  state.phase || null,
  state.capturedAt || null,
  state.firstSeenAt || state.capturedAt || null,
  state.lastSeenAt || state.capturedAt || null,
  Math.max(1, Number(state.seenCount || 1)),
  JSON.stringify(state.payload)
);

const rawOddsRecord = (row, namespace = "raw") => {
  const payload = readJsonPayload(row?.payload) || row || {};
  const capturedAt = capturedAtFor(payload) || row?.captured_at || null;
  const legacyId = asText(row?.id) || hashPayload(payload);
  return {
    id: `odds-raw-v2:${hashPayload(`${namespace}|${legacyId}`)}`,
    stateKey: null,
    matchId: row?.match_id || payload.matchId || null,
    sourceMatchId: row?.source_match_id || payload.sourceMatchId || sourceMatchIdFor(payload.matchId) || null,
    pool: row?.pool || payload.pool || payload.poolCode || payload.oddsPoolCode || null,
    bookmaker: row?.bookmaker || payload.bookmaker || null,
    handicapLine: row?.handicap_line ?? payload.handicapLine ?? payload.handicap ?? null,
    capturedAt,
    firstSeenAt: capturedAt,
    lastSeenAt: payload.lastSeenAt || capturedAt,
    seenCount: Math.max(1, Number(payload.seenCount || 1)),
    payload,
  };
};

const rawPredictionRecord = (row, namespace = "raw") => {
  const payload = readJsonPayload(row?.payload) || row || {};
  const capturedAt = capturedAtFor(payload) || row?.captured_at || null;
  const legacyId = asText(row?.id) || hashPayload(payload);
  return {
    id: `prediction-raw-v2:${hashPayload(`${namespace}|${legacyId}`)}`,
    stateKey: null,
    matchId: row?.match_id || payload.matchId || null,
    sourceMatchId: row?.source_match_id || payload.sourceMatchId || null,
    phase: row?.phase || payload.phase || null,
    capturedAt,
    firstSeenAt: payload.firstSeenAt || capturedAt,
    lastSeenAt: payload.lastSeenAt || capturedAt,
    seenCount: Math.max(1, Number(payload.seenCount || 1)),
    payload,
  };
};

const migrateOddsTable = (db) => {
  if (!tableExists(db, "odds_snapshots")) {
    createOddsTable(db);
    return { created: true, migrated: false, scanned: 0, canonicalStates: 0, rawRows: 0 };
  }
  const columns = tableColumns(db, "odds_snapshots");
  if (["state_key", "first_seen_at", "last_seen_at", "seen_count"].every((column) => columns.has(column))) {
    return { created: false, migrated: false, scanned: 0, canonicalStates: 0, rawRows: 0 };
  }

  db.exec("DROP TABLE IF EXISTS odds_snapshots_v2");
  createOddsTable(db, "odds_snapshots_v2");
  const canonicalStates = new Map();
  const rawInsert = insertOddsStateStatement(db, "odds_snapshots_v2");
  let scanned = 0;
  let rawRows = 0;
  const rows = db.prepare("SELECT * FROM odds_snapshots ORDER BY captured_at ASC, id ASC").iterate();
  for (const row of rows) {
    scanned += 1;
    const state = canonicalOddsState(row);
    if (state) {
      canonicalStates.set(state.id, mergeCanonicalOddsStates(canonicalStates.get(state.id), state));
      trimStateMap(canonicalStates, oddsStateLimit);
    } else {
      runOddsStateInsert(rawInsert, rawOddsRecord(row, "sqlite-v1"));
      rawRows += 1;
    }
  }
  const keptStates = Array.from(canonicalStates.values())
    .sort((left, right) => timestampMs(right.lastSeenAt) - timestampMs(left.lastSeenAt))
    .slice(0, oddsStateLimit);
  for (const state of keptStates) runOddsStateInsert(rawInsert, state);

  db.exec(`
    ALTER TABLE odds_snapshots RENAME TO odds_snapshots_v1_backup;
    ALTER TABLE odds_snapshots_v2 RENAME TO odds_snapshots;
    DROP TABLE odds_snapshots_v1_backup;
  `);
  return { created: false, migrated: true, scanned, canonicalStates: keptStates.length, rawRows };
};

const migratePredictionTable = (db, forceIdentityMigration = false) => {
  if (!tableExists(db, "prediction_snapshots")) {
    createPredictionTable(db);
    return { created: true, migrated: false, scanned: 0, canonicalStates: 0, rawRows: 0 };
  }
  const columns = tableColumns(db, "prediction_snapshots");
  if (!forceIdentityMigration && ["state_key", "first_seen_at", "last_seen_at", "seen_count"].every((column) => columns.has(column))) {
    return { created: false, migrated: false, scanned: 0, canonicalStates: 0, rawRows: 0 };
  }

  db.exec("DROP TABLE IF EXISTS prediction_snapshots_v2");
  createPredictionTable(db, "prediction_snapshots_v2");
  const states = new Map();
  const insert = insertPredictionStateStatement(db, "prediction_snapshots_v2");
  let scanned = 0;
  let rawRows = 0;
  const rows = db.prepare("SELECT * FROM prediction_snapshots ORDER BY captured_at ASC, id ASC").iterate();
  for (const row of rows) {
    scanned += 1;
    const state = canonicalPredictionState(row);
    if (state) {
      states.set(state.id, mergeCanonicalPredictionStates(states.get(state.id), state));
      trimStateMap(states, predictionStateLimit);
    } else {
      runPredictionStateInsert(insert, rawPredictionRecord(row, "sqlite-v1"));
      rawRows += 1;
    }
  }
  const keptStates = Array.from(states.values())
    .sort((left, right) => timestampMs(right.lastSeenAt) - timestampMs(left.lastSeenAt))
    .slice(0, predictionStateLimit);
  for (const state of keptStates) runPredictionStateInsert(insert, state);

  db.exec(`
    ALTER TABLE prediction_snapshots RENAME TO prediction_snapshots_v1_backup;
    ALTER TABLE prediction_snapshots_v2 RENAME TO prediction_snapshots;
    DROP TABLE prediction_snapshots_v1_backup;
  `);
  return { created: false, migrated: true, scanned, canonicalStates: keptStates.length, rawRows };
};

const ensureWarehouseV2 = (db) => {
  const odds = migrateOddsTable(db);
  const predictionIdentityVersion = db.prepare(
    "SELECT value FROM schema_meta WHERE key = 'prediction_state_identity_version'"
  ).get()?.value || null;
  const predictions = migratePredictionTable(
    db,
    predictionIdentityVersion !== PREDICTION_STATE_IDENTITY_VERSION
  );
  db.prepare(`
    INSERT INTO schema_meta (key, value, updated_at)
    VALUES ('prediction_state_identity_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    WHERE schema_meta.value <> excluded.value
  `).run(PREDICTION_STATE_IDENTITY_VERSION, new Date().toISOString());
  ensureWarehouseIndexes(db);
  return { odds, predictions, performed: odds.migrated || predictions.migrated };
};

const getMeta = (db, key) => db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key)?.value || null;

const upsertMeta = (db, key, value, updatedAt) => db.prepare(`
  INSERT INTO schema_meta (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  WHERE schema_meta.value <> excluded.value OR schema_meta.updated_at <> excluded.updated_at
`).run(key, value, updatedAt);

const fastPathEvidenceFor = (applied, recordedAt) => Object.freeze({
  ...activeGenerationFastPath,
  applied,
  recordedAt,
});

const emptyMigration = () => ({
  odds: { created: false, migrated: false, scanned: 0, canonicalStates: 0, rawRows: 0 },
  predictions: { created: false, migrated: false, scanned: 0, canonicalStates: 0, rawRows: 0 },
  performed: false,
});

const emptyImportSummary = () => ({
  sourceChanges: 0,
  matchChanges: 0,
  oddsChanges: 0,
  predictionChanges: 0,
  publicOddsRows: 0,
  publicPredictionRows: 0,
  fastResultGuard: {
    receiptRevision: null,
    preservedHistoryRows: 0,
    skippedCurrentRows: 0,
    skippedHistoryRows: 0,
    rebasedHistoryRows: 0,
    deletedCurrentRows: 0,
    restoredHistoryRows: 0,
  },
  jsonl: {},
});

/**
 * A fast official-result publication is newer than the static JSON snapshot
 * consumed by this exporter.  Capture the exact committed rows while the
 * caller holds BEGIN IMMEDIATE so a later full export cannot move the same
 * fixture back to `current` or replace its audited final payload.
 */
const readFastResultGuard = (db) => {
  let receiptState = readFastResultReceiptState(db);
  if (receiptState.legacy) {
    const migration = migrateLegacyFastResultIntegrity(db, { transactionOpen: true });
    if (!migration.ok) {
      const diagnostic = {
        mismatchKind: migration.mismatchKind || null,
        authorityEventKey: migration.authorityEventKey || null,
        observationKey: migration.observationKey || null,
        sourceHistoryRows: Number.isSafeInteger(migration.sourceHistoryRows)
          ? migration.sourceHistoryRows
          : null,
        exactHistoryRows: Number.isSafeInteger(migration.exactHistoryRows)
          ? migration.exactHistoryRows
          : null,
        legacyAliasHistoryRows: Number.isSafeInteger(migration.legacyAliasHistoryRows)
          ? migration.legacyAliasHistoryRows
          : null,
        eventHistoryRows: Number.isSafeInteger(migration.eventHistoryRows)
          ? migration.eventHistoryRows
          : null,
        observationRows: Number.isSafeInteger(migration.observationRows)
          ? migration.observationRows
          : null,
        currentScoreObservationRows: Number.isSafeInteger(migration.currentScoreObservationRows)
          ? migration.currentScoreObservationRows
          : null,
      };
      const diagnosticText = Object.values(diagnostic).some((value) => value !== null)
        ? ` ${JSON.stringify(diagnostic)}`
        : "";
      throw new Error(
        `legacy fast result integrity migration failed: ${migration.reason}${diagnosticText}`
      );
    }
    receiptState = readFastResultReceiptState(db);
  }
  if (!receiptState.valid) {
    throw new Error(`fast_result_receipt integrity failure: ${receiptState.reason || "invalid"}`);
  }
  const authorityState = loadAuthorityHighWater(db);
  if (!authorityState.valid) {
    throw new Error("fast_result_authority_high_water integrity failure");
  }
  if (!receiptState.missing && authorityState.missing) {
    throw new Error("fast_result_authority_high_water missing for initialized receipt");
  }
  if (authorityState.missing) {
    return {
      receiptRow: null,
      receipt: null,
      receiptState,
      authorityState,
      authoritySnapshot: null,
      rows: [],
    };
  }

  const historyForSource = db.prepare(`
    SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload
    FROM match_snapshots
    WHERE dataset = 'history' AND LOWER(source_match_id) = ?
  `);
  const receiptSources = [...new Set(receiptState.observations
    .map((observation) => asText(observation.sourceMatchId).toLowerCase())
    .filter(Boolean))];
  const receiptHistory = receiptSources.flatMap((sourceMatchId) => (
    historyForSource.all(sourceMatchId)
      .map((row) => ({ ...row, match: readJsonPayload(row.payload) }))
      .filter((row) => row.match && trustedOfficialFinal(row.match))
  ));
  const receiptAuthority = resolveFastResultReceiptAuthorities({
    observations: receiptState.observations,
    historyRows: receiptHistory,
  });
  if (!receiptAuthority.ok) {
    throw new Error(`fast_result_receipt history resolution mismatch: ${JSON.stringify({
      mismatchKind: receiptAuthority.mismatchKind || null,
      authorityEventKey: receiptAuthority.authorityEventKey || null,
      observationKey: receiptAuthority.observationKey || null,
      sourceHistoryRows: receiptAuthority.sourceHistoryRows ?? null,
      exactHistoryRows: receiptAuthority.exactHistoryRows ?? null,
      legacyAliasHistoryRows: receiptAuthority.legacyAliasHistoryRows ?? null,
      eventHistoryRows: receiptAuthority.eventHistoryRows ?? null,
      observationRows: receiptAuthority.observationRows ?? null,
      exactObservationRows: receiptAuthority.exactObservationRows ?? null,
      currentScoreObservationRows: receiptAuthority.currentScoreObservationRows ?? null,
      legacyAliasObservationRows: receiptAuthority.legacyAliasObservationRows ?? null,
    })}`);
  }
  const authorityByKey = new Map(authorityState.rows.map((row) => [row.key, row]));
  const rowsById = new Map();
  for (const group of receiptAuthority.groups) {
    const eventKey = group.authorityIdentity.key;
    const authorityRow = authorityByKey.get(eventKey) || null;
    const observation = group.activeObservation;
    const guardedRow = group.authorityEntry;
    const matchedAuthorityRow = authorityHighWaterRow(
      { rows: authorityRow ? [authorityRow] : [] },
      guardedRow.match,
    );
    if (
      !authorityRow
      || !authorityHighWaterBindsResult(authorityRow, observation)
      || !matchedAuthorityRow
      || !authorityHighWaterBindsResult(matchedAuthorityRow, guardedRow.match)
      || !findFastResultObservation(guardedRow.match, [observation])
    ) {
      throw new Error(`fast_result_receipt authority mismatch: ${eventKey}`);
    }
    rowsById.set(guardedRow.id, {
      ...guardedRow,
      match: guardedRow.match,
      authorityKey: eventKey,
    });
  }
  return {
    receiptRow: receiptState.receiptRow || null,
    receipt: receiptState.receipt || null,
    receiptState,
    authorityState,
    authoritySnapshot: JSON.stringify({
      manifest: authorityState.manifestRow,
      initialized: authorityState.initializedRow,
      rows: authorityState.rows,
    }),
    rows: Array.from(rowsById.values()),
  };
};

const guardedFastFinalFor = (guard, match) => {
  const identity = authorityIdentityKey({
    sourceMatchId: match?.sourceMatchId || match?.id,
    eventVersion: eventVersionOf(match) || match?.kickoffTime,
  });
  if (!identity) return null;
  return guard.rows.find((row) => row.authorityKey === identity.key) || null;
};

const generationReconciliationBindsGuard = (guard) => {
  if (!generationInputActive || !guard?.receipt) return false;
  const reconciliation = inputSyncMeta?.fastResultGenerationReconciliation;
  const receiptRevision = Number(guard.receipt.revision || 0);
  return Boolean(
    inputFastResultGenerationReconciliationStamp
    && Number.isSafeInteger(receiptRevision)
    && receiptRevision > 0
    && Number(inputSyncMeta?.fastResultGenerationRevision || 0) === receiptRevision
    && Number(reconciliation?.receiptRevision || 0) === receiptRevision
    && asText(reconciliation?.publishedAt) === asText(guard.receipt.publishedAt)
    && asText(reconciliation?.sourceCycleId) === asText(guard.receipt.sourceCycleId)
    && asText(reconciliation?.datasetRevision) === asText(guard.receipt.datasetRevision)
  );
};

// A receipt guard protects a fast official result from an older static base.
// Once an immutable generation explicitly acknowledges that exact receipt,
// however, the generation is the reconciled public surface: retaining a
// legacy SQLite alias would detach the PostgreSQL/API row from its standalone
// review. Only allow that canonical rebase when the incoming final is bound to
// the same receipt observation and authority score. Every mismatch keeps the
// original byte-exact guard behavior.
const reconciledGenerationFastFinal = (guard, guardedRow, match) => {
  if (!guardedRow || !generationReconciliationBindsGuard(guard)) return null;
  const observation = findFastResultObservation(match, guard.receiptState.observations);
  const authorityRow = authorityHighWaterRow(guard.authorityState, match);
  if (
    !observation
    || !authorityRow
    || !authorityHighWaterBindsResult(authorityRow, match)
  ) return null;
  const observedFinal = applyFastResultObservation(match, [observation]);
  // The reconciler already proved embedded/standalone review parity before it
  // stamped sync-meta. Keep that embedded review byte-equivalent to the
  // immutable generation while still restoring receipt-authoritative root
  // observation clocks and provenance.
  return match?.postMatchReview
    ? { ...observedFinal, postMatchReview: match.postMatchReview }
    : observedFinal;
};

const assertFastResultReceiptUnchanged = (db, guard) => {
  const receiptState = readFastResultReceiptState(db);
  if (!receiptState.valid) {
    throw new Error("fast_result_receipt invalid during static SQLite export");
  }
  if (guard.receiptRow && (
    receiptState.receiptRow?.value !== guard.receiptRow.value
    || receiptState.receiptRow?.updated_at !== guard.receiptRow.updated_at
  )) {
    throw new Error("fast_result_receipt changed during static SQLite export");
  }
  const authorityState = loadAuthorityHighWater(db);
  if (!authorityState.valid) {
    throw new Error("fast_result_authority_high_water invalid during static SQLite export");
  }
  const authoritySnapshot = authorityState.missing ? null : JSON.stringify({
    manifest: authorityState.manifestRow,
    initialized: authorityState.initializedRow,
    rows: authorityState.rows,
  });
  if (authoritySnapshot !== guard.authoritySnapshot) {
    throw new Error("fast_result_authority_high_water changed during static SQLite export");
  }
};

const parseCursor = (value) => {
  try {
    const cursor = JSON.parse(String(value || ""));
    return cursor && typeof cursor === "object" ? cursor : null;
  } catch {
    return null;
  }
};

const sameFileIdentity = (cursor, filePath, stat) => Boolean(
  cursor
  && cursor.version === 2
  && cursor.path === path.resolve(filePath)
  && Number(cursor.dev || 0) === Number(stat.dev || 0)
  && Number(cursor.ino || 0) === Number(stat.ino || 0)
  && Number(cursor.offset || 0) <= Number(stat.size || 0)
);

const processJsonlIncrement = async ({ db, key, filePath, enabled, onRow, now }) => {
  const cursorKey = `jsonl_cursor:${key}`;
  if (!enabled) return { key, enabled: false, skipped: true, reason: "disabled" };
  if (!fs.existsSync(filePath)) return { key, enabled: true, exists: false, rows: 0, bytesRead: 0 };
  const stat = fs.statSync(filePath);
  const previous = parseCursor(getMeta(db, cursorKey));
  const reset = !sameFileIdentity(previous, filePath, stat);
  const startOffset = reset ? 0 : Math.max(0, Number(previous.offset || 0));
  const snapshotSize = Number(stat.size || 0);
  let committedOffset = startOffset;
  let rows = 0;
  let malformed = 0;
  let pending = "";

  if (snapshotSize > startOffset) {
    const stream = fs.createReadStream(filePath, {
      start: startOffset,
      end: snapshotSize - 1,
      encoding: "utf8",
    });
    for await (const chunk of stream) {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawLine = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        committedOffset += Buffer.byteLength(rawLine, "utf8") + 1;
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.trim()) {
          try {
            const row = JSON.parse(line);
            onRow(row);
            rows += 1;
          } catch (error) {
            if (error instanceof SyntaxError) malformed += 1;
            else throw error;
          }
        }
        newlineIndex = pending.indexOf("\n");
      }
    }
  }

  const nextCursor = {
    version: 2,
    path: path.resolve(filePath),
    dev: Number(stat.dev || 0),
    ino: Number(stat.ino || 0),
    offset: committedOffset,
    fileSize: snapshotSize,
    mtimeMs: Number(stat.mtimeMs || 0),
    updatedAt: now,
  };
  upsertMeta(db, cursorKey, JSON.stringify(nextCursor), now);
  return {
    key,
    enabled: true,
    exists: true,
    reset,
    resetReason: reset ? (!previous ? "missing-cursor" : "file-identity-or-size-changed") : null,
    startOffset,
    endOffset: committedOffset,
    fileSize: snapshotSize,
    pendingBytes: Math.max(0, snapshotSize - committedOffset),
    bytesRead: Math.max(0, committedOffset - startOffset),
    rows,
    malformed,
  };
};

const sourceUpserter = (db) => db.prepare(`
  INSERT INTO source_snapshots (id, source, captured_at, payload)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    source = excluded.source,
    captured_at = excluded.captured_at,
    payload = excluded.payload
  WHERE source_snapshots.source IS NOT excluded.source
     OR source_snapshots.captured_at IS NOT excluded.captured_at
     OR source_snapshots.payload <> excluded.payload
`);

const matchUpserter = (db) => db.prepare(`
  INSERT INTO match_snapshots
    (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    dataset = excluded.dataset,
    match_id = excluded.match_id,
    source_match_id = excluded.source_match_id,
    kickoff_time = excluded.kickoff_time,
    status = excluded.status,
    payload = excluded.payload
  WHERE match_snapshots.dataset IS NOT excluded.dataset
     OR match_snapshots.match_id IS NOT excluded.match_id
     OR match_snapshots.source_match_id IS NOT excluded.source_match_id
     OR match_snapshots.kickoff_time IS NOT excluded.kickoff_time
     OR match_snapshots.status IS NOT excluded.status
     OR match_snapshots.payload <> excluded.payload
`);

const storedOddsState = (row) => canonicalOddsState(row);
const storedPredictionState = (row) => canonicalPredictionState(row);

const oddsUpserter = (db) => {
  const select = db.prepare("SELECT * FROM odds_snapshots WHERE id = ?");
  const insert = insertOddsStateStatement(db, "odds_snapshots");
  return (state) => {
    const existingRow = select.get(state.id);
    const merged = mergeCanonicalOddsStates(existingRow ? storedOddsState(existingRow) : null, state);
    return runOddsStateInsert(insert, merged).changes;
  };
};

const predictionUpserter = (db) => {
  // Most source generations repeat already persisted semantic prediction
  // states.  Reading SELECT * for every repeat transfers multi-megabyte JSON
  // payloads from SQLite into V8 merely to discover that nothing changed.
  // Read only the merge clock first and fetch the payload on the rare path
  // where an older persisted payload must be retained while its observation
  // bounds advance.
  const selectMetadata = db.prepare(`
    SELECT id, state_key, captured_at, first_seen_at, last_seen_at, seen_count
    FROM prediction_snapshots
    WHERE id = ?
  `);
  const selectPayload = db.prepare("SELECT * FROM prediction_snapshots WHERE id = ?");
  const insert = insertPredictionStateStatement(db, "prediction_snapshots");
  return (state) => {
    const existing = selectMetadata.get(state.id);
    if (!existing) return runPredictionStateInsert(insert, state).changes;
    if (String(existing.state_key || "") !== String(state.stateKey || "")) {
      throw new Error(`prediction state id collision for ${state.id}`);
    }

    const firstSeenAt = earliestIso(
      existing.first_seen_at,
      existing.captured_at,
      state.firstSeenAt,
      state.capturedAt,
    );
    const lastSeenAt = latestIso(
      existing.last_seen_at,
      existing.captured_at,
      state.lastSeenAt,
      state.capturedAt,
    ) || firstSeenAt;
    const seenCount = Math.max(1, Number(existing.seen_count || 1), Number(state.seenCount || 1));
    const incomingIsNewer = timestampMs(state.lastSeenAt || state.capturedAt)
      > timestampMs(existing.last_seen_at || existing.captured_at);

    if (incomingIsNewer) {
      const merged = {
        ...state,
        id: existing.id,
        capturedAt: firstSeenAt,
        firstSeenAt,
        lastSeenAt,
        seenCount,
        payload: {
          ...state.payload,
          capturedAt: firstSeenAt,
          firstSeenAt,
          lastSeenAt,
          seenCount,
        },
      };
      return runPredictionStateInsert(insert, merged).changes;
    }

    const metadataChanged = String(existing.captured_at || "") !== String(firstSeenAt || "")
      || String(existing.first_seen_at || "") !== String(firstSeenAt || "")
      || String(existing.last_seen_at || "") !== String(lastSeenAt || "")
      || Number(existing.seen_count || 1) !== seenCount;
    if (!metadataChanged) return 0;

    const existingRow = selectPayload.get(state.id);
    const merged = mergeCanonicalPredictionStates(
      existingRow ? storedPredictionState(existingRow) : null,
      state,
    );
    return runPredictionStateInsert(insert, merged).changes;
  };
};

const pruneByLimit = (db, table, where, orderBy, limit) => {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const result = db.prepare(`
    DELETE FROM ${table}
    WHERE id IN (
      SELECT id FROM ${table}
      ${where ? `WHERE ${where}` : ""}
      ORDER BY ${orderBy}
      LIMIT -1 OFFSET ?
    )
  `).run(limit);
  return Number(result.changes || 0);
};

const readFinalCounts = (db) => {
  const scalar = (sql) => Number(db.prepare(sql).get()?.value || 0);
  return {
    currentMatches: scalar("SELECT COUNT(*) AS value FROM match_snapshots WHERE dataset = 'current'"),
    historyMatches: scalar("SELECT COUNT(*) AS value FROM match_snapshots WHERE dataset = 'history'"),
    oddsSnapshots: scalar("SELECT COUNT(*) AS value FROM odds_snapshots"),
    predictionSnapshots: scalar("SELECT COUNT(*) AS value FROM prediction_snapshots"),
    legacyMatchSnapshots: scalar("SELECT COUNT(*) AS value FROM match_snapshots WHERE id LIKE 'jsonl-match:%'"),
    legacySyncRuns: scalar("SELECT COUNT(*) AS value FROM source_snapshots WHERE id LIKE 'jsonl-sync:%'"),
    privateModelArtifacts: scalar("SELECT COUNT(*) AS value FROM private_model_artifacts"),
  };
};

const exportIncrementalRows = async (db) => {
  const now = new Date().toISOString();
  const fastResultGuard = readFastResultGuard(db);
  if (activeGenerationFastPath.eligible) {
    const mismatch = activeGenerationFastPathFileMismatch()
      || activeGenerationFastPathMetaMismatch(readActiveGenerationFastPathMeta(db));
    if (mismatch) {
      const error = new Error(`release clone fast-path metadata changed before transaction: ${mismatch}`);
      error.code = "SQLITE_FAST_PATH_METADATA_CHANGED";
      throw error;
    }
    const fastPath = fastPathEvidenceFor(true, now);
    upsertMeta(db, "sqlite_export_fast_path", JSON.stringify(fastPath), now);
    return {
      now,
      migration: emptyMigration(),
      imported: emptyImportSummary(),
      pruned: {
        syncRuns: 0,
        matchSnapshots: 0,
        oddsSnapshots: 0,
        predictionSnapshots: 0,
      },
      fastPath,
    };
  }
  const syncMeta = loadBaseProjection ? inputSyncMeta : null;
  const migration = ensureWarehouseV2(db);
  const sourceInsert = sourceUpserter(db);
  const matchInsert = matchUpserter(db);
  const upsertOdds = oddsUpserter(db);
  const upsertPrediction = predictionUpserter(db);
  const oddsBatch = new Map();
  const rawOddsBatch = new Map();
  const imported = {
    sourceChanges: 0,
    matchChanges: 0,
    oddsChanges: 0,
    predictionChanges: 0,
    publicOddsRows: 0,
    publicPredictionRows: 0,
    fastResultGuard: {
      receiptRevision: Number(fastResultGuard.receipt?.revision || 0) || null,
      preservedHistoryRows: fastResultGuard.rows.length,
      skippedCurrentRows: 0,
      skippedHistoryRows: 0,
      rebasedHistoryRows: 0,
      deletedCurrentRows: 0,
      restoredHistoryRows: 0,
    },
    jsonl: {},
  };

  const fastPath = fastPathEvidenceFor(false, now);
  upsertMeta(db, "sqlite_export_fast_path", JSON.stringify(fastPath), now);

  upsertMeta(db, "schema_version", SQLITE_SCHEMA_VERSION, now);
  upsertMeta(db, "exported_at", now, now);
  upsertMeta(db, "sync_meta_updated_at", syncMetaDataVersion(syncMeta), now);
  upsertMeta(db, "data_publication_mode", inputPublication.identity.mode, now);
  upsertMeta(db, "data_generation_id", inputPublication.identity.generationId || "", now);
  upsertMeta(db, "manifest_hash", inputPublication.identity.manifestHash || "", now);
  upsertMeta(
    db,
    "source_cycle_id",
    inputPublication.identity.sourceCycleId || String(syncMeta?.sourceCycleId || ""),
    now,
  );
  // Fast-result overlay writers legitimately advance the generic
  // source_cycle_id.  Keep the immutable base cycle separately so those
  // overlays do not make an otherwise matching generation unreadable.
  upsertMeta(
    db,
    "data_generation_source_cycle_id",
    inputPublication.identity.sourceCycleId || String(syncMeta?.sourceCycleId || ""),
    now,
  );
  upsertMeta(db, "committed_at", inputPublication.identity.committedAt || "", now);
  upsertMeta(
    db,
    "fast_result_generation_reconciliation",
    inputFastResultGenerationReconciliationStamp,
    now,
  );
  upsertMeta(db, "warehouse_policy", JSON.stringify(expectedWarehousePolicy), now);

  if (syncMeta && typeof syncMeta === "object") {
    imported.sourceChanges += Number(sourceInsert.run(
      "sync-meta:current",
      syncMeta.source || "sporttery",
      syncMeta.updatedAt || syncMeta.capturedAt || null,
      JSON.stringify(syncMeta)
    ).changes || 0);
    db.prepare("DELETE FROM source_snapshots WHERE id LIKE 'sync-meta:%' AND id <> 'sync-meta:current'").run();
  }
  let externalSignals = loadBaseProjection ? readCoreJson("external-signals.json", null) : null;
  if (externalSignals && typeof externalSignals === "object") {
    imported.sourceChanges += Number(sourceInsert.run(
      "external-signals:current",
      externalSignals.source || "external-signals",
      externalSignals.updatedAt || null,
      JSON.stringify(externalSignals)
    ).changes || 0);
    db.prepare("DELETE FROM source_snapshots WHERE id LIKE 'external-signals:%' AND id <> 'external-signals:current'").run();
  }
  externalSignals = null;
  collectReleasedPayloads();

  let predictionSnapshots = loadBaseProjection ? readCoreJson("prediction-snapshots.json", null) : null;
  let currentMatchesPayload = loadBaseProjection ? readCoreJson("matches-current.json", null) : null;
  let historyMatchesPayload = loadBaseProjection ? readCoreJson("matches-history.json", null) : null;
  let currentMatches = materializeArchiveProjection(currentMatchesPayload, predictionSnapshots);
  let historyMatches = materializeArchiveProjection(historyMatchesPayload, predictionSnapshots);

  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS export_active_match_ids (
      id TEXT PRIMARY KEY,
      dataset TEXT NOT NULL
    );
    DELETE FROM export_active_match_ids;
  `);
  const activeMatchInsert = db.prepare("INSERT OR REPLACE INTO export_active_match_ids (id, dataset) VALUES (?, ?)");
  const activeMatchDelete = db.prepare("DELETE FROM export_active_match_ids WHERE id = ?");
  const guardedHistoryIds = new Set(fastResultGuard.rows.map((row) => row.id));
  const rebasedGuardedHistoryIds = new Set();
  for (const row of fastResultGuard.rows) activeMatchInsert.run(row.id, "history");
  for (const [dataset, rows] of [["current", currentMatches], ["history", historyMatches]]) {
    if (!Array.isArray(rows)) continue;
    for (const match of rows) {
      let normalizedMatch = normalizeLegacyReviewClock(match);
      const sourceMatchId = normalizedMatch?.sourceMatchId || sourceMatchIdFor(normalizedMatch?.id) || null;
      let id = `${dataset}:${normalizedMatch?.id || sourceMatchId || hashPayload(normalizedMatch)}`;
      const guardedFinal = guardedFastFinalFor(fastResultGuard, normalizedMatch);
      if (dataset === "current" && guardedFinal) {
        imported.fastResultGuard.skippedCurrentRows += 1;
        continue;
      }
      if (dataset === "history" && guardedFinal) {
        const reconciledFinal = reconciledGenerationFastFinal(
          fastResultGuard,
          guardedFinal,
          normalizedMatch,
        );
        if (reconciledFinal) {
          if (rebasedGuardedHistoryIds.has(guardedFinal.id)) {
            const error = new Error(`duplicate reconciled generation fast final: ${guardedFinal.authorityKey}`);
            error.code = "SQLITE_RECONCILED_FAST_RESULT_DUPLICATE";
            throw error;
          }
          normalizedMatch = reconciledFinal;
          id = `${dataset}:${normalizedMatch?.id || sourceMatchId || hashPayload(normalizedMatch)}`;
          rebasedGuardedHistoryIds.add(guardedFinal.id);
          activeMatchDelete.run(guardedFinal.id);
          imported.fastResultGuard.rebasedHistoryRows += 1;
        } else {
          imported.fastResultGuard.skippedHistoryRows += 1;
          continue;
        }
      } else if (dataset === "history" && guardedHistoryIds.has(id)) {
        imported.fastResultGuard.skippedHistoryRows += 1;
        continue;
      }
      activeMatchInsert.run(id, dataset);
      imported.matchChanges += Number(matchInsert.run(
        id,
        dataset,
        normalizedMatch?.id || null,
        sourceMatchId,
        normalizedMatch?.kickoffTime || null,
        normalizedMatch?.status || null,
        JSON.stringify(normalizedMatch)
      ).changes || 0);
    }
    db.prepare(`
      DELETE FROM match_snapshots
      WHERE dataset = ?
        AND id NOT IN (SELECT id FROM export_active_match_ids WHERE dataset = ?)
    `).run(dataset, dataset);
  }

  // The explicit delete also covers exports where matches-current.json is
  // temporarily unavailable (and therefore the normal active-id prune does
  // not run).  A reused source id for a genuinely different event survives.
  const currentRowsForGuardSource = db.prepare(`
    SELECT id, payload
    FROM match_snapshots
    WHERE dataset = 'current' AND LOWER(source_match_id) = ?
  `);
  const deleteGuardedCurrent = db.prepare(
    "DELETE FROM match_snapshots WHERE id = ? AND dataset = 'current'"
  );
  const guardedSources = [...new Set(fastResultGuard.rows
    .map((row) => asText(row.source_match_id).toLowerCase())
    .filter(Boolean))];
  for (const sourceMatchId of guardedSources) {
    for (const row of currentRowsForGuardSource.all(sourceMatchId)) {
      const match = readJsonPayload(row.payload);
      if (!match || !guardedFastFinalFor(fastResultGuard, match)) continue;
      const deleted = Number(deleteGuardedCurrent.run(row.id).changes || 0);
      imported.fastResultGuard.deletedCurrentRows += deleted;
      imported.matchChanges += deleted;
    }
  }

  // Re-upsert the captured columns and original payload bytes.  Normally this
  // is a no-op because guarded rows were active and static conflicts skipped;
  // retaining it makes the invariant robust to future exporter changes.
  for (const row of fastResultGuard.rows) {
    if (rebasedGuardedHistoryIds.has(row.id)) continue;
    const restored = Number(matchInsert.run(
      row.id,
      "history",
      row.match_id,
      row.source_match_id,
      row.kickoff_time,
      row.status,
      row.payload
    ).changes || 0);
    imported.fastResultGuard.restoredHistoryRows += restored;
    imported.matchChanges += restored;
  }

  const addOddsCandidate = (row, namespace) => {
    const state = canonicalOddsState(row);
    if (state) {
      oddsBatch.set(state.id, mergeCanonicalOddsStates(oddsBatch.get(state.id), state));
      trimStateMap(oddsBatch, oddsStateLimit);
    } else {
      const raw = rawOddsRecord(row, namespace);
      rawOddsBatch.set(raw.id, raw);
    }
  };

  let publicPredictionRows = Array.isArray(predictionSnapshots?.rows)
    ? predictionSnapshots.rows.slice(-predictionLimit)
    : [];
  for (const row of publicPredictionRows) {
    const state = canonicalPredictionState(row);
    const candidate = state || rawPredictionRecord(row, "public");
    imported.predictionChanges += upsertPrediction(candidate);
  }
  imported.publicPredictionRows = publicPredictionRows.length;
  publicPredictionRows = null;

  currentMatches = null;
  historyMatches = null;
  currentMatchesPayload = null;
  historyMatchesPayload = null;
  predictionSnapshots = null;
  collectReleasedPayloads();

  let oddsHistory = loadBaseProjection ? readCoreJson("odds-history.json", null) : null;
  let publicOddsRows = Array.isArray(oddsHistory?.rows) ? oddsHistory.rows.slice(-oddsLimit) : [];
  for (const row of publicOddsRows) addOddsCandidate(row, "public");
  imported.publicOddsRows = publicOddsRows.length;
  publicOddsRows = null;
  oddsHistory = null;
  collectReleasedPayloads();

  imported.jsonl.syncRuns = await processJsonlIncrement({
    db,
    key: "syncRuns",
    filePath: jsonlFiles.syncRuns,
    enabled: !generationInputActive && jsonlSyncLimit > 0,
    now,
    onRow: (row) => {
      imported.sourceChanges += Number(sourceInsert.run(
        `jsonl-sync:${row?.id || hashPayload(row)}`,
        row?.source || "sync-run",
        capturedAtFor(row),
        JSON.stringify(row)
      ).changes || 0);
    },
  });

  imported.jsonl.matchSnapshots = await processJsonlIncrement({
    db,
    key: "matchSnapshots",
    filePath: jsonlFiles.matchSnapshots,
    enabled: !generationInputActive && jsonlMatchLimit > 0,
    now,
    onRow: (row) => {
      const payload = matchPayloadForJsonl(row);
      const sourceMatchId = row?.sourceMatchId || payload?.sourceMatchId || sourceMatchIdFor(payload?.id) || null;
      const matchId = row?.matchId || payload?.id || (sourceMatchId ? `sporttery_${sourceMatchId}` : null);
      imported.matchChanges += Number(matchInsert.run(
        `jsonl-match:${row?.id || hashPayload(row)}`,
        legacyDatasetFor(row),
        matchId,
        sourceMatchId,
        row?.kickoffTime || payload?.kickoffTime || null,
        row?.status || payload?.status || null,
        JSON.stringify(payload)
      ).changes || 0);
    },
  });

  imported.jsonl.oddsSnapshots = await processJsonlIncrement({
    db,
    key: "oddsSnapshots",
    filePath: jsonlFiles.oddsSnapshots,
    enabled: !generationInputActive && jsonlOddsLimit > 0,
    now,
    onRow: (row) => addOddsCandidate(row, "jsonl"),
  });

  imported.jsonl.predictionRuns = await processJsonlIncrement({
    db,
    key: "predictionRuns",
    filePath: jsonlFiles.predictionRuns,
    enabled: !generationInputActive && jsonlPredictionLimit > 0,
    now,
    onRow: (row) => {
      const state = canonicalPredictionState(row);
      const candidate = state || rawPredictionRecord(row, "jsonl");
      imported.predictionChanges += upsertPrediction(candidate);
    },
  });

  const keptOdds = Array.from(oddsBatch.values())
    .sort((left, right) => timestampMs(right.lastSeenAt) - timestampMs(left.lastSeenAt))
    .slice(0, oddsStateLimit);
  for (const state of keptOdds) imported.oddsChanges += upsertOdds(state);
  for (const state of rawOddsBatch.values()) imported.oddsChanges += upsertOdds(state);

  const pruned = {
    syncRuns: pruneByLimit(db, "source_snapshots", "id LIKE 'jsonl-sync:%'", "captured_at DESC, id DESC", jsonlSyncLimit),
    matchSnapshots: pruneByLimit(db, "match_snapshots", "id LIKE 'jsonl-match:%'", "kickoff_time DESC, id DESC", jsonlMatchLimit),
    oddsSnapshots: pruneByLimit(db, "odds_snapshots", "", "COALESCE(last_seen_at, captured_at) DESC, id DESC", oddsStateLimit),
    predictionSnapshots: pruneByLimit(db, "prediction_snapshots", "", "COALESCE(last_seen_at, captured_at) DESC, id DESC", predictionStateLimit),
  };

  upsertMeta(db, "legacy_jsonl_import", JSON.stringify({
    version: "legacy-jsonl-incremental-v2",
    importedAt: now,
    files: imported.jsonl,
    pruned,
  }), now);

  assertFastResultReceiptUnchanged(db, fastResultGuard);

  return { now, migration, imported, pruned, fastPath };
};

const checkpointWal = (db, requestedMode = "PASSIVE") => {
  const allowedModes = new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]);
  const mode = allowedModes.has(String(requestedMode).toUpperCase()) ? String(requestedMode).toUpperCase() : "PASSIVE";
  try {
    const rows = db.prepare(`PRAGMA wal_checkpoint(${mode})`).all();
    const row = rows[0] || {};
    const values = Object.values(row).map(Number);
    const busy = Number(row.busy ?? values[0] ?? 0);
    const logFrames = Number(row.log ?? values[1] ?? 0);
    const checkpointedFrames = Number(row.checkpointed ?? values[2] ?? 0);
    const complete = busy === 0 && (logFrames <= 0 || checkpointedFrames >= logFrames);
    return {
      ok: complete,
      complete,
      mode,
      busy,
      logFrames,
      checkpointedFrames,
      rows,
      ...(complete ? {} : { reason: busy > 0 ? "checkpoint-busy" : "checkpoint-incomplete" }),
    };
  } catch (error) {
    return { ok: false, complete: false, mode, error: error.message || String(error) };
  }
};

const databasePageStats = (db) => {
  const pageCount = Number(Object.values(db.prepare("PRAGMA page_count").get() || {})[0] || 0);
  const freelistCount = Number(Object.values(db.prepare("PRAGMA freelist_count").get() || {})[0] || 0);
  return {
    pageCount,
    freelistCount,
    freeRatio: pageCount > 0 ? Number((freelistCount / pageCount).toFixed(4)) : 0,
  };
};

const fsyncPath = (filePath) => {
  const descriptor = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const maybeRunControlledVacuum = ({ db, expectedCounts }) => {
  const requested = process.env.SQLITE_VACUUM_AFTER_EXPORT === "1";
  const maintenanceWindow = String(process.env.SQLITE_MAINTENANCE_WINDOW || "");
  const allowed = requested && maintenanceWindow === "release-stopped";
  const before = databasePageStats(db);
  const minFreeRatio = Math.max(0, Number(process.env.SQLITE_VACUUM_MIN_FREE_RATIO || 0.2));
  const minFreePages = Math.max(1, Number(process.env.SQLITE_VACUUM_MIN_FREE_PAGES || 1000));
  const beforeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  if (!allowed) {
    return { db, result: { requested, allowed: false, maintenanceWindow: maintenanceWindow || null, before } };
  }
  if (before.freeRatio < minFreeRatio || before.freelistCount < minFreePages) {
    return {
      db,
      result: { requested, allowed: true, performed: false, reason: "below-threshold", before, minFreeRatio, minFreePages },
    };
  }

  const checkpoint = checkpointWal(db, "TRUNCATE");
  if (!checkpoint.ok) {
    throw new Error(`controlled SQLite vacuum requires an idle database; WAL checkpoint was not complete (${checkpoint.reason || checkpoint.error || "unknown"})`);
  }
  const tempPath = `${dbPath}.vacuum-${process.pid}-${Date.now()}`;
  const backupPath = `${dbPath}.pre-vacuum-${process.pid}-${Date.now()}`;
  fs.rmSync(tempPath, { force: true });
  db.exec(`VACUUM INTO ${sqlQuote(tempPath)}`);
  closeDatabase(db);
  db = null;

  let installed = false;
  try {
    const validation = new DatabaseSync(tempPath);
    try {
      const quickCheck = Object.values(validation.prepare("PRAGMA quick_check").get() || {})[0];
      if (quickCheck !== "ok") throw new Error(`VACUUM output quick_check failed: ${quickCheck}`);
      const actualCounts = readFinalCounts(validation);
      for (const [key, expected] of Object.entries(expectedCounts || {})) {
        if (Number(actualCounts[key]) !== Number(expected)) {
          throw new Error(`VACUUM output count mismatch for ${key}: ${actualCounts[key]} != ${expected}`);
        }
      }
      validation.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
      `);
    } finally {
      closeDatabase(validation);
    }
    fs.rmSync(`${tempPath}-wal`, { force: true });
    fs.rmSync(`${tempPath}-shm`, { force: true });
    fsyncPath(tempPath);
    fs.renameSync(dbPath, backupPath);
    try {
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      fs.renameSync(tempPath, dbPath);
      installed = true;
    } catch (error) {
      if (!fs.existsSync(dbPath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, dbPath);
      throw error;
    }
    fsyncPath(dbPath);
    fs.rmSync(backupPath, { force: true });
    const afterBytes = fs.statSync(dbPath).size;
    return {
      db: null,
      result: {
        requested,
        allowed: true,
        performed: true,
        before,
        beforeBytes,
        afterBytes,
        checkpoint,
      },
    };
  } finally {
    if (!installed) fs.rmSync(tempPath, { force: true });
  }
};

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
let db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA busy_timeout = ${sqliteBusyTimeoutMs};
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA wal_autocheckpoint = 1000;
`);
ensureBaseSchema(db);

(async () => {
  let exportResult = null;
  let finalCounts = null;
  let walCheckpoint = null;
  let vacuum = null;
  let completedAttempt = 0;
  try {
    for (let attempt = 1; attempt <= sqliteExportAttempts; attempt += 1) {
      let publicationLock = null;
      try {
        db.exec("BEGIN IMMEDIATE");
        exportResult = await exportIncrementalRows(db);
        // Compare-and-swap immediately before commit. Both paths acquire the
        // same pointer-commit lock used by supported generation writers and
        // retain it until SQLite COMMIT has completed. The release-only path
        // remains pointer-read-only: it never publishes a pointer, and avoids
        // a second payload hash/parse by checking the strict pointer identity
        // while holding the writer lock.
        if (sourcePointerReadOnly) {
          commitWithActivePublicationPointerLock({
            storeDir,
            expected: inputPublication,
            timeoutMs: sqliteBusyTimeoutMs,
            staleMs: Math.max(60_000, sqliteBusyTimeoutMs * 2),
            commit: () => db.exec("COMMIT"),
          });
        } else {
          const generationPaths = storePaths(storeDir);
          fs.mkdirSync(generationPaths.root, { recursive: true });
          publicationLock = acquirePointerCommitLock({
            lockDir: generationPaths.pointerLockDir,
            timeoutMs: sqliteBusyTimeoutMs,
            staleMs: Math.max(60_000, sqliteBusyTimeoutMs * 2),
          });
          assertActivePublicationUnchanged({
            storeDir,
            publicDataDir,
            expected: inputPublication,
          });
        }
        if (!sourcePointerReadOnly) db.exec("COMMIT");
        publicationLock?.release();
        publicationLock = null;
        completedAttempt = attempt;
        finalCounts = readFinalCounts(db);
        walCheckpoint = checkpointWal(db, process.env.SQLITE_WAL_CHECKPOINT_MODE || "PASSIVE");
        break;
      } catch (error) {
        try { publicationLock?.release(); } catch { /* preserve export failure */ }
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback failures after a failed transaction start.
        }
        if (!isSqliteBusy(error) || attempt >= sqliteExportAttempts) throw error;
        const delayMs = sqliteExportRetryDelayMs * attempt;
        console.warn(`SQLite export busy; retrying attempt ${attempt + 1}/${sqliteExportAttempts} in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }

    const maintenance = maybeRunControlledVacuum({ db, expectedCounts: finalCounts });
    db = maintenance.db;
    vacuum = maintenance.result;
  } finally {
    closeDatabase(db);
  }

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    publicDataDir,
    storeDir,
    publication: inputPublication.identity,
    schemaVersion: SQLITE_SCHEMA_VERSION,
    journalMode: "WAL",
    busyTimeoutMs: sqliteBusyTimeoutMs,
    configuredAttempts: sqliteExportAttempts,
    completedAttempt,
    counts: finalCounts,
    migration: exportResult?.migration || null,
    fastPath: exportResult?.fastPath || fastPathEvidenceFor(false, new Date().toISOString()),
    incremental: exportResult?.imported || null,
    pruned: exportResult?.pruned || null,
    legacyJsonl: {
      version: "legacy-jsonl-incremental-v2",
      files: exportResult?.imported?.jsonl || {},
      pruned: exportResult?.pruned || {},
    },
    walCheckpoint,
    vacuum,
  }, null, 2));
})().catch((error) => {
  closeDatabase(db);
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
