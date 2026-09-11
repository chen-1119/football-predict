"use strict";
// Compatibility gate, not an operator skip flag. Unknown code or missing model
// evidence always retains the full model lane. No prediction/result writes.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { FRONTEND_PATHS } = require("./releaseChangeClassification.cjs");
const { validateReusablePrivateAudit, validateReusablePrivateAuditPostgres } = require("./releasePrivateModelSeed.cjs");
const { runSynchronousPublication, runAsynchronousPublication } = require("./publicationOperationRunner.cjs");
const VERSION = "release-model-work-policy-v1";
const RELEASE_ONLY = new Set([
  "scripts/createReleaseBundle.cjs", "scripts/deployReleaseBundle.cjs", "scripts/verifyReleaseBundleSafety.cjs",
  "scripts/verifyReleaseTransactionSafety.cjs", "scripts/releaseSequencePreflight.cjs", "scripts/releaseReadinessPolicy.cjs",
  "scripts/releaseModelWorkPolicy.cjs", "scripts/verifyReleaseSpeedFix.cjs", "scripts/rootStaticResultCache.cjs",
  "scripts/verifyReleaseReadinessEarlyExit.cjs", "scripts/releaseProgress.cjs", "scripts/verifyReleaseProgress.cjs",
  "scripts/verifyProductionReadiness.cjs", "scripts/staticVerificationReceipts.cjs",
  "scripts/productionFixtureIsolationContract.cjs", "scripts/verifyProductionFixtureIsolationContract.cjs",
  "scripts/verifyProductionFixtureIsolation.cjs",
  "scripts/rootStaticVerificationAttestations.cjs", "scripts/createRootStaticVerificationAttestations.cjs",
  "scripts/verifyCurrentListPayloadCompaction.cjs",
  // Installed-runtime inspection and its release-only verifiers do not feed
  // model features/training. Keep this exact allowlist, not a verify* wildcard.
  "scripts/frontendInstalledRuntime.cjs", "scripts/verifyFrontendInstalledRuntime.cjs",
  "scripts/verifyFrontendRuntimeAlternatives.cjs", "scripts/verifyReleaseVerifierContracts.cjs",
  "scripts/frontendReleaseInputs.cjs", "scripts/prepareFrontendRelease.cjs", "scripts/verifyFrontendReleaseInputs.cjs",
  // Fixture process lifecycle only; none of these files produce model inputs.
  "scripts/stopVerificationChild.cjs", "scripts/verifyVerificationChildShutdown.cjs",
  "scripts/verifyAccessCodeConcurrency.cjs", "scripts/verifyRelaySnapshotUploadSerialization.cjs",
  "scripts/verifySportteryRelayDualLaneServer.cjs", "scripts/verifySyncWorkerEventBridge.cjs",
  "scripts/verifyDataGenerationEndToEnd.cjs",
  "scripts/verifyFrontendReleaseTransaction.cjs",
  "scripts/verifyReleaseRecovery.cjs",
  "scripts/verifyNativeReleaseRecovery.cjs",
  "scripts/nativeReleaseJournal.cjs", "scripts/verifyNativeReleaseJournal.cjs",
  "scripts/releaseStoragePreflight.cjs", "scripts/verifyReleaseStoragePreflight.cjs",
  "scripts/releasePrivateModelSeed.cjs", "scripts/verifyReleasePrivateModelSeed.cjs",
  "scripts/verifyCandidateArtifactSeed.cjs",
  "scripts/runReleaseWindowPreflight.cjs", "scripts/verifyReleaseWindowPreflight.cjs",
]);
const UI_ONLY = new Set(FRONTEND_PATHS);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function readPlain(file, limit = 16 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error("unsafe-source-file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.lstatSync(file);
    if (opened.ino !== before.ino || after.ino !== before.ino || bytes.length !== before.size
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("source-changed");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function inputInventory(root) {
  root = path.resolve(root);
  for (let dir = root;; dir = path.dirname(dir)) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-source-root");
    if (dir === path.dirname(dir)) break;
  }
  const files = []; let count = 0, bytes = 0;
  function walk(relative) {
    const dir = path.join(root, relative), before = fs.lstatSync(dir);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("unsafe-source-directory");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (++count > 5000 || entry.isSymbolicLink()) throw new Error("source-membership-limit-or-link");
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else if (!RELEASE_ONLY.has(name) && !UI_ONLY.has(name)) add(name);
    }
    const after = fs.lstatSync(dir);
    if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("source-membership-changed");
  }
  function add(relative) {
    const content = readPlain(path.join(root, relative)); bytes += content.length;
    if (bytes > 128 * 1024 * 1024) throw new Error("source-total-byte-limit");
    files.push([relative, hash(content)]);
  }
  // Complete trees: unknown new files, shared UI services, migration code and
  // package script/dependency changes are NOT silently classified as cosmetic.
  for (const tree of ["src", "scripts", "server"]) walk(tree);
  for (const file of ["package.json", "package-lock.json", "deploy/light-server/candidate-revision-transition.json"]) add(file);
  files.sort((a,b) => a[0].localeCompare(b[0]));
  return { files, hash: hash(JSON.stringify(files)) };
}
function* classifyModelWorkOperations({ liveRoot, sourceRoot, storeDir, runtime = process.version, readAudit, storage }) {
  try {
    if (runtime !== "v22.22.1") throw new Error("runtime-not-audited");
    const live = inputInventory(liveRoot), candidate = inputInventory(sourceRoot);
    if (live.hash !== candidate.hash) return { version: VERSION, mode: "recompute", reason: "model-or-unknown-source-changed",
      liveHash: live.hash, candidateHash: candidate.hash };
    const artifacts = {}; let evaluation;
    // Existing products remain private and unchanged. Shape and promotion
    // semantics are still checked by the original fresh readiness gates.
    for (const name of ["model-strategy.json", "model-artifacts/evaluation.json", "model-artifacts/candidate-prospective-registry.json"]) {
      const file = path.join(storeDir, name);
      for (let dir = path.dirname(file);; dir = path.dirname(dir)) {
        const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-model-directory");
        if (dir === path.dirname(dir)) break;
      }
      const content = readPlain(file, 64 * 1024 * 1024), parsed = JSON.parse(content);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.keys(parsed).length === 0) throw new Error("missing-model-artifact");
      artifacts[name] = hash(content);
      if (name === "model-artifacts/evaluation.json") evaluation = parsed;
    }
    const audit = yield readAudit({ storeDir, evaluation });
    artifacts[`${storage}:hhad-companion-audit`] = { sha256: audit.payloadSha256, bytes: audit.payloadBytes,
      version: audit.artifactVersion, generatedAt: audit.generatedAt, updatedAt: audit.updatedAt };
    if (inputInventory(liveRoot).hash !== live.hash || inputInventory(sourceRoot).hash !== candidate.hash) throw new Error("source-changed-during-classification");
    return { version: VERSION, mode: "preserve", reason: "same-complete-model-input-code-and-existing-artifacts",
      sourceHash: live.hash, artifacts, freshDataChecksRequired: true, modelPromotionAuthorized: false };
  } catch (error) {
    return { version: VERSION, mode: "recompute", reason: String(error.code || error.message).slice(0,120) };
  }
}
function classifyModelWork(options) {
  return runSynchronousPublication(classifyModelWorkOperations({ ...options, storage: "sqlite", readAudit: validateReusablePrivateAudit }));
}
async function classifyModelWorkPostgres(options) {
  return runAsynchronousPublication(classifyModelWorkOperations({ ...options, storage: "postgres",
    readAudit: args => validateReusablePrivateAuditPostgres({ ...args, pool: options.pool }) }));
}
module.exports = { VERSION, RELEASE_ONLY, inputInventory, classifyModelWork, classifyModelWorkPostgres };
if (require.main === module) {
  if (process.argv.length !== 5 || process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("fixed-root-release-classifier-required");
  const classify = require("../server/storageMode.cjs").readStorageMode().postgresOnly ? classifyModelWorkPostgres : classifyModelWork;
  Promise.resolve(classify({ liveRoot: process.argv[2], sourceRoot: process.argv[3], storeDir: process.argv[4] }))
    .then(report => { console.error(JSON.stringify(report)); console.log(report.mode); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
