const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");

const argv = new Set(process.argv.slice(2));
const apply = process.env.SERVER_CLEANUP_APPLY === "1" || argv.has("--apply");
const appDir = path.resolve(process.env.SERVER_CLEANUP_APP_DIR || "/opt/football-predict");
const storeDir = path.resolve(process.env.SERVER_CLEANUP_STORE_DIR || process.env.SERVER_STORE_DIR || "/var/lib/football-predict");
const tmpDir = path.resolve(process.env.SERVER_CLEANUP_TMP_DIR || "/tmp");
const backupRetentionDays = Math.max(1, Number(process.env.SERVER_CLEANUP_BACKUP_RETENTION_DAYS || 7));
const appBackupKeep = Math.max(1, Number(process.env.SERVER_CLEANUP_APP_BACKUP_KEEP || 2));
const releaseArchiveRetentionDays = Math.max(1, Number(process.env.SERVER_CLEANUP_RELEASE_ARCHIVE_RETENTION_DAYS || backupRetentionDays));
const releaseArchiveKeep = Math.max(1, Number(process.env.SERVER_CLEANUP_RELEASE_ARCHIVE_KEEP || 8));
const distBackupRetentionDays = Math.max(1, Number(process.env.SERVER_CLEANUP_DIST_BACKUP_RETENTION_DAYS || backupRetentionDays));
const distBackupKeep = Math.max(1, Number(process.env.SERVER_CLEANUP_DIST_BACKUP_KEEP || 1));
const sqliteBackupRetentionDays = Math.max(1, Number(process.env.SERVER_CLEANUP_SQLITE_BACKUP_RETENTION_DAYS || 7));
const sqliteBackupKeep = Math.max(1, Number(process.env.SERVER_CLEANUP_SQLITE_BACKUP_KEEP || 3));
const sqliteBackupCompressDays = Math.max(1, Number(process.env.SERVER_CLEANUP_SQLITE_BACKUP_COMPRESS_DAYS || 1));
const currentSnapshotRetentionDays = Math.max(1, Number(process.env.SERVER_CLEANUP_CURRENT_SNAPSHOT_RETENTION_DAYS || process.env.SNAPSHOT_RETENTION_DAYS || 2));
const currentSnapshotKeep = Math.max(1, Number(process.env.SERVER_CLEANUP_CURRENT_SNAPSHOT_KEEP || process.env.SNAPSHOT_RETENTION_MAX_FILES || 96));
const currentSnapshotUncompressedKeep = Math.max(1, Number(process.env.SERVER_CLEANUP_CURRENT_SNAPSHOT_UNCOMPRESSED_KEEP || 24));
const currentSnapshotCompressAgeHours = Math.max(1, Number(process.env.SERVER_CLEANUP_CURRENT_SNAPSHOT_COMPRESS_AGE_HOURS || 12));
const dataBackupCompressDays = Math.max(1, Number(process.env.SERVER_CLEANUP_DATA_BACKUP_COMPRESS_DAYS || 1));
const logRetentionDays = Math.max(1, Number(process.env.SERVER_CLEANUP_LOG_RETENTION_DAYS || 14));
const tmpMinAgeMinutes = Math.max(0, Number(process.env.SERVER_CLEANUP_TMP_MIN_AGE_MINUTES || 10));
// The production oneshot runs as the unprivileged football account and only mutates
// its state directory. Root-owned release trees, backups, host /tmp and /var/log
// are deliberately audit-only/disabled instead of widening cleanup privileges.
const cleanupAppBackups = process.env.SERVER_CLEANUP_APP_BACKUPS === "1";
const cleanupAppArtifacts = process.env.SERVER_CLEANUP_APP_ARTIFACTS === "1";
const cleanupTmpArtifacts = process.env.SERVER_CLEANUP_TMP_ARTIFACTS === "1";
const cleanupSystemLogs = process.env.SERVER_CLEANUP_SYSTEM_LOGS === "1";
const stagingDir = path.join(storeDir, ".cleanup-staging");

const now = Date.now();
const dayMs = 24 * 60 * 60 * 1000;

const readDir = (dirPath) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
};

const lstatSafe = (filePath) => {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
};

const ageDays = (stat) => stat ? (now - stat.mtimeMs) / dayMs : Infinity;
const ageHours = (stat) => stat ? (now - stat.mtimeMs) / (60 * 60 * 1000) : Infinity;

const pathSizeSafe = (filePath) => {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return 0;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  return readDir(filePath).reduce((sum, entry) => sum + pathSizeSafe(path.join(filePath, entry.name)), stat.size);
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isInside = (target, root) => {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const allowedRoots = [
  path.dirname(appDir),
  storeDir,
  tmpDir,
  "/var/log"
].map((item) => path.resolve(item));

const isSafeTarget = (target) => {
  const resolved = path.resolve(target);
  if (["/", "/opt", "/tmp", "/var", "/var/lib", "/var/log", appDir, storeDir].includes(resolved)) return false;
  return allowedRoots.some((root) => isInside(resolved, root));
};

const candidates = [];

const addCandidate = (filePath, category, reason, options = {}) => {
  const resolved = path.resolve(filePath);
  const stat = lstatSafe(resolved);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    candidates.push({
      path: resolved,
      category,
      reason,
      skipped: true,
      skipReason: "symbolic-link"
    });
    return;
  }
  if (!isSafeTarget(resolved)) {
    candidates.push({
      path: resolved,
      category,
      reason,
      skipped: true,
      skipReason: "unsafe-target"
    });
    return;
  }
  candidates.push({
    path: resolved,
    category,
    reason,
    action: options.action || "remove",
    targetPath: options.targetPath ? path.resolve(options.targetPath) : null,
    type: stat.isDirectory() ? "directory" : "file",
    bytes: pathSizeSafe(resolved),
    mtime: stat.mtime.toISOString(),
    ageDays: Number(ageDays(stat).toFixed(2)),
    recursive: Boolean(options.recursive),
    identity: {
      dev: String(stat.dev),
      ino: String(stat.ino)
    }
  });
};

const assertStoreRoot = () => {
  const stat = lstatSafe(storeDir);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`cleanup store root is missing or unsafe: ${storeDir}`);
  }
  if (fs.realpathSync(storeDir) !== storeDir) {
    throw new Error(`cleanup store root must be canonical: ${storeDir}`);
  }
};

const assertStoreFilePath = (filePath) => {
  const resolved = path.resolve(filePath);
  if (!isInside(resolved, storeDir)) {
    throw new Error(`cleanup apply is restricted to the state directory: ${resolved}`);
  }
  const parent = path.dirname(resolved);
  const parentStat = lstatSafe(parent);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`cleanup parent is missing or unsafe: ${parent}`);
  }
  const realParent = fs.realpathSync(parent);
  if (realParent !== storeDir && !isInside(realParent, storeDir)) {
    throw new Error(`cleanup parent escapes the state directory: ${parent}`);
  }
  return resolved;
};

const sameIdentity = (stat, identity) => Boolean(stat)
  && String(stat.dev) === String(identity?.dev)
  && String(stat.ino) === String(identity?.ino);

const stageCandidate = (item) => {
  const sourcePath = assertStoreFilePath(item.path);
  const before = lstatSafe(sourcePath);
  if (!before?.isFile() || before.isSymbolicLink() || !sameIdentity(before, item.identity)) {
    throw new Error(`cleanup candidate changed after collection: ${sourcePath}`);
  }
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const stagingStat = lstatSafe(stagingDir);
  if (!stagingStat?.isDirectory() || stagingStat.isSymbolicLink() || fs.realpathSync(stagingDir) !== stagingDir) {
    throw new Error(`cleanup staging directory is unsafe: ${stagingDir}`);
  }
  const stagedPath = path.join(stagingDir, `${crypto.randomUUID()}.staged`);
  // rename(2) moves the final directory entry without dereferencing it. The
  // inode check after the rename closes the lstat/remove substitution window.
  fs.renameSync(sourcePath, stagedPath);
  const staged = lstatSafe(stagedPath);
  if (!staged?.isFile() || staged.isSymbolicLink() || !sameIdentity(staged, item.identity)) {
    throw new Error(`cleanup candidate identity changed during staging: ${sourcePath}`);
  }
  return stagedPath;
};

const gzipStagedFile = async (stagedPath, targetPath, identity) => {
  const resolvedTarget = assertStoreFilePath(targetPath);
  if (lstatSafe(resolvedTarget)) throw new Error(`gzip target already exists: ${resolvedTarget}`);
  const tmpTarget = `${resolvedTarget}.tmp-${crypto.randomUUID()}`;
  let sourceHandle = null;
  try {
    sourceHandle = await fs.promises.open(stagedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile() || !sameIdentity(sourceStat, identity)) {
      throw new Error(`staged gzip source identity mismatch: ${stagedPath}`);
    }
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      zlib.createGzip({ level: 9 }),
      fs.createWriteStream(tmpTarget, { flags: "wx", mode: 0o600 })
    );
    await sourceHandle.close();
    sourceHandle = null;
    // link(2) is an atomic no-overwrite publication. A raced symlink or file at
    // the destination makes the operation fail instead of being overwritten.
    fs.linkSync(tmpTarget, resolvedTarget);
    fs.unlinkSync(tmpTarget);
    fs.unlinkSync(stagedPath);
  } catch (error) {
    if (sourceHandle) {
      try {
        await sourceHandle.close();
      } catch {
        // Best effort close after a failed compression.
      }
    }
    try {
      fs.unlinkSync(tmpTarget);
    } catch {
      // Best effort cleanup of an incomplete gzip file.
    }
    throw error;
  }
};

const collectTmpCandidates = () => {
  if (!cleanupTmpArtifacts) return;
  const exactNames = new Set([
    "env.example",
    "index.cjs",
    "pushSportteryRelaySnapshot.cjs",
    "verifyProductionPlanCoverage.cjs",
    "verifyProductionReadiness.cjs",
    "verifyApiContracts.cjs",
    "verifyRemotePublicReadiness.cjs",
    "verifyRemoteRefreshPipeline.cjs",
    "verifyRemoteRefreshPipelineContract.cjs",
    "verifySourceFallback.cjs",
    "verifyCloudSyncFreshness.cjs",
    "verifyDeploymentConfig.cjs",
    "runSyncWorker.cjs",
    "cleanupServerArtifacts.cjs",
    "light-server-deployment.md",
    "football-set-model-env.sh",
    "dist-fallback-ui.tgz",
    "AppContext.tsx",
    "AppContextCore.ts",
    "PredictionsList.tsx",
    "verifyFrontendObservability.cjs"
  ]);
  const diagnosticNames = new Set([
    "football-cleanup-last.log",
    "football-monitor-now.json",
    "football-server-index.cjs",
    "football-verify-live.json"
  ]);
  const addAgedTmpCandidate = (fullPath, category, reason, options = {}) => {
    const stat = lstatSafe(fullPath);
    const ageMinutes = stat ? (now - stat.mtimeMs) / 60000 : Infinity;
    if (ageMinutes >= tmpMinAgeMinutes) {
      addCandidate(fullPath, category, reason, options);
    }
  };
  for (const entry of readDir(tmpDir)) {
    const name = entry.name;
    const fullPath = path.join(tmpDir, name);
    if (diagnosticNames.has(name)) {
      addAgedTmpCandidate(fullPath, "tmp-diagnostic", "old football diagnostic scratch file");
      continue;
    }
    if (exactNames.has(name)) {
      addCandidate(fullPath, "tmp-upload", "deployment upload scratch file");
      continue;
    }
    if (/^(prod-readiness|perf-|health-after-).*\.(json|err)$/i.test(name) || name === "plan.json") {
      addCandidate(fullPath, "tmp-verification", "production verification scratch file");
      continue;
    }
    if (/^football-(predict|release|deploy|offline-release-kit)-/i.test(name) || /^football-cloud-data(?:-extract|\.tgz)$/i.test(name)) {
      addAgedTmpCandidate(fullPath, "tmp-football", "old football temporary artifact", { recursive: entry.isDirectory() });
    }
  }
};

const collectAppBackupCandidates = () => {
  if (!cleanupAppBackups) return;
  const appParent = path.dirname(appDir);
  const appBase = path.basename(appDir);
  readDir(appParent)
    .filter((entry) => entry.isDirectory())
    .filter((entry) => entry.name.startsWith(`${appBase}.hotfix-backup-`) || entry.name === `${appBase}.failed` || entry.name === `${appBase}.next`)
    .map((entry) => {
      const filePath = path.join(appParent, entry.name);
      return { entry, filePath, stat: lstatSafe(filePath) };
    })
    .filter((item) => item.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .forEach((item, index) => {
      if (index < appBackupKeep && ageDays(item.stat) < backupRetentionDays) return;
      const reason = index >= appBackupKeep
        ? `beyond newest ${appBackupKeep} app backups`
        : `older than ${backupRetentionDays}d`;
      addCandidate(item.filePath, "app-backup", reason, { recursive: item.entry.isDirectory() });
    });
};

const collectReleaseArchiveCandidates = () => {
  if (!cleanupAppBackups) return;
  const appParent = path.dirname(appDir);
  const appBase = path.basename(appDir);
  const archivePattern = new RegExp(`^${escapeRegExp(appBase)}\\..+-backup-\\d{8}-\\d{6}\\.tgz$`);
  readDir(appParent)
    .filter((entry) => entry.isFile() && archivePattern.test(entry.name))
    .map((entry) => {
      const filePath = path.join(appParent, entry.name);
      return { filePath, stat: lstatSafe(filePath) };
    })
    .filter((item) => item.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .forEach((item, index) => {
      if (index < releaseArchiveKeep && ageDays(item.stat) < releaseArchiveRetentionDays) return;
      const reason = index >= releaseArchiveKeep
        ? `beyond newest ${releaseArchiveKeep} release archives`
        : `older than ${releaseArchiveRetentionDays}d`;
      addCandidate(item.filePath, "release-archive", reason);
    });
};

const collectDistBackupCandidates = () => {
  if (!cleanupAppBackups) return;
  readDir(appDir)
    .filter((entry) => entry.isDirectory() && /^dist\.(bak|backup)-/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(appDir, entry.name);
      return { entry, filePath, stat: lstatSafe(filePath) };
    })
    .filter((item) => item.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .forEach((item, index) => {
      if (index < distBackupKeep && ageDays(item.stat) < distBackupRetentionDays) return;
      const reason = index >= distBackupKeep
        ? `beyond newest ${distBackupKeep} dist backups`
        : `older than ${distBackupRetentionDays}d`;
      addCandidate(item.filePath, "dist-backup", reason, { recursive: item.entry.isDirectory() });
    });
};

const collectAppArtifactCandidates = () => {
  if (!cleanupAppArtifacts) return;
  const appParent = path.dirname(appDir);
  const appBase = path.basename(appDir);
  const appNames = new Set([
    appBase,
    `${appBase}.previous`
  ]);
  readDir(appParent)
    .filter((entry) => entry.isDirectory())
    .filter((entry) => appNames.has(entry.name) || entry.name.startsWith(`${appBase}.hotfix-backup-`))
    .forEach((entry) => {
      const artifactsPath = path.join(appParent, entry.name, "artifacts");
      if (lstatSafe(artifactsPath)) {
        addCandidate(artifactsPath, "app-artifacts", "non-runtime generated artifacts excluded from production releases", {
          recursive: true
        });
      }
    });
};

const collectSqliteBackupCandidates = () => {
  const backups = readDir(storeDir)
    .filter((entry) => entry.isFile() && /^football\.db\.backup-/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(storeDir, entry.name);
      return { entry, filePath, stat: lstatSafe(filePath) };
    })
    .filter((item) => item.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  backups.forEach((item, index) => {
    if (index < sqliteBackupKeep) return;
    if (ageDays(item.stat) >= sqliteBackupRetentionDays) {
      addCandidate(item.filePath, "sqlite-backup", `older than ${sqliteBackupRetentionDays}d and beyond newest ${sqliteBackupKeep}`);
      return;
    }
    if (item.entry.name.endsWith(".gz") || ageDays(item.stat) < sqliteBackupCompressDays) return;
    const gzipPath = `${item.filePath}.gz`;
    if (fs.existsSync(gzipPath)) {
      addCandidate(item.filePath, "sqlite-backup-duplicate", "gzip backup already exists", { action: "remove" });
      return;
    }
    addCandidate(item.filePath, "sqlite-backup-compress", `older than ${sqliteBackupCompressDays}d and beyond newest ${sqliteBackupKeep}`, {
      action: "gzip",
      targetPath: gzipPath
    });
  });
};

const collectCurrentSnapshotCandidates = () => {
  const snapshotDir = path.join(storeDir, "snapshots");
  const snapshots = readDir(snapshotDir)
    .filter((entry) => entry.isFile() && /^current-.*\.json(?:\.gz)?$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(snapshotDir, entry.name);
      return { entry, filePath, stat: lstatSafe(filePath) };
    })
    .filter((item) => item.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  snapshots.forEach((item, index) => {
    if (index >= currentSnapshotKeep || ageDays(item.stat) >= currentSnapshotRetentionDays) {
      const reason = index >= currentSnapshotKeep
        ? `beyond newest ${currentSnapshotKeep} current snapshots`
        : `older than ${currentSnapshotRetentionDays}d`;
      addCandidate(item.filePath, "current-snapshot", reason);
      return;
    }
    if (item.entry.name.endsWith(".gz")) return;
    if (index < currentSnapshotUncompressedKeep || ageHours(item.stat) < currentSnapshotCompressAgeHours) return;
    const gzipPath = `${item.filePath}.gz`;
    if (fs.existsSync(gzipPath)) {
      addCandidate(item.filePath, "current-snapshot-duplicate", "gzip snapshot already exists", { action: "remove" });
      return;
    }
    addCandidate(item.filePath, "current-snapshot-compress", `older than ${currentSnapshotCompressAgeHours}h and beyond newest ${currentSnapshotUncompressedKeep} uncompressed current snapshots`, {
      action: "gzip",
      targetPath: gzipPath
    });
  });
};

const collectDataBackupCompressCandidates = () => {
  const dbDir = path.join(storeDir, "db");
  for (const entry of readDir(dbDir)) {
    if (!entry.isFile()) continue;
    if (!/\.(jsonl|json)\.bak-[^.]+$/i.test(entry.name)) continue;
    const filePath = path.join(dbDir, entry.name);
    const stat = lstatSafe(filePath);
    if (ageDays(stat) < dataBackupCompressDays) continue;
    const gzipPath = `${filePath}.gz`;
    if (fs.existsSync(gzipPath)) {
      addCandidate(filePath, "data-backup-duplicate", "gzip backup already exists", { action: "remove" });
      continue;
    }
    addCandidate(filePath, "data-backup-compress", `older than ${dataBackupCompressDays}d`, {
      action: "gzip",
      targetPath: gzipPath
    });
  }
};


const collectLogCandidates = () => {
  const logDirs = [path.join(storeDir, "logs")];
  if (cleanupAppBackups) logDirs.push(path.join(appDir, "logs"));
  if (cleanupSystemLogs) logDirs.push("/var/log/football-predict");
  for (const logDir of logDirs) {
    for (const entry of readDir(logDir)) {
      if (!entry.isFile()) continue;
      if (!/\.(log\.\d+|log-\d|bak-|old$|gz$)/i.test(entry.name)) continue;
      const fullPath = path.join(logDir, entry.name);
      const stat = lstatSafe(fullPath);
      if (ageDays(stat) >= logRetentionDays) {
        addCandidate(fullPath, "rotated-log", `older than ${logRetentionDays}d`);
      }
    }
  }
};

collectTmpCandidates();
collectAppBackupCandidates();
collectReleaseArchiveCandidates();
collectDistBackupCandidates();
collectAppArtifactCandidates();
collectSqliteBackupCandidates();
collectCurrentSnapshotCandidates();
collectDataBackupCompressCandidates();
collectLogCandidates();

const removable = candidates.filter((item) => !item.skipped);
const removed = [];
const compressed = [];
const failed = [];

const applyCleanup = async () => {
  assertStoreRoot();
  for (const item of removable) {
    let stagedPath = null;
    try {
      if (item.type !== "file" || item.recursive) {
        throw new Error(`cleanup apply refuses non-file candidate: ${item.path}`);
      }
      stagedPath = stageCandidate(item);
      if (item.action === "gzip") {
        await gzipStagedFile(stagedPath, item.targetPath, item.identity);
        stagedPath = null;
        const targetStat = lstatSafe(item.targetPath);
        compressed.push({
          ...item,
          targetBytes: targetStat ? targetStat.size : null
        });
      } else {
        fs.unlinkSync(stagedPath);
        stagedPath = null;
        removed.push(item);
      }
    } catch (error) {
      failed.push({
        ...item,
        stagedPath: stagedPath && lstatSafe(stagedPath) ? stagedPath : null,
        error: error.message || String(error)
      });
    }
  }
  try {
    fs.rmdirSync(stagingDir);
  } catch {
    // Preserve a non-empty quarantine for operator inspection after a race/failure.
  }
};

const byCategory = removable.reduce((acc, item) => {
  const bucket = acc[item.category] || { count: 0, bytes: 0 };
  bucket.count += 1;
  bucket.bytes += Number(item.bytes || 0);
  acc[item.category] = bucket;
  return acc;
}, {});

const buildPayload = () => ({
  ok: failed.length === 0,
  dryRun: !apply,
  checkedAt: new Date().toISOString(),
  policy: {
    appDir,
    storeDir,
    tmpDir,
    backupRetentionDays,
    appBackupKeep,
    releaseArchiveRetentionDays,
    releaseArchiveKeep,
    distBackupRetentionDays,
    distBackupKeep,
    sqliteBackupRetentionDays,
    sqliteBackupKeep,
    sqliteBackupCompressDays,
    currentSnapshotRetentionDays,
    currentSnapshotKeep,
    currentSnapshotUncompressedKeep,
    currentSnapshotCompressAgeHours,
    dataBackupCompressDays,
    logRetentionDays,
    tmpMinAgeMinutes,
    cleanupAppBackups,
    cleanupAppArtifacts,
    cleanupTmpArtifacts,
    cleanupSystemLogs,
    applyScope: storeDir,
    symlinkPolicy: "lstat-reject-atomic-stage-inode-verify",
    preserves: [
      appDir,
      `${appDir}.previous`,
      path.join(storeDir, "football.db"),
      path.join(storeDir, "db"),
      path.join(storeDir, "snapshots")
    ]
  },
  summary: {
    candidates: removable.length,
    skippedUnsafe: candidates.filter((item) => item.skipped).length,
    removed: removed.length,
    compressed: compressed.length,
    failed: failed.length,
    bytes: removable.reduce((sum, item) => sum + Number(item.bytes || 0), 0),
    compressedBytesBefore: compressed.reduce((sum, item) => sum + Number(item.bytes || 0), 0),
    compressedBytesAfter: compressed.reduce((sum, item) => sum + Number(item.targetBytes || 0), 0),
    byCategory
  },
  candidates: removable,
  removed: removed.map((item) => item.path),
  compressed: compressed.map((item) => ({
    path: item.path,
    targetPath: item.targetPath,
    bytes: item.bytes,
    targetBytes: item.targetBytes
  })),
  failed
});

const main = async () => {
  if (apply) await applyCleanup();
  const payload = buildPayload();
  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) process.exitCode = 1;
};

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    dryRun: !apply,
    error: error.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
