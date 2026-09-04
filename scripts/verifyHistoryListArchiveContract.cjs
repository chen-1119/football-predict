const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  getHistoryMatchesForList,
  persistDataSnapshot,
} = require("../server/dataStore.cjs");

const rootDir = path.resolve(__dirname, "..");
const readText = (relativePath) => fs.readFile(path.join(rootDir, relativePath), "utf8");

const kickoffTime = "2026-07-28T01:00:00+08:00";
const cutoffTime = "2026-07-27T22:00:00+08:00";
const capturedAt = "2026-07-27T15:22:33.229+08:00";

const archivedPrediction = {
  version: "archived-pre-match-prediction-v1",
  source: "immutable-pre-match-prediction-snapshot",
  sourceMatchId: "2040641",
  matchId: "sporttery_2040641",
  kickoffTime,
  eventVersion: kickoffTime,
  capturedAt,
  cutoffTime,
  prediction: {
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "X",
    tipLabel: { zh: "参考推荐 平局", en: "Reference pick: Draw" },
    odds: 3.4,
    trustScore: 31,
    recommendationAction: "reference",
    recommendationTier: "multi-factor-watch",
    visibilityStatus: "FREE",
    resultStatus: "PENDING",
  },
};

const reviewRows = [
  {
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode: "X",
    tipLabel: { zh: "平局", en: "Draw" },
    odds: 3.4,
    resultStatus: "WON",
    recommendationAction: "recommend",
    recommendationTier: "main",
    performanceTrack: "formal",
    reviewRole: "main",
  },
  {
    marketType: "1X2",
    oddsPoolCode: "HAD",
    tipCode: "X",
    tipLabel: { zh: "平局", en: "Draw" },
    odds: 3.4,
    resultStatus: "WON",
    recommendationAction: "reference",
    recommendationTier: "reference",
    performanceTrack: "reference",
    reviewRole: "reference",
  },
];

const historyMatch = {
  id: "sporttery_2040641",
  sourceMatchId: "2040641",
  source: "sporttery",
  sourceMethod: "relay:history",
  sourceUrl: "https://webapi.sporttery.cn/example",
  homeTeamId: "home",
  awayTeamId: "away",
  leagueId: "sweden-allsvenskan",
  countryId: "se",
  homeTeamName: "赫根",
  awayTeamName: "索尔纳",
  leagueName: "瑞超",
  countryName: "瑞典",
  kickoffTime,
  kickoffDate: "2026-07-28",
  businessDate: "2026-07-27",
  matchDate: "2026-07-27",
  buyEndTime: cutoffTime,
  eventVersion: kickoffTime,
  status: "FINISHED",
  sourceStatus: "FINISHED",
  effectiveStatus: "FINISHED",
  scoreHome: 0,
  scoreAway: 0,
  matchNo: "周一201",
  odds: { odds1: 1.79, oddsX: 3.4, odds2: 3.62 },
  oddsSource: "sporttery:HAD",
  oddsPoolCode: "HAD",
  oddsSourceMethod: "relay:current",
  oddsUpdatedAt: capturedAt,
  oddsObservedAt: capturedAt,
  oddsReceivedAt: capturedAt,
  oddsSourceUrl: "https://webapi.sporttery.cn/had",
  handicapOdds: { odds1: 3.3, oddsX: 3.75, odds2: 1.79 },
  handicapLine: "-1",
  handicapOddsSource: "sporttery:HHAD",
  handicapOddsPoolCode: "HHAD",
  handicapOddsSourceMethod: "relay:current",
  handicapOddsUpdatedAt: capturedAt,
  handicapOddsObservedAt: capturedAt,
  handicapOddsReceivedAt: capturedAt,
  handicapOddsSourceUrl: "https://webapi.sporttery.cn/hhad",
  predictionMeta: {
    policyVersion: "policy-v1",
    strategyVersion: "strategy-v1",
    generatedAt: capturedAt,
    lockedAt: capturedAt,
    cutoffTime,
  },
  archivedPreMatchPrediction: archivedPrediction,
  predictions: [archivedPrediction.prediction],
  postMatchReview: {
    version: "post-match-review-v1",
    generatedAt: "2026-07-28T03:30:00.000Z",
    matchId: "sporttery_2040641",
    sourceMatchId: "2040641",
    finalScore: "0-0",
    settlement: {
      resultRevision: 1,
      resultObservedAt: "2026-07-28T03:20:00.000Z",
      settledAt: "2026-07-28T03:20:00.000Z",
      reviewGeneratedAt: "2026-07-28T03:30:00.000Z",
    },
    predictionReview: {
      settled: 2,
      won: 2,
      hitRate: 100,
      mainSettled: 1,
      mainWon: 1,
      allSettled: 2,
      allWon: 2,
      referenceSettled: 1,
      referenceWon: 1,
      liveSettled: 0,
      liveWon: 0,
      liveHitRate: null,
      bestStatus: "WON",
      formalBestStatus: "WON",
      referenceBestStatus: "WON",
      bestRole: "main",
      bestTrack: "formal",
      rows: reviewRows,
    },
  },
};

const main = async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "football-history-contract-"));
  const dataDir = path.join(tempRoot, "data");
  const storeDir = path.join(tempRoot, "store");

  try {
    await fs.mkdir(dataDir, { recursive: true });
    const files = {
      "matches-current.json": [],
      "matches-history.json": [historyMatch],
      "sync-meta.json": {
        updatedAt: "2026-07-28T04:00:00.000Z",
        capturedAt: "2026-07-28T04:00:00.000Z",
      },
      "odds-history.json": { rows: [] },
      "prediction-snapshots.json": { rows: [] },
      "gpt-predictions.json": { rows: [] },
      "external-signals.json": { matches: {} },
    };
    await Promise.all(Object.entries(files).map(([name, payload]) => (
      fs.writeFile(path.join(dataDir, name), `${JSON.stringify(payload)}\n`, "utf8")
    )));

    await persistDataSnapshot({ storeDir, dataDir, source: "history-contract-test" });
    const [row] = await getHistoryMatchesForList(storeDir, 10);

    assert.ok(row, "history row must remain queryable");
    assert.equal(row.oddsSource, "sporttery:HAD");
    assert.equal(row.handicapOddsSource, "sporttery:HHAD");
    assert.equal(row.odds.oddsX, 3.4);
    assert.equal(row.handicapOdds.odds2, 1.79);
    assert.equal(row.predictionMeta.cutoffTime, cutoffTime);
    assert.equal(row.archivedPreMatchPrediction.prediction.tipCode, "X");
    assert.equal(row.archivedPreMatchPrediction.prediction.odds, 3.4);
    assert.equal(row.postMatchReview.predictionReview.formalBestStatus, "WON");
    assert.equal(row.postMatchReview.predictionReview.bestTrack, "formal");
    assert.equal(row.postMatchReview.predictionReview.rows[0].performanceTrack, "formal");

    const [serverIndex, predictionsList, appContext] = await Promise.all([
      readText("server/index.cjs"),
      readText("src/pages/PredictionsList.tsx"),
      readText("src/context/AppContext.tsx"),
    ]);
    const historyProjection = serverIndex.slice(
      serverIndex.indexOf("const compactHistoryMatchForList"),
      serverIndex.indexOf("const readUnresolvedArchiveForListDetailed"),
    );
    for (const field of [
      "oddsSource",
      "handicapOddsSource",
      "oddsObservedAt",
      "handicapOddsObservedAt",
      "predictionMeta",
      "archivedPreMatchPrediction",
      "postMatchReview",
    ]) {
      assert.ok(historyProjection.includes(field), `server history projection must keep ${field}`);
    }
    for (const marker of [
      "data-awaiting-official",
      "data-archived-directions",
      "原赛前方向归档",
      "待官方赛果",
    ]) {
      assert.ok(predictionsList.includes(marker), `result summary must expose ${marker}`);
    }
    const loadHistorySource = appContext.slice(
      appContext.indexOf("const loadHistory ="),
      appContext.indexOf("const loadCurrent ="),
    );
    const progressiveApplyIndex = loadHistorySource.indexOf(
      "const progressiveHistoryCount = applyData({ rows: historyRows }, 'history');",
    );
    const remainingPagesIndex = loadHistorySource.indexOf("while (", progressiveApplyIndex);
    assert.ok(progressiveApplyIndex >= 0, "recent history must be applied before background pagination");
    assert.ok(
      remainingPagesIndex > progressiveApplyIndex,
      "recent history hydration must precede remaining-page retrieval",
    );
    assert.ok(
      loadHistorySource.includes("historyLoading: true"),
      "progressive history hydration must preserve the background-loading state",
    );

    console.log(JSON.stringify({
      ok: true,
      verifier: "verifyHistoryListArchiveContract",
      checks: {
        officialOddsRetained: true,
        archiveRetained: true,
        reviewTrackRetained: true,
        pendingSummaryExposed: true,
        progressiveRecentHistoryHydration: true,
      },
    }, null, 2));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
