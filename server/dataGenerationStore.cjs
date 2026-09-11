"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STORE_SCHEMA_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const GENERATION_ID_PATTERN = /^g-[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class DataGenerationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DataGenerationError";
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new DataGenerationError(code, message, details);
};

const canonicalize = (value, location = "value") => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_CANONICAL_VALUE", `${location} must be finite`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalize(entry, `${location}[${index}]`));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail("INVALID_CANONICAL_VALUE", `${location}.${key} is undefined`);
      result[key] = canonicalize(value[key], `${location}.${key}`);
    }
    return result;
  }
  fail("INVALID_CANONICAL_VALUE", `${location} is not JSON-canonicalizable`);
};

const stableStringify = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const storePaths = (storeDir) => {
  if (!storeDir || typeof storeDir !== "string") fail("INVALID_ARGUMENT", "storeDir is required");
  const root = path.join(path.resolve(storeDir), "data-generations");
  return Object.freeze({
    root,
    stagingDir: path.join(root, ".staging"),
    generationsDir: path.join(root, "generations"),
    currentPointer: path.join(root, "current.json"),
    previousPointer: path.join(root, "previous.json"),
    pointerLockDir: path.join(root, ".pointer-commit.lock"),
  });
};

const normalizeRelativePath = (input) => {
  if (typeof input !== "string" || !input.trim()) fail("UNSAFE_PATH", "generation file path is empty");
  if (input.includes("\0") || /^[a-zA-Z]:/.test(input) || input.startsWith("/") || input.startsWith("\\")) {
    fail("UNSAFE_PATH", `generation file path is not relative: ${input}`);
  }
  const slashPath = input.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.endsWith("/")) {
    fail("UNSAFE_PATH", `generation file path escapes its generation: ${input}`);
  }
  if (normalized === MANIFEST_FILE) fail("RESERVED_PATH", `${MANIFEST_FILE} is reserved`);
  return normalized;
};

const fsyncFileRplus = (filePath) => {
  // Windows rejects fsync on some read-only handles. Reopen with r+ after the
  // complete write so the durability step has identical semantics on NTFS.
  const descriptor = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const fsyncDirectoryBestEffort = (directory) => {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // The file fsync and same-directory rename are the portable guarantee.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const writeAndSync = (filePath, bytes) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  fsyncFileRplus(filePath);
};

const sha256File = (filePath) => {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
};

const atomicWriteBytes = ({ targetPath, bytes, beforeRename, renameFault }) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    writeAndSync(temporaryPath, bytes);
    if (beforeRename) beforeRename({ targetPath, temporaryPath });
    if (renameFault) renameFault({ targetPath, temporaryPath });
    fs.renameSync(temporaryPath, targetPath);
    fsyncDirectoryBestEffort(path.dirname(targetPath));
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort temp cleanup */ }
  }
};

const pointerBytes = (pointer) => Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8");
const manifestBytes = (manifest) => Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const normalizeRows = (rows, relativePath) => {
  if (!Number.isSafeInteger(rows) || rows < 0) {
    fail("INVALID_ROWS", `rows must be a non-negative safe integer for ${relativePath}`);
  }
  return rows;
};

const descriptorBytes = (descriptor, relativePath) => {
  const value = descriptor && typeof descriptor === "object" && !Buffer.isBuffer(descriptor)
    && !(descriptor instanceof Uint8Array)
    && (Object.prototype.hasOwnProperty.call(descriptor, "bytes")
      || Object.prototype.hasOwnProperty.call(descriptor, "content")
      || Object.prototype.hasOwnProperty.call(descriptor, "data"))
    ? (descriptor.bytes ?? descriptor.content ?? descriptor.data)
    : descriptor;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value !== undefined) return Buffer.from(`${stableStringify(value)}\n`, "utf8");
  fail("INVALID_FILE_CONTENT", `file content is missing for ${relativePath}`);
};

const normalizeFiles = (files, coreFiles) => {
  let inputEntries;
  if (Array.isArray(files)) {
    inputEntries = files.map((entry) => {
      if (!entry || typeof entry !== "object") fail("INVALID_ARGUMENT", "file descriptors must be objects");
      return [entry.path, entry];
    });
  } else if (files && typeof files === "object") {
    inputEntries = Object.entries(files);
  } else {
    fail("INVALID_ARGUMENT", "files must be an object or descriptor array");
  }
  if (inputEntries.length === 0) fail("INVALID_ARGUMENT", "at least one generation file is required");

  const normalized = [];
  const caseInsensitivePaths = new Set();
  for (const [inputPath, descriptor] of inputEntries) {
    const relativePath = normalizeRelativePath(inputPath);
    const collisionKey = relativePath.toLocaleLowerCase("en-US");
    if (caseInsensitivePaths.has(collisionKey)) fail("DUPLICATE_PATH", `duplicate generation path: ${relativePath}`);
    caseInsensitivePaths.add(collisionKey);
    const inferredRows = descriptor && typeof descriptor === "object" && !Buffer.isBuffer(descriptor)
      && Object.prototype.hasOwnProperty.call(descriptor, "rows")
      ? descriptor.rows
      : (Array.isArray(descriptor?.data) ? descriptor.data.length : undefined);
    const rows = normalizeRows(inferredRows, relativePath);
    const hasSourcePath = descriptor && typeof descriptor === "object" && !Buffer.isBuffer(descriptor)
      && Object.prototype.hasOwnProperty.call(descriptor, "sourcePath");
    if (hasSourcePath) {
      if (typeof descriptor.sourcePath !== "string" || !descriptor.sourcePath.trim()) {
        fail("INVALID_FILE_SOURCE", `sourcePath is invalid for ${relativePath}`);
      }
      const sourcePath = path.resolve(descriptor.sourcePath);
      const stat = assertPlainFile(sourcePath, relativePath);
      const expectedSha256 = descriptor.expectedSha256 === undefined
        ? null
        : String(descriptor.expectedSha256 || "").trim();
      const expectedBytes = descriptor.expectedBytes === undefined
        ? null
        : Number(descriptor.expectedBytes);
      if (expectedSha256 !== null && !HASH_PATTERN.test(expectedSha256)) {
        fail("INVALID_FILE_SOURCE", `expectedSha256 is invalid for ${relativePath}`);
      }
      if (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
        fail("INVALID_FILE_SOURCE", `expectedBytes is invalid for ${relativePath}`);
      }
      if (expectedBytes !== null && stat.size !== expectedBytes) {
        fail("SOURCE_FILE_CHANGED", `source file size changed before staging: ${relativePath}`, {
          relativePath,
          expected: expectedBytes,
          actual: stat.size,
        });
      }
      normalized.push({
        relativePath,
        sourcePath,
        expectedSha256,
        expectedBytes,
        rows,
      });
      continue;
    }
    const bytes = descriptorBytes(descriptor, relativePath);
    normalized.push({ relativePath, bytes, rows });
  }
  normalized.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  const requestedCore = coreFiles === undefined
    ? normalized.map((entry) => entry.relativePath)
    : coreFiles.map(normalizeRelativePath);
  if (!Array.isArray(requestedCore) || requestedCore.length === 0) {
    fail("INVALID_ARGUMENT", "coreFiles must contain at least one path");
  }
  const normalizedCore = [...new Set(requestedCore)].sort((left, right) => left.localeCompare(right, "en"));
  const available = new Set(normalized.map((entry) => entry.relativePath));
  for (const coreFile of normalizedCore) {
    if (!available.has(coreFile)) fail("MISSING_CORE_FILE", `core file is absent: ${coreFile}`);
  }
  return { files: normalized, coreFiles: normalizedCore };
};

const manifestProjection = (manifest) => ({
  schemaVersion: manifest?.schemaVersion,
  sourceCycleId: manifest?.sourceCycleId,
  coreFiles: manifest?.coreFiles,
  files: manifest?.files,
});

const generationIdForManifestHash = (manifestHash) => `g-${manifestHash}`;

const buildManifest = ({ sourceCycleId, files, coreFiles }) => {
  const projection = {
    schemaVersion: STORE_SCHEMA_VERSION,
    sourceCycleId,
    coreFiles,
    files: files.map((entry) => ({
      path: entry.relativePath,
      sha256: entry.sha256 || sha256(entry.bytes),
      bytes: Number.isSafeInteger(entry.byteLength) ? entry.byteLength : entry.bytes.length,
      rows: entry.rows,
      core: coreFiles.includes(entry.relativePath),
    })),
  };
  const manifestHash = sha256(stableStringify(projection));
  return Object.freeze({
    ...projection,
    generationId: generationIdForManifestHash(manifestHash),
    manifestHash,
  });
};

const parseJsonFile = (filePath, missingCode, invalidCode) => {
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail(missingCode, `missing file: ${filePath}`, { filePath });
    throw error;
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(invalidCode, `invalid JSON: ${filePath}`, { filePath, cause: error.message });
  }
};

const validatePointerShape = (pointer, pointerPath) => {
  if (!pointer || typeof pointer !== "object"
      || pointer.schemaVersion !== STORE_SCHEMA_VERSION
      || !GENERATION_ID_PATTERN.test(String(pointer.generationId || ""))
      || !HASH_PATTERN.test(String(pointer.manifestHash || ""))
      || typeof pointer.sourceCycleId !== "string" || !pointer.sourceCycleId.trim()
      || !Number.isFinite(Date.parse(String(pointer.committedAt || "")))) {
    fail("POINTER_INVALID", `invalid generation pointer: ${pointerPath}`, { pointerPath });
  }
  return pointer;
};

const readPointer = (pointerPath, { optional = false } = {}) => {
  try {
    return validatePointerShape(
      parseJsonFile(pointerPath, "POINTER_NOT_FOUND", "POINTER_INVALID"),
      pointerPath,
    );
  } catch (error) {
    if (optional && error instanceof DataGenerationError && error.code === "POINTER_NOT_FOUND") return null;
    throw error;
  }
};

const assertPlainFile = (filePath, relativePath) => {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail("FILE_MISSING", `generation file is missing: ${relativePath}`, { relativePath });
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("FILE_NOT_REGULAR", `generation entry is not a regular file: ${relativePath}`, { relativePath });
  }
  return stat;
};

const validateGenerationDirectory = ({
  generationDir,
  expectedGenerationId,
  expectedManifestHash,
  expectedSourceCycleId,
  requireDirectoryName = true,
}) => {
  const resolvedDir = path.resolve(generationDir);
  const manifest = parseJsonFile(
    path.join(resolvedDir, MANIFEST_FILE),
    "MANIFEST_MISSING",
    "MANIFEST_INVALID",
  );
  if (manifest?.schemaVersion !== STORE_SCHEMA_VERSION
      || !Array.isArray(manifest.coreFiles) || manifest.coreFiles.length === 0
      || !Array.isArray(manifest.files) || manifest.files.length === 0
      || !HASH_PATTERN.test(String(manifest.manifestHash || ""))
      || !GENERATION_ID_PATTERN.test(String(manifest.generationId || ""))) {
    fail("MANIFEST_INVALID", `invalid manifest structure: ${resolvedDir}`);
  }
  const computedHash = sha256(stableStringify(manifestProjection(manifest)));
  if (computedHash !== manifest.manifestHash) {
    fail("MANIFEST_HASH_MISMATCH", "manifest content does not match manifestHash", {
      expected: manifest.manifestHash,
      actual: computedHash,
    });
  }
  if (generationIdForManifestHash(computedHash) !== manifest.generationId) {
    fail("GENERATION_ID_MISMATCH", "generationId is not derived from its manifest");
  }
  if (requireDirectoryName && path.basename(resolvedDir) !== manifest.generationId) {
    fail("GENERATION_ID_MISMATCH", "generation directory name does not match its manifest");
  }
  if (expectedGenerationId && manifest.generationId !== expectedGenerationId) {
    fail("GENERATION_ID_MISMATCH", "generation does not match its pointer", {
      expected: expectedGenerationId,
      actual: manifest.generationId,
    });
  }
  if (expectedManifestHash && manifest.manifestHash !== expectedManifestHash) {
    fail("MANIFEST_HASH_MISMATCH", "manifest does not match its pointer", {
      expected: expectedManifestHash,
      actual: manifest.manifestHash,
    });
  }
  if (expectedSourceCycleId && manifest.sourceCycleId !== expectedSourceCycleId) {
    fail("SOURCE_CYCLE_MISMATCH", "manifest sourceCycleId does not match its pointer", {
      expected: expectedSourceCycleId,
      actual: manifest.sourceCycleId,
    });
  }

  const seen = new Set();
  const files = [];
  for (const entry of manifest.files) {
    const relativePath = normalizeRelativePath(entry?.path);
    const collisionKey = relativePath.toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) fail("MANIFEST_INVALID", `duplicate manifest path: ${relativePath}`);
    seen.add(collisionKey);
    if (!HASH_PATTERN.test(String(entry?.sha256 || ""))
        || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0
        || !Number.isSafeInteger(entry?.rows) || entry.rows < 0
        || typeof entry?.core !== "boolean") {
      fail("MANIFEST_INVALID", `invalid manifest file metadata: ${relativePath}`);
    }
    const absolutePath = path.join(resolvedDir, ...relativePath.split("/"));
    const stat = assertPlainFile(absolutePath, relativePath);
    if (stat.size !== entry.bytes) {
      fail("FILE_SIZE_MISMATCH", `generation file size mismatch: ${relativePath}`, {
        relativePath,
        expected: entry.bytes,
        actual: stat.size,
      });
    }
    const actualHash = sha256File(absolutePath);
    if (actualHash !== entry.sha256) {
      fail("FILE_HASH_MISMATCH", `generation file hash mismatch: ${relativePath}`, {
        relativePath,
        expected: entry.sha256,
        actual: actualHash,
      });
    }
    files.push(Object.freeze({ ...entry, path: relativePath }));
  }
  const manifestPaths = new Set(files.map((entry) => entry.path));
  const normalizedCore = manifest.coreFiles.map(normalizeRelativePath);
  if (new Set(normalizedCore).size !== normalizedCore.length) fail("MANIFEST_INVALID", "duplicate core file path");
  for (const coreFile of normalizedCore) {
    if (!manifestPaths.has(coreFile)) fail("MISSING_CORE_FILE", `manifest core file is absent: ${coreFile}`);
    const entry = files.find((item) => item.path === coreFile);
    if (!entry.core) fail("MANIFEST_INVALID", `core flag is false for ${coreFile}`);
  }
  for (const entry of files) {
    if (entry.core !== normalizedCore.includes(entry.path)) {
      fail("MANIFEST_INVALID", `core file list disagrees with metadata for ${entry.path}`);
    }
  }
  return Object.freeze({
    generationDir: resolvedDir,
    generationId: manifest.generationId,
    sourceCycleId: manifest.sourceCycleId,
    manifestHash: manifest.manifestHash,
    manifest: Object.freeze({ ...manifest, coreFiles: Object.freeze([...normalizedCore]), files: Object.freeze(files) }),
  });
};

const resolvePointer = ({ paths, pointer, pointerPath }) => {
  const context = validateGenerationDirectory({
    generationDir: path.join(paths.generationsDir, pointer.generationId),
    expectedGenerationId: pointer.generationId,
    expectedManifestHash: pointer.manifestHash,
    expectedSourceCycleId: pointer.sourceCycleId,
  });
  return Object.freeze({
    ...context,
    pointer: Object.freeze({ ...pointer }),
    pointerPath,
  });
};

const resolveCurrentGeneration = ({ storeDir }) => {
  const paths = storePaths(storeDir);
  return resolvePointer({
    paths,
    pointer: readPointer(paths.currentPointer),
    pointerPath: paths.currentPointer,
  });
};

const resolvePreviousGeneration = ({ storeDir }) => {
  const paths = storePaths(storeDir);
  return resolvePointer({
    paths,
    pointer: readPointer(paths.previousPointer),
    pointerPath: paths.previousPointer,
  });
};

const resolveGeneration = ({ storeDir, generationId, manifestHash, sourceCycleId }) => {
  if (!GENERATION_ID_PATTERN.test(String(generationId || ""))) {
    fail("INVALID_GENERATION_ID", "generationId is invalid");
  }
  const paths = storePaths(storeDir);
  return validateGenerationDirectory({
    generationDir: path.join(paths.generationsDir, generationId),
    expectedGenerationId: generationId,
    expectedManifestHash: manifestHash,
    expectedSourceCycleId: sourceCycleId,
  });
};

const readGenerationFile = (context, inputPath, { encoding = null, parseJson = false } = {}) => {
  if (!context || typeof context !== "object" || !context.generationDir || !context.manifest) {
    fail("INVALID_CONTEXT", "a resolved generation context is required");
  }
  const relativePath = normalizeRelativePath(inputPath);
  const entry = context.manifest.files.find((item) => item.path === relativePath);
  if (!entry) fail("FILE_NOT_IN_MANIFEST", `file is not part of generation: ${relativePath}`);
  const absolutePath = path.join(context.generationDir, ...relativePath.split("/"));
  const stat = assertPlainFile(absolutePath, relativePath);
  if (stat.size !== entry.bytes) fail("FILE_SIZE_MISMATCH", `generation file size mismatch: ${relativePath}`);
  // Preserve the native parser's small-file latency on request/cache paths.
  // Large projections never enter the file-sized Buffer/string branch below.
  if (parseJson && stat.size >= 32 * 1024 * 1024) {
    try {
      return require("./chunkedJsonFile.cjs").readChunkedJsonFile(absolutePath, {
        expectedBytes: entry.bytes, expectedSha256: entry.sha256,
      }).value;
    } catch (error) {
      fail(error.code || "FILE_READ_FAILED", `${relativePath}: ${error.message}`);
    }
  }
  const bytes = fs.readFileSync(absolutePath);
  const actualHash = sha256(bytes);
  if (actualHash !== entry.sha256) fail("FILE_HASH_MISMATCH", `generation file hash mismatch: ${relativePath}`);
  if (parseJson) {
    try { return JSON.parse(bytes.toString("utf8")); } catch { fail("FILE_JSON_INVALID", `invalid JSON: ${relativePath}`); }
  }
  return encoding ? bytes.toString(encoding) : bytes;
};

const readGenerationSelectedObject = (context, inputPath, { keys, ...limits } = {}) => {
  if (!context || typeof context !== "object" || !context.generationDir || !context.manifest) {
    fail("INVALID_CONTEXT", "a resolved generation context is required");
  }
  const relativePath = normalizeRelativePath(inputPath);
  const entry = context.manifest.files.find(item => item.path === relativePath);
  if (!entry) fail("FILE_NOT_IN_MANIFEST", `file is not part of generation: ${relativePath}`);
  const absolutePath = path.join(context.generationDir, ...relativePath.split("/"));
  assertPlainFile(absolutePath, relativePath);
  try {
    return require("./selectedJsonObjectFile.cjs").readSelectedJsonObjectFile({
      ...limits, filePath: absolutePath, expectedBytes: entry.bytes, expectedSha256: entry.sha256, keys,
    });
  } catch (error) {
    if (error?.code) fail(error.code, `${relativePath}: ${error.message}`);
    throw error;
  }
};

const invokeFault = (faultInjector, point, details = {}) => {
  if (!faultInjector) return;
  let shouldFail = false;
  if (typeof faultInjector === "function") {
    shouldFail = faultInjector(point, Object.freeze({ ...details })) === true;
  } else if (typeof faultInjector === "string") {
    shouldFail = faultInjector === point;
  } else if (Array.isArray(faultInjector)) {
    shouldFail = faultInjector.includes(point);
  } else {
    fail("INVALID_ARGUMENT", "faultInjector must be a function, string, or array");
  }
  if (shouldFail) fail("FAULT_INJECTED", `fault injected at ${point}`, { point, ...details });
};

const atomicWritePointer = ({ targetPath, pointer, faultInjector, injectCurrentPointerFaults = false }) => {
  atomicWriteBytes({
    targetPath,
    bytes: pointerBytes(pointer),
    beforeRename: injectCurrentPointerFaults
      ? (details) => invokeFault(faultInjector, "before-pointer-rename", details)
      : null,
    renameFault: injectCurrentPointerFaults
      ? (details) => invokeFault(faultInjector, "pointer-rename", details)
      : null,
  });
};

const sleepSync = (milliseconds) => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.max(1, milliseconds));
};

const readLockOwner = (lockDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
};

const POINTER_LOCK_OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const lstatOrNull = (targetPath) => {
  try {
    // Use bigint stats so 64-bit Windows file IDs are not rounded through
    // Number and accidentally treated as an exact inode match.
    return fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const sameFilesystemIdentity = (left, right) => Boolean(left && right)
  && typeof left.dev === "bigint"
  && typeof left.ino === "bigint"
  && typeof right.dev === "bigint"
  && typeof right.ino === "bigint"
  && left.dev >= 0n
  && right.dev >= 0n
  && left.ino > 0n
  && right.ino > 0n
  && left.dev === right.dev
  && left.ino === right.ino;

const validPointerLockOwner = (owner) => {
  if (!owner || Object.getPrototypeOf(owner) !== Object.prototype) return false;
  if (Object.keys(owner).sort().join("\0") !== ["acquiredAt", "hostname", "pid", "schemaVersion", "token"].join("\0")) {
    return false;
  }
  const acquiredAt = String(owner.acquiredAt || "");
  let canonicalAcquiredAt;
  try {
    canonicalAcquiredAt = new Date(acquiredAt).toISOString();
  } catch {
    return false;
  }
  return owner.schemaVersion === STORE_SCHEMA_VERSION
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.hostname === "string"
    && owner.hostname.length > 0
    && owner.hostname.length <= 255
    && POINTER_LOCK_OWNER_TOKEN_PATTERN.test(String(owner.token || ""))
    && canonicalAcquiredAt === acquiredAt;
};

const readStrictPointerLockEvidence = ({ lockDir, ownerFileName = "owner.json" }) => {
  if (path.basename(ownerFileName) !== ownerFileName) return null;
  const ownerPath = path.join(lockDir, ownerFileName);
  const lockBefore = lstatOrNull(lockDir);
  const ownerBefore = lstatOrNull(ownerPath);
  if (
    !lockBefore?.isDirectory()
    || lockBefore.isSymbolicLink()
    || !ownerBefore?.isFile()
    || ownerBefore.isSymbolicLink()
    || ownerBefore.nlink !== 1n
    || lockBefore.dev !== ownerBefore.dev
    || ownerBefore.size <= 0n
    || ownerBefore.size > 1024n
  ) return null;
  let entries;
  let bytes;
  try {
    entries = fs.readdirSync(lockDir);
    if (entries.length !== 1 || entries[0] !== ownerFileName) return null;
    bytes = fs.readFileSync(ownerPath);
  } catch {
    return null;
  }
  const lockAfter = lstatOrNull(lockDir);
  const ownerAfter = lstatOrNull(ownerPath);
  if (!sameFilesystemIdentity(lockBefore, lockAfter) || !sameFilesystemIdentity(ownerBefore, ownerAfter)) return null;
  let owner;
  try {
    owner = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!validPointerLockOwner(owner)) return null;
  return Object.freeze({
    lockDir,
    ownerFileName,
    ownerPath,
    lockStat: lockAfter,
    ownerStat: ownerAfter,
    owner,
    ownerSha256: sha256(bytes),
  });
};

const samePointerLockEvidence = (left, right) => Boolean(left && right)
  && sameFilesystemIdentity(left.lockStat, right.lockStat)
  && sameFilesystemIdentity(left.ownerStat, right.ownerStat)
  && left.ownerSha256 === right.ownerSha256
  && left.owner.token === right.owner.token
  && left.owner.pid === right.owner.pid
  && left.owner.hostname === right.owner.hostname;

const invokePointerLockTestHook = (testHook, point, details) => {
  if (testHook === undefined || testHook === null) return;
  if (typeof testHook !== "function") fail("INVALID_ARGUMENT", "pointer lock test hook must be a function");
  testHook(point, Object.freeze({ ...details }));
};

const restoreClaimAtCanonicalPath = ({ lockDir, claimName, claimedEvidence }) => {
  const current = readStrictPointerLockEvidence({ lockDir, ownerFileName: claimName });
  if (!samePointerLockEvidence(current, claimedEvidence) || lstatOrNull(path.join(lockDir, "owner.json"))) return false;
  try {
    fs.renameSync(path.join(lockDir, claimName), path.join(lockDir, "owner.json"));
    return true;
  } catch {
    return false;
  }
};

const restoreClaimUsingInitialIdentity = ({ lockDir, claimName, initialEvidence }) => {
  const claimPath = path.join(lockDir, claimName);
  const lockStat = lstatOrNull(lockDir);
  const claimStat = lstatOrNull(claimPath);
  if (
    !sameFilesystemIdentity(lockStat, initialEvidence?.lockStat)
    || !sameFilesystemIdentity(claimStat, initialEvidence?.ownerStat)
    || lstatOrNull(path.join(lockDir, "owner.json"))
  ) return false;
  try {
    const entries = fs.readdirSync(lockDir);
    if (entries.length !== 1 || entries[0] !== claimName) return false;
    fs.renameSync(claimPath, path.join(lockDir, "owner.json"));
    return true;
  } catch {
    return false;
  }
};

const quarantineExactPointerLock = ({
  lockDir,
  expectedOwner = null,
  requireDead = false,
  testHook = null,
}) => {
  const initial = readStrictPointerLockEvidence({ lockDir });
  if (!initial) {
    return Object.freeze({ status: lstatOrNull(lockDir) ? "unprovable" : "lock-missing" });
  }
  if (expectedOwner && (
    initial.owner.token !== expectedOwner.token
    || initial.owner.pid !== expectedOwner.pid
    || initial.owner.hostname !== expectedOwner.hostname
  )) return Object.freeze({ status: "not-owner" });
  if (requireDead && (initial.owner.hostname !== os.hostname() || localProcessAlive(initial.owner) !== false)) {
    return Object.freeze({ status: "owner-not-dead" });
  }

  invokePointerLockTestHook(testHook, "before-owner-claim", {
    lockDir,
    owner: initial.owner,
    lockDev: initial.lockStat.dev,
    lockIno: initial.lockStat.ino,
    ownerDev: initial.ownerStat.dev,
    ownerIno: initial.ownerStat.ino,
  });
  const claimName = `.owner.pointer-claim.${process.pid}.${crypto.randomUUID()}.json`;
  const claimPath = path.join(lockDir, claimName);
  try {
    fs.renameSync(initial.ownerPath, claimPath);
  } catch {
    return Object.freeze({ status: "claim-raced" });
  }
  const claimed = readStrictPointerLockEvidence({ lockDir, ownerFileName: claimName });
  if (!claimed) {
    const restored = restoreClaimUsingInitialIdentity({ lockDir, claimName, initialEvidence: initial });
    return Object.freeze({ status: restored ? "claim-unprovable-restored" : "claim-unprovable-unrestored" });
  }
  if (!samePointerLockEvidence(claimed, initial)) {
    const restored = restoreClaimAtCanonicalPath({ lockDir, claimName, claimedEvidence: claimed });
    const differentOwner = claimed.owner.token !== initial.owner.token
      || claimed.owner.pid !== initial.owner.pid
      || claimed.owner.hostname !== initial.owner.hostname;
    return Object.freeze({
      status: restored && differentOwner
        ? "successor-restored"
        : restored ? "claim-drift-restored" : "claim-drift-unrestored",
    });
  }
  if (requireDead && localProcessAlive(claimed.owner) !== false) {
    const restored = restoreClaimAtCanonicalPath({ lockDir, claimName, claimedEvidence: claimed });
    return Object.freeze({ status: restored ? "owner-revived" : "owner-revived-unrestored" });
  }

  const parentDir = path.dirname(lockDir);
  const quarantinePath = path.join(parentDir, `${path.basename(lockDir)}.quarantine.${process.pid}.${crypto.randomUUID()}`);
  invokePointerLockTestHook(testHook, "before-lock-quarantine", { lockDir, quarantinePath, owner: claimed.owner });
  try {
    if (lstatOrNull(quarantinePath)) {
      const restored = restoreClaimAtCanonicalPath({ lockDir, claimName, claimedEvidence: claimed });
      return Object.freeze({ status: restored ? "quarantine-collision" : "quarantine-collision-unrestored" });
    }
    fs.renameSync(lockDir, quarantinePath);
  } catch {
    const restored = restoreClaimAtCanonicalPath({ lockDir, claimName, claimedEvidence: claimed });
    return Object.freeze({ status: restored ? "quarantine-failed" : "quarantine-failed-unrestored" });
  }

  const quarantined = readStrictPointerLockEvidence({ lockDir: quarantinePath, ownerFileName: claimName });
  if (!samePointerLockEvidence(quarantined, initial)) {
    return Object.freeze({ status: "quarantine-drift", quarantinePath });
  }
  if (requireDead && localProcessAlive(quarantined.owner) !== false) {
    return Object.freeze({ status: "quarantined-owner-revived", quarantinePath });
  }
  try {
    fs.unlinkSync(quarantined.ownerPath);
    fs.rmdirSync(quarantinePath);
    fsyncDirectoryBestEffort(parentDir);
  } catch {
    return Object.freeze({ status: "quarantine-cleanup-failed", quarantinePath });
  }
  return Object.freeze({ status: "quarantined" });
};

const lockAgeMs = (lockDir, owner) => {
  const acquiredAt = Date.parse(String(owner?.acquiredAt || ""));
  if (Number.isFinite(acquiredAt)) return Math.max(0, Date.now() - acquiredAt);
  try { return Math.max(0, Date.now() - fs.statSync(lockDir).mtimeMs); } catch { return 0; }
};

const localProcessAlive = (owner) => {
  if (!owner || owner.hostname !== os.hostname()) return null;
  const pid = Number(owner.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const inspectPointerCommitLockActivity = ({
  lockDir,
  staleMs = 60_000,
  metadataGraceMs = 1_000,
  nowMs = Date.now(),
  readOwner = readLockOwner,
  processAlive = localProcessAlive,
} = {}) => {
  const resolvedLockDir = path.resolve(lockDir || "");
  let stat;
  try {
    stat = fs.statSync(resolvedLockDir);
  } catch {
    return { active: false, reason: "lock-missing", lockDir: resolvedLockDir, ageMs: null };
  }
  if (!stat.isDirectory()) {
    return { active: false, reason: "lock-not-directory", lockDir: resolvedLockDir, ageMs: null };
  }
  const owner = readOwner(resolvedLockDir);
  const acquiredAtMs = Date.parse(String(owner?.acquiredAt || ""));
  const ageMs = Math.max(0, nowMs - (Number.isFinite(acquiredAtMs) ? acquiredAtMs : stat.mtimeMs));
  const safeStaleMs = Math.max(1, Number(staleMs) || 60_000);
  const safeMetadataGraceMs = Math.min(
    safeStaleMs,
    Math.max(1, Number(metadataGraceMs) || 1_000),
  );
  if (ageMs > safeStaleMs) {
    return { active: false, reason: "lock-stale", lockDir: resolvedLockDir, ageMs, owner };
  }
  const pid = Number(owner?.pid);
  if (!owner || !Number.isSafeInteger(pid) || pid <= 0) {
    return {
      active: ageMs <= safeMetadataGraceMs,
      reason: ageMs <= safeMetadataGraceMs ? "metadata-grace" : "metadata-orphan",
      lockDir: resolvedLockDir,
      ageMs,
      owner,
    };
  }
  const alive = processAlive(owner);
  if (alive === false) {
    return { active: false, reason: "owner-dead", lockDir: resolvedLockDir, ageMs, owner };
  }
  return {
    active: true,
    reason: alive === true ? "owner-alive" : "foreign-owner-fresh",
    lockDir: resolvedLockDir,
    ageMs,
    owner,
  };
};

const pointerCommitLockActive = (options = {}) => inspectPointerCommitLockActivity(options).active;

const acquirePointerCommitLock = ({
  lockDir,
  timeoutMs = 10_000,
  staleMs = 60_000,
  pollMs = 20,
  pointerLockTestHook = null,
}) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(staleMs) || staleMs <= 0) {
    fail("INVALID_ARGUMENT", "pointer lock timeout and stale interval are invalid");
  }
  const startedAtMs = Date.now();
  const token = crypto.randomUUID();
  const owner = Object.freeze({
    schemaVersion: STORE_SCHEMA_VERSION,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  });
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      try {
        writeAndSync(path.join(lockDir, "owner.json"), pointerBytes(owner));
      } catch (error) {
        // A partial owner publication is not safe to remove by canonical path:
        // another actor may already have quarantined this inode and installed a
        // successor. Clean up only when the fully written owner still proves
        // this exact token; otherwise fail closed and leave forensic evidence.
        quarantineExactPointerLock({ lockDir, expectedOwner: owner, testHook: pointerLockTestHook });
        throw error;
      }
      let released = false;
      return Object.freeze({
        owner,
        release: () => {
          if (released) return;
          const result = quarantineExactPointerLock({
            lockDir,
            expectedOwner: owner,
            testHook: pointerLockTestHook,
          });
          if (!["quarantined", "not-owner", "successor-restored", "lock-missing"].includes(result.status)) {
            fail("POINTER_LOCK_RELEASE_FAILED", "failed to quarantine owned generation pointer lock", {
              lockDir,
              status: result.status,
            });
          }
          released = true;
        },
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existingOwner = readLockOwner(lockDir);
      const ageMs = lockAgeMs(lockDir, existingOwner);
      const processAlive = validPointerLockOwner(existingOwner) ? localProcessAlive(existingOwner) : null;
      // A same-host PID that is definitively gone cannot still own the lock.
      // Reclaim it only through the exact owner claim + inode quarantine path.
      // Missing, malformed, foreign, or extra metadata is deliberately not
      // reclaimed by age: without an exact owner inode/token there is no safe
      // way to distinguish an abandoned directory from an ABA successor.
      if (processAlive === false) {
        const reclaimed = quarantineExactPointerLock({
          lockDir,
          expectedOwner: existingOwner,
          requireDead: true,
          testHook: pointerLockTestHook,
        });
        if (reclaimed.status === "quarantined") continue;
      }
      if (Date.now() - startedAtMs >= timeoutMs) {
        fail("POINTER_LOCK_TIMEOUT", "timed out waiting for generation pointer writer lock", {
          lockDir,
          timeoutMs,
          ageMs,
          owner: existingOwner,
        });
      }
      sleepSync(Math.min(Math.max(1, pollMs), Math.max(1, timeoutMs)));
    }
  }
};

const samePointer = (left, right) => {
  if (left === null || right === null) return left === right;
  return stableStringify(left) === stableStringify(right);
};

const commitDataGeneration = ({
  storeDir,
  sourceCycleId,
  files,
  coreFiles,
  committedAt = new Date().toISOString(),
  validate,
  faultInjector,
  pointerLockTimeoutMs = 10_000,
  pointerLockStaleMs = 60_000,
  pointerLockHandle = null,
}) => {
  if (typeof sourceCycleId !== "string" || !sourceCycleId.trim()) {
    fail("INVALID_ARGUMENT", "sourceCycleId is required");
  }
  if (!Number.isFinite(Date.parse(String(committedAt)))) fail("INVALID_ARGUMENT", "committedAt must be an ISO date-time");
  if (validate !== undefined && typeof validate !== "function") fail("INVALID_ARGUMENT", "validate must be a function");
  if (pointerLockHandle !== null && typeof pointerLockHandle?.release !== "function") {
    fail("INVALID_ARGUMENT", "pointerLockHandle must be an acquired pointer lock");
  }

  const paths = storePaths(storeDir);
  fs.mkdirSync(paths.stagingDir, { recursive: true });
  fs.mkdirSync(paths.generationsDir, { recursive: true });
  const oldPointer = readPointer(paths.currentPointer, { optional: true });
  const oldContext = oldPointer
    ? resolvePointer({ paths, pointer: oldPointer, pointerPath: paths.currentPointer })
    : null;
  const normalized = normalizeFiles(files, coreFiles);
  const stagingDir = fs.mkdtempSync(path.join(paths.stagingDir, "stage-"));
  let stagingExists = true;
  let generationPublished = false;

  try {
    const stagedFiles = normalized.files.map((entry, fileIndex) => {
      const targetPath = path.join(stagingDir, ...entry.relativePath.split("/"));
      if (entry.sourcePath) {
        const sourceStat = assertPlainFile(entry.sourcePath, entry.relativePath);
        if (entry.expectedBytes !== null && sourceStat.size !== entry.expectedBytes) {
          fail("SOURCE_FILE_CHANGED", `source file size changed during staging: ${entry.relativePath}`, {
            relativePath: entry.relativePath,
            expected: entry.expectedBytes,
            actual: sourceStat.size,
          });
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(entry.sourcePath, targetPath);
        fsyncFileRplus(targetPath);
      } else {
        writeAndSync(targetPath, entry.bytes);
      }
      const targetStat = assertPlainFile(targetPath, entry.relativePath);
      const actualHash = sha256File(targetPath);
      if (entry.expectedSha256 && actualHash !== entry.expectedSha256) {
        fail("SOURCE_FILE_CHANGED", `source file content changed during staging: ${entry.relativePath}`, {
          relativePath: entry.relativePath,
          expected: entry.expectedSha256,
          actual: actualHash,
        });
      }
      invokeFault(faultInjector, "after-file-fsync", {
        relativePath: entry.relativePath,
        fileIndex,
        fileCount: normalized.files.length,
      });
      return Object.freeze({
        relativePath: entry.relativePath,
        sha256: actualHash,
        byteLength: targetStat.size,
        rows: entry.rows,
      });
    });
    const manifest = buildManifest({
      sourceCycleId: sourceCycleId.trim(),
      files: stagedFiles,
      coreFiles: normalized.coreFiles,
    });
    const generationDir = path.join(paths.generationsDir, manifest.generationId);
    writeAndSync(path.join(stagingDir, MANIFEST_FILE), manifestBytes(manifest));
    invokeFault(faultInjector, "after-manifest-fsync", { generationId: manifest.generationId });

    let stagedContext = validateGenerationDirectory({
      generationDir: stagingDir,
      expectedGenerationId: manifest.generationId,
      expectedManifestHash: manifest.manifestHash,
      expectedSourceCycleId: manifest.sourceCycleId,
      requireDirectoryName: false,
    });
    if (validate) {
      const result = validate(stagedContext);
      if (result === false || (result && typeof result === "object" && result.ok === false)) {
        fail("VALIDATION_FAILED", "generation validator rejected staged data", { result });
      }
      // A validator is untrusted application code; re-hash everything after it.
      stagedContext = validateGenerationDirectory({
        generationDir: stagingDir,
        expectedGenerationId: manifest.generationId,
        expectedManifestHash: manifest.manifestHash,
        expectedSourceCycleId: manifest.sourceCycleId,
        requireDirectoryName: false,
      });
    }

    let reusedGeneration = false;
    if (fs.existsSync(generationDir)) {
      try {
        validateGenerationDirectory({
          generationDir,
          expectedGenerationId: manifest.generationId,
          expectedManifestHash: manifest.manifestHash,
          expectedSourceCycleId: manifest.sourceCycleId,
        });
      } catch (error) {
        fail("GENERATION_CONFLICT", `immutable generation already exists with different or invalid content: ${manifest.generationId}`, {
          causeCode: error?.code || null,
        });
      }
      fs.rmSync(stagingDir, { recursive: true, force: true });
      stagingExists = false;
      reusedGeneration = true;
    } else {
      try {
        fs.renameSync(stagingDir, generationDir);
        stagingExists = false;
        generationPublished = true;
      } catch (error) {
        if (!fs.existsSync(generationDir)) throw error;
        try {
          validateGenerationDirectory({
            generationDir,
            expectedGenerationId: manifest.generationId,
            expectedManifestHash: manifest.manifestHash,
            expectedSourceCycleId: manifest.sourceCycleId,
          });
        } catch (validationError) {
          fail("GENERATION_CONFLICT", `generation publish raced with conflicting content: ${manifest.generationId}`, {
            causeCode: validationError?.code || null,
          });
        }
        fs.rmSync(stagingDir, { recursive: true, force: true });
        stagingExists = false;
        reusedGeneration = true;
      }
      fsyncDirectoryBestEffort(paths.generationsDir);
      invokeFault(faultInjector, "after-generation-rename", { generationId: manifest.generationId });
    }

    const context = validateGenerationDirectory({
      generationDir,
      expectedGenerationId: manifest.generationId,
      expectedManifestHash: manifest.manifestHash,
      expectedSourceCycleId: manifest.sourceCycleId,
    });
    const pointer = Object.freeze({
      schemaVersion: STORE_SCHEMA_VERSION,
      generationId: manifest.generationId,
      sourceCycleId: manifest.sourceCycleId,
      manifestHash: manifest.manifestHash,
      committedAt: new Date(committedAt).toISOString(),
    });
    const ownsPointerLock = pointerLockHandle === null;
    const pointerLock = pointerLockHandle || acquirePointerCommitLock({
      lockDir: paths.pointerLockDir,
      timeoutMs: pointerLockTimeoutMs,
      staleMs: pointerLockStaleMs,
    });
    let idempotent = false;
    try {
      const currentInsideLock = readPointer(paths.currentPointer, { optional: true });
      if (!samePointer(currentInsideLock, oldPointer)) {
        fail("POINTER_CHANGED", "generation pointer changed while this writer was staging", {
          expectedGenerationId: oldPointer?.generationId || null,
          actualGenerationId: currentInsideLock?.generationId || null,
        });
      }
      if (currentInsideLock) {
        resolvePointer({ paths, pointer: currentInsideLock, pointerPath: paths.currentPointer });
      }
      idempotent = Boolean(currentInsideLock
        && currentInsideLock.generationId === manifest.generationId
        && currentInsideLock.manifestHash === manifest.manifestHash
        && currentInsideLock.sourceCycleId === manifest.sourceCycleId);
      if (!idempotent) {
        if (oldContext) {
          atomicWritePointer({ targetPath: paths.previousPointer, pointer: oldContext.pointer });
        }
        atomicWritePointer({
          targetPath: paths.currentPointer,
          pointer,
          faultInjector,
          injectCurrentPointerFaults: true,
        });
      }
    } finally {
      if (ownsPointerLock) pointerLock.release();
    }
    if (idempotent) {
      return Object.freeze({
        committed: true,
        idempotent: true,
        reusedGeneration: true,
        pointer: Object.freeze({ ...oldPointer }),
        previousPointer: readPointer(paths.previousPointer, { optional: true }),
        context: Object.freeze({ ...context, pointer: Object.freeze({ ...oldPointer }), pointerPath: paths.currentPointer }),
      });
    }
    return Object.freeze({
      committed: true,
      idempotent: false,
      reusedGeneration,
      generationPublished,
      pointer,
      previousPointer: oldPointer ? Object.freeze({ ...oldPointer }) : null,
      context: Object.freeze({ ...context, pointer, pointerPath: paths.currentPointer }),
    });
  } finally {
    if (stagingExists) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort staging cleanup */ }
    }
  }
};

module.exports = {
  DataGenerationError,
  MANIFEST_FILE,
  STORE_SCHEMA_VERSION,
  inspectPointerCommitLockActivity,
  pointerCommitLockActive,
  buildManifest,
  acquirePointerCommitLock,
  commitDataGeneration,
  generationIdForManifestHash,
  normalizeRelativePath,
  readGenerationFile,
  readGenerationSelectedObject,
  readPointer,
  resolveCurrentGeneration,
  resolveGeneration,
  resolvePreviousGeneration,
  sha256,
  sha256File,
  stableStringify,
  storePaths,
  validateGenerationDirectory,
};
