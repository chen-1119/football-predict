const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  createSourceCycleId,
  fetchEndpoint,
  parseCurlResponseHeaders,
  sha256Buffer
} = require("./collectSportterySnapshot.cjs");
const {
  verifyCollectorAttestation,
} = require("../src/services/collectorAttestation.cjs");
const {
  createCollectorAttestationTestContext,
} = require("./collectorAttestationTestFixture.cjs");

const rootDir = path.resolve(__dirname, "..");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data"));
const relayTaskSnapshotPath = path.join(rootDir, ".codex-tmp", "sporttery-relay-snapshot.json");
const storeSnapshotPath = path.join(storeDir, "sporttery-relay-snapshot.json");

const newestExistingPath = (candidates) => candidates
  .filter((candidate) => fs.existsSync(candidate))
  .map((candidate) => ({ candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.candidate || null;

const explicitSnapshotPath = process.argv[2]
  || process.env.SPORTTERY_RELAY_SNAPSHOT
  || process.env.SPORTTERY_RELAY_SNAPSHOT_PATH
  || "";
const snapshotPath = path.resolve(
  explicitSnapshotPath
  || newestExistingPath([relayTaskSnapshotPath, storeSnapshotPath])
  || relayTaskSnapshotPath
);
const maxAgeMinutes = Math.max(1, Number(process.env.SPORTTERY_RELAY_MAX_AGE_MINUTES || process.env.SOURCE_MAX_AGE_MINUTES || 20));
const minRows = Math.max(1, Number(process.env.SPORTTERY_RELAY_MIN_ROWS || 1));
const minTrustedRows = Math.max(1, Number(process.env.SPORTTERY_RELAY_MIN_TRUSTED_ROWS || 100));
const minTrustedEndpoints = Math.max(1, Number(process.env.SPORTTERY_RELAY_MIN_TRUSTED_ENDPOINTS || 2));
const fallbackMaxAgeSeconds = Number(process.env.V1_FALLBACK_MAX_STALE_SECONDS || 60 * 60);
const staleFallbackMaxAgeMinutes = Math.max(
  1,
  Number(process.env.SPORTTERY_RELAY_STALE_FALLBACK_MAX_AGE_MINUTES || (Number.isFinite(fallbackMaxAgeSeconds) ? fallbackMaxAgeSeconds / 60 : 60))
);
const requirePagedMethod = process.env.SPORTTERY_RELAY_REQUIRE_PAGED === "1";

const rowsInPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const main = async () => {
  const collectorContext = createCollectorAttestationTestContext({ keyId: "relay-collector-test-ed25519" });
  const checks = [];
  const warnings = [];
  const push = (name, ok, detail = {}) => checks.push({ name, ok: Boolean(ok), ...detail });

  push("snapshot exists", fs.existsSync(snapshotPath), { path: snapshotPath });
  if (!fs.existsSync(snapshotPath)) {
    const payload = { ok: false, checkedAt: new Date().toISOString(), snapshotPath, checks };
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
    return;
  }

  const testPayload = {
    success: true,
    value: {
      matchInfoList: [{
        businessDate: "2026-07-16",
        subMatchList: [{
          matchId: "clock_contract_1",
          had: { updateDate: "2026-07-16", updateTime: "10:19:30" }
        }]
      }]
    }
  };
  const rawBody = Buffer.from(JSON.stringify(testPayload), "utf8");
  const sourceCycleId = createSourceCycleId("2026-07-16T02:20:00.000Z");
  const endpointTimes = [
    "2026-07-16T02:20:00.000Z",
    "2026-07-16T02:20:00.025Z",
    "2026-07-16T02:20:00.030Z",
    "2026-07-16T02:20:00.050Z"
  ];
  const clock = () => endpointTimes.shift();
  const mockRequest = async () => ({
    statusCode: 200,
    headers: {
      date: "Thu, 16 Jul 2026 02:20:00 GMT",
      etag: "\"sporttery-contract\"",
      "content-type": "application/json"
    },
    rawBody,
    payload: testPayload
  });
  const firstAuditedEndpoint = await fetchEndpoint({
    id: "contract:1",
    method: "current",
    url: "https://webapi.sporttery.cn/contract-1",
    sourceCycleId,
    request: mockRequest,
    clock,
    role: "contract-current",
    page: 1,
    attestationSigner: collectorContext.keyPair,
  });
  const secondAuditedEndpoint = await fetchEndpoint({
    id: "contract:2",
    method: "current",
    url: "https://webapi.sporttery.cn/contract-2",
    sourceCycleId,
    request: mockRequest,
    clock,
    role: "contract-current",
    page: 2,
    attestationSigner: collectorContext.keyPair,
  });
  const expectedSha256 = crypto.createHash("sha256").update(rawBody).digest("hex");
  push("collector clock contract waits for response completion", (
    Date.parse(firstAuditedEndpoint.receivedAt) >= Date.parse(firstAuditedEndpoint.requestedAt)
    && Date.parse(secondAuditedEndpoint.receivedAt) >= Date.parse(secondAuditedEndpoint.requestedAt)
    && firstAuditedEndpoint.fetchedAt === firstAuditedEndpoint.receivedAt
    && secondAuditedEndpoint.fetchedAt === secondAuditedEndpoint.receivedAt
  ), {
    firstRequestedAt: firstAuditedEndpoint.requestedAt,
    firstReceivedAt: firstAuditedEndpoint.receivedAt,
    secondRequestedAt: secondAuditedEndpoint.requestedAt,
    secondReceivedAt: secondAuditedEndpoint.receivedAt
  });
  push("collector source cycle is stable across endpoints", (
    firstAuditedEndpoint.sourceCycleId === sourceCycleId
    && secondAuditedEndpoint.sourceCycleId === sourceCycleId
    && firstAuditedEndpoint.collectorProvenance?.sourceCycleId === sourceCycleId
    && secondAuditedEndpoint.collectorProvenance?.sourceCycleId === sourceCycleId
  ), { sourceCycleId });
  push("raw response hash and bytes match exact content", (
    firstAuditedEndpoint.rawBytes === rawBody.length
    && firstAuditedEndpoint.rawSha256 === expectedSha256
    && firstAuditedEndpoint.rawSha256 === sha256Buffer(rawBody)
    && firstAuditedEndpoint.httpStatus === 200
    && firstAuditedEndpoint.httpDate === "Thu, 16 Jul 2026 02:20:00 GMT"
    && firstAuditedEndpoint.httpEtag === "\"sporttery-contract\""
  ), {
    rawBytes: firstAuditedEndpoint.rawBytes,
    rawSha256: firstAuditedEndpoint.rawSha256,
    expectedSha256
  });
  const signedCollectorAudit = verifyCollectorAttestation(
    firstAuditedEndpoint.collectorAttestation,
    { trustRegistry: collectorContext.registry, payload: testPayload },
  );
  push("collector signs canonical endpoint commitment with a dedicated trusted key", (
    signedCollectorAudit.eligible
    && firstAuditedEndpoint.canonicalPayloadSha256 === firstAuditedEndpoint.collectorAttestation?.commitment?.canonicalPayloadSha256
    && firstAuditedEndpoint.collectorAttestation?.commitment?.endpoint?.page === 1
    && firstAuditedEndpoint.collectorAttestation?.commitment?.endpoint?.role === "contract-current"
    && !Object.prototype.hasOwnProperty.call(firstAuditedEndpoint.collectorAttestation || {}, "publicKeyPem")
    && !Object.prototype.hasOwnProperty.call(firstAuditedEndpoint.collectorAttestation || {}, "verified")
  ), { signedCollectorAudit });
  const parsedCurlHeaders = parseCurlResponseHeaders([
    "HTTP/1.1 200 Connection established",
    "",
    "HTTP/2 200",
    "date: Thu, 16 Jul 2026 02:20:00 GMT",
    "etag: \"curl-contract\"",
    "content-type: application/json",
    ""
  ].join("\r\n"));
  push("curl transport retains final HTTP status Date and ETag", (
    parsedCurlHeaders.statusCode === 200
    && parsedCurlHeaders.headers.date === "Thu, 16 Jul 2026 02:20:00 GMT"
    && parsedCurlHeaders.headers.etag === "\"curl-contract\""
  ), { parsedCurlHeaders });
  push("provider observation stays distinct from collector receipt", (
    firstAuditedEndpoint.providerObservedAt === "2026-07-16T02:19:30.000Z"
    && firstAuditedEndpoint.providerObservedAt !== firstAuditedEndpoint.receivedAt
    && firstAuditedEndpoint.providerObservation?.source === "sporttery-payload-updateDate-updateTime"
  ), {
    providerObservedAt: firstAuditedEndpoint.providerObservedAt,
    collectorReceivedAt: firstAuditedEndpoint.receivedAt
  });

  const notModifiedRaw = Buffer.alloc(0);
  let notModifiedError = null;
  try {
    const failedTimes = ["2026-07-16T02:21:00.000Z", "2026-07-16T02:21:00.010Z"];
    await fetchEndpoint({
      id: "contract:304",
      method: "current",
      url: "https://webapi.sporttery.cn/not-modified",
      sourceCycleId,
      clock: () => failedTimes.shift(),
      request: async () => {
        const error = new Error("HTTP 304");
        error.response = {
          statusCode: 304,
          headers: { date: "Thu, 16 Jul 2026 02:21:00 GMT", etag: "\"unchanged\"" },
          rawBody: notModifiedRaw
        };
        throw error;
      }
    });
  } catch (error) {
    notModifiedError = error;
  }
  push("304 failure records collector facts without inventing provider time", (
    notModifiedError?.collectorAudit?.httpStatus === 304
    && notModifiedError.collectorAudit.providerObservedAt === null
    && notModifiedError.collectorAudit.providerObservation === null
    && notModifiedError.collectorAudit.rawBytes === 0
    && notModifiedError.collectorAudit.rawSha256 === sha256Buffer(notModifiedRaw)
    && Date.parse(notModifiedError.collectorAudit.receivedAt) >= Date.parse(notModifiedError.collectorAudit.requestedAt)
  ), { collectorAudit: notModifiedError?.collectorAudit || null });

  let snapshot = null;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    push("snapshot json parse", true);
  } catch (error) {
    push("snapshot json parse", false, { error: error.message || String(error) });
  }

  const entries = Array.isArray(snapshot?.endpoints)
    ? snapshot.endpoints
    : Array.isArray(snapshot?.payloads)
      ? snapshot.payloads
      : [];
  const usable = entries.filter((entry) => (
    entry?.payload
    && entry.ok !== false
    && rowsInPayload(entry.payload) > 0
  ));
  const rows = usable.reduce((sum, entry) => sum + rowsInPayload(entry.payload), 0);
  const reportedEndpoints = Number(snapshot?.summary?.endpoints);
  const reportedUsableEndpoints = Number(snapshot?.summary?.usableEndpoints);
  const reportedRows = Number(snapshot?.summary?.rows);
  const endpointRowMismatches = usable
    .map((entry, index) => ({
      index,
      reported: entry?.rows === undefined || entry?.rows === null ? null : Number(entry.rows),
      actual: rowsInPayload(entry.payload)
    }))
    .filter((entry) => entry.reported !== null && (!Number.isSafeInteger(entry.reported) || entry.reported !== entry.actual));
  const methods = Array.from(new Set(usable.map((entry) => String(entry.method || entry.id || "")).filter(Boolean)));
  const capturedAt = snapshot?.capturedAt || snapshot?.updatedAt || null;
  const capturedMs = Date.parse(capturedAt || "");
  const ageMinutes = Number.isFinite(capturedMs) ? (Date.now() - capturedMs) / 60000 : Infinity;
  const fresh = Number.isFinite(ageMinutes) && ageMinutes <= maxAgeMinutes;
  const trusted = rows >= minTrustedRows && usable.length >= minTrustedEndpoints;
  const staleFallbackUsable = trusted
    && Number.isFinite(ageMinutes)
    && ageMinutes <= staleFallbackMaxAgeMinutes;
  const hasCurrentOrCalculator = methods.some((method) => ["current", "calculator"].includes(method));
  const hasPagedMethod = methods.some((method) => ["concern", "live", "result", "all"].includes(method));
  const provenanceEnabled = Number(snapshot?.provenanceVersion || 0) >= 1;
  const provenanceEntries = entries.concat(Array.isArray(snapshot?.errors) ? snapshot.errors : []);
  const clockViolations = provenanceEntries.filter((entry) => (
    !Number.isFinite(Date.parse(entry?.requestedAt || ""))
    || !Number.isFinite(Date.parse(entry?.receivedAt || ""))
    || Date.parse(entry.receivedAt) < Date.parse(entry.requestedAt)
    || entry.fetchedAt !== entry.receivedAt
  ));
  const cycleViolations = provenanceEntries.filter((entry) => entry?.sourceCycleId !== snapshot?.sourceCycleId);
  const rawAuditViolations = entries.filter((entry) => (
    !Number.isSafeInteger(entry?.rawBytes)
    || entry.rawBytes < 0
    || !/^[a-f0-9]{64}$/.test(String(entry?.rawSha256 || ""))
    || !Number.isInteger(entry?.httpStatus)
    || entry.httpStatus < 200
    || entry.httpStatus >= 300
    || entry?.sourceRequest?.url !== entry?.url
    || entry?.sourceRequest?.method !== "GET"
  ));
  const failedProviderTimeViolations = (Array.isArray(snapshot?.errors) ? snapshot.errors : [])
    .filter((entry) => entry?.providerObservedAt !== null || entry?.providerObservation !== null);

  push("snapshot schema", snapshot?.version === 1 && (snapshot?.source || "").includes("sporttery"), {
    version: snapshot?.version || null,
    source: snapshot?.source || null
  });
  if (provenanceEnabled) {
    push("snapshot collector provenance clock", (
      typeof snapshot?.sourceCycleId === "string"
      && snapshot.sourceCycleId.startsWith("sporttery-relay:")
      && snapshot?.collectorProvenance?.sourceCycleId === snapshot.sourceCycleId
      && Number.isFinite(Date.parse(snapshot?.requestedAt || ""))
      && Number.isFinite(Date.parse(snapshot?.completedAt || ""))
      && Date.parse(snapshot.completedAt) >= Date.parse(snapshot.requestedAt)
    ), {
      sourceCycleId: snapshot?.sourceCycleId || null,
      requestedAt: snapshot?.requestedAt || null,
      completedAt: snapshot?.completedAt || null
    });
    push("all endpoint attempts retain one collector cycle and non-regressing clocks", (
      provenanceEntries.length > 0
      && clockViolations.length === 0
      && cycleViolations.length === 0
    ), { attempts: provenanceEntries.length, clockViolations, cycleViolations });
    push("successful endpoints retain HTTP and raw-response audit fields", rawAuditViolations.length === 0, {
      endpoints: entries.length,
      rawAuditViolations
    });
    push("failed endpoint attempts never invent provider observation time", failedProviderTimeViolations.length === 0, {
      failures: Array.isArray(snapshot?.errors) ? snapshot.errors.length : 0,
      failedProviderTimeViolations
    });
  } else {
    warnings.push("legacy relay snapshot accepted without collector provenance; the next collection will emit provenanceVersion 1");
  }
  push("snapshot fresh", fresh || staleFallbackUsable, {
    capturedAt,
    fresh,
    staleFallbackUsable,
    ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
    maxAgeMinutes,
    staleFallbackMaxAgeMinutes,
    trusted,
    minTrustedRows,
    minTrustedEndpoints
  });
  if (!fresh && staleFallbackUsable) {
    warnings.push("relay snapshot is stale for the primary source window but remains inside the C-end fallback reliability window");
  }
  push("usable endpoints", usable.length > 0, { usableEndpoints: usable.length, endpoints: entries.length });
  push("minimum rows", rows >= minRows, { rows, minRows });
  push("summary matches endpoint payloads", Number.isSafeInteger(reportedEndpoints)
    && reportedEndpoints === entries.length
    && Number.isSafeInteger(reportedUsableEndpoints)
    && reportedUsableEndpoints === usable.length
    && Number.isSafeInteger(reportedRows)
    && reportedRows === rows
    && endpointRowMismatches.length === 0, {
      reportedEndpoints,
      actualEndpoints: entries.length,
      reportedUsableEndpoints,
      actualUsableEndpoints: usable.length,
      reportedRows,
      actualRows: rows,
      endpointRowMismatches
    });
  push("has current or calculator", hasCurrentOrCalculator, { methods });
  if (requirePagedMethod) {
    push("has paged method", hasPagedMethod, { methods, requiredByEnv: true });
  } else {
    push("current-only relay accepted", hasCurrentOrCalculator && rows >= minRows, {
      methods,
      hasPagedMethod,
      requiredByEnv: false
    });
    if (!hasPagedMethod) {
      warnings.push("paged Sporttery relay methods are unavailable; current endpoint is enough for live/current freshness");
    }
  }

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    snapshotPath,
    capturedAt,
    ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
    rows,
    usableEndpoints: usable.length,
    methods,
    warnings,
    status: warnings.length ? "watch" : "healthy",
    policy: {
      requirePagedMethod,
      currentOnlyAccepted: !requirePagedMethod,
      maxAgeMinutes,
      staleFallbackMaxAgeMinutes,
      minTrustedRows,
      minTrustedEndpoints
    },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
