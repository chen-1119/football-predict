const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");

const defaultPort = Number(process.env.PORT || 8788);
const baseUrl = new URL(process.env.VERIFY_BASE_URL || `http://127.0.0.1:${defaultPort}`);
const adminToken = process.env.ADMIN_TOKEN || "";
const accessCodeAdminToken = process.env.ACCESS_CODE_ADMIN_TOKEN || adminToken;
const startServer = process.env.VERIFY_START_SERVER === "1";
const requireSqlite = process.env.VERIFY_REQUIRE_SQLITE === "1";
const minProbabilityRows = Math.max(1, Number(process.env.VERIFY_MIN_PROBABILITY_ROWS || 1));

let child = null;
let childLogs = "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = (method, pathname, body = null, headers = {}) => {
  const target = new URL(pathname, baseUrl);
  const payload = body ? JSON.stringify(body) : "";
  const transport = target.protocol === "https:" ? https : http;
  const cleanHeaders = Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );

  return new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method,
      headers: {
        ...(payload ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        } : {}),
        ...cleanHeaders
      }
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json,
          bytes: Buffer.byteLength(raw)
        });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const runLocalJson = (args, env = {}) => new Promise((resolve) => {
  const childProcess = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  childProcess.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  childProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  childProcess.on("error", (error) => {
    resolve({ status: -1, body: null, stdout, stderr: error.message || String(error) });
  });
  childProcess.on("exit", (code) => {
    let body = null;
    try {
      body = JSON.parse(stdout);
    } catch {
      body = null;
    }
    resolve({ status: code, body, stdout, stderr });
  });
});

const refreshSqliteAfterMutableChecks = async (checks) => {
  if (!requireSqlite) return;
  const refresh = await runLocalJson(["scripts/exportDataStoreSqlite.cjs"]);
  pushCheck(checks, "sqlite refreshed after mutable checks", refresh.status === 0 && refresh.body?.ok === true, {
    status: refresh.status,
    counts: refresh.body?.counts || null,
    legacyJsonlVersion: refresh.body?.legacyJsonl?.version || null,
    stdoutTail: refresh.status === 0 ? "" : refresh.stdout.slice(-500),
    stderrTail: refresh.stderr.slice(-500)
  });
};

const startLocalServer = async () => {
  child = spawn(process.execPath, ["server/index.cjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: baseUrl.hostname,
      PORT: String(baseUrl.port || defaultPort),
      ENABLE_SYNC_CRON: process.env.VERIFY_ENABLE_SYNC_CRON === "1" ? "1" : "0",
      ENABLE_GPT_CRON: process.env.VERIFY_ENABLE_GPT_CRON === "1" ? "1" : "0",
      ...(requireSqlite && !process.env.DATASTORE_READ_SOURCE && !process.env.CURRENT_MATCH_SOURCE
        ? { DATASTORE_READ_SOURCE: "sqlite" }
        : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    childLogs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    childLogs += chunk.toString();
  });

  for (let i = 0; i < 50; i += 1) {
    await sleep(250);
    try {
      const health = await request("GET", "/api/v1/health");
      if (health.status === 200 && health.body) return;
    } catch {
      // Keep waiting until the local process is ready.
    }
    if (child.exitCode !== null) break;
  }
  throw new Error(`local server did not become ready: ${childLogs.slice(-1000)}`);
};

const stopLocalServer = () => {
  if (!child) return;
  child.kill("SIGTERM");
  setTimeout(() => child?.kill("SIGKILL"), 1500).unref();
};

const getAccessToken = async (checks) => {
  if (process.env.VERIFY_ACCESS_TOKEN) return process.env.VERIFY_ACCESS_TOKEN;
  if (process.env.VERIFY_ACCESS_CODE) {
    const verify = await request("POST", "/api/access/verify", { code: process.env.VERIFY_ACCESS_CODE });
    pushCheck(checks, "access code verify", verify.status === 200 && verify.body?.session?.token, { status: verify.status });
    return verify.body?.session?.token || "";
  }
  if (!accessCodeAdminToken) return "";

  const create = await request("POST", "/api/admin/access-codes", { label: "production-readiness-check" }, {
    authorization: `Bearer ${accessCodeAdminToken}`
  });
  pushCheck(checks, "admin bearer access-code create", create.status === 200 && create.body?.code, { status: create.status });
  if (!create.body?.code) return "";

  const verify = await request("POST", "/api/access/verify", { code: create.body.code });
  pushCheck(checks, "generated access code verify", verify.status === 200 && verify.body?.session?.token, { status: verify.status });
  return verify.body?.session?.token || "";
};

const runAccessCodeRevocationChecks = async (checks) => {
  if (!accessCodeAdminToken) return;
  const create = await request("POST", "/api/admin/access-codes", { label: "production-readiness-revoke-check" }, {
    authorization: `Bearer ${accessCodeAdminToken}`
  });
  const code = create.body?.code || "";
  const codeId = create.body?.id || "";
  pushCheck(checks, "revocation access-code create", create.status === 200 && code && codeId, {
    status: create.status,
    hasCode: Boolean(code),
    hasId: Boolean(codeId)
  });
  if (!code || !codeId) return;

  const verify = await request("POST", "/api/access/verify", { code });
  const token = verify.body?.session?.token || "";
  pushCheck(checks, "revocation access-code verify", verify.status === 200 && token, {
    status: verify.status,
    hasToken: Boolean(token)
  });
  if (!token) return;

  const statusBefore = await request("GET", "/api/access/status", null, { "x-access-token": token });
  pushCheck(checks, "revocation session initially active", statusBefore.status === 200 && statusBefore.body?.authorized === true, {
    status: statusBefore.status,
    authorized: statusBefore.body?.authorized ?? null
  });

  const revoke = await request("POST", `/api/admin/access-codes/${encodeURIComponent(codeId)}/revoke`, null, {
    authorization: `Bearer ${accessCodeAdminToken}`
  });
  pushCheck(checks, "access-code revoke", revoke.status === 200 && revoke.body?.ok === true && revoke.body?.row?.status === "revoked", {
    status: revoke.status,
    rowStatus: revoke.body?.row?.status || null
  });

  const verifyAfterRevoke = await request("POST", "/api/access/verify", { code });
  pushCheck(checks, "revoked code verify denied", verifyAfterRevoke.status === 401, {
    status: verifyAfterRevoke.status,
    error: verifyAfterRevoke.body?.error || null
  });

  const statusAfterRevoke = await request("GET", "/api/access/status", null, { "x-access-token": token });
  pushCheck(checks, "revoked session status denied", statusAfterRevoke.status === 200 && statusAfterRevoke.body?.authorized === false, {
    status: statusAfterRevoke.status,
    authorized: statusAfterRevoke.body?.authorized ?? null
  });

  const currentAfterRevoke = await request("GET", "/api/v1/matches/current?view=list", null, { "x-access-token": token });
  pushCheck(checks, "revoked session current denied", currentAfterRevoke.status === 401, {
    status: currentAfterRevoke.status
  });
};

const run = async () => {
  const checks = [];
  if (startServer) await startLocalServer();

  try {
    const runtime = await request("GET", "/data/runtime-config.json");
    pushCheck(checks, "runtime config", runtime.status === 200, {
      status: runtime.status,
      dataApiBase: runtime.body?.dataApiBase || null
    });

    const health = await request("GET", "/api/v1/health");
    const sqlite = health.body?.storage?.sqlite || null;
    pushCheck(checks, "v1 health", health.status === 200 && health.body?.apiVersion === "v1", {
      status: health.status,
      ok: health.body?.ok,
      bytes: health.bytes
    });
    pushCheck(checks, "sqlite status", !requireSqlite || (sqlite?.available && !sqlite?.stale), {
      required: requireSqlite,
      available: Boolean(sqlite?.available),
      stale: Boolean(sqlite?.stale),
      counts: sqlite?.counts || null
    });
    pushCheck(checks, "sqlite legacy jsonl import", !requireSqlite || sqlite?.legacyJsonl?.version === "legacy-jsonl-import-v1", {
      required: requireSqlite,
      version: sqlite?.legacyJsonl?.version || null,
      imported: sqlite?.legacyJsonl?.imported || null,
      legacyMatchSnapshots: sqlite?.counts?.legacyMatchSnapshots ?? null,
      files: sqlite?.legacyJsonl?.files || null
    });

    const workerStatus = await runLocalJson(["scripts/runSyncWorker.cjs", "--status"], {
      SYNC_WORKER_STATUS_ONLY: "1"
    });
    const cadence = workerStatus.body?.cadence || null;
    pushCheck(checks, "sync worker cadence", workerStatus.status === 0 && ["base", "hot"].includes(cadence?.mode) && Number(cadence?.intervalSeconds) >= 60 && Number(cadence?.workflowMinutes) >= 1, {
      status: workerStatus.status,
      mode: cadence?.mode || null,
      reason: cadence?.reason || null,
      intervalSeconds: cadence?.intervalSeconds ?? null,
      workflowMinutes: cadence?.workflowMinutes ?? null,
      hotWindowMinutes: cadence?.hotWindowMinutes ?? null,
      nextMatch: cadence?.nextMatch || null
    });

    const predictionAudit = await runLocalJson(["scripts/verifyPredictionAudit.cjs"]);
    pushCheck(checks, "prediction audit", predictionAudit.status === 0 && predictionAudit.body?.ok === true, {
      status: predictionAudit.status,
      rows: predictionAudit.body?.checks?.find((check) => check.name === "prediction snapshots available")?.rows ?? null,
      currentWithPredictions: predictionAudit.body?.checks?.find((check) => check.name === "current prediction meta audit fields")?.currentWithPredictions ?? null,
      stdoutTail: predictionAudit.status === 0 ? "" : predictionAudit.stdout.slice(-500),
      stderrTail: predictionAudit.stderr.slice(-500)
    });

    const modelPromotion = await runLocalJson(["scripts/verifyModelPromotionGate.cjs"]);
    const modelPromotionSummary = modelPromotion.body?.summary || {};
    pushCheck(checks, "model promotion artifact", modelPromotion.status === 0 && modelPromotion.body?.ok === true, {
      status: modelPromotion.status,
      gateStatus: modelPromotionSummary.gateStatus || null,
      onlineEffect: modelPromotionSummary.onlineEffect || null,
      reasons: modelPromotionSummary.reasons || [],
      stdoutTail: modelPromotion.status === 0 ? "" : modelPromotion.stdout.slice(-500),
      stderrTail: modelPromotion.stderr.slice(-500)
    });

    const llmBoundary = await runLocalJson(["scripts/verifyLlmReviewBoundary.cjs"]);
    const llmBoundarySummary = llmBoundary.body?.summary || {};
    pushCheck(checks, "llm boundary artifact", llmBoundary.status === 0 && llmBoundary.body?.ok === true, {
      status: llmBoundary.status,
      llmRows: llmBoundarySummary.llmRows ?? null,
      updatedAt: llmBoundarySummary.updatedAt || null,
      stdoutTail: llmBoundary.status === 0 ? "" : llmBoundary.stdout.slice(-500),
      stderrTail: llmBoundary.stderr.slice(-500)
    });

    const syncLock = await runLocalJson(["scripts/verifySyncLock.cjs"]);
    pushCheck(checks, "sync lock artifact", syncLock.status === 0 && syncLock.body?.ok === true, {
      status: syncLock.status,
      checks: Array.isArray(syncLock.body?.checks) ? syncLock.body.checks.length : null,
      stdoutTail: syncLock.status === 0 ? "" : syncLock.stdout.slice(-500),
      stderrTail: syncLock.stderr.slice(-500)
    });

    const deploymentConfig = await runLocalJson(["scripts/verifyDeploymentConfig.cjs"]);
    pushCheck(checks, "deployment config artifact", deploymentConfig.status === 0 && deploymentConfig.body?.ok === true, {
      status: deploymentConfig.status,
      checks: Array.isArray(deploymentConfig.body?.checks) ? deploymentConfig.body.checks.length : null,
      stdoutTail: deploymentConfig.status === 0 ? "" : deploymentConfig.stdout.slice(-500),
      stderrTail: deploymentConfig.stderr.slice(-500)
    });

    const planCoverage = await runLocalJson(["scripts/verifyProductionPlanCoverage.cjs"]);
    pushCheck(checks, "production plan coverage artifact", planCoverage.status === 0 && planCoverage.body?.ok === true, {
      status: planCoverage.status,
      phases: planCoverage.body?.summary?.phases ?? null,
      checks: planCoverage.body?.summary?.checks ?? null,
      required: planCoverage.body?.summary?.required ?? null,
      watch: planCoverage.body?.summary?.watch ?? null,
      stdoutTail: planCoverage.status === 0 ? "" : planCoverage.stdout.slice(-500),
      stderrTail: planCoverage.stderr.slice(-500)
    });

    const apiContracts = await runLocalJson(["scripts/verifyApiContracts.cjs"], {
      CONTRACT_BASE_URL: baseUrl.toString()
    });
    const apiContractSummary = apiContracts.body?.summary || {};
    pushCheck(checks, "api contract artifact", apiContracts.status === 0 && apiContracts.body?.ok === true, {
      status: apiContracts.status,
      currentRows: apiContractSummary.currentRows ?? null,
      selectedMatchId: apiContractSummary.selectedMatchId || null,
      historyMaxLimit: apiContractSummary.historyMaxLimit ?? null,
      oddsMaxLimit: apiContractSummary.oddsMaxLimit ?? null,
      stdoutTail: apiContracts.status === 0 ? "" : apiContracts.stdout.slice(-500),
      stderrTail: apiContracts.stderr.slice(-500)
    });

    const frontendObservability = await runLocalJson(["scripts/verifyFrontendObservability.cjs"], {
      FRONTEND_OBSERVABILITY_BASE_URL: baseUrl.toString(),
      FRONTEND_OBSERVABILITY_CHECK_DIST: "1"
    });
    const frontendObservabilitySummary = frontendObservability.body?.summary || {};
    pushCheck(checks, "frontend observability artifact", frontendObservability.status === 0 && frontendObservability.body?.ok === true, {
      status: frontendObservability.status,
      domContracts: frontendObservabilitySummary.domContracts ?? null,
      probabilityRows: frontendObservabilitySummary.probabilityRows ?? null,
      marketBaselineRows: frontendObservabilitySummary.marketBaselineRows ?? null,
      gateStatus: frontendObservabilitySummary.gateStatus || null,
      distChecked: frontendObservabilitySummary.distChecked ?? null,
      stdoutTail: frontendObservability.status === 0 ? "" : frontendObservability.stdout.slice(-500),
      stderrTail: frontendObservability.stderr.slice(-500)
    });

    const sourceHealth = await request("GET", "/api/v1/source-health");
    const syncMeta = await request("GET", "/api/v1/sync-meta");
    const syncMetaFallback = syncMeta.body?.fallback || null;
    const syncMetaApi = syncMeta.body?.api || null;
    pushCheck(checks, "sync-meta fallback contract", syncMeta.status === 200 && (
      !syncMetaFallback?.keptExisting
      || (syncMetaApi?.stale === true && Boolean(syncMetaApi?.freshnessTime) && Boolean(syncMeta.body?.lastAttemptAt))
    ), {
      status: syncMeta.status,
      fallback: Boolean(syncMetaFallback?.keptExisting),
      stale: syncMetaApi?.stale ?? null,
      freshnessTime: syncMetaApi?.freshnessTime || null,
      lastAttemptAt: syncMeta.body?.lastAttemptAt || null,
      reason: syncMetaFallback?.reason || syncMetaApi?.fallbackReason || null
    });
    const sourceRows = Array.isArray(sourceHealth.body?.sources)
      ? sourceHealth.body.sources
      : [];
    const sourceIds = sourceRows.length
      ? sourceRows.map((source) => source.id).filter(Boolean)
      : [];
    const requiredSourceIds = ["sporttery", "five-hundred", "weather", "pre-match"];
    const sourceScoreSummary = Object.fromEntries(sourceRows.map((source) => [source.id, {
      status: source.status,
      score: source.score,
      stale: Boolean(source.stale)
    }]));
    const sourceHealthExposesAdmin = Boolean(sourceHealth.body?.admin);
    pushCheck(checks, "source health matrix", sourceHealth.status === 200 && requiredSourceIds.every((id) => sourceIds.includes(id)) && !sourceHealthExposesAdmin, {
      status: sourceHealth.status,
      ok: sourceHealth.body?.ok,
      sourceIds,
      sourceScores: sourceScoreSummary,
      exposesAdmin: sourceHealthExposesAdmin,
      warnings: sourceHealth.body?.warnings || [],
      errors: sourceHealth.body?.errors || []
    });
    const sourceHealthAdminNoAuth = await request("GET", "/api/v1/source-health?detail=admin");
    pushCheck(checks, "source health admin no-auth denied", sourceHealthAdminNoAuth.status === 401, {
      status: sourceHealthAdminNoAuth.status
    });
    if (adminToken) {
      const sourceHealthAdminQuery = await request("GET", `/api/v1/source-health?detail=admin&token=${encodeURIComponent(adminToken)}`);
      pushCheck(checks, "source health admin query token denied", sourceHealthAdminQuery.status === 401, {
        status: sourceHealthAdminQuery.status
      });
      const sourceHealthAdmin = await request("GET", "/api/v1/source-health?detail=admin", null, {
        authorization: `Bearer ${adminToken}`
      });
      const adminPayload = sourceHealthAdmin.body?.admin || null;
      pushCheck(checks, "source health admin diagnostics", sourceHealthAdmin.status === 200 && Boolean(adminPayload?.files?.externalSignals?.path) && Boolean(adminPayload?.crawlerErrors) && Boolean(adminPayload?.taskTimings), {
        status: sourceHealthAdmin.status,
        hasFiles: Boolean(adminPayload?.files),
        hasExternalSignalsPath: Boolean(adminPayload?.files?.externalSignals?.path),
        hasCrawlerErrors: Boolean(adminPayload?.crawlerErrors),
        hasTaskTimings: Boolean(adminPayload?.taskTimings),
        workerCheckedAt: adminPayload?.taskTimings?.workerCheckedAt || null
      });
    }

    const model = await request("GET", "/api/v1/model/evaluation");
    const probabilityRows = Number(model.body?.backtest?.sample?.probabilityRows || 0);
    const marketRows = Number(model.body?.backtest?.sample?.marketBaselineRows || 0);
    const shadowCandidates = model.body?.backtest?.shadowCandidates || null;
    const requiredCandidateIds = ["market-baseline", "elo-rating-v1", "poisson-goals-v1", "historical-elo-poisson-50"];
    const promotionGate = model.body?.strategy?.activation?.promotionGate || null;
    const strategyOnlineEffect = model.body?.strategy?.activation?.onlineEffect || "";
    const publicLeaksCandidates = Array.isArray(shadowCandidates?.candidates);
    const publicLeaksStrategyRules = Boolean(model.body?.strategy?.activeGates || model.body?.strategy?.recommendations);
    pushCheck(checks, "model evaluation", model.status === 200 && probabilityRows >= minProbabilityRows, {
      status: model.status,
      version: model.body?.backtest?.version || null,
      probabilityRows,
      marketBaselineRows: marketRows,
      minProbabilityRows
    });
    pushCheck(checks, "model evaluation public redaction", model.status === 200 && model.body?.publicView === true && !publicLeaksCandidates && !publicLeaksStrategyRules, {
      status: model.status,
      publicView: model.body?.publicView ?? null,
      leaksCandidates: publicLeaksCandidates,
      leaksStrategyRules: publicLeaksStrategyRules,
      hiddenFields: model.body?.hiddenFields || []
    });
    pushCheck(checks, "model promotion gate", promotionGate && (promotionGate.status !== "shadow" || strategyOnlineEffect === "shadow"), {
      status: promotionGate?.status || null,
      onlineEffect: strategyOnlineEffect || null,
      rollingSource: promotionGate?.metrics?.rollingSource || null,
      rollingPassRate: promotionGate?.metrics?.rollingPassRate ?? null,
      reasons: promotionGate?.reasons || []
    });
    pushCheck(checks, "shadow candidates", Boolean(shadowCandidates?.bestCandidateId && shadowCandidates?.sample?.rows > 0), {
      version: shadowCandidates?.version || null,
      rows: shadowCandidates?.sample?.rows || 0,
      bestCandidateId: shadowCandidates?.bestCandidateId || null,
      bestRole: shadowCandidates?.bestCandidate?.role || null,
      rollingPassRate: shadowCandidates?.bestCandidate?.rolling?.passRate ?? null,
      rollingWindows: shadowCandidates?.bestCandidate?.rolling?.windows ?? 0,
      candidateListPublic: Array.isArray(shadowCandidates?.candidates)
    });
    const modelAdminNoAuth = await request("GET", "/api/v1/model/evaluation?detail=admin");
    pushCheck(checks, "model evaluation admin no-auth denied", modelAdminNoAuth.status === 401, {
      status: modelAdminNoAuth.status
    });
    if (adminToken) {
      const modelAdminQuery = await request("GET", `/api/v1/model/evaluation?detail=admin&token=${encodeURIComponent(adminToken)}`);
      pushCheck(checks, "model evaluation admin query token denied", modelAdminQuery.status === 401, {
        status: modelAdminQuery.status
      });
      const modelAdmin = await request("GET", "/api/v1/model/evaluation?detail=admin", null, {
        authorization: `Bearer ${adminToken}`
      });
      const adminShadowCandidates = modelAdmin.body?.backtest?.shadowCandidates || null;
      const candidateIds = Array.isArray(adminShadowCandidates?.candidates)
        ? adminShadowCandidates.candidates.map((candidate) => candidate.id).filter(Boolean)
        : [];
      pushCheck(checks, "model evaluation admin diagnostics", modelAdmin.status === 200 && modelAdmin.body?.admin?.includesInternalCandidates === true && candidateIds.length > 0, {
        status: modelAdmin.status,
        includesInternalCandidates: modelAdmin.body?.admin?.includesInternalCandidates ?? null,
        includesStrategyRules: modelAdmin.body?.admin?.includesStrategyRules ?? null,
        candidateCount: candidateIds.length
      });
      pushCheck(checks, "historical model candidates", requiredCandidateIds.every((id) => candidateIds.includes(id)), {
        requiredCandidateIds,
        present: requiredCandidateIds.filter((id) => candidateIds.includes(id)),
        missing: requiredCandidateIds.filter((id) => !candidateIds.includes(id))
      });
    }

    const dbNoAuth = await request("GET", "/api/db/status");
    pushCheck(checks, "db no-auth denied", dbNoAuth.status === 401, { status: dbNoAuth.status });

    const historyStatic = await request("GET", "/data/matches-history.json");
    pushCheck(checks, "large history static disabled", historyStatic.status === 410, { status: historyStatic.status });

    const currentStatic = await request("GET", "/data/matches-current.json");
    pushCheck(checks, "current static disabled", currentStatic.status === 410, { status: currentStatic.status });

    const rootMatchesStatic = await request("GET", "/matches.json");
    pushCheck(checks, "root matches static disabled", rootMatchesStatic.status === 410, { status: rootMatchesStatic.status });

    const modelStatic = await request("GET", "/data/model-calibration.json");
    pushCheck(checks, "model detail static disabled", modelStatic.status === 410, { status: modelStatic.status });

    if (accessCodeAdminToken) {
      const queryAdmin = await request("POST", `/api/admin/access-codes?token=${encodeURIComponent(accessCodeAdminToken)}`, {
        label: "query-token-must-fail"
      });
      pushCheck(checks, "access-code admin query token denied", queryAdmin.status === 401, { status: queryAdmin.status });
      await runAccessCodeRevocationChecks(checks);
    }

    if (adminToken) {
      const syncQueryAdmin = await request("POST", `/api/admin/sync?token=${encodeURIComponent(adminToken)}`);
      pushCheck(checks, "sync admin query token denied", syncQueryAdmin.status === 401, { status: syncQueryAdmin.status });

      const modelQueryAdmin = await request("POST", `/api/admin/model/run?token=${encodeURIComponent(adminToken)}`, { limit: 1 });
      pushCheck(checks, "model admin query token denied", modelQueryAdmin.status === 401, { status: modelQueryAdmin.status });

      const dbQueryAdmin = await request("GET", `/api/db/status?token=${encodeURIComponent(adminToken)}`);
      pushCheck(checks, "db query token denied", dbQueryAdmin.status === 401, { status: dbQueryAdmin.status });

      const dbBearerAdmin = await request("GET", "/api/db/status", null, {
        authorization: `Bearer ${adminToken}`
      });
      pushCheck(checks, "db bearer admin allowed", dbBearerAdmin.status === 200 && dbBearerAdmin.body?.ok === true, {
        status: dbBearerAdmin.status,
        current: dbBearerAdmin.body?.counts?.current || null,
        history: dbBearerAdmin.body?.counts?.history || null
      });

      const llmRun = await request("POST", "/api/admin/model/run", { limit: 1 }, {
        authorization: `Bearer ${adminToken}`
      });
      const llmRows = Array.isArray(llmRun.body?.payload?.rows) ? llmRun.body.payload.rows : [];
      const llmRow = llmRows[0] || null;
      const llmReview = llmRow?.llmReview || null;
      const deniedFields = llmReview?.audit?.deniedOutputFields || [];
      pushCheck(checks, "llm review boundary", llmRun.status === 200 && (
        (Boolean(llmReview)
          && llmReview.audit?.canOverrideProbabilities === false
          && llmReview.audit?.canOverrideRecommendationDirection === false
          && llmReview.audit?.generatedBeforeCutoff === true)
        || (Number(llmRun.body?.generated || 0) === 0 && Number(llmRun.body?.skippedAfterCutoff || 0) >= 0)
      ), {
        status: llmRun.status,
        generated: llmRun.body?.generated ?? null,
        skippedAfterCutoff: llmRun.body?.skippedAfterCutoff ?? null,
        removedInvalidRows: llmRun.body?.removedInvalidRows ?? null,
        reviewRole: llmReview?.reviewRole || null,
        promptVersion: llmReview?.audit?.promptVersion || null,
        canOverrideProbabilities: llmReview?.audit?.canOverrideProbabilities ?? null,
        canOverrideRecommendationDirection: llmReview?.audit?.canOverrideRecommendationDirection ?? null,
        generatedBeforeCutoff: llmReview?.audit?.generatedBeforeCutoff ?? null,
        deniedOutputFields: deniedFields
      });
    }

    await refreshSqliteAfterMutableChecks(checks);

    const currentNoAuth = await request("GET", "/api/v1/matches/current?view=list");
    pushCheck(checks, "current no-auth denied", currentNoAuth.status === 401, { status: currentNoAuth.status });

    const accessToken = await getAccessToken(checks);
    const accessHeaders = accessToken ? { "x-access-token": accessToken } : {};
    pushCheck(checks, "access token available", Boolean(accessToken), { provided: Boolean(accessToken) });

    const current = await request("GET", "/api/v1/matches/current?view=list", null, accessHeaders);
    const currentRows = Array.isArray(current.body?.rows) ? current.body.rows : [];
    const exposesRawLlmRelay = currentRows.some((row) => row?.gptPrediction?.relay);
    const exposesHeavyCurrentListFields = currentRows.some((row) => (
      row?.probabilityModel?.calculationTrace
      || row?.probabilityModel?.basis
      || row?.predictionMeta?.analystFramework
      || row?.predictionMeta?.dataPolicy
      || row?.externalSignals?.fiveHundred?.recentForm?.home?.rows
      || row?.externalSignals?.fiveHundred?.europeOdds?.rows
      || row?.externalSignals?.fiveHundred?.asianHandicap?.rows
    ));
    const currentAvgBytesPerRow = currentRows.length ? Math.round(current.bytes / currentRows.length) : current.bytes;
    pushCheck(checks, "current matches", current.status === 200 && currentRows.length > 0 && !exposesRawLlmRelay, {
      status: current.status,
      rows: currentRows.length,
      dataSource: current.body?.dataSource || null,
      version: current.body?.version || null,
      exposesRawLlmRelay
    });
    const currentReadSource = current.body?.currentRead?.source || current.body?.dataSource || null;
    pushCheck(checks, "current read source", !requireSqlite || currentReadSource === "sqlite", {
      requiredSqlite: requireSqlite,
      dataSource: current.body?.dataSource || null,
      currentReadSource,
      dbUpdatedAt: current.body?.currentRead?.dbUpdatedAt || null,
      fileUpdatedAt: current.body?.currentRead?.fileUpdatedAt || null
    });
    pushCheck(checks, "current list compact payload", current.status === 200 && currentRows.length > 0 && !exposesHeavyCurrentListFields && currentAvgBytesPerRow <= 20000, {
      status: current.status,
      bytes: current.bytes,
      rows: currentRows.length,
      avgBytesPerRow: currentAvgBytesPerRow,
      exposesHeavyCurrentListFields
    });
    const currentEtag = current.headers?.etag || "";
    const currentNotModified = currentEtag
      ? await request("GET", "/api/v1/matches/current?view=list", null, { ...accessHeaders, "if-none-match": currentEtag })
      : { status: 0, body: null };
    pushCheck(checks, "current etag not-modified", currentNotModified.status === 304, {
      status: currentNotModified.status,
      etagPresent: Boolean(currentEtag),
      bytes: currentNotModified.bytes
    });

    const history = await request("GET", "/api/v1/matches/history?limit=5", null, accessHeaders);
    const historyRows = Array.isArray(history.body?.rows) ? history.body.rows : [];
    pushCheck(checks, "history page", history.status === 200 && historyRows.length > 0 && (!requireSqlite || history.body?.source === "sqlite"), {
      status: history.status,
      rows: historyRows.length,
      source: history.body?.source || null,
      dbUpdatedAt: history.body?.dbUpdatedAt || null,
      hasMore: Boolean(history.body?.pageInfo?.hasMore)
    });

    const matchId = currentRows[0]?.id || historyRows[0]?.id || "";
    const detail = matchId
      ? await request("GET", `/api/v1/matches/${encodeURIComponent(matchId)}`, null, accessHeaders)
      : { status: 0, body: null };
    pushCheck(checks, "match detail", detail.status === 200 && detail.body?.match?.id, {
      status: detail.status,
      matchId: detail.body?.match?.id || null,
      hasPredictionLock: Boolean(detail.body?.predictionLock)
    });
    const detailEtag = detail.headers?.etag || "";
    const detailNotModified = matchId && detailEtag
      ? await request("GET", `/api/v1/matches/${encodeURIComponent(matchId)}`, null, { ...accessHeaders, "if-none-match": detailEtag })
      : { status: 0, body: null };
    pushCheck(checks, "match detail etag not-modified", detailNotModified.status === 304, {
      status: detailNotModified.status,
      etagPresent: Boolean(detailEtag),
      bytes: detailNotModified.bytes
    });

    const odds = matchId
      ? await request("GET", `/api/v1/odds/history?matchId=${encodeURIComponent(matchId)}&limit=5`, null, accessHeaders)
      : { status: 0, body: null };
    pushCheck(checks, "odds page", odds.status === 200 && Array.isArray(odds.body?.rows), {
      status: odds.status,
      source: odds.body?.source || null,
      rows: Array.isArray(odds.body?.rows) ? odds.body.rows.length : 0
    });

    const ok = checks.every((check) => check.ok);
    const payload = {
      ok,
      checkedAt: new Date().toISOString(),
      baseUrl: baseUrl.toString().replace(/\/$/, ""),
      checks
    };
    console.log(JSON.stringify(payload, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    stopLocalServer();
  }
};

run().catch((error) => {
  stopLocalServer();
  console.error(error.stack || String(error));
  process.exit(1);
});
