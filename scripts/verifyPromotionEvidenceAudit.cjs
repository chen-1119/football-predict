const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  HASH_PATTERN,
  validatePromotionEvidenceManifest,
  validatePromotionEvidenceRecord,
} = require("../src/services/promotionEvidenceManifest.cjs");
const {
  DECISION_SNAPSHOT_VERSION,
  PROMOTION_EVIDENCE_AUDIT_VERSION,
  buildPromotionEvidenceAudit,
} = require("./promotionEvidenceAudit.cjs");
const {
  createCollectorAttestationTestContext,
} = require("./collectorAttestationTestFixture.cjs");

let assertions = 0;
const check = (value, message) => {
  assert.ok(value, message);
  assertions += 1;
};
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  assertions += 1;
};
const deepEqual = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
};
const clone = (value) => JSON.parse(JSON.stringify(value));

const generatedAt = "2026-07-01T15:00:00.000Z";
const decisionCycleId = "prediction-cycle-2040999-1";
const collectorContext = createCollectorAttestationTestContext({ keyId: "promotion-audit-test-ed25519" });
const marketProvenance = (poolCode, providerObservedAt, receivedAt) => (
  collectorContext.buildSignedMarketProvenance({
    poolCode,
    sourceMatchId: "2040999",
    odds: poolCode === "HAD"
      ? { "1": 2.1, X: 3.2, "2": 3.4 }
      : { "1": 3.8, X: 3.7, "2": 1.68 },
    handicapLine: poolCode === "HHAD" ? -1 : 0,
    sourceUrl: "https://webapi.sporttery.cn/gateway/promotion-audit-fixture.qry",
    providerObservedAt,
    sourceTiming: {
      sourceCycleId: decisionCycleId,
      requestedAt: "2026-07-01T10:32:00.000Z",
      receivedAt,
      sourceRequest: { method: "GET", page: 1, role: "promotion-audit-fixture" },
      httpStatus: 200,
      rawSha256: poolCode === "HAD" ? "6".repeat(64) : "7".repeat(64),
      rawBytes: poolCode === "HAD" ? 1600 : 1800,
    },
  })
);

const matchFixture = () => ({
  id: "sporttery_2040999",
  sourceMatchId: "2040999",
  status: "FINISHED",
  kickoffTime: "2026-07-01T20:00:00+08:00",
  scoreHome: 2,
  scoreAway: 1,
  resultProvenance: {
    official: true,
    trusted: true,
    provider: "sporttery",
    source: "sporttery",
    scoreHome: 2,
    scoreAway: 1,
    eventVersion: "2026-07-01T20:00:00+08:00",
    observedAt: "2026-07-01T14:00:00.000Z",
    observationSource: "sporttery-official-result",
    resultObservationFallback: false,
  },
});

const snapshotFixture = () => ({
  matchId: "sporttery_2040999",
  sourceMatchId: "2040999",
  phase: "late",
  capturedAt: "2026-07-01T10:40:00.000Z",
  cutoffTime: "2026-07-01T11:00:00.000Z",
  kickoffTime: "2026-07-01T20:00:00+08:00",
  policyVersion: "multi-factor-market-evidence-v2",
  modelVersion: "probability-model-v1",
  calibrationVersion: "rolling-calibration-v1",
  featureSnapshot: {
    hash: "legacy-self-reported-hash",
    version: "prediction-feature-snapshot-v1",
    confidentialMarker: "RAW_FEATURE_MUST_NOT_LEAK",
    teamForm: {
      home: { matches: 5, points: 10 },
      away: { matches: 5, points: 8 },
    },
    market: {
      had: { line: 0 },
      hhad: { line: -1 },
    },
  },
  decisionSnapshot: {
    version: DECISION_SNAPSHOT_VERSION,
    capturedAt: "2026-07-01T10:40:00.000Z",
    decisionAt: "2026-07-01T10:45:00.000Z",
    cutoffTime: "2026-07-01T11:00:00.000Z",
    kickoffTime: "2026-07-01T20:00:00+08:00",
    matchId: "sporttery_2040999",
    sourceMatchId: "2040999",
    sourceCycleId: decisionCycleId,
  policyVersion: "multi-factor-market-evidence-v2",
    modelVersion: "probability-model-v1",
    calibrationVersion: "rolling-calibration-v1",
    policyHash: "fixture-policy-hash",
    sourceTimestamps: {
      modelGeneratedAt: "2026-07-01T10:37:00.000Z",
      baseModelGeneratedAt: "2026-07-01T10:36:00.000Z",
      unifiedPosteriorGeneratedAt: "2026-07-01T10:37:00.000Z",
      hadObservedAt: "2026-07-01T10:34:00.000Z",
      hadReceivedAt: "2026-07-01T10:35:00.000Z",
      hhadObservedAt: "2026-07-01T10:33:00.000Z",
      hhadReceivedAt: "2026-07-01T10:34:00.000Z",
    },
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: true,
      blockers: [],
      sourceCycleId: decisionCycleId,
      capturedAt: "2026-07-01T10:40:00.000Z",
      decisionAt: "2026-07-01T10:45:00.000Z",
      cutoffTime: "2026-07-01T11:00:00.000Z",
      kickoffTime: "2026-07-01T12:00:00.000Z",
      modelGeneratedAt: "2026-07-01T10:37:00.000Z",
      baseModelGeneratedAt: "2026-07-01T10:36:00.000Z",
      unifiedPosteriorGeneratedAt: "2026-07-01T10:37:00.000Z",
      markets: {
        HAD: {
          observedAt: "2026-07-01T10:34:00.000Z",
          receivedAt: "2026-07-01T10:35:00.000Z",
          sourceCycleId: decisionCycleId,
          provenanceHash: marketProvenance("HAD", "2026-07-01T10:34:00.000Z", "2026-07-01T10:35:00.000Z").hash,
          provenanceEligible: true,
        },
        HHAD: {
          observedAt: "2026-07-01T10:33:00.000Z",
          receivedAt: "2026-07-01T10:34:00.000Z",
          sourceCycleId: decisionCycleId,
          provenanceHash: marketProvenance("HHAD", "2026-07-01T10:33:00.000Z", "2026-07-01T10:34:00.000Z").hash,
          provenanceEligible: true,
        },
      },
    },
    markets: {
      HAD: {
        line: 0,
        odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
        observedAt: "2026-07-01T10:34:00.000Z",
        receivedAt: "2026-07-01T10:35:00.000Z",
        provenance: marketProvenance("HAD", "2026-07-01T10:34:00.000Z", "2026-07-01T10:35:00.000Z"),
        provenanceHash: marketProvenance("HAD", "2026-07-01T10:34:00.000Z", "2026-07-01T10:35:00.000Z").hash,
      },
      HHAD: {
        line: -1,
        odds: { odds1: 3.8, oddsX: 3.7, odds2: 1.68 },
        observedAt: "2026-07-01T10:33:00.000Z",
        receivedAt: "2026-07-01T10:34:00.000Z",
        provenance: marketProvenance("HHAD", "2026-07-01T10:33:00.000Z", "2026-07-01T10:34:00.000Z"),
        provenanceHash: marketProvenance("HHAD", "2026-07-01T10:33:00.000Z", "2026-07-01T10:34:00.000Z").hash,
      },
    },
    probabilities: {
      HAD: { home: 0.45, draw: 0.28, away: 0.27 },
      HHAD: { line: -1, outcomes: { home: 0.25, draw: 0.3, away: 0.45 } },
    },
    dataQuality: 0.82,
    candidates: [
      { key: "HAD:1:0", selected: true },
      { key: "HHAD:2:-1", selected: false },
    ],
    selectedCandidateKey: "HAD:1:0",
  },
});

const hasRawEvidenceKey = (value) => {
  if (Array.isArray(value)) return value.some(hasRawEvidenceKey);
  if (!value || typeof value !== "object") return false;
  const forbidden = new Set(["featureSnapshot", "decisionSnapshot", "odds", "probabilities", "result"]);
  return Object.entries(value).some(([key, child]) => forbidden.has(key) || hasRawEvidenceKey(child));
};

const match = matchFixture();
const snapshot = snapshotFixture();
const baseline = buildPromotionEvidenceAudit({
  matches: { rows: [match] },
  snapshots: { rows: [snapshot] },
  generatedAt,
});

equal(baseline.version, PROMOTION_EVIDENCE_AUDIT_VERSION);
equal(baseline.records.length, 2, "one latest decision must create HAD and HHAD records");
equal(baseline.summary.finishedMatches, 1);
equal(baseline.summary.officialFinishedMatches, 1);
equal(baseline.summary.matchedFinishedMatches, 1);
equal(baseline.summary.eligibleRows, 2);
equal(baseline.summary.rejectedRows, 0);
equal(baseline.summary.byMarket.HAD.eligible, 1);
equal(baseline.summary.byMarket.HHAD.eligible, 1);
equal(baseline.manifest.promotionEligible, true);
equal(validatePromotionEvidenceManifest(baseline.manifest, baseline.records).valid, true);
check(baseline.records.every((record) => record.promotionEligible));
check(baseline.records.every((record) => Object.values(record.hashes).every((hash) => HASH_PATTERN.test(hash))),
  "all raw payload types, including the official result, must be committed with SHA-256");
check(baseline.records.every((record) => (
  Object.entries(record.clocks)
    .filter(([key, value]) => key.endsWith("At") && value !== null)
    .every(([, value]) => new Date(value).toISOString() === value)
)), "all emitted clock values must be canonical UTC");
equal(baseline.records[0].clocks.kickoffTime, "2026-07-01T12:00:00.000Z");
equal(baseline.records[0].identity.eventVersion, "2026-07-01T12:00:00.000Z");
equal(hasRawEvidenceKey(baseline), false, "audit output must not contain raw features or decisions");
check(!JSON.stringify(baseline).includes("RAW_FEATURE_MUST_NOT_LEAK"));

const older = snapshotFixture();
older.capturedAt = "2026-07-01T10:20:00.000Z";
older.decisionSnapshot.capturedAt = older.capturedAt;
older.decisionSnapshot.decisionAt = "2026-07-01T10:25:00.000Z";
older.featureSnapshot.teamForm.home.points = 1;
const latestOnly = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [older, snapshot],
  generatedAt,
});
equal(latestOnly.summary.selection.eligibleCandidateRows, 2);
equal(latestOnly.summary.selection.selectedLatestRows, 1);
equal(latestOnly.records.length, 2);
equal(latestOnly.manifest.rootHash, baseline.manifest.rootHash,
  "an older eligible revision must not replace the latest pre-cutoff revision");

const review = snapshotFixture();
review.phase = "review";
review.capturedAt = "2026-07-01T10:55:00.000Z";
review.decisionSnapshot.capturedAt = review.capturedAt;
review.decisionSnapshot.decisionAt = "2026-07-01T10:56:00.000Z";
review.featureSnapshot.teamForm.home.points = 999;
const postCutoff = snapshotFixture();
postCutoff.capturedAt = "2026-07-01T11:01:00.000Z";
postCutoff.decisionSnapshot.capturedAt = postCutoff.capturedAt;
postCutoff.decisionSnapshot.decisionAt = "2026-07-01T11:02:00.000Z";
postCutoff.featureSnapshot.teamForm.home.points = 777;
const selectionGuard = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [snapshot, review, postCutoff],
  generatedAt,
});
equal(selectionGuard.summary.selection.reviewRejected, 1);
equal(selectionGuard.summary.selection.postCutoffRejected, 1);
equal(selectionGuard.summary.selection.selectedLatestRows, 1);
equal(selectionGuard.records.length, 2);
equal(selectionGuard.manifest.rootHash, baseline.manifest.rootHash,
  "review and post-cutoff rows must not enter the evidence manifest");

const reviewOnly = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [review, postCutoff],
  generatedAt,
});
equal(reviewOnly.records.length, 0);
equal(reviewOnly.summary.unmatchedFinishedMatches, 1);
equal(reviewOnly.manifest.promotionEligible, false);

const missingOddsTimeSnapshot = snapshotFixture();
delete missingOddsTimeSnapshot.decisionSnapshot.sourceTimestamps.hadReceivedAt;
delete missingOddsTimeSnapshot.decisionSnapshot.sourceTimestamps.hhadReceivedAt;
delete missingOddsTimeSnapshot.decisionSnapshot.markets.HAD.receivedAt;
delete missingOddsTimeSnapshot.decisionSnapshot.markets.HHAD.receivedAt;
const missingOddsTimes = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [missingOddsTimeSnapshot],
  generatedAt,
});
equal(missingOddsTimes.records.length, 2);
equal(missingOddsTimes.summary.eligibleRows, 0);
equal(missingOddsTimes.manifest.promotionEligible, false);
check(missingOddsTimes.records.every((record) => record.clocks.oddsReceivedAt === null),
  "missing received times must remain null rather than being synthesized");
check(missingOddsTimes.records.every((record) => (
  record.blockers.includes("odds-received-at-missing-or-invalid")
)));

const missingCycleSnapshot = snapshotFixture();
delete missingCycleSnapshot.decisionSnapshot.sourceCycleId;
const missingCycle = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [missingCycleSnapshot],
  generatedAt,
});
check(missingCycle.records.every((record) => record.provenance.sourceCycleId === null));
check(missingCycle.records.every((record) => record.blockers.includes("source-cycle-id-missing")));
equal(missingCycle.manifest.promotionEligible, false);

const missingClockAuditSnapshot = snapshotFixture();
delete missingClockAuditSnapshot.decisionSnapshot.clockAudit;
const missingClockAudit = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [missingClockAuditSnapshot],
  generatedAt,
});
equal(missingClockAudit.records.length, 2);
check(missingClockAudit.records.every((record) => (
  record.blockers.includes("decision-clock-audit-ineligible")
)));
equal(missingClockAudit.manifest.promotionEligible, false);

const mutableOuterOnlySnapshot = snapshotFixture();
mutableOuterOnlySnapshot.odds = { odds1: 2.1, oddsX: 3.2, odds2: 3.4 };
mutableOuterOnlySnapshot.handicapOdds = { odds1: 3.8, oddsX: 3.7, odds2: 1.68 };
mutableOuterOnlySnapshot.handicapLine = -1;
mutableOuterOnlySnapshot.probabilityFinal = { home: 0.45, draw: 0.28, away: 0.27 };
mutableOuterOnlySnapshot.oddsObservedAt = "2026-07-01T10:34:00.000Z";
mutableOuterOnlySnapshot.oddsReceivedAt = "2026-07-01T10:35:00.000Z";
mutableOuterOnlySnapshot.featureSnapshot.market.had = {
  line: 0,
  odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
  observedAt: "2026-07-01T10:34:00.000Z",
  receivedAt: "2026-07-01T10:35:00.000Z",
};
mutableOuterOnlySnapshot.featureSnapshot.market.hhad = {
  line: -1,
  odds: { odds1: 3.8, oddsX: 3.7, odds2: 1.68 },
  observedAt: "2026-07-01T10:33:00.000Z",
  receivedAt: "2026-07-01T10:34:00.000Z",
};
delete mutableOuterOnlySnapshot.decisionSnapshot.markets.HAD;
delete mutableOuterOnlySnapshot.decisionSnapshot.markets.HHAD;
delete mutableOuterOnlySnapshot.decisionSnapshot.probabilities.HAD;
delete mutableOuterOnlySnapshot.decisionSnapshot.probabilities.HHAD;
const mutableOuterOnlyAudit = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [mutableOuterOnlySnapshot],
  generatedAt,
});
const mutableOuterOnlyHad = mutableOuterOnlyAudit.records.find((record) => record.identity.market === "HAD");
equal(mutableOuterOnlyHad.promotionEligible, false,
  "complete mutable outer evidence must not repair an incomplete decision snapshot");
equal(mutableOuterOnlyHad.clocks.oddsObservedAt, null);
equal(mutableOuterOnlyHad.clocks.oddsReceivedAt, null);
equal(mutableOuterOnlyHad.hashes.oddsSha256, null);
equal(mutableOuterOnlyHad.hashes.probabilitiesSha256, null);
check(mutableOuterOnlyHad.blockers.includes("decision-market-missing"));
check(mutableOuterOnlyHad.blockers.includes("odds-triplet-invalid"));
check(mutableOuterOnlyHad.blockers.includes("probability-triplet-invalid"));
equal(mutableOuterOnlyAudit.manifest.promotionEligible, false);

const missingResultTimeMatch = matchFixture();
delete missingResultTimeMatch.resultProvenance.observedAt;
const missingResultTime = buildPromotionEvidenceAudit({
  matches: [missingResultTimeMatch],
  snapshots: [snapshot],
  generatedAt,
});
check(missingResultTime.records.every((record) => record.clocks.resultObservedAt === null));
check(missingResultTime.records.every((record) => (
  record.blockers.includes("result-observed-at-missing-or-invalid")
)));
equal(missingResultTime.manifest.promotionEligible, false);

const fallbackMatch = matchFixture();
fallbackMatch.resultProvenance.resultObservationFallback = true;
fallbackMatch.resultProvenance.observationSource = "kickoff-plus-three-hours";
const fallbackAudit = buildPromotionEvidenceAudit({
  matches: [fallbackMatch],
  snapshots: [snapshot],
  generatedAt,
});
check(fallbackAudit.records.every((record) => record.clocks.resultObservationFallback === true));
check(fallbackAudit.records.every((record) => record.blockers.includes("result-observation-fallback")));
equal(fallbackAudit.manifest.promotionEligible, false);

const nonOfficialMatch = matchFixture();
nonOfficialMatch.resultProvenance.official = false;
const nonOfficialAudit = buildPromotionEvidenceAudit({
  matches: [nonOfficialMatch],
  snapshots: [snapshot],
  generatedAt,
});
equal(nonOfficialAudit.summary.officialFinishedMatches, 0);
check(nonOfficialAudit.records.every((record) => record.blockers.includes("official-result-invalid")));
equal(nonOfficialAudit.manifest.promotionEligible, false);

const officialButUntrustedMatch = matchFixture();
officialButUntrustedMatch.resultProvenance.trusted = false;
officialButUntrustedMatch.sourceUrl = "https://webapi.sporttery.cn/gateway/uniform/football/result/get";
officialButUntrustedMatch.resultSource = "sporttery:official-result";
const officialButUntrustedAudit = buildPromotionEvidenceAudit({
  matches: [officialButUntrustedMatch],
  snapshots: [snapshot],
  generatedAt,
});
equal(officialButUntrustedAudit.summary.officialFinishedMatches, 0);
check(officialButUntrustedAudit.records.every((record) => (
  record.blockers.includes("trusted-sporttery-result-required")
  && record.blockers.includes("result-lifecycle-provenance-ineligible")
)));
equal(officialButUntrustedAudit.manifest.promotionEligible, false);

const mismatchedEventVersionMatch = matchFixture();
mismatchedEventVersionMatch.resultProvenance.eventVersion = "2026-07-01T13:00:00.000Z";
const mismatchedEventVersionAudit = buildPromotionEvidenceAudit({
  matches: [mismatchedEventVersionMatch],
  snapshots: [snapshot],
  generatedAt,
});
equal(mismatchedEventVersionAudit.summary.officialFinishedMatches, 0);
check(mismatchedEventVersionAudit.records.every((record) => (
  record.blockers.includes("result-event-version-mismatch")
  && record.blockers.includes("result-lifecycle-provenance-ineligible")
)));
equal(mismatchedEventVersionAudit.manifest.promotionEligible, false);

const conflictingSnapshot = snapshotFixture();
conflictingSnapshot.featureSnapshot.teamForm.home.points = 999;
conflictingSnapshot.featureSnapshot.hash = snapshot.featureSnapshot.hash;
const conflictAudit = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [snapshot, conflictingSnapshot],
  generatedAt,
});
equal(conflictAudit.summary.selection.latestTieGroups, 1);
equal(conflictAudit.records.length, 4);
equal(conflictAudit.manifest.conflictingDuplicateKeys, 2,
  "HAD and HHAD must each expose a same-key content conflict");
equal(conflictAudit.manifest.promotionEligible, false);
check(conflictAudit.manifest.blockers.includes("conflicting-duplicate-keys:2"));
equal(validatePromotionEvidenceManifest(conflictAudit.manifest, conflictAudit.records).valid, true);

const featureTamperSnapshot = snapshotFixture();
featureTamperSnapshot.featureSnapshot.teamForm.home.points = 500;
featureTamperSnapshot.featureSnapshot.hash = snapshot.featureSnapshot.hash;
const featureTamperAudit = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [featureTamperSnapshot],
  generatedAt,
});
check(featureTamperAudit.manifest.rootHash !== baseline.manifest.rootHash,
  "changing feature content while retaining its self-reported hash must change the audit root");
check(featureTamperAudit.records.every((record, index) => (
  record.hashes.featureSnapshotSha256 !== baseline.records[index].hashes.featureSnapshotSha256
)));

const decisionTamperSnapshot = snapshotFixture();
decisionTamperSnapshot.decisionSnapshot.dataQuality = 0.01;
const decisionTamperAudit = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [decisionTamperSnapshot],
  generatedAt,
});
check(decisionTamperAudit.records.every((record, index) => (
  record.hashes.decisionSnapshotSha256 !== baseline.records[index].hashes.decisionSnapshotSha256
)));
check(decisionTamperAudit.manifest.rootHash !== baseline.manifest.rootHash);

const storedRecordTamper = clone(baseline.records[0]);
storedRecordTamper.hashes.resultSha256 = "f".repeat(64);
const storedRecordValidation = validatePromotionEvidenceRecord(storedRecordTamper);
equal(storedRecordValidation.valid, false);
check(storedRecordValidation.errors.includes("record-hash-mismatch"));

const storedManifestTamper = clone(baseline.manifest);
storedManifestTamper.rootHash = "a".repeat(64);
const storedManifestValidation = validatePromotionEvidenceManifest(storedManifestTamper, baseline.records);
equal(storedManifestValidation.valid, false);
check(storedManifestValidation.errors.includes("manifest-hash-mismatch"));
check(storedManifestValidation.errors.includes("manifest-records-mismatch"));

const previousManifestHash = "b".repeat(64);
const chainedAudit = buildPromotionEvidenceAudit({
  matches: [match],
  snapshots: [snapshot],
  generatedAt,
  previousManifestHash,
});
equal(chainedAudit.manifest.previousManifestHash, previousManifestHash);
equal(validatePromotionEvidenceManifest(chainedAudit.manifest, chainedAudit.records).valid, true);

const backtestSource = fs.readFileSync(path.join(__dirname, "runModelBacktest.cjs"), "utf8");
check(backtestSource.includes('require("./promotionEvidenceAudit.cjs")'),
  "model backtest must import the promotion evidence audit");
check(backtestSource.includes("const promotionEvidenceAudit = buildPromotionEvidenceAudit({"),
  "model backtest must build evidence from the actual match and snapshot rows");
check(backtestSource.includes("promotionEvidenceAudit,"),
  "model evaluation payload must expose the fail-closed promotion evidence audit");

console.log(JSON.stringify({
  ok: true,
  verifier: "promotion-evidence-audit",
  assertions,
  version: PROMOTION_EVIDENCE_AUDIT_VERSION,
  baseline: {
    records: baseline.records.length,
    eligibleRows: baseline.summary.eligibleRows,
    markets: baseline.summary.byMarket,
    rootHash: baseline.manifest.rootHash,
    manifestHash: baseline.manifest.manifestHash,
    rawEvidenceLeaked: hasRawEvidenceKey(baseline),
  },
  selectionPolicy: {
    reviewRejected: selectionGuard.summary.selection.reviewRejected,
    postCutoffRejected: selectionGuard.summary.selection.postCutoffRejected,
    latestRows: selectionGuard.summary.selection.selectedLatestRows,
  },
  failClosed: {
    missingOddsTimes: missingOddsTimes.summary.blockerCounts,
    missingSourceCycle: missingCycle.summary.blockerCounts,
    missingResultTime: missingResultTime.summary.blockerCounts,
    fallbackResult: fallbackAudit.summary.blockerCounts,
    nonOfficialResult: nonOfficialAudit.summary.blockerCounts,
    mutableOuterOnly: mutableOuterOnlyAudit.summary.blockerCounts,
    officialButUntrusted: officialButUntrustedAudit.summary.blockerCounts,
    eventVersionMismatch: mismatchedEventVersionAudit.summary.blockerCounts,
    conflictingDuplicateKeys: conflictAudit.manifest.conflictingDuplicateKeys,
  },
  tamperResistance: {
    featureContentDetected: featureTamperAudit.manifest.rootHash !== baseline.manifest.rootHash,
    fullDecisionDetected: decisionTamperAudit.manifest.rootHash !== baseline.manifest.rootHash,
    storedRecordDetected: !storedRecordValidation.valid,
    storedManifestDetected: !storedManifestValidation.valid,
  },
}, null, 2));
