const path = require("node:path");
const { pathToFileURL } = require("node:url");

const rootDir = path.resolve(__dirname, "..");
const workerUrl = pathToFileURL(path.join(rootDir, "cloudflare", "sync-trigger", "src", "index.js")).href;

const requestWorker = async (worker, pathname) => {
  const response = await worker.fetch(new Request(`https://worker.test${pathname}`), {}, { waitUntil() {} });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const run = async () => {
  const workerModule = await import(workerUrl);
  const worker = workerModule.default;
  const checks = [];

  const health = await requestWorker(worker, "/health");
  pushCheck(checks, "worker health policy", health.status === 200
    && health.body?.worker === "football-predict-sync-trigger"
    && String(health.body?.protectedDataPolicy || "").includes("protected Node /api/v1"), {
      status: health.status,
      api: health.body?.api || null,
      protectedDataPolicy: health.body?.protectedDataPolicy || null
    });

  const protectedRoutes = [
    ["/api/matches/current", "/api/v1/matches/current?view=list"],
    ["/api/matches/history", "/api/v1/matches/history?limit=50"],
    ["/api/odds/history", "/api/v1/odds/history?matchId=<matchId>&limit=200"],
    ["/api/predictions/snapshots", "/api/v1/model/evaluation?detail=admin"],
    ["/api/model/calibration", "/api/v1/model/evaluation"]
  ];

  for (const [route, replacement] of protectedRoutes) {
    const result = await requestWorker(worker, route);
    pushCheck(checks, `protected route disabled ${route}`, result.status === 410
      && result.body?.error === "protected data API disabled on sync worker"
      && result.body?.replacement === replacement, {
        status: result.status,
        error: result.body?.error || null,
        replacement: result.body?.replacement || null
      });
  }

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: error.stack || error.message || String(error)
  }, null, 2));
  process.exit(1);
});
