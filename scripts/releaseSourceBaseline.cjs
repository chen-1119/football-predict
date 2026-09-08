"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { TextDecoder } = require("node:util");
const { validateReleaseManifestV3, verifyManifestBytes, publicKeyId, RELEASE_SIGNATURE_ALGORITHM } = require("./releaseSigning.cjs");
const { validateSignedArchiveSourceEvidence, verifyArchiveSourceEvidence } = require("./releaseArchiveSourceInventory.cjs");
const VERSION = "authenticated-release-source-baseline-v1";
const STORE_ROOT = "/var/lib/football-release/source-baselines", WORK_ROOT = "/var/lib/football-release/work";
const PUBLIC_KEY_PATH = "/etc/football-release/signing-public.pem";
const LIMITS = Object.freeze({ archive: 512 * 1024 * 1024, manifest: 1024 * 1024, signature: 16384, key: 16384, inventory: 1024 * 1024, record: 16384 });
const MINIMUM_FREE_BYTES = 4n * 1024n * 1024n * 1024n;
const FILES = Object.freeze({ archive: "original.tgz", manifest: "manifest.json", signature: "manifest.sig", publicKey: "signing-public.pem",
  inventory: "source-inventory.json", record: "baseline.json", complete: "complete.json" });
const HASH = /^[a-f0-9]{64}$/, TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true }), digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
function reject(code) { const error = new Error(code); error.code = code; throw error; }
function exact(value, keys) { return value && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function within(target, root) { return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep); }
function syncDir(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function policy(options) {
  const ownerUid = options.fixtureOwnerUid ?? 0, boundary = options.fixtureTrustBoundary ? path.resolve(options.fixtureTrustBoundary) : null;
  if (!options.fixtureTrustBoundary && (process.platform !== "linux" || process.getuid() !== 0)) reject("linux-root-baseline-recorder-required");
  if (process.platform !== "win32" && process.getuid() !== ownerUid) reject("baseline-owner-mismatch");
  if (!options.fixtureTrustBoundary) {
    if ((options.storeRoot && path.resolve(options.storeRoot) !== STORE_ROOT)
      || (options.publicKeyPath && path.resolve(options.publicKeyPath) !== PUBLIC_KEY_PATH)) reject("fixed-baseline-trust-path-required");
    if (options.archivePath) {
      const work = path.dirname(path.resolve(options.archivePath));
      if (path.dirname(work) !== WORK_ROOT || !path.basename(work).startsWith(options.sha256 + ".")
        || path.resolve(options.archivePath) !== path.join(work, options.sha256 + ".tgz")
        || path.resolve(options.manifestPath) !== path.join(work, options.sha256 + ".manifest.json")
        || path.resolve(options.signaturePath) !== path.join(work, options.sha256 + ".manifest.sig")) reject("original-root-work-artifacts-required");
    }
  }
  return { ownerUid, boundary };
}
function protectedDirectory(directory, access, { create = false, privateMode = false } = {}) {
  if (!path.isAbsolute(directory) || path.parse(path.resolve(directory)).root === path.resolve(directory)) reject("dedicated-absolute-directory-required");
  const resolved = path.resolve(directory), boundary = access.boundary || path.parse(resolved).root;
  if (!within(resolved, boundary)) reject("outside-trusted-boundary");
  if (create) {
    protectedDirectory(path.dirname(resolved), access);
    try { fs.mkdirSync(resolved, { mode: 0o700 }); syncDir(path.dirname(resolved)); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(cursor) !== cursor
      || (process.platform !== "win32" && (stat.uid !== access.ownerUid || (stat.mode & 0o022) !== 0))) reject("untrusted-baseline-directory");
    if (cursor === resolved && privateMode && process.platform !== "win32" && (stat.mode & 0o077) !== 0) reject("baseline-directory-not-private");
    if (cursor === boundary) break;
    if (path.dirname(cursor) === cursor) reject("unreachable-trust-boundary");
  }
  return resolved;
}
function openProtected(file, limit, access) {
  if (!path.isAbsolute(file)) reject("absolute-file-required");
  protectedDirectory(path.dirname(file), access);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > limit
    || (process.platform !== "win32" && (before.uid !== access.ownerUid || (before.mode & 0o022) !== 0))) reject("unsafe-or-oversized-baseline-file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { if (stamp(fs.fstatSync(fd)) !== stamp(before)) reject("baseline-file-changed-before-open"); }
  catch (error) { fs.closeSync(fd); throw error; }
  return { fd, before, file };
}
function closeUnchanged(handle) {
  try {
    if (stamp(fs.fstatSync(handle.fd)) !== stamp(handle.before) || stamp(fs.lstatSync(handle.file)) !== stamp(handle.before)) reject("baseline-file-changed-during-read");
  } finally { fs.closeSync(handle.fd); }
}
function readProtected(file, limit, access) {
  const handle = openProtected(file, limit, access), buffer = Buffer.alloc(handle.before.size);
  try {
    let offset = 0;
    while (offset < buffer.length) { const bytes = fs.readSync(handle.fd, buffer, offset, buffer.length - offset, offset); if (!bytes) reject("short-baseline-read"); offset += bytes; }
  } finally { closeUnchanged(handle); }
  return buffer;
}
function writePrivate(file, bytes, limit) {
  if (bytes.length <= 0 || bytes.length > limit) reject("baseline-output-limit");
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o400);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { bytes: bytes.length, sha256: digest(bytes) };
}
function publicKey(bytes) {
  const text = utf8.decode(bytes);
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(text)) reject("public-key-only-pem-required");
  const key = crypto.createPublicKey(bytes), bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType !== "rsa" || !Number.isSafeInteger(bits) || bits < 3072 || bits > 8192) reject("unsupported-baseline-rsa-key");
  return { key, keyId: publicKeyId(key), bytes };
}
function authenticate(manifestBytes, signatureBytes, key, expected, { now = Date.now(), enforceFreshness = true } = {}) {
  if (!verifyManifestBytes(manifestBytes, signatureBytes, key.key)) reject("baseline-manifest-signature-invalid");
  const manifest = JSON.parse(utf8.decode(manifestBytes));
  validateReleaseManifestV3(manifest, { now, enforceFreshness });
  if (manifest.ok !== true || manifest.policyVersion !== "release-secret-policy-v2" || manifest.sha256 !== expected.sha256
    || manifest.releaseSequence !== expected.sequence || manifest.site !== expected.site || manifest.channel !== expected.channel
    || manifest.signature?.algorithm !== RELEASE_SIGNATURE_ALGORITHM || manifest.signature.keyId !== key.keyId
    || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > LIMITS.archive
    || ["sensitiveEntries", "blockedEntries", "missingEntries"].some(name => !Array.isArray(manifest[name]) || manifest[name].length !== 0)) reject("baseline-manifest-policy-or-identity-mismatch");
  if ((Object.hasOwn(manifest, "executionMode") && manifest.executionMode !== "full")
    || (Object.hasOwn(manifest, "releaseKind") && manifest.releaseKind !== "full")) reject("full-release-source-required");
  const source = validateSignedArchiveSourceEvidence(manifest);
  return { manifest, source };
}
function expectations(options) {
  const value = { sha256: options.sha256, sequence: options.sequence, site: options.site, channel: options.channel };
  if (!HASH.test(value.sha256) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !TOKEN.test(value.site) || !TOKEN.test(value.channel)) reject("invalid-baseline-expectation");
  return value;
}
function readInputs(options, access) {
  const expected = expectations(options), manifestBytes = readProtected(options.manifestPath, LIMITS.manifest, access);
  const signatureBytes = readProtected(options.signaturePath, LIMITS.signature, access), keyBytes = readProtected(options.publicKeyPath, LIMITS.key, access);
  const key = publicKey(keyBytes), verified = authenticate(manifestBytes, signatureBytes, key, expected);
  return { expected, manifestBytes, signatureBytes, keyBytes, key, ...verified };
}
function summary(record, extra = {}) {
  return { version: VERSION, status: "source-baseline-retained", release: record.release, inventorySha256: record.inventorySha256,
    sourceBaselineReady: true, uiFastPathAllowed: false, frontendBuildBindingAvailable: false, releaseAcceptanceProven: false,
    origin: "signature-authenticated-original-archive", ...extra };
}
async function verifyRetained(options) {
  const access = policy(options), expected = expectations(options), storeRoot = protectedDirectory(options.storeRoot || STORE_ROOT, access, { privateMode: true });
  const directory = protectedDirectory(path.join(storeRoot, expected.sha256), access, { privateMode: true });
  if (process.platform !== "win32" && (fs.statSync(directory).mode & 0o777) !== 0o500) reject("baseline-directory-not-sealed");
  const names = [], entries = fs.opendirSync(directory);
  try { let entry; while ((entry = entries.readSync())) { if (names.length >= 8 || !entry.isFile() || entry.isSymbolicLink()) reject("unexpected-baseline-members"); names.push(entry.name); } }
  finally { entries.closeSync(); }
  if (JSON.stringify(names.sort()) !== JSON.stringify(Object.values(FILES).sort())) reject("incomplete-or-extra-baseline-members");
  if (process.platform !== "win32" && names.some(name => (fs.lstatSync(path.join(directory, name)).mode & 0o777) !== 0o400)) reject("baseline-files-not-sealed");
  const completeBytes = readProtected(path.join(directory, FILES.complete), LIMITS.record, access), complete = JSON.parse(utf8.decode(completeBytes));
  const recordBytes = readProtected(path.join(directory, FILES.record), LIMITS.record, access), record = JSON.parse(utf8.decode(recordBytes));
  if (!exact(complete, ["version", "sha256", "recordSha256", "completedAt"]) || complete.version !== VERSION || complete.sha256 !== expected.sha256
    || complete.recordSha256 !== digest(recordBytes) || !iso(complete.completedAt)
    || !exact(record, ["version", "release", "capturedAt", "inventorySha256", "files", "origin", "frontendBuildBindingAvailable", "uiFastPathAllowed", "releaseAcceptanceProven"])
    || record.version !== VERSION || JSON.stringify(record.release) !== JSON.stringify(expected) || !iso(record.capturedAt)
    || Date.parse(record.capturedAt) > Date.now() + 300000 || Date.parse(complete.completedAt) > Date.now() + 300000 || Date.parse(complete.completedAt) < Date.parse(record.capturedAt)
    || record.origin !== "signature-authenticated-original-archive" || record.frontendBuildBindingAvailable !== false || record.uiFastPathAllowed !== false
    || record.releaseAcceptanceProven !== false || !exact(record.files, ["archive", "manifest", "signature", "publicKey", "inventory"])) reject("baseline-completion-binding-invalid");
  const trustedKey = publicKey(readProtected(options.publicKeyPath, LIMITS.key, access));
  const stored = {};
  for (const name of ["manifest", "signature", "publicKey", "inventory"]) {
    stored[name] = readProtected(path.join(directory, FILES[name]), LIMITS[name === "publicKey" ? "key" : name], access);
    if (!exact(record.files[name], ["bytes", "sha256"]) || record.files[name].sha256 !== digest(stored[name]) || record.files[name].bytes !== stored[name].length) reject("retained-file-digest-mismatch");
  }
  const storedKey = publicKey(stored.publicKey);
  if (storedKey.keyId !== trustedKey.keyId) reject("retained-key-not-externally-trusted");
  const { manifest, source } = authenticate(stored.manifest, stored.signature, trustedKey, expected, { now: Date.parse(record.capturedAt), enforceFreshness: true });
  if (source.status === "legacy-unavailable" || record.inventorySha256 !== source.inventorySha256
    || JSON.stringify(JSON.parse(utf8.decode(stored.inventory))) !== JSON.stringify(manifest.archiveSourceEvidence.inventory)
    || !exact(record.files.archive, ["bytes", "sha256"]) || record.files.archive.sha256 !== expected.sha256 || record.files.archive.bytes !== manifest.bytes) reject("retained-inventory-binding-invalid");
  const archivePath = path.join(directory, FILES.archive), archive = openProtected(archivePath, LIMITS.archive, access);
  closeUnchanged(archive);
  await verifyArchiveSourceEvidence(archivePath, manifest);
  if (digest(readProtected(path.join(directory, FILES.complete), LIMITS.record, access)) !== digest(completeBytes)
    || digest(readProtected(path.join(directory, FILES.record), LIMITS.record, access)) !== digest(recordBytes)
    || digest(readProtected(options.publicKeyPath, LIMITS.key, access)) !== digest(trustedKey.bytes)) reject("baseline-changed-during-verification");
  return { record, directory, ...summary(record, { productionWrites: 0, verification: "signature-and-actual-retained-archive-inventory" }) };
}
async function preserveSourceBaseline(options) {
  const access = policy(options), input = readInputs(options, access);
  if (input.source.status === "legacy-unavailable") return { version: VERSION, status: "legacy-inventory-unavailable",
    release: input.expected, sourceBaselineReady: false, uiFastPathAllowed: false, releaseAcceptanceProven: false, productionWrites: 0 };
  const storeRoot = protectedDirectory(options.storeRoot || STORE_ROOT, access, { create: true, privateMode: true });
  const lock = path.join(storeRoot, "." + input.expected.sha256 + ".capture-lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") reject("baseline-capture-busy-or-interrupted"); throw error; }
  let staging = null;
  try {
    const finalDirectory = path.join(storeRoot, input.expected.sha256);
    let existing = false; try { fs.lstatSync(finalDirectory); existing = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing) {
      const previous = await verifyRetained({ ...options, storeRoot });
      if (previous.record.files.manifest.sha256 !== digest(input.manifestBytes) || previous.record.files.signature.sha256 !== digest(input.signatureBytes)
        || previous.record.files.publicKey.sha256 !== digest(input.keyBytes)) reject("existing-baseline-conflicts-with-original-inputs");
      return summary(previous.record, { reusedExisting: true, productionWrites: 0 });
    }
    // Retention is optional and must not consume the full release's remaining
    // disk space. Preserve a fixed 4 GiB floor in addition to this original
    // archive and bounded metadata; do not purge old baselines to make room.
    const capacity = fs.statfsSync(storeRoot, { bigint: true });
    const requiredBytes = MINIMUM_FREE_BYTES + BigInt(input.manifest.bytes) + 4n * 1024n * 1024n;
    if (capacity.bsize <= 0n || capacity.bavail < 0n || capacity.bavail * capacity.bsize < requiredBytes) reject("baseline-insufficient-free-space");
    staging = fs.mkdtempSync(path.join(storeRoot, "." + input.expected.sha256 + ".staging-")); fs.chmodSync(staging, 0o700); syncDir(storeRoot);
    const files = {
      manifest: writePrivate(path.join(staging, FILES.manifest), input.manifestBytes, LIMITS.manifest),
      signature: writePrivate(path.join(staging, FILES.signature), input.signatureBytes, LIMITS.signature),
      publicKey: writePrivate(path.join(staging, FILES.publicKey), input.keyBytes, LIMITS.key),
    };
    const handle = openProtected(options.archivePath, LIMITS.archive, access), archiveHash = crypto.createHash("sha256");
    let outFd, offset = 0;
    try {
      if (handle.before.size !== input.manifest.bytes) reject("original-archive-size-mismatch");
      outFd = fs.openSync(path.join(staging, FILES.archive), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o400);
      const buffer = Buffer.alloc(65536);
      while (offset < handle.before.size) {
        const count = fs.readSync(handle.fd, buffer, 0, Math.min(buffer.length, handle.before.size - offset), offset);
        if (!count) reject("short-original-archive-copy");
        archiveHash.update(buffer.subarray(0, count)); let written = 0;
        while (written < count) { const n = fs.writeSync(outFd, buffer, written, count - written); if (!n) reject("short-baseline-write"); written += n; }
        offset += count;
      }
      fs.fsyncSync(outFd);
    } finally { if (outFd !== undefined) fs.closeSync(outFd); closeUnchanged(handle); }
    files.archive = { bytes: offset, sha256: archiveHash.digest("hex") };
    if (files.archive.sha256 !== input.expected.sha256) reject("original-archive-sha-mismatch");
    await verifyArchiveSourceEvidence(path.join(staging, FILES.archive), input.manifest);
    files.inventory = writePrivate(path.join(staging, FILES.inventory), Buffer.from(JSON.stringify(input.manifest.archiveSourceEvidence.inventory) + "\n"), LIMITS.inventory);
    const latest = readInputs(options, access);
    if (digest(latest.manifestBytes) !== files.manifest.sha256 || digest(latest.signatureBytes) !== files.signature.sha256 || digest(latest.keyBytes) !== files.publicKey.sha256) reject("authentication-input-changed-during-capture");
    const capturedAt = new Date().toISOString();
    validateReleaseManifestV3(input.manifest, { now: Date.parse(capturedAt), enforceFreshness: true });
    const record = { version: VERSION, release: input.expected, capturedAt, inventorySha256: input.source.inventorySha256,
      files: { archive: files.archive, manifest: files.manifest, signature: files.signature, publicKey: files.publicKey, inventory: files.inventory },
      origin: "signature-authenticated-original-archive", frontendBuildBindingAvailable: false, uiFastPathAllowed: false, releaseAcceptanceProven: false };
    const recordBytes = Buffer.from(JSON.stringify(record) + "\n");
    writePrivate(path.join(staging, FILES.record), recordBytes, LIMITS.record);
    // Complete-last, then directory sync, seal, and atomic publish. Staging is never a readable baseline.
    writePrivate(path.join(staging, FILES.complete), Buffer.from(JSON.stringify({ version: VERSION, sha256: input.expected.sha256,
      recordSha256: digest(recordBytes), completedAt: new Date().toISOString() }) + "\n"), LIMITS.record);
    syncDir(staging); fs.chmodSync(staging, 0o500); syncDir(staging);
    try { fs.lstatSync(finalDirectory); reject("baseline-appeared-during-capture"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.renameSync(staging, finalDirectory); staging = null; syncDir(storeRoot);
    return summary(record, { reusedExisting: false, storedFiles: 7 });
  } finally {
    // Deliberately preserve incomplete staging for inspection. Never purge earlier baselines.
    fs.rmdirSync(lock); syncDir(storeRoot);
  }
}
async function main(argv = process.argv.slice(2)) {
  if (!["preserve", "verify"].includes(argv[0]) || !HASH.test(argv[1]) || !/^[1-9][0-9]*$/.test(argv[2] || "")
    || argv.length !== (argv[0] === "preserve" ? 4 : 3)) reject("usage-release-source-baseline-preserve-sha-sequence-workdir-or-verify-sha-sequence");
  const access = policy({}), config = "/etc/football-release";
  const readLabel = name => {
    const value = utf8.decode(readProtected(path.join(config, name), 128, access)).trim();
    if (!TOKEN.test(value)) reject("invalid-trusted-release-label"); return value;
  };
  const options = { sha256: argv[1], sequence: Number(argv[2]), site: readLabel("expected-site"), channel: readLabel("expected-channel"),
    publicKeyPath: PUBLIC_KEY_PATH, storeRoot: STORE_ROOT };
  if (argv[0] === "preserve") {
    const work = path.resolve(argv[3]);
    if (!path.isAbsolute(argv[3]) || path.dirname(work) !== WORK_ROOT || !path.basename(work).startsWith(options.sha256 + ".")) reject("invalid-original-work-directory");
    protectedDirectory(work, access, { privateMode: true });
    options.archivePath = path.join(work, options.sha256 + ".tgz");
    options.manifestPath = path.join(work, options.sha256 + ".manifest.json");
    options.signaturePath = path.join(work, options.sha256 + ".manifest.sig");
    console.log(JSON.stringify(await preserveSourceBaseline(options)));
  } else {
    const { record, directory, ...report } = await verifyRetained(options); void record; void directory;
    console.log(JSON.stringify(report));
  }
}
module.exports = { VERSION, STORE_ROOT, WORK_ROOT, FILES, LIMITS, preserveSourceBaseline, verifyRetained, main };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ version: VERSION, status: "baseline-unavailable",
  error: typeof error.code === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(error.code) ? error.code : "baseline-verification-failed",
  sourceBaselineReady: false, uiFastPathAllowed: false, releaseAcceptanceProven: false })); process.exitCode = 1; });
