const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const {
  publicHhadCompanionSchemaValid,
  findHhadCompanionSensitiveKeyLeaks,
  isNonNegativeInteger
} = require("./hhadCompanionPublicContract.cjs");
const {
  MAX_LATENCY_RECOVERY_ATTEMPTS,
  REQUIRED_LATENCY_RECOVERY_RUNS,
  evaluatePerformanceRecovery,
  isLatencyOnlyPerformanceFailure,
  performanceRunPassed
} = require("./apiPerformanceRecoveryPolicy.cjs");

// Keep independently spawned verifiers away from both the production/dev
// listener and one another. Callers that intentionally target an existing
// service use VERIFY_BASE_URL, while PORT/VERIFY_PORT can still pin a local
// test port. The process-derived default prevents parallel verification jobs
// from accidentally borrowing another verifier's listener.
const autoLocalPort = 20000 + (process.pid % 30000);
const defaultPort = Number(process.env.VERIFY_PORT || process.env.PORT || autoLocalPort);
const explicitBaseUrl = process.env.VERIFY_BASE_URL || "";
const baseUrl = new URL(explicitBaseUrl || `http://127.0.0.1:${defaultPort}`);
const shouldAutoStartLocalServer = !explicitBaseUrl && process.env.VERIFY_START_SERVER !== "0";
const startServer = process.env.VERIFY_START_SERVER === "1" || shouldAutoStartLocalServer;
const requireSqlite = process.env.VERIFY_REQUIRE_SQLITE === "1"
  || (startServer && process.env.VERIFY_REQUIRE_SQLITE !== "0");
const requiredReadSource = String(process.env.VERIFY_REQUIRED_READ_SOURCE || (requireSqlite ? "sqlite" : "")).toLowerCase();
const requireAiArenaPublication = process.env.VERIFY_REQUIRE_AI_ARENA === "1";
const sqlitePrevalidated = requireSqlite
  && !startServer
  && process.env.VERIFY_SQLITE_PREVALIDATED === "1";
const minProbabilityRows = Math.max(1, Number(process.env.VERIFY_MIN_PROBABILITY_ROWS || 1));
const localAdminToken = "production-readiness-local-admin";
const adminToken = process.env.ADMIN_TOKEN || (startServer ? localAdminToken : "");
const accessCodeAdminToken = process.env.ACCESS_CODE_ADMIN_TOKEN || adminToken;
const rootDir = path.resolve(__dirname, "..");
const modelEvaluationArtifactPath = path.join(rootDir, "public", "data", "model-evaluation.json");
const expectedModelEvaluationVersion = "rolling-backtest-v19";
const expectedWalkForwardValidationVersion = "walk-forward-promotion-validation-v3";
const expectedWalkForwardProtocolVersion = "nested-expanding-window-candidate-selection-v2";
const requestTimeoutMs = Math.min(
  60_000,
  Math.max(1_000, Number(process.env.VERIFY_REQUEST_TIMEOUT_MS || 30_000))
);
const childTimeoutMs = Math.min(
  300_000,
  Math.max(5_000, Number(process.env.VERIFY_CHILD_TIMEOUT_MS || 120_000))
);

let child = null;
let childLogs = "";
let childExit = null;

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
      req.destroy(new Error(`production-readiness request timed out after ${requestTimeoutMs}ms: ${method} ${target.pathname}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const sampleRelayEndpoint = ({ method, page = null, cycleId, observedMs, rows = 1 }) => {
  const requestedAt = new Date(observedMs - 500).toISOString();
  const receivedAt = new Date(observedMs).toISOString();
  return {
    id: page === null ? method : `method:${method}:${page}`,
    method,
    ...(page === null ? {} : { page }),
    ok: true,
    rows,
    sourceCycleId: cycleId,
    requestedAt,
    receivedAt,
    fetchedAt: receivedAt,
    collectorProvenance: {
      sourceCycleId: cycleId,
      requestedAt,
      receivedAt
    },
    payload: {
      value: {
        matchInfoList: [{
          subMatchList: Array.from({ length: rows }, (_, index) => ({
            matchId: `verify-${method}-${page ?? 1}-${index + 1}`
          }))
        }]
      }
    }
  };
};

const sampleRelaySnapshot = ({ cycleId, observedMs, endpoints, transport, uploadMode = "full" }) => {
  const requestedAt = new Date(observedMs - 1000).toISOString();
  const completedAt = new Date(observedMs + 250).toISOString();
  return {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt: requestedAt,
    sourceCycleId: cycleId,
    requestedAt,
    completedAt,
    maxAgeMinutes: 20,
    provenanceVersion: 1,
    collectorProvenance: {
      sourceCycleId: cycleId,
      requestedAt,
      completedAt,
      clock: "collector-owned-wall-clock"
    },
    producer: {
      host: "production-readiness",
      platform: process.platform,
      transport,
      uploadMode,
      atomicSubset: false
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows: endpoints.reduce((sum, endpoint) => sum + Number(endpoint.rows || 0), 0),
      errors: 0,
      methods: Array.from(new Set(endpoints.map((endpoint) => endpoint.method))),
      pageDepth: 1,
      resultPageDepth: 1,
      uploadMode
    },
    endpoints,
    errors: []
  };
};

const sampleSportteryRelaySnapshot = () => {
  const observedMs = Date.now() - 1000;
  const cycleId = `production-readiness-full-${observedMs}`;
  return sampleRelaySnapshot({
    cycleId,
    observedMs,
    transport: "validate-only-full",
    endpoints: [
      sampleRelayEndpoint({ method: "current", cycleId, observedMs, rows: 30 }),
      sampleRelayEndpoint({ method: "calculator", cycleId, observedMs: observedMs + 10, rows: 30 }),
      sampleRelayEndpoint({ method: "result", page: 1, cycleId, observedMs: observedMs + 20, rows: 30 }),
      sampleRelayEndpoint({ method: "all", page: 1, cycleId, observedMs: observedMs + 30, rows: 30 })
    ]
  });
};

const sampleSportteryRelayState = () => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  consecutiveCollectFailures: 3,
  lastCollectOkAt: null,
  lastCollectFailedAt: new Date().toISOString(),
  lastUploadOkAt: null,
  lastRemotePrimaryAt: null,
  lastRemoteServingMode: "fallback-degraded",
  lastFailure: {
    capturedAt: new Date().toISOString(),
    rows: 0,
    errors: 2,
    errorClasses: {
      "waf-blocked": 2
    },
    wafBlocked: true,
    sampleErrors: [
      { id: "current", method: "current", class: "waf-blocked" }
    ]
  }
});

const sampleFastSportteryRelaySnapshot = () => {
  const observedMs = Date.now() - 500;
  const cycleId = `production-readiness-fast-${observedMs}`;
  return sampleRelaySnapshot({
    cycleId,
    observedMs,
    transport: "validate-only-fast",
    uploadMode: "current",
    endpoints: [
      sampleRelayEndpoint({ method: "current", cycleId, observedMs, rows: 2 }),
      sampleRelayEndpoint({ method: "calculator", cycleId, observedMs: observedMs + 10, rows: 2 })
    ]
  });
};

const runLocalJson = (args, env = {}) => new Promise((resolve) => {
  const label = args.join(" ");
  const startedAt = Date.now();
  process.stderr.write(`[production-readiness] child-start ${label}\n`);
  const childProcess = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let finished = false;
  let timedOut = false;
  let forceKillTimer = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    stderr += `production-readiness child timed out after ${childTimeoutMs}ms: ${label}\n`;
    process.stderr.write(`[production-readiness] child-timeout ${label} elapsedMs=${Date.now() - startedAt}\n`);
    childProcess.kill("SIGTERM");
    forceKillTimer = setTimeout(() => childProcess.kill("SIGKILL"), 5_000);
    forceKillTimer.unref?.();
  }, childTimeoutMs);
  timeout.unref?.();
  const finish = ({ status, error = null }) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    let body = null;
    try {
      body = JSON.parse(stdout);
    } catch {
      body = null;
    }
    process.stderr.write(`[production-readiness] child-end ${label} status=${status} elapsedMs=${Date.now() - startedAt} timedOut=${timedOut ? 1 : 0}\n`);
    resolve({ status, body, stdout, stderr: error || stderr, timedOut });
  };
  childProcess.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  childProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  childProcess.on("error", (error) => {
    finish({ status: -1, error: error.message || String(error) });
  });
  childProcess.on("exit", (code, signal) => {
    finish({
      status: timedOut ? 124 : (Number.isInteger(code) ? code : -1),
      error: signal && !stderr ? `child exited from signal ${signal}` : null
    });
  });
});

const failedArtifactChecks = (result) => (Array.isArray(result?.body?.checks)
  ? result.body.checks
    .filter((check) => check?.ok !== true)
    .map((check) => check?.name || check?.phase || "unnamed-check")
  : []);

const readModelEvaluationArtifact = () => {
  try {
    const bytes = fs.readFileSync(modelEvaluationArtifactPath);
    return {
      ok: true,
      path: modelEvaluationArtifactPath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      body: JSON.parse(bytes.toString("utf8")),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      path: modelEvaluationArtifactPath,
      sha256: null,
      body: null,
      error: error.message || String(error)
    };
  }
};

const refreshSqliteAfterMutableChecks = async (checks) => {
  if (!requireSqlite) return;
  if (sqlitePrevalidated) {
    const { readSourceCycleObservation } = require("./runSyncWorker.cjs");
    const observation = readSourceCycleObservation({
      phase: "production-readiness-prevalidated",
      validationStep: { ok: true },
      generationStep: { ok: true },
      sqliteStep: { ok: true },
    });
    pushCheck(checks, "prevalidated sqlite projection reused", observation.ready === true, {
      sourceCycleId: observation.public?.sourceCycleId || null,
      generationId: observation.generation?.generationId || null,
      manifestHash: observation.generation?.manifestHash || null,
      sqliteGenerationId: observation.sqlite?.generationId || null,
      sqliteManifestHash: observation.sqlite?.manifestHash || null,
      samePublicationIdentity: observation.samePublicationIdentity === true,
      blockers: observation.blockers || [],
    });
    return;
  }
  const refresh = await runLocalJson(["scripts/exportDataStoreSqlite.cjs"]);
  pushCheck(checks, "sqlite refreshed after mutable checks", refresh.status === 0 && refresh.body?.ok === true, {
    status: refresh.status,
    counts: refresh.body?.counts || null,
    legacyJsonlVersion: refresh.body?.legacyJsonl?.version || null,
    stdoutTail: refresh.status === 0 ? "" : refresh.stdout.slice(-500),
    stderrTail: refresh.stderr.slice(-500)
  });
};

const waitForSqlitePrimaryRead = async (checks, name = "sqlite primary read after refresh") => {
  if (!requiredReadSource) return;
  const timeoutMs = Math.max(1000, Number(process.env.VERIFY_SQLITE_READY_TIMEOUT_MS || 30000));
  const intervalMs = Math.max(250, Number(process.env.VERIFY_SQLITE_READY_INTERVAL_MS || 1000));
  const startedAt = Date.now();
  const attempts = [];
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const health = await request("GET", "/api/v1/health");
      const currentRead = health.body?.data?.currentRead || {};
      const sqlite = health.body?.storage?.sqlite || {};
      const postgres = health.body?.storage?.postgres || {};
      const source = currentRead.source || sqlite.readSource || null;
      attempts.push({
        status: health.status,
        currentReadSource: source,
        sqliteAvailable: sqlite.available ?? null,
        sqliteStale: sqlite.stale ?? null,
        postgresAvailable: postgres.available ?? null,
        dbUpdatedAt: currentRead.dbUpdatedAt || sqlite.syncMetaUpdatedAt || null,
        fileUpdatedAt: currentRead.fileUpdatedAt || null
      });
      const ready = requiredReadSource === "postgres"
        ? postgres.available === true && postgres.baseReady !== false && !postgres.baseBlockedReason && source === "postgres"
        : sqlite.available === true && sqlite.baseReady !== false && !sqlite.baseBlockedReason && source === "sqlite";
      if (health.status === 200 && ready) {
        pushCheck(checks, name, true, {
          attempts: attempts.length,
          timeoutMs,
          currentReadSource: source,
          requiredReadSource,
          sqliteCounts: sqlite.counts || null,
          dbUpdatedAt: currentRead.dbUpdatedAt || sqlite.syncMetaUpdatedAt || null,
          fileUpdatedAt: currentRead.fileUpdatedAt || null
        });
        return;
      }
    } catch (error) {
      attempts.push({
        status: 0,
        error: error.message || String(error)
      });
    }
    await sleep(intervalMs);
  }
  const last = attempts[attempts.length - 1] || null;
  pushCheck(checks, name, false, {
    attempts: attempts.length,
    timeoutMs,
    last,
    recentAttempts: attempts.slice(-5)
  });
};

const refreshSqliteBeforeLocalServer = async (checks) => {
  if (!requireSqlite || !startServer) return;
  const refresh = await runLocalJson(["scripts/exportDataStoreSqlite.cjs"]);
  pushCheck(checks, "sqlite refreshed before local server", refresh.status === 0 && refresh.body?.ok === true, {
    status: refresh.status,
    counts: refresh.body?.counts || null,
    legacyJsonlVersion: refresh.body?.legacyJsonl?.version || null,
    stdoutTail: refresh.status === 0 ? "" : refresh.stdout.slice(-500),
    stderrTail: refresh.stderr.slice(-500)
  });
};

const startLocalServer = async () => {
  const expectedListenerLog = `[football-server] listening on http://${baseUrl.hostname}:${baseUrl.port || defaultPort}`;
  child = spawn(process.execPath, ["server/index.cjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: baseUrl.hostname,
      PORT: String(baseUrl.port || defaultPort),
      ENABLE_SYNC_CRON: process.env.VERIFY_ENABLE_SYNC_CRON === "1" ? "1" : "0",
      ENABLE_GPT_CRON: process.env.VERIFY_ENABLE_GPT_CRON === "1" ? "1" : "0",
      ADMIN_TOKEN: process.env.ADMIN_TOKEN || adminToken,
      ACCESS_CODE_ADMIN_TOKEN: process.env.ACCESS_CODE_ADMIN_TOKEN || accessCodeAdminToken,
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
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  for (let i = 0; i < 50; i += 1) {
    await sleep(250);
    if (childExit) {
      throw new Error(
        `local verification server exited before readiness `
        + `(code=${childExit.code ?? "null"}, signal=${childExit.signal || "none"})\n${childLogs.slice(-2000)}`
      );
    }
    if (childLogs.includes(expectedListenerLog)) {
      try {
        const health = await request("GET", "/api/v1/health");
        if (health.status === 200 && health.body) {
          return {
            pid: child.pid,
            port: Number(baseUrl.port || defaultPort),
            expectedListenerLog,
            listenerOwned: true
          };
        }
      } catch {
        // The child owns the listener but has not completed API warm-up yet.
      }
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
  const postgresMigrationPlan = await runLocalJson(["scripts/verifyPostgresMigrationPlan.cjs"]);
  pushCheck(
    checks,
    "PostgreSQL applied migrations remain immutable",
    postgresMigrationPlan.status === 0
      && postgresMigrationPlan.body?.ok === true
      && postgresMigrationPlan.body?.verifier === "postgres-migration-plan",
    {
      status: postgresMigrationPlan.status,
      verifier: postgresMigrationPlan.body?.verifier || null,
      migrations: postgresMigrationPlan.body?.migrations || [],
      stdoutTail: postgresMigrationPlan.status === 0 ? "" : postgresMigrationPlan.stdout.slice(-500),
      stderrTail: postgresMigrationPlan.stderr.slice(-500),
    },
  );
  const fixtureIsolation = await runLocalJson(["scripts/verifyProductionFixtureIsolation.cjs"]);
  pushCheck(checks, "temporary verifier servers reject inherited production database settings",
    fixtureIsolation.status === 0 && fixtureIsolation.body?.ok === true
      && fixtureIsolation.body?.checks?.length === 3
      && fixtureIsolation.body.checks.every((check) => check.ok === true), {
      status: fixtureIsolation.status,
      checks: fixtureIsolation.body?.checks || [],
      stdoutTail: fixtureIsolation.status === 0 ? "" : fixtureIsolation.stdout.slice(-500),
      stderrTail: fixtureIsolation.stderr.slice(-500),
    });
  const dataValidationScopes = await runLocalJson(["scripts/verifyDataValidationScopes.cjs"]);
  const fixtureRetry = await runLocalJson(["scripts/verifyFootballDataFixtureRetry.cjs"]);
  pushCheck(checks, "failed supplementary fixtures back off without changing successful snapshot freshness",
    fixtureRetry.status === 0 && fixtureRetry.body?.ok === true
      && fixtureRetry.body?.verifier === "football-data-fixture-retry-v1"
      && fixtureRetry.body?.productionDataTouched === false
      && fixtureRetry.body?.checks?.length === 18
      && fixtureRetry.body.checks.every(check => check.ok === true), {
      status: fixtureRetry.status, checks: fixtureRetry.body?.checks || [],
      stderrTail: fixtureRetry.stderr.slice(-500),
    });
  pushCheck(checks, "Pages scope cannot weaken server private-archive validation",
    dataValidationScopes.status === 0 && dataValidationScopes.body?.ok === true
      && dataValidationScopes.body?.checks === 70 && dataValidationScopes.body?.productionDataTouched === false
      && dataValidationScopes.body?.fullPublicFileRuns === 2 && dataValidationScopes.body?.fixtureDataReads === 201
      && dataValidationScopes.body?.strictFinishedScoreCases === 46, {
      status: dataValidationScopes.status, checks: dataValidationScopes.body?.checks || 0,
      stdoutTail: dataValidationScopes.status === 0 ? "" : dataValidationScopes.stdout.slice(-500),
      stderrTail: dataValidationScopes.stderr.slice(-500),
    });
  const publicationIdentityCache = await runLocalJson(["scripts/verifySqlitePublicationIdentityCache.cjs"]);
  pushCheck(checks, "SQLite publication identity cache follows WAL commits without checkpoint",
    publicationIdentityCache.status === 0 && publicationIdentityCache.body?.ok === true
      && publicationIdentityCache.body?.checks?.length === 11
      && publicationIdentityCache.body.checks.every((check) => check.ok === true), {
      status: publicationIdentityCache.status,
      checks: publicationIdentityCache.body?.checks || [],
      stdoutTail: publicationIdentityCache.status === 0 ? "" : publicationIdentityCache.stdout.slice(-500),
      stderrTail: publicationIdentityCache.stderr.slice(-500),
    });
  await refreshSqliteBeforeLocalServer(checks);
  const publicReferenceIntegrity = await runLocalJson(["scripts/verifyPublicReferenceIntegrity.cjs"]);
  pushCheck(checks, "public reference survives cutoff and provider changes; missing values stay missing",
    publicReferenceIntegrity.status === 0 && publicReferenceIntegrity.body?.ok === true, {
      status: publicReferenceIntegrity.status, checks: publicReferenceIntegrity.body?.checks || 0,
      stderrTail: publicReferenceIntegrity.stderr.slice(-500),
    });
  const clubResultReceipts = await runLocalJson(["scripts/verifyOfficialClubReceiptClocks.cjs"]);
  pushCheck(checks, "official club receipt clocks follow complete responses and preserve newer evidence",
    clubResultReceipts.status === 0 && clubResultReceipts.body?.ok === true
      && clubResultReceipts.body?.checks >= 21
      && clubResultReceipts.body?.networkCalls === 0
      && clubResultReceipts.body?.productionDataTouched === false, {
      status: clubResultReceipts.status, checks: clubResultReceipts.body?.checks || 0,
      stderrTail: clubResultReceipts.stderr.slice(-500),
    });
  const competitionContext = await runLocalJson(["scripts/verifyCompetitionModelContext.cjs"]);
  pushCheck(checks, "model competition weights ignore team labels and preserve executed context",
    competitionContext.status === 0 && competitionContext.body?.ok === true
      && competitionContext.body?.checks >= 16 && competitionContext.body?.productionWrites === 0, {
      status: competitionContext.status, checks: competitionContext.body?.checks || 0,
      stderrTail: competitionContext.stderr.slice(-500),
    });
  const executionCapture = await runLocalJson(["scripts/verifyPredictionExecutionCapture.cjs"]);
  pushCheck(checks, "private prediction execution capture preserves exact inputs and never rewrites locked outputs",
    executionCapture.status === 0 && executionCapture.body?.ok === true
      && executionCapture.body?.checks >= 49 && executionCapture.body?.retentionChecks >= 18
      && executionCapture.body?.writerLockChecks >= 9
      && executionCapture.body?.realRetainedBatches >= 513
      && executionCapture.body?.retentionPolicyVersion === "prediction-capture-capacity-v2"
      && executionCapture.body?.productionDataTouched === false
      && executionCapture.body?.providerRequests === 0, {
      status: executionCapture.status, checks: executionCapture.body?.checks || 0,
      stderrHead: executionCapture.status === 0 ? "" : executionCapture.stderr.slice(0, 500),
      stderrTail: executionCapture.stderr.slice(-500),
    });
  const executionClock = await runLocalJson(["scripts/verifyPredictionExecutionClock.cjs"]);
  pushCheck(checks, "prediction clock replays entire outputs without ignoring fields or forging observation times",
    executionClock.status === 0 && executionClock.body?.ok === true
      && executionClock.body?.checks >= 14 && executionClock.body?.productionDataTouched === false
      && executionClock.body?.providerRequests === 0 && executionClock.body?.fullOutputFieldsIgnored === 0, {
      status: executionClock.status, checks: executionClock.body?.checks || 0,
      stderrTail: executionClock.stderr.slice(-500),
    });
  const predictionReplay = await runLocalJson(["scripts/verifyPredictionReplay.cjs"]);
  pushCheck(checks, "independent prediction replay requires exact executable runtime and rejects corrupt records",
    predictionReplay.status === 0 && predictionReplay.body?.ok === true && predictionReplay.body?.checks >= 13
      && predictionReplay.body?.independentChildRuns >= 1 && predictionReplay.body?.productionDataTouched === false
      && predictionReplay.body?.providerRequests === 0 && predictionReplay.body?.fullOutputFieldsIgnored === 0, {
      status: predictionReplay.status, checks: predictionReplay.body?.checks || 0,
      stderrHead: predictionReplay.status === 0 ? "" : predictionReplay.stderr.slice(0, 500),
      stderrTail: predictionReplay.stderr.slice(-500),
    });
  const localServerOwnership = startServer ? await startLocalServer() : null;

  try {
    if (startServer) {
      pushCheck(checks, "local verification listener owned by child", localServerOwnership?.listenerOwned === true, {
        pid: localServerOwnership?.pid || null,
        port: localServerOwnership?.port || null,
        expectedListenerLog: localServerOwnership?.expectedListenerLog || null
      });
    }
    const runtime = await request("GET", "/data/runtime-config.json");
    pushCheck(checks, "runtime config", runtime.status === 200, {
      status: runtime.status,
      dataApiBase: runtime.body?.dataApiBase || null
    });

    const health = await request("GET", "/api/v1/health");
    const sqlite = health.body?.storage?.sqlite || null;
    const healthStatus = health.body?.status || {};
    const runtimeStoreDir = process.env.SERVER_STORE_DIR
      || process.env.DATA_STORE_DIR
      || (sqlite?.path ? path.dirname(sqlite.path) : "");
    const runtimeStoreEnv = {
      ...(runtimeStoreDir ? { SERVER_STORE_DIR: runtimeStoreDir, DATA_STORE_DIR: runtimeStoreDir } : {}),
      ...(sqlite?.path ? { DATASTORE_SQLITE_PATH: sqlite.path } : {})
    };
    const sqliteServiceable = Boolean(sqlite?.available) && (
      !sqlite?.stale
      || healthStatus.dataFresh === true
      || healthStatus.fallbackDataFresh === true
    );
    pushCheck(checks, "v1 health", health.status === 200 && health.body?.apiVersion === "v1", {
      status: health.status,
      ok: health.body?.ok,
      bytes: health.bytes
    });
    const fastWatcherHealth = health.body?.sync?.fastResultWatcher || null;
    pushCheck(checks, "relay fast watcher health contract", Boolean(fastWatcherHealth)
      && typeof fastWatcherHealth.enabled === "boolean"
      && Number.isFinite(Number(fastWatcherHealth.pollMs))
      && Object.prototype.hasOwnProperty.call(fastWatcherHealth, "lastCheckedAt")
      && Object.prototype.hasOwnProperty.call(fastWatcherHealth, "lastPublishedAt")
      && Object.prototype.hasOwnProperty.call(fastWatcherHealth, "lastLatencyMs")
      && Object.prototype.hasOwnProperty.call(fastWatcherHealth, "lastError"), {
      fastResultWatcher: fastWatcherHealth
    });
    pushCheck(checks, "sqlite status", !requireSqlite || sqliteServiceable, {
      required: requireSqlite,
      available: Boolean(sqlite?.available),
      stale: Boolean(sqlite?.stale),
      dataFresh: healthStatus.dataFresh ?? null,
      fallbackDataFresh: healthStatus.fallbackDataFresh ?? null,
      servingMode: healthStatus.servingMode || null,
      counts: sqlite?.counts || null
    });
    const legacyJsonlVersion = sqlite?.legacyJsonl?.version || null;
    const legacyJsonlImportOk = legacyJsonlVersion === "legacy-jsonl-import-v1"
      || (legacyJsonlVersion === "legacy-jsonl-incremental-v2"
        && sqlite?.legacyJsonl?.files
        && typeof sqlite.legacyJsonl.files === "object");
    pushCheck(checks, "sqlite legacy jsonl import", !requireSqlite || legacyJsonlImportOk, {
      required: requireSqlite,
      version: legacyJsonlVersion,
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

    const workerCadenceArtifact = await runLocalJson(["scripts/verifySyncWorkerCadence.cjs"]);
    pushCheck(checks, "sync worker official-result-first pipeline", workerCadenceArtifact.status === 0
      && workerCadenceArtifact.body?.ok === true
      && workerCadenceArtifact.body?.officialFirst === true
      && workerCadenceArtifact.body?.officialReconciliationBeforeGeneration === true
      && workerCadenceArtifact.body?.failedOfficialReconciliationPreventsPublication === true
      && workerCadenceArtifact.body?.fullSyncRunsPerCycle === 1, {
      status: workerCadenceArtifact.status,
      stages: workerCadenceArtifact.body?.stages || null,
      fullSyncRunsPerCycle: workerCadenceArtifact.body?.fullSyncRunsPerCycle ?? null,
      stdoutTail: workerCadenceArtifact.status === 0 ? "" : workerCadenceArtifact.stdout.slice(-500),
      stderrTail: workerCadenceArtifact.stderr.slice(-500)
    });

    const releaseEnrichmentReuse = await runLocalJson(["scripts/verifyReleaseEnrichmentReuse.cjs"]);
    const releaseEnrichmentReuseChecks = Array.isArray(releaseEnrichmentReuse.body?.checks)
      ? releaseEnrichmentReuse.body.checks
      : [];
    pushCheck(checks, "release enrichment reuse is hash-bound and fail-closed",
      releaseEnrichmentReuse.status === 0
      && releaseEnrichmentReuse.body?.ok === true
      && releaseEnrichmentReuse.body?.verifier === "release-enrichment-reuse"
      && releaseEnrichmentReuseChecks.length >= 10
      && releaseEnrichmentReuseChecks.every((check) => check?.ok === true), {
        status: releaseEnrichmentReuse.status,
        assertions: releaseEnrichmentReuse.body?.assertions ?? null,
        failedChecks: releaseEnrichmentReuseChecks
          .filter((check) => check?.ok !== true)
          .map((check) => check?.name || "unnamed-check"),
        stdoutTail: releaseEnrichmentReuse.status === 0
          ? ""
          : releaseEnrichmentReuse.stdout.slice(-500),
        stderrTail: releaseEnrichmentReuse.stderr.slice(-500)
      });

    const fastResultPublication = await runLocalJson(["scripts/verifyFastResultPublication.cjs"]);
    pushCheck(checks, "official result SQLite fast publication", fastResultPublication.status === 0
      && fastResultPublication.body?.ok === true
      && Number(fastResultPublication.body?.summary?.failed || 0) === 0, {
      status: fastResultPublication.status,
      summary: fastResultPublication.body?.summary || null,
      stdoutTail: fastResultPublication.status === 0 ? "" : fastResultPublication.stdout.slice(-500),
      stderrTail: fastResultPublication.stderr.slice(-500)
    });

    const relayFastWatcher = await runLocalJson(["scripts/verifyRelayFastResultWatcher.cjs"]);
    pushCheck(checks, "independent relay fast result watcher", relayFastWatcher.status === 0
      && relayFastWatcher.body?.ok === true
      && Number(relayFastWatcher.body?.passed || 0) === Number(relayFastWatcher.body?.checks || -1), {
      status: relayFastWatcher.status,
      checks: relayFastWatcher.body?.checks ?? null,
      passed: relayFastWatcher.body?.passed ?? null,
      stdoutTail: relayFastWatcher.status === 0 ? "" : relayFastWatcher.stdout.slice(-500),
      stderrTail: relayFastWatcher.stderr.slice(-500)
    });

    const relayUploadSerialization = await runLocalJson(["scripts/verifyRelaySnapshotUploadSerialization.cjs"]);
    pushCheck(checks, "serialized relay snapshot uploads preserve independent lanes", relayUploadSerialization.status === 0
      && relayUploadSerialization.body?.ok === true
      && relayUploadSerialization.body?.verifier === "relay-snapshot-upload-serialization"
      && Number(relayUploadSerialization.body?.summary?.failed || 0) === 0, {
      status: relayUploadSerialization.status,
      summary: relayUploadSerialization.body?.summary || null,
      stdoutTail: relayUploadSerialization.status === 0 ? "" : relayUploadSerialization.stdout.slice(-500),
      stderrTail: relayUploadSerialization.stderr.slice(-500)
    });

    const atomicRefreshBridge = await runLocalJson(["scripts/verifyAtomicRefreshBridge.cjs"]);
    pushCheck(checks, "atomic current-to-history refresh bridge", atomicRefreshBridge.status === 0
      && atomicRefreshBridge.body?.ok === true
      && Number(atomicRefreshBridge.body?.summary?.failed || 0) === 0, {
      status: atomicRefreshBridge.status,
      summary: atomicRefreshBridge.body?.summary || null,
      stdoutTail: atomicRefreshBridge.status === 0 ? "" : atomicRefreshBridge.stdout.slice(-500),
      stderrTail: atomicRefreshBridge.stderr.slice(-500)
    });

    const syncWorkerEventBridge = await runLocalJson(["scripts/verifySyncWorkerEventBridge.cjs"]);
    pushCheck(checks, "sync worker fast/full event bridge", syncWorkerEventBridge.status === 0
      && syncWorkerEventBridge.body?.ok === true
      && syncWorkerEventBridge.body?.verifier === "sync-worker-event-bridge", {
      status: syncWorkerEventBridge.status,
      events: syncWorkerEventBridge.body?.events || null,
      stdoutTail: syncWorkerEventBridge.status === 0 ? "" : syncWorkerEventBridge.stdout.slice(-500),
      stderrTail: syncWorkerEventBridge.stderr.slice(-500)
    });

    const predictionAudit = await runLocalJson(["scripts/verifyPredictionAudit.cjs"]);
    pushCheck(checks, "prediction audit", predictionAudit.status === 0 && predictionAudit.body?.ok === true, {
      status: predictionAudit.status,
      rows: predictionAudit.body?.checks?.find((check) => check.name === "prediction snapshots available")?.rows ?? null,
      currentWithPredictions: predictionAudit.body?.checks?.find((check) => check.name === "current prediction meta audit fields")?.currentWithPredictions ?? null,
      stdoutTail: predictionAudit.status === 0 ? "" : predictionAudit.stdout.slice(-500),
      stderrTail: predictionAudit.stderr.slice(-500)
    });

    const predictionFeatureAsOf = await runLocalJson(["scripts/verifyPredictionFeatureAsOf.cjs"]);
    pushCheck(checks, "prediction market features are cutoff-safe", predictionFeatureAsOf.status === 0, {
      status: predictionFeatureAsOf.status,
      stdoutTail: predictionFeatureAsOf.status === 0 ? "" : predictionFeatureAsOf.stdout.slice(-500),
      stderrTail: predictionFeatureAsOf.stderr.slice(-500)
    });

    const collectorAttestation = await runLocalJson(["scripts/verifyCollectorAttestation.cjs"]);
    pushCheck(checks, "collector attestation trust boundary", collectorAttestation.status === 0
      && collectorAttestation.body?.ok === true
      && collectorAttestation.body?.version === "collector-attestation-integration-verifier-v1"
      && collectorAttestation.body?.unsignedFailsClosed === true, {
      status: collectorAttestation.status,
      signedMarkets: collectorAttestation.body?.signedMarkets || null,
      trustBoundary: collectorAttestation.body?.trustBoundary || null,
      stdoutTail: collectorAttestation.status === 0 ? "" : collectorAttestation.stdout.slice(-500),
      stderrTail: collectorAttestation.stderr.slice(-500)
    });

    const marketSourceProvenance = await runLocalJson(["scripts/verifyMarketSourceProvenance.cjs"]);
    pushCheck(checks, "market source provenance fails closed", marketSourceProvenance.status === 0
      && marketSourceProvenance.body?.ok === true
      && marketSourceProvenance.body?.version === "market-source-provenance-verifier-v2"
      && Number(marketSourceProvenance.body?.synthetic?.hadStrictEligible) === 1
      && Number(marketSourceProvenance.body?.synthetic?.hhadStrictEligible) === 1, {
      status: marketSourceProvenance.status,
      attacksRejected: marketSourceProvenance.body?.attacksRejected || [],
      realData: marketSourceProvenance.body?.realData || null,
      stdoutTail: marketSourceProvenance.status === 0 ? "" : marketSourceProvenance.stdout.slice(-500),
      stderrTail: marketSourceProvenance.stderr.slice(-500)
    });

    const predictionDirectionIntegrity = await runLocalJson(["scripts/verifyPredictionDirectionIntegrity.cjs"]);
    const directionGuarantees = predictionDirectionIntegrity.body?.guarantees || {};
    pushCheck(checks, "prediction direction integrity artifact", predictionDirectionIntegrity.status === 0
      && predictionDirectionIntegrity.body?.ok === true
      && predictionDirectionIntegrity.body?.verifier === "prediction-direction-integrity"
      && Number(predictionDirectionIntegrity.body?.assertions || 0) > 0
      && Object.values(directionGuarantees).length >= 4
      && Object.values(directionGuarantees).every((value) => value === true), {
      status: predictionDirectionIntegrity.status,
      assertions: predictionDirectionIntegrity.body?.assertions ?? null,
      guarantees: directionGuarantees,
      stdoutTail: predictionDirectionIntegrity.status === 0 ? "" : predictionDirectionIntegrity.stdout.slice(-500),
      stderrTail: predictionDirectionIntegrity.stderr.slice(-500)
    });

    const walkForward = await runLocalJson(["scripts/verifyWalkForwardValidation.cjs"]);
    const walkForwardEligible = walkForward.body?.eligible || {};
    pushCheck(checks, "walk-forward validation artifact", walkForward.status === 0
      && walkForward.body?.ok === true
      && walkForward.body?.verifier === "walk-forward-validation"
      && walkForward.body?.validationVersion === expectedWalkForwardValidationVersion
      && walkForward.body?.protocolVersion === expectedWalkForwardProtocolVersion
      && Number(walkForwardEligible.folds || 0) >= 6
      && walkForwardEligible.watermark?.noOverlapVerified === true
      && /^[a-f0-9]{64}$/.test(String(walkForwardEligible.foldManifestHash || ""))
      && /^[a-f0-9]{64}$/.test(String(walkForwardEligible.featureModelHash || "")), {
      status: walkForward.status,
      validationVersion: walkForward.body?.validationVersion || null,
      protocolVersion: walkForward.body?.protocolVersion || null,
      folds: walkForwardEligible.folds ?? null,
      passRate: walkForwardEligible.passRate ?? null,
      watermark: walkForwardEligible.watermark || null,
      stdoutTail: walkForward.status === 0 ? "" : walkForward.stdout.slice(-500),
      stderrTail: walkForward.stderr.slice(-500)
    });

    const asOfResultTimeline = await runLocalJson(["scripts/verifyAsOfResultTimeline.cjs"]);
    pushCheck(checks, "as-of result timeline artifact", asOfResultTimeline.status === 0
      && asOfResultTimeline.body?.ok === true
      && asOfResultTimeline.body?.verifier === "as-of-result-timeline"
      && Number(asOfResultTimeline.body?.delayedObservation?.appliedResults) === 1
      && Number(asOfResultTimeline.body?.simultaneousKickoff?.appliedResults) === 0
      && asOfResultTimeline.body?.invalidClockExcluded?.fallback === true
      && asOfResultTimeline.body?.invalidClockExcluded?.promotionEligible === false
      && asOfResultTimeline.body?.invalidClockExcluded?.observedAt === null, {
      status: asOfResultTimeline.status,
      version: asOfResultTimeline.body?.version || null,
      delayedObservation: asOfResultTimeline.body?.delayedObservation || null,
      simultaneousKickoff: asOfResultTimeline.body?.simultaneousKickoff || null,
      invalidClockExcluded: asOfResultTimeline.body?.invalidClockExcluded || null,
      stdoutTail: asOfResultTimeline.status === 0 ? "" : asOfResultTimeline.stdout.slice(-500),
      stderrTail: asOfResultTimeline.stderr.slice(-500)
    });

    const marketMovement = await runLocalJson(["scripts/verifyMarketMovement.cjs"]);
    pushCheck(checks, "market movement artifact", marketMovement.status === 0
      && marketMovement.body?.ok === true
      && marketMovement.body?.verifier === "market-movement"
      && Number(marketMovement.body?.had?.changes?.["1"]?.probabilityDelta) > 0
      && Number(marketMovement.body?.had?.changes?.["2"]?.probabilityDelta) < 0
      && marketMovement.body?.hhad?.line?.direction === "home-gives-more"
      && Object.keys(marketMovement.body?.marginOnly?.changes || {}).length === 3
      && Object.values(marketMovement.body?.marginOnly?.changes || {})
        .every((change) => Number(change?.probabilityDelta) === 0), {
      status: marketMovement.status,
      devigMethod: marketMovement.body?.devigMethod || null,
      had: marketMovement.body?.had || null,
      hhad: marketMovement.body?.hhad || null,
      marginOnly: marketMovement.body?.marginOnly || null,
      stdoutTail: marketMovement.status === 0 ? "" : marketMovement.stdout.slice(-500),
      stderrTail: marketMovement.stderr.slice(-500)
    });

    const frontendEvidenceSemantics = await runLocalJson(["scripts/verifyFrontendEvidenceSemantics.cjs"]);
    const frontendEvidenceChecks = Array.isArray(frontendEvidenceSemantics.body?.checks)
      ? frontendEvidenceSemantics.body.checks
      : [];
    pushCheck(checks, "frontend evidence semantics artifact", frontendEvidenceSemantics.status === 0
      && frontendEvidenceSemantics.body?.ok === true
      && frontendEvidenceSemantics.body?.verifier === "frontend-evidence-semantics"
      && Number(frontendEvidenceSemantics.body?.assertions || 0) === frontendEvidenceChecks.length
      && frontendEvidenceChecks.length > 0
      && frontendEvidenceChecks.every((check) => check?.ok === true), {
      status: frontendEvidenceSemantics.status,
      verifier: frontendEvidenceSemantics.body?.verifier || null,
      assertions: frontendEvidenceSemantics.body?.assertions ?? null,
      failedChecks: frontendEvidenceChecks.filter((check) => check?.ok !== true).map((check) => check?.name || "unnamed-check"),
      stdoutTail: frontendEvidenceSemantics.status === 0 ? "" : frontendEvidenceSemantics.stdout.slice(-500),
      stderrTail: frontendEvidenceSemantics.stderr.slice(-500)
    });

    const recommendationConfidencePayload = await runLocalJson([
      "scripts/verifyRecommendationConfidencePayload.cjs"
    ]);
    const recommendationConfidenceContract = recommendationConfidencePayload.body?.contract || {};
    pushCheck(checks, "recommendation confidence public payload semantics",
      recommendationConfidencePayload.status === 0
      && recommendationConfidencePayload.body?.ok === true
      && recommendationConfidencePayload.body?.verifier === "recommendation-confidence-production-payload"
      && Number(recommendationConfidencePayload.body?.assertions || 0) > 0
      && recommendationConfidenceContract.missingCalibrationSampleIsNull === true
      && recommendationConfidenceContract.marketAlignmentIsTriState === true
      && recommendationConfidenceContract.freshnessRequiresAuditedClock === true
      && recommendationConfidenceContract.completenessUsesInputCoverageRatio === true
      && recommendationConfidenceContract.missingFactsRemainNull === true, {
      status: recommendationConfidencePayload.status,
      verifier: recommendationConfidencePayload.body?.verifier || null,
      assertions: recommendationConfidencePayload.body?.assertions ?? null,
      contract: recommendationConfidenceContract,
      stdoutTail: recommendationConfidencePayload.status === 0
        ? ""
        : recommendationConfidencePayload.stdout.slice(-500),
      stderrTail: recommendationConfidencePayload.stderr.slice(-500)
    });

    const fastResultGeneration = await runLocalJson([
      "scripts/verifyFastResultGenerationReconciliation.cjs"
    ]);
    const fastResultGenerationContract = fastResultGeneration.body?.contract || {};
    pushCheck(checks, "fast result generation receipt review isolation",
      fastResultGeneration.status === 0
      && fastResultGeneration.body?.ok === true
      && fastResultGeneration.body?.verifier === "fast-result-generation-reconciliation"
      && Number(fastResultGeneration.body?.checks) === 23
      && Number(fastResultGeneration.body?.passed) === 23
      && Array.isArray(fastResultGeneration.body?.failed)
      && fastResultGeneration.body.failed.length === 0
      && fastResultGenerationContract.receiptReviewCannotEnterFormalMetrics === true
      && fastResultGenerationContract.pairedReferenceSurvivesReconciliation === true
      && fastResultGenerationContract.invalidPairSourceFailsBeforeAnyWrite === true
      && fastResultGenerationContract.invalidReviewInputCannotAdvanceGeneration === true
      && fastResultGenerationContract.existingQuarantineLedgerIsStrictlyValidated === true
      && fastResultGenerationContract.existingSameEventReviewPreservedByteForByte === true
      && fastResultGenerationContract.standaloneReviewIdentityIncludesEventVersion === true
      && fastResultGenerationContract.producedReviewsCarryCanonicalEventVersion === true
      && fastResultGenerationContract.reproducibleLegacyReviewRequiresUniqueEventBinding === true
      && fastResultGenerationContract.legacyReviewContentMustReproduce === true
      && fastResultGenerationContract.nonReproducibleReferenceReviewIsQuarantined === true
      && fastResultGenerationContract.quarantineWriteFailureCannotAdvanceGeneration === true
      && fastResultGenerationContract.reviewSurfacesRemainOneToOne === true
      && fastResultGenerationContract.legacyLiveOnlyReviewIsNonFormalQuarantine === true
      && fastResultGenerationContract.embeddedReviewCannotSelfVerifyFormalPublication === true
      && fastResultGenerationContract.unverifiedLegacyFormalReviewCannotAdvanceGeneration === true
      && fastResultGenerationContract.wrongEventFactorsAreNotInherited === true
      && fastResultGenerationContract.resultOnlyTopLevelModelContentIsStripped === true
      && fastResultGenerationContract.sqliteAliasCannotRenamePublicIdentity === true, {
      status: fastResultGeneration.status,
      verifier: fastResultGeneration.body?.verifier || null,
      checks: fastResultGeneration.body?.checks ?? null,
      passed: fastResultGeneration.body?.passed ?? null,
      failed: fastResultGeneration.body?.failed || null,
      contract: fastResultGenerationContract,
      stdoutTail: fastResultGeneration.status === 0
        ? ""
        : fastResultGeneration.stdout.slice(-500),
      stderrTail: fastResultGeneration.stderr.slice(-500)
    });

    const postgresSemanticReviews = await runLocalJson([
      "scripts/verifyPostgresSemanticReviewCleanup.cjs"
    ]);
    pushCheck(checks, "postgres semantic result-only review canonicalization",
      postgresSemanticReviews.status === 0
      && postgresSemanticReviews.body?.ok === true
      && postgresSemanticReviews.body?.verifier === "postgres-semantic-review-cleanup"
      && Number(postgresSemanticReviews.body?.checks) >= 37
      && postgresSemanticReviews.body?.fixture?.staleMatchId === "fivehundred_2040801"
      && postgresSemanticReviews.body?.fixture?.keeperMatchId === "sporttery_2040801"
      && postgresSemanticReviews.body?.fixture?.eventVersion === "2026-08-09T19:30:00.000Z"
      && postgresSemanticReviews.body?.fixture?.resultIdentity === "2:2|sporttery:official-api", {
      status: postgresSemanticReviews.status,
      verifier: postgresSemanticReviews.body?.verifier || null,
      checks: postgresSemanticReviews.body?.checks ?? null,
      fixture: postgresSemanticReviews.body?.fixture || null,
      stdoutTail: postgresSemanticReviews.status === 0
        ? ""
        : postgresSemanticReviews.stdout.slice(-500),
      stderrTail: postgresSemanticReviews.stderr.slice(-500)
    });

    const benchmarkSelection = await runLocalJson(["scripts/verifyBenchmarkSelectionPolicy.cjs"]);
    pushCheck(checks, "80 percent benchmark selection remains shadow-only", benchmarkSelection.status === 0
      && benchmarkSelection.body?.ok === true
      && benchmarkSelection.body?.verifier === "benchmark-selection-policy"
      && benchmarkSelection.body?.role === "shadow-only"
      && Number(benchmarkSelection.body?.criteria?.minimumEvidenceScore) === 60
      && Number(benchmarkSelection.body?.criteria?.minimumOdds) === 1.2
      && Number(benchmarkSelection.body?.criteria?.maximumOdds) === 1.85, {
      status: benchmarkSelection.status,
      version: benchmarkSelection.body?.version || null,
      role: benchmarkSelection.body?.role || null,
      criteria: benchmarkSelection.body?.criteria || null,
      stdoutTail: benchmarkSelection.status === 0 ? "" : benchmarkSelection.stdout.slice(-500),
      stderrTail: benchmarkSelection.stderr.slice(-500)
    });

    const benchmarkProspectiveLedger = await runLocalJson(["scripts/verifyBenchmarkProspectiveLedger.cjs"]);
    pushCheck(checks, "benchmark prospective ledger is immutable and fail-closed",
      benchmarkProspectiveLedger.status === 0
      && benchmarkProspectiveLedger.body?.ok === true
      && benchmarkProspectiveLedger.body?.verifier === "benchmark-prospective-ledger"
      && benchmarkProspectiveLedger.body?.version === "goodwin-benchmark-prospective-shadow-v2"
      && Number(benchmarkProspectiveLedger.body?.researchRows || 0) === 6, {
        status: benchmarkProspectiveLedger.status,
        version: benchmarkProspectiveLedger.body?.version || null,
        auditVersion: benchmarkProspectiveLedger.body?.auditVersion || null,
        sample: benchmarkProspectiveLedger.body?.sample || null,
        researchRows: benchmarkProspectiveLedger.body?.researchRows ?? null,
        stdoutTail: benchmarkProspectiveLedger.status === 0 ? "" : benchmarkProspectiveLedger.stdout.slice(-500),
        stderrTail: benchmarkProspectiveLedger.stderr.slice(-500)
      });

    const candidateProspectiveLedger = await runLocalJson([
      "scripts/verifyCandidateProspectiveLedger.cjs",
    ]);
    const candidateProspectiveChecks = Array.isArray(candidateProspectiveLedger.body?.checks)
      ? candidateProspectiveLedger.body.checks
      : [];
    pushCheck(checks, "candidate prospective ledger freezes implementation and forbids backfill",
      candidateProspectiveLedger.status === 0
      && candidateProspectiveLedger.body?.ok === true
      && candidateProspectiveLedger.body?.verifier === "candidate-prospective-ledger"
      && candidateProspectiveChecks.length >= 14
      && candidateProspectiveChecks.every((check) => check?.ok === true), {
        status: candidateProspectiveLedger.status,
        verifier: candidateProspectiveLedger.body?.verifier || null,
        assertions: candidateProspectiveLedger.body?.assertions ?? null,
        failedChecks: candidateProspectiveChecks
          .filter((check) => check?.ok !== true)
          .map((check) => check?.name || "unnamed-check"),
        stdoutTail:
          candidateProspectiveLedger.status === 0
            ? ""
            : candidateProspectiveLedger.stdout.slice(-500),
        stderrTail: candidateProspectiveLedger.stderr.slice(-500)
      });

    const candidateProspectiveAdmission = await runLocalJson([
      "scripts/verifyCandidateProspectiveAdmission.cjs",
    ]);
    pushCheck(checks, "candidate admission audit distinguishes admitted rows from due capture gaps",
      candidateProspectiveAdmission.status === 0
      && candidateProspectiveAdmission.body?.ok === true
      && candidateProspectiveAdmission.body?.verifier
        === "candidate-prospective-admission"
      && candidateProspectiveAdmission.body?.summary?.reconciled === true
      && candidateProspectiveAdmission.body?.summary?.captureGap === true
      && Number(candidateProspectiveAdmission.body?.summary?.dueUnrecorded || 0) === 1, {
        status: candidateProspectiveAdmission.status,
        verifier: candidateProspectiveAdmission.body?.verifier || null,
        assertions: candidateProspectiveAdmission.body?.assertions ?? null,
        summary: candidateProspectiveAdmission.body?.summary || null,
        stdoutTail:
          candidateProspectiveAdmission.status === 0
            ? ""
            : candidateProspectiveAdmission.stdout.slice(-500),
        stderrTail: candidateProspectiveAdmission.stderr.slice(-500)
      });

    const candidateReadinessFullCoverage = await runLocalJson([
      "scripts/verifyCandidateReadinessFullCoverage.cjs",
    ]);
    const candidateMarketCoverage =
      candidateReadinessFullCoverage.body?.readiness?.marketCoverage || null;
    pushCheck(checks, "candidate readiness classifies unpublished markets separately from published chain gaps",
      candidateReadinessFullCoverage.status === 0
      && candidateReadinessFullCoverage.body?.ok === true
      && candidateReadinessFullCoverage.body?.verifier
        === "candidate-readiness-full-coverage"
      && Number(candidateReadinessFullCoverage.body?.assertions || 0) >= 48
      && candidateMarketCoverage?.version
        === "candidate-official-market-coverage-preview-v1"
      && candidateMarketCoverage?.awaitingClassificationComplete === true
      && Number(candidateMarketCoverage?.publishedChainGapMatches || 0) === 0, {
        status: candidateReadinessFullCoverage.status,
        verifier: candidateReadinessFullCoverage.body?.verifier || null,
        assertions: candidateReadinessFullCoverage.body?.assertions ?? null,
        marketCoverage: candidateMarketCoverage,
        stdoutTail:
          candidateReadinessFullCoverage.status === 0
            ? ""
            : candidateReadinessFullCoverage.stdout.slice(-500),
        stderrTail: candidateReadinessFullCoverage.stderr.slice(-500)
      });

    const candidateDeadlineCapture = await runLocalJson([
      "scripts/verifyCandidateDeadlineCapture.cjs",
    ]);
    const candidateDeadlineCaptureChecks = Array.isArray(candidateDeadlineCapture.body?.checks)
      ? candidateDeadlineCapture.body.checks
      : [];
    pushCheck(checks, "candidate deadline heartbeat captures T-10 rows without backfill",
      candidateDeadlineCapture.status === 0
      && candidateDeadlineCapture.body?.ok === true
      && candidateDeadlineCapture.body?.verifier
        === "candidate-prospective-deadline-capture"
      && candidateDeadlineCaptureChecks.length >= 6
      && candidateDeadlineCaptureChecks.every((check) => check?.ok === true), {
        status: candidateDeadlineCapture.status,
        verifier: candidateDeadlineCapture.body?.verifier || null,
        assertions: candidateDeadlineCapture.body?.assertions ?? null,
        failedChecks: candidateDeadlineCaptureChecks
          .filter((check) => check?.ok !== true)
          .map((check) => check?.name || "unnamed-check"),
        stdoutTail:
          candidateDeadlineCapture.status === 0
            ? ""
            : candidateDeadlineCapture.stdout.slice(-500),
        stderrTail: candidateDeadlineCapture.stderr.slice(-500)
      });

    const candidateProspectiveGoal = await runLocalJson([
      "scripts/verifyCandidateProspectiveGoalProgress.cjs",
    ]);
    pushCheck(checks, "candidate goal monitor requires 500 settled rows and five of six dual-metric windows",
      candidateProspectiveGoal.status === 0
      && candidateProspectiveGoal.body?.ok === true
      && candidateProspectiveGoal.body?.verifier
        === "candidate-prospective-goal-progress"
      && Number(candidateProspectiveGoal.body?.collecting?.thresholds?.targetRows) === 500
      && Number(candidateProspectiveGoal.body?.collecting?.thresholds?.requiredWindows) === 6
      && Number(
        candidateProspectiveGoal.body?.collecting?.thresholds?.requiredWinningWindows,
      ) === 5
      && candidateProspectiveGoal.body?.collecting?.status === "collecting"
      && candidateProspectiveGoal.body?.complete?.status === "complete"
      && Number(candidateProspectiveGoal.body?.complete?.formal?.rows) === 500
      && Number(
        candidateProspectiveGoal.body?.complete?.evaluation?.winningWindows,
      ) === 5, {
        status: candidateProspectiveGoal.status,
        verifier: candidateProspectiveGoal.body?.verifier || null,
        assertions: candidateProspectiveGoal.body?.assertions ?? null,
        collecting: candidateProspectiveGoal.body?.collecting || null,
        complete: candidateProspectiveGoal.body?.complete || null,
        stdoutTail:
          candidateProspectiveGoal.status === 0
            ? ""
            : candidateProspectiveGoal.stdout.slice(-500),
        stderrTail: candidateProspectiveGoal.stderr.slice(-500)
      });

    const prospectiveWatchHealth = await runLocalJson([
      "scripts/verifyProspectiveWatchHealthPolicy.cjs",
    ]);
    pushCheck(checks, "candidate watcher survives release freshness transitions but fails on ledger drift",
      prospectiveWatchHealth.status === 0
      && prospectiveWatchHealth.body?.ok === true
      && prospectiveWatchHealth.body?.verifier
        === "prospective-watch-health-policy"
      && prospectiveWatchHealth.body?.releaseTransition?.keepRunning === true
      && prospectiveWatchHealth.body?.releaseTransition?.severity
        === "transient"
      && Number(
        prospectiveWatchHealth.body?.prolongedTransition
          ?.consecutiveUnhealthyPolls,
      ) >= 20
      && prospectiveWatchHealth.body?.prolongedTransition?.keepRunning === true
      && prospectiveWatchHealth.body?.recovered?.recoveries === 1
      && prospectiveWatchHealth.body?.fatal?.shouldExit === true, {
        status: prospectiveWatchHealth.status,
        verifier: prospectiveWatchHealth.body?.verifier || null,
        assertions: prospectiveWatchHealth.body?.assertions ?? null,
        releaseTransition:
          prospectiveWatchHealth.body?.releaseTransition || null,
        prolongedTransition:
          prospectiveWatchHealth.body?.prolongedTransition || null,
        recovered: prospectiveWatchHealth.body?.recovered || null,
        fatal: prospectiveWatchHealth.body?.fatal || null,
        stdoutTail:
          prospectiveWatchHealth.status === 0
            ? ""
            : prospectiveWatchHealth.stdout.slice(-500),
        stderrTail: prospectiveWatchHealth.stderr.slice(-500)
      });

    const prospectiveWatchRecovery = await runLocalJson([
      "scripts/verifyProspectiveWatchRecovery.cjs",
    ]);
    pushCheck(checks, "candidate watcher process recovers after a release-transition heartbeat",
      prospectiveWatchRecovery.status === 0
      && prospectiveWatchRecovery.body?.ok === true
      && prospectiveWatchRecovery.body?.verifier
        === "prospective-watch-recovery"
      && Number(prospectiveWatchRecovery.body?.requests || 0) >= 3
      && prospectiveWatchRecovery.body?.final?.version
        === "candidate-prospective-capture-watch-v4"
      && prospectiveWatchRecovery.body?.final?.continuityPolicyVersion
        === "candidate-prospective-capture-watch-continuity-policy-v2"
      && prospectiveWatchRecovery.body?.final?.status === "complete"
      && Number(
        prospectiveWatchRecovery.body?.final?.unhealthyPolls,
      ) === 2
      && Number(prospectiveWatchRecovery.body?.final?.recoveries) === 1
      && Number(
        prospectiveWatchRecovery.body?.final?.stableNoOpTransitions,
      ) >= 2, {
        status: prospectiveWatchRecovery.status,
        verifier: prospectiveWatchRecovery.body?.verifier || null,
        assertions: prospectiveWatchRecovery.body?.assertions ?? null,
        requests: prospectiveWatchRecovery.body?.requests ?? null,
        final: prospectiveWatchRecovery.body?.final || null,
        stdoutTail:
          prospectiveWatchRecovery.status === 0
            ? ""
            : prospectiveWatchRecovery.stdout.slice(-500),
        stderrTail: prospectiveWatchRecovery.stderr.slice(-500)
      });

    const modelPromotion = await runLocalJson(["scripts/verifyModelPromotionGate.cjs"], runtimeStoreEnv);
    const modelPromotionSummary = modelPromotion.body?.summary || {};
    pushCheck(checks, "model promotion artifact", modelPromotion.status === 0 && modelPromotion.body?.ok === true, {
      status: modelPromotion.status,
      gateStatus: modelPromotionSummary.gateStatus || null,
      onlineEffect: modelPromotionSummary.onlineEffect || null,
      reasons: modelPromotionSummary.reasons || [],
      stdoutTail: modelPromotion.status === 0 ? "" : modelPromotion.stdout.slice(-500),
      stderrTail: modelPromotion.stderr.slice(-500)
    });

    const ragNeutrality = await runLocalJson(["scripts/verifyRagPredictionNeutrality.cjs"]);
    pushCheck(checks, "RAG evidence is prediction-neutral", ragNeutrality.status === 0
      && ragNeutrality.body?.ok === true
      && ragNeutrality.body?.formalPredictionDigestStable === true
      && ragNeutrality.body?.featureSnapshotHashStable === true
      && Number(ragNeutrality.body?.numericWebWeight) === 0, {
      status: ragNeutrality.status,
      assertions: ragNeutrality.body?.assertions ?? null,
      nonEmptyV2Rows: ragNeutrality.body?.nonEmptyV2Rows ?? null,
      stdoutTail: ragNeutrality.status === 0 ? "" : ragNeutrality.stdout.slice(-500),
      stderrTail: ragNeutrality.stderr.slice(-500)
    });

    const openResearchGateway = await runLocalJson(["scripts/verifyOpenResearchGateway.cjs"]);
    pushCheck(checks, "open research gateway is bounded and paywall-safe", openResearchGateway.status === 0
      && openResearchGateway.body?.ok === true
      && Number(openResearchGateway.body?.summary?.failed || 0) === 0
      && Number(openResearchGateway.body?.summary?.passed || 0) > 0, {
      status: openResearchGateway.status,
      verifier: openResearchGateway.body?.verifier || null,
      total: openResearchGateway.body?.summary?.total ?? null,
      passed: openResearchGateway.body?.summary?.passed ?? null,
      failedChecks: (openResearchGateway.body?.checks || []).filter((check) => check?.ok !== true).map((check) => check?.name || "unnamed-check"),
      stdoutTail: openResearchGateway.status === 0 ? "" : openResearchGateway.stdout.slice(-500),
      stderrTail: openResearchGateway.stderr.slice(-500)
    });

    const apiFootballHardening = await runLocalJson(["scripts/verifyApiFootballHardening.cjs"]);
    pushCheck(checks, "API-Football free supplement is quota-bounded and identity-safe",
      apiFootballHardening.status === 0
        && apiFootballHardening.body?.ok === true
        && Number(apiFootballHardening.body?.assertions || 0) > 0, {
        status: apiFootballHardening.status,
        assertions: apiFootballHardening.body?.assertions ?? null,
        networkCalls: apiFootballHardening.body?.networkCalls ?? null,
        stdoutTail: apiFootballHardening.status === 0 ? "" : apiFootballHardening.stdout.slice(-500),
        stderrTail: apiFootballHardening.stderr.slice(-500),
      });

    const legacyReferenceConflict = await runLocalJson(["scripts/verifyLegacyReferenceConflict.cjs"]);
    pushCheck(checks, "legacy reference conflicts are explicit without rewriting history",
      legacyReferenceConflict.status === 0 && legacyReferenceConflict.body?.ok === true
        && Number(legacyReferenceConflict.body?.checks || 0) >= 14, {
        status: legacyReferenceConflict.status, checks: legacyReferenceConflict.body?.checks ?? null,
        stderrTail: legacyReferenceConflict.stderr.slice(-500),
      });

    const collectorDiagnostics = await runLocalJson(["scripts/verifyApiFootballDiagnostics.cjs"]);
    pushCheck(checks, "collector diagnostics preserve privacy and frozen-decision separation",
      collectorDiagnostics.status === 0 && collectorDiagnostics.body?.ok === true
        && Number(collectorDiagnostics.body?.checks || 0) >= 24, {
        status: collectorDiagnostics.status, checks: collectorDiagnostics.body?.checks ?? null,
        stdoutTail: collectorDiagnostics.status === 0 ? "" : collectorDiagnostics.stdout.slice(-500),
        stderrTail: collectorDiagnostics.stderr.slice(-500),
      });

    const wikidataCandidates = await runLocalJson(["scripts/verifyWikidataEntityCandidates.cjs"]);
    pushCheck(checks, "Wikidata candidates remain quarantined", wikidataCandidates.status === 0
      && wikidataCandidates.body?.ok === true
      && Number(wikidataCandidates.body?.assertions || 0) > 0
      && Number(wikidataCandidates.body?.autoPromoted) === 0, {
      status: wikidataCandidates.status,
      assertions: wikidataCandidates.body?.assertions ?? null,
      syntheticCandidates: wikidataCandidates.body?.syntheticCandidates ?? null,
      receipts: wikidataCandidates.body?.receipts ?? null,
      stdoutTail: wikidataCandidates.status === 0 ? "" : wikidataCandidates.stdout.slice(-500),
      stderrTail: wikidataCandidates.stderr.slice(-500)
    });

    const entityMasterData = await runLocalJson(["scripts/verifyEntityMasterData.cjs"]);
    pushCheck(checks, "entity master data review and as-of boundary", entityMasterData.status === 0
      && entityMasterData.body?.ok === true
      && entityMasterData.body?.verifier === "entity-master-data-v1"
      && Number(entityMasterData.body?.assertions || 0) > 0
      && entityMasterData.body?.guarantees?.testIsolation?.startsWith?.("temporary fixtures only"), {
      status: entityMasterData.status,
      assertions: entityMasterData.body?.assertions ?? null,
      guarantees: entityMasterData.body?.guarantees || null,
      stdoutTail: entityMasterData.status === 0 ? "" : entityMasterData.stdout.slice(-500),
      stderrTail: entityMasterData.stderr.slice(-500)
    });

    const hhadCompanionEvaluation = await runLocalJson(["scripts/verifyHhadCompanionShadowEvaluation.cjs"], runtimeStoreEnv);
    pushCheck(checks, "HHAD companion shadow evaluation", hhadCompanionEvaluation.status === 0 && hhadCompanionEvaluation.body?.ok === true, {
      status: hhadCompanionEvaluation.status,
      candidateReady: hhadCompanionEvaluation.body?.candidateReady ?? null,
      pairedNonVoidRows: hhadCompanionEvaluation.body?.counts?.pairedNonVoidRows ?? null,
      improvingWindows: hhadCompanionEvaluation.body?.improvingWindows ?? null,
      stdoutTail: hhadCompanionEvaluation.status === 0 ? "" : hhadCompanionEvaluation.stdout.slice(-500),
      stderrTail: hhadCompanionEvaluation.stderr.slice(-500)
    });

    const modelInputAudit = await runLocalJson(["scripts/verifyModelInputAudit.cjs"], runtimeStoreEnv);
    const modelInputAuditSummary = modelInputAudit.body?.summary || {};
    pushCheck(checks, "model input leakage audit", modelInputAudit.status === 0 && modelInputAudit.body?.ok === true, {
      status: modelInputAudit.status,
      auditOk: modelInputAuditSummary.auditOk ?? null,
      violationCount: modelInputAuditSummary.violationCount ?? null,
      probabilityRows: modelInputAuditSummary.probabilityRows ?? null,
      marketBaselineRows: modelInputAuditSummary.marketBaselineRows ?? null,
      bestCandidateId: modelInputAuditSummary.bestCandidateId || null,
      stdoutTail: modelInputAudit.status === 0 ? "" : modelInputAudit.stdout.slice(-500),
      stderrTail: modelInputAudit.stderr.slice(-500)
    });

    const modelRiskTiers = await runLocalJson(["scripts/verifyModelRiskTiers.cjs"], runtimeStoreEnv);
    const modelRiskTiersSummary = modelRiskTiers.body?.summary || {};
    pushCheck(checks, "model risk tier artifact", modelRiskTiers.status === 0 && modelRiskTiers.body?.ok === true, {
      status: modelRiskTiers.status,
      riskVersion: modelRiskTiersSummary.riskVersion || null,
      overallTier: modelRiskTiersSummary.overallTier || null,
      confidenceBucketCount: modelRiskTiersSummary.confidenceBucketCount ?? null,
      maxCalibrationError: modelRiskTiersSummary.maxCalibrationError ?? null,
      stdoutTail: modelRiskTiers.status === 0 ? "" : modelRiskTiers.stdout.slice(-500),
      stderrTail: modelRiskTiers.stderr.slice(-500)
    });

    const recommendationEligibility = await runLocalJson(["scripts/verifyRecommendationEligibility.cjs"], runtimeStoreEnv);
    const recommendationComparison = recommendationEligibility.body?.comparison || {};
    pushCheck(checks, "official recommendation eligibility", recommendationEligibility.status === 0 && recommendationEligibility.body?.ok === true, {
      status: recommendationEligibility.status,
      beforeSettled: recommendationComparison.beforeSettled ?? null,
      afterSettled: recommendationComparison.afterSettled ?? null,
      coverage: recommendationComparison.coverage ?? null,
      beforeHitRate: recommendationComparison.beforeHitRate ?? null,
      afterHitRate: recommendationComparison.afterHitRate ?? null,
      rollingWindows: recommendationComparison.rollingWindows ?? null,
      failedChecks: Array.isArray(recommendationEligibility.body?.failedChecks)
        ? recommendationEligibility.body.failedChecks
        : [],
      stdoutTail: recommendationEligibility.status === 0 ? "" : recommendationEligibility.stdout.slice(-500),
      stderrTail: recommendationEligibility.stderr.slice(-500)
    });

    const externalOddsReference = await runLocalJson(["scripts/verifyExternalOddsAnalysisReference.cjs"]);
    pushCheck(checks, "500 market reference stays analysis-only", externalOddsReference.status === 0 && externalOddsReference.body?.ok === true, {
      status: externalOddsReference.status,
      policyVersion: externalOddsReference.body?.policyVersion || null,
      minimumLeaderGap: externalOddsReference.body?.minimumLeaderGap ?? null,
      scenarios: externalOddsReference.body?.scenarios ?? null,
      passed: externalOddsReference.body?.passed ?? null,
      stdoutTail: externalOddsReference.status === 0 ? "" : externalOddsReference.stdout.slice(-500),
      stderrTail: externalOddsReference.stderr.slice(-500)
    });

    const handicapSettlement = await runLocalJson(["scripts/verifyHandicapSettlement.cjs"]);
    pushCheck(checks, "handicap parsing and settlement fail closed", handicapSettlement.status === 0, {
      status: handicapSettlement.status,
      stdoutTail: handicapSettlement.status === 0 ? "" : handicapSettlement.stdout.slice(-500),
      stderrTail: handicapSettlement.stderr.slice(-500)
    });

    const betSlipGate = await runLocalJson(["scripts/verifyBetSlipRecommendationGate.cjs"]);
    pushCheck(checks, "bet slip uses formal multi-factor recommendations only", betSlipGate.status === 0 && betSlipGate.body?.ok === true, {
      status: betSlipGate.status,
      total: betSlipGate.body?.summary?.total ?? null,
      passed: betSlipGate.body?.summary?.passed ?? null,
      failed: betSlipGate.body?.summary?.failed ?? null,
      failedChecks: failedArtifactChecks(betSlipGate),
      stdoutTail: betSlipGate.status === 0 ? "" : betSlipGate.stdout.slice(-500),
      stderrTail: betSlipGate.stderr.slice(-500)
    });

    const serverRecommendationBoundary = await runLocalJson(["scripts/verifyServerRecommendationBoundary.cjs"]);
    pushCheck(checks, "server recommendation boundary fails closed", serverRecommendationBoundary.status === 0, {
      status: serverRecommendationBoundary.status,
      stdoutTail: serverRecommendationBoundary.status === 0 ? "" : serverRecommendationBoundary.stdout.slice(-500),
      stderrTail: serverRecommendationBoundary.stderr.slice(-500)
    });

    const displayBindingIntegrity = await runLocalJson(["scripts/verifyDisplayRecommendationBindingIntegrity.cjs"]);
    pushCheck(checks, "verified HHAD display binding is never rewritten", displayBindingIntegrity.status === 0 && displayBindingIntegrity.body?.ok === true, {
      status: displayBindingIntegrity.status,
      expected: displayBindingIntegrity.body?.expected || null,
      actual: displayBindingIntegrity.body?.actual || null,
      stdoutTail: displayBindingIntegrity.status === 0 ? "" : displayBindingIntegrity.stdout.slice(-500),
      stderrTail: displayBindingIntegrity.stderr.slice(-500)
    });

    // Production readiness must remain an audit. Repairing the runtime LLM
    // cache belongs to the writable release build phase; the assembled
    // candidate source tree is intentionally mounted read-only.
    const llmBoundary = await runLocalJson(["scripts/verifyLlmReviewBoundary.cjs"]);
    const llmBoundarySummary = llmBoundary.body?.summary || {};
    const llmBoundaryFailures = failedArtifactChecks(llmBoundary);
    pushCheck(checks, "llm boundary stale review cleanup (read-only audit)", llmBoundary.status === 0 && llmBoundary.body?.ok === true, {
      status: llmBoundary.status,
      mode: "read-only-audit",
      failedChecks: llmBoundaryFailures,
      stdoutTail: llmBoundary.status === 0 ? "" : llmBoundary.stdout.slice(-500),
      stderrTail: llmBoundary.stderr.slice(-500)
    });
    pushCheck(checks, "llm boundary artifact", llmBoundary.status === 0 && llmBoundary.body?.ok === true, {
      status: llmBoundary.status,
      llmRows: llmBoundarySummary.llmRows ?? null,
      updatedAt: llmBoundarySummary.updatedAt || null,
      stdoutTail: llmBoundary.status === 0 ? "" : llmBoundary.stdout.slice(-500),
      stderrTail: llmBoundary.stderr.slice(-500)
    });

    const llmEvidenceBoundary = await runLocalJson(["scripts/verifyLlmEvidenceBoundary.cjs"]);
    pushCheck(checks, "LLM retrieval evidence boundary", llmEvidenceBoundary.status === 0
      && llmEvidenceBoundary.body?.ok === true
      && Number(llmEvidenceBoundary.body?.evidenceRows || 0) > 0
      && Number(llmEvidenceBoundary.body?.nonEmptyCitedReviewRows || 0) > 0
      && llmEvidenceBoundary.body?.rawExternalSignalsInPrompt === false
      && Number(llmEvidenceBoundary.body?.legacyRowsPublishable) === 0, {
      status: llmEvidenceBoundary.status,
      assertions: llmEvidenceBoundary.body?.assertions ?? null,
      evidenceRows: llmEvidenceBoundary.body?.evidenceRows ?? null,
      retrievalHash: llmEvidenceBoundary.body?.retrievalHash || null,
      stdoutTail: llmEvidenceBoundary.status === 0 ? "" : llmEvidenceBoundary.stdout.slice(-500),
      stderrTail: llmEvidenceBoundary.stderr.slice(-500)
    });

    const syncLock = await runLocalJson(["scripts/verifySyncLock.cjs"]);
    pushCheck(checks, "sync lock artifact", syncLock.status === 0 && syncLock.body?.ok === true, {
      status: syncLock.status,
      checks: Array.isArray(syncLock.body?.checks) ? syncLock.body.checks.length : null,
      stdoutTail: syncLock.status === 0 ? "" : syncLock.stdout.slice(-500),
      stderrTail: syncLock.stderr.slice(-500)
    });

    const runtimeStability = await runLocalJson(["scripts/verifyRuntimeStability.cjs"]);
    pushCheck(checks, "runtime stability artifact", runtimeStability.status === 0 && runtimeStability.body?.ok === true, {
      status: runtimeStability.status,
      checks: Array.isArray(runtimeStability.body?.checks) ? runtimeStability.body.checks.length : null,
      stdoutTail: runtimeStability.status === 0 ? "" : runtimeStability.stdout.slice(-500),
      stderrTail: runtimeStability.stderr.slice(-500)
    });

    const reviewSettlement = await runLocalJson(["scripts/verifyReviewSettlementPresentation.cjs"]);
    pushCheck(checks, "frontend fetch/history resilience contract", reviewSettlement.status === 0 && reviewSettlement.body?.ok === true, {
      status: reviewSettlement.status,
      checks: Array.isArray(reviewSettlement.body?.checks) ? reviewSettlement.body.checks.length : null,
      failedChecks: failedArtifactChecks(reviewSettlement),
      stdoutTail: reviewSettlement.status === 0 ? "" : reviewSettlement.stdout.slice(-500),
      stderrTail: reviewSettlement.stderr.slice(-500)
    });

    const reviewPerformance = await runLocalJson(["scripts/verifyReviewPerformanceSummary.cjs"]);
    pushCheck(checks, "immutable daily formal review performance cache", reviewPerformance.status === 0
      && reviewPerformance.body?.ok === true
      && reviewPerformance.body?.version === "formal-review-performance-v1"
      && reviewPerformance.body?.startDate === "2026-08-16", {
      status: reviewPerformance.status,
      version: reviewPerformance.body?.version || null,
      startDate: reviewPerformance.body?.startDate || null,
      checks: reviewPerformance.body?.checks ?? null,
      stdoutTail: reviewPerformance.status === 0 ? "" : reviewPerformance.stdout.slice(-500),
      stderrTail: reviewPerformance.stderr.slice(-500)
    });

    const frozenReviewVersion = await runLocalJson(["scripts/verifyFrozenReviewVersion.cjs"]);
    pushCheck(checks, "frozen public version to settlement and reconciled partitions", frozenReviewVersion.status === 0
      && frozenReviewVersion.body?.ok === true && frozenReviewVersion.body?.checks >= 20, {
      status: frozenReviewVersion.status, checks: frozenReviewVersion.body?.checks ?? null,
      stdoutTail: frozenReviewVersion.status === 0 ? "" : frozenReviewVersion.stdout.slice(-500), stderrTail: frozenReviewVersion.stderr.slice(-500),
    });

    const publicReferencePairs = await runLocalJson(["scripts/verifyPublicReferencePairs.cjs"]);
    pushCheck(checks, "frozen same-decision reference market quote and paired diagnostic", publicReferencePairs.status === 0
      && publicReferencePairs.body?.ok === true && publicReferencePairs.body?.checks >= 24, {
      status: publicReferencePairs.status, checks: publicReferencePairs.body?.checks ?? null,
      stdoutTail: publicReferencePairs.status === 0 ? "" : publicReferencePairs.stdout.slice(-500), stderrTail: publicReferencePairs.stderr.slice(-500),
    });

    const referencePairedBaseline = await runLocalJson(["scripts/verifyReferencePairedBaseline.cjs"]);
    pushCheck(checks, "complete-history public paired baseline reconciles with browser selectors", referencePairedBaseline.status === 0
      && referencePairedBaseline.body?.ok === true && referencePairedBaseline.body?.count >= 37, {
      status: referencePairedBaseline.status, checks: referencePairedBaseline.body?.count ?? null,
      stdoutTail: referencePairedBaseline.status === 0 ? "" : referencePairedBaseline.stdout.slice(-500), stderrTail: referencePairedBaseline.stderr.slice(-500),
    });

    const archivedPreMatchCutoff = await runLocalJson([
      "scripts/verifyArchivedPreMatchCutoff.cjs"
    ]);
    pushCheck(
      checks,
      "model-only pre-match reference archive remains immutable and outside formal statistics",
      archivedPreMatchCutoff.status === 0
        && archivedPreMatchCutoff.body?.ok === true
        && archivedPreMatchCutoff.body?.modelOnlyReferenceArchived === true
        && archivedPreMatchCutoff.body?.modelOnlyReferenceFormalPromotionRejected === true,
      {
        status: archivedPreMatchCutoff.status,
        modelOnlyReferenceArchived:
          archivedPreMatchCutoff.body?.modelOnlyReferenceArchived ?? null,
        modelOnlyReferenceFormalPromotionRejected:
          archivedPreMatchCutoff.body?.modelOnlyReferenceFormalPromotionRejected ?? null,
        stdoutTail: archivedPreMatchCutoff.status === 0
          ? ""
          : archivedPreMatchCutoff.stdout.slice(-500),
        stderrTail: archivedPreMatchCutoff.stderr.slice(-500),
      }
    );

    const publicationLedger = await runLocalJson(["scripts/verifyRecommendationPublicationLedger.cjs"]);
    pushCheck(checks, "immutable recommendation publication ledger", publicationLedger.status === 0 && publicationLedger.body?.ok === true, {
      status: publicationLedger.status,
      checks: Array.isArray(publicationLedger.body?.checks) ? publicationLedger.body.checks.length : null,
      failedChecks: failedArtifactChecks(publicationLedger),
      stdoutTail: publicationLedger.status === 0 ? "" : publicationLedger.stdout.slice(-500),
      stderrTail: publicationLedger.stderr.slice(-500)
    });

    const currentMatchRetention = await runLocalJson(["scripts/verifyCurrentMatchRetention.cjs"]);
    pushCheck(checks, "current match retention artifact", currentMatchRetention.status === 0 && currentMatchRetention.body?.ok === true, {
      status: currentMatchRetention.status,
      checks: Array.isArray(currentMatchRetention.body?.checks) ? currentMatchRetention.body.checks.length : null,
      retentionHours: currentMatchRetention.body?.summary?.retentionHours ?? null,
      stdoutTail: currentMatchRetention.status === 0 ? "" : currentMatchRetention.stdout.slice(-500),
      stderrTail: currentMatchRetention.stderr.slice(-500)
    });

    const communitySchedule = await runLocalJson(["scripts/verifyOpenFootballObservationSchedule.cjs"]);
    pushCheck(checks, "community receipt schedule is isolated, bounded and outside base publication", communitySchedule.status === 0
      && communitySchedule.body?.ok === true && communitySchedule.body?.verifier === "openfootball-observation-schedule-v1"
      && communitySchedule.body?.providerRequests === 0 && communitySchedule.body?.productionDataTouched === false
      && Array.isArray(communitySchedule.body?.checks) && communitySchedule.body.checks.length >= 17
      && communitySchedule.body.checks.every(check => check.ok === true)
      && communitySchedule.body.checks.some(check => check.name === "actual worker wiring keeps research step outside base-publication inputs"), {
      status: communitySchedule.status, checks: communitySchedule.body?.checks?.length ?? null,
      stdoutTail: communitySchedule.status === 0 ? "" : communitySchedule.stdout.slice(-500),
      stderrTail: communitySchedule.stderr.slice(-500),
    });

    const communityObservations = await runLocalJson(["scripts/verifyOpenFootballObservations.cjs"]);
    pushCheck(checks, "community raw receipts preserve first clocks and cannot publish predictions", communityObservations.status === 0
      && communityObservations.body?.ok === true && communityObservations.body?.checks >= 51
      && communityObservations.body?.providerRequests === 0
      && communityObservations.body?.productionDataTouched === false, {
      status: communityObservations.status, checks: communityObservations.body?.checks ?? null,
      stdoutTail: communityObservations.status === 0 ? "" : communityObservations.stdout.slice(-500),
      stderrTail: communityObservations.stderr.slice(-500),
    });

    const generationCompatibility = await runLocalJson(["scripts/verifyDataGenerationEndToEnd.cjs", "--buffered-compatibility-only"]);
    pushCheck(checks, "buffered generation preserves canonical identity and isolated publication behavior", generationCompatibility.status === 0
      && generationCompatibility.body?.ok === true
      && generationCompatibility.body?.version === "buffered-generation-compatibility-v1"
      && generationCompatibility.body?.checks >= 125
      && generationCompatibility.body?.bufferedCompatibilityChecks >= 125
      && generationCompatibility.body?.defaultServerDataTouched === false, {
      status: generationCompatibility.status,
      checks: generationCompatibility.body?.checks ?? null,
      bufferedCompatibilityChecks: generationCompatibility.body?.bufferedCompatibilityChecks ?? null,
      stdoutTail: generationCompatibility.status === 0 ? "" : generationCompatibility.stdout.slice(-500),
      stderrTail: generationCompatibility.stderr.slice(-500),
    });

    const selectedJson = await runLocalJson(["scripts/verifySelectedJsonObjectFile.cjs"]);
    pushCheck(checks, "bounded immutable JSON selection and full-file integrity", selectedJson.status === 0
      && selectedJson.body?.ok === true
      && selectedJson.body?.largeEvidence?.evidence?.bytes >= 440 * 1024 * 1024
      && selectedJson.body?.largeEvidence?.maxRssKiB < 320 * 1024, {
      status: selectedJson.status,
      checks: selectedJson.body?.checks ?? null,
      largeEvidence: selectedJson.body?.largeEvidence || null,
      stdoutTail: selectedJson.status === 0 ? "" : selectedJson.stdout.slice(-500),
      stderrTail: selectedJson.stderr.slice(-500),
    });

    const sqliteIncremental = await runLocalJson(["scripts/verifySqliteIncrementalExport.cjs"]);
    pushCheck(checks, "incremental SQLite warehouse artifact", sqliteIncremental.status === 0
      && sqliteIncremental.body?.ok === true
      && sqliteIncremental.body?.predictionStateIdentityVersion === "prediction-state-v3", {
      status: sqliteIncremental.status,
      checks: sqliteIncremental.body?.checks ?? null,
      predictionStateIdentityVersion: sqliteIncremental.body?.predictionStateIdentityVersion || null,
      stdoutTail: sqliteIncremental.status === 0 ? "" : sqliteIncremental.stdout.slice(-500),
      stderrTail: sqliteIncremental.stderr.slice(-500)
    });

    const privateModelArtifact = await runLocalJson(["scripts/verifyPrivateModelArtifactStore.cjs"]);
    pushCheck(checks, "private model artifact SQLite integrity", privateModelArtifact.status === 0 && privateModelArtifact.body?.ok === true, {
      status: privateModelArtifact.status,
      checks: privateModelArtifact.body?.checks ?? null,
      stdoutTail: privateModelArtifact.status === 0 ? "" : privateModelArtifact.stdout.slice(-500),
      stderrTail: privateModelArtifact.stderr.slice(-500)
    });

    const oddsStateDedup = await runLocalJson(["scripts/verifyDataStoreOddsStateDedup.cjs"]);
    pushCheck(checks, "odds state dedup artifact", oddsStateDedup.status === 0 && oddsStateDedup.body?.ok === true, {
      status: oddsStateDedup.status,
      checks: oddsStateDedup.body?.checks ?? null,
      stdoutTail: oddsStateDedup.status === 0 ? "" : oddsStateDedup.stdout.slice(-500),
      stderrTail: oddsStateDedup.stderr.slice(-500)
    });

    const streamingCompaction = await runLocalJson(["scripts/verifyStreamingDataStoreCompaction.cjs"]);
    pushCheck(checks, "streaming datastore compaction artifact", streamingCompaction.status === 0 && streamingCompaction.body?.ok === true, {
      status: streamingCompaction.status,
      checks: streamingCompaction.body?.checks ?? null,
      stdoutTail: streamingCompaction.status === 0 ? "" : streamingCompaction.stdout.slice(-500),
      stderrTail: streamingCompaction.stderr.slice(-500)
    });

    const syncDataMemorySafety = await runLocalJson(["scripts/verifySyncDataMemorySafety.cjs"]);
    pushCheck(checks, "sync data bounded-memory JSON publication", syncDataMemorySafety.status === 0
      && syncDataMemorySafety.body?.ok === true
      && Number(syncDataMemorySafety.body?.assertions || 0) >= 7, {
      status: syncDataMemorySafety.status,
      assertions: syncDataMemorySafety.body?.assertions ?? null,
      stdoutTail: syncDataMemorySafety.status === 0 ? "" : syncDataMemorySafety.stdout.slice(-500),
      stderrTail: syncDataMemorySafety.stderr.slice(-500)
    });

    const relayLaneFreshness = await runLocalJson(["scripts/verifyRelayLaneFreshness.cjs"]);
    pushCheck(checks, "relay lane freshness artifact", relayLaneFreshness.status === 0 && relayLaneFreshness.body?.ok === true, {
      status: relayLaneFreshness.status,
      checks: relayLaneFreshness.body?.checks ?? null,
      stdoutTail: relayLaneFreshness.status === 0 ? "" : relayLaneFreshness.stdout.slice(-500),
      stderrTail: relayLaneFreshness.stderr.slice(-500)
    });

    const relayFullRecovery = await runLocalJson(["scripts/verifySportteryRelayFullRecovery.cjs"]);
    pushCheck(checks, "relay full archive recovery artifact", relayFullRecovery.status === 0 && relayFullRecovery.body?.ok === true, {
      status: relayFullRecovery.status,
      checks: relayFullRecovery.body?.summary?.checks ?? null,
      stdoutTail: relayFullRecovery.status === 0 ? "" : relayFullRecovery.stdout.slice(-500),
      stderrTail: relayFullRecovery.stderr.slice(-500)
    });

    const matchLifecycle = await runLocalJson(["scripts/verifyMatchLifecycleReconciliation.cjs"]);
    pushCheck(checks, "match lifecycle reconciliation artifact", matchLifecycle.status === 0 && matchLifecycle.body?.ok === true, {
      status: matchLifecycle.status,
      checks: matchLifecycle.body?.checks ?? null,
      stdoutTail: matchLifecycle.status === 0 ? "" : matchLifecycle.stdout.slice(-500),
      stderrTail: matchLifecycle.stderr.slice(-500)
    });

    const matchDetailLifecycle = await runLocalJson(["scripts/verifyMatchDetailLifecycle.cjs"]);
    pushCheck(checks, "match detail lifecycle artifact", matchDetailLifecycle.status === 0 && matchDetailLifecycle.body?.ok === true
      && Array.isArray(matchDetailLifecycle.body?.checks) && matchDetailLifecycle.body.checks.length >= 24
      && matchDetailLifecycle.body.checks.some(check => check.name === "isolated SSR collector alias executes the real diagnostics module" && check.ok === true), {
      status: matchDetailLifecycle.status,
      checks: Array.isArray(matchDetailLifecycle.body?.checks) ? matchDetailLifecycle.body.checks.length : null,
      stdoutTail: matchDetailLifecycle.status === 0 ? "" : matchDetailLifecycle.stdout.slice(-500),
      stderrHead: matchDetailLifecycle.status === 0 ? "" : matchDetailLifecycle.stderr.slice(0, 500),
      stderrTail: matchDetailLifecycle.stderr.slice(-500)
    });

    const predictionMetricSemantics = await runLocalJson(["scripts/verifyPredictionMetricSemantics.cjs"]);
    pushCheck(checks, "prediction metric semantics artifact", predictionMetricSemantics.status === 0 && predictionMetricSemantics.body?.ok === true, {
      status: predictionMetricSemantics.status,
      checks: Array.isArray(predictionMetricSemantics.body?.checks) ? predictionMetricSemantics.body.checks.length : null,
      stdoutTail: predictionMetricSemantics.status === 0 ? "" : predictionMetricSemantics.stdout.slice(-500),
      stderrTail: predictionMetricSemantics.stderr.slice(-500)
    });

    const deploymentConfig = await runLocalJson(["scripts/verifyDeploymentConfig.cjs"]);
    pushCheck(checks, "deployment config artifact", deploymentConfig.status === 0 && deploymentConfig.body?.ok === true, {
      status: deploymentConfig.status,
      checks: Array.isArray(deploymentConfig.body?.checks) ? deploymentConfig.body.checks.length : null,
      stdoutTail: deploymentConfig.status === 0 ? "" : deploymentConfig.stdout.slice(-500),
      stderrTail: deploymentConfig.stderr.slice(-500)
    });

    const sshKeyRecovery = await runLocalJson(["scripts/verifySshOperatorKeyRecovery.cjs"]);
    pushCheck(checks, "SSH operator-key recovery artifact", sshKeyRecovery.status === 0 && sshKeyRecovery.body?.ok === true, {
      status: sshKeyRecovery.status,
      checks: Array.isArray(sshKeyRecovery.body?.checks) ? sshKeyRecovery.body.checks.length : null,
      stdoutTail: sshKeyRecovery.status === 0 ? "" : sshKeyRecovery.stdout.slice(-500),
      stderrTail: sshKeyRecovery.stderr.slice(-500)
    });

    const releaseSshHostKeyPin = await runLocalJson(["scripts/verifyReleaseSshHostKeyPin.cjs"]);
    pushCheck(checks, "release SSH host-key pin artifact", releaseSshHostKeyPin.status === 0 && releaseSshHostKeyPin.body?.ok === true, {
      status: releaseSshHostKeyPin.status,
      checks: Array.isArray(releaseSshHostKeyPin.body?.checks) ? releaseSshHostKeyPin.body.checks.length : null,
      stdoutTail: releaseSshHostKeyPin.status === 0 ? "" : releaseSshHostKeyPin.stdout.slice(-500),
      stderrTail: releaseSshHostKeyPin.stderr.slice(-500)
    });

    const releaseWatchPolicy = await runLocalJson(["scripts/verifyReleaseWatchPolicy.cjs"]);
    pushCheck(checks, "release watch candidate identity artifact", releaseWatchPolicy.status === 0 && releaseWatchPolicy.body?.ok === true, {
      status: releaseWatchPolicy.status,
      checks: Array.isArray(releaseWatchPolicy.body?.checks) ? releaseWatchPolicy.body.checks.length : null,
      stdoutTail: releaseWatchPolicy.status === 0 ? "" : releaseWatchPolicy.stdout.slice(-500),
      stderrTail: releaseWatchPolicy.stderr.slice(-500)
    });

    const accessCodeConcurrency = await runLocalJson(["scripts/verifyAccessCodeConcurrency.cjs"]);
    pushCheck(checks, "access code concurrency artifact", accessCodeConcurrency.status === 0 && accessCodeConcurrency.body?.ok === true, {
      status: accessCodeConcurrency.status,
      finalStatus: accessCodeConcurrency.body?.summary?.revocationRace?.finalStatus || null,
      postRevokeDenied: accessCodeConcurrency.body?.summary?.revocationRace?.postRevokeDenied ?? null,
      writeFailureStatus: accessCodeConcurrency.body?.summary?.writeFailure?.verifyStatus ?? null,
      stdoutTail: accessCodeConcurrency.status === 0 ? "" : accessCodeConcurrency.stdout.slice(-1000),
      stderrTail: accessCodeConcurrency.stderr.slice(-1000)
    });

    const releaseTransactionSafety = await runLocalJson(["scripts/verifyReleaseTransactionSafety.cjs"]);
    pushCheck(checks, "release transaction safety artifact", releaseTransactionSafety.status === 0, {
      status: releaseTransactionSafety.status,
      stdoutTail: releaseTransactionSafety.status === 0 ? "" : releaseTransactionSafety.stdout.slice(-1000),
      stderrTail: releaseTransactionSafety.stderr.slice(-1000)
    });

    const releaseRecovery = await runLocalJson(["scripts/verifyReleaseRecovery.cjs"]);
    pushCheck(checks, "cold release recovery artifact", releaseRecovery.status === 0 && releaseRecovery.body?.ok === true, {
      status: releaseRecovery.status,
      rollbackPhases: releaseRecovery.body?.rollbackPhases ?? null,
      forwardPhases: releaseRecovery.body?.forwardPhases ?? null,
      assertions: releaseRecovery.body?.assertions ?? null,
      failedChecks: failedArtifactChecks(releaseRecovery),
      stdoutTail: releaseRecovery.status === 0 ? "" : releaseRecovery.stdout.slice(-1000),
      stderrTail: releaseRecovery.stderr.slice(-1000)
    });

    const legacyReleaseDisabled = await runLocalJson(["scripts/verifyLegacyReleaseDisabled.cjs"]);
    pushCheck(checks, "legacy release disabled artifact", legacyReleaseDisabled.status === 0 && legacyReleaseDisabled.body?.ok === true, {
      status: legacyReleaseDisabled.status,
      checks: Array.isArray(legacyReleaseDisabled.body?.checks) ? legacyReleaseDisabled.body.checks.length : null,
      stdoutTail: legacyReleaseDisabled.status === 0 ? "" : legacyReleaseDisabled.stdout.slice(-1000),
      stderrTail: legacyReleaseDisabled.stderr.slice(-1000)
    });

    const serverPrimary = await runLocalJson(["scripts/verifyServerPrimaryDataFlow.cjs"]);
    pushCheck(checks, "server-primary data flow artifact", serverPrimary.status === 0 && serverPrimary.body?.ok === true, {
      status: serverPrimary.status,
      checks: Array.isArray(serverPrimary.body?.checks) ? serverPrimary.body.checks.length : null,
      productionDataMode: serverPrimary.body?.summary?.productionDataMode || null,
      localDataPushRequired: serverPrimary.body?.summary?.localDataPushRequired || null,
      cloudSyncRequired: serverPrimary.body?.summary?.cloudSyncRequired || null,
      stdoutTail: serverPrimary.status === 0 ? "" : serverPrimary.stdout.slice(-500),
      stderrTail: serverPrimary.stderr.slice(-500)
    });

    const cloudflareWorkerPolicy = await runLocalJson(["scripts/verifyCloudflareWorkerPolicy.cjs"]);
    pushCheck(checks, "cloudflare worker policy artifact", cloudflareWorkerPolicy.status === 0 && cloudflareWorkerPolicy.body?.ok === true, {
      status: cloudflareWorkerPolicy.status,
      checks: Array.isArray(cloudflareWorkerPolicy.body?.checks) ? cloudflareWorkerPolicy.body.checks.length : null,
      stdoutTail: cloudflareWorkerPolicy.status === 0 ? "" : cloudflareWorkerPolicy.stdout.slice(-500),
      stderrTail: cloudflareWorkerPolicy.stderr.slice(-500)
    });

    const cloudflareSportteryCollector = await runLocalJson(["scripts/verifyCloudflareSportteryCollector.cjs"]);
    pushCheck(checks, "cloudflare independent Sporttery collector artifact", cloudflareSportteryCollector.status === 0
      && cloudflareSportteryCollector.body?.ok === true
      && cloudflareSportteryCollector.body?.acceptedRows === 2, {
      status: cloudflareSportteryCollector.status,
      acceptedRows: cloudflareSportteryCollector.body?.acceptedRows ?? null,
      checks: Array.isArray(cloudflareSportteryCollector.body?.checks)
        ? cloudflareSportteryCollector.body.checks.length
        : null,
      stdoutTail: cloudflareSportteryCollector.status === 0 ? "" : cloudflareSportteryCollector.stdout.slice(-500),
      stderrTail: cloudflareSportteryCollector.stderr.slice(-500)
    });

    const huaweiFunctionGraphCollector = await runLocalJson(["scripts/verifyHuaweiFunctionGraphCollector.cjs"]);
    pushCheck(checks, "Huawei FunctionGraph independent Sporttery collector artifact", huaweiFunctionGraphCollector.status === 0
      && huaweiFunctionGraphCollector.body?.ok === true
      && huaweiFunctionGraphCollector.body?.acceptedRows === 2, {
      status: huaweiFunctionGraphCollector.status,
      acceptedRows: huaweiFunctionGraphCollector.body?.acceptedRows ?? null,
      assertions: huaweiFunctionGraphCollector.body?.assertions ?? null,
      independenceDomain: huaweiFunctionGraphCollector.body?.independenceDomain ?? null,
      stdoutTail: huaweiFunctionGraphCollector.status === 0 ? "" : huaweiFunctionGraphCollector.stdout.slice(-500),
      stderrTail: huaweiFunctionGraphCollector.stderr.slice(-500)
    });

    const planCoverage = await runLocalJson(["scripts/verifyProductionPlanCoverage.cjs"]);
    pushCheck(checks, "production plan coverage artifact", planCoverage.status === 0 && planCoverage.body?.ok === true, {
      status: planCoverage.status,
      phases: planCoverage.body?.summary?.phases ?? null,
      checks: planCoverage.body?.summary?.checks ?? null,
      required: planCoverage.body?.summary?.required ?? null,
      watch: planCoverage.body?.summary?.watch ?? null,
      failedChecks: failedArtifactChecks(planCoverage),
      stdoutTail: planCoverage.status === 0 ? "" : planCoverage.stdout.slice(-500),
      stderrTail: planCoverage.stderr.slice(-500)
    });

    // The sync worker is frozen before this verifier starts, but the HTTP
    // process may still be validating a newly committed generation pointer.
    // Require the immutable generation and SQLite projection to converge
    // before comparing recommendation risk across separate API requests.
    await waitForSqlitePrimaryRead(checks, "sqlite primary read before API contracts");

    const apiContracts = await runLocalJson(["scripts/verifyApiContracts.cjs"], {
      CONTRACT_BASE_URL: baseUrl.toString(),
      CONTRACT_START_SERVER: "0",
      ADMIN_TOKEN: adminToken,
      ACCESS_CODE_ADMIN_TOKEN: accessCodeAdminToken
    });
    const apiContractSummary = apiContracts.body?.summary || {};
    const apiContractFailures = (Array.isArray(apiContracts.body?.checks)
      ? apiContracts.body.checks
      : [])
      .filter((check) => check?.ok !== true)
      .map((check) => ({
        name: check?.name || "unnamed-check",
        ...Object.fromEntries(
          Object.entries(check || {}).filter(([key]) => (
            key !== "name" && key !== "ok"
          )),
        ),
      }));
    pushCheck(checks, "api contract artifact", apiContracts.status === 0 && apiContracts.body?.ok === true, {
      status: apiContracts.status,
      currentRows: apiContractSummary.currentRows ?? null,
      selectedMatchId: apiContractSummary.selectedMatchId || null,
      historyMaxLimit: apiContractSummary.historyMaxLimit ?? null,
      oddsMaxLimit: apiContractSummary.oddsMaxLimit ?? null,
      failedChecks: failedArtifactChecks(apiContracts),
      failedCheckDetails: apiContractFailures,
      stdoutTail: apiContracts.status === 0 ? "" : apiContracts.stdout.slice(-500),
      stderrTail: apiContracts.stderr.slice(-500)
    });

    const recommendationParity = await runLocalJson(
      ["scripts/verifyRemoteRecommendationParity.cjs"],
      {
        REMOTE_RECOMMENDATION_BASE_URL: baseUrl.toString(),
        REMOTE_RECOMMENDATION_ACCESS_CODE_ADMIN_TOKEN: accessCodeAdminToken,
      }
    );
    const recommendationParitySummary = recommendationParity.body?.summary || {};
    const recommendationParitySession = recommendationParity.body?.accessSession || {};
    pushCheck(
      checks,
      "all protected list, detail, and frozen archive recommendations share one canonical direction",
      recommendationParity.status === 0
        && recommendationParity.body?.ok === true
        && recommendationParitySession.mode === "temporary-admin-code"
        && recommendationParitySession.created === true
        && recommendationParitySession.verified === true
        && recommendationParitySession.revoked === true,
      {
        status: recommendationParity.status,
        rows: recommendationParitySummary.rows ?? null,
        checked: recommendationParitySummary.checked ?? null,
        scheduledWithoutBest: recommendationParitySummary.scheduledWithoutBest ?? null,
        resultPhaseWithoutArchive:
          recommendationParitySummary.resultPhaseWithoutArchive ?? null,
        postKickoffScheduled:
          recommendationParitySummary.postKickoffScheduled ?? null,
        archiveScopeCounts:
          recommendationParitySummary.archiveScopeCounts || {},
        mismatches: recommendationParitySummary.mismatches ?? null,
        mismatchRows: Array.isArray(recommendationParity.body?.mismatches)
          ? recommendationParity.body.mismatches.slice(0, 8)
          : [],
        temporaryAccessCodeRevoked: recommendationParitySession.revoked === true,
        failedChecks: failedArtifactChecks(recommendationParity),
        stdoutTail: recommendationParity.status === 0
          ? ""
          : recommendationParity.stdout.slice(-500),
        stderrTail: recommendationParity.stderr.slice(-500),
      }
    );

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
      failedChecks: failedArtifactChecks(frontendObservability),
      stdoutTail: frontendObservability.status === 0 ? "" : frontendObservability.stdout.slice(-500),
      stderrTail: frontendObservability.stderr.slice(-500)
    });

    const frontendAccessibility = await runLocalJson(["scripts/verifyFrontendAccessibility.cjs"]);
    pushCheck(checks, "frontend accessibility artifact", frontendAccessibility.status === 0 && frontendAccessibility.body?.ok === true, {
      status: frontendAccessibility.status,
      total: frontendAccessibility.body?.summary?.total ?? null,
      passed: frontendAccessibility.body?.summary?.passed ?? null,
      failed: frontendAccessibility.body?.summary?.failed ?? null,
      stdoutTail: frontendAccessibility.status === 0 ? "" : frontendAccessibility.stdout.slice(-500),
      stderrTail: frontendAccessibility.stderr.slice(-500)
    });

    const predictionsPageFocus = await runLocalJson(["scripts/verifyPredictionsPageFocus.cjs"]);
    pushCheck(checks, "predictions page focus artifact", predictionsPageFocus.status === 0 && predictionsPageFocus.body?.ok === true, {
      status: predictionsPageFocus.status,
      total: predictionsPageFocus.body?.summary?.total ?? null,
      passed: predictionsPageFocus.body?.summary?.passed ?? null,
      failed: predictionsPageFocus.body?.summary?.failed ?? null,
      strictHelperUses: predictionsPageFocus.body?.summary?.strictHelperUses ?? null,
      duplicateRecommendationMarkers: predictionsPageFocus.body?.summary?.duplicateRecommendationMarkers || [],
      failedChecks: failedArtifactChecks(predictionsPageFocus),
      stdoutTail: predictionsPageFocus.status === 0 ? "" : predictionsPageFocus.stdout.slice(-500),
      stderrTail: predictionsPageFocus.stderr.slice(-500)
    });

    const sourceHealth = await request("GET", "/api/v1/source-health");
    const syncMeta = await request("GET", "/api/v1/sync-meta");
    const syncMetaFallback = syncMeta.body?.fallback || null;
    const syncMetaApi = syncMeta.body?.api || null;
    const syncMetaFallbackReason = syncMetaFallback?.reason || syncMetaApi?.fallbackReason || null;
    const syncMetaFallbackHasFreshness = Boolean(
      syncMetaApi?.freshnessTime
      || syncMetaApi?.currentFreshnessTime
      || syncMetaApi?.historyFreshnessTime
    );
    const syncMetaFallbackMarked = syncMetaApi?.stale === true
      || syncMetaApi?.partialStale === true
      || syncMetaApi?.historyStale === true
      || syncMeta.body?.sourceHistoryGuard?.active === true
      || syncMeta.body?.sourceFallback?.active === true;
    const syncMetaFallbackServiceable = syncMetaApi?.stale === true
      || (
        syncMetaApi?.currentStale === false
        && syncMetaApi?.fallbackCoverage?.currentLaneFresh === true
        && syncMetaApi?.partialStale === true
      );
    pushCheck(checks, "sync-meta fallback contract", syncMeta.status === 200 && (
      !syncMetaFallback?.keptExisting
      || (
        Boolean(syncMetaFallbackReason)
        && syncMetaFallbackHasFreshness
        && syncMetaFallbackMarked
        && syncMetaFallbackServiceable
        && Boolean(syncMeta.body?.lastAttemptAt)
      )
    ), {
      status: syncMeta.status,
      fallback: Boolean(syncMetaFallback?.keptExisting),
      stale: syncMetaApi?.stale ?? null,
      currentStale: syncMetaApi?.currentStale ?? null,
      historyStale: syncMetaApi?.historyStale ?? null,
      partialStale: syncMetaApi?.partialStale ?? null,
      currentLaneFresh: syncMetaApi?.fallbackCoverage?.currentLaneFresh ?? null,
      freshnessTime: syncMetaApi?.freshnessTime || null,
      currentFreshnessTime: syncMetaApi?.currentFreshnessTime || null,
      historyFreshnessTime: syncMetaApi?.historyFreshnessTime || null,
      lastAttemptAt: syncMeta.body?.lastAttemptAt || null,
      reason: syncMetaFallbackReason
    });
    pushCheck(checks, "sync-meta compact payload", syncMeta.status === 200 && syncMeta.bytes < 1_000_000 && !syncMeta.body?.oddsHistory?.payload, {
      status: syncMeta.status,
      bytes: syncMeta.bytes,
      hasEmbeddedOddsHistoryPayload: Boolean(syncMeta.body?.oddsHistory?.payload)
    });
    const publicSyncStrategy = syncMeta.body?.modelStrategy || null;
    const publicSyncStrategyText = JSON.stringify(publicSyncStrategy || null);
    pushCheck(checks, "sync-meta model strategy redaction", syncMeta.status === 200
      && (!publicSyncStrategy || publicSyncStrategy.publicView === true)
      && !publicSyncStrategy?.activeGates
      && !publicSyncStrategy?.recommendations
      && !publicSyncStrategyText.includes('"shadowCandidate":')
      && !publicSyncStrategyText.includes('"modelSignalCandidate":')
      && !publicSyncStrategyText.includes('"bestModelCandidateId":')
      && !publicSyncStrategyText.includes('"weights":'), {
        status: syncMeta.status,
        publicView: publicSyncStrategy?.publicView ?? null,
        hasActiveGates: Boolean(publicSyncStrategy?.activeGates),
        hasRecommendations: Boolean(publicSyncStrategy?.recommendations),
        leaksCandidateMetadata: publicSyncStrategyText.includes('"shadowCandidate":')
          || publicSyncStrategyText.includes('"modelSignalCandidate":')
          || publicSyncStrategyText.includes('"bestModelCandidateId":')
          || publicSyncStrategyText.includes('"weights":')
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
    const fallbackCoverage = sourceHealth.body?.fallbackCoverage || null;
    const officialSourceRedundancy = sourceHealth.body?.officialSourceRedundancy || null;
    const trustedCollectorCount = Number(officialSourceRedundancy?.trustedCollectorCount);
    const requiredTrustedCollectors = Number(officialSourceRedundancy?.requiredTrustedCollectors);
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
    pushCheck(checks, "source health fallback coverage", sourceHealth.status === 200 && Boolean(fallbackCoverage?.servingMode) && Number.isFinite(Number(fallbackCoverage?.currentMatches)), {
      status: sourceHealth.status,
      servingMode: fallbackCoverage?.servingMode || null,
      usable: fallbackCoverage?.usable ?? null,
      primaryStale: fallbackCoverage?.primaryStale ?? null,
      currentMatches: fallbackCoverage?.currentMatches ?? null,
      fiveHundredCoveragePercent: fallbackCoverage?.fiveHundredCoveragePercent ?? null,
      referenceOddsMatches: fallbackCoverage?.referenceOddsMatches ?? null
    });
    pushCheck(checks, "official source redundancy is explicit non-blocking health evidence", sourceHealth.status === 200
      && typeof sourceHealth.body?.officialSourceSinglePoint === "boolean"
      && officialSourceRedundancy
      && ["watch", "redundant"].includes(officialSourceRedundancy.status)
      && Number.isInteger(trustedCollectorCount)
      && Number.isInteger(requiredTrustedCollectors)
      && requiredTrustedCollectors >= 2
      && sourceHealth.body.officialSourceSinglePoint === Boolean(
        officialSourceRedundancy.serverDirectAvailable !== true
        && trustedCollectorCount < requiredTrustedCollectors
      ), {
      officialSourceSinglePoint: sourceHealth.body?.officialSourceSinglePoint ?? null,
      redundancyStatus: officialSourceRedundancy?.status || null,
      redundancyMode: officialSourceRedundancy?.mode || null,
      serverDirectAvailable: officialSourceRedundancy?.serverDirectAvailable ?? null,
      trustedCollectorCount: officialSourceRedundancy?.trustedCollectorCount ?? null,
      requiredTrustedCollectors: officialSourceRedundancy?.requiredTrustedCollectors ?? null,
      note: "watch is reported as evidence and does not change source-health ok by itself"
    });
    pushCheck(checks, "sync-meta runtime source-health mirror", syncMeta.status === 200
      && sourceHealth.status === 200
      && syncMeta.body?.sourceHealth?.runtime === true
      && syncMeta.body?.sourceHealth?.servingMode === fallbackCoverage?.servingMode
      && syncMeta.body?.sourceHealth?.primaryStale === fallbackCoverage?.primaryStale
      && syncMeta.body?.sourceHealth?.officialSourceSinglePoint === sourceHealth.body?.officialSourceSinglePoint
      && syncMeta.body?.sourceHealth?.officialSourceRedundancy?.status === officialSourceRedundancy?.status
      && syncMeta.body?.api?.fallbackCoverage?.servingMode === fallbackCoverage?.servingMode
      && syncMeta.body?.runtimeSourceHealth?.servingMode === fallbackCoverage?.servingMode
      && syncMeta.body?.runtimeSourceHealth?.officialSourceSinglePoint === sourceHealth.body?.officialSourceSinglePoint
      && syncMeta.body?.runtimeSourceHealth?.officialSourceRedundancy?.mode === officialSourceRedundancy?.mode, {
        syncMetaStatus: syncMeta.status,
        sourceHealthStatus: sourceHealth.status,
        syncMetaServingMode: syncMeta.body?.sourceHealth?.servingMode || null,
        sourceHealthServingMode: fallbackCoverage?.servingMode || null,
        syncMetaPrimaryStale: syncMeta.body?.sourceHealth?.primaryStale ?? null,
        sourceHealthPrimaryStale: fallbackCoverage?.primaryStale ?? null,
        officialSourceSinglePoint: syncMeta.body?.sourceHealth?.officialSourceSinglePoint ?? null,
        officialSourceRedundancyStatus: syncMeta.body?.sourceHealth?.officialSourceRedundancy?.status || null,
        runtime: syncMeta.body?.sourceHealth?.runtime ?? null
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
      pushCheck(checks, "source health admin sporttery diagnostics", sourceHealthAdmin.status === 200 && Boolean(adminPayload?.crawlerSources?.sporttery?.api) && Boolean(adminPayload?.crawlerErrors?.sporttery), {
        status: sourceHealthAdmin.status,
        transport: adminPayload?.crawlerSources?.sporttery?.api?.transport || null,
        relaySnapshot: adminPayload?.crawlerSources?.sporttery?.relaySnapshot || null,
        sportteryErrorCount: adminPayload?.crawlerErrors?.sporttery?.count ?? null,
        recentErrors: (adminPayload?.crawlerErrors?.sporttery?.recent || []).slice(0, 3)
      });
    }

    const model = await request("GET", "/api/v1/model/evaluation");
    const modelEvaluationArtifact = readModelEvaluationArtifact();
    const artifactEvaluation = modelEvaluationArtifact.body || null;
    const artifactWalkForward = artifactEvaluation?.walkForwardValidation || null;
    const probabilityRows = Number(model.body?.backtest?.sample?.probabilityRows || 0);
    const marketRows = Number(model.body?.backtest?.sample?.marketBaselineRows || 0);
    const inputAudit = model.body?.backtest?.inputAudit || null;
    const riskTiers = model.body?.backtest?.riskTiers || null;
    const shadowCandidates = model.body?.backtest?.shadowCandidates || null;
    const publicScorecard = model.body?.publicScorecard || null;
    const publicHhadBacktest = model.body?.backtest?.hhadCompanionEvaluation || null;
    const sampleHhadCompanion = model.body?.backtest?.sample?.hhadCompanion || null;
    const requiredCandidateIds = ["market-baseline", "elo-rating-v1", "poisson-goals-v1", "historical-elo-poisson-50"];
    const promotionGate = model.body?.strategy?.activation?.promotionGate || null;
    const strategyOnlineEffect = model.body?.strategy?.activation?.onlineEffect || "";
    const publicLeaksCandidates = Array.isArray(shadowCandidates?.candidates);
    const publicLeaksCandidateIds = Boolean(shadowCandidates?.bestCandidateId || shadowCandidates?.bestCandidate?.id || shadowCandidates?.bestCandidate?.featureSet);
    const publicLeaksStrategyRules = Boolean(model.body?.strategy?.activeGates || model.body?.strategy?.recommendations);
    const publicLeaksStrategyCandidateDetail = Boolean(promotionGate?.shadowCandidate || promotionGate?.modelSignalCandidate);
    const publicHhadCompanion = publicScorecard?.shadowTracks?.HHAD_COMPANION || null;
    const hhadSensitiveKeyLeaks = findHhadCompanionSensitiveKeyLeaks({
      publicHhadCompanion,
      publicHhadBacktest,
      sampleHhadCompanion
    });
    const publicLeaksHhadRows = hhadSensitiveKeyLeaks.length > 0;
    pushCheck(checks, "model evaluation", model.status === 200 && probabilityRows >= minProbabilityRows && inputAudit?.ok === true, {
      status: model.status,
      version: model.body?.backtest?.version || null,
      probabilityRows,
      marketBaselineRows: marketRows,
      inputAuditOk: inputAudit?.ok ?? null,
      inputAuditViolationCount: inputAudit?.violationCount ?? null,
      minProbabilityRows
    });
    pushCheck(checks, "candidate model evaluation schema and digest", model.status === 200
      && model.body?.backtest?.version === expectedModelEvaluationVersion
      && modelEvaluationArtifact.ok === true
      && artifactEvaluation?.ok === true
      && artifactEvaluation?.version === expectedModelEvaluationVersion
      && artifactWalkForward?.version === expectedWalkForwardValidationVersion
      && artifactWalkForward?.protocolVersion === expectedWalkForwardProtocolVersion
      && artifactEvaluation?.generatedAt === model.body?.backtest?.generatedAt
      && /^[a-f0-9]{64}$/.test(String(modelEvaluationArtifact.sha256 || "")), {
      path: modelEvaluationArtifact.path,
      sha256: modelEvaluationArtifact.sha256,
      expectedEvaluationVersion: expectedModelEvaluationVersion,
      apiEvaluationVersion: model.body?.backtest?.version || null,
      artifactEvaluationVersion: artifactEvaluation?.version || null,
      expectedWalkForwardVersion: expectedWalkForwardValidationVersion,
      artifactWalkForwardVersion: artifactWalkForward?.version || null,
      expectedWalkForwardProtocolVersion,
      artifactWalkForwardProtocolVersion: artifactWalkForward?.protocolVersion || null,
      apiGeneratedAt: model.body?.backtest?.generatedAt || null,
      artifactGeneratedAt: artifactEvaluation?.generatedAt || null,
      error: modelEvaluationArtifact.error
    });
    pushCheck(checks, "model risk tier evaluation", model.status === 200
      && riskTiers?.version === "model-risk-tier-v1"
      && ["stable", "watch", "degraded"].includes(riskTiers?.overall?.tier)
      && riskTiers?.recommendationBucketScope === "formal"
      && riskTiers?.shadowRecommendationBucketScope === "shadow"
      && (riskTiers?.recommendationBuckets || []).every((bucket) => bucket?.scope === "formal")
      && (riskTiers?.shadowRecommendationBuckets || []).every((bucket) => bucket?.scope === "shadow")
      && riskTiers?.policy?.probabilityOverride === false, {
        status: model.status,
        riskVersion: riskTiers?.version || null,
        overallTier: riskTiers?.overall?.tier || null,
        maxCalibrationError: riskTiers?.confidenceBuckets?.maxCalibrationError ?? null,
        probabilityOverride: riskTiers?.policy?.probabilityOverride ?? null
      });
    pushCheck(checks, "model evaluation public redaction", model.status === 200
      && model.body?.publicView === true
      && !publicLeaksCandidates
      && !publicLeaksCandidateIds
      && !publicLeaksStrategyRules
      && !publicLeaksStrategyCandidateDetail
      && !publicLeaksHhadRows, {
      status: model.status,
      publicView: model.body?.publicView ?? null,
      leaksCandidates: publicLeaksCandidates,
      leaksCandidateIds: publicLeaksCandidateIds,
      leaksStrategyRules: publicLeaksStrategyRules,
      leaksStrategyCandidateDetail: publicLeaksStrategyCandidateDetail,
      leaksHhadRows: publicLeaksHhadRows,
      hhadSensitiveKeyLeaks,
      hiddenFields: model.body?.hiddenFields || []
    });
    const scorecardRecommendationSampleUnavailable = Number(publicScorecard?.sample?.formalRecommendationRows || 0) === 0
      && ["watch", "degraded"].includes(publicScorecard?.status?.riskTier);
    pushCheck(checks, "public model scorecard", model.status === 200
      && publicScorecard?.version === "public-model-scorecard-v2"
      && publicScorecard?.publicView === true
      && publicScorecard?.buckets?.scope === "formal-recommendations-only"
      && publicScorecard?.sample?.formalRecommendationRows === publicScorecard?.sample?.predictionRows
      && publicHhadCompanion?.publicView === true
      && publicHhadCompanion?.onlineEffect === "shadow"
      && publicHhadCompanion?.promotionAllowed === false
      && publicHhadCompanionSchemaValid(publicHhadCompanion)
      && publicHhadCompanionSchemaValid(publicHhadBacktest)
      && isNonNegativeInteger(publicHhadCompanion?.counts?.pairedNonVoidRows)
      && isNonNegativeInteger(sampleHhadCompanion?.pairedNonVoidRows)
      && sampleHhadCompanion.pairedNonVoidRows === publicHhadCompanion.counts.pairedNonVoidRows
      && hhadSensitiveKeyLeaks.length === 0
      && Array.isArray(publicHhadCompanion?.gate?.failedChecks)
      && (scorecardRecommendationSampleUnavailable || (
        (publicScorecard?.buckets?.markets || []).length > 0
        && (publicScorecard?.buckets?.leagues || []).length > 0
        && (publicScorecard?.buckets?.odds || []).length > 0
      )), {
        status: model.status,
        version: publicScorecard?.version || null,
        scorecardRecommendationSampleUnavailable,
        formalRecommendationRows: publicScorecard?.sample?.formalRecommendationRows ?? null,
        marketBuckets: publicScorecard?.buckets?.markets?.length || 0,
        leagueBuckets: publicScorecard?.buckets?.leagues?.length || 0,
        oddsBuckets: publicScorecard?.buckets?.odds?.length || 0,
        hhadCompanionStatus: publicHhadCompanion?.candidateStatus || null,
        hhadCompanionRows: publicHhadCompanion?.counts?.pairedNonVoidRows ?? null,
        hiddenFields: publicScorecard?.hiddenFields || []
      });
    pushCheck(checks, "model promotion gate", promotionGate && (promotionGate.status !== "shadow" || strategyOnlineEffect === "shadow"), {
      status: promotionGate?.status || null,
      onlineEffect: strategyOnlineEffect || null,
      rollingSource: promotionGate?.metrics?.rollingSource || null,
      rollingPassRate: promotionGate?.metrics?.rollingPassRate ?? null,
      reasons: promotionGate?.reasons || []
    });
    const promotionGateOnline = promotionGate?.status === "eligible" && strategyOnlineEffect === "guarded-active";
    const healthDataFresh = health.body?.status?.dataFresh === true;
    const healthModelEvaluationFresh = health.body?.status?.modelEvaluationFresh === true;
    const healthModelRiskStable = health.body?.status?.modelRiskStable === true;
    const minRecommendationRows = Math.max(1, Number(process.env.MODEL_RELIABILITY_MIN_ROWS || 30));
    const minPromotionBaselineRows = Math.max(1, Number(process.env.MODEL_PROMOTION_MIN_BASELINE_ROWS || 500));
    const minPromotionRollingPassRate = Math.max(0, Number(process.env.MODEL_PROMOTION_MIN_ROLLING_PASS_RATE || 0.6));
    const calibrationReady = Number(health.body?.model?.calibrationRecommendationSample || 0) >= minRecommendationRows;
    const modelSignalPromotionReady = promotionGateOnline
      && health.body?.model?.promotionEligibleScope === "model-signal"
      && health.body?.model?.promotionModelSignalReady === true
      && Number(health.body?.model?.marketBaselineRows || 0) >= minPromotionBaselineRows
      && (
        !Number.isFinite(Number(health.body?.model?.rollingPassRate))
        || Number(health.body?.model?.rollingPassRate) >= minPromotionRollingPassRate
      );
    const expectedRecommendationReliable = healthDataFresh
      && healthModelEvaluationFresh
      && healthModelRiskStable
      && (calibrationReady || modelSignalPromotionReady);
    pushCheck(checks, "health recommendation reliability follows model risk and promotion scope", health.body?.status?.recommendationReliable === expectedRecommendationReliable, {
      promotionGateOnline,
      healthDataFresh,
      healthModelEvaluationFresh,
      healthModelRiskStable,
      calibrationReady,
      modelSignalPromotionReady,
      expectedRecommendationReliable,
      healthRecommendationReliable: health.body?.status?.recommendationReliable ?? null,
      healthServingMode: health.body?.status?.servingMode || null,
      healthReliabilitySource: health.body?.model?.reliabilitySource || null,
      healthMarketBaselineRows: health.body?.model?.marketBaselineRows ?? null,
      healthStrategySample: health.body?.model?.strategyRecommendationSample ?? null,
      healthRecommendationSample: health.body?.model?.recommendationSample ?? null
    });
    pushCheck(checks, "shadow candidate public summary", Boolean(shadowCandidates?.bestCandidateAvailable && shadowCandidates?.sample?.rows > 0 && !publicLeaksCandidateIds), {
      version: shadowCandidates?.version || null,
      rows: shadowCandidates?.sample?.rows || 0,
      bestCandidateAvailable: shadowCandidates?.bestCandidateAvailable ?? null,
      bestRole: shadowCandidates?.bestCandidate?.role || null,
      rollingPassRate: shadowCandidates?.bestCandidate?.rolling?.passRate ?? null,
      rollingWindows: shadowCandidates?.bestCandidate?.rolling?.windows ?? 0,
      candidateListPublic: Array.isArray(shadowCandidates?.candidates),
      leaksCandidateIds: publicLeaksCandidateIds
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
      const candidateCaptureAudit = modelAdmin.body?.candidateCaptureAudit || null;
      const candidateCaptureRows = candidateCaptureAudit?.readiness?.rows || [];
      const candidateExclusionAudit = candidateCaptureAudit?.exclusionAudit || null;
      const candidateTemporalStatus = candidateCaptureAudit?.temporalStatus || null;
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
          const keys = Object.keys(row || {});
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
        "officialVoidRows",
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
              "official-void",
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
      pushCheck(checks, "model evaluation admin diagnostics", modelAdmin.status === 200
        && modelAdmin.body?.admin?.includesInternalCandidates === true
        && candidateCaptureAuditFieldPresent
        && candidateCaptureAvailabilityConsistent
        && candidateExclusionAvailabilityConsistent
        && (
          candidateCaptureAudit === null
          || candidateCaptureAudit?.version === "candidate-capture-admin-audit-v1"
        )
        && captureRowsAreSanitized
        && exclusionAuditIsSanitized
        && temporalStatusIsSanitized
        && temporalDiagnosticsAreSanitized
        && temporalReasonCountsAreSanitized
        && candidateIds.length > 0, {
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
        exclusionAuditIsSanitized,
        exclusionRows: exclusionRows.length,
        temporalAggregateKeysAreSanitized,
        temporalDenominatorIsReconciled,
        temporalStatusIsSanitized,
        temporalDiagnosticsAreSanitized,
        temporalDiagnosticRows: temporalDiagnosticRows.length,
        temporalReasonCountsAreSanitized,
        candidateTemporalStatus,
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

      const relayNoAuth = await request("POST", "/api/admin/sporttery-relay-snapshot?validateOnly=1", { snapshot: sampleSportteryRelaySnapshot() });
      pushCheck(checks, "sporttery relay upload no-auth denied", relayNoAuth.status === 401, { status: relayNoAuth.status });

      const relayQueryAdmin = await request("POST", `/api/admin/sporttery-relay-snapshot?validateOnly=1&token=${encodeURIComponent(adminToken)}`, {
        snapshot: sampleSportteryRelaySnapshot()
      });
      pushCheck(checks, "sporttery relay upload query token denied", relayQueryAdmin.status === 401, { status: relayQueryAdmin.status });

      const relayValidate = await request("POST", "/api/admin/sporttery-relay-snapshot?validateOnly=1", {
        snapshot: sampleSportteryRelaySnapshot()
      }, {
        authorization: `Bearer ${adminToken}`
      });
      pushCheck(checks, "sporttery relay upload validate-only", relayValidate.status === 200 && relayValidate.body?.ok === true && relayValidate.body?.validateOnly === true && relayValidate.body?.validation?.rows >= 1, {
        status: relayValidate.status,
        ok: relayValidate.body?.ok ?? null,
        validateOnly: relayValidate.body?.validateOnly ?? null,
        rows: relayValidate.body?.validation?.rows ?? null,
        usableEndpoints: relayValidate.body?.validation?.usableEndpoints ?? null
      });

      const compactFullReject = await request("POST", "/api/admin/sporttery-relay-snapshot?validateOnly=1", {
        snapshot: sampleFastSportteryRelaySnapshot()
      }, {
        authorization: `Bearer ${adminToken}`
      });
      pushCheck(checks, "sporttery full relay rejects compact fast snapshot", compactFullReject.status === 400
        && compactFullReject.body?.ok === false, {
          status: compactFullReject.status,
          error: compactFullReject.body?.error || null,
          blockers: compactFullReject.body?.validation?.blockers || []
        });

      const fastRelayNoAuth = await request("POST", "/api/admin/sporttery-relay-fast-lane?validateOnly=1", {
        snapshot: sampleFastSportteryRelaySnapshot()
      });
      pushCheck(checks, "sporttery fast relay upload no-auth denied", fastRelayNoAuth.status === 401, {
        status: fastRelayNoAuth.status
      });

      const fastRelayValidate = await request("POST", "/api/admin/sporttery-relay-fast-lane?validateOnly=1", {
        snapshot: sampleFastSportteryRelaySnapshot()
      }, {
        authorization: `Bearer ${adminToken}`
      });
      const fastRelayMethods = fastRelayValidate.body?.validation?.methods || [];
      pushCheck(checks, "sporttery fast relay current calculator validate accepted", fastRelayValidate.status === 200
        && fastRelayValidate.body?.ok === true
        && fastRelayValidate.body?.validateOnly === true
        && fastRelayValidate.body?.replacementPreview?.lane === "fast"
        && fastRelayValidate.body?.replacementPreview?.fullSnapshotUntouched === true
        && fastRelayMethods.includes("current")
        && fastRelayMethods.includes("calculator")
        && !fastRelayMethods.includes("all"), {
          status: fastRelayValidate.status,
          rows: fastRelayValidate.body?.validation?.rows ?? null,
          methods: fastRelayMethods,
          replacementPreview: fastRelayValidate.body?.replacementPreview || null
        });

      const archiveIntoFastReject = await request("POST", "/api/admin/sporttery-relay-fast-lane?validateOnly=1", {
        snapshot: sampleSportteryRelaySnapshot()
      }, {
        authorization: `Bearer ${adminToken}`
      });
      pushCheck(checks, "sporttery fast relay rejects archive methods", archiveIntoFastReject.status === 400
        && archiveIntoFastReject.body?.ok === false, {
          status: archiveIntoFastReject.status,
          error: archiveIntoFastReject.body?.error || null,
          blockers: archiveIntoFastReject.body?.validation?.blockers || []
        });

      const relayStateNoAuth = await request("POST", "/api/admin/sporttery-relay-state?validateOnly=1", {
        collectorState: sampleSportteryRelayState()
      });
      pushCheck(checks, "sporttery relay state no-auth denied", relayStateNoAuth.status === 401, { status: relayStateNoAuth.status });

      const relayStateQueryAdmin = await request("POST", `/api/admin/sporttery-relay-state?validateOnly=1&token=${encodeURIComponent(adminToken)}`, {
        collectorState: sampleSportteryRelayState()
      });
      pushCheck(checks, "sporttery relay state query token denied", relayStateQueryAdmin.status === 401, { status: relayStateQueryAdmin.status });

      const relayStateUpload = await request("POST", "/api/admin/sporttery-relay-state?validateOnly=1", {
        collectorState: sampleSportteryRelayState()
      }, {
        authorization: `Bearer ${adminToken}`
      });
      pushCheck(checks, "sporttery relay state bearer validate-only", relayStateUpload.status === 200
        && relayStateUpload.body?.ok === true
        && relayStateUpload.body?.validateOnly === true
        && Number(relayStateUpload.body?.collectorState?.consecutiveCollectFailures || 0) >= 1, {
          status: relayStateUpload.status,
          validateOnly: relayStateUpload.body?.validateOnly ?? null,
          consecutiveCollectFailures: relayStateUpload.body?.collectorState?.consecutiveCollectFailures ?? null,
        });

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

      pushCheck(checks, "llm review boundary", llmBoundary.status === 0 && llmBoundary.body?.ok === true, {
        status: llmBoundary.status,
        mode: "existing-cache-read-only-audit",
        llmRows: llmBoundarySummary.llmRows ?? null,
        updatedAt: llmBoundarySummary.updatedAt || null,
        failedChecks: llmBoundaryFailures
      });
    }

    await refreshSqliteAfterMutableChecks(checks);
    await waitForSqlitePrimaryRead(checks);

    const currentNoAuth = await request("GET", "/api/v1/matches/current?view=list");
    pushCheck(checks, "current no-auth denied", currentNoAuth.status === 401, { status: currentNoAuth.status });

    const aiArenaStatus = await request("GET", "/api/v1/ai-arena/status");
    const aiArenaStatusSlots = Array.isArray(aiArenaStatus.body?.leagueSlots)
      ? aiArenaStatus.body.leagueSlots
      : [];
    const aiArenaStatusState = String(aiArenaStatus.body?.state || "");
    const aiArenaStatusBody = JSON.stringify(aiArenaStatus.body || {});
    const aiArenaStatusPublished = aiArenaStatus.status === 200
      && aiArenaStatus.body?.ok === true
      && aiArenaStatus.body?.version === "ai-big-five-survival-status-v1"
      && ["ai-big-five-survival-v2", "ai-big-five-survival-v3", "ai-big-five-survival-v4", "ai-big-five-survival-v5"]
        .includes(aiArenaStatus.body?.publicationVersion)
      && ["FORMING", "READY", "LOCKED"].includes(aiArenaStatusState)
      && Number(aiArenaStatus.body?.targetMatches) === 10
      && Number(aiArenaStatus.body?.availableMatches) >= 0
      && Number(aiArenaStatus.body?.availableMatches) <= 10
      && Number(aiArenaStatus.body?.agents) === 6
      && aiArenaStatusSlots.length === 5
      && aiArenaStatusSlots.every((row) => Number(row?.target) === 2)
      && aiArenaStatus.body?.formalStatisticsExcluded === true
      && aiArenaStatus.body?.disclosure === "strategy-simulation-not-external-model-calls";
    const aiArenaStatusUnavailable = aiArenaStatus.status === 200
      && aiArenaStatus.body?.ok === false
      && aiArenaStatusState === "UNAVAILABLE";
    const aiArenaStatusPrivacySafe = !/(?:[a-f0-9]{64}|(?:[A-Za-z]:\\\\)|(?:\/var\/)|(?:\/opt\/))/i.test(aiArenaStatusBody);
    pushCheck(checks, "AI survival public status contract is privacy-safe", aiArenaStatusPrivacySafe
      && (aiArenaStatusPublished || (!requireAiArenaPublication && aiArenaStatusUnavailable)), {
      requiredByEnv: requireAiArenaPublication,
      status: aiArenaStatus.status,
      ok: aiArenaStatus.body?.ok ?? null,
      version: aiArenaStatus.body?.version || null,
      publicationVersion: aiArenaStatus.body?.publicationVersion || null,
      state: aiArenaStatusState || null,
      agents: aiArenaStatus.body?.agents ?? null,
      leagueSlots: aiArenaStatusSlots.length,
      privacySafe: aiArenaStatusPrivacySafe,
      published: aiArenaStatusPublished
    });

    const accessToken = await getAccessToken(checks);
    const accessHeaders = accessToken ? { "x-access-token": accessToken } : {};
    pushCheck(checks, "access token available", Boolean(accessToken), { provided: Boolean(accessToken) });
    if (accessToken) {
      const aiArena = await request("GET", "/api/v1/ai-arena", null, accessHeaders);
      const aiArenaAgents = Array.isArray(aiArena.body?.agents) ? aiArena.body.agents : [];
      const aiArenaLeagueSlots = Array.isArray(aiArena.body?.leagueSlots) ? aiArena.body.leagueSlots : [];
      const aiArenaState = String(aiArena.body?.state || "");
      const aiArenaStateValid = ["FORMING", "READY", "LOCKED"].includes(aiArenaState);
      const aiArenaV5 = aiArena.body?.version === "ai-big-five-survival-v5";
      const aiArenaAvailableMatches = Number(aiArena.body?.availableMatches);
      const aiArenaLockedValid = aiArenaState !== "LOCKED" || (
        (aiArenaV5
          ? aiArena.body?.roundActive === true
            && aiArenaAvailableMatches >= 2
            && aiArena.body?.complete === (aiArenaAvailableMatches === 10)
            && aiArena.body?.poolPolicy === "complete-or-friday-partial-lock-v1"
            && aiArena.body?.shortfallPolicy === "lock-current-qualified-pool-no-backfill"
            && aiArena.body?.dataAccess?.mode === "shared-immutable-pre-match-snapshot"
            && aiArena.body?.dataAccess?.identicalInputs === true
            && aiArena.body?.dataAccess?.externalProviderCallsActive === false
            && aiArena.body?.resultWriter?.mode === "trusted-official-auto-settlement"
            && aiArena.body?.resultWriter?.officialOnly === true
            && aiArena.body?.resultWriter?.modelScoreWriteAllowed === false
            && aiArena.body?.stakeFreedom === "any-qualified-match-or-zero-with-risk-caps"
          : aiArena.body?.complete === true && aiArenaAvailableMatches === 10)
        && Array.isArray(aiArena.body?.matches)
        && aiArena.body.matches.length === aiArenaAvailableMatches
        && aiArena.body?.integrity?.immutable === true
        && /^[a-f0-9]{64}$/.test(String(aiArena.body?.integrity?.stateHash || ""))
      );
      const aiArenaContractOk = aiArena.status === 200
        && ["ai-big-five-survival-v2", "ai-big-five-survival-v3", "ai-big-five-survival-v4", "ai-big-five-survival-v5"]
          .includes(aiArena.body?.version)
        && aiArenaStateValid
        && Number(aiArena.body?.targetMatches) === 10
        && Number(aiArena.body?.availableMatches) >= 0
        && Number(aiArena.body?.availableMatches) <= 10
        && aiArenaAgents.length === 6
        && aiArenaLeagueSlots.length === 5
        && aiArena.body?.formalStatisticsExcluded === true
        && aiArena.body?.disclosure === "strategy-simulation-not-external-model-calls"
        && aiArenaLockedValid;
      const aiArenaUnavailable = aiArena.status === 200 && aiArenaState === "UNAVAILABLE";
      pushCheck(checks, "AI survival authenticated publication contract", aiArenaContractOk
        || (!requireAiArenaPublication && aiArenaUnavailable), {
        requiredByEnv: requireAiArenaPublication,
        unavailableAllowed: !requireAiArenaPublication,
        status: aiArena.status,
        version: aiArena.body?.version || null,
        state: aiArenaState || null,
        targetMatches: aiArena.body?.targetMatches ?? null,
        availableMatches: aiArena.body?.availableMatches ?? null,
        agents: aiArenaAgents.length,
        leagueSlots: aiArenaLeagueSlots.length,
        formalStatisticsExcluded: aiArena.body?.formalStatisticsExcluded ?? null,
        lockedValid: aiArenaLockedValid,
        contractOk: aiArenaContractOk
      });
      const perfEnv = {
        PERF_BASE_URL: baseUrl.toString(),
        PERF_ACCESS_TOKEN: accessToken,
        PERF_REQUESTS: process.env.VERIFY_PERF_REQUESTS || process.env.PERF_REQUESTS || "60",
        PERF_CONCURRENCY: process.env.VERIFY_PERF_CONCURRENCY || process.env.PERF_CONCURRENCY || "8",
        PERF_MAX_P95_MS: process.env.VERIFY_PERF_MAX_P95_MS || process.env.PERF_MAX_P95_MS || "800",
        PERF_MAX_ERROR_RATE: process.env.VERIFY_PERF_MAX_ERROR_RATE || process.env.PERF_MAX_ERROR_RATE || "0.01"
      };
      const perf = await runLocalJson(["scripts/verifyApiPerformance.cjs"], perfEnv);
      const perfRecoveryRuns = [];
      if (isLatencyOnlyPerformanceFailure(perf)) {
        for (let attempt = 0; attempt < MAX_LATENCY_RECOVERY_ATTEMPTS; attempt += 1) {
          await sleep(2500);
          const recoveryRun = await runLocalJson(
            ["scripts/verifyApiPerformance.cjs"],
            perfEnv,
          );
          perfRecoveryRuns.push(recoveryRun);
          const interimRecovery = evaluatePerformanceRecovery({
            initialRun: perf,
            recoveryRuns: perfRecoveryRuns,
          });
          if (
            interimRecovery.recovered
            || (
              !performanceRunPassed(recoveryRun)
              && !isLatencyOnlyPerformanceFailure(recoveryRun)
            )
          ) {
            break;
          }
        }
      }
      const perfRecovery = evaluatePerformanceRecovery({
        initialRun: perf,
        recoveryRuns: perfRecoveryRuns
      });
      const perfWarmups = Array.isArray(perf.body?.warmups) ? perf.body.warmups : [];
      const perfResults = Array.isArray(perf.body?.results) ? perf.body.results : [];
      pushCheck(checks, "api performance smoke", perfRecovery.ok, {
        status: perf.status,
        thresholds: perf.body?.thresholds || null,
        selectedMatchId: perf.body?.selectedMatchId || null,
        failureReasons: Array.isArray(perf.body?.failureReasons) ? perf.body.failureReasons : [],
        latencyRecovery: {
          policy: "latency-only initial failure requires two consecutive full passing reruns within three attempts",
          ...perfRecovery,
          runs: perfRecoveryRuns.map((run) => ({
            status: run.status,
            ok: run.body?.ok === true,
            checkedAt: run.body?.checkedAt || null,
            failureReasons: Array.isArray(run.body?.failureReasons) ? run.body.failureReasons : []
          }))
        },
        warmupTransportRecoveries: Array.isArray(perf.body?.warmupTransportRecoveries)
          ? perf.body.warmupTransportRecoveries
          : [],
        warmupCacheTransitions: Array.isArray(perf.body?.warmupCacheTransitions)
          ? perf.body.warmupCacheTransitions
          : [],
        measurementCacheIdentityRetries: Array.isArray(perf.body?.measurementCacheIdentityRetries)
          ? perf.body.measurementCacheIdentityRetries
          : [],
        warmups: perfWarmups.map((row) => ({
          name: row.name,
          requests: row.requests,
          errorRate: row.errorRate,
          payloadValidatedResponses: row.payloadValidatedResponses,
          uniqueEtags: row.uniqueEtags,
          uniqueCheckedAt: row.uniqueCheckedAt,
          statuses: row.statuses
        })),
        results: perfResults.map((row) => ({
          name: row.name,
          requests: row.requests,
          errorRate: row.errorRate,
          p95Ms: row.p95Ms,
          avgBytes: row.avgBytes,
          uniqueEtags: row.uniqueEtags,
          statuses: row.statuses
        })),
        stdoutTail: perf.status === 0 ? "" : perf.stdout.slice(-500),
        stderrTail: perf.stderr.slice(-500)
      });
    }

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
    const transitionCurrent = requiredReadSource === "sqlite"
      ? await request("GET", "/api/v1/matches/current?view=list&transition=1", null, accessHeaders)
      : null;
    const transitionCurrentReadSource = transitionCurrent?.body?.currentRead?.source
      || transitionCurrent?.body?.dataSource
      || null;
    const currentReadSplitValid = !requiredReadSource
      || currentReadSource === requiredReadSource
      || (requiredReadSource === "sqlite" &&
        currentReadSource === "generation"
        && transitionCurrent?.status === 200
        && transitionCurrentReadSource === "sqlite"
      );
    pushCheck(checks, "current read source", currentReadSplitValid, {
      requiredSqlite: requireSqlite,
      requiredReadSource: requiredReadSource || null,
      dataSource: current.body?.dataSource || null,
      currentReadSource,
      transitionStatus: transitionCurrent?.status ?? null,
      transitionDataSource: transitionCurrent?.body?.dataSource || null,
      transitionCurrentReadSource,
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
    pushCheck(checks, "history page", history.status === 200 && historyRows.length > 0 && (!requiredReadSource || history.body?.source === requiredReadSource), {
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
      summary: {
        total: checks.length,
        passed: checks.filter((check) => check.ok).length,
        failed: checks.filter((check) => !check.ok).map((check) => check.name),
      },
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
  if (childExit || childLogs) {
    console.error(JSON.stringify({
      childExit,
      childLogsTail: childLogs.slice(-3000),
    }, null, 2));
  }
  process.exit(1);
});
