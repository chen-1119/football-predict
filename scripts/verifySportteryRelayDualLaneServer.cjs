"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  createFastUploadSnapshot,
  resultFingerprint,
} = require("./sportteryFastResultLane.cjs");
const {
  SPORTTERY_CALCULATOR_URL,
  SPORTTERY_CURRENT_URL,
  SPORTTERY_RESULT_URL,
} = require("./sportteryEndpointContract.cjs");
const {
  buildCollectorCommitment,
  createCollectorKeyPair,
  sha256CollectorJson,
  signCollectorCommitment,
} = require("../src/services/collectorAttestation.cjs");

const rootDir = path.resolve(__dirname, "..");
const adminToken = `dual-lane-${crypto.randomBytes(12).toString("hex")}`;
const checks = [];

const check = (name, ok, detail = {}) => {
  const row = { name, ok: Boolean(ok), ...detail };
  checks.push(row);
  if (!row.ok) throw new Error(`${name} failed: ${JSON.stringify(detail)}`);
};

const sha256File = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

const allocatePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const request = (baseUrl, method, pathname, body = null, authorized = true) => new Promise((resolve, reject) => {
  const bytes = body === null ? null : Buffer.from(JSON.stringify(body));
  const req = http.request(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(authorized ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(bytes ? {
        "content-type": "application/json",
        "content-length": bytes.length,
      } : {}),
    },
    timeout: 15_000,
  }, (res) => {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { raw += chunk; });
    res.on("end", () => {
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
      resolve({ status: Number(res.statusCode || 0), body: payload, raw });
    });
  });
  req.once("timeout", () => req.destroy(new Error(`request timeout: ${pathname}`)));
  req.once("error", reject);
  if (bytes) req.write(bytes);
  req.end();
});

const iso = (ms) => new Date(ms).toISOString();

const endpoint = ({ method, page = null, observedMs, cycleId, marker, rows = 2 }) => {
  const requestedAt = iso(observedMs - 750);
  const receivedAt = iso(observedMs);
  return {
    id: page === null ? method : `method:${method}:${page}`,
    method,
    page,
    ok: true,
    rows,
    sourceCycleId: cycleId,
    requestedAt,
    receivedAt,
    fetchedAt: receivedAt,
    collectorProvenance: {
      sourceCycleId: cycleId,
      requestedAt,
      receivedAt,
    },
    payload: {
      value: {
        matchInfoList: [{
          subMatchList: Array.from({ length: rows }, (_, index) => ({
            matchId: `${marker}-${index + 1}`,
            marker,
          })),
        }],
      },
    },
  };
};

const snapshot = ({ cycleId, observedMs, endpoints, producer = {}, summary = {} }) => {
  const requestedAt = iso(observedMs - 1500);
  const completedAt = iso(observedMs + 250);
  const rows = endpoints.reduce((sum, item) => sum + Number(item.rows || 0), 0);
  const usableEndpoints = endpoints.filter((item) => item.ok !== false && item.payload).length;
  return {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt: requestedAt,
    sourceCycleId: cycleId,
    requestedAt,
    completedAt,
    provenanceVersion: 1,
    collectorProvenance: {
      sourceCycleId: cycleId,
      requestedAt,
      completedAt,
      clock: "collector-owned-wall-clock",
    },
    producer: {
      host: "dual-lane-server-verifier",
      transport: "isolated-http",
      ...producer,
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints,
      rows,
      errors: 0,
      methods: Array.from(new Set(endpoints.map((item) => item.method))),
      ...summary,
    },
    endpoints,
    errors: [],
  };
};

const fullSnapshot = (observedMs, suffix = "a") => {
  const cycleId = `full-cycle-${suffix}`;
  return snapshot({
    cycleId,
    observedMs,
    endpoints: [
      endpoint({ method: "current", observedMs, cycleId, marker: `full-current-${suffix}` }),
      endpoint({ method: "calculator", observedMs: observedMs + 10, cycleId, marker: `full-calculator-${suffix}` }),
      endpoint({ method: "result", page: 1, observedMs: observedMs + 20, cycleId, marker: `full-result-${suffix}` }),
      endpoint({ method: "all", page: 1, observedMs: observedMs + 30, cycleId, marker: `full-all-${suffix}` }),
    ],
    summary: { pageDepth: 1, resultPageDepth: 1 },
  });
};

const atomicFastSnapshot = (observedMs, suffix = "a") => {
  const cycleId = `fast-cycle-${suffix}`;
  return snapshot({
    cycleId,
    observedMs,
    endpoints: [
      endpoint({ method: "current", observedMs, cycleId, marker: `fast-current-${suffix}` }),
      endpoint({ method: "calculator", observedMs: observedMs + 10, cycleId, marker: `fast-calculator-${suffix}` }),
    ],
    producer: { uploadMode: "current", atomicSubset: false },
    summary: { uploadMode: "current" },
  });
};

const currentOnlyFastSnapshot = (observedMs, suffix = "a") => {
  const value = atomicFastSnapshot(observedMs, suffix);
  value.endpoints = value.endpoints.filter((item) => item.method === "current");
  value.summary.endpoints = value.endpoints.length;
  value.summary.usableEndpoints = value.endpoints.length;
  value.summary.rows = value.endpoints.reduce((sum, item) => sum + Number(item.rows || 0), 0);
  value.summary.methods = ["current"];
  return value;
};

const signFastSnapshot = (value, signer) => {
  for (const item of value.endpoints || []) {
    if (!["current", "calculator"].includes(item.method)) continue;
    const url = `https://webapi.sporttery.cn/gateway/verifier/${item.method}.qry`;
    const role = item.id || item.method;
    const sourceRequest = { url, method: "GET", page: item.page ?? null, role };
    const response = {
      httpStatus: 200,
      httpDate: null,
      httpEtag: null,
      contentType: "application/json",
      headersSha256: sha256CollectorJson({}),
      rawSha256: sha256CollectorJson(item.payload),
      rawBytes: Buffer.byteLength(JSON.stringify(item.payload)),
    };
    const canonicalPayloadSha256 = sha256CollectorJson(item.payload);
    const commitment = buildCollectorCommitment({
      provider: "sporttery",
      endpoint: sourceRequest,
      collectorCycleId: item.sourceCycleId,
      requestedAt: item.requestedAt,
      receivedAt: item.receivedAt,
      providerObservedAt: null,
      response,
      payload: item.payload,
      canonicalPayloadSha256,
    });
    const collectorAttestation = signCollectorCommitment(commitment, signer);
    Object.assign(item, {
      url,
      sourceRequest,
      collectorRole: role,
      ...response,
      canonicalPayloadSha256,
      collectorAttestation,
      collectorProvenance: {
        sourceCycleId: item.sourceCycleId,
        requestedAt: item.requestedAt,
        receivedAt: item.receivedAt,
        sourceRequest,
        ...response,
        canonicalPayloadSha256,
        collectorAttestation,
      },
    });
  }
  return value;
};

const signedOfficialFastEndpoint = ({ method, page = null, observedMs, cycleId, signer }) => {
  const requestedAt = iso(observedMs - 250);
  const receivedAt = iso(observedMs);
  const beijing = new Date(observedMs + 8 * 60 * 60 * 1000).toISOString();
  const updateDate = beijing.slice(0, 10);
  const updateTime = beijing.slice(11, 19);
  const payload = method === "result"
    ? {
        value: {
          matchInfoList: [{
            businessDate: updateDate,
            subMatchList: [{
              matchId: "watcher-handler-result",
              matchNumDate: updateDate,
              matchNum: "001",
              matchNumStr: "周四001",
              matchStatus: "11",
              matchStatusName: "赛果",
              matchResultStatus: "2",
              poolStatus: "Payout",
              sectionsNo999: "2:1",
              sourceUpdatedAt: receivedAt,
              officialResultIdentity: {
                provider: "sporttery",
                endpoint: "getUniformMatchResultV1",
                matchId: "watcher-handler-result",
                providerUpdatedAt: receivedAt,
              },
              officialPayoutSp: { h: "1.90", d: "3.20", a: "3.80" },
            }],
          }],
        },
      }
    : {
        value: {
          lastUpdateTime: `${updateDate} ${updateTime}`,
          matchInfoList: [{
            businessDate: updateDate,
            subMatchList: [{
              matchId: "watcher-handler-market",
              oddsList: [
                { poolCode: "HAD", h: 1.9, d: 3.2, a: 3.8, updateDate, updateTime },
                { poolCode: "HHAD", goalLine: "-1", h: 3.1, d: 3.45, a: 1.95, updateDate, updateTime },
              ],
            }],
          }],
        },
      };
  const url = {
    current: SPORTTERY_CURRENT_URL,
    calculator: SPORTTERY_CALCULATOR_URL,
    result: SPORTTERY_RESULT_URL,
  }[method];
  const sourceRequest = { url, method: "GET", page, role: method };
  const response = {
    httpStatus: 200,
    httpDate: null,
    httpEtag: null,
    contentType: "application/json",
    headersSha256: sha256CollectorJson({}),
    rawSha256: sha256CollectorJson(payload),
    rawBytes: Buffer.byteLength(JSON.stringify(payload)),
  };
  const canonicalPayloadSha256 = sha256CollectorJson(payload);
  const commitment = buildCollectorCommitment({
    provider: "sporttery",
    endpoint: sourceRequest,
    collectorCycleId: cycleId,
    requestedAt,
    receivedAt,
    providerObservedAt: null,
    response,
    payload,
    canonicalPayloadSha256,
  });
  const collectorAttestation = signCollectorCommitment(commitment, signer);
  return {
    id: method,
    method,
    page,
    url,
    ok: true,
    rows: 1,
    sourceCycleId: cycleId,
    requestedAt,
    receivedAt,
    fetchedAt: receivedAt,
    sourceRequest,
    collectorRole: method,
    ...response,
    canonicalPayloadSha256,
    collectorAttestation,
    collectorProvenance: {
      sourceCycleId: cycleId,
      requestedAt,
      receivedAt,
      sourceRequest,
      ...response,
      canonicalPayloadSha256,
      collectorAttestation,
    },
    payload,
  };
};

const watcherEligibleFastSnapshot = (observedMs, signer) => {
  const companionCycleId = "watcher-handler-companion-cycle";
  const probeCycleId = "watcher-handler-result-cycle";
  const current = signedOfficialFastEndpoint({
    method: "current",
    observedMs,
    cycleId: companionCycleId,
    signer,
  });
  const calculator = signedOfficialFastEndpoint({
    method: "calculator",
    observedMs: observedMs + 10,
    cycleId: companionCycleId,
    signer,
  });
  const result = signedOfficialFastEndpoint({
    method: "result",
    page: 1,
    observedMs: observedMs + 20,
    cycleId: probeCycleId,
    signer,
  });
  return createFastUploadSnapshot({
    probeSnapshot: {
      version: 1,
      source: "sporttery-relay-snapshot",
      sourceCycleId: probeCycleId,
      endpoints: [result],
      producer: { runtime: "real-handler-contract-test" },
    },
    companionSnapshot: {
      version: 1,
      source: "sporttery-relay-snapshot",
      sourceCycleId: companionCycleId,
      endpoints: [current, calculator],
      producer: { runtime: "real-handler-contract-test" },
    },
    fingerprint: resultFingerprint(result),
    now: new Date(observedMs + 30),
    uploadCycleId: "watcher-handler-upload-merge-cycle",
  });
};

const waitForServer = async (baseUrl, child) => {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited before readiness: ${child.exitCode}`);
    try {
      const response = await request(baseUrl, "GET", "/api/v1/health", null, false);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("server readiness timed out");
};

const terminate = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

const main = async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "football-relay-dual-lane-"));
  const storeDir = path.join(tempDir, "store");
  const fullPath = path.join(storeDir, "sporttery-relay-snapshot.json");
  const fastPath = path.join(storeDir, "sporttery-relay-fast-lane.json");
  const collectorRegistryPath = path.join(tempDir, "collector-trust-registry.json");
  const collectorSigner = createCollectorKeyPair({
    keyId: "dual-lane-server-test-collector",
    independenceDomain: "dual-lane-server-test-runtime",
  });
  await fsp.writeFile(collectorRegistryPath, `${JSON.stringify(collectorSigner.registry, null, 2)}\n`, "utf8");
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  let child = null;
  try {
    child = spawn(process.execPath, [path.join(rootDir, "server", "index.cjs")], {
      cwd: rootDir,
      env: {
        ...process.env,
        // Post-swap verifiers inherit primary mode; the relay fixture must not.
        FOOTBALL_POSTGRES_MODE: "disabled",
        FOOTBALL_POSTGRES_URL: "",
        DATABASE_URL: "",
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(port),
        SERVER_STORE_DIR: storeDir,
        DATA_STORE_DIR: storeDir,
        DATASTORE_READ_SOURCE: "file",
        DATASTORE_SQLITE_PATH: path.join(storeDir, "football.db"),
        SPORTTERY_RELAY_SNAPSHOT: fullPath,
        SPORTTERY_RELAY_FAST_LANE_SNAPSHOT: fastPath,
        SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH: collectorRegistryPath,
        SPORTTERY_RELAY_MIN_TRUSTED_ROWS: "4",
        SPORTTERY_RELAY_MIN_TRUSTED_ENDPOINTS: "2",
        SPORTTERY_RELAY_MAX_AGE_MINUTES: "20",
        SOURCE_MAX_AGE_MINUTES: "20",
        ADMIN_TOKEN: adminToken,
        ACCESS_CODE_ADMIN_TOKEN: adminToken,
        ACCESS_CODE_SECRET: `${adminToken}-access`,
        ENABLE_SYNC_CRON: "0",
        ENABLE_GPT_CRON: "0",
        SYNC_WORKER_EVENT_BRIDGE: "0",
        RELAY_FAST_WATCHER_ENABLED: "0",
        SKIP_SPORTTERY_DIRECT_FETCH: "1",
        SPORTTERY_DIRECT_FETCH: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-20_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    await waitForServer(baseUrl, child);

    const unauthorized = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?validateOnly=1",
      { snapshot: atomicFastSnapshot(Date.now() - 60_000, "unauthorized") },
      false
    );
    check("fast admin endpoint requires authorization", unauthorized.status === 401, { status: unauthorized.status });

    const fullObservedMs = Date.now() - 90_000;
    const full = fullSnapshot(fullObservedMs, "initial");
    const fullUpload = await request(baseUrl, "POST", "/api/admin/sporttery-relay-snapshot?runSync=0", { snapshot: full });
    check("complete full snapshot accepted", fullUpload.status === 200 && fullUpload.body?.storedValidation?.ok === true, {
      status: fullUpload.status,
      error: fullUpload.body?.error || null,
    });
    check("full upload is an atomic replacement without merge", fullUpload.body?.mergedWithPrevious === false
      && fullUpload.body?.fastLaneUntouched === true, {
      mergedWithPrevious: fullUpload.body?.mergedWithPrevious ?? null,
      fastLaneUntouched: fullUpload.body?.fastLaneUntouched ?? null,
    });
    check("full file written and fast file not synthesized", fs.existsSync(fullPath) && !fs.existsSync(fastPath));
    const initialFullHash = sha256File(fullPath);

    const optionalLaneFailure = fullSnapshot(fullObservedMs + 500, "optional-lane-failure");
    optionalLaneFailure.endpoints = optionalLaneFailure.endpoints.filter((item) => item.method !== "calculator");
    optionalLaneFailure.errors = [{
      id: "calculator",
      method: "calculator",
      error: "read ECONNRESET",
      sourceCycleId: optionalLaneFailure.sourceCycleId,
      requestedAt: iso(fullObservedMs - 750),
      receivedAt: iso(fullObservedMs),
    }];
    optionalLaneFailure.summary.endpoints = optionalLaneFailure.endpoints.length;
    optionalLaneFailure.summary.usableEndpoints = optionalLaneFailure.endpoints.length;
    optionalLaneFailure.summary.rows = optionalLaneFailure.endpoints.reduce((sum, item) => sum + Number(item.rows || 0), 0);
    optionalLaneFailure.summary.errors = 1;
    optionalLaneFailure.summary.methods = Array.from(new Set(optionalLaneFailure.endpoints.map((item) => item.method)));
    const optionalLaneFailureAccepted = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-snapshot?validateOnly=1",
      { snapshot: optionalLaneFailure }
    );
    check("full archive accepts a disclosed optional calculator failure", (
      optionalLaneFailureAccepted.status === 200
      && optionalLaneFailureAccepted.body?.validation?.blockingCollectionErrors?.length === 0
      && optionalLaneFailureAccepted.body?.validation?.collectionErrors?.length === 1
    ), {
      status: optionalLaneFailureAccepted.status,
      validation: optionalLaneFailureAccepted.body?.validation || null,
    });

    const archiveFailure = fullSnapshot(fullObservedMs + 750, "archive-failure");
    archiveFailure.errors = [{
      id: "method:result:2",
      method: "result",
      page: 2,
      error: "read ECONNRESET",
      sourceCycleId: archiveFailure.sourceCycleId,
      requestedAt: iso(fullObservedMs - 750),
      receivedAt: iso(fullObservedMs),
    }];
    archiveFailure.summary.errors = 1;
    const archiveFailureRejected = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-snapshot?validateOnly=1",
      { snapshot: archiveFailure }
    );
    check("full archive rejects a disclosed result-page failure", (
      archiveFailureRejected.status === 400
      && archiveFailureRejected.body?.validation?.blockingCollectionErrors?.length === 1
    ), {
      status: archiveFailureRejected.status,
      validation: archiveFailureRejected.body?.validation || null,
    });

    const compactFull = {
      ...full,
      producer: { ...full.producer, atomicSubset: true, uploadMode: "live" },
      summary: { ...full.summary, omittedEndpoints: 5, uploadMode: "live" },
    };
    const compactReject = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-snapshot?validateOnly=1",
      { snapshot: compactFull }
    );
    check("full endpoint rejects compact snapshot", compactReject.status === 400
      && compactReject.body?.validation?.compactMarkers === true, { status: compactReject.status });

    const mixedFull = fullSnapshot(fullObservedMs + 1000, "mixed");
    mixedFull.endpoints[3] = {
      ...mixedFull.endpoints[3],
      sourceCycleId: "other-full-cycle",
      collectorProvenance: {
        ...mixedFull.endpoints[3].collectorProvenance,
        sourceCycleId: "other-full-cycle",
      },
    };
    const mixedReject = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-snapshot?validateOnly=1",
      { snapshot: mixedFull }
    );
    check("full endpoint rejects mixed source cycles", mixedReject.status === 400
      && mixedReject.body?.validation?.cycle?.atomic === false, { status: mixedReject.status });

    const fastObservedMs = Date.now() - 45_000;
    const currentOnly = currentOnlyFastSnapshot(fastObservedMs - 1000, "current-only");
    const currentOnlyAccepted = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?validateOnly=1",
      { snapshot: currentOnly }
    );
    check("signed-clock-compatible current-only fast snapshot is accepted", (
      currentOnlyAccepted.status === 200
      && currentOnlyAccepted.body?.validation?.provenanceMode === "single-cycle-atomic"
      && currentOnlyAccepted.body?.validation?.methods?.length === 1
      && currentOnlyAccepted.body?.validation?.methods?.[0] === "current"
    ), {
      status: currentOnlyAccepted.status,
      checks: currentOnlyAccepted.body?.validation?.checks || null,
    });

    const optionalCalculatorFailure = currentOnlyFastSnapshot(
      fastObservedMs - 500,
      "current-only-calculator-failed",
    );
    optionalCalculatorFailure.errors = [{
      id: "calculator",
      method: "calculator",
      error: "HTTP 403 WAF",
      sourceCycleId: optionalCalculatorFailure.sourceCycleId,
      requestedAt: iso(fastObservedMs - 800),
      receivedAt: iso(fastObservedMs - 500),
    }];
    optionalCalculatorFailure.summary.errors = 1;
    const optionalCalculatorFailureAccepted = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?validateOnly=1",
      { snapshot: optionalCalculatorFailure },
    );
    check("current-only fast snapshot accepts a disclosed optional calculator failure", (
      optionalCalculatorFailureAccepted.status === 200
      && optionalCalculatorFailureAccepted.body?.validation?.blockingCollectionErrors?.length === 0
      && optionalCalculatorFailureAccepted.body?.validation?.collectionErrors?.length === 1
    ), {
      status: optionalCalculatorFailureAccepted.status,
      validation: optionalCalculatorFailureAccepted.body?.validation || null,
    });

    const unknownFastFailure = currentOnlyFastSnapshot(
      fastObservedMs - 250,
      "current-only-unknown-failed",
    );
    unknownFastFailure.errors = [{
      id: "unknown-source",
      method: "unknown-source",
      error: "unclassified collection failure",
      sourceCycleId: unknownFastFailure.sourceCycleId,
      requestedAt: iso(fastObservedMs - 500),
      receivedAt: iso(fastObservedMs - 250),
    }];
    unknownFastFailure.summary.errors = 1;
    const unknownFastFailureRejected = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?validateOnly=1",
      { snapshot: unknownFastFailure },
    );
    check("current-only fast snapshot rejects an unknown collection failure", (
      unknownFastFailureRejected.status === 400
      && unknownFastFailureRejected.body?.validation?.blockingCollectionErrors?.length === 1
    ), {
      status: unknownFastFailureRejected.status,
      validation: unknownFastFailureRejected.body?.validation || null,
    });

    const fast = atomicFastSnapshot(fastObservedMs, "atomic");
    const fastUpload = await request(baseUrl, "POST", "/api/admin/sporttery-relay-fast-lane?runSync=0", { snapshot: fast });
    check("single-cycle atomic fast snapshot accepted", fastUpload.status === 200
      && fastUpload.body?.storedValidation?.provenanceMode === "single-cycle-atomic", {
      status: fastUpload.status,
      error: fastUpload.body?.error || null,
    });
    check("fast upload cannot modify full file", initialFullHash === sha256File(fullPath)
      && fastUpload.body?.fullSnapshotUntouched === true);
    const fastHash = sha256File(fastPath);

    const fullIntoFast = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?validateOnly=1",
      { snapshot: fullSnapshot(Date.now() - 40_000, "wrong-lane") }
    );
    check("fast endpoint rejects archive methods", fullIntoFast.status === 400, { status: fullIntoFast.status });

    const resultPageTwo = atomicFastSnapshot(Date.now() - 40_000, "page-two");
    const resultCycleId = resultPageTwo.sourceCycleId;
    resultPageTwo.endpoints.push(endpoint({
      method: "result",
      page: 2,
      observedMs: Date.now() - 39_000,
      cycleId: resultCycleId,
      marker: "result-page-two",
    }));
    resultPageTwo.summary.endpoints = resultPageTwo.endpoints.length;
    resultPageTwo.summary.usableEndpoints = resultPageTwo.endpoints.length;
    resultPageTwo.summary.rows = resultPageTwo.endpoints.reduce((sum, item) => sum + item.rows, 0);
    resultPageTwo.summary.methods = ["current", "calculator", "result"];
    const pageTwoReject = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?validateOnly=1",
      { snapshot: resultPageTwo }
    );
    check("fast endpoint rejects result pages beyond page one", pageTwoReject.status === 400, { status: pageTwoReject.status });

    const older = atomicFastSnapshot(fastObservedMs - 60_000, "older");
    const olderReject = await request(baseUrl, "POST", "/api/admin/sporttery-relay-fast-lane?runSync=0", { snapshot: older });
    check("fast endpoint rejects same-key clock regression", olderReject.status === 409
      && olderReject.body?.code === "RELAY_FAST_LANE_MONOTONICITY_REJECTED", {
      status: olderReject.status,
      code: olderReject.body?.code || null,
    });
    check("rejected fast regression leaves fast file unchanged", fastHash === sha256File(fastPath));

    const companionObservedMs = Date.now() - 20_000;
    const probeObservedMs = companionObservedMs + 5_000;
    const companion = atomicFastSnapshot(companionObservedMs, "companion");
    const probeCycleId = "probe-result-cycle";
    const probe = snapshot({
      cycleId: probeCycleId,
      observedMs: probeObservedMs,
      endpoints: [endpoint({
        method: "result",
        page: 1,
        observedMs: probeObservedMs,
        cycleId: probeCycleId,
        marker: "probe-result",
      })],
    });
    const uploadMerge = createFastUploadSnapshot({
      probeSnapshot: probe,
      companionSnapshot: companion,
      fingerprint: crypto.randomBytes(32).toString("hex"),
      now: new Date(probeObservedMs + 1000),
      uploadCycleId: "explicit-upload-merge-cycle",
    });
    const mergeUpload = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?runSync=0",
      { snapshot: uploadMerge }
    );
    check("explicit upload-merge provenance accepted", mergeUpload.status === 200
      && mergeUpload.body?.storedValidation?.provenanceMode === "upload-merge", {
      status: mergeUpload.status,
      blockers: mergeUpload.body?.validation?.uploadMerge?.blockers || null,
    });
    check("upload-merge still leaves full archive byte-identical", initialFullHash === sha256File(fullPath));

    const laterCurrent = atomicFastSnapshot(probeObservedMs + 1000, "later-current-heartbeat");
    const laterCurrentUpload = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?runSync=0",
      { snapshot: laterCurrent }
    );
    const fastAfterLaterCurrent = JSON.parse(fs.readFileSync(fastPath, "utf8"));
    const retainedResultAfterLaterCurrent = fastAfterLaterCurrent.endpoints.find(
      (item) => item.method === "result" && Number(item.page) === 1
    );
    check("later current-only fast upload preserves the last result page", (
      laterCurrentUpload.status === 200
      && laterCurrentUpload.body?.mergedWithPreviousResult === true
      && laterCurrentUpload.body?.storedValidation?.provenanceMode === "upload-merge"
      && retainedResultAfterLaterCurrent?.receivedAt === uploadMerge.endpoints
        .find((item) => item.method === "result")?.receivedAt
    ), {
      status: laterCurrentUpload.status,
      mergedWithPreviousResult: laterCurrentUpload.body?.mergedWithPreviousResult ?? null,
      retainedResultObservedAt: laterCurrentUpload.body?.retainedResultObservedAt || null,
    });

    const fastBeforeFullReplace = sha256File(fastPath);
    const secondFull = fullSnapshot(Date.now() - 30_000, "replacement");
    const secondFullUpload = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-snapshot?runSync=0",
      { snapshot: secondFull }
    );
    check("later full upload replaces only full file", secondFullUpload.status === 200
      && secondFullUpload.body?.replacedPrevious === true
      && sha256File(fastPath) === fastBeforeFullReplace);

    const watcherContractSnapshot = watcherEligibleFastSnapshot(Date.now() - 8_000, collectorSigner);
    const watcherContractUpload = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?runSync=0",
      { snapshot: watcherContractSnapshot },
    );
    check("real fast handler distinguishes durable storage from watcher publication eligibility", (
      watcherContractUpload.status === 200
      && watcherContractUpload.body?.stored === true
      && watcherContractUpload.body?.storedValidation?.ok === true
      && watcherContractUpload.body?.watcherEligible === true
      && watcherContractUpload.body?.publicationEligibility?.eligible === true
      && watcherContractUpload.body?.publicationEligibility?.validator === "auditRelayFastResultEligibility"
      && watcherContractUpload.body?.publicationEligibility?.structureEligible === true
      && watcherContractUpload.body?.publicationEligibility?.endpointTrustEligible === true
    ), {
      status: watcherContractUpload.status,
      stored: watcherContractUpload.body?.stored ?? null,
      watcherEligible: watcherContractUpload.body?.watcherEligible ?? null,
      publicationEligibility: watcherContractUpload.body?.publicationEligibility || null,
    });

    const signedFast = signFastSnapshot(
      atomicFastSnapshot(Date.now() - 5_000, "signed-attested"),
      collectorSigner,
    );
    const signedFastUpload = await request(
      baseUrl,
      "POST",
      "/api/admin/sporttery-relay-fast-lane?runSync=0",
      { snapshot: signedFast },
    );
    check("cryptographically attested fast market lane accepted", (
      signedFastUpload.status === 200
      && signedFastUpload.body?.stored === true
      && signedFastUpload.body?.storedValidation?.ok === true
      && signedFastUpload.body?.mergedWithPreviousResult === true
    ), {
      status: signedFastUpload.status,
      error: signedFastUpload.body?.error || null,
      mergedWithPreviousResult: signedFastUpload.body?.mergedWithPreviousResult ?? null,
    });
    check("stored fast snapshot is not mislabeled watcher-eligible when endpoint trust fails", (
      signedFastUpload.body?.stored === true
      && signedFastUpload.body?.watcherEligible === false
      && signedFastUpload.body?.publicationEligibility?.eligible === false
      && signedFastUpload.body?.publicationEligibility?.blocker === "relay-fast-endpoint-trust-invalid"
    ), {
      stored: signedFastUpload.body?.stored ?? null,
      watcherEligible: signedFastUpload.body?.watcherEligible ?? null,
      publicationEligibility: signedFastUpload.body?.publicationEligibility || null,
    });

    const finalFastSnapshot = JSON.parse(fs.readFileSync(fastPath, "utf8"));
    const finalFastResult = finalFastSnapshot.endpoints.find(
      (item) => item.method === "result" && Number(item.page) === 1,
    );
    const health = await request(baseUrl, "GET", "/api/v1/source-health", null, false);
    const relay = health.body?.sportteryRelaySnapshot;
    check("health prefers fresh fast current lane", health.status === 200
      && relay?.currentSource === "fast-lane-file"
      && relay?.currentLane?.capturedAt === signedFast.endpoints
        .filter((item) => ["current", "calculator"].includes(item.method))
        .map((item) => item.receivedAt)
        .sort()[0], {
      status: health.status,
      currentSource: relay?.currentSource || null,
      capturedAt: relay?.currentLane?.capturedAt || null,
    });
    check("health keeps the fresh fast result lane after later current heartbeats", (
      relay?.resultSource === "fast-lane-file"
      && relay?.resultLane?.capturedAt === finalFastResult?.receivedAt
      && relay?.resultLane?.rows > 0
    ), {
      resultSource: relay?.resultSource || null,
      capturedAt: relay?.resultLane?.capturedAt || null,
      rows: relay?.resultLane?.rows ?? null,
    });
    check("health reports full history independently", relay?.fullHistorySource === "full-snapshot"
      && relay?.storagePolicy === "dual-file-no-flattening"
      && relay?.fullSnapshot?.fileName === path.basename(fullPath)
      && relay?.fastLaneSnapshot?.fileName === path.basename(fastPath)
      && relay?.historyLane?.methods?.includes("result")
      && relay?.historyLane?.methods?.includes("all"), {
      fullHistorySource: relay?.fullHistorySource || null,
      historyMethods: relay?.historyLane?.methods || null,
    });
    check("public health exposes both physical lane summaries", health.body?.sportteryRelayFullSnapshot?.fileName === path.basename(fullPath)
      && health.body?.sportteryRelayFastLaneSnapshot?.fileName === path.basename(fastPath));
    check("health counts one verified market collector without claiming redundancy", (
      relay?.collectorAttestation?.trustedCollectorCount === 1
      && relay?.collectorAttestation?.trustedKeyCount === 1
      && relay?.collectorAttestation?.trustedEndpoints === 2
      && relay?.collectorAttestation?.independenceDomains?.[0] === "dual-lane-server-test-runtime"
      && relay?.collectorAttestation?.unassignedKeyIds?.length === 0
      && health.body?.officialSourceRedundancy?.trustedCollectorCount === 1
      && health.body?.officialSourceRedundancy?.requiredTrustedCollectors === 2
      && health.body?.officialSourceRedundancy?.officialSourceSinglePoint === true
      && health.body?.officialSourceRedundancy?.mode === "single-collector"
      && health.body?.officialSourceRedundancy?.collectorProof === "current-cryptographically-attested-market-lane"
    ), {
      collectorAttestation: relay?.collectorAttestation || null,
      officialSourceRedundancy: health.body?.officialSourceRedundancy || null,
    });

    console.log(JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      checks,
      fullPath: path.basename(fullPath),
      fastPath: path.basename(fastPath),
    }, null, 2));
  } catch (error) {
    error.message = `${error.message}\nserver stdout:\n${stdout}\nserver stderr:\n${stderr}`;
    throw error;
  } finally {
    await terminate(child);
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
