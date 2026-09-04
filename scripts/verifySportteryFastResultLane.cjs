const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  acquireInstanceLock,
  assertSafeUploadUrl,
  classifyFailure,
  commandSignature,
  computeBackoffMs,
  computeFailureBackoffMs,
  computeDelayFromCompletion,
  createFastUploadSnapshot,
  evaluateLockOwner,
  fastLanePublishDecision,
  finiteNumber,
  postSnapshot,
  resultFingerprint,
  resultPageOneEndpoint,
  writeJsonAtomic
} = require("./sportteryFastResultLane.cjs");
const {
  buildCurlInvocation,
  classifyError,
  finiteEnvNumber
} = require("./collectSportterySnapshot.cjs");

const rootDir = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-fast-result-lane-"));
const checks = [];
const push = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });

push("EdgeOne 567 propagates from collector evidence into the official WAF backoff class", (
  classifyError("HTTP 567 security policy blocked") === "waf-blocked"
  && classifyFailure("collector-failed-waf-blocked HTTP 567") === "official-waf"
));

const makePayload = (rows) => ({
  value: {
    matchInfoList: [{
      businessDate: "2026-07-13",
      subMatchList: rows
    }]
  }
});

const makeEndpoint = (method, rows, options = {}) => {
  const receivedAt = options.receivedAt || options.fetchedAt || new Date().toISOString();
  const requestedAt = options.requestedAt || receivedAt;
  const sourceCycleId = options.sourceCycleId || null;
  const rawSha256 = options.rawSha256 || "a".repeat(64);
  const rawBytes = options.rawBytes ?? 321;
  const httpStatus = options.httpStatus ?? 200;
  const httpDate = options.httpDate || "Thu, 16 Jul 2026 02:20:00 GMT";
  const httpEtag = options.httpEtag || `\"${method}-etag\"`;
  return {
    id: method === "result" ? "method:result:1" : method,
    method,
    page: method === "result" ? 1 : null,
    fetchedAt: options.fetchedAt || receivedAt,
    requestedAt,
    receivedAt,
    sourceCycleId,
    rawSha256,
    rawBytes,
    httpStatus,
    httpDate,
    httpEtag,
    contentType: "application/json",
    collectorProvenance: {
      sourceCycleId,
      requestedAt,
      receivedAt,
      rawSha256,
      rawBytes,
      httpStatus,
      httpDate,
      httpEtag,
      contentType: "application/json"
    },
    ok: true,
    rows: rows.length,
    payload: makePayload(rows)
  };
};

const makeSnapshot = (endpoints, options = {}) => ({
  version: 1,
  source: "sporttery-relay-snapshot",
  capturedAt: options.capturedAt || new Date().toISOString(),
  sourceCycleId: options.sourceCycleId || null,
  collectorProvenance: options.sourceCycleId ? { sourceCycleId: options.sourceCycleId } : undefined,
  maxAgeMinutes: 20,
  producer: { transport: "test" },
  summary: {
    endpoints: endpoints.length,
    usableEndpoints: endpoints.length,
    rows: endpoints.reduce((sum, endpoint) => sum + Number(endpoint.rows || 0), 0),
    errors: 0,
    methods: Array.from(new Set(endpoints.map((endpoint) => endpoint.method)))
  },
  endpoints,
  errors: []
});

const runChild = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(rootDir, "scripts", "runSportteryFastResultLane.cjs"), ...args], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("exit", (code) => resolve({ code, stdout, stderr }));
});

const runPowerShell = (scriptPath, env) => new Promise((resolve, reject) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("exit", (code) => resolve({ code, stdout, stderr }));
});

const startServer = (plannedResponses = []) => new Promise((resolve, reject) => {
  const uploads = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      uploads.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        snapshot: body?.snapshot || null
      });
      const planned = plannedResponses.length ? plannedResponses.shift() : null;
      if (planned) {
        res.writeHead(planned.status || 200, { "content-type": planned.contentType || "application/json" });
        if (planned.truncate === true) {
          res.write(String(planned.body || '{"ok":true,"storedValidation":'));
          setImmediate(() => res.destroy());
          return;
        }
        if (planned.hang === true) {
          res.write(String(planned.body || '{"ok":true,"storedValidation":'));
          return;
        }
        res.end(typeof planned.body === "string" ? planned.body : JSON.stringify(planned.body));
        return;
      }
      const storedValidation = {
        ok: true,
        rows: Number(body?.snapshot?.summary?.rows || 0),
        usableEndpoints: Number(body?.snapshot?.summary?.usableEndpoints || 0)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        validation: storedValidation,
        storedValidation,
        replacedPrevious: true
      }));
    });
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve({
    server,
    uploads,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  }));
});

const fixturePath = path.join(tempDir, "collector-fixture.cjs");
fs.writeFileSync(fixturePath, `
const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.FAST_FIXTURE_STATE;
const outputPath = process.env.SPORTTERY_RELAY_SNAPSHOT_OUT;
const state = (() => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { probes: 0, companions: 0, probeStarts: [] }; } })();
state.probeStarts = Array.isArray(state.probeStarts) ? state.probeStarts : [];
const payload = (rows) => ({ value: { matchInfoList: [{ businessDate: "2026-07-13", subMatchList: rows }] } });
const endpoint = (method, rows, sourceCycleId) => {
  const receivedAt = new Date().toISOString();
  const httpDate = new Date(receivedAt).toUTCString();
  return {
    id: method === "result" ? "method:result:1" : method,
    method,
    page: method === "result" ? 1 : null,
    fetchedAt: receivedAt,
    requestedAt: receivedAt,
    receivedAt,
    sourceCycleId,
    rawSha256: "b".repeat(64),
    rawBytes: 123,
    httpStatus: 200,
    httpDate,
    httpEtag: "fixture-etag",
    collectorProvenance: {
      sourceCycleId,
      requestedAt: receivedAt,
      receivedAt,
      rawSha256: "b".repeat(64),
      rawBytes: 123,
      httpStatus: 200,
      httpDate,
      httpEtag: "fixture-etag"
    },
    ok: true,
    rows: rows.length,
    payload: payload(rows)
  };
};
let endpoints;
if (process.env.SPORTTERY_RELAY_SKIP_INITIAL === "1") {
  state.probes += 1;
  state.probeStarts.push(Date.now());
  const failAlways = process.env.FAST_FIXTURE_FAIL_PROBE === "1";
  const failWaf = process.env.FAST_FIXTURE_FAIL_PROBE_WAF === "1";
  const failFirst = process.env.FAST_FIXTURE_FAIL_FIRST_PROBE === "1" && state.probes === 1;
  if (failAlways || failWaf || failFirst) {
    state.firstFailureCompletedAt = Date.now();
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
    process.stderr.write(failWaf
      ? "HTTP 567 security policy blocked\\n"
      : "collector fixture failed\\n");
    process.exit(2);
  }
  const score = state.probes < 3 ? "1:0" : "2:1";
  endpoints = [endpoint("result", [{ matchId: "result-1", matchNum: 201, matchStatus: "11", sectionsNo999: score }], "fixture-probe-cycle-" + state.probes)];
} else {
  state.companions += 1;
  endpoints = [
    endpoint("calculator", [{ matchId: "current-1" }], "fixture-companion-cycle-" + state.companions),
    endpoint("current", [{ matchId: "current-1" }], "fixture-companion-cycle-" + state.companions)
  ];
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const snapshot = {
  version: 1,
  source: "sporttery-relay-snapshot",
  capturedAt: new Date().toISOString(),
  sourceCycleId: endpoints[0]?.sourceCycleId || null,
  collectorProvenance: { sourceCycleId: endpoints[0]?.sourceCycleId || null },
  maxAgeMinutes: 20,
  producer: { transport: "fixture" },
  summary: { endpoints: endpoints.length, usableEndpoints: endpoints.length, rows: endpoints.length, errors: 0 },
  endpoints,
  errors: []
};
const temp = outputPath + ".tmp";
fs.writeFileSync(temp, JSON.stringify(snapshot), "utf8");
fs.renameSync(temp, outputPath);
fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
`, "utf8");

const main = async () => {
  const resultA = makeEndpoint("result", [{
    matchId: "m1",
    matchNum: 201,
    matchStatus: "11",
    sectionsNo999: "1:0"
  }]);
  const resultAReordered = makeEndpoint("result", [{
    sectionsNo999: "1:0",
    matchStatus: "11",
    matchNum: 201,
    matchId: "m1"
  }]);
  const resultB = makeEndpoint("result", [{
    matchId: "m1",
    matchNum: 201,
    matchStatus: "11",
    sectionsNo999: "2:0"
  }]);
  const fingerprintA = resultFingerprint(resultA);
  push("result fingerprint is semantic and stable across object key order", fingerprintA === resultFingerprint(resultAReordered));
  push("score change changes result fingerprint", fingerprintA !== resultFingerprint(resultB));
  const heartbeatFreshDecision = fastLanePublishDecision({
    fingerprint: fingerprintA,
    lastUploadedResultFingerprint: fingerprintA,
    lastUploadOkAt: "2026-07-16T02:20:00.000Z",
    currentHeartbeatMs: 60_000,
    nowMs: Date.parse("2026-07-16T02:20:30.000Z")
  });
  const heartbeatDueDecision = fastLanePublishDecision({
    fingerprint: fingerprintA,
    lastUploadedResultFingerprint: fingerprintA,
    lastUploadOkAt: "2026-07-16T02:20:00.000Z",
    currentHeartbeatMs: 60_000,
    nowMs: Date.parse("2026-07-16T02:21:00.000Z")
  });
  const changedDecision = fastLanePublishDecision({
    fingerprint: resultFingerprint(resultB),
    lastUploadedResultFingerprint: fingerprintA,
    lastUploadOkAt: "2026-07-16T02:20:59.000Z",
    currentHeartbeatMs: 60_000,
    nowMs: Date.parse("2026-07-16T02:21:00.000Z")
  });
  push("unchanged result inside the current heartbeat window does not upload", (
    heartbeatFreshDecision.publish === false
    && heartbeatFreshDecision.reason === "unchanged-within-current-heartbeat"
  ), { decision: heartbeatFreshDecision });
  push("unchanged result publishes a fresh current calculator heartbeat at sixty seconds", (
    heartbeatDueDecision.publish === true
    && heartbeatDueDecision.reason === "current-heartbeat"
    && heartbeatDueDecision.currentHeartbeatDue === true
  ), { decision: heartbeatDueDecision });
  push("result changes publish immediately without waiting for the current heartbeat", (
    changedDecision.publish === true
    && changedDecision.reason === "result-change"
    && changedDecision.resultChanged === true
  ), { decision: changedDecision });

  const probeCycleId = "sporttery-relay:probe-cycle";
  const companionCycleId = "sporttery-relay:companion-cycle";
  const probeRequestedAt = "2026-07-16T02:20:00.000Z";
  const probeReceivedAt = "2026-07-16T02:20:01.000Z";
  const companionRequestedAt = "2026-07-16T02:20:02.000Z";
  const companionReceivedAt = "2026-07-16T02:20:03.000Z";
  const auditedResultA = makeEndpoint("result", [{
    matchId: "m1",
    matchNum: 201,
    matchStatus: "11",
    sectionsNo999: "1:0"
  }], {
    sourceCycleId: probeCycleId,
    requestedAt: probeRequestedAt,
    receivedAt: probeReceivedAt,
    rawSha256: "1".repeat(64),
    rawBytes: 101,
    httpStatus: 200,
    httpDate: "Thu, 16 Jul 2026 02:20:01 GMT",
    httpEtag: "probe-etag"
  });
  const auditedCurrent = makeEndpoint("current", [{ matchId: "c1" }], {
    sourceCycleId: companionCycleId,
    requestedAt: companionRequestedAt,
    receivedAt: companionReceivedAt,
    rawSha256: "2".repeat(64),
    rawBytes: 202,
    httpStatus: 200,
    httpDate: "Thu, 16 Jul 2026 02:20:03 GMT",
    httpEtag: "current-etag"
  });
  const auditedCalculator = makeEndpoint("calculator", [{ matchId: "c1" }], {
    sourceCycleId: companionCycleId,
    requestedAt: companionRequestedAt,
    receivedAt: companionReceivedAt,
    rawSha256: "3".repeat(64),
    rawBytes: 303,
    httpStatus: 200,
    httpDate: "Thu, 16 Jul 2026 02:20:03 GMT",
    httpEtag: "calculator-etag"
  });
  const probeSnapshot = makeSnapshot([auditedResultA], { sourceCycleId: probeCycleId });
  const companionSnapshot = makeSnapshot([auditedCurrent, auditedCalculator], { sourceCycleId: companionCycleId });
  const uploadSnapshot = createFastUploadSnapshot({
    probeSnapshot,
    companionSnapshot,
    fingerprint: fingerprintA,
    now: new Date("2026-07-16T02:25:00.000Z"),
    uploadCycleId: "sporttery-fast-upload-merge:test-1"
  });
  const methods = uploadSnapshot.endpoints.map((endpoint) => endpoint.method).sort();
  push("fast upload is bounded to current calculator and result page 1", (
    uploadSnapshot.endpoints.length === 3
    && methods.join(",") === "calculator,current,result"
    && resultPageOneEndpoint(uploadSnapshot)?.page === 1
  ), { methods });
  push("fast upload exposes a distinct upload merge cycle and every constituent collector cycle", (
    uploadSnapshot.sourceCycleId === "sporttery-fast-upload-merge:test-1"
    && uploadSnapshot.sourceCycleKind === "upload-merge"
    && uploadSnapshot.mergeCycleId === uploadSnapshot.sourceCycleId
    && uploadSnapshot.collectorSourceCycleId === null
    && uploadSnapshot.mixedCollectorSourceCycles === true
    && uploadSnapshot.constituentCycleIds.join(",") === [companionCycleId, probeCycleId].sort().join(",")
    && uploadSnapshot.collectorProvenance?.constituentCycleIds?.join(",") === uploadSnapshot.constituentCycleIds.join(",")
  ), {
    uploadCycleId: uploadSnapshot.sourceCycleId,
    constituentCycleIds: uploadSnapshot.constituentCycleIds
  });
  const resultUploadEndpoint = resultPageOneEndpoint(uploadSnapshot);
  const currentUploadEndpoint = uploadSnapshot.endpoints.find((endpoint) => endpoint.method === "current");
  push("endpoint collector provenance survives the probe companion merge without clock or HTTP metadata loss", (
    resultUploadEndpoint?.sourceCycleId === probeCycleId
    && resultUploadEndpoint?.requestedAt === probeRequestedAt
    && resultUploadEndpoint?.receivedAt === probeReceivedAt
    && resultUploadEndpoint?.rawSha256 === "1".repeat(64)
    && resultUploadEndpoint?.rawBytes === 101
    && resultUploadEndpoint?.httpStatus === 200
    && resultUploadEndpoint?.httpDate === "Thu, 16 Jul 2026 02:20:01 GMT"
    && resultUploadEndpoint?.httpEtag === "probe-etag"
    && resultUploadEndpoint?.collectorProvenance?.sourceCycleId === probeCycleId
    && resultUploadEndpoint?.fastResultConstituent?.role === "probe"
    && currentUploadEndpoint?.sourceCycleId === companionCycleId
    && currentUploadEndpoint?.collectorProvenance?.rawSha256 === "2".repeat(64)
    && currentUploadEndpoint?.fastResultConstituent?.role === "companion"
  ));
  const retrySnapshot = createFastUploadSnapshot({
    probeSnapshot,
    companionSnapshot,
    fingerprint: fingerprintA,
    now: new Date("2026-07-16T02:35:00.000Z"),
    uploadCycleId: "sporttery-fast-upload-merge:test-retry"
  });
  const retryResultEndpoint = resultPageOneEndpoint(retrySnapshot);
  push("retry creates only a new upload cycle and never forges constituent observation clocks", (
    retrySnapshot.sourceCycleId !== uploadSnapshot.sourceCycleId
    && retrySnapshot.mergeCreatedAt === "2026-07-16T02:35:00.000Z"
    && retrySnapshot.capturedAt === uploadSnapshot.capturedAt
    && retrySnapshot.capturedAt === companionReceivedAt
    && retryResultEndpoint?.requestedAt === probeRequestedAt
    && retryResultEndpoint?.receivedAt === probeReceivedAt
    && retryResultEndpoint?.fetchedAt === probeReceivedAt
  ), {
    firstCapturedAt: uploadSnapshot.capturedAt,
    retryCapturedAt: retrySnapshot.capturedAt,
    retryMergeCreatedAt: retrySnapshot.mergeCreatedAt
  });
  let missingClockRejected = false;
  const clocklessResult = { ...auditedResultA };
  delete clocklessResult.fetchedAt;
  delete clocklessResult.requestedAt;
  delete clocklessResult.receivedAt;
  delete clocklessResult.collectorProvenance;
  const clocklessCurrent = { ...auditedCurrent };
  delete clocklessCurrent.fetchedAt;
  delete clocklessCurrent.requestedAt;
  delete clocklessCurrent.receivedAt;
  delete clocklessCurrent.collectorProvenance;
  try {
    createFastUploadSnapshot({
      probeSnapshot: makeSnapshot([clocklessResult], { sourceCycleId: probeCycleId }),
      companionSnapshot: makeSnapshot([clocklessCurrent], { sourceCycleId: companionCycleId }),
      fingerprint: fingerprintA,
      now: new Date("2026-07-16T02:45:00.000Z")
    });
  } catch (error) {
    missingClockRejected = error?.message === "fast-result-endpoint-clock-missing";
  }
  push("missing endpoint clocks fail closed instead of being replaced with retry time", missingClockRejected);

  const backoffs = [1, 2, 3, 9].map((failures) => computeBackoffMs({
    consecutiveFailures: failures,
    baseMs: 1000,
    maxMs: 5000,
    jitterRatio: 0,
    random: () => 0
  }));
  push("failure backoff is exponential and capped", backoffs.join(",") === "1000,2000,4000,5000", { backoffs });
  const differentiatedBackoffs = {
    generic: computeFailureBackoffMs({
      failureCode: "network",
      consecutiveFailures: 12,
      baseMs: 1000,
      maxMs: 5000,
      wafMaxMs: 30_000,
      jitterRatio: 0,
      random: () => 0,
    }),
    waf: computeFailureBackoffMs({
      failureCode: "official-waf",
      consecutiveFailures: 12,
      baseMs: 1000,
      maxMs: 5000,
      wafMaxMs: 30_000,
      jitterRatio: 0,
      random: () => 0,
    }),
  };
  push("official WAF failures use a longer cooldown without slowing generic recovery", (
    differentiatedBackoffs.generic === 5000
    && differentiatedBackoffs.waf === 30_000
  ), { differentiatedBackoffs });
  let plainRemoteRejected = false;
  try { assertSafeUploadUrl("http://192.0.2.1"); } catch { plainRemoteRejected = true; }
  push("remote bearer upload rejects plaintext non-loopback", plainRemoteRejected);

  const fakeRunnerCommand = `node ${path.join(rootDir, "scripts", "runSportteryFastResultLane.cjs")} --watch`;
  const fakeSelfIdentity = {
    status: "ok",
    exists: true,
    startKey: "test-runner-start-1",
    command: fakeRunnerCommand,
    cwd: rootDir
  };
  const inspectLiveSelf = (pid) => Number(pid) === process.pid
    ? fakeSelfIdentity
    : { status: "ok", exists: false };
  const lockDir = path.join(tempDir, "lock-test");
  const firstLock = acquireInstanceLock({ lockDir, inspect: inspectLiveSelf });
  const secondLock = acquireInstanceLock({ lockDir, inspect: inspectLiveSelf });
  push("instance lock accepts only a start-time command and root verified live owner", (
    firstLock.acquired
    && !secondLock.acquired
    && secondLock.unsafe === false
    && secondLock.reason === "verified-runner-active"
  ));
  firstLock.release();
  const thirdLock = acquireInstanceLock({ lockDir, inspect: inspectLiveSelf });
  push("instance lock is reusable after clean release", thirdLock.acquired);
  thirdLock.release();

  const failedCreateDir = path.join(tempDir, "owner-write-failure-lock");
  let partialOwnerTempPath = null;
  const injectedNoSpaceFs = {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (filePath, data, encoding) => {
      partialOwnerTempPath = filePath;
      fs.writeFileSync(filePath, String(data).slice(0, 8), encoding);
      const error = new Error("injected owner ENOSPC");
      error.code = "ENOSPC";
      throw error;
    },
    renameSync: (...args) => fs.renameSync(...args),
    rmSync: (...args) => fs.rmSync(...args)
  };
  let ownerWriteFailure = null;
  try {
    acquireInstanceLock({
      lockDir: failedCreateDir,
      inspect: inspectLiveSelf,
      writeAtomic: (filePath, payload) => writeJsonAtomic(filePath, payload, {
        fileSystem: injectedNoSpaceFs
      })
    });
  } catch (error) {
    ownerWriteFailure = error;
  }
  push("atomic owner write failure removes its partial tmp and newly-created lock directory", (
    ownerWriteFailure?.code === "ENOSPC"
    && ownerWriteFailure.fastResultNewLockDirectoryCleaned === true
    && partialOwnerTempPath
    && !fs.existsSync(partialOwnerTempPath)
    && !fs.existsSync(failedCreateDir)
  ), {
    error: ownerWriteFailure?.code || null,
    tempRemoved: partialOwnerTempPath ? !fs.existsSync(partialOwnerTempPath) : false,
    lockDirRemoved: !fs.existsSync(failedCreateDir)
  });

  const lockNowMs = Date.parse("2026-07-16T03:00:00.000Z");
  const unexpiredOrphanDir = path.join(tempDir, "unexpired-orphan-lock");
  fs.mkdirSync(unexpiredOrphanDir);
  fs.writeFileSync(path.join(unexpiredOrphanDir, "owner.json"), "{invalid", "utf8");
  let unexpiredScanCalls = 0;
  const unexpiredOrphan = acquireInstanceLock({
    lockDir: unexpiredOrphanDir,
    leaseMs: 60_000,
    now: () => lockNowMs,
    inspect: inspectLiveSelf,
    observeLock: () => ({ status: "ok", observedAtMs: lockNowMs - 30_000 }),
    scanRunners: () => {
      unexpiredScanCalls += 1;
      return { status: "ok", liveRunnerCount: 0, processes: [] };
    }
  });
  push("an invalid orphan inside its bounded lease is never reclaimed or even process-scanned", (
    !unexpiredOrphan.acquired
    && unexpiredOrphan.reason === "lock-owner-record-invalid-unexpired"
    && unexpiredScanCalls === 0
    && fs.existsSync(unexpiredOrphanDir)
  ), { result: unexpiredOrphan, scanCalls: unexpiredScanCalls });

  const crossPlatformRecovery = [];
  for (const platform of ["win32", "linux"]) {
    const orphanDir = path.join(tempDir, `expired-orphan-${platform}`);
    const unrelatedSibling = path.join(tempDir, `must-survive-${platform}.txt`);
    fs.mkdirSync(orphanDir);
    fs.writeFileSync(path.join(orphanDir, `owner.json.999.${platform}.tmp`), "partial", "utf8");
    fs.writeFileSync(unrelatedSibling, "keep", "utf8");
    let scanCalls = 0;
    const recovered = acquireInstanceLock({
      lockDir: orphanDir,
      leaseMs: 60_000,
      now: () => lockNowMs,
      inspect: inspectLiveSelf,
      observeLock: () => ({ status: "ok", observedAtMs: lockNowMs - 120_000 }),
      scanRunners: () => {
        scanCalls += 1;
        return { status: "ok", liveRunnerCount: 0, processes: [] };
      },
      platform
    });
    const duplicate = acquireInstanceLock({
      lockDir: orphanDir,
      leaseMs: 60_000,
      now: () => lockNowMs,
      inspect: inspectLiveSelf,
      observeLock: () => ({ status: "ok", observedAtMs: lockNowMs - 120_000 }),
      scanRunners: () => ({ status: "ok", liveRunnerCount: 0, processes: [] }),
      platform
    });
    const quarantinePrefix = `${path.basename(orphanDir)}.quarantine-`;
    const quarantineLeftovers = fs.readdirSync(tempDir)
      .filter((name) => name.startsWith(quarantinePrefix));
    crossPlatformRecovery.push({
      platform,
      recovered: recovered.acquired === true,
      duplicateBlocked: duplicate.acquired === false
        && duplicate.reason === "verified-runner-active"
        && duplicate.unsafe === false,
      scanCalls,
      unrelatedSiblingPreserved: fs.existsSync(unrelatedSibling),
      quarantineLeftovers
    });
    if (recovered.acquired) recovered.release();
  }
  push("expired ownerless locks recover by same-parent quarantine on Windows and POSIX without deleting siblings", (
    crossPlatformRecovery.every((item) => item.recovered
      && item.duplicateBlocked
      && item.scanCalls === 1
      && item.unrelatedSiblingPreserved
      && item.quarantineLeftovers.length === 0)
  ), { crossPlatformRecovery });

  const staleDecisionRaceDir = path.join(tempDir, "stale-decision-race-lock");
  fs.mkdirSync(staleDecisionRaceDir);
  fs.writeFileSync(path.join(staleDecisionRaceDir, "owner.json"), "{invalid-old-owner", "utf8");
  let raceWinner = null;
  let raceWinnerOwnerRaw = null;
  const staleContender = acquireInstanceLock({
    lockDir: staleDecisionRaceDir,
    leaseMs: 60_000,
    now: () => lockNowMs,
    inspect: inspectLiveSelf,
    observeLock: () => ({ status: "ok", observedAtMs: lockNowMs - 120_000 }),
    scanRunners: () => ({ status: "ok", liveRunnerCount: 0, processes: [] }),
    hooks: {
      beforeQuarantineRename: () => {
        raceWinner = acquireInstanceLock({
          lockDir: staleDecisionRaceDir,
          leaseMs: 60_000,
          now: () => lockNowMs,
          inspect: inspectLiveSelf,
          observeLock: () => ({ status: "ok", observedAtMs: lockNowMs - 120_000 }),
          scanRunners: () => ({ status: "ok", liveRunnerCount: 0, processes: [] })
        });
        raceWinnerOwnerRaw = fs.readFileSync(path.join(staleDecisionRaceDir, "owner.json"));
      }
    }
  });
  const ownerAfterStaleDecision = fs.readFileSync(path.join(staleDecisionRaceDir, "owner.json"));
  const raceDuplicate = acquireInstanceLock({
    lockDir: staleDecisionRaceDir,
    inspect: inspectLiveSelf
  });
  const raceQuarantinePrefix = `${path.basename(staleDecisionRaceDir)}.quarantine-`;
  const raceQuarantineLeftovers = fs.readdirSync(tempDir)
    .filter((name) => name.startsWith(raceQuarantinePrefix));
  const raceWinnerReleased = raceWinner?.acquired === true ? raceWinner.release() : false;
  push("a stale orphan decision cannot quarantine and replace a lock rebuilt by the winning contender", (
    raceWinner?.acquired === true
    && staleContender.acquired === false
    && staleContender.reason === "lock-snapshot-changed-before-quarantine"
    && staleContender.snapshotExpectedOwnerState === "present"
    && staleContender.snapshotActualOwnerState === "present"
    && staleContender.quarantineRestored === true
    && staleContender.quarantineRetained === false
    && Buffer.isBuffer(raceWinnerOwnerRaw)
    && ownerAfterStaleDecision.equals(raceWinnerOwnerRaw)
    && raceDuplicate.acquired === false
    && raceDuplicate.reason === "verified-runner-active"
    && raceDuplicate.unsafe === false
    && raceQuarantineLeftovers.length === 0
    && raceWinnerReleased
  ), {
    staleContender,
    duplicateReason: raceDuplicate.reason,
    ownerPreserved: Buffer.isBuffer(raceWinnerOwnerRaw)
      && ownerAfterStaleDecision.equals(raceWinnerOwnerRaw),
    quarantineLeftovers: raceQuarantineLeftovers,
    winnerReleased: raceWinnerReleased
  });

  const noOverwriteRaceDir = path.join(tempDir, "stale-decision-no-overwrite-lock");
  fs.mkdirSync(noOverwriteRaceDir);
  fs.writeFileSync(path.join(noOverwriteRaceDir, "owner.json.old.tmp"), "old-orphan", "utf8");
  let quarantinedWinnerOwnerRaw = null;
  const replacementSentinel = "replacement-must-not-be-overwritten";
  const noOverwriteContender = acquireInstanceLock({
    lockDir: noOverwriteRaceDir,
    leaseMs: 60_000,
    now: () => lockNowMs,
    inspect: inspectLiveSelf,
    observeLock: () => ({ status: "ok", observedAtMs: lockNowMs - 120_000 }),
    scanRunners: () => ({ status: "ok", liveRunnerCount: 0, processes: [] }),
    hooks: {
      beforeQuarantineRename: () => {
        const winner = acquireInstanceLock({
          lockDir: noOverwriteRaceDir,
          leaseMs: 60_000,
          now: () => lockNowMs,
          inspect: inspectLiveSelf,
          observeLock: () => ({ status: "ok", observedAtMs: lockNowMs - 120_000 }),
          scanRunners: () => ({ status: "ok", liveRunnerCount: 0, processes: [] })
        });
        if (!winner.acquired) throw new Error("no-overwrite-race-winner-did-not-acquire");
        quarantinedWinnerOwnerRaw = fs.readFileSync(path.join(noOverwriteRaceDir, "owner.json"));
      },
      beforeSnapshotMismatchRestore: () => {
        fs.mkdirSync(noOverwriteRaceDir);
        fs.writeFileSync(path.join(noOverwriteRaceDir, "replacement.txt"), replacementSentinel, "utf8");
      }
    }
  });
  const noOverwriteQuarantinePrefix = `${path.basename(noOverwriteRaceDir)}.quarantine-`;
  const noOverwriteQuarantines = fs.readdirSync(tempDir)
    .filter((name) => name.startsWith(noOverwriteQuarantinePrefix));
  const retainedOwnerPath = noOverwriteQuarantines.length === 1
    ? path.join(tempDir, noOverwriteQuarantines[0], "owner.json")
    : null;
  push("snapshot mismatch never overwrites a replacement lock and retains the displaced lock in quarantine", (
    noOverwriteContender.acquired === false
    && noOverwriteContender.reason === "lock-snapshot-changed-before-quarantine"
    && noOverwriteContender.quarantineRestored === false
    && noOverwriteContender.quarantineRetained === true
    && noOverwriteContender.snapshotRestoreReason === "lock-replacement-already-exists"
    && fs.readFileSync(path.join(noOverwriteRaceDir, "replacement.txt"), "utf8") === replacementSentinel
    && noOverwriteQuarantines.length === 1
    && retainedOwnerPath
    && fs.readFileSync(retainedOwnerPath).equals(quarantinedWinnerOwnerRaw)
  ), {
    result: noOverwriteContender,
    quarantineCount: noOverwriteQuarantines.length,
    replacementPreserved: fs.readFileSync(path.join(noOverwriteRaceDir, "replacement.txt"), "utf8") === replacementSentinel
  });

  const liveOrphanDir = path.join(tempDir, "expired-orphan-live-runner");
  fs.mkdirSync(liveOrphanDir);
  const liveOrphan = acquireInstanceLock({
    lockDir: liveOrphanDir,
    leaseMs: 60_000,
    now: () => lockNowMs,
    inspect: inspectLiveSelf,
    observeLock: () => ({ status: "ok", observedAtMs: lockNowMs - 120_000 }),
    scanRunners: () => ({
      status: "ok",
      liveRunnerCount: 1,
      processes: [{ pid: 7654321, startKey: "live-runner" }]
    })
  });
  push("an expired ownerless lock is not reclaimed while a corresponding runner is live", (
    !liveOrphan.acquired
    && liveOrphan.reason === "expired-orphan-live-runner-active"
    && fs.existsSync(liveOrphanDir)
  ), { result: liveOrphan });

  const oldOwner = {
    version: 2,
    pid: 424242,
    root: rootDir,
    processStartKey: "old-process-start",
    command: fakeRunnerCommand,
    commandSignature: commandSignature(fakeRunnerCommand),
    updatedAt: new Date(Date.now() - 20 * 60_000).toISOString()
  };
  const reusedPidDecision = evaluateLockOwner({
    owner: oldOwner,
    identity: {
      status: "ok",
      exists: true,
      startKey: "reused-pid-new-start",
      command: fakeRunnerCommand,
      cwd: rootDir
    },
    expectedRoot: rootDir,
    leaseMs: 10 * 60_000
  });
  push("PID reuse with a runner-like live process fails closed instead of reporting healthy", (
    reusedPidDecision.action === "fail"
    && reusedPidDecision.unsafe === true
    && reusedPidDecision.pidReuseSuspected === true
  ), { decision: reusedPidDecision });
  const nonRunnerDecision = evaluateLockOwner({
    owner: oldOwner,
    identity: {
      status: "ok",
      exists: true,
      startKey: "reused-pid-non-runner",
      command: "node unrelated-service.cjs",
      cwd: rootDir
    },
    expectedRoot: rootDir,
    leaseMs: 10 * 60_000
  });
  push("expired lock is reclaimed only for a confirmed non-runner process", nonRunnerDecision.action === "reclaim", {
    decision: nonRunnerDecision
  });
  const unknownOwnerDecision = evaluateLockOwner({
    owner: oldOwner,
    identity: { status: "unknown", exists: null, reason: "access-denied" },
    expectedRoot: rootDir,
    leaseMs: 10 * 60_000
  });
  push("unknown live owner identity is an unhealthy fail-closed lock", (
    unknownOwnerDecision.action === "fail" && unknownOwnerDecision.unsafe === true
  ), { decision: unknownOwnerDecision });

  const numericFallbacks = {
    nan: finiteNumber("NaN", 15, { min: 10, max: 300 }),
    infinity: finiteNumber("Infinity", 30, { min: 10, max: 300 }),
    negative: finiteNumber(-99, 10, { min: 10, max: 300 }),
    collectorNaN: finiteEnvNumber("NaN", 20, { min: 8, max: 120 }),
    collectorInfinity: finiteEnvNumber("Infinity", 25, { min: 8, max: 180 })
  };
  push("NaN Infinity and unsafe numeric values fall back or clamp above storm cadence", (
    numericFallbacks.nan === 15
    && numericFallbacks.infinity === 30
    && numericFallbacks.negative === 10
    && numericFallbacks.collectorNaN === 20
    && numericFallbacks.collectorInfinity === 25
  ), { numericFallbacks });

  const proxySecret = "proxy-user:proxy-password";
  const proxyUrl = `socks5h://${proxySecret}@127.0.0.1:1080`;
  const curlInvocation = buildCurlInvocation("https://webapi.sporttery.cn/test", "result", proxyUrl);
  let unsafeProxyRejected = false;
  try {
    buildCurlInvocation("https://webapi.sporttery.cn/test", "result", `${proxyUrl}\nmalicious=1`);
  } catch {
    unsafeProxyRejected = true;
  }
  push("authenticated proxy credentials travel through curl stdin config and never argv", (
    !curlInvocation.args.join(" ").includes(proxySecret)
    && !curlInvocation.args.includes("--proxy")
    && curlInvocation.stdinConfig.includes(proxySecret)
    && unsafeProxyRejected
  ));

  const contractMock = await startServer([
    { status: 200, contentType: "text/plain", body: "not-json" },
    { status: 200, body: {} },
    { status: 200, body: { ok: true, storedValidation: { ok: false } } },
    { status: 200, body: { ok: true, storedValidation: { ok: true, rows: 3, usableEndpoints: 3 } } }
  ]);
  const contractOutcomes = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      try {
        const accepted = await postSnapshot({
          baseUrl: contractMock.baseUrl,
          adminToken: "contract-token",
          snapshot: uploadSnapshot,
          timeoutMs: Number.NaN
        });
        contractOutcomes.push({ accepted: true, status: accepted.status });
      } catch (error) {
        contractOutcomes.push({ accepted: false, error: error.message || String(error) });
      }
    }
  } finally {
    await new Promise((resolve) => contractMock.server.close(resolve));
  }
  push("upload acknowledgement requires 2xx JSON ok=true and storedValidation.ok=true", (
    contractOutcomes.slice(0, 3).every((item) => item.accepted === false)
    && contractOutcomes[3]?.accepted === true
  ), { contractOutcomes });

  const truncatedMock = await startServer([{ status: 200, truncate: true }]);
  let truncatedDeadline = null;
  const truncatedStartedAt = Date.now();
  let truncatedOutcome = null;
  try {
    truncatedOutcome = await Promise.race([
      postSnapshot({
        baseUrl: truncatedMock.baseUrl,
        adminToken: "truncated-response-token",
        snapshot: uploadSnapshot,
        timeoutMs: 5000
      }).then(
        () => ({ settled: true, accepted: true }),
        (error) => ({ settled: true, accepted: false, error: error.message || String(error) })
      ),
      new Promise((resolve) => {
        truncatedDeadline = setTimeout(() => resolve({ settled: false, accepted: false }), 500);
      })
    ]);
  } finally {
    if (truncatedDeadline) clearTimeout(truncatedDeadline);
    await new Promise((resolve) => truncatedMock.server.close(resolve));
  }
  const truncatedElapsedMs = Date.now() - truncatedStartedAt;
  push("truncated 200 JSON response settles fail-closed on response abort or close", (
    truncatedOutcome?.settled === true
    && truncatedOutcome.accepted === false
    && truncatedElapsedMs < 500
  ), { truncatedElapsedMs, error: truncatedOutcome?.error || null });

  const hangingMock = await startServer([{ status: 200, hang: true }]);
  const fakeWallClock = {
    cleared: 0,
    setTimeout(callback, delayMs) {
      const handle = { callback, delayMs, cancelled: false };
      queueMicrotask(() => {
        if (!handle.cancelled) callback();
      });
      return handle;
    },
    clearTimeout(handle) {
      handle.cancelled = true;
      this.cleared += 1;
    }
  };
  let wallClockOutcome = null;
  try {
    wallClockOutcome = await postSnapshot({
      baseUrl: hangingMock.baseUrl,
      adminToken: "wall-clock-timeout-token",
      snapshot: uploadSnapshot,
      timeoutMs: 5000,
      timerApi: fakeWallClock
    }).then(
      () => ({ accepted: true }),
      (error) => ({ accepted: false, error: error.message || String(error) })
    );
  } finally {
    await new Promise((resolve) => hangingMock.server.close(resolve));
  }
  push("independent wall-clock upload timer settles once and is cleared", (
    wallClockOutcome?.accepted === false
    && wallClockOutcome.error === "remote-upload-wall-clock-timeout"
    && fakeWallClock.cleared === 1
  ), { error: wallClockOutcome?.error || null, cleared: fakeWallClock.cleared });

  const mock = await startServer();
  const fixtureState = path.join(tempDir, "fixture-state.json");
  const runnerState = path.join(tempDir, "runner-state.json");
  const runnerSnapshot = path.join(tempDir, "runner-snapshot.json");
  const runnerLock = path.join(tempDir, "runner-lock");
  const token = "isolated-fast-result-token";
  const commonEnv = {
    SPORTTERY_FAST_RESULT_TEST_MODE: "1",
    SPORTTERY_FAST_RESULT_INTERVAL_SECONDS: "0.05",
    SPORTTERY_FAST_RESULT_BACKOFF_BASE_SECONDS: "0.01",
    SPORTTERY_FAST_RESULT_BACKOFF_MAX_SECONDS: "0.04",
    SPORTTERY_FAST_RESULT_COLLECT_TIMEOUT_SECONDS: "2",
    SPORTTERY_FAST_RESULT_UPLOAD_TIMEOUT_SECONDS: "2",
    SPORTTERY_FAST_RESULT_LOG_EVERY_CYCLES: "1",
    SPORTTERY_FAST_RESULT_COLLECTOR_SCRIPT: fixturePath,
    SPORTTERY_FAST_RESULT_PUSH_BASE_URL: mock.baseUrl,
    SPORTTERY_FAST_RESULT_ADMIN_TOKEN: token,
    SPORTTERY_FAST_RESULT_STATE_PATH: runnerState,
    SPORTTERY_FAST_RESULT_SNAPSHOT_PATH: runnerSnapshot,
    SPORTTERY_FAST_RESULT_LOCK_DIR: runnerLock,
    FAST_FIXTURE_STATE: fixtureState
  };
  try {
    const child = await runChild(["--watch", "--max-cycles=3"], commonEnv);
    if (!fs.existsSync(fixtureState) || !fs.existsSync(runnerState)) {
      throw new Error(`isolated fast-result runner did not create state files: ${JSON.stringify({
        exitCode: child.code,
        stdout: child.stdout,
        stderr: child.stderr,
        fixtureStateExists: fs.existsSync(fixtureState),
        runnerStateExists: fs.existsSync(runnerState)
      })}`);
    }
    const fixture = JSON.parse(fs.readFileSync(fixtureState, "utf8"));
    const finalState = JSON.parse(fs.readFileSync(runnerState, "utf8"));
    push("three isolated probes perform only one result request per cycle", child.code === 0 && fixture.probes === 3, {
      exitCode: child.code,
      probes: fixture.probes
    });
    push("current calculator companion is fetched on result changes while the heartbeat is not yet due", fixture.companions === 2, {
      companions: fixture.companions
    });
    push("unchanged result page is not uploaded", mock.uploads.length === 2 && finalState.unchangedCycles === 1, {
      uploads: mock.uploads.length,
      unchangedCycles: finalState.unchangedCycles
    });
    push("changed result uploads use runSync=0 and bearer authorization", mock.uploads.every((upload) => (
      upload.method === "POST"
      && upload.url === "/api/admin/sporttery-relay-fast-lane?runSync=0"
      && upload.authorization === `Bearer ${token}`
    )));
    push("isolated upload payloads stay bounded to three fast endpoints", mock.uploads.every((upload) => (
      upload.snapshot?.endpoints?.length === 3
      && upload.snapshot.endpoints.some((endpoint) => endpoint.method === "result" && Number(endpoint.page) === 1)
      && upload.snapshot.endpoints.some((endpoint) => endpoint.method === "current")
      && upload.snapshot.endpoints.some((endpoint) => endpoint.method === "calculator")
    )));
    push("runner output never prints bearer token", !child.stdout.includes(token) && !child.stderr.includes(token));
    push("state records successful changed publication without failure debt", (
      finalState.uploads === 2
      && finalState.consecutiveFailures === 0
      && finalState.lastCycleStatus === "uploaded"
      && finalState.currentHeartbeatUploaded === false
      && finalState.lastUploadedResultFingerprint === finalState.lastObservedResultFingerprint
    ));

    const failureState = path.join(tempDir, "failure-state.json");
    const failureLock = path.join(tempDir, "failure-lock");
    const failed = await runChild(["--once"], {
      ...commonEnv,
      SPORTTERY_FAST_RESULT_STATE_PATH: failureState,
      SPORTTERY_FAST_RESULT_LOCK_DIR: failureLock,
      FAST_FIXTURE_FAIL_PROBE: "1"
    });
    const failedState = JSON.parse(fs.readFileSync(failureState, "utf8"));
    push("failed official probe is fail-closed and accrues bounded backoff", (
      failed.code === 1
      && failedState.consecutiveFailures === 1
      && failedState.lastCycleStatus === "failed"
      && Date.parse(failedState.nextAttemptAt) >= Date.parse(failedState.updatedAt)
    ), { exitCode: failed.code, failureCode: failedState.lastFailure?.code || null });

    const wafFixtureState = path.join(tempDir, "waf-fixture-state.json");
    const wafRunnerState = path.join(tempDir, "waf-runner-state.json");
    const wafRunnerSnapshot = path.join(tempDir, "waf-runner-snapshot.json");
    const wafRunnerLock = path.join(tempDir, "waf-runner-lock");
    const staleUploadAt = new Date(Date.now() - 5 * 60_000).toISOString();
    fs.writeFileSync(wafRunnerState, JSON.stringify({
      version: 1,
      mode: "once",
      uploads: 7,
      companionCollections: 3,
      consecutiveFailures: 4,
      lastObservedResultFingerprint: fingerprintA,
      lastUploadedResultFingerprint: fingerprintA,
      lastUploadOkAt: staleUploadAt
    }), "utf8");
    const uploadsBeforeWafFallback = mock.uploads.length;
    const wafFallback = await runChild(["--once"], {
      ...commonEnv,
      SPORTTERY_FAST_RESULT_STATE_PATH: wafRunnerState,
      SPORTTERY_FAST_RESULT_SNAPSHOT_PATH: wafRunnerSnapshot,
      SPORTTERY_FAST_RESULT_LOCK_DIR: wafRunnerLock,
      FAST_FIXTURE_STATE: wafFixtureState,
      FAST_FIXTURE_FAIL_PROBE_WAF: "1"
    });
    const wafState = JSON.parse(fs.readFileSync(wafRunnerState, "utf8"));
    const wafFixture = JSON.parse(fs.readFileSync(wafFixtureState, "utf8"));
    const wafUpload = mock.uploads[uploadsBeforeWafFallback] || null;
    push("official result WAF does not suppress the independent current calculator heartbeat", (
      wafFallback.code === 1
      && wafState.lastFailure?.code === "official-waf"
      && wafState.currentHeartbeatUploaded === true
      && wafState.uploads === 8
      && wafState.companionCollections === 4
      && wafFixture.probes === 1
      && wafFixture.companions === 1
      && wafUpload?.snapshot?.endpoints?.length === 2
      && wafUpload.snapshot.endpoints.every((endpoint) => ["current", "calculator"].includes(endpoint.method))
      && !wafUpload.snapshot.endpoints.some((endpoint) => endpoint.method === "result")
    ), {
      exitCode: wafFallback.code,
      failureCode: wafState.lastFailure?.code || null,
      currentHeartbeatUploaded: wafState.currentHeartbeatUploaded === true,
      uploads: wafState.uploads,
      companionCollections: wafState.companionCollections,
      uploadedMethods: wafUpload?.snapshot?.endpoints?.map((endpoint) => endpoint.method) || []
    });
    push("WAF fallback preserves result failure debt while scheduling the next result or heartbeat attempt", (
      wafState.consecutiveFailures === 5
      && Date.parse(wafState.lastUploadOkAt) > Date.parse(staleUploadAt)
      && Date.parse(wafState.nextAttemptAt) >= Date.parse(wafState.updatedAt)
      && Date.parse(wafState.nextAttemptAt) <= Date.parse(wafState.lastUploadOkAt) + 60_000
    ), {
      consecutiveFailures: wafState.consecutiveFailures,
      lastUploadOkAt: wafState.lastUploadOkAt || null,
      nextAttemptAt: wafState.nextAttemptAt || null
    });

    const invalidFixtureState = path.join(tempDir, "invalid-numeric-fixture-state.json");
    const invalidRunnerState = path.join(tempDir, "invalid-numeric-runner-state.json");
    const invalidRunner = await runChild(["--once", "--max-cycles=Infinity"], {
      ...commonEnv,
      SPORTTERY_FAST_RESULT_INTERVAL_SECONDS: "NaN",
      SPORTTERY_FAST_RESULT_BACKOFF_BASE_SECONDS: "Infinity",
      SPORTTERY_FAST_RESULT_BACKOFF_MAX_SECONDS: "NaN",
      SPORTTERY_FAST_RESULT_COLLECT_TIMEOUT_SECONDS: "Infinity",
      SPORTTERY_FAST_RESULT_UPLOAD_TIMEOUT_SECONDS: "NaN",
      SPORTTERY_FAST_RESULT_LOG_EVERY_CYCLES: "Infinity",
      SPORTTERY_FAST_RESULT_STATE_PATH: invalidRunnerState,
      SPORTTERY_FAST_RESULT_SNAPSHOT_PATH: path.join(tempDir, "invalid-numeric-snapshot.json"),
      SPORTTERY_FAST_RESULT_LOCK_DIR: path.join(tempDir, "invalid-numeric-lock"),
      FAST_FIXTURE_STATE: invalidFixtureState
    });
    const invalidState = JSON.parse(fs.readFileSync(invalidRunnerState, "utf8"));
    const invalidStart = JSON.parse(invalidRunner.stdout.trim().split(/\r?\n/)[0]);
    push("invalid numeric environment cannot collapse polling timeout or backoff to a request storm", (
      invalidRunner.code === 0
      && invalidStart.intervalSeconds === 15
      && invalidState.intervalSeconds === 15
      && invalidState.backoffBaseSeconds === 30
      && invalidState.backoffMaxSeconds === 300
      && invalidState.wafBackoffMaxSeconds === 1800
    ), {
      exitCode: invalidRunner.code,
      intervalSeconds: invalidState.intervalSeconds,
      backoffBaseSeconds: invalidState.backoffBaseSeconds,
      wafBackoffMaxSeconds: invalidState.wafBackoffMaxSeconds,
      backoffMaxSeconds: invalidState.backoffMaxSeconds
    });

    const fakeFailureCompletedAtMs = Date.parse("2026-07-13T12:00:00.000Z");
    const fakeNextAttemptAt = new Date(fakeFailureCompletedAtMs + 30_000).toISOString();
    const delayAtCompletionMs = computeDelayFromCompletion({
      nextAttemptAt: fakeNextAttemptAt,
      nowMs: fakeFailureCompletedAtMs,
      fallbackMs: 1,
      maxMs: 300_000
    });
    const delayAfterFakeClockAdvanceMs = computeDelayFromCompletion({
      nextAttemptAt: fakeNextAttemptAt,
      nowMs: fakeFailureCompletedAtMs + 7_000,
      fallbackMs: 1,
      maxMs: 300_000
    });
    push("failure backoff sleep starts at failure completion and matches nextAttemptAt", (
      delayAtCompletionMs === 30_000
      && delayAfterFakeClockAdvanceMs === 23_000
    ), {
      fakeClock: true,
      cycleElapsedBeforeFailureMs: 120_000,
      delayAtCompletionMs,
      delayAfterFakeClockAdvanceMs
    });

    const unsafeLockDir = path.join(tempDir, "unsafe-live-owner-lock");
    fs.mkdirSync(unsafeLockDir);
    fs.writeFileSync(path.join(unsafeLockDir, "owner.json"), JSON.stringify({
      version: 2,
      instanceId: "pid-reuse-owner",
      pid: process.pid,
      root: rootDir,
      runnerScript: path.join(rootDir, "scripts", "runSportteryFastResultLane.cjs"),
      processStartKey: "stale-process-start",
      command: fakeRunnerCommand,
      commandSignature: commandSignature(fakeRunnerCommand),
      updatedAt: new Date().toISOString()
    }), "utf8");
    const unsafeLockRunner = await runChild(["--once"], {
      ...commonEnv,
      SPORTTERY_FAST_RESULT_STATE_PATH: path.join(tempDir, "unsafe-lock-runner-state.json"),
      SPORTTERY_FAST_RESULT_LOCK_DIR: unsafeLockDir,
      FAST_FIXTURE_STATE: path.join(tempDir, "unsafe-lock-fixture-state.json")
    });
    const unsafeLockLine = JSON.parse(unsafeLockRunner.stdout.trim().split(/\r?\n/).at(-1));
    push("unknown or mismatched live lock owner exits nonzero with a health alarm", (
      unsafeLockRunner.code === 1
      && unsafeLockLine.ok === false
      && unsafeLockLine.status === "lock-health-failed"
    ), {
      exitCode: unsafeLockRunner.code,
      status: unsafeLockLine.status,
      reason: unsafeLockLine.reason
    });
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
  }

  const rejectedAckMock = await startServer([
    { status: 200, body: { ok: true, storedValidation: { ok: false } } }
  ]);
  const rejectedAckStatePath = path.join(tempDir, "rejected-ack-state.json");
  try {
    const rejectedAckRunner = await runChild(["--once"], {
      SPORTTERY_FAST_RESULT_TEST_MODE: "1",
      SPORTTERY_FAST_RESULT_INTERVAL_SECONDS: "0.05",
      SPORTTERY_FAST_RESULT_COLLECTOR_SCRIPT: fixturePath,
      SPORTTERY_FAST_RESULT_PUSH_BASE_URL: rejectedAckMock.baseUrl,
      SPORTTERY_FAST_RESULT_ADMIN_TOKEN: "rejected-ack-token",
      SPORTTERY_FAST_RESULT_STATE_PATH: rejectedAckStatePath,
      SPORTTERY_FAST_RESULT_SNAPSHOT_PATH: path.join(tempDir, "rejected-ack-snapshot.json"),
      SPORTTERY_FAST_RESULT_LOCK_DIR: path.join(tempDir, "rejected-ack-lock"),
      FAST_FIXTURE_STATE: path.join(tempDir, "rejected-ack-fixture-state.json")
    });
    const rejectedAckState = JSON.parse(fs.readFileSync(rejectedAckStatePath, "utf8"));
    push("rejected stored validation never advances uploaded fingerprint or upload count", (
      rejectedAckRunner.code === 1
      && rejectedAckState.uploads === 0
      && !rejectedAckState.lastUploadedResultFingerprint
      && rejectedAckState.lastCycleStatus === "failed"
    ), {
      exitCode: rejectedAckRunner.code,
      uploads: rejectedAckState.uploads,
      lastCycleStatus: rejectedAckState.lastCycleStatus
    });
  } finally {
    await new Promise((resolve) => rejectedAckMock.server.close(resolve));
  }

  const installerPath = path.join(rootDir, "scripts", "installSportteryFastResultLaneTask.ps1");
  const installerSource = fs.readFileSync(installerPath, "utf8");
  push("failed unattended task registration cleans the candidate before touching production", (
    installerSource.includes("$CandidateTaskName")
    && installerSource.includes("$CandidateCreated")
    && installerSource.includes("/Delete /TN $CandidateTaskName /F")
    && installerSource.indexOf("$Folder.RegisterTaskDefinition(\n    $CandidateTaskName")
      < installerSource.indexOf("Stop-ScheduledTask -TaskName $TaskName")
    && installerSource.includes("Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue")
  ));
  if (process.platform === "win32") {
    const taskBaseEnv = {
      FOOTBALL_FAST_RESULT_VALIDATE_ONLY: "1",
      FOOTBALL_FAST_RESULT_TASK_IDENTITY: "",
      FOOTBALL_FAST_RESULT_ALLOW_INTERACTIVE: ""
    };
    const defaultTask = await runPowerShell(installerPath, taskBaseEnv);
    const systemTask = await runPowerShell(installerPath, {
      ...taskBaseEnv,
      FOOTBALL_FAST_RESULT_TASK_IDENTITY: "SYSTEM"
    });
    const rejectedInteractiveTask = await runPowerShell(installerPath, {
      ...taskBaseEnv,
      FOOTBALL_FAST_RESULT_TASK_IDENTITY: "INTERACTIVE"
    });
    const explicitInteractiveTask = await runPowerShell(installerPath, {
      ...taskBaseEnv,
      FOOTBALL_FAST_RESULT_TASK_IDENTITY: "INTERACTIVE",
      FOOTBALL_FAST_RESULT_ALLOW_INTERACTIVE: "1"
    });
    const defaultConfig = JSON.parse(defaultTask.stdout.trim());
    const systemConfig = JSON.parse(systemTask.stdout.trim());
    const explicitInteractiveConfig = JSON.parse(explicitInteractiveTask.stdout.trim());
    push("scheduled task defaults to passwordless unattended S4U across user logoff", (
      defaultTask.code === 0
      && defaultConfig.identity === "S4U"
      && defaultConfig.logonType === 2
      && defaultConfig.unattendedAcrossLogoff === true
      && defaultConfig.storesPassword === false
    ));
    push("SYSTEM service-account task policy is available without stored credentials", (
      systemTask.code === 0
      && systemConfig.identity === "SYSTEM"
      && systemConfig.logonType === 5
      && systemConfig.storesPassword === false
    ));
    push("interactive task identity requires explicit unsafe diagnostic opt-in", (
      rejectedInteractiveTask.code !== 0
      && explicitInteractiveTask.code === 0
      && explicitInteractiveConfig.logonType === 3
      && explicitInteractiveConfig.interactiveOptIn === true
    ));
  } else {
    push("Windows task policy statically defaults to unattended passwordless identity", (
      installerSource.includes('else { "S4U" }')
      && installerSource.includes("TASK_LOGON_S4U")
      && installerSource.includes("TASK_LOGON_SERVICE_ACCOUNT")
      && installerSource.includes("FOOTBALL_FAST_RESULT_ALLOW_INTERACTIVE=1")
    ));
  }

  const lockCandidateResidue = fs.readdirSync(tempDir)
    .filter((name) => name.includes(".candidate-"));
  push("complete-lock staging directories are removed after all publish races", (
    lockCandidateResidue.length === 0
  ), { lockCandidateResidue });
  const tempResidue = fs.readdirSync(tempDir).filter((name) => name.endsWith(".tmp"));
  push("atomic snapshot and state writes leave no temp residue", tempResidue.length === 0, { tempResidue });

  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    summary: {
      checks: checks.length,
      passed: checks.filter((check) => check.ok).length,
      defaultProbeIntervalSeconds: 15,
      steadyOfficialRequestsPerMinute: 4,
      currentHeartbeatAdditionalOfficialRequestsPerMinute: 2,
      changedCycleAdditionalOfficialRequests: 2,
      uploadOnResultChangeOrCurrentHeartbeat: true
    },
    checks
  }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
};

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message || String(error) })}\n`);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
