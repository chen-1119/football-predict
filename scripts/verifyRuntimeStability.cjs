const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getDataStoreStatus } = require("../server/dataStore.cjs");
const { assessOfficialSourceRedundancy } = require("../server/sourceRedundancy.cjs");
const { evaluateSqliteReadRequirement } = require("./checkServerRuntime.cjs");
const {
  runCommand,
  summarizeWorkerError,
  withCycleDuration,
  workerHistoryFields
} = require("./runSyncWorker.cjs");

const rootDir = path.resolve(__dirname, "..");
const checks = [];
const record = (name, evidence = {}) => checks.push({ name, ok: true, evidence });

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
};

const buildStoreFixture = () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-runtime-stability-"));
  const dbDir = path.join(storeDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  writeJson(path.join(dbDir, "state.json"), {
    version: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
    counts: {
      syncRuns: 7,
      matchSnapshots: 8,
      oddsSnapshots: 9,
      predictionRuns: 10
    }
  });
  for (const fileName of ["sync-runs", "match-snapshots", "odds-snapshots", "prediction-runs"]) {
    fs.writeFileSync(path.join(dbDir, `${fileName}.jsonl`), "{}\n{}\n", "utf8");
  }
  writeJson(path.join(dbDir, "current-matches.json"), { rows: [{ id: 1 }, { id: 2 }] });
  writeJson(path.join(dbDir, "history-list.json"), { rows: [{ id: 3 }] });
  writeJson(path.join(dbDir, "latest-match-index.json"), { matches: { a: {}, b: {}, c: {} } });
  return storeDir;
};

const verifyDataStoreStatus = async (storeDir) => {
  const fast = await getDataStoreStatus(storeDir);
  assert.equal(fast.countMode, "state");
  assert.equal(fast.files["odds-snapshots"].rows, 9);
  assert.equal(fast.files["odds-snapshots"].rowCountSource, "state");
  assert.equal(fast.files["current-matches.json"].rows, null);
  assert.equal(fast.files["current-matches.json"].rowCountSource, "not-counted");
  record("default datastore status uses state counts without exact file scans", {
    countMode: fast.countMode,
    oddsRows: fast.files["odds-snapshots"].rows,
    materializedRows: fast.files["current-matches.json"].rows
  });

  const firstExact = await getDataStoreStatus(storeDir, { exact: true });
  assert.equal(firstExact.countMode, "exact");
  assert.equal(firstExact.files["odds-snapshots"].rows, 2);
  assert.equal(firstExact.files["odds-snapshots"].stateRows, 9);
  assert.equal(firstExact.files["odds-snapshots"].rowCountSource, "exact-scan");
  assert.equal(firstExact.files["current-matches.json"].rows, 2);
  assert.equal(firstExact.files["latest-match-index.json"].rows, 3);

  const cachedExact = await getDataStoreStatus(storeDir, { exact: true });
  assert.equal(cachedExact.files["odds-snapshots"].rowCountSource, "exact-cache");
  assert.equal(cachedExact.files["current-matches.json"].rowCountSource, "exact-cache");
  record("exact datastore diagnostics count rows and reuse the signature cache", {
    exactRows: firstExact.files["odds-snapshots"].rows,
    cachedSource: cachedExact.files["odds-snapshots"].rowCountSource
  });

  fs.appendFileSync(path.join(storeDir, "db", "odds-snapshots.jsonl"), "{}\n", "utf8");
  const changedExact = await getDataStoreStatus(storeDir, { exact: true });
  assert.equal(changedExact.files["odds-snapshots"].rows, 3);
  assert.equal(changedExact.files["odds-snapshots"].rowCountSource, "exact-scan");
  record("exact row cache invalidates when a file signature changes", {
    rowsAfterAppend: changedExact.files["odds-snapshots"].rows
  });
};

const verifyWorkerHistory = () => {
  const previous = {
    ok: false,
    lastCycle: {
      ok: true,
      startedAt: "2026-07-12T00:00:00.000Z",
      finishedAt: "2026-07-12T00:00:02.500Z"
    },
    lastSuccessAt: "2026-07-12T00:00:02.500Z",
    lastSlowPhaseAt: "2026-07-12T00:00:02.000Z",
    lastError: {
      at: "2026-07-12T00:01:00.000Z",
      message: "previous failure",
      code: "TEST_FAILURE"
    }
  };
  const history = workerHistoryFields(previous);
  assert.equal(history.lastSuccessAt, previous.lastSuccessAt);
  assert.equal(history.lastSlowPhaseAt, previous.lastSlowPhaseAt);
  assert.equal(history.lastCycleDurationMs, 2500);
  assert.equal(history.lastCycle.durationMs, 2500);
  assert.equal(history.lastError.code, "TEST_FAILURE");
  const cycle = withCycleDuration({
    ok: false,
    startedAt: "2026-07-12T00:02:00.000Z",
    finishedAt: "2026-07-12T00:02:01.125Z"
  });
  assert.equal(cycle.durationMs, 1125);
  record("worker history preserves the previous cycle, success time, duration, and error", {
    lastSuccessAt: history.lastSuccessAt,
    durationMs: history.lastCycleDurationMs,
    lastErrorCode: history.lastError.code
  });
};

const verifyCommandTimeout = async () => {
  const startedAt = Date.now();
  let timeoutError = null;
  try {
    await runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {},
      { timeoutMs: 100, terminateGraceMs: 100, forceSettleMs: 500, stdio: "ignore" }
    );
  } catch (error) {
    timeoutError = error;
  }
  const elapsedMs = Date.now() - startedAt;
  assert.ok(timeoutError, "hanging child must reject");
  assert.equal(timeoutError.code, "SYNC_WORKER_COMMAND_TIMEOUT");
  assert.equal(timeoutError.timeoutMs, 100);
  assert.ok(elapsedMs < 5000, `timeout termination took too long: ${elapsedMs}ms`);
  const summary = summarizeWorkerError(timeoutError, "2026-07-12T00:00:00.000Z");
  assert.equal(summary.code, "SYNC_WORKER_COMMAND_TIMEOUT");
  assert.equal(summary.timeoutMs, 100);
  record("worker command timeout terminates a hanging child and returns diagnostics", {
    elapsedMs,
    code: timeoutError.code,
    timeoutMs: timeoutError.timeoutMs
  });
};

const verifyServerRouting = () => {
  const source = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
  assert.ok(source.includes("database: await getDataStoreStatus(storeDir, { exact: options.exactDataStore === true })"));
  assert.ok(source.includes("getHealth({ exactDataStore: true })"));
  const exactAdminCalls = source.match(/getDataStoreStatus\(storeDir, \{ exact: true \}\)/g) || [];
  assert.ok(exactAdminCalls.length >= 2);
  assert.ok(source.includes("workerLastSuccessAt"));
  assert.ok(source.includes("workerLastCycleDurationMs"));
  assert.ok(source.includes("workerLastError"));
  record("public health uses fast status while admin diagnostics request exact cached counts", {
    exactAdminCalls: exactAdminCalls.length
  });
};

const verifyFastResultWatcherRuntimeGuard = () => {
  const source = fs.readFileSync(path.join(rootDir, "scripts", "checkServerRuntime.cjs"), "utf8");
  assert.ok(source.includes('process.env.RUNTIME_MONITOR_REQUIRE_FAST_RESULT_WATCHER !== "0" && !isWindows'));
  assert.ok(source.includes('process.env.RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_POLL_MS || 5000'));
  assert.ok(source.includes('process.env.RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_CHECK_AGE_SECONDS || 30'));
  assert.ok(source.includes('fastResultWatcher.enabled === true'));
  assert.ok(source.includes('Number(fastResultWatcher.pollMs || 0) <= fastResultWatcherMaxPollMs'));
  assert.ok(source.includes('fastWatcherCheckAgeSeconds <= fastResultWatcherMaxCheckAgeSeconds'));
  assert.ok(source.includes('!fastResultWatcher.lastError'));
  assert.ok(source.includes('fastWatcherLastErrorCode === "PUBLISHER_RETRYABLE_SKIP"'));
  assert.ok(source.includes('watcher-retryable-skip-within-grace'));
  assert.ok(source.includes('? "watcher-disabled-or-poll-too-slow"'));
  assert.ok(source.includes('? "watcher-heartbeat-stale"'));
  assert.ok(source.includes('addCheck("fast result watcher", fastWatcherStatus'));
  record("runtime monitor fails closed for a disabled, slow, stale, or errored fast-result watcher", {
    productionDefaultRequired: true,
    maxPollMs: 5000,
    maxHeartbeatAgeSeconds: 30
  });
};

const verifyOfficialSourceRedundancy = () => {
  const trustedRelay = {
    stale: false,
    validationOk: true,
    currentLane: { stale: false },
    collectorState: {
      lastUploadSnapshotTrusted: true,
      lastUploadTrustLevel: "trusted"
    }
  };
  const single = assessOfficialSourceRedundancy({
    skipSportteryDirectFetch: true,
    syncTransport: "relay",
    currentLaneFresh: true,
    relaySnapshot: trustedRelay
  });
  assert.equal(single.officialSourceSinglePoint, true);
  assert.equal(single.status, "watch");
  assert.equal(single.trustedCollectorCount, 1);

  const configuredButBlocked = assessOfficialSourceRedundancy({
    skipSportteryDirectFetch: false,
    syncTransport: "relay",
    currentLaneFresh: true,
    sportteryEgress: {
      ok: false,
      status: "blocked",
      transport: "proxy",
      proxyConfigured: true,
      checkedAt: new Date().toISOString(),
      summary: { jsonEndpoints: 0, rows: 0 }
    },
    relaySnapshot: trustedRelay
  });
  assert.equal(configuredButBlocked.officialSourceSinglePoint, true);
  assert.equal(configuredButBlocked.serverDirectAvailable, false);

  const direct = assessOfficialSourceRedundancy({
    skipSportteryDirectFetch: false,
    syncTransport: "direct",
    currentLaneFresh: true,
    relaySnapshot: trustedRelay
  });
  assert.equal(direct.officialSourceSinglePoint, false);
  assert.equal(direct.serverDirectProof, "successful-sync-transport");

  const twoCollectors = assessOfficialSourceRedundancy({
    skipSportteryDirectFetch: true,
    syncTransport: "relay",
    currentLaneFresh: true,
    relaySnapshot: trustedRelay,
    trustedCollectorCount: 2
  });
  assert.equal(twoCollectors.officialSourceSinglePoint, false);
  assert.equal(twoCollectors.mode, "multi-collector");

  record("official source redundancy requires runtime proof, not configuration labels", {
    single,
    configuredButBlocked,
    direct,
    twoCollectors
  });
};

const verifyPostgresPrimarySqliteParity = () => {
  const publication = {
    generationId: "g-test",
    manifestHash: "a".repeat(64),
    sourceCycleId: "cycle-test",
    committedAt: "2026-08-30T12:00:00.000Z",
  };
  const sameGeneration = evaluateSqliteReadRequirement({
    sqlite: { available: true, publication },
    postgres: { available: true, publication: { ...publication } },
    currentRead: { source: "postgres" },
    requireSqlite: true,
    autoRepairSqlite: true,
    postgresMode: "primary",
  });
  assert.equal(sameGeneration.requirementMet, true);
  assert.equal(sameGeneration.repairEligible, false);
  assert.equal(sameGeneration.publicationParity, true);
  assert.equal(sameGeneration.reason, "postgres-primary-read-with-sqlite-parity");

  const transitionWithParity = evaluateSqliteReadRequirement({
    sqlite: { available: true, publication },
    postgres: { available: true, publication: { ...publication } },
    currentRead: { source: "generation-pair-refresh" },
    requireSqlite: true,
    autoRepairSqlite: true,
    postgresMode: "primary",
  });
  assert.equal(transitionWithParity.requirementMet, true);
  assert.equal(transitionWithParity.repairEligible, false);
  assert.equal(transitionWithParity.publicationParity, true);

  const mismatched = evaluateSqliteReadRequirement({
    sqlite: { available: true, publication },
    postgres: { available: true, publication: { ...publication, generationId: "g-new" } },
    currentRead: { source: "postgres" },
    requireSqlite: true,
    autoRepairSqlite: true,
    postgresMode: "primary",
  });
  assert.equal(mismatched.requirementMet, false);
  assert.equal(mismatched.repairEligible, true);
  assert.equal(mismatched.publicationParity, false);

  const sqlitePrimary = evaluateSqliteReadRequirement({
    sqlite: { available: true, publication },
    postgres: { available: false },
    currentRead: { source: "sqlite" },
    requireSqlite: true,
    autoRepairSqlite: true,
    postgresMode: "disabled",
  });
  assert.equal(sqlitePrimary.requirementMet, true);
  assert.equal(sqlitePrimary.repairEligible, false);
  record("PostgreSQL primary accepts same-generation SQLite parity without taking the sync lock", {
    sameGeneration,
    transitionWithParity,
    mismatched,
    sqlitePrimary,
  });
};

(async () => {
  const storeDir = buildStoreFixture();
  try {
    await verifyDataStoreStatus(storeDir);
    verifyWorkerHistory();
    await verifyCommandTimeout();
    verifyServerRouting();
    verifyFastResultWatcherRuntimeGuard();
    verifyOfficialSourceRedundancy();
    verifyPostgresPrimarySqliteParity();
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({
    ok: true,
    verifier: "runtime-stability",
    checks
  }, null, 2));
})().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    verifier: "runtime-stability",
    error: error.stack || error.message || String(error),
    checks
  }, null, 2));
  process.exit(1);
});
