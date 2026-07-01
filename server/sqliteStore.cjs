const fs = require("node:fs/promises");
const path = require("node:path");

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

const readMetaRows = (db) => {
  const rows = db.prepare("SELECT key, value, updated_at FROM schema_meta").all();
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

const sourceMatchIdFor = (id) => {
  const text = String(id || "").trim();
  if (!text) return "";
  return text.replace(/^sporttery_/, "");
};

const parsePayloadRows = (rows) => rows
  .map((row) => safeJsonParse(row.payload, null))
  .filter((payload) => payload && typeof payload === "object");

const getSqliteStatus = async (dbPath) => {
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

  try {
    const meta = readMetaRows(db);
    const counts = {
      currentMatches: getSingleValue(db, "SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset = 'current'") || 0,
      historyMatches: getSingleValue(db, "SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset = 'history'") || 0,
      legacyMatchSnapshots: getSingleValue(db, "SELECT COUNT(*) AS count FROM match_snapshots WHERE dataset NOT IN ('current', 'history')") || 0,
      oddsSnapshots: getSingleValue(db, "SELECT COUNT(*) AS count FROM odds_snapshots") || 0,
      predictionSnapshots: getSingleValue(db, "SELECT COUNT(*) AS count FROM prediction_snapshots") || 0,
      sourceSnapshots: getSingleValue(db, "SELECT COUNT(*) AS count FROM source_snapshots") || 0
    };
    return {
      available: true,
      path: resolvedPath,
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      schemaVersion: meta.schema_version?.value || null,
      exportedAt: meta.exported_at?.value || null,
      syncMetaUpdatedAt: meta.sync_meta_updated_at?.value || null,
      legacyJsonl: readMetaJson(meta, "legacy_jsonl_import", null),
      counts
    };
  } catch (error) {
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

const readSqliteCurrentMatches = async (dbPath) => {
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT payload
      FROM match_snapshots
      WHERE dataset = 'current'
      ORDER BY kickoff_time ASC, match_id ASC
    `).all();
    return parsePayloadRows(rows);
  } catch {
    return [];
  } finally {
    closeDatabase(db);
  }
};

const readSqliteHistoryMatchesForList = async (dbPath, limit = 600) => {
  const safeLimit = Math.max(1, Math.min(1200, Number(limit || 600)));
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT payload
      FROM match_snapshots
      WHERE dataset = 'history'
      ORDER BY kickoff_time DESC, match_id ASC
      LIMIT ?
    `).all(safeLimit);
    return parsePayloadRows(rows);
  } catch {
    return [];
  } finally {
    closeDatabase(db);
  }
};

const readSqliteMatchById = async (dbPath, id) => {
  const matchId = String(id || "").trim();
  if (!matchId) return null;
  const sourceMatchId = sourceMatchIdFor(matchId);
  const { db } = openReadonly(path.resolve(dbPath));
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT payload
      FROM match_snapshots
      WHERE match_id = ?
        OR source_match_id = ?
        OR match_id = ?
        OR source_match_id = ?
      ORDER BY CASE dataset WHEN 'current' THEN 0 ELSE 1 END, kickoff_time DESC
      LIMIT 1
    `).get(matchId, matchId, sourceMatchId, sourceMatchId);
    return row?.payload ? safeJsonParse(row.payload, null) : null;
  } catch {
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

module.exports = {
  getSqliteStatus,
  readSqliteCurrentMatches,
  readSqliteHistoryMatchesForList,
  readSqliteMatchById,
  readSqliteOddsHistoryRows
};
