const fs = require("node:fs");
const path = require("node:path");
const {
  buildResidualBoundModelSignalCandidate,
  hhadCompanionShadowGateFromEvaluation,
  loadModelLearningActivationAuthority,
  modelLearningActivationAuthorityFromRegistry,
  modelLearningCandidateContract,
  promotionGateFromEvaluation,
  promotionEvidenceStateFromEvaluation,
  readPromotionThresholds,
  stabilizeStrategyPublication,
  strategySemanticFingerprint,
  stripShadowStrategyFromMutableMatch
} = require("./optimizePredictionStrategy.cjs");
const {
  applyLearningCandidate,
  buildCandidateFromEvaluation,
  createLearningRegistry,
} = require("./modelLearningRegistry.cjs");
const {
  buildPromotionEvidenceManifest,
  buildPromotionEvidenceRecord,
} = require("../src/services/promotionEvidenceManifest.cjs");
const {
  normalizeMarketSourceProvenance,
} = require("../src/services/marketSourceProvenance.cjs");
const {
  createCollectorAttestationTestContext,
} = require("./collectorAttestationTestFixture.cjs");
const {
  HHAD_COMPANION_AUDIT_KEY,
  privateArtifactStorage,
  readPrivateModelArtifact,
} = require("./runtimePrivateModelArtifactStore.cjs");
const {
  WALK_FORWARD_PROTOCOL_VERSION,
  buildWalkForwardValidation,
  deepValidateWalkForwardArtifact,
  walkForwardPromotionState,
} = require("./walkForwardValidation.cjs");
const {
  fit: fitResidualMarketModel,
  stableHash: stableResidualHash,
} = require("./residualMarketModel.cjs");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data");
const sqliteDbPath = path.resolve(process.env.DATASTORE_SQLITE_PATH || path.join(serverDataDir, "football.db"));

const VERIFIER_PROMOTION_THRESHOLDS = readPromotionThresholds(process.env);
const PROMOTION_MIN_BASELINE_ROWS = VERIFIER_PROMOTION_THRESHOLDS.values.minBaselineRows;
const PROMOTION_MIN_LOG_LOSS_IMPROVEMENT = VERIFIER_PROMOTION_THRESHOLDS.values.minLogLossImprovement;
const PROMOTION_MIN_BRIER_IMPROVEMENT = VERIFIER_PROMOTION_THRESHOLDS.values.minBrierImprovement;
const PROMOTION_MIN_ROLLING_PASS_RATE = VERIFIER_PROMOTION_THRESHOLDS.values.minRollingPassRate;
const PROMOTION_MIN_ROLLING_WINDOWS = VERIFIER_PROMOTION_THRESHOLDS.values.minRollingWindows;
const PROMOTION_MIN_EVIDENCE_ROWS = VERIFIER_PROMOTION_THRESHOLDS.values.minPromotionEvidenceRows;
const collectorContext = createCollectorAttestationTestContext({ keyId: "model-promotion-test-ed25519" });
const PRODUCTION_MIN_ROWS_PER_MARKET = 100;
const PRODUCTION_MARKET_VALIDATION_STATUS = "validated";

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const pushCheck = (checks, name, ok, details = {}) => {
  checks.push({ name, ...details, ok: Boolean(ok) });
};

const asNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const asTime = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const promotionDecisionProjection = (gate) => {
  const { checkedAt, ...decision } = gate || {};
  return decision;
};

const candidateUsesModelSignal = (candidate) => {
  const weights = candidate?.weights || {};
  const features = Array.isArray(candidate?.featureSet) ? candidate.featureSet : [];
  return Number(weights.model || 0) > 0
    || Number(weights.historical || 0) > 0
    || Number(weights.elo || 0) > 0
    || Number(weights.poisson || 0) > 0
    || features.some((feature) => /historical|elo|poisson|model/i.test(String(feature)));
};

const finiteMetric = (value) => {
  if (value === null || value === undefined || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
};

const calibratedMarketReferenceFor = (shadowCandidates, modelCandidate) => {
  const targetTemperature = finiteMetric(modelCandidate?.weights?.temperature);
  return (Array.isArray(shadowCandidates?.candidates) ? shadowCandidates.candidates : [])
    .filter((candidate) => {
      const weights = candidate?.weights || {};
      const temperature = finiteMetric(weights.temperature);
      return !candidateUsesModelSignal(candidate)
        && finiteMetric(weights.market) === 1
        && finiteMetric(weights.model || 0) === 0
        && (Number.isFinite(targetTemperature)
          ? Number.isFinite(temperature) && Math.abs(temperature - targetTemperature) < 1e-9
          : !Number.isFinite(temperature));
    })
    .sort((left, right) => finiteMetric(left?.metrics?.logLoss) - finiteMetric(right?.metrics?.logLoss))[0] || null;
};

const productionMarketValidationReady = (productionValidation, market) => {
  const marketValidation = productionValidation?.perMarket?.[market] || null;
  const minimumRows = finiteMetric(marketValidation?.minimumRows);
  const sameSnapshotRows = finiteMetric(marketValidation?.sameSnapshotModelMarketRows);
  const exactReplayRows = finiteMetric(marketValidation?.exactReplayRows);
  return productionValidation?.validatedMarkets?.includes(market)
    && marketValidation?.status === PRODUCTION_MARKET_VALIDATION_STATUS
    && marketValidation?.productionPolicyReplay === true
    && Number.isFinite(minimumRows)
    && minimumRows >= PRODUCTION_MIN_ROWS_PER_MARKET
    && Number.isFinite(sameSnapshotRows)
    && sameSnapshotRows >= minimumRows
    && Number.isFinite(exactReplayRows)
    && exactReplayRows === sameSnapshotRows;
};

const collectInjectedStrategies = (matches) => {
  const rows = [];
  for (const match of matches) {
    // A locked or finished row keeps immutable strategy provenance for audit.
    // It cannot be changed by the current online strategy and is therefore not
    // evidence that a shadow strategy is still active.
    if (match?.predictionMeta?.lockedAt || ["LIVE", "FINISHED"].includes(String(match?.status || "").toUpperCase())) {
      continue;
    }
    const dynamicStrategy = match?.probabilityModel?.dynamicCalibration?.strategy || null;
    const legacyStrategy = match?.probabilityModel?.strategy || null;
    const strategyVersion = match?.predictionMeta?.strategyVersion || "";
    if (dynamicStrategy || legacyStrategy || (strategyVersion && strategyVersion !== "none")) {
      rows.push({
        id: match?.id || match?.matchId || null,
        sourceMatchId: match?.sourceMatchId || null,
        kickoffTime: match?.kickoffTime || null,
        strategyVersion: strategyVersion || null,
        dynamicOnlineEffect: dynamicStrategy?.activation?.onlineEffect || dynamicStrategy?.onlineEffect || null,
        legacyOnlineEffect: legacyStrategy?.activation?.onlineEffect || legacyStrategy?.onlineEffect || null
      });
    }
  }
  return rows;
};

const collectRulesByAction = (strategy, action) => {
  const buckets = [
    strategy?.gateByProfile,
    strategy?.gateByMarket,
    strategy?.gateByMarketProfile,
    strategy?.gateByOddsBucket,
    strategy?.gateByTip,
    strategy?.gateByWebConsensus
  ];
  return buckets.flatMap((bucket) => (
    Object.values(bucket || {}).filter((rule) => rule?.onlineAction === action)
  ));
};

const expectedGateReasons = (evaluation, modelLearningAuthority) => {
  const sample = evaluation?.sample || {};
  const currentModelComparison = evaluation?.marketBaseline?.comparison || {};
  const bestCandidate = evaluation?.shadowCandidates?.bestCandidate || null;
  const bestModelCandidate = evaluation?.shadowCandidates?.bestModelCandidate || null;
  const calibratedMarketReference = calibratedMarketReferenceFor(evaluation?.shadowCandidates, bestModelCandidate);
  const candidateComparison = bestCandidate?.comparison || currentModelComparison;
  const candidateRolling = bestCandidate?.rolling || null;
  const modelCandidateComparison = bestModelCandidate?.comparison || {};
  const modelCandidateRolling = bestModelCandidate?.rolling || null;
  const legacyRollingWindows = Array.isArray(evaluation?.rollingWindows) ? evaluation.rollingWindows : [];
  const legacyCheckedWindows = legacyRollingWindows.filter((window) => (
    Number.isFinite(finiteMetric(window?.improvement?.logLossImprovement))
    && Number.isFinite(finiteMetric(window?.improvement?.brierImprovement))
  ));
  const legacyPassingWindows = legacyCheckedWindows.filter((window) => (
    finiteMetric(window?.improvement?.logLossImprovement) >= PROMOTION_MIN_LOG_LOSS_IMPROVEMENT
    && finiteMetric(window?.improvement?.brierImprovement) >= PROMOTION_MIN_BRIER_IMPROVEMENT
  ));
  const marketBaselineRows = asNumber(sample.marketBaselineRows || currentModelComparison.rows);
  const candidateRows = asNumber(candidateComparison.rows, NaN);
  const modelCandidateRows = asNumber(modelCandidateComparison.rows, NaN);
  const logLossImprovement = asNumber(candidateComparison.logLossImprovement, NaN);
  const brierImprovement = asNumber(candidateComparison.brierImprovement, NaN);
  const candidateRollingWindows = asNumber(candidateRolling?.windows, NaN);
  const hasCandidateRolling = Number.isFinite(candidateRollingWindows) && candidateRollingWindows > 0;
  const checkedWindowCount = hasCandidateRolling ? candidateRollingWindows : legacyCheckedWindows.length;
  const candidateRollingPassRate = asNumber(candidateRolling?.passRate, NaN);
  const rollingPassRate = Number.isFinite(candidateRollingPassRate)
    ? candidateRollingPassRate
    : (legacyCheckedWindows.length ? legacyPassingWindows.length / legacyCheckedWindows.length : null);
  const modelLogLossImprovement = asNumber(modelCandidateComparison.logLossImprovement, NaN);
  const modelBrierImprovement = asNumber(modelCandidateComparison.brierImprovement, NaN);
  const modelRollingPassRate = modelCandidateRolling?.windows
    ? asNumber(modelCandidateRolling.passRate, NaN)
    : null;
  const riskTier = String(evaluation?.riskTiers?.overall?.tier || "unknown");
  const inputViolationCount = finiteMetric(evaluation?.inputAudit?.violationCount);
  const inputAuditReady = evaluation?.inputAudit?.ok === true
    && evaluation?.inputAudit?.promotionEligible === true
    && Number.isFinite(inputViolationCount)
    && inputViolationCount === 0;
  const recommendationSelectionReady = evaluation?.recommendationSelection?.gate?.eligible === true;
  const walkForwardState = walkForwardPromotionState(evaluation);
  const productionValidation = evaluation?.recommendationSelection?.productionValidation || null;
  const requiredRecommendationMarkets = ["HAD", "HHAD"];
  const validatedRecommendationMarkets = Array.isArray(productionValidation?.validatedMarkets)
    ? productionValidation.validatedMarkets
    : [];
  const productionPolicyReady = productionValidation?.eligible === true
    && productionValidation?.samePolicyImplementation === true
    && requiredRecommendationMarkets.every((market) => productionMarketValidationReady(productionValidation, market));
  const modelMetricRows = finiteMetric(bestModelCandidate?.metrics?.rows);
  const calibratedReferenceRows = finiteMetric(calibratedMarketReference?.metrics?.rows);
  const modelMarginalLogLossImprovement = finiteMetric(calibratedMarketReference?.metrics?.logLoss)
    - finiteMetric(bestModelCandidate?.metrics?.logLoss);
  const modelMarginalBrierImprovement = finiteMetric(calibratedMarketReference?.metrics?.brier)
    - finiteMetric(bestModelCandidate?.metrics?.brier);
  const modelMarginalReady = Boolean(calibratedMarketReference)
    && Number.isFinite(modelMetricRows)
    && modelMetricRows >= PROMOTION_MIN_BASELINE_ROWS
    && calibratedReferenceRows === modelMetricRows
    && Number.isFinite(modelMarginalLogLossImprovement)
    && modelMarginalLogLossImprovement >= 0
    && Number.isFinite(modelMarginalBrierImprovement)
    && modelMarginalBrierImprovement >= 0;
  const modelSignalIdentityReady = modelLearningAuthority === undefined
    ? true
    : modelLearningAuthority?.eligible === true;
  const modelSignalReady = Boolean(bestModelCandidate)
    && VERIFIER_PROMOTION_THRESHOLDS.valid
    && Number.isFinite(modelCandidateRows)
    && modelCandidateRows >= PROMOTION_MIN_BASELINE_ROWS
    && Number.isFinite(modelLogLossImprovement)
    && modelLogLossImprovement >= PROMOTION_MIN_LOG_LOSS_IMPROVEMENT
    && Number.isFinite(modelBrierImprovement)
    && modelBrierImprovement >= PROMOTION_MIN_BRIER_IMPROVEMENT
    && asNumber(modelCandidateRolling?.windows) >= PROMOTION_MIN_ROLLING_WINDOWS
    && (
      Number.isFinite(modelRollingPassRate)
      && modelRollingPassRate >= PROMOTION_MIN_ROLLING_PASS_RATE
    )
    && riskTier === "stable"
    && productionPolicyReady
    && inputAuditReady
    && recommendationSelectionReady
    && modelMarginalReady
    && walkForwardState.eligible
    && modelSignalIdentityReady;
  const reasons = [];

  if (!VERIFIER_PROMOTION_THRESHOLDS.valid) {
    reasons.push(`promotion-threshold-config-invalid:${VERIFIER_PROMOTION_THRESHOLDS.invalidNames.join(",")}`);
  }
  if (marketBaselineRows < PROMOTION_MIN_BASELINE_ROWS) {
    reasons.push(`market-baseline-rows:${marketBaselineRows}<${PROMOTION_MIN_BASELINE_ROWS}`);
  }
  if (!Number.isFinite(candidateRows) || candidateRows < PROMOTION_MIN_BASELINE_ROWS) {
    reasons.push(`shadow-candidate-rows:${Number.isFinite(candidateRows) ? candidateRows : "missing"}<${PROMOTION_MIN_BASELINE_ROWS}`);
  }
  if (!bestCandidate) {
    reasons.push("no-shadow-candidate");
  }
  if (!Number.isFinite(logLossImprovement) || logLossImprovement < PROMOTION_MIN_LOG_LOSS_IMPROVEMENT) {
    reasons.push(`log-loss-improvement:${Number.isFinite(logLossImprovement) ? logLossImprovement : "missing"}<${PROMOTION_MIN_LOG_LOSS_IMPROVEMENT}`);
  }
  if (!Number.isFinite(brierImprovement) || brierImprovement < PROMOTION_MIN_BRIER_IMPROVEMENT) {
    reasons.push(`brier-improvement:${Number.isFinite(brierImprovement) ? brierImprovement : "missing"}<${PROMOTION_MIN_BRIER_IMPROVEMENT}`);
  }
  if (checkedWindowCount < PROMOTION_MIN_ROLLING_WINDOWS) {
    reasons.push(`independent-rolling-windows:${checkedWindowCount}<${PROMOTION_MIN_ROLLING_WINDOWS}`);
  }
  if (!Number.isFinite(rollingPassRate) || rollingPassRate < PROMOTION_MIN_ROLLING_PASS_RATE) {
    reasons.push(`rolling-pass-rate:${Number.isFinite(rollingPassRate) ? rollingPassRate : "missing"}<${PROMOTION_MIN_ROLLING_PASS_RATE}`);
  }
  if (riskTier !== "stable") reasons.push(`model-risk-tier:${riskTier}!=stable`);
  if (!inputAuditReady) reasons.push("input-audit-failed");
  if (!recommendationSelectionReady) reasons.push("recommendation-selection-gate-ineligible");
  reasons.push(...walkForwardState.blockers);
  if (productionValidation?.samePolicyImplementation !== true || productionValidation?.eligible !== true) {
    reasons.push("production-multi-factor-policy-unvalidated");
  }
  for (const market of requiredRecommendationMarkets) {
    if (!productionMarketValidationReady(productionValidation, market)) {
      reasons.push(`recommendation-market-${market}-unvalidated`);
    }
  }
  if (candidateUsesModelSignal(bestCandidate) && !modelMarginalReady) {
    reasons.push("model-signal-no-marginal-gain-vs-calibrated-market");
  }

  return {
    reasons,
    marketBaselineRows,
    candidateRows,
    modelCandidateRows,
    bestCandidateId: bestCandidate?.id || null,
    bestCandidateUsesModelSignal: candidateUsesModelSignal(bestCandidate),
    expectedEligibleScope: reasons.length
      ? "none"
      : (candidateUsesModelSignal(bestCandidate) ? "model-signal" : "market-calibration-only"),
    bestModelCandidateId: bestModelCandidate?.id || null,
    modelSignalReady,
    modelSignalStatus: !bestModelCandidate
      ? "missing"
      : (!modelSignalIdentityReady ? "champion-identity-mismatch" : (modelSignalReady ? "candidate-positive" : "shadow-only")),
    modelSignalOnlineEffect: modelSignalReady && candidateUsesModelSignal(bestCandidate) ? "guarded-active" : "shadow",
    expectedStatus: reasons.length ? "shadow" : "eligible",
    expectedOnlineEffect: reasons.length ? "shadow" : "guarded-active",
    thresholds: {
      configValid: VERIFIER_PROMOTION_THRESHOLDS.valid,
      configInvalidNames: VERIFIER_PROMOTION_THRESHOLDS.invalidNames,
      minMarketBaselineRows: PROMOTION_MIN_BASELINE_ROWS,
      minLogLossImprovement: PROMOTION_MIN_LOG_LOSS_IMPROVEMENT,
      minBrierImprovement: PROMOTION_MIN_BRIER_IMPROVEMENT,
      minRollingPassRate: PROMOTION_MIN_ROLLING_PASS_RATE,
      minIndependentRollingWindows: PROMOTION_MIN_ROLLING_WINDOWS,
      minPromotionEvidenceRows: PROMOTION_MIN_EVIDENCE_ROWS,
      minProductionRowsPerMarket: PRODUCTION_MIN_ROWS_PER_MARKET,
      requireCleanInputAudit: true,
      requireRecommendationSelectionGate: true,
      requireSelectionAdjustedCandidateRobustness: true,
      requireUntouchedProspectiveCandidateConfirmation: true,
      requireWalkForwardProtocol: true,
      requireVerifiedTrainingEvaluationWatermark: true,
      requireProductionPolicyReplay: true,
      requireModelMarginalGainVsCalibratedMarket: true,
      requireValidPromotionEvidenceManifest: true,
      requireCompleteDecisionClockRecords: true,
      requireVerifiedModelLearningChampion: true,
      requireModelSignalCandidateChampionIdentity: true,
      requiredModelLearningCandidateTypes: ["market-residual-shadow"],
      requiredValidatedMarkets: requiredRecommendationMarkets
    }
  };
};

const syntheticWalkForwardRows = (count) => {
  const start = Date.parse("2025-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const kickoff = start + index * 24 * 60 * 60 * 1000;
    const actual = ["1", "X", "2"][index % 3];
    const triplet = (confidence) => ({
      "1": actual === "1" ? confidence : (1 - confidence) / 2,
      X: actual === "X" ? confidence : (1 - confidence) / 2,
      "2": actual === "2" ? confidence : (1 - confidence) / 2,
    });
    return {
      sourceMatchId: `promotion-wf-${index + 1}`,
      kickoffTime: new Date(kickoff).toISOString(),
      forecastTime: new Date(kickoff - 2 * 60 * 60 * 1000).toISOString(),
      resultObservedAt: new Date(kickoff + 3 * 60 * 60 * 1000).toISOString(),
      actual,
      marketProbabilities: triplet(0.55),
      modelProbabilities: triplet(0.64),
    };
  });
};

const syntheticWalkForwardValidation = (count = 320) => {
  const rows = syntheticWalkForwardRows(count);
  return buildWalkForwardValidation({
    rows,
    candidates: [{
      id: "promotion-real-builder-model",
      role: "shadow-model-candidate",
      weights: { market: 0.9, model: 0.1 },
      featureSet: ["sporttery-market", "independent-model"],
      rowsForValidation: rows.map((row) => ({
        ...row,
        probabilities: row.modelProbabilities,
      })),
    }],
  });
};

const hash = (character) => character.repeat(64);

const syntheticResidualFinalCandidate = () => {
  const start = Date.parse("2025-01-01T08:00:00.000Z");
  const rows = Array.from({ length: 150 }, (_, index) => {
    const forecastTime = new Date(start + index * 24 * 60 * 60 * 1_000).toISOString();
    const resultObservedAt = new Date(Date.parse(forecastTime) + 4 * 60 * 60 * 1_000).toISOString();
    const actual = ["1", "X", "2"][index % 3];
    const marketProbabilities = { "1": 0.4, X: 0.29, "2": 0.31 };
    const currentModelProbabilities = actual === "1"
      ? { "1": 0.58, X: 0.22, "2": 0.2 }
      : actual === "X"
        ? { "1": 0.25, X: 0.53, "2": 0.22 }
        : { "1": 0.24, X: 0.21, "2": 0.55 };
    return {
      sourceMatchId: `promotion-residual-${index + 1}`,
      forecastTime,
      resultObservedAt,
      resultObservedAtFallback: false,
      actual,
      marketProbabilities,
      currentModelProbabilities,
      historicalModelProbabilities: currentModelProbabilities,
      openingMarketProbabilities: { "1": 0.38, X: 0.3, "2": 0.32 },
    };
  });
  const evaluationTime = new Date(Date.parse(rows[rows.length - 1].resultObservedAt) + 1).toISOString();
  const model = fitResidualMarketModel(rows, {
    evaluationTime,
    minRows: 120,
    iterations: 30,
  });
  if (model.status !== "trained-shadow" || model.eligible !== true) {
    throw new Error(`synthetic residual final fit failed: ${(model.blockers || []).join(",")}`);
  }
  return {
    ...model,
    candidateId: `residual-market:${model.modelHash}`,
    candidateType: "market-residual-shadow",
    shadowOnly: true,
    productionEligible: false,
    candidateReady: true,
    candidateStatus: "candidate-ready-shadow",
    internalCandidateBlockers: [],
    parametersHash: stableResidualHash(model.parameters),
  };
};

const syntheticPromotionEvidenceAudit = (count = PROMOTION_MIN_EVIDENCE_ROWS) => {
  const records = Array.from({ length: Math.max(1, count) }, (_, index) => {
    const sourceCycleId = `promotion-cycle-${index + 1}`;
    const observedAt = "2026-07-15T00:00:00.000Z";
    const receivedAt = "2026-07-15T00:01:00.000Z";
    const baseModelGeneratedAt = "2026-07-15T00:02:00.000Z";
    const unifiedPosteriorGeneratedAt = "2026-07-15T00:03:00.000Z";
    const capturedAt = "2026-07-15T00:04:00.000Z";
    const decisionAt = "2026-07-15T00:05:00.000Z";
    const cutoffTime = "2026-07-15T01:00:00.000Z";
    const kickoffTime = "2026-07-15T02:00:00.000Z";
    const odds = { "1": 2.1, X: 3.2, "2": 3.4 };
    const probabilities = { "1": 0.48, X: 0.28, "2": 0.24 };
    const sourceMatchId = `promotion-source-${index + 1}`;
    const marketProvenance = collectorContext.buildSignedMarketProvenance({
      poolCode: "HAD",
      sourceMatchId,
      odds,
      handicapLine: 0,
      sourceUrl: "https://webapi.sporttery.cn/gateway/model-promotion-fixture.qry",
      providerObservedAt: observedAt,
      sourceTiming: {
        sourceCycleId,
        requestedAt: "2026-07-14T23:59:00.000Z",
        receivedAt,
        sourceRequest: { method: "GET", page: 1, role: "model-promotion-fixture" },
        httpStatus: 200,
        rawSha256: "a".repeat(64),
        rawBytes: 2048 + index,
      },
    });
    const normalizedMarketProvenance = normalizeMarketSourceProvenance(
      marketProvenance,
      { trustRegistry: collectorContext.registry },
    );
    const decisionSnapshot = {
      version: "candidate-decision-snapshot-v2",
      sourceCycleId,
      policyVersion: "multi-factor-market-evidence-v2",
      modelVersion: "residual-market-softmax-v1",
      calibrationVersion: "synthetic-calibration-v1",
      capturedAt,
      decisionAt,
      cutoffTime,
      kickoffTime,
      sourceTimestamps: {
        modelGeneratedAt: unifiedPosteriorGeneratedAt,
        baseModelGeneratedAt,
        unifiedPosteriorGeneratedAt,
        hadObservedAt: observedAt,
        hadReceivedAt: receivedAt,
      },
      markets: {
        HAD: {
          observedAt,
          receivedAt,
          line: 0,
          odds,
          provenance: marketProvenance,
          provenanceHash: marketProvenance.hash,
        },
      },
      probabilities: { HAD: probabilities },
      clockAudit: {
        version: "decision-clock-audit-v1",
        eligible: true,
        blockers: [],
        sourceCycleId,
        capturedAt,
        decisionAt,
        cutoffTime,
        kickoffTime,
        modelGeneratedAt: unifiedPosteriorGeneratedAt,
        baseModelGeneratedAt,
        unifiedPosteriorGeneratedAt,
        markets: {
          HAD: {
            observedAt,
            receivedAt,
            sourceCycleId,
            provenanceHash: marketProvenance.hash,
            provenanceEligible: true,
          },
        },
      },
    };
    return buildPromotionEvidenceRecord({
      identity: {
        matchId: `promotion-match-${index + 1}`,
        sourceMatchId,
        eventVersion: kickoffTime,
        market: "HAD",
        handicapLine: 0,
      },
      clocks: {
        capturedAt,
        decisionAt,
        cutoffTime,
        kickoffTime,
        modelGeneratedAt: unifiedPosteriorGeneratedAt,
        oddsObservedAt: observedAt,
        oddsReceivedAt: receivedAt,
        resultObservedAt: "2026-07-15T05:00:00.000Z",
        resultObservationSource: "sporttery-final-feed",
        resultObservationFallback: false,
      },
      provenance: {
        snapshotVersion: "candidate-decision-snapshot-v2",
        policyVersion: "multi-factor-market-evidence-v2",
        modelVersion: "residual-market-softmax-v1",
        calibrationVersion: "synthetic-calibration-v1",
        sourceCycleId,
        phase: "final",
        marketProvenanceVersion: normalizedMarketProvenance.version,
        marketProvenanceHash: normalizedMarketProvenance.hash,
        collectorAttestationKeyId: normalizedMarketProvenance.strict.collectorAttestationKeyId,
        collectorAttestationKeyFingerprint: normalizedMarketProvenance.strict.collectorAttestationKeyFingerprint,
        collectorAttestationCommitmentHash: normalizedMarketProvenance.strict.collectorAttestationCommitmentHash,
        marketExtractionHash: normalizedMarketProvenance.extraction.hash,
        collectorTrustBoundary: normalizedMarketProvenance.strict.trustBoundary,
      },
      decisionClockAuditEligible: true,
      decisionSnapshot,
      featureSnapshot: { version: "synthetic-feature-snapshot-v1", sourceCycleId },
      odds,
      probabilities,
      result: {
        official: true,
        trusted: true,
        provider: "sporttery",
        provenanceValidated: true,
        eventVersion: kickoffTime,
        eventVersionConsistent: true,
        status: "FINISHED",
        scoreHome: 2,
        scoreAway: 1,
        outcomeCode: "1",
        source: "sporttery",
      },
    });
  });
  const manifest = buildPromotionEvidenceManifest(records, {
    generatedAt: "2026-07-16T02:45:00.000Z",
  });
  return {
    version: "promotion-evidence-audit-v2",
    generatedAt: manifest.generatedAt,
    records,
    manifest,
    summary: {
      eligibleRows: manifest.eligibleRows,
      conflictingDuplicateKeys: manifest.conflictingDuplicateKeys,
      manifestPromotionEligible: manifest.promotionEligible,
    },
  };
};

const syntheticModelLearningAuthority = (evaluation) => {
  const candidateContract = modelLearningCandidateContract();
  const candidate = buildCandidateFromEvaluation(evaluation, candidateContract);
  const initialRegistry = createLearningRegistry({ createdAt: "2026-07-16T02:00:00.000Z" });
  const promotion = applyLearningCandidate({
    registry: initialRegistry,
    candidate,
    evaluation,
    productionContract: candidateContract,
    at: "2026-07-16T03:00:00.000Z",
    actor: { type: "automation", id: "promotion-gate-verifier" },
  });
  return {
    candidate,
    registry: promotion.registry,
    decision: promotion.decision,
    authority: modelLearningActivationAuthorityFromRegistry(evaluation, promotion.registry, { candidateContract }),
  };
};

const bindBestModelCandidateToChampion = (evaluation, authority) => {
  const bestModelCandidate = buildResidualBoundModelSignalCandidate(evaluation, authority);
  if (!bestModelCandidate || !evaluation?.shadowCandidates) return evaluation;
  evaluation.shadowCandidates.bestModelCandidate = bestModelCandidate;
  const candidates = evaluation.shadowCandidates.candidates;
  if (Array.isArray(candidates)) {
    const index = candidates.findIndex((candidate) => candidate?.role === "shadow-model-candidate");
    if (index >= 0) candidates[index] = bestModelCandidate;
    else candidates.push(bestModelCandidate);
  }
  if (evaluation.shadowCandidates.bestCandidate?.id === bestModelCandidate.id) {
    evaluation.shadowCandidates.bestCandidate = bestModelCandidate;
  }
  return evaluation;
};

const syntheticPromotionReadyEvaluation = () => {
  const residualFinalCandidate = syntheticResidualFinalCandidate();
  const productionValidation = {
    version: "production-multi-factor-validation-v3",
    productionPolicyVersion: "multi-factor-market-evidence-v2",
    samePolicyImplementation: true,
    eligible: true,
    validatedMarkets: ["HAD", "HHAD"],
    perMarket: Object.fromEntries(["HAD", "HHAD"].map((market) => [market, {
      sourceRows: PRODUCTION_MIN_ROWS_PER_MARKET,
      sameSnapshotModelMarketRows: PRODUCTION_MIN_ROWS_PER_MARKET,
      exactReplayRows: PRODUCTION_MIN_ROWS_PER_MARKET,
      minimumRows: PRODUCTION_MIN_ROWS_PER_MARKET,
      status: PRODUCTION_MARKET_VALIDATION_STATUS,
      productionPolicyReplay: true
    }]))
  };
  const marketCandidate = {
    id: "synthetic-market-calibration",
    role: "shadow-feature-candidate",
    weights: { market: 1, model: 0, temperature: 1.25 },
    featureSet: ["sporttery-market", "temperature-calibration"],
    metrics: {
      rows: PROMOTION_MIN_BASELINE_ROWS,
      logLoss: 0.8,
      brier: 0.5,
    },
    comparison: {
      rows: PROMOTION_MIN_BASELINE_ROWS,
      logLossImprovement: 0.01,
      brierImprovement: 0.01,
      accuracyDelta: 0.01
    },
    rolling: {
      windows: PROMOTION_MIN_ROLLING_WINDOWS,
      passRate: 1
    }
  };
  const modelCandidate = {
    id: "synthetic-residual-model",
    role: "shadow-model-candidate",
    weights: { market: 0.8, model: 0.2, temperature: 1.25 },
    featureSet: ["sporttery-market", "market-residual-model", "temperature-calibration"],
    metrics: {
      rows: PROMOTION_MIN_BASELINE_ROWS,
      logLoss: 0.79,
      brier: 0.49,
    },
    comparison: {
      rows: PROMOTION_MIN_BASELINE_ROWS,
      logLossImprovement: 0.02,
      brierImprovement: 0.02,
      accuracyDelta: 0.01,
      pairedByMatch: true,
    },
    rolling: {
      windows: PROMOTION_MIN_ROLLING_WINDOWS,
      passRate: 1,
      sufficientIndependentWindows: true,
    },
  };
  const evaluation = {
    version: "synthetic-promotion-ready",
    generatedAt: "2026-07-16T02:45:00.000Z",
    sample: {
      marketBaselineRows: PROMOTION_MIN_BASELINE_ROWS,
      probabilityRows: PROMOTION_MIN_BASELINE_ROWS
    },
    inputAudit: {
      ok: true,
      violationCount: 0,
      promotionEligible: true,
      promotionBlockers: []
    },
    walkForwardValidation: syntheticWalkForwardValidation(),
    marketBaseline: {
      comparison: {
        rows: PROMOTION_MIN_BASELINE_ROWS,
        logLossImprovement: 0,
        brierImprovement: 0,
        accuracyDelta: 0
      }
    },
    shadowCandidates: {
      sample: { rows: PROMOTION_MIN_BASELINE_ROWS },
      bestCandidate: marketCandidate,
      bestModelCandidate: modelCandidate,
      candidates: [marketCandidate, modelCandidate],
      summary: { modelCandidateCount: 1, balancedModelCandidateCount: 1 },
      robustness: {
        version: "shadow-candidate-robustness-v1",
        role: "prospective-confirmation",
        family: { inventoryHash: hash("9") },
        selectedCandidate: { id: marketCandidate.id },
        candidateReadyForProspectiveTest: true,
        formalPromotionEligible: true,
        blockers: [],
      },
    },
    residualMarketWalkForward: {
      version: "residual-market-walk-forward-v1",
      status: "evaluated-shadow",
      productionEligible: false,
      candidateReady: true,
      internalCandidateBlockers: [],
      input: { dataHash: residualFinalCandidate.dataHash },
      sample: { completeFolds: PROMOTION_MIN_ROLLING_WINDOWS },
       config: { fit: residualFinalCandidate.hyperparameters },
       aggregate: {
         rows: PROMOTION_MIN_BASELINE_ROWS,
         model: { rows: PROMOTION_MIN_BASELINE_ROWS, logLoss: 0.79, brier: 0.49, accuracy: 0.61 },
         market: { rows: PROMOTION_MIN_BASELINE_ROWS, logLoss: 0.81, brier: 0.51, accuracy: 0.6 },
         improvement: { brier: 0.02, logLoss: 0.02, accuracy: 0.01 },
      },
      folds: Array.from({ length: PROMOTION_MIN_ROLLING_WINDOWS }, (_, index) => ({
        fold: index + 1,
        blockers: [],
        window: {
          rows: index === PROMOTION_MIN_ROLLING_WINDOWS - 1
            ? PROMOTION_MIN_BASELINE_ROWS
              - Math.floor(PROMOTION_MIN_BASELINE_ROWS / PROMOTION_MIN_ROLLING_WINDOWS)
                * (PROMOTION_MIN_ROLLING_WINDOWS - 1)
            : Math.floor(PROMOTION_MIN_BASELINE_ROWS / PROMOTION_MIN_ROLLING_WINDOWS),
          contiguousWithPrevious: true,
        },
         sampleGates: {
           minimumTrainingRows: true,
           completeHoldout: true,
          completePredictionCoverage: true,
          strictWatermark: true,
        },
         metrics: {
           model: { rows: 1, logLoss: 0.79, brier: 0.49, accuracy: 0.61 },
           market: { rows: 1, logLoss: 0.81, brier: 0.51, accuracy: 0.6 },
           improvement: { brier: 0.02, logLoss: 0.02, accuracy: 0.01 },
         },
       })),
      finalCandidate: residualFinalCandidate,
    },
    promotionEvidenceAudit: syntheticPromotionEvidenceAudit(),
    riskTiers: { overall: { tier: "stable" } },
    recommendationSelection: {
      hardMaxSp: null,
      after: { settled: 300 },
      gate: { eligible: true },
      productionValidation
    }
  };
  for (const fold of evaluation.residualMarketWalkForward.folds) {
    fold.foldManifestHash = stableResidualHash(fold);
  }
  evaluation.residualMarketWalkForward.manifestHash = stableResidualHash(
    evaluation.residualMarketWalkForward
  );
  return evaluation;
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const run = async () => {
  const checks = [];
  const previousStableStrategy = {
    version: "strategy-idempotency-test-v1",
    generatedAt: "2026-07-27T00:00:00.000Z",
    activation: {
      onlineEffect: "shadow",
      promotionGate: {
        checkedAt: "2026-07-27T00:00:00.000Z",
        status: "shadow",
      },
    },
    sample: { officialRows: 0 },
  };
  const laterClockSameStrategy = cloneJson(previousStableStrategy);
  laterClockSameStrategy.generatedAt = "2026-07-27T01:00:00.000Z";
  laterClockSameStrategy.activation.promotionGate.checkedAt = "2026-07-27T01:00:00.000Z";
  const stablePublication = stabilizeStrategyPublication(
    laterClockSameStrategy,
    previousStableStrategy
  );
  pushCheck(checks, "strategy scheduler clocks do not manufacture a new publication",
    strategySemanticFingerprint(laterClockSameStrategy) === strategySemanticFingerprint(previousStableStrategy)
      && stablePublication.reused === true
      && stablePublication.strategy === previousStableStrategy, {
      nextSemanticHash: stablePublication.nextSemanticHash,
      previousSemanticHash: stablePublication.previousSemanticHash,
      reason: stablePublication.reason,
    });
  const changedStrategy = cloneJson(laterClockSameStrategy);
  changedStrategy.activation.promotionGate.status = "eligible";
  const changedPublication = stabilizeStrategyPublication(changedStrategy, previousStableStrategy);
  pushCheck(checks, "a semantic strategy change still creates a new publication",
    changedPublication.reused === false
      && changedPublication.strategy === changedStrategy
      && changedPublication.nextSemanticHash !== changedPublication.previousSemanticHash, {
      nextSemanticHash: changedPublication.nextSemanticHash,
      previousSemanticHash: changedPublication.previousSemanticHash,
      reason: changedPublication.reason,
    });
  const syncDataSource = fs.readFileSync(path.join(rootDir, "scripts", "syncData.cjs"), "utf8");
  const backtestSource = fs.readFileSync(path.join(rootDir, "scripts", "runModelBacktest.cjs"), "utf8");
  const emptyWalkForward = buildWalkForwardValidation({ rows: [], candidates: [] });
  pushCheck(checks, "backtest emits explicit walk-forward protocol and watermark blockers",
    typeof buildWalkForwardValidation === "function"
      && emptyWalkForward.protocolVersion === WALK_FORWARD_PROTOCOL_VERSION
      && emptyWalkForward.blockers.includes("walk-forward-watermark-unverified")
      && backtestSource.includes("buildWalkForwardValidation({")
      && backtestSource.includes("walkForwardValidation,"), {
      builderPresent: typeof buildWalkForwardValidation === "function",
      protocolBlockerPresent: emptyWalkForward.protocolVersion === WALK_FORWARD_PROTOCOL_VERSION,
      watermarkBlockerPresent: emptyWalkForward.blockers.includes("walk-forward-watermark-unverified"),
      backtestWiringPresent: backtestSource.includes("buildWalkForwardValidation({"),
      payloadFieldPresent: backtestSource.includes("walkForwardValidation,")
  });
  const happyPathFixture = syntheticPromotionReadyEvaluation();
  const happyLearning = syntheticModelLearningAuthority(happyPathFixture);
  bindBestModelCandidateToChampion(happyPathFixture, happyLearning.authority);
  const happyPathGate = promotionGateFromEvaluation(
    happyPathFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    happyLearning.authority
  );
  const happyWalkForwardAudit = deepValidateWalkForwardArtifact(happyPathFixture.walkForwardValidation);
  pushCheck(checks, "real walk-forward output activates only with an explicit valid Champion authority",
    happyLearning.decision.status === "promoted"
      && happyLearning.authority.eligible === true
      && happyPathGate.status === "eligible"
      && happyPathGate.onlineEffect === "guarded-active"
      && happyPathGate.reasons.length === 0
      && happyPathGate.metrics.productionPolicyReady === true
      && happyPathGate.metrics.walkForwardReady === true
      && happyPathGate.metrics.promotionEvidenceReady === true
      && happyPathGate.metrics.modelLearningAuthorityReady === true
      && happyPathFixture.walkForwardValidation.status === "validated"
      && happyWalkForwardAudit.eligible === true, {
      learningDecision: happyLearning.decision,
      authority: happyLearning.authority,
      status: happyPathGate.status,
      onlineEffect: happyPathGate.onlineEffect,
      reasons: happyPathGate.reasons,
      productionPolicyReady: happyPathGate.metrics.productionPolicyReady,
      walkForwardReady: happyPathGate.metrics.walkForwardReady,
      builderStatus: happyPathFixture.walkForwardValidation.status,
      builderAudit: happyWalkForwardAudit
    });

  const missingRobustnessFixture = cloneJson(happyPathFixture);
  delete missingRobustnessFixture.shadowCandidates.robustness;
  const missingRobustnessGate = promotionGateFromEvaluation(
    missingRobustnessFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    happyLearning.authority
  );
  const mismatchedRobustnessFixture = cloneJson(happyPathFixture);
  mismatchedRobustnessFixture.shadowCandidates.robustness.selectedCandidate.id = "different-candidate";
  const mismatchedRobustnessGate = promotionGateFromEvaluation(
    mismatchedRobustnessFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    happyLearning.authority
  );
  const retrospectiveOnlyFixture = cloneJson(happyPathFixture);
  retrospectiveOnlyFixture.shadowCandidates.robustness.role = "counterevidence-audit";
  retrospectiveOnlyFixture.shadowCandidates.robustness.formalPromotionEligible = false;
  retrospectiveOnlyFixture.shadowCandidates.robustness.blockers = [
    "candidate-selected-on-same-retrospective-sample",
  ];
  const retrospectiveOnlyGate = promotionGateFromEvaluation(
    retrospectiveOnlyFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    happyLearning.authority
  );
  pushCheck(checks, "candidate robustness is selection-bound and retrospective search cannot activate online",
    missingRobustnessGate.status === "shadow"
      && missingRobustnessGate.reasons.includes("shadow-candidate-robustness-selection-unbound")
      && missingRobustnessGate.reasons.includes("shadow-candidate-inventory-uncommitted")
      && missingRobustnessGate.reasons.includes("shadow-candidate-robustness-ineligible")
      && mismatchedRobustnessGate.status === "shadow"
      && mismatchedRobustnessGate.reasons.includes("shadow-candidate-robustness-selection-unbound")
      && retrospectiveOnlyGate.status === "shadow"
      && retrospectiveOnlyGate.metrics.candidateRobustnessReadyForProspectiveTest === true
      && retrospectiveOnlyGate.metrics.candidateRobustnessPromotionEligible === false
      && retrospectiveOnlyGate.reasons.includes("shadow-candidate-prospective-confirmation-missing"), {
      missingReasons: missingRobustnessGate.reasons,
      mismatchedReasons: mismatchedRobustnessGate.reasons,
      retrospectiveReasons: retrospectiveOnlyGate.reasons,
      retrospectiveRobustness: retrospectiveOnlyGate.shadowCandidateRobustness,
    });

  const boundModelSignalFixture = cloneJson(happyPathFixture);
  boundModelSignalFixture.shadowCandidates.bestCandidate = boundModelSignalFixture.shadowCandidates.bestModelCandidate;
  boundModelSignalFixture.shadowCandidates.robustness.selectedCandidate.id =
    boundModelSignalFixture.shadowCandidates.bestModelCandidate.id;
  const boundModelSignalGate = promotionGateFromEvaluation(
    boundModelSignalFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    happyLearning.authority
  );
  const identityFields = [
    "candidateId",
    "candidateType",
    "artifactHash",
    "modelHash",
    "trainingDataHash",
    "parametersHash",
    "featureSchemaHash",
    "metricsManifestHash",
    "trainedThrough",
  ];
  const identityMismatchResults = identityFields.map((field) => {
    const fixture = cloneJson(boundModelSignalFixture);
    fixture.shadowCandidates.bestModelCandidate.modelIdentity[field] = `mismatch-${field}`;
    fixture.shadowCandidates.bestCandidate = fixture.shadowCandidates.bestModelCandidate;
    const gate = promotionGateFromEvaluation(
      fixture,
      VERIFIER_PROMOTION_THRESHOLDS,
      happyLearning.authority
    );
    return {
      field,
      status: gate.status,
      onlineEffect: gate.onlineEffect,
      identityMatched: gate.modelSignal?.championIdentityMatched,
      blocked: gate.reasons.includes("model-signal-candidate-champion-identity-mismatch"),
    };
  });
  const candidateContentMutations = [
    ["weights", (candidate) => { candidate.weights.temperature = 1.1; }],
    ["featureSet", (candidate) => { candidate.featureSet.push("unbound-feature"); }],
    ["metrics", (candidate) => { candidate.metrics.brier -= 0.01; }],
    ["comparison", (candidate) => { candidate.comparison.logLossImprovement += 0.01; }],
    ["rolling", (candidate) => { candidate.rolling.passRate = 0.99; }],
    ["performanceManifestHash", (candidate) => { candidate.performanceManifestHash = hash("f"); }],
    ["foldManifestHashes", (candidate) => { candidate.foldManifestHashes[0] = hash("e"); }],
  ];
  const contentMismatchResults = candidateContentMutations.map(([field, mutate]) => {
    const fixture = cloneJson(boundModelSignalFixture);
    mutate(fixture.shadowCandidates.bestModelCandidate);
    fixture.shadowCandidates.bestCandidate = fixture.shadowCandidates.bestModelCandidate;
    const gate = promotionGateFromEvaluation(
      fixture,
      VERIFIER_PROMOTION_THRESHOLDS,
      happyLearning.authority
    );
    return {
      field,
      status: gate.status,
      onlineEffect: gate.onlineEffect,
      identityMatched: gate.modelSignal?.championIdentityMatched,
      blocked: gate.reasons.includes("model-signal-candidate-champion-identity-mismatch"),
    };
  });
  pushCheck(checks, "guarded model signal is the exact content-addressed Champion identity",
    boundModelSignalGate.status === "eligible"
      && boundModelSignalGate.onlineEffect === "guarded-active"
      && boundModelSignalGate.eligibleScope === "model-signal"
      && boundModelSignalGate.modelSignal?.readyForGuardedUse === true
      && boundModelSignalGate.modelSignal?.championIdentityMatched === true
      && identityMismatchResults.every((result) => (
        result.status === "shadow"
        && result.onlineEffect === "shadow"
        && result.identityMatched === false
        && result.blocked === true
      ))
      && contentMismatchResults.every((result) => (
        result.status === "shadow"
        && result.onlineEffect === "shadow"
        && result.identityMatched === false
        && result.blocked === true
      )), {
      boundStatus: boundModelSignalGate.status,
      boundScope: boundModelSignalGate.eligibleScope,
      boundIdentityMatched: boundModelSignalGate.modelSignal?.championIdentityMatched,
      identityMismatchResults,
      contentMismatchResults,
    });

  const noAuthorityGate = promotionGateFromEvaluation(happyPathFixture);
  const missingManifestFixture = cloneJson(happyPathFixture);
  delete missingManifestFixture.promotionEvidenceAudit.manifest;
  const missingManifestGate = promotionGateFromEvaluation(
    missingManifestFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    happyLearning.authority
  );
  const forgedManifestFixture = cloneJson(happyPathFixture);
  forgedManifestFixture.promotionEvidenceAudit.manifest.eligibleRows += 1;
  const forgedManifestGate = promotionGateFromEvaluation(
    forgedManifestFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    happyLearning.authority
  );
  const missingRegistryAuthority = loadModelLearningActivationAuthority(
    happyPathFixture,
    path.join(serverDataDir, "model-artifacts", "definitely-missing-promotion-registry.json")
  );
  const missingRegistryGate = promotionGateFromEvaluation(
    happyPathFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    missingRegistryAuthority
  );
  const mismatchedChampionFixture = cloneJson(happyPathFixture);
  mismatchedChampionFixture.residualMarketWalkForward.finalCandidate.modelHash = hash("f");
  const mismatchedChampionAuthority = modelLearningActivationAuthorityFromRegistry(
    mismatchedChampionFixture,
    happyLearning.registry,
    { candidateContract: modelLearningCandidateContract() }
  );
  const mismatchedChampionGate = promotionGateFromEvaluation(
    mismatchedChampionFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    mismatchedChampionAuthority
  );
  const unsupportedTypeAuthority = modelLearningActivationAuthorityFromRegistry(
    happyPathFixture,
    happyLearning.registry,
    {
      candidateContract: modelLearningCandidateContract(),
      supportedCandidateTypes: ["unrelated-model-family"],
    }
  );
  const unsupportedTypeGate = promotionGateFromEvaluation(
    happyPathFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    unsupportedTypeAuthority
  );
  pushCheck(checks, "manifest and Champion authority failures remain fail-closed",
    noAuthorityGate.status === "shadow"
      && noAuthorityGate.reasons.includes("model-learning-authority-missing")
      && missingManifestGate.status === "shadow"
      && missingManifestGate.reasons.includes("promotion-evidence-manifest-missing")
      && forgedManifestGate.status === "shadow"
      && forgedManifestGate.reasons.includes("promotion-evidence-manifest-hash-invalid")
      && missingRegistryAuthority.eligible === false
      && missingRegistryGate.status === "shadow"
      && missingRegistryGate.reasons.includes("model-learning-registry-missing")
      && mismatchedChampionAuthority.eligible === false
      && mismatchedChampionAuthority.blockers.includes("model-learning-champion-mismatch")
      && mismatchedChampionGate.status === "shadow"
      && unsupportedTypeAuthority.eligible === false
      && unsupportedTypeAuthority.blockers.includes("model-learning-candidate-type-unsupported:market-residual-shadow")
      && unsupportedTypeGate.status === "shadow", {
      noAuthorityReasons: noAuthorityGate.reasons,
      missingManifestReasons: missingManifestGate.reasons,
      forgedManifestState: forgedManifestGate.promotionEvidence,
      missingRegistryAuthority,
      mismatchedChampionAuthority,
      mismatchedChampionReasons: mismatchedChampionGate.reasons,
      unsupportedTypeAuthority,
      unsupportedTypeReasons: unsupportedTypeGate.reasons,
    });

  const invalidThresholdConfig = readPromotionThresholds({
    MODEL_PROMOTION_MIN_BASELINE_ROWS: "not-a-number",
    MODEL_PROMOTION_MIN_LOG_LOSS_IMPROVEMENT: "-0.01",
    MODEL_PROMOTION_MIN_BRIER_IMPROVEMENT: " ",
    MODEL_PROMOTION_MIN_ROLLING_PASS_RATE: "0.2",
    MODEL_PROMOTION_MIN_ROLLING_WINDOWS: "5.5",
  });
  const invalidThresholdGate = promotionGateFromEvaluation(
    happyPathFixture,
    invalidThresholdConfig,
    happyLearning.authority
  );
  pushCheck(checks, "invalid promotion threshold configuration fails closed",
    invalidThresholdConfig.valid === false
      && invalidThresholdConfig.invalidNames.length === 5
      && invalidThresholdConfig.values.minBaselineRows >= 500
      && invalidThresholdConfig.values.minLogLossImprovement >= 0
      && invalidThresholdConfig.values.minBrierImprovement >= 0
      && invalidThresholdConfig.values.minRollingPassRate >= 0.6
      && invalidThresholdConfig.values.minRollingWindows >= 6
      && invalidThresholdGate.status === "shadow"
      && invalidThresholdGate.onlineEffect === "shadow"
      && invalidThresholdGate.thresholds?.configValid === false
      && invalidThresholdGate.reasons.some((reason) => reason.startsWith("promotion-threshold-config-invalid:")), {
      invalidThresholdConfig,
      status: invalidThresholdGate.status,
      onlineEffect: invalidThresholdGate.onlineEffect,
      reasons: invalidThresholdGate.reasons,
    });

  const marginalFixture = cloneJson(happyPathFixture);
  const calibratedMarketCandidate = {
    ...cloneJson(marginalFixture.shadowCandidates.bestCandidate),
    id: "market-temperature-1_25",
    weights: { market: 1, model: 0, temperature: 1.25 },
    featureSet: ["sporttery-market", "temperature-calibration"],
    metrics: { rows: PROMOTION_MIN_BASELINE_ROWS, logLoss: 0.8, brier: 0.5 },
  };
  const worseModelCandidate = {
    ...cloneJson(calibratedMarketCandidate),
    id: "market-model-temperature-90-1_25",
    role: "shadow-candidate",
    weights: { market: 0.9, model: 0.1, temperature: 1.25 },
    featureSet: ["sporttery-market", "current-probability-model", "temperature-calibration"],
    metrics: { rows: PROMOTION_MIN_BASELINE_ROWS, logLoss: 0.801, brier: 0.501 },
    comparison: {
      rows: PROMOTION_MIN_BASELINE_ROWS,
      logLossImprovement: 0.01,
      brierImprovement: 0.01,
      accuracyDelta: 0,
      pairedByMatch: true,
    },
    rolling: {
      windows: PROMOTION_MIN_ROLLING_WINDOWS,
      passRate: 1,
      sufficientIndependentWindows: true,
    },
  };
  marginalFixture.shadowCandidates.bestCandidate = calibratedMarketCandidate;
  marginalFixture.shadowCandidates.bestModelCandidate = worseModelCandidate;
  marginalFixture.shadowCandidates.candidates = [calibratedMarketCandidate, worseModelCandidate];
  marginalFixture.shadowCandidates.robustness.selectedCandidate.id = calibratedMarketCandidate.id;
  marginalFixture.shadowCandidates.summary = {
    ...(marginalFixture.shadowCandidates.summary || {}),
    modelCandidateCount: 1,
    balancedModelCandidateCount: 1,
  };
  const worseMarginalLearning = syntheticModelLearningAuthority(marginalFixture);
  const worseMarginalGate = promotionGateFromEvaluation(
    marginalFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    worseMarginalLearning.authority
  );
  const betterMarginalFixture = cloneJson(marginalFixture);
  betterMarginalFixture.shadowCandidates.bestModelCandidate.metrics = {
    rows: PROMOTION_MIN_BASELINE_ROWS,
    logLoss: 0.799,
    brier: 0.499,
  };
  betterMarginalFixture.shadowCandidates.candidates[1] = betterMarginalFixture.shadowCandidates.bestModelCandidate;
  const betterMarginalLearning = syntheticModelLearningAuthority(betterMarginalFixture);
  const betterMarginalGate = promotionGateFromEvaluation(
    betterMarginalFixture,
    VERIFIER_PROMOTION_THRESHOLDS,
    betterMarginalLearning.authority
  );
  pushCheck(checks, "unbound legacy model metrics cannot impersonate the residual Champion",
    worseMarginalLearning.decision.status === "promoted"
      && worseMarginalLearning.authority.eligible === true
      && worseMarginalGate.status === "eligible"
      && worseMarginalGate.eligibleScope === "market-calibration-only"
      && worseMarginalGate.modelSignal.readyForGuardedUse === false
      && worseMarginalGate.modelSignal.status === "champion-identity-mismatch"
      && worseMarginalGate.modelSignal.onlineEffect === "shadow"
      && worseMarginalGate.metrics.modelMarginalReady === false
      && worseMarginalGate.metrics.modelMarginalReferenceId === calibratedMarketCandidate.id
      && betterMarginalLearning.decision.status === "promoted"
      && betterMarginalLearning.authority.eligible === true
      && betterMarginalGate.status === "eligible"
      && betterMarginalGate.eligibleScope === "market-calibration-only"
      && betterMarginalGate.modelSignal.readyForGuardedUse === false
      && betterMarginalGate.modelSignal.status === "champion-identity-mismatch"
      && betterMarginalGate.modelSignal.onlineEffect === "shadow"
      && betterMarginalGate.metrics.modelMarginalReady === true
      && betterMarginalGate.metrics.modelMarginalLogLossImprovement > 0
      && betterMarginalGate.metrics.modelMarginalBrierImprovement > 0, {
      worseLearningDecision: worseMarginalLearning.decision,
      worseAuthority: worseMarginalLearning.authority,
      worseModelSignal: worseMarginalGate.modelSignal,
      worseMarginalMetrics: worseMarginalGate.metrics,
      betterLearningDecision: betterMarginalLearning.decision,
      betterAuthority: betterMarginalLearning.authority,
      betterModelSignal: betterMarginalGate.modelSignal,
      betterMarginalMetrics: betterMarginalGate.metrics,
    });

  const forgedZeroFoldFixture = cloneJson(happyPathFixture);
  forgedZeroFoldFixture.walkForwardValidation.folds = [];
  forgedZeroFoldFixture.walkForwardValidation.sample.folds = 0;
  forgedZeroFoldFixture.walkForwardValidation.sample.evaluationRows = 0;
  forgedZeroFoldFixture.walkForwardValidation.sample.passedFolds = 0;
  const forgedZeroFoldAudit = deepValidateWalkForwardArtifact(forgedZeroFoldFixture.walkForwardValidation);
  const forgedZeroFoldGate = promotionGateFromEvaluation(forgedZeroFoldFixture);
  pushCheck(checks, "forged top-level eligible artifact with zero folds fails closed",
    forgedZeroFoldAudit.eligible === false
      && forgedZeroFoldGate.status === "shadow"
      && forgedZeroFoldGate.reasons.includes("walk-forward-validation-unvalidated"), {
      auditErrors: forgedZeroFoldAudit.errors,
      gateStatus: forgedZeroFoldGate.status,
      reasons: forgedZeroFoldGate.reasons
    });

  const oneFoldFixture = cloneJson(happyPathFixture);
  oneFoldFixture.walkForwardValidation = syntheticWalkForwardValidation(159);
  const oneFoldAudit = deepValidateWalkForwardArtifact(oneFoldFixture.walkForwardValidation);
  const oneFoldGate = promotionGateFromEvaluation(oneFoldFixture);
  pushCheck(checks, "one-fold collecting artifact stays non-promotable with a valid watermark",
    oneFoldFixture.walkForwardValidation.status === "collecting"
      && oneFoldFixture.walkForwardValidation.sample.folds === 1
      && oneFoldFixture.walkForwardValidation.watermark.noOverlapVerified === true
      && oneFoldAudit.eligible === false
      && oneFoldAudit.errors.length === 0
      && oneFoldGate.status === "shadow"
      && oneFoldGate.reasons.includes("walk-forward-validation-unvalidated"), {
      validationStatus: oneFoldFixture.walkForwardValidation.status,
      folds: oneFoldFixture.walkForwardValidation.sample.folds,
      watermark: oneFoldFixture.walkForwardValidation.watermark,
      audit: oneFoldAudit,
      reasons: oneFoldGate.reasons
    });

  const staleEnumFixture = cloneJson(happyPathFixture);
  staleEnumFixture.recommendationSelection.productionValidation.perMarket.HAD.status = "eligible";
  const staleEnumGate = promotionGateFromEvaluation(staleEnumFixture);
  pushCheck(checks, "production validation uses one canonical validated enum",
    staleEnumGate.status === "shadow"
      && staleEnumGate.reasons.includes("recommendation-market-HAD-unvalidated"), {
      status: staleEnumGate.status,
      reasons: staleEnumGate.reasons,
      hadStatus: staleEnumFixture.recommendationSelection.productionValidation.perMarket.HAD.status
    });

  const unsafeInputFixture = cloneJson(happyPathFixture);
  unsafeInputFixture.inputAudit = { ok: false, violationCount: 1 };
  const unsafeInputGate = promotionGateFromEvaluation(unsafeInputFixture);
  const fallbackInputFixture = cloneJson(happyPathFixture);
  fallbackInputFixture.inputAudit.promotionEligible = false;
  fallbackInputFixture.inputAudit.promotionBlockers = ["historical-result-observed-at-fallback:42"];
  const fallbackInputGate = promotionGateFromEvaluation(fallbackInputFixture);
  const ineligibleSelectionFixture = cloneJson(happyPathFixture);
  ineligibleSelectionFixture.recommendationSelection.gate.eligible = false;
  const ineligibleSelectionGate = promotionGateFromEvaluation(ineligibleSelectionFixture);
  pushCheck(checks, "input audit and recommendation-selection gates fail closed independently",
    unsafeInputGate.status === "shadow"
      && unsafeInputGate.reasons.includes("input-audit-failed")
      && fallbackInputGate.status === "shadow"
      && fallbackInputGate.reasons.includes("input-audit-failed")
      && ineligibleSelectionGate.status === "shadow"
      && ineligibleSelectionGate.reasons.includes("recommendation-selection-gate-ineligible"), {
      unsafeInputReasons: unsafeInputGate.reasons,
      fallbackInputReasons: fallbackInputGate.reasons,
      ineligibleSelectionReasons: ineligibleSelectionGate.reasons
    });

  const missingWalkForwardFixture = cloneJson(happyPathFixture);
  delete missingWalkForwardFixture.walkForwardValidation;
  const missingWalkForwardGate = promotionGateFromEvaluation(missingWalkForwardFixture);
  const overlappingWatermarkFixture = cloneJson(happyPathFixture);
  overlappingWatermarkFixture.walkForwardValidation.watermark.trainingDataMaxObservedAt = "2026-01-02T00:00:00.000Z";
  const overlappingWatermarkGate = promotionGateFromEvaluation(overlappingWatermarkFixture);
  pushCheck(checks, "walk-forward protocol and non-overlap watermark are mandatory",
    missingWalkForwardGate.status === "shadow"
      && missingWalkForwardGate.reasons.includes("walk-forward-protocol-missing")
      && missingWalkForwardGate.reasons.includes("walk-forward-watermark-missing")
      && missingWalkForwardGate.reasons.includes("walk-forward-validation-unvalidated")
      && overlappingWatermarkGate.status === "shadow"
      && overlappingWatermarkGate.reasons.includes("walk-forward-watermark-unverified"), {
      missingReasons: missingWalkForwardGate.reasons,
      overlappingReasons: overlappingWatermarkGate.reasons
    });

  const undersizedFixture = cloneJson(happyPathFixture);
  undersizedFixture.sample.marketBaselineRows = PROMOTION_MIN_BASELINE_ROWS - 1;
  undersizedFixture.shadowCandidates.bestCandidate.comparison.rows = PROMOTION_MIN_BASELINE_ROWS - 1;
  const undersizedGate = promotionGateFromEvaluation(undersizedFixture);
  pushCheck(checks, "synthetic promotion floor cannot be lowered below 500 rows",
    PROMOTION_MIN_BASELINE_ROWS >= 500
      && undersizedGate.status === "shadow"
      && undersizedGate.reasons.includes(`market-baseline-rows:${PROMOTION_MIN_BASELINE_ROWS - 1}<${PROMOTION_MIN_BASELINE_ROWS}`)
      && undersizedGate.reasons.includes(`shadow-candidate-rows:${PROMOTION_MIN_BASELINE_ROWS - 1}<${PROMOTION_MIN_BASELINE_ROWS}`), {
      promotionFloor: PROMOTION_MIN_BASELINE_ROWS,
      reasons: undersizedGate.reasons
    });

  const nullMetricGate = promotionGateFromEvaluation({
    version: "synthetic-null-metrics",
    sample: { marketBaselineRows: PROMOTION_MIN_BASELINE_ROWS, probabilityRows: PROMOTION_MIN_BASELINE_ROWS },
    marketBaseline: { comparison: { rows: PROMOTION_MIN_BASELINE_ROWS } },
    shadowCandidates: {
      bestCandidate: {
        id: "synthetic-null",
        weights: { market: 1 },
        comparison: { rows: null, logLossImprovement: null, brierImprovement: null }
      },
      bestModelCandidate: {
        id: "synthetic-small-model",
        weights: { market: 0.9, model: 0.1 },
        comparison: {
          rows: PROMOTION_MIN_BASELINE_ROWS - 1,
          logLossImprovement: 1,
          brierImprovement: 1
        }
      }
    }
  });
  pushCheck(checks, "null and undersized candidate metrics cannot promote", nullMetricGate.status === "shadow"
    && nullMetricGate.reasons.includes(`shadow-candidate-rows:missing<${PROMOTION_MIN_BASELINE_ROWS}`)
    && nullMetricGate.metrics.logLossImprovement === null
    && nullMetricGate.metrics.brierImprovement === null
    && nullMetricGate.modelSignal.readyForGuardedUse === false, {
    gateStatus: nullMetricGate.status,
    reasons: nullMetricGate.reasons,
    modelSignal: nullMetricGate.modelSignal
  });
  const zeroCandidateRollingFixture = {
    sample: { marketBaselineRows: 20, probabilityRows: 20 },
    marketBaseline: { comparison: { rows: 20 } },
    shadowCandidates: {
      bestCandidate: {
        id: "synthetic-zero-window",
        weights: { market: 1 },
        comparison: { rows: 7, logLossImprovement: 0.03, brierImprovement: 0.01 },
        rolling: { windows: 0, passRate: null }
      }
    },
    rollingWindows: [{ improvement: { logLossImprovement: -0.01, brierImprovement: -0.01 } }],
    riskTiers: { overall: { tier: "degraded" } },
    recommendationSelection: { productionValidation: { eligible: false, validatedMarkets: [], perMarket: {} } }
  };
  const zeroCandidateRollingGate = promotionGateFromEvaluation(zeroCandidateRollingFixture);
  const zeroCandidateRollingExpected = expectedGateReasons(zeroCandidateRollingFixture);
  pushCheck(checks, "zero candidate windows use the same legacy rolling fallback as production",
    zeroCandidateRollingGate.sample.rollingWindows === 1
      && zeroCandidateRollingGate.metrics.rollingSource === "current-model-legacy"
      && zeroCandidateRollingExpected.reasons.every((reason) => zeroCandidateRollingGate.reasons.includes(reason)), {
      productionReasons: zeroCandidateRollingGate.reasons,
      verifierReasons: zeroCandidateRollingExpected.reasons
    });
  const nullLegacyRollingFixture = cloneJson(happyPathFixture);
  nullLegacyRollingFixture.shadowCandidates.bestCandidate.rolling = { windows: 0, passRate: null };
  nullLegacyRollingFixture.rollingWindows = Array.from({ length: PROMOTION_MIN_ROLLING_WINDOWS }, () => ({
    improvement: { logLossImprovement: null, brierImprovement: null }
  }));
  const nullLegacyRollingGate = promotionGateFromEvaluation(nullLegacyRollingFixture);
  pushCheck(checks, "null legacy rolling improvements cannot count as passing windows",
    nullLegacyRollingGate.status === "shadow"
      && nullLegacyRollingGate.sample.rollingWindows === 0
      && nullLegacyRollingGate.metrics.rollingPassRate === null
      && nullLegacyRollingGate.reasons.includes(`independent-rolling-windows:0<${PROMOTION_MIN_ROLLING_WINDOWS}`)
      && nullLegacyRollingGate.reasons.includes(`rolling-pass-rate:missing<${PROMOTION_MIN_ROLLING_PASS_RATE}`), {
      rollingWindows: nullLegacyRollingGate.sample.rollingWindows,
      rollingPassRate: nullLegacyRollingGate.metrics.rollingPassRate,
      reasons: nullLegacyRollingGate.reasons,
    });
  const candidateReadyCompanion = {
    version: "hhad-companion-shadow-evaluation-v1",
    strategy: "HHAD_COMPANION_SHADOW",
    strategyVersion: "hhad-companion-shadow-v2",
    strategyHash: "synthetic-companion-strategy-hash",
    evaluatedAt: "2026-07-13T00:00:00.000Z",
    candidateReady: true,
    candidateStatus: "candidate-ready-for-manual-evaluation",
    promotionAllowed: false,
    onlineEffect: "shadow",
    counts: { pairedNonVoidRows: 650 },
    exactReplay: { rate: 1 },
    gate: {
      version: "hhad-companion-candidate-gate-v1",
      thresholds: { minimumPairedNonVoidRows: 500 },
      checks: { minimumPairedNonVoidRows: true },
      candidateReady: true,
      interpretation: "manual evaluation only"
    }
  };
  const globalWithoutCompanion = promotionGateFromEvaluation(zeroCandidateRollingFixture);
  const evaluationWithCompanion = {
    ...zeroCandidateRollingFixture,
    hhadCompanionEvaluation: candidateReadyCompanion
  };
  const globalWithCompanion = promotionGateFromEvaluation(evaluationWithCompanion);
  const independentCompanionGate = hhadCompanionShadowGateFromEvaluation(evaluationWithCompanion);
  pushCheck(checks, "HHAD companion candidate readiness cannot activate or mutate the global gate",
    sameJson(promotionDecisionProjection(globalWithoutCompanion), promotionDecisionProjection(globalWithCompanion))
      && independentCompanionGate.candidateReady === true
      && independentCompanionGate.onlineEffect === "shadow"
      && independentCompanionGate.promotionAllowed === false, {
      globalWithoutCompanion: promotionDecisionProjection(globalWithoutCompanion),
      globalWithCompanion: promotionDecisionProjection(globalWithCompanion),
      companionGate: independentCompanionGate
    });
  const staleStrategyFixture = {
    status: "SCHEDULED",
    probabilityModel: {
      dynamicCalibration: {
        version: "fixture",
        strategy: { version: "self-optimization-v2", onlineEffect: "guarded-active" }
      }
    },
    predictionMeta: { strategyVersion: "self-optimization-v2", lockedAt: null }
  };
  const reconciledFixture = stripShadowStrategyFromMutableMatch(staleStrategyFixture);
  const lockedFixture = stripShadowStrategyFromMutableMatch({
    ...staleStrategyFixture,
    predictionMeta: { ...staleStrategyFixture.predictionMeta, lockedAt: "2026-07-11T00:00:00.000Z" }
  });
  pushCheck(checks, "shadow reconciliation clears only mutable online strategy injection",
    reconciledFixture.changed === true
      && !reconciledFixture.match?.probabilityModel?.dynamicCalibration?.strategy
      && reconciledFixture.match?.predictionMeta?.strategyVersion === "none"
      && lockedFixture.changed === false
      && lockedFixture.match?.predictionMeta?.strategyVersion === "self-optimization-v2", {
      mutableChanged: reconciledFixture.changed,
      mutableStrategyVersion: reconciledFixture.match?.predictionMeta?.strategyVersion || null,
      lockedChanged: lockedFixture.changed,
      lockedStrategyVersion: lockedFixture.match?.predictionMeta?.strategyVersion || null
    });
  const evaluation = readJson(path.join(publicDataDir, "model-evaluation.json"), null);
  const publicStrategy = readJson(path.join(publicDataDir, "model-strategy.json"), null);
  const serverStrategy = readJson(path.join(serverDataDir, "model-strategy.json"), null);
  const legacyHhadCompanionAuditPath = path.join(serverDataDir, "model-artifacts", "hhad-companion-audit.json");
  let privateAuditRecord = null;
  let privateAuditError = null;
  try {
    privateAuditRecord = await readPrivateModelArtifact({
      dbPath: privateArtifactStorage() === "sqlite" ? sqliteDbPath : null,
      storage: privateArtifactStorage(),
      artifactKey: HHAD_COMPANION_AUDIT_KEY,
    });
  } catch (error) {
    privateAuditError = error?.message || String(error);
  }
  const hhadCompanionAudit = privateAuditRecord?.payload || null;
  const calibration = readJson(path.join(publicDataDir, "model-calibration.json"), null);
  const syncMeta = readJson(path.join(publicDataDir, "sync-meta.json"), null);
  const currentPayload = readJson(path.join(publicDataDir, "matches-current.json"), []);
  const currentMatches = Array.isArray(currentPayload) ? currentPayload : (currentPayload?.matches || []);
  const gate = publicStrategy?.activation?.promotionGate || null;
  const publicHhadCompanion = evaluation?.hhadCompanionEvaluation || null;
  const strategyHhadCompanion = publicStrategy?.activation?.shadowTracks?.HHAD_COMPANION || null;
  const expectedHhadCompanionGate = hhadCompanionShadowGateFromEvaluation(evaluation);
  const riskGuard = publicStrategy?.activation?.riskGuard || null;
  const modelLearningAuthority = loadModelLearningActivationAuthority(evaluation);
  const expected = expectedGateReasons(evaluation, modelLearningAuthority);

  pushCheck(checks, "model evaluation available", Boolean(evaluation?.version && evaluation?.generatedAt), {
    version: evaluation?.version || null,
    generatedAt: evaluation?.generatedAt || null,
    marketBaselineRows: evaluation?.sample?.marketBaselineRows ?? null,
    probabilityRows: evaluation?.sample?.probabilityRows ?? null
  });
  pushCheck(checks, "model strategy available", Boolean(publicStrategy?.version && publicStrategy?.generatedAt && gate), {
    version: publicStrategy?.version || null,
    generatedAt: publicStrategy?.generatedAt || null,
    gateStatus: gate?.status || null,
    onlineEffect: publicStrategy?.activation?.onlineEffect || null
  });
  const currentWalkForwardValidation = evaluation?.walkForwardValidation || null;
  const currentWalkForwardAudit = deepValidateWalkForwardArtifact(currentWalkForwardValidation);
  const currentWalkForwardBlocked = currentWalkForwardAudit.eligible !== true;
  pushCheck(checks, "current evaluation has no promotable walk-forward cohort",
    currentWalkForwardBlocked, {
      walkForwardValidation: currentWalkForwardValidation,
      deepAudit: currentWalkForwardAudit
    });
  const walkForwardGateBlocked = gate?.reasons?.includes("walk-forward-validation-unvalidated");
  pushCheck(checks, "current model remains fail-closed shadow",
    gate?.status === "shadow"
      && gate?.onlineEffect === "shadow"
      && publicStrategy?.activation?.onlineEffect === "shadow"
      && walkForwardGateBlocked
      && gate?.sample?.inputAuditOk === false
      && gate?.sample?.inputAuditViolationCount === 0
      && gate?.reasons?.includes("input-audit-failed")
      && gate?.sample?.recommendationSelectionEligible === false, {
      gateStatus: gate?.status || null,
      onlineEffect: publicStrategy?.activation?.onlineEffect || null,
      reasons: gate?.reasons || [],
      sample: gate?.sample || null
    });
  const {
    finalExposureRows: privateFinalExposureRows,
    settlementRows: privateSettlementRows,
    ...privateHhadCompanionAggregate
  } = hhadCompanionAudit || {};
  pushCheck(checks, "HHAD companion private audit is hash-verified in SQLite",
    Boolean(privateAuditRecord)
      && privateAuditRecord.artifactKey === HHAD_COMPANION_AUDIT_KEY
      && privateAuditRecord.artifactVersion === hhadCompanionAudit?.version
      && privateAuditRecord.generatedAt === hhadCompanionAudit?.evaluatedAt
      && privateAuditRecord.integrity?.hashVerified === true
      && privateAuditRecord.integrity?.sizeVerified === true
      && /^[0-9a-f]{64}$/.test(privateAuditRecord.payloadSha256 || "")
      && Number(privateAuditRecord.payloadBytes) > 0, {
      storage: privateArtifactStorage(),
      dbPath: privateArtifactStorage() === "sqlite" ? sqliteDbPath : null,
      artifactKey: privateAuditRecord?.artifactKey || null,
      artifactVersion: privateAuditRecord?.artifactVersion || null,
      payloadBytes: privateAuditRecord?.payloadBytes ?? null,
      payloadSha256: privateAuditRecord?.payloadSha256 || null,
      error: privateAuditError
    });
  pushCheck(checks, "legacy HHAD private audit file has been removed",
    !fs.existsSync(legacyHhadCompanionAuditPath), {
      legacyPath: legacyHhadCompanionAuditPath,
      present: fs.existsSync(legacyHhadCompanionAuditPath)
    });
  pushCheck(checks, "HHAD companion public evaluation is aggregate-only",
    Boolean(publicHhadCompanion?.version && publicHhadCompanion?.gate)
      && !Object.prototype.hasOwnProperty.call(publicHhadCompanion, "finalExposureRows")
      && !Object.prototype.hasOwnProperty.call(publicHhadCompanion, "settlementRows")
      && !fs.existsSync(path.join(publicDataDir, "hhad-companion-audit.json")), {
      version: publicHhadCompanion?.version || null,
      candidateStatus: publicHhadCompanion?.candidateStatus || null,
      pairedNonVoidRows: publicHhadCompanion?.counts?.pairedNonVoidRows ?? null,
      publicAuditFilePresent: fs.existsSync(path.join(publicDataDir, "hhad-companion-audit.json"))
    });
  pushCheck(checks, "HHAD companion private audit preserves internal rows and reproduces the public aggregate",
    Boolean(hhadCompanionAudit)
      && Array.isArray(privateFinalExposureRows)
      && Array.isArray(privateSettlementRows)
      && privateFinalExposureRows.length === Number(hhadCompanionAudit?.counts?.finalRevisions || 0)
      && privateSettlementRows.length === Number(hhadCompanionAudit?.counts?.settlementRows || 0)
      && sameJson(privateHhadCompanionAggregate, publicHhadCompanion), {
      auditAvailable: Boolean(hhadCompanionAudit),
      finalExposureRows: Array.isArray(privateFinalExposureRows) ? privateFinalExposureRows.length : null,
      settlementRows: Array.isArray(privateSettlementRows) ? privateSettlementRows.length : null,
      publicCounts: publicHhadCompanion?.counts || null
    });
  pushCheck(checks, "HHAD companion sample counts mirror the aggregate",
    sameJson(evaluation?.sample?.hhadCompanion || null, publicHhadCompanion?.counts || null), {
      sampleCounts: evaluation?.sample?.hhadCompanion || null,
      evaluationCounts: publicHhadCompanion?.counts || null
    });
  pushCheck(checks, "HHAD companion gate is copied as an independent permanent-shadow activation track",
    Boolean(strategyHhadCompanion)
      && sameJson(strategyHhadCompanion, expectedHhadCompanionGate)
      && strategyHhadCompanion.onlineEffect === "shadow"
      && strategyHhadCompanion.promotionAllowed === false, {
      expected: expectedHhadCompanionGate,
      actual: strategyHhadCompanion
    });
  const strategySettledRows = asNumber(publicStrategy?.sample?.settledRows);
  const strategyOfficialRows = asNumber(publicStrategy?.sample?.officialRows);
  const strategyRecommendationRows = asNumber(publicStrategy?.sample?.recommendationRows);
  const activeGateCount = Object.values(publicStrategy?.activeGates || {}).reduce((sum, value) => sum + asNumber(value), 0);
  pushCheck(checks, "strategy settled sample is leakage-safe or remains shadow", strategySettledRows > 0
    ? strategyOfficialRows > 0 && strategyRecommendationRows > 0
    : publicStrategy?.activation?.onlineEffect === "shadow" && activeGateCount === 0, {
      sample: publicStrategy?.sample || null,
      activeGates: publicStrategy?.activeGates || null
    });

  const evaluationTime = asTime(evaluation?.generatedAt);
  const strategyTime = asTime(publicStrategy?.generatedAt);
  const gateCheckedAt = asTime(gate?.checkedAt);
  pushCheck(checks, "strategy generated after backtest", Boolean(evaluationTime && (strategyTime >= evaluationTime || gateCheckedAt >= evaluationTime)), {
    evaluationGeneratedAt: evaluation?.generatedAt || null,
    strategyGeneratedAt: publicStrategy?.generatedAt || null,
    gateCheckedAt: gate?.checkedAt || null
  });
  pushCheck(checks, "strategy references evaluation version", gate?.sourceEvaluationVersion === evaluation?.version, {
    sourceEvaluationVersion: gate?.sourceEvaluationVersion || null,
    evaluationVersion: evaluation?.version || null
  });
  pushCheck(checks, "server strategy mirror matches public", Boolean(publicStrategy && serverStrategy && sameJson(publicStrategy, serverStrategy)), {
    publicGeneratedAt: publicStrategy?.generatedAt || null,
    serverGeneratedAt: serverStrategy?.generatedAt || null
  });
  pushCheck(checks, "sync health strategy metadata matches public strategy",
    syncMeta?.modelStrategy?.version === publicStrategy?.version
      && syncMeta?.modelStrategy?.generatedAt === publicStrategy?.generatedAt
      && syncMeta?.modelStrategy?.activation?.onlineEffect === publicStrategy?.activation?.onlineEffect
      && syncMeta?.modelStrategy?.activation?.promotionGate?.status === publicStrategy?.activation?.promotionGate?.status, {
      syncMetaVersion: syncMeta?.modelStrategy?.version || null,
      publicVersion: publicStrategy?.version || null,
      syncMetaGeneratedAt: syncMeta?.modelStrategy?.generatedAt || null,
      publicGeneratedAt: publicStrategy?.generatedAt || null,
      syncMetaOnlineEffect: syncMeta?.modelStrategy?.activation?.onlineEffect || null,
      publicOnlineEffect: publicStrategy?.activation?.onlineEffect || null,
      syncMetaGateStatus: syncMeta?.modelStrategy?.activation?.promotionGate?.status || null,
      publicGateStatus: publicStrategy?.activation?.promotionGate?.status || null
    });
  pushCheck(checks, "sync preserves shadow strategy observability without online injection",
    syncDataSource.includes("modelStrategy: existingModelStrategy ?")
      && !syncDataSource.includes("modelStrategy: modelCalibration.strategy ?"), {
      usesStrategyArtifact: syncDataSource.includes("modelStrategy: existingModelStrategy ?"),
      couplesMetadataToInjection: syncDataSource.includes("modelStrategy: modelCalibration.strategy ?")
    });

  const gateReasons = Array.isArray(gate?.reasons) ? gate.reasons : [];
  const hasExpectedReasons = expected.reasons.every((reason) => gateReasons.includes(reason));
  pushCheck(checks, "promotion gate reasons match thresholds", gate?.status === expected.expectedStatus && publicStrategy?.activation?.onlineEffect === expected.expectedOnlineEffect && hasExpectedReasons, {
    expectedStatus: expected.expectedStatus,
    actualStatus: gate?.status || null,
    expectedOnlineEffect: expected.expectedOnlineEffect,
    actualOnlineEffect: publicStrategy?.activation?.onlineEffect || null,
    expectedReasons: expected.reasons,
    actualReasons: gateReasons
  });
  pushCheck(checks, "promotion gate eligible scope is explicit", gate?.eligibleScope === expected.expectedEligibleScope, {
    expectedEligibleScope: expected.expectedEligibleScope,
    actualEligibleScope: gate?.eligibleScope || null
  });
  pushCheck(checks, "promotion gate threshold snapshot", sameJson(gate?.thresholds || null, expected.thresholds), {
    expected: expected.thresholds,
    actual: gate?.thresholds || null
  });
  pushCheck(checks, "promotion gate sample matches backtest", asNumber(gate?.sample?.marketBaselineRows, NaN) === expected.marketBaselineRows, {
    gateSample: gate?.sample || null,
    evaluationSample: evaluation?.sample || null
  });
  pushCheck(checks, "promotion gate requires candidate-local sample sizes", asNumber(gate?.sample?.candidateRows, NaN) === expected.candidateRows
    && asNumber(gate?.sample?.modelCandidateRows, NaN) === expected.modelCandidateRows, {
    expectedCandidateRows: expected.candidateRows,
    actualCandidateRows: gate?.sample?.candidateRows ?? null,
    expectedModelCandidateRows: expected.modelCandidateRows,
    actualModelCandidateRows: gate?.sample?.modelCandidateRows ?? null
  });

  const expectedBestCandidateId = evaluation?.shadowCandidates?.bestCandidateId || evaluation?.shadowCandidates?.bestCandidate?.id || null;
  pushCheck(checks, "promotion gate candidate matches shadow best", gate?.shadowCandidate?.id === expectedBestCandidateId, {
    gateCandidateId: gate?.shadowCandidate?.id || null,
    evaluationBestCandidateId: expectedBestCandidateId
  });
  pushCheck(checks, "promotion gate model-signal status matches shadow best model", gate?.modelSignal?.status === expected.modelSignalStatus
    && gate?.modelSignal?.readyForGuardedUse === expected.modelSignalReady
    && gate?.modelSignal?.onlineEffect === expected.modelSignalOnlineEffect
    && gate?.modelSignal?.bestCandidateUsesModelSignal === expected.bestCandidateUsesModelSignal
    && (gate?.modelSignal?.bestModelCandidateId || null) === expected.bestModelCandidateId, {
      expectedStatus: expected.modelSignalStatus,
      actualStatus: gate?.modelSignal?.status || null,
      expectedReadyForGuardedUse: expected.modelSignalReady,
      actualReadyForGuardedUse: gate?.modelSignal?.readyForGuardedUse ?? null,
      expectedOnlineEffect: expected.modelSignalOnlineEffect,
      actualOnlineEffect: gate?.modelSignal?.onlineEffect || null,
      expectedBestCandidateUsesModelSignal: expected.bestCandidateUsesModelSignal,
      actualBestCandidateUsesModelSignal: gate?.modelSignal?.bestCandidateUsesModelSignal ?? null,
      expectedBestModelCandidateId: expected.bestModelCandidateId,
      actualBestModelCandidateId: gate?.modelSignal?.bestModelCandidateId || null
    });
  pushCheck(checks, "promotion gate model-signal candidate payload matches evaluation", expected.bestModelCandidateId
    ? gate?.modelSignalCandidate?.id === expected.bestModelCandidateId
    : gate?.modelSignalCandidate === null, {
      expectedBestModelCandidateId: expected.bestModelCandidateId,
      actualModelSignalCandidateId: gate?.modelSignalCandidate?.id || null
    });

  const expectedRiskTier = evaluation?.riskTiers?.overall?.tier || "unknown";
  const looseningRules = collectRulesByAction(publicStrategy, "loosen");
  const sampleGuard = Array.isArray(publicStrategy?.recommendations)
    ? publicStrategy.recommendations.find((item) => item?.id === "sample-guard")
    : null;
  const riskStable = expectedRiskTier === "stable";
  pushCheck(checks, "risk guard mirrors evaluation tier", riskGuard?.version === "risk-constrained-exposure-v1"
    && riskGuard?.riskTier === expectedRiskTier
    && riskGuard?.looseningAllowed === riskStable, {
      expectedRiskTier,
      riskGuard
    });
  pushCheck(checks, "risk guard blocks loosening when tier is not stable", riskStable || (
    riskGuard?.looseningAllowed === false
    && looseningRules.length === 0
    && ["risk-constrained-cooling", "shadow-only"].includes(sampleGuard?.status)
  ), {
    riskTier: expectedRiskTier,
    looseningAllowed: riskGuard?.looseningAllowed ?? null,
    looseningRules: looseningRules.length,
    sampleGuardStatus: sampleGuard?.status || null
  });

  const calibrationStrategy = calibration?.strategy || calibration?.dynamicCalibration?.strategy || null;
  const injectedStrategies = collectInjectedStrategies(currentMatches);
  if (publicStrategy?.activation?.onlineEffect === "shadow") {
    const calibrationReferenceTighteningSafe = !calibrationStrategy || (
      calibrationStrategy?.activation?.onlineEffect === "tighten-only-reference-shadow"
      && calibrationStrategy?.activation?.promotionAllowed === false
      && calibrationStrategy?.activation?.looseningAllowed === false
    );
    const injectedReferenceTighteningSafe = injectedStrategies.every((row) => (
      row.dynamicOnlineEffect === "tighten-only-reference-shadow"
      || row.legacyOnlineEffect === "tighten-only-reference-shadow"
    ));
    pushCheck(checks, "shadow formal strategy is absent; any reference shadow effect is tighten-only", calibrationReferenceTighteningSafe, {
      calibrationStrategyOnlineEffect: calibrationStrategy?.activation?.onlineEffect || calibrationStrategy?.onlineEffect || null,
      promotionAllowed: calibrationStrategy?.activation?.promotionAllowed ?? null,
      looseningAllowed: calibrationStrategy?.activation?.looseningAllowed ?? null
    });
    pushCheck(checks, "shadow formal strategy is absent from current recommendations", injectedReferenceTighteningSafe, {
      injected: injectedStrategies.length,
      sample: injectedStrategies.slice(0, 5)
    });
  } else {
    pushCheck(checks, "guarded strategy attached to calibration", calibrationStrategy?.activation?.onlineEffect === "guarded-active", {
      calibrationStrategyOnlineEffect: calibrationStrategy?.activation?.onlineEffect || calibrationStrategy?.onlineEffect || null
    });
  }

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    summary: {
      evaluationGeneratedAt: evaluation?.generatedAt || null,
      strategyGeneratedAt: publicStrategy?.generatedAt || null,
      gateStatus: gate?.status || null,
      onlineEffect: publicStrategy?.activation?.onlineEffect || null,
      reasons: gateReasons,
      currentMatches: currentMatches.length
    },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run().catch(error => { console.error(error.message); process.exitCode = 1; });
