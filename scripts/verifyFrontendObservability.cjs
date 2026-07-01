const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

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

const fileMissingInDist = (relativePath) => !fs.existsSync(path.join(distDir, relativePath));

const run = async () => {
  const checks = [];
  const appContext = readText("src/context/AppContext.tsx");
  const appContextCore = readText("src/context/AppContextCore.ts");
  const predictionsList = readText("src/pages/PredictionsList.tsx");
  const css = readText("src/index.css");
  const viteConfig = readText("vite.config.ts");
  const stripLargeStaticPayloads = readText("scripts/stripLargeStaticPayloads.cjs");
  const modelEvaluation = readJson(path.join(publicDataDir, "model-evaluation.json"));
  const modelStrategy = readJson(path.join(publicDataDir, "model-strategy.json"));
  const modelCalibration = readJson(path.join(publicDataDir, "model-calibration.json"));

  pushCheck(checks, "v1 frontend fetch wiring", [
    "apiBaseRef.current || '/api/v1'",
    "fetchModelEvaluation",
    "dataUrls('/model/evaluation'",
    "dataUrls('/source-health'",
    "dataUrls('/matches/current?view=list', [])",
    "if-none-match"
  ].every((needle) => appContext.includes(needle)), {
    hasModelFetch: appContext.includes("fetchModelEvaluation"),
    usesV1Base: appContext.includes("apiBaseRef.current || '/api/v1'"),
    hasConditionalFetch: appContext.includes("if-none-match")
  });

  pushCheck(checks, "data sync dom contract", [
    'data-testid="data-sync-strip"',
    "data-source-version",
    "data-source-stale",
    "data-source-health-ok",
    "data-model-version"
  ].every((needle) => predictionsList.includes(needle)), {
    hasSourceVersion: predictionsList.includes("data-source-version"),
    hasStaleFlag: predictionsList.includes("data-source-stale")
  });

  pushCheck(checks, "source health dom contract", [
    'data-testid="source-health-panel"',
    "data-source-health-ok",
    "data-source-health-checked-at",
    "data-source-health-fallback"
  ].every((needle) => predictionsList.includes(needle)), {
    hasCheckedAt: predictionsList.includes("data-source-health-checked-at"),
    hasFallbackFlag: predictionsList.includes("data-source-health-fallback")
  });

  pushCheck(checks, "model governance dom contract", [
    'data-testid="model-governance-panel"',
    "data-model-version",
    "data-model-online-effect",
    "data-model-gate-status",
    "data-model-baseline-rows",
    "modelGovernanceItems"
  ].every((needle) => predictionsList.includes(needle)), {
    hasGateStatus: predictionsList.includes("data-model-gate-status"),
    hasBaselineRows: predictionsList.includes("data-model-baseline-rows")
  });

  pushCheck(checks, "frontend data sync type coverage", [
    "modelEvaluation?:",
    "sourceHealth?:",
    "sources?: Array",
    "sourceScores?: Record",
    "promotionGate?:",
    "llmRole?:"
  ].every((needle) => appContextCore.includes(needle)), {
    typedModelEvaluation: appContextCore.includes("modelEvaluation?:"),
    typedSourceMatrix: appContextCore.includes("sources?: Array")
  });

  pushCheck(checks, "model governance responsive css", [
    ".model-governance-panel",
    ".model-governance-grid",
    "@media (max-width: 520px)",
    "overflow-wrap: anywhere"
  ].every((needle) => css.includes(needle)), {
    hasPanelCss: css.includes(".model-governance-panel"),
    hasSmallScreenWrap: css.includes("overflow-wrap: anywhere")
  });

  pushCheck(checks, "large static payload strip list", [
    "data/matches-current.json",
    "data/matches-history.json",
    "data/odds-history.json",
    "data/prediction-snapshots.json",
    "data/model-calibration.json",
    "data/model-strategy.json",
    "data/gpt-predictions.json"
  ].every((needle) => stripLargeStaticPayloads.includes(needle)), {
    protectedFiles: [
      "data/matches-current.json",
      "data/matches-history.json",
      "data/model-strategy.json",
      "data/gpt-predictions.json"
    ].filter((needle) => stripLargeStaticPayloads.includes(needle))
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
    const forbiddenDistFiles = [
      "matches.json",
      "data/matches-current.json",
      "data/matches-history.json",
      "data/odds-history.json",
      "data/model-calibration.json",
      "data/model-strategy.json",
      "data/gpt-predictions.json"
    ];
    const present = forbiddenDistFiles.filter((relativePath) => !fileMissingInDist(relativePath));
    pushCheck(checks, "dist large static payloads absent", distExists && present.length === 0, {
      distExists,
      present,
      checked: forbiddenDistFiles.length
    });
  }

  const evaluationRows = Number(modelEvaluation?.sample?.probabilityRows || 0);
  const marketRows = Number(modelEvaluation?.sample?.marketBaselineRows || modelEvaluation?.marketBaseline?.metrics?.rows || 0);
  const strategyGate = modelStrategy?.activation?.promotionGate || null;
  pushCheck(checks, "local model artifacts", Boolean(
    modelEvaluation?.ok
    && evaluationRows > 0
    && marketRows > 0
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
    bestCandidateId: modelEvaluation?.shadowCandidates?.bestCandidateId || null,
    gateStatus: strategyGate?.status || null,
    onlineEffect: modelStrategy?.activation?.onlineEffect || null
  });

  if (baseUrl) {
    const model = await request("/api/v1/model/evaluation");
    const sourceHealth = await request("/api/v1/source-health");
    const health = await request("/api/v1/health");
    const apiGate = model?.body?.strategy?.activation?.promotionGate || null;
    const apiSourceRows = Array.isArray(sourceHealth?.body?.sources) ? sourceHealth.body.sources : [];

    pushCheck(checks, "api model evaluation for frontend", model?.status === 200 && Boolean(
      model.body?.apiVersion === "v1"
      && model.body?.strategy?.version
      && apiGate?.status
      && model.body?.backtest?.sample?.marketBaselineRows > 0
      && String(model.body?.policy?.llmRole || "").includes("risk review")
    ), {
      status: model?.status || null,
      apiVersion: model?.body?.apiVersion || null,
      strategyVersion: model?.body?.strategy?.version || null,
      gateStatus: apiGate?.status || null,
      onlineEffect: model?.body?.strategy?.activation?.onlineEffect || null,
      marketBaselineRows: model?.body?.backtest?.sample?.marketBaselineRows ?? null
    });

    pushCheck(checks, "api source health for frontend", sourceHealth?.status === 200 && apiSourceRows.length >= 4 && !sourceHealth.body?.admin, {
      status: sourceHealth?.status || null,
      ok: sourceHealth?.body?.ok ?? null,
      checkedAt: sourceHealth?.body?.checkedAt || null,
      sourceIds: apiSourceRows.map((source) => source.id).filter(Boolean),
      exposesAdmin: Boolean(sourceHealth?.body?.admin)
    });

    pushCheck(checks, "api health exposes freshness and model", health?.status === 200 && Boolean(
      health.body?.apiVersion === "v1"
      && health.body?.data?.updatedAt
      && health.body?.model
    ), {
      status: health?.status || null,
      apiVersion: health?.body?.apiVersion || null,
      dataUpdatedAt: health?.body?.data?.updatedAt || null,
      strategyVersion: health?.body?.model?.strategyVersion || null
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
