const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const defaultStoreDir = path.resolve(process.env.SERVER_STORE_DIR || path.join(__dirname, "..", "server-data"));
const defaultLockDir = path.join(defaultStoreDir, "locks", "sync.lock");
const defaultStaleMs = Math.max(1, Number(process.env.SYNC_LOCK_STALE_MINUTES || 30)) * 60 * 1000;
const defaultMetadataGraceMs = Math.max(
  1,
  Number(process.env.SYNC_LOCK_METADATA_GRACE_SECONDS || 10)
) * 1000;
const defaultWaitMs = Math.max(0, Number(process.env.SYNC_LOCK_WAIT_MS || 0));
const publicationBarrierMaxStaleMs = 30 * 60 * 1000;

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

const inspectLockOwner = (info) => {
  if (!info || typeof info !== "object") return { status: "missing" };
  if (info.hostname && info.hostname !== os.hostname()) {
    return { status: "foreign-host", hostname: info.hostname };
  }
  const pid = Number(info.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { status: "invalid-pid", pid: null };
  try {
    process.kill(pid, 0);
    return { status: "alive", pid };
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "dead", pid };
    return { status: "unknown", pid, error: error?.code || error?.message || String(error) };
  }
};

const inspectSyncLockActivity = ({
  lockDir = defaultLockDir,
  staleMs = Math.min(defaultStaleMs, publicationBarrierMaxStaleMs),
  metadataGraceMs = defaultMetadataGraceMs,
  nowMs = Date.now(),
  inspectOwner = inspectLockOwner,
} = {}) => {
  const resolvedLockDir = path.resolve(lockDir);
  let stat;
  try {
    stat = fs.statSync(resolvedLockDir);
  } catch {
    return { active: false, reason: "lock-missing", lockDir: resolvedLockDir, ageMs: null };
  }
  if (!stat.isDirectory()) {
    return { active: false, reason: "lock-not-directory", lockDir: resolvedLockDir, ageMs: null };
  }
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(path.join(resolvedLockDir, "lock.json"), "utf8"));
  } catch {
    info = null;
  }
  const startedAtMs = Date.parse(info?.startedAt || "");
  const ageMs = Math.max(0, nowMs - (Number.isFinite(startedAtMs) ? startedAtMs : stat.mtimeMs));
  const safeStaleMs = Math.min(
    publicationBarrierMaxStaleMs,
    Math.max(1, Number(staleMs) || publicationBarrierMaxStaleMs),
  );
  const safeMetadataGraceMs = Math.max(1, Number(metadataGraceMs) || defaultMetadataGraceMs);
  const owner = inspectOwner(info);
  if (ageMs > safeStaleMs) {
    return { active: false, reason: "lock-stale", lockDir: resolvedLockDir, ageMs, info, owner };
  }
  if (["missing", "invalid-pid"].includes(owner.status)) {
    return {
      active: ageMs <= safeMetadataGraceMs,
      reason: ageMs <= safeMetadataGraceMs ? "metadata-grace" : "metadata-orphan",
      lockDir: resolvedLockDir,
      ageMs,
      info,
      owner,
    };
  }
  if (owner.status === "dead") {
    return { active: false, reason: "owner-dead", lockDir: resolvedLockDir, ageMs, info, owner };
  }
  return { active: true, reason: owner.status, lockDir: resolvedLockDir, ageMs, info, owner };
};

const syncLockActive = (options = {}) => inspectSyncLockActivity(options).active;

const acquireSyncLock = async ({
  lockDir = defaultLockDir,
  owner = "sync",
  source = "unknown",
  staleMs = defaultStaleMs,
  metadataGraceMs = defaultMetadataGraceMs,
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
      const owner = inspectLockOwner(info);
      const metadataOrphan = ageMs > metadataGraceMs
        && ["missing", "invalid-pid"].includes(owner.status);
      if (owner.status === "dead" || metadataOrphan) {
        await removeLockDir(resolvedLockDir);
        continue;
      }
      if (Date.now() - startedWait >= waitMs) {
        return {
          acquired: false,
          lockDir: resolvedLockDir,
          info,
          owner,
          ageMs,
          staleMs,
          metadataGraceMs,
          reason: "sync lock held"
        };
      }
      await sleep(Math.max(50, pollMs));
    }
  }
};

module.exports = {
  acquireSyncLock,
  inspectSyncLockActivity,
  readLockInfo,
  defaultLockDir,
  defaultMetadataGraceMs,
  defaultStaleMs,
  publicationBarrierMaxStaleMs,
  syncLockActive,
};
