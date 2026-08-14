const assert = require("node:assert/strict");
const {
  auditableDirectionalInputCoverage,
  buildEloSnapshots,
  buildFormSnapshots,
  matchesAfterHistoricalTrainingCutoff,
  predictionSet,
  predictionSetWithoutOfficialOdds,
  selectValueAwareOneXTwo,
} = require("./syncData.cjs");

const noHandicapRelationships = { "1": null, X: null, "2": null };

const namedResult = {
  id: "named-result",
  sourceMatchId: "named-result",
  eventVersion: "2026-07-18T12:00:00.000Z",
  kickoffTime: "2026-07-18T12:00:00.000Z",
  source: "sporttery",
  sourceUrl: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=result",
  resultSource: "sporttery:official-api",
  resultObservedAt: "2026-07-18T14:00:00.000Z",
  resultObservationSource: "sporttery-relay-endpoint-fetched-at",
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 0,
  homeTeamName: "Named Home",
  awayTeamName: "Named Away",
};
const namedForecast = {
  id: "named-forecast",
  sourceMatchId: "named-forecast",
  eventVersion: "2026-07-20T12:00:00.000Z",
  kickoffTime: "2026-07-20T12:00:00.000Z",
  status: "SCHEDULED",
  homeTeamName: "Named Home",
  awayTeamName: "Named Away",
};
const namedForm = buildFormSnapshots([namedResult, namedForecast]).get("named-forecast");
const namedElo = buildEloSnapshots([namedResult, namedForecast]).get("named-forecast");
assert.equal(namedForm.home.sampleSize, 1,
  "form snapshots must consume homeTeamName when legacy homeTeam is absent");
assert.equal(namedForm.away.sampleSize, 1,
  "form snapshots must consume awayTeamName when legacy awayTeam is absent");
assert.equal(namedElo.homeMatches, 1,
  "Elo snapshots must count homeTeamName results");
assert.equal(namedElo.awayMatches, 1,
  "Elo snapshots must count awayTeamName results");
assert.ok(namedElo.homeRating > namedElo.awayRating,
  "the observed home win must move the named-team Elo ordering");

const cutoffTraining = {
  version: "historical-training-cutoff-fixture-v1",
  sample: { rows: 2, lastMatchDate: "2026-06-08" },
  source: { name: "fixture-history" },
  teams: {
    benfica: {
      latestElo: 1800,
      matches: 40,
      recent: [{
        kickoffTime: "2026-05-30T12:00:00.000Z",
        homeKey: "benfica",
        awayKey: "st gallen",
        scoreHome: 2,
        scoreAway: 0,
      }],
    },
    "st gallen": {
      latestElo: 1540,
      matches: 40,
      recent: [{
        kickoffTime: "2026-05-30T12:00:00.000Z",
        homeKey: "benfica",
        awayKey: "st gallen",
        scoreHome: 2,
        scoreAway: 0,
      }],
    },
  },
};
const beforeTrainingCutoff = {
  sourceMatchId: "before-training-cutoff",
  kickoffTime: "2026-06-08T12:00:00.000Z",
  status: "SCHEDULED",
  homeTeamName: "\u672c\u83f2\u5361",
  awayTeamName: "\u5723\u52a0\u4ed1",
};
const afterTrainingCutoff = {
  sourceMatchId: "after-training-cutoff",
  kickoffTime: "2026-06-09T12:00:00.000Z",
  status: "SCHEDULED",
  homeTeamName: "\u672c\u83f2\u5361",
  awayTeamName: "\u5723\u52a0\u4ed1",
};
const cutoffMatches = matchesAfterHistoricalTrainingCutoff(
  [beforeTrainingCutoff, afterTrainingCutoff],
  cutoffTraining
);
assert.deepEqual(cutoffMatches.map((match) => match.sourceMatchId), ["after-training-cutoff"],
  "aggregate history must only seed forecasts after its declared lastMatchDate");
const seededChineseAliasForm = buildFormSnapshots(cutoffMatches, cutoffTraining)
  .get("after-training-cutoff");
assert.equal(seededChineseAliasForm.home.sampleSize, 1,
  "current Chinese club names must resolve to their audited historical-training keys");
assert.equal(seededChineseAliasForm.away.sampleSize, 1,
  "historical seed aliases must work for both teams");

const currentClubAliasTraining = {
  version: "historical-training-current-club-alias-fixture-v1",
  sample: { rows: 2, lastMatchDate: "2026-06-08" },
  source: { name: "fixture-history" },
  teams: {
    "paris sg": {
      latestElo: 1948,
      matches: 880,
      recent: [{
        kickoffTime: "2026-05-30T12:00:00.000Z",
        homeKey: "paris sg",
        awayKey: "aston villa",
        scoreHome: 2,
        scoreAway: 1,
      }],
    },
    "aston villa": {
      latestElo: 1877,
      matches: 960,
      recent: [{
        kickoffTime: "2026-05-30T12:00:00.000Z",
        homeKey: "paris sg",
        awayKey: "aston villa",
        scoreHome: 2,
        scoreAway: 1,
      }],
    },
  },
};
const currentClubAliasForecast = [{
  sourceMatchId: "current-club-alias-forecast",
  kickoffTime: "2026-08-13T03:00:00.000Z",
  status: "SCHEDULED",
  homeTeamName: "\u5df4\u9ece\u5723\u65e5\u5c14\u66fc",
  awayTeamName: "\u963f\u65af\u987f\u7ef4\u62c9",
}];
const currentClubAliasElo = buildEloSnapshots(
  currentClubAliasForecast,
  currentClubAliasTraining
).get("current-club-alias-forecast");
assert.equal(currentClubAliasElo.homeRating, 1948,
  "current PSG Chinese name must resolve to the signed Paris SG training entity");
assert.equal(currentClubAliasElo.awayRating, 1877,
  "current Aston Villa Chinese name must resolve to the signed Aston Villa training entity");
assert.notEqual(
  Number(currentClubAliasElo.probabilities.home.toFixed(4)),
  Number(currentClubAliasElo.probabilities.away.toFixed(4)),
  "resolved club history must replace the symmetric cold-start strength prior"
);

const valueReroute = selectValueAwareOneXTwo(
  {},
  [
    ["1", 0.47, 1.3, "主胜", "Home win"],
    ["2", 0.42, 5.8, "客胜", "Away win"],
    ["X", 0.11, 4.2, "平局", "Draw"],
  ],
  { home: 0.47, draw: 0.11, away: 0.42 },
  { home: 0.68, draw: 0.18, away: 0.14 },
  noHandicapRelationships
);
assert.equal(valueReroute.pick[0], "2", "a low-SP favourite must not lock out a calibrated positive-value reroute");
assert.equal(valueReroute.mode, "value-underdog");
assert.equal(valueReroute.isContrarian, true);
assert.match(valueReroute.reason.en, /never from a lower SP/i);

const lowSpEndToEnd = predictionSet({
  sourceMatchId: "f-3.5-15-10",
  homeTeam: "H15",
  awayTeam: "A10",
  homeRank: "15",
  awayRank: "10",
  leagueName: "测试联赛",
  kickoffTime: "2026-07-20T12:00:00Z",
  status: "SCHEDULED",
  odds: { odds1: 1.3, oddsX: 4.4, odds2: 3.5 },
  oddsSource: "sporttery:HAD",
  oddsUpdatedAt: "2026-07-14T00:00:00Z",
  modelCalibration: { strategy: { activation: { riskGuard: { riskTier: "stable" } } } },
});
const lowSpFinal = lowSpEndToEnd.probabilityModel.oneXTwo.final;
const lowSpModelLeader = Object.entries({ "1": lowSpFinal.home, X: lowSpFinal.draw, "2": lowSpFinal.away })
  .sort((a, b) => b[1] - a[1])[0][0];
const lowSpOneXTwo = lowSpEndToEnd.predictions.find((row) => row.marketType === "1X2");
const lowSpBest = lowSpEndToEnd.predictions.find((row) => row.marketType === "BEST");
const lowSpUnifiedCode = lowSpEndToEnd.probabilityModel.unifiedPosterior.selectedCode;
assert.equal(lowSpModelLeader, "1", "fixture must begin with a calibrated home model leader");
assert.equal(lowSpOneXTwo.tipCode, lowSpUnifiedCode,
  "the published 1X2 row must use the final unified evidence direction");
assert.notEqual(lowSpOneXTwo.tipCode, "1",
  "the lower-SP market favourite must not overwrite the unified evidence direction");
assert.equal(lowSpOneXTwo.recommendationAction, "reference", "the market disagreement must block promotion and remain WATCH/reference");
assert.ok(lowSpOneXTwo.riskTags.some((tag) => tag.en === "Market disagreement"));
assert.equal(lowSpBest.tipCode, lowSpOneXTwo.tipCode,
  "the public BEST direction must stay bound to the published 1X2 recommendation");
assert.equal(lowSpBest.odds, lowSpOneXTwo.odds,
  "the public BEST odds must come from the same published 1X2 recommendation");

const marketOnlyDisagreement = selectValueAwareOneXTwo(
  {},
  [
    ["1", 0.55, 2.25, "主胜", "Home win"],
    ["X", 0.25, 3.5, "平局", "Draw"],
    ["2", 0.2, 1.45, "客胜", "Away win"],
  ],
  { home: 0.55, draw: 0.25, away: 0.2 },
  { home: 0.3, draw: 0.2, away: 0.5 },
  noHandicapRelationships
);
assert.equal(marketOnlyDisagreement.pick[0], "1", "the market leader alone must never reroute the independent direction");
assert.notEqual(marketOnlyDisagreement.pick[0], "2");

const hhadOnlyFixture = {
  sourceMatchId: "fixture-hhad-market-contradiction",
  homeTeam: "Brazil",
  awayTeam: "San Marino",
  homeRank: "1",
  awayRank: "210",
  leagueName: "国际友谊赛",
  kickoffTime: "2026-07-20T12:00:00Z",
  status: "SCHEDULED",
  handicapLine: "-1",
  handicapOdds: { odds1: 5.2, oddsX: 3.8, odds2: 1.35 },
  handicapOddsSource: "sporttery:HHAD",
  handicapOddsUpdatedAt: "2026-07-14T00:00:00Z",
  modelCalibration: { strategy: { activation: { riskGuard: { riskTier: "stable" } } } },
};
const hhadOnly = predictionSet(hhadOnlyFixture);
const hhadUnified = hhadOnly.probabilityModel.unifiedPosterior;
const hhadBest = hhadOnly.predictions.find((row) => row.marketType === "BEST");
assert.ok(hhadOnly.probabilityModel.handicap.market.away > hhadOnly.probabilityModel.handicap.market.home,
  "fixture must have an official HHAD-away market leader");
assert.ok(hhadOnly.probabilityModel.handicap.unifiedPosterior.home > hhadOnly.probabilityModel.handicap.unifiedPosterior.away,
  "independent HHAD posterior must retain its home direction");
assert.equal(hhadUnified.selectedCode, "1", "HHAD-only safeguard must not reset posterior to the market leader");
assert.equal(hhadUnified.marketSafeguard.action, "downgrade-watch");
assert.equal(hhadUnified.marketSafeguard.marketCode, "2");
assert.equal(hhadUnified.selectionPolicy, "hhad-market-contradiction-watch");
assert.equal(hhadUnified.recommendationAction, "reference");
assert.ok(hhadUnified.multiFactorEvidence.blockers.includes("official-market-direction-contradiction"));
assert.equal(hhadBest.tipCode, "1", "observation must retain the frozen model direction");
assert.equal(hhadBest.recommendationAction, "reference", "market contradiction must downgrade the lane to observation");
assert.match(hhadBest.tipLabel.zh, /^参考推荐\s/u, "a retained direction must be labelled as a reference pick");
assert.doesNotMatch(hhadBest.tipLabel.zh, /观察/u, "a public directional label must not fall back to watch copy");
assert.match(hhadBest.explanation.en, /retained but downgraded to watch/i);

const noAuditableInputsFixture = {
  sourceMatchId: "fixture-no-auditable-inputs",
  homeTeam: "甲队",
  awayTeam: "乙队",
  leagueName: "测试联赛",
  kickoffTime: "2026-07-20T12:00:00Z",
  status: "SCHEDULED",
};
const noAuditableInputs = predictionSetWithoutOfficialOdds(noAuditableInputsFixture);
const noAuditableOneXTwo = noAuditableInputs.predictions.find((row) => row.marketType === "1X2");
const noAuditableBest = noAuditableInputs.predictions.find((row) => row.marketType === "BEST");
assert.equal(auditableDirectionalInputCoverage(noAuditableInputsFixture).sufficient, false);
assert.ok(noAuditableInputs.predictions.length >= 2);
/* Legacy suppression assertions intentionally removed: every public fixture now keeps a low-weight reference direction.
assert.ok(noAuditableInputs.predictions.every((row) => row.tipCode === "WATCH"));
assert.ok(noAuditableInputs.predictions.every((row) => row.recommendationAction === "reference"));
assert.ok(noAuditableInputs.predictions.every((row) => row.tipLabel.zh === "暂无推荐：可审计数据不足"));
assert.ok(noAuditableInputs.predictions.every((row) => !/(主胜|平局|客胜|让胜|让平|让负)/.test(row.tipLabel.zh)));
assert.ok(noAuditableInputs.predictions.every((row) => !/[锛鏂璇绔妯姒鐞璁缁棰]/.test(JSON.stringify(row))));
assert.equal(noAuditableInputs.projectedScore, undefined, "front-end payload must not expose a synthetic score direction");
assert.equal(noAuditableInputs.probabilityModel.publicDecision.tipCode, "WATCH");
assert.equal(noAuditableInputs.probabilityModel.publicDecision.directionPublished, false);
assert.equal(noAuditableInputs.probabilityModel.unifiedPosterior, undefined);
assert.equal(noAuditableInputs.probabilityModel.oneXTwo.final, null);
assert.ok(["1", "X", "2"].includes(noAuditableInputs.probabilityModel.internalDirectionalAudit.unifiedPosterior.selectedCode),
  "internal model audit remains available even when the public direction is suppressed");
*/
assert.ok(noAuditableInputs.predictions.every((row) => ["1", "X", "2"].includes(row.tipCode)));
assert.ok(noAuditableInputs.predictions.every((row) => row.recommendationAction === "reference"));
assert.ok(noAuditableInputs.predictions.every((row) => row.recommendationTier === "cold-start-reference"));
assert.ok(noAuditableInputs.predictions.every((row) => /^\u51b7\u542f\u52a8\u53c2\u8003\s/u.test(row.tipLabel.zh)));
assert.ok(noAuditableInputs.projectedScore && Number.isFinite(noAuditableInputs.projectedScore.home));
assert.ok(["1", "X", "2"].includes(noAuditableInputs.probabilityModel.publicDecision.tipCode));
assert.equal(noAuditableInputs.probabilityModel.publicDecision.directionPublished, true);
assert.equal(noAuditableInputs.probabilityModel.publicDecision.formalRecommendation, false);
assert.equal(noAuditableBest.tipCode, noAuditableOneXTwo.tipCode,
  "cold-start BEST must stay bound to the visible model-only 1X2 reference");
assert.ok(noAuditableInputs.probabilityModel.oneXTwo.final);
assert.ok(noAuditableInputs.probabilityModel.unifiedPosterior);
assert.ok(["1", "X", "2"].includes(noAuditableInputs.probabilityModel.internalDirectionalAudit.unifiedPosterior.selectedCode),
  "internal model audit remains available alongside the low-weight public reference");

const unauditedReferenceOdds = predictionSet({
  ...noAuditableInputsFixture,
  sourceMatchId: "fixture-unaudited-reference-odds",
  odds: { odds1: 1.5, oddsX: 4.1, odds2: 6.2 },
  oddsSource: "500.com:HAD",
  oddsUpdatedAt: "2026-07-14T00:00:00Z",
});
/* Legacy suppression assertion:
assert.ok(unauditedReferenceOdds.predictions.every((row) => row.tipCode === "WATCH"),
  "non-official reference odds cannot manufacture a direction when audited football inputs are missing");
assert.equal(unauditedReferenceOdds.probabilityModel.publicDecision.directionPublished, false);
*/
assert.ok(["1", "X", "2"].includes(
  unauditedReferenceOdds.predictions.find((row) => row.marketType === "BEST")?.tipCode
));
assert.ok(unauditedReferenceOdds.predictions.every((row) => row.recommendationTier === "cold-start-reference"));
assert.equal(unauditedReferenceOdds.probabilityModel.publicDecision.directionPublished, true);
assert.equal(unauditedReferenceOdds.probabilityModel.publicDecision.formalRecommendation, false);

const oneSidedFormFixture = {
  ...noAuditableInputsFixture,
  sourceMatchId: "fixture-one-sided-form",
  odds: { odds1: 2.2, oddsX: 3.2, odds2: 3.1 },
  oddsSource: "500.com:HAD",
  oddsUpdatedAt: "2026-07-14T00:00:00Z",
  formSnapshot: {
    version: "rolling-form-one-sided-fixture-v1",
    sampleSize: 12,
    home: {
      sampleSize: 12,
      goalsForAvg: 1.7,
      goalsAgainstAvg: 0.9,
    },
    away: {
      sampleSize: 0,
      goalsForAvg: null,
      goalsAgainstAvg: null,
    },
    historicalSource: { source: "fixture-history", version: "v1", signature: "form-one-sided-v1" },
  },
};
const oneSidedForm = predictionSet(oneSidedFormFixture);
assert.equal(auditableDirectionalInputCoverage(oneSidedFormFixture).form.ready, false,
  "one-sided form must not satisfy a two-team recommendation input gate");
assert.equal(oneSidedForm.probabilityModel.inputSufficiency.sufficient, false,
  "one-sided form must remain an insufficient model input");
assert.equal(oneSidedForm.probabilityModel.lambdaBlend.formWeight, 0,
  "missing away form must fall back instead of being interpreted as zero goals");

const sufficientInputsFixture = {
  ...noAuditableInputsFixture,
  sourceMatchId: "fixture-sufficient-auditable-inputs",
  eloSnapshot: {
    probabilities: { home: 0.56, draw: 0.25, away: 0.19 },
    homeRating: 1660,
    awayRating: 1480,
    diff: 180,
    homeMatches: 8,
    awayMatches: 8,
    lastUpdatedAt: "2026-07-13T00:00:00Z",
    historicalSource: { source: "fixture-history", version: "v1", signature: "elo-fixture-v1" },
  },
  formSnapshot: {
    version: "rolling-form-fixture-v1",
    sampleSize: 8,
    home: { goalsForAvg: 1.8, goalsAgainstAvg: 0.8 },
    away: { goalsForAvg: 0.9, goalsAgainstAvg: 1.6 },
    historicalSource: { source: "fixture-history", version: "v1", signature: "form-fixture-v1" },
  },
  leaguePrior: {
    source: "fixture-history",
    trainingVersion: "v1",
    trainingSignature: "league-fixture-v1",
    matches: 80,
    homeGoalsAvg: 1.45,
    awayGoalsAvg: 1.08,
  },
};
const sufficientInputs = predictionSetWithoutOfficialOdds(sufficientInputsFixture);
assert.equal(sufficientInputs.probabilityModel.inputSufficiency.sufficient, true);
assert.ok(sufficientInputs.predictions.some((row) => row.tipCode !== "WATCH"),
  "audited model-only evidence may retain an explicitly reference-only direction");
assert.ok(sufficientInputs.predictions.every((row) => row.recommendationAction === "reference"));
assert.match(sufficientInputs.probabilityModel.basis.zh, /未开售模型参考/);
assert.ok(!/[锛鏂璇绔妯姒鐞璁缁棰]/.test(JSON.stringify({
  basis: sufficientInputs.probabilityModel.basis,
  predictions: sufficientInputs.predictions,
})));

console.log(JSON.stringify({
  ok: true,
  verifier: "prediction-direction-integrity",
  assertions: 61,
  guarantees: {
    lowerSpCannotOverrideEvidence: true,
    hhadMarketContradictionDowngradesToWatch: true,
    insufficientAuditableInputsKeepColdStartReference: true,
    coldStartReferenceExcludedFromFormalRecommendation: true,
    historicalAggregateAppliedOnlyAfterCutoff: true,
  },
}, null, 2));
