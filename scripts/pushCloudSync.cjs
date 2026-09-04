const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { boundedRuntimeEnv, boundedRuntimeNumber } = require("./boundedRuntimeNumber.cjs");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(rootDir, ".codex-tmp");
const lockFile = path.join(tmpDir, "cloud-sync.lock");
const archiveFile = path.join(tmpDir, "football-cloud-data.tgz");
const relaySnapshotFile = path.join(tmpDir, "sporttery-relay-snapshot.json");
const sqliteSnapshotDir = path.join(tmpDir, "cloud-sqlite");
const sqliteSnapshotFile = path.join(sqliteSnapshotDir, "football.db");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const cloudHost = process.env.FOOTBALL_CLOUD_HOST || "134.175.132.183";
const cloudUser = process.env.FOOTBALL_CLOUD_USER || "ubuntu";
const cloudPort = String(process.env.FOOTBALL_CLOUD_PORT || process.env.RELEASE_DEPLOY_PORT || "22");
const cloudDir = process.env.FOOTBALL_CLOUD_DIR || "/opt/football-predict";
const cloudApiBase = String(process.env.FOOTBALL_CLOUD_API_BASE || process.env.REMOTE_BASE_URL || `https://${cloudHost}`).replace(/\/+$/, "");
const cloudAdminToken = process.env.FOOTBALL_CLOUD_ADMIN_TOKEN || "";
const keyPath = path.resolve(rootDir, process.env.FOOTBALL_CLOUD_KEY || ".codex-tmp/football.pem");
const remoteArchive = process.env.FOOTBALL_CLOUD_REMOTE_ARCHIVE || "/tmp/football-cloud-data.tgz";
const remoteExtractDir = process.env.FOOTBALL_CLOUD_REMOTE_EXTRACT_DIR || "/tmp/football-cloud-data-extract";
const remoteRelaySnapshot = process.env.FOOTBALL_REMOTE_RELAY_SNAPSHOT || "/var/lib/football-predict/sporttery-relay-snapshot.json";
const remoteSqliteDbPath = process.env.FOOTBALL_REMOTE_SQLITE_DB || "/var/lib/football-predict/football.db";
const localSqliteDbPath = path.resolve(process.env.DATASTORE_SQLITE_PATH || path.join(rootDir, "server-data", "football.db"));
const sqliteSyncStateFile = path.join(tmpDir, "cloud-sqlite-sync-state.json");
const supplementalSync = process.env.FOOTBALL_REMOTE_SUPPLEMENTAL_SYNC !== "0";
const localSupplementalSync = process.env.FOOTBALL_LOCAL_SUPPLEMENTAL_SYNC !== "0";
const weatherSync = process.env.FOOTBALL_ENABLE_WEATHER_SYNC !== "0";
const apiFootballSync = process.env.FOOTBALL_ENABLE_API_FOOTBALL_SYNC === "1";
const restartService = process.env.FOOTBALL_REMOTE_RESTART === "1";
const staleLockMinutes = boundedRuntimeEnv(process.env, "FOOTBALL_CLOUD_STALE_LOCK_MINUTES", {
  fallback: 20, min: 5, max: 24 * 60,
});
const sqliteWarehouseSync = process.env.FOOTBALL_CLOUD_SQLITE_SYNC !== "0";
const forceSqliteWarehouseSync = process.env.FOOTBALL_CLOUD_FORCE_SQLITE_SYNC === "1";
const sqliteWarehouseSyncIntervalMinutes = boundedRuntimeEnv(
  process.env,
  "FOOTBALL_CLOUD_SQLITE_SYNC_INTERVAL_MINUTES",
  { fallback: 360, min: 30, max: 30 * 24 * 60 },
);
const disabledDistPayloads = [
  "matches.json",
  "odds-history.json",
  "data/matches-current.json",
  "data/matches-history.json",
  "data/odds-history.json",
  "data/post-match-reviews.json",
  "data/external-signals.json",
  "data/five-hundred-details.json",
  "data/pre-match-signals.json",
  "data/prediction-snapshots.json",
  "data/model-calibration.json",
  "data/model-strategy.json",
  "data/api-football-cache.json",
  "data/api-football-meta.json",
  "data/gpt-predictions.json",
  "data/web-consensus-signals.json",
  "data/weather-locations.json",
  "data/worldcup-kimi-dataset.json",
];
const lightweightDistDataFiles = [
  "runtime-config.json",
  "sync-meta.json",
  "team-index.json",
];
const serverGeneratedArtifactExcludes = [
  "public/data/model-evaluation.json",
  "dist/data/model-evaluation.json",
];

function log(message) {
  const stamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  console.log(`[cloud-sync] ${stamp} ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${command} ${args.join(" ")}`);
    const useShell = options.shell !== undefined
      ? options.shell
      : (process.platform === "win32" && /\.cmd$/i.test(command));
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...(options.env || {}) },
      shell: useShell,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

function ensureNoActiveLock() {
  fs.mkdirSync(tmpDir, { recursive: true });
  if (!fs.existsSync(lockFile)) {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    return;
  }

  const stat = fs.statSync(lockFile);
  const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
  if (ageMinutes > staleLockMinutes) {
    log(`发现过期锁 ${ageMinutes.toFixed(1)} 分钟，已清理`);
    fs.rmSync(lockFile, { force: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    return;
  }

  throw new Error("上一轮云端推送仍在运行，跳过本轮");
}

function releaseLock() {
  fs.rmSync(lockFile, { force: true });
}

const readJsonFile = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonFile = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const sqliteQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

const readSqliteCounts = (dbPath) => {
  if (!sqliteWarehouseSync) return { ok: false, skipped: true, reason: "sqlite warehouse sync disabled" };
  if (!DatabaseSync) return { ok: false, reason: "node:sqlite unavailable" };
  if (!fs.existsSync(dbPath)) return { ok: false, reason: "sqlite database not found", path: dbPath };
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const scalar = (sql) => Number(db.prepare(sql).get()?.value || 0);
    return {
      ok: true,
      path: dbPath,
      sizeBytes: fs.statSync(dbPath).size,
      counts: {
        currentMatches: scalar("SELECT COUNT(*) AS value FROM match_snapshots WHERE dataset = 'current'"),
        historyMatches: scalar("SELECT COUNT(*) AS value FROM match_snapshots WHERE dataset = 'history'"),
        oddsSnapshots: scalar("SELECT COUNT(*) AS value FROM odds_snapshots"),
        predictionSnapshots: scalar("SELECT COUNT(*) AS value FROM prediction_snapshots"),
        sourceSnapshots: scalar("SELECT COUNT(*) AS value FROM source_snapshots")
      }
    };
  } catch (error) {
    return { ok: false, path: dbPath, reason: error.message || String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures for diagnostics.
    }
  }
};

const fetchRemoteSqliteCounts = async () => {
  if (typeof fetch !== "function") return { ok: false, reason: "fetch unavailable" };
  try {
    const response = await fetch(`${cloudApiBase}/api/v1/health`, { method: "GET" });
    const payload = await response.json().catch(() => null);
    const sqlite = payload?.storage?.sqlite || {};
    return {
      ok: response.ok && sqlite.available === true,
      status: response.status,
      counts: sqlite.counts || null,
      path: sqlite.path || null,
      stale: sqlite.stale ?? null,
      reason: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return { ok: false, reason: error.message || String(error) };
  }
};

const sqliteBehindTables = (localCounts = {}, remoteCounts = {}) => {
  return ["currentMatches", "historyMatches", "oddsSnapshots", "predictionSnapshots", "sourceSnapshots"]
    .filter((key) => Number(localCounts[key] || 0) > Number(remoteCounts[key] || 0));
};

const sqliteAheadTables = (localCounts = {}, remoteCounts = {}) => {
  return ["currentMatches", "historyMatches", "oddsSnapshots", "predictionSnapshots", "sourceSnapshots"]
    .filter((key) => Number(remoteCounts[key] || 0) > Number(localCounts[key] || 0));
};

const sqliteStateAgeMinutes = (state) => {
  const time = Date.parse(state?.lastSuccessAt || "");
  return Number.isFinite(time) ? (Date.now() - time) / 60000 : Infinity;
};

const buildSqliteWarehousePlan = async () => {
  const local = readSqliteCounts(localSqliteDbPath);
  const remote = await fetchRemoteSqliteCounts();
  const state = readJsonFile(sqliteSyncStateFile, {});
  const behindTables = sqliteBehindTables(local.counts, remote.counts);
  const aheadTables = sqliteAheadTables(local.counts, remote.counts);
  const stateAgeMinutes = sqliteStateAgeMinutes(state);
  const intervalDue = Number.isFinite(stateAgeMinutes) && stateAgeMinutes >= sqliteWarehouseSyncIntervalMinutes;
  const upload = Boolean(sqliteWarehouseSync && local.ok && (
    forceSqliteWarehouseSync
    || behindTables.length > 0
    || (intervalDue && aheadTables.length === 0)
  ));
  return {
    upload,
    reason: !sqliteWarehouseSync
      ? "disabled"
      : !local.ok
        ? local.reason
        : forceSqliteWarehouseSync
          ? "forced"
          : behindTables.length
            ? `remote-behind:${behindTables.join(",")}`
            : aheadTables.length
              ? `remote-ahead:${aheadTables.join(",")}`
              : intervalDue
              ? `interval-due:${Math.round(stateAgeMinutes)}m`
              : "remote-current",
    local,
    remote,
    behindTables,
    aheadTables,
    stateAgeMinutes: Number.isFinite(stateAgeMinutes) ? Number(stateAgeMinutes.toFixed(2)) : null,
    intervalMinutes: sqliteWarehouseSyncIntervalMinutes
  };
};

const createSqliteWarehouseSnapshot = () => {
  const source = readSqliteCounts(localSqliteDbPath);
  if (!source.ok) return { ok: false, ...source };
  fs.rmSync(sqliteSnapshotDir, { recursive: true, force: true });
  fs.mkdirSync(sqliteSnapshotDir, { recursive: true });
  let db = null;
  try {
    db = new DatabaseSync(localSqliteDbPath, { readOnly: true });
    db.exec(`VACUUM INTO ${sqliteQuote(sqliteSnapshotFile)}`);
  } catch (error) {
    return { ok: false, path: localSqliteDbPath, reason: error.message || String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures after VACUUM INTO.
    }
  }
  const snapshot = readSqliteCounts(sqliteSnapshotFile);
  return {
    ok: snapshot.ok,
    sourcePath: localSqliteDbPath,
    archivePath: sqliteSnapshotFile,
    archiveRelativePath: path.relative(rootDir, sqliteSnapshotFile).replace(/\\/g, "/"),
    sizeBytes: snapshot.sizeBytes,
    counts: snapshot.counts,
    reason: snapshot.reason || null
  };
};

function mirrorPublicDataToDist() {
  const publicDataDir = path.join(rootDir, "public", "data");
  const distDir = path.join(rootDir, "dist");
  const distDataDir = path.join(distDir, "data");
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(distDataDir, { recursive: true });

  for (const relativePath of disabledDistPayloads) {
    fs.rmSync(path.join(distDir, relativePath), { force: true });
  }

  for (const fileName of lightweightDistDataFiles) {
    const source = path.join(publicDataDir, fileName);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(distDataDir, fileName));
    }
  }
}

function relaySnapshotStatus(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const capturedMs = Date.parse(payload?.capturedAt || "");
    const configuredMaxAgeMinutes = boundedRuntimeEnv(
      process.env,
      ["SPORTTERY_RELAY_MAX_AGE_MINUTES", "SOURCE_MAX_AGE_MINUTES"],
      { fallback: 20, min: 1, max: 30 * 24 * 60 },
    );
    const maxAgeMinutes = Math.max(configuredMaxAgeMinutes, boundedRuntimeNumber(
      payload?.maxAgeMinutes,
      { fallback: configuredMaxAgeMinutes, min: 1, max: 30 * 24 * 60 },
    ));
    const ageMinutes = Number.isFinite(capturedMs) ? (Date.now() - capturedMs) / 60000 : Infinity;
    const usable = Number(payload?.summary?.usableEndpoints || 0) > 0
      && Number(payload?.summary?.rows || 0) > 0;
    return {
      exists: true,
      usable,
      fresh: usable && Number.isFinite(ageMinutes) && ageMinutes <= maxAgeMinutes,
      capturedAt: payload?.capturedAt || null,
      ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
      maxAgeMinutes,
      rows: Number(payload?.summary?.rows || 0),
      usableEndpoints: Number(payload?.summary?.usableEndpoints || 0),
    };
  } catch {
    return { exists: fs.existsSync(filePath), usable: false, fresh: false };
  }
}

async function collectRelaySnapshot() {
  try {
    await run(npmCommand, ["run", "sync:sporttery-snapshot"], {
      env: { SPORTTERY_RELAY_SNAPSHOT_OUT: relaySnapshotFile },
    });
    const status = relaySnapshotStatus(relaySnapshotFile);
    if (!status.fresh) {
      throw new Error(`Sporttery relay snapshot is not fresh after refresh: ${JSON.stringify(status)}`);
    }
    return status;
  } catch (error) {
    const status = relaySnapshotStatus(relaySnapshotFile);
    if (!status.usable) {
      log(`Sporttery relay snapshot refresh failed and no usable local snapshot is available; skip cloud data push: ${error.message || error}`);
      return status;
    }
    if (!status.fresh) {
      log(`Sporttery relay snapshot refresh failed and existing snapshot is stale; skip cloud data push: ${error.message || error}; ${JSON.stringify(status)}`);
      return status;
    }
    log(`Sporttery relay snapshot refresh failed; using existing fresh snapshot: ${error.message || error}; ${JSON.stringify(status)}`);
    return status;
  }
}

async function uploadRelaySnapshotViaApi() {
  if (!cloudAdminToken || process.env.FOOTBALL_CLOUD_API_UPLOAD === "0") {
    return { ok: false, skipped: true, reason: "api upload not configured" };
  }
  if (typeof fetch !== "function") {
    return { ok: false, skipped: true, reason: "fetch unavailable in current Node runtime" };
  }

  let apiOrigin;
  try {
    apiOrigin = new URL(cloudApiBase);
  } catch (error) {
    return { ok: false, skipped: true, reason: `invalid cloud API base URL: ${error.message || error}` };
  }
  const loopbackHost = apiOrigin.hostname === "localhost"
    || apiOrigin.hostname === "::1"
    || /^127(?:\.[0-9]{1,3}){3}$/.test(apiOrigin.hostname);
  if (apiOrigin.protocol !== "https:" && !loopbackHost) {
    return { ok: false, skipped: true, reason: "refusing to send bearer credentials to a non-HTTPS public origin" };
  }

  const snapshot = JSON.parse(fs.readFileSync(relaySnapshotFile, "utf8"));
  const runSyncAfterUpload = process.env.FOOTBALL_CLOUD_RELAY_RUN_SYNC === "1";
  const endpoint = `${cloudApiBase}/api/admin/sporttery-relay-snapshot${runSyncAfterUpload ? "?runSync=1" : ""}`;
  log(`尝试通过 HTTPS 上传 Sporttery relay 快照: ${endpoint}`);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${cloudAdminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ snapshot, runSync: runSyncAfterUpload }),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.ok !== true) {
      return {
        ok: false,
        status: response.status,
        error: payload?.error || text.slice(0, 300) || response.statusText,
        payload,
      };
    }
    return {
      ok: true,
      status: response.status,
      rows: payload?.validation?.rows || 0,
      usableEndpoints: payload?.validation?.usableEndpoints || 0,
      syncOk: payload?.sync?.ok ?? null,
      payload,
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function remoteStripDisabledDistPayloads() {
  const targets = disabledDistPayloads
    .map((relativePath) => `dist/${relativePath}`)
    .join(" ");
  return `rm -f ${targets}`;
}

function remoteCommand(options = {}) {
  const relaySnapshotInArchive = `${remoteExtractDir}/.codex-tmp/sporttery-relay-snapshot.json`;
  const sqliteWarehouseInArchive = `${remoteExtractDir}/.codex-tmp/cloud-sqlite/football.db`;
  const installRelaySnapshot = [
    `if [ -f ${relaySnapshotInArchive} ]; then sudo install -o football -g football -m 0664 ${relaySnapshotInArchive} ${remoteRelaySnapshot}; fi`,
    `test -f ${remoteRelaySnapshot} || { echo '[cloud-sync] relay snapshot missing'; exit 31; }`,
  ];
  const installSqliteWarehouse = options.installSqliteWarehouse
    ? [
        `test -f ${sqliteWarehouseInArchive} || { echo '[cloud-sync] sqlite warehouse snapshot missing'; exit 32; }`,
        `sudo install -d -o football -g football -m 0775 ${path.posix.dirname(remoteSqliteDbPath)}`,
        `sqlite_backup=${remoteSqliteDbPath}.backup-$(date +%Y%m%d-%H%M%S)`,
        `if [ -f ${remoteSqliteDbPath} ]; then sudo cp -f ${remoteSqliteDbPath} "$sqlite_backup"; fi`,
        `sudo install -o football -g football -m 0664 ${sqliteWarehouseInArchive} ${remoteSqliteDbPath}.new`,
        `sudo rm -f ${remoteSqliteDbPath}-wal ${remoteSqliteDbPath}-shm`,
        `sudo mv -f ${remoteSqliteDbPath}.new ${remoteSqliteDbPath}`,
        `sudo chown football:football ${remoteSqliteDbPath} ${remoteSqliteDbPath}.backup-* 2>/dev/null || true`,
        "sqlite_uploaded=1",
      ]
    : [];
  const syncBlock = options.installSqliteWarehouse
    ? [
        "npm run validate:data",
        "npm run validate:sources || echo '[cloud-sync] validate:sources skipped/failed'",
        "echo '[cloud-sync] datastore:sqlite skipped because local SQLite warehouse was installed'",
        "sudo -u football env PATH=$PATH SERVER_STORE_DIR=/var/lib/football-predict DATASTORE_SQLITE_PATH=/var/lib/football-predict/football.db MODEL_BACKTEST_SQLITE_ODDS_LIMIT=120000 MODEL_BACKTEST_SQLITE_PREDICTION_LIMIT=50000 node scripts/runModelBacktest.cjs",
      ]
    : supplementalSync
    ? [
        "set +u",
        `[ -r ${cloudDir}/deploy/light-server/env ] && set -a && . ${cloudDir}/deploy/light-server/env && set +a || true`,
        "set -u",
        "npm run sync:500 || echo '[cloud-sync] sync:500 skipped/failed'",
        "npm run sync:500:details || echo '[cloud-sync] sync:500:details skipped/failed'",
        weatherSync
          ? "npm run sync:weather || echo '[cloud-sync] sync:weather skipped/failed'"
          : "echo '[cloud-sync] weather disabled'",
        apiFootballSync
          ? "ENABLE_API_FOOTBALL_SYNC=1 npm run sync:api-football || echo '[cloud-sync] sync:api-football skipped/failed'"
          : "echo '[cloud-sync] api-football disabled by default'",
        "npm run sync:prematch || echo '[cloud-sync] sync:prematch skipped/failed'",
        `SPORTTERY_RELAY_MODE=prefer SPORTTERY_RELAY_SNAPSHOT=${remoteRelaySnapshot} node scripts/syncData.cjs`,
        "npm run validate:data",
        "npm run validate:sources",
        `sudo env PATH=$PATH SERVER_STORE_DIR=/var/lib/football-predict DATASTORE_SQLITE_PATH=/var/lib/football-predict/football.db npm run datastore:sqlite`,
        "sudo chown football:football /var/lib/football-predict/football.db* || true",
      ]
    : [
        "npm run validate:data",
        `sudo env PATH=$PATH SERVER_STORE_DIR=/var/lib/football-predict DATASTORE_SQLITE_PATH=/var/lib/football-predict/football.db npm run datastore:sqlite`,
        "sudo chown football:football /var/lib/football-predict/football.db* || true",
      ];

  return [
    "set -euo pipefail",
    "sqlite_uploaded=0",
    "remote_sync_lock=/var/lib/football-predict/locks/sync.lock",
    "remote_sync_lock_acquired=0",
    "worker_was_active=$(systemctl is-active football-sync-worker 2>/dev/null || true)",
    "sudo systemctl stop football-sync-worker >/dev/null 2>&1 || true",
    `cleanup_cloud_sync(){ rm -rf ${remoteExtractDir} ${remoteArchive}; if [ "$remote_sync_lock_acquired" = "1" ]; then sudo rm -rf "$remote_sync_lock"; fi; if [ "$worker_was_active" = "active" ]; then sudo systemctl start football-sync-worker >/dev/null 2>&1 || true; fi; }`,
    "trap cleanup_cloud_sync EXIT",
    "sudo install -d -o football -g football -m 0775 /var/lib/football-predict/locks",
    "for i in $(seq 1 60); do if sudo mkdir \"$remote_sync_lock\" 2>/dev/null; then remote_sync_lock_acquired=1; break; fi; echo '[cloud-sync] waiting for sync lock'; sleep 2; done",
    "if [ \"$remote_sync_lock_acquired\" != \"1\" ]; then echo '[cloud-sync] sync lock still held after waiting'; exit 73; fi",
    "printf '{\"version\":1,\"owner\":\"football-cloud-sync\",\"source\":\"pushCloudSync\",\"pid\":%s,\"hostname\":\"%s\",\"startedAt\":\"%s\",\"lockDir\":\"%s\"}\\n' \"$$\" \"$(hostname)\" \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \"$remote_sync_lock\" | sudo tee \"$remote_sync_lock/lock.json\" >/dev/null",
    `cd ${cloudDir}`,
    `rm -rf ${remoteExtractDir}`,
    `mkdir -p ${remoteExtractDir}`,
    `tar -xzf ${remoteArchive} -C ${remoteExtractDir}`,
    ...installRelaySnapshot,
    ...installSqliteWarehouse,
    "sudo chmod -R a+rwX public dist || true",
    "mkdir -p public/data dist/data",
    `cp -r ${remoteExtractDir}/public/data/. public/data/`,
    `cp -f ${remoteExtractDir}/public/matches.json public/matches.json`,
    `cp -f ${remoteExtractDir}/public/odds-history.json public/odds-history.json`,
    `cp -r ${remoteExtractDir}/dist/data/. dist/data/`,
    remoteStripDisabledDistPayloads(),
    ...syncBlock,
    remoteStripDisabledDistPayloads(),
    "sudo chown -R football:football public/data dist/data public/matches.json public/odds-history.json || true",
    "sudo chmod -R a+rwX public/data dist/data public/matches.json public/odds-history.json || true",
    `rm -rf ${remoteExtractDir} ${remoteArchive}`,
    options.installSqliteWarehouse
      ? "if [ \"$sqlite_uploaded\" = \"1\" ]; then sudo systemctl restart football-predict; else true; fi"
      : (restartService ? "sudo systemctl restart football-predict" : "true"),
    "if [ \"$worker_was_active\" = \"active\" ]; then sudo systemctl start football-sync-worker >/dev/null 2>&1 || true; fi",
    "echo '[cloud-sync] remote data refresh complete'",
  ].join("; ");
}

async function main() {
  ensureNoActiveLock();
  try {
    if (!fs.existsSync(keyPath)) {
      throw new Error(`SSH key not found: ${keyPath}`);
    }

    log("开始本地中国竞彩网同步");
    const relayStatus = await collectRelaySnapshot();
    if (!relayStatus.fresh && process.env.FOOTBALL_ALLOW_STALE_RELAY_PUSH !== "1") {
      log("本轮未获得新鲜 Sporttery relay，跳过云端数据推送，避免用 stale 数据覆盖服务器");
      if (!sqlitePlan.upload) return;
      log("HTTPS relay uploaded; SQLite warehouse still needs sync, continuing with SSH package");
    }

    const apiUpload = await uploadRelaySnapshotViaApi();
    const sqlitePlan = await buildSqliteWarehousePlan();
    log(`SQLite warehouse sync plan: ${JSON.stringify({
      upload: sqlitePlan.upload,
      reason: sqlitePlan.reason,
      local: sqlitePlan.local?.counts || null,
      remote: sqlitePlan.remote?.counts || null,
      behindTables: sqlitePlan.behindTables,
      aheadTables: sqlitePlan.aheadTables,
      stateAgeMinutes: sqlitePlan.stateAgeMinutes
    })}`);
    if (apiUpload.ok) {
      log(`HTTPS relay 上传完成：rows=${apiUpload.rows} usableEndpoints=${apiUpload.usableEndpoints} syncOk=${apiUpload.syncOk}`);
      return;
    }
    if (!apiUpload.skipped) {
      log(`HTTPS relay 上传失败，回退 SSH 数据包推送：${apiUpload.error || `HTTP ${apiUpload.status}`}`);
    }

    if (localSupplementalSync) {
      await run("node", ["scripts/sync500Data.cjs"]);
      await run("node", ["scripts/sync500Details.cjs"]);
      if (weatherSync) {
        await run("node", ["scripts/syncWeatherData.cjs"]);
      }
      if (apiFootballSync) {
        await run("node", ["scripts/syncApiFootballData.cjs"], {
          env: { ENABLE_API_FOOTBALL_SYNC: "1" },
        });
      }
      // Aggregate quality only after every enabled structured provider has
      // written its observations, so the current cycle never scores stale
      // API-Football or weather coverage.
      await run(npmCommand, ["run", "sync:prematch"]);
    }
    await run("node", ["scripts/syncData.cjs"], {
      env: {
        SPORTTERY_RELAY_SNAPSHOT: relaySnapshotFile,
        PAGE_POLL_SECONDS: process.env.PAGE_POLL_SECONDS || "20",
        SYNC_WORKFLOW_MINUTES: process.env.SYNC_WORKFLOW_MINUTES || "5",
      },
    });
    await run(npmCommand, ["run", "validate:data"]);
    let sqliteSnapshot = null;
    if (sqlitePlan.upload) {
      await run(npmCommand, ["run", "datastore:sqlite"], {
        env: {
          DATASTORE_SQLITE_PATH: localSqliteDbPath,
          SERVER_STORE_DIR: path.dirname(localSqliteDbPath),
          SQLITE_EXPORT_ODDS_LIMIT: process.env.SQLITE_EXPORT_ODDS_LIMIT || "120000",
          SQLITE_EXPORT_PREDICTION_LIMIT: process.env.SQLITE_EXPORT_PREDICTION_LIMIT || "50000",
          SQLITE_IMPORT_JSONL_ODDS_LIMIT: process.env.SQLITE_IMPORT_JSONL_ODDS_LIMIT || "50000",
          SQLITE_IMPORT_JSONL_PREDICTION_LIMIT: process.env.SQLITE_IMPORT_JSONL_PREDICTION_LIMIT || "50000",
        },
      });
      sqliteSnapshot = createSqliteWarehouseSnapshot();
      if (!sqliteSnapshot.ok) {
        throw new Error(`SQLite warehouse snapshot failed: ${sqliteSnapshot.reason || "unknown error"}`);
      }
      log(`SQLite warehouse snapshot ready: ${JSON.stringify({
        bytes: sqliteSnapshot.sizeBytes,
        counts: sqliteSnapshot.counts
      })}`);
    }
    mirrorPublicDataToDist();

    fs.rmSync(archiveFile, { force: true });
    const archivePathForTar = path.relative(rootDir, archiveFile).replace(/\\/g, "/");
    const archiveEntries = [
      ...serverGeneratedArtifactExcludes.map((relativePath) => `--exclude=${relativePath}`),
      "-czf",
      archivePathForTar,
      "public/data",
      "public/matches.json",
      "public/odds-history.json",
      "dist/data",
      ".codex-tmp/sporttery-relay-snapshot.json",
    ];
    if (sqliteSnapshot?.archiveRelativePath) archiveEntries.push(sqliteSnapshot.archiveRelativePath);
    await run("tar", archiveEntries);

    const remote = `${cloudUser}@${cloudHost}`;
    await run("scp", ["-P", cloudPort, "-i", keyPath, "-o", "StrictHostKeyChecking=accept-new", archiveFile, `${remote}:${remoteArchive}`]);
    await run("ssh", ["-p", cloudPort, "-i", keyPath, "-o", "StrictHostKeyChecking=accept-new", remote, remoteCommand({
      installSqliteWarehouse: Boolean(sqliteSnapshot?.archiveRelativePath)
    })]);
    if (sqliteSnapshot?.archiveRelativePath) {
      writeJsonFile(sqliteSyncStateFile, {
        lastSuccessAt: new Date().toISOString(),
        reason: sqlitePlan.reason,
        localCounts: sqliteSnapshot.counts,
        remoteCountsBefore: sqlitePlan.remote?.counts || null,
        dbPath: localSqliteDbPath,
        sizeBytes: sqliteSnapshot.sizeBytes
      });
    }

    log("云端数据推送完成");
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  console.error(`[cloud-sync] failed: ${error.message || error}`);
  process.exit(1);
});
