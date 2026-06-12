const fs = require("fs");
const path = require("path");

const VERSION = "self-optimization-v1";
const ENABLED_MARKETS = new Set(["1X2", "HHAD", "GOALS", "BEST"]);
const PROFILE_KEYS = ["international", "japan", "other"];

const MIN_RULE_ROWS = 3;
const MIN_PROFILE_ROWS = 5;
const MIN_LOOSEN_ROWS = 100;
const MAX_DETAIL_BOOST = 0.06;

const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const serverDataDir = path.join(rootDir, "server-data");
const outputFiles = [
  path.join(publicDataDir, "model-strategy.json"),
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

function probabilityForTip(match, prediction) {
  const oneXTwo = match?.probabilityModel?.oneXTwo?.final;
  if (!oneXTwo) return null;
  if (prediction.tipCode === "1") return Number(oneXTwo.home) / 100;
  if (prediction.tipCode === "X") return Number(oneXTwo.draw) / 100;
  if (prediction.tipCode === "2") return Number(oneXTwo.away) / 100;
  return null;
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
      };
      rows.push(row);
    }
  }
  return rows.sort((a, b) => String(a.kickoffTime).localeCompare(String(b.kickoffTime)));
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

function buildStrategy(matches) {
  const rows = predictionRows(matches);
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

  const activeGates = {
    profile: activeRuleCount(gateByProfile),
    market: activeRuleCount(gateByMarket),
    marketProfile: activeRuleCount(gateByMarketProfile),
    oddsBucket: activeRuleCount(gateByOddsBucket),
    tip: activeRuleCount(gateByTip),
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
      recommendationRows: recommendationRows.length,
      bestRows: bestRows.length,
      goalsRows: goalsRows.length,
    },
    summary,
    activeGates,
    gateByProfile,
    gateByMarket,
    gateByMarketProfile,
    gateByOddsBucket,
    gateByTip,
    recommendations: [
      {
        id: "sample-guard",
        status: settledOfficialRows >= MIN_LOOSEN_ROWS ? "ready-for-controlled-loosening" : "cooling-only",
        reason: settledOfficialRows >= MIN_LOOSEN_ROWS
          ? "The settled official sample has reached the loosening floor."
          : "The settled official sample is still small, so automation may tighten gates but will not loosen them.",
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
const matches = matchFiles.flatMap((file) => {
  const parsed = readJson(file, []);
  return Array.isArray(parsed) ? parsed : [];
});

const strategy = buildStrategy(matches);
for (const file of outputFiles) writeJson(file, strategy);

console.log(JSON.stringify({
  ok: true,
  version: strategy.version,
  outputFiles,
  sample: strategy.sample,
  activeGates: strategy.activeGates,
  onlineEffect: strategy.activation.onlineEffect,
}, null, 2));
