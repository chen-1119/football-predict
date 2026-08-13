const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data");

const allowedTiers = new Set(["stable", "watch", "degraded"]);
const tierRank = { stable: 0, watch: 1, degraded: 2 };

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const asNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const maxReasonTier = (reasons) => {
  const rows = Array.isArray(reasons) ? reasons : [];
  return rows.reduce((tier, reason) => (
    tierRank[reason?.tier] > tierRank[tier] ? reason.tier : tier
  ), "stable");
};

const bucketTierIsValid = (bucket) => {
  if (!allowedTiers.has(bucket?.tier)) return false;
  const rows = asNumber(bucket?.rows, 0);
  const error = Number(bucket?.calibrationError);
  if (rows < 10 || (Number.isFinite(error) && error > 0.3)) return bucket.tier === "degraded";
  if (rows < 30 || (Number.isFinite(error) && error > 0.1)) return bucket.tier === "watch";
  return bucket.tier === "stable";
};

const run = () => {
  const checks = [];
  const publicEvaluation = readJson(path.join(publicDataDir, "model-evaluation.json"));
  const serverEvaluation = readJson(path.join(serverDataDir, "model-artifacts", "evaluation.json"));
  const riskTiers = publicEvaluation?.riskTiers || null;
  const serverRiskTiers = serverEvaluation?.riskTiers || null;
  const confidenceBuckets = Array.isArray(riskTiers?.confidenceBuckets?.buckets)
    ? riskTiers.confidenceBuckets.buckets
    : [];
  const recommendationBuckets = Array.isArray(riskTiers?.recommendationBuckets)
    ? riskTiers.recommendationBuckets
    : [];
  const shadowRecommendationBuckets = Array.isArray(riskTiers?.shadowRecommendationBuckets)
    ? riskTiers.shadowRecommendationBuckets
    : [];
  const reasons = Array.isArray(riskTiers?.overall?.reasons) ? riskTiers.overall.reasons : [];
  const calibrationBucketCount = Object.keys(publicEvaluation?.probabilityMetrics?.calibrationByConfidence || {}).length;

  pushCheck(checks, "model risk tier artifact available", riskTiers?.version === "model-risk-tier-v1"
    && allowedTiers.has(riskTiers?.overall?.tier), {
      evaluationVersion: publicEvaluation?.version || null,
      riskVersion: riskTiers?.version || null,
      overallTier: riskTiers?.overall?.tier || null,
      generatedAt: riskTiers?.generatedAt || null
    });
  pushCheck(checks, "server and public risk tiers mirror", Boolean(riskTiers && serverRiskTiers)
    && publicEvaluation?.version === serverEvaluation?.version
    && publicEvaluation?.generatedAt === serverEvaluation?.generatedAt
    && sameJson(riskTiers, serverRiskTiers), {
      publicGeneratedAt: publicEvaluation?.generatedAt || null,
      serverGeneratedAt: serverEvaluation?.generatedAt || null
    });
  pushCheck(checks, "overall tier follows highest reason severity", reasons.length > 0
    && riskTiers?.overall?.tier === maxReasonTier(reasons), {
      overallTier: riskTiers?.overall?.tier || null,
      maxReasonTier: maxReasonTier(reasons),
      reasonCodes: reasons.map((reason) => reason.code).filter(Boolean)
    });
  pushCheck(checks, "risk policy cannot override probabilities", riskTiers?.policy?.probabilityOverride === false
    && String(riskTiers?.policy?.onlineEffect || "").includes("advisory")
    && String(riskTiers?.policy?.llmBoundary || "").includes("cannot override model probabilities"), {
      policy: riskTiers?.policy || null
    });
  pushCheck(checks, "confidence bucket risks match calibration buckets", confidenceBuckets.length > 0
    && riskTiers?.confidenceBuckets?.bucketCount === calibrationBucketCount
    && confidenceBuckets.every(bucketTierIsValid), {
      riskBucketCount: riskTiers?.confidenceBuckets?.bucketCount ?? null,
      calibrationBucketCount,
      buckets: confidenceBuckets.map((bucket) => ({
        id: bucket.id,
        tier: bucket.tier,
        rows: bucket.rows,
        calibrationError: bucket.calibrationError
      }))
    });
  pushCheck(checks, "market comparison risk summary is present", riskTiers?.marketComparison?.rows === publicEvaluation?.sample?.marketBaselineRows
    && riskTiers.marketComparison?.bestShadowCandidate?.id === publicEvaluation?.shadowCandidates?.bestCandidateId, {
      marketRows: riskTiers?.marketComparison?.rows ?? null,
      sampleMarketRows: publicEvaluation?.sample?.marketBaselineRows ?? null,
      bestCandidateId: riskTiers?.marketComparison?.bestShadowCandidate?.id || null
    });
  const clv = publicEvaluation?.closingLineValue || {};
  const riskClv = riskTiers?.closingLineValue || {};
  pushCheck(checks, "closing-line risk uses only distinct later observations",
    clv?.version === "closing-line-value-v2"
    && riskClv?.version === clv.version
    && riskClv?.timingAudit?.version === "closing-line-timing-audit-v1"
    && asNumber(clv?.candidateRows, -1) >= asNumber(clv?.rows, 0)
    && asNumber(riskClv?.candidateRows, -1) === asNumber(clv?.candidateRows, -2)
    && asNumber(riskClv?.rows, -1) === asNumber(clv?.rows, -2)
    && asNumber(publicEvaluation?.sample?.clvRows, -1) === asNumber(clv?.rows, -2)
    && asNumber(publicEvaluation?.sample?.clvCandidateRows, -1) === asNumber(clv?.candidateRows, -2)
    && asNumber(publicEvaluation?.sample?.clvTimingCoverage, -1) === asNumber(clv?.timingCoverage, -2), {
      clvVersion: clv?.version || null,
      timingVersion: riskClv?.timingAudit?.version || null,
      eligibleRows: clv?.rows ?? null,
      candidateRows: clv?.candidateRows ?? null,
      timingCoverage: clv?.timingCoverage ?? null,
      sample: {
        clvRows: publicEvaluation?.sample?.clvRows ?? null,
        clvCandidateRows: publicEvaluation?.sample?.clvCandidateRows ?? null,
        clvTimingCoverage: publicEvaluation?.sample?.clvTimingCoverage ?? null
      }
    });
  const recommendationSampleMissing = reasons.some((reason) => reason?.code === "recommendation-sample-missing");
  pushCheck(checks, "recommendation bucket risks are compact or explicitly unavailable", (recommendationBuckets.length > 0
    && recommendationBuckets.every((bucket) => bucket.scope === "formal" && allowedTiers.has(bucket.tier) && !Array.isArray(bucket.rows)))
    || (recommendationBuckets.length === 0 && recommendationSampleMissing && riskTiers?.overall?.tier !== "stable"), {
      bucketCount: recommendationBuckets.length,
      recommendationSampleMissing,
      buckets: recommendationBuckets.map((bucket) => ({
        id: bucket.id,
        tier: bucket.tier,
        settled: bucket.settled
      }))
    });
  const formalBucketSettled = recommendationBuckets.reduce((sum, bucket) => sum + asNumber(bucket?.settled, 0), 0);
  const shadowBucketSettled = shadowRecommendationBuckets.reduce((sum, bucket) => sum + asNumber(bucket?.settled, 0), 0);
  pushCheck(checks, "formal and shadow recommendation bucket scopes stay separate",
    riskTiers?.recommendationBucketScope === "formal"
    && riskTiers?.shadowRecommendationBucketScope === "shadow"
    && shadowRecommendationBuckets.every((bucket) => bucket.scope === "shadow" && allowedTiers.has(bucket.tier))
    && formalBucketSettled === asNumber(publicEvaluation?.recommendationMetrics?.total?.settled, 0)
    && shadowBucketSettled === asNumber(publicEvaluation?.shadowRecommendationMetrics?.total?.settled, 0), {
      formalBucketSettled,
      formalMetricSettled: publicEvaluation?.recommendationMetrics?.total?.settled ?? null,
      shadowBucketSettled,
      shadowMetricSettled: publicEvaluation?.shadowRecommendationMetrics?.total?.settled ?? null,
      formalScope: riskTiers?.recommendationBucketScope || null,
      shadowScope: riskTiers?.shadowRecommendationBucketScope || null
    });
  pushCheck(checks, "risk artifact does not expose row-level samples", !Array.isArray(riskTiers?.rows)
    && !Array.isArray(riskTiers?.inputRows)
    && !Array.isArray(riskTiers?.probabilityRows)
    && !Array.isArray(riskTiers?.predictionRows), {
      hasRows: Array.isArray(riskTiers?.rows),
      hasInputRows: Array.isArray(riskTiers?.inputRows),
      hasProbabilityRows: Array.isArray(riskTiers?.probabilityRows),
      hasPredictionRows: Array.isArray(riskTiers?.predictionRows)
    });

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    summary: {
      evaluationVersion: publicEvaluation?.version || null,
      generatedAt: publicEvaluation?.generatedAt || null,
      riskVersion: riskTiers?.version || null,
      overallTier: riskTiers?.overall?.tier || null,
      confidenceBucketCount: confidenceBuckets.length,
      recommendationBucketCount: recommendationBuckets.length,
      shadowRecommendationBucketCount: shadowRecommendationBuckets.length,
      maxCalibrationError: riskTiers?.confidenceBuckets?.maxCalibrationError ?? null
    },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run();
