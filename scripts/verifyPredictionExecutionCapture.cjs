"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto");
const { createPredictionExecutionCapture: capture, LIMITS, encode, decode } = require("./predictionExecutionCapture.cjs");
const { rebuildPublishedPredictionModel } = require("./syncData.cjs");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
const dir = fs.mkdtempSync(path.join(root, "outputs", "execution-capture-test-"));
let checks = 0;
const check = (name, test) => { test(); checks++; };
const now = () => new Date().toISOString();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fixture = () => ({ id: "sporttery_capture-fixture", sourceMatchId: "capture-fixture", kickoffTime: "2099-09-09T03:00:00+08:00", status: "SCHEDULED",
  homeTeamName: "Synthetic Home", awayTeamName: "国际米兰", leagueName: "欧洲冠军联赛",
  odds: { odds1: 2.1, oddsX: 3.4, odds2: 3.3 }, oddsSource: "sporttery:HAD",
  formSnapshot: { sampleSize: 24, home: { sampleSize: 12, goalsForAvg: 1.92, goalsAgainstAvg: 1.08 }, away: { sampleSize: 12, goalsForAvg: 2.25, goalsAgainstAvg: 1.17 } } });
const scorer = () => ({ probabilityModel: { version: "fixture", generatedAt: now() }, predictions: [] });
const collector = capture(now()); let result, saved;
check("actual private rebuild captures exact normalized input and executed output", () => {
  const row = fixture(), before = JSON.stringify(row);
  result = rebuildPublishedPredictionModel(row, null, collector);
  assert.equal(collector.summary().captured, 1); assert.equal(JSON.stringify(row), before);
  saved = collector.persist(dir); assert.equal(saved.persisted, true);
  const body = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, "prediction-execution-captures", saved.sha256 + ".json.gz"))));
  const record = body.records[0];
  assert.deepEqual(record.input.formSnapshot, row.formSnapshot); assert.equal(record.input.awayTeam, "国际米兰");
  assert.ok(require("node:util").isDeepStrictEqual(decode(record.output).probabilityModel, result.probabilityModel), "captured model including undefined must equal actual return value");
  assert.equal(record.inputHash, hash(JSON.stringify(record.input))); assert.equal(record.outputHash, hash(JSON.stringify(record.output)));
  const { contentHash, ...payload } = record; assert.equal(contentHash, hash(JSON.stringify(payload)));
  assert.equal(record.productionEligible, false); assert.equal(record.sourceVerified, false);
  assert.equal(JSON.stringify(result).includes("prediction-execution-record"), false);
});
check("persist is idempotent and does not overwrite the same captured batch", () => {
  const again = collector.persist(dir); assert.equal(again.sha256, saved.sha256); assert.equal(again.duplicate, true);
});
check("capture callback returns the exact scorer object and executes it once", () => {
  const c = capture(now()); let calls = 0; const output = scorer();
  const returned = c.run(fixture(), () => { calls++; output.probabilityModel.generatedAt = now(); return output; });
  assert.equal(returned, output); assert.equal(calls, 1);
});
check("scorer failure is not swallowed or retried", () => {
  let calls = 0; assert.throws(() => capture(now()).run(fixture(), () => { calls++; throw new Error("scorer-failed"); }), /scorer-failed/); assert.equal(calls, 1);
});
for (const [key, value] of [["apiKey", "fake-secret"], ["authorization", "fake-secret"], ["url", "https://example.test/?api_key=fake"]]) check("sensitive input rejected without retaining value: " + key, () => {
  const c = capture(now()), output = c.run({ ...fixture(), [key]: value }, scorer);
  assert.ok(output.probabilityModel); assert.equal(c.summary().captured, 0);
  assert.equal(c.summary().skipped["sensitive-input-rejected"], 1); assert.equal(JSON.stringify(c.summary()).includes(value), false);
});
check("oversized evidence does not block scoring", () => {
  const c = capture(now()); assert.ok(c.run({ ...fixture(), padding: "x".repeat(LIMITS.recordBytes + 1) }, scorer));
  assert.equal(c.summary().skipped["record-size-limit"], 1);
});
check("mutation during scorer execution is rejected as retrospective input", () => {
  const c = capture(now()); c.run(fixture(), input => { input.odds.odds1 = 9; return scorer(); });
  assert.equal(c.summary().skipped["input-mutated-during-calculation"], 1);
});
check("past or ambiguous kickoff and result-phase rows cannot become prematch captures", () => {
  for (const change of [{ kickoffTime: "2020-01-01T00:00:00Z" }, { kickoffTime: "2099-02-30T00:00:00Z" }, { status: "FINISHED" }]) {
    const c = capture(now()); c.run({ ...fixture(), ...change }, scorer); assert.equal(c.summary().skipped["not-strict-prematch"], 1);
  }
});
check("invalid model execution clock is excluded", () => {
  const c = capture(now()); c.run(fixture(), () => ({ probabilityModel: { generatedAt: "2000-01-01T00:00:00Z" } }));
  assert.equal(c.summary().skipped["executed-model-clock-invalid"], 1);
});
check("locked matches do not acquire new replay records", () => {
  const row = { ...fixture(), kickoffTime: "2020-01-01T00:00:00Z", status: "FINISHED" }, c = capture(now());
  const returned = rebuildPublishedPredictionModel(row, null, c);
  assert.equal(returned, row); assert.equal(c.summary().attempted, 0);
});
check("missing storage reports failure, not successful persistence", () => assert.equal(collector.persist(path.join(dir, "absent-parent")).persisted, false));
check("unknown store files are preserved and cause an explicit refusal", () => {
  const other = fs.mkdtempSync(path.join(dir, "unknown-")); fs.mkdirSync(path.join(other, "prediction-execution-captures"));
  const file = path.join(other, "prediction-execution-captures", "retain.txt"); fs.writeFileSync(file, "retained");
  assert.equal(collector.persist(other).reason, "unexpected-store-entry"); assert.equal(fs.readFileSync(file, "utf8"), "retained");
});
check("busy writer is not removed or retried", () => {
  const other = fs.mkdtempSync(path.join(dir, "busy-")); fs.mkdirSync(path.join(other, "prediction-execution-captures"));
  const lock = path.join(other, "prediction-execution-captures", ".writer.lock"); fs.writeFileSync(lock, "another-writer");
  assert.equal(collector.persist(other).reason, "private-store-busy"); assert.equal(fs.readFileSync(lock, "utf8"), "another-writer");
});
check("per-batch record cap is explicit without skipping the scorer", () => {
  const c = capture(now()); let count = 0;
  for (let i = 0; i < LIMITS.records + 1; i++) c.run(fixture(), () => { count++; return scorer(); });
  assert.equal(count, LIMITS.records + 1); assert.equal(c.summary().captured, LIMITS.records);
  assert.equal(c.summary().skipped["batch-record-limit"], 1);
});
check("undefined remains distinct from null and absent properties after exact round trip", () => {
  const original = { explicit: undefined, blank: null, list: [undefined, null] };
  const restored = decode(JSON.parse(encode(original)));
  assert.deepEqual(restored, original); assert.equal(Object.hasOwn(restored, "explicit"), true);
  assert.equal(Object.hasOwn(restored, "absent"), false);
});
check("unsupported or marker-colliding values are excluded rather than changed silently", () => {
  for (const value of [{ $predictionExecutionUndefined: 1 }, { date: new Date() }, { value: () => 0 }, { value: NaN }, { value: new Array(1) }]) assert.throws(() => encode(value));
});
check("captured historical file corruption is detected and never overwritten", () => {
  const file = path.join(dir, "prediction-execution-captures", saved.sha256 + ".json.gz"), changed = zlib.gzipSync("corrupted-fixture");
  fs.writeFileSync(file, changed);
  assert.equal(collector.persist(dir).reason, "existing-capture-mismatch");
  assert.ok(fs.readFileSync(file).equals(changed));
});
check("store byte cap is enforced before writing without allocating a full disk", () => {
  const other = fs.mkdtempSync(path.join(dir, "capacity-")), folder = path.join(other, "prediction-execution-captures");
  fs.mkdirSync(folder); const file = path.join(folder, "0".repeat(64) + ".json.gz"); fs.writeFileSync(file, "capacity-fixture");
  const original = fs.lstatSync;
  try {
    fs.lstatSync = (target, ...args) => target === file ? { size: LIMITS.storeBytes, isFile: () => true, isSymbolicLink: () => false } : original(target, ...args);
    assert.equal(collector.persist(other).reason, "private-store-capacity-limit");
    assert.deepEqual(fs.readdirSync(folder), [path.basename(file)]);
  } finally { fs.lstatSync = original; }
});
check("calculation crossing kickoff cannot acquire a prematch capture", () => {
  const RealDate = Date; let clock = RealDate.parse("2098-01-01T00:00:00Z");
  class TestDate extends RealDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  try {
    globalThis.Date = TestDate;
    const c = capture(now()), row = { ...fixture(), kickoffTime: new RealDate(clock + 1).toISOString() };
    c.run(row, () => { clock += 2; return scorer(); });
    assert.equal(c.summary().skipped["cutoff-crossed-during-calculation"], 1);
  } finally { globalThis.Date = RealDate; }
});
check("sensitive output does not prevent returning original result", () => {
  const c = capture(now()), output = c.run(fixture(), () => ({ ...scorer(), apiKey: "synthetic-output-secret" }));
  assert.equal(output.apiKey, "synthetic-output-secret"); assert.equal(c.summary().skipped["sensitive-input-rejected"], 1);
  assert.equal(c.summary().captured, 0);
});
console.log(JSON.stringify({ ok: true, verifier: "prediction-execution-capture-v1", checks, fixtureDirectory: dir,
  productionDataTouched: false, providerRequests: 0, scope: "actual rebuild boundary plus bounded private JSON evidence; not deterministic full replay or source attestation" }, null, 2));
