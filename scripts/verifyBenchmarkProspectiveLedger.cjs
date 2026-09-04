"use strict";

const assert = require("node:assert/strict");
const {
  buildBenchmarkProspectiveAudit,
  buildSnapshotDecision,
  verifyLedger,
} = require("./benchmarkProspectiveLedger.cjs");
const {
  GOODWIN_BENCHMARK_SHADOW_POLICY,
} = require("../src/services/benchmarkSelectionPolicy.cjs");
const {
  statusFromSporttery,
} = require("../src/services/sportteryStatus.cjs");

const kickoffTime = "2026-07-27T20:00:00+08:00";
const cutoffTime = "2026-07-27T19:50:00+08:00";

const makeMatch = ({
  sourceMatchId = "prospective-001",
  kickoff = kickoffTime,
  cutoff = cutoffTime,
  status = "FINISHED",
  scoreHome = 2,
  scoreAway = 0,
  actualKickoffAt = null,
  firstInPlayObservedAt = null,
} = {}) => {
  const resultObservedAt = new Date(Date.parse(kickoff) + (30 * 60_000)).toISOString();
  return ({
  id: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  status,
  leagueName: "验证联赛",
  homeTeamName: "主队",
  awayTeamName: "客队",
  businessDate: "2026-07-27",
  kickoffTime: kickoff,
  cutoffTime: cutoff,
  scoreHome,
  scoreAway,
  resultObservedAt,
  resultObservationSource: "sporttery-result-endpoint",
  resultObservationFallback: false,
  resultProvenance: {
    version: "result-provenance-v2",
    provider: "sporttery",
    official: true,
    trusted: true,
    promotionEligible: true,
    secondaryResultVerified: true,
    eventVersionConsistent: true,
    resultObservationFallback: false,
    observationSource: "sporttery-result-endpoint",
    sourceMatchId,
    eventVersion: new Date(kickoff).toISOString(),
    scoreHome,
    scoreAway,
    observedAt: resultObservedAt,
    ...(actualKickoffAt ? {
      actualKickoffAt,
      actualKickoffSource: "official-event-clock",
    } : {}),
    ...(firstInPlayObservedAt ? {
      firstInPlayObservedAt,
      inPlayObservationSource: "sporttery-official-live-status",
    } : {}),
  },
  });
};

const makeSnapshot = ({
  sourceMatchId = "prospective-001",
  kickoff = kickoffTime,
  cutoff = cutoffTime,
  capturedAt = "2026-07-27T11:40:00.000Z",
  firstSeenAt = null,
  decisionAt = null,
  tipCode = "1",
  odds = 1.6,
  trustScore = 70,
  phase = "final",
} = {}) => {
  const capturedMillis = Date.parse(capturedAt);
  const resolvedFirstSeenAt = firstSeenAt
    || new Date(capturedMillis + 2_000).toISOString();
  const resolvedDecisionAt = decisionAt
    || new Date(capturedMillis + 3_000).toISOString();
  const observedAt = new Date(capturedMillis - 30_000).toISOString();
  const receivedAt = new Date(capturedMillis - 20_000).toISOString();
  const probabilities = { "1": 0.64, X: 0.22, "2": 0.14 };
  const marketProbabilities = { "1": 0.6, X: 0.24, "2": 0.16 };
  const marketOdds = { "1": 1.6, X: 4, "2": 6 };
  return {
    sourceMatchId,
    matchId: `sporttery_${sourceMatchId}`,
    phase,
    status: "SCHEDULED",
    capturedAt,
    firstSeenAt: resolvedFirstSeenAt,
    kickoffTime: kickoff,
    cutoffTime: cutoff,
    decisionSnapshotVersion: "candidate-decision-snapshot-v2",
    featureSnapshotHash: `feature-${sourceMatchId}`,
    best: {
      tipCode,
      oddsPoolCode: "HAD",
      odds,
      trustScore,
      recommendationAction: "reference",
    },
    decisionSnapshot: {
      version: "candidate-decision-snapshot-v2",
      capturedAt,
      decisionAt: resolvedDecisionAt,
      sourceCycleId: `cycle-${sourceMatchId}`,
      sourceMatchId,
      matchId: `sporttery_${sourceMatchId}`,
      kickoffTime: kickoff,
      cutoffTime: cutoff,
      featureSnapshotHash: `feature-${sourceMatchId}`,
      policyHash: `policy-${sourceMatchId}`,
      clockAudit: {
        eligible: true,
      },
      markets: {
        HAD: {
          odds: marketOdds,
          marketProbabilities,
          observedAt,
          receivedAt,
          provenanceHash: `market-${sourceMatchId}`,
          provenance: {
            provider: {
              id: "sporttery",
              official: true,
            },
            market: {
              poolCode: "HAD",
              sourceMatchId,
            },
            timing: {
              providerObservedAt: observedAt,
              receivedAt,
            },
            strict: {
              eligible: true,
            },
            hash: `market-${sourceMatchId}`,
          },
        },
      },
      probabilities: {
        HAD: probabilities,
      },
      candidates: [{
        key: `HAD:${tipCode}:0`,
        market: "HAD",
        code: tipCode,
        odds,
        evidenceScore: trustScore,
      }],
    },
  };
};

const makeClosingOdds = ({
  sourceMatchId = "prospective-001",
  kickoff = kickoffTime,
  cutoff = cutoffTime,
} = {}) => ({
  sourceMatchId,
  poolCode: "HAD",
  kickoffTime: kickoff,
  cutoffTime: cutoff,
  capturedAt: "2026-07-27T11:47:00.000Z",
  firstSeenAt: "2026-07-27T11:47:00.000Z",
  oddsObservedAt: "2026-07-27T11:47:00.000Z",
  oddsReceivedAt: "2026-07-27T11:47:01.000Z",
  odds1: 1.55,
  oddsX: 4.1,
  odds2: 6.2,
  marketProvenance: {
    provider: {
      id: "sporttery",
      official: true,
    },
    timing: {
      providerObservedAt: "2026-07-27T11:47:00.000Z",
      receivedAt: "2026-07-27T11:47:01.000Z",
    },
    strict: {
      eligible: true,
    },
  },
});

const researchAudit = {
  walkForward: {
    selectedRows: 6,
    foldCount: 5,
    metrics: {
      settled: 6,
      won: 5,
      lost: 1,
      hitRate: 5 / 6,
      confidence95Percent: [43.65, 96.99],
      roiPercent: 25.17,
    },
  },
};

const prepared = buildBenchmarkProspectiveAudit({
  matches: [makeMatch({ status: "SCHEDULED" })],
  snapshots: [makeSnapshot()],
  oddsRows: [makeClosingOdds()],
  evaluatedAt: "2026-07-27T11:45:00.000Z",
  researchAudit,
});
assert.equal(prepared.ledgerUpdate.ledger.events.length, 1);
assert.equal(prepared.ledgerUpdate.ledger.events[0].type, "universe");

const selected = buildBenchmarkProspectiveAudit({
  priorLedger: prepared.ledgerUpdate.ledger,
  matches: [makeMatch({ status: "SCHEDULED" })],
  snapshots: [makeSnapshot()],
  oddsRows: [makeClosingOdds()],
  evaluatedAt: "2026-07-27T11:50:30.000Z",
  researchAudit,
});

assert.equal(selected.ledgerUpdate.chainValid, true);
assert.equal(selected.ledgerUpdate.changed, true);
assert.equal(selected.ledgerUpdate.ledger.events.length, 3);
assert.deepEqual(selected.ledgerUpdate.ledger.events.map((event) => event.type), [
  "universe",
  "selection",
  "settlement_hold",
]);

const first = buildBenchmarkProspectiveAudit({
  priorLedger: selected.ledgerUpdate.ledger,
  matches: [makeMatch()],
  snapshots: [makeSnapshot()],
  oddsRows: [makeClosingOdds()],
  evaluatedAt: "2026-07-27T15:00:00.000Z",
  researchAudit,
});

assert.equal(first.ledgerUpdate.chainValid, true);
assert.equal(first.ledgerUpdate.changed, true);
assert.equal(first.ledgerUpdate.ledger.events.length, 4);
assert.deepEqual(first.ledgerUpdate.ledger.events.map((event) => event.type), [
  "universe",
  "selection",
  "settlement_hold",
  "settlement",
]);
assert.equal(first.audit.version, "goodwin-benchmark-prospective-shadow-v2");
assert.equal(first.audit.auditVersion, "goodwin-benchmark-prospective-audit-v3");
assert.equal(first.audit.research.selectedRows, 6);
assert.equal(first.audit.research.promotionEligible, false);
assert.equal(first.audit.prospective.cohort.selected, 1);
assert.equal(first.audit.prospective.cohort.settled, 1);
assert.equal(first.audit.prospective.cohort.won, 1);
assert.equal(first.audit.prospective.metrics.hitRate, 1);
assert.ok(first.audit.prospective.metrics.roiPercent > 0);
assert.equal(first.audit.prospective.metrics.closingLineRows, 1);
assert.equal(first.audit.prospective.chainValid, true);
assert.equal(first.audit.promotionReviewReady, false);
assert.equal(first.audit.formalOnlineEffect, false);
assert.equal(first.audit.gates.checks.timeIntegrityEvidence, false);
assert.equal(first.audit.gates.thresholds.minimumTimeIntegrityEvidenceCoverage, 0.95);

const rerun = buildBenchmarkProspectiveAudit({
  priorLedger: first.ledgerUpdate.ledger,
  matches: [makeMatch()],
  snapshots: [makeSnapshot(), makeSnapshot({ capturedAt: "2026-07-27T11:41:00.000Z" })],
  oddsRows: [makeClosingOdds()],
  evaluatedAt: "2026-07-27T15:05:00.000Z",
  researchAudit,
});
assert.equal(rerun.ledgerUpdate.changed, false);
assert.equal(rerun.ledgerUpdate.ledger.events.length, 4);

const revised = buildBenchmarkProspectiveAudit({
  priorLedger: rerun.ledgerUpdate.ledger,
  matches: [makeMatch({ scoreHome: 0, scoreAway: 1 })],
  snapshots: [makeSnapshot()],
  oddsRows: [makeClosingOdds()],
  evaluatedAt: "2026-07-28T02:00:00.000Z",
  researchAudit,
});
assert.equal(revised.ledgerUpdate.changed, true);
assert.equal(revised.ledgerUpdate.ledger.events.length, 5);
assert.equal(revised.ledgerUpdate.ledger.events[4].type, "settlement");
assert.equal(revised.ledgerUpdate.ledger.events[4].revision, 2);
assert.equal(revised.ledgerUpdate.ledger.events[4].outcome, "LOST");
assert.equal(
  revised.ledgerUpdate.ledger.events[4].supersedesSettlementHash,
  revised.ledgerUpdate.ledger.events[3].rowHash,
);

const beforeActivationId = "prospective-before-activation";
const beforeActivationKickoff = "2026-07-27T22:00:00+08:00";
const beforeActivationCutoff = "2026-07-27T21:50:00+08:00";
const excludedPrepared = buildBenchmarkProspectiveAudit({
  matches: [makeMatch({
    sourceMatchId: beforeActivationId,
    kickoff: beforeActivationKickoff,
    cutoff: beforeActivationCutoff,
  })],
  snapshots: [makeSnapshot({
    sourceMatchId: beforeActivationId,
    kickoff: beforeActivationKickoff,
    cutoff: beforeActivationCutoff,
    capturedAt: "2026-07-27T13:40:00.000Z",
    firstSeenAt: "2026-07-26T19:59:00.000Z",
    decisionAt: "2026-07-27T13:40:01.000Z",
  })],
  oddsRows: [],
  evaluatedAt: "2026-07-27T13:45:00.000Z",
  researchAudit,
});
const excluded = buildBenchmarkProspectiveAudit({
  priorLedger: excludedPrepared.ledgerUpdate.ledger,
  matches: [makeMatch({
    sourceMatchId: beforeActivationId,
    kickoff: beforeActivationKickoff,
    cutoff: beforeActivationCutoff,
  })],
  snapshots: [makeSnapshot({
    sourceMatchId: beforeActivationId,
    kickoff: beforeActivationKickoff,
    cutoff: beforeActivationCutoff,
    capturedAt: "2026-07-27T13:40:00.000Z",
    firstSeenAt: "2026-07-26T19:59:00.000Z",
    decisionAt: "2026-07-27T13:40:01.000Z",
  })],
  oddsRows: [],
  evaluatedAt: "2026-07-27T13:51:00.000Z",
  researchAudit,
});
assert.equal(excluded.audit.prospective.cohort.selected, 0);
assert.equal(excluded.audit.prospective.cohort.excluded, 1);
assert.equal(
  excluded.audit.prospective.exclusionBlockers["first-seen-at-before-activation"],
  1,
);

const noBacksearchId = "prospective-no-backsearch";
const noBacksearchKickoff = "2026-07-28T00:00:00+08:00";
const noBacksearchCutoff = "2026-07-27T23:50:00+08:00";
const qualifiedEarly = makeSnapshot({
  sourceMatchId: noBacksearchId,
  kickoff: noBacksearchKickoff,
  cutoff: noBacksearchCutoff,
  capturedAt: "2026-07-27T15:25:00.000Z",
  trustScore: 70,
  odds: 1.6,
});
const rejectedLast = makeSnapshot({
  sourceMatchId: noBacksearchId,
  kickoff: noBacksearchKickoff,
  cutoff: noBacksearchCutoff,
  capturedAt: "2026-07-27T15:40:00.000Z",
  trustScore: 55,
  odds: 1.6,
});
const noBacksearchMatch = makeMatch({
  sourceMatchId: noBacksearchId,
  kickoff: noBacksearchKickoff,
  cutoff: noBacksearchCutoff,
});
assert.equal(buildSnapshotDecision(qualifiedEarly, noBacksearchMatch).qualified, true);
assert.equal(buildSnapshotDecision(rejectedLast, noBacksearchMatch).qualified, false);
const noBacksearchPrepared = buildBenchmarkProspectiveAudit({
  matches: [noBacksearchMatch],
  snapshots: [qualifiedEarly, rejectedLast],
  oddsRows: [],
  evaluatedAt: "2026-07-27T15:45:00.000Z",
  researchAudit,
});
const noBacksearch = buildBenchmarkProspectiveAudit({
  priorLedger: noBacksearchPrepared.ledgerUpdate.ledger,
  matches: [noBacksearchMatch],
  snapshots: [qualifiedEarly, rejectedLast],
  oddsRows: [],
  evaluatedAt: "2026-07-27T15:51:00.000Z",
  researchAudit,
});
assert.equal(noBacksearch.audit.prospective.cohort.selected, 0);
assert.equal(noBacksearch.audit.prospective.cohort.excluded, 1);
assert.equal(noBacksearch.ledgerUpdate.ledger.events[1].status, "abstain_filter");
assert.ok(noBacksearch.ledgerUpdate.ledger.events[1].cutoffSnapshotHash);
assert.equal(
  noBacksearch.audit.prospective.exclusionBlockers["evidence-below-threshold"],
  1,
);

const missedHeartbeatId = "prospective-missed-heartbeat";
const missedHeartbeatMatch = makeMatch({
  sourceMatchId: missedHeartbeatId,
  kickoff: "2026-07-28T02:00:00+08:00",
  cutoff: "2026-07-28T01:50:00+08:00",
  status: "SCHEDULED",
});
const missedHeartbeatSnapshot = makeSnapshot({
  sourceMatchId: missedHeartbeatId,
  kickoff: missedHeartbeatMatch.kickoffTime,
  cutoff: missedHeartbeatMatch.cutoffTime,
  capturedAt: "2026-07-27T17:40:00.000Z",
});
const missedHeartbeatPrepared = buildBenchmarkProspectiveAudit({
  matches: [missedHeartbeatMatch],
  snapshots: [missedHeartbeatSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T17:45:00.000Z",
  researchAudit,
});
const missedHeartbeat = buildBenchmarkProspectiveAudit({
  priorLedger: missedHeartbeatPrepared.ledgerUpdate.ledger,
  matches: [missedHeartbeatMatch],
  snapshots: [missedHeartbeatSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T18:00:01.000Z",
  researchAudit,
});
assert.equal(missedHeartbeat.audit.prospective.cohort.selected, 0);
assert.equal(missedHeartbeat.audit.prospective.cohort.coverageGap, 1);
assert.equal(
  missedHeartbeat.audit.prospective.exclusionBlockers[
    "deadline-heartbeat-missed-before-kickoff"
  ],
  1,
);

const earlyKickoffId = "prospective-early-kickoff";
const earlyKickoffMatch = makeMatch({
  sourceMatchId: earlyKickoffId,
  kickoff: "2026-07-27T22:00:00+08:00",
  cutoff: "2026-07-27T21:50:00+08:00",
  status: "SCHEDULED",
});
const earlyKickoffSnapshot = makeSnapshot({
  sourceMatchId: earlyKickoffId,
  kickoff: earlyKickoffMatch.kickoffTime,
  cutoff: earlyKickoffMatch.cutoffTime,
  capturedAt: "2026-07-27T13:35:00.000Z",
});
const earlyKickoffPrepared = buildBenchmarkProspectiveAudit({
  matches: [earlyKickoffMatch],
  snapshots: [earlyKickoffSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T13:45:00.000Z",
  researchAudit,
});
const earlyKickoffSelected = buildBenchmarkProspectiveAudit({
  priorLedger: earlyKickoffPrepared.ledgerUpdate.ledger,
  matches: [earlyKickoffMatch],
  snapshots: [earlyKickoffSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T13:50:30.000Z",
  researchAudit,
});
const earlyKickoffSettled = buildBenchmarkProspectiveAudit({
  priorLedger: earlyKickoffSelected.ledgerUpdate.ledger,
  matches: [makeMatch({
    sourceMatchId: earlyKickoffId,
    kickoff: earlyKickoffMatch.kickoffTime,
    cutoff: earlyKickoffMatch.cutoffTime,
    actualKickoffAt: "2026-07-27T13:40:00.000Z",
  })],
  snapshots: [earlyKickoffSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T15:00:00.000Z",
  researchAudit,
});
const earlyKickoffSettlement = earlyKickoffSettled.ledgerUpdate.ledger.events.at(-1);
assert.equal(earlyKickoffSettlement.type, "settlement");
assert.equal(earlyKickoffSettlement.outcome, "VOID");
assert.equal(earlyKickoffSettlement.voidReason, "ACTUAL_KICKOFF_NOT_AFTER_DECISION_CUTOFF");
assert.equal(earlyKickoffSettlement.actualKickoffAt, "2026-07-27T13:40:00.000Z");
assert.equal(earlyKickoffSettled.audit.prospective.cohort.selected, 1);
assert.equal(earlyKickoffSettled.audit.prospective.cohort.void, 1);
assert.equal(earlyKickoffSettled.audit.prospective.cohort.settled, 0);

const verifiedClockId = "prospective-verified-kickoff-clock";
const verifiedClockMatch = makeMatch({
  sourceMatchId: verifiedClockId,
  kickoff: "2026-07-28T01:00:00+08:00",
  cutoff: "2026-07-28T00:50:00+08:00",
  status: "SCHEDULED",
});
const verifiedClockSnapshot = makeSnapshot({
  sourceMatchId: verifiedClockId,
  kickoff: verifiedClockMatch.kickoffTime,
  cutoff: verifiedClockMatch.cutoffTime,
  capturedAt: "2026-07-27T16:35:00.000Z",
});
const verifiedClockPrepared = buildBenchmarkProspectiveAudit({
  matches: [verifiedClockMatch],
  snapshots: [verifiedClockSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T16:45:00.000Z",
  researchAudit,
});
const verifiedClockSelected = buildBenchmarkProspectiveAudit({
  priorLedger: verifiedClockPrepared.ledgerUpdate.ledger,
  matches: [verifiedClockMatch],
  snapshots: [verifiedClockSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T16:50:30.000Z",
  researchAudit,
});
const verifiedClockSettled = buildBenchmarkProspectiveAudit({
  priorLedger: verifiedClockSelected.ledgerUpdate.ledger,
  matches: [makeMatch({
    sourceMatchId: verifiedClockId,
    kickoff: verifiedClockMatch.kickoffTime,
    cutoff: verifiedClockMatch.cutoffTime,
    actualKickoffAt: "2026-07-27T17:00:00.000Z",
  })],
  snapshots: [verifiedClockSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T18:30:00.000Z",
  researchAudit,
});
const verifiedClockSettlement = verifiedClockSettled.ledgerUpdate.ledger.events.at(-1);
assert.equal(verifiedClockSettlement.outcome, "WON");
assert.equal(verifiedClockSettled.audit.prospective.cohort.settled, 1);
assert.equal(verifiedClockSettled.audit.prospective.metrics.timeIntegrityEvidenceRows, 1);
assert.equal(verifiedClockSettled.audit.prospective.metrics.timeIntegrityEvidenceCoverage, 1);
assert.equal(verifiedClockSettled.audit.gates.checks.timeIntegrityEvidence, true);

assert.equal(
  statusFromSporttery("4", "2", "进行中", "2026-07-27T20:00:00.000Z", Date.parse("2026-07-27T19:30:00.000Z")),
  "LIVE",
);
assert.equal(
  statusFromSporttery("playing", "2", "", "2026-07-27T20:00:00.000Z", Date.parse("2026-07-27T19:30:00.000Z")),
  "LIVE",
);
assert.equal(
  statusFromSporttery("3", "3", "暂停销售", "2026-07-27T20:00:00.000Z", Date.parse("2026-07-27T19:30:00.000Z")),
  "SCHEDULED",
);

const earlyLiveId = "prospective-early-live-status";
const earlyLiveMatch = makeMatch({
  sourceMatchId: earlyLiveId,
  kickoff: "2026-07-27T23:00:00+08:00",
  cutoff: "2026-07-27T22:50:00+08:00",
  status: "SCHEDULED",
});
const earlyLiveSnapshot = makeSnapshot({
  sourceMatchId: earlyLiveId,
  kickoff: earlyLiveMatch.kickoffTime,
  cutoff: earlyLiveMatch.cutoffTime,
  capturedAt: "2026-07-27T14:35:00.000Z",
});
const earlyLivePrepared = buildBenchmarkProspectiveAudit({
  matches: [earlyLiveMatch],
  snapshots: [earlyLiveSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T14:45:00.000Z",
  researchAudit,
});
const earlyLiveSelected = buildBenchmarkProspectiveAudit({
  priorLedger: earlyLivePrepared.ledgerUpdate.ledger,
  matches: [earlyLiveMatch],
  snapshots: [earlyLiveSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T14:50:30.000Z",
  researchAudit,
});
const earlyLiveSettled = buildBenchmarkProspectiveAudit({
  priorLedger: earlyLiveSelected.ledgerUpdate.ledger,
  matches: [makeMatch({
    sourceMatchId: earlyLiveId,
    kickoff: earlyLiveMatch.kickoffTime,
    cutoff: earlyLiveMatch.cutoffTime,
    firstInPlayObservedAt: "2026-07-27T14:45:00.000Z",
  })],
  snapshots: [earlyLiveSnapshot],
  oddsRows: [],
  evaluatedAt: "2026-07-27T16:30:00.000Z",
  researchAudit,
});
const earlyLiveSettlement = earlyLiveSettled.ledgerUpdate.ledger.events.at(-1);
assert.equal(earlyLiveSettlement.outcome, "VOID");
assert.equal(earlyLiveSettlement.voidReason, "IN_PLAY_OBSERVED_NOT_AFTER_DECISION_CUTOFF");
assert.equal(earlyLiveSettlement.firstInPlayObservedAt, "2026-07-27T14:45:00.000Z");
assert.equal(earlyLiveSettled.audit.prospective.cohort.void, 1);
assert.equal(earlyLiveSettled.audit.prospective.cohort.settled, 0);

const tampered = JSON.parse(JSON.stringify(first.ledgerUpdate.ledger));
tampered.events[0].odds = 1.01;
assert.equal(verifyLedger(tampered, GOODWIN_BENCHMARK_SHADOW_POLICY).ok, false);
const tamperedUpdate = buildBenchmarkProspectiveAudit({
  priorLedger: tampered,
  matches: [makeMatch()],
  snapshots: [makeSnapshot()],
  oddsRows: [makeClosingOdds()],
  evaluatedAt: "2026-07-28T03:00:00.000Z",
  researchAudit,
});
assert.equal(tamperedUpdate.ledgerUpdate.chainValid, false);
assert.equal(tamperedUpdate.ledgerUpdate.changed, false);
assert.equal(tamperedUpdate.audit.promotionReviewReady, false);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "benchmark-prospective-ledger",
  version: first.audit.version,
  auditVersion: first.audit.auditVersion,
  assertions: 70,
  sample: first.audit.prospective.cohort,
  rootHash: first.audit.prospective.rootHash,
  researchRows: first.audit.research.selectedRows,
}, null, 2)}\n`);
