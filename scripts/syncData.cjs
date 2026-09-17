const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { readChunkedJsonFile } = require("../server/chunkedJsonFile.cjs");
const { predictionNowMs, predictionNowIso, executeWithPredictionClock } = require("../src/services/predictionExecutionClock.cjs");
const { spawn } = require("child_process");
const {
  MULTI_FACTOR_POLICY_VERSION,
  evaluateMultiFactorRecommendation,
} = require("../src/services/multiFactorRecommendation.cjs");
const {
  CONFIDENCE_POLICY_VERSION,
  buildDynamicRecommendationConfidence,
  confidenceReferenceTier,
} = require("../src/services/recommendationConfidence.cjs");
const {
  isOfficialRecommendationEligible,
} = require("../src/services/officialRecommendationEligibility.cjs");
const {
  LIVE_OFFICIAL_ODDS_MAX_AGE_MS,
  LIVE_RECOMMENDATION_POLICY_VERSION,
  buildLivePublicationEvidence,
  evaluateLiveRecommendation,
  hasOfficialSportterySourceForLivePrediction,
  isLivePublicationEvidenceValid,
  isLiveRecommendationWindowOpen,
  isPublishedLiveRecommendationEligible,
  officialOddsForLivePrediction,
  officialOddsFreshnessForLivePrediction,
  parseShanghaiDateTime,
} = require("../src/services/liveRecommendationEligibility.cjs");
const {
  appendPublicationRecord,
  buildPublicationLedgerIndex,
  hashPublicationEvidence,
  loadPublicationLedger,
  publicationBindingForRecord,
  resolvePublishedRecommendation,
} = require("../src/services/recommendationPublicationLedger.cjs");
const {
  DECISION_SNAPSHOT_VERSION,
  buildCandidateDecisionSnapshot,
} = require("../src/services/decisionSnapshot.cjs");
const {
  attestDualMarketDecisionBinding,
  hashDualMarketDecisionBinding,
} = require("../src/services/dualMarketDecisionBinding.cjs");
const {
  attestImmutableAnalysisReferenceDecision,
  buildImmutableAnalysisReferenceDecision,
} = require("../src/services/immutableAnalysisReferenceDecision.cjs");
const {
  buildSportteryMarketSourceProvenance,
  marketSourceLineageId,
  normalizeMarketSourceProvenance,
} = require("../src/services/marketSourceProvenance.cjs");
const {
  extractionFromSportteryPool,
  loadCollectorTrustRegistry,
} = require("../src/services/collectorAttestation.cjs");
const {
  canonicalSourceMatchId,
  eventVersionOf,
  isOfficialSportteryFinal,
  isTrustedOfficialFinal,
  reconcileMatchLifecycle,
  resolveMatchLifecycle,
  sameEvent,
} = require("../src/services/matchLifecycle.cjs");
const {
  officialVoidDispositionFromSportteryRow,
  scoreFromSportteryRow,
  statusFromSportteryRow,
  teamCodeFromSportteryRow,
} = require("../src/services/sportteryResultSemantics.cjs");
// Retain the established syncData test/export surface while row normalization
// itself uses the shared result-semantics contract above.
const { officialVoidDisposition } = require("../src/services/sportteryStatus.cjs");
const { loadOddsHistory } = require("./oddsHistoryStore.cjs");
const { loadRuntimeOddsHistory } = require("./runtimeOddsHistory.cjs");
const { summarizeRelayLanes } = require("./relayLaneFreshness.cjs");
const { boundedRuntimeEnv } = require("./boundedRuntimeNumber.cjs");
const {
  applyFastResultObservation,
  mergeFastResultObservations,
  overlayFastObservedFinals,
} = require("./fastResultObservations.cjs");
const { readRuntimeFastResultInput } = require("./runtimeFastResultInput.cjs");
const { readStorageMode } = require("../server/storageMode.cjs");
const { acquireSyncMetaCommitLock } = require("./syncMetaCommitLock.cjs");
const { FREE_FOOTBALL_TEAM_ALIASES } = require("./freeFootballTeamAliases.cjs");
const { buildFormalReviewPerformance } = require("../server/reviewPerformanceSummary.cjs");
const { auditRecommendationBias } = require("./auditRecommendationBatchBias.cjs");
const {
  browserFallbackEnabled,
  requestJsonViaEdgeDocument,
} = require("./sportteryBrowserTransport.cjs");
const { forEachForecastAsOf } = require("./asOfResultTimeline.cjs");
const { updateAiArenaState } = require("./aiArenaEngine.cjs");
const { persistAiArenaSqlite } = require("./aiArenaSqlite.cjs");
const {
  analyzeMarketMovement,
  movementEvidenceForCode,
} = require("../src/services/marketMovement.cjs");
const {
  withOddsObservationTrail,
} = require("../src/services/oddsObservationTrail.cjs");
const {
  isMatchEligibleForCurrent,
  reconcileArchivedUnsettled,
  resolveCurrentUnsettledRetentionHours,
  splitMatchesForOutput,
} = require("./currentMatchRetention.cjs");
const {
  HISTORICAL_TRAINING_RELEASE_ENTRY,
  inspectHistoricalTrainingFile,
} = require("./historicalTrainingReleaseArtifact.cjs");
const {
  applyUefaOfficialResult,
  loadUefaOfficialResults,
} = require("./syncUefaOfficialResults.cjs");
const {
  applyOfficialClubResult,
  loadOfficialClubResults,
} = require("./syncOfficialClubResults.cjs");
const {
  applyKLeagueOfficialResult,
} = require("./syncKLeagueOfficialStandings.cjs");
const {
  loadArchivedPreMatchRecoveries,
  recoveryArchiveForMatch,
} = require("./archivedPreMatchRecovery.cjs");
const { loadRestorations, restoreMissingArchive, retainedRestorationReceipt } = require("./frozenArchiveRestoration.cjs");
const ROOT_DIR = path.resolve(__dirname, "..");
const ARCHIVED_PREMATCH_RECOVERY_INDEX = loadArchivedPreMatchRecoveries();
const FROZEN_ARCHIVE_RESTORATION_INDEX = loadRestorations();
const COLLECTOR_TRUST_REGISTRY_PATH = path.resolve(
  process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH
  || path.join(ROOT_DIR, "deploy", "light-server", "collector-trust-registry.json")
);
const COLLECTOR_TRUST_REGISTRY = loadCollectorTrustRegistry(
  COLLECTOR_TRUST_REGISTRY_PATH
);
const normalizeTrustedMarketSourceProvenance = (value) => (
  normalizeMarketSourceProvenance(value, {
    trustRegistry: COLLECTOR_TRUST_REGISTRY,
  })
);
const {
  SPORTTERY_BASE,
  SPORTTERY_CALCULATOR_URL: CALCULATOR_URL,
  SPORTTERY_CURRENT_URL: CURRENT_URL,
  SPORTTERY_RESULT_URL: RESULT_URL,
  sportteryRequestHeaders,
} = require("./sportteryEndpointContract.cjs");
const {
  isOfficialUniformResultUrl,
  normalizeOfficialUniformResultPayload,
} = require("./sportteryOfficialResult.cjs");
const PAGE_SIZE = Math.max(1, Number(process.env.SPORTTERY_PAGE_SIZE || 80));
const PAGE_DEPTH = Math.max(1, Number(process.env.SPORTTERY_PAGE_DEPTH || 120));
const WINDOW_BACK_DAYS = Math.max(0, Number(process.env.MATCH_WINDOW_BACK_DAYS || 365));
const WINDOW_FORWARD_DAYS = Math.max(1, Number(process.env.MATCH_WINDOW_FORWARD_DAYS || 14));
const ODDS_HISTORY_RETENTION_DAYS = Math.max(1, Number(process.env.ODDS_HISTORY_RETENTION_DAYS || 90));
const ODDS_HISTORY_MAX_ROWS = Math.max(1000, Number(process.env.ODDS_HISTORY_MAX_ROWS || 12000));
const ODDS_HISTORY_BUCKET_MINUTES = Math.max(1, Number(process.env.ODDS_HISTORY_BUCKET_MINUTES || 5));
const PAGE_POLL_SECONDS = Math.max(15, Number(process.env.PAGE_POLL_SECONDS || 30));
const CONFIGURED_WORKFLOW_MINUTES = Number(process.env.SYNC_WORKFLOW_MINUTES);
const SYNC_WORKFLOW_MINUTES = Number.isFinite(CONFIGURED_WORKFLOW_MINUTES)
  ? Math.max(1, CONFIGURED_WORKFLOW_MINUTES)
  : 5;
const TRUSTED_MAX_FUTURE_SKEW_MS = boundedRuntimeEnv(
  process.env,
  "TRUSTED_MAX_FUTURE_SKEW_SECONDS",
  { fallback: 300, min: 0, max: 3600 },
) * 1000;
const ANALYST_PROMPT_VERSION = "professional-football-analyst-v25";
const PREDICTION_POLICY_VERSION = "sporttery-day-formula-trace-v74-auditable-confidence-facts";
const PRE_CUTOFF_MODEL_REFRESH_FROM_POLICY = "sporttery-day-formula-trace-v67-evidence-led-poisson";
const HISTORICAL_TRAINING_APPLICATION_VERSION = "historical-training-application-v3-signed-seed-trusted-event-incremental";
const CALIBRATED_HAD_MARKET_MIN_LEADER_PROBABILITY = 0.60;
const CONFIGURED_LLM_REVIEW_MODEL = String(process.env.GPT_MODEL || "").trim();
const ANALYST_RUNTIME = Object.freeze({
  model: CONFIGURED_LLM_REVIEW_MODEL || null,
  modelStatus: CONFIGURED_LLM_REVIEW_MODEL ? "configured" : "not-configured",
  role: "optional-risk-review-only",
  reasoningEffort: "high",
  promptDocument: "docs/professional-analysis-prompt.md",
});
const FORM_LOOKBACK_MATCHES = 12;
const SAFE_AUTO_TUNING_MIN_ROWS = 50;
const SAFE_AUTO_TUNING_MIN_MATCH_DAYS = 4;
const SCORE_CALIBRATION_RECENT_DAYS = Math.max(2, Number(process.env.SCORE_CALIBRATION_RECENT_DAYS || 2));
const SCORE_CALIBRATION_ROLLING_DAYS = Math.max(SCORE_CALIBRATION_RECENT_DAYS, Number(process.env.SCORE_CALIBRATION_ROLLING_DAYS || 14));
const SCORE_CALIBRATION_MIN_ROWS = Math.max(
  SAFE_AUTO_TUNING_MIN_ROWS,
  Number(process.env.SCORE_CALIBRATION_MIN_ROWS || SAFE_AUTO_TUNING_MIN_ROWS)
);
const PREDICTION_SNAPSHOT_RETENTION_DAYS = Math.max(30, Number(process.env.PREDICTION_SNAPSHOT_RETENTION_DAYS || 365));
const PREDICTION_SNAPSHOT_MAX_ROWS = Math.max(500, Number(process.env.PREDICTION_SNAPSHOT_MAX_ROWS || 5000));
const PREDICTION_SNAPSHOT_MAX_ROWS_PER_MATCH = Math.max(
  1,
  Number(process.env.PREDICTION_SNAPSHOT_MAX_ROWS_PER_MATCH || 6)
);
const METHODS = (process.env.SPORTTERY_METHODS || "concern,live,result,all")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const SPORTTERY_RELAY_MODE = String(process.env.SPORTTERY_RELAY_MODE || "prefer").toLowerCase();
const SPORTTERY_RELAY_MAX_AGE_MINUTES = boundedRuntimeEnv(
  process.env,
  ["SPORTTERY_RELAY_MAX_AGE_MINUTES", "SOURCE_MAX_AGE_MINUTES"],
  { fallback: 20, min: 1, max: 30 * 24 * 60 },
);
const SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES",
  { fallback: 180, min: SPORTTERY_RELAY_MAX_AGE_MINUTES, max: 30 * 24 * 60 },
);
const SKIP_SPORTTERY_DIRECT_FETCH = process.env.SKIP_SPORTTERY_DIRECT_FETCH === "1"
  || process.env.SPORTTERY_DIRECT_FETCH === "0";
const DEFAULT_STORE_DIR = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(ROOT_DIR, "server-data"));
const DEFAULT_SPORTTERY_RELAY_SNAPSHOT = path.join(DEFAULT_STORE_DIR, "sporttery-relay-snapshot.json");
const DEFAULT_SPORTTERY_RELAY_FAST_LANE_SNAPSHOT = path.join(DEFAULT_STORE_DIR, "sporttery-relay-fast-lane.json");
const RECOMMENDATION_PUBLICATION_LEDGER_PATH = path.resolve(
  process.env.RECOMMENDATION_PUBLICATION_LEDGER_PATH
  || path.join(DEFAULT_STORE_DIR, "recommendation-publication-ledger.json")
);
const UNRESOLVED_MATCH_ARCHIVE_PATH = path.resolve(
  process.env.UNRESOLVED_MATCH_ARCHIVE_PATH || path.join(DEFAULT_STORE_DIR, "matches-unresolved-archive.json")
);
const AI_ARENA_STATE_PATH = path.resolve(
  process.env.AI_ARENA_STATE_PATH || path.join(DEFAULT_STORE_DIR, "ai-arena-state.json")
);
const AI_ARENA_SQLITE_PATH = path.resolve(
  process.env.AI_ARENA_SQLITE_PATH || path.join(DEFAULT_STORE_DIR, "ai-arena.db")
);
const CURRENT_UNSETTLED_RETENTION_HOURS = resolveCurrentUnsettledRetentionHours();

const STATUS_PRIORITY = { FINISHED: 6, LIVE: 5, PENDING_RESULT: 4, SCHEDULED: 2 };
const PREDICTION_DATA_POLICY = {
  zh: "竞彩截止前，模型结合球队强度、历史样本、近期状态、比分分布与市场赔率生成参考。各项是否参与、使用权重和数据缺口以本次计算记录为准；有输入不等于来源已验证。截止后保留历史预测，只结算赛果，不回写旧推荐。",
  en: "Before cutoff, the model combines team strength, history, form, score distributions and market odds. Actual use, weights and gaps follow this calculation's records; presence is not source verification. After cutoff, historical predictions are preserved and only results are settled.",
};
const PREDICTION_MODEL_BASIS = {
  zh: "模型按竞彩日归档、按官方开赛时间排序。基础概率结合 Elo、球队强度、Poisson 比分分布和市场赔率，随后进行反馈、校准与统一后验选择。赔率并非固定零权重；各阶段实际系数与缺失回退需分别核对，基础模型输出不等于最终冻结的公开方向。",
  en: "Schedules use Sporttery business days and official kickoff order. Base probabilities mix Elo, team strength, Poisson scores and market odds before feedback, calibration and unified selection. Market weight is not fixed at zero. Stage coefficients and missing-input fallbacks must be audited separately; base output is not the final frozen public direction.",
};
const ANALYST_OUTPUT_SECTIONS = Object.freeze([
  { id: "baseline", zh: "一、比赛基本面分析", en: "1. Fixture baseline" },
  { id: "recent-form", zh: "二、近期状态分析", en: "2. Recent form" },
  { id: "home-away", zh: "三、主客场表现分析", en: "3. Home and away split" },
  { id: "attack", zh: "四、进攻能力分析", en: "4. Attack" },
  { id: "defense", zh: "五、防守能力分析", en: "5. Defense" },
  { id: "lineup", zh: "六、伤停与首发阵容分析", en: "6. Injuries and starting XI" },
  { id: "tactics", zh: "七、战术风格与克制关系分析", en: "7. Tactical matchup" },
  { id: "schedule-motivation", zh: "八、赛程体能与战意分析", en: "8. Schedule, fitness, motivation" },
  { id: "h2h", zh: "九、历史交锋分析", en: "9. Head to head" },
  { id: "environment-referee", zh: "十、天气、场地与裁判因素", en: "10. Weather, pitch, referee" },
  { id: "market", zh: "十一、赔率与盘口分析", en: "11. Odds and market" },
  { id: "verdict", zh: "十二、综合判断与预测结论", en: "12. Verdict" },
]);
const PROBABILITY_FORECASTING_PRINCIPLES = Object.freeze({
  zh: [
    "先输出胜平负、比分分布、大小球、双方进球和让球概率，不把任务简化成只猜胜负。",
    "独立概率先由 Elo 强度、Poisson 比分模型、近一年攻防、长期历史样本和赛程密度生成；世界杯先验仅在安全校验通过时参与，官方 SP 只作为市场校验和价值差参考。",
    "推荐阈值跟随 model-calibration 动态变化；低命中联赛、市场或方向自动降权并提高概率差与让球支持要求。",
    "回测必须按时间滚动，严禁赛后 xG、赛后射门、最终排名、未公开首发或时间点不一致的临场赔率泄漏。",
    "评估以 log loss、Brier score、校准误差和分桶可靠性为主，命中率只作为辅助观察。",
  ],
  en: [
    "Output 1X2, score distribution, totals, BTTS, and handicap probabilities first instead of reducing the task to one winner.",
    "Independent probabilities are generated first from Elo strength, Poisson score modelling, last-year attack/defense form, long-run history, and schedule density; World Cup priors participate only after safety validation, while official SP is only market validation and value-gap reference.",
    "Recommendation gates follow model-calibration dynamically; cold leagues, markets, or directions are down-weighted with higher probability-gap and handicap-support requirements.",
    "Backtests must be time-ordered and must not leak post-match xG, post-match shots, final table rank, unpublished lineups, or late odds into earlier forecast nodes.",
    "Evaluate with log loss, Brier score, calibration error, and bucket reliability; hit rate is only a secondary diagnostic.",
  ],
});
const FORECAST_TARGET_SCHEMA = Object.freeze([
  { id: "one-x-two", zh: "胜平负：主胜、平局、客胜三项概率", en: "1X2: home, draw, away probabilities" },
  { id: "score-distribution", zh: "比分分布：2-3 个最高概率比分", en: "Score distribution: top 2-3 scorelines" },
  { id: "goal-lines", zh: "大小球：大/小 2.5 概率", en: "Goal line: over/under 2.5 probabilities" },
  { id: "btts", zh: "双方进球：BTTS Yes/No 概率", en: "BTTS: yes/no probabilities" },
  { id: "handicap", zh: "让球概率：当前官方让球线支持率", en: "Handicap: support at the current official line" },
]);
const MODELING_STACK = Object.freeze([
  { id: "independent-baseline", zh: "独立基准：Elo、历史样本、Poisson 概率，以及通过安全校验后才启用的世界杯先验", en: "Independent baseline: Elo, historical samples, Poisson probabilities, plus World Cup priors only after safety validation" },
  { id: "elo", zh: "Elo/Glicko 强度：球队动态评分、主场优势和强弱差", en: "Elo/Glicko strength: dynamic rating, home advantage, team gap" },
  { id: "poisson", zh: "Poisson/Dixon-Coles：进球期望、比分矩阵、大小球和让球聚合", en: "Poisson/Dixon-Coles: goal expectations, score matrix, totals, handicap aggregation" },
  { id: "ml", zh: "机器学习层：仅在基准稳定并完成时间滚动回测后加入", en: "ML layer: added only after stable baselines and time-ordered backtests" },
  { id: "ensemble", zh: "集成层：用滚动验证集优化强度/Elo/Poisson/ML 权重", en: "Ensemble: optimize strength/Elo/Poisson/ML weights on rolling validation" },
  { id: "calibration", zh: "校准层：可靠性曲线、Platt、isotonic、联赛和场景分桶", en: "Calibration: reliability curves, Platt, isotonic, league and profile buckets" },
]);
const FEATURE_PRIORITY = Object.freeze([
  "long-term-team-strength",
  "independent-model-probability",
  "xg-xga-gap-when-connected",
  "home-away-split-and-travel",
  "injuries-and-lineup-quality",
  "rest-days-and-schedule-density",
  "style-matchup",
  "motivation",
  "ranking-pressure-and-attack-intent",
  "discipline-cards-and-red-card-risk",
  "weather-and-pitch",
  "referee-tendency",
]);
const QUALITY_STANDARDS = Object.freeze({
  zh: [
    "必须输出概率，而不是只输出胜负结论。",
    "必须按时间滚动回测，不能随机切分。",
    "必须校准概率，并按联赛、场景和赔率区间分桶评估。",
    "必须避免未来信息泄漏。",
    "必须长期接近或优于简单赔率基准，否则不升格为推荐。",
    "必须保留赛前快照，赛后只结算和复盘，不改写原方向。",
  ],
  en: [
    "Output probabilities, not just a winner.",
    "Use time-ordered rolling backtests, not random splits.",
    "Calibrate probabilities and evaluate by league, profile, and odds bucket.",
    "Avoid future-information leakage.",
    "Approach or beat the simple market baseline long term before promoting recommendations.",
    "Keep pre-match snapshots; after kickoff only settle and review, never rewrite the original direction.",
  ],
});
const PREDICTION_ANALYST_FRAMEWORK = Object.freeze({
  version: ANALYST_PROMPT_VERSION,
  role: {
    zh: "专业足球赛事分析师",
    en: "Professional football analyst",
  },
  runtime: ANALYST_RUNTIME,
  outputSections: ANALYST_OUTPUT_SECTIONS,
  probabilityPrinciples: PROBABILITY_FORECASTING_PRINCIPLES,
  forecastTargets: FORECAST_TARGET_SCHEMA,
  modelingStack: MODELING_STACK,
  featurePriority: FEATURE_PRIORITY,
  qualityStandards: QUALITY_STANDARDS,
  finalVerdict: {
    zh: "结论必须区分稳妥方向和激进方向；胜平负与让球方向保持一致；数据不足时明确标注，不为推荐而硬推。",
    en: "The verdict must split conservative and aggressive directions; 1X2 and handicap views must stay consistent; missing data is labelled and no pick is forced.",
  },
});

function sportteryOutboundProxy() {
  return normText(process.env.SPORTTERY_OUTBOUND_PROXY || process.env.SPORTTERY_HTTP_PROXY || "");
}

function curlHeaderArgs(url, tab = "all") {
  return Object.entries(sportteryRequestHeaders(url, tab))
    .flatMap(([key, value]) => ["-H", `${key}: ${value}`]);
}
function normText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function latestTrustedIsoTime(...values) {
  const latestAllowed = Date.now() + TRUSTED_MAX_FUTURE_SKEW_MS;
  const times = values
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value) && value <= latestAllowed);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

let sportteryFetchSummary = {
  transport: "direct",
  relaySnapshot: null,
  errors: [],
};

function resetSportteryFetchSummary() {
  sportteryFetchSummary = {
    transport: "direct",
    relaySnapshot: null,
    errors: [],
  };
}

function compactSportteryFetchError(error) {
  return String(error?.message || error || "")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function recordSportteryFetchError(entry) {
  const errors = Array.isArray(sportteryFetchSummary.errors)
    ? sportteryFetchSummary.errors
    : [];
  errors.push({
    at: new Date().toISOString(),
    stage: entry.stage || null,
    method: entry.method || null,
    url: entry.url || null,
    error: compactSportteryFetchError(entry.error || entry.message),
  });
  sportteryFetchSummary.errors = errors.slice(-30);
}

function withSportteryFetchSummary(next) {
  return {
    ...next,
    errors: Array.isArray(sportteryFetchSummary.errors) ? sportteryFetchSummary.errors.slice(-30) : [],
  };
}

function publicRelaySnapshotSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const {
    path: snapshotPath,
    fullPath: fullSnapshotPath,
    fastPath: fastSnapshotPath,
    ...publicSummary
  } = summary;
  if (snapshotPath) publicSummary.fileName = path.basename(snapshotPath);
  if (fullSnapshotPath) publicSummary.fullFileName = path.basename(fullSnapshotPath);
  if (fastSnapshotPath) publicSummary.fastFileName = path.basename(fastSnapshotPath);
  return publicSummary;
}

function uniqueList(items) {
  return Array.from(new Set(items.map((item) => normText(item)).filter(Boolean)));
}

function sportteryRelaySnapshotPaths() {
  return uniqueList([
    process.env.SPORTTERY_RELAY_SNAPSHOT,
    process.env.SPORTTERY_RELAY_SNAPSHOT_PATH,
    DEFAULT_SPORTTERY_RELAY_SNAPSHOT,
  ]).map((item) => path.resolve(item));
}

function sportteryRelayFastLaneSnapshotPaths() {
  return uniqueList([
    process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT,
    process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH,
    DEFAULT_SPORTTERY_RELAY_FAST_LANE_SNAPSHOT,
  ]).map((item) => path.resolve(item));
}

function relaySnapshotEntryRows(entry) {
  const payload = entry?.payload;
  if (!payload || typeof payload !== "object") return 0;
  return (payload.value?.matchInfoList || [])
    .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);
}

function compactRelayCollectorState(state) {
  if (!state || typeof state !== "object") return null;
  const fullCircuit = state.fullCircuit && typeof state.fullCircuit === "object" ? state.fullCircuit : null;
  const currentLaneState = state.currentLaneState && typeof state.currentLaneState === "object" ? state.currentLaneState : null;
  const failureRaw = state.lastFailure || fullCircuit?.lastFullFailure || null;
  const failure = failureRaw && typeof failureRaw === "object"
    ? {
        capturedAt: failureRaw.capturedAt || null,
        rows: toNum(failureRaw.rows, 0),
        errors: toNum(failureRaw.errors, 0),
        errorClasses: failureRaw.errorClasses || null,
        wafBlocked: Boolean(failureRaw.wafBlocked),
        sampleErrors: Array.isArray(failureRaw.sampleErrors)
          ? failureRaw.sampleErrors.slice(0, 3).map((item) => ({
              id: item?.id || null,
              method: item?.method || null,
              class: item?.class || null,
            }))
          : [],
      }
    : null;
  return {
    version: toNum(state.version, 1),
    updatedAt: state.updatedAt || null,
    circuitState: state.circuitState || fullCircuit?.circuitState || null,
    consecutiveFullFailures: toNum(state.consecutiveFullFailures ?? fullCircuit?.consecutiveFullFailures, 0),
    lastFullAttemptAt: state.lastFullAttemptAt || fullCircuit?.lastFullAttemptAt || null,
    lastFullOkAt: state.lastFullOkAt || fullCircuit?.lastFullOkAt || state.lastCollectOkAt || null,
    lastFullFailedAt: state.lastFullFailedAt || fullCircuit?.lastFullFailedAt || state.lastCollectFailedAt || null,
    nextFullProbeAt: state.nextFullProbeAt || fullCircuit?.nextFullProbeAt || null,
    legacyInflatedFailureCount: state.legacyInflatedFailureCount ?? fullCircuit?.legacyInflatedFailureCount ?? null,
    consecutiveCollectFailures: toNum(state.consecutiveCollectFailures ?? fullCircuit?.consecutiveFullFailures, 0),
    lastCollectOkAt: state.lastCollectOkAt || fullCircuit?.lastFullOkAt || null,
    lastCollectFailedAt: state.lastCollectFailedAt || fullCircuit?.lastFullFailedAt || null,
    lastUploadOkAt: state.lastUploadOkAt || null,
    lastRemotePrimaryAt: state.lastRemotePrimaryAt || null,
    lastRemoteServingMode: state.lastRemoteServingMode || null,
    fullCircuit: fullCircuit ? {
      circuitState: fullCircuit.circuitState || null,
      consecutiveFullFailures: toNum(fullCircuit.consecutiveFullFailures, 0),
      lastFullAttemptAt: fullCircuit.lastFullAttemptAt || null,
      lastFullOkAt: fullCircuit.lastFullOkAt || null,
      lastFullFailedAt: fullCircuit.lastFullFailedAt || null,
      nextFullProbeAt: fullCircuit.nextFullProbeAt || null,
      backoffMinutes: toNum(fullCircuit.backoffMinutes, 0),
      legacyInflatedFailureCount: fullCircuit.legacyInflatedFailureCount ?? null,
    } : null,
    currentLaneState: currentLaneState ? {
      consecutiveFailures: toNum(currentLaneState.consecutiveFailures, 0),
      lastAttemptAt: currentLaneState.lastAttemptAt || null,
      lastOkAt: currentLaneState.lastOkAt || null,
      lastFailedAt: currentLaneState.lastFailedAt || null,
      rows: toNum(currentLaneState.rows, 0),
      usableEndpoints: toNum(currentLaneState.usableEndpoints, 0),
    } : null,
    lastFailure: failure,
  };
}

function relayCollectorStateClockMs(state) {
  if (!state || typeof state !== "object") return NaN;
  const latestAllowed = Date.now() + TRUSTED_MAX_FUTURE_SKEW_MS;
  const fullCircuit = state.fullCircuit && typeof state.fullCircuit === "object"
    ? state.fullCircuit
    : null;
  const timestamps = [
    state.updatedAt,
    state.lastFullAttemptAt,
    state.lastFullFailedAt,
    state.lastFullOkAt,
    state.lastUploadOkAt,
    fullCircuit?.lastFullAttemptAt,
    fullCircuit?.lastFullFailedAt,
    fullCircuit?.lastFullOkAt,
  ]
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value) && value <= latestAllowed);
  return timestamps.length ? Math.max(...timestamps) : NaN;
}

function latestRelayCollectorState(fullState, fastState) {
  if (!fullState) return fastState || null;
  if (!fastState) return fullState;
  const fullClockMs = relayCollectorStateClockMs(fullState);
  const fastClockMs = relayCollectorStateClockMs(fastState);
  if (Number.isFinite(fastClockMs) && (
    !Number.isFinite(fullClockMs) || fastClockMs > fullClockMs
  )) {
    return fastState;
  }
  return fullState;
}

function relayEndpointMethod(entry) {
  return String(entry?.method || entry?.id || "")
    .replace(/^method:/, "")
    .trim()
    .toLowerCase();
}

function relayEndpointPage(entry) {
  const page = Number(entry?.page ?? 1);
  return Number.isFinite(page) ? page : 1;
}

function relayEndpointObservationMs(entry) {
  const value = entry?.receivedAt
    || entry?.collectorProvenance?.receivedAt
    || entry?.fetchedAt
    || entry?.capturedAt
    || entry?.updatedAt
    || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function readSportteryRelayCandidate(file, lane) {
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const capturedAt = payload?.capturedAt || payload?.updatedAt || null;
  const capturedMs = Date.parse(capturedAt || "");
  const nowMs = Date.now();
  const ageMinutes = Number.isFinite(capturedMs) ? (nowMs - capturedMs) / 60000 : Infinity;
  const futureClock = Number.isFinite(capturedMs) && capturedMs > nowMs + TRUSTED_MAX_FUTURE_SKEW_MS;
  const maxAgeMinutes = SPORTTERY_RELAY_MAX_AGE_MINUTES;
  const historyMaxAgeMinutes = SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES;
  const entries = Array.isArray(payload?.endpoints)
    ? payload.endpoints
    : Array.isArray(payload?.payloads)
      ? payload.payloads
      : [];
  const futureEntries = entries.filter((entry) => {
    const entryMs = relayEndpointObservationMs(entry);
    return Number.isFinite(entryMs) && entryMs > nowMs + TRUSTED_MAX_FUTURE_SKEW_MS;
  }).length;
  const usableEntries = entries.filter((entry) => (
    entry?.payload
    && entry.ok !== false
    && relaySnapshotEntryRows(entry) > 0
    && !(Number.isFinite(relayEndpointObservationMs(entry))
      && relayEndpointObservationMs(entry) > nowMs + TRUSTED_MAX_FUTURE_SKEW_MS)
  ));
  const rows = usableEntries.reduce((sum, entry) => sum + relaySnapshotEntryRows(entry), 0);
  const methods = Array.from(new Set(usableEntries.map(relayEndpointMethod).filter(Boolean)));
  const lanes = summarizeRelayLanes({ ...payload, endpoints: usableEntries }, {
    currentMaxAgeMinutes: maxAgeMinutes,
    historyMaxAgeMinutes,
  });
  const currentFresh = lanes.current?.usableEndpoints > 0
    && lanes.current?.futureClock !== true
    && lanes.current?.stale === false;
  const historyFresh = lanes.history?.usableEndpoints > 0
    && lanes.history?.futureClock !== true
    && lanes.history?.stale === false;
  const fastMethodsAllowed = usableEntries.every((entry) => {
    const method = relayEndpointMethod(entry);
    return method === "current"
      || method === "calculator"
      || (method === "result" && relayEndpointPage(entry) === 1);
  });
  const fastContractOk = lane !== "fast" || (
    payload?.version === 1
    && String(payload?.source || "").includes("sporttery")
    && futureClock === false
    && futureEntries === 0
    && fastMethodsAllowed
    // The signed relay upload gate accepts a single fresh official market
    // lane when the optional companion endpoint is WAF-blocked. Runtime
    // composition must apply the same rule or an accepted current-only
    // snapshot is silently discarded before prediction snapshots are built.
    && (methods.includes("current") || methods.includes("calculator"))
    && currentFresh
  );
  const collectorState = compactRelayCollectorState(
    payload?.producer?.collectorState || payload?.summary?.collectorState,
  );
  return {
    payload,
    entries: usableEntries,
    currentFresh,
    historyFresh,
    fastContractOk,
    summary: {
      path: file,
      lane,
      capturedAt,
      ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
      maxAgeMinutes,
      endpoints: usableEntries.length,
      rows,
      stale: !currentFresh,
      futureClock,
      futureEntries,
      methods,
      currentLane: lanes.current,
      resultLane: lanes.result,
      fullLane: lanes.full,
      historyLane: lanes.history,
      collectorState,
    },
  };
}

function firstSportteryRelayCandidate(paths, lane) {
  for (const file of paths) {
    try {
      const candidate = readSportteryRelayCandidate(file, lane);
      if (candidate) return candidate;
    } catch (error) {
      recordSportteryFetchError({ stage: "relay", method: lane, url: file, error });
      console.log(`Sporttery relay ${lane} snapshot read failed: ${file}: ${error.message || error}`);
    }
  }
  return null;
}

function relayCandidateCycleIds(candidate) {
  if (!candidate) return [];
  return uniqueList([
    candidate.payload?.sourceCycleId,
    candidate.payload?.uploadCycleId,
    candidate.payload?.mergeCycleId,
    ...(Array.isArray(candidate.payload?.constituentCycleIds) ? candidate.payload.constituentCycleIds : []),
    ...candidate.entries.flatMap((entry) => [
      entry?.sourceCycleId,
      entry?.collectorProvenance?.sourceCycleId,
      ...(Array.isArray(entry?.fastResultConstituent?.sourceCycleIds)
        ? entry.fastResultConstituent.sourceCycleIds
        : []),
    ]),
  ]);
}

function loadSportteryRelaySnapshot() {
  if (SPORTTERY_RELAY_MODE === "off" || SPORTTERY_RELAY_MODE === "0") return null;
  const full = firstSportteryRelayCandidate(sportteryRelaySnapshotPaths(), "full");
  const fast = firstSportteryRelayCandidate(sportteryRelayFastLaneSnapshotPaths(), "fast");
  const fastUsable = Boolean(fast?.fastContractOk && fast.currentFresh);
  const fullCurrentUsable = Boolean(full?.currentFresh);
  if (!fastUsable && !fullCurrentUsable) {
    const summary = { full: full?.summary || null, fast: fast?.summary || null };
    recordSportteryFetchError({
      stage: "relay",
      method: "current-overlay",
      url: fast?.summary?.path || full?.summary?.path || "sporttery-relay",
      error: "no fresh trusted Sporttery current lane",
    });
    console.log(`Sporttery relay current lanes unavailable: ${JSON.stringify(summary)}`);
    return null;
  }

  if (!fastUsable) {
    console.log(`Sporttery relay full snapshot ok: ${JSON.stringify(full.summary)}`);
    return { payload: full.payload, entries: full.entries, summary: full.summary };
  }

  const fastHasResultHead = fast.entries.some((entry) => (
    relayEndpointMethod(entry) === "result" && relayEndpointPage(entry) === 1
  ));
  const archiveEntries = full?.historyFresh
    ? full.entries.filter((entry) => {
        const method = relayEndpointMethod(entry);
        if (method === "current" || method === "calculator") return false;
        if (fastHasResultHead && method === "result" && relayEndpointPage(entry) === 1) return false;
        return ["concern", "live", "result", "all"].includes(method);
      })
    : [];
  const entriesByKey = new Map();
  for (const entry of [...archiveEntries, ...fast.entries]) {
    entriesByKey.set(`${relayEndpointMethod(entry)}:${relayEndpointPage(entry)}`, entry);
  }
  const entries = Array.from(entriesByKey.values());
  const rows = entries.reduce((sum, entry) => sum + relaySnapshotEntryRows(entry), 0);
  const methods = Array.from(new Set(entries.map(relayEndpointMethod).filter(Boolean)));
  const constituentCycleIds = uniqueList([
    ...relayCandidateCycleIds(full),
    ...relayCandidateCycleIds(fast),
  ]).sort();
  const overlayDigest = crypto.createHash("sha256")
    .update(constituentCycleIds.join("\n") || fast.summary.capturedAt || "sporttery-fast")
    .digest("hex")
    .slice(0, 20);
  const sourceCycleId = `sporttery-runtime-lane-overlay:${overlayDigest}`;
  const collectorState = latestRelayCollectorState(
    full?.summary?.collectorState,
    fast.summary.collectorState,
  );
  const payload = {
    version: 1,
    source: "sporttery-relay-runtime-overlay",
    capturedAt: fast.summary.currentLane?.capturedAt || fast.summary.capturedAt,
    sourceCycleId,
    sourceCycleKind: "runtime-lane-overlay",
    mergeCycleId: sourceCycleId,
    constituentCycleIds,
    provenanceVersion: 2,
    collectorProvenance: {
      sourceCycleId,
      cycleKind: "runtime-lane-overlay",
      constituentCycleIds,
      endpointObservationClocks: "preserved-from-independent-relay-files",
    },
    producer: {
      runtimeLaneOverlay: true,
      fullPath: full?.summary?.path || null,
      fastPath: fast.summary.path,
      collectorState,
    },
    maxAgeMinutes: SPORTTERY_RELAY_MAX_AGE_MINUTES,
    endpoints: entries,
    errors: [],
    summary: {
      endpoints: entries.length,
      usableEndpoints: entries.length,
      rows,
      methods,
      runtimeLaneOverlay: true,
      fastCapturedAt: fast.summary.capturedAt,
      fullCapturedAt: full?.summary?.capturedAt || null,
      archiveRetained: archiveEntries.length > 0,
      archiveEndpoints: archiveEntries.length,
    },
  };
  const lanes = summarizeRelayLanes(payload, {
    currentMaxAgeMinutes: SPORTTERY_RELAY_MAX_AGE_MINUTES,
    historyMaxAgeMinutes: SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES,
  });
  const summary = {
    path: fast.summary.path,
    fullPath: full?.summary?.path || null,
    fastPath: fast.summary.path,
    lane: "runtime-overlay",
    capturedAt: payload.capturedAt,
    ageMinutes: lanes.current?.ageMinutes ?? fast.summary.ageMinutes,
    maxAgeMinutes: SPORTTERY_RELAY_MAX_AGE_MINUTES,
    endpoints: entries.length,
    rows,
    stale: lanes.current?.stale !== false,
    futureClock: lanes.current?.futureClock === true,
    futureEntries: fast.summary.futureEntries,
    methods,
    currentLane: lanes.current,
    resultLane: lanes.result,
    fullLane: full?.summary?.fullLane || lanes.full,
    historyLane: full?.summary?.historyLane || lanes.history,
    collectorState,
    runtimeLaneOverlay: {
      version: "sporttery-relay-dual-file-v1",
      fastCapturedAt: fast.summary.capturedAt,
      fullCapturedAt: full?.summary?.capturedAt || null,
      archiveRetained: archiveEntries.length > 0,
      archiveEndpoints: archiveEntries.length,
      constituentCycleIds,
    },
  };
  console.log(`Sporttery relay dual-file overlay ok: ${JSON.stringify(summary)}`);
  return { payload, entries, summary };
}

function loadSportteryRelayHistorySnapshot() {
  if (SPORTTERY_RELAY_MODE === "off" || SPORTTERY_RELAY_MODE === "0") return null;
  const full = firstSportteryRelayCandidate(sportteryRelaySnapshotPaths(), "full");
  if (!full?.historyFresh) return null;
  const entries = full.entries.filter((entry) => (
    ["all", "result"].includes(relayEndpointMethod(entry))
  ));
  if (!entries.length) return null;
  const rows = entries.reduce((sum, entry) => sum + relaySnapshotEntryRows(entry), 0);
  const methods = Array.from(new Set(entries.map(relayEndpointMethod).filter(Boolean)));
  return {
    payload: full.payload,
    entries,
    summary: {
      ...full.summary,
      lane: "history-only",
      endpoints: entries.length,
      rows,
      methods,
      stale: true,
      historyOnly: true,
    },
  };
}

// The fast result publisher is a trust boundary, so it must audit the exact
// endpoint multiset from the fast-lane file before runtime composition can
// filter or de-duplicate it. Keep this loader separate from the UI/data overlay
// loader above: the latter intentionally composes lanes by endpoint key, while
// this one intentionally preserves duplicate and otherwise unusable endpoints
// so the signature audit can fail closed.
function loadSportteryRelayFastSnapshotForAudit() {
  if (SPORTTERY_RELAY_MODE === "off" || SPORTTERY_RELAY_MODE === "0") return null;
  const configuredPaths = uniqueList([
    process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT,
    process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH,
  ]).map((item) => path.resolve(item));
  if (configuredPaths.length > 1) {
    recordSportteryFetchError({
      stage: "relay",
      method: "fast-audit",
      url: configuredPaths.join(" | "),
      error: "conflicting fast-lane snapshot aliases",
    });
    return null;
  }
  const auditPath = configuredPaths[0] || path.resolve(DEFAULT_SPORTTERY_RELAY_FAST_LANE_SNAPSHOT);
  let fast = null;
  try {
    // Exactly one authoritative file is read. A malformed or missing watched
    // primary is terminal for this publication attempt; never fall through to
    // a different candidate that the watcher did not fingerprint.
    fast = readSportteryRelayCandidate(auditPath, "fast");
  } catch (error) {
    recordSportteryFetchError({
      stage: "relay",
      method: "fast-audit",
      url: auditPath,
      error,
    });
    return null;
  }
  if (!fast) return null;
  const rawEntries = Array.isArray(fast.payload?.endpoints)
    ? fast.payload.endpoints
    : Array.isArray(fast.payload?.payloads)
      ? fast.payload.payloads
      : [];
  return {
    payload: fast.payload,
    entries: rawEntries,
    summary: {
      ...(fast.summary || {}),
      currentFresh: fast.currentFresh === true,
      historyFresh: fast.historyFresh === true,
      fastContractOk: fast.fastContractOk === true,
      rawEndpoints: rawEntries.length,
    },
  };
}

function toNum(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashString(value) {
  let hash = 2166136261;
  const s = String(value || "");
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function seeded(seed) {
  let x = 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i += 1) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 0xffffffff;
  };
}

function colorFromName(name) {
  let hash = 2166136261;
  const text = String(name || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `#${(hash >>> 8).toString(16).slice(0, 6).padStart(6, "0")}`;
}

const FIFA_TO_ISO = {
  ALB: "AL",
  ALG: "DZ",
  ARG: "AR",
  ARM: "AM",
  AUS: "AU",
  AUT: "AT",
  BEL: "BE",
  BIH: "BA",
  BRA: "BR",
  BUL: "BG",
  CAN: "CA",
  CHI: "CL",
  CHN: "CN",
  CIV: "CI",
  COL: "CO",
  CRC: "CR",
  CRO: "HR",
  CUW: "CW",
  CYP: "CY",
  CZE: "CZ",
  DEN: "DK",
  ECU: "EC",
  ENG: "GB",
  ESP: "ES",
  FRA: "FR",
  GER: "DE",
  GRE: "GR",
  HAI: "HT",
  HUN: "HU",
  IRL: "IE",
  ISR: "IL",
  ITA: "IT",
  JOR: "JO",
  JPN: "JP",
  KOR: "KR",
  MEX: "MX",
  MAR: "MA",
  NED: "NL",
  NGA: "NG",
  NIR: "GB",
  NOR: "NO",
  PAR: "PY",
  PER: "PE",
  POL: "PL",
  POR: "PT",
  QAT: "QA",
  ROU: "RO",
  SCO: "GB",
  SRB: "RS",
  SLO: "SI",
  SUI: "CH",
  SVK: "SK",
  SWE: "SE",
  THA: "TH",
  TUR: "TR",
  UKR: "UA",
  URU: "UY",
  UZB: "UZ",
  USA: "US",
  WAL: "GB",
};

const TEAM_NAME_TO_ISO = {
  "\u4e2d\u56fd": "CN",
  "\u5308\u7259\u5229": "HU",
  "\u4f0a\u62c9\u514b": "IQ",
  "\u65af\u6d1b\u4f10\u514b": "SK",
  "\u65b0\u52a0\u5761": "SG",
  "斯洛文尼亚": "SI",
  "塞浦路斯": "CY",
  "瑞典": "SE",
  "希腊": "GR",
  "法国": "FR",
  "科特迪瓦": "CI",
  "墨西哥": "MX",
  "塞尔维亚": "RS",
  "哥伦比亚": "CO",
  "哥斯达黎加": "CR",
  "荷兰": "NL",
  "西班牙": "ES",
  "意大利": "IT",
  "英格兰": "GB",
  "德国": "DE",
  "葡萄牙": "PT",
  "巴西": "BR",
  "阿根廷": "AR",
  "美国": "US",
  "日本": "JP",
  "韩国": "KR",
  "乌兹别克斯坦": "UZ",
  "保加利亚": "BG",
  "克罗地亚": "HR",
  "冰岛": "IS",
  "刚果(金)": "CD",
  "刚果": "CG",
  "加拿大": "CA",
  "加纳": "GH",
  "北马其顿": "MK",
  "卡塔尔": "QA",
  "土耳其": "TR",
  "塞内加尔": "SN",
  "奥地利": "AT",
  "威尔士": "GB-WLS",
  "卢森堡": "LU",
  "巴拿马": "PA",
  "库拉索": "CW",
  "挪威": "NO",
  "捷克": "CZ",
  "格鲁吉亚": "GE",
  "比利时": "BE",
  "波黑": "BA",
  "澳大利亚": "AU",
  "爱尔兰": "IE",
  "瑞士": "CH",
  "科索沃": "XK",
  "突尼斯": "TN",
  "约旦": "JO",
  "罗马尼亚": "RO",
  "芬兰": "FI",
  "苏格兰": "GB-SCT",
  "黑山": "ME",
  "阿尔及利亚": "DZ",
  "丹麦": "DK",
  "波兰": "PL",
  "尼日利亚": "NG",
  "秘鲁": "PE",
  "北爱尔兰": "GB",
  "泰国": "TH",
  "哈萨": "KZ",
  "哈萨克斯坦": "KZ",
  "南非": "ZA",
  "巴拉": "PY",
  "巴拉圭": "PY",
  "摩洛": "MA",
  "摩洛哥": "MA",
  "海地": "HT",
  "厄瓜": "EC",
  "厄瓜多尔": "EC",
  "乌兹别克": "UZ",
  "乌兹别克斯坦": "UZ",
  "乌拉圭": "UY",
  "委内": "VE",
  "委内瑞拉": "VE",
  "埃及": "EG",
  "新西兰": "NZ",
  "刚果民主共和国": "CD",
  "刚果金": "CD",
};

function flagEmojiFromIso(isoCode) {
  const code = normText(isoCode).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...code.split("").map((letter) => 127397 + letter.charCodeAt(0)));
}

const J_LEAGUE_LOGO_BASE = "./team-logos/jleague";

const CLUB_LOGO_BY_NAME = {
  "\u5766\u4f69\u96f7\u5c71\u732b": "https://media.api-sports.io/football/teams/1163.png",
  "Ilves": "https://media.api-sports.io/football/teams/1163.png",
  "TPS\u56fe\u5c14\u5e93": "https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png",
  "TPS Turku": "https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png",
  "Turun Palloseura": "https://upload.wikimedia.org/wikipedia/en/3/30/Turun_Palloseura_logo.png",
  "\u56fd\u9645\u56fe\u5c14\u5e93": "https://media.api-sports.io/football/teams/1164.png",
  "Inter Turku": "https://media.api-sports.io/football/teams/1164.png",
  "AC\u5965\u5362": "https://upload.wikimedia.org/wikipedia/commons/d/d5/AC_Oulu_logo.svg",
  "AC Oulu": "https://upload.wikimedia.org/wikipedia/commons/d/d5/AC_Oulu_logo.svg",
  "\u96c5\u7f57": "https://upload.wikimedia.org/wikipedia/en/9/9f/FF_Jaro_logotype.svg",
  "FF Jaro": "https://upload.wikimedia.org/wikipedia/en/9/9f/FF_Jaro_logotype.svg",
  "\u8d6b\u5c14\u8f9b\u57fa": "https://media.api-sports.io/football/teams/649.png",
  "HJK Helsinki": "https://media.api-sports.io/football/teams/649.png",
  "\u74e6\u8428": "https://media.api-sports.io/football/teams/650.png",
  "VPS": "https://media.api-sports.io/football/teams/650.png",
  "\u5e93\u5965\u76ae\u5965": "https://media.api-sports.io/football/teams/1165.png",
  "KuPS": "https://media.api-sports.io/football/teams/1165.png",
  "\u739b\u4e3d\u6e2f": "https://upload.wikimedia.org/wikipedia/en/0/00/IFK_Mariehamnin_logo.svg",
  "IFK Mariehamn": "https://upload.wikimedia.org/wikipedia/en/0/00/IFK_Mariehamnin_logo.svg",
  "\u8d6b\u5c14\u8f9b\u57fa\u706b\u82b1": "https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg",
  "IF Gnistan": "https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg",
  "Gnistan": "https://upload.wikimedia.org/wikipedia/commons/d/d0/IF_Gnistan_logo.svg",
  "\u62c9\u8d6b\u8482": "https://media.api-sports.io/football/teams/1166.png",
  "Lahti": "https://media.api-sports.io/football/teams/1166.png",
  "\u585e\u4f0a\u5948\u7ea6\u57fa": "https://media.api-sports.io/football/teams/689.png",
  "SJK": "https://media.api-sports.io/football/teams/689.png",
  "\u9e7f\u5c9b\u9e7f\u89d2": `${J_LEAGUE_LOGO_BASE}/kashima-antlers.png`,
  "\u795e\u6237\u80dc\u5229\u8239": `${J_LEAGUE_LOGO_BASE}/vissel-kobe.png`,
  "\u753a\u7530\u6cfd\u7ef4\u4e9a": `${J_LEAGUE_LOGO_BASE}/machida-zelvia.png`,
  "\u540d\u53e4\u5c4b\u9cb8\u516b": `${J_LEAGUE_LOGO_BASE}/nagoya-grampus.png`,
  "\u540d\u53e4\u5c4b\u9cb8": `${J_LEAGUE_LOGO_BASE}/nagoya-grampus.png`,
  "\u6d66\u548c\u7ea2\u94bb": `${J_LEAGUE_LOGO_BASE}/urawa-red-diamonds.png`,
  "\u5188\u5c71\u7eff\u96c9": `${J_LEAGUE_LOGO_BASE}/fagiano-okayama.png`,
  "\u6a2a\u6ee8\u6c34\u624b": `${J_LEAGUE_LOGO_BASE}/yokohama-f-marinos.png`,
  "\u6e05\u6c34\u9f13\u52a8": `${J_LEAGUE_LOGO_BASE}/shimizu-s-pulse.png`,
  "\u67cf\u592a\u9633\u795e": `${J_LEAGUE_LOGO_BASE}/kashiwa-reysol.png`,
  "\u4eac\u90fd\u4e0d\u6b7b\u9e1f": `${J_LEAGUE_LOGO_BASE}/kyoto-sanga.png`,
  "\u5ddd\u5d0e\u524d\u950b": `${J_LEAGUE_LOGO_BASE}/kawasaki-frontale.png`,
  "\u5e7f\u5c9b\u4e09\u7bad": `${J_LEAGUE_LOGO_BASE}/sanfrecce-hiroshima.png`,
  "FC\u4e1c\u4eac": `${J_LEAGUE_LOGO_BASE}/fc-tokyo.png`,
  "\u4e1c\u4eacFC": `${J_LEAGUE_LOGO_BASE}/fc-tokyo.png`,
  "\u4e1c\u4eac\u7eff\u8335": `${J_LEAGUE_LOGO_BASE}/tokyo-verdy.png`,
  "\u6a2a\u6ee8FC": `${J_LEAGUE_LOGO_BASE}/yokohama-fc.png`,
  "\u6e58\u5357\u6d77\u6d0b": `${J_LEAGUE_LOGO_BASE}/shonan-bellmare.png`,
  "\u5927\u962a\u94a2\u5df4": `${J_LEAGUE_LOGO_BASE}/gamba-osaka.png`,
  "\u5927\u962a\u98de\u811a": `${J_LEAGUE_LOGO_BASE}/gamba-osaka.png`,
  "\u5927\u962a\u6a31\u82b1": `${J_LEAGUE_LOGO_BASE}/cerezo-osaka.png`,
  "\u798f\u5188\u9ec4\u8702": `${J_LEAGUE_LOGO_BASE}/avispa-fukuoka.png`,
  "\u65b0\u6cfb\u5929\u9e45": `${J_LEAGUE_LOGO_BASE}/albirex-niigata.png`,
  "\u5317\u6d77\u9053\u672d\u5e4c\u5188\u8428\u591a": `${J_LEAGUE_LOGO_BASE}/consadole-sapporo.png`,
  "\u672d\u5e4c\u5188\u8428\u591a": `${J_LEAGUE_LOGO_BASE}/consadole-sapporo.png`,
  "\u78d0\u7530\u559c\u60a6": `${J_LEAGUE_LOGO_BASE}/jubilo-iwata.png`,
  "\u9e1f\u6816\u6c99\u5ca9": `${J_LEAGUE_LOGO_BASE}/sagan-tosu.png`,
  "\u9e1f\u6816\u7802\u5ca9": `${J_LEAGUE_LOGO_BASE}/sagan-tosu.png`,
  "曼彻斯特城": "https://media.api-sports.io/football/teams/50.png",
  "曼城": "https://media.api-sports.io/football/teams/50.png",
  "利物浦": "https://media.api-sports.io/football/teams/40.png",
  "阿森纳": "https://media.api-sports.io/football/teams/42.png",
  "切尔西": "https://media.api-sports.io/football/teams/49.png",
  "曼彻斯特联": "https://media.api-sports.io/football/teams/33.png",
  "曼联": "https://media.api-sports.io/football/teams/33.png",
  "托特纳姆热刺": "https://media.api-sports.io/football/teams/47.png",
  "热刺": "https://media.api-sports.io/football/teams/47.png",
  "水晶宫": "https://media.api-sports.io/football/teams/52.png",
  "阿斯顿维拉": "https://media.api-sports.io/football/teams/66.png",
  "皇家马德里": "https://media.api-sports.io/football/teams/541.png",
  "皇马": "https://media.api-sports.io/football/teams/541.png",
  "巴塞罗那": "https://media.api-sports.io/football/teams/529.png",
  "巴萨": "https://media.api-sports.io/football/teams/529.png",
  "马德里竞技": "https://media.api-sports.io/football/teams/530.png",
  "马竞": "https://media.api-sports.io/football/teams/530.png",
  "皇家社会": "https://media.api-sports.io/football/teams/548.png",
  "拜仁慕尼黑": "https://media.api-sports.io/football/teams/157.png",
  "拜仁": "https://media.api-sports.io/football/teams/157.png",
  "多特蒙德": "https://media.api-sports.io/football/teams/165.png",
  "多特": "https://media.api-sports.io/football/teams/165.png",
  "勒沃库森": "https://media.api-sports.io/football/teams/168.png",
  "国际米兰": "https://media.api-sports.io/football/teams/505.png",
  "国米": "https://media.api-sports.io/football/teams/505.png",
  "AC米兰": "https://media.api-sports.io/football/teams/489.png",
  "尤文图斯": "https://media.api-sports.io/football/teams/496.png",
  "尤文": "https://media.api-sports.io/football/teams/496.png",
};

function isoFromTeam(teamName, teamCode) {
  return FIFA_TO_ISO[normText(teamCode).toUpperCase()] || TEAM_NAME_TO_ISO[normText(teamName)] || "";
}

function flagImageFromIso(isoCode) {
  const code = normText(isoCode).toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{3})?$/.test(code)) return "";
  return `https://flagcdn.com/w80/${code}.png`;
}

function normalizeLogoUrl(rawLogo) {
  const logo = normText(rawLogo);
  if (!logo) return "";
  if (/^https?:\/\//i.test(logo)) return logo;
  if (logo.startsWith("//")) return `https:${logo}`;
  if (logo.startsWith("/")) return `${SPORTTERY_BASE}${logo}`;
  return logo;
}

function teamLogoInfo(teamName, teamCode, rawLogo) {
  const suppliedLogo = normalizeLogoUrl(rawLogo);
  if (suppliedLogo) return { logo: suppliedLogo, logoType: "crest" };

  const isoCode = isoFromTeam(teamName, teamCode);
  if (isoCode) {
    return {
      logo: flagImageFromIso(isoCode) || flagEmojiFromIso(isoCode),
      logoType: "flag",
      countryIso: isoCode,
    };
  }

  const clubLogo = CLUB_LOGO_BY_NAME[normText(teamName)];
  if (clubLogo) return { logo: clubLogo, logoType: "crest" };

  // Never manufacture a crest from a club name or abbreviation. The UI renders
  // a neutral shield until an audited image source is available.
  return { logo: "", logoType: "crest-placeholder" };
}

function parseKickoff(matchDate, matchTime) {
  const date = normText(matchDate);
  const time = normText(matchTime);
  if (!date) return new Date().toISOString();
  const hhmm = /^\d{2}:\d{2}$/.test(time)
    ? `${time}:00`
    : /^\d{2}:\d{2}:\d{2}$/.test(time)
      ? time
      : "00:00:00";
  return `${date}T${hhmm}+08:00`;
}

const SPORTTERY_WEEKDAY_INDEX = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6
};

function beijingDateOffset(ymd, offsetDays) {
  const baseMs = Date.parse(`${ymd}T00:00:00+08:00`);
  if (!Number.isFinite(baseMs)) return "";
  return new Date(baseMs + offsetDays * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function beijingWeekday(ymd) {
  const baseMs = Date.parse(`${ymd}T00:00:00+08:00`);
  if (!Number.isFinite(baseMs)) return null;
  return new Date(baseMs + 8 * 60 * 60 * 1000).getUTCDay();
}

function inferSportteryBusinessDate(matchNo, kickoffDate) {
  const rawMatchNo = normText(matchNo);
  const ymd = normText(kickoffDate);
  if (!rawMatchNo || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";

  const weekdayMatch = rawMatchNo.match(/周([日天一二三四五六])/);
  const targetWeekday = weekdayMatch ? SPORTTERY_WEEKDAY_INDEX[weekdayMatch[1]] : undefined;
  if (targetWeekday === undefined) return "";

  for (let offset = 0; offset >= -6; offset -= 1) {
    const candidate = beijingDateOffset(ymd, offset);
    if (candidate && beijingWeekday(candidate) === targetWeekday) return candidate;
  }

  return "";
}

function beijingStartOfToday() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const ymd = beijing.toISOString().slice(0, 10);
  return Date.parse(`${ymd}T00:00:00+08:00`);
}

function inMatchWindow(match) {
  const t = Date.parse(match.kickoffTime);
  if (!Number.isFinite(t)) return true;
  const start = beijingStartOfToday() - WINDOW_BACK_DAYS * 24 * 60 * 60 * 1000;
  const end = beijingStartOfToday() + (WINDOW_FORWARD_DAYS + 1) * 24 * 60 * 60 * 1000;
  return t >= start && t < end;
}

function normalizeStatusWithScore(status, kickoffTime, scoreHome, scoreAway) {
  const hasScore = Number.isFinite(scoreHome) && Number.isFinite(scoreAway);
  if (status === "FINISHED") return status;
  if (status === "PENDING_RESULT") return hasScore ? "FINISHED" : status;
  const kickoffAt = Date.parse(kickoffTime);
  if (!Number.isFinite(kickoffAt) || !hasScore) return status;

  const elapsedMinutes = Math.floor((Date.now() - kickoffAt) / 60000);
  if (elapsedMinutes >= 125) return "FINISHED";
  if (elapsedMinutes >= 0) return "LIVE";
  return status;
}

function sanitizeOdds(raw) {
  const odds1 = toNum(raw?.odds1, null);
  const oddsX = toNum(raw?.oddsX, null);
  const odds2 = toNum(raw?.odds2, null);
  if (odds1 > 1.01 && oddsX > 1.01 && odds2 > 1.01) return { odds1, oddsX, odds2 };
  return null;
}

function sportteryPoolOdds(row, poolCode, sourceUrl, sourceMethod, sourceTiming = {}) {
  const rows = Array.isArray(row?.oddsList) ? row.oddsList : [];
  const code = String(poolCode).toUpperCase();
  const poolRow =
    rows.find((item) => String(item?.poolCode || "").toUpperCase() === code) ||
    row?.[code.toLowerCase()] ||
    (code === "HAD" && (row?.h || row?.d || row?.a) ? row : null);
  const odds = sanitizeOdds({
    odds1: poolRow?.h,
    oddsX: poolRow?.d,
    odds2: poolRow?.a,
  });

  if (!odds) return null;

  const updateDate = normText(poolRow?.updateDate);
  const updateTime = normText(poolRow?.updateTime);
  const providerObservedMs = updateDate && updateTime
    ? parseBeijingDateTime(`${updateDate} ${updateTime}`)
    : NaN;
  const oddsObservedAt = Number.isFinite(providerObservedMs)
    ? new Date(providerObservedMs).toISOString()
    : (validAuditInstant(sourceTiming?.providerObservedAt) || null);
  const oddsReceivedAt = validAuditInstant(sourceTiming?.receivedAt) || null;
  const rawHandicap = code === "HAD"
    ? "0"
    : (poolRow?.goalLine ?? poolRow?.goalLineValue ?? row?.hhad?.goalLine);
  const handicap = code === "HAD" ? "0" : normText(rawHandicap, "");
  if (code === "HHAD" && parseHandicapLine(rawHandicap) === null) return null;
  const marketExtraction = extractionFromSportteryPool({
    row,
    poolRow,
    poolCode: code,
    fallbackProviderObservedAt: sourceTiming?.providerObservedAt,
  });
  const marketProvenance = buildSportteryMarketSourceProvenance({
    poolCode: code,
    sourceMatchId: row?.matchId,
    odds,
    handicapLine: handicap,
    marketExtraction,
    sourceUrl,
    sourceMethod: "GET",
    providerObservedAt: oddsObservedAt,
    sourceTiming,
    trustRegistry: COLLECTOR_TRUST_REGISTRY,
  });
  return {
    odds,
    handicap,
    oddsSource: `sporttery:${code}`,
    oddsPoolCode: code,
    oddsSourceMethod: sourceMethod,
    oddsObservedAt,
    oddsReceivedAt,
    oddsUpdatedAt: [updateDate, updateTime].filter(Boolean).join(" ") || undefined,
    oddsSourceUrl: sourceUrl,
    marketProvenance,
  };
}

function sportteryOddsInfo(row, sourceUrl, sourceMethod, sourceTiming = {}) {
  return {
    had: sportteryPoolOdds(row, "HAD", sourceUrl, sourceMethod, sourceTiming),
    hhad: sportteryPoolOdds(row, "HHAD", sourceUrl, sourceMethod, sourceTiming),
  };
}

function impliedProbabilities(odds) {
  const inv1 = 1 / odds.odds1;
  const invX = 1 / odds.oddsX;
  const inv2 = 1 / odds.odds2;
  const total = inv1 + invX + inv2 || 1;
  return { home: inv1 / total, draw: invX / total, away: inv2 / total };
}

function pct(value) {
  return Math.round(value * 100);
}

function pct1(value) {
  return Number((clamp(value, 0, 1) * 100).toFixed(1));
}

function safeRatio(value, total) {
  const numerator = Number(value);
  const denominator = Number(total);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return clamp(numerator / denominator, 0, 1);
}

function poissonProbability(lambda, goals) {
  let factorial = 1;
  for (let i = 2; i <= goals; i += 1) factorial *= i;
  return (Math.exp(-lambda) * lambda ** goals) / factorial;
}

function projectedScore(homeLambda, awayLambda) {
  let best = { home: 0, away: 0, probability: 0 };
  for (let home = 0; home <= 5; home += 1) {
    for (let away = 0; away <= 5; away += 1) {
      const probability = poissonProbability(homeLambda, home) * poissonProbability(awayLambda, away);
      if (probability > best.probability) best = { home, away, probability };
    }
  }
  return best;
}

function scoreMatrix(homeLambda, awayLambda, maxGoals = 8) {
  const rows = [];
  for (let home = 0; home <= maxGoals; home += 1) {
    for (let away = 0; away <= maxGoals; away += 1) {
      rows.push({
        home,
        away,
        probability: poissonProbability(homeLambda, home) * poissonProbability(awayLambda, away),
      });
    }
  }
  return rows;
}

function representativeScoreRank(row, homeLambda, awayLambda, modeProbability, preferredCode, context = {}) {
  const totalLambda = homeLambda + awayLambda;
  const totalGoals = row.home + row.away;
  const over25Probability = Number(context.over25Probability);
  const bttsProbability = Number(context.bttsProbability);
  const scoreCalibration = context.scoreCalibration || null;
  const scoreAdjustments = scoreCalibration?.adjustments || {};
  const contextSignals = context.contextSignals || {};
  const attackIntentTotal = Number(contextSignals.attackIntent?.total);
  const redCardRisk = Number(contextSignals.discipline?.redCardRisk?.total);
  const rankingPressureMax = Number(contextSignals.rankingPressure?.maxPressure);
  const worldCupGroupContext = contextSignals.worldCupGroupContext || contextSignals.rankingPressure?.worldCupGroupContext || null;
  const groupEffects = worldCupGroupContext?.effects || {};
  const goalDiffPushSide = groupEffects.goalDiffPushSide || null;
  const marginPushSide = groupEffects.marginPushSide || goalDiffPushSide;
  const groupDrawBias = Number(groupEffects.drawBias || 0);
  const groupTotalIntentBoost = Number(groupEffects.totalIntentBoost || 0);
  const lambdaGap = Number(homeLambda) - Number(awayLambda);
  const lambdaGapAbs = Math.abs(lambdaGap);
  const probabilityScore = row.probability / Math.max(modeProbability, 0.000001);
  const lambdaCloseness = 1 - Math.min(1, (Math.abs(row.home - homeLambda) + Math.abs(row.away - awayLambda)) / 4);
  const totalCloseness = 1 - Math.min(1, Math.abs(totalGoals - totalLambda) / 3);
  const diffCloseness = 1 - Math.min(1, Math.abs((row.home - row.away) - (homeLambda - awayLambda)) / 3);
  let rank = probabilityScore * 0.52 + lambdaCloseness * 0.22 + totalCloseness * 0.16 + diffCloseness * 0.1;

  const preferredRankBoost = Number.isFinite(Number(context.preferredRankBoost))
    ? Number(context.preferredRankBoost)
    : 0.12;
  if (preferredCode && oneXTwoCodeForScore(row.home, row.away) === preferredCode) rank += preferredRankBoost;
  if (totalLambda >= 2.45 && totalGoals >= 3) rank += 0.08;
  if (totalLambda >= 2.75 && totalGoals >= 4) rank += 0.05;
  if (totalLambda <= 2.05 && totalGoals <= 2) rank += 0.05;
  if (totalLambda >= 2.45 && totalGoals <= 1) rank -= 0.22;
  if (totalLambda >= 2.15 && row.home === 0 && row.away === 0) rank -= 0.18;
  if (homeLambda >= 1.55 && row.home >= 2) rank += 0.05;
  if (awayLambda >= 1.55 && row.away >= 2) rank += 0.05;
  if (Number.isFinite(over25Probability)) {
    if (over25Probability >= 0.56 && totalGoals >= 3) rank += 0.16;
    else if (over25Probability >= 0.5 && totalGoals >= 3) rank += 0.09;
    if (over25Probability >= 0.5 && over25Probability <= 0.54 && totalGoals === 2) rank += 0.08;
    if (over25Probability >= 0.5 && over25Probability <= 0.54 && totalGoals >= 4) rank -= 0.07;
    if (over25Probability <= 0.46 && totalGoals <= 2) rank += 0.11;
    if (over25Probability <= 0.42 && totalGoals >= 4) rank -= 0.14;
  }
  if (Number.isFinite(bttsProbability)) {
    if (bttsProbability >= 0.52 && row.home > 0 && row.away > 0) rank += 0.14;
    if (bttsProbability >= 0.58 && (row.home === 0 || row.away === 0)) rank -= 0.08;
    if (bttsProbability <= 0.5 && row.home > 0 && row.away > 0) rank -= 0.07;
    if (bttsProbability <= 0.45 && (row.home === 0 || row.away === 0)) rank += 0.08;
  }
  if (lambdaGapAbs >= 0.38) {
    if (lambdaGap > 0) {
      if (row.home - row.away >= 2 && row.away === 0 && totalGoals <= 3) rank += Number.isFinite(bttsProbability) && bttsProbability <= 0.52 ? 0.16 : 0.07;
      if (row.away > 0 && Number.isFinite(bttsProbability) && bttsProbability <= 0.5) rank -= 0.06;
      if (lambdaGapAbs >= 0.62 && row.home >= 3 && row.away <= 1) rank += 0.06;
    } else {
      if (row.away - row.home >= 2 && row.home === 0 && totalGoals <= 3) rank += Number.isFinite(bttsProbability) && bttsProbability <= 0.52 ? 0.16 : 0.07;
      if (row.home > 0 && Number.isFinite(bttsProbability) && bttsProbability <= 0.5) rank -= 0.06;
      if (lambdaGapAbs >= 0.62 && row.away >= 3 && row.home <= 1) rank += 0.06;
    }
  }
  if (Number.isFinite(attackIntentTotal) && attackIntentTotal >= 68) {
    if (lambdaGap >= 0.18 && row.home === 3 && row.away === 1) rank += 0.14;
    if (lambdaGap <= -0.18 && row.home === 1 && row.away === 3) rank += 0.14;
    if (lambdaGapAbs <= 0.22 && row.home === 2 && row.away === 2) rank += 0.13;
  }
  if (Number.isFinite(bttsProbability) && bttsProbability <= 0.53 && lambdaGapAbs >= 0.42) {
    if (lambdaGap > 0 && row.home === 3 && row.away === 0) rank += 0.13;
    if (lambdaGap < 0 && row.home === 0 && row.away === 3) rank += 0.13;
    if (lambdaGap > 0 && row.home === 2 && row.away === 0) rank += 0.09;
    if (lambdaGap < 0 && row.home === 0 && row.away === 2) rank += 0.09;
  }
  if (lambdaGapAbs <= 0.18) {
    if (Number.isFinite(over25Probability) && over25Probability <= 0.54 && row.home === 1 && row.away === 1) rank += 0.13;
    if (Number.isFinite(bttsProbability) && bttsProbability >= 0.56 && row.home === 2 && row.away === 2) rank += 0.11;
    if (row.home === row.away && totalGoals >= 2) rank += Number.isFinite(bttsProbability) && bttsProbability >= 0.5 ? 0.09 : 0.04;
    if (Math.abs(row.home - row.away) >= 2) rank -= 0.07;
  }
  if (Number.isFinite(attackIntentTotal)) {
    if (attackIntentTotal >= 64 && totalGoals >= 3) rank += 0.08;
    if (attackIntentTotal >= 70 && row.home > 0 && row.away > 0) rank += 0.04;
    if (attackIntentTotal <= 42 && totalGoals <= 2) rank += 0.08;
    if (attackIntentTotal <= 42 && totalGoals >= 4) rank -= 0.12;
  }
  if (Number.isFinite(redCardRisk) && redCardRisk >= 0.16) {
    if (Math.abs(row.home - row.away) <= 1 && totalGoals <= 3) rank += 0.035;
    if (totalGoals >= 5) rank -= 0.055;
  }
  if (Number.isFinite(rankingPressureMax) && rankingPressureMax >= 70) {
    if (totalGoals >= 2 && Math.abs(row.home - row.away) <= 2) rank += 0.025;
  }
  if (worldCupGroupContext?.sameGroup) {
    if (goalDiffPushSide === "home" && row.home > 0) rank += 0.025;
    if (goalDiffPushSide === "away" && row.away > 0) rank += 0.025;
    if (marginPushSide === "home") {
      if (row.home - row.away >= 2) rank += 0.1;
      if (row.home - row.away >= 3) rank += 0.045;
      if (row.home <= row.away) rank -= 0.055;
    } else if (marginPushSide === "away") {
      if (row.away - row.home >= 2) rank += 0.1;
      if (row.away - row.home >= 3) rank += 0.045;
      if (row.away <= row.home) rank -= 0.055;
    }
    if (Number.isFinite(groupDrawBias)) {
      if (groupDrawBias >= 0.012 && row.home === row.away && totalGoals <= 4) rank += 0.055;
      if (groupDrawBias <= -0.012 && row.home === row.away) rank -= 0.075;
    }
    if (Number.isFinite(groupTotalIntentBoost) && groupTotalIntentBoost >= 5 && totalGoals >= 3) rank += 0.04;
  }
  const lowScorePenalty = Number(scoreAdjustments.lowScoreRankPenalty || 0);
  const openScoreBoost = Number(scoreAdjustments.openScoreRankBoost || 0);
  const bttsRankBoost = Number(scoreAdjustments.bttsRankBoost || 0);
  const bandRankBoost = Number(scoreAdjustments.bandRankBoosts?.[scoreTotalBand(row.home, row.away)] || 0);
  const shapeRankBoost = Number(scoreAdjustments.shapeRankBoosts?.[scoreShapeKey(row.home, row.away)] || 0);
  if (lowScorePenalty > 0 && totalGoals <= 2) rank -= lowScorePenalty;
  if (openScoreBoost > 0 && totalGoals >= 3) rank += openScoreBoost;
  if (bttsRankBoost > 0 && row.home > 0 && row.away > 0) rank += bttsRankBoost;
  if (Number.isFinite(bandRankBoost)) rank += bandRankBoost;
  if (Number.isFinite(shapeRankBoost)) rank += shapeRankBoost;

  return rank;
}

function representativeProjectedScore(homeLambda, awayLambda, preferredCode = null, context = {}) {
  const matrix = scoreMatrix(homeLambda, awayLambda, 8);
  const mode = matrix.reduce((best, row) => (row.probability > best.probability ? row : best), matrix[0]);
  const modeProbability = mode?.probability || 0.000001;
  const softOutcomeBinding = Boolean(context.softOutcomeBinding);
  let cleanPreferredCode = ["1", "X", "2"].includes(preferredCode) ? preferredCode : null;
  if (cleanPreferredCode) {
    const modeCode = oneXTwoCodeForScore(mode.home, mode.away);
    const directionalBest = matrix
      .filter((row) => oneXTwoCodeForScore(row.home, row.away) === cleanPreferredCode)
      .sort((a, b) => b.probability - a.probability)[0];
    const lambdaDiff = homeLambda - awayLambda;
    const conflictsWithLambda = (cleanPreferredCode === "1" && lambdaDiff < -0.18)
      || (cleanPreferredCode === "2" && lambdaDiff > 0.18);
    const supportThreshold = cleanPreferredCode === modeCode
      ? 0.38
      : conflictsWithLambda
        ? 0.82
        : 0.64;

    if (!directionalBest || directionalBest.probability < modeProbability * supportThreshold) {
      cleanPreferredCode = null;
    }
  }
  const directionalPool = cleanPreferredCode && !softOutcomeBinding
    ? matrix.filter((row) => oneXTwoCodeForScore(row.home, row.away) === cleanPreferredCode)
    : matrix;
  const minProbability = modeProbability * (cleanPreferredCode && !softOutcomeBinding ? 0.2 : 0.42);
  const plausible = directionalPool.filter((row) => (
    row.probability >= minProbability
    && row.home + row.away <= 7
  ));
  const pool = plausible.length ? plausible : directionalPool.length ? directionalPool : matrix;

  return [...pool].sort((a, b) => {
    const rankDiff = representativeScoreRank(b, homeLambda, awayLambda, modeProbability, cleanPreferredCode, context)
      - representativeScoreRank(a, homeLambda, awayLambda, modeProbability, cleanPreferredCode, context);
    if (Math.abs(rankDiff) > 0.000001) return rankDiff;
    return b.probability - a.probability;
  })[0] || projectedScore(homeLambda, awayLambda);
}

function poissonOutcomeProbabilities(homeLambda, awayLambda) {
  const matrix = scoreMatrix(homeLambda, awayLambda, 10);
  const totals = matrix.reduce((acc, row) => {
    if (row.home > row.away) acc.home += row.probability;
    else if (row.home === row.away) acc.draw += row.probability;
    else acc.away += row.probability;
    acc.mass += row.probability;
    return acc;
  }, { home: 0, draw: 0, away: 0, mass: 0 });
  const mass = totals.mass || 1;
  return {
    home: totals.home / mass,
    draw: totals.draw / mass,
    away: totals.away / mass,
  };
}

function topScoreProbabilities(homeLambda, awayLambda, limit = 5, context = {}) {
  const matrix = scoreMatrix(homeLambda, awayLambda, 8)
    .filter((row) => row.home + row.away <= 8);
  const mode = matrix.reduce((best, row) => (row.probability > best.probability ? row : best), matrix[0]);
  const modeProbability = mode?.probability || 0.000001;
  const ranked = matrix
    .map((row) => ({
      ...row,
      rank: representativeScoreRank(row, homeLambda, awayLambda, modeProbability, null, context),
    }))
    .sort((a, b) => {
      const rankDiff = b.rank - a.rank;
      if (Math.abs(rankDiff) > 0.000001) return rankDiff;
      return b.probability - a.probability;
    });
  const over25Probability = Number(context.over25Probability);
  const bttsProbability = Number(context.bttsProbability);
  const selected = [];
  const seen = new Set();
  const scoreKey = (row) => `${row.home}-${row.away}`;
  const addCandidate = (predicate, minRatio = 0.22) => {
    const candidate = ranked.find((row) => (
      !seen.has(scoreKey(row))
      && row.probability >= modeProbability * minRatio
      && predicate(row)
    ));
    if (candidate) {
      selected.push(candidate);
      seen.add(scoreKey(candidate));
    }
  };

  addCandidate(() => true, 0);
  if (Number.isFinite(over25Probability)) {
    if (over25Probability >= 0.5) addCandidate((row) => row.home + row.away >= 3, 0.18);
    if (over25Probability <= 0.49) addCandidate((row) => row.home + row.away <= 2, 0.18);
  }
  if (Number.isFinite(bttsProbability)) {
    if (bttsProbability >= 0.5) addCandidate((row) => row.home > 0 && row.away > 0, 0.18);
    if (bttsProbability <= 0.45) addCandidate((row) => row.home === 0 || row.away === 0, 0.18);
  }
  for (const code of ["1", "X", "2"]) {
    if (selected.length >= Math.max(3, limit)) break;
    addCandidate((row) => oneXTwoCodeForScore(row.home, row.away) === code, 0.24);
  }
  for (const row of ranked) {
    if (selected.length >= limit) break;
    if (seen.has(scoreKey(row))) continue;
    selected.push(row);
    seen.add(scoreKey(row));
  }

  return selected
    .slice(0, limit)
    .map((row) => ({
      home: row.home,
      away: row.away,
      label: `${row.home}-${row.away}`,
      probability: pct1(row.probability),
    }));
}

function parseHandicapLine(line) {
  if (typeof line === "number") return Number.isFinite(line) ? line : null;
  if (typeof line !== "string") return null;

  const normalized = line
    .trim()
    .replace(/\uFF0B/g, "+")
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, "-");
  const matched = normalized.match(/^(?:(?:\u8BA9\u7403|HHAD|handicap)\s*[:\uFF1A]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\u7403)?$/i);
  if (!matched) return null;

  const value = Number(matched[1]);
  return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
}

function hasExplicitHhadMarker(value) {
  if (!value || typeof value !== "object") return false;
  return [
    value.poolCode,
    value.oddsPoolCode,
    value.market,
    value.marketType,
    value.externalOddsPoolCode,
    value.handicapOddsPoolCode,
  ].some((marker) => String(marker || "").trim().toUpperCase() === "HHAD");
}

function externalHhadLineCandidates(match) {
  const externalSignals = match?.externalSignals;
  const bookmakerHhad = externalSignals?.bookmakerOdds?.hhad;
  const bookmakerLine = parseHandicapLine(bookmakerHhad?.handicapLine);
  if (bookmakerLine !== null) return [bookmakerHhad.handicapLine];

  const externalLine = parseHandicapLine(externalSignals?.handicapLine);
  if (externalLine === null) return [];
  const hasHhadTrace = Boolean(
    bookmakerHhad
    && typeof bookmakerHhad === "object"
    && (sanitizeOdds(bookmakerHhad) || hasExplicitHhadMarker(bookmakerHhad))
  ) || hasExplicitHhadMarker(externalSignals);
  return hasHhadTrace ? [externalSignals.handicapLine] : [];
}

function resolveHandicapLine(match, predictions = null) {
  const predictionRows = Array.isArray(predictions)
    ? predictions
    : predictions
      ? [predictions]
      : [];
  const storedPredictionRows = Array.isArray(match?.predictions)
    ? match.predictions.filter((prediction) => !predictionRows.includes(prediction))
    : [];
  const predictionLines = [...predictionRows, ...storedPredictionRows]
    .filter((prediction) => prediction?.oddsPoolCode === "HHAD")
    .map((prediction) => prediction.handicapLine);
  const candidates = [
    ...predictionLines,
    match?.handicapLine,
    ...externalHhadLineCandidates(match),
  ];

  for (const candidate of candidates) {
    const parsed = parseHandicapLine(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function sanitizeHandicapOdds(match) {
  if (parseHandicapLine(match?.handicapLine) === null) return null;
  return sanitizeOdds(match?.handicapOdds);
}

function formatHandicapLineForCopy(line) {
  const value = parseHandicapLine(line);
  if (value === null) return "";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const trimmed = Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/\.?0+$/, "");
  return `${value > 0 ? "+" : "-"}${trimmed}`;
}

function handicapOutcomeProbabilities(homeLambda, awayLambda, line) {
  const handicap = parseHandicapLine(line);
  if (handicap === null) return null;

  const matrix = scoreMatrix(homeLambda, awayLambda, 10);
  const totals = matrix.reduce((acc, row) => {
    const adjustedHome = row.home + handicap;
    if (adjustedHome > row.away) acc.home += row.probability;
    else if (adjustedHome === row.away) acc.draw += row.probability;
    else acc.away += row.probability;
    acc.mass += row.probability;
    return acc;
  }, { home: 0, draw: 0, away: 0, mass: 0 });
  const mass = totals.mass || 1;
  return {
    home: totals.home / mass,
    draw: totals.draw / mass,
    away: totals.away / mass,
  };
}

function scoreOutcomeWithHandicap(home, away, handicap) {
  const diff = home + handicap - away;
  if (Math.abs(diff) < 1e-9) return "X";
  return diff > 0 ? "1" : "2";
}

function alignedScoreForHandicapPick(homeLambda, awayLambda, line, code) {
  const handicap = parseHandicapLine(line);
  if (handicap === null || !["1", "X", "2"].includes(code)) return null;

  return scoreMatrix(homeLambda, awayLambda, 8)
    .filter((row) => scoreOutcomeWithHandicap(row.home, row.away, handicap) === code)
    .sort((a, b) => {
      const probabilityDiff = b.probability - a.probability;
      if (Math.abs(probabilityDiff) > 0.000001) return probabilityDiff;
      return (a.home + a.away) - (b.home + b.away);
    })[0] || null;
}

function alignLambdaToScore(currentLambda, goals, maxLambda) {
  return clamp(currentLambda * 0.25 + (goals + 0.35) * 0.75, 0.25, maxLambda);
}

function alignedHandicapForecast(homeLambda, awayLambda, line, code) {
  const score = alignedScoreForHandicapPick(homeLambda, awayLambda, line, code);
  if (!score) return null;

  return {
    score: {
      home: score.home,
      away: score.away
    },
    homeLambda: alignLambdaToScore(homeLambda, score.home, 5.2),
    awayLambda: alignLambdaToScore(awayLambda, score.away, 5.2)
  };
}

function normalizeOutcomeProbabilities(probabilities) {
  if (!probabilities) return null;
  const total = probabilities.home + probabilities.draw + probabilities.away || 1;
  return {
    home: probabilities.home / total,
    draw: probabilities.draw / total,
    away: probabilities.away / total,
  };
}

function formConfidence(formSnapshot) {
  const sampleSize = Number(formSnapshot?.sampleSize || 0);
  if (sampleSize <= 0) return 0;
  const homeSample = Number(formSnapshot?.home?.sampleSize);
  const awaySample = Number(formSnapshot?.away?.sampleSize);
  if (Number.isFinite(homeSample) && Number.isFinite(awaySample)) {
    // Recent form is a comparison, so one populated side cannot stand in for
    // two-team evidence. Weight by the smaller side instead of the combined
    // total to avoid treating an unknown opponent as a zero-goal team.
    return clamp(Math.min(homeSample, awaySample) / 12, 0, 1);
  }
  return clamp(sampleSize / 24, 0, 1);
}

function recentFormNumber(value, fallback) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function recentFormCandidate(form, marketHomeLambda, marketAwayLambda, confidence, source) {
  if (!form?.home || !form?.away || confidence <= 0) return null;

  const homeAttack = recentFormNumber(form.home.goalsForAvg, marketHomeLambda);
  const homeDefense = recentFormNumber(form.home.goalsAgainstAvg, marketAwayLambda);
  const awayAttack = recentFormNumber(form.away.goalsForAvg, marketAwayLambda);
  const awayDefense = recentFormNumber(form.away.goalsAgainstAvg, marketHomeLambda);

  return {
    homeLambda: clamp(homeAttack * 0.58 + awayDefense * 0.42, 0.25, 3.6),
    awayLambda: clamp(awayAttack * 0.58 + homeDefense * 0.42, 0.25, 3.6),
    confidence,
    source,
    fallbackMetrics: ["home.goalsForAvg", "home.goalsAgainstAvg", "away.goalsForAvg", "away.goalsAgainstAvg"]
      .filter(key => { const [side, metric] = key.split("."); return recentFormNumber(form[side][metric], null) === null; }),
  };
}

function fiveHundredRecentFormSnapshot(match) {
  const recentForm = match?.externalSignals?.fiveHundred?.recentForm;
  if (!recentForm?.home || !recentForm?.away) return null;

  const homeSample = Number(recentForm.home.sampleSize || 0);
  const awaySample = Number(recentForm.away.sampleSize || 0);
  const pairedSample = Math.min(homeSample, awaySample);
  if (!Number.isFinite(pairedSample) || pairedSample <= 0) return null;

  return {
    home: recentForm.home,
    away: recentForm.away,
    sampleSize: pairedSample,
    confidence: clamp(pairedSample / 12, 0, 1),
  };
}

function blendLambdasWithForm(match, marketHomeLambda, marketAwayLambda) {
  const trainingCandidate = recentFormCandidate(
    match.formSnapshot,
    marketHomeLambda,
    marketAwayLambda,
    formConfidence(match.formSnapshot),
    "training-history"
  );
  const fiveHundredForm = fiveHundredRecentFormSnapshot(match);
  const fiveHundredCandidate = recentFormCandidate(
    fiveHundredForm,
    marketHomeLambda,
    marketAwayLambda,
    fiveHundredForm?.confidence || 0,
    "500-recent-form"
  );
  const candidates = [trainingCandidate, fiveHundredCandidate].filter(Boolean);

  if (!candidates.length) {
    return {
      homeLambda: marketHomeLambda,
      awayLambda: marketAwayLambda,
      formWeight: 0,
      formHomeLambda: null,
      formAwayLambda: null,
      formUsage: require("../src/services/modelInputUsage.cjs").recordModelInputUsage(match, "form-lambda-blend", {
        before: { home: marketHomeLambda, away: marketAwayLambda }, candidates: [], weight: 0,
        output: { home: marketHomeLambda, away: marketAwayLambda },
      }),
    };
  }

  const confidenceTotal = candidates.reduce((sum, item) => sum + item.confidence, 0) || 1;
  const formHomeLambda = clamp(
    candidates.reduce((sum, item) => sum + item.homeLambda * item.confidence, 0) / confidenceTotal,
    0.25,
    3.6
  );
  const formAwayLambda = clamp(
    candidates.reduce((sum, item) => sum + item.awayLambda * item.confidence, 0) / confidenceTotal,
    0.25,
    3.6
  );
  const profile = matchVolatilityProfile(match);
  const maxWeight = profile.isInternational ? 0.34 : 0.42;
  const strongestConfidence = Math.max(...candidates.map((item) => item.confidence));
  const formWeight = clamp(strongestConfidence * maxWeight, 0, maxWeight);
  const formOutput = {
    home: clamp(marketHomeLambda * (1 - formWeight) + formHomeLambda * formWeight, 0.25, 3.4),
    away: clamp(marketAwayLambda * (1 - formWeight) + formAwayLambda * formWeight, 0.25, 3.4),
  };

  return {
    homeLambda: formOutput.home,
    awayLambda: formOutput.away,
    formUsage: require("../src/services/modelInputUsage.cjs").recordModelInputUsage(match, "form-lambda-blend", {
      before: { home: marketHomeLambda, away: marketAwayLambda }, candidates, weight: formWeight, output: formOutput,
    }),
    formWeight: Number(formWeight.toFixed(3)),
    formHomeLambda: Number(formHomeLambda.toFixed(2)),
    formAwayLambda: Number(formAwayLambda.toFixed(2)),
    formSource: candidates.map((item) => item.source).join("+"),
  };
}

function blendLambdasWithLeaguePrior(match, marketHomeLambda, marketAwayLambda) {
  const prior = match.leaguePrior;
  const matches = Number(prior?.matches || 0);
  if (!prior || matches < 120) {
    return {
      homeLambda: marketHomeLambda,
      awayLambda: marketAwayLambda,
      leagueWeight: 0,
      leagueHomeLambda: null,
      leagueAwayLambda: null,
      leaguePriorKey: null,
    };
  }

  const priorHome = Number(prior.homeGoalsAvg);
  const priorAway = Number(prior.awayGoalsAvg);
  if (!Number.isFinite(priorHome) || !Number.isFinite(priorAway)) {
    return {
      homeLambda: marketHomeLambda,
      awayLambda: marketAwayLambda,
      leagueWeight: 0,
      leagueHomeLambda: null,
      leagueAwayLambda: null,
      leaguePriorKey: null,
    };
  }

  const sourceWeight = prior.source === "historical-global-prior" ? 0.08 : 0.16;
  const sampleWeight = clamp(Math.log10(matches) / 4, 0.08, sourceWeight);
  return {
    homeLambda: clamp(marketHomeLambda * (1 - sampleWeight) + priorHome * sampleWeight, 0.25, 3.4),
    awayLambda: clamp(marketAwayLambda * (1 - sampleWeight) + priorAway * sampleWeight, 0.25, 3.4),
    leagueWeight: Number(sampleWeight.toFixed(3)),
    leagueHomeLambda: Number(priorHome.toFixed(2)),
    leagueAwayLambda: Number(priorAway.toFixed(2)),
    leaguePriorKey: prior.key || prior.source || "historical-prior",
  };
}

function independentBaseLambdas(match, probabilities) {
  const profile = matchVolatilityProfile(match);
  const strengthEdge = clamp(Number(probabilities.home || 0) - Number(probabilities.away || 0), -0.62, 0.62);
  const drawPressure = clamp(Number(probabilities.draw || 0), 0.16, 0.34);
  const baseTotal = profile.isInternational ? 2.34 : 2.52;
  const totalLambda = clamp(
    baseTotal
      + Math.abs(strengthEdge) * 0.46
      + (0.26 - drawPressure) * 0.38,
    1.62,
    3.28
  );
  const homeShare = clamp(
    0.5 + strengthEdge * 0.58 + (
      teamModelStrengthHasEvidence(match, "home") || teamModelStrengthHasEvidence(match, "away")
        ? (profile.isInternational ? 0.008 : 0.035)
        : 0
    ),
    0.22,
    0.78
  );

  return {
    homeLambda: clamp(totalLambda * homeShare, 0.28, 3.2),
    awayLambda: clamp(totalLambda * (1 - homeShare), 0.28, 3.2),
    totalLambda: Number(totalLambda.toFixed(2)),
    homeShare: Number(homeShare.toFixed(3)),
  };
}

function scoreCalibrationForMatch(match) {
  return match?.modelCalibration?.scoreCalibration || null;
}

function applyScoreCalibrationToLambdas(match, homeLambda, awayLambda) {
  const calibration = scoreCalibrationForMatch(match);
  const adjustment = Number(calibration?.adjustments?.totalLambdaAdjustment || 0);
  if (!Number.isFinite(adjustment) || Math.abs(adjustment) < 0.001) {
    return {
      homeLambda,
      awayLambda,
      applied: false,
      totalLambdaAdjustment: 0,
      version: calibration?.version || null,
    };
  }

  const total = Math.max(0.1, homeLambda + awayLambda);
  const homeShare = clamp(homeLambda / total, 0.22, 0.78);
  return {
    homeLambda: clamp(homeLambda + adjustment * homeShare, 0.25, 3.6),
    awayLambda: clamp(awayLambda + adjustment * (1 - homeShare), 0.25, 3.6),
    applied: true,
    totalLambdaAdjustment: Number(adjustment.toFixed(3)),
    version: calibration?.version || null,
  };
}

function outcomeLeadStats(probabilities) {
  const normalized = normalizeOutcomeProbabilities(probabilities);
  const ranked = [
    { code: "1", key: "home", probability: Number(normalized?.home || 0) },
    { code: "X", key: "draw", probability: Number(normalized?.draw || 0) },
    { code: "2", key: "away", probability: Number(normalized?.away || 0) },
  ].sort((a, b) => b.probability - a.probability);
  return {
    leader: ranked[0],
    runnerUp: ranked[1],
    gap: Math.max(0, Number(ranked[0]?.probability || 0) - Number(ranked[1]?.probability || 0)),
  };
}

function scoreImpliedOutcomeFromMatrix(homeLambda, awayLambda, context, outcomeCodeForRow) {
  const matrix = scoreMatrix(homeLambda, awayLambda, 8)
    .filter((row) => row.home + row.away <= 8);
  const mode = matrix.reduce((best, row) => (row.probability > best.probability ? row : best), matrix[0]);
  const modeProbability = mode?.probability || 0.000001;
  const totals = matrix.reduce((acc, row) => {
    const rank = representativeScoreRank(row, homeLambda, awayLambda, modeProbability, null, context);
    const rankFactor = clamp(0.55 + Math.max(0, rank) * 0.75, 0.25, 1.9);
    const weightedProbability = row.probability * rankFactor;
    const code = outcomeCodeForRow(row);
    if (code === "1") acc.home += weightedProbability;
    else if (code === "X") acc.draw += weightedProbability;
    else if (code === "2") acc.away += weightedProbability;
    acc.mass += weightedProbability;
    return acc;
  }, { home: 0, draw: 0, away: 0, mass: 0 });
  const mass = totals.mass || 1;
  return normalizeOutcomeProbabilities({
    home: totals.home / mass,
    draw: totals.draw / mass,
    away: totals.away / mass,
  });
}

function scoreImpliedOutcomeProbabilities(homeLambda, awayLambda, context = {}) {
  return scoreImpliedOutcomeFromMatrix(
    homeLambda,
    awayLambda,
    context,
    (row) => oneXTwoCodeForScore(row.home, row.away)
  );
}

function scoreImpliedHandicapProbabilities(homeLambda, awayLambda, line, context = {}) {
  const handicap = parseHandicapLine(line);
  if (handicap === null) return null;
  return scoreImpliedOutcomeFromMatrix(
    homeLambda,
    awayLambda,
    context,
    (row) => scoreOutcomeWithHandicap(row.home, row.away, handicap)
  );
}

function applyScoreOutcomeFeedback(match, probabilities, scoreImplied) {
  const before = normalizeOutcomeProbabilities(probabilities);
  const score = normalizeOutcomeProbabilities(scoreImplied);
  if (!before || !score) {
    return {
      probabilities: before,
      applied: false,
      weight: 0,
      reasons: [],
      before,
      scoreImplied: score,
      after: before,
    };
  }

  const profile = matchVolatilityProfile(match);
  const modelStats = outcomeLeadStats(before);
  const scoreStats = outcomeLeadStats(score);
  const disagree = modelStats.leader?.code && scoreStats.leader?.code && modelStats.leader.code !== scoreStats.leader.code;
  const reasons = ["score-outcome-mutual-feedback"];
  let weight = 0.12;

  if (scoreStats.gap >= 0.08) {
    weight += 0.03;
    reasons.push("score-leader-clear");
  }
  if (disagree) {
    reasons.push("score-model-direction-disagreement");
    weight += modelStats.gap <= 0.08 ? 0.06 : -0.03;
    if (scoreStats.gap >= modelStats.gap + 0.025) weight += 0.03;
  } else {
    reasons.push("score-model-direction-aligned");
  }
  if (profile.isInternational) {
    weight -= 0.02;
    reasons.push("international-score-noise-cap");
  }
  const scoreCalibration = scoreCalibrationForMatch(match);
  const scoreCalibrationRows = Number(scoreCalibration?.sample?.rows || scoreCalibration?.summary?.rows || 0);
  const scoreCalibrationMatchDays = Number(scoreCalibration?.sample?.independentMatchDays || 0);
  const scoreCalibrationSampleReady = scoreCalibrationRows >= SAFE_AUTO_TUNING_MIN_ROWS
    && scoreCalibrationMatchDays >= SAFE_AUTO_TUNING_MIN_MATCH_DAYS;
  const top3OutcomeHitRate = Number(scoreCalibration?.sample?.top3OutcomeHitRate);
  const top3TotalBandHitRate = Number(scoreCalibration?.sample?.top3TotalBandHitRate);
  if (scoreCalibrationSampleReady) {
    weight += 0.02;
    reasons.push("recent-score-calibration-sample");
  }
  if (scoreCalibrationSampleReady && Number.isFinite(top3OutcomeHitRate) && top3OutcomeHitRate >= 0.72) {
    weight += 0.025;
    reasons.push("score-top3-outcome-reliable");
  }
  if (scoreCalibrationSampleReady && Number.isFinite(top3TotalBandHitRate) && top3TotalBandHitRate < 0.45) {
    weight -= 0.02;
    reasons.push("score-total-band-low-hit-rate");
  }

  weight = clamp(weight, 0.08, 0.24);
  let after = normalizeOutcomeProbabilities({
    home: before.home * (1 - weight) + score.home * weight,
    draw: before.draw * (1 - weight) + score.draw * weight,
    away: before.away * (1 - weight) + score.away * weight,
  });
  const afterStats = outcomeLeadStats(after);

  if (
    afterStats.leader?.code !== modelStats.leader?.code
    && (
      scoreStats.gap < 0.07
      || modelStats.gap > scoreStats.gap + 0.05
    )
  ) {
    after = preserveOutcomeLeader(after, modelStats.leader.code, 0.003);
    reasons.push("score-feedback-leader-guard");
  }

  return {
    probabilities: after,
    applied: true,
    weight: Number(weight.toFixed(3)),
    reasons,
    before,
    scoreImplied: score,
    after,
    leaders: {
      before: modelStats.leader?.code || null,
      score: scoreStats.leader?.code || null,
      after: outcomeLeadStats(after).leader?.code || null,
    },
  };
}

function blendOutcomeProbabilities(match, market, poisson, eloSnapshot, formSnapshot) {
  const teamStrength = syntheticModelOnlyProbabilities(match);
  const elo = normalizeOutcomeProbabilities(eloSnapshot?.probabilities);
  const eloSample = (eloSnapshot?.homeMatches || 0) + (eloSnapshot?.awayMatches || 0);
  const formSample = Number(formSnapshot?.sampleSize || 0);
  const pairedFormConfidence = formConfidence(formSnapshot);
  const worldCupPrior = worldCupPriorOutcomeProbabilities(match);
  const formReady = formSample >= 8 && pairedFormConfidence >= 0.25;
  // Market is one evidence family, not a direction override. Keep a stable
  // market anchor in every data regime while letting Elo, team strength and
  // the form/context-aware Poisson layer take the majority of the blend when
  // auditable samples are available. No branch is selected by SP level.
  let weights = elo && eloSample >= 6 && formReady
    ? { market: 0.1, teamStrength: 0.15, elo: 0.3, poisson: 0.45 }
    : elo && eloSample >= 6
      ? { market: 0.12, teamStrength: 0.18, elo: 0.35, poisson: 0.35 }
      : formReady
        ? { market: 0.12, teamStrength: 0.24, elo: 0, poisson: 0.64 }
        : { market: 0.15, teamStrength: 0.35, elo: 0, poisson: 0.5 };
  const worldCupPriorWeight = worldCupPrior
    ? 0.18
    : 0;
  if (worldCupPriorWeight > 0) {
    weights = {
      market: Number((weights.market * (1 - worldCupPriorWeight)).toFixed(3)),
      teamStrength: Number((weights.teamStrength * (1 - worldCupPriorWeight)).toFixed(3)),
      elo: Number((weights.elo * (1 - worldCupPriorWeight)).toFixed(3)),
      poisson: Number((weights.poisson * (1 - worldCupPriorWeight)).toFixed(3)),
      worldCupPrior: worldCupPriorWeight,
    };
  }
  const blended = {
    home: market.home * weights.market + teamStrength.home * weights.teamStrength + (elo?.home || 0) * weights.elo + poisson.home * weights.poisson + (worldCupPrior?.home || 0) * (weights.worldCupPrior || 0),
    draw: market.draw * weights.market + teamStrength.draw * weights.teamStrength + (elo?.draw || 0) * weights.elo + poisson.draw * weights.poisson + (worldCupPrior?.draw || 0) * (weights.worldCupPrior || 0),
    away: market.away * weights.market + teamStrength.away * weights.teamStrength + (elo?.away || 0) * weights.elo + poisson.away * weights.poisson + (worldCupPrior?.away || 0) * (weights.worldCupPrior || 0),
  };
  const total = blended.home + blended.draw + blended.away || 1;
  const blendOutput = { home: blended.home / total, draw: blended.draw / total, away: blended.away / total };
  return {
    probabilities: blendOutput,
    usage: require("../src/services/modelInputUsage.cjs").recordModelInputUsage(match, "base-outcome-blend", {
      inputs: { market, teamStrength, elo, poisson, worldCupPrior },
      weights: { ...weights, worldCupPrior: weights.worldCupPrior || 0 }, output: blendOutput,
      marketPool: sanitizeOdds(match.odds) ? "HAD" : sanitizeHandicapOdds(match) ? "HHAD" : null,
      marketSource: sanitizeOdds(match.odds) ? match.oddsSource || null : sanitizeHandicapOdds(match) ? match.handicapOddsSource || null : null,
    }),
    weights,
    teamStrength,
  };
}

function outcomeLeader(probabilities) {
  return [
    { code: "1", probability: probabilities.home },
    { code: "X", probability: probabilities.draw },
    { code: "2", probability: probabilities.away },
  ].sort((a, b) => b.probability - a.probability)[0];
}

function outcomeKeyForCode(code) {
  if (code === "1") return "home";
  if (code === "X") return "draw";
  if (code === "2") return "away";
  return null;
}

function preserveOutcomeLeader(probabilities, code, minGap = 0.006) {
  const key = outcomeKeyForCode(code);
  const normalized = normalizeOutcomeProbabilities(probabilities);
  if (!key) return normalized;

  const otherKeys = ["home", "draw", "away"].filter((item) => item !== key);
  const maxOther = Math.max(...otherKeys.map((item) => Number(normalized[item] || 0)));
  if (Number(normalized[key] || 0) >= maxOther + minGap) return normalized;

  const target = clamp(maxOther + minGap, 0.08, 0.82);
  const otherTotal = otherKeys.reduce((sum, item) => sum + Number(normalized[item] || 0), 0) || 1;
  const remaining = Math.max(0.02, 1 - target);
  return normalizeOutcomeProbabilities({
    ...normalized,
    [key]: target,
    [otherKeys[0]]: remaining * (Number(normalized[otherKeys[0]] || 0) / otherTotal),
    [otherKeys[1]]: remaining * (Number(normalized[otherKeys[1]] || 0) / otherTotal),
  });
}

function redistributeOutcomePenalty(probabilities, code, penalty) {
  const adjusted = { ...probabilities };
  const safePenalty = clamp(penalty, 0, Math.max(0, adjusted[code === "1" ? "home" : code === "X" ? "draw" : "away"] - 0.05));
  if (safePenalty <= 0) return adjusted;

  if (code === "1") {
    adjusted.home -= safePenalty;
    adjusted.draw += safePenalty * 0.55;
    adjusted.away += safePenalty * 0.45;
  } else if (code === "2") {
    adjusted.away -= safePenalty;
    adjusted.draw += safePenalty * 0.55;
    adjusted.home += safePenalty * 0.45;
  } else {
    adjusted.draw -= safePenalty;
    adjusted.home += safePenalty * 0.5;
    adjusted.away += safePenalty * 0.5;
  }

  return normalizeOutcomeProbabilities(adjusted);
}

function calibrateOutcomeProbabilities(match, probabilities, marketProbabilities) {
  let adjusted = normalizeOutcomeProbabilities(probabilities);
  const reasons = [];
  const adjustments = [];
  const profile = matchVolatilityProfile(match);
  const profileKey = predictionProfileKey(match);
  const health = match.predictionHealth;
  const marketLeader = outcomeLeader(marketProbabilities);
  const modelLeader = outcomeLeader(adjusted);
  const preCalibrationLeader = modelLeader;
  const homeFavoriteBucket = health?.homeFavorite;
  const oneXTwoBucket = health?.byMarket?.["1X2"];
  const modelTipBucket = health?.oneXTwo?.byTip?.[modelLeader.code];
  const profileBucket = health?.oneXTwo?.byProfile?.[profileKey];
  const marketLeaderOdds = Number(match.odds?.[`odds${marketLeader.code}`]);
  const marketLeaderOddsBucket = predictionOddsBucket(marketLeaderOdds);
  const oddsBucket = health?.oneXTwo?.byOddsBucket?.[marketLeaderOddsBucket];
  const lowSpSideBucket = health?.oneXTwo?.lowSpSide;
  const profileMarketBucket = health?.byMarketProfile?.[`1X2:${profileKey}`];

  const applyPenalty = (code, penalty, reason) => {
    const before = adjusted[code === "1" ? "home" : code === "X" ? "draw" : "away"];
    adjusted = redistributeOutcomePenalty(adjusted, code, penalty);
    const after = adjusted[code === "1" ? "home" : code === "X" ? "draw" : "away"];
    if (after < before) {
      reasons.push(reason);
      adjustments.push({
        code,
        reason,
        penalty: Number((before - after).toFixed(3)),
      });
    }
  };

  if (isCoolingBucket(homeFavoriteBucket) && marketLeader.code === "1") {
    const missPressure = homeFavoriteBucket.hitRate === null ? 0.06 : clamp((0.45 - homeFavoriteBucket.hitRate) * 0.3, 0.025, 0.08);
    applyPenalty("1", missPressure, "home-favorite-hit-rate-cooldown");
  }

  if (isCoolingBucket(modelTipBucket) && modelLeader.code !== "X") {
    const missPressure = modelTipBucket.hitRate === null ? 0.035 : clamp((0.44 - modelTipBucket.hitRate) * 0.2, 0.018, 0.05);
    applyPenalty(modelLeader.code, missPressure, `tip-${modelLeader.code}-hit-rate-cooldown`);
  }

  if (isCoolingBucket(profileBucket) && modelLeader.code !== "X") {
    const missPressure = profileBucket.hitRate === null ? 0.025 : clamp((0.44 - profileBucket.hitRate) * 0.16, 0.015, 0.04);
    applyPenalty(modelLeader.code, missPressure, `${profileKey}-1x2-hit-rate-cooldown`);
  }

  if (isCoolingBucket(oddsBucket) && marketLeader.code !== "X") {
    const missPressure = oddsBucket.hitRate === null ? 0.025 : clamp((0.44 - oddsBucket.hitRate) * 0.16, 0.015, 0.04);
    applyPenalty(marketLeader.code, missPressure, `${marketLeaderOddsBucket}-hit-rate-cooldown`);
  }

  if (isCoolingBucket(lowSpSideBucket) && marketLeader.code !== "X" && marketLeaderOdds <= 1.7) {
    const missPressure = lowSpSideBucket.hitRate === null ? 0.025 : clamp((0.44 - lowSpSideBucket.hitRate) * 0.16, 0.015, 0.04);
    applyPenalty(marketLeader.code, missPressure, "low-sp-side-hit-rate-cooldown");
  }

  if (isCoolingBucket(oneXTwoBucket) && modelLeader.code !== "X") {
    const missPressure = oneXTwoBucket.hitRate === null ? 0.035 : clamp((0.45 - oneXTwoBucket.hitRate) * 0.22, 0.02, 0.055);
    applyPenalty(modelLeader.code, missPressure, "one-x-two-hit-rate-cooldown");
  }

  if (isCoolingBucket(profileMarketBucket) && marketLeader.code !== "X") {
    const missPressure = profileMarketBucket.hitRate === null ? 0.03 : clamp((0.45 - profileMarketBucket.hitRate) * 0.18, 0.02, 0.055);
    applyPenalty(marketLeader.code, missPressure, `${profileKey}-short-form-brake`);
  }

  if (profile.isInternational && marketLeader.code !== "X" && marketLeaderOdds <= 1.7) {
    applyPenalty(marketLeader.code, 0.05, "international-low-sp-shrink");
  }

  if (profile.isJapan && marketLeader.code !== "X" && marketLeaderOdds <= 2.05) {
    applyPenalty(marketLeader.code, 0.07, "jleague-favorite-shrink");
  }

  const postCalibrationLeader = outcomeLeader(adjusted);
  if (preCalibrationLeader?.code && postCalibrationLeader?.code && preCalibrationLeader.code !== postCalibrationLeader.code) {
    adjusted = preserveOutcomeLeader(adjusted, preCalibrationLeader.code);
    reasons.push("calibration-leader-preserved");
    adjustments.push({
      code: preCalibrationLeader.code,
      reason: "calibration-leader-preserved",
      penalty: 0,
    });
  }

  return {
    probabilities: normalizeOutcomeProbabilities(adjusted),
    applied: adjustments.length > 0,
    reasons,
    adjustments,
  };
}

function buildOutcomeCalibrationShadow(scoreOutcomeFeedback, activeCalibration) {
  const preCooldownProbabilities = normalizeOutcomeProbabilities(
    scoreOutcomeFeedback?.probabilities || activeCalibration?.probabilities || {}
  );
  const activeProbabilities = normalizeOutcomeProbabilities(
    activeCalibration?.probabilities || preCooldownProbabilities
  );
  const activeLeader = outcomeLeader(activeProbabilities)?.code || null;
  const shadowLeader = outcomeLeader(preCooldownProbabilities)?.code || null;
  const maxAbsoluteDelta = Math.max(
    ...["home", "draw", "away"].map((key) => (
      Math.abs(Number(preCooldownProbabilities[key] || 0) - Number(activeProbabilities[key] || 0))
    ))
  );

  return {
    version: "outcome-calibration-no-stacked-cooldown-shadow-v1",
    activation: "shadow-only",
    promotionEligible: false,
    formalOutputChanged: false,
    policy: "Keep score-distribution feedback, but skip every stacked outcome cooldown penalty; collect chronological evidence before activation.",
    probabilities: asPercentTriplet(preCooldownProbabilities),
    activeProbabilities: asPercentTriplet(activeProbabilities),
    activeLeader,
    shadowLeader,
    leaderWouldChange: Boolean(activeLeader && shadowLeader && activeLeader !== shadowLeader),
    maxAbsoluteDeltaPoints: Number((maxAbsoluteDelta * 100).toFixed(1)),
  };
}

function calibrateGoalProbabilities(match, over25Probability, bttsProbability) {
  const profile = matchVolatilityProfile(match);
  const goalsBucket = match.predictionHealth?.byMarket?.GOALS;
  const profileKey = predictionProfileKey(match);
  const profileBucket = match.predictionHealth?.goals?.byProfile?.[profileKey];
  const directionKey = over25Probability >= 0.5 ? "O2.5" : "U2.5";
  const directionBucket = match.predictionHealth?.goals?.byTip?.[directionKey];
  let over25 = over25Probability;
  let btts = bttsProbability;
  const reasons = [];
  let shrinkFactor = 1;

  if (isCoolingBucket(goalsBucket)) {
    shrinkFactor *= 0.55;
    reasons.push("goals-hit-rate-cooldown");
  }

  if (isCoolingBucket(directionBucket)) {
    shrinkFactor *= 0.76;
    reasons.push(`${directionKey}-hit-rate-cooldown`);
  }

  if (isCoolingBucket(profileBucket)) {
    shrinkFactor *= 0.8;
    reasons.push(`${profileKey}-goals-hit-rate-cooldown`);
  }

  if (profile.isInternational) {
    shrinkFactor *= 0.82;
    reasons.push("international-goal-volatility");
  }

  if (shrinkFactor < 1) {
    over25 = 0.5 + (over25 - 0.5) * shrinkFactor;
    btts = 0.5 + (btts - 0.5) * shrinkFactor;
  }

  const scoreCalibration = scoreCalibrationForMatch(match);
  const over25Shift = Number(scoreCalibration?.adjustments?.over25ProbabilityShift || 0);
  const bttsShift = Number(scoreCalibration?.adjustments?.bttsProbabilityShift || 0);
  if (Number.isFinite(over25Shift) && Math.abs(over25Shift) >= 0.001) {
    over25 = clamp(over25 + over25Shift, 0.05, 0.95);
    reasons.push("recent-score-total-calibration");
  }
  if (Number.isFinite(bttsShift) && Math.abs(bttsShift) >= 0.001) {
    btts = clamp(btts + bttsShift, 0.05, 0.95);
    reasons.push("recent-score-btts-calibration");
  }

  return {
    over25: clamp(over25, 0.05, 0.95),
    btts: clamp(btts, 0.05, 0.95),
    meta: {
      applied: shrinkFactor < 1,
      reasons,
      shrinkFactor: Number(shrinkFactor.toFixed(3)),
      before: {
        over25: pct1(over25Probability),
        btts: pct1(bttsProbability),
      },
      after: {
        over25: pct1(over25),
        btts: pct1(btts),
      },
    },
  };
}

function asPercentTriplet(probabilities) {
  if (!probabilities) return null;
  return {
    home: pct1(probabilities.home),
    draw: pct1(probabilities.draw),
    away: pct1(probabilities.away),
  };
}

function formulaNumber(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function formulaPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return `${numeric.toFixed(1).replace(/\.0$/, "")}%`;
}

function formulaWeight(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formulaOutcomeExpression(side, components, resultPercent) {
  const terms = components
    .filter((component) => Number(component.weight) > 0 && component.probabilities)
    .map((component) => `${formulaWeight(component.weight)}*${formulaPercent(component.probabilities?.[side])}`);
  return `${terms.length ? terms.join(" + ") : "0"} = ${formulaPercent(resultPercent)}`;
}

function buildProbabilityCalculationTrace(match, context) {
  const weights = context.weights || {};
  const teamStrength = asPercentTriplet(context.teamStrength);
  const market = asPercentTriplet(context.market);
  const elo = asPercentTriplet(context.elo);
  const poisson = asPercentTriplet(context.poisson);
  const scoreImplied = asPercentTriplet(context.scoreImplied);
  const worldCupPrior = asPercentTriplet(context.worldCupPrior);
  const raw = asPercentTriplet(context.raw);
  const final = asPercentTriplet(context.final);
  const officialOddsAvailable = Boolean(
    (match?.oddsSource === "sporttery:HAD" && sanitizeOdds(match.odds))
    || (match?.handicapOddsSource === "sporttery:HHAD" && sanitizeHandicapOdds(match))
  );
  const blendComponentRows = [
    {
      key: "teamStrength",
      label: { zh: "球队强度/长期样本", en: "Team strength / long sample" },
      weight: formulaNumber(weights.teamStrength || 0, 3),
      probabilities: teamStrength,
      role: "model",
    },
    {
      key: "elo",
      label: { zh: "Elo 强弱差", en: "Elo strength gap" },
      weight: formulaNumber(weights.elo || 0, 3),
      probabilities: elo,
      role: "model",
    },
    {
      key: "poisson",
      label: { zh: "Poisson 比分分布", en: "Poisson score distribution" },
      weight: formulaNumber(weights.poisson || 0, 3),
      probabilities: poisson,
      role: "model",
    },
    {
      key: "worldCupPrior",
      label: { zh: "世界杯先验", en: "World Cup prior" },
      weight: formulaNumber(weights.worldCupPrior || 0, 3),
      probabilities: worldCupPrior,
      role: "model",
    },
    {
      key: "market",
      label: { zh: "官方 SP 去水", en: "Official SP de-vig" },
      weight: formulaNumber(weights.market || 0, 3),
      probabilities: market,
      role: Number(weights.market || 0) > 0 ? "base-model-and-validation" : officialOddsAvailable ? "validation-only" : "unavailable",
    },
  ].filter((component) => component.probabilities || component.key === "market");
  const scoreFeedback = context.scoreOutcomeFeedback || {};
  const componentRows = [
    ...blendComponentRows,
    ...(scoreImplied ? [{
      key: "scoreFeedback",
      label: { zh: "姣斿垎鍒嗗竷鍙嶆帹", en: "Score-implied feedback" },
      weight: formulaNumber(scoreFeedback.weight || 0, 3),
      probabilities: scoreImplied,
      role: "model-feedback",
    }] : []),
  ];

  const lambdaBlend = context.lambdaBlend || {};
  const calibration = context.outcomeCalibration || {};
  const calibrationAdjustments = Array.isArray(calibration.adjustments)
    ? calibration.adjustments.map((adjustment) => ({
      code: adjustment.code,
      reason: adjustment.reason,
      penalty: formulaNumber(adjustment.penalty, 3),
    }))
    : [];

  return {
    version: "formula-trace-v2",
    policy: {
      zh: "此处展示基础概率计算，市场赔率按下列实际权重参与混合；之后仍有比分反馈、校准和统一后验选择，不等于最终公开方向。",
      en: "This is the base probability calculation, including the actual market weight below. Score feedback, calibration and unified selection follow; this is not the final public direction.",
    },
    outcome: {
      formula: {
        zh: "P_raw(o)=normalize(w_market*M(o)+w_strength*S(o)+w_elo*E(o)+w_poisson*Q(o)+w_wc*W(o))；P_base(o)=calibrate((1-wS)*P_raw(o)+wS*P_score(o))。",
        en: "P_raw(o)=normalize(w_market*M(o)+w_strength*S(o)+w_elo*E(o)+w_poisson*Q(o)+w_wc*W(o)); P_base(o)=calibrate((1-wS)*P_raw(o)+wS*P_score(o)).",
      },
      weights: {
        market: formulaNumber(weights.market || 0, 3),
        teamStrength: formulaNumber(weights.teamStrength || 0, 3),
        elo: formulaNumber(weights.elo || 0, 3),
        poisson: formulaNumber(weights.poisson || 0, 3),
        scoreFeedback: formulaNumber(scoreFeedback.weight || 0, 3),
        worldCupPrior: formulaNumber(weights.worldCupPrior || 0, 3),
      },
      components: componentRows,
      raw,
      final,
      expressions: raw ? {
        home: formulaOutcomeExpression("home", blendComponentRows, raw.home),
        draw: formulaOutcomeExpression("draw", blendComponentRows, raw.draw),
        away: formulaOutcomeExpression("away", blendComponentRows, raw.away),
      } : null,
      scoreFeedback: scoreImplied ? {
        applied: Boolean(scoreFeedback.applied),
        weight: formulaNumber(scoreFeedback.weight || 0, 3),
        reasons: scoreFeedback.reasons || [],
        before: asPercentTriplet(scoreFeedback.before),
        scoreImplied,
        after: asPercentTriplet(scoreFeedback.after),
        leaders: scoreFeedback.leaders || null,
      } : null,
      calibration: {
        applied: Boolean(calibration.applied),
        reasons: calibration.reasons || [],
        adjustments: calibrationAdjustments,
        before: asPercentTriplet(context.raw),
        after: final,
      },
    },
    expectedGoals: {
      formula: {
        zh: "lambda0 来自独立强度差和战平压力；lambda_league=(1-wL)*lambda0+wL*leagueAvg；lambda_final=(1-wF)*lambda_league+wF*formLambda。",
        en: "lambda0 comes from independent strength edge and draw pressure; lambda_league=(1-wL)*lambda0+wL*leagueAvg; lambda_final=(1-wF)*lambda_league+wF*formLambda.",
      },
      values: {
        independentHome: formulaNumber(lambdaBlend.independentHomeLambda ?? lambdaBlend.marketHomeLambda, 2),
        independentAway: formulaNumber(lambdaBlend.independentAwayLambda ?? lambdaBlend.marketAwayLambda, 2),
        independentTotal: formulaNumber(lambdaBlend.independentTotalLambda, 2),
        independentHomeShare: formulaNumber(lambdaBlend.independentHomeShare, 3),
        leagueHome: formulaNumber(lambdaBlend.leagueHomeLambda, 2),
        leagueAway: formulaNumber(lambdaBlend.leagueAwayLambda, 2),
        leagueWeight: formulaNumber(lambdaBlend.leagueWeight || 0, 3),
        formHome: formulaNumber(lambdaBlend.formHomeLambda, 2),
        formAway: formulaNumber(lambdaBlend.formAwayLambda, 2),
        formWeight: formulaNumber(lambdaBlend.formWeight || 0, 3),
        finalHome: formulaNumber(context.homeLambda, 2),
        finalAway: formulaNumber(context.awayLambda, 2),
      },
    },
    contextSignals: context.contextSignals || null,
    poisson: {
      formula: {
        zh: "P(score h-a)=Pois(h;lambda_home)*Pois(a;lambda_away)，其中 Pois(k;lambda)=e^-lambda*lambda^k/k!。",
        en: "P(score h-a)=Pois(h;lambda_home)*Pois(a;lambda_away), where Pois(k;lambda)=e^-lambda*lambda^k/k!.",
      },
      lambdas: {
        home: formulaNumber(context.homeLambda, 2),
        away: formulaNumber(context.awayLambda, 2),
      },
      topScores: context.scoreDistribution || [],
    },
    goals: {
      formula: {
        zh: "P(大2.5)=1-sum_{g=0..2}Pois(g;lambda_home+lambda_away)；P(BTTS)=(1-e^-lambda_home)*(1-e^-lambda_away)。",
        en: "P(Over2.5)=1-sum_{g=0..2}Pois(g;lambda_home+lambda_away); P(BTTS)=(1-e^-lambda_home)*(1-e^-lambda_away).",
      },
      values: {
        over25: pct1(context.over25Probability),
        under25: pct1(1 - context.over25Probability),
        bttsYes: pct1(context.bttsProbability),
        bttsNo: pct1(1 - context.bttsProbability),
      },
    },
    marketUse: {
      formula: "baseMarketWeight=ensembleWeights.market; finalContribution=not-attributed",
      zh: "赔率按基础模型实际阶段系数参与概率混合，也用于市场偏离和风险诊断；该系数不代表最终公开方向的贡献度，已冻结方向不得被刷新覆盖。",
      en: "Odds enter the base probability blend at its recorded stage weight and also support market-risk diagnostics. This weight is not final-direction attribution; refreshes must not overwrite a frozen direction.",
    },
  };
}

function buildCalculationTraceFromPublishedModel(match, model) {
  if (!model || typeof model !== "object") return null;

  const weights = model.ensembleWeights || {};
  const oneXTwo = model.oneXTwo || {};
  const componentRows = [
    {
      key: "teamStrength",
      label: { zh: "球队强度/长期样本", en: "Team strength / long sample" },
      weight: formulaNumber(weights.teamStrength || 0, 3),
      probabilities: oneXTwo.teamStrength || null,
      role: "model",
    },
    {
      key: "elo",
      label: { zh: "Elo 强弱差", en: "Elo strength gap" },
      weight: formulaNumber(weights.elo || 0, 3),
      probabilities: oneXTwo.elo || null,
      role: "model",
    },
    {
      key: "poisson",
      label: { zh: "Poisson 比分分布", en: "Poisson score distribution" },
      weight: formulaNumber(weights.poisson || 0, 3),
      probabilities: oneXTwo.poisson || null,
      role: "model",
    },
    {
      key: "worldCupPrior",
      label: { zh: "世界杯先验", en: "World Cup prior" },
      weight: formulaNumber(weights.worldCupPrior || 0, 3),
      probabilities: oneXTwo.worldCupPrior || null,
      role: "model",
    },
    {
      key: "market",
      label: { zh: "官方 SP 去水", en: "Official SP de-vig" },
      weight: formulaNumber(weights.market || 0, 3),
      probabilities: oneXTwo.market || null,
      role: oneXTwo.market ? (Number(weights.market || 0) > 0 ? "base-model-and-validation" : "validation-only") : "unavailable",
    },
  ].filter((component) => component.probabilities || component.key === "market");

  const final = oneXTwo.final || null;
  const lambdaBlend = model.lambdaBlend || {};
  const finalHomeLambda = Number.isFinite(Number(lambdaBlend.finalHomeLambda))
    ? Number(lambdaBlend.finalHomeLambda)
    : Number.isFinite(Number(match?.stats?.xG?.home))
      ? Number(match.stats.xG.home)
      : null;
  const finalAwayLambda = Number.isFinite(Number(lambdaBlend.finalAwayLambda))
    ? Number(lambdaBlend.finalAwayLambda)
    : Number.isFinite(Number(match?.stats?.xG?.away))
      ? Number(match.stats.xG.away)
      : null;
  const calibration = model.calibrationAdjustment?.oneXTwo || {};

  const expressionResult = calibration.before || final;

  return {
    version: "formula-trace-v2",
    policy: {
      zh: "以下为已保存基础模型的解释视图，不补造计算时使用回执。市场赔率权重以保存的数值为准；基础输出不等于最终公开方向。",
      en: "Explanation of the stored base model; no execution receipt is reconstructed. Market use follows the stored weight, and base output is not the final public direction.",
    },
    outcome: {
      formula: {
        zh: "P_raw(o)=normalize(w_market*M(o)+w_strength*S(o)+w_elo*E(o)+w_poisson*Q(o)+w_wc*W(o))；后续比分反馈与校准见保存记录。",
        en: "P_raw(o)=normalize(w_market*M(o)+w_strength*S(o)+w_elo*E(o)+w_poisson*Q(o)+w_wc*W(o)); subsequent feedback and calibration follow the stored record.",
      },
      weights: {
        market: formulaNumber(weights.market || 0, 3),
        teamStrength: formulaNumber(weights.teamStrength || 0, 3),
        elo: formulaNumber(weights.elo || 0, 3),
        poisson: formulaNumber(weights.poisson || 0, 3),
        worldCupPrior: formulaNumber(weights.worldCupPrior || 0, 3),
      },
      components: componentRows,
      raw: calibration.before || final,
      final,
      expressions: expressionResult ? {
        home: formulaOutcomeExpression("home", componentRows, expressionResult.home),
        draw: formulaOutcomeExpression("draw", componentRows, expressionResult.draw),
        away: formulaOutcomeExpression("away", componentRows, expressionResult.away),
      } : null,
      calibration: {
        applied: Boolean(calibration.applied),
        reasons: calibration.reasons || [],
        adjustments: (calibration.adjustments || []).map((adjustment) => ({
          code: adjustment.code,
          reason: adjustment.reason,
          penalty: formulaNumber(adjustment.penalty, 3),
        })),
        before: calibration.before || final,
        after: calibration.after || final,
      },
    },
    expectedGoals: {
      formula: {
        zh: "lambda0 来自独立强度差和战平压力；lambda_league=(1-wL)*lambda0+wL*leagueAvg；lambda_final=(1-wF)*lambda_league+wF*formLambda。",
        en: "lambda0 comes from independent strength edge and draw pressure; lambda_league=(1-wL)*lambda0+wL*leagueAvg; lambda_final=(1-wF)*lambda_league+wF*formLambda.",
      },
      values: {
        independentHome: formulaNumber(lambdaBlend.independentHomeLambda ?? lambdaBlend.marketHomeLambda, 2),
        independentAway: formulaNumber(lambdaBlend.independentAwayLambda ?? lambdaBlend.marketAwayLambda, 2),
        independentTotal: formulaNumber(lambdaBlend.independentTotalLambda, 2),
        independentHomeShare: formulaNumber(lambdaBlend.independentHomeShare, 3),
        leagueHome: formulaNumber(lambdaBlend.leagueHomeLambda, 2),
        leagueAway: formulaNumber(lambdaBlend.leagueAwayLambda, 2),
        leagueWeight: formulaNumber(lambdaBlend.leagueWeight || 0, 3),
        formHome: formulaNumber(lambdaBlend.formHomeLambda, 2),
        formAway: formulaNumber(lambdaBlend.formAwayLambda, 2),
        formWeight: formulaNumber(lambdaBlend.formWeight || 0, 3),
        finalHome: formulaNumber(finalHomeLambda, 2),
        finalAway: formulaNumber(finalAwayLambda, 2),
      },
    },
    poisson: {
      formula: {
        zh: "P(score h-a)=Pois(h;lambda_home)*Pois(a;lambda_away)，其中 Pois(k;lambda)=e^-lambda*lambda^k/k!。",
        en: "P(score h-a)=Pois(h;lambda_home)*Pois(a;lambda_away), where Pois(k;lambda)=e^-lambda*lambda^k/k!.",
      },
      lambdas: {
        home: formulaNumber(finalHomeLambda, 2),
        away: formulaNumber(finalAwayLambda, 2),
      },
      topScores: model.scoreDistribution || [],
    },
    goals: {
      formula: {
        zh: "P(大2.5)=1-sum_{g=0..2}Pois(g;lambda_home+lambda_away)；P(BTTS)=(1-e^-lambda_home)*(1-e^-lambda_away)。",
        en: "P(Over2.5)=1-sum_{g=0..2}Pois(g;lambda_home+lambda_away); P(BTTS)=(1-e^-lambda_home)*(1-e^-lambda_away).",
      },
      values: {
        over25: formulaNumber(model.goalLines?.over25, 1),
        under25: formulaNumber(model.goalLines?.under25, 1),
        bttsYes: formulaNumber(model.bothTeamsToScore?.yes, 1),
        bttsNo: formulaNumber(model.bothTeamsToScore?.no, 1),
      },
    },
    marketUse: {
      formula: "baseMarketWeight=ensembleWeights.market; finalContribution=not-attributed",
      zh: "赔率按基础模型实际阶段系数参与概率混合，也用于市场偏离和风险诊断；该系数不代表最终公开方向的贡献度，已冻结方向不得被刷新覆盖。",
      en: "Odds enter the base probability blend at its recorded stage weight and also support market-risk diagnostics. This weight is not final-direction attribution; refreshes must not overwrite a frozen direction.",
    },
  };
}

function compactWorldCupPriorForModel(prior) {
  if (!prior) return null;
  const compactSide = (side) => side ? {
    key: side.key,
    nameZh: side.nameZh,
    nameEn: side.nameEn,
    group: side.group,
    fifaRank: side.fifaRank,
    elo: side.elo,
    squadValueM: side.squadValueM,
    avgAge: side.avgAge,
    corePlayer: side.corePlayer,
    qualityTier: side.qualityTier,
    modelStrengthNormalized: side.modelStrengthNormalized,
    recent10: side.recent10,
    groupOutlook: side.groupOutlook,
  } : null;

  return {
    source: prior.source,
    version: prior.version,
    signature: prior.signature,
    policy: prior.policy,
    rawPolicy: prior.rawPolicy,
    strengthDiff: prior.strengthDiff,
    fixture: prior.fixture,
    home: compactSide(prior.home),
    away: compactSide(prior.away),
  };
}

function buildProbabilityModel(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability, lambdaBlend, goalCalibration, contextSignals = null) {
  const poisson1x2 = poissonOutcomeProbabilities(homeLambda, awayLambda);
  const blended = blendOutcomeProbabilities(match, probabilities, poisson1x2, match.eloSnapshot, match.formSnapshot);
  const scoreContext = {
    over25Probability,
    bttsProbability,
    scoreCalibration: match.modelCalibration?.scoreCalibration,
    contextSignals,
    worldCupGroupContext: contextSignals?.worldCupGroupContext || null,
  };
  const scoreDistribution = topScoreProbabilities(homeLambda, awayLambda, 6, scoreContext);
  const scoreImplied1x2 = scoreImpliedOutcomeProbabilities(homeLambda, awayLambda, scoreContext);
  const scoreOutcomeFeedback = applyScoreOutcomeFeedback(match, blended.probabilities, scoreImplied1x2);
  const outcomeCalibration = calibrateOutcomeProbabilities(match, scoreOutcomeFeedback.probabilities, probabilities);
  const outcomeCalibrationShadow = buildOutcomeCalibrationShadow(scoreOutcomeFeedback, outcomeCalibration);
  const final1x2 = outcomeCalibration.probabilities;
  const handicapLine = parseHandicapLine(match.handicapLine);
  const handicapPoisson = handicapOutcomeProbabilities(homeLambda, awayLambda, handicapLine);
  const handicapScoreImplied = scoreImpliedHandicapProbabilities(homeLambda, awayLambda, handicapLine, scoreContext);
  const calibration = profileCalibration(match);
  const worldCupPrior = worldCupPriorOutcomeProbabilities(match);
  const calculationTrace = buildProbabilityCalculationTrace(match, {
    weights: blended.weights,
    teamStrength: blended.teamStrength,
    market: probabilities,
    elo: match.eloSnapshot?.probabilities,
    poisson: poisson1x2,
    scoreImplied: scoreImplied1x2,
    scoreOutcomeFeedback,
    worldCupPrior,
    raw: blended.probabilities,
    final: final1x2,
    outcomeCalibration,
    lambdaBlend,
    homeLambda,
    awayLambda,
    over25Probability,
    bttsProbability,
    scoreDistribution,
    contextSignals,
  });
  return {
    version: "independent-elo-form-poisson-v11",
    competitionContext: require("./competitionModelContext.cjs").competitionModelContext(match),
    generatedAt: predictionNowIso(),
    basis: PREDICTION_MODEL_BASIS,
    ensembleWeights: {
      ...blended.weights,
      scoreFeedback: scoreOutcomeFeedback.weight,
    },
    calculationTrace,
    inputUsage: [lambdaBlend?.formUsage, blended.usage].filter(Boolean),
    dynamicCalibration: {
      version: match.modelCalibration?.version || "none",
      profileKey: calibration.profileKey,
      gate: calibration.gate || null,
      metrics: calibration.metrics || null,
      strategy: calibration.strategy ? {
        version: calibration.strategy.version,
        generatedAt: calibration.strategy.generatedAt,
        onlineEffect: calibration.strategy.activation?.onlineEffect || "unknown",
        activeGates: calibration.strategy.activeGates || null,
      } : null,
    },
    scoreCalibration: match.modelCalibration?.scoreCalibration ? {
      version: match.modelCalibration.scoreCalibration.version,
      source: match.modelCalibration.scoreCalibration.source,
      sample: {
        rows: match.modelCalibration.scoreCalibration.sample?.rows || 0,
        recentRows: match.modelCalibration.scoreCalibration.sample?.recentRows || 0,
        sampleDays: match.modelCalibration.scoreCalibration.sample?.sampleDays || null,
        exactHitRate: match.modelCalibration.scoreCalibration.sample?.exactHitRate ?? null,
        top3ExactHitRate: match.modelCalibration.scoreCalibration.sample?.top3ExactHitRate ?? null,
        outcomeHitRate: match.modelCalibration.scoreCalibration.sample?.outcomeHitRate ?? null,
        top3OutcomeHitRate: match.modelCalibration.scoreCalibration.sample?.top3OutcomeHitRate ?? null,
        totalBandHitRate: match.modelCalibration.scoreCalibration.sample?.totalBandHitRate ?? null,
        top3TotalBandHitRate: match.modelCalibration.scoreCalibration.sample?.top3TotalBandHitRate ?? null,
      },
      adjustments: {
        totalLambdaAdjustment: match.modelCalibration.scoreCalibration.adjustments?.totalLambdaAdjustment || 0,
        bandRankBoosts: match.modelCalibration.scoreCalibration.adjustments?.bandRankBoosts || {},
        shapeRankBoosts: match.modelCalibration.scoreCalibration.adjustments?.shapeRankBoosts || {},
      },
      reasons: match.modelCalibration.scoreCalibration.reasons || [],
    } : null,
    calibrationAdjustment: {
      oneXTwo: {
        applied: outcomeCalibration.applied || scoreOutcomeFeedback.applied,
        reasons: [...(scoreOutcomeFeedback.reasons || []), ...(outcomeCalibration.reasons || [])],
        adjustments: outcomeCalibration.adjustments,
        before: asPercentTriplet(blended.probabilities),
        after: asPercentTriplet(final1x2),
        scoreFeedback: {
          applied: scoreOutcomeFeedback.applied,
          weight: scoreOutcomeFeedback.weight,
          reasons: scoreOutcomeFeedback.reasons,
          before: asPercentTriplet(scoreOutcomeFeedback.before),
          scoreImplied: asPercentTriplet(scoreOutcomeFeedback.scoreImplied),
          after: asPercentTriplet(scoreOutcomeFeedback.after),
          leaders: scoreOutcomeFeedback.leaders || null,
        },
        shadow: outcomeCalibrationShadow,
      },
      goals: goalCalibration?.meta || null,
    },
    contextSignals,
    worldCupGroupContext: contextSignals?.worldCupGroupContext || null,
    lambdaBlend: lambdaBlend ? {
      marketHomeLambda: Number(lambdaBlend.marketHomeLambda.toFixed(2)),
      marketAwayLambda: Number(lambdaBlend.marketAwayLambda.toFixed(2)),
      independentHomeLambda: lambdaBlend.independentHomeLambda,
      independentAwayLambda: lambdaBlend.independentAwayLambda,
      independentTotalLambda: lambdaBlend.independentTotalLambda,
      independentHomeShare: lambdaBlend.independentHomeShare,
      leagueHomeLambda: lambdaBlend.leagueHomeLambda,
      leagueAwayLambda: lambdaBlend.leagueAwayLambda,
      leagueWeight: lambdaBlend.leagueWeight || 0,
      leaguePriorKey: lambdaBlend.leaguePriorKey || null,
      formHomeLambda: lambdaBlend.formHomeLambda,
      formAwayLambda: lambdaBlend.formAwayLambda,
      formWeight: lambdaBlend.formWeight,
      scoreTotalLambdaAdjustment: lambdaBlend.scoreTotalLambdaAdjustment || 0,
      scoreCalibrationVersion: lambdaBlend.scoreCalibrationVersion || null,
      contextTotalLambdaAdjustment: lambdaBlend.contextTotalLambdaAdjustment || 0,
      contextHomeLambdaAdjustment: lambdaBlend.contextHomeLambdaAdjustment || 0,
      contextAwayLambdaAdjustment: lambdaBlend.contextAwayLambdaAdjustment || 0,
    } : undefined,
    oneXTwo: {
      market: asPercentTriplet(probabilities),
      teamStrength: asPercentTriplet(blended.teamStrength),
      elo: asPercentTriplet(match.eloSnapshot?.probabilities),
      poisson: asPercentTriplet(poisson1x2),
      scoreImplied: asPercentTriplet(scoreImplied1x2),
      worldCupPrior: asPercentTriplet(worldCupPrior),
      final: asPercentTriplet(final1x2),
    },
    worldCupPrior: compactWorldCupPriorForModel(match.worldCupPrior || match.externalSignals?.worldCupPrior),
    elo: match.eloSnapshot ? {
      homeRating: Math.round(match.eloSnapshot.homeRating),
      awayRating: Math.round(match.eloSnapshot.awayRating),
      diff: Math.round(match.eloSnapshot.diff),
      homeMatches: match.eloSnapshot.homeMatches,
      awayMatches: match.eloSnapshot.awayMatches,
      historicalSource: match.eloSnapshot.historicalSource || null,
      lastUpdatedAt: match.eloSnapshot.lastUpdatedAt,
    } : null,
    form: match.formSnapshot ? {
      version: match.formSnapshot.version,
      lookbackMatches: match.formSnapshot.lookbackMatches,
      sampleSize: match.formSnapshot.sampleSize,
      home: match.formSnapshot.home,
      away: match.formSnapshot.away,
      h2h: match.formSnapshot.h2h,
      historicalSource: match.formSnapshot.historicalSource || null,
    } : null,
    leaguePrior: match.leaguePrior ? {
      key: match.leaguePrior.key,
      source: match.leaguePrior.source,
      matches: match.leaguePrior.matches,
      homeGoalsAvg: match.leaguePrior.homeGoalsAvg,
      awayGoalsAvg: match.leaguePrior.awayGoalsAvg,
      totalGoalsAvg: match.leaguePrior.totalGoalsAvg,
      over25Rate: match.leaguePrior.over25Rate,
      bttsRate: match.leaguePrior.bttsRate,
      drawRate: match.leaguePrior.drawRate,
      lastMatchDate: match.leaguePrior.lastMatchDate,
      trainingVersion: match.leaguePrior.trainingVersion,
      trainingSignature: match.leaguePrior.trainingSignature,
    } : null,
    modelHealth: match.predictionHealth ? {
      version: match.predictionHealth.version,
      total: match.predictionHealth.total,
      byMarket: match.predictionHealth.byMarket,
      byTip: match.predictionHealth.byTip,
      byProfile: match.predictionHealth.byProfile,
      byMarketProfile: match.predictionHealth.byMarketProfile,
      byOddsBucket: match.predictionHealth.byOddsBucket,
      oneXTwo: match.predictionHealth.oneXTwo,
      hhad: match.predictionHealth.hhad,
      best: match.predictionHealth.best,
      goals: match.predictionHealth.goals,
      homeFavorite: match.predictionHealth.homeFavorite,
      awayFavorite: match.predictionHealth.awayFavorite,
      lowSpSide: match.predictionHealth.lowSpSide,
      under25: match.predictionHealth.under25,
      dataSources: match.predictionHealth.dataSources || null,
    } : null,
    scoreDistribution,
    goalLines: {
      over25: pct1(over25Probability),
      under25: pct1(1 - over25Probability),
    },
    bothTeamsToScore: {
      yes: pct1(bttsProbability),
      no: pct1(1 - bttsProbability),
    },
    handicap: handicapLine !== null ? {
      line: formatHandicapLineForCopy(handicapLine),
      market: asPercentTriplet(hhadProbabilities),
      poisson: asPercentTriplet(handicapPoisson),
      scoreImplied: asPercentTriplet(handicapScoreImplied),
    } : null,
    calibration: {
      status: "baseline",
      zh: "当前为轻量级赛前校准：已加入历史 form 修正和近期命中率冷却；后续仍需要用时间滚动回测做 Brier / log loss / reliability 正式校准。",
      en: "This is a lightweight pre-match calibration with rolling-form correction and recent hit-rate cooldown; Brier, log loss, and reliability calibration are still needed.",
    },
  };
}

function eloExpectedScore(homeRating, awayRating, homeAdvantage = 62) {
  return 1 / (1 + 10 ** (-((homeRating + homeAdvantage) - awayRating) / 400));
}

function eloOutcomeProbabilities(homeRating, awayRating, homeAdvantage = 62) {
  const strengthHome = eloExpectedScore(homeRating, awayRating, homeAdvantage);
  const draw = clamp(0.305 - Math.abs(strengthHome - 0.5) * 0.26, 0.17, 0.31);
  const home = clamp((1 - draw) * strengthHome, 0.05, 0.88);
  const away = clamp(1 - draw - home, 0.05, 0.88);
  return normalizeOutcomeProbabilities({ home, draw, away });
}

const TEAM_KEY_ALIASES = Object.freeze({
  "阿根廷": "argentina",
  "冰岛": "iceland",
  "葡萄牙": "portugal",
  "尼日利亚": "nigeria",
  "英格兰": "england",
  "哥斯达黎加": "costa rica",
  "墨西哥": "mexico",
  "南非": "south africa",
  "韩国": "south korea",
  "捷克": "czech republic",
  "加拿大": "canada",
  "波黑": "bosnia and herzegovina",
  "美国": "united states",
  "巴拉圭": "paraguay",
  "卡塔尔": "qatar",
  "瑞士": "switzerland",
  "巴西": "brazil",
  "摩洛哥": "morocco",
  "海地": "haiti",
  "苏格兰": "scotland",
  "澳大利亚": "australia",
  "土耳其": "turkey",
  "德国": "germany",
  "库拉索": "curacao",
  "荷兰": "netherlands",
  "日本": "japan",
  "瑞典": "sweden",
  "突尼斯": "tunisia",
  "西班牙": "spain",
  "佛得角": "cape verde",
  "比利时": "belgium",
  "埃及": "egypt",
  "沙特阿拉伯": "saudi arabia",
  "乌拉圭": "uruguay",
  "伊朗": "iran",
  "新西兰": "new zealand",
  "丹麦": "denmark",
  "塞内加尔": "senegal",
  "哥伦比亚": "colombia",
  "克罗地亚": "croatia",
  "法国": "france",
  "加纳": "ghana",
  "挪威": "norway",
  "喀麦隆": "cameroon",
  "意大利": "italy",
  "洪都拉斯": "honduras",
  "智利": "chile",
  "牙买加": "jamaica",
  "波兰": "poland",
  "阿尔及利亚": "algeria",
  "中国": "china",
  "泰国": "thailand",
  "匈牙利": "hungary",
  "哈萨克": "kazakhstan",
});

const CURRENT_TEAM_KEY_ALIASES = Object.freeze({
  ...FREE_FOOTBALL_TEAM_ALIASES,
  "\u963f\u6839\u5ef7": "argentina",
  "\u51b0\u5c9b": "iceland",
  "\u8461\u8404\u7259": "portugal",
  "\u5c3c\u65e5\u5229\u4e9a": "nigeria",
  "\u82f1\u683c\u5170": "england",
  "\u54e5\u65af\u8fbe\u9ece\u52a0": "costa rica",
  "\u58a8\u897f\u54e5": "mexico",
  "\u5357\u975e": "south africa",
  "\u97e9\u56fd": "south korea",
  "\u6377\u514b": "czech republic",
  "\u52a0\u62ff\u5927": "canada",
  "\u6ce2\u9ed1": "bosnia and herzegovina",
  "\u7f8e\u56fd": "united states",
  "\u5df4\u62c9\u572d": "paraguay",
  "\u5361\u5854\u5c14": "qatar",
  "\u745e\u58eb": "switzerland",
  "\u5df4\u897f": "brazil",
  "\u6469\u6d1b\u54e5": "morocco",
  "\u6d77\u5730": "haiti",
  "\u82cf\u683c\u5170": "scotland",
  "\u6fb3\u5927\u5229\u4e9a": "australia",
  "\u571f\u8033\u5176": "turkey",
  "\u5fb7\u56fd": "germany",
  "\u5e93\u62c9\u7d22": "curacao",
  "\u8377\u5170": "netherlands",
  "\u65e5\u672c": "japan",
  "\u745e\u5178": "sweden",
  "\u7a81\u5c3c\u65af": "tunisia",
  "\u897f\u73ed\u7259": "spain",
  "\u4f5b\u5f97\u89d2": "cape verde",
  "\u6bd4\u5229\u65f6": "belgium",
  "\u57c3\u53ca": "egypt",
  "\u6c99\u7279\u963f\u62c9\u4f2f": "saudi arabia",
  "\u4e4c\u62c9\u572d": "uruguay",
  "\u4f0a\u6717": "iran",
  "\u65b0\u897f\u5170": "new zealand",
  "\u4e39\u9ea6": "denmark",
  "\u585e\u5185\u52a0\u5c14": "senegal",
  "\u54e5\u4f26\u6bd4\u4e9a": "colombia",
  "\u514b\u7f57\u5730\u4e9a": "croatia",
  "\u6cd5\u56fd": "france",
  "\u52a0\u7eb3": "ghana",
  "\u632a\u5a01": "norway",
  "\u5580\u9ea6\u9686": "cameroon",
  "\u610f\u5927\u5229": "italy",
  "\u6d2a\u90fd\u62c9\u65af": "honduras",
  "\u667a\u5229": "chile",
  "\u7259\u4e70\u52a0": "jamaica",
  "\u6ce2\u5170": "poland",
  "\u963f\u5c14\u53ca\u5229\u4e9a": "algeria",
  "\u4e2d\u56fd": "china",
  "\u6cf0\u56fd": "thailand",
  "\u5308\u7259\u5229": "hungary",
  "\u54c8\u8428\u514b": "kazakhstan",
  "\u8d6b\u6839": "hacken",
  "aik\u7d22\u5c14\u7eb3": "aik",
  "\u7f57\u68ee\u535a\u683c": "rosenborg",
  "\u8153\u7279\u70c8\u65af\u5854": "fredrikstad",
  "\u5e93\u5965\u76ae\u5965": "kups",
  "\u54c8\u8328": "hearts",
  "\u683c\u62c9\u8328\u98ce\u66b4": "sturm graz",
  "\u6ce2\u5179\u5357\u83b1\u8d6b": "lech poznan",
  "\u5965\u80e1\u65af": "aarhus",
  "\u5df4\u897f\u56fd\u9645": "internacional",
  "\u5f17\u62c9\u95e8\u6208": "flamengo rj",
  "\u5f17\u9c81\u7c73\u5ae9\u585e": "fluminense",
  "\u5df4\u4f0a\u4e9a": "bahia",
  "\u7ef4\u591a\u5229\u4e9a": "vitoria",
  "\u5e15\u5c14\u6885\u62c9\u65af": "palmeiras",
  "\u5df4\u9ece\u5723\u65e5\u5c14\u66fc": "paris sg",
  "\u963f\u65af\u987f\u7ef4\u62c9": "aston villa",
  "\u666e\u62c9\u6ed5\u65af": "platense",
  "\u79d1\u91d1\u535a\u8054": "coquimbo unido",
  "\u6ce2\u7279\u8bfa\u5c71\u4e18": "cerro porteno",
  "\u4e2d\u65e5\u5fb7\u5170": "midtjylland",
  "\u8d1d\u897f\u514b\u5854\u65af": "besiktas",
  "\u5b89\u5fb7\u83b1\u8d6b\u7279": "anderlecht",
  "\u54c8\u9a6c\u6bd4": "hammarby",
  "\u5929\u72fc\u661f": "sirius",
  "\u5e03\u9c81\u9a6c\u6ce2\u5361\u7eb3": "brommapojkarna",
  "\u97e6\u65af\u7279\u7f57\u65af": "vasteras sk",
  "\u4f50\u52a0\u987f\u65af": "djurgarden",
  "\u5723\u514b\u62c9\u62c9": "santa clara",
  "\u8461\u8404\u7259\u56fd\u6c11": "nacional",
  "\u7279\u6e29\u7279": "twente",
  "\u672c\u83f2\u5361": "benfica",
  "\u5723\u52a0\u4ed1": "st gallen",
  "\u79d1\u6797\u8482\u5b89": "corinthians",
  "\u5df4\u62c9\u7eb3\u7ade\u6280": "athletico pr",
  "\u79d1\u7f57\u62c9\u591a\u6025\u6d41": "colorado rapids",
  "\u6d1b\u6749\u77f6": "los angeles",
  "\u7c73\u4e9a\u5c14\u6bd4": "mjallby",
  "\u8428\u5c14\u8328\u5821": "salzburg",
  "\u7279\u62c9\u5e03\u5b97\u4f53\u80b2": "trabzonspor",
  "\u56fe\u6069": "thun",
  "\u8d1d\u5c14\u683c\u83b1\u5fb7\u7ea2\u661f": "red star",
  "\u5df4\u5217\u5361\u8bfa": "vallecano",
  "\u963f\u62c9\u7ef4\u65af": "alaves",
  "\u7f57\u8428\u91cc\u5965\u4e2d\u592e": "rosario central",
  "\u67cf\u592a\u9633\u795e": "kashiwa reysol",
  "\u957f\u5d0e\u822a\u6d77": "v varen nagasaki",
  "\u4e1c\u4eac": "tokyo",
  "\u767b\u535a\u601d": "den bosch",
  "\u6566\u523b\u5c14\u514b": "dunkerque",
  "\u8499\u5f7c\u5229\u57c3": "montpellier",
  "\u9a6c\u8d5b": "marseille",
  "\u65af\u7279\u62c9\u65af\u5821": "strasbourg",
  "\u963f\u68ee\u7eb3": "arsenal",
  "\u8003\u6587\u5782": "coventry",
  "\u7687\u5bb6\u8d1d\u8482\u65af": "betis",
  "\u7687\u5bb6\u793e\u4f1a": "sociedad",
  "\u6ce2\u5179\u5357": "lech poznan",
  "\u7c73\u62c9\u7d22\u5c14": "mirassol",
  "\u91cc\u83ab": "remo",
  "\u5e15\u798f\u65af": "pafos",
  "\u65af\u666e\u5229\u7279\u6d77\u675c\u514b": "hajduk split",
  "\u8d39\u4f26\u8328\u74e6\u7f57\u65af": "ferencvaros",
  "\u74e6\u52d2\u4f26\u52a0": "valerenga",
  "\u6c49\u574e": "hamkam",
  "\u535a\u5fb7\u95ea\u8000": "bodo glimt",
  "\u5229\u52d2\u65af\u7279\u7f57\u59c6": "lillestrom",
  "\u7ebd\u7ea6\u57ce": "new york city",
  "\u591a\u4f26\u591a": "toronto",
});

function normalizedTeamKey(teamName) {
  return normText(teamName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(fc|cf|afc|sc|club)\b/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function teamKey(teamName) {
  const key = normalizedTeamKey(teamName);
  return CURRENT_TEAM_KEY_ALIASES[key] || TEAM_KEY_ALIASES[key] || key;
}

function pairKey(homeTeam, awayTeam) {
  return [teamKey(homeTeam), teamKey(awayTeam)].sort().join("__");
}

function matchSideTeamName(match, side) {
  return side === "home"
    ? (match.homeTeamName || match.homeTeam || match.homeName || "")
    : (match.awayTeamName || match.awayTeam || match.awayName || "");
}

const KIMI_WORLD_CUP_KEY_ALIASES = Object.freeze({
  "united-states": "usa",
  "czech-republic": "czechia",
  "bosnia-and-herzegovina": "bosnia",
  "south-africa": "south-africa",
  "south-korea": "south-korea",
  "saudi-arabia": "saudi-arabia",
  "new-zealand": "new-zealand",
  "cape-verde": "cape-verde",
  "ivory-coast": "ivory-coast",
  "dr-congo": "dr-congo",
  "democratic-republic-of-congo": "dr-congo",
  "congo-dr": "dr-congo",
});

function kimiWorldCupKey(value) {
  const key = teamKey(value).replace(/\s+/g, "-");
  return KIMI_WORLD_CUP_KEY_ALIASES[key] || key;
}

function worldCupTeamMap(dataset) {
  const map = new Map();
  for (const team of dataset?.teams || []) {
    [
      team.key,
      team.nameZh,
      team.nameEn,
    ].filter(Boolean).forEach((value) => {
      map.set(kimiWorldCupKey(value), team);
    });
  }
  return map;
}

function compactWorldCupTeamPrior(team) {
  if (!team) return null;
  return {
    key: team.key,
    nameZh: team.nameZh,
    nameEn: team.nameEn,
    group: team.group,
    fifaRank: team.fifaRank,
    elo: team.elo,
    squadValueM: team.squadValueM,
    avgAge: team.avgAge,
    corePlayer: team.corePlayer,
    qualityTier: team.qualityTier,
    recent10: team.recent10,
    groupOutlook: team.groupOutlook,
    modelStrengthNormalized: team.modelStrengthNormalized,
  };
}

function fixturePriorForMatch(dataset, match) {
  const homeKey = kimiWorldCupKey(matchSideTeamName(match, "home"));
  const awayKey = kimiWorldCupKey(matchSideTeamName(match, "away"));
  return (dataset?.fixtures || []).find((fixture) => {
    const fixtureHome = kimiWorldCupKey(fixture.homeKey || fixture.homeNameZh);
    const fixtureAway = kimiWorldCupKey(fixture.awayKey || fixture.awayNameZh);
    return fixtureHome === homeKey && fixtureAway === awayKey;
  }) || null;
}

function isWorldCupMatchCandidate(match) {
  const text = [
    match.leagueName,
    match.leagueNameEn,
    match.leagueShortName,
    match.countryName,
    match.countryNameEn,
    match.externalSignals?.leagueName,
  ].filter(Boolean).join(" ");
  return /世界杯|FIFA\s*World\s*Cup|World\s*Cup/i.test(text);
}

function worldCupPriorForMatch(dataset, match) {
  if (!dataset?.modelingSafety?.accepted || !dataset?.teams || !isWorldCupMatchCandidate(match)) return null;
  const teams = worldCupTeamMap(dataset);
  const home = teams.get(kimiWorldCupKey(matchSideTeamName(match, "home")));
  const away = teams.get(kimiWorldCupKey(matchSideTeamName(match, "away")));
  if (!home || !away) return null;

  const fixture = fixturePriorForMatch(dataset, match);
  const homeStrength = Number(home.modelStrengthNormalized);
  const awayStrength = Number(away.modelStrengthNormalized);
  return {
    source: "kimi-worldcup-dataset",
    version: dataset.version,
    signature: dataset.signature,
    policy: dataset.quality?.curated?.policy || "pre-match-prior",
    rawPolicy: dataset.quality?.raw?.policy || "audit-only",
    strengthDiff: Number.isFinite(homeStrength) && Number.isFinite(awayStrength)
      ? Number((homeStrength - awayStrength).toFixed(4))
      : null,
    fixture: fixture ? {
      matchNo: fixture.matchNo,
      kickoffLabel: fixture.kickoffLabel,
      kickoffTime: fixture.kickoffTime,
      venue: fixture.venue,
      city: fixture.city,
      sourceQuality: fixture.sourceQuality,
      note: fixture.note,
    } : null,
    home: compactWorldCupTeamPrior(home),
    away: compactWorldCupTeamPrior(away),
  };
}

function stripWorldCupPriorFields(value) {
  if (Array.isArray(value)) return value.map(stripWorldCupPriorFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "worldCupPrior" && key !== "worldCupPriorSignature")
    .map(([key, item]) => [key, stripWorldCupPriorFields(item)]));
}

function stripRejectedWorldCupPrior(match) {
  if (!match || typeof match !== "object") return match;
  const cleaned = stripWorldCupPriorFields(match);
  return {
    ...cleaned,
    predictionMeta: {
      ...(cleaned.predictionMeta || {}),
      rejectedDataSources: Array.from(new Set([
        ...(Array.isArray(cleaned.predictionMeta?.rejectedDataSources)
          ? cleaned.predictionMeta.rejectedDataSources
          : []),
        "kimi-worldcup-dataset",
      ])),
    },
  };
}

function attachWorldCupPrior(match, dataset) {
  if (!dataset?.modelingSafety?.accepted) {
    const hasStoredPrior = Boolean(
      match?.worldCupPrior
      || match?.externalSignals?.worldCupPrior
      || match?.probabilityModel?.worldCupPrior
      || match?.predictionMeta?.worldCupPriorSignature
      || match?.predictionMeta?.featureSnapshot?.modelInputs?.worldCupPrior
    );
    return isWorldCupMatchCandidate(match) || hasStoredPrior
      ? stripRejectedWorldCupPrior(match)
      : match;
  }
  const worldCupPrior = worldCupPriorForMatch(dataset, match);
  if (!worldCupPrior) return match;
  return {
    ...match,
    worldCupPrior,
    externalSignals: {
      ...(match.externalSignals || {}),
      worldCupPrior,
    },
  };
}

function loadHistoricalTrainingIndex() {
  const candidates = [
    process.env.HISTORICAL_TRAINING_INDEX_PATH,
    path.join(__dirname, "..", HISTORICAL_TRAINING_RELEASE_ENTRY),
    path.join(__dirname, "..", "server-data", "training", "historical-training-index.json"),
  ].filter(Boolean);
  for (const file of [...new Set(candidates.map((candidate) => path.resolve(candidate)))]) {
    if (!fs.existsSync(file)) continue;
    try {
      const inspection = inspectHistoricalTrainingFile(file);
      if (!inspection.ok) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        ...parsed,
        releaseArtifact: {
          entry: file.includes(".release-model-assets")
            ? HISTORICAL_TRAINING_RELEASE_ENTRY
            : null,
          file,
          sourceKind: file.includes(".release-model-assets")
            ? "signed-release-asset"
            : (process.env.HISTORICAL_TRAINING_INDEX_PATH
              && file === path.resolve(process.env.HISTORICAL_TRAINING_INDEX_PATH)
              ? "explicit-runtime-path"
              : "local-workspace"),
          validation: inspection,
        },
      };
    } catch {
      // Try the next explicitly trusted location. Invalid or partial training
      // input must never silently enter the model.
    }
  }
  return null;
}

function loadWorldCupKimiDataset() {
  const candidates = [
    path.join(__dirname, "..", "server-data", "worldcup", "kimi-worldcup-dataset.json"),
    path.join(__dirname, "..", "public", "data", "worldcup-kimi-dataset.json"),
  ];

  const loadErrors = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        loadErrors.push(`invalid-dataset-shape:${path.basename(file)}`);
        continue;
      }
      const modelingSafety = auditWorldCupKimiDataset(parsed, file);
      return { ...parsed, modelingSafety };
    } catch (error) {
      loadErrors.push(`invalid-json:${path.basename(file)}:${error.message || String(error)}`);
      // Try the next location.
    }
  }
  return {
    version: "worldcup-kimi-unavailable",
    teams: [],
    fixtures: [],
    modelingSafety: {
      version: "worldcup-kimi-modeling-safety-v1",
      accepted: false,
      status: "rejected",
      modelingUsage: "rejected-fail-closed",
      sourceFile: null,
      reasons: loadErrors.length ? loadErrors : ["dataset-not-found"],
      counts: {
        teams: 0,
        fixtures: 0,
        groupFixtures: 0,
        teamOutlookGroups: 0,
        fixtureGroups: 0,
        invalidTeamGroups: 0,
        mismatchedTeamOutlooks: 0,
        malformedTeamGroupCounts: 0,
        invalidFixtureDates: 0,
        invalidFixtureGroups: 0,
        mismatchedFixtureTeams: 0,
        untrustedFixtures: 0,
      },
    },
  };
}

function auditWorldCupKimiDataset(dataset, sourceFile = null) {
  const expectedGroups = new Set("ABCDEFGHIJKL".split(""));
  const trustedFixtureQualities = new Set(["official", "verified", "reconciled"]);
  const teams = Array.isArray(dataset?.teams) ? dataset.teams : [];
  const fixtures = Array.isArray(dataset?.fixtures) ? dataset.fixtures : [];
  const teamByKey = new Map(teams.map((team) => [normText(team?.key), team]));
  const groupFixtures = fixtures.filter((fixture) => /小组赛|group\s*stage/i.test(normText(fixture?.stage)));
  const invalidTeamGroups = teams.filter((team) => !expectedGroups.has(normText(team?.group)));
  const mismatchedTeamOutlooks = teams.filter((team) => {
    const group = normText(team?.group);
    const outlookGroup = normText(team?.groupOutlook?.group);
    return Boolean(outlookGroup) && outlookGroup !== group;
  });
  const malformedTeamGroupCounts = [...expectedGroups].filter((group) => (
    teams.filter((team) => normText(team?.group) === group).length !== 4
  ));
  const teamOutlookGroups = new Set(teams
    .map((team) => normText(team?.groupOutlook?.group))
    .filter(Boolean));
  const fixtureGroups = new Set(groupFixtures.map((fixture) => normText(fixture?.group)).filter(Boolean));
  const invalidFixtureDates = fixtures.filter((fixture) => (
    !normText(fixture?.kickoffTime) || !Number.isFinite(Date.parse(fixture.kickoffTime))
  ));
  const invalidFixtureGroups = groupFixtures.filter((fixture) => !expectedGroups.has(normText(fixture?.group)));
  const mismatchedFixtureTeams = groupFixtures.filter((fixture) => {
    const fixtureGroup = normText(fixture?.group);
    const homeGroup = normText(teamByKey.get(normText(fixture?.homeKey))?.group);
    const awayGroup = normText(teamByKey.get(normText(fixture?.awayKey))?.group);
    return !homeGroup || !awayGroup || homeGroup !== fixtureGroup || awayGroup !== fixtureGroup;
  });
  const untrustedFixtures = fixtures.filter((fixture) => (
    !trustedFixtureQualities.has(normText(fixture?.sourceQuality).toLowerCase())
  ));
  const reasons = [
    ...(teams.length !== 48 ? ["team-count-invalid"] : []),
    ...(fixtures.length !== 104 ? ["fixture-count-invalid"] : []),
    ...(groupFixtures.length !== 72 ? ["group-fixture-count-invalid"] : []),
    ...(invalidTeamGroups.length ? ["invalid-team-groups"] : []),
    ...(mismatchedTeamOutlooks.length ? ["team-group-outlook-mismatch"] : []),
    ...(malformedTeamGroupCounts.length ? ["team-group-cardinality-invalid"] : []),
    ...(teamOutlookGroups.size !== expectedGroups.size ? ["team-outlook-groups-not-diverse"] : []),
    ...(invalidFixtureDates.length ? ["invalid-fixture-dates"] : []),
    ...(invalidFixtureGroups.length ? ["invalid-fixture-groups"] : []),
    ...(fixtureGroups.size !== expectedGroups.size ? ["fixture-groups-not-diverse"] : []),
    ...(mismatchedFixtureTeams.length ? ["fixture-team-group-mismatch"] : []),
    ...(untrustedFixtures.length ? ["fixture-quality-untrusted"] : []),
  ];
  const accepted = reasons.length === 0;
  return {
    version: "worldcup-kimi-modeling-safety-v1",
    accepted,
    status: accepted ? "accepted" : "rejected",
    modelingUsage: accepted ? "enabled-pre-match-prior" : "rejected-fail-closed",
    sourceFile,
    reasons,
    counts: {
      teams: teams.length,
      fixtures: fixtures.length,
      groupFixtures: groupFixtures.length,
      teamOutlookGroups: teamOutlookGroups.size,
      fixtureGroups: fixtureGroups.size,
      invalidTeamGroups: invalidTeamGroups.length,
      mismatchedTeamOutlooks: mismatchedTeamOutlooks.length,
      malformedTeamGroupCounts: malformedTeamGroupCounts.length,
      invalidFixtureDates: invalidFixtureDates.length,
      invalidFixtureGroups: invalidFixtureGroups.length,
      mismatchedFixtureTeams: mismatchedFixtureTeams.length,
      untrustedFixtures: untrustedFixtures.length,
    },
  };
}

function worldCupDatasetSummary(dataset) {
  if (!dataset) return null;
  return {
    version: dataset.version || "unknown",
    source: dataset.source?.zipFile || "kimi-worldcup-dataset",
    signature: dataset.signature || null,
    teams: Array.isArray(dataset.teams) ? dataset.teams.length : 0,
    fixtures: Array.isArray(dataset.fixtures) ? dataset.fixtures.length : 0,
    policy: dataset.quality?.curated?.policy || "pre-match-prior",
    rawPolicy: dataset.quality?.raw?.policy || null,
    modelingUsage: dataset.modelingSafety?.modelingUsage || "rejected-fail-closed",
    modelingStatus: dataset.modelingSafety?.status || "rejected",
    accepted: dataset.modelingSafety?.accepted === true,
    rejectionReasons: dataset.modelingSafety?.accepted === true
      ? []
      : (dataset.modelingSafety?.reasons || ["modeling-safety-missing"]),
    audit: dataset.modelingSafety?.counts || null,
  };
}

function trainingSourceSummary(trainingIndex) {
  if (!trainingIndex) return null;
  const source = trainingIndex.source?.name || "historical-training";
  const rows = trainingIndex.sample?.rows || 0;
  const lastMatchDate = trainingIndex.sample?.lastMatchDate || null;
  const artifact = trainingIndex.releaseArtifact?.validation || null;
  return {
    version: trainingIndex.version,
    source,
    rows,
    lastMatchDate,
    signature: [trainingIndex.version || "unknown", source, rows, lastMatchDate || "none"].join("|"),
    releaseArtifact: artifact ? {
      entry: trainingIndex.releaseArtifact?.entry || null,
      sourceKind: trainingIndex.releaseArtifact?.sourceKind || "unknown",
      validationOk: artifact.ok === true,
      sha256: artifact.sha256 || null,
      bytes: artifact.bytes ?? null,
      teams: artifact.teams ?? null,
      finiteEloTeams: artifact.finiteEloTeams ?? null,
      minElo: artifact.minElo ?? null,
      maxElo: artifact.maxElo ?? null,
    } : null,
  };
}

function historicalTrainingCutoffMs(trainingIndex) {
  const value = normText(trainingIndex?.sample?.lastMatchDate);
  if (!value) return null;
  const parsed = Date.parse(`${value}T23:59:59.999Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesAfterHistoricalTrainingCutoff(matches, trainingIndex) {
  const cutoffMs = historicalTrainingCutoffMs(trainingIndex);
  if (cutoffMs === null) return [];
  return (Array.isArray(matches) ? matches : []).filter((match) => {
    // The seed already contains every result through sample.lastMatchDate.
    // Incremental Elo must therefore be selected by the event clock, never by
    // a later prediction/publication clock. Using generatedAt here replays old
    // matches whenever legacy rows receive a new prediction and double-counts
    // hundreds of results against the signed training seed.
    const eventMs = Date.parse(
      match?.kickoffTime
      || match?.matchTime
      || match?.matchDate
      || ""
    );
    return Number.isFinite(eventMs) && eventMs > cutoffMs;
  });
}

function seedTeamHistoryFromTraining(teamHistory, trainingIndex) {
  if (!trainingIndex?.teams) return 0;
  let seeded = 0;
  for (const [key, team] of Object.entries(trainingIndex.teams)) {
    const recent = Array.isArray(team?.recent) ? team.recent : [];
    if (!key || !recent.length) continue;
    teamHistory.set(key, recent.slice(-40));
    seeded += 1;
  }
  return seeded;
}

function seedEloFromTraining(ratings, counts, trainingIndex) {
  if (!trainingIndex?.teams) return 0;
  let seeded = 0;
  for (const [key, team] of Object.entries(trainingIndex.teams)) {
    const rawRating = team?.latestElo;
    if (
      !key
      || rawRating === null
      || rawRating === undefined
      || (typeof rawRating === "string" && !rawRating.trim())
    ) continue;
    const rating = Number(rawRating);
    if (!Number.isFinite(rating) || rating < 800 || rating > 2400) continue;
    ratings.set(key, rating);
    counts.set(key, Number(team?.matches || 0));
    seeded += 1;
  }
  return seeded;
}

function leaguePriorKey(value) {
  return teamKey(value);
}

function leaguePriorForMatch(trainingIndex, match) {
  if (!trainingIndex?.leaguePriors) return null;
  const trainingSource = trainingSourceSummary(trainingIndex);
  const profile = matchVolatilityProfile(match);
  if (profile.isInternational) {
    const prior = trainingIndex.leaguePriors.international;
    return prior && Number(prior.matches || 0) >= 500 ? {
      ...prior,
      key: "international",
      source: "historical-international-prior",
      trainingVersion: trainingIndex.version,
      trainingSignature: trainingSource?.signature || trainingIndex.version || null,
    } : null;
  }

  const candidates = [
    match.countryNameEn,
    match.countryName,
    match.leagueNameEn,
    match.leagueName,
  ].map(leaguePriorKey).filter(Boolean);

  for (const key of candidates) {
    const prior = trainingIndex.leaguePriors.countries?.[key];
    if (prior && Number(prior.matches || 0) >= 120) {
      return {
        ...prior,
        key,
        source: "historical-country-prior",
        trainingVersion: trainingIndex.version,
        trainingSignature: trainingSource?.signature || trainingIndex.version || null,
      };
    }
  }

  const global = trainingIndex.leaguePriors.global;
  if (global && Number(global.matches || 0) >= 1000) {
    return {
      ...global,
      key: "global",
      source: "historical-global-prior",
      trainingVersion: trainingIndex.version,
      trainingSignature: trainingSource?.signature || trainingIndex.version || null,
    };
  }
  return null;
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.floor((to - from) / 86400000);
}

function countSince(rows, kickoffTime, days) {
  const kickoff = Date.parse(kickoffTime);
  if (!Number.isFinite(kickoff)) return 0;
  const from = kickoff - days * 86400000;
  return rows.filter((row) => {
    const time = Date.parse(row.kickoffTime);
    return Number.isFinite(time) && time < kickoff && time >= from;
  }).length;
}

function summarizeTeamForm(rows, key, kickoffTime) {
  const recent = rows.slice(-FORM_LOOKBACK_MATCHES);
  const last = rows[rows.length - 1];
  const resultEvidence = require("./recentFormEvidence.cjs").summarizeRecentFormEvidence(recent, key, kickoffTime);
  const empty = {
    sampleSize: 0,
    resultEvidence,
    wins: 0,
    draws: 0,
    losses: 0,
    pointsPerMatch: null,
    goalsForAvg: null,
    goalsAgainstAvg: null,
    goalDiffAvg: null,
    over25Rate: null,
    bttsRate: null,
    cleanSheetRate: null,
    failedScoreRate: null,
    lastMatchAt: last?.kickoffTime || null,
    restDays: last?.kickoffTime ? daysBetween(last.kickoffTime, kickoffTime) : null,
    matchesLast14: countSince(rows, kickoffTime, 14),
    matchesLast30: countSince(rows, kickoffTime, 30),
  };
  if (!recent.length) return empty;

  const totals = recent.reduce((acc, row) => {
    const isHome = row.homeKey === key;
    const goalsFor = isHome ? row.scoreHome : row.scoreAway;
    const goalsAgainst = isHome ? row.scoreAway : row.scoreHome;
    const totalGoals = row.scoreHome + row.scoreAway;
    const points = goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;
    acc.wins += points === 3 ? 1 : 0;
    acc.draws += points === 1 ? 1 : 0;
    acc.losses += points === 0 ? 1 : 0;
    acc.points += points;
    acc.goalsFor += goalsFor;
    acc.goalsAgainst += goalsAgainst;
    acc.over25 += totalGoals >= 3 ? 1 : 0;
    acc.btts += row.scoreHome > 0 && row.scoreAway > 0 ? 1 : 0;
    acc.cleanSheet += goalsAgainst === 0 ? 1 : 0;
    acc.failedScore += goalsFor === 0 ? 1 : 0;
    return acc;
  }, {
    wins: 0,
    draws: 0,
    losses: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    over25: 0,
    btts: 0,
    cleanSheet: 0,
    failedScore: 0,
  });

  const sampleSize = recent.length;
  return {
    sampleSize,
    resultEvidence,
    wins: totals.wins,
    draws: totals.draws,
    losses: totals.losses,
    pointsPerMatch: Number((totals.points / sampleSize).toFixed(2)),
    goalsForAvg: Number((totals.goalsFor / sampleSize).toFixed(2)),
    goalsAgainstAvg: Number((totals.goalsAgainst / sampleSize).toFixed(2)),
    goalDiffAvg: Number(((totals.goalsFor - totals.goalsAgainst) / sampleSize).toFixed(2)),
    over25Rate: Number((totals.over25 / sampleSize).toFixed(3)),
    bttsRate: Number((totals.btts / sampleSize).toFixed(3)),
    cleanSheetRate: Number((totals.cleanSheet / sampleSize).toFixed(3)),
    failedScoreRate: Number((totals.failedScore / sampleSize).toFixed(3)),
    lastMatchAt: last?.kickoffTime || null,
    restDays: last?.kickoffTime ? daysBetween(last.kickoffTime, kickoffTime) : null,
    matchesLast14: countSince(rows, kickoffTime, 14),
    matchesLast30: countSince(rows, kickoffTime, 30),
  };
}

function summarizeHeadToHead(rows) {
  const recent = rows.slice(-8);
  if (!recent.length) {
    return {
      sampleSize: 0,
      over25Rate: null,
      bttsRate: null,
      drawRate: null,
      lastMeetingAt: null,
    };
  }

  const totals = recent.reduce((acc, row) => {
    const totalGoals = row.scoreHome + row.scoreAway;
    acc.over25 += totalGoals >= 3 ? 1 : 0;
    acc.btts += row.scoreHome > 0 && row.scoreAway > 0 ? 1 : 0;
    acc.draws += row.scoreHome === row.scoreAway ? 1 : 0;
    return acc;
  }, { over25: 0, btts: 0, draws: 0 });

  return {
    sampleSize: recent.length,
    over25Rate: Number((totals.over25 / recent.length).toFixed(3)),
    bttsRate: Number((totals.btts / recent.length).toFixed(3)),
    drawRate: Number((totals.draws / recent.length).toFixed(3)),
    lastMeetingAt: recent[recent.length - 1]?.kickoffTime || null,
  };
}

function buildFormSnapshots(matches, historicalTraining = null) {
  const teamHistory = new Map();
  const h2hHistory = new Map();
  const snapshots = new Map();
  const seededTeams = seedTeamHistoryFromTraining(teamHistory, historicalTraining);
  const historicalSource = trainingSourceSummary(historicalTraining);
  const readRows = (map, key) => map.get(key) || [];
  const appendRow = (map, key, row) => {
    const rows = map.get(key) || [];
    rows.push(row);
    if (rows.length > 40) rows.splice(0, rows.length - 40);
    map.set(key, rows);
  };

  const appendObservedResult = (match, observation) => {
    const sourceMatchId = normText(match.sourceMatchId);
    const homeName = matchSideTeamName(match, "home");
    const awayName = matchSideTeamName(match, "away");
    const homeKey = teamKey(homeName);
    const awayKey = teamKey(awayName);
    if (!sourceMatchId || !homeKey || !awayKey) return;
    const row = {
      sourceMatchId,
      homeKey,
      awayKey,
      kickoffTime: match.kickoffTime,
      scoreHome: match.scoreHome,
      scoreAway: match.scoreAway,
      resultObservedAt: observation?.observedAt || null,
      resultObservationSource: observation?.source || null,
    };
    appendRow(teamHistory, homeKey, row);
    appendRow(teamHistory, awayKey, row);
    appendRow(h2hHistory, pairKey(homeName, awayName), row);
  };

  forEachForecastAsOf(matches, {
    onResult: appendObservedResult,
    onForecast: (match, asOf) => {
      const sourceMatchId = normText(match.sourceMatchId);
      const homeName = matchSideTeamName(match, "home");
      const awayName = matchSideTeamName(match, "away");
      const homeKey = teamKey(homeName);
      const awayKey = teamKey(awayName);
      if (!sourceMatchId || !homeKey || !awayKey) return;

      const homeForm = summarizeTeamForm(readRows(teamHistory, homeKey), homeKey, asOf.forecastAt);
      const awayForm = summarizeTeamForm(readRows(teamHistory, awayKey), awayKey, asOf.forecastAt);
      const h2h = summarizeHeadToHead(readRows(h2hHistory, pairKey(homeName, awayName)));
      const sampleSize = homeForm.sampleSize + awayForm.sampleSize;
      snapshots.set(sourceMatchId, {
        version: historicalSource ? "rolling-form-v3-historical-seeded-asof" : "rolling-form-v2-asof",
        lookbackMatches: FORM_LOOKBACK_MATCHES,
        sampleSize,
        historicalSource: historicalSource ? { ...historicalSource, seededTeams } : null,
        asOf: {
          forecastAt: asOf.forecastAt,
          appliedResults: asOf.appliedResults,
          resultObservationPolicy: "attributed non-fallback resultObservedAt<=forecastAt; missing clocks excluded",
        },
        home: homeForm,
        away: awayForm,
        h2h,
      });
    },
  });

  return snapshots;
}

function buildEloSnapshots(matches, historicalTraining = null) {
  const baseRating = 1500;
  const kFactor = 22;
  const ratings = new Map();
  const counts = new Map();
  const snapshots = new Map();
  const seededTeams = seedEloFromTraining(ratings, counts, historicalTraining);
  const historicalSource = trainingSourceSummary(historicalTraining);

  const ratingFor = (key) => ratings.get(key) ?? baseRating;
  const countFor = (key) => counts.get(key) ?? 0;
  const setRating = (key, value) => ratings.set(key, value);
  const addCount = (key) => counts.set(key, countFor(key) + 1);

  const frozenRatings = new Map();
  forEachForecastAsOf(matches, {
    onResult: (match) => {
      const sourceMatchId = normText(match.sourceMatchId);
      const homeKey = teamKey(matchSideTeamName(match, "home"));
      const awayKey = teamKey(matchSideTeamName(match, "away"));
      if (!sourceMatchId || !homeKey || !awayKey) return;
      const frozen = frozenRatings.get(sourceMatchId);
      const homeRating = frozen?.homeRating ?? ratingFor(homeKey);
      const awayRating = frozen?.awayRating ?? ratingFor(awayKey);
      const actualHome = match.scoreHome > match.scoreAway ? 1 : match.scoreHome === match.scoreAway ? 0.5 : 0;
      const expectedHome = eloExpectedScore(homeRating, awayRating);
      const goalDiff = Math.abs(match.scoreHome - match.scoreAway);
      const marginMultiplier = goalDiff <= 1 ? 1 : Math.min(1.75, Math.log(goalDiff + 1));
      const delta = kFactor * marginMultiplier * (actualHome - expectedHome);
      setRating(homeKey, ratingFor(homeKey) + delta);
      setRating(awayKey, ratingFor(awayKey) - delta);
      addCount(homeKey);
      addCount(awayKey);
    },
    onForecast: (match, asOf) => {
      const sourceMatchId = normText(match.sourceMatchId);
      const homeKey = teamKey(matchSideTeamName(match, "home"));
      const awayKey = teamKey(matchSideTeamName(match, "away"));
      if (!sourceMatchId || !homeKey || !awayKey) return;

      const homeRating = ratingFor(homeKey);
      const awayRating = ratingFor(awayKey);
      frozenRatings.set(sourceMatchId, { homeRating, awayRating });
      const probabilities = eloOutcomeProbabilities(homeRating, awayRating);
      snapshots.set(sourceMatchId, {
        version: historicalSource ? "elo-v3-historical-seeded-asof" : "elo-v2-window-asof",
        homeRating,
        awayRating,
        diff: homeRating - awayRating + 62,
        probabilities,
        homeMatches: countFor(homeKey),
        awayMatches: countFor(awayKey),
        historicalSource: historicalSource ? { ...historicalSource, seededTeams } : null,
        asOf: {
          forecastAt: asOf.forecastAt,
          appliedResults: asOf.appliedResults,
          resultObservationPolicy: "attributed non-fallback resultObservedAt<=forecastAt; missing clocks excluded",
        },
        lastUpdatedAt: asOf.forecastAt,
      });
    },
  });

  return snapshots;
}

function isOfficialVoidMatch(match) {
  return Boolean(
    match?.resultDisposition === "VOID"
    && String(match?.voidSource || "").startsWith("sporttery:")
    && String(match?.voidReason || "").trim()
  );
}

function isPredictionSettlementReady(match) {
  return match?.status === "FINISHED" || isOfficialVoidMatch(match);
}

function resultStatus(match, expected, marketType = "", handicapPrediction = null) {
  if (expected === "WATCH") return "PENDING";
  if (isOfficialVoidMatch(match)) return "VOID";
  if (match.status !== "FINISHED") return "PENDING";
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return "PENDING";
  const total = match.scoreHome + match.scoreAway;
  const actual1x2 = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
  if ((marketType === "HHAD" || marketType === "BEST_HHAD") && ["1", "X", "2"].includes(expected)) {
    const handicap = resolveHandicapLine(match, handicapPrediction);
    if (handicap === null) return "PENDING";
    const adjustedHome = match.scoreHome + handicap;
    const actualHhad = adjustedHome > match.scoreAway ? "1" : adjustedHome < match.scoreAway ? "2" : "X";
    return expected === actualHhad ? "WON" : "LOST";
  }
  if ((marketType === "1X2" || marketType === "BEST" || marketType === "") && ["1", "X", "2"].includes(expected)) {
    return expected === actual1x2 ? "WON" : "LOST";
  }
  if (/^[0-6]$/.test(expected)) return total === Number(expected) ? "WON" : "LOST";
  if (expected === "7+") return total >= 7 ? "WON" : "LOST";
  if (expected === "O2.5") return total > 2.5 ? "WON" : "LOST";
  if (expected === "U2.5") return total < 2.5 ? "WON" : "LOST";
  if (expected === "GG") return match.scoreHome > 0 && match.scoreAway > 0 ? "WON" : "LOST";
  if (expected === "NG") return match.scoreHome === 0 || match.scoreAway === 0 ? "WON" : "LOST";
  return expected === actual1x2 ? "WON" : "LOST";
}

function reviewResultLabel(code, market = "HAD", match = null) {
  const home = match?.homeTeamName || match?.homeTeam || "主队";
  const away = match?.awayTeamName || match?.awayTeam || "客队";
  if (market === "GOALS") {
    if (code === "O2.5") return { zh: "大2.5球", en: "Over 2.5" };
    if (code === "U2.5") return { zh: "小2.5球", en: "Under 2.5" };
  }
  if (market === "BTTS") {
    if (code === "GG") return { zh: "双方进球 是", en: "BTTS yes" };
    if (code === "NG") return { zh: "双方进球 否", en: "BTTS no" };
  }
  if (market === "HHAD") {
    if (code === "1") return { zh: "让胜", en: "Handicap home" };
    if (code === "X") return { zh: "让平", en: "Handicap draw" };
    if (code === "2") return { zh: "让负", en: "Handicap away" };
  }
  if (code === "1") return { zh: `主胜 ${home}`, en: `Home win (${home})` };
  if (code === "X") return { zh: "平局", en: "Draw" };
  if (code === "2") return { zh: `客胜 ${away}`, en: `Away win (${away})` };
  return { zh: String(code || "--"), en: String(code || "--") };
}

function predictionMarketForReview(prediction) {
  if (prediction?.oddsPoolCode === "HHAD" && ["1", "X", "2"].includes(prediction.tipCode)) {
    return prediction.marketType === "BEST" ? "BEST_HHAD" : "HHAD";
  }
  return prediction?.marketType || "";
}

function predictionReviewStatus(match, prediction) {
  if (!prediction) return "PENDING";
  return resultStatus(match, prediction.tipCode, predictionMarketForReview(prediction), prediction);
}

function normalizedOddsLeader(odds) {
  const clean = sanitizeOdds(odds);
  if (!clean) return null;
  return [
    ["1", clean.odds1],
    ["X", clean.oddsX],
    ["2", clean.odds2],
  ].sort((a, b) => Number(a[1]) - Number(b[1]))[0]?.[0] || null;
}

function postMatchReviewActuals(match, predictions = match?.predictions) {
  const scoreHome = Number(match.scoreHome);
  const scoreAway = Number(match.scoreAway);
  if (!Number.isFinite(scoreHome) || !Number.isFinite(scoreAway)) return null;
  const totalGoals = scoreHome + scoreAway;
  const had = oneXTwoCodeForScore(scoreHome, scoreAway);
  const handicap = resolveHandicapLine(match, predictions);
  const hhad = handicap === null ? null : scoreOutcomeWithHandicap(scoreHome, scoreAway, handicap);
  return {
    finalScore: `${scoreHome}-${scoreAway}`,
    scoreHome,
    scoreAway,
    totalGoals,
    had,
    hhad,
    handicapLine: handicap,
    overUnder25: totalGoals > 2.5 ? "O2.5" : "U2.5",
    btts: scoreHome > 0 && scoreAway > 0 ? "GG" : "NG",
  };
}

function liveAuditNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function compactLiveRecommendationForAudit(value) {
  if (!value || typeof value !== "object") return null;
  return {
    version: value.version || null,
    eligible: value.eligible === true,
    grade: value.grade || null,
    statisticsTrack: value.statisticsTrack || null,
    evidenceScore: liveAuditNumber(value.evidenceScore),
    probabilityEdge: liveAuditNumber(value.probabilityEdge),
    expectedValue: liveAuditNumber(value.expectedValue),
    dataQuality: liveAuditNumber(value.dataQuality),
    severeMissingCount: liveAuditNumber(value.severeMissingCount),
    coverageMode: value.coverageMode || null,
    dataCoverageWarning: value.dataCoverageWarning === true,
    supportingFactorCount: liveAuditNumber(value.supportingFactorCount),
    blockers: Array.isArray(value.blockers) ? value.blockers.slice(0, 16) : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 16) : [],
  };
}

function compactLivePublicationEvidenceForAudit(value) {
  if (!value || typeof value !== "object") return null;
  return {
    version: value.version || null,
    policyVersion: value.policyVersion || null,
    statisticsTrack: value.statisticsTrack || null,
    matchId: value.matchId || null,
    sourceMatchId: value.sourceMatchId || null,
    market: value.market || null,
    code: value.code || null,
    handicapLine: value.handicapLine ?? null,
    officialSp: value.officialSp ?? null,
    officialSource: value.officialSource || null,
    officialSourceUrl: value.officialSourceUrl || null,
    officialOddsObservedAt: value.officialOddsObservedAt || null,
    officialOddsReceivedAt: value.officialOddsReceivedAt || null,
    officialOddsClockSource: value.officialOddsClockSource || null,
    officialOddsMaxAgeSeconds: value.officialOddsMaxAgeSeconds ?? null,
    publishedAt: value.publishedAt || null,
    cutoffAt: value.cutoffAt || null,
  };
}

function restoreCompactedLivePublicationEvidenceFromSnapshot(snapshot, tip, oddsPoolCode) {
  const publication = compactLivePublicationEvidenceForAudit(tip?.livePublicationEvidence);
  if (!publication) return null;
  if (
    publication.officialOddsClockSource
    && publication.officialOddsMaxAgeSeconds !== null
    && (publication.officialOddsObservedAt || publication.officialOddsReceivedAt)
  ) {
    return publication;
  }

  const pool = oddsPoolCode === "HHAD" ? "HHAD" : "HAD";
  const marketKey = pool === "HHAD" ? "hhad" : "had";
  const market = snapshot?.featureSnapshot?.market?.[marketKey];
  const sourceMatchId = normText(snapshot?.sourceMatchId);
  const marketSourceMatchId = normText(
    market?.provenance?.market?.sourceMatchId
    || market?.provenance?.extraction?.sourceMatchId
  );
  const endpointUrl = normText(market?.provenance?.endpoint?.url);
  const expectedOddsKey = publication.code === "1"
    ? "odds1"
    : publication.code === "X"
      ? "oddsX"
      : publication.code === "2"
        ? "odds2"
        : null;
  const snapshotOdds = expectedOddsKey ? Number(market?.odds?.[expectedOddsKey]) : Number.NaN;
  const publicationOdds = Number(publication.officialSp);
  const lineMatches = pool !== "HHAD" || (
    parseHandicapLine(market?.handicapLine) !== null
    && parseHandicapLine(market?.handicapLine) === parseHandicapLine(publication.handicapLine)
  );
  if (
    publication.version !== "live-recommendation-publication-v2"
    || !sourceMatchId
    || sourceMatchId !== normText(publication.sourceMatchId)
    || marketSourceMatchId !== sourceMatchId
    || normText(market?.source) !== normText(publication.officialSource)
    || endpointUrl !== normText(publication.officialSourceUrl)
    || !Number.isFinite(snapshotOdds)
    || !Number.isFinite(publicationOdds)
    || Math.abs(snapshotOdds - publicationOdds) > 0.001
    || !lineMatches
  ) {
    return publication;
  }

  const publishedAtMs = parseBeijingDateTime(publication.publishedAt);
  const maxAgeMs = LIVE_OFFICIAL_ODDS_MAX_AGE_MS;
  const normalizedObservedAt = Number.isFinite(Date.parse(market?.observedAt || ""))
    ? new Date(Date.parse(market.observedAt)).toISOString()
    : null;
  const normalizedReceivedAt = Number.isFinite(Date.parse(market?.receivedAt || ""))
    ? new Date(Date.parse(market.receivedAt)).toISOString()
    : null;
  const clocks = [
    { source: "receivedAt", value: normalizedReceivedAt },
    { source: "observedAt", value: normalizedObservedAt },
  ];
  const clock = clocks.find((candidate) => {
    const clockMs = Date.parse(candidate.value || "");
    return Number.isFinite(publishedAtMs)
      && Number.isFinite(clockMs)
      && clockMs <= publishedAtMs
      && publishedAtMs - clockMs <= maxAgeMs;
  });
  if (!clock) return publication;

  return {
    ...publication,
    officialOddsObservedAt: normalizedObservedAt,
    officialOddsReceivedAt: normalizedReceivedAt,
    officialOddsClockSource: clock.source,
    officialOddsMaxAgeSeconds: maxAgeMs / 1000,
  };
}

function isArchivedLiveRecommendation(match, prediction) {
  const officialHandicapLine = prediction?.oddsPoolCode === "HHAD"
    ? prediction?.handicapLine
    : 0;
  return Boolean(
    prediction?.marketType === "BEST"
    && isPublishedLiveRecommendationEligible(
      prediction,
      prediction?.livePublicationEvidence?.officialSp ?? prediction?.odds,
      prediction?.livePublicationEvidence?.handicapLine ?? officialHandicapLine,
      match
    )
  );
}

function buildPredictionReviewRows(match, actuals, publicationIndex = null) {
  const predictions = Array.isArray(match.predictions) ? match.predictions : [];
  return predictions
    .filter((prediction) => prediction && prediction.tipCode !== "WATCH")
    .map((prediction) => {
      const status = predictionReviewStatus(match, prediction);
      const officialOdds = Number(prediction.odds);
      // Settled snapshots may intentionally clear the mutable match-level line.
      // Eligibility must use the immutable line archived on the prediction first.
      const officialHandicapLine = prediction.oddsPoolCode === "HHAD"
        ? (prediction.handicapLine ?? match.handicapLine)
        : 0;
      const publication = resolvePublishedRecommendation(match, prediction, publicationIndex);
      const isMainRecommendation = Boolean(publication) && isOfficialRecommendationEligible(
        prediction,
        officialOdds,
        officialHandicapLine
      );
      const isLiveRecommendation = !isMainRecommendation && isArchivedLiveRecommendation(match, prediction);
      const recommendationAction = isMainRecommendation ? "recommend" : "reference";
      const recommendationTier = isMainRecommendation
        ? (prediction.recommendationTier || "multi-factor")
        : (prediction.recommendationTier || "reference");
      const market = prediction.oddsPoolCode === "HHAD" && ["1", "X", "2"].includes(prediction.tipCode)
        ? "HHAD"
        : prediction.marketType === "GOALS"
          ? "GOALS"
          : prediction.marketType === "GG_NG"
            ? "BTTS"
            : "HAD";
      const resolvedHandicap = market === "HHAD" ? resolveHandicapLine(match, prediction) : null;
      const actualCode = market === "HHAD"
        ? (resolvedHandicap === null
          ? null
          : scoreOutcomeWithHandicap(actuals.scoreHome, actuals.scoreAway, resolvedHandicap))
        : market === "GOALS"
          ? actuals.overUnder25
          : market === "BTTS"
            ? actuals.btts
            : actuals.had;
      const frozenVersion = !isMainRecommendation && !isLiveRecommendation
        ? require("../src/services/frozenReviewVersion.cjs").compactFrozenReviewVersion(prediction.frozenVersion, prediction) : null;
      return {
        marketType: prediction.marketType,
        oddsPoolCode: prediction.oddsPoolCode || (market === "HAD" ? "HAD" : undefined),
        handicapLine: market === "HHAD" && resolvedHandicap !== null
          ? formatHandicapLineForCopy(resolvedHandicap)
          : undefined,
        tipCode: prediction.tipCode,
        tipLabel: prediction.tipLabel,
        odds: Number.isFinite(officialOdds) && (officialOdds > 1 || (officialOdds === 0 && frozenVersion)) ? officialOdds : undefined,
        actualCode,
        actualLabel: reviewResultLabel(actualCode, market, match),
        resultStatus: status,
        trustScore: prediction.trustScore,
        recommendationAction,
        recommendationTier,
        liveRecommendationAction: isLiveRecommendation ? "recommend" : "withhold",
        liveRecommendationTier: prediction.liveRecommendationTier || (isLiveRecommendation ? "live" : "live-withhold"),
        liveRecommendation: compactLiveRecommendationForAudit(prediction.liveRecommendation),
        livePublicationEvidence: compactLivePublicationEvidenceForAudit(prediction.livePublicationEvidence),
        performanceTrack: isMainRecommendation ? "formal" : isLiveRecommendation ? "live-model" : "reference",
        ...(frozenVersion ? { frozenVersion } : {}),
        reviewRole: isMainRecommendation ? "main" : "reference",
        publicationId: publication?.publicationId || null,
        publicationEvidence: publication ? prediction.publicationEvidence : null,
      };
    });
}

function predictionPartsFromSnapshotSignature(signature, marketType) {
  const part = String(signature || "").split("|").find((item) => item.startsWith(`${marketType}:`));
  if (!part) return null;
  const [, oddsPoolCode = "", tipCode = "", recommendationAction = "reference"] = part.split(":");
  return {
    oddsPoolCode: oddsPoolCode || undefined,
    tipCode: tipCode || "WATCH",
    recommendationAction: recommendationAction || "reference",
  };
}

function predictionFromSnapshotTip(snapshot, marketType) {
  const key = marketType === "1X2" ? "oneXTwo" : marketType.toLowerCase();
  const tip = snapshot?.[key];
  const parts = predictionPartsFromSnapshotSignature(snapshot?.signature, marketType) || {};
  if (!tip && !parts.tipCode) return null;
  const tipCode = tip?.tipCode || parts.tipCode;
  if (!tipCode || tipCode === "WATCH") return null;
  const oddsPoolCode = tip?.oddsPoolCode || parts.oddsPoolCode || (marketType === "GOALS" ? undefined : "HAD");
  return {
    marketType,
    oddsPoolCode,
    handicapLine: oddsPoolCode === "HHAD" ? (tip?.handicapLine ?? snapshot?.handicapLine) : undefined,
    tipCode,
    tipLabel: tip?.tipLabel,
    odds: tip?.odds || 0,
    trustScore: tip?.trustScore,
    recommendationAction: tip?.recommendationAction || parts.recommendationAction || "reference",
    recommendationTier: tip?.recommendationTier || "reference",
    liveRecommendationAction: tip?.liveRecommendationAction || "withhold",
    liveRecommendationTier: tip?.liveRecommendationTier || "live-withhold",
    liveRecommendation: compactLiveRecommendationForAudit(tip?.liveRecommendation),
    livePublicationEvidence: restoreCompactedLivePublicationEvidenceFromSnapshot(
      snapshot,
      tip,
      oddsPoolCode
    ),
    publicationId: tip?.publicationId || null,
    publicationEvidence: tip?.publicationEvidence || null,
    multiFactorEvidence: tip?.multiFactorEvidence || null,
    riskTags: Array.from({ length: Math.max(0, Number(tip?.riskCount || 0)) }, () => ({ zh: "快照风险", en: "Snapshot risk" })),
  };
}

function predictionsFromSnapshot(snapshot) {
  return ["1X2", "GOALS", "BEST"]
    .map((marketType) => predictionFromSnapshotTip(snapshot, marketType))
    .filter(Boolean);
}

function predictionsFromPriorReview(priorReview) {
  const rows = Array.isArray(priorReview?.predictionReview?.rows)
    ? priorReview.predictionReview.rows
    : [];
  return rows
    .filter((row) => row && row.tipCode && row.tipCode !== "WATCH")
    .map((row) => ({
      marketType: row.marketType,
      oddsPoolCode: row.oddsPoolCode,
      handicapLine: row.oddsPoolCode === "HHAD" ? row.handicapLine : undefined,
      tipCode: row.tipCode,
      tipLabel: row.tipLabel,
      odds: row.odds,
      trustScore: row.trustScore,
      recommendationAction: "reference",
      recommendationTier: row.recommendationTier || "reference",
      liveRecommendationAction: row.liveRecommendationAction || "withhold",
      liveRecommendationTier: row.liveRecommendationTier || "live-withhold",
      liveRecommendation: compactLiveRecommendationForAudit(row.liveRecommendation),
      livePublicationEvidence: compactLivePublicationEvidenceForAudit(row.livePublicationEvidence),
      publicationId: row.publicationId || null,
      publicationEvidence: row.publicationEvidence || null,
      ...(row.frozenVersion ? { frozenVersion: require("../src/services/frozenReviewVersion.cjs").compactFrozenReviewVersion(row.frozenVersion, row) } : {}),
    }));
}

function reviewSelectionKey(row) {
  if (!row || typeof row !== "object") return null;
  const marketType = normText(row.marketType).toUpperCase();
  const oddsPoolCode = normText(row.oddsPoolCode || (marketType === "1X2" ? "HAD" : "")).toUpperCase();
  const tipCode = normText(row.tipCode).toUpperCase();
  const line = oddsPoolCode === "HHAD" ? parseHandicapLine(row.handicapLine) : 0;
  const odds = Number(row.odds);
  if (!marketType || !["HAD", "HHAD"].includes(oddsPoolCode) || !["1", "X", "2"].includes(tipCode)) return null;
  if (line === null || !Number.isFinite(odds) || odds <= 1) return null;
  return `${marketType}|${oddsPoolCode}|${tipCode}|${line}|${odds.toFixed(4)}`;
}

function validPublicationBindingShape(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const hash = /^[a-f0-9]{64}$/;
  const expectedKeys = [
    "cutoffTime",
    "evidenceHash",
    "featureHash",
    "publishedAt",
    "recordHash",
    "strategyHash",
    "version",
  ];
  const publishedAt = Date.parse(binding.publishedAt || "");
  const cutoffTime = Date.parse(binding.cutoffTime || "");
  return Object.keys(binding).sort().join("|") === expectedKeys.join("|")
    && binding.version === "recommendation-publication-binding-v1"
    && hash.test(normText(binding.recordHash).toLowerCase())
    && hash.test(normText(binding.strategyHash).toLowerCase())
    && hash.test(normText(binding.evidenceHash).toLowerCase())
    && hash.test(normText(binding.featureHash).toLowerCase())
    && Number.isFinite(publishedAt)
    && Number.isFinite(cutoffTime)
    && publishedAt <= cutoffTime;
}

function lockedVerifiedPublicationRows(priorReview) {
  const settlement = priorReview?.settlement;
  const publicationId = normText(settlement?.publicationId);
  if (
    settlement?.publicationVerified !== true
    || !/^pub_[a-f0-9]{32}$/.test(publicationId)
  ) return new Map();
  const rows = Array.isArray(priorReview?.predictionReview?.rows)
    ? priorReview.predictionReview.rows
    : [];
  const verified = new Map();
  for (const row of rows) {
    const key = reviewSelectionKey(row);
    if (
      key
      && row.reviewRole === "main"
      && row.recommendationAction === "recommend"
      && normText(row.publicationId) === publicationId
      && validPublicationBindingShape(row.publicationEvidence)
    ) {
      verified.set(key, row);
    }
  }
  return verified;
}

function restoreLedgerVerifiedPublicationRow(match, row, priorSettlement, publicationIndex) {
  const publicationId = normText(priorSettlement?.publicationId);
  if (
    !publicationIndex?.valid
    || !(publicationIndex.byId instanceof Map)
    || !/^pub_[a-f0-9]{32}$/.test(publicationId)
  ) return null;
  const record = publicationIndex.byId.get(publicationId);
  if (!record) return null;
  const matchId = normText(match?.id);
  const sourceMatchId = normText(match?.sourceMatchId || matchId.replace(/^sporttery_/, ""));
  const rowMarketType = normText(row?.marketType).toUpperCase();
  const rowPool = normText(row?.oddsPoolCode || (rowMarketType === "1X2" ? "HAD" : "")).toUpperCase();
  const rowLine = rowPool === "HHAD" ? parseHandicapLine(row?.handicapLine) : 0;
  const recordLine = parseHandicapLine(record.handicapLine);
  const rowOdds = Number(row?.odds);
  const recordOdds = Number(record.odds);
  const cutoffMillis = Date.parse(match?.predictionMeta?.cutoffTime || match?.buyEndTime || match?.kickoffTime || "");
  const cutoff = Number.isFinite(cutoffMillis) ? new Date(cutoffMillis).toISOString() : null;
  const kickoff = Date.parse(match?.kickoffTime || "");
  if (
    matchId !== record.matchId
    || sourceMatchId !== record.sourceMatchId
    || rowMarketType !== record.selectionRole
    || rowPool !== record.marketType
    || normText(row?.tipCode).toUpperCase() !== record.tipCode
    || rowLine === null
    || recordLine === null
    || rowLine !== recordLine
    || !Number.isFinite(rowOdds)
    || !Number.isFinite(recordOdds)
    || Number(rowOdds.toFixed(4)) !== Number(recordOdds.toFixed(4))
    || (cutoff && cutoff !== record.cutoffTime)
    || (Number.isFinite(kickoff) && Date.parse(record.publishedAt) > kickoff)
  ) return null;
  return {
    ...row,
    recommendationAction: "recommend",
    recommendationTier: row.recommendationTier || "multi-factor",
    reviewRole: "main",
    publicationId,
    publicationEvidence: publicationBindingForRecord(record),
  };
}

function sourceMatchKeyForReview(match) {
  return normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
}

function buildPredictionSnapshotIndex(predictionSnapshotsPayload) {
  const bySourceId = new Map();
  const rows = Array.isArray(predictionSnapshotsPayload?.rows) ? predictionSnapshotsPayload.rows : [];
  for (const row of rows) {
    const sourceMatchId = sourceMatchKeyForReview(row);
    if (!sourceMatchId) continue;
    if (!bySourceId.has(sourceMatchId)) bySourceId.set(sourceMatchId, []);
    bySourceId.get(sourceMatchId).push(row);
  }
  for (const snapshots of bySourceId.values()) {
    snapshots.sort((a, b) => parseBeijingDateTime(a.capturedAt) - parseBeijingDateTime(b.capturedAt));
  }
  return bySourceId;
}

const PRE_MATCH_SNAPSHOT_PHASES = new Set(["baseline", "mid", "late", "final", "locked"]);

function sameSnapshotEvent(match, snapshot) {
  if (!match || !snapshot) return false;
  const matchSourceId = sourceMatchKeyForReview(match);
  const snapshotSourceId = sourceMatchKeyForReview(snapshot);
  if (!matchSourceId || !snapshotSourceId || matchSourceId !== snapshotSourceId) return false;

  // Sporttery keeps the provider match id and event clock stable while team
  // display names may move between the 500.com alias and the canonical entity
  // name (for example "AIK Solna" -> "Solna"). When both event clocks are
  // present, provider id + exact event time is the stronger immutable identity.
  // This also keeps the reused-id guard: a different kickoff/event revision is
  // still rejected before any archived prediction can be replayed.
  const matchEventTime = parseBeijingDateTime(match.eventVersion || match.kickoffTime || "");
  const snapshotEventTime = parseBeijingDateTime(snapshot.eventVersion || snapshot.kickoffTime || "");
  const matchKickoffTime = parseBeijingDateTime(match.kickoffTime || "");
  const snapshotKickoffTime = parseBeijingDateTime(snapshot.kickoffTime || "");
  if (
    [matchEventTime, snapshotEventTime, matchKickoffTime, snapshotKickoffTime]
      .every(Number.isFinite)
  ) {
    return matchEventTime === snapshotEventTime
      && matchKickoffTime === snapshotKickoffTime;
  }

  const matchIdentity = {
    sourceMatchId: matchSourceId,
    kickoffTime: match.kickoffTime || null,
    eventVersion: match.eventVersion || match.kickoffTime || null,
  };
  const snapshotIdentity = {
    sourceMatchId: snapshotSourceId,
    kickoffTime: snapshot.kickoffTime || null,
    eventVersion: snapshot.eventVersion || snapshot.kickoffTime || null,
  };

  for (const side of ["home", "away"]) {
    const idKey = `${side}TeamId`;
    const nameKey = `${side}TeamName`;
    const matchTeamId = normText(match[idKey]);
    const snapshotTeamId = normText(snapshot[idKey]);
    if (matchTeamId && snapshotTeamId) {
      matchIdentity[idKey] = matchTeamId;
      snapshotIdentity[idKey] = snapshotTeamId;
      continue;
    }

    const matchTeamName = normText(match[nameKey] || match[`${side}Team`]);
    const snapshotTeamName = normText(snapshot[nameKey] || snapshot[`${side}Team`]);
    if (!matchTeamName || !snapshotTeamName) return false;
    matchIdentity[nameKey] = matchTeamName;
    snapshotIdentity[nameKey] = snapshotTeamName;
  }

  // Snapshot rows intentionally omit internal team ids. Compare the common
  // identity representation (ids when both sides captured them, otherwise
  // names) while retaining sameEvent's source-id and event-version guards.
  return sameEvent(matchIdentity, snapshotIdentity);
}

function isEligiblePreMatchSnapshot(match, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (snapshot.auditRole === "shadow-candidate") return false;
  const phase = normText(snapshot.phase).toLowerCase();
  if (phase && !PRE_MATCH_SNAPSHOT_PHASES.has(phase)) return false;

  const capturedTime = parseBeijingDateTime(snapshot.capturedAt || "");
  if (!Number.isFinite(capturedTime)) return false;
  const deadlines = [
    parseBeijingDateTime(matchCutoffValue(match)),
    parseBeijingDateTime(snapshot.cutoffTime || ""),
    parseBeijingDateTime(match?.kickoffTime || ""),
  ].filter(Number.isFinite);
  if (!deadlines.length) return false;
  return capturedTime <= Math.min(...deadlines);
}

function fallbackPredictionsFromSnapshots(match, snapshotIndex, publicationIndex = null) {
  if (!snapshotIndex) return [];
  const sourceMatchId = sourceMatchKeyForReview(match);
  const snapshots = sourceMatchId ? snapshotIndex.get(sourceMatchId) || [] : [];
  if (!snapshots.length) return [];
  const candidates = snapshots.filter((snapshot) => (
    isEligiblePreMatchSnapshot(match, snapshot)
    && predictionsFromSnapshot(snapshot).length > 0
  )).sort((a, b) => (
    parseBeijingDateTime(a.capturedAt) - parseBeijingDateTime(b.capturedAt)
  ));
  const selected = candidates[candidates.length - 1];
  const selectedPredictions = predictionsFromSnapshot(selected);
  if (!selectedPredictions.length) return [];

  // The latest qualified snapshot owns ordinary reference analysis. A live
  // publication is different: once exposed, a later runtime downgrade cannot
  // erase it from the audit trail. Retain the first snapshot whose immutable
  // publication record still validates, while keeping one BEST row per match.
  const retainedLiveBest = candidates
    .map((snapshot) => predictionsFromSnapshot(snapshot)
      .find((prediction) => prediction?.marketType === "BEST"))
    .find((prediction) => prediction && isArchivedLiveRecommendation(match, prediction));
  if (!retainedLiveBest) return selectedPredictions;

  const selectedBest = selectedPredictions.find((prediction) => prediction?.marketType === "BEST");
  const selectedOfficialOdds = Number(selectedBest?.odds);
  const selectedOfficialHandicapLine = selectedBest?.oddsPoolCode === "HHAD"
    ? (selectedBest?.handicapLine ?? match?.handicapLine)
    : 0;
  const selectedFormalPublication = selectedBest
    ? resolvePublishedRecommendation(match, selectedBest, publicationIndex)
    : null;
  const selectedIsVerifiedFormal = Boolean(selectedFormalPublication)
    && isOfficialRecommendationEligible(
      selectedBest,
      selectedOfficialOdds,
      selectedOfficialHandicapLine
    );
  if (selectedIsVerifiedFormal) return selectedPredictions;
  if (!selectedBest) return [...selectedPredictions, retainedLiveBest];
  return selectedPredictions.map((prediction) => (
    prediction?.marketType === "BEST" ? retainedLiveBest : prediction
  ));
}

function archivedTipLabel(match, prediction) {
  if (
    prediction?.tipLabel
    && typeof prediction.tipLabel === "object"
    && normText(prediction.tipLabel.zh)
    && normText(prediction.tipLabel.en)
  ) {
    return prediction.tipLabel;
  }
  const code = normText(prediction?.tipCode).toUpperCase();
  const home = normText(match?.homeTeamName || match?.homeTeam) || "主队";
  const away = normText(match?.awayTeamName || match?.awayTeam) || "客队";
  if (code === "1") {
    return { zh: `赛前归档 主胜 ${home}`, en: `Pre-match archive: Home win (${home})` };
  }
  if (code === "X") {
    return { zh: "赛前归档 平局", en: "Pre-match archive: Draw" };
  }
  return { zh: `赛前归档 客胜 ${away}`, en: `Pre-match archive: Away win (${away})` };
}

function validArchivedPreMatchPrediction(match, archive = match?.archivedPreMatchPrediction) {
  if (!match || !archive || typeof archive !== "object") return null;
  const prediction = archive.prediction;
  const marketEvidenceScope = normText(archive.marketEvidenceScope) || "result-pool";
  const archivedPool = normText(prediction?.oddsPoolCode).toUpperCase();
  const archivedOdds = Number(prediction?.odds);
  const archivedHandicapLine = archivedPool === "HHAD"
    ? parseHandicapLine(prediction?.handicapLine)
    : 0;
  const modelOnlyReference = marketEvidenceScope === "model-only-reference"
    && ["HAD", "HHAD"].includes(archivedPool)
    && (archivedPool !== "HHAD" || archivedHandicapLine !== null)
    && prediction?.recommendationAction === "reference"
    && archivedOdds === 0;
  const sourceMatchId = sourceMatchKeyForReview(match);
  const archivedSourceMatchId = normText(archive.sourceMatchId).replace(/^sporttery_/, "");
  const kickoffMs = parseBeijingDateTime(match?.kickoffTime || "");
  const archiveDeadlineMs = Math.min(...[
    parseBeijingDateTime(matchCutoffValue(match)),
    parseBeijingDateTime(archive.cutoffTime || ""),
    kickoffMs,
  ].filter(Number.isFinite));
  const eventMs = parseBeijingDateTime(match?.eventVersion || match?.kickoffTime || "");
  const archivedEventMs = parseBeijingDateTime(archive.eventVersion || archive.kickoffTime || "");
  const capturedMs = parseBeijingDateTime(archive.capturedAt || "");
  if (
    archive.version !== "archived-pre-match-prediction-v1"
    || archive.source !== "immutable-pre-match-prediction-snapshot"
    || !sourceMatchId
    || archivedSourceMatchId !== sourceMatchId
    || !Number.isFinite(kickoffMs)
    || !Number.isFinite(eventMs)
    || eventMs !== archivedEventMs
    || !Number.isFinite(capturedMs)
    || capturedMs >= kickoffMs
    || !Number.isFinite(archiveDeadlineMs)
    || capturedMs > archiveDeadlineMs
    || prediction?.marketType !== "BEST"
    || !["result-pool", "model-only-reference"].includes(marketEvidenceScope)
    || !["HAD", "HHAD"].includes(archivedPool)
    || !["1", "X", "2"].includes(normText(prediction?.tipCode).toUpperCase())
    || (marketEvidenceScope === "model-only-reference" && !modelOnlyReference)
  ) {
    return null;
  }
  return archive;
}

function mergeArchivedBestPrediction(match, predictions) {
  const archived = validArchivedPreMatchPrediction(match);
  if (!archived) return Array.isArray(predictions) ? predictions.filter(Boolean) : [];
  const archivedBest = {
    ...archived.prediction,
    resultStatus: "PENDING",
  };
  const rows = Array.isArray(predictions) ? predictions.filter(Boolean) : [];
  let replaced = false;
  const merged = rows.map((prediction) => {
    if (prediction?.marketType !== "BEST") return prediction;
    replaced = true;
    return archivedBest;
  });
  return replaced ? merged : [...merged, archivedBest];
}

function archiveDirectionIdentity(prediction) {
  if (!prediction || typeof prediction !== "object") return null;
  const marketType = normText(prediction.marketType).toUpperCase();
  const poolCode = normText(
    prediction.oddsPoolCode
      || (marketType === "1X2" ? "HAD" : "")
      || (
        prediction.recommendationAction === "reference"
        && Number(prediction.odds) === 0
          ? "HAD"
          : ""
      )
  ).toUpperCase();
  const tipCode = normText(prediction.tipCode).toUpperCase();
  if (!["HAD", "HHAD"].includes(poolCode) || !["1", "X", "2"].includes(tipCode)) {
    return null;
  }
  const handicapLine = poolCode === "HHAD"
    ? parseHandicapLine(prediction.handicapLine)
    : 0;
  if (handicapLine === null) return null;
  return `${poolCode}:${tipCode}:${handicapLine}`;
}

function canonicalArchiveParityRecovery(match) {
  const archive = validArchivedPreMatchPrediction(match);
  const correction = archive?.recoveryEvidence;
  if (
    correction?.version !== "published-direction-archive-parity-v1"
    || correction?.reason !== "archived-direction-diverged-from-user-visible-published-direction"
  ) return null;

  const source = normText(correction.source);
  if (![
    "formal-publication-ledger",
    "live-publication-ledger",
    "public-reference-decision",
    "immutable-analysis-reference-decision",
    "dual-market-decision-binding",
    "trusted-pre-cutoff-decision",
  ].includes(source)) return null;

  const archiveDirection = archiveDirectionIdentity(archive.prediction);
  const canonicalMarket = normText(correction?.canonical?.market).toUpperCase();
  const canonicalDirection = normText(correction?.canonical?.direction).toUpperCase();
  const canonicalIdentity = normText(correction?.canonical?.directionIdentity);
  const previousMarket = normText(correction?.previous?.market).toUpperCase();
  const previousDirection = normText(correction?.previous?.direction).toUpperCase();
  const previousIdentity = normText(correction?.previous?.directionIdentity);
  if (
    !archiveDirection
    || !["HAD", "HHAD"].includes(canonicalMarket)
    || !["1", "X", "2"].includes(canonicalDirection)
    || canonicalIdentity !== archiveDirection
    || canonicalMarket !== normText(archive?.prediction?.oddsPoolCode).toUpperCase()
    || canonicalDirection !== normText(archive?.prediction?.tipCode).toUpperCase()
    || !["HAD", "HHAD"].includes(previousMarket)
    || !["1", "X", "2"].includes(previousDirection)
    || !previousIdentity
    || previousIdentity === canonicalIdentity
    || !previousIdentity.startsWith(`${previousMarket}:${previousDirection}:`)
  ) return null;

  const proof = correction?.proof && typeof correction.proof === "object"
    ? correction.proof
    : {};
  const proofIdentity = normText(
    proof.recordHash
      || proof.bindingHash
      || proof.contentHash
      || proof.publicationId
      || proof.featureSnapshotHash
      || proof.decisionId
  );
  if (!proofIdentity) return null;

  const kickoffMs = parseBeijingDateTime(match?.kickoffTime || "");
  const cutoffMs = parseBeijingDateTime(matchCutoffValue(match));
  const deadlineMs = Math.min(...[cutoffMs, kickoffMs].filter(Number.isFinite));
  const proofAt = [proof.publishedAt, proof.decisionAt]
    .map(validAuditInstant)
    .find((value) => {
      const valueMs = parseBeijingDateTime(value || "");
      return Number.isFinite(valueMs)
        && Number.isFinite(deadlineMs)
        && Number.isFinite(kickoffMs)
        && valueMs <= deadlineMs
        && valueMs < kickoffMs;
    });
  const correctedAtMs = parseBeijingDateTime(correction.correctedAt || "");
  if (
    !proofAt
    || !Number.isFinite(correctedAtMs)
    || correctedAtMs < parseBeijingDateTime(proofAt)
  ) return null;

  const attestationSignature = [
    "published-direction-attestation-v1",
    source,
    archiveDirection,
    proofIdentity,
  ].join(":");
  if (
    normText(archive.signature).startsWith("published-direction-attestation-v1:")
    && archive.signature !== attestationSignature
  ) return null;

  return {
    prediction: archive.prediction,
    source,
    proof,
    archive,
  };
}

function canonicalArchiveBestPrediction(match, publicationIndex = null) {
  const currentBest = (Array.isArray(match?.predictions) ? match.predictions : [])
    .find((prediction) => (
      prediction?.marketType === "BEST"
      && archiveDirectionIdentity(prediction)
    ));

  if (currentBest) {
    const formalPublication = resolvePublishedRecommendation(
      match,
      currentBest,
      publicationIndex
    );
    if (formalPublication) {
      return {
        prediction: currentBest,
        source: "formal-publication-ledger",
        proof: {
          publicationId: formalPublication.publicationId || currentBest.publicationId || null,
          recordHash: formalPublication.recordHash || currentBest?.publicationEvidence?.recordHash || null,
          publishedAt: formalPublication.publishedAt
            || formalPublication.createdAt
            || currentBest?.publicationEvidence?.publishedAt
            || null,
        },
      };
    }
    if (isArchivedLiveRecommendation(match, currentBest)) {
      return {
        prediction: currentBest,
        source: "live-publication-ledger",
        proof: {
          publicationId: currentBest?.livePublicationEvidence?.publicationId || null,
          recordHash: currentBest?.livePublicationEvidence?.recordHash || null,
          publishedAt: currentBest?.livePublicationEvidence?.publishedAt
            || currentBest?.livePublicationEvidence?.createdAt
            || null,
        },
      };
    }
  }

  // A parity repair was created only after a strong pre-cutoff publication or
  // decision proof showed that a legacy archive disagreed with the direction
  // users had actually seen. Result-feed reconstruction can later lose the
  // original binding and rediscover a different raw snapshot, so preserve the
  // validated repair ahead of reconstructed snapshot/binding candidates.
  const parityRecovery = canonicalArchiveParityRecovery(match);
  if (parityRecovery) return parityRecovery;

  const publicReference = require("../src/services/publicReferenceDecision.cjs")
    .attestPublicReferenceDecision(match?.predictionMeta?.publicReferenceDecision, match);
  if (publicReference) return {
    prediction: publicReference.prediction,
    source: "public-reference-decision",
    proof: { contentHash: publicReference.contentHash, decisionAt: publicReference.recordedAt },
  };

  const immutableReference = attestImmutableAnalysisReferenceDecision(
    match?.predictionMeta?.immutableAnalysisReferenceDecision,
    match
  );
  if (immutableReference) {
    return {
      prediction: {
        marketType: "BEST",
        oddsPoolCode: "HAD",
        handicapLine: undefined,
        tipCode: immutableReference.code,
        tipLabel: currentBest?.tipCode === immutableReference.code
          ? currentBest.tipLabel
          : undefined,
        odds: Number(immutableReference.selectedSourceOdds || 0),
        trustScore: Math.round(Number(immutableReference.marketProbability || 0) * 100),
        recommendationAction: "reference",
        recommendationTier: "immutable-five-hundred-analysis-reference",
        liveRecommendationAction: "withhold",
        liveRecommendationTier: "live-withhold",
      },
      source: "immutable-analysis-reference-decision",
      proof: {
        contentHash: immutableReference.contentHash || null,
        decisionAt: immutableReference.decisionAt || null,
      },
    };
  }

  const binding = validExistingDualMarketDecisionBinding(match);
  if (binding?.had && ["1", "X", "2"].includes(normText(binding.had.code).toUpperCase())) {
    const bindingCode = normText(binding.had.code).toUpperCase();
    const matchingCurrent = currentBest
      && normText(currentBest.oddsPoolCode || "HAD").toUpperCase() === "HAD"
      && normText(currentBest.tipCode).toUpperCase() === bindingCode
      ? currentBest
      : null;
    return {
      prediction: {
        ...(matchingCurrent || {}),
        marketType: "BEST",
        oddsPoolCode: "HAD",
        handicapLine: undefined,
        tipCode: bindingCode,
        odds: Number(binding.had.odds),
        trustScore: Number.isFinite(Number(matchingCurrent?.trustScore))
          ? Number(matchingCurrent.trustScore)
          : Math.round(Number(binding.had.modelProbability || 0) * 100),
        recommendationAction: binding.had.recommendationAction
          || matchingCurrent?.recommendationAction
          || "reference",
        recommendationTier: matchingCurrent?.recommendationTier
          || "atomic-dual-market-bound-reference",
        liveRecommendationAction: matchingCurrent?.liveRecommendationAction || "withhold",
        liveRecommendationTier: matchingCurrent?.liveRecommendationTier || "live-withhold",
      },
      source: "dual-market-decision-binding",
      proof: {
        bindingHash: binding.bindingHash || null,
        sourceCycleId: binding.sourceCycleId || null,
        decisionAt: binding?.sourceClocks?.decisionAt || null,
      },
    };
  }

  const cutoffMs = parseBeijingDateTime(matchCutoffValue(match));
  if (currentBest && trustedPreCutoffDecision(match, cutoffMs)) {
    const normalizedPool = normText(currentBest.oddsPoolCode).toUpperCase()
      || (
        currentBest.recommendationAction === "reference"
        && Number(currentBest.odds || 0) === 0
          ? "HAD"
          : ""
      );
    const normalizedPrediction = {
      ...currentBest,
      oddsPoolCode: normalizedPool,
      handicapLine: normalizedPool === "HHAD" ? currentBest.handicapLine : undefined,
    };
    if (archiveDirectionIdentity(normalizedPrediction)) {
      return {
        prediction: normalizedPrediction,
        source: "trusted-pre-cutoff-decision",
        proof: {
          decisionId: match?.predictionMeta?.decisionId || null,
          decisionRevision: match?.predictionMeta?.decisionRevision || null,
          featureSnapshotHash: match?.predictionMeta?.featureSnapshotHash || null,
          decisionAt: match?.predictionMeta?.decisionGeneratedAt
            || match?.predictionMeta?.generatedAt
            || match?.predictionMeta?.modelGeneratedAt
            || null,
        },
      };
    }
  }

  return null;
}

function canonicalArchiveAttestation(match, canonicalBest, kickoffMs) {
  const direction = archiveDirectionIdentity(canonicalBest?.prediction);
  const source = normText(canonicalBest?.source);
  const proof = canonicalBest?.proof && typeof canonicalBest.proof === "object"
    ? canonicalBest.proof
    : {};
  const kickoffClock = normText(match?.kickoffTime).match(/T(\d{2}):(\d{2})/);
  const resultPhase = ["FINISHED", "PENDING_RESULT", "LIVE"]
    .includes(normText(match?.status).toUpperCase());
  // Some official result rows use local 00:00 as an omitted-clock placeholder.
  // Do not bind a published direction to that ambiguous event until the
  // independent result-clock recovery has proved the exact fixture.
  if (
    resultPhase
    && kickoffClock?.[1] === "00"
    && kickoffClock?.[2] === "00"
    && !match?.resultEventClockRecovery
  ) {
    return null;
  }
  if (!direction || ![
    "formal-publication-ledger",
    "live-publication-ledger",
    "public-reference-decision",
    "immutable-analysis-reference-decision",
    "dual-market-decision-binding",
    "trusted-pre-cutoff-decision",
  ].includes(source)) {
    return null;
  }

  const proofIdentity = normText(
    proof.recordHash
      || proof.bindingHash
      || proof.contentHash
      || proof.publicationId
      || proof.featureSnapshotHash
      || proof.decisionId
  );
  if (!proofIdentity) return null;

  const cutoffMs = parseBeijingDateTime(matchCutoffValue(match));
  const deadlineMs = Math.min(...[cutoffMs, kickoffMs].filter(Number.isFinite));
  if (!Number.isFinite(deadlineMs)) return null;
  const attestedAt = [
    proof.publishedAt,
    proof.decisionAt,
    match?.predictionMeta?.decisionGeneratedAt,
    match?.predictionMeta?.modelGeneratedAt,
  ].map(validAuditInstant).find((value) => {
    const valueMs = parseBeijingDateTime(value || "");
    return Number.isFinite(valueMs) && valueMs <= deadlineMs && valueMs < kickoffMs;
  });
  if (!attestedAt) return null;

  return {
    capturedAt: attestedAt,
    cutoffTime: validAuditInstant(matchCutoffValue(match)),
    phase: "published",
    signature: [
      "published-direction-attestation-v1",
      source,
      direction,
      proofIdentity,
    ].join(":"),
  };
}

function buildArchivedPreMatchPrediction(
  match,
  snapshotIndex,
  publicationIndex = null,
  capturedAt = new Date().toISOString()
) {
  if (!match || !snapshotIndex || isOfficialVoidMatch(match)) return null;
  const kickoffMs = parseBeijingDateTime(match?.kickoffTime || "");
  const observedMs = parseBeijingDateTime(capturedAt);
  const cutoffMs = parseBeijingDateTime(matchCutoffValue(match));
  const resultPhase = ["FINISHED", "PENDING_RESULT", "LIVE"].includes(normText(match?.status).toUpperCase())
    || (
      normText(match?.status).toUpperCase() === "SCHEDULED"
      && Number.isFinite(kickoffMs)
      && Number.isFinite(observedMs)
      && kickoffMs <= observedMs
  );
  // Freeze the immutable review direction as soon as the official purchase
  // deadline has passed. Waiting until kickoff leaves a predictable gap: a
  // long-running sync can publish the last pre-match generation before
  // kickoff and the API then enters result phase without an archive until the
  // next cycle finishes. The archive still selects only an independently
  // validated snapshot captured on or before the deadline below, so this does
  // not permit a post-cutoff or post-kickoff direction to be backfilled.
  const cutoffPhase = normText(match?.status).toUpperCase() === "SCHEDULED"
    && Number.isFinite(cutoffMs)
    && Number.isFinite(observedMs)
    && cutoffMs <= observedMs;
  if (!(resultPhase || cutoffPhase) || !Number.isFinite(kickoffMs)) return null;

  // A release-signed recovery row is an explicit correction for a known
  // legacy archive. It must win even when that legacy object is structurally
  // valid: older builds could freeze a pre-cutoff object whose BEST direction
  // had already been regenerated from the wrong snapshot subset.
  const recoveredArchive = recoveryArchiveForMatch(
    match,
    ARCHIVED_PREMATCH_RECOVERY_INDEX
  );
  if (recoveredArchive) return recoveredArchive;

  const canonicalBest = canonicalArchiveBestPrediction(match, publicationIndex);
  const canonicalDirection = archiveDirectionIdentity(canonicalBest?.prediction);
  const canonicalAttestation = canonicalArchiveAttestation(
    match,
    canonicalBest,
    kickoffMs
  );

  // Outside the signed recovery set, the first validated result-phase archive
  // remains the public audit record. A later sync may have a shorter local
  // snapshot window and must never derive a different "original" direction.
  const existingArchive = validArchivedPreMatchPrediction(match);
  const existingDirection = archiveDirectionIdentity(existingArchive?.prediction);
  // A hash of a fallback market reference, or a model's pre-cutoff timestamp,
  // proves neither what was public nor authority to rewrite a frozen archive.
  // Independent publication records may establish a parity correction; the
  // explicit release-signed recovery path above remains separate. Losing the
  // current public record must never downgrade the first archive's protection.
  if (existingArchive && (!canonicalDirection || canonicalDirection === existingDirection
    || !["formal-publication-ledger", "live-publication-ledger",
      "public-reference-decision"].includes(canonicalBest?.source))) {
    return existingArchive;
  }

  const sourceMatchId = sourceMatchKeyForReview(match);
  const snapshots = sourceMatchId ? snapshotIndex.get(sourceMatchId) || [] : [];
  const candidates = snapshots
    .filter((snapshot) => (
      sameSnapshotEvent(match, snapshot)
      && isEligiblePreMatchSnapshot(match, snapshot)
      && predictionsFromSnapshot(snapshot).some((prediction) => prediction?.marketType === "BEST")
    ))
    .sort((left, right) => (
      parseBeijingDateTime(left.capturedAt) - parseBeijingDateTime(right.capturedAt)
    ));

  const predictions = candidates.length
    ? fallbackPredictionsFromSnapshots(match, snapshotIndex, publicationIndex)
    : [];
  const snapshotBest = predictions.find((prediction) => (
    prediction?.marketType === "BEST"
    && ["1", "X", "2"].includes(normText(prediction?.tipCode).toUpperCase())
    && (
      ["HAD", "HHAD"].includes(normText(prediction?.oddsPoolCode).toUpperCase())
      || (
        !normText(prediction?.oddsPoolCode)
        && prediction?.recommendationAction === "reference"
        && Number(prediction?.odds) === 0
      )
    )
  ));
  const best = canonicalBest?.prediction || snapshotBest;
  if (!best) return recoveredArchive;
  const marketEvidenceScope = best?.recommendationAction === "reference"
    && Number(best?.odds) === 0
    ? "model-only-reference"
    : "result-pool";
  const explicitArchivedPool = normText(best.oddsPoolCode).toUpperCase();
  const archivedPool = explicitArchivedPool
    || (marketEvidenceScope === "model-only-reference" ? "HAD" : "");

  const bestKey = reviewSelectionKey(best);
  const bestDirection = archiveDirectionIdentity(best);
  if (!bestDirection) return recoveredArchive;
  let evidenceSnapshot = candidates
    .slice()
    .reverse()
    .find((snapshot) => predictionsFromSnapshot(snapshot).some((prediction) => (
      prediction?.marketType === "BEST"
      && (
        (bestKey && reviewSelectionKey(prediction) === bestKey)
        || (bestDirection && archiveDirectionIdentity(prediction) === bestDirection)
      )
    ))) || candidates.at(-1) || null;
  let evidenceBest = predictionsFromSnapshot(evidenceSnapshot).find((prediction) => (
    prediction?.marketType === "BEST"
    && archiveDirectionIdentity(prediction) === bestDirection
  ));
  // An immutable published/bound direction must have its own qualified
  // pre-cutoff snapshot. Never fall back to a different raw model candidate:
  // that was the production path that changed a visible home pick to draw
  // when the page switched into result/archive mode.
  if (canonicalDirection && !evidenceBest) {
    if (!canonicalAttestation) return null;
    evidenceSnapshot = canonicalAttestation;
    evidenceBest = best;
  }
  if (!evidenceSnapshot) return recoveredArchive;
  const snapshotCapturedAt = validAuditInstant(evidenceSnapshot?.capturedAt);
  const snapshotCapturedMs = Date.parse(snapshotCapturedAt || "");
  const snapshotDeadlineMs = Math.min(...[
    parseBeijingDateTime(matchCutoffValue(match)),
    parseBeijingDateTime(evidenceSnapshot?.cutoffTime || ""),
    kickoffMs,
  ].filter(Number.isFinite));
  if (
    !snapshotCapturedAt
    || !Number.isFinite(snapshotCapturedMs)
    || snapshotCapturedMs >= kickoffMs
    || !Number.isFinite(snapshotDeadlineMs)
    || snapshotCapturedMs > snapshotDeadlineMs
  ) return recoveredArchive;

  const parityCorrection = existingArchive && canonicalDirection !== existingDirection
    ? {
        version: "published-direction-archive-parity-v1",
        reason: "archived-direction-diverged-from-user-visible-published-direction",
        source: canonicalBest.source,
        previous: {
          market: normText(existingArchive?.prediction?.oddsPoolCode).toUpperCase() || null,
          direction: normText(existingArchive?.prediction?.tipCode).toUpperCase() || null,
          directionIdentity: existingDirection,
        },
        canonical: {
          market: archivedPool,
          direction: normText(best.tipCode).toUpperCase(),
          directionIdentity: canonicalDirection,
        },
        proof: canonicalBest.proof || null,
        correctedAt: validAuditInstant(capturedAt),
      }
    : null;

  return {
    version: "archived-pre-match-prediction-v1",
    source: "immutable-pre-match-prediction-snapshot",
    sourceMatchId,
    matchId: match?.id || null,
    kickoffTime: validAuditInstant(match?.kickoffTime),
    eventVersion: validAuditInstant(match?.eventVersion || match?.kickoffTime),
    capturedAt: snapshotCapturedAt,
    phase: evidenceSnapshot?.phase || null,
    signature: evidenceSnapshot?.signature || null,
    cutoffTime: validAuditInstant(evidenceSnapshot?.cutoffTime || matchCutoffValue(match)),
    marketEvidenceScope,
    ...(parityCorrection ? { recoveryEvidence: parityCorrection } : {}),
    prediction: {
      marketType: "BEST",
      // A model-only reference keeps the exact HAD/HHAD outcome space users
      // saw before kickoff, but carries zero SP and an explicit model-only
      // scope. This preserves the direction without pretending that an official market was published
      // or admitting it to formal performance statistics.
      oddsPoolCode: archivedPool,
      handicapLine: archivedPool === "HHAD" ? best.handicapLine : undefined,
      tipCode: normText(best.tipCode).toUpperCase(),
      tipLabel: archivedTipLabel(match, best),
      odds: Number(best.odds || 0),
      ...(canonicalBest?.source === "public-reference-decision" ? {
        frozenVersion: require("../src/services/frozenReviewVersion.cjs").captureFrozenReviewVersion(
          match?.predictionMeta?.publicReferenceDecision, match, best),
      } : {}),
      trustScore: Number(best.trustScore || 0),
      recommendationAction: best.recommendationAction || "reference",
      recommendationTier: best.recommendationTier || "reference",
      liveRecommendationAction: best.liveRecommendationAction || "withhold",
      liveRecommendationTier: best.liveRecommendationTier || "live-withhold",
      liveRecommendation: compactLiveRecommendationForAudit(best.liveRecommendation),
      livePublicationEvidence: compactLivePublicationEvidenceForAudit(best.livePublicationEvidence),
      riskTags: Array.isArray(best.riskTags) ? best.riskTags.slice(0, 6) : [],
      explanation: { zh: "", en: "" },
      visibilityStatus: "FREE",
      resultStatus: "PENDING",
    },
  };
}

function attachArchivedPreMatchPredictions(
  matches,
  predictionSnapshotsPayload,
  publicationIndex = null,
  capturedAt = new Date().toISOString()
) {
  // A valid existing archive (or signed recovery) can decide without scanning
  // snapshots. The fast publisher supplies a synchronous lazy reader; only
  // the existing archive algorithm may decide when snapshot evidence is needed.
  // Keep failures visible and share the same complete index once requested.
  let resolvedSnapshotIndex;
  const snapshotIndex = typeof predictionSnapshotsPayload === "function"
    ? { get(sourceMatchId) {
      resolvedSnapshotIndex ||= buildPredictionSnapshotIndex(predictionSnapshotsPayload());
      return resolvedSnapshotIndex.get(sourceMatchId);
    } }
    : buildPredictionSnapshotIndex(predictionSnapshotsPayload);
  return (matches || []).map((inputMatch) => {
    const match = restoreMissingArchive(inputMatch, FROZEN_ARCHIVE_RESTORATION_INDEX, capturedAt,
      (candidate, archive) => !isOfficialVoidMatch(candidate)
        && validArchivedPreMatchPrediction(candidate, archive));
    const archivedPreMatchPrediction = buildArchivedPreMatchPrediction(
      match,
      snapshotIndex,
      publicationIndex,
      capturedAt
    );
    if (!archivedPreMatchPrediction) {
      if (!match?.archivedPreMatchPrediction) return match;
      // An invalid legacy archive must not survive merely because the current
      // server no longer retains the original snapshot row. Leaving it on the
      // match lets an old post-cutoff review keep masquerading as the original
      // recommendation. Recovery is allowed only through the integrity-checked
      // manifest above; otherwise fail closed and remove the bad archive.
      const { archivedPreMatchPrediction: rejectedArchive, ...withoutRejectedArchive } = match;
      void rejectedArchive;
      return withoutRejectedArchive;
    }
    return { ...match, archivedPreMatchPrediction };
  });
}

function mergeReviewPredictionsWithSnapshot(currentPredictions, snapshotPredictions) {
  const current = Array.isArray(currentPredictions) ? currentPredictions.filter(Boolean) : [];
  const snapshots = Array.isArray(snapshotPredictions) ? snapshotPredictions.filter(Boolean) : [];
  if (!snapshots.length) return current;

  // A qualified pre-match snapshot is the audit boundary. Do not splice in
  // current/post-match fields or markets that were absent from that snapshot.
  // In particular, an HHAD direction without its own captured line must stay
  // unresolved instead of borrowing a later line from the mutable match row.
  return snapshots.map((snapshotPrediction) => {
    const merged = { ...snapshotPrediction };
    if (snapshotPrediction.oddsPoolCode === "HHAD") {
      const snapshotLine = parseHandicapLine(snapshotPrediction.handicapLine);
      merged.handicapLine = snapshotLine === null ? undefined : formatHandicapLineForCopy(snapshotLine);
    } else {
      delete merged.handicapLine;
    }
    return merged;
  });
}

function scoreReview(match, actuals) {
  const priorScoreReview = match?.postMatchReview?.scoreReview || null;
  const priorProjected = String(priorScoreReview?.projectedScore || "").match(/^(\d+)-(\d+)$/);
  const directProjectedHome = Number(match.projectedScoreHome);
  const directProjectedAway = Number(match.projectedScoreAway);
  const projectedHome = Number.isFinite(directProjectedHome)
    ? directProjectedHome
    : Number(priorProjected?.[1]);
  const projectedAway = Number.isFinite(directProjectedAway)
    ? directProjectedAway
    : Number(priorProjected?.[2]);
  const distribution = Array.isArray(match.probabilityModel?.scoreDistribution)
    ? match.probabilityModel.scoreDistribution
    : [];
  const actualLabel = `${actuals.scoreHome}-${actuals.scoreAway}`;
  const modelTopLabels = distribution.slice(0, 3).map((row) => `${row.home}-${row.away}`);
  const topLabels = modelTopLabels.length
    ? modelTopLabels
    : (Array.isArray(priorScoreReview?.top3) ? priorScoreReview.top3.slice(0, 3) : []);
  const exactTop1 = topLabels[0] === actualLabel;
  const exactTop3 = topLabels.includes(actualLabel);
  const projectedTotal = Number.isFinite(projectedHome) && Number.isFinite(projectedAway)
    ? projectedHome + projectedAway
    : null;
  return {
    projectedScore: Number.isFinite(projectedHome) && Number.isFinite(projectedAway)
      ? `${projectedHome}-${projectedAway}`
      : null,
    actualScore: actualLabel,
    exactTop1,
    exactTop3,
    top3: topLabels,
    totalGoalDelta: Number.isFinite(projectedTotal) ? actuals.totalGoals - projectedTotal : null,
  };
}

function validAuditInstant(value) {
  return Number.isFinite(Date.parse(value || "")) ? value : null;
}

function latestExplicitAuditInstant(...values) {
  const millis = values
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return millis.length ? new Date(Math.max(...millis)).toISOString() : null;
}

function isTrustedFinishedForSettlement(match) {
  const scoreHome = match?.scoreHome;
  const scoreAway = match?.scoreAway;
  return Boolean(
    match
    && (match.status === "FINISHED" || match.effectiveStatus === "FINISHED")
    && isTrustedOfficialFinal(match)
    && Number.isInteger(scoreHome)
    && Number.isInteger(scoreAway)
    && scoreHome >= 0
    && scoreAway >= 0
  );
}

function attachResultAuditTimestamps(match, existing = null) {
  if (!isTrustedFinishedForSettlement(match)) return match;
  const prior = existing && typeof existing === "object" ? existing : null;
  const priorSettlement = prior?.postMatchReview?.settlement || prior?.settlement || null;
  const observationCandidates = [
    {
      observedAt: priorSettlement?.resultObservedAt,
      source: priorSettlement?.resultObservationSource,
      sourceUpdatedAt: priorSettlement?.resultSourceUpdatedAt,
      fallback: priorSettlement?.resultObservationFallback,
      promotionEligible: prior?.resultProvenance?.promotionEligible,
    },
    {
      observedAt: prior?.resultObservedAt,
      source: prior?.resultObservationSource,
      sourceUpdatedAt: prior?.resultSourceUpdatedAt,
      fallback: prior?.resultObservationFallback,
      promotionEligible: prior?.resultProvenance?.promotionEligible,
    },
    {
      observedAt: match?.postMatchReview?.settlement?.resultObservedAt,
      source: match?.postMatchReview?.settlement?.resultObservationSource,
      sourceUpdatedAt: match?.postMatchReview?.settlement?.resultSourceUpdatedAt,
      fallback: match?.postMatchReview?.settlement?.resultObservationFallback,
      promotionEligible: match?.resultProvenance?.promotionEligible,
    },
    {
      observedAt: match?.resultObservedAt,
      source: match?.resultObservationSource,
      sourceUpdatedAt: match?.resultSourceUpdatedAt,
      fallback: match?.resultObservationFallback,
      promotionEligible: match?.resultProvenance?.promotionEligible,
    },
    {
      observedAt: match?.resultProvenance?.observedAt,
      source: match?.resultProvenance?.observationSource,
      sourceUpdatedAt: match?.resultProvenance?.sourceUpdatedAt,
      fallback: match?.resultProvenance?.resultObservationFallback,
      promotionEligible: match?.resultProvenance?.promotionEligible,
    },
  ].map((candidate) => ({
    observedAt: validAuditInstant(candidate.observedAt),
    source: normText(candidate.source) || null,
    sourceUpdatedAt: validAuditInstant(candidate.sourceUpdatedAt),
    fallback: candidate.fallback === true,
    promotionEligible: candidate.promotionEligible === true,
  }));
  // Never graft a newly discovered source label onto an older unattributed
  // timestamp. Prefer a complete clock+source pair, otherwise retain the
  // legacy timestamp only as explicitly non-promotable evidence.
  // Preserve the first strict attributed observation, but never let an older
  // fallback/provisional clock permanently mask a later official attributed
  // observation. This is the upgrade path used when Sporttery publishes its
  // result after an interim provider or legacy fallback has already archived
  // the score.
  const selectedObservation = observationCandidates.find((candidate) => (
    candidate.observedAt
    && candidate.source
    && candidate.fallback !== true
    && candidate.promotionEligible === true
  )) || observationCandidates.find((candidate) => (
    candidate.observedAt && candidate.source && candidate.fallback !== true
  )) || observationCandidates.find((candidate) => (
    candidate.observedAt && candidate.source
  )) || observationCandidates.find((candidate) => candidate.observedAt) || null;
  const resultObservedAt = selectedObservation?.observedAt || null;
  const resultObservationSource = selectedObservation?.source || null;
  // A stored candidate may own the immutable first observation while the
  // current signed row supplies the provider clock. Complete that metadata in
  // the same atomic write only when both observation time and authority label
  // are identical; never graft a provider clock across observations/sources.
  const matchingProviderClock = observationCandidates.find((candidate) => (
    candidate.observedAt === resultObservedAt
    && candidate.source === resultObservationSource
    && candidate.sourceUpdatedAt
  ));
  const resultSourceUpdatedAt = selectedObservation?.sourceUpdatedAt
    || matchingProviderClock?.sourceUpdatedAt
    || null;
  const kickoffMs = Date.parse(match?.kickoffTime || "");
  const observedMs = Date.parse(resultObservedAt || "");
  const invalidChronology = Number.isFinite(kickoffMs)
    && Number.isFinite(observedMs)
    && observedMs < kickoffMs;
  const resultObservationFallback = Boolean(
    selectedObservation?.fallback === true
    || !resultObservedAt
    || !resultObservationSource
    || invalidChronology
  );
  const priorPromotableObservation = observationCandidates.slice(0, 2).some((candidate) => (
    candidate.observedAt
    && candidate.source
    && candidate.fallback !== true
    && candidate.promotionEligible === true
  ));
  const settledAt = priorPromotableObservation
    ? (
        validAuditInstant(priorSettlement?.settledAt)
        || validAuditInstant(prior?.settledAt)
        || validAuditInstant(match?.postMatchReview?.settlement?.settledAt)
        || validAuditInstant(match?.settledAt)
        || resultObservedAt
        || null
      )
    : (resultObservedAt || null);
  return {
    ...match,
    resultObservedAt,
    resultObservationSource,
    resultObservationFallback,
    resultSourceUpdatedAt,
    settledAt,
  };
}

function buildPostMatchReview(match, capturedAt, snapshotIndex = null, publicationIndex = null, options = {}) {
  if (match?.resultProvenance && !isTrustedFinishedForSettlement(match)) return null;
  match = resolveMatchLifecycle(match, { now: capturedAt });
  if (!isTrustedFinishedForSettlement(match)) return null;
  const auditedResultMatch = attachResultAuditTimestamps(match, match, capturedAt);
  const priorReview = match?.postMatchReview && typeof match.postMatchReview === "object"
    ? match.postMatchReview
    : null;
  const priorSettlement = priorReview?.settlement && typeof priorReview.settlement === "object"
    ? priorReview.settlement
    : null;
  const snapshotPredictions = fallbackPredictionsFromSnapshots(match, snapshotIndex, publicationIndex);
  const auditedPreMatchPredictions = mergeArchivedBestPrediction(match, snapshotPredictions);
  const livePredictions = Array.isArray(match.predictions) ? match.predictions.filter(Boolean) : [];
  const priorReviewPredictions = predictionsFromPriorReview(priorReview);
  // A settled review is the immutable audit record. Mutable match.predictions
  // can be regenerated by a later model cycle and must never replace a
  // previously verified formal selection (or silently rewrite its outcome).
  const reviewSourcePredictions = priorReviewPredictions.length > 0
    ? priorReviewPredictions
    : livePredictions;
  const snapshotOwnsHhadAudit = auditedPreMatchPredictions.some((prediction) => (
    prediction?.oddsPoolCode === "HHAD"
    && ["1", "X", "2"].includes(prediction?.tipCode)
  ));
  const reviewMatch = {
    ...match,
    // Once an eligible pre-match snapshot supplies the audited HHAD direction,
    // its captured line is the only line that may settle that direction. Clear
    // mutable match/external fallbacks so a missing snapshot line remains
    // unresolved instead of being paired with a later handicap.
    ...(snapshotOwnsHhadAudit ? {
      handicapLine: undefined,
      externalSignals: undefined,
    } : {}),
    predictions: mergeReviewPredictionsWithSnapshot(reviewSourcePredictions, auditedPreMatchPredictions),
  };
  const actuals = postMatchReviewActuals(reviewMatch, reviewMatch.predictions);
  if (!actuals) return null;
  let predictionRows = buildPredictionReviewRows(reviewMatch, actuals, publicationIndex);
  // Once a result has been reviewed, its publication membership is immutable.
  // An old review without publication proof is explicitly locked as reference;
  // a later/backdated ledger append must never turn it into a formal sample.
  if (priorReview) {
    const verifiedPriorRows = lockedVerifiedPublicationRows(priorReview);
    // Version metadata follows the already-settled row, never a later public
    // record or a newly enriched archive with the same outcome direction.
    const priorVersionRows = Array.isArray(priorReview.predictionReview?.rows) ? priorReview.predictionReview.rows : [];
    predictionRows = predictionRows.map((row) => {
      const { frozenReviewSelection } = require("../src/services/frozenReviewVersion.cjs");
      const candidates = priorVersionRows.filter(prior => frozenReviewSelection(prior) && frozenReviewSelection(prior) === frozenReviewSelection(row));
      const traces = candidates.map(prior => require("../src/services/frozenReviewVersion.cjs").compactFrozenReviewVersion(prior.frozenVersion, prior));
      const version = traces.length && traces.every(trace => trace && trace.contentHash === traces[0]?.contentHash) ? traces[0] : null;
      const { frozenVersion: ignoredVersion, ...withoutVersion } = row;
      row = { ...withoutVersion, ...(version ? { frozenVersion: version } : {}) };
      const locked = verifiedPriorRows.get(reviewSelectionKey(row));
      if (locked) {
        return {
          ...row,
          recommendationAction: "recommend",
          recommendationTier: locked.recommendationTier || row.recommendationTier,
          reviewRole: "main",
          publicationId: locked.publicationId,
          publicationEvidence: locked.publicationEvidence,
        };
      }
      const restored = restoreLedgerVerifiedPublicationRow(
        reviewMatch,
        row,
        priorSettlement,
        publicationIndex
      );
      if (restored) return restored;
      return {
        ...row,
        recommendationAction: "reference",
        reviewRole: "reference",
        publicationId: null,
        publicationEvidence: null,
      };
    });
  }
  if (auditedPreMatchPredictions.length === 0) {
    // Reference performance needs a provably pre-cutoff decision snapshot.
    // Apply this only after prior publication rows have been restored: the
    // legacy review adapter intentionally starts rows as references until
    // immutable publication proof is reattached above.
    predictionRows = predictionRows.filter((row) => (
      row.reviewRole === "main" || row.performanceTrack === "live-model"
    ));
  }
  const settledRows = predictionRows.filter((row) => row.resultStatus === "WON" || row.resultStatus === "LOST");
  const wonRows = settledRows.filter((row) => row.resultStatus === "WON");
  const mainRows = predictionRows.filter((row) => row.reviewRole === "main");
  const mainSettledRows = mainRows.filter((row) => row.resultStatus === "WON" || row.resultStatus === "LOST");
  const mainWonRows = mainSettledRows.filter((row) => row.resultStatus === "WON");
  const liveRows = predictionRows.filter((row) => row.performanceTrack === "live-model");
  const liveSettledRows = liveRows.filter((row) => row.resultStatus === "WON" || row.resultStatus === "LOST");
  const liveWonRows = liveSettledRows.filter((row) => row.resultStatus === "WON");
  const referenceSettledRows = settledRows.filter((row) => row.reviewRole !== "main" && row.performanceTrack !== "live-model");
  const referenceWonRows = referenceSettledRows.filter((row) => row.resultStatus === "WON");
  const formalBestRow = predictionRows.find((row) => row.marketType === "BEST" && row.reviewRole === "main");
  const liveBestRow = predictionRows.find((row) => row.marketType === "BEST" && row.performanceTrack === "live-model");
  const referenceBestRow = predictionRows.find((row) => row.marketType === "BEST" && row.reviewRole !== "main" && row.performanceTrack !== "live-model");
  const archivedBestRow = formalBestRow || liveBestRow || referenceBestRow || mainRows[0] || null;
  const priorResultRevision = Math.max(1, Number(priorSettlement?.resultRevision || 1));
  const resultRevision = options.officialScoreCorrection === true
    && priorReview?.finalScore
    && priorReview.finalScore !== actuals.finalScore
    ? priorResultRevision + 1
    : priorResultRevision;
  const firstPublicationId = priorReview
    ? (normText(priorSettlement?.publicationId || "") || null)
    : (formalBestRow?.publicationId || mainRows[0]?.publicationId || null);
  const resultObservedAt = auditedResultMatch?.resultObservedAt || null;
  const resultObservationSource = auditedResultMatch?.resultObservationSource
    || auditedResultMatch?.resultProvenance?.observationSource
    || null;
  const resultObservationFallback = Boolean(
    auditedResultMatch?.resultObservationFallback === true
    || auditedResultMatch?.resultProvenance?.resultObservationFallback === true
    || !resultObservedAt
    || !resultObservationSource
  );
  const resultSourceUpdatedAt = auditedResultMatch?.resultSourceUpdatedAt
    || auditedResultMatch?.resultProvenance?.sourceUpdatedAt
    || null;
  const settledAt = auditedResultMatch?.settledAt || resultObservedAt || null;
  const oneXTwoRow = predictionRows.find((row) => row.marketType === "1X2");
  const hhadRows = predictionRows.filter((row) => row.oddsPoolCode === "HHAD");
  const hhadWon = hhadRows.some((row) => row.resultStatus === "WON");
  // Only a canonical main recommendation may drive formal BEST hit/miss
  // diagnostics or model-adjustment feedback. A reference BEST remains useful
  // as an archived observation, but it must never be relabeled as a miss/hit.
  const bestMissed = formalBestRow?.resultStatus === "LOST";
  const handicapMarketLeader = normalizedOddsLeader(match.handicapOdds);
  const missedHandicapLane = Boolean(
    bestMissed
    && formalBestRow?.oddsPoolCode !== "HHAD"
    && actuals.hhad
    && handicapMarketLeader
    && actuals.hhad === handicapMarketLeader
  );
  const drawRiskMissed = Boolean(
    oneXTwoRow?.tipCode !== "X"
    && actuals.had === "X"
    && oneXTwoRow?.resultStatus === "LOST"
  );
  const score = scoreReview(match, actuals);
  const diagnosis = [];
  const adjustments = [];

  if (formalBestRow?.resultStatus === "WON") {
    diagnosis.push({ code: "best-hit", zh: "BEST 方向命中，当前赛前主线有效。", en: "BEST landed; the pre-match main lane worked." });
  } else if (bestMissed) {
    diagnosis.push({ code: "best-miss", zh: "BEST 未命中，需要进入模型复盘。", en: "BEST missed and should feed the review loop." });
  }
  if (!formalBestRow && liveBestRow?.resultStatus === "WON") {
    diagnosis.push({
      code: "live-best-hit",
      zh: "实时推荐命中，计入实时推荐独立统计，不计入正式推荐命中率。",
      en: "The live pick landed and is counted only in the live-pick track, not the formal hit rate.",
    });
  } else if (!formalBestRow && liveBestRow?.resultStatus === "LOST") {
    diagnosis.push({
      code: "live-best-miss",
      zh: "实时推荐未命中，计入实时推荐独立统计，不计入正式推荐命中率。",
      en: "The live pick missed and is counted only in the live-pick track, not the formal hit rate.",
    });
  } else if (!formalBestRow && referenceBestRow?.resultStatus === "WON") {
    diagnosis.push({
      code: "reference-best-hit",
      zh: "BEST \u53c2\u8003\u503e\u5411\u547d\u4e2d\uff0c\u4ec5\u4f5c\u89c2\u5bdf\u6837\u672c\uff0c\u4e0d\u8ba1\u5165\u6b63\u5f0f\u63a8\u8350\u547d\u4e2d\u3002",
      en: "The reference BEST lean landed; it remains an observation and is excluded from formal recommendation results.",
    });
  } else if (!formalBestRow && referenceBestRow?.resultStatus === "LOST") {
    diagnosis.push({
      code: "reference-best-miss",
      zh: "BEST \u53c2\u8003\u503e\u5411\u672a\u547d\u4e2d\uff0c\u4ec5\u4f5c\u89c2\u5bdf\u590d\u76d8\uff0c\u4e0d\u8ba1\u5165\u6b63\u5f0f\u63a8\u8350\u5931\u5229\u3002",
      en: "The reference BEST lean missed; it is review-only and excluded from formal recommendation losses.",
    });
  }
  if (hhadWon) {
    diagnosis.push({ code: "handicap-hit", zh: "让球命中，盘口层提供了有效补充。", en: "The handicap-adjusted result landed and added useful signal." });
  }
  if (missedHandicapLane) {
    diagnosis.push({ code: "handicap-lane-suppressed", zh: "让球方向命中但未进入 BEST，属于错过更优盘口方向。", en: "The handicap lane landed but was not selected as BEST." });
    adjustments.push({ code: "raise-handicap-protection", zh: "低赔热门让球证据不足时，提高让球权重。", en: "Raise handicap-result weight when a low-odds favorite lacks handicap evidence." });
  }
  if (drawRiskMissed) {
    diagnosis.push({ code: "draw-risk-underestimated", zh: "平局风险被低估，普通胜平负不宜硬推。", en: "Draw risk was underestimated; raw 1X2 should be less forceful." });
    adjustments.push({ code: "raise-draw-risk", zh: "在低赔热门和平局压力并存时，提高防平/防冷阈值。", en: "Increase draw/upset protection when low-odds favorites carry draw pressure." });
  }
  if (Number.isFinite(score.totalGoalDelta) && score.totalGoalDelta >= 1.5) {
    diagnosis.push({ code: "goals-underestimated", zh: "实际进球明显高于模型热区，总进球期望偏低。", en: "Actual goals were well above the projected zone." });
    adjustments.push({ code: "raise-total-lambda", zh: "提高同类场景总进球 lambda 与大球权重。", en: "Raise total-goal lambda and over-weight for similar profiles." });
  } else if (Number.isFinite(score.totalGoalDelta) && score.totalGoalDelta <= -1.5) {
    diagnosis.push({ code: "goals-overestimated", zh: "实际进球明显低于模型热区，总进球期望偏高。", en: "Actual goals were well below the projected zone." });
    adjustments.push({ code: "lower-total-lambda", zh: "降低同类场景总进球 lambda 与大球权重。", en: "Lower total-goal lambda and over-weight for similar profiles." });
  }
  if (!diagnosis.length) {
    diagnosis.push({ code: "neutral-review", zh: "赛果与模型分歧不大，作为常规样本进入滚动校准。", en: "No major model conflict; keep it as a rolling calibration sample." });
  }
  if (!adjustments.length) {
    adjustments.push({ code: "rolling-calibration", zh: "纳入滚动校准样本，不单场过度修正。", en: "Feed into rolling calibration without overreacting to one match." });
  }

  const eventFactors = {
    sourceStatus: "pending-external-event-feed",
    goals: {
      count: actuals.totalGoals,
      summary: {
        zh: `当前已接入最终比分 ${actuals.finalScore}；进球时间与助攻事件待接入。`,
        en: `Final score ${actuals.finalScore} is available; goal timing and assists await event feed.`,
      },
    },
    penalties: { available: false, count: null },
    var: { available: false, count: null },
    yellowCards: { available: false, total: null },
    redCards: { available: false, total: null },
    corners: { available: false, total: null },
    shots: { available: false, total: null },
    xg: { available: false, home: null, away: null },
    referee: { available: false, name: null },
  };

  return {
    version: "post-match-review-v2",
    generatedAt: capturedAt,
    matchId: match.id,
    sourceMatchId: match.sourceMatchId || null,
    eventVersion: eventVersionOf(match),
    matchNo: match.matchNo || null,
    teams: {
      home: match.homeTeamName || match.homeTeam || "主队",
      away: match.awayTeamName || match.awayTeam || "客队",
    },
    finalScore: actuals.finalScore,
    actual: {
      had: { code: actuals.had, label: reviewResultLabel(actuals.had, "HAD", match) },
      hhad: actuals.hhad ? {
        code: actuals.hhad,
        label: reviewResultLabel(actuals.hhad, "HHAD", reviewMatch),
        handicapLine: formatHandicapLineForCopy(actuals.handicapLine),
      } : null,
      goals: { code: actuals.overUnder25, label: reviewResultLabel(actuals.overUnder25, "GOALS", match) },
      btts: { code: actuals.btts, label: reviewResultLabel(actuals.btts, "BTTS", match) },
    },
    settlement: {
      version: "recommendation-settlement-v1",
      resultObservedAt,
      resultObservationSource,
      resultObservationFallback,
      resultSourceUpdatedAt,
      settledAt,
      reviewGeneratedAt: priorSettlement?.reviewGeneratedAt || priorReview?.generatedAt || capturedAt,
      sourceCycleId: priorSettlement?.sourceCycleId
        || match?.sourceCycleId
        || match?.predictionMeta?.sourceCycleId
        || null,
      resultRevision,
      datasetRevision: priorSettlement?.datasetRevision
        || match?.datasetRevision
        || match?.predictionMeta?.datasetRevision
        || null,
      publicationId: firstPublicationId,
      publicationVerified: Boolean(
        firstPublicationId
        && mainRows.some((row) => row.publicationId === firstPublicationId && row.reviewRole === "main")
      ),
    },
    predictionReview: {
      settled: mainSettledRows.length,
      won: mainWonRows.length,
      hitRate: mainSettledRows.length ? Math.round((mainWonRows.length / mainSettledRows.length) * 100) : null,
      mainSettled: mainSettledRows.length,
      mainWon: mainWonRows.length,
      allSettled: settledRows.length,
      allWon: wonRows.length,
      referenceSettled: referenceSettledRows.length,
      referenceWon: referenceWonRows.length,
      liveSettled: liveSettledRows.length,
      liveWon: liveWonRows.length,
      liveHitRate: liveSettledRows.length ? Math.round((liveWonRows.length / liveSettledRows.length) * 100) : null,
      // Legacy bestStatus is now formal-only. Keep the archived/reference
      // status in explicit fields so consumers cannot inflate recommendation results.
      bestStatus: formalBestRow?.resultStatus || null,
      formalBestStatus: formalBestRow?.resultStatus || null,
      liveBestStatus: liveBestRow?.resultStatus || null,
      referenceBestStatus: referenceBestRow?.resultStatus || null,
      archivedBestStatus: archivedBestRow?.resultStatus || null,
      bestRole: formalBestRow ? "main" : referenceBestRow ? "reference" : null,
      oneXTwoStatus: oneXTwoRow?.resultStatus || null,
      handicapHit: hhadWon,
      missedHandicapLane,
      rows: predictionRows,
    },
    scoreReview: score,
    eventFactors,
    modelDiagnosis: diagnosis,
    nextAdjustment: adjustments,
    dataGaps: [
      { key: "cards", zh: "红黄牌事件未接入", en: "Card events not connected" },
      { key: "corners", zh: "角球数据未接入", en: "Corner data not connected" },
      { key: "xg", zh: "xG/xGA 未接入", en: "xG/xGA not connected" },
      { key: "lineups", zh: "真实首发与换人未完整接入", en: "Lineups and substitutions not fully connected" },
    ],
  };
}

function compactPredictionReviewRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    marketType: row.marketType,
    oddsPoolCode: row.oddsPoolCode,
    handicapLine: row.handicapLine,
    tipCode: row.tipCode,
    tipLabel: row.tipLabel,
    odds: row.odds,
    actualCode: row.actualCode,
    actualLabel: row.actualLabel,
    resultStatus: row.resultStatus,
    trustScore: row.trustScore,
    recommendationAction: row.recommendationAction,
    recommendationTier: row.recommendationTier,
    liveRecommendationAction: row.liveRecommendationAction || "withhold",
    liveRecommendationTier: row.liveRecommendationTier || "live-withhold",
    liveRecommendation: compactLiveRecommendationForAudit(row.liveRecommendation),
    livePublicationEvidence: compactLivePublicationEvidenceForAudit(row.livePublicationEvidence),
    performanceTrack: row.performanceTrack || (row.reviewRole === "main" ? "formal" : "reference"),
    reviewRole: row.reviewRole,
    publicationId: row.publicationId || null,
    publicationEvidence: row.publicationEvidence || null,
    ...(row.frozenVersion ? { frozenVersion: require("../src/services/frozenReviewVersion.cjs").compactFrozenReviewVersion(row.frozenVersion, row) } : {}),
  };
}

function compactPostMatchReviewForMatch(review) {
  if (!review || typeof review !== "object") return null;
  const predictionReview = review.predictionReview || {};
  const reviewRows = Array.isArray(predictionReview.rows) ? predictionReview.rows : [];
  const formalBestRow = reviewRows.find((row) => row?.marketType === "BEST" && row?.reviewRole === "main");
  const liveBestRow = reviewRows.find((row) => row?.marketType === "BEST" && row?.performanceTrack === "live-model");
  const referenceBestRow = reviewRows.find((row) => row?.marketType === "BEST" && row?.reviewRole !== "main" && row?.performanceTrack !== "live-model");
  const inferredBestRole = predictionReview.bestRole
    || (formalBestRow ? "main" : referenceBestRow ? "reference" : null);
  const formalBestStatus = predictionReview.formalBestStatus
    || formalBestRow?.resultStatus
    || (inferredBestRole === "main" ? predictionReview.bestStatus : null)
    || null;
  const referenceBestStatus = predictionReview.referenceBestStatus
    || referenceBestRow?.resultStatus
    || (inferredBestRole === "reference" ? predictionReview.bestStatus : null)
    || null;
  const liveBestStatus = predictionReview.liveBestStatus
    || liveBestRow?.resultStatus
    || null;
  const archivedBestStatus = predictionReview.archivedBestStatus
    || formalBestStatus
    || liveBestStatus
    || referenceBestStatus
    || null;
  return {
    version: review.version,
    generatedAt: review.generatedAt,
    matchId: review.matchId,
    sourceMatchId: review.sourceMatchId,
    eventVersion: eventVersionOf(review),
    matchNo: review.matchNo,
    teams: review.teams,
    finalScore: review.finalScore,
    actual: review.actual,
    settlement: review.settlement || null,
    predictionReview: {
      settled: predictionReview.settled || 0,
      won: predictionReview.won || 0,
      hitRate: predictionReview.hitRate ?? null,
      mainSettled: predictionReview.mainSettled || 0,
      mainWon: predictionReview.mainWon || 0,
      allSettled: predictionReview.allSettled || 0,
      allWon: predictionReview.allWon || 0,
      referenceSettled: predictionReview.referenceSettled || 0,
      referenceWon: predictionReview.referenceWon || 0,
      liveSettled: predictionReview.liveSettled || 0,
      liveWon: predictionReview.liveWon || 0,
      liveHitRate: predictionReview.liveHitRate ?? null,
      // `bestStatus` remains as a legacy alias, but it is formal-only.
      bestStatus: formalBestStatus,
      formalBestStatus,
      liveBestStatus,
      referenceBestStatus,
      archivedBestStatus,
      bestRole: inferredBestRole,
      bestTrack: formalBestRow ? "formal" : liveBestRow ? "live-model" : referenceBestRow ? "reference" : null,
      oneXTwoStatus: predictionReview.oneXTwoStatus || null,
      handicapHit: Boolean(predictionReview.handicapHit),
      missedHandicapLane: Boolean(predictionReview.missedHandicapLane && formalBestStatus === "LOST"),
      rows: reviewRows.map(compactPredictionReviewRow).filter(Boolean),
    },
    scoreReview: review.scoreReview,
    modelDiagnosis: review.modelDiagnosis || [],
    nextAdjustment: review.nextAdjustment || [],
    dataGaps: review.dataGaps || [],
  };
}

function postMatchReviewComparable(review) {
  const compact = compactPostMatchReviewForMatch(review);
  if (!compact) return "";
  const settlement = compact.settlement && typeof compact.settlement === "object"
    ? {
        ...compact.settlement,
        reviewGeneratedAt: null,
        sourceCycleId: null,
        datasetRevision: null,
      }
    : compact.settlement;
  return JSON.stringify({ ...compact, generatedAt: null, settlement });
}

function attachPostMatchReviews(
  matches,
  capturedAt,
  predictionSnapshotsPayload = null,
  publicationIndex = null,
  options = {}
) {
  const snapshotIndex = buildPredictionSnapshotIndex(predictionSnapshotsPayload);
  const rows = [];
  const enriched = (matches || []).map((match) => {
    let review = buildPostMatchReview(match, capturedAt, snapshotIndex, publicationIndex, options);
    if (
      review
      && match?.postMatchReview?.generatedAt
      && postMatchReviewComparable(review) === postMatchReviewComparable(match.postMatchReview)
    ) {
      review = { ...review, generatedAt: match.postMatchReview.generatedAt };
    }
    if (review) rows.push(review);
    const { postMatchReview, ...withoutEmbeddedReview } = match || {};
    void postMatchReview;
    return review
      ? { ...withoutEmbeddedReview, postMatchReview: compactPostMatchReviewForMatch(review) }
      : withoutEmbeddedReview;
  });
  const summary = rows.reduce((acc, review) => {
    acc.total += 1;
    if (review.predictionReview.bestStatus === "WON") acc.bestWon += 1;
    if (review.predictionReview.bestStatus === "LOST") acc.bestLost += 1;
    if (review.predictionReview.referenceBestStatus === "WON") acc.referenceBestWon += 1;
    if (review.predictionReview.referenceBestStatus === "LOST") acc.referenceBestLost += 1;
    if (review.predictionReview.handicapHit) acc.handicapHit += 1;
    if (review.predictionReview.missedHandicapLane) acc.missedHandicapLane += 1;
    for (const item of review.modelDiagnosis || []) {
      acc.diagnosis[item.code] = (acc.diagnosis[item.code] || 0) + 1;
    }
    return acc;
  }, {
    total: 0,
    bestWon: 0,
    bestLost: 0,
    referenceBestWon: 0,
    referenceBestLost: 0,
    handicapHit: 0,
    missedHandicapLane: 0,
    diagnosis: {},
  });

  return {
    matches: enriched,
    payload: {
      version: 2,
      source: "post-match-review-v2",
      generatedAt: capturedAt,
      rows,
      summary,
    },
  };
}

function isReferencePrediction(prediction) {
  if (prediction?.marketType === "GOALS" || prediction?.marketType === "GG_NG") return true;
  return prediction?.recommendationAction === "reference"
    || prediction?.recommendationTier === "reference";
}

function predictionGameplayMarket(prediction) {
  const role = normText(prediction?.marketType).toUpperCase();
  const pool = normText(prediction?.oddsPoolCode).toUpperCase();
  const code = normText(prediction?.tipCode).toUpperCase();
  if (["1", "X", "2"].includes(code)) {
    if (pool === "HHAD" || role === "HHAD") return "HHAD";
    if (pool === "HAD" || role === "1X2") return "1X2";
  }
  return role;
}

function isFormalMainPredictionForMetrics(match, prediction, publicationIndex = null) {
  if (!prediction || isReferencePrediction(prediction)) return false;
  if (!resolvePublishedRecommendation(match, prediction, publicationIndex)) return false;
  const officialOdds = Number(prediction.odds);
  const officialHandicapLine = prediction.oddsPoolCode === "HHAD"
    ? (prediction.handicapLine ?? match?.handicapLine)
    : 0;
  return isOfficialRecommendationEligible(
    prediction,
    officialOdds,
    officialHandicapLine
  );
}

function predictionProfileKey(match) {
  const profile = matchVolatilityProfile(match);
  if (profile.isJapan) return "japan";
  if (profile.isInternational) return "international";
  return "other";
}

function predictionOddsBucket(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value <= 1.45) return "sp_le_1_45";
  if (value <= 1.7) return "sp_1_46_1_70";
  if (value <= 2.05) return "sp_1_71_2_05";
  if (value <= 2.6) return "sp_2_06_2_60";
  return "sp_gt_2_60";
}

function analysisMatchIdentity(match) {
  return normText(
    match?.sourceMatchId
    || String(match?.id || "").replace(/^sporttery_/, "")
    || [
      match?.kickoffTime,
      match?.homeTeamName || match?.homeTeam || match?.homeTeamNameEn || match?.homeTeamId,
      match?.awayTeamName || match?.awayTeam || match?.awayTeamNameEn || match?.awayTeamId,
    ].filter(Boolean).join("|")
  );
}

function analysisMatchQuality(match) {
  let score = 0;
  if (match?.status === "FINISHED") score += 40;
  if (Number.isFinite(match?.scoreHome) && Number.isFinite(match?.scoreAway)) score += 30;
  if (match?.predictionMeta?.lockedAt) score += 8;
  if (Array.isArray(match?.predictions) && match.predictions.length) score += 6;
  if (match?.probabilityModel?.scoreDistribution?.length) score += 4;
  if (match?.odds || match?.handicapOdds) score += 2;
  return score;
}

function dedupeAnalysisMatches(matches) {
  const byId = new Map();
  for (const match of matches || []) {
    const key = analysisMatchIdentity(match);
    if (!key) continue;
    const previous = byId.get(key);
    if (!previous || analysisMatchQuality(match) >= analysisMatchQuality(previous)) {
      byId.set(key, match);
    }
  }
  return [...byId.values()];
}

function buildPredictionHealth(existingMatches, publicationIndex = null) {
  const summarize = (rows, minSettled = 24, minHitRate = 0.38) => {
    const settledRows = rows.filter((row) => row.resultStatus === "WON" || row.resultStatus === "LOST");
    const won = settledRows.filter((row) => row.resultStatus === "WON").length;
    const lost = settledRows.filter((row) => row.resultStatus === "LOST").length;
    const settled = won + lost;
    const hitRate = settled ? won / settled : null;
    const independentMatchDays = distinctMatchDayCount(settledRows);
    const hotSampleReady = settled >= Math.max(SAFE_AUTO_TUNING_MIN_ROWS, minSettled)
      && independentMatchDays >= SAFE_AUTO_TUNING_MIN_MATCH_DAYS;
    return {
      settled,
      won,
      lost,
      independentMatchDays,
      hitRate: hitRate === null ? null : Number(hitRate.toFixed(3)),
      urgentCooldown: settled >= Math.min(3, minSettled) && hitRate !== null && hitRate < Math.min(minHitRate, 0.35),
      hot: hotSampleReady && hitRate !== null && hitRate >= Math.max(minHitRate + 0.16, 0.58),
      cooldown: settled >= minSettled && hitRate < minHitRate,
    };
  };
  const summarizeBy = (items, keyFn, minSettled = 14, minHitRate = 0.36) => {
    const output = {};
    for (const row of items) {
      const key = keyFn(row);
      if (!key) continue;
      if (!output[key]) output[key] = [];
      output[key].push(row);
    }
    return Object.fromEntries(Object.entries(output).map(([key, group]) => [key, summarize(group, minSettled, minHitRate)]));
  };

  const rows = [];
  for (const match of dedupeAnalysisMatches(existingMatches || [])) {
    if (!isTrustedFinishedForSettlement(match)) continue;
    for (const prediction of match.predictions || []) {
      if (!prediction || prediction.tipCode === "WATCH") continue;
      if (!isFormalMainPredictionForMetrics(match, prediction, publicationIndex)) continue;
      if (prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") continue;
      const profileKey = predictionProfileKey(match);
      const odds = Number(prediction.odds || 0);
      const marketType = predictionGameplayMarket(prediction);
      rows.push({
        marketType,
        roleMarketType: normText(prediction.marketType).toUpperCase(),
        tipCode: prediction.tipCode,
        odds,
        oddsBucket: predictionOddsBucket(odds),
        profileKey,
        matchDay: matchReviewDate(match),
        isSidePick: prediction.tipCode === "1" || prediction.tipCode === "2",
        isHomePick: prediction.tipCode === "1",
        isAwayPick: prediction.tipCode === "2",
        isLowSpSide: (prediction.tipCode === "1" || prediction.tipCode === "2") && odds > 0 && odds <= 1.7,
        resultStatus: prediction.resultStatus,
      });
    }
  }

  const byMarket = Object.fromEntries(
    ["1X2", "HHAD", "GOALS"].map((marketType) => [
      marketType,
      summarize(rows.filter((row) => row.marketType === marketType), 10, 0.4),
    ])
  );
  const bestRows = rows.filter((row) => row.roleMarketType === "BEST");
  const hadRows = rows.filter((row) => row.marketType === "1X2");
  const hhadRows = rows.filter((row) => row.marketType === "HHAD");

  return {
    version: "settled-prediction-health-v4-market-isolated",
    generatedAt: new Date().toISOString(),
    total: summarize(rows),
    byMarket,
    byTip: summarizeBy(rows, (row) => `${row.marketType}:${row.tipCode}`, 5, 0.42),
    byProfile: summarizeBy(rows, (row) => row.profileKey, 5, 0.42),
    byMarketProfile: summarizeBy(rows, (row) => `${row.marketType}:${row.profileKey}`, 10, 0.4),
    // Legacy top-level side buckets are HAD-only. HHAD has its own namespace
    // below and can never cool or heat a raw 1X2 gate.
    byOddsBucket: summarizeBy(hadRows.filter((row) => row.isSidePick), (row) => row.oddsBucket, 6, 0.42),
    oneXTwo: {
      byTip: summarizeBy(hadRows, (row) => row.tipCode, 8, 0.4),
      byProfile: summarizeBy(hadRows, (row) => row.profileKey, 10, 0.4),
      byOddsBucket: summarizeBy(hadRows.filter((row) => row.isSidePick), (row) => row.oddsBucket, 5, 0.42),
      lowSpSide: summarize(hadRows.filter((row) => row.isLowSpSide), 7, 0.42),
    },
    hhad: {
      byTip: summarizeBy(hhadRows, (row) => row.tipCode, 8, 0.4),
      byProfile: summarizeBy(hhadRows, (row) => row.profileKey, 10, 0.4),
      byOddsBucket: summarizeBy(hhadRows.filter((row) => row.isSidePick), (row) => row.oddsBucket, 5, 0.42),
      lowSpSide: summarize(hhadRows.filter((row) => row.isLowSpSide), 7, 0.42),
    },
    best: {
      overall: summarize(bestRows, 5, 0.5),
      byMarket: {
        "1X2": summarize(bestRows.filter((row) => row.marketType === "1X2"), 5, 0.5),
        HHAD: summarize(bestRows.filter((row) => row.marketType === "HHAD"), 5, 0.5),
      },
    },
    goals: {
      byTip: summarizeBy(rows.filter((row) => row.marketType === "GOALS"), (row) => row.tipCode, 8, 0.4),
      byProfile: summarizeBy(rows.filter((row) => row.marketType === "GOALS"), (row) => row.profileKey, 10, 0.4),
    },
    homeFavorite: summarize(hadRows.filter((row) => row.tipCode === "1"), 8, 0.42),
    awayFavorite: summarize(hadRows.filter((row) => row.tipCode === "2"), 8, 0.42),
    lowSpSide: summarize(hadRows.filter((row) => row.isLowSpSide), 7, 0.42),
    under25: summarize(rows.filter((row) => row.marketType === "GOALS" && row.tipCode === "U2.5"), 8, 0.42),
  };
}

function isCoolingBucket(bucket) {
  return Boolean(bucket?.cooldown || bucket?.urgentCooldown);
}

function isHotBucket(bucket, minSettled = 3, minHitRate = 0.58) {
  return Boolean(
    bucket
    && Number(bucket.settled || 0) >= Math.max(SAFE_AUTO_TUNING_MIN_ROWS, minSettled)
    && Number(bucket.independentMatchDays || 0) >= SAFE_AUTO_TUNING_MIN_MATCH_DAYS
    && Number(bucket.hitRate || 0) >= minHitRate
  );
}

function bucketHitRate(bucket) {
  return Number.isFinite(bucket?.hitRate) ? bucket.hitRate : null;
}

function hardCoolingBucket(bucket, minSettled = 5, maxHitRate = 0.42) {
  const settled = Number(bucket?.settled || 0);
  const hitRate = bucketHitRate(bucket);
  return settled >= minSettled && hitRate !== null && hitRate < maxHitRate;
}

function predictionRowsFromMatches(existingMatches, publicationIndex = null) {
  const rows = [];
  for (const match of dedupeAnalysisMatches(existingMatches || [])) {
    if (!isTrustedFinishedForSettlement(match)) continue;
    if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) continue;
    const actual = match.scoreHome > match.scoreAway ? "1" : match.scoreHome < match.scoreAway ? "2" : "X";
    const totalGoals = match.scoreHome + match.scoreAway;
    const finalProbabilities = match.probabilityModel?.oneXTwo?.final;
    const marketProbabilities = match.probabilityModel?.oneXTwo?.market;
    const profileKey = predictionProfileKey(match);

    for (const prediction of match.predictions || []) {
      if (!prediction || prediction.tipCode === "WATCH") continue;
      if (!isFormalMainPredictionForMetrics(match, prediction, publicationIndex)) continue;
      if (prediction.resultStatus !== "WON" && prediction.resultStatus !== "LOST") continue;
      const marketType = predictionGameplayMarket(prediction);
      const isOneXTwo = marketType === "1X2";
      const probability = isOneXTwo && finalProbabilities
        ? prediction.tipCode === "1"
          ? finalProbabilities.home
          : prediction.tipCode === "X"
            ? finalProbabilities.draw
            : prediction.tipCode === "2"
              ? finalProbabilities.away
              : null
        : null;
      rows.push({
        sourceMatchId: normText(match.sourceMatchId || String(match.id || "").replace(/^sporttery_/, "")),
        marketType,
        roleMarketType: normText(prediction.marketType).toUpperCase(),
        tipCode: prediction.tipCode,
        odds: Number(prediction.odds || 0),
        oddsBucket: predictionOddsBucket(prediction.odds),
        profileKey,
        policyVersion: match.predictionMeta?.policyVersion || "unknown",
        promptVersion: match.predictionMeta?.promptVersion || "unknown",
        resultStatus: prediction.resultStatus,
        kickoffTime: match.kickoffTime,
        matchDay: matchReviewDate(match),
        actual,
        totalGoals,
        probability,
        finalProbabilities: isOneXTwo ? finalProbabilities : null,
        marketProbabilities: isOneXTwo ? marketProbabilities : null,
      });
    }
  }
  return rows;
}

function summarizeCalibrationRows(rows) {
  const won = rows.filter((row) => row.resultStatus === "WON").length;
  const lost = rows.filter((row) => row.resultStatus === "LOST").length;
  const settled = won + lost;
  return {
    settled,
    won,
    lost,
    independentMatchDays: distinctMatchDayCount(rows),
    hitRate: settled ? Number((won / settled).toFixed(3)) : null,
  };
}

function summarizeCalibrationBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries(
    Array.from(groups.entries()).map(([key, group]) => [key, summarizeCalibrationRows(group)])
  );
}

function brierScore(rows) {
  const scored = rows.filter((row) => row.finalProbabilities && ["1", "X", "2"].includes(row.actual));
  if (!scored.length) return null;
  const total = scored.reduce((sum, row) => {
    const actual = {
      home: row.actual === "1" ? 1 : 0,
      draw: row.actual === "X" ? 1 : 0,
      away: row.actual === "2" ? 1 : 0,
    };
    const probabilities = row.finalProbabilities;
    return sum
      + Math.pow((probabilities.home || 0) / 100 - actual.home, 2)
      + Math.pow((probabilities.draw || 0) / 100 - actual.draw, 2)
      + Math.pow((probabilities.away || 0) / 100 - actual.away, 2);
  }, 0);
  return Number((total / scored.length).toFixed(4));
}

function logLossScore(rows) {
  const scored = rows.filter((row) => row.finalProbabilities && ["1", "X", "2"].includes(row.actual));
  if (!scored.length) return null;
  const total = scored.reduce((sum, row) => {
    const probability = row.actual === "1"
      ? row.finalProbabilities.home
      : row.actual === "X"
        ? row.finalProbabilities.draw
        : row.finalProbabilities.away;
    return sum - Math.log(clamp((probability || 1) / 100, 0.01, 0.99));
  }, 0);
  return Number((total / scored.length).toFixed(4));
}

function matchReviewDate(match) {
  return normText(match?.businessDate || match?.matchDate || String(match?.kickoffTime || "").slice(0, 10));
}

function distinctMatchDayCount(rows) {
  return new Set((rows || []).map((row) => (
    normText(row?.matchDay || matchReviewDate(row))
  )).filter(Boolean)).size;
}

function safeAutomaticTuningSample(summary) {
  return Number(summary?.settled ?? summary?.rows ?? 0) >= SAFE_AUTO_TUNING_MIN_ROWS
    && Number(summary?.independentMatchDays || 0) >= SAFE_AUTO_TUNING_MIN_MATCH_DAYS;
}

function scoreOutcomeCode(home, away) {
  if (home > away) return "1";
  if (home < away) return "2";
  return "X";
}

function scoreTotalBand(home, away) {
  const total = home + away;
  if (total <= 1) return "0-1";
  if (total === 2) return "2";
  if (total === 3) return "3";
  return "4+";
}

function parseScoreLabel(label) {
  const match = String(label || "").trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) return null;
  return {
    home: Number(match[1]),
    away: Number(match[2]),
  };
}

function scoreShapeKey(home, away) {
  const total = home + away;
  const diff = Math.abs(home - away);
  if (total <= 1) return "low-0-1";
  if (home === away && home > 0) return "draw-btts";
  if (diff === 1 && home > 0 && away > 0 && total === 3) return "one-goal-btts";
  if (diff >= 2 && (home === 0 || away === 0) && total <= 3) return "clear-clean-sheet";
  if (diff >= 2 && home > 0 && away > 0 && total >= 4) return "clear-btts-open";
  if (total >= 4) return "open-4plus";
  return "mid-mixed";
}

function ratio(count, total) {
  return total ? Number((count / total).toFixed(3)) : null;
}

function scoredProjectedMatches(existingMatches) {
  return dedupeAnalysisMatches(existingMatches || [])
    .filter((match) => (
      isTrustedFinishedForSettlement(match)
      && Number.isFinite(match.scoreHome)
      && Number.isFinite(match.scoreAway)
      && Number.isFinite(match.projectedScoreHome)
      && Number.isFinite(match.projectedScoreAway)
    ))
    .sort((a, b) => `${matchReviewDate(a)}${a.kickoffTime || ""}`.localeCompare(`${matchReviewDate(b)}${b.kickoffTime || ""}`));
}

function matchesInLatestDays(scored, days = 2) {
  if (!scored.length) return [];

  const dates = scored.map(matchReviewDate).filter(Boolean).sort();
  const latestDate = dates[dates.length - 1];
  const latestTime = Date.parse(`${latestDate}T00:00:00Z`);
  const cutoff = Number.isFinite(latestTime)
    ? new Date(latestTime - Math.max(0, days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : latestDate;
  return scored.filter((match) => matchReviewDate(match) >= cutoff);
}

function recentScoredMatches(existingMatches, days = 2) {
  return matchesInLatestDays(scoredProjectedMatches(existingMatches), days);
}

function calibrationScoredMatches(existingMatches) {
  const scored = scoredProjectedMatches(existingMatches);
  const recentRows = matchesInLatestDays(scored, SCORE_CALIBRATION_RECENT_DAYS);
  const rollingRows = matchesInLatestDays(scored, SCORE_CALIBRATION_ROLLING_DAYS);
  const useRolling = recentRows.length < SCORE_CALIBRATION_MIN_ROWS && rollingRows.length > recentRows.length;
  return {
    rows: useRolling ? rollingRows : recentRows,
    recentRows: recentRows.length,
    totalProjectedRows: scored.length,
    sampleDays: useRolling ? SCORE_CALIBRATION_ROLLING_DAYS : SCORE_CALIBRATION_RECENT_DAYS,
    recentDays: SCORE_CALIBRATION_RECENT_DAYS,
    rollingDays: SCORE_CALIBRATION_ROLLING_DAYS,
    minRows: SCORE_CALIBRATION_MIN_ROWS,
    source: useRolling ? "rolling-settled-projected-scores" : "recent-settled-projected-scores",
  };
}

function scoreDistributionCount(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function scoreRateByKey(rows, keyFn) {
  const total = rows.length || 1;
  const counts = scoreDistributionCount(rows, keyFn);
  return Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, count / total]));
}

function scoreRankBoostMap(actualRates, projectedRates, total, positiveScale, negativeScale, maxPositive = 0.1, maxNegative = 0.06) {
  if (total < SAFE_AUTO_TUNING_MIN_ROWS) return {};
  const keys = new Set([...Object.keys(actualRates || {}), ...Object.keys(projectedRates || {})]);
  const boosts = {};
  for (const key of keys) {
    const gap = Number(actualRates[key] || 0) - Number(projectedRates[key] || 0);
    if (gap >= 0.12) {
      boosts[key] = Number(clamp(gap * positiveScale, 0.018, maxPositive).toFixed(3));
    } else if (gap <= -0.16) {
      boosts[key] = Number(clamp(gap * negativeScale, -maxNegative, -0.016).toFixed(3));
    }
  }
  return Object.fromEntries(Object.entries(boosts).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0])));
}

function buildScoreCalibration(existingMatches) {
  const sampleSource = calibrationScoredMatches(existingMatches);
  const rows = sampleSource.rows;
  const total = rows.length;
  const independentMatchDays = distinctMatchDayCount(rows);
  const automaticTuningSampleReady = total >= SAFE_AUTO_TUNING_MIN_ROWS
    && independentMatchDays >= SAFE_AUTO_TUNING_MIN_MATCH_DAYS;
  const emptySummary = {
    rows: total,
    independentMatchDays,
    automaticTuningSampleReady,
    recentRows: sampleSource.recentRows,
    totalProjectedRows: sampleSource.totalProjectedRows,
    sampleDays: sampleSource.sampleDays,
    recentDays: sampleSource.recentDays,
    rollingDays: sampleSource.rollingDays,
    minRows: sampleSource.minRows,
    exactHitRate: null,
    top3ExactHitRate: null,
    outcomeHitRate: null,
    top3OutcomeHitRate: null,
    over25HitRate: null,
    top3Over25HitRate: null,
    totalBandHitRate: null,
    top3TotalBandHitRate: null,
    avgActualGoals: null,
    avgProjectedGoals: null,
    actualOver25Rate: null,
    projectedOver25Rate: null,
    actualBttsRate: null,
    projectedBttsRate: null,
    projectedLowScoreRate: null,
    actualScores: {},
    projectedScores: {},
    actualBands: {},
    projectedBands: {},
    actualShapes: {},
    projectedShapes: {},
  };

  if (!total) {
    return {
      version: "score-calibration-v2",
      generatedAt: new Date().toISOString(),
      source: sampleSource.source,
      sample: emptySummary,
      adjustments: {
        totalLambdaAdjustment: 0,
        over25ProbabilityShift: 0,
        bttsProbabilityShift: 0,
        lowScoreRankPenalty: 0,
        openScoreRankBoost: 0,
        bttsRankBoost: 0,
        bandRankBoosts: {},
        shapeRankBoosts: {},
      },
      reasons: ["no-settled-projected-score-sample"],
    };
  }

  const enriched = rows.map((match) => {
    const actualHome = Number(match.scoreHome);
    const actualAway = Number(match.scoreAway);
    const projectedHome = Number(match.projectedScoreHome);
    const projectedAway = Number(match.projectedScoreAway);
    const topScores = (match.probabilityModel?.scoreDistribution || [])
      .slice(0, 3)
      .map((item) => parseScoreLabel(item?.label))
      .filter(Boolean);
    return {
      actualHome,
      actualAway,
      projectedHome,
      projectedAway,
      actualTotal: actualHome + actualAway,
      projectedTotal: projectedHome + projectedAway,
      actualOutcome: scoreOutcomeCode(actualHome, actualAway),
      projectedOutcome: scoreOutcomeCode(projectedHome, projectedAway),
      actualBand: scoreTotalBand(actualHome, actualAway),
      projectedBand: scoreTotalBand(projectedHome, projectedAway),
      actualShape: scoreShapeKey(actualHome, actualAway),
      projectedShape: scoreShapeKey(projectedHome, projectedAway),
      actualBtts: actualHome > 0 && actualAway > 0,
      projectedBtts: projectedHome > 0 && projectedAway > 0,
      top3Exact: topScores.some((row) => row.home === actualHome && row.away === actualAway),
      top3Outcome: topScores.some((row) => scoreOutcomeCode(row.home, row.away) === scoreOutcomeCode(actualHome, actualAway)),
      top3Over25: topScores.some((row) => (row.home + row.away > 2.5) === (actualHome + actualAway > 2.5)),
      top3TotalBand: topScores.some((row) => scoreTotalBand(row.home, row.away) === scoreTotalBand(actualHome, actualAway)),
    };
  });

  const avgActualGoals = enriched.reduce((sum, row) => sum + row.actualTotal, 0) / total;
  const avgProjectedGoals = enriched.reduce((sum, row) => sum + row.projectedTotal, 0) / total;
  const totalGap = avgActualGoals - avgProjectedGoals;
  const actualOver25Rate = ratio(enriched.filter((row) => row.actualTotal > 2.5).length, total);
  const projectedOver25Rate = ratio(enriched.filter((row) => row.projectedTotal > 2.5).length, total);
  const actualBttsRate = ratio(enriched.filter((row) => row.actualBtts).length, total);
  const projectedBttsRate = ratio(enriched.filter((row) => row.projectedBtts).length, total);
  const projectedLowScoreRate = ratio(enriched.filter((row) => row.projectedTotal <= 2).length, total);
  const over25Gap = (actualOver25Rate ?? 0) - (projectedOver25Rate ?? 0);
  const bttsGap = (actualBttsRate ?? 0) - (projectedBttsRate ?? 0);
  const hasLowScoreBias = automaticTuningSampleReady && totalGap >= 0.45 && Number(projectedLowScoreRate || 0) >= 0.5;
  const hasUnderBias = automaticTuningSampleReady && over25Gap >= 0.18;
  const hasBttsBias = automaticTuningSampleReady && bttsGap >= 0.18;
  const actualBandRates = scoreRateByKey(enriched, (row) => row.actualBand);
  const projectedBandRates = scoreRateByKey(enriched, (row) => row.projectedBand);
  const actualShapeRates = scoreRateByKey(enriched, (row) => row.actualShape);
  const projectedShapeRates = scoreRateByKey(enriched, (row) => row.projectedShape);
  const tuningRowCount = automaticTuningSampleReady ? total : 0;
  const bandRankBoosts = scoreRankBoostMap(actualBandRates, projectedBandRates, tuningRowCount, 0.18, 0.1, 0.095, 0.055);
  const shapeRankBoosts = scoreRankBoostMap(actualShapeRates, projectedShapeRates, tuningRowCount, 0.2, 0.09, 0.105, 0.06);
  const exactHitRate = ratio(enriched.filter((row) => row.actualHome === row.projectedHome && row.actualAway === row.projectedAway).length, total);
  const top3ExactHitRate = ratio(enriched.filter((row) => row.top3Exact).length, total);
  const top3Lift = Number(top3ExactHitRate ?? 0) - Number(exactHitRate ?? 0);
  const reasons = [];

  if (hasLowScoreBias) reasons.push("recent-actual-goals-above-projection");
  if (hasUnderBias) reasons.push("recent-over25-above-projection");
  if (hasBttsBias) reasons.push("recent-btts-above-projection");
  if (sampleSource.sampleDays > sampleSource.recentDays) reasons.push("rolling-score-sample-for-hit-rate");
  if (top3Lift >= 0.15) reasons.push("top3-score-covers-more-than-primary");
  if (Object.keys(bandRankBoosts).length) reasons.push("score-total-band-hit-rate-adjustment");
  if (Object.keys(shapeRankBoosts).length) reasons.push("score-shape-hit-rate-adjustment");
  if (!automaticTuningSampleReady) reasons.push("automatic-tuning-sample-blocked");
  if (!reasons.length) reasons.push("neutral-score-sample");

  const totalLambdaAdjustment = hasLowScoreBias
    ? clamp(totalGap * 0.075, 0, 0.16)
    : automaticTuningSampleReady && totalGap <= -0.55
      ? clamp(totalGap * 0.045, -0.1, 0)
      : 0;
  const over25ProbabilityShift = hasUnderBias ? clamp(over25Gap * 0.12, 0, 0.07) : 0;
  const bttsProbabilityShift = hasBttsBias ? clamp(bttsGap * 0.08, 0, 0.05) : 0;

  return {
    version: "score-calibration-v2",
    generatedAt: new Date().toISOString(),
    source: sampleSource.source,
    sample: {
      rows: total,
      independentMatchDays,
      automaticTuningSampleReady,
      recentRows: sampleSource.recentRows,
      totalProjectedRows: sampleSource.totalProjectedRows,
      sampleDays: sampleSource.sampleDays,
      recentDays: sampleSource.recentDays,
      rollingDays: sampleSource.rollingDays,
      minRows: sampleSource.minRows,
      exactHitRate,
      top3ExactHitRate,
      outcomeHitRate: ratio(enriched.filter((row) => row.actualOutcome === row.projectedOutcome).length, total),
      top3OutcomeHitRate: ratio(enriched.filter((row) => row.top3Outcome).length, total),
      over25HitRate: ratio(enriched.filter((row) => (row.actualTotal > 2.5) === (row.projectedTotal > 2.5)).length, total),
      top3Over25HitRate: ratio(enriched.filter((row) => row.top3Over25).length, total),
      totalBandHitRate: ratio(enriched.filter((row) => row.actualBand === row.projectedBand).length, total),
      top3TotalBandHitRate: ratio(enriched.filter((row) => row.top3TotalBand).length, total),
      avgActualGoals: Number(avgActualGoals.toFixed(2)),
      avgProjectedGoals: Number(avgProjectedGoals.toFixed(2)),
      actualOver25Rate,
      projectedOver25Rate,
      actualBttsRate,
      projectedBttsRate,
      projectedLowScoreRate,
      actualScores: scoreDistributionCount(enriched, (row) => `${row.actualHome}-${row.actualAway}`),
      projectedScores: scoreDistributionCount(enriched, (row) => `${row.projectedHome}-${row.projectedAway}`),
      actualBands: scoreDistributionCount(enriched, (row) => row.actualBand),
      projectedBands: scoreDistributionCount(enriched, (row) => row.projectedBand),
      actualShapes: scoreDistributionCount(enriched, (row) => row.actualShape),
      projectedShapes: scoreDistributionCount(enriched, (row) => row.projectedShape),
    },
    adjustments: {
      totalLambdaAdjustment: Number(totalLambdaAdjustment.toFixed(3)),
      over25ProbabilityShift: Number(over25ProbabilityShift.toFixed(3)),
      bttsProbabilityShift: Number(bttsProbabilityShift.toFixed(3)),
      lowScoreRankPenalty: hasLowScoreBias ? Number(clamp(totalGap * 0.045, 0.02, 0.09).toFixed(3)) : 0,
      openScoreRankBoost: hasLowScoreBias ? Number(clamp(totalGap * 0.055 + over25Gap * 0.06, 0.03, 0.11).toFixed(3)) : 0,
      bttsRankBoost: hasBttsBias ? Number(clamp(bttsGap * 0.08, 0.02, 0.05).toFixed(3)) : 0,
      bandRankBoosts,
      shapeRankBoosts,
    },
    reasons,
  };
}

function calibrationWeightForProfile(summary, profileKey) {
  const profile = summary.byProfile?.[profileKey];
  const marketProfile = summary.byMarketProfile?.[`1X2:${profileKey}`];
  const settled = Number(marketProfile?.settled || profile?.settled || 0);
  const hitRate = Number.isFinite(marketProfile?.hitRate) ? marketProfile.hitRate : profile?.hitRate;
  const relaxationSampleReady = safeAutomaticTuningSample(marketProfile || profile);

  let market = 0.58;
  let elo = 0.22;
  let poisson = 0.2;
  if (profileKey === "international") {
    market = 0.62;
    elo = 0.2;
    poisson = 0.18;
  } else if (profileKey === "japan") {
    market = 0.6;
    elo = 0.18;
    poisson = 0.22;
  }

  if (settled >= 8 && hitRate !== null && hitRate < 0.38) {
    market += 0.06;
    elo -= 0.02;
    poisson -= 0.04;
  } else if (relaxationSampleReady && hitRate !== null && hitRate >= 0.55) {
    market -= 0.04;
    poisson += 0.04;
  }

  const total = market + elo + poisson;
  return {
    market: Number((market / total).toFixed(3)),
    elo: Number((elo / total).toFixed(3)),
    poisson: Number((poisson / total).toFixed(3)),
    sample: settled,
    independentMatchDays: Number((marketProfile || profile)?.independentMatchDays || 0),
    hitRate: hitRate ?? null,
  };
}

function calibrationGateForProfile(summary, profileKey) {
  const profile = summary.byMarketProfile?.[`1X2:${profileKey}`] || summary.byProfile?.[profileKey];
  const goalsProfile = summary.byMarketProfile?.[`GOALS:${profileKey}`];
  const settled = Number(profile?.settled || 0);
  const relaxationSampleReady = safeAutomaticTuningSample(profile);
  const hitRate = Number.isFinite(profile?.hitRate) ? profile.hitRate : null;
  const goalsHitRate = Number.isFinite(goalsProfile?.hitRate) ? goalsProfile.hitRate : null;
  const cold = settled >= 5 && hitRate !== null && hitRate < 0.4;
  const veryCold = settled >= 5 && hitRate !== null && hitRate < 0.32;
  const hot = relaxationSampleReady && hitRate !== null && hitRate >= 0.56;

  return {
    minProbabilityBoost: veryCold ? 0.07 : cold ? 0.045 : hot ? -0.015 : 0,
    minModelGapBoost: veryCold ? 0.04 : cold ? 0.025 : hot ? -0.01 : 0,
    minHandicapSupportBoost: profileKey === "international" ? (cold ? 0.06 : 0.035) : profileKey === "japan" ? (cold ? 0.05 : 0.025) : cold ? 0.025 : 0,
    trustPenalty: veryCold ? 12 : cold ? 7 : 0,
    maxRiskTags: veryCold ? 1 : cold ? 2 : 3,
    goalsMinBoost: goalsHitRate !== null && goalsProfile?.settled >= 5 && goalsHitRate < 0.4 ? 0.04 : 0,
    reason: veryCold ? "very-cold-profile" : cold ? "cold-profile" : hot ? "hot-profile" : "neutral-profile",
  };
}

function buildModelCalibration(existingMatches, publicationIndex = null) {
  const rows = predictionRowsFromMatches(existingMatches, publicationIndex);
  const oneXTwoRows = rows.filter((row) => row.marketType === "1X2");
  const hhadRows = rows.filter((row) => row.marketType === "HHAD");
  const bestRows = rows.filter((row) => row.roleMarketType === "BEST");
  const goalsRows = rows.filter((row) => row.marketType === "GOALS");
  const scoreCalibration = buildScoreCalibration(existingMatches);
  const summary = {
    total: summarizeCalibrationRows(rows),
    byMarket: summarizeCalibrationBy(rows, (row) => row.marketType),
    byRole: summarizeCalibrationBy(rows, (row) => row.roleMarketType),
    byProfile: summarizeCalibrationBy(rows, (row) => row.profileKey),
    byMarketProfile: summarizeCalibrationBy(rows, (row) => `${row.marketType}:${row.profileKey}`),
    byOddsBucket: summarizeCalibrationBy(rows.filter((row) => row.marketType === "1X2" && ["1", "2"].includes(row.tipCode)), (row) => row.oddsBucket),
    byTip: summarizeCalibrationBy(rows, (row) => `${row.marketType}:${row.tipCode}`),
  };
  const profiles = ["international", "japan", "other"];
  const weightsByProfile = Object.fromEntries(profiles.map((profileKey) => [profileKey, calibrationWeightForProfile(summary, profileKey)]));
  const gateByProfile = Object.fromEntries(profiles.map((profileKey) => [profileKey, calibrationGateForProfile(summary, profileKey)]));
  const oneXTwoBrier = brierScore(oneXTwoRows);
  const oneXTwoLogLoss = logLossScore(oneXTwoRows);
  const recommendationPool = rows.filter((row) => (
    row.roleMarketType === "BEST"
    && (row.marketType === "1X2" || row.marketType === "HHAD")
    && row.tipCode !== "WATCH"
  ));

  return {
    version: "rolling-calibration-v1",
    generatedAt: new Date().toISOString(),
    source: "settled-pre-match-predictions",
    sample: {
      rows: rows.length,
      independentMatchDays: summary.total.independentMatchDays,
      oneXTwo: oneXTwoRows.length,
      hhad: hhadRows.length,
      goals: goalsRows.length,
      best: bestRows.length,
      recommendationPool: recommendationPool.length,
      automaticRelaxationMinimumRows: SAFE_AUTO_TUNING_MIN_ROWS,
      automaticRelaxationMinimumMatchDays: SAFE_AUTO_TUNING_MIN_MATCH_DAYS,
    },
    metrics: {
      oneXTwoBrier,
      oneXTwoLogLoss,
      oneXTwoHitRate: summary.byMarket["1X2"]?.hitRate ?? null,
      goalsHitRate: summary.byMarket.GOALS?.hitRate ?? null,
      bestHitRate: summary.byRole.BEST?.hitRate ?? null,
    },
    weightsByProfile,
    gateByProfile,
    scoreCalibration,
    summary,
    note: {
      zh: "该文件由已结算赛前预测自动生成，只用于动态调权和推荐闸门，不会回写赛后方向。",
      en: "Generated from settled pre-match predictions. It only adjusts weights and gates; it never rewrites post-match picks.",
    },
  };
}

function strategyRuleIsActive(rule) {
  return Boolean(rule && rule.onlineAction === "tighten" && rule.adjustments);
}

function roundGate(value) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(3));
}

function mergeCalibrationGate(baseGate, strategyGate) {
  if (!strategyRuleIsActive(strategyGate)) return baseGate;
  const base = baseGate || {};
  const rawAdjustment = strategyGate.adjustments || {};
  const adjustment = {
    minProbabilityBoost: clamp(Number(rawAdjustment.minProbabilityBoost || 0), 0, 0.04),
    minModelGapBoost: clamp(Number(rawAdjustment.minModelGapBoost || 0), 0, 0.025),
    minHandicapSupportBoost: clamp(Number(rawAdjustment.minHandicapSupportBoost || 0), 0, 0.025),
    trustPenalty: clamp(Number(rawAdjustment.trustPenalty || 0), 0, 6),
    maxRiskTagsDelta: clamp(Number(rawAdjustment.maxRiskTagsDelta || 0), -1, 0),
    goalsMinBoost: clamp(Number(rawAdjustment.goalsMinBoost || 0), 0, 0.03),
  };
  const baseMaxRiskTags = Number.isFinite(base.maxRiskTags) ? Number(base.maxRiskTags) : 3;
  const maxRiskTagsDelta = Number(adjustment.maxRiskTagsDelta || 0);
  return {
    ...base,
    minProbabilityBoost: roundGate(clamp(Number(base.minProbabilityBoost || 0) + Number(adjustment.minProbabilityBoost || 0), -0.02, 0.11)),
    minModelGapBoost: roundGate(clamp(Number(base.minModelGapBoost || 0) + Number(adjustment.minModelGapBoost || 0), -0.02, 0.07)),
    minHandicapSupportBoost: roundGate(clamp(Number(base.minHandicapSupportBoost || 0) + Number(adjustment.minHandicapSupportBoost || 0), -0.02, 0.09)),
    trustPenalty: Math.round(clamp(Number(base.trustPenalty || 0) + Number(adjustment.trustPenalty || 0), 0, 18)),
    maxRiskTags: Math.round(clamp(baseMaxRiskTags + maxRiskTagsDelta, 1, 5)),
    goalsMinBoost: roundGate(clamp(Number(base.goalsMinBoost || 0) + Number(adjustment.goalsMinBoost || 0), -0.02, 0.07)),
    reason: [base.reason, `strategy:${strategyGate.key || "profile"}`].filter(Boolean).join("+"),
  };
}

function referenceShadowTighteningFromStrategy(strategy) {
  const reference = strategy?.referenceShadowRows;
  const tightening = reference?.tightening;
  if (
    reference?.promotionEligible !== false
    || reference?.countedInFormalMetrics !== false
    || reference?.activation?.automaticPromotionAllowed !== false
    || reference?.activation?.automaticLooseningAllowed !== false
    || reference?.activation?.onlineEffect !== "tighten-only"
    || Number(tightening?.activeGateCount || 0) <= 0
  ) return null;

  const gateMaps = [
    tightening.gateByMarket,
    tightening.gateByMarketProfile,
    tightening.gateByOddsBucket,
    tightening.gateByTip,
    tightening.gateByProfile,
  ];
  const rules = gateMaps.flatMap((map) => Object.values(map || {}));
  const unsafeRule = rules.some((rule) => {
    if (!rule || rule.onlineAction === "observe") return false;
    const adjustment = rule.adjustments || {};
    return rule.onlineAction !== "tighten"
      || Number(adjustment.minProbabilityBoost || 0) < 0
      || Number(adjustment.minModelGapBoost || 0) < 0
      || Number(adjustment.minHandicapSupportBoost || 0) < 0
      || Number(adjustment.trustPenalty || 0) < 0
      || Number(adjustment.goalsMinBoost || 0) < 0
      || Number(adjustment.maxRiskTagsDelta || 0) > 0;
  });
  if (unsafeRule) return null;

  return {
    version: strategy.version || null,
    generatedAt: strategy.generatedAt || null,
    activation: {
      mode: "reference-shadow-tightening",
      onlineEffect: "tighten-only-reference-shadow",
      sourceOnlineEffect: strategy.activation?.onlineEffect || null,
      promotionAllowed: false,
      looseningAllowed: false,
    },
    sample: reference.sample || {},
    activeGates: tightening.activeGates || {},
    gateByMarket: tightening.gateByMarket || {},
    gateByMarketProfile: tightening.gateByMarketProfile || {},
    gateByOddsBucket: tightening.gateByOddsBucket || {},
    gateByTip: tightening.gateByTip || {},
    gateByProfile: tightening.gateByProfile || {},
    gateByWebConsensus: {},
    referenceShadowRows: {
      version: reference.version || null,
      promotionEligible: false,
      countedInFormalMetrics: false,
      policy: reference.policy || null,
    },
  };
}

function applyModelStrategyToCalibration(calibration, strategy) {
  if (!calibration || !strategy) return calibration;
  const referenceTightening = referenceShadowTighteningFromStrategy(strategy);
  if (strategy.activation?.onlineEffect === "shadow" && !referenceTightening) {
    // A newly failed promotion gate must actively remove a previously embedded
    // guarded strategy. Leaving the old object in place would keep stale online
    // effects alive even though the current evaluation has fallen back to shadow.
    const { strategy: staleStrategy, ...withoutStrategy } = calibration;
    void staleStrategy;
    return withoutStrategy;
  }
  const applicableStrategy = strategy.activation?.onlineEffect === "shadow"
    ? referenceTightening
    : strategy;
  const next = {
    ...calibration,
    strategy: {
      ...applicableStrategy,
      activation: applicableStrategy.activation || null,
      sample: applicableStrategy.sample || {},
      activeGates: applicableStrategy.activeGates || {},
      gateByMarket: applicableStrategy.gateByMarket || {},
      gateByMarketProfile: applicableStrategy.gateByMarketProfile || {},
      gateByOddsBucket: applicableStrategy.gateByOddsBucket || {},
      gateByTip: applicableStrategy.gateByTip || {},
      gateByProfile: applicableStrategy.gateByProfile || {},
      gateByWebConsensus: applicableStrategy.gateByWebConsensus || {},
    },
  };
  next.gateByProfile = { ...(calibration.gateByProfile || {}) };
  for (const [profileKey, rule] of Object.entries(applicableStrategy.gateByProfile || {})) {
    next.gateByProfile[profileKey] = mergeCalibrationGate(next.gateByProfile[profileKey], rule);
  }
  return next;
}

function combineStrategyRules(rules) {
  const activeRules = rules.filter(strategyRuleIsActive);
  const combined = {
    minProbabilityBoost: 0,
    minModelGapBoost: 0,
    minHandicapSupportBoost: 0,
    trustPenalty: 0,
    maxRiskTagsDelta: 0,
    goalsMinBoost: 0,
    reasons: [],
  };

  for (const rule of activeRules) {
    const adjustment = rule.adjustments || {};
    combined.minProbabilityBoost += Math.max(0, Number(adjustment.minProbabilityBoost || 0));
    combined.minModelGapBoost += Math.max(0, Number(adjustment.minModelGapBoost || 0));
    combined.minHandicapSupportBoost += Math.max(0, Number(adjustment.minHandicapSupportBoost || 0));
    combined.trustPenalty += Math.max(0, Number(adjustment.trustPenalty || 0));
    combined.maxRiskTagsDelta += Math.min(0, Number(adjustment.maxRiskTagsDelta || 0));
    combined.goalsMinBoost += Math.max(0, Number(adjustment.goalsMinBoost || 0));
    combined.reasons.push(`strategy:${rule.key || "rule"}`);
  }

  return {
    minProbabilityBoost: roundGate(clamp(combined.minProbabilityBoost, 0, 0.08)),
    minModelGapBoost: roundGate(clamp(combined.minModelGapBoost, 0, 0.06)),
    minHandicapSupportBoost: roundGate(clamp(combined.minHandicapSupportBoost, 0, 0.07)),
    trustPenalty: Math.round(clamp(combined.trustPenalty, 0, 12)),
    maxRiskTagsDelta: Math.round(clamp(combined.maxRiskTagsDelta, -2, 0)),
    goalsMinBoost: roundGate(clamp(combined.goalsMinBoost, 0, 0.06)),
    reasons: combined.reasons,
  };
}

function webConsensusStrategyKeys(match, marketType) {
  const signal = webConsensusSignal(match);
  if (!webConsensusModelEligible(signal)) return [];
  const buckets = Array.isArray(signal.buckets)
    ? signal.buckets.filter((key) => normText(key).startsWith("web:") && key !== "web:usable" && key !== "web:audit-only")
    : [];
  return Array.from(new Set([
    ...buckets,
    ...buckets.map((key) => `${marketType}:${key}`),
  ]));
}

function strategyGateForPrediction(match, marketType, tipCode, oddsBucket) {
  const strategy = match.modelCalibration?.strategy;
  if (!strategy || strategy.activation?.onlineEffect === "shadow") return combineStrategyRules([]);
  const oddsRules = strategy.gateByOddsBucket || {};
  const qualifiedOddsRule = oddsRules[`${marketType}:${oddsBucket}`];
  const hasQualifiedOddsKeys = Object.keys(oddsRules).some((key) => key.includes(":"));
  // Historical artifacts used an unqualified bucket. Keep that fallback for
  // HAD only; never let a legacy mixed bucket tighten an HHAD recommendation.
  const legacyHadOddsRule = !hasQualifiedOddsKeys && marketType === "1X2"
    ? oddsRules[oddsBucket]
    : null;
  const webRules = webConsensusStrategyKeys(match, marketType).map((key) => strategy.gateByWebConsensus?.[key]);
  return combineStrategyRules([
    strategy.gateByMarket?.[marketType],
    qualifiedOddsRule || legacyHadOddsRule,
    strategy.gateByTip?.[`${marketType}:${tipCode}`],
    ...webRules,
  ]);
}

function profileCalibration(match) {
  const profileKey = predictionProfileKey(match);
  const calibration = match.modelCalibration;
  return {
    profileKey,
    weights: calibration?.weightsByProfile?.[profileKey],
    gate: calibration?.gateByProfile?.[profileKey],
    metrics: calibration?.metrics,
    strategy: calibration?.strategy || null,
  };
}

function leagueMeta(leagueName) {
  const name = normText(leagueName, "足球赛事");
  const countryNameZh = {
    England: "英格兰",
    Spain: "西班牙",
    Germany: "德国",
    Italy: "意大利",
    France: "法国",
    Europe: "欧洲",
    China: "中国",
    Japan: "日本",
    Korea: "韩国",
    Sweden: "瑞典",
    Finland: "芬兰",
    Norway: "挪威",
    Portugal: "葡萄牙",
    Brazil: "巴西",
    "South America": "南美",
    World: "国际",
  };
  const rules = [
    [/英超|Premier League/i, ["eng", "England", "🇬🇧", "Premier League", "英超"]],
    [
      /巴甲|巴西(?:足球)?甲级(?:联赛)?|Brazil(?:ian)?\s+S[eé]rie\s+A|Brasileir[aã]o|Campeonato Brasileiro/i,
      ["bra", "Brazil", "🇧🇷", "Brazilian Serie A", "巴甲"],
    ],
    [/^(?:西甲|西班牙(?:足球)?甲级(?:联赛)?|La Liga)$/i, ["esp", "Spain", "🇪🇸", "La Liga", "西甲"]],
    [/德甲|Bundesliga/i, ["deu", "Germany", "🇩🇪", "Bundesliga", "德甲"]],
    [/意甲|Serie A/i, ["ita", "Italy", "🇮🇹", "Serie A", "意甲"]],
    [/法甲|Ligue 1/i, ["fra", "France", "🇫🇷", "Ligue 1", "法甲"]],
    [/欧冠|欧洲冠军联赛|Champions/i, ["eur", "Europe", "🇪🇺", "UEFA Champions League", "欧冠"]],
    [/欧联|欧罗巴|Europa/i, ["eur", "Europe", "🇪🇺", "UEFA Europa League", "欧联"]],
    [/欧协联|Conference/i, ["eur", "Europe", "🇪🇺", "UEFA Conference League", "欧协联"]],
    [/解放者杯|Libertadores/i, ["sam", "South America", "🌎", "Copa Libertadores", "解放者杯"]],
    [/中超|Chinese/i, ["chn", "China", "🇨🇳", "Chinese Super League", "中超"]],
    [/日职|J1|日本/i, ["jpn", "Japan", "🇯🇵", "Japan", "日职"]],
    [/韩|K League/i, ["kor", "Korea", "🇰🇷", "K League", "韩职"]],
    [/瑞超|Allsvenskan/i, ["swe", "Sweden", "🇸🇪", "Swedish Allsvenskan", "瑞超"]],
    [/芬超|Veikkausliiga/i, ["fin", "Finland", "🇫🇮", "Finnish Veikkausliiga", "芬超"]],
    [/挪超|Eliteserien/i, ["nor", "Norway", "🇳🇴", "Norwegian Eliteserien", "挪超"]],
    [/葡超|Primeira|Liga Portugal/i, ["por", "Portugal", "🇵🇹", "Primeira Liga", "葡超"]],
    [/国际|友谊|世预|世界杯/i, ["world", "World", "🌐", "International", "国际赛"]],
  ];
  for (const [pattern, meta] of rules) {
    if (pattern.test(name)) {
      return {
        countryId: meta[0],
        countryNameEn: meta[1],
        countryName: countryNameZh[meta[1]] || meta[1],
        countryFlag: meta[2],
        leagueNameEn: meta[3],
        leagueShortName: meta[4],
      };
    }
  }
  return {
    countryId: "oth",
    countryName: "其他",
    countryNameEn: "Other",
    countryFlag: "🏳️",
    leagueNameEn: name,
    leagueShortName: name.slice(0, 4),
  };
}

function normalizeLeagueMetadataForAppMatch(match) {
  if (!match || typeof match !== "object") return match;
  const leagueName = normText(
    match.leagueName || match.leagueShortName || match.leagueNameEn,
    ""
  );
  if (!leagueName) return match;
  const meta = leagueMeta(leagueName);
  if (meta.countryId === "oth") return match;
  return {
    ...match,
    countryId: meta.countryId,
    countryName: meta.countryName,
    countryNameEn: meta.countryNameEn,
    countryFlag: meta.countryFlag,
    leagueNameEn: meta.leagueNameEn,
    leagueShortName: meta.leagueShortName,
    leagueShortNameEn: meta.leagueNameEn.slice(0, 12),
  };
}

function httpGetJsonPrimary(url, tab = "concern") {
  const proxy = sportteryOutboundProxy();
  if (proxy) return httpGetJsonViaCurl(url, tab, proxy);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET",
      headers: sportteryRequestHeaders(url, tab),
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const preview = body ? ` ${body.slice(0, 160).replace(/\s+/g, " ")}` : "";
          reject(new Error(`${url} -> HTTP ${res.statusCode}${preview}`));
          return;
        }
        try {
          const payload = JSON.parse(body);
          if (payload?.success === false) {
            reject(new Error(`sporttery_api_${payload.errorCode || "unknown"}`));
            return;
          }
          resolve(payload);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(20000, () => {
      req.destroy(new Error(`timeout: ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpGetJsonViaCurl(url, tab, proxy) {
  return new Promise((resolve, reject) => {
    const args = [
      "-fsSL",
      "--connect-timeout",
      String(Math.max(3, Number(process.env.SPORTTERY_CURL_CONNECT_TIMEOUT_SECONDS || 8))),
      "--max-time",
      String(Math.max(8, Number(process.env.SPORTTERY_CURL_MAX_TIME_SECONDS || 25))),
      "--proxy",
      proxy,
      ...curlHeaderArgs(url, tab),
      url,
    ];

    const child = spawn(process.env.CURL_BIN || "curl", args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
    });

    let body = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      body += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${url} -> curl proxy exited ${code}${stderr ? ` ${stderr.slice(0, 220).replace(/\s+/g, " ")}` : ""}`));
        return;
      }
      try {
        const payload = JSON.parse(body);
        if (payload?.success === false) {
          reject(new Error(`sporttery_api_${payload.errorCode || "unknown"}`));
          return;
        }
        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function buildPageUrl(method, pageNo = null, pageType = null) {
  if (String(method || "").toLowerCase() === "result") return RESULT_URL;
  const params = new URLSearchParams();
  params.set("method", method);
  params.set("pageSize", String(PAGE_SIZE));
  if (pageNo !== null && pageNo !== undefined) params.set("pageNo", String(pageNo));
  if (pageType !== null && pageType !== undefined) params.set("pageType", String(pageType));
  return `${SPORTTERY_BASE}/gateway/uniform/fb/getMatchDataPageListV1.qry?${params.toString()}`;
}

function flatten(payload, sourceMethod, sourceUrl, sourceTiming = {}) {
  const rows = [];
  for (const day of payload?.value?.matchInfoList || []) {
    for (const row of day.subMatchList || []) {
      rows.push(mapSportteryRow(row, sourceMethod, sourceUrl, sourceTiming));
    }
  }
  return rows;
}

function sportterySaleClockMatchesEvent(buyEndTime, kickoffTime) {
  const cutoffMs = parseBeijingDateTime(buyEndTime);
  const kickoffMs = parseBeijingDateTime(kickoffTime);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(kickoffMs)) return false;
  const earliestMs = kickoffMs - 72 * 60 * 60 * 1000;
  const latestMs = kickoffMs + 30 * 60 * 1000;
  return cutoffMs >= earliestMs && cutoffMs <= latestMs;
}

function mapSportteryRow(row, sourceMethod, sourceUrl, sourceTiming = {}) {
  const rowScore = scoreFromSportteryRow(row);
  const scoreHome = rowScore.home;
  const scoreAway = rowScore.away;
  const homeTeam = normText(row.homeTeamAllName || row.homeTeamAbbName, "主队");
  const awayTeam = normText(row.awayTeamAllName || row.awayTeamAbbName, "客队");
  const leagueName = normText(row.leagueAllName || row.leagueAbbName, "足球赛事");
  const matchId = String(row.matchId || `${row.matchDate}-${homeTeam}-${awayTeam}`);
  const kickoffTime = parseKickoff(row.matchDate, row.matchTime);
  const rawStatus = statusFromSportteryRow(row, kickoffTime);
  const status = normalizeStatusWithScore(rawStatus, kickoffTime, scoreHome, scoreAway);
  const voidDisposition = officialVoidDispositionFromSportteryRow(row);
  const receivedAt = validAuditInstant(sourceTiming.receivedAt)
    || validAuditInstant(sourceTiming.sourceObservedAt)
    || null;
  const sourceObservedAt = validAuditInstant(sourceTiming.sourceObservedAt) || receivedAt;
  const providerSourceUpdatedAt = [
    row?.sourceUpdatedAt,
    row?.updatedAt,
    row?.updateTime,
    row?.lastUpdateTime,
    row?.matchUpdateTime,
  ].map(validAuditInstant).find(Boolean) || null;
  const exactFinalScore = status === "FINISHED"
    && Number.isInteger(scoreHome)
    && Number.isInteger(scoreAway)
    && scoreHome >= 0
    && scoreAway >= 0;
  const observationSource = normText(
    sourceTiming.observationSource,
    String(sourceMethod || "").startsWith("relay:")
      ? "sporttery-relay-endpoint-fetched-at"
      : "sporttery-direct-response-received-at"
  );
  const matchNo = normText(row.matchNumStr);
  const matchDate = normText(row.matchDate);
  const businessDate = normText(row.businessDate || row.matchNumDate)
    || inferSportteryBusinessDate(matchNo, matchDate)
    || matchDate;
  const rawBuyEndTime = normText(
    row.buyEndTime || row.matchEndTime || row.sellEndTime || row.stopSaleTime || row.endTime
  );
  const saleClockExplicit = Boolean(rawBuyEndTime);
  const saleClockMatchesEvent = !saleClockExplicit
    || sportterySaleClockMatchesEvent(rawBuyEndTime, kickoffTime);
  // Sporttery provider ids are reused. A relay/current row can therefore pair
  // a new fixture clock with the previous event's sale clock and SP pools. The
  // sale clock is part of the market-event identity: reject the entire market
  // atom when it cannot belong to this kickoff, then let the scheduled match
  // use its model-only reference until the current official market arrives.
  const oddsInfo = saleClockMatchesEvent
    ? sportteryOddsInfo(row, sourceUrl, sourceMethod, sourceTiming)
    : { had: null, hhad: null };
  return {
    source: "sporttery",
    sourceMethod,
    sourceUrl,
    sourceMatchId: matchId,
    matchNo,
    businessDate,
    matchDate,
    buyEndTime: saleClockMatchesEvent ? rawBuyEndTime : "",
    homeTeam,
    awayTeam,
    homeRank: normText(row.homeRank),
    awayRank: normText(row.awayRank),
    homeTeamCode: teamCodeFromSportteryRow(row, "home"),
    awayTeamCode: teamCodeFromSportteryRow(row, "away"),
    homeTeamLogo: normText(row.homeTeamLogo || row.homeTeamLogoUrl || row.homeLogoUrl || row.homeTeamFlag),
    awayTeamLogo: normText(row.awayTeamLogo || row.awayTeamLogoUrl || row.awayLogoUrl || row.awayTeamFlag),
    leagueName,
    leagueCode: String(row.leagueId || ""),
    kickoffTime,
    eventVersion: kickoffTime || null,
    sourceObservedAt,
    sourceReceivedAt: receivedAt,
    sourceCycleId: normText(sourceTiming.sourceCycleId) || undefined,
    status,
    ...(status === "LIVE" && sourceObservedAt ? {
      firstInPlayObservedAt: sourceObservedAt,
      inPlayObservationSource: observationSource,
    } : {}),
    ...(voidDisposition ? {
      ...voidDisposition,
      voidSource: "sporttery:official-api",
      voidObservedAt: sourceObservedAt,
      voidSourceUrl: sourceUrl,
      voidSourceMethod: sourceMethod,
    } : {}),
    scoreHome,
    scoreAway,
    ...(exactFinalScore ? {
      resultSource: "sporttery:official-api",
      // The API payload currently exposes no provider-side result update
      // timestamp. Keep that distinction explicit instead of copying the
      // collector receipt time into sourceUpdatedAt.
      resultSourceUpdatedAt: providerSourceUpdatedAt,
      resultObservedAt: sourceObservedAt,
      resultObservationSource: sourceObservedAt ? observationSource : "missing-official-response-observation",
    resultObservationFallback: !sourceObservedAt,
    resultUpdatedAt: providerSourceUpdatedAt || sourceObservedAt,
    } : {}),
    officialResultIdentity: row.officialResultIdentity || undefined,
    officialPayoutSp: row.officialPayoutSp || undefined,
    odds: oddsInfo.had?.odds || null,
    oddsSource: oddsInfo.had?.oddsSource,
    oddsPoolCode: oddsInfo.had?.oddsPoolCode,
    oddsSourceMethod: oddsInfo.had?.oddsSourceMethod,
    oddsObservedAt: oddsInfo.had?.oddsObservedAt,
    oddsReceivedAt: oddsInfo.had?.oddsReceivedAt,
    oddsUpdatedAt: oddsInfo.had?.oddsUpdatedAt,
    oddsSourceUrl: oddsInfo.had?.oddsSourceUrl,
    oddsMarketProvenance: oddsInfo.had?.marketProvenance || null,
    handicapOdds: oddsInfo.hhad?.odds || null,
    handicapLine: oddsInfo.hhad?.handicap,
    handicapOddsSource: oddsInfo.hhad?.oddsSource,
    handicapOddsPoolCode: oddsInfo.hhad?.oddsPoolCode,
    handicapOddsSourceMethod: oddsInfo.hhad?.oddsSourceMethod,
    handicapOddsObservedAt: oddsInfo.hhad?.oddsObservedAt,
    handicapOddsReceivedAt: oddsInfo.hhad?.oddsReceivedAt,
    handicapOddsUpdatedAt: oddsInfo.hhad?.oddsUpdatedAt,
    handicapOddsSourceUrl: oddsInfo.hhad?.oddsSourceUrl,
    handicapOddsMarketProvenance: oddsInfo.hhad?.marketProvenance || null,
  };
}

async function fetchCurrentMatches() {
  if (process.env.SKIP_SPORTTERY_FETCH === "1") {
    console.log("Sporttery fetch skipped by SKIP_SPORTTERY_FETCH=1; using existing store and external signals.");
    return [];
  }

  const urls = [
    { url: CALCULATOR_URL, method: "calculator" },
    { url: CURRENT_URL, method: "current" },
    ...(process.env.SPORTTERY_SOURCE_URLS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((url) => ({ url, method: "current" })),
    process.env.SPORTTERY_PROXY_URL ? { url: process.env.SPORTTERY_PROXY_URL, method: "proxy" } : null,
  ].filter(Boolean);
  const allMatches = [];
  for (const item of urls) {
    try {
      const payload = await httpGetJson(item.url, "concern");
      const receivedAt = new Date().toISOString();
      const matches = flatten(payload, item.method, item.url, {
        receivedAt,
        sourceObservedAt: receivedAt,
        observationSource: "sporttery-direct-response-received-at",
      });
      console.log(`Sporttery ${item.method} ok: ${matches.length}`);
      if (matches.length) allMatches.push(...matches);
    } catch (error) {
      recordSportteryFetchError({
        stage: "direct",
        method: item.method,
        url: item.url,
        error,
      });
      console.log(`Sporttery ${item.method} failed: ${error.message || error}`);
    }
  }
  return allMatches;
}

async function fetchMethodMatches(method) {
  const firstUrl = buildPageUrl(method);
  const payloads = [{
    payload: await httpGetJson(firstUrl, method),
    url: firstUrl,
    receivedAt: new Date().toISOString(),
  }];
  if (method === "all") {
    for (let page = 2; page <= PAGE_DEPTH; page += 1) {
      let pageUrl = buildPageUrl(method, page, 0);
      try {
        const payload = await httpGetJson(pageUrl, method);
        if (!(payload?.value?.matchInfoList || []).length) break;
        payloads.push({ payload, url: pageUrl, receivedAt: new Date().toISOString() });
        const hasMore = payload?.value?.prePage && String(payload.value.prePage) !== "0";
        if (!hasMore) break;
      } catch (error) {
        recordSportteryFetchError({
          stage: "direct",
          method,
          url: pageUrl,
          error,
        });
        console.log(`Sporttery ${method} page ${page} failed: ${error.message || error}`);
        break;
      }
    }
  }
  const matches = payloads.flatMap((entry) => flatten(entry.payload, method, entry.url, {
    receivedAt: entry.receivedAt,
    sourceObservedAt: entry.receivedAt,
    observationSource: "sporttery-direct-response-received-at",
  }));
  console.log(`Sporttery ${method} ok: ${matches.length}`);
  return matches;
}

function matchesFromSportteryRelaySnapshot(snapshot) {
  if (!snapshot?.entries?.length) return [];
  const rows = [];
  const envelope = snapshot?.payload || {};
  const envelopeSourceCycleId = normText(
    envelope?.uploadCycleId
    || envelope?.mergeCycleId
    || envelope?.sourceCycleId
    || envelope?.collectorProvenance?.sourceCycleId
  ) || null;
  const envelopeCycleKind = normText(
    envelope?.sourceCycleKind
    || envelope?.collectorProvenance?.cycleKind
  ) || null;
  for (const entry of snapshot.entries) {
    const method = normText(entry.method || entry.id || "relay");
    const sourceMethod = method.startsWith("method:") ? method.slice("method:".length) : method;
    const sourceUrl = normText(entry.url || `sporttery-relay:${sourceMethod}`);
    const collector = entry?.collectorProvenance || {};
    // Strict market evidence belongs to the endpoint response, not to the
    // later upload/merge envelope. In particular, fetchedAt/updatedAt and the
    // snapshot's upload cycle are deliberately excluded from these clocks.
    const sourceCycleId = normText(entry?.sourceCycleId || collector?.sourceCycleId) || null;
    const requestedAt = validAuditInstant(entry?.requestedAt || collector?.requestedAt);
    const receivedAt = validAuditInstant(entry?.receivedAt || collector?.receivedAt);
    const providerObservedAt = validAuditInstant(
      entry?.providerObservedAt || entry?.providerObservation?.observedAt
    );
    const sourceRequest = entry?.sourceRequest || collector?.sourceRequest || null;
    rows.push(...flatten(entry.payload, `relay:${sourceMethod}`, sourceUrl, {
      requestedAt,
      receivedAt,
      sourceObservedAt: receivedAt,
      providerObservedAt,
      observationSource: "sporttery-relay-endpoint-received-at",
      sourceCycleId,
      sourceRequest,
      httpStatus: entry?.httpStatus ?? collector?.httpStatus ?? null,
      httpDate: entry?.httpDate ?? collector?.httpDate ?? null,
      httpEtag: entry?.httpEtag ?? collector?.httpEtag ?? null,
      contentType: entry?.contentType ?? collector?.contentType ?? null,
      headersSha256: entry?.headersSha256 ?? collector?.headersSha256 ?? null,
      rawSha256: entry?.rawSha256 ?? collector?.rawSha256 ?? null,
      rawBytes: entry?.rawBytes ?? collector?.rawBytes ?? null,
      canonicalPayloadSha256: entry?.canonicalPayloadSha256
        ?? collector?.canonicalPayloadSha256
        ?? null,
      collectorAttestation: entry?.collectorAttestation
        ?? collector?.collectorAttestation
        ?? null,
      endpointPayload: entry?.payload,
      envelopeSourceCycleId,
      envelopeCycleKind,
      constituentSourceCycleIds: entry?.fastResultConstituent?.sourceCycleIds
        || envelope?.constituentCycleIds
        || [],
    }));
  }
  return rows;
}

async function fetchSportteryMatchesDirect() {
  const lists = [];
  const current = await fetchCurrentMatches();
  if (current.length) lists.push(current);

  const results = await Promise.allSettled(METHODS.map((method) => fetchMethodMatches(method)));
  results.forEach((result, idx) => {
    if (result.status === "fulfilled" && result.value.length) {
      lists.push(result.value);
    } else if (result.status === "rejected") {
      recordSportteryFetchError({
        stage: "direct",
        method: METHODS[idx],
        url: buildPageUrl(METHODS[idx]),
        error: result.reason,
      });
      console.log(`Sporttery ${METHODS[idx]} failed: ${result.reason?.message || result.reason}`);
    }
  });

  return dedupeMatches(lists.flat());
}

function mergeMatch(prev, next) {
  const nextHasScore = Number.isFinite(next.scoreHome) && Number.isFinite(next.scoreAway);
  const prevHasScore = Number.isFinite(prev.scoreHome) && Number.isFinite(prev.scoreAway);
  const oddsRank = (match) => {
    const method = String(match.oddsSourceMethod || "");
    if (!sanitizeOdds(match.odds)) return 0;
    if (method === "current" || method === "relay:current") return 5;
    if (method === "calculator" || method === "relay:calculator") return 4;
    if (match.oddsUpdatedAt) return 3;
    return 1;
  };
  const handicapOddsRank = (match) => {
    const method = String(match.handicapOddsSourceMethod || "");
    if (!sanitizeHandicapOdds(match)) return 0;
    if (method === "current" || method === "relay:current") return 5;
    if (method === "calculator" || method === "relay:calculator") return 4;
    if (match.handicapOddsUpdatedAt) return 3;
    return 1;
  };
  const oddsMatch = oddsRank(next) >= oddsRank(prev) ? next : prev;
  const handicapOddsMatch = handicapOddsRank(next) >= handicapOddsRank(prev) ? next : prev;
  const cleanHandicapOdds = sanitizeHandicapOdds(handicapOddsMatch);
  const resolvedLine = [handicapOddsMatch.handicapLine, next.handicapLine, prev.handicapLine]
    .map(parseHandicapLine)
    .find((line) => line !== null);
  return {
    ...prev,
    ...next,
    odds: oddsMatch.odds || null,
    oddsSource: oddsMatch.oddsSource,
    oddsPoolCode: oddsMatch.oddsPoolCode,
    oddsSourceMethod: oddsMatch.oddsSourceMethod,
    oddsObservedAt: oddsMatch.oddsObservedAt,
    oddsReceivedAt: oddsMatch.oddsReceivedAt,
    oddsUpdatedAt: oddsMatch.oddsUpdatedAt,
    oddsSourceUrl: oddsMatch.oddsSourceUrl,
    oddsMarketProvenance: oddsMatch.oddsMarketProvenance || null,
    handicapOdds: cleanHandicapOdds,
    handicapLine: resolvedLine === undefined ? undefined : formatHandicapLineForCopy(resolvedLine),
    handicapOddsSource: cleanHandicapOdds ? handicapOddsMatch.handicapOddsSource : undefined,
    handicapOddsPoolCode: cleanHandicapOdds ? handicapOddsMatch.handicapOddsPoolCode : undefined,
    handicapOddsSourceMethod: cleanHandicapOdds ? handicapOddsMatch.handicapOddsSourceMethod : undefined,
    handicapOddsObservedAt: cleanHandicapOdds ? handicapOddsMatch.handicapOddsObservedAt : undefined,
    handicapOddsReceivedAt: cleanHandicapOdds ? handicapOddsMatch.handicapOddsReceivedAt : undefined,
    handicapOddsUpdatedAt: cleanHandicapOdds ? handicapOddsMatch.handicapOddsUpdatedAt : undefined,
    handicapOddsSourceUrl: cleanHandicapOdds ? handicapOddsMatch.handicapOddsSourceUrl : undefined,
    handicapOddsMarketProvenance: cleanHandicapOdds
      ? (handicapOddsMatch.handicapOddsMarketProvenance || null)
      : null,
    homeTeamCode: next.homeTeamCode || prev.homeTeamCode,
    awayTeamCode: next.awayTeamCode || prev.awayTeamCode,
    homeTeamLogo: next.homeTeamLogo || prev.homeTeamLogo,
    awayTeamLogo: next.awayTeamLogo || prev.awayTeamLogo,
    businessDate: inferSportteryBusinessDate(next.matchNo || prev.matchNo, next.matchDate || prev.matchDate)
      || next.businessDate
      || prev.businessDate,
    buyEndTime: next.buyEndTime || prev.buyEndTime,
    matchDate: next.matchDate || prev.matchDate,
    sourceUrl: next.sourceUrl || prev.sourceUrl,
    scoreHome: nextHasScore ? next.scoreHome : prevHasScore ? prev.scoreHome : next.scoreHome,
    scoreAway: nextHasScore ? next.scoreAway : prevHasScore ? prev.scoreAway : next.scoreAway,
  };
}

function dedupeMatches(matches) {
  const map = new Map();
  const isCurrentRevision = (match) => /(?:^|:)current$|(?:^|:)calculator$/i.test(String(
    match?.sourceMethod || match?.oddsSourceMethod || ""
  ));
  for (const match of matches) {
    const key = match.sourceMatchId;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, resolveMatchLifecycle(match));
      continue;
    }
    if (!sameEvent(prev, match)) {
      const previousCurrent = isCurrentRevision(prev);
      const incomingCurrent = isCurrentRevision(match);
      if (incomingCurrent && !previousCurrent) {
        map.set(key, resolveMatchLifecycle(match));
      } else if (incomingCurrent === previousCurrent) {
        const previousKickoff = Date.parse(prev.kickoffTime || "");
        const incomingKickoff = Date.parse(match.kickoffTime || "");
        if (Number.isFinite(incomingKickoff) && (!Number.isFinite(previousKickoff) || incomingKickoff > previousKickoff)) {
          map.set(key, resolveMatchLifecycle(match));
        }
      }
      continue;
    }
    const nextPriority = STATUS_PRIORITY[match.status] || 0;
    const prevPriority = STATUS_PRIORITY[prev.status] || 0;
    map.set(key, resolveMatchLifecycle(
      nextPriority >= prevPriority ? mergeMatch(prev, match) : mergeMatch(match, prev)
    ));
  }
  return Array.from(map.values()).sort((a, b) => new Date(a.kickoffTime) - new Date(b.kickoffTime));
}

function pickByCode(picks, code) {
  return picks.find((pick) => pick[0] === code);
}

function handicapProbabilityByCode(probabilities, code) {
  if (!probabilities) return null;
  if (code === "1") return Number(probabilities.home);
  if (code === "X") return Number(probabilities.draw);
  if (code === "2") return Number(probabilities.away);
  return null;
}

function hadHandicapRelationshipFromScoreRows(scoreRows, handicapLine, hadCode, hhadMarketProbabilities = null) {
  const line = parseHandicapLine(handicapLine);
  if (line === null || !["1", "X", "2"].includes(hadCode) || !Array.isArray(scoreRows)) return null;

  const totals = {
    mass: 0,
    had: 0,
    hhad: { "1": 0, X: 0, "2": 0 },
    joint: { "1": 0, X: 0, "2": 0 },
  };
  for (const row of scoreRows) {
    if (
      row?.home === null
      || row?.home === undefined
      || row?.home === ""
      || row?.away === null
      || row?.away === undefined
      || row?.away === ""
    ) continue;
    const home = Number(row?.home);
    const away = Number(row?.away);
    const probability = Number(row?.probability);
    if (
      !Number.isFinite(home)
      || !Number.isFinite(away)
      || !Number.isFinite(probability)
      || probability <= 0
    ) continue;
    const rowHadCode = oneXTwoCodeForScore(home, away);
    const rowHhadCode = scoreOutcomeWithHandicap(home, away, line);
    totals.mass += probability;
    totals.hhad[rowHhadCode] += probability;
    if (rowHadCode === hadCode) {
      totals.had += probability;
      totals.joint[rowHhadCode] += probability;
    }
  }
  if (!(totals.mass > 0)) return null;

  const probabilityFromMass = (value) => Number((Number(value || 0) / totals.mass).toFixed(6));
  const conditionalFromHad = (value) => totals.had > 0
    ? Number((Number(value || 0) / totals.had).toFixed(6))
    : null;
  const hhadProbabilities = {
    home: probabilityFromMass(totals.hhad["1"]),
    draw: probabilityFromMass(totals.hhad.X),
    away: probabilityFromMass(totals.hhad["2"]),
  };
  const jointProbabilities = {
    home: probabilityFromMass(totals.joint["1"]),
    draw: probabilityFromMass(totals.joint.X),
    away: probabilityFromMass(totals.joint["2"]),
  };
  const conditionalHhadGivenHad = totals.had > 0 ? {
    home: conditionalFromHad(totals.joint["1"]),
    draw: conditionalFromHad(totals.joint.X),
    away: conditionalFromHad(totals.joint["2"]),
  } : null;
  const sideCode = hadCode === "1" || hadCode === "2" ? hadCode : null;
  const oppositeCode = sideCode === "1" ? "2" : sideCode === "2" ? "1" : null;
  const conditionalCoverProbability = sideCode && conditionalHhadGivenHad
    ? handicapProbabilityByCode(conditionalHhadGivenHad, sideCode)
    : null;
  const conditionalHandicapDrawProbability = conditionalHhadGivenHad?.draw ?? null;
  const conditionalWinNotCoverProbability = oppositeCode && conditionalHhadGivenHad
    ? handicapProbabilityByCode(conditionalHhadGivenHad, oppositeCode)
    : null;
  const scoreConditionalNonLossSupport = sideCode && conditionalHhadGivenHad
    ? Number((Number(conditionalCoverProbability || 0) + Number(conditionalHandicapDrawProbability || 0)).toFixed(6))
    : conditionalHhadGivenHad
      ? 1
      : null;
  const compatibleHhadCodes = conditionalHhadGivenHad
    ? ["1", "X", "2"].filter((code) => Number(handicapProbabilityByCode(conditionalHhadGivenHad, code) || 0) > 0.000001)
    : [];
  const nonLossHhadCodes = sideCode
    ? compatibleHhadCodes.filter((code) => code === sideCode || code === "X")
    : compatibleHhadCodes;
  const normalizedMarket = normalizedTripletFromAny(hhadMarketProbabilities);
  const marketCompatibleSupport = normalizedMarket
    ? Number(nonLossHhadCodes.reduce(
        (sum, code) => sum + Number(handicapProbabilityByCode(normalizedMarket, code) || 0),
        0
      ).toFixed(6))
    : null;
  const conditionalCompatibleSupport = scoreConditionalNonLossSupport === null
    ? null
    : marketCompatibleSupport === null
      ? scoreConditionalNonLossSupport
      : Number(Math.min(scoreConditionalNonLossSupport, marketCompatibleSupport).toFixed(6));

  return {
    version: "had-hhad-margin-relationship-v1",
    handicapLine: line,
    hadCode,
    hadDirectionProbability: probabilityFromMass(totals.had),
    hhadProbabilities,
    jointHhadGivenHad: jointProbabilities,
    conditionalHhadGivenHad,
    compatibleHhadCodes,
    nonLossHhadCodes,
    coverProbability: sideCode ? handicapProbabilityByCode(hhadProbabilities, sideCode) : null,
    handicapDrawProbability: hhadProbabilities.draw,
    jointCoverProbability: sideCode ? handicapProbabilityByCode(jointProbabilities, sideCode) : null,
    jointHandicapDrawProbability: jointProbabilities.draw,
    winNotCoverProbability: oppositeCode ? handicapProbabilityByCode(jointProbabilities, oppositeCode) : null,
    conditionalCoverProbability,
    conditionalHandicapDrawProbability,
    conditionalWinNotCoverProbability,
    scoreConditionalNonLossSupport,
    marketCompatibleSupport,
    conditionalCompatibleSupport,
  };
}

function buildHadHandicapRelationships(homeLambda, awayLambda, handicapLine, hhadMarketProbabilities = null) {
  const line = parseHandicapLine(handicapLine);
  const home = Number(homeLambda);
  const away = Number(awayLambda);
  if (line === null || !Number.isFinite(home) || !Number.isFinite(away) || home <= 0 || away <= 0) {
    return { "1": null, X: null, "2": null };
  }
  const scoreRows = scoreMatrix(home, away, 12);
  return Object.fromEntries(["1", "X", "2"].map((code) => [
    code,
    hadHandicapRelationshipFromScoreRows(scoreRows, line, code, hhadMarketProbabilities),
  ]));
}

function conditionalHandicapSupportForPick(relationships, code) {
  const support = relationships?.[code]?.conditionalCompatibleSupport;
  return support !== null && support !== undefined && Number.isFinite(Number(support))
    ? Number(support)
    : null;
}

function outcomeProbabilityForCode(probabilities, code) {
  if (!probabilities) return null;
  if (code === "1") return Number(probabilities.home);
  if (code === "X") return Number(probabilities.draw);
  if (code === "2") return Number(probabilities.away);
  return null;
}

function normalizedTripletFromAny(probabilities) {
  if (!probabilities) return null;
  const raw = {
    home: Number(probabilities.home),
    draw: Number(probabilities.draw),
    away: Number(probabilities.away),
  };
  if (!Number.isFinite(raw.home) || !Number.isFinite(raw.draw) || !Number.isFinite(raw.away)) return null;
  const total = raw.home + raw.draw + raw.away;
  if (!Number.isFinite(total) || total <= 0) return null;
  return normalizeOutcomeProbabilities(raw);
}

function outcomeRowsFromTriplet(probabilities) {
  const normalized = normalizedTripletFromAny(probabilities);
  if (!normalized) return [];
  return [
    { code: "1", key: "home", probability: normalized.home },
    { code: "X", key: "draw", probability: normalized.draw },
    { code: "2", key: "away", probability: normalized.away },
  ].sort((a, b) => b.probability - a.probability);
}

function oddsValueForCode(odds, code) {
  if (code === "1") return Number(odds?.odds1 || 0);
  if (code === "X") return Number(odds?.oddsX || 0);
  if (code === "2") return Number(odds?.odds2 || 0);
  return 0;
}

function simpleOutcomeLabel(match, code) {
  return {
    "1": { zh: `主胜 ${match.homeTeam}`, en: `Home win ${match.homeTeam}` },
    X: { zh: "平局", en: "Draw" },
    "2": { zh: `客胜 ${match.awayTeam}`, en: `Away win ${match.awayTeam}` },
  }[code] || { zh: "胜平负", en: "1X2" };
}

function simpleHandicapOutcomeLabel(code) {
  return {
    "1": { zh: "让胜", en: "HHAD home" },
    X: { zh: "让平", en: "HHAD draw" },
    "2": { zh: "让负", en: "HHAD away" },
  }[code] || { zh: "让球", en: "HHAD" };
}

function scoreShapeFromProbabilityModel(model, handicapLine) {
  const topScores = (model?.scoreDistribution || [])
    .map((row) => ({
      home: Number(row.home),
      away: Number(row.away),
      label: row.label || `${row.home}-${row.away}`,
      probability: Number(row.probability || 0),
    }))
    .filter((row) => Number.isFinite(row.home) && Number.isFinite(row.away));
  const top3 = topScores.slice(0, 3);
  const codeCounts = { "1": 0, X: 0, "2": 0 };
  const hhadCodeCounts = { "1": 0, X: 0, "2": 0 };
  const handicap = parseHandicapLine(handicapLine);

  for (const row of top3) {
    const code = oneXTwoCodeForScore(row.home, row.away);
    codeCounts[code] += 1;
    if (handicap !== null) {
      const hhadCode = scoreOutcomeWithHandicap(row.home, row.away, handicap);
      hhadCodeCounts[hhadCode] += 1;
    }
  }

  const top1 = top3[0] || null;
  const top1Code = top1 ? oneXTwoCodeForScore(top1.home, top1.away) : null;
  const top1HhadCode = top1 && handicap !== null
    ? scoreOutcomeWithHandicap(top1.home, top1.away, handicap)
    : null;

  return {
    topScores,
    top3,
    top1,
    top1Code,
    top1HhadCode,
    codeCounts,
    hhadCodeCounts,
    drawHeavy: top1Code === "X" || codeCounts.X >= 2,
    lowScoreHeavy: top3.filter((row) => row.home + row.away <= 2).length >= 2,
    handicap,
  };
}

function isHandicapCodeCompatibleWithOutcomeCode(outcomeCode, handicapCode, lineValue) {
  if (!["1", "X", "2"].includes(outcomeCode) || !["1", "X", "2"].includes(handicapCode)) return true;
  if (!Number.isFinite(lineValue)) return true;
  for (let margin = -20; margin <= 20; margin += 1) {
    const outcomeMatches = (outcomeCode === "1" && margin > 0)
      || (outcomeCode === "X" && margin === 0)
      || (outcomeCode === "2" && margin < 0);
    if (!outcomeMatches) continue;
    const hhadCode = scoreOutcomeWithHandicap(margin, 0, lineValue);
    if (hhadCode === handicapCode) return true;
  }
  return false;
}

function unifiedDataQuality(contextSignals) {
  const dataGaps = contextSignals?.dataGaps || {};
  const qualityScore = Number(dataGaps.preMatchQuality?.score ?? dataGaps.coverageScore);
  if (Number.isFinite(qualityScore)) return clamp(qualityScore / 100, 0.25, 1);
  if (dataGaps.sourceQuality === "high") return 0.88;
  if (dataGaps.sourceQuality === "medium") return 0.64;
  if (dataGaps.sourceQuality === "low") return 0.42;
  return 0.58;
}

function observedUnifiedDataQuality(contextSignals) {
  const qualityScore = Number(contextSignals?.dataGaps?.preMatchQuality?.score);
  if (!Number.isFinite(qualityScore)) return null;
  return clamp(qualityScore / 100, 0, 1);
}

function auditableConfidenceFreshnessEvidence(match, evaluatedAt, market = "HAD") {
  const evaluatedMs = Date.parse(String(evaluatedAt || ""));
  if (!Number.isFinite(evaluatedMs)) return null;
  const canonicalAuditInstant = (value) => {
    const text = String(value || "").trim();
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return null;
    const millis = Date.parse(text);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
  };
  const selectedMarket = String(market || "HAD").toUpperCase();
  const marketPrefix = selectedMarket === "HHAD" ? "handicapOdds" : "odds";
  const marketProvenance = match?.[`${marketPrefix}MarketProvenance`] || null;
  const candidates = [
    {
      observedAt: match?.[`${marketPrefix}ObservedAt`]
        || marketProvenance?.timing?.providerObservedAt
        || marketProvenance?.timing?.endpointProviderObservedAt
        || null,
      sourceUpdatedAt: match?.[`${marketPrefix}UpdatedAt`] || null,
      source: match?.[`${marketPrefix}Source`] || null,
    },
    {
      observedAt: match?.sourceObservedAt || null,
      sourceUpdatedAt: match?.sourceUpdatedAt || null,
      source: match?.source || null,
    },
    {
      observedAt: match?.externalSignals?.preMatch?.sourceObservedAt || null,
      sourceUpdatedAt: match?.externalSignals?.preMatch?.updatedAt || null,
      source: match?.externalSignals?.preMatch?.source || null,
    },
  ].map((candidate) => {
    const source = normText(candidate.source);
    const observedAt = canonicalAuditInstant(candidate.observedAt);
    const sourceUpdatedAt = canonicalAuditInstant(candidate.sourceUpdatedAt);
    const asOf = observedAt || sourceUpdatedAt;
    const asOfMs = Date.parse(String(asOf || ""));
    if (!source || !Number.isFinite(asOfMs) || asOfMs > evaluatedMs + 5 * 60 * 1000) return null;
    return { observedAt, sourceUpdatedAt, source, asOfMs };
  }).filter(Boolean).sort((a, b) => b.asOfMs - a.asOfMs);
  const selected = candidates[0] || null;
  if (!selected) return null;
  return {
    observedAt: selected.observedAt,
    sourceUpdatedAt: selected.sourceUpdatedAt,
    evaluatedAt: new Date(evaluatedMs).toISOString(),
    source: selected.source,
  };
}

function observedInputCoverageRatio(inputCoverage) {
  const raw = inputCoverage?.coverageRatio;
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? clamp(numeric, 0, 1) : null;
}

function weightedLogPosterior(components, biases = {}) {
  const validComponents = components
    .map((component) => ({
      probabilities: normalizedTripletFromAny(component.probabilities),
      weight: Number(component.weight || 0),
    }))
    .filter((component) => component.probabilities && component.weight > 0);
  if (!validComponents.length) return null;

  const sides = ["home", "draw", "away"];
  const raw = {};
  const totalWeight = validComponents.reduce((sum, component) => sum + component.weight, 0) || 1;
  for (const side of sides) {
    const logScore = validComponents.reduce((sum, component) => {
      const value = clamp(Number(component.probabilities[side] || 0), 0.002, 0.996);
      return sum + component.weight * Math.log(value);
    }, Number(biases[side] || 0));
    raw[side] = Math.exp(logScore / totalWeight);
  }
  return normalizeOutcomeProbabilities(raw);
}

function probabilityValue(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(numeric > 1 ? numeric / 100 : numeric, 0, 1);
}

function tripletComponentDiagnostics(components) {
  const valid = components
    .map((component) => normalizedTripletFromAny(component))
    .filter(Boolean);
  if (!valid.length) {
    return { dispersion: 1, leaderAgreement: 0, componentCount: 0 };
  }
  const leaders = valid.map((component) => outcomeLeadStats(component).leader?.code || null);
  const leaderCounts = leaders.reduce((summary, code) => {
    if (code) summary[code] = (summary[code] || 0) + 1;
    return summary;
  }, {});
  const leaderAgreement = Math.max(0, ...Object.values(leaderCounts)) / valid.length;
  const sides = ["home", "draw", "away"];
  const dispersion = sides.reduce((sum, side) => {
    const mean = valid.reduce((total, component) => total + component[side], 0) / valid.length;
    const variance = valid.reduce((total, component) => total + (component[side] - mean) ** 2, 0) / valid.length;
    return sum + Math.sqrt(variance);
  }, 0) / sides.length;
  return {
    dispersion: Number(dispersion.toFixed(6)),
    leaderAgreement: Number(leaderAgreement.toFixed(6)),
    componentCount: valid.length,
  };
}

function buildUnifiedOneXTwoPosteriorDecision(probabilityModel, marketProbabilities, contextSignals, scoreShape, inputCoverage = null) {
  const final = normalizedTripletFromAny(probabilityModel?.oneXTwo?.final);
  const scoreImplied = normalizedTripletFromAny(probabilityModel?.oneXTwo?.scoreImplied);
  const poisson = normalizedTripletFromAny(probabilityModel?.oneXTwo?.poisson);
  const market = normalizedTripletFromAny(marketProbabilities);
  const inputSparse = inputCoverage?.sufficient === false;
  const coverageRatio = clamp(
    Number(inputCoverage?.evidenceFamilies || 0)
      / Math.max(1, Number(inputCoverage?.minimumEvidenceFamilies || 2)),
    0,
    1,
  );
  const independentComponents = [final, scoreImplied, poisson].filter(Boolean);
  const componentDiagnostics = tripletComponentDiagnostics(independentComponents);
  const independentPosterior = weightedLogPosterior([
    { probabilities: final, weight: 0.5 },
    { probabilities: scoreImplied, weight: 0.3 },
    { probabilities: poisson, weight: 0.2 },
  ]) || final || scoreImplied || poisson || market;
  const independentSideGap = independentPosterior
    ? Math.abs(Number(independentPosterior.home || 0) - Number(independentPosterior.away || 0))
    : 1;
  const dominantSideProbability = independentPosterior
    ? Math.max(Number(independentPosterior.home || 0), Number(independentPosterior.away || 0))
    : 1;
  const competitiveBalance = clamp((0.17 - independentSideGap) / 0.17, 0, 1);
  const poissonDraw = Number(poisson?.draw || 0);
  const scoreDraw = Number(scoreImplied?.draw || 0);
  const leagueDrawRate = probabilityValue(probabilityModel?.leaguePrior?.drawRate, null);
  const drawEvidence = clamp(
    competitiveBalance * 0.13
      + (scoreShape?.drawHeavy ? 0.1 : 0)
      + (scoreShape?.lowScoreHeavy ? 0.075 : 0)
      + clamp((poissonDraw - 0.25) * 0.8, 0, 0.055)
      + clamp((scoreDraw - 0.26) * 0.7, 0, 0.05)
      + (leagueDrawRate === null ? 0 : clamp((leagueDrawRate - 0.24) * 0.65, -0.015, 0.045))
      - clamp((dominantSideProbability - 0.47) * 0.75, 0, 0.12),
    0,
    0.3,
  );
  const scoreWeight = scoreShape?.drawHeavy ? 0.31 : scoreShape?.lowScoreHeavy ? 0.29 : 0.27;
  const biases = {};
  const groupContext = contextSignals?.worldCupGroupContext || contextSignals?.rankingPressure?.worldCupGroupContext;
  const groupEffects = groupContext?.effects || {};

  biases.draw = drawEvidence;
  if (independentSideGap >= 0.16 && scoreShape?.top1Code === "1") biases.home = 0.025;
  if (independentSideGap >= 0.16 && scoreShape?.top1Code === "2") biases.away = 0.025;
  if (groupContext?.sameGroup) {
    const drawBias = Number(groupEffects.drawBias || 0);
    const needEdge = Number(groupEffects.needEdge || 0);
    const marginPushSide = groupEffects.marginPushSide || groupEffects.goalDiffPushSide;
    if (Number.isFinite(drawBias)) biases.draw = (biases.draw || 0) + clamp(drawBias * 1.8, -0.07, 0.05);
    if (Number.isFinite(needEdge) && Math.abs(needEdge) >= 6) {
      if (needEdge > 0) biases.home = (biases.home || 0) + clamp(needEdge / 260, 0.012, 0.055);
      if (needEdge < 0) biases.away = (biases.away || 0) + clamp(Math.abs(needEdge) / 260, 0.012, 0.055);
    }
    if (marginPushSide === "home") biases.home = (biases.home || 0) + 0.035;
    if (marginPushSide === "away") biases.away = (biases.away || 0) + 0.035;
  }

  const weights = inputSparse
    ? { final: 0.44, score: scoreWeight, poisson: 0.2, market: 0.07 }
    : { final: 0.5, score: scoreWeight, poisson: 0.15, market: 0.08 };
  const posterior = weightedLogPosterior([
    { probabilities: final, weight: weights.final },
    { probabilities: scoreImplied, weight: scoreWeight },
    { probabilities: poisson, weight: weights.poisson },
    { probabilities: market, weight: weights.market },
  ], biases);
  const uncertaintyScore = clamp(
    (inputSparse ? 0.36 : 0.14)
      + (1 - coverageRatio) * 0.24
      + componentDiagnostics.dispersion * 1.45
      + (1 - componentDiagnostics.leaderAgreement) * 0.18,
    0.08,
    0.92,
  );

  return {
    probabilities: posterior,
    diagnostics: {
      version: "evidence-shrinkage-posterior-v1",
      inputSparse,
      marketRole: "low-weight-validation-not-direction-override",
      weights: {
        final: weights.final,
        scoreImplied: scoreWeight,
        poisson: weights.poisson,
        market: weights.market,
      },
      evidenceFamilies: Number(inputCoverage?.evidenceFamilies || 0),
      minimumEvidenceFamilies: Number(inputCoverage?.minimumEvidenceFamilies || 2),
      coverageRatio: Number(coverageRatio.toFixed(3)),
      independentComponentCount: componentDiagnostics.componentCount,
      independentAgreement: componentDiagnostics.leaderAgreement,
      componentDispersion: componentDiagnostics.dispersion,
      independentSideGap: Number(independentSideGap.toFixed(4)),
      drawAdjustment: Number(drawEvidence.toFixed(4)),
      drawSignals: {
        competitiveBalance: Number(competitiveBalance.toFixed(3)),
        scoreDraw: Number(scoreDraw.toFixed(4)),
        poissonDraw: Number(poissonDraw.toFixed(4)),
        leagueDrawRate: leagueDrawRate === null ? null : Number(leagueDrawRate.toFixed(4)),
        drawHeavy: Boolean(scoreShape?.drawHeavy),
        lowScoreHeavy: Boolean(scoreShape?.lowScoreHeavy),
      },
      uncertaintyScore: Number(uncertaintyScore.toFixed(3)),
      formalPromotionEligible: !inputSparse,
      quotaBalancing: false,
    },
  };
}

function buildUnifiedOneXTwoPosterior(probabilityModel, marketProbabilities, contextSignals, scoreShape, inputCoverage = null) {
  return buildUnifiedOneXTwoPosteriorDecision(
    probabilityModel,
    marketProbabilities,
    contextSignals,
    scoreShape,
    inputCoverage,
  ).probabilities;
}

function buildUnifiedHandicapPosterior(probabilityModel, hhadProbabilities, scoreShape) {
  const scoreImplied = normalizedTripletFromAny(probabilityModel?.handicap?.scoreImplied);
  const poisson = normalizedTripletFromAny(probabilityModel?.handicap?.poisson);
  const groupContext = probabilityModel?.contextSignals?.worldCupGroupContext || probabilityModel?.contextSignals?.rankingPressure?.worldCupGroupContext;
  const groupEffects = groupContext?.effects || {};
  const biases = {};
  const line = Number(scoreShape?.handicap);
  if (scoreShape?.top1HhadCode === "1") biases.home = (biases.home || 0) + 0.055;
  if (scoreShape?.top1HhadCode === "X") biases.draw = (biases.draw || 0) + 0.07;
  if (scoreShape?.top1HhadCode === "2") biases.away = (biases.away || 0) + 0.055;
  if (scoreShape?.hhadCodeCounts?.X >= 2) biases.draw = (biases.draw || 0) + 0.04;
  if (Number.isFinite(line) && Math.abs(line) >= 2 && scoreShape?.hhadCodeCounts?.X >= 1) {
    biases.draw = (biases.draw || 0) + 0.045;
  }
  if (groupContext?.sameGroup) {
    const drawBias = Number(groupEffects.drawBias || 0);
    if (Number.isFinite(drawBias)) biases.draw = (biases.draw || 0) + clamp(drawBias * 1.55, -0.06, 0.045);
    if (groupEffects.handicapPushCode === "1") biases.home = (biases.home || 0) + 0.075;
    if (groupEffects.handicapPushCode === "2") biases.away = (biases.away || 0) + 0.075;
  }

  return weightedLogPosterior([
    { probabilities: scoreImplied, weight: 0.45 },
    { probabilities: poisson, weight: 0.34 },
  ], biases);
}

function worldCupCandidateContextBoost(candidate, context) {
  const groupContext = context.contextSignals?.worldCupGroupContext || context.contextSignals?.rankingPressure?.worldCupGroupContext;
  if (!groupContext?.sameGroup) return 0;
  const effects = groupContext.effects || {};
  const needEdge = Number(effects.needEdge || 0);
  const drawBias = Number(effects.drawBias || 0);
  let boost = 0;

  if (candidate.market === "HAD") {
    if (candidate.code === "1" && needEdge >= 6) boost += clamp(needEdge / 420, 0.012, 0.045);
    if (candidate.code === "2" && needEdge <= -6) boost += clamp(Math.abs(needEdge) / 420, 0.012, 0.045);
    if (candidate.code === "X" && drawBias > 0.01) boost += clamp(drawBias * 1.4, 0.01, 0.035);
    if (candidate.code === "X" && drawBias < -0.01) boost -= clamp(Math.abs(drawBias) * 1.8, 0.012, 0.05);
  } else if (candidate.market === "HHAD") {
    if (effects.handicapPushCode && candidate.code === effects.handicapPushCode) boost += 0.055;
    if (effects.handicapPushCode && candidate.code !== effects.handicapPushCode && candidate.code !== "X") boost -= 0.028;
    if (candidate.code === "X" && drawBias > 0.012) boost += 0.018;
    if (candidate.code === "X" && drawBias < -0.012) boost -= 0.022;
  }

  return Number(clamp(boost, -0.06, 0.08).toFixed(4));
}

function candidateMarketSupport(candidate, context) {
  const rows = candidate.market === "HHAD" ? context.hhadMarketRows : context.hadMarketRows;
  const row = (rows || []).find((item) => item.code === candidate.code);
  return Number.isFinite(Number(row?.probability)) ? Number(row.probability) : null;
}

function outcomeSideForCode(code) {
  return code === "1" ? "home" : code === "X" ? "draw" : code === "2" ? "away" : null;
}

function candidateOfficialTrendEvidence(match, candidate) {
  const trend = match?.oddsTrend || {};
  const poolTrend = trend?.byPool?.[candidate?.market] || (candidate?.market === "HAD" ? trend : null);
  const movement = poolTrend?.movement || null;
  const sampleSize = Number(poolTrend?.sampleSize || trend.sampleSize || 0);
  if (!movement || sampleSize < 3) {
    return { available: false, sampleSize, supports: false, contradicts: false, change: null };
  }
  const evidence = movementEvidenceForCode(movement, candidate.code, { minimumSamples: 3 });
  if (evidence.available !== true) {
    return { available: false, sampleSize, supports: false, contradicts: false, change: null };
  }
  return {
    available: true,
    sampleSize,
    supports: evidence.supports,
    contradicts: evidence.contradicts,
    change: evidence.probabilityDelta,
    logitChange: evidence.logitDelta,
    direction: poolTrend?.direction || trend.direction || null,
    overroundShiftMaterial: evidence.overroundShiftMaterial,
    lineMovement: evidence.lineMovement,
    blocker: evidence.blocker || null,
    method: movement.devigMethod || null,
  };
}

function candidateExternalMarketEvidence(match, candidate, evaluationAt = null) {
  const fiveHundred = match?.externalSignals?.fiveHundred || {};
  const updatedMs = parseBeijingDateTime(fiveHundred.updatedAt || match?.externalSignals?.updatedAt || "");
  const kickoffMs = parseBeijingDateTime(match?.kickoffTime || match?.matchDate || "");
  const declaredCutoffMs = parseBeijingDateTime(match?.predictionMeta?.cutoffTime || matchCutoffValue(match));
  const lockedMs = parseBeijingDateTime(match?.predictionMeta?.lockedAt || "");
  const evaluationMs = parseBeijingDateTime(evaluationAt || "");
  const cutoffCandidates = [predictionNowMs(), kickoffMs, declaredCutoffMs, lockedMs, evaluationMs].filter(Number.isFinite);
  const cutoffMs = Math.min(...cutoffCandidates);
  const ageMs = Number.isFinite(updatedMs) ? cutoffMs - updatedMs : NaN;
  const freshAsOf = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 72 * 60 * 60 * 1000;
  if (!freshAsOf) {
    return {
      available: false,
      aligned: false,
      contradicted: false,
      riskLevel: null,
      reason: Number.isFinite(updatedMs) && updatedMs > cutoffMs ? "post-cutoff-external-market" : "stale-or-missing-external-market",
      updatedAt: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
      cutoffAt: new Date(cutoffMs).toISOString(),
    };
  }
  if (candidate?.market !== "HAD") {
    return {
      available: false,
      aligned: false,
      contradicted: false,
      riskLevel: null,
      reason: "external-had-market-not-hhad-outcome-evidence",
      updatedAt: new Date(updatedMs).toISOString(),
      cutoffAt: new Date(cutoffMs).toISOString(),
    };
  }
  const europe = fiveHundred.europeOdds || {};
  const consensus = fiveHundred.marketConsensus || {};
  const side = outcomeSideForCode(candidate?.code);
  const currentAverage = normalizedTripletFromAny(europe.currentProbabilityAverage);
  const officialCurrent = normalizedTripletFromAny(europe.official?.currentProbability);
  const officialInitial = normalizedTripletFromAny(europe.official?.initialProbability);
  const currentRows = outcomeRowsFromTriplet(currentAverage);
  const leader = currentRows[0] || null;
  const currentProbability = side && currentAverage ? Number(currentAverage[side]) : null;
  const officialProbability = side && officialCurrent ? Number(officialCurrent[side]) : null;
  const initialProbability = side && officialInitial ? Number(officialInitial[side]) : null;
  const probabilityMove = Number.isFinite(officialProbability) && Number.isFinite(initialProbability)
    ? officialProbability - initialProbability
    : null;
  const asianLineMovement = Number(fiveHundred.asianHandicap?.lineMovement);
  const asianSupports = candidate?.market === "HAD" && Number.isFinite(asianLineMovement) && (
    (candidate.code === "1" && asianLineMovement <= -0.075)
    || (candidate.code === "2" && asianLineMovement >= 0.075)
  );
  const asianContradicts = candidate?.market === "HAD" && Number.isFinite(asianLineMovement) && (
    (candidate.code === "1" && asianLineMovement >= 0.1)
    || (candidate.code === "2" && asianLineMovement <= -0.1)
  );
  const leaderAligned = candidate?.market === "HAD" && leader?.code === candidate.code;
  const probabilityAligned = candidate?.market === "HAD" && Number.isFinite(currentProbability) && currentProbability >= 0.32;
  const moveSupports = Number.isFinite(probabilityMove) && probabilityMove >= 0.015;
  const moveContradicts = Number.isFinite(probabilityMove) && probabilityMove <= -0.03;
  const aligned = Boolean(leaderAligned || probabilityAligned || moveSupports || asianSupports);
  const contradicted = Boolean(moveContradicts || asianContradicts || (
    candidate?.market === "HAD"
    && Number.isFinite(currentProbability)
    && currentProbability < 0.22
  ));
  return {
    available: Boolean(currentAverage || officialCurrent || Number.isFinite(asianLineMovement)),
    aligned,
    contradicted,
    riskLevel: consensus.riskLevel || null,
    leaderCode: leader?.code || null,
    currentProbability: Number.isFinite(currentProbability) ? Number(currentProbability.toFixed(4)) : null,
    officialProbability: Number.isFinite(officialProbability) ? Number(officialProbability.toFixed(4)) : null,
    probabilityMove: Number.isFinite(probabilityMove) ? Number(probabilityMove.toFixed(4)) : null,
    asianLineMovement: Number.isFinite(asianLineMovement) ? Number(asianLineMovement.toFixed(3)) : null,
    companies: Number(europe.companies || 0),
    updatedAt: new Date(updatedMs).toISOString(),
    cutoffAt: new Date(cutoffMs).toISOString(),
  };
}

function upstreamPredictionForCandidate(candidate, context) {
  const rows = [context.best, context.oneXTwo].filter(Boolean);
  return rows.find((prediction) => (
    String(prediction.oddsPoolCode || "").toUpperCase() === candidate.market
    && String(prediction.tipCode || "").toUpperCase() === candidate.code
  )) || null;
}

function multiFactorEvidenceForCandidate(match, candidate, context) {
  const scoreShape = context.scoreShape || {};
  const evidenceHandicapLine = candidate.market === "HHAD"
    ? formatHandicapLineForCopy(scoreShape.handicap)
    : "0";
  const marketRows = candidate.market === "HHAD" ? context.hhadMarketRows : context.hadMarketRows;
  const marketLeader = (marketRows || [])[0] || null;
  const scoreAligned = candidate.market === "HHAD"
    ? scoreShape.top1HhadCode === candidate.code || Number(scoreShape.hhadCodeCounts?.[candidate.code] || 0) > 0
    : scoreShape.top1Code === candidate.code || Number(scoreShape.codeCounts?.[candidate.code] || 0) > 0;
  const handicapAligned = candidate.market === "HHAD"
    ? scoreShape.top1HhadCode === candidate.code || Number(scoreShape.hhadCodeCounts?.[candidate.code] || 0) >= 2
    : context.hadLeader?.code === candidate.code || scoreShape.top1Code === candidate.code;
  const crossMarketCompatible = candidate.market !== "HHAD" || !context.hadLeader?.code
    ? true
    : isHandicapCodeCompatibleWithOutcomeCode(
        context.hadLeader.code,
        candidate.code,
        Number(scoreShape.handicap)
      );
  const trend = candidateOfficialTrendEvidence(match, candidate);
  const externalMarket = candidateExternalMarketEvidence(match, candidate, context.evaluationAt);
  const upstream = upstreamPredictionForCandidate(candidate, context);
  const dataGaps = context.contextSignals?.dataGaps || {};
  const riskTier = String(match?.modelCalibration?.strategy?.activation?.riskGuard?.riskTier || "");
  const evidence = evaluateMultiFactorRecommendation({
    market: candidate.market,
    code: candidate.code,
    handicapLine: evidenceHandicapLine,
    odds: candidate.odds,
    modelProbability: candidate.probability,
    marketProbability: candidateMarketSupport(candidate, context),
    modelGap: candidate.gap,
    dataQuality: observedUnifiedDataQuality(context.contextSignals),
    scoreAligned,
    crossMarketCompatible,
    handicapAligned,
    marketLeaderAligned: marketLeader ? marketLeader.code === candidate.code : null,
    trendSupports: trend.supports,
    trendContradicts: trend.contradicts,
    externalMarketAligned: externalMarket.aligned,
    externalMarketContradicted: externalMarket.contradicted,
    externalMarketRisk: externalMarket.riskLevel,
    upstreamRecommended: upstream?.recommendationAction === "recommend",
    upstreamAligned: Boolean(upstream),
    globalRiskTier: riskTier,
    trustPenalty: context.contextSignals?.trustPenalty,
    riskPenalty: candidate.recentReviewPenalty,
    severeMissingCount: dataGaps.severeMissingCount,
    riskTagsCount: Array.isArray(upstream?.riskTags) ? upstream.riskTags.length : 0,
  });
  const result = {
    ...evidence,
    handicapLine: evidenceHandicapLine,
    officialTrend: trend,
    externalMarket,
    upstream: upstream ? {
      marketType: upstream.marketType,
      oddsPoolCode: upstream.oddsPoolCode,
      tipCode: upstream.tipCode,
      recommendationAction: upstream.recommendationAction,
      recommendationTier: upstream.recommendationTier,
    } : null,
  };
  if (context.inputSparseMarketFallback !== true) return result;
  return {
    ...result,
    eligible: false,
    grade: "WATCH",
    blockers: [...new Set([
      ...(result.blockers || []),
      "insufficient-auditable-model-inputs",
      "official-market-reference-only",
    ])],
    diagnostics: {
      ...(result.diagnostics || {}),
      inputSparseMarketFallback: true,
    },
  };
}

function scoreCountForCandidate(candidate, scoreShape) {
  if (candidate.market === "HHAD") return Number(scoreShape?.hhadCodeCounts?.[candidate.code] || 0);
  return Number(scoreShape?.codeCounts?.[candidate.code] || 0);
}

function recentReviewCandidateAdjustment(candidate, context) {
  const scoreShape = context.scoreShape || {};
  const line = Number(scoreShape.handicap);
  const odds = Number(candidate.odds || 0);
  const oddsBucket = predictionOddsBucket(odds);
  const strategyMarket = candidate.market === "HHAD" ? "HHAD" : "1X2";
  const marketGate = strategyGateForPrediction(context.match, strategyMarket, candidate.code, oddsBucket);
  const bestGate = strategyGateForPrediction(context.match, "BEST", candidate.code, oddsBucket);
  const marketSupport = candidateMarketSupport(candidate, context);
  const topSupportsCandidate = candidate.market === "HHAD"
    ? scoreShape.top1HhadCode === candidate.code
    : scoreShape.top1Code === candidate.code;
  const scoreCount = scoreCountForCandidate(candidate, scoreShape);
  const hadLeaderCode = context.hadLeader?.code;
  const reasons = [];
  let penalty = 0;
  let bonus = 0;

  const strategyPenalty = clamp(
    Number(marketGate.minProbabilityBoost || 0) * 0.44
    + Number(marketGate.minModelGapBoost || 0) * 0.35
    + Number(marketGate.minHandicapSupportBoost || 0) * 0.32
    + Number(marketGate.trustPenalty || 0) / 320
    + Number(bestGate.trustPenalty || 0) / 420,
    0,
    0.09
  );
  if (strategyPenalty > 0.001) {
    penalty += strategyPenalty;
    reasons.push("recent-strategy-cooling");
  }

  if (candidate.market === "HHAD") {
    if (context.hadAvailable) {
      penalty += 0.012;
      reasons.push("prefer-1x2-when-close");
    }

    const opposesRawLeader = Number.isFinite(line) && (
      (line < 0 && hadLeaderCode === "1" && candidate.code === "2")
      || (line > 0 && hadLeaderCode === "2" && candidate.code === "1")
    );
    const exactMarginCount = Number(scoreShape.hhadCodeCounts?.X || 0);

    if (Math.abs(line) >= 2 && opposesRawLeader) {
      const strongCoverEvidence = topSupportsCandidate && scoreCount >= 2 && (marketSupport === null || marketSupport >= 0.42);
      if (!strongCoverEvidence) {
        penalty += 0.095;
        reasons.push("deep-line-cover-risk");
      }
    }

    if (Math.abs(line) >= 2 && exactMarginCount >= 1) {
      if (candidate.code === "X") {
        bonus += 0.035;
        reasons.push("deep-line-let-draw-zone");
      } else if (!topSupportsCandidate || scoreCount < 2 || (marketSupport !== null && marketSupport < 0.45)) {
        penalty += 0.065;
        reasons.push("deep-line-exact-margin-trap");
      }
    }

    if (Math.abs(line) === 1 && opposesRawLeader) {
      if (exactMarginCount >= 1 || scoreShape.lowScoreHeavy) {
        penalty += 0.065;
        reasons.push("one-goal-margin-trap");
      }
      if (marketSupport !== null && marketSupport < 0.37) {
        penalty += 0.035;
        reasons.push("weak-hhad-support");
      }
    }

    if (Math.abs(line) === 1 && candidate.code !== "X" && exactMarginCount >= 2) {
      penalty += 0.06;
      reasons.push("let-draw-hot-zone");
    }

    if (candidate.code === "2" && scoreCount === 0 && marketSupport !== null && marketSupport < 0.45) {
      penalty += 0.035;
      reasons.push("hhad-away-cover-cooling");
    }

    if (line > 0 && candidate.code === "1" && hadLeaderCode === "2") {
      const underdogCoverConfirmed = topSupportsCandidate && (marketSupport === null || marketSupport >= 0.48);
      if (!underdogCoverConfirmed) {
        penalty += 0.06;
        reasons.push("positive-line-underdog-risk");
      }
    }

    if (topSupportsCandidate && scoreCount >= 2 && (marketSupport === null || marketSupport >= 0.43)) {
      bonus += 0.025;
      reasons.push("hhad-score-market-confirmed");
    }
  }

  const adjustment = clamp(bonus - penalty, -0.18, 0.045);
  return {
    recentReviewAdjustment: Number(adjustment.toFixed(4)),
    recentReviewReasons: reasons.slice(0, 6),
    recentReviewPenalty: Number(Math.max(0, penalty - bonus).toFixed(4)),
  };
}

function unifiedCandidateScore(candidate, context) {
  const { scoreShape, hadLeader, hadAvailable, hhadAvailable, contextSignals } = context;
  const sameMarketRows = context[`${candidate.market.toLowerCase()}Rows`] || [];
  const second = sameMarketRows.find((row) => row.code !== candidate.code);
  const gap = Math.max(0, candidate.probability - Number(second?.probability || 0));
  const dataQuality = unifiedDataQuality(contextSignals);
  let consistency = 0;

  if (candidate.market === "HAD") {
    if (scoreShape.top1Code === candidate.code) consistency += 0.065;
    if ((scoreShape.codeCounts?.[candidate.code] || 0) >= 2) consistency += 0.04;
    if (scoreShape.drawHeavy && candidate.code === "X") consistency += 0.07;
    if (scoreShape.drawHeavy && candidate.code !== "X") consistency -= 0.075;
    if (scoreShape.lowScoreHeavy && candidate.code === "X") consistency += 0.045;
    if (scoreShape.lowScoreHeavy && candidate.code !== "X" && candidate.probability < 0.56) consistency -= 0.045;
  } else if (candidate.market === "HHAD") {
    if (scoreShape.top1HhadCode === candidate.code) consistency += 0.065;
    if ((scoreShape.hhadCodeCounts?.[candidate.code] || 0) >= 2) consistency += 0.04;
    if (hadAvailable) consistency -= 0.035;
    if (scoreShape.hhadCodeCounts?.X >= 2 && candidate.code === "X") consistency += 0.045;
    const line = Number(scoreShape.handicap);
    const hadCode = hadLeader?.code;
    const hhadTopCode = scoreShape.top1HhadCode;
    const hhadOpposesRawLeader = Number.isFinite(line) && hadCode && (
      (line < 0 && hadCode === "1" && candidate.code === "2")
      || (line > 0 && hadCode === "2" && candidate.code === "1")
    );
    if (Number.isFinite(line) && Math.abs(line) >= 2 && scoreShape.hhadCodeCounts?.X >= 1) {
      if (candidate.code === "X") consistency += 0.035;
      else consistency -= 0.035;
    }
    if (hhadOpposesRawLeader && hhadTopCode !== candidate.code) consistency -= 0.09;
    if (hhadOpposesRawLeader && hhadTopCode === candidate.code) consistency += 0.035;
    if (!hhadAvailable) consistency -= 1;
  }

  if (context.inputSparseMarketFallback === true) consistency *= 0.2;
  const qualityPenalty = dataQuality < 0.45 ? 0.035 : dataQuality < 0.62 ? 0.018 : 0;
  const riskPenalty = Math.min(0.055, Number(contextSignals?.trustPenalty || 0) / 220);
  const worldCupContextBoost = worldCupCandidateContextBoost(candidate, context);
  const recentReview = recentReviewCandidateAdjustment(candidate, context);
  return {
    ...candidate,
    gap,
    consistency,
    worldCupContextBoost,
    ...recentReview,
    posteriorScore: candidate.probability + gap * 0.54 + consistency + worldCupContextBoost + recentReview.recentReviewAdjustment - qualityPenalty - riskPenalty,
  };
}

function compactMarketLaneCandidate(candidate) {
  if (!candidate) return null;
  const posteriorScore = Number(candidate.posteriorScore);
  return {
    market: candidate.market,
    code: candidate.code,
    probability: pct1(candidate.probability),
    odds: Number.isFinite(candidate.odds) ? candidate.odds : 0,
    gap: pct1(candidate.gap),
    posteriorScore: Number.isFinite(posteriorScore) ? Number(posteriorScore.toFixed(4)) : null,
    selectionPolicy: candidate.selectionPolicy || null,
  };
}

function buildMarketLaneShadowAudit(hadBest, hhadBest, selected, rawSelected = selected) {
  // HAD and HHAD have materially different calibration. Keep HHAD available
  // only when HAD is absent until its own chronological promotion gate passes.
  const activeSelected = selected || hadBest || hhadBest || null;
  const rawSelection = compactMarketLaneCandidate(rawSelected);
  const currentSelection = compactMarketLaneCandidate(activeSelected);
  const shadowSelection = compactMarketLaneCandidate(hadBest || hhadBest || null);
  const formalOutputChanged = Boolean(
    rawSelection
    && currentSelection
    && (rawSelection.market !== currentSelection.market || rawSelection.code !== currentSelection.code)
  );
  return {
    version: "had-hhad-independent-lane-v2",
    activation: "active-had-first",
    promotionEligible: false,
    formalOutputChanged,
    policy: "Prefer the HAD lane when both pools exist; allow HHAD only when HAD is unavailable until HHAD passes an independent chronological promotion gate.",
    lanes: {
      HAD: compactMarketLaneCandidate(hadBest),
      HHAD: compactMarketLaneCandidate(hhadBest),
    },
    rawSelection,
    currentSelection,
    shadowSelection,
    wouldChangeSelection: formalOutputChanged,
  };
}

function buildUnifiedPosteriorCandidates(match, context) {
  const {
    best,
    oneXTwo,
    probabilityModel,
    probabilities,
    hhadProbabilities,
    hadOdds,
    hhadOdds,
    anchorHandicapLine,
    contextSignals,
    inputCoverage,
  } = context;
  const resolvedHhadLine = resolveHandicapLine(match, [best, oneXTwo]);
  const hhadLine = hhadOdds && resolvedHhadLine !== null
    ? formatHandicapLineForCopy(resolvedHhadLine)
    : (anchorHandicapLine || "");
  const scoreShape = scoreShapeFromProbabilityModel(probabilityModel, hhadLine);
  const inputSparseMarketFallback = Boolean(
    hadOdds
    && inputCoverage?.sufficient === false
  );
  const hadPosteriorDecision = hadOdds
    ? buildUnifiedOneXTwoPosteriorDecision(probabilityModel, probabilities, contextSignals, scoreShape, inputCoverage)
    : null;
  const hadPosterior = hadPosteriorDecision?.probabilities || null;
  const hhadPosterior = hhadOdds
    ? buildUnifiedHandicapPosterior(probabilityModel, hhadProbabilities, scoreShape)
    : null;
  const hadRows = outcomeRowsFromTriplet(hadPosterior);
  const hhadRows = outcomeRowsFromTriplet(hhadPosterior);
  const hhadMarketRows = hhadOdds
    ? outcomeRowsFromTriplet(impliedProbabilities(hhadOdds))
    : [];
  const hadMarketRows = hadOdds
    ? outcomeRowsFromTriplet(impliedProbabilities(hadOdds))
    : [];
  const hadLeader = hadRows[0] || null;
  const scoredContext = {
    match,
    scoreShape,
    hadRows,
    hhadRows,
    hadMarketRows,
    hhadMarketRows,
    hadLeader,
    hadAvailable: Boolean(hadOdds),
    hhadAvailable: Boolean(hhadOdds),
    contextSignals,
    best,
    oneXTwo,
    evaluationAt: probabilityModel?.generatedAt || predictionNowIso(),
    inputCoverage,
    inputSparseMarketFallback,
    hadPosteriorDiagnostics: hadPosteriorDecision?.diagnostics || null,
  };
  const candidates = [
    ...hadRows.map((row) => ({
      market: "HAD",
      code: row.code,
      probability: row.probability,
      odds: oddsValueForCode(hadOdds, row.code),
      label: simpleOutcomeLabel(match, row.code),
    })),
    ...hhadRows.map((row) => ({
      market: "HHAD",
      code: row.code,
      probability: row.probability,
      odds: oddsValueForCode(hhadOdds, row.code),
      label: simpleHandicapOutcomeLabel(row.code),
    })),
  ].map((candidate) => unifiedCandidateScore(candidate, scoredContext))
    .map((candidate) => ({
      ...candidate,
      multiFactorEvidence: multiFactorEvidenceForCandidate(match, candidate, scoredContext),
    }));

  const rawSelected = [...candidates].sort((a, b) => b.posteriorScore - a.posteriorScore)[0] || null;
  // HAD direction is the argmax of the auditable unified probability
  // posterior. Value, score-shape and risk scores remain confidence/promotion
  // evidence, but cannot rewrite the published outcome direction.
  const hadBest = hadLeader
    ? candidates.find((item) => item.market === "HAD" && item.code === hadLeader.code) || null
    : null;
  const hhadBest = candidates.filter((item) => item.market === "HHAD").sort((a, b) => b.posteriorScore - a.posteriorScore)[0] || null;
  let selected = hadBest || hhadBest || rawSelected;

  if (hadBest && hhadBest && selected?.market === "HHAD") {
    const hadIsClean = hadBest.probability >= 0.39
      && hadBest.gap >= 0.055
      && scoreShape.top1Code === hadBest.code
      && !scoreShape.drawHeavy
      && !scoreShape.lowScoreHeavy;
    if (hadIsClean && hadBest.posteriorScore >= hhadBest.posteriorScore - 0.018) {
      selected = hadBest;
    }
  }

  let outcomeConflict = null;
  if (
    selected?.market === "HHAD"
    && hadBest
    && ["1", "X", "2"].includes(hadBest.code)
    && !isHandicapCodeCompatibleWithOutcomeCode(hadBest.code, selected.code, Number(scoreShape.handicap))
  ) {
    const originalSelected = selected;
    const compatibleHhad = candidates
      .filter((item) => item.market === "HHAD" && isHandicapCodeCompatibleWithOutcomeCode(hadBest.code, item.code, Number(scoreShape.handicap)))
      .sort((a, b) => b.posteriorScore - a.posteriorScore);
    const letDraw = compatibleHhad.find((item) => item.code === "X");
    const canReturnToHad = hadBest.posteriorScore >= originalSelected.posteriorScore - 0.13
      || scoreShape.top1Code === hadBest.code
      || Number(originalSelected.recentReviewPenalty || 0) >= 0.14;
    const canUseLetDraw = letDraw
      && letDraw.posteriorScore >= originalSelected.posteriorScore - 0.12
      && (scoreShape.top1HhadCode === "X" || Number(scoreShape.hhadCodeCounts?.X || 0) >= 1);

    if (canReturnToHad) {
      selected = {
        ...hadBest,
        selectionPolicy: "hhad-outcome-conflict-had-safeguard",
      };
      outcomeConflict = {
        type: "hhad-outcome-conflict",
        line: scoreShape.handicap,
        originalMarket: originalSelected.market,
        originalCode: originalSelected.code,
        hadCode: hadBest.code,
        action: "selected-had",
      };
    } else if (canUseLetDraw) {
      selected = {
        ...letDraw,
        selectionPolicy: "hhad-outcome-conflict-let-draw-safeguard",
      };
      outcomeConflict = {
        type: "hhad-outcome-conflict",
        line: scoreShape.handicap,
        originalMarket: originalSelected.market,
        originalCode: originalSelected.code,
        hadCode: hadBest.code,
        action: "selected-compatible-hhad",
      };
    } else {
      selected = {
        ...selected,
        selectionPolicy: "hhad-main-over-conflicting-1x2",
        outcomeConflict: {
          type: "hhad-outcome-conflict",
          line: scoreShape.handicap,
          hadCode: hadBest.code,
          originalCode: originalSelected.code,
          action: "kept-hhad-main",
        },
      };
      outcomeConflict = selected.outcomeConflict;
    }
  }

  let marketSafeguard = null;
  const selectedHhadMarketSupport = selected?.market === "HHAD"
    ? hhadMarketRows.find((row) => row.code === selected.code)?.probability ?? null
    : null;
  const hhadMarketLeader = hhadMarketRows[0] || null;
  if (
    !hadOdds
    && selected?.market === "HHAD"
    && hhadMarketLeader
    && hhadMarketLeader.code !== selected.code
    && selectedHhadMarketSupport !== null
    && selectedHhadMarketSupport < 0.38
  ) {
    const originalSelected = selected;
    selected = {
      ...originalSelected,
      selectionPolicy: "hhad-market-contradiction-watch",
    };
    marketSafeguard = {
      type: "hhad-market-contradiction",
      action: "downgrade-watch",
      originalCode: originalSelected.code,
      originalLabelZh: originalSelected.label.zh,
      originalLabelEn: originalSelected.label.en,
      originalMarketSupport: selectedHhadMarketSupport,
      marketCode: hhadMarketLeader.code,
      marketLabelZh: simpleHandicapOutcomeLabel(hhadMarketLeader.code).zh,
      marketLabelEn: simpleHandicapOutcomeLabel(hhadMarketLeader.code).en,
      marketSupport: hhadMarketLeader.probability,
    };
  }

  const hadMarketLeader = hadMarketRows[0] || null;
  const selectedHadMarketSupport = selected?.market === "HAD"
    ? hadMarketRows.find((row) => row.code === selected.code)?.probability ?? null
    : null;
  const hadMarketDirectionGap = selectedHadMarketSupport !== null && hadMarketLeader
    ? Number(hadMarketLeader.probability) - Number(selectedHadMarketSupport)
    : null;
  const materialHadMarketConflict = Boolean(
    selected?.market === "HAD"
    && hadMarketLeader
    && hadMarketLeader.code !== selected.code
    && Number(hadMarketLeader.probability) >= 0.45
    && Number(hadMarketDirectionGap) >= 0.12
  );
  const calibratedMarketCandidate = hadMarketLeader
    ? candidates.find((item) => item.market === "HAD" && item.code === hadMarketLeader.code) || null
    : null;
  const calibratedMarketThresholdMet = Boolean(
    calibratedMarketCandidate
    && hadMarketLeader.probability + Number.EPSILON >= CALIBRATED_HAD_MARKET_MIN_LEADER_PROBABILITY
  );
  const calibratedMarketDirectionAligned = Boolean(
    calibratedMarketThresholdMet
    && selected?.market === "HAD"
    && selected.code === hadMarketLeader?.code
  );
  const calibratedMarketBlockers = [
    ...(calibratedMarketThresholdMet && selected?.market !== "HAD" ? ["selected-market-not-had"] : []),
    ...(materialHadMarketConflict
      ? ["model-market-direction-conflict"]
      : []),
    ...(marketSafeguard ? ["market-safeguard-active"] : []),
    ...(outcomeConflict ? ["outcome-conflict-active"] : []),
  ];
  const calibratedMarketBaselineApplied = Boolean(
    calibratedMarketDirectionAligned
    && calibratedMarketBlockers.length === 0
  );
  if (calibratedMarketBaselineApplied) {
    selected = {
      ...selected,
      selectionPolicy: selected.selectionPolicy || "calibrated-had-market-baseline",
      marketBaselineSupport: {
        version: "calibrated-had-market-support-v1",
        applied: true,
        leaderCode: hadMarketLeader.code,
        leaderProbability: Number(hadMarketLeader.probability.toFixed(6)),
      },
    };
  }
  const marketBaseline = {
    version: "calibrated-had-market-baseline-v2",
    activation: "support-only-when-model-aligned-and-conflict-free",
    minimumLeaderProbability: CALIBRATED_HAD_MARKET_MIN_LEADER_PROBABILITY,
    available: Boolean(calibratedMarketCandidate),
    thresholdMet: calibratedMarketThresholdMet,
    directionAligned: calibratedMarketDirectionAligned,
    applied: calibratedMarketBaselineApplied,
    blockers: calibratedMarketBlockers,
    leaderCode: hadMarketLeader?.code || null,
    leaderProbability: Number.isFinite(hadMarketLeader?.probability)
      ? Number(hadMarketLeader.probability.toFixed(6))
      : null,
    selectedCode: selected?.market === "HAD" ? selected.code : null,
    selectedSupport: Number.isFinite(selectedHadMarketSupport)
      ? Number(selectedHadMarketSupport.toFixed(6))
      : null,
    directionGap: Number.isFinite(hadMarketDirectionGap)
      ? Number(hadMarketDirectionGap.toFixed(6))
      : null,
    materialDirectionConflict: materialHadMarketConflict,
    rawSelection: compactMarketLaneCandidate(rawSelected),
    activeSelection: compactMarketLaneCandidate(selected),
  };
  const inputFallback = {
    version: "input-sparse-evidence-shrinkage-reference-v3",
    applied: inputSparseMarketFallback,
    formalPromotionEligible: false,
    source: inputSparseMarketFallback ? "official-sporttery-had" : null,
    marketWeight: hadPosteriorDecision?.diagnostics?.weights?.market ?? 0,
    modelWeight: hadPosteriorDecision
      ? Number((1 - Number(hadPosteriorDecision.diagnostics?.weights?.market || 0)).toFixed(2))
      : 0,
    inputSufficient: inputCoverage?.sufficient ?? null,
    evidenceFamilies: inputCoverage?.evidenceFamilies ?? null,
    blockers: inputSparseMarketFallback ? (inputCoverage?.blockers || []) : [],
    uncertaintyScore: hadPosteriorDecision?.diagnostics?.uncertaintyScore ?? null,
    drawAdjustment: hadPosteriorDecision?.diagnostics?.drawAdjustment ?? null,
  };

  if (selected) {
    selected = {
      ...selected,
      multiFactorEvidence: multiFactorEvidenceForCandidate(match, selected, scoredContext),
    };
  }
  let multiFactorEvidence = selected?.multiFactorEvidence || null;
  if (marketSafeguard && multiFactorEvidence) {
    multiFactorEvidence = {
      ...multiFactorEvidence,
      eligible: false,
      grade: "WATCH",
      blockers: [...new Set([
        ...(multiFactorEvidence.blockers || []),
        "official-market-direction-contradiction",
      ])],
      diagnostics: {
        ...(multiFactorEvidence.diagnostics || {}),
        marketDirectionContradiction: true,
        marketContradictionAction: "downgrade-watch-without-reroute",
      },
    };
    selected = { ...selected, multiFactorEvidence };
  }
  const actionable = multiFactorEvidence?.eligible === true;
  const marketLaneAudit = buildMarketLaneShadowAudit(hadBest, hhadBest, selected, rawSelected);

  return {
    selected,
    candidates: candidates.sort((a, b) => b.posteriorScore - a.posteriorScore),
    hadPosterior,
    hhadPosterior,
    hadRows,
    hhadRows,
    scoreShape,
    hhadLine,
    marketSafeguard,
    multiFactorEvidence,
    actionable,
    outcomeConflict,
    marketLaneAudit,
    marketBaseline,
    inputFallback,
    hadPosteriorDiagnostics: hadPosteriorDecision?.diagnostics || null,
  };
}

function formatPosteriorRows(rows, match, market) {
  if (!rows?.length) return "--";
  return rows
    .map((row) => {
      const label = market === "HHAD"
        ? simpleHandicapOutcomeLabel(row.code).zh
        : simpleOutcomeLabel(match, row.code).zh.replace(/\s.+$/, "");
      return `${label} ${pct(row.probability)}%`;
    })
    .join(" / ");
}

function markPredictionAsUnifiedReference(prediction, noteZh, noteEn) {
  if (!prediction) return prediction;
  return {
    ...prediction,
    recommendationAction: "reference",
    recommendationTier: "posterior-reference",
    explanation: {
      zh: noteZh,
      en: noteEn,
    },
    riskTags: [
      ...(prediction.riskTags || []).slice(0, 3),
      { zh: "统一后验验证项", en: "Unified posterior reference" },
    ],
  };
}

function enforceUnifiedPosteriorRecommendation(match, context) {
  const {
    oneXTwo,
    goals,
    best,
    probabilityModel,
    hadOdds,
    hhadOdds,
    anchorHandicapLine,
    contextSignals,
  } = context;
  const unified = buildUnifiedPosteriorCandidates(match, context);
  const selected = unified.selected;
  if (!selected) {
    return {
      predictions: [oneXTwo, goals, best],
      probabilityModel,
      projectedScore: context.score,
    };
  }

  const selectedIsHhad = selected.market === "HHAD";
  const usesCalibratedHadMarketBaseline = unified.marketBaseline?.applied === true
    && selected.market === "HAD"
    && selected.code === unified.marketBaseline?.leaderCode;
  const usesInputSparseMarketFallback = unified.inputFallback?.applied === true
    && selected.market === "HAD";
  const withholdForHadMarketConflict = unified.marketBaseline?.materialDirectionConflict === true;
  const isActionable = unified.actionable === true
    && Number.isFinite(selected.odds)
    && selected.odds > 1;
  const multiFactorEvidence = unified.multiFactorEvidence || selected.multiFactorEvidence || null;
  const scoreShape = unified.scoreShape;
  const selectedScore = selectedIsHhad && scoreShape.handicap !== null
    ? (scoreShape.topScores.find((row) => scoreOutcomeWithHandicap(row.home, row.away, scoreShape.handicap) === selected.code) || scoreShape.top1)
    : (scoreShape.topScores.find((row) => oneXTwoCodeForScore(row.home, row.away) === selected.code) || scoreShape.top1);
  const topScoreText = selectedScore ? `${selectedScore.home}-${selectedScore.away}` : `${context.score.home}-${context.score.away}`;
  const globalTopScoreText = scoreShape.top1 ? `${scoreShape.top1.home}-${scoreShape.top1.away}` : topScoreText;
  const marketLabelZh = selectedIsHhad ? "让球胜平负" : "胜平负";
  const marketLabelEn = selectedIsHhad ? "HHAD" : "1X2";
  const hasHad = Boolean(hadOdds);
  const hasHhad = Boolean(hhadOdds);
  const posteriorRows = selectedIsHhad ? unified.hhadRows : unified.hadRows;
  const supportText = formatPosteriorRows(posteriorRows, match, selected.market);
  const hhadLine = unified.hhadLine || anchorHandicapLine || "";
  const onlyHhadNoteZh = !hasHad && hasHhad
    ? "普通胜平负未开售，本场只按让球胜平负给主结论。"
    : "";
  const switchNoteZh = hasHad && selectedIsHhad
    ? "普通胜平负边际不够清晰，统一后验改用让球盘作为主结论。"
    : "";
  const marketSafeguardNoteZh = unified.marketSafeguard
    ? `让球盘口分歧：模型方向 ${unified.marketSafeguard.originalLabelZh} 的官方支持只有 ${pct(unified.marketSafeguard.originalMarketSupport || 0)}%，官方让球盘第一方向为 ${unified.marketSafeguard.marketLabelZh}；保留冻结模型方向，但降级为观察，不按市场换向。`
    : "";
  const marketSafeguardNoteEn = unified.marketSafeguard
    ? `HHAD market disagreement: the frozen model side ${unified.marketSafeguard.originalLabelEn} has only ${pct(unified.marketSafeguard.originalMarketSupport || 0)}% official support while the market leader is ${unified.marketSafeguard.marketLabelEn}. The model direction is retained but downgraded to watch; the market does not reroute it.`
    : "";
  const evidenceBlockers = (multiFactorEvidence?.blockers || []).slice(0, 4);
  const evidenceNoteZh = isActionable
    ? `\u591a\u56e0\u7d20\u8bc1\u636e\u5206 ${Number(multiFactorEvidence?.evidenceScore || 0).toFixed(1)}\uff1a\u72ec\u7acb\u6a21\u578b\u3001\u6bd4\u5206\u77e9\u9635\u3001HAD/HHAD \u4e00\u81f4\u6027\u3001\u53bb\u6c34\u76d8\u9762\u3001\u8d54\u7387\u8d70\u52bf\u4e0e\u6570\u636e\u8d28\u91cf\u5171\u540c\u901a\u8fc7\u3002`
    : `\u591a\u56e0\u7d20\u95e8\u69db\u672a\u901a\u8fc7\uff08\u8bc1\u636e\u5206 ${Number(multiFactorEvidence?.evidenceScore || 0).toFixed(1)}\uff09\uff1a${evidenceBlockers.join(" / ") || "evidence-not-ready"}\u3002SP \u4ec5\u4f5c\u4e3a\u76d8\u9762\u4e0e\u4ef7\u503c\u7279\u5f81\uff0c\u4e0d\u4f1a\u56e0\u4e3a\u66f4\u4f4e\u5c31\u6362\u65b9\u5411\u3002`;
  const evidenceNoteEn = isActionable
    ? `Multi-factor evidence ${Number(multiFactorEvidence?.evidenceScore || 0).toFixed(1)}: the independent model, score matrix, HAD/HHAD consistency, devigged board, price movement and data quality all passed.`
    : `Multi-factor gate did not pass (evidence ${Number(multiFactorEvidence?.evidenceScore || 0).toFixed(1)}): ${evidenceBlockers.join(" / ") || "evidence-not-ready"}. SP is a market/value feature and never changes the selected direction merely because it is lower.`;
  const calibratedMarketNoteZh = usesCalibratedHadMarketBaseline
    ? `\u5b98\u65b9 HAD \u53bb\u6c34\u9886\u8dd1\u65b9\u5411\uff08${pct(unified.marketBaseline.leaderProbability || 0)}%\uff09\u4e0e\u5f53\u524d\u6a21\u578b\u65b9\u5411\u4e00\u81f4\uff0c\u4ec5\u6807\u8bb0\u4e3a\u5e02\u573a\u652f\u6301\uff1b\u5e02\u573a\u57fa\u7ebf\u4e0d\u6539\u5199\u6a21\u578b\u65b9\u5411\uff0c\u4e5f\u4e0d\u6e05\u9664\u5e73\u5c40\u6216\u8de8\u76d8\u53e3\u98ce\u9669\u4fdd\u62a4\u3002`
    : "";
  const calibratedMarketNoteEn = usesCalibratedHadMarketBaseline
    ? `The official de-vigged HAD leader (${pct(unified.marketBaseline.leaderProbability || 0)}%) agrees with the current model direction and is marked only as market support. The market baseline does not rewrite the model direction or clear draw and cross-market safeguards.`
    : "";
  const inputFallbackNoteZh = usesInputSparseMarketFallback
    ? `球队级 Elo、近期状态或历史映射未达到可审计门槛，当前方向采用平局感知的证据收缩：独立模型与比分结构占 ${Math.round((1 - Number(unified.inputFallback.marketWeight || 0)) * 100)}%，官方 HAD 仅以 ${Math.round(Number(unified.inputFallback.marketWeight || 0) * 100)}% 低权重做市场校验；该方向仍给出参考，但不进入正式晋级与正式命中率。`
    : "";
  const inputFallbackNoteEn = usesInputSparseMarketFallback
    ? `Team-level Elo, form, or historical mapping did not meet the auditable threshold. The direction uses draw-aware evidence shrinkage with a ${Math.round((1 - Number(unified.inputFallback.marketWeight || 0)) * 100)}% independent model/score share and only a ${Math.round(Number(unified.inputFallback.marketWeight || 0) * 100)}% official market validation share. It remains visible as a reference and is excluded from formal promotion and formal hit-rate samples.`
    : "";
  const calibrationMetrics = match?.modelCalibration?.metrics || {};
  const calibrationSample = match?.modelCalibration?.sample?.recommendationPool
    ?? match?.modelCalibration?.sample?.oneXTwo
    ?? null;
  const confidenceFreshnessEvidence = auditableConfidenceFreshnessEvidence(
    match,
    probabilityModel?.generatedAt,
    selected.market,
  );
  const dynamicConfidence = buildDynamicRecommendationConfidence({
    selectedProbability: selected.probability,
    modelGap: selected.gap,
    dataQuality: observedUnifiedDataQuality(contextSignals),
    evidenceCompleteness: observedInputCoverageRatio(context.inputCoverage),
    evidenceScore: multiFactorEvidence?.evidenceScore,
    marketProbability: multiFactorEvidence?.marketProbability,
    marketAligned: multiFactorEvidence?.diagnostics?.marketLeaderAligned,
    supportingFactorCount: multiFactorEvidence?.supportingFactors?.length,
    evidenceFamilyCount: context.inputCoverage?.evidenceFamilies,
    minimumEvidenceFamilies: context.inputCoverage?.minimumEvidenceFamilies,
    independentAgreement: unified.hadPosteriorDiagnostics?.independentAgreement,
    freshnessEvidence: confidenceFreshnessEvidence,
    uncertaintyScore: unified.hadPosteriorDiagnostics?.uncertaintyScore,
    inputSparse: context.inputCoverage?.sufficient === false,
    blockerCount: multiFactorEvidence?.blockers?.length,
    calibrationHitRate: calibrationMetrics.bestHitRate ?? calibrationMetrics.oneXTwoHitRate,
    calibrationSample,
    trustPenalty: Number(contextSignals?.trustPenalty || 0)
      + Number(selected.recentReviewPenalty || 0) * 100,
    materialConflict: withholdForHadMarketConflict,
    formalRecommendation: isActionable,
  });
  const trustScore = dynamicConfidence.score;
  const unifiedBestBase = {
    ...best,
    marketType: "BEST",
    oddsPoolCode: selectedIsHhad ? "HHAD" : "HAD",
    handicapLine: selectedIsHhad ? hhadLine : "0",
    tipCode: selected.code,
    tipLabel: {
      zh: isActionable ? `主推 ${selected.label.zh}` : `参考推荐 ${selected.label.zh}`,
      en: isActionable ? `Main pick: ${selected.label.en}` : `Reference pick: ${selected.label.en}`,
    },
    odds: Number.isFinite(selected.odds) ? selected.odds : 0,
    trustScore,
    confidence: dynamicConfidence,
    multiFactorEvidence,
    recommendationAction: isActionable ? "recommend" : "reference",
    recommendationTier: !isActionable
      ? (usesInputSparseMarketFallback
          ? confidenceReferenceTier(dynamicConfidence, "input-sparse-dynamic-evidence")
          : confidenceReferenceTier(dynamicConfidence))
      : `multi-factor-${String(multiFactorEvidence?.grade || "c").toLowerCase()}`,
    explanation: {
      zh: `统一后验结论：先用泊松比分矩阵生成比分分布，再融合独立模型概率、比分反推和赛前信号；SP只做校验。${onlyHhadNoteZh}${switchNoteZh}${marketSafeguardNoteZh}${evidenceNoteZh}${isActionable ? `本场主推 ${selected.label.zh}。` : `本场仅观察 ${selected.label.zh}。`}`,
      en: `Unified posterior verdict: the final gate combines independent probability, score-implied probability, HAD/HHAD structure, official and external market movement, value, data quality and risk. ${inputFallbackNoteEn}${calibratedMarketNoteEn}${marketSafeguardNoteEn}${evidenceNoteEn} Direction: ${selected.label.en}.`,
    },
    analysisItems: [
      {
        zh: `比分矩阵先行：主推对应热区 ${topScoreText}${globalTopScoreText !== topScoreText ? `，全局最高单比分 ${globalTopScoreText}` : ""}；前三比分为 ${scoreShape.top3.map((row) => row.label).join(" / ") || topScoreText}。`,
        en: `Score matrix first: pick-aligned score zone ${topScoreText}${globalTopScoreText !== topScoreText ? `, global top single score ${globalTopScoreText}` : ""}; top three ${scoreShape.top3.map((row) => row.label).join(" / ") || topScoreText}.`,
      },
      {
        zh: `${marketLabelZh}后验：${supportText}。当前主结论只按${marketLabelZh}结算，不再用进球数或另一个盘口做兜底。`,
        en: `${marketLabelEn} posterior: ${supportText}. The main result settles only on this market; totals or the other pool are references, not backups.`,
      },
      ...(unified.marketSafeguard ? [{
        zh: marketSafeguardNoteZh,
        en: marketSafeguardNoteEn,
      }] : []),
      ...(usesCalibratedHadMarketBaseline ? [{
        zh: calibratedMarketNoteZh,
        en: calibratedMarketNoteEn,
      }] : []),
      ...(usesInputSparseMarketFallback ? [{
        zh: inputFallbackNoteZh,
        en: inputFallbackNoteEn,
      }] : []),
      { zh: evidenceNoteZh, en: evidenceNoteEn },
      {
        zh: `自洽规则：如果比分热区偏平局，就压低硬追胜负；如果普通胜平负未开售，就不凭空生成主胜/平/客胜主推；如果选择让球，也只显示为让胜/让平/让负。`,
        en: `Consistency rule: draw-heavy score shapes suppress forced 1X2 sides; if 1X2 is not on sale, no raw 1X2 main pick is invented; HHAD is displayed only as HHAD home/draw/away.`,
      },
    ],
    riskTags: [
      { zh: "统一后验主结论", en: "Unified posterior main pick" },
      ...(scoreShape.drawHeavy ? [{ zh: "比分防平", en: "Score draw pressure" }] : []),
      ...(scoreShape.lowScoreHeavy ? [{ zh: "低比分热区", en: "Low-score zone" }] : []),
      ...(!isActionable ? [{ zh: "\u591a\u56e0\u7d20\u8bc1\u636e\u4e0d\u8db3", en: "Multi-factor evidence not ready" }] : []),
      ...(usesCalibratedHadMarketBaseline ? [{ zh: "\u6821\u51c6 HAD \u5e02\u573a\u53c2\u8003", en: "Calibrated HAD market reference" }] : []),
      ...(usesInputSparseMarketFallback ? [{ zh: "\u7f3a\u53c2\u5b98\u65b9 HAD \u515c\u5e95", en: "Official HAD sparse-input backstop" }] : []),
      ...((best?.riskTags || []).filter((tag) => !["Conditions not aligned", "Best-lane hit-rate cooldown"].includes(tag.en)).slice(0, 3)),
    ],
    visibilityStatus: "FREE",
    resultStatus: isActionable ? resultStatus(match, selected.code, selectedIsHhad ? "BEST_HHAD" : "BEST") : "PENDING",
  };
  const marketConflictLeaderLabel = withholdForHadMarketConflict
    ? simpleOutcomeLabel(match, unified.marketBaseline.leaderCode)
    : null;
  let publicUnifiedBestBase = withholdForHadMarketConflict ? {
    ...unifiedBestBase,
    tipCode: "WATCH",
    tipLabel: {
      zh: "暂不推荐：模型与官方市场冲突",
      en: "No pick: model and official market conflict",
    },
    odds: 0,
    trustScore: clamp(Number(unifiedBestBase.trustScore || 35), 20, 38),
    recommendationAction: "reference",
    recommendationTier: "market-conflict-watch",
    explanation: {
      zh: `模型内部方向为${selected.label.zh}，但官方 HAD 去水领跑方向为${marketConflictLeaderLabel?.zh || unified.marketBaseline.leaderCode}（${pct(unified.marketBaseline.leaderProbability || 0)}%），方向支持差达到 ${pct(unified.marketBaseline.directionGap || 0)}%。当前保留内部审计，不向前台发布主胜、平局或客胜方向。`,
      en: `The internal model side is ${selected.label.en}, while the official de-vigged HAD leader is ${marketConflictLeaderLabel?.en || unified.marketBaseline.leaderCode} (${pct(unified.marketBaseline.leaderProbability || 0)}%), with a ${pct(unified.marketBaseline.directionGap || 0)}% support gap. The internal audit is retained, but no public 1X2 direction is issued.`,
    },
    riskTags: [
      { zh: "模型与官方市场冲突", en: "Model and official market conflict" },
      { zh: "方向暂停发布", en: "Direction withheld" },
    ],
    resultStatus: "PENDING",
  } : unifiedBestBase;
  const dynamicHadReferenceCandidate = !isActionable
    ? unified.candidates.find((item) => item.market === "HAD" && item.code === unified.hadRows?.[0]?.code) || null
    : null;
  const officialHadReferenceCode = (
    !isActionable
    && dynamicHadReferenceCandidate
    && ["1", "X", "2"].includes(String(dynamicHadReferenceCandidate.code || ""))
  )
    ? String(dynamicHadReferenceCandidate.code)
    : null;
  const officialHadReferenceOdds = officialHadReferenceCode
    ? oddsValueForCode(hadOdds, officialHadReferenceCode)
    : 0;
  const useOfficialHadReference = Boolean(
    officialHadReferenceCode
    && Number.isFinite(officialHadReferenceOdds)
    && officialHadReferenceOdds > 1
  );
  const officialHadMarketRows = hadOdds
    ? outcomeRowsFromTriplet(impliedProbabilities(hadOdds))
    : [];
  const officialHadReferenceMarketRow = officialHadMarketRows.find((row) => row.code === officialHadReferenceCode) || null;
  const officialHadReferenceProbability = Number.isFinite(Number(dynamicHadReferenceCandidate?.probability))
    ? Number(dynamicHadReferenceCandidate.probability)
    : null;
  const officialHadReferenceMarketProbability = officialHadReferenceMarketRow
    && Number.isFinite(Number(officialHadReferenceMarketRow.probability))
    ? Number(officialHadReferenceMarketRow.probability)
    : null;
  const officialHadReferenceMarketAligned = officialHadMarketRows[0]
    ? officialHadMarketRows[0].code === officialHadReferenceCode
    : null;
  const officialHadReferenceEvidence = dynamicHadReferenceCandidate?.multiFactorEvidence || multiFactorEvidence;
  const officialHadReferenceFreshnessEvidence = auditableConfidenceFreshnessEvidence(
    match,
    probabilityModel?.generatedAt,
    "HAD",
  );
  const officialHadReferenceConfidence = buildDynamicRecommendationConfidence({
    selectedProbability: officialHadReferenceProbability,
    modelGap: dynamicHadReferenceCandidate?.gap,
    dataQuality: observedUnifiedDataQuality(contextSignals),
    evidenceCompleteness: observedInputCoverageRatio(context.inputCoverage),
    evidenceScore: officialHadReferenceEvidence?.evidenceScore,
    marketProbability: officialHadReferenceMarketProbability,
    marketAligned: officialHadReferenceMarketAligned,
    supportingFactorCount: officialHadReferenceEvidence?.supportingFactors?.length,
    evidenceFamilyCount: context.inputCoverage?.evidenceFamilies,
    minimumEvidenceFamilies: context.inputCoverage?.minimumEvidenceFamilies,
    independentAgreement: unified.hadPosteriorDiagnostics?.independentAgreement,
    freshnessEvidence: officialHadReferenceFreshnessEvidence,
    uncertaintyScore: unified.hadPosteriorDiagnostics?.uncertaintyScore,
    inputSparse: context.inputCoverage?.sufficient === false,
    blockerCount: officialHadReferenceEvidence?.blockers?.length,
    calibrationHitRate: calibrationMetrics.bestHitRate ?? calibrationMetrics.oneXTwoHitRate,
    calibrationSample,
    trustPenalty: Number(contextSignals?.trustPenalty || 0)
      + Number(dynamicHadReferenceCandidate?.recentReviewPenalty || 0) * 100,
    materialConflict: withholdForHadMarketConflict,
    formalRecommendation: false,
  });
  const officialHadReferenceTrust = officialHadReferenceConfidence.score;
  const officialHadReferenceTier = confidenceReferenceTier(
    officialHadReferenceConfidence,
    usesInputSparseMarketFallback ? "input-sparse-dynamic-evidence" : "dynamic-evidence",
  );
  if (useOfficialHadReference) {
    const officialHadReferenceLabel = simpleOutcomeLabel(match, officialHadReferenceCode);
    publicUnifiedBestBase = {
      ...unifiedBestBase,
      oddsPoolCode: "HAD",
      handicapLine: "0",
      tipCode: officialHadReferenceCode,
      tipLabel: {
        zh: `\u52a8\u6001\u8bc1\u636e\u53c2\u8003 ${officialHadReferenceLabel?.zh || officialHadReferenceCode}`,
        en: `Dynamic-evidence reference: ${officialHadReferenceLabel?.en || officialHadReferenceCode}`,
      },
      odds: officialHadReferenceOdds,
      trustScore: officialHadReferenceTrust,
      confidence: officialHadReferenceConfidence,
      recommendationAction: "reference",
      recommendationTier: officialHadReferenceTier,
      explanation: {
        zh: `\u591a\u56e0\u7d20\u6b63\u5f0f\u95e8\u69db\u672a\u901a\u8fc7\uff0c\u4f46\u4ecd\u7ed9\u51fa\u52a8\u6001\u8bc1\u636e\u65b9\u5411 ${officialHadReferenceLabel?.zh || officialHadReferenceCode}\uff1a\u878d\u5408\u540e\u6982\u7387 ${pct(officialHadReferenceProbability)}%\uff0c\u5b98\u65b9\u53bb\u6c34\u652f\u6301 ${pct(officialHadReferenceMarketProbability)}%\u3002SP \u53ea\u7528\u4e8e\u76d8\u9762\u548c\u4ef7\u503c\u5c55\u793a\uff0c\u4e0d\u6539\u5199\u65b9\u5411\u3001\u4e0d\u5355\u72ec\u538b\u4f4e\u7f6e\u4fe1\u5ea6\u3002`,
        en: `The formal multi-factor gate did not pass, but a dynamic-evidence direction remains visible: ${officialHadReferenceLabel?.en || officialHadReferenceCode}, with ${pct(officialHadReferenceProbability)}% fused probability and ${pct(officialHadReferenceMarketProbability)}% official de-vigged support. SP is retained for market/value display and neither rewrites direction nor caps confidence by itself.`,
      },
      riskTags: [
        ...(withholdForHadMarketConflict
          ? [{ zh: "\u6a21\u578b\u4e0e\u5b98\u65b9\u5e02\u573a\u51b2\u7a81", en: "Model and official market conflict" }]
          : [{ zh: "\u6b63\u5f0f\u8bc1\u636e\u95e8\u69db\u672a\u901a\u8fc7", en: "Formal evidence gate not passed" }]),
        { zh: "\u52a8\u6001\u591a\u56e0\u7d20\u878d\u5408", en: "Dynamic multi-factor fusion" },
        { zh: "SP \u4e0d\u5355\u72ec\u5b9a\u7f6e\u4fe1", en: "SP-independent confidence" },
      ],
      resultStatus: "PENDING",
    };
  }
  const liveOfficialOdds = officialOddsForLivePrediction(match, publicUnifiedBestBase);
  const liveRecommendationCandidate = evaluateLiveRecommendation(
    publicUnifiedBestBase,
    liveOfficialOdds,
    selectedIsHhad ? hhadLine : 0
  );
  const livePublicationEvidence = buildLivePublicationEvidence(match, publicUnifiedBestBase, predictionNowMs());
  const liveRecommendation = livePublicationEvidence
    ? liveRecommendationCandidate
    : {
        ...liveRecommendationCandidate,
        eligible: false,
        grade: "WITHHOLD",
        blockers: [...new Set([
          ...(liveRecommendationCandidate.blockers || []),
          "live-publication-evidence-missing",
        ])],
      };
  const unifiedBest = {
    ...publicUnifiedBestBase,
    liveRecommendationAction: liveRecommendation.eligible ? "recommend" : "withhold",
    liveRecommendationTier: liveRecommendation.eligible
      ? `live-${String(liveRecommendation.grade || "c").toLowerCase()}`
      : "live-withhold",
    liveRecommendation,
    livePublicationEvidence,
  };

  let oneXTwoReference = markPredictionAsUnifiedReference(
    oneXTwo,
    hasHad
      ? "胜平负作为统一后验验证项展示，页面主推只看 AI 精选这一条。"
      : "普通胜平负未开售，胜平负不生成主推；本场按让球胜平负输出主结论。",
    hasHad
      ? "1X2 is shown as a unified-posterior reference; the page main pick is the BEST row only."
      : "Standard 1X2 is not on sale, so no raw 1X2 main pick is created; the verdict uses HHAD."
  );
  const oneXTwoMustFollowUnifiedDecision = !selectedIsHhad
    || !hasHad
    || oneXTwoReference?.tipCode === "WATCH";
  if (oneXTwoMustFollowUnifiedDecision) {
    oneXTwoReference = {
      ...oneXTwoReference,
      oddsPoolCode: selectedIsHhad ? "HHAD" : "HAD",
      handicapLine: selectedIsHhad ? hhadLine : "0",
      tipCode: selected.code,
      tipLabel: {
        zh: `参考 ${selected.label.zh}`,
        en: `Reference: ${selected.label.en}`,
      },
      odds: Number.isFinite(selected.odds) ? selected.odds : 0,
      resultStatus: resultStatus(match, selected.code, selectedIsHhad ? "HHAD" : "1X2"),
    };
  }
  if (withholdForHadMarketConflict) {
    oneXTwoReference = {
      ...oneXTwoReference,
      tipCode: "WATCH",
      tipLabel: {
        zh: "暂不推荐：模型与官方市场冲突",
        en: "No pick: model and official market conflict",
      },
      odds: 0,
      trustScore: clamp(Number(oneXTwoReference?.trustScore || 35), 20, 38),
      recommendationAction: "reference",
      recommendationTier: "market-conflict-watch",
      explanation: publicUnifiedBestBase.explanation,
      riskTags: publicUnifiedBestBase.riskTags,
      resultStatus: "PENDING",
    };
  }
  if (useOfficialHadReference) {
    oneXTwoReference = {
      ...oneXTwoReference,
      oddsPoolCode: "HAD",
      handicapLine: "0",
      tipCode: officialHadReferenceCode,
      tipLabel: publicUnifiedBestBase.tipLabel,
      odds: publicUnifiedBestBase.odds,
      trustScore: publicUnifiedBestBase.trustScore,
      recommendationAction: "reference",
      recommendationTier: officialHadReferenceTier,
      explanation: publicUnifiedBestBase.explanation,
      riskTags: publicUnifiedBestBase.riskTags,
      resultStatus: "PENDING",
    };
  }
  const goalsReference = markPredictionAsUnifiedReference(
    goals,
    "进球数只解释比分形态，不作为本场主推兜底。",
    "Goals explain the score shape only; they are not a backup main pick."
  );
  const unifiedProbabilityModel = {
    ...probabilityModel,
    version: "unified-poisson-bayes-v75",
    oneXTwo: {
      ...(probabilityModel.oneXTwo || {}),
      unifiedPosterior: asPercentTriplet(unified.hadPosterior),
    },
    handicap: probabilityModel.handicap ? {
      ...probabilityModel.handicap,
      unifiedPosterior: asPercentTriplet(unified.hhadPosterior),
    } : probabilityModel.handicap,
    unifiedPosterior: {
      version: "v75-execution-clock-competition-metadata-draw-aware-evidence-shrinkage-argmax",
      generatedAt: predictionNowIso(),
      selectedMarket: selected.market,
      selectedCode: selected.code,
      selectedLabelZh: selected.label.zh,
      selectedHandicapLine: selectedIsHhad ? hhadLine : "0",
      selectedProbability: pct1(selected.probability),
      selectedGap: pct1(selected.gap),
      selectedPosteriorScore: Number(selected.posteriorScore.toFixed(4)),
      selectedRecentReviewAdjustment: Number((selected.recentReviewAdjustment || 0).toFixed(4)),
      selectedRecentReviewReasons: selected.recentReviewReasons || [],
      selectionPolicy: selected.selectionPolicy || "unified-posterior",
      marketSafeguard: unified.marketSafeguard,
      multiFactorEvidence,
      recommendationAction: isActionable ? "recommend" : "reference",
      outcomeConflict: unified.outcomeConflict || selected.outcomeConflict || null,
      marketLaneAudit: unified.marketLaneAudit,
      marketBaseline: unified.marketBaseline,
      inputFallback: unified.inputFallback,
      evidenceShrinkage: unified.hadPosteriorDiagnostics,
      dataQuality: Number(unifiedDataQuality(contextSignals).toFixed(3)),
      worldCupGroupContext: contextSignals?.worldCupGroupContext || null,
      scoreShape: {
        top1: scoreShape.top1,
        selectedScore,
        top1Code: scoreShape.top1Code,
        top1HhadCode: scoreShape.top1HhadCode,
        drawHeavy: scoreShape.drawHeavy,
        lowScoreHeavy: scoreShape.lowScoreHeavy,
        top3: scoreShape.top3,
      },
      candidates: unified.candidates.slice(0, 6).map((candidate) => ({
        market: candidate.market,
        code: candidate.code,
        probability: pct1(candidate.probability),
        odds: Number.isFinite(candidate.odds) ? candidate.odds : 0,
        gap: pct1(candidate.gap),
        posteriorScore: Number(candidate.posteriorScore.toFixed(4)),
        worldCupContextBoost: candidate.worldCupContextBoost,
        recentReviewAdjustment: candidate.recentReviewAdjustment,
        recentReviewReasons: candidate.recentReviewReasons,
        multiFactorEvidence: candidate.multiFactorEvidence ? {
          version: candidate.multiFactorEvidence.version,
          eligible: candidate.multiFactorEvidence.eligible,
          grade: candidate.multiFactorEvidence.grade,
          market: candidate.multiFactorEvidence.market,
          code: candidate.multiFactorEvidence.code,
          handicapLine: candidate.multiFactorEvidence.handicapLine,
          odds: candidate.multiFactorEvidence.odds,
          evidenceScore: candidate.multiFactorEvidence.evidenceScore,
          threshold: candidate.multiFactorEvidence.threshold,
          modelProbability: candidate.multiFactorEvidence.modelProbability,
          marketProbability: candidate.multiFactorEvidence.marketProbability,
          probabilityEdge: candidate.multiFactorEvidence.probabilityEdge,
          expectedValue: candidate.multiFactorEvidence.expectedValue,
          modelGap: candidate.multiFactorEvidence.modelGap,
          dataQuality: candidate.multiFactorEvidence.dataQuality,
          components: candidate.multiFactorEvidence.components,
          penalty: candidate.multiFactorEvidence.penalty,
          supportingFactors: candidate.multiFactorEvidence.supportingFactors,
          blockers: candidate.multiFactorEvidence.blockers,
          diagnostics: candidate.multiFactorEvidence.diagnostics,
        } : null,
      })),
      confidence: officialHadReferenceConfidence,
      policy: `${MULTI_FACTOR_POLICY_VERSION}; dynamic-market-elo-poisson-form-context-fusion; confidence-is-price-independent; formal-picks-require-independent-evidence; market-disagreement-blocks-promotion; references-remain-visible`,
    },
    publicDecision: {
      tipCode: useOfficialHadReference ? officialHadReferenceCode : selected.code,
      directionPublished: true,
      formalRecommendation: !useOfficialHadReference && isActionable,
      reason: withholdForHadMarketConflict
        ? "material-official-market-direction-conflict-reference"
        : useOfficialHadReference
          ? "nonformal-dynamic-evidence-reference"
        : "unified-posterior-decision",
    },
  };

  return {
    predictions: [oneXTwoReference, goalsReference, unifiedBest],
    probabilityModel: unifiedProbabilityModel,
    projectedScore: scoreShape.top1
      ? { home: selectedScore.home, away: selectedScore.away, probability: selectedScore.probability }
      : context.score,
  };
}

function handicapSemanticPickLabel(match, code, line) {
  return {
    "1": { zh: "让胜", en: "HHAD Home" },
    X: { zh: "让平", en: "HHAD Draw" },
    "2": { zh: "让负", en: "HHAD Away" },
  }[code] || { zh: "让球", en: "Handicap reference" };
}

function pickValueProfile(pick, modelProbabilities, marketProbabilities) {
  const code = pick?.[0];
  const odds = Number(pick?.[2]);
  const modelProbability = outcomeProbabilityForCode(modelProbabilities, code);
  const marketProbability = outcomeProbabilityForCode(marketProbabilities, code);
  const probabilityEdge = Number.isFinite(modelProbability) && Number.isFinite(marketProbability)
    ? modelProbability - marketProbability
    : null;
  const expectedValue = Number.isFinite(modelProbability) && Number.isFinite(odds)
    ? modelProbability * odds - 1
    : null;

  return {
    code,
    odds,
    modelProbability,
    marketProbability,
    probabilityEdge,
    expectedValue,
  };
}

function matchVolatilityProfile(match) {
  return require("./competitionModelContext.cjs").competitionProfile(match);
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function sideRankNumber(match, side) {
  const direct = side === "home" ? match.homeRank : match.awayRank;
  const priorRank = worldCupPriorSide(match, side)?.fifaRank;
  const rank = firstFiniteNumber(direct, externalFifaRank(match, side), priorRank);
  return rank && rank > 0 ? rank : null;
}

function sideAdvanceProbability(match, side) {
  const value = Number(worldCupPriorSide(match, side)?.groupOutlook?.advanceProbability);
  return Number.isFinite(value) ? clamp(value, 0, 100) : null;
}

function sideGroupOutlook(match, side) {
  return worldCupPriorSide(match, side)?.groupOutlook || null;
}

function sideWorldCupGroupProfile(match, side) {
  const team = worldCupPriorSide(match, side);
  const outlook = team?.groupOutlook || null;
  if (!team || !outlook) return null;
  const projectedRank = firstFiniteNumber(outlook.projectedRank, outlook.rank);
  const projectedPoints = firstFiniteNumber(outlook.projectedPoints, outlook.points);
  const goalDiff = firstFiniteNumber(outlook.goalDiff);
  const goalsFor = firstFiniteNumber(outlook.goalsFor);
  const goalsAgainst = firstFiniteNumber(outlook.goalsAgainst);
  const advanceProbability = sideAdvanceProbability(match, side);
  const groupWinProbability = firstFiniteNumber(outlook.groupWinProbability, outlook.firstProbability);
  const strength = firstFiniteNumber(team.modelStrengthNormalized);

  return {
    side,
    key: team.key || null,
    nameZh: team.nameZh || null,
    nameEn: team.nameEn || null,
    group: team.group || outlook.group || null,
    fifaRank: firstFiniteNumber(team.fifaRank),
    projectedRank,
    projectedPoints,
    goalDiff,
    goalsFor,
    goalsAgainst,
    advanceProbability,
    groupWinProbability,
    strength,
  };
}

function sideFormSnapshot(match, side) {
  return match.formSnapshot?.[side] || null;
}

function formNeedPressure(match, side) {
  const form = sideFormSnapshot(match, side);
  if (!form || Number(form.sampleSize || 0) < 3) return 0;
  const ppg = Number(form.pointsPerMatch);
  const goalDiff = Number(form.goalDiffAvg);
  const restDays = Number(form.restDays);
  let pressure = 0;
  if (Number.isFinite(ppg)) {
    if (ppg < 0.95) pressure += 5;
    else if (ppg < 1.25) pressure += 3;
    else if (ppg > 2.05) pressure -= 2;
  }
  if (Number.isFinite(goalDiff)) {
    if (goalDiff < -0.55) pressure += 3;
    else if (goalDiff > 0.85) pressure -= 1;
  }
  if (Number.isFinite(restDays) && restDays <= 3) pressure += 2;
  return clamp(pressure, -4, 10);
}

function groupNeedPressure(advanceProbability) {
  const value = Number(advanceProbability);
  if (!Number.isFinite(value)) return 0;
  if (value < 35) return 8;
  if (value < 50) return 5;
  if (value > 92) return -2;
  if (value > 80) return -1;
  return 0;
}

function groupRankNeedPressure(projectedRank) {
  const rank = Number(projectedRank);
  if (!Number.isFinite(rank)) return 0;
  if (rank >= 4) return 8;
  if (rank >= 3) return 5;
  if (rank <= 1) return -1;
  return 1;
}

function groupGoalDiffPressure(goalDiff) {
  const diff = Number(goalDiff);
  if (!Number.isFinite(diff)) return 0;
  if (diff <= -1.5) return 10;
  if (diff <= -0.5) return 7;
  if (diff < 0) return 4;
  if (diff >= 2) return -2;
  if (diff >= 1) return -1;
  return 1;
}

function groupPointsNeedPressure(projectedPoints) {
  const points = Number(projectedPoints);
  if (!Number.isFinite(points)) return 0;
  if (points < 3) return 5;
  if (points < 4) return 3;
  if (points >= 5.5) return -2;
  if (points >= 4.8) return -1;
  return 0;
}

function groupStageNeedProfile(profile) {
  if (!profile) return null;
  const advanceNeed = groupNeedPressure(profile.advanceProbability);
  const rankNeed = groupRankNeedPressure(profile.projectedRank);
  const pointsNeed = groupPointsNeedPressure(profile.projectedPoints);
  const goalDiffPressure = groupGoalDiffPressure(profile.goalDiff);
  const groupWin = Number(profile.groupWinProbability);
  const firstPlaceNeed = Number.isFinite(groupWin) && groupWin < 18 && Number(profile.advanceProbability) >= 45 ? 2 : 0;
  const rawNeed = 50 + advanceNeed + rankNeed + pointsNeed + goalDiffPressure * 0.55 + firstPlaceNeed;
  const needScore = Math.round(clamp(rawNeed, 34, 82));
  const attackPush = Number(clamp((needScore - 50) * 0.28 + Math.max(0, goalDiffPressure) * 0.34, -4, 12).toFixed(2));
  const safeButNotClinched = Number(profile.advanceProbability) >= 88 && Number(profile.projectedRank) <= 2;
  const rotationRisk = Number((
    Number(profile.advanceProbability) >= 94
    && Number(profile.projectedRank) === 1
    && Number(profile.groupWinProbability) >= 70
    && Number(profile.goalDiff) >= 2
      ? 0.12
      : safeButNotClinched ? 0.04 : 0
  ).toFixed(2));
  const reasons = [];
  if (advanceNeed > 0) reasons.push("qualification-pressure");
  if (rankNeed > 1) reasons.push("projected-rank-pressure");
  if (pointsNeed > 0) reasons.push("points-pressure");
  if (goalDiffPressure >= 4) reasons.push("goal-difference-pressure");
  if (safeButNotClinched) reasons.push("advance-probability-cushion");
  if (!reasons.length) reasons.push("balanced-group-context");

  return {
    ...profile,
    needScore,
    goalDiffPressure,
    attackPush,
    rotationRisk,
    reasons,
  };
}

function worldCupGroupStageContext(match) {
  const home = groupStageNeedProfile(sideWorldCupGroupProfile(match, "home"));
  const away = groupStageNeedProfile(sideWorldCupGroupProfile(match, "away"));
  if (!home && !away) return null;

  const sameGroup = Boolean(home?.group && away?.group && home.group === away.group);
  const homeNeed = Number(home?.needScore || 50);
  const awayNeed = Number(away?.needScore || 50);
  const homeGoalDiffPressure = Number(home?.goalDiffPressure || 0);
  const awayGoalDiffPressure = Number(away?.goalDiffPressure || 0);
  const needEdge = homeNeed - awayNeed;
  const goalDiffPressureEdge = homeGoalDiffPressure - awayGoalDiffPressure;
  const rankGap = Number.isFinite(Number(home?.projectedRank)) && Number.isFinite(Number(away?.projectedRank))
    ? Number(away.projectedRank) - Number(home.projectedRank)
    : null;
  const pointsGap = Number.isFinite(Number(home?.projectedPoints)) && Number.isFinite(Number(away?.projectedPoints))
    ? Number((Number(home.projectedPoints) - Number(away.projectedPoints)).toFixed(2))
    : null;
  const goalDiffGap = Number.isFinite(Number(home?.goalDiff)) && Number.isFinite(Number(away?.goalDiff))
    ? Number((Number(home.goalDiff) - Number(away.goalDiff)).toFixed(2))
    : null;
  const advanceGap = Number.isFinite(Number(home?.advanceProbability)) && Number.isFinite(Number(away?.advanceProbability))
    ? Number((Number(home.advanceProbability) - Number(away.advanceProbability)).toFixed(1))
    : null;
  const groupWinGap = Number.isFinite(Number(home?.groupWinProbability)) && Number.isFinite(Number(away?.groupWinProbability))
    ? Number((Number(home.groupWinProbability) - Number(away.groupWinProbability)).toFixed(1))
    : null;
  const totalIntentBoost = sameGroup
    ? Number(clamp(
      (Math.max(0, homeNeed - 50) + Math.max(0, awayNeed - 50)) / 5
        + (Math.max(0, homeGoalDiffPressure) + Math.max(0, awayGoalDiffPressure)) / 7,
      0,
      9
    ).toFixed(2))
    : 0;
  const bothComfortable = sameGroup
    && Number(home?.advanceProbability) >= 82
    && Number(away?.advanceProbability) >= 82
    && Number(home?.projectedRank) <= 2
    && Number(away?.projectedRank) <= 2;
  const mustChase = sameGroup && (homeNeed >= 63 || awayNeed >= 63);
  const drawBias = Number(clamp(
    (bothComfortable ? 0.018 : 0)
      - (mustChase ? 0.026 : 0)
      - totalIntentBoost * 0.002,
    -0.04,
    0.025
  ).toFixed(3));
  const goalDiffPushSide = sameGroup && Math.max(homeGoalDiffPressure, awayGoalDiffPressure) >= 6
    ? (homeGoalDiffPressure >= awayGoalDiffPressure + 2 ? "home" : awayGoalDiffPressure >= homeGoalDiffPressure + 2 ? "away" : null)
    : null;
  const homeStrength = Number(home?.strength);
  const awayStrength = Number(away?.strength);
  const strengthEdge = Number.isFinite(homeStrength) && Number.isFinite(awayStrength)
    ? homeStrength - awayStrength
    : null;
  let marginPushSide = goalDiffPushSide;
  if (goalDiffPushSide === "home" && Number.isFinite(strengthEdge) && strengthEdge < -0.12) marginPushSide = "away";
  if (goalDiffPushSide === "away" && Number.isFinite(strengthEdge) && strengthEdge > 0.12) marginPushSide = "home";
  const handicapPushCode = marginPushSide === "home" ? "1" : marginPushSide === "away" ? "2" : null;

  return {
    version: "world-cup-group-stage-v1",
    source: "world-cup-prior-group-outlook",
    sameGroup,
    group: sameGroup ? home?.group || away?.group || null : null,
    home,
    away,
    gaps: {
      rank: rankGap,
      projectedPoints: pointsGap,
      goalDiff: goalDiffGap,
      advanceProbability: advanceGap,
      groupWinProbability: groupWinGap,
    },
    effects: {
      needEdge,
      goalDiffPressureEdge,
      totalIntentBoost,
      drawBias,
      goalDiffPushSide,
      marginPushSide,
      handicapPushCode,
      strengthEdge: Number.isFinite(strengthEdge) ? Number(strengthEdge.toFixed(4)) : null,
      homeAttackPush: Number(home?.attackPush || 0),
      awayAttackPush: Number(away?.attackPush || 0),
      reasons: [
        ...(sameGroup ? ["same-group-match"] : ["cross-group-or-stage"]),
        ...(mustChase ? ["must-chase-points"] : []),
        ...(goalDiffPushSide ? ["goal-difference-push"] : []),
        ...(marginPushSide && goalDiffPushSide && marginPushSide !== goalDiffPushSide ? ["open-space-favorite-margin"] : []),
        ...(bothComfortable ? ["draw-can-be-acceptable"] : []),
      ],
    },
  };
}

function rankingPressureProfile(match) {
  const homeRank = sideRankNumber(match, "home");
  const awayRank = sideRankNumber(match, "away");
  const homeAdvance = sideAdvanceProbability(match, "home");
  const awayAdvance = sideAdvanceProbability(match, "away");
  const groupContext = worldCupGroupStageContext(match);
  const rankGap = homeRank !== null && awayRank !== null ? awayRank - homeRank : null;
  const rankPressure = Number.isFinite(rankGap) ? clamp(rankGap / 80, -1, 1) : 0;
  const homeRankPressure = rankPressure * 11;
  const awayRankPressure = -rankPressure * 11;
  const homeNeed = formNeedPressure(match, "home") + groupNeedPressure(homeAdvance) + Math.max(-3, Number(groupContext?.home?.needScore || 50) - 50) * 0.58;
  const awayNeed = formNeedPressure(match, "away") + groupNeedPressure(awayAdvance) + Math.max(-3, Number(groupContext?.away?.needScore || 50) - 50) * 0.58;
  const home = Math.round(clamp(50 + homeRankPressure + homeNeed, 25, 82));
  const away = Math.round(clamp(50 + awayRankPressure + awayNeed, 25, 82));
  const maxPressure = Math.max(home, away);
  const edge = home - away;
  const homeRotationRisk = Number(groupContext?.home?.rotationRisk || 0);
  const awayRotationRisk = Number(groupContext?.away?.rotationRisk || 0);
  const rotationRisk = Number((Math.max(homeRotationRisk, awayRotationRisk)).toFixed(2));
  const dataQuality = homeRank !== null || awayRank !== null || Number.isFinite(homeAdvance) || Number.isFinite(awayAdvance)
    ? "rank-connected"
    : "estimated";
  const reasons = [];
  if (Number.isFinite(rankGap)) reasons.push(`rank-gap:${rankGap}`);
  if (Number.isFinite(homeAdvance) || Number.isFinite(awayAdvance)) reasons.push("group-outlook");
  if (groupContext?.effects?.reasons?.length) reasons.push(...groupContext.effects.reasons);
  if (formNeedPressure(match, "home") || formNeedPressure(match, "away")) reasons.push("recent-form-pressure");
  if (!reasons.length) reasons.push("no-connected-table-rank");

  return {
    version: "ranking-pressure-v2",
    source: dataQuality === "rank-connected" ? "rank/form/world-cup-prior" : "model-estimated",
    dataQuality,
    homeRank,
    awayRank,
    rankGap,
    homeAdvanceProbability: homeAdvance,
    awayAdvanceProbability: awayAdvance,
    homeProjectedRank: groupContext?.home?.projectedRank ?? null,
    awayProjectedRank: groupContext?.away?.projectedRank ?? null,
    homeProjectedPoints: groupContext?.home?.projectedPoints ?? null,
    awayProjectedPoints: groupContext?.away?.projectedPoints ?? null,
    homeGoalDiff: groupContext?.home?.goalDiff ?? null,
    awayGoalDiff: groupContext?.away?.goalDiff ?? null,
    home,
    away,
    maxPressure,
    edge,
    rotationRisk,
    worldCupGroupContext: groupContext,
    reasons,
  };
}

function formAttackIntent(match, side) {
  const form = sideFormSnapshot(match, side);
  if (!form || Number(form.sampleSize || 0) < 3) return 50;
  const goalsFor = Number(form.goalsForAvg);
  const goalsAgainst = Number(form.goalsAgainstAvg);
  const over25 = Number(form.over25Rate);
  const btts = Number(form.bttsRate);
  let score = 50;
  if (Number.isFinite(goalsFor)) score += (goalsFor - 1.25) * 12;
  if (Number.isFinite(goalsAgainst)) score += (goalsAgainst - 1.1) * 4;
  if (Number.isFinite(over25)) score += (over25 - 0.5) * 9;
  if (Number.isFinite(btts)) score += (btts - 0.5) * 6;
  return clamp(score, 34, 72);
}

function attackIntentProfile(match, homeLambda, awayLambda, over25Probability, bttsProbability, rankingPressure) {
  const homeForm = formAttackIntent(match, "home");
  const awayForm = formAttackIntent(match, "away");
  const homePressure = Number(rankingPressure?.home || 50);
  const awayPressure = Number(rankingPressure?.away || 50);
  const groupContext = rankingPressure?.worldCupGroupContext || worldCupGroupStageContext(match);
  const homeGroupPush = Number(groupContext?.effects?.homeAttackPush || 0);
  const awayGroupPush = Number(groupContext?.effects?.awayAttackPush || 0);
  const groupTotalIntentBoost = Number(groupContext?.effects?.totalIntentBoost || 0);
  const totalLambda = Number(homeLambda) + Number(awayLambda);
  const home = Math.round(clamp(
    50
      + (Number(homeLambda) - 1.2) * 18
      + (homeForm - 50) * 0.34
      + (homePressure - 50) * 0.14
      + homeGroupPush,
    28,
    78
  ));
  const away = Math.round(clamp(
    50
      + (Number(awayLambda) - 1.1) * 18
      + (awayForm - 50) * 0.34
      + (awayPressure - 50) * 0.14
      + awayGroupPush,
    28,
    78
  ));
  const total = Math.round(clamp(
    (home + away) / 2
      + (totalLambda - 2.35) * 10
      + (Number(over25Probability) - 0.5) * 20
      + (Number(bttsProbability) - 0.5) * 12
      + groupTotalIntentBoost,
    30,
    82
  ));
  const edge = home - away;
  const lambdaTotalAdjustment = Number(clamp((total - 50) * 0.0035 + groupTotalIntentBoost * 0.002, -0.07, 0.105).toFixed(3));
  const over25Shift = Number(clamp((total - 50) * 0.0018 + groupTotalIntentBoost * 0.0012, -0.025, 0.04).toFixed(3));
  const bttsShift = Number(clamp((Math.min(home, away) - 48) * 0.0015, -0.018, 0.022).toFixed(3));
  const dataQuality = match.formSnapshot?.sampleSize >= 6 || rankingPressure?.dataQuality === "rank-connected"
    ? "model-with-form-rank"
    : "model-estimated";
  const reasons = [];
  if (Number.isFinite(totalLambda)) reasons.push(`lambda-total:${totalLambda.toFixed(2)}`);
  if (match.formSnapshot?.sampleSize >= 3) reasons.push("recent-attack-form");
  if (rankingPressure?.dataQuality === "rank-connected") reasons.push("ranking-pressure");
  if (groupContext?.sameGroup) reasons.push("world-cup-group-context");
  if (groupContext?.effects?.goalDiffPushSide) reasons.push("goal-difference-push");

  return {
    version: "attack-intent-v2",
    source: "lambda/form/ranking-pressure/world-cup-group",
    dataQuality,
    home,
    away,
    total,
    edge,
    groupTotalIntentBoost,
    homeGroupPush,
    awayGroupPush,
    lambdaTotalAdjustment,
    over25Shift,
    bttsShift,
    reasons: reasons.length ? reasons : ["baseline-lambda-only"],
  };
}

function disciplineProfile(match, probabilities, hhadProbabilities, attackIntent, rankingPressure) {
  const profile = matchVolatilityProfile(match);
  const refereeCards = Number(match.externalSignals?.referee?.cardsPerMatch);
  const refereeBase = Number.isFinite(refereeCards) && refereeCards > 0
    ? clamp(refereeCards, 2, 6.5)
    : profile.isJapan
      ? 2.8
      : profile.isInternational
        ? 3.6
        : 3.4;
  const topSideGap = probabilities
    ? Math.max(probabilities.home || 0, probabilities.away || 0, probabilities.draw || 0) - Math.min(probabilities.home || 0, probabilities.away || 0, probabilities.draw || 0)
    : 0;
  const closeGame = probabilities ? Math.abs(Number(probabilities.home) - Number(probabilities.away)) < 0.08 : false;
  const handicapSplit = hhadProbabilities
    ? Math.abs(Number(hhadProbabilities.home || 0) - Number(hhadProbabilities.away || 0))
    : 0;
  const pressureGap = Math.abs(Number(rankingPressure?.edge || 0));
  const totalIntent = Number(attackIntent?.total || 50);
  const rawYellow = refereeBase
    + (totalIntent - 50) * 0.035
    + (closeGame ? 0.35 : 0)
    + Math.max(0, 0.28 - topSideGap) * 1.1
    + pressureGap * 0.012
    + (handicapSplit > 0.28 ? 0.18 : 0);
  const totalYellow = Number(clamp(rawYellow, 2.1, 6.2).toFixed(1));
  const homeYellowShare = clamp(
    0.5
      + (Number(rankingPressure?.away || 50) - Number(rankingPressure?.home || 50)) / 180
      + (Number(probabilities?.away || 0) - Number(probabilities?.home || 0)) * 0.18,
    0.34,
    0.66
  );
  const homeYellow = Number((totalYellow * homeYellowShare).toFixed(1));
  const awayYellow = Number((totalYellow - homeYellow).toFixed(1));
  const redRisk = Number(clamp(
    0.055
      + Math.max(0, totalYellow - 3.4) * 0.033
      + (closeGame ? 0.025 : 0)
      + (totalIntent >= 66 ? 0.02 : 0),
    0.03,
    0.24
  ).toFixed(3));
  const homeRedRisk = Number((redRisk * homeYellowShare).toFixed(3));
  const awayRedRisk = Number((redRisk - homeRedRisk).toFixed(3));
  const totalFouls = Number(clamp(18 + totalYellow * 2 + (closeGame ? 2 : 0) + (totalIntent - 50) * 0.08, 16, 34).toFixed(1));
  const homeFouls = Number((totalFouls * homeYellowShare).toFixed(1));
  const awayFouls = Number((totalFouls - homeFouls).toFixed(1));
  const trustPenalty = (redRisk >= 0.17 ? 4 : redRisk >= 0.12 ? 2 : 0)
    + (totalYellow >= 5.2 ? 2 : 0);
  const dataQuality = Number.isFinite(refereeCards) && refereeCards > 0 ? "referee-connected" : "model-estimated";

  return {
    version: "discipline-cards-v1",
    source: dataQuality === "referee-connected" ? "referee/form/model" : "model-estimated",
    dataQuality,
    expectedYellowCards: { home: homeYellow, away: awayYellow, total: totalYellow },
    redCardRisk: { home: homeRedRisk, away: awayRedRisk, total: redRisk },
    expectedFouls: { home: homeFouls, away: awayFouls, total: totalFouls },
    foulPressure: Math.round(clamp(45 + (totalFouls - 20) * 2.4 + (totalYellow - 3.2) * 4, 28, 82)),
    trustPenalty,
    reasons: [
      dataQuality === "referee-connected" ? "referee-card-average" : "estimated-referee-profile",
      closeGame ? "close-game" : "normal-gap",
      totalIntent >= 62 ? "high-tempo" : totalIntent <= 42 ? "low-tempo" : "neutral-tempo",
    ],
  };
}

function hasNumericSignal(...values) {
  return values.some((value) => Number.isFinite(Number(value)));
}

function signalText(value) {
  return normText(value).trim();
}

function webConsensusSignal(match) {
  const signal = match?.externalSignals?.webConsensus;
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) return null;
  return signal;
}

function webConsensusDisplayEligible(signal) {
  return Boolean(
    signal
    && signal.version === "web-consensus-v2"
    && signal.usableForModel === false
    && signal.usableForRisk === false
    && signal.eligibleForNumericModel === false
    && signal.eligibleForFormalQuality === false
    && signal.eligibleForStrategyGate === false
    && (signal.eligibleForRiskDisplay === true || signal.modelUse?.eligibleForRiskDisplay === true)
  );
}

function webConsensusModelEligible() {
  // Deliberately impossible: Web/RAG evidence is never a numeric feature,
  // formal quality input, strategy gate, risk penalty or promotion signal.
  return false;
}

function webConsensusDirectionCode(value) {
  const text = normText(value).toLowerCase();
  if (["1", "home", "home_win", "home-win", "主胜"].includes(text)) return "1";
  if (["x", "draw", "tie", "平", "平局"].includes(text)) return "X";
  if (["2", "away", "away_win", "away-win", "客胜"].includes(text)) return "2";
  return null;
}

function webConsensusGoalsCode(value) {
  const text = normText(value).toLowerCase();
  if (["over", "over25", "over2.5", "o2.5", "大", "大2.5"].includes(text)) return "over25";
  if (["under", "under25", "under2.5", "u2.5", "小", "小2.5"].includes(text)) return "under25";
  return null;
}

function probabilityLeaderCode(probabilities) {
  const rows = [
    ["1", Number(probabilities?.home || 0)],
    ["X", Number(probabilities?.draw || 0)],
    ["2", Number(probabilities?.away || 0)],
  ].filter(([, value]) => Number.isFinite(value));
  if (!rows.length) return null;
  return rows.sort((a, b) => b[1] - a[1])[0][0];
}

function webConsensusContext(match, probabilities, hhadProbabilities, over25Probability, bttsProbability) {
  const signal = webConsensusSignal(match);
  if (!signal) return { available: false };

  const consensus = signal.consensus || {};
  const features = signal.features || {};
  const confidence = clamp(Number(signal.quality?.confidence ?? consensus.confidence ?? 0), 0, 1);
  const sourceCount = Number(signal.quality?.sourceCount || signal.sources?.length || 0);
  const eligibleForRiskDisplay = webConsensusDisplayEligible(signal) && confidence >= 0.35;
  const usableForRisk = false;
  const usableForModel = false;
  const directionCode = webConsensusDirectionCode(consensus.oneXTwo || consensus.direction || features.oneXTwo);
  const goalsCode = webConsensusGoalsCode(consensus.goals || features.goalsConsensus);
  const handicapView = normText(consensus.handicapView || features.handicapView);
  const drawRisk = normText(consensus.drawRisk || features.drawRisk).toLowerCase();
  const modelLeader = probabilityLeaderCode(probabilities);
  const modelAgree = typeof features.modelAgree === "boolean"
    ? features.modelAgree
    : directionCode && modelLeader
      ? directionCode === modelLeader
      : null;
  const favoriteMayNotCover = Boolean(features.favoriteMayNotCover || handicapView === "favorite-win-not-cover");
  const reasons = ["web-rag-advisory-only"];
  if (signal.conflictFreeze === true || signal.modelUse?.conflictFreeze === true) reasons.push("web-conflict-frozen");

  return {
    available: true,
    advisoryOnly: true,
    eligibleForRiskDisplay,
    eligibleForNumericModel: false,
    eligibleForFormalQuality: false,
    eligibleForStrategyGate: false,
    eligibleForPromotion: false,
    usableForModel,
    usableForRisk,
    confidence: Number(confidence.toFixed(3)),
    sourceCount,
    directionCode,
    goalsCode,
    handicapView,
    drawRisk: drawRisk || null,
    modelLeader,
    modelAgree,
    favoriteMayNotCover,
    lambdaTotalAdjustment: 0,
    over25Shift: 0,
    bttsShift: 0,
    riskPenalty: 0,
    buckets: Array.isArray(signal.buckets) ? signal.buckets.slice(0, 12) : [],
    reasons,
  };
}

function dataGapProfile(match, context) {
  const signals = match.externalSignals || {};
  const preMatchQuality = signals.preMatch?.quality || null;
  const fiveHundred = signals.fiveHundred || {};
  const referee = signals.referee || {};
  const expectedGoals = signals.expectedGoals || {};
  const lineups = signals.confirmedLineup || signals.projectedRoster || signals.lineups || {};
  const injuries = signals.injuries || {};
  const weather = signals.weather || {};
  const webConsensus = signals.webConsensus || {};
  const standingConnected = Boolean(
    match.homeRank
    || match.awayRank
    || fiveHundred.rank?.home?.fifaRank
    || fiveHundred.rank?.away?.fifaRank
    || match.worldCupPrior
    || signals.worldCupPrior
  );
  const groupOrStageConnected = Boolean(
    context?.rankingPressure?.homeAdvanceProbability !== null
    || context?.rankingPressure?.awayAdvanceProbability !== null
    || fiveHundred.futureSchedule?.home
    || fiveHundred.futureSchedule?.away
    || signals.buyEndTime
  );
  const refereeConnected = Boolean(hasNumericSignal(referee.cardsPerMatch, referee.penaltiesPerMatch));
  const lineupConnected = Boolean(
    signalText(lineups.summary?.zh || lineups.summary?.en)
    || signalText(lineups.homeFormation)
    || signalText(lineups.awayFormation)
  );
  const injuryConnected = Boolean(
    signalText(injuries.summary?.zh || injuries.summary?.en)
    || (Array.isArray(injuries.home) && injuries.home.length)
    || (Array.isArray(injuries.away) && injuries.away.length)
  );
  const xgConnected = Boolean(
    hasNumericSignal(expectedGoals.homeXg, expectedGoals.awayXg, expectedGoals.homeXga, expectedGoals.awayXga)
    || signalText(expectedGoals.summary?.zh || expectedGoals.summary?.en)
  );
  const weatherConnected = Boolean(
    signalText(weather.summary?.zh || weather.summary?.en)
    || signalText(weather.condition?.zh || weather.condition?.en)
    || hasNumericSignal(weather.temperatureC, weather.windKph, weather.precipitationMm)
  );
  const webConsensusAdvisoryAvailable = Boolean(
    webConsensus
    && typeof webConsensus === "object"
    && webConsensusDisplayEligible(webConsensus)
    && (webConsensus.consensus || webConsensus.features || webConsensus.summary)
  );
  const officialOddsConnected = Boolean(sanitizeOdds(match.odds) || sanitizeHandicapOdds(match));
  const externalMarketConnected = Boolean(
    fiveHundred.europeOdds?.currentAverage
    || fiveHundred.asianHandicap?.currentAverageLine
    || signals.externalOdds?.odds1
  );
  const teamCardHistoryConnected = Boolean(
    signals.discipline?.homeCardsPerMatch
    || signals.discipline?.awayCardsPerMatch
    || fiveHundred.discipline?.home
    || fiveHundred.discipline?.away
  );

  const missing = [];
  const addMissing = (key, zh, en, severity, weight) => {
    missing.push({ key, zh, en, severity, weight });
  };
  if (!refereeConnected) addMissing("referee-card-source", "缺少真实裁判牌数", "Missing referee card source", "medium", 9);
  if (!teamCardHistoryConnected) addMissing("team-card-history", "缺少球队黄红牌历史", "Missing team card history", "medium", 8);
  if (!standingConnected) addMissing("league-table-rank", "缺少积分/排名结构", "Missing league table/ranking structure", "high", 13);
  if (!groupOrStageConnected) addMissing("motivation-stage", "缺少赛程阶段/战意结构", "Missing stage/motivation structure", "medium", 7);
  if (!lineupConnected && !injuryConnected) addMissing("injury-lineup", "缺少伤停首发", "Missing injuries/projected XI", "high", 14);
  if (!xgConnected) addMissing("xg-xga", "缺少赛前 xG/xGA", "Missing pre-match xG/xGA", "medium", 8);
  if (!weatherConnected) addMissing("weather-pitch", "缺少天气/场地", "Missing weather/pitch signal", "low", 4);
  if (!officialOddsConnected && !externalMarketConnected) addMissing("market-source", "缺少盘口校验源", "Missing market validation source", "high", 15);

  const preMatchMissing = Array.isArray(preMatchQuality?.missing)
    ? preMatchQuality.missing.filter((item) => item?.key !== "webConsensus" && item?.key !== "web-consensus").map((item) => ({
      key: item.key,
      zh: item.zh,
      en: item.en,
      severity: item.severity || "medium",
      weight: Number(item.weight || 0),
    }))
    : [];
  // An empty temporal missing list is meaningful: evidence that has not
  // reached its normal publication window must not fall back to the legacy
  // static "missing injuries/projected XI" penalty.
  const effectiveMissing = preMatchQuality ? preMatchMissing : missing;
  const missingWeight = effectiveMissing.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const fallbackCoverageScore = Math.round(clamp(100 - missingWeight, 25, 100));
  const coverageScore = Number.isFinite(Number(preMatchQuality?.score))
    ? Math.round(clamp(Number(preMatchQuality.score), 0, 100))
    : fallbackCoverageScore;
  const severeMissingCount = Number.isFinite(Number(preMatchQuality?.severeMissingCount))
    ? Number(preMatchQuality.severeMissingCount)
    : effectiveMissing.filter((item) => item.severity === "high").length;
  const sourceQuality = preMatchQuality?.sourceQuality || (coverageScore >= 78 && severeMissingCount === 0
    ? "high"
    : coverageScore >= 58 && severeMissingCount <= 1
      ? "medium"
      : "low");
  const fallbackTrustPenalty = (sourceQuality === "low" ? 5 : sourceQuality === "medium" ? 2 : 0)
    + (teamCardHistoryConnected ? 0 : 1)
    + (refereeConnected ? 0 : 1)
    + (!lineupConnected && !injuryConnected ? 2 : 0);
  const trustPenalty = Number.isFinite(Number(preMatchQuality?.trustPenalty))
    ? Number(preMatchQuality.trustPenalty)
    : fallbackTrustPenalty;
  const preMatchConnected = preMatchQuality?.connected || {};
  const connected = {
    referee: preMatchConnected.referee ?? refereeConnected,
    teamCards: preMatchConnected.teamCards ?? teamCardHistoryConnected,
    standings: preMatchConnected.motivation ?? standingConnected,
    motivationStage: preMatchConnected.motivation ?? groupOrStageConnected,
    lineup: preMatchConnected.lineup ?? lineupConnected,
    injuries: preMatchConnected.injuries ?? injuryConnected,
    xg: preMatchConnected.xg ?? xgConnected,
    weather: preMatchConnected.weather ?? weatherConnected,
    // Kept for response compatibility, but permanently false in the formal
    // connected map. Web/RAG availability is reported under advisory instead.
    webConsensus: false,
    officialOdds: preMatchConnected.market ?? officialOddsConnected,
    externalMarket: preMatchConnected.market ?? externalMarketConnected,
  };

  return {
    version: preMatchQuality ? "data-gap-profile-v51-temporal-evidence" : "data-gap-profile-v1",
    coverageScore,
    sourceQuality,
    severeMissingCount,
    trustPenalty,
    connected,
    advisory: {
      webConsensus: {
        available: webConsensusAdvisoryAvailable,
        eligibleForRiskDisplay: webConsensusAdvisoryAvailable,
        eligibleForNumericModel: false,
        eligibleForFormalQuality: false,
        eligibleForStrategyGate: false,
        weight: 0,
      },
    },
    missing: effectiveMissing,
    primaryGaps: effectiveMissing.slice(0, 4).map((item) => item.key),
    ...(preMatchQuality ? {
      preMatchQuality: {
        version: preMatchQuality.version,
        score: preMatchQuality.score,
        sourceQuality: preMatchQuality.sourceQuality,
        lowQuality: (preMatchQuality.lowQuality || []).filter((key) => key !== "webConsensus" && key !== "web-consensus"),
        missing: preMatchMissing,
        notYetPublishable: Array.isArray(preMatchQuality.notYetPublishable)
          ? preMatchQuality.notYetPublishable
          : [],
        components: preMatchQuality.components || {},
      },
    } : {}),
    note: sourceQuality === "low"
      ? "high-variance-data-gap"
      : sourceQuality === "medium"
        ? "partial-context"
        : "context-covered",
  };
}

function preMatchContextSignals(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability) {
  const rankingPressure = rankingPressureProfile(match);
  const attackIntent = attackIntentProfile(match, homeLambda, awayLambda, over25Probability, bttsProbability, rankingPressure);
  const discipline = disciplineProfile(match, probabilities, hhadProbabilities, attackIntent, rankingPressure);
  const dataGaps = dataGapProfile(match, { rankingPressure, attackIntent, discipline });
  const webConsensus = webConsensusContext(match, probabilities, hhadProbabilities, over25Probability, bttsProbability);
  const attackPenalty = attackIntent.total <= 42 ? 2 : 0;
  const pressurePenalty = rankingPressure.maxPressure >= 70 ? 2 : 0;
  const rotationPenalty = rankingPressure.rotationRisk >= 0.3 ? 1 : 0;
  return {
    version: dataGaps.version.startsWith("data-gap-profile-v5") ? "pre-match-context-v51-temporal-evidence" : "pre-match-context-v1",
    rankingPressure,
    worldCupGroupContext: rankingPressure.worldCupGroupContext || null,
    attackIntent,
    discipline,
    dataGaps,
    webConsensus,
    trustPenalty: discipline.trustPenalty + attackPenalty + pressurePenalty + rotationPenalty + Number(dataGaps.trustPenalty || 0),
  };
}

function rawGoalProbabilities(homeLambda, awayLambda) {
  const totalLambda = Number(homeLambda) + Number(awayLambda);
  return {
    totalLambda,
    over25: clamp(1 - [0, 1, 2].reduce((sum, goals) => sum + poissonProbability(totalLambda, goals), 0), 0, 1),
    btts: clamp((1 - Math.exp(-Number(homeLambda))) * (1 - Math.exp(-Number(awayLambda))), 0, 1),
  };
}

function applyContextLambdaAdjustment(homeLambda, awayLambda, contextSignals) {
  const attackAdjustment = Number(contextSignals?.attackIntent?.lambdaTotalAdjustment || 0);
  const totalAdjustment = attackAdjustment;
  if (!Number.isFinite(totalAdjustment) || Math.abs(totalAdjustment) < 0.001) {
    return {
      homeLambda,
      awayLambda,
      applied: false,
      totalAdjustment: 0,
      homeAdjustment: 0,
      awayAdjustment: 0,
      reason: null,
    };
  }
  const total = Math.max(0.1, Number(homeLambda) + Number(awayLambda));
  const baseHomeShare = clamp(Number(homeLambda) / total, 0.24, 0.76);
  const intentBias = clamp(Number(contextSignals?.attackIntent?.edge || 0) / 260, -0.035, 0.035);
  const homeShare = clamp(baseHomeShare + intentBias, 0.24, 0.76);
  const homeAdjustment = totalAdjustment * homeShare;
  const awayAdjustment = totalAdjustment - homeAdjustment;
  return {
    homeLambda: clamp(Number(homeLambda) + homeAdjustment, 0.25, 3.8),
    awayLambda: clamp(Number(awayLambda) + awayAdjustment, 0.2, 3.6),
    applied: true,
    totalAdjustment: Number(totalAdjustment.toFixed(3)),
    homeAdjustment: Number(homeAdjustment.toFixed(3)),
    awayAdjustment: Number(awayAdjustment.toFixed(3)),
    homeShare: Number(homeShare.toFixed(3)),
    reason: Math.abs(attackAdjustment) >= 0.001 ? "attack-intent" : null,
  };
}

function applyContextGoalAdjustments(over25Probability, bttsProbability, contextSignals) {
  const attack = contextSignals?.attackIntent || {};
  const discipline = contextSignals?.discipline || {};
  const overShift = Number(attack.over25Shift || 0);
  const bttsShift = Number(attack.bttsShift || 0);
  const redRisk = Number(discipline.redCardRisk?.total || 0);
  const cardDrag = redRisk >= 0.17 ? -0.008 : redRisk >= 0.12 ? -0.004 : 0;
  const over25 = clamp(Number(over25Probability) + overShift + cardDrag, 0.05, 0.93);
  const btts = clamp(Number(bttsProbability) + bttsShift, 0.05, 0.9);
  return {
    over25,
    btts,
    meta: {
      applied: Math.abs(overShift) >= 0.001 || Math.abs(bttsShift) >= 0.001 || cardDrag !== 0,
      over25Shift: Number((over25 - Number(over25Probability)).toFixed(3)),
      bttsShift: Number((btts - Number(bttsProbability)).toFixed(3)),
      cardDrag,
      webOver25Shift: 0,
      webBttsShift: 0,
      reasons: [
        ...(Math.abs(overShift) >= 0.001 || Math.abs(bttsShift) >= 0.001 ? ["attack-intent"] : []),
        ...(cardDrag ? ["red-card-volatility"] : []),
      ],
    },
  };
}

function evaluateOneXTwoGate(context) {
  const {
    match,
    pick,
    probabilities,
    modelProbabilities,
    hadHandicapRelationships,
    probabilityGap,
    modelProbabilityGap,
    riskTags,
    analystSelection,
    predictionHealth,
    marketType = "1X2",
  } = context;

  const code = pick[0];
  const odds = pick[2];
  const profile = matchVolatilityProfile(match);
  const isSidePick = code === "1" || code === "2";
  const valueProfile = pickValueProfile(pick, modelProbabilities || probabilities, probabilities);
  const pickProbability = Number.isFinite(valueProfile.modelProbability)
    ? valueProfile.modelProbability
    : outcomeProbabilityForCode(probabilities, code);
  const marketPickProbability = Number.isFinite(valueProfile.marketProbability)
    ? valueProfile.marketProbability
    : outcomeProbabilityForCode(probabilities, code);
  const probabilityEdge = Number.isFinite(valueProfile.probabilityEdge) ? valueProfile.probabilityEdge : 0;
  const expectedValue = Number.isFinite(valueProfile.expectedValue) ? valueProfile.expectedValue : null;
  const handicapRelationship = hadHandicapRelationships?.[code] || null;
  const handicapSupport = conditionalHandicapSupportForPick(hadHandicapRelationships, code);
  const profileKey = predictionProfileKey(match);
  const dynamicGate = profileCalibration(match).gate || {};
  const oddsBucket = predictionOddsBucket(odds);
  const strategyGate = strategyGateForPrediction(match, marketType, code, oddsBucket);
  const drawHealth = predictionHealth?.oneXTwo?.byTip?.X;
  const drawHasPositiveSample = isHotBucket(drawHealth, 3, 0.5);
  const directionCooldown = Boolean(
    isCoolingBucket(predictionHealth?.oneXTwo?.byTip?.[code])
    || isCoolingBucket(predictionHealth?.oneXTwo?.byProfile?.[profileKey])
    || isCoolingBucket(predictionHealth?.oneXTwo?.byOddsBucket?.[oddsBucket])
    || (isSidePick && odds <= 1.7 && isCoolingBucket(predictionHealth?.oneXTwo?.lowSpSide))
    || (code === "1" && isCoolingBucket(predictionHealth?.homeFavorite))
    || (code === "2" && isCoolingBucket(predictionHealth?.awayFavorite))
  );
  const profileMarketCooldown = isCoolingBucket(predictionHealth?.byMarketProfile?.[`1X2:${profileKey}`]);
  const oneXTwoCooldown = Boolean(isCoolingBucket(predictionHealth?.byMarket?.["1X2"]) || profileMarketCooldown || directionCooldown);
  const hasSelectionDisagreement = Boolean(analystSelection.isContrarian || analystSelection.hasValueDisagreement);
  const reasons = [];

  if (hasSelectionDisagreement) reasons.push("market-disagreement");
  if (code === "X") reasons.push("draw-is-not-single-pick");
  if (!isSidePick) reasons.push("no-side-pick");
  if (isSidePick && handicapSupport === null) reasons.push("missing-handicap-confirmation");
  if (isSidePick && handicapSupport !== null && handicapSupport < 0.32) reasons.push("weak-handicap-confirmation");
  if (probabilities.draw >= 0.3) reasons.push("draw-pressure");
  if (probabilityGap < 0.1) reasons.push("thin-market-edge");
  if (modelProbabilityGap < 0.07) reasons.push("thin-model-edge");
  if (probabilityEdge < 0.015) reasons.push("no-model-market-edge");
  if (expectedValue !== null && expectedValue < 0.01) reasons.push("negative-or-flat-ev");
  if (riskTags.length > 0) reasons.push("risk-tags");
  if (isSidePick && odds <= 1.25) reasons.push("low-odds-no-value");
  if (profile.isInternational && isSidePick && odds <= 1.35) reasons.push("international-low-odds");
  if (profile.isJapan && isSidePick && odds <= 1.75) reasons.push("jleague-volatile-favorite");
  if (directionCooldown) reasons.push("direction-hit-rate-cooldown");
  if (oneXTwoCooldown) reasons.push("recent-1x2-hit-rate-cooldown");
  if (code === "X" && oneXTwoCooldown && !drawHasPositiveSample) reasons.push("draw-no-positive-sample");
  if (isSidePick && oneXTwoCooldown && odds <= 2.1) reasons.push("side-short-form-brake");
  if (dynamicGate.reason && dynamicGate.reason !== "neutral-profile") reasons.push(dynamicGate.reason);
  if (strategyGate.reasons.length) reasons.push(...strategyGate.reasons);

  const fragileInternationalFavorite = profile.isInternational
    && isSidePick
    && odds <= 1.35
    && (
      oneXTwoCooldown
      || directionCooldown
      || pickProbability < 0.64
      || handicapSupport === null
      || handicapSupport < 0.42
    );
  if (fragileInternationalFavorite) reasons.push("fragile-international-favorite");

  const minPickProbability = (oneXTwoCooldown ? 0.58 : 0.52) + Number(dynamicGate.minProbabilityBoost || 0) + Number(strategyGate.minProbabilityBoost || 0);
  const minProbabilityGap = (oneXTwoCooldown ? 0.14 : 0.08) + Number(dynamicGate.minModelGapBoost || 0) + Number(strategyGate.minModelGapBoost || 0);
  const minModelGap = (oneXTwoCooldown ? 0.1 : 0.06) + Number(dynamicGate.minModelGapBoost || 0) + Number(strategyGate.minModelGapBoost || 0);
  const minHandicapSupport = (oneXTwoCooldown ? 0.38 : 0.3) + Number(dynamicGate.minHandicapSupportBoost || 0) + Number(strategyGate.minHandicapSupportBoost || 0);
  const minValueEdge = (odds <= 1.45 ? 0.045 : odds <= 1.7 ? 0.032 : 0.02)
    + Number(dynamicGate.minModelGapBoost || 0) * 0.35
    + Number(strategyGate.minModelGapBoost || 0) * 0.35;
  const minExpectedValue = odds <= 1.45 ? 0.045 : odds <= 1.7 ? 0.03 : 0.015;
  const maxDrawPressure = oneXTwoCooldown ? 0.32 : 0.36;
  const maxGateRiskTags = Math.max(0, (Number.isFinite(dynamicGate.maxRiskTags) ? Number(dynamicGate.maxRiskTags) : 3) + Number(strategyGate.maxRiskTagsDelta || 0));

  const strongSidePick = isSidePick
    && !hasSelectionDisagreement
    && pickProbability >= minPickProbability
    && probabilityGap >= minProbabilityGap
    && modelProbabilityGap >= minModelGap
    && probabilityEdge >= minValueEdge
    && (expectedValue === null || expectedValue >= minExpectedValue)
    && handicapSupport !== null
    && handicapSupport >= minHandicapSupport
    && probabilities.draw <= maxDrawPressure
    && odds > 1.08
    && odds <= 2.35
    && riskTags.length <= maxGateRiskTags
    && !(profile.isInternational && odds <= 1.75 && oneXTwoCooldown)
    && !(profile.isJapan && odds <= 2.1 && oneXTwoCooldown);

  const stricterProfileOk = (!profile.isInternational || odds > 1.35 || (pickProbability >= 0.58 && handicapSupport >= 0.3))
    && (!profile.isJapan || odds > 1.75 || (pickProbability >= 0.56 && handicapSupport >= 0.36));

  const valueSidePick = isSidePick
    && !hasSelectionDisagreement
    && pickProbability >= (oneXTwoCooldown ? 0.56 : 0.49)
    && probabilityGap >= (oneXTwoCooldown ? 0.12 : 0.065)
    && modelProbabilityGap >= (oneXTwoCooldown ? 0.095 : 0.055)
    && probabilityEdge >= Math.max(0.026, minValueEdge - 0.006)
    && (expectedValue === null || expectedValue >= Math.max(0.02, minExpectedValue))
    && handicapSupport !== null
    && handicapSupport >= (oneXTwoCooldown ? 0.38 : 0.34)
    && probabilities.draw <= 0.34
    && odds > 1.25
    && odds <= 2.65
    && riskTags.length <= Math.max(1, maxGateRiskTags - 1)
    && !(profile.isInternational && odds <= 1.34)
    && !(profile.isInternational && odds <= 1.75 && oneXTwoCooldown)
    && !(profile.isJapan && odds <= 2.1 && oneXTwoCooldown);

  const tier = hasSelectionDisagreement
    ? "watch"
    : !fragileInternationalFavorite && strongSidePick && stricterProfileOk
    ? "strong"
    : !fragileInternationalFavorite && valueSidePick
      ? "value-side"
      : "watch";

  return {
    promote: tier !== "watch",
    tier,
    reasons,
    handicapSupport,
    handicapRelationship,
    valueProfile: {
      ...valueProfile,
      modelProbability: Number.isFinite(pickProbability) ? pickProbability : null,
      marketProbability: Number.isFinite(marketPickProbability) ? marketPickProbability : null,
      probabilityEdge,
      expectedValue,
    },
    profile,
  };
}

function evaluateGoalsGate(match, goalsTip, goalsProbability, over25Probability, bttsProbability, predictionHealth) {
  const reasons = [];
  const edge = Math.abs(over25Probability - 0.5);
  const profile = matchVolatilityProfile(match);
  const profileKey = predictionProfileKey(match);
  const directionCooldown = Boolean(
    isCoolingBucket(predictionHealth?.goals?.byTip?.[goalsTip])
    || isCoolingBucket(predictionHealth?.goals?.byProfile?.[profileKey])
  );
  const goalsCooldown = Boolean(isCoolingBucket(predictionHealth?.byMarket?.GOALS) || directionCooldown);
  const under25IsHot = goalsTip === "U2.5" && isHotBucket(predictionHealth?.under25, 3, 0.6);
  let minProbability = goalsCooldown ? 0.68 : 0.63;
  let minEdge = goalsCooldown ? 0.18 : 0.13;
  const dynamicGate = profileCalibration(match).gate || {};
  const strategyGate = strategyGateForPrediction(match, "GOALS", goalsTip, "unknown");
  if (Number(dynamicGate.goalsMinBoost || 0) > 0) {
    minProbability += Number(dynamicGate.goalsMinBoost || 0);
    minEdge += Number(dynamicGate.goalsMinBoost || 0) * 0.5;
    reasons.push("dynamic-goals-cooldown");
  }
  if (Number(strategyGate.goalsMinBoost || strategyGate.minProbabilityBoost || 0) > 0) {
    const boost = Number(strategyGate.goalsMinBoost || strategyGate.minProbabilityBoost || 0);
    minProbability += boost;
    minEdge += boost * 0.5;
    reasons.push(...strategyGate.reasons);
  }

  if (under25IsHot) {
    minProbability -= 0.04;
    minEdge -= 0.03;
    reasons.push("under25-hot-sample");
  }

  if (profile.isInternational && goalsTip === "O2.5") {
    minProbability += 0.05;
    minEdge += 0.03;
    reasons.push("international-over-goals-noise");
  }

  if (profile.isJapan && goalsTip === "O2.5") {
    minProbability += 0.03;
    minEdge += 0.02;
    reasons.push("jleague-over-goals-noise");
  }

  if (goalsProbability < minProbability) reasons.push("thin-goal-edge");
  if (edge < minEdge) reasons.push("near-coin-flip-total");
  if (bttsProbability >= 0.46 && bttsProbability <= 0.56) reasons.push("btts-borderline");
  if (directionCooldown) reasons.push("direction-goals-hit-rate-cooldown");
  if (goalsCooldown) reasons.push("recent-goals-hit-rate-cooldown");

  return {
    promote: goalsProbability >= minProbability
      && edge >= minEdge
      && !(bttsProbability >= 0.46 && bttsProbability <= 0.56)
      && (goalsTip === "U2.5" || goalsProbability >= minProbability + 0.04),
    reasons,
  };
}

function selectValueAwareOneXTwo(match, picks, modelProbabilities, marketProbabilities, hadHandicapRelationships) {
  const modelLeader = picks[0];
  const profiles = picks.map((pick, index) => {
    const value = pickValueProfile(pick, modelProbabilities, marketProbabilities);
    const handicapRelationship = hadHandicapRelationships?.[pick[0]] || null;
    const handicapSupport = conditionalHandicapSupportForPick(hadHandicapRelationships, pick[0]);
    return {
      pick,
      code: pick[0],
      modelRank: index + 1,
      handicapSupport,
      handicapRelationship,
      ...value,
      score: (
        Math.max(0, Number(value.probabilityEdge || 0)) * 2.2
        + Math.max(0, Math.min(Number(value.expectedValue || 0), 0.28)) * 0.85
        + Number(value.modelProbability || 0) * 0.18
        + (index === 0 ? 0.025 : 0)
        - (pick[0] === "X" ? 0.015 : 0)
      ),
    };
  });
  const marketLeaderProfile = [...profiles]
    .sort((a, b) => Number(b.marketProbability || 0) - Number(a.marketProbability || 0))[0];
  const marketLeader = marketLeaderProfile?.pick || modelLeader;
  const modelLeaderProfile = profiles.find((profile) => profile.code === modelLeader?.[0]) || profiles[0];
  const leaderGap = Number(marketLeaderProfile?.marketProbability || 0)
    - Math.max(...profiles.filter((item) => item.code !== marketLeader?.[0]).map((item) => Number(item.marketProbability || 0)), 0);
  const leaderHandicapSupport = conditionalHandicapSupportForPick(hadHandicapRelationships, marketLeader?.[0]);
  const weakHandicapSupport = marketLeader?.[0] !== "X" && leaderHandicapSupport !== null && leaderHandicapSupport < 0.42;
  const modelLeaderProbability = Number(modelLeader?.[1] || 0);

  const qualifiesValue = (profile) => {
    const edge = Number(profile.probabilityEdge || 0);
    const ev = Number(profile.expectedValue || 0);
    const modelProbability = Number(profile.modelProbability || 0);
    const odds = Number(profile.odds || 0);
    const isDraw = profile.code === "X";
    const isSide = profile.code === "1" || profile.code === "2";
    const maxModelDiscount = modelLeaderProbability - modelProbability;
    const drawRerouteSupported = !isDraw
      || profile.modelRank === 1
      || (modelProbability >= 0.31 && maxModelDiscount <= 0.04);
    const minEdge = isDraw ? 0.018 : odds <= 1.45 ? 0.05 : odds <= 1.7 ? 0.035 : 0.026;
    const minEv = isDraw ? 0.035 : odds <= 1.45 ? 0.05 : odds <= 1.7 ? 0.032 : 0.025;
    const minProbability = isDraw ? 0.245 : odds <= 1.7 ? 0.44 : 0.29;
    return edge >= minEdge
      && ev >= minEv
      && modelProbability >= minProbability
      && drawRerouteSupported
      && maxModelDiscount <= (isDraw ? 0.12 : 0.14)
      && odds >= (isDraw ? 2.65 : 1.32)
      && odds <= (isDraw ? 6.8 : 5.8)
      && (!isSide || profile.handicapSupport === null || profile.handicapSupport >= 0.34);
  };

  // The 1X2 probability layer owns the published direction. Price/EV may
  // confirm that direction or downgrade it to watch, but it must never replace
  // the most likely outcome with a lower-probability side (especially a long
  // priced draw).
  const valueCandidate = profiles
    .filter((profile) => profile.modelRank === 1)
    .filter(qualifiesValue)
    .sort((a, b) => b.score - a.score)[0];

  if (valueCandidate) {
    const changesModelLeader = valueCandidate.code !== modelLeader?.[0];
    const isContrarian = valueCandidate.code !== marketLeader?.[0];
    const edgeTextZh = `${pct(valueCandidate.probabilityEdge || 0)} 个百分点`;
    const edgeTextEn = `${pct(valueCandidate.probabilityEdge || 0)} points`;
    const evText = `${Math.round(Number(valueCandidate.expectedValue || 0) * 100)}%`;
    return {
      pick: valueCandidate.pick,
      mode: isContrarian
        ? (valueCandidate.code === "X" ? "value-draw" : "value-underdog")
        : "value-market",
      isContrarian,
      hasValueDisagreement: changesModelLeader || isContrarian,
      valueProfile: valueCandidate,
      disagreementProfile: changesModelLeader ? modelLeaderProfile : null,
      reason: {
        zh: changesModelLeader
          ? `价值换向：候选方向仍有独立模型概率支撑，且比市场隐含概率高约 ${edgeTextZh}、EV 约 ${evText}；换向依据是校准概率和价值证据，不是更低 SP。盘口分歧会进入门槛并可降级为观察。`
          : isContrarian
          ? `价值修正：不直接跟随最低 SP，候选方向模型概率比市场隐含概率高约 ${edgeTextZh}，EV 约 ${evText}，因此只按价值方向观察。`
          : `价值确认：独立模型先给出该方向，市场只是同步支持；模型概率比市场隐含概率高约 ${edgeTextZh}，EV 约 ${evText}，通过价值边际检查。`,
        en: changesModelLeader
          ? `Value reroute: the candidate retains independent-model support and is about ${edgeTextEn} above market-implied probability with EV around ${evText}. The reroute comes from calibrated probability and value evidence, never from a lower SP; market disagreement remains a gate that can downgrade the lane to watch.`
          : isContrarian
          ? `Value adjustment: not blindly following the lowest SP. The candidate is about ${edgeTextEn} above market-implied probability with EV around ${evText}, so it is kept as value-watch.`
          : `Value confirmation: the independent model gives this direction first and the market only agrees; model probability is about ${edgeTextEn} above market-implied probability with EV around ${evText}.`,
      },
    };
  }

  const drawProfile = profiles.find((profile) => profile.code === "X");
  const drawIsLive = drawProfile
    && Number(drawProfile.modelProbability || 0) >= 0.27
    && Number(drawProfile.probabilityEdge || 0) >= 0.012
    && Number(drawProfile.expectedValue || 0) >= 0.025
    && Number(marketLeaderProfile?.marketProbability || 0) <= 0.46
    && (Number(modelLeader?.[1] || 0) - Number(drawProfile.modelProbability || 0)) <= 0.16;

  if (drawIsLive && (weakHandicapSupport || leaderGap <= 0.13)) {
    return {
      pick: modelLeader,
      mode: "value-draw",
      isContrarian: false,
      hasValueDisagreement: true,
      valueProfile: modelLeaderProfile,
      disagreementProfile: drawProfile,
      reason: {
        zh: `防平分歧：最低 SP 方向让球确认不足，平局模型概率较市场高约 ${pct(drawProfile.probabilityEdge || 0)} 个百分点；该信号只提示防平，不改写模型首位方向。`,
        en: `Draw disagreement: the lowest-SP side lacks handicap confirmation, while draw model probability is about ${pct(drawProfile.probabilityEdge || 0)} points above market. This flags draw cover only and does not rewrite the model leader.`,
      },
    };
  }

  return {
    pick: modelLeader,
    mode: "model-leader",
    isContrarian: false,
    hasValueDisagreement: false,
    valueProfile: modelLeaderProfile,
    reason: {
      zh: "模型首位：当前没有发现足够强的冷门/防平价值边际；若该方向只是最低 SP 但边际不足，后续风控会降级为观察。",
      en: "Model lead: no strong draw/upset value edge was found. If this is merely the lowest-SP side without value edge, the gate will downgrade it to watch.",
    },
  };
}

function selectAnalystOneXTwo(match, picks, probabilities, hadHandicapRelationships) {
  const marketLeader = picks[0];
  const runnerUp = picks[1];
  const drawPick = pickByCode(picks, "X");
  const homePick = pickByCode(picks, "1");
  const awayPick = pickByCode(picks, "2");
  const leaderGap = marketLeader[1] - runnerUp[1];
  const leaderHandicapSupport = conditionalHandicapSupportForPick(hadHandicapRelationships, marketLeader[0]);
  const weakHandicapSupport = marketLeader[0] !== "X" && leaderHandicapSupport !== null && leaderHandicapSupport < 0.42;
  const drawIsLive = drawPick && drawPick[1] >= 0.27 && marketLeader[1] <= 0.46 && (marketLeader[1] - drawPick[1]) <= 0.16;
  const underdogPick = [homePick, awayPick]
    .filter(Boolean)
    .filter((pick) => pick[0] !== marketLeader[0])
    .sort((a, b) => b[1] - a[1])[0];
  const underdogHandicapSupport = underdogPick
    ? conditionalHandicapSupportForPick(hadHandicapRelationships, underdogPick[0])
    : null;
  const underdogIsLive = underdogPick
    && marketLeader[1] <= 0.44
    && underdogPick[1] >= 0.30
    && (marketLeader[1] - underdogPick[1]) <= 0.12
    && (underdogHandicapSupport === null || underdogHandicapSupport >= 0.4);

  if (drawIsLive && (weakHandicapSupport || leaderGap <= 0.13)) {
    return {
      pick: drawPick,
      mode: "value-draw",
      isContrarian: true,
      reason: {
        zh: `专业修正：不机械追随最低 SP。本场胜平负首选与平局差距不大，平局去水支持率约 ${pct(probabilities.draw)}%，且让球盘对正路支持不足，稳妥方向降为防平观察。`,
        en: `Analyst adjustment: not blindly following the lowest SP. The draw is live at about ${pct(probabilities.draw)}% normalized support, and handicap support for the market favorite is weak.`,
      },
    };
  }

  if (underdogIsLive && weakHandicapSupport) {
    return {
      pick: underdogPick,
      mode: "value-underdog",
      isContrarian: true,
      reason: {
        zh: `专业修正：正路热度与让球盘存在分歧，非热门方向去水支持率约 ${pct(underdogPick[1])}%，本场更适合做冷门价值观察。`,
        en: `Analyst adjustment: the favorite is not fully confirmed by handicap support; the non-favorite side is kept as value-watch.`,
      },
    };
  }

  return {
    pick: marketLeader,
    mode: "market-leader",
    isContrarian: false,
    reason: {
      zh: `市场主线：最低 SP 方向与去水支持率一致，暂未触发足够强的冷门或防平修正。`,
      en: `Market lead: the lowest-SP side remains aligned with normalized support; no strong draw/upset adjustment was triggered.`,
    },
  };
}

function chooseNarrative(match, salt, builders) {
  const rand = seeded(`${match.sourceMatchId}-${salt}`);
  const idx = Math.min(builders.length - 1, Math.floor(rand() * builders.length));
  return builders[idx]();
}

function buildBestNarrative(match, context) {
  const {
    oneXTwo,
    bestShouldWatch,
    analystSelection,
    bestIsSteady,
    bestHasWeakHandicap,
    bestHasThinEdge,
    riskTags,
    probabilityGap,
    modelProbabilityGap,
    bestHandicapSupport,
    bestHandicapRelationship,
    totalLambda,
    over25Probability,
    bttsProbability,
    score,
    hhadProbabilities
  } = context;
  const tipZh = oneXTwo.tipLabel.zh;
  const tipEn = oneXTwo.tipLabel.en;
  const marketGapZh = `${pct(probabilityGap)} 个百分点`;
  const modelGapZh = `${pct(modelProbabilityGap)} 个百分点`;
  const marketGapEn = `${pct(probabilityGap)} points`;
  const modelGapEn = `${pct(modelProbabilityGap)} points`;
  const conditionalCover = bestHandicapRelationship?.conditionalCoverProbability;
  const conditionalHandicapDraw = bestHandicapRelationship?.conditionalHandicapDrawProbability;
  const conditionalWinNotCover = bestHandicapRelationship?.conditionalWinNotCoverProbability;
  const isSideHandicapRead = oneXTwo.tipCode === "1" || oneXTwo.tipCode === "2";
  const handicapZh = bestHandicapSupport === null
    ? "让球盘暂时不足以验证净胜球条件"
    : isSideHandicapRead
      ? `让球条件兼容支持约 ${pct(bestHandicapSupport)}%（穿盘 ${pct(conditionalCover || 0)}% / 让平 ${pct(conditionalHandicapDraw || 0)}% / 赢球不穿 ${pct(conditionalWinNotCover || 0)}%）`
      : `平局方向在当前让球线下的条件兼容支持约 ${pct(bestHandicapSupport)}%`;
  const handicapEn = bestHandicapSupport === null
    ? "conditional handicap confirmation is unavailable"
    : isSideHandicapRead
      ? `conditional handicap support is about ${pct(bestHandicapSupport)}% (cover ${pct(conditionalCover || 0)}% / handicap draw ${pct(conditionalHandicapDraw || 0)}% / win without cover ${pct(conditionalWinNotCover || 0)}%)`
      : `draw compatibility at the current handicap is about ${pct(bestHandicapSupport)}%`;
  const riskTextZh = riskTags.length ? riskTags.map((tag) => tag.zh).join("、") : "暂无明显风险标签";
  const riskTextEn = riskTags.length ? riskTags.map((tag) => tag.en).join(", ") : "no major risk tag";
  const hhadTextZh = hhadProbabilities
    ? `让球盘去水支持约 主胜 ${pct(hhadProbabilities.home)}% / 平 ${pct(hhadProbabilities.draw)}% / 客胜 ${pct(hhadProbabilities.away)}%`
    : "让球盘暂无可用去水支持率";
  const hhadTextEn = hhadProbabilities
    ? `handicap normalized support is home ${pct(hhadProbabilities.home)}% / draw ${pct(hhadProbabilities.draw)}% / away ${pct(hhadProbabilities.away)}%`
    : "handicap normalized support is unavailable";
  const goalsZh = `进球侧：比分热区 ${score.home}-${score.away}，总期望 ${totalLambda.toFixed(2)}，大 2.5 约 ${pct(over25Probability)}%，双方进球约 ${pct(bttsProbability)}%。`;
  const goalsEn = `Goals: score heat zone ${score.home}-${score.away}, total xG ${totalLambda.toFixed(2)}, over 2.5 about ${pct(over25Probability)}%, BTTS about ${pct(bttsProbability)}%.`;
  const lateRiskZh = `临场复核：${riskTextZh}。如果赛前 SP 继续降赔但让球支持不上来，仍按参考处理。`;
  const lateRiskEn = `Late check: ${riskTextEn}. If SP shortens without handicap confirmation, keep this as reference-only.`;
  const watchTipZh = analystSelection.isContrarian
    ? analystSelection.mode === "value-draw"
      ? `防平参考 ${tipZh}`
      : `冷门参考 ${tipZh}`
    : tipZh;
  const watchTipEn = analystSelection.isContrarian
    ? analystSelection.mode === "value-draw"
      ? `draw-cover reference ${tipEn}`
      : `upset reference ${tipEn}`
    : tipEn;

  if (bestShouldWatch) {
    const subtype = bestHasWeakHandicap ? "weak-handicap" : bestHasThinEdge ? "thin-edge" : "stacked-risk";
    const explanation = chooseNarrative(match, `best-watch-${subtype}`, [
      () => ({
        zh: analystSelection.isContrarian
          ? `这场先不把${watchTipZh}包装成主推。它的意义是提醒防平/防冷，主盘与让球盘还没有形成完整共振。`
          : `这场先不把${watchTipZh}包装成高可信。HAD 方向虽然清楚，但${handicapZh}，盘口确认不够完整。`,
        en: analystSelection.isContrarian
          ? `This is not packaged as a main pick. ${watchTipEn} is used as draw/upset protection because 1X2 and handicap are not fully aligned.`
          : `This is not packaged as high confidence. ${watchTipEn} leads the HAD read, but ${handicapEn}, so confirmation is incomplete.`
      }),
      () => ({
        zh: `${watchTipZh}只能作为参考，不是主推结论：模型差距约 ${modelGapZh}，真正的问题在让球盘是否愿意继续同向。`,
        en: `${watchTipEn} is a reference only, not the main pick: model edge is ${modelGapEn}, and the key question is handicap confirmation.`
      }),
      () => ({
        zh: `这场有正路倾向，但不适合硬写成稳胆。${handicapZh}，风险标签为 ${riskTextZh}，先按观察单处理。`,
        en: `There is a favorite lean, but not a banker. ${handicapEn}; risk tags: ${riskTextEn}. Keep it in watch mode.`
      }),
      () => ({
        zh: `模型没有否定${watchTipZh}，只是拒绝把它抬到主推：市场第一方向领先 ${marketGapZh}，但让球验证和风险项还没闭合。`,
        en: `The model is not rejecting ${watchTipEn}; it is refusing to upgrade it. Market lead is ${marketGapEn}, but handicap and risk checks are not closed.`
      })
    ]);

    return {
      explanation,
      analysisItems: [
        {
          zh: bestHasWeakHandicap
            ? `降级原因：${tipZh}对应 ${handicapZh}；${hhadTextZh}，和普通胜平负主线存在温差。`
            : bestHasThinEdge
              ? `降级原因：独立模型首选优势约 ${modelGapZh}，未达到强推荐阈值；市场差距约 ${marketGapZh}，仅作为校验。`
              : `降级原因：风险标签叠加为 ${riskTextZh}，当前不适合只给单一方向。`,
          en: bestHasWeakHandicap
            ? `Downgrade reason: ${tipEn} has ${handicapEn}; ${hhadTextEn}, not fully aligned with HAD.`
            : bestHasThinEdge
              ? `Downgrade reason: independent model edge is about ${modelGapEn}, below the strong-pick threshold; market gap is about ${marketGapEn} and is validation only.`
              : `Downgrade reason: risk tags overlap: ${riskTextEn}. A single pick is not justified yet.`
        },
        { zh: goalsZh, en: goalsEn },
        { zh: lateRiskZh, en: lateRiskEn }
      ]
    };
  }

  if (analystSelection.isContrarian) {
    const isDrawValue = analystSelection.mode === "value-draw";
    const explanation = chooseNarrative(match, `best-contrarian-${analystSelection.mode}`, [
      () => ({
        zh: isDrawValue
          ? `这场重点不是追低赔，而是平局拉力。主线没有拉开足够距离，让球盘也没有把正路完全坐实。`
          : `低赔方向有热度，但让球盘没有同步确认。模型把${tipZh}保留为价值观察，而不是常规正路。`,
        en: isDrawValue
          ? `The key is draw pressure rather than chasing the lowest SP. The main line has not separated enough, and handicap support is incomplete.`
          : `The low-SP side is warm, but handicap support does not fully confirm it. ${tipEn} is kept as value-watch, not a standard favorite.`
      }),
      () => ({
        zh: isDrawValue
          ? `平局在这场不是陪衬项：胜平负差距偏窄，正路让球支持偏弱，因此优先看防平价值。`
          : `${tipZh}属于盘口分歧下的冷门观察。它不是最高确定性方向，但比机械追随热门更有赔率解释空间。`,
        en: isDrawValue
          ? `The draw is not a filler here: the 1X2 spread is narrow and favorite handicap support is weak, so draw cover has value.`
          : `${tipEn} is an upset watch under market disagreement. It is not high-certainty, but has more price logic than blindly following the favorite.`
      })
    ]);

    return {
      explanation,
      analysisItems: [
        {
          zh: `盘口分歧：${analystSelection.reason.zh.replace(/^专业修正：/, "")} 市场差异约 ${marketGapZh}，只用于解释分歧；独立模型首选优势约 ${modelGapZh}。`,
          en: `Market disagreement: ${analystSelection.reason.en.replace(/^Analyst adjustment: /, "")} Market gap is about ${marketGapEn} and is explanatory only; independent model edge is about ${modelGapEn}.`
        },
        { zh: goalsZh, en: goalsEn },
        {
          zh: `风险边界：这是价值观察，不是高确定性推荐；若临场平局 SP 被明显抬高或让球盘重新支持热门，需要下调权重。`,
          en: `Risk boundary: this is value-watch, not high certainty. If late draw SP drifts or handicap support returns to the favorite, downgrade it.`
        }
      ]
    };
  }

  if (bestIsSteady) {
    const explanation = chooseNarrative(match, "best-steady", [
      () => ({
        zh: `这场能进入候选，不是因为赔率低，而是官方 SP、模型概率和风险标签没有互相打架：${tipZh}同时得到多项支持。`,
        en: `This makes the shortlist not because the odds are low, but because official SP, model probability, and risk checks are aligned for ${tipEn}.`
      }),
      () => ({
        zh: `${tipZh}是本场较完整的一条主线：市场领先 ${marketGapZh}，模型领先 ${modelGapZh}，风险标签控制在低位。`,
        en: `${tipEn} is the cleanest main line here: market edge ${marketGapEn}, model edge ${modelGapEn}, and risk tags remain contained.`
      }),
      () => ({
        zh: `这场的优势来自一致性。普通胜平负、进球模型和风险过滤都没有明显反向信号，${tipZh}可列入赛前候选。`,
        en: `The edge comes from alignment. 1X2, goal model, and risk filter do not send a strong opposite signal, so ${tipEn} stays on the shortlist.`
      })
    ]);

    return {
      explanation,
      analysisItems: [
        { zh: `主线确认：市场第一方向领先约 ${marketGapZh}，模型第一方向领先约 ${modelGapZh}，${handicapZh}。`, en: `Main-line check: market edge about ${marketGapEn}, model edge about ${modelGapEn}, ${handicapEn}.` },
        { zh: goalsZh, en: goalsEn },
        { zh: `风险提示：即便进入候选，也只代表赛前概率更优；临场若出现 ${riskTextZh} 加重，需要重新降级。`, en: `Risk note: shortlist only means better pre-match probability. If ${riskTextEn} worsens late, downgrade it.` }
      ]
    };
  }

  const explanation = chooseNarrative(match, "best-model-lean", [
    () => ({
      zh: `${tipZh}是模型首选，但还不到“稳”的级别。当前优势来自概率排序，后续仍要看 SP 是否继续支持。`,
      en: `${tipEn} is the model lean, but not a steady pick. The edge comes from probability ranking and still needs late SP support.`
    }),
    () => ({
      zh: `这场有方向，但不是强方向。${tipZh}领先第二选择约 ${modelGapZh}，足够进入跟踪，不足以直接升为高可信。`,
      en: `There is a lean, not a strong lean. ${tipEn} leads the second option by about ${modelGapEn}, enough to track but not enough to upgrade.`
    })
  ]);

  return {
    explanation,
    analysisItems: [
      { zh: `独立模型排序：${tipZh}暂列第一，模型优势约 ${modelGapZh}；市场差距约 ${marketGapZh}，仅用于校验风险。`, en: `Independent model ranking: ${tipEn} is first with model edge about ${modelGapEn}; market gap is about ${marketGapEn} and is used only for risk validation.` },
      { zh: goalsZh, en: goalsEn },
      { zh: `观察点：${riskTextZh}；若临场 SP 与让球盘分歧扩大，不建议强行升档。`, en: `Watch point: ${riskTextEn}. If late SP and handicap diverge further, do not upgrade it.` }
    ]
  };
}

const MODEL_ONLY_TEAM_STRENGTH = new Map(Object.entries({
  "阿根廷": 0.92,
  "法国": 0.9,
  "英格兰": 0.88,
  "葡萄牙": 0.87,
  "巴西": 0.87,
  "西班牙": 0.86,
  "德国": 0.82,
  "荷兰": 0.81,
  "比利时": 0.78,
  "克罗地亚": 0.76,
  "意大利": 0.75,
  "乌拉圭": 0.73,
  "哥伦比亚": 0.72,
  "丹麦": 0.7,
  "瑞士": 0.69,
  "美国": 0.66,
  "墨西哥": 0.65,
  "日本": 0.65,
  "韩国": 0.62,
  "尼日利亚": 0.62,
  "匈牙利": 0.61,
  "塞内加尔": 0.61,
  "摩洛哥": 0.61,
  "波兰": 0.6,
  "奥地利": 0.6,
  "捷克": 0.57,
  "哥斯达黎加": 0.5,
  "冰岛": 0.47,
  "南非": 0.45,
  "中国": 0.38,
  "哈萨克斯坦": 0.34,
  "泰国": 0.34,
}));

function canonicalTeamNameForModel(value) {
  return normText(value).toLowerCase().replace(/\s+/g, "");
}

function rankToStrength(rank) {
  const value = toNum(rank);
  if (!Number.isFinite(value) || value <= 0) return null;
  return clamp(1 - (value - 1) / 140, 0.22, 0.94);
}

function externalFifaRank(match, side) {
  const rank = match.externalSignals?.fiveHundred?.rank?.[side]?.fifaRank;
  return Number.isFinite(Number(rank)) ? Number(rank) : null;
}

function worldCupPriorSide(match, side) {
  const prior = match.worldCupPrior || match.externalSignals?.worldCupPrior;
  return prior?.[side] || null;
}

function worldCupPriorStrength(match, side) {
  const strength = Number(worldCupPriorSide(match, side)?.modelStrengthNormalized);
  return Number.isFinite(strength) ? clamp(strength, 0.18, 0.96) : null;
}

function worldCupPriorOutcomeProbabilities(match) {
  const home = worldCupPriorSide(match, "home");
  const away = worldCupPriorSide(match, "away");
  const homeStrength = Number(home?.modelStrengthNormalized);
  const awayStrength = Number(away?.modelStrengthNormalized);
  if (!Number.isFinite(homeStrength) || !Number.isFinite(awayStrength)) return null;

  const groupContext = worldCupGroupStageContext(match);
  const homeAdvance = Number(home?.groupOutlook?.advanceProbability);
  const awayAdvance = Number(away?.groupOutlook?.advanceProbability);
  const advanceDiff = Number.isFinite(homeAdvance) && Number.isFinite(awayAdvance)
    ? (homeAdvance - awayAdvance) / 100
    : 0;
  const homeRank = Number(home?.groupOutlook?.projectedRank);
  const awayRank = Number(away?.groupOutlook?.projectedRank);
  const rankDiff = Number.isFinite(homeRank) && Number.isFinite(awayRank)
    ? clamp((awayRank - homeRank) / 6, -0.45, 0.45)
    : 0;
  const homePoints = Number(home?.groupOutlook?.projectedPoints);
  const awayPoints = Number(away?.groupOutlook?.projectedPoints);
  const pointsDiff = Number.isFinite(homePoints) && Number.isFinite(awayPoints)
    ? clamp((homePoints - awayPoints) / 7, -0.38, 0.38)
    : 0;
  const homeGoalDiff = Number(home?.groupOutlook?.goalDiff);
  const awayGoalDiff = Number(away?.groupOutlook?.goalDiff);
  const goalDiffEdge = Number.isFinite(homeGoalDiff) && Number.isFinite(awayGoalDiff)
    ? clamp((homeGoalDiff - awayGoalDiff) / 8, -0.34, 0.34)
    : 0;
  const homeGroupWin = Number(home?.groupOutlook?.groupWinProbability);
  const awayGroupWin = Number(away?.groupOutlook?.groupWinProbability);
  const groupWinDiff = Number.isFinite(homeGroupWin) && Number.isFinite(awayGroupWin)
    ? clamp((homeGroupWin - awayGroupWin) / 100, -0.45, 0.45)
    : 0;
  const needEdge = clamp(Number(groupContext?.effects?.needEdge || 0) / 100, -0.28, 0.28);
  const diff = clamp(
    (homeStrength - awayStrength) * 0.72
      + advanceDiff * 0.1
      + rankDiff * 0.07
      + pointsDiff * 0.055
      + goalDiffEdge * 0.055
      + groupWinDiff * 0.04
      + needEdge * 0.035,
    -0.42,
    0.42
  );
  const draw = clamp(0.27 - Math.abs(diff) * 0.16 + Number(groupContext?.effects?.drawBias || 0), 0.16, 0.31);
  const homeProbability = clamp((1 - draw) * (0.5 + diff), 0.08, 0.84);
  const awayProbability = clamp(1 - draw - homeProbability, 0.08, 0.84);
  return normalizeOutcomeProbabilities({
    home: homeProbability,
    draw,
    away: awayProbability,
  });
}

function officialKLeagueStandingSignalForMatch(match) {
  const signal = match?.externalSignals?.kLeagueOfficial;
  if (!signal || signal.version !== "k-league-official-standings-v1") return null;
  if (signal.source !== "K League official JSON") return null;
  const observedMs = Date.parse(signal.observedAt || signal.receivedAt || "");
  const cutoffMs = Date.parse(
    match?.buyEndTime
    || match?.predictionMeta?.cutoffTime
    || match?.kickoffTime
    || ""
  );
  if (!Number.isFinite(observedMs) || !Number.isFinite(cutoffMs) || observedMs > cutoffMs) return null;
  if (cutoffMs - observedMs > 96 * 60 * 60 * 1000) return null;
  const validSide = (row) => Boolean(
    row
    && Number(row.played || 0) >= 6
    && Number(row.rank || 0) > 0
    && Number.isFinite(Number(row.points))
    && Number.isFinite(Number(row.goalsFor))
    && Number.isFinite(Number(row.goalsAgainst))
    && Array.isArray(row.recent)
    && row.recent.length >= 4
  );
  return validSide(signal.home) && validSide(signal.away) ? signal : null;
}

function officialKLeagueTeamStrength(match, side) {
  const signal = officialKLeagueStandingSignalForMatch(match);
  const row = signal?.[side];
  if (!row) return null;
  const played = Math.max(1, Number(row.played || 0));
  const pointsPerGame = clamp(Number(row.points || 0) / played, 0, 3);
  const goalDifferencePerGame = clamp(
    (Number(row.goalsFor || 0) - Number(row.goalsAgainst || 0)) / played,
    -2,
    2,
  );
  const recent = row.recent.slice(0, 6);
  const recentPoints = recent.reduce((sum, result) => (
    sum + (result === "W" ? 3 : result === "D" ? 1 : 0)
  ), 0);
  const recentPointsPerGame = recent.length ? recentPoints / recent.length : 1;
  return clamp(
    0.2
      + (pointsPerGame / 3) * 0.55
      + ((goalDifferencePerGame + 2) / 4) * 0.15
      + (recentPointsPerGame / 3) * 0.1,
    0.18,
    0.92,
  );
}

function teamModelStrength(match, side) {
  const priorStrength = worldCupPriorStrength(match, side);
  if (priorStrength !== null) return priorStrength;

  const name = matchSideTeamName(match, side);
  const directRank = side === "home" ? match.homeRank : match.awayRank;
  const rankStrength = rankToStrength(directRank) || rankToStrength(externalFifaRank(match, side));
  if (rankStrength !== null) return rankStrength;

  const officialLeagueStrength = officialKLeagueTeamStrength(match, side);
  if (officialLeagueStrength !== null) return officialLeagueStrength;

  const normalizedName = canonicalTeamNameForModel(name);
  for (const [teamName, strength] of MODEL_ONLY_TEAM_STRENGTH.entries()) {
    if (normalizedName.includes(canonicalTeamNameForModel(teamName))) return strength;
  }

  // Unknown teams use a neutral, explicit cold-start prior. A match-id seeded
  // perturbation looks deterministic but has no football evidence and creates
  // false precision that cannot be learned or audited.
  return 0.5;
}

function teamModelStrengthHasEvidence(match, side) {
  if (worldCupPriorStrength(match, side) !== null) return true;
  const directRank = side === "home" ? match.homeRank : match.awayRank;
  if (rankToStrength(directRank) !== null || rankToStrength(externalFifaRank(match, side)) !== null) return true;
  if (officialKLeagueTeamStrength(match, side) !== null) return true;
  const normalizedName = canonicalTeamNameForModel(matchSideTeamName(match, side));
  for (const teamName of MODEL_ONLY_TEAM_STRENGTH.keys()) {
    if (normalizedName.includes(canonicalTeamNameForModel(teamName))) return true;
  }
  return false;
}

function syntheticModelOnlyProbabilities(match) {
  const profile = matchVolatilityProfile(match);
  const homeStrength = teamModelStrength(match, "home");
  const awayStrength = teamModelStrength(match, "away");
  const hasStrengthEvidence = teamModelStrengthHasEvidence(match, "home")
    || teamModelStrengthHasEvidence(match, "away");
  const homeAdvantage = hasStrengthEvidence ? (profile.isInternational ? 0.012 : 0.055) : 0;
  const strengthDiff = clamp((homeStrength - awayStrength) * 0.62 + homeAdvantage, -0.34, 0.34);
  const neutralDrawPrior = hasStrengthEvidence ? 0.255 : 0.3;
  const draw = clamp(neutralDrawPrior - Math.abs(strengthDiff) * 0.18, 0.18, 0.32);
  const home = clamp((1 - draw) * clamp(0.5 + strengthDiff, 0.16, 0.84), 0.08, 0.82);
  const away = clamp(1 - draw - home, 0.08, 0.82);
  return normalizeOutcomeProbabilities({ home, draw, away });
}

function evidenceAwareIndependentProbabilities(match) {
  const fallback = syntheticModelOnlyProbabilities(match);
  const elo = normalizeOutcomeProbabilities(match?.eloSnapshot?.probabilities);
  const homeMatches = Number(match?.eloSnapshot?.homeMatches || 0);
  const awayMatches = Number(match?.eloSnapshot?.awayMatches || 0);
  const pairedMatches = Math.min(homeMatches, awayMatches);
  if (!elo || pairedMatches < 3) return fallback;

  // When both teams have real Elo history, the Poisson seed must not remain a
  // duplicate of the generic home prior. Otherwise teamStrength and Poisson
  // contribute the same home bias while Elo is the only counterweight. Keep a
  // small independent-strength contribution, but let audited Elo history lead
  // the expected-goal split before recent form is applied.
  const eloWeight = clamp(pairedMatches / 24, 0.55, 0.9);
  return normalizeOutcomeProbabilities({
    home: fallback.home * (1 - eloWeight) + elo.home * eloWeight,
    draw: fallback.draw * (1 - eloWeight) + elo.draw * eloWeight,
    away: fallback.away * (1 - eloWeight) + elo.away * eloWeight,
  });
}

function oneXTwoCodeForScore(home, away) {
  if (home > away) return "1";
  if (home < away) return "2";
  return "X";
}

function alignedScoreForOneXTwoPick(homeLambda, awayLambda, code) {
  if (!["1", "X", "2"].includes(code)) return null;

  return scoreMatrix(homeLambda, awayLambda, 8)
    .filter((row) => oneXTwoCodeForScore(row.home, row.away) === code)
    .sort((a, b) => {
      const probabilityDiff = b.probability - a.probability;
      if (Math.abs(probabilityDiff) > 0.000001) return probabilityDiff;
      return (a.home + a.away) - (b.home + b.away);
    })[0] || null;
}

function alignedModelOnlyForecast(homeLambda, awayLambda, code) {
  const score = alignedScoreForOneXTwoPick(homeLambda, awayLambda, code);
  if (!score) return null;

  return {
    score: { home: score.home, away: score.away },
    homeLambda: alignLambdaToScore(homeLambda, score.home, 4.4),
    awayLambda: alignLambdaToScore(awayLambda, score.away, 4.4),
  };
}

function modelOnlyPickEntries(probabilities) {
  return [
    { code: "1", probability: probabilities.home, labelZh: "主胜", labelEn: "Home win" },
    { code: "X", probability: probabilities.draw, labelZh: "平局", labelEn: "Draw" },
    { code: "2", probability: probabilities.away, labelZh: "客胜", labelEn: "Away win" },
  ].sort((a, b) => b.probability - a.probability);
}

function modelInputProvenancePresent(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    normText(value.source)
    || normText(value.version)
    || normText(value.signature)
    || normText(value.trainingVersion)
    || normText(value.trainingSignature)
    || normText(value.lastUpdatedAt)
  );
}

function auditableDirectionalInputCoverage(match) {
  const elo = match?.eloSnapshot || null;
  const eloProbabilities = normalizedTripletFromAny(elo?.probabilities);
  const eloHomeMatches = Math.max(0, Number(elo?.homeMatches || 0));
  const eloAwayMatches = Math.max(0, Number(elo?.awayMatches || 0));
  const eloSample = eloHomeMatches + eloAwayMatches;
  const eloReady = Boolean(
    eloProbabilities
    && eloHomeMatches >= 3
    && eloAwayMatches >= 3
    && eloSample >= 12
    && modelInputProvenancePresent(elo?.historicalSource || elo)
  );

  const form = match?.formSnapshot || null;
  const formSample = Math.max(0, Number(form?.sampleSize || 0));
  const formHomeSample = Math.max(0, Number(form?.home?.sampleSize || 0));
  const formAwaySample = Math.max(0, Number(form?.away?.sampleSize || 0));
  const auditableMetricPresent = (value) => value !== null
    && value !== undefined
    && !(typeof value === "string" && !value.trim())
    && Number.isFinite(Number(value));
  const formMetricsReady = [
    form?.home?.goalsForAvg,
    form?.home?.goalsAgainstAvg,
    form?.away?.goalsForAvg,
    form?.away?.goalsAgainstAvg,
  ].every(auditableMetricPresent);
  const forecastMs = parseBeijingDateTime(match?.kickoffTime || match?.matchDate || "");
  const maxFormAgeMs = 240 * 24 * 60 * 60 * 1000;
  const formLastMatchTimes = [form?.home?.lastMatchAt, form?.away?.lastMatchAt]
    .map((value) => parseBeijingDateTime(value || ""));
  const formRecencyReady = Number.isFinite(forecastMs)
    && formLastMatchTimes.every((value) => (
      Number.isFinite(value)
      && value <= forecastMs
      && forecastMs - value <= maxFormAgeMs
    ));
  const formReady = Boolean(
    formSample >= 6
    && formHomeSample >= 3
    && formAwaySample >= 3
    && formMetricsReady
    && formRecencyReady
    && modelInputProvenancePresent(form?.historicalSource || form)
  );

  const leaguePrior = match?.leaguePrior || null;
  const leagueHistoryMatches = Math.max(0, Number(leaguePrior?.matches || 0));
  const leagueHistoryReady = Boolean(
    leagueHistoryMatches >= 30
    && Number.isFinite(Number(leaguePrior?.homeGoalsAvg))
    && Number.isFinite(Number(leaguePrior?.awayGoalsAvg))
    && modelInputProvenancePresent(leaguePrior)
  );
  const historicalTrainingReady = Boolean(
    (modelInputProvenancePresent(elo?.historicalSource) && eloSample >= 12)
    || (modelInputProvenancePresent(form?.historicalSource) && formReady)
  );
  const historyReady = leagueHistoryReady || historicalTrainingReady;
  const officialKLeague = officialKLeagueStandingSignalForMatch(match);
  const officialKLeagueReady = Boolean(officialKLeague);
  // Elo/form training provenance cannot be counted again as an independent input.
  const historicalEvidenceFamilies = [eloReady, formReady, leagueHistoryReady].filter(Boolean).length;
  const evidenceFamilies = officialKLeagueReady
    ? Math.max(2, historicalEvidenceFamilies)
    : historicalEvidenceFamilies;
  const sufficient = (historicalEvidenceFamilies >= 2 && (eloReady || formReady))
    || officialKLeagueReady;
  const blockers = [];
  if (!eloReady && !officialKLeagueReady) blockers.push("auditable-elo-insufficient");
  if (!formReady && !officialKLeagueReady) blockers.push("auditable-form-insufficient");
  if (!historyReady) blockers.push("auditable-history-insufficient");
  if (!sufficient) blockers.push("directional-input-families-below-2");

  return {
    version: "directional-input-coverage-v2-confidence-aware",
    sufficient,
    evidenceFamilies,
    minimumEvidenceFamilies: 2,
    coverageRatio: Number(clamp(evidenceFamilies / 2, 0, 1).toFixed(3)),
    freshnessQuality: formReady ? 0.9 : eloReady ? 0.7 : historyReady ? 0.55 : 0.42,
    policy: "without-official-odds-require-two-auditable-families-including-elo-or-form",
    elo: {
      ready: eloReady,
      homeMatches: eloHomeMatches,
      awayMatches: eloAwayMatches,
      sampleSize: eloSample,
      provenance: modelInputProvenancePresent(elo?.historicalSource || elo),
    },
    form: {
      ready: formReady,
      sampleSize: formSample,
      homeMatches: formHomeSample,
      awayMatches: formAwaySample,
      metricsReady: formMetricsReady,
      recencyReady: formRecencyReady,
      maximumAgeDays: 240,
      ageDays: formLastMatchTimes.map((value) => Number.isFinite(value) && Number.isFinite(forecastMs)
        && value <= forecastMs ? Math.floor((forecastMs - value) / 86400000) : null),
      freshnessStatus: !formRecencyReady ? "unavailable" : formLastMatchTimes.some((value) => forecastMs - value > 60 * 86400000)
        ? "aged-history" : "recent",
      recentWindowDays: 60,
      freshnessNote: "240-day history eligibility is not current-season form; aged inputs require shadow validation",
      homeLastMatchAt: form?.home?.lastMatchAt || null,
      awayLastMatchAt: form?.away?.lastMatchAt || null,
      provenance: modelInputProvenancePresent(form?.historicalSource || form),
    },
    history: {
      ready: historyReady,
      leaguePriorReady: leagueHistoryReady,
      leagueMatches: leagueHistoryMatches,
      historicalTrainingReady,
    },
    officialLeague: {
      ready: officialKLeagueReady,
      source: officialKLeague?.source || null,
      version: officialKLeague?.version || null,
      observedAt: officialKLeague?.observedAt || null,
      homePlayed: Number(officialKLeague?.home?.played || 0),
      awayPlayed: Number(officialKLeague?.away?.played || 0),
      homeRank: Number(officialKLeague?.home?.rank || 0) || null,
      awayRank: Number(officialKLeague?.away?.rank || 0) || null,
    },
    blockers,
  };
}

function suppressUnauditableDirectionalTips(result, inputCoverage) {
  // Missing official odds AND insufficient audited inputs do not authorize a
  // public cold-start direction. Keep the model only in the diagnostic branch;
  // later persistence preserves existing immutable publications independently.
  const coverageTextZh = `Elo 样本 ${inputCoverage.elo.sampleSize}、状态样本 ${inputCoverage.form.sampleSize}、历史联赛样本 ${inputCoverage.history.leagueMatches}`;
  const coverageTextEn = `Elo sample ${inputCoverage.elo.sampleSize}, form sample ${inputCoverage.form.sampleSize}, league-history sample ${inputCoverage.history.leagueMatches}`;
  const predictions = (result?.predictions || []).map((prediction) => ({
    ...prediction,
    tipCode: "WATCH",
    tipLabel: {
      zh: "暂无推荐：可审计数据不足",
      en: "No pick: insufficient audited inputs",
    },
    odds: 0,
    trustScore: clamp(Number(prediction?.trustScore || 35), 20, 38),
    recommendationAction: "reference",
    recommendationTier: "input-insufficient-watch",
    explanation: {
      zh: "暂无中国竞彩网官方赔率，且 Elo、近期状态和历史样本未达到可审计最低门槛；页面不展示主胜、平局、客胜或让球方向，等待可靠输入后重算。",
      en: "Official Sporttery odds are unavailable and the Elo, recent-form, and historical samples do not meet the auditable minimum. No 1X2 or handicap direction is shown until reliable inputs arrive.",
    },
    analysisItems: [{
      zh: `输入审计：${coverageTextZh}；当前仅保留内部概率计算用于排查，不构成前台方向。`,
      en: `Input audit: ${coverageTextEn}. Internal probability calculations are retained for diagnostics but do not create a public direction.`,
    }],
    riskTags: [
      { zh: "无官方赔率", en: "No official Sporttery odds" },
      { zh: "可审计输入不足", en: "Insufficient audited inputs" },
    ],
    resultStatus: "PENDING",
  }));
  const originalProbabilityModel = result?.probabilityModel || null;
  const probabilityModel = originalProbabilityModel ? {
    ...originalProbabilityModel,
    oneXTwo: originalProbabilityModel.oneXTwo ? {
      ...originalProbabilityModel.oneXTwo,
      final: null,
      unifiedPosterior: null,
      scoreImplied: null,
      poisson: null,
      market: null,
    } : originalProbabilityModel.oneXTwo,
    handicap: originalProbabilityModel.handicap ? {
      ...originalProbabilityModel.handicap,
      unifiedPosterior: null,
      scoreImplied: null,
      poisson: null,
      market: null,
    } : originalProbabilityModel.handicap,
    unifiedPosterior: undefined,
    inputSufficiency: inputCoverage,
    publicDecision: {
      tipCode: "WATCH",
      directionPublished: false,
      formalRecommendation: false,
      reason: "insufficient-auditable-inputs-without-official-odds",
    },
    internalDirectionalAudit: {
      oneXTwo: originalProbabilityModel.oneXTwo || null,
      handicap: originalProbabilityModel.handicap || null,
      unifiedPosterior: originalProbabilityModel.unifiedPosterior || null,
      projectedScore: result?.projectedScore || null,
    },
  } : undefined;
  return {
    ...result,
    predictions,
    projectedScore: undefined,
    probabilityModel,
  };
}

function buildModelOnlyProbabilityModel(match, probabilities, homeLambda, awayLambda) {
  let rawGoalModel = rawGoalProbabilities(homeLambda, awayLambda);
  let goalCalibration = calibrateGoalProbabilities(match, rawGoalModel.over25, rawGoalModel.btts);
  let over25Probability = goalCalibration.over25;
  let bttsProbability = goalCalibration.btts;
  let contextSignals = preMatchContextSignals(match, probabilities, null, homeLambda, awayLambda, over25Probability, bttsProbability);
  const lambdaContextAdjustment = applyContextLambdaAdjustment(homeLambda, awayLambda, contextSignals);
  if (lambdaContextAdjustment.applied) {
    homeLambda = lambdaContextAdjustment.homeLambda;
    awayLambda = lambdaContextAdjustment.awayLambda;
    rawGoalModel = rawGoalProbabilities(homeLambda, awayLambda);
    goalCalibration = calibrateGoalProbabilities(match, rawGoalModel.over25, rawGoalModel.btts);
    over25Probability = goalCalibration.over25;
    bttsProbability = goalCalibration.btts;
    contextSignals = preMatchContextSignals(match, probabilities, null, homeLambda, awayLambda, over25Probability, bttsProbability);
    contextSignals.lambdaAdjustment = {
      applied: true,
      total: lambdaContextAdjustment.totalAdjustment,
      home: lambdaContextAdjustment.homeAdjustment,
      away: lambdaContextAdjustment.awayAdjustment,
      homeShare: lambdaContextAdjustment.homeShare,
      reason: lambdaContextAdjustment.reason || "attack-intent",
    };
  }
  const contextGoalAdjustment = applyContextGoalAdjustments(over25Probability, bttsProbability, contextSignals);
  over25Probability = contextGoalAdjustment.over25;
  bttsProbability = contextGoalAdjustment.btts;
  contextSignals.goalAdjustment = contextGoalAdjustment.meta;
  const scoreCalibration = scoreCalibrationForMatch(match);
  const lambdaBlend = {
    marketHomeLambda: homeLambda,
    marketAwayLambda: awayLambda,
    homeLambda,
    awayLambda,
    formWeight: 0,
    formHomeLambda: null,
    formAwayLambda: null,
    scoreTotalLambdaAdjustment: Number(scoreCalibration?.adjustments?.totalLambdaAdjustment || 0),
    scoreCalibrationVersion: scoreCalibration?.version || null,
    contextTotalLambdaAdjustment: lambdaContextAdjustment.totalAdjustment,
    contextHomeLambdaAdjustment: lambdaContextAdjustment.homeAdjustment,
    contextAwayLambdaAdjustment: lambdaContextAdjustment.awayAdjustment,
  };
  const probabilityModel = buildProbabilityModel(
    match,
    probabilities,
    null,
    homeLambda,
    awayLambda,
    over25Probability,
    bttsProbability,
    lambdaBlend,
    goalCalibration,
    contextSignals
  );

  return {
    probabilityModel: {
      ...probabilityModel,
      version: "model-only-no-official-sp-v4",
      basis: {
        zh: "未开售模型参考：官方 SP/让球 SP 暂无时，按球队强弱、历史样本、赛程与 Poisson 比分分布生成参考推荐；不作为串关 SP。",
        en: "Model-only reference while official SP/handicap SP is unavailable. It uses team strength, historical samples, schedule context, and Poisson score distribution, and is not a parlay SP."
      },
      calibration: {
        status: "baseline",
        zh: "当前为未开售低权重参考；开售后会切回中国竞彩网官方 SP/让球 SP 重新评估。",
        en: "Low-weight reference before official prices open; once Sporttery SP/handicap SP is available, the model switches back to official-odds evaluation."
      }
    },
    over25Probability,
    bttsProbability,
    homeLambda,
    awayLambda,
    contextSignals,
  };
}

function predictionSetWithoutOfficialOdds(match) {
  return executeWithPredictionClock(() => predictionSetWithoutOfficialOddsInternal(match));
}

function predictionSetWithoutOfficialOddsInternal(match) {
  const inputCoverage = auditableDirectionalInputCoverage(match);
  const probabilities = evidenceAwareIndependentProbabilities(match);
  const leader = outcomeLeader(probabilities);
  const totalLambdaSeed = 2.18 + (1 - probabilities.draw) * 0.38 + Math.abs(probabilities.home - probabilities.away) * 0.52;
  const totalLambda = clamp(totalLambdaSeed, 1.65, 3.35);
  const sideBias = clamp((probabilities.home - probabilities.away) * 1.45, -0.75, 0.75);
  let homeLambda = clamp(totalLambda / 2 + sideBias, 0.35, 3.2);
  let awayLambda = clamp(totalLambda - homeLambda, 0.35, 3.2);
  const scoreLambdaCalibration = applyScoreCalibrationToLambdas(match, homeLambda, awayLambda);
  homeLambda = scoreLambdaCalibration.homeLambda;
  awayLambda = scoreLambdaCalibration.awayLambda;
  let score = representativeProjectedScore(homeLambda, awayLambda, leader.code, {
    scoreCalibration: match.modelCalibration?.scoreCalibration,
    softOutcomeBinding: true,
    preferredRankBoost: 0.06,
  });
  let aligned = null;
  if (aligned) {
    homeLambda = aligned.homeLambda;
    awayLambda = aligned.awayLambda;
    score = representativeProjectedScore(homeLambda, awayLambda, leader.code, {
      scoreCalibration: match.modelCalibration?.scoreCalibration,
      softOutcomeBinding: true,
      preferredRankBoost: 0.06,
    });
  }

  let modelBundle = buildModelOnlyProbabilityModel(match, probabilities, homeLambda, awayLambda);
  homeLambda = modelBundle.homeLambda || homeLambda;
  awayLambda = modelBundle.awayLambda || awayLambda;
  let picks = modelOnlyPickEntries(modelBundle.probabilityModel.oneXTwo.final || asPercentTriplet(probabilities));
  const modelLeader = picks[0];
  score = representativeProjectedScore(homeLambda, awayLambda, modelLeader.code, {
    over25Probability: modelBundle.over25Probability,
    bttsProbability: modelBundle.bttsProbability,
    scoreCalibration: match.modelCalibration?.scoreCalibration,
    contextSignals: modelBundle.contextSignals || modelBundle.probabilityModel.contextSignals,
    softOutcomeBinding: true,
    preferredRankBoost: 0.06,
  });

  const bestPick = picks[0];
  const secondPick = picks[1];
  const probabilityGap = Math.max(0, bestPick.probability - secondPick.probability);
  const bestProbability = Number(bestPick.probability);
  const trustScore = clamp(Math.round(bestProbability + probabilityGap * 0.75 + 5), 45, 78);
  const modelOnlyLowConfidence = bestProbability < 39 || probabilityGap < 4;
  const calibrationMetrics = match?.modelCalibration?.metrics || {};
  const calibrationSample = match?.modelCalibration?.sample?.recommendationPool
    ?? match?.modelCalibration?.sample?.oneXTwo
    ?? null;
  const modelOnlyConfidence = buildDynamicRecommendationConfidence({
    selectedProbability: bestProbability,
    modelGap: probabilityGap,
    dataQuality: observedUnifiedDataQuality(modelBundle.contextSignals),
    evidenceCompleteness: observedInputCoverageRatio(inputCoverage),
    // There is no multi-factor market gate before official SP opens. Keep the
    // overall confidence unavailable instead of turning input coverage into a
    // fabricated evidence score or neutral market agreement.
    evidenceScore: null,
    marketProbability: null,
    marketAligned: null,
    supportingFactorCount: 0,
    evidenceFamilyCount: inputCoverage?.evidenceFamilies,
    minimumEvidenceFamilies: inputCoverage?.minimumEvidenceFamilies,
    independentAgreement: null,
    freshnessEvidence: auditableConfidenceFreshnessEvidence(
      match,
      modelBundle.probabilityModel?.generatedAt,
      "HAD",
    ),
    inputSparse: inputCoverage?.sufficient === false,
    blockerCount: inputCoverage?.blockers?.length,
    calibrationHitRate: calibrationMetrics.bestHitRate ?? calibrationMetrics.oneXTwoHitRate,
    calibrationSample,
    trustPenalty: Number(modelBundle.contextSignals?.trustPenalty || 0),
    materialConflict: false,
    formalRecommendation: false,
  });
  const riskTags = [
    { zh: "未开售无官方SP", en: "No official SP" },
    { zh: "待官方赔率", en: "Waiting for official SP" },
    ...(probabilityGap < 8 ? [{ zh: "优势不厚", en: "Thin edge" }] : []),
  ];
  const final = modelBundle.probabilityModel.oneXTwo.final || { home: 0, draw: 0, away: 0 };
  const probabilityTextZh = `主胜 ${Number(final.home || 0).toFixed(1)}% / 平 ${Number(final.draw || 0).toFixed(1)}% / 客胜 ${Number(final.away || 0).toFixed(1)}%`;
  const probabilityTextEn = `home ${Number(final.home || 0).toFixed(1)}% / draw ${Number(final.draw || 0).toFixed(1)}% / away ${Number(final.away || 0).toFixed(1)}%`;
  const tipLabel = {
    zh: `参考推荐 ${bestPick.labelZh}（待官方 SP）`,
    en: `Reference pick: ${bestPick.labelEn} (official SP pending)`,
  };

  const oneXTwo = {
    marketType: "1X2",
    tipCode: bestPick.code,
    tipLabel,
    odds: 0,
    trustScore,
    confidence: modelOnlyConfidence,
    recommendationAction: "reference",
    recommendationTier: "model-only-reference",
    explanation: {
      zh: `本场胜平负暂未开售，模型参考推荐为 ${bestPick.labelZh}。该值不是官方 SP，不计入正式推荐、榜单、串关或命中率。`,
      en: `Official 1X2 is not open yet. The model reference pick is ${bestPick.labelEn}; it is excluded from formal recommendations, leaderboards, parlays, and hit-rate denominators.`,
    },
    analysisItems: [
      {
        zh: `模型概率：${probabilityTextZh}；第一方向领先第二方向约 ${probabilityGap.toFixed(1)} 个百分点。`,
        en: `Model probabilities: ${probabilityTextEn}; the first lane leads the second by about ${probabilityGap.toFixed(1)} points.`,
      },
      {
        zh: `比分热区已和方向校准在 ${score.home}-${score.away} 附近，避免出现方向与比分互相打架。`,
        en: `Score heat is aligned around ${score.home}-${score.away}, keeping the scoreline consistent with the directional lean.`,
      },
      {
        zh: "开售后优先读取中国竞彩网 HAD/HHAD SP，并用官方赔率重算；当前内容只做赛前讨论参考。",
        en: "Once Sporttery HAD/HHAD opens, official SP is used first and this model-only read is recalculated.",
      },
    ],
    riskTags,
    visibilityStatus: "FREE",
    resultStatus: "PENDING",
  };

  const best = {
    marketType: "BEST",
    tipCode: oneXTwo.tipCode,
    tipLabel: {
      zh: `参考推荐 ${bestPick.labelZh}（待官方 SP）`,
      en: `Reference pick: ${bestPick.labelEn} (official SP pending)`,
    },
    odds: 0,
    trustScore: clamp(trustScore - (modelOnlyLowConfidence ? 8 : 3), 35, 76),
    confidence: modelOnlyConfidence,
    recommendationAction: "reference",
    recommendationTier: "model-only-watch",
    explanation: oneXTwo.explanation,
    analysisItems: oneXTwo.analysisItems,
    riskTags,
    visibilityStatus: "FREE",
    resultStatus: oneXTwo.resultStatus,
  };

  const result = {
    predictions: [oneXTwo, best],
    homeLambda,
    awayLambda,
    projectedScore: score,
    probabilityModel: {
      ...modelBundle.probabilityModel,
      version: "model-only-unified-v67",
      unifiedPosterior: {
        version: "v67-model-only-execution-clock-evidence-led-poisson",
        generatedAt: predictionNowIso(),
        selectedMarket: "MODEL_ONLY_1X2",
        selectedCode: bestPick.code,
        selectedLabelZh: bestPick.labelZh,
        selectedProbability: Number(bestProbability.toFixed(1)),
        selectedGap: Number(probabilityGap.toFixed(1)),
        scoreShape: {
          selectedScore: score,
          top1: score,
          drawHeavy: bestPick.code === "X",
          lowScoreHeavy: score.home + score.away <= 2,
        },
        policy: "observation-only; excluded-until-official-sp-opens",
      },
      inputSufficiency: inputCoverage,
    },
  };
  return inputCoverage.sufficient
    ? result
    : suppressUnauditableDirectionalTips(result, inputCoverage);
}

function oddsAnchorSourceInfo(match, isHhad, handicapLine) {
  const source = isHhad ? match.handicapOddsSource : match.oddsSource;
  const isSporttery = String(source || "").startsWith("sporttery:");
  const isFiveHundred = String(source || "").startsWith("500.com");
  if (isSporttery) {
    return {
      source,
      isOfficial: true,
      labelZh: isHhad ? `官方 HHAD 让球(${handicapLine || "--"})` : "中国竞彩网官方 HAD 胜平负",
      labelEn: isHhad ? `official Sporttery HHAD (${handicapLine || "--"})` : "official Sporttery HAD",
      snapshotZh: "本次中国竞彩网同步快照",
      snapshotEn: "this Sporttery sync snapshot",
    };
  }

  if (isFiveHundred) {
    return {
      source,
      isOfficial: false,
      labelZh: isHhad ? `500 网 HHAD 让球参考(${handicapLine || "--"})` : "500 网 HAD 胜平负参考",
      labelEn: isHhad ? `500.com HHAD reference (${handicapLine || "--"})` : "500.com HAD reference",
      snapshotZh: "本次 500 网参考快照",
      snapshotEn: "this 500.com reference snapshot",
    };
  }

  return {
    source,
    isOfficial: false,
    labelZh: isHhad ? `让球参考(${handicapLine || "--"})` : "胜平负参考",
    labelEn: isHhad ? `handicap 1X2 reference (${handicapLine || "--"})` : "1X2 reference",
    snapshotZh: "本次参考数据快照",
    snapshotEn: "this reference snapshot",
  };
}

function predictionSet(match) {
  return executeWithPredictionClock(() => predictionSetInternal(match));
}

function predictionSetInternal(match) {
  const hadOdds = sanitizeOdds(match.odds);
  const parsedHandicapLine = parseHandicapLine(match.handicapLine);
  const hhadLineText = parsedHandicapLine === null
    ? ""
    : formatHandicapLineForCopy(parsedHandicapLine);
  const hhadOdds = parsedHandicapLine === null ? null : sanitizeOdds(match.handicapOdds);
  const anchorOdds = hadOdds || hhadOdds;
  if (!anchorOdds) return emptyPredictionSet();
  const anchorPoolCode = hadOdds ? "HAD" : "HHAD";
  const anchorIsHhad = anchorPoolCode === "HHAD";
  const anchorHandicapLine = anchorIsHhad ? hhadLineText : "0";
  const anchorMarketType = anchorIsHhad ? "HHAD" : "1X2";
  const anchorSourceInfo = oddsAnchorSourceInfo(match, anchorIsHhad, anchorHandicapLine);
  const anchorLabelZh = anchorSourceInfo.labelZh;
  const anchorLabelEn = anchorSourceInfo.labelEn;
  const probabilities = impliedProbabilities(anchorOdds);
  const hhadProbabilities = hhadOdds ? impliedProbabilities(hhadOdds) : null;
  const independentProbabilities = evidenceAwareIndependentProbabilities(match);
  const independentLambda = independentBaseLambdas(match, independentProbabilities);
  const marketHomeLambda = independentLambda.homeLambda;
  const marketAwayLambda = independentLambda.awayLambda;
  const leagueLambda = blendLambdasWithLeaguePrior(match, independentLambda.homeLambda, independentLambda.awayLambda);
  const formLambda = blendLambdasWithForm(match, leagueLambda.homeLambda, leagueLambda.awayLambda);
  const lambdaBlend = {
    marketHomeLambda,
    marketAwayLambda,
    independentHomeLambda: Number(independentLambda.homeLambda.toFixed(2)),
    independentAwayLambda: Number(independentLambda.awayLambda.toFixed(2)),
    independentTotalLambda: independentLambda.totalLambda,
    independentHomeShare: independentLambda.homeShare,
    leagueHomeLambda: leagueLambda.leagueHomeLambda,
    leagueAwayLambda: leagueLambda.leagueAwayLambda,
    leagueWeight: leagueLambda.leagueWeight,
    leaguePriorKey: leagueLambda.leaguePriorKey,
    ...formLambda,
  };
  const scoreLambdaCalibration = applyScoreCalibrationToLambdas(match, lambdaBlend.homeLambda, lambdaBlend.awayLambda);
  let homeLambda = scoreLambdaCalibration.homeLambda;
  let awayLambda = scoreLambdaCalibration.awayLambda;
  if (scoreLambdaCalibration.applied) {
    lambdaBlend.scoreTotalLambdaAdjustment = scoreLambdaCalibration.totalLambdaAdjustment;
    lambdaBlend.scoreCalibrationVersion = scoreLambdaCalibration.version;
    lambdaBlend.homeLambda = homeLambda;
    lambdaBlend.awayLambda = awayLambda;
  }
  let score = projectedScore(homeLambda, awayLambda);
  const alignedForecast = null;
  if (alignedForecast) {
    homeLambda = alignedForecast.homeLambda;
    awayLambda = alignedForecast.awayLambda;
    score = alignedForecast.score;
    lambdaBlend.marketHomeLambda = alignedForecast.homeLambda;
    lambdaBlend.marketAwayLambda = alignedForecast.awayLambda;
    lambdaBlend.homeLambda = alignedForecast.homeLambda;
    lambdaBlend.awayLambda = alignedForecast.awayLambda;
  }
  let rawGoalModel = rawGoalProbabilities(homeLambda, awayLambda);
  let totalLambda = rawGoalModel.totalLambda;
  let goalCalibration = calibrateGoalProbabilities(match, rawGoalModel.over25, rawGoalModel.btts);
  let over25Probability = goalCalibration.over25;
  let bttsProbability = goalCalibration.btts;
  let contextSignals = preMatchContextSignals(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability);
  const lambdaContextAdjustment = applyContextLambdaAdjustment(homeLambda, awayLambda, contextSignals);
  if (lambdaContextAdjustment.applied) {
    homeLambda = lambdaContextAdjustment.homeLambda;
    awayLambda = lambdaContextAdjustment.awayLambda;
    lambdaBlend.homeLambda = homeLambda;
    lambdaBlend.awayLambda = awayLambda;
    lambdaBlend.contextTotalLambdaAdjustment = lambdaContextAdjustment.totalAdjustment;
    lambdaBlend.contextHomeLambdaAdjustment = lambdaContextAdjustment.homeAdjustment;
    lambdaBlend.contextAwayLambdaAdjustment = lambdaContextAdjustment.awayAdjustment;
    rawGoalModel = rawGoalProbabilities(homeLambda, awayLambda);
    totalLambda = rawGoalModel.totalLambda;
    goalCalibration = calibrateGoalProbabilities(match, rawGoalModel.over25, rawGoalModel.btts);
    over25Probability = goalCalibration.over25;
    bttsProbability = goalCalibration.btts;
    contextSignals = preMatchContextSignals(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability);
    contextSignals.lambdaAdjustment = {
      applied: true,
      total: lambdaContextAdjustment.totalAdjustment,
      home: lambdaContextAdjustment.homeAdjustment,
      away: lambdaContextAdjustment.awayAdjustment,
      homeShare: lambdaContextAdjustment.homeShare,
      reason: lambdaContextAdjustment.reason || "attack-intent",
    };
    score = projectedScore(homeLambda, awayLambda);
  }
  const contextGoalAdjustment = applyContextGoalAdjustments(over25Probability, bttsProbability, contextSignals);
  over25Probability = contextGoalAdjustment.over25;
  bttsProbability = contextGoalAdjustment.btts;
  contextSignals.goalAdjustment = contextGoalAdjustment.meta;
  const goalsTip = over25Probability >= 0.52 ? "O2.5" : "U2.5";
  const goalsProbability = goalsTip === "O2.5" ? over25Probability : 1 - over25Probability;
  const goalsOdds = Number(clamp(1 / Math.max(goalsProbability, 0.36), 1.2, 2.78).toFixed(2));
  const goalsTipLabel = goalsTip === "O2.5"
    ? { zh: "大2.5球（≥3球）", en: "Over 2.5 goals" }
    : { zh: "小2.5球（≤2球）", en: "Under 2.5 goals" };
  const probabilityModel = buildProbabilityModel(match, probabilities, hhadProbabilities, homeLambda, awayLambda, over25Probability, bttsProbability, lambdaBlend, goalCalibration, contextSignals);
  const finalOneXTwoProbabilities = {
    home: (probabilityModel.oneXTwo.final?.home || pct1(independentProbabilities.home)) / 100,
    draw: (probabilityModel.oneXTwo.final?.draw || pct1(independentProbabilities.draw)) / 100,
    away: (probabilityModel.oneXTwo.final?.away || pct1(independentProbabilities.away)) / 100,
  };
  const hhadScoreModel = probabilityModel.handicap?.scoreImplied || probabilityModel.handicap?.poisson || probabilityModel.handicap?.market;
  const hhadModelProbabilities = hhadScoreModel
    ? {
      home: Number(hhadScoreModel.home || 0) / 100,
      draw: Number(hhadScoreModel.draw || 0) / 100,
      away: Number(hhadScoreModel.away || 0) / 100,
    }
    : null;
  const hadHandicapRelationships = hadOdds
    ? buildHadHandicapRelationships(
        homeLambda,
        awayLambda,
        parsedHandicapLine,
        hhadProbabilities
      )
    : { "1": null, X: null, "2": null };
  const modelProbabilities = anchorIsHhad
    ? (hhadModelProbabilities || finalOneXTwoProbabilities)
    : finalOneXTwoProbabilities;
  const anchorHhadHomeLabel = anchorIsHhad ? handicapSemanticPickLabel(match, "1", anchorHandicapLine) : null;
  const anchorHhadDrawLabel = anchorIsHhad ? handicapSemanticPickLabel(match, "X", anchorHandicapLine) : null;
  const anchorHhadAwayLabel = anchorIsHhad ? handicapSemanticPickLabel(match, "2", anchorHandicapLine) : null;
  const homePickLabelZh = anchorIsHhad ? anchorHhadHomeLabel.zh : `主胜 ${match.homeTeam}`;
  const drawPickLabelZh = anchorIsHhad ? anchorHhadDrawLabel.zh : "平局";
  const awayPickLabelZh = anchorIsHhad ? anchorHhadAwayLabel.zh : `客胜 ${match.awayTeam}`;
  const homePickLabelEn = anchorIsHhad ? anchorHhadHomeLabel.en : `Home Win (${match.homeTeam})`;
  const drawPickLabelEn = anchorIsHhad ? anchorHhadDrawLabel.en : "Draw";
  const awayPickLabelEn = anchorIsHhad ? anchorHhadAwayLabel.en : `Away Win (${match.awayTeam})`;
  const picks = [
    ["1", modelProbabilities.home, anchorOdds.odds1, homePickLabelZh, homePickLabelEn],
    ["X", modelProbabilities.draw, anchorOdds.oddsX, drawPickLabelZh, drawPickLabelEn],
    ["2", modelProbabilities.away, anchorOdds.odds2, awayPickLabelZh, awayPickLabelEn],
  ].sort((a, b) => b[1] - a[1]);
  const marketPicks = [
    ["1", probabilities.home, anchorOdds.odds1],
    ["X", probabilities.draw, anchorOdds.oddsX],
    ["2", probabilities.away, anchorOdds.odds2],
  ].sort((a, b) => b[1] - a[1]);
  const hhadHomeLabel = handicapSemanticPickLabel(match, "1", hhadLineText || anchorHandicapLine);
  const hhadDrawLabel = handicapSemanticPickLabel(match, "X", hhadLineText || anchorHandicapLine);
  const hhadAwayLabel = handicapSemanticPickLabel(match, "2", hhadLineText || anchorHandicapLine);
  const hhadPicks = hhadOdds && hhadModelProbabilities
    ? [
        ["1", hhadModelProbabilities.home, hhadOdds.odds1, hhadHomeLabel.zh, hhadHomeLabel.en],
        ["X", hhadModelProbabilities.draw, hhadOdds.oddsX, hhadDrawLabel.zh, hhadDrawLabel.en],
        ["2", hhadModelProbabilities.away, hhadOdds.odds2, hhadAwayLabel.zh, hhadAwayLabel.en],
      ].sort((a, b) => b[1] - a[1])
    : [];
  const hhadBest = hhadPicks[0];
  const hhadSecond = hhadPicks[1];
  const hhadModelGap = hhadBest && hhadSecond ? Math.max(0, hhadBest[1] - hhadSecond[1]) : 0;
  const hhadMarketSupport = hhadBest && hhadProbabilities ? outcomeProbabilityForCode(hhadProbabilities, hhadBest[0]) : null;
  const hhadMarketPicks = hhadProbabilities
    ? [
        ["1", hhadProbabilities.home],
        ["X", hhadProbabilities.draw],
        ["2", hhadProbabilities.away],
      ].sort((a, b) => b[1] - a[1])
    : [];
  const hhadMarketLeader = hhadMarketPicks[0];
  const hhadMarketAligned = Boolean(hhadBest && hhadMarketLeader && hhadMarketLeader[0] === hhadBest[0]);
  const hhadModelMarketSpread = hhadBest && hhadMarketSupport !== null
    ? Math.abs(Number(hhadBest[1]) - Number(hhadMarketSupport))
    : null;
  const hhadSpreadOk = hhadModelMarketSpread === null
    || hhadModelMarketSpread <= (Number(hhadBest?.[1] || 0) >= 0.64 ? 0.18 : 0.22);
  const hhadMarketContradicted = Boolean(
    hhadBest
    && hhadMarketLeader
    && hhadMarketLeader[0] !== hhadBest[0]
    && hhadMarketSupport !== null
    && hhadMarketSupport < 0.38
  );
  const anchorHhadShouldWatch = Boolean(anchorIsHhad && hhadMarketContradicted);
  const marketLeader = marketPicks[0];
  const marketSecond = marketPicks[1];
  const analystSelection = selectValueAwareOneXTwo(
    match,
    picks,
    modelProbabilities,
    probabilities,
    hadHandicapRelationships
  );
  const hasSelectionDisagreement = Boolean(analystSelection.isContrarian || analystSelection.hasValueDisagreement);
  const best1x2 = analystSelection.pick;
  score = representativeProjectedScore(homeLambda, awayLambda, anchorIsHhad ? null : best1x2[0], {
    over25Probability,
    bttsProbability,
    scoreCalibration: match.modelCalibration?.scoreCalibration,
    contextSignals,
    softOutcomeBinding: true,
    preferredRankBoost: 0.06,
  });
  const probabilityGap = marketLeader[1] - marketSecond[1];
  const modelProbabilityGap = Math.max(0, picks[0][1] - picks[1][1]);
  const oneXTwoModelEdgeIsNoise = !anchorIsHhad && modelProbabilityGap < 0.035;
  const selectedMarketProbability = outcomeProbabilityForCode(probabilities, best1x2[0]) || 0;
  const selectionDiscount = Math.max(0, marketLeader[1] - selectedMarketProbability);
  const candidateHandicapRelationship = hadHandicapRelationships?.[best1x2[0]] || null;
  const candidateHandicapSupport = conditionalHandicapSupportForPick(hadHandicapRelationships, best1x2[0]);
  const candidateIsLowOddsFavorite = ["1", "2"].includes(best1x2[0]) && best1x2[2] <= 1.55;
  const candidateIsOverheated = ["1", "2"].includes(best1x2[0]) && best1x2[2] <= 1.35;
  const candidateHasWeakHandicap = ["1", "2"].includes(best1x2[0])
    && candidateHandicapSupport !== null
    && candidateHandicapSupport < 0.42;
  const dynamicGate = profileCalibration(match).gate || {};
  const oneXTwoStrategyGate = strategyGateForPrediction(match, anchorMarketType, best1x2[0], predictionOddsBucket(best1x2[2]));
  const rawTrust = hasSelectionDisagreement
    ? clamp(Math.round(best1x2[1] * 100 + 31 - selectionDiscount * 42), 54, 76)
    : clamp(Math.round(best1x2[1] * 100 + modelProbabilityGap * 48 + 10), 52, 93);
  const trustPenalty =
    (candidateIsOverheated ? 11 : candidateIsLowOddsFavorite ? 5 : 0)
    + (candidateHasWeakHandicap ? 9 : 0)
    + (probabilities.draw >= 0.28 ? 4 : 0)
    + (bttsProbability >= 0.45 && bttsProbability < 0.65 ? 3 : 0)
    + Number(contextSignals.trustPenalty || 0)
    + Number(dynamicGate.trustPenalty || 0)
    + Number(oneXTwoStrategyGate.trustPenalty || 0);
  const baseTrust = clamp(
    rawTrust - trustPenalty,
    hasSelectionDisagreement ? 50 : 48,
    candidateIsOverheated || candidateHasWeakHandicap ? 82 : 91
  );
  const probabilityTextZh = `主胜 ${pct(probabilities.home)}% / 平局 ${pct(probabilities.draw)}% / 客胜 ${pct(probabilities.away)}%`;
  const probabilityTextEn = `home ${pct(probabilities.home)}% / draw ${pct(probabilities.draw)}% / away ${pct(probabilities.away)}%`;
  const oddsText = `${anchorOdds.odds1.toFixed(2)} / ${anchorOdds.oddsX.toFixed(2)} / ${anchorOdds.odds2.toFixed(2)}`;
  const sourceUpdatedAt = anchorIsHhad ? match.handicapOddsUpdatedAt : match.oddsUpdatedAt;
  const sourceTextZh = sourceUpdatedAt
    ? `${anchorLabelZh} SP 更新时间：${sourceUpdatedAt}`
    : `${anchorLabelZh} SP 来自${anchorSourceInfo.snapshotZh}`;
  const sourceTextEn = sourceUpdatedAt
    ? `${anchorLabelEn} SP updated at ${sourceUpdatedAt}`
    : `${anchorLabelEn} SP came from ${anchorSourceInfo.snapshotEn}`;
  const drawRiskZh = probabilities.draw >= 0.28
    ? "平局支持率偏高，胜平负方向需要防平。"
    : "平局支持率未明显压低主方向，但仍需留意赛前 SP 变化。";
  const drawRiskEn = probabilities.draw >= 0.28
    ? "Draw support is high, so cover the draw risk."
    : "Draw support is not dominant, but late SP movement still matters.";
  const volatilityProfile = matchVolatilityProfile(match);
  const riskTags = [];
  const candidateValueProfile = analystSelection.valueProfile || pickValueProfile(best1x2, modelProbabilities, probabilities);
  const candidateProbabilityEdge = Number(candidateValueProfile?.probabilityEdge);
  const candidateExpectedValue = Number(candidateValueProfile?.expectedValue);

  if (!anchorSourceInfo.isOfficial) {
    riskTags.push({ zh: "非官方参考源", en: "Non-official reference" });
  }

  if (Number.isFinite(candidateProbabilityEdge) && candidateProbabilityEdge < 0.015) {
    riskTags.push({ zh: "价值边际不足", en: "No value edge" });
  }
  if (Number.isFinite(candidateExpectedValue) && candidateExpectedValue < 0.01) {
    riskTags.push({ zh: "EV不足", en: "Flat expected value" });
  }

  if (probabilities.draw >= 0.28) {
    riskTags.push({ zh: "防平", en: "Draw risk" });
  }
  if (best1x2[2] <= 1.25) {
    riskTags.push({ zh: "热门过热", en: "Heavy favorite" });
  }
  if (volatilityProfile.isInternational && ["1", "2"].includes(best1x2[0]) && best1x2[2] <= 1.35) {
    riskTags.push({ zh: "国际赛低赔", en: "International low-SP favorite" });
  }
  if (probabilityGap < 0.12) {
    riskTags.push({ zh: "胜负接近", en: "Tight 1X2" });
  }
  if (["1", "2"].includes(best1x2[0]) && candidateHandicapSupport !== null && candidateHandicapSupport < 0.42) {
    riskTags.push({ zh: "让球支持不足", en: "Handicap support weak" });
  }
  if (bttsProbability >= 0.45 && bttsProbability < 0.65) {
    riskTags.push({ zh: "进球临界", en: "Goal-model borderline" });
  }
  if (hasSelectionDisagreement) {
    riskTags.push({ zh: "盘口分歧", en: "Market disagreement" });
  }

  if (Number(contextSignals.discipline?.redCardRisk?.total || 0) >= 0.17) {
    riskTags.push({ zh: "\u7ea2\u724c\u6ce2\u52a8", en: "Red-card volatility" });
  }
  if (Number(contextSignals.discipline?.expectedYellowCards?.total || 0) >= 5.2) {
    riskTags.push({ zh: "\u9ec4\u724c\u504f\u9ad8", en: "High-card risk" });
  }
  if (Number(contextSignals.attackIntent?.total || 50) <= 42) {
    riskTags.push({ zh: "\u8fdb\u653b\u6b32\u671b\u504f\u4f4e", en: "Low attack intent" });
  }
  if (Number(contextSignals.rankingPressure?.maxPressure || 0) >= 70) {
    riskTags.push({ zh: "\u6392\u540d\u6218\u610f\u538b\u529b", en: "Ranking pressure" });
  }
  if (Number(contextSignals.dataGaps?.severeMissingCount || 0) >= 2 || contextSignals.dataGaps?.sourceQuality === "low") {
    riskTags.push({ zh: "\u5173\u952e\u6570\u636e\u7f3a\u53e3", en: "Key data gaps" });
  }
  if (contextSignals.dataGaps?.connected?.referee === false && contextSignals.dataGaps?.connected?.teamCards === false) {
    riskTags.push({ zh: "\u724c\u6570\u6570\u636e\u672a\u63a5\u5165", en: "Card data missing" });
  }

  const oneXTwoGate = evaluateOneXTwoGate({
    match,
    pick: best1x2,
    probabilities,
    modelProbabilities,
    hadHandicapRelationships,
    probabilityGap,
    modelProbabilityGap,
    riskTags,
    analystSelection,
    predictionHealth: match.predictionHealth,
    marketType: anchorMarketType,
  });
  const anchorGatePromote = false;
  const oneXTwoPromote = !anchorIsHhad && (oneXTwoGate.promote || anchorGatePromote);
  const oneXTwoWatchLabel = {
    zh: anchorIsHhad ? "观察为主 让球盘不强推" : "\u89c2\u5bdf\u4e3a\u4e3b \u80dc\u5e73\u8d1f\u4e0d\u5f3a\u63a8",
    en: anchorIsHhad ? "Watch first: no HHAD pick" : "Watch first: no 1X2 pick",
  };
  const oneXTwoHealthCooldown = Boolean(
    !anchorIsHhad
    && (
      isCoolingBucket(match.predictionHealth?.byMarket?.["1X2"])
      || isCoolingBucket(match.predictionHealth?.homeFavorite)
    )
  );
  const oneXTwoMarketHardCooldown = !anchorIsHhad && hardCoolingBucket(match.predictionHealth?.byMarket?.["1X2"], 8, 0.42);
  const bestMarketHardCooldown = !anchorIsHhad && hardCoolingBucket(match.predictionHealth?.best?.byMarket?.["1X2"], 5, 0.45);
  const homeFavoriteHardCooldown = !anchorIsHhad && hardCoolingBucket(match.predictionHealth?.homeFavorite, 6, 0.42);
  const healthCooldownTag = oneXTwoHealthCooldown
    ? [{ zh: "\u8fd1\u671f\u547d\u4e2d\u7387\u51b7\u5374", en: "Recent hit-rate cooldown" }]
    : [];
  const oneXTwoRiskTags = oneXTwoPromote
    ? riskTags
    : [
        ...riskTags,
        ...healthCooldownTag,
        { zh: "条件未齐", en: "Conditions not aligned" },
      ];
  const oneXTwoTrust = oneXTwoGate.promote
    ? baseTrust
    : oneXTwoPromote
      ? clamp(baseTrust - 6, 46, 72)
      : clamp(baseTrust - (oneXTwoMarketHardCooldown ? 26 : 18), 34, 62);
  const oneXTwoGateZh = anchorIsHhad
    ? `参考理由：普通胜平负未开售，本场按独立 Poisson 让球概率给参考方向；模型优势约 ${pct(modelProbabilityGap)} 个百分点，盘口仅作校验，条件未完全闭合时不强推单一让球方向。`
    : `参考理由：独立模型优势约 ${pct(modelProbabilityGap)} 个百分点，市场分歧约 ${pct(probabilityGap)} 个百分点，让球条件兼容支持${oneXTwoGate.handicapSupport === null ? "不足" : `约 ${pct(oneXTwoGate.handicapSupport)}%`}；条件没有同时闭合，暂不输出单一胜平负方向。`;
  const oneXTwoGateEn = anchorIsHhad
    ? `Watch reason: standard 1X2 is not open, so the reference direction comes from independent Poisson handicap probabilities. Model edge is about ${pct(modelProbabilityGap)} points; the board is only a validation layer.`
    : `Watch reason: independent model edge is about ${pct(modelProbabilityGap)} points, market disagreement about ${pct(probabilityGap)} points, conditional handicap support ${oneXTwoGate.handicapSupport === null ? "unavailable" : `about ${pct(oneXTwoGate.handicapSupport)}%`}; no single 1X2 pick is promoted.`;
  const modelLean = {
    tipCode: best1x2[0],
    tipLabel: { zh: best1x2[3], en: best1x2[4] },
    odds: best1x2[2],
    trustScore: baseTrust,
    resultStatus: resultStatus(match, best1x2[0], anchorMarketType),
  };
  const oneXTwoReferenceLabel = {
    zh: `\u53c2\u8003\u503e\u5411 ${modelLean.tipLabel.zh}`,
    en: `Reference lean: ${modelLean.tipLabel.en}`,
  };
  const oneXTwoTipCode = anchorHhadShouldWatch || (oneXTwoModelEdgeIsNoise && !oneXTwoPromote)
    ? "WATCH"
    : modelLean.tipCode;
  const oneXTwoTipLabel = anchorHhadShouldWatch
    ? oneXTwoWatchLabel
    : oneXTwoModelEdgeIsNoise && !oneXTwoPromote
      ? {
          zh: "观察为主 胜平负方向接近",
          en: "Watch first: tight 1X2 board",
        }
      : oneXTwoPromote ? modelLean.tipLabel : oneXTwoReferenceLabel;
  const oneXTwoOdds = oneXTwoTipCode === "WATCH" ? 0 : modelLean.odds;

  const oneXTwo = {
    marketType: "1X2",
    oddsPoolCode: anchorPoolCode,
    handicapLine: anchorHandicapLine,
    tipCode: oneXTwoTipCode,
    tipLabel: oneXTwoTipLabel,
    odds: oneXTwoOdds,
    trustScore: oneXTwoTrust,
    recommendationAction: oneXTwoPromote ? "recommend" : "reference",
    recommendationTier: oneXTwoPromote ? oneXTwoGate.tier : "reference",
    explanation: {
      zh: anchorHhadShouldWatch
        ? `让球盘先降级观察：模型方向和官方让球盘第一方向相反，且模型方向的官方支持不足 ${pct(hhadMarketSupport || 0)}%，本场不把让球结果写成主推荐。`
        : oneXTwoModelEdgeIsNoise && !oneXTwoPromote
        ? `胜平负不强推：独立模型三项非常接近，第一方向只领先约 ${pct(modelProbabilityGap)} 个百分点；官方 SP 可作为市场压力参考，但不输出单一胜平负方向。`
        : oneXTwoPromote
        ? `本场先由独立模型给出${best1x2[3]}方向；${anchorLabelZh} SP 只用于校验市场分歧、价值差和风险标签，不作为预测主轴。`
        : `${anchorLabelZh}条件未齐：低赔、平局压力、让球确认或风险标签存在不一致，只保留为参考推荐。`,
      en: anchorHhadShouldWatch
        ? `The HHAD lane is downgraded to watch: model direction conflicts with the official handicap market leader, and official support for that model side is only about ${pct(hhadMarketSupport || 0)}%.`
        : oneXTwoModelEdgeIsNoise && !oneXTwoPromote
        ? `No 1X2 side is promoted: the independent model is essentially tied, with the top side ahead by only about ${pct(modelProbabilityGap)} points. Official SP is market pressure, not a single pick.`
        : oneXTwoPromote
        ? `This pick comes from the independent model as ${best1x2[4]}. ${anchorLabelEn} odds are used only for market disagreement, value gap, and risk tags.`
        : `Reference lean: ${modelLean.tipLabel.en}. This ${anchorIsHhad ? "HHAD" : "1X2"} market did not pass the strong recommendation gate, so the direction is shown for user judgement only.`,
    },
    analysisItems: [
      {
        zh: `${anchorLabelZh} SP：${anchorIsHhad ? "让胜" : "主胜"} ${anchorOdds.odds1.toFixed(2)} / ${anchorIsHhad ? "让平" : "平局"} ${anchorOdds.oddsX.toFixed(2)} / ${anchorIsHhad ? "让负" : "客胜"} ${anchorOdds.odds2.toFixed(2)}；去水支持率约 ${probabilityTextZh}。`,
        en: `${anchorLabelEn} SP: ${oddsText}; normalized support is about ${probabilityTextEn}.`,
      },
      {
        zh: !oneXTwoPromote
          ? oneXTwoGateZh
          : analystSelection.isContrarian
          ? `${analystSelection.reason.zh} 当前模型可信度 ${baseTrust}%，该方向属于价值观察而非高确定性推荐。`
          : `独立模型差距：第一方向领先第二方向约 ${pct(modelProbabilityGap)} 个百分点；市场差距仅作校验，当前模型可信度 ${baseTrust}%。`,
        en: !oneXTwoPromote
          ? oneXTwoGateEn
          : analystSelection.isContrarian
          ? `${analystSelection.reason.en} Model confidence is ${baseTrust}%; this is a value-watch, not a high-certainty banker.`
          : `Independent model separation: the top direction leads by about ${pct(modelProbabilityGap)} percentage points; market separation is validation only. Model confidence: ${baseTrust}%.`,
      },
      {
        zh: `${drawRiskZh} ${sourceTextZh}。`,
        en: `${drawRiskEn} ${sourceTextEn}.`,
      },
    ],
    riskTags: oneXTwoRiskTags,
    visibilityStatus: "FREE",
    resultStatus: resultStatus(match, oneXTwoTipCode, anchorMarketType),
  };

  const goalsGate = evaluateGoalsGate(match, goalsTip, goalsProbability, over25Probability, bttsProbability, match.predictionHealth);
  const goalsWatchLabel = {
    zh: "观察为主 进球数不强推",
    en: "Watch first: no total-goals pick",
  };
  const goalsReferenceLabel = {
    zh: `\u8fdb\u7403\u53c2\u8003 ${goalsTipLabel.zh}`,
    en: `Goals reference: ${goalsTipLabel.en}`,
  };
  const goalsRiskTags = goalsGate.promote
    ? riskTags.filter((tag) => tag.en === "Goal-model borderline")
    : [
        ...riskTags.filter((tag) => tag.en === "Goal-model borderline"),
        ...(isCoolingBucket(match.predictionHealth?.byMarket?.GOALS) ? [{ zh: "进球命中率冷却", en: "Goals hit-rate cooldown" }] : []),
        { zh: "进球条件未齐", en: "Goals conditions not aligned" },
      ];

  const goals = {
    marketType: "GOALS",
    tipCode: goalsTip,
    tipLabel: goalsReferenceLabel,
    odds: goalsOdds,
    trustScore: clamp(Math.round(goalsProbability * 100 - 2), 42, 58),
    recommendationAction: "reference",
    recommendationTier: "reference",
    explanation: {
      zh: goalsGate.promote
        ? `进球趋势为模型参考项，基于胜平负 SP 反推出主队 ${homeLambda.toFixed(2)}、客队 ${awayLambda.toFixed(2)} 的预期进球，当前总进球期望约 ${totalLambda.toFixed(2)}。`
        : `进球趋势条件未齐：总进球期望约 ${totalLambda.toFixed(2)}，大 2.5 概率约 ${pct(over25Probability)}%，边际不足时不强行给大/小球方向。`,
      en: goalsGate.promote
        ? `The goals trend derives expected goals from 1X2 odds: home ${homeLambda.toFixed(2)}, away ${awayLambda.toFixed(2)}, total ${totalLambda.toFixed(2)}.`
        : `The goals trend did not pass the recommendation gate. Total expected goals are about ${totalLambda.toFixed(2)}, over 2.5 probability about ${pct(over25Probability)}%, so no over/under pick is promoted.`,
    },
    analysisItems: [
      {
        zh: goalsGate.promote
          ? `比分热区：${score.home}-${score.away} 附近；${goalsTipLabel.zh} 的模型概率约 ${pct(goalsProbability)}%。`
          : `比分热区：${score.home}-${score.away} 附近；候选方向 ${goalsTipLabel.zh} 的模型概率约 ${pct(goalsProbability)}%，低于强推阈值。`,
        en: goalsGate.promote
          ? `Score heat zone: around ${score.home}-${score.away}; model probability for ${goalsTipLabel.en} is about ${pct(goalsProbability)}%.`
          : `Score heat zone: around ${score.home}-${score.away}; candidate ${goalsTipLabel.en} is about ${pct(goalsProbability)}%, below the promotion threshold.`,
      },
      {
        zh: `大 2.5 球概率约 ${pct(over25Probability)}%，该指标用于走势参考，不等同于官方总进球 SP。`,
        en: `Over 2.5 probability is about ${pct(over25Probability)}%. This is a model reference, not official Sporttery total-goals SP.`,
      },
    ],
    riskTags: goalsRiskTags,
    visibilityStatus: "FREE",
    resultStatus: resultStatus(match, goalsTip, "GOALS"),
  };

  const bestIsSteady = oneXTwoPromote
    && !hasSelectionDisagreement
    && best1x2[1] >= 0.58
    && modelProbabilityGap >= 0.18
    && baseTrust >= 84
    && riskTags.length === 0;
  const bestHandicapRelationship = hadHandicapRelationships?.[modelLean.tipCode] || candidateHandicapRelationship;
  const bestHandicapSupport = conditionalHandicapSupportForPick(hadHandicapRelationships, modelLean.tipCode);
  const bestHasWeakHandicap = ["1", "2"].includes(modelLean.tipCode)
    && bestHandicapSupport !== null
    && bestHandicapSupport < 0.3;
  const bestHasThinEdge = !hasSelectionDisagreement && (modelProbabilityGap < 0.18 || best1x2[1] < 0.62);
  const bestHasOverheatedFavorite = ["1", "2"].includes(modelLean.tipCode)
    && modelLean.odds <= 1.7
    && (bestHandicapSupport === null || bestHandicapSupport < 0.3 || riskTags.length >= 4);
  const severeRiskCountForBest = riskTags.filter((tag) => (
    !hasSelectionDisagreement
    || !["Draw risk", "Tight 1X2", "Market disagreement"].includes(tag.en)
  )).length;
  const bestHasSevereRisk = severeRiskCountForBest >= 4
    || (bestHasWeakHandicap && modelLean.odds <= 1.7)
    || (!hasSelectionDisagreement && modelProbabilityGap < 0.06 && best1x2[1] < 0.52);
  const bestLaneHardCooldown = Boolean(
    bestMarketHardCooldown
    || oneXTwoMarketHardCooldown
    || (modelLean.tipCode === "1" && homeFavoriteHardCooldown)
  );
  const bestShouldWatch = !oneXTwoPromote
    || bestLaneHardCooldown
    || bestHasWeakHandicap
    || bestHasOverheatedFavorite
    || bestHasSevereRisk;
  const hhadLineNumber = parseHandicapLine(hhadLineText || anchorHandicapLine);
  const hhadUnderdogProtection = Number.isFinite(Number(hhadLineNumber))
    && (
      (Number(hhadLineNumber) > 0 && hhadBest?.[0] === "1")
      || (Number(hhadLineNumber) < 0 && hhadBest?.[0] === "2")
    );
  const hhadFavoriteNonCoverOpposesOneXTwo = Boolean(
    hhadBest
    && hhadUnderdogProtection
    && (
      (Number(hhadLineNumber) < 0 && modelLean.tipCode === "1" && hhadBest[0] === "2")
      || (Number(hhadLineNumber) > 0 && modelLean.tipCode === "2" && hhadBest[0] === "1")
    )
  );
  const oneXTwoFavoriteLooksFragile = Boolean(
    hhadFavoriteNonCoverOpposesOneXTwo
    && !oneXTwoPromote
    && modelLean.odds <= 1.75
    && (
      bestHasThinEdge
      || bestHasWeakHandicap
      || bestHasOverheatedFavorite
      || candidateHasWeakHandicap
      || probabilities.draw >= 0.27
      || modelProbabilityGap < 0.1
      || hasSelectionDisagreement
    )
  );
  const oneXTwoConflictForHandicap = !anchorIsHhad
    && hhadBest
    && (
      !oneXTwoPromote
      || hasSelectionDisagreement
      || bestHasThinEdge
      || modelProbabilityGap < 0.07
      || probabilities.draw >= 0.28
      || probabilityGap >= 0.18
      || bestHasOverheatedFavorite
      || candidateHasWeakHandicap
      || oneXTwoFavoriteLooksFragile
    );
  const hhadDoesNotOpposeOneXTwo = (() => {
    if (!hhadBest) return false;
    if (modelLean.tipCode === "1" && hhadBest[0] === "2") {
      return (oneXTwoModelEdgeIsNoise && hhadUnderdogProtection) || oneXTwoFavoriteLooksFragile;
    }
    if (modelLean.tipCode === "2" && hhadBest[0] === "1") {
      return (oneXTwoModelEdgeIsNoise && hhadUnderdogProtection) || oneXTwoFavoriteLooksFragile;
    }
    if (modelLean.tipCode === "X" && hhadBest[0] !== "X") return false;
    return true;
  })();
  const hhadCanCarryBest = Boolean(
    bestShouldWatch
    && oneXTwoConflictForHandicap
    && hhadBest
    && hhadDoesNotOpposeOneXTwo
    && hhadBest[1] >= 0.56
    && hhadModelGap >= 0.16
    && hhadMarketAligned
    && !hhadMarketContradicted
    && hhadSpreadOk
    && hhadMarketSupport !== null
    && hhadMarketSupport >= 0.39
    && Number(hhadBest[2]) >= 1.7
  );
  const handicapBestTrust = hhadBest
    ? clamp(
        Math.round(
          hhadBest[1] * 100
          + hhadModelGap * 38
          + Number(hhadMarketSupport || 0) * 12
          - Math.min(12, riskTags.length * 3)
          - Number(contextSignals.trustPenalty || 0)
        ),
        52,
        74
      )
    : 0;
  const handicapBestPromote = handicapBestTrust >= 64;
  const handicapBestRiskTags = [
    { zh: "胜平负不强推", en: "1X2 not forced" },
    ...(oneXTwoFavoriteLooksFragile ? [{ zh: "让球风险", en: "Handicap risk" }] : []),
    ...(hasSelectionDisagreement ? [{ zh: "盘口分歧", en: "Market disagreement" }] : []),
    ...(probabilities.draw >= 0.28 ? [{ zh: "防平/防冷", en: "Draw/upset cover" }] : []),
    ...(bestHasOverheatedFavorite || candidateHasWeakHandicap ? [{ zh: "热门优势不足", en: "Favorite cover weak" }] : []),
    ...(contextSignals.dataGaps?.connected?.referee === false && contextSignals.dataGaps?.connected?.teamCards === false
      ? [{ zh: "牌数数据未接入", en: "Card data missing" }]
      : []),
  ];
  const handicapLineText = hhadLineText || anchorHandicapLine || "";
  const handicapBest = hhadBest ? {
    marketType: "BEST",
    oddsPoolCode: "HHAD",
    handicapLine: handicapLineText,
    tipCode: hhadBest[0],
    tipLabel: {
      zh: `${handicapBestPromote ? "让球结果主推" : "让球结果参考"} ${hhadBest[3]}`,
      en: `${handicapBestPromote ? "Handicap result pick" : "Handicap result reference"}: ${hhadBest[4]}`,
    },
    odds: hhadBest[2],
    trustScore: handicapBestTrust,
    recommendationAction: handicapBestPromote ? "recommend" : "reference",
    recommendationTier: handicapBestPromote ? "handicap-protection" : "handicap-protection-reference",
    explanation: {
      zh: oneXTwoFavoriteLooksFragile
        ? `普通胜平负保留为参考，但低赔热门让球证据不足；本场 BEST 改看让球${handicapLineText ? ` ${handicapLineText}` : ""}：${hhadBest[3]}。`
        : `普通胜平负差距小或盘口分歧明显，本场不强推普通胜平负单向；改看让球${handicapLineText ? ` ${handicapLineText}` : ""}计算后的结果：${hhadBest[3]}。`,
      en: oneXTwoFavoriteLooksFragile
        ? `The raw 1X2 side remains reference only, but the low-odds favorite has weak handicap evidence. BEST switches to the handicap-adjusted result${handicapLineText ? ` ${handicapLineText}` : ""}: ${hhadBest[4]}.`
        : `The standard 1X2 edge is thin or conflicted, so no raw 1X2 side is forced. The best lane switches to the handicap-adjusted result${handicapLineText ? ` ${handicapLineText}` : ""}: ${hhadBest[4]}.`,
    },
    analysisItems: [
      {
        zh: `胜平负不强推：模型第一方向领先约 ${pct(modelProbabilityGap)} 个百分点，平局/冷门或盘口分歧需要保留。`,
        en: `1X2 is not forced: the model leader is ahead by about ${pct(modelProbabilityGap)} points, while draw/upset or market disagreement remains live.`,
      },
      {
        zh: `让球：${handicapLineText || "--"} 下模型约 让胜 ${pct(hhadModelProbabilities.home)}% / 让平 ${pct(hhadModelProbabilities.draw)}% / 让负 ${pct(hhadModelProbabilities.away)}%；官方去水约 让胜 ${hhadProbabilities ? pct(hhadProbabilities.home) : "--"}% / 让平 ${hhadProbabilities ? pct(hhadProbabilities.draw) : "--"}% / 让负 ${hhadProbabilities ? pct(hhadProbabilities.away) : "--"}%。`,
        en: `Handicap model on ${handicapLineText || "--"}: home ${pct(hhadModelProbabilities.home)}% / draw ${pct(hhadModelProbabilities.draw)}% / away ${pct(hhadModelProbabilities.away)}%; normalized market is home ${hhadProbabilities ? pct(hhadProbabilities.home) : "--"}% / draw ${hhadProbabilities ? pct(hhadProbabilities.draw) : "--"}% / away ${hhadProbabilities ? pct(hhadProbabilities.away) : "--"}%.`,
      },
      {
        zh: "解读边界：这里是让球盘口径，和普通胜平负分开展示。",
        en: "Boundary: this is the handicap-adjusted result, not the raw 90-minute 1X2 result; the margin note only explains how many goals are needed.",
      },
    ],
    riskTags: handicapBestRiskTags,
    visibilityStatus: "FREE",
    resultStatus: resultStatus(match, hhadBest[0], "BEST_HHAD"),
  } : null;
  const goalsCanCarryBest = false;
  const bestPrefix = bestShouldWatch
    ? { zh: "观察为主", en: "Watch first" }
    : analystSelection.isContrarian
    ? { zh: "价值观察", en: "Value watch" }
    : bestIsSteady
      ? { zh: "稳妥方向", en: "Steady lean" }
      : { zh: "模型首选", en: "Model lean" };
  const watchUsefulnessScore = (() => {
    const leadProbability = Math.max(modelProbabilities.home, modelProbabilities.draw, modelProbabilities.away);
    const handicapBonus = bestHandicapSupport === null ? 0 : Math.min(10, bestHandicapSupport * 16);
    const edgeBonus = modelProbabilityGap * 42;
    const riskPenalty = riskTags.length * 6
      + (oneXTwoGate.reasons || []).filter((reason) => (
        reason.includes("cooldown")
        || reason.includes("weak")
        || reason.includes("thin")
        || reason.includes("risk")
      )).length * 3
      + (bestHasOverheatedFavorite ? 7 : 0)
      + (hasSelectionDisagreement ? 4 : 0);
    return clamp(Math.round(leadProbability * 100 + edgeBonus + handicapBonus - riskPenalty), 28, 68);
  })();
  const bestTrustScore = bestShouldWatch
    ? clamp(watchUsefulnessScore - (bestLaneHardCooldown ? 12 : 0), 22, 62)
    : hasSelectionDisagreement
    ? clamp(oneXTwo.trustScore, 54, 76)
    : bestIsSteady
      ? clamp(oneXTwo.trustScore + 2, 57, 96)
      : clamp(oneXTwo.trustScore - (bestHasThinEdge ? 2 : 0), 52, 82);
  const bestWatchLabelZh = !oneXTwoPromote
    ? "观察为主 条件未齐"
    : bestLaneHardCooldown
    ? "观察为主 命中冷却"
    : bestHasWeakHandicap
    ? "观察为主 防正路过热"
    : bestHasThinEdge
      ? "观察为主 胜平负差距小"
      : "观察为主 风险叠加";
  const bestWatchLabelEn = !oneXTwoPromote
    ? "Watch first: conditions not aligned"
    : bestLaneHardCooldown
    ? "Watch first: hit-rate cooldown"
    : bestHasWeakHandicap
    ? "Watch first: favorite overheated"
    : bestHasThinEdge
      ? "Watch first: thin 1X2 edge"
      : "Watch first: stacked risk";
  const bestNarrative = buildBestNarrative(match, {
    oneXTwo: modelLean,
    bestShouldWatch,
    analystSelection,
    bestIsSteady,
    bestHasWeakHandicap,
    bestHasThinEdge,
    riskTags,
    probabilityGap,
    modelProbabilityGap,
    bestHandicapSupport,
    bestHandicapRelationship,
    totalLambda,
    over25Probability,
    bttsProbability,
    score,
    hhadProbabilities
  });

  const best = handicapBest && hhadCanCarryBest ? handicapBest : goalsCanCarryBest ? {
    marketType: "BEST",
    tipCode: goals.tipCode,
    tipLabel: {
      zh: `进球精选 ${goalsTipLabel.zh}`,
      en: `Goals pick: ${goalsTipLabel.en}`,
    },
    odds: goals.odds,
    trustScore: clamp(goals.trustScore, 62, 76),
    recommendationAction: "recommend",
    recommendationTier: "goals",
    explanation: {
      zh: `胜平负方向处于命中率冷却或盘口分歧中，本场 AI精选切到回测更稳的进球数方向：${goalsTipLabel.zh}。`,
      en: `The 1X2 side is under hit-rate cooldown or market disagreement, so the best tip switches to the better-tested totals lane: ${goalsTipLabel.en}.`,
    },
    analysisItems: [
      ...goals.analysisItems,
      {
        zh: "胜平负条件未齐，精选不强行追正路；仅在进球数边际和回测方向同时满足时输出。",
        en: "The 1X2 gate was not met, so the best tip does not chase the favourite. Totals are promoted only when edge and historical lane agree.",
      },
    ],
    riskTags: goals.riskTags,
    visibilityStatus: "FREE",
    resultStatus: resultStatus(match, goals.tipCode, "GOALS"),
  } : anchorHhadShouldWatch ? {
    marketType: "BEST",
    oddsPoolCode: anchorPoolCode,
    handicapLine: anchorHandicapLine,
    tipCode: "WATCH",
    tipLabel: oneXTwoWatchLabel,
    odds: 0,
    trustScore: clamp(bestTrustScore - 12, 22, 52),
    recommendationAction: "reference",
    recommendationTier: "reference",
    explanation: {
      zh: `让球结果不进入主推荐：模型首选 ${hhadBest?.[3] || "--"}，但官方让球盘第一方向不同，模型方向支持只有 ${pct(hhadMarketSupport || 0)}%。`,
      en: `No HHAD best pick is promoted: the model leader is ${hhadBest?.[4] || "--"}, but the official handicap market leader points elsewhere and support is only about ${pct(hhadMarketSupport || 0)}%.`,
    },
    analysisItems: oneXTwo.analysisItems,
    riskTags: [
      ...oneXTwoRiskTags,
      { zh: "让球盘口反向", en: "HHAD market contradiction" },
    ],
    visibilityStatus: "FREE",
    resultStatus: "PENDING",
  } : oneXTwoModelEdgeIsNoise && bestShouldWatch ? {
    marketType: "BEST",
    oddsPoolCode: anchorPoolCode,
    handicapLine: anchorHandicapLine,
    tipCode: modelLean.tipCode,
    tipLabel: oneXTwoReferenceLabel,
    odds: modelLean.odds,
    trustScore: clamp(bestTrustScore, 22, 54),
    recommendationAction: "reference",
    recommendationTier: "reference",
    explanation: {
      zh: `胜平负不强推：独立模型三项接近，第一方向只领先约 ${pct(modelProbabilityGap)} 个百分点；本场只保留盘口、进球数和临场 SP 复核。`,
      en: `No best 1X2 pick is promoted: the independent model is too tight, with the top side ahead by only about ${pct(modelProbabilityGap)} points. Keep this as market and late-SP review.`,
    },
    analysisItems: oneXTwo.analysisItems,
    riskTags: oneXTwoRiskTags,
    visibilityStatus: "FREE",
    resultStatus: "PENDING",
  } : {
    marketType: "BEST",
    oddsPoolCode: anchorPoolCode,
    handicapLine: anchorHandicapLine,
    tipCode: modelLean.tipCode,
    tipLabel: {
      zh: bestShouldWatch ? `\u53c2\u8003\u503e\u5411 ${modelLean.tipLabel.zh}` : `${bestPrefix.zh} ${modelLean.tipLabel.zh}`,
      en: bestShouldWatch ? `Reference lean: ${modelLean.tipLabel.en}` : `${bestPrefix.en}: ${modelLean.tipLabel.en}`,
    },
    odds: modelLean.odds,
    trustScore: bestTrustScore,
    recommendationAction: bestShouldWatch ? "reference" : "recommend",
    recommendationTier: bestShouldWatch ? "reference" : bestPrefix.en.toLowerCase().replace(/\s+/g, "-").replace(/:$/, ""),
    explanation: bestNarrative.explanation,
    analysisItems: bestNarrative.analysisItems,
    riskTags: bestShouldWatch
      ? [
          ...oneXTwoRiskTags,
          ...(bestLaneHardCooldown ? [{ zh: "精选赛道冷却", en: "Best-lane hit-rate cooldown" }] : []),
        ]
      : riskTags,
    visibilityStatus: "FREE",
    resultStatus: modelLean.resultStatus,
  };

  const inputCoverage = auditableDirectionalInputCoverage(match);
  const unifiedRecommendation = enforceUnifiedPosteriorRecommendation(match, {
    oneXTwo,
    goals,
    best,
    probabilityModel,
    probabilities,
    hhadProbabilities,
    hadOdds,
    hhadOdds,
    anchorHandicapLine,
    contextSignals,
    score,
    inputCoverage,
  });

  const result = {
    predictions: unifiedRecommendation.predictions.map(normalizePredictionDisplayCopy),
    homeLambda,
    awayLambda,
    projectedScore: unifiedRecommendation.projectedScore,
    probabilityModel: {
      ...unifiedRecommendation.probabilityModel,
      inputSufficiency: inputCoverage,
    },
  };
  return !anchorSourceInfo.isOfficial && !inputCoverage.sufficient
    ? suppressUnauditableDirectionalTips(result, inputCoverage)
    : result;
}

function shouldBuildModelOnlyReference(match) {
  const kickoffMs = Date.parse(match?.kickoffTime);
  if (!Number.isFinite(kickoffMs)) return false;
  const now = Date.now();
  const forwardMs = (WINDOW_FORWARD_DAYS + 1) * 24 * 60 * 60 * 1000;
  const recentGraceMs = 3 * 60 * 60 * 1000;
  const status = String(match?.status || "").trim().toUpperCase();
  const preMatchStatus = ["SCHEDULED", "TIMED", "PENDING", "NOT_STARTED"].includes(status);
  return (
    preMatchStatus &&
    kickoffMs >= now - recentGraceMs &&
    kickoffMs <= now + forwardMs
  );
}

function emptyPredictionSet() {
  return {
    predictions: [],
    homeLambda: 0,
    awayLambda: 0,
    projectedScore: undefined,
    probabilityModel: undefined,
  };
}

function toAppMatch(match) {
  const meta = leagueMeta(match.leagueName);
  const homeTeamId = `team_${hashString(match.homeTeam)}`;
  const awayTeamId = `team_${hashString(match.awayTeam)}`;
  const leagueId = `league_${hashString(match.leagueName)}`;
  const parsedHandicapLine = parseHandicapLine(match.handicapLine);
  const normalizedHandicapLine = parsedHandicapLine === null
    ? undefined
    : formatHandicapLineForCopy(parsedHandicapLine);
  const hasOfficialDisplayOdds = match.oddsSource === "sporttery:HAD"
    || (match.handicapOddsSource === "sporttery:HHAD" && parsedHandicapLine !== null);
  const hasFiveHundredDisplayOdds = String(match.oddsSource || "").startsWith("500.com")
    || (String(match.handicapOddsSource || "").startsWith("500.com") && parsedHandicapLine !== null);
  const appSource = !hasOfficialDisplayOdds && hasFiveHundredDisplayOdds
    ? "five-hundred"
    : match.source || (String(match.sourceMethod || "").startsWith("500") ? "five-hundred" : "sporttery");
  const odds = sanitizeOdds(match.odds);
  const handicapOdds = parsedHandicapLine === null ? null : sanitizeOdds(match.handicapOdds);
  const hasPredictionModel = Boolean(odds || handicapOdds);
  const model = hasPredictionModel
    ? predictionSet({ ...match, odds, handicapOdds })
    : shouldBuildModelOnlyReference(match)
      ? predictionSetWithoutOfficialOdds({ ...match, odds: undefined, handicapOdds: undefined })
      : emptyPredictionSet();
  const scoreHome = Number.isFinite(match.scoreHome) ? match.scoreHome : undefined;
  const scoreAway = Number.isFinite(match.scoreAway) ? match.scoreAway : undefined;
  const homeLogo = teamLogoInfo(match.homeTeam, match.homeTeamCode, match.homeTeamLogo);
  const awayLogo = teamLogoInfo(match.awayTeam, match.awayTeamCode, match.awayTeamLogo);
  const kickoffDate = match.matchDate || String(match.kickoffTime || "").slice(0, 10);
  const businessDate = inferSportteryBusinessDate(match.matchNo, kickoffDate)
    || match.businessDate
    || kickoffDate;
  const contextSignals = model.probabilityModel?.contextSignals || {};
  const disciplineSignals = contextSignals.discipline || {};
  const attackIntentSignals = contextSignals.attackIntent || {};
  const rankingPressureSignals = contextSignals.rankingPressure || {};
  return {
    id: `${appSource === "five-hundred" ? "fivehundred" : "sporttery"}_${match.sourceMatchId}`,
    homeTeamId,
    awayTeamId,
    leagueId,
    countryId: meta.countryId,
    kickoffTime: match.kickoffTime,
    status: match.status,
    ...(match.liveScore ? {
      liveScore: {
        ...match.liveScore,
        official: false,
        settlementEligible: false
      }
    } : {}),
    ...(match.resultDisposition === "VOID" ? {
      resultDisposition: "VOID",
      voidReason: match.voidReason,
      voidSource: match.voidSource,
      voidObservedAt: match.voidObservedAt,
      voidSourceUrl: match.voidSourceUrl,
      voidSourceMethod: match.voidSourceMethod,
    } : {}),
    scoreHome,
    scoreAway,
    projectedScoreHome: model.projectedScore?.home,
    projectedScoreAway: model.projectedScore?.away,
    probabilityModel: model.probabilityModel,
    odds: odds || undefined,
    handicapOdds: handicapOdds || undefined,
    predictions: model.predictions,
    worldCupPrior: match.worldCupPrior || undefined,
    externalSignals: match.worldCupPrior
      ? { ...(match.externalSignals || {}), worldCupPrior: match.worldCupPrior }
      : match.externalSignals || undefined,
    ...(model.probabilityModel ? {
    stats: {
      version: "pre-match-model-estimates-v1",
      source: "derived-model-not-observed-match-statistics",
      sourceType: "model-estimate",
      generatedAt: model.probabilityModel.generatedAt || null,
      expectedGoals: {
        home: Number.isFinite(model.homeLambda) ? Number(model.homeLambda.toFixed(2)) : null,
        away: Number.isFinite(model.awayLambda) ? Number(model.awayLambda.toFixed(2)) : null,
      },
      attackIntent: {
        version: attackIntentSignals.version || "attack-intent-model-v1",
        source: attackIntentSignals.source || "derived-pre-match-context",
        home: attackIntentSignals.home,
        away: attackIntentSignals.away,
        total: attackIntentSignals.total,
        dataQuality: attackIntentSignals.dataQuality,
        reasons: attackIntentSignals.reasons,
      },
      rankingPressure: {
        version: rankingPressureSignals.version || "ranking-pressure-model-v1",
        source: rankingPressureSignals.source || "derived-pre-match-context",
        home: rankingPressureSignals.home,
        away: rankingPressureSignals.away,
        maxPressure: rankingPressureSignals.maxPressure,
        rotationRisk: rankingPressureSignals.rotationRisk,
        dataQuality: rankingPressureSignals.dataQuality,
        reasons: rankingPressureSignals.reasons,
      },
      discipline: {
        version: disciplineSignals.version || "discipline-risk-model-v1",
        expectedYellowCards: disciplineSignals.expectedYellowCards,
        redCardRisk: disciplineSignals.redCardRisk,
        expectedFouls: disciplineSignals.expectedFouls,
        foulPressure: disciplineSignals.foulPressure,
        dataQuality: disciplineSignals.dataQuality,
        source: disciplineSignals.source,
        reasons: disciplineSignals.reasons,
      },
      dataGaps: contextSignals.dataGaps,
    },
    } : {}),
    matchDate: kickoffDate,
    kickoffDate,
    businessDate,
    buyEndTime: match.buyEndTime || match.externalSignals?.buyEndTime || match.externalSignals?.fiveHundred?.sale?.buyEndTime,
    homeTeamName: match.homeTeam,
    homeTeamNameEn: match.homeTeam,
    homeRank: match.homeRank,
    homeTeamLogo: homeLogo.logo,
    homeTeamLogoType: homeLogo.logoType,
    homeTeamCountryIso: homeLogo.countryIso,
    homeTeamColor: colorFromName(match.homeTeam),
    awayTeamName: match.awayTeam,
    awayTeamNameEn: match.awayTeam,
    awayRank: match.awayRank,
    awayTeamLogo: awayLogo.logo,
    awayTeamLogoType: awayLogo.logoType,
    awayTeamCountryIso: awayLogo.countryIso,
    awayTeamColor: colorFromName(match.awayTeam),
    leagueName: match.leagueName,
    leagueNameEn: meta.leagueNameEn,
    leagueShortName: meta.leagueShortName,
    leagueShortNameEn: meta.leagueNameEn.slice(0, 12),
    countryName: meta.countryName,
    countryNameEn: meta.countryNameEn,
    countryFlag: meta.countryFlag,
    source: appSource,
    sourceMethod: match.sourceMethod,
    sourceUrl: match.sourceUrl,
    sourceCycleId: match.sourceCycleId,
    sourceObservedAt: match.sourceObservedAt,
    sourceReceivedAt: match.sourceReceivedAt,
    sourceMatchId: match.sourceMatchId,
    eventVersion: match.eventVersion || match.kickoffTime || null,
    resultSource: match.resultSource,
    resultUpdatedAt: match.resultUpdatedAt,
    resultObservedAt: match.resultObservedAt,
    resultObservationSource: match.resultObservationSource,
    resultObservationFallback: match.resultObservationFallback,
    resultSourceUpdatedAt: match.resultSourceUpdatedAt ?? null,
    resultProvenance: match.resultProvenance || null,
    matchNo: match.matchNo,
    oddsSource: match.oddsSource,
    oddsPoolCode: match.oddsPoolCode,
    oddsSourceMethod: match.oddsSourceMethod,
    oddsObservedAt: odds ? match.oddsObservedAt : undefined,
    oddsReceivedAt: odds ? match.oddsReceivedAt : undefined,
    oddsUpdatedAt: match.oddsUpdatedAt,
    oddsSourceUrl: match.oddsSourceUrl,
    oddsMarketProvenance: odds
      ? normalizeTrustedMarketSourceProvenance(match.oddsMarketProvenance)
      : undefined,
    handicapLine: normalizedHandicapLine,
    handicapOddsSource: handicapOdds ? match.handicapOddsSource : undefined,
    handicapOddsPoolCode: handicapOdds ? match.handicapOddsPoolCode : undefined,
    handicapOddsSourceMethod: handicapOdds ? match.handicapOddsSourceMethod : undefined,
    handicapOddsObservedAt: handicapOdds ? match.handicapOddsObservedAt : undefined,
    handicapOddsReceivedAt: handicapOdds ? match.handicapOddsReceivedAt : undefined,
    handicapOddsUpdatedAt: handicapOdds ? match.handicapOddsUpdatedAt : undefined,
    handicapOddsSourceUrl: handicapOdds ? match.handicapOddsSourceUrl : undefined,
    handicapOddsMarketProvenance: handicapOdds
      ? normalizeTrustedMarketSourceProvenance(match.handicapOddsMarketProvenance)
      : undefined,
  };
}

function modelStrategySummary(modelCalibration) {
  return modelCalibration?.strategy ? {
    version: modelCalibration.strategy.version,
    generatedAt: modelCalibration.strategy.generatedAt,
    onlineEffect: modelCalibration.strategy.activation?.onlineEffect || "unknown",
    activeGates: modelCalibration.strategy.activeGates || null,
  } : null;
}

function predictionModelVersionFor(match) {
  return match?.probabilityModel?.version
    || match?.predictionMeta?.modelVersion
    || "unknown-model";
}

function predictionCalibrationVersionFor(match) {
  return match?.probabilityModel?.dynamicCalibration?.version
    || match?.probabilityModel?.lambdaBlend?.scoreCalibrationVersion
    || match?.predictionMeta?.calibrationVersion
    || "uncalibrated";
}

function compactHistoricalSource(source) {
  if (!source || typeof source !== "object") return null;
  return {
    version: source.version || null,
    source: source.source || null,
    signature: source.signature || null,
    rows: source.rows || source.matches || null,
  };
}

function compactFeatureTriplet(value) {
  if (!value || typeof value !== "object") return null;
  return {
    home: Number.isFinite(Number(value.home)) ? Number(Number(value.home).toFixed(3)) : null,
    draw: Number.isFinite(Number(value.draw)) ? Number(Number(value.draw).toFixed(3)) : null,
    away: Number.isFinite(Number(value.away)) ? Number(Number(value.away).toFixed(3)) : null,
  };
}

function compactPublicPredictionSelection(match, marketType) {
  const prediction = enabledPredictions(Array.isArray(match?.predictions) ? match.predictions : [])
    .find((row) => row?.marketType === marketType);
  const poolCode = normText(
    prediction?.oddsPoolCode || (marketType === "1X2" ? "HAD" : "")
  ).toUpperCase();
  const code = normText(prediction?.tipCode).toUpperCase();
  if (!["HAD", "HHAD"].includes(poolCode) || !["1", "X", "2"].includes(code)) return null;
  return {
    marketType,
    poolCode,
    code,
    handicapLine: poolCode === "HHAD"
      ? formatHandicapLineForCopy(prediction?.handicapLine ?? match?.handicapLine)
      : "0",
    recommendationAction: prediction?.recommendationAction || "reference",
  };
}

function marketSourceLineageForMatch(match) {
  return marketSourceLineageId([
    match?.oddsMarketProvenance,
    match?.handicapOddsMarketProvenance,
  ]);
}

function compactMetricOddsTriplet(value) {
  if (!value || typeof value !== "object") return null;
  const metricNumber = (item) => item === null || item === undefined || item === "" ? NaN : Number(item);
  const odds1 = metricNumber(value.odds1);
  const oddsX = metricNumber(value.oddsX);
  const odds2 = metricNumber(value.odds2);
  if (![odds1, oddsX, odds2].every((item) => Number.isFinite(item) && item >= 0)) return null;
  return {
    odds1: Number(odds1.toFixed(3)),
    oddsX: Number(oddsX.toFixed(3)),
    odds2: Number(odds2.toFixed(3)),
  };
}

function buildPredictionFeatureSnapshot(match, explicitCapturedAt = null) {
  const model = match?.probabilityModel || {};
  const odds = sanitizeOdds(match?.odds);
  const parsedHandicapLine = parseHandicapLine(match?.handicapLine);
  const handicapOdds = parsedHandicapLine === null ? null : sanitizeOdds(match?.handicapOdds);
  const hadMarketProvenance = odds
    ? normalizeTrustedMarketSourceProvenance(match?.oddsMarketProvenance)
    : null;
  const hhadMarketProvenance = handicapOdds
    ? normalizeTrustedMarketSourceProvenance(match?.handicapOddsMarketProvenance)
    : null;
  const fiveHundred = match?.externalSignals?.fiveHundred || null;
  const externalUpdatedMs = parseBeijingDateTime(fiveHundred?.updatedAt || match?.externalSignals?.updatedAt || "");
  const snapshotTime = explicitCapturedAt
    || match?.predictionMeta?.decisionGeneratedAt
    || match?.predictionMeta?.generatedAt
    || model?.unifiedPosterior?.generatedAt
    || model.generatedAt
    || match?.predictionMeta?.updatedAt
    || null;
  const snapshotMs = parseBeijingDateTime(snapshotTime);
  const kickoffMs = parseBeijingDateTime(match?.kickoffTime || "");
  const declaredCutoffMs = parseBeijingDateTime(match?.predictionMeta?.cutoffTime || matchCutoffValue(match));
  const cutoffMs = [snapshotMs, kickoffMs, declaredCutoffMs]
    .filter(Number.isFinite)
    .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
  const externalAgeMs = Number.isFinite(externalUpdatedMs) && Number.isFinite(cutoffMs)
    ? cutoffMs - externalUpdatedMs
    : NaN;
  const externalCapturedBeforeCutoff = Number.isFinite(externalUpdatedMs)
    && Number.isFinite(cutoffMs)
    && externalUpdatedMs <= cutoffMs;
  const externalFreshAsOf = externalCapturedBeforeCutoff
    && externalAgeMs <= 72 * 60 * 60 * 1000;
  const featureSnapshot = {
    version: "prediction-feature-snapshot-v4-clock-lineage",
    capturedAt: Number.isFinite(snapshotMs) ? new Date(snapshotMs).toISOString() : null,
    modelGeneratedAt: validAuditInstant(model?.unifiedPosterior?.generatedAt)
      || validAuditInstant(model?.generatedAt)
      || null,
    sourceCycleId: marketSourceLineageForMatch(match)
      || normText(match?.predictionMeta?.sourceCycleId || match?.sourceCycleId)
      || null,
    modelVersion: predictionModelVersionFor(match),
    calibrationVersion: predictionCalibrationVersionFor(match),
    cutoffTime: match?.predictionMeta?.cutoffTime || matchCutoffValue(match) || null,
    source: match?.source || null,
    sourceMatchId: match?.sourceMatchId || null,
    kickoffTime: match?.kickoffTime || null,
    market: {
      had: odds ? {
        odds,
        source: match?.oddsSource || null,
        sourceMethod: match?.oddsSourceMethod || null,
        observedAt: hadMarketProvenance?.timing?.providerObservedAt
          || validAuditInstant(match?.oddsObservedAt)
          || null,
        receivedAt: hadMarketProvenance?.timing?.receivedAt
          || validAuditInstant(match?.oddsReceivedAt),
        updatedAt: match?.oddsUpdatedAt || null,
        provenance: hadMarketProvenance,
        provenanceHash: hadMarketProvenance?.hash || null,
      } : null,
      hhad: handicapOdds ? {
        handicapLine: formatHandicapLineForCopy(parsedHandicapLine),
        odds: handicapOdds,
        source: match?.handicapOddsSource || null,
        sourceMethod: match?.handicapOddsSourceMethod || null,
        observedAt: hhadMarketProvenance?.timing?.providerObservedAt
          || validAuditInstant(match?.handicapOddsObservedAt)
          || null,
        receivedAt: hhadMarketProvenance?.timing?.receivedAt
          || validAuditInstant(match?.handicapOddsReceivedAt),
        updatedAt: match?.handicapOddsUpdatedAt || null,
        provenance: hhadMarketProvenance,
        provenanceHash: hhadMarketProvenance?.hash || null,
      } : null,
      oddsTrend: match?.oddsTrend ? {
        sampleSize: match.oddsTrend.sampleSize || 0,
        firstObservedAt: match.oddsTrend.firstObservedAt || match.oddsTrend.firstCapturedAt || null,
        firstCapturedAt: match.oddsTrend.firstCapturedAt || null,
        lastCapturedAt: match.oddsTrend.lastCapturedAt || null,
        cutoffAt: match.oddsTrend.cutoffAt || null,
        odds1Change: match.oddsTrend.odds1Change ?? null,
        oddsXChange: match.oddsTrend.oddsXChange ?? null,
        odds2Change: match.oddsTrend.odds2Change ?? null,
        direction: match.oddsTrend.direction || null,
      } : null,
      external: fiveHundred ? {
        source: fiveHundred.source || "500.com",
        updatedAt: fiveHundred.updatedAt || null,
        capturedBeforeCutoff: externalCapturedBeforeCutoff,
        freshAsOf: externalFreshAsOf,
        usableForModel: externalFreshAsOf,
        cutoffAt: Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString() : null,
        policy: "as-of-risk-and-consistency-only; no learned weight before sufficient settled snapshots",
        europe: fiveHundred.europeOdds ? {
          companies: Number(fiveHundred.europeOdds.companies || 0),
          currentAverage: sanitizeOdds(fiveHundred.europeOdds.currentAverage),
          initialAverage: sanitizeOdds(fiveHundred.europeOdds.initialAverage),
          currentProbabilityAverage: compactFeatureTriplet(fiveHundred.europeOdds.currentProbabilityAverage),
          officialCurrentProbability: compactFeatureTriplet(fiveHundred.europeOdds.official?.currentProbability),
          officialInitialProbability: compactFeatureTriplet(fiveHundred.europeOdds.official?.initialProbability),
          officialReturnRateCurrent: fiveHundred.europeOdds.official?.returnRateCurrent ?? null,
          officialKellyCurrent: compactMetricOddsTriplet(fiveHundred.europeOdds.official?.kellyCurrent),
        } : null,
        asianHandicap: fiveHundred.asianHandicap ? {
          companies: Number(fiveHundred.asianHandicap.companies || 0),
          currentAverageLine: fiveHundred.asianHandicap.currentAverageLine ?? null,
          initialAverageLine: fiveHundred.asianHandicap.initialAverageLine ?? null,
          lineMovement: fiveHundred.asianHandicap.lineMovement ?? null,
        } : null,
        consensus: fiveHundred.marketConsensus ? {
          riskLevel: fiveHundred.marketConsensus.riskLevel || null,
          homeProbabilityGap: fiveHundred.marketConsensus.homeProbabilityGap ?? null,
          handicapLineGap: fiveHundred.marketConsensus.handicapLineGap ?? null,
        } : null,
      } : null,
    },
    modelInputs: {
      usageSummary: require("../src/services/modelInputUsage.cjs").summarizeModelInputUsage(model, match),
      oneXTwoFinal: compactFeatureTriplet(model.oneXTwo?.final),
      market: compactFeatureTriplet(model.oneXTwo?.market),
      poisson: compactFeatureTriplet(model.oneXTwo?.poisson),
      elo: model.elo ? {
        homeRating: model.elo.homeRating ?? null,
        awayRating: model.elo.awayRating ?? null,
        diff: model.elo.diff ?? null,
        homeMatches: model.elo.homeMatches ?? null,
        awayMatches: model.elo.awayMatches ?? null,
        historicalSource: compactHistoricalSource(model.elo.historicalSource),
      } : null,
      form: model.form ? {
        home: model.form.home ?? model.form.homeScore ?? null,
        away: model.form.away ?? model.form.awayScore ?? null,
        diff: model.form.diff ?? null,
        historicalSource: compactHistoricalSource(model.form.historicalSource),
      } : null,
      leaguePrior: model.leaguePrior ? {
        source: model.leaguePrior.source || null,
        version: model.leaguePrior.trainingVersion || model.leaguePrior.version || null,
        signature: model.leaguePrior.trainingSignature || model.leaguePrior.signature || null,
      } : null,
      lambdaBlend: model.lambdaBlend ? {
        independentHomeLambda: model.lambdaBlend.independentHomeLambda ?? null,
        independentAwayLambda: model.lambdaBlend.independentAwayLambda ?? null,
        independentTotalLambda: model.lambdaBlend.independentTotalLambda ?? null,
        marketHomeLambda: model.lambdaBlend.marketHomeLambda ?? null,
        marketAwayLambda: model.lambdaBlend.marketAwayLambda ?? null,
        leagueHomeLambda: model.lambdaBlend.leagueHomeLambda ?? null,
        leagueAwayLambda: model.lambdaBlend.leagueAwayLambda ?? null,
        formHomeLambda: model.lambdaBlend.formHomeLambda ?? null,
        formAwayLambda: model.lambdaBlend.formAwayLambda ?? null,
        scoreCalibrationVersion: model.lambdaBlend.scoreCalibrationVersion || null,
        scoreTotalLambdaAdjustment: model.lambdaBlend.scoreTotalLambdaAdjustment ?? null,
      } : null,
      worldCupPrior: model.worldCupPrior ? {
        version: model.worldCupPrior.version || null,
        signature: model.worldCupPrior.signature || null,
        source: model.worldCupPrior.source || null,
      } : null,
      dataGaps: model.modelHealth?.dataGaps || match?.stats?.dataGaps || null,
    },
    modelOutputs: {
      had: compactFeatureTriplet(model.oneXTwo?.final),
      hhad: parsedHandicapLine !== null && model.handicap ? {
        handicapLine: formatHandicapLineForCopy(parsedHandicapLine),
        unifiedPosterior: compactFeatureTriplet(model.handicap.unifiedPosterior),
        poisson: compactFeatureTriplet(model.handicap.poisson),
        scoreImplied: compactFeatureTriplet(model.handicap.scoreImplied),
      } : null,
      goals: model.goalLines ? {
        over25: Number.isFinite(Number(model.goalLines.over25)) ? Number(model.goalLines.over25) : null,
        under25: Number.isFinite(Number(model.goalLines.under25)) ? Number(model.goalLines.under25) : null,
      } : null,
      bothTeamsToScore: model.bothTeamsToScore ? {
        yes: Number.isFinite(Number(model.bothTeamsToScore.yes)) ? Number(model.bothTeamsToScore.yes) : null,
        no: Number.isFinite(Number(model.bothTeamsToScore.no)) ? Number(model.bothTeamsToScore.no) : null,
      } : null,
      scoreDistribution: Array.isArray(model.scoreDistribution)
        ? model.scoreDistribution.slice(0, 12).map((row) => ({
            home: Number(row.home),
            away: Number(row.away),
            probability: Number(row.probability),
          }))
        : [],
      unifiedSelection: model.unifiedPosterior ? {
        version: model.unifiedPosterior.version || null,
        market: model.unifiedPosterior.selectedMarket || null,
        code: model.unifiedPosterior.selectedCode || null,
        handicapLine: model.unifiedPosterior.selectedHandicapLine || null,
        recommendationAction: model.unifiedPosterior.recommendationAction || null,
        evidenceVersion: model.unifiedPosterior.multiFactorEvidence?.version || null,
      } : null,
      publicSelections: {
        oneXTwo: compactPublicPredictionSelection(match, "1X2"),
        best: compactPublicPredictionSelection(match, "BEST"),
      },
    },
  };
  return {
    ...featureSnapshot,
    hash: hashString(JSON.stringify(featureSnapshot)),
  };
}

function normalizePredictionAuditMeta(meta, match) {
  const featureSnapshot = meta?.featureSnapshot || buildPredictionFeatureSnapshot({
    ...match,
    predictionMeta: meta,
  }, meta?.generatedAt || null);
  return {
    ...meta,
    modelVersion: meta?.modelVersion || predictionModelVersionFor(match),
    calibrationVersion: meta?.calibrationVersion || predictionCalibrationVersionFor(match),
    cutoffTime: meta?.cutoffTime || matchCutoffValue(match) || undefined,
    featureSnapshot,
    featureSnapshotHash: meta?.featureSnapshotHash || featureSnapshot?.hash || null,
  };
}

function normalizePredictionAuditForPublish(match) {
  if (!match?.predictionMeta) return match;
  return {
    ...match,
    predictionMeta: normalizePredictionAuditMeta(match.predictionMeta, match),
  };
}

function attachCalibrationMetadataToAppMatch(match, modelCalibration) {
  if (!match?.probabilityModel || !modelCalibration) return match;
  const profileKey = predictionProfileKey(match);
  return {
    ...match,
    probabilityModel: {
      ...match.probabilityModel,
      dynamicCalibration: {
        ...(match.probabilityModel.dynamicCalibration || {}),
        version: modelCalibration.version,
        profileKey,
        gate: modelCalibration.gateByProfile?.[profileKey] || match.probabilityModel.dynamicCalibration?.gate || null,
        metrics: modelCalibration.metrics || match.probabilityModel.dynamicCalibration?.metrics || null,
        strategy: modelStrategySummary(modelCalibration),
      },
    },
  };
}

function kickoffHasStarted(match, capturedAt) {
  const kickoffAt = Date.parse(match?.kickoffTime);
  const capturedTime = Date.parse(capturedAt);
  return Number.isFinite(kickoffAt) && Number.isFinite(capturedTime) && capturedTime >= kickoffAt;
}

function parseBeijingDateTime(value) {
  const raw = normText(value);
  if (!raw) return NaN;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    return Date.parse(`${raw.replace(/\s+/, "T")}+08:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return Date.parse(`${raw}+08:00`);
  }
  return Date.parse(raw);
}

function matchCutoffValue(match) {
  return match?.buyEndTime
    || match?.externalSignals?.buyEndTime
    || match?.externalSignals?.fiveHundred?.sale?.buyEndTime
    || match?.kickoffTime
    || "";
}

function cutoffHasPassed(match, capturedAt) {
  const cutoffAt = parseBeijingDateTime(matchCutoffValue(match));
  const capturedTime = Date.parse(capturedAt);
  return Number.isFinite(cutoffAt) && Number.isFinite(capturedTime) && capturedTime >= cutoffAt;
}

function predictionSignature(predictions) {
  const byMarket = new Map((predictions || []).map((prediction) => [prediction.marketType, prediction]));
  return ["1X2", "BEST", "GOALS"]
    .map((marketType) => {
      const prediction = byMarket.get(marketType);
      return prediction ? `${marketType}:${prediction.oddsPoolCode || ""}:${prediction.tipCode}:${prediction.recommendationAction || "recommend"}` : `${marketType}:-`;
    })
    .join("|");
}

function marketEvidenceObservationSignature(value) {
  const provenance = normalizeTrustedMarketSourceProvenance(value);
  if (!provenance) return "--";
  const providerObservedAt = provenance?.timing?.providerObservedAt
    || provenance?.timing?.endpointProviderObservedAt
    || "";
  const extractionHash = provenance?.extraction?.hash || "";
  const strictStatus = provenance?.strict?.eligible === true
    ? "strict"
    : `diagnostic:${(provenance?.strict?.blockers || []).join(",")}`;
  return [
    provenance?.market?.poolCode || "",
    providerObservedAt,
    extractionHash,
    strictStatus,
  ].join(":");
}

function marketSignalSignatureForMatch(match) {
  const odds = sanitizeOdds(match?.odds);
  const handicapOdds = sanitizeHandicapOdds(match);
  const oddsSignature = odds
    ? `${odds.odds1.toFixed(2)}/${odds.oddsX.toFixed(2)}/${odds.odds2.toFixed(2)}`
    : "--";
  const hhadSignature = handicapOdds
    ? `${formatHandicapLineForCopy(match?.handicapLine)}:${handicapOdds.odds1.toFixed(2)}/${handicapOdds.oddsX.toFixed(2)}/${handicapOdds.odds2.toFixed(2)}`
    : "--";
  const trend = match?.oddsTrend || {};
  const trendSignature = Number(trend.sampleSize || 0) >= 2
    ? `${Number(trend.odds1Change || 0).toFixed(3)}/${Number(trend.oddsXChange || 0).toFixed(3)}/${Number(trend.odds2Change || 0).toFixed(3)}`
    : "--";
  const fiveHundred = match?.externalSignals?.fiveHundred || {};
  const europe = fiveHundred.europeOdds?.currentAverage || {};
  const externalSignature = fiveHundred.updatedAt
    ? `${fiveHundred.updatedAt}:${Number(europe.odds1 || 0).toFixed(2)}/${Number(europe.oddsX || 0).toFixed(2)}/${Number(europe.odds2 || 0).toFixed(2)}:${Number(fiveHundred.asianHandicap?.lineMovement || 0).toFixed(3)}:${fiveHundred.marketConsensus?.riskLevel || ""}`
    : "--";
  const hadEvidenceSignature = marketEvidenceObservationSignature(match?.oddsMarketProvenance);
  const hhadEvidenceSignature = marketEvidenceObservationSignature(match?.handicapOddsMarketProvenance);
  return `${oddsSignature}|${hhadSignature}|${trendSignature}|${externalSignature}|${hadEvidenceSignature}|${hhadEvidenceSignature}`;
}

function oddsSignalSignature(rawOdds) {
  const odds = sanitizeOdds(rawOdds);
  return odds ? `${odds.odds1.toFixed(2)}/${odds.oddsX.toFixed(2)}/${odds.odds2.toFixed(2)}` : "";
}

function handicapSignalSignature(match) {
  const handicapOdds = sanitizeHandicapOdds(match);
  if (!handicapOdds) return "";
  const parsedLine = parseHandicapLine(match?.handicapLine);
  const line = parsedLine.toFixed(2);
  return `${line}:${handicapOdds.odds1.toFixed(2)}/${handicapOdds.oddsX.toFixed(2)}/${handicapOdds.odds2.toFixed(2)}`;
}

function hadMarketSignalChanged(existing, fresh) {
  const existingSignature = oddsSignalSignature(existing?.odds);
  const freshSignature = oddsSignalSignature(fresh?.odds);
  return Boolean(existingSignature && freshSignature && existingSignature !== freshSignature);
}

function hhadMarketSignalChanged(existing, fresh) {
  const existingSignature = handicapSignalSignature(existing);
  const freshSignature = handicapSignalSignature(fresh);
  return Boolean(existingSignature && freshSignature && existingSignature !== freshSignature);
}

function marketSignalChanged(existing, fresh) {
  return hadMarketSignalChanged(existing, fresh) || hhadMarketSignalChanged(existing, fresh);
}

function resultMarketForPrediction(prediction) {
  if (prediction?.oddsPoolCode === "HHAD" && ["1", "X", "2"].includes(prediction.tipCode)) {
    return prediction.marketType === "BEST" ? "BEST_HHAD" : "HHAD";
  }
  return prediction?.marketType || "";
}

function settlePredictionsForMatch(match, predictions) {
  return (predictions || []).map((prediction) => {
    const market = resultMarketForPrediction(prediction);
    const isHhad = market === "HHAD" || market === "BEST_HHAD";
    const handicap = isHhad ? resolveHandicapLine(match, prediction) : null;
    return {
      ...prediction,
      ...(isHhad && handicap !== null
        ? { handicapLine: formatHandicapLineForCopy(handicap) }
        : {}),
      resultStatus: prediction.marketType === "BEST" && prediction.tipCode === "WATCH"
        ? "PENDING"
        : resultStatus(match, prediction.tipCode, market, prediction),
    };
  });
}

function settleTrustedPublishedPredictions(match) {
  const predictions = Array.isArray(match?.predictions)
    ? match.predictions.filter(Boolean)
    : [];
  if (!predictions.length) return match;
  if (!isOfficialVoidMatch(match) && !isTrustedFinishedForSettlement(match)) {
    return match;
  }
  return {
    ...match,
    // Result publication is allowed to update only settlement state. The
    // frozen direction, odds, probabilities, feature snapshot and strategy
    // identity remain byte-for-byte owned by the pre-match decision.
    predictions: settlePredictionsForMatch(match, predictions),
  };
}

async function httpGetJson(url, tab = "concern") {
  let payload;
  try {
    payload = await httpGetJsonPrimary(url, tab);
  } catch (error) {
    const initialMarketEndpoint = (
      url === CURRENT_URL
      || url === CALCULATOR_URL
      || url === RESULT_URL
    );
    if (!initialMarketEndpoint || !browserFallbackEnabled()) throw error;
    try {
      payload = (await requestJsonViaEdgeDocument(url)).payload;
    } catch (browserError) {
      browserError.cause = error;
      throw browserError;
    }
  }
  return isOfficialUniformResultUrl(url)
    ? normalizeOfficialUniformResultPayload(payload)
    : payload;
}

function predictionIdentityKey(prediction) {
  if (!prediction) return "";
  return [
    prediction.marketType || "",
    prediction.oddsPoolCode || "",
    prediction.handicapLine ?? "",
    prediction.tipCode || "",
    prediction.recommendationAction || "recommend",
  ].join("|");
}

function refreshLockedPredictionDisplayCopy(existingPredictions, nextPredictions) {
  const nextByIdentity = new Map(
    (nextPredictions || []).map((prediction) => [predictionIdentityKey(prediction), prediction])
  );

  return (existingPredictions || []).map((prediction) => {
    const next = nextByIdentity.get(predictionIdentityKey(prediction));
    const refreshed = next ? {
      ...prediction,
      tipLabel: next.tipLabel || prediction.tipLabel,
      explanation: next.explanation || prediction.explanation,
      analysisItems: next.analysisItems || prediction.analysisItems,
      riskTags: next.riskTags || prediction.riskTags,
      visibilityStatus: next.visibilityStatus || prediction.visibilityStatus,
    } : prediction;

    return normalizePredictionDisplayCopy(refreshed);
  });
}

function normalizeZhDisplayCopy(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/让球防线/g, "让球结果主推")
    .replace(/让球保护参考/g, "让球结果参考")
    .replace(/让球胜平负/g, "让球")
    .replace(/正路优势不足/g, "热门优势不足")
    .replace(/本场不强推 [^；。]+；改用让球/g, "本场不强推普通胜平负单向；改看让球")
    .replace(/本场不强推 [^；。]+；改看让球/g, "本场不强推普通胜平负单向；改看让球")
    .replace(/表达防线/g, "计算后的结果");
}

function normalizePublicPredictionLabel(prediction, label) {
  if (!label || typeof label !== "object") return label;
  const zh = normalizeZhDisplayCopy(label.zh || "");
  const en = String(label.en || "");
  const zhWithoutState = zh
    .replace(/^(?:观察为主|观察|价值观察|参考倾向|参考推荐|参考)\s*[:：]?\s*/u, "")
    .trim();
  const enWithoutState = en
    .replace(/^(?:Watch first|Watch|Value watch|Reference lean|Reference pick|Reference)\s*[:：]?\s*/iu, "")
    .trim();

  if (
    prediction.recommendationAction === "reference"
    && prediction.recommendationTier === "cold-start-reference"
  ) {
    const coldStartZh = zhWithoutState
      .replace(/^\u51b7\u542f\u52a8\u53c2\u8003\s*/u, "")
      .trim();
    const coldStartEn = enWithoutState
      .replace(/^Cold-start reference:\s*/iu, "")
      .trim();
    return {
      ...label,
      zh: `\u53c2\u8003\u63a8\u8350 ${coldStartZh || prediction.tipCode}`,
      en: `Reference pick: ${coldStartEn || prediction.tipCode}`,
    };
  }

  if (prediction.tipCode === "WATCH") {
    return {
      ...label,
      zh: zh.startsWith("暂无推荐") ? zh : `暂无推荐${zhWithoutState ? `：${zhWithoutState}` : "：当前证据不足"}`,
      en: /^No pick\b/i.test(en) ? en : `No pick${enWithoutState ? `: ${enWithoutState}` : ": current evidence is insufficient"}`,
    };
  }

  if (prediction.recommendationAction === "reference") {
    return {
      ...label,
      zh: `参考推荐 ${zhWithoutState || prediction.tipCode}`,
      en: `Reference pick: ${enWithoutState || prediction.tipCode}`,
    };
  }

  return { ...label, zh };
}

function normalizePredictionDisplayCopy(prediction) {
  if (!prediction) return prediction;
  return {
    ...prediction,
    tipLabel: prediction.tipLabel
      ? normalizePublicPredictionLabel(prediction, prediction.tipLabel)
      : prediction.tipLabel,
    explanation: prediction.explanation
      ? { ...prediction.explanation, zh: normalizeZhDisplayCopy(prediction.explanation.zh) }
      : prediction.explanation,
    analysisItems: Array.isArray(prediction.analysisItems)
      ? prediction.analysisItems.map((item) => ({
          ...item,
          zh: normalizeZhDisplayCopy(item.zh),
        }))
      : prediction.analysisItems,
    riskTags: Array.isArray(prediction.riskTags)
      ? prediction.riskTags.map((item) => ({
          ...item,
          zh: normalizeZhDisplayCopy(item.zh),
        }))
      : prediction.riskTags,
  };
}

function predictionContentLocked(match, capturedAt = new Date().toISOString()) {
  const reason = normText(match?.predictionMeta?.lockedReason);
  return Boolean(
    match?.predictionMeta?.lockedAt
    || reason
    || match?.status === "LIVE"
    || match?.status === "PENDING_RESULT"
    || match?.status === "FINISHED"
    || kickoffHasStarted(match, capturedAt)
    || cutoffHasPassed(match, capturedAt)
  );
}

const LOCKED_PREDICTION_CONTENT_FIELDS = Object.freeze([
  "probabilityModel",
  "projectedScoreHome",
  "projectedScoreAway",
  "stats",
  "gptPrediction",
  "odds",
  "oddsSource",
  "oddsPoolCode",
  "oddsSourceMethod",
  "oddsObservedAt",
  "oddsReceivedAt",
  "oddsUpdatedAt",
  "oddsSourceUrl",
  "oddsMarketProvenance",
  "handicapOdds",
  "handicapLine",
  "handicapOddsSource",
  "handicapOddsPoolCode",
  "handicapOddsSourceMethod",
  "handicapOddsObservedAt",
  "handicapOddsReceivedAt",
  "handicapOddsUpdatedAt",
  "handicapOddsSourceUrl",
  "handicapOddsMarketProvenance",
  "oddsTrend",
]);

const LOCKED_PUBLISHED_IDENTITY_FIELDS = Object.freeze([
  "id",
  "source",
  "sourceMethod",
  "sourceUrl",
  "sourceMatchId",
]);

function pickDefinedFields(source, keys) {
  const picked = {};
  if (!source) return picked;
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

const LOCKED_PREDICTION_UPDATE_REASON = Object.freeze({
  zh: "竞彩截止或开赛后，历史预测已冻结；后续同步只更新赛果和命中结算，不重算推荐、概率和预测比分。",
  en: "After Sporttery cutoff or kickoff, the historical forecast is frozen; later syncs only settle results and never recalculate picks, probabilities, or projected score.",
});

const NO_PRE_CUTOFF_PREDICTION_REASON = Object.freeze({
  zh: "\u7ade\u5f69\u622a\u6b62\u6216\u5f00\u8d5b\u524d\u6ca1\u6709\u53ef\u7528\u7684\u5386\u53f2\u9884\u6d4b\u5feb\u7167\uff1b\u4e0d\u5728\u622a\u6b62\u540e\u8865\u751f\u65b0\u63a8\u8350\uff0c\u53ea\u4fdd\u7559\u8d5b\u7a0b\u4e0e\u7ed3\u679c\u4fe1\u606f\u3002",
  en: "No usable pre-cutoff prediction snapshot exists; no new recommendation is backfilled after cutoff or kickoff, and only schedule/result data is kept.",
});

const CUTOFF_CROSSED_DURING_SYNC_REASON = Object.freeze({
  zh: "\u672c\u8f6e\u540c\u6b65\u5f00\u59cb\u65f6\u5c1a\u672a\u622a\u6b62\uff0c\u4f46\u6700\u7ec8\u6a21\u578b\u4e0e\u53d1\u5e03\u95e8\u7981\u5b8c\u6210\u65f6\u5df2\u8de8\u8fc7\u7ade\u5f69\u622a\u6b62\u65f6\u523b\uff1b\u4e0d\u53d1\u5e03\u672c\u8f6e\u65b0\u9884\u6d4b\uff0c\u4e5f\u4e0d\u56de\u586b\u65b0\u63a8\u8350\u3002",
  en: "This sync started before the Sporttery cutoff, but final model publication completed after it; the new forecast is not published or backfilled.",
});

const MARKET_UNCHANGED_PREDICTION_UPDATE_REASON = Object.freeze({
  zh: "\u5b98\u65b9 SP \u6216\u8ba9\u7403\u76d8\u6ca1\u6709\u5b9e\u8d28\u53d8\u5316\uff0c\u539f\u8d5b\u524d\u65b9\u5411\u7ee7\u7eed\u4fdd\u7559\uff1b\u5206\u6790\u7248\u672c\u53ef\u66f4\u65b0\uff0c\u4f46\u4e0d\u91cd\u7b97\u63a8\u8350\u65b9\u5411\u3002",
  en: "Official SP and handicap signals did not materially change, so the pre-match direction is preserved; analysis versions may update, but the recommendation direction is not recalculated.",
});

const ATOMIC_DUAL_MARKET_DECISION_UPDATE_REASON = Object.freeze({
  zh: "\u672c\u573a HAD/HHAD \u5df2\u5f62\u6210\u539f\u5b50\u8d5b\u524d\u51b3\u7b56\uff1b\u540e\u7eed\u540c\u6b65\u53ef\u66f4\u65b0\u5f53\u524d\u5b98\u65b9\u8d54\u7387\uff0c\u4f46\u4e0d\u6539\u5199\u5df2\u53d1\u5e03\u65b9\u5411\u3001\u51b3\u7b56\u6982\u7387\u3001\u7279\u5f81\u5feb\u7167\u548c\u7b56\u7565\u7248\u672c\u3002",
  en: "The HAD/HHAD pair is now one atomic pre-match decision. Later syncs may refresh current official odds, but cannot rewrite its published directions, decision probabilities, feature snapshot, or strategy versions.",
});

function preserveLockedPredictionContent(next, existing, force = false) {
  if (!existing || (!force && !predictionContentLocked(existing))) return next;
  const existingPredictions = enabledPredictions(Array.isArray(existing?.predictions) ? existing.predictions : []);
  const settledPredictions = existingPredictions.length && isPredictionSettlementReady(next)
    ? settlePredictionsForMatch(next, existingPredictions)
    : existingPredictions;
  const nextWithoutPredictionContent = { ...(next || {}) };
  delete nextWithoutPredictionContent.predictions;
  for (const key of LOCKED_PREDICTION_CONTENT_FIELDS) {
    delete nextWithoutPredictionContent[key];
  }
  const identityFields = shouldPreferPublishedIdentity(existing, next)
    ? pickDefinedFields(existing, LOCKED_PUBLISHED_IDENTITY_FIELDS)
    : {};
  return {
    ...nextWithoutPredictionContent,
    ...identityFields,
    ...pickDefinedFields(existing, LOCKED_PREDICTION_CONTENT_FIELDS),
    predictions: settledPredictions,
    predictionMeta: {
      ...(existing.predictionMeta || next.predictionMeta || {}),
      lockedAt: existing.predictionMeta?.lockedAt || next.predictionMeta?.lockedAt,
      lockedReason: existing.predictionMeta?.lockedReason || next.predictionMeta?.lockedReason,
      cutoffTime: existing.predictionMeta?.cutoffTime || next.predictionMeta?.cutoffTime,
      updateReason: LOCKED_PREDICTION_UPDATE_REASON,
    },
  };
}

function enabledPredictions(predictions) {
  return (predictions || []).filter((prediction) => prediction.marketType !== "GG_NG");
}

function trustedPreCutoffDecision(existing, cutoffMs) {
  const predictions = enabledPredictions(Array.isArray(existing?.predictions) ? existing.predictions : []);
  const meta = existing?.predictionMeta || {};
  const decisionMs = Date.parse(meta.decisionGeneratedAt || meta.generatedAt || "");
  const featureCapturedMs = Date.parse(meta.featureSnapshot?.capturedAt || "");
  const baseModelMs = Date.parse(meta.modelGeneratedAt || existing?.probabilityModel?.generatedAt || "");
  const unifiedModelMs = Date.parse(
    meta.unifiedPosteriorGeneratedAt
      || existing?.probabilityModel?.unifiedPosterior?.generatedAt
      || ""
  );
  const featureHash = normText(meta.featureSnapshotHash);
  const embeddedFeatureHash = normText(meta.featureSnapshot?.hash);
  return Boolean(
    predictions.length
    && Number.isFinite(cutoffMs)
    && Number.isFinite(decisionMs)
    && decisionMs < cutoffMs
    && normText(meta.decisionId)
    && Number(meta.decisionRevision || 0) >= 1
    && featureHash
    && featureHash === embeddedFeatureHash
    && Number.isFinite(featureCapturedMs)
    && featureCapturedMs <= decisionMs
    && (!Number.isFinite(baseModelMs) || baseModelMs <= decisionMs)
    && (!Number.isFinite(unifiedModelMs) || unifiedModelMs <= decisionMs)
  );
}

function completeSignedTrainingInputs(match) {
  const elo = match?.probabilityModel?.elo || {};
  const form = match?.probabilityModel?.form || {};
  return Number.isFinite(Number(elo.homeRating))
    && Number.isFinite(Number(elo.awayRating))
    && Number(elo.homeMatches || 0) > 0
    && Number(elo.awayMatches || 0) > 0
    && Number(form?.home?.sampleSize || 0) > 0
    && Number(form?.away?.sampleSize || 0) > 0;
}

function trainingArtifactsForMatch(match) {
  return [
    match?.probabilityModel?.elo?.historicalSource,
    match?.probabilityModel?.form?.historicalSource,
  ].map((source) => ({
    source,
    artifact: source?.releaseArtifact,
  })).filter(({ artifact }) => artifact && typeof artifact === "object");
}

function validatedSignedTrainingArtifact(match) {
  const rows = trainingArtifactsForMatch(match);
  if (rows.length !== 2) return null;
  const validRows = rows.filter(({ source, artifact }) => (
    artifact.sourceKind === "signed-release-asset"
    && artifact.entry === HISTORICAL_TRAINING_RELEASE_ENTRY
    && artifact.validationOk === true
    && /^[a-f0-9]{64}$/i.test(normText(artifact.sha256))
    && Number(source?.rows || 0) > 0
    && Number(artifact.teams || 0) > 0
    && Number(artifact.finiteEloTeams || 0) > 0
  ));
  if (validRows.length !== 2) return null;
  const hashes = new Set(validRows.map(({ artifact }) => normText(artifact.sha256).toLowerCase()));
  if (hashes.size !== 1) return null;
  return {
    sha256: [...hashes][0],
    rows: Math.min(...validRows.map(({ source }) => Number(source.rows))),
    teams: Math.min(...validRows.map(({ artifact }) => Number(artifact.teams))),
    finiteEloTeams: Math.min(...validRows.map(({ artifact }) => Number(artifact.finiteEloTeams))),
  };
}

function strongestTrainingArtifact(match) {
  const rows = trainingArtifactsForMatch(match)
    .filter(({ source, artifact }) => (
      /^[a-f0-9]{64}$/i.test(normText(artifact?.sha256))
      && Number(source?.rows || 0) > 0
    ));
  if (!rows.length) return null;
  return rows.sort((left, right) => (
    Number(right.source?.rows || 0) - Number(left.source?.rows || 0)
    || Number(right.artifact?.finiteEloTeams || 0) - Number(left.artifact?.finiteEloTeams || 0)
  ))[0];
}

function hasFormalPublicationBinding(match) {
  return enabledPredictions(Array.isArray(match?.predictions) ? match.predictions : []).some((prediction) => (
    normText(prediction?.publicationId)
    || (prediction?.publicationEvidence && typeof prediction.publicationEvidence === "object")
    || (prediction?.liveRecommendationAction === "publish"
      && prediction?.livePublicationEvidence
      && typeof prediction.livePublicationEvidence === "object")
  ));
}

const CURRENT_PUBLIC_CONFIDENCE_FIELDS = Object.freeze([
  "modelProbability",
  "evidenceCompleteness",
  "evidenceCompletenessBasis",
  "dataQuality",
  "evidenceScore",
  "marketConsistency",
  "marketConsistencyBasis",
  "calibrationSample",
  "freshnessQuality",
  "freshnessObservedAt",
  "freshnessSourceUpdatedAt",
  "freshnessAsOf",
  "freshnessEvaluatedAt",
  "freshnessAgeSeconds",
  "freshnessSource",
  "freshnessBasis",
]);

function hasCurrentPublicConfidenceContract(prediction) {
  const confidence = prediction?.confidence;
  const publicMetrics = confidence?.publicMetrics;
  return confidence?.version === CONFIDENCE_POLICY_VERSION
    && publicMetrics
    && typeof publicMetrics === "object"
    && CURRENT_PUBLIC_CONFIDENCE_FIELDS.every((field) => (
      Object.prototype.hasOwnProperty.call(publicMetrics, field)
    ));
}

function predictionConfidenceIdentity(prediction) {
  if (!prediction || typeof prediction !== "object") return null;
  const marketType = normText(prediction.marketType).toUpperCase();
  const oddsPoolCode = normText(prediction.oddsPoolCode).toUpperCase();
  const tipCode = normText(prediction.tipCode).toUpperCase();
  const handicapLine = marketType === "BEST" && oddsPoolCode === "HHAD"
    ? normText(prediction.handicapLine)
    : "";
  if (!marketType || !tipCode) return null;
  return [marketType, oddsPoolCode, tipCode, handicapLine].join("|");
}

function enrichMutablePredictionConfidence(existingPredictions, nextPredictions) {
  const nextByIdentity = new Map((nextPredictions || []).map((prediction) => (
    [predictionConfidenceIdentity(prediction), prediction]
  )).filter(([identity]) => Boolean(identity)));
  return (existingPredictions || []).map((prediction) => {
    if (hasCurrentPublicConfidenceContract(prediction)) {
      return normalizePredictionDisplayCopy(prediction);
    }
    const candidate = nextByIdentity.get(predictionConfidenceIdentity(prediction));
    if (!candidate || !hasCurrentPublicConfidenceContract(candidate)) {
      return normalizePredictionDisplayCopy(prediction);
    }
    return normalizePredictionDisplayCopy({
      ...prediction,
      confidence: candidate.confidence,
    });
  });
}

function signedTrainingUpgradeRefresh(existing, candidate, publicationFinalizedAt) {
  if (!existing || !candidate || !predictionPersistenceSameEvent(existing, candidate)) return null;
  if (predictionContentLocked(existing, publicationFinalizedAt)
    || predictionContentLocked(candidate, publicationFinalizedAt)) return null;
  if (hasFormalPublicationBinding(existing)) return null;
  if (!completeSignedTrainingInputs(candidate)) return null;
  const next = validatedSignedTrainingArtifact(candidate);
  if (!next) return null;
  const previousRow = strongestTrainingArtifact(existing);
  const previousSha256 = normText(previousRow?.artifact?.sha256).toLowerCase() || null;
  if (previousSha256 === next.sha256) return null;
  const previousRows = Number(previousRow?.source?.rows || 0);
  const previousFiniteEloTeams = Number(previousRow?.artifact?.finiteEloTeams || 0);
  const existingComplete = completeSignedTrainingInputs(existing);
  const materiallyStronger = !existingComplete
    || next.rows > previousRows
    || next.finiteEloTeams > previousFiniteEloTeams;
  if (!materiallyStronger) return null;
  return {
    version: "signed-training-pre-cutoff-refresh-v1",
    applied: true,
    scope: "same-event-pre-cutoff-unpublished-only",
    previousSha256,
    candidateSha256: next.sha256,
    previousRows,
    candidateRows: next.rows,
    previousFiniteEloTeams,
    candidateFiniteEloTeams: next.finiteEloTeams,
    completedInputs: ["elo-home", "elo-away", "form-home", "form-away"],
    refreshedAt: validAuditInstant(publicationFinalizedAt),
  };
}

function preCutoffModelUpgradeRefresh(existing, candidate, publicationFinalizedAt) {
  if (!existing || !candidate || !predictionPersistenceSameEvent(existing, candidate)) return null;
  if (predictionContentLocked(existing, publicationFinalizedAt)
    || predictionContentLocked(candidate, publicationFinalizedAt)) return null;
  if (hasFormalPublicationBinding(existing)) return null;
  const existingPredictions = enabledPredictions(existing?.predictions);
  const candidatePredictions = enabledPredictions(candidate?.predictions);
  if (!existingPredictions.length || !candidatePredictions.length) return null;
  const previousPolicyVersion = normText(existing?.predictionMeta?.policyVersion);
  if (previousPolicyVersion !== PRE_CUTOFF_MODEL_REFRESH_FROM_POLICY) return null;
  return {
    version: "pre-cutoff-model-upgrade-refresh-v1",
    applied: true,
    scope: "same-event-pre-cutoff-reference-only",
    previousPolicyVersion,
    candidatePolicyVersion: PREDICTION_POLICY_VERSION,
    previousDirectionSignature: predictionSignature(existingPredictions),
    candidateDirectionSignature: predictionSignature(candidatePredictions),
    directionChanged: predictionSignature(existingPredictions) !== predictionSignature(candidatePredictions),
    refreshedAt: validAuditInstant(publicationFinalizedAt),
  };
}

function predictionPersistenceSameEvent(left, right) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const sourceKey = (value) => normText(
    value?.sourceMatchId || value?.matchId || String(value?.id || "").replace(/^[^_]+_/, ""),
  );
  const canonicalClock = (value) => {
    const text = normText(value);
    if (!text) return "";
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
  };
  const leftSource = sourceKey(left);
  const rightSource = sourceKey(right);
  if (!leftSource || !rightSource || leftSource !== rightSource) return false;
  const leftVersion = canonicalClock(left?.eventVersion);
  const rightVersion = canonicalClock(right?.eventVersion);
  if (leftVersion && rightVersion && leftVersion !== rightVersion) return false;
  const leftKickoff = canonicalClock(left?.kickoffTime ?? left?.kickoff);
  const rightKickoff = canonicalClock(right?.kickoffTime ?? right?.kickoff);
  if (!leftKickoff || !rightKickoff || leftKickoff !== rightKickoff) return false;
  const explicitCutoff = (value) => normText(
    value?.predictionMeta?.cutoffTime
      || value?.buyEndTime
      || value?.externalSignals?.buyEndTime
      || value?.externalSignals?.fiveHundred?.sale?.buyEndTime,
  );
  // A previous bad cycle may already have rebound an old locked decision to
  // the reused id's new kickoff. Event-version equality alone cannot repair
  // that contaminated row. The sale/decision cutoff must also plausibly
  // belong to the kickoff before odds, predictions, locks or revisions may be
  // inherited.
  for (const value of [left, right]) {
    const cutoff = explicitCutoff(value);
    const kickoff = value?.kickoffTime ?? value?.kickoff;
    if (cutoff && !sportterySaleClockMatchesEvent(cutoff, kickoff)) return false;
  }
  return true;
}

function applyPredictionPersistence(match, existing, capturedAt, options = {}) {
  // Sporttery provider ids are reused across distinct events. Persistence is
  // allowed to inherit a cutoff, lock, revision or immutable decision only
  // from the exact same event; otherwise an old cutoff can make a newly
  // scheduled match look post-deadline and erase its freshly built reference
  // recommendation.
  existing = existing && predictionPersistenceSameEvent(existing, match) ? existing : null;
  // A fresh provider result has no local archive field. Carry the first
  // validated archive across this merge before any early persistence return;
  // otherwise a later snapshot retention gap can erase an already published
  // direction. Check both event/cutoff contexts and leave signed recovery or
  // independently attested parity correction to the archive authority stage.
  const persistedArchive = validArchivedPreMatchPrediction(existing);
  if (persistedArchive && !isOfficialVoidMatch(match)
    && validArchivedPreMatchPrediction(match, persistedArchive)) {
    match = { ...match, archivedPreMatchPrediction: persistedArchive };
  }
  const existingPredictions = enabledPredictions(Array.isArray(existing?.predictions) ? existing.predictions : []);
  const nextPredictions = enabledPredictions(Array.isArray(match?.predictions) ? match.predictions : []);
  const explicitFinalizedAt = typeof options === "string" ? options : options?.finalizedAt;
  const publicationFinalizedAt = explicitFinalizedAt === undefined ? capturedAt : explicitFinalizedAt;
  const capturedMs = Date.parse(capturedAt || "");
  const finalizedMs = Date.parse(publicationFinalizedAt || "");
  const cutoffCandidates = [
    matchCutoffValue(match),
    match?.predictionMeta?.cutoffTime,
    existing?.predictionMeta?.cutoffTime,
  ]
    .map((value) => ({ value, millis: parseBeijingDateTime(value) }))
    .filter((row) => Number.isFinite(row.millis))
    .sort((a, b) => a.millis - b.millis);
  const cutoffTime = cutoffCandidates[0]?.value || matchCutoffValue(match) || undefined;
  const cutoffMs = cutoffCandidates[0]?.millis ?? NaN;
  const capturedAfterCutoff = Number.isFinite(capturedMs) && Number.isFinite(cutoffMs) && capturedMs >= cutoffMs;
  const finalizedAfterCutoff = Number.isFinite(finalizedMs) && Number.isFinite(cutoffMs) && finalizedMs >= cutoffMs;
  const crossedCutoffDuringSync = !capturedAfterCutoff
    && Number.isFinite(capturedMs)
    && Number.isFinite(finalizedMs)
    && Number.isFinite(cutoffMs)
    && capturedMs < cutoffMs
    && finalizedMs >= cutoffMs;
  const started = kickoffHasStarted(match, publicationFinalizedAt)
    || match.status === "LIVE"
    || match.status === "FINISHED";
  const strategyVersion = match?.probabilityModel?.dynamicCalibration?.strategy?.version || "none";
  const trainingVersion = match?.probabilityModel?.leaguePrior?.trainingVersion
    || match?.probabilityModel?.form?.historicalSource?.version
    || match?.probabilityModel?.elo?.historicalSource?.version
    || "none";
  const trainingSource = match?.probabilityModel?.form?.historicalSource?.source
    || match?.probabilityModel?.elo?.historicalSource?.source
    || match?.probabilityModel?.leaguePrior?.source
    || "none";
  const trainingSignature = match?.probabilityModel?.leaguePrior?.trainingSignature
    || match?.probabilityModel?.form?.historicalSource?.signature
    || match?.probabilityModel?.elo?.historicalSource?.signature
    || trainingVersion;
  const worldCupPriorSignature = match?.probabilityModel?.worldCupPrior?.signature || null;
  const scoreCalibrationVersion = match?.probabilityModel?.lambdaBlend?.scoreCalibrationVersion || null;
  const scoreTotalLambdaAdjustment = Number(match?.probabilityModel?.lambdaBlend?.scoreTotalLambdaAdjustment || 0);
  const scoreBandSignature = JSON.stringify(match?.probabilityModel?.scoreCalibration?.adjustments?.bandRankBoosts || {});
  const scoreShapeSignature = JSON.stringify(match?.probabilityModel?.scoreCalibration?.adjustments?.shapeRankBoosts || {});
  const scoreCalibrationSignature = scoreCalibrationVersion
    ? `${scoreCalibrationVersion}:${scoreTotalLambdaAdjustment.toFixed(3)}:${scoreBandSignature}:${scoreShapeSignature}`
    : null;
  const dataSignature = [
    trainingSignature,
    `application:${HISTORICAL_TRAINING_APPLICATION_VERSION}`,
    worldCupPriorSignature,
    scoreCalibrationSignature,
  ].filter(Boolean).join("|") || trainingVersion;
  const baseModelGeneratedAt = latestExplicitAuditInstant(match?.probabilityModel?.generatedAt);
  const unifiedPosteriorGeneratedAt = latestExplicitAuditInstant(match?.probabilityModel?.unifiedPosterior?.generatedAt);
  // A decision exists only after every probability layer used by the selector
  // has been generated. This is intentionally derived from those real model
  // clocks; the sync-start time must never be used to backfill a decision.
  const decisionGeneratedAt = latestExplicitAuditInstant(
    baseModelGeneratedAt,
    unifiedPosteriorGeneratedAt,
  );
  const decisionGeneratedMs = Date.parse(decisionGeneratedAt || "");
  const modelCompletedAfterCutoff = Number.isFinite(decisionGeneratedMs)
    && Number.isFinite(cutoffMs)
    && decisionGeneratedMs >= cutoffMs;
  const invalidPublicationClock = !Number.isFinite(capturedMs)
    || !Number.isFinite(finalizedMs)
    || finalizedMs < capturedMs
    || (Number.isFinite(decisionGeneratedMs) && finalizedMs < decisionGeneratedMs);
  const locked = started || finalizedAfterCutoff || modelCompletedAfterCutoff || invalidPublicationClock;
  const lockedReason = invalidPublicationClock
    ? "publication-clock-invalid"
    : crossedCutoffDuringSync
      ? "cutoff-crossed-during-sync"
      : modelCompletedAfterCutoff
        ? "model-after-cutoff"
        : finalizedAfterCutoff
          ? "cutoff"
          : started
            ? "kickoff"
            : undefined;
  const trustedExistingDecision = trustedPreCutoffDecision(existing, cutoffMs);
  const publicationGateBase = {
    version: "prediction-publication-cutoff-gate-v1",
    syncCapturedAt: validAuditInstant(capturedAt),
    finalizedAt: validAuditInstant(publicationFinalizedAt),
    cutoffTime: cutoffTime || null,
    crossedCutoffDuringSync,
    syncStartedAfterCutoff: capturedAfterCutoff,
    candidateDecisionGeneratedAt: decisionGeneratedAt,
    trustedExistingPreCutoffDecision: trustedExistingDecision,
  };
  const decisionRevision = Math.max(0, Number(existing?.predictionMeta?.decisionRevision || 0)) + 1;
  const decisionId = `decision_${hashString([
    match?.sourceMatchId || match?.id || "unknown",
    capturedAt,
    PREDICTION_POLICY_VERSION,
    marketSignalSignatureForMatch(match || {}),
  ].join("|"))}`;
  const generatedMeta = normalizePredictionAuditMeta({
    policyVersion: PREDICTION_POLICY_VERSION,
    promptVersion: ANALYST_PROMPT_VERSION,
    strategyVersion,
    trainingVersion,
    trainingSource,
    trainingSignature: dataSignature,
    worldCupPriorSignature,
    scoreCalibrationSignature,
    generatedAt: decisionGeneratedAt,
    modelGeneratedAt: baseModelGeneratedAt,
    unifiedPosteriorGeneratedAt,
    sourceCycleId: marketSourceLineageForMatch(match)
      || normText(match?.sourceCycleId)
      || null,
    decisionId,
    decisionRevision,
    decisionGeneratedAt,
    updatedAt: publicationFinalizedAt,
    syncCapturedAt: validAuditInstant(capturedAt),
    publicationFinalizedAt: validAuditInstant(publicationFinalizedAt),
    publicationGate: {
      ...publicationGateBase,
      status: locked ? (trustedExistingDecision ? "preserved" : "blocked") : "allowed",
      reasonCode: lockedReason || "finalized-before-cutoff",
    },
    lockedAt: locked ? (existing?.predictionMeta?.lockedAt || publicationFinalizedAt) : undefined,
    lockedReason,
    cutoffTime,
    dataPolicy: PREDICTION_DATA_POLICY,
    analystRuntime: ANALYST_RUNTIME,
    analystFramework: PREDICTION_ANALYST_FRAMEWORK,
  }, match);

  const immutableDualMarketDecision = validExistingDualMarketDecisionBinding(existing);
  const trainingUpgradeRefresh = !locked
    ? signedTrainingUpgradeRefresh(existing, match, publicationFinalizedAt)
    : null;
  const modelUpgradeRefresh = !locked
    ? preCutoffModelUpgradeRefresh(existing, match, publicationFinalizedAt)
    : null;
  const publicationGeneratedMeta = trainingUpgradeRefresh || modelUpgradeRefresh
    ? {
        ...generatedMeta,
        ...(trainingUpgradeRefresh ? { trainingUpgradeRefresh } : {}),
        ...(modelUpgradeRefresh ? { modelUpgradeRefresh } : {}),
      }
    : generatedMeta;
  if (
    immutableDualMarketDecision?.featureSnapshot
    && existingPredictions.length
    && sameEvent(existing, match)
    && !isOfficialResultMatch(match)
    && !isOfficialVoidMatch(match)
    && !trainingUpgradeRefresh
    && !modelUpgradeRefresh
  ) {
    return {
      ...match,
      predictions: existingPredictions.map(normalizePredictionDisplayCopy),
      probabilityModel: existing?.probabilityModel || match.probabilityModel,
      projectedScoreHome: existing?.projectedScoreHome ?? match.projectedScoreHome,
      projectedScoreAway: existing?.projectedScoreAway ?? match.projectedScoreAway,
      stats: existing?.stats || match.stats,
      gptPrediction: existing?.gptPrediction || match.gptPrediction,
      predictionMeta: {
        ...(existing?.predictionMeta || generatedMeta),
        dualMarketDecision: immutableDualMarketDecision,
        syncCapturedAt: validAuditInstant(capturedAt),
        publicationFinalizedAt: validAuditInstant(publicationFinalizedAt),
        updatedAt: validAuditInstant(publicationFinalizedAt),
        cutoffTime: existing?.predictionMeta?.cutoffTime || cutoffTime,
        updateReason: ATOMIC_DUAL_MARKET_DECISION_UPDATE_REASON,
      },
    };
  }

  if (isOfficialResultMatch(match)) {
    const { stats, probabilityModel, projectedScoreHome, projectedScoreAway, ...rest } = match;
    void stats;
    void probabilityModel;
    void projectedScoreHome;
    void projectedScoreAway;
    return {
      ...rest,
      predictions: [],
      predictionMeta: publicationGeneratedMeta,
    };
  }

  if (locked && trustedExistingDecision) {
    // A sync that crosses cutoff must preserve the exact pre-cutoff decision.
    // Post-cutoff model output is not allowed to refresh even its supporting
    // copy because that would publish newly generated predictive content.
    const displayRefreshedPredictions = crossedCutoffDuringSync || modelCompletedAfterCutoff
      ? existingPredictions
      : refreshLockedPredictionDisplayCopy(existingPredictions, nextPredictions);
    const lockedMatch = preserveLockedPredictionContent({
      ...match,
      predictionMeta: {
        ...normalizePredictionAuditMeta(existing?.predictionMeta || generatedMeta, existing || match),
        lockedAt: existing?.predictionMeta?.lockedAt || publicationFinalizedAt,
        lockedReason: lockedReason === "cutoff" ? "cutoff" : (existing?.predictionMeta?.lockedReason || lockedReason),
        cutoffTime: existing?.predictionMeta?.cutoffTime || cutoffTime,
        updateReason: crossedCutoffDuringSync
          ? CUTOFF_CROSSED_DURING_SYNC_REASON
          : LOCKED_PREDICTION_UPDATE_REASON,
      },
    }, existing, true);
    return {
      ...lockedMatch,
      predictions: started || isOfficialVoidMatch(match)
        ? settlePredictionsForMatch(match, displayRefreshedPredictions)
        : displayRefreshedPredictions,
      predictionMeta: {
        ...lockedMatch.predictionMeta,
        publicationFinalizedAt: validAuditInstant(publicationFinalizedAt),
        publicationGate: {
          ...publicationGateBase,
          status: "preserved",
          reasonCode: crossedCutoffDuringSync
            ? "cutoff-crossed-during-sync-preserved-trusted-pre-cutoff-decision"
            : "locked-preserved-trusted-pre-cutoff-decision",
        },
        updateReason: crossedCutoffDuringSync
          ? CUTOFF_CROSSED_DURING_SYNC_REASON
          : LOCKED_PREDICTION_UPDATE_REASON,
      },
    };
  }

  if (locked) {
    const {
      predictions,
      probabilityModel,
      projectedScoreHome,
      projectedScoreAway,
      stats,
      gptPrediction,
      ...matchWithoutPredictionContent
    } = match;
    void predictions;
    void probabilityModel;
    void projectedScoreHome;
    void projectedScoreAway;
    void stats;
    void gptPrediction;
    return {
      ...matchWithoutPredictionContent,
      predictions: [],
      predictionMeta: {
        policyVersion: PREDICTION_POLICY_VERSION,
        promptVersion: ANALYST_PROMPT_VERSION,
        syncCapturedAt: validAuditInstant(capturedAt),
        publicationFinalizedAt: validAuditInstant(publicationFinalizedAt),
        lockedAt: validAuditInstant(publicationFinalizedAt) || validAuditInstant(capturedAt),
        lockedReason,
        cutoffTime,
        publicationGate: {
          ...publicationGateBase,
          status: "blocked",
          reasonCode: crossedCutoffDuringSync
            ? "cutoff-crossed-during-sync-no-trusted-pre-cutoff-decision"
            : capturedAfterCutoff
              ? "sync-started-after-cutoff-no-trusted-pre-cutoff-decision"
              : invalidPublicationClock
                ? "invalid-publication-clock-no-trusted-pre-cutoff-decision"
                : "locked-no-trusted-pre-cutoff-decision",
        },
        updateReason: crossedCutoffDuringSync
          ? CUTOFF_CROSSED_DURING_SYNC_REASON
          : NO_PRE_CUTOFF_PREDICTION_REASON,
      },
    };
  }

  if (!existingPredictions.length || !nextPredictions.length) {
    return { ...match, predictionMeta: publicationGeneratedMeta };
  }

  const sameDirection = predictionSignature(existingPredictions) === predictionSignature(nextPredictions);
  const sameMarketSignals = marketSignalSignatureForMatch(existing || {}) === marketSignalSignatureForMatch(match || {});
  const existingProbabilityStrategyVersion = existing?.probabilityModel?.dynamicCalibration?.strategy?.version || "none";
  const existingUnifiedPosteriorVersion = existing?.probabilityModel?.unifiedPosterior?.version || "none";
  const nextUnifiedPosteriorVersion = match?.probabilityModel?.unifiedPosterior?.version || "none";
  const existingMultiFactorPolicyVersion = existingPredictions
    .find((prediction) => prediction?.marketType === "BEST")
    ?.multiFactorEvidence?.version || "none";
  const nextMultiFactorPolicyVersion = nextPredictions
    .find((prediction) => prediction?.marketType === "BEST")
    ?.multiFactorEvidence?.version || "none";
  const existingUnifiedPosteriorLine = existing?.probabilityModel?.unifiedPosterior?.selectedHandicapLine || "none";
  const nextUnifiedPosteriorLine = match?.probabilityModel?.unifiedPosterior?.selectedHandicapLine || "none";
  const policyChanged = existing?.predictionMeta?.policyVersion !== PREDICTION_POLICY_VERSION
    || existing?.predictionMeta?.promptVersion !== ANALYST_PROMPT_VERSION
    || (existing?.predictionMeta?.strategyVersion || "none") !== strategyVersion
    || existingProbabilityStrategyVersion !== strategyVersion
    || existingUnifiedPosteriorVersion !== nextUnifiedPosteriorVersion
    || existingMultiFactorPolicyVersion !== nextMultiFactorPolicyVersion
    || existingUnifiedPosteriorLine !== nextUnifiedPosteriorLine
    || (existing?.predictionMeta?.scoreCalibrationSignature || "none") !== (scoreCalibrationSignature || "none")
    || (existing?.predictionMeta?.trainingSignature || existing?.predictionMeta?.trainingVersion || "none") !== (dataSignature || "none");

  if (sameMarketSignals && !policyChanged) {
    const immutableReferenceDecision = attestImmutableAnalysisReferenceDecision(
      existing?.predictionMeta?.immutableAnalysisReferenceDecision,
      existing,
    );
    const predictionEvidenceIsImmutable = hasFormalPublicationBinding(existing)
      || Boolean(validArchivedPreMatchPrediction(existing))
      || Boolean(immutableReferenceDecision);
    const persistedPredictions = predictionEvidenceIsImmutable
      ? existingPredictions.map(normalizePredictionDisplayCopy)
      : enrichMutablePredictionConfidence(existingPredictions, nextPredictions);
    return {
      ...match,
      predictions: persistedPredictions,
      projectedScoreHome: existing?.projectedScoreHome ?? match.projectedScoreHome,
      projectedScoreAway: existing?.projectedScoreAway ?? match.projectedScoreAway,
      stats: existing?.stats || match.stats,
      probabilityModel: existing?.probabilityModel || match.probabilityModel,
      predictionMeta: {
        ...normalizePredictionAuditMeta(existing?.predictionMeta || generatedMeta, existing || match),
        updatedAt: publicationFinalizedAt,
        dataPolicy: PREDICTION_DATA_POLICY,
        analystRuntime: ANALYST_RUNTIME,
        analystFramework: PREDICTION_ANALYST_FRAMEWORK,
        updateReason: MARKET_UNCHANGED_PREDICTION_UPDATE_REASON,
      },
    };
  }

  if (sameDirection && policyChanged) {
    return {
      ...match,
      predictionMeta: {
        ...publicationGeneratedMeta,
        updateReason: {
          zh: "提示词与展示规则已升级，赛前方向未发生实质变化；保留原预测，只更新分析说明。",
          en: "Prompt and display rules were upgraded while the pre-match direction did not materially change; the old forecast is kept and only the analysis text is refreshed.",
        },
      },
    };
  }

  return {
    ...match,
    predictionMeta: {
      ...publicationGeneratedMeta,
      updateReason: {
        zh: "赛前赔率或让球信号发生实质变化，已生成新的临场预测；开赛后将锁定这版记录。",
          en: "Pre-match odds, handicap signals, or a trusted provider observation changed materially, so a new late forecast was generated and will be locked after kickoff.",
      },
    },
  };
}

function decisionFinalizationInstant(finalizationClock, match, index) {
  if (typeof finalizationClock === "function") return finalizationClock(match, index);
  if (typeof finalizationClock === "string") return finalizationClock;
  if (typeof finalizationClock?.now === "function") return finalizationClock.now(match, index);
  if (finalizationClock && Object.prototype.hasOwnProperty.call(finalizationClock, "finalizedAt")) {
    return finalizationClock.finalizedAt;
  }
  return new Date().toISOString();
}

function finalizePublishedPredictionDecisions(matches, existingBySourceId, capturedAt, finalizationClock) {
  return (matches || []).map((match, index) => {
    const sourceMatchId = matchStoreKey(match);
    const existing = existingBySourceId instanceof Map
      ? existingBySourceId.get(sourceMatchId)
      : null;
    const finalizedAt = decisionFinalizationInstant(finalizationClock, match, index);
    const result = applyPredictionPersistence(match, existing, capturedAt, { finalizedAt });
    const restorationReceipt = retainedRestorationReceipt(result, existing, FROZEN_ARCHIVE_RESTORATION_INDEX, finalizedAt);
    return restorationReceipt ? { ...result, predictionMeta: {
      ...(result.predictionMeta || {}), frozenArchiveRestoration: restorationReceipt,
    } } : result;
  });
}

function attachImmutableAnalysisReferenceDecisions(matches, existingBySourceId, capturedAt) {
  return (matches || []).map((match) => {
    const existing = existingBySourceId instanceof Map
      ? existingBySourceId.get(matchStoreKey(match))
      : null;
    const existingDecision = existing && sameEvent(existing, match)
      ? attestImmutableAnalysisReferenceDecision(
          existing?.predictionMeta?.immutableAnalysisReferenceDecision,
          match,
        )
      : null;
    const currentDecision = attestImmutableAnalysisReferenceDecision(
      match?.predictionMeta?.immutableAnalysisReferenceDecision,
      match,
    );
    const decisionAt = match?.predictionMeta?.publicationFinalizedAt
      || match?.predictionMeta?.updatedAt
      || capturedAt;
    // New records are created only while the sales window is still open. Once
    // present, the same exact event keeps the first valid binding forever; a
    // later heartbeat cannot refresh its direction, quote, clock or hash.
    const signedTrainingRefreshApplied = match?.predictionMeta?.trainingUpgradeRefresh?.applied === true;
    const modelUpgradeRefreshApplied = match?.predictionMeta?.modelUpgradeRefresh?.applied === true;
    const decision = (!(signedTrainingRefreshApplied || modelUpgradeRefreshApplied) ? existingDecision : null)
      || currentDecision
      || buildImmutableAnalysisReferenceDecision(match, decisionAt);
    if (!decision) return match;
    return {
      ...match,
      predictionMeta: {
        ...(match.predictionMeta || {}),
        immutableAnalysisReferenceDecision: decision,
      },
    };
  });
}

function freezePublishedLivePredictionIdentity(match, prediction, publication) {
  if (!prediction || !publication) return prediction;
  const market = publication.market === "HHAD" ? "HHAD" : publication.market === "HAD" ? "HAD" : null;
  const code = ["1", "X", "2"].includes(String(publication.code || ""))
    ? String(publication.code)
    : null;
  const officialSp = Number(publication.officialSp);
  if (!market || !code || !Number.isFinite(officialSp) || officialSp <= 1) return prediction;
  return {
    ...prediction,
    oddsPoolCode: market,
    tipCode: code,
    handicapLine: market === "HHAD" ? String(publication.handicapLine ?? "") : "0",
    odds: officialSp,
    tipLabel: reviewResultLabel(code, market, match),
  };
}

function finalizeLiveRecommendationPublications(matches, capturedAt) {
  const publishedAtMs = parseShanghaiDateTime(capturedAt);
  return (matches || []).map((match) => {
    if (!Array.isArray(match?.predictions)) return match;
    const bestIndex = match.predictions.findIndex((prediction) => prediction?.marketType === "BEST");
    if (bestIndex < 0) return match;
    const best = match.predictions[bestIndex];
    const existingPublication = best?.livePublicationEvidence || null;

    // A valid, immutable publication keeps its original policy/schema version.
    // A later sync may refresh mutable model fields, but must not silently
    // rewrite an already published v1 record into v2 and make it self-invalid.
    if (existingPublication) {
      const publicationBoundBest = freezePublishedLivePredictionIdentity(
        match,
        best,
        existingPublication
      );
      if (isPublishedLiveRecommendationEligible(
        publicationBoundBest,
        existingPublication.officialSp,
        existingPublication.handicapLine,
        match
      )) {
        const predictions = [...match.predictions];
        predictions[bestIndex] = publicationBoundBest;
        return { ...match, predictions };
      }
    }

    // Once a live recommendation has been published, its immutable identity
    // remains authoritative throughout the match lifecycle. Later source
    // refreshes may overwrite BEST with the current market line/SP; repair
    // those identity fields without creating a new publication or changing
    // any of the original live recommendation metadata.
    if (match.status !== "SCHEDULED") {
      if (!existingPublication) return match;
      const publicationBoundBest = freezePublishedLivePredictionIdentity(
        match,
        best,
        existingPublication
      );
      if (!isPublishedLiveRecommendationEligible(
        publicationBoundBest,
        existingPublication.officialSp,
        existingPublication.handicapLine,
        match
      )) return match;
      const predictions = [...match.predictions];
      predictions[bestIndex] = publicationBoundBest;
      return { ...match, predictions };
    }

    const officialOdds = officialOddsForLivePrediction(match, best);
    const officialOddsFreshness = officialOddsFreshnessForLivePrediction(match, best, publishedAtMs);
    const officialHandicapLine = best?.oddsPoolCode === "HHAD" ? match?.handicapLine : 0;
    const evaluated = evaluateLiveRecommendation(best, officialOdds, officialHandicapLine);
    const publication = existingPublication || buildLivePublicationEvidence(match, best, publishedAtMs);
    const publicationBoundBest = existingPublication
      ? freezePublishedLivePredictionIdentity(match, best, existingPublication)
      : best;
    const candidate = { ...publicationBoundBest, livePublicationEvidence: publication };
    const publicationValid = Boolean(publication) && isLivePublicationEvidenceValid(
      match,
      candidate,
      officialOdds,
      officialHandicapLine
    );
    const allowed = Boolean(
      evaluated.eligible
      && publicationValid
      && hasOfficialSportterySourceForLivePrediction(match, best)
      && officialOddsFreshness.eligible
      && isLiveRecommendationWindowOpen(match, publishedAtMs)
    );
    const finalizedBest = {
      ...publicationBoundBest,
      liveRecommendationAction: allowed ? "recommend" : "withhold",
      liveRecommendationTier: allowed
        ? `live-${String(evaluated.grade || "c").toLowerCase()}`
        : "live-withhold",
      liveRecommendation: {
        ...evaluated,
        eligible: allowed,
        grade: allowed ? evaluated.grade : "WITHHOLD",
        blockers: [...new Set([
          ...(evaluated.blockers || []),
          ...(!publication ? ["live-publication-evidence-missing"] : []),
          ...(publication && !publicationValid ? ["live-publication-binding-stale"] : []),
          ...(!isLiveRecommendationWindowOpen(match, publishedAtMs) ? ["live-window-closed"] : []),
          ...(!hasOfficialSportterySourceForLivePrediction(match, best) ? ["unverified-official-source"] : []),
          ...(!officialOddsFreshness.eligible ? ["official-sp-clock-missing-or-stale"] : []),
        ])],
      },
      // Existing evidence is immutable. A later SP/line/direction change keeps
      // the original binding and therefore causes the server gate to withhold.
      livePublicationEvidence: publication,
    };
    const predictions = [...match.predictions];
    predictions[bestIndex] = finalizedBest;
    return { ...match, predictions };
  });
}

function withoutFormalPublicationBinding(prediction) {
  if (!prediction) return prediction;
  const {
    publicationId,
    publicationEvidence,
    ...unbound
  } = prediction;
  void publicationId;
  void publicationEvidence;
  return unbound;
}

function failClosedScheduledPublicationBindings(matches, publicationIndex) {
  return (matches || []).map((match) => {
    if (match?.status !== "SCHEDULED" || !Array.isArray(match?.predictions)) return match;
    let changed = false;
    const predictions = match.predictions.map((prediction) => {
      if (prediction?.marketType !== "BEST") return prediction;
      if (resolvePublishedRecommendation(match, prediction, publicationIndex)) return prediction;
      if (!prediction.publicationId && !prediction.publicationEvidence) return prediction;
      changed = true;
      return withoutFormalPublicationBinding(prediction);
    });
    return changed ? { ...match, predictions } : match;
  });
}

function bindPredictionToPublicationRecord(match, prediction, record) {
  if (!record) return null;
  const bound = {
    ...withoutFormalPublicationBinding(prediction),
    publicationId: record.publicationId,
    publicationEvidence: publicationBindingForRecord(record),
  };
  const singleRecordIndex = {
    valid: true,
    byId: new Map([[record.publicationId, record]]),
  };
  return resolvePublishedRecommendation(match, bound, singleRecordIndex) ? bound : null;
}

function canonicalPublicationInstant(value) {
  const millis = parseShanghaiDateTime(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function formalPublicationInput(match, prediction) {
  const liveEvidence = prediction?.livePublicationEvidence;
  const strategyVersion = normText(
    match?.predictionMeta?.strategyVersion
    || match?.predictionMeta?.policyVersion
    || prediction?.multiFactorEvidence?.version
    || liveEvidence?.policyVersion
    || PREDICTION_POLICY_VERSION
  );
  const decisionSnapshot = buildCandidateDecisionSnapshot(
    match,
    liveEvidence?.publishedAt,
    { collectorTrustRegistry: COLLECTOR_TRUST_REGISTRY }
  );
  return {
    publishedAt: liveEvidence?.publishedAt,
    cutoffTime: liveEvidence?.cutoffAt,
    matchId: match?.id,
    sourceMatchId: match?.sourceMatchId,
    selectionRole: "BEST",
    marketType: prediction?.oddsPoolCode,
    tipCode: prediction?.tipCode,
    handicapLine: prediction?.oddsPoolCode === "HHAD"
      ? liveEvidence?.handicapLine
      : 0,
    odds: liveEvidence?.officialSp,
    strategyVersion,
    strategyHash: hashPublicationEvidence({
      predictionPolicyVersion: match?.predictionMeta?.policyVersion || PREDICTION_POLICY_VERSION,
      promptVersion: match?.predictionMeta?.promptVersion || ANALYST_PROMPT_VERSION,
      strategyVersion,
      multiFactorPolicyVersion: prediction?.multiFactorEvidence?.version || null,
      livePolicyVersion: liveEvidence?.policyVersion || null,
    }),
    evidenceHash: hashPublicationEvidence({
      livePublicationEvidence: liveEvidence,
      multiFactorEvidence: prediction?.multiFactorEvidence || null,
    }),
    // The v1 ledger stores only the immutable feature hash, not the full
    // probability vector. Formal Brier/log-loss therefore remains disabled
    // until a future schema explicitly archives the vector itself.
    featureHash: hashPublicationEvidence({
      decisionSnapshotVersion: decisionSnapshot?.version || DECISION_SNAPSHOT_VERSION,
      policyHash: decisionSnapshot?.policyHash || null,
      featureSnapshotHash: decisionSnapshot?.featureSnapshotHash || null,
      sourceCycleId: decisionSnapshot?.sourceCycleId
        || match?.predictionMeta?.sourceCycleId
        || match?.sourceCycleId
        || null,
      selectedCandidateKey: decisionSnapshot?.selectedCandidateKey || null,
      probabilities: decisionSnapshot?.probabilities || null,
    }),
  };
}

function isStrictFormalPublicationCandidate(match, prediction, capturedAtMs) {
  if (
    match?.status !== "SCHEDULED"
    || normText(match?.source).toLowerCase() !== "sporttery"
    || prediction?.marketType !== "BEST"
    || prediction?.recommendationAction !== "recommend"
    || prediction?.liveRecommendationAction !== "recommend"
    || prediction?.liveRecommendation?.eligible !== true
    || !isLiveRecommendationWindowOpen(match, capturedAtMs)
  ) return false;
  const officialOdds = officialOddsForLivePrediction(match, prediction);
  const officialHandicapLine = prediction?.oddsPoolCode === "HHAD" ? match?.handicapLine : 0;
  return Boolean(
    hasOfficialSportterySourceForLivePrediction(match, prediction)
    && officialOddsFreshnessForLivePrediction(match, prediction, capturedAtMs).eligible
    && isLivePublicationEvidenceValid(
      match,
      prediction,
      officialOdds,
      officialHandicapLine,
      prediction.livePublicationEvidence
    )
  );
}

function publicationRecordMatchesLiveEvidence(match, prediction, record) {
  const liveEvidence = prediction?.livePublicationEvidence;
  return Boolean(
    liveEvidence
    && record?.publishedAt === canonicalPublicationInstant(liveEvidence.publishedAt)
    && record?.cutoffTime === canonicalPublicationInstant(liveEvidence.cutoffAt)
    && bindPredictionToPublicationRecord(match, prediction, record)
  );
}

function commitRecommendationPublicationLedger(matches, capturedAt, options = {}) {
  const ledgerPath = path.resolve(
    options.ledgerPath || RECOMMENDATION_PUBLICATION_LEDGER_PATH
  );
  const ledgerLoader = options.ledgerLoader || loadPublicationLedger;
  const persistLedger = options.persistLedger || writeJson;
  const acquireCommitLock = options.acquireCommitLock || acquireSyncMetaCommitLock;
  const capturedAtMs = parseShanghaiDateTime(capturedAt);
  let output = (matches || []).map((match) => (
    Array.isArray(match?.predictions)
      ? { ...match, predictions: [...match.predictions] }
      : match
  ));
  let ledgerLoad = null;
  let publicationIndex = null;
  let commitLock = null;
  const summary = {
    version: "recommendation-publication-commit-v1",
    status: "not-run",
    attempted: 0,
    staged: 0,
    appended: 0,
    reused: 0,
    conflicts: 0,
    skipped: 0,
    errors: [],
  };

  try {
    commitLock = acquireCommitLock({ filePath: ledgerPath });
    ledgerLoad = ledgerLoader(ledgerPath);
    publicationIndex = buildPublicationLedgerIndex(ledgerLoad);
    output = failClosedScheduledPublicationBindings(output, publicationIndex);
    if (!publicationIndex.valid) {
      summary.status = "invalid-ledger-fail-closed";
      summary.errors = publicationIndex.errors.slice(0, 10);
      return { matches: output, ledgerLoad, publicationIndex, summary };
    }

    let nextLedger = ledgerLoad.payload;
    const stagedBindings = [];
    for (let matchIndex = 0; matchIndex < output.length; matchIndex += 1) {
      const match = output[matchIndex];
      if (match?.status !== "SCHEDULED" || !Array.isArray(match?.predictions)) continue;
      const bestIndex = match.predictions.findIndex((prediction) => prediction?.marketType === "BEST");
      if (bestIndex < 0) continue;
      const best = match.predictions[bestIndex];
      const verifiedExisting = resolvePublishedRecommendation(match, best, publicationIndex);
      if (verifiedExisting) {
        summary.reused += 1;
        continue;
      }

      output[matchIndex] = {
        ...match,
        predictions: match.predictions.map((prediction, index) => (
          index === bestIndex ? withoutFormalPublicationBinding(prediction) : prediction
        )),
      };
      const unboundBest = output[matchIndex].predictions[bestIndex];
      if (!isStrictFormalPublicationCandidate(output[matchIndex], unboundBest, capturedAtMs)) {
        summary.skipped += 1;
        continue;
      }
      summary.attempted += 1;

      const existingSelectionRecords = nextLedger.rows.filter((record) => (
        record.matchId === output[matchIndex].id
        && record.sourceMatchId === output[matchIndex].sourceMatchId
        && record.selectionRole === "BEST"
      ));
      const reusableRecord = existingSelectionRecords.find((record) => (
        publicationRecordMatchesLiveEvidence(output[matchIndex], unboundBest, record)
      ));
      if (reusableRecord) {
        stagedBindings.push({ matchIndex, bestIndex, publicationId: reusableRecord.publicationId });
        summary.reused += 1;
        continue;
      }
      // The first immutable BEST publication owns the event. A later model,
      // line or direction cannot append a second formal history row.
      if (existingSelectionRecords.length > 0) {
        summary.conflicts += 1;
        continue;
      }

      const appended = appendPublicationRecord(
        nextLedger,
        formalPublicationInput(output[matchIndex], unboundBest)
      );
      nextLedger = appended.ledger;
      stagedBindings.push({
        matchIndex,
        bestIndex,
        publicationId: appended.record.publicationId,
      });
      summary.staged += 1;
    }

    if (summary.staged > 0) {
      persistLedger(ledgerPath, nextLedger);
      const persistedLoad = ledgerLoader(ledgerPath);
      const persistedIndex = buildPublicationLedgerIndex(persistedLoad);
      const expectedIndex = buildPublicationLedgerIndex(nextLedger);
      if (
        !persistedIndex.valid
        || persistedIndex.rows !== expectedIndex.rows
        || persistedIndex.headHash !== expectedIndex.headHash
      ) {
        const error = new Error("recommendation publication ledger persistence verification failed");
        error.code = "RECOMMENDATION_PUBLICATION_LEDGER_VERIFY_FAILED";
        throw error;
      }
      ledgerLoad = persistedLoad;
      publicationIndex = persistedIndex;
      summary.appended = summary.staged;
    }

    for (const staged of stagedBindings) {
      const match = output[staged.matchIndex];
      const prediction = match?.predictions?.[staged.bestIndex];
      const record = publicationIndex.byId.get(staged.publicationId);
      const bound = bindPredictionToPublicationRecord(match, prediction, record);
      if (!bound) {
        summary.errors.push(`binding-verification-failed:${staged.publicationId}`);
        continue;
      }
      const predictions = [...match.predictions];
      predictions[staged.bestIndex] = bound;
      output[staged.matchIndex] = { ...match, predictions };
    }
    summary.status = summary.errors.length > 0
      ? "binding-fail-closed"
      : summary.appended > 0
        ? "committed"
        : summary.reused > 0
          ? "reused"
          : "no-eligible-publications";
    return { matches: output, ledgerLoad, publicationIndex, summary };
  } catch (error) {
    summary.status = "write-failed-closed";
    summary.errors.push(String(error?.code || error?.message || error));
    if (!publicationIndex) {
      ledgerLoad = ledgerLoad || ledgerLoader(ledgerPath);
      publicationIndex = buildPublicationLedgerIndex(ledgerLoad);
    }
    output = failClosedScheduledPublicationBindings(output, publicationIndex);
    return { matches: output, ledgerLoad, publicationIndex, summary };
  } finally {
    commitLock?.release();
  }
}

function buildLiveRecommendationAuditSummary(matches, capturedAt) {
  const checkedAtMs = parseShanghaiDateTime(capturedAt);
  const rows = [];
  for (const match of matches || []) {
    if (!isLiveRecommendationWindowOpen(match, checkedAtMs)) continue;
    const prediction = (match?.predictions || []).find((row) => row?.marketType === "BEST");
    if (!prediction) continue;
    const officialSp = officialOddsForLivePrediction(match, prediction);
    const officialHandicapLine = prediction?.oddsPoolCode === "HHAD" ? match?.handicapLine : 0;
    const publication = prediction?.livePublicationEvidence;
    const eligible = Boolean(
      prediction?.liveRecommendationAction === "recommend"
      && prediction?.liveRecommendation?.eligible === true
      && hasOfficialSportterySourceForLivePrediction(match, prediction)
      && evaluateLiveRecommendation(prediction, officialSp, officialHandicapLine).eligible
      && isLivePublicationEvidenceValid(
        match,
        prediction,
        officialSp,
        officialHandicapLine,
        publication
      )
    );
    if (!eligible) continue;
    rows.push({
      matchId: match.id,
      sourceMatchId: match.sourceMatchId,
      homeTeamName: match.homeTeamName,
      awayTeamName: match.awayTeamName,
      pool: prediction.oddsPoolCode,
      tipCode: prediction.tipCode,
      handicapLine: prediction.oddsPoolCode === "HHAD" ? publication?.handicapLine || null : "0",
      officialSp,
      grade: prediction.liveRecommendation?.grade || null,
      evidenceScore: prediction.liveRecommendation?.evidenceScore ?? null,
      probabilityEdge: prediction.liveRecommendation?.probabilityEdge ?? null,
      expectedValue: prediction.liveRecommendation?.expectedValue ?? null,
      coverageMode: prediction.liveRecommendation?.coverageMode || null,
      dataCoverageWarning: prediction.liveRecommendation?.dataCoverageWarning === true,
      publishedAt: publication?.publishedAt || null,
      cutoffAt: publication?.cutoffAt || null,
    });
  }
  return {
    version: LIVE_RECOMMENDATION_POLICY_VERSION,
    checkedAt: Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : capturedAt,
    qualifiedCount: rows.length,
    rows,
  };
}

function stripOfficialResultOnlyPredictionContent(match) {
  const isPublishedResultOnly = match?.status === "FINISHED" && match?.oddsSource !== "sporttery:HAD";
  const isAttributedFiveHundredResult = isFallbackResultMatch(match);
  if (!isOfficialResultMatch(match) && !(isPublishedResultOnly && !isAttributedFiveHundredResult)) return match;
  const {
    predictions,
    probabilityModel,
    projectedScoreHome,
    projectedScoreAway,
    stats,
    gptPrediction,
    ...rest
  } = match;
  void predictions;
  void probabilityModel;
  void projectedScoreHome;
  void projectedScoreAway;
  void stats;
  void gptPrediction;
  return {
    ...rest,
    predictions: [],
    predictionMeta: {
      ...(match.predictionMeta || {}),
      lockedAt: match.predictionMeta?.lockedAt || match.resultUpdatedAt || match.kickoffTime,
      lockedReason: match.predictionMeta?.lockedReason || "result-only",
      updateReason: NO_PRE_CUTOFF_PREDICTION_REASON,
    },
  };
}

function hasObservedMatchStatsProvenance(stats) {
  if (!stats || typeof stats !== "object") return false;
  if (stats.observed === true || stats.provenance?.observed === true) return true;
  const sourceType = normText(stats.sourceType || stats.provenance?.sourceType).toLowerCase();
  if (["observed", "official-post-match", "provider-post-match"].includes(sourceType)) return true;
  const source = normText(stats.source || stats.provenance?.source).toLowerCase();
  return Boolean(stats.version && /api-football|official.*result|sporttery.*stat/.test(source));
}

function sanitizeSyntheticMatchStats(match) {
  const stats = match?.stats;
  if (!stats || typeof stats !== "object" || hasObservedMatchStatsProvenance(stats)) return match;
  const sanitized = { ...stats };
  for (const key of [
    "xG",
    "possession",
    "shots",
    "shotsOnTarget",
    "corners",
    "fouls",
    "offsides",
    "yellowCards",
    "redCards",
  ]) {
    delete sanitized[key];
  }
  return {
    ...match,
    stats: {
      ...sanitized,
      version: stats.version || "pre-match-model-estimates-v1",
      source: stats.source || "legacy-unverified-match-facts-removed",
      sourceType: "model-estimate",
      generatedAt: stats.generatedAt || match?.probabilityModel?.generatedAt || match?.predictionMeta?.generatedAt || null,
      observedMatchFactsRemoved: true,
    },
  };
}

async function fetchSportteryMatches() {
  resetSportteryFetchSummary();
  if (process.env.SKIP_SPORTTERY_FETCH === "1") {
    console.log("Sporttery fetch skipped by SKIP_SPORTTERY_FETCH=1; using existing store and external signals.");
    return [];
  }

  const relaySnapshot = loadSportteryRelaySnapshot();
  const relayMatches = relaySnapshot ? dedupeMatches(matchesFromSportteryRelaySnapshot(relaySnapshot)) : [];
  if (relayMatches.length) {
    console.log(`Sporttery relay snapshot ok: ${relayMatches.length} matches ${JSON.stringify(relaySnapshot.summary)}`);
  }
  if (relayMatches.length && SPORTTERY_RELAY_MODE !== "fallback") {
    sportteryFetchSummary = withSportteryFetchSummary({
      transport: "relay",
      relaySnapshot: publicRelaySnapshotSummary(relaySnapshot.summary),
    });
    return relayMatches;
  }

  // Current odds and official result publication have different freshness
  // semantics. A stale current market lane must never authorize new odds or
  // recommendations, but immutable terminal rows from a still-fresh history
  // lane remain valid result evidence. Keeping this lane independent prevents
  // a 20-minute odds freshness timeout from suppressing already captured
  // official finals and voids.
  const historySnapshot = relayMatches.length ? null : loadSportteryRelayHistorySnapshot();
  const historyMatches = historySnapshot
    ? dedupeMatches(matchesFromSportteryRelaySnapshot(historySnapshot))
      .filter((match) => isOfficialResultMatch(match) || isOfficialVoidMatch(match))
    : [];
  if (historyMatches.length) {
    console.log(
      `Sporttery relay history-only snapshot ok: ${historyMatches.length} terminal matches ${JSON.stringify(historySnapshot.summary)}`,
    );
    sportteryFetchSummary = withSportteryFetchSummary({
      transport: "relay-history-only",
      relaySnapshot: publicRelaySnapshotSummary(historySnapshot.summary),
    });
    return historyMatches;
  }

  if (SKIP_SPORTTERY_DIRECT_FETCH) {
    sportteryFetchSummary = withSportteryFetchSummary({
      transport: relayMatches.length ? "relay-fallback" : "direct-disabled",
      relaySnapshot: publicRelaySnapshotSummary(relaySnapshot?.summary),
    });
    if (relayMatches.length) return relayMatches;
    console.log("Sporttery direct fetch disabled by SKIP_SPORTTERY_DIRECT_FETCH=1; no fresh relay snapshot available.");
    return [];
  }

  const directMatches = await fetchSportteryMatchesDirect();
  if (directMatches.length) {
    sportteryFetchSummary = withSportteryFetchSummary({
      transport: sportteryOutboundProxy() ? "proxy" : "direct",
      relaySnapshot: publicRelaySnapshotSummary(relaySnapshot?.summary),
    });
    return directMatches;
  }

  if (relayMatches.length) {
    sportteryFetchSummary = withSportteryFetchSummary({
      transport: "relay-fallback",
      relaySnapshot: publicRelaySnapshotSummary(relaySnapshot.summary),
    });
    return relayMatches;
  }

  sportteryFetchSummary = withSportteryFetchSummary({
    transport: sportteryOutboundProxy() ? "proxy" : "direct",
    relaySnapshot: publicRelaySnapshotSummary(relaySnapshot?.summary),
  });
  return [];
}

function readJsonArray(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadUnresolvedMatchArchive() {
  if (!fs.existsSync(UNRESOLVED_MATCH_ARCHIVE_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(UNRESOLVED_MATCH_ARCHIVE_PATH, "utf8"));
    const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function loadExistingMatchStore() {
  const publicDir = path.join(__dirname, "..", "public");
  const historyFile = path.join(publicDir, "data", "matches-history.json");
  const files = [
    path.join(publicDir, "matches.json"),
    path.join(publicDir, "data", "matches-current.json"),
    historyFile,
  ];
  const byId = new Map();
  let historyRows = 0;
  for (const file of files) {
    const rows = readJsonArray(file);
    if (file === historyFile) historyRows = rows.length;
    for (const match of rows) {
      const key = matchStoreKey(match);
      if (!key) continue;
      const existing = byId.get(key);
      byId.set(key, existing ? mergeStoredPublishedMatch(existing, match) : bindCanonicalMatchIdentity(match, key));
    }
  }
  for (const match of loadUnresolvedMatchArchive()) {
    const key = matchStoreKey(match);
    if (!key) continue;
    const existing = byId.get(key);
    byId.set(key, existing ? mergeStoredPublishedMatch(existing, match) : bindCanonicalMatchIdentity(match, key));
  }
  return {
    matches: Array.from(byId.values()),
    historyRows,
  };
}

function publishedIdentityRank(match) {
  let rank = 0;
  // A trusted terminal observation is irreversible lifecycle evidence and must
  // outrank any scheduled/reference row that happens to be read later.
  if (isOfficialSportteryFinal(match)) rank += 32;
  if (String(match?.id || "").startsWith("sporttery_")) rank += 8;
  if (match?.source === "sporttery") rank += 4;
  if (hasPublishedOfficialOdds(match)) rank += 2;
  if (match?.predictionMeta?.lockedAt || match?.predictionMeta?.snapshot?.latestSignature) rank += 1;
  return rank;
}

function shouldPreferPublishedIdentity(candidate, existing) {
  const candidateRank = publishedIdentityRank(candidate);
  const existingRank = publishedIdentityRank(existing);
  if (candidateRank !== existingRank) return candidateRank > existingRank;
  const candidateUpdated = Date.parse(candidate?.resultObservedAt || candidate?.resultSourceUpdatedAt || candidate?.predictionMeta?.updatedAt || candidate?.oddsUpdatedAt || candidate?.kickoffTime || "");
  const existingUpdated = Date.parse(existing?.resultObservedAt || existing?.resultSourceUpdatedAt || existing?.predictionMeta?.updatedAt || existing?.oddsUpdatedAt || existing?.kickoffTime || "");
  return Number.isFinite(candidateUpdated) && Number.isFinite(existingUpdated) && candidateUpdated > existingUpdated;
}

function loadExistingSyncMeta(publicDir) {
  const file = path.join(publicDir, "data", "sync-meta.json");
  if (!fs.existsSync(file)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function loadExistingJsonObject(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function bindCanonicalMatchIdentity(match, key = matchStoreKey(match)) {
  if (!match || !key || canonicalSourceMatchId(match.sourceMatchId) === key) return match;
  return { ...match, sourceMatchId: key };
}

function mergeStoredPublishedMatch(existing, candidate) {
  const key = matchStoreKey(candidate) || matchStoreKey(existing);
  const candidatePreferred = shouldPreferPublishedIdentity(candidate, existing);
  const preferred = candidatePreferred ? candidate : existing;
  const supplemental = candidatePreferred ? existing : candidate;
  if (!predictionPersistenceSameEvent(existing, candidate)) {
    return bindCanonicalMatchIdentity(preferred, key);
  }
  return bindCanonicalMatchIdentity(mergePublishedMatches(preferred, supplemental), key);
}

function loadLatestExistingJsonObject(files) {
  const candidates = [];
  for (const file of files) {
    const payload = loadExistingJsonObject(file);
    if (!payload) continue;
    const time = Date.parse(
      payload.generatedAt
      || payload.updatedAt
      || payload.activation?.promotionGate?.checkedAt
      || ""
    );
    candidates.push({
      file,
      payload,
      time: Number.isFinite(time) ? time : 0,
    });
  }
  candidates.sort((a, b) => b.time - a.time);
  return candidates[0]?.payload || null;
}

function loadExternalSignals(publicDir) {
  const file = path.join(publicDir, "data", "external-signals.json");
  if (!fs.existsSync(file)) return { version: 1, updatedAt: null, matches: {}, count: 0 };

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const matches = parsed && typeof parsed.matches === "object" && !Array.isArray(parsed.matches)
      ? parsed.matches
      : {};
    return {
      version: Number(parsed?.version || 1),
      updatedAt: parsed?.updatedAt || null,
      source: parsed?.source || "external-signals",
      matches,
      count: Object.keys(matches).length,
    };
  } catch (error) {
    console.warn(`external-signals.json ignored: ${error.message}`);
    return { version: 1, updatedAt: null, matches: {}, count: 0, error: error.message };
  }
}

function loadPreMatchSignals(publicDir) {
  const file = path.join(publicDir, "data", "pre-match-signals.json");
  if (!fs.existsSync(file)) return { version: 1, updatedAt: null, matches: {}, count: 0 };

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const matches = parsed && typeof parsed.matches === "object" && !Array.isArray(parsed.matches)
      ? parsed.matches
      : {};
    return {
      version: Number(parsed?.version || 1),
      updatedAt: parsed?.updatedAt || null,
      source: parsed?.source || "pre-match-signals",
      matches,
      count: Object.keys(matches).length,
    };
  } catch (error) {
    console.warn(`pre-match-signals.json ignored: ${error.message}`);
    return { version: 1, updatedAt: null, matches: {}, count: 0, error: error.message };
  }
}

function fallbackSourceUpdatedAt(signal, externalSignals) {
  return signal?.updatedAt
    || signal?.bookmakerOdds?.had?.updatedAt
    || signal?.bookmakerOdds?.hhad?.updatedAt
    || signal?.externalOdds?.updatedAt
    || externalSignals?.updatedAt
    || null;
}

function fiveHundredMatchUrl(signal, kind = "analysis") {
  return signal?.fiveHundred?.urls?.[kind]
    || signal?.fiveHundred?.urls?.analysis
    || "https://trade.500.com/jczq/";
}

function signalFallbackId(signal) {
  return normText(signal?.sourceMatchId || signal?.matchId || signal?.fixtureId || "");
}

function fiveHundredResultScore(signal) {
  const result = signal?.fiveHundred?.result || signal?.result || {};
  const home = toNum(result.scoreHome, toNum(signal?.scoreHome, null));
  const away = toNum(result.scoreAway, toNum(signal?.scoreAway, null));
  return Number.isFinite(home) && Number.isFinite(away)
    ? {
      scoreHome: home,
      scoreAway: away,
      source: result.source || signal?.resultSource || "500.com:jczq-result",
      observedAt: result.sourceObservedAt || result.observedAt || result.updatedAt || signal?.updatedAt,
      observationSource: result.observationSource || "500.com-response-received-at",
      sourceUpdatedAt: result.sourceUpdatedAt || null,
      observationFallback: true,
    }
    : null;
}

function buildProvisionalResultEvidence(match, signal) {
  const score = fiveHundredResultScore(signal);
  if (!score) return null;
  if (
    !Number.isInteger(score.scoreHome)
    || !Number.isInteger(score.scoreAway)
    || score.scoreHome < 0
    || score.scoreAway < 0
    || !String(score.source || "").startsWith("500.com")
  ) {
    return null;
  }

  const matchSourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const signalSourceMatchId = canonicalSourceMatchId(signalFallbackId(signal));
  if (!matchSourceMatchId || !signalSourceMatchId || matchSourceMatchId !== signalSourceMatchId) return null;

  const result = signal?.fiveHundred?.result || signal?.result || {};
  const matchKickoff = validAuditInstant(match?.kickoffTime);
  const signalKickoff = validAuditInstant(result.eventVersion || signal?.eventVersion || signal?.kickoffTime);
  if (
    !matchKickoff
    || !signalKickoff
    || Date.parse(matchKickoff) !== Date.parse(signalKickoff)
  ) {
    return null;
  }

  const matchHome = normText(match?.homeTeamName || match?.homeTeam).toLowerCase();
  const matchAway = normText(match?.awayTeamName || match?.awayTeam).toLowerCase();
  const signalHome = normText(signal?.homeTeamName || signal?.homeTeam).toLowerCase();
  const signalAway = normText(signal?.awayTeamName || signal?.awayTeam).toLowerCase();
  if (matchHome && signalHome && matchHome !== signalHome) return null;
  if (matchAway && signalAway && matchAway !== signalAway) return null;

  const observedAt = validAuditInstant(score.observedAt);
  if (!observedAt || Date.parse(observedAt) < Date.parse(matchKickoff)) return null;

  return {
    version: "provisional-result-evidence-v1",
    status: "PROVISIONAL_RESULT_OBSERVED",
    provider: "500.com",
    source: score.source,
    sourceMatchId: matchSourceMatchId,
    kickoffTime: matchKickoff,
    eventVersion: signalKickoff,
    scoreHome: score.scoreHome,
    scoreAway: score.scoreAway,
    scoreText: `${score.scoreHome}:${score.scoreAway}`,
    observedAt,
    firstObservedAt: observedAt,
    latestObservedAt: observedAt,
    observationSource: score.observationSource || "500.com-response-received-at",
    sourceUpdatedAt: validAuditInstant(score.sourceUpdatedAt),
    observationFallback: true,
    official: false,
    trusted: false,
    promotionEligible: false,
    lifecycleEffect: "none-awaiting-official-sporttery-result",
    statisticsTrack: "shadow-provisional",
    resultRevision: 1,
  };
}

function provisionalResultEvidenceForMatch(match) {
  if (!match || isTrustedFinishedForSettlement(match) || isOfficialVoidMatch(match)) return null;
  const existing = match?.provisionalResult && typeof match.provisionalResult === "object"
    ? match.provisionalResult
    : null;
  const existingSignal = existing ? {
    sourceMatchId: existing.sourceMatchId || match?.sourceMatchId,
    kickoffTime: existing.kickoffTime || match?.kickoffTime,
    eventVersion: existing.eventVersion || existing.kickoffTime || match?.eventVersion || match?.kickoffTime,
    homeTeamName: match?.homeTeamName || match?.homeTeam,
    awayTeamName: match?.awayTeamName || match?.awayTeam,
    fiveHundred: {
      result: {
        source: existing.source || "500.com:jczq-result",
        scoreHome: existing.scoreHome,
        scoreAway: existing.scoreAway,
        sourceObservedAt: existing.observedAt || existing.firstObservedAt,
        observationSource: existing.observationSource,
        sourceUpdatedAt: existing.sourceUpdatedAt,
        eventVersion: existing.eventVersion || existing.kickoffTime,
      },
    },
  } : null;
  const normalizedExisting = existingSignal ? buildProvisionalResultEvidence(match, existingSignal) : null;
  const externalEvidence = buildProvisionalResultEvidence(match, match?.externalSignals);
  const rootEvidence = String(match?.resultSource || "").startsWith("500.com")
    ? buildProvisionalResultEvidence(match, {
      sourceMatchId: match?.sourceMatchId,
      kickoffTime: match?.kickoffTime,
      eventVersion: match?.eventVersion || match?.kickoffTime,
      homeTeamName: match?.homeTeamName || match?.homeTeam,
      awayTeamName: match?.awayTeamName || match?.awayTeam,
      fiveHundred: {
        result: {
          source: match?.resultSource,
          scoreHome: match?.scoreHome,
          scoreAway: match?.scoreAway,
          sourceObservedAt: match?.resultObservedAt || match?.resultUpdatedAt,
          observationSource: match?.resultObservationSource,
          sourceUpdatedAt: match?.resultSourceUpdatedAt,
          eventVersion: match?.eventVersion || match?.kickoffTime,
        },
      },
    })
    : null;
  const incoming = externalEvidence || rootEvidence;
  if (!normalizedExisting) return incoming;
  if (!incoming) {
    return {
      ...normalizedExisting,
      firstObservedAt: validAuditInstant(existing?.firstObservedAt) || normalizedExisting.observedAt,
      latestObservedAt: validAuditInstant(existing?.latestObservedAt) || normalizedExisting.observedAt,
      resultRevision: Math.max(1, Number(existing?.resultRevision || 1)),
    };
  }
  const sameScore = normalizedExisting.scoreHome === incoming.scoreHome
    && normalizedExisting.scoreAway === incoming.scoreAway;
  return {
    ...incoming,
    firstObservedAt: validAuditInstant(existing?.firstObservedAt) || normalizedExisting.observedAt,
    latestObservedAt: incoming.observedAt,
    observedAt: sameScore ? normalizedExisting.observedAt : incoming.observedAt,
    resultRevision: sameScore
      ? Math.max(1, Number(existing?.resultRevision || 1))
      : Math.max(1, Number(existing?.resultRevision || 1)) + 1,
  };
}

function stripProvisionalResultFields(match) {
  if (!match || typeof match !== "object") return match;
  const { provisionalResult, provisionalResultReview, ...rest } = match;
  void provisionalResult;
  void provisionalResultReview;
  return rest;
}

function sanitizeNonOfficialResultForShadow(match, evidence = provisionalResultEvidenceForMatch(match)) {
  if (!match || isTrustedFinishedForSettlement(match) || isOfficialVoidMatch(match)) {
    return stripProvisionalResultFields(match);
  }
  const hasFallbackMarker = Boolean(
    evidence
    || String(match?.resultSource || "").startsWith("500.com")
    || String(match?.provisionalResult?.source || "").startsWith("500.com")
  );
  if (!hasFallbackMarker) return match;

  const next = {
    ...match,
    status: match.status === "FINISHED" ? "PENDING_RESULT" : match.status,
    sourceStatus: match.sourceStatus === "FINISHED" ? "PENDING_RESULT" : match.sourceStatus,
    effectiveStatus: match.effectiveStatus === "FINISHED" ? "PENDING_RESULT" : match.effectiveStatus,
    statusReason: "provisional-result-awaiting-official-confirmation",
    resultProvenance: null,
    ...(evidence ? { provisionalResult: evidence } : {}),
    predictions: (match.predictions || []).map((prediction) => (
      prediction?.resultStatus === "WON" || prediction?.resultStatus === "LOST"
        ? { ...prediction, resultStatus: "PENDING" }
        : prediction
    )),
  };
  for (const key of [
    "scoreHome",
    "scoreAway",
    "resultSource",
    "resultUpdatedAt",
    "resultObservedAt",
    "resultObservationSource",
    "resultObservationFallback",
    "resultSourceUpdatedAt",
    "settledAt",
    "postMatchReview",
  ]) {
    delete next[key];
  }
  return next;
}

function buildFiveHundredFallbackMatches(externalSignals) {
  if (process.env.ENABLE_500_MATCH_FALLBACK === "0") return [];

  const signals = externalSignals?.matches || {};
  const seen = new Set();
  const rows = [];
  const now = Date.now();
  const staleStartedGraceMs = 3 * 60 * 60 * 1000;
  const resultLookbackMs = Math.max(6, Number(process.env.FIVE_HUNDRED_RESULT_OUTPUT_LOOKBACK_HOURS || 72)) * 60 * 60 * 1000;

  for (const signal of Object.values(signals)) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) continue;

    const sourceMatchId = signalFallbackId(signal);
    if (!sourceMatchId || seen.has(sourceMatchId)) continue;

    const kickoffTime = normText(signal.kickoffTime);
    const kickoffMs = Date.parse(kickoffTime);
    const resultScore = fiveHundredResultScore(signal);
    if (!Number.isFinite(kickoffMs)) continue;

    const homeTeam = normText(signal.homeTeamName || signal.homeTeam);
    const awayTeam = normText(signal.awayTeamName || signal.awayTeam);
    if (!homeTeam || !awayTeam) continue;
    const provisionalResult = resultScore ? buildProvisionalResultEvidence({
      sourceMatchId,
      kickoffTime,
      eventVersion: kickoffTime,
      homeTeamName: homeTeam,
      awayTeamName: awayTeam,
    }, signal) : null;
    const resultIsFresh = provisionalResult && kickoffMs >= now - resultLookbackMs;
    if (!resultIsFresh && kickoffMs < now - staleStartedGraceMs) continue;

    const bookmakerOdds = signal.bookmakerOdds || {};
    const sourceIncludesFiveHundred = (value) => String(value || "")
      .split("+")
      .map((item) => item.trim())
      .some((item) => /^500\.com(?::|$)/i.test(item));
    const isFiveHundredOddsPiece = (piece) => {
      const pieceSource = normText(piece?.source);
      return pieceSource
        ? sourceIncludesFiveHundred(pieceSource)
        : sourceIncludesFiveHundred(signal.source);
    };
    const fiveHundredHad = isFiveHundredOddsPiece(bookmakerOdds.had) ? bookmakerOdds.had : null;
    const fiveHundredHhad = isFiveHundredOddsPiece(bookmakerOdds.hhad) ? bookmakerOdds.hhad : null;
    const fiveHundredExternal = isFiveHundredOddsPiece(signal.externalOdds) ? signal.externalOdds : null;
    const parsedHhadLine = fiveHundredHhad && typeof fiveHundredHhad === "object"
      ? [bookmakerOdds.hhad.handicapLine, signal.handicapLine]
          .map(parseHandicapLine)
          .find((line) => line !== null) ?? null
      : null;
    const bookmakerHhadOdds = parsedHhadLine === null ? null : sanitizeOdds(fiveHundredHhad);
    const hadOdds = sanitizeOdds(fiveHundredHad)
      || (!bookmakerHhadOdds ? sanitizeOdds(fiveHundredExternal) : null);
    const hhadOdds = bookmakerHhadOdds;
    if (!provisionalResult && !hadOdds && !hhadOdds) continue;

    const updatedAt = fallbackSourceUpdatedAt(signal, externalSignals);
    const hadObservedAt = hadOdds ? validAuditInstant(
      fiveHundredHad?.sourceObservedAt
      || fiveHundredHad?.observedAt
      || fiveHundredHad?.updatedAt
      || signal?.sourceObservedAt
      || updatedAt,
    ) : null;
    const hadReceivedAt = hadOdds ? validAuditInstant(
      fiveHundredHad?.receivedAt || signal?.receivedAt,
    ) : null;
    const hhadObservedAt = hhadOdds ? validAuditInstant(
      fiveHundredHhad?.sourceObservedAt
      || fiveHundredHhad?.observedAt
      || fiveHundredHhad?.updatedAt
      || signal?.sourceObservedAt
      || updatedAt,
    ) : null;
    const hhadReceivedAt = hhadOdds ? validAuditInstant(
      fiveHundredHhad?.receivedAt || signal?.receivedAt,
    ) : null;
    const matchDate = kickoffTime.slice(0, 10);
    const matchNo = normText(signal.matchNo);
    const businessDate = inferSportteryBusinessDate(matchNo, matchDate) || matchDate;
    seen.add(sourceMatchId);
    rows.push({
      source: "five-hundred",
      sourceMethod: "500-fallback",
      sourceUrl: fiveHundredMatchUrl(signal, "analysis"),
      sourceMatchId,
      fixtureId: normText(signal.fixtureId),
      matchNo,
      businessDate,
      matchDate,
      buyEndTime: normText(signal.buyEndTime || signal.fiveHundred?.sale?.buyEndTime),
      homeTeam,
      awayTeam,
      homeRank: normText(signal.fiveHundred?.rank?.home?.fifaRank),
      awayRank: normText(signal.fiveHundred?.rank?.away?.fifaRank),
      homeTeamCode: normText(signal.homeTeamCode),
      awayTeamCode: normText(signal.awayTeamCode),
      leagueName: normText(signal.leagueName, "足球赛事"),
      kickoffTime,
      status: provisionalResult ? "PENDING_RESULT" : "SCHEDULED",
      ...(provisionalResult ? { provisionalResult } : {}),
      eventVersion: kickoffTime || null,
      odds: hadOdds,
      oddsSource: hadOdds ? "500.com:HAD" : undefined,
      oddsPoolCode: hadOdds ? "HAD" : undefined,
      oddsSourceMethod: hadOdds ? "500-fallback" : undefined,
      oddsObservedAt: hadObservedAt || undefined,
      oddsReceivedAt: hadReceivedAt || undefined,
      oddsUpdatedAt: hadOdds ? updatedAt : undefined,
      oddsSourceUrl: hadOdds ? fiveHundredMatchUrl(signal, "europeOdds") : undefined,
      handicapOdds: hhadOdds,
      handicapLine: hhadOdds ? formatHandicapLineForCopy(parsedHhadLine) : undefined,
      handicapOddsSource: hhadOdds ? "500.com:HHAD" : undefined,
      handicapOddsPoolCode: hhadOdds ? "HHAD" : undefined,
      handicapOddsSourceMethod: hhadOdds ? "500-fallback" : undefined,
      handicapOddsObservedAt: hhadObservedAt || undefined,
      handicapOddsReceivedAt: hhadReceivedAt || undefined,
      handicapOddsUpdatedAt: hhadOdds ? updatedAt : undefined,
      handicapOddsSourceUrl: hhadOdds ? fiveHundredMatchUrl(signal, "asianHandicap") : undefined,
      externalSignals: {
        ...signal,
        source: signal.source || externalSignals?.source || "external-signals",
        updatedAt,
      },
    });
  }

  return dedupeMatches(rows);
}

function signalTeamDateKey(home, away, date) {
  return normText(home && away && date ? `${date}:${home}:${away}` : "");
}

function externalSignalKeys(match) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  const kickoffDate = normText(match?.kickoffDate || String(match?.kickoffTime || "").slice(0, 10));
  return [
    // The canonical provider id is the only alias that every 500.com refresh
    // updates. Legacy `sporttery_${id}` aliases can survive with older
    // pre-match data and must never mask a newer same-event result.
    sourceMatchId,
    normText(match?.id),
    normText(match?.matchNo),
    normText(match?.matchNo && match?.businessDate ? `${match.businessDate}:${match.matchNo}` : ""),
    signalTeamDateKey(match?.homeTeamName, match?.awayTeamName, kickoffDate),
    signalTeamDateKey(match?.homeTeam, match?.awayTeam, kickoffDate),
    signalTeamDateKey(match?.homeTeamId, match?.awayTeamId, kickoffDate),
  ].filter(Boolean);
}

function preMatchSignalKeys(signal) {
  const kickoffDate = normText(String(signal?.kickoffTime || "").slice(0, 10));
  return [
    normText(signal?.matchId),
    normText(signal?.sourceMatchId),
    normText(signal?.matchNo),
    signalTeamDateKey(signal?.homeTeamName, signal?.awayTeamName, kickoffDate),
  ].filter(Boolean);
}

function buildPreMatchSignalIndex(preMatchSignals) {
  const rows = preMatchSignals?.matches || {};
  const index = new Map();
  for (const [key, value] of Object.entries(rows)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const alias of [normText(key), ...preMatchSignalKeys(value)]) {
      if (alias && !index.has(alias)) index.set(alias, value);
    }
  }
  return index;
}

function externalSignalMatchesEvent(match, signal) {
  if (!match || !signal || typeof signal !== "object" || Array.isArray(signal)) return false;
  const kickoffMs = parseBeijingDateTime(match?.kickoffTime || match?.eventVersion || "");
  if (!Number.isFinite(kickoffMs)) return false;

  const explicitEventClocks = [
    signal?.kickoffTime,
    signal?.eventVersion,
    signal?.preMatch?.kickoffTime,
    signal?.fiveHundred?.kickoffTime,
    signal?.fiveHundred?.eventVersion,
    signal?.fiveHundred?.result?.eventVersion,
  ]
    .map(parseBeijingDateTime)
    .filter(Number.isFinite);
  if (explicitEventClocks.length) {
    return explicitEventClocks.every((value) => Math.abs(value - kickoffMs) <= 30 * 60 * 1000);
  }

  // 500.com sale cutoff is the remaining event clock on pre-match rows. It is
  // normally shortly before kickoff; a cutoff days earlier is a reused-id
  // signal from a different fixture and must fail closed.
  const saleCutoffMs = parseBeijingDateTime(
    signal?.buyEndTime
      || signal?.sale?.buyEndTime
      || signal?.fiveHundred?.sale?.buyEndTime
      || "",
  );
  if (!Number.isFinite(saleCutoffMs)) return false;
  const leadMs = kickoffMs - saleCutoffMs;
  return leadMs >= -30 * 60 * 1000 && leadMs <= 36 * 60 * 60 * 1000;
}

function trustedDisplayLiveScore(match, signal) {
  const liveScore = signal?.liveScore;
  if (!liveScore || typeof liveScore !== "object" || Array.isArray(liveScore)) return null;
  const matchSourceMatchId = canonicalSourceMatchId(match?.sourceMatchId || match?.id);
  const signalSourceMatchId = canonicalSourceMatchId(liveScore.sourceMatchId);
  const matchKickoff = validAuditInstant(match?.kickoffTime || match?.eventVersion);
  const liveKickoff = validAuditInstant(liveScore.kickoffTime);
  const observedAt = validAuditInstant(liveScore.observedAt);
  if (!matchSourceMatchId || !signalSourceMatchId || matchSourceMatchId !== signalSourceMatchId) return null;
  if (!matchKickoff || !liveKickoff || Date.parse(matchKickoff) !== Date.parse(liveKickoff)) return null;
  if (!observedAt || Date.parse(observedAt) < Date.parse(matchKickoff) - 15 * 60 * 1000) return null;
  if (!Number.isInteger(liveScore.scoreHome) || liveScore.scoreHome < 0
      || !Number.isInteger(liveScore.scoreAway) || liveScore.scoreAway < 0) return null;
  if (liveScore.trusted !== true
      || liveScore.settlementEligible !== false
      || liveScore.mappingVerification !== "registry-exact"
      || !String(liveScore.source || "").startsWith("api-football:")) return null;
  return {
    ...liveScore,
    observedAt,
    receivedAt: validAuditInstant(liveScore.receivedAt) || observedAt,
    official: false,
    settlementEligible: false
  };
}

function attachExternalSignals(matches, externalSignals, preMatchSignals = null) {
  const signalMap = externalSignals?.matches || {};
  const preMatchIndex = buildPreMatchSignalIndex(preMatchSignals);
  if ((!signalMap || !Object.keys(signalMap).length) && preMatchIndex.size === 0) return matches;

  return matches.map((match) => {
    const keys = externalSignalKeys(match);
    const key = keys.find((candidate) => externalSignalMatchesEvent(match, signalMap[candidate]));
    const preMatch = keys
      .map((candidate) => preMatchIndex.get(candidate))
      .find((candidate) => externalSignalMatchesEvent(match, candidate));
    if (!key && !preMatch) return match;
    const value = key ? signalMap[key] : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return match;
    const nextPreMatch = value.preMatch || preMatch || undefined;
    const liveScore = trustedDisplayLiveScore(match, value);
    return {
      ...match,
      ...(liveScore ? { liveScore } : {}),
      externalSignals: {
        ...value,
        ...(nextPreMatch ? { preMatch: nextPreMatch } : {}),
        ...(!value.discipline && preMatch?.discipline ? { discipline: preMatch.discipline } : {}),
        source: value.source || externalSignals.source || "external-signals",
        updatedAt: value.updatedAt || externalSignals.updatedAt || preMatchSignals?.updatedAt || undefined,
      },
    };
  });
}

function applyExternalResultSignal(match) {
  if (isTrustedFinishedForSettlement(match) || isOfficialVoidMatch(match)) {
    return stripProvisionalResultFields(match);
  }
  const evidence = provisionalResultEvidenceForMatch(match);
  return sanitizeNonOfficialResultForShadow(match, evidence);
}

function buildProvisionalResultReview(
  match,
  snapshotIndex,
  publicationIndex = null,
  capturedAt = new Date().toISOString()
) {
  const evidence = provisionalResultEvidenceForMatch(match);
  if (!evidence) return null;
  const sourceMatchId = sourceMatchKeyForReview(match);
  const snapshots = sourceMatchId && snapshotIndex
    ? snapshotIndex.get(sourceMatchId) || []
    : [];
  const exactSnapshots = snapshots.filter((snapshot) => (
    sameSnapshotEvent(match, snapshot)
    && isEligiblePreMatchSnapshot(match, snapshot)
  ));
  const archivedPrediction = validArchivedPreMatchPrediction(match);
  if (!exactSnapshots.length && !archivedPrediction) return null;
  const exactSnapshotIndex = exactSnapshots.length
    ? new Map([[sourceMatchId, exactSnapshots]])
    : null;
  const snapshotPredictions = fallbackPredictionsFromSnapshots(
    match,
    exactSnapshotIndex,
    publicationIndex
  );
  const auditedPreMatchPredictions = mergeArchivedBestPrediction(match, snapshotPredictions);
  if (!auditedPreMatchPredictions.length) return null;

  const reviewMatch = {
    ...match,
    status: "FINISHED",
    scoreHome: evidence.scoreHome,
    scoreAway: evidence.scoreAway,
    predictions: auditedPreMatchPredictions,
  };
  const actuals = postMatchReviewActuals(reviewMatch, auditedPreMatchPredictions);
  if (!actuals) return null;
  const rows = buildPredictionReviewRows(reviewMatch, actuals, publicationIndex).map((row) => ({
    ...row,
    sourceReviewRole: row.reviewRole,
    sourcePerformanceTrack: row.performanceTrack,
    publicationBoundSelection: Boolean(row.publicationId),
    recommendationAction: "reference",
    recommendationTier: "shadow-provisional",
    reviewRole: "shadow",
    performanceTrack: "shadow-provisional",
    statisticsTrack: "shadow-provisional",
    formalEligible: false,
    officialMetricsEligible: false,
    promotionEligible: false,
  }));
  const settledRows = rows.filter((row) => row.resultStatus === "WON" || row.resultStatus === "LOST");
  const bestRow = rows.find((row) => row.marketType === "BEST") || null;
  const latestSnapshot = exactSnapshots
    .slice()
    .sort((a, b) => parseBeijingDateTime(a.capturedAt) - parseBeijingDateTime(b.capturedAt))
    .at(-1);
  return {
    version: "provisional-result-review-v1",
    generatedAt: capturedAt,
    status: "shadow-provisional",
    sourceMatchId,
    matchId: match?.id || null,
    matchNo: match?.matchNo || null,
    kickoffTime: match?.kickoffTime || null,
    teams: {
      home: match?.homeTeamName || match?.homeTeam || null,
      away: match?.awayTeamName || match?.awayTeam || null,
    },
    provisionalResult: evidence,
    snapshotEvidence: {
      required: true,
      sameEvent: true,
      capturedAt: archivedPrediction?.capturedAt || latestSnapshot?.capturedAt || null,
      phase: archivedPrediction?.phase || latestSnapshot?.phase || null,
      signature: archivedPrediction?.signature || latestSnapshot?.signature || null,
      predictionSource: "immutable-pre-match-prediction-snapshot",
      immutableArchiveUsed: Boolean(archivedPrediction),
      mutableRuntimePredictionExcluded: true,
      clientGeneratedFallbackDirectionReplayEligible: false,
    },
    actual: {
      score: actuals.finalScore,
      had: actuals.had,
      hhad: actuals.hhad,
      goals: actuals.overUnder25,
      btts: actuals.btts,
    },
    predictionReview: {
      rows,
      settled: settledRows.length,
      won: settledRows.filter((row) => row.resultStatus === "WON").length,
      lost: settledRows.filter((row) => row.resultStatus === "LOST").length,
      bestStatus: bestRow?.resultStatus || null,
      shadowHitRate: settledRows.length
        ? Number((settledRows.filter((row) => row.resultStatus === "WON").length / settledRows.length).toFixed(3))
        : null,
    },
    formalEligible: false,
    officialMetricsEligible: false,
    promotionEligible: false,
    onlineEffect: "none",
    policy: "single-source 500 result is review-only until an exact official Sporttery final confirms the event and score",
  };
}

function buildProvisionalResultReviews(
  matches,
  predictionSnapshotsPayload,
  publicationIndex = null,
  capturedAt = new Date().toISOString()
) {
  const snapshotIndex = buildPredictionSnapshotIndex(predictionSnapshotsPayload);
  const observedMatches = (matches || []).filter((match) => provisionalResultEvidenceForMatch(match));
  const rows = observedMatches
    .map((match) => buildProvisionalResultReview(match, snapshotIndex, publicationIndex, capturedAt))
    .filter(Boolean);
  const predictionRows = rows.flatMap((review) => review.predictionReview?.rows || []);
  const bestRows = predictionRows.filter((row) => (
    row.marketType === "BEST"
    && (row.resultStatus === "WON" || row.resultStatus === "LOST")
  ));
  const bestWon = bestRows.filter((row) => row.resultStatus === "WON").length;
  return {
    version: "provisional-result-review-feed-v1",
    source: "500.com:result-shadow",
    generatedAt: capturedAt,
    predictionReplayPolicy: {
      source: "immutable-pre-match-prediction-snapshot",
      mutableRuntimePredictionEligible: false,
      clientGeneratedFallbackDirectionReplayEligible: false,
    },
    rows,
    summary: {
      observedMatches: observedMatches.length,
      reviewableMatches: rows.length,
      rejectedWithoutExactPreMatchSnapshot: observedMatches.length - rows.length,
      predictionRows: predictionRows.length,
      bestSettled: bestRows.length,
      bestWon,
      bestLost: bestRows.length - bestWon,
      shadowBestHitRate: bestRows.length ? Number((bestWon / bestRows.length).toFixed(3)) : null,
      formalSettled: 0,
      officialMetricsEligible: false,
      promotionEligible: false,
    },
  };
}

function normalizeProbabilityModelForPublish(model) {
  if (!model || typeof model !== "object") return model;
  return {
    ...model,
    basis: String(model.version || "").includes("model-only")
      ? (model.basis || {
        zh: "未开售模型参考：官方 SP/让球 SP 暂无时，按球队强弱、历史样本、赛程与 Poisson 比分分布生成参考推荐；不作为串关 SP。",
        en: "Model-only reference while official SP/handicap SP is unavailable. It uses team strength, historical samples, schedule context, and Poisson score distribution, and is not a parlay SP.",
      })
      : PREDICTION_MODEL_BASIS,
  };
}

function normalizePredictionMetaForPublish(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const { forecastPlan, ...rest } = meta;
  void forecastPlan;
  const lockedMeta = Boolean(rest.lockedAt || rest.lockedReason);
  return {
    ...rest,
    policyVersion: lockedMeta && rest.policyVersion ? rest.policyVersion : PREDICTION_POLICY_VERSION,
    promptVersion: lockedMeta && rest.promptVersion ? rest.promptVersion : ANALYST_PROMPT_VERSION,
    dataPolicy: PREDICTION_DATA_POLICY,
    analystRuntime: rest.analystRuntime || ANALYST_RUNTIME,
    analystFramework: rest.analystFramework || PREDICTION_ANALYST_FRAMEWORK,
  };
}

function normalizePublishedPredictionText(match) {
  if (!match || typeof match !== "object") return match;
  const enriched = enrichPublishedCalculationTrace(match);
  return {
    ...enriched,
    probabilityModel: normalizeProbabilityModelForPublish(enriched.probabilityModel),
    predictionMeta: normalizePredictionMetaForPublish(enriched.predictionMeta),
  };
}

const REFERENCE_COPY_REPLACEMENTS = Object.freeze([
  ["赛前观察项", "参考推荐"],
  ["赛前观察方向", "参考方向"],
  ["只保留观察位", "只保留参考位"],
  ["保留赛前观察", "保留参考方向"],
  ["观察理由：", "参考理由："],
  ["观察处理", "参考处理"],
  ["本场仅观察", "本场参考推荐"],
  ["降级为观察", "降级为参考推荐"],
  ["价值观察", "价值参考"],
  ["冷门观察", "冷门参考"],
  ["观察为主", "参考为主"],
  ["观察点：", "风险点："],
  ["watch-only", "reference-only"],
  ["pre-match watch", "reference-only"],
  ["Pre-match watch", "Reference-only"],
]);

function sanitizeReferenceCopyText(text) {
  if (typeof text !== "string") return text;
  return REFERENCE_COPY_REPLACEMENTS.reduce(
    (current, [from, to]) => current.split(from).join(to),
    text
  );
}

function sanitizeReferenceCopyValue(value) {
  if (typeof value === "string") return sanitizeReferenceCopyText(value);
  if (Array.isArray(value)) return value.map(sanitizeReferenceCopyValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeReferenceCopyValue(entry)])
  );
}

function sanitizePublishedReferenceCopy(match) {
  if (!match || typeof match !== "object") return match;
  return {
    ...match,
    predictions: Array.isArray(match.predictions)
      ? match.predictions.map((prediction) => normalizePredictionDisplayCopy(sanitizeReferenceCopyValue(prediction)))
      : match.predictions,
    oddsTrend: match.oddsTrend ? sanitizeReferenceCopyValue(match.oddsTrend) : match.oddsTrend,
    predictionMeta: match.predictionMeta ? sanitizeReferenceCopyValue(match.predictionMeta) : match.predictionMeta,
  };
}

function normalizePublishedStatus(match, capturedAt) {
  if (!match) return match;
  const kickoffMs = Date.parse(match.kickoffTime);
  const capturedMs = Date.parse(capturedAt);
  const hasScore = Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);
  if (!Number.isFinite(kickoffMs) || !Number.isFinite(capturedMs)) return match;
  const elapsedMinutes = Math.floor((capturedMs - kickoffMs) / 60000);
  if (match.status === "FINISHED") return hasScore ? match : { ...match, status: "PENDING_RESULT" };
  if (match.status === "LIVE") {
    return !hasScore && elapsedMinutes >= 125 ? { ...match, status: "PENDING_RESULT" } : match;
  }
  if (match.status === "PENDING_RESULT") return match;
  if (capturedMs < kickoffMs) return match;
  if (hasScore && elapsedMinutes >= 125) return { ...match, status: "FINISHED" };
  if (!hasScore && elapsedMinutes >= 125) return { ...match, status: "PENDING_RESULT" };
  return { ...match, status: "LIVE" };
}

function isTrustedOddsMatch(match) {
  return (
    match?.source === "sporttery" &&
    match?.oddsSource === "sporttery:HAD" &&
    String(match?.oddsSourceUrl || "").includes("webapi.sporttery.cn") &&
    Boolean(sanitizeOdds(match?.odds))
  );
}

function isOfficialResultMatch(match) {
  return isTrustedOfficialFinal(match)
    && match?.resultProvenance?.resultObservationFallback !== true;
}

function isFallbackResultMatch(match) {
  return (
    match?.status === "FINISHED" &&
    Number.isFinite(match?.scoreHome) &&
    Number.isFinite(match?.scoreAway) &&
    String(match?.resultSource || match?.externalSignals?.fiveHundred?.result?.source || "").startsWith("500.com")
  );
}

function hasOfficialDisplayOdds(match) {
  return Boolean(sanitizeOdds(match?.odds) || sanitizeHandicapOdds(match));
}

function captureBucketIso(capturedAt) {
  const time = Date.parse(capturedAt);
  const bucketMs = ODDS_HISTORY_BUCKET_MINUTES * 60 * 1000;
  return new Date(Math.floor(time / bucketMs) * bucketMs).toISOString();
}

function oddsHistoryPoolCode(row) {
  const explicit = normText(row?.poolCode || row?.oddsPoolCode).toUpperCase();
  if (["HAD", "HHAD"].includes(explicit)) return explicit;
  return /HHAD/i.test(String(row?.oddsSource || "")) ? "HHAD" : "HAD";
}

function oddsHistoryHandicapLine(row) {
  if (oddsHistoryPoolCode(row) !== "HHAD") return 0;
  return parseHandicapLine(row?.handicapLine);
}

function oddsHistoryStateSignature(row) {
  const odds = sanitizeOdds({ odds1: row?.odds1, oddsX: row?.oddsX, odds2: row?.odds2 });
  if (!odds) return null;
  const poolCode = oddsHistoryPoolCode(row);
  const line = oddsHistoryHandicapLine(row);
  if (poolCode === "HHAD" && line === null) return null;
  return [
    poolCode,
    poolCode === "HHAD" ? formatHandicapLineForCopy(line) : "0",
    odds.odds1.toFixed(3),
    odds.oddsX.toFixed(3),
    odds.odds2.toFixed(3),
  ].join("|");
}

function oddsHistoryRowBeforeCutoff(row) {
  const capturedMs = Date.parse(row?.capturedAt || row?.firstSeenAt || "");
  const kickoffMs = Date.parse(row?.kickoffTime || "");
  const declaredCutoffMs = parseBeijingDateTime(row?.cutoffTime || "");
  const limits = [kickoffMs, declaredCutoffMs].filter(Number.isFinite);
  if (!Number.isFinite(capturedMs) || !limits.length) return false;
  return capturedMs <= Math.min(...limits);
}

function latestOddsSnapshotForMatch(match, historyRows, poolCode = "HAD", handicapLine = null) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  if (!sourceMatchId) return null;

  const kickoffAt = Date.parse(match.kickoffTime);
  const rows = historyRows
    .filter((row) => normText(row?.sourceMatchId) === sourceMatchId)
    // Provider ids are reused. A historical SP belongs to the new fixture
    // only when its recorded kickoff identifies the same event revision.
    .filter((row) => predictionPersistenceSameEvent(row, match))
    .filter((row) => oddsHistoryPoolCode(row) === poolCode)
    .filter((row) => poolCode !== "HHAD" || parseHandicapLine(handicapLine) === oddsHistoryHandicapLine(row))
    .filter((row) => sanitizeOdds({ odds1: row?.odds1, oddsX: row?.oddsX, odds2: row?.odds2 }))
    .filter(oddsHistoryRowBeforeCutoff)
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  if (!rows.length) return null;

  const beforeKickoff = Number.isFinite(kickoffAt)
    ? rows.filter((row) => Date.parse(row.capturedAt) <= kickoffAt)
    : rows;
  return beforeKickoff.at(-1) || null;
}

function enrichRawMatchWithPredictionSnapshot(match, existingBySourceId, historyRows) {
  if (sanitizeOdds(match.odds)) return match;

  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  const existingCandidate = existingBySourceId.get(sourceMatchId);
  const existing = predictionPersistenceSameEvent(existingCandidate, match)
    ? existingCandidate
    : null;
  const existingOdds = sanitizeOdds(existing?.odds);
  if (existingOdds) {
    const existingHandicapOdds = sanitizeHandicapOdds(existing);
    const freshHandicapOdds = sanitizeHandicapOdds(match);
    const handicapSourceMatch = existingHandicapOdds ? existing : freshHandicapOdds ? match : null;
    const handicapLineSource = [existing, match]
      .find((candidate) => parseHandicapLine(candidate?.handicapLine) !== null);
    return {
      ...match,
      odds: existingOdds,
      oddsSource: existing.oddsSource || "sporttery:HAD",
      oddsPoolCode: existing.oddsPoolCode || "HAD",
      oddsSourceMethod: existing.oddsSourceMethod || "preserved",
      oddsObservedAt: existing.oddsObservedAt,
      oddsReceivedAt: existing.oddsReceivedAt,
      oddsUpdatedAt: existing.oddsUpdatedAt,
      oddsSourceUrl: existing.oddsSourceUrl,
      oddsMarketProvenance: existing.oddsMarketProvenance || null,
      handicapOdds: existingHandicapOdds || freshHandicapOdds || undefined,
      handicapLine: handicapLineSource
        ? formatHandicapLineForCopy(handicapLineSource.handicapLine)
        : undefined,
      handicapOddsSource: handicapSourceMatch?.handicapOddsSource,
      handicapOddsPoolCode: handicapSourceMatch?.handicapOddsPoolCode,
      handicapOddsSourceMethod: handicapSourceMatch?.handicapOddsSourceMethod,
      handicapOddsObservedAt: handicapSourceMatch?.handicapOddsObservedAt,
      handicapOddsReceivedAt: handicapSourceMatch?.handicapOddsReceivedAt,
      handicapOddsUpdatedAt: handicapSourceMatch?.handicapOddsUpdatedAt,
      handicapOddsSourceUrl: handicapSourceMatch?.handicapOddsSourceUrl,
      handicapOddsMarketProvenance: handicapSourceMatch?.handicapOddsMarketProvenance || null,
    };
  }

  const snapshot = latestOddsSnapshotForMatch(match, historyRows);
  if (!snapshot) return match;

  return {
    ...match,
    odds: {
      odds1: Number(snapshot.odds1),
      oddsX: Number(snapshot.oddsX),
      odds2: Number(snapshot.odds2),
    },
    oddsSource: "sporttery:HAD",
    oddsPoolCode: "HAD",
    oddsSourceMethod: "snapshot",
    oddsObservedAt: snapshot.oddsObservedAt || snapshot.oddsUpdatedAt || null,
    oddsReceivedAt: snapshot.oddsReceivedAt || null,
    oddsUpdatedAt: snapshot.oddsUpdatedAt || undefined,
    oddsSourceUrl: snapshot.oddsSourceUrl,
    oddsMarketProvenance: snapshot.marketProvenance
      || snapshot.oddsMarketProvenance
      || null,
  };
}

function isTrustedHhadOddsMatch(match) {
  return Boolean(
    match?.handicapOddsSource === "sporttery:HHAD"
    && String(match?.handicapOddsSourceUrl || "").includes("webapi.sporttery.cn")
    && sanitizeHandicapOdds(match)
  );
}

function oddsHistoryRowsForMatch(match, capturedAt) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  if (!sourceMatchId) return [];
  const capturedMs = Date.parse(capturedAt);
  const cutoffCandidates = [
    Date.parse(match?.kickoffTime || ""),
    parseBeijingDateTime(matchCutoffValue(match)),
  ].filter(Number.isFinite);
  if (!Number.isFinite(capturedMs) || !cutoffCandidates.length || capturedMs > Math.min(...cutoffCandidates)) return [];

  const base = {
    capturedAt,
    firstSeenAt: capturedAt,
    lastSeenAt: capturedAt,
    seenCount: 1,
    captureBucket: captureBucketIso(capturedAt),
    sourceCycleId: match?.sourceCycleId || null,
    sourceMatchId,
    matchNo: normText(match.matchNo),
    kickoffTime: match.kickoffTime,
    status: match.status,
    leagueName: match.leagueName,
    countryName: match.countryName,
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    homeTeamLogo: match.homeTeamLogo,
    awayTeamLogo: match.awayTeamLogo,
    cutoffTime: matchCutoffValue(match) || match.kickoffTime || null,
  };
  const rows = [];
  const hadOdds = sanitizeOdds(match?.odds);
  if (hadOdds && isTrustedOddsMatch(match)) {
    rows.push({
      ...base,
      poolCode: "HAD",
      handicapLine: 0,
      odds1: hadOdds.odds1,
      oddsX: hadOdds.oddsX,
      odds2: hadOdds.odds2,
      oddsSource: match.oddsSource,
      oddsSourceMethod: match.oddsSourceMethod,
      oddsObservedAt: match.oddsObservedAt || null,
      oddsReceivedAt: match.oddsReceivedAt || null,
      oddsUpdatedAt: match.oddsUpdatedAt,
      oddsSourceUrl: match.oddsSourceUrl,
      sourceCycleId: match.oddsMarketProvenance?.cycles?.collectorSourceCycleId
        || base.sourceCycleId,
      marketProvenance: normalizeTrustedMarketSourceProvenance(match.oddsMarketProvenance),
    });
  }
  const hhadOdds = sanitizeHandicapOdds(match);
  const hhadLine = parseHandicapLine(match?.handicapLine);
  if (hhadOdds && hhadLine !== null && isTrustedHhadOddsMatch(match)) {
    rows.push({
      ...base,
      poolCode: "HHAD",
      handicapLine: formatHandicapLineForCopy(hhadLine),
      odds1: hhadOdds.odds1,
      oddsX: hhadOdds.oddsX,
      odds2: hhadOdds.odds2,
      oddsSource: match.handicapOddsSource,
      oddsSourceMethod: match.handicapOddsSourceMethod,
      oddsObservedAt: match.handicapOddsObservedAt || null,
      oddsReceivedAt: match.handicapOddsReceivedAt || null,
      oddsUpdatedAt: match.handicapOddsUpdatedAt,
      oddsSourceUrl: match.handicapOddsSourceUrl,
      sourceCycleId: match.handicapOddsMarketProvenance?.cycles?.collectorSourceCycleId
        || base.sourceCycleId,
      marketProvenance: normalizeTrustedMarketSourceProvenance(match.handicapOddsMarketProvenance),
    });
  }
  return rows.map((row) => withOddsObservationTrail({
    ...row,
    stateSignature: oddsHistoryStateSignature(row),
  }));
}

function appendOddsHistory(publicDir, matches, capturedAt, historyPayload = null) {
  const history = historyPayload || loadOddsHistory(publicDir);
  const cutoff = Date.parse(capturedAt) - ODDS_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const byState = new Map();

  for (const row of history.rows) {
    const rowTime = Date.parse(row?.capturedAt || row?.firstSeenAt || "");
    const sourceMatchId = normText(row?.sourceMatchId);
    const poolCode = oddsHistoryPoolCode(row);
    const stateSignature = oddsHistoryStateSignature(row);
    if (!Number.isFinite(rowTime) || rowTime < cutoff || !sourceMatchId || !stateSignature) continue;
    if (!oddsHistoryRowBeforeCutoff(row)) continue;
    const key = `${sourceMatchId}|${stateSignature}`;
    const existing = byState.get(key);
    const normalized = withOddsObservationTrail({
      ...row,
      sourceMatchId,
      poolCode,
      handicapLine: poolCode === "HHAD" ? formatHandicapLineForCopy(oddsHistoryHandicapLine(row)) : 0,
      stateSignature,
      firstSeenAt: row.firstSeenAt || row.capturedAt,
      lastSeenAt: row.lastSeenAt || row.capturedAt,
      seenCount: Math.max(1, Number(row.seenCount || 1)),
    });
    if (!existing) {
      byState.set(key, normalized);
    } else {
      byState.set(key, withOddsObservationTrail({
        ...existing,
        firstSeenAt: Date.parse(existing.firstSeenAt) <= Date.parse(normalized.firstSeenAt) ? existing.firstSeenAt : normalized.firstSeenAt,
        capturedAt: Date.parse(existing.capturedAt) <= Date.parse(normalized.capturedAt) ? existing.capturedAt : normalized.capturedAt,
        lastSeenAt: Date.parse(existing.lastSeenAt) >= Date.parse(normalized.lastSeenAt) ? existing.lastSeenAt : normalized.lastSeenAt,
        seenCount: Number(existing.seenCount || 1) + Number(normalized.seenCount || 1),
      }, [normalized]));
    }
  }

  let appended = 0;
  let updated = 0;
  let unchanged = 0;
  let observationsAppended = 0;
  let observationReplays = 0;
  for (const match of matches) {
    for (const row of oddsHistoryRowsForMatch(match, capturedAt)) {
      const key = `${row.sourceMatchId}|${row.stateSignature}`;
      const existing = byState.get(key);
      if (!existing) {
        appended += 1;
        observationsAppended += Number(row.observationCount || 0);
        byState.set(key, row);
      } else {
        const priorObservationCount = Number(existing.observationCount || 0);
        const merged = withOddsObservationTrail({
          ...existing,
          lastSeenAt: existing.lastSeenAt || existing.capturedAt,
          seenCount: Math.max(
            Number(existing.seenCount || 1),
            Number(existing.observationCount || 0),
          ),
          oddsObservedAt: row.oddsObservedAt || existing.oddsObservedAt || null,
          oddsReceivedAt: existing.oddsReceivedAt || row.oddsReceivedAt || null,
          lastOddsReceivedAt: row.oddsReceivedAt || existing.lastOddsReceivedAt || existing.oddsReceivedAt || null,
          lastSourceCycleId: row.sourceCycleId || existing.lastSourceCycleId || existing.sourceCycleId || null,
          marketProvenance: row.marketProvenance || existing.marketProvenance || null,
        }, [row]);
        const nextObservationCount = Number(merged.observationCount || 0);
        const addedObservations = Math.max(0, nextObservationCount - priorObservationCount);
        if (addedObservations > 0) {
          updated += 1;
          observationsAppended += addedObservations;
          merged.lastSeenAt = merged.lastObservationAt || merged.lastSeenAt;
          merged.seenCount = Math.max(
            Number(merged.seenCount || 1),
            nextObservationCount,
          );
        } else {
          unchanged += 1;
          observationReplays += 1;
        }
        byState.set(key, merged);
      }
    }
  }

  const rows = Array.from(byState.values()).sort((a, b) => {
    const byTime = Date.parse(a.capturedAt) - Date.parse(b.capturedAt);
    if (byTime !== 0) return byTime;
    return String(a.sourceMatchId).localeCompare(String(b.sourceMatchId));
  }).slice(-ODDS_HISTORY_MAX_ROWS);

  const payload = {
    version: 3,
    source: "sporttery:HAD+HHAD",
    updatedAt: appended || updated ? capturedAt : (history.updatedAt || capturedAt),
    retentionDays: ODDS_HISTORY_RETENTION_DAYS,
    maxRows: ODDS_HISTORY_MAX_ROWS,
    writePolicy: "pre-cutoff-state-change-plus-official-receipt-trail",
    rows,
  };
  const byPool = rows.reduce((summary, row) => {
    const pool = oddsHistoryPoolCode(row);
    summary[pool] = (summary[pool] || 0) + 1;
    return summary;
  }, {});
  const observationRows = rows.reduce(
    (sum, row) => sum + Number(row.observationCount || 0),
    0,
  );
  return {
    rows: rows.length,
    appended,
    updated,
    unchanged,
    observationsAppended,
    observationReplays,
    observationRows,
    byPool,
    payload,
  };
}

function loadPredictionSnapshots(publicDir) {
  const files = [
    path.join(publicDir, "data", "prediction-snapshots.json"),
    path.join(publicDir, "prediction-snapshots.json"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = readChunkedJsonFile(file).value;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.rows)) {
        const error = new Error("prediction snapshot must be an object with rows[]");
        error.code = "PREDICTION_SNAPSHOT_INVALID";
        throw error;
      }
      for (const field of ["observations", "publicReferenceDecisions", "publicReferenceEvidence"]) {
        if (Object.hasOwn(parsed, field) && !Array.isArray(parsed[field])) {
          const error = new Error(`prediction snapshot ${field} must be an array`);
          error.code = "PREDICTION_SNAPSHOT_INVALID";
          throw error;
        }
      }
      return {
        version: Number(parsed?.version || 1),
        source: "sporttery:prediction-snapshots",
        updatedAt: parsed?.updatedAt || null,
        retentionDays: Number(parsed?.retentionDays || PREDICTION_SNAPSHOT_RETENTION_DAYS),
        maxRows: Number(parsed?.maxRows || PREDICTION_SNAPSHOT_MAX_ROWS),
        rows: Array.isArray(parsed?.rows) ? parsed.rows : [],
        publicReferenceDecisions: Array.isArray(parsed?.publicReferenceDecisions) ? parsed.publicReferenceDecisions : [],
        publicReferenceEvidence: Array.isArray(parsed?.publicReferenceEvidence) ? parsed.publicReferenceEvidence : [],
      };
    } catch (cause) {
      const error = new Error(`existing prediction snapshots cannot be read; refusing to replace history: ${cause.message}`);
      error.code = cause.code || "PREDICTION_SNAPSHOT_READ_FAILED";
      throw error;
    }
  }
  return {
    version: 1,
    source: "sporttery:prediction-snapshots",
    updatedAt: null,
    retentionDays: PREDICTION_SNAPSHOT_RETENTION_DAYS,
    maxRows: PREDICTION_SNAPSHOT_MAX_ROWS,
    rows: [],
  };
}

function predictionPhase(match, capturedAt) {
  const kickoffAt = Date.parse(match?.kickoffTime);
  const capturedTime = Date.parse(capturedAt);
  if (match?.status === "FINISHED") return "review";
  if (!Number.isFinite(kickoffAt) || !Number.isFinite(capturedTime)) return "baseline";
  const minutesToKickoff = Math.floor((kickoffAt - capturedTime) / 60000);
  if (minutesToKickoff <= 0 || match?.status === "LIVE") return "locked";
  if (minutesToKickoff <= 30) return "final";
  if (minutesToKickoff <= 90) return "late";
  if (minutesToKickoff <= 360) return "mid";
  return "baseline";
}

function snapshotTip(predictions, marketType) {
  const prediction = (predictions || []).find((item) => item.marketType === marketType);
  if (!prediction) return null;
  return {
    tipCode: prediction.tipCode,
    tipLabel: prediction.tipLabel,
    oddsPoolCode: prediction.oddsPoolCode || null,
    handicapLine: prediction.oddsPoolCode === "HHAD" && parseHandicapLine(prediction.handicapLine) !== null
      ? formatHandicapLineForCopy(prediction.handicapLine)
      : null,
    odds: prediction.odds || 0,
    trustScore: prediction.trustScore || 0,
    resultStatus: prediction.resultStatus,
    recommendationAction: prediction.recommendationAction || "reference",
    recommendationTier: prediction.recommendationTier || "reference",
    liveRecommendationAction: prediction.liveRecommendationAction || "withhold",
    liveRecommendationTier: prediction.liveRecommendationTier || "live-withhold",
    liveRecommendation: compactLiveRecommendationForAudit(prediction.liveRecommendation),
    livePublicationEvidence: compactLivePublicationEvidenceForAudit(prediction.livePublicationEvidence),
    publicationId: prediction.publicationId || null,
    publicationEvidence: prediction.publicationEvidence || null,
    multiFactorEvidence: prediction.multiFactorEvidence || null,
    riskCount: (prediction.riskTags || []).length,
  };
}

function normalizePredictionSnapshotAudit(row) {
  if (!row || typeof row !== "object") return row;
  const modelVersion = row.modelVersion || row.probabilityModelVersion || "unknown-model";
  const calibrationVersion = row.calibrationVersion || row.dynamicCalibrationVersion || "legacy-uncalibrated";
  const cutoffTime = row.cutoffTime || row.buyEndTime || row.kickoffTime || null;
  const featureSnapshot = row.featureSnapshot || {
    version: "prediction-feature-snapshot-v1",
    migrated: true,
    sourceCycleId: row.sourceCycleId || null,
    modelGeneratedAt: row.modelGeneratedAt || null,
    modelVersion,
    calibrationVersion,
    cutoffTime,
    sourceMatchId: row.sourceMatchId || null,
    kickoffTime: row.kickoffTime || null,
    market: {
      had: row.odds ? {
        odds: row.odds,
        source: row.oddsSource || null,
        observedAt: row.oddsObservedAt || null,
        receivedAt: row.oddsReceivedAt || null,
        updatedAt: row.oddsUpdatedAt || null,
        provenance: normalizeTrustedMarketSourceProvenance(row.oddsMarketProvenance),
        provenanceHash: normalizeTrustedMarketSourceProvenance(row.oddsMarketProvenance)?.hash || null,
      } : null,
      hhad: row.handicapOdds && parseHandicapLine(row.handicapLine) !== null ? {
        handicapLine: formatHandicapLineForCopy(row.handicapLine),
        odds: row.handicapOdds,
        source: row.handicapOddsSource || null,
        observedAt: row.handicapOddsObservedAt || null,
        receivedAt: row.handicapOddsReceivedAt || null,
        updatedAt: row.handicapOddsUpdatedAt || null,
        provenance: normalizeTrustedMarketSourceProvenance(row.handicapOddsMarketProvenance),
        provenanceHash: normalizeTrustedMarketSourceProvenance(row.handicapOddsMarketProvenance)?.hash || null,
      } : null,
      oddsTrend: row.oddsTrend ? {
        sampleSize: row.oddsTrend.sampleSize || 0,
        firstCapturedAt: row.oddsTrend.firstCapturedAt || null,
        lastCapturedAt: row.oddsTrend.lastCapturedAt || null,
        direction: row.oddsTrend.direction || null,
      } : null,
    },
    modelInputs: {
      oneXTwoFinal: compactFeatureTriplet(row.probabilityFinal),
      market: null,
      poisson: null,
    },
  };
  const featureSnapshotWithHash = featureSnapshot.hash
    ? featureSnapshot
    : { ...featureSnapshot, hash: hashString(JSON.stringify(featureSnapshot)) };
  return {
    ...row,
    modelVersion,
    calibrationVersion,
    cutoffTime,
    featureSnapshot: featureSnapshotWithHash,
    featureSnapshotHash: row.featureSnapshotHash || featureSnapshotWithHash.hash,
  };
}

function snapshotSignatureForMatch(match) {
  const odds = sanitizeOdds(match?.odds);
  const handicapOdds = sanitizeHandicapOdds(match);
  const final = match?.probabilityModel?.oneXTwo?.final;
  const tipSignature = predictionSignature(match?.predictions || []);
  const oddsSignature = odds
    ? `${odds.odds1.toFixed(2)}/${odds.oddsX.toFixed(2)}/${odds.odds2.toFixed(2)}`
    : "--";
  const hhadSignature = handicapOdds
    ? `${formatHandicapLineForCopy(match.handicapLine)}:${handicapOdds.odds1.toFixed(2)}/${handicapOdds.oddsX.toFixed(2)}/${handicapOdds.odds2.toFixed(2)}`
    : "--";
  const probabilitySignature = final
    ? `${Math.round(final.home)}/${Math.round(final.draw)}/${Math.round(final.away)}`
    : "--";
  return `${tipSignature}|${oddsSignature}|${hhadSignature}|${probabilitySignature}`;
}

function predictionSnapshotRow(match, capturedAt) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  const predictions = enabledPredictions(match?.predictions || []);
  if (!sourceMatchId || predictions.length === 0) return null;
  const phase = predictionPhase(match, capturedAt);
  const signature = snapshotSignatureForMatch(match);
  const finalProbabilities = match?.probabilityModel?.oneXTwo?.final || null;
  const featureSnapshot = match?.predictionMeta?.featureSnapshot
    || buildPredictionFeatureSnapshot(match, match?.predictionMeta?.generatedAt || capturedAt);
  const decisionSnapshot = buildCandidateDecisionSnapshot(match, capturedAt, {
    collectorTrustRegistry: COLLECTOR_TRUST_REGISTRY,
  });
  const publicReference = require("../src/services/publicReferenceDecision.cjs")
    .attestPublicReferenceDecision(match?.predictionMeta?.publicReferenceDecision, match);
  return normalizePredictionSnapshotAudit({
    capturedAt,
    decisionAt: decisionSnapshot?.decisionAt || null,
    sourceCycleId: decisionSnapshot?.sourceCycleId || null,
    modelGeneratedAt: decisionSnapshot?.sourceTimestamps?.modelGeneratedAt || null,
    oddsObservedAt: decisionSnapshot?.sourceTimestamps?.hadObservedAt || null,
    oddsReceivedAt: decisionSnapshot?.sourceTimestamps?.hadReceivedAt || null,
    handicapOddsObservedAt: decisionSnapshot?.sourceTimestamps?.hhadObservedAt || null,
    handicapOddsReceivedAt: decisionSnapshot?.sourceTimestamps?.hhadReceivedAt || null,
    firstSeenAt: capturedAt,
    lastSeenAt: capturedAt,
    seenCount: 1,
    phase,
    signature,
    policyVersion: match.predictionMeta?.policyVersion || PREDICTION_POLICY_VERSION,
    promptVersion: match.predictionMeta?.promptVersion || ANALYST_PROMPT_VERSION,
    decisionId: match.predictionMeta?.decisionId || null,
    decisionRevision: Number(match.predictionMeta?.decisionRevision || 1),
    eventVersion: match.eventVersion || null,
    // A pointer to the separate public ledger, never proof that this candidate
    // was published or that its probabilities equal the public evidence.
    publicReferenceHash: publicReference?.contentHash || null,
    publicReferenceEvidenceHash: publicReference?.evidenceBinding?.evidenceHash || null,
    sourceMatchId,
    matchId: match.id,
    matchNo: match.matchNo,
    businessDate: match.businessDate,
    kickoffTime: match.kickoffTime,
    status: match.status,
    leagueName: match.leagueName,
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    scoreHome: Number.isFinite(match.scoreHome) ? match.scoreHome : null,
    scoreAway: Number.isFinite(match.scoreAway) ? match.scoreAway : null,
    odds: sanitizeOdds(match.odds),
    oddsMarketProvenance: normalizeTrustedMarketSourceProvenance(match.oddsMarketProvenance),
    handicapLine: parseHandicapLine(match.handicapLine) === null
      ? null
      : formatHandicapLineForCopy(match.handicapLine),
    handicapOdds: sanitizeHandicapOdds(match),
    handicapOddsMarketProvenance: normalizeTrustedMarketSourceProvenance(match.handicapOddsMarketProvenance),
    oddsTrend: match.oddsTrend || null,
    probabilityFinal: finalProbabilities,
    probabilityModelVersion: match.probabilityModel?.version || null,
    modelVersion: predictionModelVersionFor(match),
    calibrationVersion: predictionCalibrationVersionFor(match),
    cutoffTime: match?.predictionMeta?.cutoffTime || matchCutoffValue(match) || null,
    featureSnapshot,
    decisionSnapshot,
    decisionSnapshotVersion: decisionSnapshot?.version || DECISION_SNAPSHOT_VERSION,
    best: snapshotTip(predictions, "BEST"),
    oneXTwo: snapshotTip(predictions, "1X2"),
    goals: snapshotTip(predictions, "GOALS"),
  });
}

function finiteProbability(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function finitePositiveOdds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
}

function dualMarketDecisionBindingFromSnapshotRow(match, row) {
  const decisionSnapshot = row?.decisionSnapshot;
  const hhadTrack = decisionSnapshot?.exposure?.shadowTracks?.HHAD_COMPANION;
  const hhadSelection = hhadTrack?.selection;
  const hadTip = row?.best?.oddsPoolCode === "HAD"
    ? row.best
    : row?.oneXTwo?.oddsPoolCode === "HAD"
      ? row.oneXTwo
      : null;
  const hadAnalysisTip = row?.oneXTwo?.oddsPoolCode === "HAD"
    ? row.oneXTwo
    : null;
  const hadCode = ["1", "X", "2"].includes(String(hadTip?.tipCode || ""))
    ? String(hadTip.tipCode)
    : null;
  const hadAnalysisCode = ["1", "X", "2"].includes(String(hadAnalysisTip?.tipCode || ""))
    ? String(hadAnalysisTip.tipCode)
    : null;
  const hhadCode = ["1", "X", "2"].includes(String(hhadSelection?.code || ""))
    ? String(hhadSelection.code)
    : null;
  const handicapLine = Number(hhadSelection?.handicapLine);
  const hadOdds = finitePositiveOdds(hadTip?.odds)
    ?? finitePositiveOdds(decisionSnapshot?.markets?.HAD?.odds?.[hadCode]);
  const hadModelProbability = finiteProbability(
    hadTip?.multiFactorEvidence?.modelProbability
    ?? decisionSnapshot?.probabilities?.HAD?.[hadCode]
  );
  const hadMarketProbability = finiteProbability(
    hadTip?.multiFactorEvidence?.marketProbability
    ?? decisionSnapshot?.markets?.HAD?.marketProbabilities?.[hadCode]
  );
  const hadAnalysisOdds = finitePositiveOdds(hadAnalysisTip?.odds)
    ?? finitePositiveOdds(decisionSnapshot?.markets?.HAD?.odds?.[hadAnalysisCode]);
  const hadAnalysisModelProbability = finiteProbability(
    hadAnalysisTip?.multiFactorEvidence?.modelProbability
    ?? decisionSnapshot?.probabilities?.HAD?.[hadAnalysisCode]
  );
  const hadAnalysisMarketProbability = finiteProbability(
    hadAnalysisTip?.multiFactorEvidence?.marketProbability
    ?? decisionSnapshot?.markets?.HAD?.marketProbabilities?.[hadAnalysisCode]
  );
  const hhadOdds = finitePositiveOdds(hhadSelection?.odds);
  const hhadModelProbability = finiteProbability(hhadSelection?.modelProbability);
  const hhadMarketProbability = finiteProbability(hhadSelection?.marketProbability);
  const hhadShadowEvaluated = hhadTrack?.action === "EVALUATE"
    && hhadTrack?.eligible === true;

  if (
    !decisionSnapshot
    || decisionSnapshot.version !== DECISION_SNAPSHOT_VERSION
    || !hadCode
    || hadOdds === null
    || hadModelProbability === null
    || hadMarketProbability === null
    || !hhadCode
    || !Number.isFinite(handicapLine)
    || hhadOdds === null
    || hhadModelProbability === null
    || hhadMarketProbability === null
  ) {
    return null;
  }

  const sourceClocks = {
    capturedAt: hhadTrack?.sourceTimes?.capturedAt || decisionSnapshot.capturedAt || row.capturedAt || null,
    decisionAt: hhadTrack?.sourceTimes?.decisionAt || decisionSnapshot.decisionAt || row.decisionAt || null,
    cutoffTime: hhadTrack?.cutoffTime || decisionSnapshot.cutoffTime || row.cutoffTime || null,
    modelGeneratedAt: decisionSnapshot?.sourceTimestamps?.modelGeneratedAt
      || hhadTrack?.sourceTimes?.unifiedPosteriorGeneratedAt
      || hhadTrack?.sourceTimes?.modelGeneratedAt
      || row.modelGeneratedAt
      || null,
    hadObservedAt: decisionSnapshot?.sourceTimestamps?.hadObservedAt || row.oddsObservedAt || null,
    hadReceivedAt: decisionSnapshot?.sourceTimestamps?.hadReceivedAt || row.oddsReceivedAt || null,
    hhadObservedAt: hhadTrack?.sourceTimes?.observedAt
      || decisionSnapshot?.sourceTimestamps?.hhadObservedAt
      || row.handicapOddsObservedAt
      || null,
    hhadReceivedAt: hhadTrack?.sourceTimes?.receivedAt
      || decisionSnapshot?.sourceTimestamps?.hhadReceivedAt
      || row.handicapOddsReceivedAt
      || null,
  };
  const payload = {
    version: "dual-market-decision-binding-v1",
    decisionSnapshotVersion: decisionSnapshot.version,
    sourceCycleId: decisionSnapshot.sourceCycleId || row.sourceCycleId || null,
    featureSnapshotHash: decisionSnapshot.featureSnapshotHash || row.featureSnapshotHash || null,
    featureSnapshot: row.featureSnapshot || null,
    sourceClocks,
    strategyVersions: {
      predictionPolicy: decisionSnapshot.policyVersion || row.policyVersion || null,
      prompt: decisionSnapshot.promptVersion || row.promptVersion || null,
      model: decisionSnapshot.modelVersion || row.modelVersion || null,
      calibration: decisionSnapshot.calibrationVersion || row.calibrationVersion || null,
      hhadCompanion: hhadTrack.version || null,
    },
    had: hadCode
      ? {
          poolCode: "HAD",
          code: hadCode,
          odds: hadOdds,
          modelProbability: hadModelProbability,
          marketProbability: hadMarketProbability,
          recommendationAction: hadTip?.recommendationAction || "reference",
        }
      : null,
    hadAnalysis: (
      hadAnalysisCode
      && hadAnalysisOdds !== null
      && hadAnalysisModelProbability !== null
      && hadAnalysisMarketProbability !== null
    )
      ? {
          poolCode: "HAD",
          role: "one-x-two-analysis",
          code: hadAnalysisCode,
          odds: hadAnalysisOdds,
          modelProbability: hadAnalysisModelProbability,
          marketProbability: hadAnalysisMarketProbability,
          recommendationAction: hadAnalysisTip?.recommendationAction || "reference",
        }
      : undefined,
    hhad: {
      poolCode: "HHAD",
      code: hhadCode,
      handicapLine,
      handicapLineText: hhadSelection.handicapLineText || formatHandicapLineForCopy(handicapLine),
      odds: hhadOdds,
      modelProbability: hhadModelProbability,
      marketProbability: hhadMarketProbability,
      recommendationAction: "reference",
      role: "handicap-companion",
      promotionEligible: false,
      shadowAction: hhadShadowEvaluated ? "EVALUATE" : "SKIP",
      shadowBlockers: hhadShadowEvaluated
        ? []
        : Array.from(new Set((hhadTrack?.blockers || []).map(String).filter(Boolean))).sort(),
    },
    hashes: {
      policyHash: decisionSnapshot.policyHash || null,
      hadMarketProvenanceHash: decisionSnapshot?.markets?.HAD?.provenanceHash || null,
      hhadMarketProvenanceHash: decisionSnapshot?.markets?.HHAD?.provenanceHash || null,
      strategyHash: hhadTrack?.hashes?.strategyHash || hhadTrack?.strategyHash || null,
      revisionHash: hhadTrack?.hashes?.revisionHash || hhadTrack?.revisionHash || null,
      exposureHash: hhadTrack?.hashes?.exposureHash || hhadTrack?.exposureHash || null,
      pairHash: hhadTrack?.hashes?.pairHash || hhadTrack?.pairHash || null,
    },
  };
  const binding = {
    ...payload,
    bindingHash: hashDualMarketDecisionBinding(payload),
  };
  const candidateMatch = {
    ...match,
    predictionMeta: {
      ...(match?.predictionMeta || {}),
      dualMarketDecision: binding,
    },
  };
  return attestDualMarketDecisionBinding(candidateMatch);
}

function dualMarketDecisionBindingForMatch(match, capturedAt) {
  return dualMarketDecisionBindingFromSnapshotRow(
    match,
    predictionSnapshotRow(match, capturedAt),
  );
}

function validExistingDualMarketDecisionBinding(match) {
  return attestDualMarketDecisionBinding(match);
}

function dualMarketDecisionBindingForMatchOrExisting(match, capturedAt) {
  const existing = validExistingDualMarketDecisionBinding(match);
  return (existing?.featureSnapshot ? existing : null)
    || dualMarketDecisionBindingForMatch(match, capturedAt)
    || existing
    || null;
}

function dualMarketDecisionBindingFromImmutableRowsOrExisting(match, rows) {
  const existing = validExistingDualMarketDecisionBinding(match);
  if (existing?.featureSnapshot) return existing;

  const cutoffMs = Date.parse(match?.predictionMeta?.cutoffTime || matchCutoffValue(match) || "");
  const immutableRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      if (row?.auditRole === "shadow-candidate") return false;
      const decisionMs = Date.parse(
        row?.decisionSnapshot?.decisionAt
        || row?.decisionAt
        || row?.capturedAt
        || "",
      );
      return Number.isFinite(cutoffMs)
        && Number.isFinite(decisionMs)
        && decisionMs <= cutoffMs;
    })
    .sort((left, right) => (
      Date.parse(
        right?.decisionSnapshot?.decisionAt
        || right?.decisionAt
        || right?.capturedAt
        || "",
      )
      - Date.parse(
        left?.decisionSnapshot?.decisionAt
        || left?.decisionAt
        || left?.capturedAt
        || "",
      )
    ));

  for (const row of immutableRows) {
    const restored = dualMarketDecisionBindingFromSnapshotRow(match, row);
    if (restored?.featureSnapshot) return restored;
  }
  return existing || null;
}

function predictionSnapshotComparable(row) {
  if (!row || typeof row !== "object") return "";
  return JSON.stringify({
    ...row,
    capturedAt: undefined,
    firstSeenAt: undefined,
    lastSeenAt: undefined,
    seenCount: undefined,
  });
}

function preserveImmutableLivePublicationTip(existingTip, nextTip) {
  if (!existingTip?.livePublicationEvidence) return nextTip;
  return {
    ...(nextTip || existingTip),
    oddsPoolCode: existingTip.oddsPoolCode,
    tipCode: existingTip.tipCode,
    handicapLine: existingTip.handicapLine,
    odds: existingTip.odds,
    tipLabel: existingTip.tipLabel,
    liveRecommendationAction: existingTip.liveRecommendationAction,
    liveRecommendationTier: existingTip.liveRecommendationTier,
    liveRecommendation: existingTip.liveRecommendation,
    livePublicationEvidence: existingTip.livePublicationEvidence,
  };
}

function shouldCaptureLockedShadowRevision(match, capturedAt) {
  if (!match?.predictionMeta?.lockedAt || !match?.predictionMeta?.snapshot?.latestSignature) return true;
  const capturedMs = Date.parse(capturedAt || "");
  const cutoffMs = Date.parse(match?.predictionMeta?.cutoffTime || matchCutoffValue(match) || "");
  return Number.isFinite(capturedMs) && Number.isFinite(cutoffMs) && capturedMs <= cutoffMs;
}

function retainPredictionSnapshotRows(rows, {
  maxRows = PREDICTION_SNAPSHOT_MAX_ROWS,
  maxRowsPerMatch = PREDICTION_SNAPSHOT_MAX_ROWS_PER_MATCH,
} = {}) {
  const boundedRows = Math.max(1, Number(maxRows || PREDICTION_SNAPSHOT_MAX_ROWS));
  const boundedPerMatch = Math.max(
    1,
    Number(maxRowsPerMatch || PREDICTION_SNAPSHOT_MAX_ROWS_PER_MATCH)
  );
  const ordered = (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftAt = Date.parse(left.row?.firstSeenAt || left.row?.capturedAt || "");
      const rightAt = Date.parse(right.row?.firstSeenAt || right.row?.capturedAt || "");
      const normalizedLeft = Number.isFinite(leftAt) ? leftAt : 0;
      const normalizedRight = Number.isFinite(rightAt) ? rightAt : 0;
      return normalizedLeft - normalizedRight || left.index - right.index;
    })
    .map((entry, order) => ({ ...entry, order }));
  const byMatch = new Map();
  for (const entry of ordered) {
    const matchKey = normText(entry.row?.sourceMatchId || entry.row?.matchId);
    if (!matchKey) continue;
    if (!byMatch.has(matchKey)) byMatch.set(matchKey, []);
    const retained = byMatch.get(matchKey);
    retained.push(entry);
    if (retained.length > boundedPerMatch) retained.shift();
  }
  return Array.from(byMatch.values())
    .flat()
    .sort((left, right) => left.order - right.order)
    .slice(-boundedRows)
    .map((entry) => entry.row);
}

function appendPredictionSnapshots(publicDir, matches, capturedAt, {
  observationMatches = matches,
} = {}) {
  const history = loadPredictionSnapshots(publicDir);
  const cutoff = Date.parse(capturedAt) - PREDICTION_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const byKey = new Map();
  const observations = (observationMatches || [])
    .filter((match) => shouldCaptureLockedShadowRevision(match, capturedAt))
    .map((match) => predictionSnapshotRow(match, capturedAt))
    .filter(Boolean)
    .map((row) => ({ ...row, auditRole: "shadow-candidate" }));

  for (const row of history.rows) {
    const rowTime = Date.parse(row?.lastSeenAt || row?.capturedAt);
    const sourceMatchId = normText(row?.sourceMatchId);
    const phase = normText(row?.phase);
    const signature = normText(row?.signature);
    if (!Number.isFinite(rowTime) || rowTime < cutoff || !sourceMatchId || !phase || !signature) continue;
    const normalized = normalizePredictionSnapshotAudit(row);
    const featureHash = normalized?.featureSnapshotHash || normalized?.featureSnapshot?.hash || "legacy";
    byKey.set(`${sourceMatchId}|${phase}|${signature}|${featureHash}`, normalized);
  }

  let appended = 0;
  let updated = 0;
  for (const match of matches || []) {
    // Public recommendation content remains frozen, but the independent shadow
    // audit may keep a latest eligible revision until the official cutoff.
    // After cutoff this remains fail-closed and no new decision data is written.
    if (!shouldCaptureLockedShadowRevision(match, capturedAt)) {
      continue;
    }
    const row = predictionSnapshotRow(match, capturedAt);
    if (!row) continue;
    const featureHash = row.featureSnapshotHash || row.featureSnapshot?.hash || "legacy";
    const key = `${row.sourceMatchId}|${row.phase}|${row.signature}|${featureHash}`;
    const existing = byKey.get(key);
    if (existing) {
      if (predictionSnapshotComparable(existing) !== predictionSnapshotComparable(row)) {
        updated += 1;
        byKey.set(key, {
          ...existing,
          ...row,
          // Once a live pick has a publication binding inside this immutable
          // decision snapshot, later heartbeat refreshes may update seen clocks
          // but must never rewrite the published direction, SP or deadline.
          best: preserveImmutableLivePublicationTip(existing.best, row.best),
          // A decision snapshot is an immutable as-of record. Never repair an
          // older row with clocks from a later sync; missing legacy lineage
          // must remain visible and fail closed in promotion evidence.
          decisionSnapshot: existing.decisionSnapshot || row.decisionSnapshot,
          decisionSnapshotVersion: existing.decisionSnapshotVersion || row.decisionSnapshotVersion,
          decisionAt: existing.decisionAt || row.decisionAt,
          sourceCycleId: existing.sourceCycleId || row.sourceCycleId,
          modelGeneratedAt: existing.modelGeneratedAt || row.modelGeneratedAt,
          oddsObservedAt: existing.oddsObservedAt || row.oddsObservedAt,
          oddsReceivedAt: existing.oddsReceivedAt || row.oddsReceivedAt,
          handicapOddsObservedAt: existing.handicapOddsObservedAt || row.handicapOddsObservedAt,
          handicapOddsReceivedAt: existing.handicapOddsReceivedAt || row.handicapOddsReceivedAt,
          firstSeenAt: existing.firstSeenAt || existing.capturedAt || row.firstSeenAt,
          lastSeenAt: capturedAt,
          seenCount: Number(existing.seenCount || 1) + 1,
        });
      }
    } else {
      appended += 1;
      byKey.set(key, row);
    }
  }

  // Persist the current-cycle prospective observations as the authoritative
  // row for their exact match+capture clock. A frozen public-display decision
  // can legitimately have another feature hash at that same clock; retaining
  // both would manufacture a conflicting "latest" tie in the preregistered
  // deadline selector. The observation is a complete immutable v2 decision,
  // so it is also the correct row to retain for later SQLite replay.
  const observationKeyByCapture = new Map();
  for (const observation of observations) {
    const featureHash = observation.featureSnapshotHash
      || observation.featureSnapshot?.hash
      || "legacy";
    const key = `${observation.sourceMatchId}|${observation.phase}|${observation.signature}|${featureHash}`;
    const captureKey = [
      observation.sourceMatchId,
      observation.decisionSnapshot?.capturedAt || observation.capturedAt,
    ].join("|");
    const existing = byKey.get(key);
    if (!existing) appended += 1;
    else if (predictionSnapshotComparable(existing) !== predictionSnapshotComparable(observation)) updated += 1;
    byKey.set(key, observation);
    observationKeyByCapture.set(captureKey, key);
  }

  const rows = retainPredictionSnapshotRows(
    Array.from(byKey.entries())
      .filter(([key, row]) => {
        const captureKey = [
          row?.sourceMatchId,
          row?.decisionSnapshot?.capturedAt || row?.capturedAt,
        ].join("|");
        const observationKey = observationKeyByCapture.get(captureKey);
        return !observationKey || observationKey === key;
      })
      .map(([, row]) => row),
  );
  const byPhase = rows.reduce((acc, row) => {
    acc[row.phase] = (acc[row.phase] || 0) + 1;
    return acc;
  }, {});
  const payload = {
    version: 3,
    source: "sporttery:prediction-snapshots",
    // Separate immutable public lineage; never enter the candidate deadline selector.
    publicReferenceDecisions: [...new Map([
      ...(history.publicReferenceDecisions || []),
      ...(matches || []).map((match) => match?.predictionMeta?.publicReferenceDecision).filter(Boolean),
    ].filter((record) => Date.parse(record.recordedAt) >= cutoff)
      .map((record) => [record.contentHash, record])).values()],
    updatedAt: appended || updated ? capturedAt : (history.updatedAt || capturedAt),
    retentionDays: PREDICTION_SNAPSHOT_RETENTION_DAYS,
    maxRows: PREDICTION_SNAPSHOT_MAX_ROWS,
    maxRowsPerMatch: PREDICTION_SNAPSHOT_MAX_ROWS_PER_MATCH,
    observations,
    rows,
    summary: {
      total: rows.length,
      observations: observations.length,
      byPhase,
      appended,
      updated,
    },
  };
  payload.publicReferenceEvidence = require("../src/services/publicReferenceEvidence.cjs")
    .collectPublicReferenceEvidence(payload.publicReferenceDecisions, [
      ...(history.publicReferenceEvidence || []),
      ...(matches || []).map((match) => require("../src/services/publicReferenceDecision.cjs")
        .pendingPublicReferenceEvidence(match)).filter(Boolean),
    ]);
  return payload;
}

function attachPredictionSnapshotSummary(matches, snapshotPayload, capturedAt) {
  const rowsByMatch = new Map();
  for (const row of snapshotPayload?.rows || []) {
    const key = normText(row?.sourceMatchId);
    if (!key) continue;
    if (!rowsByMatch.has(key)) rowsByMatch.set(key, []);
    rowsByMatch.get(key).push(row);
  }

  return (matches || []).map((match) => {
    const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
    const rows = rowsByMatch.get(sourceMatchId) || [];
    const lockedSnapshot = match?.predictionMeta?.snapshot;
    const contentLocked = predictionContentLocked(match, capturedAt);
    const dualMarketDecision = contentLocked
      ? dualMarketDecisionBindingFromImmutableRowsOrExisting(match, rows)
      : dualMarketDecisionBindingForMatchOrExisting(match, capturedAt);
    if (contentLocked && lockedSnapshot?.latestSignature) {
      return {
        ...match,
        predictionMeta: {
          ...(match.predictionMeta || {}),
          snapshot: lockedSnapshot,
          ...(dualMarketDecision ? { dualMarketDecision } : {}),
        },
      };
    }
    const phases = rows.reduce((acc, row) => {
      acc[row.phase] = (acc[row.phase] || 0) + 1;
      return acc;
    }, {});
    const latest = rows
      .slice()
      .sort((a, b) => Date.parse(b.lastSeenAt || b.capturedAt) - Date.parse(a.lastSeenAt || a.capturedAt))[0];

    return {
      ...match,
      predictionMeta: {
        ...(match.predictionMeta || {}),
        snapshot: {
          phase: predictionPhase(match, capturedAt),
          total: rows.length,
          phases,
          latestAt: latest?.lastSeenAt || latest?.capturedAt,
          latestSignature: latest?.signature,
        },
        ...(dualMarketDecision ? { dualMarketDecision } : {}),
      },
    };
  });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileRetry(operation, label) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (attempt < 5) sleepMs(80 + attempt * 120);
    }
  }
  throw new Error(`${label}: ${lastError?.message || lastError}`);
}

const STREAMING_JSON_MIN_ROWS = 100;
const FILE_COMPARE_BUFFER_BYTES = 1024 * 1024;

function writeBufferFully(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (written <= 0) throw new Error("streaming JSON write made no progress");
    offset += written;
  }
}

function writeTextFully(fd, text) {
  writeBufferFully(fd, Buffer.from(text, "utf8"));
}

function indentSerializedJson(serialized, spaces) {
  const prefix = " ".repeat(spaces);
  return `${prefix}${serialized.replace(/\n/g, `\n${prefix}`)}`;
}

function writePrettyJsonArray(fd, rows, indent = 0, compact = false) {
  const prefix = " ".repeat(indent);
  const itemIndent = indent + 2;
  writeTextFully(fd, "[");
  for (let index = 0; index < rows.length; index += 1) {
    const serialized = JSON.stringify(rows[index], null, compact ? undefined : 2) ?? "null";
    writeTextFully(fd, compact ? `${index === 0 ? "" : ","}${serialized}`
      : `${index === 0 ? "\n" : ",\n"}${indentSerializedJson(serialized, itemIndent)}`);
  }
  writeTextFully(fd, rows.length && !compact ? `\n${prefix}]` : "]");
}

function writePrettyJsonStreaming(file, payload, compact = false) {
  const fd = fs.openSync(file, "w", 0o640);
  try {
    if (Array.isArray(payload)) {
      writePrettyJsonArray(fd, payload, 0, compact);
      writeTextFully(fd, "\n");
      fs.fsyncSync(fd);
      return;
    }

    const entries = Object.entries(payload || {});
    writeTextFully(fd, compact ? "{" : "{\n");
    let writtenEntries = 0;
    for (const [key, value] of entries) {
      const prefix = compact ? `${writtenEntries > 0 ? "," : ""}${JSON.stringify(key)}:`
        : `${writtenEntries > 0 ? ",\n" : ""}  ${JSON.stringify(key)}: `;
      if (Array.isArray(value)) {
        writeTextFully(fd, prefix);
        writePrettyJsonArray(fd, value, 2, compact);
        writtenEntries += 1;
        continue;
      }
      const serialized = JSON.stringify(value, null, compact ? undefined : 2);
      if (serialized === undefined) continue;
      writeTextFully(
        fd,
        prefix + (compact ? serialized : serialized.replace(/\n/g, "\n  ")),
      );
      writtenEntries += 1;
    }
    writeTextFully(fd, `${writtenEntries > 0 && !compact ? "\n" : ""}}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function filesHaveSameBytes(leftPath, rightPath) {
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
  const leftStat = fs.statSync(leftPath);
  const rightStat = fs.statSync(rightPath);
  if (leftStat.size !== rightStat.size) return false;

  const leftFd = fs.openSync(leftPath, "r");
  const rightFd = fs.openSync(rightPath, "r");
  const leftBuffer = Buffer.allocUnsafe(FILE_COMPARE_BUFFER_BYTES);
  const rightBuffer = Buffer.allocUnsafe(FILE_COMPARE_BUFFER_BYTES);
  try {
    let remaining = leftStat.size;
    while (remaining > 0) {
      const chunkBytes = Math.min(remaining, FILE_COMPARE_BUFFER_BYTES);
      const leftRead = fs.readSync(leftFd, leftBuffer, 0, chunkBytes, null);
      const rightRead = fs.readSync(rightFd, rightBuffer, 0, chunkBytes, null);
      if (leftRead !== rightRead || leftRead <= 0) return false;
      if (!leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) return false;
      remaining -= leftRead;
    }
    return true;
  } finally {
    fs.closeSync(leftFd);
    fs.closeSync(rightFd);
  }
}

function replaceTemporaryFile(tmpFile, file) {
  // Never degrade an atomic same-directory rename into an in-place copy. A
  // transient Windows/antivirus lock is retried by withFileRetry; an exhausted
  // retry leaves the previous complete JSON visible instead of exposing a
  // partially copied document to readers.
  fs.renameSync(tmpFile, file);
}

function streamingJsonRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.rows)) return payload.rows;
  return null;
}

function shouldUseStreamingJson(payload) {
  const rows = streamingJsonRows(payload);
  return Boolean(rows && rows.length >= STREAMING_JSON_MIN_ROWS);
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const compact = path.basename(file) === "prediction-snapshots.json";
  const useStreamingWrite = compact || shouldUseStreamingJson(payload);

  if (!useStreamingWrite) {
    const next = `${JSON.stringify(payload, null, 2)}\n`;
    if (fs.existsSync(file) && fs.statSync(file).size === Buffer.byteLength(next, "utf8")) {
      const previous = withFileRetry(() => fs.readFileSync(file, "utf8"), `read ${file}`);
      if (previous === next) return false;
    }
    const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    withFileRetry(() => {
      fs.writeFileSync(tmpFile, next, "utf8");
      replaceTemporaryFile(tmpFile, file);
    }, `write ${file}`);
    return true;
  }

  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  return withFileRetry(() => {
    try {
      writePrettyJsonStreaming(tmpFile, payload, compact);
      if (filesHaveSameBytes(file, tmpFile)) {
        fs.unlinkSync(tmpFile);
        return false;
      }
      replaceTemporaryFile(tmpFile, file);
      return true;
    } catch (error) {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // Leave the original error intact; the retry loop will report it.
      }
      throw error;
    }
  }, `stream write ${file}`);
}

function predictionAuditSignature(match) {
  const payload = {
    predictions: Array.isArray(match?.predictions)
      ? match.predictions.map((prediction) => ({
        marketType: prediction.marketType,
        oddsPoolCode: prediction.oddsPoolCode,
        tipCode: prediction.tipCode,
        recommendationTier: prediction.recommendationTier,
        recommendationAction: prediction.recommendationAction,
      }))
      : [],
    probabilityModelVersion: match?.probabilityModel?.version || null,
    oneXTwoFinal: match?.probabilityModel?.oneXTwo?.final || null,
    handicapFinal: match?.probabilityModel?.handicap?.final || null,
    lockedAt: match?.predictionMeta?.lockedAt || null,
    cutoffTime: match?.predictionMeta?.cutoffTime || match?.buyEndTime || null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

function llmReviewRowAllowed(row, match) {
  if (!match) return false;
  const generatedMs = Date.parse(row?.generatedAt || "");
  const cutoffMs = parseBeijingDateTime(
    row?.llmReview?.audit?.cutoffTime
    || match?.predictionMeta?.cutoffTime
    || matchCutoffValue(match)
    || row?.cutoffTime
    || row?.kickoffTime
  );
  if (Number.isFinite(generatedMs) && Number.isFinite(cutoffMs) && generatedMs > cutoffMs) return false;
  const storedSignature = row?.llmReview?.audit?.sourcePredictionSignature;
  return Boolean(storedSignature) && storedSignature === predictionAuditSignature(match);
}

function pruneStaleLlmReviews(publicDir, currentMatches, capturedAt) {
  const file = path.join(publicDir, "data", "gpt-predictions.json");
  if (!fs.existsSync(file)) return { exists: false, rows: 0, kept: 0, removed: 0 };

  let payload;
  try {
    payload = JSON.parse(withFileRetry(() => fs.readFileSync(file, "utf8"), `read ${file}`));
  } catch {
    return { exists: true, rows: 0, kept: 0, removed: 0, error: "invalid-json" };
  }

  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const currentById = new Map((currentMatches || []).map((match) => [match.id, match]));
  const keptRows = rows.filter((row) => llmReviewRowAllowed(row, currentById.get(row?.matchId)));
  const removed = rows.length - keptRows.length;
  if (removed > 0) {
    writeJson(file, {
      version: Number(payload?.version || 2),
      source: payload?.source || "llm-risk-review",
      promptVersion: payload?.promptVersion || "llm-risk-review-v1",
      updatedAt: capturedAt,
      prunedAt: capturedAt,
      rows: keptRows,
    });
  }

  return {
    exists: true,
    rows: rows.length,
    kept: keptRows.length,
    removed,
  };
}

function mirrorPublishedDataToDist(publicDir) {
  if (process.env.MIRROR_PUBLISHED_DATA_TO_DIST === "0") {
    return { mirrored: false, reason: "disabled-by-policy" };
  }
  const rootDir = path.join(publicDir, "..");
  const distDir = path.join(rootDir, "dist");
  if (!fs.existsSync(distDir)) return { mirrored: false, reason: "dist-missing" };

  const disabledDistPayloads = [
    "matches.json",
    "odds-history.json",
    "data/matches-current.json",
    "data/matches-history.json",
    "data/odds-history.json",
    "data/post-match-reviews.json",
    "data/external-signals.json",
    "data/five-hundred-details.json",
    "data/pre-match-signals.json",
    "data/prediction-snapshots.json",
    "data/model-calibration.json",
    "data/model-strategy.json",
    "data/api-football-cache.json",
    "data/api-football-meta.json",
    "data/gpt-predictions.json",
    "data/web-consensus-signals.json",
    "data/weather-locations.json",
    "data/worldcup-kimi-dataset.json",
  ];
  const copyPairs = [
    ["data/team-index.json", "data/team-index.json"],
    ["data/sync-meta.json", "data/sync-meta.json"],
    ["data/model-evaluation.json", "data/model-evaluation.json"],
  ];

  let copied = 0;
  let removed = 0;
  for (const relativeName of disabledDistPayloads) {
    const target = path.join(distDir, relativeName);
    if (!fs.existsSync(target)) continue;
    withFileRetry(() => fs.rmSync(target, { force: true }), `remove disabled static ${target}`);
    removed += 1;
  }

  for (const [sourceName, targetName] of copyPairs) {
    const source = path.join(publicDir, sourceName);
    if (!fs.existsSync(source)) continue;
    const target = path.join(distDir, targetName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sourceText = withFileRetry(() => fs.readFileSync(source, "utf8"), `read ${source}`);
    const targetText = fs.existsSync(target)
      ? withFileRetry(() => fs.readFileSync(target, "utf8"), `read ${target}`)
      : null;
    if (sourceText === targetText) continue;
    const tmpFile = `${target}.${process.pid}.${Date.now()}.tmp`;
    withFileRetry(() => {
      fs.writeFileSync(tmpFile, sourceText, "utf8");
      replaceTemporaryFile(tmpFile, target);
    }, `mirror ${target}`);
    copied += 1;
  }

  return { mirrored: true, copied, removed };
}

function preserveRootTimestamps(next, existing, keys) {
  if (!next || !existing || typeof next !== "object" || typeof existing !== "object") return next;
  const sanitizedNext = { ...next };
  const sanitizedExisting = { ...existing };
  for (const key of keys) {
    delete sanitizedNext[key];
    delete sanitizedExisting[key];
  }
  if (JSON.stringify(sanitizedNext) !== JSON.stringify(sanitizedExisting)) return next;
  const merged = { ...next };
  for (const key of keys) {
    if (existing[key] !== undefined) merged[key] = existing[key];
  }
  return merged;
}

function spChange(value) {
  const rounded = Number(value.toFixed(2));
  if (Object.is(rounded, -0)) return 0;
  return rounded;
}

function formatSpChange(value) {
  const rounded = spChange(value);
  if (rounded === 0) return "0.00";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}

function oddsMovePhrase(item) {
  const amount = formatSpChange(item.change);
  return {
    zh: `${item.zh} ${amount}`,
    en: `${item.en} ${amount}`,
  };
}

function oddsTrendSummary(rows, direction, strongest, candidates) {
  const moved = candidates
    .filter((item) => Math.abs(item.change) >= 0.03)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  if (direction === "flat") {
    return {
      zh: `已记录 ${rows.length} 次官方 SP 快照，胜平负主盘基本没动；这种场次不把静态赔率写成推荐，临场继续看让球盘是否补强。`,
      en: `${rows.length} official SP snapshots recorded; the 1X2 board is essentially flat, so a static board is not packaged as a pick. Keep watching handicap confirmation.`,
    };
  }

  if (direction === "mixed") {
    const moveTextZh = moved.slice(0, 2).map((item) => oddsMovePhrase(item).zh).join("，");
    const moveTextEn = moved.slice(0, 2).map((item) => oddsMovePhrase(item).en).join(", ");
    return {
      zh: `已记录 ${rows.length} 次官方 SP 快照，主要变化：${moveTextZh || "暂无单项大幅变化"}；盘面在拉扯，先按参考处理。`,
      en: `${rows.length} official SP snapshots recorded. Main moves: ${moveTextEn || "no single strong move"}; the board is mixed, so keep it as reference-only.`,
    };
  }

  const strongestPhrase = oddsMovePhrase(strongest);
  const otherMoves = candidates
    .filter((item) => item.key !== strongest.key && Math.abs(item.change) >= 0.03)
    .slice(0, 2);
  return {
    zh: `已记录 ${rows.length} 次官方 SP 快照，${strongestPhrase.zh}，市场对该方向有增温迹象${otherMoves.length ? `；同步变化：${otherMoves.map((item) => oddsMovePhrase(item).zh).join("，")}` : ""}。`,
    en: `${rows.length} official SP snapshots recorded. ${strongestPhrase.en}; that side is warming${otherMoves.length ? `, with secondary moves ${otherMoves.map((item) => oddsMovePhrase(item).en).join(", ")}` : ""}.`,
  };
}

function oddsTrendForMatch(match, historyRows) {
  const sourceMatchId = normText(match?.sourceMatchId || String(match?.id || "").replace(/^sporttery_/, ""));
  if (!sourceMatchId) return undefined;

  const kickoffMs = parseBeijingDateTime(match?.kickoffTime || match?.matchDate || "");
  const declaredCutoffMs = parseBeijingDateTime(match?.predictionMeta?.cutoffTime || matchCutoffValue(match));
  const lockedMs = parseBeijingDateTime(match?.predictionMeta?.lockedAt || "");
  const cutoffCandidates = [Date.now(), kickoffMs, declaredCutoffMs, lockedMs].filter(Number.isFinite);
  const cutoffMs = cutoffCandidates.length ? Math.min(...cutoffCandidates) : Date.now();

  const eligibleRows = historyRows
    .filter((row) => {
      const capturedMs = parseBeijingDateTime(row?.capturedAt || row?.captureBucket || "");
      return normText(row?.sourceMatchId) === sourceMatchId
        && Boolean(sanitizeOdds({ odds1: row?.odds1, oddsX: row?.oddsX, odds2: row?.odds2 }))
        && Number.isFinite(capturedMs)
        && capturedMs <= cutoffMs;
    })
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  const poolTrend = (pool) => {
    const rows = eligibleRows.filter((row) => oddsHistoryPoolCode(row) === pool);
    if (rows.length < 2) return null;
    const first = rows[0];
    const latest = rows[rows.length - 1];
    const movement = analyzeMarketMovement({
      pool,
      openOdds: { odds1: first.odds1, oddsX: first.oddsX, odds2: first.odds2 },
      currentOdds: { odds1: latest.odds1, oddsX: latest.oddsX, odds2: latest.odds2 },
      openLine: pool === "HHAD" ? first.handicapLine : 0,
      currentLine: pool === "HHAD" ? latest.handicapLine : 0,
      sampleSize: rows.length,
      openObservedAt: first.capturedAt,
      currentObservedAt: latest.lastSeenAt || latest.capturedAt,
    });
    const strongest = ["1", "X", "2"]
      .map((code) => ({ code, delta: Number(movement?.changes?.[code]?.probabilityDelta || 0) }))
      .sort((a, b) => b.delta - a.delta)[0];
    const direction = Math.abs(Number(strongest?.delta || 0)) >= 0.015
      ? (strongest.code === "1" ? "home" : strongest.code === "X" ? "draw" : "away")
      : "flat";
    return {
      sampleSize: rows.length,
      firstObservedAt: first.capturedAt,
      firstCapturedAt: first.capturedAt,
      lastCapturedAt: latest.lastSeenAt || latest.capturedAt,
      direction,
      movement,
    };
  };

  const hadTrend = poolTrend("HAD");
  const hhadTrend = poolTrend("HHAD");
  if (!hadTrend && !hhadTrend) return undefined;

  const rows = eligibleRows.filter((row) => oddsHistoryPoolCode(row) === "HAD");
  if (!hadTrend) {
    return {
      sampleSize: hhadTrend.sampleSize,
      firstObservedAt: hhadTrend.firstObservedAt,
      firstCapturedAt: hhadTrend.firstCapturedAt,
      lastCapturedAt: hhadTrend.lastCapturedAt,
      cutoffAt: new Date(cutoffMs).toISOString(),
      observationPolicy: "first-observed-to-pre-cutoff; same-line no-vig movement; never post-kickoff",
      direction: "flat",
      byPool: { HHAD: hhadTrend },
      summary: {
        zh: `已记录 ${hhadTrend.sampleSize} 次官方让球赔率快照；让球盘口变化仅作同盘口去水概率验证，不按最低 SP 选方向。`,
        en: `${hhadTrend.sampleSize} official HHAD snapshots recorded; movement is evaluated on same-line no-vig probabilities and never by the lowest SP.`,
      },
    };
  }

  const first = rows[0];
  const latest = rows[rows.length - 1];
  const changes = {
    odds1Change: spChange(Number(latest.odds1) - Number(first.odds1)),
    oddsXChange: spChange(Number(latest.oddsX) - Number(first.oddsX)),
    odds2Change: spChange(Number(latest.odds2) - Number(first.odds2)),
  };
  const candidates = [
    { key: "home", change: changes.odds1Change, zh: "主胜", en: "home win" },
    { key: "draw", change: changes.oddsXChange, zh: "平局", en: "draw" },
    { key: "away", change: changes.odds2Change, zh: "客胜", en: "away win" },
  ].sort((a, b) => a.change - b.change);
  const strongest = candidates[0];
  const hasMove = candidates.some((item) => Math.abs(item.change) >= 0.03);
  const direction = hasMove && strongest.change < -0.02 ? strongest.key : hasMove ? "mixed" : "flat";

  return {
    sampleSize: rows.length,
    firstObservedAt: first.capturedAt,
    firstCapturedAt: first.capturedAt,
    lastCapturedAt: latest.lastSeenAt || latest.capturedAt,
    cutoffAt: new Date(cutoffMs).toISOString(),
    observationPolicy: "first-observed-to-pre-cutoff; same-line no-vig movement; never post-kickoff",
    ...changes,
    direction,
    movement: hadTrend.movement,
    byPool: {
      HAD: hadTrend,
      ...(hhadTrend ? { HHAD: hhadTrend } : {}),
    },
    summary: oddsTrendSummary(rows, direction, strongest, candidates),
  };
}

function attachOddsTrends(matches, publicDir, historyPayload = null) {
  const history = historyPayload || loadOddsHistory(publicDir);
  return matches.map((match) => {
    const trend = oddsTrendForMatch(match, history.rows);
    return trend ? { ...match, oddsTrend: trend } : match;
  });
}

function staleOrPartialFetchReason(existingMatches, nextMatches, rawMatchesWithOdds, rawResultMatches, existingHistoryCount = 0) {
  if (existingMatches.length < 100 && existingHistoryCount < 100) return "";

  const nextSplit = splitMatchesForOutput(nextMatches);
  const safeExistingHistoryCount = Math.max(0, Number(existingHistoryCount || 0));

  if (rawMatchesWithOdds.length === 0 && nextMatches.length < existingMatches.length) {
    return `fresh Sporttery odds unavailable; keeping existing ${existingMatches.length} matches`;
  }

  if (
    safeExistingHistoryCount >= 100 &&
    nextSplit.history.length < safeExistingHistoryCount * 0.8 &&
    rawResultMatches.length < safeExistingHistoryCount * 0.8
  ) {
    return `fresh result coverage ${rawResultMatches.length} is far below existing history ${safeExistingHistoryCount}`;
  }

  return "";
}

function matchStoreKey(match) {
  return canonicalSourceMatchId(match?.sourceMatchId || match?.id);
}

function hasPublishedOfficialOdds(match) {
  return (match?.oddsSource === "sporttery:HAD" && Boolean(sanitizeOdds(match?.odds)))
    || (match?.handicapOddsSource === "sporttery:HHAD" && Boolean(sanitizeHandicapOdds(match)));
}

function strictPublishedMarketProvenance(match, poolCode) {
  const code = String(poolCode || "").toUpperCase();
  const raw = code === "HHAD"
    ? match?.handicapOddsMarketProvenance
    : match?.oddsMarketProvenance;
  const normalized = normalizeTrustedMarketSourceProvenance(raw);
  return normalized?.strict?.eligible === true ? normalized : null;
}

function preservePublishedHadMarket(target, source) {
  Object.assign(target, {
    odds: source.odds,
    oddsSource: source.oddsSource,
    oddsPoolCode: source.oddsPoolCode,
    oddsSourceMethod: source.oddsSourceMethod,
    oddsObservedAt: source.oddsObservedAt,
    oddsReceivedAt: source.oddsReceivedAt,
    oddsUpdatedAt: source.oddsUpdatedAt,
    oddsSourceUrl: source.oddsSourceUrl,
    oddsMarketProvenance: source.oddsMarketProvenance || null,
  });
}

function preservePublishedHhadMarket(target, source) {
  Object.assign(target, {
    handicapOdds: source.handicapOdds,
    handicapLine: source.handicapLine,
    handicapOddsSource: source.handicapOddsSource,
    handicapOddsPoolCode: source.handicapOddsPoolCode,
    handicapOddsSourceMethod: source.handicapOddsSourceMethod,
    handicapOddsObservedAt: source.handicapOddsObservedAt,
    handicapOddsReceivedAt: source.handicapOddsReceivedAt,
    handicapOddsUpdatedAt: source.handicapOddsUpdatedAt,
    handicapOddsSourceUrl: source.handicapOddsSourceUrl,
    handicapOddsMarketProvenance: source.handicapOddsMarketProvenance || null,
  });
}

function hasPublishedReferenceOdds(match) {
  return (String(match?.oddsSource || "").startsWith("500.com") && Boolean(sanitizeOdds(match?.odds)))
    || (String(match?.handicapOddsSource || "").startsWith("500.com") && Boolean(sanitizeHandicapOdds(match)));
}

function decimalTripletFromPercent(probabilities) {
  if (!probabilities) return null;
  return {
    home: Number(probabilities.home || 0) / 100,
    draw: Number(probabilities.draw || 0) / 100,
    away: Number(probabilities.away || 0) / 100,
  };
}

function modelInputsFromPublishedProbability(match) {
  const model = match?.probabilityModel || {};
  return {
    eloSnapshot: match?.eloSnapshot || (model.elo ? {
      homeRating: model.elo.homeRating,
      awayRating: model.elo.awayRating,
      diff: model.elo.diff,
      homeMatches: model.elo.homeMatches,
      awayMatches: model.elo.awayMatches,
      historicalSource: model.elo.historicalSource || null,
      lastUpdatedAt: model.elo.lastUpdatedAt || match?.kickoffTime,
      probabilities: decimalTripletFromPercent(model.oneXTwo?.elo),
    } : null),
    formSnapshot: match?.formSnapshot || model.form || null,
    leaguePrior: match?.leaguePrior || model.leaguePrior || null,
    worldCupPrior: match?.worldCupPrior || model.worldCupPrior || match?.externalSignals?.worldCupPrior || null,
  };
}

function predictionInputFromPublishedMatch(match, modelCalibration = null) {
  const modelInputs = modelInputsFromPublishedProbability(match);
  return {
    ...match,
    ...modelInputs,
    homeTeam: match.homeTeam || match.homeTeamName,
    awayTeam: match.awayTeam || match.awayTeamName,
    leagueName: match.leagueName || match.leagueShortName,
    leagueNameEn: match.leagueNameEn || match.leagueShortNameEn,
    countryName: match.countryName,
    countryNameEn: match.countryNameEn,
    modelCalibration: match.modelCalibration || modelCalibration || null,
  };
}

function rebuildPublishedPredictionModel(match, modelCalibration = null, executionCapture = null) {
  if (predictionContentLocked(match)) return match;
  const odds = sanitizeOdds(match?.odds);
  const handicapOdds = sanitizeHandicapOdds(match);
  const input = predictionInputFromPublishedMatch({ ...match, odds, handicapOdds }, modelCalibration);
  const calculate = odds || handicapOdds
    ? predictionSet
    : shouldBuildModelOnlyReference(match)
      ? predictionSetWithoutOfficialOdds
      : null;
  const rebuilt = calculate ? (executionCapture ? executionCapture.run(input, calculate) : calculate(input)) : null;
  if (!rebuilt) return match;
  return {
    ...match,
    predictions: rebuilt.predictions,
    probabilityModel: rebuilt.probabilityModel,
    projectedScoreHome: rebuilt.projectedScore?.home,
    projectedScoreAway: rebuilt.projectedScore?.away,
  };
}

function enrichPublishedCalculationTrace(match) {
  if (!match?.probabilityModel) return match;
  if (match.probabilityModel.calculationTrace?.version === "formula-trace-v2") return match;

  const calculationTrace = buildCalculationTraceFromPublishedModel(match, match.probabilityModel);
  if (!calculationTrace) return match;

  return {
    ...match,
    probabilityModel: {
      ...match.probabilityModel,
      calculationTrace,
    },
  };
}

function publishedOddsForPrediction(match, prediction) {
  const odds = prediction?.oddsPoolCode === "HHAD" ? match?.handicapOdds : match?.odds;
  if (prediction?.tipCode === "1") return odds?.odds1;
  if (prediction?.tipCode === "X") return odds?.oddsX;
  if (prediction?.tipCode === "2") return odds?.odds2;
  return undefined;
}

function predictionsAlignWithPublishedOdds(match) {
  for (const prediction of match?.predictions || []) {
    if (!["1X2", "BEST"].includes(prediction?.marketType)) continue;
    if (!["1", "X", "2"].includes(prediction?.tipCode)) continue;
    if (!Number.isFinite(Number(prediction?.odds)) || Number(prediction?.odds) <= 0) continue;
    const expected = publishedOddsForPrediction(match, prediction);
    if (!Number.isFinite(Number(expected))) continue;
    if (Math.abs(Number(expected) - Number(prediction.odds)) > 1e-9) return false;
  }
  return true;
}

function probabilityModelRichness(model) {
  if (!model) return 0;
  let score = 0;
  if (model.unifiedPosterior?.version) score += 8;
  if (model.elo?.historicalSource) score += 4;
  if (model.form?.historicalSource) score += 4;
  if (model.leaguePrior) score += 3;
  if (model.lambdaBlend?.scoreCalibrationVersion) score += 2;
  if (model.scoreDistribution?.length) score += 1;
  return score;
}

function reconcileOfficialResultClock(existing, fresh) {
  if (
    !existing
    || !fresh
    || fresh?.officialResultIdentity?.endpoint !== "getUniformMatchResultV1"
    || fresh?.officialResultIdentity?.scheduleTimeAuthority !== "omitted-by-official-result-feed"
  ) {
    return fresh;
  }
  const existingSourceId = matchStoreKey(existing);
  const freshSourceId = matchStoreKey(fresh);
  const existingKickoff = validAuditInstant(existing?.kickoffTime);
  const existingEventVersion = validAuditInstant(existing?.eventVersion || existing?.kickoffTime);
  const existingHome = normText(existing?.homeTeamName || existing?.homeTeam).toLowerCase();
  const existingAway = normText(existing?.awayTeamName || existing?.awayTeam).toLowerCase();
  const freshHome = normText(fresh?.homeTeamName || fresh?.homeTeam).toLowerCase();
  const freshAway = normText(fresh?.awayTeamName || fresh?.awayTeam).toLowerCase();
  if (
    !existingSourceId
    || existingSourceId !== freshSourceId
    || !existingKickoff
    || !existingEventVersion
    || !existingHome
    || !existingAway
    || existingHome !== freshHome
    || existingAway !== freshAway
  ) {
    return fresh;
  }
  return {
    ...fresh,
    kickoffTime: existing.kickoffTime,
    eventVersion: existing.eventVersion || existing.kickoffTime,
    matchDate: existing.matchDate || fresh.matchDate,
    businessDate: existing.businessDate || fresh.businessDate,
    buyEndTime: existing.buyEndTime || fresh.buyEndTime,
    officialResultIdentity: {
      ...fresh.officialResultIdentity,
      scheduleTimeAuthority: "inherited-pre-match-event-identity",
      inheritedKickoffTime: existingKickoff,
      inheritedEventVersion: existingEventVersion,
    },
  };
}

function mergePublishedMatches(existing, fresh, modelCalibration = null) {
  if (!existing) return fresh;
  fresh = reconcileOfficialResultClock(existing, fresh);

  const samePublishedEvent = predictionPersistenceSameEvent(existing, fresh);
  const predictionPolicyChanged = existing?.predictionMeta?.policyVersion !== fresh?.predictionMeta?.policyVersion
    || existing?.predictionMeta?.promptVersion !== fresh?.predictionMeta?.promptVersion
    || existing?.predictionMeta?.trainingSignature !== fresh?.predictionMeta?.trainingSignature
    || existing?.predictionMeta?.scoreCalibrationSignature !== fresh?.predictionMeta?.scoreCalibrationSignature
    || existing?.probabilityModel?.version !== fresh?.probabilityModel?.version
    || existing?.probabilityModel?.unifiedPosterior?.version
      !== fresh?.probabilityModel?.unifiedPosterior?.version;
  const freshIsModelOnly = String(fresh?.probabilityModel?.version || "").includes("model-only");
  const merged = {
    ...existing,
    ...fresh,
    // An explicit null is part of the atomic model-only snapshot contract.
    // Raw current rows omit the odds property before Sporttery opens HAD; if
    // that omission survives the merge, lifecycle reconciliation will retain
    // an obsolete probability payload forever.
    ...(freshIsModelOnly && !sanitizeOdds(fresh?.odds) ? { odds: null } : {}),
  };
  const preserveStrictHadEvidence = Boolean(
    samePublishedEvent
    && sanitizeOdds(existing?.odds)
    && existing?.oddsSource === "sporttery:HAD"
    && strictPublishedMarketProvenance(existing, "HAD")
    && fresh?.oddsSource === "sporttery:HAD"
    && sanitizeOdds(fresh?.odds)
    && !strictPublishedMarketProvenance(fresh, "HAD")
  );
  const preserveStrictHhadEvidence = Boolean(
    samePublishedEvent
    && sanitizeHandicapOdds(existing)
    && existing?.handicapOddsSource === "sporttery:HHAD"
    && strictPublishedMarketProvenance(existing, "HHAD")
    && fresh?.handicapOddsSource === "sporttery:HHAD"
    && sanitizeHandicapOdds(fresh)
    && !strictPublishedMarketProvenance(fresh, "HHAD")
  );
  // A later source row is not allowed to replace a cryptographically bound
  // odds triplet with an unsigned triplet. Provenance describes the exact
  // extracted values, so copying only the old provenance onto new odds would
  // be equally invalid; preserve the whole market atomically instead.
  if (preserveStrictHadEvidence) preservePublishedHadMarket(merged, existing);
  if (preserveStrictHhadEvidence) preservePublishedHhadMarket(merged, existing);
  if (
    !predictionPolicyChanged
    && probabilityModelRichness(existing.probabilityModel) > probabilityModelRichness(fresh.probabilityModel)
  ) {
    merged.probabilityModel = existing.probabilityModel;
    if (existing.projectedScoreHome !== undefined) merged.projectedScoreHome = existing.projectedScoreHome;
    if (existing.projectedScoreAway !== undefined) merged.projectedScoreAway = existing.projectedScoreAway;
    if (existing.stats) merged.stats = existing.stats;
  }
  const existingHasOfficial = hasPublishedOfficialOdds(existing);
  const freshHasOfficial = hasPublishedOfficialOdds(fresh);
  const freshIsReference = hasPublishedReferenceOdds(fresh);
  const existingPredictionLocked = predictionContentLocked(existing);
  const referenceMarketChangedBeforeLock = freshIsReference
    && !existingPredictionLocked
    && !predictionContentLocked(fresh)
    && marketSignalChanged(existing, fresh);
  if (existingHasOfficial && !freshHasOfficial && freshIsReference) {
    Object.assign(merged, {
      id: existing.id,
      source: existing.source,
      oddsTrend: existing.oddsTrend,
    });

    if (existingPredictionLocked) {
      Object.assign(merged, preserveLockedPredictionContent(merged, existing));
    } else if (!predictionPolicyChanged && !referenceMarketChangedBeforeLock) {
      Object.assign(merged, {
        predictions: isPredictionSettlementReady(merged)
          ? settlePredictionsForMatch(merged, existing.predictions)
          : existing.predictions,
        probabilityModel: existing.probabilityModel,
        projectedScoreHome: existing.projectedScoreHome,
        projectedScoreAway: existing.projectedScoreAway,
        stats: existing.stats,
      });
    }
  }

  if (
    samePublishedEvent
    && existing.oddsSource === "sporttery:HAD"
    && fresh.oddsSource !== "sporttery:HAD"
  ) {
    // A changed supplemental quote may trigger a fresh model rebuild, but it
    // must never replace the last trusted official market atom. Rebuild below
    // against the preserved Sporttery odds and their exact provenance.
    preservePublishedHadMarket(merged, existing);
  }

  if (
    samePublishedEvent
    && existing.handicapOddsSource === "sporttery:HHAD"
    && fresh.handicapOddsSource !== "sporttery:HHAD"
  ) {
    preservePublishedHhadMarket(merged, existing);
  }

  if (
    existingHasOfficial
    && !freshHasOfficial
    && freshIsReference
    && !existingPredictionLocked
    && (referenceMarketChangedBeforeLock || predictionPolicyChanged || !predictionsAlignWithPublishedOdds(merged))
  ) {
    const rebuilt = rebuildPublishedPredictionModel(merged, modelCalibration);
    if (!samePublishedEvent) return resolveMatchLifecycle(fresh);
    return reconcileMatchLifecycle(existing, rebuilt);
  }

  if (
    (preserveStrictHadEvidence || preserveStrictHhadEvidence)
    && !existingPredictionLocked
    && !predictionsAlignWithPublishedOdds(merged)
  ) {
    const rebuilt = rebuildPublishedPredictionModel(merged, modelCalibration);
    return reconcileMatchLifecycle(existing, rebuilt);
  }

  const protectedMerged = existingPredictionLocked
    ? preserveLockedPredictionContent(merged, existing)
    : merged;
  if (!samePublishedEvent) return resolveMatchLifecycle(fresh);
  return reconcileMatchLifecycle(existing, protectedMerged);
}

function mergeFreshWithExistingStore(existingMatches, freshMatches, modelCalibration = null) {
  const byId = new Map();
  const orderedIds = [];
  const upsert = (match, preferFresh = false) => {
    const key = matchStoreKey(match);
    if (!key) return;
    if (!byId.has(key)) orderedIds.push(key);
    const previous = byId.get(key);
    const merged = previous && !preferFresh
      ? mergeStoredPublishedMatch(previous, match)
      : mergePublishedMatches(previous, match, modelCalibration);
    byId.set(key, bindCanonicalMatchIdentity(merged, key));
  };

  for (const match of existingMatches || []) upsert(match, false);
  for (const match of freshMatches || []) upsert(match, true);

  return orderedIds
    .map((key) => byId.get(key))
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.kickoffTime || 0) - Date.parse(b.kickoffTime || 0));
}

function buildTeamIndex(matches) {
  const byTeam = new Map();
  const upsert = (match, side) => {
    const isHome = side === "home";
    const teamId = isHome ? match.homeTeamId : match.awayTeamId;
    if (!teamId) return;
    const existing = byTeam.get(teamId) || {
      teamId,
      teamName: isHome ? match.homeTeamName : match.awayTeamName,
      teamNameEn: isHome ? match.homeTeamNameEn : match.awayTeamNameEn,
      logo: isHome ? match.homeTeamLogo : match.awayTeamLogo,
      logoType: isHome ? match.homeTeamLogoType : match.awayTeamLogoType,
      countryIso: isHome ? match.homeTeamCountryIso : match.awayTeamCountryIso,
      color: isHome ? match.homeTeamColor : match.awayTeamColor,
      matchCount: 0,
      finishedCount: 0,
      firstMatchDate: "",
      lastMatchDate: "",
    };
    const date = match.kickoffDate || String(match.kickoffTime || "").slice(0, 10) || match.matchDate || match.businessDate;
    existing.matchCount += 1;
    if (match.status === "FINISHED") existing.finishedCount += 1;
    if (date && (!existing.firstMatchDate || date < existing.firstMatchDate)) existing.firstMatchDate = date;
    if (date && (!existing.lastMatchDate || date > existing.lastMatchDate)) existing.lastMatchDate = date;
    byTeam.set(teamId, existing);
  };

  for (const match of matches) {
    upsert(match, "home");
    upsert(match, "away");
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: "sporttery",
    note: "Team names are kept exactly as synced from China Sporttery.",
    teams: Array.from(byTeam.values()).sort((a, b) => String(a.teamName).localeCompare(String(b.teamName), "zh-CN")),
  };
}

async function sync() {
  const capturedAt = new Date().toISOString();
  const sourceCycleId = `sporttery-full-sync:${capturedAt}`;
  const publicDir = path.join(__dirname, "..", "public");
  const dataDir = path.join(publicDir, "data");
  fs.mkdirSync(publicDir, { recursive: true });
  const existingUnresolvedArchive = loadUnresolvedMatchArchive();
  const existingStore = loadExistingMatchStore();
  // Old builds could transiently settle predictions from a 500.com score
  // before lifecycle reconciliation rejected the non-official FINISHED state.
  // Scrub that legacy contamination before any health/calibration input reads.
  const existingMatches = existingStore.matches.map((match) => sanitizeNonOfficialResultForShadow(match));
  // loadExistingMatchStore already parsed and de-duplicated the history file.
  // Keep only the baseline count instead of retaining a second 60MB+ object
  // graph for the entire sync cycle.
  const existingHistoryCount = Math.max(existingStore.historyRows, splitMatchesForOutput(existingMatches, capturedAt, {
    retentionHours: CURRENT_UNSETTLED_RETENTION_HOURS,
  }).history.length);
  const existingSyncMeta = loadExistingSyncMeta(publicDir);
  const sqliteDataPath = process.env.DATASTORE_SQLITE_PATH || path.join(DEFAULT_STORE_DIR, "football.db");
  const { receipt: sqliteFastReceipt, finals: sqliteFastFinals } = await readRuntimeFastResultInput({
    sqlitePath: sqliteDataPath, storeDir: DEFAULT_STORE_DIR, publicDataDir: dataDir,
    existingObservations: existingSyncMeta?.fastResultObservations,
  });
  const fastResultObservations = mergeFastResultObservations(
    existingSyncMeta?.fastResultObservations,
    sqliteFastReceipt?.observations || []
  );
  const existingFastRevision = Math.max(0, Number(existingSyncMeta?.fastResultRevision || 0));
  const receiptFastRevision = Math.max(0, Number(sqliteFastReceipt?.revision || 0));
  const fastResultRevision = Math.max(existingFastRevision, receiptFastRevision);
  const fastResultPublication = receiptFastRevision >= existingFastRevision && sqliteFastReceipt
    ? {
        version: "sqlite-fast-result-v1",
        publishedAt: sqliteFastReceipt.publishedAt,
        sourceCycleId: sqliteFastReceipt.sourceCycleId,
        datasetRevision: sqliteFastReceipt.datasetRevision,
        publishedRows: Number(sqliteFastReceipt.publishedRows || 0),
      }
    : (existingSyncMeta?.fastResultPublication || null);
  const existingModelCalibration = loadExistingJsonObject(path.join(dataDir, "model-calibration.json"));
  const existingModelStrategy = loadLatestExistingJsonObject([
    path.join(dataDir, "model-strategy.json"),
    path.join(DEFAULT_STORE_DIR, "model-strategy.json"),
    path.join(__dirname, "..", "server-data", "model-strategy.json"),
  ]);
  const existingTeamIndex = loadExistingJsonObject(path.join(dataDir, "team-index.json"));
  let publicationLedgerLoad = loadPublicationLedger(RECOMMENDATION_PUBLICATION_LEDGER_PATH);
  let publicationIndex = buildPublicationLedgerIndex(publicationLedgerLoad);
  const externalSignals = loadExternalSignals(publicDir);
  const preMatchSignals = loadPreMatchSignals(publicDir);
  const uefaOfficialResults = loadUefaOfficialResults(path.join(dataDir, "uefa-official-results.json"));
  const officialClubResults = loadOfficialClubResults(path.join(dataDir, "official-club-results.json"));
  const historicalTraining = loadHistoricalTrainingIndex();
  const historicalTrainingSummary = trainingSourceSummary(historicalTraining);
  const historicalTrainingModeling = historicalTrainingSummary ? {
    ...historicalTrainingSummary,
    modelingUsage: "enabled-live-asof-after-training-cutoff",
    applicationVersion: HISTORICAL_TRAINING_APPLICATION_VERSION,
    cutoffPolicy: "aggregate seeds include results through sample.lastMatchDate; incremental Elo replays only matches whose kickoffTime is later than that event cutoff",
    cutoffAt: historicalTraining?.sample?.lastMatchDate || null,
  } : null;
  const worldCupKimiDataset = loadWorldCupKimiDataset();
  const worldCupKimiSummary = worldCupDatasetSummary(worldCupKimiDataset);
  const predictionHealth = {
    ...buildPredictionHealth(existingMatches, publicationIndex),
    dataSources: {
      worldCupKimi: {
        status: worldCupKimiSummary?.modelingStatus || "rejected",
        modelingUsage: worldCupKimiSummary?.modelingUsage || "rejected-fail-closed",
        accepted: worldCupKimiSummary?.accepted === true,
        rejectionReasons: worldCupKimiSummary?.rejectionReasons || ["dataset-unavailable"],
        audit: worldCupKimiSummary?.audit || null,
        signature: worldCupKimiSummary?.signature || null,
      },
    },
  };
  const modelCalibration = preserveRootTimestamps(
    applyModelStrategyToCalibration(buildModelCalibration(existingMatches, publicationIndex), existingModelStrategy),
    existingModelCalibration,
    ["generatedAt"]
  );
  const existingBySourceId = new Map(
    existingMatches
      .map((match) => [matchStoreKey(match), match])
      .filter(([sourceMatchId]) => sourceMatchId)
  );
  const oddsHistoryBeforeSync = await loadRuntimeOddsHistory(publicDir);
  const allRawMatches = (await fetchSportteryMatches()).map((match) => {
    const clockReconciledMatch = reconcileOfficialResultClock(
      existingBySourceId.get(matchStoreKey(match)),
      match
    );
    return {
      ...clockReconciledMatch,
      // One immutable cycle identifier binds source receipt, model generation,
      // feature capture and the resulting decision. It is created once for this
      // run and is never applied retroactively to stored snapshots.
      sourceCycleId,
    };
  });
  const unresolvedSourceIds = new Set(
    existingUnresolvedArchive.map(matchStoreKey).filter(Boolean),
  );
  const rawMatches = allRawMatches.filter((match) => (
    inMatchWindow(match)
    || (
      unresolvedSourceIds.has(matchStoreKey(match))
      && (isOfficialResultMatch(match) || isOfficialVoidMatch(match))
    )
  ));
  const rawFiveHundredFallbackMatches = buildFiveHundredFallbackMatches(externalSignals)
    .filter(inMatchWindow)
    .map((match) => ({ ...match, sourceCycleId }));
  const rawMatchesWithOdds = rawMatches.filter((match) => sanitizeOdds(match.odds));
  const rawMatchesWithHandicapOdds = rawMatches.filter((match) => sanitizeHandicapOdds(match));
  const rawResultMatches = rawMatches.filter(isOfficialResultMatch);
  const rawProvisionalResultMatches = rawFiveHundredFallbackMatches.filter((match) => Boolean(match?.provisionalResult));
  const rawMatchesForOutput = rawMatches.filter((match) => (
    match.status !== "FINISHED" ||
    hasOfficialDisplayOdds(match) ||
    isOfficialResultMatch(match)
  ));
  const rawFiveHundredFallbackForOutput = rawFiveHundredFallbackMatches.filter((match) => (
    (match.status !== "FINISHED" && hasOfficialDisplayOdds(match)) ||
    Boolean(match?.provisionalResult)
  ));
  const combinedRawMatchesForOutput = dedupeMatches([
    ...rawFiveHundredFallbackForOutput,
    ...rawMatchesForOutput,
  ]);
  // The signed seed ends at sample.lastMatchDate. Result endpoints can be
  // intermittently blocked while the current fixture endpoint still works, so
  // using rawMatches alone silently discards every trusted result observed
  // after that cutoff. Reuse the immutable local official-result store as the
  // incremental lane, then let the event-time cutoff and as-of clock filters
  // decide which rows may update Elo/form.
  const modelingRawMatches = dedupeMatches([
    ...existingMatches,
    ...rawFiveHundredFallbackMatches,
    ...rawMatches,
  ]);
  const eloSnapshots = buildEloSnapshots(modelingRawMatches, null);
  const formSnapshots = buildFormSnapshots(modelingRawMatches, null);
  const postTrainingCutoffMatches = matchesAfterHistoricalTrainingCutoff(modelingRawMatches, historicalTraining);
  const historicalEloSnapshots = buildEloSnapshots(postTrainingCutoffMatches, historicalTraining);
  const historicalFormSnapshots = buildFormSnapshots(postTrainingCutoffMatches, historicalTraining);
  const liveEloSnapshotFor = (match) => (
    historicalEloSnapshots.get(normText(match.sourceMatchId))
    || eloSnapshots.get(normText(match.sourceMatchId))
    || null
  );
  const liveFormSnapshotFor = (match) => (
    historicalFormSnapshots.get(normText(match.sourceMatchId))
    || formSnapshots.get(normText(match.sourceMatchId))
    || null
  );
  const liveLeaguePriorFor = (match) => {
    const sourceMatchId = normText(match.sourceMatchId);
    return historicalEloSnapshots.has(sourceMatchId) || historicalFormSnapshots.has(sourceMatchId)
      ? leaguePriorForMatch(historicalTraining, match)
      : null;
  };
  const usedFreshOdds = rawMatchesWithOdds.length > 0;
  let output = combinedRawMatchesForOutput
    .map((match) => enrichRawMatchWithPredictionSnapshot(match, existingBySourceId, oddsHistoryBeforeSync.rows))
    .map((match) => attachWorldCupPrior(match, worldCupKimiDataset))
    .map((match) => ({ ...match, eloSnapshot: liveEloSnapshotFor(match) }))
    .map((match) => ({
      ...match,
      formSnapshot: liveFormSnapshotFor(match),
      leaguePrior: liveLeaguePriorFor(match),
      predictionHealth,
      modelCalibration,
    }))
    .map((match) => attachCalibrationMetadataToAppMatch(toAppMatch(match), modelCalibration));

  // Preserve a private, current-cycle source view before display persistence
  // merges in an already-published recommendation. It is finalized only after
  // the same odds-trend, external-signal and model-rebuild stages as the public
  // view, so its market clock, features and probabilities remain atomic.
  let prospectiveAuditMatches = output;

  let keptExistingReason = staleOrPartialFetchReason(existingMatches, output, rawMatchesWithOdds, rawResultMatches, existingHistoryCount);
  let mergedPartialFresh = false;

  if (!output.length) {
    output = existingMatches;
    keptExistingReason = "Sporttery returned no publishable matches; kept existing match store";
    if (!output.length) throw new Error("Sporttery returned no matches and no existing matches.json is available.");
    console.log(`${keptExistingReason} (${output.length}).`);
  } else if (keptExistingReason) {
    const freshCount = output.length;
    output = mergeFreshWithExistingStore(existingMatches, output, modelCalibration);
    mergedPartialFresh = true;
    console.log(`${keptExistingReason}; merged ${freshCount} fresh rows with existing store (${output.length}).`);
  }
  // Partial source cycles retain existing scheduled rows. Re-normalize their
  // league metadata as part of every generation so a corrected parser also
  // repairs stale persisted identities (for example 巴西甲级联赛 previously
  // matching the 西甲 substring).
  output = output.map(normalizeLeagueMetadataForAppMatch);

  // A fallback merge can restore a previously published prior. Re-apply the
  // dataset gate before any downstream model rebuild so rejected priors cannot
  // influence a new prediction or survive as audit input.
  output = output.map((match) => ({
    ...attachWorldCupPrior(match, worldCupKimiDataset),
    predictionHealth,
  }));

  const previousOddsHistoryPayload = await loadRuntimeOddsHistory(publicDir);
  const oddsHistory = usedFreshOdds && (mergedPartialFresh || !keptExistingReason)
    ? appendOddsHistory(publicDir, output, capturedAt, previousOddsHistoryPayload)
    : {
        rows: previousOddsHistoryPayload.rows.length,
        appended: 0,
        updated: 0,
        skipped: keptExistingReason || "no fresh official odds",
        payload: previousOddsHistoryPayload,
      };
  const oddsHistoryPayload = oddsHistory.payload || previousOddsHistoryPayload;
  output = attachOddsTrends(output, publicDir, oddsHistoryPayload);
  output = attachExternalSignals(output, externalSignals, preMatchSignals);
  // External-signal snapshots may still contain a prior from an older sync.
  // Gate again before rebuilding the published probability model.
  output = output.map((match) => attachWorldCupPrior(match, worldCupKimiDataset));
  output = output.map(applyExternalResultSignal);
  output = output.map((match) => rebuildPublishedPredictionModel(match, modelCalibration));
  prospectiveAuditMatches = attachOddsTrends(prospectiveAuditMatches, publicDir, oddsHistoryPayload);
  const predictionExecutionCapture = require("./predictionExecutionCapture.cjs").createPredictionExecutionCapture(capturedAt);
  prospectiveAuditMatches = attachExternalSignals(prospectiveAuditMatches, externalSignals, preMatchSignals);
  prospectiveAuditMatches = prospectiveAuditMatches
    .map((match) => attachWorldCupPrior(match, worldCupKimiDataset))
    .map(applyExternalResultSignal)
    .map((match) => rebuildPublishedPredictionModel(match, modelCalibration, predictionExecutionCapture));
  prospectiveAuditMatches = finalizePublishedPredictionDecisions(
    prospectiveAuditMatches,
    new Map(),
    capturedAt,
  ).map(normalizePredictionAuditForPublish);
  const recommendationBiasAudit = {
    ...auditRecommendationBias(prospectiveAuditMatches, { nowMs: Date.parse(capturedAt) }),
    checkedAt: capturedAt,
    cohort: "prospective-pre-persistence",
  };
  if (recommendationBiasAudit.publicationBlocked) {
    throw new Error(
      `recommendation bias publication gate blocked: ${recommendationBiasAudit.blockingReasons.join(",")}`,
    );
  }
  // Persist exactly once, after every input-bearing enrichment and the final
  // published-model rebuild. This binds the immutable decision, probability
  // model, market snapshot and feature hash to one final model generation.
  // Existing locked decisions still flow through applyPredictionPersistence's
  // preservation branch and retain their original revision/source cycle.
  output = finalizePublishedPredictionDecisions(output, existingBySourceId, capturedAt);
  output = require('../src/services/prospectiveForecastInput.cjs').attachProspectiveForecastInputs(
    output, prospectiveAuditMatches, Date.now(),
  );
  output = attachImmutableAnalysisReferenceDecisions(output, existingBySourceId, capturedAt);
  output = output.map((match) => attachWorldCupPrior(match, worldCupKimiDataset));
  output = output.map(normalizePublishedPredictionText);
  output = output.map(sanitizePublishedReferenceCopy);
  output = output.map((match) => normalizePublishedStatus(match, capturedAt));
  // A degraded full fetch must not regress a final already committed by the
  // trusted SQLite fast path back into current/scheduled state.
  output = overlayFastObservedFinals(output, sqliteFastFinals, fastResultObservations);
  output = output.map(normalizePredictionAuditForPublish);
  // Persistence may intentionally reuse an unchanged legacy direction. Bind
  // that final current BEST exactly once here, after every merge/model step and
  // before snapshots/public current are serialized.
  output = finalizeLiveRecommendationPublications(output, capturedAt);
  // Formal publication is a separate, append-only commit boundary. The
  // ledger is atomically persisted and re-read before publicationId/binding
  // can enter any snapshot or public JSON.
  const publicationLedgerCommit = commitRecommendationPublicationLedger(
    output,
    capturedAt,
    { ledgerPath: RECOMMENDATION_PUBLICATION_LEDGER_PATH }
  );
  output = publicationLedgerCommit.matches;
  // Capture the public reference after persistence and publication gates. The
  // prospective shadow stream must never become its archive authority.
  output = output.map((match) => require("../src/services/publicReferenceDecision.cjs")
    .bindPublicReferenceDecision(match, existingBySourceId.get(matchStoreKey(match)),
      new Date().toISOString()));
  publicationLedgerLoad = publicationLedgerCommit.ledgerLoad;
  publicationIndex = publicationLedgerCommit.publicationIndex;
  const predictionSnapshotsPayload = appendPredictionSnapshots(
    publicDir,
    output,
    capturedAt,
    { observationMatches: prospectiveAuditMatches },
  );
  // Private pre-persistence computation evidence is not a public decision ledger.
  // Capture failures expose a diagnostic gap without changing publication or old records.
  const predictionExecutionCaptureStatus = predictionExecutionCapture.persist(DEFAULT_STORE_DIR);
  output = attachPredictionSnapshotSummary(output, predictionSnapshotsPayload, capturedAt);
  // Result-phase cards must replay the immutable pre-match BEST snapshot.
  // Mutable match.predictions can be rebuilt after kickoff and therefore must
  // never be the archive direction used by the list, detail, or shadow result
  // denominator.
  output = attachArchivedPreMatchPredictions(
    output,
    predictionSnapshotsPayload,
    publicationIndex,
    capturedAt
  );
  output = output.map(normalizePredictionAuditForPublish);
  // When the Sporttery result endpoint is WAF-blocked, an exact-clock,
  // exact-event UEFA organizer result may settle UEFA competitions. This
  // happens only after the immutable pre-match direction has been archived,
  // so the supplemental result can never rewrite the original recommendation.
  output = output.map((match) => applyUefaOfficialResult(match, uefaOfficialResults));
  output = output.map((match) => applyOfficialClubResult(match, officialClubResults));
  output = output.map(applyKLeagueOfficialResult);
  // The SQLite fast path may have observed this exact official final before
  // the full JSON rebuild started. Reapply only an exact event+score match so
  // the first immutable settlement timestamps and revisions cannot drift.
  output = output.map((match) => applyFastResultObservation(match, fastResultObservations));
  output = output.map((match) => sanitizeNonOfficialResultForShadow(match));
  // Fast-lane and supplemental official finals can arrive after the immutable
  // pre-match publication step. Settle the retained card rows only after
  // untrusted/provisional results have been demoted, and before review/output
  // validation, so FINISHED rows cannot retain stale PENDING statuses.
  output = output.map(settleTrustedPublishedPredictions);
  const postMatchReviews = attachPostMatchReviews(
    output,
    capturedAt,
    predictionSnapshotsPayload,
    publicationIndex
  );
  output = postMatchReviews.matches;
  const postMatchReviewsPayload = postMatchReviews.payload;
  const provisionalResultReviewsPayload = buildProvisionalResultReviews(
    output,
    predictionSnapshotsPayload,
    publicationIndex,
    capturedAt
  );
  postMatchReviewsPayload.shadowRows = provisionalResultReviewsPayload.rows;
  postMatchReviewsPayload.shadowSummary = provisionalResultReviewsPayload.summary;
  postMatchReviewsPayload.shadowPolicy = {
    version: provisionalResultReviewsPayload.version,
    source: provisionalResultReviewsPayload.source,
    predictionReplayPolicy: provisionalResultReviewsPayload.predictionReplayPolicy,
    formalEligible: false,
    officialMetricsEligible: false,
    promotionEligible: false,
    onlineEffect: "none",
  };
  output = output.map(stripOfficialResultOnlyPredictionContent);
  output = output.map(sanitizeSyntheticMatchStats);
  // Final fail-closed boundary for the serialized current/history payloads.
  output = output.map((match) => attachWorldCupPrior(match, worldCupKimiDataset));
  output = output.map((match) => resolveMatchLifecycle(match, { now: capturedAt }));
  const split = splitMatchesForOutput(output, capturedAt, {
    retentionHours: CURRENT_UNSETTLED_RETENTION_HOURS,
  });
  // Cache the customer-facing record once per published generation. This is
  // intentionally derived only from immutable formal BEST settlements, so a
  // page request never scans the full history database and a post-match model
  // rebuild cannot rewrite the denominator.
  postMatchReviewsPayload.formalPerformance = buildFormalReviewPerformance({
    matches: split.history,
    generatedAt: capturedAt,
  });
  postMatchReviewsPayload.referencePerformance = require("../server/referencePairedBaseline.cjs").buildReferencePerformanceWithPairs({
    matches: split.history,
    generatedAt: capturedAt,
    snapshotPayload: predictionSnapshotsPayload,
    trustRegistry: COLLECTOR_TRUST_REGISTRY,
  });
  let aiArenaPublication = null;
  let aiArenaDatabase = null;
  let aiArenaError = null;
  try {
    let previousArenaState = null;
    if (fs.existsSync(AI_ARENA_STATE_PATH)) {
      const rawState = fs.readFileSync(AI_ARENA_STATE_PATH, "utf8");
      previousArenaState = JSON.parse(rawState);
    }
    const nextArenaPublication = updateAiArenaState({
      matches: [...split.current, ...split.history],
      state: previousArenaState,
      now: capturedAt,
    });
    aiArenaDatabase = readStorageMode().postgresOnly ? {
      storage: "postgres", pending: true, reason: "awaiting-generation-projection",
    } : persistAiArenaSqlite({
      dbPath: AI_ARENA_SQLITE_PATH,
      state: nextArenaPublication.state,
      payload: nextArenaPublication.payload,
    });
    aiArenaPublication = nextArenaPublication;
  } catch (error) {
    aiArenaError = error?.message || String(error);
  }
  const liveRecommendationAudit = buildLiveRecommendationAuditSummary(split.current, capturedAt);
  const unresolvedArchive = reconcileArchivedUnsettled(
    // Include the complete pre-sync match store, not only the prior private
    // archive. A stale unresolved row may disappear from a fresh provider
    // snapshot; it must still move from public current into the private audit
    // archive instead of vanishing without a settlement record.
    [...existingUnresolvedArchive, ...existingMatches],
    output,
    capturedAt,
    { retentionHours: CURRENT_UNSETTLED_RETENTION_HOURS }
  );
  const llmReviewPrune = pruneStaleLlmReviews(publicDir, split.current, capturedAt);
  const teamIndex = preserveRootTimestamps(buildTeamIndex(output), existingTeamIndex, ["updatedAt"]);
  const publishedOddsMatches = split.current.filter((match) => sanitizeOdds(match.odds)).length;
  const publishedHandicapOddsMatches = split.current.filter((match) => sanitizeHandicapOdds(match)).length;
  const publishedOfficialOddsMatches = split.current.filter(isTrustedOddsMatch).length;
  const publishedOfficialHandicapOddsMatches = split.current.filter((match) => (
    match?.source === "sporttery" &&
    match?.handicapOddsSource === "sporttery:HHAD" &&
    String(match?.handicapOddsSourceUrl || "").includes("webapi.sporttery.cn") &&
    Boolean(sanitizeHandicapOdds(match))
  )).length;
  const publishedReferenceOddsMatches = split.current.filter((match) => String(match?.oddsSource || "").startsWith("500.com")).length;
  const publishedReferenceHandicapOddsMatches = split.current.filter((match) => (
    String(match?.handicapOddsSource || "").startsWith("500.com")
    && Boolean(sanitizeHandicapOdds(match))
  )).length;
  const publishedReferenceMarketMatches = split.current.filter(hasPublishedReferenceOdds).length;
  const publishedResultMatches = split.history.filter(isOfficialResultMatch).length
    || split.history.filter((match) => match.status === "FINISHED" && Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway)).length;
  const publishedFallbackResultMatches = split.history.filter(isFallbackResultMatch).length;
  const publishedProvisionalResultMatches = provisionalResultReviewsPayload.summary.observedMatches;
  const publishedWebConsensusMatches = split.current.filter((match) => Boolean(match?.externalSignals?.webConsensus)).length;
  const byStatus = output.reduce((acc, match) => {
    acc[match.status] = (acc[match.status] || 0) + 1;
    return acc;
  }, {});
  const outputDates = output
    .map((match) => match.businessDate || match.kickoffDate || String(match.kickoffTime || "").slice(0, 10) || match.matchDate)
    .filter(Boolean)
    .sort();
  const relaySnapshotCapturedAt = sportteryFetchSummary.relaySnapshot?.capturedAt || null;
  const relaySnapshotCapturedMs = Date.parse(relaySnapshotCapturedAt || "");
  const sourceObservedAt = String(sportteryFetchSummary.transport || "").startsWith("relay")
    && Number.isFinite(relaySnapshotCapturedMs)
    ? relaySnapshotCapturedAt
    : capturedAt;
  const shouldPreserveSourceTimestamp = Boolean(keptExistingReason && !mergedPartialFresh);
  const sourcePublishedAt = shouldPreserveSourceTimestamp
    ? (existingSyncMeta?.updatedAt || existingSyncMeta?.capturedAt || capturedAt)
    : sourceObservedAt;
  const freshCurrentSportteryMatches = rawMatchesForOutput.filter((match) => (
    isMatchEligibleForCurrent(match, sourceObservedAt, {
      retentionHours: CURRENT_UNSETTLED_RETENTION_HOURS,
    })
  )).length;
  const currentLaneHasFreshSporttery = freshCurrentSportteryMatches > 0;
  const oddsLaneStale = Boolean(keptExistingReason)
    && rawMatchesWithOdds.length === 0;
  const currentStale = Boolean(keptExistingReason)
    && !currentLaneHasFreshSporttery;
  const historyBaselineCount = Math.max(existingHistoryCount, split.history.length);
  const relayResultLane = sportteryFetchSummary.relaySnapshot?.resultLane || null;
  const relayResultLanePresent = Number(relayResultLane?.usableEndpoints || 0) > 0;
  const relayResultStale = String(sportteryFetchSummary.transport || "").startsWith("relay")
    && (!relayResultLanePresent || relayResultLane?.stale !== false);
  const resultStale = relayResultStale || (Boolean(keptExistingReason) && rawResultMatches.length === 0);
  const relayHistoryLane = sportteryFetchSummary.relaySnapshot?.historyLane || null;
  const relayHistoryLanePresent = Number(relayHistoryLane?.usableEndpoints || 0) > 0;
  const relayHistoryStale = String(sportteryFetchSummary.transport || "").startsWith("relay")
    && (!relayHistoryLanePresent || relayHistoryLane?.stale !== false);
  const historyStale = relayHistoryStale || (Boolean(keptExistingReason)
    && historyBaselineCount >= 100
    && rawResultMatches.length < historyBaselineCount * 0.8);
  const partialStale = new Set([currentStale, resultStale, historyStale]).size > 1;
  const fastPublicationFreshnessTime = latestTrustedIsoTime(
    fastResultPublication?.publishedAt,
    sqliteFastReceipt?.publishedAt,
    existingSyncMeta?.fastResultPublication?.publishedAt
  );
  const sourceFreshnessCandidate = keptExistingReason
    ? (existingSyncMeta?.api?.freshnessTime || existingSyncMeta?.updatedAt || existingSyncMeta?.capturedAt || sourcePublishedAt)
    : sourcePublishedAt;
  const sourceFreshnessTime = latestTrustedIsoTime(
    sourceFreshnessCandidate,
    existingSyncMeta?.sourceHealth?.sourceFreshnessTime,
    fastPublicationFreshnessTime
  ) || sourceFreshnessCandidate;
  const currentFreshnessCandidate = currentStale
    ? (
        existingSyncMeta?.api?.freshnessTime
        || existingSyncMeta?.api?.currentFreshnessTime
        || existingSyncMeta?.updatedAt
        || existingSyncMeta?.capturedAt
        || sourceFreshnessTime
      )
    : sourcePublishedAt;
  const currentFreshnessTime = latestTrustedIsoTime(
    currentFreshnessCandidate,
    existingSyncMeta?.api?.currentFreshnessTime,
    existingSyncMeta?.sourceHealth?.currentFreshnessTime,
    fastPublicationFreshnessTime
  ) || currentFreshnessCandidate;
  const resultFreshnessCandidate = relayResultLane?.capturedAt
    || (resultStale
      ? (
          existingSyncMeta?.api?.resultFreshnessTime
          || existingSyncMeta?.api?.historyFreshnessTime
          || existingSyncMeta?.api?.freshnessTime
          || existingSyncMeta?.updatedAt
          || sourceFreshnessTime
        )
      : sourcePublishedAt);
  const resultFreshnessTime = latestTrustedIsoTime(
    resultFreshnessCandidate,
    existingSyncMeta?.api?.resultFreshnessTime,
    existingSyncMeta?.sourceHealth?.resultFreshnessTime,
    fastPublicationFreshnessTime
  ) || resultFreshnessCandidate;
  const retainedHistoryFreshnessTime = latestTrustedIsoTime(
    existingSyncMeta?.api?.historyFreshnessTime,
    existingSyncMeta?.sourceHealth?.historyFreshnessTime
  );
  // The fast current/result lane does not refresh the complete paged archive.
  // When a relay history lane exists, its oldest required page clock is the
  // authoritative history clock, even if an older sync-meta value was
  // accidentally advanced by a fast publication.
  const historyFreshnessCandidate = relayHistoryLane?.capturedAt
    || (historyStale ? retainedHistoryFreshnessTime : sourcePublishedAt);
  const historyFreshnessTime = historyFreshnessCandidate || retainedHistoryFreshnessTime;
  const sourceFreshnessMs = Date.parse(sourceFreshnessTime || "");
  const currentFreshnessMs = Date.parse(currentFreshnessTime || "");
  const resultFreshnessMs = Date.parse(resultFreshnessTime || "");
  const historyFreshnessMs = Date.parse(historyFreshnessTime || "");
  const capturedMs = Date.parse(capturedAt || "");
  const sourceAgeSeconds = Number.isFinite(sourceFreshnessMs) && Number.isFinite(capturedMs)
    ? Math.max(0, Math.floor((capturedMs - sourceFreshnessMs) / 1000))
    : null;
  const currentAgeSeconds = Number.isFinite(currentFreshnessMs) && Number.isFinite(capturedMs)
    ? Math.max(0, Math.floor((capturedMs - currentFreshnessMs) / 1000))
    : null;
  const resultAgeSeconds = Number.isFinite(resultFreshnessMs) && Number.isFinite(capturedMs)
    ? Math.max(0, Math.floor((capturedMs - resultFreshnessMs) / 1000))
    : null;
  const historyAgeSeconds = Number.isFinite(historyFreshnessMs) && Number.isFinite(capturedMs)
    ? Math.max(0, Math.floor((capturedMs - historyFreshnessMs) / 1000))
    : null;
  const fallbackCoverage = {
    servingMode: currentStale
      ? ((rawFiveHundredFallbackForOutput.length > 0 || publishedReferenceMarketMatches > 0) ? "fallback-degraded" : "critical")
      : "primary",
    usable: Boolean(rawFiveHundredFallbackForOutput.length > 0 || publishedReferenceMarketMatches > 0),
    primaryStale: currentStale,
    freshPublishableMatches: combinedRawMatchesForOutput.length,
    sportteryPublishableMatches: rawMatchesForOutput.length,
    currentSportteryMatches: freshCurrentSportteryMatches,
    currentLaneFresh: currentLaneHasFreshSporttery,
    resultLaneFresh: !resultStale,
    relayResultFresh: relayResultLanePresent && relayResultLane?.stale === false,
    relayResultRows: Number(relayResultLane?.rows || 0),
    relayResultFreshnessTime: relayResultLane?.capturedAt || null,
    fiveHundredFallbackMatches: rawFiveHundredFallbackForOutput.length,
    currentMatches: split.current.length,
    referenceOddsMatches: publishedReferenceMarketMatches,
    referenceOddsCoverage: Number(safeRatio(publishedReferenceMarketMatches, Math.max(split.current.length, 1)).toFixed(4)),
    referenceOddsCoveragePercent: pct1(safeRatio(publishedReferenceMarketMatches, Math.max(split.current.length, 1))),
    officialOddsMatches: publishedOfficialOddsMatches,
    officialOddsCoverage: Number(safeRatio(publishedOfficialOddsMatches, Math.max(split.current.length, 1)).toFixed(4)),
    officialOddsCoveragePercent: pct1(safeRatio(publishedOfficialOddsMatches, Math.max(split.current.length, 1))),
    officialOddsStale: oddsLaneStale,
    fallbackReason: keptExistingReason || null,
  };
  const { payload: _oddsHistoryPayloadForWrite, ...oddsHistorySummary } = oddsHistory;
  const currentFallbackActive = fallbackCoverage.servingMode !== "primary" || Boolean(fallbackCoverage.primaryStale);
  const sourceHistoryGuardActive = Boolean(historyStale && !currentFallbackActive);

  const syncMeta = {
    version: 1,
    source: "sporttery",
    sourceCycleId,
    updatedAt: sourcePublishedAt,
    capturedAt: sourcePublishedAt,
    lastAttemptAt: capturedAt,
    ...(fastResultRevision > 0 ? {
      fastResultRevision,
    } : {}),
    ...(fastResultPublication ? {
      fastResultPublication,
    } : {}),
    fastResultObservations,
    sourceHealth: {
      servingMode: fallbackCoverage.servingMode,
      primaryStale: fallbackCoverage.primaryStale,
      usable: fallbackCoverage.usable,
      currentLaneFresh: fallbackCoverage.currentLaneFresh,
      resultLaneFresh: fallbackCoverage.resultLaneFresh,
      resultStale,
      relayResultFresh: fallbackCoverage.relayResultFresh,
      relayResultRows: fallbackCoverage.relayResultRows,
      sourceFreshnessTime,
      currentFreshnessTime,
      resultFreshnessTime,
      historyFreshnessTime,
      sourceAgeSeconds,
      currentAgeSeconds,
      resultAgeSeconds,
      historyAgeSeconds,
      fallbackReason: fallbackCoverage.fallbackReason,
    },
    sourceAttempt: {
      capturedAt,
      transport: sportteryFetchSummary.transport || "direct",
      relaySnapshotCapturedAt,
      relaySnapshotStale: sportteryFetchSummary.relaySnapshot?.stale ?? null,
      relayCurrentLaneCapturedAt: sportteryFetchSummary.relaySnapshot?.currentLane?.capturedAt || null,
      relayResultLaneCapturedAt: relayResultLane?.capturedAt || null,
      relayResultLaneStale: relayResultStale,
      relayResultRows: Number(relayResultLane?.rows || 0),
      relayHistoryLaneCapturedAt: relayHistoryLane?.capturedAt || null,
      relayHistoryLaneStale: relayHistoryStale,
      officialOddsMatches: rawMatchesWithOdds.length,
      officialHandicapOddsMatches: rawMatchesWithHandicapOdds.length,
      officialResultMatches: rawResultMatches.length,
      publishableMatches: rawMatchesForOutput.length,
      combinedPublishableMatches: combinedRawMatchesForOutput.length,
      keptExisting: Boolean(keptExistingReason),
      mergedPartialFresh,
      errors: Array.isArray(sportteryFetchSummary.errors) ? sportteryFetchSummary.errors.length : 0,
    },
    sourceFallback: {
      active: currentFallbackActive,
      servingMode: fallbackCoverage.servingMode,
      usable: fallbackCoverage.usable,
      primaryStale: fallbackCoverage.primaryStale,
      reason: fallbackCoverage.fallbackReason,
      fiveHundredFallbackMatches: fallbackCoverage.fiveHundredFallbackMatches,
      referenceOddsMatches: fallbackCoverage.referenceOddsMatches,
      officialOddsMatches: fallbackCoverage.officialOddsMatches,
      officialOddsCoverage: fallbackCoverage.officialOddsCoverage,
    },
    sourceHistoryGuard: {
      active: sourceHistoryGuardActive,
      reason: sourceHistoryGuardActive ? fallbackCoverage.fallbackReason : null,
      historyFreshnessTime,
      historyAgeSeconds,
    },
    api: {
      source: "sporttery",
      transport: sportteryFetchSummary.transport || "direct",
      relaySnapshot: sportteryFetchSummary.relaySnapshot || null,
      errors: Array.isArray(sportteryFetchSummary.errors) ? sportteryFetchSummary.errors.slice(-30) : [],
      freshnessTime: sourceFreshnessTime,
      currentFreshnessTime,
      resultFreshnessTime,
      historyFreshnessTime,
      sourceUpdatedAt: sourcePublishedAt,
      lastAttemptAt: capturedAt,
      ageSeconds: sourceAgeSeconds,
      currentAgeSeconds,
      resultAgeSeconds,
      historyAgeSeconds,
      stale: Boolean(keptExistingReason),
      currentStale,
      resultStale,
      historyStale,
      partialStale,
      syncTriggered: false,
      fallbackCoverage,
      ...(keptExistingReason ? { fallbackReason: keptExistingReason } : {}),
    },
    officialOddsMatches: publishedOfficialOddsMatches,
    officialHandicapOddsMatches: publishedOfficialHandicapOddsMatches,
    displayOddsMatches: publishedOddsMatches,
    displayHandicapOddsMatches: publishedHandicapOddsMatches,
    referenceOddsMatches: publishedReferenceOddsMatches,
    referenceHandicapOddsMatches: publishedReferenceHandicapOddsMatches,
    officialResultMatches: publishedResultMatches,
    skippedWithoutOfficialOdds: rawMatches.length - rawMatchesWithOdds.length,
    byStatus,
    coverage: { first: outputDates[0], last: outputDates[outputDates.length - 1] },
    window: { backDays: WINDOW_BACK_DAYS, forwardDays: WINDOW_FORWARD_DAYS },
    currentListPolicy: {
      version: "kickoff-retention-v1",
      evaluatedAt: capturedAt,
      unsettledRetentionHours: CURRENT_UNSETTLED_RETENTION_HOURS,
      archivedUnsettled: unresolvedArchive.length,
      behavior: "old-unsettled-exits-current-without-fabricated-settlement",
    },
    files: {
      current: split.current.length,
      history: split.history.length,
      archivedUnsettled: unresolvedArchive.length,
      teams: teamIndex.teams.length,
      predictionSnapshots: predictionSnapshotsPayload.rows.length,
      postMatchReviews: postMatchReviewsPayload.rows.length,
      provisionalResultReviews: provisionalResultReviewsPayload.rows.length,
      llmReviews: llmReviewPrune.kept,
      llmReviewsRemoved: llmReviewPrune.removed,
      externalSignals: externalSignals.count || 0,
      preMatchSignals: preMatchSignals.count || 0,
      webConsensusSignals: publishedWebConsensusMatches,
    },
    refreshPolicy: {
      workflowMinutes: SYNC_WORKFLOW_MINUTES,
      pagePollSeconds: PAGE_POLL_SECONDS,
      oddsHistoryBucketMinutes: ODDS_HISTORY_BUCKET_MINUTES,
      note: "GitHub Pages serves static JSON. The page checks for newer JSON regularly; GitHub Actions refreshes the source files on schedule.",
    },
    attempt: {
      capturedAt,
      officialOddsMatches: rawMatchesWithOdds.length,
      officialHandicapOddsMatches: rawMatchesWithHandicapOdds.length,
      officialResultMatches: rawResultMatches.length,
      fallbackResultMatches: publishedFallbackResultMatches,
      provisionalResultMatches: rawProvisionalResultMatches.length,
      publishableMatches: rawMatchesForOutput.length,
      fiveHundredFallbackMatches: rawFiveHundredFallbackForOutput.length,
      combinedPublishableMatches: combinedRawMatchesForOutput.length,
    },
    oddsHistory: oddsHistorySummary,
    predictionSnapshots: predictionSnapshotsPayload.summary,
    postMatchReviews: postMatchReviewsPayload.summary,
    provisionalResultReviews: provisionalResultReviewsPayload.summary,
    recommendationPublicationLedger: {
      version: publicationLedgerLoad?.payload?.version || null,
      valid: publicationIndex.valid,
      missing: publicationLedgerLoad.missing,
      rows: publicationIndex.rows,
      sourceRows: publicationIndex.sourceRows,
      headHash: publicationIndex.headHash,
      errors: publicationIndex.errors.slice(0, 10),
      commit: publicationLedgerCommit.summary,
      settlementPolicy: "valid-publication-id-and-immutable-binding-only; no-retroactive-formal-backfill",
    },
    recommendationBiasAudit,
    predictionExecutionCapture: predictionExecutionCaptureStatus,
    liveRecommendations: liveRecommendationAudit,
    aiArena: aiArenaPublication ? {
      version: aiArenaPublication.payload.version,
      state: aiArenaPublication.payload.state,
      monthKey: aiArenaPublication.payload.monthKey,
      weekStart: aiArenaPublication.payload.weekStart,
      weekEnd: aiArenaPublication.payload.weekEnd,
      availableMatches: aiArenaPublication.payload.availableMatches,
      targetMatches: aiArenaPublication.payload.targetMatches,
      lockedAt: aiArenaPublication.payload.lockedAt,
      poolHash: aiArenaPublication.payload.poolHash,
      submissionRootHash: aiArenaPublication.payload.submissionRootHash,
      database: aiArenaDatabase?.pending
        ? { ok: false, ...aiArenaDatabase }
        : (aiArenaDatabase ? { ok: true, counts: aiArenaDatabase.counts } : { ok: false }),
      formalStatisticsExcluded: true,
      error: null,
    } : {
      version: "ai-big-five-survival-v5",
      state: "ERROR",
      availableMatches: 0,
      targetMatches: 10,
      formalStatisticsExcluded: true,
      error: aiArenaError || "arena state update failed",
    },
    externalSignals: {
      source: externalSignals.source || "external-signals",
      updatedAt: externalSignals.updatedAt,
      matches: externalSignals.count || 0,
      webConsensusMatches: publishedWebConsensusMatches,
    },
    preMatchSignals: {
      source: preMatchSignals.source || "pre-match-signals",
      updatedAt: preMatchSignals.updatedAt,
      matches: preMatchSignals.count || 0,
    },
    modelCalibration: {
      version: modelCalibration.version,
      sample: modelCalibration.sample,
      metrics: modelCalibration.metrics,
      scoreCalibration: modelCalibration.scoreCalibration ? {
        version: modelCalibration.scoreCalibration.version,
        sample: modelCalibration.scoreCalibration.sample,
        adjustments: modelCalibration.scoreCalibration.adjustments,
        reasons: modelCalibration.scoreCalibration.reasons,
      } : null,
    },
    // Keep strategy observability separate from online injection. A shadow
    // strategy is intentionally absent from modelCalibration.strategy, but it
    // must remain visible in health metadata as shadow instead of becoming
    // null (or allowing stale guarded-active metadata to survive).
    modelStrategy: existingModelStrategy ? {
      version: existingModelStrategy.version,
      generatedAt: existingModelStrategy.generatedAt,
      activation: existingModelStrategy.activation,
      sample: existingModelStrategy.sample,
      activeGates: existingModelStrategy.activeGates,
    } : null,
    historicalTraining: historicalTrainingModeling,
    worldCupKimiData: worldCupKimiSummary,
    ...(keptExistingReason ? {
      fallback: {
        keptExisting: true,
        mergedPartialFresh,
        reason: keptExistingReason,
        existingMatches: existingMatches.length,
        freshPublishableMatches: combinedRawMatchesForOutput.length,
        sportteryPublishableMatches: rawMatchesForOutput.length,
        fiveHundredFallbackMatches: rawFiveHundredFallbackForOutput.length,
        fiveHundredResultMatches: publishedFallbackResultMatches,
        fiveHundredProvisionalResultMatches: publishedProvisionalResultMatches,
      },
    } : {}),
  };
  // Persist unresolved rows before removing them from any public current
  // payload. If the process stops between writes, auditability wins and the
  // next sync can safely reconcile the private archive again.
  writeJson(UNRESOLVED_MATCH_ARCHIVE_PATH, {
    version: 1,
    source: "sporttery-unresolved-archive",
    updatedAt: capturedAt,
    retentionHours: CURRENT_UNSETTLED_RETENTION_HOURS,
    rows: unresolvedArchive,
  });
  if (process.env.WRITE_LEGACY_STATIC_PAYLOADS !== "0") {
    writeJson(path.join(publicDir, "matches.json"), split.current);
    writeJson(path.join(publicDir, "odds-history.json"), oddsHistoryPayload);
  }
  writeJson(path.join(dataDir, "matches-current.json"), split.current);
  writeJson(path.join(dataDir, "matches-history.json"), split.history);
  writeJson(path.join(dataDir, "team-index.json"), teamIndex);
  writeJson(path.join(dataDir, "odds-history.json"), oddsHistoryPayload);
  writeJson(path.join(dataDir, "prediction-snapshots.json"), predictionSnapshotsPayload);
  writeJson(path.join(dataDir, "post-match-reviews.json"), postMatchReviewsPayload);
  writeJson(path.join(dataDir, "model-calibration.json"), modelCalibration);
  writeJson(path.join(dataDir, "recommendation-bias-audit.json"), recommendationBiasAudit);
  if (aiArenaPublication) {
    // The private state is written before its public projection. A crash can
    // therefore delay the public view, but cannot publish decisions that were
    // not already durably locked in the state store.
    writeJson(AI_ARENA_STATE_PATH, aiArenaPublication.state);
    writeJson(path.join(dataDir, "ai-arena.json"), aiArenaPublication.payload);
  }
  if (modelCalibration.strategy) {
    writeJson(path.join(dataDir, "model-strategy.json"), modelCalibration.strategy);
    writeJson(path.join(DEFAULT_STORE_DIR, "model-strategy.json"), modelCalibration.strategy);
  }
  // A relay watcher can commit a trusted final while this heavier cycle is
  // still running. Re-read the transactional SQLite receipt immediately before
  // publishing metadata. The shared commit lock closes the remaining race:
  // either this writer sees the fast receipt, or the fast writer runs after
  // this commit and re-merges the just-written full-sync metadata.
  const syncMetaCommitPath = path.join(dataDir, "sync-meta.json");
  const syncMetaCommitLock = acquireSyncMetaCommitLock({ filePath: syncMetaCommitPath });
  try {
  let latestDiskSyncMeta = null;
  try {
    latestDiskSyncMeta = JSON.parse(fs.readFileSync(syncMetaCommitPath, "utf8"));
  } catch {
    latestDiskSyncMeta = null;
  }
  if (latestDiskSyncMeta && typeof latestDiskSyncMeta === "object" && !Array.isArray(latestDiskSyncMeta)) {
    const diskFastRevision = Math.max(0, Number(latestDiskSyncMeta.fastResultRevision || 0));
    const memoryFastRevision = Math.max(0, Number(syncMeta.fastResultRevision || 0));
    const diskPublishedAt = Date.parse(latestDiskSyncMeta.fastResultPublication?.publishedAt || "");
    const memoryPublishedAt = Date.parse(syncMeta.fastResultPublication?.publishedAt || "");
    syncMeta.fastResultRevision = Math.max(memoryFastRevision, diskFastRevision);
    syncMeta.fastResultObservations = mergeFastResultObservations(
      latestDiskSyncMeta.fastResultObservations,
      syncMeta.fastResultObservations?.rows || []
    );
    if (
      diskFastRevision > memoryFastRevision
      || (
        diskFastRevision === memoryFastRevision
        && Number.isFinite(diskPublishedAt)
        && (!Number.isFinite(memoryPublishedAt) || diskPublishedAt > memoryPublishedAt)
      )
    ) {
      syncMeta.fastResultPublication = latestDiskSyncMeta.fastResultPublication;
    }
  }
  const { receipt: latestFastReceipt } = await readRuntimeFastResultInput({
    sqlitePath: sqliteDataPath, storeDir: DEFAULT_STORE_DIR, publicDataDir: dataDir, receiptOnly: true,
  });
  if (latestFastReceipt) {
    const latestFastRevision = Math.max(0, Number(latestFastReceipt.revision || 0));
    syncMeta.fastResultRevision = Math.max(
      Number(syncMeta.fastResultRevision || 0),
      latestFastRevision
    );
    syncMeta.fastResultObservations = mergeFastResultObservations(
      syncMeta.fastResultObservations,
      latestFastReceipt.observations || []
    );
    if (latestFastRevision >= Number(syncMeta.fastResultRevision || 0)) {
      syncMeta.fastResultPublication = {
        version: "sqlite-fast-result-v1",
        publishedAt: latestFastReceipt.publishedAt,
        sourceCycleId: latestFastReceipt.sourceCycleId,
        datasetRevision: latestFastReceipt.datasetRevision,
        publishedRows: Number(latestFastReceipt.publishedRows || 0),
      };
    }
  }
  const finalFastFreshnessTime = latestTrustedIsoTime(
    syncMeta.fastResultPublication?.publishedAt,
    latestDiskSyncMeta?.fastResultPublication?.publishedAt,
    latestFastReceipt?.publishedAt,
    fastPublicationFreshnessTime
  );
  const finalSourceFreshnessTime = latestTrustedIsoTime(
    syncMeta.api?.freshnessTime,
    syncMeta.sourceHealth?.sourceFreshnessTime,
    latestDiskSyncMeta?.api?.freshnessTime,
    latestDiskSyncMeta?.sourceHealth?.sourceFreshnessTime,
    finalFastFreshnessTime
  );
  const finalCurrentFreshnessTime = latestTrustedIsoTime(
    syncMeta.api?.currentFreshnessTime,
    syncMeta.sourceHealth?.currentFreshnessTime,
    latestDiskSyncMeta?.api?.currentFreshnessTime,
    latestDiskSyncMeta?.sourceHealth?.currentFreshnessTime,
    finalFastFreshnessTime
  );
  const finalResultFreshnessTime = latestTrustedIsoTime(
    syncMeta.api?.resultFreshnessTime,
    syncMeta.sourceHealth?.resultFreshnessTime,
    latestDiskSyncMeta?.api?.resultFreshnessTime,
    latestDiskSyncMeta?.sourceHealth?.resultFreshnessTime,
    finalFastFreshnessTime
  );
  const finalHistoryFreshnessTime = latestTrustedIsoTime(
    syncMeta.api?.historyFreshnessTime,
    syncMeta.sourceHealth?.historyFreshnessTime
  ) || latestTrustedIsoTime(
    latestDiskSyncMeta?.api?.historyFreshnessTime,
    latestDiskSyncMeta?.sourceHealth?.historyFreshnessTime
  );
  const freshnessAgeSeconds = (value) => {
    const valueMs = Date.parse(value || "");
    const referenceMs = Math.max(Date.parse(capturedAt || "") || 0, Date.now());
    return Number.isFinite(valueMs)
      ? Math.max(0, Math.floor((referenceMs - valueMs) / 1000))
      : null;
  };
  syncMeta.api = {
    ...(syncMeta.api || {}),
    ...(finalSourceFreshnessTime ? { freshnessTime: finalSourceFreshnessTime } : {}),
    ...(finalCurrentFreshnessTime ? { currentFreshnessTime: finalCurrentFreshnessTime } : {}),
    ...(finalResultFreshnessTime ? { resultFreshnessTime: finalResultFreshnessTime } : {}),
    ...(finalHistoryFreshnessTime ? { historyFreshnessTime: finalHistoryFreshnessTime } : {}),
    ageSeconds: freshnessAgeSeconds(finalSourceFreshnessTime),
    currentAgeSeconds: freshnessAgeSeconds(finalCurrentFreshnessTime),
    resultAgeSeconds: freshnessAgeSeconds(finalResultFreshnessTime),
    historyAgeSeconds: freshnessAgeSeconds(finalHistoryFreshnessTime),
  };
  syncMeta.sourceHealth = {
    ...(syncMeta.sourceHealth || {}),
    ...(finalSourceFreshnessTime ? { sourceFreshnessTime: finalSourceFreshnessTime } : {}),
    ...(finalCurrentFreshnessTime ? { currentFreshnessTime: finalCurrentFreshnessTime } : {}),
    ...(finalResultFreshnessTime ? { resultFreshnessTime: finalResultFreshnessTime } : {}),
    ...(finalHistoryFreshnessTime ? { historyFreshnessTime: finalHistoryFreshnessTime } : {}),
    sourceAgeSeconds: freshnessAgeSeconds(finalSourceFreshnessTime),
    currentAgeSeconds: freshnessAgeSeconds(finalCurrentFreshnessTime),
    resultAgeSeconds: freshnessAgeSeconds(finalResultFreshnessTime),
    historyAgeSeconds: freshnessAgeSeconds(finalHistoryFreshnessTime),
  };
  writeJson(syncMetaCommitPath, syncMeta);
  } finally {
    syncMetaCommitLock.release();
  }
  const distMirror = mirrorPublishedDataToDist(publicDir);
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: "sporttery",
        count: output.length,
        scanned: allRawMatches.length,
        fiveHundredFallbackScanned: rawFiveHundredFallbackMatches.length,
        officialOddsMatches: publishedOfficialOddsMatches,
        officialHandicapOddsMatches: publishedOfficialHandicapOddsMatches,
        displayOddsMatches: publishedOddsMatches,
        displayHandicapOddsMatches: publishedHandicapOddsMatches,
        referenceOddsMatches: publishedReferenceOddsMatches,
        referenceHandicapOddsMatches: publishedReferenceHandicapOddsMatches,
        fallbackResultMatches: publishedFallbackResultMatches,
        provisionalResultMatches: publishedProvisionalResultMatches,
        officialResultMatches: publishedResultMatches,
        skippedWithoutOfficialOdds: rawMatches.length - rawMatchesWithOdds.length,
        window: { backDays: WINDOW_BACK_DAYS, forwardDays: WINDOW_FORWARD_DAYS },
        coverage: { first: outputDates[0], last: outputDates[outputDates.length - 1] },
        files: {
          current: split.current.length,
          history: split.history.length,
          archivedUnsettled: unresolvedArchive.length,
          teams: teamIndex.teams.length,
          predictionSnapshots: predictionSnapshotsPayload.rows.length,
          postMatchReviews: postMatchReviewsPayload.rows.length,
          provisionalResultReviews: provisionalResultReviewsPayload.rows.length,
          llmReviews: llmReviewPrune.kept,
          llmReviewsRemoved: llmReviewPrune.removed,
          externalSignals: externalSignals.count || 0,
          preMatchSignals: preMatchSignals.count || 0,
        },
        liveRecommendations: liveRecommendationAudit,
        distMirror,
        oddsHistory: oddsHistorySummary,
        historicalTraining: historicalTrainingModeling,
        worldCupKimiData: worldCupKimiSummary,
        byStatus,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  sync().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
} else {
  module.exports = {
    loadPredictionSnapshots,
    replayPredictionWithClock: (input, clock) => executeWithPredictionClock(
      () => input.odds || input.handicapOdds ? predictionSet(input) : predictionSetWithoutOfficialOdds(input), clock ?? null),
    rebuildPublishedPredictionModel,
    attachWorldCupPrior,
    attachArchivedPreMatchPredictions,
    applyPredictionPersistence,
    buildLiveRecommendationAuditSummary,
    commitRecommendationPublicationLedger,
    finalizePublishedPredictionDecisions,
    finalizeLiveRecommendationPublications,
    attachResultAuditTimestamps,
    attachPostMatchReviews,
    attachExternalSignals,
    enrichRawMatchWithPredictionSnapshot,
    auditableDirectionalInputCoverage,
    auditWorldCupKimiDataset,
    buildUnifiedPosteriorCandidates,
    buildMarketLaneShadowAudit,
    buildOutcomeCalibrationShadow,
    buildProbabilityModel,
    buildHadHandicapRelationships,
    buildModelCalibration,
    applyModelStrategyToCalibration,
    calibrationGateForProfile,
    calibrationWeightForProfile,
    buildPostMatchReview,
    buildProvisionalResultEvidence,
    buildProvisionalResultReview,
    buildProvisionalResultReviews,
    buildFiveHundredFallbackMatches,
    buildEloSnapshots,
    buildFormSnapshots,
    buildPredictionHealth,
    buildArchivedPreMatchPrediction,
    archiveDirectionIdentity,
    canonicalArchiveBestPrediction,
    buildPredictionReviewRows,
    buildPredictionFeatureSnapshot,
    candidateExternalMarketEvidence,
    fallbackPredictionsFromSnapshots,
    mergeArchivedBestPrediction,
    hadHandicapRelationshipFromScoreRows,
    isEligiblePreMatchSnapshot,
    validArchivedPreMatchPrediction,
    leagueMeta,
    normalizeLeagueMetadataForAppMatch,
    isOfficialVoidMatch,
    isPredictionSettlementReady,
    isTrustedFinishedForSettlement,
    loadSportteryRelayFastSnapshotForAudit,
    loadSportteryRelayHistorySnapshot,
    loadSportteryRelaySnapshot,
    loadHistoricalTrainingIndex,
    matchStoreKey,
    marketEvidenceObservationSignature,
    marketSignalSignatureForMatch,
    matchesAfterHistoricalTrainingCutoff,
    loadWorldCupKimiDataset,
    matchesFromSportteryRelaySnapshot,
    mergeMatch,
    mergeFreshWithExistingStore,
    mergeStoredPublishedMatch,
    reconcileOfficialResultClock,
    mergeReviewPredictionsWithSnapshot,
    stripOfficialResultOnlyPredictionContent,
    oddsTrendForMatch,
    officialVoidDisposition,
    parseHandicapLine,
    predictionGameplayMarket,
    predictionRowsFromMatches,
    referenceShadowTighteningFromStrategy,
    safeAutomaticTuningSample,
    seedEloFromTraining,
    postMatchReviewActuals,
    predictionFromSnapshotTip,
    predictionSet,
    blendLambdasWithForm,
    predictionSetWithoutOfficialOdds,
    compactPostMatchReviewForMatch,
    postMatchReviewComparable,
    provisionalResultEvidenceForMatch,
    isFormalMainPredictionForMetrics,
    predictionSnapshotRow,
    appendPredictionSnapshots,
    resolveHandicapLine,
    resultStatus,
    selectValueAwareOneXTwo,
    shouldBuildModelOnlyReference,
    settlePredictionsForMatch,
    settleTrustedPublishedPredictions,
    teamKey,
    sanitizeNonOfficialResultForShadow,
    applyExternalResultSignal,
    attachImmutableAnalysisReferenceDecisions,
    attachPredictionSnapshotSummary,
    canonicalArchiveParityRecovery,
    dualMarketDecisionBindingFromSnapshotRow,
    dualMarketDecisionBindingForMatch,
    dualMarketDecisionBindingForMatchOrExisting,
    dualMarketDecisionBindingFromImmutableRowsOrExisting,
    shouldCaptureLockedShadowRevision,
    retainPredictionSnapshotRows,
    snapshotTip,
    sportteryPoolOdds,
    staleOrPartialFetchReason,
    shouldUseStreamingJson,
    writeJson,
    writePrettyJsonStreaming,
    filesHaveSameBytes,
    applyContextGoalAdjustments,
    applyContextLambdaAdjustment,
    buildUnifiedOneXTwoPosterior,
    buildUnifiedOneXTwoPosteriorDecision,
    evidenceAwareIndependentProbabilities,
    independentBaseLambdas,
    dataGapProfile,
    preMatchContextSignals,
    webConsensusContext,
    webConsensusDisplayEligible,
    worldCupDatasetSummary,
  };
}
