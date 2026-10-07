"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { commitDataGeneration, resolveCurrentGeneration, readGenerationFile, storePaths } = require("../server/dataGenerationStore.cjs");
const { copyNativeReleaseGeneration, createNativeCopyDeadline, nativeCopyBudget, COPY_BUDGET_MS, LOCK_WAIT_MAX_MS, COPY_MIN_AFTER_LOCK_MS } = require("./nativeReleaseGenerationCopy.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-native-generation-copy-")), source = path.join(root, "source");
const checks = [];
try {
  const raw = Buffer.from(JSON.stringify({ rows: [{ tipCode: "X", note: "原始冻结推荐\n保留空格", padding: "a".repeat(2 * 1024 * 1024) }] }) + "\n");
  const original = commitDataGeneration({ storeDir: source, sourceCycleId: "native-copy-original", files: { "original.json": { bytes: raw, rows: 1 },
    "nested/evidence.json": { bytes: '{"original":"X"}\n', rows: 1 } }, coreFiles: ["original.json"], committedAt: "2026-09-11T00:00:00.000Z" });
  const identity = { mode: "active-generation", ...original.pointer }; delete identity.schemaVersion;
  commitDataGeneration({ storeDir: source, sourceCycleId: "native-copy-advanced", files: { "original.json": { bytes: '{"newGeneration":true}\n', rows: 1 } }, coreFiles: ["original.json"], committedAt: "2026-09-11T01:00:00.000Z" });
  const pointerBefore = fs.readFileSync(storePaths(source).currentPointer), target = path.join(root, "candidate");
  const copied = copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: target, identity, deadline: createNativeCopyDeadline() });
  assert.equal(copied.ok, true); assert.equal(copied.sqliteExports, 0); assert.equal(copied.activated, false);
  const candidate = resolveCurrentGeneration({ storeDir: target }); assert.equal(candidate.generationId, original.pointer.generationId);
  assert.deepEqual(readGenerationFile(candidate, "original.json"), raw); assert.deepEqual(fs.readFileSync(storePaths(source).currentPointer), pointerBefore);
  assert.equal(readGenerationFile(candidate, "nested/evidence.json", { encoding: "utf8" }), '{"original":"X"}\n');
  assert.equal(fs.existsSync(path.join(target, "football.db")), false);
  checks.push("copies exact database-bound generation even when the production pointer has advanced");
  assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: target, identity, deadline: createNativeCopyDeadline() }), { code: "EEXIST" });
  assert.deepEqual(readGenerationFile(candidate, "original.json"), raw);
  checks.push("existing candidate is retained rather than overwritten");
  assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: path.join(source, "candidate"), identity, deadline: createNativeCopyDeadline() }), /independent/);
  assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: path.join(root, "mismatch"), identity: { ...identity, manifestHash: "0".repeat(64) }, deadline: createNativeCopyDeadline() }));
  assert.equal(fs.existsSync(path.join(root, "mismatch")), false);
  checks.push("source-contained destination and mismatched publication fail before copying");
  const { acquirePointerCommitLock, inspectPointerCommitLockActivity } = require("../server/dataGenerationStore.cjs");
  const { acquireGenerationReadLease } = require("../server/dataGenerationBundle.cjs");
  const lockDir = storePaths(source).pointerLockDir, held = acquirePointerCommitLock({ lockDir });
  try {
    const lease = acquireGenerationReadLease({ storeDir: source, generationId: identity.generationId, context: original.context, pointerLockHandle: held });
    assert.equal(inspectPointerCommitLockActivity({ lockDir }).owner.token, held.owner.token);
    lease.release(); assert.equal(inspectPointerCommitLockActivity({ lockDir }).active, true);
    assert.throws(() => acquireGenerationReadLease({ storeDir: source, generationId: identity.generationId,
      pointerLockHandle: { owner: { token: "wrong" }, release() {} } }), /actual held pointer lock/);
    assert.equal(inspectPointerCommitLockActivity({ lockDir }).owner.token, held.owner.token);
  } finally { held.release(); }
  assert.throws(() => acquireGenerationReadLease({ storeDir: source, generationId: identity.generationId, pointerLockHandle: held }), /actual held pointer lock/);
  checks.push("retirement read lease reuses only the actual caller-held barrier without releasing it");
  const ready = path.join(root, "writer-ready"), released = path.join(root, "writer-released");
  const writerSource = "const fs=require('fs');const {acquirePointerCommitLock}=require(" + JSON.stringify(require.resolve("../server/dataGenerationStore.cjs")) + ");const lock=acquirePointerCommitLock({lockDir:" + JSON.stringify(lockDir) + "});fs.writeFileSync(" + JSON.stringify(ready) + ",'ready');setTimeout(()=>{lock.release();fs.writeFileSync(" + JSON.stringify(released) + ",'released');},11000);";
  const writer = require("node:child_process").spawn(process.execPath, ["-e", writerSource], { windowsHide: true, stdio: "ignore" });
  writer.unref();
  const waitStarted = Date.now();
  while (!fs.existsSync(ready)) { assert.ok(Date.now()-waitStarted < 5000); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }
  const waitedCopy = copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: path.join(root, "after-writer"), identity, deadline: createNativeCopyDeadline() });
  assert.equal(waitedCopy.ok, true); assert.ok(fs.existsSync(released));
  assert.ok(Date.now()-waitStarted >= 11000); assert.equal(inspectPointerCommitLockActivity({lockDir}).active,false);
  assert.deepEqual(readGenerationFile(resolveCurrentGeneration({ storeDir: path.join(root, "after-writer") }), "original.json"), raw);
  checks.push("actual concurrent writer longer than 10 seconds releases before the authenticated copy without lock bypass");
  assert.equal(COPY_BUDGET_MS, 240000); assert.equal(LOCK_WAIT_MAX_MS, 180000); assert.equal(COPY_MIN_AFTER_LOCK_MS, 60000);
  assert.equal(waitedCopy.timing.budgetMs, 240000); assert.ok(waitedCopy.timing.lockWaitElapsedMs >= 10000);
  assert.ok(waitedCopy.timing.grantedLockWaitMs <= 180000); assert.equal(waitedCopy.timing.fullHashAndFsyncVerified, true);
  assert.equal(waitedCopy.timing.sixtySecondsProvenSufficient, false); assert.ok(waitedCopy.timing.copyElapsedMs >= 0);
  assert.ok(waitedCopy.timing.totalElapsedMs >= waitedCopy.timing.lockWaitElapsedMs + waitedCopy.timing.copyElapsedMs);
  checks.push("successful real small-generation timing separates dispatch, natural lock wait and complete authenticated copy");

  const budget = createNativeCopyDeadline(), baseMs = Date.parse(budget.startedAt), baseNs = BigInt(budget.monotonicStartedNs);
  const projectedBudget = elapsed => nativeCopyBudget(budget, { nowMs: baseMs + elapsed, monotonicNs: baseNs + BigInt(elapsed) * 1000000n });
  assert.equal(projectedBudget(0).lockWaitMs, 180000); assert.equal(projectedBudget(2000).lockWaitMs, 178000);
  assert.equal(projectedBudget(179999).lockWaitMs, 1); assert.equal(projectedBudget(180000).lockWaitMs, 0);
  assert.throws(() => projectedBudget(240000), { code: "NATIVE_GENERATION_COPY_DEADLINE" });
  assert.throws(() => nativeCopyBudget(budget, { nowMs: baseMs + 10000, monotonicNs: baseNs }), { code: "NATIVE_GENERATION_COPY_DEADLINE" });
  checks.push("pure budget includes parent dispatch and never grants over 180 seconds or resets the outer 240 seconds");

  const agedDeadline = age => {
    const d = createNativeCopyDeadline();
    d.startedAt = new Date(Date.parse(d.startedAt) - age).toISOString();
    d.deadlineAt = new Date(Date.parse(d.deadlineAt) - age).toISOString();
    d.monotonicStartedNs = (BigInt(d.monotonicStartedNs) - BigInt(age) * 1000000n).toString();
    return d;
  };
  const crossSource = path.join(root, "cross-process-source"), crossTarget = path.join(root, "cross-process-target");
  const crossRaw = Buffer.from('{"small":"parent-issued deadline, child copy and complete hash/fsync"}\n');
  const crossOriginal = commitDataGeneration({ storeDir: crossSource, sourceCycleId: "cross-process-deadline", files: {
    "small.json": { bytes: crossRaw, rows: 1 }, "nested/identity.json": { bytes: '{"sameIdentity":true}\n', rows: 1 },
  }, coreFiles: ["small.json"], committedAt: "2026-09-11T02:00:00.000Z" });
  const crossIdentity = { mode: "active-generation", ...crossOriginal.pointer }; delete crossIdentity.schemaVersion;
  const crossPointerBefore = fs.readFileSync(storePaths(crossSource).currentPointer), crossLockDir = storePaths(crossSource).pointerLockDir;
  const crossLeases = () => { const at = path.join(storePaths(crossSource).root, "readers"); return fs.existsSync(at) ? fs.readdirSync(at).sort() : []; };
  const crossLeasesBefore = crossLeases();
  function copyInActualChild(targetStoreDir, deadline) {
    const args = { sourceStoreDir: crossSource, targetStoreDir, identity: crossIdentity, deadline };
    const childSource = "const {copyNativeReleaseGeneration}=require(" + JSON.stringify(require.resolve("./nativeReleaseGenerationCopy.cjs"))
      + ");try{console.log(JSON.stringify(copyNativeReleaseGeneration(" + JSON.stringify(args)
      + ")));}catch(error){console.log(JSON.stringify({ok:false,code:error.code,details:error.details}));process.exitCode=1;}";
    const child = require("node:child_process").spawnSync(process.execPath, ["-e", childSource], {
      windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
    });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.stderr, "");
    return { status: child.status, result: JSON.parse(child.stdout) };
  }
  const crossDeadline = createNativeCopyDeadline(), crossSuccess = copyInActualChild(crossTarget, crossDeadline);
  assert.equal(crossSuccess.status, 0); assert.equal(crossSuccess.result.ok, true);
  assert.equal(crossSuccess.result.timing.parentStartedAt, crossDeadline.startedAt);
  assert.equal(crossSuccess.result.timing.deadlineAt, crossDeadline.deadlineAt);
  assert.ok(crossSuccess.result.timing.dispatchElapsedMs > 0);
  assert.equal(crossSuccess.result.timing.fullHashAndFsyncVerified, true);
  assert.equal(crossSuccess.result.timing.sixtySecondsProvenSufficient, false);
  const crossCandidate = resolveCurrentGeneration({ storeDir: crossTarget });
  assert.deepEqual(crossCandidate.pointer, crossOriginal.pointer);
  assert.deepEqual(readGenerationFile(crossCandidate, "small.json"), crossRaw);
  assert.equal(readGenerationFile(crossCandidate, "nested/identity.json", { encoding: "utf8" }), '{"sameIdentity":true}\n');
  assert.deepEqual(fs.readFileSync(storePaths(crossSource).currentPointer), crossPointerBefore);
  assert.equal(fs.existsSync(crossLockDir), false); assert.deepEqual(crossLeases(), crossLeasesBefore);
  const crossInsufficientTarget = path.join(root, "cross-process-insufficient"), crossInsufficientDeadline = agedDeadline(180000);
  const crossRejected = copyInActualChild(crossInsufficientTarget, crossInsufficientDeadline);
  assert.equal(crossRejected.status, 1); assert.equal(crossRejected.result.code, "NATIVE_GENERATION_COPY_DEADLINE");
  assert.equal(crossRejected.result.details.stage, "before-source");
  assert.equal(fs.existsSync(crossInsufficientTarget), false); assert.equal(fs.existsSync(crossLockDir), false);
  assert.deepEqual(crossLeases(), crossLeasesBefore);
  assert.deepEqual(fs.readFileSync(storePaths(crossSource).currentPointer), crossPointerBefore);
  assert.deepEqual(readGenerationFile(crossCandidate, "small.json"), crossRaw);
  checks.push("actual parent-issued monotonic deadline crosses into child for complete immutable copy and bounded no-target refusal");
  const leases = () => { const at = path.join(storePaths(source).root, "readers"); return fs.existsSync(at) ? fs.readdirSync(at).sort() : []; };
  const leasesBefore = leases();
  for (const [name, deadline] of [["missing", undefined], ["expired", agedDeadline(240001)], ["insufficient", agedDeadline(180000)]]) {
    const output = path.join(root, "deadline-" + name);
    assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: output, identity, deadline }), { code: "NATIVE_GENERATION_COPY_DEADLINE" });
    assert.equal(fs.existsSync(output), false); assert.equal(fs.existsSync(lockDir), false); assert.deepEqual(leases(), leasesBefore);
  }
  checks.push("missing, expired or at-most-60-second remaining budgets fail before target creation without a fresh deadline fallback");

  for (const mode of ["future-wall", "future-monotonic", "extended", "wrong-total", "extra", "missing-clock"]) {
    const d = createNativeCopyDeadline(), output = path.join(root, "invalid-deadline-" + mode);
    if (mode === "future-wall") { d.startedAt = new Date(Date.parse(d.startedAt) + 1000).toISOString(); d.deadlineAt = new Date(Date.parse(d.deadlineAt) + 1000).toISOString(); }
    if (mode === "future-monotonic") d.monotonicStartedNs = (BigInt(d.monotonicStartedNs) + 1000000000n).toString();
    if (mode === "extended") d.deadlineAt = new Date(Date.parse(d.deadlineAt) + 1000).toISOString();
    if (mode === "wrong-total") d.budgetMs = 300000;
    if (mode === "extra") d.extension = true;
    if (mode === "missing-clock") delete d.monotonicStartedNs;
    assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: output, identity, deadline: d }), { code: "NATIVE_GENERATION_COPY_DEADLINE" });
    assert.equal(fs.existsSync(output), false); assert.deepEqual(leases(), leasesBefore);
  }
  checks.push("future, extended, extra or incomplete deadline contracts cannot change the original verification budget");

  const alive = acquirePointerCommitLock({ lockDir }), aliveToken = alive.owner.token, busyOutput = path.join(root, "live-owner-deadline");
  try {
    // A near-expired parent budget makes the test bounded; it does not tune any
    // production constant or change the actual owner/lock metadata.
    assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: busyOutput, identity, deadline: agedDeadline(179800) }), { code: "POINTER_LOCK_TIMEOUT" });
    assert.equal(fs.existsSync(busyOutput), false);
    assert.equal(inspectPointerCommitLockActivity({ lockDir, staleMs: Number.MAX_SAFE_INTEGER }).owner.token, aliveToken);
    assert.equal(inspectPointerCommitLockActivity({ lockDir, staleMs: Number.MAX_SAFE_INTEGER }).active, true);
    assert.deepEqual(leases(), leasesBefore);
  } finally { alive.release(); }
  assert.equal(fs.existsSync(lockDir), false);
  checks.push("a real live owner is neither stolen nor removed when the bounded wait fails before candidate creation");

  function expireDuring(trigger, outputName, targetExpected) {
    const output = path.join(root, outputName), realMono = process.hrtime.bigint, originalNow = Date.now, originalWrite = fs.writeFileSync, originalOpen = fs.openSync, originalBlockWrite = fs.writeSync;
    let expired = false, watchedFd = null;
    const deltaNs = trigger === "owned-lock-short" ? 180000000000n : 241000000000n;
    process.hrtime.bigint = () => realMono() + (expired ? deltaNs : 0n);
    Date.now = () => originalNow() + (expired && trigger === "owned-lock-short" ? 180000 : 0);
    fs.writeFileSync = function (file, ...args) {
      const value = originalWrite.call(this, file, ...args);
      if (["owned-lock", "owned-lock-short"].includes(trigger) && file === path.join(lockDir, "owner.json")) expired = true;
      if (trigger === "lease" && typeof file === "string" && path.dirname(file) === path.join(storePaths(source).root, "readers")) expired = true;
      return value;
    };
    fs.openSync = function (file, flags, ...args) {
      const fd = originalOpen.call(this, file, flags, ...args);
      if (typeof file === "string" && file.startsWith(output + path.sep) && flags === "wx") {
        watchedFd = fd; if (trigger === "copy-open") expired = true;
      }
      return fd;
    };
    fs.writeSync = function (fd, ...args) { const result = originalBlockWrite.call(this, fd, ...args); if (trigger === "block-write" && fd === watchedFd) expired = true; return result; };
    let failure;
    try {
      assert.throws(() => {
        try { copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: output, identity, deadline: createNativeCopyDeadline() }); }
        catch (error) { failure = error; throw error; }
      }, { code: "NATIVE_GENERATION_COPY_DEADLINE" });
    } finally { process.hrtime.bigint = realMono; Date.now = originalNow; fs.writeFileSync = originalWrite; fs.openSync = originalOpen; fs.writeSync = originalBlockWrite; }
    assert.equal(expired, true, "deadline fixture did not reach its actual filesystem phase");
    if (trigger === "owned-lock-short") assert.equal(failure.details.stage, "after-pointer-lock");
    assert.equal(fs.existsSync(output), targetExpected); assert.equal(fs.existsSync(lockDir), false); assert.deepEqual(leases(), leasesBefore);
    assert.deepEqual(fs.readFileSync(storePaths(source).currentPointer), pointerBefore);
    if (targetExpected) assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: output, identity, deadline: createNativeCopyDeadline() }), { code: "EEXIST" });
  }
  expireDuring("owned-lock", "deadline-after-lock", false);
  checks.push("deadline after obtaining own lock releases that exact lock before any target or lease exists");
  expireDuring("owned-lock-short", "deadline-after-lock-short", false);
  checks.push("at-most-60-second reserve after real lock acquisition refuses full copy and returns the owned lock");
  expireDuring("lease", "deadline-after-lease", false);
  checks.push("deadline after read-lease creation releases both owned lock and own lease without creating target");
  expireDuring("copy-open", "deadline-partial-open", true);
  expireDuring("block-write", "deadline-partial-block", true);
  checks.push("deadline during actual open/block copy releases own lease and retains partial evidence without overwriting failed candidate");

  const originalFile = path.join(original.context.generationDir, "original.json");
  fs.writeFileSync(originalFile, Buffer.alloc(raw.length, 32));
  assert.throws(() => copyNativeReleaseGeneration({ sourceStoreDir: source, targetStoreDir: path.join(root, "tampered"), identity, deadline: createNativeCopyDeadline() }));
  assert.equal(fs.existsSync(path.join(root, "tampered")), false);
  checks.push("same-size changed generation bytes are refused before candidate creation");
  console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks, productionWrites: 0, sqliteExports: 0,
    runtime: { platform: process.platform, node: process.version },
    timingSamples: { ordinarySmallGeneration: copied.timing, naturalLiveWriter: waitedCopy.timing, actualChildSmallGeneration: crossSuccess.result.timing },
    timingScope: "Real local small immutable files and an 11-second naturally released writer; not a production copy-duration baseline or proof that 60 seconds is sufficient." }));
} finally {
  const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("football-native-generation-copy-")); fs.rmSync(resolved, { recursive: true });
}
