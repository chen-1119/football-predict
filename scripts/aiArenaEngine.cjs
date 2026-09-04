"use strict";

const crypto = require("node:crypto");
const { isTrustedOfficialFinal } = require("../src/services/matchLifecycle.cjs");
const {
  buildArenaEvidenceSnapshot,
  buildProfessionalDecision,
} = require("./aiArenaDecisionEngine.cjs");

const STATE_VERSION = "ai-big-five-survival-state-v1";
const PAYLOAD_VERSION = "ai-big-five-survival-v5";
const STARTING_BALANCE = 10_000;
const MIN_LOCKABLE_MATCHES = 2;
const PARTIAL_LOCK_WEEKDAY_OFFSET = 4;
const OUTCOMES = Object.freeze(["1", "X", "2"]);
const LEAGUES = Object.freeze([
  Object.freeze({ code: "premier-league", nameZh: "英超", nameEn: "Premier League", target: 2 }),
  Object.freeze({ code: "laliga", nameZh: "西甲", nameEn: "La Liga", target: 2 }),
  Object.freeze({ code: "serie-a", nameZh: "意甲", nameEn: "Serie A", target: 2 }),
  Object.freeze({ code: "bundesliga", nameZh: "德甲", nameEn: "Bundesliga", target: 2 }),
  Object.freeze({ code: "ligue-1", nameZh: "法甲", nameEn: "Ligue 1", target: 2 }),
]);
const AGENTS = Object.freeze([
  Object.freeze({ id: "gpt", name: "均衡策略", model: "autonomous-risk-v2", providerMode: "local-strategy-simulation", style: "balanced", styleZh: "全局均衡", styleEn: "Global balance", color: "#6ee7b7", staking: Object.freeze({ kellyFraction: 0.18, minEv: 0.020, minEdge: 0.005, minDataQuality: 0.45, maxAdversarialRisk: 0.75, weeklyRiskFraction: 0.18, singleRiskFraction: 0.060, correlationCapFraction: 0.10 }) }),
  Object.freeze({ id: "kimi", name: "稳健策略", model: "auditable-risk-v2", providerMode: "local-strategy-simulation", style: "steady", styleZh: "风险审慎", styleEn: "Risk first", color: "#f0b37e", staking: Object.freeze({ kellyFraction: 0.10, minEv: 0.035, minEdge: 0.010, minDataQuality: 0.60, maxAdversarialRisk: 0.55, weeklyRiskFraction: 0.12, singleRiskFraction: 0.040, correlationCapFraction: 0.07 }) }),
  Object.freeze({ id: "gemini", name: "融合策略", model: "multi-signal-risk-v2", providerMode: "local-strategy-simulation", style: "balanced", styleZh: "多信号融合", styleEn: "Multi-signal", color: "#8ab4f8", staking: Object.freeze({ kellyFraction: 0.16, minEv: 0.025, minEdge: 0.008, minDataQuality: 0.55, maxAdversarialRisk: 0.65, weeklyRiskFraction: 0.16, singleRiskFraction: 0.050, correlationCapFraction: 0.09 }) }),
  Object.freeze({ id: "deepseek", name: "价值策略", model: "autonomous-risk-v2", providerMode: "local-strategy-simulation", style: "aggressive", styleZh: "价值搜索", styleEn: "Value search", color: "#8b9cff", staking: Object.freeze({ kellyFraction: 0.22, minEv: 0.015, minEdge: 0.005, minDataQuality: 0.45, maxAdversarialRisk: 0.72, weeklyRiskFraction: 0.20, singleRiskFraction: 0.065, correlationCapFraction: 0.11 }) }),
  Object.freeze({ id: "doubao", name: "逆向策略", model: "auditable-risk-v2", providerMode: "local-strategy-simulation", style: "aggressive", styleZh: "逆向进攻", styleEn: "Contrarian attack", color: "#f4d06f", staking: Object.freeze({ kellyFraction: 0.20, minEv: 0.030, minEdge: 0.015, minDataQuality: 0.40, maxAdversarialRisk: 0.78, weeklyRiskFraction: 0.22, singleRiskFraction: 0.070, correlationCapFraction: 0.12 }) }),
  Object.freeze({ id: "qwen", name: "纪律策略", model: "autonomous-risk-v2", providerMode: "local-strategy-simulation", style: "steady", styleZh: "稳定执行", styleEn: "Stable execution", color: "#d5a6ff", staking: Object.freeze({ kellyFraction: 0.08, minEv: 0.050, minEdge: 0.015, minDataQuality: 0.65, maxAdversarialRisk: 0.50, weeklyRiskFraction: 0.10, singleRiskFraction: 0.030, correlationCapFraction: 0.06 }) }),
]);
const WEALTH_POINTS = Object.freeze([12, 9, 7, 5, 3, 1]);
const PREDICTION_POINTS = Object.freeze([8, 6, 5, 3, 2, 1]);

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const round = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positive = (value) => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};
const normalizeProbability = (value) => {
  const parsed = finite(value);
  if (parsed === null || parsed < 0) return null;
  return parsed > 1.000001 ? parsed / 100 : parsed;
};
const normalizeTriplet = (value) => {
  const home = normalizeProbability(value?.["1"] ?? value?.home);
  const draw = normalizeProbability(value?.X ?? value?.draw);
  const away = normalizeProbability(value?.["2"] ?? value?.away);
  if (home === null || draw === null || away === null) return null;
  const total = home + draw + away;
  if (!(total > 0)) return null;
  return Object.freeze({ "1": home / total, X: draw / total, "2": away / total });
};
const officialOdds = (match) => {
  if (String(match?.oddsSource || "") !== "sporttery:HAD") return null;
  const home = positive(match?.odds?.odds1);
  const draw = positive(match?.odds?.oddsX);
  const away = positive(match?.odds?.odds2);
  if (home === null || draw === null || away === null) return null;
  return Object.freeze({ "1": home, X: draw, "2": away });
};
const modelProbabilities = (match) => normalizeTriplet(match?.probabilityModel?.oneXTwo?.final);
const devig = (odds) => normalizeTriplet({ "1": 1 / odds["1"], X: 1 / odds.X, "2": 1 / odds["2"] });
const sha256 = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const shanghaiDateKey = (value) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(value instanceof Date ? value : new Date(value));
const addDays = (dateKey, days) => {
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return shanghaiDateKey(date);
};
const arenaWeekRange = (nowMs = Date.now()) => {
  const dateKey = shanghaiDateKey(nowMs);
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  const weekday = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" })
    .formatToParts(date).find((part) => part.type === "weekday")?.value
    .replace("Mon", "1").replace("Tue", "2").replace("Wed", "3").replace("Thu", "4")
    .replace("Fri", "5").replace("Sat", "6").replace("Sun", "7")) || 1;
  const weekStart = addDays(dateKey, -(weekday - 1));
  return Object.freeze({ weekStart, weekEnd: addDays(weekStart, 6) });
};
const matchDateKey = (match) => String(
  match?.businessDate || match?.matchDate || match?.kickoffDate || match?.kickoffTime || "",
).slice(0, 10);
const identifyLeagueText = (text) => {
  if (/巴甲|巴西|brazil|brasileir/.test(text)) return null;
  if (/(^|\s)epl($|\s)|(?:^|[\s/·_-])英超(?:$|[\s/·_-])|premier\s*league/.test(text)) return "premier-league";
  if (/英格兰(?:足球)?超级联赛/.test(text)) return "premier-league";
  if (/(?:^|[\s/·_-])西甲(?:$|[\s/·_-])|西班牙(?:足球)?甲级联赛|la\s*liga|laliga/.test(text)) return "laliga";
  if (/(?:^|[\s/·_-])意甲(?:$|[\s/·_-])|意大利(?:足球)?甲级联赛|serie\s*a|seriea/.test(text)) return "serie-a";
  if (/(?:^|[\s/·_-])德甲(?:$|[\s/·_-])|德国(?:足球)?甲级联赛|bundesliga/.test(text)) return "bundesliga";
  if (/(?:^|[\s/·_-])法甲(?:$|[\s/·_-])|法国(?:足球)?甲级联赛|ligue\s*1|ligue1/.test(text)) return "ligue-1";
  return null;
};
const identifyLeague = (match) => {
  const labelText = [match?.leagueName, match?.leagueNameEn, match?.leagueShortName, match?.leagueShortNameEn]
    .filter(Boolean).join(" ").toLowerCase();
  if (labelText) return identifyLeagueText(labelText);
  return identifyLeagueText(String(match?.leagueId || "").toLowerCase());
};
const matchIdentity = (match) => String(match?.sourceMatchId || match?.id || "").trim();
const resultForMatch = (match) => {
  if (match?.resultDisposition === "VOID") {
    const trustedVoid = /^sporttery(?::|$)/i.test(String(match?.voidSource || match?.resultSource || ""))
      || (match?.resultProvenance?.official === true && match?.resultProvenance?.trusted === true);
    return trustedVoid
      ? Object.freeze({
          status: "VOID",
          outcome: null,
          scoreHome: null,
          scoreAway: null,
          resultRevision: Number(match?.resultRevision || match?.postMatchReview?.settlement?.resultRevision || 0),
          resultObservedAt: match?.voidObservedAt || match?.resultUpdatedAt || null,
        })
      : null;
  }
  if (match?.status !== "FINISHED" || !isTrustedOfficialFinal(match)) return null;
  const scoreHome = finite(match?.scoreHome);
  const scoreAway = finite(match?.scoreAway);
  if (scoreHome === null || scoreAway === null || scoreHome < 0 || scoreAway < 0) return null;
  return Object.freeze({
    status: "SETTLED",
    outcome: scoreHome > scoreAway ? "1" : scoreHome < scoreAway ? "2" : "X",
    scoreHome,
    scoreAway,
    resultRevision: Number(
      match?.resultRevision
      || match?.postMatchReview?.settlement?.resultRevision
      || match?.resultProvenance?.resultRevision
      || 0,
    ),
    resultObservedAt: match?.resultProvenance?.observedAt || match?.resultUpdatedAt || null,
  });
};
const postponedRefundForMatch = (snapshot, match) => {
  if (!match || String(match.source || "") !== "sporttery" || match.status === "FINISHED") return null;
  const originalKickoff = Date.parse(snapshot?.kickoffTime || "");
  const nextKickoff = Date.parse(match?.kickoffTime || "");
  if (!Number.isFinite(originalKickoff) || !Number.isFinite(nextKickoff) || nextKickoff - originalKickoff <= 48 * 60 * 60 * 1000) return null;
  return Object.freeze({
    status: "VOID",
    outcome: null,
    scoreHome: null,
    scoreAway: null,
    resultRevision: Number(match?.resultRevision || 0),
    resultObservedAt: match?.updatedAt || match?.oddsUpdatedAt || new Date(nextKickoff).toISOString(),
    reason: "official-kickoff-postponed-over-48h",
  });
};

const emptyState = () => ({
  version: STATE_VERSION,
  updatedAt: null,
  months: {},
});
const normalizeState = (value) => {
  if (!isObject(value) || value.version !== STATE_VERSION || !isObject(value.months)) return emptyState();
  return JSON.parse(JSON.stringify(value));
};
// A week crossing a month boundary belongs to the month containing its Sunday.
// This prevents the same locked pool from resetting halfway through the week.
const monthKeyForWeek = (_weekStart, weekEnd) => weekEnd.slice(0, 7);
const ensureMonth = (state, monthKey) => {
  if (!isObject(state.months[monthKey])) {
    state.months[monthKey] = {
      monthKey,
      startingBalance: STARTING_BALANCE,
      weeks: {},
      createdAt: null,
    };
  }
  if (!isObject(state.months[monthKey].weeks)) state.months[monthKey].weeks = {};
  return state.months[monthKey];
};

const candidateRows = (matches, weekStart, weekEnd, nowMs) => matches.flatMap((match) => {
  if (match?.status !== "SCHEDULED") return [];
  const kickoffMs = Date.parse(match?.kickoffTime || "");
  if (!Number.isFinite(kickoffMs) || kickoffMs <= nowMs) return [];
  const dateKey = matchDateKey(match);
  const leagueCode = identifyLeague(match);
  const odds = officialOdds(match);
  const probabilities = modelProbabilities(match);
  const id = matchIdentity(match);
  if (!id || !leagueCode || dateKey < weekStart || dateKey > weekEnd || !odds || !probabilities) return [];
  const marketProbabilities = devig(odds);
  const evidenceSnapshot = buildArenaEvidenceSnapshot(match, {
    baseProbabilities: probabilities,
    marketProbabilities,
  });
  return [{
    id,
    matchId: String(match.id || id),
    sourceMatchId: String(match.sourceMatchId || id),
    leagueCode,
    dateKey,
    kickoffTime: match.kickoffTime,
    buyEndTime: match.buyEndTime || null,
    homeTeamName: match.homeTeamName || match.homeTeamNameEn || "Home",
    awayTeamName: match.awayTeamName || match.awayTeamNameEn || "Away",
    odds,
    baseProbabilities: probabilities,
    marketProbabilities,
    evidenceSnapshot,
    oddsSource: "sporttery:HAD",
    oddsUpdatedAt: match.oddsUpdatedAt || null,
    dataSnapshotHash: sha256({ id, kickoffTime: match.kickoffTime, odds, probabilities, evidenceSnapshot }),
  }];
});
const selectPool = (matches, weekStart, weekEnd, nowMs) => {
  const candidates = candidateRows(matches, weekStart, weekEnd, nowMs);
  const selected = LEAGUES.flatMap((league) => candidates
    .filter((row) => row.leagueCode === league.code)
    .sort((left, right) => Date.parse(left.kickoffTime) - Date.parse(right.kickoffTime) || left.id.localeCompare(right.id))
    .slice(0, league.target));
  const slots = LEAGUES.map((league) => ({
    ...league,
    count: selected.filter((row) => row.leagueCode === league.code).length,
  }));
  const complete = slots.every((slot) => slot.count === slot.target);
  const partialLockAt = `${addDays(weekStart, PARTIAL_LOCK_WEEKDAY_OFFSET)}T00:00:00+08:00`;
  return {
    candidates: selected,
    slots,
    complete,
    lockable: complete || (
      selected.length >= MIN_LOCKABLE_MATCHES
      && nowMs >= Date.parse(partialLockAt)
    ),
    partialLockAt,
  };
};

const scorelineFor = (match, pick) => {
  if (pick === "1") return "2-1";
  if (pick === "2") return "1-2";
  return "1-1";
};
const confidenceFor = (probabilities) => {
  const ordered = OUTCOMES.map((code) => probabilities[code]).sort((left, right) => right - left);
  const score = ordered[0] + Math.max(0, ordered[0] - ordered[1]) * 0.8;
  if (score >= 0.67) return 5;
  if (score >= 0.55) return 4;
  if (score >= 0.45) return 3;
  if (score >= 0.38) return 2;
  return 1;
};
const buildForecast = (agent, match) => {
  const decision = buildProfessionalDecision(agent, match);
  const probabilities = decision.probabilities;
  const pick = decision.pick;
  const confidence = confidenceFor(probabilities);
  const dataQuality = clamp(finite(decision.decisionAudit?.dataQuality) ?? 0, 0, 1);
  const adversarialRisk = clamp((finite(decision.decisionAudit?.adversarialRiskScore) ?? 100) / 100, 0, 1);
  const recommendationTier = dataQuality >= 0.75 && confidence >= 4 && adversarialRisk <= 0.45
    ? "HIGH_EVIDENCE"
    : dataQuality >= 0.50 && confidence >= 2 && adversarialRisk <= 0.70
      ? "REFERENCE"
      : "LOW_CONFIDENCE";
  return {
    matchId: match.id,
    pick,
    probabilities,
    confidence,
    projectedScore: scorelineFor(match, pick),
    reasonsZh: decision.reasonsZh,
    reasonsEn: decision.reasonsEn,
    expectedValue: decision.expectedValue,
    decisionAudit: decision.decisionAudit,
    dataQuality,
    adversarialRisk,
    recommendationTier,
    recommendationReasonCodes: [
      "DETERMINISTIC_TOP_PROBABILITY",
      `TIER_${recommendationTier}`,
      ...(decision.decisionAudit?.missingSignals?.length ? ["MISSING_SIGNALS_DISCLOSED"] : []),
    ],
    investment: false,
    stake: 0,
    stakeReasonZh: "尚未执行积分风险分配。",
    stakeReasonEn: "Point-risk allocation has not run yet.",
    stakeAudit: null,
  };
};
const balanceStatus = (balance) => {
  if (balance <= 0) return "BANKRUPT";
  if (balance < 1500) return "RED";
  if (balance < 3000) return "YELLOW";
  return "ACTIVE";
};
const stakeReason = (reasonCode, stake = 0) => {
  const reasons = {
    ALLOCATED: [`证据与预期价值通过门槛，自主分配 ${stake} 积分。`, `Evidence and expected value passed; ${stake} points allocated autonomously.`],
    BANKRUPT: ["积分为 0，继续预测但停止投入。", "Balance is zero; forecasts continue but staking stops."],
    NEGATIVE_OR_LOW_EV: ["预期价值未达到该 AI 的投入门槛，积分为 0。", "Expected value is below this AI's threshold; stake is zero."],
    EDGE_BELOW_THRESHOLD: ["相对市场优势不足，积分为 0。", "The edge over market is insufficient; stake is zero."],
    DATA_QUALITY_LOW: ["数据完整度不足，仅保留低置信推荐，积分为 0。", "Data quality is insufficient; the low-confidence recommendation remains, but stake is zero."],
    ADVERSARIAL_RISK_HIGH: ["反方审查风险过高，积分为 0。", "Adversarial-review risk is too high; stake is zero."],
    CONFIDENCE_LOW: ["方向领先幅度不足，积分为 0。", "The leading outcome margin is too small; stake is zero."],
    RED_ZONE_RESTRICTED: ["处于红区且未通过强化门槛，积分为 0。", "Red-zone enhanced thresholds were not met; stake is zero."],
    STAKE_BELOW_MINIMUM: ["凯利折算后的风险额度低于最小执行单位，积分为 0。", "The Kelly-adjusted risk amount is below the execution minimum; stake is zero."],
    WEEKLY_RISK_BUDGET_EXHAUSTED: ["本周风险预算已用尽，积分为 0。", "The weekly risk budget is exhausted; stake is zero."],
    CORRELATION_CAP_REACHED: ["同联赛同比赛日暴露达到上限，积分为 0。", "The same-league/day correlation cap is reached; stake is zero."],
  };
  return reasons[reasonCode] || ["未触发积分投入。", "No point stake was triggered."];
};
const assignInvestments = (forecasts, matchesById, agent, balance) => {
  const status = balanceStatus(balance);
  const policy = agent.staking;
  const zoneMultiplier = status === "RED" ? 0 : status === "YELLOW" ? 0.65 : 1;
  const weeklyRiskFraction = status === "RED" ? 0
    : status === "YELLOW" ? Math.min(policy.weeklyRiskFraction, 0.10) : policy.weeklyRiskFraction;
  const singleRiskFraction = status === "RED" ? 0
    : status === "YELLOW" ? Math.min(policy.singleRiskFraction, 0.04) : policy.singleRiskFraction;
  const weeklyCap = Math.max(0, Math.floor(Math.min(balance, balance * weeklyRiskFraction) / 10) * 10);
  const singleCap = Math.max(0, Math.floor(Math.min(balance, balance * singleRiskFraction) / 10) * 10);
  const correlationCap = Math.max(0, Math.floor(Math.min(balance, balance * policy.correlationCapFraction) / 10) * 10);
  let totalStake = 0;
  const groupStakes = new Map();
  const allocations = new Map();
  const ordered = [...forecasts].sort((left, right) => (
    right.expectedValue - left.expectedValue
    || right.probabilities[right.pick] - left.probabilities[left.pick]
    || right.confidence - left.confidence
    || left.matchId.localeCompare(right.matchId)
  ));

  for (const forecast of ordered) {
    const match = matchesById.get(forecast.matchId);
    const odds = positive(match?.odds?.[forecast.pick]) || 0;
    const edge = forecast.probabilities[forecast.pick] - (match?.marketProbabilities?.[forecast.pick] || 0);
    const dataQuality = clamp(finite(forecast.decisionAudit?.dataQuality) ?? 0, 0, 1);
    const adversarialRisk = clamp((finite(forecast.decisionAudit?.adversarialRiskScore) ?? 100) / 100, 0, 1);
    let reasonCode = null;
    if (status === "BANKRUPT") reasonCode = "BANKRUPT";
    else if (status === "RED") reasonCode = "RED_ZONE_RESTRICTED";
    else if (!(forecast.expectedValue >= policy.minEv) || !(odds > 1)) reasonCode = "NEGATIVE_OR_LOW_EV";
    else if (edge < policy.minEdge) reasonCode = "EDGE_BELOW_THRESHOLD";
    else if (dataQuality < policy.minDataQuality) reasonCode = "DATA_QUALITY_LOW";
    else if (adversarialRisk > policy.maxAdversarialRisk) reasonCode = "ADVERSARIAL_RISK_HIGH";
    else if (forecast.confidence < 2) reasonCode = "CONFIDENCE_LOW";

    const rawKelly = odds > 1 ? Math.max(0, forecast.expectedValue / (odds - 1)) : 0;
    const confidenceDiscount = clamp((forecast.confidence - 1) / 4, 0.15, 1);
    const longOddsDiscount = odds > 3.5 ? clamp(3.5 / odds, 0.15, 1) : 1;
    const discount = confidenceDiscount * dataQuality * (1 - adversarialRisk) * longOddsDiscount * zoneMultiplier;
    const longOddsCap = odds >= 8 ? Math.floor(balance * 0.005 / 10) * 10
      : odds > 3.5 ? Math.floor(balance * 0.02 / 10) * 10 : singleCap;
    const effectiveSingleCap = Math.min(singleCap, longOddsCap);
    const groupKey = `${match?.leagueCode || "unknown"}|${match?.dateKey || "unknown"}`;
    const groupRemaining = Math.max(0, correlationCap - (groupStakes.get(groupKey) || 0));
    const weeklyRemaining = Math.max(0, weeklyCap - totalStake);
    let stake = reasonCode ? 0 : Math.floor((balance * policy.kellyFraction * rawKelly * discount) / 10) * 10;
    stake = Math.min(stake, effectiveSingleCap, groupRemaining, weeklyRemaining);
    if (!reasonCode && weeklyRemaining < 50) reasonCode = "WEEKLY_RISK_BUDGET_EXHAUSTED";
    else if (!reasonCode && groupRemaining < 50) reasonCode = "CORRELATION_CAP_REACHED";
    else if (!reasonCode && stake < 50) reasonCode = "STAKE_BELOW_MINIMUM";
    if (reasonCode) stake = 0;
    else reasonCode = "ALLOCATED";
    if (stake > 0) {
      totalStake += stake;
      groupStakes.set(groupKey, (groupStakes.get(groupKey) || 0) + stake);
    }
    const [stakeReasonZh, stakeReasonEn] = stakeReason(reasonCode, stake);
    allocations.set(forecast.matchId, {
      investment: stake > 0,
      stake,
      stakeReasonZh,
      stakeReasonEn,
      stakeAudit: {
        policy: "fractional-kelly-evidence-risk-v2",
        eligible: stake > 0,
        reasonCode,
        rawKelly: round(rawKelly, 6),
        discount: round(discount, 6),
        dataQuality: round(dataQuality, 4),
        adversarialRisk: round(adversarialRisk, 4),
        marketEdge: round(edge, 6),
        weeklyCap,
        singleCap: effectiveSingleCap,
        correlationCap,
        allocatedStake: stake,
        reserveAfter: Math.max(0, balance - totalStake),
      },
    });
  }
  return forecasts.map((forecast) => ({ ...forecast, ...allocations.get(forecast.matchId) }));
};

const monthMetrics = (month) => {
  const weeks = Object.values(month.weeks || {}).filter((week) => week?.status === "LOCKED")
    .sort((left, right) => left.weekStart.localeCompare(right.weekStart));
  const entries = AGENTS.map((agent) => {
    let balance = STARTING_BALANCE;
    let peak = STARTING_BALANCE;
    let maxDrawdown = 0;
    let bankrupt = false;
    const brierRows = [];
    const balanceHistory = [{ at: `${month.monthKey}-01T00:00:00+08:00`, balance }];
    let won = 0;
    let lost = 0;
    let voided = 0;
    let settledStake = 0;
    let realizedProfit = 0;
    for (const week of weeks) {
      const forecastRows = week.agentForecasts?.[agent.id]?.forecasts || [];
      for (const match of week.pool || []) {
        const settlement = week.settlements?.[match.id];
        if (!settlement) continue;
        const forecast = forecastRows.find((row) => row.matchId === match.id);
        if (!forecast) continue;
        if (settlement.status === "VOID") {
          if (forecast.investment) voided += 1;
          continue;
        }
        const actual = settlement.outcome;
        const brier = OUTCOMES.reduce((sum, code) => (
          sum + (forecast.probabilities[code] - (code === actual ? 1 : 0)) ** 2
        ), 0);
        brierRows.push(brier);
        if (forecast.investment) {
          const delta = forecast.pick === actual
            ? forecast.stake * (match.odds[forecast.pick] - 1)
            : -forecast.stake;
          settledStake += forecast.stake;
          realizedProfit += delta;
          balance = Math.max(0, round(balance + delta, 2));
          if (delta >= 0) won += 1;
          else lost += 1;
          peak = Math.max(peak, balance);
          maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - balance) / peak : 0);
          bankrupt ||= balance <= 0;
          balanceHistory.push({ at: settlement.settledAt, balance, delta: round(delta, 2), matchId: match.id });
        }
      }
    }
    return {
      ...agent,
      startingBalance: STARTING_BALANCE,
      balance,
      status: balanceStatus(balance),
      brierScore: brierRows.length ? round(brierRows.reduce((sum, value) => sum + value, 0) / brierRows.length, 6) : null,
      settledPredictions: brierRows.length,
      won,
      lost,
      voided,
      settledStake: round(settledStake, 2),
      realizedProfit: round(realizedProfit, 2),
      roi: settledStake > 0 ? round(realizedProfit / settledStake, 6) : null,
      maxDrawdown: round(maxDrawdown, 6),
      balanceHistory,
      bankrupt,
    };
  });
  const wealthOrder = [...entries].sort((a, b) => b.balance - a.balance || a.id.localeCompare(b.id));
  if (!entries.some((entry) => entry.settledPredictions > 0)) {
    return entries.map((entry) => ({
      ...entry,
      wealthRank: null,
      predictionRank: null,
      riskRank: null,
      riskReward: null,
      stageScore: null,
    }));
  }
  const predictionOrder = [...entries].sort((a, b) => (
    (a.brierScore ?? Number.POSITIVE_INFINITY) - (b.brierScore ?? Number.POSITIVE_INFINITY)
    || a.id.localeCompare(b.id)
  ));
  const riskOrder = [...entries].sort((a, b) => a.maxDrawdown - b.maxDrawdown || a.id.localeCompare(b.id));
  const rankOf = (rows, id) => rows.findIndex((row) => row.id === id) + 1;
  return entries.map((entry) => {
    const wealthRank = rankOf(wealthOrder, entry.id);
    const predictionRank = entry.brierScore === null ? null : rankOf(predictionOrder, entry.id);
    const riskRank = rankOf(riskOrder, entry.id);
    const riskReward = entry.bankrupt ? -2
      : entry.maxDrawdown <= 0.15 ? 5
      : entry.maxDrawdown <= 0.30 ? 3
      : entry.maxDrawdown <= 0.50 ? 1
      : 0;
    const stageScore = WEALTH_POINTS[wealthRank - 1]
      + (predictionRank ? PREDICTION_POINTS[predictionRank - 1] : 0)
      + riskReward;
    return { ...entry, wealthRank, predictionRank, riskRank, riskReward, stageScore };
  }).sort((a, b) => b.stageScore - a.stageScore || b.balance - a.balance || a.id.localeCompare(b.id));
};

const lockWeek = (month, week, nowIso) => {
  const standings = monthMetrics(month);
  const balanceByAgent = new Map(standings.map((entry) => [entry.id, entry.balance]));
  const matchesById = new Map(week.pool.map((match) => [match.id, match]));
  week.agentForecasts = Object.fromEntries(AGENTS.map((agent) => {
    const raw = week.pool.map((match) => buildForecast(agent, match));
    const forecasts = assignInvestments(raw, matchesById, agent, balanceByAgent.get(agent.id) ?? STARTING_BALANCE);
    const submission = {
      agentId: agent.id,
      model: agent.model,
      submittedAt: nowIso,
      inputSnapshotHash: week.poolHash,
      forecasts,
    };
    submission.submissionHash = sha256(submission);
    return [agent.id, submission];
  }));
  week.status = "LOCKED";
  week.lockedAt = nowIso;
  week.submissionRootHash = sha256(Object.values(week.agentForecasts).map((row) => row.submissionHash));
};

const updateSettlements = (state, matches, nowIso) => {
  const byId = new Map();
  for (const match of matches) {
    const identity = matchIdentity(match);
    if (identity) byId.set(identity, match);
    if (match?.id) byId.set(String(match.id), match);
    if (match?.sourceMatchId) byId.set(String(match.sourceMatchId), match);
  }
  for (const month of Object.values(state.months)) {
    for (const week of Object.values(month.weeks || {})) {
      if (week?.status !== "LOCKED") continue;
      if (!isObject(week.settlements)) week.settlements = {};
      for (const snapshot of week.pool || []) {
        const source = byId.get(snapshot.id) || byId.get(snapshot.matchId) || byId.get(snapshot.sourceMatchId);
        const result = resultForMatch(source) || postponedRefundForMatch(snapshot, source);
        if (!result) continue;
        const existing = week.settlements[snapshot.id] || null;
        if (existing) {
          const existingRevision = Number(existing.resultRevision || 0);
          const nextRevision = Number(result.resultRevision || 0);
          const existingObserved = Date.parse(existing.resultObservedAt || existing.settledAt || "");
          const nextObserved = Date.parse(result.resultObservedAt || "");
          const newer = nextRevision > existingRevision
            || (nextRevision === existingRevision && Number.isFinite(nextObserved)
              && (!Number.isFinite(existingObserved) || nextObserved > existingObserved));
          if (!newer) continue;
        }
        week.settlements[snapshot.id] = {
          ...result,
          settledAt: nowIso,
          resultEventVersion: source?.eventVersion || null,
          resultSource: source?.source || "sporttery",
        };
      }
    }
  }
};

const flopRows = (month) => {
  const rows = [];
  for (const week of Object.values(month.weeks || {})) {
    if (week?.status !== "LOCKED") continue;
    for (const agent of AGENTS) {
      for (const forecast of week.agentForecasts?.[agent.id]?.forecasts || []) {
        const settlement = week.settlements?.[forecast.matchId];
        if (!settlement || settlement.status !== "SETTLED" || forecast.pick === settlement.outcome) continue;
        const match = week.pool.find((row) => row.id === forecast.matchId);
        rows.push({
          agentId: agent.id,
          agentName: agent.name,
          matchId: forecast.matchId,
          match: match ? `${match.homeTeamName} vs ${match.awayTeamName}` : forecast.matchId,
          pick: forecast.pick,
          confidence: forecast.confidence,
          actual: settlement.outcome,
          loss: forecast.investment ? forecast.stake : 0,
          settledAt: settlement.settledAt,
        });
      }
    }
  }
  return rows.sort((a, b) => b.loss - a.loss || b.confidence - a.confidence || String(b.settledAt).localeCompare(String(a.settledAt))).slice(0, 6);
};

const monthlyAwards = (month, standings) => {
  const settled = standings.some((row) => row.settledPredictions > 0);
  if (!settled) return null;
  const byBalance = [...standings].sort((a, b) => b.balance - a.balance || a.id.localeCompare(b.id));
  const byBrier = [...standings].filter((row) => row.brierScore !== null)
    .sort((a, b) => a.brierScore - b.brierScore || a.id.localeCompare(b.id));
  const byRisk = [...standings].sort((a, b) => a.maxDrawdown - b.maxDrawdown || a.id.localeCompare(b.id));
  const byStage = [...standings].filter((row) => row.stageScore !== null)
    .sort((a, b) => b.stageScore - a.stageScore || b.balance - a.balance || a.id.localeCompare(b.id));
  const investmentRows = [];
  for (const week of Object.values(month.weeks || {})) {
    if (week?.status !== "LOCKED") continue;
    const matchById = new Map((week.pool || []).map((match) => [match.id, match]));
    for (const agent of AGENTS) {
      for (const forecast of week.agentForecasts?.[agent.id]?.forecasts || []) {
        if (!forecast.investment) continue;
        const match = matchById.get(forecast.matchId);
        const settlement = week.settlements?.[forecast.matchId];
        investmentRows.push({
          agentId: agent.id,
          agentName: agent.name,
          stake: forecast.stake,
          odds: match?.odds?.[forecast.pick] || 0,
          hit: settlement?.status === "SETTLED" && settlement.outcome === forecast.pick,
        });
      }
    }
  }
  const upset = investmentRows.filter((row) => row.hit)
    .sort((a, b) => b.odds - a.odds || b.stake - a.stake || a.agentId.localeCompare(b.agentId))[0] || null;
  const averageStake = AGENTS.map((agent) => {
    const rows = investmentRows.filter((row) => row.agentId === agent.id);
    return {
      agentId: agent.id,
      agentName: agent.name,
      value: rows.length ? rows.reduce((sum, row) => sum + row.stake, 0) / rows.length : 0,
    };
  }).sort((a, b) => b.value - a.value || a.agentId.localeCompare(b.agentId))[0];
  return {
    monthChampion: byStage[0] ? { agentId: byStage[0].id, agentName: byStage[0].name, value: byStage[0].stageScore } : null,
    wealthKing: byBalance[0] ? { agentId: byBalance[0].id, agentName: byBalance[0].name, value: byBalance[0].balance } : null,
    accuracyKing: byBrier[0] ? { agentId: byBrier[0].id, agentName: byBrier[0].name, value: byBrier[0].brierScore } : null,
    riskKing: byRisk[0] ? { agentId: byRisk[0].id, agentName: byRisk[0].name, value: byRisk[0].maxDrawdown } : null,
    upsetKing: upset ? { agentId: upset.agentId, agentName: upset.agentName, value: upset.odds } : null,
    reckless: averageStake ? { agentId: averageStake.agentId, agentName: averageStake.agentName, value: round(averageStake.value, 2) } : null,
    bankrupt: standings.filter((row) => row.status === "BANKRUPT").map((row) => ({ agentId: row.id, agentName: row.name })),
  };
};

const seasonStandings = (state) => AGENTS.map((agent) => {
  let seasonPoints = 0;
  let stages = 0;
  let brierTotal = 0;
  let brierStages = 0;
  let bestStage = 0;
  for (const month of Object.values(state.months || {})) {
    const row = monthMetrics(month).find((entry) => entry.id === agent.id);
    if (!row || row.stageScore === null) continue;
    seasonPoints += row.stageScore;
    bestStage = Math.max(bestStage, row.stageScore);
    stages += 1;
    if (row.brierScore !== null) {
      brierTotal += row.brierScore;
      brierStages += 1;
    }
  }
  return {
    agentId: agent.id,
    agentName: agent.name,
    color: agent.color,
    seasonPoints,
    stages,
    averageBrier: brierStages ? round(brierTotal / brierStages, 6) : null,
    bestStage,
  };
}).sort((a, b) => (
  b.seasonPoints - a.seasonPoints
  || (a.averageBrier ?? Number.POSITIVE_INFINITY) - (b.averageBrier ?? Number.POSITIVE_INFINITY)
  || b.bestStage - a.bestStage
  || a.agentId.localeCompare(b.agentId)
)).map((row, index) => ({ ...row, rank: index + 1 }));

const evidenceAgentStandings = (month) => {
  const aggregate = new Map();
  for (const week of Object.values(month?.weeks || {})) {
    if (week?.status !== "LOCKED") continue;
    const primarySubmission = week.agentForecasts?.[AGENTS[0].id];
    for (const forecast of primarySubmission?.forecasts || []) {
      const settlement = week.settlements?.[forecast.matchId];
      if (!settlement || settlement.status !== "SETTLED") continue;
      for (const evidence of forecast.decisionAudit?.evidenceAgents || []) {
        if (!evidence.available || !evidence.distribution || !OUTCOMES.includes(evidence.pick)) continue;
        const brier = OUTCOMES.reduce((sum, code) => (
          sum + (Number(evidence.distribution[code]) - (code === settlement.outcome ? 1 : 0)) ** 2
        ), 0);
        const row = aggregate.get(evidence.id) || {
          id: evidence.id,
          nameZh: evidence.nameZh,
          nameEn: evidence.nameEn,
          settled: 0,
          hits: 0,
          brierTotal: 0,
        };
        row.settled += 1;
        row.hits += evidence.pick === settlement.outcome ? 1 : 0;
        row.brierTotal += brier;
        aggregate.set(evidence.id, row);
      }
    }
  }
  return [...aggregate.values()].map((row) => ({
    id: row.id,
    nameZh: row.nameZh,
    nameEn: row.nameEn,
    settled: row.settled,
    hits: row.hits,
    hitRate: row.settled ? round(row.hits / row.settled, 4) : null,
    brierScore: row.settled ? round(row.brierTotal / row.settled, 6) : null,
  })).sort((left, right) => (
    (left.brierScore ?? Number.POSITIVE_INFINITY) - (right.brierScore ?? Number.POSITIVE_INFINITY)
    || left.id.localeCompare(right.id)
  ));
};

const publicWeek = (week, standings) => {
  const byAgent = new Map(standings.map((row) => [row.id, row]));
  const agents = AGENTS.map((agent) => {
    const submission = week.agentForecasts?.[agent.id] || null;
    const stage = byAgent.get(agent.id);
    const forecasts = submission?.forecasts || [];
    return {
      ...agent,
      startingBalance: STARTING_BALANCE,
      balance: stage?.balance ?? STARTING_BALANCE,
      status: stage?.status || "ACTIVE",
      forecasts,
      investedMatches: forecasts.filter((forecast) => forecast.investment).length,
      totalStake: forecasts.reduce((sum, forecast) => sum + forecast.stake, 0),
      reservedBalance: Math.max(0, (stage?.balance ?? STARTING_BALANCE) - forecasts.reduce((sum, forecast) => sum + forecast.stake, 0)),
      brierScore: stage?.brierScore ?? null,
      settledPredictions: stage?.settledPredictions || 0,
      won: stage?.won || 0,
      lost: stage?.lost || 0,
      voided: stage?.voided || 0,
      settledStake: stage?.settledStake || 0,
      realizedProfit: stage?.realizedProfit || 0,
      roi: stage?.roi ?? null,
      maxDrawdown: stage?.maxDrawdown || 0,
      wealthRank: stage?.wealthRank ?? null,
      predictionRank: stage?.predictionRank ?? null,
      riskRank: stage?.riskRank ?? null,
      riskReward: stage?.riskReward ?? null,
      stageScore: stage?.stageScore ?? null,
      submissionHash: submission?.submissionHash || null,
    };
  });
  const matches = (week.pool || []).map((match) => ({
    match: {
      id: match.id,
      sourceMatchId: match.sourceMatchId || match.id,
      leagueId: match.leagueCode,
      kickoffTime: match.kickoffTime,
      buyEndTime: match.buyEndTime,
      businessDate: match.dateKey,
      status: week.settlements?.[match.id]?.status === "SETTLED" ? "FINISHED" : "SCHEDULED",
      homeTeamName: match.homeTeamName,
      awayTeamName: match.awayTeamName,
    },
    league: LEAGUES.find((league) => league.code === match.leagueCode),
    dateKey: match.dateKey,
    odds: match.odds,
    baseProbabilities: match.baseProbabilities,
    marketProbabilities: match.marketProbabilities,
    oddsUpdatedAt: match.oddsUpdatedAt,
    dataSnapshotHash: match.dataSnapshotHash,
    evidenceSnapshotHash: match.evidenceSnapshot?.hash || null,
    settlement: week.settlements?.[match.id] || null,
    forecasts: agents.flatMap((agent) => {
      const forecast = agent.forecasts.find((row) => row.matchId === match.id);
      return forecast ? [{ ...forecast, agentId: agent.id, agentName: agent.name, color: agent.color }] : [];
    }),
  }));
  return { agents, matches };
};

const updateAiArenaState = ({ matches, state: inputState, now = new Date().toISOString() }) => {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("ai arena update requires a valid now clock");
  const state = normalizeState(inputState);
  const { weekStart, weekEnd } = arenaWeekRange(nowMs);
  const monthKey = monthKeyForWeek(weekStart, weekEnd);
  const month = ensureMonth(state, monthKey);
  month.createdAt ||= now;
  let week = month.weeks[weekStart];
  if (!isObject(week)) {
    week = {
      weekStart,
      weekEnd,
      monthKey,
      status: "FORMING",
      createdAt: now,
      updatedAt: now,
      lockedAt: null,
      pool: [],
      leagueSlots: LEAGUES.map((league) => ({ ...league, count: 0 })),
      poolHash: null,
      partialLockAt: null,
      submissionRootHash: null,
      agentForecasts: {},
      settlements: {},
    };
    month.weeks[weekStart] = week;
  }
  if (week.status !== "LOCKED") {
    const selection = selectPool(matches, weekStart, weekEnd, nowMs);
    week.pool = selection.candidates;
    week.leagueSlots = selection.slots;
    week.poolHash = selection.lockable ? sha256(selection.candidates) : null;
    week.partialLockAt = selection.partialLockAt;
    week.status = selection.lockable ? "READY" : "FORMING";
    week.updatedAt = now;
    if (selection.lockable) lockWeek(month, week, now);
  }
  updateSettlements(state, matches, now);
  state.updatedAt = now;
  const monthKeys = Object.keys(state.months).sort();
  for (const staleKey of monthKeys.slice(0, Math.max(0, monthKeys.length - 24))) delete state.months[staleKey];

  const standings = monthMetrics(month);
  const projected = publicWeek(week, standings);
  const availableMatches = week.pool?.length || 0;
  const locked = week.status === "LOCKED";
  const poolComplete = locked
    && availableMatches === 10
    && (week.leagueSlots || []).every((slot) => slot.count === slot.target);
  const autonomousStakingActive = !locked || AGENTS.every((agent) => {
    const submission = week.agentForecasts?.[agent.id];
    return /(?:autonomous-risk-v2|multi-signal-risk-v2|auditable-risk-v2|gemini-3\.7-reviewed-profile-v2|domestic-auditable-risk-v1)/.test(String(submission?.model || ""))
      && Array.isArray(submission?.forecasts)
      && submission.forecasts.every((forecast) => forecast?.stakeAudit?.policy === "fractional-kelly-evidence-risk-v2");
  });
  const dates = locked ? [...new Set((week.pool || []).map((row) => row.dateKey))].sort() : [];
  const payload = {
    ok: true,
    version: autonomousStakingActive ? PAYLOAD_VERSION : "ai-big-five-survival-v3",
    generatedAt: now,
    monthKey,
    weekStart,
    weekEnd,
    targetMatches: 10,
    availableMatches,
    complete: poolComplete,
    roundActive: locked,
    poolPolicy: "complete-or-friday-partial-lock-v1",
    shortfallPolicy: "lock-current-qualified-pool-no-backfill",
    partialLockAt: week.partialLockAt || null,
    state: week.status,
    lockedAt: week.lockedAt,
    poolHash: week.poolHash,
    submissionRootHash: week.submissionRootHash,
    leagueSlots: week.leagueSlots,
    matches: locked ? projected.matches : [],
    agents: projected.agents,
    standings,
    seasonStandings: seasonStandings(state),
    evidenceStandings: evidenceAgentStandings(month),
    awards: monthlyAwards(month, standings),
    dates,
    flopBoard: flopRows(month),
    rules: autonomousStakingActive ? {
      startingBalance: STARTING_BALANCE,
      predictionsPerAgent: locked ? availableMatches : 0,
      stakingMode: "autonomous-fractional-kelly-v2",
      investmentsPerAgent: null,
      zeroStakeAllowed: true,
      minimumExecutableStake: 50,
      weeklyRiskFractionRange: [0.10, 0.22],
      singleRiskFractionRange: [0.03, 0.07],
      longOddsThreshold: 3.5,
      longOddsRiskFractionMax: 0.02,
      extremeOddsThreshold: 8,
      extremeOddsRiskFractionMax: 0.005,
      yellowBalance: 3000,
      yellowWeeklyRiskFractionMax: 0.10,
      yellowSingleRiskFractionMax: 0.04,
      redBalance: 1500,
      redWeeklyRiskFractionMax: 0,
      redSingleRiskFractionMax: 0,
      bankruptBalance: 0,
    } : {
      startingBalance: STARTING_BALANCE,
      predictionsPerAgent: locked ? availableMatches : 0,
      investmentsPerAgent: locked ? 3 : 0,
      weeklyStakeMin: 1500,
      weeklyStakeMax: 2500,
      singleStakeMin: 300,
      singleStakeMax: 1200,
      longOddsThreshold: 3.5,
      longOddsStakeMax: 500,
      yellowBalance: 3000,
      yellowSingleStakeMax: 800,
      redBalance: 1500,
      redWeeklyStakeMax: 1000,
      bankruptBalance: 0,
    },
    integrity: {
      immutable: locked,
      inputSnapshotHash: week.poolHash,
      submissionRootHash: week.submissionRootHash,
      stateHash: sha256(state),
    },
    decisionEngine: "professional-agent-fusion-v1",
    stakingEngine: autonomousStakingActive ? "fractional-kelly-evidence-risk-v2" : null,
    dataAccess: {
      mode: "shared-immutable-pre-match-snapshot",
      identicalInputs: true,
      sources: ["sporttery:official-had", "probability-model", "structured-evidence"],
      externalProviderCallsActive: false,
    },
    resultWriter: {
      mode: "trusted-official-auto-settlement",
      officialOnly: true,
      forecastsImmutable: true,
      modelScoreWriteAllowed: false,
    },
    stakeFreedom: "any-qualified-match-or-zero-with-risk-caps",
    disclosure: "strategy-simulation-not-external-model-calls",
    formalStatisticsExcluded: true,
  };
  return { state, payload };
};

module.exports = {
  AGENTS,
  LEAGUES,
  MIN_LOCKABLE_MATCHES,
  PARTIAL_LOCK_WEEKDAY_OFFSET,
  OUTCOMES,
  PAYLOAD_VERSION,
  STARTING_BALANCE,
  STATE_VERSION,
  arenaWeekRange,
  assignInvestments,
  balanceStatus,
  buildForecast,
  identifyLeague,
  updateAiArenaState,
};
