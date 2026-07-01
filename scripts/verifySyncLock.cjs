const fs = require("node:fs");
const path = require("node:path");
const { acquireSyncLock, defaultLockDir } = require("../server/syncLock.cjs");

const rootDir = path.resolve(__dirname, "..");
const testLockDir = path.join(rootDir, "server-data", "locks", "verify-sync.lock");

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const cleanup = () => {
  fs.rmSync(testLockDir, { recursive: true, force: true });
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
    staleMs: 1
  });
  pushCheck(checks, "stale lock recovered", stale.acquired === true && stale.info?.source === "stale-recovery", {
    source: stale.info?.source || null
  });
  if (stale.release) await stale.release();
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
