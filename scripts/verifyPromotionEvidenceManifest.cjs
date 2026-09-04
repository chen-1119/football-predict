const assert = require("node:assert/strict");
const {
  HASH_PATTERN,
  LEGACY_PROMOTION_EVIDENCE_MANIFEST_VERSION,
  LEGACY_PROMOTION_EVIDENCE_RECORD_VERSION,
  PROMOTION_EVIDENCE_MANIFEST_VERSION,
  PROMOTION_EVIDENCE_RECORD_VERSION,
  buildPromotionEvidenceManifest,
  buildPromotionEvidenceRecord,
  canonicalJson,
  sha256Json,
  validatePromotionEvidenceManifest,
  validatePromotionEvidenceRecord,
} = require("../src/services/promotionEvidenceManifest.cjs");
const {
  normalizeMarketSourceProvenance,
} = require("../src/services/marketSourceProvenance.cjs");
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
const throws = (operation, expected, message) => {
  assert.throws(operation, expected, message);
  assertions += 1;
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const rehashRecord = (value) => sha256Json(Object.fromEntries([
  "version", "recordKey", "identity", "clocks", "provenance", "hashes",
  "promotionEligible", "blockers",
].map((field) => [field, value[field]])));
const decisionCycleId = "cycle-2040999-1";
const collectorContext = createCollectorAttestationTestContext({ keyId: "promotion-manifest-test-ed25519" });
const hadMarketProvenance = () => collectorContext.buildSignedMarketProvenance({
  poolCode: "HAD",
  sourceMatchId: "2040999",
  odds: { "1": 2.1, X: 3.2, "2": 3.4 },
  handicapLine: 0,
  sourceUrl: "https://webapi.sporttery.cn/gateway/promotion-manifest-fixture.qry",
  providerObservedAt: "2026-07-01T10:35:00.000Z",
  sourceTiming: {
    sourceCycleId: decisionCycleId,
    requestedAt: "2026-07-01T10:34:00.000Z",
    receivedAt: "2026-07-01T10:36:00.000Z",
    sourceRequest: { method: "GET", page: 1, role: "promotion-manifest-fixture" },
    httpStatus: 200,
    rawSha256: "8".repeat(64),
    rawBytes: 2000,
  },
});
const hhadMarketProvenance = () => collectorContext.buildSignedMarketProvenance({
  poolCode: "HHAD",
  sourceMatchId: "2040999",
  odds: { "1": 3.8, X: 3.7, "2": 1.68 },
  handicapLine: -1,
  sourceUrl: "https://webapi.sporttery.cn/gateway/promotion-manifest-fixture.qry",
  providerObservedAt: "2026-07-01T10:35:00.000Z",
  sourceTiming: {
    sourceCycleId: decisionCycleId,
    requestedAt: "2026-07-01T10:34:00.000Z",
    receivedAt: "2026-07-01T10:36:00.000Z",
    sourceRequest: { method: "GET", page: 1, role: "promotion-manifest-fixture" },
    httpStatus: 200,
    rawSha256: "9".repeat(64),
    rawBytes: 2100,
  },
});

const marketCommitmentFields = (value) => {
  const provenance = normalizeMarketSourceProvenance(value, { trustRegistry: collectorContext.registry });
  return {
    marketProvenanceVersion: provenance.version,
    marketProvenanceHash: provenance.hash,
    collectorAttestationKeyId: provenance.strict.collectorAttestationKeyId,
    collectorAttestationKeyFingerprint: provenance.strict.collectorAttestationKeyFingerprint,
    collectorAttestationCommitmentHash: provenance.strict.collectorAttestationCommitmentHash,
    marketExtractionHash: provenance.extraction.hash,
    collectorTrustBoundary: provenance.strict.trustBoundary,
  };
};

const fixtureInput = () => ({
  identity: {
    matchId: "sporttery_2040999",
    sourceMatchId: "2040999",
    eventVersion: "2026-07-01T12:00:00.000Z",
    market: "HAD",
    handicapLine: 0,
  },
  clocks: {
    capturedAt: "2026-07-01T10:40:00.000Z",
    decisionAt: "2026-07-01T10:45:00.000Z",
    cutoffTime: "2026-07-01T11:00:00.000Z",
    kickoffTime: "2026-07-01T12:00:00.000Z",
    modelGeneratedAt: "2026-07-01T10:38:00.000Z",
    oddsObservedAt: "2026-07-01T10:35:00.000Z",
    oddsReceivedAt: "2026-07-01T10:36:00.000Z",
    resultObservedAt: "2026-07-01T14:00:00.000Z",
    resultObservationSource: "officialResult.observedAt",
    resultObservationFallback: false,
  },
  provenance: {
    snapshotVersion: "candidate-decision-snapshot-v2",
    policyVersion: "multi-factor-market-evidence-v2",
    modelVersion: "probability-model-v1",
    calibrationVersion: "rolling-calibration-v1",
    sourceCycleId: decisionCycleId,
    phase: "late",
    ...marketCommitmentFields(hadMarketProvenance()),
  },
  featureSnapshot: {
    hash: "1h9dqqs",
    league: "fixture-league",
    market: {
      had: {
        line: 0,
        odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
      },
    },
    teamForm: {
      away: { matches: 5, points: 8 },
      home: { matches: 5, points: 10 },
    },
  },
  decisionSnapshot: {
    version: "candidate-decision-snapshot-v2",
    capturedAt: "2026-07-01T10:40:00.000Z",
    decisionAt: "2026-07-01T10:45:00.000Z",
    cutoffTime: "2026-07-01T11:00:00.000Z",
    kickoffTime: "2026-07-01T12:00:00.000Z",
    sourceCycleId: decisionCycleId,
    policyVersion: "multi-factor-market-evidence-v2",
    modelVersion: "probability-model-v1",
    calibrationVersion: "rolling-calibration-v1",
    selectedCandidateKey: "HAD:1:0",
    policyHash: "policy-hash-fixture",
    candidates: [{ key: "HAD:1:0", selected: true, odds: 2.1 }],
    sourceTimestamps: {
      modelGeneratedAt: "2026-07-01T10:38:00.000Z",
      baseModelGeneratedAt: "2026-07-01T10:37:00.000Z",
      unifiedPosteriorGeneratedAt: "2026-07-01T10:38:00.000Z",
      hadObservedAt: "2026-07-01T10:35:00.000Z",
      hadReceivedAt: "2026-07-01T10:36:00.000Z",
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
      modelGeneratedAt: "2026-07-01T10:38:00.000Z",
      baseModelGeneratedAt: "2026-07-01T10:37:00.000Z",
      unifiedPosteriorGeneratedAt: "2026-07-01T10:38:00.000Z",
      markets: {
        HAD: {
          observedAt: "2026-07-01T10:35:00.000Z",
          receivedAt: "2026-07-01T10:36:00.000Z",
          sourceCycleId: decisionCycleId,
          provenanceHash: hadMarketProvenance().hash,
          provenanceEligible: true,
        },
      },
    },
    markets: {
      HAD: {
        line: 0,
        odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
        observedAt: "2026-07-01T10:35:00.000Z",
        receivedAt: "2026-07-01T10:36:00.000Z",
        provenance: hadMarketProvenance(),
        provenanceHash: hadMarketProvenance().hash,
      },
    },
    probabilities: {
      HAD: { home: 0.45, draw: 0.28, away: 0.27 },
    },
  },
  decisionClockAuditEligible: true,
  odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
  probabilities: { home: 0.45, draw: 0.28, away: 0.27 },
  result: {
    official: true,
    trusted: true,
    provider: "sporttery",
    provenanceValidated: true,
    eventVersion: "2026-07-01T12:00:00.000Z",
    eventVersionConsistent: true,
    status: "FINISHED",
    scoreHome: 2,
    scoreAway: 1,
    outcomeCode: "1",
    source: "sporttery-official-result",
  },
});

const source = fixtureInput();
const sourceBeforeBuild = canonicalJson(source);
const record = buildPromotionEvidenceRecord(source);

equal(canonicalJson(source), sourceBeforeBuild, "builder must not mutate source evidence");
equal(record.version, PROMOTION_EVIDENCE_RECORD_VERSION);
equal(record.promotionEligible, true);
deepEqual(record.blockers, []);
check(HASH_PATTERN.test(record.recordKey));
check(HASH_PATTERN.test(record.recordHash));
check(Object.values(record.hashes).every((hash) => HASH_PATTERN.test(hash)));
equal(validatePromotionEvidenceRecord(record, source).valid, true);
equal(validatePromotionEvidenceRecord(record, source).promotionEligible, true);

equal(canonicalJson({ z: 2, a: { y: 1, x: 0 } }), canonicalJson({ a: { x: 0, y: 1 }, z: 2 }));
equal(sha256Json({ z: 2, a: 1 }), sha256Json({ a: 1, z: 2 }));
throws(() => sha256Json({ unsafe: Number.NaN }), /non-finite number/);

const reordered = fixtureInput();
reordered.featureSnapshot = {
  teamForm: {
    home: { points: 10, matches: 5 },
    away: { points: 8, matches: 5 },
  },
  market: {
    had: {
      odds: { odds2: 3.4, oddsX: 3.2, odds1: 2.1 },
      line: 0,
    },
  },
  league: "fixture-league",
  hash: "1h9dqqs",
};
const reorderedRecord = buildPromotionEvidenceRecord(reordered);
equal(reorderedRecord.hashes.featureSnapshotSha256, record.hashes.featureSnapshotSha256,
  "object key order must not change the feature commitment");
equal(reorderedRecord.recordHash, record.recordHash,
  "canonical evidence with different insertion order must produce the same record");

const selfReportedHashOnlyChange = fixtureInput();
selfReportedHashOnlyChange.featureSnapshot.hash = "attacker-controlled-declared-hash";
const selfReportedHashRecord = buildPromotionEvidenceRecord(selfReportedHashOnlyChange);
equal(selfReportedHashRecord.hashes.featureSnapshotSha256, record.hashes.featureSnapshotSha256,
  "the legacy self-reported hash must not be trusted as feature content");
equal(selfReportedHashRecord.recordHash, record.recordHash,
  "changing only the ignored legacy hash must not change canonical evidence");

const tamperedSource = fixtureInput();
tamperedSource.featureSnapshot.teamForm.home.points = 999;
tamperedSource.featureSnapshot.hash = source.featureSnapshot.hash;
const tamperedRecord = buildPromotionEvidenceRecord(tamperedSource);
equal(tamperedRecord.recordKey, record.recordKey,
  "the same event and decision horizon must retain its duplicate-detection key");
check(tamperedRecord.hashes.featureSnapshotSha256 !== record.hashes.featureSnapshotSha256,
  "changing feature content must change its SHA-256 commitment");
const tamperedSourceValidation = validatePromotionEvidenceRecord(record, tamperedSource);
equal(tamperedSourceValidation.valid, false);
check(tamperedSourceValidation.errors.includes("source-evidence-mismatch"));

const tamperedResultSource = fixtureInput();
tamperedResultSource.result.scoreHome = 0;
tamperedResultSource.result.scoreAway = 1;
tamperedResultSource.result.outcomeCode = "2";
const tamperedResultRecord = buildPromotionEvidenceRecord(tamperedResultSource);
check(tamperedResultRecord.hashes.resultSha256 !== record.hashes.resultSha256,
  "changing the official outcome must change the result commitment");
const tamperedResultValidation = validatePromotionEvidenceRecord(record, tamperedResultSource);
equal(tamperedResultValidation.valid, false);
check(tamperedResultValidation.errors.includes("source-evidence-mismatch"));

const marketOddsTamperInput = fixtureInput();
marketOddsTamperInput.decisionSnapshot.markets.HAD.odds.odds1 = 2.2;
marketOddsTamperInput.odds.odds1 = 2.2;
const marketOddsTamperRecord = buildPromotionEvidenceRecord(marketOddsTamperInput);
equal(marketOddsTamperRecord.promotionEligible, false);
check(marketOddsTamperRecord.blockers.includes("market-extraction-decision-odds-mismatch"),
  "decision odds must remain bound to the signed endpoint row extraction hash");

const tamperedStoredRecord = clone(record);
tamperedStoredRecord.hashes.featureSnapshotSha256 = "f".repeat(64);
const tamperedStoredValidation = validatePromotionEvidenceRecord(tamperedStoredRecord, source);
equal(tamperedStoredValidation.valid, false);
check(tamperedStoredValidation.errors.includes("record-hash-mismatch"));
check(tamperedStoredValidation.errors.includes("source-evidence-mismatch"));

const crossFieldTamperRecord = clone(record);
crossFieldTamperRecord.provenance.marketProvenanceHash = "c".repeat(64);
crossFieldTamperRecord.recordHash = rehashRecord(crossFieldTamperRecord);
const crossFieldTamperValidation = validatePromotionEvidenceRecord(crossFieldTamperRecord);
equal(crossFieldTamperValidation.valid, false);
check(crossFieldTamperValidation.errors.includes("record-market-provenance-hash-commitment-mismatch"));

const missingCommitmentRecord = clone(record);
delete missingCommitmentRecord.hashes.probabilitiesSha256;
const missingCommitmentValidation = validatePromotionEvidenceRecord(missingCommitmentRecord);
equal(missingCommitmentValidation.valid, false);
check(missingCommitmentValidation.errors.some((error) => error.startsWith("record-hashes-missing-fields:")));

const invalidHadLineInput = fixtureInput();
invalidHadLineInput.identity.handicapLine = -1;
const invalidHadLineRecord = buildPromotionEvidenceRecord(invalidHadLineInput);
equal(invalidHadLineRecord.promotionEligible, false);
check(invalidHadLineRecord.blockers.includes("had-line-must-be-zero"));

const mutableOuterOnlyInput = fixtureInput();
delete mutableOuterOnlyInput.decisionSnapshot.markets.HAD;
delete mutableOuterOnlyInput.decisionSnapshot.probabilities.HAD;
const mutableOuterOnlyRecord = buildPromotionEvidenceRecord(mutableOuterOnlyInput);
equal(mutableOuterOnlyRecord.promotionEligible, false,
  "complete caller odds/probabilities/clocks must not replace missing committed decision evidence");
check(mutableOuterOnlyRecord.blockers.includes("decision-market-missing"));
check(mutableOuterOnlyRecord.blockers.includes("decision-odds-source-mismatch"));
check(mutableOuterOnlyRecord.blockers.includes("decision-probabilities-source-mismatch"));
check(mutableOuterOnlyRecord.blockers.includes("decision-clock-source-mismatch"));

const officialButUntrustedInput = fixtureInput();
officialButUntrustedInput.result.trusted = false;
const officialButUntrustedRecord = buildPromotionEvidenceRecord(officialButUntrustedInput);
equal(officialButUntrustedRecord.promotionEligible, false);
check(officialButUntrustedRecord.blockers.includes("trusted-sporttery-result-required"));
check(officialButUntrustedRecord.blockers.includes("result-lifecycle-provenance-ineligible"));

const mismatchedEventVersionInput = fixtureInput();
mismatchedEventVersionInput.result.eventVersion = "2026-07-01T13:00:00.000Z";
const mismatchedEventVersionRecord = buildPromotionEvidenceRecord(mismatchedEventVersionInput);
equal(mismatchedEventVersionRecord.promotionEligible, false);
check(mismatchedEventVersionRecord.blockers.includes("result-event-version-mismatch"));
check(mismatchedEventVersionRecord.blockers.includes("result-lifecycle-provenance-ineligible"));

const timeCases = [
  {
    name: "observed-after-received",
    mutate: (input) => { input.clocks.oddsObservedAt = "2026-07-01T10:37:00.000Z"; },
    blocker: "odds-observed-after-received",
  },
  {
    name: "received-after-decision",
    mutate: (input) => { input.clocks.oddsReceivedAt = "2026-07-01T10:50:00.000Z"; },
    blocker: "odds-received-after-decision",
  },
  {
    name: "decision-after-cutoff",
    mutate: (input) => { input.clocks.decisionAt = "2026-07-01T11:01:00.000Z"; },
    blocker: "decision-after-cutoff",
  },
  {
    name: "fallback-result-time",
    mutate: (input) => {
      input.clocks.resultObservationFallback = true;
      input.clocks.resultObservationSource = "kickoff-plus-three-hours";
    },
    blocker: "result-observation-fallback",
  },
  {
    name: "missing-received-at",
    mutate: (input) => { input.clocks.oddsReceivedAt = null; },
    blocker: "odds-received-at-missing-or-invalid",
  },
  {
    name: "review-phase",
    mutate: (input) => { input.provenance.phase = "review"; },
    blocker: "review-phase-not-promotable",
  },
  {
    name: "noncanonical-clock",
    mutate: (input) => { input.clocks.capturedAt = "2026-07-01T18:40:00+08:00"; },
    blocker: "captured-at-missing-or-invalid",
  },
  {
    name: "result-before-kickoff",
    mutate: (input) => { input.clocks.resultObservedAt = "2026-07-01T11:59:00.000Z"; },
    blocker: "result-observed-before-kickoff",
  },
];

const timeResults = [];
for (const testCase of timeCases) {
  const input = fixtureInput();
  testCase.mutate(input);
  const built = buildPromotionEvidenceRecord(input);
  equal(built.promotionEligible, false, `${testCase.name} must remain audit-only`);
  check(built.blockers.includes(testCase.blocker), `${testCase.name} must emit ${testCase.blocker}`);
  const validation = validatePromotionEvidenceRecord(built, input);
  equal(validation.valid, true, `${testCase.name} must be an intact but ineligible record`);
  equal(validation.promotionEligible, false);
  timeResults.push({ name: testCase.name, blocker: testCase.blocker });
}

const generatedAt = "2026-07-01T15:00:00.000Z";
const duplicateManifest = buildPromotionEvidenceManifest([record, clone(record)], { generatedAt });
equal(duplicateManifest.version, PROMOTION_EVIDENCE_MANIFEST_VERSION);
equal(duplicateManifest.totalRows, 2);
equal(duplicateManifest.canonicalRows, 1);
equal(duplicateManifest.duplicateRowsRemoved, 1);
equal(duplicateManifest.conflictingDuplicateKeys, 0);
equal(duplicateManifest.promotionEligible, true);
equal(validatePromotionEvidenceManifest(duplicateManifest, [record, clone(record)]).valid, true);

const hhadInput = fixtureInput();
hhadInput.identity.market = "HHAD";
hhadInput.identity.handicapLine = -1;
hhadInput.provenance = {
  ...hhadInput.provenance,
  ...marketCommitmentFields(hhadMarketProvenance()),
};
hhadInput.decisionSnapshot.selectedCandidateKey = "HHAD:1:-1";
hhadInput.decisionSnapshot.candidates = [{ key: "HHAD:1:-1", selected: true, odds: 2.1 }];
hhadInput.decisionSnapshot.sourceTimestamps.hhadObservedAt = "2026-07-01T10:35:00.000Z";
hhadInput.decisionSnapshot.sourceTimestamps.hhadReceivedAt = "2026-07-01T10:36:00.000Z";
hhadInput.decisionSnapshot.clockAudit.markets.HHAD = {
  observedAt: "2026-07-01T10:35:00.000Z",
  receivedAt: "2026-07-01T10:36:00.000Z",
  sourceCycleId: decisionCycleId,
  provenanceHash: hhadMarketProvenance().hash,
  provenanceEligible: true,
};
hhadInput.decisionSnapshot.markets.HHAD = {
  line: -1,
  odds: { odds1: 3.8, oddsX: 3.7, odds2: 1.68 },
  observedAt: "2026-07-01T10:35:00.000Z",
  receivedAt: "2026-07-01T10:36:00.000Z",
  provenance: hhadMarketProvenance(),
  provenanceHash: hhadMarketProvenance().hash,
};
hhadInput.decisionSnapshot.probabilities.HHAD = {
  line: -1,
  outcomes: { home: 0.25, draw: 0.3, away: 0.45 },
};
hhadInput.odds = { odds1: 3.8, oddsX: 3.7, odds2: 1.68 };
hhadInput.probabilities = { home: 0.25, draw: 0.3, away: 0.45 };
const hhadRecord = buildPromotionEvidenceRecord(hhadInput);
equal(hhadRecord.promotionEligible, true);
const orderedManifest = buildPromotionEvidenceManifest([record, hhadRecord], { generatedAt });
const reversedManifest = buildPromotionEvidenceManifest([hhadRecord, record], { generatedAt });
equal(orderedManifest.manifestHash, reversedManifest.manifestHash,
  "input order must not change the canonical manifest");
deepEqual(orderedManifest.rowHashes, reversedManifest.rowHashes);
equal(validatePromotionEvidenceManifest(orderedManifest, [hhadRecord, record]).valid, true);

const conflictManifest = buildPromotionEvidenceManifest([record, tamperedRecord], { generatedAt });
equal(conflictManifest.conflictingDuplicateKeys, 1);
equal(conflictManifest.promotionEligible, false);
check(conflictManifest.blockers.includes("conflicting-duplicate-keys:1"));
const conflictValidation = validatePromotionEvidenceManifest(conflictManifest, [record, tamperedRecord]);
equal(conflictValidation.valid, true,
  "a conflict report is an intact manifest even though it must never promote");
equal(conflictValidation.promotionEligible, false);

const invalidRecord = clone(record);
invalidRecord.hashes.featureSnapshotSha256 = "0".repeat(64);
const invalidManifest = buildPromotionEvidenceManifest([invalidRecord], { generatedAt });
equal(invalidManifest.invalidRows, 1);
equal(invalidManifest.promotionEligible, false);
check(invalidManifest.blockers.includes("invalid-records:1"));
equal(validatePromotionEvidenceManifest(invalidManifest, [invalidRecord]).valid, true,
  "the manifest must faithfully report invalid source records without promoting them");

const tamperedManifest = clone(orderedManifest);
tamperedManifest.rootHash = "a".repeat(64);
const tamperedManifestValidation = validatePromotionEvidenceManifest(tamperedManifest, [record, hhadRecord]);
equal(tamperedManifestValidation.valid, false);
check(tamperedManifestValidation.errors.includes("manifest-hash-mismatch"));
check(tamperedManifestValidation.errors.includes("manifest-records-mismatch"));

const previousManifestHash = "b".repeat(64);
const chainedManifest = buildPromotionEvidenceManifest([record], { generatedAt, previousManifestHash });
equal(chainedManifest.previousManifestHash, previousManifestHash);
equal(validatePromotionEvidenceManifest(chainedManifest, [record]).valid, true);
throws(() => buildPromotionEvidenceManifest([record], {
  generatedAt,
  previousManifestHash: "B".repeat(64),
}), /previousManifestHash/);
throws(() => buildPromotionEvidenceManifest([record], {
  generatedAt: "2026-07-01T23:00:00+08:00",
}), /generatedAt/);

const legacyRecord = clone(record);
legacyRecord.version = LEGACY_PROMOTION_EVIDENCE_RECORD_VERSION;
legacyRecord.recordHash = rehashRecord(legacyRecord);
const legacyRecordValidation = validatePromotionEvidenceRecord(legacyRecord);
equal(legacyRecordValidation.valid, true);
equal(legacyRecordValidation.promotionEligible, false);
check(legacyRecordValidation.blockers.includes("legacy-promotion-evidence-v1-audit-only"));

const legacyManifest = clone(orderedManifest);
legacyManifest.version = LEGACY_PROMOTION_EVIDENCE_MANIFEST_VERSION;
legacyManifest.manifestHash = sha256Json(Object.fromEntries([
  "version", "generatedAt", "previousManifestHash", "totalRows", "canonicalRows",
  "validRows", "invalidRows", "eligibleRows", "rejectedRows", "duplicateRowsRemoved",
  "conflictingDuplicateKeys", "rejectedByReason", "firstForecastAt", "lastForecastAt",
  "rowHashes", "eligibleRowHashes", "rootHash", "eligibleRootHash", "promotionEligible", "blockers",
].map((field) => [field, legacyManifest[field]])));
const legacyManifestValidation = validatePromotionEvidenceManifest(legacyManifest, [record, hhadRecord]);
equal(legacyManifestValidation.valid, true);
equal(legacyManifestValidation.promotionEligible, false);
check(legacyManifestValidation.blockers.includes("legacy-promotion-evidence-v1-audit-only"));

console.log(JSON.stringify({
  ok: true,
  verifier: "promotion-evidence-manifest",
  assertions,
  versions: {
    record: PROMOTION_EVIDENCE_RECORD_VERSION,
    manifest: PROMOTION_EVIDENCE_MANIFEST_VERSION,
    legacyV1AuditOnly: legacyRecordValidation.legacyAuditOnly
      && legacyManifestValidation.legacyAuditOnly,
  },
  baseline: {
    recordKey: record.recordKey,
    recordHash: record.recordHash,
    featureSnapshotSha256: record.hashes.featureSnapshotSha256,
    promotionEligible: record.promotionEligible,
  },
  tamperResistance: {
    legacyDeclaredHashIgnored: true,
    featureMutationDetected: !tamperedSourceValidation.valid,
    storedCommitmentMutationDetected: !tamperedStoredValidation.valid,
    crossFieldMarketCommitmentMutationDetected: !crossFieldTamperValidation.valid,
    officialResultMutationDetected: !tamperedResultValidation.valid,
    signedMarketOddsMutationRejected: marketOddsTamperRecord.blockers
      .includes("market-extraction-decision-odds-mismatch"),
    manifestMutationDetected: !tamperedManifestValidation.valid,
  },
  failClosedSourceBinding: {
    mutableOuterOnly: mutableOuterOnlyRecord.blockers,
    officialButUntrusted: officialButUntrustedRecord.blockers,
    eventVersionMismatch: mismatchedEventVersionRecord.blockers,
  },
  timePolicy: {
    tested: timeResults.length,
    cases: timeResults,
  },
  duplicatePolicy: {
    exactDuplicateRowsRemoved: duplicateManifest.duplicateRowsRemoved,
    conflictingDuplicateKeys: conflictManifest.conflictingDuplicateKeys,
    conflictPromotionEligible: conflictManifest.promotionEligible,
  },
  deterministicManifest: {
    rows: orderedManifest.canonicalRows,
    rootHash: orderedManifest.rootHash,
    eligibleRootHash: orderedManifest.eligibleRootHash,
    manifestHash: orderedManifest.manifestHash,
  },
}, null, 2));
