"use strict";

const assert = require("node:assert/strict");
const {
  buildCapabilityAudit,
  coverageFor,
  evaluationAudit,
  snapshotClockAudit,
} = require("./predictionCapabilityAudit.cjs");
const {
  createCollectorAttestationTestContext,
} = require("./collectorAttestationTestFixture.cjs");

let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};

const matches = [
  {
    id: "sporttery_1",
    sourceMatchId: "1",
    status: "SCHEDULED",
    homeTeamId: "home-1",
    awayTeamId: "away-1",
    sourceCycleId: "relay:cycle-1",
    odds: { odds1: 2, oddsX: 3.2, odds2: 3.5 },
    predictionMeta: {
      featureSnapshot: {
        modelInputs: {
          dataGaps: {
            coverageScore: 72,
            connected: {
              officialOdds: true,
              lineup: true,
              injuries: true,
              xg: false,
              weather: true,
              referee: false,
              teamCards: false,
              standings: true,
              motivationStage: true,
              webConsensus: false,
              externalMarket: false,
            },
          },
        },
      },
    },
  },
  {
    id: "sporttery_2",
    sourceMatchId: "2",
    status: "SCHEDULED",
    homeTeamName: "Home Two",
    awayTeamName: "Away Two",
    predictionMeta: {
      featureSnapshot: {
        modelInputs: {
          dataGaps: {
            coverageScore: 18,
            connected: {},
          },
        },
      },
    },
  },
  {
    id: "sporttery_finished",
    sourceMatchId: "3",
    status: "FINISHED",
    homeTeamName: "Old Home",
    awayTeamName: "Old Away",
  },
];

const collectorContext = createCollectorAttestationTestContext({
  keyId: "prediction-capability-audit-ed25519",
});
const buildProvenance = (poolCode, odds, providerObservedAt, receivedAt, handicapLine = 0) => (
  collectorContext.buildSignedMarketProvenance({
    poolCode,
    sourceMatchId: "capability-fixture-1",
    odds,
    handicapLine,
    sourceUrl: "https://webapi.sporttery.cn/test",
    providerObservedAt,
    sourceTiming: {
      sourceCycleId: "capability-cycle-1",
      requestedAt: "2026-07-16T09:59:30.000Z",
      receivedAt,
      sourceRequest: { method: "GET", page: 1, role: "prediction-capability-audit" },
      httpStatus: 200,
      rawSha256: poolCode === "HAD" ? "a".repeat(64) : "b".repeat(64),
      rawBytes: 1024,
    },
  })
);
const goodHadOdds = { "1": 2, X: 3, "2": 4 };
const goodHhadOdds = { "1": 2, X: 3, "2": 4 };
const goodHadProvenance = buildProvenance(
  "HAD",
  goodHadOdds,
  "2026-07-16T09:59:40.000Z",
  "2026-07-16T09:59:45.000Z",
);
const goodHhadProvenance = buildProvenance(
  "HHAD",
  goodHhadOdds,
  "2026-07-16T09:59:41.000Z",
  "2026-07-16T09:59:46.000Z",
  -1,
);

const goodSnapshot = {
  decisionSnapshot: {
    version: "candidate-decision-snapshot-v2",
    sourceCycleId: "capability-cycle-1",
    capturedAt: "2026-07-16T09:59:46.000Z",
    decisionAt: "2026-07-16T10:00:00.000Z",
    cutoffTime: "2026-07-16T11:00:00.000Z",
    kickoffTime: "2026-07-16T12:00:00.000Z",
    markets: {
      HAD: {
        odds: goodHadOdds,
        observedAt: "2026-07-16T09:59:40.000Z",
        receivedAt: "2026-07-16T09:59:45.000Z",
        provenance: goodHadProvenance,
        provenanceHash: goodHadProvenance.hash,
      },
      HHAD: {
        odds: goodHhadOdds,
        line: -1,
        observedAt: "2026-07-16T09:59:41.000Z",
        receivedAt: "2026-07-16T09:59:46.000Z",
        provenance: goodHhadProvenance,
        provenanceHash: goodHhadProvenance.hash,
      },
    },
    sourceTimestamps: {
      modelGeneratedAt: "2026-07-16T09:59:50.000Z",
      baseModelGeneratedAt: "2026-07-16T09:59:49.000Z",
      unifiedPosteriorGeneratedAt: "2026-07-16T09:59:50.000Z",
      hadObservedAt: "2026-07-16T09:59:40.000Z",
      hhadObservedAt: "2026-07-16T09:59:41.000Z",
      hadReceivedAt: "2026-07-16T09:59:45.000Z",
      hhadReceivedAt: "2026-07-16T09:59:46.000Z",
    },
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: true,
      blockers: [],
      sourceCycleId: "capability-cycle-1",
      capturedAt: "2026-07-16T09:59:46.000Z",
      decisionAt: "2026-07-16T10:00:00.000Z",
      cutoffTime: "2026-07-16T11:00:00.000Z",
      kickoffTime: "2026-07-16T12:00:00.000Z",
      modelGeneratedAt: "2026-07-16T09:59:50.000Z",
      baseModelGeneratedAt: "2026-07-16T09:59:49.000Z",
      unifiedPosteriorGeneratedAt: "2026-07-16T09:59:50.000Z",
      markets: {
        HAD: {
          observedAt: "2026-07-16T09:59:40.000Z",
          receivedAt: "2026-07-16T09:59:45.000Z",
          provenanceHash: goodHadProvenance.hash,
          provenanceEligible: true,
          sourceCycleId: "capability-cycle-1",
        },
        HHAD: {
          observedAt: "2026-07-16T09:59:41.000Z",
          receivedAt: "2026-07-16T09:59:46.000Z",
          provenanceHash: goodHhadProvenance.hash,
          provenanceEligible: true,
          sourceCycleId: "capability-cycle-1",
        },
      },
    },
  },
};

const badSnapshot = {
  decisionSnapshot: {
    version: "candidate-decision-snapshot-v2",
    decisionAt: "2026-07-16T10:00:00.000Z",
    markets: {
      HAD: { odds: { "1": 2, X: 3, "2": 4 } },
      HHAD: { odds: { "1": 2, X: 3, "2": 4 }, line: -1 },
    },
    sourceTimestamps: {
      modelGeneratedAt: "2026-07-16T10:00:01.000Z",
      hadObservedAt: "2026-07-16T09:59:40.000Z",
      hhadObservedAt: null,
      hadReceivedAt: null,
      hhadReceivedAt: null,
    },
  },
};

const weakEvaluation = {
  version: "rolling-backtest-v-test",
  generatedAt: "2026-07-16T10:05:00.000Z",
  marketBaseline: {
    metrics: { rows: 100, accuracy: 0.58, brier: 0.52, logLoss: 0.89 },
    modelOnSameRows: { rows: 100, accuracy: 0.53, brier: 0.61, logLoss: 1.01 },
    comparison: { rows: 100, accuracyDelta: -0.05, brierImprovement: -0.09, logLossImprovement: -0.12 },
  },
  walkForwardValidation: { sample: { folds: 0 }, eligible: false },
  residualMarketWalkForward: { sample: { completeFolds: 0 }, productionEligible: false },
  promotionEvidenceAudit: { manifest: { eligibleRows: 0 } },
  recommendationMetrics: { total: { settled: 0 } },
  recommendationSelection: { productionValidation: { eligible: false } },
  riskTiers: { overall: { tier: "watch" } },
};

const coverage = coverageFor(matches);
check(coverage.scope === "scheduled", "scheduled matches are the capability coverage scope when present");
check(coverage.scopeMatches === 2, "finished rows do not dilute scheduled feature coverage");
check(coverage.features.officialOdds.coveragePct === 50, "official odds coverage is calculated from real structured presence");
check(coverage.features.sourceCycle.coveragePct === 50, "source cycle coverage is explicit");
check(coverage.features.lineup.coveragePct === 50, "lineup coverage respects the connected evidence flag");
check(coverage.features.xg.coveragePct === 0, "missing xG stays missing");
check(coverage.averageDeclaredCoverage === 45, "declared data coverage is averaged only over explicit scores");

const clocks = snapshotClockAudit({ rows: [goodSnapshot, badSnapshot, { version: "legacy-v1" }] });
check(clocks.totalRows === 3, "all snapshot rows are counted for audit context");
check(clocks.v2Rows === 2, "only immutable v2 snapshots enter clock completeness");
check(clocks.completeClockRows === 1, "only the fully ordered v2 row is complete");
check(clocks.completeClockPct === 50, "clock completeness percentage is correct");
check(clocks.fields.modelOrdered.rows === 1, "a model timestamp after decision is rejected");
check(clocks.fields.hhadObservedOrdered.rows === 1, "missing HHAD observation time is rejected");
check(clocks.fields.hadReceivedOrdered.rows === 1, "missing HAD receive time is rejected");

const evalSummary = evaluationAudit(weakEvaluation);
check(evalSummary.pairedMarketRows === 100, "same-match market rows are reported");
check(evalSummary.improvementVsMarket.brier === -0.09, "Brier delta is preserved without optimistic rewriting");
check(evalSummary.formalRecommendationRows === 0, "formal recommendation evidence stays separate from probability rows");

const weak = buildCapabilityAudit({
  matches,
  snapshots: { rows: [goodSnapshot, badSnapshot] },
  evaluation: weakEvaluation,
  apiFootballMeta: {
    failClosed: true,
    accountStatus: {
      blocked: true,
      eligible: false,
      blockers: ["account-suspended"],
      reason: "Account suspended",
      checkedAt: "2026-07-16T09:50:00.000Z",
    },
  },
  sourceHashes: { z: "hash-z", a: "hash-a" },
  generatedAt: "2026-07-16T10:10:00.000Z",
});

check(weak.learningReadiness.status === "blocked-shadow", "weak evidence cannot leave shadow mode");
check(weak.learningReadiness.productionActivationAllowed === false, "capability audit never activates production by itself");
check(weak.learningReadiness.blockers.includes("paired-market-rows-below-500"), "small paired sample is a blocker");
check(weak.learningReadiness.blockers.includes("model-does-not-beat-market-brier"), "market Brier loss is a blocker");
check(weak.learningReadiness.blockers.includes("model-does-not-beat-market-logloss"), "market log-loss loss is a blocker");
check(weak.learningReadiness.blockers.includes("decision-snapshot-clock-coverage-below-95pct"), "incomplete clocks are a blocker");
check(weak.learningReadiness.blockers.includes("supplemental-provider-blocked"), "provider suspension remains visible");
check(weak.acquisitionQueue[0].priority === "critical", "critical provenance or official data gaps lead the queue");
check(weak.acquisitionQueue.some((item) => item.feature === "lineup" && item.providerBlocked), "blocked lineup provider is explicit");
check(weak.acquisitionQueue.some((item) => item.feature === "xg" && /StatsBomb/.test(item.source)), "historical xG acquisition has an explicit source and scope");
check(weak.aiBoundary.numericControl === false, "AI has no numeric-control authority");
check(weak.aiBoundary.ragRecommended === true, "RAG is recommended for cited evidence retrieval");
check(weak.aiBoundary.prohibited.includes("create missing structured statistics"), "RAG cannot manufacture missing data");
check(/^[a-f0-9]{64}$/.test(weak.auditHash), "audit is content-addressed");

const weakAgain = buildCapabilityAudit({
  matches,
  snapshots: { rows: [goodSnapshot, badSnapshot] },
  evaluation: weakEvaluation,
  apiFootballMeta: {
    failClosed: true,
    accountStatus: {
      blocked: true,
      eligible: false,
      blockers: ["account-suspended"],
      reason: "Account suspended",
      checkedAt: "2026-07-16T09:50:00.000Z",
    },
  },
  sourceHashes: { a: "hash-a", z: "hash-z" },
  generatedAt: "2026-07-16T10:10:00.000Z",
});
check(weakAgain.auditHash === weak.auditHash, "audit hash is deterministic across input key order");

const strongEvaluation = {
  ...weakEvaluation,
  marketBaseline: {
    metrics: { rows: 500, accuracy: 0.58, brier: 0.52, logLoss: 0.89 },
    modelOnSameRows: { rows: 500, accuracy: 0.6, brier: 0.5, logLoss: 0.86 },
    comparison: { rows: 500, accuracyDelta: 0.02, brierImprovement: 0.02, logLossImprovement: 0.03 },
  },
  walkForwardValidation: { sample: { folds: 6 }, eligible: true },
  residualMarketWalkForward: { sample: { completeFolds: 3 }, productionEligible: true },
  promotionEvidenceAudit: { manifest: { eligibleRows: 120 } },
  recommendationSelection: { productionValidation: { eligible: true } },
};
const strong = buildCapabilityAudit({
  matches,
  snapshots: { rows: [goodSnapshot] },
  evaluation: strongEvaluation,
  apiFootballMeta: {
    accountStatus: { blocked: false, eligible: true, blockers: [] },
  },
  generatedAt: "2026-07-16T10:10:00.000Z",
});
check(strong.learningReadiness.status === "candidate-review", "sufficient evidence reaches review, not automatic production");
check(strong.learningReadiness.blockers.length === 0, "healthy synthetic evidence has no learning blocker");
check(strong.learningReadiness.productionActivationAllowed === false, "even healthy audit still requires the separate promotion/runtime contract");

collectorContext.cleanup();
console.log(`Prediction capability audit verification passed (${assertions} assertions).`);
