const fs = require("node:fs");
const path = require("node:path");
const { assessOfficialSourceRedundancy } = require("../server/sourceRedundancy.cjs");

const rootDir = path.resolve(__dirname, "..");

const readText = (relativePath) => {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  } catch {
    return "";
  }
};

const readJson = (relativePath, fallback = null) => {
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return fallback;
  }
};

const keyValue = (text, key) => {
  const match = text.match(new RegExp(`^${key}=([^\\r\\n]*)`, "m"));
  return match?.[1]?.trim() || "";
};

const hasAll = (text, needles) => needles.every((needle) => text.includes(needle));

const checks = [];
const pushCheck = (name, ok, details = {}, required = true) => {
  checks.push({ name, required, ok: Boolean(ok), details });
};

const packageJson = readJson("package.json", { scripts: {} });
const scripts = packageJson.scripts || {};
const envExample = readText("deploy/light-server/env.example");
const workerService = readText("deploy/light-server/football-sync-worker.service");
const monitorService = readText("deploy/light-server/football-monitor.service");
const releaseScript = readText("deploy/light-server/release.sh");
const bundleReleaseScript = readText("deploy/light-server/release-from-bundle.sh");
const syncWorker = readText("scripts/runSyncWorker.cjs");
const runtimeMonitor = readText("scripts/checkServerRuntime.cjs");
const verifyCloudSyncFreshness = readText("scripts/verifyCloudSyncFreshness.cjs");
const verifyProductionPlanCoverage = readText("scripts/verifyProductionPlanCoverage.cjs");
const verifyProductionReadiness = readText("scripts/verifyProductionReadiness.cjs");
const docsLightServer = readText("docs/light-server-deployment.md");
const docsSportteryRelay = readText("docs/sporttery-relay-snapshot.md");
const serverIndex = readText("server/index.cjs");
const sourceRedundancy = readText("server/sourceRedundancy.cjs");
const relayTaskInstaller = readText("scripts/installSportteryRelayTask.ps1");

const releaseScripts = [releaseScript, bundleReleaseScript];
const serverPrimaryKeys = [
  "PRODUCTION_DATA_MODE",
  "SERVER_DATA_PRIMARY",
  "LOCAL_DATA_PUSH_REQUIRED",
  "CLOUD_SYNC_REQUIRED",
  "SPORTTERY_RELAY_REQUIRED"
];

pushCheck("package exposes server-primary verifier", scripts["verify:server-primary"] === "node scripts/verifyServerPrimaryDataFlow.cjs", {
  script: scripts["verify:server-primary"] || null
});

pushCheck("env selects cloud-server processing and storage mode",
  keyValue(envExample, "PRODUCTION_DATA_MODE") === "server-primary"
    && keyValue(envExample, "SERVER_DATA_PRIMARY") === "1"
    && keyValue(envExample, "LOCAL_DATA_PUSH_REQUIRED") === "0"
    && keyValue(envExample, "CLOUD_SYNC_REQUIRED") === "0"
    && keyValue(envExample, "SPORTTERY_RELAY_REQUIRED") === "0", {
    productionDataMode: keyValue(envExample, "PRODUCTION_DATA_MODE") || null,
    serverDataPrimary: keyValue(envExample, "SERVER_DATA_PRIMARY") || null,
    localDataPushRequired: keyValue(envExample, "LOCAL_DATA_PUSH_REQUIRED") || null,
    cloudSyncRequired: keyValue(envExample, "CLOUD_SYNC_REQUIRED") || null,
    sportteryRelayRequired: keyValue(envExample, "SPORTTERY_RELAY_REQUIRED") || null
  });

const trustedRelay = {
  stale: false,
  validationOk: true,
  currentLane: { stale: false },
  collectorState: {
    lastUploadSnapshotTrusted: true,
    lastUploadTrustLevel: "trusted"
  }
};
const singleCollectorAssessment = assessOfficialSourceRedundancy({
  skipSportteryDirectFetch: true,
  syncTransport: "relay",
  currentLaneFresh: true,
  relaySnapshot: trustedRelay
});
const configuredOnlyAssessment = assessOfficialSourceRedundancy({
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
const directAssessment = assessOfficialSourceRedundancy({
  skipSportteryDirectFetch: false,
  syncTransport: "proxy",
  currentLaneFresh: true,
  relaySnapshot: trustedRelay
});
const multiCollectorAssessment = assessOfficialSourceRedundancy({
  skipSportteryDirectFetch: true,
  syncTransport: "relay",
  currentLaneFresh: true,
  relaySnapshot: trustedRelay,
  trustedCollectorCount: 2
});

pushCheck("official source redundancy is runtime-evidence based",
  singleCollectorAssessment.officialSourceSinglePoint === true
    && singleCollectorAssessment.status === "watch"
    && singleCollectorAssessment.trustedCollectorCount === 1
    && configuredOnlyAssessment.officialSourceSinglePoint === true
    && configuredOnlyAssessment.serverDirectAvailable === false
    && directAssessment.officialSourceSinglePoint === false
    && directAssessment.serverDirectProof === "successful-sync-transport"
    && multiCollectorAssessment.officialSourceSinglePoint === false
    && sourceRedundancy.includes("healthyEgressProof")
    && serverIndex.includes("officialSourceSinglePoint")
    && runtimeMonitor.includes('addCheck("official source redundancy"'), {
    singleCollectorAssessment,
    configuredOnlyAssessment,
    directAssessment,
    multiCollectorAssessment
  });

pushCheck("Windows relay task recovery is safe by default",
  hasAll(relayTaskInstaller, [
    "StartWhenAvailable = $true",
    "DisallowStartIfOnBatteries = $false",
    "StopIfGoingOnBatteries = $false",
    "RestartCount = $RetryCount",
    "RestartInterval",
    "ExecutionTimeLimit",
    'FOOTBALL_RELAY_WAKE_TO_RUN -eq "1"',
    'FOOTBALL_RELAY_USE_S4U -eq "1"',
    "TASK_LOGON_INTERACTIVE_TOKEN",
    "TASK_LOGON_S4U: explicit opt-in only"
  ]), {
    startWhenAvailable: relayTaskInstaller.includes("StartWhenAvailable = $true"),
    batterySafe: relayTaskInstaller.includes("StopIfGoingOnBatteries = $false"),
    wakeOptIn: relayTaskInstaller.includes('FOOTBALL_RELAY_WAKE_TO_RUN -eq "1"'),
    s4uOptIn: relayTaskInstaller.includes('FOOTBALL_RELAY_USE_S4U -eq "1"')
  });

pushCheck("env uses server SQLite as authoritative store",
  keyValue(envExample, "SERVER_STORE_DIR") === "/var/lib/football-predict"
    && keyValue(envExample, "DATASTORE_READ_SOURCE") === "sqlite"
    && keyValue(envExample, "DATASTORE_SQLITE_PATH") === "/var/lib/football-predict/football.db"
    && keyValue(envExample, "ENABLE_SQLITE_EXPORT") === "1"
    && keyValue(envExample, "ENABLE_SYNC_CRON") === "0", {
    serverStoreDir: keyValue(envExample, "SERVER_STORE_DIR") || null,
    dataStoreReadSource: keyValue(envExample, "DATASTORE_READ_SOURCE") || null,
    sqlitePath: keyValue(envExample, "DATASTORE_SQLITE_PATH") || null,
    enableSqliteExport: keyValue(envExample, "ENABLE_SQLITE_EXPORT") || null,
    enableApiCron: keyValue(envExample, "ENABLE_SYNC_CRON") || null
  });

pushCheck("systemd sync worker owns production refresh",
  hasAll(workerService, [
    "EnvironmentFile=/etc/football-predict/env",
    "Environment=SYNC_WORKER_LOOP=1",
    "Environment=ENABLE_SQLITE_EXPORT=1",
    "ExecStart=/opt/node-v22.22.1/bin/node /opt/football-predict/scripts/runSyncWorker.cjs",
    "Restart=on-failure",
    "User=football"
  ]), {
    hasEnvFile: workerService.includes("EnvironmentFile=/etc/football-predict/env"),
    loop: workerService.includes("SYNC_WORKER_LOOP=1"),
    readSourceFromEnvFile: !workerService.includes("Environment=DATASTORE_READ_SOURCE="),
    sqliteExport: workerService.includes("ENABLE_SQLITE_EXPORT=1")
  });

pushCheck("sync worker cycle is self-contained on server",
  hasAll(syncWorker, [
    "sync:500",
    "sync:500:details",
    "sync:weather",
    "sync:prematch",
    "scripts/syncData.cjs",
    "validate:data",
    "validate:sources",
    "datastore:sqlite",
    "maybeRunModelBacktest",
    "optimize:strategy",
    "writeWorkerStatus"
  ]), {
    refreshes500: syncWorker.includes("sync:500"),
    refreshesWeather: syncWorker.includes("sync:weather"),
    refreshesPrematch: syncWorker.includes("sync:prematch"),
    runsPrimarySync: syncWorker.includes("scripts/syncData.cjs"),
    exportsSqlite: syncWorker.includes("datastore:sqlite"),
    updatesModel: syncWorker.includes("maybeRunModelBacktest") && syncWorker.includes("optimize:strategy")
  });

pushCheck("release scripts preserve server-primary mode",
  serverPrimaryKeys.every((key) => releaseScripts.every((text) => text.includes(`set_env_value "$env_file" "${key}"`)))
    && releaseScripts.every((text) => text.includes('set_env_value "$env_file" "DATASTORE_READ_SOURCE" "$PRIMARY_READ_SOURCE"'))
    && releaseScripts.every((text) => text.includes('set_env_value "$env_file" "ENABLE_SQLITE_EXPORT" "1"')), {
    keys: Object.fromEntries(serverPrimaryKeys.map((key) => [
      key,
      releaseScripts.every((text) => text.includes(`set_env_value "$env_file" "${key}"`))
    ]))
  });

pushCheck("local push automation is opt-in, not production-required",
  verifyCloudSyncFreshness.includes("explicitLocalPushRequired")
    && verifyCloudSyncFreshness.includes("serverPrimaryMode")
    && verifyCloudSyncFreshness.includes("server primary data flow selected")
    && !verifyCloudSyncFreshness.includes('process.platform === "win32" || process.env.CLOUD_SYNC_REQUIRE_LOCAL_AUTOMATION'), {
    hasExplicitLocalPushFlag: verifyCloudSyncFreshness.includes("explicitLocalPushRequired"),
    hasServerPrimaryMode: verifyCloudSyncFreshness.includes("serverPrimaryMode"),
    win32NoLongerRequiredByDefault: !verifyCloudSyncFreshness.includes('process.platform === "win32" || process.env.CLOUD_SYNC_REQUIRE_LOCAL_AUTOMATION')
  });

pushCheck("runtime monitor fails stopped worker unless local push pause is explicitly allowed",
  runtimeMonitor.includes("allowLocalPushWorkerPause")
    && runtimeMonitor.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE")
    && runtimeMonitor.includes("allowLocalPushWorkerPause && inactive.length")
    && monitorService.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE=0"), {
    hasOptInFlag: runtimeMonitor.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE"),
    gatedCloudPause: runtimeMonitor.includes("allowLocalPushWorkerPause && inactive.length"),
    serviceDefault: monitorService.includes("RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE=0") ? "0" : null
  });

const runtimeHardFlags = runtimeMonitor.match(/const hardFlags = \{([\s\S]*?)\n\s*\};/)?.[1] || "";
pushCheck("runtime monitor treats a model safety pause as watch, not service failure",
  runtimeHardFlags.includes("serviceOk")
    && runtimeHardFlags.includes("dataFresh")
    && !runtimeHardFlags.includes("recommendationReliable")
    && runtimeMonitor.includes('addCheck("recommendation safety gate", recommendationReliable ? "ok" : "watch"')
    && runtimeMonitor.includes('reason: recommendationReliable ? "formal-recommendations-enabled" : "model-safety-gate-paused"'), {
    hardFlags: runtimeHardFlags.trim(),
    hasSafetyGateWatch: runtimeMonitor.includes('addCheck("recommendation safety gate", recommendationReliable ? "ok" : "watch"')
  });

pushCheck("production coverage separates cloud processing from official-source redundancy",
  verifyProductionPlanCoverage.includes("server processing is cloud-primary while official-source redundancy is runtime-evidenced")
    && verifyProductionPlanCoverage.includes("verify:server-primary")
    && verifyProductionReadiness.includes("server-primary data flow artifact"), {
    planCoverageHasRule: verifyProductionPlanCoverage.includes("server processing is cloud-primary while official-source redundancy is runtime-evidenced"),
    packageGate: verifyProductionPlanCoverage.includes("verify:server-primary"),
    productionReadinessGate: verifyProductionReadiness.includes("server-primary data flow artifact")
  });

pushCheck("docs describe conditional collector single-point risk",
  docsLightServer.includes("PRODUCTION_DATA_MODE=server-primary")
    && docsLightServer.includes("does not by itself prove")
    && docsLightServer.includes("officialSourceSinglePoint=true")
    && docsSportteryRelay.includes("not proof of source redundancy")
    && docsSportteryRelay.includes("upstream production single point")
    && docsSportteryRelay.includes("FOOTBALL_RELAY_WAKE_TO_RUN=1")
    && docsSportteryRelay.includes("FOOTBALL_RELAY_USE_S4U=1"), {
    lightServerDocUpdated: docsLightServer.includes("officialSourceSinglePoint=true"),
    relayDocUpdated: docsSportteryRelay.includes("upstream production single point")
  });

const required = checks.filter((check) => check.required);
const failed = required.filter((check) => !check.ok);

console.log(JSON.stringify({
  ok: failed.length === 0,
  verifier: "verifyServerPrimaryDataFlow",
  checkedAt: new Date().toISOString(),
  summary: {
    checks: checks.length,
    required: required.length,
    failed: failed.length,
    productionDataMode: keyValue(envExample, "PRODUCTION_DATA_MODE") || null,
    localDataPushRequired: keyValue(envExample, "LOCAL_DATA_PUSH_REQUIRED") || null,
    cloudSyncRequired: keyValue(envExample, "CLOUD_SYNC_REQUIRED") || null,
    sqlitePath: keyValue(envExample, "DATASTORE_SQLITE_PATH") || null
  },
  checks
}, null, 2));

if (failed.length > 0) process.exitCode = 1;
