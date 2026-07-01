const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");

const defaultPort = Number(process.env.PORT || 8788);
const baseUrl = new URL(process.env.CONTRACT_BASE_URL || process.env.VERIFY_BASE_URL || `http://127.0.0.1:${defaultPort}`);
const startServer = process.env.CONTRACT_START_SERVER === "1";
const adminToken = process.env.ADMIN_TOKEN || "";
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
    if (payload) req.write(payload);
    req.end();
  });
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
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
      DATASTORE_READ_SOURCE: process.env.DATASTORE_READ_SOURCE || "sqlite"
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

const run = async () => {
  const checks = [];
  if (startServer) await startLocalServer();

  try {
    const health = await request("GET", "/api/v1/health");
    pushCheck(checks, "health schema", health.status === 200 && health.body?.apiVersion === "v1" && health.headers.etag, {
      status: health.status,
      apiVersion: health.body?.apiVersion || null,
      hasEtag: Boolean(health.headers.etag),
      cacheControl: health.headers["cache-control"] || null
    });

    const sourceHealth = await request("GET", "/api/v1/source-health");
    const publicSources = Array.isArray(sourceHealth.body?.sources) ? sourceHealth.body.sources : [];
    pushCheck(checks, "source-health public schema", sourceHealth.status === 200 && publicSources.length >= 4 && !sourceHealth.body?.admin, {
      status: sourceHealth.status,
      sourceIds: publicSources.map((source) => source.id),
      exposesAdmin: Boolean(sourceHealth.body?.admin)
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
    }

    const modelEvaluation = await request("GET", "/api/v1/model/evaluation");
    const modelShadow = modelEvaluation.body?.backtest?.shadowCandidates || null;
    const leaksModelCandidates = Array.isArray(modelShadow?.candidates);
    const leaksStrategyRules = Boolean(modelEvaluation.body?.strategy?.activeGates || modelEvaluation.body?.strategy?.recommendations);
    pushCheck(checks, "model-evaluation public redaction", modelEvaluation.status === 200 && modelEvaluation.body?.publicView === true && !leaksModelCandidates && !leaksStrategyRules, {
      status: modelEvaluation.status,
      publicView: modelEvaluation.body?.publicView ?? null,
      leaksModelCandidates,
      leaksStrategyRules
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
      pushCheck(checks, "model-evaluation admin diagnostics", modelAdmin.status === 200 && modelAdmin.body?.admin?.includesInternalCandidates === true, {
        status: modelAdmin.status,
        includesInternalCandidates: modelAdmin.body?.admin?.includesInternalCandidates ?? null,
        includesStrategyRules: modelAdmin.body?.admin?.includesStrategyRules ?? null
      });
    }

    const currentNoAuth = await request("GET", "/api/v1/matches/current?view=list");
    const historyNoAuth = await request("GET", "/api/v1/matches/history?limit=1");
    const oddsNoAuth = await request("GET", "/api/v1/odds/history?limit=1");
    pushCheck(checks, "protected v1 reads require access", currentNoAuth.status === 401 && historyNoAuth.status === 401 && oddsNoAuth.status === 401, {
      current: currentNoAuth.status,
      history: historyNoAuth.status,
      odds: oddsNoAuth.status
    });

    const accessToken = await getAccessToken(checks);
    const accessHeaders = accessToken ? { "x-access-token": accessToken } : {};
    pushCheck(checks, "contract access token available", Boolean(accessToken), {
      provided: Boolean(accessToken)
    });

    const current = await request("GET", "/api/v1/matches/current?view=list", null, accessHeaders);
    const currentRows = Array.isArray(current.body?.rows) ? current.body.rows : [];
    const matchId = currentRows.find((row) => row?.id)?.id || "";
    pushCheck(checks, "current list contract", current.status === 200 && current.body?.apiVersion === "v1" && current.body?.ok === true && currentRows.length > 0 && currentRows.every((row) => !hasHeavyListFields(row)), {
      status: current.status,
      rows: currentRows.length,
      dataSource: current.body?.dataSource || null,
      stale: current.body?.stale ?? null,
      hasEtag: Boolean(current.headers.etag),
      selectedMatchId: matchId || null
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

    const historyClamp = await request("GET", "/api/v1/matches/history?limit=999", null, accessHeaders);
    const historyRows = Array.isArray(historyClamp.body?.rows) ? historyClamp.body.rows : [];
    pushCheck(checks, "history limit clamp", historyClamp.status === 200 && historyClamp.body?.apiVersion === "v1" && historyClamp.body?.pageInfo?.limit === 200 && historyRows.length <= 200, {
      status: historyClamp.status,
      limit: historyClamp.body?.pageInfo?.limit ?? null,
      rows: historyRows.length,
      hasMore: historyClamp.body?.pageInfo?.hasMore ?? null
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

    const detail = matchId
      ? await request("GET", `/api/v1/matches/${encodeURIComponent(matchId)}`, null, accessHeaders)
      : { status: 0, body: null, headers: {} };
    pushCheck(checks, "match detail contract", detail.status === 200 && detail.body?.apiVersion === "v1" && detail.body?.match?.id === matchId && detail.body?.predictionLock && detail.body?.sourceHealth && !detail.body?.match?.gptPrediction?.relay, {
      status: detail.status,
      matchId,
      hasPredictionLock: Boolean(detail.body?.predictionLock),
      hasSourceHealth: Boolean(detail.body?.sourceHealth),
      hasEtag: Boolean(detail.headers.etag)
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
    pushCheck(checks, "large static payloads disabled", staticCurrent.status === 410 && staticGpt.status === 410, {
      currentStatus: staticCurrent.status,
      gptStatus: staticGpt.status
    });

    const adminSyncGet = await request("GET", "/api/admin/sync", null, adminToken ? { authorization: `Bearer ${adminToken}` } : {});
    pushCheck(checks, "admin sync method contract", adminSyncGet.status === 405, {
      status: adminSyncGet.status
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
