"use strict";

const path = require("node:path");
const { readChunkedJsonFile } = require("../server/chunkedJsonFile.cjs");
const { PRECISION_POLICY } = require("../src/services/recommendationPrecisionPolicy.cjs");

const historyPath = path.resolve(
  process.env.PRECISION_AUDIT_HISTORY_PATH
  || path.join(__dirname, "..", "public", "data", "matches-history.json")
);

const finite = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const archivedPrediction = (match) => {
  const archive = match?.archivedPreMatchPrediction;
  const prediction = archive?.prediction;
  const capturedAt = Date.parse(archive?.capturedAt || "");
  const kickoffAt = Date.parse(match?.kickoffTime || "");
  if (
    archive?.version !== "archived-pre-match-prediction-v1"
    || archive?.source !== "immutable-pre-match-prediction-snapshot"
    || !prediction
    || prediction.marketType !== "BEST"
    || !["HAD", "HHAD"].includes(prediction.oddsPoolCode)
    || !["1", "X", "2"].includes(prediction.tipCode)
    || !Number.isFinite(capturedAt)
    || !Number.isFinite(kickoffAt)
    || capturedAt >= kickoffAt
  ) return null;
  return prediction;
};

const actualCode = (match, prediction) => {
  if (!Number.isInteger(match?.scoreHome) || !Number.isInteger(match?.scoreAway)) return null;
  let home = Number(match.scoreHome);
  const away = Number(match.scoreAway);
  if (prediction.oddsPoolCode === "HHAD") {
    const line = Number(String(prediction.handicapLine ?? "").trim());
    if (!Number.isSafeInteger(line)) return null;
    home += line;
  }
  return home > away ? "1" : home < away ? "2" : "X";
};

const isBaselineFormal = (prediction) => Boolean(
  prediction
  && prediction.recommendationAction === "recommend"
  && prediction.recommendationTier === "main"
  && Number(prediction.odds) > 1
);

const passesArchivedPrecisionGate = (prediction) => {
  const market = prediction?.oddsPoolCode;
  const policy = PRECISION_POLICY[market];
  const evidence = prediction?.multiFactorEvidence;
  if (!policy || !evidence || evidence.eligible !== true || (evidence.blockers || []).length > 0) return false;
  const odds = finite(prediction.odds);
  const modelProbability = finite(evidence.modelProbability);
  const dataQuality = finite(evidence.dataQuality);
  const expectedValue = finite(evidence.expectedValue);
  const probabilityEdge = finite(evidence.probabilityEdge);
  const evidenceScore = finite(evidence.evidenceScore);
  const supportingFactors = Array.isArray(evidence.supportingFactors) ? evidence.supportingFactors.length : 0;
  const severeMissingCount = Math.max(0, Math.trunc(finite(evidence.diagnostics?.severeMissingCount) || 0));
  if (odds === null || odds <= 1 || odds > policy.maxOdds) return false;
  if (modelProbability === null || modelProbability < policy.minModelProbability) return false;
  if (dataQuality === null || dataQuality < policy.minDataQuality) return false;
  if (expectedValue === null || expectedValue < policy.minExpectedValue) return false;
  if (probabilityEdge === null || probabilityEdge < policy.minProbabilityEdge) return false;
  if (evidenceScore === null || evidenceScore < policy.minEvidenceScore) return false;
  if (supportingFactors < policy.minSupportingFactors) return false;
  if (severeMissingCount > policy.maxSevereMissingCount) return false;
  if (policy.requireMarketLeaderAlignment && evidence.diagnostics?.marketLeaderAligned !== true) return false;
  if (policy.requireHandicapAlignment && evidence.diagnostics?.handicapAligned !== true) return false;
  if (evidence.diagnostics?.trendContradicts === true) return false;
  if (evidence.diagnostics?.externalMarketContradicted === true) return false;
  return true;
};

const emptyBucket = () => ({ settled: 0, won: 0, lost: 0, hitRate: null });
const settleBucket = (bucket) => ({
  ...bucket,
  hitRate: bucket.settled > 0 ? bucket.won / bucket.settled : null,
});

const push = (bucket, won) => {
  bucket.settled += 1;
  if (won) bucket.won += 1;
  else bucket.lost += 1;
};

const oddsBucket = (odds) => odds <= 1.50 ? "<=1.50"
  : odds <= 1.70 ? "1.51-1.70"
    : odds <= 2.05 ? "1.71-2.05"
      : odds <= 2.60 ? "2.06-2.60"
        : ">2.60";

function main() {
  const rows = readChunkedJsonFile(historyPath).value;
  if (!Array.isArray(rows)) throw new Error("matches-history must be an array");

  const baseline = emptyBucket();
  const precision = emptyBucket();
  const baselineByMarket = { HAD: emptyBucket(), HHAD: emptyBucket() };
  const precisionByMarket = { HAD: emptyBucket(), HHAD: emptyBucket() };
  const baselineByOdds = {};
  const precisionByOdds = {};

  for (const match of rows) {
    if (match?.status !== "FINISHED" || match?.resultDisposition === "VOID") continue;
    const prediction = archivedPrediction(match);
    if (!isBaselineFormal(prediction)) continue;
    const actual = actualCode(match, prediction);
    if (!actual) continue;
    const won = prediction.tipCode === actual;
    const market = prediction.oddsPoolCode;
    const bucket = oddsBucket(Number(prediction.odds));
    baselineByOdds[bucket] ||= emptyBucket();
    push(baseline, won);
    push(baselineByMarket[market], won);
    push(baselineByOdds[bucket], won);

    if (!passesArchivedPrecisionGate(prediction)) continue;
    precisionByOdds[bucket] ||= emptyBucket();
    push(precision, won);
    push(precisionByMarket[market], won);
    push(precisionByOdds[bucket], won);
  }

  const finalizeMap = (value) => Object.fromEntries(
    Object.entries(value).map(([key, bucket]) => [key, settleBucket(bucket)])
  );
  const baselineFinal = settleBucket(baseline);
  const precisionFinal = settleBucket(precision);
  const output = {
    ok: true,
    version: "recommendation-precision-audit-v1",
    source: historyPath,
    exactPolicyReplay: false,
    replayNote: "Archived evidence does not guarantee every transient runtime field (notably modelGap/risk penalties); this audit applies all precision gates that are immutably stored.",
    baseline: {
      overall: baselineFinal,
      byMarket: finalizeMap(baselineByMarket),
      byOdds: finalizeMap(baselineByOdds),
    },
    precision: {
      overall: precisionFinal,
      byMarket: finalizeMap(precisionByMarket),
      byOdds: finalizeMap(precisionByOdds),
    },
    delta: {
      recommendations: precisionFinal.settled - baselineFinal.settled,
      hitRate: baselineFinal.hitRate !== null && precisionFinal.hitRate !== null
        ? precisionFinal.hitRate - baselineFinal.hitRate
        : null,
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { archivedPrediction, actualCode, passesArchivedPrecisionGate };
