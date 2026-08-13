const fs = require("node:fs");
const path = require("node:path");
const {
  acquireSyncLock,
  defaultLockDir,
  defaultMetadataGraceMs,
  inspectSyncLockActivity,
  publicationBarrierMaxStaleMs,
  syncLockActive,
} = require("../server/syncLock.cjs");
const {
  inspectPointerCommitLockActivity,
  pointerCommitLockActive,
} = require("../server/dataGenerationStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const storeDir = process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data");
const testLockDir = path.join(storeDir, "locks", "verify-sync.lock");
const testPointerLockDir = path.join(storeDir, "locks", "verify-pointer.lock");

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const cleanup = () => {
  fs.rmSync(testLockDir, { recursive: true, force: true });
  fs.rmSync(testPointerLockDir, { recursive: true, force: true });
};

const run = async () => {
  const checks = [];
  cleanup();

  const first = await acquireSyncLock({
    lockDir: testLockDir,
    owner: "verify-sync-lock",
    source: "first",
    waitMs: 0,
    staleMs: 60_000
  });
  pushCheck(checks, "first lock acquired", first.acquired === true, {
    lockDir: first.lockDir || null,
    defaultLockDir
  });
  const liveBarrier = inspectSyncLockActivity({ lockDir: testLockDir });
  pushCheck(checks, "publication barrier recognizes a live sync owner", liveBarrier.active === true
    && syncLockActive({ lockDir: testLockDir }) === true, {
      reason: liveBarrier.reason,
      ageMs: liveBarrier.ageMs,
    });
  const staleBarrier = inspectSyncLockActivity({
    lockDir: testLockDir,
    staleMs: publicationBarrierMaxStaleMs * 4,
    nowMs: Date.parse(first.info.startedAt) + publicationBarrierMaxStaleMs + 1,
    inspectOwner: () => ({ status: "alive", pid: process.pid }),
  });
  pushCheck(checks, "publication barrier caps even a live owner at thirty minutes", staleBarrier.active === false
    && staleBarrier.reason === "lock-stale", {
      reason: staleBarrier.reason,
      ageMs: staleBarrier.ageMs,
      publicationBarrierMaxStaleMs,
    });
  const deadBarrier = inspectSyncLockActivity({
    lockDir: testLockDir,
    inspectOwner: () => ({ status: "dead", pid: first.info.pid }),
  });
  pushCheck(checks, "publication barrier ignores a dead owner", deadBarrier.active === false
    && deadBarrier.reason === "owner-dead", { reason: deadBarrier.reason });

  const second = await acquireSyncLock({
    lockDir: testLockDir,
    owner: "verify-sync-lock",
    source: "second",
    waitMs: 0,
    staleMs: 60_000
  });
  pushCheck(checks, "concurrent lock denied", second.acquired === false && second.reason === "sync lock held", {
    reason: second.reason || null,
    holderOwner: second.info?.owner || null,
    holderSource: second.info?.source || null
  });

  fs.writeFileSync(path.join(testLockDir, "lock.json"), JSON.stringify({
    ...first.info,
    startedAt: new Date(Date.now() - 120_000).toISOString()
  }, null, 2));
  const liveButOld = await acquireSyncLock({
    lockDir: testLockDir,
    owner: "verify-sync-lock",
    source: "live-owner-past-stale-threshold",
    waitMs: 0,
    staleMs: 1
  });
  pushCheck(checks, "live owner is not reclaimed after stale threshold", liveButOld.acquired === false
    && liveButOld.reason === "sync lock held"
    && liveButOld.owner?.status === "alive", {
      reason: liveButOld.reason || null,
      ownerStatus: liveButOld.owner?.status || null,
      holderPid: liveButOld.info?.pid || null,
      ageMs: liveButOld.ageMs ?? null
    });

  if (first.release) await first.release();
  const third = await acquireSyncLock({
    lockDir: testLockDir,
    owner: "verify-sync-lock",
    source: "after-release",
    waitMs: 0,
    staleMs: 60_000
  });
  pushCheck(checks, "lock reacquired after release", third.acquired === true, {
    source: third.info?.source || null
  });
  if (third.release) await third.release();

  fs.mkdirSync(testLockDir, { recursive: true });
  const freshEmpty = await acquireSyncLock({
    lockDir: testLockDir,
    owner: "verify-sync-lock",
    source: "fresh-empty-metadata-grace",
    waitMs: 0,
    metadataGraceMs: 60_000
  });
  pushCheck(checks, "fresh empty lock is protected during metadata grace", freshEmpty.acquired === false
    && freshEmpty.reason === "sync lock held"
    && freshEmpty.owner?.status === "missing", {
      reason: freshEmpty.reason || null,
      ownerStatus: freshEmpty.owner?.status || null,
      metadataGraceMs: freshEmpty.metadataGraceMs ?? null,
      defaultMetadataGraceMs
    });

  const oldDirectoryTime = new Date(Date.now() - 120_000);
  fs.utimesSync(testLockDir, oldDirectoryTime, oldDirectoryTime);
  const emptyOrphan = await acquireSyncLock({
    lockDir: testLockDir,
    owner: "verify-sync-lock",
    source: "empty-metadata-recovery",
    waitMs: 0,
    metadataGraceMs: 1_000
  });
  pushCheck(checks, "empty lock is recovered after metadata grace", emptyOrphan.acquired === true
    && emptyOrphan.info?.source === "empty-metadata-recovery", {
      source: emptyOrphan.info?.source || null
    });
  if (emptyOrphan.release) await emptyOrphan.release();

  fs.mkdirSync(testLockDir, { recursive: true });
  fs.writeFileSync(path.join(testLockDir, "lock.json"), JSON.stringify({
    version: 1,
    owner: "stale-test",
    source: "old",
    pid: 0,
    startedAt: new Date(Date.now() - 120_000).toISOString()
  }, null, 2));
  const stale = await acquireSyncLock({
    lockDir: testLockDir,
    owner: "verify-sync-lock",
    source: "stale-recovery",
    waitMs: 0,
    staleMs: 1,
    metadataGraceMs: 1
  });
  pushCheck(checks, "stale lock recovered", stale.acquired === true && stale.info?.source === "stale-recovery", {
    source: stale.info?.source || null
  });
  if (stale.release) await stale.release();

  fs.mkdirSync(testPointerLockDir, { recursive: true });
  const pointerStartedAt = Date.now();
  const pointerOwner = {
    pid: process.pid,
    hostname: first.info.hostname,
    acquiredAt: new Date(pointerStartedAt).toISOString(),
  };
  fs.writeFileSync(
    path.join(testPointerLockDir, "owner.json"),
    JSON.stringify(pointerOwner),
    "utf8",
  );
  const livePointer = inspectPointerCommitLockActivity({
    lockDir: testPointerLockDir,
    nowMs: pointerStartedAt + 500,
    processAlive: () => true,
  });
  pushCheck(checks, "pointer publication barrier recognizes a live fresh owner", livePointer.active === true
    && pointerCommitLockActive({
      lockDir: testPointerLockDir,
      nowMs: pointerStartedAt + 500,
      processAlive: () => true,
    }) === true, { reason: livePointer.reason });
  const stalePointer = inspectPointerCommitLockActivity({
    lockDir: testPointerLockDir,
    staleMs: 60_000,
    nowMs: pointerStartedAt + 60_001,
    processAlive: () => true,
  });
  pushCheck(checks, "pointer publication barrier ignores a stale live owner", stalePointer.active === false
    && stalePointer.reason === "lock-stale", { reason: stalePointer.reason, ageMs: stalePointer.ageMs });
  const deadPointer = inspectPointerCommitLockActivity({
    lockDir: testPointerLockDir,
    nowMs: pointerStartedAt + 500,
    processAlive: () => false,
  });
  pushCheck(checks, "pointer publication barrier ignores a dead owner", deadPointer.active === false
    && deadPointer.reason === "owner-dead", { reason: deadPointer.reason });
  fs.rmSync(path.join(testPointerLockDir, "owner.json"), { force: true });
  const pointerStat = fs.statSync(testPointerLockDir);
  const orphanPointer = inspectPointerCommitLockActivity({
    lockDir: testPointerLockDir,
    metadataGraceMs: 1_000,
    nowMs: pointerStat.mtimeMs + 1_001,
  });
  pushCheck(checks, "pointer publication barrier ignores orphan metadata after grace", orphanPointer.active === false
    && orphanPointer.reason === "metadata-orphan", { reason: orphanPointer.reason });
  cleanup();

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run().catch((error) => {
  cleanup();
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: error.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
