const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_RECOVERY_PATH,
  loadArchivedPreMatchRecoveries,
  recoveryArchiveForMatch,
  validateRecoveryRow,
} = require("./archivedPreMatchRecovery.cjs");
const {
  attachArchivedPreMatchPredictions,
  buildPostMatchReview,
  validArchivedPreMatchPrediction,
} = require("./syncData.cjs");
const {
  applyOfficialClubResult,
} = require("./syncOfficialClubResults.cjs");

const manifest = JSON.parse(fs.readFileSync(DEFAULT_RECOVERY_PATH, "utf8"));
const recoveryIndex = loadArchivedPreMatchRecoveries(DEFAULT_RECOVERY_PATH);
assert.equal(recoveryIndex.size, 5);

const match = (sourceMatchId, overrides = {}) => ({
  id: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  status: "FINISHED",
  kickoffTime: "2026-07-28T01:00:00+08:00",
  eventVersion: "2026-07-28T01:00:00+08:00",
  buyEndTime: "2026-07-27T22:00:00+08:00",
  ...overrides,
});

const recoveredDraw = recoveryArchiveForMatch(match("2040641"), recoveryIndex);
const recoveredHome = recoveryArchiveForMatch(match("2040642"), recoveryIndex);
assert.equal(recoveredDraw?.prediction?.tipCode, "X");
assert.equal(recoveredDraw?.prediction?.odds, 3.4);
assert.equal(recoveredHome?.prediction?.tipCode, "1");
assert.equal(recoveredHome?.prediction?.odds, 1.48);
assert.ok(validArchivedPreMatchPrediction(match("2040641"), recoveredDraw));
assert.ok(validArchivedPreMatchPrediction(match("2040642"), recoveredHome));
const recoveredWithoutLegacyCutoff = recoveryArchiveForMatch(
  match("2040641", { buyEndTime: undefined, predictionMeta: undefined }),
  recoveryIndex
);
assert.equal(
  recoveredWithoutLegacyCutoff?.prediction?.tipCode,
  "X",
  "a signed cutoff in the recovery manifest must repair legacy rows that omitted their cutoff field"
);

const augustMatch = (sourceMatchId) => match(sourceMatchId, {
  kickoffTime: "2026-08-21T02:00:00+08:00",
  eventVersion: "2026-08-21T02:00:00+08:00",
  buyEndTime: "2026-08-20 22:00:00",
});
const recoveredPublishedHome = recoveryArchiveForMatch(
  augustMatch("2040934"),
  recoveryIndex
);
const recoveredModelOnlyHome = recoveryArchiveForMatch(
  augustMatch("2040949"),
  recoveryIndex
);
assert.equal(recoveredPublishedHome?.prediction?.tipCode, "1");
assert.equal(recoveredPublishedHome?.prediction?.odds, 10);
assert.equal(recoveredPublishedHome?.marketEvidenceScope, "result-pool");
assert.equal(recoveredPublishedHome?.recoveryEvidence?.previous?.direction, "X");
assert.equal(recoveredModelOnlyHome?.prediction?.tipCode, "1");
assert.equal(recoveredModelOnlyHome?.prediction?.odds, 0);
assert.equal(recoveredModelOnlyHome?.marketEvidenceScope, "model-only-reference");
assert.ok(validArchivedPreMatchPrediction(augustMatch("2040934"), recoveredPublishedHome));
assert.ok(validArchivedPreMatchPrediction(augustMatch("2040949"), recoveredModelOnlyHome));

const recoveredCorinthiansHome = recoveryArchiveForMatch(
  match("2040936", {
    kickoffTime: "2026-08-21T08:30:00+08:00",
    eventVersion: "2026-08-21T08:30:00+08:00",
    buyEndTime: "2026-08-20 22:00:00",
  }),
  recoveryIndex
);
assert.equal(recoveredCorinthiansHome?.prediction?.tipCode, "1");
assert.equal(recoveredCorinthiansHome?.prediction?.odds, 1.91);
assert.equal(recoveredCorinthiansHome?.recoveryEvidence?.previous?.direction, "X");
assert.ok(validArchivedPreMatchPrediction(
  match("2040936", {
    kickoffTime: "2026-08-21T08:30:00+08:00",
    eventVersion: "2026-08-21T08:30:00+08:00",
    buyEndTime: "2026-08-20 22:00:00",
  }),
  recoveredCorinthiansHome,
));

const tamperedModelOnly = structuredClone(manifest.rows.find((row) => (
  row.sourceMatchId === "2040949"
)));
tamperedModelOnly.marketEvidenceScope = "result-pool";
const tamperedModelOnlyValidation = validateRecoveryRow(tamperedModelOnly);
assert.equal(tamperedModelOnlyValidation.ok, false);
assert.ok(tamperedModelOnlyValidation.errors.includes("prediction-odds-invalid"));
assert.ok(tamperedModelOnlyValidation.errors.includes("integrity-sha256-mismatch"));

const wrongEvent = recoveryArchiveForMatch(
  match("2040641", {
    kickoffTime: "2026-08-01T01:00:00+08:00",
    eventVersion: "2026-08-01T01:00:00+08:00",
  }),
  recoveryIndex
);
assert.equal(wrongEvent, null, "a recovery row must never cross event versions");

const tampered = structuredClone(manifest.rows[0]);
tampered.prediction.tipCode = "1";
const tamperedValidation = validateRecoveryRow(tampered);
assert.equal(tamperedValidation.ok, false);
assert.ok(tamperedValidation.errors.includes("signature-selection-mismatch"));
assert.ok(tamperedValidation.errors.includes("integrity-sha256-mismatch"));

const invalidLegacyArchive = {
  ...recoveredDraw,
  capturedAt: "2026-07-27T22:01:00+08:00",
  prediction: {
    ...recoveredDraw.prediction,
    tipCode: "1",
    odds: 1.76,
  },
};
const [repaired] = attachArchivedPreMatchPredictions(
  [{ ...match("2040641"), archivedPreMatchPrediction: invalidLegacyArchive }],
  { rows: [] },
  null,
  "2026-07-29T01:00:00+08:00"
);
assert.equal(repaired.archivedPreMatchPrediction?.prediction?.tipCode, "X");
assert.equal(repaired.archivedPreMatchPrediction?.capturedAt, "2026-07-27T07:22:33.229Z");
assert.equal(
  repaired.archivedPreMatchPrediction?.recoveryEvidence?.integritySha256,
  manifest.rows[0].integritySha256
);

const structurallyValidButKnownWrongLegacyArchive = {
  ...recoveredDraw,
  capturedAt: "2026-07-27T15:30:00+08:00",
  prediction: {
    ...recoveredDraw.prediction,
    tipCode: "1",
    odds: 1.76,
  },
};
assert.ok(
  validArchivedPreMatchPrediction(
    match("2040641"),
    structurallyValidButKnownWrongLegacyArchive
  ),
  "the regression fixture must reproduce a structurally valid legacy archive"
);
const [correctedKnownLegacy] = attachArchivedPreMatchPredictions(
  [{
    ...match("2040641"),
    archivedPreMatchPrediction: structurallyValidButKnownWrongLegacyArchive,
  }],
  { rows: [] },
  null,
  "2026-07-29T01:00:00+08:00"
);
assert.equal(
  correctedKnownLegacy.archivedPreMatchPrediction?.prediction?.tipCode,
  "X",
  "the signed recovery must override a known wrong legacy archive even when its clocks are valid"
);
assert.equal(
  correctedKnownLegacy.archivedPreMatchPrediction?.recoveryEvidence?.integritySha256,
  manifest.rows[0].integritySha256
);

const unrelatedInvalid = {
  ...match("9999999"),
  archivedPreMatchPrediction: invalidLegacyArchive,
};
const [stripped] = attachArchivedPreMatchPredictions(
  [unrelatedInvalid],
  { rows: [] },
  null,
  "2026-07-29T01:00:00+08:00"
);
assert.equal(
  Object.hasOwn(stripped, "archivedPreMatchPrediction"),
  false,
  "an unrecoverable post-cutoff archive must fail closed"
);

// Recovery behavior must not depend on an untracked generated local cache.
// These explicit offline HTML parser fixtures are not production evidence.
const { syntheticStore: officialClubResults } = require("./verifyOfficialClubResults.cjs");
const priorWrongReview = (tipCode, odds) => ({
  version: "post-match-review-v2",
  generatedAt: "2026-07-28T23:43:57.782Z",
  settlement: {
    version: "recommendation-settlement-v1",
    resultObservedAt: "2026-07-28T23:42:03.199Z",
    resultObservationSource: "official-club-page-response-received-at",
    resultObservationFallback: false,
  },
  predictionReview: {
    rows: [{
      marketType: "BEST",
      oddsPoolCode: "HAD",
      tipCode,
      tipLabel: { zh: tipCode, en: tipCode },
      odds,
      resultStatus: "LOST",
      recommendationAction: "reference",
      recommendationTier: "reference",
      performanceTrack: "reference",
      reviewRole: "reference",
    }],
  },
});
const recoveredReviews = [
  {
    sourceMatchId: "2040641",
    scoreHome: 0,
    scoreAway: 0,
    expectedTip: "X",
    invalidTip: "1",
    invalidOdds: 1.76,
    homeTeamName: "赫根",
    awayTeamName: "索尔纳",
  },
  {
    sourceMatchId: "2040642",
    scoreHome: 4,
    scoreAway: 0,
    expectedTip: "1",
    invalidTip: "X",
    invalidOdds: 4.4,
    homeTeamName: "罗森博格",
    awayTeamName: "腓特烈",
  },
].map((fixture) => {
  const resultMatch = applyOfficialClubResult({
    ...match(fixture.sourceMatchId, {
      status: "PENDING_RESULT",
      homeTeamName: fixture.homeTeamName,
      awayTeamName: fixture.awayTeamName,
      handicapLine: "-1",
      predictions: [],
      archivedPreMatchPrediction: {
        ...recoveryIndex.get(fixture.sourceMatchId),
        version: "archived-pre-match-prediction-v1",
        source: "immutable-pre-match-prediction-snapshot",
        capturedAt: "2026-07-27T22:01:00+08:00",
        prediction: {
          marketType: "BEST",
          oddsPoolCode: "HAD",
          tipCode: fixture.invalidTip,
          odds: fixture.invalidOdds,
        },
      },
      postMatchReview: priorWrongReview(fixture.invalidTip, fixture.invalidOdds),
    })},
    officialClubResults
  );
  assert.equal(resultMatch.scoreHome, fixture.scoreHome);
  assert.equal(resultMatch.scoreAway, fixture.scoreAway);
  const [recoveredMatch] = attachArchivedPreMatchPredictions(
    [resultMatch],
    { rows: [] },
    null,
    "2026-07-29T01:00:00+08:00"
  );
  const review = buildPostMatchReview(
    recoveredMatch,
    "2026-07-29T01:00:00+08:00",
    new Map(),
    null
  );
  const best = review?.predictionReview?.rows?.find((row) => row.marketType === "BEST");
  assert.equal(best?.tipCode, fixture.expectedTip);
  assert.equal(best?.resultStatus, "WON");
  assert.equal(review?.predictionReview?.referenceBestStatus, "WON");
  return {
    sourceMatchId: fixture.sourceMatchId,
    tipCode: best.tipCode,
    resultStatus: best.resultStatus,
  };
});

console.log(JSON.stringify({
  ok: true,
  verifier: "archived-pre-match-recovery-v1",
  recovered: [
    { sourceMatchId: "2040641", tipCode: recoveredDraw.prediction.tipCode, odds: recoveredDraw.prediction.odds },
    { sourceMatchId: "2040642", tipCode: recoveredHome.prediction.tipCode, odds: recoveredHome.prediction.odds },
    { sourceMatchId: "2040934", tipCode: recoveredPublishedHome.prediction.tipCode, odds: recoveredPublishedHome.prediction.odds },
    { sourceMatchId: "2040949", tipCode: recoveredModelOnlyHome.prediction.tipCode, odds: recoveredModelOnlyHome.prediction.odds },
    { sourceMatchId: "2040936", tipCode: recoveredCorinthiansHome.prediction.tipCode, odds: recoveredCorinthiansHome.prediction.odds },
  ],
  tamperRejected: true,
  invalidLegacyArchiveStripped: true,
  knownWrongLegacyArchiveCorrected: true,
  recoveredReviews,
  syntheticResultInputs: true,
  manifest: path.relative(process.cwd(), DEFAULT_RECOVERY_PATH).replaceAll("\\", "/"),
}, null, 2));
