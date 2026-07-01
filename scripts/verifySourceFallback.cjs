const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");

const rootDir = path.resolve(__dirname, "..");
const tempDir = path.join(rootDir, ".codex-tmp", `source-fallback-${Date.now()}`);
const port = Number(process.env.FALLBACK_VERIFY_PORT || 8830);
const adminToken = process.env.FALLBACK_VERIFY_ADMIN_TOKEN || "fallback-verify-admin";
const accessSecret = process.env.FALLBACK_VERIFY_ACCESS_SECRET || "fallback-verify-secret";

const publishedFiles = [
  "public/matches.json",
  "public/odds-history.json",
  "public/data/matches-current.json",
  "public/data/matches-history.json",
  "public/data/team-index.json",
  "public/data/odds-history.json",
  "public/data/prediction-snapshots.json",
  "public/data/post-match-reviews.json",
  "public/data/model-calibration.json",
  "public/data/model-strategy.json",
  "public/data/sync-meta.json",
  "dist/data/sync-meta.json",
  "dist/data/team-index.json",
  "dist/data/model-evaluation.json"
];

const sqliteFiles = [
  "server-data/football.db",
  "server-data/football.db-wal",
  "server-data/football.db-shm"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readJson = (relativePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
  } catch {
    return fallback;
  }
};

const copyIfExists = async (from, to) => {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  if (fs.existsSync(from)) {
    await fsp.copyFile(from, to);
  } else {
    await fsp.writeFile(`${to}.missing`, "");
  }
};

const backupFiles = async () => {
  for (const relativePath of [...publishedFiles, ...sqliteFiles]) {
    await copyIfExists(path.join(rootDir, relativePath), path.join(tempDir, relativePath));
  }
};

const restoreFiles = async () => {
  for (const relativePath of [...publishedFiles, ...sqliteFiles]) {
    const source = path.join(tempDir, relativePath);
    const target = path.join(rootDir, relativePath);
    const missingMarker = `${source}.missing`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (fs.existsSync(source)) {
      await fsp.copyFile(source, target);
    } else if (fs.existsSync(missingMarker) && fs.existsSync(target)) {
      await fsp.rm(target, { force: true });
    }
  }
};

const runCommand = (command, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) {
      resolve({ stdout, stderr });
    } else {
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${stdout}\n${stderr}`));
    }
  });
});

const request = (method, pathname, body = null, headers = {}) => {
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(payload ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        } : {}),
        ...headers
      }
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json, bytes: Buffer.byteLength(raw) });
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

let serverProcess = null;
const startServer = async () => {
  serverProcess = spawn(process.execPath, ["server/index.cjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ADMIN_TOKEN: adminToken,
      ACCESS_CODE_ADMIN_TOKEN: adminToken,
      ACCESS_CODE_SECRET: accessSecret,
      DATASTORE_READ_SOURCE: "sqlite",
      ENABLE_SYNC_CRON: "0",
      ENABLE_GPT_CRON: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let logs = "";
  serverProcess.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  for (let index = 0; index < 40; index += 1) {
    await sleep(250);
    try {
      const health = await request("GET", "/api/v1/health");
      if (health.status === 200 && health.body?.apiVersion === "v1") return;
    } catch {
      // Keep waiting until the server accepts requests.
    }
    if (serverProcess.exitCode !== null) break;
  }
  throw new Error(`fallback verify server did not start: ${logs.slice(-1200)}`);
};

const stopServer = () => {
  if (!serverProcess) return;
  serverProcess.kill("SIGTERM");
  setTimeout(() => serverProcess?.kill("SIGKILL"), 1500).unref();
};

const run = async () => {
  const checks = [];
  await backupFiles();
  try {
    const beforeCurrent = readJson("public/data/matches-current.json", []);
    const beforeHistory = readJson("public/data/matches-history.json", []);
    const beforeMeta = readJson("public/data/sync-meta.json", null);
    pushCheck(checks, "baseline data available", beforeCurrent.length > 0 && beforeHistory.length > 0, {
      current: beforeCurrent.length,
      history: beforeHistory.length,
      version: beforeMeta?.updatedAt || null
    });

    await runCommand(process.execPath, ["scripts/syncData.cjs"], {
      SKIP_SPORTTERY_FETCH: "1",
      ENABLE_500_SYNC: "0",
      ENABLE_WEATHER_SYNC: "0",
      ENABLE_PREMATCH_SIGNALS_SYNC: "0"
    });

    const fallbackCurrent = readJson("public/data/matches-current.json", []);
    const fallbackHistory = readJson("public/data/matches-history.json", []);
    const fallbackMeta = readJson("public/data/sync-meta.json", null);
    pushCheck(checks, "fallback keeps current data", Array.isArray(fallbackCurrent) && fallbackCurrent.length > 0, {
      current: fallbackCurrent.length
    });
    pushCheck(checks, "fallback keeps history data", Array.isArray(fallbackHistory) && fallbackHistory.length > 0, {
      history: fallbackHistory.length
    });
    pushCheck(checks, "fallback meta marked stale", fallbackMeta?.fallback?.keptExisting === true && fallbackMeta?.api?.stale === true, {
      keptExisting: fallbackMeta?.fallback?.keptExisting ?? null,
      stale: fallbackMeta?.api?.stale ?? null,
      reason: fallbackMeta?.fallback?.reason || fallbackMeta?.api?.fallbackReason || null
    });
    pushCheck(checks, "fallback freshness preserves trusted source time", Boolean(fallbackMeta?.api?.freshnessTime && fallbackMeta?.lastAttemptAt), {
      freshnessTime: fallbackMeta?.api?.freshnessTime || null,
      lastAttemptAt: fallbackMeta?.lastAttemptAt || null,
      updatedAt: fallbackMeta?.updatedAt || null
    });

    await runCommand(process.execPath, ["scripts/exportDataStoreSqlite.cjs"]);
    await startServer();

    const health = await request("GET", "/api/v1/health");
    const sqlite = health.body?.storage?.sqlite || null;
    pushCheck(checks, "fallback sqlite remains readable", health.status === 200 && sqlite?.available && !sqlite?.stale, {
      status: health.status,
      sqliteAvailable: Boolean(sqlite?.available),
      sqliteStale: Boolean(sqlite?.stale),
      syncMetaUpdatedAt: sqlite?.syncMetaUpdatedAt || null
    });

    const create = await request("POST", "/api/admin/access-codes", { label: "source-fallback-verify" }, {
      authorization: `Bearer ${adminToken}`
    });
    const verify = create.body?.code
      ? await request("POST", "/api/access/verify", { code: create.body.code })
      : { status: 0, body: null };
    const token = verify.body?.session?.token || "";
    const current = token
      ? await request("GET", "/api/v1/matches/current?view=list", null, { "x-access-token": token })
      : { status: 0, body: null };
    pushCheck(checks, "fallback v1 current served from sqlite", current.status === 200 && current.body?.dataSource === "sqlite" && Array.isArray(current.body?.rows) && current.body.rows.length > 0, {
      status: current.status,
      dataSource: current.body?.dataSource || null,
      rows: Array.isArray(current.body?.rows) ? current.body.rows.length : 0
    });
    pushCheck(checks, "fallback v1 current marked stale", current.status === 200 && current.body?.stale === true, {
      stale: current.body?.stale ?? null,
      version: current.body?.version || null
    });

    const ok = checks.every((check) => check.ok);
    console.log(JSON.stringify({
      ok,
      checkedAt: new Date().toISOString(),
      port,
      checks
    }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    stopServer();
    await restoreFiles();
    await runCommand(process.execPath, ["scripts/exportDataStoreSqlite.cjs"]).catch(() => {});
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

run().catch((error) => {
  stopServer();
  restoreFiles()
    .catch(() => {})
    .finally(() => {
      console.error(error.stack || String(error));
      process.exit(1);
    });
});
