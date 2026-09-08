"use strict";

// Deliberately no production entry point or CLI. The public factory creates its
// own private test tree; a future fixed root authorizer must supply both trusted
// release authorization and the real shared release lock before reusing core.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { inspectPrebuiltDist } = require("./releasePrebuiltDist.cjs");
const VERSION = "frontend-overlay-fixture-transaction-v1";
const HASH = /^[a-f0-9]{64}$/;
const ASSET = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const INDEX_LIMIT = 1024 * 1024, ASSET_LIMIT = 32 * 1024 * 1024, TOTAL_LIMIT = 128 * 1024 * 1024;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = s => [s.dev, s.ino, s.size, s.mode, s.nlink, s.mtimeNs, s.ctimeNs].map(String).join(":");
const boundary = Object.freeze({ fixtureOnly: true, deploymentAuthorized: false,
  requiresOuterTrustedAuthorization: true, requiresSharedReleaseLock: true });

function plainDirectory(directory) {
  const s = fs.lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) throw new Error("nonplain-transaction-directory");
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeNew(filename, bytes, mode = 0o600) {
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readIndex(filename) {
  const before = fs.lstatSync(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(INDEX_LIMIT)) throw new Error("unsafe-index-input");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(before)) throw new Error("index-open-drift");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== Number(before.size) || identity(fs.fstatSync(fd, { bigint: true })) !== identity(before)
      || identity(fs.lstatSync(filename, { bigint: true })) !== identity(before)) throw new Error("index-read-drift");
    return { bytes, sha256: hash(bytes), identity: identity(before), mode: Number(before.mode & 0o777n) };
  } finally { fs.closeSync(fd); }
}
function copiedBytes(entry, limit) {
  if (!entry || !Buffer.isBuffer(entry.bytes) || !HASH.test(entry.sha256 || "") || entry.bytes.length > limit) throw new Error("invalid-bound-artifact");
  const bytes = Buffer.from(entry.bytes);
  if (hash(bytes) !== entry.sha256) throw new Error("bound-artifact-digest-mismatch");
  return { bytes, sha256: entry.sha256 };
}
function preparePlan(input) {
  if (!input || !HASH.test(input.expectedIndexSha256 || "") || !Array.isArray(input.newAssets) || input.newAssets.length > 4096) throw new Error("invalid-overlay-plan");
  const candidate = copiedBytes(input.candidateIndex, INDEX_LIMIT);
  if (candidate.sha256 === input.expectedIndexSha256) throw new Error("unchanged-index-not-a-cutover");
  const baseline = JSON.parse(JSON.stringify(input.expectedDistManifest));
  if (!Array.isArray(baseline?.files) || baseline.files.find(row => row.path === "index.html")?.sha256 !== input.expectedIndexSha256) throw new Error("index-baseline-binding-mismatch");
  const names = new Set(); let total = candidate.bytes.length;
  const assets = input.newAssets.map(entry => {
    if (!entry || typeof entry.path !== "string" || !ASSET.test(entry.path) || entry.path.split("/").some(p => p.startsWith(".")) || names.has(entry.path)) throw new Error("invalid-immutable-asset-path");
    names.add(entry.path); const copied = copiedBytes(entry, ASSET_LIMIT); total += copied.bytes.length;
    if (total > TOTAL_LIMIT) throw new Error("overlay-byte-limit");
    return { path: entry.path, ...copied };
  });
  return { baseline, expectedIndexSha256: input.expectedIndexSha256, candidate, assets };
}
function expectedFiles(plan) {
  const rows = new Map(plan.baseline.files.map(row => [row.path, { ...row }]));
  rows.set("index.html", { path: "index.html", bytes: plan.candidate.bytes.length, sha256: plan.candidate.sha256 });
  for (const asset of plan.assets) {
    const old = rows.get(asset.path);
    if (old && (old.sha256 !== asset.sha256 || old.bytes !== asset.bytes.length)) throw new Error("immutable-asset-name-collision");
    rows.set(asset.path, { path: asset.path, bytes: asset.bytes.length, sha256: asset.sha256 });
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}
function assertFiles(distDir, expected, indexOverride) {
  const rows = inspectPrebuiltDist(distDir).files;
  const wanted = expected.map(row => row.path === "index.html" && indexOverride ? indexOverride : row);
  if (JSON.stringify(rows) !== JSON.stringify(wanted)) throw new Error("undeclared-dist-change");
}

// Filesystem core has no credential/signature parsing, env policy or production
// routing. Its caller must already hold a lock shared by every permitted writer.
function applyLocked({ distDir, journalRoot, onStep }, plan) {
  plainDirectory(distDir); plainDirectory(journalRoot);
  const before = inspectPrebuiltDist(distDir);
  if (JSON.stringify(before) !== JSON.stringify(plan.baseline)) throw new Error("current-dist-baseline-mismatch");
  const index = path.join(distDir, "index.html"), original = readIndex(index);
  if (original.sha256 !== plan.expectedIndexSha256) throw new Error("current-index-precondition-failed");
  const finalFiles = expectedFiles(plan), id = crypto.randomBytes(16).toString("hex");
  const directory = path.join(journalRoot, id); fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(journalRoot);
  const journal = path.join(directory, "journal.jsonl"), backup = path.join(directory, "index.previous"), next = path.join(directory, "index.next");
  writeNew(backup, original.bytes, original.mode); writeNew(next, plan.candidate.bytes, 0o644); writeNew(journal, Buffer.alloc(0)); syncDirectory(directory);
  const fd = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  const record = (phase, details = {}) => { fs.writeFileSync(fd, JSON.stringify({ version: VERSION, id, phase, ...details }) + "\n"); fs.fsyncSync(fd); };
  const step = phase => onStep?.({ phase, id, distDir, directory });
  let committed = false, committedIdentity = null;
  const result = { ...boundary, version: VERSION, transactionId: id, journalPath: journal,
    previousIndexSha256: original.sha256, candidateIndexSha256: plan.candidate.sha256, installedAssets: [], reusedAssets: [], deletes: [], rollback: "not-needed" };
  try {
    record("prepared", { baselineTreeHash: before.treeHash, previousIndexSha256: original.sha256, candidateIndexSha256: plan.candidate.sha256,
      assets: plan.assets.map(asset => ({ path: asset.path, sha256: asset.sha256, bytes: asset.bytes.length })) }); step("prepared");
    const assetsDir = path.join(distDir, "assets");
    if (plan.assets.length) { if (!fs.existsSync(assetsDir)) { fs.mkdirSync(assetsDir, { mode: 0o755 }); syncDirectory(distDir); } plainDirectory(assetsDir); }
    for (const asset of plan.assets) {
      const target = path.join(distDir, asset.path), stage = path.join(directory, "asset-" + hash(asset.path));
      if (fs.existsSync(target)) {
        const existing = inspectPrebuiltDist(distDir).files.find(row => row.path === asset.path);
        if (!existing || existing.sha256 !== asset.sha256 || existing.bytes !== asset.bytes.length) throw new Error("immutable-asset-name-collision");
        result.reusedAssets.push(asset.path); continue;
      }
      writeNew(stage, asset.bytes, 0o644); syncDirectory(directory);
      // link() is atomic create-only; complete bytes become visible together.
      // The temporary alias is outside dist and removed before tree inspection.
      fs.linkSync(stage, target); fs.unlinkSync(stage); syncDirectory(assetsDir); syncDirectory(directory);
      result.installedAssets.push(asset.path); record("asset-installed", { path: asset.path, sha256: asset.sha256 }); step("asset-installed");
    }
    const originalRow = before.files.find(row => row.path === "index.html");
    record("index-switch-intent"); step("before-index-compare");
    assertFiles(distDir, finalFiles, originalRow);
    const current = readIndex(index);
    if (current.sha256 !== original.sha256 || current.identity !== original.identity) throw new Error("current-index-precondition-failed");
    fs.renameSync(next, index); committed = true; syncDirectory(distDir);
    committedIdentity = readIndex(index).identity; record("index-committed"); step("index-committed");
    assertFiles(distDir, finalFiles);
    record("complete"); result.ok = true; result.state = "committed";
  } catch (error) {
    result.ok = false; result.error = error.message;
    try { record("failed", { error: error.message, committed }); } catch { result.journalWriteFailed = true; }
    if (committed) {
      try {
        step("before-rollback-compare");
        const current = readIndex(index);
        // Hash + inode identity CAS is checked under the caller's shared lock.
        // rename alone is not a kernel conditional-write primitive.
        if (!committedIdentity) {
          result.rollback = "failed-manual-recovery";
        } else if (current.sha256 !== plan.candidate.sha256 || current.identity !== committedIdentity) {
          result.rollback = "refused-external-index-change";
        } else {
          const previous = readIndex(backup);
          if (previous.sha256 !== original.sha256) throw new Error("rollback-backup-drift", { cause: error });
          record("rollback-intent");
          const stillCurrent = readIndex(index);
          if (stillCurrent.identity !== current.identity || stillCurrent.sha256 !== current.sha256) throw new Error("rollback-index-cas-drift", { cause: error });
          fs.renameSync(backup, index); syncDirectory(distDir);
          if (readIndex(index).sha256 !== original.sha256) throw new Error("rollback-postcondition-failed", { cause: error });
          result.rollback = "restored-original"; record("rollback-complete");
        }
      } catch (rollbackError) { result.rollback = "failed-manual-recovery"; result.rollbackError = rollbackError.message; }
    }
    result.state = committed ? "failed-after-index" : "aborted-before-index";
    try { record("stopped", { state: result.state, rollback: result.rollback }); } catch { result.journalWriteFailed = true; }
  } finally { fs.closeSync(fd); }
  return result;
}

function createFrontendOverlayFixtureAdapter({ onStep } = {}) {
  if (process.platform !== "linux") throw new Error("linux-atomic-fixture-required");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-frontend-overlay-fixture-")); fs.chmodSync(rootDir, 0o700);
  const distDir = path.join(rootDir, "dist"), journalRoot = path.join(rootDir, "transactions"), lock = path.join(rootDir, "fixture-shared.lock");
  fs.mkdirSync(distDir, { mode: 0o755 }); fs.mkdirSync(journalRoot, { mode: 0o700 });
  let disposed = false;
  const validate = () => {
    if (disposed || path.dirname(fs.realpathSync(rootDir)) !== fs.realpathSync(os.tmpdir())
      || !/^football-frontend-overlay-fixture-[A-Za-z0-9]+$/.test(path.basename(rootDir))) throw new Error("fixture-root-identity-changed");
    plainDirectory(rootDir); const s = fs.lstatSync(rootDir);
    if (s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw new Error("fixture-root-not-private");
  };
  return Object.freeze({ ...boundary, rootDir, distDir, journalRoot,
    apply(input) {
      validate(); const plan = preparePlan(input);
      let fd; try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === "EEXIST") throw new Error("fixture-shared-lock-busy", { cause: error }); throw error; }
      let lockIdentity, result, failure;
      try {
        lockIdentity = identity(fs.fstatSync(fd, { bigint: true }));
        fs.fsyncSync(fd); syncDirectory(rootDir); result = applyLocked({ distDir, journalRoot, onStep }, plan);
      } catch (error) { failure = error; }
      try {
        fs.closeSync(fd);
        if (!lockIdentity || identity(fs.lstatSync(lock, { bigint: true })) !== lockIdentity) throw new Error("fixture-lock-identity-changed");
        fs.unlinkSync(lock); syncDirectory(rootDir);
      } catch (error) {
        if (failure) throw new AggregateError([failure, error], "fixture transaction and lock cleanup failed", { cause: error });
        throw error;
      }
      if (failure) throw failure;
      return result;
    },
    dispose() {
      validate(); if (fs.existsSync(lock)) throw new Error("fixture-shared-lock-busy");
      // This path was created by this adapter, remains private and canonical,
      // and can never be an app/dist path selected by the caller.
      fs.rmSync(rootDir, { recursive: true }); disposed = true;
    },
  });
}

module.exports = { VERSION, createFrontendOverlayFixtureAdapter };
