"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  acquirePointerCommitLock,
  DataGenerationError,
  commitDataGeneration,
  readGenerationFile,
  resolveCurrentGeneration,
  resolveGeneration,
  resolvePreviousGeneration,
  sha256,
  stableStringify,
  storePaths,
} = require("../server/dataGenerationStore.cjs");

let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  assertions += 1;
};
const deepEqual = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
};
const expectCode = (task, code, message) => {
  assert.throws(task, (error) => error instanceof DataGenerationError && error.code === code, message);
  assertions += 1;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-data-generation-"));
const storeDir = path.join(root, "server-data");
const paths = storePaths(storeDir);
const coreFiles = ["matches.json", "nested/odds.json", "sync-meta.json"];
const at = (minute) => new Date(Date.parse("2026-07-16T00:00:00.000Z") + minute * 60_000).toISOString();
const fixtureFiles = (label) => ({
  "matches.json": {
    data: [
      { id: `${label}-1`, home: "Alpha", away: "Beta" },
      { id: `${label}-2`, home: "Gamma", away: "Delta" },
    ],
    rows: 2,
  },
  "nested/odds.json": {
    data: [
      { id: `${label}-1`, had: [2.1, 3.2, 3.4] },
      { id: `${label}-2`, had: [1.8, 3.5, 4.1] },
    ],
    rows: 2,
  },
  "sync-meta.json": {
    data: { label, complete: true },
    rows: 1,
  },
});
const pointerBytes = () => fs.readFileSync(paths.currentPointer);
const generationNames = () => fs.existsSync(paths.generationsDir)
  ? fs.readdirSync(paths.generationsDir).sort()
  : [];
const afterFileFault = (relativePath) => (point, details) => (
  point === "after-file-fsync" && details.relativePath === relativePath
);
const pointFault = (expectedPoint) => (point) => point === expectedPoint;

try {
  const first = commitDataGeneration({
    storeDir,
    sourceCycleId: "sporttery-full-sync:first",
    files: fixtureFiles("first"),
    coreFiles,
    committedAt: at(1),
  });
  check(first.committed, "first generation commits");
  equal(first.idempotent, false, "first generation is not an idempotent retry");
  equal(first.pointer.sourceCycleId, "sporttery-full-sync:first", "pointer binds source cycle");
  equal(first.pointer.manifestHash.length, 64, "pointer contains manifest hash");
  equal(first.pointer.committedAt, at(1), "pointer records the commit clock");
  check(fs.existsSync(first.context.generationDir), "generation directory exists after commit");
  check(!first.context.generationDir.includes(`${path.sep}.staging${path.sep}`), "committed generation left staging");
  check(Object.isFrozen(first.context), "resolved commit context is immutable at the top level");

  const firstContext = resolveCurrentGeneration({ storeDir });
  equal(firstContext.generationId, first.pointer.generationId, "current pointer resolves exact generation");
  equal(firstContext.manifestHash, first.pointer.manifestHash, "resolved manifest matches pointer");
  deepEqual(firstContext.manifest.coreFiles, [...coreFiles].sort((a, b) => a.localeCompare(b, "en")), "manifest records every core file");
  equal(firstContext.manifest.files.find((entry) => entry.path === "matches.json").rows, 2, "manifest records row count");
  equal(firstContext.manifest.files.find((entry) => entry.path === "sync-meta.json").rows, 1, "manifest records singleton row count");
  for (const entry of firstContext.manifest.files) {
    const bytes = readGenerationFile(firstContext, entry.path);
    equal(bytes.length, entry.bytes, `${entry.path} byte count is verified`);
    equal(sha256(bytes), entry.sha256, `${entry.path} hash is verified`);
  }
  equal(readGenerationFile(firstContext, "matches.json", { parseJson: true })[0].id, "first-1", "context reads its own JSON");

  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, "matches.json"), "legacy mutable mirror is corrupt\n");
  equal(
    readGenerationFile(firstContext, "matches.json", { parseJson: true })[0].id,
    "first-1",
    "legacy mutable mirror is never consulted",
  );

  const second = commitDataGeneration({
    storeDir,
    sourceCycleId: "sporttery-full-sync:second",
    files: fixtureFiles("second"),
    coreFiles,
    committedAt: at(2),
  });
  equal(resolveCurrentGeneration({ storeDir }).generationId, second.pointer.generationId, "pointer switches to second generation");
  equal(readGenerationFile(firstContext, "matches.json", { parseJson: true })[0].id, "first-1", "old fixed context remains readable after switch");
  equal(readGenerationFile(second.context, "matches.json", { parseJson: true })[0].id, "second-1", "new context reads only second generation");
  const previous = resolvePreviousGeneration({ storeDir });
  equal(previous.generationId, first.pointer.generationId, "previous pointer keeps last known good generation");
  equal(previous.pointer.manifestHash, first.pointer.manifestHash, "previous pointer preserves manifest identity");
  equal(
    resolveGeneration({ storeDir, generationId: first.pointer.generationId }).generationId,
    first.pointer.generationId,
    "an explicit immutable generation can be resolved independently",
  );

  const activeContext = resolveCurrentGeneration({ storeDir });
  const activeMatchesPath = path.join(activeContext.generationDir, "matches.json");
  const activeMatchesBytes = fs.readFileSync(activeMatchesPath);
  const sameSizeTamper = Buffer.from(activeMatchesBytes);
  sameSizeTamper[0] ^= 1;
  fs.writeFileSync(activeMatchesPath, sameSizeTamper);
  expectCode(() => resolveCurrentGeneration({ storeDir }), "FILE_HASH_MISMATCH", "same-size tamper fails hash validation");
  fs.writeFileSync(activeMatchesPath, activeMatchesBytes);
  fs.writeFileSync(activeMatchesPath, Buffer.concat([activeMatchesBytes, Buffer.from("x")]));
  expectCode(() => resolveCurrentGeneration({ storeDir }), "FILE_SIZE_MISMATCH", "size tamper is rejected");
  fs.writeFileSync(activeMatchesPath, activeMatchesBytes);
  fs.rmSync(activeMatchesPath);
  expectCode(() => resolveCurrentGeneration({ storeDir }), "FILE_MISSING", "missing generation file is rejected");
  fs.writeFileSync(activeMatchesPath, activeMatchesBytes);
  equal(resolveCurrentGeneration({ storeDir }).generationId, second.pointer.generationId, "restored generation validates again");

  const goodPointerBytes = pointerBytes();
  const goodPointer = JSON.parse(goodPointerBytes.toString("utf8"));
  fs.writeFileSync(paths.currentPointer, `${JSON.stringify({ ...goodPointer, manifestHash: "0".repeat(64) }, null, 2)}\n`);
  expectCode(() => resolveCurrentGeneration({ storeDir }), "MANIFEST_HASH_MISMATCH", "pointer-to-manifest mismatch is rejected");
  fs.writeFileSync(paths.currentPointer, goodPointerBytes);

  const mutableFallbackPath = path.join(storeDir, "sync-meta.json");
  fs.writeFileSync(mutableFallbackPath, JSON.stringify({ fake: "legacy fallback" }));
  const pointerBackup = path.join(root, "current-pointer.backup");
  fs.renameSync(paths.currentPointer, pointerBackup);
  expectCode(() => resolveCurrentGeneration({ storeDir }), "POINTER_NOT_FOUND", "missing pointer fails closed despite mutable root files");
  fs.renameSync(pointerBackup, paths.currentPointer);

  for (const relativePath of [...coreFiles].sort((a, b) => a.localeCompare(b, "en"))) {
    const before = pointerBytes();
    expectCode(() => commitDataGeneration({
      storeDir,
      sourceCycleId: `fault:file:${relativePath}`,
      files: fixtureFiles(`fault-file-${relativePath}`),
      coreFiles,
      committedAt: at(3),
      faultInjector: afterFileFault(relativePath),
    }), "FAULT_INJECTED", `fault after fsync of ${relativePath} is observable`);
    deepEqual(pointerBytes(), before, `fault after ${relativePath} does not move current pointer`);
  }

  for (const [index, point] of [
    "after-manifest-fsync",
    "before-pointer-rename",
    "pointer-rename",
  ].entries()) {
    const before = pointerBytes();
    expectCode(() => commitDataGeneration({
      storeDir,
      sourceCycleId: `fault:${point}`,
      files: fixtureFiles(`fault-${point}`),
      coreFiles,
      committedAt: at(10 + index),
      faultInjector: pointFault(point),
    }), "FAULT_INJECTED", `${point} failure is observable`);
    deepEqual(pointerBytes(), before, `${point} failure leaves current pointer byte-for-byte unchanged`);
  }

  const orphanFiles = fixtureFiles("orphan-conflict");
  const generationsBeforeOrphan = new Set(generationNames());
  const beforeOrphanPointer = pointerBytes();
  expectCode(() => commitDataGeneration({
    storeDir,
    sourceCycleId: "fault:after-generation-rename",
    files: orphanFiles,
    coreFiles,
    committedAt: at(20),
    faultInjector: pointFault("after-generation-rename"),
  }), "FAULT_INJECTED", "fault after directory rename is observable");
  deepEqual(pointerBytes(), beforeOrphanPointer, "directory-rename fault leaves current pointer unchanged");
  const orphanNames = generationNames().filter((name) => !generationsBeforeOrphan.has(name));
  equal(orphanNames.length, 1, "directory-rename failure leaves exactly one unreferenced immutable generation");
  const orphanPath = path.join(paths.generationsDir, orphanNames[0], "matches.json");
  const orphanBytes = fs.readFileSync(orphanPath);
  const orphanTamper = Buffer.from(orphanBytes);
  orphanTamper[0] ^= 1;
  fs.writeFileSync(orphanPath, orphanTamper);
  expectCode(() => commitDataGeneration({
    storeDir,
    sourceCycleId: "fault:after-generation-rename",
    files: orphanFiles,
    coreFiles,
    committedAt: at(21),
  }), "GENERATION_CONFLICT", "existing generation identity with conflicting bytes is rejected explicitly");
  deepEqual(pointerBytes(), beforeOrphanPointer, "generation conflict does not move current pointer");

  const beforeValidatorFailure = pointerBytes();
  expectCode(() => commitDataGeneration({
    storeDir,
    sourceCycleId: "validator:reject",
    files: fixtureFiles("validator-reject"),
    coreFiles,
    committedAt: at(30),
    validate: () => ({ ok: false, reason: "fixture rejection" }),
  }), "VALIDATION_FAILED", "application validator can reject before publication");
  deepEqual(pointerBytes(), beforeValidatorFailure, "validator rejection leaves pointer unchanged");

  expectCode(() => commitDataGeneration({
    storeDir,
    sourceCycleId: "validator:mutates",
    files: fixtureFiles("validator-mutates"),
    coreFiles,
    committedAt: at(31),
    validate: (context) => {
      const target = path.join(context.generationDir, "matches.json");
      const bytes = fs.readFileSync(target);
      bytes[0] ^= 1;
      fs.writeFileSync(target, bytes);
      return true;
    },
  }), "FILE_HASH_MISMATCH", "staging is re-hashed after custom validation");
  deepEqual(pointerBytes(), beforeValidatorFailure, "validator mutation leaves pointer unchanged");

  let innerWriter;
  expectCode(() => commitDataGeneration({
    storeDir,
    sourceCycleId: "writer:outer-stale",
    files: fixtureFiles("writer-outer-stale"),
    coreFiles,
    committedAt: at(35),
    validate: () => {
      innerWriter = commitDataGeneration({
        storeDir,
        sourceCycleId: "writer:inner-winner",
        files: fixtureFiles("writer-inner-winner"),
        coreFiles,
        committedAt: at(36),
      });
      return true;
    },
  }), "POINTER_CHANGED", "a staged writer cannot overwrite a pointer committed by a second writer");
  equal(resolveCurrentGeneration({ storeDir }).generationId, innerWriter.pointer.generationId, "winning writer remains current after stale writer CAS rejection");
  equal(resolvePreviousGeneration({ storeDir }).generationId, second.pointer.generationId, "winning writer alone advances last-known-good pointer");
  check(!fs.existsSync(paths.pointerLockDir), "pointer writer lock is released after CAS rejection");

  const heldLock = acquirePointerCommitLock({ lockDir: paths.pointerLockDir, timeoutMs: 100, staleMs: 60_000 });
  try {
    expectCode(() => commitDataGeneration({
      storeDir,
      sourceCycleId: "writer:lock-timeout",
      files: fixtureFiles("writer-lock-timeout"),
      coreFiles,
      committedAt: at(37),
      pointerLockTimeoutMs: 30,
      pointerLockStaleMs: 60_000,
    }), "POINTER_LOCK_TIMEOUT", "a live pointer writer lock fails with a bounded timeout");
  } finally {
    heldLock.release();
  }
  equal(resolveCurrentGeneration({ storeDir }).generationId, innerWriter.pointer.generationId, "lock timeout leaves winning pointer unchanged");
  check(!fs.existsSync(paths.pointerLockDir), "lock owner releases lock in finally");

  fs.mkdirSync(paths.pointerLockDir);
  fs.writeFileSync(path.join(paths.pointerLockDir, "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    token: "00000000-0000-4000-8000-000000000001",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  })}\n`);
  const reclaimedDeadOwner = acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: 100,
    staleMs: 60_000,
  });
  try {
    equal(reclaimedDeadOwner.owner.pid, process.pid, "same-host dead writer lock is reclaimed immediately");
  } finally {
    reclaimedDeadOwner.release();
  }
  check(!fs.existsSync(paths.pointerLockDir), "reclaimed dead writer lock is released by its new owner");

  fs.mkdirSync(paths.pointerLockDir);
  const staleNoOwner = new Date(Date.now() - 120_000);
  fs.utimesSync(paths.pointerLockDir, staleNoOwner, staleNoOwner);
  expectCode(() => acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: 25,
    staleMs: 1,
    pollMs: 2,
  }), "POINTER_LOCK_TIMEOUT", "a stale lock without exact owner evidence fails closed");
  check(fs.existsSync(paths.pointerLockDir), "stale ownerless canonical lock is never removed by pathname");
  fs.rmdirSync(paths.pointerLockDir);

  fs.mkdirSync(paths.pointerLockDir);
  const malformedOwnerPath = path.join(paths.pointerLockDir, "owner.json");
  fs.writeFileSync(malformedOwnerPath, "{malformed-owner", "utf8");
  fs.utimesSync(paths.pointerLockDir, staleNoOwner, staleNoOwner);
  fs.utimesSync(malformedOwnerPath, staleNoOwner, staleNoOwner);
  expectCode(() => acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: 25,
    staleMs: 1,
    pollMs: 2,
  }), "POINTER_LOCK_TIMEOUT", "stale malformed owner metadata fails closed");
  equal(fs.readFileSync(malformedOwnerPath, "utf8"), "{malformed-owner", "malformed owner bytes remain untouched");
  fs.rmSync(paths.pointerLockDir, { recursive: true, force: true });

  fs.mkdirSync(paths.pointerLockDir);
  const extraEntryOwner = {
    schemaVersion: 1,
    token: "00000000-0000-4000-8000-000000000003",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(paths.pointerLockDir, "owner.json"), `${JSON.stringify(extraEntryOwner)}\n`);
  fs.writeFileSync(path.join(paths.pointerLockDir, "unexpected-entry"), "preserve", "utf8");
  expectCode(() => acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: 25,
    staleMs: 1,
    pollMs: 2,
  }), "POINTER_LOCK_TIMEOUT", "extra lock metadata prevents unsafe dead-owner reclamation");
  deepEqual(
    fs.readdirSync(paths.pointerLockDir).sort(),
    ["owner.json", "unexpected-entry"],
    "extra lock metadata and exact owner are preserved fail closed",
  );
  fs.rmSync(paths.pointerLockDir, { recursive: true, force: true });

  fs.mkdirSync(paths.pointerLockDir);
  const renameFailureOwner = {
    schemaVersion: 1,
    token: "00000000-0000-4000-8000-000000000002",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(paths.pointerLockDir, "owner.json"), `${JSON.stringify(renameFailureOwner)}\n`);
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (sourcePath, targetPath) => {
    if (sourcePath === paths.pointerLockDir && path.basename(targetPath).includes(".quarantine.")) {
      const error = new Error("injected pointer lock quarantine rename failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRenameSync(sourcePath, targetPath);
  };
  try {
    expectCode(() => acquirePointerCommitLock({
      lockDir: paths.pointerLockDir,
      timeoutMs: 25,
      staleMs: 60_000,
      pollMs: 2,
    }), "POINTER_LOCK_TIMEOUT", "quarantine rename failure fails closed instead of deleting canonical lock");
  } finally {
    fs.renameSync = originalRenameSync;
  }
  deepEqual(fs.readdirSync(paths.pointerLockDir), ["owner.json"], "failed quarantine restores the exact owner filename");
  equal(
    JSON.parse(fs.readFileSync(path.join(paths.pointerLockDir, "owner.json"), "utf8")).token,
    renameFailureOwner.token,
    "failed quarantine restores the exact dead-owner token",
  );
  const cleanupRenameFailureOwner = acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: 100,
    staleMs: 60_000,
  });
  cleanupRenameFailureOwner.release();

  const claimReadFailureHandle = acquirePointerCommitLock({
    lockDir: paths.pointerLockDir,
    timeoutMs: 100,
    staleMs: 60_000,
  });
  const originalReadFileSync = fs.readFileSync;
  let claimReadFailureInjected = false;
  fs.readFileSync = (targetPath, ...args) => {
    if (!claimReadFailureInjected && path.basename(String(targetPath)).startsWith(".owner.pointer-claim.")) {
      claimReadFailureInjected = true;
      const error = new Error("injected owner claim read failure");
      error.code = "EIO";
      throw error;
    }
    return originalReadFileSync(targetPath, ...args);
  };
  try {
    expectCode(
      () => claimReadFailureHandle.release(),
      "POINTER_LOCK_RELEASE_FAILED",
      "an unprovable claimed owner fails release instead of silently leaking the lock",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  check(claimReadFailureInjected, "claim evidence read fault is injected after owner-to-claim rename");
  deepEqual(fs.readdirSync(paths.pointerLockDir), ["owner.json"], "unprovable claim restores the exact owner filename");
  equal(
    JSON.parse(fs.readFileSync(path.join(paths.pointerLockDir, "owner.json"), "utf8")).token,
    claimReadFailureHandle.owner.token,
    "unprovable claim restores the exact owned token",
  );
  claimReadFailureHandle.release();
  check(!fs.existsSync(paths.pointerLockDir), "release can be retried after exact claim restoration");

  const idempotentFiles = fixtureFiles("idempotent");
  const idempotentFirst = commitDataGeneration({
    storeDir,
    sourceCycleId: "cycle:idempotent",
    files: idempotentFiles,
    coreFiles,
    committedAt: at(40),
  });
  const generationCount = generationNames().length;
  const idempotentPointerBytes = pointerBytes();
  const idempotentRetry = commitDataGeneration({
    storeDir,
    sourceCycleId: "cycle:idempotent",
    files: idempotentFiles,
    coreFiles,
    committedAt: at(99),
  });
  check(idempotentRetry.idempotent, "same source cycle and content are idempotent");
  equal(idempotentRetry.pointer.generationId, idempotentFirst.pointer.generationId, "idempotent retry preserves generation identity");
  equal(generationNames().length, generationCount, "idempotent retry creates no generation directory");
  deepEqual(pointerBytes(), idempotentPointerBytes, "idempotent retry does not churn pointer timestamp or bytes");

  expectCode(() => commitDataGeneration({
    storeDir,
    sourceCycleId: "invalid:path",
    files: {
      "../escape.json": { data: [], rows: 0 },
      "sync-meta.json": { data: {}, rows: 1 },
    },
    coreFiles: ["../escape.json"],
  }), "UNSAFE_PATH", "path traversal is rejected");
  expectCode(() => commitDataGeneration({
    storeDir,
    sourceCycleId: "invalid:case-collision",
    files: [
      { path: "Matches.json", data: [], rows: 0 },
      { path: "matches.json", data: [], rows: 0 },
    ],
  }), "DUPLICATE_PATH", "case-insensitive path collision is rejected for Windows safety");

  const moduleSource = fs.readFileSync(path.join(__dirname, "..", "server", "dataGenerationStore.cjs"), "utf8");
  check(moduleSource.includes('fs.openSync(filePath, "r+")'), "durability helper explicitly uses r+ for Windows fsync");
  check(moduleSource.includes("fs.renameSync(stagingDir, generationDir)"), "generation publication uses same-filesystem directory rename");
  check(moduleSource.includes("fs.renameSync(temporaryPath, targetPath)"), "pointer publication uses temp-file rename");
  check(!moduleSource.includes("public/data"), "generation reader has no mutable public-data fallback");

  const pointerRaceVerification = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, "verifyDataGenerationPointerLockRace.cjs"),
  ], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  equal(pointerRaceVerification.status, 0, `pointer-lock ABA regression passes: ${pointerRaceVerification.stderr || ""}`);
  const pointerRaceReport = JSON.parse(pointerRaceVerification.stdout);
  check(
    pointerRaceReport.ok === true && pointerRaceReport.schema === "data-generation-pointer-lock-aba-v1",
    "data-generation transaction suite includes the real three-process pointer-lock ABA regression",
  );

  const result = {
    ok: true,
    schema: "data-generation-transaction-v1",
    assertions,
    activeGenerationId: resolveCurrentGeneration({ storeDir }).generationId,
    generationDirectories: generationNames().length,
    manifestHash: resolveCurrentGeneration({ storeDir }).manifestHash,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
