const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const {
  publicHhadCompanionSchemaValid,
  findHhadCompanionSensitiveKeyLeaks,
  isNonNegativeInteger
} = require("./hhadCompanionPublicContract.cjs");
const { publicLiveRecommendationSummary } = require("../server/publicSyncMeta.cjs");
const { compactPredictionSnapshotAudit } = require("../server/predictionSnapshotAudit.cjs");
const {
  verifyCompactDualMarketDecisionBinding,
} = require("../src/services/dualMarketDecisionBinding.cjs");

const defaultPort = Number(process.env.PORT || 8788);
const explicitBaseUrl = process.env.CONTRACT_BASE_URL || process.env.VERIFY_BASE_URL || "";
const baseUrl = new URL(explicitBaseUrl || `http://127.0.0.1:${defaultPort}`);
const requestTimeoutMs = Math.max(1_000, Number(process.env.CONTRACT_REQUEST_TIMEOUT_MS || 15_000));
const shouldAutoStartLocalServer = !explicitBaseUrl && process.env.CONTRACT_START_SERVER !== "0";
const startServer = process.env.CONTRACT_START_SERVER === "1" || shouldAutoStartLocalServer;
const localAdminToken = "api-contract-local-admin";
const adminToken = process.env.ADMIN_TOKEN || (startServer ? localAdminToken : "");
const accessCodeAdminToken = process.env.ACCESS_CODE_ADMIN_TOKEN || adminToken;

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
    req.setTimeout(requestTimeoutMs, () => {
      req.destroy(new Error(`request timed out after ${requestTimeoutMs}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const hasTrustedOfficialResultProvenance = (row) => {
  const provenance = row?.resultProvenance;
  return Boolean(
    provenance?.official === true
    && provenance?.trusted === true
    && (
      provenance?.provider === "sporttery"
      || (
        provenance?.provider === "uefa"
        && provenance?.source === "uefa:official-match-api"
        && provenance?.sourceKind === "official-competition-organizer"
        && provenance?.scoreKind === "regular-time"
        && provenance?.resultObservationFallback === false
      )
      || (
        provenance?.provider === "official-club"
        && provenance?.source === "official-club:result-page"
        && provenance?.sourceKind === "official-club-result-page"
        && provenance?.scoreKind === "regular-time"
        && provenance?.resultObservationFallback === false
        && provenance?.promotionEligible === false
        && /^https:\/\/(?:www\.aikfotboll\.se|www\.rbk\.no)\//i.test(
          String(provenance?.sourceUrl || "")
        )
      )
    )
  );
};

const collectHistoryPages = async (firstResponse, headers = {}, maxPages = 250) => {
  const rows = [];
  const issues = [];
  const seenCursors = new Set();
  const seenRowIds = new Set();
  let response = firstResponse;
  let pageCount = 0;
  let terminalPageReached = false;
  let expectedRevisionToken = null;
  let expectedVersion = null;
  let expectedTotalAvailable = null;

  while (response && pageCount < maxPages) {
    pageCount += 1;
    const body = response.body;
    const pageRows = Array.isArray(body?.rows) ? body.rows : null;
    const pageInfo = body?.pageInfo;
    if (response.status !== 200 || body?.apiVersion !== "v1" || !pageRows || !pageInfo) {
      issues.push(`page ${pageCount} has an invalid response contract`);
      break;
    }

    const revisionToken = body.revisionToken;
    const totalAvailable = pageInfo.totalAvailable;
    if (pageCount === 1) {
      expectedRevisionToken = revisionToken;
      expectedVersion = body.version || null;
      expectedTotalAvailable = totalAvailable;
    } else {
      if (revisionToken !== expectedRevisionToken) issues.push(`page ${pageCount} changed revisionToken`);
      if ((body.version || null) !== expectedVersion) issues.push(`page ${pageCount} changed version`);
      if (totalAvailable !== expectedTotalAvailable) issues.push(`page ${pageCount} changed totalAvailable`);
    }

    if (typeof revisionToken !== "number" || !Number.isSafeInteger(revisionToken) || revisionToken < 0) {
      issues.push(`page ${pageCount} has an invalid revisionToken`);
    }
    if (!Number.isFinite(Date.parse(body.version || ""))) {
      issues.push(`page ${pageCount} has an invalid version`);
    }
    if (typeof totalAvailable !== "number" || !Number.isSafeInteger(totalAvailable) || totalAvailable < 0) {
      issues.push(`page ${pageCount} has an invalid totalAvailable`);
    }
    if (pageInfo.limit !== 200) {
      issues.push(`page ${pageCount} did not preserve the 200-row limit`);
    }
    if (typeof pageInfo.count !== "number" || !Number.isSafeInteger(pageInfo.count)
      || pageInfo.count < 0 || pageInfo.count !== pageRows.length) {
      issues.push(`page ${pageCount} count does not match its rows`);
    }
    if (typeof pageInfo.hasMore !== "boolean") {
      issues.push(`page ${pageCount} has a non-boolean hasMore flag`);
    }

    for (const row of pageRows) {
      const rowId = String(row?.id || "").trim();
      if (!rowId) {
        issues.push(`page ${pageCount} contains a row without an id`);
      } else if (seenRowIds.has(rowId)) {
        issues.push(`page ${pageCount} repeats row ${rowId}`);
      } else {
        seenRowIds.add(rowId);
      }
      rows.push(row);
    }

    if (pageInfo.hasMore === true && pageRows.length === 0) {
      issues.push(`page ${pageCount} cannot make progress while hasMore is true`);
      break;
    }
    if (pageInfo.hasMore !== true) {
      terminalPageReached = true;
      if (pageInfo.nextCursor !== null) issues.push(`page ${pageCount} exposes a terminal nextCursor`);
      break;
    }

    const nextCursor = String(pageInfo.nextCursor || "").trim();
    if (!nextCursor) {
      issues.push(`page ${pageCount} is missing nextCursor while hasMore is true`);
      break;
    }
    if (seenCursors.has(nextCursor)) {
      issues.push(`page ${pageCount} repeats nextCursor`);
      break;
    }
    seenCursors.add(nextCursor);
    try {
      response = await request(
        "GET",
        `/api/v1/matches/history?limit=200&cursor=${encodeURIComponent(nextCursor)}`,
        null,
        headers
      );
    } catch (error) {
      issues.push(`page ${pageCount + 1} request failed: ${error.message || String(error)}`);
      break;
    }
  }

  if (!terminalPageReached) {
    issues.push(pageCount >= maxPages
      ? `history pagination exceeded ${maxPages} pages`
      : "history pagination did not reach a terminal page");
  }
  if (Number.isSafeInteger(expectedTotalAvailable) && rows.length !== expectedTotalAvailable) {
    issues.push(`collected ${rows.length} rows but totalAvailable is ${expectedTotalAvailable}`);
  }

  return {
    ok: issues.length === 0,
    rows,
    pageCount,
    totalAvailable: Number.isSafeInteger(expectedTotalAvailable) ? expectedTotalAvailable : null,
    revisionToken: Number.isSafeInteger(expectedRevisionToken) ? expectedRevisionToken : null,
    version: expectedVersion,
    issues: issues.slice(0, 20),
  };
};

const findPublicPathLeaks = (value, location = "$", leaks = []) => {
  if (leaks.length >= 12) return leaks;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findPublicPathLeaks(item, `${location}[${index}]`, leaks));
    return leaks;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nested]) => {
      const nextLocation = `${location}.${key}`;
      if (/path/i.test(key)) {
        leaks.push({ location: nextLocation, reason: "path-like key" });
      }
      findPublicPathLeaks(nested, nextLocation, leaks);
    });
    return leaks;
  }
  if (typeof value === "string" && /([A-Za-z]:[\\/]|\/var\/lib\/|\/opt\/football-predict|\\Users\\)/.test(value)) {
    leaks.push({ location, reason: "path-like value" });
  }
  return leaks;
};

const startLocalServer = async () => {
  child = spawn(process.execPath, ["server/index.cjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: baseUrl.hostname,
      PORT: String(baseUrl.port || defaultPort),
      ENABLE_SYNC_CRON: "0",
      ENABLE_GPT_CRON: "0",
      ADMIN_TOKEN: process.env.ADMIN_TOKEN || adminToken,
      ACCESS_CODE_ADMIN_TOKEN: process.env.ACCESS_CODE_ADMIN_TOKEN || accessCodeAdminToken,
      DATASTORE_READ_SOURCE: process.env.DATASTORE_READ_SOURCE || "sqlite",
      // Exercise upgrade safety: an old deployment may still export the former
      // 8-row bridge value, which the server must clamp to batch-safe capacity.
      CURRENT_TRANSITION_ROW_LIMIT: process.env.CURRENT_TRANSITION_ROW_LIMIT || "8"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    childLogs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    childLogs += chunk.toString();
  });

  for (let index = 0; index < 50; index += 1) {
    await sleep(250);
    try {
      const health = await request("GET", "/api/v1/health");
      if (health.status === 200 && health.body) return;
    } catch {
      // Keep waiting for the server to bind the port.
    }
    if (child.exitCode !== null) break;
  }
  throw new Error(`contract server did not become ready: ${childLogs.slice(-1000)}`);
};

const stopLocalServer = () => {
  if (!child) return;
  child.kill("SIGTERM");
  setTimeout(() => child?.kill("SIGKILL"), 1500).unref();
};

const getAccessToken = async (checks) => {
  if (process.env.CONTRACT_ACCESS_TOKEN) return process.env.CONTRACT_ACCESS_TOKEN;
  if (process.env.CONTRACT_ACCESS_CODE) {
    const verify = await request("POST", "/api/access/verify", { code: process.env.CONTRACT_ACCESS_CODE });
    pushCheck(checks, "contract access code verify", verify.status === 200 && verify.body?.session?.token, {
      status: verify.status
    });
    return verify.body?.session?.token || "";
  }
  if (!accessCodeAdminToken) return "";

  const create = await request("POST", "/api/admin/access-codes", { label: "api-contract-check" }, {
    authorization: `Bearer ${accessCodeAdminToken}`
  });
  pushCheck(checks, "contract access-code create", create.status === 200 && create.body?.code, {
    status: create.status
  });
  if (!create.body?.code) return "";

  const verify = await request("POST", "/api/access/verify", { code: create.body.code });
  pushCheck(checks, "contract generated code verify", verify.status === 200 && verify.body?.session?.token, {
    status: verify.status
  });
  return verify.body?.session?.token || "";
};

const hasHeavyListFields = (row) => Boolean(
  row?.probabilityModel?.calculationTrace
  || row?.probabilityModel?.basis
  || row?.predictionMeta?.analystFramework
  || row?.predictionMeta?.dataPolicy
  || row?.gptPrediction?.relay
  || row?.externalSignals?.fiveHundred?.recentForm?.home?.rows
);

const allowedCurrentListLiveRecommendationFields = new Set([
  "version",
  "eligible",
  "statisticsTrack",
  "dataCoverageWarning"
]);

const currentListPayloadCompactionIssues = (row) => {
  const issues = [];
  if (Object.prototype.hasOwnProperty.call(row?.probabilityModel || {}, "modelHealth")) {
    issues.push("probabilityModel.modelHealth");
  }
  for (const prediction of Array.isArray(row?.predictions) ? row.predictions : []) {
    const recommendation = prediction?.liveRecommendation;
    if (!recommendation || typeof recommendation !== "object") continue;
    for (const key of Object.keys(recommendation)) {
      if (!allowedCurrentListLiveRecommendationFields.has(key)) {
        issues.push(`predictions.${prediction?.marketType || "unknown"}.liveRecommendation.${key}`);
      }
    }
  }
  return issues;
};

const hasVerifiedSportterySource = (match, prediction) => {
  const pool = String(prediction?.oddsPoolCode || "").toUpperCase();
  const source = pool === "HHAD" ? match?.handicapOddsSource : match?.oddsSource;
  const sourcePool = pool === "HHAD" ? match?.handicapOddsPoolCode : match?.oddsPoolCode;
  const sourceUrl = pool === "HHAD" ? match?.handicapOddsSourceUrl : match?.oddsSourceUrl;
  let officialUrl = false;
  try {
    const parsed = new URL(String(sourceUrl || ""));
    officialUrl = parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "webapi.sporttery.cn";
  } catch {
    officialUrl = false;
  }
  return (pool === "HAD" || pool === "HHAD")
    && source === `sporttery:${pool}`
    && String(sourcePool || "").toUpperCase() === pool
    && officialUrl;
};

const scheduledBestRecommendationsAreServerSafe = (match, globalRiskTier) => {
  if (!match || match.status !== "SCHEDULED") return true;
  const bestRows = Array.isArray(match.predictions)
    ? match.predictions.filter((prediction) => prediction?.marketType === "BEST")
    : [];
  return bestRows.every((prediction) => {
    if (prediction.recommendationAction === "reference") return true;
    if (prediction.recommendationAction !== "recommend") return false;
    return globalRiskTier === "stable"
      && hasVerifiedSportterySource(match, prediction)
      && prediction.multiFactorEvidence?.eligible === true
      && Array.isArray(prediction.multiFactorEvidence?.blockers)
      && prediction.multiFactorEvidence.blockers.length === 0;
  });
};

const run = async () => {
  const checks = [];
  const strictAuditFixture = compactPredictionSnapshotAudit({
    matchId: "sporttery_contract_strict",
    sourceMatchId: "contract-strict",
    decisionSnapshot: {
      version: "candidate-decision-snapshot-v2",
      decisionAt: "2026-07-28T05:29:56.291Z",
      sourceCycleId: "sporttery-relay:contract-strict",
      policyVersion: "sporttery-day-formula-trace-v65-trusted-incremental-history",
      featureSnapshotHash: "contract-feature-hash",
      probabilities: {
        HAD: { "1": 0.4, X: 0.3, "2": 0.3 },
        HHAD: { line: -1, outcomes: { "1": 0.2, X: 0.3, "2": 0.5 } },
      },
      markets: {
        HAD: {
          odds: { "1": 2.4, X: 3.2, "2": 2.8 },
          provenance: { strict: { eligible: true } },
        },
        HHAD: {
          line: -1,
          odds: { "1": 4.5, X: 3.8, "2": 1.6 },
          provenance: { strict: { eligible: true } },
        },
      },
      clockAudit: {
        eligible: true,
        markets: {
          HAD: { provenanceEligible: true },
          HHAD: { provenanceEligible: true },
        },
      },
    },
  });
  pushCheck(checks, "prediction snapshot audit preserves strict market eligibility",
    strictAuditFixture.atomicEvidencePresent === true
      && strictAuditFixture.markets.HAD.provenanceEligible === true
      && strictAuditFixture.markets.HAD.decisionEligible === true
      && strictAuditFixture.markets.HHAD.provenanceEligible === true
      && strictAuditFixture.markets.HHAD.decisionEligible === true, {
      atomicEvidencePresent: strictAuditFixture.atomicEvidencePresent,
      had: strictAuditFixture.markets.HAD,
      hhad: strictAuditFixture.markets.HHAD,
    });
  if (startServer) await startLocalServer();

  try {
    const rootPage = await request("GET", "/");
    pushCheck(checks, "html security headers", rootPage.status === 200
      && String(rootPage.headers?.["content-security-policy"] || "").includes("frame-ancestors 'none'")
      && rootPage.headers?.["x-frame-options"] === "DENY"
      && rootPage.headers?.["x-content-type-options"] === "nosniff"
      && Boolean(rootPage.headers?.["permissions-policy"]), {
      status: rootPage.status,
      hasCsp: Boolean(rootPage.headers?.["content-security-policy"]),
      frameOptions: rootPage.headers?.["x-frame-options"] || null,
      contentTypeOptions: rootPage.headers?.["x-content-type-options"] || null,
      hasPermissionsPolicy: Boolean(rootPage.headers?.["permissions-policy"])
    });
    const legacyHealth = await request("GET", "/api/health");
    const legacyHealthKeys = Object.keys(legacyHealth.body || {}).sort();
    const expectedLegacyHealthKeys = ["checkedAt", "ok", "service"];
    pushCheck(checks, "legacy health minimal public schema", legacyHealth.status === 200
      && legacyHealth.body?.service === "football-predict-server"
      && typeof legacyHealth.body?.ok === "boolean"
      && Boolean(legacyHealth.body?.checkedAt)
      && JSON.stringify(legacyHealthKeys) === JSON.stringify(expectedLegacyHealthKeys)
      && findPublicPathLeaks(legacyHealth.body).length === 0, {
      status: legacyHealth.status,
      keys: legacyHealthKeys,
      pathLeaks: findPublicPathLeaks(legacyHealth.body)
    });

    const adminHealthNoAuth = await request("GET", "/api/admin/health");
    pushCheck(checks, "detailed health requires admin bearer", adminHealthNoAuth.status === 401, {
      status: adminHealthNoAuth.status
    });
    if (adminToken) {
      const adminHealthQuery = await request("GET", `/api/admin/health?token=${encodeURIComponent(adminToken)}`);
      pushCheck(checks, "detailed health query token denied", adminHealthQuery.status === 401, {
        status: adminHealthQuery.status
      });
      const adminHealth = await request("GET", "/api/admin/health", null, {
        authorization: `Bearer ${adminToken}`
      });
      const relayUploadQueue = adminHealth.body?.relaySnapshotUploadQueue || null;
      pushCheck(checks, "detailed health admin diagnostics", adminHealth.status === 200
        && adminHealth.body?.service === "football-predict-server"
        && Boolean(adminHealth.body?.memory)
        && Boolean(adminHealth.body?.database)
        && Boolean(adminHealth.body?.files)
        && relayUploadQueue?.version === "relay-snapshot-upload-queue-v1"
        && typeof relayUploadQueue?.active === "boolean"
        && Number.isInteger(relayUploadQueue?.queueDepth)
        && Number(relayUploadQueue?.maxQueue) >= 1
        && Number(relayUploadQueue?.waitTimeoutMs) >= 250
        && Object.prototype.hasOwnProperty.call(adminHealth.body || {}, "meta"), {
        status: adminHealth.status,
        hasMemory: Boolean(adminHealth.body?.memory),
        hasDatabase: Boolean(adminHealth.body?.database),
        hasFiles: Boolean(adminHealth.body?.files),
        relayUploadQueueVersion: relayUploadQueue?.version || null,
        relayUploadQueueDepth: relayUploadQueue?.queueDepth ?? null,
        hasMeta: Object.prototype.hasOwnProperty.call(adminHealth.body || {}, "meta")
      });
    }

    const health = await request("GET", "/api/v1/health");
    pushCheck(checks, "health schema", health.status === 200 && health.body?.apiVersion === "v1" && health.headers.etag, {
      status: health.status,
      apiVersion: health.body?.apiVersion || null,
      hasEtag: Boolean(health.headers.etag),
      cacheControl: health.headers["cache-control"] || null
    });
    const healthSync = health.body?.sync || {};
    pushCheck(checks, "health sync worker schema", health.status === 200
      && typeof healthSync.running === "boolean"
      && typeof healthSync.apiSyncRunning === "boolean"
      && typeof healthSync.workerRunning === "boolean"
      && Object.prototype.hasOwnProperty.call(healthSync, "workerState")
      && Object.prototype.hasOwnProperty.call(healthSync, "workerCheckedAt")
      && Object.prototype.hasOwnProperty.call(healthSync, "nextWakeAt"), {
      status: health.status,
      running: healthSync.running ?? null,
      apiSyncRunning: healthSync.apiSyncRunning ?? null,
      workerRunning: healthSync.workerRunning ?? null,
      workerState: healthSync.workerState || null,
      workerCheckedAt: healthSync.workerCheckedAt || null,
      nextWakeAt: healthSync.nextWakeAt || null
    });
    const recommendationCoverage = health.body?.data?.recommendations || {};
    const recommendationProjectionParity = recommendationCoverage.projectionParity || {};
    pushCheck(checks, "health recommendation coverage schema", health.status === 200
      && recommendationCoverage.version === "current-recommendation-coverage-v5"
      && Number.isInteger(recommendationCoverage.scheduledMatches)
      && Number.isInteger(recommendationCoverage.bestDirectionMatches)
      && Number.isInteger(recommendationCoverage.missingDirectionMatches)
      && Number.isInteger(recommendationCoverage.watchMatches)
      && Number.isInteger(recommendationCoverage.trainingBackedMatches)
      && Number.isInteger(recommendationCoverage.trainingInputSufficientMatches)
      && Number.isInteger(recommendationCoverage.hhadMarketMatches)
      && Number.isInteger(recommendationCoverage.hhadBoundDirectionMatches)
      && Number.isInteger(recommendationCoverage.hhadMissingDirectionMatches)
      && Number.isInteger(recommendationCoverage.hhadOnlyMarketMatches)
      && Number.isInteger(recommendationCoverage.dualMarketEligibleMatches)
      && Number.isInteger(recommendationCoverage.dualMarketAtomicMatches)
      && Number.isInteger(recommendationCoverage.dualMarketAtomicMissingMatches)
      && recommendationCoverage.dualMarketBindingBlockerCounts
      && typeof recommendationCoverage.dualMarketBindingBlockerCounts === "object"
      && !Array.isArray(recommendationCoverage.dualMarketBindingBlockerCounts)
      && typeof recommendationCoverage.trainingCoverageOk === "boolean"
      && typeof recommendationCoverage.dualMarketAtomicCoverageOk === "boolean"
      && recommendationProjectionParity.version === "current-list-detail-recommendation-parity-v1"
      && recommendationProjectionParity.scope === "same-current-read-model-list-detail-projection"
      && recommendationProjectionParity.disclosure === "aggregate-counts-only"
      && Number.isInteger(recommendationProjectionParity.checkedRows)
      && Number.isInteger(recommendationProjectionParity.comparableRows)
      && Number.isInteger(recommendationProjectionParity.mismatchRows)
      && typeof recommendationProjectionParity.ok === "boolean"
      && health.body?.status?.recommendationProjectionParityOk === recommendationProjectionParity.ok
      && typeof recommendationCoverage.coverageOk === "boolean"
      && health.body?.status?.recommendationCoverageOk === recommendationCoverage.coverageOk, {
      status: health.status,
      recommendationCoverageOk: health.body?.status?.recommendationCoverageOk ?? null,
      recommendationProjectionParityOk: health.body?.status?.recommendationProjectionParityOk ?? null,
      recommendationCoverage
    });
    const healthTrainingAsset = health.body?.model?.trainingAsset || null;
    pushCheck(checks, "health training artifact schema", health.status === 200
      && healthTrainingAsset
      && healthTrainingAsset.validationOk === true
      && ["signed-release-asset", "explicit-runtime-path", "local-workspace"].includes(
        healthTrainingAsset.sourceKind
      )
      && /^[a-f0-9]{64}$/i.test(String(healthTrainingAsset.sha256 || ""))
      && Number(healthTrainingAsset.bytes || 0) > 0
      && Number(healthTrainingAsset.finiteEloTeams || 0) > 0
      && typeof health.body?.status?.signedTrainingAssetOk === "boolean", {
      status: health.status,
      signedTrainingAssetOk: health.body?.status?.signedTrainingAssetOk ?? null,
      trainingAsset: healthTrainingAsset
    });
    const healthModelEvaluation = health.body?.model?.evaluation || {};
    const healthStatus = health.body?.status || {};
    const healthRedundancy = healthStatus.officialSourceRedundancy || null;
    const evaluationStateIsExplicit = typeof healthModelEvaluation.ok === "boolean"
      && typeof healthModelEvaluation.coverageOk === "boolean";
    const evaluationStateIsConsistent = healthStatus.modelEvaluationFresh === healthModelEvaluation.ok
      && healthStatus.modelEvaluationCoverageOk === healthModelEvaluation.coverageOk;
    const coveredWhenDeclaredReady = healthModelEvaluation.coverageOk !== true || (
      Number(healthModelEvaluation.odds?.modelRows || 0) >= Number(healthModelEvaluation.odds?.minRows || 0)
      && Number(healthModelEvaluation.predictionSnapshots?.modelRows || 0) >= Number(healthModelEvaluation.predictionSnapshots?.minRows || 0)
    );
    pushCheck(checks, "health model evaluation coverage contract", health.status === 200
      && evaluationStateIsExplicit
      && evaluationStateIsConsistent
      && healthModelEvaluation.inputAuditOk === true
      && ["stable", "watch", "degraded"].includes(healthModelEvaluation.riskTier)
      && coveredWhenDeclaredReady, {
      status: health.status,
      generatedAt: healthModelEvaluation.generatedAt || null,
      minCoverageRatio: healthModelEvaluation.minCoverageRatio ?? null,
      evaluationOk: healthModelEvaluation.ok ?? null,
      coverageOk: healthModelEvaluation.coverageOk ?? null,
      stateConsistent: evaluationStateIsConsistent,
      oddsModelRows: healthModelEvaluation.odds?.modelRows ?? null,
      oddsSqliteRows: healthModelEvaluation.odds?.sqliteRows ?? null,
      predictionModelRows: healthModelEvaluation.predictionSnapshots?.modelRows ?? null,
      predictionSqliteRows: healthModelEvaluation.predictionSnapshots?.sqliteRows ?? null,
      inputAuditOk: healthModelEvaluation.inputAuditOk ?? null,
      riskTier: healthModelEvaluation.riskTier || null
    });

    const sourceHealth = await request("GET", "/api/v1/source-health");
    const publicSources = Array.isArray(sourceHealth.body?.sources) ? sourceHealth.body.sources : [];
    const publicSourceHealthText = JSON.stringify(sourceHealth.body || {});
    pushCheck(checks, "source-health public schema", sourceHealth.status === 200
      && publicSources.length >= 4
      && !sourceHealth.body?.admin
      && !publicSourceHealthText.includes('"refreshPipeline"'), {
      status: sourceHealth.status,
      sourceIds: publicSources.map((source) => source.id),
      exposesAdmin: Boolean(sourceHealth.body?.admin),
      exposesRefreshPipeline: publicSourceHealthText.includes('"refreshPipeline"')
    });
    const sourceRedundancy = sourceHealth.body?.officialSourceRedundancy || null;
    const trustedCollectorCount = Number(sourceRedundancy?.trustedCollectorCount);
    const requiredTrustedCollectors = Number(sourceRedundancy?.requiredTrustedCollectors);
    const redundancyBooleanConsistent = typeof sourceHealth.body?.officialSourceSinglePoint === "boolean"
      && sourceHealth.body.officialSourceSinglePoint === Boolean(
        sourceRedundancy?.serverDirectAvailable !== true
        && trustedCollectorCount < requiredTrustedCollectors
      );
    pushCheck(checks, "official source redundancy public contract", sourceHealth.status === 200
      && sourceRedundancy
      && ["watch", "redundant"].includes(sourceRedundancy.status)
      && Number.isInteger(trustedCollectorCount)
      && trustedCollectorCount >= 0
      && Number.isInteger(requiredTrustedCollectors)
      && requiredTrustedCollectors >= 2
      && redundancyBooleanConsistent
      && healthStatus.officialSourceSinglePoint === sourceHealth.body.officialSourceSinglePoint
      && healthRedundancy?.status === sourceRedundancy.status
      && healthRedundancy?.mode === sourceRedundancy.mode, {
      status: sourceHealth.status,
      officialSourceSinglePoint: sourceHealth.body?.officialSourceSinglePoint ?? null,
      redundancyStatus: sourceRedundancy?.status || null,
      redundancyMode: sourceRedundancy?.mode || null,
      serverDirectAvailable: sourceRedundancy?.serverDirectAvailable ?? null,
      trustedCollectorCount: sourceRedundancy?.trustedCollectorCount ?? null,
      requiredTrustedCollectors: sourceRedundancy?.requiredTrustedCollectors ?? null,
      booleanConsistent: redundancyBooleanConsistent,
      healthMirrorMatches: healthStatus.officialSourceSinglePoint === sourceHealth.body?.officialSourceSinglePoint
    });

    const syncMeta = await request("GET", "/api/v1/sync-meta");
    const liveRecommendationProjectionFixture = publicLiveRecommendationSummary({
      version: "live-model-recommendation-v1",
      checkedAt: "2026-07-16T08:20:38.295Z",
      qualifiedCount: 2,
      rows: [{
        matchId: "secret-match",
        homeTeamName: "Secret home",
        awayTeamName: "Secret away",
        pool: "HHAD",
        tipCode: "1",
        officialSp: 1.92,
        grade: "A",
      }],
      futureSensitiveField: { recommendation: "must-not-leak" },
    });
    const publicLiveRecommendations = syncMeta.body?.liveRecommendations;
    const publicLiveRecommendationKeys = publicLiveRecommendations && typeof publicLiveRecommendations === "object"
      ? Object.keys(publicLiveRecommendations).sort()
      : [];
    pushCheck(checks, "sync-meta live recommendation projection is aggregate-only", (
      JSON.stringify(liveRecommendationProjectionFixture) === JSON.stringify({
        version: "live-model-recommendation-v1",
        checkedAt: "2026-07-16T08:20:38.295Z",
        qualifiedCount: 2,
      })
      && syncMeta.status === 200
      && publicLiveRecommendationKeys.every((key) => ["checkedAt", "qualifiedCount", "version"].includes(key))
      && !Object.prototype.hasOwnProperty.call(publicLiveRecommendations || {}, "rows")
      && !JSON.stringify(publicLiveRecommendations || null).includes("matchId")
      && !JSON.stringify(publicLiveRecommendations || null).includes("tipCode")
    ), {
      status: syncMeta.status,
      publicKeys: publicLiveRecommendationKeys,
      exposesRows: Object.prototype.hasOwnProperty.call(publicLiveRecommendations || {}, "rows")
    });
    pushCheck(checks, "sync-meta official source redundancy runtime mirror", syncMeta.status === 200
      && syncMeta.body?.sourceHealth?.officialSourceSinglePoint === sourceHealth.body?.officialSourceSinglePoint
      && syncMeta.body?.sourceHealth?.officialSourceRedundancy?.status === sourceRedundancy?.status
      && syncMeta.body?.runtimeSourceHealth?.officialSourceSinglePoint === sourceHealth.body?.officialSourceSinglePoint
      && syncMeta.body?.runtimeSourceHealth?.officialSourceRedundancy?.mode === sourceRedundancy?.mode, {
      status: syncMeta.status,
      sourceHealthSinglePoint: syncMeta.body?.sourceHealth?.officialSourceSinglePoint ?? null,
      runtimeSinglePoint: syncMeta.body?.runtimeSourceHealth?.officialSourceSinglePoint ?? null,
      redundancyStatus: syncMeta.body?.sourceHealth?.officialSourceRedundancy?.status || null,
      redundancyMode: syncMeta.body?.runtimeSourceHealth?.officialSourceRedundancy?.mode || null
    });

    const sourceHealthAdminNoAuth = await request("GET", "/api/v1/source-health?detail=admin");
    pushCheck(checks, "source-health admin requires bearer", sourceHealthAdminNoAuth.status === 401, {
      status: sourceHealthAdminNoAuth.status
    });
    if (adminToken) {
      const sourceHealthAdminQuery = await request("GET", `/api/v1/source-health?detail=admin&token=${encodeURIComponent(adminToken)}`);
      pushCheck(checks, "source-health query token denied", sourceHealthAdminQuery.status === 401, {
        status: sourceHealthAdminQuery.status
      });
      const sourceHealthAdmin = await request("GET", "/api/v1/source-health?detail=admin", null, {
        authorization: `Bearer ${adminToken}`
      });
      const refreshPipeline = sourceHealthAdmin.body?.admin?.refreshPipeline || null;
      const refreshKeys = Object.keys(refreshPipeline || {}).sort();
      const cycleKeys = refreshPipeline?.cycle ? Object.keys(refreshPipeline.cycle).sort() : [];
      const wakeKeys = refreshPipeline?.wake ? Object.keys(refreshPipeline.wake).sort() : [];
      const relayWakeKeys = refreshPipeline?.relayWake ? Object.keys(refreshPipeline.relayWake).sort() : [];
      const serializedRefresh = JSON.stringify(refreshPipeline || {});
      pushCheck(checks, "source-health admin refresh diagnostics are whitelisted", sourceHealthAdmin.status === 200
        && JSON.stringify(refreshKeys) === JSON.stringify(["cycle", "relayWake", "wake"])
        && (!refreshPipeline?.cycle || JSON.stringify(cycleKeys) === JSON.stringify(["durationMs", "finishedAt", "ok", "phase", "startedAt"]))
        && (!refreshPipeline?.wake || JSON.stringify(wakeKeys) === JSON.stringify(["reason", "waitedMs"]))
        && (!refreshPipeline?.relayWake || JSON.stringify(relayWakeKeys) === JSON.stringify(["eligible", "enabled", "pollSeconds"]))
        && !serializedRefresh.includes(adminToken)
        && !/(?:command|args|env|path|token)/i.test(serializedRefresh), {
        status: sourceHealthAdmin.status,
        refreshKeys,
        cycleKeys,
        wakeKeys,
        relayWakeKeys
      });
    }

    const modelEvaluation = await request("GET", "/api/v1/model/evaluation");
    const modelShadow = modelEvaluation.body?.backtest?.shadowCandidates || null;
    const modelScorecard = modelEvaluation.body?.publicScorecard || null;
    const publicHhadCompanion = modelScorecard?.shadowTracks?.HHAD_COMPANION || null;
    const publicCandidateProspective =
      modelScorecard?.shadowTracks?.CANDIDATE_PROSPECTIVE || null;
    const backtestHhadCompanion = modelEvaluation.body?.backtest?.hhadCompanionEvaluation || null;
    const sampleHhadCompanion = modelEvaluation.body?.backtest?.sample?.hhadCompanion || null;
    const publicStrategyGate = modelEvaluation.body?.strategy?.activation?.promotionGate || null;
    const modelInputAudit = modelEvaluation.body?.backtest?.inputAudit || null;
    const modelRiskTiers = modelEvaluation.body?.backtest?.riskTiers || null;
    const oddsObservationAudit = modelEvaluation.body?.backtest?.oddsObservationAudit || null;
    const sampleOddsObservationAudit = modelEvaluation.body?.backtest?.sample?.oddsObservationAudit || null;
    const leaksModelCandidates = Array.isArray(modelShadow?.candidates);
    const leaksShadowCandidateId = Boolean(modelShadow?.bestCandidateId || modelShadow?.bestCandidate?.id || modelShadow?.bestCandidate?.featureSet);
    const leaksStrategyRules = Boolean(modelEvaluation.body?.strategy?.activeGates || modelEvaluation.body?.strategy?.recommendations);
    const leaksStrategyCandidateDetail = Boolean(publicStrategyGate?.shadowCandidate || publicStrategyGate?.modelSignalCandidate);
    const leaksInputAuditSamples = Object.values(modelInputAudit?.violations || {}).some((row) => Array.isArray(row?.sample));
    const leaksRiskRows = Array.isArray(modelRiskTiers?.rows)
      || Array.isArray(modelRiskTiers?.inputRows)
      || Array.isArray(modelRiskTiers?.probabilityRows)
      || Array.isArray(modelRiskTiers?.predictionRows);
    const pathLeaks = findPublicPathLeaks(modelEvaluation.body);
    const hhadSensitiveKeyLeaks = findHhadCompanionSensitiveKeyLeaks({
      publicHhadCompanion,
      backtestHhadCompanion,
      sampleHhadCompanion
    });
    const leaksHhadCompanionRows = hhadSensitiveKeyLeaks.length > 0;
    pushCheck(checks, "model-evaluation public redaction", modelEvaluation.status === 200
      && modelEvaluation.body?.publicView === true
      && !leaksModelCandidates
      && !leaksShadowCandidateId
      && !leaksStrategyRules
      && !leaksStrategyCandidateDetail
      && !leaksHhadCompanionRows
      && pathLeaks.length === 0, {
      status: modelEvaluation.status,
      publicView: modelEvaluation.body?.publicView ?? null,
      leaksModelCandidates,
      leaksShadowCandidateId,
      leaksStrategyRules,
      leaksStrategyCandidateDetail,
      leaksHhadCompanionRows,
      hhadSensitiveKeyLeaks,
      pathLeaks
    });
    pushCheck(checks, "model-evaluation exposes compact official odds observation coverage",
      modelEvaluation.status === 200
        && oddsObservationAudit?.version === "official-odds-observation-trail-v1"
        && sampleOddsObservationAudit?.version === oddsObservationAudit.version
        && Number.isInteger(Number(oddsObservationAudit.stateRows))
        && Number.isInteger(Number(oddsObservationAudit.officialObservations))
        && Number(oddsObservationAudit.coverage) >= 0
        && Number(oddsObservationAudit.coverage) <= 1
        && !Array.isArray(oddsObservationAudit.rows)
        && !Array.isArray(sampleOddsObservationAudit.rows), {
        status: modelEvaluation.status,
        version: oddsObservationAudit?.version || null,
        stateRows: oddsObservationAudit?.stateRows ?? null,
        officialObservations: oddsObservationAudit?.officialObservations ?? null,
        coverage: oddsObservationAudit?.coverage ?? null,
      });
    pushCheck(checks, "model-evaluation public scorecard schema", modelEvaluation.status === 200
      && modelScorecard?.version === "public-model-scorecard-v2"
      && modelScorecard?.publicView === true
      && modelScorecard?.buckets?.scope === "formal-recommendations-only"
      && modelScorecard?.sample?.formalRecommendationRows === modelScorecard?.sample?.predictionRows
      && Array.isArray(modelScorecard?.buckets?.markets)
      && Array.isArray(modelScorecard?.buckets?.leagues)
      && Array.isArray(modelScorecard?.buckets?.odds)
      && publicHhadCompanion?.publicView === true
      && publicHhadCompanion?.onlineEffect === "shadow"
      && publicHhadCompanion?.promotionAllowed === false
      && typeof publicHhadCompanion?.candidateReady === "boolean"
      && publicHhadCompanionSchemaValid(publicHhadCompanion)
      && publicHhadCompanionSchemaValid(backtestHhadCompanion)
      && isNonNegativeInteger(publicHhadCompanion?.counts?.pairedNonVoidRows)
      && Array.isArray(publicHhadCompanion?.gate?.failedChecks)
      && backtestHhadCompanion?.counts?.pairedNonVoidRows === publicHhadCompanion?.counts?.pairedNonVoidRows
      && isNonNegativeInteger(sampleHhadCompanion?.pairedNonVoidRows)
      && sampleHhadCompanion.pairedNonVoidRows === publicHhadCompanion.counts.pairedNonVoidRows
      && hhadSensitiveKeyLeaks.length === 0
      && !leaksShadowCandidateId
      && !leaksStrategyCandidateDetail, {
        status: modelEvaluation.status,
        scorecardVersion: modelScorecard?.version || null,
        publicView: modelScorecard?.publicView ?? null,
        formalRecommendationRows: modelScorecard?.sample?.formalRecommendationRows ?? null,
        marketBuckets: modelScorecard?.buckets?.markets?.length ?? null,
        leagueBuckets: modelScorecard?.buckets?.leagues?.length ?? null,
        oddsBuckets: modelScorecard?.buckets?.odds?.length ?? null,
        hhadCompanionRows: publicHhadCompanion?.counts?.pairedNonVoidRows ?? null,
        hhadCompanionStatus: publicHhadCompanion?.candidateStatus || null,
        hhadCompanionOnlineEffect: publicHhadCompanion?.onlineEffect || null,
        hhadSensitiveKeyLeaks,
        leaksShadowCandidateId,
        leaksStrategyCandidateDetail
      });
    const candidateDecisionRecord = publicCandidateProspective?.decisionRecord || null;
    const candidateSettlementRecord =
      publicCandidateProspective?.settlementRecord || null;
    const candidateHeartbeat = publicCandidateProspective?.captureHeartbeat || null;
    const candidateChallengerSuite = candidateHeartbeat?.challengerSuite || null;
    const candidateReadiness =
      candidateHeartbeat?.readiness || null;
    const candidateAdmission = candidateReadiness?.admission || null;
    const candidateDueMatches = Number(candidateHeartbeat?.dueMatches || 0);
    const candidateDueCaptureEvents = Number(
      candidateHeartbeat?.dueCaptureEventsAdded || 0,
    );
    const candidateDueDecisions = Number(
      candidateHeartbeat?.dueDecisionEventsAdded || 0,
    );
    const candidateDueExclusions = Number(
      candidateHeartbeat?.dueExclusionEventsAdded || 0,
    );
    const candidateDueAtomicDecisions = Number(
      candidateHeartbeat?.dueAtomicDecisionEventsAdded || 0,
    );
    const candidateDeadlineBatches = Array.isArray(
      candidateReadiness?.deadlineBatches,
    )
      ? candidateReadiness.deadlineBatches
      : [];
    const candidateDeadlineBatchTotal = candidateDeadlineBatches.reduce(
      (sum, batch) => sum + Number(batch?.totalMatches || 0),
      0,
    );
    const candidateDeadlineBatchesValid = candidateDeadlineBatches.every(
      (batch) => {
        const total = Number(batch?.totalMatches);
        const actionable = Number(batch?.actionableMatches);
        const ready = Number(batch?.readyNow);
        const awaiting = Number(batch?.awaitingMarket);
        const blocked = Number(batch?.blocked);
        const excluded = Number(batch?.excluded);
        const terminalDecisions = Number(batch?.terminalDecisions);
        const terminalExclusions = Number(batch?.terminalExclusions);
        const duplicateTerminalEvents = Number(
          batch?.duplicateTerminalEvents,
        );
        const terminalKeysWithDuplicates = Number(
          batch?.terminalKeysWithDuplicates,
        );
        const terminalMatches = Number(batch?.terminalMatches);
        const pendingMatches = Number(batch?.pendingMatches);
        const dueUnrecorded = Number(batch?.dueUnrecorded);
        const readyDueUnrecorded = Number(batch?.readyDueUnrecorded);
        return (
          batch?.version === "candidate-deadline-batch-summary-v1"
          && [
            "upcoming",
            "finalization-grace",
            "post-finalization",
            "deadline-missing",
          ].includes(batch?.phase)
          && [
            total,
            actionable,
            ready,
            awaiting,
            blocked,
            excluded,
            terminalDecisions,
            terminalExclusions,
            duplicateTerminalEvents,
            terminalKeysWithDuplicates,
            terminalMatches,
            pendingMatches,
            dueUnrecorded,
            readyDueUnrecorded,
          ].every(isNonNegativeInteger)
          && ready + awaiting + blocked + excluded === total
          && actionable === total - excluded
          && terminalDecisions + terminalExclusions === terminalMatches
          && pendingMatches === total - terminalMatches
          && terminalMatches <= total
          && duplicateTerminalEvents === 0
          && terminalKeysWithDuplicates === 0
          && readyDueUnrecorded <= dueUnrecorded
          && (
            batch.phase !== "post-finalization"
            || dueUnrecorded === 0
          )
          && batch.invariantOk === true
          && !Object.hasOwn(batch, "matchId")
          && !Object.hasOwn(batch, "sourceMatchId")
        );
      },
    );
    const expectedNearestCandidateBatch = candidateDeadlineBatches.find(
      (batch) => (
        Number(batch?.pendingMatches || 0) > 0
        && Boolean(batch?.deadlineAt)
      ),
    ) || null;
    const candidateNearestDeadlineBatchValid = expectedNearestCandidateBatch
      ? (
        candidateReadiness?.nearestDeadlineBatch?.deadlineAt
          === expectedNearestCandidateBatch.deadlineAt
        && candidateReadiness?.nearestDeadlineBatch?.invariantOk === true
      )
      : candidateReadiness?.nearestDeadlineBatch === null;
    const requiredCandidateDecisionFields = [
      "identity",
      "official-market-provenance",
      "odds",
      "base-model-probabilities",
      "candidate-probabilities",
      "devigged-market-probabilities",
      "feature-snapshot",
      "strategy-versions",
      "source-clock",
      "dual-market-decision-record",
      "dual-market-decision-hash",
      "temporal-ordering",
      "atomic-decision-hash",
    ];
    const requiredCandidateSettlementFields = [
      "decision-link",
      "official-result-identity",
      "score-outcome-consistency",
      "result-observation-clock",
      "result-provenance-hash",
    ];
    const candidateAtomicDecisionAuditOk = modelEvaluation.status === 200
        && publicCandidateProspective?.chainValid === true
        && candidateDecisionRecord?.version === "candidate-atomic-decision-record-v3"
        && candidateDecisionRecord?.validationVersion
          === "candidate-atomic-decision-validation-v2"
        && candidateDecisionRecord?.dualMarketDecisionRecordVersion
          === "candidate-dual-market-decision-record-v1"
        && candidateDecisionRecord?.formalMetricMarket === "HAD"
        && candidateDecisionRecord?.companionMarket === "HHAD"
        && candidateDecisionRecord?.decisionDeadlinePolicyVersion
          === "official-cutoff-first-v1"
        && requiredCandidateDecisionFields.every((field) => (
          candidateDecisionRecord?.requiredFields?.includes(field)
        ))
        && Number(candidateDecisionRecord?.admittedRows || 0)
          === Number(candidateDecisionRecord?.atomicRows || 0)
        && Number(candidateDecisionRecord?.admittedRows || 0)
          === Number(candidateDecisionRecord?.completeRows || 0)
        && Number(candidateDecisionRecord?.failedRows || 0) === 0
        && Object.keys(candidateDecisionRecord?.blockerCounts || {}).length === 0
        && Number(candidateDecisionRecord?.coverage) === 1
        && candidateDecisionRecord?.complete === true
        && candidateSettlementRecord?.version
          === "candidate-official-settlement-record-v1"
        && candidateSettlementRecord?.validationVersion
          === "candidate-official-settlement-validation-v1"
        && requiredCandidateSettlementFields.every((field) => (
          candidateSettlementRecord?.requiredFields?.includes(field)
        ))
        && Number(candidateSettlementRecord?.rows || 0)
          === Number(candidateSettlementRecord?.completeRows || 0)
        && Number(candidateSettlementRecord?.failedRows || 0) === 0
        && Object.keys(candidateSettlementRecord?.blockerCounts || {}).length === 0
        && Number(candidateSettlementRecord?.coverage) === 1
        && candidateSettlementRecord?.complete === true
        && !Object.hasOwn(publicCandidateProspective, "featureSnapshot")
        && !Object.hasOwn(publicCandidateProspective, "sourceClock")
        && !Object.hasOwn(publicCandidateProspective, "strategyVersions");
    pushCheck(
      checks,
      "candidate prospective public audit proves atomic decision records",
      candidateAtomicDecisionAuditOk,
      {
        status: modelEvaluation.status,
        candidateRevisionId: publicCandidateProspective?.candidateRevisionId || null,
        chainValid: publicCandidateProspective?.chainValid ?? null,
        decisionRecord: candidateDecisionRecord,
        settlementRecord: candidateSettlementRecord,
      },
    );
    const candidateDeadlineAuditOk = [
          "dueCaptureEventsAdded",
          "dueDecisionEventsAdded",
          "dueExclusionEventsAdded",
          "dueAtomicDecisionEventsAdded",
          "dueCaptureComplete",
          "dueAtomicComplete",
        ].every((field) => Object.hasOwn(candidateHeartbeat || {}, field))
        && candidateDueCaptureEvents === candidateDueMatches
        && candidateDueDecisions + candidateDueExclusions
          === candidateDueCaptureEvents
        && candidateDueAtomicDecisions === candidateDueDecisions
        && candidateHeartbeat?.dueCaptureComplete === true
        && candidateHeartbeat?.dueAtomicComplete === true
        && (
          candidateReadiness === null
          || (
            candidateReadiness.version === "candidate-prospective-readiness-preview-v2"
            && candidateReadiness.captureFinalizationPolicyVersion
              === "deadline-evidence-grace-v1"
            && Number(candidateReadiness.captureFinalizationGraceSeconds) === 120
            && isNonNegativeInteger(candidateReadiness.previewLimit)
            && Number(candidateReadiness.previewLimit) > 0
            && isNonNegativeInteger(candidateReadiness.evaluatedMatches)
            && isNonNegativeInteger(candidateReadiness.detailedMatches)
            && isNonNegativeInteger(candidateReadiness.rowsTruncated)
            && isNonNegativeInteger(candidateReadiness.upcomingMatches)
            && isNonNegativeInteger(candidateReadiness.readyNow)
            && isNonNegativeInteger(candidateReadiness.atomicReadyNow)
            && isNonNegativeInteger(candidateReadiness.awaitingMarket)
            && isNonNegativeInteger(candidateReadiness.blocked)
            && isNonNegativeInteger(candidateReadiness.excluded)
            && Number(candidateReadiness.atomicReadyNow)
              === Number(candidateReadiness.readyNow)
            && candidateReadiness.readyInvariantOk === true
            && Number(candidateReadiness.readyNow)
              + Number(candidateReadiness.awaitingMarket)
              + Number(candidateReadiness.blocked)
              + Number(candidateReadiness.excluded)
              === Number(candidateReadiness.upcomingMatches)
            && Number(candidateReadiness.evaluatedMatches)
              === Number(candidateReadiness.upcomingMatches)
            && Number(candidateReadiness.detailedMatches)
              + Number(candidateReadiness.rowsTruncated)
              === Number(candidateReadiness.evaluatedMatches)
            && candidateDeadlineBatchTotal
              === Number(candidateReadiness.upcomingMatches)
            && candidateDeadlineBatchesValid
            && candidateNearestDeadlineBatchValid
            && Number(candidateReadiness.detailedMatches)
              <= Number(candidateReadiness.previewLimit)
            && Number.isFinite(Number(candidateReadiness.readinessRatio))
            && Number(candidateReadiness.readinessRatio) >= 0
            && Number(candidateReadiness.readinessRatio) <= 1
            && (
              Number(candidateReadiness.upcomingMatches)
                - Number(candidateReadiness.excluded) === 0
              || (
                Number.isFinite(Date.parse(candidateReadiness.nearestDeadlineAt || ""))
                && Number.isFinite(
                  Date.parse(candidateReadiness.nearestFinalizationAt || ""),
                )
                && Date.parse(candidateReadiness.nearestFinalizationAt)
                  - Date.parse(candidateReadiness.nearestDeadlineAt)
                  === Number(candidateReadiness.captureFinalizationGraceSeconds) * 1000
              )
            )
            && candidateReadiness.blockerCounts
            && typeof candidateReadiness.blockerCounts === "object"
            && candidateReadiness.excludedReasonCounts
            && typeof candidateReadiness.excludedReasonCounts === "object"
            && candidateAdmission?.version
              === "candidate-prospective-admission-summary-v1"
            && typeof candidateAdmission.registryAvailable === "boolean"
            && isNonNegativeInteger(candidateAdmission.expectedRows)
            && isNonNegativeInteger(candidateAdmission.auditedRows)
            && isNonNegativeInteger(candidateAdmission.admitted)
            && isNonNegativeInteger(candidateAdmission.excluded)
            && isNonNegativeInteger(candidateAdmission.pendingDeadline)
            && isNonNegativeInteger(candidateAdmission.dueUnrecorded)
            && isNonNegativeInteger(candidateAdmission.unreconciled)
            // The admission preview covers only currently upcoming fixtures,
            // while decisionRecord is the cumulative append-only ledger.
            // A completed past decision may legitimately remain in the latter
            // after it has left the former.
            && Number(candidateAdmission.admitted)
              <= Number(candidateDecisionRecord.admittedRows)
            && typeof candidateAdmission.captureGap === "boolean"
            && typeof candidateAdmission.reconciled === "boolean"
          )
        );
    pushCheck(
      checks,
      "candidate prospective public audit reconciles the deadline cohort",
      candidateDeadlineAuditOk,
      {
        status: modelEvaluation.status,
        candidateRevisionId: publicCandidateProspective?.candidateRevisionId || null,
        chainValid: publicCandidateProspective?.chainValid ?? null,
        decisionRecord: candidateDecisionRecord,
        deadlineCohortAudit: {
          dueMatches: candidateDueMatches,
          dueCaptureEventsAdded: candidateDueCaptureEvents,
          dueDecisionEventsAdded: candidateDueDecisions,
          dueExclusionEventsAdded: candidateDueExclusions,
          dueAtomicDecisionEventsAdded: candidateDueAtomicDecisions,
          dueCaptureComplete: candidateHeartbeat?.dueCaptureComplete ?? null,
          dueAtomicComplete: candidateHeartbeat?.dueAtomicComplete ?? null,
        },
        readiness: candidateReadiness,
      },
    );
    const candidateHeartbeatAgeMs = candidateHeartbeat?.heartbeatAgeMs;
    const candidateCaptureDurationMs = candidateHeartbeat?.captureDurationMs;
    const candidateHeartbeatFreshnessLimitMs = candidateHeartbeat?.freshnessLimitMs;
    const candidateLastAttemptAt = candidateHeartbeat?.lastAttemptAt;
    const candidateHeartbeatEvaluatedAtMs = Date.parse(
      candidateHeartbeat?.evaluatedAt || "",
    );
    const candidateNextPreemptiveRefreshAtMs = Date.parse(
      candidateHeartbeat?.nextPreemptiveRefreshAt || "",
    );
    const candidatePreemptiveRefreshAgeMs =
      candidateHeartbeat?.preemptiveRefreshAgeMs;
    const candidatePreemptiveReserveMs = candidateHeartbeat?.preemptiveReserveMs;
    const candidateProjectedWorstCaseCompletionAgeMs =
      candidateHeartbeat?.projectedWorstCaseCompletionAgeMs;
    const candidateNextAttemptType = candidateHeartbeat?.nextAttemptType;
    const candidateNextAttemptIsRecovery =
      candidateNextAttemptType === "preemptive-recovery";
    const candidateHeartbeatObservabilityOk = [
      "captureDurationMs",
      "heartbeatAgeMs",
      "freshnessLimitMs",
      "scheduleVersion",
      "scheduleMode",
      "preemptiveRefreshAgeMs",
      "preemptiveReserveMs",
      "attemptTimeoutLimitMs",
      "retryDelayMs",
      "recoveryCaptureBudgetMs",
      "preemptiveSafetyMarginMs",
      "projectedWorstCaseCompletionAgeMs",
      "preemptiveBudgetFits",
      "nextPreemptiveRefreshAt",
      "preemptiveRefreshDue",
      "nextAttemptBudgetVersion",
      "nextAttemptType",
      "nextAttemptTimeoutMs",
      "nextAttemptProjectedCompletionAgeMs",
      "nextAttemptBudgetFits",
      "lastAttemptAt",
      "lastAttemptReason",
      "lastAttemptStatusAdvanced",
      "lastAttemptKind",
      "lastAttemptTimeoutMs",
    ].every((field) => Object.hasOwn(candidateHeartbeat || {}, field))
      && typeof candidateCaptureDurationMs === "number"
      && Number.isFinite(candidateCaptureDurationMs)
      && candidateCaptureDurationMs >= 0
      && typeof candidateHeartbeatAgeMs === "number"
      && Number.isFinite(candidateHeartbeatAgeMs)
      && candidateHeartbeatFreshnessLimitMs === 120_000
      && candidateHeartbeat?.scheduleVersion
        === "candidate-heartbeat-preemptive-schedule-v1"
      && candidateHeartbeat?.scheduleMode === "preemptive-evaluated-at"
      && typeof candidatePreemptiveRefreshAgeMs === "number"
      && Number.isFinite(candidatePreemptiveRefreshAgeMs)
      && candidatePreemptiveRefreshAgeMs >= 1_000
      && typeof candidatePreemptiveReserveMs === "number"
      && Number.isFinite(candidatePreemptiveReserveMs)
      && candidatePreemptiveReserveMs > 0
      && Number.isFinite(candidateHeartbeat?.attemptTimeoutLimitMs)
      && candidateHeartbeat.attemptTimeoutLimitMs >= 1_000
      && Number.isFinite(candidateHeartbeat?.retryDelayMs)
      && candidateHeartbeat.retryDelayMs >= 1_000
      && Number.isFinite(candidateHeartbeat?.recoveryCaptureBudgetMs)
      && candidateHeartbeat.recoveryCaptureBudgetMs >= 1_000
      && Number.isFinite(candidateHeartbeat?.preemptiveSafetyMarginMs)
      && candidateHeartbeat.preemptiveSafetyMarginMs >= 0
      && candidatePreemptiveReserveMs
        === candidateHeartbeat.attemptTimeoutLimitMs
          + candidateHeartbeat.retryDelayMs
          + candidateHeartbeat.recoveryCaptureBudgetMs
          + candidateHeartbeat.preemptiveSafetyMarginMs
      && candidatePreemptiveRefreshAgeMs + candidatePreemptiveReserveMs
        === candidateHeartbeatFreshnessLimitMs
      && typeof candidateProjectedWorstCaseCompletionAgeMs === "number"
      && Number.isFinite(candidateProjectedWorstCaseCompletionAgeMs)
      && candidateProjectedWorstCaseCompletionAgeMs
        < candidateHeartbeatFreshnessLimitMs
      && candidateHeartbeat?.preemptiveBudgetFits === true
      && Number.isFinite(candidateHeartbeatEvaluatedAtMs)
      && Number.isFinite(candidateNextPreemptiveRefreshAtMs)
      && candidateNextPreemptiveRefreshAtMs - candidateHeartbeatEvaluatedAtMs
        === candidatePreemptiveRefreshAgeMs
      && candidateHeartbeat?.preemptiveRefreshDue === (
        candidateHeartbeatAgeMs >= candidatePreemptiveRefreshAgeMs
      )
      && candidateHeartbeat?.nextAttemptBudgetVersion
        === "candidate-heartbeat-attempt-budget-v1"
      && ["preemptive-primary", "preemptive-recovery"]
        .includes(candidateNextAttemptType)
      && Number.isFinite(candidateHeartbeat?.nextAttemptTimeoutMs)
      && candidateHeartbeat.nextAttemptTimeoutMs >= 1_000
      && candidateHeartbeat.nextAttemptTimeoutMs
        <= candidateHeartbeat.attemptTimeoutLimitMs
      && Number.isFinite(
        candidateHeartbeat?.nextAttemptProjectedCompletionAgeMs,
      )
      && candidateHeartbeat.nextAttemptProjectedCompletionAgeMs
        === Math.max(0, candidateHeartbeatAgeMs)
          + candidateHeartbeat.nextAttemptTimeoutMs
          + (candidateNextAttemptIsRecovery
            ? 0
            : candidateHeartbeat.retryDelayMs
              + candidateHeartbeat.recoveryCaptureBudgetMs)
      && candidateHeartbeat?.nextAttemptBudgetFits === (
        candidateHeartbeat.nextAttemptProjectedCompletionAgeMs
          <= candidateHeartbeatFreshnessLimitMs
            - candidateHeartbeat.preemptiveSafetyMarginMs
      )
      && Number(candidateHeartbeat?.intervalSeconds)
        === candidatePreemptiveRefreshAgeMs / 1_000
      && candidateHeartbeat?.fresh === (
        candidateHeartbeatAgeMs >= 0
        && candidateHeartbeatAgeMs <= candidateHeartbeatFreshnessLimitMs
      )
      && (
        candidateLastAttemptAt === null
          ? candidateHeartbeat.lastAttemptReason === null
            && candidateHeartbeat.lastAttemptStatusAdvanced === null
            && candidateHeartbeat.lastAttemptKind === null
            && candidateHeartbeat.lastAttemptTimeoutMs === null
          : Number.isFinite(Date.parse(candidateLastAttemptAt))
            && typeof candidateHeartbeat.lastAttemptReason === "string"
            && typeof candidateHeartbeat.lastAttemptStatusAdvanced === "boolean"
            && (
              candidateHeartbeat.lastAttemptKind === null
                ? candidateHeartbeat.lastAttemptTimeoutMs === null
                : ["preemptive-primary", "preemptive-recovery", "scheduled"]
                    .includes(candidateHeartbeat.lastAttemptKind)
                  && Number.isFinite(candidateHeartbeat.lastAttemptTimeoutMs)
                  && candidateHeartbeat.lastAttemptTimeoutMs >= 1_000
                  && candidateHeartbeat.lastAttemptTimeoutMs
                    <= candidateHeartbeat.attemptTimeoutLimitMs
            )
      );
    pushCheck(
      checks,
      "candidate heartbeat exposes truthful runtime duration, age and attempt state",
      candidateHeartbeatObservabilityOk,
      {
        status: modelEvaluation.status,
        captureDurationMs: candidateCaptureDurationMs ?? null,
        heartbeatAgeMs: candidateHeartbeatAgeMs ?? null,
        freshnessLimitMs: candidateHeartbeatFreshnessLimitMs ?? null,
        scheduleVersion: candidateHeartbeat?.scheduleVersion || null,
        scheduleMode: candidateHeartbeat?.scheduleMode || null,
        preemptiveRefreshAgeMs: candidatePreemptiveRefreshAgeMs ?? null,
        preemptiveReserveMs: candidatePreemptiveReserveMs ?? null,
        attemptTimeoutLimitMs: candidateHeartbeat?.attemptTimeoutLimitMs ?? null,
        retryDelayMs: candidateHeartbeat?.retryDelayMs ?? null,
        recoveryCaptureBudgetMs:
          candidateHeartbeat?.recoveryCaptureBudgetMs ?? null,
        preemptiveSafetyMarginMs:
          candidateHeartbeat?.preemptiveSafetyMarginMs ?? null,
        projectedWorstCaseCompletionAgeMs:
          candidateProjectedWorstCaseCompletionAgeMs ?? null,
        preemptiveBudgetFits: candidateHeartbeat?.preemptiveBudgetFits ?? null,
        nextPreemptiveRefreshAt:
          candidateHeartbeat?.nextPreemptiveRefreshAt || null,
        preemptiveRefreshDue: candidateHeartbeat?.preemptiveRefreshDue ?? null,
        nextAttemptBudgetVersion:
          candidateHeartbeat?.nextAttemptBudgetVersion || null,
        nextAttemptType: candidateNextAttemptType || null,
        nextAttemptTimeoutMs: candidateHeartbeat?.nextAttemptTimeoutMs ?? null,
        nextAttemptProjectedCompletionAgeMs:
          candidateHeartbeat?.nextAttemptProjectedCompletionAgeMs ?? null,
        nextAttemptBudgetFits:
          candidateHeartbeat?.nextAttemptBudgetFits ?? null,
        fresh: candidateHeartbeat?.fresh ?? null,
        lastAttemptAt: candidateLastAttemptAt ?? null,
        lastAttemptReason: candidateHeartbeat?.lastAttemptReason ?? null,
        lastAttemptStatusAdvanced:
          candidateHeartbeat?.lastAttemptStatusAdvanced ?? null,
        lastAttemptKind: candidateHeartbeat?.lastAttemptKind || null,
        lastAttemptTimeoutMs: candidateHeartbeat?.lastAttemptTimeoutMs ?? null,
      },
    );
    const candidateChallengerSerialized = JSON.stringify(
      candidateChallengerSuite || {},
    );
    const candidateChallengerBaseOk = candidateChallengerSuite !== null
      && candidateChallengerSuite.version
        === "candidate-prospective-challenger-suite-public-v1"
      && candidateChallengerSuite.onlineEffect === false
      && isNonNegativeInteger(candidateChallengerSuite.dueMatches)
      && isNonNegativeInteger(candidateChallengerSuite.trialCount)
      && isNonNegativeInteger(candidateChallengerSuite.progressUnits)
      && isNonNegativeInteger(candidateChallengerSuite.blockerCount)
      && candidateChallengerSuite.admittedRows?.min
        === candidateChallengerSuite.admittedRows?.max
      && candidateChallengerSuite.atomicRows?.min
        === candidateChallengerSuite.atomicRows?.max
      && candidateChallengerSuite.settledRows?.min
        === candidateChallengerSuite.settledRows?.max
      && candidateChallengerSuite.excludedRows?.min
        === candidateChallengerSuite.excludedRows?.max
      && candidateChallengerSuite.formalRows?.min
        === candidateChallengerSuite.formalRows?.max
      && candidateChallengerSuite.eligibleWindows?.min
        === candidateChallengerSuite.eligibleWindows?.max
      && candidateChallengerSuite.winningWindows?.min
        === candidateChallengerSuite.winningWindows?.max
      && isNonNegativeInteger(
        candidateChallengerSuite.promotionReviewReadyTrialCount,
      )
      && isNonNegativeInteger(
        candidateChallengerSuite.formalPromotionEligibleTrialCount,
      )
      && (
        candidateChallengerSuite.logLossImprovement?.min === null
          ? candidateChallengerSuite.logLossImprovement?.max === null
          : (
            Number.isFinite(Number(candidateChallengerSuite.logLossImprovement?.min))
            && Number.isFinite(Number(candidateChallengerSuite.logLossImprovement?.max))
          )
      )
      && (
        candidateChallengerSuite.brierImprovement?.min === null
          ? candidateChallengerSuite.brierImprovement?.max === null
          : (
            Number.isFinite(Number(candidateChallengerSuite.brierImprovement?.min))
            && Number.isFinite(Number(candidateChallengerSuite.brierImprovement?.max))
          )
      )
      && candidateChallengerSuite.countParity === true
      && !/(?:candidateId|candidateRevisionId|weights|probabilities|featureSnapshot|sourceClock)/
        .test(candidateChallengerSerialized);
    const candidateChallengerPublicOk = candidateChallengerSuite === null
      || (
        candidateChallengerBaseOk
        && (
          candidateChallengerSuite.available === true
            ? (
              Number(candidateChallengerSuite.trialCount) > 0
              && candidateChallengerSuite.chainValid === true
              && candidateChallengerSuite.allTrialsActive === true
              && candidateChallengerSuite.allTrialsShadowOnly === true
              && candidateChallengerSuite.decisionCoverageComplete === true
              && candidateChallengerSuite.settlementCoverageComplete === true
              && candidateChallengerSuite.metricCoverageComplete === true
              && candidateChallengerSuite.windowEvaluationCoverageComplete === true
            )
            : (
              Number(candidateChallengerSuite.trialCount) === 0
              && candidateChallengerSuite.rootHash === null
              && candidateChallengerSuite.allTrialsActive === false
              && candidateChallengerSuite.allTrialsShadowOnly === false
              && candidateChallengerSuite.decisionCoverageComplete === false
              && candidateChallengerSuite.settlementCoverageComplete === false
              && candidateChallengerSuite.metricCoverageComplete === false
              && candidateChallengerSuite.windowEvaluationCoverageComplete === false
              && Number(candidateChallengerSuite.blockerCount) >= 1
            )
        )
      );
    pushCheck(
      checks,
      "candidate challenger public audit exposes only aggregate parity",
      candidateChallengerPublicOk,
      {
        status: modelEvaluation.status,
        challengerSuite: candidateChallengerSuite,
      },
    );
    const hitRateAudit = modelScorecard?.hitRateAudit;
    pushCheck(checks, "formal hit-rate audit rejects unverified 80 percent claims", modelEvaluation.status === 200
      && hitRateAudit?.version === "formal-hit-rate-audit-v1"
      && Number(hitRateAudit?.targetRate) === 0.8
      && Number(hitRateAudit?.minimumSettledRows) >= 500
      && hitRateAudit?.externalBenchmark?.verificationStatus === "unverified-external-claim"
      && hitRateAudit?.externalBenchmark?.usableAsTrainingLabel === false
      && hitRateAudit?.publicationPolicy?.immutableLedgerRequired === true
      && hitRateAudit?.publicationPolicy?.completeWinsAndLossesRequired === true
      && hitRateAudit?.publicationPolicy?.postCutoffMutationForbidden === true
      && Array.isArray(hitRateAudit?.denominatorPolicy)
      && hitRateAudit.denominatorPolicy.includes("no-retrospective-row-deletion")
      && Number(hitRateAudit?.observed?.settled || 0) === Number(modelScorecard?.formalPerformance?.settled || 0), {
        status: modelEvaluation.status,
        auditVersion: hitRateAudit?.version || null,
        auditStatus: hitRateAudit?.status || null,
        targetRate: hitRateAudit?.targetRate ?? null,
        settled: hitRateAudit?.observed?.settled ?? null,
        minimumSettledRows: hitRateAudit?.minimumSettledRows ?? null,
        externalClaimStatus: hitRateAudit?.externalBenchmark?.verificationStatus || null
      });
    const hitRateClv = hitRateAudit?.closingLineValue;
    pushCheck(checks, "closing-line audit exposes timing-eligible denominator", modelEvaluation.status === 200
      && hitRateClv?.version === "closing-line-value-v2"
      && hitRateClv?.timingAudit?.version === "closing-line-timing-audit-v1"
      && isNonNegativeInteger(hitRateClv?.rows)
      && isNonNegativeInteger(hitRateClv?.candidateRows)
      && Number(hitRateClv.candidateRows) >= Number(hitRateClv.rows)
      && Number.isFinite(Number(hitRateClv?.timingCoverage))
      && Number(hitRateClv.timingCoverage) >= 0
      && Number(hitRateClv.timingCoverage) <= 1
      && Number(hitRateClv?.timingAudit?.eligibleRows) === Number(hitRateClv.rows)
      && hitRateClv?.timingAudit?.reasonCounts
      && typeof hitRateClv.timingAudit.reasonCounts === "object", {
        status: modelEvaluation.status,
        clvVersion: hitRateClv?.version || null,
        timingVersion: hitRateClv?.timingAudit?.version || null,
        eligibleRows: hitRateClv?.rows ?? null,
        candidateRows: hitRateClv?.candidateRows ?? null,
        timingCoverage: hitRateClv?.timingCoverage ?? null,
        reasonCounts: hitRateClv?.timingAudit?.reasonCounts || null
      });
    const benchmarkShadow = modelScorecard?.shadowTracks?.GOODWIN_BENCHMARK;
    pushCheck(checks, "selective 80 percent benchmark remains shadow-only and sample-gated",
      modelEvaluation.status === 200
      && benchmarkShadow?.version === "goodwin-benchmark-prospective-shadow-v2"
      && benchmarkShadow?.auditVersion === "goodwin-benchmark-prospective-audit-v3"
      && benchmarkShadow?.role === "shadow-only"
      && benchmarkShadow?.formalOnlineEffect === false
      && typeof benchmarkShadow?.captureHeartbeat?.ok === "boolean"
      && Number(benchmarkShadow?.captureHeartbeat?.intervalSeconds || 0) >= 15
      && Number.isFinite(Date.parse(benchmarkShadow?.activatedAt || ""))
      && Number(benchmarkShadow?.targetHitRate) === 0.8
      && benchmarkShadow?.criteria?.marketType === "BEST"
      && benchmarkShadow?.criteria?.oddsPoolCode === "HAD"
      && Number(benchmarkShadow?.criteria?.minimumEvidenceScore) === 60
      && Number(benchmarkShadow?.criteria?.minimumOdds) === 1.2
      && Number(benchmarkShadow?.criteria?.maximumOdds) === 1.85
      && benchmarkShadow?.criteria?.timeIntegrityAuditVersion
        === "official-live-clock-integrity-v1"
      && benchmarkShadow?.criteria?.earlyActualKickoffOrLiveObservationPolicy
        === "void-when-not-after-decision-cutoff"
      && Number(benchmarkShadow?.minimumSettledRowsForPromotionReview) >= 200
      && Number(benchmarkShadow?.minimumChronologicalFolds) >= 6
      && Number(benchmarkShadow?.minimumCalendarDays) >= 42
      && benchmarkShadow?.research?.promotionEligible === false
      && benchmarkShadow?.prospective?.chainValid === true
      && Number(benchmarkShadow?.prospective?.cohort?.settled || 0)
        === Number(benchmarkShadow?.walkForward?.metrics?.settled || 0)
      && benchmarkShadow?.gates?.thresholds?.hitRateDisclosureOnly === true
      && Number(benchmarkShadow?.gates?.thresholds?.minimumClosingLineCoverage) >= 0.95
      && Number(
        benchmarkShadow?.gates?.thresholds?.minimumTimeIntegrityEvidenceCoverage,
      ) >= 0.95
      && Number(benchmarkShadow?.gates?.thresholds?.minimumPositiveClvRate) >= 0.558
      && Number.isInteger(
        Number(benchmarkShadow?.prospective?.metrics?.timeIntegrityEvidenceRows),
      )
      && Number.isFinite(
        Number(benchmarkShadow?.prospective?.metrics?.timeIntegrityEvidenceCoverage),
      )
      && (
        Number(benchmarkShadow?.walkForward?.selectedRows || 0) === 0
        || benchmarkShadow?.walkForward?.allFoldsStrictTimeOrder === true
      )
      && Number(benchmarkShadow?.walkForward?.selectedRows || 0)
        === Number(benchmarkShadow?.walkForward?.metrics?.settled || 0), {
        status: modelEvaluation.status,
        version: benchmarkShadow?.version || null,
        role: benchmarkShadow?.role || null,
        captureHeartbeat: benchmarkShadow?.captureHeartbeat || null,
        activatedAt: benchmarkShadow?.activatedAt || null,
        researchRows: benchmarkShadow?.research?.selectedRows ?? null,
        prospectiveEvents: benchmarkShadow?.prospective?.eventCount ?? null,
        prospectiveChainValid: benchmarkShadow?.prospective?.chainValid ?? null,
        selectedRows: benchmarkShadow?.walkForward?.selectedRows ?? null,
        targetRate: benchmarkShadow?.targetHitRate ?? null,
        promotionReviewReady: benchmarkShadow?.promotionReviewReady ?? null,
        formalOnlineEffect: benchmarkShadow?.formalOnlineEffect ?? null,
      });
    const probabilityArchitecture = modelEvaluation.body?.probabilityArchitecture || null;
    const sourcePolicy = modelEvaluation.body?.sourcePolicy || null;
    pushCheck(checks, "model-evaluation probability architecture schema", modelEvaluation.status === 200
      && probabilityArchitecture?.version === "probability-stack-v1"
      && probabilityArchitecture?.publicView === true
      && Array.isArray(probabilityArchitecture?.outputs)
      && probabilityArchitecture.outputs.some((output) => output.id === "oneXTwo")
      && probabilityArchitecture.outputs.some((output) => output.id === "scoreDistribution")
      && Array.isArray(probabilityArchitecture?.layers)
      && probabilityArchitecture.layers.some((layer) => layer.id === "market-baseline")
      && probabilityArchitecture.layers.some((layer) => layer.id === "poisson-score")
      && probabilityArchitecture?.gates?.baselineRequired === true
      && probabilityArchitecture?.gates?.probabilityOverride === false, {
        status: modelEvaluation.status,
        version: probabilityArchitecture?.version || null,
        outputIds: Array.isArray(probabilityArchitecture?.outputs) ? probabilityArchitecture.outputs.map((output) => output.id) : [],
        layerIds: Array.isArray(probabilityArchitecture?.layers) ? probabilityArchitecture.layers.map((layer) => layer.id) : [],
        probabilityOverride: probabilityArchitecture?.gates?.probabilityOverride ?? null
      });
    pushCheck(checks, "model-evaluation source policy schema", modelEvaluation.status === 200
      && sourcePolicy?.version === "source-policy-v1"
      && sourcePolicy?.publicView === true
      && sourcePolicy?.primary === "sporttery-relay-snapshot"
      && sourcePolicy?.fullFiveHundredCutover?.allowed === false
      && sourcePolicy?.runtimeRule?.doNotPublishEmptyCurrentSlate === true, {
        status: modelEvaluation.status,
        version: sourcePolicy?.version || null,
        primary: sourcePolicy?.primary || null,
        fullFiveHundredCutoverAllowed: sourcePolicy?.fullFiveHundredCutover?.allowed ?? null,
        doNotPublishEmptyCurrentSlate: sourcePolicy?.runtimeRule?.doNotPublishEmptyCurrentSlate ?? null
      });
    const riskBucketTierById = new Map((modelRiskTiers?.recommendationBuckets || [])
      .map((bucket) => [bucket.id, bucket.tier]));
    const scorecardOddsTierMismatches = (modelScorecard?.buckets?.odds || [])
      .filter((bucket) => riskBucketTierById.has(bucket.id) && riskBucketTierById.get(bucket.id) !== bucket.tier)
      .map((bucket) => ({
        id: bucket.id,
        scorecardTier: bucket.tier,
        riskTier: riskBucketTierById.get(bucket.id)
      }));
    const recommendationBucketsExplicitlyUnavailable = riskBucketTierById.size === 0
      && (modelScorecard?.buckets?.odds || []).length === 0
      && ["watch", "degraded"].includes(modelRiskTiers?.overall?.tier);
    pushCheck(checks, "model-evaluation odds scorecard mirrors risk tiers", modelEvaluation.status === 200
      && (riskBucketTierById.size > 0 || recommendationBucketsExplicitlyUnavailable)
      && scorecardOddsTierMismatches.length === 0, {
        status: modelEvaluation.status,
        riskBuckets: riskBucketTierById.size,
        scorecardOddsBuckets: modelScorecard?.buckets?.odds?.length ?? null,
        recommendationBucketsExplicitlyUnavailable,
        mismatches: scorecardOddsTierMismatches
      });
    pushCheck(checks, "model-evaluation input audit public summary", modelEvaluation.status === 200
      && modelInputAudit?.version === "pre-match-input-audit-v1"
      && modelInputAudit?.ok === true
      && Number(modelInputAudit?.violationCount || 0) === 0
      && !leaksInputAuditSamples, {
        status: modelEvaluation.status,
        auditVersion: modelInputAudit?.version || null,
        auditOk: modelInputAudit?.ok ?? null,
        violationCount: modelInputAudit?.violationCount ?? null,
        leaksInputAuditSamples
      });
    pushCheck(checks, "model-evaluation risk tier public summary", modelEvaluation.status === 200
      && modelRiskTiers?.version === "model-risk-tier-v1"
      && ["stable", "watch", "degraded"].includes(modelRiskTiers?.overall?.tier)
      && modelRiskTiers?.policy?.probabilityOverride === false
      && !leaksRiskRows, {
        status: modelEvaluation.status,
        riskVersion: modelRiskTiers?.version || null,
        overallTier: modelRiskTiers?.overall?.tier || null,
        maxCalibrationError: modelRiskTiers?.confidenceBuckets?.maxCalibrationError ?? null,
        leaksRiskRows
      });

    const modelAdminNoAuth = await request("GET", "/api/v1/model/evaluation?detail=admin");
    pushCheck(checks, "model-evaluation admin requires bearer", modelAdminNoAuth.status === 401, {
      status: modelAdminNoAuth.status
    });
    if (adminToken) {
      const modelAdminQuery = await request("GET", `/api/v1/model/evaluation?detail=admin&token=${encodeURIComponent(adminToken)}`);
      pushCheck(checks, "model-evaluation query token denied", modelAdminQuery.status === 401, {
        status: modelAdminQuery.status
      });
      const modelAdmin = await request("GET", "/api/v1/model/evaluation?detail=admin", null, {
        authorization: `Bearer ${adminToken}`
      });
      const candidateCaptureAudit = modelAdmin.body?.candidateCaptureAudit || null;
      const candidateCaptureRows = candidateCaptureAudit?.readiness?.rows || [];
      const candidateProspectiveAudit =
        candidateCaptureAudit?.prospectiveAudit || null;
      const candidateExclusionAudit =
        candidateCaptureAudit?.exclusionAudit || null;
      const candidateTemporalStatus =
        candidateCaptureAudit?.temporalStatus || null;
      const candidateChallengerSuite =
        candidateCaptureAudit?.challengerSuite || null;
      const candidateCaptureAuditFieldPresent = Object.prototype.hasOwnProperty.call(
        modelAdmin.body || {},
        "candidateCaptureAudit"
      );
      const candidateCaptureAvailabilityConsistent = (
        modelAdmin.body?.admin?.includesCandidateCaptureAudit
        === Boolean(candidateCaptureAudit?.readiness)
      );
      const candidateExclusionAvailabilityConsistent = (
        modelAdmin.body?.admin?.includesCandidateExclusionAudit
        === Boolean(
          candidateExclusionAudit?.version
          === "candidate-prospective-exclusion-audit-v1",
        )
      );
      const captureRowsAreSanitized = Array.isArray(candidateCaptureRows)
        && candidateCaptureRows.every((row) => {
          const keys = Object.keys(row || {}).sort();
          return keys.every((key) => [
            "blockers",
            "atomicEvidenceValid",
            "awaitingReason",
            "captureFinalizationAt",
            "captureFinalizationGraceSeconds",
            "decisionDeadlineAt",
            "decisionDeadlineSource",
            "decisionSnapshotObserved",
            "kickoffAt",
            "matchId",
            "marketState",
            "officialHadMarketPresent",
            "snapshotCapturedAt",
            "sourceMatchId",
            "strictOfficialMarketEvidenceComplete",
            "status"
          ].includes(key))
            && typeof row.atomicEvidenceValid === "boolean"
            && typeof row.decisionSnapshotObserved === "boolean"
            && typeof row.officialHadMarketPresent === "boolean"
            && typeof row.strictOfficialMarketEvidenceComplete === "boolean"
            && !("featureSnapshot" in (row || {}))
            && !("probabilities" in (row || {}))
            && !("odds" in (row || {}));
        });
      const prospectiveAuditIsSanitized = candidateProspectiveAudit === null
        || (
          candidateProspectiveAudit?.chainValid === true
          && (
            (
              candidateProspectiveAudit?.decisionRecord
              && candidateProspectiveAudit?.cohort
            )
            || (
              candidateProspectiveAudit?.shadow
              && candidateProspectiveAudit?.formal
            )
          )
          && !("events" in candidateProspectiveAudit)
          && !("rows" in candidateProspectiveAudit)
          && !("featureSnapshot" in candidateProspectiveAudit)
          && !("probabilities" in candidateProspectiveAudit)
          && !("odds" in candidateProspectiveAudit)
        );
      const challengerSuiteSerialized = JSON.stringify(candidateChallengerSuite || {});
      const challengerSuiteIsSanitized = candidateChallengerSuite === null
        || (
          candidateChallengerSuite?.version
            === "candidate-prospective-challenger-suite-audit-v1"
          && candidateChallengerSuite?.onlineEffect === false
          && Array.isArray(candidateChallengerSuite?.trials)
          && candidateChallengerSuite.trials.length <= 3
          && !/"(?:registry|events|featureSnapshot|sourceClock|strategyVersions|odds)"\s*:/.test(
            challengerSuiteSerialized,
          )
        );
      const exclusionAuditAllowedKeys = new Set([
        "activeLedgerId",
        "blockerCounts",
        "formal",
        "phaseCounts",
        "reasonCounts",
        "registryAvailable",
        "rows",
        "rowsTruncated",
        "shadow",
        "total",
        "version",
      ]);
      const exclusionRows = Array.isArray(candidateExclusionAudit?.rows)
        ? candidateExclusionAudit.rows
        : [];
      const exclusionAuditIsSanitized = candidateExclusionAudit === null
        || (
          candidateExclusionAudit?.version
            === "candidate-prospective-exclusion-audit-v1"
          && Object.keys(candidateExclusionAudit).every(
            (key) => exclusionAuditAllowedKeys.has(key),
          )
          && exclusionRows.length <= 100
          && Number(candidateExclusionAudit?.rowsTruncated || 0) >= 0
          && exclusionRows.length
            + Number(candidateExclusionAudit?.rowsTruncated || 0)
            === Number(candidateExclusionAudit?.total || 0)
          && Object.values(candidateExclusionAudit?.phaseCounts || {})
            .reduce((sum, total) => sum + Number(total || 0), 0)
            === Number(candidateExclusionAudit?.total || 0)
          && exclusionRows.every((row) => (
            Object.keys(row || {}).every((key) => [
              "blockers",
              "captureFinalizationAt",
              "decisionDeadlineAt",
              "kickoffAt",
              "matchId",
              "marketState",
              "officialHadMarketPresent",
              "phase",
              "primaryExclusionReason",
              "recordedAt",
              "sequence",
              "sourceMatchId",
              "strictOfficialMarketEvidenceComplete",
              "hhadCompanionEvidenceComplete",
            ].includes(key))
            && Array.isArray(row?.blockers)
            && (
              row?.officialHadMarketPresent === null
              || typeof row?.officialHadMarketPresent === "boolean"
            )
            && (
              row?.strictOfficialMarketEvidenceComplete === null
              || typeof row?.strictOfficialMarketEvidenceComplete === "boolean"
            )
            && (
              row?.hhadCompanionEvidenceComplete === null
              || typeof row?.hhadCompanionEvidenceComplete === "boolean"
            )
            && row.blockers.every((blocker) => (
              typeof blocker === "string"
              && /^[a-z0-9-]+$/.test(blocker)
            ))
            && !("eventHash" in (row || {}))
            && !("featureSnapshot" in (row || {}))
            && !("probabilities" in (row || {}))
            && !("odds" in (row || {}))
          ))
        );
      const temporalStatusAllowedKeys = new Set([
        "activeLedgerPresent",
        "admittedRows",
        "awaitingOfficialFinalRows",
        "denominatorReconciled",
        "diagnosticRows",
        "diagnosticRowsTruncated",
        "evaluatedAt",
        "futureKickoffRows",
        "invalidKickoffRows",
        "kickoffPassedRows",
        "officialFinishedEligibleUnsettledRows",
        "officialFinishedIneligibleRows",
        "officialFinishedIneligiblePrimaryReasonCounts",
        "officialFinishedIneligibleReasonCounts",
        "officialResultRecordMissingRows",
        "pendingKickoffRange",
        "pendingRows",
        "settledRows",
        "settlementWorkerAttentionRequired",
        "version",
      ]);
      const temporalAggregateKeysAreSanitized = candidateTemporalStatus === null
        || Object.keys(candidateTemporalStatus).every(
          (key) => temporalStatusAllowedKeys.has(key),
        );
      const temporalDenominatorIsReconciled = candidateTemporalStatus === null
        || (
          candidateTemporalStatus?.denominatorReconciled === true
          && Number(candidateTemporalStatus?.admittedRows || 0)
            === Number(candidateTemporalStatus?.settledRows || 0)
              + Number(candidateTemporalStatus?.pendingRows || 0)
        );
      const temporalStatusIsSanitized = candidateTemporalStatus === null
        || (
          candidateTemporalStatus?.version
            === "candidate-prospective-temporal-audit-v1"
          && temporalAggregateKeysAreSanitized
          && temporalDenominatorIsReconciled
        );
      const temporalDiagnosticRows = Array.isArray(
        candidateTemporalStatus?.diagnosticRows,
      )
        ? candidateTemporalStatus.diagnosticRows
        : [];
      const temporalDiagnosticsAreSanitized = candidateTemporalStatus === null
        || (
          temporalDiagnosticRows.length <= 100
          && Number.isInteger(Number(
            candidateTemporalStatus?.diagnosticRowsTruncated,
          ))
          && Number(candidateTemporalStatus.diagnosticRowsTruncated) >= 0
          && temporalDiagnosticRows.every((row) => (
            Object.keys(row || {}).every((key) => [
              "blockers",
              "classification",
              "decisionEventHash",
              "kickoffAt",
              "matchId",
              "resultObservedAt",
              "resultPromotionEligible",
              "resultProvider",
              "scoreAway",
              "scoreHome",
              "sourceMatchId",
              "status",
            ].includes(key))
            && Array.isArray(row?.blockers)
            && row.blockers.every((blocker) => (
              typeof blocker === "string"
              && /^[a-z0-9-]+$/.test(blocker)
            ))
            && [
              "invalid-kickoff",
              "future-kickoff",
              "read-model-row-missing",
              "awaiting-official-final",
              "official-finished-eligible-unsettled",
              "official-finished-ineligible",
            ].includes(row?.classification)
            && !("featureSnapshot" in (row || {}))
            && !("probabilities" in (row || {}))
            && !("odds" in (row || {}))
          ))
        );
      const temporalPrimaryReasonCounts =
        candidateTemporalStatus?.officialFinishedIneligiblePrimaryReasonCounts;
      const temporalReasonCounts =
        candidateTemporalStatus?.officialFinishedIneligibleReasonCounts;
      const temporalReasonCountsAreSanitized = candidateTemporalStatus === null
        || (
          temporalPrimaryReasonCounts
          && typeof temporalPrimaryReasonCounts === "object"
          && !Array.isArray(temporalPrimaryReasonCounts)
          && temporalReasonCounts
          && typeof temporalReasonCounts === "object"
          && !Array.isArray(temporalReasonCounts)
          && [temporalPrimaryReasonCounts, temporalReasonCounts]
            .every((counts) => Object.entries(counts).every(
              ([reason, total]) => (
                /^[a-z0-9-]+$/.test(reason)
                && Number.isInteger(Number(total))
                && Number(total) >= 0
              ),
            ))
          && Object.values(temporalPrimaryReasonCounts)
            .reduce((sum, total) => sum + Number(total), 0)
            === Number(
              candidateTemporalStatus?.officialFinishedIneligibleRows || 0,
            )
        );
      pushCheck(checks, "model-evaluation admin diagnostics", modelAdmin.status === 200
        && modelAdmin.body?.admin?.includesInternalCandidates === true
        && candidateCaptureAuditFieldPresent
        && candidateCaptureAvailabilityConsistent
        && candidateExclusionAvailabilityConsistent
        && (
          candidateCaptureAudit === null
          || candidateCaptureAudit?.version === "candidate-capture-admin-audit-v1"
        )
        && captureRowsAreSanitized
        && prospectiveAuditIsSanitized
        && challengerSuiteIsSanitized
        && exclusionAuditIsSanitized
        && temporalStatusIsSanitized
        && temporalDiagnosticsAreSanitized
        && temporalReasonCountsAreSanitized, {
        status: modelAdmin.status,
        includesInternalCandidates: modelAdmin.body?.admin?.includesInternalCandidates ?? null,
        includesStrategyRules: modelAdmin.body?.admin?.includesStrategyRules ?? null,
        includesCandidateCaptureAudit:
          modelAdmin.body?.admin?.includesCandidateCaptureAudit ?? null,
        includesCandidateExclusionAudit:
          modelAdmin.body?.admin?.includesCandidateExclusionAudit ?? null,
        candidateCaptureAuditFieldPresent,
        candidateCaptureAvailabilityConsistent,
        candidateExclusionAvailabilityConsistent,
        candidateCaptureRows: candidateCaptureRows.length,
        captureRowsAreSanitized,
        prospectiveAuditIsSanitized,
        challengerSuiteIsSanitized,
        challengerTrialCount: candidateChallengerSuite?.trials?.length || 0,
        exclusionAuditIsSanitized,
        exclusionRows: exclusionRows.length,
        temporalAggregateKeysAreSanitized,
        temporalDenominatorIsReconciled,
        temporalStatusIsSanitized,
        temporalDiagnosticsAreSanitized,
        temporalDiagnosticRows: temporalDiagnosticRows.length,
        temporalReasonCountsAreSanitized,
        candidateTemporalStatus
      });
    }

    const currentNoAuth = await request("GET", "/api/v1/matches/current?view=list");
    const historyNoAuth = await request("GET", "/api/v1/matches/history?limit=1");
    const unresolvedArchiveNoAuth = await request("GET", "/api/v1/matches/unresolved-archive?limit=1");
    const oddsNoAuth = await request("GET", "/api/v1/odds/history?limit=1");
    const researchNoAuth = await request("GET", "/api/v1/research/status");
    pushCheck(checks, "protected v1 reads require access", currentNoAuth.status === 401
      && historyNoAuth.status === 401
      && unresolvedArchiveNoAuth.status === 401
      && oddsNoAuth.status === 401
      && researchNoAuth.status === 401, {
      current: currentNoAuth.status,
      history: historyNoAuth.status,
      unresolvedArchive: unresolvedArchiveNoAuth.status,
      odds: oddsNoAuth.status,
      research: researchNoAuth.status
    });

    const accessToken = await getAccessToken(checks);
    const accessHeaders = accessToken ? { "x-access-token": accessToken } : {};
    pushCheck(checks, "contract access token available", Boolean(accessToken), {
      provided: Boolean(accessToken)
    });

    const researchStatus = await request("GET", "/api/v1/research/status", null, accessHeaders);
    pushCheck(checks, "open research status is access-protected and policy-explicit", researchStatus.status === 200
      && researchStatus.body?.ok === true
      && researchStatus.body?.service === "open-research-gateway"
      && researchStatus.body?.policy?.fullTextFetched === false
      && researchStatus.body?.policy?.paywallBypass === false
      && researchStatus.body?.policy?.aiReceivesStructuredAuditOnly === true, {
      status: researchStatus.status,
      providers: researchStatus.body?.providers || [],
      policy: researchStatus.body?.policy || null
    });
    const researchMalformed = await request("POST", "/api/v1/research/search", {
      query: "https://169.254.169.254/latest/meta-data"
    }, accessHeaders);
    const researchWrongMethod = await request("GET", "/api/v1/research/search", null, accessHeaders);
    pushCheck(checks, "open research rejects fetch-target input and wrong methods without network access", researchMalformed.status === 400
      && researchMalformed.body?.code === "URL_QUERY_REJECTED"
      && researchWrongMethod.status === 405, {
      malformedStatus: researchMalformed.status,
      malformedCode: researchMalformed.body?.code || null,
      wrongMethodStatus: researchWrongMethod.status
    });

    const current = await request("GET", "/api/v1/matches/current?view=list", null, accessHeaders);
    const currentRows = Array.isArray(current.body?.rows) ? current.body.rows : [];
    const protectedBestPredictions = currentRows.flatMap((row) => (
      Array.isArray(row?.predictions)
        ? row.predictions.filter((prediction) => prediction?.marketType === "BEST")
        : []
    ));
    const modelOnlyReferenceRows = currentRows.filter((row) => (
      row?.status === "SCHEDULED"
      && row?.predictions?.some((prediction) => (
        prediction?.marketType === "BEST"
        && prediction?.recommendationTier === "model-only-watch"
      ))
    ));
    const provisionalResultRows = currentRows.filter((row) => row?.provisionalResult);
    const currentWithBridge = await request("GET", "/api/v1/matches/current?view=list&transition=1", null, accessHeaders);
    const bridgeCurrentRows = Array.isArray(currentWithBridge.body?.rows) ? currentWithBridge.body.rows : [];
    const transitionRows = Array.isArray(currentWithBridge.body?.transitionRows) ? currentWithBridge.body.transitionRows : [];
    const matchId = currentRows.find((row) => (
      row?.id
      && row?.predictions?.some((prediction) => prediction?.marketType === "BEST")
    ))?.id
      || currentRows.find((row) => row?.status === "SCHEDULED" && row?.id)?.id
      || currentRows.find((row) => row?.id)?.id
      || "";
    pushCheck(checks, "current list contract", current.status === 200 && current.body?.apiVersion === "v1" && current.body?.ok === true && currentRows.length > 0 && currentRows.every((row) => !hasHeavyListFields(row)), {
      status: current.status,
      rows: currentRows.length,
      dataSource: current.body?.dataSource || null,
      stale: current.body?.stale ?? null,
      hasEtag: Boolean(current.headers.etag),
      selectedMatchId: matchId || null
    });
    const currentListCompactionIssues = currentRows.flatMap((row) => (
      currentListPayloadCompactionIssues(row).map((issue) => `${row?.id || "unknown"}:${issue}`)
    ));
    pushCheck(checks, "current list excludes model health and compacts live recommendation", (
      current.status === 200
      && currentListCompactionIssues.length === 0
    ), {
      rows: currentRows.length,
      bytes: current.bytes,
      issues: currentListCompactionIssues.slice(0, 20)
    });
    pushCheck(checks, "protected current feed retains recommendation projection", (
      current.status === 200
      && protectedBestPredictions.length > 0
      && protectedBestPredictions.some((prediction) => (
        Object.prototype.hasOwnProperty.call(prediction, "recommendationAction")
        && Object.prototype.hasOwnProperty.call(prediction, "liveRecommendationAction")
        && prediction.liveRecommendation
        && typeof prediction.liveRecommendation === "object"
      ))
    ), {
      status: current.status,
      bestPredictions: protectedBestPredictions.length,
      recommendationFields: protectedBestPredictions.slice(0, 3).map((prediction) => ({
        recommendationAction: prediction.recommendationAction ?? null,
        liveRecommendationAction: prediction.liveRecommendationAction ?? null,
        hasLiveRecommendation: Boolean(prediction.liveRecommendation)
      }))
    });
    const unverifiedListBindings = currentRows.filter((row) => {
      const binding = row?.predictionMeta?.dualMarketDecision;
      return binding && (
        binding.integrityVerified !== true
        || binding.integrityVersion !== "dual-market-decision-integrity-v1"
        || Object.prototype.hasOwnProperty.call(binding, "featureSnapshot")
        || verifyCompactDualMarketDecisionBinding(binding).valid !== true
      );
    });
    pushCheck(checks, "current list exposes only server-verified dual-market bindings", (
      current.status === 200
      && unverifiedListBindings.length === 0
    ), {
      bindings: currentRows.filter((row) => row?.predictionMeta?.dualMarketDecision).length,
      unverifiedIds: unverifiedListBindings.map((row) => row?.id).slice(0, 10)
    });
    pushCheck(checks, "current list projects provisional results as shadow-only evidence", (
      provisionalResultRows.every((row) => (
        row.status !== "FINISHED"
        && row.provisionalResult?.provider === "500.com"
        && String(row.provisionalResult?.source || "").startsWith("500.com")
        && Number.isSafeInteger(row.provisionalResult?.scoreHome)
        && row.provisionalResult.scoreHome >= 0
        && Number.isSafeInteger(row.provisionalResult?.scoreAway)
        && row.provisionalResult.scoreAway >= 0
        && row.provisionalResult?.official === false
        && row.provisionalResult?.trusted === false
        && row.provisionalResult?.promotionEligible === false
        && row.provisionalResult?.statisticsTrack === "shadow-provisional"
        && row.resultProvenance === null
        && row.scoreHome === undefined
        && row.scoreAway === undefined
      ))
    ), {
      rows: provisionalResultRows.length,
      fields: provisionalResultRows.slice(0, 3).map((row) => ({
        id: row.id,
        status: row.status,
        score: row.provisionalResult?.scoreText || null,
        official: row.provisionalResult?.official ?? null,
        trusted: row.provisionalResult?.trusted ?? null,
        formalScoreLeaked: row.scoreHome !== undefined || row.scoreAway !== undefined
      }))
    });
    pushCheck(checks, "current list retains audited model-only reference evidence", (
      modelOnlyReferenceRows.every((row) => (
        row?.probabilityModel?.inputSufficiency?.sufficient === true
        && row?.probabilityModel?.unifiedPosterior?.selectedMarket === "MODEL_ONLY_1X2"
        && String(row?.probabilityModel?.unifiedPosterior?.policy || "").includes("observation-only")
        && row?.probabilityModel?.publicDecision?.directionPublished !== false
      ))
    ), {
      rows: modelOnlyReferenceRows.length,
      fields: modelOnlyReferenceRows.slice(0, 3).map((row) => ({
        sufficient: row?.probabilityModel?.inputSufficiency?.sufficient ?? null,
        selectedMarket: row?.probabilityModel?.unifiedPosterior?.selectedMarket ?? null,
        policy: row?.probabilityModel?.unifiedPosterior?.policy ?? null,
        directionPublished: row?.probabilityModel?.publicDecision?.directionPublished ?? null
      }))
    });
    pushCheck(checks, "initial current list omits terminal backfill", (
      current.body?.transition?.enabled === false
      && current.body?.transition?.count === 0
      && current.body?.transition?.maxRows === 0
      && Array.isArray(current.body?.transitionRows)
      && current.body.transitionRows.length === 0
    ), {
      enabled: current.body?.transition?.enabled ?? null,
      transitionRows: current.body?.transitionRows?.length ?? null,
      maxRows: current.body?.transition?.maxRows ?? null
    });
    const unsafeTransitionRows = transitionRows.filter((row) => (
      row?.status !== "FINISHED"
      || row?.effectiveStatus !== "FINISHED"
      || row?.resultProvenance?.provider !== "sporttery"
      || row?.resultProvenance?.official !== true
      || row?.resultProvenance?.trusted !== true
      || !Number.isInteger(row?.scoreHome)
      || !Number.isInteger(row?.scoreAway)
      || hasHeavyListFields(row)
      || row?.gptPrediction !== undefined
      || row?.probabilityModel !== undefined
      || row?.externalSignals !== undefined
    ));
    const currentIds = new Set(bridgeCurrentRows.map((row) => row?.id).filter(Boolean));
    const transitionIds = transitionRows.map((row) => row?.id).filter(Boolean);
    const transitionSourceMatchIds = transitionRows.map((row) => row?.sourceMatchId).filter(Boolean);
    pushCheck(checks, "current list atomic terminal bridge contract", (
      currentWithBridge.status === 200
      && currentWithBridge.body?.transition?.version === "current-history-transition-v1"
      && currentWithBridge.body?.transition?.enabled === true
      && currentWithBridge.body?.transition?.count === transitionRows.length
      && Number(currentWithBridge.body?.transition?.maxRows) >= transitionRows.length
      && Number(currentWithBridge.body?.transition?.maxRows) >= 1
      && Number(currentWithBridge.body?.transition?.maxRows) <= 32
      && Number(currentWithBridge.body?.transition?.hardMaxRows) === 32
      && Number(currentWithBridge.body?.transition?.batchCount) <= transitionRows.length
      && Number(currentWithBridge.body?.transition?.supplementalCount) <= 4
      && Number(currentWithBridge.body?.transition?.batchCount)
        + Number(currentWithBridge.body?.transition?.supplementalCount) === transitionRows.length
      && currentWithBridge.body?.currentRead?.count === bridgeCurrentRows.length
      && unsafeTransitionRows.length === 0
      && transitionIds.length === transitionRows.length
      && new Set(transitionIds).size === transitionIds.length
      && transitionSourceMatchIds.length === transitionRows.length
      && new Set(transitionSourceMatchIds).size === transitionSourceMatchIds.length
      && transitionRows.every((row) => !currentIds.has(row.id))
    ), {
      currentRows: bridgeCurrentRows.length,
      currentReadCount: currentWithBridge.body?.currentRead?.count ?? null,
      transitionRows: transitionRows.length,
      transitionCount: currentWithBridge.body?.transition?.count ?? null,
      transitionMaxRows: currentWithBridge.body?.transition?.maxRows ?? null,
      unsafeTransitionIds: unsafeTransitionRows.map((row) => row?.id).slice(0, 10)
    });
    const lifecycleNow = Date.now();
    const overdueScheduledRows = currentRows.filter((row) => {
      const kickoffAt = Date.parse(row?.kickoffTime || "");
      return row?.status === "SCHEDULED"
        && Number.isFinite(kickoffAt)
        && lifecycleNow - kickoffAt >= 130 * 60 * 1000;
    });
    const postKickoffRecommendations = currentRows.filter((row) => {
      const kickoffAt = Date.parse(row?.kickoffTime || "");
      return Number.isFinite(kickoffAt)
        && kickoffAt <= lifecycleNow
        && (row?.predictions || []).some((prediction) => (
          prediction?.marketType === "BEST" && prediction?.recommendationAction === "recommend"
        ));
    });
    pushCheck(checks, "current lifecycle is monotonic and post-kickoff recommendation is closed", (
      overdueScheduledRows.length === 0
      && postKickoffRecommendations.length === 0
      && currentRows.every((row) => row?.effectiveStatus === row?.status && typeof row?.statusReason === "string")
    ), {
      overdueScheduledIds: overdueScheduledRows.map((row) => row.id).slice(0, 10),
      postKickoffRecommendationIds: postKickoffRecommendations.map((row) => row.id).slice(0, 10),
      lifecycleRows: currentRows.filter((row) => row?.effectiveStatus === row?.status).length
    });

    const current304 = current.headers.etag
      ? await request("GET", "/api/v1/matches/current?view=list", null, { ...accessHeaders, "if-none-match": current.headers.etag })
      : { status: 0 };
    pushCheck(checks, "current list etag 304", current304.status === 304, {
      status: current304.status
    });

    const currentSince = current.body?.version
      ? await request("GET", `/api/v1/matches/current?view=list&since=${encodeURIComponent(current.body.version)}`, null, accessHeaders)
      : { status: 0, body: null };
    pushCheck(checks, "current since flag", currentSince.status === 200 && currentSince.body?.notModified === true, {
      status: currentSince.status,
      notModified: currentSince.body?.notModified ?? null
    });

    const currentRevision = Number(current.body?.revisionToken);
    const currentSinceWithRevision = current.body?.version && Number.isFinite(currentRevision)
      ? await request(
          "GET",
          `/api/v1/matches/current?view=list&since=${encodeURIComponent(current.body.version)}&revision=${encodeURIComponent(currentRevision)}`,
          null,
          accessHeaders
        )
      : { status: 0, body: null };
    const currentSinceWrongRevision = current.body?.version && Number.isFinite(currentRevision)
      ? await request(
          "GET",
          `/api/v1/matches/current?view=list&since=${encodeURIComponent(current.body.version)}&revision=${encodeURIComponent(currentRevision + 1)}`,
          null,
          accessHeaders
        )
      : { status: 0, body: null };
    pushCheck(checks, "current since revision is exact when supplied", (
      currentSinceWithRevision.status === 200
      && currentSinceWithRevision.body?.notModified === true
      && currentSinceWrongRevision.status === 200
      && currentSinceWrongRevision.body?.notModified === false
    ), {
      revisionToken: Number.isFinite(currentRevision) ? currentRevision : null,
      matchingRevisionNotModified: currentSinceWithRevision.body?.notModified ?? null,
      wrongRevisionNotModified: currentSinceWrongRevision.body?.notModified ?? null
    });

    const historyClamp = await request("GET", "/api/v1/matches/history?limit=999", null, accessHeaders);
    const historyRows = Array.isArray(historyClamp.body?.rows) ? historyClamp.body.rows : [];
    pushCheck(checks, "history limit clamp", historyClamp.status === 200 && historyClamp.body?.apiVersion === "v1" && historyClamp.body?.pageInfo?.limit === 200 && historyRows.length <= 200, {
      status: historyClamp.status,
      limit: historyClamp.body?.pageInfo?.limit ?? null,
      rows: historyRows.length,
      hasMore: historyClamp.body?.pageInfo?.hasMore ?? null
    });
    const historyCoverage = await collectHistoryPages(historyClamp, accessHeaders);
    pushCheck(checks, "history pagination exhausts one stable revision", historyCoverage.ok, {
      pages: historyCoverage.pageCount,
      rows: historyCoverage.rows.length,
      totalAvailable: historyCoverage.totalAvailable,
      revisionToken: historyCoverage.revisionToken,
      version: historyCoverage.version,
      issues: historyCoverage.issues
    });
    const verifiedHistoryRows = historyCoverage.rows;
    const officialFinishedWithoutProvenance = verifiedHistoryRows.filter((row) => (
      row?.status === "FINISHED"
      && !hasTrustedOfficialResultProvenance(row)
    ));
    pushCheck(checks, "finished history exposes verified result provenance", (
      historyCoverage.ok && verifiedHistoryRows.length > 0 && officialFinishedWithoutProvenance.length === 0
    ), {
      rows: verifiedHistoryRows.length,
      missingProvenanceIds: officialFinishedWithoutProvenance.map((row) => row.id).slice(0, 10)
    });
    const reviewedHistoryRows = verifiedHistoryRows.filter((row) => row?.postMatchReview);
    const reviewRowsWithoutClock = reviewedHistoryRows.filter((row) => (
      !Number.isSafeInteger(Number(row.postMatchReview?.settlement?.resultRevision))
      || Number(row.postMatchReview.settlement.resultRevision) <= 0
      || !Number.isFinite(Date.parse(row.postMatchReview?.settlement?.reviewGeneratedAt || ""))
    ));
    pushCheck(checks, "history reviews expose a monotonic revision clock", (
      historyCoverage.ok
      && reviewedHistoryRows.length > 0
      && reviewRowsWithoutClock.length === 0
      && Number.isSafeInteger(historyCoverage.revisionToken)
      && historyCoverage.revisionToken >= 0
      && Number.isFinite(Date.parse(historyCoverage.version || ""))
    ), {
      reviewedRows: reviewedHistoryRows.length,
      missingClockIds: reviewRowsWithoutClock.map((row) => row.id).slice(0, 10),
      revisionToken: historyCoverage.revisionToken,
      version: historyCoverage.version,
      pages: historyCoverage.pageCount,
      totalAvailable: historyCoverage.totalAvailable
    });

    const unresolvedArchive = await request(
      "GET",
      "/api/v1/matches/unresolved-archive?limit=200",
      null,
      accessHeaders
    );
    const unresolvedArchiveRows = Array.isArray(unresolvedArchive.body?.rows)
      ? unresolvedArchive.body.rows
      : [];
    const unresolvedArchivedBestRows = unresolvedArchiveRows.filter((row) => (
      row?.predictions?.some((prediction) => prediction?.marketType === "BEST")
    ));
    const unresolvedArchivedBestProjectionOk = unresolvedArchivedBestRows.every((row) => (
      Number.isFinite(Date.parse(row?.predictionMeta?.generatedAt || ""))
      && row.predictions.some((prediction) => (
        prediction?.marketType === "BEST"
        && ["HAD", "HHAD"].includes(prediction?.oddsPoolCode)
        && ["1", "X", "2"].includes(prediction?.tipCode)
      ))
    ));
    pushCheck(checks, "protected unresolved archive restores immutable pre-match directions", (
      unresolvedArchive.status === 200
      && unresolvedArchive.body?.apiVersion === "v1"
      && unresolvedArchive.body?.source === "server-private-unresolved-archive"
      && unresolvedArchiveRows.every((row) => row?.status === "PENDING_RESULT")
      && unresolvedArchivedBestProjectionOk
    ), {
      status: unresolvedArchive.status,
      rows: unresolvedArchiveRows.length,
      archivedBestRows: unresolvedArchivedBestRows.length,
      totalAvailable: unresolvedArchive.body?.pageInfo?.totalAvailable ?? null
    });

    const historyPage1 = await request("GET", "/api/v1/matches/history?limit=2", null, accessHeaders);
    const page1Rows = Array.isArray(historyPage1.body?.rows) ? historyPage1.body.rows : [];
    const nextCursor = historyPage1.body?.pageInfo?.nextCursor || "";
    const historyPage2 = nextCursor
      ? await request("GET", `/api/v1/matches/history?limit=2&cursor=${encodeURIComponent(nextCursor)}`, null, accessHeaders)
      : { status: 0, body: null };
    const page2Rows = Array.isArray(historyPage2.body?.rows) ? historyPage2.body.rows : [];
    pushCheck(checks, "history cursor pagination", historyPage1.status === 200 && historyPage2.status === 200 && page1Rows.length > 0 && page2Rows.length > 0 && page1Rows[0]?.id !== page2Rows[0]?.id, {
      page1Rows: page1Rows.length,
      page2Rows: page2Rows.length,
      nextCursor: Boolean(nextCursor)
    });

    const detailNoAuth = matchId ? await request("GET", `/api/v1/matches/${encodeURIComponent(matchId)}`) : { status: 0 };
    pushCheck(checks, "match detail requires access", detailNoAuth.status === 401, {
      status: detailNoAuth.status,
      matchId: matchId || null
    });

    let detail = { status: 0, body: null, headers: {} };
    let recommendationBoundaryModel = { status: 0, body: null };
    let recommendationBoundaryRiskTier = "unknown";
    let recommendationBoundaryAttempts = 0;
    if (matchId) {
      // Model artifacts and immutable match generations can switch between
      // two distant requests in this long-running contract suite. Re-read the
      // risk tier immediately beside the protected detail and retry only when
      // the two responses report different publication-era risk tiers.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        recommendationBoundaryAttempts = attempt;
        recommendationBoundaryModel = await request("GET", "/api/v1/model/evaluation");
        recommendationBoundaryRiskTier = recommendationBoundaryModel.body?.backtest?.riskTiers?.overall?.tier || "unknown";
        detail = await request("GET", `/api/v1/matches/${encodeURIComponent(matchId)}`, null, accessHeaders);
        if (detail.status === 200
          && detail.body?.recommendationRiskTier === recommendationBoundaryRiskTier) {
          break;
        }
        if (attempt < 3) await sleep(250);
      }
    }
    pushCheck(checks, "match detail contract", detail.status === 200 && detail.body?.apiVersion === "v1" && detail.body?.match?.id === matchId && detail.body?.predictionLock && detail.body?.sourceHealth && !detail.body?.match?.gptPrediction?.relay, {
      status: detail.status,
      matchId,
      hasPredictionLock: Boolean(detail.body?.predictionLock),
      hasSourceHealth: Boolean(detail.body?.sourceHealth),
      hasEtag: Boolean(detail.headers.etag)
    });
    const listMatch = currentRows.find((row) => row?.id === matchId);
    const detailMatch = detail.body?.match;
    const predictionIdentity = (prediction) => JSON.stringify([
      prediction?.marketType || null,
      prediction?.oddsPoolCode || null,
      prediction?.handicapLine ?? null,
      prediction?.tipCode || null
    ]);
    const listPredictionByIdentity = new Map(
      (Array.isArray(listMatch?.predictions) ? listMatch.predictions : [])
        .map((prediction) => [predictionIdentity(prediction), prediction])
    );
    const criticalDetailPredictions = (Array.isArray(detailMatch?.predictions) ? detailMatch.predictions : [])
      .filter((prediction) => (
        prediction?.marketType === "BEST"
        || prediction?.marketType === "GOALS"
        || ["HAD", "HHAD"].includes(String(prediction?.oddsPoolCode || "").toUpperCase())
      ));
    const missingCriticalListPredictions = criticalDetailPredictions
      .filter((prediction) => !listPredictionByIdentity.has(predictionIdentity(prediction)))
      .map(predictionIdentity);
    const detailModelHealthPresent = Object.prototype.hasOwnProperty.call(
      detailMatch?.probabilityModel || {},
      "modelHealth"
    );
    const listModelHealthPresent = Object.prototype.hasOwnProperty.call(
      listMatch?.probabilityModel || {},
      "modelHealth"
    );
    const expandedDetailLiveFields = (Array.isArray(detailMatch?.predictions) ? detailMatch.predictions : [])
      .flatMap((prediction) => Object.keys(prediction?.liveRecommendation || {}))
      .filter((key) => !allowedCurrentListLiveRecommendationFields.has(key));
    pushCheck(checks, "current list compaction leaves detail payload and result markets intact", (
      detail.status === 200
      && Boolean(listMatch)
      && listModelHealthPresent === false
      && detailModelHealthPresent === true
      && expandedDetailLiveFields.length > 0
      && JSON.stringify(listMatch?.odds || null) === JSON.stringify(detailMatch?.odds || null)
      && JSON.stringify(listMatch?.handicapOdds || null) === JSON.stringify(detailMatch?.handicapOdds || null)
      && String(listMatch?.handicapLine ?? "") === String(detailMatch?.handicapLine ?? "")
      && criticalDetailPredictions.length > 0
      && missingCriticalListPredictions.length === 0
    ), {
      matchId,
      listModelHealthPresent,
      detailModelHealthPresent,
      expandedDetailLiveFields: [...new Set(expandedDetailLiveFields)].slice(0, 12),
      criticalDetailPredictions: criticalDetailPredictions.map(predictionIdentity),
      missingCriticalListPredictions
    });
    const currentArchivedRows = currentRows.filter((row) => row?.archivedPreMatchPrediction);
    const currentResultRows = currentRows.filter((row) => row?.resultProvenance);
    pushCheck(checks, "current list retains immutable archive and official result fields", (
      // A valid current lane may contain only future fixtures. In that case
      // there is no result/archive record to inspect yet; require evidence
      // whenever either result-phase field is actually present.
      (currentArchivedRows.length > 0 || currentResultRows.length > 0)
        ? (
      currentArchivedRows.every((row) => (
        row.archivedPreMatchPrediction?.version === "archived-pre-match-prediction-v1"
        && row.archivedPreMatchPrediction?.prediction?.marketType === "BEST"
        && ["HAD", "HHAD"].includes(row.archivedPreMatchPrediction?.prediction?.oddsPoolCode)
        && ["1", "X", "2"].includes(row.archivedPreMatchPrediction?.prediction?.tipCode)
      ))
      && currentResultRows.every((row) => (
        Number.isInteger(row.scoreHome)
        && Number.isInteger(row.scoreAway)
        && row.resultProvenance?.official === true
        && row.resultProvenance?.trusted === true
      )))
        : true
    ), {
      archivedRows: currentArchivedRows.length,
      resultRows: currentResultRows.length,
      archivedIds: currentArchivedRows.map((row) => row.id).slice(0, 10),
      resultIds: currentResultRows.map((row) => row.id).slice(0, 10)
    });
    const listDualMarketBinding = listMatch?.predictionMeta?.dualMarketDecision || null;
    const detailDualMarketBinding = detail.body?.match?.predictionMeta?.dualMarketDecision || null;
    pushCheck(checks, "list and detail share one verified dual-market decision", (
      detail.status === 200
      && Boolean(listDualMarketBinding) === Boolean(detailDualMarketBinding)
      && (
        !listDualMarketBinding
        || (
          listDualMarketBinding.integrityVerified === true
          && detailDualMarketBinding?.integrityVerified === true
          && !Object.prototype.hasOwnProperty.call(listDualMarketBinding, "featureSnapshot")
          && !Object.prototype.hasOwnProperty.call(detailDualMarketBinding, "featureSnapshot")
          && verifyCompactDualMarketDecisionBinding(listDualMarketBinding).valid === true
          && verifyCompactDualMarketDecisionBinding(detailDualMarketBinding).valid === true
          && listDualMarketBinding.bindingHash === detailDualMarketBinding.bindingHash
          && listDualMarketBinding.publicBindingHash === detailDualMarketBinding.publicBindingHash
          && listDualMarketBinding.had?.code === detailDualMarketBinding.had?.code
          && listDualMarketBinding.hhad?.code === detailDualMarketBinding.hhad?.code
        )
      )
    ), {
      matchId,
      listBinding: Boolean(listDualMarketBinding),
      detailBinding: Boolean(detailDualMarketBinding),
      bindingHashMatches: listDualMarketBinding?.bindingHash === detailDualMarketBinding?.bindingHash,
      listPublicBindingValid: listDualMarketBinding
        ? verifyCompactDualMarketDecisionBinding(listDualMarketBinding).valid
        : null,
      detailPublicBindingValid: detailDualMarketBinding
        ? verifyCompactDualMarketDecisionBinding(detailDualMarketBinding).valid
        : null
    });

    const globalRiskTier = recommendationBoundaryRiskTier;
    pushCheck(checks, "v1 scheduled BEST recommendations fail closed at server boundary",
      recommendationBoundaryModel.status === 200
      && detail.status === 200
      && detail.body?.recommendationRiskTier === globalRiskTier
      && scheduledBestRecommendationsAreServerSafe(detail.body?.match, globalRiskTier), {
      status: detail.status,
      modelStatus: recommendationBoundaryModel.status,
      attempts: recommendationBoundaryAttempts,
      globalRiskTier,
      payloadRiskTier: detail.body?.recommendationRiskTier || null,
      bestActions: (detail.body?.match?.predictions || [])
        .filter((prediction) => prediction?.marketType === "BEST")
        .map((prediction) => prediction.recommendationAction ?? null)
    });

    const legacyDetail = matchId
      ? await request("GET", `/api/matches/${encodeURIComponent(matchId)}`, null, accessHeaders)
      : { status: 0, body: null };
    pushCheck(checks, "legacy match detail enforces recommendation boundary before response", legacyDetail.status === 200
      && legacyDetail.body?.id === matchId
      && scheduledBestRecommendationsAreServerSafe(legacyDetail.body, globalRiskTier), {
      status: legacyDetail.status,
      matchId,
      globalRiskTier,
      bestActions: (legacyDetail.body?.predictions || [])
        .filter((prediction) => prediction?.marketType === "BEST")
        .map((prediction) => prediction.recommendationAction ?? null)
    });

    const legacyRoot = await request("GET", "/api/matches/root", null, accessHeaders);
    const legacyRootRows = Array.isArray(legacyRoot.body) ? legacyRoot.body : [];
    pushCheck(checks, "legacy root match feed enforces recommendation boundary", legacyRoot.status === 200
      && legacyRootRows.length > 0
      && legacyRootRows.every((match) => scheduledBestRecommendationsAreServerSafe(match, globalRiskTier)), {
      status: legacyRoot.status,
      rows: legacyRootRows.length,
      globalRiskTier
    });

    const detail404 = await request("GET", "/api/v1/matches/not-a-real-match-id", null, accessHeaders);
    pushCheck(checks, "match detail 404 contract", detail404.status === 404 && detail404.body?.error === "match not found", {
      status: detail404.status,
      error: detail404.body?.error || null
    });

    const oddsClamp = await request("GET", "/api/v1/odds/history?limit=999", null, accessHeaders);
    const oddsRows = Array.isArray(oddsClamp.body?.rows) ? oddsClamp.body.rows : [];
    pushCheck(checks, "odds history limit clamp", oddsClamp.status === 200 && oddsClamp.body?.ok === true && oddsClamp.body?.limit === 500 && oddsRows.length <= 500, {
      status: oddsClamp.status,
      source: oddsClamp.body?.source || null,
      limit: oddsClamp.body?.limit ?? null,
      rows: oddsRows.length
    });

    const staticCurrent = await request("GET", "/data/matches-current.json");
    const staticGpt = await request("GET", "/data/gpt-predictions.json");
    const staticModelEvaluation = await request("GET", "/data/model-evaluation.json");
    pushCheck(checks, "large static payloads disabled", staticCurrent.status === 410 && staticGpt.status === 410 && staticModelEvaluation.status === 410, {
      currentStatus: staticCurrent.status,
      gptStatus: staticGpt.status,
      modelEvaluationStatus: staticModelEvaluation.status
    });

    const adminSyncGet = await request("GET", "/api/admin/sync", null, adminToken ? { authorization: `Bearer ${adminToken}` } : {});
    pushCheck(checks, "admin sync method contract", adminSyncGet.status === 405, {
      status: adminSyncGet.status
    });

    const collectorEvidenceGet = await request(
      "GET",
      "/api/admin/sporttery-collector-evidence",
      null,
      adminToken ? { authorization: `Bearer ${adminToken}` } : {},
    );
    const collectorEvidenceUnauthorized = await request(
      "POST",
      "/api/admin/sporttery-collector-evidence?validateOnly=1",
      { version: "sporttery-collector-evidence-upload-v1", endpoints: [] },
    );
    const collectorEvidenceInvalid = await request(
      "POST",
      "/api/admin/sporttery-collector-evidence?validateOnly=1",
      { version: "invalid", endpoints: [] },
      adminToken ? { authorization: `Bearer ${adminToken}` } : {},
    );
    pushCheck(checks, "collector evidence upload is POST-only, bearer-protected and fail-closed", collectorEvidenceGet.status === 405
      && collectorEvidenceUnauthorized.status === 401
      && collectorEvidenceInvalid.status === 400
      && collectorEvidenceInvalid.body?.validateOnly === true
      && Array.isArray(collectorEvidenceInvalid.body?.blockers)
      && collectorEvidenceInvalid.body.blockers.includes("collector-evidence-upload-version-invalid"), {
        getStatus: collectorEvidenceGet.status,
        unauthorizedStatus: collectorEvidenceUnauthorized.status,
        invalidStatus: collectorEvidenceInvalid.status,
        validateOnly: collectorEvidenceInvalid.body?.validateOnly ?? null,
        blockers: collectorEvidenceInvalid.body?.blockers || null,
      });

    const ok = checks.every((check) => check.ok);
    console.log(JSON.stringify({
      ok,
      checkedAt: new Date().toISOString(),
      baseUrl: baseUrl.toString(),
      summary: {
        currentRows: currentRows.length,
        selectedMatchId: matchId || null,
        historyMaxLimit: historyClamp.body?.pageInfo?.limit ?? null,
        historyVerifiedRows: historyCoverage.rows.length,
        historyVerifiedPages: historyCoverage.pageCount,
        oddsMaxLimit: oddsClamp.body?.limit ?? null
      },
      checks
    }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    stopLocalServer();
  }
};

run().catch((error) => {
  stopLocalServer();
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    baseUrl: baseUrl.toString(),
    error: error.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
