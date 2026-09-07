"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib"), assert = require("node:assert/strict");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sameHash = (value, bytes) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && value === hash(bytes);
const boundedRead = (file, limit) => {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, "bounded regular file required");
  return fs.readFileSync(file);
};
function validateRecord(record, cycleAt) {
  const { contentHash, ...body } = record;
  assert.ok(record.version === "prediction-execution-record-v1" && record.encoding === "json-with-explicit-undefined-v1"
    && record.productionEligible === false && record.sourceVerified === false && sameHash(contentHash, JSON.stringify(body)), "record identity invalid");
  assert.ok([record.cycleAt, record.startedAt, record.finishedAt, record.kickoffTime].every(strictInstant)
    && record.cycleAt === cycleAt && Date.parse(record.cycleAt) <= Date.parse(record.startedAt)
    && Date.parse(record.startedAt) <= Date.parse(record.finishedAt)
    && Date.parse(record.finishedAt) < Date.parse(record.kickoffTime), "record clocks invalid");
  assert.ok(sameHash(record.inputHash, JSON.stringify(record.input)) && sameHash(record.outputHash, JSON.stringify(record.output)), "input or output hash invalid");
  const { decode, encode } = require("./predictionExecutionCapture.cjs");
  const input = decode(record.input), output = decode(record.output);
  assert.ok(encode(input) === JSON.stringify(record.input) && encode(output) === JSON.stringify(record.output), "lossless codec mismatch");
  assert.ok(input.sourceMatchId === record.sourceMatchId && typeof record.sourceMatchId === "string" && record.sourceMatchId.trim()
    && ["SCHEDULED", "TIMED", "PENDING", "NOT_STARTED"].includes(input.status)
    && input.kickoffTime === record.kickoffTime && output.probabilityModel?.version === record.modelVersion, "event or model identity mismatch");
  const clock = output.probabilityModel.executionClock;
  assert.ok(require("../src/services/predictionExecutionClock.cjs").verifyPredictionClock(clock), "original clock transcript required");
  assert.ok(clock.events.every(event => event.millis >= Date.parse(record.startedAt) && event.millis <= Date.parse(record.finishedAt)), "clock transcript outside actual execution");
  assert.ok(strictInstant(output.probabilityModel.generatedAt)
    && Date.parse(output.probabilityModel.generatedAt) >= Date.parse(record.startedAt)
    && Date.parse(output.probabilityModel.generatedAt) <= Date.parse(record.finishedAt), "model clock outside actual execution");
  return { input, output };
}
function outputDifferences(expected, actual, prefix = "output", result = []) {
  if (Object.is(expected, actual) || result.length >= 20) return result;
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) outputDifferences(expected[key], actual[key], `${prefix}.${key}`, result);
  } else {
    const brief = value => typeof value === "string" && value.length > 100 ? { stringLength: value.length, sha256: hash(value) } : value;
    result.push({ path: prefix, expected: brief(expected), actual: brief(actual) });
  }
  return result;
}
function replayBatch(inputPath, manifestPath, { crossRuntimeDiagnostic = false } = {}) {
  assert.equal(typeof crossRuntimeDiagnostic, "boolean", "explicit diagnostic flag must be boolean");
  const manifestBytes = boundedRead(manifestPath, 1024 * 1024), manifest = JSON.parse(manifestBytes);
  assert.ok(manifest.capture?.persisted === true && manifest.sourceHashes && typeof manifest.sourceHashes === "object", "captured source manifest required");
  const required = ["syncData.cjs", "predictionExecutionCapture.cjs", "competitionModelContext.cjs", "../src/services/predictionExecutionClock.cjs", "../src/services/modelInputUsage.cjs", "../src/services/predictionRuntimeIdentity.cjs"];
  const implementation = required.map(name => {
    const file = path.resolve(__dirname, name), bytes = fs.readFileSync(file);
    assert.ok(sameHash(manifest.sourceHashes[name], bytes), "captured implementation mismatch: " + name);
    return { name, sha256: hash(bytes), file };
  });
  const zipped = boundedRead(inputPath, 17 * 1024 * 1024), raw = zlib.gunzipSync(zipped, { maxOutputLength: 17 * 1024 * 1024 });
  assert.ok(sameHash(manifest.capture.sha256, raw), "capture batch content hash invalid");
  const batch = JSON.parse(raw);
  const { predictionRuntimeIdentity, comparePredictionRuntimes } = require("../src/services/predictionRuntimeIdentity.cjs");
  const runtime = predictionRuntimeIdentity(), runtimeComparison = comparePredictionRuntimes(batch.runtime, runtime);
  assert.ok(crossRuntimeDiagnostic || runtimeComparison.compatible, runtimeComparison.reason + ": " + runtimeComparison.mismatches.join(","));
  assert.ok(batch.version === "prediction-execution-capture-v1" && batch.productionEligible === false && batch.sourceVerified === false
    && Array.isArray(batch.records) && batch.records.length > 0 && batch.records.length <= 128
    && batch.captured === batch.records.length && manifest.capture.captured === batch.records.length, "batch contract invalid");
  const seen = new Set();
  const validated = batch.records.map(record => {
    const values = validateRecord(record, batch.cycleAt), key = `${record.sourceMatchId}|${record.kickoffTime}`;
    assert.ok(!seen.has(key), "duplicate event in capture batch"); seen.add(key);
    return { record, ...values };
  });
  // Fresh CLI processes load the scorer only after all original identities pass.
  const { replayPredictionWithClock } = require("./syncData.cjs"), { encode } = require("./predictionExecutionCapture.cjs");
  const RealDate = Date, originalFetch = globalThis.fetch;
  const http = require("node:http"), https = require("node:https"), net = require("node:net");
  const saved = [[http, "request"], [http, "get"], [https, "request"], [https, "get"], [net.Socket.prototype, "connect"]].map(([object, key]) => [object, key, object[key]]);
  let wallClockReads = 0, providerRequests = 0;
  const rejectNetwork = () => { providerRequests++; throw new Error("network request forbidden during replay"); };
  class NoWallDate extends RealDate {
    constructor(...args) { if (!args.length) { wallClockReads++; throw new Error("unrecorded wall clock read"); } super(...args); }
    static now() { wallClockReads++; throw new Error("unrecorded wall clock read"); }
  }
  const reports = [];
  try {
    globalThis.Date = NoWallDate; globalThis.fetch = rejectNetwork;
    for (const [object, key] of saved) object[key] = rejectNetwork;
    for (const { record, input, output } of validated) {
      const before = encode(input), replay = replayPredictionWithClock(input, output.probabilityModel.executionClock);
      assert.ok(encode(input) === before, "replay mutated captured input");
      const replayHash = hash(encode(replay));
      reports.push({ sourceMatchId: record.sourceMatchId, expectedHash: record.outputHash, replayHash, exact: replayHash === record.outputHash,
        differences: replayHash === record.outputHash ? [] : outputDifferences(output, replay) });
    }
  } finally {
    globalThis.Date = RealDate; globalThis.fetch = originalFetch;
    for (const [object, key, value] of saved) object[key] = value;
  }
  assert.ok(implementation.every(entry => hash(fs.readFileSync(entry.file)) === entry.sha256), "implementation changed during replay");
  assert.ok(fs.readFileSync(inputPath).equals(zipped) && fs.readFileSync(manifestPath).equals(manifestBytes), "capture input changed during replay");
  return { ok: reports.every(report => report.exact), version: "independent-process-prediction-replay-v1",
    runtime, runtimeComparison, crossRuntimeDiagnostic,
    strictReplayPassed: !crossRuntimeDiagnostic && runtimeComparison.compatible && reports.every(report => report.exact),
    batchHash: manifest.capture.sha256, manifestHash: hash(manifestBytes), capturedRuntime: batch.runtime,
    implementation: implementation.map(({ name, sha256 }) => ({ name, sha256 })),
    replayed: reports.length, exact: reports.filter(report => report.exact).length, fullOutputFieldsIgnored: 0,
    wallClockReads, providerRequests, productionDataTouched: false, sourceVerified: false, nominationAllowed: false,
    scope: "captured inputs with six implementation hashes and exact runtime binding; not complete dependency closure or production Linux verification", reports };
}
module.exports = { replayBatch, validateRecord };
if (require.main === module) {
  try {
    assert.ok(process.argv.length === 4 || process.argv.length === 5 && process.argv[4] === "--cross-runtime-diagnostic",
      "usage: node replayPredictionCapture.cjs CAPTURE.json.gz SOURCE_REPORT.json [--cross-runtime-diagnostic]");
    const result = replayBatch(process.argv[2], process.argv[3], { crossRuntimeDiagnostic: process.argv[4] === "--cross-runtime-diagnostic" });
    console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
