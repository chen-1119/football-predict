const fs = require("node:fs");

const POLICY_VERSION = "release-live-sqlite-prebuild-policy-v2";
const MAX_HEARTBEAT_AGE_SECONDS = 600;
const MIN_MEM_AVAILABLE_ENV = "RELEASE_LIVE_SQLITE_PREBUILD_MIN_MEM_AVAILABLE_MIB";
const MAX_APP_MEMORY_ENV = "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_MEMORY_CURRENT_MIB";
const MAX_APP_WORKING_SET_ENV = "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_WORKING_SET_MIB";
const DEFAULT_MIN_MEM_AVAILABLE_MIB = 3072;
const DEFAULT_MAX_APP_MEMORY_CURRENT_MIB = 768;
const DEFAULT_MAX_APP_WORKING_SET_MIB = 512;

function parseBoundedInteger(raw, name, { min, max }) {
  const text = String(raw ?? "");
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${name} must be an unsigned base-10 integer`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function resolveCapacityLimits(env = process.env) {
  return {
    minMemAvailableMiB: parseBoundedInteger(
      Object.hasOwn(env, MIN_MEM_AVAILABLE_ENV)
        ? env[MIN_MEM_AVAILABLE_ENV]
        : DEFAULT_MIN_MEM_AVAILABLE_MIB,
      MIN_MEM_AVAILABLE_ENV,
      { min: DEFAULT_MIN_MEM_AVAILABLE_MIB, max: 65536 },
    ),
    maxAppMemoryCurrentMiB: parseBoundedInteger(
      Object.hasOwn(env, MAX_APP_MEMORY_ENV)
        ? env[MAX_APP_MEMORY_ENV]
        : DEFAULT_MAX_APP_MEMORY_CURRENT_MIB,
      MAX_APP_MEMORY_ENV,
      { min: 64, max: DEFAULT_MAX_APP_MEMORY_CURRENT_MIB },
    ),
    maxAppWorkingSetMiB: parseBoundedInteger(
      Object.hasOwn(env, MAX_APP_WORKING_SET_ENV)
        ? env[MAX_APP_WORKING_SET_ENV]
        : DEFAULT_MAX_APP_WORKING_SET_MIB,
      MAX_APP_WORKING_SET_ENV,
      { min: 64, max: DEFAULT_MAX_APP_WORKING_SET_MIB },
    ),
  };
}

function parseMemAvailableKiB(meminfoText) {
  const matches = String(meminfoText ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^MemAvailable:\s+([0-9]+)\s+kB\s*$/))
    .filter(Boolean);
  if (matches.length !== 1) {
    throw new Error("/proc/meminfo must contain exactly one numeric MemAvailable kB row");
  }
  return BigInt(matches[0][1]);
}

function parseByteCount(raw, name) {
  const text = String(raw ?? "");
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${name} must be an unsigned base-10 byte count`);
  }
  return BigInt(text);
}

function evaluateCapacity({
  meminfoText,
  appMemoryCurrentBytes,
  appInactiveFileBytes,
  env = process.env,
}) {
  const limits = resolveCapacityLimits(env);
  const memAvailableKiB = parseMemAvailableKiB(meminfoText);
  const appBytes = parseByteCount(appMemoryCurrentBytes, "app MemoryCurrent");
  const inactiveFileBytes = parseByteCount(appInactiveFileBytes, "app inactive_file");
  if (inactiveFileBytes > appBytes) {
    throw new Error("app inactive_file must not exceed app MemoryCurrent");
  }
  // cgroup v2 MemoryCurrent includes file pages charged while the service
  // verifies immutable generations and queries the SQLite read model.  Those
  // inactive_file is the standard cgroup working-set proxy, not a promise that
  // every page can be reclaimed immediately (the service also has MemoryLow).
  // Keep a strict raw ceiling while applying the original 512 MiB ceiling to
  // that proxy. Host MemAvailable remains an independent hard gate.
  const appWorkingSetBytes = appBytes - inactiveFileBytes;
  const minMemAvailableKiB = BigInt(limits.minMemAvailableMiB) * 1024n;
  const maxAppMemoryCurrentBytes = BigInt(limits.maxAppMemoryCurrentMiB) * 1024n * 1024n;
  const maxAppWorkingSetBytes = BigInt(limits.maxAppWorkingSetMiB) * 1024n * 1024n;
  const hostReady = memAvailableKiB >= minMemAvailableKiB;
  const appMemoryCurrentReady = appBytes <= maxAppMemoryCurrentBytes;
  const appWorkingSetReady = appWorkingSetBytes <= maxAppWorkingSetBytes;
  const appReady = appMemoryCurrentReady && appWorkingSetReady;
  return {
    version: POLICY_VERSION,
    ok: hostReady && appReady,
    hostReady,
    appReady,
    memAvailableKiB: memAvailableKiB.toString(),
    minMemAvailableMiB: limits.minMemAvailableMiB,
    appMemoryCurrentBytes: appBytes.toString(),
    appInactiveFileBytes: inactiveFileBytes.toString(),
    appWorkingSetBytes: appWorkingSetBytes.toString(),
    maxAppMemoryCurrentMiB: limits.maxAppMemoryCurrentMiB,
    maxAppWorkingSetMiB: limits.maxAppWorkingSetMiB,
    appMemoryCurrentReady,
    appWorkingSetReady,
  };
}

function evaluateFreshness({
  refreshedAtEpochSeconds,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds,
  phase,
}) {
  const refreshedAt = parseBoundedInteger(
    refreshedAtEpochSeconds,
    "heartbeat refreshed-at epoch seconds",
    { min: 1, max: Number.MAX_SAFE_INTEGER },
  );
  const now = parseBoundedInteger(nowEpochSeconds, "current epoch seconds", {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  const maxAge = parseBoundedInteger(maxAgeSeconds, "heartbeat maximum age seconds", {
    min: 1,
    max: MAX_HEARTBEAT_AGE_SECONDS,
  });
  const normalizedPhase = String(phase ?? "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(normalizedPhase)) {
    throw new Error("freshness phase must be a bounded lowercase token");
  }
  const ageSeconds = now - refreshedAt;
  const ok = ageSeconds >= 0 && ageSeconds <= maxAge;
  return {
    version: POLICY_VERSION,
    ok,
    phase: normalizedPhase,
    refreshedAtEpochSeconds: refreshedAt,
    nowEpochSeconds: now,
    ageSeconds,
    maxAgeSeconds: maxAge,
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!/^--[a-z0-9-]+$/.test(key || "") || value === undefined || args.has(key)) {
      throw new Error("release prebuild policy received malformed or duplicate arguments");
    }
    args.set(key, value);
  }
  return { command, args };
}

function requireExactArgs(args, expected) {
  if (args.size !== expected.length || expected.some((key) => !args.has(key))) {
    throw new Error(`release prebuild policy requires exactly: ${expected.join(" ")}`);
  }
}

function main(argv = process.argv.slice(2), env = process.env) {
  const { command, args } = parseArgs(argv);
  let result;
  if (command === "capacity") {
    requireExactArgs(args, ["--app-memory-current-bytes", "--app-inactive-file-bytes"]);
    result = evaluateCapacity({
      meminfoText: fs.readFileSync("/proc/meminfo", "utf8"),
      appMemoryCurrentBytes: args.get("--app-memory-current-bytes"),
      appInactiveFileBytes: args.get("--app-inactive-file-bytes"),
      env,
    });
  } else if (command === "freshness") {
    requireExactArgs(args, ["--refreshed-at-epoch-seconds", "--max-age-seconds", "--phase"]);
    result = evaluateFreshness({
      refreshedAtEpochSeconds: args.get("--refreshed-at-epoch-seconds"),
      maxAgeSeconds: args.get("--max-age-seconds"),
      phase: args.get("--phase"),
    });
  } else {
    throw new Error("release prebuild policy command must be capacity or freshness");
  }
  if (!result.ok) {
    throw new Error(`release prebuild ${command} gate rejected: ${JSON.stringify(result)}`);
  }
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_MAX_APP_MEMORY_CURRENT_MIB,
  DEFAULT_MAX_APP_WORKING_SET_MIB,
  DEFAULT_MIN_MEM_AVAILABLE_MIB,
  MAX_APP_MEMORY_ENV,
  MAX_APP_WORKING_SET_ENV,
  MAX_HEARTBEAT_AGE_SECONDS,
  MIN_MEM_AVAILABLE_ENV,
  POLICY_VERSION,
  evaluateCapacity,
  evaluateFreshness,
  parseBoundedInteger,
  parseMemAvailableKiB,
  resolveCapacityLimits,
};
