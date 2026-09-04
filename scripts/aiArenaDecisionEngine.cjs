"use strict";

const crypto = require("node:crypto");

const VERSION = "professional-agent-fusion-v1";
const SNAPSHOT_VERSION = "professional-evidence-snapshot-v1";
const OUTCOMES = Object.freeze(["1", "X", "2"]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));
const finite = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const probability = (value) => {
  const parsed = finite(value);
  if (parsed === null || parsed < 0) return null;
  return parsed > 1.000001 ? parsed / 100 : parsed;
};
const normalize = (value) => {
  const home = probability(value?.["1"] ?? value?.home);
  const draw = probability(value?.X ?? value?.draw);
  const away = probability(value?.["2"] ?? value?.away);
  if (home === null || draw === null || away === null) return null;
  const total = home + draw + away;
  if (!(total > 0)) return null;
  return { "1": home / total, X: draw / total, "2": away / total };
};
const average = (rows, weights = []) => {
  const usable = rows.map((row, index) => ({ row: normalize(row), weight: finite(weights[index], 1) }))
    .filter(({ row, weight }) => row && weight > 0);
  if (!usable.length) return null;
  const totalWeight = usable.reduce((sum, item) => sum + item.weight, 0);
  return normalize(Object.fromEntries(OUTCOMES.map((code) => [
    code,
    usable.reduce((sum, item) => sum + item.row[code] * item.weight, 0) / totalWeight,
  ])));
};
const leader = (scores) => [...OUTCOMES]
  .sort((left, right) => scores[right] - scores[left] || OUTCOMES.indexOf(left) - OUTCOMES.indexOf(right))[0];
const labelZh = (code) => code === "1" ? "主胜" : code === "2" ? "客胜" : "平局";
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const formDistribution = (form, fallback) => {
  const homePpm = finite(form?.home?.pointsPerMatch);
  const awayPpm = finite(form?.away?.pointsPerMatch);
  if (homePpm === null || awayPpm === null) return fallback;
  const gap = clamp((homePpm - awayPpm) / 3, -0.75, 0.75);
  const closeness = 1 - Math.min(1, Math.abs(gap));
  const draw = clamp(0.22 + closeness * 0.075, 0.19, 0.31);
  const remaining = 1 - draw;
  const homeShare = clamp(0.53 + gap * 0.32, 0.18, 0.82);
  return normalize({ "1": remaining * homeShare, X: draw, "2": remaining * (1 - homeShare) });
};

const buildArenaEvidenceSnapshot = (match, { baseProbabilities, marketProbabilities }) => {
  const model = match?.probabilityModel || {};
  const oneXTwo = model.oneXTwo || {};
  const context = model.contextSignals || match?.stats || {};
  const gaps = context.dataGaps || match?.stats?.dataGaps || {};
  const expectedGoals = match?.stats?.expectedGoals || model?.calculationTrace?.expectedGoals || {};
  const homeExpected = finite(expectedGoals.home ?? model?.lambdaBlend?.formHomeLambda);
  const awayExpected = finite(expectedGoals.away ?? model?.lambdaBlend?.formAwayLambda);
  const totalExpected = homeExpected !== null && awayExpected !== null ? homeExpected + awayExpected : null;
  const form = model.form || {};
  const leaguePrior = model.leaguePrior || {};
  const input = model.inputSufficiency || {};
  const web = context.webConsensus || {};
  const snapshot = {
    version: SNAPSHOT_VERSION,
    components: {
      final: normalize(oneXTwo.final) || normalize(baseProbabilities),
      poisson: normalize(oneXTwo.poisson),
      elo: normalize(oneXTwo.elo),
      teamStrength: normalize(oneXTwo.teamStrength),
      scoreImplied: normalize(oneXTwo.scoreImplied),
      market: normalize(marketProbabilities),
      form: formDistribution(form, null),
    },
    samples: {
      eloHome: Math.max(0, finite(model?.elo?.homeMatches, 0)),
      eloAway: Math.max(0, finite(model?.elo?.awayMatches, 0)),
      form: Math.max(0, finite(form.sampleSize, 0)),
      history: Math.max(0, finite(leaguePrior.matches, 0)),
    },
    form: {
      homePpm: finite(form?.home?.pointsPerMatch),
      awayPpm: finite(form?.away?.pointsPerMatch),
      homeRestDays: finite(form?.home?.restDays),
      awayRestDays: finite(form?.away?.restDays),
    },
    league: {
      drawRate: probability(leaguePrior.drawRate),
      totalGoals: finite(leaguePrior.totalGoalsAvg),
    },
    context: {
      dataQuality: clamp(finite(gaps.coverageScore, 0) / 100, 0, 1),
      trustPenalty: clamp(finite(gaps.trustPenalty, 0), 0, 100),
      severeMissingCount: Math.max(0, finite(gaps.severeMissingCount, 0)),
      missingKeys: Array.isArray(gaps.missing) ? gaps.missing.map((row) => String(row?.key || "")).filter(Boolean).slice(0, 12) : [],
      inputSufficient: input.sufficient === true,
      attackHome: finite(context?.attackIntent?.home),
      attackAway: finite(context?.attackIntent?.away),
      pressureHome: finite(context?.rankingPressure?.home),
      pressureAway: finite(context?.rankingPressure?.away),
      expectedGoalsHome: homeExpected,
      expectedGoalsAway: awayExpected,
      expectedGoalsTotal: totalExpected,
      webConsensusAvailable: web.available === true,
      webConsensusNumericEligible: web.eligibleForNumericModel === true,
    },
  };
  return { ...snapshot, hash: hash(snapshot) };
};

const shiftOutcome = (distribution, target, amount) => {
  const base = normalize(distribution);
  if (!base || !OUTCOMES.includes(target) || !Number.isFinite(amount) || amount === 0) return base;
  const capped = clamp(amount, -0.08, 0.08);
  const nextTarget = clamp(base[target] + capped, 0.08, 0.82);
  const delta = nextTarget - base[target];
  const otherCodes = OUTCOMES.filter((code) => code !== target);
  const otherTotal = otherCodes.reduce((sum, code) => sum + base[code], 0);
  return normalize({
    ...base,
    [target]: nextTarget,
    ...Object.fromEntries(otherCodes.map((code) => [code, base[code] - delta * (base[code] / otherTotal)])),
  });
};

const drawSignal = (snapshot, math, history, market) => {
  const poissonDraw = snapshot.components.poisson?.X ?? math.X;
  const historyDraw = history?.X ?? snapshot.league.drawRate ?? 0.26;
  const totalGoals = snapshot.context.expectedGoalsTotal ?? snapshot.league.totalGoals ?? 2.65;
  const sideGap = Math.abs(math["1"] - math["2"]);
  const score = 50
    + (poissonDraw - 0.255) * 115
    + (historyDraw - 0.26) * 70
    + (market.X - 0.26) * 75
    + (0.22 - Math.min(0.22, sideGap)) * 55
    + clamp(2.65 - totalGoals, -1, 1) * 11;
  return clamp(Math.round(score), 0, 100);
};

const buildEvidenceAgents = (match) => {
  const snapshot = match.evidenceSnapshot || {
    version: SNAPSHOT_VERSION,
    components: { final: match.baseProbabilities, market: match.marketProbabilities },
    samples: {}, form: {}, league: {}, context: {}, hash: null,
  };
  const market = normalize(snapshot.components.market) || normalize(match.marketProbabilities);
  const math = average([
    snapshot.components.final,
    snapshot.components.poisson,
    snapshot.components.elo,
    snapshot.components.teamStrength,
    snapshot.components.scoreImplied,
  ], [4, 2.5, 1.5, 1.5, 1]);
  const history = average([
    snapshot.components.elo,
    snapshot.components.teamStrength,
    snapshot.components.form,
  ], [2, 1.5, 1.2]) || math;
  const contextQuality = clamp(finite(snapshot.context.dataQuality, 0), 0, 1);
  let fundamentals = math;
  const attackHome = finite(snapshot.context.attackHome);
  const attackAway = finite(snapshot.context.attackAway);
  const pressureHome = finite(snapshot.context.pressureHome);
  const pressureAway = finite(snapshot.context.pressureAway);
  const restHome = finite(snapshot.form.homeRestDays);
  const restAway = finite(snapshot.form.awayRestDays);
  const contextualEdge = clamp(
    ((attackHome ?? 50) - (attackAway ?? 50)) / 100
      + ((pressureHome ?? 50) - (pressureAway ?? 50)) / 180
      + ((restHome ?? 4) - (restAway ?? 4)) / 70,
    -0.12,
    0.12,
  );
  fundamentals = shiftOutcome(fundamentals, contextualEdge >= 0 ? "1" : "2", Math.abs(contextualEdge) * contextQuality);
  const drawScore = drawSignal(snapshot, math, history, market);
  const draw = shiftOutcome(math, "X", (drawScore - 50) * 0.00125);
  const preliminary = average([math, market, history, fundamentals, draw], [35, 25, 15, 10, 10]);
  const preliminaryPick = leader(preliminary);
  const ordered = OUTCOMES.map((code) => ({ code, value: preliminary[code] })).sort((a, b) => b.value - a.value);
  const disagreement = leader(math) !== leader(market) ? 18 : 0;
  const thinGap = clamp((0.12 - (ordered[0].value - ordered[1].value)) / 0.12, 0, 1) * 35;
  const dataRisk = (1 - contextQuality) * 25 + clamp(finite(snapshot.context.severeMissingCount, 0), 0, 4) * 5;
  const adversarialRisk = clamp(Math.round(12 + disagreement + thinGap + dataRisk), 0, 100);
  const counterPick = ordered.find((row) => row.code !== preliminaryPick)?.code || "X";
  const adversarial = shiftOutcome(preliminary, counterPick, adversarialRisk * 0.00045);
  const agents = [
    {
      id: "math", nameZh: "A1 数学模型", nameEn: "A1 mathematical model", available: true,
      distribution: math, pick: leader(math), confidence: Math.round(Math.max(...OUTCOMES.map((code) => math[code])) * 100),
      reasonZh: "融合 Poisson、Elo、球队强度与比分矩阵，概率不由大模型编写。",
    },
    {
      id: "market", nameZh: "A2 赔率市场", nameEn: "A2 odds market", available: true,
      distribution: market, pick: leader(market), confidence: Math.round(Math.max(...OUTCOMES.map((code) => market[code])) * 100),
      reasonZh: "只读取同场官方 HAD SP 的去水隐含概率，不把低赔率直接当赛果。",
    },
    {
      id: "history", nameZh: "A3 历史强度", nameEn: "A3 historical strength", available: Boolean(history),
      distribution: history, pick: leader(history), confidence: Math.round(Math.max(...OUTCOMES.map((code) => history[code])) * 100),
      reasonZh: `Elo/Form/历史先验样本：${Math.round(finite(snapshot.samples.eloHome, 0) + finite(snapshot.samples.eloAway, 0))}/${Math.round(finite(snapshot.samples.form, 0))}/${Math.round(finite(snapshot.samples.history, 0))}。`,
    },
    {
      id: "fundamentals", nameZh: "A4 基本面", nameEn: "A4 fundamentals", available: contextQuality > 0,
      distribution: fundamentals, pick: leader(fundamentals), confidence: Math.round(contextQuality * 100),
      reasonZh: contextQuality >= 0.65 ? "结构化赛程、状态与压力信号较完整。" : "基本面字段不完整，只做受限修正并降低权重。",
    },
    {
      id: "intelligence", nameZh: "A5 黑天鹅情报", nameEn: "A5 black-swan intelligence",
      available: snapshot.context.webConsensusAvailable === true && snapshot.context.webConsensusNumericEligible === true,
      distribution: math, pick: leader(math), confidence: 0,
      reasonZh: "未取得可数值化且通过时效/来源校验的情报时保持中立，禁止编故事改概率。",
    },
    {
      id: "draw", nameZh: "A6 平局结构", nameEn: "A6 draw structure", available: true,
      distribution: draw, pick: leader(draw), confidence: drawScore, signalScore: drawScore,
      reasonZh: `平局信号 ${drawScore}/100；这是相对结构评分，不等于平局概率。`,
    },
    {
      id: "adversarial", nameZh: "A7 反方审查", nameEn: "A7 adversarial review", available: true,
      distribution: adversarial, pick: counterPick, confidence: adversarialRisk, riskScore: adversarialRisk,
      reasonZh: `对“${labelZh(preliminaryPick)}”结论的反方攻击强度 ${adversarialRisk}/100，重点检查薄弱领先、市场冲突和数据缺口。`,
    },
  ];
  return { snapshot, agents, drawScore, adversarialRisk, preliminaryPick };
};

const PROFILE_WEIGHTS = Object.freeze({
  gpt: { math: 0.34, market: 0.23, history: 0.17, fundamentals: 0.12, intelligence: 0.04, draw: 0.10, adversarial: 0.13 },
  kimi: { math: 0.30, market: 0.28, history: 0.16, fundamentals: 0.10, intelligence: 0.03, draw: 0.13, adversarial: 0.18 },
  gemini: { math: 0.30, market: 0.22, history: 0.18, fundamentals: 0.15, intelligence: 0.05, draw: 0.10, adversarial: 0.14 },
  deepseek: { math: 0.35, market: 0.18, history: 0.17, fundamentals: 0.10, intelligence: 0.03, draw: 0.10, adversarial: 0.12 },
  doubao: { math: 0.32, market: 0.18, history: 0.14, fundamentals: 0.10, intelligence: 0.04, draw: 0.08, adversarial: 0.24 },
  qwen: { math: 0.33, market: 0.27, history: 0.17, fundamentals: 0.08, intelligence: 0.02, draw: 0.13, adversarial: 0.16 },
});

const logPool = (agents, weights) => {
  const usable = agents.filter((agent) => agent.available && agent.id !== "adversarial" && weights[agent.id] > 0);
  const total = usable.reduce((sum, agent) => sum + weights[agent.id], 0);
  const logits = Object.fromEntries(OUTCOMES.map((code) => [code, usable.reduce((sum, agent) => (
    sum + (weights[agent.id] / total) * Math.log(clamp(agent.distribution[code], 1e-6, 1))
  ), 0)]));
  const maxLogit = Math.max(...OUTCOMES.map((code) => logits[code]));
  return normalize(Object.fromEntries(OUTCOMES.map((code) => [code, Math.exp(logits[code] - maxLogit)])));
};

const buildProfessionalDecision = (agent, match) => {
  const evidence = buildEvidenceAgents(match);
  const weights = PROFILE_WEIGHTS[agent.id] || PROFILE_WEIGHTS.gpt;
  let probabilities = logPool(evidence.agents, weights);
  const preliminaryPick = leader(probabilities);
  const adversarial = evidence.agents.find((row) => row.id === "adversarial");
  const counterPick = adversarial.pick;
  const attack = clamp((adversarial.riskScore - 45) / 1000, 0, 0.045) * (weights.adversarial / 0.15);
  probabilities = shiftOutcome(probabilities, counterPick, attack);
  const pick = leader(probabilities);
  const pickedProbability = probabilities[pick];
  const marketProbability = match.marketProbabilities[pick];
  const strongestSupport = evidence.agents
    .filter((row) => row.available && row.id !== "adversarial" && row.pick === pick)
    .sort((left, right) => right.confidence - left.confidence)[0];
  const audit = {
    version: VERSION,
    evidenceSnapshotHash: evidence.snapshot.hash || null,
    evidenceAgents: evidence.agents,
    judge: {
      id: "chief-judge",
      nameZh: "A8 总裁判",
      weights,
      preliminaryPick,
      finalPick: pick,
      changedByAdversarialReview: preliminaryPick !== pick,
      policy: "weighted-log-pool-with-capped-adversarial-review-v1",
    },
    drawSignalScore: evidence.drawScore,
    adversarialRiskScore: evidence.adversarialRisk,
    dataQuality: round(finite(evidence.snapshot.context.dataQuality, 0), 3),
    missingSignals: evidence.snapshot.context.missingKeys || [],
  };
  return {
    probabilities,
    pick,
    decisionAudit: audit,
    reasonsZh: [
      `${labelZh(pick)}为总裁判融合后的最高概率 ${Math.round(pickedProbability * 100)}%，不是简单多数投票。`,
      strongestSupport ? `${strongestSupport.nameZh}提供主要支持；${strongestSupport.reasonZh}` : "各证据方向分散，总裁判保留最低置信等级。",
      `平局结构 ${evidence.drawScore}/100，反方风险 ${evidence.adversarialRisk}/100，数据完整度 ${Math.round(audit.dataQuality * 100)}%。`,
    ],
    reasonsEn: [
      `${pick === "1" ? "Home win" : pick === "2" ? "Away win" : "Draw"} leads the chief-judge fusion at ${Math.round(pickedProbability * 100)}%; this is not a majority vote.`,
      strongestSupport ? `${strongestSupport.nameEn} supplies the strongest aligned evidence.` : "Evidence is dispersed, so confidence remains constrained.",
      `Draw structure ${evidence.drawScore}/100, adversarial risk ${evidence.adversarialRisk}/100, data quality ${Math.round(audit.dataQuality * 100)}%.`,
    ],
    expectedValue: pickedProbability * match.odds[pick] - 1,
    marketProbability,
  };
};

module.exports = {
  OUTCOMES,
  SNAPSHOT_VERSION,
  VERSION,
  buildArenaEvidenceSnapshot,
  buildEvidenceAgents,
  buildProfessionalDecision,
};
