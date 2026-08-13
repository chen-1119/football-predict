const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server", "index.cjs"), "utf8");

const section = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const probabilityListProjection = section(
  "const compactProbabilityModelForCurrentList =",
  "const compactPredictionMetaForList ="
);
assert.doesNotMatch(
  probabilityListProjection,
  /\bmodelHealth\s*:/,
  "current list probability projection must not expose per-match modelHealth"
);

const liveRecommendationProjection = section(
  "const compactLiveRecommendationForCurrentList =",
  "const compactPredictionForCurrentList ="
);
assert.match(
  liveRecommendationProjection,
  /\["version", "eligible", "statisticsTrack", "dataCoverageWarning"\]/,
  "current list live recommendation projection must use the four-field allowlist"
);

const predictionListProjection = section(
  "const compactPredictionForCurrentList =",
  "const compactTrendTextForList ="
);
for (const field of [
  "marketType",
  "oddsPoolCode",
  "handicapLine",
  "tipCode",
  "recommendationAction",
  "liveRecommendationAction",
  "livePublicationEvidence",
  "multiFactorEvidence",
  "resultStatus",
]) {
  assert.match(predictionListProjection, new RegExp(`\\b${field}\\s*:`), `list prediction lost ${field}`);
}
assert.match(
  predictionListProjection,
  /liveRecommendation:\s*compactLiveRecommendationForCurrentList\(prediction\.liveRecommendation\)/,
  "current list must not copy the full live recommendation object"
);

const currentMatchProjection = section(
  "const compactCurrentMatchForList =",
  "const compactMatchForList = compactCurrentMatchForList;"
);
for (const field of [
  "odds",
  "handicapOdds",
  "handicapLine",
  "predictions",
  "predictionMeta",
  "archivedPreMatchPrediction",
  "resultProvenance",
  "provisionalResult",
  "scoreHome",
  "scoreAway",
  "postMatchReview",
]) {
  assert.match(currentMatchProjection, new RegExp(`\\b${field}\\s*:`), `current list lost ${field}`);
}
assert.match(
  currentMatchProjection,
  /\.map\(compactPredictionForCurrentList\)/,
  "current list must retain all prediction markets, including GOALS and BEST"
);

const listMetaProjection = section(
  "const compactPredictionMetaForList =",
  "const enforceCurrentRecommendationEvidence ="
);
assert.match(listMetaProjection, /dualMarketDecision:/, "current list lost dual-market decision binding");

const detailModelProjection = section(
  "const normalizeProbabilityModelForDetail =",
  "const compactVerifiedDualMarketDecision ="
);
assert.match(detailModelProjection, /\.\.\.model,/, "detail probability payload must retain the full model object");

const detailMatchProjection = section(
  "const normalizeMatchForDetailPayload =",
  "const compactPredictionMeta ="
);
assert.match(detailMatchProjection, /\.\.\.match,/, "detail payload must retain the full match object");
assert.match(
  detailMatchProjection,
  /probabilityModel:\s*normalizeProbabilityModelForDetail\(match\.probabilityModel\)/,
  "detail payload must continue using the full detail probability normalizer"
);

console.log("Current list payload compaction source contract passed.");
