const fs = require("node:fs");
const path = require("node:path");

const {
  buildPredictionReviewRows,
  predictionFromSnapshotTip,
  predictionSetWithoutOfficialOdds,
} = require("./syncData.cjs");

const rootDir = path.resolve(__dirname, "..");
const readJson = (relativePath, fallback = null) => {
  try {
    const filePath = path.isAbsolute(relativePath) ? relativePath : path.join(rootDir, relativePath);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const evaluation = readJson(
  process.env.MODEL_EVALUATION_FILE || "public/data/model-evaluation.json",
  {},
);
const strategy = readJson("public/data/model-strategy.json", {});
const currentMatches = readJson(
  process.env.RECOMMENDATION_ELIGIBILITY_CURRENT_MATCHES_FILE
    || "public/data/matches-current.json",
  [],
);
const displayRecommendationSource = fs.readFileSync(
  path.join(rootDir, "src/services/displayRecommendation.ts"),
  "utf8"
);
const predictionsListSource = fs.readFileSync(
  path.join(rootDir, "src/pages/PredictionsList.tsx"),
  "utf8"
);
const bestTipsSource = fs.readFileSync(
  path.join(rootDir, "src/pages/BestTips.tsx"),
  "utf8"
);
const analysisReferenceSelectionSource = fs.readFileSync(
  path.join(rootDir, "src/services/analysisReferenceSelection.ts"),
  "utf8"
);
const officialEligibilitySource = fs.readFileSync(
  path.join(rootDir, "src/services/officialRecommendationEligibility.cjs"),
  "utf8"
);
const matchDetailSource = fs.readFileSync(path.join(rootDir, "src/pages/MatchDetail.tsx"), "utf8");
const worldCupSource = fs.readFileSync(path.join(rootDir, "src/pages/WorldCup.tsx"), "utf8");
const recommendationCopySource = fs.readFileSync(path.join(rootDir, "src/services/recommendationCopy.ts"), "utf8");
const backtestSource = fs.readFileSync(
  path.join(rootDir, "scripts/runModelBacktest.cjs"),
  "utf8"
);

const checks = [];
const check = (name, ok, details = {}, contractId = null) => checks.push({ name, ok: Boolean(ok), ...details, ...(contractId ? { contractId } : {}) });
const selection = evaluation?.recommendationSelection || {};
const before = selection.before || {};
const after = selection.after || {};
const windows = Array.isArray(selection.rollingWindows) ? selection.rollingWindows : [];
const ROLLING_WINDOW_LIMIT = 6;

const validateRollingWindowPartition = ({ rollingWindows, settledRows }) => {
  if (!Array.isArray(rollingWindows)) return false;
  const sampleRows = Number(settledRows);
  if (!Number.isInteger(sampleRows) || sampleRows < 0) return false;
  const expectedWindowCount = Math.min(ROLLING_WINDOW_LIMIT, sampleRows);
  if (rollingWindows.length !== expectedWindowCount) return false;

  let partitionRows = 0;
  let previousEnd = null;
  for (let index = 0; index < rollingWindows.length; index += 1) {
    const window = rollingWindows[index];
    const windowRows = Number(window?.before?.settled);
    const start = Date.parse(window?.startKickoffTime);
    const end = Date.parse(window?.endKickoffTime);
    if (Number(window?.index) !== index + 1
      || !Number.isInteger(windowRows)
      || windowRows < 1
      || !Number.isFinite(start)
      || !Number.isFinite(end)
      || start > end
      || (previousEnd !== null && previousEnd > start)) return false;
    partitionRows += windowRows;
    previousEnd = end;
  }
  return partitionRows === sampleRows;
};

const syntheticRollingWindow = (index, startKickoffTime, endKickoffTime, settled) => ({
  index,
  startKickoffTime,
  endKickoffTime,
  before: { settled },
});
const singleSampleWindows = [syntheticRollingWindow(
  1,
  "2026-07-15T03:00:00+08:00",
  "2026-07-15T03:00:00+08:00",
  1,
)];
const eightSampleWindows = [
  syntheticRollingWindow(1, "2026-07-01T01:00:00Z", "2026-07-01T01:00:00Z", 1),
  syntheticRollingWindow(2, "2026-07-02T01:00:00Z", "2026-07-02T01:00:00Z", 1),
  syntheticRollingWindow(3, "2026-07-03T01:00:00Z", "2026-07-04T01:00:00Z", 2),
  syntheticRollingWindow(4, "2026-07-05T01:00:00Z", "2026-07-05T01:00:00Z", 1),
  syntheticRollingWindow(5, "2026-07-06T01:00:00Z", "2026-07-06T01:00:00Z", 1),
  syntheticRollingWindow(6, "2026-07-07T01:00:00Z", "2026-07-08T01:00:00Z", 2),
];

check("one settled sample yields one valid point window",
  validateRollingWindowPartition({ rollingWindows: singleSampleWindows, settledRows: 1 })
  && !validateRollingWindowPartition({ rollingWindows: [], settledRows: 1 }));
check("six-window partition remains strict once at least six samples exist",
  validateRollingWindowPartition({ rollingWindows: eightSampleWindows, settledRows: 8 })
  && !validateRollingWindowPartition({ rollingWindows: eightSampleWindows.slice(0, 5), settledRows: 8 })
  && !validateRollingWindowPartition({
    rollingWindows: eightSampleWindows.map((window, index) => (index === 3
      ? { ...window, startKickoffTime: "2026-07-03T12:00:00Z" }
      : window)),
    settledRows: 8,
  }));

const settledReviewFixture = {
  homeTeamName: "Home",
  awayTeamName: "Away",
  scoreHome: 1,
  scoreAway: 0,
  handicapLine: "-1",
};
const legacyReview = buildPredictionReviewRows({
  ...settledReviewFixture,
  predictions: [{ marketType: "BEST", oddsPoolCode: "HAD", tipCode: "1", odds: 1.5 }],
}, { had: "1", hhad: "X", overUnder25: "U2.5", btts: "NG" });
check("legacy BEST without canonical evidence is review-only", legacyReview.length === 1
  && legacyReview[0].reviewRole === "reference"
  && legacyReview[0].recommendationAction === "reference");
const legacySnapshotPrediction = predictionFromSnapshotTip({
  signature: "BEST:HAD:1",
  best: { tipCode: "1", odds: 1.5 },
}, "BEST");
check("legacy snapshot action defaults to reference", legacySnapshotPrediction?.recommendationAction === "reference"
  && legacySnapshotPrediction?.recommendationTier === "reference");

const currentMatchRows = Array.isArray(currentMatches) ? currentMatches : [];
// Production serves the current slate from SQLite and may intentionally ship
// an empty static matches-current.json. The policy verifier must therefore
// own its no-SP fixtures instead of sampling mutable live rows. A release
// worker can replace matches-current.json while readiness is running; mixing
// those rows into this policy unit check made the result depend on timing and
// could roll back an otherwise healthy release. These rows contain no result,
// odds, ranking or historical evidence, so they can only exercise the
// fail-closed cold-start reference path.
const deterministicModelOnlyFixtures = Array.from({ length: 4 }, (_, index) => ({
  id: `model-only-verifier-${index + 1}`,
  sourceMatchId: `model-only-verifier-${index + 1}`,
  status: "SCHEDULED",
  kickoffTime: `2099-01-0${index + 1}T12:00:00.000Z`,
  leagueName: "Verifier fixture league",
  homeTeam: `Verifier home ${index + 1}`,
  homeTeamName: `Verifier home ${index + 1}`,
  awayTeam: `Verifier away ${index + 1}`,
  awayTeamName: `Verifier away ${index + 1}`,
  odds: null,
  handicapLine: null,
  handicapOdds: null,
}));
const modelOnlyMatches = deterministicModelOnlyFixtures;
const regeneratedModelOnlyRows = modelOnlyMatches.flatMap((match) => {
  const bundle = predictionSetWithoutOfficialOdds(match);
  return (bundle?.predictions || []).map((prediction) => ({
    matchId: match.id,
    inputSufficiency: bundle?.probabilityModel?.inputSufficiency || null,
    prediction,
  }));
});
const regeneratedBestRows = regeneratedModelOnlyRows.filter((row) => row.prediction.marketType === "BEST");

check("model-only fixtures are exercised independently of the runtime slate",
  modelOnlyMatches === deterministicModelOnlyFixtures
  && modelOnlyMatches.length === 4
  && modelOnlyMatches.every((match) => String(match.id || "").startsWith("model-only-verifier-")), {
  staticCurrentMatches: currentMatchRows.length,
  matches: modelOnlyMatches.length,
  deterministicFixtures: deterministicModelOnlyFixtures.length,
  isolatedFromRuntimeSlate: modelOnlyMatches === deterministicModelOnlyFixtures
});
check("model-only BEST rows withhold insufficient inputs while auditable model-only references remain available", regeneratedBestRows.length === modelOnlyMatches.length
  && regeneratedBestRows.every(({ prediction, inputSufficiency }) => (
    prediction.recommendationAction === "reference"
    && Number(prediction.odds || 0) === 0
    && prediction.resultStatus === "PENDING"
    && (inputSufficiency?.sufficient === true
      ? prediction.recommendationTier === "model-only-watch" && ["1", "X", "2"].includes(prediction.tipCode)
      : prediction.recommendationTier === "input-insufficient-watch" && prediction.tipCode === "WATCH")
  )), { rows: regeneratedBestRows.map(({ matchId, prediction, inputSufficiency }) => ({
    matchId,
    inputSufficient: inputSufficiency?.sufficient ?? null,
    action: prediction.recommendationAction,
    tier: prediction.recommendationTier,
    odds: prediction.odds,
    resultStatus: prediction.resultStatus,
    tipCode: prediction.tipCode
  })) }, "model-only-input-sufficiency-v2");
check("no model-only row is actionable", regeneratedModelOnlyRows.every(({ prediction }) => (
  prediction.recommendationAction !== "recommend"
  && prediction.resultStatus === "PENDING"
  && Number(prediction.odds || 0) === 0
)));

check("frontend keeps formal gates while reference directions remain separately visible without official SP",
  displayRecommendationSource.includes("getOfficialRecommendationHandicapLine(match, prediction)")
  && predictionsListSource.includes("if (!storedBest || !isPredictionOfficialResultPoolAvailable(match, storedBest)) return null")
  && predictionsListSource.includes("getOfficialPredictionHandicapLine(match, storedBest)")
  && predictionsListSource.includes("getOnSaleAnalysisReference(match")
  && analysisReferenceSelectionSource.includes("isModelOnlyAnalysisReferenceEligible(match, storedBest, now)")
  && analysisReferenceSelectionSource.includes("recommendationAction: 'reference'")
  && bestTipsSource.includes("const formalPrediction = formalPresentationAllowed && isBeforeMatchSaleCutoff(match, now)")
  && bestTipsSource.includes("const reference = selectOnSaleAnalysisReference(match, { allowModelOnly: false, now })")
  && bestTipsSource.includes("observation: { zh: '数据推荐', en: 'Data pick' }")
  && bestTipsSource.includes("const featuredMatchIds = React.useMemo(() => new Set(")
  && bestTipsSource.includes("tipCards.map((card)")
  && bestTipsSource.includes("市场去水概率")
  && predictionsListSource.includes("return language === 'zh' ? '数据推荐' : 'Data pick';")
  && predictionsListSource.includes("来源与正式战绩分轨")
  && predictionsListSource.includes("500/external reference prices")
  && predictionsListSource.includes("excluded from the formal record and parlays")
  && predictionsListSource.includes("no official SP is on sale")
  && predictionsListSource.includes("Data pick")
  && officialEligibilitySource.includes("prediction.recommendationAction === 'recommend'")
  && officialEligibilitySource.includes("Number.isFinite(odds)")
  && officialEligibilitySource.includes("odds > 1")
  && officialEligibilitySource.includes("recommendationLinesMatch(prediction, evidence, currentOfficialHandicapLine)")
  && !displayRecommendationSource.includes("const getHandicapOverride =")
  && recommendationCopySource.includes("isFormalRecommendationPrediction(match, prediction)")
  && matchDetailSource.includes("isFormalPrimaryRecommendation")
  && matchDetailSource.includes("分析参考")
  && worldCupSource.includes("copy.analysisReference[language]")
  && !worldCupSource.includes("actionablePrediction")
  && !bestTipsSource.includes("observation: { zh: '观察'")
  && !bestTipsSource.includes("language === 'zh' ? '观察' : 'Watch'")
  && !predictionsListSource.includes("return language === 'zh' ? '观察' : 'Watch'"));
check("recommendation denominator has no unknown SP", Number(before.missingOddsRows || 0) === 0
  && Number(after.missingOddsRows || 0) === 0
  && Number(evaluation?.recommendationMetrics?.total?.missingOddsRows || 0) === 0, {
  beforeMissing: before.missingOddsRows,
  afterMissing: after.missingOddsRows,
  activeMissing: evaluation?.recommendationMetrics?.total?.missingOddsRows
});
check("non-promotion result observations stay outside the selection denominator",
  Number(selection.sourceRows || 0) >= Number(selection.promotionResultRows || 0)
  && Number(selection.excludedResultObservationRows || 0)
    === Number(selection.sourceRows || 0) - Number(selection.promotionResultRows || 0)
  && backtestSource.includes("row?.resultObservationPromotionEligible === true")
  && backtestSource.includes("excludedIneligibleResultObservation")
  && backtestSource.includes("resultObservationPromotionEligible")
  && backtestSource.includes("promotionCohortEligible: decisionClockEligible && resultObservationPromotionEligible"), {
  sourceRows: selection.sourceRows ?? null,
  promotionResultRows: selection.promotionResultRows ?? null,
  excludedResultObservationRows: selection.excludedResultObservationRows ?? null,
  auditExcludedRows: evaluation?.sample?.recommendationEligibilityAudit
    ?.excludedIneligibleResultObservation ?? null
});
check("multi-factor shadow reports coverage without using an SP ceiling", selection.version === "multi-factor-selection-shadow-v3"
  && selection.hardMaxSp === null
  && Number(selection.coverage) >= 0
  && Number(selection.coverage) <= 1
  && Number(selection.lowSpRejected || 0) >= 0
  && Number(selection.highSpCandidates || 0) >= 0, {
  beforeSettled: before.settled,
  afterSettled: after.settled,
  coverage: selection.coverage,
  hitRateSpOnly: selection.spOnlyBaseline?.hitRate,
  hitRateAfter: after.hitRate,
  hitRateDeltaVsSpOnly: selection.hitRateDeltaVsSpOnly,
  highSpCandidates: selection.highSpCandidates,
  lowSpRejected: selection.lowSpRejected
});
const hasSettledSelectionSample = Number(before.settled || 0) > 0;
check("selection comparison is same-snapshot or explicitly unavailable", (!hasSettledSelectionSample
  ? Number(before?.selectedEventScoring?.model?.rows || 0) === 0
    && Number(selection?.spOnlyBaseline?.selectedEventScoring?.model?.rows || 0) === 0
    && selection?.gate?.eligible === false
  : Number(before?.selectedEventScoring?.model?.rows || 0) > 0
    && Number(selection?.spOnlyBaseline?.selectedEventScoring?.model?.rows || 0) > 0)
  && Number(before?.selectedEventScoring?.deviggedMarket?.rows || 0) === Number(before.settled || 0)
  && Number(selection?.spOnlyBaseline?.selectedEventScoring?.deviggedMarket?.rows || 0) === Number(selection?.spOnlyBaseline?.settled || 0)
  && Number(after?.selectedEventScoring?.deviggedMarket?.rows || 0) === Number(after.settled || 0));
check("rolling windows are chronological and non-overlapping",
  validateRollingWindowPartition({ rollingWindows: windows, settledRows: before.settled })
  && (!hasSettledSelectionSample ? selection?.gate?.eligible === false : true)
  && backtestSource.includes(".sort(compareRecommendationSelectionRows)")
  && backtestSource.includes("recommendationSelectionKickoffEpoch")
  && backtestSource.includes("invalid-kickoff-time:")
  && backtestSource.includes("const windowCount = Math.min(6, sortedRows.length);")
  && backtestSource.includes('split: "six non-overlapping chronological windows; no random split"'), { windows: windows.map((window) => ({
    start: window.startKickoffTime,
    end: window.endKickoffTime,
    spOnlySettled: window.spOnly?.settled,
    afterSettled: window.after?.settled,
    hitRateDeltaVsSpOnly: window.hitRateDeltaVsSpOnly
  })) });
check("insufficient samples remain shadow instead of claiming an accuracy gain", selection?.split === "six non-overlapping chronological windows; no random split"
  && selection?.gate?.eligible === false
  && selection?.gate?.action === "shadow-only"
  && Number(selection?.gate?.thresholds?.minCandidateRows || 0) >= 300
  && Number(selection?.gate?.thresholds?.minBaselineRows || 0) >= 500);
const productionValidation = selection?.productionValidation || {};
const productionReplayStateConsistent = (validation, gate) => validation?.eligible === true
  ? validation?.samePolicyImplementation === true
    && validation?.perMarket?.HAD?.productionPolicyReplay === true
    && validation?.perMarket?.HHAD?.productionPolicyReplay === true
    && validation?.validatedMarkets?.includes("HAD")
    && validation?.validatedMarkets?.includes("HHAD")
    && gate?.productionPolicyValidated === true
    && gate?.validatedMarkets?.includes("HAD")
    && gate?.validatedMarkets?.includes("HHAD")
  : validation?.perMarket?.HAD?.productionPolicyReplay === false
    && validation?.perMarket?.HHAD?.productionPolicyReplay === false
    && validation?.validatedMarkets?.length === 0
    && gate?.productionPolicyValidated === false
    && gate?.blockers?.length > 0
    && gate?.blockers?.includes("HHAD-production-policy-unvalidated");
const replayStateConsistent = productionReplayStateConsistent(productionValidation, selection?.gate);
check("validated policy replay fixture remains shadow under the outer promotion gate",
  productionReplayStateConsistent({
    eligible: true,
    samePolicyImplementation: true,
    validatedMarkets: ["HAD", "HHAD"],
    perMarket: {
      HAD: { productionPolicyReplay: true },
      HHAD: { productionPolicyReplay: true },
    },
  }, {
    eligible: false,
    action: "shadow-only",
    productionPolicyValidated: true,
    validatedMarkets: ["HAD", "HHAD"],
  }));
check("production policy replay remains distinct from recommendation promotion", productionValidation.version === "production-multi-factor-validation-v3"
  && productionValidation.decisionSnapshotVersion === "candidate-decision-snapshot-v2"
  && productionValidation.cohortPolicy === "candidate-decision-snapshot-v2-only"
  && typeof productionValidation.samePolicyImplementation === "boolean"
  && replayStateConsistent
  && selection?.gate?.eligible === false
  && selection?.gate?.action === "shadow-only", {
  productionValidation,
  gate: selection?.gate || null
});

const riskGuard = strategy?.activation?.riskGuard || {};
const constrainedRisk = riskGuard.riskTier === "watch" || riskGuard.riskTier === "degraded";
check("watch/degraded risk cannot loosen", !constrainedRisk || (
  riskGuard.looseningAllowed === false
  && riskGuard.tighteningAllowed === true
  && strategy?.recommendationSelection?.status === "shadow-only"
  && strategy?.recommendationSelection?.hardMaxSp === null
  && strategy?.recommendationSelection?.directionSwitchByLowerSp === false
  && selection?.gate?.eligible === false
  && selection?.gate?.action === "shadow-only"
), { riskGuard, recommendationSelection: strategy?.recommendationSelection });

const ok = checks.every((row) => row.ok);
const failedChecks = checks
  .filter((row) => row.ok !== true)
  .map((row) => ({
    name: row.name,
    details: Object.fromEntries(Object.entries(row).filter(([key]) => !["name", "ok"].includes(key))),
  }));
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  policyContracts: Object.fromEntries(checks.filter(row => row.contractId).map(row => [row.contractId, row.ok])),
  comparison: {
    beforeSettled: before.settled ?? null,
    afterSettled: after.settled ?? null,
    coverage: selection.coverage ?? null,
    beforeHitRate: before.hitRate ?? null,
    afterHitRate: after.hitRate ?? null,
    beforeBrier: before?.selectedEventScoring?.model?.brier ?? null,
    afterBrier: after?.selectedEventScoring?.model?.brier ?? null,
    beforeLogLoss: before?.selectedEventScoring?.model?.logLoss ?? null,
    afterLogLoss: after?.selectedEventScoring?.model?.logLoss ?? null,
    beforeMarketBrier: before?.selectedEventScoring?.deviggedMarket?.brier ?? null,
    afterMarketBrier: after?.selectedEventScoring?.deviggedMarket?.brier ?? null,
    rollingWindows: windows.length
  },
  checks,
  // Keep a compact failure summary last so release logs retain the precise
  // live-only invariant even when the full verifier output is truncated.
  failedChecks,
}, null, 2));
if (!ok) process.exitCode = 1;
