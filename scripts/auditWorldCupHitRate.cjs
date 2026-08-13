const fs = require("node:fs");
const path = require("node:path");
const {
  GOODWIN_BENCHMARK_SHADOW_POLICY,
  evaluateBenchmarkSelection,
} = require("../src/services/benchmarkSelectionPolicy.cjs");

const VERSION = "world-cup-hit-rate-audit-v3";
const DEFAULT_DATA_DIR = path.resolve(__dirname, "..", "public", "data");

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const asRows = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
};

const finiteNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseAuditTime = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const matchKey = (match) => String(
  match?.sourceMatchId
  || String(match?.id || "").replace(/^sporttery_/, "")
  || [match?.kickoffTime, match?.homeTeamName, match?.awayTeamName].filter(Boolean).join("|")
  || "",
).trim();

const isWorldCupFinalsMatch = (match) => {
  const leagueSignals = [
    match?.leagueName,
    match?.leagueNameEn,
    match?.leagueShortName,
    match?.leagueShortNameEn,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return leagueSignals.some((value) => /^(?:\u4e16\u754c\u676f|world cup|fifa world cup)$/i.test(value));
};

const matchQuality = (match) => {
  let score = 0;
  if (match?.status === "FINISHED") score += 20;
  if (Number.isFinite(Number(match?.scoreHome)) && Number.isFinite(Number(match?.scoreAway))) score += 10;
  if (match?.resultObservedAt) score += 4;
  if (match?.sourceCycleId) score += 2;
  return score;
};

const dedupeMatches = (matches) => {
  const byKey = new Map();
  for (const match of matches || []) {
    if (!isWorldCupFinalsMatch(match)) continue;
    const key = matchKey(match);
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous || matchQuality(match) >= matchQuality(previous)) byKey.set(key, match);
  }
  return [...byKey.values()].sort((left, right) => (
    String(left?.kickoffTime || left?.businessDate || "").localeCompare(String(right?.kickoffTime || right?.businessDate || ""))
    || matchKey(left).localeCompare(matchKey(right))
  ));
};

const stageForMatch = (match) => {
  const date = String(match?.businessDate || match?.matchDate || match?.kickoffTime || "").slice(0, 10);
  if (!/^2026-\d{2}-\d{2}$/.test(date)) return "unknown";
  if (date < "2026-06-28") return "group";
  if (date < "2026-07-04") return "r32";
  if (date < "2026-07-09") return "r16";
  if (date < "2026-07-14") return "qf";
  if (date < "2026-07-18") return "sf";
  if (date < "2026-07-19") return "third";
  return "final";
};

const normalizedTrack = (row) => {
  const explicit = String(row?.performanceTrack || row?.reviewRole || "").toLowerCase();
  if (explicit === "live-model") return "live";
  if (["formal", "live", "reference"].includes(explicit)) return explicit;
  if (row?.liveRecommendationAction === "publish") return "live";
  if (row?.recommendationAction === "recommend") return "formal";
  return "reference";
};

const decisionClockForMatch = (match) => {
  const latestAt = match?.predictionMeta?.snapshot?.latestAt || null;
  const cutoffTime = match?.predictionMeta?.cutoffTime || match?.buyEndTime || null;
  const kickoffTime = match?.kickoffTime || null;
  const latestMillis = parseAuditTime(latestAt);
  const deadlines = [
    { type: "cutoff", value: cutoffTime, millis: parseAuditTime(cutoffTime) },
    { type: "kickoff", value: kickoffTime, millis: parseAuditTime(kickoffTime) },
  ].filter((entry) => Number.isFinite(entry.millis));
  deadlines.sort((left, right) => left.millis - right.millis);
  const deadline = deadlines[0] || null;
  let reason = "eligible";
  if (!Number.isFinite(latestMillis)) reason = "missing-snapshot-latest-at";
  else if (!deadline) reason = "missing-cutoff-and-kickoff";
  else if (latestMillis >= deadline.millis) reason = `snapshot-not-before-${deadline.type}`;
  return {
    eligible: reason === "eligible",
    reason,
    latestAt,
    cutoffTime,
    kickoffTime,
    deadlineType: deadline?.type || null,
    deadlineAt: deadline?.value || null,
  };
};

const wilsonInterval = (wins, total, z = 1.96) => {
  if (!total) return null;
  const probability = wins / total;
  const denominator = 1 + (z * z) / total;
  const centre = (probability + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (probability * (1 - probability)) / total + (z * z) / (4 * total * total),
  ) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
};

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const metricsForRows = (rows) => {
  const settled = (rows || []).filter((row) => ["WON", "LOST"].includes(row?.resultStatus));
  const won = settled.filter((row) => row.resultStatus === "WON").length;
  const lost = settled.length - won;
  const priced = settled.filter((row) => finiteNumber(row?.odds, 0) > 1);
  const netUnits = priced.reduce((sum, row) => (
    sum + (row.resultStatus === "WON" ? finiteNumber(row.odds, 0) - 1 : -1)
  ), 0);
  const interval = wilsonInterval(won, settled.length);
  return {
    settled: settled.length,
    won,
    lost,
    hitRate: settled.length ? round(won / settled.length) : null,
    hitRatePercent: settled.length ? round((won / settled.length) * 100, 2) : null,
    confidence95Percent: interval ? interval.map((value) => round(value * 100, 2)) : null,
    pricedRows: priced.length,
    averageOdds: priced.length
      ? round(priced.reduce((sum, row) => sum + finiteNumber(row.odds, 0), 0) / priced.length, 2)
      : null,
    netUnits: priced.length ? round(netUnits, 2) : null,
    roiPercent: priced.length ? round((netUnits / priced.length) * 100, 2) : null,
  };
};

const groupedMetrics = (rows, keyFn) => Object.fromEntries(
  [...new Set((rows || []).map(keyFn))]
    .sort((left, right) => String(left).localeCompare(String(right)))
    .map((key) => [key, metricsForRows(rows.filter((row) => keyFn(row) === key))]),
);

const oddsBucket = (odds) => {
  const value = finiteNumber(odds, 0);
  if (value < 1.6) return "lt-1.60";
  if (value < 1.85) return "1.60-1.84";
  if (value < 2.1) return "1.85-2.09";
  if (value < 2.5) return "2.10-2.49";
  return "gte-2.50";
};

const trustBucket = (trustScore) => {
  const value = finiteNumber(trustScore, 0);
  if (value < 35) return "lt-35";
  if (value < 50) return "35-49";
  if (value < 60) return "50-59";
  return "gte-60";
};

const POLICY_GRID = Object.freeze([
  { id: "all-best", pools: null, minTrust: 0, maxOdds: Infinity },
  { id: "had-only", pools: ["HAD"], minTrust: 0, maxOdds: Infinity },
  { id: "trust-50", pools: null, minTrust: 50, maxOdds: Infinity },
  { id: "trust-60", pools: null, minTrust: 60, maxOdds: Infinity },
  { id: "odds-lte-2.10", pools: null, minTrust: 0, maxOdds: 2.1 },
  { id: "odds-lte-1.85", pools: null, minTrust: 0, maxOdds: 1.85 },
  { id: "odds-lte-1.60", pools: null, minTrust: 0, maxOdds: 1.6 },
  { id: "had-odds-lte-2.10", pools: ["HAD"], minTrust: 0, maxOdds: 2.1 },
  { id: "had-odds-lte-1.85", pools: ["HAD"], minTrust: 0, maxOdds: 1.85 },
  { id: "had-trust-50", pools: ["HAD"], minTrust: 50, maxOdds: Infinity },
  { id: "had-trust-60", pools: ["HAD"], minTrust: 60, maxOdds: Infinity },
  { id: "hhad-trust-60", pools: ["HHAD"], minTrust: 60, maxOdds: Infinity },
  { id: "hhad-trust-60-odds-lte-2.05", pools: ["HHAD"], minTrust: 60, maxOdds: 2.05 },
]);

const policyAccepts = (policy, row) => {
  if (policy.pools && !policy.pools.includes(String(row?.oddsPoolCode || ""))) return false;
  if (finiteNumber(row?.trustScore, 0) < policy.minTrust) return false;
  const odds = finiteNumber(row?.odds, Infinity);
  if (odds < finiteNumber(policy?.minOdds, 0)) return false;
  if (odds > policy.maxOdds) return false;
  return true;
};

const chronologicalRows = (rows) => [...(rows || [])].sort((left, right) => (
  String(left?.kickoffTime || left?.businessDate || "").localeCompare(String(right?.kickoffTime || right?.businessDate || ""))
  || String(left?.matchKey || "").localeCompare(String(right?.matchKey || ""))
));

const policyTrainingScore = (selected, totalRows) => {
  const metrics = metricsForRows(selected);
  const coverage = totalRows ? selected.length / totalRows : 0;
  const lowerBound = metrics.confidence95Percent?.[0] ?? 0;
  return {
    metrics,
    coverage,
    score: lowerBound
      + Math.min(coverage, 0.7) * 4
      + Math.max(-20, Math.min(20, metrics.roiPercent ?? -20)) * 0.15,
  };
};

const choosePolicy = (trainingRows, policies = POLICY_GRID, options = {}) => {
  const minTrainingSelectedRows = Math.max(1, Number(options.minTrainingSelectedRows ?? 12));
  const minTrainingCoverage = Math.max(0, Math.min(1, Number(options.minTrainingCoverage ?? 0.3)));
  const minimumRows = Math.max(
    minTrainingSelectedRows,
    Math.ceil(trainingRows.length * minTrainingCoverage),
  );
  const candidates = policies.map((policy) => {
    const selected = trainingRows.filter((row) => policyAccepts(policy, row));
    return { policy, selected, ...policyTrainingScore(selected, trainingRows.length) };
  }).filter((candidate) => candidate.selected.length >= minimumRows);
  candidates.sort((left, right) => (
    right.score - left.score
    || right.coverage - left.coverage
    || String(left.policy.id).localeCompare(String(right.policy.id))
  ));
  return candidates[0] || null;
};

const runWalkForwardPolicySearch = (sourceRows, options = {}) => {
  const rows = chronologicalRows(sourceRows);
  const initialTrainingRows = Math.max(24, Number(options.initialTrainingRows || 48));
  const evaluationWindowRows = Math.max(6, Number(options.evaluationWindowRows || 10));
  const policies = options.policies || POLICY_GRID;
  const folds = [];

  const selectedRows = [];
  const evaluatedRows = [];
  let offset = Math.min(initialTrainingRows, rows.length);
  while (offset < rows.length) {
    while (
      offset < rows.length
      && String(rows[offset - 1]?.kickoffTime || rows[offset - 1]?.businessDate || "")
        === String(rows[offset]?.kickoffTime || rows[offset]?.businessDate || "")
    ) offset += 1;
    if (offset >= rows.length) break;
    const training = rows.slice(0, offset);
    let evaluationEnd = Math.min(rows.length, offset + evaluationWindowRows);
    while (
      evaluationEnd < rows.length
      && String(rows[evaluationEnd - 1]?.kickoffTime || rows[evaluationEnd - 1]?.businessDate || "")
        === String(rows[evaluationEnd]?.kickoffTime || rows[evaluationEnd]?.businessDate || "")
    ) evaluationEnd += 1;
    const evaluation = rows.slice(offset, evaluationEnd);
    if (!evaluation.length) break;
    const chosen = choosePolicy(training, policies, options);
    if (!chosen) {
      offset = evaluationEnd;
      continue;
    }
    const selectedEvaluation = evaluation.filter((row) => policyAccepts(chosen.policy, row));
    selectedRows.push(...selectedEvaluation);
    evaluatedRows.push(...evaluation);
    const trainingMaxTime = String(training.at(-1)?.kickoffTime || training.at(-1)?.businessDate || "");
    const evaluationMinTime = String(evaluation[0]?.kickoffTime || evaluation[0]?.businessDate || "");
    folds.push({
      id: `fold-${folds.length + 1}`,
      policyId: chosen.policy.id,
      trainingRows: training.length,
      trainingSelectedRows: chosen.selected.length,
      trainingMetrics: chosen.metrics,
      evaluationRows: evaluation.length,
      evaluationSelectedRows: selectedEvaluation.length,
      evaluationMetrics: metricsForRows(selectedEvaluation),
      baselineMetrics: metricsForRows(evaluation),
      trainingMaxTime,
      evaluationMinTime,
      strictTimeOrder: Boolean(trainingMaxTime && evaluationMinTime && trainingMaxTime < evaluationMinTime),
      selectedMatchKeys: selectedEvaluation.map((row) => row.matchKey),
    });
    offset = evaluationEnd;
  }

  const candidateMetrics = metricsForRows(selectedRows);
  const baselineMetrics = metricsForRows(evaluatedRows);
  const candidateRate = candidateMetrics.hitRate ?? 0;
  const baselineRate = baselineMetrics.hitRate ?? 0;
  const coverage = evaluatedRows.length ? selectedRows.length / evaluatedRows.length : 0;
  const roiImprovement = (candidateMetrics.roiPercent ?? -Infinity) - (baselineMetrics.roiPercent ?? 0);
  const improvingFolds = folds.filter((fold) => (
    (fold.evaluationMetrics.hitRate ?? -1) >= (fold.baselineMetrics.hitRate ?? 0)
  )).length;
  const policyFrequency = folds.reduce((summary, fold) => {
    summary[fold.policyId] = (summary[fold.policyId] || 0) + 1;
    return summary;
  }, {});

  return {
    protocol: "expanding-window-training-only-policy-selection-v1",
    randomSplit: false,
    initialTrainingRows,
    evaluationWindowRows,
    policyGrid: policies.map((policy) => ({
      ...policy,
      maxOdds: Number.isFinite(policy.maxOdds) ? policy.maxOdds : null,
    })),
    folds,
    foldCount: folds.length,
    allFoldsStrictTimeOrder: folds.length > 0 && folds.every((fold) => fold.strictTimeOrder),
    evaluationRows: evaluatedRows.length,
    selectedRows: selectedRows.length,
    coverage: round(coverage),
    coveragePercent: round(coverage * 100, 1),
    baselineMetrics,
    candidateMetrics,
    hitRateImprovementPoints: round((candidateRate - baselineRate) * 100, 1),
    roiImprovementPoints: Number.isFinite(roiImprovement) ? round(roiImprovement, 1) : null,
    improvingFolds,
    policyFrequency,
    shadowCandidateReady: folds.length >= 4
      && folds.every((fold) => fold.strictTimeOrder)
      && selectedRows.length >= 30
      && coverage >= 0.3
      && candidateRate - baselineRate >= 0.05
      && (candidateMetrics.roiPercent ?? -Infinity) >= 0
      && roiImprovement >= 5
      && improvingFolds >= Math.ceil(folds.length * 0.6),
    productionPromotionAllowed: false,
    promotionReason: "World Cup references are an audit-only shadow cohort; formal promotion still requires immutable decision clocks and the global model-learning gate.",
  };
};

const reviewRowsForMatches = (matches, reviews) => {
  const matchByKey = new Map();
  for (const match of matches) {
    const key = matchKey(match);
    matchByKey.set(key, match);
    matchByKey.set(String(match?.id || ""), match);
  }
  const rows = [];
  for (const review of reviews || []) {
    const match = matchByKey.get(String(review?.sourceMatchId || ""))
      || matchByKey.get(String(review?.matchId || ""));
    if (!match) continue;
    const decisionClock = decisionClockForMatch(match);
    for (const row of review?.predictionReview?.rows || []) {
      if (!["WON", "LOST"].includes(row?.resultStatus)) continue;
      rows.push({
        ...row,
        matchKey: matchKey(match),
        matchId: match?.id || review?.matchId || null,
        businessDate: match?.businessDate || null,
        kickoffTime: match?.kickoffTime || null,
        stage: stageForMatch(match),
        track: normalizedTrack(row),
        clockEligible: decisionClock.eligible,
        clockReason: decisionClock.reason,
        decisionClock,
        publicationVerified: review?.settlement?.publicationVerified === true,
      });
    }
  }
  return rows;
};

const buildWorldCupAudit = ({ currentMatches = [], historyMatches = [], reviews = [], metadata = {} }) => {
  const matches = dedupeMatches([...currentMatches, ...historyMatches]);
  const settledMatches = matches.filter((match) => match.status === "FINISHED");
  const rows = reviewRowsForMatches(matches, reviews);
  const rawPrimaryRows = rows.filter((row) => row.marketType === "BEST");
  const strictRows = rows.filter((row) => row.clockEligible);
  const primaryRows = strictRows.filter((row) => row.marketType === "BEST");
  const uniqueMarketRows = strictRows.filter((row) => row.marketType !== "BEST");
  const formalPrimaryRows = primaryRows.filter((row) => row.track === "formal" && row.publicationVerified);
  const livePrimaryRows = primaryRows.filter((row) => row.track === "live" && row.publicationVerified);
  const referencePrimaryRows = primaryRows.filter((row) => row.track === "reference");
  const rawReferencePrimaryRows = rawPrimaryRows.filter((row) => row.track === "reference");
  const walkForward = runWalkForwardPolicySearch(referencePrimaryRows);
  const benchmarkPolicy = {
    id: GOODWIN_BENCHMARK_SHADOW_POLICY.version,
    pools: [GOODWIN_BENCHMARK_SHADOW_POLICY.oddsPoolCode],
    minTrust: GOODWIN_BENCHMARK_SHADOW_POLICY.minimumEvidenceScore,
    minOdds: GOODWIN_BENCHMARK_SHADOW_POLICY.minimumOdds,
    maxOdds: GOODWIN_BENCHMARK_SHADOW_POLICY.maximumOdds,
  };
  const benchmarkRows = referencePrimaryRows.filter((row) => (
    evaluateBenchmarkSelection(row).qualified
  ));
  const benchmarkWalkForward = runWalkForwardPolicySearch(referencePrimaryRows, {
    policies: [benchmarkPolicy],
    minTrainingSelectedRows: 5,
    minTrainingCoverage: 0.08,
  });
  const benchmarkMetrics = benchmarkWalkForward.candidateMetrics;
  const benchmarkIntervalLower = (benchmarkMetrics.confidence95Percent?.[0] ?? 0) / 100;
  const benchmarkPromotionReviewReady = (
    benchmarkWalkForward.selectedRows
      >= GOODWIN_BENCHMARK_SHADOW_POLICY.minimumSettledRowsForPromotionReview
    && benchmarkWalkForward.foldCount
      >= GOODWIN_BENCHMARK_SHADOW_POLICY.minimumChronologicalFolds
    && benchmarkIntervalLower >= GOODWIN_BENCHMARK_SHADOW_POLICY.targetHitRate - 0.05
    && (benchmarkMetrics.roiPercent ?? -Infinity) >= 0
  );
  const excludedPrimaryRows = rawPrimaryRows.filter((row) => !row.clockEligible);

  return {
    ok: true,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    scope: {
      competition: "2026 FIFA World Cup finals",
      leagueIdentity: "exact finals competition only; qualifiers and other World Cup competitions excluded",
      settlement: "WON/LOST only; VOID/PENDING excluded",
      formalMetric: "BEST rows with formal track only",
      referenceMetric: "BEST shadow/reference rows reported separately and only when snapshot.latestAt is strictly before cutoff/kickoff",
      duplicationPolicy: "BEST is the product primary pick and is not mixed with its supporting 1X2 row; unique-market totals exclude BEST",
    },
    data: {
      ...metadata,
      matches: matches.length,
      settledMatches: settledMatches.length,
      reviewedMatches: new Set(rows.map((row) => row.matchKey)).size,
      settledRows: rows.length,
      clockEligibleRows: strictRows.length,
      excludedPrimaryRows: excludedPrimaryRows.length,
      excludedPrimaryMatches: excludedPrimaryRows.map((row) => ({
        matchKey: row.matchKey,
        matchId: row.matchId,
        reason: row.clockReason,
        latestAt: row.decisionClock?.latestAt || null,
        deadlineAt: row.decisionClock?.deadlineAt || null,
      })),
      publicationVerifiedMatches: new Set(rows.filter((row) => row.publicationVerified).map((row) => row.matchKey)).size,
    },
    headline: {
      formalPrimary: metricsForRows(formalPrimaryRows),
      livePrimary: metricsForRows(livePrimaryRows),
      referencePrimary: metricsForRows(referencePrimaryRows),
      referencePrimaryRawDiagnostic: metricsForRows(rawReferencePrimaryRows),
      uniqueMarkets: metricsForRows(uniqueMarketRows),
      allReviewRowsDiagnosticOnly: metricsForRows(rows),
    },
    byTrack: groupedMetrics(primaryRows, (row) => row.track),
    byMarket: groupedMetrics(strictRows, (row) => row.marketType || "unknown"),
    primaryByPool: groupedMetrics(referencePrimaryRows, (row) => row.oddsPoolCode || "unknown"),
    primaryByStage: groupedMetrics(referencePrimaryRows, (row) => row.stage || "unknown"),
    primaryByOddsBucket: groupedMetrics(referencePrimaryRows, (row) => oddsBucket(row.odds)),
    primaryByTrustBucket: groupedMetrics(referencePrimaryRows, (row) => trustBucket(row.trustScore)),
    primaryByTip: groupedMetrics(referencePrimaryRows, (row) => `${row.oddsPoolCode || "unknown"}:${row.tipCode || "unknown"}`),
    uniqueMarketByPool: groupedMetrics(uniqueMarketRows, (row) => `${row.marketType || "unknown"}:${row.oddsPoolCode || "none"}`),
    walkForward,
    benchmarkShadow: {
      version: GOODWIN_BENCHMARK_SHADOW_POLICY.version,
      role: GOODWIN_BENCHMARK_SHADOW_POLICY.role,
      status: benchmarkPromotionReviewReady ? "promotion-review-ready" : "collecting",
      targetHitRate: GOODWIN_BENCHMARK_SHADOW_POLICY.targetHitRate,
      criteria: {
        marketType: GOODWIN_BENCHMARK_SHADOW_POLICY.marketType,
        oddsPoolCode: GOODWIN_BENCHMARK_SHADOW_POLICY.oddsPoolCode,
        minimumEvidenceScore: GOODWIN_BENCHMARK_SHADOW_POLICY.minimumEvidenceScore,
        minimumOdds: GOODWIN_BENCHMARK_SHADOW_POLICY.minimumOdds,
        maximumOdds: GOODWIN_BENCHMARK_SHADOW_POLICY.maximumOdds,
      },
      minimumSettledRowsForPromotionReview:
        GOODWIN_BENCHMARK_SHADOW_POLICY.minimumSettledRowsForPromotionReview,
      minimumChronologicalFolds:
        GOODWIN_BENCHMARK_SHADOW_POLICY.minimumChronologicalFolds,
      fullCohortDiagnostic: metricsForRows(benchmarkRows),
      walkForward: {
        protocol: benchmarkWalkForward.protocol,
        foldCount: benchmarkWalkForward.foldCount,
        allFoldsStrictTimeOrder: benchmarkWalkForward.allFoldsStrictTimeOrder,
        evaluationRows: benchmarkWalkForward.evaluationRows,
        selectedRows: benchmarkWalkForward.selectedRows,
        coveragePercent: benchmarkWalkForward.coveragePercent,
        metrics: benchmarkMetrics,
        baselineMetrics: benchmarkWalkForward.baselineMetrics,
        improvingFolds: benchmarkWalkForward.improvingFolds,
      },
      promotionReviewReady: benchmarkPromotionReviewReady,
      formalOnlineEffect: false,
      reason: benchmarkPromotionReviewReady
        ? "Shadow evidence reached the minimum review gate; formal promotion still requires the global immutable model-learning gate."
        : "Candidate remains shadow-only until the minimum settled sample, chronological folds, conservative interval and ROI gates all pass.",
    },
    limitations: [
      "The settled World Cup cohort is reference/shadow evidence, not a leakage-safe formal recommendation cohort.",
      "Rows without a provably pre-cutoff snapshot are fail-closed and excluded from every public-facing aggregate.",
      "Hit-rate changes from tighter filters trade coverage for selectivity and must not be described as guaranteed future performance.",
      "The global promotion gate remains authoritative even if this event-specific shadow audit improves.",
    ],
  };
};

const loadAuditInputs = (dataDir = DEFAULT_DATA_DIR) => {
  const currentPath = path.join(dataDir, "matches-current.json");
  const historyPath = path.join(dataDir, "matches-history.json");
  const reviewsPath = path.join(dataDir, "post-match-reviews.json");
  const syncMetaPath = path.join(dataDir, "sync-meta.json");
  const currentPayload = readJson(currentPath, []);
  const historyPayload = readJson(historyPath, []);
  const reviewsPayload = readJson(reviewsPath, []);
  const syncMeta = readJson(syncMetaPath, {});
  return {
    currentMatches: asRows(currentPayload),
    historyMatches: asRows(historyPayload),
    reviews: asRows(reviewsPayload),
    metadata: {
      dataDir,
      currentUpdatedAt: currentPayload?.updatedAt || syncMeta?.updatedAt || null,
      historyUpdatedAt: historyPayload?.updatedAt || syncMeta?.updatedAt || null,
      reviewsGeneratedAt: reviewsPayload?.generatedAt || null,
      sourceCycleId: syncMeta?.sourceCycleId || syncMeta?.cycleId || null,
    },
  };
};

if (require.main === module) {
  const dataDir = path.resolve(process.env.WORLD_CUP_AUDIT_DATA_DIR || DEFAULT_DATA_DIR);
  const report = buildWorldCupAudit(loadAuditInputs(dataDir));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

module.exports = {
  VERSION,
  POLICY_GRID,
  isWorldCupFinalsMatch,
  dedupeMatches,
  stageForMatch,
  metricsForRows,
  decisionClockForMatch,
  normalizedTrack,
  policyAccepts,
  reviewRowsForMatches,
  runWalkForwardPolicySearch,
  buildWorldCupAudit,
  loadAuditInputs,
};
