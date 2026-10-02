"use strict";
// Revalidates previously captured ONLINE bytes. Synthetic tests are kept apart.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const api = require(path.join(root, "scripts/prospectiveDataCoverage.cjs"));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const history = path.resolve(root, "../05-history-regression/outputs/history-regression-20261002");
const sources = [
  { path: path.join(history, "online-sample-v3.json"), sha256: "151a20c0678b89ec41d0555f06149be75182beba0dbc17cd4a1b5a76435470e1" },
  { path: "C:/Users/86188/.codex/worktrees/football-release-oct02/football/outputs/online-validation-20261002/online-validation-inputs-receipt.json", sha256: "e6d9c19aebdf561c77449a4d50d1d019b40ea0d375bba0373e40de401901d42b" },
  { path: path.join(history, "online-sample-v3.json.remote-response.json"), sha256: "6ed9802d2a9e43930ed5db44a7f7b809145eed8908d8af47770e77a93dddd507" },
];
for (const source of sources) assert.equal(sha(fs.readFileSync(source.path)), source.sha256);
const tests = spawnSync(process.execPath, ["--test", "scripts/prospectiveDataCoverage.test.cjs"], { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(__dirname, "test-results.txt"), tests.stdout + tests.stderr);
assert.equal(tests.status, 0, tests.stdout + tests.stderr);
const check = spawnSync(process.execPath, ["--check", "scripts/prospectiveDataCoverage.cjs"], { cwd: root, encoding: "utf8" });
assert.equal(check.status, 0, check.stderr);
const output = path.join(__dirname, "coverage-final.json");
const summary = api.main(["report", ...sources.map(item => item.path), output]);
const report = JSON.parse(fs.readFileSync(output));
assert.deepEqual(report.inputs.map(item => item.sha256), sources.map(item => item.sha256));
assert.equal(report.funnel.selected, 432);
assert.equal(report.funnel.sameDecisionPaired, 154);
assert.equal(report.funnel.frozenProbabilityScorable, 180);
assert.equal(report.funnel.featureReplayEligible, 0);
assert.equal(report.cohorts.allSelected.form.exportOmitted, 355);
assert.equal(report.cohorts.allSelected.form.valuePresent, 24);
assert.equal(report.cohorts.allSelected.form.snapshotEvidenceMissing, 53);
assert.equal(report.cohorts.allSelected.injuries.sourceSnapshotMissing, 379);
assert.equal(report.cohorts.allSelected.injuries.snapshotEvidenceMissing, 53);
assert.equal(report.rows.length, 432);
assert.equal(report.productionEligible, false);
const capture = JSON.parse(fs.readFileSync(sources[0].path)), prior = JSON.parse(fs.readFileSync(sources[1].path)), raw = fs.readFileSync(sources[2].path);
capture.rows[0].snapshot = null;
assert.throws(() => api.coverageReport(capture, prior, raw), /CAPTURE_DIFFERS_FROM_RAW_RESPONSE/);
const wrongRaw = Buffer.from(raw); wrongRaw[0] = 0;
assert.throws(() => api.coverageReport(JSON.parse(fs.readFileSync(sources[0].path)), prior, wrongRaw), /RAW_RESPONSE_HASH_MISMATCH/);
for (const source of sources) assert.equal(sha(fs.readFileSync(source.path)), source.sha256);
const receipt = { version: "prospective-data-coverage-verification-v1", verifiedAt: new Date().toISOString(), runtime: process.version,
  productionWrites: false, liveSourceRecaptured: false, modelPromoted: false, newLiveFieldReceipts: 0,
  originalOnlineInputsUnchanged: true, sources, syntheticTests: { passed: Number(/# pass (\d+)/.exec(tests.stdout)[1]), failed: 0,
    meaning: "Software contract tests only; not model accuracy or live field acquisition evidence." },
  realExport: { envelopeVerified: true, previousPublicationMatched: true, rawHashRevalidated: true, tamperingRejected: true, funnel: report.funnel },
  artifacts: ["scripts/prospectiveDataCoverage.cjs", "scripts/prospectiveDataCoverage.test.cjs",
    "outputs/prospective-data-coverage-20261002/coverage-final.json", "outputs/prospective-data-coverage-20261002/test-results.txt"]
    .map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(root, file))) })),
  limitations: ["Not deployed or connected to live collectors.", "Local retention and declared authorization do not replace signed collector/source approval.",
    "Recovered export bytes cannot fabricate historical clocks or change frozen decisions.", "Intermediate coverage.json is superseded by coverage-final.json."] };
fs.writeFileSync(path.join(__dirname, "verification-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ verification: "passed", syntheticTests: receipt.syntheticTests, ...summary }, null, 2));
