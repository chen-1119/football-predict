"use strict";

// One bounded operator job, not a daemon, cron job, or a privileged entrypoint.
// Start as ubuntu under nohup/setsid with redirected stdio if SSH may disconnect.
// This survives an ordinary disconnect, not a server reboot or session cgroup kill.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const VERSION = "server-release-queue-v1";
const POLL_MS = 60_000;
const MAX_QUEUE_TTL_MS = 48 * 60 * 60_000;
const MAX_OBSERVE_MS = 4 * 60 * 60_000;
const RELEASE_HORIZON_SECONDS = 7620;
const DEFAULT_PREPARATION_SECONDS = 900;
const FIXED = Object.freeze({
  app: "/opt/football-predict",
  store: "/var/lib/football-predict",
  incoming: "/var/lib/football-release/incoming",
  status: "/var/lib/football-release/status",
  publicKey: "/etc/football-release/signing-public.pem",
  entrypoint: "/usr/local/sbin/football-release",
  sudo: "/usr/bin/sudo",
  home: "/home/ubuntu",
  state: "/home/ubuntu/.local/state/football-release-queue",
});
const SHA = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(["completed", "failed", "expired"]);
class QueueError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new QueueError(code); };
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const canonicalTime = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || iso(ms) !== value) fail("invalid-canonical-time");
  return ms;
};
const parseOptions = (argv, now = Date.now()) => {
  const allowed = new Set(["--sha", "--not-before", "--expires-at", "--prepare-margin-seconds"]);
  const fields = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || argv[i + 1] === undefined || fields[argv[i]] !== undefined) fail("invalid-arguments");
    fields[argv[i]] = argv[i + 1];
  }
  const sha = fields["--sha"];
  if (typeof sha !== "string" || !SHA.test(sha)) fail("invalid-bundle-sha");
  const expiresAtMs = canonicalTime(fields["--expires-at"]);
  if (expiresAtMs <= now || expiresAtMs - now > MAX_QUEUE_TTL_MS) fail("invalid-queue-ttl");
  const notBeforeMs = canonicalTime(fields["--not-before"]);
  if (notBeforeMs <= now || notBeforeMs >= expiresAtMs) fail("invalid-not-before");
  const rawMargin = fields["--prepare-margin-seconds"] || String(DEFAULT_PREPARATION_SECONDS);
  if (!/^[1-9][0-9]*$/.test(rawMargin)) fail("invalid-preparation-margin");
  const preparationSeconds = Number(rawMargin);
  if (!Number.isSafeInteger(preparationSeconds) || preparationSeconds < 900 || preparationSeconds > 7200) fail("invalid-preparation-margin");
  return Object.freeze({ sha, notBeforeMs, expiresAtMs, preparationSeconds, createdAtMs: now });
};
const assertRunner = (identity, platform) => {
  if (platform !== "linux" || identity.uid <= 0 || identity.username !== "ubuntu" || identity.homedir !== FIXED.home) fail("runner-must-be-nonroot-ubuntu");
};
const assertRegular = (file, maxBytes, owner = null) => {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes || info.size < 1
    || (process.platform !== "win32" && (info.mode & 0o022) !== 0) || (owner !== null && info.uid !== owner)) fail("unsafe-input-file");
  return info;
};
const regularBytes = (file, maxBytes, owner = null) => {
  const before = assertRegular(file, maxBytes, owner);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail("input-file-changed");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("input-file-changed");
    return bytes;
  } finally { fs.closeSync(fd); }
};
const regularJson = (file, maxBytes, owner = null) => JSON.parse(regularBytes(file, maxBytes, owner));
const assertDirectory = (directory, owner = null) => {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o022) !== 0)
    || (owner !== null && info.uid !== owner)) fail("unsafe-directory");
  return info;
};

// Only the current fixture file is read/hash-checked, not the 400MB snapshot
// corpus. The immutable manifest digest and a second pointer read bind it.
const inspectGenerationDocuments = ({ pointer, manifest, currentBytes, pointerAfter, stableStringify }) => {
  if (pointer?.schemaVersion !== 1 || !SHA.test(pointer.manifestHash || "")
    || pointer.generationId !== `g-${pointer.manifestHash}` || !pointer.sourceCycleId
    || !Number.isFinite(Date.parse(pointer.committedAt || ""))) fail("invalid-generation-pointer");
  const projection = { schemaVersion: manifest?.schemaVersion, sourceCycleId: manifest?.sourceCycleId,
    coreFiles: manifest?.coreFiles, files: manifest?.files };
  if (digest(stableStringify(projection)) !== pointer.manifestHash
    || manifest.manifestHash !== pointer.manifestHash || manifest.generationId !== pointer.generationId
    || manifest.sourceCycleId !== pointer.sourceCycleId || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.coreFiles)) fail("invalid-generation-manifest");
  const entries = manifest.files.filter((row) => row?.path === "matches-current.json");
  const entry = entries[0];
  if (entries.length !== 1 || entry.core !== true || !manifest.coreFiles.includes("matches-current.json")
    || entry.bytes !== currentBytes.length || entry.sha256 !== digest(currentBytes)) fail("current-generation-file-mismatch");
  for (const name of ["generationId", "manifestHash", "sourceCycleId", "committedAt"]) {
    if (pointer[name] !== pointerAfter?.[name]) fail("generation-changed-during-probe");
  }
  const payload = JSON.parse(currentBytes);
  const rows = Array.isArray(payload) ? payload : payload?.matches || payload?.rows;
  if (!Array.isArray(rows) || rows.length === 0) fail("current-match-inventory-unavailable");
  return { payload, generationId: pointer.generationId };
};
const probeWindow = (input, options, now, createTransitionLease) => {
  try {
    const lease = createTransitionLease(input.payload, {
      refreshAt: iso(now), verifierRuntimeMaxSeconds: 900,
      preverifyRefreshBudgetSeconds: 6690 + options.preparationSeconds,
      atomicSwapMarginSeconds: 30,
    });
    if (lease.minimumHorizonSeconds !== RELEASE_HORIZON_SECONDS + options.preparationSeconds) fail("queue-budget-mismatch");
    return { safe: true, generationId: input.generationId, minimumHorizonSeconds: lease.minimumHorizonSeconds,
      nextTransition: lease.nextTransition, availableHorizonSeconds: lease.availableHorizonSeconds };
  } catch (error) {
    if (error?.message === "candidate transition horizon is too short") {
      return { safe: false, reason: "transition-window-closed", generationId: input.generationId,
        minimumHorizonSeconds: RELEASE_HORIZON_SECONDS + options.preparationSeconds,
        nextTransition: error.details?.nextTransition || null,
        nextSafeWindow: error.details?.nextSafeWindow?.refreshStrictlyAfter || null };
    }
    throw error;
  }
};
const fixedLaunchSpec = (sha) => {
  if (!SHA.test(sha)) fail("invalid-bundle-sha");
  return { command: FIXED.sudo, args: ["-n", FIXED.entrypoint, sha], options: {
    detached: true, shell: false, stdio: ["ignore", "ignore", "ignore"],
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: FIXED.home, LANG: "C.UTF-8" },
  } };
};

// Dependencies keep the finite state machine testable without sudo or sleeps.
const runQueue = async (options, runtime) => {
  let state = runtime.previous || null;
  if (state && (state.attempted === true || TERMINAL.has(state.state))) fail("queue-already-attempted-or-terminal");
  let attempted = false;
  let launchAtMs = null;
  let childPid = null;
  let lastLog = null;
  const publish = (name, reason, evidence = {}) => {
    state = { version: VERSION, bundleSha256: options.sha, state: name, reason, attempted,
      pid: runtime.pid, childPid, createdAt: iso(options.createdAtMs), updatedAt: iso(runtime.now()),
      expiresAt: iso(options.expiresAtMs), launchAt: launchAtMs === null ? null : iso(launchAtMs),
      scheduledAt: iso(options.notBeforeMs), windowPreauthorized: false,
      windowAuthority: "signed-entrypoint-early-and-final-transition-gates",
      releaseHorizonSeconds: RELEASE_HORIZON_SECONDS, preparationSeconds: options.preparationSeconds,
      ...evidence };
    runtime.write(state); // Durable starting/attempted record MUST precede spawn.
    const logKey = JSON.stringify([name, reason, evidence.nextTransition, evidence.nextSafeWindow]);
    if (logKey !== lastLog) {
      runtime.log({ state: name, reason, at: state.updatedAt, bundleSha256: options.sha });
      lastLog = logKey;
    }
  };
  try {
    const initial = runtime.validateBundle();
    if (options.expiresAtMs > initial.expiresAtMs) fail("queue-outlives-signed-manifest");
    while (!attempted) {
      if (runtime.cancelled()) { publish("failed", "queue-cancelled-before-launch"); return state; }
      if (runtime.now() >= options.expiresAtMs) { publish("expired", "queue-deadline-reached"); return state; }
      if (runtime.now() < options.notBeforeMs) {
        publish("waiting-not-before", "scheduled-time-only-no-live-window-proof");
        await runtime.wait(Math.min(POLL_MS, options.notBeforeMs - runtime.now(), options.expiresAtMs - runtime.now()));
        continue;
      }
      const latest = runtime.validateBundle();
      if (latest.identity !== initial.identity) fail("signed-bundle-changed-while-waiting");
      // The non-root uploader cannot read the private generation. A scheduled
      // instant is NOT a live window proof: only the signed root entrypoint's
      // early probe and final lease/CAS may authorize the actual cutover.
      if (runtime.now() >= options.expiresAtMs) { publish("expired", "queue-deadline-reached"); return state; }
      if (runtime.cancelled()) { publish("failed", "queue-cancelled-before-launch"); return state; }
      attempted = true;
      launchAtMs = runtime.now();
      publish("starting", "scheduled-single-attempt-window-not-preauthorized");
      childPid = runtime.launch(options.sha);
      publish("running", "signed-entrypoint-running");
    }
    for (;;) {
      const observation = runtime.observe(launchAtMs);
      if (observation.complete === true) { publish("completed", "signed-release-complete"); return state; }
      if (observation.failed === true) { publish("failed", observation.reason || "signed-release-failed"); return state; }
      if (runtime.cancelled()) { publish("failed", "observer-stopped-deployment-may-still-be-running"); return state; }
      if (runtime.now() >= launchAtMs + MAX_OBSERVE_MS) { publish("failed", "observer-deadline-deployment-may-still-be-running"); return state; }
      await runtime.wait(POLL_MS);
    }
  } catch (error) {
    publish("failed", error instanceof QueueError ? error.code : "queue-operation-failed");
    return state;
  }
};

const createStateStore = (directory, sha, uid) => {
  if (!SHA.test(sha)) fail("invalid-bundle-sha");
  const directoryInfo = assertDirectory(directory, uid);
  if (process.platform !== "win32" && (directoryInfo.mode & 0o777) !== 0o700) fail("queue-state-directory-must-be-private");
  const output = path.join(directory, `${sha}.json`);
  return {
    read() { return fs.lstatSync(output, { throwIfNoEntry: false }) ? regularJson(output, 64 * 1024, uid) : null; },
    write(value) {
      assertDirectory(directory, uid);
      if (fs.lstatSync(output, { throwIfNoEntry: false })) assertRegular(output, 64 * 1024, uid);
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      if (bytes.length > 64 * 1024) fail("queue-state-too-large");
      const temporary = path.join(directory, `.${sha}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, output);
      if (process.platform !== "win32") {
        const directoryFd = fs.openSync(directory, "r");
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
    },
  };
};

const main = async (argv = process.argv.slice(2)) => {
  const identity = os.userInfo();
  assertRunner(identity, process.platform);
  const options = parseOptions(argv);
  for (const directory of ["/home", FIXED.home]) assertDirectory(directory);
  for (const directory of [path.join(FIXED.home, ".local"), path.join(FIXED.home, ".local/state"), FIXED.state]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    assertDirectory(directory, identity.uid);
  }
  const stateStore = createStateStore(FIXED.state, options.sha, identity.uid);
  const previous = stateStore.read();
  if (previous) fail("existing-queue-state-requires-operator-review");
  const lock = path.join(FIXED.state, `${options.sha}.lock`);
  fs.mkdirSync(lock, { mode: 0o700 }); // Never reclaim a pre-existing lock.
  const lockIdentity = fs.lstatSync(lock);
  let cancelled = false;
  let wake = null;
  const cancel = () => { cancelled = true; wake?.(); };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  process.on("SIGHUP", () => {});
  try {
    stateStore.write({ version: VERSION, bundleSha256: options.sha, state: "waiting-not-before",
      reason: "initializing-signed-bundle-validation", attempted: false, pid: process.pid,
      childPid: null, createdAt: iso(options.createdAtMs), updatedAt: iso(Date.now()),
      scheduledAt: iso(options.notBeforeMs), expiresAt: iso(options.expiresAtMs), windowPreauthorized: false });
    const signing = path.join(FIXED.app, "scripts/releaseSigning.cjs");
    for (const file of [signing, FIXED.entrypoint, FIXED.publicKey]) assertRegular(file, 2 * 1024 * 1024, 0);
    const { verifyManifestSignature } = require(signing);
    let childExit = null;
    const validateBundle = () => {
      assertDirectory(FIXED.incoming, identity.uid);
      const base = path.join(FIXED.incoming, options.sha);
      const files = { bundle: `${base}.tgz`, manifest: `${base}.manifest.json`, signature: `${base}.manifest.sig`, sidecar: `${base}.sha256` };
      assertRegular(files.bundle, 512 * 1024 * 1024, identity.uid);
      regularBytes(files.manifest, 1024 * 1024, identity.uid);
      regularBytes(files.signature, 16 * 1024, identity.uid);
      const sidecar = regularBytes(files.sidecar, 4096, identity.uid).toString("utf8").trim().split(/\s+/)[0];
      const checked = verifyManifestSignature({ manifestPath: files.manifest, signaturePath: files.signature, publicKeyPath: FIXED.publicKey });
      const manifest = checked.manifest;
      if (manifest.sha256 !== options.sha || sidecar !== options.sha || manifest.site !== "football-predict"
        || manifest.channel !== "production" || manifest.ok !== true || manifest.policyVersion !== "release-secret-policy-v2") fail("signed-bundle-identity-invalid");
      if (["sensitiveEntries", "blockedEntries", "missingEntries"].some((key) => !Array.isArray(manifest[key]) || manifest[key].length !== 0)) fail("signed-bundle-policy-invalid");
      const hash = crypto.createHash("sha256");
      const fd = fs.openSync(files.bundle, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const buffer = Buffer.alloc(1024 * 1024);
      let bytes = 0;
      try {
        for (;;) { const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break; bytes += size; hash.update(buffer.subarray(0, size)); }
      } finally { fs.closeSync(fd); }
      if (bytes !== manifest.bytes || hash.digest("hex") !== options.sha) fail("signed-bundle-content-invalid");
      return { identity: digest(checked.manifestBytes), expiresAtMs: canonicalTime(manifest.expiresAt) };
    };
    const runtime = {
      pid: process.pid, previous, now: Date.now, cancelled: () => cancelled,
      write: stateStore.write, log: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
      wait: (ms) => new Promise((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve(); }, Math.max(1, ms));
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      }),
      validateBundle,
      launch: (sha) => {
        const spec = fixedLaunchSpec(sha);
        const child = spawn(spec.command, spec.args, spec.options);
        child.on("error", () => { childExit = { failed: true, reason: "fixed-entrypoint-launch-failed" }; });
        child.on("exit", (code, signal) => { childExit = { code, signal }; });
        child.unref();
        return child.pid || null;
      },
      observe: (startedAtMs) => {
        let status = {};
        try {
          const text = regularBytes(path.join(FIXED.status, `${options.sha}.status`), 64 * 1024, 0).toString("utf8");
          status = Object.fromEntries(text.trim().split(/\r?\n/).filter((line) => /^[A-Za-z][A-Za-z0-9]*=/.test(line)).map((line) => {
            const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
          }));
        } catch { /* The entrypoint may not have created its status yet. */ }
        const fresh = status.bundleSha256 === options.sha && Date.parse(status.startedAt || "") >= startedAtMs - 1000;
        if (fresh && status.status === "failed") return { failed: true, reason: "signed-release-failed-no-retry" };
        if (fresh && status.status === "complete" && status.ok === "1" && status.exitCode === "0") {
          try {
            const marker = regularBytes(path.join(FIXED.app, ".release-bundle-sha256"), 4096, 0).toString("utf8").trim();
            const complete = regularBytes(path.join(FIXED.app, ".release-live-complete"), 4096, 0).toString("utf8").trim();
            if (marker === options.sha && complete === options.sha) return { complete: true };
          } catch { /* Missing proof must not be treated as completion. */ }
          return { failed: true, reason: "signed-release-marker-proof-missing" };
        }
        if (childExit) return { failed: true, reason: childExit.reason || "entrypoint-exited-without-complete-proof" };
        return { complete: false };
      },
    };
    const result = await runQueue(options, runtime);
    return result.state === "completed" ? 0 : 1;
  } catch (error) {
    const last = stateStore.read();
    stateStore.write({ ...last, state: "failed", updatedAt: iso(Date.now()),
      reason: error instanceof QueueError ? error.code : "queue-initialization-failed" });
    throw error;
  } finally {
    const current = fs.lstatSync(lock);
    if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino && !current.isSymbolicLink()) fs.rmdirSync(lock);
  }
};
if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ state: "failed", reason: error instanceof QueueError ? error.code : "queue-initialization-failed" })}\n`);
    process.exitCode = 1;
  });
}
module.exports = { VERSION, FIXED, POLL_MS, MAX_QUEUE_TTL_MS, MAX_OBSERVE_MS, RELEASE_HORIZON_SECONDS,
  QueueError, parseOptions, assertRunner, inspectGenerationDocuments, probeWindow, fixedLaunchSpec, runQueue, createStateStore };
