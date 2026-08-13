const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  attachPostMatchReviews,
  attachResultAuditTimestamps,
  buildPostMatchReview,
  buildPredictionReviewRows,
  commitRecommendationPublicationLedger,
  finalizeLiveRecommendationPublications,
} = require("./syncData.cjs");
const {
  PUBLICATION_BINDING_VERSION,
  PUBLICATION_LEDGER_VERSION,
  PUBLICATION_RECORD_VERSION,
  RECORD_FIELDS,
  appendPublicationRecord,
  buildPublicationLedgerIndex,
  emptyPublicationLedger,
  hashPublicationEvidence,
  loadPublicationLedger,
  publicationBindingForRecord,
  validatePublicationLedger,
} = require("../src/services/recommendationPublicationLedger.cjs");

const checks = [];
const check = (name, condition, details = {}) => {
  assert.ok(condition, name);
  checks.push({ name, ok: true, ...details });
};

function prediction({ pool = "HAD", tipCode = "1", line = 0, odds = 1.65 } = {}) {
  return {
    marketType: "BEST",
    oddsPoolCode: pool,
    ...(pool === "HHAD" ? { handicapLine: line } : {}),
    tipCode,
    tipLabel: { zh: tipCode, en: tipCode },
    odds,
    trustScore: 72,
    recommendationAction: "recommend",
    recommendationTier: "multi-factor",
    resultStatus: "PENDING",
    multiFactorEvidence: {
      version: "multi-factor-market-evidence-v2",
      eligible: true,
      market: pool,
      code: tipCode,
      handicapLine: pool === "HHAD" ? line : 0,
      odds,
      blockers: [],
    },
  };
}

function finishedMatch(id, selection, scoreHome = 1, scoreAway = 0, extra = {}) {
  return {
    id: `sporttery_${id}`,
    sourceMatchId: id,
    matchNo: id,
    source: "sporttery",
    status: "FINISHED",
    scoreHome,
    scoreAway,
    resultProvenance: {
      provider: "sporttery",
      official: true,
      trusted: true,
      scoreHome,
      scoreAway,
    },
    kickoffTime: "2026-07-12T10:00:00+08:00",
    buyEndTime: "2026-07-12T09:30:00+08:00",
    homeTeamName: `Home ${id}`,
    awayTeamName: `Away ${id}`,
    odds: { odds1: 1.65, oddsX: 3.2, odds2: 5.1 },
    handicapLine: selection.oddsPoolCode === "HHAD" ? selection.handicapLine : undefined,
    handicapOdds: selection.oddsPoolCode === "HHAD"
      ? { odds1: 2.8, oddsX: 3.4, odds2: selection.odds }
      : undefined,
    predictionMeta: {
      cutoffTime: "2026-07-12T09:30:00+08:00",
      sourceCycleId: "cycle-first-result",
      datasetRevision: "dataset-r1",
    },
    predictions: [selection],
    ...extra,
  };
}

function publish(match, selection, ledger = emptyPublicationLedger()) {
  const strategyVersion = "publication-ledger-test-strategy-v1";
  const appended = appendPublicationRecord(ledger, {
    publishedAt: "2026-07-12T08:30:00+08:00",
    cutoffTime: match.predictionMeta.cutoffTime,
    matchId: match.id,
    sourceMatchId: match.sourceMatchId,
    selectionRole: selection.marketType,
    marketType: selection.oddsPoolCode,
    tipCode: selection.tipCode,
    handicapLine: selection.oddsPoolCode === "HHAD" ? selection.handicapLine : 0,
    odds: selection.odds,
    strategyVersion,
    strategyHash: hashPublicationEvidence({ strategyVersion }),
    evidenceHash: hashPublicationEvidence(selection.multiFactorEvidence),
    featureHash: hashPublicationEvidence({ matchId: match.id, cutoffTime: match.predictionMeta.cutoffTime }),
  });
  const boundPrediction = {
    ...selection,
    publicationId: appended.record.publicationId,
    publicationEvidence: publicationBindingForRecord(appended.record),
  };
  return {
    ledger: appended.ledger,
    record: appended.record,
    prediction: boundPrediction,
    match: { ...match, predictions: [boundPrediction] },
    index: buildPublicationLedgerIndex(appended.ledger),
  };
}

function actuals(scoreHome = 1, scoreAway = 0, handicapLine = null) {
  return {
    scoreHome,
    scoreAway,
    had: scoreHome > scoreAway ? "1" : scoreHome < scoreAway ? "2" : "X",
    hhad: handicapLine === null ? null : "2",
    overUnder25: scoreHome + scoreAway > 2.5 ? "O2.5" : "U2.5",
    btts: scoreHome > 0 && scoreAway > 0 ? "GG" : "NG",
  };
}

function withResultObservation(match, observedAt) {
  return {
    ...match,
    resultObservedAt: observedAt,
    resultObservationSource: "sporttery:result",
    resultObservationFallback: false,
    resultProvenance: {
      ...match.resultProvenance,
      observedAt,
      observationSource: "sporttery:result",
      resultObservationFallback: false,
    },
  };
}

function referenceSnapshotFor(match) {
  const selection = match.predictions[0];
  return {
    sourceMatchId: match.sourceMatchId,
    matchId: match.id,
    phase: "locked",
    capturedAt: "2026-07-12T08:30:00+08:00",
    cutoffTime: match.buyEndTime,
    kickoffTime: match.kickoffTime,
    signature: `BEST:${selection.oddsPoolCode}:${selection.tipCode}:reference`,
    best: {
      tipCode: selection.tipCode,
      tipLabel: selection.tipLabel,
      oddsPoolCode: selection.oddsPoolCode,
      handicapLine: selection.handicapLine ?? null,
      odds: selection.odds,
      trustScore: selection.trustScore,
      recommendationAction: "reference",
      recommendationTier: "reference",
    },
  };
}

function scheduledFormalPublicationFixture(id, overrides = {}) {
  const capturedAt = "2026-07-16T08:00:00+08:00";
  const selection = {
    ...prediction({ odds: 2.1 }),
    recommendationAction: overrides.recommendationAction || "recommend",
    recommendationTier: "multi-factor-a",
    multiFactorEvidence: {
      version: "multi-factor-market-evidence-v2",
      eligible: true,
      grade: "A",
      evidenceScore: 68,
      market: "HAD",
      code: "1",
      handicapLine: "0",
      odds: 2.1,
      modelProbability: 0.58,
      marketProbability: 0.46,
      modelGap: 0.12,
      probabilityEdge: 0.12,
      expectedValue: 0.218,
      dataQuality: 0.8,
      supportingFactors: [
        "independent-model-probability",
        "model-separation",
        "model-market-edge",
        "positive-expected-value",
        "score-matrix-alignment",
        "official-market-source",
        "fresh-official-sp",
      ],
      blockers: [],
      diagnostics: { severeMissingCount: 0 },
    },
  };
  const match = {
    id: `sporttery_${id}`,
    sourceMatchId: id,
    source: overrides.source || "sporttery",
    status: "SCHEDULED",
    kickoffTime: "2026-07-16T10:00:00+08:00",
    buyEndTime: "2026-07-16T09:00:00+08:00",
    predictionMeta: {
      cutoffTime: "2026-07-16T09:00:00+08:00",
      policyVersion: "publication-ledger-sync-test-v1",
      strategyVersion: "publication-ledger-sync-strategy-v1",
      sourceCycleId: `cycle-${id}`,
    },
    odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
    oddsSource: "sporttery:HAD",
    oddsPoolCode: "HAD",
    oddsObservedAt: "2026-07-16T07:58:00+08:00",
    oddsReceivedAt: "2026-07-16T07:59:00+08:00",
    oddsSourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001",
    probabilityModel: {
      version: "publication-ledger-model-v1",
      generatedAt: "2026-07-16T07:59:30+08:00",
      oneXTwo: { final: { home: 58, draw: 24, away: 18 } },
      unifiedPosterior: {
        version: "publication-ledger-posterior-v1",
        generatedAt: "2026-07-16T07:59:40+08:00",
        selectedMarket: "HAD",
        selectedCode: "1",
      },
    },
    predictions: [selection],
  };
  return finalizeLiveRecommendationPublications([match], capturedAt)[0];
}

function run() {
  const empty = emptyPublicationLedger();
  const emptyValidation = validatePublicationLedger(empty);
  check("an empty ledger is valid and contains no formal publication", empty.version === PUBLICATION_LEDGER_VERSION
    && emptyValidation.valid
    && emptyValidation.rows === 0
    && buildPublicationLedgerIndex(empty).rows === 0);

  const missingFile = path.join(os.tmpdir(), `football-publication-ledger-missing-${process.pid}-${Date.now()}.json`);
  const missingLoad = loadPublicationLedger(missingFile);
  check("loading a missing ledger is read-only and fail-closed empty", missingLoad.missing
    && missingLoad.validation.valid
    && missingLoad.payload.rows.length === 0
    && !fs.existsSync(missingFile));

  const syncDataSource = fs.readFileSync(path.join(__dirname, "syncData.cjs"), "utf8");
  const liveFinalizationIndex = syncDataSource.indexOf(
    "output = finalizeLiveRecommendationPublications(output, capturedAt);"
  );
  const publicationCommitIndex = syncDataSource.indexOf(
    "const publicationLedgerCommit = commitRecommendationPublicationLedger("
  );
  const publicSnapshotIndex = syncDataSource.indexOf(
    "const predictionSnapshotsPayload = appendPredictionSnapshots("
  );
  const prospectiveObservationIndex = syncDataSource.indexOf(
    "{ observationMatches: prospectiveAuditMatches },",
    publicSnapshotIndex
  );
  check("production sync commits the ledger after live finalization and before every public snapshot",
    liveFinalizationIndex >= 0
    && publicationCommitIndex > liveFinalizationIndex
    && publicSnapshotIndex > publicationCommitIndex
    && prospectiveObservationIndex > publicSnapshotIndex);

  const productionCommitDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-publication-commit-"));
  const productionLedgerFile = path.join(productionCommitDir, "recommendation-publication-ledger.json");
  const firstScheduled = scheduledFormalPublicationFixture("ledger-sync-first");
  const firstCommit = commitRecommendationPublicationLedger(
    [firstScheduled],
    "2026-07-16T08:00:00+08:00",
    { ledgerPath: productionLedgerFile }
  );
  const firstBoundBest = firstCommit.matches[0].predictions[0];
  const firstPersistedLedger = loadPublicationLedger(productionLedgerFile);
  check("production sync atomically appends the first strict live BEST before exposing its binding",
    firstCommit.summary.status === "committed"
    && firstCommit.summary.appended === 1
    && firstPersistedLedger.validation.valid
    && firstPersistedLedger.payload.rows.length === 1
    && firstBoundBest.publicationId === firstPersistedLedger.payload.rows[0].publicationId
    && firstBoundBest.publicationEvidence?.recordHash === firstPersistedLedger.payload.rows[0].recordHash);

  const repeatedCommit = commitRecommendationPublicationLedger(
    firstCommit.matches,
    "2026-07-16T08:01:00+08:00",
    { ledgerPath: productionLedgerFile }
  );
  const repeatedLedger = loadPublicationLedger(productionLedgerFile);
  check("repeated production sync reuses the same immutable publication without a second row",
    repeatedCommit.summary.status === "reused"
    && repeatedCommit.summary.appended === 0
    && repeatedCommit.summary.reused === 1
    && repeatedLedger.payload.rows.length === 1
    && repeatedCommit.matches[0].predictions[0].publicationId === firstBoundBest.publicationId);

  const afterCutoffFile = path.join(productionCommitDir, "after-cutoff.json");
  const afterCutoffCommit = commitRecommendationPublicationLedger(
    [scheduledFormalPublicationFixture("ledger-sync-after-cutoff")],
    "2026-07-16T09:01:00+08:00",
    { ledgerPath: afterCutoffFile }
  );
  check("a scheduled candidate cannot be backfilled after the sale cutoff",
    afterCutoffCommit.summary.appended === 0
    && !afterCutoffCommit.matches[0].predictions[0].publicationId
    && !fs.existsSync(afterCutoffFile));

  const referenceFile = path.join(productionCommitDir, "reference.json");
  const referenceCommit = commitRecommendationPublicationLedger(
    [scheduledFormalPublicationFixture("ledger-sync-reference", { recommendationAction: "reference" })],
    "2026-07-16T08:00:00+08:00",
    { ledgerPath: referenceFile }
  );
  check("a market/reference BEST never enters the formal publication ledger",
    referenceCommit.summary.appended === 0
    && !referenceCommit.matches[0].predictions[0].publicationId
    && !fs.existsSync(referenceFile));

  const fiveHundredFile = path.join(productionCommitDir, "fivehundred.json");
  const fiveHundredCommit = commitRecommendationPublicationLedger(
    [scheduledFormalPublicationFixture("ledger-sync-fivehundred", { source: "fivehundred" })],
    "2026-07-16T08:00:00+08:00",
    { ledgerPath: fiveHundredFile }
  );
  check("a 500 source row cannot manufacture a formal publication",
    fiveHundredCommit.summary.appended === 0
    && !fiveHundredCommit.matches[0].predictions[0].publicationId
    && !fs.existsSync(fiveHundredFile));

  const failedWriteFile = path.join(productionCommitDir, "write-failure.json");
  const failedWriteCommit = commitRecommendationPublicationLedger(
    [scheduledFormalPublicationFixture("ledger-sync-write-failure")],
    "2026-07-16T08:00:00+08:00",
    {
      ledgerPath: failedWriteFile,
      persistLedger: () => {
        const error = new Error("injected ledger write failure");
        error.code = "INJECTED_LEDGER_WRITE_FAILURE";
        throw error;
      },
    }
  );
  check("a ledger write failure fails closed and never exposes an unpersisted binding",
    failedWriteCommit.summary.status === "write-failed-closed"
    && failedWriteCommit.summary.staged === 1
    && failedWriteCommit.summary.appended === 0
    && failedWriteCommit.summary.errors.includes("INJECTED_LEDGER_WRITE_FAILURE")
    && !failedWriteCommit.matches[0].predictions[0].publicationId
    && !fs.existsSync(failedWriteFile));

  const invalidLedgerFile = path.join(productionCommitDir, "invalid-ledger.json");
  fs.writeFileSync(invalidLedgerFile, "{\"version\":\"tampered\",\"rows\":[]}\n", "utf8");
  const invalidLedgerCommit = commitRecommendationPublicationLedger(
    [scheduledFormalPublicationFixture("ledger-sync-invalid-ledger")],
    "2026-07-16T08:00:00+08:00",
    { ledgerPath: invalidLedgerFile }
  );
  check("an invalid ledger fails closed without replacement or public binding",
    invalidLedgerCommit.summary.status === "invalid-ledger-fail-closed"
    && invalidLedgerCommit.summary.appended === 0
    && !invalidLedgerCommit.matches[0].predictions[0].publicationId
    && fs.readFileSync(invalidLedgerFile, "utf8").includes("\"tampered\""));
  fs.rmSync(productionCommitDir, { recursive: true, force: true });

  const baseSelection = prediction();
  const baseMatch = finishedMatch("ledger-base", baseSelection);
  const publication = publish(baseMatch, baseSelection);
  check("publication contract freezes market direction line SP time cutoff and provenance hashes",
    publication.record.version === PUBLICATION_RECORD_VERSION
    && publication.record.selectionRole === "BEST"
    && publication.record.marketType === "HAD"
    && publication.record.tipCode === "1"
    && publication.record.handicapLine === "0"
    && publication.record.odds === 1.65
    && publication.record.publishedAt === "2026-07-12T00:30:00.000Z"
    && publication.record.cutoffTime === "2026-07-12T01:30:00.000Z"
    && publication.record.strategyHash.length === 64
    && publication.record.evidenceHash.length === 64
    && publication.record.featureHash.length === 64
    && publication.record.recordHash.length === 64
    && Object.keys(publication.record).sort().join("|") === [...RECORD_FIELDS].sort().join("|"));
  check("prediction binding points at the immutable ledger hash", publication.prediction.publicationEvidence.version === PUBLICATION_BINDING_VERSION
    && publication.prediction.publicationEvidence.recordHash === publication.record.recordHash);

  const unboundRows = buildPredictionReviewRows(baseMatch, actuals());
  check("computed recommend action without a ledger publication is always reference", unboundRows.length === 1
    && unboundRows[0].reviewRole === "reference"
    && unboundRows[0].recommendationAction === "reference"
    && unboundRows[0].publicationId === null);

  const publishedRows = buildPredictionReviewRows(publication.match, actuals(), publication.index);
  check("only a valid publication id and exact immutable binding becomes main", publishedRows.length === 1
    && publishedRows[0].reviewRole === "main"
    && publishedRows[0].recommendationAction === "recommend"
    && publishedRows[0].publicationId === publication.record.publicationId);

  const forgedIdMatch = {
    ...baseMatch,
    predictions: [{ ...baseSelection, publicationId: publication.record.publicationId }],
  };
  const forgedIdRows = buildPredictionReviewRows(forgedIdMatch, actuals(), publication.index);
  check("a copied publication id without the immutable binding is rejected", forgedIdRows[0].reviewRole === "reference");

  const tamperedOddsMatch = {
    ...publication.match,
    predictions: [{ ...publication.prediction, odds: 1.66 }],
  };
  const tamperedDirectionMatch = {
    ...publication.match,
    predictions: [{ ...publication.prediction, tipCode: "2" }],
  };
  check("post-publication SP or direction mutation cannot settle as main",
    buildPredictionReviewRows(tamperedOddsMatch, actuals(), publication.index)[0].reviewRole === "reference"
    && buildPredictionReviewRows(tamperedDirectionMatch, actuals(), publication.index)[0].reviewRole === "reference");

  const hhadSelection = prediction({ pool: "HHAD", tipCode: "2", line: -1, odds: 1.65 });
  const hhadMatch = finishedMatch("ledger-hhad", hhadSelection, 0, 1);
  const hhadPublication = publish(hhadMatch, hhadSelection);
  const changedLineMatch = {
    ...hhadPublication.match,
    handicapLine: -2,
    predictions: [{ ...hhadPublication.prediction, handicapLine: -2 }],
  };
  check("post-publication handicap mutation cannot settle as main",
    buildPredictionReviewRows(changedLineMatch, actuals(0, 1, -2), hhadPublication.index)[0].reviewRole === "reference");

  const tamperedLedger = structuredClone(publication.ledger);
  tamperedLedger.rows[0].odds = 1.7;
  const tamperedIndex = buildPublicationLedgerIndex(tamperedLedger);
  check("any broken record hash invalidates the whole ledger index", !tamperedIndex.valid
    && tamperedIndex.rows === 0
    && tamperedIndex.errors.some((error) => error.includes("record-hash-mismatch")));

  const untrustedFinal = {
    ...baseMatch,
    resultProvenance: { provider: "fallback", official: false, trusted: false },
  };
  const negativeScoreFinal = {
    ...baseMatch,
    scoreHome: -1,
    resultProvenance: { provider: "sporttery", official: true, trusted: true },
  };
  const weakProvenanceFinal = {
    ...baseMatch,
    resultProvenance: { provider: "sporttery", official: true },
  };
  const untrustedAudit = attachResultAuditTimestamps(untrustedFinal, null, "2026-07-12T12:00:00.000Z");
  check("untrusted or invalid FINISHED rows cannot receive settlement timestamps or reviews",
    untrustedAudit.resultObservedAt === undefined
    && untrustedAudit.settledAt === undefined
    && buildPostMatchReview(untrustedFinal, "2026-07-12T12:00:00.000Z") === null
    && buildPostMatchReview(weakProvenanceFinal, "2026-07-12T12:00:00.000Z") === null
    && buildPostMatchReview(negativeScoreFinal, "2026-07-12T12:00:00.000Z") === null);

  const rawOfficialFinal = {
    ...baseMatch,
    resultProvenance: undefined,
    sourceUrl: "https://webapi.sporttery.cn/gateway/result",
  };
  const resolvedOfficialReview = buildPostMatchReview(rawOfficialFinal, "2026-07-12T12:00:00.000Z");
  check("an official raw final is reviewable but cannot synthesize an observation clock",
    resolvedOfficialReview?.settlement?.resultObservedAt === null
    && resolvedOfficialReview?.settlement?.resultObservationSource === null
    && resolvedOfficialReview?.settlement?.resultObservationFallback === true
    && resolvedOfficialReview?.settlement?.reviewGeneratedAt === "2026-07-12T12:00:00.000Z"
    && resolvedOfficialReview?.predictionReview?.mainSettled === 0);

  const screenshotMatches = [
    finishedMatch("screenshot-1", prediction({ tipCode: "1" }), 1, 0),
    finishedMatch("screenshot-2", prediction({ tipCode: "X" }), 0, 0),
    finishedMatch("screenshot-3", prediction({ tipCode: "1" }), 0, 1),
  ];
  const screenshotReview = attachPostMatchReviews(screenshotMatches, "2026-07-12T12:00:00.000Z");
  check("unsnapshotted screenshot-style directions never enter any performance denominator",
    screenshotReview.payload.summary.bestWon === 0
    && screenshotReview.payload.summary.bestLost === 0
    && screenshotReview.payload.summary.referenceBestWon === 0
    && screenshotReview.payload.summary.referenceBestLost === 0
    && screenshotReview.payload.rows.every((review) => (
      review.predictionReview.mainSettled === 0
      && review.predictionReview.referenceSettled === 0
      && review.predictionReview.rows.length === 0
    )));

  const firstObservedAt = "2026-07-12T12:01:00.000Z";
  const laterObservedAt = "2026-07-12T12:09:00.000Z";
  const firstPublishedReview = attachPostMatchReviews(
    [withResultObservation(publication.match, firstObservedAt)],
    firstObservedAt,
    null,
    publication.index
  );
  const firstReviewedMatch = firstPublishedReview.matches[0];
  const secondPublishedReview = attachPostMatchReviews(
    [firstReviewedMatch],
    laterObservedAt,
    null,
    publication.index
  );
  const firstSettlement = firstReviewedMatch.postMatchReview.settlement;
  const secondSettlement = secondPublishedReview.matches[0].postMatchReview.settlement;
  check("repeated finished sync preserves first result and settlement timestamps", firstSettlement.resultObservedAt === firstObservedAt
    && firstSettlement.settledAt === firstObservedAt
    && secondSettlement.resultObservedAt === firstObservedAt
    && secondSettlement.settledAt === firstObservedAt
    && secondSettlement.reviewGeneratedAt === firstSettlement.reviewGeneratedAt
    && secondSettlement.resultRevision === 1
    && secondSettlement.publicationId === publication.record.publicationId
    && secondSettlement.publicationVerified === true);

  const ledgerTemporarilyUnavailable = attachPostMatchReviews(
    [{ ...firstReviewedMatch, predictions: [] }],
    "2026-07-12T12:10:00.000Z",
    null,
    buildPublicationLedgerIndex(emptyPublicationLedger())
  ).matches[0];
  const preservedVerifiedRow = ledgerTemporarilyUnavailable.postMatchReview.predictionReview.rows[0];
  check("a previously verified formal settlement survives temporary ledger unavailability", (
    preservedVerifiedRow.reviewRole === "main"
    && preservedVerifiedRow.recommendationAction === "recommend"
    && preservedVerifiedRow.publicationId === publication.record.publicationId
    && preservedVerifiedRow.publicationEvidence?.recordHash === publication.record.recordHash
    && ledgerTemporarilyUnavailable.postMatchReview.predictionReview.mainSettled === 1
    && ledgerTemporarilyUnavailable.postMatchReview.settlement.publicationVerified === true
  ));

  const postMatchPredictionDrift = attachPostMatchReviews(
    [{
      ...firstReviewedMatch,
      predictions: [prediction({
        tipCode: publication.match.predictions[0].tipCode === "1" ? "2" : "1",
        odds: 8.88,
      })],
    }],
    "2026-07-12T12:10:15.000Z",
    null,
    buildPublicationLedgerIndex(emptyPublicationLedger())
  ).matches[0];
  const driftProtectedRow = postMatchPredictionDrift.postMatchReview.predictionReview.rows[0];
  check("post-match mutable predictions cannot replace an already verified formal settlement", (
    driftProtectedRow.tipCode === publication.match.predictions[0].tipCode
    && driftProtectedRow.odds === publication.match.predictions[0].odds
    && driftProtectedRow.reviewRole === "main"
    && driftProtectedRow.publicationId === publication.record.publicationId
    && postMatchPredictionDrift.postMatchReview.settlement.publicationVerified === true
  ));

  const previouslyDowngradedReview = structuredClone(firstReviewedMatch.postMatchReview);
  previouslyDowngradedReview.settlement.publicationVerified = false;
  previouslyDowngradedReview.predictionReview.rows = previouslyDowngradedReview.predictionReview.rows.map((row) => ({
    ...row,
    recommendationAction: "reference",
    reviewRole: "reference",
    publicationId: null,
    publicationEvidence: null,
  }));
  previouslyDowngradedReview.predictionReview.settled = 0;
  previouslyDowngradedReview.predictionReview.won = 0;
  previouslyDowngradedReview.predictionReview.mainSettled = 0;
  previouslyDowngradedReview.predictionReview.mainWon = 0;
  previouslyDowngradedReview.predictionReview.bestStatus = null;
  previouslyDowngradedReview.predictionReview.formalBestStatus = null;
  previouslyDowngradedReview.predictionReview.bestRole = "reference";
  const repairedDowngrade = attachPostMatchReviews(
    [{ ...firstReviewedMatch, predictions: [], postMatchReview: previouslyDowngradedReview }],
    "2026-07-12T12:10:30.000Z",
    null,
    publication.index
  ).matches[0];
  check("an old temporary-ledger downgrade is restored only from its locked exact publication record", (
    repairedDowngrade.postMatchReview.predictionReview.mainSettled === 1
    && repairedDowngrade.postMatchReview.predictionReview.rows[0].reviewRole === "main"
    && repairedDowngrade.postMatchReview.predictionReview.rows[0].publicationId === publication.record.publicationId
    && repairedDowngrade.postMatchReview.settlement.publicationVerified === true
  ));

  const correctedVerified = attachPostMatchReviews(
    [{
      ...ledgerTemporarilyUnavailable,
      scoreHome: 0,
      scoreAway: 1,
      resultUpdatedAt: "2026-07-12T12:11:00.000Z",
      resultProvenance: {
        ...ledgerTemporarilyUnavailable.resultProvenance,
        scoreHome: 0,
        scoreAway: 1,
        observedAt: "2026-07-12T12:11:00.000Z",
      },
    }],
    "2026-07-12T12:11:00.000Z",
    null,
    buildPublicationLedgerIndex(emptyPublicationLedger()),
    { officialScoreCorrection: true }
  ).matches[0];
  check("official score correction recomputes a locked formal outcome without changing its publication role", (
    correctedVerified.postMatchReview.finalScore === "0-1"
    && correctedVerified.postMatchReview.predictionReview.formalBestStatus === "LOST"
    && correctedVerified.postMatchReview.predictionReview.rows[0].reviewRole === "main"
    && correctedVerified.postMatchReview.settlement.resultRevision === 2
    && correctedVerified.postMatchReview.settlement.resultObservedAt === firstObservedAt
    && correctedVerified.postMatchReview.settlement.publicationVerified === true
  ));

  const helperFirst = attachResultAuditTimestamps(withResultObservation(publication.match, firstObservedAt), null);
  const helperSecond = attachResultAuditTimestamps({ ...publication.match }, helperFirst, laterObservedAt);
  check("exported result audit helper is idempotent", helperFirst.resultObservedAt === firstObservedAt
    && helperFirst.settledAt === firstObservedAt
    && helperSecond.resultObservedAt === firstObservedAt
    && helperSecond.settledAt === firstObservedAt);

  const baseReferenceSnapshot = referenceSnapshotFor(baseMatch);
  const initialReference = attachPostMatchReviews(
    [withResultObservation(baseMatch, firstObservedAt)],
    firstObservedAt,
    { rows: [baseReferenceSnapshot] }
  );
  const lateBoundMatch = {
    ...publication.match,
    postMatchReview: initialReference.matches[0].postMatchReview,
  };
  const lateBoundReview = buildPostMatchReview(
    lateBoundMatch,
    laterObservedAt,
    new Map([[baseMatch.sourceMatchId, [baseReferenceSnapshot]]]),
    publication.index
  );
  check("an already-settled legacy/reference row cannot be backfilled into a formal recommendation",
    lateBoundReview.predictionReview.mainSettled === 0
    && lateBoundReview.predictionReview.formalBestStatus === null
    && lateBoundReview.predictionReview.referenceBestStatus === "WON"
    && lateBoundReview.settlement.publicationId === null
    && lateBoundReview.settlement.resultObservedAt === firstObservedAt);

  console.log(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    summary: { total: checks.length, passed: checks.length, failed: 0 },
    checks,
  }, null, 2));
}

run();
