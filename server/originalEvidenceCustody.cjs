"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const VERSION = "original-evidence-custody-v1";
const MAX_FILES = 128;
const MAX_BYTES = 8 * 1024 ** 3;
const CHUNK_BYTES = 1024 * 1024;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const same = (left, right) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"]
  .every(key => left[key] === right[key]);

function directoryChain(directory) {
  const ancestors = [];
  let current = path.resolve(directory);
  while (true) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("ORIGINAL_CUSTODY_UNSAFE_DIRECTORY");
    ancestors.push({ path: current, dev: stat.dev, ino: stat.ino });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

function checkDirectories(ancestors) {
  for (const previous of ancestors) {
    const current = fs.lstatSync(previous.path);
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== previous.dev || current.ino !== previous.ino) fail("ORIGINAL_CUSTODY_DIRECTORY_CHANGED");
  }
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (!written) fail("ORIGINAL_CUSTODY_WRITE_STALLED");
    offset += written;
  }
}

function inspectFile(file, expected) {
  const ancestors = directoryChain(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size !== expected.bytes) fail("ORIGINAL_CUSTODY_UNSAFE_FILE");
  return { file, stat, ancestors };
}

function streamFile(observation, destinationDescriptor) {
  checkDirectories(observation.ancestors);
  const descriptor = fs.openSync(observation.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const digest = crypto.createHash("sha256");
  let bytes = 0;
  try {
    if (!same(observation.stat, fs.fstatSync(descriptor))) fail("ORIGINAL_CUSTODY_SOURCE_CHANGED");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (bytes < observation.stat.size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, observation.stat.size - bytes), bytes);
      if (!count) fail("ORIGINAL_CUSTODY_SOURCE_CHANGED");
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
      if (destinationDescriptor !== undefined) writeAll(destinationDescriptor, chunk);
      bytes += count;
    }
    const current = fs.lstatSync(observation.file);
    if (current.isSymbolicLink() || !same(observation.stat, current)
      || !same(observation.stat, fs.fstatSync(descriptor))) fail("ORIGINAL_CUSTODY_SOURCE_CHANGED");
    checkDirectories(observation.ancestors);
    return { bytes, sha256: digest.digest("hex") };
  } finally { fs.closeSync(descriptor); }
}

function validateSources(sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > MAX_FILES) fail("ORIGINAL_CUSTODY_SOURCE_LIMIT");
  const names = new Set();
  const paths = new Set();
  let total = 0;
  for (const source of sources) {
    if (!source || !/^[a-z][a-z0-9-]{0,79}\.(json|dump|sha256)$/.test(source.name || "")
      || !path.isAbsolute(source.path || "") || !Number.isSafeInteger(source.bytes) || source.bytes < 1
      || !/^[a-f0-9]{64}$/.test(source.sha256 || "") || names.has(source.name)
      || paths.has(path.resolve(source.path))) fail("ORIGINAL_CUSTODY_SOURCE_INVALID");
    names.add(source.name);
    paths.add(path.resolve(source.path));
    total += source.bytes;
    if (!Number.isSafeInteger(total) || total > MAX_BYTES) fail("ORIGINAL_CUSTODY_BYTE_LIMIT");
  }
  return total;
}

function createOriginalEvidenceCustody({ destinationRoot, sources, runtimeSha256 }) {
  validateSources(sources);
  if (!/^[a-f0-9]{64}$/.test(runtimeSha256 || "")) fail("ORIGINAL_CUSTODY_RUNTIME_INVALID");
  const root = path.resolve(destinationRoot);
  const rootAncestors = directoryChain(root);
  if (process.platform !== "win32") {
    const stat = fs.statSync(root);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail("ORIGINAL_CUSTODY_ROOT_PERMISSIONS");
  }
  const observations = sources.map(source => inspectFile(source.path, source));
  const staging = fs.mkdtempSync(path.join(root, ".pending-"));
  fs.chmodSync(staging, 0o700);
  const entries = [];
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const target = path.join(staging, source.name);
    const descriptor = fs.openSync(target, "wx", 0o600);
    let copied;
    try { copied = streamFile(observations[index], descriptor); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    if (copied.bytes !== source.bytes || copied.sha256 !== source.sha256) fail("ORIGINAL_CUSTODY_SOURCE_HASH");
    const reread = streamFile(inspectFile(target, source));
    if (reread.sha256 !== source.sha256) fail("ORIGINAL_CUSTODY_COPY_HASH");
    entries.push({ ...source, ...copied });
  }
  for (let index = 0; index < sources.length; index++) {
    const current = streamFile(observations[index]);
    if (current.sha256 !== sources[index].sha256) fail("ORIGINAL_CUSTODY_SOURCE_HASH");
  }
  checkDirectories(rootAncestors);
  const body = { version: VERSION, createdAt: new Date().toISOString(), runtimeSha256,
    scope: "original-files-only", databaseSnapshotIncluded: false, evidenceRecoveryGranted: false,
    collectionAdmissionGranted: false, sources: entries,
    durability: process.platform === "win32" ? "process-crash-only" : "directory-fsync" };
  const manifest = Buffer.from(JSON.stringify(body));
  const seal = { version: VERSION, bytes: manifest.length, sha256: hash(manifest) };
  for (const [name, bytes] of [["manifest.json", manifest], ["seal.json", Buffer.from(JSON.stringify(seal))]]) {
    const descriptor = fs.openSync(path.join(staging, name), "wx", 0o600);
    try { writeAll(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  syncDirectory(staging);
  const destination = path.join(root, seal.sha256);
  if (fs.existsSync(destination)) fail("ORIGINAL_CUSTODY_DESTINATION_EXISTS");
  fs.renameSync(staging, destination);
  syncDirectory(root);
  return verifyOriginalEvidenceCustody(destination);
}

function verifyOriginalEvidenceCustody(directory) {
  if (!/^[a-f0-9]{64}$/.test(path.basename(directory))) fail("ORIGINAL_CUSTODY_UNCOMMITTED");
  const ancestors = directoryChain(directory);
  function readSmall(name, limit) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail("ORIGINAL_CUSTODY_SEAL_INVALID");
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (!same(stat, fs.fstatSync(descriptor))) fail("ORIGINAL_CUSTODY_SOURCE_CHANGED");
      const bytes = fs.readFileSync(descriptor);
      if (bytes.length !== stat.size || !same(stat, fs.fstatSync(descriptor))
        || !same(stat, fs.lstatSync(file))) fail("ORIGINAL_CUSTODY_SOURCE_CHANGED");
      return bytes;
    } finally { fs.closeSync(descriptor); }
  }
  const seal = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readSmall("seal.json", 4096)));
  const bytes = readSmall("manifest.json", 128 * 1024);
  if (seal.version !== VERSION || seal.bytes !== bytes.length || seal.sha256 !== hash(bytes)
    || seal.sha256 !== path.basename(directory)) fail("ORIGINAL_CUSTODY_SEAL_INVALID");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (manifest.version !== VERSION || manifest.scope !== "original-files-only"
    || manifest.databaseSnapshotIncluded !== false || manifest.evidenceRecoveryGranted !== false
    || manifest.collectionAdmissionGranted !== false) fail("ORIGINAL_CUSTODY_SCOPE_INVALID");
  validateSources(manifest.sources);
  const membership = ["manifest.json", "seal.json", ...manifest.sources.map(source => source.name)].sort();
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(membership)) fail("ORIGINAL_CUSTODY_MEMBERSHIP_INVALID");
  for (const source of manifest.sources) {
    const result = streamFile(inspectFile(path.join(directory, source.name), source));
    if (result.sha256 !== source.sha256) fail("ORIGINAL_CUSTODY_COPY_HASH");
  }
  checkDirectories(ancestors);
  syncDirectory(path.dirname(directory));
  return { directory, seal, manifest, verified: true };
}

module.exports = { VERSION, MAX_BYTES, MAX_FILES, createOriginalEvidenceCustody, verifyOriginalEvidenceCustody };
