"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto");
const { createPredictionExecutionCapture: capture, LIMITS, captureStorageCapacity, predictionCaptureStorageHealth, encode, decode } = require("./predictionExecutionCapture.cjs");
const { rebuildPublishedPredictionModel } = require("./syncData.cjs");
const root = path.resolve(__dirname, "..");
// Signed candidates are read-only; synthetic fixtures belong in private system temp.
const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "football-execution-capture-test-"));
assert.equal(path.dirname(fs.realpathSync(dir)), fs.realpathSync(require("node:os").tmpdir()));
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
let retentionChecks = 0;
const retentionCheck = (name, test) => { check(name, test); retentionChecks++; };
const capacityInput = { files: 0, bytes: 0, nextBatchBytes: 767824, availableBytes: 100 * 1024 ** 3 };
retentionCheck("fixed bounded policy covers six calendar windows at the observed compressed size without preallocation", () => {
  const policy = captureStorageCapacity(capacityInput);
  assert.equal(policy.maxFiles, 60000); assert.equal(policy.maxBytes, 48 * 1024 ** 3);
  assert.equal(policy.freeReserveBytes, 8 * 1024 ** 3);
  assert.equal(policy.status, "ok"); assert.equal(policy.remainingBatches, 60000);
  assert.equal(policy.estimatedDaysAtFiveMinuteCadence, 208.3);
  assert.equal(policy.estimateAssumption.includes("not guaranteed"), true);
});
for (const [name, changes, reason] of [
  ["file limit", { files: LIMITS.storeFiles }, "private-store-capacity-limit"],
  ["byte limit", { bytes: LIMITS.storeBytes }, "private-store-capacity-limit"],
  ["free space reserve", { availableBytes: LIMITS.freeReserveBytes }, "private-store-disk-reserve"],
  ["oversized next write", { availableBytes: LIMITS.freeReserveBytes + capacityInput.nextBatchBytes - 1 }, "private-store-disk-reserve"],
]) retentionCheck(name + " refuses new evidence without deleting older evidence", () => {
  const policy = captureStorageCapacity({ ...capacityInput, ...changes });
  assert.equal(policy.status, "full"); assert.equal(policy.reason, reason); assert.equal(policy.remainingBatches, 0);
});
retentionCheck("exact reserve and quota boundary admit one last write", () => {
  const p = captureStorageCapacity({ ...capacityInput, files: LIMITS.storeFiles - 1,
    bytes: LIMITS.storeBytes - capacityInput.nextBatchBytes,
    availableBytes: LIMITS.freeReserveBytes + capacityInput.nextBatchBytes });
  assert.equal(p.reason, null); assert.equal(p.remainingBatches, 1); assert.equal(p.status, "watch");
});
retentionCheck("warning exposes less than thirty days and does not claim fixed retention", () => {
  const p = captureStorageCapacity({ ...capacityInput, files: LIMITS.storeFiles - 29 * 288 });
  assert.equal(p.status, "watch"); assert.equal(p.estimatedDaysAtFiveMinuteCadence, 29);
  const larger = captureStorageCapacity({ ...capacityInput, nextBatchBytes: 8 * 1024 ** 2 });
  assert.ok(larger.estimatedDaysAtFiveMinuteCadence < 30);
});
retentionCheck("invalid observations cannot bypass disk or store quotas", () => {
  for (const changes of [{ files: -1 }, { bytes: NaN }, { availableBytes: Infinity }, { nextBatchBytes: 0 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => captureStorageCapacity({ ...capacityInput, ...changes }));
  }
});
check("actual private rebuild captures exact normalized input and executed output", () => {
  const row = fixture(), before = JSON.stringify(row);
  result = rebuildPublishedPredictionModel(row, null, collector);
  assert.equal(collector.summary().captured, 1); assert.equal(JSON.stringify(row), before);
  saved = collector.persist(dir); assert.equal(saved.persisted, true);
  assert.equal(saved.storage.files, 1); assert.equal(saved.storage.bytes, saved.storage.nextBatchBytes);
  assert.ok(saved.storage.availableBytes >= LIMITS.freeReserveBytes);
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
retentionCheck("public health exposes capacity aggregates but no private records, hashes or paths", () => {
  const health = predictionCaptureStorageHealth({ ...saved, records: [{ secret: "private-canary" }], path: "private-canary",
    storage: { ...saved.storage, records: ["private-canary"], path: "private-canary" }, productionEligible: true, sourceVerified: true });
  assert.equal(health.status, "ok"); assert.equal(health.persisted, true);
  assert.equal(health.files, 1); assert.equal(health.productionEligible, false); assert.equal(health.sourceVerified, false);
  assert.equal(JSON.stringify(health).includes("private-canary"), false); assert.equal(JSON.stringify(health).includes(saved.sha256), false);
});
retentionCheck("unobserved and failed captures never report healthy capacity", () => {
  assert.equal(predictionCaptureStorageHealth(null).status, "watch");
  assert.equal(predictionCaptureStorageHealth({ persisted: false, reason: "no-captured-records" }).status, "watch");
  assert.equal(predictionCaptureStorageHealth({ persisted: false, reason: "private-store-busy" }).status, "failed");
  const unknown = predictionCaptureStorageHealth({ persisted: false, reason: "sensitive-path-canary" });
  assert.equal(unknown.reason, "capture-persistence-failed"); assert.equal(JSON.stringify(unknown).includes("sensitive-path-canary"), false);
});
retentionCheck("public health recomputes full capacity even when stored status says ok", () => {
  const health = predictionCaptureStorageHealth({ ...saved, storage: { ...saved.storage, status: "ok", files: LIMITS.storeFiles } });
  assert.equal(health.status, "failed"); assert.equal(health.reason, "private-store-capacity-limit");
});
retentionCheck("stale, future and malformed observations are explicit rather than current capacity", () => {
  const at = Date.parse(saved.storage.observedAt);
  assert.equal(predictionCaptureStorageHealth(saved, at + 1801000).reason, "capture-capacity-observation-stale");
  assert.equal(predictionCaptureStorageHealth(saved, at - 1).reason, "capture-capacity-not-verifiable");
  assert.equal(predictionCaptureStorageHealth({ ...saved, storage: { ...saved.storage, bytes: NaN } }, at).reason, "capture-capacity-not-verifiable");
});
for (const unknownDisk of [false, true]) retentionCheck("verified duplicate remains retained when free-space inspection is " + (unknownDisk ? "unavailable" : "low"), () => {
  const statfs = fs.statfsSync, file = path.join(dir, "prediction-execution-captures", saved.sha256 + ".json.gz"), before = fs.readFileSync(file);
  try {
    fs.statfsSync = () => { if (unknownDisk) throw new Error("fixture"); return { bavail: 0n, bsize: 4096n }; };
    const status = collector.persist(dir);
    assert.equal(status.persisted, true); assert.equal(status.duplicate, true); assert.ok(fs.readFileSync(file).equals(before));
    assert.notEqual(predictionCaptureStorageHealth(status).status, "ok");
  } finally { fs.statfsSync = statfs; }
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
for (const [name, observation, reason] of [
  ["low disk", { bavail: 1n, bsize: 4096n }, "private-store-disk-reserve"],
  ["unknown disk", null, "private-store-free-space-unavailable"],
  ["invalid disk", { bavail: -1n, bsize: 4096n }, "private-store-free-space-unavailable"],
]) retentionCheck(name + " refuses writes but leaves the scorer result and previous files alone", () => {
  const other = fs.mkdtempSync(path.join(dir, "disk-"));
  const c = capture(now()), output = c.run(fixture(), scorer), statfs = fs.statfsSync;
  try {
    fs.statfsSync = () => { if (!observation) throw new Error("synthetic statfs failed"); return observation; };
    const status = c.persist(other); assert.equal(status.persisted, false); assert.equal(status.reason, reason);
    assert.deepEqual(fs.readdirSync(path.join(other, "prediction-execution-captures")), []);
    assert.ok(output.probabilityModel);
  } finally { fs.statfsSync = statfs; }
});
retentionCheck("real 513-batch append crosses the old file ceiling and preserves every earlier byte", () => {
  const other = fs.mkdtempSync(path.join(dir, "retention-")), files = [];
  for (let i = 0; i < 513; i++) {
    const c = capture(now()); c.run({ ...fixture(), sourceMatchId: `retention-${i}` }, scorer);
    const status = c.persist(other); assert.equal(status.persisted, true, `batch ${i}: ${JSON.stringify(status)}`); assert.equal(status.duplicate, false);
    assert.notEqual(status.lockReleaseFailed, true, `batch ${i}: lock release must be proven`);
    assert.equal(status.storage.files, i + 1);
    const file = path.join(other, "prediction-execution-captures", status.sha256 + ".json.gz");
    const raw = fs.readFileSync(file); assert.equal(hash(zlib.gunzipSync(raw)), status.sha256);
    files.push({ file, sha256: hash(raw) });
  }
  assert.equal(fs.readdirSync(path.join(other, "prediction-execution-captures")).length, 513);
  for (const file of files) assert.equal(hash(fs.readFileSync(file.file)), file.sha256);
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
let writerLockChecks = 0;
const lockCheck = (name, test) => { check(name, test); writerLockChecks++; };
const lockFixture = () => {
  const base = fs.mkdtempSync(path.join(dir, "writer-"));
  const c = capture(now()); c.run(fixture(), scorer);
  const initial = c.persist(base); assert.equal(initial.persisted, true); assert.notEqual(initial.lockReleaseFailed, true);
  const folder = path.join(base, "prediction-execution-captures"), lockDir = path.join(folder, ".writer.lock");
  const file = path.join(folder, initial.sha256 + ".json.gz"), bytes = fs.readFileSync(file);
  return { base, c, folder, lockDir, file, bytes };
};
lockCheck("real exited child owner is recovered without rewriting previous capture", () => {
  const f = lockFixture();
  const child = require("node:child_process").spawnSync(process.execPath, ["-e",
    'require(process.argv[1]).acquirePointerCommitLock({lockDir:process.argv[2],timeoutMs:0});',
    path.join(root, "server/dataGenerationStore.cjs"), f.lockDir], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const owner = JSON.parse(fs.readFileSync(path.join(f.lockDir, "owner.json")));
  assert.throws(() => process.kill(owner.pid, 0), error => error.code === "ESRCH");
  const result = f.c.persist(f.base); assert.equal(result.persisted, true); assert.equal(result.duplicate, true);
  assert.notEqual(result.lockReleaseFailed, true); assert.ok(fs.readFileSync(f.file).equals(f.bytes));
  assert.equal(fs.existsSync(f.lockDir), false);
});
for (const kind of ["live-old-owner", "foreign-owner", "partial-owner", "extra-metadata"]) {
  lockCheck(kind + " cannot be reclaimed by age", () => {
    const f = lockFixture(); fs.mkdirSync(f.lockDir);
    const owner = { schemaVersion: 1, token: crypto.randomUUID(), pid: process.pid,
      hostname: require("node:os").hostname(), acquiredAt: "2000-01-01T00:00:00.000Z" };
    if (kind === "foreign-owner") owner.hostname = "synthetic-foreign-host";
    const file = path.join(f.lockDir, "owner.json"), raw = kind === "partial-owner" ? "{" : JSON.stringify(owner);
    fs.writeFileSync(file, raw);
    if (kind === "extra-metadata") fs.writeFileSync(path.join(f.lockDir, "unexpected"), "preserve");
    const entries = fs.readdirSync(f.lockDir);
    const result = f.c.persist(f.base); assert.equal(result.persisted, false); assert.equal(result.reason, "private-store-busy");
    assert.equal(fs.readFileSync(file, "utf8"), raw); assert.deepEqual(fs.readdirSync(f.lockDir), entries);
    assert.ok(fs.readFileSync(f.file).equals(f.bytes));
  });
}
for (const permanent of [false, true]) lockCheck((permanent ? "persistent" : "transient") + " release denial is bounded and never deletes canonical lock", () => {
  const f = lockFixture(), rename = fs.renameSync; let denied = 0;
  try {
    fs.renameSync = (from, to, ...args) => {
      if (from === f.lockDir && (permanent || denied === 0)) {
        denied++; const error = new Error("synthetic rename denied"); error.code = "EPERM"; throw error;
      }
      return rename(from, to, ...args);
    };
    const result = f.c.persist(f.base); assert.equal(result.persisted, true); assert.equal(result.duplicate, true);
    assert.equal(denied, permanent ? 4 : 1); assert.equal(result.lockReleaseFailed === true, permanent);
    assert.equal(fs.existsSync(f.lockDir), permanent); assert.ok(fs.readFileSync(f.file).equals(f.bytes));
    if (permanent) {
      const health = predictionCaptureStorageHealth(result);
      assert.equal(health.status, "failed"); assert.equal(health.reason, "capture-writer-lock-release-not-proven");
    }
  } finally { fs.renameSync = rename; }
});
lockCheck("legacy empty file stays protected", () => {
  const f = lockFixture(); fs.writeFileSync(f.lockDir, "");
  assert.equal(f.c.persist(f.base).reason, "private-store-busy");
  assert.equal(fs.statSync(f.lockDir).size, 0); assert.ok(fs.readFileSync(f.file).equals(f.bytes));
});
lockCheck("actual multiprocess ABA and release successor races preserve successor ownership", () => {
  const child = require("node:child_process").spawnSync(process.execPath, [path.join(root, "scripts/verifyDataGenerationPointerLockRace.cjs")],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true); assert.ok(result.assertions >= 10);
});
console.log(JSON.stringify({ ok: true, verifier: "prediction-execution-capture-v1", checks, fixtureDirectory: dir, writerLockChecks,
  retentionChecks, realRetainedBatches: 513, retentionPolicyVersion: "prediction-capture-capacity-v2",
  productionDataTouched: false, providerRequests: 0, scope: "actual rebuild boundary plus bounded private JSON evidence; not deterministic full replay or source attestation" }, null, 2));
