const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = process.env.SERVER_STORE_DIR || path.join(rootDir, "server-data");

const MIN_MARKET_BASELINE_ROWS = Math.max(30, Number(process.env.MODEL_INPUT_AUDIT_MIN_MARKET_ROWS || 100));
const MIN_ROLLING_WINDOWS = Math.max(1, Number(process.env.MODEL_INPUT_AUDIT_MIN_ROLLING_WINDOWS || 1));

const readJson = (filePath, fallback = null) => {
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
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const parseTime = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : NaN;
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const violationSummary = (audit) => {
  const groups = audit?.violations && typeof audit.violations === "object" ? audit.violations : {};
  const rows = Object.entries(groups).map(([name, value]) => ({
    name,
    count: asNumber(value?.count, 0),
    sample: Array.isArray(value?.sample) ? value.sample.slice(0, 3) : []
  }));
  return {
    total: Number.isFinite(asNumber(audit?.violationCount, NaN))
      ? asNumber(audit.violationCount, NaN)
      : rows.reduce((sum, row) => sum + row.count, 0),
    rows
  };
};

const rollingWindowsOrdered = (windows, minimumWindows = MIN_ROLLING_WINDOWS) => {
  if (!Array.isArray(windows)) return false;
  const rows = windows;
  let previousEnd = -Infinity;
  for (const row of rows) {
    const start = parseTime(row?.startKickoffTime);
    const end = parseTime(row?.endKickoffTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < previousEnd) return false;
    if (asNumber(row?.rows, 0) <= 0) return false;
    previousEnd = end;
  }
  return rows.length >= minimumWindows;
};

const candidateMetricsArePairedAndAuditable = (candidate, {
  allowBaselineSentinel = false,
  baselineId = null,
  expectedRows = null,
  expectedMaxRows = null,
} = {}) => {
  if (!candidate || typeof candidate !== "object") return false;
  const comparison = candidate.comparison || {};
  const comparisonRows = asNumber(comparison.rows, 0);
  const metricsRows = asNumber(candidate?.metrics?.rows, -1);
  const sameMatchRows = asNumber(candidate?.sameMatchMarketMetrics?.rows, -2);
  const baselineSentinelAllowed = allowBaselineSentinel
      && candidate.role === "baseline"
      && candidate.id === "market-baseline"
      && baselineId === "market-baseline"
      && asNumber(candidate?.weights?.market, NaN) === 1
      && asNumber(candidate?.weights?.model, NaN) === 0
      && asNumber(comparison.logLossImprovement, NaN) === 0
      && asNumber(comparison.brierImprovement, NaN) === 0;
  const candidateRoleAllowed = candidate.role !== "baseline" || baselineSentinelAllowed;
  return candidateRoleAllowed
    && comparisonRows > 0
    && Number.isFinite(asNumber(comparison.logLossImprovement, NaN))
    && Number.isFinite(asNumber(comparison.brierImprovement, NaN))
    && comparison.pairedByMatch === true
    && sameMatchRows === metricsRows
    && comparisonRows === metricsRows
    && (expectedRows === null || comparisonRows === expectedRows)
    && (expectedMaxRows === null || comparisonRows <= expectedMaxRows);
};

const run = () => {
  const checks = [];
  const pairedSubsetFixture = {
    role: "shadow-model-candidate",
    metrics: { rows: 25 },
    sameMatchMarketMetrics: { rows: 25 },
    comparison: {
      rows: 25,
      logLossImprovement: 0.01,
      brierImprovement: 0.005,
      pairedByMatch: true,
    },
  };
  pushCheck(checks, "paired feature-availability subsets stay auditable without claiming full market coverage",
    candidateMetricsArePairedAndAuditable(pairedSubsetFixture, { expectedMaxRows: 31 })
      && !candidateMetricsArePairedAndAuditable(pairedSubsetFixture, { expectedMaxRows: 24 }));
  const nullFailClosedResult = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "runModelBacktest.cjs"), "--verify-null-fail-closed"],
    { cwd: rootDir, encoding: "utf8", env: process.env },
  );
  let nullFailClosedAudit = null;
  try {
    nullFailClosedAudit = JSON.parse(nullFailClosedResult.stdout || "null");
  } catch {
    nullFailClosedAudit = null;
  }
  pushCheck(checks, "backtest null, blank, score, balance and stability guards fail closed",
    nullFailClosedResult.status === 0
      && nullFailClosedAudit?.ok === true
      && nullFailClosedAudit?.verifier === "model-backtest-null-fail-closed"
      && Number(nullFailClosedAudit?.assertions || 0) >= 19
      && nullFailClosedAudit.checks.every((check) => check.ok === true), {
      status: nullFailClosedResult.status,
      audit: nullFailClosedAudit,
      stderr: String(nullFailClosedResult.stderr || "").trim() || null,
    });
  const probabilitySelectionResult = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "runModelBacktest.cjs"), "--verify-probability-selection"],
    { cwd: rootDir, encoding: "utf8", env: process.env },
  );
  let probabilitySelectionAudit = null;
  try {
    probabilitySelectionAudit = JSON.parse(probabilitySelectionResult.stdout || "null");
  } catch {
    probabilitySelectionAudit = null;
  }
  pushCheck(checks, "post-kickoff match probabilities fall back or are excluded before input audit",
    probabilitySelectionResult.status === 0
      && probabilitySelectionAudit?.ok === true
      && probabilitySelectionAudit?.verifier === "model-backtest-pre-match-probability-selection"
      && Number(probabilitySelectionAudit?.assertions || 0) >= 4
      && probabilitySelectionAudit.checks.every((check) => check.ok === true), {
      status: probabilitySelectionResult.status,
      audit: probabilitySelectionAudit,
      stderr: String(probabilitySelectionResult.stderr || "").trim() || null,
    });
  const strictCohortResult = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "runModelBacktest.cjs"), "--verify-strict-promotion-cohort"],
    { cwd: rootDir, encoding: "utf8", env: process.env },
  );
  let strictCohortAudit = null;
  try {
    strictCohortAudit = JSON.parse(strictCohortResult.stdout || "null");
  } catch {
    strictCohortAudit = null;
  }
  pushCheck(checks, "strict promotion cohort rejects legacy and mutable fallback evidence",
    strictCohortResult.status === 0
      && strictCohortAudit?.ok === true
      && strictCohortAudit?.verifier === "model-backtest-strict-promotion-cohort"
      && Number(strictCohortAudit?.assertions || 0) >= 11
      && strictCohortAudit.checks.every((check) => check.ok === true), {
      status: strictCohortResult.status,
      audit: strictCohortAudit,
      stderr: String(strictCohortResult.stderr || "").trim() || null,
    });
  const sqliteStreamingResult = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=128",
      "--expose-gc",
      path.join(rootDir, "scripts", "runModelBacktest.cjs"),
      "--verify-sqlite-streaming",
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  let sqliteStreamingAudit = null;
  try {
    sqliteStreamingAudit = JSON.parse(sqliteStreamingResult.stdout || "null");
  } catch {
    sqliteStreamingAudit = null;
  }
  pushCheck(checks, "SQLite model inputs stream, deduplicate and retain audit semantics under constrained heap",
    sqliteStreamingResult.status === 0
      && sqliteStreamingAudit?.ok === true
      && sqliteStreamingAudit?.verifier === "model-backtest-sqlite-streaming"
      && Number(sqliteStreamingAudit?.assertions || 0) >= 6
      && sqliteStreamingAudit.checks.every((check) => check.ok === true), {
      status: sqliteStreamingResult.status,
      audit: sqliteStreamingAudit,
      stderr: String(sqliteStreamingResult.stderr || "").trim() || null,
    });
  const publicEvaluation = readJson(path.join(publicDataDir, "model-evaluation.json"));
  const serverEvaluation = readJson(path.join(serverDataDir, "model-artifacts", "evaluation.json"));
  const publicStrategy = readJson(path.join(publicDataDir, "model-strategy.json"));
  const audit = publicEvaluation?.inputAudit || null;
  const probabilitySelection = audit?.coverage?.probabilitySelection || null;
  const closingLineValue = publicEvaluation?.closingLineValue || null;
  const clvTimingAudit = closingLineValue?.timingAudit || null;
  const clvReasonRows = Object.values(clvTimingAudit?.reasonCounts || {})
    .reduce((sum, value) => sum + asNumber(value, 0), 0);
  const clvCandidateRows = asNumber(closingLineValue?.candidateRows, 0);
  const clvEligibleRows = asNumber(closingLineValue?.rows, 0);
  const clvMovementMissingRows = asNumber(clvTimingAudit?.movementMissingRows, 0);
  const violations = violationSummary(audit);
  const sourceCounts = audit?.coverage?.sourceCounts || {};
  const probabilitySourceTotal = Object.values(sourceCounts).reduce((sum, value) => sum + asNumber(value, 0), 0);
  const probabilityRows = asNumber(publicEvaluation?.sample?.probabilityRows, 0);
  const marketBaselineRows = asNumber(publicEvaluation?.sample?.marketBaselineRows, 0);
  const bestCandidate = publicEvaluation?.shadowCandidates?.bestCandidate || null;
  const gate = publicStrategy?.activation?.promotionGate || null;
  const explicitHistoricalResultTimes = asNumber(audit?.coverage?.historicalResultTimeSources?.explicit, 0);
  const fallbackHistoricalResultTimes = asNumber(audit?.coverage?.historicalResultTimeSources?.kickoffPlusThreeHours, 0);
  const historicalFeatureSnapshotRows = asNumber(audit?.coverage?.rowsWithHistoricalFeatureSnapshot, 0);
  const auditPromotionBlockers = Array.isArray(audit?.promotionBlockers) ? audit.promotionBlockers : [];
  const missingHistoricalInputsFailClosed = historicalFeatureSnapshotRows === 0
    && explicitHistoricalResultTimes === 0
    && fallbackHistoricalResultTimes === 0
    && audit?.promotionEligible === false
    && auditPromotionBlockers.some((blocker) => String(blocker).startsWith("promotion-cohort-rows:0<"));
  const baselineSampleSufficient = marketBaselineRows >= MIN_MARKET_BASELINE_ROWS;
  const undersizedBaselineFailsClosed = !baselineSampleSufficient
    && marketBaselineRows > 0
    && gate?.status === "shadow"
    && gate?.onlineEffect === "shadow"
    && gate?.eligibleScope === "none"
    && publicStrategy?.activation?.onlineEffect === "shadow"
    && publicStrategy?.activation?.riskGuard?.looseningAllowed === false
    && gate?.modelSignal?.readyForGuardedUse === false
    && Array.isArray(gate?.reasons)
    && gate.reasons.some((reason) => String(reason).startsWith(`market-baseline-rows:${marketBaselineRows}<`));

  pushCheck(checks, "model evaluation input audit available", Boolean(publicEvaluation?.version && audit?.version === "pre-match-input-audit-v1"), {
    evaluationVersion: publicEvaluation?.version || null,
    auditVersion: audit?.version || null,
    generatedAt: publicEvaluation?.generatedAt || null
  });
  pushCheck(checks, "server and public evaluation mirror audit", Boolean(publicEvaluation && serverEvaluation)
    && publicEvaluation.version === serverEvaluation.version
    && publicEvaluation.generatedAt === serverEvaluation.generatedAt
    && sameJson(publicEvaluation.inputAudit, serverEvaluation.inputAudit), {
      publicGeneratedAt: publicEvaluation?.generatedAt || null,
      serverGeneratedAt: serverEvaluation?.generatedAt || null
    });
  pushCheck(checks, "closing-line denominator reconciles to distinct pre-kickoff observations",
    closingLineValue?.version === "closing-line-value-v2"
    && clvTimingAudit?.version === "closing-line-timing-audit-v1"
    && clvCandidateRows === clvEligibleRows + clvMovementMissingRows + clvReasonRows
    && asNumber(publicEvaluation?.sample?.clvRows, -1) === clvEligibleRows
    && asNumber(publicEvaluation?.sample?.clvCandidateRows, -1) === clvCandidateRows
    && Math.abs(
      asNumber(publicEvaluation?.sample?.clvTimingCoverage, -1)
      - (clvCandidateRows > 0 ? clvEligibleRows / clvCandidateRows : 0)
    ) <= 0.000001, {
      version: closingLineValue?.version || null,
      timingVersion: clvTimingAudit?.version || null,
      candidateRows: clvCandidateRows,
      eligibleRows: clvEligibleRows,
      movementMissingRows: clvMovementMissingRows,
      excludedReasonRows: clvReasonRows,
      timingCoverage: closingLineValue?.timingCoverage ?? null,
      sample: {
        clvRows: publicEvaluation?.sample?.clvRows ?? null,
        clvCandidateRows: publicEvaluation?.sample?.clvCandidateRows ?? null,
        clvTimingCoverage: publicEvaluation?.sample?.clvTimingCoverage ?? null
      }
    });
  pushCheck(checks, "pre-match input audit has zero leakage violations", audit?.ok === true && violations.total === 0, {
    violationCount: violations.total,
    violations: violations.rows
  });
  pushCheck(checks, "audit coverage matches probability sample", probabilityRows > 0
    && asNumber(audit?.coverage?.rows, 0) === probabilityRows
    && probabilitySourceTotal === probabilityRows
    && asNumber(sourceCounts.preMatchSnapshot, 0) === asNumber(publicEvaluation?.sample?.probabilitySources?.preMatchSnapshot, 0), {
      probabilityRows,
      auditRows: audit?.coverage?.rows ?? null,
      probabilitySourceTotal,
      sourceCounts,
      sampleSources: publicEvaluation?.sample?.probabilitySources || null
    });
  pushCheck(checks, "forecast and market coverage are explicit", asNumber(audit?.coverage?.rowsWithForecastTime, 0) === probabilityRows
    && asNumber(audit?.coverage?.rowsWithMarketAtForecast, 0) === marketBaselineRows
    && (historicalFeatureSnapshotRows > 0 || missingHistoricalInputsFailClosed), {
      rowsWithForecastTime: audit?.coverage?.rowsWithForecastTime ?? null,
      rowsWithMarketAtForecast: audit?.coverage?.rowsWithMarketAtForecast ?? null,
      rowsWithHistoricalFeatureSnapshot: audit?.coverage?.rowsWithHistoricalFeatureSnapshot ?? null,
      missingHistoricalInputsFailClosed,
      marketBaselineRows
    });
  pushCheck(checks, "historical result chronology is explicit and before forecast", String(audit?.policy?.historicalFeaturePolicy || "").includes("attributed non-fallback results")
    && String(audit?.policy?.historicalFeaturePolicy || "").includes("no later than forecastTime")
    && String(audit?.policy?.historicalFeaturePolicy || "").includes("missing result clocks are excluded rather than synthesized")
    && asNumber(audit?.violations?.historicalResultAfterForecast?.count, -1) === 0
    && asNumber(audit?.violations?.historicalPolicyMissing?.count, -1) === 0, {
      policy: audit?.policy?.historicalFeaturePolicy || null,
      historicalResultAfterForecast: audit?.violations?.historicalResultAfterForecast || null,
      historicalPolicyMissing: audit?.violations?.historicalPolicyMissing || null,
      resultTimeSources: audit?.coverage?.historicalResultTimeSources || null
    });
  pushCheck(checks, "fallback historical result times fail promotion closed", fallbackHistoricalResultTimes > 0
    ? audit?.promotionEligible === false
      && auditPromotionBlockers.some((blocker) => String(blocker).startsWith("historical-result-observed-at-fallback:"))
    : !auditPromotionBlockers.some((blocker) => String(blocker).startsWith("historical-result-observed-at-fallback:"))
      && (explicitHistoricalResultTimes > 0 || missingHistoricalInputsFailClosed), {
      promotionEligible: audit?.promotionEligible ?? null,
      promotionBlockers: auditPromotionBlockers,
      historicalFeatureSnapshotRows,
      missingHistoricalInputsFailClosed,
      explicitHistoricalResultTimes,
      fallbackHistoricalResultTimes
    });
  pushCheck(checks, "time windows are chronological", Number.isFinite(parseTime(audit?.timeWindow?.firstKickoffTime))
    && Number.isFinite(parseTime(audit?.timeWindow?.lastKickoffTime))
    && parseTime(audit.timeWindow.firstKickoffTime) <= parseTime(audit.timeWindow.lastKickoffTime)
    && Number.isFinite(parseTime(audit?.timeWindow?.firstForecastTime))
    && Number.isFinite(parseTime(audit?.timeWindow?.lastForecastTime))
    && parseTime(audit.timeWindow.firstForecastTime) <= parseTime(audit.timeWindow.lastForecastTime), {
      timeWindow: audit?.timeWindow || null
    });
  const candidateRolling = bestCandidate?.rolling || null;
  const candidateRollingMinRows = asNumber(candidateRolling?.minRowsPerWindow, 0);
  const gateReasons = Array.isArray(gate?.reasons) ? gate.reasons.map(String) : [];
  const zeroWindowShadowFallbackAllowed = undersizedBaselineFailsClosed
    && Array.isArray(publicEvaluation?.rollingWindows)
    && publicEvaluation.rollingWindows.length === 0
    && candidateRollingMinRows > 0
    && marketBaselineRows < candidateRollingMinRows
    && asNumber(candidateRolling?.windows, -1) === 0
    && asNumber(candidateRolling?.passed, -1) === 0
    && candidateRolling?.passRate === null
    && candidateRolling?.sufficientIndependentWindows === false
    && asNumber(gate?.sample?.rollingWindows, -1) === 0
    && gateReasons.some((reason) => reason.startsWith("independent-rolling-windows:0<"))
    && gateReasons.some((reason) => reason.startsWith("rolling-pass-rate:missing"));
  const minimumRequiredRollingWindows = zeroWindowShadowFallbackAllowed ? 0 : MIN_ROLLING_WINDOWS;
  pushCheck(checks, "rolling windows are time ordered", rollingWindowsOrdered(
    publicEvaluation?.rollingWindows,
    minimumRequiredRollingWindows,
  ), {
    windows: Array.isArray(publicEvaluation?.rollingWindows) ? publicEvaluation.rollingWindows.length : 0,
    minimumRequiredWindows: minimumRequiredRollingWindows,
    undersizedBaselineFailsClosed,
    zeroWindowShadowFallbackAllowed,
    candidateRollingMinRows,
    firstWindow: publicEvaluation?.rollingWindows?.[0] || null,
      lastWindow: publicEvaluation?.rollingWindows?.slice(-1)[0] || null
    });
  const horizonBuckets = publicEvaluation?.forecastHorizons?.buckets || {};
  const horizonRows = Object.values(horizonBuckets).reduce((sum, bucket) => sum + asNumber(bucket?.rows, 0), 0);
  pushCheck(checks, "forecast horizons are stratified", publicEvaluation?.forecastHorizons?.version === "forecast-horizon-audit-v1"
    && horizonRows === probabilityRows
    && ["lt_10m", "m10_60", "h1_6", "h6_24", "gt_24h", "unknown"].every((id) => horizonBuckets[id])
    && Number.isFinite(Number(publicEvaluation?.forecastHorizons?.leadMinutes?.median)), {
      probabilityRows,
      horizonRows,
      leadMinutes: publicEvaluation?.forecastHorizons?.leadMinutes || null,
      buckets: Object.fromEntries(Object.entries(horizonBuckets).map(([id, bucket]) => [id, {
        rows: bucket?.rows || 0,
        matchedMarketRows: bucket?.matchedMarketRows || 0
      }]))
    });
  pushCheck(checks, "market baseline is forecast-time baseline and undersized samples stay shadow", marketBaselineRows > 0
    && String(publicEvaluation?.marketBaseline?.source || "").includes("forecast-time")
    && asNumber(publicEvaluation?.marketBaseline?.metrics?.rows, 0) === marketBaselineRows
    && (baselineSampleSufficient || undersizedBaselineFailsClosed), {
      source: publicEvaluation?.marketBaseline?.source || null,
      marketBaselineRows,
      minMarketBaselineRows: MIN_MARKET_BASELINE_ROWS,
      metricRows: publicEvaluation?.marketBaseline?.metrics?.rows ?? null,
      baselineSampleSufficient,
      undersizedBaselineFailsClosed,
      gateStatus: gate?.status || null,
      gateOnlineEffect: gate?.onlineEffect || null,
      eligibleScope: gate?.eligibleScope || null,
      looseningAllowed: publicStrategy?.activation?.riskGuard?.looseningAllowed ?? null
    });
  pushCheck(checks, "shadow best candidate metrics are paired and bounded by the market cohort", candidateMetricsArePairedAndAuditable(
    bestCandidate,
    {
      allowBaselineSentinel: zeroWindowShadowFallbackAllowed,
      baselineId: publicEvaluation?.shadowCandidates?.baselineId || null,
      expectedRows: bestCandidate?.role === "baseline" ? marketBaselineRows : null,
      expectedMaxRows: marketBaselineRows,
    },
  ), {
    bestCandidateId: bestCandidate?.id || null,
    role: bestCandidate?.role || null,
    allowBaselineSentinel: zeroWindowShadowFallbackAllowed,
    marketBaselineRows,
    comparison: bestCandidate?.comparison || null,
    rolling: bestCandidate?.rolling || null
  });
  pushCheck(checks, "promotion gate references audited candidate", gate?.sourceEvaluationVersion === publicEvaluation?.version
    && gate?.shadowCandidate?.id === bestCandidate?.id
    && gate?.sample?.marketBaselineRows === marketBaselineRows, {
      gateStatus: gate?.status || null,
      onlineEffect: publicStrategy?.activation?.onlineEffect || null,
      sourceEvaluationVersion: gate?.sourceEvaluationVersion || null,
      gateCandidateId: gate?.shadowCandidate?.id || null,
      bestCandidateId: bestCandidate?.id || null,
      gateSample: gate?.sample || null
    });
  pushCheck(checks, "public artifact does not expose row-level backtest inputs", !Array.isArray(publicEvaluation?.probabilityRows)
    && !Array.isArray(publicEvaluation?.predictionRows)
    && !Array.isArray(publicEvaluation?.inputRows), {
      hasProbabilityRows: Array.isArray(publicEvaluation?.probabilityRows),
      hasPredictionRows: Array.isArray(publicEvaluation?.predictionRows),
      hasInputRows: Array.isArray(publicEvaluation?.inputRows)
    });
  const selectionReasonCounts = probabilitySelection?.reasonCounts
    && typeof probabilitySelection.reasonCounts === "object"
    ? Object.values(probabilitySelection.reasonCounts)
    : [];
  pushCheck(checks, "probability selection audit remains aggregate-only when present", !probabilitySelection || (
    probabilitySelection.version === "pre-match-probability-selection-audit-v1"
      && asNumber(probabilitySelection.consideredRows, -1)
        === asNumber(probabilitySelection.selectedRows, -2) + asNumber(probabilitySelection.excludedRows, -3)
      && asNumber(probabilitySelection.selectedRows, -1)
        === asNumber(probabilitySelection.matchModelSelected, -2)
          + asNumber(probabilitySelection.snapshotFallbackSelected, -3)
      && asNumber(probabilitySelection.snapshotFallbackAttempts, -1)
        === asNumber(probabilitySelection.snapshotFallbackSelected, -2)
          + asNumber(probabilitySelection.excludedRows, -3)
      && selectionReasonCounts.length >= 5
      && selectionReasonCounts.every((count) => Number.isInteger(Number(count)) && Number(count) >= 0)
      && !Array.isArray(probabilitySelection.rows)
      && !Array.isArray(probabilitySelection.samples)
      && !Object.hasOwn(probabilitySelection, "matchIds")
  ), {
    probabilitySelection,
  });
  pushCheck(checks, "policy declares no-random-split and no-LLM-probability role", String(publicEvaluation?.policy?.split || "").includes("time-ordered")
    && String(audit?.policy?.splitPolicy || "").includes("no random split")
    && String(publicEvaluation?.policy?.llmRole || "").includes("risk review"), {
      split: publicEvaluation?.policy?.split || null,
      auditSplitPolicy: audit?.policy?.splitPolicy || null,
      llmRole: publicEvaluation?.policy?.llmRole || null
    });

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    summary: {
      evaluationVersion: publicEvaluation?.version || null,
      generatedAt: publicEvaluation?.generatedAt || null,
      auditOk: audit?.ok ?? null,
      violationCount: violations.total,
      probabilityRows,
      marketBaselineRows,
      bestCandidateId: bestCandidate?.id || null,
      gateStatus: gate?.status || null,
      onlineEffect: publicStrategy?.activation?.onlineEffect || null
    },
    checks
  }, null, 2));
  if (!ok) process.exitCode = 1;
};

run();
