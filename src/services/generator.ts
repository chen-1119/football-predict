import type { Match, PredictionDetail } from './mockData';
import { getResolvedMatchOdds, normalizeOdds } from './bettingDisplay';
import { getVisiblePredictions } from './predictionVisibility';

export type BetSlipMarketType = '1X2' | 'HHAD' | 'GOALS' | 'BEST';

export interface GeneratorParams {
  targetOdds: number; // 目标总SP
  matchCount: 'auto' | 2 | 5 | 10 | 15; // 比赛数量
  marketTypes: string[]; // ['1X2', 'HHAD', 'GOALS', 'BEST']
  minOdds: number;
  maxOdds: number;
  timeWindow: '1' | '2' | '3'; // 未来几天天数
  minTrust: number; // 最低可信度
  onlyImportantLeagues: boolean;
  onlyOddsDropping: boolean;
}

export interface SelectionResult {
  match: Match;
  prediction: PredictionDetail;
  generatedFrom?: 'model' | 'official-odds' | 'existing-prediction';
}

export interface BetSlipResult {
  selections: SelectionResult[];
  totalOdds: number;
  averageTrust: number;
  isSuccess: boolean;
  message: { zh: string; en: string };
}

const officialPickLabels: Record<string, { zh: string; en: string }> = {
  '1': { zh: '胜', en: 'Home win' },
  X: { zh: '平', en: 'Draw' },
  '2': { zh: '负', en: 'Away win' }
};

const officialHandicapPickLabels: Record<string, { zh: string; en: string }> = {
  '1': { zh: '让球主胜', en: 'Handicap home win' },
  X: { zh: '让球平', en: 'Handicap draw' },
  '2': { zh: '让球客胜', en: 'Handicap away win' }
};

const isBetSlipMarketType = (marketType: string): marketType is BetSlipMarketType => (
  marketType === '1X2' || marketType === 'HHAD' || marketType === 'GOALS' || marketType === 'BEST'
);

const selectionMarketKey = (prediction: PredictionDetail): BetSlipMarketType => {
  if ((prediction.marketType === '1X2' || prediction.marketType === 'BEST') && prediction.oddsPoolCode === 'HHAD') {
    return 'HHAD';
  }

  return prediction.marketType === 'GG_NG' ? 'GOALS' : prediction.marketType;
};

const probabilityForCode = (
  probabilities: { home: number; draw: number; away: number } | null | undefined,
  code: string
) => {
  if (!probabilities) return null;
  if (code === '1') return probabilities.home;
  if (code === 'X') return probabilities.draw;
  if (code === '2') return probabilities.away;
  return null;
};

const outcomeEntries = (probabilities: { home: number; draw: number; away: number } | null | undefined) => {
  if (!probabilities) return [];
  return [
    { code: '1', probability: Number(probabilities.home) },
    { code: 'X', probability: Number(probabilities.draw) },
    { code: '2', probability: Number(probabilities.away) }
  ].filter((item) => Number.isFinite(item.probability));
};

const impliedProbabilities = (odds: { odds1: number; oddsX: number; odds2: number }) => {
  const home = 1 / odds.odds1;
  const draw = 1 / odds.oddsX;
  const away = 1 / odds.odds2;
  const total = home + draw + away || 1;
  return {
    home: (home / total) * 100,
    draw: (draw / total) * 100,
    away: (away / total) * 100
  };
};

const probabilityGap = (entries: Array<{ probability: number }>) => {
  const sorted = entries
    .map((item) => Number(item.probability))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  return sorted.length >= 2 ? sorted[0] - sorted[1] : 0;
};

const clampTrust = (value: number) => Math.min(88, Math.max(35, Math.round(value)));

const fairModelOdds = (probabilityPercent: number) => {
  const probability = Math.min(86, Math.max(18, probabilityPercent)) / 100;
  return Number((1 / probability).toFixed(2));
};

const getOfficialPickCandidates = (
  match: Match,
  pool: 'HAD' | 'HHAD',
  minOdds: number,
  maxOdds: number
): SelectionResult[] => {
  const resolved = getResolvedMatchOdds(match);
  const resolvedPool = pool === 'HAD' ? resolved.had : resolved.hhad;
  const odds = normalizeOdds(resolvedPool?.odds);
  if (!odds) return [];

  const marketProbabilities = impliedProbabilities(odds);
  const modelProbabilities = pool === 'HAD'
    ? (match.probabilityModel?.oneXTwo?.final || match.probabilityModel?.oneXTwo?.market)
    : (match.probabilityModel?.handicap?.market || match.probabilityModel?.handicap?.poisson);
  const modelEntries = outcomeEntries(modelProbabilities);
  const marketEntries = outcomeEntries(marketProbabilities);
  const sourceEntries = modelEntries.length ? modelEntries : marketEntries;
  const gap = probabilityGap(sourceEntries);
  const labels = pool === 'HAD' ? officialPickLabels : officialHandicapPickLabels;
  const explanationPrefix = pool === 'HAD'
    ? {
        zh: '按官方胜平负 SP 与模型概率生成候选方向',
        en: 'Candidate generated from official 1X2 SP and model probability'
      }
    : {
        zh: '按官方让球胜平负 SP 与让球概率生成候选方向',
        en: 'Candidate generated from official handicap 1X2 SP and handicap probability'
      };

  const outcomes = [
    { code: '1', odds: odds.odds1 },
    { code: 'X', odds: odds.oddsX },
    { code: '2', odds: odds.odds2 }
  ]
    .filter((outcome) => Number.isFinite(outcome.odds) && outcome.odds >= minOdds && outcome.odds <= maxOdds)
    .map((outcome) => {
      const modelProbability = probabilityForCode(modelProbabilities, outcome.code);
      const marketProbability = probabilityForCode(marketProbabilities, outcome.code) || 0;
      const selectedProbability = Number.isFinite(modelProbability) ? Number(modelProbability) : marketProbability;
      const isLeader = sourceEntries[0]?.code === outcome.code;
      const trustScore = clampTrust(
        selectedProbability
        + (isLeader ? 8 : -8)
        + Math.min(10, Math.max(0, gap - 3))
        - (outcome.code === 'X' ? 4 : 0)
      );
      const label = labels[outcome.code] || { zh: outcome.code, en: outcome.code };

      const selection: SelectionResult = {
        match,
        generatedFrom: 'official-odds',
        prediction: {
          marketType: '1X2' as const,
          oddsPoolCode: pool,
          handicapLine: pool === 'HHAD' ? resolved.hhad?.handicap || match.handicapLine : undefined,
          tipCode: outcome.code,
          tipLabel: label,
          odds: outcome.odds,
          trustScore,
          explanation: {
            zh: `${explanationPrefix.zh}：${label.zh}，SP ${outcome.odds.toFixed(2)}，概率约 ${Math.round(selectedProbability)}%。`,
            en: `${explanationPrefix.en}: ${label.en}, odds ${outcome.odds.toFixed(2)}, probability around ${Math.round(selectedProbability)}%.`
          },
          analysisItems: [
            pool === 'HAD'
              ? { zh: '官方胜平负已开售', en: 'Official 1X2 is on sale' }
              : { zh: '官方让球胜平负已开售', en: 'Official handicap 1X2 is on sale' },
            modelEntries.length
              ? { zh: '模型概率参与筛选', en: 'Model probability included in ranking' }
              : { zh: '模型概率不足时使用官方去水概率', en: 'Official de-vig probability used when model signal is limited' }
          ],
          riskTags: [
            { zh: '仅供赛前参考', en: 'Pre-match reference only' },
            ...(isLeader ? [] : [{ zh: '非第一概率方向', en: 'Not the top probability lane' }])
          ],
          visibilityStatus: 'FREE',
          resultStatus: 'PENDING'
        }
      };
      return selection;
    })
    .sort((a, b) => {
      const trustDiff = b.prediction.trustScore - a.prediction.trustScore;
      if (Math.abs(trustDiff) > 0) return trustDiff;
      return a.prediction.odds - b.prediction.odds;
    });

  return outcomes;
};

const getGoalsCandidates = (
  match: Match,
  minOdds: number,
  maxOdds: number
): SelectionResult[] => {
  const goalLines = match.probabilityModel?.goalLines;
  if (!goalLines || !Number.isFinite(goalLines.over25) || !Number.isFinite(goalLines.under25)) return [];

  const over25 = Number(goalLines.over25);
  const under25 = Number(goalLines.under25);
  const isOver = over25 >= under25;
  const probability = isOver ? over25 : under25;
  const odds = fairModelOdds(probability);
  if (odds < minOdds || odds > maxOdds) return [];

  const trustScore = clampTrust(probability + Math.max(0, Math.abs(over25 - under25) - 3) * 0.9);
  const tipCode = isOver ? 'O2.5' : 'U2.5';
  const tipLabel = isOver
    ? { zh: '大2.5球', en: 'Over 2.5 goals' }
    : { zh: '小2.5球', en: 'Under 2.5 goals' };

  return [{
    match,
    generatedFrom: 'model',
    prediction: {
      marketType: 'GOALS',
      tipCode,
      tipLabel,
      odds,
      trustScore,
      explanation: {
        zh: `进球模型倾向${tipLabel.zh}，概率约 ${Math.round(probability)}%；该值为模型参考值，不是官方总进球 SP。`,
        en: `The goal model leans ${tipLabel.en} at about ${Math.round(probability)}%; this is a model reference value, not official total-goals odds.`
      },
      analysisItems: [
        { zh: '由比分分布与大小球概率派生', en: 'Derived from score distribution and goal-line probabilities' },
        { zh: '用于串关参考，不替代官方盘口', en: 'Accumulator reference, not a replacement for official markets' }
      ],
      riskTags: [
        { zh: '模型参考值', en: 'Model reference value' },
        { zh: '需临场复核', en: 'Needs late review' }
      ],
      visibilityStatus: 'FREE',
      resultStatus: 'PENDING'
    }
  }];
};

const dedupeSelections = (selections: SelectionResult[]) => {
  const byKey = new Map<string, SelectionResult>();
  for (const selection of selections) {
    const key = [
      selection.match.id,
      selection.prediction.marketType,
      selection.prediction.oddsPoolCode || '',
      selection.prediction.tipCode
    ].join(':');
    const existing = byKey.get(key);
    if (!existing || selection.prediction.trustScore > existing.prediction.trustScore) {
      byKey.set(key, selection);
    }
  }

  return Array.from(byKey.values());
};

const selectionScore = (selection: SelectionResult) => {
  const sourceBoost = selection.generatedFrom === 'existing-prediction'
    ? 6
    : selection.generatedFrom === 'official-odds'
      ? 3
      : 0;
  const marketBoost = selection.prediction.oddsPoolCode === 'HHAD' ? 2 : selection.prediction.marketType === 'GOALS' ? -1 : 0;
  return selection.prediction.trustScore + sourceBoost + marketBoost;
};

const sortSelections = (a: SelectionResult, b: SelectionResult) => {
  const scoreDiff = selectionScore(b) - selectionScore(a);
  if (Math.abs(scoreDiff) > 0) return scoreDiff;
  const timeDiff = Date.parse(a.match.kickoffTime) - Date.parse(b.match.kickoffTime);
  if (Math.abs(timeDiff) > 0) return timeDiff;
  return a.prediction.odds - b.prediction.odds;
};

const rankCombination = (
  selections: SelectionResult[],
  targetOdds: number,
  targetCountMin: number,
  targetCountMax: number
) => {
  const totalOdds = selections.reduce((product, selection) => product * selection.prediction.odds, 1);
  const averageTrust = selections.length
    ? selections.reduce((sum, selection) => sum + selection.prediction.trustScore, 0) / selections.length
    : 0;
  const countPenalty = selections.length < targetCountMin
    ? (targetCountMin - selections.length) * targetOdds
    : selections.length > targetCountMax
      ? (selections.length - targetCountMax) * targetOdds
      : 0;
  return {
    totalOdds,
    averageTrust,
    value: Math.abs(totalOdds - targetOdds) + countPenalty - averageTrust / 1000
  };
};

const findBestCombination = (
  candidateSelections: SelectionResult[],
  targetOdds: number,
  targetCountMin: number,
  targetCountMax: number
) => {
  const byMatch = new Map<string, SelectionResult[]>();
  for (const selection of candidateSelections.sort(sortSelections)) {
    const rows = byMatch.get(selection.match.id) || [];
    rows.push(selection);
    byMatch.set(selection.match.id, rows.slice(0, 4));
  }

  const groups = Array.from(byMatch.values())
    .sort((a, b) => sortSelections(a[0], b[0]))
    .slice(0, 80);
  let beam: SelectionResult[][] = [[]];
  let best: SelectionResult[] = [];
  let bestRank = { totalOdds: 0, averageTrust: 0, value: Infinity };
  const beamLimit = 900;

  const consider = (combination: SelectionResult[]) => {
    if (combination.length < targetCountMin || combination.length > targetCountMax) return;
    const rank = rankCombination(combination, targetOdds, targetCountMin, targetCountMax);
    if (
      rank.value < bestRank.value
      || (Math.abs(rank.value - bestRank.value) < 0.0001 && rank.averageTrust > bestRank.averageTrust)
    ) {
      best = combination;
      bestRank = rank;
    }
  };

  for (const group of groups) {
    const nextBeam: SelectionResult[][] = [...beam];
    for (const combination of beam) {
      for (const selection of group) {
        if (combination.length >= targetCountMax) continue;
        const next = [...combination, selection];
        const nextOdds = next.reduce((product, item) => product * item.prediction.odds, 1);
        if (next.length >= targetCountMin && nextOdds > targetOdds * 2.8) continue;
        consider(next);
        nextBeam.push(next);
      }
    }
    beam = nextBeam
      .sort((a, b) => {
        const rankA = rankCombination(a, targetOdds, targetCountMin, targetCountMax);
        const rankB = rankCombination(b, targetOdds, targetCountMin, targetCountMax);
        return rankA.value - rankB.value;
      })
      .slice(0, beamLimit);
  }

  return { selections: best, totalOdds: bestRank.totalOdds };
};

// 串关参考生成算法：先构建可投注/可参考候选，再用确定性组合搜索贴近目标总值。
export function generateBetSlip(params: GeneratorParams, matches: Match[]): BetSlipResult {
  const {
    matchCount,
    marketTypes,
    minOdds,
    maxOdds,
    timeWindow,
    onlyImportantLeagues
  } = params;
  const { targetOdds, minTrust } = params;
  const enabledMarketTypes = marketTypes.filter(isBetSlipMarketType);
  const includesMarket = (marketType: BetSlipMarketType) => enabledMarketTypes.includes(marketType);

  // 1. 筛选比赛范围：未来 timeWindow 天内的未开始比赛
  const now = new Date();
  const maxTime = new Date();
  maxTime.setDate(now.getDate() + parseInt(timeWindow));

  const candidateMatches = matches.filter(m => {
    if (m.status !== 'SCHEDULED') return false;
    const kickoff = new Date(m.kickoffTime);
    if (kickoff < now || kickoff > maxTime) return false;
    if (onlyImportantLeagues && m.leagueId === 'non-important') return false; // 我们目前所有mock联赛都设为 important
    return true;
  });

  // 2. 筛选预测池
  const candidateSelections: SelectionResult[] = [];
  candidateMatches.forEach(m => {
    getVisiblePredictions(m).forEach(p => {
      // 筛选市场类型
      const marketKey = selectionMarketKey(p);
      if (!includesMarket(marketKey) && !(p.marketType === 'BEST' && includesMarket('BEST'))) return;
      if (p.tipCode === 'WATCH' || p.odds <= 0) return;
      // 筛选 SP 范围
      if (p.odds < minOdds || p.odds > maxOdds) return;
      // 筛选可信度
      if (p.trustScore < minTrust) return;
      candidateSelections.push({
        match: m,
        prediction: p,
        generatedFrom: 'existing-prediction'
      });
    });

    if (includesMarket('1X2') || includesMarket('BEST')) {
      candidateSelections.push(...getOfficialPickCandidates(m, 'HAD', minOdds, maxOdds));
    }

    if (includesMarket('HHAD') || includesMarket('BEST')) {
      candidateSelections.push(...getOfficialPickCandidates(m, 'HHAD', minOdds, maxOdds));
    }

    if (includesMarket('GOALS') || includesMarket('BEST')) {
      candidateSelections.push(...getGoalsCandidates(m, minOdds, maxOdds));
    }
  });

  const filteredSelections = dedupeSelections(candidateSelections)
    .filter((selection) => selection.prediction.trustScore >= minTrust)
    .sort(sortSelections);

  if (filteredSelections.length === 0) {
    const hasOfficialOdds = candidateMatches.some((match) => {
      const resolved = getResolvedMatchOdds(match);
      return Boolean(resolved.had?.odds || resolved.hhad?.odds);
    });
    const hasGoalModel = candidateMatches.some((match) => match.probabilityModel?.goalLines);
    const zhReason = candidateMatches.length === 0
      ? '未来时间窗口内没有可用未开赛比赛。'
      : hasOfficialOdds || hasGoalModel
        ? '当前窗口内有赛程，但盘口/进球模型未达到你设置的 SP 或可信度要求。'
        : '当前窗口内有赛程，但胜平负、让球和进球模型还没有可用于串关的赔率或概率。';
    const enReason = candidateMatches.length === 0
      ? 'There are no scheduled matches in the selected time window.'
      : hasOfficialOdds || hasGoalModel
        ? 'Matches exist, but the available odds/model values do not pass your odds or confidence filters.'
        : 'Matches exist, but 1X2, handicap, and goal-model candidates are not available yet.';
    return {
      selections: [],
      totalOdds: 1,
      averageTrust: 0,
      isSuccess: false,
      message: {
        zh: `${zhReason} 请放宽 SP、可信度，或把时间窗口扩到明后天再试。`,
        en: `${enReason} Please loosen odds/confidence filters or extend the time window.`
      }
    };
  }

  // 3. 开始匹配组合。目标是找到一组 Selection，其乘积（总SP）尽可能接近 targetOdds，且没有重复的 matchId。
  // 我们使用贪心法结合随机微调来寻找最佳组合。
  
  // 决定最终要挑选的比赛数量范围
  const [targetCountMin, targetCountMax] = matchCount === 'auto'
    ? targetOdds <= 3
      ? [1, 3]
      : targetOdds <= 8
        ? [3, 5]
        : [4, 8]
    : [matchCount, matchCount];

  const search = findBestCombination(filteredSelections, targetOdds, targetCountMin, targetCountMax);
  const bestCombination = search.selections;
  const bestOdds = search.totalOdds;

  if (bestCombination.length < targetCountMin) {
    // 如果无法凑齐数量，直接用当前 SP 最接近的一组
    // 或者返回错误
    return {
      selections: [],
      totalOdds: 1,
      averageTrust: 0,
      isSuccess: false,
      message: {
        zh: `当前只有 ${filteredSelections.length} 个候选方向通过筛选，匹配不到合适数量的串关组合。请降低比赛数量、放宽 SP/可信度，或增加比赛窗口。`,
        en: `Only ${filteredSelections.length} candidate selections passed filters. Lower the count, loosen odds/confidence, or extend the time window.`
      }
    };
  }

  const averageTrust = Math.round(
    bestCombination.reduce((sum, s) => sum + s.prediction.trustScore, 0) / bestCombination.length
  );

  return {
    selections: bestCombination,
    totalOdds: parseFloat(bestOdds.toFixed(2)),
    averageTrust,
    isSuccess: true,
    message: {
      zh: 'AI 参考组合生成成功！',
      en: 'AI reference combo generated successfully!'
    }
  };
}
