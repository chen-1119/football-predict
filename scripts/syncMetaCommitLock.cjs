const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const processIsAlive = (pid) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const readOwner = (lockDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
};

const staleLockCanBeRemoved = (lockDir, staleMs) => {
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs <= staleMs) return false;
  } catch {
    return true;
  }
  const owner = readOwner(lockDir);
  if (!owner) return true;
  if (owner.hostname && owner.hostname !== os.hostname()) return false;
  return !processIsAlive(owner.pid);
};

const acquireSyncMetaCommitLock = ({
  filePath,
  waitMs = Math.max(1000, Number(process.env.SYNC_META_COMMIT_LOCK_WAIT_MS || 30_000)),
  staleMs = Math.max(10_000, Number(process.env.SYNC_META_COMMIT_LOCK_STALE_MS || 120_000)),
  pollMs = 25,
} = {}) => {
  if (!filePath) throw new Error("sync-meta commit lock requires filePath");
  const lockDir = `${path.resolve(filePath)}.commit.lock`;
  const startedAt = Date.now();
  const token = crypto.randomBytes(12).toString("hex");

  while (true) {
    try {
      fs.mkdirSync(path.dirname(lockDir), { recursive: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      })}\n`, "utf8");
      let released = false;
      return {
        lockDir,
        release: () => {
          if (released) return;
          released = true;
          const owner = readOwner(lockDir);
          if (!owner || owner.token === token) {
            fs.rmSync(lockDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (staleLockCanBeRemoved(lockDir, staleMs)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= waitMs) {
        const timeout = new Error(`sync-meta commit lock timeout: ${lockDir}`);
        timeout.code = "SYNC_META_COMMIT_LOCK_TIMEOUT";
        throw timeout;
      }
      sleepSync(Math.max(10, Number(pollMs || 25)));
    }
  }
};

module.exports = {
  acquireSyncMetaCommitLock,
};
