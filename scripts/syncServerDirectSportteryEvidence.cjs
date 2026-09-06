const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createSourceCycleId, fetchEndpoint } = require("./collectSportterySnapshot.cjs");
const { SPORTTERY_RESULT_URL } = require("./sportteryEndpointContract.cjs");
const { createFastUploadSnapshot, resultFingerprint } = require("./sportteryFastResultLane.cjs");
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

const collectServerDirectEvidence = async ({
  collectorEnv,
  keyId,
  privateKeyPem,
  maxAgeMinutes,
  createMarketEvidence,
  resultRequest,
}) => {
  const resultSourceCycleId = createSourceCycleId();
  const [marketOutcome, resultOutcome] = await Promise.allSettled([
    Promise.resolve().then(() => createMarketEvidence(collectorEnv)),
    fetchEndpoint({
      id: "result", method: "result", page: 1, role: "result",
      url: SPORTTERY_RESULT_URL,
      sourceCycleId: resultSourceCycleId,
      attestationSigner: { keyId, privateKeyPem },
      ...(resultRequest ? { request: resultRequest } : {}),
    }),
  ]);
  if (marketOutcome.status !== "fulfilled") throw marketOutcome.reason;
  // This builder still requires both complete market endpoints. A result
  // response must never enter the market-evidence quorum or replace a market.
  const marketEvidence = marketOutcome.value;
  const companionSnapshot = buildFastLaneSnapshot(marketEvidence, { keyId, maxAgeMinutes });
  const resultEndpoint = resultOutcome.status === "fulfilled" ? resultOutcome.value : null;
  const resultCollected = Boolean(resultEndpoint?.ok === true && Number(resultEndpoint.rows) > 0);
  if (!resultCollected) {
    return {
      marketEvidence,
      // Uploading only fresh companions uses the server's existing monotonic
      // merge, preserving the old signed result and its original clock.
      fastLaneSnapshot: companionSnapshot,
      resultProbe: {
        collected: false,
        receivedAt: null,
        rows: 0,
        reason: resultOutcome.status === "rejected" ? "official-result-request-failed" : "official-result-empty",
        errorCode: resultOutcome.reason?.code || null,
      },
    };
  }
  const probeSnapshot = {
    sourceCycleId: resultSourceCycleId,
    capturedAt: resultEndpoint.receivedAt,
    endpoints: [resultEndpoint],
    producer: companionSnapshot.producer,
    maxAgeMinutes: companionSnapshot.maxAgeMinutes,
  };
  return {
    marketEvidence,
    fastLaneSnapshot: createFastUploadSnapshot({
      probeSnapshot,
      companionSnapshot,
      fingerprint: resultFingerprint(resultEndpoint),
    }),
    resultProbe: {
      collected: true,
      receivedAt: resultEndpoint.receivedAt,
      rows: resultEndpoint.rows,
      reason: "signed-official-result-collected",
      errorCode: null,
    },
  };
};

const publishServerDirectCollection = async ({
  collection,
  adminToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fastLaneUploadUrl,
  collectorUploadUrl,
  upload = fetchJsonBounded,
  logger = console.log,
}) => {
  const evidence = collection.marketEvidence;
  const fastLane = await upload(
    validateFastLaneUploadUrl(fastLaneUploadUrl),
    {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ snapshot: collection.fastLaneSnapshot }),
    },
    { timeoutMs, maxBytes: MAX_LOCAL_RESPONSE_BYTES, label: "server-direct fast lane upload" },
  );
  if (fastLane?.ok !== true || fastLane?.storedValidation?.ok !== true) {
    throw new Error("server-direct fast lane upload was not accepted");
  }
  if (collection.resultProbe.collected && (
    fastLane?.stored !== true || fastLane?.watcherEligible !== true || fastLane?.publicationEligibility?.eligible !== true
  )) throw new Error("server-direct result was stored without trusted watcher eligibility");
  const accepted = await upload(
    validateLocalUrl(collectorUploadUrl),
    {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(evidence),
    },
    { timeoutMs, maxBytes: MAX_LOCAL_RESPONSE_BYTES, label: "server-direct evidence upload" },
  );
  if (accepted?.ok !== true) throw new Error("server-direct evidence upload was not accepted");
  const summary = {
    ok: true,
    degraded: !collection.resultProbe.collected,
    transport: "new-server-direct",
    capturedAt: evidence.capturedAt || null,
    sourceCycleId: evidence.sourceCycleId || null,
    endpoints: evidence.endpoints.length,
    rows: evidence.endpoints.reduce((sum, endpoint) => sum + Number(endpoint.rows || 0), 0),
    errors: evidence.errors,
    resultProbe: {
      ...collection.resultProbe,
      refreshed: collection.resultProbe.collected,
      status: collection.resultProbe.collected ? "fresh" : "degraded-result-unavailable",
      previousResultPreserved: !collection.resultProbe.collected && fastLane?.mergedWithPreviousResult === true,
      // Collection/storage is not proof that the watcher published a score.
      scorePublicationConfirmed: false,
    },
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
  const collection = await collectServerDirectEvidence({
    keyId,
    privateKeyPem: privateKey,
    maxAgeMinutes: process.env.SPORTTERY_RELAY_MAX_AGE_MINUTES,
    createMarketEvidence: createSportteryEvidence,
    collectorEnv: {
      SPORTTERY_COLLECTOR_PRIVATE_KEY_PKCS8: privateKey,
      SPORTTERY_COLLECTOR_KEY_ID: keyId,
      SPORTTERY_COLLECTOR_KEY_FINGERPRINT: keyFingerprint,
      SPORTTERY_COLLECTOR_TRANSPORT: "new-server-direct",
      SPORTTERY_COLLECTOR_CYCLE_PREFIX: "new-server-sporttery",
    },
  });
  return publishServerDirectCollection({
    collection, adminToken, timeoutMs, logger,
    fastLaneUploadUrl: process.env.SPORTTERY_SERVER_DIRECT_RELAY_UPLOAD_URL,
    collectorUploadUrl: process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_UPLOAD_URL,
  });
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
  collectServerDirectEvidence,
  publishServerDirectCollection,
  readPrivateKey,
  run,
  validateFastLaneUploadUrl,
};
