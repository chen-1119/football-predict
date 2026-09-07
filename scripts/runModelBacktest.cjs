const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { observePredictionEvidence, summarizePredictionEvidence } = require("./predictionEvidenceAudit.cjs");
const { exactDecisionEventMatch } = require("../src/services/decisionEventIdentity.cjs");
const {
  MULTI_FACTOR_POLICY_VERSION,
  evaluateMultiFactorRecommendation,
} = require("../src/services/multiFactorRecommendation.cjs");
const {
  DECISION_SNAPSHOT_VERSION,
  LEGACY_DECISION_SNAPSHOT_VERSION,
  isDecisionSnapshotVersion,
  isDecisionClockAuditEligible,
  isPromotionDecisionSnapshotVersion,
  replayCandidateEvidence,
  selectLatestEligibleDecisionSnapshot,
  settleDecisionCandidate,
} = require("../src/services/decisionSnapshot.cjs");
const {
  evaluateHhadCompanionShadowHistory,
} = require("../src/services/hhadCompanionShadowEvaluation.cjs");
const {
  HHAD_COMPANION_AUDIT_KEY,
  writePrivateModelArtifact,
} = require("./privateModelArtifactStore.cjs");
const {
  buildWalkForwardValidation,
} = require("./walkForwardValidation.cjs");
const {
  evaluateResidualMarketWalkForward,
} = require("./residualMarketWalkForward.cjs");
const {
  buildPromotionEvidenceAudit,
} = require("./promotionEvidenceAudit.cjs");
const {
  resultObservationForMatch: strictResultObservationForMatch,
} = require("./asOfResultTimeline.cjs");
const {
  buildWorldCupAudit,
  loadAuditInputs: loadWorldCupAuditInputs,
} = require("./auditWorldCupHitRate.cjs");
const {
  loadWorldCupResearchSnapshot,
  researchAuditFromSnapshot,
} = require("./worldCupResearchSnapshot.cjs");
const {
  buildBenchmarkProspectiveAudit,
} = require("./benchmarkProspectiveLedger.cjs");
const {
  buildShadowCandidateRobustness,
  nominationSelectionPolicyCommitment,
  rankShadowCandidatesForNomination,
} = require("./shadowCandidateRobustness.cjs");
const {
  DEFAULT_REGISTRY_LOCK_TIMEOUT_MS,
  CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  candidateGateSpecCompatibility,
  candidateEvaluatorSemanticHashes,
  updateCandidateProspectiveLedger,
  withCandidateProspectiveRegistryLock,
} = require("./candidateProspectiveLedger.cjs");
const {
  assessClvTiming,
  summarizeClvRows,
} = require("../src/services/clvTimingAudit.cjs");
const {
  ODDS_OBSERVATION_TRAIL_VERSION,
  oddsObservationTrailForRow,
} = require("../src/services/oddsObservationTrail.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data");
const outputDir = path.join(serverDataDir, "model-artifacts");
const defaultPublicOutputFile = path.join(publicDataDir, "model-evaluation.json");
const publicOutputFile = path.resolve(
  process.env.MODEL_BACKTEST_PUBLIC_OUTPUT_FILE
    || defaultPublicOutputFile,
);
const isolatedOutput = publicOutputFile !== path.resolve(defaultPublicOutputFile);
const isolatedOutputStem = publicOutputFile.replace(/\.json$/i, "");
const serverOutputFile = path.resolve(
  process.env.MODEL_BACKTEST_SERVER_OUTPUT_FILE
    || (isolatedOutput ? `${isolatedOutputStem}.server.json` : path.join(outputDir, "evaluation.json")),
);
const shadowCandidatesOutputFile = path.resolve(
  process.env.MODEL_BACKTEST_SHADOW_OUTPUT_FILE
    || (isolatedOutput ? `${isolatedOutputStem}.shadow-candidates.json` : path.join(outputDir, "shadow-candidates.json")),
);
const benchmarkProspectiveLedgerFile = path.resolve(
  process.env.BENCHMARK_PROSPECTIVE_LEDGER_FILE
    || (isolatedOutput
      ? `${isolatedOutputStem}.benchmark-prospective-ledger.json`
      : path.join(outputDir, "benchmark-prospective-ledger.json")),
);
const candidateProspectiveRegistryFile = path.resolve(
  process.env.CANDIDATE_PROSPECTIVE_REGISTRY_FILE
    || (isolatedOutput
      ? `${isolatedOutputStem}.candidate-prospective-registry.json`
      : path.join(outputDir, "candidate-prospective-registry.json")),
);
const configuredCandidateProspectiveRegistryLockTimeoutMs = Number(
  process.env.CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT_MS,
);
const candidateProspectiveRegistryLockTimeoutMs = Number.isFinite(
  configuredCandidateProspectiveRegistryLockTimeoutMs,
)
  ? Math.max(0, configuredCandidateProspectiveRegistryLockTimeoutMs)
  : DEFAULT_REGISTRY_LOCK_TIMEOUT_MS;
const sqliteDbPath = path.resolve(process.env.DATASTORE_SQLITE_PATH || path.join(serverDataDir, "football.db"));
const privateArtifactDbPath = path.resolve(
  process.env.MODEL_BACKTEST_PRIVATE_ARTIFACT_DB_PATH
    || (isolatedOutput ? `${isolatedOutputStem}.private.sqlite` : sqliteDbPath),
);
const legacyHhadCompanionAuditFile = path.resolve(
  process.env.MODEL_BACKTEST_LEGACY_PRIVATE_AUDIT_FILE
    || (isolatedOutput
      ? `${isolatedOutputStem}.legacy-hhad-companion-audit.json`
      : path.join(outputDir, "hhad-companion-audit.json")),
);

const sha256File = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const candidateImplementationCommitment = {
  commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  semanticHashes: candidateEvaluatorSemanticHashes(),
  // The evaluator uses only deterministic JavaScript math. Unrelated changes
  // to backtest orchestration, capture scheduling or package-lock must not
  // retire an already activated prospective cohort.
  sourceHashes: {},
  dependencyLockHash: "",
};

const VERSION = "rolling-backtest-v19";
const MIN_PROMOTION_PROBABILITY_ROWS = 500;

let DatabaseSync = null;
let sqliteLoadError = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  sqliteLoadError = error;
}

const ensureIsolatedPrivateArtifactDb = () => {
  if (!isolatedOutput) return;
  if (fs.existsSync(privateArtifactDbPath) && fs.statSync(privateArtifactDbPath).size > 0) return;
  if (!DatabaseSync) {
    throw sqliteLoadError || new Error("node:sqlite is required for isolated private model artifacts");
  }
  fs.mkdirSync(path.dirname(privateArtifactDbPath), { recursive: true });
  const db = new DatabaseSync(privateArtifactDbPath);
  db.exec("PRAGMA user_version = 1");
  db.close();
};

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tempFile, filePath);
  } finally {
    if (fs.existsSync(tempFile)) fs.rmSync(tempFile, { force: true });
  }
};

const removeLegacyPrivateAuditFile = (filePath) => {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(filePath);
  } else {
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`refusing unsafe legacy private audit path: ${filePath}`);
    }
    fs.unlinkSync(filePath);
  }
  if (fs.existsSync(filePath)) {
    throw new Error(`legacy private audit file was not removed: ${filePath}`);
  }
  return true;
};

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

const payloadRowKey = (row, label) => label === "predictionSnapshots"
  ? [
      row?.sourceMatchId || row?.matchId || "",
      row?.phase || "",
      row?.signature || "",
      row?.featureSnapshotHash || row?.featureSnapshot?.hash || "legacy",
      row?.capturedAt || row?.firstSeenAt || "",
    ].join("|")
  : [
      row?.sourceMatchId || row?.matchId || "",
      row?.poolCode || row?.oddsPoolCode || "HAD",
      row?.handicapLine ?? 0,
      row?.stateSignature || row?.captureBucket || row?.capturedAt || "",
    ].join("|");

const readSqlitePayloadRows = (table, options = {}) => {
  const allowedTables = new Set(["odds_snapshots", "prediction_snapshots"]);
  const dbPath = path.resolve(options.dbPath || sqliteDbPath);
  if (!allowedTables.has(table)) {
    return { ok: false, rows: [], source: "sqlite", table, reason: "table not allowed" };
  }
  if (!DatabaseSync) {
    return {
      ok: false,
      rows: [],
      source: "sqlite",
      table,
      path: dbPath,
      reason: sqliteLoadError?.message || "node:sqlite is unavailable"
    };
  }
  if (!fs.existsSync(dbPath)) {
    return { ok: false, rows: [], source: "sqlite", table, path: dbPath, reason: "sqlite database not found" };
  }

  const limit = Math.max(1, Number(options.limit || 100000));
  const orderDirection = options.preferLatestRows === true ? "DESC" : "ASC";
  const maxRowsPerMatch = Math.max(0, Number(options.maxRowsPerMatch || 0));
  const label = table === "prediction_snapshots" ? "predictionSnapshots" : "oddsHistory";
  const orderColumn = table === "prediction_snapshots" ? "captured_at" : "captured_at";
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const statement = db.prepare(`
      SELECT payload
      FROM ${table}
      ORDER BY ${orderColumn} ${orderDirection}
      LIMIT ?
    `);
    const rowsByKey = new Map();
    const retainedKeysByMatch = new Map();
    let selectedRows = 0;
    let parsedRows = 0;
    let invalidRows = 0;
    let duplicateRows = 0;
    let filteredRows = 0;
    let compactedRows = 0;
    let peakHeapUsed = options.observeMemory === true ? process.memoryUsage().heapUsed : null;
    for (const row of statement.iterate(limit)) {
      selectedRows += 1;
      const payload = safeJsonParse(row.payload, null);
      if (!payload || typeof payload !== "object") {
        invalidRows += 1;
        continue;
      }
      parsedRows += 1;
      if (typeof options.acceptPayload === "function" && options.acceptPayload(payload) !== true) {
        filteredRows += 1;
        continue;
      }
      const key = payloadRowKey(payload, label);
      if (rowsByKey.has(key)) {
        duplicateRows += 1;
        // A descending scan sees the newest duplicate first. Do not let an
        // older revision overwrite it while walking toward the past.
        if (options.preferLatestRows === true) continue;
      }
      if (maxRowsPerMatch > 0) {
        const matchKey = String(payload.sourceMatchId || payload.matchId || "").trim();
        if (matchKey && !rowsByKey.has(key)) {
          const retainedKeys = retainedKeysByMatch.get(matchKey) || [];
          if (retainedKeys.length >= maxRowsPerMatch) {
            compactedRows += 1;
            if (options.preferLatestRows === true) continue;
            const evictedKey = retainedKeys.shift();
            if (evictedKey) rowsByKey.delete(evictedKey);
          }
          retainedKeys.push(key);
          retainedKeysByMatch.set(matchKey, retainedKeys);
        }
      }
      rowsByKey.set(key, payload);
      if (options.observeMemory === true && selectedRows % 128 === 0) {
        peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
      }
    }
    if (options.observeMemory === true) {
      peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
    }
    const rows = Array.from(rowsByKey.values());
    if (options.preferLatestRows === true) {
      rows.sort((a, b) => Date.parse(a?.capturedAt || a?.firstSeenAt || "")
        - Date.parse(b?.capturedAt || b?.firstSeenAt || ""));
    }
    return {
      ok: true,
      rows,
      source: "sqlite",
      table,
      path: dbPath,
      limit,
      selectedRows,
      parsedRows,
      invalidRows,
      duplicateRows,
      filteredRows,
      compactedRows,
      uniqueRows: rows.length,
      peakHeapUsed,
    };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      source: "sqlite",
      table,
      path: dbPath,
      reason: error.message || String(error)
    };
  } finally {
    closeDatabase(db);
  }
};

const isBacktestPredictionSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (String(snapshot.phase || "").toLowerCase() === "review") return false;
  const kickoffMs = Date.parse(snapshot.kickoffTime || snapshot.decisionSnapshot?.kickoffTime || "");
  const capturedMs = Date.parse(
    snapshot.decisionSnapshot?.capturedAt
      || snapshot.capturedAt
      || snapshot.firstSeenAt
      || "",
  );
  return !Number.isFinite(kickoffMs)
    || !Number.isFinite(capturedMs)
    || capturedMs <= kickoffMs;
};

const preferRows = (publicRows, sqliteResult, label) => {
  const publicCount = Array.isArray(publicRows) ? publicRows.length : 0;
  const sqliteRows = Array.isArray(sqliteResult?.rows) ? sqliteResult.rows : [];
  const sqliteParsedRows = Number.isSafeInteger(sqliteResult?.parsedRows)
    ? sqliteResult.parsedRows
    : sqliteRows.length;
  const sqliteAudit = {
    sqliteRows: sqliteParsedRows,
    sqliteUniqueRows: Number.isSafeInteger(sqliteResult?.uniqueRows)
      ? sqliteResult.uniqueRows
      : sqliteRows.length,
    sqliteSelectedRows: Number.isSafeInteger(sqliteResult?.selectedRows)
      ? sqliteResult.selectedRows
      : sqliteRows.length,
    sqliteInvalidRows: Number.isSafeInteger(sqliteResult?.invalidRows)
      ? sqliteResult.invalidRows
      : 0,
    sqliteDuplicateRows: Number.isSafeInteger(sqliteResult?.duplicateRows)
      ? sqliteResult.duplicateRows
      : Math.max(0, sqliteParsedRows - sqliteRows.length),
  };
  if (sqliteResult?.ok && sqliteParsedRows > publicCount) {
    const merged = new Map();
    for (const row of sqliteRows) merged.set(payloadRowKey(row, label), row);
    for (const row of Array.isArray(publicRows) ? publicRows : []) merged.set(payloadRowKey(row, label), row);
    return {
      rows: Array.from(merged.values()),
      selectedSource: "sqlite+public-json",
      label,
      publicRows: publicCount,
      ...sqliteAudit,
      mergedRows: merged.size,
      sqliteLimit: sqliteResult.limit || null
    };
  }
  return {
    rows: Array.isArray(publicRows) ? publicRows : [],
    selectedSource: "public-json",
    label,
    publicRows: publicCount,
    ...sqliteAudit,
    sqliteReason: sqliteResult?.reason || null
  };
};

const rowSelectionSummary = (selection) => {
  const { rows, ...summary } = selection || {};
  return summary;
};

const finiteMetric = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const round = (value, digits = 4) => {
  const number = finiteMetric(value);
  return number === null ? null : Number(number.toFixed(digits));
};

const finiteImprovementPair = (comparison) => {
  const logLossImprovement = finiteMetric(comparison?.logLossImprovement);
  const brierImprovement = finiteMetric(comparison?.brierImprovement);
  if (logLossImprovement === null || brierImprovement === null) return null;
  return { logLossImprovement, brierImprovement };
};

const hasNonNegativeImprovementPair = (comparison) => {
  const pair = finiteImprovementPair(comparison);
  return pair !== null
    && pair.logLossImprovement >= 0
    && pair.brierImprovement >= 0;
};

const strictScorePairFor = (match) => {
  const home = finiteMetric(match?.scoreHome);
  const away = finiteMetric(match?.scoreAway);
  if (home === null || away === null
      || !Number.isSafeInteger(home) || !Number.isSafeInteger(away)
      || home < 0 || away < 0) return null;
  return { home, away };
};

const clampProbability = (value) => Math.min(0.999, Math.max(0.001, Number(value || 0)));

const codeLabels = {
  "1": "home",
  X: "draw",
  "2": "away"
};

const resultCodeFor = (match) => {
  const score = strictScorePairFor(match);
  if (!score) return "";
  if (score.home > score.away) return "1";
  if (score.home < score.away) return "2";
  return "X";
};

const normalizePercent = (value) => {
  const number = finiteMetric(value);
  if (number === null || number < 0 || number > 100) return null;
  const normalized = number > 1 ? number / 100 : number;
  return normalized >= 0 && normalized <= 1 ? normalized : null;
};

const probabilityTripletFromFinal = (final) => {
  if (!final) return null;
  const home = normalizePercent(final.home ?? final["1"]);
  const draw = normalizePercent(final.draw ?? final.X);
  const away = normalizePercent(final.away ?? final["2"]);
  if (![home, draw, away].every((value) => value !== null && value >= 0 && value <= 1)) return null;
  const total = home + draw + away;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    "1": home / total,
    X: draw / total,
    "2": away / total
  };
};

const probabilityTripletFromSignature = (signature) => {
  const parts = String(signature || "").split("|");
  const tail = parts[parts.length - 1] || "";
  const match = tail.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return probabilityTripletFromFinal({
    home: Number(match[1]),
    draw: Number(match[2]),
    away: Number(match[3])
  });
};

const probabilityTripletFor = (match) => {
  return probabilityTripletFromFinal(match?.probabilityModel?.oneXTwo?.final)
    || probabilityTripletFromFinal(match?.probabilityFinal)
    || probabilityTripletFromSignature(match?.signature);
};

const probabilityTripletForSnapshot = (snapshot) => {
  return probabilityTripletFromFinal(snapshot?.decisionSnapshot?.probabilities?.HAD)
    || probabilityTripletFromFinal(snapshot?.probabilityFinal)
    || probabilityTripletFromFinal(snapshot?.probabilityModel?.oneXTwo?.final)
    || probabilityTripletFromFinal(snapshot?.probabilityModel?.final)
    || probabilityTripletFromSignature(snapshot?.signature);
};

const oddsTripletFor = (row) => {
  const source = row?.odds && typeof row.odds === "object" ? row.odds : row;
  const home = Number(source?.odds1 ?? source?.home ?? source?.h ?? source?.["1"]);
  const draw = Number(source?.oddsX ?? source?.draw ?? source?.d ?? source?.X);
  const away = Number(source?.odds2 ?? source?.away ?? source?.a ?? source?.["2"]);
  if (![home, draw, away].every((value) => Number.isFinite(value) && value > 1)) return null;
  return { "1": home, X: draw, "2": away };
};

const marketProbabilityTripletFor = (row) => {
  const odds = oddsTripletFor(row);
  if (!odds) return null;
  const raw = {
    "1": 1 / odds["1"],
    X: 1 / odds.X,
    "2": 1 / odds["2"]
  };
  const total = raw["1"] + raw.X + raw["2"];
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    "1": raw["1"] / total,
    X: raw.X / total,
    "2": raw["2"] / total
  };
};

const topProbabilityCode = (probabilities) => {
  const normalized = normalizeProbabilityTriplet(probabilities);
  if (!normalized) return "";
  return Object.entries(normalized)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "";
};

const probabilityForCode = (probabilities, code) => {
  if (!["1", "X", "2"].includes(code)) return null;
  const normalized = normalizeProbabilityTriplet(probabilities);
  return normalized ? normalized[code] : null;
};

const oddsForCode = (odds, code) => {
  const value = Number(odds?.[code]);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const finiteDecimalOdds = (value) => {
  const odds = Number(value);
  return Number.isFinite(odds) && odds > 1 ? odds : null;
};

const normalizeTipCodeForOdds = (code) => {
  const value = String(code || "").trim().toUpperCase();
  if (["1", "H", "HOME", "WIN"].includes(value)) return "1";
  if (["X", "D", "DRAW"].includes(value)) return "X";
  if (["2", "A", "AWAY", "LOSE"].includes(value)) return "2";
  return value;
};

const oddsBucket = (odds) => {
  const value = Number(odds);
  if (!Number.isFinite(value) || value <= 1) return "unknown";
  if (value <= 1.45) return "sp_le_1_45";
  if (value <= 1.7) return "sp_1_46_1_70";
  if (value <= 2.05) return "sp_1_71_2_05";
  if (value <= 2.6) return "sp_2_06_2_60";
  return "sp_gt_2_60";
};

const marketTypeFor = (prediction) => {
  if (prediction?.oddsPoolCode === "HHAD" && prediction?.marketType === "1X2") return "HHAD";
  return prediction?.marketType || "unknown";
};

const isMainRecommendation = (prediction) => {
  const action = String(prediction?.recommendationAction || "").trim().toLowerCase();
  const tier = String(prediction?.recommendationTier || "").trim().toLowerCase();
  const market = String(prediction?.marketType || "").trim().toUpperCase();
  return action === "recommend"
    && market === "BEST"
    && !tier.includes("reference")
    && !tier.includes("model-only")
    && !tier.includes("watch");
};

const predictionOddsPool = (prediction) => {
  const explicit = String(prediction?.oddsPoolCode || "").trim().toUpperCase();
  if (explicit) return explicit;
  const marketType = String(marketTypeFor(prediction) || "").toUpperCase();
  if (marketType === "HHAD") return "HHAD";
  if (marketType === "1X2" || marketType === "BEST") return "HAD";
  return marketType || "unknown";
};

const matchOddsTripletForPrediction = (match, prediction) => {
  const pool = predictionOddsPool(prediction);
  if (pool === "HHAD") {
    return oddsTripletFor(
      match?.handicapOdds
      || match?.hhadOdds
      || match?.hhad?.odds
      || match?.featureSnapshot?.market?.hhad?.odds
    );
  }
  if (pool === "HAD") {
    return oddsTripletFor(
      match?.odds
      || match?.hadOdds
      || match?.had?.odds
      || match?.oneXTwo?.odds
      || match?.featureSnapshot?.market?.had?.odds
    );
  }
  return null;
};

const officialOddsTripletForPrediction = (match, prediction, selectedSnapshot) => (
  snapshotOddsTripletForPrediction(selectedSnapshot, prediction)
  || matchOddsTripletForPrediction(match, prediction)
);

const snapshotOddsTripletForPrediction = (selectedSnapshot, prediction) => {
  const snapshot = selectedSnapshot?.snapshot || selectedSnapshot;
  const pool = predictionOddsPool(prediction);
  if (pool === "HHAD") {
    return oddsTripletFor(
      snapshot?.decisionSnapshot?.markets?.HHAD?.odds
      || snapshot?.handicapOdds
      || snapshot?.hhadOdds
      || snapshot?.featureSnapshot?.market?.hhad?.odds
    );
  }
  if (pool === "HAD") {
    return oddsTripletFor(
      snapshot?.decisionSnapshot?.markets?.HAD?.odds
      || snapshot?.odds
      || snapshot?.hadOdds
      || snapshot?.featureSnapshot?.market?.had?.odds
    );
  }
  return null;
};

const resolvePredictionOdds = (prediction, match, selectedSnapshot) => {
  for (const candidate of [
    prediction?.odds,
    prediction?.sp,
    prediction?.recommendedOdds,
    prediction?.decimalOdds
  ]) {
    const odds = finiteDecimalOdds(candidate);
    if (odds) return { odds, source: "prediction" };
  }

  const pool = predictionOddsPool(prediction);
  if (pool !== "HAD" && pool !== "HHAD") return { odds: null, source: null };

  const tipCode = normalizeTipCodeForOdds(prediction?.tipCode);
  if (!["1", "X", "2"].includes(tipCode)) return { odds: null, source: null };

  const matchOdds = oddsForCode(matchOddsTripletForPrediction(match, prediction), tipCode);
  if (matchOdds) return { odds: matchOdds, source: `match:${pool}` };

  const snapshotOdds = oddsForCode(snapshotOddsTripletForPrediction(selectedSnapshot, prediction), tipCode);
  if (snapshotOdds) return { odds: snapshotOdds, source: `prediction-snapshot:${pool}` };

  return { odds: null, source: null };
};

const profileKey = (match) => {
  const text = [
    match?.leagueName,
    match?.leagueNameEn,
    match?.countryName,
    match?.countryNameEn
  ].filter(Boolean).join(" ");
  if (/japan|j1|j2|\u65e5\u672c|\u65e5\u804c/i.test(text)) return "japan";
  if (/international|world cup|friendly|qualifier|fifa|\u56fd\u9645|\u4e16\u754c\u676f/i.test(text)) return "international";
  return "other";
};

const summarizePredictionRows = (rows) => {
  const settled = rows.length;
  const won = rows.filter((row) => row.won).length;
  const rowsWithOdds = rows.filter((row) => finiteDecimalOdds(row.odds));
  const stakeReturn = rowsWithOdds.reduce((sum, row) => {
    if (row.won) return sum + Math.max(0, Number(row.odds || 0) - 1);
    return sum - 1;
  }, 0);
  return {
    settled,
    won,
    lost: settled - won,
    hitRate: settled ? round(won / settled) : null,
    flatStakeRoi: rowsWithOdds.length ? round(stakeReturn / rowsWithOdds.length) : null,
    avgOdds: rowsWithOdds.length ? round(rowsWithOdds.reduce((sum, row) => sum + Number(row.odds || 0), 0) / rowsWithOdds.length, 3) : null,
    oddsRows: rowsWithOdds.length,
    missingOddsRows: settled - rowsWithOdds.length
  };
};

const summarizeBinaryProbabilityRows = (rows, probabilityKey) => {
  const scoredRows = rows.filter((row) => Number.isFinite(row?.[probabilityKey]));
  if (!scoredRows.length) {
    return { rows: 0, coverage: 0, brier: null, logLoss: null, avgProbability: null };
  }
  let brier = 0;
  let logLoss = 0;
  let probabilityTotal = 0;
  for (const row of scoredRows) {
    const probability = clampProbability(row[probabilityKey]);
    const actual = row.won ? 1 : 0;
    brier += (probability - actual) ** 2;
    logLoss += -(actual * Math.log(probability) + (1 - actual) * Math.log(1 - probability));
    probabilityTotal += probability;
  }
  return {
    rows: scoredRows.length,
    coverage: rows.length ? round(scoredRows.length / rows.length) : 0,
    brier: round(brier / scoredRows.length),
    logLoss: round(logLoss / scoredRows.length),
    avgProbability: round(probabilityTotal / scoredRows.length)
  };
};

const summarizeRecommendationSelectionRows = (rows) => {
  const matchedRows = rows.filter((row) => (
    Number.isFinite(row.modelPickProbability)
    && Number.isFinite(row.marketPickProbability)
  ));
  const modelMatched = summarizeBinaryProbabilityRows(matchedRows, "modelPickProbability");
  const marketMatched = summarizeBinaryProbabilityRows(matchedRows, "marketPickProbability");
  return {
    ...summarizePredictionRows(rows),
    selectedEventScoring: {
      interpretation: "binary Brier/log loss for the selected result event; lower is better",
      model: summarizeBinaryProbabilityRows(rows, "modelPickProbability"),
      deviggedMarket: summarizeBinaryProbabilityRows(rows, "marketPickProbability"),
      matchedRows: matchedRows.length,
      modelOnMatched: modelMatched,
      marketOnMatched: marketMatched,
      relativeToMarket: matchedRows.length ? {
        brierImprovement: round(marketMatched.brier - modelMatched.brier),
        logLossImprovement: round(marketMatched.logLoss - modelMatched.logLoss)
      } : { brierImprovement: null, logLossImprovement: null }
    }
  };
};

const multiFactorShadowEligible = (row) => {
  if (isPromotionDecisionSnapshotVersion(row?.decisionSnapshotVersion)) {
    return row.localEvidenceEligible === true;
  }
  // HHAD rows in the legacy archive are not consistently bound to the same
  // as-of snapshot as their odds. Keep them out of this shadow comparison
  // until candidate-level HAD/HHAD snapshots have enough settled coverage.
  if (row.oddsPoolCode !== "HAD") return false;
  const odds = Number(row.odds);
  const modelProbability = Number(row.modelPickProbability);
  const marketProbability = Number(row.marketPickProbability);
  if (!Number.isFinite(odds) || odds <= 1) return false;
  if (!Number.isFinite(modelProbability) || !Number.isFinite(marketProbability)) return false;
  const probabilityEdge = modelProbability - marketProbability;
  const expectedValue = modelProbability * odds - 1;
  const minimumProbability = odds <= 1.45 ? 0.56 : odds <= 2.2 ? 0.46 : odds <= 3 ? 0.4 : 0.38;
  if (modelProbability < minimumProbability || probabilityEdge < -0.025 || expectedValue < -0.04) return false;
  if (odds <= 1.45 && (probabilityEdge < 0.015 || expectedValue < 0.01)) return false;
  if (odds >= 2.8 && (modelProbability < 0.4 || probabilityEdge < 0.035 || expectedValue < 0.04)) return false;
  return true;
};

const recommendationSelectionKickoffEpoch = (row) => {
  const epoch = Date.parse(row?.kickoffTime || "");
  return Number.isFinite(epoch) ? epoch : null;
};

const recommendationSelectionStableRowKey = (row) => [
  row?.sourceMatchId,
  row?.matchId,
  row?.id,
  row?.oddsPoolCode,
  row?.marketType,
  row?.tipCode,
  row?.forecastTime,
  row?.kickoffTime,
].map((value) => String(value ?? "")).join("\u001f");

const compareRecommendationSelectionRows = (left, right) => {
  const leftEpoch = recommendationSelectionKickoffEpoch(left);
  const rightEpoch = recommendationSelectionKickoffEpoch(right);
  if (leftEpoch !== null && rightEpoch !== null && leftEpoch !== rightEpoch) {
    return leftEpoch - rightEpoch;
  }
  if (leftEpoch !== null) return -1;
  if (rightEpoch !== null) return 1;
  const leftKey = recommendationSelectionStableRowKey(left);
  const rightKey = recommendationSelectionStableRowKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
};

const legacyEvidenceReplayForCandidate = (decisionSnapshot, candidate) => {
  const diagnostics = candidate?.diagnostics || {};
  const replay = evaluateMultiFactorRecommendation({
    market: candidate?.market,
    code: candidate?.code,
    handicapLine: candidate?.handicapLine,
    odds: candidate?.odds,
    modelProbability: candidate?.modelProbability,
    marketProbability: candidate?.marketProbability,
    modelGap: candidate?.modelGap,
    dataQuality: decisionSnapshot?.dataQuality,
    scoreAligned: diagnostics.scoreAligned,
    crossMarketCompatible: diagnostics.crossMarketCompatible,
    handicapAligned: diagnostics.handicapAligned,
    marketLeaderAligned: diagnostics.marketLeaderAligned,
    trendSupports: diagnostics.trendSupports,
    trendContradicts: diagnostics.trendContradicts,
    externalMarketAligned: diagnostics.externalMarketAligned,
    externalMarketContradicted: diagnostics.externalMarketContradicted,
    externalMarketRisk: diagnostics.externalMarketRisk,
    upstreamRecommended: diagnostics.upstreamRecommended,
    upstreamAligned: diagnostics.upstreamAligned,
    globalRiskTier: diagnostics.globalRiskTier,
    trustPenalty: diagnostics.trustPenalty,
    riskPenalty: diagnostics.riskPenalty,
    severeMissingCount: diagnostics.severeMissingCount,
    riskTagsCount: diagnostics.riskTagsCount,
  });
  const expectedBlockers = [...(candidate?.blockers || [])].sort();
  const replayBlockers = [...(replay?.blockers || [])].sort();
  const exact = replay?.version === candidate?.evidenceVersion
    && replay?.eligible === candidate?.publicEligible
    && Number(replay?.evidenceScore) === Number(candidate?.evidenceScore)
    && JSON.stringify(replayBlockers) === JSON.stringify(expectedBlockers);
  return {
    exact,
    replay,
    promotionEligible: false,
    reason: exact ? "legacy-v1-audit-exact" : "legacy-v1-audit-mismatch",
  };
};

const evidenceReplayForCandidate = (decisionSnapshot, candidate) => (
  isPromotionDecisionSnapshotVersion(decisionSnapshot?.version)
    ? replayCandidateEvidence(decisionSnapshot, candidate)
    : legacyEvidenceReplayForCandidate(decisionSnapshot, candidate)
);

const recommendationSelectionComparison = (rows, candidateDecisionRows = []) => {
  const chronologicalRows = [...rows]
    .sort(compareRecommendationSelectionRows);
  // A result can be sufficiently trustworthy for customer-facing settlement
  // and still be intentionally barred from model promotion (for example an
  // organizer fallback used while the primary Sporttery result lane is
  // blocked). Keep that cohort visible in the post-match review, but never
  // let it enter the recommendation-selection denominator.
  const promotionResultRows = chronologicalRows.filter((row) => (
    row?.resultObservationPromotionEligible === true
  ));
  const hasImmutableRows = promotionResultRows.some((row) => (
    row.decisionSnapshotVersion === DECISION_SNAPSHOT_VERSION
  ));
  const sortedRows = promotionResultRows
    .filter((row) => (!hasImmutableRows || row.decisionSnapshotVersion === DECISION_SNAPSHOT_VERSION)
      && (hasImmutableRows || row.oddsPoolCode === "HAD")
      && finiteMetric(row.modelPickProbability) !== null
      && finiteMetric(row.marketPickProbability) !== null);
  const invalidKickoffRows = sortedRows.filter((row) => (
    recommendationSelectionKickoffEpoch(row) === null
  )).length;
  const chronologyValid = invalidKickoffRows === 0;
  const spOnlyRows = sortedRows.filter((row) => Number(row.odds) <= 2.05);
  const candidateRows = sortedRows.filter(multiFactorShadowEligible);
  const before = summarizeRecommendationSelectionRows(sortedRows);
  const spOnlyBaseline = summarizeRecommendationSelectionRows(spOnlyRows);
  const after = summarizeRecommendationSelectionRows(candidateRows);
  const rollingWindows = [];
  const windowCount = Math.min(6, sortedRows.length);
  for (let index = 0; index < windowCount; index += 1) {
    const start = Math.floor(index * sortedRows.length / windowCount);
    const end = Math.floor((index + 1) * sortedRows.length / windowCount);
    const windowRows = sortedRows.slice(start, end);
    const windowCandidateRows = windowRows.filter(multiFactorShadowEligible);
    const windowSpOnlyRows = windowRows.filter((row) => Number(row.odds) <= 2.05);
    const windowBefore = summarizeRecommendationSelectionRows(windowRows);
    const windowAfter = summarizeRecommendationSelectionRows(windowCandidateRows);
    const windowSpOnly = summarizeRecommendationSelectionRows(windowSpOnlyRows);
    rollingWindows.push({
      index: index + 1,
      startKickoffTime: windowRows[0]?.kickoffTime || null,
      endKickoffTime: windowRows.at(-1)?.kickoffTime || null,
      before: windowBefore,
      spOnly: windowSpOnly,
      after: windowAfter,
      coverage: windowRows.length ? round(windowCandidateRows.length / windowRows.length) : 0,
      hitRateDeltaVsSpOnly: Number.isFinite(windowSpOnly.hitRate) && Number.isFinite(windowAfter.hitRate)
        ? round(windowAfter.hitRate - windowSpOnly.hitRate)
        : null
    });
  }
  const coverage = sortedRows.length ? round(candidateRows.length / sortedRows.length) : 0;
  const hitRateDelta = Number.isFinite(spOnlyBaseline.hitRate) && Number.isFinite(after.hitRate)
    ? round(after.hitRate - spOnlyBaseline.hitRate)
    : null;
  const afterModelScoring = after?.selectedEventScoring?.model || null;
  const baselineModelScoring = spOnlyBaseline?.selectedEventScoring?.model || null;
  const afterModelBrier = finiteMetric(afterModelScoring?.brier);
  const baselineModelBrier = finiteMetric(baselineModelScoring?.brier);
  const afterModelLogLoss = finiteMetric(afterModelScoring?.logLoss);
  const baselineModelLogLoss = finiteMetric(baselineModelScoring?.logLoss);
  const modelBrierNonWorse = Number(afterModelScoring?.rows || 0) > 0
    && Number(baselineModelScoring?.rows || 0) > 0
    && afterModelBrier !== null
    && baselineModelBrier !== null
    && afterModelBrier <= baselineModelBrier;
  const modelLogLossNonWorse = Number(afterModelScoring?.rows || 0) > 0
    && Number(baselineModelScoring?.rows || 0) > 0
    && afterModelLogLoss !== null
    && baselineModelLogLoss !== null
    && afterModelLogLoss <= baselineModelLogLoss;
  const validationRows = candidateDecisionRows.filter((row) => (
    isPromotionDecisionSnapshotVersion(row.decisionSnapshotVersion)
    && row.promotionCohortEligible === true
  ));
  const legacyAuditOnlyRows = candidateDecisionRows.filter((row) => (
    row.decisionSnapshotVersion === LEGACY_DECISION_SNAPSHOT_VERSION
  ));
  const minimumRowsPerMarket = 100;
  const perMarket = Object.fromEntries(["HAD", "HHAD"].map((market) => {
    const sourceRows = validationRows.filter((row) => row.oddsPoolCode === market);
    const sameSnapshotRows = sourceRows.filter((row) => (
      String(row.oddsSource || "").startsWith("candidate-decision-snapshot:")
      && finiteMetric(row.modelPickProbability) !== null
      && finiteMetric(row.marketPickProbability) !== null
    ));
    const exactReplayRows = sameSnapshotRows.filter((row) => row.productionPolicyReplay === true);
    const validated = sameSnapshotRows.length >= minimumRowsPerMarket
      && exactReplayRows.length === sameSnapshotRows.length;
    return [market, {
      sourceRows: sourceRows.length,
      sameSnapshotModelMarketRows: sameSnapshotRows.length,
      exactReplayRows: exactReplayRows.length,
      minimumRows: minimumRowsPerMarket,
      status: validated ? "validated" : sameSnapshotRows.length ? "collecting" : "unvalidated",
      productionPolicyReplay: validated
    }];
  }));
  const validatedMarkets = Object.entries(perMarket)
    .filter(([, value]) => value.productionPolicyReplay)
    .map(([market]) => market);
  const samePolicyImplementation = validationRows.length > 0
    && validationRows.every((row) => row.productionPolicyReplay === true);
  const productionBlockers = [];
  if (!samePolicyImplementation) productionBlockers.push("production-multi-factor-policy-not-replayed");
  for (const market of ["HAD", "HHAD"]) {
    if (!validatedMarkets.includes(market)) productionBlockers.push(`${market}-production-policy-unvalidated`);
  }
  const productionValidation = {
    version: "production-multi-factor-validation-v3",
    productionPolicyVersion: MULTI_FACTOR_POLICY_VERSION,
    backtestPolicyVersion: "multi-factor-selection-shadow-v3",
    decisionSnapshotVersion: DECISION_SNAPSHOT_VERSION,
    cohortPolicy: "candidate-decision-snapshot-v2-only",
    cohortRows: validationRows.length,
    excludedLegacyV1AuditRows: legacyAuditOnlyRows.length,
    samePolicyImplementation,
    eligible: samePolicyImplementation && validatedMarkets.length === 2,
    validatedMarkets,
    requiredMarkets: ["HAD", "HHAD"],
    perMarket,
    blockers: productionBlockers,
    policy: "Only immutable v2 candidates with exact canonical input/output/policy replay enter promotion validation; v1 remains audit-only and a probability/odds proxy cannot promote the production policy."
  };
  const thresholds = {
    minBaselineRows: 500,
    minCandidateRows: 300,
    minCoverage: 0.3,
    maxCoverage: 0.8,
    minHitRateImprovementVsSpOnly: 0.02,
    minStableWindows: 5,
    requiredWindows: 6,
    minRowsPerWindow: 40,
    requireModelBrierNonWorse: true,
    requireModelLogLossNonWorse: true,
    requireProductionPolicyReplay: true,
    requiredValidatedMarkets: ["HAD", "HHAD"]
  };
  const stableWindows = rollingWindows.filter((window) => (
    Number(window.after?.settled || 0) >= thresholds.minRowsPerWindow
    && finiteMetric(window.hitRateDeltaVsSpOnly) !== null
    && finiteMetric(window.hitRateDeltaVsSpOnly) >= 0
  )).length;
  const eligible = before.settled >= thresholds.minBaselineRows
    && after.settled >= thresholds.minCandidateRows
    && coverage >= thresholds.minCoverage
    && coverage <= thresholds.maxCoverage
    && finiteMetric(hitRateDelta) !== null
    && finiteMetric(hitRateDelta) >= thresholds.minHitRateImprovementVsSpOnly
    && rollingWindows.length >= thresholds.requiredWindows
    && stableWindows >= thresholds.minStableWindows
    && modelBrierNonWorse
    && modelLogLossNonWorse
    && chronologyValid
    && productionValidation.eligible;
  const gateBlockers = [...productionValidation.blockers];
  if (!chronologyValid) gateBlockers.push(`invalid-kickoff-time:${invalidKickoffRows}`);
  return {
    version: "multi-factor-selection-shadow-v3",
    policy: "SP is a continuous market/value feature; no max-SP reroute",
    split: "six non-overlapping chronological windows; no random split",
    hardMaxSp: null,
    before,
    spOnlyBaseline,
    after,
    coverage,
    sourceRows: chronologicalRows.length,
    promotionResultRows: promotionResultRows.length,
    excludedResultObservationRows: chronologicalRows.length - promotionResultRows.length,
    excludedRows: before.settled - after.settled,
    highSpCandidates: candidateRows.filter((row) => Number(row.odds) > 2.05).length,
    lowSpRejected: spOnlyRows.filter((row) => !multiFactorShadowEligible(row)).length,
    hitRateDeltaVsSpOnly: hitRateDelta,
    rollingWindows,
    chronology: {
      version: "recommendation-selection-epoch-order-v1",
      valid: chronologyValid,
      invalidKickoffRows,
      invalidTimePolicy: "retain-fail-closed-after-valid-rows",
      tieBreakFields: ["sourceMatchId", "matchId", "id", "oddsPoolCode", "marketType", "tipCode", "forecastTime", "kickoffTime"],
    },
    productionValidation,
    gate: {
      eligible,
      action: eligible ? "activate-multi-factor-evidence" : "shadow-only",
      thresholds,
      stableWindows,
      modelBrierNonWorse,
      modelLogLossNonWorse,
      productionPolicyValidated: productionValidation.eligible,
      validatedMarkets: productionValidation.validatedMarkets,
      blockers: gateBlockers,
      riskPolicy: "insufficient as-of samples remain shadow; a failed candidate becomes WATCH and never changes direction merely for lower SP"
    }
  };
};

const groupSummary = (rows, keyFn) => {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    Array.from(groups.entries())
      .map(([key, group]) => [key, summarizePredictionRows(group)])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  );
};

const summarizeProbabilityRows = (rows) => {
  if (!rows.length) {
    return {
      rows: 0,
      brier: null,
      logLoss: null,
      accuracy: null,
      calibrationByConfidence: {}
    };
  }

  let brierSum = 0;
  let logLossSum = 0;
  let correct = 0;
  const buckets = new Map();
  for (const row of rows) {
    const actual = row.actual;
    const probabilities = row.probabilities;
    const predicted = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
    if (predicted?.[0] === actual) correct += 1;
    for (const code of ["1", "X", "2"]) {
      const expected = code === actual ? 1 : 0;
      brierSum += (probabilities[code] - expected) ** 2;
    }
    logLossSum += -Math.log(clampProbability(probabilities[actual]));
    const confidence = predicted?.[1] || 0;
    const bucket = confidence < 0.4 ? "p_lt_40" : confidence < 0.5 ? "p_40_50" : confidence < 0.6 ? "p_50_60" : "p_ge_60";
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push({ confidence, correct: predicted?.[0] === actual });
  }

  const calibrationByConfidence = Object.fromEntries(
    Array.from(buckets.entries()).map(([bucket, group]) => {
      const avgConfidence = group.reduce((sum, row) => sum + row.confidence, 0) / group.length;
      const hitRate = group.filter((row) => row.correct).length / group.length;
      return [bucket, {
        rows: group.length,
        avgConfidence: round(avgConfidence),
        hitRate: round(hitRate),
        calibrationError: round(Math.abs(avgConfidence - hitRate))
      }];
    })
  );

  return {
    rows: rows.length,
    brier: round(brierSum / rows.length),
    logLoss: round(logLossSum / rows.length),
    accuracy: round(correct / rows.length),
    calibrationByConfidence
  };
};

const compareProbabilityMetrics = (modelMetrics, marketMetrics) => {
  if (!modelMetrics?.rows || !marketMetrics?.rows) {
    return {
      rows: 0,
      brierImprovement: null,
      logLossImprovement: null,
      accuracyDelta: null
    };
  }
  return {
    rows: Math.min(modelMetrics.rows, marketMetrics.rows),
    brierImprovement: round(marketMetrics.brier - modelMetrics.brier),
    logLossImprovement: round(marketMetrics.logLoss - modelMetrics.logLoss),
    accuracyDelta: round(modelMetrics.accuracy - marketMetrics.accuracy),
    interpretation: "positive improvement means the model beats the market baseline"
  };
};

const FORECAST_HORIZON_BUCKETS = [
  { id: "lt_10m", minMinutes: 0, maxMinutes: 10 },
  { id: "m10_60", minMinutes: 10, maxMinutes: 60 },
  { id: "h1_6", minMinutes: 60, maxMinutes: 6 * 60 },
  { id: "h6_24", minMinutes: 6 * 60, maxMinutes: 24 * 60 },
  { id: "gt_24h", minMinutes: 24 * 60, maxMinutes: Number.POSITIVE_INFINITY }
];

const forecastLeadMinutesFor = (row) => {
  const kickoffMs = Date.parse(row?.kickoffTime || "");
  const forecastMs = Date.parse(row?.forecastTime || "");
  if (!Number.isFinite(kickoffMs) || !Number.isFinite(forecastMs)) return null;
  return (kickoffMs - forecastMs) / (60 * 1000);
};

const forecastHorizonIdFor = (row) => {
  const minutes = forecastLeadMinutesFor(row);
  if (!Number.isFinite(minutes) || minutes < 0) return "unknown";
  return FORECAST_HORIZON_BUCKETS.find((bucket) => (
    minutes >= bucket.minMinutes && minutes < bucket.maxMinutes
  ))?.id || "unknown";
};

const quantile = (sortedValues, ratio) => {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * ratio));
  return round(sortedValues[index], 2);
};

const summarizeForecastHorizons = (rows) => {
  const groups = new Map([...FORECAST_HORIZON_BUCKETS.map((bucket) => [bucket.id, []]), ["unknown", []]]);
  for (const row of rows) groups.get(forecastHorizonIdFor(row)).push(row);
  const buckets = Object.fromEntries(Array.from(groups.entries()).map(([id, group]) => {
    const matched = group.filter((row) => row.marketProbabilities && row.probabilities);
    const model = summarizeProbabilityRows(matched);
    const market = summarizeProbabilityRows(matched.map((row) => ({
      ...row,
      probabilities: row.marketProbabilities
    })));
    const leadMinutes = group
      .map(forecastLeadMinutesFor)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return [id, {
      rows: group.length,
      coverage: rows.length ? round(group.length / rows.length) : 0,
      matchedMarketRows: matched.length,
      leadMinutes: {
        min: quantile(leadMinutes, 0),
        median: quantile(leadMinutes, 0.5),
        p90: quantile(leadMinutes, 0.9),
        max: quantile(leadMinutes, 1)
      },
      model,
      market,
      comparison: compareProbabilityMetrics(model, market)
    }];
  }));
  const allLeadMinutes = rows
    .map(forecastLeadMinutesFor)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    version: "forecast-horizon-audit-v1",
    policy: "Report probability metrics separately by forecast lead time; never treat mixed horizons as equivalent evidence.",
    bucketDefinitions: Object.fromEntries(FORECAST_HORIZON_BUCKETS.map((bucket) => [bucket.id, {
      minMinutes: bucket.minMinutes,
      maxMinutes: Number.isFinite(bucket.maxMinutes) ? bucket.maxMinutes : null
    }])),
    rows: rows.length,
    leadMinutes: {
      min: quantile(allLeadMinutes, 0),
      p10: quantile(allLeadMinutes, 0.1),
      median: quantile(allLeadMinutes, 0.5),
      p90: quantile(allLeadMinutes, 0.9),
      max: quantile(allLeadMinutes, 1)
    },
    buckets
  };
};

const normalizeProbabilityTriplet = (probabilities) => {
  const home = finiteMetric(probabilities?.["1"]);
  const draw = finiteMetric(probabilities?.X);
  const away = finiteMetric(probabilities?.["2"]);
  if (![home, draw, away].every((value) => value !== null && value >= 0 && value <= 1)) return null;
  const total = home + draw + away;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    "1": home / total,
    X: draw / total,
    "2": away / total
  };
};

const blendProbabilityTriplets = (primary, secondary, primaryWeight) => {
  const a = normalizeProbabilityTriplet(primary);
  const b = normalizeProbabilityTriplet(secondary);
  const weight = Number(primaryWeight);
  if (!a || !b || !Number.isFinite(weight)) return null;
  return normalizeProbabilityTriplet({
    "1": a["1"] * weight + b["1"] * (1 - weight),
    X: a.X * weight + b.X * (1 - weight),
    "2": a["2"] * weight + b["2"] * (1 - weight)
  });
};

const temperatureProbabilityTriplet = (probabilities, temperature) => {
  const source = normalizeProbabilityTriplet(probabilities);
  const parsedTemperature = Number(temperature);
  if (!source || !Number.isFinite(parsedTemperature) || parsedTemperature <= 0) return null;
  // Temperature greater than one softens a distribution and temperature below
  // one sharpens it. Keep this identical to the frozen prospective evaluator;
  // otherwise a candidate can be selected under one transform and audited
  // under its mathematical inverse.
  const inverseTemperature = 1 / parsedTemperature;
  return normalizeProbabilityTriplet({
    "1": source["1"] ** inverseTemperature,
    X: source.X ** inverseTemperature,
    "2": source["2"] ** inverseTemperature
  });
};

const logPoolProbabilityTriplets = (
  marketProbabilities,
  modelProbabilities,
  {
    marketWeight,
    modelWeight,
    temperature = 1,
    outcomeBiasLogOffsets = null,
  } = {},
) => {
  const market = normalizeProbabilityTriplet(marketProbabilities);
  const model = normalizeProbabilityTriplet(modelProbabilities);
  const parsedMarketWeight = Number(marketWeight);
  const parsedModelWeight = Number(modelWeight);
  const parsedTemperature = Number(temperature);
  if (
    !market
    || !model
    || !Number.isFinite(parsedMarketWeight)
    || !Number.isFinite(parsedModelWeight)
    || !Number.isFinite(parsedTemperature)
    || parsedTemperature <= 0
  ) return null;
  const inverseTemperature = 1 / parsedTemperature;
  return normalizeProbabilityTriplet(Object.fromEntries(
    ["1", "X", "2"].map((code) => {
      const logProbability = parsedMarketWeight * Math.log(Math.max(1e-12, market[code]))
        + parsedModelWeight * Math.log(Math.max(1e-12, model[code]));
      const outcomeBias = Number(outcomeBiasLogOffsets?.[code]) || 0;
      return [code, Math.exp(logProbability * inverseTemperature + outcomeBias)];
    }),
  ));
};

const clampSignal = (value, min = -1.25, max = 1.25) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
};

const oddsTrendSignals = (trend) => {
  if (!trend || typeof trend !== "object") return null;
  return {
    "1": clampSignal(-Number(trend.odds1Change || 0)),
    X: clampSignal(-Number(trend.oddsXChange || 0)),
    "2": clampSignal(-Number(trend.odds2Change || 0))
  };
};

const oddsTrendTiltProbabilityTriplet = (probabilities, trend, strength) => {
  const source = normalizeProbabilityTriplet(probabilities);
  const signals = oddsTrendSignals(trend);
  const weight = Number(strength);
  if (!source || !signals || !Number.isFinite(weight)) return null;
  return normalizeProbabilityTriplet({
    "1": source["1"] * Math.exp(weight * signals["1"]),
    X: source.X * Math.exp(weight * signals.X),
    "2": source["2"] * Math.exp(weight * signals["2"])
  });
};

const teamKeyFor = (...values) => {
  const value = values.find((item) => String(item || "").trim());
  return String(value || "").normalize("NFKC").trim().toLowerCase();
};

const clampNumber = (value, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
};

const scorePairFor = (match) => {
  return strictScorePairFor(match);
};

const emptyTeamStats = () => ({
  matches: 0,
  homeMatches: 0,
  awayMatches: 0,
  goalsFor: 0,
  goalsAgainst: 0,
  homeFor: 0,
  homeAgainst: 0,
  awayFor: 0,
  awayAgainst: 0
});

const createHistoricalModelState = () => ({
  matches: 0,
  homeGoals: 0,
  awayGoals: 0,
  teams: new Map(),
  ratings: new Map(),
  latestResultObservedMs: null,
  explicitResultTimeMatches: 0,
  fallbackResultTimeMatches: 0
});

const ensureHistoricalTeam = (state, key) => {
  if (!state.teams.has(key)) state.teams.set(key, emptyTeamStats());
  return state.teams.get(key);
};

const historicalRatingFor = (state, key) => {
  const rating = Number(state.ratings.get(key));
  return Number.isFinite(rating) ? rating : 1500;
};

const eloWinExpectation = (homeRating, awayRating, homeAdvantage = 65) => {
  return 1 / (1 + (10 ** ((awayRating - homeRating - homeAdvantage) / 400)));
};

const eloProbabilityTriplet = (homeRating, awayRating, homeAdvantage = 65) => {
  const expectedHome = eloWinExpectation(homeRating, awayRating, homeAdvantage);
  const diff = Math.abs((homeRating + homeAdvantage) - awayRating) / 400;
  const draw = clampNumber(0.28 - Math.min(0.12, diff * 0.08), 0.16, 0.3);
  return normalizeProbabilityTriplet({
    "1": expectedHome * (1 - draw),
    X: draw,
    "2": (1 - expectedHome) * (1 - draw)
  });
};

const poissonPmf = (lambda, maxGoals) => {
  const safeLambda = clampNumber(lambda, 0.05, 6);
  const values = [];
  let probability = Math.exp(-safeLambda);
  values.push(probability);
  for (let goals = 1; goals <= maxGoals; goals += 1) {
    probability = (probability * safeLambda) / goals;
    values.push(probability);
  }
  return values;
};

const poissonOutcomeProbabilityTriplet = (homeLambda, awayLambda, maxGoals = 8) => {
  const home = poissonPmf(homeLambda, maxGoals);
  const away = poissonPmf(awayLambda, maxGoals);
  const outcomes = { "1": 0, X: 0, "2": 0 };
  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
      const probability = home[homeGoals] * away[awayGoals];
      if (homeGoals > awayGoals) outcomes["1"] += probability;
      else if (homeGoals < awayGoals) outcomes["2"] += probability;
      else outcomes.X += probability;
    }
  }
  return normalizeProbabilityTriplet(outcomes);
};

const smoothedRate = (sum, count, prior, pseudoCount = 6) => {
  const safePrior = Number.isFinite(Number(prior)) && Number(prior) > 0 ? Number(prior) : 1.25;
  return (Number(sum || 0) + safePrior * pseudoCount) / (Number(count || 0) + pseudoCount);
};

const HISTORICAL_RESULT_CUTOFF_POLICY = "Only attributed, non-fallback results with trusted resultObservedAt no later than forecastTime are used; missing observation clocks are excluded.";

const predictHistoricalModels = (state, row) => {
  const homeKey = teamKeyFor(row?.homeTeamName, row?.homeTeamNameEn, row?.homeTeam);
  const awayKey = teamKeyFor(row?.awayTeamName, row?.awayTeamNameEn, row?.awayTeam);
  if (!homeKey || !awayKey || homeKey === awayKey || state.matches < 20) return null;

  const homeStats = state.teams.get(homeKey) || emptyTeamStats();
  const awayStats = state.teams.get(awayKey) || emptyTeamStats();
  const globalHomeGoals = state.matches ? state.homeGoals / state.matches : 1.35;
  const globalAwayGoals = state.matches ? state.awayGoals / state.matches : 1.1;
  const homeAttack = smoothedRate(homeStats.homeFor, homeStats.homeMatches, globalHomeGoals) / globalHomeGoals;
  const awayDefense = smoothedRate(awayStats.awayAgainst, awayStats.awayMatches, globalHomeGoals) / globalHomeGoals;
  const awayAttack = smoothedRate(awayStats.awayFor, awayStats.awayMatches, globalAwayGoals) / globalAwayGoals;
  const homeDefense = smoothedRate(homeStats.homeAgainst, homeStats.homeMatches, globalAwayGoals) / globalAwayGoals;
  const homeLambda = clampNumber(globalHomeGoals * homeAttack * awayDefense, 0.2, 3.8);
  const awayLambda = clampNumber(globalAwayGoals * awayAttack * homeDefense, 0.15, 3.4);
  const homeRating = historicalRatingFor(state, homeKey);
  const awayRating = historicalRatingFor(state, awayKey);
  const eloProbabilities = eloProbabilityTriplet(homeRating, awayRating);
  const poissonProbabilities = poissonOutcomeProbabilityTriplet(homeLambda, awayLambda);
  const historicalBlendProbabilities = blendProbabilityTriplets(eloProbabilities, poissonProbabilities, 0.5);

  return {
    eloProbabilities,
    poissonProbabilities,
    historicalBlendProbabilities,
    featureSnapshot: {
      version: "historical-elo-poisson-v2",
      trainingMatches: state.matches,
      cutoffPolicy: HISTORICAL_RESULT_CUTOFF_POLICY,
      latestResultObservedAt: Number.isFinite(state.latestResultObservedMs)
        ? new Date(state.latestResultObservedMs).toISOString()
        : null,
      resultTimeSources: {
        explicit: state.explicitResultTimeMatches,
        kickoffPlusThreeHours: state.fallbackResultTimeMatches
      },
      home: {
        key: homeKey,
        matches: homeStats.matches,
        homeMatches: homeStats.homeMatches,
        rating: round(homeRating, 1)
      },
      away: {
        key: awayKey,
        matches: awayStats.matches,
        awayMatches: awayStats.awayMatches,
        rating: round(awayRating, 1)
      },
      global: {
        homeGoalsPerMatch: round(globalHomeGoals),
        awayGoalsPerMatch: round(globalAwayGoals)
      },
      poisson: {
        homeLambda: round(homeLambda),
        awayLambda: round(awayLambda)
      }
    }
  };
};

const applyMatchToHistoricalState = (state, match) => {
  const score = scorePairFor(match);
  const homeKey = teamKeyFor(match?.homeTeamName, match?.homeTeamNameEn, match?.homeTeam);
  const awayKey = teamKeyFor(match?.awayTeamName, match?.awayTeamNameEn, match?.awayTeam);
  if (!score || !homeKey || !awayKey || homeKey === awayKey) return;

  const homeStats = ensureHistoricalTeam(state, homeKey);
  const awayStats = ensureHistoricalTeam(state, awayKey);
  const homeRating = historicalRatingFor(state, homeKey);
  const awayRating = historicalRatingFor(state, awayKey);
  const expectedHome = eloWinExpectation(homeRating, awayRating);
  const actualHome = score.home > score.away ? 1 : score.home < score.away ? 0 : 0.5;
  const margin = Math.max(1, Math.abs(score.home - score.away));
  const kFactor = 20 * (margin > 1 ? Math.log(margin + 1) : 1);
  const delta = kFactor * (actualHome - expectedHome);
  state.ratings.set(homeKey, homeRating + delta);
  state.ratings.set(awayKey, awayRating - delta);

  state.matches += 1;
  state.homeGoals += score.home;
  state.awayGoals += score.away;

  homeStats.matches += 1;
  homeStats.homeMatches += 1;
  homeStats.goalsFor += score.home;
  homeStats.goalsAgainst += score.away;
  homeStats.homeFor += score.home;
  homeStats.homeAgainst += score.away;

  awayStats.matches += 1;
  awayStats.awayMatches += 1;
  awayStats.goalsFor += score.away;
  awayStats.goalsAgainst += score.home;
  awayStats.awayFor += score.away;
  awayStats.awayAgainst += score.home;
};

const resultObservedEntryFor = (match) => {
  const observation = strictResultObservationForMatch(match);
  return Number.isFinite(observation?.observedMs) && observation?.fallback !== true
    ? observation
    : null;
};

const attachHistoricalModelFeatures = (rows, allMatches) => {
  const trainingMatches = allMatches
    .filter((match) => match?.status === "FINISHED" && scorePairFor(match))
    .map((match) => ({ match, resultObserved: resultObservedEntryFor(match) }))
    .filter((entry) => Number.isFinite(entry.resultObserved?.observedMs))
    .sort((a, b) => a.resultObserved.observedMs - b.resultObserved.observedMs);

  const predictionAt = (row, forecastMs) => {
    if (!Number.isFinite(forecastMs)) return null;
    const state = createHistoricalModelState();
    for (const entry of trainingMatches) {
      if (entry.resultObserved.observedMs > forecastMs) break;
      if (entry.match?.id && row?.matchId && entry.match.id === row.matchId) continue;
      if (entry.match?.sourceMatchId && row?.sourceMatchId
          && String(entry.match.sourceMatchId) === String(row.sourceMatchId)) continue;
      applyMatchToHistoricalState(state, entry.match);
      state.latestResultObservedMs = Math.max(
        Number(state.latestResultObservedMs || 0),
        entry.resultObserved.observedMs
      );
      if (entry.resultObserved.fallback) state.fallbackResultTimeMatches += 1;
      else state.explicitResultTimeMatches += 1;
    }
    return predictHistoricalModels(state, row);
  };

  for (const row of rows) {
    const forecastMs = Date.parse(row?.forecastTime || row?.kickoffTime || "");
    const prediction = predictionAt(row, forecastMs);
    if (prediction) {
      row.eloProbabilities = prediction.eloProbabilities;
      row.poissonProbabilities = prediction.poissonProbabilities;
      row.historicalBlendProbabilities = prediction.historicalBlendProbabilities;
      row.historicalFeatureSnapshot = prediction.featureSnapshot;
    }

    // Promotion has its own immutable boundary. Never reuse a historical
    // snapshot constructed at a mutable outer/legacy forecast timestamp.
    const strictForecastMs = Date.parse(row?.strictDecisionAt || "");
    const strictPrediction = strictForecastMs === forecastMs
      ? prediction
      : predictionAt(row, strictForecastMs);
    if (strictPrediction) {
      row.strictHistoricalBlendProbabilities = strictPrediction.historicalBlendProbabilities;
      row.strictHistoricalFeatureSnapshot = strictPrediction.featureSnapshot;
    }
  }
};

const ROLLING_REQUIRED_WINDOWS = 6;
const ROLLING_MIN_ROWS_PER_WINDOW = 40;

const shadowCandidateStabilityReady = (comparison, rolling, robustness = null) => {
  const passRate = finiteMetric(rolling?.passRate);
  const windows = finiteMetric(rolling?.windows);
  return hasNonNegativeImprovementPair(comparison)
    && passRate !== null
    && passRate >= 0.8
    && windows !== null
    && windows >= ROLLING_REQUIRED_WINDOWS
    && robustness?.candidateReadyForProspectiveTest === true;
};

const summarizeRollingPassRate = (windows, minLogLossImprovement = 0, minBrierImprovement = 0) => {
  const checked = (Array.isArray(windows) ? windows : []).filter((window) => (
    finiteImprovementPair(window?.improvement) !== null
  ));
  const passed = checked.filter((window) => {
    const pair = finiteImprovementPair(window.improvement);
    return pair.logLossImprovement >= minLogLossImprovement
      && pair.brierImprovement >= minBrierImprovement;
  });
  return {
    windows: checked.length,
    passed: passed.length,
    passRate: checked.length ? round(passed.length / checked.length) : null,
    requiredWindows: ROLLING_REQUIRED_WINDOWS,
    minRowsPerWindow: ROLLING_MIN_ROWS_PER_WINDOW,
    sufficientIndependentWindows: checked.length >= ROLLING_REQUIRED_WINDOWS,
    split: "non-overlapping chronological windows",
    criteria: {
      minLogLossImprovement,
      minBrierImprovement
    },
    recentWindows: checked.slice(-4).map((window) => ({
      startKickoffTime: window.startKickoffTime,
      endKickoffTime: window.endKickoffTime,
      rows: window.rows,
      logLossImprovement: round(window.improvement.logLossImprovement),
      brierImprovement: round(window.improvement.brierImprovement),
      accuracyDelta: round(window.improvement.accuracyDelta)
    }))
  };
};

const shadowCandidateFromRows = (candidate, rows) => {
  const metrics = summarizeProbabilityRows(rows);
  const sameMatchMarketMetrics = summarizeProbabilityRows(rows
    .filter((row) => row.marketProbabilities)
    .map((row) => ({ ...row, probabilities: row.marketProbabilities })));
  const rollingWindows = summarizeRollingWindows(rows);
  const result = {
    ...candidate,
    metrics,
    sameMatchMarketMetrics,
    comparison: {
      ...compareProbabilityMetrics(metrics, sameMatchMarketMetrics),
      pairedByMatch: metrics.rows === sameMatchMarketMetrics.rows
    },
    rolling: summarizeRollingPassRate(rollingWindows)
  };
  // Walk-forward selection needs row-level predictions internally, but these
  // rows must never leak into the serialized public/admin candidate artifact.
  Object.defineProperty(result, "_rows", {
    value: rows,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
};

const candidateUsesModelSignal = (candidate) => {
  const weights = candidate?.weights || {};
  const features = Array.isArray(candidate?.featureSet) ? candidate.featureSet : [];
  const modelWeight = Number(weights.model);
  return (Number.isFinite(modelWeight) && modelWeight !== 0)
    || Number(weights.historical || 0) > 0
    || Number(weights.elo || 0) > 0
    || Number(weights.poisson || 0) > 0
    || features.some((feature) => String(feature).includes("historical") || String(feature).includes("elo") || String(feature).includes("poisson"));
};

const evaluateShadowCandidates = (rows) => {
  const matchedRows = rows.filter((row) => row.marketProbabilities && row.probabilities);
  const baseMarketRows = matchedRows.map((row) => ({ ...row, probabilities: row.marketProbabilities }));
  const baseModelRows = matchedRows.map((row) => ({ ...row, probabilities: row.probabilities }));
  const candidates = [
    shadowCandidateFromRows({
      id: "market-baseline",
      label: "Sporttery market baseline",
      role: "baseline",
      weights: { market: 1, model: 0 }
    }, baseMarketRows),
    shadowCandidateFromRows({
      id: "current-model",
      label: "Current pre-match probability model",
      role: "current-online-shadow",
      weights: { market: 0, model: 1 }
    }, baseModelRows)
  ];

  for (const temperature of [0.75, 0.9, 1.1, 1.25, 1.5]) {
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: temperatureProbabilityTriplet(row.marketProbabilities, temperature)
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: `market-temperature-${String(temperature).replace(".", "_")}`,
      label: `Market baseline temperature ${temperature}`,
      role: "shadow-feature-candidate",
      featureSet: ["sporttery-market", "temperature-calibration"],
      weights: { market: 1, model: 0, temperature }
    }, candidateRows));
  }

  for (const strength of [0.15, 0.3, 0.45, 0.65, 0.9]) {
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: oddsTrendTiltProbabilityTriplet(row.marketProbabilities, row.oddsTrend, strength)
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: `odds-trend-tilt-${String(strength).replace(".", "_")}`,
      label: `Sporttery odds-trend tilt ${strength}`,
      role: "shadow-feature-candidate",
      featureSet: ["sporttery-market", "sporttery-odds-trend"],
      weights: { market: 1, model: 0, oddsTrendStrength: strength }
    }, candidateRows));
  }

  const historicalCandidates = [
    {
      id: "elo-rating-v1",
      label: "Historical Elo 1X2 rating",
      probabilityKey: "eloProbabilities",
      featureSet: ["historical-results", "elo-rating"],
      weights: { elo: 1 }
    },
    {
      id: "poisson-goals-v1",
      label: "Historical Poisson goal distribution",
      probabilityKey: "poissonProbabilities",
      featureSet: ["historical-results", "goal-rate-poisson"],
      weights: { poisson: 1 }
    },
    {
      id: "historical-elo-poisson-50",
      label: "Historical Elo/Poisson blend",
      probabilityKey: "historicalBlendProbabilities",
      featureSet: ["historical-results", "elo-rating", "goal-rate-poisson"],
      weights: { elo: 0.5, poisson: 0.5 }
    }
  ];

  for (const candidate of historicalCandidates) {
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: row[candidate.probabilityKey]
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: candidate.id,
      label: candidate.label,
      role: "shadow-model-candidate",
      featureSet: candidate.featureSet,
      weights: candidate.weights
    }, candidateRows));
  }

  for (const marketWeight of [0.75, 0.85, 0.92]) {
    const historicalWeight = round(1 - marketWeight, 2);
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: blendProbabilityTriplets(row.marketProbabilities, row.historicalBlendProbabilities, marketWeight)
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: `market-history-blend-${Math.round(marketWeight * 100)}`,
      label: `Market/historical blend ${Math.round(marketWeight * 100)}/${Math.round((1 - marketWeight) * 100)}`,
      role: "shadow-model-candidate",
      featureSet: ["sporttery-market", "historical-results", "elo-rating", "goal-rate-poisson"],
      weights: { market: round(marketWeight, 2), historical: historicalWeight }
    }, candidateRows));
  }

  for (const marketWeight of [0.65, 0.75, 0.85, 0.92]) {
    for (const temperature of [0.9, 1.1, 1.25]) {
      const historicalWeight = round(1 - marketWeight, 2);
      const candidateRows = matchedRows
        .map((row) => {
          const blended = blendProbabilityTriplets(row.marketProbabilities, row.historicalBlendProbabilities, marketWeight);
          return {
            ...row,
            probabilities: blended ? temperatureProbabilityTriplet(blended, temperature) : null
          };
        })
        .filter((row) => row.probabilities);
      candidates.push(shadowCandidateFromRows({
        id: `market-history-temperature-${Math.round(marketWeight * 100)}-${String(temperature).replace(".", "_")}`,
        label: `Market/historical blend ${Math.round(marketWeight * 100)}/${Math.round((1 - marketWeight) * 100)} temperature ${temperature}`,
        role: "shadow-model-candidate",
        featureSet: ["sporttery-market", "historical-results", "elo-rating", "goal-rate-poisson", "temperature-calibration"],
        weights: { market: round(marketWeight, 2), historical: historicalWeight, temperature }
      }, candidateRows));
    }
  }

  for (const modelWeight of [-0.05, -0.1, -0.2]) {
    const marketWeight = round(1 - modelWeight, 2);
    for (const temperature of [0.75, 0.9, 1, 1.1, 1.25]) {
      const candidateRows = matchedRows
        .map((row) => ({
          ...row,
          probabilities: logPoolProbabilityTriplets(
            row.marketProbabilities,
            row.probabilities,
            { marketWeight, modelWeight, temperature },
          ),
        }))
        .filter((row) => row.probabilities);
      candidates.push(shadowCandidateFromRows({
        id: `market-current-model-residual-minus-${Math.abs(Math.round(modelWeight * 100))}`
          + `-temperature-${String(temperature).replace(".", "_")}`,
        label: `Market/current-model anti-residual ${Math.round(marketWeight * 100)}`
          + `/${Math.round(modelWeight * 100)} temperature ${temperature}`,
        role: "shadow-model-candidate",
        featureSet: [
          "sporttery-market",
          "current-probability-model",
          "negative-model-residual",
          "temperature-calibration",
        ],
        weights: {
          market: marketWeight,
          model: modelWeight,
          temperature,
        },
      }, candidateRows));
    }
  }

  for (const marketWeight of [0.65, 0.75, 0.85, 0.92]) {
    for (const temperature of [0.9, 1.1, 1.25]) {
      const modelWeight = round(1 - marketWeight, 2);
      const candidateRows = matchedRows
        .map((row) => {
          const blended = blendProbabilityTriplets(row.marketProbabilities, row.probabilities, marketWeight);
          return {
            ...row,
            probabilities: blended ? temperatureProbabilityTriplet(blended, temperature) : null
          };
        })
        .filter((row) => row.probabilities);
      candidates.push(shadowCandidateFromRows({
        id: `market-current-model-temperature-${Math.round(marketWeight * 100)}-${String(temperature).replace(".", "_")}`,
        label: `Market/current-model blend ${Math.round(marketWeight * 100)}/${Math.round((1 - marketWeight) * 100)} temperature ${temperature}`,
        role: "shadow-candidate",
        featureSet: ["sporttery-market", "current-probability-model", "temperature-calibration"],
        weights: { market: round(marketWeight, 2), model: modelWeight, temperature }
      }, candidateRows));
    }
  }

  for (const marketWeight of [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9]) {
    const candidateRows = matchedRows
      .map((row) => ({
        ...row,
        probabilities: blendProbabilityTriplets(row.marketProbabilities, row.probabilities, marketWeight)
      }))
      .filter((row) => row.probabilities);
    candidates.push(shadowCandidateFromRows({
      id: `blend-market-${Math.round(marketWeight * 100)}`,
      label: `Market/model blend ${Math.round(marketWeight * 100)}/${Math.round((1 - marketWeight) * 100)}`,
      role: "shadow-candidate",
      weights: {
        market: round(marketWeight, 2),
        model: round(1 - marketWeight, 2)
      }
    }, candidateRows));
  }

  const ranked = candidates
    .slice()
    .sort((a, b) => {
      const aLogLoss = Number.isFinite(a.metrics?.logLoss) ? a.metrics.logLoss : Number.POSITIVE_INFINITY;
      const bLogLoss = Number.isFinite(b.metrics?.logLoss) ? b.metrics.logLoss : Number.POSITIVE_INFINITY;
      if (aLogLoss !== bLogLoss) return aLogLoss - bLogLoss;
      const aBrier = Number.isFinite(a.metrics?.brier) ? a.metrics.brier : Number.POSITIVE_INFINITY;
      const bBrier = Number.isFinite(b.metrics?.brier) ? b.metrics.brier : Number.POSITIVE_INFINITY;
      return aBrier - bBrier;
    });
  const balancedRanked = ranked.filter((candidate) => (
    candidate.id !== "market-baseline"
    && hasNonNegativeImprovementPair(candidate.comparison)
  ));
  const nominationRanking = rankShadowCandidatesForNomination(balancedRanked);
  const best = nominationRanking.ranked[0] || ranked[0] || null;
  const modelRanked = ranked.filter(candidateUsesModelSignal);
  const balancedModelRanked = balancedRanked.filter(candidateUsesModelSignal);
  const modelNominationRanking = rankShadowCandidatesForNomination(balancedModelRanked);
  const bestModel = modelNominationRanking.ranked[0] || modelRanked[0] || null;
  const robustness = buildShadowCandidateRobustness({
    candidates: ranked,
    bestCandidateId: best?.id || null,
  });
  return {
    version: "shadow-candidates-v6",
    generatedAt: new Date().toISOString(),
    sample: {
      rows: matchedRows.length,
      sourceRows: rows.length
    },
    baselineId: "market-baseline",
    bestCandidateId: best?.id || null,
    bestCandidate: best || null,
    bestModelCandidateId: bestModel?.id || null,
    bestModelCandidate: bestModel || null,
    summary: {
      candidateCount: ranked.length,
      balancedCandidateCount: balancedRanked.length,
      modelCandidateCount: modelRanked.length,
      balancedModelCandidateCount: balancedModelRanked.length,
      bestLogLossImprovement: finiteMetric(best?.comparison?.logLossImprovement) !== null
        ? round(best.comparison.logLossImprovement)
        : null,
      bestBrierImprovement: finiteMetric(best?.comparison?.brierImprovement) !== null
        ? round(best.comparison.brierImprovement)
        : null,
      bestRollingPassRate: finiteMetric(best?.rolling?.passRate) !== null
        ? round(best.rolling.passRate)
        : null,
      bestModelLogLossImprovement: finiteMetric(bestModel?.comparison?.logLossImprovement) !== null
        ? round(bestModel.comparison.logLossImprovement)
        : null,
      bestModelBrierImprovement: finiteMetric(bestModel?.comparison?.brierImprovement) !== null
        ? round(bestModel.comparison.brierImprovement)
        : null,
      bestModelRollingPassRate: finiteMetric(bestModel?.rolling?.passRate) !== null
        ? round(bestModel.rolling.passRate)
        : null
    },
    selectionPolicy: balancedRanked.length
      ? nominationRanking.policy
      : "No non-baseline candidate improved both Log Loss and Brier; ranking falls back to lowest aggregate Log Loss.",
    selectionAudit: {
      version: nominationRanking.version,
      policyCommitment: nominationSelectionPolicyCommitment(),
      stabilityApplied: nominationRanking.stabilityApplied,
      maximumComparableRows: nominationRanking.maximumComparableRows,
      maximumComparableWindows: nominationRanking.maximumComparableWindows,
      selectedWinningWindows: Number(best?.rolling?.passed || 0),
      selectedWindowPassRate: finiteMetric(best?.rolling?.passRate),
      selectedCandidateId: best?.id || null,
    },
    robustness,
    candidates: ranked,
    policy: {
      onlineEffect: "shadow-only",
      promotionRule: "A shadow candidate must beat the market baseline on log loss and Brier score over enough time-ordered samples, pass family-wise counterevidence tests, and then survive a new untouched prospective ledger before it can affect recommendations."
    }
  };
};

const riskTierRank = { stable: 0, watch: 1, degraded: 2 };

const worseRiskTier = (current, next) => (
  riskTierRank[next] > riskTierRank[current] ? next : current
);

const formatRiskTierLabel = (tier) => ({
  stable: { zh: "稳定", en: "Stable" },
  watch: { zh: "观察", en: "Watch" },
  degraded: { zh: "降级", en: "Degraded" }
}[tier] || { zh: "观察", en: "Watch" });

const confidenceBucketRiskTier = (bucket) => {
  const rows = Number(bucket?.rows || 0);
  const error = Number(bucket?.calibrationError);
  if (rows < 10 || (Number.isFinite(error) && error > 0.3)) return "degraded";
  if (rows < 30 || (Number.isFinite(error) && error > 0.1)) return "watch";
  return "stable";
};

const summarizeConfidenceBucketRisks = (calibrationByConfidence) => {
  const buckets = Object.entries(calibrationByConfidence || {})
    .map(([id, bucket]) => {
      const tier = confidenceBucketRiskTier(bucket);
      const reasons = [];
      if (Number(bucket?.rows || 0) < 30) reasons.push("small-bucket-sample");
      if (Number(bucket?.calibrationError) > 0.1) reasons.push("calibration-gap");
      return {
        id,
        tier,
        label: formatRiskTierLabel(tier),
        rows: Number(bucket?.rows || 0),
        avgConfidence: bucket?.avgConfidence ?? null,
        hitRate: bucket?.hitRate ?? null,
        calibrationError: bucket?.calibrationError ?? null,
        reasons
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const rows = buckets.reduce((sum, bucket) => sum + Number(bucket.rows || 0), 0);
  const weightedCalibrationError = rows
    ? round(buckets.reduce((sum, bucket) => (
      sum + Number(bucket.rows || 0) * Number(bucket.calibrationError || 0)
    ), 0) / rows)
    : null;
  const maxCalibrationError = buckets.reduce((max, bucket) => {
    const value = Number(bucket.calibrationError);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
  return {
    rows,
    bucketCount: buckets.length,
    maxCalibrationError: buckets.length ? round(maxCalibrationError) : null,
    weightedCalibrationError,
    buckets
  };
};

const recommendationBucketRiskTier = (bucket, bucketId) => {
  const settled = Number(bucket?.settled || 0);
  const avgOdds = Number(bucket?.avgOdds || 0);
  const hitRate = Number(bucket?.hitRate);
  const flatStakeRoi = Number(bucket?.flatStakeRoi);
  if (settled < 20) return "watch";
  if (bucketId === "unknown" || avgOdds <= 0) return "watch";
  if (
    (Number.isFinite(flatStakeRoi) && flatStakeRoi <= -0.5)
    || (avgOdds > 2.6 && Number.isFinite(hitRate) && hitRate < 0.1)
  ) return "degraded";
  if (Number.isFinite(flatStakeRoi) && flatStakeRoi <= -0.2) return "watch";
  return "stable";
};

const summarizeRecommendationBucketRisks = (byOddsBucket, scope) => Object.entries(byOddsBucket || {})
  .map(([id, bucket]) => {
    const tier = recommendationBucketRiskTier(bucket, id);
    const reasons = [];
    if (Number(bucket?.settled || 0) < 20) reasons.push("small-settled-sample");
    if (id === "unknown" || Number(bucket?.avgOdds || 0) <= 0) reasons.push("missing-odds-bucket");
    if (Number(bucket?.flatStakeRoi) <= -0.5) reasons.push("negative-flat-stake-roi-critical");
    else if (Number(bucket?.flatStakeRoi) <= -0.2) reasons.push("negative-flat-stake-roi");
    if (Number(bucket?.avgOdds) > 2.6 && Number(bucket?.hitRate) < 0.1) reasons.push("high-odds-low-hit-rate");
    return {
      id,
      scope,
      tier,
      label: formatRiskTierLabel(tier),
      settled: Number(bucket?.settled || 0),
      hitRate: bucket?.hitRate ?? null,
      flatStakeRoi: bucket?.flatStakeRoi ?? null,
      avgOdds: bucket?.avgOdds ?? null,
      oddsRows: Number(bucket?.oddsRows || 0),
      missingOddsRows: Number(bucket?.missingOddsRows || 0),
      reasons
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

const summarizeModelRiskTiers = ({
  sample,
  probabilityMetrics,
  inputAudit,
  marketBaseline,
  closingLineValue,
  shadowCandidates,
  recommendationMetrics,
  shadowRecommendationMetrics
}) => {
  let overallTier = "stable";
  const reasons = [];
  const addReason = (code, tier, message, evidence = {}) => {
    overallTier = worseRiskTier(overallTier, tier);
    reasons.push({ code, tier, message, evidence });
  };

  const probabilityRows = Number(sample?.probabilityRows || 0);
  const marketBaselineRows = Number(sample?.marketBaselineRows || 0);
  const inputViolationCount = finiteMetric(inputAudit?.violationCount);
  if (inputAudit?.ok !== true || inputViolationCount > 0) {
    addReason("input-audit-failed", "degraded", "pre-match input audit must be clean before model output is trusted", {
      auditOk: inputAudit?.ok ?? null,
      violationCount: inputViolationCount
    });
  } else if (inputAudit?.promotionEligible !== true) {
    addReason("input-audit-promotion-blocked", "watch", "historical features remain shadow-only until feature snapshots contain attributed non-fallback result observation clocks", {
      violationCount: inputViolationCount,
      promotionEligible: inputAudit?.promotionEligible ?? null,
      promotionBlockers: inputAudit?.promotionBlockers || []
    });
  } else {
    addReason("input-audit-passed", "stable", "pre-match input audit has zero leakage violations", {
      violationCount: 0,
      promotionEligible: true
    });
  }

  if (probabilityRows < 30) {
    addReason("probability-sample-critical", "degraded", "probability backtest sample is below the minimum review floor", {
      probabilityRows,
      minimumRows: 30
    });
  } else if (probabilityRows < 500) {
    addReason("probability-sample-small", "watch", "probability backtest sample is below the promotion floor", {
      probabilityRows,
      targetRows: 500
    });
  } else {
    addReason("probability-sample-ready", "stable", "probability backtest sample meets the promotion floor", {
      probabilityRows,
      targetRows: 500
    });
  }

  if (marketBaselineRows < 30) {
    addReason("market-baseline-critical", "degraded", "market baseline comparison sample is below the minimum review floor", {
      marketBaselineRows,
      minimumRows: 30
    });
  } else if (marketBaselineRows < 500) {
    addReason("market-baseline-small", "watch", "market baseline comparison sample is below the promotion floor", {
      marketBaselineRows,
      targetRows: 500
    });
  } else {
    addReason("market-baseline-ready", "stable", "market baseline comparison sample meets the promotion floor", {
      marketBaselineRows,
      targetRows: 500
    });
  }

  const comparison = marketBaseline?.comparison || {};
  const modelComparisonPair = finiteImprovementPair(comparison);
  if (modelComparisonPair) {
    const { logLossImprovement: modelLogLossImprovement, brierImprovement: modelBrierImprovement } = modelComparisonPair;
    if (modelLogLossImprovement < 0 || modelBrierImprovement < 0) {
      addReason("current-model-trails-market", "watch", "current online probability model trails the market baseline and must remain gated", {
        logLossImprovement: comparison.logLossImprovement,
        brierImprovement: comparison.brierImprovement
      });
    } else {
      addReason("current-model-beats-market", "stable", "current probability model beats the market baseline on core metrics", {
        logLossImprovement: comparison.logLossImprovement,
        brierImprovement: comparison.brierImprovement
      });
    }
  } else {
    addReason("market-comparison-missing", "watch", "market baseline comparison is incomplete", {
      logLossImprovement: comparison.logLossImprovement ?? null,
      brierImprovement: comparison.brierImprovement ?? null
    });
  }

  const bestCandidate = shadowCandidates?.bestCandidate || null;
  const bestComparison = bestCandidate?.comparison || {};
  const bestRolling = bestCandidate?.rolling || {};
  const candidateRobustness = shadowCandidates?.robustness || null;
  const bestRollingPassRate = finiteMetric(bestRolling.passRate);
  const bestRollingWindows = Number(bestRolling.windows || 0);
  if (!bestCandidate?.id) {
    addReason("shadow-candidate-missing", "degraded", "no shadow candidate is available for model promotion review");
  } else if (shadowCandidateStabilityReady(bestComparison, bestRolling, candidateRobustness)) {
    addReason("shadow-candidate-clean", "stable", "best shadow candidate beats baseline across enough independent rolling windows and passes selection-adjusted counterevidence tests", {
      id: bestCandidate.id,
      logLossImprovement: bestComparison.logLossImprovement,
      brierImprovement: bestComparison.brierImprovement,
      rollingPassRate: bestRolling.passRate,
      rollingWindows: bestRollingWindows,
      robustnessVersion: candidateRobustness?.version || null,
      robustnessBlockers: candidateRobustness?.blockers || []
    });
  } else {
    addReason("shadow-candidate-not-ready", bestRollingPassRate < 0.6 ? "degraded" : "watch", "best shadow candidate lacks enough independent, selection-adjusted out-of-sample evidence for promotion", {
      id: bestCandidate.id,
      logLossImprovement: bestComparison.logLossImprovement ?? null,
      brierImprovement: bestComparison.brierImprovement ?? null,
      rollingPassRate: bestRolling.passRate ?? null,
      rollingWindows: bestRollingWindows,
      requiredWindows: ROLLING_REQUIRED_WINDOWS,
      robustnessVersion: candidateRobustness?.version || null,
      robustnessBlockers: candidateRobustness?.blockers || []
    });
  }

  const confidenceBuckets = summarizeConfidenceBucketRisks(probabilityMetrics?.calibrationByConfidence);
  const maxCalibrationError = Number(confidenceBuckets.maxCalibrationError);
  if (!confidenceBuckets.bucketCount) {
    addReason("calibration-buckets-missing", "watch", "confidence calibration buckets are missing");
  } else if (maxCalibrationError > 0.3) {
    addReason("calibration-error-high", "degraded", "at least one confidence bucket is badly miscalibrated", {
      maxCalibrationError: confidenceBuckets.maxCalibrationError
    });
  } else if (maxCalibrationError > 0.1) {
    addReason("calibration-error-watch", "watch", "confidence calibration needs more samples before stronger exposure", {
      maxCalibrationError: confidenceBuckets.maxCalibrationError
    });
  } else {
    addReason("calibration-stable", "stable", "confidence buckets are within the first calibration tolerance", {
      maxCalibrationError: confidenceBuckets.maxCalibrationError
    });
  }

  const clvRows = Number(closingLineValue?.rows || 0);
  if (clvRows < 5) {
    addReason("clv-sample-critical", "degraded", "closing-line value sample is too small for release decisions", {
      clvRows,
      minimumRows: 5
    });
  } else if (clvRows < 30) {
    addReason("clv-sample-small", "watch", "closing-line value is tracked but sample is still small", {
      clvRows,
      targetRows: 30
    });
  } else if (Number(closingLineValue?.positiveClvRate) < 0.45) {
    addReason("clv-rate-watch", "watch", "closing-line value trend is below the watch threshold", {
      positiveClvRate: closingLineValue?.positiveClvRate ?? null
    });
  } else {
    addReason("clv-stable", "stable", "closing-line value sample is usable", {
      clvRows,
      positiveClvRate: closingLineValue?.positiveClvRate ?? null
    });
  }

  const recommendationBuckets = summarizeRecommendationBucketRisks(recommendationMetrics?.byOddsBucket, "formal");
  const shadowRecommendationBuckets = summarizeRecommendationBucketRisks(
    shadowRecommendationMetrics?.byOddsBucket,
    "shadow"
  );
  const worstRecommendationTier = recommendationBuckets.reduce((tier, bucket) => worseRiskTier(tier, bucket.tier), "stable");
  if (!recommendationBuckets.length) {
    addReason("recommendation-sample-missing", "watch", "no leakage-safe settled multi-factor recommendations are available yet", {
      buckets: [],
      policy: "keep formal recommendations disabled until as-of evidence accumulates"
    });
  } else if (worstRecommendationTier !== "stable") {
    addReason(
      worstRecommendationTier === "degraded" ? "recommendation-buckets-degraded" : "recommendation-buckets-watch",
      worstRecommendationTier,
      "some recommendation buckets need odds, sample, or performance cleanup before public scorecards are trusted",
      {
        buckets: recommendationBuckets.filter((bucket) => bucket.tier !== "stable").map((bucket) => bucket.id)
      }
    );
  } else {
    addReason("recommendation-buckets-stable", "stable", "recommendation buckets have usable odds and sample coverage", {
      buckets: recommendationBuckets.map((bucket) => bucket.id)
    });
  }

  return {
    version: "model-risk-tier-v1",
    generatedAt: new Date().toISOString(),
    overall: {
      tier: overallTier,
      label: formatRiskTierLabel(overallTier),
      score: riskTierRank[overallTier],
      reasons
    },
    confidenceBuckets,
    recommendationBucketScope: "formal",
    recommendationBuckets,
    shadowRecommendationBucketScope: "shadow",
    shadowRecommendationBuckets,
    marketComparison: {
      rows: marketBaselineRows,
      currentModel: {
        logLossImprovement: comparison.logLossImprovement ?? null,
        brierImprovement: comparison.brierImprovement ?? null,
        accuracyDelta: comparison.accuracyDelta ?? null
      },
      bestShadowCandidate: bestCandidate ? {
        id: bestCandidate.id,
        role: bestCandidate.role || null,
        logLossImprovement: bestComparison.logLossImprovement ?? null,
        brierImprovement: bestComparison.brierImprovement ?? null,
        rollingPassRate: bestRolling.passRate ?? null
      } : null
    },
    closingLineValue: {
      version: closingLineValue?.version || null,
      rows: clvRows,
      candidateRows: Number(closingLineValue?.candidateRows || 0),
      timingCoverage: closingLineValue?.timingCoverage ?? null,
      positiveClvRate: closingLineValue?.positiveClvRate ?? null,
      avgProbabilityMove: closingLineValue?.avgProbabilityMove ?? null,
      avgOddsRatioMove: closingLineValue?.avgOddsRatioMove ?? null,
      directionCounts: closingLineValue?.directionCounts || null,
      timingAudit: closingLineValue?.timingAudit || null
    },
    policy: {
      onlineEffect: "advisory-risk-tier-only",
      probabilityOverride: false,
      llmBoundary: "LLM may explain or review risk labels, but cannot override model probabilities or post-cutoff picks."
    }
  };
};

const timeMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : NaN;
};

const sampleRows = (rows) => rows.slice(0, 5).map((row) => ({
  matchId: row.matchId || null,
  sourceMatchId: row.sourceMatchId || null,
  kickoffTime: row.kickoffTime || null,
  forecastTime: row.forecastTime || null,
  source: row.probabilitySource || null
}));

const summarizePreMatchInputAudit = (rows) => {
  const sourceCounts = rows.reduce((acc, row) => {
    const key = row.probabilitySource || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const withForecastTime = rows.filter((row) => Number.isFinite(timeMs(row.forecastTime)));
  const withMarketAtForecast = rows.filter((row) => row.market?.capturedAt && row.marketProbabilities);
  const withClosingLine = rows.filter((row) => row.closingLine?.capturedAt && row.closingMarketProbabilities);
  const withHistoricalFeatureSnapshot = rows.filter((row) => row.historicalFeatureSnapshot);
  const promotionEligibleRows = rows.filter((row) => row.promotionAudit?.eligible === true);
  const promotionReasonCounts = rows.reduce((acc, row) => {
    for (const reason of row.promotionAudit?.reasons || []) acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});

  const forecastAfterKickoff = rows.filter((row) => {
    const forecast = timeMs(row.forecastTime);
    const kickoff = timeMs(row.kickoffTime);
    return Number.isFinite(forecast) && Number.isFinite(kickoff) && forecast > kickoff;
  });
  const missingForecastTime = rows.filter((row) => !Number.isFinite(timeMs(row.forecastTime)));
  const reviewSnapshotRows = rows.filter((row) => row.snapshot?.phase === "review");
  const snapshotAfterKickoff = rows.filter((row) => {
    if (!row.snapshot) return false;
    const kickoff = timeMs(row.kickoffTime);
    const captured = timeMs(row.snapshot.capturedAt || row.snapshot.firstSeenAt);
    return Number.isFinite(kickoff) && Number.isFinite(captured) && captured > kickoff;
  });
  const marketAfterForecast = rows.filter((row) => {
    if (!row.market?.capturedAt) return false;
    const forecast = timeMs(row.forecastTime);
    const market = timeMs(row.market.capturedAt);
    return Number.isFinite(forecast) && Number.isFinite(market) && market > forecast;
  });
  const closingAfterKickoff = rows.filter((row) => {
    if (!row.closingLine?.capturedAt) return false;
    const kickoff = timeMs(row.kickoffTime);
    const closing = timeMs(row.closingLine.capturedAt);
    return Number.isFinite(kickoff) && Number.isFinite(closing) && closing > kickoff;
  });
  const historicalPolicyMissing = withHistoricalFeatureSnapshot.filter((row) => (
    !String(row.historicalFeatureSnapshot?.cutoffPolicy || "").includes("resultObservedAt")
    || Number(row.historicalFeatureSnapshot?.trainingMatches || 0) < 20
    || !row.historicalFeatureSnapshot?.latestResultObservedAt
  ));
  const historicalResultAfterForecast = withHistoricalFeatureSnapshot.filter((row) => {
    const forecast = timeMs(row.forecastTime);
    const latestResult = timeMs(row.historicalFeatureSnapshot?.latestResultObservedAt);
    return Number.isFinite(forecast) && Number.isFinite(latestResult) && latestResult > forecast;
  });

  const kickoffTimes = rows.map((row) => timeMs(row.kickoffTime)).filter(Number.isFinite).sort((a, b) => a - b);
  const forecastTimes = withForecastTime.map((row) => timeMs(row.forecastTime)).filter(Number.isFinite).sort((a, b) => a - b);
  const violationGroups = {
    forecastAfterKickoff,
    missingForecastTime,
    reviewSnapshotRows,
    snapshotAfterKickoff,
    marketAfterForecast,
    closingAfterKickoff,
    historicalPolicyMissing,
    historicalResultAfterForecast
  };
  const violations = Object.fromEntries(
    Object.entries(violationGroups).map(([key, group]) => [key, {
      count: group.length,
      sample: sampleRows(group)
    }])
  );
  const violationCount = Object.values(violationGroups).reduce((sum, group) => sum + group.length, 0);
  const historicalResultTimeSources = withHistoricalFeatureSnapshot.reduce((acc, row) => {
    acc.explicit += Number(row.historicalFeatureSnapshot?.resultTimeSources?.explicit || 0);
    acc.kickoffPlusThreeHours += Number(row.historicalFeatureSnapshot?.resultTimeSources?.kickoffPlusThreeHours || 0);
    return acc;
  }, { explicit: 0, kickoffPlusThreeHours: 0 });
  const promotionBlockers = [];
  if (promotionEligibleRows.length < MIN_PROMOTION_PROBABILITY_ROWS) {
    promotionBlockers.push(`promotion-cohort-rows:${promotionEligibleRows.length}<${MIN_PROMOTION_PROBABILITY_ROWS}`);
  }
  if (historicalResultTimeSources.kickoffPlusThreeHours > 0) {
    promotionBlockers.push(`historical-result-observed-at-fallback:${historicalResultTimeSources.kickoffPlusThreeHours}`);
  }
  if (withHistoricalFeatureSnapshot.length && historicalResultTimeSources.explicit <= 0) {
    promotionBlockers.push("historical-result-observed-at-explicit-missing");
  }
  const promotionEligible = violationCount === 0 && promotionBlockers.length === 0;

  return {
    version: "pre-match-input-audit-v1",
    ok: violationCount === 0,
    promotionEligible,
    promotionBlockers,
    evidenceDiagnostics: summarizePredictionEvidence(rows),
    policy: {
      splitPolicy: "time-ordered rolling windows; no random split",
      probabilityPolicy: "use locked match probabilities or prediction snapshots captured/first-seen before kickoff; review snapshots are excluded",
      marketBaselinePolicy: "legacy diagnostics may use the latest HAD odds no later than forecastTime, with lag reported; promotion uses only odds and model probabilities frozen in the same clock-audited immutable decision snapshot",
      closingLinePolicy: "closing-line value uses latest odds no later than kickoff and is not used as forecast input",
      historicalFeaturePolicy: "Elo/Poisson features use only attributed non-fallback results observed no later than forecastTime; missing result clocks are excluded rather than synthesized"
    },
    coverage: {
      rows: rows.length,
      rowsWithForecastTime: withForecastTime.length,
      rowsWithMarketAtForecast: withMarketAtForecast.length,
      rowsWithClosingLine: withClosingLine.length,
      rowsWithHistoricalFeatureSnapshot: withHistoricalFeatureSnapshot.length,
      promotionEligibleRows: promotionEligibleRows.length,
      promotionIneligibleRows: rows.length - promotionEligibleRows.length,
      promotionReasonCounts,
      historicalResultTimeSources,
      sourceCounts
    },
    timeWindow: {
      firstKickoffTime: kickoffTimes.length ? new Date(kickoffTimes[0]).toISOString() : null,
      lastKickoffTime: kickoffTimes.length ? new Date(kickoffTimes[kickoffTimes.length - 1]).toISOString() : null,
      firstForecastTime: forecastTimes.length ? new Date(forecastTimes[0]).toISOString() : null,
      lastForecastTime: forecastTimes.length ? new Date(forecastTimes[forecastTimes.length - 1]).toISOString() : null
    },
    violations,
    violationCount
  };
};

const summarizeRollingWindows = (rows, windowSize = ROLLING_MIN_ROWS_PER_WINDOW) => {
  const sorted = rows
    .filter((row) => row.marketProbabilities && row.kickoffTime)
    .slice()
    .sort((a, b) => Date.parse(a.kickoffTime || "") - Date.parse(b.kickoffTime || ""));
  if (sorted.length < Math.min(10, windowSize)) return [];

  const windows = [];
  const safeWindowSize = Math.min(windowSize, sorted.length);
  // Deliberately use disjoint windows. Overlapping windows re-use the same
  // matches and make stability look stronger than the independent evidence is.
  for (let start = 0; start <= sorted.length - safeWindowSize; start += safeWindowSize) {
    const group = sorted.slice(start, start + safeWindowSize);
    const modelMetrics = summarizeProbabilityRows(group);
    const marketMetrics = summarizeProbabilityRows(group.map((row) => ({
      ...row,
      probabilities: row.marketProbabilities
    })));
    windows.push({
      startKickoffTime: group[0]?.kickoffTime || null,
      endKickoffTime: group[group.length - 1]?.kickoffTime || null,
      rows: group.length,
      model: {
        brier: modelMetrics.brier,
        logLoss: modelMetrics.logLoss,
        accuracy: modelMetrics.accuracy
      },
      market: {
        brier: marketMetrics.brier,
        logLoss: marketMetrics.logLoss,
        accuracy: marketMetrics.accuracy
      },
      improvement: compareProbabilityMetrics(modelMetrics, marketMetrics)
    });
  }
  return windows.slice(-12);
};

const dedupeMatches = (matches) => {
  const byKey = new Map();
  for (const match of matches) {
    const key = match?.sourceMatchId || match?.id || `${match?.homeTeamName}-${match?.awayTeamName}-${match?.kickoffTime}`;
    if (!key) continue;
    const previous = byKey.get(key);
    const score = (match?.status === "FINISHED" ? 2 : 0) + (Array.isArray(match?.predictions) ? 1 : 0);
    const previousScore = (previous?.status === "FINISHED" ? 2 : 0) + (Array.isArray(previous?.predictions) ? 1 : 0);
    if (!previous || score >= previousScore) byKey.set(key, match);
  }
  return Array.from(byKey.values());
};

const keyVariantsFor = (row) => {
  const keys = new Set();
  const matchId = String(row?.matchId || row?.id || "").trim();
  const sourceMatchId = String(row?.sourceMatchId || "").trim();
  if (matchId) {
    keys.add(matchId);
    keys.add(matchId.replace(/^sporttery_/, ""));
  }
  if (sourceMatchId) {
    keys.add(sourceMatchId);
    keys.add(`sporttery_${sourceMatchId}`);
  }
  return Array.from(keys).filter(Boolean);
};

const snapshotTimeMs = (snapshot, kickoffMs) => {
  if (snapshot?.phase === "review") return NaN;
  const captured = Date.parse(snapshot?.capturedAt || "");
  if (Number.isFinite(captured) && captured <= kickoffMs) return captured;
  const firstSeen = Date.parse(snapshot?.firstSeenAt || "");
  if (Number.isFinite(firstSeen) && firstSeen <= kickoffMs) return firstSeen;
  return NaN;
};

const buildSnapshotIndex = (snapshots) => {
  const index = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    if (!probabilityTripletForSnapshot(snapshot)) continue;
    for (const key of keyVariantsFor(snapshot)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(snapshot);
    }
  }
  for (const rows of index.values()) {
    rows.sort((a, b) => {
      const aTime = Date.parse(a.capturedAt || a.firstSeenAt || "") || 0;
      const bTime = Date.parse(b.capturedAt || b.firstSeenAt || "") || 0;
      return aTime - bTime;
    });
  }
  return index;
};

const buildDecisionSnapshotIndex = (snapshots) => {
  const index = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    if (!isDecisionSnapshotVersion(snapshot?.decisionSnapshot?.version)) continue;
    for (const key of keyVariantsFor(snapshot)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(snapshot);
    }
  }
  return index;
};

const buildOddsIndex = (rows) => {
  const index = new Map();
  const audit = {
    version: ODDS_OBSERVATION_TRAIL_VERSION,
    stateRows: 0,
    stateRowsWithOfficialObservations: 0,
    stateRowsWithoutOfficialObservations: 0,
    multiObservationStateRows: 0,
    officialObservations: 0,
    indexedHadObservations: 0,
    coverage: null,
    note: "Only independently received official Sporttery responses are eligible; capture buckets and sync replays are excluded.",
  };
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    audit.stateRows += 1;
    const poolCode = String(row.poolCode || row.oddsPoolCode || (/HHAD/i.test(String(row.oddsSource || "")) ? "HHAD" : "HAD")).toUpperCase();
    const observations = oddsObservationTrailForRow(row);
    audit.officialObservations += observations.length;
    if (observations.length) audit.stateRowsWithOfficialObservations += 1;
    else audit.stateRowsWithoutOfficialObservations += 1;
    if (observations.length > 1) audit.multiObservationStateRows += 1;
    if (poolCode !== "HAD" || !marketProbabilityTripletFor(row)) continue;
    for (const observation of observations) {
      const capturedMs = Date.parse(observation.availableAt || "");
      if (!Number.isFinite(capturedMs)) continue;
      const observedRow = {
        ...row,
        capturedAt: observation.availableAt,
        oddsObservation: observation,
        oddsSourceMethod: observation.sourceMethod || row.oddsSourceMethod || null,
      };
      audit.indexedHadObservations += 1;
      for (const key of keyVariantsFor(row)) {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ row: observedRow, capturedMs, source: "official-receipt-trail" });
      }
    }
  }
  for (const rowsForKey of index.values()) {
    rowsForKey.sort((a, b) => a.capturedMs - b.capturedMs);
  }
  audit.coverage = audit.stateRows
    ? Number((audit.stateRowsWithOfficialObservations / audit.stateRows).toFixed(4))
    : null;
  index.observationAudit = audit;
  return index;
};

const findLatestOddsBefore = (match, oddsIndex, cutoffMs) => {
  if (!Number.isFinite(cutoffMs)) return null;
  const candidates = [];
  const seen = new Set();
  for (const key of keyVariantsFor(match)) {
    for (const entry of oddsIndex.get(key) || []) {
      if (entry.capturedMs > cutoffMs) continue;
      const seenKey = `${entry.row.sourceMatchId || ""}:${entry.row.matchId || ""}:${entry.capturedMs}:${entry.row.stateSignature || entry.row.signature || ""}:${entry.row.oddsSource || ""}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      candidates.push(entry);
    }
  }
  candidates.sort((a, b) => b.capturedMs - a.capturedMs);
  return candidates[0] || null;
};

const marketOddsEntryFromSnapshot = (selectedSnapshot) => {
  const snapshot = selectedSnapshot?.snapshot;
  const capturedMs = Number(selectedSnapshot?.timeMs);
  if (!snapshot || !Number.isFinite(capturedMs)) return null;
  const odds = snapshot.decisionSnapshot?.markets?.HAD?.odds
    || snapshot.odds
    || snapshot.featureSnapshot?.market?.had?.odds
    || null;
  const row = {
    matchId: snapshot.matchId || null,
    sourceMatchId: snapshot.sourceMatchId || null,
    capturedAt: new Date(capturedMs).toISOString(),
    odds,
    oddsSource: "prediction-snapshot:HAD",
    oddsSourceMethod: "pre-cutoff-snapshot"
  };
  return marketProbabilityTripletFor(row) ? { row, capturedMs, source: "prediction-snapshot" } : null;
};

const decisionSnapshotPromotionCohortEligible = (decisionSnapshot) => (
  decisionSnapshot?.version === DECISION_SNAPSHOT_VERSION
  && isDecisionClockAuditEligible(decisionSnapshot)
);

const sameProbabilityTriplet = (left, right) => (
  ["1", "X", "2"].every((code) => (
    finiteMetric(left?.[code]) !== null
    && finiteMetric(left?.[code]) === finiteMetric(right?.[code])
  ))
);

const strictDecisionMarketPair = (selectedSnapshot, match) => {
  const snapshot = selectedSnapshot?.snapshot;
  const decision = snapshot?.decisionSnapshot;
  if (!snapshot
      || !decisionSnapshotPromotionCohortEligible(decision)
      || !exactDecisionEventMatch(decision, match)) return null;
  const modelProbabilities = probabilityTripletFromFinal(decision?.probabilities?.HAD);
  const odds = decision?.markets?.HAD?.odds || null;
  const decisionMs = Date.parse(decision.capturedAt || "");
  if (!modelProbabilities
      || !Number.isFinite(decisionMs)
      || decisionMs !== Number(selectedSnapshot?.timeMs)) return null;
  const row = {
    matchId: decision.matchId || null,
    sourceMatchId: decision.sourceMatchId || null,
    capturedAt: new Date(decisionMs).toISOString(),
    observedAt: decision?.markets?.HAD?.observedAt || null,
    receivedAt: decision?.markets?.HAD?.receivedAt || null,
    sourceCycleId: decision?.sourceCycleId || null,
    odds,
    oddsSource: "immutable-decision-snapshot:HAD",
    oddsSourceMethod: "same-decision-clock-audited",
  };
  const marketProbabilities = marketProbabilityTripletFor(row);
  if (!marketProbabilities) return null;
  return {
    decision,
    modelProbabilities,
    marketProbabilities,
    marketEntry: { row, capturedMs: decisionMs, source: "immutable-decision-snapshot" },
  };
};

const promotionProbabilityEligibility = (row, strictDecisionPair = null) => {
  const reasons = [];
  const decision = strictDecisionPair?.decision || null;
  const forecast = timeMs(decision?.decisionAt);
  const kickoff = timeMs(row?.kickoffTime);
  const historicalSnapshot = row?.strictHistoricalFeatureSnapshot;
  const latestHistoricalResult = timeMs(historicalSnapshot?.latestResultObservedAt);
  if (!Number.isFinite(forecast)
      || !Number.isFinite(kickoff)
      || forecast > kickoff
      || row?.strictDecisionAt !== decision?.decisionAt) reasons.push("forecast-clock-invalid");
  if (row?.resultObservationPromotionEligible !== true || row?.resultObservationFallback === true) {
    reasons.push("trusted-result-observation-missing");
  }
  const decisionClockEligible = decisionSnapshotPromotionCohortEligible(decision)
    && row?.strictDecisionSnapshotVersion === DECISION_SNAPSHOT_VERSION
    && row?.strictDecisionClockEligible === true;
  if (!decisionClockEligible) reasons.push("decision-clock-audit-ineligible");
  const marketPairExact = Boolean(
    strictDecisionPair
    && sameProbabilityTriplet(row?.strictModelProbabilities, strictDecisionPair.modelProbabilities)
    && sameProbabilityTriplet(row?.strictMarketProbabilities, strictDecisionPair.marketProbabilities)
    && row?.strictMarket?.source === strictDecisionPair.marketEntry.source
    && row?.strictMarket?.sourceMethod === strictDecisionPair.marketEntry.row.oddsSourceMethod
    && row?.strictMarket?.capturedAt === strictDecisionPair.marketEntry.row.capturedAt
    && row?.strictMarket?.observedAt === strictDecisionPair.marketEntry.row.observedAt
    && row?.strictMarket?.receivedAt === strictDecisionPair.marketEntry.row.receivedAt
    && row?.strictMarket?.sourceCycleId === strictDecisionPair.marketEntry.row.sourceCycleId
    && sameProbabilityTriplet(row?.strictMarket?.probabilities, strictDecisionPair.marketProbabilities)
    && sameProbabilityTriplet(
      marketProbabilityTripletFor({ odds: row?.strictMarket?.odds }),
      strictDecisionPair.marketProbabilities,
    )
  );
  if (!marketPairExact) {
    reasons.push("same-decision-market-pair-missing");
  }
  if (!historicalSnapshot) reasons.push("historical-feature-snapshot-missing");
  else {
    if (!String(historicalSnapshot.cutoffPolicy || "").includes("resultObservedAt")) {
      reasons.push("historical-cutoff-policy-invalid");
    }
    if (Number(historicalSnapshot.trainingMatches || 0) < 20) {
      reasons.push("historical-training-rows-insufficient");
    }
    if (!Number.isFinite(latestHistoricalResult) || latestHistoricalResult > forecast) {
      reasons.push("historical-watermark-invalid");
    }
    if (Number(historicalSnapshot?.resultTimeSources?.kickoffPlusThreeHours || 0) > 0) {
      reasons.push("historical-result-time-fallback-present");
    }
  }
  return { eligible: reasons.length === 0, reasons };
};

const pairingQuantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index].toFixed(2));
};

const summarizeMarketPairingAudit = (rows) => {
  const paired = rows.filter((row) => row.marketProbabilities && row.market?.capturedAt);
  const lags = paired.map((row) => {
    const forecast = timeMs(row.forecastTime);
    const market = timeMs(row.market.capturedAt);
    return Number.isFinite(forecast) && Number.isFinite(market) ? Math.max(0, (forecast - market) / 60000) : null;
  }).filter(Number.isFinite);
  const bySource = paired.reduce((acc, row) => {
    const source = row.market?.source || "unknown";
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  return {
    version: "market-pairing-lag-audit-v1",
    scope: "legacy-diagnostic-only",
    rows: paired.length,
    sameDecisionClockAuditedRows: rows.filter((row) => row.promotionAudit?.eligible === true).length,
    lagRows: lags.length,
    lagMinutes: {
      p50: pairingQuantile(lags, 0.5),
      p90: pairingQuantile(lags, 0.9),
      max: lags.length ? Number(Math.max(...lags).toFixed(2)) : null,
    },
    overFiveMinutes: lags.filter((value) => value > 5).length,
    overSixHours: lags.filter((value) => value > 360).length,
    bySource,
    policy: "These rows are descriptive only. A promotion row must take probabilities and HAD odds from one immutable decision snapshot whose full clock audit passes.",
  };
};

const findPreMatchSnapshotFor = (match, snapshotIndex) => {
  const kickoffMs = Date.parse(match?.kickoffTime || match?.matchDate || "");
  if (!Number.isFinite(kickoffMs)) return null;
  const candidates = [];
  const seen = new Set();
  for (const key of keyVariantsFor(match)) {
    for (const snapshot of snapshotIndex.get(key) || []) {
      const rowKey = `${snapshot.matchId || ""}:${snapshot.sourceMatchId || ""}:${snapshot.phase || ""}:${snapshot.capturedAt || snapshot.firstSeenAt || ""}:${snapshot.signature || ""}`;
      if (seen.has(rowKey)) continue;
      seen.add(rowKey);
      const timeMs = snapshotTimeMs(snapshot, kickoffMs);
      if (!Number.isFinite(timeMs)) continue;
      const probabilities = probabilityTripletForSnapshot(snapshot);
      if (!probabilities) continue;
      candidates.push({ snapshot, timeMs, probabilities });
    }
  }
  candidates.sort((a, b) => b.timeMs - a.timeMs);
  return candidates[0] || null;
};

const PROBABILITY_SELECTION_AUDIT_VERSION = "pre-match-probability-selection-audit-v1";
const PROBABILITY_SELECTION_REASONS = Object.freeze({
  MATCH_PROBABILITIES_MISSING: "match-probabilities-missing",
  MATCH_FORECAST_CLOCK_INVALID: "match-forecast-clock-invalid",
  MATCH_KICKOFF_CLOCK_INVALID: "match-kickoff-clock-invalid",
  MATCH_FORECAST_AFTER_KICKOFF: "match-forecast-after-kickoff",
  VALID_PRE_MATCH_SNAPSHOT_MISSING: "valid-pre-match-snapshot-missing",
});

const createProbabilitySelectionAudit = () => ({
  version: PROBABILITY_SELECTION_AUDIT_VERSION,
  consideredRows: 0,
  selectedRows: 0,
  matchModelSelected: 0,
  snapshotFallbackAttempts: 0,
  snapshotFallbackSelected: 0,
  excludedRows: 0,
  reasonCounts: Object.fromEntries(
    Object.values(PROBABILITY_SELECTION_REASONS).map((reason) => [reason, 0]),
  ),
});

const recordProbabilitySelectionReason = (audit, reason) => {
  if (!audit?.reasonCounts || !Object.hasOwn(audit.reasonCounts, reason)) return;
  audit.reasonCounts[reason] += 1;
};

const selectPreMatchProbabilityInput = (match, snapshotIndex, audit = null) => {
  if (audit) audit.consideredRows += 1;
  const kickoffMs = Date.parse(match?.kickoffTime || match?.matchDate || "");
  const forecastTimeMs = Date.parse(
    match?.predictionMeta?.lockedAt
      || match?.predictionMeta?.generatedAt
      || match?.predictionMeta?.updatedAt
      || "",
  );
  const matchProbabilities = probabilityTripletFor(match);
  const rejectionReasons = [];
  if (!matchProbabilities) {
    rejectionReasons.push(PROBABILITY_SELECTION_REASONS.MATCH_PROBABILITIES_MISSING);
  } else {
    if (!Number.isFinite(kickoffMs)) {
      rejectionReasons.push(PROBABILITY_SELECTION_REASONS.MATCH_KICKOFF_CLOCK_INVALID);
    }
    if (!Number.isFinite(forecastTimeMs)) {
      rejectionReasons.push(PROBABILITY_SELECTION_REASONS.MATCH_FORECAST_CLOCK_INVALID);
    } else if (Number.isFinite(kickoffMs) && forecastTimeMs > kickoffMs) {
      rejectionReasons.push(PROBABILITY_SELECTION_REASONS.MATCH_FORECAST_AFTER_KICKOFF);
    }
  }

  if (matchProbabilities && rejectionReasons.length === 0) {
    if (audit) {
      audit.selectedRows += 1;
      audit.matchModelSelected += 1;
    }
    return {
      probabilities: matchProbabilities,
      probabilitySource: "matchProbabilityModel",
      forecastTimeMs,
      selectedSnapshot: null,
      rejectionReasons,
    };
  }

  for (const reason of rejectionReasons) recordProbabilitySelectionReason(audit, reason);
  if (audit) audit.snapshotFallbackAttempts += 1;
  const selectedSnapshot = findPreMatchSnapshotFor(match, snapshotIndex);
  if (selectedSnapshot?.probabilities) {
    if (audit) {
      audit.selectedRows += 1;
      audit.snapshotFallbackSelected += 1;
    }
    return {
      probabilities: selectedSnapshot.probabilities,
      probabilitySource: "preMatchSnapshot",
      forecastTimeMs: selectedSnapshot.timeMs,
      selectedSnapshot,
      rejectionReasons,
    };
  }

  recordProbabilitySelectionReason(
    audit,
    PROBABILITY_SELECTION_REASONS.VALID_PRE_MATCH_SNAPSHOT_MISSING,
  );
  if (audit) audit.excludedRows += 1;
  return {
    probabilities: null,
    probabilitySource: "missing",
    forecastTimeMs: NaN,
    selectedSnapshot: null,
    rejectionReasons: [
      ...rejectionReasons,
      PROBABILITY_SELECTION_REASONS.VALID_PRE_MATCH_SNAPSHOT_MISSING,
    ],
  };
};

const runProbabilitySelectionSelfTest = () => {
  const checks = [];
  const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
  const kickoffTime = "2026-08-01T03:00:00.000Z";
  const lateForecastTime = "2026-08-01T03:20:00.000Z";
  const match = {
    id: "sporttery_probability-selection-fallback",
    sourceMatchId: "probability-selection-fallback",
    kickoffTime,
    probabilityFinal: { home: 55, draw: 25, away: 20 },
    predictionMeta: { generatedAt: lateForecastTime },
  };
  const snapshot = {
    matchId: match.id,
    sourceMatchId: match.sourceMatchId,
    phase: "pre",
    capturedAt: "2026-08-01T02:40:00.000Z",
    probabilityFinal: { home: 40, draw: 30, away: 30 },
    signature: "probability-selection-safe-snapshot",
  };
  const fallbackAudit = createProbabilitySelectionAudit();
  const fallback = selectPreMatchProbabilityInput(
    match,
    buildSnapshotIndex([snapshot]),
    fallbackAudit,
  );
  push("post-kickoff match model falls back to latest valid pre-match snapshot",
    fallback.probabilitySource === "preMatchSnapshot"
      && fallback.selectedSnapshot?.snapshot === snapshot
      && fallback.forecastTimeMs === Date.parse(snapshot.capturedAt)
      && fallback.probabilities?.["1"] === 0.4
      && fallbackAudit.matchModelSelected === 0
      && fallbackAudit.snapshotFallbackSelected === 1
      && fallbackAudit.excludedRows === 0
      && fallbackAudit.reasonCounts[PROBABILITY_SELECTION_REASONS.MATCH_FORECAST_AFTER_KICKOFF] === 1);

  const exclusionAudit = createProbabilitySelectionAudit();
  const excluded = selectPreMatchProbabilityInput(match, new Map(), exclusionAudit);
  push("post-kickoff match model is excluded when no valid pre-match snapshot exists",
    excluded.probabilities === null
      && excluded.probabilitySource === "missing"
      && exclusionAudit.selectedRows === 0
      && exclusionAudit.snapshotFallbackAttempts === 1
      && exclusionAudit.snapshotFallbackSelected === 0
      && exclusionAudit.excludedRows === 1
      && exclusionAudit.reasonCounts[PROBABILITY_SELECTION_REASONS.MATCH_FORECAST_AFTER_KICKOFF] === 1
      && exclusionAudit.reasonCounts[PROBABILITY_SELECTION_REASONS.VALID_PRE_MATCH_SNAPSHOT_MISSING] === 1);

  const rawLateAudit = summarizePreMatchInputAudit([{
    matchId: match.id,
    sourceMatchId: match.sourceMatchId,
    kickoffTime,
    forecastTime: lateForecastTime,
    probabilitySource: "matchProbabilityModel",
  }]);
  push("input audit still detects a raw post-kickoff forecast",
    rawLateAudit.ok === false
      && rawLateAudit.violationCount === 1
      && rawLateAudit.violations.forecastAfterKickoff.count === 1);

  const aggregateText = JSON.stringify({ fallbackAudit, exclusionAudit });
  push("selection audit exposes aggregate counts without row-level identifiers",
    fallbackAudit.version === PROBABILITY_SELECTION_AUDIT_VERSION
      && exclusionAudit.version === PROBABILITY_SELECTION_AUDIT_VERSION
      && !aggregateText.includes(match.id)
      && !aggregateText.includes(match.sourceMatchId)
      && !Object.hasOwn(fallbackAudit, "rows")
      && !Object.hasOwn(exclusionAudit, "samples"));

  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    verifier: "model-backtest-pre-match-probability-selection",
    assertions: checks.length,
    checks,
  }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
};

const findPreMatchDecisionSnapshotFor = (match, decisionSnapshotIndex) => {
  const kickoffMs = Date.parse(match?.kickoffTime || match?.matchDate || "");
  if (!Number.isFinite(kickoffMs)) return null;
  const candidates = [];
  const seen = new Set();
  for (const key of keyVariantsFor(match)) {
    for (const snapshot of decisionSnapshotIndex.get(key) || []) {
      const decisionSnapshot = snapshot?.decisionSnapshot;
      if (!isDecisionSnapshotVersion(decisionSnapshot?.version)) continue;
      const rowKey = [
        snapshot.matchId || "",
        snapshot.sourceMatchId || "",
        decisionSnapshot.version,
        decisionSnapshot.capturedAt || snapshot.capturedAt || snapshot.firstSeenAt || "",
        decisionSnapshot.policyHash || "",
      ].join(":");
      if (seen.has(rowKey)) continue;
      seen.add(rowKey);
      candidates.push(snapshot);
    }
  }
  const selected = selectLatestEligibleDecisionSnapshot(
    candidates,
    match?.kickoffTime || match?.matchDate,
  );
  if (!selected) return null;
  return {
    snapshot: selected.snapshot,
    timeMs: selected.capturedMs,
    probabilities: probabilityTripletForSnapshot(selected.snapshot),
  };
};

const runStrictPromotionCohortSelfTest = () => {
  const {
    createCollectorAttestationTestContext,
  } = require("./collectorAttestationTestFixture.cjs");
  const checks = [];
  const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const collectorContext = createCollectorAttestationTestContext({
    keyId: "model-backtest-strict-cohort-ed25519",
  });
  const hadProvenance = collectorContext.buildSignedMarketProvenance({
    poolCode: "HAD",
    sourceMatchId: "2040999",
    odds: { "1": 2.1, X: 3.2, "2": 3.4 },
    handicapLine: 0,
    sourceUrl: "https://webapi.sporttery.cn/test",
    providerObservedAt: "2026-07-01T10:30:00.000Z",
    sourceTiming: {
      sourceCycleId: "strict-cycle-1",
      requestedAt: "2026-07-01T10:29:00.000Z",
      receivedAt: "2026-07-01T10:31:00.000Z",
      sourceRequest: { method: "GET", page: 1, role: "model-backtest-strict-cohort" },
      httpStatus: 200,
      rawSha256: "c".repeat(64),
      rawBytes: 1024,
    },
  });
  const decision = {
    version: DECISION_SNAPSHOT_VERSION,
    matchId: "sporttery_2040999",
    sourceMatchId: "2040999",
    capturedAt: "2026-07-01T10:34:00.000Z",
    decisionAt: "2026-07-01T10:35:00.000Z",
    cutoffTime: "2026-07-01T11:00:00.000Z",
    kickoffTime: "2026-07-01T12:00:00.000Z",
    sourceCycleId: "strict-cycle-1",
    sourceTimestamps: {
      modelGeneratedAt: "2026-07-01T10:33:00.000Z",
      baseModelGeneratedAt: "2026-07-01T10:32:00.000Z",
      unifiedPosteriorGeneratedAt: "2026-07-01T10:33:00.000Z",
      hadObservedAt: "2026-07-01T10:30:00.000Z",
      hadReceivedAt: "2026-07-01T10:31:00.000Z",
    },
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: true,
      blockers: [],
      sourceCycleId: "strict-cycle-1",
      capturedAt: "2026-07-01T10:34:00.000Z",
      decisionAt: "2026-07-01T10:35:00.000Z",
      cutoffTime: "2026-07-01T11:00:00.000Z",
      kickoffTime: "2026-07-01T12:00:00.000Z",
      modelGeneratedAt: "2026-07-01T10:33:00.000Z",
      baseModelGeneratedAt: "2026-07-01T10:32:00.000Z",
      unifiedPosteriorGeneratedAt: "2026-07-01T10:33:00.000Z",
      markets: {
        HAD: {
          observedAt: "2026-07-01T10:30:00.000Z",
          receivedAt: "2026-07-01T10:31:00.000Z",
          provenanceHash: hadProvenance.hash,
          provenanceEligible: true,
          sourceCycleId: "strict-cycle-1",
        },
      },
    },
    markets: {
      HAD: {
        line: 0,
        odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
        observedAt: "2026-07-01T10:30:00.000Z",
        receivedAt: "2026-07-01T10:31:00.000Z",
        provenance: hadProvenance,
        provenanceHash: hadProvenance.hash,
      },
    },
    probabilities: {
      HAD: { home: 0.45, draw: 0.28, away: 0.27 },
    },
  };
  const match = {
    id: decision.matchId,
    sourceMatchId: decision.sourceMatchId,
    kickoffTime: decision.kickoffTime,
  };
  const wrapper = {
    snapshot: {
      matchId: decision.matchId,
      sourceMatchId: decision.sourceMatchId,
      odds: { odds1: 9, oddsX: 9, odds2: 9 },
      featureSnapshot: { market: { had: { odds: { odds1: 8, oddsX: 8, odds2: 8 } } } },
      decisionSnapshot: decision,
    },
    timeMs: Date.parse(decision.capturedAt),
  };
  const pair = strictDecisionMarketPair(wrapper, match);
  const clockless = clone(decision);
  delete clockless.clockAudit;
  const legacy = { ...clone(decision), version: LEGACY_DECISION_SNAPSHOT_VERSION };
  const missingInnerMarket = clone(decision);
  delete missingInnerMarket.markets.HAD.odds;
  const missingProvenance = clone(decision);
  delete missingProvenance.markets.HAD.provenance;

  push("v2 promotion cohort requires recomputed clock audit",
    decisionSnapshotPromotionCohortEligible(decision)
      && !decisionSnapshotPromotionCohortEligible(clockless)
      && !decisionSnapshotPromotionCohortEligible(legacy));
  push("same decision pair uses committed market clocks", Boolean(pair)
    && pair.marketEntry.row.observedAt === decision.markets.HAD.observedAt
    && pair.marketEntry.row.receivedAt === decision.markets.HAD.receivedAt
    && pair.marketEntry.row.sourceCycleId === decision.sourceCycleId);
  push("legacy wrapper and outer odds remain diagnostic only",
    strictDecisionMarketPair({ ...wrapper, snapshot: { ...wrapper.snapshot, decisionSnapshot: legacy } }, match) === null);
  push("clockless v2 cannot borrow wrapper evidence",
    strictDecisionMarketPair({ ...wrapper, snapshot: { ...wrapper.snapshot, decisionSnapshot: clockless } }, match) === null);
  push("missing committed odds cannot borrow wrapper evidence",
    strictDecisionMarketPair({ ...wrapper, snapshot: { ...wrapper.snapshot, decisionSnapshot: missingInnerMarket } }, match) === null);
  push("missing signed provenance cannot borrow wrapper evidence",
    strictDecisionMarketPair({ ...wrapper, snapshot: { ...wrapper.snapshot, decisionSnapshot: missingProvenance } }, match) === null);
  push("rescheduled event identity cannot reuse an older decision",
    strictDecisionMarketPair(wrapper, { ...match, kickoffTime: "2026-07-01T13:00:00.000Z" }) === null);
  push("verified official source alias preserves the same immutable decision pair",
    Boolean(strictDecisionMarketPair(wrapper, { ...match, id: "fivehundred_2040999" })));
  push("alias repair never bypasses clock or provenance gates",
    strictDecisionMarketPair({ ...wrapper, snapshot: { ...wrapper.snapshot, decisionSnapshot: clockless } }, { ...match, id: "fivehundred_2040999" }) === null
      && strictDecisionMarketPair({ ...wrapper, snapshot: { ...wrapper.snapshot, decisionSnapshot: missingProvenance } }, { ...match, id: "fivehundred_2040999" }) === null);
  push("unknown prefixes and conflicting official source ids cannot alias",
    strictDecisionMarketPair(wrapper, { ...match, id: "unknown_2040999" }) === null
      && strictDecisionMarketPair(wrapper, { ...match, id: "fivehundred_2040999", sourceMatchId: "2040998" }) === null);

  const pairMarketRow = pair?.marketEntry?.row || {};
  const validRow = {
    ...match,
    matchId: match.id,
    forecastTime: "2026-07-01T11:59:00.000Z",
    resultObservationPromotionEligible: true,
    resultObservationFallback: false,
    strictDecisionSnapshotVersion: decision.version,
    strictDecisionClockEligible: true,
    strictDecisionAt: decision.decisionAt,
    strictModelProbabilities: pair?.modelProbabilities || null,
    strictMarketProbabilities: pair?.marketProbabilities || null,
    strictMarket: {
      capturedAt: pairMarketRow.capturedAt || null,
      observedAt: pairMarketRow.observedAt || null,
      receivedAt: pairMarketRow.receivedAt || null,
      sourceCycleId: pairMarketRow.sourceCycleId || null,
      source: pair?.marketEntry?.source || null,
      sourceMethod: pairMarketRow.oddsSourceMethod || null,
      odds: oddsTripletFor(pairMarketRow),
      probabilities: pair?.marketProbabilities || null,
    },
    strictHistoricalFeatureSnapshot: {
      cutoffPolicy: HISTORICAL_RESULT_CUTOFF_POLICY,
      trainingMatches: 20,
      latestResultObservedAt: "2026-07-01T10:20:00.000Z",
      resultTimeSources: { explicit: 20, kickoffPlusThreeHours: 0 },
    },
  };
  push("only full strict row enters promotion baseline",
    promotionProbabilityEligibility(validRow, pair).eligible === true);
  const outerOnly = {
    ...validRow,
    historicalFeatureSnapshot: validRow.strictHistoricalFeatureSnapshot,
    marketProbabilities: pair?.marketProbabilities || null,
    probabilities: pair?.modelProbabilities || null,
    strictHistoricalFeatureSnapshot: null,
  };
  const outerOnlyAudit = promotionProbabilityEligibility(outerOnly, null);
  push("legacy odds history and outer historical wrapper cannot promote",
    outerOnlyAudit.eligible === false
      && outerOnlyAudit.reasons.includes("decision-clock-audit-ineligible")
      && outerOnlyAudit.reasons.includes("same-decision-market-pair-missing")
      && outerOnlyAudit.reasons.includes("historical-feature-snapshot-missing"));
  push("trusted result is mandatory",
    promotionProbabilityEligibility({ ...validRow, resultObservationPromotionEligible: false }, pair)
      .reasons.includes("trusted-result-observation-missing"));
  push("historical watermark is bounded by decision time",
    promotionProbabilityEligibility({
      ...validRow,
      strictHistoricalFeatureSnapshot: {
        ...validRow.strictHistoricalFeatureSnapshot,
        latestResultObservedAt: "2026-07-01T10:36:00.000Z",
      },
    }, pair).reasons.includes("historical-watermark-invalid"));
  push("tampered row market cannot reuse a valid decision audit",
    promotionProbabilityEligibility({
      ...validRow,
      strictMarket: { ...validRow.strictMarket, odds: { odds1: 1.2, oddsX: 8, odds2: 8 } },
    }, pair).reasons.includes("same-decision-market-pair-missing"));

  const generatedHistoricalState = createHistoricalModelState();
  generatedHistoricalState.matches = 20;
  generatedHistoricalState.homeGoals = 27;
  generatedHistoricalState.awayGoals = 22;
  generatedHistoricalState.latestResultObservedMs = Date.parse("2026-07-01T10:20:00.000Z");
  generatedHistoricalState.explicitResultTimeMatches = 20;
  const generatedHistorical = predictHistoricalModels(generatedHistoricalState, {
    homeTeamName: "Producer Home",
    awayTeamName: "Producer Away",
  });
  const generatedHistoricalAuditRow = {
    matchId: "producer-policy",
    sourceMatchId: "producer-policy",
    kickoffTime: "2026-07-01T12:00:00.000Z",
    forecastTime: "2026-07-01T10:35:00.000Z",
    probabilitySource: "preMatchSnapshot",
    historicalFeatureSnapshot: generatedHistorical?.featureSnapshot,
  };
  const generatedHistoricalAudit = summarizePreMatchInputAudit([generatedHistoricalAuditRow]);
  const tamperedHistoricalAudit = summarizePreMatchInputAudit([{
    ...generatedHistoricalAuditRow,
    historicalFeatureSnapshot: {
      ...generatedHistoricalAuditRow.historicalFeatureSnapshot,
      cutoffPolicy: "Observed results only.",
    },
  }]);
  push("historical producer policy satisfies input audit and tampering fails closed",
    generatedHistorical?.featureSnapshot?.cutoffPolicy === HISTORICAL_RESULT_CUTOFF_POLICY
      && generatedHistoricalAudit.violations.historicalPolicyMissing.count === 0
      && generatedHistoricalAudit.violations.historicalResultAfterForecast.count === 0
      && generatedHistoricalAudit.ok === true
      && tamperedHistoricalAudit.violations.historicalPolicyMissing.count === 1
      && tamperedHistoricalAudit.ok === false);

  collectorContext.cleanup();
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    verifier: "model-backtest-strict-promotion-cohort",
    assertions: checks.length,
    checks,
  }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
};

const runNullFailClosedSelfTest = () => {
  const checks = [];
  const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
  for (const missing of [null, undefined, "", "   "]) {
    const label = missing === undefined ? "undefined" : JSON.stringify(missing);
    push(`missing-score-${label}`,
      scorePairFor({ scoreHome: missing, scoreAway: 0 }) === null
        && scorePairFor({ scoreHome: 0, scoreAway: missing }) === null
        && resultCodeFor({ scoreHome: missing, scoreAway: missing }) === "");
    push(`missing-improvement-${label}`,
      hasNonNegativeImprovementPair({ logLossImprovement: missing, brierImprovement: 0 }) === false
        && hasNonNegativeImprovementPair({ logLossImprovement: 0, brierImprovement: missing }) === false
        && shadowCandidateStabilityReady(
          { logLossImprovement: missing, brierImprovement: 0 },
          { passRate: 1, windows: ROLLING_REQUIRED_WINDOWS },
        ) === false);
    const missingProbabilityTriplet = { "1": missing, X: 0.4, "2": 0.6 };
    push(`missing-probability-${label}`,
      normalizePercent(missing) === null
        && probabilityTripletFromFinal({ home: missing, draw: 40, away: 60 }) === null
        && normalizeProbabilityTriplet(missingProbabilityTriplet) === null
        && topProbabilityCode(missingProbabilityTriplet) === ""
        && probabilityForCode(missingProbabilityTriplet, "1") === null);
  }
  push("numeric-zero-score-remains-valid",
    resultCodeFor({ scoreHome: 0, scoreAway: 0 }) === "X"
      && JSON.stringify(scorePairFor({ scoreHome: "0", scoreAway: "0" })) === JSON.stringify({ home: 0, away: 0 }));
  push("numeric-zero-improvements-remain-valid",
    hasNonNegativeImprovementPair({ logLossImprovement: 0, brierImprovement: 0 }) === true
      && shadowCandidateStabilityReady(
        { logLossImprovement: 0, brierImprovement: 0 },
        { passRate: 0.8, windows: ROLLING_REQUIRED_WINDOWS },
        { candidateReadyForProspectiveTest: true },
      ) === true);
  const genuineZeroTriplet = { "1": 0, X: 0.4, "2": 0.6 };
  const normalizedGenuineZero = probabilityTripletFromFinal({ home: 0, draw: 40, away: 60 });
  push("numeric-zero-probability-remains-valid",
    normalizePercent(0) === 0
      && normalizedGenuineZero?.["1"] === 0
      && normalizeProbabilityTriplet(genuineZeroTriplet)?.["1"] === 0
      && topProbabilityCode(genuineZeroTriplet) === "2"
      && probabilityForCode(genuineZeroTriplet, "1") === 0);
  const outOfRangeTriplets = [
    { "1": -0.1, X: 0.5, "2": 0.6 },
    { "1": 1.1, X: 0, "2": 0 },
  ];
  push("out-of-range-probabilities-fail-closed",
    normalizePercent(-0.1) === null
      && normalizePercent(101) === null
      && probabilityTripletFromFinal({ home: -1, draw: 40, away: 61 }) === null
      && probabilityTripletFromFinal({ home: 101, draw: 0, away: 0 }) === null
      && outOfRangeTriplets.every((triplet) => (
        normalizeProbabilityTriplet(triplet) === null
          && topProbabilityCode(triplet) === ""
          && probabilityForCode(triplet, "1") === null
      )));
  const partialTriplet = { "1": 0.5, X: 0.5 };
  push("partial-triplet-and-invalid-code-fail-closed",
    topProbabilityCode(partialTriplet) === ""
      && probabilityForCode(partialTriplet, "1") === null
      && probabilityForCode(genuineZeroTriplet, "home") === null);
  const invalidRolling = summarizeRollingPassRate([
    { improvement: { logLossImprovement: null, brierImprovement: 0 } },
    { improvement: { logLossImprovement: "   ", brierImprovement: 0 } },
  ]);
  push("missing-rolling-improvements-are-not-windows",
    invalidRolling.windows === 0 && invalidRolling.passed === 0 && invalidRolling.passRate === null,
    invalidRolling);
  const validRolling = summarizeRollingPassRate([
    { improvement: { logLossImprovement: 0, brierImprovement: 0 } },
  ]);
  push("numeric-zero-rolling-improvement-remains-valid",
    validRolling.windows === 1 && validRolling.passed === 1 && validRolling.passRate === 1,
    validRolling);
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    verifier: "model-backtest-null-fail-closed",
    assertions: checks.length,
    checks,
  }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
};

const runSqliteStreamingSelfTest = () => {
  const checks = [];
  const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-model-sqlite-stream-"));
  const dbPath = path.join(tempDir, "snapshots.sqlite");
  const validRows = 18000;
  const invalidRows = 3;
  // Keep the duplicate ratio close to the live snapshot store. This proves the
  // loader is safe even when almost every parsed snapshot must remain retained.
  const uniqueRows = 17664;
  const limit = validRows + invalidRows;
  const padding = "x".repeat(4096);
  let db = null;
  let serializedBytes = 0;
  try {
    if (!DatabaseSync) throw sqliteLoadError || new Error("node:sqlite is unavailable");
    db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE prediction_snapshots (
        captured_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    const insert = db.prepare("INSERT INTO prediction_snapshots (captured_at, payload) VALUES (?, ?)");
    const baseMs = Date.parse("2026-07-01T00:00:00.000Z");
    db.exec("BEGIN");
    for (let index = 0; index < validRows; index += 1) {
      const group = index % uniqueRows;
      const payload = JSON.stringify({
        sourceMatchId: `stream-${String(group).padStart(3, "0")}`,
        phase: "pre",
        signature: `signature-${group}`,
        featureSnapshotHash: `feature-${group}`,
        capturedAt: new Date(baseMs + group * 1000).toISOString(),
        revision: index,
        decisionSnapshot: {
          version: DECISION_SNAPSHOT_VERSION,
          capturedAt: new Date(baseMs + group * 1000).toISOString(),
          clockAudit: { eligible: false, blockers: ["synthetic-memory-regression"] },
        },
        featureSnapshot: {
          hash: `feature-${group}`,
          attributes: { padding },
        },
      });
      serializedBytes += Buffer.byteLength(payload);
      insert.run(new Date(baseMs + index * 1000).toISOString(), payload);
    }
    for (const invalidPayload of ["{bad-json", "null", "42"]) {
      serializedBytes += Buffer.byteLength(invalidPayload);
      insert.run(new Date(baseMs + (validRows + invalidRows) * 1000).toISOString(), invalidPayload);
    }
    db.exec("COMMIT");
    closeDatabase(db);
    db = null;

    if (typeof global.gc === "function") global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const streamed = readSqlitePayloadRows("prediction_snapshots", {
      dbPath,
      limit,
      observeMemory: true,
    });
    if (typeof global.gc === "function") global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const retainedHeapGrowth = Math.max(0, heapAfter - heapBefore);
    const peakHeapGrowth = Math.max(0, Number(streamed.peakHeapUsed || heapBefore) - heapBefore);

    push("representative snapshot volume streams under constrained old-space",
      process.execArgv.some((arg) => arg === "--max-old-space-size=128")
        && streamed.ok === true
        && streamed.selectedRows === limit
        && streamed.parsedRows === validRows, {
        constrainedOldSpaceMiB: 128,
        selectedRows: streamed.selectedRows,
        parsedRows: streamed.parsedRows,
        serializedMiB: Number((serializedBytes / 1024 / 1024).toFixed(2)),
      });
    push("streaming parser deduplicates without shrinking the SQL row limit",
      streamed.uniqueRows === uniqueRows
        && streamed.duplicateRows === validRows - uniqueRows
        && streamed.invalidRows === invalidRows
        && streamed.rows.length === uniqueRows, {
        limit: streamed.limit,
        selectedRows: streamed.selectedRows,
        uniqueRows: streamed.uniqueRows,
        duplicateRows: streamed.duplicateRows,
        invalidRows: streamed.invalidRows,
      });
    const expectedLatestRevision = new Map();
    for (let index = 0; index < validRows; index += 1) expectedLatestRevision.set(index % uniqueRows, index);
    push("streaming dedupe keeps the same last-payload value and first-key order",
      streamed.rows.every((row, index) => row.sourceMatchId === `stream-${String(index).padStart(3, "0")}`
        && row.revision === expectedLatestRevision.get(index)));

    const equivalenceLimit = 257;
    db = new DatabaseSync(dbPath, { readOnly: true });
    const legacyRows = Array.from(db.prepare(`
      SELECT payload
      FROM prediction_snapshots
      ORDER BY captured_at ASC
      LIMIT ?
    `).iterate(equivalenceLimit))
      .map((row) => safeJsonParse(row.payload, null))
      .filter((payload) => payload && typeof payload === "object");
    closeDatabase(db);
    db = null;
    const legacyMap = new Map();
    for (const row of legacyRows) legacyMap.set(payloadRowKey(row, "predictionSnapshots"), row);
    const legacyEquivalentRows = Array.from(legacyMap.values());
    const streamedEquivalent = readSqlitePayloadRows("prediction_snapshots", {
      dbPath,
      limit: equivalenceLimit,
    });
    push("iterate output is equivalent to the previous all-then-dedupe semantics",
      streamedEquivalent.ok === true
        && streamedEquivalent.parsedRows === legacyRows.length
        && JSON.stringify(streamedEquivalent.rows) === JSON.stringify(legacyEquivalentRows), {
        limit: equivalenceLimit,
        parsedRows: streamedEquivalent.parsedRows,
        uniqueRows: streamedEquivalent.uniqueRows,
      });

    const publicOverride = {
      ...streamed.rows[0],
      revision: "public-override",
    };
    const publicOnly = {
      ...streamed.rows[0],
      sourceMatchId: "stream-public-only",
      signature: "signature-public-only",
      featureSnapshotHash: "feature-public-only",
      capturedAt: "2026-07-02T00:00:00.000Z",
      revision: "public-only",
    };
    const selection = preferRows([publicOverride, publicOnly], streamed, "predictionSnapshots");
    push("public overlay and SQLite audit counts preserve previous coverage semantics",
      selection.selectedSource === "sqlite+public-json"
        && selection.sqliteRows === validRows
        && selection.sqliteUniqueRows === uniqueRows
        && selection.sqliteSelectedRows === limit
        && selection.sqliteInvalidRows === invalidRows
        && selection.sqliteDuplicateRows === validRows - uniqueRows
        && selection.mergedRows === uniqueRows + 1
        && selection.rows.some((row) => row.revision === "public-override")
        && selection.rows.some((row) => row.revision === "public-only"), {
        selectedSource: selection.selectedSource,
        sqliteRows: selection.sqliteRows,
        sqliteUniqueRows: selection.sqliteUniqueRows,
        mergedRows: selection.mergedRows,
      });
    push("streaming heap stays below the duplicated raw-plus-object footprint",
      typeof global.gc === "function"
        && retainedHeapGrowth < serializedBytes * 1.4
        && peakHeapGrowth < serializedBytes * 1.7, {
        retainedHeapGrowthMiB: Number((retainedHeapGrowth / 1024 / 1024).toFixed(2)),
        peakHeapGrowthMiB: Number((peakHeapGrowth / 1024 / 1024).toFixed(2)),
        serializedMiB: Number((serializedBytes / 1024 / 1024).toFixed(2)),
      });
  } catch (error) {
    push("SQLite streaming regression completed", false, { error: error?.stack || String(error) });
  } finally {
    closeDatabase(db);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    verifier: "model-backtest-sqlite-streaming",
    assertions: checks.length,
    checks,
  }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
};

const runOddsObservationBacktestSelfTest = () => {
  const checks = [];
  const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
  const match = {
    id: "sporttery_observation-test",
    sourceMatchId: "observation-test",
  };
  const common = {
    sourceMatchId: "observation-test",
    poolCode: "HAD",
    cutoffTime: "2026-07-28T12:00:00.000Z",
    kickoffTime: "2026-07-28T12:05:00.000Z",
    oddsSource: "sporttery:HAD",
    oddsSourceMethod: "current",
    oddsSourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry",
    odds1: 2,
    oddsX: 3.2,
    odds2: 3.8,
  };
  const rows = [{
    ...common,
    capturedAt: "2026-07-28T10:00:00.000Z",
    captureBucket: "2026-07-28T10:00:00.000Z",
    oddsReceivedAt: "2026-07-28T10:30:00.000Z",
    sourceCycleId: "cycle-1",
    observationTrail: [
      {
        availableAt: "2026-07-28T10:30:00.000Z",
        receivedAt: "2026-07-28T10:30:00.000Z",
        sourceCycleId: "cycle-1",
        sourceMethod: "current",
      },
      {
        availableAt: "2026-07-28T11:45:00.000Z",
        receivedAt: "2026-07-28T11:45:00.000Z",
        sourceCycleId: "cycle-2",
        sourceMethod: "current",
      },
    ],
  }];
  const index = buildOddsIndex(rows);
  const beforeReceipt = findLatestOddsBefore(match, index, Date.parse("2026-07-28T10:15:00.000Z"));
  const afterFirstReceipt = findLatestOddsBefore(match, index, Date.parse("2026-07-28T10:45:00.000Z"));
  const afterSecondReceipt = findLatestOddsBefore(match, index, Date.parse("2026-07-28T11:50:00.000Z"));
  push("capture bucket before provider receipt is not forecast-visible", beforeReceipt === null);
  push("first official response becomes visible at receipt time",
    afterFirstReceipt?.row?.capturedAt === "2026-07-28T10:30:00.000Z");
  push("later independent response remains a distinct same-odds observation",
    afterSecondReceipt?.row?.capturedAt === "2026-07-28T11:45:00.000Z");
  push("observation coverage audit counts independent responses",
    index.observationAudit?.stateRowsWithOfficialObservations === 1
      && index.observationAudit?.multiObservationStateRows === 1
      && index.observationAudit?.officialObservations === 2,
    { observationAudit: index.observationAudit });
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    verifier: "model-backtest-odds-observation-time",
    assertions: checks.length,
    checks,
  }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
};

const runRecommendationSelectionTimeOrderSelfTest = () => {
  const checks = [];
  const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
  const row = (sourceMatchId, kickoffTime) => ({
    id: sourceMatchId,
    matchId: sourceMatchId,
    sourceMatchId,
    kickoffTime,
    oddsPoolCode: "HAD",
    marketType: "BEST",
    tipCode: "1",
    odds: 2.1,
    won: true,
    modelPickProbability: 0.55,
    marketPickProbability: 0.5,
    resultObservationPromotionEligible: true,
    decisionSnapshotVersion: DECISION_SNAPSHOT_VERSION,
    localEvidenceEligible: true,
  });
  const mixedTimezoneRows = [
    row("mixed-z-6", "2026-08-01T02:30:00.000Z"),
    row("mixed-plus-1", "2026-08-01T08:15:00+08:00"),
    row("mixed-z-4", "2026-08-01T01:30:00.000Z"),
    row("mixed-plus-5", "2026-08-01T10:00:00+08:00"),
    row("mixed-z-2", "2026-08-01T00:30:00.000Z"),
    row("mixed-plus-3", "2026-08-01T09:00:00+08:00"),
  ];
  const lexicallySortedIds = [...mixedTimezoneRows]
    .sort((left, right) => String(left.kickoffTime).localeCompare(String(right.kickoffTime)))
    .map((entry) => entry.sourceMatchId);
  const epochSorted = [...mixedTimezoneRows].sort(compareRecommendationSelectionRows);
  const epochSortedIds = epochSorted.map((entry) => entry.sourceMatchId);
  const expectedEpochOrder = [
    "mixed-plus-1",
    "mixed-z-2",
    "mixed-plus-3",
    "mixed-z-4",
    "mixed-plus-5",
    "mixed-z-6",
  ];
  push("mixed timezone text order differs from chronological epoch order",
    JSON.stringify(lexicallySortedIds) !== JSON.stringify(expectedEpochOrder)
      && JSON.stringify(epochSortedIds) === JSON.stringify(expectedEpochOrder), {
      lexicallySortedIds,
      epochSortedIds,
    });

  const comparison = recommendationSelectionComparison(mixedTimezoneRows);
  const windowBounds = comparison.rollingWindows.map((window) => ({
    start: Date.parse(window.startKickoffTime || ""),
    end: Date.parse(window.endKickoffTime || ""),
  }));
  push("six mixed timezone windows are strictly ordered and non-overlapping by epoch",
    comparison.rollingWindows.length === 6
      && comparison.chronology?.valid === true
      && comparison.chronology?.invalidKickoffRows === 0
      && windowBounds.every((window, index) => Number.isFinite(window.start)
        && Number.isFinite(window.end)
        && window.start <= window.end
        && (index === 0 || windowBounds[index - 1].end < window.start)), {
      windows: comparison.rollingWindows.map((window, index) => ({
        index: window.index,
        startKickoffTime: window.startKickoffTime,
        endKickoffTime: window.endKickoffTime,
        startEpoch: windowBounds[index]?.start ?? null,
        endEpoch: windowBounds[index]?.end ?? null,
      })),
    });

  const sameEpochRows = [
    row("same-epoch-b", "2026-08-01T08:00:00+08:00"),
    row("same-epoch-a", "2026-08-01T00:00:00.000Z"),
  ].sort(compareRecommendationSelectionRows);
  push("equal epochs use stable source identity tie breaking",
    sameEpochRows.map((entry) => entry.sourceMatchId).join(",") === "same-epoch-a,same-epoch-b");

  const invalidRows = [
    ...mixedTimezoneRows,
    row("invalid-time-b", "not-a-time"),
    row("invalid-time-a", ""),
  ];
  const invalidSorted = [...invalidRows].sort(compareRecommendationSelectionRows);
  const invalidComparison = recommendationSelectionComparison(invalidRows);
  push("invalid kickoff times sort last deterministically and fail the promotion gate closed",
    invalidSorted.slice(-2).map((entry) => entry.sourceMatchId).join(",") === "invalid-time-a,invalid-time-b"
      && invalidComparison.chronology?.valid === false
      && invalidComparison.chronology?.invalidKickoffRows === 2
      && invalidComparison.gate?.eligible === false
      && invalidComparison.gate?.blockers?.includes("invalid-kickoff-time:2"), {
      sortedIds: invalidSorted.map((entry) => entry.sourceMatchId),
      chronology: invalidComparison.chronology,
      blockers: invalidComparison.gate?.blockers || [],
    });

  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    verifier: "model-backtest-recommendation-selection-time-order",
    assertions: checks.length,
    checks,
  }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
};

if (process.argv.includes("--verify-strict-promotion-cohort")) runStrictPromotionCohortSelfTest();
if (process.argv.includes("--verify-null-fail-closed")) runNullFailClosedSelfTest();
if (process.argv.includes("--verify-sqlite-streaming")) runSqliteStreamingSelfTest();
if (process.argv.includes("--verify-odds-observation-time")) runOddsObservationBacktestSelfTest();
if (process.argv.includes("--verify-recommendation-selection-time-order")) runRecommendationSelectionTimeOrderSelfTest();
if (process.argv.includes("--verify-probability-selection")) runProbabilitySelectionSelfTest();

const current = readJson(path.join(publicDataDir, "matches-current.json"), []);
const history = readJson(path.join(publicDataDir, "matches-history.json"), []);
const oddsHistory = readJson(path.join(publicDataDir, "odds-history.json"), { rows: [] });
const matches = dedupeMatches([...(Array.isArray(current) ? current : []), ...(Array.isArray(history) ? history : [])]);
const publicOddsRows = Array.isArray(oddsHistory?.rows) ? oddsHistory.rows : [];
const sqlitePredictionRows = readSqlitePayloadRows("prediction_snapshots", {
  limit: Math.max(1, Number(process.env.MODEL_BACKTEST_SQLITE_PREDICTION_LIMIT || 50000)),
  preferLatestRows: true,
  maxRowsPerMatch: Math.max(
    2,
    Number(process.env.MODEL_BACKTEST_SNAPSHOTS_PER_MATCH || 6),
  ),
  acceptPayload: isBacktestPredictionSnapshot,
});
const sqliteOddsRows = readSqlitePayloadRows("odds_snapshots", {
  limit: Math.max(1, Number(process.env.MODEL_BACKTEST_SQLITE_ODDS_LIMIT || 120000))
});
// The synchronized SQLite publication is the authority during production
// backtests. Avoid parsing the much larger JSON mirror a second time when
// SQLite already yielded rows; retain the file only as a fail-safe fallback.
const predictionSnapshots = sqlitePredictionRows.ok === true
  && Number(sqlitePredictionRows.parsedRows || 0) > 0
  ? { rows: [] }
  : readJson(path.join(publicDataDir, "prediction-snapshots.json"), { rows: [] });
const publicSnapshotRows = Array.isArray(predictionSnapshots?.rows)
  ? predictionSnapshots.rows.filter(isBacktestPredictionSnapshot)
  : [];
const snapshotSelection = preferRows(publicSnapshotRows, sqlitePredictionRows, "predictionSnapshots");
const oddsSelection = preferRows(publicOddsRows, sqliteOddsRows, "oddsHistory");
const snapshotRows = snapshotSelection.rows;
const oddsRows = oddsSelection.rows;
const dataSources = {
  matches: {
    selectedSource: "public-json",
    currentRows: Array.isArray(current) ? current.length : 0,
    historyRows: Array.isArray(history) ? history.length : 0
  },
  predictionSnapshots: rowSelectionSummary(snapshotSelection),
  oddsHistory: rowSelectionSummary(oddsSelection)
};
const snapshotIndex = buildSnapshotIndex(snapshotRows);
const decisionSnapshotIndex = buildDecisionSnapshotIndex(snapshotRows);
const oddsIndex = buildOddsIndex(oddsRows);

const probabilityRows = [];
const strictDecisionPairByProbabilityRow = new WeakMap();
const predictionRows = [];
const shadowDecisionRows = [];
const candidateDecisionRows = [];
const decisionSnapshotAudit = {
  settledMatchesSeen: 0,
  immutableSnapshotsFound: 0,
  invalidOrPostKickoffSnapshots: 0,
  candidateRows: 0,
  promotionCandidateRows: 0,
  resultIneligibleCandidateRows: 0,
  clockIneligibleV2CandidateRows: 0,
  legacyV1AuditOnlyCandidateRows: 0,
  selectedShadowRows: 0,
  exactPolicyReplayRows: 0,
  exactV2PolicyReplayRows: 0,
  versions: {
    [LEGACY_DECISION_SNAPSHOT_VERSION]: {
      snapshots: 0,
      candidateRows: 0,
      exactAuditReplayRows: 0,
      promotionCohortRows: 0,
    },
    [DECISION_SNAPSHOT_VERSION]: {
      snapshots: 0,
      candidateRows: 0,
      exactAuditReplayRows: 0,
      promotionCohortRows: 0,
    },
  },
};
const recommendationEligibilityAudit = {
  settledPredictionRowsSeen: 0,
  settledOutcomeRowsWithoutOfficialSp: 0,
  excludedIneligibleResultObservation: 0,
  excludedNotMainRecommendation: 0,
  excludedInvalidPoolOrTip: 0,
  excludedUnknownOfficialSp: 0,
  eligibleBeforeDeduplication: 0,
  deduplicatedRows: 0
};
const probabilitySourceCounts = {
  matchProbabilityModel: 0,
  preMatchSnapshot: 0,
  missing: 0
};
const probabilitySelectionAudit = createProbabilitySelectionAudit();
for (const match of matches) {
  if (match?.status !== "FINISHED") continue;
  const actual = resultCodeFor(match);
  if (!actual) continue;
  const resultObservation = resultObservedEntryFor(match);
  const resultObservationPromotionEligible = resultObservation?.promotionEligible === true;
  const recommendationDecisionSnapshot = findPreMatchDecisionSnapshotFor(match, decisionSnapshotIndex);
  const strictDecisionPair = strictDecisionMarketPair(recommendationDecisionSnapshot, match);

  const probabilitySelection = selectPreMatchProbabilityInput(
    match,
    snapshotIndex,
    probabilitySelectionAudit,
  );
  const {
    probabilities,
    probabilitySource,
    forecastTimeMs,
    selectedSnapshot,
  } = probabilitySelection;
  const snapshotMeta = selectedSnapshot ? {
    phase: selectedSnapshot.snapshot?.phase || null,
    capturedAt: selectedSnapshot.snapshot?.capturedAt || null,
    firstSeenAt: selectedSnapshot.snapshot?.firstSeenAt || null,
    policyVersion: selectedSnapshot.snapshot?.policyVersion || null,
    probabilityModelVersion: selectedSnapshot.snapshot?.probabilityModelVersion || null
  } : null;
  if (probabilities) {
    const kickoffMs = Date.parse(match?.kickoffTime || match?.matchDate || "");
    let forecastOdds = findLatestOddsBefore(match, oddsIndex, Number.isFinite(forecastTimeMs) ? forecastTimeMs : kickoffMs);
    if (!forecastOdds) {
      forecastOdds = marketOddsEntryFromSnapshot(selectedSnapshot);
    }
    const closingOdds = findLatestOddsBefore(match, oddsIndex, kickoffMs);
    const marketProbabilities = marketProbabilityTripletFor(forecastOdds?.row);
    const closingMarketProbabilities = marketProbabilityTripletFor(closingOdds?.row);
    const modelPick = topProbabilityCode(probabilities);
    const forecastOddsTriplet = oddsTripletFor(forecastOdds?.row);
    const closingOddsTriplet = oddsTripletFor(closingOdds?.row);
    const forecastPickOdds = oddsForCode(forecastOddsTriplet, modelPick);
    const closingPickOdds = oddsForCode(closingOddsTriplet, modelPick);
    const forecastMarketPickProbability = probabilityForCode(marketProbabilities, modelPick);
    const closingMarketPickProbability = probabilityForCode(closingMarketProbabilities, modelPick);
    const forecastOddsCapturedAt = Number.isFinite(forecastOdds?.capturedMs)
      ? new Date(forecastOdds.capturedMs).toISOString()
      : null;
    const closingOddsCapturedAt = Number.isFinite(closingOdds?.capturedMs)
      ? new Date(closingOdds.capturedMs).toISOString()
      : null;
    const clvTiming = assessClvTiming({
      forecastCapturedAt: forecastOddsCapturedAt,
      closingCapturedAt: closingOddsCapturedAt,
      kickoffTime: Number.isFinite(kickoffMs) ? new Date(kickoffMs).toISOString() : null,
    });
    const clvProbabilityMove = clvTiming.eligible
      && Number.isFinite(forecastMarketPickProbability)
      && Number.isFinite(closingMarketPickProbability)
      ? closingMarketPickProbability - forecastMarketPickProbability
      : null;
    const clvOddsRatioMove = clvTiming.eligible
      && Number.isFinite(forecastPickOdds)
      && Number.isFinite(closingPickOdds)
      && closingPickOdds > 0
      ? (forecastPickOdds / closingPickOdds) - 1
      : null;
    probabilitySourceCounts[probabilitySource] += 1;
    const probabilityRow = {
      matchId: match.id || null,
      sourceMatchId: match.sourceMatchId || null,
      kickoffTime: match.kickoffTime || null,
      forecastTime: Number.isFinite(forecastTimeMs) ? new Date(forecastTimeMs).toISOString() : null,
      resultObservedAt: Number.isFinite(resultObservation?.observedMs)
        ? new Date(resultObservation.observedMs).toISOString()
        : null,
      resultObservationSource: resultObservation?.source || null,
      resultObservationFallback: resultObservation?.fallback === true,
      resultObservationPromotionEligible: resultObservation?.promotionEligible === true,
      league: match.leagueName || match.leagueNameEn || "unknown",
      homeTeamName: match.homeTeamName || match.homeTeamNameEn || null,
      awayTeamName: match.awayTeamName || match.awayTeamNameEn || null,
      profile: profileKey(match),
      actual,
      probabilities,
      marketProbabilities,
      closingMarketProbabilities,
      modelPick,
      oddsTrend: selectedSnapshot?.snapshot?.oddsTrend || null,
      forecastOddsCapturedAt,
      closingOddsCapturedAt,
      clvTiming,
      clvProbabilityMove,
      clvOddsRatioMove,
      probabilitySource,
      market: marketProbabilities ? {
        capturedAt: forecastOddsCapturedAt,
        source: forecastOdds?.source || forecastOdds?.row?.oddsSource || null,
        odds: forecastOddsTriplet,
        probabilities: marketProbabilities
      } : null,
      strictDecisionSnapshotVersion: strictDecisionPair?.decision?.version || null,
      evidenceTrace: observePredictionEvidence({ match, selectedSnapshot: recommendationDecisionSnapshot, strictPair: strictDecisionPair }),
      strictDecisionClockEligible: Boolean(strictDecisionPair),
      strictDecisionAt: strictDecisionPair?.decision?.decisionAt || null,
      strictModelProbabilities: strictDecisionPair?.modelProbabilities || null,
      strictMarketProbabilities: strictDecisionPair?.marketProbabilities || null,
      strictMarket: strictDecisionPair ? {
        capturedAt: strictDecisionPair.marketEntry.row.capturedAt,
        observedAt: strictDecisionPair.marketEntry.row.observedAt,
        receivedAt: strictDecisionPair.marketEntry.row.receivedAt,
        sourceCycleId: strictDecisionPair.marketEntry.row.sourceCycleId,
        source: strictDecisionPair.marketEntry.source,
        sourceMethod: strictDecisionPair.marketEntry.row.oddsSourceMethod,
        odds: oddsTripletFor(strictDecisionPair.marketEntry.row),
        probabilities: strictDecisionPair.marketProbabilities,
      } : null,
      closingLine: closingMarketProbabilities ? {
        capturedAt: closingOddsCapturedAt,
        odds: closingOddsTriplet,
        probabilities: closingMarketProbabilities
      } : null,
      snapshot: snapshotMeta
    };
    probabilityRows.push(probabilityRow);
    if (strictDecisionPair) strictDecisionPairByProbabilityRow.set(probabilityRow, strictDecisionPair);
  } else {
    probabilitySourceCounts.missing += 1;
  }

  const recommendationSnapshot = recommendationDecisionSnapshot
    || selectedSnapshot
    || findPreMatchSnapshotFor(match, snapshotIndex);
  decisionSnapshotAudit.settledMatchesSeen += 1;
  const decisionSnapshot = recommendationDecisionSnapshot?.snapshot?.decisionSnapshot
    || recommendationSnapshot?.snapshot?.decisionSnapshot
    || null;
  if (isDecisionSnapshotVersion(decisionSnapshot?.version)) {
    const decisionCapturedMs = Date.parse(decisionSnapshot.capturedAt || recommendationSnapshot?.snapshot?.capturedAt || "");
    const kickoffMs = Date.parse(match?.kickoffTime || match?.matchDate || "");
    if (Number.isFinite(decisionCapturedMs) && Number.isFinite(kickoffMs) && decisionCapturedMs <= kickoffMs) {
      decisionSnapshotAudit.immutableSnapshotsFound += 1;
      const versionAudit = decisionSnapshotAudit.versions[decisionSnapshot.version];
      versionAudit.snapshots += 1;
      const isPromotionSnapshot = isPromotionDecisionSnapshotVersion(decisionSnapshot.version);
      const decisionClockEligible = decisionSnapshotPromotionCohortEligible(decisionSnapshot);
      const rowsForDecision = [];
      for (const candidate of Array.isArray(decisionSnapshot.candidates) ? decisionSnapshot.candidates : []) {
        const settlement = settleDecisionCandidate(candidate, match.scoreHome, match.scoreAway);
        if (!settlement) continue;
        const replay = evidenceReplayForCandidate(decisionSnapshot, candidate);
        const row = {
          matchId: match.id || decisionSnapshot.matchId || null,
          sourceMatchId: match.sourceMatchId || decisionSnapshot.sourceMatchId || null,
          kickoffTime: match.kickoffTime || decisionSnapshot.kickoffTime || null,
          forecastTime: decisionSnapshot.capturedAt || null,
          league: match.leagueName || match.leagueNameEn || "unknown",
          profile: profileKey(match),
          marketType: candidate.market,
          oddsPoolCode: candidate.market,
          handicapLine: candidate.market === "HHAD" ? candidate.handicapLine : null,
          tipCode: candidate.code,
          odds: candidate.odds,
          oddsBucket: oddsBucket(candidate.odds),
          oddsSource: `candidate-decision-snapshot:${candidate.market}`,
          modelPickProbability: candidate.modelProbability,
          marketPickProbability: candidate.marketProbability,
          probabilityEdge: candidate.probabilityEdge,
          expectedValue: candidate.expectedValue,
          evidenceScore: candidate.evidenceScore,
          evidenceVersion: candidate.evidenceVersion,
          publicEligible: candidate.publicEligible === true,
          localEvidenceEligible: candidate.localEvidenceEligible === true,
          selected: candidate.selected === true,
          blockers: candidate.blockers || [],
          policyVersion: decisionSnapshot.policyVersion || null,
          policyHash: decisionSnapshot.policyHash || null,
          decisionSnapshotVersion: decisionSnapshot.version,
          auditPolicyReplay: replay.exact,
          productionPolicyReplay:
            decisionClockEligible
            && resultObservationPromotionEligible
            && replay.exact,
          promotionCohortEligible: decisionClockEligible && resultObservationPromotionEligible,
          resultObservationPromotionEligible,
          replayReason: replay.reason || null,
          replayEligible: replay.replay?.eligible === true,
          outcomeCode: settlement.outcomeCode,
          won: settlement.won,
        };
        candidateDecisionRows.push(row);
        rowsForDecision.push(row);
        decisionSnapshotAudit.candidateRows += 1;
        versionAudit.candidateRows += 1;
        if (decisionClockEligible && resultObservationPromotionEligible) {
          decisionSnapshotAudit.promotionCandidateRows += 1;
          versionAudit.promotionCohortRows += 1;
        } else if (decisionClockEligible && !resultObservationPromotionEligible) {
          decisionSnapshotAudit.resultIneligibleCandidateRows += 1;
        } else if (isPromotionSnapshot) {
          decisionSnapshotAudit.clockIneligibleV2CandidateRows += 1;
        } else {
          decisionSnapshotAudit.legacyV1AuditOnlyCandidateRows += 1;
        }
        if (replay.exact) {
          decisionSnapshotAudit.exactPolicyReplayRows += 1;
          versionAudit.exactAuditReplayRows += 1;
          if (decisionClockEligible) decisionSnapshotAudit.exactV2PolicyReplayRows += 1;
        }
      }
      const selectedKey = decisionSnapshot.exposure?.shadowCandidateKey || decisionSnapshot.selectedCandidateKey;
      const selectedRow = rowsForDecision.find((row) => {
        const line = row.oddsPoolCode === "HHAD" ? row.handicapLine : 0;
        return `${row.oddsPoolCode}:${row.tipCode}:${line}` === selectedKey;
      }) || rowsForDecision.find((row) => row.selected);
      if (decisionClockEligible
          && resultObservationPromotionEligible
          && selectedRow
          && decisionSnapshot.exposure?.shadowEligible !== false) {
        shadowDecisionRows.push({
          ...selectedRow,
          marketType: "BEST",
          decisionMode: "shadow",
          publicAction: decisionSnapshot.exposure?.publicAction || "reference",
        });
        decisionSnapshotAudit.selectedShadowRows += 1;
      }
    } else {
      decisionSnapshotAudit.invalidOrPostKickoffSnapshots += 1;
    }
  }
  const seenPredictionRows = new Set();
  const addPredictionRow = (prediction) => {
    if (!prediction) return;
    const status = prediction.resultStatus;
    if (status !== "WON" && status !== "LOST") return;
    recommendationEligibilityAudit.settledPredictionRowsSeen += 1;
    if (!resultObservationPromotionEligible) {
      recommendationEligibilityAudit.excludedIneligibleResultObservation += 1;
      return;
    }
    const observedPool = predictionOddsPool(prediction);
    const observedTipCode = normalizeTipCodeForOdds(prediction.tipCode);
    if (["HAD", "HHAD"].includes(observedPool) && ["1", "X", "2"].includes(observedTipCode)) {
      const observedTriplet = officialOddsTripletForPrediction(match, prediction, recommendationSnapshot);
      if (!oddsForCode(observedTriplet, observedTipCode)) {
        recommendationEligibilityAudit.settledOutcomeRowsWithoutOfficialSp += 1;
      }
    }
    if (!isMainRecommendation(prediction)) {
      recommendationEligibilityAudit.excludedNotMainRecommendation += 1;
      return;
    }
    const pool = predictionOddsPool(prediction);
    const tipCode = normalizeTipCodeForOdds(prediction.tipCode);
    if (!["HAD", "HHAD"].includes(pool) || !["1", "X", "2"].includes(tipCode)) {
      recommendationEligibilityAudit.excludedInvalidPoolOrTip += 1;
      return;
    }
    const snapshotOddsTriplet = snapshotOddsTripletForPrediction(recommendationSnapshot, prediction);
    const matchOddsTriplet = matchOddsTripletForPrediction(match, prediction);
    const officialOddsTriplet = snapshotOddsTriplet || matchOddsTriplet;
    const officialOdds = oddsForCode(officialOddsTriplet, tipCode);
    if (!officialOdds) {
      recommendationEligibilityAudit.excludedUnknownOfficialSp += 1;
      return;
    }
    recommendationEligibilityAudit.eligibleBeforeDeduplication += 1;
    const key = [
      match.id || "",
      "BEST",
      pool,
      prediction.handicapLine ?? "",
      tipCode,
      officialOdds
    ].join("|");
    if (seenPredictionRows.has(key)) {
      recommendationEligibilityAudit.deduplicatedRows += 1;
      return;
    }
    seenPredictionRows.add(key);
    // Legacy HHAD rows do not carry a candidate-level probability frozen in
    // the same pre-match snapshot as the line and SP. Leave their model score
    // empty instead of leaking the finished match's latest probability model.
    const modelProbabilityTriplet = pool === "HHAD" ? null : probabilities;
    const marketProbabilityTriplet = marketProbabilityTripletFor(officialOddsTriplet);
    predictionRows.push({
      matchId: match.id || null,
      sourceMatchId: match.sourceMatchId || null,
      kickoffTime: match.kickoffTime || null,
      league: match.leagueName || match.leagueNameEn || "unknown",
      profile: profileKey(match),
      marketType: "BEST",
      oddsPoolCode: pool,
      tipCode,
      odds: officialOdds,
      oddsBucket: oddsBucket(officialOdds),
      oddsSource: snapshotOddsTriplet ? `pre-match-snapshot:${pool}` : `locked-match:${pool}`,
      modelPickProbability: probabilityForCode(modelProbabilityTriplet, tipCode),
      marketPickProbability: probabilityForCode(marketProbabilityTriplet, tipCode),
      resultObservationPromotionEligible,
      won: status === "WON"
    });
  };

  for (const prediction of Array.isArray(match.predictions) ? match.predictions : []) {
    addPredictionRow(prediction);
  }
}

attachHistoricalModelFeatures(probabilityRows, matches);
for (const row of probabilityRows) {
  row.promotionAudit = promotionProbabilityEligibility(
    row,
    strictDecisionPairByProbabilityRow.get(row) || null,
  );
}
const promotionProbabilityRows = probabilityRows.filter((row) => row.promotionAudit.eligible);

const residualMarketWalkForward = evaluateResidualMarketWalkForward(
  promotionProbabilityRows
    .filter((row) => row.strictMarketProbabilities)
    .map((row) => ({
      ...row,
      marketProbabilities: row.strictMarketProbabilities,
      currentModelProbabilities: row.strictModelProbabilities,
      historicalModelProbabilities: row.strictHistoricalBlendProbabilities,
    })),
);

const historicalModelRows = {
  elo: probabilityRows.filter((row) => row.eloProbabilities).length,
  poisson: probabilityRows.filter((row) => row.poissonProbabilities).length,
  historicalBlend: probabilityRows.filter((row) => row.historicalBlendProbabilities).length
};
const modelProbabilityMetrics = summarizeProbabilityRows(probabilityRows);
const marketBaselineRows = probabilityRows
  .filter((row) => row.marketProbabilities)
  .map((row) => ({
    ...row,
    probabilities: row.marketProbabilities
  }));
const marketBaselineMetrics = summarizeProbabilityRows(marketBaselineRows);
const matchedModelRows = probabilityRows.filter((row) => row.marketProbabilities);
const matchedModelMetrics = summarizeProbabilityRows(matchedModelRows);
const promotionMarketBaselineRows = promotionProbabilityRows.map((row) => ({
  ...row,
  probabilities: row.strictMarketProbabilities,
}));
const promotionModelRows = promotionProbabilityRows.map((row) => ({
  ...row,
  probabilities: row.strictModelProbabilities,
}));
const promotionMarketBaselineMetrics = summarizeProbabilityRows(promotionMarketBaselineRows);
const promotionModelMetrics = summarizeProbabilityRows(promotionModelRows);
const marketPairingAudit = summarizeMarketPairingAudit(probabilityRows);
const clvRows = probabilityRows
  .filter((row) => row.marketProbabilities && row.closingMarketProbabilities)
  .map((row) => ({
    matchId: row.matchId,
    sourceMatchId: row.sourceMatchId,
    kickoffTime: row.kickoffTime,
    forecastTime: row.forecastTime,
    modelPick: row.modelPick,
    actual: row.actual,
    forecastOddsCapturedAt: row.forecastOddsCapturedAt,
    closingOddsCapturedAt: row.closingOddsCapturedAt,
    clvTiming: row.clvTiming,
    clvProbabilityMove: row.clvProbabilityMove,
    clvOddsRatioMove: row.clvOddsRatioMove,
    won: row.modelPick === row.actual
  }));
const rollingWindows = summarizeRollingWindows(probabilityRows);
const shadowCandidates = evaluateShadowCandidates(probabilityRows);
const inputAudit = summarizePreMatchInputAudit(probabilityRows);
inputAudit.coverage.probabilitySelection = {
  ...probabilitySelectionAudit,
  reasonCounts: { ...probabilitySelectionAudit.reasonCounts },
};
const walkForwardValidation = buildWalkForwardValidation({
  rows: probabilityRows,
  candidates: shadowCandidates.candidates,
});
const forecastHorizons = summarizeForecastHorizons(probabilityRows);
const closingLineValue = summarizeClvRows(clvRows);
const recommendationSelectionRows = shadowDecisionRows.length ? shadowDecisionRows : predictionRows;
const recommendationSelection = recommendationSelectionComparison(recommendationSelectionRows, candidateDecisionRows);
const policyPredictionRows = recommendationSelection.gate.eligible
  ? predictionRows.filter(multiFactorShadowEligible)
  : predictionRows;
const recommendationMetrics = {
  policy: recommendationSelection.gate.eligible ? MULTI_FACTOR_POLICY_VERSION : "multi-factor-evidence-shadow",
  total: summarizePredictionRows(policyPredictionRows),
  byMarket: groupSummary(policyPredictionRows, (row) => row.marketType),
  byLeague: groupSummary(policyPredictionRows, (row) => row.league),
  byProfile: groupSummary(policyPredictionRows, (row) => row.profile),
  byOddsBucket: groupSummary(policyPredictionRows, (row) => row.oddsBucket)
};
const shadowRecommendationMetrics = {
  policy: "immutable-candidate-decision-shadow",
  source: shadowDecisionRows.length ? DECISION_SNAPSHOT_VERSION : "not-yet-collected",
  total: summarizePredictionRows(shadowDecisionRows),
  localEvidence: summarizePredictionRows(shadowDecisionRows.filter(multiFactorShadowEligible)),
  byMarket: groupSummary(shadowDecisionRows, (row) => row.oddsPoolCode),
  byLeague: groupSummary(shadowDecisionRows, (row) => row.league),
  byProfile: groupSummary(shadowDecisionRows, (row) => row.profile),
  byOddsBucket: groupSummary(shadowDecisionRows, (row) => row.oddsBucket)
};
const riskTiers = summarizeModelRiskTiers({
  sample: {
    probabilityRows: probabilityRows.length,
    marketBaselineRows: marketBaselineRows.length
  },
  probabilityMetrics: modelProbabilityMetrics,
  inputAudit,
  marketBaseline: {
    comparison: compareProbabilityMetrics(matchedModelMetrics, marketBaselineMetrics)
  },
  closingLineValue,
  shadowCandidates,
  recommendationMetrics,
  shadowRecommendationMetrics
});
const generatedAt = new Date().toISOString();
const promotionEvidenceAudit = buildPromotionEvidenceAudit({
  matches,
  snapshots: snapshotRows,
  generatedAt,
});
const globalRiskTier = riskTiers?.overall?.tier || "unknown";
const hhadCompanionAudit = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: snapshotRows,
  matches,
  globalRiskTier,
  evaluatedAt: generatedAt,
  includeInternalRows: true,
});
const {
  finalExposureRows: hhadCompanionFinalExposureRows,
  settlementRows: hhadCompanionSettlementRows,
  ...hhadCompanionEvaluation
} = hhadCompanionAudit;
const currentWorldCupResearchAudit = buildWorldCupAudit(
  loadWorldCupAuditInputs(path.dirname(publicOutputFile)),
).benchmarkShadow;
const frozenWorldCupResearchSnapshot = loadWorldCupResearchSnapshot(
  path.join(rootDir, "model-research", "world-cup-research-benchmark.json"),
);
const benchmarkResearchAudit = Number(
  currentWorldCupResearchAudit?.walkForward?.selectedRows || 0,
) > 0
  ? {
      ...currentWorldCupResearchAudit,
      source: "current-runtime-research-replay",
    }
  : researchAuditFromSnapshot(frozenWorldCupResearchSnapshot);
const {
  ledgerUpdate: benchmarkProspectiveLedgerUpdate,
  audit: benchmarkShadowAudit,
} = withCandidateProspectiveRegistryLock(
  benchmarkProspectiveLedgerFile,
  () => {
    const update = buildBenchmarkProspectiveAudit({
      priorLedger: readJson(benchmarkProspectiveLedgerFile, null),
      matches,
      snapshots: snapshotRows,
      oddsRows,
      evaluatedAt: generatedAt,
      researchAudit: benchmarkResearchAudit,
    });
    if (update.ledgerUpdate.chainValid) {
      writeJson(benchmarkProspectiveLedgerFile, update.ledgerUpdate.ledger);
    }
    return update;
  },
);
const candidateProspectiveUpdate = withCandidateProspectiveRegistryLock(
  candidateProspectiveRegistryFile,
  () => {
    const priorRegistry = readJson(candidateProspectiveRegistryFile, null);
    const gateCompatibility = candidateGateSpecCompatibility({
      priorRegistry,
      resetAuthorization:
        process.env.CANDIDATE_PROSPECTIVE_GATE_RESET_AUTHORIZATION || "",
    });
    if (!gateCompatibility.ok) {
      const error = new Error([
        "active candidate gate specification changed after prospective evidence",
        `ledger=${gateCompatibility.activeLedgerId || "unknown"}`,
        `evidence=${gateCompatibility.postActivationEvidenceCount}`,
        "set CANDIDATE_PROSPECTIVE_GATE_RESET_AUTHORIZATION to the exact",
        `hash-bound value ${gateCompatibility.expectedResetAuthorization}`,
        "only when a deliberate new prospective trial is approved",
      ].join("; "));
      error.code = "CANDIDATE_PROSPECTIVE_GATE_RESET_AUTHORIZATION_REQUIRED";
      error.gateCompatibility = gateCompatibility;
      throw error;
    }
    const update = updateCandidateProspectiveLedger({
      priorRegistry,
      candidates: shadowCandidates.candidates,
      selectedCandidate: shadowCandidates.bestCandidate,
      robustness: shadowCandidates.robustness,
      matches,
      snapshots: snapshotRows,
      evaluatedAt: generatedAt,
      implementationCommitment: candidateImplementationCommitment,
      nominationPolicyCommitment: nominationSelectionPolicyCommitment(),
      trustedCollectorCount: Math.max(
        0,
        Number(process.env.TRUSTED_SPORTTERY_COLLECTOR_COUNT || 1),
      ),
    });
    if (update.chainValid) {
      writeJson(candidateProspectiveRegistryFile, update.registry);
    }
    return update;
  },
  { timeoutMs: candidateProspectiveRegistryLockTimeoutMs },
);
shadowCandidates.robustness = {
  ...shadowCandidates.robustness,
  prospectiveConfirmation: candidateProspectiveUpdate.audit,
  formalPromotionEligible:
    shadowCandidates.robustness?.candidateReadyForProspectiveTest === true
    && candidateProspectiveUpdate.audit?.formalPromotionEligible === true,
};

const payload = {
  ok: true,
  version: VERSION,
  generatedAt,
  source: "settled-pre-match-predictions",
  sample: {
    matches: matches.length,
    predictionSnapshots: snapshotRows.length,
    oddsHistoryRows: oddsRows.length,
    oddsObservationAudit: oddsIndex.observationAudit,
    dataSources,
    probabilityRows: probabilityRows.length,
    marketBaselineRows: marketBaselineRows.length,
    promotionProbabilityRows: promotionProbabilityRows.length,
    promotionMarketBaselineRows: promotionMarketBaselineRows.length,
    clvRows: closingLineValue.rows,
    clvCandidateRows: closingLineValue.candidateRows,
    clvTimingCoverage: closingLineValue.timingCoverage,
    historicalModelRows,
    probabilitySources: probabilitySourceCounts,
    predictionRows: policyPredictionRows.length,
    recommendationBaselineRows: predictionRows.length,
    shadowDecisionRows: shadowDecisionRows.length,
    candidateDecisionRows: candidateDecisionRows.length,
    benchmarkShadowRows: benchmarkShadowAudit?.prospective?.cohort?.settled || 0,
    benchmarkResearchRows: benchmarkShadowAudit?.research?.selectedRows || 0,
    candidateProspectiveFormalRows:
      candidateProspectiveUpdate.audit?.cohort?.formal?.settled || 0,
    candidateProspectiveShadowRows:
      candidateProspectiveUpdate.audit?.cohort?.shadow?.settled || 0,
    hhadCompanion: { ...(hhadCompanionEvaluation.counts || {}) },
    decisionSnapshotAudit,
    recommendationEligibilityAudit
  },
  probabilityMetrics: modelProbabilityMetrics,
  inputAudit,
  walkForwardValidation,
  residualMarketWalkForward,
  promotionEvidenceAudit,
  forecastHorizons,
  marketBaseline: {
    source: "sporttery-had-devigged-forecast-time-latest-at-or-before-legacy-diagnostic",
    metrics: marketBaselineMetrics,
    modelOnSameRows: matchedModelMetrics,
    comparison: compareProbabilityMetrics(matchedModelMetrics, marketBaselineMetrics),
    promotionEligible: false,
    note: "Legacy diagnostic cohort; pairing lag and wrapper provenance are audited separately and cannot activate a model."
  },
  promotionMarketBaseline: {
    source: "immutable-clock-audited-decision-snapshot-had",
    metrics: promotionMarketBaselineMetrics,
    modelOnSameRows: promotionModelMetrics,
    comparison: compareProbabilityMetrics(promotionModelMetrics, promotionMarketBaselineMetrics),
    promotionEligible: promotionProbabilityRows.length >= MIN_PROMOTION_PROBABILITY_ROWS,
  },
  marketPairingAudit,
  oddsObservationAudit: oddsIndex.observationAudit,
  closingLineValue,
  rollingWindows,
  shadowCandidates: {
    version: shadowCandidates.version,
    generatedAt: shadowCandidates.generatedAt,
    sample: shadowCandidates.sample,
    baselineId: shadowCandidates.baselineId,
    bestCandidateId: shadowCandidates.bestCandidateId,
    bestCandidate: shadowCandidates.bestCandidate,
    bestModelCandidateId: shadowCandidates.bestModelCandidateId,
    bestModelCandidate: shadowCandidates.bestModelCandidate,
    summary: shadowCandidates.summary,
    selectionPolicy: shadowCandidates.selectionPolicy,
    robustness: shadowCandidates.robustness,
    candidates: shadowCandidates.candidates,
    policy: shadowCandidates.policy
  },
  recommendationSelection,
  recommendationMetrics,
  shadowRecommendationMetrics,
  benchmarkShadowAudit,
  candidateProspectiveAudit: candidateProspectiveUpdate.audit,
  riskTiers,
  hhadCompanionEvaluation,
  policy: {
    split: "time-ordered non-overlapping rolling backtest required before online promotion",
    leakageGuard: "legacy probability metrics remain diagnostic and report market lag; promotion metrics use only rows with a trusted result observation, a complete historical feature watermark, and model probabilities plus HAD odds frozen inside the same immutable v2 decision snapshot whose clock audit passes; v1 and wrapper fallbacks remain audit-only",
    recommendationEligibility: "unknown SP, model-only, reference, WATCH, non-BEST and non-official pools never enter recommendation counts or hit-rate denominators",
    productionPolicyValidation: "the production multi-factor evidence-score implementation is replayed exactly from immutable v2 canonical inputs; v1 is excluded from promotion, HAD and HHAD each need at least 100 exact-policy v2 rows, and the full selection gate still needs 300 candidates over six chronological windows before promotion",
    horizonPolicy: "forecast lead-time buckets are reported independently; mixed horizons cannot by themselves justify promotion",
    promotionGate: "shadow models must beat the same-match market baseline across at least six non-overlapping windows before affecting online recommendations",
    walkForwardPromotion: "promotion additionally requires a versioned walk-forward fold/refit protocol and a verified training-data watermark strictly before the evaluation window; the current artifact remains shadow until both are recorded",
    promotionEvidence: "promotion requires an immutable hash-bound feature/decision/odds/probability/official-result record with explicit observed and received clocks; missing clocks, review rows, post-cutoff rows and duplicate conflicts fail closed",
    residualLearning: "the regularized market-residual learner is refit inside each expanding walk-forward fold and remains shadow-only; it cannot activate production probabilities",
    llmRole: "risk review and explanation only"
  }
};

const privateHhadCompanionAudit = {
  ...hhadCompanionAudit,
  finalExposureRows: hhadCompanionFinalExposureRows,
  settlementRows: hhadCompanionSettlementRows,
};
ensureIsolatedPrivateArtifactDb();
const privateAuditWrite = writePrivateModelArtifact({
  dbPath: privateArtifactDbPath,
  artifactKey: HHAD_COMPANION_AUDIT_KEY,
  artifactVersion: privateHhadCompanionAudit.version,
  generatedAt: privateHhadCompanionAudit.evaluatedAt || generatedAt,
  payload: privateHhadCompanionAudit,
});
const legacyPrivateAuditRemoved = removeLegacyPrivateAuditFile(legacyHhadCompanionAuditFile);

writeJson(serverOutputFile, payload);
writeJson(publicOutputFile, payload);
writeJson(shadowCandidatesOutputFile, shadowCandidates);

console.log(JSON.stringify({
  ok: true,
  outputFiles: [serverOutputFile, publicOutputFile, shadowCandidatesOutputFile],
  privateArtifact: {
    storage: "sqlite",
    dbPath: privateAuditWrite.dbPath,
    table: "private_model_artifacts",
    artifactKey: privateAuditWrite.artifactKey,
    artifactVersion: privateAuditWrite.artifactVersion,
    payloadBytes: privateAuditWrite.payloadBytes,
    payloadSha256: privateAuditWrite.payloadSha256,
    legacyFileRemoved: legacyPrivateAuditRemoved,
    isolated: isolatedOutput,
  },
  benchmarkProspectiveLedger: {
    file: benchmarkProspectiveLedgerFile,
    chainValid: benchmarkProspectiveLedgerUpdate.chainValid,
    changed: benchmarkProspectiveLedgerUpdate.changed,
    events: benchmarkProspectiveLedgerUpdate.ledger?.events?.length || 0,
    rootHash: benchmarkProspectiveLedgerUpdate.ledger?.rootHash || null,
    blockers: benchmarkProspectiveLedgerUpdate.blockers,
  },
  candidateProspectiveLedger: {
    file: candidateProspectiveRegistryFile,
    chainValid: candidateProspectiveUpdate.chainValid,
    changed: candidateProspectiveUpdate.changed,
    activeLedgerId: candidateProspectiveUpdate.registry?.activeLedgerId || null,
    state: candidateProspectiveUpdate.audit?.state || null,
    candidateRevisionId: candidateProspectiveUpdate.audit?.candidateRevisionId || null,
    shadowUniverse: candidateProspectiveUpdate.audit?.cohort?.shadow?.universe || 0,
    formalUniverse: candidateProspectiveUpdate.audit?.cohort?.formal?.universe || 0,
    formalSettled: candidateProspectiveUpdate.audit?.cohort?.formal?.settled || 0,
    rootHash: candidateProspectiveUpdate.audit?.rootHash || null,
    blockers: candidateProspectiveUpdate.blockers,
  },
  sample: payload.sample,
  inputAudit: {
    ok: inputAudit.ok,
    coverage: inputAudit.coverage,
    violationCount: inputAudit.violationCount
  },
  walkForwardValidation: {
    status: walkForwardValidation.status,
    eligible: walkForwardValidation.eligible,
    protocolVersion: walkForwardValidation.protocolVersion,
    watermark: walkForwardValidation.watermark,
    blockers: walkForwardValidation.blockers
  },
  residualMarketWalkForward: {
    status: residualMarketWalkForward.status,
    shadowOnly: residualMarketWalkForward.shadowOnly,
    productionEligible: residualMarketWalkForward.productionEligible,
    sample: residualMarketWalkForward.sample,
    aggregate: residualMarketWalkForward.aggregate,
    blockers: residualMarketWalkForward.blockers,
    manifestHash: residualMarketWalkForward.manifestHash,
  },
  promotionEvidenceAudit: {
    summary: promotionEvidenceAudit.summary,
    manifest: promotionEvidenceAudit.manifest,
  },
  probabilityMetrics: payload.probabilityMetrics,
  marketBaseline: payload.marketBaseline,
  shadowCandidates: {
    sample: shadowCandidates.sample,
    bestCandidateId: shadowCandidates.bestCandidateId,
    bestCandidate: shadowCandidates.bestCandidate
  },
  closingLineValue: payload.closingLineValue,
  recommendationSelection: {
    version: recommendationSelection.version,
    hardMaxSp: recommendationSelection.hardMaxSp,
    before: recommendationSelection.before,
    spOnlyBaseline: recommendationSelection.spOnlyBaseline,
    after: recommendationSelection.after,
    coverage: recommendationSelection.coverage,
    highSpCandidates: recommendationSelection.highSpCandidates,
    lowSpRejected: recommendationSelection.lowSpRejected,
    hitRateDeltaVsSpOnly: recommendationSelection.hitRateDeltaVsSpOnly,
    gate: recommendationSelection.gate
  },
  recommendationTotal: payload.recommendationMetrics.total,
  riskTiers: {
    version: riskTiers.version,
    overall: riskTiers.overall,
    confidenceBucketCount: riskTiers.confidenceBuckets.bucketCount,
    recommendationBucketCount: riskTiers.recommendationBuckets.length,
    shadowRecommendationBucketCount: riskTiers.shadowRecommendationBuckets.length
  }
}, null, 2));
