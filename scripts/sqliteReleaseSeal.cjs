const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SEAL_VERSION = "release-sqlite-seal-v1";
const DEFAULT_ROLLBACK_COPY_MAX_ATTEMPTS = 4;
const DEFAULT_ROLLBACK_COPY_RETRY_DELAY_MS = 250;
const MAX_STOPPED_WAL_RECONCILE_BYTES = 64 * 1024 * 1024;
const TOKENS = Object.freeze([
  Object.freeze({ token: "base", suffix: "" }),
  Object.freeze({ token: "wal", suffix: "-wal" }),
]);

class SQLiteSourceChangedError extends Error {
  constructor(token, detail = "changed during rollback snapshot") {
    super(`SQLite source ${detail}: ${token}`);
    this.name = "SQLiteSourceChangedError";
    this.code = "SQLITE_SOURCE_CHANGED";
    this.token = token;
  }
}

const modeOf = (stat) => Number(stat.mode & 0o7777n);
const bigintText = (value) => String(value);

const metadataFromStat = (stat) => ({
  dev: bigintText(stat.dev),
  ino: bigintText(stat.ino),
  nlink: bigintText(stat.nlink),
  size: bigintText(stat.size),
  mtimeNs: bigintText(stat.mtimeNs),
  ctimeNs: bigintText(stat.ctimeNs),
  uid: bigintText(stat.uid),
  gid: bigintText(stat.gid),
  mode: String(modeOf(stat).toString(8)),
});

const sameMetadata = (left, right) => [
  "dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs", "uid", "gid", "mode",
].every((key) => String(left?.[key]) === String(right?.[key]));

const openRegularNoFollow = (filePath) => {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  let pathStat;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) {
    throw new Error(`unsafe SQLite release path: ${filePath}`);
  }
  try {
    descriptor = fs.openSync(filePath, flags);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const stat = fs.fstatSync(descriptor, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    fs.closeSync(descriptor);
    throw new Error(`unsafe SQLite release file: ${filePath}`);
  }
  if (!sameMetadata(metadataFromStat(pathStat), metadataFromStat(stat))) {
    fs.closeSync(descriptor);
    throw new Error(`SQLite release path changed between lstat and open: ${filePath}`);
  }
  return { descriptor, stat };
};

const digestDescriptor = (descriptor) => {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
};

const captureEntry = (filePath, token, includeDigest = true) => {
  const opened = openRegularNoFollow(filePath);
  if (!opened) return { token, present: false };
  const { descriptor, stat: before } = opened;
  try {
    const digest = includeDigest ? digestDescriptor(descriptor) : undefined;
    const after = fs.fstatSync(descriptor, { bigint: true });
    const beforeMetadata = metadataFromStat(before);
    const afterMetadata = metadataFromStat(after);
    if (!sameMetadata(beforeMetadata, afterMetadata)) {
      throw new SQLiteSourceChangedError(token, `changed while sealing ${filePath}`);
    }
    return {
      token,
      present: true,
      ...beforeMetadata,
      ...(includeDigest ? { sha256: digest } : {}),
    };
  } finally {
    fs.closeSync(descriptor);
  }
};

const captureSeal = (basePath, { includeDigest = true } = {}) => ({
  version: SEAL_VERSION,
  basePath: path.resolve(basePath),
  entries: TOKENS.map(({ token, suffix }) => captureEntry(`${basePath}${suffix}`, token, includeDigest)),
});

const assertSealShape = (seal, { requireDigest = true } = {}) => {
  if (seal?.version !== SEAL_VERSION || !Array.isArray(seal.entries) || seal.entries.length !== TOKENS.length) {
    throw new Error("invalid SQLite release seal");
  }
  for (let index = 0; index < TOKENS.length; index += 1) {
    const expectedToken = TOKENS[index].token;
    const entry = seal.entries[index];
    if (entry?.token !== expectedToken || typeof entry.present !== "boolean") {
      throw new Error(`invalid SQLite release seal entry: ${expectedToken}`);
    }
    if (!entry.present) {
      if (Object.keys(entry).some((key) => !["token", "present"].includes(key))) {
        throw new Error(`absent SQLite release seal entry has metadata: ${expectedToken}`);
      }
      continue;
    }
    for (const key of ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs", "uid", "gid", "mode"]) {
      if (!/^\d+$/u.test(String(entry[key] || ""))) throw new Error(`invalid ${key} in SQLite release seal`);
    }
    if (entry.nlink !== "1") throw new Error(`SQLite release seal hard-link count is unsafe: ${expectedToken}`);
    if (requireDigest && !/^[a-f0-9]{64}$/u.test(String(entry.sha256 || ""))) {
      throw new Error(`invalid digest in SQLite release seal: ${expectedToken}`);
    }
  }
  if (!seal.entries[0].present) throw new Error("SQLite release seal requires the base database");
  return seal;
};

const readSeal = (sealPath) => {
  const opened = openRegularNoFollow(sealPath);
  if (!opened) throw new Error(`SQLite release seal is missing: ${sealPath}`);
  try {
    if (opened.stat.size > 1024n * 1024n) throw new Error("SQLite release seal is too large");
    return assertSealShape(JSON.parse(fs.readFileSync(opened.descriptor, "utf8")));
  } finally {
    fs.closeSync(opened.descriptor);
  }
};

const fsyncDirectory = (directory) => {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      // Windows permits opening a directory but rejects fsync on that handle.
      // Linux production must still complete the durability barrier.
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
};

const writeJsonExclusive = (outputPath, payload, mode = 0o600) => {
  const descriptor = fs.openSync(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const assertSealsEqual = (left, right) => {
  assertSealShape(left);
  assertSealShape(right);
  for (let index = 0; index < TOKENS.length; index += 1) {
    const leftEntry = left.entries[index];
    const rightEntry = right.entries[index];
    if (JSON.stringify(leftEntry) !== JSON.stringify(rightEntry)) {
      throw new SQLiteSourceChangedError(leftEntry.token);
    }
  }
};

const sameStableFileContract = (left, right) => [
  "dev", "nlink", "size", "uid", "gid", "mode",
].every((key) => String(left?.[key]) === String(right?.[key]));

const verifyMetadataSeal = (basePath, expectedSeal, { allowWalDigestEquivalent = false } = {}) => {
  assertSealShape(expectedSeal);
  const actual = captureSeal(basePath, { includeDigest: false });
  for (let index = 0; index < TOKENS.length; index += 1) {
    const expected = expectedSeal.entries[index];
    const observed = actual.entries[index];
    if (expected.present === observed.present
        && (!expected.present || sameMetadata(expected, observed))) continue;
    if (allowWalDigestEquivalent && expected.token === "wal"
        && expected.present && observed.present) {
      const observedWithDigest = captureEntry(`${basePath}-wal`, "wal", true);
      if (sameStableFileContract(expected, observedWithDigest)
          && expected.sha256 === observedWithDigest.sha256) continue;
    }
    throw new Error(`SQLite metadata seal CAS mismatch: ${expected.token}`);
  }
  return actual;
};

const verifySnapshotMatchesSource = (snapshotSeal, sourceSeal) => {
  assertSealShape(snapshotSeal);
  assertSealShape(sourceSeal);
  for (let index = 0; index < TOKENS.length; index += 1) {
    const snapshot = snapshotSeal.entries[index];
    const source = sourceSeal.entries[index];
    if (snapshot.present !== source.present
        || (source.present && (snapshot.size !== source.size || snapshot.sha256 !== source.sha256))) {
      throw new Error(`SQLite rollback snapshot does not match source: ${source.token}`);
    }
  }
};

const reconcileStoppedWalSnapshot = ({ liveBase, snapshotBase, sourceSeal, snapshotSeal }) => {
  assertSealShape(sourceSeal);
  assertSealShape(snapshotSeal);
  verifySnapshotMatchesSource(snapshotSeal, sourceSeal);
  const liveMetadata = captureSeal(liveBase, { includeDigest: false });
  const snapshotMetadata = captureSeal(snapshotBase, { includeDigest: false });
  const expectedBase = sourceSeal.entries[0];
  const liveBaseEntry = liveMetadata.entries[0];
  if (!sameMetadata(expectedBase, liveBaseEntry)) {
    throw new Error("SQLite metadata seal CAS mismatch: base");
  }
  if (!sameMetadata(snapshotSeal.entries[0], snapshotMetadata.entries[0])) {
    throw new Error("SQLite rollback metadata seal CAS mismatch: base");
  }
  const expectedWal = sourceSeal.entries[1];
  const liveWalMetadata = liveMetadata.entries[1];
  const expectedSnapshotWal = snapshotSeal.entries[1];
  const snapshotWalMetadata = snapshotMetadata.entries[1];
  const liveWalUnchanged = expectedWal.present === liveWalMetadata.present
    && (!expectedWal.present || sameMetadata(expectedWal, liveWalMetadata));
  const snapshotWalUnchanged = expectedSnapshotWal.present === snapshotWalMetadata.present
    && (!expectedSnapshotWal.present || sameMetadata(expectedSnapshotWal, snapshotWalMetadata));
  if (liveWalUnchanged && snapshotWalUnchanged) {
    return { sourceSeal, snapshotSeal, reconciled: false };
  }

  const snapshotWalPath = `${snapshotBase}-wal`;
  const liveWalPath = `${liveBase}-wal`;
  if (!liveWalMetadata.present) {
    removeRollbackAttemptFile(snapshotWalPath);
    fsyncDirectory(path.dirname(snapshotBase));
    const reconciledSource = {
      ...sourceSeal,
      entries: [sourceSeal.entries[0], { token: "wal", present: false }],
    };
    const reconciledSnapshot = {
      ...snapshotSeal,
      entries: [snapshotSeal.entries[0], { token: "wal", present: false }],
    };
    verifySnapshotMatchesSource(reconciledSnapshot, reconciledSource);
    return { sourceSeal: reconciledSource, snapshotSeal: reconciledSnapshot, reconciled: true };
  }

  const liveWalBefore = captureEntry(liveWalPath, "wal", true);
  if (BigInt(liveWalBefore.size) > BigInt(MAX_STOPPED_WAL_RECONCILE_BYTES)) {
    throw new Error(`stopped SQLite WAL exceeds reconciliation limit: ${liveWalBefore.size}`);
  }
  const temporaryWalPath = `${snapshotWalPath}.stopped-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    copyFileExclusive(liveWalPath, temporaryWalPath);
    const liveWalAfter = captureEntry(liveWalPath, "wal", true);
    if (JSON.stringify(liveWalBefore) !== JSON.stringify(liveWalAfter)) {
      throw new SQLiteSourceChangedError("wal", "changed during stopped reconciliation");
    }
    const temporaryWal = captureEntry(temporaryWalPath, "wal", true);
    if (!temporaryWal.present || temporaryWal.size !== liveWalBefore.size
        || temporaryWal.sha256 !== liveWalBefore.sha256) {
      throw new Error("stopped SQLite WAL reconciliation copy mismatch");
    }
    removeRollbackAttemptFile(snapshotWalPath);
    fs.renameSync(temporaryWalPath, snapshotWalPath);
    fsyncDirectory(path.dirname(snapshotBase));
  } catch (error) {
    removeRollbackAttemptFile(temporaryWalPath);
    throw error;
  }
  const snapshotWal = captureEntry(snapshotWalPath, "wal", true);
  const reconciledSource = {
    ...sourceSeal,
    entries: [sourceSeal.entries[0], liveWalBefore],
  };
  const reconciledSnapshot = {
    ...snapshotSeal,
    entries: [snapshotSeal.entries[0], snapshotWal],
  };
  verifySnapshotMatchesSource(reconciledSnapshot, reconciledSource);
  return { sourceSeal: reconciledSource, snapshotSeal: reconciledSnapshot, reconciled: true };
};

const copyFileExclusive = (source, target) => {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | (fs.constants.COPYFILE_FICLONE || 0));
  // Recovery snapshots live below a root-only 0700 transaction directory and
  // must remain root-owned even when the source SQLite sidecars belong to the
  // service account.  Do not rely on platform copy semantics for ownership.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    fs.chownSync(target, 0, 0);
  }
  fs.chmodSync(target, 0o600);
  const descriptor = fs.openSync(target, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const assertPrivateSnapshotEntry = (filePath, token) => {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error(`unsafe private SQLite snapshot entry: ${token}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o777n) !== 0o600n) {
    throw new Error(`private SQLite snapshot mode mismatch: ${token}`);
  }
  if (typeof process.getuid === "function" && process.getuid() === 0
      && (stat.uid !== 0n || stat.gid !== 0n)) {
    throw new Error(`private SQLite snapshot ownership mismatch: ${token}`);
  }
};

const removeRollbackAttemptFile = (filePath) => {
  let stat;
  try {
    stat = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error(`refusing to clean unsafe SQLite rollback attempt: ${filePath}`);
  }
  fs.unlinkSync(filePath);
};

const cleanupRollbackAttempt = (snapshotBase) => {
  for (const { suffix } of TOKENS) removeRollbackAttemptFile(`${snapshotBase}${suffix}`);
};

const sleepMilliseconds = (milliseconds) => {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const assertBoundedInteger = (value, name, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
};

const copyRollbackSnapshot = ({
  sourceBase,
  snapshotBase,
  sourceSealOutput,
  snapshotSealOutput,
  requireRootOwner = true,
  maxAttempts = DEFAULT_ROLLBACK_COPY_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_ROLLBACK_COPY_RETRY_DELAY_MS,
  onRetry = null,
}) => {
  const boundedMaxAttempts = assertBoundedInteger(maxAttempts, "maxAttempts", 1, 10);
  const boundedRetryDelayMs = assertBoundedInteger(retryDelayMs, "retryDelayMs", 0, 5_000);
  const snapshotDirectory = path.dirname(snapshotBase);
  const directoryStat = fs.lstatSync(snapshotDirectory, { bigint: true });
  // Windows does not expose meaningful POSIX directory permission bits (a
  // chmod(0700) directory is commonly reported as 0666).  Production runs on
  // Linux, where the exact private mode remains mandatory; the signed shell
  // wrapper independently checks root:root/0700 before and after this helper.
  const hasPrivateDirectoryMode = process.platform === "win32"
    || (directoryStat.mode & 0o777n) === 0o700n;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || !hasPrivateDirectoryMode || directoryStat.nlink < 1n
      || (requireRootOwner && (directoryStat.uid !== 0n || directoryStat.gid !== 0n))) {
    throw new Error("SQLite rollback snapshot directory must be a root-owned real 0700 directory");
  }
  for (let attempt = 1; attempt <= boundedMaxAttempts; attempt += 1) {
    let sourceBefore;
    try {
      sourceBefore = captureSeal(sourceBase);
      for (let index = 0; index < TOKENS.length; index += 1) {
        const { token, suffix } = TOKENS[index];
        if (!sourceBefore.entries[index].present) continue;
        try {
          copyFileExclusive(`${sourceBase}${suffix}`, `${snapshotBase}${suffix}`);
        } catch (error) {
          // A WAL can legitimately disappear between the initial seal and its
          // copy when an already-running connection finishes a checkpoint.
          // Retry only that observed source transition; destination/security
          // failures remain immediate hard failures.
          if (error?.code === "ENOENT" && !fs.existsSync(`${sourceBase}${suffix}`)) {
            throw new SQLiteSourceChangedError(token, "disappeared during rollback snapshot");
          }
          throw error;
        }
      }
      const sourceAfter = captureSeal(sourceBase);
      assertSealsEqual(sourceBefore, sourceAfter);
      const snapshotSeal = captureSeal(snapshotBase);
      verifySnapshotMatchesSource(snapshotSeal, sourceBefore);
      writeJsonExclusive(sourceSealOutput, sourceBefore);
      writeJsonExclusive(snapshotSealOutput, snapshotSeal);
      fsyncDirectory(snapshotDirectory);
      return { sourceSeal: sourceBefore, snapshotSeal, attempts: attempt };
    } catch (error) {
      cleanupRollbackAttempt(snapshotBase);
      if (!(error instanceof SQLiteSourceChangedError)) throw error;
      if (attempt >= boundedMaxAttempts) {
        throw new Error(
          `SQLite source did not stabilize after ${boundedMaxAttempts} rollback snapshot attempts: ${error.token}`,
          { cause: error },
        );
      }
      if (typeof onRetry === "function") {
        onRetry({ attempt, maxAttempts: boundedMaxAttempts, error });
      }
      sleepMilliseconds(boundedRetryDelayMs);
    }
  }
  throw new Error("unreachable SQLite rollback snapshot retry state");
};

const captureSmallShm = (liveBase, snapshotBase) => {
  const sourcePath = `${liveBase}-shm`;
  const snapshotPath = `${snapshotBase}-shm`;
  const sourceBefore = captureEntry(sourcePath, "shm", true);
  if (!sourceBefore.present) return sourceBefore;
  copyFileExclusive(sourcePath, snapshotPath);
  const sourceAfter = captureEntry(sourcePath, "shm", true);
  if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) {
    throw new Error("SQLite shm changed while capturing rollback state");
  }
  const snapshot = captureEntry(snapshotPath, "shm", true);
  if (!snapshot.present || snapshot.size !== sourceBefore.size || snapshot.sha256 !== sourceBefore.sha256) {
    throw new Error("SQLite shm rollback snapshot mismatch");
  }
  return { ...snapshot, uid: sourceBefore.uid, gid: sourceBefore.gid, mode: sourceBefore.mode };
};

const manifestRow = (token, snapshot, sourceMetadata = snapshot) => snapshot.present
  ? [token, "1", snapshot.size, snapshot.sha256, sourceMetadata.uid, sourceMetadata.gid, sourceMetadata.mode].join("\t")
  : [token, "0", "-", "-", "-", "-", "-"].join("\t");

const finalizeRecoverySnapshot = ({
  liveBase,
  snapshotBase,
  sourceSealPath,
  snapshotSealPath,
  livePathOutput,
  manifestOutput,
}) => {
  const originalSourceSeal = readSeal(sourceSealPath);
  const originalSnapshotSeal = readSeal(snapshotSealPath);
  const reconciled = reconcileStoppedWalSnapshot({
    liveBase,
    snapshotBase,
    sourceSeal: originalSourceSeal,
    snapshotSeal: originalSnapshotSeal,
  });
  const sourceSeal = reconciled.sourceSeal;
  const snapshotSeal = reconciled.snapshotSeal;
  const shm = captureSmallShm(liveBase, snapshotBase);
  for (const { token, suffix } of TOKENS) {
    if (snapshotSeal.entries.find((entry) => entry.token === token)?.present) {
      assertPrivateSnapshotEntry(`${snapshotBase}${suffix}`, token);
    }
  }
  if (shm.present) assertPrivateSnapshotEntry(`${snapshotBase}-shm`, "shm");
  const rows = TOKENS.map(({ token }, index) => manifestRow(
    token,
    snapshotSeal.entries[index],
    sourceSeal.entries[index],
  ));
  rows.push(manifestRow("shm", shm));
  const liveDescriptor = fs.openSync(livePathOutput, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(liveDescriptor, `${path.resolve(liveBase)}\n`);
    fs.fsyncSync(liveDescriptor);
  } finally {
    fs.closeSync(liveDescriptor);
  }
  const manifestDescriptor = fs.openSync(manifestOutput, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(manifestDescriptor, `${rows.join("\n")}\n`);
    fs.fsyncSync(manifestDescriptor);
  } finally {
    fs.closeSync(manifestDescriptor);
  }
  fsyncDirectory(path.dirname(snapshotBase));
  return { sourceSeal, snapshotSeal, shm };
};

const parseArgs = (args) => {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = String(args[index] || "");
    const value = args[index + 1];
    if (!key.startsWith("--") || value == null) throw new Error(`invalid argument: ${key}`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
};

const requireArg = (args, name) => {
  const value = String(args[name] || "");
  if (!value) throw new Error(`missing --${name}`);
  return path.resolve(value);
};

const optionalIntegerArg = (args, name, fallback, minimum, maximum) => (
  args[name] == null
    ? fallback
    : assertBoundedInteger(args[name], `--${name}`, minimum, maximum)
);

const optionalBooleanArg = (args, name, fallback = false) => {
  if (args[name] == null) return fallback;
  if (args[name] === "1") return true;
  if (args[name] === "0") return false;
  throw new Error(`--${name} must be 0 or 1`);
};

const main = () => {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "copy-rollback") {
    copyRollbackSnapshot({
      sourceBase: requireArg(args, "source-base"),
      snapshotBase: requireArg(args, "snapshot-base"),
      sourceSealOutput: requireArg(args, "source-seal-output"),
      snapshotSealOutput: requireArg(args, "snapshot-seal-output"),
      maxAttempts: optionalIntegerArg(
        args,
        "max-attempts",
        DEFAULT_ROLLBACK_COPY_MAX_ATTEMPTS,
        1,
        10,
      ),
      retryDelayMs: optionalIntegerArg(
        args,
        "retry-delay-ms",
        DEFAULT_ROLLBACK_COPY_RETRY_DELAY_MS,
        0,
        5_000,
      ),
      onRetry: ({ attempt, maxAttempts, error }) => {
        console.error(
          `SQLite rollback snapshot source churn; retrying ${attempt + 1}/${maxAttempts} after ${error.token}`,
        );
      },
    });
  } else if (command === "capture") {
    const output = requireArg(args, "output");
    writeJsonExclusive(output, captureSeal(requireArg(args, "base")));
    fsyncDirectory(path.dirname(output));
  } else if (command === "verify-metadata") {
    verifyMetadataSeal(
      requireArg(args, "base"),
      readSeal(requireArg(args, "seal")),
      {
        allowWalDigestEquivalent: optionalBooleanArg(
          args,
          "allow-wal-digest-equivalent",
          false,
        ),
      },
    );
  } else if (command === "finalize-recovery") {
    finalizeRecoverySnapshot({
      liveBase: requireArg(args, "live-base"),
      snapshotBase: requireArg(args, "snapshot-base"),
      sourceSealPath: requireArg(args, "source-seal"),
      snapshotSealPath: requireArg(args, "snapshot-seal"),
      livePathOutput: requireArg(args, "live-path-output"),
      manifestOutput: requireArg(args, "manifest-output"),
    });
  } else {
    throw new Error(`unknown command: ${command || "<empty>"}`);
  }
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_ROLLBACK_COPY_MAX_ATTEMPTS,
  DEFAULT_ROLLBACK_COPY_RETRY_DELAY_MS,
  SEAL_VERSION,
  SQLiteSourceChangedError,
  TOKENS,
  assertSealsEqual,
  captureSeal,
  copyRollbackSnapshot,
  finalizeRecoverySnapshot,
  reconcileStoppedWalSnapshot,
  readSeal,
  verifyMetadataSeal,
  verifySnapshotMatchesSource,
};
