"use strict";

// Advisory preparation gate only. It cannot reserve a lease, spend a release
// sequence, start a queue, or authorize cutover. The signed server gates remain.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildPinnedSshBaseOptions, resolveReleaseSshHostKeyPin } = require("./releaseSshHostKeyPin.cjs");
const { inspectGenerationDocuments, probeWindow, RELEASE_HORIZON_SECONDS } = require("./queueServerRelease.cjs");
const { createTransitionLease } = require("./releaseTransitionLease.cjs");
const { stableStringify } = require("../server/dataGenerationStore.cjs");
const { LEGACY_UNACCEPTED } = require("./nativeReleaseJournal.cjs");

const PREPARATION_SECONDS = 900;
// Before-upload still needs its complete existing allowance. Before-build
// additionally reserves local verification/build/packaging time so spending it
// cannot consume the allowance required again by the later upload gate.
// This is advisory planning, not a timeout guarantee or reusable permission.
const BUILD_PREPARATION_SECONDS = 900;
const MAX_OBSERVATION_AGE_MS = 60_000;
function preparationBudget(stage) {
  assert.ok(stage === "before-build" || stage === "before-upload", "unknown release preparation stage");
  const buildPreparationSeconds = stage === "before-build" ? BUILD_PREPARATION_SECONDS : 0;
  return { stage, buildPreparationSeconds, uploadPreparationSeconds: PREPARATION_SECONDS,
    preparationSeconds: buildPreparationSeconds + PREPARATION_SECONDS };
}

// Sent as local reviewed source over pinned SSH. Only built-in Node modules are
// loaded remotely, never executable code from APP. Read current fixtures only,
// not the archive corpus, database, environment, credentials, or models.
function collectReleaseWindowObservation() {
  const fs = require("node:fs"), assert = require("node:assert/strict");
  let dataOwner = 0, dataGroup = 0;
  const trustedMetadata = info => info.uid === 0 ? info.gid === 0 && (info.mode & 0o022) === 0
    : info.uid === dataOwner && info.gid === dataGroup && (info.mode & 0o002) === 0;
  const read = (file, maxBytes, owner = null) => {
    const before = fs.lstatSync(file);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
      && before.size > 0 && before.size <= maxBytes && trustedMetadata(before)
      && (owner === null || before.uid === owner), "unsafe window input");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      assert.ok(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, "window input changed");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
        assert.ok(count > 0, "window input truncated"); offset += count;
      }
      assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, null), 0, "window input grew");
      const after = fs.fstatSync(fd);
      assert.ok(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, "window input changed");
      const current = fs.lstatSync(file);
      assert.ok(!current.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino
        && current.size === before.size && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs
        && current.uid === before.uid && current.gid === before.gid && current.mode === before.mode, "window input path changed");
      return bytes;
    } finally { fs.closeSync(fd); }
  };
  const root = "/var/lib/football-predict/data-generations";
  const app = "/opt/football-predict";
  // The worker's fixed data store may belong to football, not root. Trust only
  // that store owner (or root) below the non-writable, fixed parent chain.
  const storeStat = fs.lstatSync("/var/lib/football-predict");
  dataOwner = storeStat.uid; dataGroup = storeStat.gid;
  const directories = new Map();
  const inspectDirectory = (directory, runtime = false) => {
    const info = fs.lstatSync(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && fs.realpathSync(directory) === directory
      && trustedMetadata(info) && (!runtime || info.uid === 0), "unsafe window input directory");
    directories.set(directory, info);
  };
  for (const directory of ["/var", "/var/lib", "/var/lib/football-predict", root, root + "/generations", "/opt", app]) {
    inspectDirectory(directory, ["/var", "/var/lib", "/opt", app].includes(directory));
  }
  const marker = () => read(app + "/.release-bundle-sha256", 4096, 0).toString("utf8").trim();
  const complete = () => { try { return read(app + "/.release-live-complete", 4096, 0).toString("utf8").trim(); }
    catch (error) { if (error.code === "ENOENT") return "-"; throw error; } };
  const releaseMarker = marker(), liveComplete = complete();
  assert.match(releaseMarker, /^[a-f0-9]{64}$/);
  // This remote helper is advisory and has no source-tree dependencies. The
  // signed storage, allocation and recovery gates bind the exact exception.
  assert.ok(liveComplete === releaseMarker || liveComplete === "-", "runtime completion marker changed");
  const pointer = JSON.parse(read(root + "/current.json", 64 * 1024));
  assert.match(pointer.generationId || "", /^g-[a-f0-9]{64}$/);
  const directory = root + "/generations/" + pointer.generationId;
  inspectDirectory(directory);
  const manifest = JSON.parse(read(directory + "/manifest.json", 4 * 1024 * 1024));
  const currentBase64 = read(directory + "/matches-current.json", 32 * 1024 * 1024).toString("base64");
  const pointerAfter = JSON.parse(read(root + "/current.json", 64 * 1024));
  assert.equal(marker(), releaseMarker, "runtime changed during window probe");
  assert.equal(complete(), liveComplete, "acceptance changed during window probe");
  for (const [directory, before] of directories) {
    const after = fs.lstatSync(directory);
    assert.ok(after.isDirectory() && !after.isSymbolicLink() && fs.realpathSync(directory) === directory
      && after.dev === before.dev && after.ino === before.ino && after.uid === before.uid && after.gid === before.gid
      && after.mode === before.mode, "window directory changed");
  }
  return { version: "release-window-observation-v1", checkedAt: new Date().toISOString(),
    releaseMarker, liveComplete, pointer, pointerAfter, manifest, currentBase64, productionWrites: 0 };
}

const buildReadOnlyWindowProbe = () => `console.log(JSON.stringify((${collectReleaseWindowObservation.toString()})()));`;

function evaluateReleaseWindowObservation(observation, now = Date.now(), { stage = "before-build" } = {}) {
  const budget = preparationBudget(stage);
  assert.equal(observation?.version, "release-window-observation-v1");
  assert.equal(observation.productionWrites, 0);
  assert.match(observation.releaseMarker || "", /^[a-f0-9]{64}$/);
  const legacyUnaccepted = observation.liveComplete === "-";
  if (legacyUnaccepted) assert.equal(observation.releaseMarker, LEGACY_UNACCEPTED.bundleSha256, "unreviewed incomplete runtime");
  else assert.equal(observation.liveComplete, observation.releaseMarker);
  const age = now - Date.parse(observation.checkedAt);
  assert.ok(Number.isFinite(age) && age >= -5000 && age <= MAX_OBSERVATION_AGE_MS, "window observation expired or future-dated");
  const generationAge = now - Date.parse(observation.pointer?.committedAt);
  assert.ok(Number.isFinite(generationAge) && generationAge >= -5000, "window generation time invalid or future-dated");
  // A successful semantic no-op preserves this pointer and its committedAt.
  // Age is telemetry, not proof of a recent provider collection or a blocker.
  assert.ok(typeof observation.currentBase64 === "string" && observation.currentBase64.length <= Math.ceil(32 * 1024 * 1024 / 3) * 4, "window current payload unavailable or oversized");
  const currentBytes = Buffer.from(observation.currentBase64, "base64");
  assert.ok(currentBytes.length <= 32 * 1024 * 1024, "window current payload exceeds byte limit");
  assert.equal(currentBytes.toString("base64"), observation.currentBase64, "window current payload is not canonical base64");
  const input = inspectGenerationDocuments({ ...observation, currentBytes, stableStringify });
  // Keep the remote observation's next boundary even if a fast client clock
  // has already crossed it. Reserve transport/clock uncertainty instead of
  // rebuilding the projection at a later instant and silently dropping it.
  const observationReserveSeconds = Math.ceil(Math.max(0, age) / 1000) + 5;
  const proof = probeWindow(input, { preparationSeconds: budget.preparationSeconds + observationReserveSeconds },
    Date.parse(observation.checkedAt), createTransitionLease);
  const nextTransitionMs = Date.parse(proof.nextTransition);
  const latestStartBeforeNextTransition = Number.isFinite(nextTransitionMs)
    ? new Date(nextTransitionMs - proof.minimumHorizonSeconds * 1000).toISOString() : null;
  return { version: "release-window-preflight-v1", checkedAt: new Date(now).toISOString(), observationAt: observation.checkedAt,
    ok: proof.safe === true, ...proof, releaseMarker: observation.releaseMarker, legacyUnaccepted,
    sourceCycleId: observation.pointer.sourceCycleId, committedAt: observation.pointer.committedAt,
    releaseHorizonSeconds: RELEASE_HORIZON_SECONDS, ...budget,
    observationReserveSeconds, latestStartBeforeNextTransition,
    generationAgeMs: generationAge, providerFreshnessVerified: false,
    productionWrites: 0, readyToCutover: false, windowReserved: false,
    safeToStartPreparation: proof.safe === true, windowPreauthorized: false, leaseCreated: false,
    scope: "Preparation only; fresh signed early, candidate lease, and final cutover checks remain mandatory." };
}

function runLiveReleaseWindowPreflight({ stage = "before-build" } = {}) {
  preparationBudget(stage); // Reject typos before reading a key or making SSH calls.
  const rootDir = path.resolve(__dirname, ".."), tmpDir = path.join(rootDir, ".codex-tmp");
  const host = process.env.RELEASE_DEPLOY_HOST || "134.175.132.183", user = process.env.RELEASE_DEPLOY_USER || "ubuntu";
  assert.match(user, /^[a-z_][a-z0-9_-]*$/i);
  const port = Number(process.env.RELEASE_DEPLOY_PORT || 22);
  const keyPath = path.resolve(process.env.RELEASE_DEPLOY_KEY || path.join(tmpDir, "football.pem"));
  assert.ok(fs.statSync(keyPath).isFile());
  const pin = resolveReleaseSshHostKeyPin({ rootDir, tmpDir, host, port });
  const args = ["-p", String(port), ...buildPinnedSshBaseOptions({ keyPath, pin }), `${user}@${host}`,
    "sudo", "-n", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/opt/node-v22.22.1/bin/node", "-"];
  const child = spawnSync("ssh", args, { input: buildReadOnlyWindowProbe(), encoding: "utf8",
    windowsHide: true, timeout: 30_000, maxBuffer: 48 * 1024 * 1024 });
  // Do not echo remote stdout/stderr: stdout contains fixture data, not a report.
  if (child.status !== 0) throw new Error(`read-only release window observation failed (status=${Number.isInteger(child.status) ? child.status : "unknown"})`);
  return evaluateReleaseWindowObservation(JSON.parse(child.stdout), Date.now(), { stage });
}

module.exports = { PREPARATION_SECONDS, BUILD_PREPARATION_SECONDS, MAX_OBSERVATION_AGE_MS, preparationBudget,
  collectReleaseWindowObservation, buildReadOnlyWindowProbe, evaluateReleaseWindowObservation, runLiveReleaseWindowPreflight };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--stage"), "usage: runReleaseWindowPreflight.cjs [--stage before-build|before-upload]");
    const report = runLiveReleaseWindowPreflight({ stage: args[1] || "before-build" });
    console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
  }
  catch (error) { console.log(JSON.stringify({ ok: false, error: String(error.message).slice(0, 700), productionWrites: 0, readyToCutover: false })); process.exitCode = 1; }
}
