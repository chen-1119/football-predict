#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { acquireSyncLock, readLockInfo } = require("../server/syncLock.cjs");

const CONTROL_VERSION = "release-sync-write-barrier-v1";

const fail = (message) => {
  const error = new Error(message);
  error.code = "RELEASE_SYNC_WRITE_BARRIER_INVALID";
  throw error;
};

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = String(argv[index] || "");
    const value = argv[index + 1];
    if (!key.startsWith("--") || value == null || values.has(key)) fail(`invalid argument: ${key}`);
    values.set(key, String(value));
  }
  return values;
};

const requiredPath = (values, name) => {
  const value = values.get(name);
  if (!value) fail(`missing ${name}`);
  return path.resolve(value);
};

const requiredText = (values, name) => {
  const value = String(values.get(name) || "").trim();
  if (!value) fail(`missing ${name}`);
  return value;
};

const boundedInteger = (values, name, minimum, maximum) => {
  const value = Number(values.get(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
};

const barrierOptions = (values, { requireControlFile = true, requireWaitMs = true } = {}) => {
  const storeDir = requiredPath(values, "--store-dir");
  const lockDir = requiredPath(values, "--lock-dir");
  const expectedLockDir = path.join(storeDir, "locks", "sync.lock");
  if (lockDir !== expectedLockDir) fail("write barrier must use the canonical live sync lock");
  return {
    storeDir,
    lockDir,
    controlFile: requireControlFile ? requiredPath(values, "--control-file") : null,
    owner: requiredText(values, "--owner"),
    source: requiredText(values, "--source"),
    waitMs: requireWaitMs ? boundedInteger(values, "--wait-ms", 0, 1_200_000) : null,
  };
};

const assertPrivateRuntimeDirectory = (controlFile) => {
  const directory = path.dirname(controlFile);
  const stat = fs.lstatSync(directory, { bigint: true });
  const privateMode = process.platform === "win32" || (stat.mode & 0o777n) === 0o700n;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n || !privateMode) {
    fail("control file parent must be a private real directory");
  }
  if (fs.existsSync(controlFile)) fail("control file must not already exist");
};

const writeControlFile = (controlFile, payload) => {
  const temporary = `${controlFile}.${process.pid}.tmp`;
  let descriptor;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    temporaryCreated = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, controlFile);
  } catch (error) {
    if (descriptor != null) fs.closeSync(descriptor);
    if (temporaryCreated) fs.rmSync(temporary, { force: true });
    throw error;
  }
  const directoryDescriptor = fs.openSync(path.dirname(controlFile), fs.constants.O_RDONLY);
  try {
    try {
      fs.fsyncSync(directoryDescriptor);
    } catch (error) {
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    }
  } finally {
    fs.closeSync(directoryDescriptor);
  }
};

const lockIdentityMatches = (current, expected) => Boolean(
  current
  && current.pid === expected.pid
  && current.owner === expected.owner
  && current.source === expected.source
  && current.lockDir === expected.lockDir
);

const releaseOwnedLock = async (lock, expected) => {
  const current = await readLockInfo(expected.lockDir);
  if (!current) return { released: false, reason: "lock-missing" };
  if (!lockIdentityMatches(current, expected)) {
    const error = new Error("live sync write barrier ownership changed before release");
    error.code = "RELEASE_SYNC_WRITE_BARRIER_OWNERSHIP_CHANGED";
    throw error;
  }
  await lock.release();
  return { released: true, reason: "released" };
};

const acquireAndInitializeBarrier = async (options, { writeControl = writeControlFile } = {}) => {
  const {
    storeDir, lockDir, controlFile, owner, source, waitMs,
  } = options;
  assertPrivateRuntimeDirectory(controlFile);
  const lock = await acquireSyncLock({ lockDir, owner, source, waitMs, pollMs: 100 });
  if (!lock.acquired) {
    const error = new Error(`could not acquire live sync write barrier: ${lock.reason || "lock held"}`);
    error.code = "RELEASE_SYNC_WRITE_BARRIER_BUSY";
    throw error;
  }
  const expected = { pid: process.pid, owner, source, lockDir };
  try {
    const current = await readLockInfo(lockDir);
    if (!lockIdentityMatches(current, expected)) {
      fail("live sync write barrier ownership could not be verified");
    }
    fs.chmodSync(lockDir, 0o700);
    fs.chmodSync(path.join(lockDir, "lock.json"), 0o600);
    assertOwnedLockPath(lockDir);
    const payload = {
      version: CONTROL_VERSION,
      state: "HELD",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      storeDir,
      lockDir,
      owner,
      source,
    };
    writeControl(controlFile, payload);
    return { lock, expected, payload };
  } catch (error) {
    try {
      await releaseOwnedLock(lock, expected);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "write barrier initialization failed and its lock ownership changed during cleanup",
      );
    }
    throw error;
  }
};

const readStructurallySafeLockIdentity = (lockDir) => {
  const parentStat = fs.lstatSync(path.dirname(lockDir), { bigint: true });
  const lockStat = fs.lstatSync(lockDir, { bigint: true });
  const lockFile = path.join(lockDir, "lock.json");
  const lockFileStat = fs.lstatSync(lockFile, { bigint: true });
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  const ownerMatches = expectedUid == null
    || (parentStat.uid === expectedUid && lockStat.uid === expectedUid && lockFileStat.uid === expectedUid);
  const parentNotWritable = process.platform === "win32" || (parentStat.mode & 0o022n) === 0n;
  const directoryNotWritable = process.platform === "win32" || (lockStat.mode & 0o022n) === 0n;
  const fileNotWritable = process.platform === "win32" || (lockFileStat.mode & 0o022n) === 0n;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.nlink < 1n
      || !parentNotWritable
      || !lockStat.isDirectory() || lockStat.isSymbolicLink() || lockStat.nlink < 1n
      || !directoryNotWritable
      || !lockFileStat.isFile() || lockFileStat.isSymbolicLink() || lockFileStat.nlink !== 1n
      || !fileNotWritable || !ownerMatches
      || fs.readdirSync(lockDir).some((entry) => entry !== "lock.json")) {
    fail("canonical sync lock path is unsafe for identity inspection");
  }
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    fail("canonical sync lock identity is unreadable");
  }
};

const assertOwnedLockPath = (lockDir) => {
  const parentStat = fs.lstatSync(path.dirname(lockDir), { bigint: true });
  const lockStat = fs.lstatSync(lockDir, { bigint: true });
  const lockFile = path.join(lockDir, "lock.json");
  const lockFileStat = fs.lstatSync(lockFile, { bigint: true });
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  const privateParent = process.platform === "win32" || (parentStat.mode & 0o777n) === 0o700n;
  const privateDirectory = process.platform === "win32" || (lockStat.mode & 0o777n) === 0o700n;
  const privateFile = process.platform === "win32" || (lockFileStat.mode & 0o777n) === 0o600n;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.nlink < 1n
      || !privateParent || (expectedUid != null && parentStat.uid !== expectedUid)
      || !lockStat.isDirectory() || lockStat.isSymbolicLink() || lockStat.nlink < 1n
      || !privateDirectory || (expectedUid != null && lockStat.uid !== expectedUid)
      || !lockFileStat.isFile() || lockFileStat.isSymbolicLink() || lockFileStat.nlink !== 1n
      || !privateFile || (expectedUid != null && lockFileStat.uid !== expectedUid)
      || fs.readdirSync(lockDir).some((entry) => entry !== "lock.json")) {
    fail("canonical sync lock path is unsafe for owned cleanup");
  }
  return { lockStat, lockFile };
};

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
};

const cleanupDeadOwnedLock = ({ storeDir, lockDir, owner, source, pid }) => {
  if (lockDir !== path.join(storeDir, "locks", "sync.lock")) {
    fail("owned cleanup must use the canonical live sync lock");
  }
  if (!fs.existsSync(lockDir)) return { removed: false, reason: "lock-missing" };
  const expected = { pid, owner, source, lockDir };
  const current = readStructurallySafeLockIdentity(lockDir);
  if (!lockIdentityMatches(current, expected)) return { removed: false, reason: "foreign-lock" };
  const { lockStat, lockFile } = assertOwnedLockPath(lockDir);
  if (processIsAlive(pid)) return { removed: false, reason: "owner-alive" };

  const parent = path.dirname(lockDir);
  const quarantine = path.join(parent, `.sync.lock.release-cleanup-${process.pid}-${Date.now()}`);
  fs.renameSync(lockDir, quarantine);
  const movedStat = fs.lstatSync(quarantine, { bigint: true });
  const sameDirectory = movedStat.dev === lockStat.dev && movedStat.ino === lockStat.ino;
  const movedLockFile = path.join(quarantine, "lock.json");
  let movedIdentity = null;
  try {
    movedIdentity = JSON.parse(fs.readFileSync(movedLockFile, "utf8"));
  } catch {
    movedIdentity = null;
  }
  if (!sameDirectory || !lockIdentityMatches(movedIdentity, expected)) {
    if (!fs.existsSync(lockDir)) fs.renameSync(quarantine, lockDir);
    fail("sync lock changed during owned cleanup quarantine");
  }
  assertOwnedLockPath(quarantine);
  fs.rmSync(quarantine, { recursive: true, force: false });
  const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
  try {
    try {
      fs.fsyncSync(parentDescriptor);
    } catch (error) {
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    }
  } finally {
    fs.closeSync(parentDescriptor);
  }
  return { removed: true, reason: "dead-owned-lock-removed" };
};

const main = async () => {
  const [commandOrArg, ...rest] = process.argv.slice(2);
  if (commandOrArg === "cleanup-dead-owned") {
    const values = parseArgs(rest);
    const options = barrierOptions(values, { requireControlFile: false, requireWaitMs: false });
    const pid = boundedInteger(values, "--pid", 1, 2_147_483_647);
    const result = cleanupDeadOwnedLock({ ...options, pid });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.reason === "foreign-lock" || result.reason === "owner-alive") process.exitCode = 3;
    return;
  }
  const argv = commandOrArg == null ? [] : [commandOrArg, ...rest];
  const options = barrierOptions(parseArgs(argv));
  const { lock, expected } = await acquireAndInitializeBarrier(options);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      await releaseOwnedLock(lock, expected);
      process.exit(0);
    } catch (error) {
      console.error(error.stack || error.message || String(error));
      process.exit(signal ? 1 : 2);
    }
  };

  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGHUP", () => void stop("SIGHUP"));

  // The transient systemd unit owns this process.  The timer keeps the event
  // loop alive without touching the live store; SIGTERM performs an
  // ownership-checked release through the same syncLock implementation used by
  // every production writer.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  CONTROL_VERSION,
  acquireAndInitializeBarrier,
  assertPrivateRuntimeDirectory,
  cleanupDeadOwnedLock,
  lockIdentityMatches,
  parseArgs,
  readStructurallySafeLockIdentity,
  releaseOwnedLock,
};
