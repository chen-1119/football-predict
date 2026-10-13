"use strict";

// Installed root maintenance authority. No candidate code, signing keys, path
// overrides, caller supplied policies, runtime fields or acceptance booleans.
// The accepted release is observed, never initialized or republished here.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const INSTALL = "/usr/local/libexec/football-release-frontend", APP = "/opt/football-predict", ROOT = "/var/lib/football-release";
const RECOVERY = ROOT + "/recovery", CURRENT = RECOVERY + "/current";
const BINDING = ROOT + "/frontend-runtime-binding.json", PUBLIC = APP + "/.frontend-release-binding.json";
const STATE = ROOT + "/frontend-state.json", VERSION = "frontend-policy-refresh-v1";
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/;
const hash = b => crypto.createHash("sha256").update(b).digest("hex"), json = v => Buffer.from(JSON.stringify(v) + "\n");
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
const fail = reason => { throw new Error(reason); };
function present(filename) { try { fs.lstatSync(filename); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
const stamp = s => [s.dev, s.ino, s.size, s.mode, s.uid, s.gid, s.nlink, s.mtimeNs, s.ctimeNs].map(String).join(":");
function controller() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.execPath !== "/opt/node-v22.22.1/bin/node"
    || process.version !== "v22.22.1" || process.execArgv.length || __dirname !== INSTALL
    || ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"].some(n => process.env[n])) fail("fixed-clean-root-policy-refresh-required");
  const c = require(INSTALL + "/frontendReleaseController.cjs"), m = c.load();
  m.transaction.assertFrontendReleaseLock(); c.directory(RECOVERY, true);
  return { c, m };
}
function identity(s, bytes) {
  return { dev: String(s.dev), ino: String(s.ino), bytes: bytes.length, mode: Number(s.mode & 0o777n), uid: Number(s.uid), gid: Number(s.gid), sha256: hash(bytes) };
}
function read(c, filename, mode, limit = 16384) {
  const before = fs.lstatSync(filename, { bigint: true }), bytes = c.read(filename, limit), after = fs.lstatSync(filename, { bigint: true });
  if (stamp(before) !== stamp(after) || Number(before.mode & 0o777n) !== mode) fail("policy-refresh-file-mode-or-drift");
  return { bytes, identity: identity(before, bytes), stamp: stamp(before) };
}
function parseBinding(bytes) {
  const v = JSON.parse(bytes);
  if (!exact(v, ["version", "runtimeSha256", "runtimeSequence", "inventorySha256", "runtime", "policies"])
    || v.version !== "frontend-runtime-binding-v1" || !HASH.test(v.runtimeSha256 || "") || !HASH.test(v.inventorySha256 || "")
    || !Number.isSafeInteger(v.runtimeSequence) || v.runtimeSequence < 1
    || !exact(v.runtime, ["nodeSha256", "nodeVersion", "dependencyLockSha256", "buildDependencySha256", "installedRuntimeSha256"])
    || v.runtime.nodeVersion !== "v22.22.1" || Object.entries(v.runtime).some(([k, x]) => k !== "nodeVersion" && !HASH.test(x || ""))
    || !exact(v.policies, ["authorizationSha256", "runtimeBoundarySha256", "sandboxSha256"])
    || Object.values(v.policies).some(x => !HASH.test(x || "")) || !bytes.equals(json(v))) fail("policy-refresh-binding-contract");
  return v;
}
function status(c, sha, sequence, kind) {
  const bytes = c.read(ROOT + "/status/" + sha + ".status", 16384), lines = bytes.toString("utf8").trim().split("\n"), entries = lines.map(line => {
    const at = line.indexOf("="); if (at < 1) fail("policy-refresh-status-contract"); return [line.slice(0, at), line.slice(at + 1)];
  });
  if (new Set(entries.map(r => r[0])).size !== entries.length) fail("policy-refresh-status-duplicate");
  const v = Object.fromEntries(entries);
  if (v.status !== "complete" || v.ok !== "1" || v.exitCode !== "0" || v.bundleSha256 !== sha
    || v.releaseKind !== undefined && v.releaseKind !== kind || v.releaseSequence !== undefined && v.releaseSequence !== String(sequence)
    || typeof v.finishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v.finishedAt)
    || !Number.isFinite(Date.parse(v.finishedAt))) fail("policy-refresh-release-not-accepted");
  return bytes;
}
function assertIdle(c) {
  // The inherited exclusive release lock is necessary but a stale detached
  // sandbox is also a blocker. Observation failure is never treated as idle.
  const units = c.run("/usr/bin/systemctl", ["list-units", "--all", "--type=service", "--state=activating,active,deactivating", "--no-legend", "--plain", "football-release-*", "football-frontend-build-*"], 5000);
  if (units.trim()) fail("policy-refresh-active-release-or-build");
  c.directory("/sys/fs/cgroup");
  for (const name of fs.readdirSync("/sys/fs/cgroup/system.slice")) {
    if (!/^football-(?:release|frontend-build)-/.test(name)) continue;
    const root = "/sys/fs/cgroup/system.slice/" + name;
    c.directory(root);
    const filename = root + "/cgroup.events", before = fs.lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0n || before.nlink !== 1n || before.mode & 0o022n) fail("policy-refresh-unsafe-cgroup-observation");
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), buffer = Buffer.alloc(4097); let events;
    try {
      if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before)) fail("policy-refresh-cgroup-open-drift");
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (!count || count > 4096) fail("policy-refresh-cgroup-observation-limit");
      events = buffer.subarray(0, count).toString("utf8");
      if (stamp(fs.lstatSync(filename, { bigint: true })) !== stamp(before)) fail("policy-refresh-cgroup-read-drift");
    } finally { fs.closeSync(fd); }
    if (!/^populated [01]$/m.test(events) || /^populated 1$/m.test(events)) fail("policy-refresh-live-or-unobservable-cgroup");
  }
}
function bootstrapAudit(c, binding, m) {
  const auditRoot = ROOT + "/frontend-policy-bootstrap"; c.directory(auditRoot, true);
  const pointerBytes = c.read(auditRoot + "/current.json", 4096), pointer = JSON.parse(pointerBytes);
  if (!exact(pointer, ["version", "id", "recordSha256"]) || pointer.version !== "frontend-policy-bootstrap-v1"
    || !ID.test(pointer.id || "") || !HASH.test(pointer.recordSha256 || "") || !pointerBytes.equals(json(pointer))) fail("policy-refresh-bootstrap-pointer-contract");
  const recordBytes = c.read(auditRoot + "/" + pointer.id + "/complete.json", 65536), record = JSON.parse(recordBytes);
  if (hash(recordBytes) !== pointer.recordSha256 || !recordBytes.equals(json(record)) || !exact(record, ["version", "id", "bootstrapSha256", "before", "after"])
    || record.version !== pointer.version || record.id !== pointer.id || !HASH.test(record.bootstrapSha256 || "")) fail("policy-refresh-bootstrap-record-contract");
  for (const v of [record.before, record.after]) if (!exact(v, ["modulePins", "policies", "protectedFiles"]) || !Array.isArray(v.modulePins) || !Array.isArray(v.protectedFiles)) fail("policy-refresh-bootstrap-pins-contract");
  for (const v of [record.before, record.after]) {
    if (v.modulePins.length < 10 || v.modulePins.length > 32 || new Set(v.modulePins.map(p => p.name)).size !== v.modulePins.length
      || v.modulePins.some(p => !exact(p, ["name", "sha256"]) || !/^[A-Za-z]+\.cjs$/.test(p.name) || !HASH.test(p.sha256 || ""))
      || !v.modulePins.some(p => p.name === "frontendReleaseController.cjs") || !v.modulePins.some(p => p.name === "frontendRuntimeBoundary.cjs")) fail("policy-refresh-bootstrap-module-contract");
    const derived = { authorizationSha256: c.digest(v.modulePins), runtimeBoundarySha256: v.modulePins.find(p => p.name === "frontendRuntimeBoundary.cjs").sha256,
      sandboxSha256: c.digest(v.modulePins.filter(p => ["frontendBuildSandbox.cjs", "frontendBuildEvidence.cjs", "releasePrebuiltDist.cjs"].includes(p.name))) };
    if (JSON.stringify(derived) !== JSON.stringify(v.policies)) fail("policy-refresh-bootstrap-derived-pin-mismatch");
    if (v.protectedFiles.some(p => !exact(p, ["path", "sha256"]) || typeof p.path !== "string" || !path.posix.isAbsolute(p.path) || !(p.sha256 === null || HASH.test(p.sha256 || "")))
      || new Set(v.protectedFiles.map(p => p.path)).size !== v.protectedFiles.length) fail("policy-refresh-bootstrap-protected-contract");
  }
  if (JSON.stringify(record.before.policies) !== JSON.stringify(binding.policies) || JSON.stringify(record.after.policies) !== JSON.stringify(m.policies)
    || JSON.stringify(record.before.protectedFiles) !== JSON.stringify(record.after.protectedFiles)) fail("policy-refresh-bootstrap-policy-or-preservation-mismatch");
  const actual = c.MODULES.map(name => ({ name, sha256: hash(c.read(INSTALL + "/" + name, 8 * 1024 * 1024)) }));
  if (JSON.stringify(record.after.modulePins) !== JSON.stringify(actual)) fail("policy-refresh-bootstrap-installed-pin-mismatch");
  if (!record.before.protectedFiles.some(v => v.path === BINDING && v.sha256 === hash(json(binding)))) fail("policy-refresh-bootstrap-old-binding-unbound");
  return { path: auditRoot + "/" + pointer.id + "/complete.json", sha256: hash(recordBytes) };
}
function protectedSnapshot(c, m, binding) {
  m.transaction.assertFrontendReleaseLock();
  const stateFile = read(c, STATE, 0o600, 8192), projection = read(c, APP + "/.frontend-release-state.json", 0o644, 8192);
  const state = m.identity.parseFrontendReleaseState(stateFile.bytes), receipt = read(c, APP + "/.frontend-release-acceptance.json", 0o644, 10240);
  if (!projection.bytes.equals(stateFile.bytes) || !stateFile.bytes.equals(json(state)) || state.phase !== "accepted"
    || state.runtimeSha256 !== binding.runtimeSha256 || state.runtimeSequence !== binding.runtimeSequence) fail("policy-refresh-accepted-state-mismatch");
  m.identity.validateFrontendAcceptanceReceipt(receipt.bytes, state);
  const high = read(c, ROOT + "/highest-accepted-sequence", 0o600, 128);
  if (!/^[1-9][0-9]*\n$/.test(high.bytes.toString()) || !Number.isSafeInteger(Number(high.bytes.toString()))
    || Number(high.bytes.toString()) < state.frontendSequence) fail("policy-refresh-high-water-invalid");
  const files = [[STATE, stateFile], [APP + "/.frontend-release-state.json", projection], [APP + "/.frontend-release-acceptance.json", receipt], [ROOT + "/highest-accepted-sequence", high]];
  for (const name of [".release-bundle-sha256", ".release-live-complete"]) {
    const filename = APP + "/" + name, file = read(c, filename, 0o644, 128);
    if (file.bytes.toString() !== state.runtimeSha256 + "\n") fail("policy-refresh-runtime-marker-mismatch"); files.push([filename, file]);
  }
  const dist = m.dist.inspectPrebuiltDist(APP + "/dist");
  if (dist.treeHash !== state.distTreeHash || dist.files.find(r => r.path === "index.html")?.sha256 !== state.indexSha256) fail("policy-refresh-dist-mismatch");
  for (const row of dist.files) if (hash(c.read(APP + "/dist/" + row.path, row.bytes + 1)) !== row.sha256) fail("policy-refresh-dist-ownership-or-drift");
  files.push([ROOT + "/status/" + state.runtimeSha256 + ".status", { bytes: status(c, state.runtimeSha256, state.runtimeSequence, "full") }]);
  if (state.kind === "frontend-only") files.push([ROOT + "/status/" + state.frontendSha256 + ".status", { bytes: status(c, state.frontendSha256, state.frontendSequence, "frontend-only") }]);
  return { state, files: files.map(([filename, v]) => ({ path: filename, sha256: hash(v.bytes) })), distManifestSha256: c.digest(dist) };
}
async function authority(c, m, binding) {
  if (present(ROOT + "/frontend-policy-bootstrap/pending.json")) fail("policy-refresh-bootstrap-incomplete");
  m.attempt.assertNoInterruptedFrontendReleaseAttempts();
  assertIdle(c); const protectedFiles = protectedSnapshot(c, m, binding);
  const auditedBootstrap = bootstrapAudit(c, binding, m);
  const stage = c.stage();
  try {
    const original = await c.retained(m, binding.runtimeSha256, binding.runtimeSequence, stage.root + "/baseline");
    if (original.inventory.treeHash !== binding.inventorySha256) fail("policy-refresh-retained-inventory-mismatch");
    const installed = c.installedProof(m, original), lockSha = hash(c.read(original.root + "/package-lock.json")), material = c.dependencyStore(m, lockSha);
    if (installed.installedRuntimeSha256 !== binding.runtime.installedRuntimeSha256 || lockSha !== binding.runtime.dependencyLockSha256
      || material.record.dependencySha256 !== binding.runtime.buildDependencySha256 || hash(c.read(c.NODE, 160 * 1024 * 1024)) !== binding.runtime.nodeSha256) fail("policy-refresh-runtime-or-material-drift");
    const pinned = ["/etc/football-release/signing-public.pem", "/etc/football-release/expected-site", "/etc/football-release/expected-channel", "/etc/football-release/public-base-url",
      original.verified.directory + "/manifest.json", original.verified.directory + "/manifest.sig", material.root + "/dependencies.json", material.root + "/complete.json"];
    const proof = { ...protectedFiles, authorityFiles: [auditedBootstrap, ...pinned.map(filename => ({ path: filename, sha256: hash(c.read(filename, 1024 * 1024)) }))],
      installedRuntimeSha256: installed.installedRuntimeSha256, policyPins: c.MODULES.map(name => ({ name, sha256: hash(c.read(INSTALL + "/" + name, 8 * 1024 * 1024)) })) };
    if (JSON.stringify(c.load().policies) !== JSON.stringify(m.policies)) fail("policy-refresh-installed-policy-drift");
    c.activeServices(); await c.health(c.publicBase(), protectedFiles.state); await c.publicArtifacts(c.publicBase(), m.dist.inspectPrebuiltDist(APP + "/dist"));
    assertIdle(c); const after = protectedSnapshot(c, m, binding);
    if (JSON.stringify(after) !== JSON.stringify(protectedFiles)) fail("policy-refresh-protected-state-during-observation");
    return proof;
  } finally { c.cleanupStage(stage, true); }
}
function sync(dir) { const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function equalIdentity(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function temporary(filename, id) { return filename + ".policy-" + id; }
function pair(c) { return [read(c, BINDING, 0o600), read(c, PUBLIC, 0o644)]; }
function validateJournal(c) {
  c.directory(CURRENT, true);
  if (JSON.stringify(fs.readdirSync(CURRENT).sort()) !== JSON.stringify(["complete.json", "frontend-policy-refresh.json"])) fail("policy-refresh-journal-membership");
  const bytes = c.read(CURRENT + "/frontend-policy-refresh.json", 65536), record = JSON.parse(bytes), completeBytes = c.read(CURRENT + "/complete.json", 4096), complete = JSON.parse(completeBytes);
  if (!exact(record, ["version", "id", "createdAt", "oldBinding", "newBinding", "oldRoot", "oldPublic", "newRoot", "newPublic", "proof"])
    || record.version !== VERSION || !ID.test(record.id || "") || !bytes.equals(json(record)) || new Date(record.createdAt).toISOString() !== record.createdAt
    || !exact(complete, ["version", "id", "recordSha256"]) || complete.version !== VERSION || complete.id !== record.id
    || complete.recordSha256 !== hash(bytes) || !completeBytes.equals(json(complete))) fail("policy-refresh-journal-contract");
  parseBinding(json(record.oldBinding)); parseBinding(json(record.newBinding));
  for (const v of [record.oldRoot, record.oldPublic, record.newRoot, record.newPublic]) if (!exact(v, ["identity", "stamp"])
    || !exact(v.identity, ["dev", "ino", "bytes", "mode", "uid", "gid", "sha256"]) || typeof v.stamp !== "string") fail("policy-refresh-journal-file-contract");
  if (!exact(record.proof, ["state", "files", "distManifestSha256", "authorityFiles", "installedRuntimeSha256", "policyPins"])) fail("policy-refresh-journal-proof-contract");
  return record;
}
function assertProof(c, observed, wanted) { if (JSON.stringify(observed) !== JSON.stringify(wanted)) fail("policy-refresh-authority-changed"); }
function verifyPair(c, record) {
  const files = pair(c), old = json(record.oldBinding), next = json(record.newBinding);
  files.forEach((file, i) => {
    const oldFile = i ? record.oldPublic : record.oldRoot, newFile = i ? record.newPublic : record.newRoot;
    if (file.bytes.equals(old) && equalIdentity(file.identity, oldFile.identity) && file.stamp === oldFile.stamp) return;
    if (file.bytes.equals(next) && equalIdentity(file.identity, newFile.identity)) return;
    fail("policy-refresh-pair-cas-drift");
  });
  return files;
}
function verifyTemporaries(c, record) {
  const files = verifyPair(c, record), next = json(record.newBinding);
  [BINDING, PUBLIC].forEach((filename, i) => {
    const tmp = temporary(filename, record.id);
    if (files[i].bytes.equals(next)) { if (present(tmp)) fail("policy-refresh-unexpected-temp-after-rename"); return; }
    const staged = read(c, tmp, i ? 0o644 : 0o600), expected = i ? record.newPublic : record.newRoot;
    if (!staged.bytes.equals(next) || !equalIdentity(staged.identity, expected.identity) || staged.stamp !== expected.stamp) fail("policy-refresh-staged-file-drift");
  });
}
async function forward(c, m, record) {
  const derived = c.runtimePublic({ ...record.oldBinding, policies: m.policies });
  if (!json(derived).equals(json(record.newBinding))) fail("policy-refresh-target-policy-changed");
  verifyTemporaries(c, record);
  const observed = await authority(c, m, record.oldBinding); assertProof(c, observed, record.proof);
  const paths = [BINDING, PUBLIC], old = json(record.oldBinding), next = json(record.newBinding);
  verifyTemporaries(c, record);
  for (let i = 0; i < paths.length; i++) {
    assertProof(c, protectedSnapshot(c, m, record.oldBinding), { state: record.proof.state, files: record.proof.files, distManifestSha256: record.proof.distManifestSha256 });
    if (JSON.stringify(c.load().policies) !== JSON.stringify(m.policies)) fail("policy-refresh-policy-cas-drift");
    verifyTemporaries(c, record);
    const files = verifyPair(c, record), filename = paths[i], tmp = temporary(filename, record.id), expected = i ? record.newPublic : record.newRoot;
    if (files[i].bytes.equals(next)) { if (present(tmp)) fail("policy-refresh-unexpected-temp-after-rename"); continue; }
    if (!files[i].bytes.equals(old)) fail("policy-refresh-unexpected-binding");
    const staged = read(c, tmp, i ? 0o644 : 0o600);
    if (!staged.bytes.equals(next) || !equalIdentity(staged.identity, expected.identity) || staged.stamp !== expected.stamp) fail("policy-refresh-staged-file-drift");
    // No caller supplied path or replace helper. Both observed descriptors and
    // inode identities must still match at the compare-and-swap boundary.
    verifyPair(c, record); fs.renameSync(tmp, filename); sync(path.dirname(filename));
  }
  verifyPair(c, record); const final = pair(c); if (final.some(v => !v.bytes.equals(next))) fail("policy-refresh-final-pair-mismatch");
  const after = await authority(c, m, record.oldBinding); assertProof(c, after, record.proof);
  const archive = RECOVERY + "/policy-refreshed-" + record.id;
  if (present(archive)) fail("policy-refresh-archive-conflict");
  fs.renameSync(CURRENT, archive); sync(RECOVERY);
  return { version: VERSION, ok: true, action: "refreshed-root-policy-binding", transactionId: record.id, oldBindingSha256: hash(old), bindingSha256: hash(next),
    stateSha256: record.proof.files.find(r => r.path === STATE).sha256, runtimeSha256: record.oldBinding.runtimeSha256,
    runtimeSequence: record.oldBinding.runtimeSequence, frontendSha256: record.proof.state.frontendSha256, frontendSequence: record.proof.state.frontendSequence,
    policies: record.newBinding.policies, archive, servicesRestarted: false, databaseOrModelWrites: false, releaseSequenceConsumed: false, acceptedStateRewritten: false };
}
async function refreshPolicies(input) {
  if (!exact(input, ["expectedBindingSha256", "expectedStateSha256"]) || Object.values(input).some(v => !HASH.test(v || ""))) fail("invalid-policy-refresh-input");
  const { c, m } = controller();
  if (present(CURRENT)) fail("policy-refresh-recovery-pending");
  const [root, publicFile] = pair(c), binding = parseBinding(root.bytes);
  if (!root.bytes.equals(publicFile.bytes) || hash(root.bytes) !== input.expectedBindingSha256 || hash(c.read(STATE, 8192)) !== input.expectedStateSha256) fail("policy-refresh-expected-current-mismatch");
  const next = c.runtimePublic({ ...binding, policies: m.policies });
  if (root.bytes.equals(json(next))) fail("policy-refresh-no-policy-change");
  const proof = await authority(c, m, binding), id = crypto.randomBytes(12).toString("hex"), stagedJournal = RECOVERY + "/.policy-" + id;
  fs.mkdirSync(stagedJournal, { mode: 0o700 }); sync(RECOVERY);
  const newBytes = json(next); c.writeNew(temporary(BINDING, id), newBytes, 0o600); c.writeNew(temporary(PUBLIC, id), newBytes, 0o644);
  const rootNext = read(c, temporary(BINDING, id), 0o600), publicNext = read(c, temporary(PUBLIC, id), 0o644);
  const snapshot = f => ({ identity: f.identity, stamp: f.stamp });
  const record = { version: VERSION, id, createdAt: new Date().toISOString(), oldBinding: binding, newBinding: next,
    oldRoot: snapshot(root), oldPublic: snapshot(publicFile), newRoot: snapshot(rootNext), newPublic: snapshot(publicNext), proof };
  c.writeNew(stagedJournal + "/frontend-policy-refresh.json", json(record));
  c.writeNew(stagedJournal + "/complete.json", json({ version: VERSION, id, recordSha256: hash(json(record)) })); sync(stagedJournal);
  const now = pair(c); if (!now[0].bytes.equals(root.bytes) || now[0].stamp !== root.stamp || !now[1].bytes.equals(publicFile.bytes) || now[1].stamp !== publicFile.stamp
    || hash(c.read(STATE, 8192)) !== input.expectedStateSha256 || present(CURRENT)) fail("policy-refresh-current-before-intent-drift");
  fs.renameSync(stagedJournal, CURRENT); sync(RECOVERY);
  return forward(c, m, validateJournal(c));
}
async function recoverPolicyRefresh() {
  const { c, m } = controller();
  if (!present(CURRENT)) fail("policy-refresh-recovery-not-present");
  return forward(c, m, validateJournal(c));
}
module.exports = { VERSION, refreshPolicies, recoverPolicyRefresh };
