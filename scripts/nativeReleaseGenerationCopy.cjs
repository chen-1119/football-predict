"use strict";
// Copies the exact immutable generation belonging to a held database snapshot,
// never a newly generated prediction or a SQLite export. No activation occurs.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { resolveGeneration, resolveCurrentGeneration, acquirePointerCommitLock, storePaths, MANIFEST_FILE, STORE_SCHEMA_VERSION } = require("../server/dataGenerationStore.cjs");
const { acquireGenerationReadLease } = require("../server/dataGenerationBundle.cjs");
const COPY_BUDGET_MS = 240_000, LOCK_WAIT_MAX_MS = 180_000, COPY_MIN_AFTER_LOCK_MS = 60_000;
const DEADLINE_VERSION = "native-generation-copy-deadline-v1";
function deadlineFailure(stage, details = {}) {
  throw Object.assign(new Error("native generation copy deadline rejected: " + stage), {
    code: "NATIVE_GENERATION_COPY_DEADLINE", details: { stage, ...details },
  });
}
function createNativeCopyDeadline() {
  // Called by the parent immediately before constructing/spawning its child.
  // Linux processes share CLOCK_MONOTONIC; elapsed time includes dispatch.
  const monotonicStartedNs = process.hrtime.bigint().toString(), startedMs = Date.now();
  return { version: DEADLINE_VERSION, budgetMs: COPY_BUDGET_MS,
    startedAt: new Date(startedMs).toISOString(), deadlineAt: new Date(startedMs + COPY_BUDGET_MS).toISOString(), monotonicStartedNs };
}
function nativeCopyBudget(deadline, { nowMs = Date.now(), monotonicNs = process.hrtime.bigint() } = {}) {
  const keys = ["version", "budgetMs", "startedAt", "deadlineAt", "monotonicStartedNs"];
  if (!deadline || typeof deadline !== "object" || Array.isArray(deadline)
    || Object.keys(deadline).sort().join(",") !== keys.sort().join(",")
    || deadline.version !== DEADLINE_VERSION || deadline.budgetMs !== COPY_BUDGET_MS
    || typeof deadline.monotonicStartedNs !== "string" || !/^[1-9]\d{0,23}$/.test(deadline.monotonicStartedNs)
    || typeof monotonicNs !== "bigint" || !Number.isSafeInteger(nowMs)) deadlineFailure("deadline-contract");
  const startedMs = Date.parse(deadline.startedAt), deadlineMs = Date.parse(deadline.deadlineAt);
  if (!Number.isSafeInteger(startedMs) || !Number.isSafeInteger(deadlineMs)
    || new Date(startedMs).toISOString() !== deadline.startedAt || new Date(deadlineMs).toISOString() !== deadline.deadlineAt
    || deadlineMs - startedMs !== COPY_BUDGET_MS) deadlineFailure("deadline-clock-contract");
  if (startedMs > nowMs) deadlineFailure("future-wall-start");
  const elapsedNs = monotonicNs - BigInt(deadline.monotonicStartedNs);
  if (elapsedNs < 0n) deadlineFailure("future-monotonic-start");
  if (elapsedNs >= BigInt(COPY_BUDGET_MS) * 1_000_000n) deadlineFailure("budget-expired", { budgetMs: COPY_BUDGET_MS });
  // Round elapsed time up so the child never grants itself dispatch/rounding
  // time. Wall-clock discontinuity is a refusal, not a new deadline.
  const elapsedMs = Number((elapsedNs + 999_999n) / 1_000_000n);
  if (Math.abs(nowMs - startedMs - elapsedMs) > 5000) deadlineFailure("wall-monotonic-clock-disagreement");
  const remainingMs = COPY_BUDGET_MS - elapsedMs;
  return { budgetMs: COPY_BUDGET_MS, elapsedMs, remainingMs,
    lockWaitMs: Math.min(LOCK_WAIT_MAX_MS, Math.max(0, remainingMs - COPY_MIN_AFTER_LOCK_MS)) };
}
function copyNativeReleaseGeneration({ sourceStoreDir, targetStoreDir, identity, deadline }) {
  const childStartedAt = new Date().toISOString(), childStartedNs = process.hrtime.bigint();
  const guard = (stage, minimumRemainingMs = 0) => {
    const budget = nativeCopyBudget(deadline);
    if (budget.remainingMs <= minimumRemainingMs) deadlineFailure(stage, { ...budget, minimumRemainingMs });
    return budget;
  };
  guard("before-source", COPY_MIN_AFTER_LOCK_MS);
  const source = fs.realpathSync(sourceStoreDir), target = path.resolve(targetStoreDir);
  assert.ok(target !== source && !target.startsWith(source + path.sep) && !source.startsWith(target + path.sep), "independent candidate store required");
  assert.equal(fs.realpathSync(path.dirname(target)), path.dirname(target), "candidate parent must be a real directory");
  assert.equal(identity?.mode, "active-generation"); assert.match(identity.generationId, /^g-[a-f0-9]{64}$/);
  assert.match(identity.manifestHash, /^[a-f0-9]{64}$/); assert.ok(identity.sourceCycleId && Number.isFinite(Date.parse(identity.committedAt)));
  const beforeLock = guard("before-pointer-lock", COPY_MIN_AFTER_LOCK_MS), lockStartedNs = process.hrtime.bigint(), lockRequestedAt = new Date().toISOString();
  const pointerLock = acquirePointerCommitLock({ lockDir: storePaths(source).pointerLockDir, timeoutMs: beforeLock.lockWaitMs, staleMs: 60_000 });
  const lockAcquiredNs = process.hrtime.bigint(), lockAcquiredAt = new Date().toISOString();
  let context, lease;
  try {
   try {
    guard("after-pointer-lock", COPY_MIN_AFTER_LOCK_MS);
    guard("before-source-generation-validation");
    context = resolveGeneration({ storeDir: source, generationId: identity.generationId,
      manifestHash: identity.manifestHash, sourceCycleId: identity.sourceCycleId });
    guard("after-source-generation-validation");
    lease = acquireGenerationReadLease({ storeDir: source, generationId: identity.generationId, context,
      pointerLockHandle: pointerLock, owner: "native-release-generation-copy", ttlMs: 15 * 60_000 });
    guard("after-generation-read-lease");
   } finally { pointerLock.release(); }
  let bytes = 0;
  const directories = new Set();
  const sync = filename => { guard("before-fsync"); const fd = fs.openSync(filename, process.platform === "win32" ? "r+" : "r"); try { fs.fsyncSync(fd); guard("after-fsync"); } finally { fs.closeSync(fd); } };
  function copy(filename, output, expectedBytes, expectedHash) {
    guard("before-generation-file");
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let destination;
    try {
      const before = fs.fstatSync(fd); assert.ok(before.isFile() && before.nlink === 1); assert.equal(before.size, expectedBytes);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      for (let directory = path.dirname(output);; directory = path.dirname(directory)) {
        assert.ok(directory === target || directory.startsWith(target + path.sep)); directories.add(directory);
        if (directory === target) break;
      }
      destination = fs.openSync(output, "wx", 0o600);
      const buffer = Buffer.alloc(1024 * 1024), digest = crypto.createHash("sha256"); let copied = 0;
      for (;;) { guard("before-generation-block-read"); const n = fs.readSync(fd, buffer, 0, buffer.length, null); guard("after-generation-block-read"); if (!n) break;
        copied += n; assert.ok(copied <= expectedBytes, "generation file grew"); digest.update(buffer.subarray(0, n));
        guard("after-generation-block-hash");
        let offset = 0; while (offset < n) { guard("before-generation-block-write"); offset += fs.writeSync(destination, buffer, offset, n - offset); guard("after-generation-block-write"); }
      }
      const after = fs.fstatSync(fd), current = fs.lstatSync(filename);
      assert.equal(copied, expectedBytes); assert.equal(digest.digest("hex"), expectedHash);
      assert.ok(!current.isSymbolicLink() && current.ino === before.ino && current.dev === before.dev
        && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, "generation source changed");
      guard("before-generation-file-fsync"); fs.fsyncSync(destination); guard("after-generation-file-fsync"); bytes += copied;
    } finally { if (destination !== undefined) fs.closeSync(destination); fs.closeSync(fd); }
  }
    guard("before-candidate-creation");
    fs.mkdirSync(target, { mode: 0o700 }); // Preserve an existing or failed candidate; no overwrite/retry.
    const paths = storePaths(target), generation = path.join(paths.generationsDir, identity.generationId);
    fs.mkdirSync(generation, { recursive: true, mode: 0o700 });
    for (const file of context.manifest.files) copy(path.join(context.generationDir, file.path), path.join(generation, file.path), file.bytes, file.sha256);
    guard("before-manifest-read");
    const manifest = path.join(context.generationDir, MANIFEST_FILE), manifestBytes = fs.readFileSync(manifest);
    guard("after-manifest-read");
    copy(manifest, path.join(generation, MANIFEST_FILE), manifestBytes.length, crypto.createHash("sha256").update(manifestBytes).digest("hex"));
    const pointer = { schemaVersion: STORE_SCHEMA_VERSION, generationId: identity.generationId, sourceCycleId: identity.sourceCycleId,
      manifestHash: identity.manifestHash, committedAt: identity.committedAt };
    guard("before-candidate-pointer-write"); fs.writeFileSync(paths.currentPointer, JSON.stringify(pointer) + "\n", { flag: "wx", mode: 0o600 }); guard("after-candidate-pointer-write"); sync(paths.currentPointer);
    guard("before-complete-candidate-validation");
    const copied = resolveCurrentGeneration({ storeDir: target });
    guard("after-complete-candidate-validation");
    assert.equal(copied.manifestHash, identity.manifestHash); assert.deepEqual(copied.pointer, pointer);
    if (process.platform === "linux") for (const directory of [...directories].sort((a, b) => b.length - a.length)) sync(directory);
    const completed = guard("before-copy-success"), completedNs = process.hrtime.bigint();
    return { ok: true, identity, files: context.manifest.files.length, bytes, sqliteExports: 0, databaseWrites: 0, activated: false,
      timing: { version: "native-generation-copy-timing-v1", budgetMs: COPY_BUDGET_MS,
        parentStartedAt: deadline.startedAt, deadlineAt: deadline.deadlineAt, childStartedAt, lockRequestedAt, lockAcquiredAt, completedAt: new Date().toISOString(),
        configuredLockWaitMaxMs: LOCK_WAIT_MAX_MS, grantedLockWaitMs: beforeLock.lockWaitMs, minimumAfterLockMs: COPY_MIN_AFTER_LOCK_MS,
        dispatchElapsedMs: Number(childStartedNs - BigInt(deadline.monotonicStartedNs)) / 1_000_000,
        lockWaitElapsedMs: Number(lockAcquiredNs - lockStartedNs) / 1_000_000,
        copyElapsedMs: Number(completedNs - lockAcquiredNs) / 1_000_000, totalElapsedMs: Number(completedNs - BigInt(deadline.monotonicStartedNs)) / 1_000_000,
        remainingMs: completed.remainingMs, fullHashAndFsyncVerified: true, sixtySecondsProvenSufficient: false } };
  } finally { if (lease) lease.release(); }
}
module.exports = { copyNativeReleaseGeneration, createNativeCopyDeadline, nativeCopyBudget, COPY_BUDGET_MS, LOCK_WAIT_MAX_MS, COPY_MIN_AFTER_LOCK_MS };
