#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const TRANSACTION_VERSION = 3;
const APP_PATH = "/opt/football-predict";
const BACKUP_PATH = "/opt/football-predict.previous";
const FAILED_PATH = "/opt/football-predict.failed";
const NEXT_PATH = "/opt/football-predict.next";
const RUNTIME_ENV_PATH = "/etc/football-predict/env";
const RECOVERY_ROOT_PATH = "/var/lib/football-release/recovery";
const RECOVERY_CURRENT_PATH = `${RECOVERY_ROOT_PATH}/current`;
const STORE_PATH = "/var/lib/football-predict";
const SQLITE_PATH = `${STORE_PATH}/football.db`;
const EXPECTED_SITE_PATH = "/etc/football-release/expected-site";
const EXPECTED_CHANNEL_PATH = "/etc/football-release/expected-channel";

const MANAGED_CONFIG_PATHS = [
  "/etc/systemd/system/football-predict.service",
  "/etc/systemd/system/football-sync-worker.service",
  "/etc/systemd/system/football-cleanup.service",
  "/etc/systemd/system/football-cleanup.timer",
  "/etc/systemd/system/football-monitor.service",
  "/etc/systemd/system/football-monitor.timer",
  "/etc/nginx/conf.d/football-predict-common.conf",
  "/etc/nginx/snippets/football-predict-server.conf",
  "/etc/nginx/snippets/football-predict-security-headers.conf",
  "/etc/nginx/sites-available/football-predict",
  "/etc/nginx/sites-enabled/default",
  "/etc/nginx/sites-enabled/football-predict"
];
const LEGACY_MANAGED_CONFIG_PATHS = MANAGED_CONFIG_PATHS.filter(
  (target) => target !== "/etc/nginx/sites-enabled/default"
);
const SUPPORTED_MANAGED_CONFIG_PATH_SETS = [MANAGED_CONFIG_PATHS, LEGACY_MANAGED_CONFIG_PATHS];

const TIMER_UNITS = ["football-cleanup.timer", "football-monitor.timer"];
const MAINTENANCE_UNITS = [
  "football-cleanup.timer",
  "football-monitor.timer",
  "football-cleanup.service",
  "football-monitor.service"
];
const RUNTIME_UNITS = ["football-sync-worker.service", "football-predict.service"];
const UNIT_STATE_NAMES = ["football-predict.service", "football-sync-worker.service", "nginx.service"];
const COMMON_COHORT_G2_V1_PATH = `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2.json`;
const COMMON_COHORT_G2_V2_PATH = `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2-v2.json`;
const MODEL_ARTIFACTS = new Map([
  ["strategy", `${STORE_PATH}/model-strategy.json`],
  ["evaluation", `${STORE_PATH}/model-artifacts/evaluation.json`],
  ["candidate-registry", `${STORE_PATH}/model-artifacts/candidate-prospective-registry.json`],
  ["candidate-challenger-suite", `${STORE_PATH}/model-artifacts/candidate-prospective-challenger-suite.json`],
  ["candidate-temperature-suite", `${STORE_PATH}/model-artifacts/candidate-prospective-temperature-neutralization-suite.json`],
  ["candidate-common-cohort-g2-v1", `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2.json`],
  ["candidate-common-cohort-g2-v2", `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2-v2.json`],
  ["candidate-capture-status", `${STORE_PATH}/candidate-prospective-capture-status.json`],
  ["benchmark-prospective-ledger", `${STORE_PATH}/model-artifacts/benchmark-prospective-ledger.json`]
]);
// Preserve transactions written by all older release generations. The r359
// six-row manifest used the unsuffixed token for the v1 G2 file; new releases
// snapshot that same legacy file as -v1 and the isolated schema as -v2.
const LEGACY_MODEL_ARTIFACT_COUNTS = new Set([2, 4, 5, 6, 7]);
const SQLITE_TOKENS = new Map([
  ["base", ""],
  ["wal", "-wal"],
  ["shm", "-shm"]
]);

const PRE_SWAP_PHASES = new Set([
  "prepared",
  "runtime-env-updating",
  "runtime-env-updated",
  "candidate-validated",
  "host-config-changing",
  "host-config-applied",
  "external-model-artifacts-snapshotted",
  "sqlite-snapshotted"
]);
const ROLLBACK_PHASES = new Set([
  ...PRE_SWAP_PHASES,
  "swap-starting",
  "swap-complete",
  "readiness-passed",
  "rollback-starting",
  "recovering-rollback",
  "rolled-back"
]);
const FORWARD_PHASES = new Set(["finalizing", "committed", "recovering-commit"]);
const SQLITE_REQUIRED_PHASES = new Set([
  "sqlite-snapshotted",
  "swap-starting",
  "swap-complete",
  "readiness-passed",
  "rollback-starting",
  "recovering-rollback",
  "rolled-back",
  ...FORWARD_PHASES
]);
const MODEL_REQUIRED_PHASES = new Set([
  "external-model-artifacts-snapshotted",
  ...SQLITE_REQUIRED_PHASES
]);
const NEW_IDENTITY_REQUIRED_PHASES = new Set([
  "candidate-validated",
  "host-config-changing",
  "host-config-applied",
  "external-model-artifacts-snapshotted",
  ...SQLITE_REQUIRED_PHASES
]);

class RecoveryError extends Error {
  constructor(message, code = 78) {
    super(message);
    this.name = "RecoveryError";
    this.exitCode = code;
  }
}

const fail = (message, code = 78) => {
  throw new RecoveryError(message, code);
};

const TEST_MODE = process.env.FOOTBALL_RELEASE_RECOVERY_TEST_MODE === "1";
const TEST_ROOT = TEST_MODE
  ? path.resolve(process.env.FOOTBALL_RELEASE_RECOVERY_TEST_ROOT || "")
  : "";
if (TEST_MODE && !TEST_ROOT) fail("test mode requires FOOTBALL_RELEASE_RECOVERY_TEST_ROOT");
if (!TEST_MODE && typeof process.getuid === "function" && process.getuid() !== 0) {
  fail("cold recovery must run as root", 77);
}

const hostPath = (absolutePath) => {
  if (!absolutePath.startsWith("/")) fail(`non-absolute fixed path: ${absolutePath}`);
  return TEST_MODE ? path.join(TEST_ROOT, absolutePath.slice(1)) : absolutePath;
};

const productionPath = (mappedPath) => {
  if (!TEST_MODE) return mappedPath;
  const relative = path.relative(TEST_ROOT, mappedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`test path escaped root: ${mappedPath}`);
  return `/${relative.replace(/\\/g, "/")}`;
};

const lstatOrNull = (target, options) => {
  try {
    return fs.lstatSync(target, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const pathExistsNoFollow = (target) => lstatOrNull(target) !== null;

const sha256File = (filePath) => {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
};

const sha256Text = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const fsyncPath = (target) => {
  if (TEST_MODE) return;
  const fd = fs.openSync(target, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

const readSingleLine = (filePath, label) => {
  const value = fs.readFileSync(filePath, "utf8");
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1 || !lines[0]) fail(`${label} must contain exactly one non-empty line`);
  return lines[0];
};

const assertSecureDirectory = (dirPath, label) => {
  let stat;
  try {
    stat = fs.lstatSync(dirPath);
  } catch {
    fail(`${label} is missing: ${dirPath}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a real directory: ${dirPath}`);
  if (!TEST_MODE && (stat.uid !== 0 || stat.gid !== 0)) fail(`${label} is not root-owned: ${dirPath}`);
  if (!(TEST_MODE && process.platform === "win32") && (stat.mode & 0o777) !== 0o700) {
    fail(`${label} mode must be 0700: ${dirPath}`);
  }
  return stat;
};

const assertSecureFile = (filePath, label, { mode = 0o600 } = {}) => {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is missing: ${filePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(`${label} is not a single-link regular file: ${filePath}`);
  }
  if (!TEST_MODE && (stat.uid !== 0 || stat.gid !== 0)) fail(`${label} is not root-owned: ${filePath}`);
  if (!(TEST_MODE && process.platform === "win32") && (stat.mode & 0o777) !== mode) {
    fail(`${label} mode must be 0${mode.toString(8)}: ${filePath}`);
  }
  return stat;
};

const readJsonFile = (filePath, label) => {
  assertSecureFile(filePath, label);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
  return value;
};

const parseTsv = (filePath, label, expectedColumns) => {
  assertSecureFile(filePath, label);
  const body = fs.readFileSync(filePath, "utf8");
  const lines = body.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.map((line, index) => {
    const columns = line.split("\t");
    if (columns.length !== expectedColumns) fail(`${label} line ${index + 1} has ${columns.length} columns`);
    return columns;
  });
};

const validateDigest = (digest) => /^[0-9a-f]{64}$/.test(digest);
const validateInteger = (value) => /^(0|[1-9][0-9]*)$/.test(String(value));
const validateName = (value) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);

const atomicWriteFileFromSnapshot = (source, target, metadata) => {
  const parent = path.dirname(target);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail(`restore parent is unsafe: ${parent}`);
  const targetStat = lstatOrNull(target);
  if (targetStat?.isDirectory()) fail(`restore target became a directory: ${target}`);
  const temp = path.join(parent, `.${path.basename(target)}.recover.${process.pid}.${crypto.randomBytes(4).toString("hex")}`);
  fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
  const copied = fs.lstatSync(temp);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1) fail(`restored temporary file is unsafe: ${temp}`);
  if (copied.size !== metadata.bytes || sha256File(temp) !== metadata.digest) fail(`restored temporary file hash mismatch: ${target}`);
  fs.chmodSync(temp, metadata.mode);
  if (!TEST_MODE) fs.chownSync(temp, metadata.uid, metadata.gid);
  fsyncPath(temp);
  fs.renameSync(temp, target);
  fsyncPath(parent);
};

class SystemAdapter {
  constructor() {
    this.mockPath = TEST_MODE ? hostPath("/mock-systemd.json") : null;
    this.state = TEST_MODE
      ? JSON.parse(fs.readFileSync(this.mockPath, "utf8"))
      : null;
  }

  save() {
    if (!TEST_MODE) return;
    fs.writeFileSync(this.mockPath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  run(command, args, { allowFailure = false } = {}) {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0 && !allowFailure) {
      fail(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
    }
    return result;
  }

  unit(name) {
    if (!TEST_MODE) return null;
    this.state.units ||= {};
    this.state.units[name] ||= { exists: true, enabled: false, active: false };
    return this.state.units[name];
  }

  unitExists(name) {
    if (TEST_MODE) return this.unit(name).exists !== false;
    return this.run("systemctl", ["cat", name], { allowFailure: true }).status === 0;
  }

  isActive(name) {
    if (TEST_MODE) return Boolean(this.unit(name).active);
    return this.run("systemctl", ["is-active", "--quiet", name], { allowFailure: true }).status === 0;
  }

  isEnabled(name) {
    if (TEST_MODE) return Boolean(this.unit(name).enabled);
    return this.run("systemctl", ["is-enabled", "--quiet", name], { allowFailure: true }).status === 0;
  }

  stop(name) {
    if (!this.unitExists(name)) return;
    if (TEST_MODE) {
      this.unit(name).active = false;
      this.save();
      return;
    }
    this.run("systemctl", ["stop", name]);
    if (this.isActive(name)) fail(`unit remained active after stop: ${name}`);
  }

  start(name) {
    if (!this.unitExists(name)) fail(`required unit does not exist: ${name}`);
    if (TEST_MODE) {
      this.unit(name).active = true;
      this.save();
      return;
    }
    this.run("systemctl", ["start", name]);
    if (!this.isActive(name)) fail(`unit did not become active: ${name}`);
  }

  setEnabled(name, enabled) {
    if (!this.unitExists(name)) {
      if (!enabled) return;
      fail(`cannot enable missing unit: ${name}`);
    }
    if (TEST_MODE) {
      this.unit(name).enabled = enabled;
      this.save();
      return;
    }
    this.run("systemctl", [enabled ? "enable" : "disable", name]);
    if (this.isEnabled(name) !== enabled) fail(`unit enable state did not converge: ${name}`);
  }

  daemonReload() {
    if (!TEST_MODE) this.run("systemctl", ["daemon-reload"]);
  }

  validateAndReloadNginx(wasActive) {
    if (TEST_MODE) {
      if (this.state.nginxValid === false) fail("mock nginx validation failed");
      if (wasActive) this.start("nginx.service");
      return;
    }
    const probe = this.run("nginx", ["-t"], { allowFailure: true });
    if (probe.status !== 0) fail(`nginx -t failed: ${(probe.stderr || probe.stdout || "").trim()}`);
    if (wasActive) this.run("systemctl", ["reload", "nginx.service"]);
  }

  rebuildSqliteForServingGeneration() {
    if (TEST_MODE) {
      if (this.state.publicationAffinityRepairFails) {
        fail("serving-generation SQLite rebuild failed");
      }
      this.state.publicationAffinityRebuilds = Number(this.state.publicationAffinityRebuilds || 0) + 1;
      this.save();
      return;
    }
    const app = hostPath(APP_PATH);
    const runtimeEnv = hostPath(RUNTIME_ENV_PATH);
    assertRealDirectory(app, "restored application directory");
    const runtimeEnvStat = lstatOrNull(runtimeEnv);
    if (!runtimeEnvStat?.isFile() || runtimeEnvStat.isSymbolicLink() || runtimeEnvStat.nlink !== 1) {
      fail("restored runtime environment is not a single-link regular file");
    }
    this.run("runuser", [
      "-u", "football", "--", "bash", "-c",
      'set -a; . "$1"; set +a; cd "$2"; exec "$3" run datastore:sqlite',
      "bash", runtimeEnv, app, "/opt/node-v22.22.1/bin/npm"
    ]);
  }

  stopTransientUnits(bundleSha) {
    const prefix = `football-release-${bundleSha.slice(0, 12)}-`;
    if (TEST_MODE) {
      for (const [name, unit] of Object.entries(this.state.units || {})) {
        if (name.startsWith(prefix) && name.endsWith(".service")) unit.active = false;
      }
      this.save();
      return;
    }
    const listed = this.run("systemctl", ["list-units", "--all", "--plain", "--no-legend", `${prefix}*.service`], { allowFailure: true });
    for (const line of (listed.stdout || "").split(/\r?\n/)) {
      const name = line.trim().split(/\s+/)[0];
      if (!name) continue;
      if (!name.startsWith(prefix) || !name.endsWith(".service")) fail(`unexpected transient unit name: ${name}`);
      this.run("systemctl", ["stop", name], { allowFailure: true });
      this.run("systemctl", ["kill", "--kill-who=all", "--signal=KILL", name], { allowFailure: true });
      if (this.isActive(name)) fail(`transient release unit remained active: ${name}`);
    }
  }

  killDedicatedUserProcesses() {
    if (TEST_MODE) {
      if (this.state.unknownFootballProcess || this.state.unknownBuildProcess) {
        fail("mock dedicated service user has an unknown process");
      }
      return;
    }
    for (const user of ["football", "football-build"]) {
      this.run("pkill", ["-KILL", "-u", user], { allowFailure: true });
      if (this.run("pgrep", ["-u", user], { allowFailure: true }).status === 0) {
        fail(`dedicated service user still has a process after quiesce: ${user}`);
      }
    }
  }

  isMountpoint(target) {
    if (TEST_MODE) return (this.state.mountpoints || []).includes(productionPath(target));
    return this.run("mountpoint", ["-q", target], { allowFailure: true }).status === 0;
  }

  waitForHealth() {
    if (TEST_MODE) {
      if (this.state.health === false) fail("mock application health is failing");
      return;
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = this.run("curl", ["-fsS", "--max-time", "8", "http://127.0.0.1:8788/api/v1/health"], { allowFailure: true });
      if (result.status === 0) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
    fail("restored application did not become healthy");
  }
}

const loadIdentity = (currentDir, name, required) => {
  const identityPath = path.join(currentDir, "trees", `${name}.json`);
  if (!pathExistsNoFollow(identityPath)) {
    if (required) fail(`required ${name} app identity is missing`);
    return null;
  }
  const value = readJsonFile(identityPath, `${name} app identity`);
  const expectedPath = name === "old-app" ? APP_PATH : NEXT_PATH;
  if (value.path !== expectedPath) fail(`${name} app identity path mismatch`);
  for (const field of ["dev", "ino", "uid", "gid"]) {
    if (!validateInteger(value[field])) fail(`${name} app identity ${field} is invalid`);
  }
  if (!/^[0-7]{3,4}$/.test(String(value.mode))) fail(`${name} app identity mode is invalid`);
  for (const field of ["treeMarker", "bundleMarker", "liveMarker"]) {
    if (value[field] !== "-" && !/^[0-9a-f]{64}$/.test(value[field])) fail(`${name} app identity ${field} is invalid`);
  }
  return {
    ...value,
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    uid: Number(value.uid),
    gid: Number(value.gid),
    mode: Number.parseInt(value.mode, 8)
  };
};

const treeMatchesRecordedIdentityMetadata = (absolutePath, identity) => {
  const stat = lstatOrNull(hostPath(absolutePath), { bigint: true });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  return stat.dev === identity.dev
    && stat.ino === identity.ino
    && stat.uid === BigInt(identity.uid)
    && stat.gid === BigInt(identity.gid)
    && (stat.mode & 0o7777n) === BigInt(identity.mode);
};

const loadRuntimeEnvSnapshot = (currentDir) => {
  const dir = path.join(currentDir, "runtime-env");
  assertSecureDirectory(dir, "runtime env snapshot directory");
  const rows = parseTsv(path.join(dir, "manifest.tsv"), "runtime env snapshot manifest", 8);
  if (rows.length !== 1) fail("runtime env snapshot manifest must contain one row");
  const [token, target, present, bytesRaw, digest, uidRaw, gidRaw, modeRaw] = rows[0];
  if (token !== "env" || target !== RUNTIME_ENV_PATH) fail("runtime env snapshot target mismatch");
  const parentState = readSingleLine(path.join(dir, "parent-state"), "runtime env parent state");
  if (!["present", "absent"].includes(parentState)) fail("runtime env parent state is invalid");
  let parentMetadata = null;
  if (parentState === "present") {
    const raw = readSingleLine(path.join(dir, "parent-metadata"), "runtime env parent metadata").split(" ");
    if (raw.length !== 3 || !raw.every(validateInteger)) fail("runtime env parent metadata is invalid");
    parentMetadata = { uid: Number(raw[0]), gid: Number(raw[1]), mode: Number.parseInt(raw[2], 8) };
  }
  if (present === "0") {
    if ([bytesRaw, digest, uidRaw, gidRaw, modeRaw].some((value) => value !== "-")) fail("absent runtime env metadata is not empty");
    if (pathExistsNoFollow(path.join(dir, "env"))) fail("absent runtime env has a snapshot file");
    return { dir, present: false, parentState, parentMetadata };
  }
  if (present !== "1" || !validateInteger(bytesRaw) || !validateDigest(digest)
      || !validateInteger(uidRaw) || !validateInteger(gidRaw) || !/^[0-7]{3,4}$/.test(modeRaw)) {
    fail("runtime env snapshot metadata is invalid");
  }
  const source = path.join(dir, "env");
  const stat = assertSecureFile(source, "runtime env snapshot");
  const bytes = Number(bytesRaw);
  if (stat.size !== bytes || sha256File(source) !== digest) fail("runtime env snapshot hash mismatch");
  return {
    dir,
    present: true,
    source,
    bytes,
    digest,
    uid: Number(uidRaw),
    gid: Number(gidRaw),
    mode: Number.parseInt(modeRaw, 8),
    parentState,
    parentMetadata
  };
};

const loadConfigSnapshot = (currentDir) => {
  const dir = path.join(currentDir, "managed-config");
  const entriesDir = path.join(dir, "entries");
  assertSecureDirectory(dir, "managed config snapshot directory");
  assertSecureDirectory(entriesDir, "managed config entries directory");
  const rows = parseTsv(path.join(dir, "manifest.tsv"), "managed config manifest", 5);
  const sameLengthPathSets = SUPPORTED_MANAGED_CONFIG_PATH_SETS.filter((paths) => paths.length === rows.length);
  if (sameLengthPathSets.length === 0) fail("managed config manifest length mismatch");
  const expectedConfigPaths = sameLengthPathSets.find((paths) => (
    rows.every((row, index) => row[2] === paths[index])
  ));
  if (!expectedConfigPaths) fail("managed config manifest order mismatch");
  const entries = rows.map((row, offset) => {
    const [indexRaw, type, target, bytesRaw, digest] = row;
    const index = offset + 1;
    if (indexRaw !== String(index) || target !== expectedConfigPaths[offset]) fail("managed config manifest order mismatch");
    const source = path.join(entriesDir, String(index));
    if (type === "absent") {
      if (bytesRaw !== "-" || digest !== "-" || pathExistsNoFollow(source)) fail(`invalid absent managed config snapshot: ${target}`);
      return { type, target };
    }
    if (!validateInteger(bytesRaw) || !validateDigest(digest)) fail(`invalid managed config digest metadata: ${target}`);
    if (type === "file") {
      const stat = assertSecureFile(source, `managed config snapshot ${index}`);
      if (stat.size !== Number(bytesRaw) || sha256File(source) !== digest) fail(`managed config snapshot hash mismatch: ${target}`);
      return { type, target, source, bytes: stat.size, digest, uid: 0, gid: 0, mode: 0o644 };
    }
    if (type === "symlink") {
      const stat = fs.lstatSync(source);
      if (!stat.isSymbolicLink()) fail(`managed config symlink snapshot is invalid: ${target}`);
      const linkTarget = fs.readlinkSync(source);
      if (Buffer.byteLength(linkTarget) !== Number(bytesRaw) || sha256Text(linkTarget) !== digest) {
        fail(`managed config symlink hash mismatch: ${target}`);
      }
      return { type, target, source, linkTarget };
    }
    fail(`managed config snapshot type is invalid: ${type}`);
  });
  const timerRows = parseTsv(path.join(dir, "timers.tsv"), "timer state manifest", 3);
  if (timerRows.length !== TIMER_UNITS.length) fail("timer state manifest length mismatch");
  const timers = timerRows.map(([name, enabled, active], index) => {
    if (name !== TIMER_UNITS[index] || !["0", "1"].includes(enabled) || !["0", "1"].includes(active)) {
      fail("timer state manifest is invalid");
    }
    return { name, enabled: enabled === "1", active: active === "1" };
  });
  const unitRows = parseTsv(path.join(dir, "units.tsv"), "runtime unit state manifest", 3);
  if (unitRows.length !== UNIT_STATE_NAMES.length) fail("runtime unit state manifest length mismatch");
  const units = unitRows.map(([name, enabled, active], index) => {
    if (name !== UNIT_STATE_NAMES[index] || !["0", "1"].includes(enabled) || !["0", "1"].includes(active)) {
      fail("runtime unit state manifest is invalid");
    }
    return { name, enabled: enabled === "1", active: active === "1" };
  });
  return { dir, entries, timers, units };
};

const loadSqliteSnapshot = (currentDir) => {
  const dir = path.join(currentDir, "sqlite");
  assertSecureDirectory(dir, "sqlite snapshot directory");
  if (readSingleLine(path.join(dir, "live-path"), "sqlite live path") !== SQLITE_PATH) fail("sqlite live path is not fixed");
  const rows = parseTsv(path.join(dir, "manifest.tsv"), "sqlite snapshot manifest", 7);
  if (rows.length !== SQLITE_TOKENS.size) fail("sqlite snapshot manifest must contain base/wal/shm");
  const entries = new Map();
  let index = 0;
  for (const [token, suffix] of SQLITE_TOKENS) {
    const [actualToken, present, bytesRaw, digest, uidRaw, gidRaw, modeRaw] = rows[index++];
    if (actualToken !== token) fail("sqlite snapshot token order mismatch");
    const source = path.join(dir, `football.db${suffix}`);
    if (present === "0") {
      if ([bytesRaw, digest, uidRaw, gidRaw, modeRaw].some((value) => value !== "-")) fail(`absent sqlite ${token} metadata is invalid`);
      if (pathExistsNoFollow(source)) fail(`absent sqlite ${token} snapshot exists`);
      entries.set(token, { token, suffix, present: false });
      continue;
    }
    if (present !== "1" || !validateInteger(bytesRaw) || !validateDigest(digest)
        || !validateInteger(uidRaw) || !validateInteger(gidRaw) || !/^[0-7]{3,4}$/.test(modeRaw)) {
      fail(`sqlite ${token} metadata is invalid`);
    }
    const stat = assertSecureFile(source, `sqlite ${token} snapshot`);
    const bytes = Number(bytesRaw);
    if (stat.size !== bytes || sha256File(source) !== digest) fail(`sqlite ${token} snapshot hash mismatch`);
    entries.set(token, {
      token,
      suffix,
      present: true,
      source,
      bytes,
      digest,
      uid: Number(uidRaw),
      gid: Number(gidRaw),
      mode: Number.parseInt(modeRaw, 8)
    });
  }
  if (!entries.get("base")?.present) fail("sqlite base snapshot must be present");
  const snapshot = { dir, entries };
  if (!TEST_MODE) {
    const validationDir = fs.mkdtempSync(path.join(currentDir, ".sqlite-validation."));
    fs.chmodSync(validationDir, 0o700);
    fs.chownSync(validationDir, 0, 0);
    let database;
    try {
      for (const entry of entries.values()) {
        if (!entry.present) continue;
        const destination = path.join(validationDir, `football.db${entry.suffix}`);
        fs.copyFileSync(entry.source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, 0o600);
        fs.chownSync(destination, 0, 0);
      }
      const { DatabaseSync } = require("node:sqlite");
      database = new DatabaseSync(path.join(validationDir, "football.db"));
      const rows = database.prepare("PRAGMA quick_check").all();
      if (rows.length !== 1 || Object.values(rows[0] || {})[0] !== "ok") {
        fail("sqlite rollback snapshot failed PRAGMA quick_check");
      }
    } catch (error) {
      if (error instanceof RecoveryError) throw error;
      fail(`sqlite rollback snapshot could not be opened safely: ${error.message}`);
    } finally {
      try { database?.close(); } catch {}
      fs.rmSync(validationDir, { recursive: true, force: true });
    }
  }
  return snapshot;
};

const loadModelSnapshot = (currentDir) => {
  const dir = path.join(currentDir, "external-model-artifacts");
  assertSecureDirectory(dir, "external model snapshot directory");
  const rows = parseTsv(path.join(dir, "manifest.tsv"), "external model manifest", 8);
  // Older transactions contain exact two-, four-, five-, six- or seven-entry
  // layouts. Six rows are the r359 unsuffixed v1 G2 token; seven rows are the
  // legacy v1+v2 pair, while nine rows add capture status and benchmark state.
  // Never reinterpret an older payload as the new schema.
  if (rows.length !== MODEL_ARTIFACTS.size && !LEGACY_MODEL_ARTIFACT_COUNTS.has(rows.length)) {
    fail("external model manifest length mismatch");
  }
  const expectedArtifacts = rows.length === 6
    ? [
        ...[...MODEL_ARTIFACTS].slice(0, 5),
        ["candidate-common-cohort-g2", COMMON_COHORT_G2_V1_PATH],
      ]
    : [...MODEL_ARTIFACTS].slice(0, rows.length);
  const entries = new Map();
  let index = 0;
  for (const [token, target] of expectedArtifacts) {
    const [actualToken, actualTarget, present, bytesRaw, digest, uidRaw, gidRaw, modeRaw] = rows[index++];
    if (actualToken !== token || actualTarget !== target) fail("external model artifact manifest order mismatch");
    const source = path.join(dir, token);
    if (present === "0") {
      if ([bytesRaw, digest, uidRaw, gidRaw, modeRaw].some((value) => value !== "-")) fail(`absent model ${token} metadata is invalid`);
      if (pathExistsNoFollow(source)) fail(`absent model ${token} snapshot exists`);
      entries.set(token, { token, target, present: false });
      continue;
    }
    if (present !== "1" || !validateInteger(bytesRaw) || !validateDigest(digest)
        || !validateInteger(uidRaw) || !validateInteger(gidRaw) || !/^[0-7]{3,4}$/.test(modeRaw)) {
      fail(`external model ${token} metadata is invalid`);
    }
    const stat = assertSecureFile(source, `external model ${token} snapshot`);
    const bytes = Number(bytesRaw);
    if (stat.size !== bytes || sha256File(source) !== digest) fail(`external model ${token} snapshot hash mismatch`);
    try {
      JSON.parse(fs.readFileSync(source, "utf8"));
    } catch (error) {
      fail(`external model ${token} snapshot is not valid JSON: ${error.message}`);
    }
    entries.set(token, {
      token,
      target,
      present: true,
      source,
      bytes,
      digest,
      uid: Number(uidRaw),
      gid: Number(gidRaw),
      mode: Number.parseInt(modeRaw, 8)
    });
  }
  return { dir, entries };
};

const loadTransaction = () => {
  const recoveryRoot = hostPath(RECOVERY_ROOT_PATH);
  assertSecureDirectory(recoveryRoot, "release recovery root");
  const currentDir = hostPath(RECOVERY_CURRENT_PATH);
  if (!pathExistsNoFollow(currentDir)) return null;
  assertSecureDirectory(currentDir, "current release recovery transaction");
  const version = readSingleLine(path.join(currentDir, "transaction-version"), "transaction version");
  if (version !== String(TRANSACTION_VERSION)) fail(`unsupported transaction version: ${version}`);
  const bundleSha = readSingleLine(path.join(currentDir, "bundle-sha256"), "transaction bundle sha256");
  if (!/^[0-9a-f]{64}$/.test(bundleSha)) fail("transaction bundle sha256 is invalid");
  const site = readSingleLine(path.join(currentDir, "site"), "transaction site");
  const channel = readSingleLine(path.join(currentDir, "channel"), "transaction channel");
  const releaseSequence = readSingleLine(path.join(currentDir, "release-sequence"), "transaction release sequence");
  const phase = readSingleLine(path.join(currentDir, "phase"), "transaction phase");
  if (!validateName(site) || !validateName(channel) || !validateInteger(releaseSequence) || Number(releaseSequence) <= 0) {
    fail("transaction identity metadata is invalid");
  }
  const expectedSite = readSingleLine(hostPath(EXPECTED_SITE_PATH), "expected site");
  const expectedChannel = readSingleLine(hostPath(EXPECTED_CHANNEL_PATH), "expected channel");
  if (site !== expectedSite || channel !== expectedChannel) fail("transaction site or channel does not match fixed host identity");
  if (!ROLLBACK_PHASES.has(phase) && !FORWARD_PHASES.has(phase)) fail(`unknown recovery phase: ${phase}`);
  const oldIdentity = loadIdentity(currentDir, "old-app", true);
  const newIdentityRequired = NEW_IDENTITY_REQUIRED_PHASES.has(phase) || FORWARD_PHASES.has(phase);
  const newIdentity = loadIdentity(currentDir, "new-app", false);
  let rollbackAlreadyOnOldTree = false;
  if (!newIdentity && newIdentityRequired) {
    // A rollback can already have converged the application tree before a
    // later restore step fails. In that state the disposable candidate and
    // its identity may both be gone while phase records recovery in progress.
    // Resume only when the complete managed topology is the recorded old APP
    // with no NEXT/BACKUP/FAILED tree. inspectTopology below still validates
    // the recorded markers before any mutation. Forward recovery must always
    // retain the candidate identity.
    rollbackAlreadyOnOldTree = ROLLBACK_PHASES.has(phase)
      && !FORWARD_PHASES.has(phase)
      && treeMatchesRecordedIdentityMetadata(APP_PATH, oldIdentity)
      && !pathExistsNoFollow(hostPath(NEXT_PATH))
      && !pathExistsNoFollow(hostPath(BACKUP_PATH))
      && !pathExistsNoFollow(hostPath(FAILED_PATH));
    if (!rollbackAlreadyOnOldTree) fail("required new-app app identity is missing");
  }
  const runtimeEnv = loadRuntimeEnvSnapshot(currentDir);
  const config = loadConfigSnapshot(currentDir);
  const sqliteSnapshotPresent = pathExistsNoFollow(path.join(currentDir, "sqlite"));
  const modelSnapshotPresent = pathExistsNoFollow(path.join(currentDir, "external-model-artifacts"));
  const convergedPreSnapshotRollback = !newIdentity
    && rollbackAlreadyOnOldTree
    && ["recovering-rollback", "rolled-back"].includes(phase);
  if (sqliteSnapshotPresent && !modelSnapshotPresent) {
    fail("sqlite rollback snapshot exists without its preceding model snapshot");
  }
  const sqlite = SQLITE_REQUIRED_PHASES.has(phase)
    ? (sqliteSnapshotPresent
        ? loadSqliteSnapshot(currentDir)
        : (convergedPreSnapshotRollback ? null : loadSqliteSnapshot(currentDir)))
    : null;
  const model = MODEL_REQUIRED_PHASES.has(phase)
    ? (modelSnapshotPresent
        ? loadModelSnapshot(currentDir)
        : (convergedPreSnapshotRollback ? null : loadModelSnapshot(currentDir)))
    : null;
  return {
    currentDir,
    recoveryRoot,
    bundleSha,
    site,
    channel,
    releaseSequence,
    phase,
    oldIdentity,
    newIdentity,
    runtimeEnv,
    config,
    sqlite,
    model
  };
};

const readTreeMarker = (treePath, name) => {
  const markerPath = path.join(treePath, name);
  const stat = lstatOrNull(markerPath);
  if (!stat) return "-";
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(`managed app marker is unsafe: ${productionPath(markerPath)}`);
  }
  if (!TEST_MODE) {
    const expectedMode = name === ".release-tree-identity" ? 0o600 : 0o644;
    if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== expectedMode) {
      fail(`managed app marker ownership or mode is unsafe: ${productionPath(markerPath)}`);
    }
  }
  const value = readSingleLine(markerPath, `managed app marker ${name}`);
  if (!validateDigest(value)) fail(`managed app marker is malformed: ${productionPath(markerPath)}`);
  return value;
};

const inspectTree = (absolutePath, oldIdentity, newIdentity, bundleSha, system) => {
  const mapped = hostPath(absolutePath);
  const stat = lstatOrNull(mapped, { bigint: true });
  if (!stat) return { absolutePath, mapped, kind: "absent" };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`managed app path is not a real directory: ${absolutePath}`);
  if (system.isMountpoint(mapped)) fail(`managed app path is a mountpoint: ${absolutePath}`);
  const parent = fs.lstatSync(path.dirname(mapped), { bigint: true });
  if (stat.dev !== parent.dev) fail(`managed app path crosses a filesystem boundary: ${absolutePath}`);
  const matches = (identity) => identity && stat.dev === identity.dev && stat.ino === identity.ino;
  let kind = "unknown";
  if (matches(oldIdentity)) kind = "old";
  if (matches(newIdentity)) kind = kind === "unknown" ? "new" : fail(`app tree matches both identities: ${absolutePath}`);
  if (kind === "unknown") fail(`managed app path has an unknown identity: ${absolutePath}`);
  const identity = kind === "old" ? oldIdentity : newIdentity;
  if (stat.uid !== BigInt(identity.uid) || stat.gid !== BigInt(identity.gid)
      || (stat.mode & 0o7777n) !== BigInt(identity.mode)) {
    fail(`managed app path ownership or mode changed from its recorded identity: ${absolutePath}`);
  }
  const markers = {
    treeMarker: readTreeMarker(mapped, ".release-tree-identity"),
    bundleMarker: readTreeMarker(mapped, ".release-bundle-sha256"),
    liveMarker: readTreeMarker(mapped, ".release-live-complete")
  };
  for (const [field, value] of Object.entries(markers)) {
    if (field === "treeMarker") {
      if (value !== identity.treeMarker) fail(`managed app ${field} changed from its recorded identity: ${absolutePath}`);
      continue;
    }
    const allowed = kind === "old" ? new Set([identity[field]]) : new Set([identity[field], bundleSha]);
    if (!allowed.has(value)) fail(`managed app ${field} changed to an unexpected value: ${absolutePath}`);
  }
  return { absolutePath, mapped, kind, stat };
};

const inspectTopology = (transaction, system) => {
  const result = {};
  for (const [key, absolutePath] of Object.entries({ app: APP_PATH, backup: BACKUP_PATH, failed: FAILED_PATH })) {
    result[key] = inspectTree(absolutePath, transaction.oldIdentity, transaction.newIdentity, transaction.bundleSha, system);
  }
  return result;
};

const assertRealDirectory = (mappedPath, label, { optional = false } = {}) => {
  const stat = lstatOrNull(mappedPath);
  if (!stat) {
    if (optional) return null;
    fail(`${label} is missing: ${productionPath(mappedPath)}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is not a real directory: ${productionPath(mappedPath)}`);
  return stat;
};

const rejectDirectoryOrSymlinkTarget = (mappedPath, label, { allowSymlink = false } = {}) => {
  const stat = lstatOrNull(mappedPath);
  if (!stat) return;
  if (stat.isDirectory() || (!allowSymlink && stat.isSymbolicLink())) {
    fail(`${label} has an unsafe target type: ${productionPath(mappedPath)}`);
  }
};

const prevalidateRestoreTargets = (transaction) => {
  const envTarget = hostPath(RUNTIME_ENV_PATH);
  const envParent = path.dirname(envTarget);
  const envParentStat = assertRealDirectory(envParent, "runtime env parent", { optional: !transaction.runtimeEnv.present });
  if (envParentStat) rejectDirectoryOrSymlinkTarget(envTarget, "runtime env");

  for (const entry of transaction.config.entries) {
    const target = hostPath(entry.target);
    assertRealDirectory(path.dirname(target), `managed config parent for ${entry.target}`);
    rejectDirectoryOrSymlinkTarget(target, `managed config ${entry.target}`, { allowSymlink: true });
  }

  if (transaction.sqlite) {
    const store = hostPath(STORE_PATH);
    assertRealDirectory(store, "sqlite store directory");
    const requiredBytes = [...transaction.sqlite.entries.values()]
      .filter((entry) => entry.present)
      .reduce((sum, entry) => sum + BigInt(entry.bytes), 0n);
    const filesystem = fs.statfsSync(store, { bigint: true });
    const availableBytes = filesystem.bavail * filesystem.bsize;
    const safetyMargin = 16n * 1024n * 1024n;
    if (availableBytes < (requiredBytes * 2n) + safetyMargin) {
      fail("insufficient free space to stage the sqlite rollback snapshot safely");
    }
    for (const suffix of SQLITE_TOKENS.values()) {
      rejectDirectoryOrSymlinkTarget(hostPath(`${SQLITE_PATH}${suffix}`), `sqlite${suffix || " base"}`);
    }
  }

  if (transaction.model) {
    for (const entry of transaction.model.entries.values()) {
      const target = hostPath(entry.target);
      const parentStat = assertRealDirectory(path.dirname(target), `model artifact parent for ${entry.target}`, {
        optional: !entry.present
      });
      if (parentStat) rejectDirectoryOrSymlinkTarget(target, `model artifact ${entry.target}`);
    }
  }
};

const assertPreSwapTopology = (topology) => {
  if (topology.app.kind !== "old" || topology.backup.kind !== "absent" || topology.failed.kind !== "absent") {
    fail("pre-swap transaction has an unexpected APP/BACKUP/FAILED topology");
  }
};

const restoreOldTree = (transaction, system) => {
  let topology = inspectTopology(transaction, system);
  if (PRE_SWAP_PHASES.has(transaction.phase)) {
    assertPreSwapTopology(topology);
    return topology;
  }
  if (topology.app.kind === "old") {
    if (topology.backup.kind !== "absent") fail("old APP is active while BACKUP is unexpectedly present");
    if (!["absent", "new"].includes(topology.failed.kind)) fail("FAILED has an unexpected identity after rollback");
    return topology;
  }
  if (topology.backup.kind !== "old") fail("restorable old APP identity is not in APP or BACKUP");
  if (topology.app.kind === "new") {
    if (topology.failed.kind !== "absent") fail("cannot move new APP because FAILED is already occupied");
    fs.renameSync(topology.app.mapped, topology.failed.mapped);
    fsyncPath(path.dirname(topology.app.mapped));
  } else if (topology.app.kind !== "absent") {
    fail("APP has an unsafe identity during rollback");
  }
  topology = inspectTopology(transaction, system);
  if (topology.app.kind !== "absent" || topology.backup.kind !== "old") fail("tree state changed unexpectedly before BACKUP activation");
  fs.renameSync(topology.backup.mapped, topology.app.mapped);
  fsyncPath(path.dirname(topology.app.mapped));
  topology = inspectTopology(transaction, system);
  if (topology.app.kind !== "old" || topology.backup.kind !== "absent") fail("old APP activation did not converge");
  return topology;
};

const updatePhase = (transaction, phase) => {
  const target = path.join(transaction.currentDir, "phase");
  const temp = path.join(transaction.currentDir, `.phase.recover.${process.pid}.${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(temp, `${phase}\n`, { mode: 0o600, flag: "wx" });
  if (!TEST_MODE) fs.chownSync(temp, 0, 0);
  fsyncPath(temp);
  fs.renameSync(temp, target);
  fsyncPath(transaction.currentDir);
  transaction.phase = phase;
};

const restoreRuntimeEnv = (snapshot) => {
  const target = hostPath(RUNTIME_ENV_PATH);
  const parent = path.dirname(target);
  if (snapshot.present) {
    if (!lstatOrNull(parent)?.isDirectory() || fs.lstatSync(parent).isSymbolicLink()) {
      fail("runtime env parent is unsafe during restore");
    }
    atomicWriteFileFromSnapshot(snapshot.source, target, snapshot);
  } else {
    if (lstatOrNull(target)?.isDirectory()) fail("runtime env target became a directory");
    fs.rmSync(target, { force: true });
    fsyncPath(parent);
  }
  if (snapshot.parentState === "present") {
    if (!lstatOrNull(parent)?.isDirectory() || fs.lstatSync(parent).isSymbolicLink()) {
      fail("original runtime env parent cannot be restored");
    }
    fs.chmodSync(parent, snapshot.parentMetadata.mode);
    if (!TEST_MODE) fs.chownSync(parent, snapshot.parentMetadata.uid, snapshot.parentMetadata.gid);
    fsyncPath(parent);
  } else if (pathExistsNoFollow(parent)) {
    const entries = fs.readdirSync(parent);
    if (entries.length !== 0) fail("runtime env parent was originally absent but is not empty");
    fs.rmdirSync(parent);
    fsyncPath(path.dirname(parent));
  }
};

const restoreConfig = (snapshot, system) => {
  for (const entry of snapshot.entries) {
    const target = hostPath(entry.target);
    const parent = path.dirname(target);
    if (!lstatOrNull(parent)?.isDirectory() || fs.lstatSync(parent).isSymbolicLink()) {
      fail(`managed config parent is unsafe: ${entry.target}`);
    }
    if (entry.type === "absent") {
      if (lstatOrNull(target)?.isDirectory()) fail(`managed config target became a directory: ${entry.target}`);
      fs.rmSync(target, { force: true });
      fsyncPath(parent);
    } else if (entry.type === "file") {
      atomicWriteFileFromSnapshot(entry.source, target, entry);
    } else {
      if (lstatOrNull(target)?.isDirectory()) fail(`managed config symlink target became a directory: ${entry.target}`);
      const temp = path.join(parent, `.${path.basename(target)}.recover.${process.pid}.${crypto.randomBytes(4).toString("hex")}`);
      fs.symlinkSync(entry.linkTarget, temp);
      fs.renameSync(temp, target);
      fsyncPath(parent);
    }
  }
  system.daemonReload();
  const nginxState = snapshot.units.find((entry) => entry.name === "nginx.service");
  system.validateAndReloadNginx(Boolean(nginxState?.active));
};

const restoreSqlite = (snapshot) => {
  const parent = hostPath(STORE_PATH);
  if (!lstatOrNull(parent)?.isDirectory() || fs.lstatSync(parent).isSymbolicLink()) {
    fail("sqlite store directory is unsafe");
  }
  const staged = [];
  for (const entry of snapshot.entries.values()) {
    if (!entry.present) continue;
    const target = hostPath(`${SQLITE_PATH}${entry.suffix}`);
    const temp = `${target}.recover.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    fs.copyFileSync(entry.source, temp, fs.constants.COPYFILE_EXCL);
    if (fs.lstatSync(temp).size !== entry.bytes || sha256File(temp) !== entry.digest) fail(`sqlite ${entry.token} restore staging hash mismatch`);
    fs.chmodSync(temp, entry.mode);
    if (!TEST_MODE) fs.chownSync(temp, entry.uid, entry.gid);
    fsyncPath(temp);
    staged.push({ entry, target, temp });
  }
  for (const suffix of SQLITE_TOKENS.values()) fs.rmSync(hostPath(`${SQLITE_PATH}${suffix}`), { force: true });
  for (const item of staged) fs.renameSync(item.temp, item.target);
  fsyncPath(parent);
};

const restoreModelArtifacts = (snapshot) => {
  for (const entry of snapshot.entries.values()) {
    const target = hostPath(entry.target);
    const parent = path.dirname(target);
    if (!lstatOrNull(parent)?.isDirectory() || fs.lstatSync(parent).isSymbolicLink()) {
      if (!entry.present && !pathExistsNoFollow(parent)) continue;
      fail(`model artifact parent is unsafe: ${entry.target}`);
    }
    if (entry.present) atomicWriteFileFromSnapshot(entry.source, target, entry);
    else {
      if (lstatOrNull(target)?.isDirectory()) fail(`model artifact target became a directory: ${entry.target}`);
      fs.rmSync(target, { force: true });
      fsyncPath(parent);
    }
  }
};

const quiesceAll = (transaction, system) => {
  system.stopTransientUnits(transaction.bundleSha);
  for (const unit of [...MAINTENANCE_UNITS, ...RUNTIME_UNITS]) system.stop(unit);
  system.killDedicatedUserProcesses();
};

const restoreUnitStates = (snapshot, system) => {
  for (const state of snapshot.units) {
    if (state.name === "nginx.service") continue;
    system.setEnabled(state.name, state.enabled);
    if (state.active) system.start(state.name);
    else system.stop(state.name);
  }
};

const restoreTimerStates = (snapshot, system) => {
  for (const state of snapshot.timers) {
    system.setEnabled(state.name, state.enabled);
    if (state.active) system.start(state.name);
    else system.stop(state.name);
  }
};

const isolateKnownFailedTree = (transaction, system) => {
  const topology = inspectTopology(transaction, system);
  if (topology.failed.kind === "absent") return;
  if (topology.failed.kind !== "new" || topology.app.kind !== "old" || topology.backup.kind !== "absent") {
    fail("cannot isolate FAILED because the recovered app topology is no longer exact");
  }
  const quarantine = path.join(
    path.dirname(topology.failed.mapped),
    `.football-predict.failed-resolved.${transaction.bundleSha.slice(0, 12)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`
  );
  if (pathExistsNoFollow(quarantine)) fail("FAILED quarantine path unexpectedly exists");
  fs.renameSync(topology.failed.mapped, quarantine);
  fsyncPath(path.dirname(topology.failed.mapped));
  if (TEST_MODE) {
    fs.rmSync(quarantine, { recursive: true, force: true });
  } else {
    system.run("rm", ["-rf", "--one-file-system", "--", quarantine], { allowFailure: true });
  }
  fsyncPath(path.dirname(quarantine));
};

const resolveTransaction = (transaction) => {
  const resolved = path.join(transaction.recoveryRoot, `.resolved.${transaction.bundleSha.slice(0, 12)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`);
  fs.renameSync(transaction.currentDir, resolved);
  fsyncPath(transaction.recoveryRoot);
  fs.rmSync(resolved, { recursive: true, force: true });
  fsyncPath(transaction.recoveryRoot);
};

const recoverRollback = (transaction, system) => {
  prevalidateRestoreTargets(transaction);
  updatePhase(transaction, "recovering-rollback");
  quiesceAll(transaction, system);
  restoreOldTree(transaction, system);
  if (transaction.sqlite) restoreSqlite(transaction.sqlite);
  if (transaction.model) restoreModelArtifacts(transaction.model);
  restoreRuntimeEnv(transaction.runtimeEnv);
  restoreConfig(transaction.config, system);
  // The live worker intentionally remains available during the long isolated
  // build. Its generation pointer may therefore advance after the rollback
  // SQLite snapshot was captured. Re-export from the restored app against the
  // current serving generation before any runtime unit is restarted.
  if (transaction.sqlite) system.rebuildSqliteForServingGeneration();
  restoreUnitStates(transaction.config, system);
  const appState = transaction.config.units.find((entry) => entry.name === "football-predict.service");
  if (!appState?.active) fail("original application service was not active; automatic recovery is not authorized");
  system.waitForHealth();
  restoreTimerStates(transaction.config, system);
  isolateKnownFailedTree(transaction, system);
  updatePhase(transaction, "rolled-back");
  resolveTransaction(transaction);
  return { action: "rollback", bundleSha256: transaction.bundleSha, phase: "rolled-back" };
};

const recoverForward = (transaction, system) => {
  const topology = inspectTopology(transaction, system);
  if (topology.app.kind !== "new" || topology.backup.kind !== "old" || topology.failed.kind !== "absent") {
    fail("committed transaction topology is not the expected new APP plus old BACKUP");
  }
  for (const marker of [".release-bundle-sha256", ".release-live-complete"]) {
    const markerPath = path.join(topology.app.mapped, marker);
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || readSingleLine(markerPath, marker) !== transaction.bundleSha) {
      fail(`committed transaction marker is invalid: ${marker}`);
    }
  }
  updatePhase(transaction, "recovering-commit");
  system.stopTransientUnits(transaction.bundleSha);
  system.daemonReload();
  const nginxState = transaction.config.units.find((entry) => entry.name === "nginx.service");
  system.validateAndReloadNginx(Boolean(nginxState?.active));
  system.setEnabled("football-predict.service", true);
  system.start("football-predict.service");
  system.setEnabled("football-sync-worker.service", true);
  system.start("football-sync-worker.service");
  system.waitForHealth();
  for (const timer of TIMER_UNITS) {
    system.setEnabled(timer, true);
    system.start(timer);
  }
  updatePhase(transaction, "committed");
  resolveTransaction(transaction);
  return { action: "commit", bundleSha256: transaction.bundleSha, phase: "committed" };
};

const recover = () => {
  const system = new SystemAdapter();
  const transaction = loadTransaction();
  if (!transaction) {
    const app = hostPath(APP_PATH);
    const appStat = lstatOrNull(app);
    if (!appStat?.isDirectory() || appStat.isSymbolicLink()) {
      fail("no recovery transaction exists and APP is unavailable");
    }
    if (!system.isActive("football-predict.service")) fail("no recovery transaction exists and application service is inactive");
    system.waitForHealth();
    return { action: "noop", bundleSha256: null, phase: null };
  }
  const topology = inspectTopology(transaction, system);
  if (PRE_SWAP_PHASES.has(transaction.phase)) assertPreSwapTopology(topology);
  if (FORWARD_PHASES.has(transaction.phase)) return recoverForward(transaction, system);
  return recoverRollback(transaction, system);
};

const main = () => {
  try {
    const result = recover();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const exitCode = error instanceof RecoveryError ? error.exitCode : 1;
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message || String(error), exitCode })}\n`);
    process.exitCode = exitCode;
  }
};

if (require.main === module) main();

module.exports = {
  FORWARD_PHASES,
  PRE_SWAP_PHASES,
  ROLLBACK_PHASES,
  RecoveryError,
  inspectTopology,
  loadTransaction,
  recover
};
