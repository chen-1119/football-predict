"use strict";
// All fixtures in this file are SYNTHETIC. Their success is not field coverage
// or prediction-accuracy evidence. Real export validation is a separate report.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { featureAudit } = require("./historyRegressionAdmission.cjs");
const { instant, validateEvidence, retainEvidence, readReceipt, coverageReport, fieldDiagnostic, extract } = require("./prospectiveDataCoverage.cjs");
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
const outputRoot = path.resolve(__dirname, "../outputs");
const directory = fs.mkdtempSync(path.join(outputRoot, "prospective-data-synthetic-tests-"));
test.after(() => {
  assert(path.resolve(directory).startsWith(outputRoot + path.sep + "prospective-data-synthetic-tests-"));
  fs.rmSync(directory, { recursive: true });
});
const now = () => "2026-10-02T10:00:00.000000010Z";
function fixture() {
  const payload = Buffer.from('{"weather":{"temperature":23},"testOnly":true}\n');
  const metadata = { version: "prospective-field-evidence-v1", evidenceKind: "synthetic-test", field: "weather",
    payloadSha256: sha(payload), valuePointer: "/weather/temperature", valueSemantics: "synthetic-forecast-celsius",
    event: { sourceMatchId: "synthetic-1", sourceCycleId: "synthetic-cycle", kickoffAt: "2026-10-02T12:00:00Z",
      decisionAt: "2026-10-02T10:01:00Z", cutoffAt: "2026-10-02T11:55:00Z" },
    providerObservedAt: "2026-10-02T09:58:00Z", receivedAt: "2026-10-02T09:59:00Z", availableAt: "2026-10-02T10:00:00Z",
    source: { providerId: "synthetic-provider", providerEventId: "synthetic-provider-event",
      url: "https://synthetic.invalid/weather", authorization: { status: "allowed", basis: "explicit-permission", reference: "SYNTHETIC TEST ONLY" } },
    identityMapping: { sourceMatchId: "synthetic-1", providerEventId: "synthetic-provider-event", evidenceSha256: "a".repeat(64), reference: "SYNTHETIC TEST ONLY" } };
  return { metadata, payload };
}
test("nanosecond clock comparison preserves original ordering across timezone offsets", () => {
  assert.equal(instant("2026-10-02T18:00:00.000000010+08:00"), instant(now()));
  assert(instant("2026-10-02T10:00:00.000000011Z") > instant(now()));
});
for (const value of ["2026-02-30T10:00:00Z", "2026-10-02 10:00:00", "2026-10-02T24:00:00Z", null]) {
  test(`strict clock rejects invalid value ${value}`, () => assert.throws(() => instant(value), /STRICT_CLOCK/));
}
test("valid declared evidence is retained as immutable shadow receipt with exact raw bytes", () => {
  const { metadata, payload } = fixture(), result = retainEvidence(metadata, payload, directory, { now });
  const receipt = readReceipt(result.path, result.evidenceId);
  assert.equal(receipt.candidateEligible, false);
  assert.equal(receipt.metadata.evidenceKind, "synthetic-test");
  assert.equal(receipt.trust.providerAuthorization, "declared-not-independently-verified");
  assert.equal(receipt.trust.eventMapping, "declared-not-independently-verified");
  assert.equal(receipt.retainedAt, now());
  assert.deepEqual(Buffer.from(receipt.payloadBase64, "base64"), payload);
});
test("duplicate read after cutoff does not rewrite the original receipt or its first retention time", () => {
  const { metadata, payload } = fixture(), first = retainEvidence(metadata, payload, directory, { now });
  const originalBytes = fs.readFileSync(first.path);
  const second = retainEvidence(metadata, payload, directory, { now: () => "2026-10-03T10:00:00Z" });
  assert.equal(second.duplicate, true);
  assert.equal(second.retainedAt, now());
  assert.deepEqual(fs.readFileSync(first.path), originalBytes);
});
test("old caller-declared received/available times cannot backdate a newly saved attachment", () => {
  const { metadata, payload } = fixture(); metadata.event.sourceCycleId = "synthetic-new-attachment";
  assert.throws(() => retainEvidence(metadata, payload, directory, { now: () => "2026-10-03T10:00:00Z" }), /NOT_RETAINED_BEFORE/);
});
for (const [name, mutate, error] of [
  ["provider after receipt", m => { m.providerObservedAt = "2026-10-02T09:59:00.000000001Z"; }, /FIELD_CLOCK_ORDER/],
  ["receipt after availability", m => { m.receivedAt = "2026-10-02T10:00:00.000000001Z"; }, /FIELD_CLOCK_ORDER/],
  ["availability after real retention", m => { m.availableAt = "2026-10-02T10:00:00.000000011Z"; }, /NOT_RETAINED_BEFORE/],
  ["decision before real retention", m => { m.event.decisionAt = "2026-10-02T10:00:00.000000009Z"; }, /NOT_RETAINED_BEFORE/],
  ["decision one nanosecond beyond cutoff", m => { m.event.cutoffAt = "2026-10-02T10:01:00Z"; m.event.decisionAt = "2026-10-02T10:01:00.000000001Z"; }, /NOT_RETAINED_BEFORE/],
  ["cutoff beyond kickoff", m => { m.event.cutoffAt = "2026-10-02T12:00:00.000000001Z"; }, /NOT_RETAINED_BEFORE/],
  ["optional clock reversed", m => { m.observedAt = "2026-10-02T09:57:00Z"; }, /OPTIONAL_CLOCK/],
  ["missing clock", m => { delete m.availableAt; }, /STRICT_CLOCK/],
  ["unauthorized source", m => { m.source.authorization.status = "unknown"; }, /AUTHORIZATION/],
  ["missing authorization reference", m => { delete m.source.authorization.reference; }, /AUTHORIZATION/],
  ["provider event mismatch", m => { m.identityMapping.providerEventId = "another-event"; }, /EVENT_MAPPING/],
  ["missing event mapping hash", m => { delete m.identityMapping.evidenceSha256; }, /EVENT_MAPPING/],
  ["missing provider identity", m => { delete m.source.providerId; }, /PROVIDER_IDENTITY/],
  ["missing match identity", m => { delete m.event.sourceMatchId; }, /EVENT_IDENTITY/],
  ["result feature name", m => { m.field = "finalScoreHome"; }, /UNREVIEWED_FIELD/],
  ["source credential URL", m => { m.source.url = "https://user:pass@synthetic.invalid/"; }, /SOURCE_URL/],
  ["hash mismatch", m => { m.payloadSha256 = "0".repeat(64); }, /PAYLOAD_HASH/],
  ["missing field pointer", m => { m.valuePointer = "/missing"; }, /FIELD_POINTER/],
]) {
  test(`synthetic invalid evidence rejects ${name}`, () => {
    const { metadata, payload } = fixture(); mutate(metadata);
    assert.throws(() => validateEvidence(metadata, payload, now()), error);
  });
}
test("declared observed historical xG needs a period before provider observation and cannot be market lambda", () => {
  const { metadata, payload } = fixture(); metadata.field = "xg";
  metadata.valueSemantics = "market-implied-lambda";
  assert.throws(() => validateEvidence(metadata, payload, now()), /NOT_OBSERVED_XG/);
  metadata.valueSemantics = "provider-reported-historical-xg";
  metadata.historicalPeriodEndAt = "2026-10-02T09:58:00.000000001Z";
  assert.throws(() => validateEvidence(metadata, payload, now()), /XG_HISTORICAL/);
  metadata.historicalPeriodEndAt = "2026-10-01T00:00:00Z";
  assert.doesNotThrow(() => validateEvidence(metadata, payload, now()));
});
test("JSON pointer permits exact nested keys and rejects inherited properties and null values", () => {
  assert.equal(extract({ "a/b": { "~": 0 } }, "/a~1b/~0"), 0);
  assert.equal(extract({ list: [] }, "/list").length, 0);
  assert.throws(() => extract({}, "/__proto__"), /NOT_FOUND/);
  assert.throws(() => extract({ a: null }, "/a"), /MISSING/);
  assert.throws(() => extract({}, "/~2"), /INVALID_JSON_POINTER/);
});
test("correction creates a new receipt linked to the old receipt hash without changing it", () => {
  const { metadata, payload } = fixture(), first = retainEvidence(metadata, payload, directory, { now });
  const original = fs.readFileSync(first.path);
  const corrected = Buffer.from('{"weather":{"temperature":22},"testOnly":true}\n');
  metadata.payloadSha256 = sha(corrected); metadata.supersedesEvidenceId = first.evidenceId;
  const second = retainEvidence(metadata, corrected, directory, { now }), receipt = readReceipt(second.path, second.evidenceId);
  assert.notEqual(first.evidenceId, second.evidenceId);
  assert.equal(receipt.revision, 2);
  assert.equal(receipt.supersedesReceiptSha256, JSON.parse(original).receiptSha256);
  assert.deepEqual(fs.readFileSync(first.path), original);
  metadata.field = "form";
  assert.throws(() => retainEvidence(metadata, corrected, directory, { now }), /CORRECTION_IDENTITY/);
});
test("mutated receipt time is rejected even if the payload bytes still match", () => {
  const { metadata, payload } = fixture(); metadata.event.sourceCycleId = "synthetic-tamper";
  const result = retainEvidence(metadata, payload, directory, { now });
  const edited = JSON.parse(fs.readFileSync(result.path)); edited.retainedAt = "2026-10-02T10:00:00Z";
  fs.writeFileSync(result.path, JSON.stringify(edited));
  assert.throws(() => readReceipt(result.path, result.evidenceId), /RECEIPT_HASH/);
});
test("retention cannot target public data or any path outside worktree outputs", () => {
  const { metadata, payload } = fixture();
  assert.throws(() => retainEvidence(metadata, payload, path.resolve(__dirname, "../public/data"), { now }), /WORKTREE_OUTPUTS/);
});
test("frozen feature presence is not a source receipt and omission requests export repair", () => {
  const snapshot = { featureSnapshot: { hash: "hash", capturedAt: "2026-10-02T09:00:00Z", modelInputs: {
    elo: { rating: 1400 }, form: { omitted: "field-over-byte-limit" } } } };
  const inspection = { record: { decision: { at: "2026-10-02T10:00:00Z" },
    features: featureAudit(snapshot, { decisionAt: "2026-10-02T10:00:00Z", featureSnapshotHash: "hash" }) } };
  const elo = fieldDiagnostic(snapshot, inspection, "elo"), form = fieldDiagnostic(snapshot, inspection, "form");
  assert.equal(elo.frozenBoundBeforeDecision, true);
  assert.equal(elo.candidateEligible, false);
  assert.equal(elo.payloadHashPresent, false);
  assert.equal(form.action, "restore-bounded-export-evidence");
  assert.equal(form.exportOmitted, true);
  assert.equal(form.sourceSnapshotMissing, false);
});
test("coverage refuses unverified prior online receipt or raw response", () => {
  assert.throws(() => coverageReport({}, {}, Buffer.from("{}")), /PRIOR_ONLINE_RECEIPT/);
  const prior = { version: "online-validation-inputs-v1", productionWrites: false, sameSnapshot: true,
    source: "online-immutable-active-generation", publication: {}, manifestFileSha256: "a".repeat(64) };
  assert.throws(() => coverageReport({}, prior, Buffer.from("{}")), /UNVERIFIED_ONLINE_CAPTURE/);
});
test("missing frozen snapshot remains distinct from a confirmed absent field in a snapshot", () => {
  const inspection = { record: { features: featureAudit(null, null) } };
  const diagnostic = fieldDiagnostic(null, inspection, "injuries");
  assert.equal(diagnostic.snapshotEvidenceMissing, true);
  assert.equal(diagnostic.sourceSnapshotMissing, false);
  assert.equal(diagnostic.action, "retain-future-frozen-feature-snapshot");
});
test("coverage rechecks snapshot clock at nanosecond precision without relaxing original binding", () => {
  const snapshot = { featureSnapshot: { hash: "hash", capturedAt: "2026-10-02T10:00:00.000000001Z", modelInputs: { elo: 1500 } } };
  const decisionAt = "2026-10-02T10:00:00.000000000Z";
  const inspection = { record: { decision: { at: decisionAt }, features: featureAudit(snapshot, { decisionAt, featureSnapshotHash: "hash" }) } };
  assert.equal(inspection.record.features.groups.elo.available, true); // Legacy millisecond comparison.
  const diagnostic = fieldDiagnostic(snapshot, inspection, "elo");
  assert.equal(diagnostic.frozenBoundBeforeDecision, false);
  assert.equal(diagnostic.action, "repair-future-snapshot-binding-and-clock");
  snapshot.featureSnapshot.capturedAt = decisionAt;
  assert.equal(fieldDiagnostic(snapshot, inspection, "elo").frozenBoundBeforeDecision, true);
  inspection.record.features.groups.elo.available = false;
  assert.equal(fieldDiagnostic(snapshot, inspection, "elo").frozenBoundBeforeDecision, false);
});
