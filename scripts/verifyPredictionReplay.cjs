"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const { createPredictionExecutionCapture } = require("./predictionExecutionCapture.cjs");
const { rebuildPublishedPredictionModel } = require("./syncData.cjs");
const { replayBatch } = require("./replayPredictionCapture.cjs");
const { predictionRuntimeIdentity, completeRuntimeIdentity, comparePredictionRuntimes } = require("../src/services/predictionRuntimeIdentity.cjs");
const root = path.resolve(__dirname, ".."), hash = value => crypto.createHash("sha256").update(value).digest("hex");
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
const dir = fs.mkdtempSync(path.join(root, "outputs", "prediction-replay-test-"));
const collector = createPredictionExecutionCapture(new Date().toISOString());
rebuildPublishedPredictionModel({ sourceMatchId: "independent-replay-fixture", kickoffTime: "2099-09-09T03:00:00+08:00", status: "SCHEDULED",
  homeTeamName: "Synthetic Home", awayTeamName: "国际米兰", leagueName: "欧洲冠军联赛",
  odds: { odds1: 2.1, oddsX: 3.4, odds2: 3.3 }, oddsSource: "sporttery:HAD" }, null, collector);
const stored = collector.persist(dir); assert.equal(stored.persisted, true);
const originalFile = path.join(dir, "prediction-execution-captures", stored.sha256 + ".json.gz");
const originalBatch = JSON.parse(zlib.gunzipSync(fs.readFileSync(originalFile)));
const names = ["syncData.cjs", "predictionExecutionCapture.cjs", "competitionModelContext.cjs", "../src/services/predictionExecutionClock.cjs", "../src/services/modelInputUsage.cjs", "../src/services/predictionRuntimeIdentity.cjs"];
const baseManifest = { capture: stored, sourceHashes: Object.fromEntries(names.map(name => [name, hash(fs.readFileSync(path.resolve(__dirname, name)))])) };
let serial = 0, checks = 0;
const check = (name, callback) => { callback(); checks++; };
function sample(mutate = () => {}) {
  const batch = structuredClone(originalBatch), manifest = structuredClone(baseManifest); mutate(batch, manifest);
  const raw = Buffer.from(JSON.stringify(batch)); manifest.capture.sha256 = hash(raw);
  const file = path.join(dir, `${++serial}.json.gz`), report = path.join(dir, `${serial}.manifest.json`);
  fs.writeFileSync(file, zlib.gzipSync(raw), { flag: "wx" }); fs.writeFileSync(report, JSON.stringify(manifest), { flag: "wx" });
  return { file, report };
}
const rehash = record => { const { contentHash, ...body } = record; void contentHash; record.contentHash = hash(JSON.stringify(body)); };
check("actual executable identity is complete and compares exactly", () => {
  const current = predictionRuntimeIdentity(); assert.ok(completeRuntimeIdentity(current));
  assert.equal(comparePredictionRuntimes(current, structuredClone(current)).compatible, true);
  for (const key of ["node", "v8", "platform", "arch", "timezone", "executableSha256"]) {
    assert.equal(comparePredictionRuntimes(current, { ...current, [key]: "changed" }).compatible, false);
  }
});
check("fresh independent child replays complete actual model output", () => {
  const s = sample(), child = spawnSync(process.execPath, [path.join(__dirname, "replayPredictionCapture.cjs"), s.file, s.report],
    { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.strictReplayPassed, true); assert.equal(result.replayed, 1); assert.equal(result.exact, 1);
  assert.equal(result.wallClockReads, 0); assert.equal(result.providerRequests, 0); assert.equal(result.fullOutputFieldsIgnored, 0);
});
check("outer batch corruption cannot become a replay sample", () => {
  const s = sample(); fs.writeFileSync(s.file, zlib.gzipSync("{}")); assert.throws(() => replayBatch(s.file, s.report), /batch content hash invalid/);
});
check("record corruption is rejected even when outer batch hash matches", () => {
  const s = sample(batch => { batch.records[0].modelVersion = "changed"; });
  assert.throws(() => replayBatch(s.file, s.report), /record identity invalid/);
});
check("inner input hash is independently validated", () => {
  const s = sample(batch => { const r = batch.records[0]; r.input.odds.odds1 = 7; rehash(r); });
  assert.throws(() => replayBatch(s.file, s.report), /input or output hash invalid/);
});
check("changed expected output is a failed comparison, not corrected automatically", () => {
  const s = sample(batch => { const r = batch.records[0]; r.output.probabilityModel.oneXTwo.final.home += 1;
    r.outputHash = hash(JSON.stringify(r.output)); rehash(r); });
  const result = replayBatch(s.file, s.report); assert.equal(result.ok, false); assert.equal(result.strictReplayPassed, false);
  assert.equal(result.exact, 0); assert.ok(result.reports[0].differences.length > 0);
});
check("runtime mismatch is rejected before comparing outputs", () => {
  const s = sample(batch => { batch.runtime.v8 = "different-engine"; });
  assert.throws(() => replayBatch(s.file, s.report), /runtime-identity-mismatch/);
  const diagnostic = replayBatch(s.file, s.report, { crossRuntimeDiagnostic: true });
  assert.equal(diagnostic.ok, true); assert.equal(diagnostic.strictReplayPassed, false); assert.equal(diagnostic.nominationAllowed, false);
});
check("legacy missing executable identity stays incomplete", () => {
  const s = sample(batch => { delete batch.runtime.executableSha256; });
  assert.throws(() => replayBatch(s.file, s.report), /runtime-identity-incomplete/);
});
check("captured implementation changes are rejected", () => {
  const s = sample((_batch, manifest) => { manifest.sourceHashes["syncData.cjs"] = "0".repeat(64); });
  assert.throws(() => replayBatch(s.file, s.report), /implementation mismatch/);
});
check("duplicate events cannot inflate the paired denominator", () => {
  const s = sample((batch, manifest) => { batch.records.push(structuredClone(batch.records[0])); batch.captured = 2; manifest.capture.captured = 2; });
  assert.throws(() => replayBatch(s.file, s.report), /duplicate event/);
});
check("missing historical clock transcript is not synthesized", () => {
  const s = sample(batch => { const r = batch.records[0]; delete r.output.probabilityModel.executionClock;
    r.outputHash = hash(JSON.stringify(r.output)); rehash(r); });
  assert.throws(() => replayBatch(s.file, s.report), /original clock transcript required/);
});
check("clock transcript cannot precede the actual execution interval", () => {
  const s = sample(batch => { const r = batch.records[0], clock = r.output.probabilityModel.executionClock;
    clock.events[0].millis = Date.parse(r.startedAt) - 1; rehash(clock); r.outputHash = hash(JSON.stringify(r.output)); rehash(r); });
  assert.throws(() => replayBatch(s.file, s.report), /outside actual execution/);
});
check("non-boolean diagnostic request is not treated as permission", () => {
  const s = sample(); assert.throws(() => replayBatch(s.file, s.report, { crossRuntimeDiagnostic: "true" }), /explicit diagnostic/);
});
console.log(JSON.stringify({ ok: true, verifier: "independent-prediction-replay-v1", checks, productionDataTouched: false,
  providerRequests: 0, fullOutputFieldsIgnored: 0, independentChildRuns: 1, runtime: predictionRuntimeIdentity(), fixtureDirectory: dir }, null, 2));
