"use strict";

const assert = require("node:assert/strict");

process.env.CANDIDATE_PROSPECTIVE_READINESS_PREVIEW_LIMIT = "16";

const {
  candidateReadinessPreview,
} = require("./captureCandidateProspectiveDeadline.cjs");

const frozenAt = "2026-07-29T00:00:00.000Z";
const evaluatedAt = "2026-07-29T01:00:00.000Z";
const kickoffStart = Date.parse("2026-07-30T00:00:00.000Z");
const matches = Array.from({ length: 20 }, (_, index) => {
  const kickoffMs = kickoffStart + index * 60_000;
  return {
    id: `sporttery_full-coverage-${index + 1}`,
    sourceMatchId: `full-coverage-${index + 1}`,
    kickoffTime: new Date(kickoffMs).toISOString(),
    buyEndTime: new Date(kickoffMs - 60 * 60_000).toISOString(),
    status: "SCHEDULED",
  };
});

const readiness = candidateReadinessPreview({
  ledger: {
    header: {
      frozenAt,
      candidateRevisionId: "candidate-full-coverage@test",
    },
  },
  matches,
  snapshots: [],
  evaluatedAt,
  trustedCollectorCount: 2,
});

assert.equal(readiness.version, "candidate-prospective-readiness-preview-v2");
assert.equal(readiness.previewLimit, 16);
assert.equal(readiness.evaluatedMatches, 20);
assert.equal(readiness.detailedMatches, 16);
assert.equal(readiness.rowsTruncated, 4);
assert.equal(readiness.upcomingMatches, 20);
assert.equal(readiness.readyNow, 0);
assert.equal(readiness.atomicReadyNow, 0);
assert.equal(readiness.awaitingMarket, 20);
assert.equal(readiness.blocked, 0);
assert.equal(readiness.excluded, 0);
assert.equal(readiness.readyInvariantOk, true);
assert.equal(readiness.readinessRatio, 0);
assert.equal(readiness.rows.length, 16);
assert.equal(
  readiness.marketCoverage.version,
  "candidate-official-market-coverage-preview-v1",
);
assert.equal(readiness.marketCoverage.evaluatedMatches, 20);
assert.equal(readiness.marketCoverage.decisionSnapshotObservedMatches, 0);
assert.equal(readiness.marketCoverage.officialHadPublishedMatches, 0);
assert.equal(readiness.marketCoverage.strictMarketEvidenceCompleteMatches, 0);
assert.equal(readiness.marketCoverage.atomicReadyMatches, 0);
assert.equal(readiness.marketCoverage.awaitingUnpublishedMatches, 0);
assert.equal(readiness.marketCoverage.awaitingSnapshotMissingMatches, 20);
assert.equal(readiness.marketCoverage.publishedChainGapMatches, 0);
assert.equal(readiness.marketCoverage.awaitingClassifiedMatches, 20);
assert.equal(readiness.marketCoverage.awaitingClassificationComplete, true);
assert.equal(
  readiness.awaitingReasonCounts["eligible-decision-snapshot-not-observed"],
  20,
);
assert.equal(
  readiness.blockerCounts["eligible-deadline-snapshot-missing"],
  20,
);
assert.deepEqual(readiness.excludedReasonCounts, {});
assert.equal(
  readiness.nearestDeadlineAt,
  matches[0].buyEndTime,
);
assert.equal(readiness.nearestStatus, "awaiting-market");

const readinessWithFinalizedExclusion = candidateReadinessPreview({
  ledger: {
    header: {
      frozenAt,
      candidateRevisionId: "candidate-full-coverage@test",
    },
    events: [{
      type: "exclusion",
      matchId: matches[0].id,
      sourceMatchId: matches[0].sourceMatchId,
      kickoffAt: matches[0].kickoffTime,
      decisionDeadlineAt: matches[0].buyEndTime,
      captureFinalizationAt: new Date(
        Date.parse(matches[0].buyEndTime) + 120_000,
      ).toISOString(),
      recordedAt: "2026-07-29T00:02:00.000Z",
      blockers: ["candidate-activated-after-deadline"],
    }],
  },
  matches,
  snapshots: [],
  evaluatedAt,
  trustedCollectorCount: 2,
});

assert.equal(readinessWithFinalizedExclusion.excluded, 1);
assert.equal(readinessWithFinalizedExclusion.awaitingMarket, 19);
assert.equal(readinessWithFinalizedExclusion.readyInvariantOk, true);
assert.equal(
  readinessWithFinalizedExclusion.marketCoverage.awaitingSnapshotMissingMatches,
  19,
);
assert.equal(
  readinessWithFinalizedExclusion.marketCoverage.terminalExcludedMatches,
  1,
);
assert.equal(
  readinessWithFinalizedExclusion.marketCoverage.awaitingClassificationComplete,
  true,
);
assert.equal(
  readinessWithFinalizedExclusion.blockerCounts["eligible-deadline-snapshot-missing"],
  19,
);
assert.equal(
  readinessWithFinalizedExclusion.excludedReasonCounts["candidate-activated-after-deadline"],
  1,
);
assert.equal(
  readinessWithFinalizedExclusion.nearestDeadlineAt,
  matches[1].buyEndTime,
);
assert.equal(
  readinessWithFinalizedExclusion.rows[0].status,
  "excluded",
);

const readinessWithUnpublishedOfficialMarket = candidateReadinessPreview({
  ledger: {
    header: {
      frozenAt,
      candidateRevisionId: "candidate-full-coverage@test",
      candidateDefinition: {
        id: "market-current-model-residual-minus-20-temperature-0_9",
        marketResidualWeight: -0.2,
        temperature: 0.9,
      },
      candidateSpecHash: "1".repeat(64),
      gateSpecHash: "2".repeat(64),
    },
  },
  matches: [matches[0]],
  snapshots: [{
    matchId: matches[0].id,
    sourceMatchId: matches[0].sourceMatchId,
    firstSeenAt: evaluatedAt,
    capturedAt: evaluatedAt,
    decisionSnapshot: {
      version: "candidate-decision-snapshot-v2",
      matchId: matches[0].id,
      sourceMatchId: matches[0].sourceMatchId,
      capturedAt: evaluatedAt,
      decisionAt: evaluatedAt,
      clockAudit: { eligible: true },
      markets: {},
      probabilities: {
        HAD: { "1": 0.4, X: 0.3, "2": 0.3 },
      },
    },
  }],
  evaluatedAt,
  trustedCollectorCount: 1,
});

assert.equal(readinessWithUnpublishedOfficialMarket.awaitingMarket, 1);
assert.equal(readinessWithUnpublishedOfficialMarket.blocked, 0);
assert.equal(
  readinessWithUnpublishedOfficialMarket.rows[0].marketState,
  "official-had-market-not-published",
);
assert.equal(
  readinessWithUnpublishedOfficialMarket.rows[0].awaitingReason,
  "official-had-market-not-published",
);
assert.equal(
  readinessWithUnpublishedOfficialMarket.marketCoverage
    .decisionSnapshotObservedMatches,
  1,
);
assert.equal(
  readinessWithUnpublishedOfficialMarket.marketCoverage
    .officialHadPublishedMatches,
  0,
);
assert.equal(
  readinessWithUnpublishedOfficialMarket.marketCoverage
    .awaitingUnpublishedMatches,
  1,
);
assert.equal(
  readinessWithUnpublishedOfficialMarket.marketCoverage
    .awaitingSnapshotMissingMatches,
  0,
);
assert.equal(
  readinessWithUnpublishedOfficialMarket.marketCoverage
    .publishedChainGapMatches,
  0,
);
assert.equal(
  readinessWithUnpublishedOfficialMarket.marketCoverage
    .awaitingClassificationComplete,
  true,
);
assert.equal(
  readinessWithUnpublishedOfficialMarket
    .awaitingReasonCounts["official-had-market-not-published"],
  1,
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "candidate-readiness-full-coverage",
  assertions: 48,
  readiness: {
    evaluatedMatches: readiness.evaluatedMatches,
    detailedMatches: readiness.detailedMatches,
    rowsTruncated: readiness.rowsTruncated,
    upcomingMatches: readiness.upcomingMatches,
    awaitingMarket: readiness.awaitingMarket,
    readyInvariantOk: readiness.readyInvariantOk,
    marketCoverage: readiness.marketCoverage,
  },
}, null, 2)}\n`);
