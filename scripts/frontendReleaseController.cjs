"use strict";

// Independently installed root controller. Never execute this entry from an
// uploaded candidate or mutable APP. Source authorization is not an artifact
// signature: the exact sandbox result is recorded before the index transaction.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const INSTALL = "/usr/local/libexec/football-release-frontend";
const APP = "/opt/football-predict", RELEASE = "/var/lib/football-release";
const NODE = "/opt/node-v22.22.1/bin/node";
const BUILD_ROOT = RELEASE + "/frontend-builds", DEPENDENCIES = RELEASE + "/frontend-dependencies";
const RUNTIME = RELEASE + "/frontend-runtime-binding.json", RUNTIME_PUBLIC = APP + "/.frontend-release-binding.json";
const STATE = RELEASE + "/frontend-state.json";
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/;
const MODULES = Object.freeze(["frontendReleaseController.cjs", "frontendReleaseAuthorization.cjs", "frontendReleaseTransaction.cjs",
  "frontendReleaseIdentity.cjs", "frontendInstalledRuntime.cjs", "frontendRuntimeBoundary.cjs", "frontendBuildSandbox.cjs",
  "frontendBuildEvidence.cjs", "releaseSourceBaseline.cjs", "releaseSigning.cjs", "releaseArchiveSourceInventory.cjs",
  "releaseChangeClassification.cjs", "releasePrebuiltDist.cjs"]);
const FIXED_ENV = Object.freeze({ PATH: "/opt/node-v22.22.1/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), digest = value => hash(JSON.stringify(value));
const json = value => Buffer.from(JSON.stringify(value) + "\n");
const stamp = s => [s.dev, s.ino, s.size, s.mode, s.uid, s.gid, s.nlink, s.mtimeNs, s.ctimeNs].map(String).join(":");
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
function fail(message) { throw new Error(message); }
function directory(filename, privateMode = false) {
  if (!path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail("frontend-controller-noncanonical-directory");
  for (let item = filename; ; item = path.dirname(item)) {
    const s = fs.lstatSync(item);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)
      || item === filename && privateMode && (s.mode & 0o077)) fail("frontend-controller-untrusted-directory");
    if (item === "/") break;
  }
}
function read(filename, limit = 1024 * 1024) {
  directory(path.dirname(filename));
  const s = fs.lstatSync(filename, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0n || s.nlink !== 1n || (s.mode & 0o022n)
    || s.size > BigInt(limit)) fail("frontend-controller-unsafe-file");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s)) fail("frontend-controller-file-open-drift");
    const bytes = Buffer.alloc(Number(s.size)); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) fail("frontend-controller-short-read"); offset += n; }
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(s) || stamp(fs.lstatSync(filename, { bigint: true })) !== stamp(s)) fail("frontend-controller-file-read-drift");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function syncDir(filename) { const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeNew(filename, bytes, mode = 0o600) {
  directory(path.dirname(filename)); const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDir(path.dirname(filename));
}
function replace(filename, bytes, mode = 0o600) {
  if (fs.existsSync(filename)) read(filename, 1024 * 1024);
  const next = filename + ".next-" + crypto.randomBytes(12).toString("hex"); writeNew(next, bytes, mode);
  fs.renameSync(next, filename); syncDir(path.dirname(filename));
}
function retainFile(source, target, expectedSha256, limit) {
  directory(path.dirname(source)); directory(path.dirname(target));
  const before = fs.lstatSync(source, { bigint: true });
  if (!HASH.test(expectedSha256 || "") || !before.isFile() || before.uid !== 0n || before.nlink !== 1n
    || (before.mode & 0o022n) || before.size <= 0n || before.size > BigInt(limit)) fail("frontend-retained-file-invalid");
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output;
  try {
    if (stamp(fs.fstatSync(input, { bigint: true })) !== stamp(before)) fail("frontend-retained-file-open-drift");
    output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const bytes = Buffer.alloc(65536), h = crypto.createHash("sha256"); let offset = 0;
    while (BigInt(offset) < before.size) {
      const count = fs.readSync(input, bytes, 0, Math.min(bytes.length, Number(before.size) - offset), offset);
      if (!count) fail("frontend-retained-short-read"); h.update(bytes.subarray(0, count));
      let written = 0; while (written < count) written += fs.writeSync(output, bytes, written, count - written);
      offset += count;
    }
    if (h.digest("hex") !== expectedSha256 || stamp(fs.fstatSync(input, { bigint: true })) !== stamp(before)
      || stamp(fs.lstatSync(source, { bigint: true })) !== stamp(before)) fail("frontend-retained-content-drift");
    fs.fchmodSync(output, 0o600); fs.fsyncSync(output);
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
  syncDir(path.dirname(target));
}
function run(command, args, timeout = 30000) {
  const result = spawnSync(command, args, { env: FIXED_ENV, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) fail("frontend-controller-fixed-command-failed:" + path.basename(command)); return result.stdout;
}
function load() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.execPath !== NODE || process.version !== "v22.22.1"
    || __dirname !== INSTALL || ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"].some(name => process.env[name])) fail("fixed-clean-root-frontend-controller-required");
  directory(INSTALL, true); directory(RELEASE); directory(BUILD_ROOT, true); directory(DEPENDENCIES, true);
  const policies = MODULES.map(name => ({ name, sha256: hash(read(INSTALL + "/" + name, 8 * 1024 * 1024)) }));
  // Validate the trusted parser before require executes any of its JavaScript.
  const parserPath = INSTALL + "/node_modules/typescript/lib/typescript.js";
  if (hash(read(parserPath, 16 * 1024 * 1024)) !== "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39") fail("frontend-controller-parser-drift");
  const parserPackage = JSON.parse(read(INSTALL + "/node_modules/typescript/package.json", 32768));
  if (parserPackage.name !== "typescript" || parserPackage.version !== "6.0.3" || parserPackage.main !== "./lib/typescript.js"
    || Object.hasOwn(parserPackage, "exports") || parserPackage.type === "module") fail("frontend-controller-parser-entry-drift");
  const m = name => require(INSTALL + "/" + name + ".cjs");
  const loaded = { authorization: m("frontendReleaseAuthorization"), transaction: m("frontendReleaseTransaction"),
    identity: m("frontendReleaseIdentity"), installed: m("frontendInstalledRuntime"), boundary: m("frontendRuntimeBoundary"),
    sandbox: m("frontendBuildSandbox"), build: m("frontendBuildEvidence"), baseline: m("releaseSourceBaseline"),
    signing: m("releaseSigning"), archive: m("releaseArchiveSourceInventory"), dist: m("releasePrebuiltDist") };
  loaded.transaction.assertFrontendReleaseLock();
  return { ...loaded, policies: { authorizationSha256: digest(policies),
    runtimeBoundarySha256: policies.find(p => p.name === "frontendRuntimeBoundary.cjs").sha256,
    sandboxSha256: digest(policies.filter(p => ["frontendBuildSandbox.cjs", "frontendBuildEvidence.cjs", "releasePrebuiltDist.cjs"].includes(p.name))) } };
}
function labels() {
  const output = {};
  for (const field of ["site", "channel"]) {
    output[field] = read("/etc/football-release/expected-" + field, 128).toString("utf8").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(output[field])) fail("invalid-frontend-site-or-channel");
  }
  return output;
}
function stage() {
  const id = crypto.randomBytes(12).toString("hex"), root = BUILD_ROOT + "/" + id;
  fs.mkdirSync(root, { mode: 0o700 }); syncDir(BUILD_ROOT);
  const s = fs.statSync(root); return { id, root, dev: s.dev, ino: s.ino };
}
function cleanupStage(value, safe) {
  if (!safe) return false;
  if (!ID.test(value.id) || value.root !== BUILD_ROOT + "/" + value.id) fail("frontend-cleanup-target-invalid");
  directory(value.root, true); const s = fs.statSync(value.root);
  if (s.dev !== value.dev || s.ino !== value.ino) fail("frontend-cleanup-target-changed");
  // No build descendants may remain when the caller selects safe=true.
  fs.rmSync(value.root, { recursive: true }); syncDir(BUILD_ROOT); return true;
}
function verifyExtracted(root, inventory) {
  directory(root, true); const expected = new Map(inventory.entries.map(row => [row.path, row])), actual = new Set();
  function walk(dir, prefix = "") {
    directory(dir);
    for (const name of fs.readdirSync(dir)) {
      const relative = prefix + name, row = expected.get(relative), full = dir + "/" + name, s = fs.lstatSync(full);
      if (!row || actual.has(relative) || s.isSymbolicLink()) fail("frontend-extracted-membership-drift"); actual.add(relative);
      if (row.kind === "directory") { if (!s.isDirectory()) fail("frontend-extracted-kind-drift"); fs.chmodSync(full, 0o700); walk(full, relative + "/"); }
      else {
        if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || s.size !== row.bytes) fail("frontend-extracted-file-drift");
        fs.chmodSync(full, 0o600);
        if (hash(read(full, 128 * 1024 * 1024)) !== row.sha256) fail("frontend-extracted-content-drift");
      }
    }
  }
  walk(root); if (actual.size !== expected.size) fail("frontend-extracted-membership-incomplete");
}
function extract(archive, destination, inventory) {
  fs.mkdirSync(destination, { mode: 0o700 });
  run("/usr/bin/tar", ["--no-same-owner", "--no-same-permissions", "-xzf", archive, "-C", destination]);
  fs.chmodSync(destination, 0o700); verifyExtracted(destination, inventory);
}
async function retained(m, runtimeSha256, runtimeSequence, destination) {
  const verified = await m.baseline.verifyRetained({ sha256: runtimeSha256, sequence: runtimeSequence, ...labels(),
    publicKeyPath: "/etc/football-release/signing-public.pem", storeRoot: RELEASE + "/source-baselines" });
  const original = JSON.parse(read(verified.directory + "/manifest.json").toString("utf8"));
  const inventory = original.archiveSourceEvidence.inventory;
  extract(verified.directory + "/original.tgz", destination, inventory);
  return { verified, original, inventory, root: destination };
}
function dependencyStore(m, lockSha256) {
  if (!HASH.test(lockSha256 || "")) fail("frontend-dependency-lock-required");
  const root = DEPENDENCIES + "/" + lockSha256; directory(root, true);
  if (JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify(["complete.json", "dependencies.json", "node_modules"])) fail("frontend-dependency-store-membership");
  const bytes = read(root + "/dependencies.json", 16384), record = JSON.parse(bytes), complete = JSON.parse(read(root + "/complete.json", 4096));
  if (record.version !== "frontend-build-dependencies-v1" || record.lockSha256 !== lockSha256 || !HASH.test(record.dependencySha256 || "")
    || complete.version !== record.version || complete.recordSha256 !== hash(bytes)) fail("frontend-dependency-store-binding");
  const observed = m.build.snapshotBuildInputs(root, { beforeBuild: true });
  if (observed.dependencyHash !== record.dependencySha256) fail("frontend-dependency-store-drift");
  return { root, record, observed };
}
function copyDependencies(m, material, destination) {
  for (const row of material.observed.dependencies) {
    const target = destination + "/" + row.path;
    if (row.kind === "directory") { fs.mkdirSync(target, { mode: row.mode }); fs.chmodSync(target, row.mode); }
    else if (row.kind === "bin-alias") {
      m.build.validateBuildBinAlias(row.path, row.target);
      fs.symlinkSync(path.relative(path.dirname(target), destination + "/" + row.target), target);
    } else {
      const bytes = read(material.root + "/" + row.path, 160 * 1024 * 1024);
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail("frontend-dependency-copy-drift"); writeNew(target, bytes, row.mode);
    }
  }
  if (m.build.snapshotBuildInputs(destination, { beforeBuild: true }).dependencyHash !== material.record.dependencySha256) fail("frontend-copied-dependency-commitment");
}
function runtimePublic(value) {
  return { version: "frontend-runtime-binding-v1", runtimeSha256: value.runtimeSha256, runtimeSequence: value.runtimeSequence,
    inventorySha256: value.inventorySha256, runtime: value.runtime, policies: value.policies };
}
async function request(url, limit) {
  const transport = url.protocol === "https:" ? require("node:https") : require("node:http");
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => { clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const req = transport.get(url, { headers: { "Accept-Encoding": "identity", "Cache-Control": "no-cache" } }, response => {
      const pieces = []; let total = 0;
      response.on("data", bytes => { total += bytes.length; if (total > limit) req.destroy(new Error("frontend-acceptance-response-limit")); else pieces.push(bytes); });
      response.once("end", () => finish(null, { status: response.statusCode, bytes: Buffer.concat(pieces) }));
      response.once("error", finish);
    });
    timer = setTimeout(() => req.destroy(new Error("frontend-acceptance-timeout")), 8000);
    req.once("error", finish);
  });
}
function publicBase() {
  const base = new URL(read("/etc/football-release/public-base-url", 2048).toString("utf8").trim());
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") fail("frontend-acceptance-trusted-https-origin-required"); return base;
}
async function health(base, expectedState) {
  const result = await request(new URL("/api/v1/health", base), 2 * 1024 * 1024);
  const value = JSON.parse(result.bytes.toString("utf8"));
  if (result.status !== 200 || value.apiVersion !== "v1" || value.status?.serviceOk !== true) fail("frontend-acceptance-service-unavailable");
  // Formal recommendation eligibility is deliberately not a UI release gate.
  if (expectedState && (!value.frontendRelease?.available || !value.frontendRelease.consistent
    || Object.keys(expectedState).some(key => value.frontendRelease[key] !== expectedState[key]))) fail("frontend-acceptance-health-identity-mismatch");
  return value;
}
function activeServices() {
  for (const unit of ["football-predict.service", "football-sync-worker.service", "nginx.service"])
    if (run("/usr/bin/systemctl", ["is-active", unit], 5000).trim() !== "active") fail("frontend-service-not-active");
}
async function publicArtifacts(base, actual) {
  // Four bounded readers, no build/repair/provider calls. Retained old assets
  // remain part of the release contract for clients with the previous index.
  let cursor = 0, firstError = null;
  await Promise.all(Array.from({ length: Math.min(4, actual.files.length) }, async () => {
    while (!firstError && cursor < actual.files.length) {
      const row = actual.files[cursor++];
      try {
        const dynamicConfig = row.path === "data/runtime-config.json";
        const response = await request(new URL(row.path === "index.html" ? "/" : "/" + row.path, base), dynamicConfig ? 16384 : row.bytes + 1);
        // server/index.cjs deliberately generates this one route from runtime
        // settings; its HTTP bytes are not the unchanged on-disk fallback JSON.
        if (dynamicConfig) {
          const config = JSON.parse(response.bytes.toString("utf8"));
          if (response.status !== 200 || config.dataApiBase !== "/api/v1" || config.legacyDataApiBase !== "/api"
            || config.eventStreamPath !== "/api/v1/events" || config.preferDataApi !== true || config.historyPreferStatic !== false
            || config.access?.required !== true || !Number.isFinite(config.access.ttlSeconds) || config.access.ttlSeconds <= 0
            || !Number.isFinite(config.currentPollSeconds) || config.currentPollSeconds <= 0) fail("frontend-public-runtime-config-invalid");
          continue;
        }
        if (response.status !== 200 || response.bytes.length !== row.bytes || hash(response.bytes) !== row.sha256) fail("frontend-public-artifact-mismatch:" + row.path);
      } catch (error) { firstError ||= error; }
    }
  }));
  if (firstError) throw firstError;
}
async function recoverWithReadOnlyChecks(m) {
  if (fs.existsSync(RELEASE + "/recovery/current/accept-intent.json")) {
    read(RELEASE + "/recovery/current/accept-intent.json", 4096);
    const base = publicBase(); await health(base); activeServices();
    await publicArtifacts(base, m.dist.inspectPrebuiltDist(APP + "/dist"));
  }
  // No health prerequisite for rollback. The transaction itself validates all
  // intent/receipt identities and rejects an ambiguous or externally changed tree.
  return m.transaction.recoverFrontendRelease();
}
async function acceptReadOnly(m, transaction, authorizationSha256) {
  const base = publicBase(), state = transaction.state || transaction.frontendState;
  if (!state || state.phase !== "pending") fail("frontend-pending-state-required-for-acceptance");
  const actual = m.dist.inspectPrebuiltDist(APP + "/dist");
  if (actual.treeHash !== state.distTreeHash) fail("frontend-acceptance-tree-mismatch");
  await publicArtifacts(base, actual);
  await health(base, state);
  for (const route of ["/api/v1/matches/current?view=list", "/api/v1/matches/history?limit=1", "/api/v1/odds/history?limit=1"])
    if ((await request(new URL(route, base), 65536)).status !== 401) fail("frontend-protected-api-exposed");
  for (const route of ["/matches.json", "/odds-history.json", "/data/matches-history.json", "/data/odds-history.json"])
    if (![401, 403, 404, 410].includes((await request(new URL(route, base), 65536)).status)) fail("frontend-protected-static-exposed");
  activeServices();
  if (m.dist.inspectPrebuiltDist(APP + "/dist").treeHash !== state.distTreeHash) fail("frontend-acceptance-tree-drift");
  return { version: "frontend-readonly-acceptance-v1", transactionId: transaction.transactionId,
    runtimeSha256: state.runtimeSha256, runtimeSequence: state.runtimeSequence, frontendSha256: state.frontendSha256,
    frontendSequence: state.frontendSequence, indexSha256: state.indexSha256, distTreeHash: state.distTreeHash,
    authorizationSha256, checkedAt: new Date().toISOString(), checks: { index: true, assets: true, health: true, protected: true, services: true } };
}

function authenticateRequest(m, sha256, sequence, work) {
  if (!HASH.test(sha256) || !Number.isSafeInteger(sequence) || sequence < 1 || path.dirname(work) !== RELEASE + "/work"
    || !new RegExp("^" + sha256 + "\\.[A-Za-z0-9]+$").test(path.basename(work))) fail("frontend-original-work-required");
  directory(work, true);
  const bytes = read(work + "/" + sha256 + ".manifest.json"), signature = read(work + "/" + sha256 + ".manifest.sig", 16384);
  const keyBytes = read("/etc/football-release/signing-public.pem", 16384);
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(keyBytes.toString("utf8"))) fail("frontend-public-key-only-required");
  const key = crypto.createPublicKey(keyBytes), bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType !== "rsa" || bits < 3072 || bits > 8192 || !m.signing.verifyManifestBytes(bytes, signature, key)) fail("frontend-request-signature-invalid");
  const manifest = JSON.parse(bytes.toString("utf8")), expectedLabels = labels();
  m.signing.validateReleaseManifestV3(manifest); m.authorization.validateFrontendAuthorization(manifest);
  if (manifest.releaseKind !== "frontend-only" || manifest.ok !== true || manifest.sha256 !== sha256 || manifest.releaseSequence !== sequence
    || manifest.policyVersion !== "release-secret-policy-v2" || manifest.site !== expectedLabels.site || manifest.channel !== expectedLabels.channel
    || manifest.signature?.algorithm !== m.signing.RELEASE_SIGNATURE_ALGORITHM || manifest.signature.keyId !== m.signing.publicKeyId(key)
    || ["blockedEntries", "sensitiveEntries", "missingEntries"].some(name => !Array.isArray(manifest[name]) || manifest[name].length)) fail("frontend-request-identity-or-policy-mismatch");
  if (read(RELEASE + "/highest-accepted-sequence", 64).toString("utf8").trim() !== String(sequence)) fail("frontend-sequence-not-consumed-by-wrapper");
  return { manifest, bytes, signature, archive: work + "/" + sha256 + ".tgz" };
}
function installedProof(m, original) {
  const proof = m.installed.captureInstalledFrontendRuntime({ baselineRoot: original.root, baselineInventory: original.inventory });
  if (!proof.ok || !HASH.test(proof.installedRuntimeSha256 || "")) fail("frontend-installed-runtime-unavailable:" + (proof.blockers || []).join(","));
  return proof;
}
function assertCurrent(m, stateBytes, distManifest) {
  m.transaction.assertFrontendReleaseLock();
  if (!read(STATE, 8192).equals(stateBytes) || !read(APP + "/.frontend-release-state.json", 8192).equals(stateBytes)
    || m.dist.inspectPrebuiltDist(APP + "/dist").treeHash !== distManifest.treeHash) fail("frontend-current-baseline-changed");
}
async function apply(sha256, sequence, work) {
  const startedAt = Date.now();
  const m = load(), request = authenticateRequest(m, sha256, sequence, work), a = request.manifest.frontendAuthorization;
  if (fs.existsSync(RELEASE + "/recovery/current")) fail("frontend-recovery-pending");
  await m.archive.verifyArchiveSourceEvidence(request.archive, request.manifest);
  const stateBytes = read(STATE, 8192), state = m.identity.parseFrontendReleaseState(stateBytes);
  if (state.phase !== "accepted" || state.runtimeSha256 !== a.baseline.runtimeSha256 || state.runtimeSequence !== a.baseline.runtimeSequence
    || state.frontendSequence >= sequence || state.indexSha256 !== a.baseline.indexSha256 || state.distTreeHash !== a.baseline.distTreeHash
    || hash(stateBytes) !== a.baseline.frontendStateSha256) fail("frontend-signed-current-state-mismatch");
  const binding = JSON.parse(read(RUNTIME, 16384));
  if (JSON.stringify(runtimePublic(binding)) !== read(RUNTIME_PUBLIC, 16384).toString("utf8").trim()
    || binding.version !== "frontend-runtime-binding-v1" || binding.runtimeSha256 !== state.runtimeSha256 || binding.runtimeSequence !== state.runtimeSequence
    || binding.inventorySha256 !== a.baseline.inventorySha256 || JSON.stringify(binding.runtime) !== JSON.stringify(a.runtime)
    || JSON.stringify(binding.policies) !== JSON.stringify(a.policies) || JSON.stringify(m.policies) !== JSON.stringify(a.policies)) fail("frontend-trusted-runtime-or-policy-binding-mismatch");
  const priorDist = m.dist.inspectPrebuiltDist(APP + "/dist"); assertCurrent(m, stateBytes, priorDist);
  if (priorDist.treeHash !== state.distTreeHash || read(APP + "/.release-bundle-sha256", 128).toString("utf8").trim() !== state.runtimeSha256
    || read(APP + "/.release-live-complete", 128).toString("utf8").trim() !== state.runtimeSha256) fail("frontend-runtime-markers-or-tree-mismatch");
  const capacity = fs.statfsSync(BUILD_ROOT, { bigint: true });
  if (capacity.bavail * capacity.bsize < 8n * 1024n ** 3n) fail("frontend-build-insufficient-disk-floor");
  const attemptRoot = RELEASE + "/frontend-authorizations"; directory(attemptRoot, true);
  const attempt = attemptRoot + "/" + sha256; fs.mkdirSync(attempt, { mode: 0o700 }); syncDir(attemptRoot);
  retainFile(request.archive, attempt + "/original.tgz", sha256, 512 * 1024 * 1024);
  writeNew(attempt + "/manifest.json", request.bytes); writeNew(attempt + "/manifest.sig", request.signature);
  writeNew(attempt + "/request.json", json({ version: "frontend-source-build-attempt-v1", sha256, sequence,
    manifestSha256: hash(request.bytes), stateSha256: hash(stateBytes), createdAt: new Date().toISOString() }));
  const buildStage = stage(); let execution = null, buildStarted = false, transaction = null, safeCleanup = true;
  try {
    const original = await retained(m, state.runtimeSha256, state.runtimeSequence, buildStage.root + "/baseline");
    const comparison = m.authorization.compareAuthorizedFrontendSources({ manifest: request.manifest,
      baselineInventory: original.inventory, candidateInventory: request.manifest.archiveSourceEvidence.inventory });
    extract(request.archive, buildStage.root + "/source", request.manifest.archiveSourceEvidence.inventory);
    const source = buildStage.root + "/source";
    const boundary = m.boundary.compareFrontendRuntimeBoundary({ baseline: { root: original.root, inventory: original.inventory,
      authenticatedInventoryHash: original.inventory.treeHash }, candidate: { root: source, inventory: request.manifest.archiveSourceEvidence.inventory,
      authenticatedInventoryHash: request.manifest.archiveSourceEvidence.inventory.treeHash } });
    if (!boundary.ok) fail("frontend-runtime-source-boundary-rejected:" + boundary.blockers.join(","));
    if (installedProof(m, original).installedRuntimeSha256 !== a.runtime.installedRuntimeSha256
      || hash(read(NODE, 160 * 1024 * 1024)) !== a.runtime.nodeSha256
      || hash(read(source + "/package-lock.json")) !== a.runtime.dependencyLockSha256) fail("frontend-installed-runtime-changed");
    const material = dependencyStore(m, a.runtime.dependencyLockSha256);
    if (material.record.dependencySha256 !== a.runtime.buildDependencySha256) fail("frontend-build-dependency-binding-mismatch");
    // The candidate archive intentionally contains unchanged old dist. It must
    // be outside the build input; it cannot satisfy this invocation's output.
    fs.renameSync(source + "/dist", buildStage.root + "/archived-candidate-dist");
    copyDependencies(m, material, source);
    const inputs = m.build.snapshotBuildInputs(source, { beforeBuild: true });
    assertCurrent(m, stateBytes, priorDist); buildStarted = true; safeCleanup = false;
    execution = m.sandbox.runSandboxedFrontendBuild({ rootDir: source, baselineDist: priorDist,
      baselineReleaseSha256: state.runtimeSha256, timeoutMs: 300000 });
    const recorded = m.sandbox.readSandboxEvidence({ directory: execution.directory, evidenceHash: execution.evidenceHash });
    safeCleanup = recorded.rootfsRemoved === true && recorded.descendantsQuiescent === true;
    if (recorded.sourceHash !== inputs.sourceHash || recorded.dependencyHash !== a.runtime.buildDependencySha256
      || recorded.baseline.releaseSha256 !== state.runtimeSha256 || recorded.baseline.distTreeHash !== state.distTreeHash
      || recorded.baseline.manifestHash !== digest(priorDist) || recorded.environment.HOME !== "/build-home"
      || recorded.commandPolicyHash !== digest(m.sandbox.COMMANDS)) fail("frontend-build-receipt-input-mismatch");
    const exported = m.dist.inspectPrebuiltDist(source + "/dist");
    if (JSON.stringify(exported) !== JSON.stringify(recorded.artifact)) fail("frontend-export-changed-after-receipt");
    const overlay = m.build.inspectOverlayArtifacts(priorDist, exported);
    if (overlay.index.sha256 === state.indexSha256) fail("frontend-source-change-produced-no-index-change");
    assertCurrent(m, stateBytes, priorDist);
    if (installedProof(m, original).installedRuntimeSha256 !== a.runtime.installedRuntimeSha256 || JSON.stringify(load().policies) !== JSON.stringify(m.policies)) fail("frontend-runtime-or-controller-drift-during-build");
    writeNew(attempt + "/build-evidence.json", read(execution.directory + "/evidence.json"));
    const authorization = { version: "frontend-built-source-authorization-v1", requestSha256: sha256, sequence,
      manifestSha256: hash(request.bytes), sourceAuthorization: comparison, stateSha256: hash(stateBytes),
      runtime: a.runtime, policies: m.policies, boundaryEvidenceSha256: boundary.evidenceHash,
      buildEvidenceSha256: execution.evidenceHash, artifactTreeHash: exported.treeHash, createdAt: new Date().toISOString() };
    const authorizationBytes = json(authorization), authorizationSha256 = hash(authorizationBytes);
    writeNew(attempt + "/authorization.json", authorizationBytes);
    writeNew(attempt + "/complete.json", json({ version: authorization.version, authorizationSha256 }));
    transaction = m.transaction.beginFrontendRelease({ expectedStateSha256: hash(stateBytes), expectedDistManifest: priorDist,
      candidateIndex: { bytes: read(source + "/dist/index.html", 1024 * 1024), sha256: overlay.index.sha256 },
      newAssets: overlay.newAssets.map(row => ({ path: row.path, sha256: row.sha256, bytes: read(source + "/dist/" + row.path, 32 * 1024 * 1024) })),
      runtimeSha256: state.runtimeSha256, runtimeSequence: state.runtimeSequence, frontendSha256: sha256, frontendSequence: sequence, authorizationSha256 });
    const acceptance = await acceptReadOnly(m, transaction, authorizationSha256), acceptanceBytes = json(acceptance);
    if (installedProof(m, original).installedRuntimeSha256 !== a.runtime.installedRuntimeSha256) fail("frontend-runtime-drift-before-acceptance");
    const accepted = m.transaction.acceptFrontendRelease({ transactionId: transaction.transactionId,
      acceptanceReceiptBytes: acceptanceBytes, acceptanceSha256: hash(acceptanceBytes) });
    return { version: "frontend-release-controller-v1", ok: true, releaseKind: "frontend-only", requestSha256: sha256,
      runtimeSha256: state.runtimeSha256, frontendSha256: accepted.state.frontendSha256, sequence, transactionId: transaction.transactionId,
      buildEvidenceSha256: execution.evidenceHash, acceptanceSha256: accepted.state.acceptanceSha256, servicesRestarted: false,
      databaseOrModelWrites: false, buildExecutions: 1, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (error.evidence) { execution = error.evidence; safeCleanup = execution.rootfsRemoved === true; }
    // Even begin can throw after publishing current. Do not infer "no write"
    // merely because it did not return a transaction object.
    if (fs.existsSync(RELEASE + "/recovery/current")) {
      try { await recoverWithReadOnlyChecks(m); } catch { error.recoveryPending = true; }
    }
    throw error;
  } finally {
    cleanupStage(buildStage, !buildStarted || safeCleanup);
    // Exact bounded /run receipt cleanup is left to the independent operator;
    // durable copies above are the release record, never an old cache hit.
  }
}
async function initialize(sha256, sequence) {
  const m = load();
  if (!HASH.test(sha256) || !Number.isSafeInteger(sequence) || sequence < 1) fail("invalid-full-frontend-initialization");
  const buildStage = stage();
  try {
    const original = await retained(m, sha256, sequence, buildStage.root + "/baseline"), installed = installedProof(m, original);
    const lockSha256 = hash(read(original.root + "/package-lock.json")), material = dependencyStore(m, lockSha256);
    const runtime = { nodeSha256: hash(read(NODE, 160 * 1024 * 1024)), nodeVersion: process.version,
      dependencyLockSha256: lockSha256, buildDependencySha256: material.record.dependencySha256, installedRuntimeSha256: installed.installedRuntimeSha256 };
    const actual = m.dist.inspectPrebuiltDist(APP + "/dist"); await health(publicBase());
    const acceptanceBytes = json({ version: "frontend-full-baseline-acceptance-v1", runtimeSha256: sha256, runtimeSequence: sequence,
      indexSha256: actual.files.find(row => row.path === "index.html").sha256, distTreeHash: actual.treeHash,
      checkedAt: new Date().toISOString(), checks: { runtimeMarkers: true, health: true, sourceBaseline: true } });
    const initialized = m.transaction.initializeFullFrontendState({ runtimeSha256: sha256, runtimeSequence: sequence,
      acceptanceReceiptBytes: acceptanceBytes, acceptanceSha256: hash(acceptanceBytes) });
    const binding = runtimePublic({ runtimeSha256: sha256, runtimeSequence: sequence, inventorySha256: original.inventory.treeHash, runtime, policies: m.policies });
    replace(RUNTIME, json(binding)); replace(RUNTIME_PUBLIC, json(binding), 0o644);
    await health(publicBase(), initialized.state);
    return { version: "frontend-release-controller-v1", ok: true, action: "initialized-full-frontend-baseline", runtimeSha256: sha256,
      runtimeSequence: sequence, stateSha256: initialized.stateSha256, frontendOnlyReady: true };
  } finally { cleanupStage(buildStage, true); }
}
async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "apply" && argv.length === 4 && /^[1-9][0-9]*$/.test(argv[2] || "")) return apply(argv[1], Number(argv[2]), argv[3]);
  if (argv[0] === "initialize" && argv.length === 3 && /^[1-9][0-9]*$/.test(argv[2] || "")) return initialize(argv[1], Number(argv[2]));
  if (argv[0] === "recover" && argv.length === 1) return recoverWithReadOnlyChecks(load());
  fail("usage-fixed-frontend-controller-apply-sha-sequence-work-or-initialize-sha-sequence-or-recover");
}
module.exports = { MODULES, INSTALL, APP, RELEASE, NODE, BUILD_ROOT, DEPENDENCIES,
  load, read, replace, writeNew, retainFile, directory, stage, cleanupStage, retained, extract,
  dependencyStore, copyDependencies, runtimePublic, acceptReadOnly, publicArtifacts, activeServices, recoverWithReadOnlyChecks,
  health, publicBase, labels, json, hash, digest, exact, apply, initialize, main };
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(JSON.stringify({ ok: false, releaseKind: "frontend-only", error: error.message, recoveryPending: error.recoveryPending === true })); process.exitCode = 1;
});
