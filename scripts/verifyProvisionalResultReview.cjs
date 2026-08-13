const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  applyExternalResultSignal,
  attachArchivedPreMatchPredictions,
  attachExternalSignals,
  buildFiveHundredFallbackMatches,
  buildModelCalibration,
  buildPredictionHealth,
  buildProvisionalResultReviews,
} = require("./syncData.cjs");

const observedAt = new Date().toISOString();
const kickoffTime = new Date(Date.parse(observedAt) - 3 * 60 * 60 * 1000).toISOString();
const capturedAt = observedAt;
const sourceMatchId = "provisional-500-1001";
const signal = {
  source: "500.com:jczq+500.com:details",
  sourceMatchId,
  kickoffTime,
  eventVersion: kickoffTime,
  homeTeamName: "Home Fixture",
  awayTeamName: "Away Fixture",
  leagueName: "Fixture League",
  matchNo: "Tuesday 201",
  bookmakerOdds: {
    had: { odds1: 1.8, oddsX: 3.4, odds2: 4.2 },
  },
  fiveHundred: {
    result: {
      source: "500.com:jczq-result",
      status: "FINISHED",
      scoreHome: 0,
      scoreAway: 1,
      sourceObservedAt: observedAt,
      observationSource: "500.com-response-received-at",
      resultObservationFallback: true,
      eventVersion: kickoffTime,
    },
  },
};
const externalSignals = {
  version: 1,
  source: "external-signals",
  updatedAt: observedAt,
  matches: { [sourceMatchId]: signal },
};

const fallbackRows = buildFiveHundredFallbackMatches(externalSignals);
assert.equal(fallbackRows.length, 1, "the exact 500 result creates one fallback fixture carrier");
assert.equal(fallbackRows[0].status, "PENDING_RESULT", "a 500 score never becomes canonical FINISHED");
assert.equal(fallbackRows[0].scoreHome, undefined, "the provisional score never occupies the official score fields");
assert.equal(fallbackRows[0].scoreAway, undefined);
assert.equal(fallbackRows[0].provisionalResult.scoreHome, 0);
assert.equal(fallbackRows[0].provisionalResult.scoreAway, 1);
assert.equal(fallbackRows[0].provisionalResult.official, false);
assert.equal(fallbackRows[0].provisionalResult.trusted, false);
assert.equal(fallbackRows[0].provisionalResult.promotionEligible, false);

const contaminatedPrediction = {
  marketType: "BEST",
  oddsPoolCode: "HAD",
  tipCode: "1",
  odds: 1.8,
  resultStatus: "LOST",
  recommendationAction: "recommend",
  recommendationTier: "multi-factor",
};
const pendingMatch = {
  id: `sporttery_${sourceMatchId}`,
  source: "sporttery",
  sourceMethod: "all",
  sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=all",
  sourceMatchId,
  kickoffTime,
  eventVersion: kickoffTime,
  status: "PENDING_RESULT",
  homeTeamName: signal.homeTeamName,
  awayTeamName: signal.awayTeamName,
  leagueName: signal.leagueName,
  matchNo: signal.matchNo,
  odds: { odds1: 1.8, oddsX: 3.4, odds2: 4.2 },
  oddsSource: "sporttery:HAD",
  handicapLine: "0",
  externalSignals: signal,
  predictions: [contaminatedPrediction],
};
const sanitized = applyExternalResultSignal(pendingMatch);
assert.equal(sanitized.status, "PENDING_RESULT");
assert.equal(sanitized.scoreHome, undefined);
assert.equal(sanitized.scoreAway, undefined);
assert.equal(sanitized.predictions[0].resultStatus, "PENDING", "legacy fallback settlement is scrubbed");
assert.equal(sanitized.provisionalResult.statisticsTrack, "shadow-provisional");

const stalePrefixedAlias = {
  ...signal,
  updatedAt: new Date(Date.parse(observedAt) - 24 * 60 * 60 * 1000).toISOString(),
  fiveHundred: {
    ...(signal.fiveHundred || {}),
  },
};
delete stalePrefixedAlias.fiveHundred.result;
const canonicalAliasAttached = attachExternalSignals(
  [{ ...pendingMatch, externalSignals: undefined }],
  {
    ...externalSignals,
    matches: {
      [`sporttery_${sourceMatchId}`]: stalePrefixedAlias,
      [sourceMatchId]: signal,
    },
  }
)[0];
assert.deepEqual(
  canonicalAliasAttached.externalSignals.fiveHundred.result,
  signal.fiveHundred.result,
  "a stale prefixed alias must not mask the canonical same-event 500 result"
);
assert.equal(
  applyExternalResultSignal(canonicalAliasAttached).provisionalResult.scoreAway,
  1,
  "the canonical result survives alias binding and opens the shadow result track"
);

const snapshotCapturedAt = new Date(Date.parse(kickoffTime) - 30 * 60 * 1000).toISOString();
const predictionSnapshots = {
  version: 3,
  rows: [{
    capturedAt: snapshotCapturedAt,
    phase: "locked",
    signature: "1X2:HAD:1:reference|BEST:HAD:1:recommend",
    sourceMatchId,
    matchId: pendingMatch.id,
    kickoffTime,
    cutoffTime: kickoffTime,
    homeTeamName: signal.homeTeamName,
    awayTeamName: signal.awayTeamName,
    oneXTwo: {
      tipCode: "1",
      oddsPoolCode: "HAD",
      odds: 1.8,
      recommendationAction: "reference",
    },
    best: {
      tipCode: "1",
      oddsPoolCode: "HAD",
      odds: 1.8,
      recommendationAction: "recommend",
      recommendationTier: "multi-factor",
    },
  }],
};
const shadowFeed = buildProvisionalResultReviews(
  [sanitized],
  predictionSnapshots,
  null,
  capturedAt
);
assert.equal(shadowFeed.rows.length, 1, "an exact same-event pre-match snapshot opens shadow review");
assert.equal(shadowFeed.summary.observedMatches, 1);
assert.equal(shadowFeed.summary.reviewableMatches, 1);
assert.equal(shadowFeed.summary.bestSettled, 1);
assert.equal(shadowFeed.summary.bestLost, 1);
assert.equal(shadowFeed.summary.shadowBestHitRate, 0);
assert.equal(shadowFeed.summary.formalSettled, 0);
assert.equal(shadowFeed.summary.officialMetricsEligible, false);
const bestShadow = shadowFeed.rows[0].predictionReview.rows.find((row) => row.marketType === "BEST");
assert.equal(bestShadow.resultStatus, "LOST");
assert.equal(bestShadow.performanceTrack, "shadow-provisional");
assert.equal(bestShadow.formalEligible, false);
assert.equal(bestShadow.officialMetricsEligible, false);
assert.equal(bestShadow.promotionEligible, false);
assert.equal(
  shadowFeed.predictionReplayPolicy.clientGeneratedFallbackDirectionReplayEligible,
  false,
  "a browser-generated fallback direction cannot be reconstructed as historical evidence"
);
const [archivedPendingMatch] = attachArchivedPreMatchPredictions(
  [sanitized],
  predictionSnapshots,
  null,
  capturedAt
);
assert.equal(
  archivedPendingMatch.archivedPreMatchPrediction.prediction.tipCode,
  "1",
  "result-phase UI archive must replay the immutable snapshot BEST"
);
assert.equal(
  archivedPendingMatch.archivedPreMatchPrediction.capturedAt,
  snapshotCapturedAt,
  "the published archive direction retains its exact pre-match capture clock"
);
assert.notEqual(
  archivedPendingMatch.archivedPreMatchPrediction.prediction,
  sanitized.predictions[0],
  "the archive object must not alias the mutable runtime prediction"
);

const stableArchivedMatch = {
  ...sanitized,
  archivedPreMatchPrediction: {
    ...archivedPendingMatch.archivedPreMatchPrediction,
    prediction: {
      ...archivedPendingMatch.archivedPreMatchPrediction.prediction,
      tipCode: "2",
      odds: 4.2,
    },
  },
};
const [stableArchiveAfterRebuild] = attachArchivedPreMatchPredictions(
  [stableArchivedMatch],
  predictionSnapshots,
  null,
  capturedAt
);
assert.equal(
  stableArchiveAfterRebuild.archivedPreMatchPrediction.prediction.tipCode,
  "2",
  "a valid existing result-phase archive cannot be rewritten by a shorter snapshot window"
);
const stableArchiveShadowFeed = buildProvisionalResultReviews(
  [stableArchiveAfterRebuild],
  predictionSnapshots,
  null,
  capturedAt
);
assert.equal(stableArchiveShadowFeed.summary.bestSettled, 1);
assert.equal(
  stableArchiveShadowFeed.summary.bestWon,
  1,
  "shadow settlement must score the preserved original archive rather than a recomputed BEST"
);
assert.equal(
  stableArchiveShadowFeed.rows[0].snapshotEvidence.immutableArchiveUsed,
  true
);

const aliasRenamedSnapshot = {
  ...predictionSnapshots,
  rows: predictionSnapshots.rows.map((row) => ({
    ...row,
    awayTeamName: `${row.awayTeamName} FC`,
  })),
};
const aliasRenamedFeed = buildProvisionalResultReviews(
  [sanitized],
  aliasRenamedSnapshot,
  null,
  capturedAt
);
assert.equal(
  aliasRenamedFeed.summary.reviewableMatches,
  1,
  "same provider id and exact event clock survive a post-snapshot team display-name alias change"
);
assert.equal(aliasRenamedFeed.summary.bestSettled, 1);

// Regression for the three 2026-07-21 early fixtures reported by the user.
// The immutable archive contains one baseline BEST snapshot for every fixture;
// each selected home (1), while the provisional 500 scores were draw/draw/away.
// These rows are intentionally shadow-only and never enter formal hit rate.
const historicalFixtures = [
  {
    sourceMatchId: "2040580",
    matchNo: "周二201",
    kickoffTime: "2026-07-21T18:30:00+08:00",
    homeTeamName: "济州SK",
    awayTeamName: "江原FC",
    scoreHome: 1,
    scoreAway: 1,
  },
  {
    sourceMatchId: "2040581",
    matchNo: "周二202",
    kickoffTime: "2026-07-21T18:30:00+08:00",
    homeTeamName: "全北现代",
    awayTeamName: "大田市民",
    scoreHome: 0,
    scoreAway: 0,
  },
  {
    sourceMatchId: "2040582",
    matchNo: "周二203",
    kickoffTime: "2026-07-21T18:30:00+08:00",
    homeTeamName: "蔚山现代",
    awayTeamName: "仁川联",
    scoreHome: 1,
    scoreAway: 2,
  },
];
const historicalSnapshotPayload = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../public/data/prediction-snapshots.json"),
  "utf8"
));
const historicalSourceIds = new Set(historicalFixtures.map((fixture) => fixture.sourceMatchId));
const historicalSnapshotRows = historicalSnapshotPayload.rows.filter((row) => (
  historicalSourceIds.has(String(row.sourceMatchId))
));
assert.equal(historicalSnapshotRows.length, 3, "the immutable archive retains all three early fixtures");
for (const snapshot of historicalSnapshotRows) {
  assert.equal(snapshot.phase, "baseline");
  assert.equal(snapshot.best?.tipCode, "1", "the archived BEST direction was home");
  assert.equal(snapshot.best?.recommendationAction, "reference");
}

const historicalShadowMatches = historicalFixtures.map((fixture, index) => applyExternalResultSignal({
  id: `sporttery_${fixture.sourceMatchId}`,
  source: "sporttery",
  sourceMethod: "all",
  sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=all",
  sourceMatchId: fixture.sourceMatchId,
  kickoffTime: fixture.kickoffTime,
  eventVersion: fixture.kickoffTime,
  status: "PENDING_RESULT",
  homeTeamId: `historical-home-${index}`,
  awayTeamId: `historical-away-${index}`,
  homeTeamName: fixture.homeTeamName,
  awayTeamName: fixture.awayTeamName,
  matchNo: fixture.matchNo,
  externalSignals: {
    source: "500.com:jczq+500.com:details",
    sourceMatchId: fixture.sourceMatchId,
    kickoffTime: fixture.kickoffTime,
    eventVersion: fixture.kickoffTime,
    homeTeamName: fixture.homeTeamName,
    awayTeamName: fixture.awayTeamName,
    matchNo: fixture.matchNo,
    fiveHundred: {
      result: {
        source: "500.com:jczq-result",
        status: "FINISHED",
        scoreHome: fixture.scoreHome,
        scoreAway: fixture.scoreAway,
        sourceObservedAt: "2026-07-21T15:29:40.258Z",
        observationSource: "500.com-response-received-at",
        resultObservationFallback: true,
        eventVersion: fixture.kickoffTime,
      },
    },
  },
}));
const historicalShadowFeed = buildProvisionalResultReviews(
  historicalShadowMatches,
  { ...historicalSnapshotPayload, rows: historicalSnapshotRows },
  null,
  "2026-07-21T16:00:00.000Z"
);
assert.equal(historicalShadowFeed.summary.observedMatches, 3);
assert.equal(historicalShadowFeed.summary.reviewableMatches, 3);
assert.equal(historicalShadowFeed.summary.rejectedWithoutExactPreMatchSnapshot, 0);
assert.equal(historicalShadowFeed.summary.bestSettled, 3);
assert.equal(historicalShadowFeed.summary.bestWon, 0);
assert.equal(historicalShadowFeed.summary.bestLost, 3);
assert.equal(historicalShadowFeed.summary.shadowBestHitRate, 0);
assert.equal(historicalShadowFeed.summary.formalSettled, 0);
assert.deepEqual(
  historicalShadowFeed.rows.map((row) => row.sourceMatchId),
  ["2040580", "2040581", "2040582"]
);
for (const review of historicalShadowFeed.rows) {
  const best = review.predictionReview.rows.find((row) => row.marketType === "BEST");
  assert.equal(best?.tipCode, "1");
  assert.equal(best?.resultStatus, "LOST");
  assert.equal(best?.formalEligible, false);
  assert.equal(review.snapshotEvidence.sameEvent, true);
  assert.equal(review.snapshotEvidence.clientGeneratedFallbackDirectionReplayEligible, false);
}

const mismatchedSnapshots = {
  ...predictionSnapshots,
  rows: predictionSnapshots.rows.map((row) => ({
    ...row,
    kickoffTime: new Date(Date.parse(kickoffTime) + 24 * 60 * 60 * 1000).toISOString(),
  })),
};
const rejectedFeed = buildProvisionalResultReviews([sanitized], mismatchedSnapshots, null, capturedAt);
assert.equal(rejectedFeed.rows.length, 0, "a reused source id with a different event revision is rejected");
assert.equal(rejectedFeed.summary.rejectedWithoutExactPreMatchSnapshot, 1);
assert.equal(
  attachArchivedPreMatchPredictions([sanitized], mismatchedSnapshots, null, capturedAt)[0].archivedPreMatchPrediction,
  undefined,
  "a reused source id with a different event revision cannot publish an archived direction"
);

const unsafeFinished = {
  ...pendingMatch,
  status: "FINISHED",
  scoreHome: 0,
  scoreAway: 1,
  resultSource: "500.com:jczq-result",
  resultObservationFallback: true,
  resultProvenance: null,
  predictions: [{ ...contaminatedPrediction, resultStatus: "LOST" }],
  projectedScoreHome: 1,
  projectedScoreAway: 0,
};
const health = buildPredictionHealth([unsafeFinished], null);
assert.equal(health.total.settled, 0, "untrusted finals cannot enter official hit-rate health");
const calibration = buildModelCalibration([unsafeFinished], null);
assert.equal(calibration.sample.rows, 0, "untrusted finals cannot enter formal calibration rows");
assert.equal(calibration.scoreCalibration.sample.rows, 0, "untrusted finals cannot enter score calibration");

const officialFinal = applyExternalResultSignal({
  ...pendingMatch,
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 0,
  provisionalResult: sanitized.provisionalResult,
  resultProvenance: {
    provider: "sporttery",
    official: true,
    trusted: true,
  },
  predictions: [{ ...contaminatedPrediction, resultStatus: "WON" }],
});
assert.equal(officialFinal.status, "FINISHED", "trusted Sporttery final remains canonical");
assert.equal(officialFinal.scoreHome, 2);
assert.equal(officialFinal.scoreAway, 0);
assert.equal(officialFinal.provisionalResult, undefined, "official confirmation removes provisional evidence");
assert.equal(officialFinal.predictions[0].resultStatus, "WON");

console.log(JSON.stringify({
  ok: true,
  verifier: "provisional-result-review",
  canonicalStatus: sanitized.status,
  provisionalScore: sanitized.provisionalResult.scoreText,
  shadowBestStatus: bestShadow.resultStatus,
  officialSettledRows: health.total.settled,
  scoreCalibrationRows: calibration.scoreCalibration.sample.rows,
  strictSameEventSnapshot: true,
  historicalEarlyFixtures: historicalShadowFeed.rows.map((review) => ({
    sourceMatchId: review.sourceMatchId,
    score: review.provisionalResult.scoreText,
    archivedBestTip: review.predictionReview.rows.find((row) => row.marketType === "BEST")?.tipCode,
    shadowBestStatus: review.predictionReview.rows.find((row) => row.marketType === "BEST")?.resultStatus,
  })),
  historicalShadowBest: "0/3",
  formalSettledFrom500: historicalShadowFeed.summary.formalSettled,
}, null, 2));
