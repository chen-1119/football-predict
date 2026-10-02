"use strict";

// Candidate-only validation proof. The caller supplies copied real inputs and
// enforces OS isolation; this script never contacts a provider or PostgreSQL.
// All positive decisions use the actual clock. No clock override is accepted.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { captureOfficialClosedSchedule, auditPublishedOfficialClosedSchedule } = require("./officialClosedScheduleEvidence.cjs");

const VERSION = "official-closure-repair-proof-v1";
const ROOT = path.resolve(__dirname, "..");
const FLAGS = ["WRITE_LEGACY_STATIC_PAYLOADS", "MIRROR_PUBLISHED_DATA_TO_DIST", "ALLOW_LARGE_STATIC_DIST"];
const INVENTORY_ROOTS = ["public", "server-data", "dist"];
const HASH = /^[a-f0-9]{64}$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const ensure = (value, message) => { if (!value) throw new Error(message); };
const sameStat = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => a[key] === b[key]);
const relative = file => path.relative(ROOT, file).split(path.sep).join("/");
function member(file) {
  ensure(typeof file === "string" && path.isAbsolute(file), "absolute candidate path required");
  const resolved = path.resolve(file);
  ensure(resolved.startsWith(ROOT + path.sep), "path must remain inside this candidate");
  const parent = path.dirname(resolved);
  ensure(fs.realpathSync(parent) === parent, "candidate parent path must not alias another directory");
  return resolved;
}
function inspectFile(file) {
  const resolved = member(file), before = fs.lstatSync(resolved, { bigint: true });
  ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n, "candidate input must be an unshared regular file");
  ensure(fs.realpathSync(resolved) === resolved && before.size <= 2n * 1024n ** 3n, "candidate file path or size invalid");
  const fd = fs.openSync(resolved, "r"), digest = crypto.createHash("sha256"), buffer = Buffer.alloc(65536);
  let bytes = 0;
  try {
    ensure(sameStat(before, fs.fstatSync(fd, { bigint: true })), "candidate file changed before read");
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      bytes += n; ensure(bytes <= 2 * 1024 ** 3, "candidate file grew beyond bound");
      digest.update(buffer.subarray(0, n));
    }
    ensure(sameStat(before, fs.fstatSync(fd, { bigint: true })) && sameStat(before, fs.lstatSync(resolved, { bigint: true }))
      && BigInt(bytes) === before.size, "candidate file changed during read");
  } finally { fs.closeSync(fd); }
  return { path: relative(resolved), bytes, sha256: digest.digest("hex") };
}
function readSmall(file, maximumBytes) {
  const receipt = inspectFile(file);
  ensure(receipt.bytes <= maximumBytes, "candidate JSON exceeds bound");
  const bytes = fs.readFileSync(file);
  ensure(hash(bytes) === receipt.sha256, "candidate input changed after inventory");
  return { bytes, value: JSON.parse(bytes.toString("utf8")), receipt };
}
function inventory() {
  const files = [], directories = [];
  function walk(directory) {
    const state = fs.lstatSync(directory);
    ensure(state.isDirectory() && !state.isSymbolicLink() && fs.realpathSync(directory) === directory, "candidate inventory directory unsafe");
    directories.push(relative(directory));
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), entry = fs.lstatSync(file);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(file);
      else files.push(inspectFile(file));
      ensure(files.length + directories.length <= 100000, "candidate inventory exceeds bound");
    }
  }
  for (const name of INVENTORY_ROOTS) if (fs.existsSync(path.join(ROOT, name))) walk(path.join(ROOT, name));
  return { directories, files };
}
function withoutClosure(meta) {
  const copy = structuredClone(meta);
  if (copy.currentListPolicy) delete copy.currentListPolicy.officialClosedSchedule;
  return copy;
}
function runValidator(script, publicDistribution, env, expectedPass, expectedError) {
  const args = [script, ...(publicDistribution ? ["--public-distribution"] : [])];
  const child = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", windowsHide: true,
    timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  ensure(!child.error && !child.signal && [0, 1].includes(child.status), "validator execution unavailable or timed out");
  let payload = null;
  if (child.status === 0) payload = JSON.parse(child.stdout);
  const observedPass = child.status === 0 && payload?.ok === true;
  const expectedErrorObserved = expectedError ? expectedError.test(child.stderr) : true;
  const result = { scope: publicDistribution ? "public-distribution" : "server-complete", exitCode: child.status,
    expectedPass, passed: observedPass === expectedPass && expectedErrorObserved,
    stdoutSha256: hash(child.stdout), stderrSha256: hash(child.stderr),
    errorLines: child.status ? child.stderr.trim().split(/\r?\n/).slice(0, 16) : [],
    ...(payload ? { validationScope: payload.validationScope, privateArchiveVerified: payload.privateArchiveVerified,
      count: payload.count, currentListPolicy: payload.currentListPolicy,
      officialClosedScheduleEvidence: payload.officialClosedScheduleEvidence } : {}) };
  if (!result.passed) {
    const error = new Error("validator result did not match the required case: " + result.scope);
    error.validation = result;
    throw error;
  }
  return result;
}

function prove(inputPath, outputPath) {
  inputPath = member(inputPath); outputPath = member(outputPath);
  ensure(!fs.existsSync(outputPath), "proof output must be a new candidate file");
  ensure(!INVENTORY_ROOTS.some(name => outputPath.startsWith(path.join(ROOT, name) + path.sep)), "proof output cannot be a data file");
  const input = readSmall(inputPath, 65536);
  const request = input.value;
  ensure(request.version === "official-closure-repair-proof-input-v1" && HASH.test(request.capsuleSha256), "invalid repair proof input or capsule hash");
  ensure(path.resolve(request.candidate || "") === ROOT && fs.realpathSync(ROOT) === ROOT, "proof candidate must be the script's own unaliased project");
  ensure(path.resolve(request.storeDir || "") === path.join(ROOT, "server-data"), "proof storeDir must be candidate/server-data");
  ensure(FLAGS.every(key => ["0", "1"].includes(request.flags?.[key]))
    && Object.keys(request.flags).every(key => FLAGS.includes(key)), "proof flags must explicitly match the three supplied production flags");
  const relayPath = member(request.relayPath), trustRegistryPath = member(request.trustRegistryPath);
  const baselineValidatorPath = member(request.baselineValidatorPath);
  ensure(relayPath === path.join(ROOT, "proof-input", "relay.json") && trustRegistryPath === path.join(ROOT, "proof-input", "registry.json")
    && baselineValidatorPath === path.join(ROOT, "scripts", "validateData.baseline.cjs"), "proof input paths must use the designated candidate locations");
  const report = { version: VERSION, startedAt: new Date().toISOString(), ok: false, capsuleSha256: request.capsuleSha256,
    candidate: ROOT, input: input.receipt, actualClockOnly: true, networkRequests: 0, productionWrites: false,
    postgresWrites: false, generationPublished: false, completeWorkerPipelineVerified: false,
    isolation: "OS private network and host-readonly confinement are the controller's responsibility; this script does not assert that a supplied flag creates isolation.",
    testedStages: ["validateData server-complete", "validateData public-distribution"],
    marketDataPromoted: false, recommendationsPromoted: false, sourceHealthPromoted: false,
    originalData: null, finalData: null, dataIntegrityPreserved: false, baselineRejected: false, positive: [], negative: [] };
  const metaPath = path.join(ROOT, "public", "data", "sync-meta.json");
  const currentPath = path.join(ROOT, "public", "data", "matches-current.json");
  const missingPath = path.join(ROOT, "proof-input", "missing-current-negative-" + crypto.randomBytes(8).toString("hex") + ".json");
  let originalMetaBytes = null, positiveMetaBytes = null, success = false, currentMoved = false;
  const restoreCurrent = () => {
    if (!currentMoved) return;
    ensure(!fs.existsSync(currentPath), "negative current restore target unexpectedly exists");
    fs.renameSync(missingPath, currentPath); currentMoved = false;
  };
  try {
    report.originalData = inventory();
    const current = readSmall(currentPath, 1024 * 1024), meta = readSmall(metaPath, 1024 * 1024);
    originalMetaBytes = meta.bytes;
    ensure(Array.isArray(current.value) && current.value.length === 0, "repair proof requires actual explicit empty current data");
    ensure(meta.value.files?.current === 0 && meta.value.currentListPolicy && typeof meta.value.currentListPolicy === "object"
      && !Array.isArray(meta.value.currentListPolicy), "repair metadata must already declare zero current and its existing policy");
    report.sourceCycleId = meta.value.sourceCycleId;
    report.currentListEvaluatedAt = meta.value.currentListPolicy.evaluatedAt;
    report.relay = inspectFile(relayPath); report.registry = inspectFile(trustRegistryPath);
    report.baselineValidator = inspectFile(baselineValidatorPath);
    report.candidateValidator = inspectFile(path.join(ROOT, "scripts", "validateData.cjs"));
    ensure(report.baselineValidator.sha256 !== report.candidateValidator.sha256, "baseline and repaired validators must differ");
    const closure = captureOfficialClosedSchedule({ snapshotPath: relayPath, trustRegistryPath,
      asOf: new Date().toISOString(), publicationSourceCycleId: meta.value.sourceCycleId,
      currentListEvaluatedAt: meta.value.currentListPolicy.evaluatedAt });
    report.closureAdmission = closure;
    ensure(closure.emptyCurrentIntegrityEligible === true && closure.proof, "current-time signed official closure admission failed");
    const positiveMeta = structuredClone(meta.value);
    positiveMeta.currentListPolicy.officialClosedSchedule = closure;
    assert.deepEqual(withoutClosure(positiveMeta), withoutClosure(meta.value));
    positiveMetaBytes = Buffer.from(JSON.stringify(positiveMeta, null, 2) + "\n");
    fs.writeFileSync(metaPath, positiveMetaBytes);
    const env = { ...request.flags, TZ: "UTC", LANG: "C.UTF-8", SERVER_STORE_DIR: request.storeDir,
      DATA_STORE_DIR: request.storeDir, UNRESOLVED_MATCH_ARCHIVE_PATH: path.join(request.storeDir, "matches-unresolved-archive.json"),
      SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH: trustRegistryPath,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "C:\\Windows" } : {}) };
    const validator = path.join(ROOT, "scripts", "validateData.cjs");
    for (const scope of [false, true]) report.positive.push(runValidator(validator, scope, env, true));
    report.baseline = [false, true].map(scope => runValidator(baselineValidatorPath, scope, env, false, /matches-current\.json must contain a non-empty array/));
    report.baselineRejected = report.baseline.every(row => row.passed);
    function negative(name, mutate, pattern) {
      try {
        const altered = structuredClone(positiveMeta);
        mutate(altered);
        fs.writeFileSync(metaPath, JSON.stringify(altered, null, 2) + "\n");
        report.negative.push({ name, syntheticMutationOfCandidateOnly: true,
          validators: [false, true].map(scope => runValidator(validator, scope, env, false, pattern)) });
      } finally { restoreCurrent(); fs.writeFileSync(metaPath, positiveMetaBytes); }
    }
    negative("expired-envelope-with-unchanged-signed-payloads", altered => {
      altered.currentListPolicy.officialClosedSchedule.proof.snapshot.capturedAt = new Date(Date.now() - 21 * 60000).toISOString();
    }, /closure-envelope-clock-invalid/);
    negative("tampered-collector-signature", altered => {
      const attestation = altered.currentListPolicy.officialClosedSchedule.proof.snapshot.endpoints[0].collectorAttestation;
      attestation.signature = (attestation.signature[0] === "A" ? "B" : "A") + attestation.signature.slice(1);
    }, /signature-invalid/);
    negative("missing-current-file", () => {
      ensure(!fs.existsSync(missingPath), "negative scratch collision");
      fs.renameSync(currentPath, missingPath); currentMoved = true;
    }, /explicit matches-current\.json empty array/);
    report.finalClosureAudit = auditPublishedOfficialClosedSchedule(positiveMeta, { trustRegistryPath, asOf: new Date().toISOString() });
    ensure(report.finalClosureAudit.emptyCurrentIntegrityEligible, "closure expired before proof completion");
    ensure(inspectFile(relayPath).sha256 === report.relay.sha256 && inspectFile(trustRegistryPath).sha256 === report.registry.sha256,
      "relay or trusted registry changed during proof");
    assert.deepEqual(withoutClosure(JSON.parse(fs.readFileSync(metaPath, "utf8"))), withoutClosure(meta.value));
    report.finalData = inventory();
    const omitMeta = value => ({ directories: value.directories, files: value.files.filter(row => row.path !== "public/data/sync-meta.json") });
    assert.deepEqual(omitMeta(report.finalData), omitMeta(report.originalData));
    ensure(hash(fs.readFileSync(metaPath)) === hash(positiveMetaBytes), "candidate metadata changed unexpectedly");
    report.dataIntegrityPreserved = true;
    report.allowedDataChange = "Only currentListPolicy.officialClosedSchedule was replaced in candidate sync-meta.json; original clocks, source cycle, fixtures, history, archive and odds bytes are preserved.";
    report.ok = true; success = true;
  } catch (error) {
    report.failure = { message: error.message || String(error), code: error.code || null,
      ...(error.validation ? { validation: error.validation } : {}) };
  } finally {
    try {
      restoreCurrent();
      if (!success && originalMetaBytes) fs.writeFileSync(metaPath, originalMetaBytes);
      if (!success && report.originalData) {
        report.finalData = inventory();
        report.dataIntegrityPreserved = JSON.stringify(report.finalData) === JSON.stringify(report.originalData);
      }
    } catch (error) {
      report.ok = false; report.dataIntegrityPreserved = false;
      report.restoreFailure = error.message || String(error);
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  return report;
}
module.exports = { prove, VERSION };
if (require.main === module) {
  try {
    ensure(process.argv.length === 6 && process.argv[2] === "--input" && process.argv[4] === "--output",
      "usage: node scripts/proveOfficialClosureRepair.cjs --input CANDIDATE_INPUT.json --output NEW_CANDIDATE_PROOF.json");
    const report = prove(path.resolve(process.argv[3]), path.resolve(process.argv[5]));
    console.log(JSON.stringify({ ok: report.ok, version: report.version, capsuleSha256: report.capsuleSha256,
      proofPath: process.argv[5], dataIntegrityPreserved: report.dataIntegrityPreserved, failure: report.failure || null }));
    if (!report.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message || String(error)); process.exitCode = 1; }
}
