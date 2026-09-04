import type { Match, OutcomeProbability } from './mockData';
import { buildApiUrl } from './runtimeUrls';

export type ArenaPickCode = '1' | 'X' | '2';
export type ArenaRiskStyle = 'steady' | 'balanced' | 'aggressive';
export type ArenaLeagueCode = 'premier-league' | 'laliga' | 'serie-a' | 'bundesliga' | 'ligue-1';
export type ArenaRecommendationTier = 'HIGH_EVIDENCE' | 'REFERENCE' | 'LOW_CONFIDENCE';

export interface ArenaStakingProfile {
  kellyFraction: number;
  minEv: number;
  minEdge: number;
  minDataQuality: number;
  maxAdversarialRisk: number;
  weeklyRiskFraction: number;
  singleRiskFraction: number;
  correlationCapFraction: number;
}

export interface ArenaLeagueSlot {
  code: ArenaLeagueCode;
  nameZh: string;
  nameEn: string;
  count: number;
  target: 2;
}

export interface ArenaAgentDefinition {
  id: string;
  name: string;
  nameZh: string;
  style: ArenaRiskStyle;
  styleZh: string;
  styleEn: string;
  color: string;
  model?: string;
  providerMode?: 'local-strategy-simulation';
  staking: ArenaStakingProfile;
}

export interface ArenaForecast {
  matchId: string;
  pick: ArenaPickCode;
  probabilities: Record<ArenaPickCode, number>;
  confidence: 1 | 2 | 3 | 4 | 5;
  projectedScore: string;
  reasonsZh: [string, string, string];
  reasonsEn: [string, string, string];
  expectedValue: number;
  recommendationTier: ArenaRecommendationTier;
  recommendationReasonCodes: string[];
  dataQuality: number;
  adversarialRisk: number;
  investment: boolean;
  stake: number;
  stakeReasonZh: string;
  stakeReasonEn: string;
  stakeAudit: {
    policy: 'fractional-kelly-evidence-risk-v2';
    eligible: boolean;
    reasonCode: string;
    rawKelly: number;
    discount: number;
    dataQuality: number;
    adversarialRisk: number;
    marketEdge: number;
    weeklyCap: number;
    singleCap: number;
    correlationCap: number;
    allocatedStake: number;
    reserveAfter: number;
  } | null;
  decisionAudit?: {
    version: 'professional-agent-fusion-v1';
    evidenceSnapshotHash: string | null;
    evidenceAgents: Array<{
      id: string;
      nameZh: string;
      nameEn: string;
      available: boolean;
      distribution: Record<ArenaPickCode, number>;
      pick: ArenaPickCode;
      confidence: number;
      signalScore?: number;
      riskScore?: number;
      reasonZh: string;
    }>;
    judge: {
      id: 'chief-judge';
      nameZh: string;
      weights: Record<string, number>;
      preliminaryPick: ArenaPickCode;
      finalPick: ArenaPickCode;
      changedByAdversarialReview: boolean;
      policy: string;
    };
    drawSignalScore: number;
    adversarialRiskScore: number;
    dataQuality: number;
    missingSignals: string[];
  };
}

export interface ArenaAgentEntry extends ArenaAgentDefinition {
  startingBalance: 10_000;
  balance: number;
  status: 'ACTIVE' | 'YELLOW' | 'RED' | 'BANKRUPT';
  forecasts: ArenaForecast[];
  investedMatches: number;
  totalStake: number;
  reservedBalance?: number;
  brierScore: number | null;
  settledPredictions?: number;
  won?: number;
  lost?: number;
  voided?: number;
  settledStake?: number;
  realizedProfit?: number;
  roi?: number | null;
  maxDrawdown: number;
  wealthRank: number | null;
  predictionRank: number | null;
  riskRank: number | null;
  stageScore: number | null;
  riskReward?: number | null;
  submissionHash?: string | null;
  balanceHistory?: Array<{
    at: string;
    balance: number;
    delta?: number;
    matchId?: string;
  }>;
}

export interface ArenaMatchEntry {
  match: Match;
  league: ArenaLeagueSlot;
  dateKey: string;
  odds: Record<ArenaPickCode, number>;
  baseProbabilities: Record<ArenaPickCode, number>;
  marketProbabilities: Record<ArenaPickCode, number>;
  forecasts: Array<ArenaForecast & { agentId: string; agentName: string; color: string }>;
  settlement?: {
    status: 'SETTLED' | 'VOID';
    outcome: ArenaPickCode | null;
    scoreHome: number | null;
    scoreAway: number | null;
    settledAt: string;
  } | null;
}

export interface BigFiveSurvivalArena {
  ok?: boolean;
  version: 'ai-big-five-survival-preview-v1' | 'ai-big-five-survival-v2' | 'ai-big-five-survival-v3' | 'ai-big-five-survival-v4' | 'ai-big-five-survival-v5';
  monthKey?: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  targetMatches: 10;
  availableMatches: number;
  complete: boolean;
  roundActive?: boolean;
  poolPolicy?: 'complete-or-friday-partial-lock-v1';
  shortfallPolicy?: 'lock-current-qualified-pool-no-backfill';
  partialLockAt?: string | null;
  leagueSlots: ArenaLeagueSlot[];
  matches: ArenaMatchEntry[];
  agents: ArenaAgentEntry[];
  dates: string[];
  state?: 'UNAVAILABLE' | 'FORMING' | 'READY' | 'LOCKED';
  lockedAt?: string | null;
  poolHash?: string | null;
  submissionRootHash?: string | null;
  standings?: ArenaAgentEntry[];
  seasonStandings?: Array<{
    agentId: string;
    agentName: string;
    color: string;
    seasonPoints: number;
    stages: number;
    averageBrier: number | null;
    bestStage: number;
    rank: number;
  }>;
  evidenceStandings?: Array<{
    id: string;
    nameZh: string;
    nameEn: string;
    settled: number;
    hits: number;
    hitRate: number | null;
    brierScore: number | null;
  }>;
  awards?: {
    monthChampion: { agentId: string; agentName: string; value: number } | null;
    wealthKing: { agentId: string; agentName: string; value: number } | null;
    accuracyKing: { agentId: string; agentName: string; value: number } | null;
    riskKing: { agentId: string; agentName: string; value: number } | null;
    upsetKing: { agentId: string; agentName: string; value: number } | null;
    reckless: { agentId: string; agentName: string; value: number } | null;
    bankrupt: Array<{ agentId: string; agentName: string }>;
  } | null;
  flopBoard?: Array<{
    agentId: string;
    agentName: string;
    matchId: string;
    match: string;
    pick: ArenaPickCode;
    confidence: number;
    actual: ArenaPickCode;
    loss: number;
    settledAt: string;
  }>;
  rules: {
    startingBalance: 10_000;
    predictionsPerAgent: number;
    stakingMode?: 'autonomous-fractional-kelly-v2';
    investmentsPerAgent: number | null;
    zeroStakeAllowed?: true;
    minimumExecutableStake?: 50;
    weeklyRiskFractionRange?: [number, number];
    singleRiskFractionRange?: [number, number];
    weeklyStakeMin?: number;
    weeklyStakeMax?: number;
    singleStakeMin?: number;
    singleStakeMax?: number;
    longOddsThreshold: 3.5;
    longOddsStakeMax?: number;
    longOddsRiskFractionMax?: number;
    extremeOddsThreshold?: number;
    extremeOddsRiskFractionMax?: number;
  };
  disclosure: 'strategy-simulation-not-external-model-calls';
  decisionEngine?: 'professional-agent-fusion-v1';
  stakingEngine?: 'fractional-kelly-evidence-risk-v2';
  dataAccess?: {
    mode: 'shared-immutable-pre-match-snapshot';
    identicalInputs: true;
    sources: string[];
    externalProviderCallsActive: false;
  };
  resultWriter?: {
    mode: 'trusted-official-auto-settlement';
    officialOnly: true;
    forecastsImmutable: true;
    modelScoreWriteAllowed: false;
  };
  stakeFreedom?: 'any-qualified-match-or-zero-with-risk-caps';
  formalStatisticsExcluded?: true;
  integrity?: {
    immutable: boolean;
    inputSnapshotHash: string | null;
    submissionRootHash: string | null;
    stateHash: string;
  };
}

const CODES: ArenaPickCode[] = ['1', 'X', '2'];
const STARTING_BALANCE = 10_000 as const;

const LEAGUES: Array<Omit<ArenaLeagueSlot, 'count'>> = [
  { code: 'premier-league', nameZh: '英超', nameEn: 'Premier League', target: 2 },
  { code: 'laliga', nameZh: '西甲', nameEn: 'La Liga', target: 2 },
  { code: 'serie-a', nameZh: '意甲', nameEn: 'Serie A', target: 2 },
  { code: 'bundesliga', nameZh: '德甲', nameEn: 'Bundesliga', target: 2 },
  { code: 'ligue-1', nameZh: '法甲', nameEn: 'Ligue 1', target: 2 },
];

const AGENTS: ArenaAgentDefinition[] = [
  { id: 'gpt', name: '均衡策略', nameZh: '均衡策略', model: 'autonomous-risk-v2', providerMode: 'local-strategy-simulation', style: 'balanced', styleZh: '全局均衡', styleEn: 'Global balance', color: '#6ee7b7', staking: { kellyFraction: 0.18, minEv: 0.020, minEdge: 0.005, minDataQuality: 0.45, maxAdversarialRisk: 0.75, weeklyRiskFraction: 0.18, singleRiskFraction: 0.060, correlationCapFraction: 0.10 } },
  { id: 'kimi', name: '稳健策略', nameZh: '稳健策略', model: 'auditable-risk-v2', providerMode: 'local-strategy-simulation', style: 'steady', styleZh: '风险审慎', styleEn: 'Risk first', color: '#f0b37e', staking: { kellyFraction: 0.10, minEv: 0.035, minEdge: 0.010, minDataQuality: 0.60, maxAdversarialRisk: 0.55, weeklyRiskFraction: 0.12, singleRiskFraction: 0.040, correlationCapFraction: 0.07 } },
  { id: 'gemini', name: '融合策略', nameZh: '融合策略', model: 'multi-signal-risk-v2', providerMode: 'local-strategy-simulation', style: 'balanced', styleZh: '多信号融合', styleEn: 'Multi-signal', color: '#8ab4f8', staking: { kellyFraction: 0.16, minEv: 0.025, minEdge: 0.008, minDataQuality: 0.55, maxAdversarialRisk: 0.65, weeklyRiskFraction: 0.16, singleRiskFraction: 0.050, correlationCapFraction: 0.09 } },
  { id: 'deepseek', name: '价值策略', nameZh: '价值策略', model: 'autonomous-risk-v2', providerMode: 'local-strategy-simulation', style: 'aggressive', styleZh: '价值搜索', styleEn: 'Value search', color: '#8b9cff', staking: { kellyFraction: 0.22, minEv: 0.015, minEdge: 0.005, minDataQuality: 0.45, maxAdversarialRisk: 0.72, weeklyRiskFraction: 0.20, singleRiskFraction: 0.065, correlationCapFraction: 0.11 } },
  { id: 'doubao', name: '逆向策略', nameZh: '逆向策略', model: 'auditable-risk-v2', providerMode: 'local-strategy-simulation', style: 'aggressive', styleZh: '逆向进攻', styleEn: 'Contrarian attack', color: '#f4d06f', staking: { kellyFraction: 0.20, minEv: 0.030, minEdge: 0.015, minDataQuality: 0.40, maxAdversarialRisk: 0.78, weeklyRiskFraction: 0.22, singleRiskFraction: 0.070, correlationCapFraction: 0.12 } },
  { id: 'qwen', name: '纪律策略', nameZh: '纪律策略', model: 'autonomous-risk-v2', providerMode: 'local-strategy-simulation', style: 'steady', styleZh: '稳定执行', styleEn: 'Stable execution', color: '#d5a6ff', staking: { kellyFraction: 0.08, minEv: 0.050, minEdge: 0.015, minDataQuality: 0.65, maxAdversarialRisk: 0.50, weeklyRiskFraction: 0.10, singleRiskFraction: 0.030, correlationCapFraction: 0.06 } },
];

const AGENT_PARAMETERS: Record<string, {
  modelWeight: number;
  marketWeight: number;
  valueWeight: number;
  drawBias: number;
  favoriteBias: number;
  underdogBias: number;
}> = {
  gpt: { modelWeight: 0.82, marketWeight: 0.18, valueWeight: 0.08, drawBias: 0, favoriteBias: 0, underdogBias: 0 },
  kimi: { modelWeight: 0.60, marketWeight: 0.40, valueWeight: 0.02, drawBias: 0.018, favoriteBias: 0.012, underdogBias: 0 },
  gemini: { modelWeight: 0.70, marketWeight: 0.30, valueWeight: 0.12, drawBias: 0.004, favoriteBias: 0, underdogBias: 0 },
  deepseek: { modelWeight: 0.76, marketWeight: 0.24, valueWeight: 0.20, drawBias: 0, favoriteBias: 0, underdogBias: 0.008 },
  doubao: { modelWeight: 0.86, marketWeight: 0.14, valueWeight: 0.25, drawBias: -0.008, favoriteBias: 0, underdogBias: 0.018 },
  qwen: { modelWeight: 0.68, marketWeight: 0.32, valueWeight: 0.05, drawBias: 0.008, favoriteBias: 0.014, underdogBias: 0 },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const finitePositive = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const finiteNonNegative = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const normalizeProbability = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed > 1.000001 ? parsed / 100 : parsed;
};

const normalizeTriplet = (values: Record<ArenaPickCode, number>): Record<ArenaPickCode, number> => {
  const safe = Object.fromEntries(CODES.map((code) => [code, Math.max(0.0001, values[code])])) as Record<ArenaPickCode, number>;
  const total = safe['1'] + safe.X + safe['2'];
  return {
    '1': safe['1'] / total,
    X: safe.X / total,
    '2': safe['2'] / total,
  };
};

const outcomeTriplet = (value: OutcomeProbability | null | undefined): Record<ArenaPickCode, number> | null => {
  const home = normalizeProbability(value?.home);
  const draw = normalizeProbability(value?.draw);
  const away = normalizeProbability(value?.away);
  if (home === null || draw === null || away === null || home + draw + away <= 0) return null;
  return normalizeTriplet({ '1': home, X: draw, '2': away });
};

const officialHadOdds = (match: Match): Record<ArenaPickCode, number> | null => {
  if (match.oddsSource !== 'sporttery:HAD') return null;
  const home = finitePositive(match.odds?.odds1);
  const draw = finitePositive(match.odds?.oddsX);
  const away = finitePositive(match.odds?.odds2);
  if (home === null || draw === null || away === null) return null;
  return { '1': home, X: draw, '2': away };
};

const devig = (odds: Record<ArenaPickCode, number>): Record<ArenaPickCode, number> => {
  const inverse = { '1': 1 / odds['1'], X: 1 / odds.X, '2': 1 / odds['2'] };
  return normalizeTriplet(inverse);
};

const leader = (scores: Record<ArenaPickCode, number>): ArenaPickCode => (
  [...CODES].sort((left, right) => scores[right] - scores[left] || CODES.indexOf(left) - CODES.indexOf(right))[0]
);

const shanghaiDateKey = (value: Date | number | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
};

const addDays = (dateKey: string, days: number): string => {
  const value = new Date(`${dateKey}T12:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return shanghaiDateKey(value);
};

export const arenaWeekRange = (nowMs = Date.now()): { weekStart: string; weekEnd: string } => {
  const dateKey = shanghaiDateKey(nowMs);
  const noon = new Date(`${dateKey}T12:00:00+08:00`);
  const weekday = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' })
    .formatToParts(noon).find((part) => part.type === 'weekday')?.value
    .replace('Mon', '1').replace('Tue', '2').replace('Wed', '3').replace('Thu', '4')
    .replace('Fri', '5').replace('Sat', '6').replace('Sun', '7')) || 1;
  const weekStart = addDays(dateKey, -(weekday - 1));
  return { weekStart, weekEnd: addDays(weekStart, 6) };
};

const matchDateKey = (match: Match): string => (
  String(match.businessDate || match.matchDate || match.kickoffDate || '').slice(0, 10)
  || shanghaiDateKey(match.kickoffTime)
);

const identifyLeagueText = (text: string): ArenaLeagueCode | null => {
  if (/巴甲|巴西|brazil|brasileir/.test(text)) return null;
  if (/(^|\s)epl($|\s)|(?:^|[\s/·_-])英超(?:$|[\s/·_-])|premier\s*league/.test(text)) return 'premier-league';
  if (/英格兰(?:足球)?超级联赛/.test(text)) return 'premier-league';
  if (/(?:^|[\s/·_-])西甲(?:$|[\s/·_-])|西班牙(?:足球)?甲级联赛|la\s*liga|laliga/.test(text)) return 'laliga';
  if (/(?:^|[\s/·_-])意甲(?:$|[\s/·_-])|意大利(?:足球)?甲级联赛|serie\s*a|seriea/.test(text)) return 'serie-a';
  if (/(?:^|[\s/·_-])德甲(?:$|[\s/·_-])|德国(?:足球)?甲级联赛|bundesliga/.test(text)) return 'bundesliga';
  if (/(?:^|[\s/·_-])法甲(?:$|[\s/·_-])|法国(?:足球)?甲级联赛|ligue\s*1|ligue1/.test(text)) return 'ligue-1';
  return null;
};

const identifyLeague = (match: Match): ArenaLeagueCode | null => {
  // Human-readable provider labels are authoritative when present. Falling
  // through to a stale/reused leagueId can otherwise put a Brazilian or
  // Championship fixture into a Big Five slot after an identity merge.
  const labelText = [match.leagueName, match.leagueNameEn, match.leagueShortName, match.leagueShortNameEn]
    .filter(Boolean).join(' ').toLowerCase();
  if (labelText) return identifyLeagueText(labelText);
  return identifyLeagueText(String(match.leagueId || '').toLowerCase());
};

const agentDistribution = (
  agentId: string,
  model: Record<ArenaPickCode, number>,
  market: Record<ArenaPickCode, number>,
  odds: Record<ArenaPickCode, number>,
): Record<ArenaPickCode, number> => {
  const parameters = AGENT_PARAMETERS[agentId] || AGENT_PARAMETERS.gpt;
  const favorite = leader(market);
  const underdog = [...CODES].sort((left, right) => odds[right] - odds[left])[0];
  const raw = Object.fromEntries(CODES.map((code) => {
    const valueSignal = clamp(model[code] * odds[code] - 1, -0.35, 0.45);
    const bias = (code === 'X' ? parameters.drawBias : 0)
      + (code === favorite ? parameters.favoriteBias : 0)
      + (code === underdog ? parameters.underdogBias : 0);
    return [code,
      model[code] * parameters.modelWeight
      + market[code] * parameters.marketWeight
      + valueSignal * parameters.valueWeight * 0.11
      + bias];
  })) as Record<ArenaPickCode, number>;
  return normalizeTriplet(raw);
};

const scorelineFor = (match: Match, pick: ArenaPickCode): string => {
  const home = finiteNonNegative(match.projectedScoreHome);
  const away = finiteNonNegative(match.projectedScoreAway);
  if (home !== null && away !== null) return `${Math.round(home)}-${Math.round(away)}`;
  if (pick === '1') return '2-1';
  if (pick === '2') return '1-2';
  return '1-1';
};

const confidenceFor = (probabilities: Record<ArenaPickCode, number>): 1 | 2 | 3 | 4 | 5 => {
  const ordered = CODES.map((code) => probabilities[code]).sort((left, right) => right - left);
  const score = ordered[0] + Math.max(0, ordered[0] - ordered[1]) * 0.8;
  if (score >= 0.67) return 5;
  if (score >= 0.55) return 4;
  if (score >= 0.45) return 3;
  if (score >= 0.38) return 2;
  return 1;
};

const reasonsFor = (
  pick: ArenaPickCode,
  probabilities: Record<ArenaPickCode, number>,
  market: Record<ArenaPickCode, number>,
  odds: Record<ArenaPickCode, number>,
  agent: ArenaAgentDefinition,
): { zh: [string, string, string]; en: [string, string, string] } => {
  const edge = probabilities[pick] - market[pick];
  const pickZh = arenaPickLabel(pick, 'zh');
  const pickEn = arenaPickLabel(pick, 'en');
  return {
    zh: [
      `${pickZh}在该策略分布中概率最高，为${Math.round(probabilities[pick] * 100)}%`,
      edge >= 0.01 ? `相对同场去水市场高${Math.round(edge * 100)}个百分点` : `与同场去水市场接近，优先控制分歧风险`,
      `${agent.styleZh}规则评估官方SP ${odds[pick].toFixed(2)}后的风险收益`,
    ],
    en: [
      `${pickEn} leads this strategy distribution at ${Math.round(probabilities[pick] * 100)}%`,
      edge >= 0.01 ? `${Math.round(edge * 100)} points above the devigged market` : 'Close to the devigged market, so disagreement risk is limited',
      `${agent.styleEn} rules assess risk and reward at official SP ${odds[pick].toFixed(2)}`,
    ],
  };
};

const buildForecast = (
  agent: ArenaAgentDefinition,
  match: Match,
  model: Record<ArenaPickCode, number>,
  market: Record<ArenaPickCode, number>,
  odds: Record<ArenaPickCode, number>,
): ArenaForecast => {
  const probabilities = agentDistribution(agent.id, model, market, odds);
  const pick = leader(probabilities);
  const reasons = reasonsFor(pick, probabilities, market, odds, agent);
  const confidence = confidenceFor(probabilities);
  const coverageRaw = Number(match.probabilityModel?.contextSignals?.dataGaps?.coverageScore);
  const dataQuality = Number.isFinite(coverageRaw) ? clamp(coverageRaw > 1 ? coverageRaw / 100 : coverageRaw, 0, 1) : 0;
  const ordered = CODES.map((code) => probabilities[code]).sort((left, right) => right - left);
  const leadMargin = ordered[0] - ordered[1];
  const marketConflict = Math.abs(probabilities[pick] - market[pick]);
  const severeMissing = Number(match.probabilityModel?.contextSignals?.dataGaps?.severeMissingCount || 0);
  const adversarialRisk = clamp(0.35 + Math.max(0, 0.08 - leadMargin) * 2 + marketConflict + Math.min(0.2, severeMissing * 0.03) + (1 - dataQuality) * 0.25, 0, 1);
  const recommendationTier: ArenaRecommendationTier = dataQuality >= 0.75 && confidence >= 4 && adversarialRisk <= 0.45
    ? 'HIGH_EVIDENCE'
    : dataQuality >= 0.50 && confidence >= 2 && adversarialRisk <= 0.70
      ? 'REFERENCE'
      : 'LOW_CONFIDENCE';
  return {
    matchId: match.id,
    pick,
    probabilities,
    confidence,
    projectedScore: scorelineFor(match, pick),
    reasonsZh: reasons.zh,
    reasonsEn: reasons.en,
    expectedValue: probabilities[pick] * odds[pick] - 1,
    recommendationTier,
    recommendationReasonCodes: ['DETERMINISTIC_TOP_PROBABILITY', `TIER_${recommendationTier}`],
    dataQuality,
    adversarialRisk,
    investment: false,
    stake: 0,
    stakeReasonZh: '尚未执行积分风险分配。',
    stakeReasonEn: 'Point-risk allocation has not run yet.',
    stakeAudit: null,
  };
};

interface ArenaInvestmentMatch {
  odds: Record<ArenaPickCode, number>;
  marketProbabilities: Record<ArenaPickCode, number>;
  leagueCode: ArenaLeagueCode;
  dateKey: string;
}

const stakeReason = (reasonCode: string, stake = 0): [string, string] => {
  const reasons: Record<string, [string, string]> = {
    ALLOCATED: [`证据与预期价值通过门槛，自主分配 ${stake} 积分。`, `Evidence and expected value passed; ${stake} points allocated autonomously.`],
    BANKRUPT: ['积分为 0，继续预测但停止投入。', 'Balance is zero; forecasts continue but staking stops.'],
    NEGATIVE_OR_LOW_EV: ['预期价值未达到该 AI 的投入门槛，积分为 0。', "Expected value is below this AI's threshold; stake is zero."],
    EDGE_BELOW_THRESHOLD: ['相对市场优势不足，积分为 0。', 'The edge over market is insufficient; stake is zero.'],
    DATA_QUALITY_LOW: ['数据完整度不足，仅保留低置信推荐，积分为 0。', 'Data quality is insufficient; the recommendation remains, but stake is zero.'],
    ADVERSARIAL_RISK_HIGH: ['反方审查风险过高，积分为 0。', 'Adversarial-review risk is too high; stake is zero.'],
    CONFIDENCE_LOW: ['方向领先幅度不足，积分为 0。', 'The leading outcome margin is too small; stake is zero.'],
    RED_ZONE_RESTRICTED: ['处于红区且未通过强化门槛，积分为 0。', 'Red-zone enhanced thresholds were not met; stake is zero.'],
    STAKE_BELOW_MINIMUM: ['凯利折算后的风险额度低于最小执行单位，积分为 0。', 'The Kelly-adjusted amount is below the execution minimum; stake is zero.'],
    WEEKLY_RISK_BUDGET_EXHAUSTED: ['本周风险预算已用尽，积分为 0。', 'The weekly risk budget is exhausted; stake is zero.'],
    CORRELATION_CAP_REACHED: ['同联赛同比赛日暴露达到上限，积分为 0。', 'The same-league/day correlation cap is reached; stake is zero.'],
  };
  return reasons[reasonCode] || ['未触发积分投入。', 'No point stake was triggered.'];
};

const assignInvestments = (
  forecasts: ArenaForecast[],
  matchesById: Map<string, ArenaInvestmentMatch>,
  agent: ArenaAgentDefinition,
  balance: number,
): ArenaForecast[] => {
  const status = balanceStatus(balance);
  const policy = agent.staking;
  const zoneMultiplier = status === 'RED' ? 0 : status === 'YELLOW' ? 0.65 : 1;
  const weeklyRiskFraction = status === 'RED' ? 0
    : status === 'YELLOW' ? Math.min(policy.weeklyRiskFraction, 0.10) : policy.weeklyRiskFraction;
  const singleRiskFraction = status === 'RED' ? 0
    : status === 'YELLOW' ? Math.min(policy.singleRiskFraction, 0.04) : policy.singleRiskFraction;
  const weeklyCap = Math.floor(Math.min(balance, balance * weeklyRiskFraction) / 10) * 10;
  const singleCap = Math.floor(Math.min(balance, balance * singleRiskFraction) / 10) * 10;
  const correlationCap = Math.floor(Math.min(balance, balance * policy.correlationCapFraction) / 10) * 10;
  let totalStake = 0;
  const groupStakes = new Map<string, number>();
  const allocations = new Map<string, Pick<ArenaForecast, 'investment' | 'stake' | 'stakeReasonZh' | 'stakeReasonEn' | 'stakeAudit'>>();
  const ordered = [...forecasts].sort((left, right) => (
    right.expectedValue - left.expectedValue
    || right.probabilities[right.pick] - left.probabilities[left.pick]
    || right.confidence - left.confidence
    || left.matchId.localeCompare(right.matchId)
  ));
  for (const forecast of ordered) {
    const match = matchesById.get(forecast.matchId);
    const odds = match?.odds[forecast.pick] || 0;
    const edge = forecast.probabilities[forecast.pick] - (match?.marketProbabilities[forecast.pick] || 0);
    let reasonCode: string | null = null;
    if (status === 'BANKRUPT') reasonCode = 'BANKRUPT';
    else if (status === 'RED') reasonCode = 'RED_ZONE_RESTRICTED';
    else if (!(forecast.expectedValue >= policy.minEv) || !(odds > 1)) reasonCode = 'NEGATIVE_OR_LOW_EV';
    else if (edge < policy.minEdge) reasonCode = 'EDGE_BELOW_THRESHOLD';
    else if (forecast.dataQuality < policy.minDataQuality) reasonCode = 'DATA_QUALITY_LOW';
    else if (forecast.adversarialRisk > policy.maxAdversarialRisk) reasonCode = 'ADVERSARIAL_RISK_HIGH';
    else if (forecast.confidence < 2) reasonCode = 'CONFIDENCE_LOW';
    const rawKelly = odds > 1 ? Math.max(0, forecast.expectedValue / (odds - 1)) : 0;
    const confidenceDiscount = clamp((forecast.confidence - 1) / 4, 0.15, 1);
    const longOddsDiscount = odds > 3.5 ? clamp(3.5 / odds, 0.15, 1) : 1;
    const discount = confidenceDiscount * forecast.dataQuality * (1 - forecast.adversarialRisk) * longOddsDiscount * zoneMultiplier;
    const longOddsCap = odds >= 8 ? Math.floor(balance * 0.005 / 10) * 10
      : odds > 3.5 ? Math.floor(balance * 0.02 / 10) * 10 : singleCap;
    const effectiveSingleCap = Math.min(singleCap, longOddsCap);
    const groupKey = `${match?.leagueCode || 'unknown'}|${match?.dateKey || 'unknown'}`;
    const groupRemaining = Math.max(0, correlationCap - (groupStakes.get(groupKey) || 0));
    const weeklyRemaining = Math.max(0, weeklyCap - totalStake);
    let stake = reasonCode ? 0 : Math.floor((balance * policy.kellyFraction * rawKelly * discount) / 10) * 10;
    stake = Math.min(stake, effectiveSingleCap, groupRemaining, weeklyRemaining);
    if (!reasonCode && weeklyRemaining < 50) reasonCode = 'WEEKLY_RISK_BUDGET_EXHAUSTED';
    else if (!reasonCode && groupRemaining < 50) reasonCode = 'CORRELATION_CAP_REACHED';
    else if (!reasonCode && stake < 50) reasonCode = 'STAKE_BELOW_MINIMUM';
    if (reasonCode) stake = 0;
    else reasonCode = 'ALLOCATED';
    if (stake > 0) {
      totalStake += stake;
      groupStakes.set(groupKey, (groupStakes.get(groupKey) || 0) + stake);
    }
    const finalReasonCode = reasonCode || 'STAKE_BELOW_MINIMUM';
    const [stakeReasonZh, stakeReasonEn] = stakeReason(finalReasonCode, stake);
    allocations.set(forecast.matchId, {
      investment: stake > 0,
      stake,
      stakeReasonZh,
      stakeReasonEn,
      stakeAudit: {
        policy: 'fractional-kelly-evidence-risk-v2', eligible: stake > 0, reasonCode: finalReasonCode,
        rawKelly, discount, dataQuality: forecast.dataQuality, adversarialRisk: forecast.adversarialRisk,
        marketEdge: edge, weeklyCap, singleCap: effectiveSingleCap, correlationCap,
        allocatedStake: stake, reserveAfter: Math.max(0, balance - totalStake),
      },
    });
  }
  return forecasts.map((forecast) => ({ ...forecast, ...allocations.get(forecast.matchId)! }));
};

const balanceStatus = (balance: number): ArenaAgentEntry['status'] => {
  if (balance <= 0) return 'BANKRUPT';
  if (balance < 1500) return 'RED';
  if (balance < 3000) return 'YELLOW';
  return 'ACTIVE';
};

export const buildBigFiveSurvivalArena = (
  matches: Match[],
  nowMs = Date.now(),
): BigFiveSurvivalArena => {
  const { weekStart, weekEnd } = arenaWeekRange(nowMs);
  const candidates = matches.flatMap((match) => {
    const leagueCode = identifyLeague(match);
    const dateKey = matchDateKey(match);
    if (!leagueCode || dateKey < weekStart || dateKey > weekEnd) return [];
    if (match.status !== 'SCHEDULED' || Date.parse(match.kickoffTime) <= nowMs) return [];
    const odds = officialHadOdds(match);
    const baseProbabilities = outcomeTriplet(match.probabilityModel?.oneXTwo?.final);
    if (!odds || !baseProbabilities) return [];
    return [{ match, leagueCode, dateKey, odds, baseProbabilities, marketProbabilities: devig(odds) }];
  });

  const picked = LEAGUES.flatMap((league) => candidates
    .filter((row) => row.leagueCode === league.code)
    .sort((left, right) => Date.parse(left.match.kickoffTime) - Date.parse(right.match.kickoffTime) || left.match.id.localeCompare(right.match.id))
    .slice(0, 2));
  const leagueSlots: ArenaLeagueSlot[] = LEAGUES.map((league) => ({
    ...league,
    count: picked.filter((row) => row.leagueCode === league.code).length,
  }));
  const investmentMatches = new Map<string, ArenaInvestmentMatch>(picked.map((row) => [row.match.id, {
    odds: row.odds,
    marketProbabilities: row.marketProbabilities,
    leagueCode: row.leagueCode,
    dateKey: row.dateKey,
  }]));

  const agents: ArenaAgentEntry[] = AGENTS.map((agent) => {
    const rawForecasts = picked.map((row) => buildForecast(
      agent, row.match, row.baseProbabilities, row.marketProbabilities, row.odds,
    ));
    const forecasts = assignInvestments(rawForecasts, investmentMatches, agent, STARTING_BALANCE);
    const totalStake = forecasts.reduce((sum, forecast) => sum + forecast.stake, 0);
    return {
      ...agent,
      startingBalance: STARTING_BALANCE,
      balance: STARTING_BALANCE,
      status: balanceStatus(STARTING_BALANCE),
      forecasts,
      investedMatches: forecasts.filter((forecast) => forecast.investment).length,
      totalStake,
      reservedBalance: STARTING_BALANCE - totalStake,
      brierScore: null,
      maxDrawdown: 0,
      wealthRank: null,
      predictionRank: null,
      riskRank: null,
      stageScore: null,
    };
  });

  const matchesWithForecasts: ArenaMatchEntry[] = picked
    .map((row) => ({
      match: row.match,
      league: leagueSlots.find((league) => league.code === row.leagueCode)!,
      dateKey: row.dateKey,
      odds: row.odds,
      baseProbabilities: row.baseProbabilities,
      marketProbabilities: row.marketProbabilities,
      forecasts: agents.map((agent) => {
        const forecast = agent.forecasts.find((item) => item.matchId === row.match.id)!;
        return { ...forecast, agentId: agent.id, agentName: agent.name, color: agent.color };
      }),
    }))
    .sort((left, right) => Date.parse(left.match.kickoffTime) - Date.parse(right.match.kickoffTime));

  return {
    version: 'ai-big-five-survival-preview-v1',
    weekStart,
    weekEnd,
    generatedAt: new Date(nowMs).toISOString(),
    targetMatches: 10,
    availableMatches: matchesWithForecasts.length,
    complete: leagueSlots.every((league) => league.count === league.target),
    leagueSlots,
    matches: matchesWithForecasts,
    agents,
    dates: [...new Set(matchesWithForecasts.map((row) => row.dateKey))].sort(),
    rules: {
      startingBalance: STARTING_BALANCE,
      predictionsPerAgent: matchesWithForecasts.length,
      stakingMode: 'autonomous-fractional-kelly-v2',
      investmentsPerAgent: null,
      zeroStakeAllowed: true,
      minimumExecutableStake: 50,
      weeklyRiskFractionRange: [0.10, 0.22],
      singleRiskFractionRange: [0.03, 0.07],
      longOddsThreshold: 3.5,
      longOddsRiskFractionMax: 0.02,
      extremeOddsThreshold: 8,
      extremeOddsRiskFractionMax: 0.005,
    },
    stakingEngine: 'fractional-kelly-evidence-risk-v2',
    disclosure: 'strategy-simulation-not-external-model-calls',
  };
};

const isSha256OrNull = (value: unknown) => value === null || /^[a-f0-9]{64}$/.test(String(value || ''));

export const isPublishedBigFiveSurvivalArena = (value: unknown): value is BigFiveSurvivalArena => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<BigFiveSurvivalArena>;
  if (!['ai-big-five-survival-v2', 'ai-big-five-survival-v3', 'ai-big-five-survival-v4', 'ai-big-five-survival-v5'].includes(String(row.version || ''))
    || row.disclosure !== 'strategy-simulation-not-external-model-calls') return false;
  if (row.formalStatisticsExcluded !== true || row.targetMatches !== 10) return false;
  if (!Array.isArray(row.matches) || !Array.isArray(row.agents) || !Array.isArray(row.leagueSlots)) return false;
  if (!Array.isArray(row.dates) || !Array.isArray(row.standings) || !Array.isArray(row.flopBoard)) return false;
  if (!Array.isArray(row.seasonStandings)) return false;
  if (!['FORMING', 'READY', 'LOCKED'].includes(String(row.state || ''))) return false;
  if (row.agents.length !== 6 || row.leagueSlots.length !== 5) return false;
  if (!Number.isInteger(row.availableMatches) || row.availableMatches! < 0 || row.availableMatches! > 10) return false;
  if (!isSha256OrNull(row.poolHash) || !isSha256OrNull(row.submissionRootHash)) return false;
  if (row.state === 'LOCKED') {
    const partialPoolContract = row.version === 'ai-big-five-survival-v5';
    if (partialPoolContract) {
      if (row.roundActive !== true || row.availableMatches! < 2) return false;
      if (row.matches.length !== row.availableMatches) return false;
      if (row.complete !== (row.availableMatches === 10)) return false;
      if (row.poolPolicy !== 'complete-or-friday-partial-lock-v1'
        || row.shortfallPolicy !== 'lock-current-qualified-pool-no-backfill') return false;
      if (row.dataAccess?.mode !== 'shared-immutable-pre-match-snapshot'
        || row.dataAccess.identicalInputs !== true
        || row.dataAccess.externalProviderCallsActive !== false) return false;
      if (row.resultWriter?.mode !== 'trusted-official-auto-settlement'
        || row.resultWriter.officialOnly !== true
        || row.resultWriter.forecastsImmutable !== true
        || row.resultWriter.modelScoreWriteAllowed !== false) return false;
      if (row.stakeFreedom !== 'any-qualified-match-or-zero-with-risk-caps') return false;
    } else if (row.complete !== true || row.availableMatches !== 10 || row.matches.length !== 10) {
      return false;
    }
    if (!row.integrity?.immutable || !/^[a-f0-9]{64}$/.test(String(row.integrity.stateHash || ''))) return false;
  }
  return true;
};

export const fetchPublishedBigFiveSurvivalArena = async (
  accessToken: string,
  signal?: AbortSignal,
): Promise<BigFiveSurvivalArena | null> => {
  const response = await fetch(buildApiUrl('/api/v1/ai-arena'), {
    headers: { authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!response.ok) throw new Error(`AI arena HTTP ${response.status}`);
  const payload: unknown = await response.json();
  return isPublishedBigFiveSurvivalArena(payload) ? payload : null;
};

export const arenaPickLabel = (code: ArenaPickCode, language: 'zh' | 'en'): string => {
  if (language === 'en') return code === '1' ? 'Home win' : code === '2' ? 'Away win' : 'Draw';
  return code === '1' ? '主胜' : code === '2' ? '客胜' : '平局';
};

export const arenaStatusLabel = (status: ArenaAgentEntry['status'], language: 'zh' | 'en'): string => {
  const labels = {
    ACTIVE: { zh: '生存', en: 'Active' },
    YELLOW: { zh: '黄区', en: 'Yellow' },
    RED: { zh: '红区', en: 'Red' },
    BANKRUPT: { zh: '破产', en: 'Bankrupt' },
  } as const;
  return labels[status][language];
};
