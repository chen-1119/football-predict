"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  applyContextGoalAdjustments,
  applyContextLambdaAdjustment,
  buildPredictionFeatureSnapshot,
  dataGapProfile,
  predictionSet,
  preMatchContextSignals,
  webConsensusContext,
  webConsensusDisplayEligible,
} = require("./syncData.cjs");

let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};
const same = (left, right, message) => check(JSON.stringify(stable(left)) === JSON.stringify(stable(right)), message);

const baseMatch = {
  id: "sporttery_rag_neutral",
  sourceMatchId: "rag_neutral",
  matchNo: "test-001",
  leagueName: "Test League",
  countryName: "Test",
  homeTeamId: "team_home",
  awayTeamId: "team_away",
  homeTeamName: "Home",
  awayTeamName: "Away",
  kickoffTime: "2026-07-20T12:00:00.000Z",
  buyEndTime: "2026-07-20T11:55:00.000Z",
  status: "SCHEDULED",
  odds: { odds1: 2.1, oddsX: 3.2, odds2: 3.4 },
  handicapLine: "-1",
  handicapOdds: { odds1: 4.5, oddsX: 3.8, odds2: 1.55 },
  preMatch: null,
};

const adversarialV2 = {
  version: "web-consensus-v2",
  usableForModel: false,
  usableForRisk: false,
  eligibleForNumericModel: false,
  eligibleForFormalQuality: false,
  eligibleForStrategyGate: false,
  eligibleForRiskDisplay: true,
  quality: { confidence: 0.99, sourceCount: 9 },
  consensus: { direction: "2", goals: "over25", drawRisk: "high" },
  features: { modelAgree: false, favoriteMayNotCover: true },
  buckets: ["web:away", "web:high-confidence"],
  // These legacy/self-asserted numeric fields must be ignored even if an
  // upstream payload tries to smuggle them back in.
  riskPenalty: 999,
  lambdaTotalAdjustment: 3,
  over25Shift: 0.4,
  bttsShift: 0.4,
};

const legacyV1 = {
  version: "web-consensus-v1",
  usableForModel: true,
  usableForRisk: true,
  eligibleForRiskDisplay: true,
  quality: { confidence: 1, sourceCount: 99 },
  consensus: { direction: "2", goals: "over25", drawRisk: "high" },
};

const probabilities = { home: 0.47, draw: 0.29, away: 0.24 };
const hhad = { home: 0.2, draw: 0.3, away: 0.5 };
const withoutWeb = preMatchContextSignals(baseMatch, probabilities, hhad, 1.45, 1.08, 0.51, 0.49);
const withWeb = preMatchContextSignals({
  ...baseMatch,
  externalSignals: { webConsensus: adversarialV2 },
}, probabilities, hhad, 1.45, 1.08, 0.51, 0.49);

check(webConsensusDisplayEligible(adversarialV2), "valid v2 evidence can be shown as advisory display");
check(!webConsensusDisplayEligible(legacyV1), "legacy self-asserted v1 evidence is not display-eligible");
check(withWeb.webConsensus.advisoryOnly === true, "web context is explicitly advisory-only");
check(withWeb.webConsensus.eligibleForNumericModel === false, "web context cannot be a numeric feature");
check(withWeb.webConsensus.eligibleForFormalQuality === false, "web context cannot affect formal quality");
check(withWeb.webConsensus.eligibleForStrategyGate === false, "web context cannot affect strategy gates");
check(withWeb.webConsensus.eligibleForPromotion === false, "web context cannot enter promotion evidence");
check(withWeb.webConsensus.usableForModel === false && withWeb.webConsensus.usableForRisk === false, "web context has no runtime numeric path");
check(withWeb.webConsensus.riskPenalty === 0, "web risk penalty is forced to zero");
check(withWeb.webConsensus.lambdaTotalAdjustment === 0, "web lambda adjustment is forced to zero");
check(withWeb.webConsensus.over25Shift === 0 && withWeb.webConsensus.bttsShift === 0, "web goal shifts are forced to zero");
check(withWeb.trustPenalty === withoutWeb.trustPenalty, "adding web evidence leaves formal trust penalty unchanged");
same(withWeb.dataGaps.missing, withoutWeb.dataGaps.missing, "adding web evidence leaves missing-data gates unchanged");
same(withWeb.dataGaps.connected, withoutWeb.dataGaps.connected, "adding web evidence leaves formal connected components unchanged");
check(withWeb.dataGaps.advisory.webConsensus.available, "web availability remains visible outside the formal connected map");

const lambdaWithout = applyContextLambdaAdjustment(1.45, 1.08, withoutWeb);
const lambdaWith = applyContextLambdaAdjustment(1.45, 1.08, {
  ...withWeb,
  webConsensus: { ...withWeb.webConsensus, lambdaTotalAdjustment: 9 },
});
same(lambdaWith, lambdaWithout, "even a post-context web lambda tamper cannot alter lambdas");
const goalsWithout = applyContextGoalAdjustments(0.51, 0.49, withoutWeb);
const goalsWith = applyContextGoalAdjustments(0.51, 0.49, {
  ...withWeb,
  webConsensus: { ...withWeb.webConsensus, over25Shift: 0.9, bttsShift: 0.9 },
});
same(goalsWith, goalsWithout, "even a post-context web shift tamper cannot alter goal probabilities");

const oldQuality = {
  score: 60,
  sourceQuality: "medium",
  severeMissingCount: 1,
  trustPenalty: 3,
  connected: { market: true, webConsensus: true },
  missing: [
    { key: "lineup", severity: "high", weight: 15 },
    { key: "webConsensus", severity: "low", weight: 99 },
  ],
  lowQuality: ["weather", "webConsensus"],
};
const oldGap = dataGapProfile({
  ...baseMatch,
  externalSignals: { preMatch: { quality: oldQuality }, webConsensus: adversarialV2 },
}, {});
check(!oldGap.missing.some((item) => item.key === "webConsensus" || item.key === "web-consensus"), "legacy web missing rows are removed from formal gaps");
check(!oldGap.preMatchQuality.lowQuality.includes("webConsensus"), "legacy web low-quality rows are removed from formal quality");
check(oldGap.connected.webConsensus === false, "legacy connected.webConsensus cannot claim formal coverage");

const projection = (output) => ({
  predictions: (output.predictions || []).map((row) => ({
    marketType: row.marketType,
    oddsPoolCode: row.oddsPoolCode || null,
    handicapLine: row.handicapLine || null,
    tipCode: row.tipCode,
    odds: row.odds,
    trustScore: row.trustScore,
    recommendationAction: row.recommendationAction,
    recommendationTier: row.recommendationTier,
    evidence: row.multiFactorEvidence ? {
      eligible: row.multiFactorEvidence.eligible,
      grade: row.multiFactorEvidence.grade,
      evidenceScore: row.multiFactorEvidence.evidenceScore,
      threshold: row.multiFactorEvidence.threshold,
      market: row.multiFactorEvidence.market,
      code: row.multiFactorEvidence.code,
      probabilityEdge: row.multiFactorEvidence.probabilityEdge,
      expectedValue: row.multiFactorEvidence.expectedValue,
      blockers: row.multiFactorEvidence.blockers,
      components: row.multiFactorEvidence.components,
      trustPenalty: row.multiFactorEvidence.diagnostics?.trustPenalty,
      riskPenalty: row.multiFactorEvidence.diagnostics?.riskPenalty,
    } : null,
  })),
  model: {
    oneXTwo: output.probabilityModel?.oneXTwo || null,
    handicap: output.probabilityModel?.handicap || null,
    goalLines: output.probabilityModel?.goalLines || null,
    bothTeamsToScore: output.probabilityModel?.bothTeamsToScore || null,
    scoreDistribution: output.probabilityModel?.scoreDistribution || null,
    selectedMarket: output.probabilityModel?.unifiedPosterior?.selectedMarket || null,
    selectedCode: output.probabilityModel?.unifiedPosterior?.selectedCode || null,
    recommendationAction: output.probabilityModel?.unifiedPosterior?.recommendationAction || null,
  },
});
const baseOutput = predictionSet(structuredClone(baseMatch));
const webOutput = predictionSet({ ...structuredClone(baseMatch), externalSignals: { webConsensus: adversarialV2 } });
const legacyOutput = predictionSet({ ...structuredClone(baseMatch), externalSignals: { webConsensus: legacyV1 } });
same(projection(webOutput), projection(baseOutput), "non-empty v2 RAG evidence leaves probabilities, directions and formal recommendations unchanged");
same(projection(legacyOutput), projection(baseOutput), "legacy v1 Web evidence leaves probabilities, directions and formal recommendations unchanged");

const fixedAt = "2026-07-20T11:00:00.000Z";
const snapshotFor = (match, output) => {
  const model = structuredClone(output.probabilityModel);
  model.generatedAt = fixedAt;
  if (model.unifiedPosterior) model.unifiedPosterior.generatedAt = fixedAt;
  return buildPredictionFeatureSnapshot({ ...match, probabilityModel: model }, fixedAt);
};
const baseSnapshot = snapshotFor(baseMatch, baseOutput);
const webSnapshot = snapshotFor({ ...baseMatch, externalSignals: { webConsensus: adversarialV2 } }, webOutput);
same(webSnapshot, baseSnapshot, "formal feature snapshot and hash are byte-stable when RAG evidence is added");

const source = fs.readFileSync(path.join(__dirname, "syncData.cjs"), "utf8");
check(!/trustPenalty:[^\n]*webConsensus\.riskPenalty/.test(source), "source contains no web risk term in formal trust penalty");
check(!/const\s+webAdjustment\s*=/.test(source), "source contains no web lambda adjustment variable");
check(!/const\s+webOverShift\s*=|const\s+webBttsShift\s*=/.test(source), "source contains no web goal-shift variable");

console.log(JSON.stringify({
  ok: true,
  assertions,
  nonEmptyV2Rows: 1,
  legacyV1Rows: 1,
  formalPredictionDigestStable: true,
  featureSnapshotHashStable: baseSnapshot.hash === webSnapshot.hash,
  numericWebWeight: 0,
}, null, 2));
