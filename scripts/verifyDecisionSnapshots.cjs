const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {
  DECISION_SNAPSHOT_VERSION,
  LEGACY_DECISION_SNAPSHOT_VERSION,
  buildCandidateDecisionSnapshot,
  isDecisionSnapshotVersion,
  isPromotionDecisionSnapshotVersion,
  replayCandidateEvidence,
  selectLatestEligibleDecisionSnapshot,
  settleDecisionCandidate,
} = require("../src/services/decisionSnapshot.cjs");
const {
  MULTI_FACTOR_POLICY_VERSION,
} = require("../src/services/multiFactorRecommendation.cjs");
const {
  applyPredictionPersistence,
  attachPredictionSnapshotSummary,
  buildArchivedPreMatchPrediction,
  buildPredictionFeatureSnapshot,
  canonicalArchiveParityRecovery,
  dualMarketDecisionBindingFromImmutableRowsOrExisting,
  dualMarketDecisionBindingForMatch,
  dualMarketDecisionBindingForMatchOrExisting,
  predictionSnapshotRow,
  shouldCaptureLockedShadowRevision,
  validArchivedPreMatchPrediction,
} = require("./syncData.cjs");
const {
  boundDecisionOddsForPrediction,
  compactDualMarketDecisionBindingForPublic,
  hashCompactDualMarketDecisionBinding,
  hashDualMarketDecisionBinding,
  verifyCompactDualMarketDecisionBinding,
  verifyDualMarketDecisionBinding,
} = require("../src/services/dualMarketDecisionBinding.cjs");
const {
  createCollectorAttestationTestContext,
} = require("./collectorAttestationTestFixture.cjs");

const collectorCycleId = "sporttery-relay:decision-snapshot-self-test";
const collectorContext = createCollectorAttestationTestContext({ keyId: "decision-snapshot-test-ed25519" });
const marketProvenance = (poolCode, providerObservedAt, receivedAt) => (
  collectorContext.buildSignedMarketProvenance({
    poolCode,
    sourceMatchId: "snapshot_self_test",
    odds: poolCode === "HAD"
      ? { "1": 1.8, X: 3.4, "2": 4.2 }
      : { "1": 2.7, X: 3.25, "2": 2.15 },
    handicapLine: poolCode === "HHAD" ? -1 : 0,
    sourceUrl: "https://webapi.sporttery.cn/gateway/test.qry",
    providerObservedAt,
    sourceTiming: {
      sourceCycleId: collectorCycleId,
      requestedAt: "2026-07-12T09:56:00.000Z",
      receivedAt,
      sourceRequest: { method: "GET", page: 1, role: "decision-snapshot-fixture" },
      httpStatus: 200,
      httpDate: "Sun, 12 Jul 2026 09:58:30 GMT",
      httpEtag: '"decision-snapshot-self-test"',
      contentType: "application/json",
      rawSha256: poolCode === "HAD" ? "d".repeat(64) : "e".repeat(64),
      rawBytes: poolCode === "HAD" ? 2200 : 2400,
    },
  })
);

const rootDir = path.resolve(__dirname, "..");
const readJson = (relativePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
  } catch {
    return fallback;
  }
};

const mockMatch = {
  id: "sporttery_snapshot_self_test",
  sourceMatchId: "snapshot_self_test",
  kickoffTime: "2026-07-12T20:00:00+08:00",
  buyEndTime: "2026-07-12T19:50:00+08:00",
  sourceCycleId: "sporttery-full-sync:2026-07-12T09:55:00.000Z",
  handicapLine: "-1",
  odds: { odds1: 1.8, oddsX: 3.4, odds2: 4.2 },
  oddsObservedAt: "2026-07-12T09:57:00.000Z",
  oddsReceivedAt: "2026-07-12T09:57:30.000Z",
  oddsMarketProvenance: marketProvenance(
    "HAD",
    "2026-07-12T09:57:00.000Z",
    "2026-07-12T09:57:30.000Z",
  ),
  handicapOdds: { odds1: 2.7, oddsX: 3.25, odds2: 2.15 },
  handicapOddsObservedAt: "2026-07-12T09:58:00.000Z",
  handicapOddsReceivedAt: "2026-07-12T09:58:30.000Z",
  handicapOddsMarketProvenance: marketProvenance(
    "HHAD",
    "2026-07-12T09:58:00.000Z",
    "2026-07-12T09:58:30.000Z",
  ),
  predictionMeta: {
    policyVersion: "self-test-policy",
    promptVersion: "self-test-prompt",
    modelVersion: "self-test-model",
    calibrationVersion: "self-test-calibration",
    generatedAt: "2026-07-12T10:00:00.000Z",
    decisionGeneratedAt: "2026-07-12T10:00:00.000Z",
    sourceCycleId: collectorCycleId,
    cutoffTime: "2026-07-12T19:50:00+08:00",
    featureSnapshotHash: "self-test-feature",
  },
  predictions: [{
    marketType: "BEST",
    oddsPoolCode: "HHAD",
    handicapLine: "-1",
    tipCode: "X",
    recommendationAction: "reference",
  }],
  probabilityModel: {
    version: "self-test-model",
    generatedAt: "2026-07-12T09:59:00.000Z",
    oneXTwo: { final: { home: 55, draw: 25, away: 20 } },
    handicap: {
      line: "-1",
      unifiedPosterior: { home: 30, draw: 45, away: 25 },
    },
    goalLines: { over25: 48, under25: 52 },
    bothTeamsToScore: { yes: 47, no: 53 },
    lambdaBlend: {
      independentHomeLambda: 1.7,
      independentAwayLambda: 0.9,
      independentTotalLambda: 2.6,
      marketHomeLambda: 1.65,
      marketAwayLambda: 0.95,
    },
    scoreDistribution: [
      { home: 2, away: 1, label: "2-1", probability: 14 },
      { home: 1, away: 0, label: "1-0", probability: 12 },
    ],
    unifiedPosterior: {
      version: "self-test-unified",
      generatedAt: "2026-07-12T09:59:30.000Z",
      selectedMarket: "HHAD",
      selectedCode: "X",
      selectedHandicapLine: "-1",
      selectionPolicy: "self-test-selection",
      dataQuality: 0.75,
      candidates: [
        { market: "HAD", code: "1", probability: 55, odds: 1.8 },
        { market: "HAD", code: "X", probability: 25, odds: 3.4 },
        { market: "HAD", code: "2", probability: 20, odds: 4.2 },
        {
          market: "HHAD",
          code: "X",
          probability: 45,
          odds: 3.25,
          multiFactorEvidence: {
            version: "self-test-evidence",
            eligible: false,
            grade: "WATCH",
            evidenceScore: 70,
            threshold: 66,
            blockers: ["model-risk-not-promotable"],
            modelGap: 0.2,
            diagnostics: {
              scoreAligned: true,
              crossMarketCompatible: true,
              handicapAligned: true,
              marketLeaderAligned: true,
              trendSupports: true,
              trendContradicts: false,
              externalMarketAligned: true,
              externalMarketContradicted: false,
              externalMarketRisk: "low",
              upstreamRecommended: true,
              upstreamAligned: true,
              globalRiskTier: "watch",
              trustPenalty: 0,
              riskPenalty: 0,
              severeMissingCount: 0,
              riskTagsCount: 0,
            },
          },
        },
        { market: "HHAD", code: "1", probability: 30, odds: 2.7 },
        { market: "HHAD", code: "2", probability: 25, odds: 2.15 },
      ],
    },
  },
};

const selfTestSnapshot = buildCandidateDecisionSnapshot(mockMatch, "2026-07-12T10:00:00.000Z");
const clone = (value) => JSON.parse(JSON.stringify(value));
const LEGACY_MULTI_FACTOR_POLICY_VERSION = "multi-factor-market-evidence-v1";
const PREVIOUS_MULTI_FACTOR_POLICY_VERSION = "multi-factor-market-evidence-v2";
const LEGACY_MULTI_FACTOR_POLICY_VERSIONS = new Set([
  LEGACY_MULTI_FACTOR_POLICY_VERSION,
  PREVIOUS_MULTI_FACTOR_POLICY_VERSION,
]);

const replayExpectationForSnapshot = (snapshot) => {
  if (snapshot?.version !== DECISION_SNAPSHOT_VERSION) return "decision-snapshot-audit-only";
  const policyVersion = snapshot?.evidenceReplayPolicy?.multiFactorPolicyVersion;
  if (policyVersion === MULTI_FACTOR_POLICY_VERSION) return "current-policy-exact";
  if (LEGACY_MULTI_FACTOR_POLICY_VERSIONS.has(policyVersion)) return "legacy-multi-factor-audit-only";
  return "unsupported-multi-factor-policy";
};

assert.equal(selfTestSnapshot.version, DECISION_SNAPSHOT_VERSION);
assert.equal(selfTestSnapshot.candidates.length, 6);
assert.equal(selfTestSnapshot.selectedCandidateKey, "HHAD:X:-1");
assert.equal(selfTestSnapshot.exposure.publicEligible, false);
assert.equal(selfTestSnapshot.exposure.shadowEligible, true);
assert.equal(selfTestSnapshot.clockAudit.eligible, true);
assert.equal(selfTestSnapshot.sourceCycleId, collectorCycleId);
assert.equal(selfTestSnapshot.sourceTimestamps.hadObservedAt, mockMatch.oddsObservedAt);
assert.equal(selfTestSnapshot.sourceTimestamps.hadReceivedAt, mockMatch.oddsReceivedAt);
assert.equal(selfTestSnapshot.sourceTimestamps.hhadObservedAt, mockMatch.handicapOddsObservedAt);
assert.equal(selfTestSnapshot.sourceTimestamps.hhadReceivedAt, mockMatch.handicapOddsReceivedAt);
assert.equal(selfTestSnapshot.exposure.localEvidenceEligible, true);
assert.equal(selfTestSnapshot.lambdas.independentHome, 1.7);
assert.equal(selfTestSnapshot.probabilities.HHAD.line, -1);
assert.ok(selfTestSnapshot.exposure.shadowTracks?.HHAD_COMPANION);
assert.equal(selfTestSnapshot.exposure.shadowTracks.HHAD_COMPANION.publicVisible, false);
assert.ok(["EVALUATE", "SKIP"].includes(selfTestSnapshot.exposure.shadowTracks.HHAD_COMPANION.action));
assert.deepEqual(settleDecisionCandidate({ market: "HAD", code: "1" }, 2, 1), { outcomeCode: "1", won: true });
assert.deepEqual(settleDecisionCandidate({ market: "HHAD", code: "X", handicapLine: -1 }, 2, 1), { outcomeCode: "X", won: true });
assert.deepEqual(settleDecisionCandidate({ market: "HHAD", code: "2", handicapLine: -2 }, 2, 1), { outcomeCode: "2", won: true });
assert.deepEqual(settleDecisionCandidate({ market: "HHAD", code: "X", handicapLine: 1 }, 0, 1), { outcomeCode: "X", won: true });
assert.equal(/scoreHome|scoreAway|resultStatus/.test(JSON.stringify(selfTestSnapshot)), false, "pre-match decision snapshot must not contain results");
assert.equal(DECISION_SNAPSHOT_VERSION, "candidate-decision-snapshot-v2");
assert.match(selfTestSnapshot.policyHash, /^[a-f0-9]{64}$/);
assert.equal(
  selfTestSnapshot.candidates.filter((candidate) => (
    replayCandidateEvidence(selfTestSnapshot, candidate).exact
  )).length,
  selfTestSnapshot.candidates.length,
  "every newly generated v2 candidate must replay exactly",
);
assert.equal(replayExpectationForSnapshot(selfTestSnapshot), "current-policy-exact");
const legacyMultiFactorPolicyFixture = clone(selfTestSnapshot);
legacyMultiFactorPolicyFixture.evidenceReplayPolicy.multiFactorPolicyVersion = LEGACY_MULTI_FACTOR_POLICY_VERSION;
assert.equal(
  replayExpectationForSnapshot(legacyMultiFactorPolicyFixture),
  "legacy-multi-factor-audit-only",
  "a decision-snapshot v2 row produced by the retired multi-factor v1 evaluator remains audit-only",
);
const previousMultiFactorPolicyFixture = clone(selfTestSnapshot);
previousMultiFactorPolicyFixture.evidenceReplayPolicy.multiFactorPolicyVersion = PREVIOUS_MULTI_FACTOR_POLICY_VERSION;
assert.equal(
  replayExpectationForSnapshot(previousMultiFactorPolicyFixture),
  "legacy-multi-factor-audit-only",
  "a decision-snapshot v2 row produced by the retired multi-factor v2 evaluator remains audit-only",
);
const unknownMultiFactorPolicyFixture = clone(selfTestSnapshot);
unknownMultiFactorPolicyFixture.evidenceReplayPolicy.multiFactorPolicyVersion = "multi-factor-market-evidence-unknown";
assert.equal(
  replayExpectationForSnapshot(unknownMultiFactorPolicyFixture),
  "unsupported-multi-factor-policy",
  "an unknown multi-factor evaluator must fail closed instead of bypassing exact replay",
);

const floatingEquivalentMatch = clone(mockMatch);
floatingEquivalentMatch.odds = Object.fromEntries(Object.entries(floatingEquivalentMatch.odds)
  .map(([key, value]) => [key, value + 1e-9]));
floatingEquivalentMatch.handicapOdds = Object.fromEntries(Object.entries(floatingEquivalentMatch.handicapOdds)
  .map(([key, value]) => [key, value - 1e-9]));
floatingEquivalentMatch.probabilityModel.unifiedPosterior.candidates.forEach((candidate, index) => {
  candidate.probability += index % 2 ? 1e-9 : -1e-9;
  candidate.odds += index % 2 ? -1e-9 : 1e-9;
});
const floatingEvidence = floatingEquivalentMatch.probabilityModel.unifiedPosterior.candidates[3]
  .multiFactorEvidence;
floatingEvidence.evidenceScore = 12.3;
floatingEvidence.modelGap += 1e-9;
floatingEvidence.diagnostics.trustPenalty = 1e-9;
floatingEvidence.diagnostics.riskPenalty = 1e-9;
const floatingEquivalentSnapshot = buildCandidateDecisionSnapshot(
  floatingEquivalentMatch,
  "2026-07-12T10:00:00.000Z",
);
assert.deepEqual(
  floatingEquivalentSnapshot.candidates.map((candidate) => candidate.evidenceReplay.canonicalInputs),
  selfTestSnapshot.candidates.map((candidate) => candidate.evidenceReplay.canonicalInputs),
  "sub-fixed-point floating source differences must canonicalize to identical inputs",
);
assert.deepEqual(
  floatingEquivalentSnapshot.candidates.map((candidate) => candidate.evidenceReplay.hash),
  selfTestSnapshot.candidates.map((candidate) => candidate.evidenceReplay.hash),
  "canonical-equivalent inputs must produce identical policy/input/output replay hashes",
);

const tamperedSnapshot = clone(selfTestSnapshot);
tamperedSnapshot.candidates[0].evidenceScore += 0.1;
assert.equal(
  replayCandidateEvidence(tamperedSnapshot, tamperedSnapshot.candidates[0]).exact,
  false,
  "v2 exact replay must reject even a 0.1 evidence-score drift",
);
assert.equal(isDecisionSnapshotVersion(LEGACY_DECISION_SNAPSHOT_VERSION), true);
assert.equal(isPromotionDecisionSnapshotVersion(LEGACY_DECISION_SNAPSHOT_VERSION), false);
assert.equal(isPromotionDecisionSnapshotVersion(DECISION_SNAPSHOT_VERSION), true);
assert.deepEqual(
  [
    { version: LEGACY_DECISION_SNAPSHOT_VERSION },
    { version: DECISION_SNAPSHOT_VERSION },
  ].filter((row) => isPromotionDecisionSnapshotVersion(row.version)),
  [{ version: DECISION_SNAPSHOT_VERSION }],
  "legacy v1 rows remain auditable but must not enter the v2 promotion cohort",
);
assert.equal(
  replayCandidateEvidence(
    { version: LEGACY_DECISION_SNAPSHOT_VERSION },
    selfTestSnapshot.candidates[0],
  ).reason,
  "legacy-v1-audit-only",
);
const olderLegalDecisionRow = {
  sourceMatchId: "snapshot_self_test",
  capturedAt: "2026-07-12T10:00:00.000Z",
  decisionSnapshot: clone(selfTestSnapshot),
};
const newerProbabilityOnlyRow = {
  sourceMatchId: "snapshot_self_test",
  capturedAt: "2026-07-12T10:30:00.000Z",
  probabilityFinal: { home: 0.5, draw: 0.3, away: 0.2 },
};
const illegalPostCutoffDecisionRow = clone(olderLegalDecisionRow);
illegalPostCutoffDecisionRow.capturedAt = "2026-07-12T11:51:00.001Z";
illegalPostCutoffDecisionRow.decisionSnapshot.capturedAt = "2026-07-12T11:51:00.001Z";
assert.equal(
  selectLatestEligibleDecisionSnapshot(
    [olderLegalDecisionRow, newerProbabilityOnlyRow, illegalPostCutoffDecisionRow],
    mockMatch.kickoffTime,
  )?.snapshot,
  olderLegalDecisionRow,
  "a newer probability-only row or post-cutoff decision must not hide the latest legal decision snapshot",
);

const lockedShadowFixture = {
  kickoffTime: "2026-07-12T20:00:00+08:00",
  buyEndTime: "2026-07-12T19:50:00+08:00",
  predictionMeta: {
    lockedAt: "2026-07-12T10:00:00.000Z",
    cutoffTime: "2026-07-12T19:50:00+08:00",
    snapshot: { latestSignature: "locked-public-prediction" },
  },
};
assert.equal(
  shouldCaptureLockedShadowRevision(lockedShadowFixture, "2026-07-12T11:00:00.000Z"),
  true,
  "locked public content may still append a non-public shadow revision before cutoff"
);
assert.equal(
  shouldCaptureLockedShadowRevision(lockedShadowFixture, "2026-07-12T11:51:00.000Z"),
  false,
  "shadow capture must remain closed after cutoff"
);

const companionMatch = clone(mockMatch);
companionMatch.handicapOdds = { odds1: 4.28, oddsX: 3.45, odds2: 1.65 };
companionMatch.handicapOddsUpdatedAt = "2026-07-12T09:58:00.000Z";
companionMatch.probabilityModel.handicap = {
  line: "-1",
  poisson: { home: 90, draw: 5, away: 5 },
  unifiedPosterior: { home: 22, draw: 24.2, away: 53.8 },
};
companionMatch.predictions[0] = {
  marketType: "BEST",
  oddsPoolCode: "HAD",
  tipCode: "1",
  recommendationAction: "reference",
};
companionMatch.predictions.unshift({
  marketType: "1X2",
  oddsPoolCode: "HAD",
  tipCode: "2",
  odds: 4.2,
  recommendationAction: "reference",
});
companionMatch.predictionMeta.featureSnapshot = buildPredictionFeatureSnapshot(
  companionMatch,
  "2026-07-12T10:00:00.000Z",
);
companionMatch.predictionMeta.featureSnapshotHash = companionMatch.predictionMeta.featureSnapshot.hash;
const companionSnapshot = buildCandidateDecisionSnapshot(companionMatch, "2026-07-12T10:00:00.000Z");
const companionTrack = companionSnapshot.exposure.shadowTracks.HHAD_COMPANION;
const selfTestDualMarketBinding = dualMarketDecisionBindingForMatch(
  companionMatch,
  "2026-07-12T10:00:00.000Z",
);
assert.equal(companionTrack.action, "EVALUATE", "qualified HHAD model-top must enter shadow evaluation");
assert.equal(companionTrack.publicVisible, false, "shadow track must never become public output");
assert.deepEqual(companionTrack.market.odds, { "1": 4.28, X: 3.45, "2": 1.65 });
assert.equal(companionTrack.market.officialHandicapLine, -1);
assert.equal(companionTrack.market.modelHandicapLine, -1);
assert.deepEqual(companionTrack.model.probabilities, { "1": 0.22, X: 0.242, "2": 0.538 });
assert.equal(companionTrack.selection.code, "2");
assert.equal(companionTrack.selection.odds, 1.65);
assert.equal(companionTrack.diagnostics.usedMarketFallback, false);
assert.equal(companionTrack.diagnostics.best.poolCode, "HAD");
assert.equal(companionTrack.diagnostics.best.code, "1");
assert.equal(companionTrack.diagnostics.best.conflict, true, "public BEST conflict is diagnostic only");
assert.equal(companionTrack.diagnostics.bestConflictIsBlocker, false);
assert.equal(companionTrack.blockers.length, 0);
assert.equal(selfTestDualMarketBinding?.version, "dual-market-decision-binding-v1");
assert.equal(selfTestDualMarketBinding?.decisionSnapshotVersion, DECISION_SNAPSHOT_VERSION);
assert.equal(selfTestDualMarketBinding?.hhad?.poolCode, "HHAD");
assert.equal(selfTestDualMarketBinding?.hhad?.code, companionTrack.selection.code);
assert.equal(selfTestDualMarketBinding?.hhad?.odds, companionTrack.selection.odds);
assert.equal(selfTestDualMarketBinding?.had?.odds, companionMatch.odds.odds1);
assert.equal(selfTestDualMarketBinding?.hadAnalysis?.code, "2");
assert.equal(selfTestDualMarketBinding?.hadAnalysis?.odds, companionMatch.odds.odds2);
assert.equal(selfTestDualMarketBinding?.featureSnapshot?.hash, companionMatch.predictionMeta.featureSnapshot.hash);
assert.match(selfTestDualMarketBinding?.bindingHash || "", /^[a-f0-9]{64}$/);
assert.match(selfTestDualMarketBinding?.hashes?.strategyHash || "", /^[a-f0-9]{64}$/);
assert.equal(selfTestDualMarketBinding?.integrityVerified, true);
assert.equal(selfTestDualMarketBinding?.integrityVersion, "dual-market-decision-integrity-v1");
const boundCompanionMatch = {
  ...companionMatch,
  predictionMeta: {
    ...companionMatch.predictionMeta,
    dualMarketDecision: selfTestDualMarketBinding,
  },
};
assert.deepEqual(
  verifyDualMarketDecisionBinding(boundCompanionMatch).blockers,
  [],
  "the generated binding must verify against its immutable feature snapshot",
);
assert.equal(verifyDualMarketDecisionBinding(boundCompanionMatch).valid, true);

const archiveParityMatch = {
  ...boundCompanionMatch,
  status: "PENDING_RESULT",
  eventVersion: boundCompanionMatch.kickoffTime,
  predictions: boundCompanionMatch.predictions.map((prediction) => (
    prediction.marketType === "BEST"
      ? {
          ...prediction,
          oddsPoolCode: "HAD",
          tipCode: selfTestDualMarketBinding.had.code,
          odds: selfTestDualMarketBinding.had.odds,
          recommendationAction: "reference",
        }
      : prediction
  )),
};
// A private dual-market candidate is no longer proof of what was public.
// Establish the actual pre-cutoff public reference before testing a correction.
archiveParityMatch.predictionMeta.publicReferenceDecision = require("../src/services/publicReferenceDecision.cjs")
  .bindPublicReferenceDecision({ ...archiveParityMatch, status: "SCHEDULED" }, null,
    "2026-07-12T10:10:00.000Z").predictionMeta.publicReferenceDecision;
assert.ok(archiveParityMatch.predictionMeta.publicReferenceDecision);
const canonicalArchiveSnapshot = {
  sourceMatchId: archiveParityMatch.sourceMatchId,
  kickoffTime: archiveParityMatch.kickoffTime,
  eventVersion: archiveParityMatch.eventVersion,
  homeTeamName: archiveParityMatch.homeTeamName,
  awayTeamName: archiveParityMatch.awayTeamName,
  capturedAt: "2026-07-12T10:00:00.000Z",
  cutoffTime: archiveParityMatch.buyEndTime,
  phase: "baseline",
  signature: `BEST:HAD:${selfTestDualMarketBinding.had.code}:reference`,
  best: {
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: selfTestDualMarketBinding.had.code,
    odds: selfTestDualMarketBinding.had.odds,
    recommendationAction: "reference",
  },
};
const divergentRawSnapshot = {
  ...canonicalArchiveSnapshot,
  capturedAt: "2026-07-12T10:30:00.000Z",
  signature: "BEST:HAD:X:reference",
  best: {
    ...canonicalArchiveSnapshot.best,
    tipCode: "X",
    odds: archiveParityMatch.odds.oddsX,
  },
};
archiveParityMatch.archivedPreMatchPrediction = {
  version: "archived-pre-match-prediction-v1",
  source: "immutable-pre-match-prediction-snapshot",
  sourceMatchId: archiveParityMatch.sourceMatchId,
  matchId: archiveParityMatch.id,
  kickoffTime: archiveParityMatch.kickoffTime,
  eventVersion: archiveParityMatch.eventVersion,
  capturedAt: divergentRawSnapshot.capturedAt,
  cutoffTime: archiveParityMatch.buyEndTime,
  marketEvidenceScope: "result-pool",
  prediction: {
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "X",
    odds: archiveParityMatch.odds.oddsX,
    recommendationAction: "reference",
  },
};
const correctedArchive = buildArchivedPreMatchPrediction(
  archiveParityMatch,
  new Map([[
    archiveParityMatch.sourceMatchId,
    [canonicalArchiveSnapshot, divergentRawSnapshot],
  ]]),
  null,
  "2026-07-12T12:30:00.000Z",
);
assert.equal(
  correctedArchive?.prediction?.tipCode,
  selfTestDualMarketBinding.had.code,
  "archive creation must replay the attested user-visible direction instead of a divergent raw snapshot",
);
assert.equal(
  correctedArchive?.recoveryEvidence?.version,
  "published-direction-archive-parity-v1",
  "a corrected legacy archive must retain explicit parity-repair evidence",
);
const attestedOnlyCorrectedArchive = buildArchivedPreMatchPrediction(
  archiveParityMatch,
  new Map(),
  null,
  "2026-07-12T12:30:00.000Z",
);
assert.equal(
  attestedOnlyCorrectedArchive?.prediction?.tipCode,
  selfTestDualMarketBinding.had.code,
  "a pre-cutoff attested user-visible direction must rebuild the archive when no matching raw snapshot exists",
);
assert.equal(
  attestedOnlyCorrectedArchive?.capturedAt,
  archiveParityMatch.predictionMeta.publicReferenceDecision.recordedAt,
  "attestation-only archive recovery must retain the binding's pre-cutoff decision time",
);
assert.match(
  attestedOnlyCorrectedArchive?.signature || "",
  /^published-direction-attestation-v1:public-reference-decision:/,
  "attestation-only archive recovery must retain an explicit signed-direction evidence marker",
);

const nextResultSyncMatch = clone(archiveParityMatch);
nextResultSyncMatch.archivedPreMatchPrediction = clone(correctedArchive);
nextResultSyncMatch.predictions = [{
  ...divergentRawSnapshot.best,
  marketType: "BEST",
}];
delete nextResultSyncMatch.predictionMeta.dualMarketDecision;
delete nextResultSyncMatch.predictionMeta.immutableAnalysisReferenceDecision;
const nextCycleArchive = buildArchivedPreMatchPrediction(
  nextResultSyncMatch,
  new Map([[nextResultSyncMatch.sourceMatchId, [divergentRawSnapshot]]]),
  null,
  "2026-07-12T13:00:00.000Z",
);
assert.equal(
  nextCycleArchive?.prediction?.tipCode,
  selfTestDualMarketBinding.had.code,
  "a verified parity repair must survive a later result sync that retains only a divergent raw snapshot",
);
assert.deepEqual(
  nextCycleArchive?.recoveryEvidence,
  correctedArchive.recoveryEvidence,
  "a later result sync must preserve the original parity proof instead of manufacturing a new direction",
);

const modelOnlyParityMatch = clone(archiveParityMatch);
delete modelOnlyParityMatch.predictionMeta.publicReferenceDecision;
delete modelOnlyParityMatch.predictionMeta.dualMarketDecision;
delete modelOnlyParityMatch.predictionMeta.immutableAnalysisReferenceDecision;
delete modelOnlyParityMatch.predictionMeta.decisionGeneratedAt;
modelOnlyParityMatch.predictionMeta.generatedAt = "2026-07-12T10:00:00.000Z";
modelOnlyParityMatch.predictionMeta.decisionId = "model-only-parity-decision";
modelOnlyParityMatch.predictionMeta.decisionRevision = 1;
modelOnlyParityMatch.predictions = [{
  marketType: "BEST",
  oddsPoolCode: "HHAD",
  handicapLine: "+3",
  tipCode: "1",
  odds: 0,
  recommendationAction: "reference",
  recommendationTier: "model-only-reference",
  tipLabel: {
    zh: "参考推荐 让胜（数据待补）",
    en: "Reference pick: HHAD home (data pending)",
  },
}];
modelOnlyParityMatch.archivedPreMatchPrediction = {
  ...clone(archiveParityMatch.archivedPreMatchPrediction),
  marketEvidenceScope: "result-pool",
  prediction: {
    marketType: "BEST",
    oddsPoolCode: "HHAD",
    handicapLine: "+3",
    tipCode: "2",
    odds: 1.92,
    recommendationAction: "reference",
  },
};
const modelOnlyParityArchive = buildArchivedPreMatchPrediction(
  modelOnlyParityMatch,
  new Map(),
  null,
  "2026-07-12T12:30:00.000Z",
);
assert.equal(modelOnlyParityArchive?.marketEvidenceScope, "model-only-reference");
assert.equal(modelOnlyParityArchive?.prediction?.oddsPoolCode, "HHAD");
assert.equal(modelOnlyParityArchive?.prediction?.handicapLine, "+3");
assert.equal(modelOnlyParityArchive?.prediction?.tipCode, "1");
assert.equal(modelOnlyParityArchive?.prediction?.tipLabel?.zh, "参考推荐 让胜（数据待补）");
assert.equal(modelOnlyParityArchive?.recoveryEvidence?.canonical?.market, "HHAD");
assert.equal(modelOnlyParityArchive?.recoveryEvidence?.canonical?.directionIdentity, "HHAD:1:3");
assert.equal(
  modelOnlyParityArchive?.recoveryEvidence?.proof?.decisionAt,
  modelOnlyParityMatch.predictionMeta.generatedAt,
  "trusted archive proof must use the same generatedAt fallback accepted by the cutoff gate",
);
assert.ok(
  canonicalArchiveParityRecovery({
    ...modelOnlyParityMatch,
    archivedPreMatchPrediction: modelOnlyParityArchive,
  }),
  "the normalized model-only parity repair must validate on replay",
);
const repeatedModelOnlyParityArchive = buildArchivedPreMatchPrediction(
  {
    ...modelOnlyParityMatch,
    archivedPreMatchPrediction: clone(modelOnlyParityArchive),
  },
  new Map(),
  null,
  "2026-07-12T13:00:00.000Z",
);
assert.deepEqual(
  repeatedModelOnlyParityArchive,
  clone(modelOnlyParityArchive),
  "a model-only HHAD archive must preserve its market and remain byte-stable across migration times",
);
assert.equal(
  JSON.stringify(repeatedModelOnlyParityArchive),
  JSON.stringify(modelOnlyParityArchive),
  "the replayed archive must match the migration wrapper's serialized byte comparison",
);
assert.equal(
  validArchivedPreMatchPrediction(modelOnlyParityMatch, {
    ...clone(modelOnlyParityArchive),
    prediction: {
      ...clone(modelOnlyParityArchive.prediction),
      handicapLine: undefined,
    },
  }),
  null,
  "a model-only HHAD archive without an explicit handicap line must fail closed",
);
const invalidModelOnlyHhadSnapshot = {
  sourceMatchId: modelOnlyParityMatch.sourceMatchId,
  kickoffTime: modelOnlyParityMatch.kickoffTime,
  eventVersion: modelOnlyParityMatch.eventVersion,
  capturedAt: modelOnlyParityMatch.predictionMeta.generatedAt,
  cutoffTime: modelOnlyParityMatch.buyEndTime,
  phase: "locked",
  best: {
    ...modelOnlyParityMatch.predictions[0],
    handicapLine: undefined,
  },
};
assert.equal(
  buildArchivedPreMatchPrediction(
    {
      ...modelOnlyParityMatch,
      predictions: [],
      archivedPreMatchPrediction: undefined,
    },
    new Map([[
      modelOnlyParityMatch.sourceMatchId,
      [invalidModelOnlyHhadSnapshot],
    ]]),
    null,
    "2026-07-12T12:30:00.000Z",
  ),
  null,
  "the archive writer must reject a model-only HHAD source without a handicap line",
);

const pricedHhadParityMatch = clone(modelOnlyParityMatch);
pricedHhadParityMatch.predictions[0].odds = 2.05;
pricedHhadParityMatch.archivedPreMatchPrediction.prediction.tipCode = "X";
const pricedHhadParityArchive = buildArchivedPreMatchPrediction(
  pricedHhadParityMatch,
  new Map(),
  null,
  "2026-07-12T12:30:00.000Z",
);
assert.equal(pricedHhadParityArchive?.marketEvidenceScope, "result-pool");
assert.equal(pricedHhadParityArchive?.prediction?.oddsPoolCode, "HHAD");
assert.equal(pricedHhadParityArchive?.prediction?.handicapLine, "+3");
assert.equal(pricedHhadParityArchive?.recoveryEvidence?.canonical?.directionIdentity, "HHAD:1:3");

const tamperedParityRecoveryMatch = clone(nextResultSyncMatch);
tamperedParityRecoveryMatch.archivedPreMatchPrediction.recoveryEvidence.canonical.direction = "X";
assert.equal(
  canonicalArchiveParityRecovery(tamperedParityRecoveryMatch),
  null,
  "a parity object whose canonical identity no longer matches its archive must fail integrity validation",
);
const tamperedParityArchive = buildArchivedPreMatchPrediction(
  tamperedParityRecoveryMatch,
  new Map([[tamperedParityRecoveryMatch.sourceMatchId, [divergentRawSnapshot]]]),
  null,
  "2026-07-12T13:00:00.000Z",
);
assert.equal(
  tamperedParityArchive?.prediction?.tipCode,
  selfTestDualMarketBinding.had.code,
  "an invalid parity proof must not by itself authorize rewriting the first structurally valid archive",
);

const referenceOnlyCompanionMatch = clone(companionMatch);
referenceOnlyCompanionMatch.probabilityModel.handicap.unifiedPosterior = {
  home: 31,
  draw: 32,
  away: 37,
};
referenceOnlyCompanionMatch.predictionMeta.featureSnapshot = buildPredictionFeatureSnapshot(
  referenceOnlyCompanionMatch,
  "2026-07-12T10:00:00.000Z",
);
referenceOnlyCompanionMatch.predictionMeta.featureSnapshotHash =
  referenceOnlyCompanionMatch.predictionMeta.featureSnapshot.hash;
const referenceOnlySnapshot = buildCandidateDecisionSnapshot(
  referenceOnlyCompanionMatch,
  "2026-07-12T10:00:00.000Z",
);
const referenceOnlyTrack = referenceOnlySnapshot.exposure.shadowTracks.HHAD_COMPANION;
const referenceOnlyBinding = dualMarketDecisionBindingForMatch(
  referenceOnlyCompanionMatch,
  "2026-07-12T10:00:00.000Z",
);
assert.equal(referenceOnlyTrack.action, "SKIP", "weak HHAD evidence must remain outside shadow evaluation");
assert.ok(
  referenceOnlyTrack.blockers.includes("model-probability-below-threshold")
    || referenceOnlyTrack.blockers.includes("model-gap-below-threshold"),
);
assert.equal(
  referenceOnlyBinding?.hhad?.shadowAction,
  "SKIP",
  "a complete official HHAD market still receives an explicit reference-only companion",
);
assert.equal(referenceOnlyBinding?.hhad?.promotionEligible, false);
assert.deepEqual(referenceOnlyBinding?.hhad?.shadowBlockers, [...referenceOnlyTrack.blockers].sort());
assert.equal(referenceOnlyBinding?.integrityVerified, true);
assert.equal(
  verifyDualMarketDecisionBinding({
    ...referenceOnlyCompanionMatch,
    predictionMeta: {
      ...referenceOnlyCompanionMatch.predictionMeta,
      dualMarketDecision: referenceOnlyBinding,
    },
  }).valid,
  true,
  "reference-only HHAD direction must remain atomically bound to official odds and model probabilities",
);

const compactCompanionBinding = compactDualMarketDecisionBindingForPublic(
  selfTestDualMarketBinding,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(compactCompanionBinding, "featureSnapshot"),
  false,
  "the list projection must not duplicate the internal feature snapshot",
);
assert.match(compactCompanionBinding?.publicBindingHash || "", /^[a-f0-9]{64}$/);
assert.equal(
  compactCompanionBinding.publicBindingHash,
  hashCompactDualMarketDecisionBinding(compactCompanionBinding),
);
assert.deepEqual(
  verifyCompactDualMarketDecisionBinding(compactCompanionBinding).blockers,
  [],
  "the redacted list binding must remain independently hash-verifiable",
);
assert.equal(verifyCompactDualMarketDecisionBinding(compactCompanionBinding).valid, true);

const tamperedCompactBinding = clone(compactCompanionBinding);
tamperedCompactBinding.hhad.code = "1";
assert.equal(
  verifyCompactDualMarketDecisionBinding(tamperedCompactBinding).valid,
  false,
  "changing a visible HHAD direction must invalidate the public binding hash",
);
assert.ok(
  verifyCompactDualMarketDecisionBinding(tamperedCompactBinding).blockers
    .includes("public-binding-hash-mismatch"),
);

const tamperedHhadBindingMatch = clone(boundCompanionMatch);
tamperedHhadBindingMatch.predictionMeta.dualMarketDecision.hhad.code = "1";
assert.equal(
  verifyDualMarketDecisionBinding(tamperedHhadBindingMatch).valid,
  false,
  "changing the HHAD direction without rebuilding the binding must fail closed",
);
assert.ok(
  verifyDualMarketDecisionBinding(tamperedHhadBindingMatch).blockers.includes("binding-hash-mismatch"),
);

const rehashedTamperedOddsMatch = clone(boundCompanionMatch);
rehashedTamperedOddsMatch.predictionMeta.dualMarketDecision.had.odds += 0.01;
rehashedTamperedOddsMatch.predictionMeta.dualMarketDecision.bindingHash = hashDualMarketDecisionBinding(
  rehashedTamperedOddsMatch.predictionMeta.dualMarketDecision,
);
assert.equal(
  verifyDualMarketDecisionBinding(rehashedTamperedOddsMatch).valid,
  false,
  "a self-consistent binding hash cannot detach selected HAD odds from the frozen feature snapshot",
);
assert.ok(
  verifyDualMarketDecisionBinding(rehashedTamperedOddsMatch).blockers
    .includes("binding-feature-had-odds-mismatch"),
);

const missingHadBindingMatch = clone(boundCompanionMatch);
missingHadBindingMatch.predictionMeta.dualMarketDecision.had = null;
missingHadBindingMatch.predictionMeta.dualMarketDecision.bindingHash = hashDualMarketDecisionBinding(
  missingHadBindingMatch.predictionMeta.dualMarketDecision,
);
assert.equal(
  verifyDualMarketDecisionBinding(missingHadBindingMatch).valid,
  false,
  "HHAD-only records are not dual-market atomic decisions",
);
assert.ok(
  verifyDualMarketDecisionBinding(missingHadBindingMatch).blockers
    .includes("had-binding-missing-or-invalid"),
);

const tamperedFeatureMatch = clone(boundCompanionMatch);
tamperedFeatureMatch.predictionMeta.dualMarketDecision.featureSnapshot.modelOutputs.hhad.unifiedPosterior.away = 12;
assert.equal(
  verifyDualMarketDecisionBinding(tamperedFeatureMatch).valid,
  false,
  "changing model features after the decision must invalidate the embedded feature hash",
);
assert.ok(
  verifyDualMarketDecisionBinding(tamperedFeatureMatch).blockers
    .includes("embedded-feature-snapshot-hash-mismatch"),
);

const laterMarketObservationMatch = clone(boundCompanionMatch);
laterMarketObservationMatch.odds = { odds1: 1.74, oddsX: 3.55, odds2: 4.35 };
laterMarketObservationMatch.handicapOdds = { odds1: 4.5, oddsX: 3.5, odds2: 1.61 };
laterMarketObservationMatch.predictionMeta.featureSnapshot = buildPredictionFeatureSnapshot(
  laterMarketObservationMatch,
  "2026-07-12T10:05:00.000Z",
);
laterMarketObservationMatch.predictionMeta.featureSnapshotHash =
  laterMarketObservationMatch.predictionMeta.featureSnapshot.hash;
assert.equal(
  verifyDualMarketDecisionBinding(laterMarketObservationMatch).valid,
  true,
  "a later mutable market snapshot must not invalidate the self-contained published decision",
);
assert.equal(
  dualMarketDecisionBindingForMatchOrExisting(
    laterMarketObservationMatch,
    "2026-07-12T10:05:00.000Z",
  )?.bindingHash,
  selfTestDualMarketBinding.bindingHash,
  "later syncs must preserve the first verified dual-market binding hash",
);
const immutableDualMarketRow = predictionSnapshotRow(
  companionMatch,
  "2026-07-12T10:00:00.000Z",
);
const lockedMissingBindingMatch = clone(companionMatch);
lockedMissingBindingMatch.odds = { odds1: 1.74, oddsX: 3.55, odds2: 4.35 };
lockedMissingBindingMatch.handicapOdds = { odds1: 4.5, oddsX: 3.5, odds2: 1.61 };
lockedMissingBindingMatch.predictionMeta.lockedAt = "2026-07-12T11:50:00.000Z";
lockedMissingBindingMatch.predictionMeta.lockedReason = "sporttery-cutoff";
lockedMissingBindingMatch.predictionMeta.snapshot = {
  phase: "final",
  latestSignature: "immutable-pre-cutoff-signature",
};
delete lockedMissingBindingMatch.predictionMeta.dualMarketDecision;
const restoredFromImmutableRows = dualMarketDecisionBindingFromImmutableRowsOrExisting(
  lockedMissingBindingMatch,
  [immutableDualMarketRow],
);
assert.equal(
  restoredFromImmutableRows?.bindingHash,
  selfTestDualMarketBinding.bindingHash,
  "a locked match may recover only the exact binding encoded by its immutable pre-cutoff row",
);
const [lockedWithRestoredBinding] = attachPredictionSnapshotSummary(
  [lockedMissingBindingMatch],
  { rows: [immutableDualMarketRow] },
  "2026-07-12T11:51:00.000Z",
);
assert.equal(
  lockedWithRestoredBinding.predictionMeta?.dualMarketDecision?.bindingHash,
  selfTestDualMarketBinding.bindingHash,
  "locked snapshot attachment must restore a missing HAD/HHAD binding without recalculating the pick",
);
assert.equal(
  lockedWithRestoredBinding.predictionMeta?.dualMarketDecision?.had?.odds,
  companionMatch.odds.odds1,
  "restoration must use the decision-time HAD SP instead of the mutable post-cutoff SP",
);
assert.equal(
  lockedWithRestoredBinding.predictionMeta?.dualMarketDecision?.hhad?.odds,
  companionMatch.handicapOdds.odds2,
  "restoration must use the decision-time HHAD SP instead of the mutable post-cutoff SP",
);
assert.equal(
  verifyDualMarketDecisionBinding(lockedWithRestoredBinding).valid,
  true,
  "the restored locked binding must pass the complete integrity and temporal verifier",
);
const lockedWithoutSnapshotMetadata = clone(lockedMissingBindingMatch);
delete lockedWithoutSnapshotMetadata.predictionMeta.snapshot;
const [lockedWithoutSnapshotRestored] = attachPredictionSnapshotSummary(
  [lockedWithoutSnapshotMetadata],
  { rows: [immutableDualMarketRow] },
  "2026-07-12T11:51:00.000Z",
);
assert.equal(
  lockedWithoutSnapshotRestored.predictionMeta?.dualMarketDecision?.bindingHash,
  selfTestDualMarketBinding.bindingHash,
  "result reconstruction must restore the immutable binding even when snapshot summary metadata was dropped",
);
const postCutoffOnlyRow = predictionSnapshotRow(
  companionMatch,
  "2026-07-12T11:51:00.000Z",
);
assert.equal(
  dualMarketDecisionBindingFromImmutableRowsOrExisting(
    lockedMissingBindingMatch,
    [postCutoffOnlyRow],
  ),
  null,
  "a post-cutoff row must never be used to backfill a missing dual-market binding",
);
assert.equal(
  boundDecisionOddsForPrediction(
    laterMarketObservationMatch,
    laterMarketObservationMatch.predictions.find((row) => row.marketType === "BEST"),
  ),
  selfTestDualMarketBinding.had.odds,
  "a frozen HAD prediction must validate against its bound decision-time SP instead of a later mutable SP",
);
assert.equal(
  boundDecisionOddsForPrediction(
    laterMarketObservationMatch,
    laterMarketObservationMatch.predictions.find((row) => row.marketType === "1X2"),
  ),
  selfTestDualMarketBinding.hadAnalysis.odds,
  "a frozen 1X2 analysis row must retain its own decision-time SP when BEST points elsewhere",
);
const legacyAnalysisBindingMatch = clone(laterMarketObservationMatch);
delete legacyAnalysisBindingMatch.predictionMeta.dualMarketDecision.hadAnalysis;
legacyAnalysisBindingMatch.predictionMeta.dualMarketDecision.bindingHash = hashDualMarketDecisionBinding(
  legacyAnalysisBindingMatch.predictionMeta.dualMarketDecision,
);
assert.equal(
  boundDecisionOddsForPrediction(
    legacyAnalysisBindingMatch,
    legacyAnalysisBindingMatch.predictions.find((row) => row.marketType === "1X2"),
  ),
  selfTestDualMarketBinding.hadAnalysis.odds,
  "legacy bindings must recover the frozen 1X2 SP from the immutable feature selection",
);
const incompatibleBoundPrediction = {
  ...laterMarketObservationMatch.predictions.find((row) => row.marketType === "BEST"),
  tipCode: "2",
};
assert.equal(
  boundDecisionOddsForPrediction(laterMarketObservationMatch, incompatibleBoundPrediction),
  null,
  "a different direction cannot borrow the frozen SP from the bound HAD decision",
);
laterMarketObservationMatch.predictions[0].tipCode = "2";
const persistedAtomicDecision = applyPredictionPersistence(
  laterMarketObservationMatch,
  boundCompanionMatch,
  "2026-07-12T10:05:00.000Z",
  { finalizedAt: "2026-07-12T10:05:30.000Z" },
);
assert.equal(
  persistedAtomicDecision.predictions.find((row) => row.marketType === "BEST")?.tipCode,
  "1",
  "later model refreshes cannot rewrite the published HAD direction",
);
assert.equal(
  persistedAtomicDecision.predictionMeta?.dualMarketDecision?.bindingHash,
  selfTestDualMarketBinding.bindingHash,
  "prediction persistence must retain the exact HAD/HHAD binding hash",
);

const policyUpgradeExisting = clone(boundCompanionMatch);
policyUpgradeExisting.predictionMeta.policyVersion = "sporttery-day-formula-trace-v67-evidence-led-poisson";
const policyUpgradeCandidate = clone(laterMarketObservationMatch);
delete policyUpgradeCandidate.predictionMeta.dualMarketDecision;
policyUpgradeCandidate.predictions = policyUpgradeCandidate.predictions.map((prediction) => (
  prediction.marketType === "BEST" ? { ...prediction, tipCode: "2" } : prediction
));
const refreshedForPolicyUpgrade = applyPredictionPersistence(
  policyUpgradeCandidate,
  policyUpgradeExisting,
  "2026-07-12T10:06:00.000Z",
  { finalizedAt: "2026-07-12T10:06:30.000Z" },
);
assert.equal(
  refreshedForPolicyUpgrade.predictions.find((row) => row.marketType === "BEST")?.tipCode,
  "2",
  "an explicit model policy upgrade may issue a new reference revision before cutoff",
);
assert.equal(refreshedForPolicyUpgrade.predictionMeta?.modelUpgradeRefresh?.applied, true);
assert.equal(
  refreshedForPolicyUpgrade.predictionMeta?.modelUpgradeRefresh?.previousPolicyVersion,
  "sporttery-day-formula-trace-v67-evidence-led-poisson",
);
assert.equal(
  refreshedForPolicyUpgrade.predictionMeta?.dualMarketDecision,
  undefined,
  "a pre-cutoff policy revision must discard the prior binding before a new binding is attached",
);

const formallyPublishedPolicyExisting = clone(policyUpgradeExisting);
formallyPublishedPolicyExisting.predictions = formallyPublishedPolicyExisting.predictions.map((prediction) => (
  prediction.marketType === "BEST"
    ? { ...prediction, publicationId: "publication_policy_self_test", publicationEvidence: { valid: true } }
    : prediction
));
const preservedFormalPolicyPublication = applyPredictionPersistence(
  policyUpgradeCandidate,
  formallyPublishedPolicyExisting,
  "2026-07-12T10:06:00.000Z",
  { finalizedAt: "2026-07-12T10:06:30.000Z" },
);
assert.equal(
  preservedFormalPolicyPublication.predictions.find((row) => row.marketType === "BEST")?.tipCode,
  selfTestDualMarketBinding.had.code,
  "a formal recommendation cannot be revised by a model policy upgrade",
);
assert.equal(preservedFormalPolicyPublication.predictionMeta?.modelUpgradeRefresh, undefined);

const preservedPolicyAfterCutoff = applyPredictionPersistence(
  policyUpgradeCandidate,
  policyUpgradeExisting,
  "2026-07-12T11:51:00.000Z",
  { finalizedAt: "2026-07-12T11:51:30.000Z" },
);
assert.equal(
  preservedPolicyAfterCutoff.predictions.find((row) => row.marketType === "BEST")?.tipCode,
  selfTestDualMarketBinding.had.code,
  "a model policy upgrade cannot rewrite an existing decision after cutoff",
);
assert.equal(preservedPolicyAfterCutoff.predictionMeta?.modelUpgradeRefresh, undefined);

const signedTrainingUpgradeCandidate = clone(laterMarketObservationMatch);
delete signedTrainingUpgradeCandidate.predictionMeta.dualMarketDecision;
signedTrainingUpgradeCandidate.predictions = signedTrainingUpgradeCandidate.predictions.map((prediction) => (
  prediction.marketType === "BEST" ? { ...prediction, tipCode: "2" } : prediction
));
const signedHistoricalSource = {
  version: "historical-training-v1",
  source: "signed-training-self-test",
  rows: 300000,
  signature: "historical-training-v1|signed-training-self-test|300000|2026-07-11",
  releaseArtifact: {
    entry: ".release-model-assets/historical-training-index.json",
    sourceKind: "signed-release-asset",
    validationOk: true,
    sha256: "f".repeat(64),
    teams: 1600,
    finiteEloTeams: 1400,
  },
};
signedTrainingUpgradeCandidate.probabilityModel.elo = {
  homeRating: 1540,
  awayRating: 1490,
  homeMatches: 25,
  awayMatches: 23,
  historicalSource: clone(signedHistoricalSource),
};
signedTrainingUpgradeCandidate.probabilityModel.form = {
  home: { sampleSize: 12 },
  away: { sampleSize: 12 },
  historicalSource: clone(signedHistoricalSource),
};
const refreshedForSignedTrainingUpgrade = applyPredictionPersistence(
  signedTrainingUpgradeCandidate,
  boundCompanionMatch,
  "2026-07-12T10:06:00.000Z",
  { finalizedAt: "2026-07-12T10:06:30.000Z" },
);
assert.equal(
  refreshedForSignedTrainingUpgrade.predictions.find((row) => row.marketType === "BEST")?.tipCode,
  "2",
  "a complete stronger signed training asset may refresh an unpublished same-event decision before cutoff",
);
assert.equal(refreshedForSignedTrainingUpgrade.predictionMeta?.trainingUpgradeRefresh?.applied, true);
assert.equal(
  refreshedForSignedTrainingUpgrade.predictionMeta?.trainingUpgradeRefresh?.candidateSha256,
  "f".repeat(64),
);
assert.equal(refreshedForSignedTrainingUpgrade.predictionMeta?.dualMarketDecision, undefined,
  "the prior atomic binding must be removed so the refreshed candidate receives a new binding");

const formallyPublishedExisting = clone(boundCompanionMatch);
formallyPublishedExisting.predictions = formallyPublishedExisting.predictions.map((prediction) => (
  prediction.marketType === "BEST"
    ? { ...prediction, publicationId: "publication_self_test", publicationEvidence: { valid: true } }
    : prediction
));
const preservedFormalPublication = applyPredictionPersistence(
  signedTrainingUpgradeCandidate,
  formallyPublishedExisting,
  "2026-07-12T10:06:00.000Z",
  { finalizedAt: "2026-07-12T10:06:30.000Z" },
);
assert.equal(
  preservedFormalPublication.predictions.find((row) => row.marketType === "BEST")?.tipCode,
  selfTestDualMarketBinding.had.code,
  "a formally published recommendation remains immutable even before cutoff",
);
assert.equal(preservedFormalPublication.predictionMeta?.trainingUpgradeRefresh, undefined);

const preservedAfterCutoff = applyPredictionPersistence(
  signedTrainingUpgradeCandidate,
  boundCompanionMatch,
  "2026-07-12T11:51:00.000Z",
  { finalizedAt: "2026-07-12T11:51:30.000Z" },
);
assert.equal(
  preservedAfterCutoff.predictions.find((row) => row.marketType === "BEST")?.tipCode,
  selfTestDualMarketBinding.had.code,
  "a signed asset upgrade cannot rewrite an existing decision after cutoff",
);
assert.equal(preservedAfterCutoff.predictionMeta?.trainingUpgradeRefresh, undefined);
assert.equal(companionTrack.timestamps.officialHhadObservedAt, "2026-07-12T09:58:00.000Z");
assert.equal(companionTrack.timestamps.decisionAt, mockMatch.predictionMeta.generatedAt);
assert.equal(companionTrack.timestamps.modelGeneratedAt, mockMatch.probabilityModel.generatedAt);
assert.equal(companionTrack.timestamps.unifiedPosteriorGeneratedAt, mockMatch.probabilityModel.unifiedPosterior.generatedAt);
assert.equal(companionTrack.provenance.policyVersion, mockMatch.predictionMeta.policyVersion);
assert.equal(companionTrack.provenance.modelVersion, mockMatch.predictionMeta.modelVersion);
assert.equal(companionTrack.provenance.unifiedPosteriorVersion, "self-test-unified");
assert.deepEqual(
  buildCandidateDecisionSnapshot(companionMatch, "2026-07-12T10:00:00.000Z").exposure.shadowTracks.HHAD_COMPANION.hashes,
  companionTrack.hashes,
  "identical pre-cutoff inputs must produce deterministic shadow hashes",
);

const noUnifiedPosteriorMatch = clone(companionMatch);
delete noUnifiedPosteriorMatch.probabilityModel.handicap.unifiedPosterior;
noUnifiedPosteriorMatch.probabilityModel.handicap.poisson = { home: 1, draw: 1, away: 98 };
const noFallbackTrack = buildCandidateDecisionSnapshot(
  noUnifiedPosteriorMatch,
  "2026-07-12T10:00:00.000Z",
).exposure.shadowTracks.HHAD_COMPANION;
assert.equal(noFallbackTrack.action, "SKIP", "missing unified posterior must fail closed");
assert.ok(noFallbackTrack.blockers.includes("incomplete-or-invalid-model-probabilities"));
assert.equal(noFallbackTrack.model.probabilities, null, "Poisson must not become a shadow model fallback");
assert.equal(noFallbackTrack.selection, null);
assert.equal(noFallbackTrack.diagnostics.usedMarketFallback, false);

const postCutoffModelMatch = clone(companionMatch);
postCutoffModelMatch.probabilityModel.generatedAt = "2026-07-12T11:50:00.001Z";
const postCutoffModelTrack = buildCandidateDecisionSnapshot(
  postCutoffModelMatch,
  "2026-07-12T10:00:00.000Z",
).exposure.shadowTracks.HHAD_COMPANION;
assert.equal(postCutoffModelTrack.action, "SKIP", "post-cutoff model generation must fail closed");
assert.ok(postCutoffModelTrack.blockers.includes("model-generated-after-cutoff"));
assert.ok(!postCutoffModelTrack.blockers.includes("unified-posterior-generated-after-cutoff"));
assert.ok(
  buildCandidateDecisionSnapshot(postCutoffModelMatch, "2026-07-12T10:00:00.000Z")
    .clockAudit.blockers.includes("base-model-generated-after-decision"),
);

const invalidModelTimeMatch = clone(companionMatch);
invalidModelTimeMatch.probabilityModel.generatedAt = "not-a-time";
const invalidModelTimeTrack = buildCandidateDecisionSnapshot(
  invalidModelTimeMatch,
  "2026-07-12T10:00:00.000Z",
).exposure.shadowTracks.HHAD_COMPANION;
assert.equal(invalidModelTimeTrack.action, "SKIP", "invalid explicit model time must fail closed");
assert.ok(invalidModelTimeTrack.blockers.includes("invalid-model-generated-at"));
assert.ok(!invalidModelTimeTrack.blockers.includes("invalid-unified-posterior-generated-at"));

const postCutoffTrack = buildCandidateDecisionSnapshot(
  companionMatch,
  "2026-07-12T11:50:00.001Z",
).exposure.shadowTracks.HHAD_COMPANION;
assert.equal(postCutoffTrack.action, "SKIP", "post-cutoff capture must fail closed");
assert.ok(postCutoffTrack.blockers.includes("captured-after-cutoff"));
assert.equal(postCutoffTrack.publicVisible, false);
assert.equal(/scoreHome|scoreAway|resultStatus/.test(JSON.stringify(companionTrack)), false);

const selfTestOnly = process.argv.includes("--self-test");
const current = selfTestOnly ? [] : readJson("public/data/matches-current.json", []);
const snapshotPayload = selfTestOnly ? { rows: [] } : readJson("public/data/prediction-snapshots.json", { rows: [] });
const rows = Array.isArray(snapshotPayload?.rows) ? snapshotPayload.rows : [];
let hhadCompanionTracks = 0;
let currentLegacyMultiFactorAuditOnlyRows = 0;
let currentLegacyMultiFactorAuditOnlyCandidates = 0;
let currentMultiFactorExactCandidates = 0;
const eligibleCurrent = current.filter((match) => (
  match?.status === "SCHEDULED"
  && Array.isArray(match?.probabilityModel?.unifiedPosterior?.candidates)
  && match.probabilityModel.unifiedPosterior.candidates.length > 0
));

if (eligibleCurrent.length) {
  const currentIds = new Set(eligibleCurrent.map((match) => String(match.sourceMatchId || "")));
  const currentDecisionRows = rows.filter((row) => (
    currentIds.has(String(row?.sourceMatchId || ""))
    && isDecisionSnapshotVersion(row?.decisionSnapshot?.version)
  ));
  assert.ok(currentDecisionRows.length > 0, "scheduled model rows must emit immutable candidate-level decision snapshots");
  for (const row of currentDecisionRows) {
    const snapshot = row.decisionSnapshot;
    const replayExpectation = replayExpectationForSnapshot(snapshot);
    if (snapshot.version === DECISION_SNAPSHOT_VERSION) {
      assert.notEqual(
        replayExpectation,
        "unsupported-multi-factor-policy",
        `unsupported multi-factor policy in decision snapshot: ${snapshot?.evidenceReplayPolicy?.multiFactorPolicyVersion || "missing"}`,
      );
      if (replayExpectation === "legacy-multi-factor-audit-only") {
        currentLegacyMultiFactorAuditOnlyRows += 1;
      }
    }
    assert.match(String(snapshot.policyHash || ""), /^[a-f0-9]{64}$/);
    const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
    const action = String(snapshot.exposure?.shadowAction || "skip").toUpperCase();
    const explicitBlockers = [
      ...(snapshot.exposure?.modelBlockers || []),
      ...(snapshot.exposure?.governanceBlockers || []),
      ...(snapshot.exposure?.shadowTracks?.HHAD_COMPANION?.blockers || []),
    ].filter(Boolean);
    assert.ok(["EVALUATE", "SKIP"].includes(action));
    if (action === "EVALUATE") {
      assert.ok(candidates.length >= 3, "EVALUATE snapshots require a complete candidate set");
      assert.ok(snapshot.selectedCandidateKey);
    } else {
      assert.ok(
        snapshot.version === LEGACY_DECISION_SNAPSHOT_VERSION || explicitBlockers.length > 0,
        "new SKIP snapshots may have zero candidates but require an explicit blocker",
      );
    }
    assert.ok(snapshot.exposure && typeof snapshot.exposure.shadowEligible === "boolean");
    const hhadCompanionTrack = snapshot.exposure?.shadowTracks?.HHAD_COMPANION || null;
    if (hhadCompanionTrack) {
      hhadCompanionTracks += 1;
      assert.ok(["EVALUATE", "SKIP"].includes(hhadCompanionTrack.action));
      assert.equal(hhadCompanionTrack.publicVisible, false);
      assert.equal(hhadCompanionTrack.strategy, "HHAD_COMPANION_SHADOW");
      assert.equal(hhadCompanionTrack.diagnostics?.usedMarketFallback, false);
      assert.equal(/scoreHome|scoreAway|resultStatus/.test(JSON.stringify(hhadCompanionTrack)), false);
    }
    assert.equal(/scoreHome|scoreAway|resultStatus/.test(JSON.stringify(snapshot)), false);
    const capturedMs = Date.parse(snapshot.capturedAt || "");
    const cutoffMs = Date.parse(snapshot.cutoffTime || snapshot.kickoffTime || "");
    assert.ok(Number.isFinite(capturedMs) && Number.isFinite(cutoffMs) && capturedMs <= cutoffMs, "decision snapshot must be captured before cutoff");
    for (const candidate of candidates) {
      assert.ok(["HAD", "HHAD"].includes(candidate.market));
      assert.ok(["1", "X", "2"].includes(candidate.code));
      assert.ok(Number.isFinite(Number(candidate.modelProbability)));
      assert.ok(Number.isFinite(Number(candidate.odds)) && Number(candidate.odds) > 1);
      if (candidate.market === "HHAD") assert.ok(Number.isFinite(Number(candidate.handicapLine)));
      if (snapshot.version === DECISION_SNAPSHOT_VERSION) {
        const replay = replayCandidateEvidence(snapshot, candidate);
        if (replayExpectation === "current-policy-exact") {
          currentMultiFactorExactCandidates += 1;
          assert.equal(
            replay.exact,
            true,
            "every current multi-factor candidate must replay exactly",
          );
        } else {
          currentLegacyMultiFactorAuditOnlyCandidates += 1;
          const legacyPolicyVersion = snapshot.evidenceReplayPolicy.multiFactorPolicyVersion;
          assert.ok(LEGACY_MULTI_FACTOR_POLICY_VERSIONS.has(legacyPolicyVersion));
          assert.equal(candidate.evidenceVersion, legacyPolicyVersion);
          assert.equal(candidate.evidenceReplay?.canonicalOutput?.version, legacyPolicyVersion);
          assert.equal(replay.checks?.canonicalInputsExact, true, "legacy audit-only inputs must remain canonical");
          assert.equal(replay.checks?.policyHashExact, true, "legacy audit-only policy hash must remain immutable");
          assert.equal(replay.checks?.replayHashExact, true, "legacy audit-only replay hash must remain immutable");
        }
      }
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  version: DECISION_SNAPSHOT_VERSION,
  selfTestCandidates: selfTestSnapshot.candidates.length,
  selfTestDualMarketBinding: selfTestDualMarketBinding?.bindingHash || null,
  selfTestHhadCompanionAction: companionTrack.action,
  legacyCompatibleMissingTracks: rows.filter((row) => (
    isDecisionSnapshotVersion(row?.decisionSnapshot?.version)
    && !row?.decisionSnapshot?.exposure?.shadowTracks?.HHAD_COMPANION
  )).length,
  hhadCompanionTracks,
  scheduledModelMatches: eligibleCurrent.length,
  scheduledDecisionRows: rows.filter((row) => isDecisionSnapshotVersion(row?.decisionSnapshot?.version)).length,
  v1AuditOnlyRows: rows.filter((row) => (
    row?.decisionSnapshot?.version === LEGACY_DECISION_SNAPSHOT_VERSION
  )).length,
  v2PromotionCohortRows: rows.filter((row) => (
    row?.decisionSnapshot?.version === DECISION_SNAPSHOT_VERSION
  )).length,
  currentLegacyMultiFactorAuditOnlyRows,
  currentLegacyMultiFactorAuditOnlyCandidates,
  currentMultiFactorExactCandidates,
  legacyV1SkipRowsWithoutExplicitBlocker: rows.filter((row) => {
    const snapshot = row?.decisionSnapshot;
    if (snapshot?.version !== LEGACY_DECISION_SNAPSHOT_VERSION) return false;
    if (String(snapshot.exposure?.shadowAction || "skip").toUpperCase() !== "SKIP") return false;
    return [
      ...(snapshot.exposure?.modelBlockers || []),
      ...(snapshot.exposure?.governanceBlockers || []),
      ...(snapshot.exposure?.shadowTracks?.HHAD_COMPANION?.blockers || []),
    ].filter(Boolean).length === 0;
  }).length,
}, null, 2));
