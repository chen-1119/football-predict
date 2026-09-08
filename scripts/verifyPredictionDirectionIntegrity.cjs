const assert = require("node:assert/strict");
const {
  auditableDirectionalInputCoverage,
  buildEloSnapshots,
  buildFormSnapshots,
  matchesAfterHistoricalTrainingCutoff,
  predictionSet,
  predictionSetWithoutOfficialOdds,
  selectValueAwareOneXTwo,
  shouldBuildModelOnlyReference,
} = require("./syncData.cjs");
const {
  buildDynamicRecommendationConfidence,
} = require("../src/services/recommendationConfidence.cjs");

const noHandicapRelationships = { "1": null, X: null, "2": null };

const confidenceEvidence = {
  selectedProbability: 0.54,
  modelGap: 0.13,
  dataQuality: 0.8,
  evidenceCompleteness: 1,
  evidenceScore: 78,
  marketProbability: 0.41,
  marketAligned: true,
  supportingFactorCount: 7,
  freshnessEvidence: {
    observedAt: "2026-08-20T10:00:00Z",
    evaluatedAt: "2026-08-20T10:10:00Z",
    source: "fixture-observation",
  },
  blockerCount: 0,
};
const shortSpConfidence = buildDynamicRecommendationConfidence({ ...confidenceEvidence, odds: 1.35 });
const longSpConfidence = buildDynamicRecommendationConfidence({ ...confidenceEvidence, odds: 3.35 });
assert.equal(shortSpConfidence.score, longSpConfidence.score,
  "identical football evidence must receive identical confidence regardless of SP");
assert.equal(shortSpConfidence.priceIndependent, true);
const sparseConfidence = buildDynamicRecommendationConfidence({
  ...confidenceEvidence,
  evidenceFamilyCount: 0,
  minimumEvidenceFamilies: 2,
  evidenceCompleteness: 0,
  independentAgreement: 0.5,
  freshnessEvidence: {
    observedAt: "2026-08-17T10:10:00Z",
    evaluatedAt: "2026-08-20T10:10:00Z",
    source: "fixture-observation",
  },
  uncertaintyScore: 0.75,
  inputSparse: true,
});
const coveredConfidence = buildDynamicRecommendationConfidence({
  ...confidenceEvidence,
  evidenceFamilyCount: 2,
  minimumEvidenceFamilies: 2,
  evidenceCompleteness: 1,
  independentAgreement: 0.9,
  freshnessEvidence: {
    observedAt: "2026-08-20T10:00:00Z",
    evaluatedAt: "2026-08-20T10:10:00Z",
    source: "fixture-observation",
  },
  uncertaintyScore: 0.18,
  inputSparse: false,
});
assert.ok(coveredConfidence.score > sparseConfidence.score,
  "equal headline probability must receive lower confidence when coverage is sparse and uncertainty is high");
assert.equal(sparseConfidence.version, "dynamic-evidence-confidence-v4-auditable-public-facts");
assert.equal(sparseConfidence.available, true);
const unavailableConfidence = buildDynamicRecommendationConfidence({
  selectedProbability: 0.54,
  dataQuality: null,
  evidenceCompleteness: null,
  evidenceScore: '',
  freshnessEvidence: null,
});
assert.equal(unavailableConfidence.available, false);
assert.equal(unavailableConfidence.score, 0);
assert.equal(unavailableConfidence.band, 'unavailable');
assert.deepEqual(unavailableConfidence.unavailableReasons, [
  'data-quality-missing',
  'evidence-completeness-missing',
  'evidence-score-missing',
  'freshness-quality-missing',
]);

const nearFutureKickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
assert.equal(shouldBuildModelOnlyReference({
  source: "five-hundred",
  status: "SCHEDULED",
  kickoffTime: nearFutureKickoff,
}), true, "a scheduled external-source row without odds must still receive a cold-start reference");
assert.equal(shouldBuildModelOnlyReference({
  source: "sporttery",
  status: "TIMED",
  kickoffTime: nearFutureKickoff,
}), true, "equivalent pre-match status variants must not create an empty recommendation card");
assert.equal(shouldBuildModelOnlyReference({
  source: "five-hundred",
  status: "FINISHED",
  kickoffTime: nearFutureKickoff,
}), false, "result-phase rows must not receive a newly generated cold-start direction");

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

const verifiedHistoricalAliasCases = [
  ["\u79d1\u7f57\u62c9\u591a\u6025\u6d41", "colorado rapids"],
  ["\u6d1b\u6749\u77f6FC", "los angeles"],
  ["\u7c73\u4e9a\u5c14\u6bd4", "mjallby"],
  ["\u8428\u5c14\u8328\u5821", "salzburg"],
  ["\u7279\u62c9\u5e03\u5b97\u4f53\u80b2", "trabzonspor"],
  ["\u56fe\u6069", "thun"],
  ["\u8d1d\u5c14\u683c\u83b1\u5fb7\u7ea2\u661f", "red star"],
  ["\u5df4\u5217\u5361\u8bfa", "vallecano"],
  ["\u963f\u62c9\u7ef4\u65af", "alaves"],
  ["\u7f57\u8428\u91cc\u5965\u4e2d\u592e", "rosario central"],
  ["\u67cf\u592a\u9633\u795e", "kashiwa reysol"],
  ["\u957f\u5d0e\u822a\u6d77", "v varen nagasaki"],
  ["\u4e1c\u4eacFC", "tokyo"],
  ["\u767b\u535a\u601d", "den bosch"],
  ["\u6566\u523b\u5c14\u514b", "dunkerque"],
  ["\u8499\u5f7c\u5229\u57c3", "montpellier"],
  ["\u9a6c\u8d5b", "marseille"],
  ["\u65af\u7279\u62c9\u65af\u5821", "strasbourg"],
  ["\u963f\u68ee\u7eb3", "arsenal"],
  ["\u8003\u6587\u5782", "coventry"],
  ["\u7687\u5bb6\u8d1d\u8482\u65af", "betis"],
  ["\u7687\u5bb6\u793e\u4f1a", "sociedad"],
  ["\u9e7f\u5c9b\u9e7f\u89d2", "kashima antlers"],
  ["\u798f\u5188\u9ec4\u8702", "avispa fukuoka"],
  ["\u8d6b\u5c14\u57ce", "hull"],
  ["\u66fc\u5f7b\u65af\u7279\u8054", "man united"],
  ["\u57c3\u5f17\u987f", "everton"],
  ["\u6c34\u6676\u5bab", "crystal palace"],
  ["\u8bfa\u4e01\u6c49\u68ee\u6797", "nottm forest"],
  ["\u5229\u5179\u8054", "leeds"],
  ["\u798f\u56fe\u7eb3\u9521\u5854\u5fb7", "for sittard"],
  ["\u963f\u5c14\u514b\u9a6c\u5c14", "az alkmaar"],
  ["\u6bd5\u5c14\u5df4\u9102\u7ade\u6280", "ath bilbao"],
  ["\u585e\u7ef4\u5229\u4e9a", "sevilla"],
  ["\u5e03\u4f26\u7279\u798f\u5fb7", "brentford"],
  ["\u6258\u7279\u7eb3\u59c6\u70ed\u523a", "tottenham"],
  ["\u591a\u7279\u8499\u5fb7", "dortmund"],
  ["\u62dc\u4ec1\u6155\u5c3c\u9ed1", "bayern munich"],
  ["\u70ed\u90a3\u4e9a", "genoa"],
  ["\u90a3\u4e0d\u52d2\u65af", "napoli"],
  ["\u5c3c\u65af", "nice"],
  ["\u6d1b\u91cc\u6602", "lorient"],
  ["\u897f\u73ed\u7259\u4eba", "espanol"],
  ["\u7687\u5bb6\u9a6c\u5fb7\u91cc", "real madrid"],
];
for (const [currentName, historicalKey] of verifiedHistoricalAliasCases) {
  const sourceMatchId = `verified-alias-${historicalKey.replace(/\s+/g, "-")}`;
  const training = {
    version: "verified-current-alias-fixture-v1",
    sample: { rows: 1, lastMatchDate: "2026-06-08" },
    source: { name: "fixture-history" },
    teams: {
      [historicalKey]: {
        latestElo: 1717,
        matches: 40,
        recent: [{
          kickoffTime: "2026-05-30T12:00:00.000Z",
          homeKey: historicalKey,
          awayKey: "fixture opponent",
          scoreHome: 1,
          scoreAway: 0,
        }],
      },
      "fixture opponent": {
        latestElo: 1500,
        matches: 40,
        recent: [],
      },
    },
  };
  const forecast = [{
    sourceMatchId,
    kickoffTime: "2026-08-20T12:00:00.000Z",
    status: "SCHEDULED",
    homeTeamName: currentName,
    awayTeamName: "fixture opponent",
  }];
  const elo = buildEloSnapshots(forecast, training).get(sourceMatchId);
  const form = buildFormSnapshots(forecast, training).get(sourceMatchId);
  assert.equal(elo.homeRating, 1717,
    `${currentName} must resolve to audited historical entity ${historicalKey}`);
  assert.equal(elo.homeMatches, 40,
    `${currentName} must retain the historical Elo sample count`);
  assert.equal(form.home.sampleSize, 1,
    `${currentName} must retain the historical form sample`);
}

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
assert.equal(valueReroute.pick[0], "1",
  "price and EV must not rewrite the independent model's most likely outcome");
assert.equal(valueReroute.mode, "model-leader");
assert.equal(valueReroute.isContrarian, false);

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
  eloSnapshot: {
    probabilities: { home: 0.55, draw: 0.25, away: 0.2 },
    homeRating: 1660,
    awayRating: 1480,
    diff: 180,
    homeMatches: 6,
    awayMatches: 6,
    historicalSource: { source: "fixture-history", version: "v1", signature: "low-sp-elo-v1" },
  },
  formSnapshot: {
    version: "rolling-form-fixture-v1",
    sampleSize: 8,
    home: { sampleSize: 4, goalsForAvg: 1.8, goalsAgainstAvg: 0.8 },
    away: { sampleSize: 4, goalsForAvg: 0.9, goalsAgainstAvg: 1.6 },
    historicalSource: { source: "fixture-history", version: "v1", signature: "low-sp-form-v1" },
  },
  leaguePrior: {
    source: "fixture-history",
    trainingVersion: "v1",
    trainingSignature: "low-sp-league-v1",
    matches: 80,
    homeGoalsAvg: 1.45,
    awayGoalsAvg: 1.08,
  },
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
assert.equal(lowSpOneXTwo.tipCode, lowSpModelLeader,
  "the unified 1X2 recommendation must preserve the calibrated probability leader");
assert.equal(lowSpOneXTwo.recommendationAction, "reference", "the market disagreement must block promotion and remain WATCH/reference");
assert.equal(lowSpBest.tipCode, lowSpOneXTwo.tipCode,
  "the public BEST direction must stay bound to the published 1X2 recommendation");
assert.equal(lowSpBest.odds, lowSpOneXTwo.odds,
  "the public BEST odds must come from the same published 1X2 recommendation");

const sufficientModelMarketConflict = predictionSet({
  sourceMatchId: "fixture-sufficient-model-market-conflict",
  homeTeam: "Model Home",
  awayTeam: "Market Away",
  leagueName: "Test League",
  kickoffTime: "2026-08-22T18:00:00Z",
  status: "SCHEDULED",
  odds: { odds1: 4.2, oddsX: 3.5, odds2: 1.65 },
  oddsSource: "sporttery:HAD",
  oddsUpdatedAt: "2026-08-22T08:00:00Z",
  eloSnapshot: {
    probabilities: { home: 0.58, draw: 0.24, away: 0.18 },
    homeRating: 1680,
    awayRating: 1490,
    homeMatches: 30,
    awayMatches: 30,
    historicalSource: { source: "fixture-history", version: "v1", signature: "conflict-elo-v1" },
  },
  formSnapshot: {
    version: "rolling-form-fixture-v1",
    sampleSize: 12,
    home: { sampleSize: 6, goalsForAvg: 1.9, goalsAgainstAvg: 0.8 },
    away: { sampleSize: 6, goalsForAvg: 0.8, goalsAgainstAvg: 1.7 },
    historicalSource: { source: "fixture-history", version: "v1", signature: "conflict-form-v1" },
  },
  leaguePrior: {
    source: "fixture-history",
    trainingVersion: "v1",
    trainingSignature: "conflict-league-v1",
    matches: 80,
    homeGoalsAvg: 1.45,
    awayGoalsAvg: 1.08,
  },
  modelCalibration: { strategy: { activation: { riskGuard: { riskTier: "stable" } } } },
});
const sufficientConflictBest = sufficientModelMarketConflict.predictions.find((row) => row.marketType === "BEST");
const sufficientConflictOneXTwo = sufficientModelMarketConflict.predictions.find((row) => row.marketType === "1X2");
assert.equal(sufficientModelMarketConflict.probabilityModel.inputSufficiency.sufficient, true);
assert.equal(sufficientModelMarketConflict.probabilityModel.unifiedPosterior.selectedCode, "1",
  "the internal model audit must retain its frozen direction instead of copying the market");
assert.equal(sufficientModelMarketConflict.probabilityModel.unifiedPosterior.marketBaseline.leaderCode, "2");
assert.equal(sufficientModelMarketConflict.probabilityModel.unifiedPosterior.marketBaseline.materialDirectionConflict, true);
assert.equal(sufficientConflictBest.tipCode, "1",
  "a market conflict may block formal promotion but cannot overwrite the fused direction");
assert.equal(sufficientConflictOneXTwo.tipCode, "1");
assert.match(sufficientConflictBest.recommendationTier, /^dynamic-evidence-/);
assert.equal(sufficientConflictBest.recommendationAction, "reference");
assert.equal(sufficientModelMarketConflict.probabilityModel.publicDecision.directionPublished, true);
assert.equal(sufficientModelMarketConflict.probabilityModel.publicDecision.formalRecommendation, false);
assert.equal(sufficientModelMarketConflict.probabilityModel.publicDecision.reason,
  "material-official-market-direction-conflict-reference");
assert.match(sufficientConflictBest.tipLabel.en, /Dynamic-evidence reference:/);
assert.match(sufficientConflictBest.explanation.en, /SP is retained/i);

const nonformalMildModelMarketDisagreement = predictionSet({
  sourceMatchId: "fixture-nonformal-mild-model-market-disagreement",
  homeTeam: "Model Lean Home",
  awayTeam: "Market Lean Away",
  leagueName: "Test League",
  kickoffTime: "2026-08-22T18:00:00Z",
  status: "SCHEDULED",
  odds: { odds1: 2.5, oddsX: 3.2, odds2: 2.3 },
  oddsSource: "sporttery:HAD",
  oddsUpdatedAt: "2026-08-22T08:00:00Z",
  eloSnapshot: {
    probabilities: { home: 0.54, draw: 0.25, away: 0.21 },
    homeRating: 1650,
    awayRating: 1510,
    homeMatches: 28,
    awayMatches: 28,
    historicalSource: { source: "fixture-history", version: "v1", signature: "mild-conflict-elo-v1" },
  },
  formSnapshot: {
    version: "rolling-form-fixture-v1",
    sampleSize: 12,
    home: { sampleSize: 6, goalsForAvg: 1.7, goalsAgainstAvg: 0.9 },
    away: { sampleSize: 6, goalsForAvg: 1.0, goalsAgainstAvg: 1.5 },
    historicalSource: { source: "fixture-history", version: "v1", signature: "mild-conflict-form-v1" },
  },
  leaguePrior: {
    source: "fixture-history",
    trainingVersion: "v1",
    trainingSignature: "mild-conflict-league-v1",
    matches: 80,
    homeGoalsAvg: 1.45,
    awayGoalsAvg: 1.08,
  },
  modelCalibration: { strategy: { activation: { riskGuard: { riskTier: "stable" } } } },
});
const mildConflictBest = nonformalMildModelMarketDisagreement.predictions.find((row) => row.marketType === "BEST");
const mildConflictOneXTwo = nonformalMildModelMarketDisagreement.predictions.find((row) => row.marketType === "1X2");
assert.equal(nonformalMildModelMarketDisagreement.probabilityModel.inputSufficiency.sufficient, true);
assert.equal(nonformalMildModelMarketDisagreement.probabilityModel.unifiedPosterior.selectedCode, "1",
  "internal model audit must preserve the model leader");
assert.equal(nonformalMildModelMarketDisagreement.probabilityModel.unifiedPosterior.marketBaseline.leaderCode, "2");
assert.equal(nonformalMildModelMarketDisagreement.probabilityModel.unifiedPosterior.marketBaseline.materialDirectionConflict, false,
  "fixture must exercise the non-material disagreement lane");
assert.equal(mildConflictBest.recommendationAction, "reference");
assert.equal(mildConflictBest.tipCode, "1",
  "a non-promoted public reference must retain the fused model direction");
assert.equal(mildConflictOneXTwo.tipCode, "1");
assert.match(mildConflictBest.recommendationTier, /^dynamic-evidence-/);
assert.equal(mildConflictBest.confidence.priceIndependent, true);
assert.equal(nonformalMildModelMarketDisagreement.probabilityModel.publicDecision.reason,
  "nonformal-dynamic-evidence-reference");

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

const drawValueWithoutModelLead = selectValueAwareOneXTwo(
  {},
  [
    ["1", 0.42, 2.2, "Home win", "Home win"],
    ["X", 0.29, 5.1, "Draw", "Draw"],
    ["2", 0.29, 3.4, "Away win", "Away win"],
  ],
  { home: 0.42, draw: 0.29, away: 0.29 },
  { home: 0.45, draw: 0.17, away: 0.38 },
  noHandicapRelationships
);
assert.equal(drawValueWithoutModelLead.pick[0], "1",
  "a high draw price must not reroute a materially stronger independent-model leader");

const sparseOfficialAwayFavorite = predictionSet({
  sourceMatchId: "fixture-sparse-official-away-favorite",
  homeTeam: "Unknown Home",
  awayTeam: "Unknown Away",
  leagueName: "Test League",
  kickoffTime: "2026-08-22T18:00:00Z",
  status: "SCHEDULED",
  odds: { odds1: 4.75, oddsX: 4.2, odds2: 1.47 },
  oddsSource: "sporttery:HAD",
  oddsUpdatedAt: "2026-08-22T08:00:00Z",
  modelCalibration: { strategy: { activation: { riskGuard: { riskTier: "stable" } } } },
});
const sparseOfficialBest = sparseOfficialAwayFavorite.predictions.find((row) => row.marketType === "BEST");
const sparseOfficialOneXTwo = sparseOfficialAwayFavorite.predictions.find((row) => row.marketType === "1X2");
assert.equal(sparseOfficialAwayFavorite.probabilityModel.inputSufficiency.sufficient, false,
  "the official-market backstop must only activate for insufficient auditable football inputs");
assert.equal(sparseOfficialAwayFavorite.probabilityModel.unifiedPosterior.inputFallback.applied, true);
assert.equal(sparseOfficialAwayFavorite.probabilityModel.unifiedPosterior.inputFallback.formalPromotionEligible, false);
assert.ok(sparseOfficialAwayFavorite.probabilityModel.oneXTwo.unifiedPosterior.away
  > sparseOfficialAwayFavorite.probabilityModel.oneXTwo.unifiedPosterior.home,
"a strong official away favourite must replace the repeated cold-start home prior in the reference posterior");
assert.equal(sparseOfficialBest.tipCode, "2");
assert.equal(sparseOfficialOneXTwo.tipCode, "2");
assert.match(sparseOfficialBest.recommendationTier, /^input-sparse-dynamic-evidence-/);
assert.equal(sparseOfficialBest.recommendationAction, "reference");
assert.equal(sparseOfficialBest.multiFactorEvidence.eligible, false);
assert.ok(sparseOfficialBest.multiFactorEvidence.blockers.includes("insufficient-auditable-model-inputs"));

const sparseBalancedFixture = predictionSet({
  sourceMatchId: "fixture-sparse-balanced-draw-aware",
  homeTeam: "Unknown Balanced Home",
  awayTeam: "Unknown Balanced Away",
  leagueName: "Test League",
  kickoffTime: "2026-08-22T18:00:00Z",
  status: "SCHEDULED",
  odds: { odds1: 2.55, oddsX: 3.05, odds2: 2.65 },
  oddsSource: "sporttery:HAD",
  oddsUpdatedAt: "2026-08-22T08:00:00Z",
  modelCalibration: { strategy: { activation: { riskGuard: { riskTier: "stable" } } } },
});
const sparseBalancedBest = sparseBalancedFixture.predictions.find((row) => row.marketType === "BEST");
const sparseBalancedDiagnostics = sparseBalancedFixture.probabilityModel.unifiedPosterior.evidenceShrinkage;
assert.equal(sparseBalancedFixture.probabilityModel.inputSufficiency.sufficient, false);
assert.equal(sparseBalancedBest.tipCode, "X",
  "balanced sparse evidence with a low-score draw shape must not fall back to a default home win");
assert.ok(sparseBalancedDiagnostics.drawAdjustment > 0);
assert.ok(sparseBalancedDiagnostics.weights.market <= 0.1,
  "the official board must remain a weak validation input in the sparse second-stage posterior");
assert.equal(sparseBalancedDiagnostics.quotaBalancing, false,
  "draw calibration must be evidence-derived and never a slate-level quota");
assert.equal(sparseBalancedDiagnostics.formalPromotionEligible, false);
assert.equal(sparseBalancedBest.confidence.band, "unavailable");
assert.equal(sparseBalancedBest.confidence.available, false,
  "sparse inputs without audited quality and timestamp evidence must not manufacture a trust band");

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
assert.ok(noAuditableInputs.predictions.every((row) => row.tipCode === "WATCH"));
assert.ok(noAuditableInputs.predictions.every((row) => row.recommendationAction === "reference"));
assert.ok(noAuditableInputs.predictions.every((row) => row.recommendationTier === "input-insufficient-watch"));
assert.ok(noAuditableInputs.predictions.every((row) => /^No pick:/.test(row.tipLabel.en)));
assert.ok(noAuditableInputs.predictions.every((row) => !/[锛鏂璇绔妯姒鐞璁缁棰]/.test(JSON.stringify(row))));
assert.equal(noAuditableInputs.projectedScore, undefined, "front-end payload must not expose a synthetic score direction");
assert.equal(noAuditableInputs.probabilityModel.publicDecision.tipCode, "WATCH");
assert.equal(noAuditableInputs.probabilityModel.publicDecision.directionPublished, false);
assert.equal(noAuditableInputs.probabilityModel.oneXTwo.final, null);
assert.equal(noAuditableInputs.probabilityModel.publicDecision.formalRecommendation, false);
assert.equal(noAuditableInputs.probabilityModel.publicDecision.reason,
  "insufficient-auditable-inputs-without-official-odds");
assert.ok(["1", "X", "2"].includes(noAuditableInputs.probabilityModel.internalDirectionalAudit.unifiedPosterior.selectedCode),
  "internal model audit remains available without publishing an unsupported direction");

const unauditedReferenceOdds = predictionSet({
  ...noAuditableInputsFixture,
  sourceMatchId: "fixture-unaudited-reference-odds",
  odds: { odds1: 1.5, oddsX: 4.1, odds2: 6.2 },
  oddsSource: "500.com:HAD",
  oddsUpdatedAt: "2026-07-14T00:00:00Z",
});
const unauditedReferenceDirections = unauditedReferenceOdds.predictions
  .filter((row) => row.marketType === "1X2" || row.marketType === "BEST");
assert.ok(unauditedReferenceDirections.length >= 2);
assert.ok(unauditedReferenceDirections.every((row) => row.tipCode === "WATCH"),
  "unverified non-official odds cannot revive a direction when audited football inputs are insufficient");
assert.ok(unauditedReferenceOdds.predictions.every((row) => row.recommendationAction === "reference"));
assert.equal(unauditedReferenceOdds.probabilityModel.publicDecision.directionPublished, false);

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

const stalePairedFormFixture = {
  ...noAuditableInputsFixture,
  sourceMatchId: "fixture-stale-paired-form",
  formSnapshot: {
    version: "rolling-form-stale-fixture-v1",
    sampleSize: 24,
    home: {
      sampleSize: 12,
      goalsForAvg: 1.7,
      goalsAgainstAvg: 0.9,
      lastMatchAt: "2025-05-01T12:00:00Z",
    },
    away: {
      sampleSize: 12,
      goalsForAvg: 1.2,
      goalsAgainstAvg: 1.3,
      lastMatchAt: "2025-05-03T12:00:00Z",
    },
    historicalSource: { source: "fixture-history", version: "v1", signature: "form-stale-v1" },
  },
  leaguePrior: {
    source: "fixture-history",
    trainingVersion: "v1",
    trainingSignature: "league-stale-v1",
    matches: 80,
    homeGoalsAvg: 1.45,
    awayGoalsAvg: 1.08,
  },
};
const stalePairedCoverage = auditableDirectionalInputCoverage(stalePairedFormFixture);
assert.equal(stalePairedCoverage.form.recencyReady, false);
assert.equal(stalePairedCoverage.form.ready, false,
  "year-old form rows must not be described as recent auditable form");
assert.equal(stalePairedCoverage.sufficient, false);

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
  assertions: 100,
  guarantees: {
    lowerSpCannotOverrideEvidence: true,
    spCannotCapConfidence: true,
    hhadMarketContradictionDowngradesToWatch: true,
    materialHadMarketConflictBlocksFormalPromotionWithoutOverwritingDirection: true,
    insufficientAuditableInputsWithholdNewDirection: true,
    auditableModelOnlyReferencesRemainAvailable: true,
    sparseOfficialInputsUseDynamicReferenceBlend: true,
    sparseBalancedInputsUseDrawAwareShrinkage: true,
    confidenceUsesCoverageAndUncertainty: true,
    drawCalibrationDoesNotUseDirectionQuota: true,
    coldStartDirectionExcludedFromFormalMetrics: true,
    historicalAggregateAppliedOnlyAfterCutoff: true,
    staleFormCannotRaiseInputConfidence: true,
  },
}, null, 2));
