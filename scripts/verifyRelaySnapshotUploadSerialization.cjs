"use strict";

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-relay-upload-serialization-"));
const storeDir = path.join(tempDir, "store");
const fullPath = path.join(storeDir, "sporttery-relay-snapshot.json");
const fastPath = path.join(storeDir, "sporttery-relay-fast-lane.json");
const adminToken = "relay-upload-serialization-admin";
const checks = [];
let child = null;
let childLogs = "";
let port = null;
let baseUrl = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const iso = (ms) => new Date(ms).toISOString();

const allocatePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const allocated = server.address().port;
    server.close((error) => error ? reject(error) : resolve(allocated));
  });
});

const request = (method, pathname, body = null, headers = {}) => new Promise((resolve, reject) => {
  const payload = body === null ? "" : JSON.stringify(body);
  const req = http.request(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(payload ? {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      } : {}),
      ...headers,
    },
  }, (res) => {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { raw += chunk; });
    res.on("end", () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      resolve({ status: Number(res.statusCode || 0), body: parsed, raw });
    });
  });
  req.on("error", reject);
  if (payload) req.write(payload);
  req.end();
});

const postFull = (snapshot, extra = {}) => request(
  "POST",
  "/api/admin/sporttery-relay-snapshot?runSync=0",
  { snapshot, ...extra },
  { authorization: `Bearer ${adminToken}` }
);

const postFast = (snapshot, extra = {}) => request(
  "POST",
  "/api/admin/sporttery-relay-fast-lane?runSync=0",
  { snapshot, ...extra },
  { authorization: `Bearer ${adminToken}` }
);

const adminHealth = () => request("GET", "/api/admin/health", null, {
  authorization: `Bearer ${adminToken}`,
});

const endpoint = ({ method, observedMs, cycleId, marker, page = null, rows = 2 }) => {
  const requestedAt = iso(observedMs - 500);
  const receivedAt = iso(observedMs);
  return {
    id: page === null ? method : `method:${method}:${page}`,
    method,
    ...(page === null ? {} : { page }),
    ok: true,
    rows,
    sourceCycleId: cycleId,
    requestedAt,
    receivedAt,
    fetchedAt: receivedAt,
    collectorProvenance: { sourceCycleId: cycleId, requestedAt, receivedAt },
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

const snapshot = ({ cycleId, observedMs, endpoints, uploadMode = "full" }) => {
  const requestedAt = iso(observedMs - 1000);
  const completedAt = iso(observedMs + 250);
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
      host: "relay-upload-serialization-verifier",
      transport: "isolated-http",
      ...(uploadMode === "full" ? {} : { uploadMode }),
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows: endpoints.reduce((sum, item) => sum + Number(item.rows || 0), 0),
      errors: 0,
      methods: Array.from(new Set(endpoints.map((item) => item.method))),
      ...(uploadMode === "full" ? { pageDepth: 1, resultPageDepth: 1 } : { uploadMode }),
    },
    endpoints,
    errors: [],
  };
};

const fullSnapshot = (observedMs, label) => {
  const cycleId = `full-${label}`;
  return snapshot({
    cycleId,
    observedMs,
    endpoints: [
      endpoint({ method: "current", observedMs, cycleId, marker: `${label}-full-current` }),
      endpoint({ method: "calculator", observedMs: observedMs + 10, cycleId, marker: `${label}-full-calculator` }),
      endpoint({ method: "result", page: 1, observedMs: observedMs + 20, cycleId, marker: `${label}-full-result` }),
      endpoint({ method: "all", page: 1, observedMs: observedMs + 30, cycleId, marker: `${label}-full-all` }),
    ],
  });
};

const fastSnapshot = (observedMs, label) => {
  const cycleId = `fast-${label}`;
  return snapshot({
    cycleId,
    observedMs,
    uploadMode: "current",
    endpoints: [
      endpoint({ method: "current", observedMs, cycleId, marker: `${label}-fast-current` }),
      endpoint({ method: "calculator", observedMs: observedMs + 10, cycleId, marker: `${label}-fast-calculator` }),
    ],
  });
};

const marker = (value, method) => value?.endpoints
  ?.find((item) => item.method === method)
  ?.payload?.value?.matchInfoList?.[0]?.subMatchList?.[0]?.marker || null;

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const resetFiles = () => {
  fs.rmSync(fullPath, { recursive: true, force: true });
  fs.rmSync(fastPath, { recursive: true, force: true });
};

const waitForQueuedUpload = async () => {
  let health = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    health = await adminHealth();
    if (Number(health.body?.relaySnapshotUploadQueue?.queueDepth || 0) >= 1) return health;
    await sleep(20);
  }
  return health;
};

const waitForActiveUpload = async () => {
  let health = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    health = await adminHealth();
    if (health.body?.relaySnapshotUploadQueue?.active === true) return health;
    await sleep(20);
  }
  return health;
};

const postAndAbortResponse = (pathname, value, abortAfterMs = 100) => new Promise((resolve) => {
  const payload = JSON.stringify({ snapshot: value });
  const req = http.request(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  });
  let settled = false;
  const finish = (reason) => {
    if (settled) return;
    settled = true;
    resolve(reason);
  };
  req.on("response", (res) => {
    res.resume();
    res.on("end", () => finish("response"));
  });
  req.on("error", () => finish("aborted"));
  req.write(payload);
  req.end();
  setTimeout(() => {
    req.destroy(new Error("intentional verifier disconnect"));
    finish("aborted");
  }, abortAfterMs).unref();
});

const startServer = async () => {
  fs.mkdirSync(storeDir, { recursive: true });
  port = await allocatePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.cjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      SERVER_STORE_DIR: storeDir,
      SPORTTERY_RELAY_SNAPSHOT: fullPath,
      SPORTTERY_RELAY_FAST_LANE_SNAPSHOT: fastPath,
      DATASTORE_READ_SOURCE: "server-db",
      ENABLE_SYNC_CRON: "0",
      ENABLE_GPT_CRON: "0",
      RELAY_FAST_WATCHER_ENABLED: "0",
      SYNC_WORKER_EVENT_BRIDGE: "0",
      ADMIN_TOKEN: adminToken,
      ACCESS_CODE_ADMIN_TOKEN: adminToken,
      ACCESS_CODE_SECRET: "relay-upload-serialization-access-secret",
      SPORTTERY_RELAY_MAX_AGE_MINUTES: "60",
      SPORTTERY_RELAY_MIN_ROWS: "1",
      SPORTTERY_RELAY_MIN_TRUSTED_ROWS: "4",
      SPORTTERY_RELAY_MIN_TRUSTED_ENDPOINTS: "2",
      SPORTTERY_RELAY_UPLOAD_MAX_QUEUE: "1",
      SPORTTERY_RELAY_UPLOAD_WAIT_TIMEOUT_MS: "5000",
      SPORTTERY_RELAY_UPLOAD_TEST_DELAY_MS: "2500",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { childLogs = `${childLogs}${chunk}`.slice(-20_000); });
  child.stderr.on("data", (chunk) => { childLogs = `${childLogs}${chunk}`.slice(-20_000); });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    await sleep(50);
    if (child.exitCode !== null) break;
    try {
      const health = await request("GET", "/api/health");
      if (health.status === 200) return;
    } catch {
      // Listener is still starting.
    }
  }
  throw new Error(`isolated relay upload server did not start: ${childLogs.slice(-1200)}`);
};

const stopServer = async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

const run = async () => {
  await startServer();
  const baseMs = Date.now() - 120_000;
  const fullFirst = fullSnapshot(baseMs, "concurrent");
  const fastSecond = fastSnapshot(baseMs + 1000, "concurrent");
  const overflow = fastSnapshot(baseMs + 2000, "overflow");

  resetFiles();
  const firstUpload = postFull(fullFirst);
  const activeHealth = await waitForActiveUpload();
  const secondUpload = postFast(fastSecond);
  const queuedHealth = await waitForQueuedUpload();
  const overflowUpload = await postFast(overflow);
  const [firstResponse, secondResponse] = await Promise.all([firstUpload, secondUpload]);
  const storedFull = readJson(fullPath);
  const storedFast = readJson(fastPath);
  check("full and fast concurrent uploads both commit through one serialized queue", (
    firstResponse.status === 200
      && secondResponse.status === 200
      && activeHealth?.body?.relaySnapshotUploadQueue?.active === true
      && Number(secondResponse.body?.queueWaitMs || 0) >= 300
      && Number(queuedHealth?.body?.relaySnapshotUploadQueue?.queueDepth || 0) === 1
  ), {
    fullStatus: firstResponse.status,
    fastStatus: secondResponse.status,
    activeObserved: activeHealth?.body?.relaySnapshotUploadQueue?.active ?? null,
    secondWaitMs: secondResponse.body?.queueWaitMs ?? null,
    observedQueueDepth: queuedHealth?.body?.relaySnapshotUploadQueue?.queueDepth ?? null,
  });
  check("bounded shared upload queue rejects overflow without publishing it", (
    overflowUpload.status === 429
      && overflowUpload.body?.code === "RELAY_SNAPSHOT_UPLOAD_QUEUE_FULL"
      && !JSON.stringify(storedFast).includes("overflow")
  ), { status: overflowUpload.status, code: overflowUpload.body?.code || null });
  check("serialized commits preserve physically independent full and fast files", (
    marker(storedFull, "all") === "concurrent-full-all"
      && marker(storedFull, "current") === "concurrent-full-current"
      && marker(storedFast, "current") === "concurrent-fast-current"
      && !JSON.stringify(storedFull).includes("fast-current")
      && !JSON.stringify(storedFast).includes("full-all")
  ));

  const fullBeforeValidate = fs.readFileSync(fullPath, "utf8");
  const fastBeforeValidate = fs.readFileSync(fastPath, "utf8");
  const healthBeforeValidate = await adminHealth();
  const fullPreview = await postFull(fullSnapshot(baseMs + 3000, "preview"), { validateOnly: true });
  const fastPreview = await postFast(fastSnapshot(baseMs + 3000, "preview"), { validateOnly: true });
  const healthAfterValidate = await adminHealth();
  check("validateOnly previews both replacement lanes without entering the write queue", (
    fullPreview.status === 200
      && fullPreview.body?.replacementPreview?.lane === "full"
      && fullPreview.body?.mergePreview === null
      && fastPreview.status === 200
      && fastPreview.body?.replacementPreview?.lane === "fast"
      && fs.readFileSync(fullPath, "utf8") === fullBeforeValidate
      && fs.readFileSync(fastPath, "utf8") === fastBeforeValidate
      && healthBeforeValidate.body?.relaySnapshotUploadQueue?.completed
        === healthAfterValidate.body?.relaySnapshotUploadQueue?.completed
  ));

  resetFiles();
  const abortDispositionPromise = postAndAbortResponse(
    "/api/admin/sporttery-relay-snapshot?runSync=0",
    fullSnapshot(baseMs + 4000, "abort"),
    100
  );
  await sleep(180);
  const queuedAfterAbort = postFast(fastSnapshot(baseMs + 5000, "after-abort"));
  const [abortDisposition, afterAbortResponse] = await Promise.all([abortDispositionPromise, queuedAfterAbort]);
  check("client disconnect during a full commit cannot wedge the shared mutex", (
    abortDisposition === "aborted"
      && afterAbortResponse.status === 200
      && fs.existsSync(fullPath)
      && fs.existsSync(fastPath)
      && marker(readJson(fastPath), "current") === "after-abort-fast-current"
  ), { abortDisposition, nextStatus: afterAbortResponse.status });

  resetFiles();
  fs.mkdirSync(fastPath, { recursive: true });
  const failedFastWrite = await postFast(fastSnapshot(baseMs + 6000, "write-failure"));
  fs.rmSync(fastPath, { recursive: true, force: true });
  const retryFull = await postFull(fullSnapshot(baseMs + 7000, "after-failure"));
  const finalHealth = await adminHealth();
  check("write exception releases the shared mutex and the next lane upload succeeds", (
    failedFastWrite.status === 500
      && failedFastWrite.body?.code === "RELAY_FAST_LANE_WRITE_FAILED"
      && retryFull.status === 200
      && finalHealth.body?.relaySnapshotUploadQueue?.active === false
      && Number(finalHealth.body?.relaySnapshotUploadQueue?.failed || 0) >= 1
  ), {
    failedStatus: failedFastWrite.status,
    failedCode: failedFastWrite.body?.code || null,
    retryStatus: retryFull.status,
    queue: finalHealth.body?.relaySnapshotUploadQueue || null,
  });

  const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
  check("server lock scope covers lane validation and atomic rename while runSync remains outside", [
    "withRelaySnapshotUploadLock(req",
    "const existingSnapshot = await readJsonFile(sportteryRelaySnapshotPath, null)",
    "const storedValidation = relayFullSnapshotValidation(snapshotWithCollector)",
    "await writeJsonFileAtomic(sportteryRelaySnapshotPath, snapshotWithCollector)",
    "const existingSnapshot = await readJsonFile(sportteryRelayFastLaneSnapshotPath, null)",
    "const commitSnapshot = mergeFastLaneWithRetainedResult(",
    "const commitValidation = relayFastLaneValidation(commitSnapshot.snapshot",
    "await writeJsonFileAtomic(sportteryRelayFastLaneSnapshotPath, commitSnapshot.snapshot)",
    "uploaded.sync = await runSync(\"sporttery-relay-upload\")",
    "uploaded.sync = await runSync(\"sporttery-relay-fast-lane-upload\")",
  ].every((needle) => serverSource.includes(needle)));

  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`${JSON.stringify({
    ok: failed.length === 0,
    verifier: "relay-snapshot-upload-serialization",
    summary: { checks: checks.length, failed: failed.length },
    checks,
  }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
};

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n${childLogs.slice(-1200)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
