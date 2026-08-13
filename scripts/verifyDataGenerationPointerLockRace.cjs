"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  acquirePointerCommitLock,
} = require("../server/dataGenerationStore.cjs");

const sleepSync = (milliseconds) => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.max(1, milliseconds));
};

const waitFor = (predicate, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    sleepSync(10);
  }
  assert.fail(message);
};

const writeOwner = (lockDir, owner) => {
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
};

const canonicalOwner = ({ token, pid, acquiredAt = new Date().toISOString() }) => ({
  schemaVersion: 1,
  token,
  pid,
  hostname: os.hostname(),
  acquiredAt,
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-pointer-lock-aba-"));
const lockDir = path.join(root, ".pointer-commit.lock");
const oldQuarantine = path.join(root, ".old-owner-quarantine");
const modulePath = path.join(__dirname, "..", "server", "dataGenerationStore.cjs");
const pausedPath = path.join(root, "waiter-paused");
const resumePath = path.join(root, "waiter-resume");
const waiterOutcomePath = path.join(root, "waiter-outcome.json");
const cleanupDonePath = path.join(root, "cleanup-done");
const successorReadyPath = path.join(root, "successor-ready.json");
const successorReleasePath = path.join(root, "successor-release");
const successorDonePath = path.join(root, "successor-done.json");
const children = [];
let assertions = 0;

const waiterSource = String.raw`
  const fs = require("node:fs");
  const { acquirePointerCommitLock } = require(process.argv[1]);
  const [lockDir, pausedPath, resumePath, outcomePath] = process.argv.slice(2);
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let paused = false;
  try {
    const handle = acquirePointerCommitLock({
      lockDir,
      timeoutMs: 2000,
      staleMs: 60000,
      pollMs: 5,
      pointerLockTestHook(point) {
        if (point !== "before-owner-claim" || paused) return;
        paused = true;
        fs.writeFileSync(pausedPath, "paused", { flag: "wx" });
        while (!fs.existsSync(resumePath)) sleep(5);
      },
    });
    fs.writeFileSync(outcomePath, JSON.stringify({ code: "UNEXPECTED_ACQUIRE", token: handle.owner.token }));
    handle.release();
  } catch (error) {
    fs.writeFileSync(outcomePath, JSON.stringify({ code: error && error.code || "ERROR", message: String(error && error.message || error) }));
  }
`;

const cleanupSource = String.raw`
  const fs = require("node:fs");
  const [lockDir, quarantinePath, donePath] = process.argv.slice(1);
  fs.renameSync(lockDir, quarantinePath);
  fs.writeFileSync(donePath, "done", { flag: "wx" });
`;

const successorSource = String.raw`
  const fs = require("node:fs");
  const { acquirePointerCommitLock } = require(process.argv[1]);
  const [lockDir, readyPath, releasePath, donePath] = process.argv.slice(2);
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  try {
    const handle = acquirePointerCommitLock({ lockDir, timeoutMs: 1000, staleMs: 60000, pollMs: 5 });
    fs.writeFileSync(readyPath, JSON.stringify(handle.owner), { flag: "wx" });
    while (!fs.existsSync(releasePath)) sleep(5);
    handle.release();
    fs.writeFileSync(donePath, JSON.stringify({ ok: true }), { flag: "wx" });
  } catch (error) {
    fs.writeFileSync(donePath, JSON.stringify({ ok: false, code: error && error.code || "ERROR", message: String(error && error.message || error) }), { flag: "wx" });
  }
`;

try {
  writeOwner(lockDir, canonicalOwner({
    token: "00000000-0000-4000-8000-000000000101",
    pid: 2_147_483_647,
  }));

  const waiter = childProcess.spawn(process.execPath, [
    "-e", waiterSource, modulePath, lockDir, pausedPath, resumePath, waiterOutcomePath,
  ], { stdio: "ignore", windowsHide: true });
  children.push(waiter);
  waitFor(() => fs.existsSync(pausedPath), 3000, "waiter A did not pause after deciding the old owner was dead");

  const cleanup = childProcess.spawnSync(process.execPath, [
    "-e", cleanupSource, lockDir, oldQuarantine, cleanupDonePath,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(cleanup.status, 0, cleanup.stderr || "cleanup process failed");
  assertions += 1;
  assert.equal(fs.existsSync(cleanupDonePath), true, "cleanup process isolated the old directory");
  assertions += 1;

  const successor = childProcess.spawn(process.execPath, [
    "-e", successorSource, modulePath, lockDir, successorReadyPath, successorReleasePath, successorDonePath,
  ], { stdio: "ignore", windowsHide: true });
  children.push(successor);
  waitFor(() => fs.existsSync(successorReadyPath), 3000, "successor B did not acquire the canonical lock");
  const successorOwner = JSON.parse(fs.readFileSync(successorReadyPath, "utf8"));

  fs.writeFileSync(resumePath, "resume", { flag: "wx" });
  waitFor(() => fs.existsSync(waiterOutcomePath), 5000, "waiter A did not finish after the ABA race");
  const waiterOutcome = JSON.parse(fs.readFileSync(waiterOutcomePath, "utf8"));
  assert.equal(waiterOutcome.code, "POINTER_LOCK_TIMEOUT", "stale waiter must wait behind the live successor");
  assertions += 1;
  assert.equal(fs.existsSync(lockDir), true, "live successor canonical directory survives the stale waiter");
  assertions += 1;
  assert.deepEqual(fs.readdirSync(lockDir), ["owner.json"], "stale waiter restores the successor owner filename");
  assertions += 1;
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")).token,
    successorOwner.token,
    "stale waiter preserves the live successor token",
  );
  assertions += 1;

  fs.writeFileSync(successorReleasePath, "release", { flag: "wx" });
  waitFor(() => fs.existsSync(successorDonePath), 3000, "successor B did not release");
  assert.equal(JSON.parse(fs.readFileSync(successorDonePath, "utf8")).ok, true, "successor releases its own exact lock");
  assertions += 1;
  assert.equal(fs.existsSync(lockDir), false, "successor release removes only its own quarantined inode");
  assertions += 1;

  const releaseRaceDir = path.join(root, ".release-race.lock");
  const releaseOldQuarantine = path.join(root, ".release-race.old");
  const releaseSuccessor = canonicalOwner({
    token: "00000000-0000-4000-8000-000000000202",
    pid: process.pid,
  });
  let releaseRaceInjected = false;
  const owned = acquirePointerCommitLock({
    lockDir: releaseRaceDir,
    timeoutMs: 100,
    pointerLockTestHook(point) {
      if (point !== "before-owner-claim" || releaseRaceInjected) return;
      releaseRaceInjected = true;
      fs.renameSync(releaseRaceDir, releaseOldQuarantine);
      writeOwner(releaseRaceDir, releaseSuccessor);
    },
  });
  owned.release();
  assert.equal(releaseRaceInjected, true, "release race hook replaced the original inode before claim");
  assertions += 1;
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(releaseRaceDir, "owner.json"), "utf8")).token,
    releaseSuccessor.token,
    "old handle release preserves and restores a replacement live successor",
  );
  assertions += 1;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "data-generation-pointer-lock-aba-v1",
    assertions,
    waiterOutcome,
    successorToken: successorOwner.token,
  }, null, 2)}\n`);
} finally {
  try { fs.writeFileSync(successorReleasePath, "release", { flag: "a" }); } catch { /* best effort */ }
  for (const child of children) {
    try { child.kill(); } catch { /* already exited */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
