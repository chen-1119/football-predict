const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  sportteryResultObservation,
} = require("../src/services/sportteryResultSemantics.cjs");

const rootDir = path.resolve(__dirname, "..");
const runnerScriptPath = path.join(rootDir, "scripts", "runSportteryFastResultLane.cjs");

const finiteNumber = (value, fallback, options = {}) => {
  const parsed = Number(value);
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
  const candidate = Number.isFinite(parsed) ? parsed : safeFallback;
  const min = Number.isFinite(Number(options.min)) ? Number(options.min) : -Number.MAX_SAFE_INTEGER;
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : Number.MAX_SAFE_INTEGER;
  const clamped = Math.min(Math.max(candidate, Math.min(min, max)), Math.max(min, max));
  return options.integer === true ? Math.round(clamped) : clamped;
};

const readJsonSafe = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (filePath, payload, options = {}) => {
  const fileSystem = options.fileSystem || fs;
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  let committed = false;
  try {
    fileSystem.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fileSystem.renameSync(tempPath, filePath);
    committed = true;
  } finally {
    if (!committed) {
      try { fileSystem.rmSync(tempPath, { force: true }); } catch {}
    }
  }
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

const stableStringify = (value) => JSON.stringify(stableValue(value));

const rowsInRelayPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const endpointMethod = (endpoint) => String(endpoint?.method || endpoint?.id || "");

const usableEndpoint = (endpoint) => Boolean(
  endpoint?.payload
  && endpoint.ok !== false
  && rowsInRelayPayload(endpoint.payload) > 0
);

const resultPageOneEndpoint = (snapshot) => (Array.isArray(snapshot?.endpoints) ? snapshot.endpoints : [])
  .find((endpoint) => {
    if (!usableEndpoint(endpoint) || endpointMethod(endpoint) !== "result") return false;
    const page = Number(endpoint?.page ?? 1);
    return Number.isFinite(page) && page === 1;
  }) || null;

const resultObservationRows = (resultEndpoint) => {
  const days = resultEndpoint?.payload?.value?.matchInfoList || [];
  const rows = [];
  for (const day of days) {
    for (const match of Array.isArray(day?.subMatchList) ? day.subMatchList : []) {
      rows.push(sportteryResultObservation(match));
    }
  }
  return rows.sort((a, b) => {
    const aKey = `${a.matchId ?? ""}:${a.matchNumDate ?? ""}:${a.matchNum ?? ""}`;
    const bKey = `${b.matchId ?? ""}:${b.matchNumDate ?? ""}:${b.matchNum ?? ""}`;
    return aKey.localeCompare(bKey);
  });
};

const resultFingerprint = (resultEndpoint) => {
  const rows = resultObservationRows(resultEndpoint);
  if (!rows.length) throw new Error("fast-result-probe-empty");
  return crypto.createHash("sha256").update(stableStringify(rows)).digest("hex");
};

const fastLanePublishDecision = ({
  fingerprint,
  lastUploadedResultFingerprint,
  lastUploadOkAt,
  currentHeartbeatMs = 60_000,
  nowMs = Date.now()
}) => {
  const currentFingerprint = String(fingerprint || "").trim();
  const uploadedFingerprint = String(lastUploadedResultFingerprint || "").trim();
  const safeHeartbeatMs = finiteNumber(currentHeartbeatMs, 60_000, {
    min: 1,
    max: 24 * 60 * 60_000,
    integer: true
  });
  const safeNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const lastUploadMs = Date.parse(String(lastUploadOkAt || ""));
  const uploadClockTrusted = Number.isFinite(lastUploadMs)
    && lastUploadMs <= safeNowMs + 5 * 60_000;
  const uploadAgeMs = uploadClockTrusted ? Math.max(0, safeNowMs - lastUploadMs) : null;
  const resultChanged = !uploadedFingerprint || currentFingerprint !== uploadedFingerprint;
  const currentHeartbeatDue = !uploadClockTrusted || uploadAgeMs >= safeHeartbeatMs;
  const publish = Boolean(currentFingerprint && (resultChanged || currentHeartbeatDue));
  return {
    publish,
    reason: resultChanged
      ? (uploadedFingerprint ? "result-change" : "initial-result")
      : currentHeartbeatDue
        ? (uploadClockTrusted ? "current-heartbeat" : "current-heartbeat-clock-missing-or-invalid")
        : "unchanged-within-current-heartbeat",
    resultChanged,
    currentHeartbeatDue,
    currentHeartbeatMs: safeHeartbeatMs,
    lastUploadOkAt: uploadClockTrusted ? new Date(lastUploadMs).toISOString() : null,
    uploadAgeMs
  };
};

const compactFingerprint = (value) => String(value || "").slice(0, 12) || null;

const classifyFailure = (error) => {
  const text = String(error?.message || error || "");
  if (/official-waf|waf-blocked|HTTP (?:403|429|567)|captcha|WAF/i.test(text)) return "official-waf";
  if (/timeout/i.test(text)) return "timeout";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(text)) return "network";
  if (/collector/i.test(text)) return "collector";
  if (/remote-upload/i.test(text)) return "remote-upload";
  if (/fast-result-probe-empty|fast-result-probe-invalid/i.test(text)) return "invalid-probe";
  return "unknown";
};

const safeFailure = (error) => ({
  code: classifyFailure(error),
  message: String(error?.message || error || "fast result lane failed")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 240)
});

const computeBackoffMs = ({
  consecutiveFailures,
  baseMs = 30_000,
  maxMs = 5 * 60_000,
  jitterRatio = 0.1,
  random = Math.random
}) => {
  const failures = finiteNumber(consecutiveFailures, 1, { min: 1, max: 1024, integer: true });
  const safeBaseMs = finiteNumber(baseMs, 30_000, { min: 1000, max: 60 * 60_000, integer: true });
  const safeMaxMs = finiteNumber(maxMs, 5 * 60_000, {
    min: safeBaseMs,
    max: 24 * 60 * 60_000,
    integer: true
  });
  const safeJitterRatio = finiteNumber(jitterRatio, 0.1, { min: 0, max: 0.5 });
  let randomValue = 0;
  try {
    randomValue = finiteNumber(typeof random === "function" ? random() : 0, 0, { min: 0, max: 1 });
  } catch {
    randomValue = 0;
  }
  const raw = Math.min(safeMaxMs, safeBaseMs * (2 ** Math.min(8, failures - 1)));
  const jitter = raw * safeJitterRatio * randomValue;
  return Math.round(Math.min(safeMaxMs, raw + jitter));
};

const computeFailureBackoffMs = ({
  failureCode,
  consecutiveFailures,
  baseMs,
  maxMs,
  wafMaxMs = maxMs,
  jitterRatio,
  random,
}) => computeBackoffMs({
  consecutiveFailures,
  baseMs,
  maxMs: failureCode === "official-waf"
    ? Math.max(Number(maxMs) || 0, Number(wafMaxMs) || 0)
    : maxMs,
  jitterRatio,
  random,
});

const computeDelayFromCompletion = ({
  nextAttemptAt,
  nowMs = Date.now(),
  fallbackMs = 0,
  maxMs = 24 * 60 * 60_000
}) => {
  const safeNowMs = finiteNumber(nowMs, Date.now(), {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true
  });
  const safeMaxMs = finiteNumber(maxMs, 24 * 60 * 60_000, {
    min: 0,
    max: 24 * 60 * 60_000,
    integer: true
  });
  const safeFallbackMs = finiteNumber(fallbackMs, 0, {
    min: 0,
    max: safeMaxMs,
    integer: true
  });
  const nextAttemptMs = Date.parse(String(nextAttemptAt || ""));
  if (!Number.isFinite(nextAttemptMs)) return safeFallbackMs;
  return finiteNumber(Math.max(0, nextAttemptMs - safeNowMs), safeFallbackMs, {
    min: 0,
    max: safeMaxMs,
    integer: true
  });
};

const isLoopbackHost = (hostname) => hostname === "localhost"
  || hostname === "::1"
  || /^127(?:\.\d{1,3}){3}$/.test(hostname);

const assertSafeUploadUrl = (baseUrl) => {
  const target = new URL(baseUrl);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && isLoopbackHost(target.hostname))) {
    throw new Error("remote-upload-requires-https");
  }
  return target;
};

const postSnapshot = ({
  baseUrl,
  adminToken,
  snapshot,
  timeoutMs = 30_000,
  timerApi = null
}) => new Promise((resolve, reject) => {
  if (!adminToken) {
    reject(new Error("remote-upload-admin-token-missing"));
    return;
  }
  const base = assertSafeUploadUrl(baseUrl);
  const target = new URL("/api/admin/sporttery-relay-fast-lane?runSync=0", base);
  const body = JSON.stringify({ snapshot, runSync: false });
  const transport = target.protocol === "https:" ? https : http;
  const safeTimeoutMs = finiteNumber(timeoutMs, 30_000, { min: 1000, max: 5 * 60_000, integer: true });
  let settled = false;
  let req = null;
  let res = null;
  let raw = "";
  let wallClockTimer = null;
  const scheduleTimeout = typeof timerApi?.setTimeout === "function"
    ? timerApi.setTimeout.bind(timerApi)
    : setTimeout;
  const cancelTimeout = typeof timerApi?.clearTimeout === "function"
    ? timerApi.clearTimeout.bind(timerApi)
    : clearTimeout;

  const settle = (error, value) => {
    if (settled) return;
    settled = true;
    if (wallClockTimer) {
      cancelTimeout(wallClockTimer);
      wallClockTimer = null;
    }
    if (error) reject(error);
    else resolve(value);
  };

  const fail = (error) => {
    const failure = error instanceof Error ? error : new Error(String(error || "remote-upload-failed"));
    settle(failure);
    if (res && !res.destroyed) res.destroy();
    if (req && !req.destroyed) req.destroy();
  };

  const finishResponse = () => {
    if (settled || !res) return;
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const accepted = Number(res.statusCode) >= 200
      && Number(res.statusCode) < 300
      && payload?.ok === true
      && payload?.storedValidation?.ok === true;
    if (!accepted) {
      const error = new Error(`remote-upload-rejected-${Number(res.statusCode || 0)}`);
      error.status = Number(res.statusCode || 0);
      error.response = payload;
      fail(error);
      return;
    }
    settle(null, {
      ok: true,
      status: Number(res.statusCode || 0),
      validationRows: finiteNumber(payload?.storedValidation?.rows, 0, { min: 0, max: 10_000_000, integer: true }),
      usableEndpoints: finiteNumber(payload?.storedValidation?.usableEndpoints, 0, { min: 0, max: 100_000, integer: true }),
      replacedPrevious: payload?.replacedPrevious === true
    });
  };

  wallClockTimer = scheduleTimeout(() => {
    fail(new Error("remote-upload-wall-clock-timeout"));
  }, safeTimeoutMs);
  wallClockTimer.unref?.();

  req = transport.request(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    }
  }, (response) => {
    res = response;
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      if (settled) return;
      if (raw.length + chunk.length > 1024 * 1024) {
        fail(new Error("remote-upload-response-too-large"));
        return;
      }
      raw += chunk;
    });
    res.once("end", finishResponse);
    res.once("aborted", () => fail(new Error("remote-upload-response-aborted")));
    res.once("error", (error) => fail(error));
    res.once("close", () => {
      if (settled) return;
      if (res.complete && res.readableEnded) finishResponse();
      else fail(new Error("remote-upload-response-closed"));
    });
  });
  req.setTimeout(safeTimeoutMs, () => fail(new Error("remote-upload-inactivity-timeout")));
  req.once("error", (error) => fail(error));
  req.end(body);
});

const runTransportCommand = ({
  command,
  args,
  input = null,
  timeoutMs = 30_000
}) => new Promise((resolve, reject) => {
  const safeTimeoutMs = finiteNumber(timeoutMs, 30_000, {
    min: 1000,
    max: 5 * 60_000,
    integer: true
  });
  const child = spawn(command, args, {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(value);
  };
  const timer = setTimeout(async () => {
    await terminateChildTree(child);
    finish(new Error(`remote-upload-${command}-timeout`));
  }, safeTimeoutMs);
  timer.unref?.();
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 1024 * 1024) stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 256 * 1024) stderr += chunk.toString();
  });
  child.once("error", (error) => finish(error));
  child.once("exit", (code) => {
    if (code !== 0) {
      finish(new Error(`remote-upload-${command}-failed-${code}: ${stderr.trim().slice(0, 500)}`));
      return;
    }
    finish(null, { stdout, stderr, status: Number(code || 0) });
  });
  if (input !== null && input !== undefined) child.stdin.end(String(input));
  else child.stdin.end();
});

const postSnapshotOverSsh = async ({
  sshHost,
  sshPort = "22",
  sshUser = "ubuntu",
  sshKeyPath,
  adminToken,
  snapshot,
  timeoutMs = 30_000,
  incomingDir = "/var/lib/football-relay/incoming"
}) => {
  const host = String(sshHost || "").trim();
  const user = String(sshUser || "ubuntu").trim();
  const port = String(sshPort || "22").trim();
  const keyPath = path.resolve(String(sshKeyPath || ""));
  if (!host) throw new Error("remote-upload-ssh-host-missing");
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new Error("remote-upload-ssh-host-invalid");
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) throw new Error("remote-upload-ssh-user-invalid");
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("remote-upload-ssh-port-invalid");
  }
  if (!adminToken) throw new Error("remote-upload-admin-token-missing");
  if (!sshKeyPath || !fs.existsSync(keyPath)) throw new Error("remote-upload-ssh-key-missing");
  if (incomingDir !== "/var/lib/football-relay/incoming") {
    throw new Error("remote-upload-ssh-incoming-dir-invalid");
  }

  const envelope = `${JSON.stringify({ snapshot, runSync: false })}\n`;
  const sha256 = crypto.createHash("sha256").update(envelope).digest("hex");
  const timestampId = new Date().toISOString().replace(/[-:.]/g, "");
  const localPath = path.join(rootDir, ".codex-tmp", `${sha256}.${timestampId}.fast.json`);
  const remotePath = `${incomingDir}/${sha256}.${timestampId}.fast.json`;
  const remoteTarget = `${user}@${host}`;
  const commonOptions = [
    "-i", keyPath,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new"
  ];
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, envelope, { encoding: "utf8", mode: 0o600 });
  try {
    await runTransportCommand({
      command: "scp",
      args: [
        ...commonOptions,
        "-C",
        "-P", port,
        localPath,
        `${remoteTarget}:${remotePath}`
      ],
      timeoutMs
    });
    const remoteCommand = [
      "set -eu",
      `incoming='${remotePath}'`,
      "trap 'rm -f \"$incoming\"' EXIT",
      "chmod 0600 \"$incoming\"",
      "curl --fail-with-body --silent --show-error --max-time 25 --config - --data-binary \"@$incoming\" 'http://127.0.0.1/api/admin/sporttery-relay-fast-lane?runSync=0'"
    ].join("; ");
    const curlConfig = [
      'header = "content-type: application/json"',
      `header = "authorization: Bearer ${String(adminToken).replace(/[\r\n"]/g, "")}"`,
      ""
    ].join("\n");
    const result = await runTransportCommand({
      command: "ssh",
      args: [
        ...commonOptions,
        "-p", port,
        remoteTarget,
        remoteCommand
      ],
      input: curlConfig,
      timeoutMs
    });
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error("remote-upload-ssh-response-invalid");
    }
    if (payload?.ok !== true || payload?.storedValidation?.ok !== true) {
      throw new Error("remote-upload-ssh-response-rejected");
    }
    return {
      ok: true,
      status: 200,
      transport: "ssh-local-http",
      validationRows: finiteNumber(payload?.storedValidation?.rows, 0, {
        min: 0,
        max: 10_000_000,
        integer: true
      }),
      usableEndpoints: finiteNumber(payload?.storedValidation?.usableEndpoints, 0, {
        min: 0,
        max: 100_000,
        integer: true
      }),
      replacedPrevious: payload?.replacedPrevious === true
    };
  } finally {
    fs.rmSync(localPath, { force: true });
  }
};

const terminateChildTree = async (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", resolve);
      killer.on("exit", resolve);
    });
    return;
  }
  child.kill("SIGKILL");
};

const runCollector = ({
  collectorScript,
  outputPath,
  methods,
  skipInitial,
  timeoutMs = 45_000,
  env = process.env
}) => new Promise((resolve, reject) => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const child = spawn(process.execPath, [collectorScript], {
    cwd: rootDir,
    env: {
      ...env,
      SPORTTERY_RELAY_SNAPSHOT_OUT: outputPath,
      SPORTTERY_RELAY_METHODS: methods,
      SPORTTERY_RELAY_RESULT_PAGE_DEPTH: "1",
      SPORTTERY_RELAY_PAGE_DEPTH: "1",
      SPORTTERY_RELAY_SKIP_INITIAL: skipInitial ? "1" : "0"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 128 * 1024) stderr += chunk.toString();
  });
  const safeTimeoutMs = finiteNumber(timeoutMs, 45_000, { min: 1000, max: 5 * 60_000, integer: true });
  const timer = setTimeout(async () => {
    await terminateChildTree(child);
    reject(new Error("collector-timeout"));
  }, safeTimeoutMs);
  timer.unref?.();
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      const classified = classifyFailure(stderr);
      reject(new Error(`collector-failed-${classified}`));
      return;
    }
    const snapshot = readJsonSafe(outputPath, null);
    if (!snapshot || !Array.isArray(snapshot.endpoints)) {
      reject(new Error("collector-output-invalid"));
      return;
    }
    resolve(snapshot);
  });
});

const nonEmptyText = (value) => {
  const text = String(value ?? "").trim();
  return text || null;
};

const constituentCycleIdsForEndpoint = (endpoint, snapshot) => Array.from(new Set([
  endpoint?.sourceCycleId,
  endpoint?.collectorProvenance?.sourceCycleId,
  snapshot?.sourceCycleId,
  snapshot?.collectorProvenance?.sourceCycleId
].map(nonEmptyText).filter(Boolean)));

const endpointObservationMs = (endpoint) => {
  const requestedMs = Date.parse(String(endpoint?.requestedAt || endpoint?.collectorProvenance?.requestedAt || ""));
  const receivedMs = Date.parse(String(endpoint?.receivedAt || endpoint?.collectorProvenance?.receivedAt || ""));
  if (Number.isFinite(requestedMs) && Number.isFinite(receivedMs) && receivedMs < requestedMs) {
    throw new Error("fast-result-endpoint-clock-invalid");
  }
  if (Number.isFinite(receivedMs)) return receivedMs;
  const fetchedMs = Date.parse(String(endpoint?.fetchedAt || ""));
  return Number.isFinite(fetchedMs) ? fetchedMs : null;
};

const fastResultConstituent = ({ endpoint, snapshot, role }) => {
  const preservedSourceCycleIds = Array.from(new Set(
    (Array.isArray(endpoint?.fastResultConstituent?.sourceCycleIds)
      ? endpoint.fastResultConstituent.sourceCycleIds
      : [])
      .map(nonEmptyText)
      .filter(Boolean)
  ));
  const sourceCycleIds = preservedSourceCycleIds.length
    ? preservedSourceCycleIds
    : constituentCycleIdsForEndpoint(endpoint, snapshot);
  return {
    ...endpoint,
    fastResultConstituent: {
      role,
      sourceCycleIds,
      sourceCycleId: sourceCycleIds.length === 1 ? sourceCycleIds[0] : null,
      mixedSourceCycles: sourceCycleIds.length > 1,
      provenancePreserved: true
    }
  };
};

const createFastUploadSnapshot = ({
  probeSnapshot,
  companionSnapshot,
  fingerprint,
  now = new Date(),
  uploadCycleId = null
}) => {
  const resultEndpoint = resultPageOneEndpoint(probeSnapshot);
  if (!resultEndpoint) throw new Error("fast-result-probe-invalid");
  const rawCompanionEndpoints = (Array.isArray(companionSnapshot?.endpoints) ? companionSnapshot.endpoints : [])
    .filter((endpoint) => usableEndpoint(endpoint) && ["current", "calculator"].includes(endpointMethod(endpoint)));
  if (!rawCompanionEndpoints.length) throw new Error("fast-result-companion-invalid");
  const companionEndpoints = rawCompanionEndpoints.map((endpoint) => fastResultConstituent({
    endpoint,
    snapshot: companionSnapshot,
    role: "companion"
  }));
  const auditedResultEndpoint = fastResultConstituent({
    endpoint: resultEndpoint,
    snapshot: probeSnapshot,
    role: "probe"
  });
  const endpoints = [...companionEndpoints, auditedResultEndpoint]
    .sort((a, b) => endpointMethod(a).localeCompare(endpointMethod(b)));
  const rows = endpoints.reduce((sum, endpoint) => sum + rowsInRelayPayload(endpoint.payload), 0);
  const methods = Array.from(new Set(endpoints.map(endpointMethod)));
  const captureTimes = endpoints.map(endpointObservationMs).filter(Number.isFinite);
  if (!captureTimes.length) throw new Error("fast-result-endpoint-clock-missing");
  const capturedAt = new Date(Math.max(...captureTimes)).toISOString();
  const mergeCreatedMs = Date.parse(String(now instanceof Date ? now.toISOString() : now));
  if (!Number.isFinite(mergeCreatedMs)) throw new Error("fast-result-merge-clock-invalid");
  const mergeCreatedAt = new Date(mergeCreatedMs).toISOString();
  const resolvedUploadCycleId = nonEmptyText(uploadCycleId)
    || `sporttery-fast-upload-merge:${mergeCreatedAt.replace(/[^0-9A-Za-z]/g, "")}:${crypto.randomUUID()}`;
  const constituentCycleIds = Array.from(new Set(endpoints
    .flatMap((endpoint) => endpoint.fastResultConstituent?.sourceCycleIds || [])))
    .sort();
  const mixedCollectorSourceCycles = constituentCycleIds.length > 1;
  return {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt,
    sourceCycleId: resolvedUploadCycleId,
    sourceCycleKind: "upload-merge",
    uploadCycleId: resolvedUploadCycleId,
    mergeCycleId: resolvedUploadCycleId,
    mergeCreatedAt,
    constituentCycleIds,
    collectorSourceCycleId: constituentCycleIds.length === 1 ? constituentCycleIds[0] : null,
    mixedCollectorSourceCycles,
    provenanceVersion: 2,
    collectorProvenance: {
      sourceCycleId: resolvedUploadCycleId,
      cycleKind: "upload-merge",
      mergeCreatedAt,
      constituentCycleIds,
      mixedCollectorSourceCycles,
      endpointObservationClocks: "preserved-from-constituent-collectors"
    },
    maxAgeMinutes: finiteNumber(probeSnapshot?.maxAgeMinutes ?? companionSnapshot?.maxAgeMinutes, 20, {
      min: 1,
      max: 24 * 60,
      integer: true
    }),
    producer: {
      ...(probeSnapshot?.producer || companionSnapshot?.producer || {}),
      fastResultLane: true,
      probeMode: "result-page-1",
      companionMode: "current-calculator-on-change",
      resultFingerprint: fingerprint,
      constituentProducers: {
        probe: probeSnapshot?.producer || null,
        companion: companionSnapshot?.producer || null
      }
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows,
      errors: 0,
      methods,
      pageDepth: 1,
      resultPageDepth: 1,
      fastResultLane: true,
      resultRows: rowsInRelayPayload(resultEndpoint.payload),
      sourceCycleId: resolvedUploadCycleId,
      sourceCycleKind: "upload-merge",
      constituentCycleIds,
      mixedCollectorSourceCycles
    },
    endpoints,
    errors: []
  };
};

const normalizeCommand = (value) => String(value || "").replace(/\s+/g, " ").trim();
const normalizeIdentityPath = (value, platform = process.platform) => {
  const normalized = path.resolve(String(value || "")).replace(/\\/g, "/").replace(/\/$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};
const commandSignature = (value) => crypto.createHash("sha256").update(normalizeCommand(value)).digest("hex");
const commandLooksLikeRunner = (value) => normalizeCommand(value).toLowerCase().includes("runsportteryfastresultlane.cjs");

const inspectWindowsProcessIdentity = (pid) => {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:FOOTBALL_LOCK_PID)",
    "if(-not $p){[pscustomobject]@{exists=$false}|ConvertTo-Json -Compress;exit 0}",
    "$started=if($p.CreationDate -is [datetime]){$p.CreationDate.ToUniversalTime().ToString('o')}else{[string]$p.CreationDate}",
    "[pscustomobject]@{exists=$true;startKey=$started;command=[string]$p.CommandLine;executable=[string]$p.ExecutablePath}|ConvertTo-Json -Compress"
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, FOOTBALL_LOCK_PID: String(pid) }
  });
  if (result.error || result.status !== 0) {
    return { status: "unknown", exists: null, reason: "windows-process-inspection-failed" };
  }
  try {
    const payload = JSON.parse(String(result.stdout || "").trim());
    if (payload?.exists === false) return { status: "ok", exists: false };
    if (payload?.exists !== true || !payload.startKey || !payload.command) {
      return { status: "unknown", exists: null, reason: "windows-process-identity-incomplete" };
    }
    return {
      status: "ok",
      exists: true,
      startKey: String(payload.startKey),
      command: normalizeCommand(payload.command),
      executable: String(payload.executable || ""),
      cwd: null
    };
  } catch {
    return { status: "unknown", exists: null, reason: "windows-process-identity-invalid-json" };
  }
};

const inspectLinuxProcessIdentity = (pid) => {
  const procDir = `/proc/${pid}`;
  try {
    const stat = fs.readFileSync(path.join(procDir, "stat"), "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return { status: "unknown", exists: null, reason: "linux-process-stat-invalid" };
    const fieldsAfterComm = stat.slice(closeParen + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterComm[19];
    const command = fs.readFileSync(path.join(procDir, "cmdline"))
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
    const cwd = fs.readlinkSync(path.join(procDir, "cwd"));
    if (!startTicks || !command || !cwd) {
      return { status: "unknown", exists: null, reason: "linux-process-identity-incomplete" };
    }
    return {
      status: "ok",
      exists: true,
      startKey: `proc-start-ticks:${startTicks}`,
      command: normalizeCommand(command),
      executable: "",
      cwd
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return { status: "ok", exists: false };
    return { status: "unknown", exists: null, reason: "linux-process-inspection-failed" };
  }
};

const inspectProcessIdentity = (pid, options = {}) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) {
    return { status: "unknown", exists: null, reason: "process-pid-invalid" };
  }
  const platform = options.platform || process.platform;
  if (platform === "win32") return inspectWindowsProcessIdentity(value);
  if (platform === "linux") return inspectLinuxProcessIdentity(value);
  return { status: "unknown", exists: null, reason: "process-platform-unsupported" };
};

const enumerateRunnerProcessIds = (platform = process.platform) => {
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$pids=@(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'node') -and ([string]$_.CommandLine -match 'runSportteryFastResultLane[.]cjs') } | ForEach-Object { [int]$_.ProcessId })",
      "[pscustomobject]@{pids=$pids}|ConvertTo-Json -Compress"
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000
    });
    if (result.error || result.status !== 0) {
      return { status: "unknown", pids: [], reason: "windows-runner-enumeration-failed" };
    }
    try {
      const payload = JSON.parse(String(result.stdout || "").trim());
      const pids = (Array.isArray(payload?.pids) ? payload.pids : [payload?.pids])
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      return { status: "ok", pids: Array.from(new Set(pids)) };
    } catch {
      return { status: "unknown", pids: [], reason: "windows-runner-enumeration-invalid-json" };
    }
  }
  if (platform === "linux") {
    const result = spawnSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      timeout: 5000
    });
    if (result.error || result.status !== 0) {
      return { status: "unknown", pids: [], reason: "posix-runner-enumeration-failed" };
    }
    const pids = String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        return match && commandLooksLikeRunner(match[2]) ? Number(match[1]) : null;
      })
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    return { status: "ok", pids: Array.from(new Set(pids)) };
  }
  return { status: "unknown", pids: [], reason: "runner-enumeration-platform-unsupported" };
};

const identityMatchesExpectedRunner = (identity, expectedRoot = rootDir, platform = process.platform) => {
  if (identity?.status !== "ok" || identity.exists !== true || !commandLooksLikeRunner(identity.command)) return false;
  const expectedScript = normalizeIdentityPath(
    path.join(expectedRoot, "scripts", "runSportteryFastResultLane.cjs"),
    platform
  );
  const normalizedCommand = normalizeCommand(identity.command).replace(/\\/g, "/");
  const comparableCommand = platform === "win32" ? normalizedCommand.toLowerCase() : normalizedCommand;
  if (comparableCommand.includes(expectedScript)) return true;
  if (identity.cwd) {
    return normalizeIdentityPath(identity.cwd, platform) === normalizeIdentityPath(expectedRoot, platform);
  }
  // Win32 CIM does not expose cwd. Treat any matching runner command as live so
  // an unrelated-but-active lane can only delay recovery, never cause lock theft.
  return platform === "win32";
};

const inspectRunnerProcesses = ({
  platform = process.platform,
  expectedRoot = rootDir,
  inspect = inspectProcessIdentity,
  excludePid = process.pid
} = {}) => {
  const enumeration = enumerateRunnerProcessIds(platform);
  if (enumeration.status !== "ok") {
    return { status: "unknown", liveRunnerCount: null, processes: [], reason: enumeration.reason };
  }
  const processes = [];
  for (const pid of enumeration.pids) {
    if (Number(pid) === Number(excludePid)) continue;
    const identity = inspect(pid, { platform });
    if (identity?.status === "ok" && identity.exists === false) continue;
    if (identity?.status !== "ok") {
      return {
        status: "unknown",
        liveRunnerCount: null,
        processes,
        reason: identity?.reason || "runner-process-inspection-failed"
      };
    }
    if (identityMatchesExpectedRunner(identity, expectedRoot, platform)) {
      processes.push({ pid, startKey: String(identity.startKey || "") });
    }
  }
  return { status: "ok", liveRunnerCount: processes.length, processes };
};

const observeLockActivity = (lockDir, fileSystem = fs) => {
  try {
    const candidates = [fileSystem.lstatSync(lockDir).mtimeMs];
    for (const entry of fileSystem.readdirSync(lockDir, { withFileTypes: true })) {
      try {
        candidates.push(fileSystem.lstatSync(path.join(lockDir, entry.name)).mtimeMs);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const observedAtMs = Math.max(...candidates.filter(Number.isFinite));
    return Number.isFinite(observedAtMs)
      ? { status: "ok", observedAtMs }
      : { status: "unknown", observedAtMs: null, reason: "lock-observation-clock-missing" };
  } catch (error) {
    return {
      status: error?.code === "ENOENT" ? "missing" : "unknown",
      observedAtMs: null,
      reason: error?.code === "ENOENT" ? "lock-disappeared" : "lock-observation-failed"
    };
  }
};

const lockStatToken = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  mode: String(stat.mode),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
  birthtimeNs: String(stat.birthtimeNs),
  type: stat.isFile()
    ? "file"
    : stat.isDirectory()
      ? "directory"
      : stat.isSymbolicLink()
        ? "symlink"
        : "other"
});

const lockStatObservedAtMs = (stat) => {
  const nanoseconds = Number(stat.mtimeNs);
  return Number.isFinite(nanoseconds) ? nanoseconds / 1_000_000 : null;
};

const captureLockSnapshot = (lockDir, fileSystem = fs) => {
  const ownerName = "owner.json";
  const maxDirectFileBytes = 1024 * 1024;
  try {
    const rootBefore = fileSystem.lstatSync(lockDir, { bigint: true });
    if (!rootBefore.isDirectory()) {
      return { status: "unknown", reason: "lock-snapshot-root-not-directory" };
    }
    const entries = [];
    let ownerRaw = null;
    for (const entry of fileSystem.readdirSync(lockDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(lockDir, entry.name);
      const stat = fileSystem.lstatSync(entryPath, { bigint: true });
      const entryToken = {
        name: entry.name,
        stat: lockStatToken(stat),
        contentSha256: null,
        symlinkTarget: null
      };
      if (stat.isFile()) {
        if (stat.size > BigInt(maxDirectFileBytes)) {
          return { status: "unknown", reason: "lock-snapshot-entry-too-large" };
        }
        const raw = fileSystem.readFileSync(entryPath);
        entryToken.contentSha256 = crypto.createHash("sha256").update(raw).digest("hex");
        if (entry.name === ownerName) ownerRaw = Buffer.from(raw);
      } else if (stat.isSymbolicLink()) {
        entryToken.symlinkTarget = String(fileSystem.readlinkSync(entryPath));
        if (entry.name === ownerName) {
          const raw = fileSystem.readFileSync(entryPath);
          if (raw.length > maxDirectFileBytes) {
            return { status: "unknown", reason: "lock-snapshot-owner-too-large" };
          }
          ownerRaw = Buffer.from(raw);
          entryToken.contentSha256 = crypto.createHash("sha256").update(raw).digest("hex");
        }
      }
      entries.push(entryToken);
    }
    const rootAfter = fileSystem.lstatSync(lockDir, { bigint: true });
    const rootBeforeToken = lockStatToken(rootBefore);
    const rootAfterToken = lockStatToken(rootAfter);
    if (stableStringify(rootBeforeToken) !== stableStringify(rootAfterToken)) {
      return { status: "unknown", reason: "lock-snapshot-mutated-during-capture" };
    }
    const observedAtCandidates = [
      lockStatObservedAtMs(rootAfter),
      ...entries.map((entry) => Number(entry.stat.mtimeNs) / 1_000_000)
    ].filter(Number.isFinite);
    const observationToken = crypto.createHash("sha256").update(stableStringify({
      root: rootAfterToken,
      entries
    })).digest("hex");
    return {
      status: "ok",
      ownerState: ownerRaw == null ? "missing" : "present",
      ownerRaw,
      ownerSha256: ownerRaw == null
        ? null
        : crypto.createHash("sha256").update(ownerRaw).digest("hex"),
      observationToken,
      observedAtMs: observedAtCandidates.length ? Math.max(...observedAtCandidates) : null
    };
  } catch (error) {
    return {
      status: error?.code === "ENOENT" ? "missing" : "unknown",
      reason: error?.code === "ENOENT" ? "lock-snapshot-disappeared" : "lock-snapshot-failed",
      errorCode: error?.code || null
    };
  }
};

const sameLockSnapshot = (expected, actual) => Boolean(
  expected?.status === "ok"
  && actual?.status === "ok"
  && expected.ownerState === actual.ownerState
  && expected.observationToken === actual.observationToken
  && (
    expected.ownerState === "missing"
    || (
      Buffer.isBuffer(expected.ownerRaw)
      && Buffer.isBuffer(actual.ownerRaw)
      && expected.ownerRaw.equals(actual.ownerRaw)
    )
  )
);

const parseSnapshotOwner = (snapshot) => {
  if (snapshot?.ownerState !== "present" || !Buffer.isBuffer(snapshot.ownerRaw)) return null;
  try { return JSON.parse(snapshot.ownerRaw.toString("utf8")); } catch { return null; }
};

const restoreQuarantinedLock = ({ quarantinePath, lockDir }) => {
  try {
    fs.lstatSync(lockDir);
    return {
      restored: false,
      retained: true,
      reason: "lock-replacement-already-exists"
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        restored: false,
        retained: true,
        reason: "lock-replacement-state-unknown",
        errorCode: error?.code || null
      };
    }
  }
  try {
    // Same-parent rename is the atomic restoration operation. If another
    // contender creates lockDir first, rename fails closed and quarantine is
    // retained; the destination is never deliberately removed or replaced.
    fs.renameSync(quarantinePath, lockDir);
    return { restored: true, retained: false, reason: "quarantine-restored" };
  } catch (error) {
    let destinationExists = false;
    try {
      fs.lstatSync(lockDir);
      destinationExists = true;
    } catch {}
    return {
      restored: false,
      retained: true,
      reason: destinationExists ? "lock-replacement-won-restore-race" : "quarantine-restore-failed",
      errorCode: error?.code || null
    };
  }
};

const evaluateLockOwner = ({
  owner,
  identity,
  runnerScan = null,
  expectedRoot = rootDir,
  leaseMs = 10 * 60_000,
  nowMs = Date.now(),
  lockObservedAtMs = null,
  platform = process.platform
}) => {
  const updatedMs = Date.parse(owner?.updatedAt || "");
  const safeLeaseMs = finiteNumber(leaseMs, 10 * 60_000, {
    min: 60_000,
    max: 24 * 60 * 60_000,
    integer: true
  });
  const observedLockMs = lockObservedAtMs == null ? Number.NaN : Number(lockObservedAtMs);
  const observationClocks = [updatedMs, observedLockMs].filter(Number.isFinite);
  const observedAtMs = observationClocks.length ? Math.max(...observationClocks) : null;
  const leaseExpired = Number.isFinite(observedAtMs)
    && nowMs >= observedAtMs
    && nowMs - observedAtMs >= safeLeaseMs;
  const ownerPid = Number(owner?.pid);
  const ownerRootMatches = typeof owner?.root === "string"
    && normalizeIdentityPath(owner.root, platform) === normalizeIdentityPath(expectedRoot, platform);
  const ownerCommandValid = typeof owner?.command === "string"
    && owner.command.length > 0
    && commandSignature(owner.command) === owner.commandSignature;
  const ownerValid = owner?.version === 2
    && Number.isInteger(ownerPid)
    && ownerPid > 0
    && ownerRootMatches
    && typeof owner?.processStartKey === "string"
    && owner.processStartKey.length > 0
    && ownerCommandValid
    && commandLooksLikeRunner(owner.command);
  if (!ownerValid) {
    if (!leaseExpired) {
      return {
        action: "fail",
        reason: "lock-owner-record-invalid-unexpired",
        unsafe: true,
        leaseExpired,
        observedAtMs
      };
    }
    const identityCwdMatches = identity?.cwd
      ? normalizeIdentityPath(identity.cwd, platform) === normalizeIdentityPath(expectedRoot, platform)
      : null;
    const identityIsRunner = identity?.status === "ok"
      && identity.exists === true
      && commandLooksLikeRunner(identity.command)
      && identityCwdMatches !== false;
    if (identityIsRunner) {
      return {
        action: "fail",
        reason: "expired-orphan-live-runner-active",
        unsafe: true,
        leaseExpired,
        observedAtMs
      };
    }
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      if (identity?.status !== "ok") {
        return {
          action: "fail",
          reason: identity?.reason || "expired-orphan-owner-process-unknown",
          unsafe: true,
          leaseExpired,
          observedAtMs
        };
      }
      return {
        action: "reclaim",
        reason: identity.exists === false
          ? "expired-orphan-owner-process-dead"
          : "expired-orphan-owner-is-confirmed-non-runner",
        unsafe: false,
        leaseExpired,
        observedAtMs
      };
    }
    if (runnerScan?.status !== "ok") {
      return {
        action: "fail",
        reason: runnerScan?.reason || "expired-orphan-runner-scan-required",
        unsafe: true,
        leaseExpired,
        observedAtMs,
        runnerScanRequired: runnerScan == null
      };
    }
    if (Number(runnerScan.liveRunnerCount) > 0) {
      return {
        action: "fail",
        reason: "expired-orphan-live-runner-active",
        unsafe: true,
        leaseExpired,
        observedAtMs,
        liveRunnerCount: Number(runnerScan.liveRunnerCount)
      };
    }
    return {
      action: "reclaim",
      reason: "expired-orphan-no-live-runner",
      unsafe: false,
      leaseExpired,
      observedAtMs
    };
  }
  if (identity?.status === "ok" && identity.exists === false) {
    return leaseExpired
      ? { action: "reclaim", reason: "expired-owner-process-dead", unsafe: false, leaseExpired, observedAtMs }
      : {
        action: "fail",
        reason: "owner-process-dead-lease-not-expired",
        unsafe: true,
        leaseExpired,
        observedAtMs
      };
  }
  if (identity?.status !== "ok" || identity.exists !== true || !identity.startKey || !identity.command) {
    return {
      action: "fail",
      reason: identity?.reason || "lock-owner-process-unknown",
      unsafe: true,
      leaseExpired,
      observedAtMs
    };
  }
  const sameStart = String(identity.startKey) === owner.processStartKey;
  const sameCommand = commandSignature(identity.command) === owner.commandSignature;
  const actualLooksRunner = commandLooksLikeRunner(identity.command);
  const actualCwdMatches = identity.cwd
    ? normalizeIdentityPath(identity.cwd, platform) === normalizeIdentityPath(expectedRoot, platform)
    : null;
  if (sameStart && sameCommand && actualLooksRunner && actualCwdMatches !== false) {
    return { action: "already-running", reason: "verified-runner-active", unsafe: false, leaseExpired, observedAtMs };
  }
  const confirmedNonRunner = !actualLooksRunner || actualCwdMatches === false;
  if (confirmedNonRunner && leaseExpired) {
    return {
      action: "reclaim",
      reason: "expired-lock-owned-by-confirmed-non-runner",
      unsafe: false,
      leaseExpired,
      observedAtMs
    };
  }
  return {
    action: "fail",
    reason: confirmedNonRunner ? "live-non-runner-lock-not-expired" : "live-runner-identity-mismatch",
    unsafe: true,
    leaseExpired,
    observedAtMs,
    pidReuseSuspected: !sameStart
  };
};

const acquireInstanceLock = ({
  lockDir,
  leaseMs = 10 * 60_000,
  now = () => Date.now(),
  inspect = inspectProcessIdentity,
  scanRunners = inspectRunnerProcesses,
  observeLock = observeLockActivity,
  captureLock = captureLockSnapshot,
  writeAtomic = writeJsonAtomic,
  hooks = null,
  expectedRoot = rootDir,
  platform = process.platform
}) => {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const instanceId = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const ownerPath = path.join(lockDir, "owner.json");
  const currentIdentity = inspect(process.pid, { platform });
  if (currentIdentity?.status !== "ok"
    || currentIdentity.exists !== true
    || !currentIdentity.startKey
    || !currentIdentity.command
    || !commandLooksLikeRunner(currentIdentity.command)) {
    return {
      acquired: false,
      unsafe: true,
      reason: currentIdentity?.reason || "self-process-identity-unavailable"
    };
  }
  const ownerPayload = () => ({
    version: 2,
    instanceId,
    pid: process.pid,
    root: path.resolve(expectedRoot),
    runnerScript: runnerScriptPath,
    processStartKey: String(currentIdentity.startKey),
    command: normalizeCommand(currentIdentity.command),
    commandSignature: commandSignature(currentIdentity.command),
    updatedAt: new Date(now()).toISOString()
  });
  const writeOwnerAt = (targetPath) => writeAtomic(targetPath, ownerPayload());
  const writeOwner = () => writeOwnerAt(ownerPath);
  const tryCreate = () => {
    const resolvedLockDir = path.resolve(lockDir);
    const lockParent = path.dirname(resolvedLockDir);
    const lockBase = path.basename(resolvedLockDir);
    const candidatePath = path.join(
      lockParent,
      `${lockBase}.candidate-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    );
    const candidateIsSafeSibling = path.dirname(candidatePath) === lockParent
      && path.basename(candidatePath).startsWith(`${lockBase}.candidate-`);
    if (!candidateIsSafeSibling) throw new Error("lock-candidate-path-unsafe");
    let directoryCreated = false;
    let ownerWriteAttempted = false;
    let ownerWritten = false;
    let published = false;
    const cleanupCandidate = () => {
      const entries = fs.readdirSync(candidatePath, { withFileTypes: true });
      for (const entry of entries) {
        const ownedEntry = entry.name === "owner.json"
          || (entry.name.startsWith("owner.json.") && entry.name.endsWith(".tmp"));
        if (!ownedEntry || entry.isDirectory()) throw new Error("lock-candidate-unexpected-entry");
        fs.rmSync(path.join(candidatePath, entry.name), { force: true });
      }
      fs.rmdirSync(candidatePath);
    };
    try {
      fs.mkdirSync(candidatePath);
      directoryCreated = true;
      ownerWriteAttempted = true;
      writeOwnerAt(path.join(candidatePath, "owner.json"));
      ownerWritten = true;
      try {
        try {
          fs.lstatSync(lockDir);
          const collision = new Error("lock-publish-destination-exists");
          collision.code = "EEXIST";
          collision.fastResultLockPublishCollision = true;
          throw collision;
        } catch (destinationError) {
          if (destinationError?.code !== "ENOENT") throw destinationError;
        }
        // Publish a complete, non-empty lock in one rename. A concurrent
        // restore can therefore never replace an empty in-progress lock.
        fs.renameSync(candidatePath, lockDir);
        published = true;
      } catch (publishError) {
        let destinationExists = false;
        try {
          fs.lstatSync(lockDir);
          destinationExists = true;
        } catch {}
        if (destinationExists) {
          publishError.fastResultLockPublishCollision = true;
          publishError.fastResultOriginalCode = publishError.code || null;
          publishError.code = "EEXIST";
        }
        throw publishError;
      }
    } catch (rawError) {
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));
      if (directoryCreated && !published) {
        try {
          // Only the known owner record and its atomic temp name may be
          // removed. Any unexpected entry leaves the candidate isolated.
          cleanupCandidate();
          error.fastResultNewLockDirectoryCleaned = true;
        } catch (cleanupError) {
          error.fastResultNewLockDirectoryCleaned = false;
          error.fastResultLockCleanupFailed = cleanupError?.code || "unknown";
        }
      }
      if (ownerWriteAttempted && !ownerWritten) error.fastResultOwnerWriteFailed = true;
      if (!directoryCreated && error?.code === "EEXIST") error.fastResultCandidateCreateFailed = true;
      throw error;
    }
  };
  let created = false;
  let quarantineCleanupFailed = null;
  try {
    tryCreate();
    created = true;
  } catch (error) {
    if (error?.fastResultOwnerWriteFailed === true) throw error;
    if (error?.fastResultCandidateCreateFailed === true) throw error;
    if (error?.code !== "EEXIST") throw error;
    const decisionSnapshot = captureLock(lockDir);
    if (decisionSnapshot?.status !== "ok") {
      return {
        acquired: false,
        unsafe: true,
        reason: decisionSnapshot?.reason || "lock-decision-snapshot-unavailable"
      };
    }
    const owner = parseSnapshotOwner(decisionSnapshot);
    const ownerIdentity = inspect(owner?.pid, { platform });
    const observation = observeLock(lockDir);
    const decisionInput = {
      owner,
      identity: ownerIdentity,
      expectedRoot,
      leaseMs,
      nowMs: now(),
      lockObservedAtMs: observation?.status === "ok" ? observation.observedAtMs : null,
      platform
    };
    let decision = evaluateLockOwner(decisionInput);
    if (decision.runnerScanRequired === true) {
      let runnerScan;
      try {
        runnerScan = scanRunners({
          platform,
          expectedRoot,
          inspect,
          excludePid: process.pid
        });
      } catch (scanError) {
        runnerScan = {
          status: "unknown",
          liveRunnerCount: null,
          reason: scanError?.code || scanError?.message || "runner-scan-failed"
        };
      }
      decision = evaluateLockOwner({ ...decisionInput, runnerScan });
    }
    if (decision.action === "already-running") {
      return {
        acquired: false,
        unsafe: false,
        reason: decision.reason,
        owner: { pid: Number(owner?.pid || 0), updatedAt: owner?.updatedAt || null }
      };
    }
    if (decision.action !== "reclaim") {
      return {
        acquired: false,
        unsafe: true,
        reason: decision.reason,
        pidReuseSuspected: decision.pidReuseSuspected === true,
        owner: owner ? { pid: Number(owner.pid || 0), updatedAt: owner.updatedAt || null } : null
      };
    }
    const resolvedLockDir = path.resolve(lockDir);
    const lockParent = path.dirname(resolvedLockDir);
    const lockBase = path.basename(resolvedLockDir);
    const quarantinePath = path.join(
      lockParent,
      `${lockBase}.quarantine-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    );
    const quarantineIsSafeSibling = path.dirname(quarantinePath) === lockParent
      && path.basename(quarantinePath).startsWith(`${lockBase}.quarantine-`);
    if (!quarantineIsSafeSibling) {
      return { acquired: false, unsafe: true, reason: "lock-quarantine-path-unsafe" };
    }
    let quarantined = false;
    try {
      // Atomic same-parent rename prevents a second contender from observing a
      // half-deleted lock. The quarantined directory is only removed after the
      // replacement owner record has committed successfully.
      if (typeof hooks?.beforeQuarantineRename === "function") {
        hooks.beforeQuarantineRename({ lockDir, quarantinePath, decisionSnapshot });
      }
      fs.renameSync(lockDir, quarantinePath);
      quarantined = true;
      const quarantinedSnapshot = captureLock(quarantinePath);
      if (!sameLockSnapshot(decisionSnapshot, quarantinedSnapshot)) {
        if (typeof hooks?.beforeSnapshotMismatchRestore === "function") {
          hooks.beforeSnapshotMismatchRestore({
            lockDir,
            quarantinePath,
            decisionSnapshot,
            quarantinedSnapshot
          });
        }
        const restoration = restoreQuarantinedLock({ quarantinePath, lockDir });
        if (restoration.restored) quarantined = false;
        return {
          acquired: false,
          unsafe: true,
          reason: "lock-snapshot-changed-before-quarantine",
          snapshotExpectedOwnerState: decisionSnapshot.ownerState,
          snapshotActualOwnerState: quarantinedSnapshot?.ownerState || null,
          snapshotRestoreReason: restoration.reason,
          quarantineRestored: restoration.restored,
          quarantineRetained: restoration.retained,
          quarantineRestoreFailed: restoration.errorCode || null
        };
      }
      try {
        tryCreate();
        created = true;
      } catch (createError) {
        const restoration = restoreQuarantinedLock({ quarantinePath, lockDir });
        if (restoration.restored) quarantined = false;
        if (!restoration.restored) {
          createError.fastResultQuarantineRestoreFailed = restoration.errorCode || restoration.reason;
        }
        throw createError;
      }
      try {
        fs.rmSync(quarantinePath, { recursive: true, force: true });
      } catch (cleanupError) {
        quarantineCleanupFailed = cleanupError?.code || "unknown";
      }
    } catch (reclaimError) {
      return {
        acquired: false,
        unsafe: true,
        reason: "lock-reclaim-failed",
        reclaimFailed: reclaimError?.code || "unknown",
        quarantineRestoreFailed: reclaimError?.fastResultQuarantineRestoreFailed || null,
        quarantined
      };
    }
  }
  if (!created) return { acquired: false, unsafe: true, reason: "lock-create-failed" };
  const release = () => {
    const owner = readJsonSafe(ownerPath, null);
    if (owner?.instanceId !== instanceId
      || owner?.processStartKey !== currentIdentity.startKey
      || owner?.commandSignature !== commandSignature(currentIdentity.command)) return false;
    const releasePath = `${lockDir}.release-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(lockDir, releasePath);
      fs.rmSync(releasePath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  return {
    acquired: true,
    instanceId,
    quarantineCleanupFailed,
    heartbeat: writeOwner,
    release
  };
};

const cleanupFiles = async (paths) => {
  await Promise.all(paths.map((filePath) => fsp.rm(filePath, { force: true }).catch(() => {})));
};

module.exports = {
  acquireInstanceLock,
  assertSafeUploadUrl,
  captureLockSnapshot,
  classifyFailure,
  cleanupFiles,
  commandSignature,
  compactFingerprint,
  computeBackoffMs,
  computeFailureBackoffMs,
  computeDelayFromCompletion,
  createFastUploadSnapshot,
  evaluateLockOwner,
  finiteNumber,
  fastLanePublishDecision,
  inspectProcessIdentity,
  inspectRunnerProcesses,
  observeLockActivity,
  postSnapshot,
  postSnapshotOverSsh,
  readJsonSafe,
  resultFingerprint,
  resultObservationRows,
  resultPageOneEndpoint,
  rootDir,
  rowsInRelayPayload,
  runCollector,
  safeFailure,
  sameLockSnapshot,
  stableStringify,
  usableEndpoint,
  writeJsonAtomic
};
