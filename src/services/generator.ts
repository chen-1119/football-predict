import type { Match, PredictionDetail } from './mockData';
import { getVisiblePredictions, isPredictionMarketEnabled } from './predictionVisibility';

export interface GeneratorParams {
  targetOdds: number; // 目标总SP
  matchCount: 'auto' | 2 | 5 | 10 | 15; // 比赛数量
  marketTypes: string[]; // ['1X2', 'GOALS', 'BEST']
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

const buildOfficialOddsFallback = (
  match: Match,
  minOdds: number,
  maxOdds: number,
  minTrust: number
): SelectionResult | null => {
  if (!match.odds) return null;

  const outcomes = [
    { code: '1', odds: match.odds.odds1 },
    { code: 'X', odds: match.odds.oddsX },
    { code: '2', odds: match.odds.odds2 }
  ].filter((outcome) => Number.isFinite(outcome.odds) && outcome.odds > 0);

  if (outcomes.length === 0) return null;

  const impliedTotal = outcomes.reduce((sum, outcome) => sum + (1 / outcome.odds), 0);
  const best = outcomes
    .filter((outcome) => outcome.odds >= minOdds && outcome.odds <= maxOdds)
    .sort((a, b) => a.odds - b.odds)[0];

  if (!best || impliedTotal <= 0) return null;

  const marketSupport = Math.round((1 / best.odds / impliedTotal) * 100);
  const trustScore = Math.min(58, Math.max(35, marketSupport));
  if (trustScore < minTrust) return null;

  const label = officialPickLabels[best.code] || { zh: best.code, en: best.code };

  return {
    match,
    prediction: {
      marketType: '1X2',
      tipCode: best.code,
      tipLabel: label,
      odds: best.odds,
      trustScore,
      explanation: {
        zh: `模型暂无强推方向，按官方 SP 领先项生成观察参考：${label.zh}，需结合临场变化复核。`,
        en: `No strong model pick is available. This is an official-SP fallback watch reference: ${label.en}. Recheck late movement.`
      },
      analysisItems: [
        { zh: '官方 SP 领先项', en: 'Official SP leading outcome' },
        { zh: '模型观察兜底，不作为强推', en: 'Watch-only fallback, not a strong pick' }
      ],
      riskTags: [
        { zh: '仅供参考', en: 'Reference only' },
        { zh: '需临场复核', en: 'Needs late review' }
      ],
      visibilityStatus: 'FREE',
      resultStatus: 'PENDING'
    }
  };
};

// 模拟串关生成算法
export function generateBetSlip(params: GeneratorParams, matches: Match[]): BetSlipResult {
  const {
    matchCount,
    marketTypes,
    minOdds,
    maxOdds,
    timeWindow,
    onlyImportantLeagues
  } = params;
  let { targetOdds, minTrust } = params;
  const enabledMarketTypes = marketTypes.filter((marketType) => (
    isPredictionMarketEnabled(marketType as PredictionDetail['marketType'])
  ));

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
      if (!enabledMarketTypes.includes(p.marketType)) return;
      if (p.tipCode === 'WATCH' || p.odds <= 0) return;
      // 筛选 SP 范围
      if (p.odds < minOdds || p.odds > maxOdds) return;
      // 筛选可信度
      if (p.trustScore < minTrust) return;
      candidateSelections.push({
        match: m,
        prediction: p
      });
    });
  });

  if (candidateSelections.length === 0 && enabledMarketTypes.some((marketType) => marketType === '1X2' || marketType === 'BEST')) {
    candidateMatches.forEach((match) => {
      const fallbackSelection = buildOfficialOddsFallback(match, minOdds, maxOdds, minTrust);
      if (fallbackSelection) candidateSelections.push(fallbackSelection);
    });
  }

  if (candidateSelections.length === 0) {
    return {
      selections: [],
      totalOdds: 1,
      averageTrust: 0,
      isSuccess: false,
      message: {
        zh: '未找到符合当前筛选条件的比赛预测。请放宽 SP 或可信度限制再试。',
        en: 'No predictions matching your criteria were found. Please loosen the odds or confidence limits.'
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

  let bestCombination: SelectionResult[] = [];
  let bestDiff = Infinity;
  let bestOdds = 0;

  // 随机尝试 300 次以找到最佳匹配（避免局部最优，保证生成的多样性）
  for (let i = 0; i < 300; i++) {
    // 随机打乱候选集
    const shuffled = [...candidateSelections].sort(() => Math.random() - 0.5);
    const tempSelections: SelectionResult[] = [];
    const usedMatchIds = new Set<string>();
    let currentOdds = 1;

    for (const sel of shuffled) {
      if (usedMatchIds.has(sel.match.id)) continue;
      
      // 如果加进去后，SP 是否会过高？
      // 除非还没达到最小数量，否则如果 SP 已经超过目标总SP太多，就跳过
      const nextOdds = currentOdds * sel.prediction.odds;
      if (tempSelections.length >= targetCountMax && nextOdds > targetOdds) {
        break;
      }

      tempSelections.push(sel);
      usedMatchIds.add(sel.match.id);
      currentOdds = nextOdds;

      // 如果数量达到了要求
      if (tempSelections.length >= targetCountMin) {
        const diff = Math.abs(currentOdds - targetOdds);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestCombination = [...tempSelections];
          bestOdds = currentOdds;
        }
        // 如果 SP 已经非常接近，可以提前退出
        if (diff < 0.1) break;
      }
    }
  }

  if (bestCombination.length < targetCountMin) {
    // 如果无法凑齐数量，直接用当前 SP 最接近的一组
    // 或者返回错误
    return {
      selections: [],
      totalOdds: 1,
      averageTrust: 0,
      isSuccess: false,
      message: {
        zh: '匹配不到合适数量的串关组合，请调整目标总SP或增加比赛窗口。',
        en: 'Could not match a slip with enough selections. Please adjust target odds or increase time window.'
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
