const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const {
  publicHhadCompanionSchemaValid,
  isNonNegativeInteger
} = require("./hhadCompanionPublicContract.cjs");
const {
  ALLOWED_STATIC_DATA_JSON,
  inspectStaticDistData
} = require("./staticDistDataPolicy.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const distDir = path.join(rootDir, "dist");
const baseUrlInput = process.env.FRONTEND_OBSERVABILITY_BASE_URL || process.env.VERIFY_BASE_URL || "";
const baseUrl = baseUrlInput ? new URL(baseUrlInput) : null;
const checkDist = process.env.FRONTEND_OBSERVABILITY_CHECK_DIST === "1";

const readText = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), "utf8");

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const request = (pathname) => {
  if (!baseUrl) return Promise.resolve(null);
  const target = new URL(pathname, baseUrl);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method: "GET" }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          bytes: Buffer.byteLength(raw)
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const run = async () => {
  const checks = [];
  const appContext = readText("src/context/AppContext.tsx");
  const appContextCore = readText("src/context/AppContextCore.ts");
  const appShell = readText("src/App.tsx");
  const predictionsList = readText("src/pages/PredictionsList.tsx");
  const matchDetail = readText("src/pages/MatchDetail.tsx");
  const runtimeUrls = readText("src/services/runtimeUrls.ts");
  const css = readText("src/index.css");
  const viteConfig = readText("vite.config.ts");
  const stripLargeStaticPayloads = readText("scripts/stripLargeStaticPayloads.cjs");
  const modelEvaluation = readJson(path.join(publicDataDir, "model-evaluation.json"));
  const modelStrategy = readJson(path.join(publicDataDir, "model-strategy.json"));
  const modelCalibration = readJson(path.join(publicDataDir, "model-calibration.json"));

  pushCheck(checks, "v1 frontend fetch wiring", [
    "apiBaseRef.current || '/api/v1'",
    "fetchPublicHealth",
    "dataUrls('/health'",
    "fetchModelEvaluation",
    "dataUrls('/model/evaluation'",
    "dataUrls('/source-health'",
    "matches/current?view=list",
    "if-none-match"
  ].every((needle) => appContext.includes(needle)), {
    hasModelFetch: appContext.includes("fetchModelEvaluation"),
    usesV1Base: appContext.includes("apiBaseRef.current || '/api/v1'"),
    hasConditionalFetch: appContext.includes("if-none-match")
  });

  pushCheck(checks, "diagnostic and history polling is bounded independently from current fixtures", [
    "const SYNC_META_REFRESH_MS = 30 * 1000",
    "const SOURCE_HEALTH_REFRESH_MS = 60 * 1000",
    "const PUBLIC_HEALTH_REFRESH_MS = 60 * 1000",
    "const MODEL_EVALUATION_REFRESH_MS = 5 * 60 * 1000",
    "const HISTORY_REFRESH_MS = 5 * 60 * 1000",
    "const diagnosticDue = (",
    "diagnosticDue('syncMeta', SYNC_META_REFRESH_MS)",
    "diagnosticDue('sourceHealth', SOURCE_HEALTH_REFRESH_MS)",
    "diagnosticDue('modelEvaluation', MODEL_EVALUATION_REFRESH_MS)",
    "diagnosticDue('publicHealth', PUBLIC_HEALTH_REFRESH_MS)"
  ].every((needle) => appContext.includes(needle)), {
    currentPollSeconds: 15,
    sourceHealthPollSeconds: 60,
    modelEvaluationPollSeconds: 300,
    historyPollSeconds: 300
  });

  pushCheck(checks, "data sync dom contract", [
    'data-testid="data-sync-strip"',
    "data-source-version",
    "data-source-stale",
    "data-source-health-ok",
    "data-recommendation-reliable",
    "data-fallback-within-window",
    "data-fallback-age-seconds",
    "data-model-version"
  ].every((needle) => predictionsList.includes(needle)), {
    hasSourceVersion: predictionsList.includes("data-source-version"),
    hasStaleFlag: predictionsList.includes("data-source-stale"),
    hasRecommendationReliable: predictionsList.includes("data-recommendation-reliable"),
    hasFallbackWindow: predictionsList.includes("data-fallback-within-window")
  });

  pushCheck(checks, "source health dom contract", [
    'data-testid="source-health-panel"',
    "data-source-health-ok",
    "data-source-health-checked-at",
    "data-source-health-fallback",
    "data-source-serving-mode",
    "data-fallback-within-window",
    "data-fallback-age-seconds",
    "Reliability window",
    "data-sporttery-egress-status",
    "data-sporttery-egress-waf",
    "sportteryEgressStatusLabel",
    "data-sporttery-relay-current-fresh",
    "data-sporttery-relay-current-rows",
    "data-sporttery-sync-meta-current-stale",
    "data-sporttery-relay-partial",
    "Current lane",
    "Paged crawl"
  ].every((needle) => predictionsList.includes(needle)), {
    hasCheckedAt: predictionsList.includes("data-source-health-checked-at"),
    hasFallbackFlag: predictionsList.includes("data-source-health-fallback"),
    hasServingMode: predictionsList.includes("data-source-serving-mode"),
    hasSportteryEgress: predictionsList.includes("data-sporttery-egress-status")
  });

  pushCheck(checks, "model governance dom contract", [
    'data-testid="model-governance-panel"',
    "data-model-version",
    "data-model-online-effect",
    "data-model-gate-status",
    "data-model-evaluation-ok",
    "data-model-evaluation-coverage-ok",
    "data-model-odds-coverage",
    "data-model-prediction-coverage",
    "data-model-baseline-rows",
    "data-model-input-audit-ok",
    "data-model-input-audit-violations",
    "data-model-risk-tier",
    "data-model-risk-reasons",
    "data-model-scorecard-version",
    "data-model-public-scorecard",
    "data-model-scorecard-has-formal-sample",
    "data-model-formal-recommendation-rows",
    "data-model-market-buckets",
    "data-model-league-buckets",
    "data-model-odds-buckets",
    "data-model-probability-architecture",
    "data-model-source-policy",
    "data-hhad-companion-status",
    "data-hhad-companion-paired-rows",
    "data-hhad-companion-candidate-ready",
    "data-hhad-companion-online-effect",
    "hhadCompanionAvailable",
    "hhadCompanionUiStatus",
    "gate-not-passed",
    "Evaluation unavailable",
    "hhadCompanionMetricNote",
    "data-five-hundred-cutover-allowed",
    "data-five-hundred-coverage",
    "model-probability-stack",
    "model-source-policy",
    "probabilityStackItems",
    "sourcePolicyItems",
    "modelGovernanceItems"
  ].every((needle) => predictionsList.includes(needle)), {
    hasGateStatus: predictionsList.includes("data-model-gate-status"),
    hasBaselineRows: predictionsList.includes("data-model-baseline-rows"),
    hasInputAudit: predictionsList.includes("data-model-input-audit-ok"),
    hasRiskTier: predictionsList.includes("data-model-risk-tier"),
    hasScorecard: predictionsList.includes("data-model-scorecard-version"),
    hasHhadCompanion: predictionsList.includes("data-hhad-companion-status"),
    hasProbabilityStack: predictionsList.includes("model-probability-stack"),
    hasSourcePolicy: predictionsList.includes("model-source-policy")
  });

  const unsafeDetailProbabilityReads = [
    ...matchDetail.matchAll(/(^|[^?])\.goalLines\.(over25|under25)/g),
    ...matchDetail.matchAll(/(^|[^?])\.bothTeamsToScore\.(yes|no)/g),
    ...matchDetail.matchAll(/(^|[^?])\.(before|after)\.(over25|under25)/g)
  ].map((match) => match[0].trim());
  pushCheck(checks, "match detail probability resilience", unsafeDetailProbabilityReads.length === 0 && [
    "normalizeProbabilityModel",
    "model.goalLines?.over25",
    "model.bothTeamsToScore?.yes",
    "formatProbabilityValue(probabilityModel.goalLines?.over25)",
    "calibrationAdjustment.goals?.before?.over25"
  ].every((needle) => matchDetail.includes(needle)), {
    unsafeReads: unsafeDetailProbabilityReads,
    hasNormalizer: matchDetail.includes("normalizeProbabilityModel"),
    safeGoalLinesRead: matchDetail.includes("model.goalLines?.over25"),
    safeBttsRead: matchDetail.includes("model.bothTeamsToScore?.yes")
  });

  pushCheck(checks, "route error boundary refreshes stale match detail runtime errors", [
    "isLikelyStaleMatchDetailRuntimeError",
    "isRecoverableRouteError",
    "Cannot read (?:properties|property) of (?:undefined|null)",
    "over25|under25|bttsYes|bttsNo|goalLines|bothTeamsToScore|probabilities",
    "exactTop3|projectedScore|tipLabel|summary",
    "__assetReload",
    "window.location.replace",
    "window.addEventListener('unhandledrejection'",
    "reloadForFreshAssets()",
    "recoveryState: reloadStarted ? 'reloading' : 'blocked'",
    "this.state.recoveryState !== 'blocked'",
    "window.sessionStorage.removeItem(ASSET_RELOAD_STORAGE_KEY)",
    "if (reloadForFreshAssets()) event.preventDefault()"
  ].every((needle) => appShell.includes(needle)), {
    hasStaleModelGuard: appShell.includes("isLikelyStaleMatchDetailRuntimeError"),
    hasRecoverableGuard: appShell.includes("isRecoverableRouteError"),
    handlesUnhandledRejection: appShell.includes("window.addEventListener('unhandledrejection'"),
    reusesFreshAssetReload: appShell.includes("reloadForFreshAssets()"),
    cacheBustsRecovery: appShell.includes("__assetReload") && appShell.includes("window.location.replace"),
    hasThrottledRecoveryFallback: appShell.includes("recoveryState: reloadStarted ? 'reloading' : 'blocked'")
      && appShell.includes("this.state.recoveryState !== 'blocked'"),
    retryClearsThrottle: appShell.includes("window.sessionStorage.removeItem(ASSET_RELOAD_STORAGE_KEY)"),
    preventsDefaultOnlyWhenReloadStarts: appShell.includes("if (reloadForFreshAssets()) event.preventDefault()")
  });

  pushCheck(checks, "match detail v1 api url compatibility", [
    "buildApiUrl(`/api/v1/matches/${encodeURIComponent(matchId)}`)",
    "import.meta.env.DEV",
    "apiBase.endsWith('/api/v1')",
    "normalizedEndpoint.startsWith('/api/v1/')",
    "normalizedEndpoint.slice('/api/v1'.length)"
  ].every((needle) => matchDetail.includes(needle) || runtimeUrls.includes(needle)), {
    detailUsesV1Api: matchDetail.includes("buildApiUrl(`/api/v1/matches/${encodeURIComponent(matchId)}`)"),
    runtimeDedupesApiV1: runtimeUrls.includes("apiBase.endsWith('/api/v1')"),
    localApiRedirectDevOnly: runtimeUrls.includes("!import.meta.env.DEV")
  });

  pushCheck(checks, "match detail navigation latency contract", [
    "detailNavigationMs",
    "detailNavigationDataMs",
    "detailNavigationDataStatus",
    "detailNavigationDataSource",
    "detailNavigationInteractiveMs",
    "detailNavigationInteractiveStatus",
    "clearDetailNavigationMetrics(matchId)",
    "'data', 'failed'",
    "'interactive', 'failed'",
    "window.cancelAnimationFrame(frameId)"
  ].every((needle) => matchDetail.includes(needle)), {
    hasShellMetric: matchDetail.includes("detailNavigationMs"),
    hasDataMetric: matchDetail.includes("detailNavigationDataMs"),
    hasInteractiveMetric: matchDetail.includes("detailNavigationInteractiveMs"),
    hasFailureState: matchDetail.includes("'data', 'failed'")
      && matchDetail.includes("'interactive', 'failed'"),
    clearsRouteMetrics: matchDetail.includes("clearDetailNavigationMetrics(matchId)")
  });

  pushCheck(checks, "match detail fetch timeout and fallback contract", [
    "PRIMARY_DETAIL_FETCH_TIMEOUT_MS = 4_500",
    "FALLBACK_DETAIL_FETCH_TIMEOUT_MS = 3_500",
    "fetchDetailWithTimeout",
    "DetailFetchTimeoutError",
    "source: 'v1'",
    "source: 'legacy-fallback'",
    "maxAttempts: 2",
    "maxAttempts: 1",
    "requestController.abort()",
    "parentSignal.removeEventListener('abort', abortFromParent)"
  ].every((needle) => matchDetail.includes(needle)), {
    hasIndependentAbortController: matchDetail.includes("const requestController = new AbortController()"),
    hasPrimaryTimeout: matchDetail.includes("PRIMARY_DETAIL_FETCH_TIMEOUT_MS"),
    hasLegacyFallback: matchDetail.includes("source: 'legacy-fallback'")
  });

  pushCheck(checks, "frontend data sync type coverage", [
    "modelHealth?:",
    "modelEvaluation?:",
    "sourceHealthSummary?:",
    "sourceHealth?:",
    "fallbackWithinReliableWindow?:",
    "fallbackAgeSeconds?:",
    "fallbackMaxAgeSeconds?:",
    "recommendationReliable?:",
    "coverageRatio?:",
    "sportteryEgress?:",
    "wafBlocked?: boolean",
    "sources?: Array",
    "sourceScores?: Record",
    "relayCurrentFresh?:",
    "relayCurrentRows?:",
    "resultLane?:",
    "relayResultFresh?:",
    "relayResultRows?:",
    "relayResultFreshnessTime?:",
    "syncMetaCurrentStale?:",
    "promotionGate?:",
    "probabilityArchitecture?:",
    "sourcePolicy?:",
    "llmRole?:",
    "inputAudit?:",
    "riskTiers?:"
  ].every((needle) => appContextCore.includes(needle)), {
    typedModelEvaluation: appContextCore.includes("modelEvaluation?:"),
    typedSourceMatrix: appContextCore.includes("sources?: Array"),
    typedSportteryEgress: appContextCore.includes("sportteryEgress?:"),
    typedSportteryRelayCurrent: appContextCore.includes("relayCurrentFresh?:"),
    typedSportteryRelayResult: appContextCore.includes("relayResultFresh?:")
  });

  pushCheck(checks, "model governance responsive css", [
    ".model-governance-panel",
    ".model-governance-grid",
    ".model-probability-grid",
    ".model-source-policy-grid",
    "@media (max-width: 520px)",
    "overflow-wrap: anywhere"
  ].every((needle) => css.includes(needle)), {
    hasPanelCss: css.includes(".model-governance-panel"),
    hasProbabilityStackCss: css.includes(".model-probability-grid"),
    hasSourcePolicyCss: css.includes(".model-source-policy-grid"),
    hasSmallScreenWrap: css.includes("overflow-wrap: anywhere")
  });

  pushCheck(checks, "static data allowlist policy", (
    ALLOWED_STATIC_DATA_JSON.length === 1
    && ALLOWED_STATIC_DATA_JSON[0] === "data/runtime-config.json"
    && stripLargeStaticPayloads.includes('require("./staticDistDataPolicy.cjs")')
    && stripLargeStaticPayloads.includes("assertStaticDistDataPolicy(resolvedDistDir)")
  ), {
    allowedFiles: ALLOWED_STATIC_DATA_JSON
  });

  pushCheck(checks, "vite public copy filter", [
    "publicDir: false",
    "copyFilteredPublicAssets",
    "largeStaticPayloads",
    "blocked.has(relativePath)"
  ].every((needle) => viteConfig.includes(needle)), {
    publicDirDisabled: viteConfig.includes("publicDir: false"),
    hasFilteredCopy: viteConfig.includes("copyFilteredPublicAssets")
  });

  const distExists = fs.existsSync(distDir);
  if (checkDist) {
    const staticDistData = inspectStaticDistData(distDir);
    pushCheck(checks, "dist static data allowlist enforced", staticDistData.ok, {
      distExists,
      allowed: staticDistData.allowed,
      artifacts: staticDistData.artifacts,
      unapproved: staticDistData.unapproved,
      missingRequired: staticDistData.missingRequired
    });
  }

  const evaluationRows = Number(modelEvaluation?.sample?.probabilityRows || 0);
  const marketRows = Number(modelEvaluation?.sample?.marketBaselineRows || modelEvaluation?.marketBaseline?.metrics?.rows || 0);
  const strategyGate = modelStrategy?.activation?.promotionGate || null;
  const inputAudit = modelEvaluation?.inputAudit || null;
  const riskTiers = modelEvaluation?.riskTiers || null;
  pushCheck(checks, "local model artifacts", Boolean(
    modelEvaluation?.ok
    && evaluationRows > 0
    && marketRows > 0
    && inputAudit?.ok === true
    && riskTiers?.version === "model-risk-tier-v1"
    && riskTiers?.overall?.tier
    && modelEvaluation?.shadowCandidates?.bestCandidateId
    && modelCalibration?.version
    && modelStrategy?.version
    && strategyGate?.status
  ), {
    evaluationVersion: modelEvaluation?.version || null,
    strategyVersion: modelStrategy?.version || null,
    calibrationVersion: modelCalibration?.version || null,
    probabilityRows: evaluationRows,
    marketBaselineRows: marketRows,
    inputAuditOk: inputAudit?.ok ?? null,
    inputAuditViolationCount: inputAudit?.violationCount ?? null,
    riskTier: riskTiers?.overall?.tier || null,
    maxCalibrationError: riskTiers?.confidenceBuckets?.maxCalibrationError ?? null,
    bestCandidateId: modelEvaluation?.shadowCandidates?.bestCandidateId || null,
    gateStatus: strategyGate?.status || null,
    onlineEffect: modelStrategy?.activation?.onlineEffect || null
  });

  if (baseUrl) {
    const model = await request("/api/v1/model/evaluation");
    const sourceHealth = await request("/api/v1/source-health");
    const health = await request("/api/v1/health");
    const apiGate = model?.body?.strategy?.activation?.promotionGate || null;
    const apiScorecard = model?.body?.publicScorecard || null;
    const apiHhadCompanion = apiScorecard?.shadowTracks?.HHAD_COMPANION || null;
    const apiInputAudit = model?.body?.backtest?.inputAudit || null;
    const apiRiskTiers = model?.body?.backtest?.riskTiers || null;
    const apiSourceRows = Array.isArray(sourceHealth?.body?.sources) ? sourceHealth.body.sources : [];

    pushCheck(checks, "api model evaluation for frontend", model?.status === 200 && Boolean(
      model.body?.apiVersion === "v1"
      && model.body?.strategy?.version
      && apiGate?.status
      && apiScorecard?.version === "public-model-scorecard-v2"
      && apiScorecard?.buckets?.scope === "formal-recommendations-only"
      && apiScorecard?.sample?.formalRecommendationRows === apiScorecard?.sample?.predictionRows
      && Array.isArray(apiScorecard?.buckets?.markets)
      && Array.isArray(apiScorecard?.buckets?.leagues)
      && Array.isArray(apiScorecard?.buckets?.odds)
      && apiHhadCompanion?.publicView === true
      && apiHhadCompanion?.onlineEffect === "shadow"
      && apiHhadCompanion?.promotionAllowed === false
      && publicHhadCompanionSchemaValid(apiHhadCompanion)
      && isNonNegativeInteger(apiHhadCompanion?.counts?.pairedNonVoidRows)
      && Array.isArray(apiHhadCompanion?.gate?.failedChecks)
      && apiInputAudit?.ok === true
      && apiRiskTiers?.version === "model-risk-tier-v1"
      && apiRiskTiers?.overall?.tier
      && model.body?.backtest?.sample?.marketBaselineRows > 0
      && String(model.body?.policy?.llmRole || "").includes("risk review")
    ), {
      status: model?.status || null,
      apiVersion: model?.body?.apiVersion || null,
      strategyVersion: model?.body?.strategy?.version || null,
      gateStatus: apiGate?.status || null,
      onlineEffect: model?.body?.strategy?.activation?.onlineEffect || null,
      scorecardVersion: apiScorecard?.version || null,
      formalRecommendationRows: apiScorecard?.sample?.formalRecommendationRows ?? null,
      marketBuckets: apiScorecard?.buckets?.markets?.length ?? null,
      leagueBuckets: apiScorecard?.buckets?.leagues?.length ?? null,
      oddsBuckets: apiScorecard?.buckets?.odds?.length ?? null,
      marketBaselineRows: model?.body?.backtest?.sample?.marketBaselineRows ?? null,
      inputAuditOk: apiInputAudit?.ok ?? null,
      inputAuditViolationCount: apiInputAudit?.violationCount ?? null,
      riskTier: apiRiskTiers?.overall?.tier || null,
      maxCalibrationError: apiRiskTiers?.confidenceBuckets?.maxCalibrationError ?? null
    });

    const apiSportteryEgress = sourceHealth?.body?.sportteryEgress || null;
    pushCheck(checks, "api source health for frontend", sourceHealth?.status === 200 && apiSourceRows.length >= 4 && Boolean(apiSportteryEgress) && !sourceHealth.body?.admin && !sourceHealth.body?.sportteryEgressRaw, {
      status: sourceHealth?.status || null,
      ok: sourceHealth?.body?.ok ?? null,
      checkedAt: sourceHealth?.body?.checkedAt || null,
      sourceIds: apiSourceRows.map((source) => source.id).filter(Boolean),
      sportteryEgressStatus: apiSportteryEgress?.status || null,
      sportteryEgressOk: apiSportteryEgress?.ok ?? null,
      sportteryEgressWaf: apiSportteryEgress?.summary?.wafBlocked ?? null,
      exposesAdmin: Boolean(sourceHealth?.body?.admin),
      exposesRawEgress: Boolean(sourceHealth?.body?.sportteryEgressRaw)
    });

    const apiFallbackCoverage = sourceHealth?.body?.fallbackCoverage || {};
    const apiSporttery = apiSourceRows.find((source) => source?.id === "sporttery") || null;
    pushCheck(checks, "api source health relay lane fields", sourceHealth?.status === 200
      && Object.prototype.hasOwnProperty.call(apiFallbackCoverage, "relayCurrentFresh")
      && Object.prototype.hasOwnProperty.call(apiFallbackCoverage, "syncMetaCurrentStale")
      && Object.prototype.hasOwnProperty.call(apiFallbackCoverage, "resultLane")
      && Object.prototype.hasOwnProperty.call(apiFallbackCoverage, "relayResultFresh")
      && Object.prototype.hasOwnProperty.call(apiFallbackCoverage, "relayResultRows")
      && Object.prototype.hasOwnProperty.call(apiFallbackCoverage, "relayResultFreshnessTime")
      && Object.prototype.hasOwnProperty.call(apiSporttery?.metrics || {}, "relayCurrentFresh")
      && Object.prototype.hasOwnProperty.call(apiSporttery?.metrics || {}, "resultLane")
      && Object.prototype.hasOwnProperty.call(apiSporttery?.metrics || {}, "relayResultFresh"), {
      status: sourceHealth?.status || null,
      relayCurrentFresh: apiFallbackCoverage.relayCurrentFresh ?? null,
      relayCurrentRows: apiFallbackCoverage.relayCurrentRows ?? null,
      relayResultFresh: apiFallbackCoverage.relayResultFresh ?? null,
      relayResultRows: apiFallbackCoverage.relayResultRows ?? null,
      relayResultFreshnessTime: apiFallbackCoverage.relayResultFreshnessTime ?? null,
      syncMetaCurrentStale: apiFallbackCoverage.syncMetaCurrentStale ?? null,
      sourceMetricRelayCurrentFresh: apiSporttery?.metrics?.relayCurrentFresh ?? null,
      sourceMetricRelayResultFresh: apiSporttery?.metrics?.relayResultFresh ?? null
    });

    const healthModelEvaluation = health?.body?.model?.evaluation || null;
    const healthStatus = health?.body?.status || {};
    const healthEvaluationStateIsExplicit = typeof healthModelEvaluation?.ok === "boolean"
      && typeof healthModelEvaluation?.coverageOk === "boolean"
      && typeof healthStatus.recommendationReliable === "boolean";
    const healthEvaluationStateIsConsistent = healthStatus.modelEvaluationFresh === healthModelEvaluation?.ok
      && healthStatus.modelEvaluationCoverageOk === healthModelEvaluation?.coverageOk
      && healthStatus.modelRiskStable === (healthModelEvaluation?.riskTier === "stable");
    pushCheck(checks, "api health exposes freshness and model", health?.status === 200 && Boolean(
      health.body?.apiVersion === "v1"
      && health.body?.data?.updatedAt
      && health.body?.model
      && healthEvaluationStateIsExplicit
      && healthEvaluationStateIsConsistent
      && Object.prototype.hasOwnProperty.call(health.body?.status || {}, "fallbackWithinReliableWindow")
      && ["stable", "watch", "degraded"].includes(healthModelEvaluation?.riskTier)
    ), {
      status: health?.status || null,
      apiVersion: health?.body?.apiVersion || null,
      dataUpdatedAt: health?.body?.data?.updatedAt || null,
      strategyVersion: health?.body?.model?.strategyVersion || null,
      modelEvaluationOk: healthModelEvaluation?.ok ?? null,
      modelEvaluationCoverageOk: healthModelEvaluation?.coverageOk ?? null,
      modelRiskTier: healthModelEvaluation?.riskTier || null,
      stateConsistent: healthEvaluationStateIsConsistent,
      recommendationReliable: health.body?.status?.recommendationReliable ?? null,
      fallbackWithinReliableWindow: health.body?.status?.fallbackWithinReliableWindow ?? null,
      fallbackAgeSeconds: health.body?.status?.fallbackAgeSeconds ?? null,
      oddsCoverage: healthModelEvaluation?.odds?.coverageRatio ?? null,
      predictionCoverage: healthModelEvaluation?.predictionSnapshots?.coverageRatio ?? null
    });
  }

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    baseUrl: baseUrl ? baseUrl.toString().replace(/\/$/, "") : null,
    summary: {
      domContracts: checks.filter((check) => check.name.includes("dom contract")).every((check) => check.ok),
      probabilityRows: evaluationRows,
      marketBaselineRows: marketRows,
      riskTier: riskTiers?.overall?.tier || null,
      gateStatus: strategyGate?.status || null,
      distChecked: checkDist && distExists
    },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    baseUrl: baseUrl ? baseUrl.toString().replace(/\/$/, "") : null,
    error: error.stack || String(error)
  }, null, 2));
  process.exitCode = 1;
});
