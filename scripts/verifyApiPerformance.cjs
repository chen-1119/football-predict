const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");

const defaultPort = Number(process.env.PORT || 8810);
const baseUrl = new URL(process.env.PERF_BASE_URL || `http://127.0.0.1:${defaultPort}`);
const startServer = process.env.PERF_START_SERVER === "1";
const adminToken = process.env.ADMIN_TOKEN || "";
const accessCodeAdminToken = process.env.ACCESS_CODE_ADMIN_TOKEN || adminToken;
const requestCount = Math.max(1, Number(process.env.PERF_REQUESTS || 120));
const concurrency = Math.max(1, Number(process.env.PERF_CONCURRENCY || 12));
const maxP95Ms = Math.max(50, Number(process.env.PERF_MAX_P95_MS || 800));
const maxErrorRate = Math.max(0, Math.min(1, Number(process.env.PERF_MAX_ERROR_RATE || 0.01)));
const maxCurrentAvgBytes = Math.max(10_000, Number(process.env.PERF_MAX_CURRENT_AVG_BYTES || 180000));

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
  const startedAt = process.hrtime.bigint();

  return new Promise((resolve) => {
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
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          durationMs,
          bytes: Buffer.byteLength(raw),
          headers: res.headers,
          body: json
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
      ENABLE_GPT_CRON: process.env.PERF_ENABLE_GPT_CRON === "1" ? "1" : "0"
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

const getAccessToken = async () => {
  if (process.env.PERF_ACCESS_TOKEN) return process.env.PERF_ACCESS_TOKEN;
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
  return {
    requests: responses.length,
    errors,
    errorRate: responses.length ? Number((errors / responses.length).toFixed(4)) : 1,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : null,
    avgBytes: responses.length ? Math.round(bytes / responses.length) : 0,
    statuses: responses.reduce((acc, row) => {
      const key = String(row.status || 0);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  };
};

const runEndpoint = async ({ name, path, headers }) => {
  const responses = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < requestCount) {
      cursor += 1;
      responses.push(await request("GET", path, null, headers));
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, () => worker()));
  return {
    name,
    path,
    ...summarize(responses)
  };
};

const run = async () => {
  if (startServer) await startLocalServer();
  try {
    const token = await getAccessToken();
    if (!token) {
      throw new Error("access token unavailable; set ACCESS_CODE_ADMIN_TOKEN, PERF_ACCESS_TOKEN, or PERF_ACCESS_CODE");
    }
    const headers = { "x-access-token": token };
    const current = await request("GET", "/api/v1/matches/current?view=list", null, headers);
    const currentRows = Array.isArray(current.body?.rows) ? current.body.rows : [];
    const matchId = currentRows[0]?.id;
    if (!matchId) throw new Error("no current match available for detail performance test");

    const endpoints = [
      { name: "current-list", path: "/api/v1/matches/current?view=list", headers },
      { name: "history-page", path: "/api/v1/matches/history?limit=50", headers },
      { name: "match-detail", path: `/api/v1/matches/${encodeURIComponent(matchId)}`, headers }
    ];
    const results = [];
    for (const endpoint of endpoints) {
      results.push(await runEndpoint(endpoint));
    }
    const currentListResult = results.find((row) => row.name === "current-list");
    const ok = results.every((row) => (
      row.errorRate <= maxErrorRate
      && Number.isFinite(row.p95Ms)
      && row.p95Ms <= maxP95Ms
    )) && (!currentListResult || currentListResult.avgBytes <= maxCurrentAvgBytes);
    const payload = {
      ok,
      checkedAt: new Date().toISOString(),
      baseUrl: baseUrl.toString().replace(/\/$/, ""),
      thresholds: {
        maxP95Ms,
        maxErrorRate,
        maxCurrentAvgBytes,
        requestCount,
        concurrency
      },
      selectedMatchId: matchId,
      results
    };
    console.log(JSON.stringify(payload, null, 2));
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
    error: error.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
