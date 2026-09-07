"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  CORE_FILES,
  acquireGenerationReadLease,
  assertActivePublicationUnchanged,
  bundleSemanticHash,
  cleanupDataGenerations,
  commitWithActivePublicationPointerLock,
  commitCurrentDataGeneration,
  readPublicationJson,
  resolveActivePublication,
  resolveServingPublication,
  resolveServingPublicationForSqliteIdentity,
  safeGenerationCandidate,
  selectFastResultReceiptDuringPairTransition,
  samePublicationIdentity,
} = require("../server/dataGenerationBundle.cjs");
const {
  sha256,
  stableStringify,
  storePaths,
} = require("../server/dataGenerationStore.cjs");
const {
  getSqliteStatus,
  readSqlitePublicationIdentity,
  readSqliteCurrentMatches,
} = require("../server/sqliteStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
assert.match(
  packageJson.scripts?.["datastore:generation"] || "",
  /^node --expose-gc scripts\/commitCurrentDataGeneration\.cjs$/,
  "generation CLI must expose GC so released large JSON payloads are collected between validation lanes",
);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "football-generation-e2e-"));
const publicDataDir = path.join(tempRoot, "public-data");
const storeDir = path.join(tempRoot, "store");
const dbPath = path.join(storeDir, "football.db");
let checks = 0;
let server = null;

const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks += 1;
};

const verifyBoundedReceiptTransitionSelection = () => {
  const cachedState = {
    available: true,
    valid: true,
    missing: false,
    revision: 7,
    receipt: { version: "sqlite-fast-result-receipt-v2", revision: 7 },
  };
  const selected = selectFastResultReceiptDuringPairTransition({
    sqliteState: {
      available: true,
      valid: false,
      reason: "publication-identity-mismatch",
      receipt: null,
    },
    cachedState,
    transitionActive: true,
    validatedAtMs: 1_000,
    nowMs: 2_000,
    ttlMs: 5_000,
  });
  equal(selected.valid, true, "bounded transition accepts an exact previously validated receipt");
  equal(selected.transition, true, "bounded transition marks the cached receipt explicitly");
  equal(selected.transitionSource, "cached-validated-receipt", "bounded transition exposes receipt provenance");
  const expired = selectFastResultReceiptDuringPairTransition({
    sqliteState: { valid: false, reason: "publication-identity-mismatch", receipt: null },
    cachedState,
    transitionActive: true,
    validatedAtMs: 1_000,
    nowMs: 7_001,
    ttlMs: 5_000,
  });
  equal(expired.valid, false, "an expired receipt transition fails closed");
  const unrelated = selectFastResultReceiptDuringPairTransition({
    sqliteState: { valid: false, reason: "receipt-or-revision-invalid", receipt: null },
    cachedState,
    transitionActive: true,
    validatedAtMs: 1_000,
    nowMs: 2_000,
    ttlMs: 5_000,
  });
  equal(unrelated.valid, false, "non-identity receipt failures never use the transition cache");
};

const legacySyncMetaVolatileKeys = new Set([
  "sourceCycleId", "updatedAt", "capturedAt", "lastAttemptAt", "checkedAt",
  "requestedAt", "receivedAt", "finishedAt", "startedAt", "durationMs",
  "ageSeconds", "ageMinutes", "freshnessTime", "currentFreshnessTime",
  "historyFreshnessTime", "resultFreshnessTime",
]);
const legacySanitizeSemanticValue = (value, omittedKeys = new Set()) => {
  if (Array.isArray(value)) return value.map((entry) => legacySanitizeSemanticValue(entry, omittedKeys));
  if (!value || typeof value !== "object") return value;
  const projected = {};
  for (const key of Object.keys(value).sort()) {
    if (omittedKeys.has(key)) continue;
    projected[key] = legacySanitizeSemanticValue(value[key], omittedKeys);
  }
  return projected;
};
const legacyIsPlainObject = (value) => Boolean(
  value
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);
const legacySemanticProjectionFor = (relativePath, payload) => {
  if (relativePath === "sync-meta.json") {
    return legacySanitizeSemanticValue(payload, legacySyncMetaVolatileKeys);
  }
  if (relativePath === "matches-current.json" || relativePath === "matches-history.json") {
    return legacySanitizeSemanticValue(payload, new Set(["sourceCycleId"]));
  }
  if (["external-signals.json", "odds-history.json", "prediction-snapshots.json"].includes(relativePath)
      && legacyIsPlainObject(payload)) {
    const projected = { ...payload };
    delete projected.updatedAt;
    return projected;
  }
  return payload;
};
const legacyBundleSemanticHash = (payloads) => {
  const projection = {};
  for (const relativePath of CORE_FILES) {
    projection[relativePath] = legacySemanticProjectionFor(relativePath, payloads.get(relativePath));
  }
  return sha256(stableStringify(projection));
};

const semanticHashCompatibilityFixture = () => {
  const sparse = [];
  sparse.length = 2;
  sparse[1] = "尾部";
  return new Map([
    ["matches-current.json", [{ id: "当前", sourceCycleId: "volatile", nested: { sourceCycleId: "drop", value: -0 } }]],
    ["matches-history.json", [{ id: "历史", sourceCycleId: "volatile", odds: [2.1, 3.25, 3.4] }]],
    ["sync-meta.json", {
      sourceCycleId: "volatile",
      updatedAt: "volatile",
      nested: { checkedAt: "volatile", keep: "稳定", list: [{ durationMs: 9, keep: true }] },
    }],
    ["external-signals.json", { updatedAt: "volatile", nested: { updatedAt: "semantic", score: 0.75 } }],
    ["odds-history.json", { updatedAt: "volatile", rows: [{ id: "1", values: sparse }] }],
    ["prediction-snapshots.json", { updatedAt: "volatile", rows: [{ id: "1", probability: 0.625 }] }],
    ["model-calibration.json", { version: "兼容-v1", generatedAt: "2026-07-16T01:02:03.000Z" }],
  ]);
};

const writeJson = (fileName, payload) => {
  fs.mkdirSync(publicDataDir, { recursive: true });
  fs.writeFileSync(path.join(publicDataDir, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const match = (id, cycle, home = "Home") => ({
  id,
  sourceMatchId: id.replace(/^match-/, ""),
  status: "SCHEDULED",
  effectiveStatus: "SCHEDULED",
  kickoffTime: "2030-01-02T12:00:00.000Z",
  buyEndTime: "2030-01-02T11:50:00.000Z",
  homeTeamName: home,
  awayTeamName: "Away",
  leagueName: "Generation League",
  sourceCycleId: cycle,
});

const writeBundle = ({ cycle, matchId, home = "Home" }) => {
  const now = "2026-07-16T01:02:03.000Z";
  const current = [match(matchId, cycle, home)];
  const history = [{
    ...match(`history-${matchId}`, cycle, "Past Home"),
    status: "FINISHED",
    effectiveStatus: "FINISHED",
    kickoffTime: "2026-07-15T12:00:00.000Z",
    scoreHome: 1,
    scoreAway: 0,
  }];
  writeJson("matches-current.json", current);
  writeJson("matches-history.json", history);
  writeJson("sync-meta.json", {
    version: "test-sync-meta-v1",
    source: "sporttery",
    sourceCycleId: cycle,
    updatedAt: now,
    capturedAt: now,
    api: {
      freshnessTime: now,
      currentFreshnessTime: now,
      historyFreshnessTime: now,
      stale: false,
      currentStale: false,
      historyStale: false,
    },
    files: { current: current.length, history: history.length, predictionSnapshots: 0 },
  });
  writeJson("external-signals.json", {
    version: "test-external-v1",
    source: "test",
    updatedAt: now,
    matches: {},
  });
  writeJson("odds-history.json", {
    version: "test-odds-v1",
    source: "test",
    updatedAt: now,
    rows: [],
  });
  writeJson("prediction-snapshots.json", {
    version: "test-predictions-v1",
    source: "test",
    updatedAt: now,
    rows: [],
  });
  writeJson("model-calibration.json", {
    version: "test-calibration-v1",
    generatedAt: now,
    source: "test",
    sample: {},
    metrics: {},
  });
  writeJson("model-evaluation.json", {
    version: "test-evaluation-v1",
    generatedAt: now,
    riskTiers: { overall: { tier: "unknown" } },
  });
  writeJson("model-strategy.json", {
    version: "test-strategy-v1",
    generatedAt: now,
    activation: { onlineEffect: "shadow-only" },
  });
};

const runExporter = ({
  targetStoreDir = storeDir,
  targetDbPath = dbPath,
  targetPublicDataDir = publicDataDir,
} = {}) => {
  const result = spawnSync(process.execPath, [path.join(rootDir, "scripts", "exportDataStoreSqlite.cjs")], {
    cwd: rootDir,
    env: {
      ...process.env,
      SERVER_STORE_DIR: targetStoreDir,
      DATASTORE_SQLITE_PATH: targetDbPath,
      SQL_EXPORT_PUBLIC_DATA_DIR: targetPublicDataDir,
      SQLITE_EXPORT_PUBLIC_DATA_DIR: targetPublicDataDir,
      SQLITE_IMPORT_JSONL_MATCH_LIMIT: "0",
      SQLITE_IMPORT_JSONL_ODDS_LIMIT: "0",
      SQLITE_IMPORT_JSONL_PREDICTION_LIMIT: "0",
      SQLITE_IMPORT_JSONL_SYNC_LIMIT: "0",
      SQLITE_EXPORT_ATTEMPTS: "1",
    },
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`export failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
};

const readDbMeta = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT key, value FROM schema_meta").all().map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
};

const requestJson = ({ port, method = "GET", pathname, body = null, headers = {} }) => new Promise((resolve, reject) => {
  const request = http.request({
    host: "127.0.0.1",
    port,
    method,
    path: pathname,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => resolve({
      status: response.statusCode,
      body: text ? JSON.parse(text) : null,
    }));
  });
  request.on("error", reject);
  if (body) request.write(JSON.stringify(body));
  request.end();
});

const waitForServer = async (port, output) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`test server exited early: ${output.join("")}`);
    try {
      const response = await requestJson({ port, pathname: "/api/v1/sync-meta" });
      if (response.status === 200) return;
    } catch {
      // Startup can race the first connection attempt.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`test server did not become ready: ${output.join("")}`);
};

const activeProjectionIdentityFor = (identity) => ({
  mode: "active-generation",
  generationId: identity.generationId,
  manifestHash: identity.manifestHash,
  sourceCycleId: identity.sourceCycleId,
  committedAt: identity.committedAt,
});

const writePostgresPrimaryMockPreload = (fixtureRoot) => {
  const preloadPath = path.join(fixtureRoot, "postgres-primary-preload.cjs");
  fs.writeFileSync(preloadPath, `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { isMainThread } = require("node:worker_threads");
const rootDir = path.resolve(process.env.GENERATION_E2E_ROOT_DIR);
const postgresStorePath = path.resolve(rootDir, "server", "postgresStore.cjs").toLowerCase();
const postgresProjectionPath = path.resolve(rootDir, "server", "postgresProjectionStore.cjs").toLowerCase();
const originalLoad = Module._load;
const readState = () => {
  const state = JSON.parse(fs.readFileSync(process.env.GENERATION_E2E_POSTGRES_IDENTITY_FILE, "utf8"));
  fs.appendFileSync(process.env.GENERATION_E2E_POSTGRES_AUDIT_FILE, JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    isMainThread,
    available: state.available !== false,
    generationId: state.publication?.generationId || state.generationId || null,
  }) + "\\n");
  return state.available === false
    ? { available: false, reason: state.reason || "injected PostgreSQL identity query failure", publication: null }
    : { available: true, reason: null, publication: state.publication || state };
};
const matches = (stored, expected) => Boolean(
  expected
  && stored?.mode === "active-generation"
  && ["active-generation", "previous-generation"].includes(expected.mode)
  && stored.generationId === expected.generationId
  && stored.manifestHash === expected.manifestHash
  && stored.sourceCycleId === expected.sourceCycleId
  && stored.committedAt === expected.committedAt
);
const postgresStore = {
  createPostgresPool: () => ({ end: async () => {} }),
  postgresEnabled: () => true,
  postgresMode: () => "primary",
  postgresPrimary: (mode) => String(mode || "primary").toLowerCase() === "primary",
  postgresWriteEnabled: () => true,
  runPostgresMigrations: async () => ({ applied: [] }),
};
const postgresProjection = {
  getPostgresProjectionStatus: async (_pool, options = {}) => {
    const state = readState();
    if (!state.available) return { ...state, counts: {}, baseReady: false };
    const baseReady = matches(state.publication, options.publicationIdentity);
    return {
      available: true,
      reason: null,
      publication: state.publication,
      baseReady,
      baseBlockedReason: baseReady ? null : "postgres-generation-mismatch",
      exportedAt: state.publication.committedAt,
      syncMetaUpdatedAt: state.publication.committedAt,
      counts: { currentMatches: 1, historyMatches: 1, oddsSnapshots: 0, predictionSnapshots: 0 },
      latestRun: { committedAt: state.publication.committedAt },
    };
  },
  readPostgresCurrentMatches: async () => [],
  readPostgresCurrentTransitionSnapshot: async () => ({ available: false, currentRows: [], transitionRows: [] }),
  readPostgresFastResultReceiptState: async () => ({
    available: true,
    valid: false,
    missing: true,
    legacy: false,
    reason: "receipt-missing",
    revision: 0,
    receipt: null,
  }),
  readPostgresHistoryMatchesForList: async () => [],
  readPostgresHistoryMatchesPage: async () => ({ rows: [], consumedRows: 0, totalAvailable: 0 }),
  readPostgresMatchById: async () => null,
  readPostgresOddsHistoryRows: async () => [],
  readPostgresPredictionSnapshotRows: async () => [],
  readPostgresPublicationIdentity: async () => readState(),
  readPostgresTransitionMatches: async () => [],
};
Module._load = function(request, parent, isMain) {
  const resolved = String(Module._resolveFilename(request, parent, isMain)).toLowerCase();
  if (resolved === postgresStorePath) return postgresStore;
  if (resolved === postgresProjectionPath) return postgresProjection;
  return originalLoad.apply(this, arguments);
};
`, "utf8");
  return preloadPath;
};

const writePostgresIdentityState = (identityFile, state) => {
  fs.writeFileSync(identityFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

const startPostgresPrimaryApi = async ({
  targetStoreDir,
  targetDbPath,
  identityFile,
  auditFile,
  preloadPath,
  waitForReady = true,
}) => {
  const port = 24000 + Math.floor(Math.random() * 12000);
  const output = [];
  const inheritedNodeOptions = String(process.env.NODE_OPTIONS || "").trim();
  server = spawn(process.execPath, [path.join(rootDir, "server", "index.cjs")], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      NODE_OPTIONS: [inheritedNodeOptions, `--require=${preloadPath.replace(/\\/g, "/")}`]
        .filter(Boolean)
        .join(" "),
      HOST: "127.0.0.1",
      PORT: String(port),
      SERVER_STORE_DIR: targetStoreDir,
      DATASTORE_SQLITE_PATH: targetDbPath,
      DATASTORE_READ_SOURCE: "postgres",
      CURRENT_MATCH_SOURCE: "postgres",
      FOOTBALL_POSTGRES_MODE: "primary",
      FOOTBALL_POSTGRES_URL: "postgresql://generation-e2e.invalid/football",
      GENERATION_E2E_ROOT_DIR: rootDir,
      GENERATION_E2E_POSTGRES_IDENTITY_FILE: identityFile,
      GENERATION_E2E_POSTGRES_AUDIT_FILE: auditFile,
      ENABLE_SYNC_CRON: "0",
      ENABLE_GPT_CRON: "0",
      SYNC_WORKER_EVENT_BRIDGE: "0",
      RELAY_FAST_WATCHER_ENABLED: "0",
      V1_HEALTH_CACHE_TTL_MS: "100",
      ADMIN_TOKEN: "generation-e2e-admin",
      ACCESS_CODE_ADMIN_TOKEN: "generation-e2e-admin",
      ACCESS_CODE_SECRET: "generation-e2e-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  server.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  if (waitForReady) await waitForServer(port, output);
  return { port, output };
};

const waitForProcessExit = async (child, timeoutMs = 10_000) => {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("test server did not exit fail-closed")), timeoutMs)),
  ]);
};

const startApiAndVerifyIdentity = async (expectedIdentity, expectedMatchId) => {
  const port = 24000 + Math.floor(Math.random() * 12000);
  const output = [];
  server = spawn(process.execPath, [path.join(rootDir, "server", "index.cjs")], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      SERVER_STORE_DIR: storeDir,
      DATASTORE_SQLITE_PATH: dbPath,
      DATASTORE_READ_SOURCE: "sqlite",
      CURRENT_MATCH_SOURCE: "sqlite",
      ENABLE_SYNC_CRON: "0",
      ENABLE_GPT_CRON: "0",
      SYNC_WORKER_EVENT_BRIDGE: "0",
      RELAY_FAST_WATCHER_ENABLED: "0",
      V1_HEALTH_CACHE_TTL_MS: "1000",
      ADMIN_TOKEN: "generation-e2e-admin",
      ACCESS_CODE_ADMIN_TOKEN: "generation-e2e-admin",
      ACCESS_CODE_SECRET: "generation-e2e-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  server.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  await waitForServer(port, output);

  const created = await requestJson({
    port,
    method: "POST",
    pathname: "/api/admin/access-codes",
    body: { label: "generation-e2e" },
    headers: { authorization: "Bearer generation-e2e-admin" },
  });
  equal(created.status, 200, "test access code is created");
  check(Boolean(created.body?.code), "test access code is returned once");
  const verified = await requestJson({
    port,
    method: "POST",
    pathname: "/api/access/verify",
    body: { code: created.body.code },
  });
  equal(verified.status, 200, "test access code is verified");
  const token = verified.body?.session?.token;
  check(Boolean(token), "test session token is returned");

  // The server has already resolved and leased the immutable publication.
  // Corrupt only the generation history bytes while issuing the SQLite-backed
  // current+transition read: any accidental JSON fallback now fails its hash
  // check, while the intended atomic SQLite path remains available.
  const historyPath = path.join(
    storePaths(storeDir).generationsDir,
    expectedIdentity.generationId,
    "matches-history.json",
  );
  const historyBytes = fs.readFileSync(historyPath);
  const tamperedHistoryBytes = Buffer.from(historyBytes);
  tamperedHistoryBytes[0] ^= 1;
  fs.writeFileSync(historyPath, tamperedHistoryBytes);
  let syncMeta;
  let current;
  try {
    [syncMeta, current] = await Promise.all([
      requestJson({ port, pathname: "/api/v1/sync-meta" }),
      requestJson({
        port,
        pathname: "/api/v1/matches/current?view=list&transition=1",
        headers: { "x-access-token": token },
      }),
    ]);
  } finally {
    fs.writeFileSync(historyPath, historyBytes);
  }
  equal(syncMeta.status, 200, "sync-meta API is available");
  equal(current.status, 200, "current API is available");
  check(samePublicationIdentity(syncMeta.body?.publication, expectedIdentity), "sync-meta exposes active publication identity");
  check(samePublicationIdentity(current.body?.publication, expectedIdentity), "current exposes active publication identity");
  check(samePublicationIdentity(syncMeta.body?.publication, current.body?.publication), "both APIs expose the same publication identity");
  equal(current.body?.rows?.[0]?.id, expectedMatchId, "current API serves the immutable generation row");
  equal(current.body?.dataSource, "sqlite", "matching SQLite generation is accepted as base-ready");
  equal(
    current.body?.transition?.source,
    "sqlite-atomic",
    "atomic SQLite transition read never parses generation matches-history.json",
  );
};

const startApiAndVerifyPreviousPairCatchUp = async ({ previousIdentity, activeIdentity }) => {
  const port = 24000 + Math.floor(Math.random() * 12000);
  const output = [];
  server = spawn(process.execPath, [path.join(rootDir, "server", "index.cjs")], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      SERVER_STORE_DIR: storeDir,
      DATASTORE_SQLITE_PATH: dbPath,
      DATASTORE_READ_SOURCE: "sqlite",
      CURRENT_MATCH_SOURCE: "sqlite",
      ENABLE_SYNC_CRON: "0",
      ENABLE_GPT_CRON: "0",
      SYNC_WORKER_EVENT_BRIDGE: "0",
      RELAY_FAST_WATCHER_ENABLED: "0",
      V1_HEALTH_CACHE_TTL_MS: "1000",
      ADMIN_TOKEN: "generation-e2e-admin",
      ACCESS_CODE_ADMIN_TOKEN: "generation-e2e-admin",
      ACCESS_CODE_SECRET: "generation-e2e-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  server.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  await waitForServer(port, output);

  const created = await requestJson({
    port,
    method: "POST",
    pathname: "/api/admin/access-codes",
    body: { label: "generation-previous-pair-e2e" },
    headers: { authorization: "Bearer generation-e2e-admin" },
  });
  const verified = await requestJson({
    port,
    method: "POST",
    pathname: "/api/access/verify",
    body: { code: created.body?.code },
  });
  const token = verified.body?.session?.token;
  check(Boolean(token), "previous-pair test session is authorized");

  const readCurrent = () => requestJson({
    port,
    pathname: "/api/v1/matches/current?view=list&transition=1",
    headers: { "x-access-token": token },
  });
  const [beforeMeta, beforeCurrent, beforeHealth] = await Promise.all([
    requestJson({ port, pathname: "/api/v1/sync-meta" }),
    readCurrent(),
    requestJson({ port, pathname: "/api/v1/health" }),
  ]);
  equal(beforeMeta.status, 200, "cold start remains available while current pointer is ahead of SQLite");
  check(
    samePublicationIdentity(beforeMeta.body?.publication, previousIdentity),
    "cold start selects the SQLite-matched previous publication",
  );
  check(
    samePublicationIdentity(beforeCurrent.body?.publication, previousIdentity),
    "current list remains on the same previous publication pair",
  );
  equal(beforeCurrent.body?.rows?.[0]?.id, "match-generation-1", "cold start never exposes unpaired current rows");
  equal(beforeCurrent.body?.dataSource, "sqlite-previous-pair", "paired fallback is explicit in the API source");
  equal(beforeHealth.body?.storage?.sqlite?.baseReady, true, "previous-pair SQLite is base-ready without pretending to be current");
  equal(beforeHealth.body?.data?.currentRead?.source, "sqlite-previous-pair", "health exposes the paired fallback source");

  const syncLockDir = path.join(storeDir, "locks", "sync.lock");
  fs.mkdirSync(syncLockDir, { recursive: true });
  fs.writeFileSync(path.join(syncLockDir, "lock.json"), `${JSON.stringify({
    version: 1,
    owner: "generation-e2e-pair-refresh",
    source: "verify:data-generation-e2e",
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    lockDir: syncLockDir,
  }, null, 2)}\n`);
  let caughtUpExport = null;
  try {
    caughtUpExport = runExporter();
    check(
      samePublicationIdentity(caughtUpExport.publication, activeIdentity),
      "SQLite catch-up export binds the active generation",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const transitionHealth = await requestJson({ port, pathname: "/api/v1/health" });
    equal(
      transitionHealth.body?.data?.currentRead?.source,
      "generation-pair-refresh",
      "SQLite catch-up explicitly serves the already validated immutable generation",
    );
    equal(
      transitionHealth.body?.storage?.sqlite?.baseReady,
      false,
      "raw SQLite diagnostics remain fail-closed until the publication pair catches up",
    );
  } finally {
    fs.rmSync(syncLockDir, { recursive: true, force: true });
  }
  const deadline = Date.now() + 15_000;
  let afterMeta = null;
  let afterCurrent = null;
  while (Date.now() < deadline) {
    [afterMeta, afterCurrent] = await Promise.all([
      requestJson({ port, pathname: "/api/v1/sync-meta" }),
      readCurrent(),
    ]);
    if (
      samePublicationIdentity(afterMeta.body?.publication, activeIdentity)
      && samePublicationIdentity(afterCurrent.body?.publication, activeIdentity)
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(
    samePublicationIdentity(afterMeta?.body?.publication, activeIdentity),
    "running server switches to current only after SQLite identity catches up",
  );
  check(
    samePublicationIdentity(afterCurrent?.body?.publication, activeIdentity),
    "current list switches atomically with the caught-up SQLite pair",
  );
  equal(afterCurrent?.body?.rows?.[0]?.id, "match-generation-2", "caught-up pair exposes the new current row");
  equal(afterCurrent?.body?.dataSource, "sqlite", "caught-up pair returns to the active SQLite source");
};

const postgresAuditRows = (auditFile) => {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const waitForCondition = async (predicate, message, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
};

const verifyPostgresPrimaryColdStartPairing = async ({ previousIdentity, activeIdentity }) => {
  const fixtureRoot = path.join(tempRoot, "postgres-primary-cold-start");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const preloadPath = writePostgresPrimaryMockPreload(fixtureRoot);
  const previousProjectionIdentity = activeProjectionIdentityFor(previousIdentity);
  const activeProjectionIdentity = activeProjectionIdentityFor(activeIdentity);

  const createFixture = (name, { includeSqlite = true } = {}) => {
    const fixtureDir = path.join(fixtureRoot, name);
    const fixtureStoreDir = path.join(fixtureDir, "store");
    const fixturePublicDataDir = path.join(fixtureDir, "public-data");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.cpSync(storeDir, fixtureStoreDir, { recursive: true });
    fs.cpSync(publicDataDir, fixturePublicDataDir, { recursive: true });
    const fixtureDbPath = path.join(fixtureStoreDir, "football.db");
    if (!includeSqlite) {
      fs.rmSync(fixtureDbPath, { force: true });
      fs.rmSync(`${fixtureDbPath}-wal`, { force: true });
      fs.rmSync(`${fixtureDbPath}-shm`, { force: true });
    }
    return {
      fixtureDir,
      fixtureStoreDir,
      fixturePublicDataDir,
      fixtureDbPath,
      identityFile: path.join(fixtureDir, "postgres-identity.json"),
      auditFile: path.join(fixtureDir, "postgres-audit.jsonl"),
    };
  };

  const missingSqlite = createFixture("missing-sqlite", { includeSqlite: false });
  writePostgresIdentityState(missingSqlite.identityFile, { publication: activeProjectionIdentity });
  const missingStart = await startPostgresPrimaryApi({
    targetStoreDir: missingSqlite.fixtureStoreDir,
    targetDbPath: missingSqlite.fixtureDbPath,
    identityFile: missingSqlite.identityFile,
    auditFile: missingSqlite.auditFile,
    preloadPath,
    waitForReady: false,
  });
  const missingExitCode = await waitForProcessExit(server);
  check(missingExitCode !== 0, "PostgreSQL-primary cold start fails when SQLite identity is unavailable");
  check(
    missingStart.output.join("").includes("SQLITE_PUBLICATION_IDENTITY_UNAVAILABLE"),
    "missing SQLite startup failure exposes the exact fail-closed reason",
  );

  const mismatched = createFixture("mismatched-database-pair");
  writePostgresIdentityState(mismatched.identityFile, { publication: activeProjectionIdentity });
  const mismatchedStart = await startPostgresPrimaryApi({
    targetStoreDir: mismatched.fixtureStoreDir,
    targetDbPath: mismatched.fixtureDbPath,
    identityFile: mismatched.identityFile,
    auditFile: mismatched.auditFile,
    preloadPath,
    waitForReady: false,
  });
  const mismatchExitCode = await waitForProcessExit(server);
  check(mismatchExitCode !== 0, "PostgreSQL-primary cold start rejects a mismatched PostgreSQL/SQLite pair");
  check(
    mismatchedStart.output.join("").includes("PUBLICATION_DATABASE_PAIR_MISMATCH"),
    "database pair mismatch exposes the exact fail-closed reason",
  );

  const catchUp = createFixture("previous-to-active-catch-up");
  writePostgresIdentityState(catchUp.identityFile, { publication: previousProjectionIdentity });
  const running = await startPostgresPrimaryApi({
    targetStoreDir: catchUp.fixtureStoreDir,
    targetDbPath: catchUp.fixtureDbPath,
    identityFile: catchUp.identityFile,
    auditFile: catchUp.auditFile,
    preloadPath,
  });
  const before = await requestJson({ port: running.port, pathname: "/api/v1/sync-meta" });
  equal(before.status, 200, "PostgreSQL-primary starts on a complete previous database pair");
  check(
    samePublicationIdentity(before.body?.publication, previousIdentity),
    "PostgreSQL-primary cold start binds the immutable previous generation selected by both databases",
  );

  writePostgresIdentityState(catchUp.identityFile, {
    available: false,
    reason: "injected resolver identity query failure",
  });
  await waitForCondition(
    () => postgresAuditRows(catchUp.auditFile).find((row) => row.isMainThread === false && row.available === false),
    "previous-generation resolver did not perform its bounded five-second PostgreSQL recheck",
    8_000,
  );
  const afterQueryFailure = await requestJson({ port: running.port, pathname: "/api/v1/sync-meta" });
  check(
    samePublicationIdentity(afterQueryFailure.body?.publication, previousIdentity),
    "a failed PostgreSQL recheck preserves the complete previous pair",
  );

  writePostgresIdentityState(catchUp.identityFile, { publication: activeProjectionIdentity });
  const caughtUpExport = runExporter({
    targetStoreDir: catchUp.fixtureStoreDir,
    targetDbPath: catchUp.fixtureDbPath,
    targetPublicDataDir: catchUp.fixturePublicDataDir,
  });
  check(
    samePublicationIdentity(caughtUpExport.publication, activeIdentity),
    "isolated SQLite catch-up binds the active generation before publication switches",
  );
  const after = await waitForCondition(async () => {
    const response = await requestJson({ port: running.port, pathname: "/api/v1/sync-meta" });
    return samePublicationIdentity(response.body?.publication, activeIdentity) ? response : null;
  }, "PostgreSQL-primary server did not switch from previous to the caught-up active database pair");
  equal(after.status, 200, "caught-up PostgreSQL-primary publication remains available");
  check(
    postgresAuditRows(catchUp.auditFile).some((row) => (
      row.isMainThread === false
      && row.available === true
      && row.generationId === activeIdentity.generationId
    )),
    "the active switch is backed by a real resolver-worker PostgreSQL identity read",
  );
  await stopServer();

  // Start healthy, then commit a new pair without any HTTP request to arm
  // refresh. This reproduces a quiet production server stuck two generations
  // behind when its first later request arrives during another writer lock.
  const silent = createFixture("active-cache-no-reader-catch-up");
  const silentPaths = storePaths(silent.fixtureStoreDir);
  const silentNextPointer = fs.readFileSync(silentPaths.currentPointer);
  fs.writeFileSync(silentPaths.currentPointer, fs.readFileSync(silentPaths.previousPointer));
  writePostgresIdentityState(silent.identityFile, { publication: previousProjectionIdentity });
  const silentServer = await startPostgresPrimaryApi({
    targetStoreDir: silent.fixtureStoreDir, targetDbPath: silent.fixtureDbPath,
    identityFile: silent.identityFile, auditFile: silent.auditFile, preloadPath,
  });
  fs.writeFileSync(silentPaths.currentPointer, silentNextPointer);
  writePostgresIdentityState(silent.identityFile, { publication: activeProjectionIdentity });
  runExporter({ targetStoreDir: silent.fixtureStoreDir, targetDbPath: silent.fixtureDbPath,
    targetPublicDataDir: silent.fixturePublicDataDir });
  await waitForCondition(() => postgresAuditRows(silent.auditFile).some(row => row.isMainThread === false
    && row.available === true && row.generationId === activeIdentity.generationId),
  "healthy idle server failed to discover a later committed pair without HTTP traffic", 8_000);
  check(true, "idle active server autonomously reads the new PostgreSQL pair before any post-commit HTTP request");
  const silentAfter = await waitForCondition(async () => {
    const response = await requestJson({ port: silentServer.port, pathname: "/api/v1/sync-meta" });
    return samePublicationIdentity(response.body?.publication, activeIdentity) ? response : null;
  }, "autonomously resolved publication did not become the served generation");
  equal(silentAfter.status, 200, "autonomous idle catch-up serves the verified generation");
  const idleResolverCount = postgresAuditRows(silent.auditFile).filter(row => row.isMainThread === false).length;
  await new Promise(resolve => setTimeout(resolve, 5_500));
  equal(postgresAuditRows(silent.auditFile).filter(row => row.isMainThread === false).length, idleResolverCount,
    "unchanged healthy pointer polling does not spawn additional full resolver workers");
  await stopServer();

  const activeCache = createFixture("active-cache-pointer-rotation");
  const activeCachePaths = storePaths(activeCache.fixtureStoreDir);
  const nextPointerBytes = fs.readFileSync(activeCachePaths.currentPointer);
  const previousPointerBytes = fs.readFileSync(activeCachePaths.previousPointer);
  fs.writeFileSync(activeCachePaths.currentPointer, previousPointerBytes);
  const initialActivePublication = resolveActivePublication({
    storeDir: activeCache.fixtureStoreDir,
    publicDataDir: activeCache.fixturePublicDataDir,
  });
  writePostgresIdentityState(activeCache.identityFile, { publication: previousProjectionIdentity });
  const activeCacheServer = await startPostgresPrimaryApi({
    targetStoreDir: activeCache.fixtureStoreDir,
    targetDbPath: activeCache.fixtureDbPath,
    identityFile: activeCache.identityFile,
    auditFile: activeCache.auditFile,
    preloadPath,
  });
  const activeCacheBefore = await requestJson({
    port: activeCacheServer.port,
    pathname: "/api/v1/sync-meta",
  });
  check(
    samePublicationIdentity(activeCacheBefore.body?.publication, initialActivePublication.identity),
    "PostgreSQL-primary initially caches the active G1 publication only while the pointers and DB pair agree",
  );

  writePostgresIdentityState(activeCache.identityFile, {
    available: false,
    reason: "injected pointer-rotation resolver failure",
  });
  const initialWriterLock = path.join(activeCache.fixtureStoreDir, "locks", "sync.lock");
  fs.mkdirSync(initialWriterLock, { recursive: true });
  fs.writeFileSync(path.join(initialWriterLock, "lock.json"), JSON.stringify({
    version: 1, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(),
    owner: "r688-initial-lock-test", lockDir: initialWriterLock,
  }));
  fs.writeFileSync(activeCachePaths.currentPointer, nextPointerBytes);
  await requestJson({ port: activeCacheServer.port, pathname: "/api/v1/sync-meta" });
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  check(!postgresAuditRows(activeCache.auditFile).some((row) => row.isMainThread === false),
    "initial locked request arms a timer without starting any resolver worker");
  fs.rmSync(initialWriterLock, { recursive: true, force: true });
  await waitForCondition(
    () => postgresAuditRows(activeCache.auditFile).find((row) => (
      row.isMainThread === false && row.available === false
    )),
    "writer release did not automatically invoke resolver without a new HTTP request",
    8_000,
  );
  const activeCacheAfterFailure = await requestJson({
    port: activeCacheServer.port,
    pathname: "/api/v1/sync-meta",
  });
  check(
    samePublicationIdentity(activeCacheAfterFailure.body?.publication, initialActivePublication.identity),
    "resolver failure preserves the cached active G1 publication instead of exposing unpaired G2",
  );

  // Keep an old read snapshot open: the real exporter must commit G2 in WAL
  // while PASSIVE checkpoint cannot rewrite the main database. The running
  // server already cached G1 above, reproducing production without a restart.
  const pinnedWalReader = new DatabaseSync(activeCache.fixtureDbPath, { readOnly: true });
  const writerLock = path.join(activeCache.fixtureStoreDir, "locks", "sync.lock");
  fs.mkdirSync(writerLock, { recursive: true });
  fs.writeFileSync(path.join(writerLock, "lock.json"), JSON.stringify({
    version: 1, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(),
    owner: "r688-writer-barrier-test", lockDir: writerLock,
  }));
  try {
    pinnedWalReader.exec("BEGIN");
    pinnedWalReader.prepare("SELECT value FROM schema_meta WHERE key='data_generation_id'").get();
    const mainFileBeforeWalExport = fs.statSync(activeCache.fixtureDbPath, { bigint: true });
    writePostgresIdentityState(activeCache.identityFile, { publication: activeProjectionIdentity });
    const walExport = runExporter({
      targetStoreDir: activeCache.fixtureStoreDir,
      targetDbPath: activeCache.fixtureDbPath,
      targetPublicDataDir: activeCache.fixturePublicDataDir,
    });
    check(samePublicationIdentity(walExport.publication, activeIdentity), "WAL exporter commits complete G2 projection");
    const mainFileAfterWalExport = fs.statSync(activeCache.fixtureDbPath, { bigint: true });
    equal(
      ["dev", "ino", "size", "mtimeNs", "ctimeNs"].map((key) => String(mainFileAfterWalExport[key])),
      ["dev", "ino", "size", "mtimeNs", "ctimeNs"].map((key) => String(mainFileBeforeWalExport[key])),
      "WAL-only export leaves every formerly cached main-file stat field unchanged",
    );
    // Let an already armed timer fire while the writer is active. It must
    // re-arm, not bypass the barrier or depend on another HTTP request.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    check(!postgresAuditRows(activeCache.auditFile).some((row) => row.isMainThread === false
      && row.available === true && row.generationId === activeIdentity.generationId),
    "timer recheck respects active writer lock even after complete WAL commit");
    fs.rmSync(writerLock, { recursive: true, force: true });
    await waitForCondition(
      () => postgresAuditRows(activeCache.auditFile).find((row) => (
        row.isMainThread === false
        && row.available === true
        && row.generationId === activeIdentity.generationId
      )),
      "cached active G1 did not receive the automatic bounded PostgreSQL recheck",
      8_000,
    );
    const activeCacheAfter = await waitForCondition(async () => {
      const response = await requestJson({
        port: activeCacheServer.port,
        pathname: "/api/v1/sync-meta",
      });
      return samePublicationIdentity(response.body?.publication, activeIdentity) ? response : null;
    }, "cached active G1 did not switch after the G2 database pair caught up");
    equal(activeCacheAfter.status, 200, "active-cache recovery switches atomically to G2 before WAL checkpoint");
  } finally {
    fs.rmSync(writerLock, { recursive: true, force: true });
    pinnedWalReader.exec("ROLLBACK");
    pinnedWalReader.close();
  }
  await stopServer();
};

const stopServer = async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
};

(async () => {
  try {
    verifyBoundedReceiptTransitionSelection();
    const semanticFixture = semanticHashCompatibilityFixture();
    equal(
      bundleSemanticHash(semanticFixture),
      legacyBundleSemanticHash(semanticFixture),
      "streaming semantic hash is byte-compatible with the legacy canonical projection",
    );

    writeBundle({ cycle: "cycle-1", matchId: "match-generation-1" });
    const first = commitCurrentDataGeneration({ storeDir, publicDataDir });
    check(first.committed, "first generation commits");
    equal(first.validation.currentRows, 1, "semantic validator counts current rows");
    const firstSourcePayloads = new Map(CORE_FILES.map((relativePath) => [
      relativePath,
      JSON.parse(fs.readFileSync(path.join(publicDataDir, relativePath), "utf8")),
    ]));
    equal(
      first.semanticHash,
      bundleSemanticHash(firstSourcePayloads),
      "single-pass validation computes the established semantic hash without changing its bytes",
    );
    const generationPaths = storePaths(storeDir);
    const firstGenerationCount = fs.readdirSync(generationPaths.generationsDir).length;
    writeBundle({ cycle: "cycle-1-refresh", matchId: "match-generation-1" });
    const semanticNoop = commitCurrentDataGeneration({ storeDir, publicDataDir });
    equal(semanticNoop.semanticNoop, true, "clock/source-cycle-only refresh is a semantic no-op");
    equal(semanticNoop.pointer.generationId, first.pointer.generationId, "semantic no-op reuses active generation");
    equal(
      fs.readdirSync(generationPaths.generationsDir).length,
      firstGenerationCount,
      "semantic no-op does not create another generation directory",
    );

    writeBundle({ cycle: "cycle-source-race", matchId: "match-source-race" });
    let sourceMutatedDuringStage = false;
    assert.throws(
      () => commitCurrentDataGeneration({
        storeDir,
        publicDataDir,
        faultInjector: (point, details) => {
          if (point === "after-file-fsync" && details.fileIndex === 0 && !sourceMutatedDuringStage) {
            sourceMutatedDuringStage = true;
            writeJson("matches-current.json", [
              match("match-source-race-mutated", "cycle-source-race", "Mutated During Stage"),
            ]);
          }
          return false;
        },
      }),
      (error) => error?.code === "SOURCE_FILE_CHANGED",
      "disk-backed staging rejects a mutable source changed after validation",
    );
    checks += 1;
    equal(
      resolveActivePublication({ storeDir, publicDataDir }).identity.generationId,
      first.pointer.generationId,
      "source mutation during staging cannot rotate the active pointer",
    );

    // Attack the mutable public source after commit.  Export must remain bound
    // to the immutable directory resolved by the generation pointer.
    writeBundle({ cycle: "mutable-tamper", matchId: "match-mutable-tamper", home: "Tampered" });
    const firstExport = runExporter();
    equal(firstExport.publication.generationId, first.pointer.generationId, "export reports first generation identity");
    const firstRows = await readSqliteCurrentMatches(dbPath, { publicationIdentity: firstExport.publication });
    equal(firstRows[0]?.id, "match-generation-1", "mutable public tamper cannot affect generation export");
    const firstMeta = readDbMeta();
    equal(firstMeta.data_generation_id, first.pointer.generationId, "SQLite records generation id");
    equal(firstMeta.manifest_hash, first.pointer.manifestHash, "SQLite records manifest hash");
    equal(firstMeta.source_cycle_id, first.pointer.sourceCycleId, "SQLite records source cycle id");
    equal(
      firstMeta.data_generation_source_cycle_id,
      first.pointer.sourceCycleId,
      "SQLite keeps an immutable base source cycle beside fast overlays",
    );
    equal(firstMeta.committed_at, first.pointer.committedAt, "SQLite records committedAt");

    const firstPublication = resolveActivePublication({ storeDir, publicDataDir });
    const optionalEvaluationPath = path.join(
      firstPublication.context.generationDir,
      "model-evaluation.json",
    );
    const optionalEvaluationBytes = fs.readFileSync(optionalEvaluationPath);
    fs.rmSync(optionalEvaluationPath);
    equal(
      readPublicationJson(firstPublication, "model-evaluation.json", null),
      null,
      "a late optional generation-file loss degrades to the explicit fallback",
    );
    fs.writeFileSync(optionalEvaluationPath, optionalEvaluationBytes);
    let competingWriterPassed = false;
    const guardedCommitResult = commitWithActivePublicationPointerLock({
      storeDir,
      expected: firstPublication,
      timeoutMs: 1_000,
      staleMs: 60_000,
      commit: () => {
        check(generationPaths.pointerLockDir && fs.existsSync(generationPaths.pointerLockDir),
          "pointer-guarded commit callback runs inside the shared writer critical section");
        assert.throws(
          () => {
            commitCurrentDataGeneration({
              storeDir,
              publicDataDir,
              pointerLockTimeoutMs: 25,
              pointerLockStaleMs: 60_000,
            });
            competingWriterPassed = true;
          },
          (error) => error?.code === "POINTER_LOCK_TIMEOUT",
          "a supported pointer writer is blocked until the guarded commit finishes",
        );
        checks += 1;
        return "guarded-commit-finished";
      },
    });
    equal(guardedCommitResult, "guarded-commit-finished", "guarded commit returns its callback result");
    equal(competingWriterPassed, false, "blocked pointer writer cannot cross the guarded commit boundary");
    equal(fs.existsSync(generationPaths.pointerLockDir), false, "guarded commit releases the pointer lock in finally");
    assert.throws(
      () => commitWithActivePublicationPointerLock({
        storeDir,
        expected: firstPublication,
        commit: () => { throw new Error("guarded-commit-test-failure"); },
      }),
      /guarded-commit-test-failure/,
      "guarded commit propagates a callback failure",
    );
    checks += 1;
    equal(fs.existsSync(generationPaths.pointerLockDir), false,
      "guarded commit releases the pointer lock when its callback fails");

    writeBundle({ cycle: "cycle-2", matchId: "match-generation-2" });
    const second = commitCurrentDataGeneration({ storeDir, publicDataDir });
    const secondPublication = resolveActivePublication({ storeDir, publicDataDir });
    equal(secondPublication.identity.generationId, second.pointer.generationId, "second pointer becomes active");
    const mismatchedStatus = await getSqliteStatus(dbPath, { publicationIdentity: secondPublication.identity });
    equal(mismatchedStatus.baseReady, false, "stale SQLite generation is not base-ready");
    equal(
      await readSqliteCurrentMatches(dbPath, { publicationIdentity: secondPublication.identity }),
      [],
      "generation-mismatched SQLite read fails closed",
    );
    const staleSqliteIdentity = readSqlitePublicationIdentity(dbPath);
    equal(staleSqliteIdentity.available, true, "stale SQLite publication identity remains readable");
    const previousPair = resolveServingPublicationForSqliteIdentity({
      storeDir,
      publicDataDir,
      sqliteIdentity: staleSqliteIdentity.publication,
      allowPrevious: true,
    });
    equal(previousPair.mode, "previous-generation", "SQLite identity selects the exact immutable previous generation");
    equal(
      readPublicationJson(previousPair, "matches-current.json", [])[0]?.id,
      "match-generation-1",
      "previous-pair fallback never reads the newly committed generation",
    );
    equal(
      (await readSqliteCurrentMatches(dbPath, { publicationIdentity: previousPair.identity }))[0]?.id,
      "match-generation-1",
      "previous generation and SQLite are served only as one matching pair",
    );
    assert.throws(
      () => resolveServingPublicationForSqliteIdentity({
        storeDir,
        publicDataDir,
        sqliteIdentity: {
          mode: "active-generation",
          generationId: `g-${"f".repeat(64)}`,
          manifestHash: "f".repeat(64),
          sourceCycleId: "uncommitted-staging",
          committedAt: "2026-08-02T00:00:00.000Z",
        },
        allowPrevious: true,
      }),
      (error) => error?.code === "PUBLICATION_SQLITE_IDENTITY_MISMATCH",
      "an SQLite identity matching neither committed pointer fails closed",
    );
    checks += 1;

    await verifyPostgresPrimaryColdStartPairing({
      previousIdentity: previousPair.identity,
      activeIdentity: secondPublication.identity,
    });
    await stopServer();

    await startApiAndVerifyPreviousPairCatchUp({
      previousIdentity: previousPair.identity,
      activeIdentity: secondPublication.identity,
    });
    await stopServer();

    const secondExport = runExporter();
    check(samePublicationIdentity(secondExport.publication, secondPublication.identity), "second export binds exact active pointer");
    const readyStatus = await getSqliteStatus(dbPath, { publicationIdentity: secondPublication.identity });
    equal(readyStatus.baseReady, true, "matching SQLite generation becomes base-ready");
    equal(
      (await readSqliteCurrentMatches(dbPath, { publicationIdentity: secondPublication.identity }))[0]?.id,
      "match-generation-2",
      "second generation replaces the base rows",
    );

    await startApiAndVerifyIdentity(secondPublication.identity, "match-generation-2");
    await stopServer();

    const capturedForCas = resolveActivePublication({ storeDir, publicDataDir });
    writeBundle({ cycle: "cycle-3", matchId: "match-generation-3" });
    commitCurrentDataGeneration({ storeDir, publicDataDir });
    assert.throws(
      () => assertActivePublicationUnchanged({
        storeDir,
        publicDataDir,
        expected: capturedForCas,
      }),
      (error) => error?.code === "DATA_GENERATION_POINTER_CHANGED",
      "CAS rejects pointer rotation",
    );
    checks += 1;

    const generationIds = [first.pointer.generationId, second.pointer.generationId];
    const third = resolveActivePublication({ storeDir, publicDataDir });
    generationIds.push(third.identity.generationId);
    for (let cycle = 4; cycle <= 8; cycle += 1) {
      writeBundle({ cycle: `cycle-${cycle}`, matchId: `match-generation-${cycle}` });
      const committed = commitCurrentDataGeneration({ storeDir, publicDataDir });
      generationIds.push(committed.pointer.generationId);
    }
    const readerGenerationId = generationIds[2];
    const readerLease = acquireGenerationReadLease({
      storeDir,
      generationId: readerGenerationId,
      owner: "generation-e2e-reader",
      ttlMs: 60_000,
    });
    const outsideCandidate = path.join(tempRoot, generationIds[0]);
    equal(safeGenerationCandidate({
      generationsDir: generationPaths.generationsDir,
      candidatePath: outsideCandidate,
      generationId: generationIds[0],
    }), false, "path escaping generations root is never a cleanup candidate");
    const unknownDirectory = path.join(generationPaths.generationsDir, "unknown-do-not-touch");
    fs.mkdirSync(unknownDirectory);
    const incompleteGenerationId = `g-${"f".repeat(64)}`;
    const incompleteDirectory = path.join(generationPaths.generationsDir, incompleteGenerationId);
    fs.mkdirSync(incompleteDirectory);
    fs.writeFileSync(path.join(incompleteDirectory, "incomplete.txt"), "do not delete", "utf8");
    const beforeFaultDirectories = fs.readdirSync(generationPaths.generationsDir).sort();
    assert.throws(
      () => cleanupDataGenerations({
        storeDir,
        retainCount: 4,
        graceMs: 0,
        faultInjector: "before-cleanup-delete",
      }),
      (error) => error?.code === "GENERATION_CLEANUP_FAULT_INJECTED",
      "cleanup fault injection happens before any generation deletion",
    );
    checks += 1;
    equal(
      fs.readdirSync(generationPaths.generationsDir).sort(),
      beforeFaultDirectories,
      "cleanup fault leaves generation directories unchanged",
    );
    const cleanup = cleanupDataGenerations({ storeDir, retainCount: 4, graceMs: 0 });
    check(cleanup.deleted.length >= 1, "cleanup removes non-retained complete generations");
    check(fs.existsSync(path.join(generationPaths.generationsDir, generationIds.at(-1))), "active generation is retained");
    check(fs.existsSync(path.join(generationPaths.generationsDir, generationIds.at(-2))), "previous generation is retained");
    check(fs.existsSync(path.join(generationPaths.generationsDir, readerGenerationId)), "active reader lease protects an old generation");
    check(fs.existsSync(unknownDirectory), "unknown directory is untouched");
    check(fs.existsSync(incompleteDirectory), "incomplete generation-shaped directory is untouched");
    readerLease.release();
    const cleanupAfterReader = cleanupDataGenerations({ storeDir, retainCount: 4, graceMs: 0 });
    check(cleanupAfterReader.deleted.includes(readerGenerationId), "released reader generation becomes cleanup-eligible");
    const completeRemaining = fs.readdirSync(generationPaths.generationsDir)
      .filter((name) => /^g-[a-f0-9]{64}$/.test(name) && name !== incompleteGenerationId)
      .length;
    check(completeRemaining >= 4, "cleanup retains at least four complete generations");

    fs.writeFileSync(generationPaths.currentPointer, "{broken-current", "utf8");
    const previous = resolveServingPublication({ storeDir, publicDataDir, allowPrevious: true });
    equal(previous.mode, "previous-generation", "damaged current pointer falls back only to immutable previous generation");
    equal(
      readPublicationJson(previous, "matches-current.json", [])[0]?.id,
      "match-generation-7",
      "previous generation remains immutable after current pointer damage",
    );
    fs.writeFileSync(generationPaths.previousPointer, "{broken-previous", "utf8");
    assert.throws(
      () => resolveServingPublication({ storeDir, publicDataDir, allowPrevious: true }),
      (error) => error?.code === "PUBLICATION_GENERATIONS_INVALID",
      "two damaged pointers fail closed instead of reading mutable public files",
    );
    checks += 1;

    console.log(JSON.stringify({
      ok: true,
      version: "immutable-base-generation-e2e-v1",
      checks,
      isolatedTempRoot: tempRoot,
      defaultServerDataTouched: false,
    }, null, 2));
  } finally {
    await stopServer();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
