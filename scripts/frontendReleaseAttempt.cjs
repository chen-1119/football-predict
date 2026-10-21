"use strict";

// Fixed root evidence for one signed frontend invocation. A source SHA is not
// an attempt identity: a retry needs a new signed sequence and a new build.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const signingTrust = require("./releaseSigningTrust.cjs");
const INSTALL = "/usr/local/libexec/football-release-frontend", RELEASE = "/var/lib/football-release", APP = "/opt/football-predict";
const ROOT = RELEASE + "/frontend-attempts", VERSION = "frontend-release-attempt-v1";
const HASH = /^[a-f0-9]{64}$/, LIMIT = 32 * 1024 * 1024, BUNDLE_LIMIT = 512 * 1024 * 1024;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const json = value => Buffer.from(JSON.stringify(value) + "\n");
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const fail = reason => { throw new Error(reason); };
const identity = s => [s.dev, s.ino, s.size, s.mode, s.uid, s.gid, s.nlink, s.mtimeNs, s.ctimeNs].map(String).join(":");
function target(context, logical) { return context.at(logical); }
function directory(context, filename) {
  for (let item = filename; ; item = path.dirname(item)) {
    const s = fs.lstatSync(item);
    if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(item) !== path.resolve(item) || s.uid !== context.uid ||
      !context.windows && (s.mode & 0o7022)) fail("unsafe-attempt-directory");
    if (item === context.boundary) break;
    if (item === path.dirname(item)) fail("attempt-boundary-unreachable");
  }
}
function observe(context, filename, limit, optional = false, mode = null) {
  directory(context, path.dirname(filename));
  let before; try { before = fs.lstatSync(filename, { bigint: true }); } catch (e) { if (optional && e.code === "ENOENT") return null; throw e; }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(context.uid) || before.nlink !== 1n ||
    !context.windows && ((before.mode & 0o7022n) || mode !== null && (before.mode & 0o7777n) !== BigInt(mode)) ||
    before.size > BigInt(limit)) fail("unsafe-attempt-file");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(before)) fail("attempt-open-drift");
    const h = crypto.createHash("sha256"), chunks = []; let offset = 0;
    while (offset < Number(before.size)) {
      const b = Buffer.alloc(Math.min(65536, Number(before.size) - offset)), n = fs.readSync(fd, b, 0, b.length, offset);
      if (!n) fail("attempt-short-read"); const part = b.subarray(0, n); h.update(part); if (limit < BUNDLE_LIMIT) chunks.push(part); offset += n;
    }
    if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(before) || identity(fs.lstatSync(filename, { bigint: true })) !== identity(before)) fail("attempt-read-drift");
    return { filename, bytes: limit < BUNDLE_LIMIT ? Buffer.concat(chunks) : null, size: offset, sha256: h.digest("hex"), stamp: identity(before),
      mode: Number(before.mode & 0o7777n), uid: Number(before.uid), gid: Number(before.gid) };
  } finally { fs.closeSync(fd); }
}
function syncDir(filename) { if (process.platform === "win32") return; const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function create(context, filename, bytes, mode = 0o600, gid = context.gid) {
  directory(context, path.dirname(filename)); const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
  try { if (!context.windows) { fs.fchmodSync(fd, mode); fs.fchownSync(fd, context.uid, gid); } fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(path.dirname(filename));
}
function retain(context, source, destination, expected, limit, mode = 0o600, gid = context.gid) {
  const before = observe(context, source, limit); if (before.sha256 !== expected) fail("attempt-retained-source-drift");
  directory(context, path.dirname(destination));
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let output;
  try {
    if (identity(fs.fstatSync(input, { bigint: true })) !== before.stamp) fail("attempt-retained-open-drift");
    output = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
    if (!context.windows) { fs.fchmodSync(output, mode); fs.fchownSync(output, context.uid, gid); }
    const h = crypto.createHash("sha256"), b = Buffer.alloc(65536); let offset = 0;
    while (offset < before.size) { const n = fs.readSync(input, b, 0, Math.min(b.length, before.size - offset), offset); if (!n) fail("attempt-retained-short-read"); h.update(b.subarray(0, n)); let written = 0; while (written < n) written += fs.writeSync(output, b, written, n - written); offset += n; }
    if (h.digest("hex") !== expected || identity(fs.fstatSync(input, { bigint: true })) !== before.stamp || identity(fs.lstatSync(source, { bigint: true })) !== before.stamp) fail("attempt-retained-copy-drift");
    fs.fsyncSync(output);
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
  syncDir(path.dirname(destination));
}
function production() {
  if (__dirname !== INSTALL) fail("fixed-attempt-module-required");
  const controller = require(INSTALL + "/frontendReleaseController.cjs"), modules = controller.load();
  return { at: value => value, uid: 0, gid: 0, windows: false, boundary: "/", modules, controller, fixture: false };
}
function input(value) {
  if (!exact(value, ["sha256", "sequence", "workDir"]) || !HASH.test(value.sha256 || "") || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
    typeof value.workDir !== "string" || path.posix.dirname(value.workDir) !== RELEASE + "/work" || !new RegExp("^" + value.sha256 + "\\.[A-Za-z0-9]+$").test(path.posix.basename(value.workDir))) fail("exact-signed-attempt-input-required");
  return value;
}
function attemptPath(sha256, sequence) {
  if (!HASH.test(sha256 || "") || !Number.isSafeInteger(sequence) || sequence < 1) fail("invalid-attempt-identity");
  return ROOT + "/" + sha256 + "." + sequence;
}
function absent(context, logical) { try { fs.lstatSync(target(context, logical)); fail("attempt-recovery-pending"); } catch (e) { if (e.code !== "ENOENT") throw e; } }
function current(context, value, consumed) {
  input(value); const m = context.modules;
  for (const p of [RELEASE + "/recovery/current", RELEASE + "/reference-repairs/current", RELEASE + "/frontend-policy-bootstrap/pending.json", APP + "/.frontend-release-recovery.json"]) absent(context, p);
  const get = (p, cap = 16384, mode = null) => observe(context, target(context, p), cap, false, mode);
  directory(context, target(context, value.workDir));
  const manifest = get(value.workDir + "/" + value.sha256 + ".manifest.json", 1024 * 1024, 0o600), signature = get(value.workDir + "/" + value.sha256 + ".manifest.sig", 16384, 0o600);
  const key = signingTrust.selectReleaseSigningKey(null, context.fixture ? { fixtureRoot:context.at("/"), fixtureOwnerUid:context.uid } : {}).key, bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType !== "rsa" || bits < 3072 || bits > 8192 || !m.signing.verifyManifestBytes(manifest.bytes, signature.bytes, key)) fail("attempt-signature-invalid");
  const signed = JSON.parse(manifest.bytes); m.signing.validateReleaseManifestV3(signed); m.authorization.validateFrontendAuthorization(signed);
  const archive = get(value.workDir + "/" + value.sha256 + ".tgz", BUNDLE_LIMIT, 0o600), sidecar = get(value.workDir + "/" + value.sha256 + ".sha256", 4096, 0o600);
  if (signed.releaseKind !== "frontend-only" || signed.ok !== true || signed.policyVersion !== "release-secret-policy-v2" || signed.sha256 !== value.sha256 || archive.sha256 !== value.sha256 || signed.bytes !== archive.size || signed.releaseSequence !== value.sequence ||
    signed.signature?.algorithm !== m.signing.RELEASE_SIGNATURE_ALGORITHM || signed.signature.keyId !== m.signing.publicKeyId(key) ||
    signed.site !== get("/etc/football-release/expected-site", 128, 0o644).bytes.toString().trim() || signed.channel !== get("/etc/football-release/expected-channel", 128, 0o644).bytes.toString().trim() ||
    ["blockedEntries", "sensitiveEntries", "missingEntries"].some(name => !Array.isArray(signed[name]) || signed[name].length) || sidecar.bytes.toString().trim().split(/\s+/)[0] !== value.sha256) fail("attempt-signed-identity-invalid");
  const sequence = get(RELEASE + "/highest-accepted-sequence", 128, 0o600).bytes.toString();
  if (!/^(0|[1-9][0-9]*)\n$/.test(sequence) || !Number.isSafeInteger(Number(sequence.trim())) || (consumed ? Number(sequence.trim()) !== value.sequence : Number(sequence.trim()) >= value.sequence)) fail("attempt-fresh-sequence-required");
  const stateFile = get(RELEASE + "/frontend-state.json", 8192, 0o600), state = m.identity.parseFrontendReleaseState(stateFile.bytes), projection = get(APP + "/.frontend-release-state.json", 8192, 0o644);
  if (state.phase !== "accepted" || !stateFile.bytes.equals(json(state)) || !projection.bytes.equals(stateFile.bytes) || state.frontendSequence >= value.sequence) fail("attempt-current-state-invalid");
  const acceptance = get(APP + "/.frontend-release-acceptance.json", 10240, 0o644); m.identity.validateFrontendAcceptanceReceipt(acceptance.bytes, state);
  const rootBinding = get(RELEASE + "/frontend-runtime-binding.json", 16384, 0o600), publicBinding = get(APP + "/.frontend-release-binding.json", 16384, 0o644), binding = JSON.parse(rootBinding.bytes), a = signed.frontendAuthorization;
  if (!exact(binding, ["version", "runtimeSha256", "runtimeSequence", "inventorySha256", "runtime", "policies"]) || !exact(binding.runtime, m.authorization.RUNTIME_FIELDS) || !exact(binding.policies, m.authorization.POLICY_FIELDS) ||
    !rootBinding.bytes.equals(json(binding)) || !rootBinding.bytes.equals(publicBinding.bytes) || binding.version !== "frontend-runtime-binding-v1" || binding.runtimeSha256 !== state.runtimeSha256 || binding.runtimeSequence !== state.runtimeSequence ||
    binding.inventorySha256 !== a.baseline.inventorySha256 || a.baseline.runtimeSha256 !== state.runtimeSha256 || a.baseline.runtimeSequence !== state.runtimeSequence || a.baseline.frontendStateSha256 !== stateFile.sha256 || a.baseline.indexSha256 !== state.indexSha256 || a.baseline.distTreeHash !== state.distTreeHash ||
    JSON.stringify(binding.runtime) !== JSON.stringify(a.runtime) || JSON.stringify(binding.policies) !== JSON.stringify(a.policies) || JSON.stringify(context.modules.policies) !== JSON.stringify(a.policies)) fail("attempt-current-binding-invalid");
  for (const n of [".release-bundle-sha256", ".release-live-complete"]) if (!get(APP + "/" + n, 128, 0o644).bytes.equals(Buffer.from(state.runtimeSha256 + "\n"))) fail("attempt-runtime-marker-invalid");
  const dist = m.dist.inspectPrebuiltDist(target(context, APP + "/dist"));
  if (dist.treeHash !== state.distTreeHash || get(APP + "/dist/index.html", 2 * 1024 * 1024, 0o644).sha256 !== state.indexSha256) fail("attempt-current-dist-invalid");
  return { manifest, signature, archive, sidecar, stateFile, acceptance, rootBinding, previousSequence: Number(sequence.trim()), signed,
    workIdentity: [fs.statSync(target(context, value.workDir)).dev, fs.statSync(target(context, value.workDir)).ino].map(String) };
}
function latest(context, sha256, extension) { return target(context, RELEASE + "/" + (extension === "status" ? "status/" : "logs/") + sha256 + "." + extension); }
function legacy(context, sha256) {
  const root = target(context, RELEASE + "/frontend-authorizations/" + sha256); let stat;
  try { stat = fs.lstatSync(root); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe-legacy-attempt"); directory(context, root);
  const allowed = ["original.tgz", "manifest.json", "manifest.sig", "request.json", "build-evidence.json", "authorization.json", "complete.json"];
  const members = fs.readdirSync(root).sort(); if (members.some(n => !allowed.includes(n))) fail("unknown-legacy-attempt-member");
  return members.map(name => { const row = observe(context, path.join(root, name), name === "original.tgz" ? BUNDLE_LIMIT : 8 * 1024 * 1024); return { name, sha256: row.sha256, bytes: row.size, mode: row.mode, uid: row.uid, gid: row.gid }; });
}
function pending(context) {
  const root = target(context, ROOT); directory(context, root); const names = fs.readdirSync(root);
  if (names.length > 4096) fail("attempt-count-limit");
  return names.flatMap(name => {
    const match = /^([a-f0-9]{64})\.([1-9][0-9]*)$/.exec(name); if (!match || !Number.isSafeInteger(Number(match[2]))) fail("unknown-attempt-directory");
    const dir = path.join(root, name); directory(context, dir);
    const running = observe(context, dir + "/running.status", 16384, true, 0o600), final = observe(context, dir + "/final.status", 16384, true, 0o600), sealed = observe(context, dir + "/complete.json", 4096, true, 0o600);
    // A torn prepare never started a build or changed a latest projection. Its
    // exclusive directory remains inert evidence and can never be reused.
    if (sealed) {
      const complete = JSON.parse(sealed.bytes), record = observe(context, dir + "/prepared.json", 16384, false, 0o600), log = observe(context, dir + "/output.log", LIMIT, false, 0o640);
      if (!exact(complete, ["version", "recordSha256", "statusSha256", "logSha256", "logBytes"]) || complete.version !== VERSION || complete.recordSha256 !== record.sha256 || !final || complete.statusSha256 !== final.sha256 || complete.logSha256 !== log.sha256 || complete.logBytes !== log.size) fail("sealed-attempt-evidence-drift");
    }
    return !sealed && (running || final) ? [{ sha256: match[1], sequence: Number(match[2]) }] : [];
  });
}
function quiescent(context) {
  if (context.fixture) { context.assertQuiescent?.(); return; }
  const units = context.controller.run("/usr/bin/systemctl", ["list-units", "--all", "--type=service", "--state=activating,active,deactivating", "--no-legend", "--plain", "football-frontend-build-*"], 5000);
  if (units.trim()) fail("attempt-active-build");
  context.controller.directory("/sys/fs/cgroup/system.slice");
  for (const name of fs.readdirSync("/sys/fs/cgroup/system.slice")) {
    if (!name.startsWith("football-frontend-build-")) continue;
    if (!/^football-frontend-build-[a-f0-9]{24}-[123]\.service$/.test(name) || !context.modules.sandbox.cgroupEmpty(name)) fail("attempt-live-or-unobservable-cgroup");
  }
}
function prepare(context, value) {
  const observed = current(context, value, false), root = target(context, ROOT); directory(context, root);
  if (pending(context).length) fail("previous-attempt-recovery-required");
  const status = observe(context, latest(context, value.sha256, "status"), 16384, true, 0o640), log = observe(context, latest(context, value.sha256, "log"), LIMIT, true, 0o640);
  if (Boolean(status) !== Boolean(log)) fail("unpaired-legacy-attempt-projection");
  if (status) {
    const pairs = status.bytes.toString().trim().split("\n").map(line => { const i = line.indexOf("="); if (i < 1) fail("invalid-legacy-status"); return [line.slice(0, i), line.slice(i + 1)]; });
    if (new Set(pairs.map(p => p[0])).size !== pairs.length) fail("duplicate-legacy-status-key"); const previous = Object.fromEntries(pairs);
    if (previous.status !== "failed" || previous.ok !== "0" || previous.bundleSha256 !== value.sha256 || !/^[1-9][0-9]*$/.test(previous.exitCode || "") ||
      previous.releaseSequence !== undefined && (!/^[1-9][0-9]*$/.test(previous.releaseSequence) || !Number.isSafeInteger(Number(previous.releaseSequence)) || Number(previous.releaseSequence) >= value.sequence)) fail("previous-attempt-not-failed");
  }
  const uploadOwner = observe(context, target(context, "/etc/football-release/upload-owner"), 128, false, 0o644).bytes.toString().trim();
  if (!/^[a-z_][a-z0-9_-]*$/.test(uploadOwner)) fail("attempt-upload-owner-invalid");
  const gid = context.fixture ? context.gid : Number(context.controller.run("/usr/bin/id", ["-g", uploadOwner]));
  if (!Number.isSafeInteger(gid) || gid < 0) fail("attempt-upload-group-invalid");
  const legacyEvidence = legacy(context, value.sha256), directoryName = target(context, attemptPath(value.sha256, value.sequence));
  fs.mkdirSync(directoryName, { mode: 0o700 }); if (!context.windows) fs.chmodSync(directoryName, 0o700); syncDir(root);
  context.onStep?.("attempt-created");
  if (status) { create(context, directoryName + "/previous.status", status.bytes); create(context, directoryName + "/previous.log", log.bytes); }
  for (const [name, row] of [["original.tgz", observed.archive], ["manifest.json", observed.manifest], ["manifest.sig", observed.signature], ["sha256.sidecar", observed.sidecar]]) retain(context, row.filename, directoryName + "/" + name, row.sha256, name === "original.tgz" ? BUNDLE_LIMIT : 1024 * 1024);
  const record = { version: VERSION, sha256: value.sha256, sequence: value.sequence, workDir: value.workDir, workIdentity: observed.workIdentity,
    manifestSha256: observed.manifest.sha256, signatureSha256: observed.signature.sha256, archiveBytes: observed.archive.size, sidecarSha256: observed.sidecar.sha256,
    stateSha256: observed.stateFile.sha256, acceptanceSha256: observed.acceptance.sha256, bindingSha256: observed.rootBinding.sha256, previousSequence: observed.previousSequence,
    previousStatusSha256: status?.sha256 || null, previousLogSha256: log?.sha256 || null, startedAt: new Date().toISOString(), uploadGid: gid, legacyAuthorizationEvidence: legacyEvidence };
  create(context, directoryName + "/prepared.json", json(record)); create(context, directoryName + "/prepared-complete.json", json({ version: VERSION, recordSha256: sha(json(record)) }));
  create(context, directoryName + "/output.log", Buffer.alloc(0), 0o640, gid); context.onStep?.("attempt-prepared");
  return { version: VERSION, sha256: value.sha256, sequence: value.sequence, directory: attemptPath(value.sha256, value.sequence), legacyPreserved: Boolean(status), deploymentAuthorized: false };
}
function prepared(context, sha256, sequence) {
  const dir = target(context, attemptPath(sha256, sequence)); directory(context, dir);
  const recordFile = observe(context, dir + "/prepared.json", 16384, false, 0o600), record = JSON.parse(recordFile.bytes), complete = JSON.parse(observe(context, dir + "/prepared-complete.json", 4096, false, 0o600).bytes);
  const keys = ["version", "sha256", "sequence", "workDir", "workIdentity", "manifestSha256", "signatureSha256", "archiveBytes", "sidecarSha256", "stateSha256", "acceptanceSha256", "bindingSha256", "previousSequence", "previousStatusSha256", "previousLogSha256", "startedAt", "uploadGid", "legacyAuthorizationEvidence"];
  if (!exact(record, keys) || !recordFile.bytes.equals(json(record)) || record.version !== VERSION || record.sha256 !== sha256 || record.sequence !== sequence ||
    !exact(complete, ["version", "recordSha256"]) || complete.version !== VERSION || complete.recordSha256 !== recordFile.sha256 || !Array.isArray(record.workIdentity) || record.workIdentity.length !== 2 || record.workIdentity.some(v => typeof v !== "string") ||
    ["manifestSha256", "signatureSha256", "sidecarSha256", "stateSha256", "acceptanceSha256", "bindingSha256"].some(k => !HASH.test(record[k] || "")) || !Number.isSafeInteger(record.previousSequence) || record.previousSequence < 0 || record.previousSequence >= sequence ||
    !Number.isSafeInteger(record.archiveBytes) || record.archiveBytes < 1 || record.archiveBytes > BUNDLE_LIMIT || !Number.isSafeInteger(record.uploadGid) || record.uploadGid < 0 ||
    !Number.isFinite(Date.parse(record.startedAt)) || new Date(record.startedAt).toISOString() !== record.startedAt || !Array.isArray(record.legacyAuthorizationEvidence) ||
    [record.previousStatusSha256, record.previousLogSha256].some(h => h !== null && !HASH.test(h || "")) || Boolean(record.previousStatusSha256) !== Boolean(record.previousLogSha256)) fail("prepared-attempt-binding-invalid");
  input({ sha256, sequence, workDir: record.workDir });
  const allowed = ["prepared.json", "prepared-complete.json", "original.tgz", "manifest.json", "manifest.sig", "sha256.sidecar", "output.log", "running.status", "final.status", "complete.json", ...(record.previousStatusSha256 ? ["previous.status", "previous.log"] : [])];
  if (fs.readdirSync(dir).some(name => !allowed.includes(name))) fail("unknown-attempt-member");
  for (const [name, expected, limit] of [["original.tgz", sha256, BUNDLE_LIMIT], ["manifest.json", record.manifestSha256, 1024 * 1024], ["manifest.sig", record.signatureSha256, 16384], ["sha256.sidecar", record.sidecarSha256, 4096], ...(record.previousStatusSha256 ? [["previous.status", record.previousStatusSha256, 16384], ["previous.log", record.previousLogSha256, LIMIT]] : [])]) if (observe(context, dir + "/" + name, limit, false, 0o600).sha256 !== expected) fail("immutable-attempt-evidence-drift");
  if (JSON.stringify(legacy(context, sha256)) !== JSON.stringify(record.legacyAuthorizationEvidence)) fail("legacy-authorization-evidence-drift");
  return { dir, record, recordSha256: recordFile.sha256 };
}
function verify(context, value) {
  const observed = current(context, value, true), saved = prepared(context, value.sha256, value.sequence), r = saved.record;
  if (r.workDir !== value.workDir || JSON.stringify(r.workIdentity) !== JSON.stringify(observed.workIdentity) || r.manifestSha256 !== observed.manifest.sha256 || r.signatureSha256 !== observed.signature.sha256 || r.archiveBytes !== observed.archive.size || r.sidecarSha256 !== observed.sidecar.sha256 ||
    r.stateSha256 !== observed.stateFile.sha256 || r.acceptanceSha256 !== observed.acceptance.sha256 || r.bindingSha256 !== observed.rootBinding.sha256 || fs.existsSync(saved.dir + "/final.status") || fs.existsSync(saved.dir + "/complete.json")) fail("prepared-attempt-does-not-match-current-invocation");
  return { version: VERSION, sha256: value.sha256, sequence: value.sequence, directory: attemptPath(value.sha256, value.sequence), recordSha256: saved.recordSha256, deploymentAuthorized: false };
}
function publish(context, filename, bytes, permitted, gid, sequence) {
  const old = observe(context, filename, LIMIT, true, 0o640); if (!permitted.includes(old?.sha256 || null)) fail("attempt-latest-projection-cas-conflict");
  const next = filename + ".attempt-next-" + sequence, existing = observe(context, next, LIMIT, true, 0o640);
  if (existing) { if (existing.sha256 !== sha(bytes) || !context.windows && existing.gid !== gid) fail("unknown-attempt-projection-temp"); }
  else create(context, next, bytes, 0o640, gid);
  if ((observe(context, filename, LIMIT, true, 0o640)?.stamp || null) !== (old?.stamp || null)) fail("attempt-latest-projection-drift");
  fs.renameSync(next, filename); syncDir(path.dirname(filename));
}
function ownAuthorization(context, saved) {
  const r = saved.record, root = RELEASE + "/frontend-authorizations/" + r.sha256 + "." + r.sequence;
  const get = (name, limit = 16384) => observe(context, target(context, root + "/" + name), limit, false, 0o600);
  const file = get("authorization.json", 1024 * 1024), body = JSON.parse(file.bytes), complete = JSON.parse(get("complete.json").bytes), signed = JSON.parse(observe(context, saved.dir + "/manifest.json", 1024 * 1024, false, 0o600).bytes);
  if (body.version !== "frontend-built-source-authorization-v1" || body.requestSha256 !== r.sha256 || body.sequence !== r.sequence || body.manifestSha256 !== r.manifestSha256 || body.stateSha256 !== r.stateSha256 ||
    body.buildEvidenceSha256 !== get("build-evidence.json", 1024 * 1024).sha256 || get("manifest.json", 1024 * 1024).sha256 !== r.manifestSha256 || get("manifest.sig").sha256 !== r.signatureSha256 || get("original.tgz", BUNDLE_LIMIT).sha256 !== r.sha256 ||
    !exact(complete, ["version", "authorizationSha256"]) || complete.version !== body.version || complete.authorizationSha256 !== file.sha256 || JSON.stringify(body.runtime) !== JSON.stringify(signed.frontendAuthorization.runtime) || JSON.stringify(body.policies) !== JSON.stringify(signed.frontendAuthorization.policies)) fail("attempt-fresh-authorization-required");
  return { file, body, signed };
}
function status(context, value) {
  if (!exact(value, ["sha256", "sequence", "phase", "exitCode"]) || !HASH.test(value.sha256 || "") || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !["running", "failed", "complete"].includes(value.phase) ||
    (value.phase === "running" ? value.exitCode !== null : !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 || (value.phase === "complete" ? value.exitCode !== 0 : value.exitCode === 0))) fail("exact-attempt-status-input-required");
  const saved = prepared(context, value.sha256, value.sequence), r = saved.record, terminal = value.phase !== "running";
  if (observe(context, target(context, RELEASE + "/highest-accepted-sequence"), 128, false, 0o600).bytes.toString() !== value.sequence + "\n") fail("attempt-status-sequence-not-consumed");
  if (value.phase === "complete") {
    const get = (p, cap = 16384, mode = 0o600) => observe(context, target(context, p), cap, false, mode);
    const rootState = get(RELEASE + "/frontend-state.json", 8192), publicState = get(APP + "/.frontend-release-state.json", 8192, 0o644), state = context.modules.identity.parseFrontendReleaseState(rootState.bytes);
    if (state.phase !== "accepted" || state.kind !== "frontend-only" || state.frontendSha256 !== value.sha256 || state.frontendSequence !== value.sequence || !rootState.bytes.equals(json(state)) || !rootState.bytes.equals(publicState.bytes)) fail("attempt-complete-state-not-accepted");
    const receipt = get(APP + "/.frontend-release-acceptance.json", 10240, 0o644); context.modules.identity.validateFrontendAcceptanceReceipt(receipt.bytes, state);
    const auth = ownAuthorization(context, saved), signed = auth.signed;
    if (JSON.parse(receipt.bytes).authorizationSha256 !== auth.file.sha256 || state.runtimeSha256 !== signed.frontendAuthorization.baseline.runtimeSha256 || state.runtimeSequence !== signed.frontendAuthorization.baseline.runtimeSequence || context.modules.dist.inspectPrebuiltDist(target(context, APP + "/dist")).treeHash !== state.distTreeHash) fail("attempt-complete-fresh-authorization-required");
  }
  const final = observe(context, saved.dir + "/final.status", 16384, true, 0o600), running = observe(context, saved.dir + "/running.status", 16384, true, 0o600);
  if (!terminal && (running || final)) fail("attempt-already-started-or-finished");
  let bytes = Buffer.from("status=" + value.phase + "\nok=" + (value.phase === "complete" ? "1" : "0") + "\nstartedAt=" + r.startedAt + "\n" + (terminal ? "finishedAt=" + new Date().toISOString() + "\nexitCode=" + value.exitCode + "\n" : "") + "bundleSha256=" + value.sha256 + "\nreleaseKind=frontend-only\nreleaseSequence=" + value.sequence + "\n");
  if (final) { const parsed = Object.fromEntries(final.bytes.toString().trim().split("\n").map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })); if (parsed.status !== value.phase || parsed.exitCode !== String(value.exitCode) || parsed.bundleSha256 !== value.sha256 || parsed.releaseSequence !== String(value.sequence)) fail("attempt-terminal-status-conflict"); bytes = final.bytes; }
  else { create(context, saved.dir + (terminal ? "/final.status" : "/running.status"), bytes); context.onStep?.(terminal ? "attempt-final-status-written" : "attempt-running-status-written"); }
  publish(context, latest(context, value.sha256, "status"), bytes, [r.previousStatusSha256, ...[running, final].filter(Boolean).map(file => file.sha256), sha(bytes)], r.uploadGid, value.sequence);
  context.onStep?.("attempt-status-published");
  if (terminal) {
    const log = observe(context, saved.dir + "/output.log", LIMIT, false, 0o640), completeFile = observe(context, saved.dir + "/complete.json", 4096, true, 0o600);
    if (completeFile) { const c = JSON.parse(completeFile.bytes); if (!exact(c, ["version", "recordSha256", "statusSha256", "logSha256", "logBytes"]) || c.version !== VERSION || c.recordSha256 !== saved.recordSha256 || c.statusSha256 !== sha(bytes) || c.logSha256 !== log.sha256 || c.logBytes !== log.size) fail("sealed-attempt-evidence-drift"); }
    publish(context, latest(context, value.sha256, "log"), log.bytes, [r.previousLogSha256, log.sha256], r.uploadGid, value.sequence);
    context.onStep?.("attempt-log-published");
    if (!completeFile) create(context, saved.dir + "/complete.json", json({ version: VERSION, recordSha256: saved.recordSha256, statusSha256: sha(bytes), logSha256: log.sha256, logBytes: log.size }));
    context.onStep?.("attempt-sealed");
  }
  return { version: VERSION, sha256: value.sha256, sequence: value.sequence, phase: value.phase, sealed: terminal, deploymentAuthorized: false };
}
function ownRollback(context, saved, receipt, state) {
  const body = JSON.parse(receipt.bytes); if (body.version !== "frontend-rollback-acceptance-v1") return false;
  const auth = ownAuthorization(context, saved), previous = context.modules.identity.validateFrontendReleaseState(body.previousState);
  if (sha(json(previous)) !== saved.record.stateSha256 || body.authorizationSha256 !== auth.file.sha256 || body.newFrontendAccepted !== false || !/^[a-f0-9]{24}$/.test(body.transactionId || "")) fail("attempt-rollback-source-binding-invalid");
  const root = RELEASE + "/recovery/.frontend-resolved-" + body.transactionId, get = (name, limit = 3 * 1024 * 1024) => observe(context, target(context, root + "/" + name), limit, false, 0o600);
  const raw = get("frontend-transaction.json"), record = JSON.parse(raw.bytes), complete = JSON.parse(get("complete.json", 4096).bytes), phase = JSON.parse(get("phase.json", 1024).bytes);
  if (record.version !== "frontend-release-transaction-v1" || record.kind !== "frontend-only" || record.id !== body.transactionId || record.authorizationSha256 !== auth.file.sha256 || sha(json(record.previousState)) !== saved.record.stateSha256 ||
    record.pendingState?.frontendSha256 !== saved.record.sha256 || record.pendingState?.frontendSequence !== saved.record.sequence || !exact(complete, ["version", "id", "recordSha256"]) || complete.version !== record.version || complete.id !== record.id || complete.recordSha256 !== raw.sha256 ||
    !exact(phase, ["version", "phase"]) || phase.version !== record.version || phase.phase !== "rolled-back" || get("rollback.json", 10240).sha256 !== receipt.sha256) fail("attempt-rollback-resolved-journal-invalid");
  const actual = context.modules.dist.inspectPrebuiltDist(target(context, APP + "/dist")), files = new Map(record.baselineManifest.files.map(row => [row.path, row])), retained = [];
  for (const asset of record.assets) {
    const row = actual.files.find(f => f.path === asset.path); if (!row) continue;
    if (row.bytes !== asset.bytes || row.sha256 !== asset.sha256) fail("attempt-rollback-retained-asset-changed"); files.set(row.path, row); if (!asset.reused) retained.push(row);
  }
  if (files.size !== actual.files.length || actual.files.some(row => JSON.stringify(files.get(row.path)) !== JSON.stringify(row)) ||
    body.retainedAssetCount !== retained.length || body.retainedAssetsSha256 !== sha(json(actual.files.filter(row => retained.some(r => r.path === row.path)))) ||
    state.indexSha256 !== previous.indexSha256 || state.distTreeHash !== actual.treeHash) fail("attempt-rollback-dist-binding-invalid");
  return true;
}
function recover(context) {
  absent(context, RELEASE + "/recovery/current"); absent(context, RELEASE + "/reference-repairs/current");
  quiescent(context); const rows = pending(context), result = [];
  if (rows.length > 1) fail("multiple-unresolved-started-attempts");
  for (const value of rows) {
    const saved = prepared(context, value.sha256, value.sequence), r = saved.record;
    const manifest = observe(context, saved.dir + "/manifest.json", 1024 * 1024, false, 0o600).bytes, signature = observe(context, saved.dir + "/manifest.sig", 16384, false, 0o600).bytes;
    const key = signingTrust.selectReleaseSigningKey(JSON.parse(manifest),context.fixture ? { fixtureRoot:context.at("/"), fixtureOwnerUid:context.uid } : {}).key;
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength < 3072 || key.asymmetricKeyDetails?.modulusLength > 8192 || !context.modules.signing.verifyManifestBytes(manifest, signature, key)) fail("attempt-recovery-signature-invalid");
    const signed = JSON.parse(manifest); context.modules.signing.validateReleaseManifestV3(signed, { enforceFreshness: false });
    if (signed.releaseKind !== "frontend-only" || signed.sha256 !== value.sha256 || signed.releaseSequence !== value.sequence || signed.bytes !== r.archiveBytes || signed.signature?.keyId !== context.modules.signing.publicKeyId(key)) fail("attempt-recovery-signed-identity-invalid");
    const stateFile = observe(context, target(context, RELEASE + "/frontend-state.json"), 8192, false, 0o600), projection = observe(context, target(context, APP + "/.frontend-release-state.json"), 8192, false, 0o644), state = context.modules.identity.parseFrontendReleaseState(stateFile.bytes), receipt = observe(context, target(context, APP + "/.frontend-release-acceptance.json"), 10240, false, 0o644);
    if (state.phase !== "accepted" || !stateFile.bytes.equals(json(state)) || !stateFile.bytes.equals(projection.bytes)) fail("attempt-recovery-current-state-invalid");
    context.modules.identity.validateFrontendAcceptanceReceipt(receipt.bytes, state);
    if (state.runtimeSha256 !== signed.frontendAuthorization.baseline.runtimeSha256 || state.runtimeSequence !== signed.frontendAuthorization.baseline.runtimeSequence || context.modules.dist.inspectPrebuiltDist(target(context, APP + "/dist")).treeHash !== state.distTreeHash) fail("attempt-recovery-runtime-or-dist-changed");
    for (const n of [".release-bundle-sha256", ".release-live-complete"]) if (!observe(context, target(context, APP + "/" + n), 128, false, 0o644).bytes.equals(Buffer.from(state.runtimeSha256 + "\n"))) fail("attempt-recovery-runtime-marker-changed");
    const final = observe(context, saved.dir + "/final.status", 16384, true, 0o600);
    if (state.frontendSha256 === value.sha256 && state.frontendSequence === value.sequence) {
      result.push(status(context, { ...value, phase: "complete", exitCode: 0 }));
    } else {
      if ((stateFile.sha256 !== r.stateSha256 || receipt.sha256 !== r.acceptanceSha256) && !ownRollback(context, saved, receipt, state)) fail("attempt-recovery-accepted-state-changed");
      let code = 125;
      if (final) { const fields = Object.fromEntries(final.bytes.toString().trim().split("\n").map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })); if (fields.status !== "failed" || !/^[1-9][0-9]*$/.test(fields.exitCode || "")) fail("attempt-recovery-terminal-state-conflict"); code = Number(fields.exitCode); }
      // 125 records an independently observed cold interruption, not a made-up
      // exit status for a candidate build. The accepted old UI remains intact.
      result.push(status(context, { ...value, phase: "failed", exitCode: code }));
    }
  }
  return { version: VERSION, ok: true, action: rows.length ? "interrupted-attempts-sealed" : "noop", attempts: result, candidateBuildsExecuted: 0, acceptanceStatesWritten: 0, deploymentAuthorized: false };
}
function createFrontendReleaseAttemptFixture({ modules, onStep, assertQuiescent, existingRoot, rootIdentity } = {}) {
  if (!modules || !modules.signing || !modules.authorization || !modules.identity || !modules.dist || !modules.policies) fail("fixture-attempt-modules-required");
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of [APP, RELEASE, INSTALL, "/etc/football-release", "/opt/.football-frontend-transactions"]) if (tmp === path.resolve(p) || tmp.startsWith(path.resolve(p) + path.sep)) fail("production-attempt-fixture-temp-forbidden");
  const root = existingRoot || fs.mkdtempSync(path.join(tmp, "football-frontend-attempt-fixture-"));
  if (path.dirname(root) !== tmp || !/^football-frontend-attempt-fixture-[A-Za-z0-9]+$/.test(path.basename(root)) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) fail("unsafe-attempt-fixture-root");
  if (!existingRoot) fs.chmodSync(root, 0o700);
  else if (!exact(rootIdentity, ["dev", "ino"]) || String(fs.lstatSync(root).dev) !== rootIdentity.dev || String(fs.lstatSync(root).ino) !== rootIdentity.ino) fail("attempt-fixture-cold-root-drift");
  const at = logical => { if (typeof logical !== "string" || !logical.startsWith("/") || path.posix.normalize(logical) !== logical || /[\\\0]/.test(logical)) fail("unsafe-attempt-fixture-path"); return path.join(root, "host", ...logical.slice(1).split("/")); };
  const ctx = { at, uid: process.platform === "win32" ? 0 : process.getuid(), gid: process.platform === "win32" ? 0 : process.getgid(), windows: process.platform === "win32", boundary: root, fixture: true, modules, onStep, assertQuiescent };
  directory(ctx, root);
  if (!ctx.windows && (fs.lstatSync(root).mode & 0o7777) !== 0o700) fail("attempt-fixture-root-mode");
  if (!existingRoot) for (const p of [ROOT, RELEASE + "/status", RELEASE + "/logs", RELEASE + "/frontend-authorizations", RELEASE + "/work", RELEASE + "/recovery", RELEASE + "/reference-repairs", APP + "/dist", "/etc/football-release"]) fs.mkdirSync(at(p), { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(root); let disposed = false;
  const guard = () => { if (disposed || fs.realpathSync(root) !== root || fs.lstatSync(root).dev !== s.dev || fs.lstatSync(root).ino !== s.ino) fail("attempt-fixture-root-drift"); };
  return Object.freeze({ fixtureOnly: true, deploymentAuthorized: false, root, at, posixMetadataEnforced: !ctx.windows,
    prepare(value) { guard(); return prepare(ctx, value); }, verify(value) { guard(); return verify(ctx, value); }, status(value) { guard(); return status(ctx, value); }, recover() { guard(); return recover(ctx); },
    dispose() { guard(); fs.rmSync(root, { recursive: true }); disposed = true; } });
}
module.exports = { VERSION, ROOT, attemptPath, prepareFrontendReleaseAttempt: value => prepare(production(), value),
  verifyPreparedFrontendReleaseAttempt: value => verify(production(), value), writeFrontendReleaseAttemptStatus: value => status(production(), value), recoverInterruptedFrontendReleaseAttempts: () => recover(production()),
  assertNoInterruptedFrontendReleaseAttempts() { if (pending(production()).length) fail("previous-attempt-recovery-required"); return { version: VERSION, ok: true, deploymentAuthorized: false }; }, createFrontendReleaseAttemptFixture };
async function main(argv) {
  if (argv[0] === "check-pending" && argv.length === 1) { module.exports.assertNoInterruptedFrontendReleaseAttempts(); return; }
  if (argv[0] === "prepare" && argv.length === 4 && /^[1-9][0-9]*$/.test(argv[2])) { module.exports.prepareFrontendReleaseAttempt({ sha256: argv[1], sequence: Number(argv[2]), workDir: argv[3] }); return; }
  if (argv[0] === "status" && argv.length === 5 && /^[1-9][0-9]*$/.test(argv[2]) && (argv[3] === "running" && argv[4] === "" || /^(0|[1-9][0-9]*)$/.test(argv[4]))) { module.exports.writeFrontendReleaseAttemptStatus({ sha256: argv[1], sequence: Number(argv[2]), phase: argv[3], exitCode: argv[4] === "" ? null : Number(argv[4]) }); return; }
  fail("usage-fixed-frontend-attempt-prepare-sha-sequence-work-or-status-sha-sequence-phase-exit");
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; });
