"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
const KEYS = Object.freeze(["node", "v8", "platform", "arch", "timezone", "executableSha256"]);
let executableIdentity;
function executableHash() {
  if (executableIdentity !== undefined) return executableIdentity;
  let fd;
  try {
    // Linux /proc binds the running image even if its old path was replaced.
    fd = fs.openSync(process.platform === "linux" ? "/proc/self/exe" : process.execPath, "r");
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 256 * 1024 * 1024) throw new Error("unbounded executable");
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let bytes = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, count)); bytes += count; }
    const after = fs.fstatSync(fd);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("executable changed during identity read");
    executableIdentity = hash.digest("hex");
  } catch { executableIdentity = null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return executableIdentity;
}
function predictionRuntimeIdentity() {
  return { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, executableSha256: executableHash() };
}
function completeRuntimeIdentity(value) {
  return Boolean(value && KEYS.every(key => typeof value[key] === "string" && value[key].length > 0)
    && /^[a-f0-9]{64}$/.test(value.executableSha256));
}
function comparePredictionRuntimes(captured, current) {
  const complete = completeRuntimeIdentity(captured) && completeRuntimeIdentity(current);
  const mismatches = KEYS.filter(key => captured?.[key] !== current?.[key]);
  return { complete, compatible: complete && mismatches.length === 0, mismatches,
    reason: !complete ? "runtime-identity-incomplete" : mismatches.length ? "runtime-identity-mismatch" : "runtime-identity-match" };
}
module.exports = { KEYS, predictionRuntimeIdentity, completeRuntimeIdentity, comparePredictionRuntimes };
