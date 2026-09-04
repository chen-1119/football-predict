"use strict";

const assert = require("node:assert/strict");
const {
  VERSION,
  buildCandidateProspectiveTemporalAudit,
  resultEvidenceBlockersForDecision,
  resultEvidenceEligibleForDecision,
} = require("../server/candidateProspectiveTemporalAudit.cjs");

const checkedAt = "2026-07-31T06:00:00.000Z";
const decision = (eventHash, sourceMatchId, kickoffAt) => ({
  type: "decision",
  phase: "formal",
  eventHash,
  matchId: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  kickoffAt,
});

const future = decision("decision-future", "1001", "2026-07-31T07:00:00.000Z");
const awaiting = decision("decision-awaiting", "1002", "2026-07-31T03:00:00.000Z");
const missing = decision("decision-missing", "1003", "2026-07-31T02:00:00.000Z");
const eligible = decision("decision-eligible", "1004", "2026-07-31T01:00:00.000Z");
const ineligible = decision("decision-ineligible", "1005", "2026-07-31T00:00:00.000Z");
const settled = decision("decision-settled", "1006", "2026-07-30T23:00:00.000Z");

const registry = {
  activeLedgerId: "active-ledger",
  ledgers: [{
    ledgerId: "active-ledger",
    events: [
      future,
      awaiting,
      missing,
      eligible,
      ineligible,
      settled,
      {
        type: "settlement",
        phase: "formal",
        decisionEventHash: settled.eventHash,
      },
    ],
  }],
};

const matches = [
  {
    id: "sporttery_1002",
    sourceMatchId: "1002",
    kickoffTime: awaiting.kickoffAt,
    status: "PENDING_RESULT",
  },
  {
    id: "sporttery_1004",
    sourceMatchId: "1004",
    kickoffTime: eligible.kickoffAt,
    eventVersion: eligible.kickoffAt,
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 1,
    sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/result",
    resultSource: "sporttery:official-api",
    resultObservedAt: "2026-07-31T03:05:00.000Z",
    resultObservationSource: "sporttery-relay-current",
  },
  {
    id: "sporttery_1004",
    sourceMatchId: "1004",
    kickoffTime: eligible.kickoffAt,
    status: "FINISHED",
    scoreHome: 1,
    scoreAway: 1,
    sourceUrl: "https://example.com/result",
    resultSource: "supplemental",
    updatedAt: "2026-07-31T05:59:00.000Z",
  },
  {
    id: "sporttery_1005",
    sourceMatchId: "1005",
    kickoffTime: ineligible.kickoffAt,
    status: "FINISHED",
    scoreHome: 1,
    scoreAway: 1,
    sourceUrl: "https://example.com/result",
    resultSource: "supplemental",
  },
];

assert.equal(resultEvidenceEligibleForDecision(matches[1], eligible), true);
assert.equal(resultEvidenceEligibleForDecision(matches[3], ineligible), false);
assert.deepEqual(
  resultEvidenceBlockersForDecision(matches[1], eligible),
  [],
);
assert.ok(
  resultEvidenceBlockersForDecision(matches[3], ineligible)
    .includes("not-official-sporttery-final"),
);

const audit = buildCandidateProspectiveTemporalAudit({
  registry,
  matches,
  evaluatedAt: checkedAt,
});

assert.equal(audit.version, VERSION);
assert.equal(audit.activeLedgerPresent, true);
assert.equal(audit.admittedRows, 6);
assert.equal(audit.settledRows, 1);
assert.equal(audit.pendingRows, 5);
assert.equal(audit.futureKickoffRows, 1);
assert.equal(audit.kickoffPassedRows, 4);
assert.equal(audit.awaitingOfficialFinalRows, 1);
assert.equal(audit.officialVoidRows, 0);
assert.equal(audit.officialResultRecordMissingRows, 1);
assert.equal(audit.officialFinishedIneligibleRows, 1);
assert.deepEqual(audit.officialFinishedIneligiblePrimaryReasonCounts, {
  "not-official-sporttery-final": 1,
});
assert.equal(
  audit.officialFinishedIneligibleReasonCounts[
    "not-official-sporttery-final"
  ],
  1,
);
assert.equal(
  Object.values(audit.officialFinishedIneligiblePrimaryReasonCounts)
    .reduce((sum, value) => sum + value, 0),
  audit.officialFinishedIneligibleRows,
);
assert.equal(audit.officialFinishedEligibleUnsettledRows, 1);
assert.equal(audit.invalidKickoffRows, 0);
assert.equal(audit.settlementWorkerAttentionRequired, true);
assert.equal(audit.denominatorReconciled, true);
assert.deepEqual(audit.pendingKickoffRange, {
  earliest: ineligible.kickoffAt,
  latest: future.kickoffAt,
});
assert.equal(JSON.stringify(audit).includes("1004"), false);
assert.equal(JSON.stringify(audit).includes("decision-eligible"), false);

const diagnosticAudit = buildCandidateProspectiveTemporalAudit({
  registry,
  matches,
  evaluatedAt: checkedAt,
  includeDiagnostics: true,
  diagnosticLimit: 10,
});
assert.equal(diagnosticAudit.diagnosticRows.length, 5);
assert.equal(diagnosticAudit.diagnosticRowsTruncated, 0);
assert.deepEqual(
  diagnosticAudit.diagnosticRows.map((row) => row.classification),
  [
    "future-kickoff",
    "awaiting-official-final",
    "read-model-row-missing",
    "official-finished-eligible-unsettled",
    "official-finished-ineligible",
  ],
);
assert.ok(diagnosticAudit.diagnosticRows.some((row) => (
  row.sourceMatchId === "1004"
  && row.decisionEventHash === "decision-eligible"
  && row.resultProvider === "sporttery"
  && row.resultPromotionEligible === true
  && row.blockers.length === 0
)));
assert.ok(diagnosticAudit.diagnosticRows.some((row) => (
  row.sourceMatchId === "1005"
  && row.classification === "official-finished-ineligible"
  && row.blockers.includes("not-official-sporttery-final")
)));
assert.equal(
  Object.hasOwn(audit, "diagnosticRows"),
  false,
);

const truncatedDiagnosticAudit = buildCandidateProspectiveTemporalAudit({
  registry,
  matches,
  evaluatedAt: checkedAt,
  includeDiagnostics: true,
  diagnosticLimit: 2,
});
assert.equal(truncatedDiagnosticAudit.diagnosticRows.length, 2);
assert.equal(truncatedDiagnosticAudit.diagnosticRowsTruncated, 3);

const voided = decision("decision-void", "1007", "2026-07-30T22:00:00.000Z");
const officialVoidAudit = buildCandidateProspectiveTemporalAudit({
  registry: {
    activeLedgerId: "void-ledger",
    ledgers: [{ ledgerId: "void-ledger", events: [voided] }],
  },
  matches: [{
    id: "sporttery_1007",
    sourceMatchId: "1007",
    kickoffTime: voided.kickoffAt,
    status: "PENDING_RESULT",
    resultDisposition: "VOID",
    voidReason: "OFFICIAL_INVALID_MATCH",
    voidSource: "sporttery:official-api",
  }],
  evaluatedAt: checkedAt,
  includeDiagnostics: true,
});
assert.equal(officialVoidAudit.pendingRows, 1);
assert.equal(officialVoidAudit.kickoffPassedRows, 1);
assert.equal(officialVoidAudit.officialVoidRows, 1);
assert.equal(officialVoidAudit.awaitingOfficialFinalRows, 0);
assert.equal(officialVoidAudit.officialResultRecordMissingRows, 0);
assert.equal(officialVoidAudit.diagnosticRows[0]?.classification, "official-void");

const empty = buildCandidateProspectiveTemporalAudit({
  registry: null,
  evaluatedAt: checkedAt,
});
assert.equal(empty.activeLedgerPresent, false);
assert.equal(empty.denominatorReconciled, true);
assert.equal(empty.settlementWorkerAttentionRequired, false);
assert.deepEqual(empty.officialFinishedIneligibleReasonCounts, {});
assert.deepEqual(empty.officialFinishedIneligiblePrimaryReasonCounts, {});

console.log(JSON.stringify({
  ok: true,
  version: VERSION,
  checks: 43,
  audit,
}, null, 2));
