const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  fetchJsonBounded,
  validateLocalUrl,
} = require("./syncCloudflareSportteryEvidence.cjs");

const rootDir = path.resolve(__dirname, "..");
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const MAX_LOCAL_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FAST_LANE_MAX_AGE_MINUTES = 20;

const requiredText = (value, name) => {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
};

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const instantMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const validateFastLaneUploadUrl = (value) => {
  const url = new URL(
    value || "http://127.0.0.1:8788/api/admin/sporttery-relay-fast-lane?runSync=0",
  );
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("server-direct fast lane upload URL must use loopback HTTP");
  }
  if (
    url.pathname !== "/api/admin/sporttery-relay-fast-lane"
    || url.username
    || url.password
    || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "runSync")
    || (url.searchParams.has("runSync") && url.searchParams.get("runSync") !== "0")
  ) {
    throw new Error("server-direct fast lane upload URL is invalid");
  }
  url.searchParams.set("runSync", "0");
  return url;
};

const buildFastLaneSnapshot = (evidence, {
  keyId,
  maxAgeMinutes = DEFAULT_FAST_LANE_MAX_AGE_MINUTES,
} = {}) => {
  const endpoints = Array.isArray(evidence?.endpoints)
    ? evidence.endpoints.filter((endpoint) => endpoint?.ok === true && Number(endpoint?.rows || 0) > 0)
    : [];
  const methods = [...new Set(endpoints.map((endpoint) => String(endpoint?.method || endpoint?.id || "").trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
  if (
    endpoints.length !== 2
    || !methods.includes("current")
    || !methods.includes("calculator")
    || (Array.isArray(evidence?.errors) && evidence.errors.length > 0)
  ) {
    throw new Error("server-direct fast lane requires complete current and calculator endpoints");
  }
  const requestedCandidates = endpoints
    .map((endpoint) => instantMs(endpoint?.requestedAt || endpoint?.collectorProvenance?.requestedAt))
    .filter((value) => value !== null);
  const completedCandidates = endpoints
    .map((endpoint) => instantMs(endpoint?.receivedAt || endpoint?.collectorProvenance?.receivedAt))
    .filter((value) => value !== null);
  if (requestedCandidates.length !== endpoints.length || completedCandidates.length !== endpoints.length) {
    throw new Error("server-direct fast lane endpoint clocks are incomplete");
  }
  const requestedAt = new Date(Math.min(...requestedCandidates)).toISOString();
  const completedAt = new Date(Math.max(...completedCandidates)).toISOString();
  if (Date.parse(completedAt) < Date.parse(requestedAt)) {
    throw new Error("server-direct fast lane endpoint clocks regress");
  }
  const sourceCycleId = requiredText(evidence?.sourceCycleId, "server-direct sourceCycleId");
  const collectorKeyId = requiredText(keyId, "server-direct collector keyId");
  return {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt: requestedAt,
    sourceCycleId,
    requestedAt,
    completedAt,
    provenanceVersion: 1,
    collectorProvenance: {
      sourceCycleId,
      requestedAt,
      completedAt,
      clock: "collector-owned-wall-clock",
    },
    maxAgeMinutes: positiveInteger(maxAgeMinutes, DEFAULT_FAST_LANE_MAX_AGE_MINUTES),
    producer: {
      host: "new-server-direct",
      platform: process.platform,
      transport: "new-server-direct",
      collectorAttestationKeyId: collectorKeyId,
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows: endpoints.reduce((sum, endpoint) => sum + Number(endpoint.rows || 0), 0),
      errors: 0,
      errorClasses: {},
      methods,
      skipInitialEndpoints: false,
      pageDepth: 0,
      resultPageDepth: 0,
      resultScope: null,
    },
    endpoints,
    errors: [],
  };
};

const readPrivateKey = (inputPath) => {
  const resolved = path.resolve(requiredText(inputPath, "SPORTTERY_SERVER_DIRECT_COLLECTOR_PRIVATE_KEY_PATH"));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > MAX_PRIVATE_KEY_BYTES) {
    throw new Error("server-direct collector private key file is invalid");
  }
  if (process.platform !== "win32" && (stat.mode & 0o027) !== 0) {
    throw new Error("server-direct collector private key permissions must not allow group write or any other access");
  }
  const value = fs.readFileSync(resolved, "utf8");
  if (!value.includes("-----BEGIN PRIVATE KEY-----") || !value.includes("-----END PRIVATE KEY-----")) {
    throw new Error("server-direct collector private key must be PKCS8 PEM");
  }
  return value;
};

const run = async ({ logger = console.log } = {}) => {
  const privateKey = readPrivateKey(process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_PRIVATE_KEY_PATH);
  const keyId = requiredText(process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_ID, "SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_ID");
  const keyFingerprint = requiredText(
    process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_FINGERPRINT,
    "SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_FINGERPRINT",
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(keyFingerprint)) throw new Error("server-direct collector fingerprint is invalid");
  const adminToken = requiredText(
    process.env.ADMIN_TOKEN
      || process.env.FOOTBALL_CLOUD_ADMIN_TOKEN
      || process.env.ACCESS_CODE_ADMIN_TOKEN,
    "ADMIN_TOKEN, FOOTBALL_CLOUD_ADMIN_TOKEN, or ACCESS_CODE_ADMIN_TOKEN",
  );
  const timeoutMs = positiveInteger(process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const collectorUrl = pathToFileURL(path.join(rootDir, "cloudflare", "sync-trigger", "src", "sportteryCollector.js")).href;
  const { createSportteryEvidence } = await import(collectorUrl);
  const evidence = await createSportteryEvidence({
    SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8: privateKey,
    SPORTTERY_COLLECTOR_KEY_ID: keyId,
    SPORTTERY_COLLECTOR_KEY_FINGERPRINT: keyFingerprint,
    SPORTTERY_COLLECTOR_TRANSPORT: "new-server-direct",
    SPORTTERY_COLLECTOR_CYCLE_PREFIX: "new-server-sporttery",
  });
  const fastLaneSnapshot = buildFastLaneSnapshot(evidence, {
    keyId,
    maxAgeMinutes: process.env.SPORTTERY_RELAY_MAX_AGE_MINUTES,
  });
  const fastLane = await fetchJsonBounded(
    validateFastLaneUploadUrl(process.env.SPORTTERY_SERVER_DIRECT_RELAY_UPLOAD_URL),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ snapshot: fastLaneSnapshot }),
    },
    { timeoutMs, maxBytes: MAX_LOCAL_RESPONSE_BYTES, label: "server-direct fast lane upload" },
  );
  if (fastLane?.ok !== true || fastLane?.storedValidation?.ok !== true) {
    throw new Error("server-direct fast lane upload was not accepted");
  }
  const accepted = await fetchJsonBounded(
    validateLocalUrl(process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_UPLOAD_URL),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(evidence),
    },
    { timeoutMs, maxBytes: MAX_LOCAL_RESPONSE_BYTES, label: "server-direct evidence upload" },
  );
  if (accepted?.ok !== true) throw new Error("server-direct evidence upload was not accepted");
  const summary = {
    ok: true,
    transport: "new-server-direct",
    capturedAt: evidence.capturedAt || null,
    sourceCycleId: evidence.sourceCycleId || null,
    endpoints: evidence.endpoints.length,
    rows: evidence.endpoints.reduce((sum, endpoint) => sum + Number(endpoint.rows || 0), 0),
    errors: evidence.errors,
    fastLaneRows: Number(fastLane?.storedValidation?.rows || 0),
    fastLaneCapturedAt: fastLane?.storedValidation?.capturedAt || null,
    fastLaneMergedWithPreviousResult: fastLane?.mergedWithPreviousResult === true,
    acceptedRows: Number(accepted.acceptedRows || 0),
    storeRows: Number(accepted.storeRows || 0),
    storeRootHash: accepted.storeRootHash || null,
  };
  logger?.(JSON.stringify(summary, null, 2));
  return summary;
};

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error?.message || String(error),
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildFastLaneSnapshot,
  readPrivateKey,
  run,
  validateFastLaneUploadUrl,
};
