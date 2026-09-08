"use strict";

// Observation-only bridge. CLI failures must not change the release or recovery result.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const evidence = require("./releaseStageEvidence.cjs");
const VERSION = "release-stage-shell-bridge-v1", STORE_ROOT = "/var/lib/football-release/stages";
const SOURCE_FILES = Object.freeze(["scripts/releaseStageShellBridge.cjs", "scripts/releaseStageEvidence.cjs", "deploy/light-server/release-from-bundle.sh"]);
const PHASES = new Set(["candidate-build", "candidate-readiness", "official-prebuild-wait", "sqlite-prebuild", "stopped-window",
  "cutover", "postgres-projection", "worker-official-wait", "worker-enrichment-wait", "post-swap-readiness", "finalization"]);
const RECOVERY_PHASES = new Set(["prepared", "runtime-env-updating", "runtime-env-updated", "candidate-validated",
  "host-config-changing", "host-config-applied", "external-model-artifacts-snapshotted", "sqlite-snapshotted",
  "swap-starting", "swap-complete", "readiness-passed", "rollback-starting", "rolled-back", "finalizing", "committed"]);
const OUTCOMES = new Set(["ok", "error", "unknown"]), HASH = /^[a-f0-9]{64}$/;
function reject(code) { const error = new Error(code); error.code = code; throw error; }
function sequence(value) { if (!/^[1-9]\d{0,8}$/.test(String(value))) reject("invalid-sequence"); return Number(value); }
function assertProtectedDirectories(directory, expectedUid, boundary) {
  const resolved = path.resolve(directory), limit = path.resolve(boundary || path.parse(resolved).root);
  if (resolved !== limit && !resolved.startsWith(limit.endsWith(path.sep) ? limit : limit + path.sep)) reject("outside-trusted-boundary");
  for (let current = resolved; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current
      || (process.platform !== "win32" && (stat.uid !== expectedUid || (stat.mode & 0o022) !== 0))) reject("untrusted-source-directory");
    if (current === limit) break;
    if (path.dirname(current) === current) reject("unreachable-trusted-boundary");
  }
}
function sourceCommitment(sourceRoot, expectedUid, fixtureTrustBoundary) {
  const root = path.resolve(sourceRoot), digests = {};
  for (const relative of SOURCE_FILES) {
    const file = path.join(root, relative), parent = path.dirname(file);
    assertProtectedDirectories(parent, expectedUid, fixtureTrustBoundary);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024
      || (process.platform !== "win32" && (before.uid !== expectedUid || (before.mode & 0o022) !== 0))) reject("untrusted-source-file");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) reject("source-changed-during-open");
      const content = Buffer.alloc(stat.size); let offset = 0;
      while (offset < content.length) { const bytes = fs.readSync(fd, content, offset, content.length - offset, offset); if (!bytes) reject("short-source-read"); offset += bytes; }
      const after = fs.fstatSync(fd);
      if (content.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) reject("source-changed-during-read");
      digests[relative] = crypto.createHash("sha256").update(content).digest("hex");
    } finally { fs.closeSync(fd); }
  }
  return evidence.hash(digests);
}
function createBridge(options = {}) {
  // Only this library fixture surface permits other directories/UIDs. The CLI below
  // hardcodes root UID, Linux, fixed store, and its actual parent process.
  const storeRoot = path.resolve(options.storeRoot || STORE_ROOT), sourceRoot = path.resolve(options.sourceRoot || path.join(__dirname, ".."));
  const expectedUid = options.expectedUid ?? 0, controllerPid = options.controllerPid ?? process.ppid;
  const fixtureTrustBoundary = options.fixtureTrustBoundary;
  if ((options.requireLinux ?? true) && process.platform !== "linux") reject("linux-root-recorder-required");
  if (process.platform !== "win32" && process.getuid() !== expectedUid) reject("root-recorder-required");
  if (!path.isAbsolute(options.storeRoot || STORE_ROOT) || path.parse(storeRoot).root === storeRoot) reject("invalid-store-root");
  function identityPath(sha256) { if (!HASH.test(sha256)) reject("invalid-release-sha"); return path.join(storeRoot, "identities", sha256 + ".json"); }
  function controller() {
    if (process.platform === "linux" && fs.statSync("/proc/" + controllerPid).uid !== expectedUid) reject("untrusted-controller");
    const result = evidence.processIdentity(controllerPid);
    if (process.platform === "linux" && evidence.processAlive(result) !== true) reject("controller-not-live");
    return result;
  }
  function validateIdentity(record, sha256, releaseSequence, writable) {
    const { identityHash, ...body } = record;
    if (record.version !== VERSION || !HASH.test(identityHash) || evidence.hash(body) !== identityHash
      || record.release?.sha256 !== sha256 || record.release.sequence !== sequence(releaseSequence)
      || !HASH.test(record.sourceHash) || !record.controller || !record.initializedAt
      || new Date(Date.parse(record.initializedAt)).toISOString() !== record.initializedAt) reject("release-identity-mismatch");
    evidence.releaseIdentity(record.release);
    if (writable && (record.sourceRoot !== sourceRoot || record.sourceHash !== sourceCommitment(sourceRoot, expectedUid, fixtureTrustBoundary)
      || evidence.canonical(record.controller) !== evidence.canonical(controller()))) reject("release-input-or-controller-drift");
    return record;
  }
  function load(sha256, releaseSequence, writable = true) {
    assertProtectedDirectories(path.dirname(storeRoot), expectedUid, fixtureTrustBoundary);
    evidence.safeDirectory(storeRoot); evidence.safeDirectory(path.join(storeRoot, "identities"));
    return validateIdentity(JSON.parse(evidence.safeRead(identityPath(sha256), 8192)), sha256, releaseSequence, writable);
  }
  function context(record) { return { storeDir: storeRoot, release: record.release }; }
  function inputs(record) { return { bundle: record.release.sha256, source: record.sourceHash,
    run: evidence.hash(record.release), controller: evidence.hash(record.controller) }; }
  function journal(record) { return evidence.readJournal(context(record)); }
  function assertOpen(record) {
    const overall = journal(record).latest.get("release-observation");
    if (!overall || overall.end) reject("release-observation-already-closed");
  }
  function beginRecord(record, phase) {
    const prior = journal(record).latest.get(phase);
    if (prior && !prior.end) return prior.start;
    const attemptId = crypto.randomUUID();
    return evidence.recordCheckpoint({ ...context(record), inputIdentity: inputs(record), phase, attemptId,
      eventId: "begin-" + attemptId, boundary: "begin", category: phase.endsWith("-wait") ? "wait" : "work" });
  }
  function endRecord(record, phase, observedOutcome) {
    const prior = journal(record).latest.get(phase);
    if (!prior) reject("phase-observation-not-started");
    if (prior.end) { if (prior.end.observedOutcome !== observedOutcome) reject("conflicting-observation-outcome"); return prior.end; }
    return evidence.recordCheckpoint({ ...context(record), inputIdentity: inputs(record), phase, attemptId: prior.attemptId,
      eventId: "end-" + prior.attemptId, boundary: "end", observedOutcome });
  }
  function receipt(record, operation, phase = null) {
    return { version: VERSION, observationOk: true, operation, phase, release: record.release,
      evidenceKind: "checkpoint-observation", reusable: false, liveAcceptanceProven: false };
  }
  function init(sha256, releaseSequence) {
    identityPath(sha256); const releaseSeq = sequence(releaseSequence), controllerIdentity = controller();
    const sourceHash = sourceCommitment(sourceRoot, expectedUid, fixtureTrustBoundary);
    assertProtectedDirectories(path.dirname(storeRoot), expectedUid, fixtureTrustBoundary);
    evidence.safeDirectory(storeRoot, true); const identities = evidence.safeDirectory(path.join(storeRoot, "identities"), true);
    const lock = path.join(identities, sha256 + ".init-lock");
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") reject("identity-init-busy-or-interrupted"); throw error; }
    let record, temporary = null;
    try {
      try { record = load(sha256, releaseSeq); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (record) {
        try { if (journal(record).latest.get("release-observation")?.end) reject("release-observation-already-closed"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (!record) {
        const body = { version: VERSION, release: { sha256, sequence: releaseSeq, runId: crypto.randomUUID() },
          sourceRoot, sourceHash, controller: controllerIdentity, initializedAt: new Date().toISOString() };
        record = { ...body, identityHash: evidence.hash(body) };
        temporary = path.join(identities, ".identity-" + crypto.randomUUID() + ".tmp");
        const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        try { fs.writeFileSync(fd, evidence.canonical(record) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        // The exact-SHA init lock excludes other bridge writers. Never replace an existing identity.
        try { fs.lstatSync(identityPath(sha256)); reject("identity-appeared-during-init"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        fs.renameSync(temporary, identityPath(sha256)); temporary = null; evidence.syncDirectory(identities);
      }
      const attemptId = record.release.runId;
      evidence.recordCheckpoint({ ...context(record), inputIdentity: inputs(record), phase: "release-observation", attemptId,
        eventId: "run-open", boundary: "begin", category: "work" });
      return receipt(record, "init");
    } finally {
      if (temporary) fs.unlinkSync(temporary);
      fs.rmdirSync(lock); evidence.syncDirectory(identities);
    }
  }
  function begin(sha256, releaseSequence, phase) {
    if (!PHASES.has(phase)) reject("invalid-observed-phase"); const record = load(sha256, releaseSequence); assertOpen(record);
    beginRecord(record, phase); return receipt(record, "begin", phase);
  }
  function end(sha256, releaseSequence, phase, outcome) {
    if (!PHASES.has(phase) || !OUTCOMES.has(outcome)) reject("invalid-observed-phase-or-outcome");
    const record = load(sha256, releaseSequence); assertOpen(record); endRecord(record, phase, outcome); return receipt(record, "end", phase);
  }
  function recovery(sha256, releaseSequence, phase) {
    if (!RECOVERY_PHASES.has(phase)) reject("invalid-recovery-observation");
    const record = load(sha256, releaseSequence); assertOpen(record);
    for (const prior of journal(record).attempts.filter(a => a.phase.startsWith("recovery-") && !a.end)) {
      if (prior.phase === "recovery-" + phase) return receipt(record, "recovery", phase);
      endRecord(record, prior.phase, "unknown");
    }
    beginRecord(record, "recovery-" + phase); return receipt(record, "recovery", phase);
  }
  function finish(sha256, releaseSequence, outcome) {
    if (!OUTCOMES.has(outcome)) reject("invalid-final-observation"); const record = load(sha256, releaseSequence);
    // Close abandoned subspans as unknown, never convert them to successful work.
    for (const prior of journal(record).attempts.filter(a => a.phase !== "release-observation" && !a.end)) endRecord(record, prior.phase, "unknown");
    endRecord(record, "release-observation", outcome); return receipt(record, "finish");
  }
  function report(sha256, releaseSequence) {
    const record = load(sha256, releaseSequence, false);
    // Historical reads do not depend on a now-cleaned trusted source directory or a still-live controller.
    return { ...evidence.reportStages(context(record)), bridgeVersion: VERSION, observationOk: true };
  }
  return { init, begin, end, recovery, finish, report };
}
function main(argv = process.argv.slice(2)) {
  const operation = argv[0], emitWarning = () => {
    const warning = { version: VERSION, observationOk: false, operation: ["init", "begin", "end", "recovery", "finish", "report"].includes(operation) ? operation : "unknown",
      warning: "stage-telemetry-unavailable", releaseActionChanged: false, reusable: false, liveAcceptanceProven: false };
    (operation === "report" ? console.log : console.error)(JSON.stringify(warning)); return warning;
  };
  try {
    const lengths = { init: 4, begin: 4, end: 5, recovery: 4, finish: 4, report: 3 };
    if (!Object.hasOwn(lengths, operation) || argv.length !== lengths[operation] || !HASH.test(argv[1])) reject("invalid-arguments");
    sequence(argv[2]);
    const actualRoot = fs.realpathSync(path.resolve(__dirname, ".."));
    if (operation === "init" && (!path.isAbsolute(argv[3]) || fs.realpathSync(argv[3]) !== actualRoot)) reject("incorrect-trusted-source-root");
    const bridge = createBridge({ storeRoot: STORE_ROOT, sourceRoot: actualRoot, expectedUid: 0, requireLinux: true, controllerPid: process.ppid });
    const result = operation === "init" ? bridge.init(argv[1], argv[2]) : bridge[operation](...argv.slice(1));
    (operation === "report" ? console.log : console.error)(JSON.stringify(result)); return result;
  } catch { return emitWarning(); } // Telemetry is deliberately fail-open; existing release gates remain authoritative.
}
module.exports = { VERSION, STORE_ROOT, SOURCE_FILES, PHASES, RECOVERY_PHASES, createBridge, sourceCommitment, main };
if (require.main === module) main();
