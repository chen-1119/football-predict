const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireSyncLock } = require("../server/syncLock.cjs");
const {
  acquireAndInitializeBarrier,
  cleanupDeadOwnedLock,
  releaseOwnedLock,
} = require("./runReleaseSyncWriteBarrier.cjs");

const helperPath = path.resolve(__dirname, "runReleaseSyncWriteBarrier.cjs");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (predicate, message, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(message);
};

const waitForExit = (child, timeoutMs = 5_000) => new Promise((resolve, reject) => {
  if (child.exitCode != null) {
    resolve({ code: child.exitCode, signal: child.signalCode });
    return;
  }
  const timeout = setTimeout(() => reject(new Error("write barrier helper did not exit")), timeoutMs);
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    resolve({ code, signal });
  });
});

const startBarrier = ({ storeDir, controlFile, waitMs = 1_000 }) => spawn(
  process.execPath,
  [
    helperPath,
    "--store-dir", storeDir,
    "--lock-dir", path.join(storeDir, "locks", "sync.lock"),
    "--control-file", controlFile,
    "--owner", "release-live-sqlite-prebuild",
    "--source", "signed-release-test",
    "--wait-ms", String(waitMs),
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

const main = async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-sync-write-barrier-"));
  const storeDir = path.join(tempRoot, "store");
  const runtimeDir = path.join(tempRoot, "runtime");
  const controlFile = path.join(runtimeDir, "barrier-status.json");
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);

  let child = null;
  let held = null;
  try {
    child = startBarrier({ storeDir, controlFile });
    await waitFor(
      () => fs.existsSync(controlFile) && fs.existsSync(path.join(storeDir, "locks", "sync.lock", "lock.json")),
      "write barrier did not publish ownership evidence",
    );
    const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
    assert.equal(control.version, "release-sync-write-barrier-v1");
    assert.equal(control.state, "HELD");
    assert.equal(control.pid, child.pid);

    const denied = await acquireSyncLock({
      lockDir: path.join(storeDir, "locks", "sync.lock"),
      owner: "competing-writer",
      source: "verification",
      waitMs: 0,
    });
    assert.equal(denied.acquired, false);
    assert.equal(denied.reason, "sync lock held");

    child.kill("SIGTERM");
    const cleanExit = await waitForExit(child);
    if (process.platform === "win32") {
      // Windows implements child.kill via TerminateProcess, so Node cannot run
      // the POSIX SIGTERM release handler.  The shared lock implementation must
      // still reclaim the now-dead owner without weakening live-owner checks.
      assert.equal(cleanExit.signal, "SIGTERM");
      const recovered = await acquireSyncLock({
        lockDir: path.join(storeDir, "locks", "sync.lock"),
        owner: "post-terminate-recovery",
        source: "verification",
        waitMs: 1_000,
      });
      assert.equal(recovered.acquired, true);
      await recovered.release();
    } else {
      assert.equal(cleanExit.code, 0);
    }
    assert.equal(fs.existsSync(path.join(storeDir, "locks", "sync.lock")), false);
    child = null;

    fs.rmSync(controlFile, { force: true });
    held = await acquireSyncLock({
      lockDir: path.join(storeDir, "locks", "sync.lock"),
      owner: "in-flight-writer",
      source: "verification",
      waitMs: 0,
    });
    assert.equal(held.acquired, true);
    child = startBarrier({ storeDir, controlFile, waitMs: 50 });
    const busyExit = await waitForExit(child);
    assert.equal(busyExit.code, 1);
    assert.equal(fs.existsSync(controlFile), false);
    const lockInfo = JSON.parse(fs.readFileSync(path.join(storeDir, "locks", "sync.lock", "lock.json"), "utf8"));
    assert.equal(lockInfo.owner, "in-flight-writer", "a timed-out barrier must not remove the live writer lock");
    child = null;
    await held.release();
    held = null;

    held = await acquireSyncLock({
      lockDir: path.join(storeDir, "locks", "sync.lock"),
      owner: "publisher-before-handoff",
      source: "verification",
      waitMs: 0,
    });
    assert.equal(held.acquired, true);
    fs.rmSync(controlFile, { force: true });
    child = startBarrier({ storeDir, controlFile, waitMs: 1_000 });
    await sleep(100);
    assert.equal(fs.existsSync(controlFile), false);
    await held.release();
    held = null;
    await waitFor(() => fs.existsSync(controlFile), "waiting barrier did not take over after publisher release");
    child.kill("SIGTERM");
    await waitForExit(child);
    child = null;
    if (fs.existsSync(path.join(storeDir, "locks", "sync.lock"))) {
      const recovered = await acquireSyncLock({
        lockDir: path.join(storeDir, "locks", "sync.lock"),
        owner: "post-waiter-terminate-recovery",
        source: "verification",
        waitMs: 1_000,
      });
      assert.equal(recovered.acquired, true);
      await recovered.release();
    }

    fs.rmSync(controlFile, { force: true });
    await assert.rejects(
      acquireAndInitializeBarrier({
        storeDir,
        lockDir: path.join(storeDir, "locks", "sync.lock"),
        controlFile,
        owner: "release-live-sqlite-prebuild",
        source: "signed-release-test",
        waitMs: 0,
      }, {
        writeControl: () => { throw new Error("injected control write failure"); },
      }),
      /injected control write failure/u,
    );
    assert.equal(fs.existsSync(path.join(storeDir, "locks", "sync.lock")), false);

    const initialized = await acquireAndInitializeBarrier({
      storeDir,
      lockDir: path.join(storeDir, "locks", "sync.lock"),
      controlFile,
      owner: "release-live-sqlite-prebuild",
      source: "signed-release-test",
      waitMs: 0,
    });
    const foreignIdentity = {
      version: 1,
      owner: "foreign-writer",
      source: "foreign-source",
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      lockDir: path.join(storeDir, "locks", "sync.lock"),
    };
    fs.writeFileSync(
      path.join(storeDir, "locks", "sync.lock", "lock.json"),
      `${JSON.stringify(foreignIdentity)}\n`,
    );
    await assert.rejects(
      releaseOwnedLock(initialized.lock, initialized.expected),
      /ownership changed before release/u,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(storeDir, "locks", "sync.lock", "lock.json"), "utf8")).owner,
      "foreign-writer",
    );
    fs.rmSync(path.join(storeDir, "locks", "sync.lock"), { recursive: true, force: true });
    fs.rmSync(controlFile, { force: true });

    const deadPid = 2_147_483_000;
    fs.chmodSync(path.join(storeDir, "locks"), 0o700);
    const makeSyntheticLock = (owner, { directoryMode = 0o700, fileMode = 0o600 } = {}) => {
      const lockDir = path.join(storeDir, "locks", "sync.lock");
      fs.mkdirSync(lockDir, { mode: directoryMode });
      fs.chmodSync(lockDir, directoryMode);
      const lockFile = path.join(lockDir, "lock.json");
      fs.writeFileSync(lockFile, `${JSON.stringify({
        version: 1,
        owner,
        source: "signed-release-test",
        pid: deadPid,
        hostname: os.hostname(),
        startedAt: new Date(0).toISOString(),
        lockDir,
      })}\n`, { mode: fileMode });
      fs.chmodSync(lockFile, fileMode);
      return lockDir;
    };
    const deadOwnedDir = makeSyntheticLock("release-live-sqlite-prebuild");
    const deadCleanup = cleanupDeadOwnedLock({
      storeDir,
      lockDir: deadOwnedDir,
      owner: "release-live-sqlite-prebuild",
      source: "signed-release-test",
      pid: deadPid,
    });
    assert.equal(deadCleanup.removed, true);
    assert.equal(fs.existsSync(deadOwnedDir), false);
    const foreignDir = makeSyntheticLock("foreign-writer");
    const foreignCleanup = cleanupDeadOwnedLock({
      storeDir,
      lockDir: foreignDir,
      owner: "release-live-sqlite-prebuild",
      source: "signed-release-test",
      pid: deadPid,
    });
    assert.equal(foreignCleanup.reason, "foreign-lock");
    assert.equal(fs.existsSync(foreignDir), true, "strong cleanup must preserve a foreign lock");
    fs.rmSync(foreignDir, { recursive: true, force: true });
    const relaxedForeignDir = makeSyntheticLock("active-worker", {
      directoryMode: 0o750,
      fileMode: 0o640,
    });
    const relaxedForeignCleanup = cleanupDeadOwnedLock({
      storeDir,
      lockDir: relaxedForeignDir,
      owner: "release-live-sqlite-prebuild",
      source: "signed-release-test",
      pid: deadPid,
    });
    assert.equal(relaxedForeignCleanup.reason, "foreign-lock");
    assert.equal(
      fs.existsSync(relaxedForeignDir),
      true,
      "cleanup must preserve a structurally safe worker lock created under the production umask",
    );
    fs.rmSync(relaxedForeignDir, { recursive: true, force: true });

    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: "release-sync-write-barrier-verification-v1",
      checks: [
        "canonical lock held",
        "competing writer denied",
        "ownership-checked release",
        "busy acquisition fails closed",
        "waiting publisher handoff",
        "control write failure releases own lock",
        "foreign ownership replacement is preserved",
        "dead own lock cleanup preserves foreign lock",
        "production-umask foreign lock is inspected without mutation",
      ],
    }, null, 2)}\n`);
  } finally {
    if (child?.pid && child.exitCode == null) child.kill("SIGKILL");
    await held?.release?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
