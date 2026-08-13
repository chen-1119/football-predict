const assert = require("node:assert/strict");
const {
  summarizeCandidateProspectiveAdmission,
  summarizeCandidateProspectiveExclusions,
} = require("../server/candidateProspectiveAdmission.cjs");

const registry = {
  activeLedgerId: "ledger-active",
  ledgers: [{
    ledgerId: "ledger-active",
    events: [
      {
        type: "decision",
        sourceMatchId: "sporttery_101",
        kickoffAt: "2026-07-29T12:00:00.000Z",
      },
      {
        type: "exclusion",
        sourceMatchId: "102",
        kickoffAt: "2026-07-29T13:00:00.000Z",
      },
    ],
  }],
};

const readiness = {
  evaluatedAt: "2026-07-29T10:30:00.000Z",
  upcomingMatches: 5,
  rows: [
    {
      sourceMatchId: "101",
      kickoffAt: "2026-07-29T12:00:00.000Z",
      decisionDeadlineAt: "2026-07-29T10:00:00.000Z",
      status: "ready-now",
    },
    {
      sourceMatchId: "sporttery_102",
      kickoffAt: "2026-07-29T13:00:00.000Z",
      decisionDeadlineAt: "2026-07-29T10:10:00.000Z",
      status: "blocked",
    },
    {
      sourceMatchId: "103",
      kickoffAt: "2026-07-29T14:00:00.000Z",
      decisionDeadlineAt: "2026-07-29T10:20:00.000Z",
      status: "ready-now",
    },
    {
      sourceMatchId: "104",
      kickoffAt: "2026-07-29T15:00:00.000Z",
      decisionDeadlineAt: "2026-07-29T11:00:00.000Z",
      status: "ready-now",
    },
    {
      sourceMatchId: "105",
      kickoffAt: "2026-07-29T16:00:00.000Z",
      decisionDeadlineAt: "2026-07-29T11:30:00.000Z",
      status: "awaiting-market",
    },
  ],
};

const summary = summarizeCandidateProspectiveAdmission({ readiness, registry });
assert.equal(summary.version, "candidate-prospective-admission-summary-v1");
assert.equal(summary.registryAvailable, true);
assert.equal(summary.expectedRows, 5);
assert.equal(summary.auditedRows, 5);
assert.equal(summary.admitted, 1);
assert.equal(summary.excluded, 1);
assert.equal(summary.dueUnrecorded, 1);
assert.equal(summary.pendingDeadline, 2);
assert.equal(summary.readyAlreadyAdmitted, 1);
assert.equal(summary.readyDueUnrecorded, 1);
assert.equal(summary.readyPendingDeadline, 1);
assert.equal(summary.unreconciled, 0);
assert.equal(summary.captureGap, true);
assert.equal(summary.reconciled, true);
assert.equal(summary.auditMode, "detailed-rows");

const truncatedReadiness = {
  evaluatedAt: "2026-07-30T10:10:03.799Z",
  upcomingMatches: 43,
  detailedMatches: 16,
  rowsTruncated: 27,
  readyNow: 8,
  rows: Array.from({ length: 16 }, (_, index) => ({
    sourceMatchId: `preview-${index + 1}`,
    kickoffAt: "2026-07-31T01:00:00.000Z",
    decisionDeadlineAt: "2026-07-30T14:00:00.000Z",
    captureFinalizationAt: "2026-07-30T14:02:00.000Z",
    status: index < 8 ? "ready-now" : "awaiting-market",
  })),
  deadlineBatches: [{
    version: "candidate-deadline-batch-summary-v1",
    deadlineAt: "2026-07-30T14:00:00.000Z",
    finalizationAt: "2026-07-30T14:02:00.000Z",
    phase: "upcoming",
    totalMatches: 43,
    actionableMatches: 43,
    readyNow: 8,
    awaitingMarket: 35,
    blocked: 0,
    excluded: 0,
    terminalDecisions: 0,
    terminalExclusions: 0,
    duplicateTerminalEvents: 0,
    terminalKeysWithDuplicates: 0,
    terminalMatches: 0,
    dueUnrecorded: 0,
    readyDueUnrecorded: 0,
    invariantOk: true,
  }],
};
const truncatedSummary = summarizeCandidateProspectiveAdmission({
  readiness: truncatedReadiness,
  registry,
});
assert.equal(truncatedSummary.auditMode, "deadline-batch-aggregate");
assert.equal(truncatedSummary.expectedRows, 43);
assert.equal(truncatedSummary.auditedRows, 43);
assert.equal(truncatedSummary.pendingDeadline, 43);
assert.equal(truncatedSummary.readyPendingDeadline, 8);
assert.equal(truncatedSummary.dueUnrecorded, 0);
assert.equal(truncatedSummary.readyDueUnrecorded, 0);
assert.equal(truncatedSummary.unreconciled, 0);
assert.equal(truncatedSummary.captureGap, false);
assert.equal(truncatedSummary.reconciled, true);

const duplicateBatchReadiness = structuredClone(truncatedReadiness);
duplicateBatchReadiness.deadlineBatches[0].duplicateTerminalEvents = 1;
duplicateBatchReadiness.deadlineBatches[0].terminalKeysWithDuplicates = 1;
duplicateBatchReadiness.deadlineBatches[0].invariantOk = false;
const duplicateBatchSummary = summarizeCandidateProspectiveAdmission({
  readiness: duplicateBatchReadiness,
  registry,
});
assert.equal(duplicateBatchSummary.auditMode, "detailed-rows");
assert.equal(duplicateBatchSummary.auditedRows, 16);
assert.equal(duplicateBatchSummary.reconciled, false);

const finalizationGraceReadiness = {
  evaluatedAt: "2026-07-29T10:30:00.000Z",
  upcomingMatches: 1,
  rows: [{
    sourceMatchId: "106",
    kickoffAt: "2026-07-29T14:00:00.000Z",
    decisionDeadlineAt: "2026-07-29T10:20:00.000Z",
    captureFinalizationAt: "2026-07-29T10:32:00.000Z",
    status: "ready-now",
  }],
};
const finalizationGraceSummary = summarizeCandidateProspectiveAdmission({
  readiness: finalizationGraceReadiness,
  registry,
});
assert.equal(finalizationGraceSummary.pendingDeadline, 1);
assert.equal(finalizationGraceSummary.readyPendingDeadline, 1);
assert.equal(finalizationGraceSummary.dueUnrecorded, 0);
assert.equal(finalizationGraceSummary.readyDueUnrecorded, 0);
assert.equal(finalizationGraceSummary.captureGap, false);
assert.equal(finalizationGraceSummary.reconciled, true);

const missingRegistry = summarizeCandidateProspectiveAdmission({
  readiness,
  registry: null,
});
assert.equal(missingRegistry.registryAvailable, false);
assert.equal(missingRegistry.auditedRows, 0);
assert.equal(missingRegistry.unreconciled, 5);
assert.equal(missingRegistry.captureGap, false);
assert.equal(missingRegistry.reconciled, false);

const exclusionAudit = summarizeCandidateProspectiveExclusions({ registry });
assert.equal(exclusionAudit.version, "candidate-prospective-exclusion-audit-v1");
assert.equal(exclusionAudit.registryAvailable, true);
assert.equal(exclusionAudit.activeLedgerId, "ledger-active");
assert.equal(exclusionAudit.total, 1);
assert.equal(exclusionAudit.formal, 0);
assert.equal(exclusionAudit.shadow, 0);
assert.deepEqual(exclusionAudit.phaseCounts, { unknown: 1 });
assert.deepEqual(exclusionAudit.blockerCounts, {
  "exclusion-reason-missing": 1,
});
assert.deepEqual(exclusionAudit.reasonCounts, {
  "exclusion-reason-unclassified": 1,
});
assert.equal(exclusionAudit.rows.length, 1);
assert.equal(exclusionAudit.rows[0].sourceMatchId, "102");
assert.equal(exclusionAudit.rowsTruncated, 0);

const exclusionRegistry = structuredClone(registry);
exclusionRegistry.ledgers[0].events.push(
  {
    type: "exclusion",
    sequence: 4,
    phase: "formal",
    matchId: "sporttery_103",
    sourceMatchId: "103",
    kickoffAt: "2026-07-29T14:00:00.000Z",
    decisionDeadlineAt: "2026-07-29T10:20:00.000Z",
    captureFinalizationAt: "2026-07-29T10:22:00.000Z",
    recordedAt: "2026-07-29T10:22:30.000Z",
    primaryExclusionReason: "official-had-market-not-published",
    marketState: "official-had-market-not-published",
    officialHadMarketPresent: false,
    strictOfficialMarketEvidenceComplete: false,
    hhadCompanionEvidenceComplete: true,
    blockers: [
      "official-had-market-not-published",
      "official-had-market-not-published",
      "candidate-activation-after-deadline",
    ],
  },
  {
    type: "exclusion",
    sequence: 5,
    phase: "pre-gate-shadow",
    matchId: "sporttery_104",
    sourceMatchId: "104",
    kickoffAt: "2026-07-29T15:00:00.000Z",
    recordedAt: "2026-07-29T10:23:30.000Z",
    primaryExclusionReason: "pre-match-ledger-capture-missed",
    marketState: "capture-missed-before-kickoff",
    officialHadMarketPresent: false,
    strictOfficialMarketEvidenceComplete: false,
    hhadCompanionEvidenceComplete: false,
    blockers: ["pre-match-ledger-capture-missed"],
  },
);
const detailedExclusionAudit = summarizeCandidateProspectiveExclusions({
  registry: exclusionRegistry,
  limit: 1,
});
assert.equal(detailedExclusionAudit.total, 3);
assert.equal(detailedExclusionAudit.formal, 1);
assert.equal(detailedExclusionAudit.shadow, 1);
assert.deepEqual(detailedExclusionAudit.phaseCounts, {
  formal: 1,
  "pre-gate-shadow": 1,
  unknown: 1,
});
assert.deepEqual(detailedExclusionAudit.blockerCounts, {
  "candidate-activation-after-deadline": 1,
  "exclusion-reason-missing": 1,
  "official-had-market-not-published": 1,
  "pre-match-ledger-capture-missed": 1,
});
assert.deepEqual(detailedExclusionAudit.reasonCounts, {
  "exclusion-reason-unclassified": 1,
  "official-had-market-not-published": 1,
  "pre-match-ledger-capture-missed": 1,
});
assert.equal(detailedExclusionAudit.rows.length, 1);
assert.equal(detailedExclusionAudit.rows[0].sourceMatchId, "104");
assert.equal(
  detailedExclusionAudit.rows[0].primaryExclusionReason,
  "pre-match-ledger-capture-missed",
);
assert.equal(
  detailedExclusionAudit.rows[0].marketState,
  "capture-missed-before-kickoff",
);
assert.deepEqual(
  detailedExclusionAudit.rows[0].blockers,
  ["pre-match-ledger-capture-missed"],
);
assert.equal(detailedExclusionAudit.rowsTruncated, 2);

const missingExclusionAudit = summarizeCandidateProspectiveExclusions({
  registry: null,
});
assert.equal(missingExclusionAudit.registryAvailable, false);
assert.equal(missingExclusionAudit.total, 0);
assert.deepEqual(missingExclusionAudit.rows, []);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "candidate-prospective-admission",
  assertions: 65,
  summary,
  truncatedSummary,
  finalizationGraceSummary,
  exclusionAudit,
  detailedExclusionAudit,
}, null, 2)}\n`);
