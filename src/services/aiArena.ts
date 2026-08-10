import type { Match, OutcomeProbability } from './mockData';

export type ArenaPickCode = '1' | 'X' | '2';
export type ArenaRisk = 'low' | 'medium' | 'high';

export interface ArenaAnalyst {
  id: string;
  nameZh: string;
  nameEn: string;
  styleZh: string;
  styleEn: string;
  pick: ArenaPickCode;
  probability: number;
  confidence: number;
  risk: ArenaRisk;
  stake: number;
  startingBalance: number;
  reasonsZh: string[];
  reasonsEn: string[];
}

export interface DailyArenaSelection {
  version: 'ai-single-match-arena-preview-v1';
  dateKey: string;
  match: Match;
  aiScore: number;
  probabilities: Record<ArenaPickCode, number>;
  marketProbabilities: Record<ArenaPickCode, number>;
  odds: Record<ArenaPickCode, number>;
  analysts: ArenaAnalyst[];
  consensus: {
    code: ArenaPickCode;
    votes: number;
    total: number;
  };
  projectedScore: string | null;
  disclosure: 'strategy-simulation';
}

const STARTING_BALANCE = 10_000;
const CODES: ArenaPickCode[] = ['1', 'X', '2'];

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

const outcomeTriplet = (value: OutcomeProbability | null | undefined): Record<ArenaPickCode, number> | null => {
  const home = normalizeProbability(value?.home);
  const draw = normalizeProbability(value?.draw);
  const away = normalizeProbability(value?.away);
  if (home === null || draw === null || away === null) return null;
  const total = home + draw + away;
  if (!(total > 0)) return null;
  return {
    '1': home / total,
    X: draw / total,
    '2': away / total,
  };
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
  const inverse = {
    '1': 1 / odds['1'],
    X: 1 / odds.X,
    '2': 1 / odds['2'],
  };
  const total = inverse['1'] + inverse.X + inverse['2'];
  return {
    '1': inverse['1'] / total,
    X: inverse.X / total,
    '2': inverse['2'] / total,
  };
};

const leader = (scores: Record<ArenaPickCode, number>, allowed = CODES): ArenaPickCode => (
  [...allowed].sort((left, right) => scores[right] - scores[left])[0] || 'X'
);

const shanghaiDateKey = (value: Date | number | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
};

const matchBusinessDate = (match: Match): string => (
  String(match.businessDate || match.matchDate || match.kickoffDate || '').slice(0, 10)
  || shanghaiDateKey(match.kickoffTime)
);

const confirmedHadSingle = (match: Match): boolean => (
  match.externalSignals?.fiveHundred?.sale?.availability?.spfdg === true
);

const riskFor = (pickedProbability: number, gap: number, odds: number): ArenaRisk => {
  if (pickedProbability >= 0.5 && gap >= 0.1 && odds <= 2.35) return 'low';
  if (pickedProbability < 0.34 || gap < 0.04 || odds >= 3.8) return 'high';
  return 'medium';
};

const analyst = (
  input: Omit<ArenaAnalyst, 'probability' | 'confidence' | 'risk' | 'stake' | 'startingBalance'> & {
    probabilities: Record<ArenaPickCode, number>;
    odds: Record<ArenaPickCode, number>;
    stakeRate: number;
  },
): ArenaAnalyst => {
  const pickedProbability = input.probabilities[input.pick];
  const ordered = CODES.map((code) => input.probabilities[code]).sort((a, b) => b - a);
  const gap = Math.max(0, pickedProbability - (ordered.find((value) => value < pickedProbability) ?? ordered[1] ?? 0));
  const risk = riskFor(pickedProbability, gap, input.odds[input.pick]);
  const confidence = Math.round(clamp(48 + pickedProbability * 42 + gap * 45 - (risk === 'high' ? 8 : 0), 50, 92));
  return {
    id: input.id,
    nameZh: input.nameZh,
    nameEn: input.nameEn,
    styleZh: input.styleZh,
    styleEn: input.styleEn,
    pick: input.pick,
    probability: pickedProbability,
    confidence,
    risk,
    startingBalance: STARTING_BALANCE,
    stake: Math.round(STARTING_BALANCE * input.stakeRate),
    reasonsZh: input.reasonsZh,
    reasonsEn: input.reasonsEn,
  };
};

const buildAnalysts = (
  probabilities: Record<ArenaPickCode, number>,
  market: Record<ArenaPickCode, number>,
  odds: Record<ArenaPickCode, number>,
): ArenaAnalyst[] => {
  const modelPick = leader(probabilities);
  const marketPick = leader(market);
  const valueScores = Object.fromEntries(CODES.map((code) => [code, probabilities[code] * odds[code]])) as Record<ArenaPickCode, number>;
  const valuePick = leader(valueScores);
  const safetyScores = Object.fromEntries(CODES.map((code) => [code, probabilities[code] - Math.max(0, odds[code] - 2.2) * 0.035])) as Record<ArenaPickCode, number>;
  const safetyPick = leader(safetyScores);
  const nonMarket = CODES.filter((code) => code !== marketPick);
  const reviewPick = valueScores[leader(valueScores, nonMarket)] >= valueScores[modelPick] * 1.04
    ? leader(valueScores, nonMarket)
    : modelPick;
  const balancedScores = Object.fromEntries(CODES.map((code) => [code, probabilities[code] * 0.72 + market[code] * 0.28])) as Record<ArenaPickCode, number>;
  const balancedPick = leader(balancedScores);

  return [
    analyst({ id: 'core', nameZh: '核心概率', nameEn: 'Core Probability', styleZh: '模型派', styleEn: 'Model', pick: modelPick, probabilities, odds, stakeRate: 0.12, reasonsZh: ['采用当前统一概率最高方向', '不使用赛后数据'], reasonsEn: ['Uses the current highest unified probability', 'No post-match data'], }),
    analyst({ id: 'steady', nameZh: '稳健风控', nameEn: 'Steady Control', styleZh: '稳健', styleEn: 'Steady', pick: safetyPick, probabilities, odds, stakeRate: 0.08, reasonsZh: ['降低高赔率尾部风险', '优先概率稳定性'], reasonsEn: ['Reduces long-price tail risk', 'Prioritizes probability stability'], }),
    analyst({ id: 'balanced', nameZh: '均衡判断', nameEn: 'Balanced Read', styleZh: '均衡', styleEn: 'Balanced', pick: balancedPick, probabilities, odds, stakeRate: 0.1, reasonsZh: ['模型概率与去水市场交叉校验', '控制单一信号偏差'], reasonsEn: ['Blends model and devigged market', 'Limits single-signal bias'], }),
    analyst({ id: 'value', nameZh: '价值发现', nameEn: 'Value Finder', styleZh: '进取', styleEn: 'Active', pick: valuePick, probabilities, odds, stakeRate: 0.18, reasonsZh: ['比较概率与官方 SP 的乘积', '仓位较高且波动更大'], reasonsEn: ['Compares probability against official SP', 'Higher simulated stake and variance'], }),
    analyst({ id: 'market', nameZh: '市场校验', nameEn: 'Market Check', styleZh: '赔率派', styleEn: 'Market', pick: marketPick, probabilities, odds, stakeRate: 0.09, reasonsZh: ['跟随官方 SP 去水后的市场首选', '用于检验模型是否偏离共识'], reasonsEn: ['Follows the devigged official market leader', 'Checks model divergence from consensus'], }),
    analyst({ id: 'review', nameZh: '反热门审查', nameEn: 'Contrarian Review', styleZh: '审查', styleEn: 'Review', pick: reviewPick, probabilities, odds, stakeRate: 0.06, reasonsZh: ['只有次选价值显著更高才反向', '默认不为制造分歧而分歧'], reasonsEn: ['Opposes only for materially stronger secondary value', 'Does not force disagreement'], }),
  ];
};

const candidateScore = (
  match: Match,
  probabilities: Record<ArenaPickCode, number>,
  market: Record<ArenaPickCode, number>,
): number => {
  const ordered = CODES.map((code) => probabilities[code]).sort((a, b) => b - a);
  const probabilityGap = Math.max(0, ordered[0] - ordered[1]);
  const modelPick = leader(probabilities);
  const marketGap = Math.abs(probabilities[modelPick] - market[modelPick]);
  const historyFamilies = [
    Number(match.probabilityModel?.elo?.homeMatches || 0) + Number(match.probabilityModel?.elo?.awayMatches || 0) >= 12,
    Number(match.probabilityModel?.form?.sampleSize || 0) >= 6,
    Number(match.probabilityModel?.leaguePrior?.matches || 0) >= 30,
  ].filter(Boolean).length;
  const completeness = historyFamilies / 3;
  return Math.round(clamp(
    48 + ordered[0] * 22 + probabilityGap * 70 + marketGap * 35 + completeness * 12,
    50,
    95,
  ));
};

export const todayShanghaiDateKey = (): string => shanghaiDateKey(Date.now());

export const buildDailyArenaSelection = (
  matches: Match[],
  dateKey = todayShanghaiDateKey(),
  nowMs = Date.now(),
): DailyArenaSelection | null => {
  const candidates = matches.flatMap((match) => {
    if (match.status !== 'SCHEDULED' || matchBusinessDate(match) !== dateKey) return [];
    if (!confirmedHadSingle(match)) return [];
    const kickoffMs = Date.parse(match.kickoffTime);
    if (!Number.isFinite(kickoffMs) || kickoffMs <= nowMs) return [];
    const odds = officialHadOdds(match);
    const probabilities = outcomeTriplet(match.probabilityModel?.oneXTwo?.final);
    if (!odds || !probabilities) return [];
    const market = devig(odds);
    return [{ match, odds, probabilities, market, score: candidateScore(match, probabilities, market) }];
  }).sort((left, right) => (
    right.score - left.score
    || Date.parse(left.match.kickoffTime) - Date.parse(right.match.kickoffTime)
    || left.match.id.localeCompare(right.match.id)
  ));

  const selected = candidates[0];
  if (!selected) return null;
  const analysts = buildAnalysts(selected.probabilities, selected.market, selected.odds);
  const voteCounts = Object.fromEntries(CODES.map((code) => [code, analysts.filter((row) => row.pick === code).length])) as Record<ArenaPickCode, number>;
  const consensusCode = leader(voteCounts);
  const homeScore = finiteNonNegative(selected.match.projectedScoreHome);
  const awayScore = finiteNonNegative(selected.match.projectedScoreAway);

  return {
    version: 'ai-single-match-arena-preview-v1',
    dateKey,
    match: selected.match,
    aiScore: selected.score,
    probabilities: selected.probabilities,
    marketProbabilities: selected.market,
    odds: selected.odds,
    analysts,
    consensus: {
      code: consensusCode,
      votes: voteCounts[consensusCode],
      total: analysts.length,
    },
    projectedScore: homeScore !== null && awayScore !== null
      ? `${Math.round(homeScore)}-${Math.round(awayScore)}`
      : null,
    disclosure: 'strategy-simulation',
  };
};

export const arenaPickLabel = (code: ArenaPickCode, language: 'zh' | 'en'): string => {
  if (language === 'en') return code === '1' ? 'Home win' : code === '2' ? 'Away win' : 'Draw';
  return code === '1' ? '主胜' : code === '2' ? '客胜' : '平局';
};
