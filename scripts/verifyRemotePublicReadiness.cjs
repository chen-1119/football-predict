const http = require("node:http");
const https = require("node:https");
const {
  publicHhadCompanionSchemaValid,
  findHhadCompanionSensitiveKeyLeaks,
  isNonNegativeInteger
} = require("./hhadCompanionPublicContract.cjs");
const { evaluateFallbackReadiness } = require("./fallbackReadiness.cjs");
const { shadowObservationAuditValid } = require("../src/services/candidateCaptureState.cjs");

const baseUrl = new URL(process.env.REMOTE_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.VERIFY_BASE_URL || "http://127.0.0.1:8788");
const requireHealthy = process.env.REMOTE_REQUIRE_HEALTHY === "1";
const requireSqlite = process.env.REMOTE_REQUIRE_SQLITE === "1";
const requireNativeStorage = process.env.REMOTE_REQUIRE_POSTGRES_ONLY === "1";
if (requireNativeStorage && requireSqlite) throw new Error("remote native readiness cannot require SQLite");
const requiredReadSource = String(process.env.REMOTE_REQUIRED_READ_SOURCE || (requireNativeStorage ? "postgres" : requireSqlite ? "sqlite" : "")).toLowerCase();
if (requireNativeStorage && requiredReadSource !== "postgres") throw new Error("remote native readiness requires PostgreSQL reads");
const requireSyncWorker = process.env.REMOTE_REQUIRE_SYNC_WORKER === "1";
const auditOnly = process.env.REMOTE_AUDIT_ONLY === "1";
const requestTimeoutMs = Math.max(5000, Number(process.env.REMOTE_REQUEST_TIMEOUT_MS || 20000));
const healthAttempts = Math.max(1, Number(process.env.REMOTE_HEALTH_ATTEMPTS || 6));
const healthRetryDelayMs = Math.max(500, Number(process.env.REMOTE_HEALTH_RETRY_DELAY_MS || 5000));
const sqliteReadyAttempts = Math.max(1, Number(process.env.REMOTE_SQLITE_READY_ATTEMPTS || healthAttempts));
const sqliteReadyRetryDelayMs = Math.max(500, Number(process.env.REMOTE_SQLITE_READY_RETRY_DELAY_MS || healthRetryDelayMs));
const syncWorkerAttempts = Math.max(1, Number(process.env.REMOTE_SYNC_WORKER_ATTEMPTS || healthAttempts));
const syncWorkerRetryDelayMs = Math.max(500, Number(process.env.REMOTE_SYNC_WORKER_RETRY_DELAY_MS || healthRetryDelayMs));
const minFallbackRunwaySeconds = Math.max(0, Number(process.env.REMOTE_MIN_FALLBACK_RUNWAY_SECONDS || 600));

const protectedStaticPaths = [
  "/matches.json",
  "/odds-history.json",
  "/data/matches-current.json",
  "/data/matches-history.json",
  "/data/odds-history.json",
  "/data/model-evaluation.json",
  "/data/model-calibration.json",
  "/data/model-strategy.json",
  "/data/prediction-snapshots.json",
  "/data/post-match-reviews.json",
  "/data/external-signals.json",
  "/data/ai-arena.json"
];

const request = (method, pathname, headers = {}) => {
  const target = new URL(pathname, baseUrl);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = transport.request(target, {
      method,
      timeout: requestTimeoutMs,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([, value]) => value !== undefined && value !== null && value !== "")
      )
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 256_000) {
          req.destroy();
        }
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          bytes: Buffer.byteLength(raw)
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", (error) => {
      resolve({
        status: 0,
        headers: {},
        body: null,
        bytes: 0,
        error: error.message || String(error)
      });
    });
    req.end();
  });
};

const requestText = (pathname, headers = {}, maxBytes = 2_000_000) => {
  const target = new URL(pathname, baseUrl);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    let raw = "";
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const req = transport.request(target, {
      method: "GET",
      timeout: requestTimeoutMs,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([, value]) => value !== undefined && value !== null && value !== "")
      )
    }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        if (Buffer.byteLength(raw) > maxBytes) {
          req.destroy(new Error(`response too large: ${pathname}`));
        }
      });
      res.on("end", () => {
        finish({
          status: res.statusCode,
          headers: res.headers,
          text: raw,
          bytes: Buffer.byteLength(raw)
        });
      });
      res.on("error", (error) => {
        finish({
          status: 0,
          headers: {},
          text: raw,
          bytes: Buffer.byteLength(raw),
          error: error.message || String(error)
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", (error) => {
      finish({
        status: 0,
        headers: {},
        text: raw,
        bytes: Buffer.byteLength(raw),
        error: error.message || String(error)
      });
    });
    req.end();
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finiteNumber = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const requestWithRetry = async (method, pathname, headers = {}, attempts = 1, delayMs = 1000) => {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await request(method, pathname, headers);
    if (last.status > 0) return last;
    if (attempt < attempts) await sleep(delayMs);
  }
  return last;
};

const requestTextWithRetry = async (
  pathname,
  headers = {},
  maxBytes = 2_000_000,
  attempts = 1,
  delayMs = 1000
) => {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await requestText(pathname, headers, maxBytes);
    if (last.status > 0) return { ...last, attempts: attempt };
    if (attempt < attempts) await sleep(delayMs);
  }
  return { ...(last || {}), attempts };
};

const pushCheck = (checks, name, ok, details = {}, required = true) => {
  checks.push({ name, required, ...details, ok: Boolean(ok) });
};

const headerValue = (headers, name) => {
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value || "";
};

const cacheDirectives = (headers) => headerValue(headers, "cache-control")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const hasExactCacheDirectives = (headers, expected) => {
  const actual = cacheDirectives(headers);
  const normalizedExpected = expected.map((value) => value.toLowerCase());
  return actual.length === normalizedExpected.length
    && normalizedExpected.every((value) => actual.includes(value));
};

const normalizeAssetPath = (value) => {
  if (!value) return "";
  try {
    const target = new URL(value, baseUrl);
    return `${target.pathname}${target.search || ""}`;
  } catch {
    const normalized = String(value).replace(/^\.\//, "");
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const disallowsStaticPayload = (status) => [401, 403, 404, 410].includes(Number(status));

const sqliteFromHealth = (health) => health.body?.storage?.sqlite || {};
const postgresFromHealth = (health) => health.body?.storage?.postgres || {};
const currentReadFromHealth = (health) => health.body?.data?.currentRead || health.body?.currentRead || {};
const requiredStoreReady = (health) => {
  const sqlite = sqliteFromHealth(health);
  const postgres = postgresFromHealth(health);
  const currentRead = currentReadFromHealth(health);
  if (requiredReadSource === "postgres") {
    return postgres.available === true
      && postgres.baseReady !== false
      && !postgres.baseBlockedReason
      && currentRead.source === "postgres";
  }
  if (requiredReadSource === "sqlite") {
    return sqlite.available === true
      && sqlite.baseReady !== false
      && !sqlite.baseBlockedReason
      && currentRead.source === "sqlite";
  }
  return true;
};
const syncWorkerFromHealth = (health) => health.body?.sync || {};
const syncWorkerReady = (health) => {
  const sync = syncWorkerFromHealth(health);
  return sync.running === true && sync.workerRunning !== false && sync.workerOk !== false;
};

const waitForSqlitePrimary = async (initialHealth) => {
  if (!requiredReadSource || requiredStoreReady(initialHealth)) {
    return { health: initialHealth, attempts: 1 };
  }

  let health = initialHealth;
  for (let attempt = 2; attempt <= sqliteReadyAttempts; attempt += 1) {
    await sleep(sqliteReadyRetryDelayMs);
    health = await requestWithRetry("GET", "/api/v1/health", {}, 1, sqliteReadyRetryDelayMs);
    if (requiredStoreReady(health)) return { health, attempts: attempt };
  }

  return { health, attempts: sqliteReadyAttempts };
};

const waitForSyncWorkerReady = async (initialHealth) => {
  if (!requireSyncWorker || syncWorkerReady(initialHealth)) {
    return { health: initialHealth, attempts: 1 };
  }

  let health = initialHealth;
  for (let attempt = 2; attempt <= syncWorkerAttempts; attempt += 1) {
    await sleep(syncWorkerRetryDelayMs);
    health = await requestWithRetry("GET", "/api/v1/health", {}, 1, syncWorkerRetryDelayMs);
    if (syncWorkerReady(health)) return { health, attempts: attempt };
  }

  return { health, attempts: syncWorkerAttempts };
};

const findPublicPathLeaks = (value, location = "$", leaks = []) => {
  if (leaks.length >= 12) return leaks;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findPublicPathLeaks(item, `${location}[${index}]`, leaks));
    return leaks;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nested]) => {
      const nextLocation = `${location}.${key}`;
      if (/path/i.test(key)) {
        leaks.push({ location: nextLocation, reason: "path-like key" });
      }
      findPublicPathLeaks(nested, nextLocation, leaks);
    });
    return leaks;
  }
  if (typeof value === "string" && /([A-Za-z]:[\\/]|\/var\/lib\/|\/opt\/football-predict|\\Users\\)/.test(value)) {
    leaks.push({ location, reason: "path-like value" });
  }
  return leaks;
};

const run = async () => {
  const checks = [];

  const root = await request("GET", "/");
  pushCheck(checks, "site root reachable", root.status === 200 && root.bytes > 0, {
    status: root.status,
    bytes: root.bytes,
    cacheControl: headerValue(root.headers, "cache-control") || null,
    error: root.error || null
  });

  const rootHtml = await requestText("/", { "cache-control": "no-store" }, 512_000);
  const indexAssetPath = normalizeAssetPath(
    rootHtml.text?.match(/<script\b[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1]
  );
  const indexAsset = indexAssetPath
    ? await requestText(indexAssetPath, { "cache-control": "no-store" }, 2_000_000)
    : { status: 0, text: "", bytes: 0, error: "index asset not found" };
  const frontendRecoveryNeedles = [
    "football.assetReloadAt",
    "vite:preloadError",
    "unhandledrejection",
    "Cannot read (?:properties|property) of (?:undefined|null)",
    "over25|under25|bttsYes|bttsNo|goalLines|bothTeamsToScore|probabilities",
    "__assetReload",
    "location.replace"
  ];
  const missingRecoveryNeedles = frontendRecoveryNeedles.filter((needle) => !indexAsset.text?.includes(needle));
  const matchDetailAssetPaths = unique(
    [...(indexAsset.text || "").matchAll(/MatchDetail-[A-Za-z0-9_-]+\.js/g)]
      .map((match) => `/assets/${match[0]}`)
  );
  const matchDetailAssets = [];
  for (const pathname of matchDetailAssetPaths) {
    matchDetailAssets.push({
      pathname,
      response: await requestText(pathname, { "cache-control": "no-store" }, 2_000_000)
    });
  }
  const aiArenaAssetPaths = unique(
    [...(indexAsset.text || "").matchAll(/AIArena-[A-Za-z0-9_-]+\.js/g)]
      .map((match) => `/assets/${match[0]}`)
  );
  const aiArenaAssets = [];
  for (const pathname of aiArenaAssetPaths) {
    aiArenaAssets.push({
      pathname,
      response: await requestText(pathname, { "cache-control": "no-store" }, 2_000_000)
    });
  }
  const unsafeDetailProbabilityReads = matchDetailAssets.flatMap(({ pathname, response }) => [
    ...(response.text || "").matchAll(/(^|[^?])\.goalLines\.(over25|under25)/g),
    ...(response.text || "").matchAll(/(^|[^?])\.bothTeamsToScore\.(yes|no)/g),
    ...(response.text || "").matchAll(/(^|[^?])\.(before|after)\.(over25|under25)/g)
  ].map((match) => ({ asset: pathname, read: match[0].trim() })));
  pushCheck(checks, "frontend asset runtime recovers stale match detail errors", rootHtml.status === 200
    && indexAsset.status === 200
    && missingRecoveryNeedles.length === 0, {
      rootStatus: rootHtml.status,
      indexAssetPath: indexAssetPath || null,
      indexStatus: indexAsset.status,
      indexBytes: indexAsset.bytes,
      missingRecoveryNeedles,
      error: rootHtml.error || indexAsset.error || null
    });
  const reactDevelopmentMarkers = [
    "Download the React DevTools",
    "Each child in a list should have a unique"
  ].filter((marker) => indexAsset.text?.includes(marker));
  pushCheck(checks, "frontend bundle uses the React production runtime", indexAsset.status === 200
    && reactDevelopmentMarkers.length === 0, {
      indexAssetPath: indexAssetPath || null,
      indexStatus: indexAsset.status,
      indexBytes: indexAsset.bytes,
      developmentMarkers: reactDevelopmentMarkers
    });
  pushCheck(checks, "AI survival frontend chunk uses the protected v5 publication", aiArenaAssets.length > 0
    && aiArenaAssets.every(({ response }) => response.status === 200)
    && aiArenaAssets.some(({ response }) => response.text?.includes("/api/v1/ai-arena"))
    && aiArenaAssets.some(({ response }) => response.text?.includes("ai-big-five-survival-v5"))
    && aiArenaAssets.some(({ response }) => response.text?.includes("formalStatisticsExcluded")), {
    assets: aiArenaAssets.map(({ pathname, response }) => ({
      path: pathname,
      status: response.status,
      bytes: response.bytes
    }))
  });
  pushCheck(checks, "cache-control directives are canonical and emitted once",
    hasExactCacheDirectives(root.headers, ["no-store"])
      && hasExactCacheDirectives(indexAsset.headers, ["public", "max-age=31536000", "immutable"]), {
      rootCacheControl: headerValue(root.headers, "cache-control") || null,
      indexCacheControl: headerValue(indexAsset.headers, "cache-control") || null
    });
  const missingAsset = await request("GET", "/assets/__football_missing_cache_probe_7dc135c6.js");
  const missingAssetCache = cacheDirectives(missingAsset.headers);
  pushCheck(checks, "missing static assets are not cached as immutable", missingAsset.status === 404
    && !missingAssetCache.includes("immutable")
    && !missingAssetCache.some((directive) => /^max-age=(?:[1-9]\d*)$/.test(directive)), {
      status: missingAsset.status,
      cacheControl: headerValue(missingAsset.headers, "cache-control") || null,
      error: missingAsset.error || null
    });
  const [dotEnvProbe, packageProbe, robots, sitemap] = await Promise.all([
    request("GET", "/.env"),
    request("GET", "/package.json"),
    requestTextWithRetry("/robots.txt", { "cache-control": "no-store" }, 64_000, 3, 250),
    requestTextWithRetry("/sitemap.xml", { "cache-control": "no-store" }, 128_000, 3, 250)
  ]);
  pushCheck(checks, "source probes are 404 and crawler files are real", dotEnvProbe.status === 404
    && packageProbe.status === 404
    && robots.status === 200
    && /^User-agent:/m.test(robots.text || "")
    && sitemap.status === 200
    && /<urlset\b/.test(sitemap.text || "")
    && !/<div\s+id=["']root["']/.test(`${robots.text || ""}${sitemap.text || ""}`), {
      dotEnvStatus: dotEnvProbe.status,
      packageStatus: packageProbe.status,
      robotsStatus: robots.status,
      robotsAttempts: robots.attempts,
      sitemapStatus: sitemap.status,
      sitemapAttempts: sitemap.attempts
    });
  pushCheck(checks, "match detail chunk probability resilience", matchDetailAssets.length > 0
    && matchDetailAssets.every(({ response }) => response.status === 200)
    && unsafeDetailProbabilityReads.length === 0, {
      assets: matchDetailAssets.map(({ pathname, response }) => ({
        path: pathname,
        status: response.status,
        bytes: response.bytes,
        error: response.error || null
      })),
      unsafeReads: unsafeDetailProbabilityReads.slice(0, 12)
    });

  const legacyHealth = await requestWithRetry("GET", "/api/health", {}, healthAttempts, healthRetryDelayMs);
  pushCheck(checks, "legacy health reachable", legacyHealth.status === 200 && legacyHealth.body?.service === "football-predict-server", {
    status: legacyHealth.status,
    ok: legacyHealth.body?.ok ?? null,
    service: legacyHealth.body?.service || null,
    checkedAt: legacyHealth.body?.checkedAt || null,
    error: legacyHealth.error || null
  });

  let health = await requestWithRetry("GET", "/api/v1/health", {}, healthAttempts, healthRetryDelayMs);
  const sqliteWait = await waitForSqlitePrimary(health);
  health = sqliteWait.health;
  const syncWorkerWait = await waitForSyncWorkerReady(health);
  health = syncWorkerWait.health;
  const sqlite = sqliteFromHealth(health);
  const currentRead = currentReadFromHealth(health);
  pushCheck(checks, "v1 health reachable", health.status === 200 && health.body?.apiVersion === "v1", {
    status: health.status,
    ok: health.body?.ok ?? null,
    serviceOk: health.body?.status?.serviceOk ?? null,
    dataFresh: health.body?.status?.dataFresh ?? null,
    servingMode: health.body?.status?.servingMode || null,
    recommendationReliable: health.body?.status?.recommendationReliable ?? null,
    apiVersion: health.body?.apiVersion || null,
    checkedAt: health.body?.checkedAt || null,
    error: health.error || null
  });
  pushCheck(checks, "v1 service ready", health.body?.status?.serviceOk === true, {
    serviceOk: health.body?.status?.serviceOk ?? null,
    dataFresh: health.body?.status?.dataFresh ?? null,
    servingMode: health.body?.status?.servingMode || null
  });
  const recommendationCoverage = health.body?.data?.recommendations || {};
  const recommendationProjectionParity = recommendationCoverage.projectionParity || {};
  pushCheck(checks, "scheduled matches have an explicit BEST or WATCH disposition and atomically bound HHAD directions",
    recommendationCoverage.version === "current-recommendation-coverage-v6"
      && recommendationCoverage.coverageOk === true
      && health.body?.status?.recommendationCoverageOk === true
      && health.body?.status?.recommendationProjectionParityOk === true
      && Number(recommendationCoverage.missingDispositionMatches || 0) === 0
      && Number(recommendationCoverage.publicationDispositionMatches || 0)
        === Number(recommendationCoverage.scheduledMatches || 0)
      && Number(recommendationCoverage.bestDirectionMatches || 0)
        + Number(recommendationCoverage.watchMatches || 0)
        === Number(recommendationCoverage.scheduledMatches || 0)
      && Number(recommendationCoverage.missingDirectionMatches || 0)
        === Number(recommendationCoverage.watchMatches || 0)
      && Number(recommendationCoverage.hhadMissingDirectionMatches || 0) === 0
      && Number(recommendationCoverage.dualMarketAtomicMissingMatches || 0) === 0
      && Number(recommendationCoverage.hhadBoundDirectionMatches || 0)
        === Number(recommendationCoverage.hhadMarketMatches || 0)
      && Number(recommendationCoverage.dualMarketAtomicMatches || 0)
        === Number(recommendationCoverage.dualMarketEligibleMatches || 0)
      && recommendationCoverage.dualMarketAtomicCoverageOk === true
      && recommendationProjectionParity.version === "current-list-detail-recommendation-parity-v1"
      && recommendationProjectionParity.scope === "same-current-read-model-list-detail-projection"
      && recommendationProjectionParity.disclosure === "aggregate-counts-only"
      && Number(recommendationProjectionParity.mismatchRows || 0) === 0
      && recommendationProjectionParity.ok === true, {
      recommendationCoverageOk: health.body?.status?.recommendationCoverageOk ?? null,
      recommendationProjectionParityOk: health.body?.status?.recommendationProjectionParityOk ?? null,
      ...recommendationCoverage
    });
  const trainingAsset = health.body?.model?.trainingAsset || {};
  pushCheck(checks, "scheduled recommendations use signed historical training asset",
    health.body?.status?.signedTrainingAssetOk === true
      && trainingAsset.validationOk === true
      && trainingAsset.sourceKind === "signed-release-asset"
      && trainingAsset.entry === ".release-model-assets/historical-training-index.json"
      && /^[a-f0-9]{64}$/i.test(String(trainingAsset.sha256 || ""))
      && recommendationCoverage.trainingCoverageOk === true
      && Number(recommendationCoverage.trainingBackedMatches || 0)
        === Number(recommendationCoverage.scheduledMatches || 0), {
      signedTrainingAssetOk: health.body?.status?.signedTrainingAssetOk ?? null,
      trainingAsset,
      scheduledMatches: recommendationCoverage.scheduledMatches ?? null,
      trainingBackedMatches: recommendationCoverage.trainingBackedMatches ?? null,
      trainingInputSufficientMatches: recommendationCoverage.trainingInputSufficientMatches ?? null,
      trainingCoverageOk: recommendationCoverage.trainingCoverageOk ?? null
    });
  pushCheck(checks, "v1 health ok when required", !requireHealthy || health.body?.ok === true, {
    requiredByEnv: requireHealthy,
    ok: health.body?.ok ?? null
  }, requireHealthy);
  const healthStatus = health.body?.status || {};
  const fallbackReadiness = evaluateFallbackReadiness(healthStatus, minFallbackRunwaySeconds);
  pushCheck(checks, "fallback reliability runway", fallbackReadiness.ok, fallbackReadiness);
  const postgres = postgresFromHealth(health);
  if (requireNativeStorage) {
    const evidence = require("./nativeStorageReadiness.cjs").nativeStorageReadiness(health.body);
    pushCheck(checks, "PostgreSQL-only storage and receipt integrity", evidence.ok, evidence);
  }
  pushCheck(checks, "configured primary read source when required", !requiredReadSource || requiredStoreReady(health), {
    requiredByEnv: requireSqlite,
    requiredReadSource: requiredReadSource || null,
    sqliteAvailable: sqlite.available ?? null,
    sqliteReason: sqlite.reason || null,
    sqlitePath: sqlite.path || null,
    postgresAvailable: postgres.available ?? null,
    postgresBaseReady: postgres.baseReady ?? null,
    postgresBlockedReason: postgres.baseBlockedReason || null,
    readSource: currentRead.source || sqlite.readSource || null,
    sqliteCounts: sqlite.counts || null,
    attempts: sqliteWait.attempts,
    maxAttempts: requireSqlite ? sqliteReadyAttempts : 1,
    retryDelayMs: requireSqlite ? sqliteReadyRetryDelayMs : 0
  }, Boolean(requiredReadSource));
  const healthSync = syncWorkerFromHealth(health);
  pushCheck(checks, "sync worker health when required", !requireSyncWorker || syncWorkerReady(health), {
    requiredByEnv: requireSyncWorker,
    running: healthSync.running ?? null,
    apiSyncRunning: healthSync.apiSyncRunning ?? null,
    workerRunning: healthSync.workerRunning ?? null,
    workerOk: healthSync.workerOk ?? null,
    workerState: healthSync.workerState || null,
    workerCheckedAt: healthSync.workerCheckedAt || null,
    workerAgeSeconds: healthSync.workerAgeSeconds ?? null,
    nextWakeAt: healthSync.nextWakeAt || null,
    cadence: healthSync.cadence || null,
    attempts: syncWorkerWait.attempts,
    maxAttempts: requireSyncWorker ? syncWorkerAttempts : 1,
    retryDelayMs: requireSyncWorker ? syncWorkerRetryDelayMs : 0
  }, requireSyncWorker);

  const sourceHealth = await request("GET", "/api/v1/source-health");
  const sources = Array.isArray(sourceHealth.body?.sources) ? sourceHealth.body.sources : [];
  const fallbackCoverage = sourceHealth.body?.fallbackCoverage || null;
  pushCheck(checks, "source health public schema", sourceHealth.status === 200 && sources.length >= 4 && !sourceHealth.body?.admin, {
    status: sourceHealth.status,
    ok: sourceHealth.body?.ok ?? null,
    sourceIds: sources.map((source) => source.id).filter(Boolean),
    exposesAdmin: Boolean(sourceHealth.body?.admin),
    errors: sourceHealth.body?.errors || []
  });
  pushCheck(checks, "source health fallback coverage", sourceHealth.status === 200 && Boolean(fallbackCoverage?.servingMode), {
    status: sourceHealth.status,
    servingMode: fallbackCoverage?.servingMode || null,
    usable: fallbackCoverage?.usable ?? null,
    primaryStale: fallbackCoverage?.primaryStale ?? null,
    currentMatches: fallbackCoverage?.currentMatches ?? null,
    fiveHundredCoveragePercent: fallbackCoverage?.fiveHundredCoveragePercent ?? null
  });
  const sportterySource = sources.find((source) => source?.id === "sporttery") || null;
  const collectorEvidence = sportterySource?.metrics?.relaySnapshot?.collectorAttestation || null;
  const independenceDomains = Array.isArray(collectorEvidence?.independenceDomains)
    ? collectorEvidence.independenceDomains
    : [];
  const unassignedKeyIds = Array.isArray(collectorEvidence?.unassignedKeyIds)
    ? collectorEvidence.unassignedKeyIds
    : [];
  const trustedKeyCount = Number(collectorEvidence?.trustedKeyCount);
  const trustedCollectorCount = Number(collectorEvidence?.trustedCollectorCount);
  const officialSourceRedundancy = sourceHealth.body?.officialSourceRedundancy || null;
  const recentCollectorEvidenceStore = officialSourceRedundancy?.collectorEvidenceStore || null;
  const storeIndependenceDomains = Array.isArray(recentCollectorEvidenceStore?.independenceDomains)
    ? recentCollectorEvidenceStore.independenceDomains
    : [];
  const storeTrustedCollectorCount = Number(recentCollectorEvidenceStore?.trustedCollectorCount);
  const redundancyIndependenceDomains = Array.isArray(officialSourceRedundancy?.independenceDomains)
    ? officialSourceRedundancy.independenceDomains
    : [];
  const redundancyCollectorCount = Number(officialSourceRedundancy?.trustedCollectorCount);
  const combinedIndependenceDomains = Array.from(new Set([
    ...independenceDomains,
    ...storeIndependenceDomains,
  ]));
  pushCheck(checks, "trusted collector redundancy counts independent runtimes, not keys",
    collectorEvidence?.version === "trusted-market-collector-evidence-v1"
      && Number.isInteger(trustedKeyCount)
      && trustedKeyCount >= 1
      && Number.isInteger(trustedCollectorCount)
      && trustedCollectorCount === independenceDomains.length
      && trustedCollectorCount <= trustedKeyCount
      && unassignedKeyIds.length === 0
      && recentCollectorEvidenceStore?.version === "sporttery-recent-collector-evidence-summary-v1"
      && recentCollectorEvidenceStore?.trustRegistryAvailable === true
      && Number.isInteger(storeTrustedCollectorCount)
      && storeTrustedCollectorCount === storeIndependenceDomains.length
      && Number.isInteger(redundancyCollectorCount)
      && redundancyCollectorCount === combinedIndependenceDomains.length
      && redundancyCollectorCount === redundancyIndependenceDomains.length
      && redundancyIndependenceDomains.every((domain) => combinedIndependenceDomains.includes(domain)), {
      version: collectorEvidence?.version || null,
      trustedEndpoints: collectorEvidence?.trustedEndpoints ?? null,
      trustedKeyCount: Number.isFinite(trustedKeyCount) ? trustedKeyCount : null,
      relayTrustedCollectorCount: Number.isFinite(trustedCollectorCount) ? trustedCollectorCount : null,
      relayIndependenceDomainCount: independenceDomains.length,
      unassignedKeyCount: unassignedKeyIds.length,
      storeVersion: recentCollectorEvidenceStore?.version || null,
      storeTrustRegistryAvailable: recentCollectorEvidenceStore?.trustRegistryAvailable ?? null,
      storeTrustedCollectorCount: Number.isFinite(storeTrustedCollectorCount)
        ? storeTrustedCollectorCount
        : null,
      storeIndependenceDomainCount: storeIndependenceDomains.length,
      combinedIndependenceDomainCount: combinedIndependenceDomains.length,
      redundancyIndependenceDomainCount: redundancyIndependenceDomains.length,
      redundancyCollectorCount: Number.isFinite(redundancyCollectorCount)
        ? redundancyCollectorCount
        : null,
    });

  const sourceAdmin = await request("GET", "/api/v1/source-health?detail=admin");
  pushCheck(checks, "source health admin no-auth denied", sourceAdmin.status === 401, {
    status: sourceAdmin.status
  });

  const modelEvaluation = await request("GET", "/api/v1/model/evaluation");
  const modelShadow = modelEvaluation.body?.backtest?.shadowCandidates || {};
  const publicHhadCompanion = modelEvaluation.body?.publicScorecard?.shadowTracks?.HHAD_COMPANION || null;
  const publicCandidateProspective =
    modelEvaluation.body?.publicScorecard?.shadowTracks?.CANDIDATE_PROSPECTIVE || null;
  const backtestHhadCompanion = modelEvaluation.body?.backtest?.hhadCompanionEvaluation || null;
  const sampleHhadCompanion = modelEvaluation.body?.backtest?.sample?.hhadCompanion || null;
  const leaksCandidates = Array.isArray(modelShadow.candidates);
  const leaksStrategyRules = Boolean(modelEvaluation.body?.strategy?.activeGates || modelEvaluation.body?.strategy?.recommendations);
  const hhadSensitiveKeyLeaks = findHhadCompanionSensitiveKeyLeaks({
    publicHhadCompanion,
    backtestHhadCompanion,
    sampleHhadCompanion
  });
  const leaksHhadRows = hhadSensitiveKeyLeaks.length > 0;
  const pathLeaks = findPublicPathLeaks(modelEvaluation.body);
  pushCheck(checks, "model evaluation public redacted", modelEvaluation.status === 200
    && modelEvaluation.body?.publicView === true
    && !leaksCandidates
    && !leaksStrategyRules
    && !leaksHhadRows
    && publicHhadCompanion?.onlineEffect === "shadow"
    && publicHhadCompanion?.promotionAllowed === false
    && publicHhadCompanionSchemaValid(publicHhadCompanion)
    && publicHhadCompanionSchemaValid(backtestHhadCompanion)
    && isNonNegativeInteger(publicHhadCompanion?.counts?.pairedNonVoidRows)
    && isNonNegativeInteger(sampleHhadCompanion?.pairedNonVoidRows)
    && sampleHhadCompanion.pairedNonVoidRows === publicHhadCompanion.counts.pairedNonVoidRows
    && pathLeaks.length === 0, {
      status: modelEvaluation.status,
      publicView: modelEvaluation.body?.publicView ?? null,
      leaksCandidates,
      leaksStrategyRules,
      leaksHhadRows,
      hhadSensitiveKeyLeaks,
      hhadCompanionRows: publicHhadCompanion?.counts?.pairedNonVoidRows ?? null,
      hhadCompanionStatus: publicHhadCompanion?.candidateStatus || null,
      pathLeaks,
      probabilityRows: modelEvaluation.body?.summary?.probabilityRows ?? null,
      marketBaselineRows: modelEvaluation.body?.summary?.marketBaselineRows ?? null
    });
  const candidateDecisionRecord = publicCandidateProspective?.decisionRecord || null;
  const candidateSettlementRecord =
    publicCandidateProspective?.settlementRecord || null;
  const requiredCandidateDecisionFields = [
    "identity",
    "official-market-provenance",
    "odds",
    "base-model-probabilities",
    "candidate-probabilities",
    "devigged-market-probabilities",
    "feature-snapshot",
    "strategy-versions",
    "source-clock",
    "dual-market-decision-record",
    "dual-market-decision-hash",
    "temporal-ordering",
    "atomic-decision-hash",
  ];
  const requiredCandidateSettlementFields = [
    "decision-link",
    "official-result-identity",
    "score-outcome-consistency",
    "result-observation-clock",
    "result-provenance-hash",
  ];
  pushCheck(checks, "candidate prospective decisions are atomically auditable",
    modelEvaluation.status === 200
      && publicCandidateProspective?.chainValid === true
      && candidateDecisionRecord?.version === "candidate-atomic-decision-record-v3"
      && candidateDecisionRecord?.validationVersion
        === "candidate-atomic-decision-validation-v2"
      && candidateDecisionRecord?.dualMarketDecisionRecordVersion
        === "candidate-dual-market-decision-record-v1"
      && candidateDecisionRecord?.formalMetricMarket === "HAD"
      && candidateDecisionRecord?.companionMarket === "HHAD"
      && candidateDecisionRecord?.decisionDeadlinePolicyVersion
        === "official-cutoff-first-v1"
      && requiredCandidateDecisionFields.every((field) => (
        candidateDecisionRecord?.requiredFields?.includes(field)
      ))
      && Number(candidateDecisionRecord?.admittedRows || 0)
        === Number(candidateDecisionRecord?.atomicRows || 0)
      && Number(candidateDecisionRecord?.admittedRows || 0)
        === Number(candidateDecisionRecord?.completeRows || 0)
      && Number(candidateDecisionRecord?.failedRows || 0) === 0
      && Object.keys(candidateDecisionRecord?.blockerCounts || {}).length === 0
      && Number(candidateDecisionRecord?.coverage) === 1
      && candidateDecisionRecord?.complete === true
      && candidateSettlementRecord?.version
        === "candidate-official-settlement-record-v1"
      && candidateSettlementRecord?.validationVersion
        === "candidate-official-settlement-validation-v1"
      && requiredCandidateSettlementFields.every((field) => (
        candidateSettlementRecord?.requiredFields?.includes(field)
      ))
      && Number(candidateSettlementRecord?.rows || 0)
        === Number(candidateSettlementRecord?.completeRows || 0)
      && Number(candidateSettlementRecord?.failedRows || 0) === 0
      && Object.keys(candidateSettlementRecord?.blockerCounts || {}).length === 0
      && Number(candidateSettlementRecord?.coverage) === 1
      && candidateSettlementRecord?.complete === true
      && !Object.hasOwn(publicCandidateProspective, "featureSnapshot")
      && !Object.hasOwn(publicCandidateProspective, "sourceClock")
      && !Object.hasOwn(publicCandidateProspective, "strategyVersions"), {
      status: modelEvaluation.status,
      candidateRevisionId: publicCandidateProspective?.candidateRevisionId || null,
      chainValid: publicCandidateProspective?.chainValid ?? null,
      decisionRecord: candidateDecisionRecord,
      settlementRecord: candidateSettlementRecord,
      exposesFeaturePayload: Object.hasOwn(publicCandidateProspective || {}, "featureSnapshot"),
      exposesSourceClock: Object.hasOwn(publicCandidateProspective || {}, "sourceClock"),
      exposesStrategyVersions:
        Object.hasOwn(publicCandidateProspective || {}, "strategyVersions"),
    });
  const candidateCaptureHeartbeat = publicCandidateProspective?.captureHeartbeat || null;
  const candidateReadiness = candidateCaptureHeartbeat?.readiness || null;
  const candidateHasFullCoverageMetadata = [
    "previewLimit",
    "evaluatedMatches",
    "detailedMatches",
    "rowsTruncated",
  ].every((field) => Object.hasOwn(candidateReadiness || {}, field));
  const candidateUpcomingMatches = Number(candidateReadiness?.upcomingMatches || 0);
  const candidateEvaluatedMatches = Number(candidateReadiness?.evaluatedMatches || 0);
  const candidateDetailedMatches = Number(candidateReadiness?.detailedMatches || 0);
  const candidateRowsTruncated = Number(candidateReadiness?.rowsTruncated || 0);
  const candidatePreviewLimit = Number(candidateReadiness?.previewLimit || 0);
  const candidateReadyNow = Number(candidateReadiness?.readyNow || 0);
  const candidateAtomicReadyNow = Number(candidateReadiness?.atomicReadyNow || 0);
  const candidateAwaitingMarket = Number(candidateReadiness?.awaitingMarket || 0);
  const candidateBlocked = Number(candidateReadiness?.blocked || 0);
  const candidateExcluded = Number(candidateReadiness?.excluded || 0);
  const candidateMarketCoverage = candidateReadiness?.marketCoverage || null;
  const candidateMarketEvaluatedMatches = Number(
    candidateMarketCoverage?.evaluatedMatches || 0,
  );
  const candidateMarketPublishedMatches = Number(
    candidateMarketCoverage?.officialHadPublishedMatches || 0,
  );
  const candidateStrictMarketEvidenceMatches = Number(
    candidateMarketCoverage?.strictMarketEvidenceCompleteMatches || 0,
  );
  const candidateMarketAtomicReadyMatches = Number(
    candidateMarketCoverage?.atomicReadyMatches || 0,
  );
  const candidateAwaitingUnpublishedMatches = Number(
    candidateMarketCoverage?.awaitingUnpublishedMatches || 0,
  );
  const candidateAwaitingSnapshotMissingMatches = Number(
    candidateMarketCoverage?.awaitingSnapshotMissingMatches || 0,
  );
  const candidatePublishedChainGapMatches = Number(
    candidateMarketCoverage?.publishedChainGapMatches || 0,
  );
  const candidateAwaitingClassifiedMatches = Number(
    candidateMarketCoverage?.awaitingClassifiedMatches || 0,
  );
  const candidateCaptureFinalizationGraceSeconds = Number(
    candidateReadiness?.captureFinalizationGraceSeconds || 0,
  );
  const candidateNearestDeadlineMs = Date.parse(
    candidateReadiness?.nearestDeadlineAt || "",
  );
  const candidateNearestFinalizationMs = Date.parse(
    candidateReadiness?.nearestFinalizationAt || "",
  );
  const candidateNearestDeadlineBatch =
    candidateReadiness?.nearestDeadlineBatch || null;
  const candidateNearestBatchPendingMatches = Number(
    candidateNearestDeadlineBatch?.pendingMatches || 0,
  );
  const candidateAdmission = candidateReadiness?.admission || null;
  const candidateDueUnrecorded = Number(candidateAdmission?.dueUnrecorded || 0);
  const candidateAdmissionExpectedRows = Number(
    candidateAdmission?.expectedRows || 0,
  );
  const candidateAdmissionAdmitted = Number(
    candidateAdmission?.admitted || 0,
  );
  const candidateAdmissionExcluded = Number(
    candidateAdmission?.excluded || 0,
  );
  const candidatePendingDeadline = Number(
    candidateAdmission?.pendingDeadline || 0,
  );
  const candidateDueMatches = Number(candidateCaptureHeartbeat?.dueMatches || 0);
  const candidateEventsAdded = Number(candidateCaptureHeartbeat?.eventsAdded || 0);
  const candidateHasDeadlineCohortAudit = [
    "dueCaptureEventsAdded",
    "dueDecisionEventsAdded",
    "dueExclusionEventsAdded",
    "dueAtomicDecisionEventsAdded",
    "dueCaptureComplete",
    "dueAtomicComplete",
  ].every((field) => Object.hasOwn(candidateCaptureHeartbeat || {}, field));
  const candidateDueCaptureEventsAdded = Number(
    candidateCaptureHeartbeat?.dueCaptureEventsAdded || 0,
  );
  const candidateDueDecisionEventsAdded = Number(
    candidateCaptureHeartbeat?.dueDecisionEventsAdded || 0,
  );
  const candidateDueExclusionEventsAdded = Number(
    candidateCaptureHeartbeat?.dueExclusionEventsAdded || 0,
  );
  const candidateDueAtomicDecisionEventsAdded = Number(
    candidateCaptureHeartbeat?.dueAtomicDecisionEventsAdded || 0,
  );
  pushCheck(checks, "candidate prospective cutoff heartbeat is live and unblocked",
    modelEvaluation.status === 200
      && (publicCandidateProspective?.state === "ACTIVE"
        || shadowObservationAuditValid(publicCandidateProspective))
      && publicCandidateProspective?.chainValid === true
      && candidateCaptureHeartbeat?.version === "prospective-deadline-heartbeat-v2"
      && candidateCaptureHeartbeat?.fresh === true
      && typeof candidateCaptureHeartbeat?.captureDurationMs === "number"
      && Number.isFinite(candidateCaptureHeartbeat.captureDurationMs)
      && candidateCaptureHeartbeat.captureDurationMs >= 0
      && typeof candidateCaptureHeartbeat?.heartbeatAgeMs === "number"
      && Number.isFinite(candidateCaptureHeartbeat.heartbeatAgeMs)
      && candidateCaptureHeartbeat.heartbeatAgeMs >= 0
      && candidateCaptureHeartbeat?.freshnessLimitMs === 180_000
      && candidateCaptureHeartbeat.heartbeatAgeMs
        <= candidateCaptureHeartbeat.freshnessLimitMs
      && candidateCaptureHeartbeat?.scheduleVersion
        === "candidate-heartbeat-preemptive-schedule-v1"
      && candidateCaptureHeartbeat?.scheduleMode === "preemptive-evaluated-at"
      && Number.isFinite(candidateCaptureHeartbeat?.preemptiveRefreshAgeMs)
      && candidateCaptureHeartbeat.preemptiveRefreshAgeMs >= 1_000
      && Number.isFinite(candidateCaptureHeartbeat?.preemptiveReserveMs)
      && candidateCaptureHeartbeat.preemptiveReserveMs > 0
      && Number.isFinite(candidateCaptureHeartbeat?.attemptTimeoutLimitMs)
      && candidateCaptureHeartbeat.attemptTimeoutLimitMs >= 1_000
      && Number.isFinite(candidateCaptureHeartbeat?.retryDelayMs)
      && candidateCaptureHeartbeat.retryDelayMs >= 1_000
      && Number.isFinite(candidateCaptureHeartbeat?.recoveryCaptureBudgetMs)
      && candidateCaptureHeartbeat.recoveryCaptureBudgetMs >= 1_000
      && Number.isFinite(candidateCaptureHeartbeat?.preemptiveSafetyMarginMs)
      && candidateCaptureHeartbeat.preemptiveSafetyMarginMs >= 0
      && candidateCaptureHeartbeat.preemptiveReserveMs
        === candidateCaptureHeartbeat.attemptTimeoutLimitMs
          + candidateCaptureHeartbeat.retryDelayMs
          + candidateCaptureHeartbeat.recoveryCaptureBudgetMs
          + candidateCaptureHeartbeat.preemptiveSafetyMarginMs
      && candidateCaptureHeartbeat.preemptiveRefreshAgeMs
        + candidateCaptureHeartbeat.preemptiveReserveMs
        === candidateCaptureHeartbeat.freshnessLimitMs
      && Number.isFinite(
        candidateCaptureHeartbeat?.projectedWorstCaseCompletionAgeMs,
      )
      && candidateCaptureHeartbeat.projectedWorstCaseCompletionAgeMs
        < candidateCaptureHeartbeat.freshnessLimitMs
      && candidateCaptureHeartbeat?.preemptiveBudgetFits === true
      && Number.isFinite(
        Date.parse(candidateCaptureHeartbeat?.nextPreemptiveRefreshAt || ""),
      )
      && Date.parse(candidateCaptureHeartbeat.nextPreemptiveRefreshAt)
        - Date.parse(candidateCaptureHeartbeat.evaluatedAt)
        === candidateCaptureHeartbeat.preemptiveRefreshAgeMs
      && candidateCaptureHeartbeat?.preemptiveRefreshDue === (
        candidateCaptureHeartbeat.heartbeatAgeMs
          >= candidateCaptureHeartbeat.preemptiveRefreshAgeMs
      )
      && candidateCaptureHeartbeat?.nextAttemptBudgetVersion
        === "candidate-heartbeat-attempt-budget-v1"
      && ["preemptive-primary", "preemptive-recovery"]
        .includes(candidateCaptureHeartbeat?.nextAttemptType)
      && Number.isFinite(candidateCaptureHeartbeat?.nextAttemptTimeoutMs)
      && candidateCaptureHeartbeat.nextAttemptTimeoutMs >= 1_000
      && candidateCaptureHeartbeat.nextAttemptTimeoutMs
        <= candidateCaptureHeartbeat.attemptTimeoutLimitMs
      && Number.isFinite(
        candidateCaptureHeartbeat?.nextAttemptProjectedCompletionAgeMs,
      )
      && candidateCaptureHeartbeat.nextAttemptProjectedCompletionAgeMs
        === candidateCaptureHeartbeat.heartbeatAgeMs
          + candidateCaptureHeartbeat.nextAttemptTimeoutMs
          + (candidateCaptureHeartbeat.nextAttemptType === "preemptive-recovery"
            ? 0
            : candidateCaptureHeartbeat.retryDelayMs
              + candidateCaptureHeartbeat.recoveryCaptureBudgetMs)
      && candidateCaptureHeartbeat?.nextAttemptBudgetFits === true
      && candidateCaptureHeartbeat?.ok === true
      && candidateCaptureHeartbeat?.skipped === false
      && Number(candidateCaptureHeartbeat?.intervalSeconds || 0) >= 1
      && Number(candidateCaptureHeartbeat?.intervalSeconds || 0) <= 60
      && Number(candidateCaptureHeartbeat.intervalSeconds)
        === candidateCaptureHeartbeat.preemptiveRefreshAgeMs / 1_000
      && Number.isFinite(Date.parse(candidateCaptureHeartbeat?.evaluatedAt || ""))
      && Number.isInteger(candidateDueMatches)
      && candidateDueMatches >= 0
      && Number.isInteger(candidateEventsAdded)
      && candidateEventsAdded >= 0
      && candidateHasDeadlineCohortAudit
      && Number.isInteger(candidateDueCaptureEventsAdded)
      && candidateDueCaptureEventsAdded === candidateDueMatches
      && Number.isInteger(candidateDueDecisionEventsAdded)
      && candidateDueDecisionEventsAdded >= 0
      && Number.isInteger(candidateDueExclusionEventsAdded)
      && candidateDueExclusionEventsAdded >= 0
      && candidateDueDecisionEventsAdded + candidateDueExclusionEventsAdded
        === candidateDueCaptureEventsAdded
      && Number.isInteger(candidateDueAtomicDecisionEventsAdded)
      && candidateDueAtomicDecisionEventsAdded === candidateDueDecisionEventsAdded
      && candidateCaptureHeartbeat?.dueCaptureComplete === true
      && candidateCaptureHeartbeat?.dueAtomicComplete === true
      && (
        candidateDueMatches === 0
        || candidateCaptureHeartbeat?.reason === "deadline-cohort-evaluated"
      )
      && candidateReadiness?.version === "candidate-prospective-readiness-preview-v2"
      && candidateReadiness?.captureFinalizationPolicyVersion
        === "deadline-evidence-grace-v1"
      && candidateCaptureFinalizationGraceSeconds === 120
      && candidateHasFullCoverageMetadata
      && Number.isInteger(candidateUpcomingMatches)
      && candidateUpcomingMatches >= 0
      && Number.isInteger(candidateEvaluatedMatches)
      && candidateEvaluatedMatches === candidateUpcomingMatches
      && Number.isInteger(candidateDetailedMatches)
      && candidateDetailedMatches >= 0
      && Number.isInteger(candidateRowsTruncated)
      && candidateRowsTruncated >= 0
      && candidateDetailedMatches + candidateRowsTruncated
        === candidateEvaluatedMatches
      && Number.isInteger(candidatePreviewLimit)
      && candidatePreviewLimit >= 1
      && candidateDetailedMatches <= candidatePreviewLimit
      && Number.isInteger(candidateReadyNow)
      && candidateReadyNow >= 0
      && Number.isInteger(candidateAtomicReadyNow)
      && candidateAtomicReadyNow === candidateReadyNow
      && candidateReadiness?.readyInvariantOk === true
      && candidateReadiness?.blockerCounts
      && typeof candidateReadiness.blockerCounts === "object"
      && candidateReadiness?.excludedReasonCounts
      && typeof candidateReadiness.excludedReasonCounts === "object"
      && candidateReadiness?.awaitingReasonCounts
      && typeof candidateReadiness.awaitingReasonCounts === "object"
      && candidateMarketCoverage?.version
        === "candidate-official-market-coverage-preview-v1"
      && Number.isInteger(candidateMarketEvaluatedMatches)
      && candidateMarketEvaluatedMatches === candidateUpcomingMatches
      && Number.isInteger(candidateMarketPublishedMatches)
      && candidateMarketPublishedMatches >= 0
      && Number.isInteger(candidateStrictMarketEvidenceMatches)
      && candidateStrictMarketEvidenceMatches >= 0
      && candidateStrictMarketEvidenceMatches <= candidateMarketPublishedMatches
      && Number.isInteger(candidateMarketAtomicReadyMatches)
      && candidateMarketAtomicReadyMatches === candidateAtomicReadyNow
      && Number.isInteger(candidateAwaitingUnpublishedMatches)
      && candidateAwaitingUnpublishedMatches >= 0
      && Number.isInteger(candidateAwaitingSnapshotMissingMatches)
      && candidateAwaitingSnapshotMissingMatches >= 0
      && Number.isInteger(candidateAwaitingClassifiedMatches)
      && candidateAwaitingClassifiedMatches === candidateAwaitingMarket
      && candidateAwaitingUnpublishedMatches
        + candidateAwaitingSnapshotMissingMatches
        === candidateAwaitingMarket
      && candidateMarketCoverage?.awaitingClassificationComplete === true
      && Number.isInteger(candidatePublishedChainGapMatches)
      && candidatePublishedChainGapMatches === 0
      && Number.isInteger(candidateAwaitingMarket)
      && candidateAwaitingMarket >= 0
      && Number.isInteger(candidateBlocked)
      && candidateBlocked === 0
      && Number.isInteger(candidateExcluded)
      && candidateExcluded >= 0
      && candidateReadyNow + candidateAwaitingMarket + candidateBlocked
        + candidateExcluded
        === candidateUpcomingMatches
      && candidateAdmission?.version
        === "candidate-prospective-admission-summary-v1"
      && candidateAdmission?.registryAvailable === true
      && candidateAdmission?.reconciled === true
      && candidateAdmission?.captureGap === false
      && candidateDueUnrecorded === 0
      && [
        candidateAdmissionExpectedRows,
        candidateAdmissionAdmitted,
        candidateAdmissionExcluded,
        candidatePendingDeadline,
      ].every((value) => Number.isInteger(value) && value >= 0)
      && candidateAdmissionExpectedRows === candidateUpcomingMatches
      && candidateAdmissionAdmitted
        + candidateAdmissionExcluded
        + candidatePendingDeadline
        === candidateAdmissionExpectedRows
      && (
        candidatePendingDeadline === 0
          ? (
            candidateReadiness?.nearestDeadlineAt === null
            && candidateReadiness?.nearestFinalizationAt === null
            && candidateReadiness?.nearestStatus === null
            && candidateNearestDeadlineBatch === null
          )
          : (
            Number.isInteger(candidatePendingDeadline)
            && candidatePendingDeadline > 0
            && Number.isFinite(Date.parse(candidateReadiness?.nearestDeadlineAt || ""))
            && Number.isFinite(candidateNearestFinalizationMs)
            && candidateNearestFinalizationMs - candidateNearestDeadlineMs
              === candidateCaptureFinalizationGraceSeconds * 1000
            && ["ready-now", "awaiting-market"].includes(candidateReadiness?.nearestStatus)
            && candidateNearestDeadlineBatch?.deadlineAt
              === candidateReadiness?.nearestDeadlineAt
            && Number.isInteger(candidateNearestBatchPendingMatches)
            && candidateNearestBatchPendingMatches > 0
            && candidateNearestDeadlineBatch?.invariantOk === true
          )
      ), {
      status: modelEvaluation.status,
      state: publicCandidateProspective?.state || null,
      chainValid: publicCandidateProspective?.chainValid ?? null,
      heartbeat: {
        version: candidateCaptureHeartbeat?.version || null,
        evaluatedAt: candidateCaptureHeartbeat?.evaluatedAt || null,
        captureDurationMs: candidateCaptureHeartbeat?.captureDurationMs ?? null,
        heartbeatAgeMs: candidateCaptureHeartbeat?.heartbeatAgeMs ?? null,
        freshnessLimitMs: candidateCaptureHeartbeat?.freshnessLimitMs ?? null,
        scheduleVersion: candidateCaptureHeartbeat?.scheduleVersion || null,
        scheduleMode: candidateCaptureHeartbeat?.scheduleMode || null,
        preemptiveRefreshAgeMs:
          candidateCaptureHeartbeat?.preemptiveRefreshAgeMs ?? null,
        preemptiveReserveMs: candidateCaptureHeartbeat?.preemptiveReserveMs ?? null,
        attemptTimeoutLimitMs:
          candidateCaptureHeartbeat?.attemptTimeoutLimitMs ?? null,
        retryDelayMs: candidateCaptureHeartbeat?.retryDelayMs ?? null,
        recoveryCaptureBudgetMs:
          candidateCaptureHeartbeat?.recoveryCaptureBudgetMs ?? null,
        preemptiveSafetyMarginMs:
          candidateCaptureHeartbeat?.preemptiveSafetyMarginMs ?? null,
        projectedWorstCaseCompletionAgeMs:
          candidateCaptureHeartbeat?.projectedWorstCaseCompletionAgeMs ?? null,
        preemptiveBudgetFits:
          candidateCaptureHeartbeat?.preemptiveBudgetFits ?? null,
        nextPreemptiveRefreshAt:
          candidateCaptureHeartbeat?.nextPreemptiveRefreshAt || null,
        preemptiveRefreshDue:
          candidateCaptureHeartbeat?.preemptiveRefreshDue ?? null,
        nextAttemptBudgetVersion:
          candidateCaptureHeartbeat?.nextAttemptBudgetVersion || null,
        nextAttemptType: candidateCaptureHeartbeat?.nextAttemptType || null,
        nextAttemptTimeoutMs:
          candidateCaptureHeartbeat?.nextAttemptTimeoutMs ?? null,
        nextAttemptProjectedCompletionAgeMs:
          candidateCaptureHeartbeat?.nextAttemptProjectedCompletionAgeMs ?? null,
        nextAttemptBudgetFits:
          candidateCaptureHeartbeat?.nextAttemptBudgetFits ?? null,
        fresh: candidateCaptureHeartbeat?.fresh ?? null,
        lastAttemptAt: candidateCaptureHeartbeat?.lastAttemptAt || null,
        lastAttemptReason: candidateCaptureHeartbeat?.lastAttemptReason || null,
        lastAttemptStatusAdvanced:
          candidateCaptureHeartbeat?.lastAttemptStatusAdvanced ?? null,
        lastAttemptKind: candidateCaptureHeartbeat?.lastAttemptKind || null,
        lastAttemptTimeoutMs:
          candidateCaptureHeartbeat?.lastAttemptTimeoutMs ?? null,
        ok: candidateCaptureHeartbeat?.ok ?? null,
        skipped: candidateCaptureHeartbeat?.skipped ?? null,
        reason: candidateCaptureHeartbeat?.reason || null,
        intervalSeconds: candidateCaptureHeartbeat?.intervalSeconds ?? null,
        dueMatches: candidateDueMatches,
        eventsAdded: candidateEventsAdded,
        deadlineCohortAuditMetadata: candidateHasDeadlineCohortAudit,
        dueCaptureEventsAdded: candidateDueCaptureEventsAdded,
        dueDecisionEventsAdded: candidateDueDecisionEventsAdded,
        dueExclusionEventsAdded: candidateDueExclusionEventsAdded,
        dueAtomicDecisionEventsAdded: candidateDueAtomicDecisionEventsAdded,
        dueCaptureComplete: candidateCaptureHeartbeat?.dueCaptureComplete === true,
        dueAtomicComplete: candidateCaptureHeartbeat?.dueAtomicComplete === true,
      },
      readiness: candidateReadiness ? {
        version: candidateReadiness.version || null,
        fullCoverageMetadata: candidateHasFullCoverageMetadata,
        previewLimit: candidatePreviewLimit,
        evaluatedMatches: candidateEvaluatedMatches,
        detailedMatches: candidateDetailedMatches,
        rowsTruncated: candidateRowsTruncated,
        upcomingMatches: candidateUpcomingMatches,
        readyNow: candidateReadyNow,
        atomicReadyNow: candidateAtomicReadyNow,
        awaitingMarket: candidateAwaitingMarket,
        blocked: candidateBlocked,
        excluded: candidateExcluded,
        readinessRatio: candidateReadiness.readinessRatio ?? null,
        nearestDeadlineAt: candidateReadiness.nearestDeadlineAt || null,
        nearestFinalizationAt: candidateReadiness.nearestFinalizationAt || null,
        captureFinalizationPolicyVersion:
          candidateReadiness.captureFinalizationPolicyVersion || null,
        captureFinalizationGraceSeconds:
          candidateCaptureFinalizationGraceSeconds,
        nearestStatus: candidateReadiness.nearestStatus || null,
        blockerCounts: candidateReadiness.blockerCounts || {},
        awaitingReasonCounts: candidateReadiness.awaitingReasonCounts || {},
        excludedReasonCounts: candidateReadiness.excludedReasonCounts || {},
        marketCoverage: candidateMarketCoverage,
        readyInvariantOk: candidateReadiness.readyInvariantOk === true,
        admission: candidateAdmission ? {
          version: candidateAdmission.version || null,
          registryAvailable: candidateAdmission.registryAvailable === true,
          reconciled: candidateAdmission.reconciled === true,
          captureGap: candidateAdmission.captureGap === true,
          admitted: Number(candidateAdmission.admitted || 0),
          excluded: Number(candidateAdmission.excluded || 0),
          pendingDeadline: Number(candidateAdmission.pendingDeadline || 0),
          dueUnrecorded: candidateDueUnrecorded,
          readyAlreadyAdmitted: Number(candidateAdmission.readyAlreadyAdmitted || 0),
          readyPendingDeadline: Number(candidateAdmission.readyPendingDeadline || 0),
          readyDueUnrecorded: Number(candidateAdmission.readyDueUnrecorded || 0),
        } : null,
      } : null,
    });

  const modelAdmin = await request("GET", "/api/v1/model/evaluation?detail=admin");
  pushCheck(checks, "model evaluation admin no-auth denied", modelAdmin.status === 401, {
    status: modelAdmin.status
  });

  const aiArenaStatus = await request("GET", "/api/v1/ai-arena/status");
  const aiArenaLeagueSlots = Array.isArray(aiArenaStatus.body?.leagueSlots)
    ? aiArenaStatus.body.leagueSlots
    : [];
  const aiArenaState = String(aiArenaStatus.body?.state || "");
  const aiArenaStatusV5 = aiArenaStatus.body?.publicationVersion === "ai-big-five-survival-v5";
  const aiArenaAvailableMatches = Number(aiArenaStatus.body?.availableMatches);
  const aiArenaStatusValid = aiArenaStatus.status === 200
    && aiArenaStatus.body?.ok === true
    && aiArenaStatus.body?.version === "ai-big-five-survival-status-v1"
    && ["ai-big-five-survival-v2", "ai-big-five-survival-v3", "ai-big-five-survival-v4", "ai-big-five-survival-v5"]
      .includes(aiArenaStatus.body?.publicationVersion)
    && ["FORMING", "READY", "LOCKED"].includes(aiArenaState)
    && Number(aiArenaStatus.body?.targetMatches) === 10
    && Number(aiArenaStatus.body?.availableMatches) >= 0
    && Number(aiArenaStatus.body?.availableMatches) <= 10
    && Number(aiArenaStatus.body?.agents) === 6
    && aiArenaLeagueSlots.length === 5
    && aiArenaLeagueSlots.every((row) => Number(row?.target) === 2)
    && aiArenaStatus.body?.formalStatisticsExcluded === true
    && aiArenaStatus.body?.disclosure === "strategy-simulation-not-external-model-calls"
    && (
      aiArenaState !== "LOCKED"
      || (
        (aiArenaStatusV5
          ? aiArenaStatus.body?.roundActive === true
            && aiArenaAvailableMatches >= 2
            && aiArenaStatus.body?.complete === (aiArenaAvailableMatches === 10)
          : aiArenaStatus.body?.complete === true && aiArenaAvailableMatches === 10)
        && aiArenaStatus.body?.integrity?.immutable === true
        && aiArenaStatus.body?.integrity?.poolHashPresent === true
        && aiArenaStatus.body?.integrity?.submissionRootHashPresent === true
        && aiArenaStatus.body?.integrity?.stateHashPresent === true
      )
    );
  pushCheck(checks, "AI survival public status is generation-backed and privacy-safe", aiArenaStatusValid, {
    status: aiArenaStatus.status,
    ok: aiArenaStatus.body?.ok ?? null,
    publicationVersion: aiArenaStatus.body?.publicationVersion || null,
    state: aiArenaState || null,
    targetMatches: aiArenaStatus.body?.targetMatches ?? null,
    availableMatches: aiArenaStatus.body?.availableMatches ?? null,
    agents: aiArenaStatus.body?.agents ?? null,
    leagueSlots: aiArenaLeagueSlots,
    formalStatisticsExcluded: aiArenaStatus.body?.formalStatisticsExcluded ?? null,
    integrity: aiArenaStatus.body?.integrity || null,
    publicPathLeaks: findPublicPathLeaks(aiArenaStatus.body)
  });

  const currentNoAuth = await request("GET", "/api/v1/matches/current?view=list");
  const historyNoAuth = await request("GET", "/api/v1/matches/history?limit=1");
  const oddsNoAuth = await request("GET", "/api/v1/odds/history?limit=1");
  const aiArenaNoAuth = await request("GET", "/api/v1/ai-arena");
  pushCheck(checks, "protected v1 reads deny anonymous", currentNoAuth.status === 401 && historyNoAuth.status === 401 && oddsNoAuth.status === 401 && aiArenaNoAuth.status === 401, {
    current: currentNoAuth.status,
    history: historyNoAuth.status,
    odds: oddsNoAuth.status,
    aiArena: aiArenaNoAuth.status
  });

  const staticResults = [];
  for (const pathname of protectedStaticPaths) {
    const result = await request("GET", pathname, { range: "bytes=0-256" });
    staticResults.push({ path: pathname, status: result.status, bytes: result.bytes });
  }
  const leakingStatic = staticResults.filter((result) => !disallowsStaticPayload(result.status));
  pushCheck(checks, "protected static payloads disabled", leakingStatic.length === 0, {
    checked: staticResults,
    leaking: leakingStatic
  });

  const requiredChecks = checks.filter((check) => check.required !== false);
  const failed = requiredChecks.filter((check) => !check.ok);
  const sqliteReady = sqlite.available === true && currentRead.source === "sqlite";
  const protectedStaticDisabled = leakingStatic.length === 0;
  const publicReachable = root.status === 200 && health.status === 200;
  const frontendAssetsOk = checks
    .filter((check) => check.name === "frontend asset runtime recovers stale match detail errors"
      || check.name === "frontend bundle uses the React production runtime"
      || check.name === "match detail chunk probability resilience")
    .every((check) => check.ok);

  const payload = {
    ok: failed.length === 0,
    auditOnly,
    checkedAt: new Date().toISOString(),
    baseUrl: baseUrl.origin,
    summary: {
      required: requiredChecks.length,
      failed: failed.length,
      publicReachable,
      frontendAssetsOk,
      sqliteReady,
      protectedStaticDisabled,
      healthOk: health.body?.ok ?? null,
      healthStatus: health.body?.status || null,
      currentReadSource: currentRead.source || sqlite.readSource || null
    },
    checks
  };

  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok && !auditOnly) process.exit(1);
};

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    baseUrl: baseUrl.origin,
    error: error.message || String(error)
  }, null, 2));
  if (!auditOnly) process.exit(1);
});
