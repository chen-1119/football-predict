const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  console.error("node:sqlite is unavailable. Use Node.js 22+ for SQLite export.");
  console.error(error.message || String(error));
  process.exit(1);
}

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const storeDir = process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data");
const jsonlDbDir = path.join(storeDir, "db");
const dbPath = process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db");
const oddsLimit = Math.max(1000, Number(process.env.SQLITE_EXPORT_ODDS_LIMIT || 50000));
const predictionLimit = Math.max(500, Number(process.env.SQLITE_EXPORT_PREDICTION_LIMIT || 10000));
const jsonlMatchLimit = Math.max(0, Number(process.env.SQLITE_IMPORT_JSONL_MATCH_LIMIT || 20000));
const jsonlOddsLimit = Math.max(0, Number(process.env.SQLITE_IMPORT_JSONL_ODDS_LIMIT || oddsLimit));
const jsonlPredictionLimit = Math.max(0, Number(process.env.SQLITE_IMPORT_JSONL_PREDICTION_LIMIT || predictionLimit));
const jsonlSyncLimit = Math.max(0, Number(process.env.SQLITE_IMPORT_JSONL_SYNC_LIMIT || 2000));

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const hashPayload = (payload) => {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
};

const sourceMatchIdFor = (match) => match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, "") || null;
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
const asText = (value) => String(value || "").trim();

const readJsonlTail = async (filePath, limit) => {
  if (!limit || limit <= 0 || !fs.existsSync(filePath)) return [];
  const rows = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
      if (rows.length > limit) rows.shift();
    } catch {
      // Ignore malformed legacy lines; they are not useful for the warehouse.
    }
  }
  return rows;
};

const readLegacyJsonl = async () => {
  const files = {
    syncRuns: path.join(jsonlDbDir, "sync-runs.jsonl"),
    matchSnapshots: path.join(jsonlDbDir, "match-snapshots.jsonl"),
    oddsSnapshots: path.join(jsonlDbDir, "odds-snapshots.jsonl"),
    predictionRuns: path.join(jsonlDbDir, "prediction-runs.jsonl")
  };
  const [syncRuns, matchSnapshots, oddsSnapshots, predictionRuns] = await Promise.all([
    readJsonlTail(files.syncRuns, jsonlSyncLimit),
    readJsonlTail(files.matchSnapshots, jsonlMatchLimit),
    readJsonlTail(files.oddsSnapshots, jsonlOddsLimit),
    readJsonlTail(files.predictionRuns, jsonlPredictionLimit)
  ]);
  return {
    version: "legacy-jsonl-import-v1",
    files,
    limits: {
      syncRuns: jsonlSyncLimit,
      matchSnapshots: jsonlMatchLimit,
      oddsSnapshots: jsonlOddsLimit,
      predictionRuns: jsonlPredictionLimit
    },
    rows: {
      syncRuns,
      matchSnapshots,
      oddsSnapshots,
      predictionRuns
    }
  };
};

const legacyDatasetFor = (row) => {
  const dataset = asText(row?.dataset || row?.phase || "snapshot")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `jsonl-${dataset || "snapshot"}`;
};

const matchPayloadForJsonl = (row) => asObject(row?.match) || asObject(row?.payload) || row;
const capturedAtFor = (row) => row?.capturedAt || row?.captureBucket || row?.oddsUpdatedAt || row?.updatedAt || row?.lastSeenAt || row?.finishedAt || row?.at || null;

const currentMatches = readJson(path.join(publicDataDir, "matches-current.json"), []);
const historyMatches = readJson(path.join(publicDataDir, "matches-history.json"), []);
const syncMeta = readJson(path.join(publicDataDir, "sync-meta.json"), null);
const externalSignals = readJson(path.join(publicDataDir, "external-signals.json"), null);
const oddsHistory = readJson(path.join(publicDataDir, "odds-history.json"), { rows: [] });
const predictionSnapshots = readJson(path.join(publicDataDir, "prediction-snapshots.json"), { rows: [] });

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

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

  CREATE TABLE IF NOT EXISTS odds_snapshots (
    id TEXT PRIMARY KEY,
    match_id TEXT,
    source_match_id TEXT,
    pool TEXT,
    captured_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prediction_snapshots (
    id TEXT PRIMARY KEY,
    match_id TEXT,
    source_match_id TEXT,
    phase TEXT,
    captured_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_match_snapshots_match_id ON match_snapshots(match_id);
  CREATE INDEX IF NOT EXISTS idx_match_snapshots_source_match_id ON match_snapshots(source_match_id);
  CREATE INDEX IF NOT EXISTS idx_match_snapshots_kickoff_time ON match_snapshots(kickoff_time);
  CREATE INDEX IF NOT EXISTS idx_odds_snapshots_match_id ON odds_snapshots(match_id);
  CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_match_id ON prediction_snapshots(match_id);
`);

const upsertMeta = db.prepare("INSERT OR REPLACE INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)");
const insertSource = db.prepare("INSERT OR REPLACE INTO source_snapshots (id, source, captured_at, payload) VALUES (?, ?, ?, ?)");
const insertMatch = db.prepare(`
  INSERT OR REPLACE INTO match_snapshots
  (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertOdds = db.prepare(`
  INSERT OR REPLACE INTO odds_snapshots
  (id, match_id, source_match_id, pool, captured_at, payload)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertPrediction = db.prepare(`
  INSERT OR REPLACE INTO prediction_snapshots
  (id, match_id, source_match_id, phase, captured_at, payload)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const exportRows = (legacyJsonl) => {
  const now = new Date().toISOString();
  const legacyCounts = {
    syncRuns: 0,
    matchSnapshots: 0,
    oddsSnapshots: 0,
    predictionRuns: 0
  };

  upsertMeta.run("schema_version", "football-sqlite-v1", now);
  upsertMeta.run("exported_at", now, now);
  upsertMeta.run("sync_meta_updated_at", syncMeta?.updatedAt || syncMeta?.capturedAt || "", now);

  db.exec("DELETE FROM source_snapshots");
  db.exec("DELETE FROM match_snapshots");
  db.exec("DELETE FROM odds_snapshots");
  db.exec("DELETE FROM prediction_snapshots");

  if (syncMeta) {
    insertSource.run(
      `sync-meta:${hashPayload(syncMeta)}`,
      syncMeta.source || "sporttery",
      syncMeta.updatedAt || syncMeta.capturedAt || null,
      JSON.stringify(syncMeta)
    );
  }
  if (externalSignals) {
    insertSource.run(
      `external-signals:${hashPayload({ updatedAt: externalSignals.updatedAt, count: Object.keys(externalSignals.matches || {}).length })}`,
      externalSignals.source || "external-signals",
      externalSignals.updatedAt || null,
      JSON.stringify(externalSignals)
    );
  }
  for (const row of legacyJsonl.rows.syncRuns) {
    insertSource.run(
      `jsonl-sync:${row?.id || hashPayload(row)}`,
      row?.source || "sync-run",
      capturedAtFor(row),
      JSON.stringify(row)
    );
    legacyCounts.syncRuns += 1;
  }

  for (const [dataset, rows] of [["current", currentMatches], ["history", historyMatches]]) {
    for (const match of Array.isArray(rows) ? rows : []) {
      const id = `${dataset}:${match?.id || sourceMatchIdFor(match) || hashPayload(match)}`;
      insertMatch.run(
        id,
        dataset,
        match?.id || null,
        sourceMatchIdFor(match),
        match?.kickoffTime || null,
        match?.status || null,
        JSON.stringify(match)
      );
    }
  }
  for (const row of legacyJsonl.rows.matchSnapshots) {
    const payload = matchPayloadForJsonl(row);
    const sourceMatchId = row?.sourceMatchId || payload?.sourceMatchId || sourceMatchIdFor(payload);
    const matchId = row?.matchId || payload?.id || (sourceMatchId ? `sporttery_${sourceMatchId}` : null);
    insertMatch.run(
      `jsonl-match:${row?.id || hashPayload(row)}`,
      legacyDatasetFor(row),
      matchId || null,
      sourceMatchId || null,
      row?.kickoffTime || payload?.kickoffTime || null,
      row?.status || payload?.status || null,
      JSON.stringify(payload)
    );
    legacyCounts.matchSnapshots += 1;
  }

  const oddsRows = Array.isArray(oddsHistory?.rows) ? oddsHistory.rows.slice(-oddsLimit) : [];
  for (const row of oddsRows) {
    const id = row.id || `odds:${hashPayload(row)}`;
    insertOdds.run(
      id,
      row.matchId || (row.sourceMatchId ? `sporttery_${row.sourceMatchId}` : null),
      row.sourceMatchId || null,
      row.pool || row.poolCode || row.oddsPoolCode || null,
      row.capturedAt || row.captureBucket || row.oddsUpdatedAt || row.updatedAt || null,
      JSON.stringify(row)
    );
  }
  for (const row of legacyJsonl.rows.oddsSnapshots) {
    const sourceMatchId = row?.sourceMatchId || sourceMatchIdFor(row);
    insertOdds.run(
      `jsonl-odds:${row?.id || hashPayload(row)}`,
      row?.matchId || (sourceMatchId ? `sporttery_${sourceMatchId}` : null),
      sourceMatchId || null,
      row?.pool || row?.poolCode || row?.oddsPoolCode || null,
      capturedAtFor(row),
      JSON.stringify(row)
    );
    legacyCounts.oddsSnapshots += 1;
  }

  const predictionRows = Array.isArray(predictionSnapshots?.rows) ? predictionSnapshots.rows.slice(-predictionLimit) : [];
  for (const row of predictionRows) {
    const id = row.id || `prediction:${hashPayload(row)}`;
    insertPrediction.run(
      id,
      row.matchId || null,
      row.sourceMatchId || null,
      row.phase || null,
      row.capturedAt || row.lastSeenAt || null,
      JSON.stringify(row)
    );
  }
  for (const row of legacyJsonl.rows.predictionRuns) {
    insertPrediction.run(
      `jsonl-prediction:${row?.id || hashPayload(row)}`,
      row?.matchId || null,
      row?.sourceMatchId || null,
      row?.phase || null,
      capturedAtFor(row),
      JSON.stringify(row)
    );
    legacyCounts.predictionRuns += 1;
  }

  upsertMeta.run("legacy_jsonl_import", JSON.stringify({
    version: legacyJsonl.version,
    importedAt: now,
    storeDir,
    dbDir: jsonlDbDir,
    limits: legacyJsonl.limits,
    imported: legacyCounts,
    files: Object.fromEntries(Object.entries(legacyJsonl.files).map(([key, filePath]) => [key, {
      path: filePath,
      exists: fs.existsSync(filePath)
    }]))
  }), now);

  return legacyCounts;
};

(async () => {
  const legacyJsonl = await readLegacyJsonl();
  let legacyCounts = null;
  try {
    db.exec("BEGIN IMMEDIATE");
    legacyCounts = exportRows(legacyJsonl);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures after a failed export.
    }
    throw error;
  } finally {
    db.close();
  }

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    journalMode: "WAL",
    counts: {
      currentMatches: Array.isArray(currentMatches) ? currentMatches.length : 0,
      historyMatches: Array.isArray(historyMatches) ? historyMatches.length : 0,
      oddsSnapshots: (Array.isArray(oddsHistory?.rows) ? Math.min(oddsHistory.rows.length, oddsLimit) : 0) + (legacyCounts?.oddsSnapshots || 0),
      predictionSnapshots: (Array.isArray(predictionSnapshots?.rows) ? Math.min(predictionSnapshots.rows.length, predictionLimit) : 0) + (legacyCounts?.predictionRuns || 0),
      legacyMatchSnapshots: legacyCounts?.matchSnapshots || 0,
      legacySyncRuns: legacyCounts?.syncRuns || 0
    },
    legacyJsonl: {
      version: legacyJsonl.version,
      limits: legacyJsonl.limits,
      imported: legacyCounts
    }
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
