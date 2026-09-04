const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SHA256_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;
const SUPPORTED_HOST_KEY_TYPES = new Set(["ssh-ed25519"]);
const MAX_KNOWN_HOSTS_BYTES = 16 * 1024;

const normalizeHost = (value) => {
  const host = String(value || "").trim();
  if (!host || /[\s\x00-\x1f\x7f]/.test(host)) {
    throw new Error("release SSH host is missing or malformed");
  }
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
};

const normalizePort = (value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("release SSH port is invalid");
  }
  return port;
};

const releaseKnownHostToken = (host, port) => {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = normalizePort(port);
  return normalizedPort === 22
    ? normalizedHost
    : `[${normalizedHost}]:${normalizedPort}`;
};

const fingerprintSshKeyBlob = (encodedBlob) => {
  const value = String(encodedBlob || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > MAX_KNOWN_HOSTS_BYTES) {
    throw new Error("release known_hosts key blob is malformed");
  }
  const bytes = Buffer.from(value, "base64");
  const canonicalInput = value.replace(/=+$/, "");
  const canonicalDecoded = bytes.toString("base64").replace(/=+$/, "");
  if (bytes.length === 0 || canonicalDecoded !== canonicalInput) {
    throw new Error("release known_hosts key blob is not canonical base64");
  }
  const digest = crypto.createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
};

const validateReleaseSshHostKeyPin = ({
  knownHostsPath,
  host,
  port,
  expectedFingerprint,
  expectedKeyType = "ssh-ed25519"
}) => {
  const resolvedKnownHostsPath = path.resolve(String(knownHostsPath || ""));
  const fingerprint = String(expectedFingerprint || "").trim();
  const keyType = String(expectedKeyType || "").trim();
  const hostToken = releaseKnownHostToken(host, port);

  if (!SHA256_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error("RELEASE_DEPLOY_HOST_KEY_SHA256 must be an explicit OpenSSH SHA-256 fingerprint");
  }
  if (!SUPPORTED_HOST_KEY_TYPES.has(keyType)) {
    throw new Error(`unsupported release SSH host-key type: ${keyType || "missing"}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(resolvedKnownHostsPath);
  } catch {
    throw new Error(`release known_hosts file is missing: ${resolvedKnownHostsPath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("release known_hosts path must be one regular, non-symlink, single-link file");
  }
  if (stat.size < 1 || stat.size > MAX_KNOWN_HOSTS_BYTES) {
    throw new Error("release known_hosts file size is outside the allowed range");
  }

  const entries = fs.readFileSync(resolvedKnownHostsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (entries.length !== 1) {
    throw new Error("release known_hosts file must contain exactly one non-comment entry");
  }
  const fields = entries[0].split(/\s+/);
  if (fields.length < 3 || fields[0] !== hostToken) {
    throw new Error(`release known_hosts host token must be exactly ${hostToken}`);
  }
  if (fields[1] !== keyType) {
    throw new Error(`release known_hosts key type must be exactly ${keyType}`);
  }
  const actualFingerprint = fingerprintSshKeyBlob(fields[2]);
  if (actualFingerprint !== fingerprint) {
    throw new Error("release SSH host-key fingerprint does not match the explicit pin");
  }

  return {
    knownHostsPath: resolvedKnownHostsPath,
    sshKnownHostsPath: resolvedKnownHostsPath.replace(/\\/g, "/"),
    hostToken,
    keyType,
    fingerprint: actualFingerprint
  };
};

const resolveReleaseSshHostKeyPin = ({ rootDir, tmpDir, host, port, statusMode = false }) => {
  const knownHostsValue = statusMode
    ? process.env.RELEASE_STATUS_KNOWN_HOSTS || process.env.RELEASE_DEPLOY_KNOWN_HOSTS
    : process.env.RELEASE_DEPLOY_KNOWN_HOSTS;
  const fingerprintValue = statusMode
    ? process.env.RELEASE_STATUS_HOST_KEY_SHA256 || process.env.RELEASE_DEPLOY_HOST_KEY_SHA256
    : process.env.RELEASE_DEPLOY_HOST_KEY_SHA256;
  const keyTypeValue = statusMode
    ? process.env.RELEASE_STATUS_HOST_KEY_TYPE || process.env.RELEASE_DEPLOY_HOST_KEY_TYPE
    : process.env.RELEASE_DEPLOY_HOST_KEY_TYPE;
  const defaultPath = path.join(tmpDir || path.join(rootDir, ".codex-tmp"), "football-release.known_hosts");
  return validateReleaseSshHostKeyPin({
    knownHostsPath: knownHostsValue || defaultPath,
    host,
    port,
    expectedFingerprint: fingerprintValue,
    expectedKeyType: keyTypeValue || "ssh-ed25519"
  });
};

const buildPinnedSshBaseOptions = ({ keyPath, pin, serverAliveCountMax = 1 }) => {
  if (!pin?.sshKnownHostsPath || !pin?.keyType) {
    throw new Error("validated release SSH host-key pin is required");
  }
  const nullKnownHostsPath = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "-F",
    "none",
    "-i",
    path.resolve(keyPath),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${pin.sshKnownHostsPath}`,
    "-o",
    `GlobalKnownHostsFile=${nullKnownHostsPath}`,
    "-o",
    "UpdateHostKeys=no",
    "-o",
    `HostKeyAlgorithms=${pin.keyType}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=12",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    `ServerAliveCountMax=${serverAliveCountMax}`
  ];
};

module.exports = {
  SHA256_FINGERPRINT_PATTERN,
  buildPinnedSshBaseOptions,
  fingerprintSshKeyBlob,
  releaseKnownHostToken,
  resolveReleaseSshHostKeyPin,
  validateReleaseSshHostKeyPin
};
