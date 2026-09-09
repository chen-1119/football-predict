"use strict";
// Cross-UID trust comes from a root-owned key + create-only signed records,
// never from accepting a build/service user's self-reported cache file.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const { collectInputs, success, hashValue, MAX_AGE_MS } = require("./staticVerificationReceipts.cjs");
const VERSION = "root-static-verification-attestation-v1";
const MAX_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const DIRECTORY = /^football-release-static\.[A-Za-z0-9]{6}$/;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const serialize = value => JSON.stringify(value);
let runtimeCache = null;

function protectedRootPath(filename, { directory = false } = {}) {
  if (process.platform !== "linux" || !path.isAbsolute(filename)) throw new Error("root-path-platform");
  const resolved = fs.realpathSync(filename);
  if (resolved !== path.resolve(filename)) throw new Error("root-path-link");
  let cursor = resolved, first = true;
  for (;;) {
    const stat = fs.lstatSync(cursor);
    if (stat.uid !== 0 || stat.isSymbolicLink() || (stat.mode & 0o022)
      || (!first || directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("root-path-permissions");
    if (cursor === path.parse(cursor).root) break;
    cursor = path.dirname(cursor); first = false;
  }
  return resolved;
}

function readRootFile(directory, name, limit = MAX_BYTES) {
  if (!/^(?:release\.json|public-key\.pem|[a-f0-9]{64}\.json)$/.test(name)) throw new Error("root-record-name");
  protectedRootPath(directory, { directory: true });
  const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1
      || (before.mode & 0o777) !== 0o644 || before.size < 1 || before.size > limit) throw new Error("root-record-permissions");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(path.join(directory, name));
    if (bytes.length !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error("root-record-drift");
    return bytes;
  } finally { fs.closeSync(fd); }
}

function directoryAllowed(directory) {
  if (path.dirname(directory) !== "/run" || !DIRECTORY.test(path.basename(directory))) throw new Error("root-store-location");
  protectedRootPath(directory, { directory: true });
  const stat = fs.lstatSync(directory);
  if ((stat.mode & 0o777) !== 0o755) throw new Error("root-store-mode");
  return directory;
}

function controlledEnvironment() {
  return { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    TZ: "UTC", NODE_OPTIONS: "--max-old-space-size=1536" };
}

function parentRuntimeAllowed(env) {
  // Resource-only options do not inject code. The audited fixture itself is
  // attested under controlledEnvironment; unsafe parent injection never reuses.
  return !env.NODE_PATH && process.execArgv.length === 0
    && (!env.NODE_OPTIONS || /^--max-old-space-size=(?:[1-9]\d{2,4})$/.test(env.NODE_OPTIONS));
}

function runtimeIdentity() {
  const executable = protectedRootPath(process.execPath), stat = fs.statSync(executable, { bigint: true });
  const stamp = [executable, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid].map(String).join(":");
  // Amortize the large Node binary hash only while its root-protected inode,
  // full size and nanosecond modification/change identity remain unchanged.
  if (runtimeCache?.stamp !== stamp) runtimeCache = { stamp, hash: digest(fs.readFileSync(executable)) };
  return { node: { ...process.versions }, platform: process.platform, arch: process.arch,
    osRelease: os.release(), nodeBinarySha256: runtimeCache.hash, environment: controlledEnvironment() };
}

function buildIdentity(rootDir, args, releaseSha, env) {
  if (!HASH.test(releaseSha || "")) return null;
  const inputs = collectInputs(rootDir, args, env);
  if (!inputs) return null;
  return { version: VERSION, releaseSha, inputs, runtime: runtimeIdentity(),
    attestorPolicySha256: digest(fs.readFileSync(__filename)),
    cachePolicySha256: digest(fs.readFileSync(path.join(__dirname, "rootStaticResultCache.cjs"))),
    issuerPolicySha256: digest(fs.readFileSync(path.join(__dirname, "createRootStaticVerificationAttestations.cjs"))) };
}

function sealAttestation({ identity, result, privateKey, checkedAt, elapsedMs }) {
  if (!success(result, identity?.inputs) || !Number.isSafeInteger(checkedAt)
    || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("root-attestation-not-success");
  const payload = { version: VERSION, identity, checkedAt, elapsedMs,
    result: { status: 0, body: result.body, stdout: result.stdout, stderr: "", timedOut: false } };
  return { payload, signature: crypto.sign(null, Buffer.from(serialize(payload)), privateKey).toString("base64") };
}

function openAttestation(record, { identity, publicKey, now = Date.now() }) {
  try {
    const p = record?.payload;
    if (p?.version !== VERSION || hashValue(p.identity) !== hashValue(identity)
      || !Number.isSafeInteger(p.checkedAt) || p.checkedAt > now || now - p.checkedAt > MAX_AGE_MS
      || !Number.isFinite(p.elapsedMs) || p.elapsedMs < 0 || !success(p.result, identity.inputs)
      || !/^[A-Za-z0-9+/]{86}==$/.test(record.signature)) return null;
    const key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519"
      || !crypto.verify(null, Buffer.from(serialize(p)), key, Buffer.from(record.signature, "base64"))) return null;
    return { ...p.result, verificationReceipt: { reused: true, trust: VERSION,
      verifiedAt: p.checkedAt, observedAt: now, originalElapsedMs: p.elapsedMs,
      identityHash: hashValue(identity) } };
  } catch { return null; }
}

function readRootAttestation({ rootDir, args, env, now = Date.now() }) {
  try {
    if (!parentRuntimeAllowed(env) || !env.VERIFY_STATIC_ATTESTATION_DIR) return null;
    const directory = directoryAllowed(env.VERIFY_STATIC_ATTESTATION_DIR);
    const release = JSON.parse(readRootFile(directory, "release.json", 4096));
    if (release.version !== VERSION || release.releaseSha !== env.VERIFY_STATIC_RELEASE_SHA
      || release.completed !== true || !Number.isSafeInteger(release.createdAt)
      || release.createdAt > now || now - release.createdAt > MAX_AGE_MS) return null;
    const identity = buildIdentity(rootDir, args, env.VERIFY_STATIC_RELEASE_SHA, env);
    if (!identity) return null;
    const record = JSON.parse(readRootFile(directory, `${hashValue(identity)}.json`));
    const publicKey = readRootFile(directory, "public-key.pem", 4096);
    if (digest(publicKey) !== release.publicKeySha256) return null;
    const opened = openAttestation(record, { identity, publicKey, now });
    if (!opened || hashValue(buildIdentity(rootDir, args, env.VERIFY_STATIC_RELEASE_SHA, env)) !== hashValue(identity)) return null;
    return opened;
  } catch { return null; }
}

function createRootStore({ releaseSha }) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !HASH.test(releaseSha || "")) throw new Error("root-producer-required");
  protectedRootPath("/run", { directory: true });
  const directory = fs.mkdtempSync("/run/football-release-static.");
  fs.chmodSync(directory, 0o755); directoryAllowed(directory);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicBytes = Buffer.from(publicKey.export({ type: "spki", format: "pem" }));
  const createdAt = Date.now();
  const write = (name, bytes) => {
    directoryAllowed(directory);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("root-record-size");
    const fd = fs.openSync(path.join(directory, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try { fs.fchmodSync(fd, 0o644); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  write("public-key.pem", publicBytes);
  const identities = [];
  return { directory,
    add({ identity, result, checkedAt, elapsedMs }) {
      if (identity.releaseSha !== releaseSha) throw new Error("root-release-mismatch");
      const record = sealAttestation({ identity, result, privateKey, checkedAt, elapsedMs });
      const hash = hashValue(identity); write(`${hash}.json`, serialize(record)); identities.push(hash);
    },
    complete() {
      if (!identities.length) throw new Error("root-empty-batch");
      write("release.json", serialize({ version: VERSION, releaseSha, createdAt, completed: true,
        publicKeySha256: digest(publicBytes), identities }));
      return { directory, identities: [...identities] };
    },
  };
}

function removeRootStore({ directory, device, inode, releaseSha }) {
  if (process.getuid?.() !== 0 || !HASH.test(releaseSha || "")) throw new Error("root-cleanup-required");
  directoryAllowed(directory);
  const stat = fs.lstatSync(directory, { bigint: true });
  if (String(stat.dev) !== String(device) || String(stat.ino) !== String(inode)) throw new Error("root-store-identity-changed");
  const names = fs.readdirSync(directory);
  if (names.length > 8) throw new Error("root-store-unexpected-members");
  for (const name of names) readRootFile(directory, name);
  if (names.includes("release.json")) {
    const release = JSON.parse(readRootFile(directory, "release.json"));
    if (release.releaseSha !== releaseSha) throw new Error("root-cleanup-release-mismatch");
  }
  // No recursive removal and no glob: only this invocation's validated records.
  for (const name of names) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
  return { removed: true, directory };
}

module.exports = { VERSION, MAX_BYTES, protectedRootPath, readRootFile, directoryAllowed,
  controlledEnvironment, parentRuntimeAllowed, runtimeIdentity, buildIdentity,
  sealAttestation, openAttestation, readRootAttestation, createRootStore, removeRootStore };
