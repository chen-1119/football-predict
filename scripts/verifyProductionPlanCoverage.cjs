const fs = require("node:fs");
const path = require("node:path");
const { getSqliteStatus } = require("../server/sqliteStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const storeDir = process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data");
const sqliteDbPath = process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db");

const readText = (filePath) => {
  try {
    return fs.readFileSync(path.join(rootDir, filePath), "utf8");
  } catch {
    return "";
  }
};

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, filePath), "utf8"));
  } catch {
    return fallback;
  }
};

const hasAll = (text, needles) => needles.every((needle) => text.includes(needle));

const checks = [];
const watch = [];

const pushCheck = (phase, name, ok, evidence = {}, required = true) => {
  checks.push({ phase, name, required, ok: Boolean(ok), evidence });
};

const pushWatch = (phase, name, details = {}) => {
  watch.push({ phase, name, ...details });
};

const packageJson = readJson("package.json", { scripts: {} });
const scripts = packageJson.scripts || {};
const serverIndex = readText("server/index.cjs");
const sqliteStore = readText("server/sqliteStore.cjs");
const sqliteExporter = readText("scripts/exportDataStoreSqlite.cjs");
const syncWorker = readText("scripts/runSyncWorker.cjs");
const nginx = readText("deploy/light-server/nginx.conf");
const workerService = readText("deploy/light-server/football-sync-worker.service");
const viteConfig = readText("vite.config.ts");
const appContext = readText("src/context/AppContext.tsx");
const appContextCore = readText("src/context/AppContextCore.ts");
const predictionsList = readText("src/pages/PredictionsList.tsx");
const modelBacktest = readText("scripts/runModelBacktest.cjs");
const modelStrategy = readText("scripts/optimizePredictionStrategy.cjs");
const verifyProduction = readText("scripts/verifyProductionReadiness.cjs");
const verifyApiContracts = readText("scripts/verifyApiContracts.cjs");
const verifyFrontend = readText("scripts/verifyFrontendObservability.cjs");
const verifyPerf = readText("scripts/verifyApiPerformance.cjs");
const verifyFallback = readText("scripts/verifySourceFallback.cjs");
const verifyLlm = readText("scripts/verifyLlmReviewBoundary.cjs");
const verifyAudit = readText("scripts/verifyPredictionAudit.cjs");
const modelEvaluation = readJson(path.join("public", "data", "model-evaluation.json"), null);
const publicStrategy = readJson(path.join("public", "data", "model-strategy.json"), null);
const syncMeta = readJson(path.join("public", "data", "sync-meta.json"), null);
const runtimeConfig = readJson(path.join("public", "data", "runtime-config.json"), null);

const requiredScripts = [
  "datastore:sqlite",
  "sync:worker",
  "model:backtest",
  "optimize:strategy",
  "verify:prediction-audit",
  "verify:model-promotion",
  "verify:llm-boundary",
  "verify:sync-lock",
  "verify:api-contracts",
  "verify:frontend-observability",
  "verify:deployment-config",
  "verify:source-fallback",
  "verify:production",
  "verify:perf"
];

(async () => {
  const sqliteStatus = await getSqliteStatus(sqliteDbPath);

  pushCheck("01-security-boundary", "versioned v1 public API routes", hasAll(serverIndex, [
    '"/api/v1/health"',
    '"/api/v1/source-health"',
    '"/api/v1/model/evaluation"',
    '"/api/v1/matches/current"',
    '"/api/v1/matches/history"',
    '"/api/v1/odds/history"'
  ]), { file: "server/index.cjs" });

  pushCheck("01-security-boundary", "protected recommendation reads", hasAll(serverIndex, [
    "isProtectedApiPath",
    'pathname === "/api/v1/matches/current"',
    'pathname === "/api/v1/matches/history"',
    'pathname === "/api/v1/odds/history"',
    "hasRecommendationAccess"
  ]), { file: "server/index.cjs" });

  pushCheck("01-security-boundary", "admin bearer only and query token denied by tests", hasAll(serverIndex, [
    "auth.toLowerCase().startsWith(\"bearer \")",
    "safeSecretEqual(bearer, adminToken)",
    "safeSecretEqual(bearer, accessCodeAdminToken)"
  ]) && hasAll(verifyProduction, [
    "sync admin query token denied",
    "model admin query token denied",
    "db query token denied",
    "access-code admin query token denied"
  ]), { files: ["server/index.cjs", "scripts/verifyProductionReadiness.cjs"] });

  pushCheck("01-security-boundary", "public model evaluation is redacted", hasAll(serverIndex, [
    "compactShadowCandidates",
    "compactStrategyForPublic",
    "hiddenFields"
  ]) && hasAll(verifyApiContracts, [
    "model-evaluation public redaction",
    "model-evaluation admin requires bearer",
    "model-evaluation query token denied"
  ]), { files: ["server/index.cjs", "scripts/verifyApiContracts.cjs"] });

  pushCheck("02-data-warehouse-sync", "SQLite WAL schema has four snapshot tables", hasAll(sqliteExporter, [
    "PRAGMA journal_mode = WAL",
    "CREATE TABLE IF NOT EXISTS source_snapshots",
    "CREATE TABLE IF NOT EXISTS match_snapshots",
    "CREATE TABLE IF NOT EXISTS odds_snapshots",
    "CREATE TABLE IF NOT EXISTS prediction_snapshots"
  ]), { file: "scripts/exportDataStoreSqlite.cjs" });

  pushCheck("02-data-warehouse-sync", "legacy JSONL import is preserved", hasAll(sqliteExporter, [
    "legacy-jsonl-import-v1",
    "readJsonlTail",
    "legacy_jsonl_import",
    "jsonl-match",
    "jsonl-odds",
    "jsonl-prediction"
  ]) && sqliteStatus.legacyJsonl?.version === "legacy-jsonl-import-v1", {
    file: "scripts/exportDataStoreSqlite.cjs",
    sqliteLegacyJsonl: sqliteStatus.legacyJsonl?.version || null,
    imported: sqliteStatus.legacyJsonl?.imported || null
  });

  pushCheck("02-data-warehouse-sync", "server reads from SQLite with fallback visibility", hasAll(sqliteStore, [
    "readSqliteCurrentMatches",
    "readSqliteHistoryMatchesForList",
    "readSqliteMatchById",
    "readSqliteOddsHistoryRows",
    "legacyJsonl"
  ]) && hasAll(serverIndex, [
    "shouldPreferSqliteRead",
    "sqliteFreshEnough",
    "file-sqlite-stale"
  ]), { files: ["server/sqliteStore.cjs", "server/index.cjs"] });

  pushCheck("02-data-warehouse-sync", "split sync worker has hot cadence, lock, and SQLite export", hasAll(syncWorker, [
    "HOT_SYNC_INTERVAL_SECONDS",
    "HOT_SYNC_WINDOW_MINUTES",
    "acquireSyncLock",
    "sqliteExportEnabled",
    "datastore:sqlite"
  ]) && hasAll(workerService, [
    "SYNC_WORKER_LOOP=1",
    "DATASTORE_READ_SOURCE=sqlite",
    "ENABLE_SQLITE_EXPORT=1"
  ]), { files: ["scripts/runSyncWorker.cjs", "deploy/light-server/football-sync-worker.service"] });

  pushCheck("02-data-warehouse-sync", "SQLite runtime counts are non-empty", sqliteStatus.available === true
    && Number(sqliteStatus.counts?.currentMatches || 0) > 0
    && Number(sqliteStatus.counts?.historyMatches || 0) > 0
    && Number(sqliteStatus.counts?.oddsSnapshots || 0) > 0
    && Number(sqliteStatus.counts?.predictionSnapshots || 0) > 0, {
      dbPath: sqliteStatus.path,
      counts: sqliteStatus.counts
    });

  pushCheck("03-large-payload-concurrency", "large static payloads are disabled and stripped from dist", hasAll(serverIndex, [
    "disabledLargeStaticPayloads",
    "large static payload disabled"
  ]) && hasAll(viteConfig, [
    "publicDir: false",
    "copyFilteredPublicAssets",
    "stripLargeStaticPayloads"
  ]) && hasAll(verifyFrontend, [
    "dist large static payloads absent",
    "vite public copy filter"
  ]), { files: ["server/index.cjs", "vite.config.ts", "scripts/verifyFrontendObservability.cjs"] });

  pushCheck("03-large-payload-concurrency", "v1 reads use ETag and short TTL caches", hasAll(serverIndex, [
    "sendJsonCached",
    "if-none-match",
    "v1CurrentPayloadCache",
    "v1HistoryPayloadCache",
    "v1MatchPayloadCache"
  ]) && hasAll(verifyProduction, [
    "current etag not-modified",
    "match detail etag not-modified",
    "current list compact payload"
  ]), { files: ["server/index.cjs", "scripts/verifyProductionReadiness.cjs"] });

  pushCheck("03-large-payload-concurrency", "Nginx has static cache, no-store runtime, and rate limits", hasAll(nginx, [
    "limit_req_zone",
    "gzip on",
    "immutable",
    "runtime-config.json",
    "no-store",
    "limit_req zone=football_api",
    "limit_req zone=football_admin"
  ]), { file: "deploy/light-server/nginx.conf" });

  pushCheck("03-large-payload-concurrency", "performance smoke gate exists", hasAll(verifyPerf, [
    "maxP95Ms",
    "maxErrorRate",
    "/api/v1/matches/current?view=list",
    "/api/v1/matches/history?limit=50"
  ]) && Boolean(scripts["verify:perf"]), { file: "scripts/verifyApiPerformance.cjs" });

  pushCheck("04-model-backtest-calibration", "time-ordered rolling backtest and leakage guards", hasAll(modelBacktest, [
    "summarizeRollingWindows",
    "marketBaseline",
    "closingLineValue",
    "shadowCandidates",
    "leakageGuard",
    "snapshot?.phase === \"review\""
  ]), { file: "scripts/runModelBacktest.cjs" });

  pushCheck("04-model-backtest-calibration", "market, Elo, Poisson, and historical blend candidates exist", hasAll(modelBacktest, [
    "market-baseline",
    "elo-rating-v1",
    "poisson-goals-v1",
    "historical-elo-poisson-50",
    "Historical Elo 1X2 rating",
    "Historical Poisson goal distribution"
  ]), { file: "scripts/runModelBacktest.cjs" });

  pushCheck("04-model-backtest-calibration", "promotion gate keeps weak models in shadow", hasAll(modelStrategy, [
    "PROMOTION_MIN_BASELINE_ROWS",
    "PROMOTION_MIN_LOG_LOSS_IMPROVEMENT",
    "PROMOTION_MIN_BRIER_IMPROVEMENT",
    "onlineEffect",
    "shadow"
  ]) && publicStrategy?.activation?.promotionGate?.status, {
    file: "scripts/optimizePredictionStrategy.cjs",
    gateStatus: publicStrategy?.activation?.promotionGate?.status || null,
    onlineEffect: publicStrategy?.activation?.onlineEffect || null
  });

  pushCheck("04-model-backtest-calibration", "public model artifacts have baseline samples", Number(modelEvaluation?.sample?.probabilityRows || 0) > 0
    && Number(modelEvaluation?.sample?.marketBaselineRows || 0) > 0
    && Boolean(modelEvaluation?.shadowCandidates?.bestCandidateId), {
      file: "public/data/model-evaluation.json",
      probabilityRows: modelEvaluation?.sample?.probabilityRows || 0,
      marketBaselineRows: modelEvaluation?.sample?.marketBaselineRows || 0,
      bestCandidateId: modelEvaluation?.shadowCandidates?.bestCandidateId || null
    });

  pushWatch("04-model-backtest-calibration", "accuracy improvement is still gated", {
    currentGateStatus: publicStrategy?.activation?.promotionGate?.status || null,
    reasons: publicStrategy?.activation?.promotionGate?.reasons || [],
    note: "This is expected until enough baseline rows and non-negative Brier/log-loss improvements are observed."
  });

  pushCheck("05-hybrid-review-cutoff", "LLM is limited to risk review and explanation", hasAll(serverIndex, [
    "llm-risk-review-v1",
    "riskReview",
    "tierAdjustment",
    "canOverrideProbabilities",
    "canOverrideRecommendationDirection"
  ]) && hasAll(verifyLlm, [
    "llm review boundary audit fields",
    "llm review source prediction signature"
  ]), { files: ["server/index.cjs", "scripts/verifyLlmReviewBoundary.cjs"] });

  pushCheck("05-hybrid-review-cutoff", "post-cutoff predictions are locked and audited", hasAll(serverIndex, [
    "llmReviewWindowOpen",
    "generatedBeforeCutoff",
    "predictionAuditSignature"
  ]) && hasAll(verifyAudit, [
    "cutoffTime",
    "featureSnapshot",
    "featureSnapshotHash",
    "locked predictions keep snapshot signature",
    "backtest leakage guard excludes review snapshots"
  ]), { files: ["server/index.cjs", "scripts/verifyPredictionAudit.cjs"] });

  pushCheck("05-hybrid-review-cutoff", "source fallback keeps stale data instead of empty publishes", hasAll(verifyFallback, [
    "source-fallback",
    "fallback keeps current data",
    "fallback keeps history data",
    "fallback meta marked stale",
    "fallback sqlite remains readable",
    "fallback v1 current served from sqlite",
    "fallback v1 current marked stale",
    "/api/v1/matches/current?view=list"
  ]) && hasAll(serverIndex, [
    "publicSourceHealth",
    "getAdminSourceHealth",
    "stale"
  ]), { files: ["scripts/verifySourceFallback.cjs", "server/index.cjs"] });

  pushCheck("06-c-end-release-experience", "frontend consumes v1 APIs and exposes observability DOM contracts", hasAll(appContext, [
    "apiBaseRef.current || '/api/v1'",
    "dataUrls('/matches/current?view=list'",
    "dataUrls('/source-health'",
    "dataUrls('/model/evaluation'"
  ]) && hasAll(predictionsList, [
    'data-testid="data-sync-strip"',
    'data-testid="source-health-panel"',
    'data-testid="model-governance-panel"'
  ]) && hasAll(appContextCore, [
    "modelEvaluation?:",
    "sourceHealth?:"
  ]), { files: ["src/context/AppContext.tsx", "src/pages/PredictionsList.tsx", "src/context/AppContextCore.ts"] });

  pushCheck("06-c-end-release-experience", "runtime config and local protected preview exist", runtimeConfig?.dataApiBase === "/api/v1"
    && Boolean(scripts["preview:server"])
    && fs.existsSync(path.join(rootDir, "scripts", "startLocalPreview.cjs")), {
      runtimeDataApiBase: runtimeConfig?.dataApiBase || null,
      script: "preview:server"
    });

  pushCheck("06-c-end-release-experience", "production readiness aggregates required gates", requiredScripts.every((name) => Boolean(scripts[name]))
    && hasAll(verifyProduction, [
      "prediction audit",
      "model promotion artifact",
      "llm boundary artifact",
      "deployment config artifact",
      "api contract artifact",
      "frontend observability artifact",
      "sqlite legacy jsonl import"
    ]), {
      requiredScripts,
      missingScripts: requiredScripts.filter((name) => !scripts[name])
    });

  pushCheck("06-c-end-release-experience", "sync meta exposes source fallback and current freshness", Boolean(syncMeta?.updatedAt || syncMeta?.capturedAt)
    && Boolean(syncMeta?.api)
    && Boolean(syncMeta?.sourceHealth || syncMeta?.sourceAttempt || syncMeta?.sourceFallback || syncMeta?.fallback), {
      file: "public/data/sync-meta.json",
      updatedAt: syncMeta?.updatedAt || syncMeta?.capturedAt || null,
      stale: syncMeta?.api?.stale ?? null,
      fallback: Boolean(syncMeta?.api?.fallback || syncMeta?.sourceFallback || syncMeta?.fallback?.keptExisting)
    }, false);

  const requiredChecks = checks.filter((check) => check.required);
  const failed = requiredChecks.filter((check) => !check.ok);
  const phaseSummary = Object.fromEntries(
    Array.from(new Set(checks.map((check) => check.phase))).map((phase) => {
      const phaseChecks = checks.filter((check) => check.phase === phase);
      const requiredPhaseChecks = phaseChecks.filter((check) => check.required);
      return [phase, {
        ok: requiredPhaseChecks.every((check) => check.ok),
        passed: phaseChecks.filter((check) => check.ok).length,
        total: phaseChecks.length,
        required: requiredPhaseChecks.length
      }];
    })
  );

  const ok = failed.length === 0;
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    summary: {
      phases: Object.keys(phaseSummary).length,
      checks: checks.length,
      required: requiredChecks.length,
      failed: failed.length,
      watch: watch.length
    },
    phaseSummary,
    checks,
    watch
  }, null, 2));
  if (!ok) process.exitCode = 1;
})().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message || String(error)
  }, null, 2));
  process.exit(1);
});
