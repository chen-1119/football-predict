const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const rootDir = path.resolve(__dirname, "..");
const RELEASE_MANIFEST_VERSION = 3;
const RELEASE_SIGNATURE_ALGORITHM = "rsa-sha256-pkcs1-v1_5";
const DEFAULT_RELEASE_SITE = "football-predict";
const DEFAULT_RELEASE_CHANNEL = "production";
const DEFAULT_RELEASE_MANIFEST_TTL_HOURS = 48;
const MAX_RELEASE_MANIFEST_TTL_HOURS = 168;
const MAX_RELEASE_CREATED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const RELEASE_SEQUENCE_STATE_VERSION = 1;
const MAX_SAFE_RELEASE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const DEFAULT_RELEASE_SIGNING_PRIVATE_KEY = path.join(
  rootDir,
  ".codex-tmp",
  "football-release-signing-private.pem"
);
const DEFAULT_RELEASE_SIGNING_PUBLIC_KEY = path.join(
  rootDir,
  ".codex-tmp",
  "football-release-signing-public.pem"
);
const DEFAULT_RELEASE_SEQUENCE_STATE_PATH = path.join(
  rootDir,
  ".codex-tmp",
  "football-release-sequence.json"
);

const sleepSync = (milliseconds) => {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, milliseconds);
};

const assertReleaseIdentity = (value, label) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} must match ^[a-z0-9][a-z0-9._-]{0,63}$`);
  }
  return value;
};

const parseStrictPositiveInteger = (value, label) => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive integer without leading zeroes`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} exceeds the supported safe integer range`);
  }
  return parsed;
};

const parseManifestTtlHours = (value) => {
  const raw = value === undefined || value === null || value === ""
    ? String(DEFAULT_RELEASE_MANIFEST_TTL_HOURS)
    : String(value);
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("RELEASE_MANIFEST_TTL_HOURS must be a positive whole number of hours");
  }
  const ttlHours = Number(raw);
  if (!Number.isSafeInteger(ttlHours) || ttlHours > MAX_RELEASE_MANIFEST_TTL_HOURS) {
    throw new Error(`RELEASE_MANIFEST_TTL_HOURS must not exceed ${MAX_RELEASE_MANIFEST_TTL_HOURS}`);
  }
  return ttlHours;
};

const resolveReleaseSequenceStatePath = (env = process.env) => path.resolve(
  env.RELEASE_SEQUENCE_STATE_PATH || DEFAULT_RELEASE_SEQUENCE_STATE_PATH
);

const resolveReleaseManifestConfig = ({ env = process.env, now = new Date() } = {}) => {
  const createdAtDate = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(createdAtDate.getTime())) throw new Error("release manifest creation time is invalid");
  const site = assertReleaseIdentity(
    env.RELEASE_SITE === undefined ? DEFAULT_RELEASE_SITE : env.RELEASE_SITE,
    "RELEASE_SITE"
  );
  const channel = assertReleaseIdentity(
    env.RELEASE_CHANNEL === undefined ? DEFAULT_RELEASE_CHANNEL : env.RELEASE_CHANNEL,
    "RELEASE_CHANNEL"
  );
  const ttlHours = parseManifestTtlHours(env.RELEASE_MANIFEST_TTL_HOURS);
  return {
    site,
    channel,
    ttlHours,
    createdAt: createdAtDate.toISOString(),
    expiresAt: new Date(createdAtDate.getTime() + ttlHours * 60 * 60 * 1000).toISOString()
  };
};

const assertCanonicalIsoDate = (value, label) => {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return parsed.getTime();
};

const validateReleaseManifestV3 = (manifest, { now = Date.now(), enforceFreshness = true } = {}) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("signed release manifest must be a JSON object");
  }
  if (manifest.manifestVersion !== RELEASE_MANIFEST_VERSION) {
    throw new Error(`unsupported signed release manifest version: ${manifest.manifestVersion}`);
  }
  assertReleaseIdentity(manifest.site, "release manifest site");
  assertReleaseIdentity(manifest.channel, "release manifest channel");
  if (typeof manifest.releaseSequence !== "number") {
    throw new Error("release manifest releaseSequence must be a JSON number");
  }
  parseStrictPositiveInteger(manifest.releaseSequence, "release manifest releaseSequence");
  const createdAtMs = assertCanonicalIsoDate(manifest.createdAt, "release manifest createdAt");
  const expiresAtMs = assertCanonicalIsoDate(manifest.expiresAt, "release manifest expiresAt");
  const lifetimeMs = expiresAtMs - createdAtMs;
  if (lifetimeMs <= 0) throw new Error("release manifest expiresAt must be after createdAt");
  if (lifetimeMs > MAX_RELEASE_MANIFEST_TTL_HOURS * 60 * 60 * 1000) {
    throw new Error(`release manifest lifetime exceeds ${MAX_RELEASE_MANIFEST_TTL_HOURS} hours`);
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error("release manifest verification time is invalid");
  if (enforceFreshness) {
    if (createdAtMs > nowMs + MAX_RELEASE_CREATED_AT_FUTURE_SKEW_MS) {
      throw new Error("release manifest createdAt is too far in the future");
    }
    if (expiresAtMs <= nowMs) throw new Error("release manifest has expired");
  }
  // Legacy signed releases remain valid for the full path. New source metadata
  // must be complete and exact; a partial or forged fast-path claim is rejected.
  if (Object.hasOwn(manifest, "archiveSourceEvidence")) {
    require("./releaseArchiveSourceInventory.cjs").validateSignedArchiveSourceEvidence(manifest);
  }
  return {
    site: manifest.site,
    channel: manifest.channel,
    releaseSequence: manifest.releaseSequence,
    createdAtMs,
    expiresAtMs
  };
};

const ensurePrivateDirectory = (directoryPath) => {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`release sequence state directory must be a real directory: ${directoryPath}`);
  }
};

const acquireSequenceLock = (lockPath, { timeoutMs = 10000 } = {}) => {
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const ownerPath = path.join(lockPath, "owner.json");
      let ownerFd;
      try {
        ownerFd = fs.openSync(ownerPath, "wx", 0o600);
        fs.writeFileSync(ownerFd, `${JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        })}\n`);
        fs.fsyncSync(ownerFd);
        fs.closeSync(ownerFd);
        ownerFd = undefined;
      } catch (error) {
        if (ownerFd !== undefined) {
          try { fs.closeSync(ownerFd); } catch {}
        }
        try { fs.rmSync(ownerPath, { force: true }); } catch {}
        try { fs.rmdirSync(lockPath); } catch {}
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        fs.rmSync(ownerPath, { force: true });
        fs.rmdirSync(lockPath);
        released = true;
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lockPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`release sequence lock is not a real directory: ${lockPath}`);
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `timed out waiting for release sequence lock directory: ${lockPath}; `
          + "inspect owner.json and remove the directory only after confirming its process is not running"
        );
      }
      sleepSync(50);
    }
  }
};

const readSequenceState = (statePath, site, channel) => {
  let stat;
  try {
    stat = fs.lstatSync(statePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { highestReservedSequence: 0 };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`release sequence state must be a regular non-symlink file: ${statePath}`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`release sequence state must have exactly one hard link: ${statePath}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`release sequence state must be owned by the current user: ${statePath}`);
  }
  if (stat.size <= 0 || stat.size > 16 * 1024) {
    throw new Error(`release sequence state has an invalid size: ${statePath}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`release sequence state must not be group/world accessible: ${statePath}`);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`release sequence state is not valid JSON: ${statePath} (${error.message || String(error)})`);
  }
  if (state.stateVersion !== RELEASE_SEQUENCE_STATE_VERSION) {
    throw new Error(`unsupported release sequence state version: ${state.stateVersion}`);
  }
  if (state.site !== site || state.channel !== channel) {
    throw new Error(`release sequence state identity mismatch: expected ${site}/${channel}, found ${state.site}/${state.channel}`);
  }
  if (!Number.isSafeInteger(state.highestReservedSequence) || state.highestReservedSequence < 0) {
    throw new Error("release sequence state highestReservedSequence must be a non-negative safe integer");
  }
  assertCanonicalIsoDate(state.updatedAt, "release sequence state updatedAt");
  return state;
};

const syncDirectoryBestEffort = (directoryPath) => {
  let fd;
  try {
    fd = fs.openSync(directoryPath, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!(["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error?.code))) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const writeSequenceStateAtomically = (statePath, state) => {
  const directoryPath = path.dirname(statePath);
  const tempPath = path.join(
    directoryPath,
    `.${path.basename(statePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, statePath);
    if (process.platform !== "win32") fs.chmodSync(statePath, 0o600);
    syncDirectoryBestEffort(directoryPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
};

const reserveReleaseSequence = ({
  site,
  channel,
  requestedSequence = process.env.RELEASE_SEQUENCE,
  statePath = resolveReleaseSequenceStatePath(),
  now = new Date()
} = {}) => {
  const expectedSite = assertReleaseIdentity(site, "release sequence site");
  const expectedChannel = assertReleaseIdentity(channel, "release sequence channel");
  const resolvedStatePath = path.resolve(statePath);
  ensurePrivateDirectory(path.dirname(resolvedStatePath));
  const releaseLock = acquireSequenceLock(`${resolvedStatePath}.lock`);
  try {
    const previous = readSequenceState(resolvedStatePath, expectedSite, expectedChannel);
    let releaseSequence;
    if (requestedSequence === undefined || requestedSequence === null || requestedSequence === "") {
      if (previous.highestReservedSequence >= MAX_SAFE_RELEASE_SEQUENCE) {
        throw new Error("release sequence state is exhausted");
      }
      releaseSequence = previous.highestReservedSequence + 1;
    } else {
      releaseSequence = parseStrictPositiveInteger(requestedSequence, "RELEASE_SEQUENCE");
      if (releaseSequence <= previous.highestReservedSequence) {
        throw new Error(`RELEASE_SEQUENCE must be greater than ${previous.highestReservedSequence}`);
      }
    }
    const updatedAt = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (!Number.isFinite(updatedAt.getTime())) throw new Error("release sequence update time is invalid");
    writeSequenceStateAtomically(resolvedStatePath, {
      stateVersion: RELEASE_SEQUENCE_STATE_VERSION,
      site: expectedSite,
      channel: expectedChannel,
      highestReservedSequence: releaseSequence,
      updatedAt: updatedAt.toISOString()
    });
    return {
      releaseSequence,
      previousSequence: previous.highestReservedSequence,
      statePath: resolvedStatePath
    };
  } finally {
    releaseLock();
  }
};

const assertRegularFile = (filePath, label) => {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} does not exist: ${filePath} (${error.message || String(error)})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  }
  return stat;
};

const assertPrivateKeyPermissions = (filePath, stat) => {
  if (process.platform === "win32") return;
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`release signing private key must not be group/world accessible: ${filePath}`);
  }
};

const rsaPrivateKeyFromPem = (pem, filePath = "release signing private key") => {
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(`${filePath} must contain an RSA private key`);
  }
  const modulusLength = Number(key.asymmetricKeyDetails?.modulusLength || 0);
  if (modulusLength < 3072) {
    throw new Error(`${filePath} must use an RSA modulus of at least 3072 bits`);
  }
  return key;
};

const rsaPublicKeyFromPem = (pem, filePath = "release signing public key") => {
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(`${filePath} must contain an RSA public key`);
  }
  const modulusLength = Number(key.asymmetricKeyDetails?.modulusLength || 0);
  if (modulusLength < 3072) {
    throw new Error(`${filePath} must use an RSA modulus of at least 3072 bits`);
  }
  return key;
};

const asPublicKey = (key) => key?.type === "public" ? key : crypto.createPublicKey(key);

const publicKeyPem = (key) => asPublicKey(key).export({
  type: "spki",
  format: "pem"
});

const publicKeyId = (key) => crypto.createHash("sha256")
  .update(asPublicKey(key).export({ type: "spki", format: "der" }))
  .digest("hex");

const resolvePrivateKeyPath = () => path.resolve(
  process.env.RELEASE_SIGNING_PRIVATE_KEY || DEFAULT_RELEASE_SIGNING_PRIVATE_KEY
);

const resolvePublicKeyPath = () => path.resolve(
  process.env.RELEASE_SIGNING_PUBLIC_KEY || DEFAULT_RELEASE_SIGNING_PUBLIC_KEY
);

const loadReleasePrivateKey = (filePath = resolvePrivateKeyPath()) => {
  const resolved = path.resolve(filePath);
  const stat = assertRegularFile(resolved, "release signing private key");
  assertPrivateKeyPermissions(resolved, stat);
  const key = rsaPrivateKeyFromPem(fs.readFileSync(resolved), resolved);
  return {
    path: resolved,
    key,
    publicKeyPem: publicKeyPem(key),
    keyId: publicKeyId(key)
  };
};

const loadReleasePublicKey = (filePath = resolvePublicKeyPath()) => {
  const resolved = path.resolve(filePath);
  assertRegularFile(resolved, "release signing public key");
  const key = rsaPublicKeyFromPem(fs.readFileSync(resolved), resolved);
  return {
    path: resolved,
    key,
    publicKeyPem: publicKeyPem(key),
    keyId: publicKeyId(key)
  };
};

const ensureMatchingPublicKeyFile = (filePath, expectedPem) => {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (fs.existsSync(resolved)) {
    const existing = loadReleasePublicKey(resolved);
    const expected = rsaPublicKeyFromPem(expectedPem, "derived release signing public key");
    if (existing.keyId !== publicKeyId(expected)) {
      throw new Error(`release signing public key does not match the private key: ${resolved}`);
    }
    return existing;
  }
  fs.writeFileSync(resolved, expectedPem, { mode: 0o644, flag: "wx" });
  return loadReleasePublicKey(resolved);
};

const signManifestBytes = (manifestBytes, privateKey) => crypto.sign(
  "sha256",
  manifestBytes,
  {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING
  }
);

const verifyManifestBytes = (manifestBytes, signature, publicKey) => crypto.verify(
  "sha256",
  manifestBytes,
  {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PADDING
  },
  signature
);

const verifyManifestSignature = ({ manifestPath, signaturePath, publicKeyPath, now, enforceFreshness = true }) => {
  const manifestStat = assertRegularFile(manifestPath, "release manifest");
  const signatureStat = assertRegularFile(signaturePath, "release manifest signature");
  if (manifestStat.size > 1024 * 1024) throw new Error("release manifest exceeds 1 MiB");
  if (signatureStat.size > 16 * 1024) throw new Error("release manifest signature exceeds 16 KiB");
  const manifestBytes = fs.readFileSync(manifestPath);
  const signature = fs.readFileSync(signaturePath);
  const publicKey = loadReleasePublicKey(publicKeyPath);
  if (!verifyManifestBytes(manifestBytes, signature, publicKey.key)) {
    throw new Error("release manifest signature verification failed");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`signed release manifest is not valid JSON: ${error.message || String(error)}`);
  }
  validateReleaseManifestV3(manifest, { now: now ?? Date.now(), enforceFreshness });
  if (manifest.signature?.algorithm !== RELEASE_SIGNATURE_ALGORITHM) {
    throw new Error(`unsupported release signature algorithm: ${manifest.signature?.algorithm || "missing"}`);
  }
  if (manifest.signature?.keyId !== publicKey.keyId) {
    throw new Error("signed release manifest key id does not match the trusted public key");
  }
  return { manifest, keyId: publicKey.keyId, manifestBytes };
};

module.exports = {
  DEFAULT_RELEASE_CHANNEL,
  DEFAULT_RELEASE_MANIFEST_TTL_HOURS,
  DEFAULT_RELEASE_SEQUENCE_STATE_PATH,
  DEFAULT_RELEASE_SIGNING_PRIVATE_KEY,
  DEFAULT_RELEASE_SIGNING_PUBLIC_KEY,
  DEFAULT_RELEASE_SITE,
  MAX_RELEASE_CREATED_AT_FUTURE_SKEW_MS,
  MAX_RELEASE_MANIFEST_TTL_HOURS,
  RELEASE_MANIFEST_VERSION,
  RELEASE_SEQUENCE_STATE_VERSION,
  RELEASE_SIGNATURE_ALGORITHM,
  ensureMatchingPublicKeyFile,
  loadReleasePrivateKey,
  loadReleasePublicKey,
  parseStrictPositiveInteger,
  publicKeyId,
  reserveReleaseSequence,
  resolveReleaseManifestConfig,
  resolvePrivateKeyPath,
  resolvePublicKeyPath,
  resolveReleaseSequenceStatePath,
  signManifestBytes,
  validateReleaseManifestV3,
  verifyManifestBytes,
  verifyManifestSignature
};
