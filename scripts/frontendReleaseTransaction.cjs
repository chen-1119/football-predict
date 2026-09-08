"use strict";

// Fixed-root filesystem authority only. The independently installed authorizer
// must authenticate the signed source request and the actual sandbox output.
// No CLI, environment path override, production fault hook or signing key.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { inspectPrebuiltDist, MANIFEST_VERSION } = require("./releasePrebuiltDist.cjs");
const VERSION = "frontend-release-transaction-v1", STATE_VERSION = "frontend-release-state-v1";
const FIXED = Object.freeze({ app: "/opt/football-predict", stageRoot: "/opt/.football-frontend-transactions",
  releaseRoot: "/var/lib/football-release", lock: "/run/lock/football-release.lock" });
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/, ASSET = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const STATE_KEYS = ["version", "kind", "phase", "runtimeSha256", "runtimeSequence", "frontendSha256", "frontendSequence", "indexSha256", "distTreeHash", "acceptanceSha256"];
const INDEX_MAX = 1024 * 1024, ASSET_MAX = 32 * 1024 * 1024, TREE_MAX = 128 * 1024 * 1024, RECORD_MAX = 3 * 1024 * 1024, RECEIPT_MAX = 10 * 1024;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const jsonBytes = value => Buffer.from(JSON.stringify(value) + "\n");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = s => [s.dev, s.ino, s.size, s.mode, s.nlink, s.uid, s.gid, s.mtimeNs, s.ctimeNs].map(String).join(":");
const fail = reason => { throw new Error(reason); };
function paths(base) { return { ...base, dist: path.join(base.app, "dist"), recoveryRoot: path.join(base.releaseRoot, "recovery"),
  current: path.join(base.releaseRoot, "recovery/current"), state: path.join(base.releaseRoot, "frontend-state.json"),
  projection: path.join(base.app, ".frontend-release-state.json"), acceptanceProjection: path.join(base.app, ".frontend-release-acceptance.json"),
  sequence: path.join(base.releaseRoot, "highest-accepted-sequence"),
  status: path.join(base.releaseRoot, "status") }; }
function directory(context, filename, privateMode = false) {
  for (let cursor = filename; ; cursor = path.dirname(cursor)) {
    const s = fs.lstatSync(cursor);
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(cursor) !== cursor || s.uid !== context.uid
      || (s.mode & 0o022) || (cursor === filename && privateMode && (s.mode & 0o077))) fail("unsafe-transaction-directory");
    if (cursor === context.boundary) break;
    if (cursor === path.dirname(cursor)) fail("transaction-trust-boundary-unreachable");
  }
}
function syncDir(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function makeDirectory(context, filename, mode) {
  directory(context, path.dirname(filename)); fs.mkdirSync(filename, { mode }); fs.chmodSync(filename, mode); syncDir(path.dirname(filename));
}
function describe(stat, sha256) { return { dev: String(stat.dev), ino: String(stat.ino), bytes: Number(stat.size),
  mode: Number(stat.mode & 0o777n), uid: Number(stat.uid), gid: Number(stat.gid), sha256 }; }
function read(context, filename, limit, { optional = false, links = [1] } = {}) {
  directory(context, path.dirname(filename));
  let s; try { s = fs.lstatSync(filename, { bigint: true }); } catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
  if (!s.isFile() || s.isSymbolicLink() || Number(s.uid) !== context.uid || (s.mode & 0o022n)
    || !links.includes(Number(s.nlink)) || s.size < 0n || s.size > BigInt(limit)) fail("unsafe-or-oversized-transaction-file");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), chunks = [], digest = crypto.createHash("sha256");
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s)) fail("transaction-file-open-drift");
    let offset = 0;
    while (offset < Number(s.size)) {
      const buffer = Buffer.alloc(Math.min(65536, Number(s.size) - offset));
      const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) fail("transaction-file-short-read");
      const chunk = buffer.subarray(0, count); chunks.push(chunk); digest.update(chunk); offset += count;
    }
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s) || stamp(fs.lstatSync(filename, { bigint: true })) !== stamp(s)) fail("transaction-file-read-drift");
    const bytes = Buffer.concat(chunks); return { bytes, sha256: digest.digest("hex"), identity: describe(s, hash(bytes)), stamp: stamp(s), links: Number(s.nlink) };
  } finally { fs.closeSync(fd); }
}
function writeNew(context, filename, bytes, mode = 0o600) {
  directory(context, path.dirname(filename));
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(path.dirname(filename));
}
function atomicWrite(context, filename, bytes, mode) {
  const existing = read(context, filename, RECORD_MAX, { optional: true });
  const temporary = filename + ".frontend-next";
  // An interrupted atomic write leaves exactly this name; never overwrite it.
  if (fs.existsSync(temporary)) {
    const partial = read(context, temporary, RECORD_MAX);
    if (!partial.bytes.equals(bytes)) fail("interrupted-state-write-conflict");
  } else writeNew(context, temporary, bytes, mode);
  if (existing && read(context, filename, RECORD_MAX).stamp !== existing.stamp) fail("state-cas-drift");
  if (!existing && fs.existsSync(filename)) fail("state-cas-drift");
  fs.renameSync(temporary, filename); syncDir(path.dirname(filename));
}
function state(value) {
  if (!exact(value, STATE_KEYS) || value.version !== STATE_VERSION || !["full", "frontend-only"].includes(value.kind)
    || !["pending", "accepted"].includes(value.phase)
    || ["runtimeSha256", "frontendSha256", "indexSha256", "distTreeHash"].some(key => !HASH.test(value[key] || ""))
    || ["runtimeSequence", "frontendSequence"].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1)
    || value.frontendSequence < value.runtimeSequence
    || (value.kind === "full" && (value.frontendSha256 !== value.runtimeSha256 || value.frontendSequence !== value.runtimeSequence))
    || (value.kind === "frontend-only" && (value.frontendSequence <= value.runtimeSequence || value.frontendSha256 === value.runtimeSha256))
    || (value.phase === "pending" ? value.acceptanceSha256 !== null : !HASH.test(value.acceptanceSha256 || ""))) fail("invalid-frontend-release-state");
  return Object.fromEntries(STATE_KEYS.map(key => [key, value[key]]));
}
function readState(context, filename, optional = false) {
  const file = read(context, filename, 16384, { optional }); if (!file) return null;
  if (file.identity.mode !== (filename === context.paths.state ? 0o600 : 0o644)) fail("frontend-state-permissions");
  const value = state(JSON.parse(file.bytes.toString("utf8")));
  if (!file.bytes.equals(jsonBytes(value))) fail("noncanonical-frontend-release-state");
  return { ...file, value };
}
function manifest(files) {
  files = files.map(row => ({ path: row.path, bytes: row.bytes, sha256: row.sha256 })).sort((a, b) => a.path.localeCompare(b.path, "en"));
  const body = { version: MANIFEST_VERSION, files, fileCount: files.length, totalBytes: files.reduce((sum, row) => sum + row.bytes, 0) };
  if (body.fileCount > 4096 || body.totalBytes > TREE_MAX) fail("cumulative-dist-limit");
  return { ...body, treeHash: hash(JSON.stringify(body)) };
}
function dist(context) {
  directory(context, context.paths.dist);
  const result = inspectPrebuiltDist(context.paths.dist);
  for (const row of result.files) {
    const filename = path.join(context.paths.dist, row.path); directory(context, path.dirname(filename));
    const s = fs.lstatSync(filename);
    if (s.uid !== context.uid || (s.mode & 0o022)) fail("writable-or-unowned-dist-file");
  }
  return result;
}
function markers(context, runtimeSha256) {
  for (const name of [".release-bundle-sha256", ".release-live-complete"]) {
    if (read(context, path.join(context.paths.app, name), 128).bytes.toString("utf8") !== runtimeSha256 + "\n") fail("runtime-release-marker-mismatch");
  }
}
function parseLockRows(text) {
  return text.split("\n").map(line => /(?:^|\s)(FLOCK)\s+(ADVISORY)\s+(WRITE)\s+(-?\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF\s*$/i.exec(line))
    .filter(Boolean).map(match => ({ type: match[1], advisory: match[2], access: match[3], holder: match[4],
      major: BigInt("0x" + match[5]), minor: BigInt("0x" + match[6]), ino: BigInt(match[7]) }));
}
function assertInheritedLock(context) {
  if (context.fixture) { context.assertFixtureLock(); return; }
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.execPath !== "/opt/node-v22.22.1/bin/node"
    || process.version !== "v22.22.1" || process.execArgv.length || ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"].some(key => process.env[key])) fail("fixed-clean-root-node-required");
  directory(context, path.dirname(FIXED.lock));
  const target = fs.lstatSync(FIXED.lock, { bigint: true }), fd = fs.fstatSync(9, { bigint: true });
  if (!target.isFile() || target.isSymbolicLink() || target.uid !== 0n || target.nlink !== 1n || (target.mode & 0o022n)
    || fd.dev !== target.dev || fd.ino !== target.ino || !fd.isFile()) fail("inherited-release-lock-identity-mismatch");
  const major = ((fd.dev >> 8n) & 0xfffn) | ((fd.dev >> 32n) & ~0xfffn), minor = (fd.dev & 0xffn) | ((fd.dev >> 12n) & ~0xffn);
  const own = parseLockRows(fs.readFileSync("/proc/self/fdinfo/9", "utf8")).filter(row => row.major === major && row.minor === minor && row.ino === fd.ino);
  const global = parseLockRows(fs.readFileSync("/proc/locks", "utf8"));
  if (own.length !== 1 || !global.some(row => row.major === major && row.minor === minor && row.ino === fd.ino && row.holder === own[0].holder)) fail("inherited-exclusive-flock-not-proven");
}
function guard(context) {
  assertInheritedLock(context);
  for (const name of [context.paths.app, context.paths.dist, context.paths.releaseRoot, context.paths.status]) directory(context, name);
  for (const name of [context.paths.stageRoot, context.paths.recoveryRoot]) directory(context, name, true);
  if (fs.statSync(context.paths.stageRoot).dev !== fs.statSync(context.paths.dist).dev) fail("frontend-stage-must-share-dist-filesystem");
}
function requireIdle(context) { if (fs.existsSync(context.paths.current)) fail("release-recovery-pending"); }
function sequence(context, expected) {
  const value = read(context, context.paths.sequence, 128).bytes.toString("utf8");
  if (value !== expected + "\n") fail("consumed-release-sequence-mismatch");
}
function artifact(input, limit) {
  if (!exact(input, ["bytes", "sha256"]) || !Buffer.isBuffer(input.bytes) || !HASH.test(input.sha256 || "") || input.bytes.length > limit) fail("invalid-bound-artifact");
  const bytes = Buffer.from(input.bytes); if (hash(bytes) !== input.sha256) fail("artifact-digest-mismatch"); return { bytes, sha256: input.sha256 };
}
function receipt(input, expectedSha, version, target, checks) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > RECEIPT_MAX || !HASH.test(expectedSha || "")) fail("invalid-acceptance-receipt");
  const bytes = Buffer.from(input); if (hash(bytes) !== expectedSha) fail("acceptance-receipt-hash-mismatch");
  const value = JSON.parse(bytes.toString("utf8"));
  if (!exact(value, ["version", ...Object.keys(target), "checkedAt", "checks"]) || value.version !== version
    || Object.entries(target).some(([key, wanted]) => value[key] !== wanted)
    || !exact(value.checks, checks) || checks.some(key => value.checks[key] !== true)
    || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) || new Date(value.checkedAt).toISOString() !== value.checkedAt) fail("acceptance-receipt-contract-mismatch");
  return { bytes, value, sha256: expectedSha };
}
function step(context, phase) { context.onStep?.(phase); }
function prepareCurrent(context, record, acceptance = null) {
  const staging = path.join(context.paths.recoveryRoot, ".frontend-" + record.id);
  makeDirectory(context, staging, 0o700);
  const bytes = jsonBytes(record); if (bytes.length > RECORD_MAX) fail("transaction-record-limit");
  writeNew(context, path.join(staging, "frontend-transaction.json"), bytes);
  writeNew(context, path.join(staging, "complete.json"), jsonBytes({ version: VERSION, id: record.id, recordSha256: hash(bytes) }));
  writeNew(context, path.join(staging, "phase.json"), jsonBytes({ version: VERSION, phase: "prepared" }));
  if (acceptance) {
    writeNew(context, path.join(staging, "acceptance.json"), acceptance.bytes);
    writeNew(context, path.join(staging, "accept-intent.json"), jsonBytes({ version: VERSION, transactionId: record.id, acceptanceSha256: acceptance.sha256 }));
  }
  requireIdle(context); fs.renameSync(staging, context.paths.current); syncDir(context.paths.recoveryRoot); step(context, "prepared");
}
function phase(context, value) { atomicWrite(context, path.join(context.paths.current, "phase.json"), jsonBytes({ version: VERSION, phase: value }), 0o600); step(context, value); }
function stagePath(context, record) { return path.join(context.paths.stageRoot, record.id); }
function setStatePair(context, value, acceptanceBytes = null) {
  const bytes = jsonBytes(state(value));
  if (value.phase === "accepted") {
    if (!Buffer.isBuffer(acceptanceBytes) || acceptanceBytes.length > RECEIPT_MAX || hash(acceptanceBytes) !== value.acceptanceSha256) fail("public-acceptance-binding-required");
    atomicWrite(context, context.paths.acceptanceProjection, acceptanceBytes, 0o644); step(context, "acceptance-projection-written");
  }
  atomicWrite(context, context.paths.state, bytes, 0o600); step(context, "root-state-written");
  atomicWrite(context, context.paths.projection, bytes, 0o644); step(context, "projection-written");
}
function optionalStateSnapshot(context, filename) { const file = readState(context, filename, true); return file ? file.value : null; }
function allowedStates(context, record, additions = []) {
  for (const [filename, original] of [[context.paths.state, record.previousState], [context.paths.projection, record.previousProjection]]) {
    const value = optionalStateSnapshot(context, filename);
    if (![original, record.pendingState, ...additions].some(wanted => equal(value, wanted))) fail("external-frontend-state-change");
  }
}
function allowedReceiptHashes(context, record) {
  return [record.previousAcceptanceSha256, ...["acceptance.json", "rollback.json"].map(name => read(context, path.join(context.paths.current, name), RECEIPT_MAX, { optional: true })?.sha256 || null)];
}
function clearKnownAtomicTemps(context, record, additions = []) {
  const receipt = read(context, context.paths.acceptanceProjection, RECEIPT_MAX, { optional: true });
  const allowedHashes = allowedReceiptHashes(context, record);
  if (!allowedHashes.includes(receipt?.sha256 || null) || (receipt && receipt.identity.mode !== 0o644)) fail("external-public-acceptance-change");
  const receiptTemp = context.paths.acceptanceProjection + ".frontend-next", temporaryReceipt = read(context, receiptTemp, RECEIPT_MAX, { optional: true });
  if (temporaryReceipt) {
    if (!allowedHashes.includes(temporaryReceipt.sha256) || temporaryReceipt.identity.mode !== 0o644) fail("unknown-interrupted-acceptance-write");
    fs.unlinkSync(receiptTemp); syncDir(path.dirname(receiptTemp));
  }
  for (const [filename, original] of [[context.paths.state, record.previousState], [context.paths.projection, record.previousProjection]]) {
    const temporary = filename + ".frontend-next", file = read(context, temporary, 16384, { optional: true });
    if (!file) continue;
    if (![original, record.pendingState, ...additions].filter(Boolean).some(value => file.bytes.equals(jsonBytes(value)))
      || file.identity.mode !== (filename === context.paths.state ? 0o600 : 0o644)) fail("unknown-interrupted-state-write");
    if (read(context, temporary, 16384).stamp !== file.stamp) fail("interrupted-state-write-drift");
    fs.unlinkSync(temporary); syncDir(path.dirname(temporary));
  }
  const temporary = path.join(context.paths.current, "phase.json.frontend-next"), file = read(context, temporary, 1024, { optional: true });
  if (file) {
    const value = JSON.parse(file.bytes.toString("utf8"));
    if (!exact(value, ["version", "phase"]) || value.version !== VERSION || !["prepared", "assets-installed", "index-switch-intent", "index-switched", "accept-intent", "accepted", "rollback-intent", "rolled-back"].includes(value.phase)) fail("unknown-interrupted-phase");
    if (read(context, temporary, 1024).stamp !== file.stamp) fail("interrupted-phase-drift");
    fs.unlinkSync(temporary); syncDir(context.paths.current);
  }
}
function clearCurrent(context, record) {
  const destination = path.join(context.paths.recoveryRoot, ".frontend-resolved-" + record.id);
  if (fs.existsSync(destination)) fail("resolved-transaction-conflict");
  fs.renameSync(context.paths.current, destination); syncDir(context.paths.recoveryRoot);
  return destination;
}
function result(record, value, action, extra = {}) { return { version: VERSION, ok: true, transactionId: record.id, action,
  state: value, stateSha256: hash(jsonBytes(value)), requiresOuterTrustedAuthorization: true, deletes: [], ...extra }; }
function begin(context, input) {
  guard(context); requireIdle(context);
  if (!exact(input, ["expectedStateSha256", "expectedDistManifest", "candidateIndex", "newAssets", "runtimeSha256", "runtimeSequence", "frontendSha256", "frontendSequence", "authorizationSha256"])
    || ["expectedStateSha256", "runtimeSha256", "frontendSha256", "authorizationSha256"].some(key => !HASH.test(input[key] || ""))) fail("invalid-frontend-transaction-input");
  const previous = readState(context, context.paths.state), projection = readState(context, context.paths.projection), before = dist(context);
  const previousAcceptance = read(context, context.paths.acceptanceProjection, RECEIPT_MAX);
  if (previous.sha256 !== input.expectedStateSha256 || !previous.bytes.equals(projection.bytes) || previous.value.phase !== "accepted"
    || previousAcceptance.sha256 !== previous.value.acceptanceSha256 || previousAcceptance.identity.mode !== 0o644
    || previous.value.runtimeSha256 !== input.runtimeSha256 || previous.value.runtimeSequence !== input.runtimeSequence
    || !Number.isSafeInteger(input.frontendSequence) || input.frontendSequence <= previous.value.frontendSequence
    || !equal(before, input.expectedDistManifest) || before.treeHash !== previous.value.distTreeHash) fail("frontend-baseline-binding-mismatch");
  markers(context, input.runtimeSha256); sequence(context, input.frontendSequence);
  const candidate = artifact(input.candidateIndex, INDEX_MAX), index = read(context, path.join(context.paths.dist, "index.html"), INDEX_MAX);
  if (index.sha256 !== previous.value.indexSha256 || candidate.sha256 === index.sha256) fail("index-precondition-or-noop");
  if (!Array.isArray(input.newAssets) || input.newAssets.length > 4096) fail("invalid-assets");
  const seen = new Set(), rows = new Map(before.files.map(row => [row.path, row])); let inputBytes = candidate.bytes.length;
  const assets = input.newAssets.map(entry => {
    if (!exact(entry, ["path", "bytes", "sha256"]) || !ASSET.test(entry.path || "") || entry.path.split("/").some(p => p.startsWith(".")) || seen.has(entry.path)) fail("invalid-asset-path");
    seen.add(entry.path); const file = artifact({ bytes: entry.bytes, sha256: entry.sha256 }, ASSET_MAX); inputBytes += file.bytes.length;
    if (inputBytes > TREE_MAX) fail("asset-input-limit");
    const row = { path: entry.path, bytes: file.bytes.length, sha256: file.sha256 }, old = rows.get(entry.path);
    if (old && !equal(old, row)) fail("immutable-asset-name-collision"); rows.set(entry.path, row);
    return { ...file, path: entry.path, reused: Boolean(old) };
  });
  rows.set("index.html", { path: "index.html", bytes: candidate.bytes.length, sha256: candidate.sha256 });
  const finalManifest = manifest([...rows.values()]), id = crypto.randomBytes(12).toString("hex"), stage = path.join(context.paths.stageRoot, id);
  makeDirectory(context, stage, 0o700);
  writeNew(context, path.join(stage, "index.previous"), index.bytes, index.identity.mode);
  writeNew(context, path.join(stage, "index.next"), candidate.bytes, 0o644);
  const assetRecords = assets.map(asset => {
    const name = "asset-" + hash(asset.path), filename = path.join(stage, name);
    if (!asset.reused) writeNew(context, filename, asset.bytes, 0o644);
    return { path: asset.path, bytes: asset.bytes.length, sha256: asset.sha256, reused: asset.reused, stageName: name,
      identity: read(context, asset.reused ? path.join(context.paths.dist, asset.path) : filename, ASSET_MAX).identity };
  });
  const pendingState = state({ version: STATE_VERSION, kind: "frontend-only", phase: "pending", runtimeSha256: input.runtimeSha256,
    runtimeSequence: input.runtimeSequence, frontendSha256: input.frontendSha256, frontendSequence: input.frontendSequence,
    indexSha256: candidate.sha256, distTreeHash: finalManifest.treeHash, acceptanceSha256: null });
  const record = { version: VERSION, kind: "frontend-only", id, authorizationSha256: input.authorizationSha256,
    previousState: previous.value, previousProjection: projection.value, previousAcceptanceSha256: previousAcceptance.sha256,
    pendingState, baselineManifest: before, finalManifest,
    original: index.identity, candidate: read(context, path.join(stage, "index.next"), INDEX_MAX).identity,
    backup: read(context, path.join(stage, "index.previous"), INDEX_MAX).identity, assets: assetRecords,
    stageIdentity: { dev: String(fs.statSync(stage).dev), ino: String(fs.statSync(stage).ino) } };
  prepareCurrent(context, record); allowedStates(context, record); setStatePair(context, pendingState);
  for (const asset of assetRecords) {
    if (asset.reused) continue;
    const source = path.join(stage, asset.stageName), target = path.join(context.paths.dist, asset.path);
    directory(context, path.dirname(target));
    fs.linkSync(source, target); syncDir(path.dirname(target)); step(context, "asset-linked");
    fs.unlinkSync(source); syncDir(stage); step(context, "asset-installed");
  }
  phase(context, "assets-installed"); assertTree(context, record, "original", true);
  allowedStates(context, record); assertInheritedLock(context);
  if (!equal(read(context, path.join(context.paths.dist, "index.html"), INDEX_MAX).identity, record.original)) fail("index-cas-before-switch");
  phase(context, "index-switch-intent");
  fs.renameSync(path.join(stage, "index.next"), path.join(context.paths.dist, "index.html")); syncDir(context.paths.dist); step(context, "index-renamed");
  assertTree(context, record, "candidate", true); phase(context, "index-switched");
  return result(record, pendingState, "pending-acceptance");
}
function descriptor(value) {
  if (!exact(value, ["dev", "ino", "bytes", "mode", "uid", "gid", "sha256"]) || !/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > TREE_MAX || !Number.isSafeInteger(value.mode)
    || !Number.isSafeInteger(value.uid) || !Number.isSafeInteger(value.gid) || !HASH.test(value.sha256 || "")) fail("invalid-persistent-file-identity");
}
function load(context) {
  guard(context); directory(context, context.paths.current, true);
  const members = fs.readdirSync(context.paths.current).sort();
  const allowed = ["frontend-transaction.json", "complete.json", "phase.json", "phase.json.frontend-next", "acceptance.json", "accept-intent.json", "rollback.json", "rollback-intent.json"];
  if (members.some(name => !allowed.includes(name))) fail("unknown-frontend-recovery-member");
  const raw = read(context, path.join(context.paths.current, "frontend-transaction.json"), RECORD_MAX), record = JSON.parse(raw.bytes.toString("utf8"));
  const complete = JSON.parse(read(context, path.join(context.paths.current, "complete.json"), 1024).bytes.toString("utf8"));
  if (!exact(complete, ["version", "id", "recordSha256"]) || complete.version !== VERSION || complete.recordSha256 !== raw.sha256
    || !ID.test(record.id || "") || complete.id !== record.id || record.version !== VERSION || !["frontend-only", "full-initialize"].includes(record.kind)) fail("frontend-recovery-record-binding");
  const common = ["version", "kind", "id", "authorizationSha256", "previousState", "previousProjection", "previousAcceptanceSha256", "pendingState", "baselineManifest", "finalManifest", "original", "candidate", "backup", "assets", "stageIdentity"];
  if (!exact(record, common) || !HASH.test(record.authorizationSha256 || "")
    || !(record.previousAcceptanceSha256 === null || HASH.test(record.previousAcceptanceSha256 || ""))) fail("invalid-frontend-recovery-record");
  for (const value of [record.previousState, record.previousProjection]) if (value !== null) state(value);
  state(record.pendingState); if (record.pendingState.phase !== "pending") fail("invalid-recovery-pending-state");
  if (!equal(manifest(record.baselineManifest.files), record.baselineManifest) || !equal(manifest(record.finalManifest.files), record.finalManifest)
    || record.finalManifest.treeHash !== record.pendingState.distTreeHash) fail("recovery-dist-manifest-binding");
  for (const value of [record.original, record.candidate, record.backup]) descriptor(value);
  if (!Array.isArray(record.assets) || record.assets.length > 4096) fail("invalid-recovery-assets");
  const seen = new Set();
  for (const row of record.assets) {
    if (!exact(row, ["path", "bytes", "sha256", "reused", "stageName", "identity"]) || !ASSET.test(row.path || "")
      || row.path.split("/").some(p => p.startsWith(".")) || seen.has(row.path) || typeof row.reused !== "boolean"
      || row.stageName !== "asset-" + hash(row.path) || row.identity?.bytes !== row.bytes || row.identity?.sha256 !== row.sha256) fail("invalid-recovery-asset");
    seen.add(row.path); descriptor(row.identity);
  }
  const stage = stagePath(context, record); directory(context, stage, true); const stat = fs.statSync(stage);
  if (!exact(record.stageIdentity, ["dev", "ino"]) || String(stat.dev) !== record.stageIdentity.dev || String(stat.ino) !== record.stageIdentity.ino) fail("recovery-stage-identity-changed");
  const stageNames = new Set(["index.previous", "index.next", ...record.assets.filter(row => !row.reused).map(row => row.stageName)]);
  if (fs.readdirSync(stage).some(name => !stageNames.has(name))) fail("unknown-frontend-stage-member");
  const phaseRecord = JSON.parse(read(context, path.join(context.paths.current, "phase.json"), 1024).bytes.toString("utf8"));
  if (!exact(phaseRecord, ["version", "phase"]) || phaseRecord.version !== VERSION
    || !["prepared", "assets-installed", "index-switch-intent", "index-switched", "accept-intent", "accepted", "rollback-intent", "rolled-back"].includes(phaseRecord.phase)) fail("unknown-frontend-recovery-phase");
  markers(context, record.pendingState.runtimeSha256);
  return record;
}
function normalizeAssetAliases(context, record) {
  const stage = stagePath(context, record);
  for (const asset of record.assets) {
    if (asset.reused) continue;
    const source = path.join(stage, asset.stageName), target = path.join(context.paths.dist, asset.path);
    const temporary = read(context, source, ASSET_MAX, { optional: true, links: [1, 2] });
    const installed = read(context, target, ASSET_MAX, { optional: true, links: [1, 2] });
    if (temporary && !equal(temporary.identity, asset.identity)) fail("staged-asset-identity-drift");
    if (installed && !equal(installed.identity, asset.identity)) fail("installed-asset-identity-drift");
    if (temporary?.links === 2 || installed?.links === 2) {
      if (!temporary || !installed || temporary.links !== 2 || installed.links !== 2 || !equal(temporary.identity, installed.identity)) fail("unknown-asset-hardlink");
      fs.unlinkSync(source); syncDir(stage);
    } else if (!temporary && !installed) fail("transaction-asset-missing");
  }
}
function indexRole(context, record) {
  const current = read(context, path.join(context.paths.dist, "index.html"), INDEX_MAX);
  for (const role of ["original", "candidate", "backup"]) if (equal(current.identity, record[role])) return role;
  fail("external-index-identity-change");
}
function assertTree(context, record, role, requireAll = false) {
  const actual = dist(context), wanted = new Map(record.baselineManifest.files.map(row => [row.path, row]));
  wanted.set("index.html", { path: "index.html", bytes: record[role].bytes, sha256: record[role].sha256 });
  for (const asset of record.assets) {
    const current = actual.files.find(row => row.path === asset.path);
    if (requireAll && !current) fail("required-asset-not-installed");
    if (current) { if (current.sha256 !== asset.sha256 || current.bytes !== asset.bytes) fail("asset-content-drift"); wanted.set(asset.path, current); }
  }
  if (!equal(actual, manifest([...wanted.values()])) || indexRole(context, record) !== role) fail("undeclared-dist-change");
  return actual;
}
function acceptanceTarget(record) { const value = record.pendingState; return { transactionId: record.id, runtimeSha256: value.runtimeSha256,
  runtimeSequence: value.runtimeSequence, frontendSha256: value.frontendSha256, frontendSequence: value.frontendSequence,
  indexSha256: value.indexSha256, distTreeHash: value.distTreeHash, authorizationSha256: record.authorizationSha256 }; }
function validateAcceptance(record, bytes, sha256) {
  return record.kind === "full-initialize"
    ? receipt(bytes, sha256, "frontend-full-baseline-acceptance-v1", { runtimeSha256: record.pendingState.runtimeSha256,
      runtimeSequence: record.pendingState.runtimeSequence, indexSha256: record.pendingState.indexSha256, distTreeHash: record.pendingState.distTreeHash }, ["runtimeMarkers", "health", "sourceBaseline"])
    : receipt(bytes, sha256, "frontend-readonly-acceptance-v1", acceptanceTarget(record), ["index", "assets", "health", "protected", "services"]);
}
function loadIntent(context, record) {
  const raw = read(context, path.join(context.paths.current, "accept-intent.json"), 4096, { optional: true }); if (!raw) return null;
  const value = JSON.parse(raw.bytes.toString("utf8"));
  if (!exact(value, ["version", "transactionId", "acceptanceSha256"]) || value.version !== VERSION || value.transactionId !== record.id || !HASH.test(value.acceptanceSha256 || "")) fail("invalid-accept-intent");
  const acceptance = read(context, path.join(context.paths.current, "acceptance.json"), RECEIPT_MAX);
  validateAcceptance(record, acceptance.bytes, value.acceptanceSha256);
  return state({ ...record.pendingState, phase: "accepted", acceptanceSha256: value.acceptanceSha256 });
}
function forward(context, record, accepted) {
  allowedStates(context, record, [accepted]); normalizeAssetAliases(context, record);
  assertTree(context, record, record.kind === "full-initialize" ? "original" : "candidate", true);
  clearKnownAtomicTemps(context, record, [accepted]);
  assertInheritedLock(context); setStatePair(context, accepted, read(context, path.join(context.paths.current, "acceptance.json"), RECEIPT_MAX).bytes); phase(context, "accepted");
  const archive = clearCurrent(context, record); return result(record, accepted, record.kind === "full-initialize" ? "full-initialized" : "accepted", { archive });
}
function accept(context, input) {
  if (!exact(input, ["transactionId", "acceptanceReceiptBytes", "acceptanceSha256"]) || !ID.test(input.transactionId || "")) fail("invalid-accept-input");
  const record = load(context); if (record.id !== input.transactionId || record.kind !== "frontend-only") fail("accept-transaction-mismatch");
  const checked = validateAcceptance(record, input.acceptanceReceiptBytes, input.acceptanceSha256);
  const age = Date.now() - Date.parse(checked.value.checkedAt); if (age < -5000 || age > 5 * 60 * 1000) fail("acceptance-receipt-not-fresh");
  if (fs.existsSync(path.join(context.paths.current, "rollback-intent.json"))) fail("rollback-already-started");
  allowedStates(context, record); normalizeAssetAliases(context, record); assertTree(context, record, "candidate", true);
  writeNew(context, path.join(context.paths.current, "acceptance.json"), checked.bytes);
  step(context, "acceptance-written");
  writeNew(context, path.join(context.paths.current, "accept-intent.json"), jsonBytes({ version: VERSION, transactionId: record.id, acceptanceSha256: checked.sha256 }));
  step(context, "accept-intent-written"); phase(context, "accept-intent");
  return forward(context, record, loadIntent(context, record));
}
function rollback(context, record) {
  if (record.kind !== "frontend-only") fail("full-initialization-missing-accept-intent");
  normalizeAssetAliases(context, record);
  let role = indexRole(context, record); const actual = assertTree(context, record, role);
  const existing = read(context, path.join(context.paths.current, "rollback-intent.json"), RECEIPT_MAX, { optional: true });
  let restored;
  if (existing) {
    const value = JSON.parse(existing.bytes.toString("utf8"));
    if (!exact(value, ["version", "transactionId", "state", "receiptSha256"]) || value.version !== VERSION || value.transactionId !== record.id) fail("invalid-rollback-intent");
    restored = state(value.state);
    const rollbackFile = read(context, path.join(context.paths.current, "rollback.json"), RECEIPT_MAX), body = JSON.parse(rollbackFile.bytes.toString("utf8"));
    if (rollbackFile.sha256 !== value.receiptSha256 || restored.acceptanceSha256 !== value.receiptSha256
      || !exact(body, ["version", "transactionId", "authorizationSha256", "previousState", "indexSha256", "distTreeHash", "retainedAssetsSha256", "retainedAssetCount", "newFrontendAccepted"])
      || body.version !== "frontend-rollback-acceptance-v1" || body.transactionId !== record.id
      || body.authorizationSha256 !== record.authorizationSha256 || !equal(body.previousState, record.previousState)
      || body.distTreeHash !== restored.distTreeHash || body.indexSha256 !== record.original.sha256 || body.newFrontendAccepted !== false
      || !equal(restored, state({ ...record.previousState, distTreeHash: body.distTreeHash, acceptanceSha256: rollbackFile.sha256 }))) fail("rollback-receipt-binding");
  } else {
    if (role === "backup") fail("rollback-index-without-intent");
    const final = manifest(actual.files.map(row => row.path === "index.html" ? { path: "index.html", bytes: record.original.bytes, sha256: record.original.sha256 } : row));
    const retained = actual.files.filter(row => record.assets.some(asset => asset.path === row.path && !asset.reused));
    const body = { version: "frontend-rollback-acceptance-v1", transactionId: record.id, authorizationSha256: record.authorizationSha256,
      previousState: record.previousState, indexSha256: record.original.sha256, distTreeHash: final.treeHash,
      retainedAssetsSha256: hash(jsonBytes(retained)), retainedAssetCount: retained.length, newFrontendAccepted: false };
    const bytes = jsonBytes(body), sha256 = hash(bytes);
    restored = state({ ...record.previousState, distTreeHash: final.treeHash, acceptanceSha256: sha256 });
    allowedStates(context, record);
    const oldReceipt = read(context, path.join(context.paths.current, "rollback.json"), RECEIPT_MAX, { optional: true });
    if (oldReceipt ? !oldReceipt.bytes.equals(bytes) : false) fail("rollback-receipt-conflict");
    if (!oldReceipt) writeNew(context, path.join(context.paths.current, "rollback.json"), bytes);
    writeNew(context, path.join(context.paths.current, "rollback-intent.json"), jsonBytes({ version: VERSION, transactionId: record.id, state: restored, receiptSha256: sha256 }));
    step(context, "rollback-intent-written");
  }
  allowedStates(context, record, [restored]); clearKnownAtomicTemps(context, record, [restored]); phase(context, "rollback-intent"); assertInheritedLock(context);
  if (role === "candidate") {
    const backupPath = path.join(stagePath(context, record), "index.previous");
    if (!equal(read(context, backupPath, INDEX_MAX).identity, record.backup) || indexRole(context, record) !== "candidate") fail("rollback-index-cas-drift");
    fs.renameSync(backupPath, path.join(context.paths.dist, "index.html")); syncDir(context.paths.dist); step(context, "rollback-index-renamed"); role = "backup";
  }
  const final = assertTree(context, record, role);
  if (final.treeHash !== restored.distTreeHash || read(context, path.join(context.paths.dist, "index.html"), INDEX_MAX).sha256 !== restored.indexSha256) fail("rollback-final-tree-mismatch");
  setStatePair(context, restored, read(context, path.join(context.paths.current, "rollback.json"), RECEIPT_MAX).bytes); phase(context, "rolled-back");
  const archive = clearCurrent(context, record); return result(record, restored, "rolled-back", { newFrontendAccepted: false, archive });
}
function recover(context) {
  guard(context); if (!fs.existsSync(context.paths.current)) return { version: VERSION, ok: true, action: "noop", deletes: [] };
  const record = load(context), accepted = loadIntent(context, record);
  if (accepted && fs.existsSync(path.join(context.paths.current, "rollback-intent.json"))) fail("conflicting-accept-and-rollback-intents");
  return accepted ? forward(context, record, accepted) : rollback(context, record);
}
function initialize(context, input) {
  guard(context); requireIdle(context);
  if (!exact(input, ["runtimeSha256", "runtimeSequence", "acceptanceReceiptBytes", "acceptanceSha256"]) || !HASH.test(input.runtimeSha256 || "")
    || !Number.isSafeInteger(input.runtimeSequence) || input.runtimeSequence < 1) fail("invalid-full-initialization-input");
  markers(context, input.runtimeSha256); sequence(context, input.runtimeSequence);
  const status = Object.fromEntries(read(context, path.join(context.paths.status, input.runtimeSha256 + ".status"), 16384).bytes.toString("utf8").trim().split("\n").map(line => {
    const at = line.indexOf("="); if (at < 1) fail("invalid-full-release-status"); return [line.slice(0, at), line.slice(at + 1)];
  }));
  const completed = status.finishedAt, canonicalCompleted = typeof completed === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(completed)
    && Number.isFinite(Date.parse(completed)) && new Date(completed).toISOString() === (completed.length === 20 ? completed.replace("Z", ".000Z") : completed);
  if (status.status !== "complete" || status.ok !== "1" || status.exitCode !== "0" || status.bundleSha256 !== input.runtimeSha256
    || !canonicalCompleted) fail("full-release-acceptance-not-proven");
  const before = dist(context), index = read(context, path.join(context.paths.dist, "index.html"), INDEX_MAX);
  const checked = receipt(input.acceptanceReceiptBytes, input.acceptanceSha256, "frontend-full-baseline-acceptance-v1",
    { runtimeSha256: input.runtimeSha256, runtimeSequence: input.runtimeSequence, indexSha256: index.sha256, distTreeHash: before.treeHash }, ["runtimeMarkers", "health", "sourceBaseline"]);
  const age = Date.now() - Date.parse(checked.value.checkedAt); if (age < -5000 || age > 5 * 60 * 1000) fail("full-acceptance-receipt-not-fresh");
  const id = crypto.randomBytes(12).toString("hex"), stage = path.join(context.paths.stageRoot, id); makeDirectory(context, stage, 0o700);
  const record = { version: VERSION, kind: "full-initialize", id, authorizationSha256: input.runtimeSha256,
    previousState: optionalStateSnapshot(context, context.paths.state), previousProjection: optionalStateSnapshot(context, context.paths.projection),
    previousAcceptanceSha256: read(context, context.paths.acceptanceProjection, RECEIPT_MAX, { optional: true })?.sha256 || null,
    pendingState: state({ version: STATE_VERSION, kind: "full", phase: "pending", runtimeSha256: input.runtimeSha256, runtimeSequence: input.runtimeSequence,
      frontendSha256: input.runtimeSha256, frontendSequence: input.runtimeSequence, indexSha256: index.sha256, distTreeHash: before.treeHash, acceptanceSha256: null }),
    baselineManifest: before, finalManifest: before, original: index.identity, candidate: index.identity, backup: index.identity, assets: [],
    stageIdentity: { dev: String(fs.statSync(stage).dev), ino: String(fs.statSync(stage).ino) } };
  prepareCurrent(context, record, checked);
  step(context, "full-accept-intent-written");
  return forward(context, record, loadIntent(context, record));
}
function production() { return { paths: paths(FIXED), uid: 0, boundary: "/", fixture: false }; }
function createFrontendReleaseFixtureAdapter({ onStep } = {}) {
  if (process.platform !== "linux") fail("linux-frontend-transaction-fixture-required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "football-frontend-release-fixture-")); fs.chmodSync(root, 0o700);
  const configured = paths({ app: path.join(root, "app"), releaseRoot: path.join(root, "release"), stageRoot: path.join(root, "stages"), lock: path.join(root, "fixture.lock") });
  for (const [filename, mode] of [[configured.app, 0o755], [configured.releaseRoot, 0o755], [configured.stageRoot, 0o700],
    [configured.dist, 0o755], [path.join(configured.dist, "assets"), 0o755], [configured.recoveryRoot, 0o700], [configured.status, 0o700]]) fs.mkdirSync(filename, { mode });
  const rootStat = fs.statSync(root); let held = false, disposed = false;
  const context = { paths: configured, uid: process.getuid(), boundary: root, fixture: true, onStep,
    assertFixtureLock() { if (!held || disposed || fs.realpathSync(root) !== root || fs.statSync(root).ino !== rootStat.ino) fail("fixture-lock-not-held"); } };
  const locked = call => { if (held || disposed) fail("fixture-lock-busy-or-disposed"); held = true; try { return call(); } finally { held = false; } };
  return Object.freeze({ fixtureOnly: true, deploymentAuthorized: false, rootDir: root, paths: Object.freeze(configured),
    begin: input => locked(() => begin(context, input)), accept: input => locked(() => accept(context, input)),
    recover: () => locked(() => recover(context)), initialize: input => locked(() => initialize(context, input)),
    dispose() { if (held || disposed || fs.realpathSync(root) !== root || fs.statSync(root).ino !== rootStat.ino) fail("fixture-dispose-identity"); fs.rmSync(root, { recursive: true }); disposed = true; } });
}
module.exports = { VERSION, STATE_VERSION, FIXED, beginFrontendRelease: input => begin(production(), input),
  assertFrontendReleaseLock: () => guard(production()),
  acceptFrontendRelease: input => accept(production(), input), recoverFrontendRelease: () => recover(production()),
  initializeFullFrontendState: input => initialize(production(), input), createFrontendReleaseFixtureAdapter };
