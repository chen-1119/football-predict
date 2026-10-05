"use strict";
// Local-only follow-up receipt. Never regenerates or relaxes the old receipt.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { analyzeCapture } = require("./historyRegressionAdmission.cjs");
const { summarizePublishedHistory, runHistoryRegressionReplay, FEATURE_CONTRACT } = require("./historyRegressionReplay.cjs");
const ROOT = path.resolve(__dirname, "..");
const BASE = "2d20938a13463294977696cc2fcef92bc746c902";
const OLD = "outputs/history-regression-20261002";
const CHANGED_OLD_FILES = new Set(["scripts/historyRegressionReplay.cjs", "tests/history-regression-replay.test.cjs"]);
const TEST_FILES = ["tests/history-regression-admission.test.cjs", "tests/history-regression-replay.test.cjs", "tests/history-regression-feature-admission.test.cjs"];
const CODE_FILES = [".gitattributes", "scripts/historyRegressionReplay.cjs", "src/services/strictInstant.cjs", "scripts/historyRegressionAdmission.cjs",
  "scripts/historyRegressionFeatureVerification.cjs", ...TEST_FILES, "docs/history-regression-feature-admission-20261002.md"];
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const read = relative => fs.readFileSync(path.join(ROOT, relative));
const json = relative => JSON.parse(read(relative));
const binding = relative => { const bytes = read(relative); return { path: relative.replaceAll("\\", "/"), bytes: bytes.length, sha256: sha(bytes) }; };
const writeNew = (relative, value) => fs.writeFileSync(path.join(ROOT, relative), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

function verify(dir, { writeReceipt = false } = {}) {
  const absolute = path.resolve(dir);
  assert(absolute.startsWith(ROOT + path.sep), "Output must be inside this worktree");
  const out = path.relative(ROOT, absolute).replaceAll("\\", "/");
  const receiptPath = `${out}/verification-receipt.json`;
  let receipt;
  if (!writeReceipt) {
    receipt = json(receiptPath);
    assert.equal(receipt.version, "history-feature-admission-verification-v2");
    for (const file of receipt.files) assert.deepEqual(binding(file.path), file, `Changed follow-up file: ${file.path}`);
  } else assert(!fs.existsSync(path.join(ROOT, receiptPath)), "Follow-up receipt already exists");

  const oldReceiptPath = `${OLD}/delivery-receipt.json`;
  const committedReceipt = execFileSync("git", ["show", `${BASE}:${oldReceiptPath}`], { cwd: ROOT });
  assert.deepEqual(read(oldReceiptPath), committedReceipt, "Old receipt must retain its exact original bytes");
  const oldReceipt = JSON.parse(committedReceipt);
  for (const file of oldReceipt.files) {
    // Audit prior code against its original commit, not the new implementation.
    const bytes = CHANGED_OLD_FILES.has(file.path)
      ? execFileSync("git", ["show", `${BASE}:${file.path}`], { cwd: ROOT }) : read(file.path);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha(bytes), file.sha256, file.path);
  }
  const admission = json(`${OLD}/admission-v3.json`), capture = json(`${OLD}/online-sample-v3.json`);
  const rawResponseBytes = read(`${OLD}/online-sample-v3.json.remote-response.json`);
  const priorBytes = fs.readFileSync(admission.inputs.priorReceipt.path);
  assert.equal(sha(priorBytes), admission.inputs.priorReceipt.sha256);
  const prior = JSON.parse(priorBytes);
  const fresh = analyzeCapture(capture, { rawResponseBytes, expectedPublication: prior.publication, expectedManifestFileSha256: prior.manifestFileSha256 });
  assert.deepEqual(fresh.records, admission.records);
  assert.deepEqual(fresh.originalRecords, admission.originalRecords);
  assert.deepEqual(fresh.funnel, admission.funnel);
  const config = json("docs/history-regression-protocol.json");
  const review = summarizePublishedHistory(fresh.records, { source: admission.source, timeZone: config.timeZone, bootstrap: config.bootstrap });
  assert.deepEqual(review, json(`${OLD}/report/review.json`), "Entire original frozen report must be identical, including events and intervals");
  const replay = runHistoryRegressionReplay(fresh.records, { ...config, source: { ...admission.source, ...config.source } });
  const oldReplay = json(`${OLD}/report/replay.json`);
  assert.deepEqual(replay.selection, oldReplay.selection);
  assert.deepEqual(replay.validation, oldReplay.validation);
  assert.deepEqual(replay.finalTest, oldReplay.finalTest);
  assert.deepEqual(replay.folds.map(f => ({ counts: f.counts, membership: f.membership, evaluation: f.evaluation })), oldReplay.folds.map(f => ({ counts: f.counts, membership: f.membership, evaluation: f.evaluation })));
  assert.equal(capture.rows.length, 432); assert.equal(fresh.originalRecords.length, 180); assert.equal(review.rows, 154);
  assert.equal(replay.selection.selectedCandidate, null); assert.equal(replay.productionEligible, false);
  assert.deepEqual(replay.folds.map(f => f.counts.train.used), [0, 2]); assert.equal(replay.finalTest.rows, 47);

  const independentBefore = json(`${out}/before-final3.json`);
  const independentAfter = json(`${out}/after-final3.json`);
  assert.equal(independentBefore.oldReceiptSha256, sha(committedReceipt));
  assert.equal(independentAfter.oldReceiptSha256, sha(committedReceipt));
  assert.equal(independentAfter.externalSourcesUnchanged, true);
  assert.equal(independentBefore.externalSourcesUnchanged, true);
  assert.equal(independentAfter.implementationUnchanged, true);
  assert.equal(independentBefore.evidenceHead, BASE); assert.equal(independentAfter.evidenceHead, BASE);
  assert.equal(independentBefore.exitCode, 1); assert(independentBefore.counts.fail >= 2);
  assert.equal(independentAfter.exitCode, 0); assert.equal(independentAfter.counts.fail, 0);
  assert.equal(independentAfter.counts.tests, independentAfter.counts.pass);
  assert.deepEqual(independentBefore.externalSources, independentAfter.externalSources);
  assert.deepEqual(independentBefore.externalOrigins, independentAfter.externalOrigins);
  const independentFiles = independentAfter.externalSources.map(source => {
    const file = path.resolve(source.path);
    const snapshotRelative = path.relative(path.join(ROOT, out), file).replaceAll("\\", "/");
    assert(/^external-snapshot-[a-f0-9]{12}\/(?:tests|scripts)\/[^/]+\.cjs$/.test(snapshotRelative), "Independent suite must use the local immutable snapshot");
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    assert.equal(binding(relative).sha256, source.sha256);
    assert(independentAfter.externalOrigins.some(origin => origin.sha256 === source.sha256), "Snapshot must match its original source bytes");
    return relative;
  });
  assert.equal(independentAfter.implementationReplaySha256, binding("scripts/historyRegressionReplay.cjs").sha256);
  assert.equal(independentAfter.strictInstantSha256, binding("src/services/strictInstant.cjs").sha256);
  const result = {
    sourceRows: capture.rows.length, frozenProbabilityRows: fresh.originalRecords.length, pairedRows: review.rows,
    fullFrozenReportIdentical: true, frozenReportHash: review.reportHash,
    metrics: Object.fromEntries(Object.entries(review.metrics).map(([name, m]) => [name, { brier: m.brier, logLoss: m.logLoss, accuracy: m.accuracy }])),
    trainingTimeValidRows: replay.folds.map(f => f.counts.train.used), finalTestRows: replay.finalTest.rows,
    featureContract: FEATURE_CONTRACT, rawResponseSha256: sha(rawResponseBytes),
    originalInputsAndReportsUnchanged: true, oldReceiptUnchanged: true,
    productionEligible: false, productionWrites: false, productionRecaptured: false,
  };
  if (writeReceipt) {
    const args = ["--test", "--test-reporter=tap", ...TEST_FILES];
    const testRun = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(testRun.error);
    const counts = Object.fromEntries(["tests", "pass", "fail", "skipped"].map(key => [key, Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(testRun.stdout)?.[1])]));
    assert.equal(testRun.status, 0, testRun.stdout + testRun.stderr);
    assert.equal(counts.fail, 0); assert.equal(counts.tests, counts.pass); assert(counts.pass >= 33);
    const testResult = { version: "history-feature-admission-local-tests-v1", executedAt: new Date().toISOString(), command: [process.execPath, ...args],
      nodeVersion: process.version, exitCode: testRun.status, counts, syntheticOnly: true,
      files: CODE_FILES.map(binding), stdout: testRun.stdout, stderr: testRun.stderr };
    writeNew(`${out}/local-test-results.json`, testResult);
    const files = [...new Set([...CODE_FILES, oldReceiptPath, ...oldReceipt.files.filter(f => !CHANGED_OLD_FILES.has(f.path)).map(f => f.path),
      ...independentFiles, `${out}/before-final3.json`, `${out}/after-final3.json`, `${out}/local-test-results.json`])].map(binding);
    receipt = { version: "history-feature-admission-verification-v2", verifiedAt: new Date().toISOString(), baseCommit: BASE,
      scope: "New candidate feature admission acceptance; does not rewrite or extend old receipt acceptance",
      result, tests: { local: counts, independentBefore: independentBefore.counts, independentAfter: independentAfter.counts,
        meaning: "Synthetic safety cases are software evidence, not model improvement. Independent suite also revalidates original real frozen evidence." }, files };
    writeNew(receiptPath, receipt);
  } else assert.deepEqual(result, receipt.result);
  return { ok: true, receiptPath, ...result, tests: receipt.tests };
}
if (require.main === module) {
  const [dir, flag] = process.argv.slice(2);
  assert(dir && (!flag || flag === "--write-receipt"), "Usage: node scripts/historyRegressionFeatureVerification.cjs OUTPUT_DIR [--write-receipt]");
  console.log(JSON.stringify(verify(dir, { writeReceipt: flag === "--write-receipt" })));
}
module.exports = { verify };
