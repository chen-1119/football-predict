"use strict";

const crypto = require("node:crypto");
const { isTrustedOfficialFinal } = require("../src/services/matchLifecycle.cjs");

const STATE_VERSION = "ai-big-five-survival-state-v1";
const PAYLOAD_VERSION = "ai-big-five-survival-v2";
const STARTING_BALANCE = 10_000;
const OUTCOMES = Object.freeze(["1", "X", "2"]);
const LEAGUES = Object.freeze([
  Object.freeze({ code: "premier-league", nameZh: "英超", nameEn: "Premier League", target: 2 }),
  Object.freeze({ code: "laliga", nameZh: "西甲", nameEn: "La Liga", target: 2 }),
  Object.freeze({ code: "serie-a", nameZh: "意甲", nameEn: "Serie A", target: 2 }),
  Object.freeze({ code: "bundesliga", nameZh: "德甲", nameEn: "Bundesliga", target: 2 }),
  Object.freeze({ code: "ligue-1", nameZh: "法甲", nameEn: "Ligue 1", target: 2 }),
]);
const AGENTS = Object.freeze([
  Object.freeze({ id: "gpt", name: "GPT", model: "strategy-profile-v1", style: "balanced", styleZh: "全局均衡", styleEn: "Global balance", color: "#6ee7b7", weeklyBudget: 2000 }),
  Object.freeze({ id: "claude", name: "Claude", model: "strategy-profile-v1", style: "steady", styleZh: "风险审慎", styleEn: "Risk first", color: "#f0b37e", weeklyBudget: 1600 }),
  Object.freeze({ id: "gemini", name: "Gemini", model: "strategy-profile-v1", style: "balanced", styleZh: "多信号融合", styleEn: "Multi-signal", color: "#8ab4f8", weeklyBudget: 1900 }),
  Object.freeze({ id: "deepseek", name: "DeepSeek", model: "strategy-profile-v1", style: "aggressive", styleZh: "价值搜索", styleEn: "Value search", color: "#8b9cff", weeklyBudget: 2200 }),
  Object.freeze({ id: "grok", name: "Grok", model: "strategy-profile-v1", style: "aggressive", styleZh: "逆向进攻", styleEn: "Contrarian attack", color: "#f4d06f", weeklyBudget: 2500 }),
  Object.freeze({ id: "qwen", name: "Qwen", model: "strategy-profile-v1", style: "steady", styleZh: "稳定执行", styleEn: "Stable execution", color: "#d5a6ff", weeklyBudget: 1800 }),
]);
const PARAMETERS = Object.freeze({
  gpt: { modelWeight: 0.82, marketWeight: 0.18, valueWeight: 0.08, drawBias: 0, favoriteBias: 0, underdogBias: 0 },
  claude: { modelWeight: 0.60, marketWeight: 0.40, valueWeight: 0.02, drawBias: 0.018, favoriteBias: 0.012, underdogBias: 0 },
  gemini: { modelWeight: 0.70, marketWeight: 0.30, valueWeight: 0.12, drawBias: 0.004, favoriteBias: 0, underdogBias: 0 },
  deepseek: { modelWeight: 0.76, marketWeight: 0.24, valueWeight: 0.20, drawBias: 0, favoriteBias: 0, underdogBias: 0.008 },
  grok: { modelWeight: 0.86, marketWeight: 0.14, valueWeight: 0.25, drawBias: -0.008, favoriteBias: 0, underdogBias: 0.018 },
  qwen: { modelWeight: 0.68, marketWeight: 0.32, valueWeight: 0.05, drawBias: 0.008, favoriteBias: 0.014, underdogBias: 0 },
});
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
const stableFraction = (value) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
};
const leader = (scores) => [...OUTCOMES]
  .sort((left, right) => scores[right] - scores[left] || OUTCOMES.indexOf(left) - OUTCOMES.indexOf(right))[0];

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
const identifyLeague = (match) => {
  const text = [match?.leagueId, match?.leagueName, match?.leagueNameEn, match?.leagueShortName, match?.leagueShortNameEn]
    .filter(Boolean).join(" ").toLowerCase();
  if (/(^|\s)epl($|\s)|英超|premier\s*league/.test(text)) return "premier-league";
  if (/西甲|la\s*liga|laliga/.test(text)) return "laliga";
  if (/意甲|serie\s*a|seriea/.test(text)) return "serie-a";
  if (/德甲|bundesliga/.test(text)) return "bundesliga";
  if (/法甲|ligue\s*1|ligue1/.test(text)) return "ligue-1";
  return null;
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
    marketProbabilities: devig(odds),
    oddsSource: "sporttery:HAD",
    oddsUpdatedAt: match.oddsUpdatedAt || null,
    dataSnapshotHash: sha256({ id, kickoffTime: match.kickoffTime, odds, probabilities }),
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
  return { candidates: selected, slots, complete: slots.every((slot) => slot.count === slot.target) };
};

const agentDistribution = (agent, match) => {
  const parameters = PARAMETERS[agent.id] || PARAMETERS.gpt;
  const model = match.baseProbabilities;
  const market = match.marketProbabilities;
  const odds = match.odds;
  const favorite = leader(market);
  const underdog = [...OUTCOMES].sort((left, right) => odds[right] - odds[left])[0];
  const raw = Object.fromEntries(OUTCOMES.map((code, index) => {
    const valueSignal = clamp(model[code] * odds[code] - 1, -0.35, 0.45);
    const jitter = (stableFraction(`${agent.id}|${match.id}|${code}`) - 0.5) * 0.014;
    const bias = (code === "X" ? parameters.drawBias : 0)
      + (code === favorite ? parameters.favoriteBias : 0)
      + (code === underdog ? parameters.underdogBias : 0)
      + (index === 0 ? 0.0001 : 0);
    return [code,
      model[code] * parameters.modelWeight
      + market[code] * parameters.marketWeight
      + valueSignal * parameters.valueWeight * 0.11
      + bias
      + jitter];
  }));
  return normalizeTriplet(raw);
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
const pickLabel = (pick) => pick === "1" ? "主胜" : pick === "2" ? "客胜" : "平局";
const reasonsFor = (agent, match, pick, probabilities) => {
  const edge = probabilities[pick] - match.marketProbabilities[pick];
  return [
    `${pickLabel(pick)}在该策略分布中概率最高，为 ${Math.round(probabilities[pick] * 100)}%`,
    edge >= 0.01
      ? `相对同场去水市场高 ${Math.round(edge * 100)} 个百分点`
      : "与同场去水市场接近，优先控制分歧风险",
    `${agent.styleZh}规则评估官方 SP ${match.odds[pick].toFixed(2)} 后的风险收益`,
  ];
};
const buildForecast = (agent, match) => {
  const probabilities = agentDistribution(agent, match);
  const pick = leader(probabilities);
  return {
    matchId: match.id,
    pick,
    probabilities,
    confidence: confidenceFor(probabilities),
    projectedScore: scorelineFor(match, pick),
    reasonsZh: reasonsFor(agent, match, pick, probabilities),
    reasonsEn: [
      `${pick === "1" ? "Home win" : pick === "2" ? "Away win" : "Draw"} leads this strategy distribution at ${Math.round(probabilities[pick] * 100)}%`,
      "Compared against the same devigged official market snapshot",
      `${agent.styleEn} rules assess risk and reward at official SP ${match.odds[pick].toFixed(2)}`,
    ],
    expectedValue: probabilities[pick] * match.odds[pick] - 1,
    investment: false,
    stake: 0,
  };
};
const balanceStatus = (balance) => {
  if (balance <= 0) return "BANKRUPT";
  if (balance < 1500) return "RED";
  if (balance < 3000) return "YELLOW";
  return "ACTIVE";
};
const assignInvestments = (forecasts, matchesById, agent, balance) => {
  const status = balanceStatus(balance);
  if (status === "BANKRUPT" || forecasts.length < 3) return forecasts;
  const weeklyMax = status === "RED" ? Math.min(1000, balance) : Math.min(agent.weeklyBudget, 2500, balance);
  const singleMax = status === "YELLOW" ? 800 : 1200;
  const eligible = forecasts.filter((forecast) => {
    const odds = matchesById.get(forecast.matchId)?.odds?.[forecast.pick] || 0;
    return !(status === "RED" && odds > 3.5);
  }).sort((left, right) => (
    (right.expectedValue + right.confidence * 0.025) - (left.expectedValue + left.confidence * 0.025)
    || left.matchId.localeCompare(right.matchId)
  ));
  if (eligible.length < 3 || weeklyMax < 900) return forecasts;
  const selected = eligible.slice(0, 3);
  const ratios = [0.45, 0.33, 0.22];
  const stakes = selected.map((forecast, index) => {
    const odds = matchesById.get(forecast.matchId).odds[forecast.pick];
    const cap = Math.min(singleMax, odds > 3.5 ? 500 : singleMax);
    return Math.min(cap, Math.max(300, Math.round((weeklyMax * ratios[index]) / 100) * 100));
  });
  let remaining = Math.max(0, weeklyMax - stakes.reduce((sum, value) => sum + value, 0));
  for (let index = 0; index < stakes.length && remaining >= 100; index += 1) {
    const forecast = selected[index];
    const odds = matchesById.get(forecast.matchId).odds[forecast.pick];
    const cap = Math.min(singleMax, odds > 3.5 ? 500 : singleMax);
    const addition = Math.min(Math.max(0, cap - stakes[index]), Math.floor(remaining / 100) * 100);
    stakes[index] += addition;
    remaining -= addition;
  }
  const stakeByMatch = new Map(selected.map((forecast, index) => [forecast.matchId, stakes[index]]));
  return forecasts.map((forecast) => ({
    ...forecast,
    investment: stakeByMatch.has(forecast.matchId),
    stake: stakeByMatch.get(forecast.matchId) || 0,
  }));
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
      brierScore: stage?.brierScore ?? null,
      settledPredictions: stage?.settledPredictions || 0,
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
    week.poolHash = selection.complete ? sha256(selection.candidates) : null;
    week.status = selection.complete ? "READY" : "FORMING";
    week.updatedAt = now;
    if (selection.complete) lockWeek(month, week, now);
  }
  updateSettlements(state, matches, now);
  state.updatedAt = now;
  const monthKeys = Object.keys(state.months).sort();
  for (const staleKey of monthKeys.slice(0, Math.max(0, monthKeys.length - 24))) delete state.months[staleKey];

  const standings = monthMetrics(month);
  const projected = publicWeek(week, standings);
  const availableMatches = week.pool?.length || 0;
  const complete = week.status === "LOCKED";
  const dates = complete ? [...new Set((week.pool || []).map((row) => row.dateKey))].sort() : [];
  const payload = {
    ok: true,
    version: PAYLOAD_VERSION,
    generatedAt: now,
    monthKey,
    weekStart,
    weekEnd,
    targetMatches: 10,
    availableMatches,
    complete,
    state: week.status,
    lockedAt: week.lockedAt,
    poolHash: week.poolHash,
    submissionRootHash: week.submissionRootHash,
    leagueSlots: week.leagueSlots,
    matches: complete ? projected.matches : [],
    agents: projected.agents,
    standings,
    seasonStandings: seasonStandings(state),
    awards: monthlyAwards(month, standings),
    dates,
    flopBoard: flopRows(month),
    rules: {
      startingBalance: STARTING_BALANCE,
      predictionsPerAgent: complete ? 10 : 0,
      investmentsPerAgent: complete ? 3 : 0,
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
      immutable: complete,
      inputSnapshotHash: week.poolHash,
      submissionRootHash: week.submissionRootHash,
      stateHash: sha256(state),
    },
    disclosure: "strategy-simulation-not-external-model-calls",
    formalStatisticsExcluded: true,
  };
  return { state, payload };
};

module.exports = {
  AGENTS,
  LEAGUES,
  OUTCOMES,
  PAYLOAD_VERSION,
  STARTING_BALANCE,
  STATE_VERSION,
  arenaWeekRange,
  balanceStatus,
  identifyLeague,
  updateAiArenaState,
};
