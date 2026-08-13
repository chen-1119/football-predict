const fs = require("node:fs");
const path = require("node:path");
const {
  withOddsObservationTrail,
} = require("../src/services/oddsObservationTrail.cjs");

const sqliteBackfillCache = new Map();

const emptyOddsHistory = () => ({
  version: 3,
  source: "sporttery:HAD+HHAD",
  rows: [],
});

const normalizeOddsHistory = (payload) => {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.rows)) return null;
  return {
    ...payload,
    version: Number(payload.version || 1),
    source: payload.source || "sporttery:HAD",
    rows: payload.rows,
  };
};

const oddsHistoryCandidatePaths = (publicDir) => [
  path.join(publicDir, "data", "odds-history.json"),
  path.join(publicDir, "odds-history.json"),
];

const timestampMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};

const earlierIso = (left, right) => (
  !left || (right && timestampMs(right) < timestampMs(left)) ? right : left
);

const laterIso = (left, right) => (
  !left || (right && timestampMs(right) > timestampMs(left)) ? right : left
);

const sourceMatchIdFor = (value) => String(value || "").trim().replace(/^sporttery_/, "");

const normalizedPool = (value) => {
  const pool = String(value || "").trim().toUpperCase();
  return pool === "HAD" || pool === "HHAD" ? pool : null;
};

const normalizedLine = (pool, value) => {
  if (pool === "HAD") return 0;
  const normalized = String(value ?? "")
    .trim()
    .replace(/\uFF0B/g, "+")
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, "-");
  const line = Number(normalized);
  return Number.isFinite(line) ? line : null;
};

const lineForSignature = (line) => {
  if (!Number.isFinite(line) || line === 0) return "0";
  const absolute = Math.abs(line);
  const text = Number.isInteger(absolute)
    ? String(absolute)
    : absolute.toFixed(2).replace(/\.?0+$/, "");
  return `${line > 0 ? "+" : "-"}${text}`;
};

const oddsTriplet = (payload) => {
  const odds = [Number(payload?.odds1), Number(payload?.oddsX), Number(payload?.odds2)];
  return odds.every((value) => Number.isFinite(value) && value > 1.01) ? odds : null;
};

const stateSignature = (pool, line, odds) => [
  pool,
  lineForSignature(line),
  ...odds.map((value) => value.toFixed(3)),
].join("|");

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const currentMatchBoundaries = (publicDir) => {
  const current = readJson(path.join(publicDir, "data", "matches-current.json"), []);
  const boundaries = new Map();
  for (const match of Array.isArray(current) ? current : []) {
    const sourceMatchId = sourceMatchIdFor(match?.sourceMatchId || match?.id);
    if (!sourceMatchId) continue;
    const limits = [match?.predictionMeta?.cutoffTime, match?.buyEndTime, match?.kickoffTime]
      .map(timestampMs)
      .filter((value) => value > 0);
    if (!limits.length) continue;
    boundaries.set(sourceMatchId, {
      cutoffTime: new Date(Math.min(...limits)).toISOString(),
      kickoffTime: match?.kickoffTime || null,
    });
  }
  return boundaries;
};

const canonicalSqliteOddsRow = (record, boundary) => {
  const payload = readJsonPayload(record?.payload);
  const sourceMatchId = sourceMatchIdFor(record?.source_match_id || payload?.sourceMatchId || payload?.matchId);
  const pool = normalizedPool(record?.pool || payload?.pool || payload?.poolCode || payload?.oddsPoolCode);
  const line = normalizedLine(pool, payload?.handicapLine ?? payload?.handicap);
  const odds = oddsTriplet(payload);
  const capturedAt = payload?.capturedAt
    || payload?.oddsCapturedAt
    || payload?.captureBucket
    || payload?.at
    || record?.captured_at
    || null;
  const capturedMs = timestampMs(capturedAt);
  const cutoffMs = timestampMs(boundary?.cutoffTime);
  const sourceUrl = payload?.oddsSourceUrl || payload?.sourceUrl || null;
  if (!sourceMatchId || !pool || line === null || !odds || !capturedMs || !cutoffMs || capturedMs > cutoffMs) return null;
  if (!String(sourceUrl || "").includes("webapi.sporttery.cn")) return null;
  const signature = stateSignature(pool, line, odds);
  const firstSeenMs = Math.min(
    capturedMs,
    timestampMs(payload?.firstSeenAt) || capturedMs,
  );
  const declaredLastSeenMs = timestampMs(payload?.lastSeenAt) || capturedMs;
  const lastSeenMs = Math.max(firstSeenMs, Math.min(declaredLastSeenMs, cutoffMs));
  return withOddsObservationTrail({
    capturedAt: new Date(firstSeenMs).toISOString(),
    firstSeenAt: new Date(firstSeenMs).toISOString(),
    lastSeenAt: new Date(lastSeenMs).toISOString(),
    seenCount: Math.max(1, Number(payload?.seenCount || 1)),
    sourceMatchId,
    kickoffTime: payload?.kickoffTime || boundary.kickoffTime || null,
    cutoffTime: boundary.cutoffTime,
    captureBucket: payload?.captureBucket || new Date(capturedMs).toISOString(),
    poolCode: pool,
    handicapLine: pool === "HHAD" ? lineForSignature(line) : 0,
    odds1: odds[0],
    oddsX: odds[1],
    odds2: odds[2],
    oddsSource: `sporttery:${pool}`,
    oddsSourceMethod: payload?.oddsSourceMethod || payload?.sourceMethod || null,
    oddsObservedAt: payload?.oddsObservedAt || payload?.oddsUpdatedAt || null,
    oddsUpdatedAt: payload?.oddsUpdatedAt || null,
    oddsSourceUrl: sourceUrl,
    stateSignature: signature,
    oddsReceivedAt: payload?.oddsReceivedAt || null,
    lastOddsReceivedAt: payload?.lastOddsReceivedAt || null,
    sourceCycleId: payload?.sourceCycleId || null,
    lastSourceCycleId: payload?.lastSourceCycleId || null,
    marketProvenance: payload?.marketProvenance || payload?.oddsMarketProvenance || null,
    observationTrail: payload?.observationTrail || [],
  });
};

function readJsonPayload(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

const mergeStateRows = (rows) => {
  const byState = new Map();
  for (const row of rows || []) {
    const sourceMatchId = sourceMatchIdFor(row?.sourceMatchId || row?.matchId);
    const signature = String(row?.stateSignature || "").trim();
    if (!sourceMatchId || !signature) continue;
    const key = `${sourceMatchId}|${signature}`;
    const existing = byState.get(key);
    if (!existing) {
      byState.set(key, withOddsObservationTrail({
        ...row,
        sourceMatchId,
        seenCount: Math.max(1, Number(row?.seenCount || 1)),
      }));
      continue;
    }
    byState.set(key, withOddsObservationTrail({
      ...existing,
      capturedAt: earlierIso(existing.capturedAt, row.capturedAt),
      firstSeenAt: earlierIso(existing.firstSeenAt || existing.capturedAt, row.firstSeenAt || row.capturedAt),
      lastSeenAt: laterIso(existing.lastSeenAt || existing.capturedAt, row.lastSeenAt || row.capturedAt),
      seenCount: Math.max(Number(existing.seenCount || 1), Number(row.seenCount || 1)),
    }, [row]));
  }
  return Array.from(byState.values());
};

const sqliteBackfillRows = (publicDir, options = {}) => {
  if (options.sqliteBackfill === false || process.env.ODDS_HISTORY_SQLITE_BACKFILL === "0") return [];
  const boundaries = currentMatchBoundaries(publicDir);
  if (!boundaries.size) return [];
  const defaultStoreDir = process.env.SERVER_STORE_DIR
    || process.env.DATA_STORE_DIR
    || path.join(path.dirname(publicDir), "server-data");
  const sqlitePath = path.resolve(
    options.sqlitePath
    || process.env.DATASTORE_SQLITE_PATH
    || path.join(defaultStoreDir, "football.db")
  );
  if (!fs.existsSync(sqlitePath)) return [];
  const currentPath = path.join(publicDir, "data", "matches-current.json");
  const cacheKey = [
    sqlitePath,
    fs.statSync(sqlitePath).mtimeMs,
    fs.existsSync(currentPath) ? fs.statSync(currentPath).mtimeMs : 0,
  ].join(":");
  if (sqliteBackfillCache.has(cacheKey)) return sqliteBackfillCache.get(cacheKey);

  let database = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    database = new DatabaseSync(sqlitePath, { readOnly: true });
    const ids = Array.from(boundaries.keys());
    const placeholders = ids.map(() => "?").join(",");
    const records = database.prepare(`
      SELECT source_match_id, pool, captured_at, payload
      FROM odds_snapshots
      WHERE source_match_id IN (${placeholders})
      ORDER BY captured_at ASC
      LIMIT 120000
    `).all(...ids);
    const canonicalRows = records
      .map((record) => canonicalSqliteOddsRow(record, boundaries.get(sourceMatchIdFor(record.source_match_id))))
      .filter(Boolean);
    const merged = mergeStateRows(canonicalRows).map((row) => {
      const observations = canonicalRows.filter((candidate) => (
        candidate.sourceMatchId === row.sourceMatchId && candidate.stateSignature === row.stateSignature
      ));
      return { ...row, seenCount: Math.max(1, Number(row.seenCount || 1), observations.length) };
    });
    sqliteBackfillCache.clear();
    sqliteBackfillCache.set(cacheKey, merged);
    return merged;
  } catch {
    return [];
  } finally {
    try {
      database?.close();
    } catch {
      // Read-only recovery is best effort; the canonical JSON path remains authoritative.
    }
  }
};

const loadOddsHistory = (publicDir, options = {}) => {
  const candidates = [];
  for (const [priority, filePath] of oddsHistoryCandidatePaths(publicDir).entries()) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const normalized = normalizeOddsHistory(parsed);
      if (!normalized) continue;
      const payloadTimeMs = Date.parse(normalized.updatedAt || normalized.generatedAt || "");
      const fileTimeMs = fs.statSync(filePath).mtimeMs;
      candidates.push({
        payload: normalized,
        priority,
        freshnessMs: Number.isFinite(payloadTimeMs) ? payloadTimeMs : fileTimeMs,
      });
    } catch {
      // Try the compatibility path before failing closed to an empty store.
    }
  }
  candidates.sort((left, right) => (
    right.freshnessMs - left.freshnessMs
    || left.priority - right.priority
  ));
  const selected = candidates[0]?.payload || emptyOddsHistory();
  const sqliteRows = sqliteBackfillRows(publicDir, options);
  if (!sqliteRows.length) return selected;
  const maxRows = Math.max(1000, Number(selected.maxRows || process.env.ODDS_HISTORY_MAX_ROWS || 12000));
  const rows = mergeStateRows([...(selected.rows || []), ...sqliteRows])
    .sort((left, right) => timestampMs(left.capturedAt) - timestampMs(right.capturedAt))
    .slice(-maxRows);
  return {
    ...selected,
    version: Math.max(3, Number(selected.version || 3)),
    source: "sporttery:HAD+HHAD",
    rows,
  };
};

module.exports = {
  emptyOddsHistory,
  loadOddsHistory,
  normalizeOddsHistory,
  oddsHistoryCandidatePaths,
  sqliteBackfillRows,
};
