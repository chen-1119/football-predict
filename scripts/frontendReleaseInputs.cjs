"use strict";

// Preparation is not authorization. The fixed server controller reattests the
// original archive, installed runtime, policies, build and acceptance at apply.
const crypto = require("node:crypto");
const { parseJson, validateRuntimeBinding } = require("./createFrontendReleaseBundle.cjs");
const { parseFrontendReleaseState, validateFrontendAcceptanceReceipt } = require("../server/frontendReleaseIdentity.cjs");
const VERSION = "frontend-release-inputs-v1";
const LIMITS = Object.freeze({ "frontend-state.json": 8192, "frontend-runtime-binding.json": 16384, "frontend-acceptance.json": 10240 });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function requireThat(value, reason) { if (!value) throw new Error(reason); }
function parseStatus(bytes, expectedSha, expectedSequence) {
  const fields = {};
  for (const line of bytes.toString("utf8").trim().split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9]*)=([^\r\n]*)$/.exec(line);
    requireThat(m && !Object.hasOwn(fields, m[1]), "frontend-input-status-malformed"); fields[m[1]] = m[2];
  }
  const allowed = ["status", "ok", "startedAt", "finishedAt", "exitCode", "bundleSha256", "releaseKind", "releaseSequence"];
  requireThat(Object.keys(fields).length === allowed.length && Object.keys(fields).every(k => allowed.includes(k)), "frontend-input-status-fields");
  requireThat(fields.status === "complete" && fields.ok === "1" && fields.exitCode === "0" && fields.releaseKind === "full"
    && fields.bundleSha256 === expectedSha && fields.releaseSequence === String(expectedSequence), "frontend-input-full-runtime-incomplete");
  const time = s => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === (s.length === 20 ? s.replace("Z", ".000Z") : s);
  requireThat(time(fields.startedAt) && time(fields.finishedAt) && Date.parse(fields.finishedAt) >= Date.parse(fields.startedAt), "frontend-input-status-time");
  return fields;
}
function validateObservation(observation, baseline, now = Date.now()) {
  requireThat(observation?.version === VERSION && observation.stable === true && observation.recoveryPending === false, "frontend-input-observation-unavailable");
  const age = now - Date.parse(observation.observedAt);
  requireThat(Number.isFinite(age) && age >= -5000 && age <= 60000, "frontend-input-observation-stale");
  requireThat(observation.runtimeSha256 === baseline.sha256 && observation.runtimeSequence === baseline.releaseSequence, "frontend-input-runtime-target-mismatch");
  requireThat(observation.marker === baseline.sha256 && observation.liveComplete === baseline.sha256, "frontend-input-runtime-markers-mismatch");
  requireThat(observation.raw && JSON.stringify(Object.keys(observation.raw).sort()) === JSON.stringify(Object.keys(LIMITS).sort()), "frontend-input-artifact-set");
  const bytes = {};
  for (const [name, maximum] of Object.entries(LIMITS)) {
    const row = observation.raw[name];
    requireThat(row && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= maximum && typeof row.base64 === "string"
      && row.base64.length <= Math.ceil(maximum / 3) * 4, "frontend-input-artifact-size");
    const raw = Buffer.from(row.base64, "base64");
    requireThat(raw.toString("base64") === row.base64 && raw.length === row.bytes && hash(raw) === row.sha256, "frontend-input-artifact-integrity"); bytes[name] = raw;
  }
  const state = parseFrontendReleaseState(bytes["frontend-state.json"]);
  requireThat(state.phase === "accepted" && state.runtimeSha256 === baseline.sha256 && state.runtimeSequence === baseline.releaseSequence, "frontend-input-state-not-accepted");
  validateFrontendAcceptanceReceipt(bytes["frontend-acceptance.json"], state);
  const binding = validateRuntimeBinding(parseJson(bytes["frontend-runtime-binding.json"]), state, baseline);
  requireThat(observation.indexSha256 === state.indexSha256, "frontend-input-current-index-mismatch");
  requireThat(typeof observation.fullStatus === "string" && Buffer.byteLength(observation.fullStatus) <= 4096, "frontend-input-status-size");
  parseStatus(Buffer.from(observation.fullStatus), baseline.sha256, baseline.releaseSequence);
  return { state, binding, bytes, stateSha256: hash(bytes["frontend-state.json"]), bindingSha256: hash(bytes["frontend-runtime-binding.json"]) };
}

// Serialized unchanged; only Node built-ins execute on the host. No loaded
// application/candidate code, HTTP request, provider request or remote writes.
function observeRemote(target) {
  const fs = require("node:fs"), crypto = require("node:crypto");
  const fail = reason => { throw new Error(reason); };
  if (!/^[a-f0-9]{64}$/.test(target.sha256) || !Number.isSafeInteger(target.sequence) || target.sequence < 1) fail("frontend-input-target-invalid");
  const seen = new Map(), missing = [], start = Date.now();
  const stamp = s => [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
  const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  function directory(file) {
    for (let p = require("node:path").dirname(file);; p = require("node:path").dirname(p)) {
      const s = fs.lstatSync(p, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0n || (s.mode & 0o022n)) fail("frontend-input-unsafe-ancestor");
      // Directory content timestamps legitimately change during collection;
      // bind ancestor ownership/inode/mode, not unrelated sibling writes.
      const id = [s.dev,s.ino,s.mode,s.uid,s.gid].map(String).join(":");
      if (seen.has(p) && seen.get(p).identity !== id) fail("frontend-input-ancestor-drift");
      seen.set(p, { directory: true, identity: id }); if (p === "/") break;
    }
  }
  function read(file, max, mode) {
    directory(file); const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.uid !== 0n || (s.mode & 0o7777n) !== BigInt(mode)
      || s.size <= 0n || s.size > BigInt(max)) fail("frontend-input-unsafe-file");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s)) fail("frontend-input-open-drift");
      const buffer = Buffer.alloc(Number(s.size) + 1); let offset = 0, count;
      while (offset < buffer.length && (count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset))) offset += count;
      const raw = buffer.subarray(0, offset);
      if (raw.length !== Number(s.size) || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s)
        || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(s)) fail("frontend-input-read-drift");
      const old = seen.get(file); if (old && old.identity !== stamp(s)) fail("frontend-input-reread-drift");
      seen.set(file, { directory: false, identity: stamp(s) }); return raw;
    } finally { fs.closeSync(fd); }
  }
  const app = "/opt/football-predict", release = "/var/lib/football-release", raw = {};
  const recovery = release + "/recovery/current"; directory(recovery);
  try { fs.lstatSync(recovery); fail("frontend-input-recovery-pending"); } catch (e) { if (e.code !== "ENOENT") throw e; missing.push(recovery); }
  for (const [name, projection, max] of [["frontend-state.json", ".frontend-release-state.json", 8192], ["frontend-runtime-binding.json", ".frontend-release-binding.json", 16384]]) {
    const bytes = read(release + "/" + name, max, 0o600), published = read(app + "/" + projection, max, 0o644);
    if (!bytes.equals(published)) fail("frontend-input-root-projection-mismatch");
    raw[name] = { bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") };
  }
  const receipt = read(app + "/.frontend-release-acceptance.json", 10240, 0o644);
  raw["frontend-acceptance.json"] = { bytes: receipt.length, sha256: hash(receipt), base64: receipt.toString("base64") };
  const marker = read(app + "/.release-bundle-sha256", 65, 0o644).toString("ascii").trim();
  const liveComplete = read(app + "/.release-live-complete", 65, 0o644).toString("ascii").trim();
  const indexSha256 = hash(read(app + "/dist/index.html", 1024 * 1024, 0o644));
  const fullStatus = read(release + "/status/" + target.sha256 + ".status", 4096, 0o640).toString("utf8");
  for (const [file, row] of seen) {
    const s = fs.lstatSync(file, { bigint: true });
    const current = row.directory ? [s.dev,s.ino,s.mode,s.uid,s.gid].map(String).join(":") : stamp(s);
    if (current !== row.identity) fail("frontend-input-capture-drift");
  }
  for (const file of missing) { try { fs.lstatSync(file); fail("frontend-input-recovery-appeared"); } catch(e) { if(e.code !== "ENOENT") throw e; } }
  if (Date.now() - start > 10000) fail("frontend-input-observation-time-budget");
  return { version: "frontend-release-inputs-v1", observedAt: new Date().toISOString(), stable: true, recoveryPending: false,
    runtimeSha256: target.sha256, runtimeSequence: target.sequence, marker, liveComplete, indexSha256, fullStatus, raw };
}
module.exports = { VERSION, LIMITS, hash, parseStatus, validateObservation, observeRemote };
