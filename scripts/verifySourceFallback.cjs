const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { DatabaseSync, backup: backupSqlite } = require("node:sqlite");
const { acquireSyncLock, readLockInfo } = require("../server/syncLock.cjs");

const rootDir = path.resolve(__dirname, "..");
const productionSyncLockDir = path.join(rootDir, "server-data", "locks", "sync.lock");
const syncLockWaitMs = Math.max(0, Number(process.env.FALLBACK_VERIFY_SYNC_LOCK_WAIT_MS || 30_000));
const tempDir = path.join(rootDir, ".codex-tmp", `source-fallback-${Date.now()}`);
const isolatedMissingRelaySnapshot = path.join(tempDir, "missing-sporttery-relay-snapshot.json");
const sourceSqlitePath = path.join(rootDir, "server-data", "football.db");
const isolatedStoreDir = path.join(tempDir, "isolated-server-data");
const isolatedSqlitePath = path.join(isolatedStoreDir, "football.db");
const isolatedUnresolvedArchivePath = path.join(isolatedStoreDir, "matches-unresolved-archive.json");
const sqliteIsolationEnv = Object.freeze({
  SERVER_STORE_DIR: isolatedStoreDir,
  DATA_STORE_DIR: isolatedStoreDir,
  DATASTORE_SQLITE_PATH: isolatedSqlitePath,
  UNRESOLVED_MATCH_ARCHIVE_PATH: isolatedUnresolvedArchivePath
});
const port = Number(process.env.FALLBACK_VERIFY_PORT || 8830);
let activePort = port;
const adminToken = process.env.FALLBACK_VERIFY_ADMIN_TOKEN || "fallback-verify-admin";
const accessSecret = process.env.FALLBACK_VERIFY_ACCESS_SECRET || "fallback-verify-secret";

const publishedFiles = [
  "public/matches.json",
  "public/odds-history.json",
  "public/data/matches-current.json",
  "public/data/matches-history.json",
  "public/data/external-signals.json",
  "public/data/pre-match-signals.json",
  "public/data/team-index.json",
  "public/data/odds-history.json",
  "public/data/prediction-snapshots.json",
  "public/data/post-match-reviews.json",
  "public/data/model-calibration.json",
  "public/data/model-strategy.json",
  "public/data/gpt-predictions.json",
  "public/data/sync-meta.json",
];

const privateStoreFiles = [
  "server-data/matches-unresolved-archive.json",
  "server-data/model-strategy.json"
];

// Keep this in lockstep with syncData.cjs mirrorPublishedDataToDist(). Missing
// files are intentional manifest entries: the verifier must remove a file that
// was created by the test and recreate a file that syncData deleted.
const distFiles = [
  "dist/matches.json",
  "dist/odds-history.json",
  "dist/data/matches-current.json",
  "dist/data/matches-history.json",
  "dist/data/odds-history.json",
  "dist/data/post-match-reviews.json",
  "dist/data/external-signals.json",
  "dist/data/five-hundred-details.json",
  "dist/data/pre-match-signals.json",
  "dist/data/prediction-snapshots.json",
  "dist/data/model-calibration.json",
  "dist/data/model-strategy.json",
  "dist/data/api-football-cache.json",
  "dist/data/api-football-meta.json",
  "dist/data/gpt-predictions.json",
  "dist/data/web-consensus-signals.json",
  "dist/data/weather-locations.json",
  "dist/data/worldcup-kimi-dataset.json",
  "dist/data/team-index.json",
  "dist/data/sync-meta.json",
  "dist/data/model-evaluation.json"
];

const managedFiles = [...new Set([...publishedFiles, ...privateStoreFiles, ...distFiles])];
const restoreAttempts = Math.max(1, Number(process.env.FALLBACK_VERIFY_RESTORE_ATTEMPTS || 12));
const restoreRetryDelayMs = Math.max(25, Number(process.env.FALLBACK_VERIFY_RESTORE_RETRY_MS || 150));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readJson = (relativePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = async (relativePath, payload) => {
  const filePath = path.join(rootDir, relativePath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const backdateObject = (value, isoTime) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next = { ...value };
  if (Object.prototype.hasOwnProperty.call(next, "updatedAt")) next.updatedAt = isoTime;
  if (Object.prototype.hasOwnProperty.call(next, "capturedAt")) next.capturedAt = isoTime;
  if (Object.prototype.hasOwnProperty.call(next, "finishedAt")) next.finishedAt = isoTime;
  return next;
};

const backdateFallbackFreshness = async (ageSeconds) => {
  const isoTime = new Date(Date.now() - ageSeconds * 1000).toISOString();
  const syncMeta = readJson("public/data/sync-meta.json", null);
  if (syncMeta && typeof syncMeta === "object") {
    const next = {
      ...syncMeta,
      updatedAt: isoTime,
      capturedAt: isoTime,
      sourceHealth: backdateObject(syncMeta.sourceHealth, isoTime),
      api: {
        ...(syncMeta.api || {}),
        freshnessTime: isoTime,
        currentFreshnessTime: isoTime,
        sourceUpdatedAt: isoTime
      }
    };
    await writeJson("public/data/sync-meta.json", next);
  }

  const external = readJson("public/data/external-signals.json", null);
  if (external && typeof external === "object") {
    const nextSources = Object.fromEntries(Object.entries(external.sources || {}).map(([key, value]) => [
      key,
      backdateObject(value, isoTime)
    ]));
    await writeJson("public/data/external-signals.json", {
      ...external,
      updatedAt: isoTime,
      sources: nextSources
    });
  }

  const preMatch = readJson("public/data/pre-match-signals.json", null);
  if (preMatch && typeof preMatch === "object") {
    await writeJson("public/data/pre-match-signals.json", {
      ...preMatch,
      updatedAt: isoTime
    });
  }

  await runCommand(process.execPath, ["scripts/exportDataStoreSqlite.cjs"], sqliteIsolationEnv);
  return isoTime;
};

const sha256File = (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  stream.on("error", reject);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest("hex")));
});

const manifestSha256 = (entries) => crypto.createHash("sha256").update(JSON.stringify(
  entries.map((entry) => ({
    relativePath: entry.relativePath,
    exists: Boolean(entry.exists),
    bytes: entry.exists ? Number(entry.bytes || 0) : 0,
    sha256: entry.exists ? entry.sha256 : null
  }))
)).digest("hex");

const errorText = (error) => error?.stack || error?.message || String(error);

const assertSyncLockOwned = async (syncLock, phase) => {
  const current = await readLockInfo(syncLock.lockDir);
  const owned = current?.pid === process.pid
    && current?.owner === syncLock.info?.owner
    && current?.source === syncLock.info?.source
    && current?.startedAt === syncLock.info?.startedAt;
  if (!owned) {
    throw new Error(`production sync lock ownership lost during ${phase}: ${JSON.stringify(current)}`);
  }
  return {
    phase,
    owned: true,
    owner: current.owner,
    source: current.source,
    pid: current.pid,
    startedAt: current.startedAt
  };
};

const assertPathInside = (parentPath, childPath, label) => {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${parentPath}: ${childPath}`);
  }
};

const inspectSqlite = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 60000");
    const quickCheckRows = db.prepare("PRAGMA quick_check").all();
    const quickCheck = quickCheckRows.map((row) => String(row.quick_check || ""));
    const ok = quickCheck.length === 1 && quickCheck[0] === "ok";
    if (!ok) {
      throw new Error(`SQLite quick_check failed for ${dbPath}: ${JSON.stringify(quickCheck)}`);
    }
    return {
      ok,
      quickCheck,
      journalMode: String(db.prepare("PRAGMA journal_mode").get()?.journal_mode || ""),
      pageCount: Number(db.prepare("PRAGMA page_count").get()?.page_count || 0),
      userVersion: Number(db.prepare("PRAGMA user_version").get()?.user_version || 0)
    };
  } finally {
    db.close();
  }
};

const seedIsolatedStoreFile = async (relativePath) => {
  const source = path.join(rootDir, relativePath);
  if (!fs.existsSync(source)) return { relativePath, copied: false, reason: "source-missing" };
  const target = path.join(isolatedStoreDir, path.basename(relativePath));
  await fsp.copyFile(source, target);
  return {
    relativePath,
    copied: true,
    bytes: (await fsp.stat(target)).size,
    sha256: await sha256File(target)
  };
};

const createSqliteIsolation = async () => {
  assertPathInside(tempDir, isolatedStoreDir, "isolated SQLite store");
  assertPathInside(tempDir, isolatedSqlitePath, "isolated SQLite database");
  if (path.resolve(sourceSqlitePath) === path.resolve(isolatedSqlitePath)) {
    throw new Error("source fallback verifier SQLite database is not isolated");
  }
  if (!fs.existsSync(sourceSqlitePath)) {
    throw new Error(`source SQLite database is missing: ${sourceSqlitePath}`);
  }

  await fsp.mkdir(isolatedStoreDir, { recursive: true });
  const seededFiles = [];
  for (const relativePath of privateStoreFiles) {
    seededFiles.push(await seedIsolatedStoreFile(relativePath));
  }

  // SQLite's online backup API reads a transactionally consistent snapshot,
  // including committed WAL state, into a standalone test database. Every
  // mutating child process uses this copy; the live db/wal/shm triplet is never
  // copied back or restored file-by-file.
  const sourceDb = new DatabaseSync(sourceSqlitePath, { readOnly: true });
  let pagesCopied = 0;
  let sourceMetadata = null;
  try {
    sourceDb.exec("PRAGMA busy_timeout = 60000");
    sourceMetadata = {
      journalMode: String(sourceDb.prepare("PRAGMA journal_mode").get()?.journal_mode || ""),
      pageCount: Number(sourceDb.prepare("PRAGMA page_count").get()?.page_count || 0),
      userVersion: Number(sourceDb.prepare("PRAGMA user_version").get()?.user_version || 0)
    };
    pagesCopied = Number(await backupSqlite(sourceDb, isolatedSqlitePath));
  } finally {
    sourceDb.close();
  }

  const initialIntegrity = inspectSqlite(isolatedSqlitePath);
  const initialStat = await fsp.stat(isolatedSqlitePath);
  return {
    mode: "node-sqlite-online-backup-isolated-writes",
    source: path.relative(rootDir, sourceSqlitePath),
    isolated: path.relative(rootDir, isolatedSqlitePath),
    sourceMetadata,
    pagesCopied,
    initialBytes: initialStat.size,
    initialSha256: await sha256File(isolatedSqlitePath),
    initialIntegrity,
    seededFiles,
    sourceTripletRestoreRequired: false,
    mutatingChildrenUseIsolatedDatabase: true
  };
};

const verifySqliteIsolation = async (isolation) => {
  assertPathInside(tempDir, isolatedSqlitePath, "isolated SQLite database");
  const finalIntegrity = inspectSqlite(isolatedSqlitePath);
  return {
    ...isolation,
    finalBytes: (await fsp.stat(isolatedSqlitePath)).size,
    finalIntegrity,
    childrenStoppedBeforeInspection: serverProcess === null,
    sourceTripletRestoreRequired: false,
    mutatingChildrenUseIsolatedDatabase: true
  };
};

const retryDelay = (attempt) => sleep(Math.min(1200, restoreRetryDelayMs * attempt));

const snapshotFile = async (relativePath) => {
  const source = path.join(rootDir, relativePath);
  const target = path.join(tempDir, relativePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  if (!fs.existsSync(source)) {
    await fsp.writeFile(`${target}.missing`, "");
    return { relativePath, exists: false, bytes: 0, sha256: null };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= restoreAttempts; attempt += 1) {
    try {
      await fsp.copyFile(source, target);
      const [sourceStat, targetStat, sourceSha256, targetSha256] = await Promise.all([
        fsp.stat(source),
        fsp.stat(target),
        sha256File(source),
        sha256File(target)
      ]);
      if (sourceStat.size !== targetStat.size || sourceSha256 !== targetSha256) {
        throw new Error("source changed while the fallback verifier backup was being captured");
      }
      return {
        relativePath,
        exists: true,
        bytes: targetStat.size,
        sha256: targetSha256
      };
    } catch (error) {
      lastError = error;
      if (attempt < restoreAttempts) await retryDelay(attempt);
    }
  }
  throw new Error(`source fallback backup failed for ${relativePath} after ${restoreAttempts} attempts: ${errorText(lastError)}`);
};

const backupFiles = async () => {
  const manifest = [];
  for (const relativePath of managedFiles) manifest.push(await snapshotFile(relativePath));
  return manifest;
};

const verifyRestoredFile = async (entry) => {
  const target = path.join(rootDir, entry.relativePath);
  if (!entry.exists) {
    return {
      relativePath: entry.relativePath,
      exists: false,
      ok: !fs.existsSync(target),
      reason: fs.existsSync(target) ? "file should be absent" : null
    };
  }
  if (!fs.existsSync(target)) {
    return { relativePath: entry.relativePath, exists: false, ok: false, reason: "restored file is missing" };
  }
  const stat = await fsp.stat(target);
  const sha256 = await sha256File(target);
  const ok = stat.size === entry.bytes && sha256 === entry.sha256;
  return {
    relativePath: entry.relativePath,
    exists: true,
    bytes: stat.size,
    sha256,
    ok,
    reason: ok ? null : "restored size or SHA-256 does not match the pre-test snapshot"
  };
};

const restoreEntry = async (entry) => {
  const source = path.join(tempDir, entry.relativePath);
  const target = path.join(rootDir, entry.relativePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  let lastError = null;

  for (let attempt = 1; attempt <= restoreAttempts; attempt += 1) {
    try {
      if (entry.exists) {
        await fsp.copyFile(source, target);
      } else {
        await fsp.rm(target, { force: true });
      }
      const verification = await verifyRestoredFile(entry);
      if (!verification.ok) throw new Error(verification.reason || "restore verification failed");
      return { ...verification, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < restoreAttempts) await retryDelay(attempt);
    }
  }
  throw new Error(`source fallback restore failed for ${entry.relativePath} after ${restoreAttempts} attempts: ${errorText(lastError)}`);
};

const restoreFiles = async (manifest) => {
  const restored = [];
  const errors = [];
  for (const entry of manifest) {
    try {
      restored.push(await restoreEntry(entry));
    } catch (error) {
      errors.push(error);
    }
  }

  const verification = [];
  for (const entry of manifest) {
    try {
      verification.push(await verifyRestoredFile(entry));
    } catch (error) {
      verification.push({
        relativePath: entry.relativePath,
        ok: false,
        reason: errorText(error)
      });
    }
  }
  for (const failure of verification.filter((entry) => !entry.ok)) {
    errors.push(new Error(`${failure.relativePath}: ${failure.reason || "final restore verification failed"}`));
  }
  const snapshotSha256 = manifestSha256(manifest);
  const restoredSha256 = manifestSha256(verification);
  if (snapshotSha256 !== restoredSha256) {
    errors.push(new Error(`restored manifest SHA-256 ${restoredSha256} does not match pre-test snapshot ${snapshotSha256}`));
  }
  if (errors.length) {
    throw new AggregateError(errors, `source fallback restoration failed for ${errors.length} check(s)`);
  }
  return {
    files: manifest.length,
    restored: restored.length,
    verified: verification.filter((entry) => entry.ok).length,
    sha256Verified: verification.filter((entry) => entry.exists && entry.ok).length,
    absentVerified: verification.filter((entry) => !entry.exists && entry.ok).length,
    snapshotSha256,
    restoredSha256,
    manifestMatches: snapshotSha256 === restoredSha256
  };
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
    const req = http.request(`http://127.0.0.1:${activePort}${pathname}`, {
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
const startServer = async (options = {}) => {
  activePort = Number(options.port || port);
  serverProcess = spawn(process.execPath, ["server/index.cjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...(options.env || {}),
      ...sqliteIsolationEnv,
      HOST: "127.0.0.1",
      PORT: String(activePort),
      ADMIN_TOKEN: adminToken,
      ACCESS_CODE_ADMIN_TOKEN: adminToken,
      ACCESS_CODE_SECRET: accessSecret,
      DATASTORE_READ_SOURCE: "sqlite",
      ENABLE_SYNC_CRON: "0",
      ENABLE_GPT_CRON: "0",
      SOURCE_MAX_AGE_MINUTES: process.env.FALLBACK_VERIFY_SOURCE_MAX_AGE_MINUTES || "1440",
      V1_FALLBACK_MAX_STALE_SECONDS: options.env?.V1_FALLBACK_MAX_STALE_SECONDS
        || process.env.FALLBACK_VERIFY_MAX_STALE_SECONDS
        || "86400",
      SPORTTERY_RELAY_SNAPSHOT: isolatedMissingRelaySnapshot,
      SPORTTERY_RELAY_SNAPSHOT_PATH: isolatedMissingRelaySnapshot
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let logs = "";
  let lastProbe = null;
  serverProcess.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  for (let index = 0; index < 40; index += 1) {
    await sleep(250);
    try {
      const health = await request("GET", "/api/v1/health");
      lastProbe = {
        status: health.status,
        apiVersion: health.body?.apiVersion || null,
        ok: health.body?.ok ?? null,
        error: health.body?.error || null
      };
      if (health.body?.apiVersion === "v1") return;
    } catch (error) {
      lastProbe = { error: error.message || String(error) };
      // Keep waiting until the server accepts requests.
    }
    if (serverProcess.exitCode !== null) break;
  }
  throw new Error(`fallback verify server did not start: ${JSON.stringify(lastProbe)} ${logs.slice(-1200)}`);
};

const stopServer = async () => {
  if (!serverProcess) return { stopped: false, alreadyExited: true };
  const processToStop = serverProcess;
  serverProcess = null;
  if (processToStop.exitCode !== null || processToStop.signalCode !== null) {
    return { stopped: false, alreadyExited: true };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let forceTimer = null;
    let failTimer = null;
    const finish = (result, error = null) => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (failTimer) clearTimeout(failTimer);
      processToStop.removeListener("exit", onExit);
      processToStop.removeListener("error", onError);
      if (error) reject(error);
      else resolve(result);
    };
    const onExit = (code, signal) => finish({ stopped: true, code, signal });
    const onError = (error) => finish(null, error);
    processToStop.once("exit", onExit);
    processToStop.once("error", onError);

    try {
      processToStop.kill("SIGTERM");
    } catch (error) {
      finish(null, error);
      return;
    }
    if (settled) return;
    forceTimer = setTimeout(() => {
      if (processToStop.exitCode === null && processToStop.signalCode === null) {
        try {
          processToStop.kill("SIGKILL");
        } catch (error) {
          finish(null, error);
        }
      }
    }, 1500);
    failTimer = setTimeout(() => {
      finish(null, new Error(`fallback verify server pid ${processToStop.pid} did not exit before restore`));
    }, 5000);
  });
};

const runWithSyncLock = async (syncLock) => {
  const checks = [];
  const lockAtSnapshot = await assertSyncLockOwned(syncLock, "snapshot-start");
  let backupManifest = null;
  try {
    backupManifest = await backupFiles();
  } catch (error) {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "source fallback snapshot and temp cleanup both failed");
    }
    throw error;
  }
  let runError = null;
  let result = null;
  let sqliteIsolation = null;
  try {
    sqliteIsolation = await createSqliteIsolation();
    pushCheck(checks, "sqlite online backup is consistent and isolated", sqliteIsolation.initialIntegrity.ok
      && path.resolve(sqliteIsolationEnv.DATASTORE_SQLITE_PATH) === path.resolve(isolatedSqlitePath)
      && path.resolve(sqliteIsolationEnv.DATASTORE_SQLITE_PATH) !== path.resolve(sourceSqlitePath), {
      mode: sqliteIsolation.mode,
      source: sqliteIsolation.source,
      isolated: sqliteIsolation.isolated,
      quickCheck: sqliteIsolation.initialIntegrity.quickCheck,
      pagesCopied: sqliteIsolation.pagesCopied
    });

    const beforeCurrent = readJson("public/data/matches-current.json", []);
    const beforeHistory = readJson("public/data/matches-history.json", []);
    const beforeMeta = readJson("public/data/sync-meta.json", null);
    pushCheck(checks, "baseline data available", beforeCurrent.length > 0 && beforeHistory.length > 0, {
      current: beforeCurrent.length,
      history: beforeHistory.length,
      version: beforeMeta?.updatedAt || null
    });

    await runCommand(process.execPath, ["scripts/syncData.cjs"], {
      ...sqliteIsolationEnv,
      SKIP_SPORTTERY_FETCH: "1",
      ENABLE_500_SYNC: "0",
      ENABLE_WEATHER_SYNC: "0",
      ENABLE_PREMATCH_SIGNALS_SYNC: "0",
      SPORTTERY_RELAY_SNAPSHOT: isolatedMissingRelaySnapshot,
      SPORTTERY_RELAY_SNAPSHOT_PATH: isolatedMissingRelaySnapshot
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

    const withinWindowFreshnessTime = await backdateFallbackFreshness(2 * 60);
    await startServer();

    const health = await request("GET", "/api/v1/health");
    const sqlite = health.body?.storage?.sqlite || null;
    pushCheck(checks, "fallback sqlite remains readable", health.status === 200 && sqlite?.available && !sqlite?.stale, {
      status: health.status,
      sqliteAvailable: Boolean(sqlite?.available),
      sqliteStale: Boolean(sqlite?.stale),
      syncMetaUpdatedAt: sqlite?.syncMetaUpdatedAt || null
    });
    pushCheck(checks, "fallback health stays serviceable but degraded", health.status === 200
      && health.body?.ok === true
      && health.body?.status?.sourceDataFresh === false
      && health.body?.status?.fallbackDataFresh === true
      && health.body?.status?.fallbackWithinReliableWindow === true
      && health.body?.status?.servingMode === "fallback-degraded", {
      status: health.status,
      ok: health.body?.ok ?? null,
      dataFresh: health.body?.status?.dataFresh ?? null,
      sourceDataFresh: health.body?.status?.sourceDataFresh ?? null,
      fallbackDataFresh: health.body?.status?.fallbackDataFresh ?? null,
      fallbackWithinReliableWindow: health.body?.status?.fallbackWithinReliableWindow ?? null,
      fallbackAgeSeconds: health.body?.status?.fallbackAgeSeconds ?? null,
      fallbackMaxAgeSeconds: health.body?.status?.fallbackMaxAgeSeconds ?? null,
      withinWindowFreshnessTime,
      servingMode: health.body?.status?.servingMode || null,
      recommendationReliable: health.body?.status?.recommendationReliable ?? null
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

    await stopServer();
    const expiredFreshnessTime = await backdateFallbackFreshness(15 * 60);
    await startServer({
      port: port + 1,
      env: { V1_FALLBACK_MAX_STALE_SECONDS: "300" }
    });
    const expiredHealth = await request("GET", "/api/v1/health");
    pushCheck(checks, "fallback reliability window expires recommendation", expiredHealth.status === 200
      && expiredHealth.body?.ok === false
      && expiredHealth.body?.status?.dataFresh === false
      && expiredHealth.body?.status?.fallbackDataFresh === false
      && expiredHealth.body?.status?.fallbackWithinReliableWindow === false
      && expiredHealth.body?.status?.recommendationReliable === false, {
      status: expiredHealth.status,
      ok: expiredHealth.body?.ok ?? null,
      dataFresh: expiredHealth.body?.status?.dataFresh ?? null,
      fallbackDataFresh: expiredHealth.body?.status?.fallbackDataFresh ?? null,
      fallbackWithinReliableWindow: expiredHealth.body?.status?.fallbackWithinReliableWindow ?? null,
      fallbackAgeSeconds: expiredHealth.body?.status?.fallbackAgeSeconds ?? null,
      fallbackMaxAgeSeconds: expiredHealth.body?.status?.fallbackMaxAgeSeconds ?? null,
      expiredFreshnessTime,
      recommendationReliable: expiredHealth.body?.status?.recommendationReliable ?? null
    });

    result = {
      ok: checks.every((check) => check.ok),
      checkedAt: new Date().toISOString(),
      port,
      checks
    };
  } catch (error) {
    runError = error;
  }

  const cleanupErrors = [];
  try {
    await stopServer();
  } catch (error) {
    cleanupErrors.push(new Error(`fallback verify server shutdown failed: ${errorText(error)}`));
  }

  let sqliteVerification = null;
  if (sqliteIsolation) {
    try {
      sqliteVerification = await verifySqliteIsolation(sqliteIsolation);
    } catch (error) {
      cleanupErrors.push(new Error(`isolated SQLite verification failed: ${errorText(error)}`));
    }
  }

  let lockBeforeRestore = null;
  try {
    lockBeforeRestore = await assertSyncLockOwned(syncLock, "before-restore");
  } catch (error) {
    cleanupErrors.push(error);
  }

  let restoration = null;
  let lockAfterRestore = null;
  if (lockBeforeRestore) {
    try {
      restoration = await restoreFiles(backupManifest);
      lockAfterRestore = await assertSyncLockOwned(syncLock, "after-restore");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (!cleanupErrors.length) {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(new Error(`fallback verify temp cleanup failed: ${errorText(error)}`));
    }
  }

  if (runError || cleanupErrors.length) {
    const errors = [runError, ...cleanupErrors].filter(Boolean);
    throw new AggregateError(errors, `source fallback verification failed with ${errors.length} error(s)`);
  }

  result.sqliteIsolation = sqliteVerification;
  result.restoration = {
    ...restoration,
    tempDirectoryRemoved: !fs.existsSync(tempDir)
  };
  result.syncLock = {
    implementation: "server/syncLock.cjs",
    lockDir: path.relative(rootDir, syncLock.lockDir),
    owner: syncLock.info.owner,
    source: syncLock.info.source,
    acquiredAt: syncLock.info.startedAt,
    failClosed: true,
    criticalSection: "snapshot-through-restore",
    ownershipChecks: [lockAtSnapshot, lockBeforeRestore, lockAfterRestore],
    heldAcrossSnapshotTestRestore: [lockAtSnapshot, lockBeforeRestore, lockAfterRestore]
      .every((entry) => entry?.owned === true)
  };
  return result;
};

const run = async () => {
  const lockAttemptStartedAt = Date.now();
  let syncLock = null;
  let result = null;
  let runError = null;
  let releaseError = null;
  let releaseEvidence = null;
  try {
    syncLock = await acquireSyncLock({
      lockDir: productionSyncLockDir,
      owner: "verify-source-fallback",
      source: "source-fallback-critical-section",
      waitMs: syncLockWaitMs
    });
    if (!syncLock.acquired) {
      throw new Error(`production sync lock unavailable; refusing to snapshot or mutate data: ${JSON.stringify({
        reason: syncLock.reason,
        lockDir: syncLock.lockDir,
        holder: syncLock.info || null,
        ownerStatus: syncLock.owner || null,
        ageMs: syncLock.ageMs ?? null,
        waitMs: syncLockWaitMs
      })}`);
    }
    result = await runWithSyncLock(syncLock);
  } catch (error) {
    runError = error;
  } finally {
    if (syncLock?.acquired && typeof syncLock.release === "function") {
      try {
        await syncLock.release();
        const current = await readLockInfo(syncLock.lockDir);
        if (current?.pid === process.pid) {
          throw new Error(`production sync lock still owned by verifier after release: ${syncLock.lockDir}`);
        }
        releaseEvidence = {
          released: true,
          verifierOwnershipRemoved: true,
          nextOwner: current ? {
            owner: current.owner || null,
            source: current.source || null,
            pid: current.pid || null,
            startedAt: current.startedAt || null
          } : null
        };
      } catch (error) {
        releaseError = error;
      }
    }
  }

  if (runError || releaseError) {
    const errors = [runError, releaseError].filter(Boolean);
    throw new AggregateError(errors, `source fallback lock lifecycle failed with ${errors.length} error(s)`);
  }

  result.syncLock = {
    ...result.syncLock,
    waitMs: syncLockWaitMs,
    waitedMs: Math.max(0, Date.parse(syncLock.info.startedAt) - lockAttemptStartedAt),
    ...releaseEvidence
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
};

run().catch((error) => {
  const printErrorTree = (value, depth = 0) => {
    console.error(`${"  ".repeat(depth)}${errorText(value)}`);
    if (Array.isArray(value?.errors)) {
      for (const nested of value.errors) printErrorTree(nested, depth + 1);
    }
  };
  printErrorTree(error);
  process.exitCode = 1;
});
