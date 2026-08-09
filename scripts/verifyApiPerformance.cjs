const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const zlib = require("node:zlib");

const defaultPort = Number(process.env.PORT || 8810);
const explicitBaseUrl = process.env.PERF_BASE_URL || "";
const baseUrl = new URL(explicitBaseUrl || `http://127.0.0.1:${defaultPort}`);
const shouldAutoStartLocalServer = !explicitBaseUrl && process.env.PERF_START_SERVER !== "0";
const startServer = process.env.PERF_START_SERVER === "1" || shouldAutoStartLocalServer;
const localAdminToken = "api-performance-local-admin";
const adminToken = process.env.ADMIN_TOKEN || (startServer ? localAdminToken : "");
const accessCodeAdminToken = process.env.ACCESS_CODE_ADMIN_TOKEN || adminToken;
const requestCount = Math.max(1, Number(process.env.PERF_REQUESTS || 120));
const concurrency = Math.max(1, Number(process.env.PERF_CONCURRENCY || 12));
const warmupRequests = Math.max(0, Number(process.env.PERF_WARMUP_REQUESTS || Math.min(12, requestCount)));
const warmupConcurrency = Math.max(1, Number(process.env.PERF_WARMUP_CONCURRENCY || Math.min(3, concurrency)));
const maxP95Ms = Math.max(50, Number(process.env.PERF_MAX_P95_MS || 800));
const maxErrorRate = Math.max(0, Math.min(1, Number(process.env.PERF_MAX_ERROR_RATE || 0.01)));
const maxCurrentAvgBytes = Math.max(10_000, Number(process.env.PERF_MAX_CURRENT_AVG_BYTES || 180000));
const keepAlive = process.env.PERF_KEEP_ALIVE !== "0";
const acceptGzip = process.env.PERF_ACCEPT_GZIP !== "0";
const endpointCooldownMs = Math.max(0, Number(process.env.PERF_ENDPOINT_COOLDOWN_MS || 2500));
const prepareAccessTokenOnly = process.env.PERF_PREPARE_ACCESS_TOKEN_ONLY === "1";
const accessTokenFile = String(process.env.PERF_ACCESS_TOKEN_FILE || "").trim();
const accessTokenOutputPath = String(process.env.PERF_ACCESS_TOKEN_OUTPUT_PATH || "").trim();
const stableHealthNames = new Set(["public-health", "source-health"]);
const httpAgent = new http.Agent({
  keepAlive,
  maxSockets: concurrency,
  maxFreeSockets: concurrency,
  timeout: 30_000
});
const httpsAgent = new https.Agent({
  keepAlive,
  maxSockets: concurrency,
  maxFreeSockets: concurrency,
  timeout: 30_000
});

let child = null;
let childLogs = "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = (method, pathname, body = null, headers = {}, options = {}) => {
  const decodeBody = options.decodeBody !== false;
  const target = new URL(pathname, baseUrl);
  const payload = body ? JSON.stringify(body) : "";
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;
  const cleanHeaders = Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  const hasAcceptEncoding = Object.keys(cleanHeaders).some((key) => key.toLowerCase() === "accept-encoding");
  const startedAt = process.hrtime.bigint();

  return new Promise((resolve) => {
    const req = transport.request(target, {
      method,
      agent: keepAlive ? (isHttps ? httpsAgent : httpAgent) : undefined,
      headers: {
        ...(payload ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        } : {}),
        ...(acceptGzip && !hasAcceptEncoding ? { "accept-encoding": "gzip" } : {}),
        ...cleanHeaders
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        // Capture the wire-completion time before any local decoding work. A
        // large synchronous gunzip/JSON.parse in one response callback can
        // otherwise block the event loop and inflate unrelated API samples.
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const rawBuffer = Buffer.concat(chunks);
        if (!decodeBody) {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            durationMs,
            bytes: rawBuffer.length,
            decodedBytes: null,
            contentEncoding: res.headers["content-encoding"] || null,
            error: null,
            headers: res.headers,
            body: null,
            payloadValidated: false
          });
          return;
        }
        let decodedBuffer = rawBuffer;
        let decodeError = null;
        if (String(res.headers["content-encoding"] || "").includes("gzip")) {
          try {
            decodedBuffer = zlib.gunzipSync(rawBuffer);
          } catch (error) {
            decodeError = error.message || String(error);
          }
        }
        const raw = decodedBuffer.toString("utf8");
        let json = null;
        try {
          json = raw && !decodeError ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400 && !decodeError,
          status: res.statusCode,
          durationMs,
          bytes: rawBuffer.length,
          decodedBytes: decodedBuffer.length,
          contentEncoding: res.headers["content-encoding"] || null,
          error: decodeError,
          headers: res.headers,
          body: json,
          payloadValidated: true
        });
      });
    });
    req.on("error", (error) => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({
        ok: false,
        status: 0,
        durationMs,
        bytes: 0,
        error: error.message || String(error)
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
};

const startLocalServer = async () => {
  child = spawn(process.execPath, ["server/index.cjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: baseUrl.hostname,
      PORT: String(baseUrl.port || defaultPort),
      ENABLE_SYNC_CRON: process.env.PERF_ENABLE_SYNC_CRON === "1" ? "1" : "0",
      ENABLE_GPT_CRON: process.env.PERF_ENABLE_GPT_CRON === "1" ? "1" : "0",
      ADMIN_TOKEN: process.env.ADMIN_TOKEN || adminToken,
      ACCESS_CODE_ADMIN_TOKEN: process.env.ACCESS_CODE_ADMIN_TOKEN || accessCodeAdminToken,
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

  for (let i = 0; i < 50; i += 1) {
    await sleep(250);
    const health = await request("GET", "/api/v1/health");
    if (health.status === 200 && health.body) return;
    if (child.exitCode !== null) break;
  }
  throw new Error(`local server did not become ready: ${childLogs.slice(-1000)}`);
};

const stopLocalServer = () => {
  if (!child) return;
  child.kill("SIGTERM");
  setTimeout(() => child?.kill("SIGKILL"), 1500).unref();
};

const assertAbsoluteTokenPath = (value, label) => {
  if (!value || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
};

const validateTokenFileStat = (filePath) => {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("performance access token file must be one regular non-linked file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw new Error("performance access token file must have mode 0600");
  }
  if (stat.size <= 0 || stat.size > 8192) {
    throw new Error("performance access token file has an invalid size");
  }
};

const readAccessTokenFile = (filePath) => {
  assertAbsoluteTokenPath(filePath, "PERF_ACCESS_TOKEN_FILE");
  validateTokenFileStat(filePath);
  const token = fs.readFileSync(filePath, "utf8").trim();
  if (!token || token.length > 8192 || /\s/.test(token)) {
    throw new Error("performance access token file contains an invalid token");
  }
  return token;
};

const writeAccessTokenFile = (filePath, token) => {
  assertAbsoluteTokenPath(filePath, "PERF_ACCESS_TOKEN_OUTPUT_PATH");
  if (!token || token.length > 8192 || /\s/.test(token)) {
    throw new Error("refusing to persist an invalid performance access token");
  }
  const parent = path.dirname(filePath);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) {
    throw new Error("performance access token parent must be a real directory");
  }
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, token, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  validateTokenFileStat(filePath);
};

const getAccessToken = async () => {
  if (process.env.PERF_ACCESS_TOKEN) return process.env.PERF_ACCESS_TOKEN;
  if (accessTokenFile) return readAccessTokenFile(accessTokenFile);
  if (process.env.PERF_ACCESS_CODE) {
    const verify = await request("POST", "/api/access/verify", { code: process.env.PERF_ACCESS_CODE });
    return verify.body?.session?.token || "";
  }
  if (!accessCodeAdminToken) return "";

  const create = await request("POST", "/api/admin/access-codes", { label: "api-performance-smoke" }, {
    authorization: `Bearer ${accessCodeAdminToken}`
  });
  if (!create.body?.code) return "";
  const verify = await request("POST", "/api/access/verify", { code: create.body.code });
  return verify.body?.session?.token || "";
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
};

const summarize = (responses) => {
  const durations = responses.map((row) => row.durationMs).filter((value) => Number.isFinite(value));
  const errors = responses.filter((row) => !row.ok).length;
  const bytes = responses.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
  const decodedResponses = responses.filter((row) => Number.isFinite(row.decodedBytes));
  const decodedBytes = decodedResponses.reduce((sum, row) => sum + Number(row.decodedBytes), 0);
  const uniqueEtags = new Set(responses.map((row) => row.headers?.etag).filter(Boolean));
  const uniqueCheckedAt = new Set(responses.map((row) => row.body?.checkedAt).filter(Boolean));
  return {
    requests: responses.length,
    errors,
    errorRate: responses.length ? Number((errors / responses.length).toFixed(4)) : 1,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : null,
    avgBytes: responses.length ? Math.round(bytes / responses.length) : 0,
    avgDecodedBytes: decodedResponses.length ? Math.round(decodedBytes / decodedResponses.length) : null,
    payloadValidatedResponses: responses.filter((row) => row.payloadValidated).length,
    uniqueEtags: uniqueEtags.size,
    uniqueCheckedAt: uniqueCheckedAt.size,
    contentEncodings: responses.reduce((acc, row) => {
      const key = String(row.contentEncoding || "identity");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    statuses: responses.reduce((acc, row) => {
      const key = String(row.status || 0);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  };
};

const evaluatePerformanceRun = ({
  warmups,
  results,
  maxP95Ms: p95Limit,
  maxErrorRate: errorRateLimit,
  maxCurrentAvgBytes: currentAvgBytesLimit
}) => {
  const failureReasons = [];
  const warmupTransportRecoveries = [];
  const warmupRows = Array.isArray(warmups) ? warmups : [];
  const resultRows = Array.isArray(results) ? results : [];

  for (const row of warmupRows) {
    if (!Number.isFinite(row.errorRate) || row.errorRate > errorRateLimit) {
      const errorCount = Number.isFinite(row.errors) ? Number(row.errors) : null;
      const transportErrorCount = Number(row.statuses?.["0"] || 0);
      const measured = resultRows.find((candidate) => candidate.name === row.name);
      const measuredStable = Boolean(
        measured
        && Number.isFinite(measured.errorRate)
        && measured.errorRate <= errorRateLimit
        && Number.isFinite(measured.p95Ms)
        && measured.p95Ms <= p95Limit
        && measured.uniqueEtags === 1
      );
      const recoveredTransportOnly = Boolean(
        errorCount > 0
        && transportErrorCount === errorCount
        && measuredStable
      );
      if (recoveredTransportOnly) {
        warmupTransportRecoveries.push({
          name: row.name,
          transportErrors: transportErrorCount,
          requests: row.requests,
          measuredErrorRate: measured.errorRate,
          measuredP95Ms: measured.p95Ms
        });
      } else {
        failureReasons.push(`warmup:${row.name}:error-rate:${row.errorRate}>${errorRateLimit}`);
      }
    }
  }

  for (const row of resultRows) {
    if (!Number.isFinite(row.errorRate) || row.errorRate > errorRateLimit) {
      failureReasons.push(`measured:${row.name}:error-rate:${row.errorRate}>${errorRateLimit}`);
    }
    if (!Number.isFinite(row.p95Ms)) {
      failureReasons.push(`measured:${row.name}:p95-unavailable`);
    } else if (row.p95Ms > p95Limit) {
      failureReasons.push(`measured:${row.name}:p95:${row.p95Ms}>${p95Limit}`);
    }
    if (row.uniqueEtags !== 1) {
      failureReasons.push(`measured:${row.name}:etag-identities:${row.uniqueEtags}!=1`);
    }
  }

  const currentListResult = resultRows.find((row) => row.name === "current-list");
  if (currentListResult && currentListResult.avgBytes > currentAvgBytesLimit) {
    failureReasons.push(
      `measured:current-list:avg-bytes:${currentListResult.avgBytes}>${currentAvgBytesLimit}`
    );
  }

  return {
    ok: failureReasons.length === 0,
    failureReasons,
    warmupTransportRecoveries,
    warmupCacheTransitions: warmupRows
      .filter((row) => stableHealthNames.has(row.name) && (
        row.uniqueEtags !== 1 || row.uniqueCheckedAt !== 1
      ))
      .map((row) => ({
        name: row.name,
        uniqueEtags: row.uniqueEtags,
        uniqueCheckedAt: row.uniqueCheckedAt
      }))
  };
};

const runRequests = async ({ path, headers, count, workers, decodeBody = true }) => {
  const responses = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < count) {
      cursor += 1;
      responses.push(await request("GET", path, null, headers, { decodeBody }));
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, count) }, () => worker()));
  return responses;
};

const runWarmup = async ({ name, path, headers }) => {
  if (warmupRequests <= 0) return null;
  const responses = await runRequests({
    path,
    headers,
    count: warmupRequests,
    workers: warmupConcurrency
  });
  return {
    name,
    path,
    ...summarize(responses)
  };
};

const runEndpoint = async ({ name, path, headers }) => {
  const responses = await runRequests({
    path,
    headers,
    count: requestCount,
    workers: concurrency,
    decodeBody: false
  });
  return {
    name,
    path,
    ...summarize(responses)
  };
};

const matchRowsFrom = (body) => {
  const candidates = [body?.rows, body?.data?.rows, body?.matches, body?.data?.matches];
  return candidates.find(Array.isArray) || [];
};

const selectDetailTarget = ({ currentBody, historyBody }) => {
  const firstIdentity = (rows) => {
    const row = rows.find((candidate) => candidate && typeof candidate === "object");
    const value = row?.id || row?.matchId || row?.sourceMatchId;
    return value ? String(value) : null;
  };
  const currentId = firstIdentity(matchRowsFrom(currentBody));
  if (currentId) return { matchId: currentId, source: "current" };
  const historyId = firstIdentity(matchRowsFrom(historyBody));
  return historyId ? { matchId: historyId, source: "history-fallback" } : null;
};

const run = async () => {
  if (startServer) await startLocalServer();
  try {
    const token = await getAccessToken();
    if (!token) {
      throw new Error("access token unavailable; set ACCESS_CODE_ADMIN_TOKEN, PERF_ACCESS_TOKEN, or PERF_ACCESS_CODE");
    }
    if (prepareAccessTokenOnly) {
      if (!accessTokenOutputPath) {
        throw new Error("PERF_ACCESS_TOKEN_OUTPUT_PATH is required in token preparation mode");
      }
      writeAccessTokenFile(accessTokenOutputPath, token);
      console.log(JSON.stringify({
        ok: true,
        checkedAt: new Date().toISOString(),
        preparedAccessToken: true
      }, null, 2));
      return;
    }
    const headers = { "x-access-token": token };
    const current = await request("GET", "/api/v1/matches/current?view=list", null, headers);
    const historySeed = matchRowsFrom(current.body).length > 0
      ? null
      : await request("GET", "/api/v1/matches/history?limit=50", null, headers);
    const detailTarget = selectDetailTarget({
      currentBody: current.body,
      historyBody: historySeed?.body,
    });
    if (!detailTarget) throw new Error("no current or history match available for detail performance test");
    const { matchId } = detailTarget;

    const endpoints = [
      { name: "public-health", path: "/api/v1/health", headers: {} },
      { name: "source-health", path: "/api/v1/source-health", headers: {} },
      { name: "current-list", path: "/api/v1/matches/current?view=list", headers },
      { name: "current-transition", path: "/api/v1/matches/current?view=list&transition=1", headers },
      { name: "history-page", path: "/api/v1/matches/history?limit=50", headers },
      { name: "match-detail", path: `/api/v1/matches/${encodeURIComponent(matchId)}`, headers }
    ];
    const warmups = [];
    const results = [];
    const measurementCacheIdentityRetries = [];
    for (let index = 0; index < endpoints.length; index += 1) {
      if (index > 0 && endpointCooldownMs > 0) {
        await sleep(endpointCooldownMs);
      }
      const endpoint = endpoints[index];
      // Measure the endpoint immediately after its own warm-up. Warming every
      // endpoint up front can let the 30s history/detail caches expire while a
      // preceding cold SQLite endpoint is measured, which contradicts the
      // declared steady-state warm-up policy and produces order-dependent p95s.
      const warmup = await runWarmup(endpoint);
      if (warmup) warmups.push(warmup);
      let measured = await runEndpoint(endpoint);
      // A completed publication can invalidate an otherwise warm cache between
      // warm-up and measurement. Permit one bounded re-warm only when every
      // response succeeded and the measured batch proves that exact identity
      // transition with multiple ETags. The replacement batch is still held to
      // the original p95/error thresholds and must have one stable ETag.
      if (measured.uniqueEtags > 1 && measured.errorRate <= maxErrorRate) {
        const retryWarmup = await runWarmup(endpoint);
        const initial = measured;
        measured = await runEndpoint(endpoint);
        measurementCacheIdentityRetries.push({
          name: endpoint.name,
          initial: {
            requests: initial.requests,
            errorRate: initial.errorRate,
            p95Ms: initial.p95Ms,
            uniqueEtags: initial.uniqueEtags,
            statuses: initial.statuses
          },
          retryWarmup: retryWarmup ? {
            requests: retryWarmup.requests,
            errorRate: retryWarmup.errorRate,
            uniqueEtags: retryWarmup.uniqueEtags,
            statuses: retryWarmup.statuses
          } : null,
          final: {
            requests: measured.requests,
            errorRate: measured.errorRate,
            p95Ms: measured.p95Ms,
            uniqueEtags: measured.uniqueEtags,
            statuses: measured.statuses
          }
        });
        if (retryWarmup) warmups.push(retryWarmup);
      }
      results.push(measured);
    }
    // A warm-up is allowed to transition a health endpoint from its uncached
    // representation to the cached one. Source health deliberately toggles its
    // public `cached` field at that boundary, so gating warm-up ETag uniqueness
    // makes a cold, healthy server fail deterministically. Assert ETag stability
    // on the immediately following measured batch instead.
    const evaluation = evaluatePerformanceRun({
      warmups,
      results,
      maxP95Ms,
      maxErrorRate,
      maxCurrentAvgBytes
    });
    const ok = evaluation.ok;
    const payload = {
      ok,
      checkedAt: new Date().toISOString(),
      baseUrl: baseUrl.toString().replace(/\/$/, ""),
      thresholds: {
        maxP95Ms,
        maxErrorRate,
        maxCurrentAvgBytes,
        requestCount,
        concurrency,
        warmupRequests,
        warmupConcurrency,
        warmupPolicy: "each endpoint is warmed immediately before its measured p95; thresholds are unchanged",
        latencyMetric: "wire response completion; client payload decode and JSON parse are excluded",
        payloadPolicy: "warm-ups fully validate gzip and JSON; measured samples gate status, encoding, bytes and wire p95",
        keepAlive,
        acceptGzip,
        endpointCooldownMs
      },
      selectedMatchId: matchId,
      selectedMatchSource: detailTarget.source,
      failureReasons: evaluation.failureReasons,
      warmupTransportRecoveries: evaluation.warmupTransportRecoveries,
      warmupCacheTransitions: evaluation.warmupCacheTransitions,
      measurementCacheIdentityRetries,
      warmups,
      results
    };
    console.log(JSON.stringify(payload, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    httpAgent.destroy();
    httpsAgent.destroy();
    stopLocalServer();
  }
};

module.exports = {
  evaluatePerformanceRun,
  matchRowsFrom,
  readAccessTokenFile,
  selectDetailTarget,
  writeAccessTokenFile
};

if (require.main === module) {
  run().catch((error) => {
    httpAgent.destroy();
    httpsAgent.destroy();
    stopLocalServer();
    console.error(JSON.stringify({
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error.message || String(error)
    }, null, 2));
    process.exitCode = 1;
  });
}
