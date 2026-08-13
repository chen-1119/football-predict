import type { Match, OutcomeProbability } from './mockData';
import { buildApiUrl } from './runtimeUrls';

export type ArenaPickCode = '1' | 'X' | '2';
export type ArenaRiskStyle = 'steady' | 'balanced' | 'aggressive';
export type ArenaLeagueCode = 'premier-league' | 'laliga' | 'serie-a' | 'bundesliga' | 'ligue-1';

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
  weeklyBudget: number;
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
  investment: boolean;
  stake: number;
}

export interface ArenaAgentEntry extends ArenaAgentDefinition {
  startingBalance: 10_000;
  balance: number;
  status: 'ACTIVE' | 'YELLOW' | 'RED' | 'BANKRUPT';
  forecasts: ArenaForecast[];
  investedMatches: number;
  totalStake: number;
  brierScore: number | null;
  settledPredictions?: number;
  won?: number;
  lost?: number;
  voided?: number;
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
  version: 'ai-big-five-survival-preview-v1' | 'ai-big-five-survival-v2';
  monthKey?: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  targetMatches: 10;
  availableMatches: number;
  complete: boolean;
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
    investmentsPerAgent: number;
    weeklyStakeMin: 1500;
    weeklyStakeMax: 2500;
    singleStakeMin: 300;
    singleStakeMax: 1200;
    longOddsThreshold: 3.5;
    longOddsStakeMax: 500;
  };
  disclosure: 'strategy-simulation-not-external-model-calls';
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
  { id: 'gpt', name: 'GPT', nameZh: 'GPT 全局均衡', style: 'balanced', styleZh: '全局均衡', styleEn: 'Global balance', color: '#6ee7b7', weeklyBudget: 2000 },
  { id: 'claude', name: 'Claude', nameZh: 'Claude 风险审慎', style: 'steady', styleZh: '风险审慎', styleEn: 'Risk first', color: '#f0b37e', weeklyBudget: 1600 },
  { id: 'gemini', name: 'Gemini', nameZh: 'Gemini 多信号', style: 'balanced', styleZh: '多信号融合', styleEn: 'Multi-signal', color: '#8ab4f8', weeklyBudget: 1900 },
  { id: 'deepseek', name: 'DeepSeek', nameZh: 'DeepSeek 价值搜索', style: 'aggressive', styleZh: '价值搜索', styleEn: 'Value search', color: '#8b9cff', weeklyBudget: 2200 },
  { id: 'grok', name: 'Grok', nameZh: 'Grok 逆向进攻', style: 'aggressive', styleZh: '逆向进攻', styleEn: 'Contrarian attack', color: '#f4d06f', weeklyBudget: 2500 },
  { id: 'qwen', name: 'Qwen', nameZh: 'Qwen 稳定执行', style: 'steady', styleZh: '稳定执行', styleEn: 'Stable execution', color: '#d5a6ff', weeklyBudget: 1800 },
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
  claude: { modelWeight: 0.60, marketWeight: 0.40, valueWeight: 0.02, drawBias: 0.018, favoriteBias: 0.012, underdogBias: 0 },
  gemini: { modelWeight: 0.70, marketWeight: 0.30, valueWeight: 0.12, drawBias: 0.004, favoriteBias: 0, underdogBias: 0 },
  deepseek: { modelWeight: 0.76, marketWeight: 0.24, valueWeight: 0.20, drawBias: 0, favoriteBias: 0, underdogBias: 0.008 },
  grok: { modelWeight: 0.86, marketWeight: 0.14, valueWeight: 0.25, drawBias: -0.008, favoriteBias: 0, underdogBias: 0.018 },
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

const stableFraction = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
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

const identifyLeague = (match: Match): ArenaLeagueCode | null => {
  const text = [match.leagueId, match.leagueName, match.leagueNameEn, match.leagueShortName, match.leagueShortNameEn]
    .filter(Boolean).join(' ').toLowerCase();
  if (/(^|\s)epl($|\s)|英超|premier\s*league/.test(text)) return 'premier-league';
  if (/西甲|la\s*liga|laliga/.test(text)) return 'laliga';
  if (/意甲|serie\s*a|seriea/.test(text)) return 'serie-a';
  if (/德甲|bundesliga/.test(text)) return 'bundesliga';
  if (/法甲|ligue\s*1|ligue1/.test(text)) return 'ligue-1';
  return null;
};

const agentDistribution = (
  agentId: string,
  matchId: string,
  model: Record<ArenaPickCode, number>,
  market: Record<ArenaPickCode, number>,
  odds: Record<ArenaPickCode, number>,
): Record<ArenaPickCode, number> => {
  const parameters = AGENT_PARAMETERS[agentId] || AGENT_PARAMETERS.gpt;
  const favorite = leader(market);
  const underdog = [...CODES].sort((left, right) => odds[right] - odds[left])[0];
  const raw = Object.fromEntries(CODES.map((code, index) => {
    const valueSignal = clamp(model[code] * odds[code] - 1, -0.35, 0.45);
    const jitter = (stableFraction(`${agentId}|${matchId}|${code}`) - 0.5) * 0.014;
    const bias = (code === 'X' ? parameters.drawBias : 0)
      + (code === favorite ? parameters.favoriteBias : 0)
      + (code === underdog ? parameters.underdogBias : 0)
      + (index === 0 ? 0.0001 : 0);
    return [code,
      model[code] * parameters.modelWeight
      + market[code] * parameters.marketWeight
      + valueSignal * parameters.valueWeight * 0.11
      + bias
      + jitter];
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
  const probabilities = agentDistribution(agent.id, match.id, model, market, odds);
  const pick = leader(probabilities);
  const reasons = reasonsFor(pick, probabilities, market, odds, agent);
  return {
    matchId: match.id,
    pick,
    probabilities,
    confidence: confidenceFor(probabilities),
    projectedScore: scorelineFor(match, pick),
    reasonsZh: reasons.zh,
    reasonsEn: reasons.en,
    expectedValue: probabilities[pick] * odds[pick] - 1,
    investment: false,
    stake: 0,
  };
};

const assignInvestments = (
  forecasts: ArenaForecast[],
  oddsByMatch: Map<string, Record<ArenaPickCode, number>>,
  weeklyBudget: number,
): ArenaForecast[] => {
  const ordered = [...forecasts].sort((left, right) => (
    (right.expectedValue + right.confidence * 0.025) - (left.expectedValue + left.confidence * 0.025)
    || left.matchId.localeCompare(right.matchId)
  ));
  const selected = ordered.slice(0, Math.min(3, ordered.length));
  const ratios = [0.45, 0.33, 0.22];
  const stakes = selected.map((forecast, index) => {
    const odds = oddsByMatch.get(forecast.matchId)?.[forecast.pick] || 0;
    const cap = odds > 3.5 ? 500 : 1200;
    return Math.min(cap, Math.max(300, Math.round((weeklyBudget * ratios[index]) / 100) * 100));
  });
  if (selected.length === 3) {
    let remaining = Math.max(0, Math.min(weeklyBudget, 2500) - stakes.reduce((sum, value) => sum + value, 0));
    for (let index = 0; index < stakes.length && remaining >= 100; index += 1) {
      const forecast = selected[index];
      const odds = oddsByMatch.get(forecast.matchId)?.[forecast.pick] || 0;
      const cap = odds > 3.5 ? 500 : 1200;
      const room = Math.max(0, cap - stakes[index]);
      const addition = Math.min(room, Math.floor(remaining / 100) * 100);
      stakes[index] += addition;
      remaining -= addition;
    }
  }
  const stakeByMatch = new Map(selected.map((forecast, index) => [forecast.matchId, stakes[index]]));
  return forecasts.map((forecast) => ({
    ...forecast,
    investment: stakeByMatch.has(forecast.matchId),
    stake: stakeByMatch.get(forecast.matchId) || 0,
  }));
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
  const oddsByMatch = new Map(picked.map((row) => [row.match.id, row.odds]));

  const agents: ArenaAgentEntry[] = AGENTS.map((agent) => {
    const rawForecasts = picked.map((row) => buildForecast(
      agent, row.match, row.baseProbabilities, row.marketProbabilities, row.odds,
    ));
    const forecasts = assignInvestments(rawForecasts, oddsByMatch, agent.weeklyBudget);
    const totalStake = forecasts.reduce((sum, forecast) => sum + forecast.stake, 0);
    return {
      ...agent,
      startingBalance: STARTING_BALANCE,
      balance: STARTING_BALANCE,
      status: balanceStatus(STARTING_BALANCE),
      forecasts,
      investedMatches: forecasts.filter((forecast) => forecast.investment).length,
      totalStake,
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
      investmentsPerAgent: Math.min(3, matchesWithForecasts.length),
      weeklyStakeMin: 1500,
      weeklyStakeMax: 2500,
      singleStakeMin: 300,
      singleStakeMax: 1200,
      longOddsThreshold: 3.5,
      longOddsStakeMax: 500,
    },
    disclosure: 'strategy-simulation-not-external-model-calls',
  };
};

const isSha256OrNull = (value: unknown) => value === null || /^[a-f0-9]{64}$/.test(String(value || ''));

export const isPublishedBigFiveSurvivalArena = (value: unknown): value is BigFiveSurvivalArena => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<BigFiveSurvivalArena>;
  if (row.version !== 'ai-big-five-survival-v2' || row.disclosure !== 'strategy-simulation-not-external-model-calls') return false;
  if (row.formalStatisticsExcluded !== true || row.targetMatches !== 10) return false;
  if (!Array.isArray(row.matches) || !Array.isArray(row.agents) || !Array.isArray(row.leagueSlots)) return false;
  if (!Array.isArray(row.dates) || !Array.isArray(row.standings) || !Array.isArray(row.flopBoard)) return false;
  if (!Array.isArray(row.seasonStandings)) return false;
  if (!['FORMING', 'READY', 'LOCKED'].includes(String(row.state || ''))) return false;
  if (row.agents.length !== 6 || row.leagueSlots.length !== 5) return false;
  if (!Number.isInteger(row.availableMatches) || row.availableMatches! < 0 || row.availableMatches! > 10) return false;
  if (!isSha256OrNull(row.poolHash) || !isSha256OrNull(row.submissionRootHash)) return false;
  if (row.state === 'LOCKED') {
    if (row.complete !== true || row.availableMatches !== 10) return false;
    if (row.matches.length !== 10) return false;
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
