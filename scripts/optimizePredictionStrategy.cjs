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

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = path.join(rootDir, "server-data");
const postMatchReviewsFile = path.join(publicDataDir, "post-match-reviews.json");
const outputFiles = [
  path.join(publicDataDir, "model-strategy.json"),
  path.join(rootDir, "dist", "data", "model-strategy.json"),
  path.join(serverDataDir, "model-strategy.json"),
];

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
    match?.teams?.home,
    match?.teams?.away,
    match?.matchNo,
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
  const oneXTwo = match?.probabilityModel?.oneXTwo?.final;
  if (!oneXTwo) return null;
  if (prediction.tipCode === "1") return Number(oneXTwo.home) / 100;
  if (prediction.tipCode === "X") return Number(oneXTwo.draw) / 100;
  if (prediction.tipCode === "2") return Number(oneXTwo.away) / 100;
  return null;
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

function predictionRows(matches) {
  const rows = [];
  for (const match of matches || []) {
    if (match?.status !== "FINISHED") continue;
    if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) continue;

    for (const prediction of match.predictions || []) {
      if (!prediction || prediction.tipCode === "WATCH") continue;
      if (prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") continue;
      const market = marketType(prediction);
      if (!ENABLED_MARKETS.has(market)) continue;

      const odds = Number(prediction.odds || 0);
      const row = {
        sourceMatchId: matchKey(match),
        kickoffTime: match.kickoffTime || "",
        league: match.leagueName || match.leagueNameEn || match.leagueId || "",
        profileKey: profileKey(match),
        marketType: market,
        tipCode: prediction.tipCode,
        odds,
        oddsBucket: oddsBucket(odds),
        trustScore: Number(prediction.trustScore || 0),
        resultStatus: prediction.resultStatus,
        policyVersion: match.predictionMeta?.policyVersion || "unknown",
        probability: probabilityForTip(match, prediction),
        webConsensusKeys: webConsensusRuleKeys(match, market),
      };
      rows.push(row);
    }
  }
  return rows.sort((a, b) => String(a.kickoffTime).localeCompare(String(b.kickoffTime)));
}

function buildMatchIndex(matches) {
  const index = new Map();
  for (const match of matches || []) {
    const key = matchKey(match);
    if (key && !index.has(key)) index.set(key, match);
  }
  return index;
}

function marketTypeFromReviewRow(row) {
  if (row?.oddsPoolCode === "HHAD" && ["1", "X", "2"].includes(row?.tipCode)) return "HHAD";
  if (row?.marketType === "BEST") return "BEST";
  if (row?.marketType === "GOALS") return "GOALS";
  if (row?.marketType === "GG_NG") return "BTTS";
  return "1X2";
}

function postMatchReviewRows(reviewPayload, matches) {
  const matchIndex = buildMatchIndex(matches);
  const rows = [];
  const reviews = Array.isArray(reviewPayload?.rows) ? reviewPayload.rows : [];
  for (const review of reviews) {
    const sourceMatchId = normText(review?.sourceMatchId);
    const match = sourceMatchId ? matchIndex.get(sourceMatchId) : null;
    const diagnosisCodes = (review?.modelDiagnosis || []).map((item) => item?.code).filter(Boolean);
    const adjustmentCodes = (review?.nextAdjustment || []).map((item) => item?.code).filter(Boolean);
    for (const prediction of review?.predictionReview?.rows || []) {
      if (!prediction || prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") continue;
      const market = marketTypeFromReviewRow(prediction);
      if (!ENABLED_MARKETS.has(market)) continue;
      const odds = Number(prediction.odds || 0);
      rows.push({
        sourceMatchId,
        kickoffTime: match?.kickoffTime || review.generatedAt || "",
        league: match?.leagueName || match?.leagueNameEn || match?.leagueId || "",
        profileKey: profileKey(match || review),
        marketType: market,
        tipCode: prediction.tipCode,
        actualCode: prediction.actualCode || null,
        odds,
        oddsBucket: oddsBucket(odds),
        trustScore: Number(prediction.trustScore || 0),
        resultStatus: prediction.resultStatus,
        policyVersion: match?.predictionMeta?.policyVersion || "post-match-review",
        probability: probabilityForTip(match, prediction),
        webConsensusKeys: match ? webConsensusRuleKeys(match, market) : [],
        reviewRole: prediction.reviewRole || "reference",
        fromPostMatchReview: true,
        diagnosisCodes,
        adjustmentCodes,
        missedHandicapLane: Boolean(review?.predictionReview?.missedHandicapLane),
        handicapHit: Boolean(review?.predictionReview?.handicapHit),
      });
    }
  }
  return rows;
}

function dedupePredictionRows(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const key = [
      row.sourceMatchId,
      row.marketType,
      row.tipCode,
      row.reviewRole || "",
      row.actualCode || "",
    ].join("|");
    const previous = byKey.get(key);
    if (!previous || row.fromPostMatchReview || !previous.fromPostMatchReview) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => String(a.kickoffTime).localeCompare(String(b.kickoffTime)));
}

function summarizeRows(rows) {
  const settled = rows.length;
  const won = rows.filter((row) => row.resultStatus === "WON").length;
  const lost = rows.filter((row) => row.resultStatus === "LOST").length;
  const oddsRows = rows.filter((row) => Number(row.odds) > 0);
  const stakeReturn = oddsRows.reduce((sum, row) => {
    if (row.resultStatus === "WON") return sum + Math.max(0, Number(row.odds || 0) - 1);
    if (row.resultStatus === "LOST") return sum - 1;
    return sum;
  }, 0);
  const probabilityRows = rows.filter((row) => Number.isFinite(row.probability));

  return {
    settled,
    won,
    lost,
    hitRate: settled ? round(won / settled) : null,
    roi: oddsRows.length ? round(stakeReturn / oddsRows.length) : null,
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

function reviewSignalAdjustment(key, summary) {
  const settled = Number(summary?.settled || 0);
  if (settled < MIN_RULE_ROWS) {
    return {
      onlineAction: "observe",
      sampleStatus: "low-sample",
      reasons: [`sample<${MIN_RULE_ROWS}`],
      adjustments: combineAdjustments([]),
    };
  }

  const presets = {
    "draw-risk-underestimated": {
      reasons: ["review-draw-risk-missed"],
      adjustments: {
        minProbabilityBoost: 0.025,
        minModelGapBoost: 0.015,
        minHandicapSupportBoost: 0.02,
        trustPenalty: 3,
        maxRiskTagsDelta: -1,
      },
    },
    "handicap-lane-suppressed": {
      reasons: ["review-handicap-lane-was-better"],
      adjustments: {
        minProbabilityBoost: 0.01,
        minModelGapBoost: 0.012,
        minHandicapSupportBoost: 0.045,
        trustPenalty: 3,
        maxRiskTagsDelta: -1,
      },
    },
    "best-miss": {
      reasons: ["review-best-miss-cooling"],
      adjustments: {
        minProbabilityBoost: 0.02,
        minModelGapBoost: 0.012,
        minHandicapSupportBoost: 0.015,
        trustPenalty: 2,
        maxRiskTagsDelta: -1,
      },
    },
    "goals-underestimated": {
      reasons: ["review-goals-low-projection"],
      adjustments: {
        goalsMinBoost: 0.025,
        trustPenalty: 2,
      },
    },
    "goals-overestimated": {
      reasons: ["review-goals-high-projection"],
      adjustments: {
        goalsMinBoost: 0.02,
        trustPenalty: 2,
      },
    },
  };
  const preset = presets[key];
  if (!preset) {
    return {
      onlineAction: "observe",
      sampleStatus: "neutral",
      reasons: ["review-signal-observed"],
      adjustments: combineAdjustments([]),
    };
  }

  return {
    onlineAction: "tighten",
    sampleStatus: settled >= MIN_LOOSEN_ROWS ? "validated" : "guarded",
    reasons: preset.reasons,
    adjustments: combineAdjustments([preset.adjustments]),
  };
}

function buildReviewSignalRule(key, summary) {
  const adjustment = reviewSignalAdjustment(key, summary);
  return {
    key,
    settled: Number(summary?.settled || 0),
    won: Number(summary?.won || 0),
    lost: Number(summary?.lost || 0),
    hitRate: Number.isFinite(summary?.hitRate) ? summary.hitRate : null,
    onlineAction: adjustment.onlineAction,
    sampleStatus: adjustment.sampleStatus,
    reasons: adjustment.reasons,
    adjustments: adjustment.adjustments,
  };
}

function activeRuleCount(rulesByKey) {
  return Object.values(rulesByKey || {}).filter((rule) => rule.onlineAction === "tighten").length;
}

function buildStrategy(matches, reviewPayload) {
  const matchRows = predictionRows(matches);
  const reviewRows = postMatchReviewRows(reviewPayload, matches);
  const rows = dedupePredictionRows([...matchRows, ...reviewRows]);
  const officialRows = rows.filter((row) => row.fromPostMatchReview || Number(row.odds) > 0);
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
    byDiagnosis: groupSummaryMany(officialRows, (row) => row.diagnosisCodes || []),
    byAdjustment: groupSummaryMany(officialRows, (row) => row.adjustmentCodes || []),
    byReviewRole: groupSummary(officialRows, (row) => row.reviewRole || "unknown"),
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
  const gateByReviewSignal = Object.fromEntries(
    Object.entries(summary.byDiagnosis).map(([key, value]) => [key, capDetailRule(buildReviewSignalRule(key, value))])
  );

  const activeGates = {
    profile: activeRuleCount(gateByProfile),
    market: activeRuleCount(gateByMarket),
    marketProfile: activeRuleCount(gateByMarketProfile),
    oddsBucket: activeRuleCount(gateByOddsBucket),
    tip: activeRuleCount(gateByTip),
    webConsensus: activeRuleCount(gateByWebConsensus),
    reviewSignal: activeRuleCount(gateByReviewSignal),
  };
  const settledOfficialRows = officialRows.length;

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: "settled-pre-match-predictions",
    activation: {
      mode: "cooling-only",
      onlineEffect: settledOfficialRows >= MIN_RULE_ROWS ? "guarded-active" : "shadow",
      minimumRowsForRule: MIN_RULE_ROWS,
      minimumRowsForProfile: MIN_PROFILE_ROWS,
      minimumRowsForLoosening: MIN_LOOSEN_ROWS,
      note: "Only tightening rules are applied online until a bucket reaches the loosening sample floor.",
    },
    sample: {
      matches: matches.length,
      settledRows: rows.length,
      officialRows: settledOfficialRows,
      postMatchReviewRows: reviewRows.length,
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
    gateByReviewSignal,
    recommendations: [
      {
        id: "sample-guard",
        status: settledOfficialRows >= MIN_LOOSEN_ROWS ? "ready-for-controlled-loosening" : "cooling-only",
        reason: settledOfficialRows >= MIN_LOOSEN_ROWS
          ? "The settled official sample has reached the loosening floor."
          : "The settled official sample is still small, so automation may tighten gates but will not loosen them.",
      },
      {
        id: "review-loop",
        status: reviewRows.length >= MIN_RULE_ROWS ? "active" : "pending",
        reason: reviewRows.length >= MIN_RULE_ROWS
          ? "Post-match review rows are now part of the recommendation gates."
          : "Post-match review rows are not yet enough for guarded recommendation gates.",
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
const postMatchReviews = readJson(postMatchReviewsFile, { rows: [], summary: {} });

const strategy = buildStrategy(matches, postMatchReviews);
for (const file of outputFiles) writeJson(file, strategy);

console.log(JSON.stringify({
  ok: true,
  version: strategy.version,
  outputFiles,
  sample: strategy.sample,
  activeGates: strategy.activeGates,
  onlineEffect: strategy.activation.onlineEffect,
}, null, 2));
