"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { roundedComponent, assessFrozenFormEvidence, buildDisagreementDiagnosis } = require("../scripts/diagnoseFrozenModelDisagreement.cjs");
function form() { return { sampleSize: 2, lastMatchAt: "2026-10-01T00:00:00Z", resultEvidence: { version: "recent-form-result-evidence-v1",
  sampleRows: 2, observedRows: 2, missingObservedAtRows: 0, missingSourceRows: 0, beforeKickoffRows: 0, afterDecisionRows: 0,
  latestObservedAt: "2026-10-02T00:00:00Z", decisionAt: "2026-10-03T00:00:00Z", temporalStatus: "clock-recorded", selectionHash: "a".repeat(64), sourceLabels: ["synthetic"] } }; }
const decision = "2026-10-03T00:00:00Z";
test("close rounded component leaders are unknown, not forced directions", () => {
  assert.equal(roundedComponent({ home: 36.7, draw: 26.5, away: 36.8 }).direction, null);
  assert.equal(roundedComponent({ home: 60, draw: 25, away: 15 }).direction, "home");
  assert.equal(roundedComponent({ omitted: "byte limit" }).status, "unavailable");
  assert.equal(roundedComponent({ home: 60, draw: 60, away: 10 }).status, "invalid-percent-triplet");
});
test("complete metadata has no source verification or model admission authority", () => {
  const result = assessFrozenFormEvidence(form(), decision);
  assert.equal(result.metadataCompleteAtOriginalDecision, true);
  assert.equal(result.summaryCountsComplete, true);
  assert.equal(result.originalDecisionAvailabilityProven, false);
  assert.equal(result.providerSourceVerified, false); assert.equal(result.candidateEligible, false);
});
test("later summary cutoff cannot become original-decision evidence even when latest observation is earlier", () => {
  const value = form(); value.resultEvidence.decisionAt = "2026-10-03T00:00:00.000000001Z";
  const result = assessFrozenFormEvidence(value, decision);
  assert.equal(result.metadataCompleteAtOriginalDecision, false);
  assert.equal(result.summaryCountsComplete, true);
  assert.equal(result.summaryDecisionStatus, "after-original-decision");
  assert.ok(result.blockers.includes("summary-decision-after-original-decision"));
  assert.equal(result.originalDecisionAvailabilityProven, false);
  assert.equal(result.candidateEligible, false);
});
test("missing or invalid summary decision clock cannot be substituted by latest observation or original decision", () => {
  for (const clock of [undefined, null, "", "2026-02-30T00:00:00Z", "2026-10-03T24:00:00Z", "2026-10-02T00:00:00"]) {
    const value = form(); value.resultEvidence.decisionAt = clock;
    const result = assessFrozenFormEvidence(value, decision);
    assert.equal(result.metadataCompleteAtOriginalDecision, false, String(clock));
    assert.equal(result.summaryCountsComplete, true);
    assert.ok(result.blockers.includes("summary-decision-clock-missing-or-invalid"));
  }
});
test("latest result after the summary cutoff contradicts declared zero late rows at nanosecond precision", () => {
  const value = form(); value.resultEvidence.decisionAt = "2026-10-02T00:00:00Z";
  value.resultEvidence.latestObservedAt = "2026-10-02T00:00:00.000000001Z";
  const result = assessFrozenFormEvidence(value, decision);
  assert.equal(result.metadataCompleteAtOriginalDecision, false);
  assert.ok(result.blockers.includes("latest-result-after-summary-decision"));
  assert.equal(result.summaryCountsComplete, true);
});
test("equal and earlier summary cutoffs compare exact zoned instants without claiming original source availability", () => {
  for (const cutoff of [decision, "2026-10-03T08:00:00+08:00", "2026-10-02T00:00:00Z"]) {
    const value = form(); value.resultEvidence.decisionAt = cutoff;
    const result = assessFrozenFormEvidence(value, decision);
    assert.equal(result.metadataCompleteAtOriginalDecision, true);
    assert.equal(result.reportedEvidenceDecisionAt, cutoff);
    assert.equal(result.originalDecisionAvailabilityProven, false);
    assert.equal(result.providerSourceVerified, false);
    assert.equal(result.candidateEligible, false);
  }
});
test("reported clock-recorded label does not override missing raw observation counts", () => {
  const value = form(); value.resultEvidence.missingObservedAtRows = 1;
  assert.equal(assessFrozenFormEvidence(value, decision).metadataCompleteAtOriginalDecision, false);
});
test("later evidence boundary cannot admit result recorded one nanosecond after actual decision", () => {
  const value = form(); value.resultEvidence.latestObservedAt = "2026-10-03T00:00:00.000000001Z"; value.resultEvidence.decisionAt = "2026-10-03T03:00:00Z";
  assert.ok(assessFrozenFormEvidence(value, decision).blockers.includes("latest-result-not-observed-by-original-decision"));
});
test("invalid calendars and unknown sample size do not become full form coverage", () => {
  const value = form(); value.lastMatchAt = "2026-02-30T00:00:00Z";
  assert.equal(assessFrozenFormEvidence(value, decision).metadataCompleteAtOriginalDecision, false);
  assert.equal(assessFrozenFormEvidence({}, decision).metadataCompleteAtOriginalDecision, false);
  assert.throws(() => assessFrozenFormEvidence(form(), "2026-02-30T00:00:00Z"), /strict original/);
});
test("real frozen evidence joins recovered form by exact source snapshot and preserves 154/26", () => {
  const root = path.resolve(__dirname, "..");
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file)));
  const base = read("outputs/history-regression-20261002/online-sample-v3.json"), supplement = read("outputs/next-phase-20261002/form-supplement.json"), recovery = read("outputs/next-phase-20261002/form-recovery-receipt.json");
  const evidence = fs.readFileSync(path.join(root, "outputs/history-regression-20261002/report/per-match-evidence.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const before = JSON.stringify([base, supplement, recovery, evidence]);
  const report = buildDisagreementDiagnosis(base, supplement, recovery, evidence);
  assert.deepEqual(report.pairedRecalculation, { modelHits: 78, marketHits: 83 });
  assert.equal(report.rows.length, 26); assert.equal(report.boundedSupplementRequest.rows.length, 22);
  assert.equal(report.formEvidence.allRecovered.slots, 758);
  assert.deepEqual(Object.values(report.formEvidence).map(group => group.summaryCountsComplete), [101, 66, 7]);
  assert.deepEqual(Object.values(report.formEvidence).map(group => group.metadataCompleteAtOriginalDecision), [22, 2, 0]);
  assert.deepEqual(Object.values(report.formEvidence).map(group => group.originalDecisionAvailabilityProven), [0, 0, 0]);
  assert.deepEqual(Object.values(report.formEvidence).map(group => group.candidateEligible), [0, 0, 0]);
  assert.equal(report.formEvidence.disagreement.countCompleteSummaryAfterOriginalDecision, 7);
  assert.equal(report.version, "frozen-model-disagreement-diagnosis-v2");
  assert.deepEqual(report.observations.patterns, { "poisson-and-market-align-but-base-final-disagrees": 5, "poisson-component-already-disagrees-with-market": 19, "poisson-direction-unavailable-or-ambiguous": 2 });
  assert.equal(JSON.stringify([base, supplement, recovery, evidence]), before);
  const original = fs.readFileSync(path.join(root, "outputs/implementation-20261003/model/disagreement-attribution.json"));
  assert.equal(crypto.createHash("sha256").update(original).digest("hex"), "d561e8d0eb0ac9861291943de9c8a6d9f3b3f2f1d76f67af4d40eec6398aab75");
  const changed = structuredClone(supplement); changed.rows.find(row => row.matchId === report.rows[0].matchId).snapshot.originalObjectCanonicalSha256 = "b".repeat(64);
  assert.throws(() => buildDisagreementDiagnosis(base, changed, recovery, evidence), /snapshot binding/);
});
