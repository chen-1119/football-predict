const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const nginxPath = path.join(rootDir, "deploy", "light-server", "nginx.conf");
const envExamplePath = path.join(rootDir, "deploy", "light-server", "env.example");
const workerServicePath = path.join(rootDir, "deploy", "light-server", "football-sync-worker.service");
const appServicePath = path.join(rootDir, "deploy", "light-server", "football-predict.service");
const cloudflareWorkerPath = path.join(rootDir, "cloudflare", "sync-trigger", "src", "index.js");
const cloudflareWranglerPath = path.join(rootDir, "cloudflare", "sync-trigger", "wrangler.jsonc");
const githubSyncWorkflowPath = path.join(rootDir, ".github", "workflows", "sync.yml");

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

const normalize = (text) => text.replace(/\s+/g, " ").trim();

const parseJsonFile = (filePath) => {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const extractLocation = (nginx, locationHeader) => {
  const index = nginx.indexOf(locationHeader);
  if (index < 0) return "";
  const openIndex = nginx.indexOf("{", index);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let cursor = openIndex; cursor < nginx.length; cursor += 1) {
    if (nginx[cursor] === "{") depth += 1;
    if (nginx[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return nginx.slice(openIndex + 1, cursor);
    }
  }
  return "";
};

const keyValue = (text, key) => {
  const pattern = new RegExp(`^${key}=([^\\r\\n]*)`, "m");
  return text.match(pattern)?.[1]?.trim() || "";
};

const run = () => {
  const checks = [];
  const nginx = readText(nginxPath);
  const envExample = readText(envExamplePath);
  const workerService = readText(workerServicePath);
  const appService = readText(appServicePath);
  const cloudflareWorker = readText(cloudflareWorkerPath);
  const cloudflareWrangler = parseJsonFile(cloudflareWranglerPath);
  const githubSyncWorkflow = readText(githubSyncWorkflowPath);

  const assets = normalize(extractLocation(nginx, "location /assets/"));
  const runtimeConfig = normalize(extractLocation(nginx, "location = /data/runtime-config.json"));
  const data = normalize(extractLocation(nginx, "location /data/"));
  const api = normalize(extractLocation(nginx, "location /api/"));
  const admin = normalize(extractLocation(nginx, "location /api/admin/"));
  const events = normalize(extractLocation(nginx, "location /api/v1/events"));
  const root = normalize(extractLocation(nginx, "location / {"));

  pushCheck(checks, "nginx rate-limit zones", nginx.includes("limit_req_zone $binary_remote_addr zone=football_api") && nginx.includes("limit_req_zone $binary_remote_addr zone=football_admin"), {
    hasApiZone: nginx.includes("zone=football_api"),
    hasAdminZone: nginx.includes("zone=football_admin")
  });

  pushCheck(checks, "nginx gzip enabled", nginx.includes("gzip on;") && nginx.includes("gzip_types") && nginx.includes("application/json"), {
    hasGzip: nginx.includes("gzip on;"),
    hasJsonType: nginx.includes("application/json")
  });

  pushCheck(checks, "nginx assets immutable", assets.includes("Cache-Control \"public, max-age=31536000, immutable\"") && assets.includes("expires 1y"), {
    hasAssetsLocation: Boolean(assets),
    assets
  });

  pushCheck(checks, "nginx runtime config no-store", runtimeConfig.includes("Cache-Control \"no-store\"") && runtimeConfig.includes("expires off"), {
    hasRuntimeLocation: Boolean(runtimeConfig),
    runtimeConfig
  });

  pushCheck(checks, "nginx data json no-store and limited", data.includes("Cache-Control \"no-store\"") && data.includes("limit_req zone=football_api"), {
    hasDataLocation: Boolean(data),
    data
  });

  pushCheck(checks, "nginx api and admin limited", api.includes("limit_req zone=football_api") && admin.includes("limit_req zone=football_admin"), {
    hasApiLimit: api.includes("limit_req zone=football_api"),
    hasAdminLimit: admin.includes("limit_req zone=football_admin")
  });

  pushCheck(checks, "nginx sse streaming", events.includes("proxy_buffering off") && events.includes("proxy_read_timeout 90s") && events.includes("limit_req zone=football_api"), {
    hasEventsLocation: Boolean(events),
    events
  });

  pushCheck(checks, "nginx html no-store", root.includes("Cache-Control \"no-store\"") && root.includes("expires off"), {
    hasRootLocation: Boolean(root),
    root
  });

  pushCheck(checks, "env sqlite read source", keyValue(envExample, "DATASTORE_READ_SOURCE") === "sqlite" && keyValue(envExample, "ENABLE_SQLITE_EXPORT") === "1", {
    dataStoreReadSource: keyValue(envExample, "DATASTORE_READ_SOURCE") || null,
    enableSqliteExport: keyValue(envExample, "ENABLE_SQLITE_EXPORT") || null,
    sqlitePath: keyValue(envExample, "DATASTORE_SQLITE_PATH") || null
  });

  pushCheck(checks, "env source sync cadence", Number(keyValue(envExample, "SYNC_INTERVAL_SECONDS")) <= 300 && Number(keyValue(envExample, "HOT_SYNC_INTERVAL_SECONDS")) <= 120, {
    syncIntervalSeconds: keyValue(envExample, "SYNC_INTERVAL_SECONDS") || null,
    hotSyncIntervalSeconds: keyValue(envExample, "HOT_SYNC_INTERVAL_SECONDS") || null
  });

  pushCheck(checks, "systemd split services", appService.includes("server/index.cjs") && workerService.includes("runSyncWorker.cjs") && workerService.includes("DATASTORE_READ_SOURCE=sqlite") && workerService.includes("ENABLE_SQLITE_EXPORT=1"), {
    hasAppService: appService.includes("server/index.cjs"),
    hasWorkerService: workerService.includes("runSyncWorker.cjs"),
    workerSqlite: workerService.includes("DATASTORE_READ_SOURCE=sqlite"),
    workerSqliteExport: workerService.includes("ENABLE_SQLITE_EXPORT=1")
  });

  const crons = Array.isArray(cloudflareWrangler?.triggers?.crons) ? cloudflareWrangler.triggers.crons : [];
  pushCheck(checks, "cloudflare cron guarded 5-minute cadence", crons.includes("*/5 * * * *") && Number(cloudflareWrangler?.vars?.MIN_SECONDS_BETWEEN_DISPATCHES || 0) >= 240, {
    crons,
    minSecondsBetweenDispatches: cloudflareWrangler?.vars?.MIN_SECONDS_BETWEEN_DISPATCHES || null
  });

  pushCheck(checks, "cloudflare stale repair waits two cycles", Number(cloudflareWrangler?.vars?.STALE_DATA_SECONDS || 0) >= 600, {
    staleDataSeconds: cloudflareWrangler?.vars?.STALE_DATA_SECONDS || null
  });

  pushCheck(checks, "cloudflare manual trigger bearer only", cloudflareWorker.includes("safeSecretEqual(bearerToken, env.MANUAL_TRIGGER_TOKEN)") && !cloudflareWorker.includes('searchParams.get("token")'), {
    hasSafeCompare: cloudflareWorker.includes("safeSecretEqual(bearerToken, env.MANUAL_TRIGGER_TOKEN)"),
    allowsQueryToken: cloudflareWorker.includes('searchParams.get("token")')
  });

  pushCheck(checks, "github sync does not cancel active run", /cancel-in-progress:\s*false/.test(githubSyncWorkflow), {
    cancelInProgressFalse: /cancel-in-progress:\s*false/.test(githubSyncWorkflow)
  });

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    files: {
      nginx: path.relative(rootDir, nginxPath).replace(/\\/g, "/"),
      envExample: path.relative(rootDir, envExamplePath).replace(/\\/g, "/"),
      appService: path.relative(rootDir, appServicePath).replace(/\\/g, "/"),
      workerService: path.relative(rootDir, workerServicePath).replace(/\\/g, "/"),
      cloudflareWorker: path.relative(rootDir, cloudflareWorkerPath).replace(/\\/g, "/"),
      cloudflareWrangler: path.relative(rootDir, cloudflareWranglerPath).replace(/\\/g, "/"),
      githubSyncWorkflow: path.relative(rootDir, githubSyncWorkflowPath).replace(/\\/g, "/")
    },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run();
