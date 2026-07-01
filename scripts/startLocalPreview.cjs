const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const serverDataDir = path.join(rootDir, "server-data");

const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) || 8788);
const host = process.env.HOST || "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const adminToken = process.env.ADMIN_TOKEN || "local-preview-check";
const accessAdminToken = process.env.ACCESS_CODE_ADMIN_TOKEN || adminToken;
const restart = process.env.PREVIEW_RESTART === "1" || process.argv.includes("--restart");
const pidFile = path.join(serverDataDir, `local-preview-${port}.pid`);
const outLog = path.join(serverDataDir, `local-preview-${port}.out.log`);
const errLog = path.join(serverDataDir, `local-preview-${port}.err.log`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJson = (method, pathname, body, headers = {}) => new Promise((resolve) => {
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = http.request(`${baseUrl}${pathname}`, {
    method,
    timeout: 5000,
    headers: {
      accept: "application/json",
      ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
      ...headers
    }
  }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      text += chunk;
    });
    res.on("end", () => {
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed, text });
    });
  });
  req.on("timeout", () => req.destroy(new Error("request timeout")));
  req.on("error", (error) => resolve({ ok: false, status: 0, error: error.message }));
  if (payload) req.write(payload);
  req.end();
});

async function readPid() {
  try {
    const text = await fsp.readFile(pidFile, "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(pid) {
  if (!processExists(pid)) return false;
  process.kill(pid, "SIGTERM");
  for (let index = 0; index < 30; index += 1) {
    await sleep(100);
    if (!processExists(pid)) return true;
  }
  process.kill(pid, "SIGKILL");
  for (let index = 0; index < 20; index += 1) {
    await sleep(100);
    if (!processExists(pid)) return true;
  }
  return !processExists(pid);
}

async function waitForHealth(timeoutMs = 30_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await requestJson("GET", "/api/v1/health");
    if (last.ok && last.body?.service === "football-predict-server") return last;
    await sleep(500);
  }
  const error = new Error("local preview health check timed out");
  error.lastHealth = last;
  throw error;
}

async function startServer() {
  await fsp.mkdir(serverDataDir, { recursive: true });

  const existingPid = await readPid();
  if (restart && existingPid) {
    await stopProcess(existingPid);
  }

  const existingHealth = await requestJson("GET", "/api/v1/health");
  if (!restart && existingHealth.ok && existingHealth.body?.service === "football-predict-server") {
    return { reused: true, pid: await readPid(), health: existingHealth };
  }

  const stalePid = await readPid();
  if (processExists(stalePid)) {
    throw new Error(`port ${port} is not serving /api/v1/health, but pid file process ${stalePid} is still alive`);
  }

  const outFd = fs.openSync(outLog, "a");
  const errFd = fs.openSync(errLog, "a");
  const child = spawn(process.execPath, ["server/index.cjs"], {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      ADMIN_TOKEN: adminToken,
      ACCESS_CODE_ADMIN_TOKEN: accessAdminToken,
      DATASTORE_READ_SOURCE: process.env.DATASTORE_READ_SOURCE || "sqlite",
      ENABLE_SQLITE_EXPORT: process.env.ENABLE_SQLITE_EXPORT || "1",
      ENABLE_SYNC_CRON: process.env.ENABLE_SYNC_CRON || "0",
      ENABLE_GPT_CRON: process.env.ENABLE_GPT_CRON || "0"
    }
  });
  child.unref();
  await fsp.writeFile(pidFile, `${child.pid}\n`, "utf8");

  const health = await waitForHealth();
  return { reused: false, pid: child.pid, health };
}

async function createPreviewAccess() {
  const create = await requestJson("POST", "/api/admin/access-codes", {
    label: `local-preview-${new Date().toISOString()}`
  }, {
    authorization: `Bearer ${accessAdminToken}`
  });
  if (!create.ok || !create.body?.code) {
    const error = new Error("failed to create local preview access code");
    error.response = create;
    throw error;
  }

  const verify = await requestJson("POST", "/api/access/verify", { code: create.body.code });
  if (!verify.ok || !verify.body?.session?.token) {
    const error = new Error("failed to verify local preview access code");
    error.response = verify;
    throw error;
  }

  return {
    code: create.body.code,
    codeId: create.body.id || verify.body.code?.id || null,
    expiresAt: create.body.expiresAt || verify.body.session?.expiresAt || null,
    sessionToken: verify.body.session.token
  };
}

async function main() {
  const server = await startServer();
  const access = await createPreviewAccess();
  const health = server.health.body || {};
  const result = {
    ok: true,
    baseUrl,
    pid: server.pid,
    reused: server.reused,
    logs: {
      stdout: path.relative(rootDir, outLog),
      stderr: path.relative(rootDir, errLog),
      pid: path.relative(rootDir, pidFile)
    },
    health: {
      ok: health.ok,
      apiVersion: health.apiVersion,
      status: health.status,
      dataUpdatedAt: health.data?.updatedAt || null,
      dataSource: health.storage?.readSource || health.data?.source || null,
      sqliteStale: health.storage?.sqlite?.stale ?? null,
      sqliteCurrentMatches: health.storage?.sqlite?.counts?.currentMatches ?? null
    },
    access
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    lastHealth: error.lastHealth || null,
    response: error.response || null,
    logs: {
      stdout: path.relative(rootDir, outLog),
      stderr: path.relative(rootDir, errLog),
      pid: path.relative(rootDir, pidFile)
    }
  }, null, 2));
  process.exitCode = 1;
});
