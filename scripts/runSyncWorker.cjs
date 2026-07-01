const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { acquireSyncLock } = require("../server/syncLock.cjs");

const rootDir = path.resolve(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const loop = process.env.SYNC_WORKER_LOOP === "1";
const statusOnly = process.env.SYNC_WORKER_STATUS_ONLY === "1" || process.argv.includes("--status");
const baseIntervalMs = Math.max(60, Number(process.env.SYNC_INTERVAL_SECONDS || 300)) * 1000;
const hotIntervalMs = Math.max(60, Number(process.env.HOT_SYNC_INTERVAL_SECONDS || 90)) * 1000;
const hotWindowMinutes = Math.max(15, Number(process.env.HOT_SYNC_WINDOW_MINUTES || 120));
const statusFile = path.join(rootDir, "server-data", "sync-worker-status.json");
const sqliteReadSourceEnabled = process.env.DATASTORE_READ_SOURCE === "sqlite" || process.env.CURRENT_MATCH_SOURCE === "sqlite";
const sqliteExportEnabled = process.env.ENABLE_SQLITE_EXPORT === "1" || sqliteReadSourceEnabled;

const runCommand = (command, args, extraEnv = {}) => new Promise((resolve, reject) => {
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
    stdio: "inherit"
  });
  child.on("error", reject);
  child.on("exit", (code) => {
    const finishedAt = new Date().toISOString();
    if (code === 0) {
      resolve({ ok: true, command, args, startedAt, finishedAt });
      return;
    }
    reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
  });
});

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const readCurrentMatches = () => {
  const matches = readJson(path.join(rootDir, "public", "data", "matches-current.json"), []);
  return Array.isArray(matches) ? matches : [];
};

const compactCadenceMatch = (match, now = Date.now()) => {
  const kickoffMs = Date.parse(match?.kickoffTime || "");
  return {
    id: match?.id || null,
    sourceMatchId: match?.sourceMatchId || null,
    status: match?.status || null,
    kickoffTime: match?.kickoffTime || null,
    minutesToKickoff: Number.isFinite(kickoffMs) ? Math.round((kickoffMs - now) / 60000) : null,
    homeTeamName: match?.homeTeamName || null,
    awayTeamName: match?.awayTeamName || null
  };
};

const describeSyncCadence = () => {
  const matches = readCurrentMatches();
  const now = Date.now();
  const hotWindowMs = hotWindowMinutes * 60 * 1000;
  const liveStatuses = new Set(["LIVE", "IN_PLAY", "FIRST_HALF", "SECOND_HALF", "HALFTIME"]);
  const liveMatches = [];
  const hotMatches = [];
  const upcomingMatches = [];

  for (const match of matches) {
    const status = String(match?.status || "").toUpperCase();
    const kickoff = Date.parse(match?.kickoffTime || "");
    if (liveStatuses.has(status)) liveMatches.push(match);
    if (Number.isFinite(kickoff) && kickoff >= now) {
      upcomingMatches.push(match);
      if (kickoff - now <= hotWindowMs) hotMatches.push(match);
    }
  }

  upcomingMatches.sort((a, b) => Date.parse(a?.kickoffTime || "") - Date.parse(b?.kickoffTime || ""));
  hotMatches.sort((a, b) => Date.parse(a?.kickoffTime || "") - Date.parse(b?.kickoffTime || ""));
  const hot = liveMatches.length > 0 || hotMatches.length > 0;
  const intervalMs = hot ? hotIntervalMs : baseIntervalMs;
  return {
    checkedAt: new Date(now).toISOString(),
    mode: hot ? "hot" : "base",
    reason: liveMatches.length > 0 ? "live-match" : hotMatches.length > 0 ? "near-kickoff" : "normal",
    intervalMs,
    intervalSeconds: Math.round(intervalMs / 1000),
    workflowMinutes: Math.max(1, Math.round(intervalMs / 60000)),
    baseIntervalSeconds: Math.round(baseIntervalMs / 1000),
    hotIntervalSeconds: Math.round(hotIntervalMs / 1000),
    hotWindowMinutes,
    currentMatches: matches.length,
    liveMatches: liveMatches.slice(0, 5).map((match) => compactCadenceMatch(match, now)),
    hotMatches: hotMatches.slice(0, 5).map((match) => compactCadenceMatch(match, now)),
    nextMatch: upcomingMatches[0] ? compactCadenceMatch(upcomingMatches[0], now) : null
  };
};

const runOptional = async (enabled, script, extraEnv = {}) => {
  if (!enabled) return { ok: true, skipped: true, script };
  return runCommand(npmCommand, ["run", script], extraEnv);
};

const writeWorkerStatus = (payload) => {
  const body = {
    version: 1,
    worker: "football-sync-worker",
    ...payload
  };
  writeJson(statusFile, body);
  return body;
};

const runCycle = async (cadence = describeSyncCadence()) => {
  const startedAt = new Date().toISOString();
  const syncLock = await acquireSyncLock({
    owner: "football-sync-worker",
    source: "sync-worker-cycle",
    waitMs: Number(process.env.SYNC_WORKER_LOCK_WAIT_MS || 0)
  });
  if (!syncLock.acquired) {
    return {
      ok: true,
      skipped: true,
      reason: syncLock.reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      cadence,
      lock: {
        owner: syncLock.info?.owner || null,
        source: syncLock.info?.source || null,
        pid: syncLock.info?.pid || null,
        startedAt: syncLock.info?.startedAt || null,
        ageMs: Math.round(syncLock.ageMs || 0)
      }
    };
  }

  try {
    await runOptional(process.env.ENABLE_500_SYNC !== "0", "sync:500");
    await runOptional(process.env.ENABLE_500_DETAILS_SYNC === "1", "sync:500:details");
    await runOptional(process.env.ENABLE_WEATHER_SYNC !== "0", "sync:weather");
    await runOptional(process.env.ENABLE_API_FOOTBALL_SYNC === "1", "sync:api-football");
    await runOptional(process.env.ENABLE_PREMATCH_SIGNALS_SYNC !== "0", "sync:prematch");
    await runCommand("node", ["scripts/syncData.cjs"], {
      SYNC_WORKFLOW_MINUTES: String(cadence.workflowMinutes)
    });
    await runCommand(npmCommand, ["run", "validate:data"]);
    await runCommand(npmCommand, ["run", "validate:sources"], {
      REQUIRE_EXTERNAL_SIGNALS: process.env.REQUIRE_EXTERNAL_SIGNALS === "0" ? "0" : "1"
    });
    await runOptional(process.env.ENABLE_MODEL_BACKTEST_ON_SYNC === "1", "model:backtest");
    await runOptional(process.env.ENABLE_MODEL_STRATEGY_ON_SYNC === "1", "optimize:strategy");
    await runOptional(sqliteExportEnabled, "datastore:sqlite");
    return { ok: true, startedAt, finishedAt: new Date().toISOString(), cadence };
  } finally {
    await syncLock.release();
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (statusOnly) {
    const cadence = describeSyncCadence();
    const status = writeWorkerStatus({
      ok: true,
      type: "sync-worker-status",
      checkedAt: new Date().toISOString(),
      loop,
      cadence
    });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  do {
    const cadence = describeSyncCadence();
    try {
      const result = await runCycle(cadence);
      const nextCadence = describeSyncCadence();
      const nextWakeAt = loop ? new Date(Date.now() + nextCadence.intervalMs).toISOString() : null;
      writeWorkerStatus({
        ok: true,
        type: "sync-worker-cycle",
        checkedAt: new Date().toISOString(),
        loop,
        cadence: nextCadence,
        lastCycle: result,
        nextWakeAt
      });
      console.log(JSON.stringify({ type: "sync-worker-cycle", ...result }, null, 2));
    } catch (error) {
      const nextCadence = describeSyncCadence();
      const nextWakeAt = loop ? new Date(Date.now() + nextCadence.intervalMs).toISOString() : null;
      const failure = {
        type: "sync-worker-failed",
        ok: false,
        at: new Date().toISOString(),
        loop,
        cadence: nextCadence,
        nextWakeAt,
        error: error.message || String(error)
      };
      writeWorkerStatus(failure);
      console.error(JSON.stringify(failure, null, 2));
      if (!loop) process.exitCode = 1;
    }
    if (loop) {
      await sleep(describeSyncCadence().intervalMs);
    }
  } while (loop);
})();
