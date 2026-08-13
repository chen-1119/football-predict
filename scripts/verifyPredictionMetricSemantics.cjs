const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  attachPostMatchReviews,
  buildModelCalibration,
  buildPostMatchReview,
  buildPredictionHealth,
  compactPostMatchReviewForMatch,
  snapshotTip,
} = require("./syncData.cjs");
const {
  buildStrategy,
  predictionRows,
} = require("./optimizePredictionStrategy.cjs");
const {
  appendPublicationRecord,
  buildPublicationLedgerIndex,
  emptyPublicationLedger,
  hashPublicationEvidence,
  publicationBindingForRecord,
} = require("../src/services/recommendationPublicationLedger.cjs");

function officialBoard(home = 1.4, draw = 3.2, away = 5.2) {
  return { odds1: home, oddsX: draw, odds2: away };
}

function formalBest({ pool = "HAD", tipCode = "1", odds = 1.4, line = 0, resultStatus = "WON" } = {}) {
  return {
    marketType: "BEST",
    oddsPoolCode: pool,
    ...(pool === "HHAD" ? { handicapLine: line } : {}),
    tipCode,
    tipLabel: { zh: tipCode, en: tipCode },
    odds,
    recommendationAction: "recommend",
    recommendationTier: "multi-factor-a",
    multiFactorEvidence: {
      version: "multi-factor-market-evidence-v2",
      eligible: true,
      market: pool,
      code: tipCode,
      handicapLine: pool === "HHAD" ? line : 0,
      odds,
      blockers: [],
    },
    resultStatus,
    trustScore: 80,
  };
}

function referenceBest({ pool = "HAD", tipCode = "1", odds = 1.4, line = 0, resultStatus = "LOST" } = {}) {
  return {
    marketType: "BEST",
    oddsPoolCode: pool,
    ...(pool === "HHAD" ? { handicapLine: line } : {}),
    tipCode,
    odds,
    recommendationAction: "reference",
    recommendationTier: "reference",
    multiFactorEvidence: null,
    resultStatus,
  };
}

function finishedMatch(id, scoreHome, scoreAway, predictions, extra = {}) {
  return {
    id: `sporttery_${id}`,
    sourceMatchId: id,
    matchNo: id,
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
    homeTeamName: `Home ${id}`,
    awayTeamName: `Away ${id}`,
    odds: officialBoard(),
    handicapOdds: officialBoard(),
    predictions,
    ...extra,
  };
}

function publishFormalPredictions(matches) {
  let ledger = emptyPublicationLedger();
  const publishedMatches = matches.map((match) => {
    const predictions = (match.predictions || []).map((prediction) => {
      if (prediction.recommendationAction !== "recommend") return prediction;
      const strategyVersion = "metric-test-strategy-v1";
      const appended = appendPublicationRecord(ledger, {
        publishedAt: "2026-07-12T01:00:00+08:00",
        cutoffTime: match.predictionMeta?.cutoffTime || match.buyEndTime || match.kickoffTime,
        matchId: match.id,
        sourceMatchId: match.sourceMatchId,
        selectionRole: prediction.marketType,
        marketType: prediction.oddsPoolCode,
        tipCode: prediction.tipCode,
        handicapLine: prediction.oddsPoolCode === "HHAD" ? prediction.handicapLine : 0,
        odds: prediction.odds,
        strategyVersion,
        strategyHash: hashPublicationEvidence({ strategyVersion }),
        evidenceHash: hashPublicationEvidence(prediction.multiFactorEvidence),
        featureHash: hashPublicationEvidence(match.probabilityModel || { source: "metric-test" }),
      });
      ledger = appended.ledger;
      return {
        ...prediction,
        publicationId: appended.record.publicationId,
        publicationEvidence: publicationBindingForRecord(appended.record),
      };
    });
    return { ...match, predictions };
  });
  return { matches: publishedMatches, publicationIndex: buildPublicationLedgerIndex(ledger) };
}

function preMatchReferenceSnapshotIndex(matches) {
  return new Map(matches.map((match) => [
    match.sourceMatchId,
    [{
      sourceMatchId: match.sourceMatchId,
      matchId: match.id,
      phase: "locked",
      capturedAt: "2026-07-12T01:00:00+08:00",
      cutoffTime: match.buyEndTime || match.kickoffTime,
      kickoffTime: match.kickoffTime,
      best: snapshotTip(match.predictions, "BEST"),
      signature: "BEST:HAD:reference",
    }],
  ]));
}

function run() {
  const checks = [];
  const capturedAt = "2026-07-13T12:00:00+08:00";

  const referenceMatch = finishedMatch(
    "reference-review",
    0,
    1,
    [referenceBest({ tipCode: "1", resultStatus: "LOST" })]
  );
  const referenceSnapshotIndex = preMatchReferenceSnapshotIndex([referenceMatch]);
  const referenceReview = buildPostMatchReview(referenceMatch, capturedAt, referenceSnapshotIndex);
  assert.equal(referenceReview.predictionReview.settled, 0);
  assert.equal(referenceReview.predictionReview.bestStatus, null);
  assert.equal(referenceReview.predictionReview.formalBestStatus, null);
  assert.equal(referenceReview.predictionReview.referenceBestStatus, "LOST");
  assert.equal(referenceReview.predictionReview.archivedBestStatus, "LOST");
  assert.ok(referenceReview.modelDiagnosis.some((item) => item.code === "reference-best-miss"));
  assert.ok(!referenceReview.modelDiagnosis.some((item) => item.code === "best-miss"));
  checks.push("reference BEST is archived, not counted as a formal miss");

  const referenceHitMatch = finishedMatch(
    "reference-hit-review",
    1,
    0,
    [referenceBest({ tipCode: "1", resultStatus: "WON" })]
  );
  const referenceHitSnapshotIndex = preMatchReferenceSnapshotIndex([referenceHitMatch]);
  const referenceHitReview = buildPostMatchReview(referenceHitMatch, capturedAt, referenceHitSnapshotIndex);
  assert.equal(referenceHitReview.predictionReview.bestStatus, null);
  assert.equal(referenceHitReview.predictionReview.referenceBestStatus, "WON");
  assert.ok(referenceHitReview.modelDiagnosis.some((item) => item.code === "reference-best-hit"));
  assert.ok(!referenceHitReview.modelDiagnosis.some((item) => item.code === "best-hit"));
  checks.push("reference BEST is archived, not counted as a formal hit");

  const unboundFormalMatch = finishedMatch(
    "formal-review",
    1,
    0,
    [formalBest({ pool: "HAD", tipCode: "1", resultStatus: "WON" })]
  );
  const formalFixture = publishFormalPredictions([unboundFormalMatch]);
  const formalMatch = formalFixture.matches[0];
  const formalReview = buildPostMatchReview(formalMatch, capturedAt, null, formalFixture.publicationIndex);
  assert.equal(formalReview.predictionReview.bestStatus, "WON");
  assert.equal(formalReview.predictionReview.formalBestStatus, "WON");
  assert.equal(formalReview.predictionReview.referenceBestStatus, null);
  assert.ok(formalReview.modelDiagnosis.some((item) => item.code === "best-hit"));
  assert.ok(!formalReview.modelDiagnosis.some((item) => item.code.startsWith("reference-best-")));
  checks.push("canonical formal BEST retains formal hit semantics");

  const attached = attachPostMatchReviews(
    [referenceMatch, referenceHitMatch, formalMatch],
    capturedAt,
    {
      rows: Array.from(
        preMatchReferenceSnapshotIndex([referenceMatch, referenceHitMatch]).values()
      ).flat(),
    },
    formalFixture.publicationIndex
  );
  assert.equal(attached.payload.summary.bestWon, 1);
  assert.equal(attached.payload.summary.bestLost, 0);
  assert.equal(attached.payload.summary.referenceBestWon, 1);
  assert.equal(attached.payload.summary.referenceBestLost, 1);
  checks.push("post-match aggregate keeps formal and reference BEST totals separate");

  const compactLegacy = compactPostMatchReviewForMatch({
    version: "legacy",
    predictionReview: {
      bestStatus: "LOST",
      bestRole: "reference",
      rows: [{ marketType: "BEST", reviewRole: "reference", resultStatus: "LOST" }],
    },
  });
  assert.equal(compactLegacy.predictionReview.bestStatus, null);
  assert.equal(compactLegacy.predictionReview.formalBestStatus, null);
  assert.equal(compactLegacy.predictionReview.referenceBestStatus, "LOST");
  assert.equal(compactLegacy.predictionReview.archivedBestStatus, "LOST");
  checks.push("legacy reference bestStatus is migrated without inflating formal metrics");

  const hadMatch = finishedMatch(
    "formal-had",
    1,
    0,
    [
      formalBest({ pool: "HAD", tipCode: "1", odds: 1.4, resultStatus: "WON" }),
      referenceBest({ pool: "HAD", tipCode: "2", odds: 5.2, resultStatus: "LOST" }),
    ],
    {
      probabilityModel: {
        oneXTwo: {
          final: { home: 60, draw: 25, away: 15 },
          market: { home: 58, draw: 27, away: 15 },
        },
      },
    }
  );
  const hhadMatch = finishedMatch(
    "formal-hhad",
    0,
    1,
    [formalBest({ pool: "HHAD", tipCode: "1", odds: 1.4, line: -1, resultStatus: "LOST" })],
    { handicapLine: -1 }
  );
  const legacyUnverifiedMatch = finishedMatch(
    "legacy-unverified",
    2,
    0,
    [{
      marketType: "BEST",
      oddsPoolCode: "HAD",
      tipCode: "1",
      odds: 1.4,
      recommendationAction: "recommend",
      recommendationTier: "high",
      resultStatus: "WON",
    }]
  );
  const metricFixture = publishFormalPredictions([hadMatch, hhadMatch]);
  const metricMatches = [...metricFixture.matches, legacyUnverifiedMatch];

  const health = buildPredictionHealth(metricMatches, metricFixture.publicationIndex);
  assert.equal(health.total.settled, 2);
  assert.equal(health.byMarket["1X2"].settled, 1);
  assert.equal(health.byMarket.HHAD.settled, 1);
  assert.equal(health.byMarket.BEST, undefined);
  assert.equal(health.homeFavorite.settled, 1);
  assert.equal(health.lowSpSide.settled, 1);
  assert.equal(health.oneXTwo.byTip["1"].settled, 1);
  assert.equal(health.hhad.byTip["1"].settled, 1);
  assert.equal(health.hhad.lowSpSide.settled, 1);
  assert.equal(health.best.overall.settled, 2);
  assert.equal(health.best.byMarket["1X2"].settled, 1);
  assert.equal(health.best.byMarket.HHAD.settled, 1);
  checks.push("health buckets isolate HAD and HHAD and reject non-canonical/reference rows");

  const calibration = buildModelCalibration(metricMatches, metricFixture.publicationIndex);
  assert.equal(calibration.summary.total.settled, 2);
  assert.equal(calibration.summary.byMarket["1X2"].settled, 1);
  assert.equal(calibration.summary.byMarket.HHAD.settled, 1);
  assert.equal(calibration.summary.byMarket.BEST, undefined);
  assert.equal(calibration.summary.byRole.BEST.settled, 2);
  assert.equal(calibration.sample.hhad, 1);
  assert.equal(calibration.metrics.bestHitRate, 0.5);
  checks.push("rolling calibration publishes gameplay markets and a separate formal BEST role metric");

  const rows = predictionRows(metricMatches, [], {
    publicationIndex: metricFixture.publicationIndex,
    requireVerifiedPublication: true,
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((row) => row.marketType)), new Set(["1X2", "HHAD"]));
  assert.ok(rows.every((row) => row.roleMarketType === "BEST"));
  assert.equal(rows.find((row) => row.marketType === "HHAD").probability, null);
  assert.equal(rows.find((row) => row.marketType === "1X2").probability, null);
  checks.push("optimizer rows require the immutable publication ledger and never join mutable probabilities");

  const strategy = buildStrategy(metricMatches, null, [], {
    publicationIndex: metricFixture.publicationIndex,
    requireVerifiedPublication: true,
  });
  assert.equal(strategy.summary.byMarket["1X2"].settled, 1);
  assert.equal(strategy.summary.byMarket.HHAD.settled, 1);
  assert.equal(strategy.summary.byMarket.BEST, undefined);
  assert.equal(strategy.summary.best.settled, 2);
  assert.ok(strategy.summary.byOddsBucket["1X2:sp_le_1_45"]);
  assert.ok(strategy.summary.byOddsBucket["HHAD:sp_le_1_45"]);
  assert.equal(strategy.summary.byOddsBucket.sp_le_1_45, undefined);
  assert.ok(strategy.gateByMarket["1X2"]);
  assert.ok(strategy.gateByMarket.HHAD);
  assert.equal(strategy.gateByMarket.BEST, undefined);
  assert.ok(strategy.gateByOddsBucket["1X2:sp_le_1_45"]);
  assert.ok(strategy.gateByOddsBucket["HHAD:sp_le_1_45"]);
  checks.push("strategy gates are market-qualified so HHAD cannot feed HAD odds gates");

  const coldHhadMatches = Array.from({ length: 20 }, (_, index) => finishedMatch(
    `cold-hhad-${index}`,
    0,
    1,
    [formalBest({ pool: "HHAD", tipCode: "1", odds: 1.4, line: -1, resultStatus: "LOST" })],
    { handicapLine: -1 }
  ));
  const coldHhadFixture = publishFormalPredictions(coldHhadMatches);
  const profileIsolation = buildStrategy(coldHhadFixture.matches, null, [], {
    publicationIndex: coldHhadFixture.publicationIndex,
    requireVerifiedPublication: true,
  });
  assert.equal(profileIsolation.gateByMarketProfile["HHAD:other"].onlineAction, "tighten");
  assert.equal(profileIsolation.gateByProfile.other.sample.hhad.settled, 20);
  assert.equal(profileIsolation.gateByProfile.other.sample.oneXTwo.settled, 0);
  assert.equal(profileIsolation.gateByProfile.other.onlineAction, "observe");
  checks.push("a cold HHAD profile stays visible but cannot tighten the legacy HAD profile gate");

  const rootDir = path.resolve(__dirname, "..");
  const backtestSource = fs.readFileSync(path.join(rootDir, "scripts", "runModelBacktest.cjs"), "utf8");
  const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
  const predictionsSource = fs.readFileSync(path.join(rootDir, "src", "pages", "PredictionsList.tsx"), "utf8");
  const matchDetailSource = fs.readFileSync(path.join(rootDir, "src", "pages", "MatchDetail.tsx"), "utf8");
  assert.ok(backtestSource.includes('recommendationBucketScope: "formal"'));
  assert.ok(backtestSource.includes('shadowRecommendationBucketScope: "shadow"'));
  assert.ok(backtestSource.includes('shadowRecommendationBuckets'));
  assert.ok(!backtestSource.includes("recommendationMetrics: shadowDecisionRows.length ? shadowRecommendationMetrics : recommendationMetrics"));
  checks.push("formal recommendation risk buckets are never populated from shadow decision rows");

  assert.ok(serverSource.includes('formalRecommendationRows: sample.predictionRows ?? null'));
  assert.ok(serverSource.includes('scope: "formal-recommendations-only"'));
  assert.ok(predictionsSource.includes("scorecardSample?.formalRecommendationRows ?? scorecardSample?.predictionRows"));
  assert.ok(predictionsSource.includes("暂无正式推荐样本；影子 LL/Brier 不计入赔率区间表现"));
  assert.ok(!predictionsSource.includes("modelGate?.thresholds?.minMarketBaselineRows ?? 100"));
  assert.ok(predictionsSource.includes(": 500;"));
  checks.push("public scorecard labels zero formal rows and keeps shadow LL/Brier out of odds-band performance");

  for (const source of [predictionsSource, matchDetailSource]) {
    assert.ok(source.includes("row.performanceTrack === 'formal'"));
    assert.ok(source.includes("row.recommendationAction === 'recommend'"));
    assert.ok(source.includes("row.reviewRole === 'main'"));
    assert.ok(source.includes("isSettledReviewStatus(row.resultStatus)"));
  }
  assert.ok(matchDetailSource.includes("const formalPostReviewRows = postReviewRows.filter((row) => isFormalPostReviewRow(row));"));
  assert.ok(matchDetailSource.includes("`${formalPostReviewWon}/${formalPostReviewRows.length}`"));
  assert.ok(!matchDetailSource.includes(": settledPredictions.length > 0"));
  assert.ok(!matchDetailSource.includes("postMatchReview?.predictionReview?.hitRate ?? reviewHitRate"));
  checks.push("front-end formal hit rates reject provisional, reference, live, and unreviewed prediction fallbacks");

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
}

run();
