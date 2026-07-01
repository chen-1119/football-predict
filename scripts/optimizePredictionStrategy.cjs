const fs = require("fs");
const path = require("path");

const VERSION = "self-optimization-v1";
const ENABLED_MARKETS = new Set(["1X2", "HHAD", "GOALS", "BEST"]);
const PROFILE_KEYS = ["international", "japan", "other"];

const MIN_RULE_ROWS = 3;
const MIN_PROFILE_ROWS = 5;
const WEB_CONSENSUS_MIN_RULE_ROWS = 8;
const MIN_LOOSEN_ROWS = 100;
const MAX_DETAIL_BOOST = 0.06;
const PROMOTION_MIN_BASELINE_ROWS = Math.max(30, Number(process.env.MODEL_PROMOTION_MIN_BASELINE_ROWS || 100));
const PROMOTION_MIN_LOG_LOSS_IMPROVEMENT = Number(process.env.MODEL_PROMOTION_MIN_LOG_LOSS_IMPROVEMENT || 0);
const PROMOTION_MIN_BRIER_IMPROVEMENT = Number(process.env.MODEL_PROMOTION_MIN_BRIER_IMPROVEMENT || 0);
const PROMOTION_MIN_ROLLING_PASS_RATE = Math.min(1, Math.max(0, Number(process.env.MODEL_PROMOTION_MIN_ROLLING_PASS_RATE || 0.6)));

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = path.join(rootDir, "server-data");
const outputFiles = [
  path.join(publicDataDir, "model-strategy.json"),
  path.join(serverDataDir, "model-strategy.json"),
];
const evaluationFile = path.join(publicDataDir, "model-evaluation.json");

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function profileKey(match) {
  const text = [
    match?.leagueName,
    match?.leagueNameEn,
    match?.leagueShortName,
    match?.countryName,
    match?.countryNameEn,
    match?.homeTeamName,
    match?.homeTeamNameEn,
    match?.awayTeamName,
    match?.awayTeamNameEn,
  ].filter(Boolean).join(" ");
  if (/(\u65e5\u804c|\u65e5\u8054|\u65e5\u672c|j1|j2|japan)/i.test(text)) return "japan";
  if (/(\u56fd\u9645|\u53cb\u8c0a|\u4e16\u754c\u676f|\u4e16\u9884|\u56fd\u5bb6|international|friendly|world cup|qualifier|fifa)/i.test(text)) return "international";
  return "other";
}

function oddsBucket(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value <= 1.45) return "sp_le_1_45";
  if (value <= 1.7) return "sp_1_46_1_70";
  if (value <= 2.05) return "sp_1_71_2_05";
  if (value <= 2.6) return "sp_2_06_2_60";
  return "sp_gt_2_60";
}

function marketType(prediction) {
  if (prediction?.oddsPoolCode === "HHAD" && prediction?.marketType === "1X2") return "HHAD";
  return prediction?.marketType || "";
}

function matchKey(match) {
  return normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
}

function matchIdentity(match) {
  return matchKey(match) || [
    match?.kickoffTime,
    match?.homeTeamName || match?.homeTeamNameEn || match?.homeTeamId,
    match?.awayTeamName || match?.awayTeamNameEn || match?.awayTeamId,
  ].filter(Boolean).join("|");
}

function matchQuality(match) {
  let score = 0;
  if (match?.status === "FINISHED") score += 40;
  if (Number.isFinite(match?.scoreHome) && Number.isFinite(match?.scoreAway)) score += 30;
  if (match?.predictionMeta?.lockedAt) score += 8;
  if (Array.isArray(match?.predictions) && match.predictions.length) score += 6;
  if (match?.probabilityModel?.scoreDistribution?.length) score += 4;
  if (match?.odds || match?.handicapOdds) score += 2;
  return score;
}

function dedupeMatches(matches) {
  const byId = new Map();
  for (const match of matches || []) {
    const key = normText(matchIdentity(match));
    if (!key) continue;
    const previous = byId.get(key);
    if (!previous || matchQuality(match) >= matchQuality(previous)) {
      byId.set(key, match);
    }
  }
  return [...byId.values()];
}

function probabilityForTip(match, prediction) {
  const oneXTwo = match?.probabilityModel?.oneXTwo?.final || match?.probabilityFinal;
  if (!oneXTwo) return null;
  if (prediction.tipCode === "1") return Number(oneXTwo.home) / 100;
  if (prediction.tipCode === "X") return Number(oneXTwo.draw) / 100;
  if (prediction.tipCode === "2") return Number(oneXTwo.away) / 100;
  return null;
}

function oddsFromBoard(board, tipCode) {
  const code = normText(tipCode);
  const odds = code === "1"
    ? Number(board?.odds1 ?? board?.home ?? board?.h)
    : code === "X"
      ? Number(board?.oddsX ?? board?.draw ?? board?.d)
      : code === "2"
        ? Number(board?.odds2 ?? board?.away ?? board?.a)
        : NaN;
  return Number.isFinite(odds) && odds > 1 ? odds : 0;
}

function oddsForPrediction(match, prediction, resolvedMarket) {
  const direct = Number(prediction?.odds || 0);
  if (Number.isFinite(direct) && direct > 1) return direct;
  if (resolvedMarket === "HHAD" || prediction?.oddsPoolCode === "HHAD") {
    return oddsFromBoard(match?.handicapOdds, prediction?.tipCode);
  }
  if (resolvedMarket === "1X2" || resolvedMarket === "BEST" || prediction?.oddsPoolCode === "HAD") {
    return oddsFromBoard(match?.odds, prediction?.tipCode);
  }
  return 0;
}

function webConsensusSignal(match) {
  const signal = match?.externalSignals?.webConsensus;
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) return null;
  return signal;
}

function webConsensusRuleKeys(match, marketType) {
  const signal = webConsensusSignal(match);
  if (!signal || signal.usableForModel === false) return [];
  const buckets = Array.isArray(signal.buckets)
    ? signal.buckets.filter((key) => normText(key).startsWith("web:") && key !== "web:usable" && key !== "web:audit-only")
    : [];
  return Array.from(new Set([
    ...buckets,
    ...buckets.map((key) => `${marketType}:${key}`),
  ]));
}

function predictionRows(matches, snapshots = []) {
  const rowsByKey = new Map();
  const addRow = (match, prediction, options = {}) => {
    if (!prediction || prediction.tipCode === "WATCH") return;
    if (prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") return;
    const market = options.marketType || marketType(prediction);
    if (!ENABLED_MARKETS.has(market)) return;
    const odds = oddsForPrediction(match, prediction, market);
    const sourceMatchId = matchKey(match);
    const key = [
      sourceMatchId || matchIdentity(match),
      market,
      prediction.oddsPoolCode || options.oddsPoolCode || "",
      match?.handicapLine || "",
      prediction.tipCode,
      prediction.resultStatus,
    ].join("|");
    const row = {
      sourceMatchId,
      kickoffTime: match.kickoffTime || "",
      league: match.leagueName || match.leagueNameEn || match.leagueId || "",
      profileKey: profileKey(match),
      marketType: market,
      tipCode: prediction.tipCode,
      odds,
      oddsBucket: oddsBucket(odds),
      trustScore: Number(prediction.trustScore || 0),
      resultStatus: prediction.resultStatus,
      policyVersion: match.predictionMeta?.policyVersion || match.policyVersion || "unknown",
      probability: probabilityForTip(match, prediction),
      webConsensusKeys: webConsensusRuleKeys(match, market),
      source: options.source || "match",
    };
    const previous = rowsByKey.get(key);
    if (
      !previous
      || (Number(row.odds) > 1 && !(Number(previous.odds) > 1))
      || (Number(row.trustScore || 0) > Number(previous.trustScore || 0) && Number(row.odds || 0) >= Number(previous.odds || 0))
    ) {
      rowsByKey.set(key, row);
    }
  };

  for (const match of matches || []) {
    if (match?.status !== "FINISHED") continue;
    if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) continue;

    for (const prediction of match.predictions || []) {
      addRow(match, prediction, { source: "match.predictions" });
    }
    for (const prediction of match.postMatchReview?.predictionReview?.rows || []) {
      addRow(match, prediction, { source: "postMatchReview.predictionReview.rows" });
    }
  }

  for (const snapshot of snapshots || []) {
    if (snapshot?.status !== "FINISHED") continue;
    if (!Number.isFinite(snapshot.scoreHome) || !Number.isFinite(snapshot.scoreAway)) continue;
    addRow(snapshot, snapshot.best, { source: "prediction-snapshot.best", marketType: "BEST", oddsPoolCode: "HAD" });
    addRow(snapshot, snapshot.oneXTwo, { source: "prediction-snapshot.oneXTwo", marketType: "1X2", oddsPoolCode: "HAD" });
    addRow(snapshot, snapshot.goals, { source: "prediction-snapshot.goals", marketType: "GOALS" });
  }

  return [...rowsByKey.values()].sort((a, b) => String(a.kickoffTime).localeCompare(String(b.kickoffTime)));
}

function summarizeRows(rows) {
  const settled = rows.length;
  const won = rows.filter((row) => row.resultStatus === "WON").length;
  const lost = rows.filter((row) => row.resultStatus === "LOST").length;
  const stakeReturn = rows.reduce((sum, row) => {
    if (row.resultStatus === "WON") return sum + Math.max(0, Number(row.odds || 0) - 1);
    if (row.resultStatus === "LOST") return sum - 1;
    return sum;
  }, 0);
  const oddsRows = rows.filter((row) => Number(row.odds) > 0);
  const probabilityRows = rows.filter((row) => Number.isFinite(row.probability));

  return {
    settled,
    won,
    lost,
    hitRate: settled ? round(won / settled) : null,
    roi: settled ? round(stakeReturn / settled) : null,
    avgOdds: oddsRows.length
      ? round(oddsRows.reduce((sum, row) => sum + Number(row.odds), 0) / oddsRows.length, 2)
      : null,
    avgTrust: settled ? round(rows.reduce((sum, row) => sum + Number(row.trustScore || 0), 0) / settled, 1) : null,
    avgProbability: probabilityRows.length
      ? round(probabilityRows.reduce((sum, row) => sum + Number(row.probability), 0) / probabilityRows.length)
      : null,
  };
}

function groupSummary(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    Array.from(groups.entries())
      .map(([key, group]) => [key, summarizeRows(group)])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  );
}

function groupSummaryMany(rows, keysFn) {
  const groups = new Map();
  for (const row of rows) {
    const keys = keysFn(row);
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
  }
  return Object.fromEntries(
    Array.from(groups.entries())
      .map(([key, group]) => [key, summarizeRows(group)])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  );
}

function promotionGateFromEvaluation(evaluation) {
  const currentModelComparison = evaluation?.marketBaseline?.comparison || {};
  const sample = evaluation?.sample || {};
  const shadowCandidates = evaluation?.shadowCandidates || null;
  const bestCandidate = shadowCandidates?.bestCandidate || null;
  const candidateComparison = bestCandidate?.comparison || currentModelComparison;
  const candidateRolling = bestCandidate?.rolling || null;
  const legacyRollingWindows = Array.isArray(evaluation?.rollingWindows) ? evaluation.rollingWindows : [];
  const marketBaselineRows = Number(sample.marketBaselineRows || currentModelComparison.rows || 0);
  const probabilityRows = Number(sample.probabilityRows || 0);
  const logLossImprovement = Number(candidateComparison.logLossImprovement);
  const brierImprovement = Number(candidateComparison.brierImprovement);
  const accuracyDelta = Number(candidateComparison.accuracyDelta);
  const legacyCheckedWindows = legacyRollingWindows.filter((window) => (
    Number.isFinite(Number(window?.improvement?.logLossImprovement))
    && Number.isFinite(Number(window?.improvement?.brierImprovement))
  ));
  const legacyPassingWindows = legacyCheckedWindows.filter((window) => (
    Number(window?.improvement?.logLossImprovement) >= PROMOTION_MIN_LOG_LOSS_IMPROVEMENT
    && Number(window?.improvement?.brierImprovement) >= PROMOTION_MIN_BRIER_IMPROVEMENT
  ));
  const candidateRollingWindows = Number(candidateRolling?.windows);
  const hasCandidateRolling = Number.isFinite(candidateRollingWindows);
  const checkedWindowCount = hasCandidateRolling ? candidateRollingWindows : legacyCheckedWindows.length;
  const rollingPassRate = Number.isFinite(Number(candidateRolling?.passRate))
    ? Number(candidateRolling.passRate)
    : (legacyCheckedWindows.length ? legacyPassingWindows.length / legacyCheckedWindows.length : null);
  const rollingSource = hasCandidateRolling ? "shadow-candidate" : "current-model-legacy";
  const reasons = [];

  if (!evaluation) reasons.push("model-evaluation-missing");
  if (marketBaselineRows < PROMOTION_MIN_BASELINE_ROWS) {
    reasons.push(`market-baseline-rows:${marketBaselineRows}<${PROMOTION_MIN_BASELINE_ROWS}`);
  }
  if (!Number.isFinite(logLossImprovement) || logLossImprovement < PROMOTION_MIN_LOG_LOSS_IMPROVEMENT) {
    reasons.push(`log-loss-improvement:${Number.isFinite(logLossImprovement) ? round(logLossImprovement, 4) : "missing"}<${PROMOTION_MIN_LOG_LOSS_IMPROVEMENT}`);
  }
  if (!Number.isFinite(brierImprovement) || brierImprovement < PROMOTION_MIN_BRIER_IMPROVEMENT) {
    reasons.push(`brier-improvement:${Number.isFinite(brierImprovement) ? round(brierImprovement, 4) : "missing"}<${PROMOTION_MIN_BRIER_IMPROVEMENT}`);
  }
  if (checkedWindowCount > 0 && (!Number.isFinite(rollingPassRate) || rollingPassRate < PROMOTION_MIN_ROLLING_PASS_RATE)) {
    reasons.push(`rolling-pass-rate:${Number.isFinite(rollingPassRate) ? round(rollingPassRate, 4) : "missing"}<${PROMOTION_MIN_ROLLING_PASS_RATE}`);
  }
  if (bestCandidate?.id === "market-baseline") {
    reasons.push("best-shadow-candidate-is-market-baseline");
  }

  return {
    version: "model-promotion-gate-v1",
    status: reasons.length ? "shadow" : "eligible",
    onlineEffect: reasons.length ? "shadow" : "guarded-active",
    checkedAt: new Date().toISOString(),
    sourceEvaluationVersion: evaluation?.version || null,
    thresholds: {
      minMarketBaselineRows: PROMOTION_MIN_BASELINE_ROWS,
      minLogLossImprovement: PROMOTION_MIN_LOG_LOSS_IMPROVEMENT,
      minBrierImprovement: PROMOTION_MIN_BRIER_IMPROVEMENT,
      minRollingPassRate: PROMOTION_MIN_ROLLING_PASS_RATE,
    },
    sample: {
      probabilityRows,
      marketBaselineRows,
      rollingWindows: checkedWindowCount,
      shadowCandidateRows: Number(shadowCandidates?.sample?.rows || 0),
    },
    metrics: {
      logLossImprovement: Number.isFinite(logLossImprovement) ? round(logLossImprovement, 4) : null,
      brierImprovement: Number.isFinite(brierImprovement) ? round(brierImprovement, 4) : null,
      accuracyDelta: Number.isFinite(accuracyDelta) ? round(accuracyDelta, 4) : null,
      rollingPassRate: rollingPassRate === null ? null : round(rollingPassRate, 4),
      rollingSource,
      currentModelLogLossImprovement: Number.isFinite(Number(currentModelComparison.logLossImprovement))
        ? round(Number(currentModelComparison.logLossImprovement), 4)
        : null,
      currentModelBrierImprovement: Number.isFinite(Number(currentModelComparison.brierImprovement))
        ? round(Number(currentModelComparison.brierImprovement), 4)
        : null,
    },
    shadowCandidate: bestCandidate ? {
      id: bestCandidate.id,
      role: bestCandidate.role,
      featureSet: bestCandidate.featureSet || [],
      weights: bestCandidate.weights || null,
      metrics: bestCandidate.metrics || null,
      comparison: bestCandidate.comparison || null,
      rolling: bestCandidate.rolling || null,
    } : null,
    reasons,
    policy: "Model strategy stays shadow until it has enough time-ordered baseline rows and non-negative Brier/log-loss improvement against the Sporttery market baseline.",
  };
}

function combineAdjustments(adjustments) {
  const output = {
    minProbabilityBoost: 0,
    minModelGapBoost: 0,
    minHandicapSupportBoost: 0,
    trustPenalty: 0,
    maxRiskTagsDelta: 0,
    goalsMinBoost: 0,
  };

  for (const adjustment of adjustments.filter(Boolean)) {
    output.minProbabilityBoost += Number(adjustment.minProbabilityBoost || 0);
    output.minModelGapBoost += Number(adjustment.minModelGapBoost || 0);
    output.minHandicapSupportBoost += Number(adjustment.minHandicapSupportBoost || 0);
    output.trustPenalty += Number(adjustment.trustPenalty || 0);
    output.maxRiskTagsDelta += Number(adjustment.maxRiskTagsDelta || 0);
    output.goalsMinBoost += Number(adjustment.goalsMinBoost || 0);
  }

  return {
    minProbabilityBoost: round(clamp(output.minProbabilityBoost, -0.02, 0.12)),
    minModelGapBoost: round(clamp(output.minModelGapBoost, -0.015, 0.08)),
    minHandicapSupportBoost: round(clamp(output.minHandicapSupportBoost, -0.015, 0.1)),
    trustPenalty: Math.round(clamp(output.trustPenalty, -3, 18)),
    maxRiskTagsDelta: Math.round(clamp(output.maxRiskTagsDelta, -3, 1)),
    goalsMinBoost: round(clamp(output.goalsMinBoost, -0.02, 0.08)),
  };
}

function ruleAdjustment(summary, context = {}) {
  const minRows = context.minRows || MIN_RULE_ROWS;
  const settled = Number(summary?.settled || 0);
  const hitRate = Number.isFinite(summary?.hitRate) ? summary.hitRate : null;
  const roi = Number.isFinite(summary?.roi) ? summary.roi : null;
  const reasons = [];
  const adjustments = [];

  if (settled < minRows) {
    return {
      onlineAction: "observe",
      sampleStatus: "low-sample",
      reasons: [`sample<${minRows}`],
      adjustments: combineAdjustments([]),
    };
  }

  if (hitRate !== null && hitRate < 0.32) {
    reasons.push("very-cold-hit-rate");
    adjustments.push({
      minProbabilityBoost: 0.07,
      minModelGapBoost: 0.04,
      minHandicapSupportBoost: 0.05,
      trustPenalty: 10,
      maxRiskTagsDelta: -2,
      goalsMinBoost: context.marketType === "GOALS" ? 0.04 : 0,
    });
  } else if (hitRate !== null && hitRate < 0.4) {
    reasons.push("cold-hit-rate");
    adjustments.push({
      minProbabilityBoost: 0.04,
      minModelGapBoost: 0.025,
      minHandicapSupportBoost: 0.035,
      trustPenalty: 6,
      maxRiskTagsDelta: -1,
      goalsMinBoost: context.marketType === "GOALS" ? 0.03 : 0,
    });
  }

  if (roi !== null && roi < -0.35) {
    reasons.push("negative-flat-stake-roi");
    adjustments.push({
      minProbabilityBoost: 0.02,
      minModelGapBoost: 0.015,
      minHandicapSupportBoost: 0.015,
      trustPenalty: 3,
      maxRiskTagsDelta: -1,
    });
  }

  if (!reasons.length && settled >= MIN_LOOSEN_ROWS && hitRate !== null && hitRate >= 0.58 && (roi === null || roi >= 0)) {
    return {
      onlineAction: "loosen",
      sampleStatus: "validated",
      reasons: ["validated-hot-sample"],
      adjustments: combineAdjustments([{
        minProbabilityBoost: -0.01,
        minModelGapBoost: -0.006,
        minHandicapSupportBoost: -0.006,
        trustPenalty: -2,
        maxRiskTagsDelta: 1,
        goalsMinBoost: context.marketType === "GOALS" ? -0.01 : 0,
      }]),
    };
  }

  if (!reasons.length) {
    return {
      onlineAction: "observe",
      sampleStatus: "neutral",
      reasons: ["neutral-sample"],
      adjustments: combineAdjustments([]),
    };
  }

  return {
    onlineAction: "tighten",
    sampleStatus: settled >= MIN_LOOSEN_ROWS ? "validated" : "guarded",
    reasons,
    adjustments: combineAdjustments(adjustments),
  };
}

function buildRule(key, summary, context = {}) {
  const adjustment = ruleAdjustment(summary, context);
  return {
    key,
    settled: Number(summary?.settled || 0),
    won: Number(summary?.won || 0),
    lost: Number(summary?.lost || 0),
    hitRate: Number.isFinite(summary?.hitRate) ? summary.hitRate : null,
    roi: Number.isFinite(summary?.roi) ? summary.roi : null,
    avgOdds: Number.isFinite(summary?.avgOdds) ? summary.avgOdds : null,
    onlineAction: adjustment.onlineAction,
    sampleStatus: adjustment.sampleStatus,
    reasons: adjustment.reasons,
    adjustments: adjustment.adjustments,
  };
}

function capDetailRule(rule) {
  if (!rule || rule.onlineAction !== "tighten") return rule;
  return {
    ...rule,
    adjustments: {
      ...rule.adjustments,
      minProbabilityBoost: round(clamp(rule.adjustments.minProbabilityBoost || 0, 0, MAX_DETAIL_BOOST)),
      minModelGapBoost: round(clamp(rule.adjustments.minModelGapBoost || 0, 0, MAX_DETAIL_BOOST)),
      minHandicapSupportBoost: round(clamp(rule.adjustments.minHandicapSupportBoost || 0, 0, MAX_DETAIL_BOOST)),
      goalsMinBoost: round(clamp(rule.adjustments.goalsMinBoost || 0, 0, MAX_DETAIL_BOOST)),
      trustPenalty: Math.round(clamp(rule.adjustments.trustPenalty || 0, 0, 10)),
      maxRiskTagsDelta: Math.round(clamp(rule.adjustments.maxRiskTagsDelta || 0, -2, 0)),
    },
  };
}

function activeRuleCount(rulesByKey) {
  return Object.values(rulesByKey || {}).filter((rule) => rule.onlineAction === "tighten").length;
}

function buildStrategy(matches, evaluation, snapshots = []) {
  const rows = predictionRows(matches, snapshots);
  const officialRows = rows.filter((row) => Number(row.odds) > 0);
  const bestRows = officialRows.filter((row) => row.marketType === "BEST");
  const recommendationRows = officialRows.filter((row) => row.marketType === "1X2" || row.marketType === "HHAD" || row.marketType === "BEST");
  const goalsRows = officialRows.filter((row) => row.marketType === "GOALS");

  const summary = {
    total: summarizeRows(rows),
    official: summarizeRows(officialRows),
    recommendationPool: summarizeRows(recommendationRows),
    best: summarizeRows(bestRows),
    goals: summarizeRows(goalsRows),
    byMarket: groupSummary(officialRows, (row) => row.marketType),
    byProfile: groupSummary(officialRows, (row) => row.profileKey),
    byMarketProfile: groupSummary(officialRows, (row) => `${row.marketType}:${row.profileKey}`),
    byOddsBucket: groupSummary(officialRows.filter((row) => row.tipCode === "1" || row.tipCode === "2"), (row) => row.oddsBucket),
    byTip: groupSummary(officialRows, (row) => `${row.marketType}:${row.tipCode}`),
    byWebConsensus: groupSummaryMany(officialRows, (row) => row.webConsensusKeys),
    byPolicy: groupSummary(officialRows, (row) => row.policyVersion),
  };

  const gateByProfile = Object.fromEntries(PROFILE_KEYS.map((profile) => {
    const overall = buildRule(profile, summary.byProfile[profile] || summarizeRows([]), { minRows: MIN_PROFILE_ROWS });
    const oneXTwo = buildRule(`1X2:${profile}`, summary.byMarketProfile[`1X2:${profile}`] || summarizeRows([]), { minRows: MIN_PROFILE_ROWS, marketType: "1X2" });
    const goals = buildRule(`GOALS:${profile}`, summary.byMarketProfile[`GOALS:${profile}`] || summarizeRows([]), { minRows: MIN_PROFILE_ROWS, marketType: "GOALS" });
    const activeAdjustments = [overall, oneXTwo, goals]
      .filter((rule) => rule.onlineAction === "tighten")
      .map((rule) => rule.adjustments);

    return [profile, {
      key: profile,
      sample: {
        overall: summary.byProfile[profile] || summarizeRows([]),
        oneXTwo: summary.byMarketProfile[`1X2:${profile}`] || summarizeRows([]),
        goals: summary.byMarketProfile[`GOALS:${profile}`] || summarizeRows([]),
      },
      onlineAction: activeAdjustments.length ? "tighten" : "observe",
      sampleStatus: activeAdjustments.length ? "guarded" : "observe",
      reasons: [overall, oneXTwo, goals].flatMap((rule) => rule.reasons.map((reason) => `${rule.key}:${reason}`)),
      adjustments: combineAdjustments(activeAdjustments),
    }];
  }));

  const gateByMarket = Object.fromEntries(
    Object.entries(summary.byMarket).map(([key, value]) => [key, capDetailRule(buildRule(key, value, { marketType: key }))])
  );
  const gateByMarketProfile = Object.fromEntries(
    Object.entries(summary.byMarketProfile).map(([key, value]) => {
      const market = key.split(":")[0];
      return [key, capDetailRule(buildRule(key, value, { marketType: market }))];
    })
  );
  const gateByOddsBucket = Object.fromEntries(
    Object.entries(summary.byOddsBucket).map(([key, value]) => [key, capDetailRule(buildRule(key, value))])
  );
  const gateByTip = Object.fromEntries(
    Object.entries(summary.byTip).map(([key, value]) => {
      const market = key.split(":")[0];
      return [key, capDetailRule(buildRule(key, value, { marketType: market }))];
    })
  );
  const gateByWebConsensus = Object.fromEntries(
    Object.entries(summary.byWebConsensus).map(([key, value]) => {
      const market = ENABLED_MARKETS.has(key.split(":")[0]) ? key.split(":")[0] : undefined;
      return [key, capDetailRule(buildRule(key, value, { minRows: WEB_CONSENSUS_MIN_RULE_ROWS, marketType: market }))];
    })
  );

  const activeGates = {
    profile: activeRuleCount(gateByProfile),
    market: activeRuleCount(gateByMarket),
    marketProfile: activeRuleCount(gateByMarketProfile),
    oddsBucket: activeRuleCount(gateByOddsBucket),
    tip: activeRuleCount(gateByTip),
    webConsensus: activeRuleCount(gateByWebConsensus),
  };
  const settledOfficialRows = officialRows.length;
  const promotionGate = promotionGateFromEvaluation(evaluation);
  const sampleEligibleEffect = settledOfficialRows >= MIN_RULE_ROWS ? "guarded-active" : "shadow";
  const onlineEffect = promotionGate.onlineEffect === "guarded-active" ? sampleEligibleEffect : "shadow";
  const activationMode = onlineEffect === "shadow" && promotionGate.status !== "eligible"
    ? "market-baseline-shadow"
    : "cooling-only";

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: "settled-pre-match-predictions",
    activation: {
      mode: activationMode,
      onlineEffect,
      minimumRowsForRule: MIN_RULE_ROWS,
      minimumRowsForProfile: MIN_PROFILE_ROWS,
      minimumRowsForLoosening: MIN_LOOSEN_ROWS,
      promotionGate,
      note: onlineEffect === "shadow"
        ? "Strategy is shadow-only until market baseline promotion checks pass."
        : "Only tightening rules are applied online until a bucket reaches the loosening sample floor.",
    },
    sample: {
      matches: matches.length,
      settledRows: rows.length,
      officialRows: settledOfficialRows,
      recommendationRows: recommendationRows.length,
      bestRows: bestRows.length,
      goalsRows: goalsRows.length,
      webConsensusRows: officialRows.filter((row) => Array.isArray(row.webConsensusKeys) && row.webConsensusKeys.length).length,
    },
    summary,
    activeGates,
    gateByProfile,
    gateByMarket,
    gateByMarketProfile,
    gateByOddsBucket,
    gateByTip,
    gateByWebConsensus,
    recommendations: [
      {
        id: "sample-guard",
        status: onlineEffect === "shadow"
          ? "shadow-only"
          : (settledOfficialRows >= MIN_LOOSEN_ROWS ? "ready-for-controlled-loosening" : "cooling-only"),
        reason: settledOfficialRows >= MIN_LOOSEN_ROWS
          ? "The settled official sample has reached the loosening floor."
          : "The settled official sample is still small, so automation may tighten gates but will not loosen them.",
      },
      {
        id: "market-baseline-gate",
        status: promotionGate.status,
        reason: promotionGate.reasons.length
          ? promotionGate.reasons.join("; ")
          : "Model evaluation is eligible for guarded online tightening against the market baseline.",
      },
      {
        id: "next-data-step",
        status: "pending",
        reason: "Import historical league data to seed Elo, form, and league priors before enabling weight optimization.",
      },
    ],
  };
}

const matchFiles = ["matches-current.json", "matches-history.json"]
  .map((file) => path.join(publicDataDir, file))
  .filter((file) => fs.existsSync(file));
const rawMatches = matchFiles.flatMap((file) => {
  const parsed = readJson(file, []);
  return Array.isArray(parsed) ? parsed : [];
});
const matches = dedupeMatches(rawMatches);
const modelEvaluation = readJson(evaluationFile, null);
const predictionSnapshots = readJson(path.join(publicDataDir, "prediction-snapshots.json"), { rows: [] });
const snapshotRows = Array.isArray(predictionSnapshots?.rows) ? predictionSnapshots.rows : [];

const strategy = buildStrategy(matches, modelEvaluation, snapshotRows);
for (const file of outputFiles) writeJson(file, strategy);

console.log(JSON.stringify({
  ok: true,
  version: strategy.version,
  outputFiles,
  sample: strategy.sample,
  activeGates: strategy.activeGates,
  onlineEffect: strategy.activation.onlineEffect,
  promotionGate: {
    status: strategy.activation.promotionGate?.status || null,
    metrics: strategy.activation.promotionGate?.metrics || null,
    reasons: strategy.activation.promotionGate?.reasons || [],
  },
}, null, 2));
