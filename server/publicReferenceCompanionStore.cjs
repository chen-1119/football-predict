"use strict";

// Private original-byte custody, not a publication authority. A pair is useful
// only when an independently admitted public record has this exact binding.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { attestPublicReferenceDecision } = require("../src/services/publicReferenceDecision.cjs");
const { verifyPublicReferenceEvidence } = require("../src/services/publicReferenceEvidence.cjs");
const VERSION = "public-reference-companion-custody-v1";
const MAX_PAIR_BYTES = 32 * 1024 * 1024;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const plainDirectory = directory => {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("REFERENCE_CUSTODY_UNSAFE_PATH");
};
const rootPath = storeDir => {
  const base = path.resolve(storeDir);
  plainDirectory(base);
  const real = fs.realpathSync(base);
  if ((process.platform === "win32" ? real.toLowerCase() !== base.toLowerCase() : real !== base)) {
    fail("REFERENCE_CUSTODY_UNSAFE_PATH");
  }
  return path.join(base, "public-reference-companions");
};
const pairPath = (storeDir, hash) => {
  if (!/^[a-f0-9]{64}$/.test(hash || "")) fail("REFERENCE_CUSTODY_HASH_INVALID");
  return path.join(rootPath(storeDir), hash);
};
function syncDirectory(directory) {
  // Windows cannot fsync directories through Node. Windows tests establish
  // process-crash behavior only; Linux must successfully sync every directory.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const n = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!n) fail("REFERENCE_CUSTODY_WRITE_STALLED");
    offset += n;
  }
}
function writeNew(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { writeAll(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readPlain(file, limit) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) {
    fail("REFERENCE_CUSTODY_UNSAFE_FILE");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!same(before, fs.fstatSync(fd))) fail("REFERENCE_CUSTODY_FILE_CHANGED");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) fail("REFERENCE_CUSTODY_FILE_CHANGED");
      offset += n;
    }
    const after = fs.lstatSync(file);
    if (!same(before, fs.fstatSync(fd)) || !same(before, after) || after.isSymbolicLink()) {
      fail("REFERENCE_CUSTODY_FILE_CHANGED");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
function parse(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("REFERENCE_CUSTODY_JSON_INVALID"); }
}
function validate(record, entry) {
  if (!record?.evidenceBinding || !attestPublicReferenceDecision(record, record)
    || !verifyPublicReferenceEvidence(entry, record)) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_INVALID");
}
function readAt(directory, record) {
  plainDirectory(directory);
  const seal = parse(readPlain(path.join(directory, "seal.json"), 4096));
  if (seal.version !== VERSION || seal.referenceHash !== record.contentHash
    || !Number.isSafeInteger(seal.bytes) || seal.bytes <= 0 || seal.bytes > MAX_PAIR_BYTES
    || !/^[a-f0-9]{64}$/.test(seal.sha256 || "")) fail("REFERENCE_CUSTODY_SEAL_INVALID");
  const bytes = readPlain(path.join(directory, "pair.json"), MAX_PAIR_BYTES);
  if (bytes.length !== seal.bytes || sha(bytes) !== seal.sha256) fail("REFERENCE_CUSTODY_BYTES_INVALID");
  const pair = parse(bytes);
  if (pair.version !== VERSION || JSON.stringify(pair.record) !== JSON.stringify(record)) {
    fail("REFERENCE_CUSTODY_RECORD_CONFLICT");
  }
  validate(pair.record, pair.entry);
  return { entry: pair.entry, seal };
}
function readOriginalCompanion(storeDir, record) {
  const directory = pairPath(storeDir, record?.contentHash);
  const root = path.dirname(directory);
  if (!fs.existsSync(root)) return null;
  plainDirectory(root);
  try { fs.lstatSync(directory); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return readAt(directory, record);
}
function persistOriginalCompanion(storeDir, record, entry) {
  validate(record, entry);
  const bytes = Buffer.from(JSON.stringify({ version: VERSION, record, entry }));
  if (bytes.length > MAX_PAIR_BYTES) fail("REFERENCE_CUSTODY_PAIR_LIMIT");
  const directory = pairPath(storeDir, record.contentHash), root = path.dirname(directory);
  if (!fs.existsSync(root)) { fs.mkdirSync(root, { mode: 0o700 }); syncDirectory(path.dirname(root)); }
  plainDirectory(root);
  if (fs.existsSync(directory)) {
    const original = readAt(directory, record);
    if (original.seal.sha256 !== sha(bytes)) fail("REFERENCE_CUSTODY_PAIR_CONFLICT");
    syncDirectory(root);
    return { ...original.seal, inserted: false, durability: process.platform === "win32" ? "process-crash" : "directory-fsync" };
  }
  // Interrupted stages and original files are deliberately retained. Readers
  // never discover or admit .pending-* directories, even if their bytes parse.
  const staging = fs.mkdtempSync(path.join(root, ".pending-"));
  fs.chmodSync(staging, 0o700);
  const seal = { version: VERSION, referenceHash: record.contentHash, bytes: bytes.length, sha256: sha(bytes) };
  writeNew(path.join(staging, "pair.json"), bytes);
  writeNew(path.join(staging, "seal.json"), Buffer.from(JSON.stringify(seal)));
  syncDirectory(staging);
  // A directory containing both synced files becomes visible in one rename.
  // A competing writer cannot replace the nonempty immutable destination.
  fs.renameSync(staging, directory);
  syncDirectory(root);
  const original = readAt(directory, record);
  if (original.seal.sha256 !== seal.sha256) fail("REFERENCE_CUSTODY_BYTES_INVALID");
  return { ...seal, inserted: true, durability: process.platform === "win32" ? "process-crash" : "directory-fsync" };
}
function persistCurrentReferenceCompanions(storeDir, matches, entries) {
  const wanted = new Map();
  for (const match of matches) {
    const record = match?.predictionMeta?.publicReferenceDecision;
    if (!record?.evidenceBinding) continue;
    if (!attestPublicReferenceDecision(record, match)) fail("REFERENCE_CUSTODY_CURRENT_INVALID");
    const previous = wanted.get(record.contentHash);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) fail("REFERENCE_CUSTODY_RECORD_CONFLICT");
    wanted.set(record.contentHash, record);
  }
  const found = new Set();
  // Process one complete entry at a time. No second retained model graph.
  for (const entry of entries) {
    const record = wanted.get(entry?.referenceHash);
    if (!record) continue;
    persistOriginalCompanion(storeDir, record, entry);
    found.add(record.contentHash);
  }
  for (const [hash, record] of wanted) if (!found.has(hash)) {
    // Snapshot retention may omit an old current/history reference from this
    // cycle's warehouse. Its previously durable exact original still proves
    // custody; do not recreate it or change the retained public output.
    if (!readOriginalCompanion(storeDir, record)) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING");
    // A previous writer may have stopped after rename but before syncing its
    // parent. Complete that same durability boundary before granting custody.
    syncDirectory(rootPath(storeDir));
  }
  return { references: wanted.size, durability: process.platform === "win32" ? "process-crash" : "directory-fsync" };
}
function assertCurrentReferenceCompanions(storeDir, matches) {
  let references = 0;
  for (const match of matches) {
    const record = match?.predictionMeta?.publicReferenceDecision;
    if (!record?.evidenceBinding) continue;
    if (!attestPublicReferenceDecision(record, match)) fail("REFERENCE_CUSTODY_CURRENT_INVALID");
    if (!readOriginalCompanion(storeDir, record)) fail("PUBLIC_REFERENCE_EVIDENCE_BINDING_MISSING");
    references++;
  }
  return { references };
}
function importCompleteOriginalArchive(storeDir, context, options = {}) {
  // The original builder completes every strict JSON/UTF8/hash/binding pass
  // before returning. Prefix callbacks from an incomplete file are never used.
  const { buildStreamedPublicReferenceArchive } = require("./streamedPublicReferenceArchive.cjs");
  const { SOURCE_ID, INDEX_ID } = require("./publicReferenceArchive.cjs");
  const archive = buildStreamedPublicReferenceArchive(context, options);
  if (!archive) return { references: 0 };
  let references = 0;
  try {
    for (const row of archive.rows()) {
      if (row.id === SOURCE_ID || row.id === INDEX_ID) continue;
      const pair = JSON.parse(row.payload);
      if (!pair.record.evidenceBinding) continue;
      persistOriginalCompanion(storeDir, pair.record, pair.entry);
      references++;
    }
    return { references, sourceSha256: context.manifest.files.find(x => x.path === "prediction-snapshots.json").sha256 };
  } finally { archive.close(); }
}
module.exports = { persistOriginalCompanion, readOriginalCompanion, persistCurrentReferenceCompanions,
  assertCurrentReferenceCompanions, importCompleteOriginalArchive };
