"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { observePredictionEvidence, summarizePredictionEvidence, compactPredictionEvidence, exactEventBinding } = require("./predictionEvidenceAudit.cjs");

const checks = [];
const check = (name, fn) => { fn(); checks.push({ name, ok: true }); };
const match = { id: "sporttery_evidence_test", sourceMatchId: "evidence_test", kickoffTime: "2026-09-10T12:00:00.000Z" };
const decision = {
  version: "candidate-decision-snapshot-v2", matchId: match.id, sourceMatchId: match.sourceMatchId,
  kickoffTime: match.kickoffTime, capturedAt: "2026-09-10T10:00:00.000Z", decisionAt: "2026-09-10T10:00:00.000Z",
  clockAudit: { eligible: false, blockers: ["had-market-provenance-attestation-missing", "had-market-provenance-attestation-missing"] },
  probabilities: { HAD: { "1": 0.3, X: 0.4, "2": 0.3 } },
  markets: { HAD: { odds: { "1": 3, X: 3, "2": 3 }, provenanceHash: "test-only-not-an-attestation" } },
  featureSnapshotHash: "a".repeat(64),
};
const snapshot = { firstSeenAt: decision.capturedAt, decisionSnapshot: decision };
const rejected = observePredictionEvidence({ match, selectedSnapshot: { snapshot }, strictPair: null });
const reasons = ["forecast-clock-invalid", "decision-clock-audit-ineligible", "same-decision-market-pair-missing", "historical-feature-snapshot-missing"];
const row = { matchId: match.id, sourceMatchId: match.sourceMatchId, kickoffTime: match.kickoffTime, evidenceTrace: rejected, promotionAudit: { eligible: false, reasons } };

check("cascading reasons remain one disjoint root category", () => {
  const result = summarizePredictionEvidence([row]);
  assert.equal(result.rows, 1);
  assert.deepEqual(result.primaryCounts, { "clock-or-provenance-rejected": 1 });
  assert.equal(Object.values(result.reasonCounts).reduce((a, b) => a + b, 0), 4);
  assert.equal(result.clockBlockerCounts["had-market-provenance-attestation-missing"], 1);
});
check("present odds, probabilities and feature hash are not mislabeled absent", () => {
  assert.equal(rejected.fields["markets.HAD.odds"], true);
  assert.equal(rejected.fields["probabilities.HAD"], true);
  assert.equal(rejected.fields.featureSnapshotHash, true);
  assert.equal(rejected.fields["markets.HAD.receivedAt"], false);
});
check("missing selection does not claim upstream never collected evidence", () => {
  const trace = observePredictionEvidence({ match });
  assert.equal(trace.stage, "selected-decision-missing");
  const result = summarizePredictionEvidence([{ evidenceTrace: trace, promotionAudit: { eligible: false, reasons } }]);
  assert.equal(result.policy.missingSelectedEvidenceProvesUpstreamAbsence, false);
  assert.equal(result.policy.changesAdmission, false);
});
check("event conflict is separate from missing clocks", () => {
  assert.equal(exactEventBinding({ ...decision, sourceMatchId: "different" }, match), false);
  assert.equal(exactEventBinding({ ...decision, kickoffTime: "2026-09-11T12:00:00.000Z" }, match), false);
  assert.equal(observePredictionEvidence({ match, selectedSnapshot: { snapshot: { decisionSnapshot: { ...decision, matchId: "different" } } } }).stage, "event-binding-rejected");
});
check("legacy versions are never relabeled as promotable", () => {
  const trace = observePredictionEvidence({ match, selectedSnapshot: { snapshot: { decisionSnapshot: { ...decision, version: "candidate-decision-snapshot-v1" } } } });
  assert.equal(trace.stage, "selected-version-not-promotable");
  assert.equal(trace.revalidatedClockEligible, false);
});
check("stored eligible flag cannot replace independent clock revalidation", () => {
  const trace = observePredictionEvidence({ match, selectedSnapshot: { snapshot: { decisionSnapshot: { ...decision, clockAudit: { eligible: true, blockers: [] } } } }, strictPair: {} });
  assert.equal(trace.stage, "clock-or-provenance-rejected");
  assert.equal(summarizePredictionEvidence([{ evidenceTrace: trace }]).rejectedStoredClockClaims, 1);
});
check("missing trace is explicit and no sample is fabricated", () => {
  const result = summarizePredictionEvidence([{ promotionAudit: { eligible: false, reasons: [] } }]);
  assert.equal(result.primaryCounts["trace-unavailable"], 1);
  assert.equal(result.traceRows, 0);
  assert.equal(result.eligibleRows, 0);
  assert.equal(summarizePredictionEvidence([]).rows, 0);
});
check("independent candidate cohort is not imported", () => {
  const result = summarizePredictionEvidence([row]);
  assert.equal(result.policy.candidateProspectiveCohortIncluded, false);
  assert.equal(result.eligibleRows, 0);
  assert.equal(result.rejectedRows, 1);
});
check("trace is additive and never mutates frozen input or admission", () => {
  const before = JSON.stringify({ match, snapshot, row });
  summarizePredictionEvidence([row]);
  assert.equal(JSON.stringify({ match, snapshot, row }), before);
});
check("JSON persistence roundtrip preserves trace and summary", () => {
  assert.deepEqual(summarizePredictionEvidence(JSON.parse(JSON.stringify([row]))), summarizePredictionEvidence([row]));
});
check("public compact output excludes match-level samples", () => {
  const compact = compactPredictionEvidence(summarizePredictionEvidence([row]));
  assert.equal(Object.hasOwn(compact, "samples"), false);
  assert.equal(JSON.stringify(compact).includes(match.sourceMatchId), false);
  assert.equal(compactPredictionEvidence({ version: "unknown" }), null);
});
check("samples are bounded independently per primary category", () => {
  assert.equal(summarizePredictionEvidence(Array.from({ length: 100 }, () => row)).samples.length, 3);
});
check("batch entrypoint and public adapter wire diagnostics without changing promotion filter", () => {
  const backtest = fs.readFileSync(path.join(__dirname, "runModelBacktest.cjs"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "../server/index.cjs"), "utf8");
  assert.ok(backtest.includes("evidenceDiagnostics: summarizePredictionEvidence(rows)"));
  assert.ok(backtest.includes("probabilityRows.filter((row) => row.promotionAudit.eligible)"));
  assert.ok(server.includes("evidenceDiagnostics: compactPredictionEvidence(inputAudit.evidenceDiagnostics)"));
});

console.log(JSON.stringify({ ok: true, verifier: "prediction-evidence-diagnostics", assertions: checks.length, checks }, null, 2));
