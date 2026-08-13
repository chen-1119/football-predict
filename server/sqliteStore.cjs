const fs = require("node:fs/promises");
const path = require("node:path");
const {
  reconcileMatchLifecycle,
  resolveMatchLifecycle
} = require("../src/services/matchLifecycle.cjs");
const {
  sqlitePublicationMatches,
} = require("./dataGenerationBundle.cjs");
const {
  readFastResultReceiptState,
} = require("../scripts/fastResultReceiptIntegrity.cjs");

let DatabaseSync = null;
let sqliteLoadError = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  sqliteLoadError = error;
}

const safeJsonParse = (text, fallback = null) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const closeDatabase = (db) => {
  try {
    db?.close();
  } catch {
    // Ignore close failures from already-closed handles.
  }
};

const openReadonly = (dbPath) => {
  if (!DatabaseSync) {
    return {
      db: null,
      error: sqliteLoadError?.message || "node:sqlite is unavailable"
    };
  }
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), error: null };
  } catch (error) {
    return { db: null, error: error.message || String(error) };
  }
};

const getSingleValue = (db, sql, params = []) => {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
};

const SQLITE_PUBLICATION_META_KEYS = Object.freeze([
  "data_publication_mode",
  "data_generation_id",
  "manifest_hash",
  "data_generation_source_cycle_id",
  "source_cycle_id",
  "committed_at",
]);

const SQLITE_STATUS_META_KEYS = Object.freeze([
  ...SQLITE_PUBLICATION_META_KEYS,
  "schema_version",
  "exported_at",
  "sync_meta_updated_at",
  "legacy_jsonl_import",
  "warehouse_policy",
]);

const readMetaRows = (db, keys) => {
  const selectedKeys = [...new Set((Array.isArray(keys) ? keys : [])
    .map((key) => String(key || "").trim())
    .filter(Boolean))];
  if (selectedKeys.length === 0) return {};
  const rows = db.prepare(`
    SELECT key, value, updated_at
    FROM schema_meta
    WHERE key IN (${selectedKeys.map(() => "?").join(",")})
  `).all(...selectedKeys);
  const meta = {};
  for (const row of rows) {
    meta[row.key] = {
      value: row.value,
      updatedAt: row.updated_at
    };
  }
  return meta;
};

const readMetaJson = (meta, key, fallback = null) => {
  const value = meta?.[key]?.value;
  if (!value) return fallback;
  return safeJsonParse(value, fallback);
};

const sqlitePublicationIdentityFromMeta = (meta, options = {}) => ({
  mode: meta?.data_publication_mode?.value || "legacy-bootstrap",
  generationId: meta?.data_generation_id?.value || null,
  manifestHash: meta?.manifest_hash?.value || null,
  sourceCycleId: meta?.data_generation_source_cycle_id?.value
    || (options.strictGenerationSource === true ? null : meta?.source_cycle_id?.value)
    || null,
  committedAt: meta?.committed_at?.value || null,
});

const readSqlitePublicationIdentityFromDb = (db) => sqlitePublicationIdentityFromMeta(
  readMetaRows(db, SQLITE_PUBLICATION_META_KEYS),
);

// Keep publication pairing checks intentionally lightweight.  The API uses
// this helper while deciding which immutable generation can be served beside
// the live SQLite projection; COUNT/PRAGMA work belongs to getSqliteStatus and
// must not sit on the pointer cutover path.
const readSqlitePublicationIdentity = (dbPath) => {
  const resolvedPath = path.resolve(dbPath);
  const { db, error } = openReadonly(resolvedPath);
  if (!db) {
    return {
      available: false,
      path: resolvedPath,
      reason: error,
      publication: null,
    };
  }
  try {
    return {
      available: true,
      path: resolvedPath,
      reason: null,
      publication: sqlitePublicationIdentityFromMeta(
        readMetaRows(db, SQLITE_PUBLICATION_META_KEYS),
        { strictGenerationSource: true },
      ),
    };
  } catch (readError) {
    return {
      available: false,
      path: resolvedPath,
      reason: readError.message || String(readError),
      publication: null,
    };
  } finally {
    closeDatabase(db);
  }
};

const sourceMatchIdFor = (id) => {
  const text = String(id || "").trim();
  if (!text) return "";
  return text.replace(/^sporttery_/, "");
};

const parsePayloadRows = (rows) => rows
  .map((row) => safeJsonParse(row.payload, null))
  .filter((payload) => payload && typeof payload === "object");

const getSqliteStatus = async (dbPath, options = {}) => {
  const resolvedPath = path.resolve(dbPath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat) {
    return {
      available: false,
      path: resolvedPath,
      reason: "sqlite database not found",
      counts: {}
    };
  }

  const { db, error } = openReadonly(resolvedPath);
  if (!db) {
    return {
      available: false,
      path: resolvedPath,
      reason: error,
      bytes: stat.size,
      counts: {}
    };
  }

  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    const meta = readMetaRows(db, SQLITE_STATUS_META_KEYS);
    const publication = sqlitePublicationIdentityFromMeta(meta);
    const baseReady = sqlitePublicationMatches(publication, options.publicationIdentity);
    const counts = {
      currentMatches: getSingleValue(db, "SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset = 'current'") || 0,
      historyMatches: getSingleValue(db, "SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset = 'history'") || 0,
      legacyMatchSnapshots: getSingleValue(db, "SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset NOT IN ('current', 'history')") || 0,
      oddsSnapshots: getSingleValue(db, "SELECT COUNT(*) AS count FROM odds_snapshots") || 0,
      predictionSnapshots: getSingleValue(db, "SELECT COUNT(*) AS count FROM prediction_snapshots") || 0,
      sourceSnapshots: getSingleValue(db, "SELECT COUNT(*) AS count FROM source_snapshots") || 0
    };
    const pageCount = Number(getSingleValue(db, "PRAGMA page_count") || 0);
    const freelistCount = Number(getSingleValue(db, "PRAGMA freelist_count") || 0);
    const pageSize = Number(getSingleValue(db, "PRAGMA page_size") || 0);
    const result = {
      available: true,
      path: resolvedPath,
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      schemaVersion: meta.schema_version?.value || null,
      exportedAt: meta.exported_at?.value || null,
      syncMetaUpdatedAt: meta.sync_meta_updated_at?.value || null,
      publication,
      baseReady,
      baseBlockedReason: baseReady ? null : "sqlite-generation-mismatch",
      legacyJsonl: readMetaJson(meta, "legacy_jsonl_import", null),
      warehousePolicy: readMetaJson(meta, "warehouse_policy", null),
      physical: {
        pageCount,
        freelistCount,
        pageSize,
        freeBytes: freelistCount * pageSize,
        freeRatio: pageCount > 0 ? Number((freelistCount / pageCount).toFixed(4)) : 0,
      },
      counts
    };
    db.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* read transaction cleanup only */ }
    }
    return {
      available: false,
      path: resolvedPath,
      reason: error.message || String(error),
      bytes: stat.size,
      counts: {}
    };
  } finally {
    closeDatabase(db);
  }
};

const readSqliteCurrentMatches = async (dbPath, options = {}) => {
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return [];
  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    if (!sqlitePublicationMatches(
      readSqlitePublicationIdentityFromDb(db),
      options.publicationIdentity,
    )) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return [];
    }
    const rows = db.prepare(`
      SELECT payload
      FROM match_snapshots
      WHERE dataset = 'current'
      ORDER BY kickoff_time ASC, match_id ASC
    `).all();
    const parsed = parsePayloadRows(rows);
    db.exec("COMMIT");
    transactionOpen = false;
    return parsed;
  } catch {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* read transaction cleanup only */ }
    }
    return [];
  } finally {
    closeDatabase(db);
  }
};

const readSqliteHistoryMatchesForList = async (dbPath, limit = 600, options = {}) => {
  const safeLimit = Math.max(1, Math.min(1200, Number(limit || 600)));
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return [];
  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    if (!sqlitePublicationMatches(
      readSqlitePublicationIdentityFromDb(db),
      options.publicationIdentity,
    )) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return [];
    }
    const rows = db.prepare(`
      SELECT payload
      FROM match_snapshots
      WHERE dataset = 'history'
      ORDER BY kickoff_time DESC, match_id ASC
      LIMIT ?
    `).all(safeLimit);
    const parsed = parsePayloadRows(rows);
    db.exec("COMMIT");
    transactionOpen = false;
    return parsed;
  } catch {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* read transaction cleanup only */ }
    }
    return [];
  } finally {
    closeDatabase(db);
  }
};

const querySqliteTransitionMatches = (db, options = {}) => {
  const requestedLimit = Number(options.limit);
  if (Number.isFinite(requestedLimit) && requestedLimit <= 0) return [];
  const safeLimit = Math.max(1, Math.min(256, Number(options.limit || 32)));
  const sourceMatchIds = [...new Set((Array.isArray(options.sourceMatchIds) ? options.sourceMatchIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].slice(0, 256);
  try {
    const exactRows = sourceMatchIds.length > 0
      ? db.prepare(`
          SELECT rowid AS insertion_order, payload
          FROM match_snapshots
          WHERE dataset = 'history'
            AND source_match_id IN (${sourceMatchIds.map(() => "?").join(",")})
          ORDER BY rowid DESC
          LIMIT ?
        `).all(...sourceMatchIds, safeLimit * 4)
      : [];
    const recentRows = db.prepare(`
      SELECT rowid AS insertion_order, payload
      FROM match_snapshots
      WHERE dataset = 'history'
      ORDER BY rowid DESC
      LIMIT ?
    `).all(safeLimit * 4);
    const parsedExactRows = exactRows
      .map((row) => safeJsonParse(row.payload, null))
      .filter((payload) => payload && typeof payload === "object");
    const rows = [];
    const seen = new Set();
    const append = (payload) => {
      if (!payload || typeof payload !== "object") return;
      const key = `${payload.id || ""}|${payload.sourceMatchId || ""}|${payload.eventVersion || payload.kickoffTime || ""}|${payload.scoreHome}:${payload.scoreAway}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(payload);
    };
    for (const sourceMatchId of sourceMatchIds) {
      parsedExactRows
        .filter((payload) => String(payload.sourceMatchId || "") === sourceMatchId)
        .forEach(append);
    }
    for (const row of recentRows) append(safeJsonParse(row.payload, null));
    return rows.slice(0, safeLimit);
  } catch {
    return [];
  }
};

const readSqliteTransitionMatches = async (dbPath, options = {}) => {
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return [];
  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    if (!sqlitePublicationMatches(
      readSqlitePublicationIdentityFromDb(db),
      options.publicationIdentity,
    )) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return [];
    }
    const rows = querySqliteTransitionMatches(db, options);
    db.exec("COMMIT");
    transactionOpen = false;
    return rows;
  } catch {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* read transaction cleanup only */ }
    }
    return [];
  } finally {
    closeDatabase(db);
  }
};

const readSqliteCurrentTransitionSnapshot = async (dbPath, options = {}) => {
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return { available: false, currentRows: [], transitionRows: [], meta: {} };
  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    const publication = readSqlitePublicationIdentityFromDb(db);
    if (!sqlitePublicationMatches(publication, options.publicationIdentity)) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        available: false,
        currentRows: [],
        transitionRows: [],
        meta: {},
        publication,
        reason: "sqlite-generation-mismatch",
      };
    }
    const currentRows = parsePayloadRows(db.prepare(`
      SELECT payload
      FROM match_snapshots
      WHERE dataset = 'current'
      ORDER BY kickoff_time ASC, match_id ASC
    `).all());
    const transitionRows = querySqliteTransitionMatches(db, options);
    const meta = Object.fromEntries(db.prepare(`
      SELECT key, value, updated_at
      FROM schema_meta
      WHERE key IN (
        'fast_result_revision', 'fast_result_published_at', 'dataset_revision',
        'source_cycle_id', 'data_generation_id', 'manifest_hash', 'committed_at',
        'data_publication_mode', 'data_generation_source_cycle_id'
      )
    `).all().map((row) => [row.key, { value: row.value, updatedAt: row.updated_at }]));
    db.exec("COMMIT");
    transactionOpen = false;
    return { available: true, currentRows, transitionRows, meta, publication };
  } catch {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* read transaction cleanup only */ }
    }
    return { available: false, currentRows: [], transitionRows: [], meta: {} };
  } finally {
    closeDatabase(db);
  }
};

const readSqliteFastResultReceiptState = async (dbPath, options = {}) => {
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return {
    available: false,
    valid: false,
    missing: true,
    legacy: false,
    reason: "sqlite-unavailable",
    revision: null,
    receipt: null,
  };
  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    if (!sqlitePublicationMatches(
      readSqlitePublicationIdentityFromDb(db),
      options.publicationIdentity,
    )) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        available: true,
        valid: false,
        missing: false,
        legacy: false,
        reason: "publication-identity-mismatch",
        revision: null,
        receipt: null,
      };
    }
    const state = readFastResultReceiptState(db);
    const result = {
      available: true,
      valid: state.valid === true,
      missing: state.missing === true,
      legacy: state.legacy === true,
      reason: state.reason || null,
      revision: Number.isSafeInteger(state.revision) ? state.revision : null,
      receipt: state.valid && !state.missing ? state.receipt : null,
    };
    db.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* read transaction cleanup only */ }
    }
    return {
      available: true,
      valid: false,
      missing: false,
      legacy: false,
      reason: "receipt-state-read-failed",
      error: String(error?.message || error || "unknown SQLite receipt read failure").slice(0, 300),
      revision: null,
      receipt: null,
    };
  } finally {
    closeDatabase(db);
  }
};

const readSqliteFastResultReceipt = async (dbPath, options = {}) => {
  const state = await readSqliteFastResultReceiptState(dbPath, options);
  return state.valid && !state.missing ? state.receipt : null;
};

const readSqliteHistoryMatchesPage = async (dbPath, options = {}) => {
  const safeLimit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  const safeOffset = Math.max(0, Number(options.offset || 0));
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return { rows: [], consumedRows: 0, totalAvailable: 0 };
  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    if (!sqlitePublicationMatches(
      readSqlitePublicationIdentityFromDb(db),
      options.publicationIdentity,
    )) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { rows: [], consumedRows: 0, totalAvailable: 0 };
    }
    const totalAvailable = getSingleValue(
      db,
      "SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset = 'history'"
    ) || 0;
    const rows = db.prepare(`
      SELECT payload
      FROM match_snapshots
      WHERE dataset = 'history'
      ORDER BY kickoff_time DESC, match_id ASC
      LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset);
    const result = {
      rows: parsePayloadRows(rows),
      consumedRows: rows.length,
      totalAvailable
    };
    db.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* read transaction cleanup only */ }
    }
    return { rows: [], consumedRows: 0, totalAvailable: 0 };
  } finally {
    closeDatabase(db);
  }
};

const readSqliteMatchById = async (dbPath, id, options = {}) => {
  const matchId = String(id || "").trim();
  if (!matchId) return null;
  const sourceMatchId = sourceMatchIdFor(matchId);
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return null;
  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    if (!sqlitePublicationMatches(
      readSqlitePublicationIdentityFromDb(db),
      options.publicationIdentity,
    )) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return null;
    }
    const rows = db.prepare(`
      SELECT payload, dataset
      FROM match_snapshots
      WHERE match_id = ?
        OR source_match_id = ?
        OR match_id = ?
        OR source_match_id = ?
      ORDER BY CASE dataset WHEN 'current' THEN 0 ELSE 1 END, kickoff_time DESC
    `).all(matchId, matchId, sourceMatchId, sourceMatchId);
    const candidates = parsePayloadRows(rows);
    const resolved = candidates.reduce((current, candidate) => (
      current
        ? reconcileMatchLifecycle(current, candidate)
        : resolveMatchLifecycle(candidate)
    ), null);
    db.exec("COMMIT");
    transactionOpen = false;
    return resolved;
  } catch {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* read transaction cleanup only */ }
    }
    return null;
  } finally {
    closeDatabase(db);
  }
};

const readSqliteOddsHistoryRows = async (dbPath, options = {}) => {
  const safeLimit = Math.max(1, Math.min(500, Number(options.limit || 200)));
  const conditions = [];
  const params = [];
  const matchId = String(options.matchId || "").trim();
  const sourceMatchId = String(options.sourceMatchId || sourceMatchIdFor(matchId)).trim();
  const pool = String(options.pool || "").trim();

  if (matchId) {
    conditions.push("(match_id = ? OR source_match_id = ?)");
    params.push(matchId, sourceMatchId || matchId);
  } else if (sourceMatchId) {
    conditions.push("source_match_id = ?");
    params.push(sourceMatchId);
  }
  if (pool) {
    conditions.push("pool = ?");
    params.push(pool);
  }
  params.push(safeLimit);

  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return [];
  try {
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT payload
      FROM odds_snapshots
      ${where}
      ORDER BY captured_at DESC
      LIMIT ?
    `).all(...params);
    return parsePayloadRows(rows);
  } catch {
    return [];
  } finally {
    closeDatabase(db);
  }
};

const readSqlitePredictionSnapshotRows = async (dbPath, options = {}) => {
  const safeLimit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  const conditions = [];
  const params = [];
  const matchId = String(options.matchId || "").trim();
  const sourceMatchId = String(
    options.sourceMatchId
    || matchId.replace(/^(?:sporttery|fivehundred)_/, "")
  ).trim();
  const phase = String(options.phase || "").trim();

  if (matchId) {
    conditions.push("(match_id = ? OR source_match_id = ?)");
    params.push(matchId, sourceMatchId || matchId);
  } else if (sourceMatchId) {
    conditions.push("source_match_id = ?");
    params.push(sourceMatchId);
  }
  if (phase) {
    conditions.push("phase = ?");
    params.push(phase);
  }
  params.push(safeLimit);

  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return [];
  try {
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT payload
      FROM prediction_snapshots
      ${where}
      ORDER BY captured_at DESC, id DESC
      LIMIT ?
    `).all(...params);
    return parsePayloadRows(rows);
  } catch {
    return [];
  } finally {
    closeDatabase(db);
  }
};

module.exports = {
  getSqliteStatus,
  readSqlitePublicationIdentity,
  readSqliteCurrentMatches,
  readSqliteHistoryMatchesForList,
  readSqliteTransitionMatches,
  readSqliteHistoryMatchesPage,
  readSqliteCurrentTransitionSnapshot,
  readSqliteFastResultReceipt,
  readSqliteFastResultReceiptState,
  readSqliteMatchById,
  readSqliteOddsHistoryRows,
  readSqlitePredictionSnapshotRows
};
