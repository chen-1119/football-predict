const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const rootDir = path.resolve(__dirname, "..");
const verifierName = "verifyCloudSyncFreshness";
const taskName = process.env.FOOTBALL_CLOUD_TASK_NAME || "FootballPredictCloudSync";
const relayTaskName = process.env.FOOTBALL_RELAY_TASK_NAME || "FootballPredictSportteryRelay";
const logsDir = path.join(rootDir, "logs");
const logFile = process.env.CLOUD_SYNC_LOG_FILE || path.join(logsDir, "cloud-sync.log");
const relayLogFile = process.env.SPORTTERY_RELAY_LOG_FILE || path.join(logsDir, "sporttery-relay.log");
const relaySnapshotPath = process.env.SPORTTERY_RELAY_SNAPSHOT_PATH
  || process.env.SPORTTERY_RELAY_SNAPSHOT
  || path.join(rootDir, ".codex-tmp", "sporttery-relay-snapshot.json");
const relayFailedSnapshotPath = process.env.SPORTTERY_RELAY_FAILED_SNAPSHOT_PATH
  || process.env.SPORTTERY_RELAY_FAILED_SNAPSHOT_OUT
  || `${relaySnapshotPath}.last-failed.json`;
const relayStatePath = process.env.SPORTTERY_RELAY_STATE_PATH || path.join(logsDir, "sporttery-relay-state.json");
const baseUrl = new URL(process.env.REMOTE_BASE_URL || process.env.VERIFY_BASE_URL || "https://134.175.132.183");
const maxTaskAgeMinutes = Math.max(5, Number(process.env.CLOUD_SYNC_MAX_TASK_AGE_MINUTES || 15));
const maxRunningMinutes = Math.max(2, Number(process.env.CLOUD_SYNC_MAX_RUNNING_MINUTES || process.env.FOOTBALL_CLOUD_SYNC_TIMEOUT_MINUTES || 8));
const maxLogAgeMinutes = Math.max(5, Number(process.env.CLOUD_SYNC_MAX_LOG_AGE_MINUTES || 20));
const requirePrimary = process.env.CLOUD_SYNC_REQUIRE_PRIMARY === "1";
const requireLocalRelayFresh = process.env.CLOUD_SYNC_REQUIRE_LOCAL_RELAY_FRESH === "1";
const explicitLocalPushRequired = process.env.CLOUD_SYNC_REQUIRE_LOCAL_AUTOMATION === "1"
  || process.env.LOCAL_DATA_PUSH_REQUIRED === "1"
  || process.env.CLOUD_SYNC_REQUIRED === "1";
const serverPrimaryMode = process.env.PRODUCTION_DATA_MODE === "server-primary"
  || process.env.SERVER_DATA_PRIMARY === "1"
  || process.env.LOCAL_DATA_PUSH_REQUIRED === "0"
  || process.env.CLOUD_SYNC_REQUIRED === "0"
  || (!process.env.PRODUCTION_DATA_MODE && !explicitLocalPushRequired);
const requireLocalAutomation = explicitLocalPushRequired;
const requireSqliteParity = process.env.CLOUD_SYNC_REQUIRE_SQLITE_PARITY === "1";
const requireModelCoverage = process.env.CLOUD_SYNC_REQUIRE_MODEL_COVERAGE === "1";
const modelCoverageMinRatio = Math.min(1, Math.max(0.5, Number(process.env.CLOUD_SYNC_MODEL_SQLITE_COVERAGE_MIN || 0.95)));
const modelCoverageTriggerRatio = Math.min(1, Math.max(modelCoverageMinRatio, Number(
  process.env.CLOUD_SYNC_MODEL_SQLITE_COVERAGE_TRIGGER_RATIO
    || process.env.MODEL_BACKTEST_SQLITE_COVERAGE_TRIGGER_RATIO
    || (modelCoverageMinRatio + 0.03)
)));
const relayMaxConsecutiveCollectFailures = Math.max(1, Number(process.env.SPORTTERY_RELAY_MAX_CONSECUTIVE_COLLECT_FAILURES || 3));
const localSqliteDbPath = path.resolve(process.env.DATASTORE_SQLITE_PATH || path.join(rootDir, "server-data", "football.db"));

const request = (pathname) => {
  const target = new URL(pathname, baseUrl);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = transport.request(target, { method: "GET", timeout: 20_000 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        resolve({
          status: res.statusCode,
          body,
          bytes: Buffer.byteLength(raw)
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout: ${target}`)));
    req.on("error", (error) => resolve({ status: 0, body: null, bytes: 0, error: error.message || String(error) }));
    req.end();
  });
};

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readSqliteCounts = (dbPath) => {
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
      // Ignore close failures while building diagnostics.
    }
  }
};

const sqliteBehindTables = (localCounts = {}, remoteCounts = {}) => {
  return ["currentMatches", "historyMatches", "oddsSnapshots", "predictionSnapshots", "sourceSnapshots"]
    .filter((key) => asNumber(localCounts[key], 0) > asNumber(remoteCounts[key], 0));
};

const classifySportteryError = (message) => {
  const text = String(message || "");
  if (/HTTP 403|WAF|TencentCaptcha|WafCaptcha|__captcha|captcha\.qq\.com|Unexpected token '<'|<!DOCTYPE html|<script/i.test(text)) return "waf-blocked";
  if (/invalid JSON|Unexpected token '<'|<!DOCTYPE html/i.test(text)) return "html-response";
  if (/timeout/i.test(text)) return "timeout";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(text)) return "network";
  if (/sporttery_api_/i.test(text)) return "sporttery-api";
  return "unknown";
};

const parseDateLoose = (value) => {
  const text = String(value || "").trim();
  if (!text || text.toUpperCase() === "N/A") return NaN;
  const normalized = text
    .replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+/, "$1-$2-$3 ")
    .replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+/, "$3-$1-$2 ");
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : NaN;
};

const ageMinutes = (timeMs) => (
  Number.isFinite(timeMs) ? Math.max(0, (Date.now() - timeMs) / 60000) : Infinity
);

const readJsonSafe = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const parseTaskList = (text) => {
  const row = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) row[match[1].trim()] = match[2].trim();
  }
  return row;
};

const readTaskStatus = (name = taskName) => {
  if (process.platform !== "win32") {
    return { supported: false, skipped: true, reason: "Windows scheduled task check only runs on win32" };
  }
  try {
    const text = execFileSync("schtasks.exe", ["/Query", "/TN", name, "/V", "/FO", "LIST"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const row = parseTaskList(text);
    const lastRunMs = parseDateLoose(row["Last Run Time"]);
    const nextRunMs = parseDateLoose(row["Next Run Time"]);
    return {
      supported: true,
      exists: true,
      taskName: row.TaskName || name,
      status: row.Status || null,
      state: row["Scheduled Task State"] || null,
      lastResult: row["Last Result"] || null,
      lastRunTime: row["Last Run Time"] || null,
      nextRunTime: row["Next Run Time"] || null,
      lastRunAgeMinutes: Number.isFinite(lastRunMs) ? Number(ageMinutes(lastRunMs).toFixed(2)) : null,
      nextRunInMinutes: Number.isFinite(nextRunMs) ? Number(((nextRunMs - Date.now()) / 60000).toFixed(2)) : null,
      command: row["Task To Run"] || null
    };
  } catch (error) {
    return {
      supported: true,
      exists: false,
      taskName: name,
      error: error.message || String(error)
    };
  }
};

const readLogStatus = () => {
  if (!fs.existsSync(logFile)) return { exists: false, path: logFile };
  const stat = fs.statSync(logFile);
  const raw = fs.readFileSync(logFile, "utf8");
  const tail = raw.split(/\r?\n/).slice(-180).join("\n");
  const starts = [...tail.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] cloud sync started/g)];
  const exits = [...tail.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] cloud sync exited with (-?\d+)/g)];
  const latestStart = starts.length ? starts[starts.length - 1][1] : null;
  const latestExit = exits.length ? { at: exits[exits.length - 1][1], code: Number(exits[exits.length - 1][2]) } : null;
  const latestStartMs = parseDateLoose(latestStart);
  const latestExitMs = parseDateLoose(latestExit?.at);
  const latestEventMs = Math.max(Number.isFinite(latestStartMs) ? latestStartMs : 0, Number.isFinite(latestExitMs) ? latestExitMs : 0, stat.mtimeMs);
  const wafBlocked = /HTTP 403|WAF|Unexpected token '<'|invalid JSON/i.test(tail);
  const staleSkip = /existing snapshot is stale|未获得新鲜|stale 数据/i.test(tail);
  const uploadedViaApi = /HTTPS relay 上传完成|HTTPS relay.*syncOk=true|remote data refresh complete/i.test(tail);
  return {
    exists: true,
    path: logFile,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    latestStart,
    latestExit,
    latestEventAgeMinutes: Number(ageMinutes(latestEventMs).toFixed(2)),
    wafBlocked,
    staleSkip,
    uploadedViaApi,
    tail: tail.slice(-2000)
  };
};

const readRelayLogStatus = () => {
  if (!fs.existsSync(relayLogFile)) return { exists: false, path: relayLogFile };
  const stat = fs.statSync(relayLogFile);
  const raw = fs.readFileSync(relayLogFile, "utf8");
  const tail = raw.split(/\r?\n/).slice(-220).join("\n");
  const starts = [...tail.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] sporttery relay push started/g)];
  const exits = [...tail.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] sporttery relay push exited with (-?\d+)/g)];
  const latestStart = starts.length ? starts[starts.length - 1][1] : null;
  const latestExit = exits.length ? { at: exits[exits.length - 1][1], code: Number(exits[exits.length - 1][2]) } : null;
  const latestStartMs = parseDateLoose(latestStart);
  const latestExitMs = parseDateLoose(latestExit?.at);
  const latestEventMs = Math.max(Number.isFinite(latestStartMs) ? latestStartMs : 0, Number.isFinite(latestExitMs) ? latestExitMs : 0, stat.mtimeMs);
  const collectFailed = /"name":\s*"collect snapshot"[\s\S]{0,160}"ok":\s*false/i.test(tail)
    || /sync:sporttery-snapshot exited with 1/i.test(tail)
    || /snapshot collection failed and no acceptable existing snapshot is available/i.test(tail);
  const uploaded = /"name":\s*"remote upload snapshot"[\s\S]{0,220}"ok":\s*true/i.test(tail);
  const remotePrimary = /"servingMode":\s*"primary"/i.test(tail);
  const timedOut = /sporttery relay timeout/i.test(tail);
  return {
    exists: true,
    path: relayLogFile,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    latestStart,
    latestExit,
    latestEventAgeMinutes: Number(ageMinutes(latestEventMs).toFixed(2)),
    collectFailed,
    uploaded,
    remotePrimary,
    timedOut,
    tail: tail.slice(-2000)
  };
};

const readRelayStatus = () => {
  if (!fs.existsSync(relaySnapshotPath)) return { exists: false, path: relaySnapshotPath };
  try {
    const payload = JSON.parse(fs.readFileSync(relaySnapshotPath, "utf8"));
    const capturedMs = Date.parse(payload?.capturedAt || "");
    const configuredMaxAgeMinutes = Math.max(1, Number(process.env.SPORTTERY_RELAY_MAX_AGE_MINUTES || process.env.SOURCE_MAX_AGE_MINUTES || 20));
    const maxAgeMinutes = Math.max(1, Number(payload?.maxAgeMinutes || 0), configuredMaxAgeMinutes);
    const age = ageMinutes(capturedMs);
    return {
      exists: true,
      path: relaySnapshotPath,
      capturedAt: payload?.capturedAt || null,
      ageMinutes: Number.isFinite(age) ? Number(age.toFixed(2)) : null,
      maxAgeMinutes,
      rows: asNumber(payload?.summary?.rows, 0),
      usableEndpoints: asNumber(payload?.summary?.usableEndpoints, 0),
      transport: payload?.producer?.transport || null,
      producerHost: payload?.producer?.host || null,
      methods: Array.isArray(payload?.summary?.methods) ? payload.summary.methods : [],
      errorClasses: payload?.summary?.errorClasses || null,
      fresh: Number.isFinite(age) && age <= maxAgeMinutes && asNumber(payload?.summary?.rows, 0) > 0
    };
  } catch (error) {
    return { exists: true, path: relaySnapshotPath, fresh: false, error: error.message || String(error) };
  }
};

const readRelayFailureStatus = () => {
  if (!fs.existsSync(relayFailedSnapshotPath)) return { exists: false, path: relayFailedSnapshotPath };
  try {
    const payload = JSON.parse(fs.readFileSync(relayFailedSnapshotPath, "utf8"));
    const capturedMs = Date.parse(payload?.capturedAt || "");
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const errorClasses = errors.reduce((acc, item) => {
      const key = classifySportteryError(item?.error);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      exists: true,
      path: relayFailedSnapshotPath,
      capturedAt: payload?.capturedAt || null,
      ageMinutes: Number.isFinite(capturedMs) ? Number(ageMinutes(capturedMs).toFixed(2)) : null,
      transport: payload?.producer?.transport || null,
      rows: asNumber(payload?.summary?.rows, 0),
      usableEndpoints: asNumber(payload?.summary?.usableEndpoints, 0),
      errors: errors.length,
      errorClasses,
      wafBlocked: Boolean(errorClasses["waf-blocked"]),
      sampleErrors: errors.slice(0, 3).map((item) => ({
        id: item?.id || null,
        method: item?.method || null,
        class: classifySportteryError(item?.error)
      }))
    };
  } catch (error) {
    return { exists: true, path: relayFailedSnapshotPath, error: error.message || String(error) };
  }
};

const readRelayStateStatus = () => {
  const payload = readJsonSafe(relayStatePath, null);
  if (!payload) return { exists: false, path: relayStatePath };
  const updatedMs = Date.parse(payload.updatedAt || "");
  const failedMs = Date.parse(payload.lastCollectFailedAt || "");
  const okMs = Date.parse(payload.lastCollectOkAt || "");
  return {
    exists: true,
    path: relayStatePath,
    updatedAt: payload.updatedAt || null,
    updatedAgeMinutes: Number.isFinite(updatedMs) ? Number(ageMinutes(updatedMs).toFixed(2)) : null,
    consecutiveCollectFailures: asNumber(payload.consecutiveCollectFailures, 0),
    maxConsecutiveCollectFailures: relayMaxConsecutiveCollectFailures,
    lastCollectOkAt: payload.lastCollectOkAt || null,
    lastCollectOkAgeMinutes: Number.isFinite(okMs) ? Number(ageMinutes(okMs).toFixed(2)) : null,
    lastCollectFailedAt: payload.lastCollectFailedAt || null,
    lastCollectFailedAgeMinutes: Number.isFinite(failedMs) ? Number(ageMinutes(failedMs).toFixed(2)) : null,
    lastUploadOkAt: payload.lastUploadOkAt || null,
    lastUploadSnapshotCapturedAt: payload.lastUploadSnapshotCapturedAt || null,
    lastUploadSnapshotRows: payload.lastUploadSnapshotRows ?? null,
    lastUploadSnapshotUsableEndpoints: payload.lastUploadSnapshotUsableEndpoints ?? null,
    lastUploadSnapshotTrusted: payload.lastUploadSnapshotTrusted ?? null,
    lastUploadTrustLevel: payload.lastUploadTrustLevel || null,
    lastTrustedUploadAt: payload.lastTrustedUploadAt || null,
    lastPartialLiveUploadAt: payload.lastPartialLiveUploadAt || null,
    lastTrustedFallbackAt: payload.lastTrustedFallbackAt || null,
    fallbackSnapshotCapturedAt: payload.fallbackSnapshotCapturedAt || null,
    fallbackSnapshotRows: payload.fallbackSnapshotRows ?? null,
    fallbackSnapshotUsableEndpoints: payload.fallbackSnapshotUsableEndpoints ?? null,
    lastRemotePrimaryAt: payload.lastRemotePrimaryAt || null,
    lastRemoteServingMode: payload.lastRemoteServingMode || null,
    lastFailure: payload.lastFailure || null,
    ok: asNumber(payload.consecutiveCollectFailures, 0) < relayMaxConsecutiveCollectFailures
  };
};

const pushCheck = (checks, name, ok, details = {}, required = true) => {
  checks.push({ name, required, ...details, ok: Boolean(ok) });
};

const run = async () => {
  const checks = [];
  const task = readTaskStatus(taskName);
  const relayTask = readTaskStatus(relayTaskName);
  const log = readLogStatus();
  const relayLog = readRelayLogStatus();
  const relay = readRelayStatus();
  const relayFailure = readRelayFailureStatus();
  const relayState = readRelayStateStatus();
  const [health, sourceHealth, syncMeta, modelEvaluation] = await Promise.all([
    request("/api/v1/health"),
    request("/api/v1/source-health"),
    request("/api/v1/sync-meta"),
    request("/api/v1/model/evaluation")
  ]);

  const healthStatus = health.body?.status || {};
  const sqlite = health.body?.storage?.sqlite || {};
  const fallbackCoverage = sourceHealth.body?.fallbackCoverage || {};
  const syncMetaSourceHealth = syncMeta.body?.sourceHealth || {};
  const syncMetaSourceFallback = syncMeta.body?.sourceFallback || {};
  const sportteryEgress = sourceHealth.body?.sportteryEgress || {};
  const remoteSportterySource = Array.isArray(sourceHealth.body?.sources)
    ? sourceHealth.body.sources.find((source) => source.id === "sporttery")
    : null;
  const remoteRelayCollectorState = remoteSportterySource?.metrics?.relaySnapshot?.collectorState
    || syncMeta.body?.api?.relaySnapshot?.collectorState
    || null;
  const modelSample = modelEvaluation.body?.backtest?.sample || {};
  const modelDataSources = modelSample.dataSources || {};
  const modelOddsRows = asNumber(modelDataSources.oddsHistory?.sqliteRows, 0);
  const modelPredictionRows = asNumber(modelDataSources.predictionSnapshots?.sqliteRows, 0);

  if (task.supported) {
    const lastRunAge = task.lastRunAgeMinutes;
    const runningOk = task.status !== "Running" || asNumber(lastRunAge, Infinity) <= maxRunningMinutes;
    pushCheck(checks, "local cloud sync task installed", task.exists && /Enabled/i.test(task.state || ""), {
      taskName: task.taskName,
      status: task.status || null,
      state: task.state || null,
      command: task.command || null
    }, requireLocalAutomation);
    pushCheck(checks, "local cloud sync task recent and not stuck", task.exists
      && Number.isFinite(Number(lastRunAge))
      && Number(lastRunAge) <= maxTaskAgeMinutes
      && runningOk, {
        status: task.status || null,
        lastResult: task.lastResult || null,
        lastRunTime: task.lastRunTime || null,
        lastRunAgeMinutes: lastRunAge,
        maxTaskAgeMinutes,
        maxRunningMinutes,
        nextRunTime: task.nextRunTime || null,
        nextRunInMinutes: task.nextRunInMinutes
      }, requireLocalAutomation);
  } else {
    pushCheck(checks, "local cloud sync task installed", true, task, false);
  }

  pushCheck(checks, "server primary data flow selected", serverPrimaryMode && !requireLocalAutomation, {
    productionDataMode: process.env.PRODUCTION_DATA_MODE || null,
    serverDataPrimary: process.env.SERVER_DATA_PRIMARY || null,
    localDataPushRequired: process.env.LOCAL_DATA_PUSH_REQUIRED || null,
    cloudSyncRequired: process.env.CLOUD_SYNC_REQUIRED || null,
    requireLocalAutomation
  });

  if (relayTask.supported) {
    const relayLastRunAge = relayTask.lastRunAgeMinutes;
    const relayRunningOk = relayTask.status !== "Running" || asNumber(relayLastRunAge, Infinity) <= maxRunningMinutes;
    pushCheck(checks, "local Sporttery relay task installed", relayTask.exists && /Enabled/i.test(relayTask.state || ""), {
      taskName: relayTask.taskName,
      status: relayTask.status || null,
      state: relayTask.state || null,
      command: relayTask.command || null
    }, requireLocalAutomation);
    pushCheck(checks, "local Sporttery relay task recent and not stuck", relayTask.exists
      && Number.isFinite(Number(relayLastRunAge))
      && Number(relayLastRunAge) <= maxTaskAgeMinutes
      && relayRunningOk, {
        status: relayTask.status || null,
        lastResult: relayTask.lastResult || null,
        lastRunTime: relayTask.lastRunTime || null,
        lastRunAgeMinutes: relayLastRunAge,
        maxTaskAgeMinutes,
        maxRunningMinutes,
        nextRunTime: relayTask.nextRunTime || null,
        nextRunInMinutes: relayTask.nextRunInMinutes
      }, requireLocalAutomation);
  } else {
    pushCheck(checks, "local Sporttery relay task installed", true, relayTask, false);
  }

  pushCheck(checks, "cloud sync log recent", log.exists
    && Number.isFinite(Number(log.latestEventAgeMinutes))
    && Number(log.latestEventAgeMinutes) <= maxLogAgeMinutes, {
      path: log.path,
      latestStart: log.latestStart || null,
      latestExit: log.latestExit || null,
      latestEventAgeMinutes: log.latestEventAgeMinutes ?? null,
      maxLogAgeMinutes,
      wafBlocked: Boolean(log.wafBlocked),
      staleSkip: Boolean(log.staleSkip)
    }, requireLocalAutomation);

  pushCheck(checks, "Sporttery relay log recent", relayLog.exists
    && Number.isFinite(Number(relayLog.latestEventAgeMinutes))
    && Number(relayLog.latestEventAgeMinutes) <= maxLogAgeMinutes, {
      path: relayLog.path,
      latestStart: relayLog.latestStart || null,
      latestExit: relayLog.latestExit || null,
      latestEventAgeMinutes: relayLog.latestEventAgeMinutes ?? null,
      maxLogAgeMinutes,
      collectFailed: Boolean(relayLog.collectFailed),
      uploaded: Boolean(relayLog.uploaded),
      remotePrimary: Boolean(relayLog.remotePrimary),
      timedOut: Boolean(relayLog.timedOut)
    }, requireLocalAutomation);

  pushCheck(checks, "remote v1 health reachable", health.status === 200 && health.body?.apiVersion === "v1", {
    status: health.status,
    apiVersion: health.body?.apiVersion || null,
    serviceOk: healthStatus.serviceOk ?? null,
    dataFresh: healthStatus.dataFresh ?? null,
    servingMode: healthStatus.servingMode || null,
    recommendationReliable: healthStatus.recommendationReliable ?? null
  });
  const sqliteCurrentMatches = asNumber(sqlite.counts?.currentMatches, 0);
  const healthReadSource = health.body?.data?.currentRead?.source
    || health.body?.data?.currentReadSource
    || health.body?.data?.dataSource
    || null;
  const sqliteServiceable = sqlite.available === true
    && sqliteCurrentMatches > 0
    && healthReadSource === "sqlite"
    && (sqlite.stale !== true || healthStatus.dataFresh === true || healthStatus.fallbackDataFresh === true);
  pushCheck(checks, "remote sqlite store ready", sqliteServiceable, {
      sqliteAvailable: sqlite.available ?? null,
      sqliteStale: sqlite.stale ?? null,
      dataFresh: healthStatus.dataFresh ?? null,
      fallbackDataFresh: healthStatus.fallbackDataFresh ?? null,
      sqlitePath: sqlite.path || null,
      currentReadSource: healthReadSource,
      counts: sqlite.counts || null
    });
  const localSqlite = readSqliteCounts(localSqliteDbPath);
  const sqliteBehind = sqliteBehindTables(localSqlite.counts, sqlite.counts);
  pushCheck(checks, "cloud sqlite warehouse parity", localSqlite.ok === true
    && sqlite.available === true
    && sqliteBehind.length === 0, {
      requiredByEnv: requireSqliteParity,
      localPath: localSqlite.path || localSqliteDbPath,
      localCounts: localSqlite.counts || null,
      remoteCounts: sqlite.counts || null,
      behindTables: sqliteBehind,
      localReason: localSqlite.reason || null
    }, requireSqliteParity);
  const remoteOddsRows = asNumber(sqlite.counts?.oddsSnapshots, 0);
  const remotePredictionRows = asNumber(sqlite.counts?.predictionSnapshots, 0);
  const minModelOddsRows = Math.floor(remoteOddsRows * modelCoverageMinRatio);
  const minModelPredictionRows = Math.floor(remotePredictionRows * modelCoverageMinRatio);
  const modelCoverageOk = modelEvaluation.status === 200
    && modelEvaluation.body?.ok !== false
    && modelEvaluation.body?.publicView === true
    && (remoteOddsRows === 0 || modelOddsRows >= minModelOddsRows)
    && (remotePredictionRows === 0 || modelPredictionRows >= minModelPredictionRows);
  pushCheck(checks, "remote model evaluation covers sqlite warehouse", modelCoverageOk, {
    status: modelEvaluation.status,
    publicView: modelEvaluation.body?.publicView ?? null,
    generatedAt: modelEvaluation.body?.generatedAt || modelEvaluation.body?.backtest?.generatedAt || null,
    minRatio: modelCoverageMinRatio,
    modelOddsRows,
    remoteOddsRows,
    minModelOddsRows,
    modelPredictionRows,
    remotePredictionRows,
    minModelPredictionRows
  }, requireModelCoverage);
  const oddsCoverageRatio = remoteOddsRows > 0 ? modelOddsRows / remoteOddsRows : 1;
  const predictionCoverageRatio = remotePredictionRows > 0 ? modelPredictionRows / remotePredictionRows : 1;
  const modelCoverageTriggerOk = (remoteOddsRows === 0 || oddsCoverageRatio >= modelCoverageTriggerRatio)
    && (remotePredictionRows === 0 || predictionCoverageRatio >= modelCoverageTriggerRatio);
  pushCheck(checks, "remote model evaluation above catch-up trigger", modelCoverageTriggerOk, {
    triggerRatio: modelCoverageTriggerRatio,
    oddsCoverageRatio: Number(oddsCoverageRatio.toFixed(4)),
    predictionCoverageRatio: Number(predictionCoverageRatio.toFixed(4)),
    modelOddsRows,
    remoteOddsRows,
    modelPredictionRows,
    remotePredictionRows
  }, false);
  pushCheck(checks, "remote recommendations still serviceable", healthStatus.serviceOk === true
    && healthStatus.dataFresh === true
    && healthStatus.recommendationReliable === true
    && (!requirePrimary || healthStatus.servingMode === "primary"), {
      serviceOk: healthStatus.serviceOk ?? null,
      dataFresh: healthStatus.dataFresh ?? null,
      recommendationReliable: healthStatus.recommendationReliable ?? null,
      servingMode: healthStatus.servingMode || null,
      requirePrimary
    });
  pushCheck(checks, "remote source health schema", sourceHealth.status === 200
    && Array.isArray(sourceHealth.body?.sources)
    && sourceHealth.body.sources.length >= 4
    && !sourceHealth.body?.admin, {
      status: sourceHealth.status,
      ok: sourceHealth.body?.ok ?? null,
      sourceIds: (sourceHealth.body?.sources || []).map((source) => source.id),
      errors: sourceHealth.body?.errors || [],
      warnings: sourceHealth.body?.warnings || [],
      servingMode: fallbackCoverage.servingMode || null,
      primaryStale: fallbackCoverage.primaryStale ?? null,
      currentMatches: fallbackCoverage.currentMatches ?? null
    });
  const syncMetaServingMode = syncMetaSourceHealth.servingMode || syncMetaSourceFallback.servingMode || null;
  const syncMetaPrimaryStale = syncMetaSourceHealth.primaryStale ?? syncMetaSourceFallback.primaryStale ?? null;
  const syncMetaFallbackShouldBeActive = syncMetaServingMode && syncMetaServingMode !== "primary"
    ? true
    : syncMetaPrimaryStale === true;
  pushCheck(checks, "remote sync meta fallback semantics", syncMeta.status === 200
    && Boolean(syncMeta.body?.updatedAt)
    && Boolean(syncMeta.body?.sourceHealth)
    && Boolean(syncMeta.body?.sourceFallback)
    && syncMetaSourceFallback.active === syncMetaFallbackShouldBeActive, {
      status: syncMeta.status,
      updatedAt: syncMeta.body?.updatedAt || null,
      servingMode: syncMetaServingMode,
      primaryStale: syncMetaPrimaryStale,
      fallbackActive: syncMetaSourceFallback.active ?? null,
      expectedFallbackActive: syncMetaFallbackShouldBeActive,
      historyGuardActive: syncMeta.body?.sourceHistoryGuard?.active ?? null,
      fallbackReason: syncMetaSourceFallback.reason || syncMetaSourceHealth.fallbackReason || null
    });
  pushCheck(checks, "remote source health exposes relay collector state", Boolean(remoteRelayCollectorState), {
    exists: Boolean(remoteRelayCollectorState),
    consecutiveCollectFailures: remoteRelayCollectorState?.consecutiveCollectFailures ?? null,
    lastCollectOkAt: remoteRelayCollectorState?.lastCollectOkAt || null,
    lastCollectFailedAt: remoteRelayCollectorState?.lastCollectFailedAt || null,
    lastUploadOkAt: remoteRelayCollectorState?.lastUploadOkAt || null,
    lastUploadSnapshotRows: remoteRelayCollectorState?.lastUploadSnapshotRows ?? null,
    lastUploadSnapshotUsableEndpoints: remoteRelayCollectorState?.lastUploadSnapshotUsableEndpoints ?? null,
    lastUploadSnapshotTrusted: remoteRelayCollectorState?.lastUploadSnapshotTrusted ?? null,
    lastUploadTrustLevel: remoteRelayCollectorState?.lastUploadTrustLevel || null,
    lastTrustedUploadAt: remoteRelayCollectorState?.lastTrustedUploadAt || null,
    lastPartialLiveUploadAt: remoteRelayCollectorState?.lastPartialLiveUploadAt || null,
    lastTrustedFallbackAt: remoteRelayCollectorState?.lastTrustedFallbackAt || null,
    fallbackSnapshotCapturedAt: remoteRelayCollectorState?.fallbackSnapshotCapturedAt || null,
    fallbackSnapshotRows: remoteRelayCollectorState?.fallbackSnapshotRows ?? null,
    fallbackSnapshotUsableEndpoints: remoteRelayCollectorState?.fallbackSnapshotUsableEndpoints ?? null,
    lastRemoteServingMode: remoteRelayCollectorState?.lastRemoteServingMode || null,
    lastFailure: remoteRelayCollectorState?.lastFailure || null
  }, false);
  pushCheck(checks, "local relay snapshot fresh", relay.fresh === true, {
    path: relay.path,
    capturedAt: relay.capturedAt || null,
    ageMinutes: relay.ageMinutes ?? null,
    maxAgeMinutes: relay.maxAgeMinutes ?? null,
    rows: relay.rows ?? null,
    usableEndpoints: relay.usableEndpoints ?? null,
    transport: relay.transport || null,
    producerHost: relay.producerHost || null,
    errorClasses: relay.errorClasses || null,
    exists: relay.exists
  }, requireLocalRelayFresh);

  pushCheck(checks, "Sporttery relay last failed collection classified", true, {
    path: relayFailure.path,
    exists: relayFailure.exists,
    capturedAt: relayFailure.capturedAt || null,
    ageMinutes: relayFailure.ageMinutes ?? null,
    transport: relayFailure.transport || null,
    errors: relayFailure.errors ?? null,
    errorClasses: relayFailure.errorClasses || null,
    wafBlocked: relayFailure.wafBlocked ?? null,
    sampleErrors: relayFailure.sampleErrors || []
  }, false);
  pushCheck(checks, "Sporttery relay consecutive collection failures below threshold", relayState.exists
    && relayState.ok === true, {
      path: relayState.path,
      exists: relayState.exists,
      updatedAt: relayState.updatedAt || null,
      updatedAgeMinutes: relayState.updatedAgeMinutes ?? null,
      consecutiveCollectFailures: relayState.consecutiveCollectFailures ?? null,
      maxConsecutiveCollectFailures: relayState.maxConsecutiveCollectFailures ?? null,
      lastCollectOkAt: relayState.lastCollectOkAt || null,
      lastCollectFailedAt: relayState.lastCollectFailedAt || null,
      lastUploadOkAt: relayState.lastUploadOkAt || null,
      lastUploadSnapshotRows: relayState.lastUploadSnapshotRows ?? null,
      lastUploadSnapshotUsableEndpoints: relayState.lastUploadSnapshotUsableEndpoints ?? null,
      lastUploadSnapshotTrusted: relayState.lastUploadSnapshotTrusted ?? null,
      lastUploadTrustLevel: relayState.lastUploadTrustLevel || null,
      lastTrustedUploadAt: relayState.lastTrustedUploadAt || null,
      lastPartialLiveUploadAt: relayState.lastPartialLiveUploadAt || null,
      lastTrustedFallbackAt: relayState.lastTrustedFallbackAt || null,
      fallbackSnapshotCapturedAt: relayState.fallbackSnapshotCapturedAt || null,
      fallbackSnapshotRows: relayState.fallbackSnapshotRows ?? null,
      fallbackSnapshotUsableEndpoints: relayState.fallbackSnapshotUsableEndpoints ?? null,
      lastRemotePrimaryAt: relayState.lastRemotePrimaryAt || null,
      lastRemoteServingMode: relayState.lastRemoteServingMode || null,
      lastFailure: relayState.lastFailure || null
    }, false);
  const relayNeedsProxy = relay.transport === "direct"
    && (relayFailure.wafBlocked === true || sportteryEgress.status === "blocked" || sportteryEgress.summary?.wafBlocked === true);
  const relayRecommendedAction = relayNeedsProxy
    ? "Configure SPORTTERY_OUTBOUND_PROXY on the server or a dedicated Sporttery collector, or move that collector to a stable Sporttery-reachable network, then run npm run verify:sporttery-egress and npm run sync:sporttery-relay-push. Keep local PC automation optional."
    : null;
  pushCheck(checks, "Sporttery relay egress action", !relayNeedsProxy, {
    needsProxy: relayNeedsProxy,
    relayTransport: relay.transport || null,
    remoteSportteryEgressStatus: sportteryEgress.status || null,
    remoteSportteryEgressWafBlocked: sportteryEgress.summary?.wafBlocked ?? null,
    relayLastFailureWafBlocked: relayFailure.wafBlocked ?? null,
    recommendedAction: relayRecommendedAction
  }, false);

  const requiredOk = checks.filter((check) => check.required !== false).every((check) => check.ok);
  const watch = [];
  if (sourceHealth.body?.ok === false || fallbackCoverage.servingMode !== "primary") watch.push("remote-source-not-primary");
  if (sportteryEgress.status === "blocked" || sportteryEgress.summary?.wafBlocked === true) watch.push("sporttery-egress-blocked");
  if (relay.exists && relay.fresh === false) watch.push("local-relay-stale");
  if (log.wafBlocked || log.staleSkip) watch.push("collector-recently-blocked");
  if (relayLog.collectFailed) watch.push("relay-collector-recently-blocked");
  if (relayFailure.wafBlocked) watch.push("relay-collector-waf-blocked");
  if (!remoteRelayCollectorState) watch.push("remote-relay-collector-state-missing");
  if (relayState.exists && relayState.ok === false) watch.push("relay-collector-consecutive-failures");
  if (relay.transport === "direct" && (sportteryEgress.status === "blocked" || relayFailure.wafBlocked)) {
    watch.push("relay-collector-direct-egress");
  }
  if (relayLog.timedOut) watch.push("relay-collector-timeout");
  if (relayLog.exists && relayLog.uploaded === false && !relayLog.collectFailed && !relayLog.timedOut) {
    watch.push("relay-upload-not-seen-in-log");
  }
  if (task.supported && task.status === "Running") watch.push("local-task-currently-running");
  if (relayTask.supported && relayTask.status === "Running") watch.push("local-relay-task-currently-running");
  if (!modelCoverageOk) watch.push("model-evaluation-behind-sqlite");
  if (!modelCoverageTriggerOk) watch.push("model-evaluation-needs-catch-up");
  console.log(JSON.stringify({
    ok: requiredOk,
    verifier: verifierName,
    status: requiredOk ? (watch.length ? "watch" : "healthy") : "failed",
    checkedAt: new Date().toISOString(),
    baseUrl: baseUrl.origin,
    summary: {
      taskStatus: task.status || null,
      taskLastResult: task.lastResult || null,
      taskLastRunAgeMinutes: task.lastRunAgeMinutes ?? null,
      serverPrimaryMode,
      requireLocalAutomation,
      localDataPushRequired: process.env.LOCAL_DATA_PUSH_REQUIRED || null,
      cloudSyncRequired: process.env.CLOUD_SYNC_REQUIRED || null,
      relayTaskStatus: relayTask.status || null,
      relayTaskLastResult: relayTask.lastResult || null,
      relayTaskLastRunAgeMinutes: relayTask.lastRunAgeMinutes ?? null,
      remoteServingMode: healthStatus.servingMode || null,
      remoteRecommendationReliable: healthStatus.recommendationReliable ?? null,
      remoteCurrentReadSource: healthReadSource,
      sourceHealthOk: sourceHealth.body?.ok ?? null,
      remoteSportteryEgressStatus: sportteryEgress.status || null,
      remoteSportteryEgressWafBlocked: sportteryEgress.summary?.wafBlocked ?? null,
      sqliteParityBehindTables: sqliteBehind,
      localSqlitePredictionSnapshots: localSqlite.counts?.predictionSnapshots ?? null,
      remoteSqlitePredictionSnapshots: sqlite.counts?.predictionSnapshots ?? null,
      remoteModelEvaluationGeneratedAt: modelEvaluation.body?.generatedAt || modelEvaluation.body?.backtest?.generatedAt || null,
      remoteModelOddsRows: modelOddsRows,
      remoteModelPredictionRows: modelPredictionRows,
      remoteModelOddsCoverageRatio: Number(oddsCoverageRatio.toFixed(4)),
      remoteModelPredictionCoverageRatio: Number(predictionCoverageRatio.toFixed(4)),
      modelCoverageTriggerRatio,
      localRelayFresh: relay.fresh ?? null,
      localRelayAgeMinutes: relay.ageMinutes ?? null,
      localRelayTransport: relay.transport || null,
      relayConsecutiveCollectFailures: relayState.consecutiveCollectFailures ?? null,
      remoteRelayConsecutiveCollectFailures: remoteRelayCollectorState?.consecutiveCollectFailures ?? null,
      relayMaxConsecutiveCollectFailures: relayState.maxConsecutiveCollectFailures ?? null,
      relayLastUploadTrustLevel: relayState.lastUploadTrustLevel || null,
      relayLastTrustedUploadAt: relayState.lastTrustedUploadAt || null,
      relayLastPartialLiveUploadAt: relayState.lastPartialLiveUploadAt || null,
      remoteRelayLastUploadTrustLevel: remoteRelayCollectorState?.lastUploadTrustLevel || null,
      relayLastTrustedFallbackAt: relayState.lastTrustedFallbackAt || null,
      relayFallbackSnapshotCapturedAt: relayState.fallbackSnapshotCapturedAt || null,
      relayFallbackSnapshotRows: relayState.fallbackSnapshotRows ?? null,
      relayFallbackSnapshotUsableEndpoints: relayState.fallbackSnapshotUsableEndpoints ?? null,
      remoteRelayLastTrustedFallbackAt: remoteRelayCollectorState?.lastTrustedFallbackAt || null,
      relayLastFailureAgeMinutes: relayFailure.ageMinutes ?? null,
      relayLastFailureWafBlocked: relayFailure.wafBlocked ?? null,
      sportteryRelayNeedsProxy: relayNeedsProxy,
      sportteryRelayRecommendedAction: relayRecommendedAction,
      watch
    },
    checks
  }, null, 2));
  if (!requiredOk) process.exitCode = 1;
};

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: error.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
