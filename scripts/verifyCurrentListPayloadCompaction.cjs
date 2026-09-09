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
  "const CURRENT_LIST_PUBLIC_CONFIDENCE_METRIC_KEYS ="
);
assert.match(
  liveRecommendationProjection,
  /\["version", "eligible", "statisticsTrack", "dataCoverageWarning"\]/,
  "current list live recommendation projection must use the four-field allowlist"
);

const publicConfidenceProjection = section(
  "const CURRENT_LIST_PUBLIC_CONFIDENCE_METRIC_KEYS =",
  "const compactPredictionForCurrentList ="
);
for (const field of [
  "modelProbability",
  "evidenceCompleteness",
  "evidenceCompletenessBasis",
  "marketConsistency",
  "marketConsistencyBasis",
  "calibrationSample",
  "freshnessQuality",
  "freshnessObservedAt",
  "freshnessSourceUpdatedAt",
  "freshnessAsOf",
  "freshnessAgeSeconds",
  "freshnessSource",
  "freshnessBasis",
]) {
  assert.match(publicConfidenceProjection, new RegExp(`"${field}"`), `list confidence lost ${field}`);
}
assert.match(
  publicConfidenceProjection,
  /\? \{ publicMetrics: compact \}/,
  "current list confidence must be wrapped only as publicMetrics"
);
assert.doesNotMatch(
  publicConfidenceProjection,
  /\b(?:available|band|score|components|penalties|unavailableReasons|priceIndependent)\b/,
  "current list confidence must not expose internal confidence fields"
);
for (const unusedPublicMetric of ["dataQuality", "evidenceScore", "freshnessEvaluatedAt"]) {
  assert.doesNotMatch(
    publicConfidenceProjection,
    new RegExp(`"${unusedPublicMetric}"`),
    `current list confidence must not carry unused public metric ${unusedPublicMetric}`
  );
}
assert.doesNotMatch(
  publicConfidenceProjection,
  /\.\.\.(?:confidence|source|compact)/,
  "current list confidence must use an explicit scalar allowlist"
);

const { compactPublicConfidenceForCurrentList } = Function(
  `${publicConfidenceProjection}; return { compactPublicConfidenceForCurrentList };`
)();
const compactedConfidence = compactPublicConfidenceForCurrentList({
  available: true,
  band: "high",
  score: 91,
  components: { hidden: 1 },
  publicMetrics: {
    modelProbability: 0.41,
    evidenceCompleteness: 0.5,
    marketConsistency: "aligned",
    dataQuality: 0.99,
    evidenceScore: 0.88,
  },
});
assert.deepEqual(
  compactedConfidence,
  {
    publicMetrics: {
      modelProbability: 0.41,
      evidenceCompleteness: 0.5,
      marketConsistency: "aligned",
    },
  },
  "API compaction must expose the v4 selected-direction probability and no internal or unused facts"
);
assert.equal(
  compactPublicConfidenceForCurrentList({
    publicMetrics: { modelProbability: 1.01 },
  }),
  undefined,
  "out-of-range model probability must fail closed"
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
assert.match(
  predictionListProjection,
  /confidence:\s*compactPublicConfidenceForCurrentList\(prediction\.confidence\)/,
  "current list must carry the audited public confidence facts"
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
  "liveScore",
  "sourceObservedAt",
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
assert.match(
  listMetaProjection,
  /immutableAnalysisReferenceDecision:\s*compactVerifiedImmutableAnalysisReference\(match\)/,
  "current list lost the server-attested immutable analysis reference"
);

const detailModelProjection = section(
  "const normalizeProbabilityModelForDetail =",
  "const compactVerifiedDualMarketDecision ="
);
// Details retain public model fields, but raw execution receipts must remain
// admin-only. The previous textual ...model assertion contradicted that policy.
const normalizeDetailModel = Function("normalizeProbabilityLaneForDetail", "finiteNumberOrNull",
  `${detailModelProjection}; return normalizeProbabilityModelForDetail;`
)(value => value, value => typeof value === "number" && Number.isFinite(value) ? value : null);
const detailedModel = normalizeDetailModel({ version: "public-test-version", publicExtra: { retained: true },
  inputUsage: { privateExecutionReceipt: "MUST_NOT_LEAK" } });
assert.equal(detailedModel.version, "public-test-version", "details retain public model version");
assert.deepEqual(detailedModel.publicExtra, { retained: true }, "details retain other public model fields");
assert.equal(Object.hasOwn(detailedModel, "inputUsage"), false, "raw execution receipts must not enter public details");
assert.equal(JSON.stringify(detailedModel).includes("MUST_NOT_LEAK"), false, "private receipt values must not leak");

const detailMatchProjection = section(
  "const normalizeMatchForDetailPayload =",
  "const compactPredictionMeta ="
);
assert.match(detailMatchProjection, /\.\.\.match,/, "detail payload must retain the full match object");
assert.match(
  detailMatchProjection,
  /immutableAnalysisReferenceDecision:\s*compactVerifiedImmutableAnalysisReference\(match\)/,
  "detail payload must expose the same server-attested immutable analysis reference"
);
assert.match(
  detailMatchProjection,
  /probabilityModel:\s*normalizeProbabilityModelForDetail\(match\.probabilityModel\)/,
  "detail payload must continue using the full detail probability normalizer"
);

const qualityProjection = section("const compactPreMatchQualityForList =", "const compactProbabilityTripletForList =");
const projectQuality = Function(`${qualityProjection}; return compactPreMatchQualityForList;`)();
const serialize = value => JSON.parse(JSON.stringify(value));
const clock = "2026-09-09T03:00:00.000Z";
const quality = { score: 36, sourceQuality: "low", severeMissingCount: 2,
  missing: [{ key: "injuries", zh: "缺少伤停", en: "Missing injuries", severity: "medium" }],
  notYetPublishable: [{ key: "lineup", zh: "首发未公布", en: "Lineup not published", expectedPublishedAt: clock }],
  components: {
    injuries: { label: { zh: "伤停", en: "Injuries" }, status: "missing", score: 0, source: "missing",
      availabilityState: "missing_overdue", eligibleAtCutoff: false, sourceObservedAt: null, expectedPublishedAt: null, confirmed: false },
    lineup: { status: "verified", score: 100, source: "official", evidenceType: "confirmed-lineup",
      note: { zh: "已确认", en: "Confirmed" }, availabilityState: "verified_pre_cutoff", eligibleAtCutoff: true,
      sourceObservedAt: clock, expectedPublishedAt: clock, confirmed: true },
  } };
const originalQuality = structuredClone(quality);
const compactQuality = serialize(projectQuality(quality));
assert.equal(compactQuality.score, 36);
assert.equal(compactQuality.sourceQuality, "low");
assert.equal(compactQuality.severeMissingCount, 2);
assert.deepEqual(compactQuality.missing, quality.missing);
assert.equal(compactQuality.notYetPublishable[0].expectedPublishedAt, clock);
assert.deepEqual(compactQuality.components.injuries, { label: quality.components.injuries.label,
  status: "missing", availabilityState: "missing_overdue", eligibleAtCutoff: false });
assert.deepEqual(compactQuality.components.lineup, { status: "verified", note: quality.components.lineup.note,
  evidenceType: "confirmed-lineup", availabilityState: "verified_pre_cutoff", eligibleAtCutoff: true,
  sourceObservedAt: clock, expectedPublishedAt: clock, confirmed: true });
assert.equal(compactQuality.components.injuries.confirmed === true, false);
assert.deepEqual(quality, originalQuality, "list projection cannot mutate detail/source evidence");
assert.deepEqual(serialize(projectQuality(compactQuality)), compactQuality, "projection remains idempotent");

console.log("Current list payload compaction source and quality wire contracts passed.");
