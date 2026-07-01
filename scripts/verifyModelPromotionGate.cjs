const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = path.join(rootDir, "server-data");

const PROMOTION_MIN_BASELINE_ROWS = Math.max(30, Number(process.env.MODEL_PROMOTION_MIN_BASELINE_ROWS || 100));
const PROMOTION_MIN_LOG_LOSS_IMPROVEMENT = Number(process.env.MODEL_PROMOTION_MIN_LOG_LOSS_IMPROVEMENT || 0);
const PROMOTION_MIN_BRIER_IMPROVEMENT = Number(process.env.MODEL_PROMOTION_MIN_BRIER_IMPROVEMENT || 0);
const PROMOTION_MIN_ROLLING_PASS_RATE = Math.min(1, Math.max(0, Number(process.env.MODEL_PROMOTION_MIN_ROLLING_PASS_RATE || 0.6)));

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
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const asTime = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const collectInjectedStrategies = (matches) => {
  const rows = [];
  for (const match of matches) {
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

const expectedGateReasons = (evaluation) => {
  const sample = evaluation?.sample || {};
  const currentModelComparison = evaluation?.marketBaseline?.comparison || {};
  const bestCandidate = evaluation?.shadowCandidates?.bestCandidate || null;
  const candidateComparison = bestCandidate?.comparison || currentModelComparison;
  const candidateRolling = bestCandidate?.rolling || null;
  const marketBaselineRows = asNumber(sample.marketBaselineRows || currentModelComparison.rows);
  const logLossImprovement = asNumber(candidateComparison.logLossImprovement, NaN);
  const brierImprovement = asNumber(candidateComparison.brierImprovement, NaN);
  const rollingPassRate = candidateRolling?.windows
    ? asNumber(candidateRolling.passRate, NaN)
    : null;
  const reasons = [];

  if (marketBaselineRows < PROMOTION_MIN_BASELINE_ROWS) {
    reasons.push(`market-baseline-rows:${marketBaselineRows}<${PROMOTION_MIN_BASELINE_ROWS}`);
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
  if (candidateRolling?.windows && (!Number.isFinite(rollingPassRate) || rollingPassRate < PROMOTION_MIN_ROLLING_PASS_RATE)) {
    reasons.push(`rolling-pass-rate:${Number.isFinite(rollingPassRate) ? rollingPassRate : "missing"}<${PROMOTION_MIN_ROLLING_PASS_RATE}`);
  }

  return {
    reasons,
    marketBaselineRows,
    bestCandidateId: bestCandidate?.id || null,
    expectedStatus: reasons.length ? "shadow" : "eligible",
    expectedOnlineEffect: reasons.length ? "shadow" : "guarded-active",
    thresholds: {
      minMarketBaselineRows: PROMOTION_MIN_BASELINE_ROWS,
      minLogLossImprovement: PROMOTION_MIN_LOG_LOSS_IMPROVEMENT,
      minBrierImprovement: PROMOTION_MIN_BRIER_IMPROVEMENT,
      minRollingPassRate: PROMOTION_MIN_ROLLING_PASS_RATE
    }
  };
};

const run = () => {
  const checks = [];
  const evaluation = readJson(path.join(publicDataDir, "model-evaluation.json"), null);
  const publicStrategy = readJson(path.join(publicDataDir, "model-strategy.json"), null);
  const serverStrategy = readJson(path.join(serverDataDir, "model-strategy.json"), null);
  const calibration = readJson(path.join(publicDataDir, "model-calibration.json"), null);
  const currentPayload = readJson(path.join(publicDataDir, "matches-current.json"), []);
  const currentMatches = Array.isArray(currentPayload) ? currentPayload : (currentPayload?.matches || []);
  const gate = publicStrategy?.activation?.promotionGate || null;
  const expected = expectedGateReasons(evaluation);

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
  pushCheck(checks, "strategy settled sample available", asNumber(publicStrategy?.sample?.settledRows) > 0
    && asNumber(publicStrategy?.sample?.officialRows) > 0
    && asNumber(publicStrategy?.sample?.recommendationRows) > 0, {
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
  pushCheck(checks, "promotion gate threshold snapshot", sameJson(gate?.thresholds || null, expected.thresholds), {
    expected: expected.thresholds,
    actual: gate?.thresholds || null
  });
  pushCheck(checks, "promotion gate sample matches backtest", asNumber(gate?.sample?.marketBaselineRows, NaN) === expected.marketBaselineRows, {
    gateSample: gate?.sample || null,
    evaluationSample: evaluation?.sample || null
  });

  const expectedBestCandidateId = evaluation?.shadowCandidates?.bestCandidateId || evaluation?.shadowCandidates?.bestCandidate?.id || null;
  pushCheck(checks, "promotion gate candidate matches shadow best", gate?.shadowCandidate?.id === expectedBestCandidateId, {
    gateCandidateId: gate?.shadowCandidate?.id || null,
    evaluationBestCandidateId: expectedBestCandidateId
  });

  const calibrationStrategy = calibration?.strategy || calibration?.dynamicCalibration?.strategy || null;
  const injectedStrategies = collectInjectedStrategies(currentMatches);
  if (publicStrategy?.activation?.onlineEffect === "shadow") {
    pushCheck(checks, "shadow strategy not injected into calibration", !calibrationStrategy, {
      calibrationStrategyOnlineEffect: calibrationStrategy?.activation?.onlineEffect || calibrationStrategy?.onlineEffect || null
    });
    pushCheck(checks, "shadow strategy not injected into current recommendations", injectedStrategies.length === 0, {
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

run();
