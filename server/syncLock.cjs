const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const defaultStoreDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(__dirname, "..", "server-data"));
const defaultLockDir = path.join(defaultStoreDir, "locks", "sync.lock");
const defaultStaleMs = Math.max(1, Number(process.env.SYNC_LOCK_STALE_MINUTES || 30)) * 60 * 1000;
const defaultWaitMs = Math.max(0, Number(process.env.SYNC_LOCK_WAIT_MS || 0));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readLockInfo = async (lockDir) => {
  try {
    return JSON.parse(await fsp.readFile(path.join(lockDir, "lock.json"), "utf8"));
  } catch {
    return null;
  }
};

const writeLockInfo = async (lockDir, info) => {
  await fsp.writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
};

const removeLockDir = async (lockDir) => {
  await fsp.rm(lockDir, { recursive: true, force: true });
};

const lockAgeMs = async (lockDir, info) => {
  const startedAt = Date.parse(info?.startedAt || "");
  if (Number.isFinite(startedAt)) return Date.now() - startedAt;
  try {
    const stat = await fsp.stat(lockDir);
    return Date.now() - stat.mtimeMs;
  } catch {
    return 0;
  }
};

const acquireSyncLock = async ({
  lockDir = defaultLockDir,
  owner = "sync",
  source = "unknown",
  staleMs = defaultStaleMs,
  waitMs = defaultWaitMs,
  pollMs = 250
} = {}) => {
  const startedWait = Date.now();
  const resolvedLockDir = path.resolve(lockDir);

  while (true) {
    try {
      await fsp.mkdir(path.dirname(resolvedLockDir), { recursive: true });
      await fsp.mkdir(resolvedLockDir);
      const info = {
        version: 1,
        owner,
        source,
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        lockDir: resolvedLockDir
      };
      await writeLockInfo(resolvedLockDir, info);
      let released = false;
      return {
        acquired: true,
        info,
        lockDir: resolvedLockDir,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readLockInfo(resolvedLockDir);
          if (!current || current.pid === process.pid) {
            await removeLockDir(resolvedLockDir);
          }
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await readLockInfo(resolvedLockDir);
      const ageMs = await lockAgeMs(resolvedLockDir, info);
      if (ageMs > staleMs) {
        await removeLockDir(resolvedLockDir);
        continue;
      }
      if (Date.now() - startedWait >= waitMs) {
        return {
          acquired: false,
          lockDir: resolvedLockDir,
          info,
          ageMs,
          staleMs,
          reason: "sync lock held"
        };
      }
      await sleep(Math.max(50, pollMs));
    }
  }
};

module.exports = {
  acquireSyncLock,
  readLockInfo,
  defaultLockDir
};
