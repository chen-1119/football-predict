import type { Match, MultiLangString } from './mockData';

export type MatchSignalCategory = 'steady' | 'watch' | 'avoid' | 'unavailable';

export interface MatchSignal {
  category: MatchSignalCategory;
  label: MultiLangString;
  note: MultiLangString;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  trustScore: number;
  riskCount: number;
}

const labels: Record<MatchSignalCategory, MultiLangString> = {
  steady: { zh: '稳胆候选', en: 'Steady' },
  watch: { zh: '观察', en: 'Watch' },
  avoid: { zh: '避坑', en: 'Avoid' },
  unavailable: { zh: '待开售', en: 'Pending' }
};

const hasRisk = (riskNames: string[], keyword: string) => {
  return riskNames.some((name) => name.includes(keyword));
};

export function getMatchSignal(match: Match): MatchSignal {
  const best = match.predictions.find((prediction) => prediction.marketType === 'BEST');

  if (!best) {
    return {
      category: 'unavailable',
      label: labels.unavailable,
      note: {
        zh: '普通胜平负暂未开售，先看官方让球盘。',
        en: 'Standard 1X2 is not on sale yet. Check official handicap odds first.'
      },
      tone: 'muted',
      trustScore: 0,
      riskCount: 0
    };
  }

  const riskTags = best.riskTags || [];
  const riskNames = riskTags.map((tag) => tag.zh);
  const trustScore = best.trustScore || 0;
  const trendIsMixed = match.oddsTrend?.direction === 'mixed';
  const hasDrawRisk = hasRisk(riskNames, '防平');
  const hasWeakHandicap = hasRisk(riskNames, '让球支持不足');
  const hasOverheated = hasRisk(riskNames, '热门过热');

  if ((hasDrawRisk && hasWeakHandicap) || (trendIsMixed && trustScore < 82) || (riskTags.length >= 3 && trustScore < 86)) {
    return {
      category: 'avoid',
      label: labels.avoid,
      note: {
        zh: '风险标签叠加，建议降低优先级或等待临场 SP。',
        en: 'Multiple risk tags overlap. Lower priority or wait for late SP.'
      },
      tone: 'danger',
      trustScore,
      riskCount: riskTags.length
    };
  }

  if (trustScore >= 84 && riskTags.length <= 1 && !trendIsMixed && !hasOverheated) {
    return {
      category: 'steady',
      label: labels.steady,
      note: {
        zh: '官方 SP、模型可信度和风险标签相对一致。',
        en: 'Official SP, model confidence, and risk tags are aligned.'
      },
      tone: 'success',
      trustScore,
      riskCount: riskTags.length
    };
  }

  return {
    category: 'watch',
    label: labels.watch,
    note: {
      zh: '有明确倾向，但仍存在风险标签或 SP 走势待观察。',
      en: 'There is a lean, but risk tags or SP movement still need monitoring.'
    },
    tone: 'warning',
    trustScore,
    riskCount: riskTags.length
  };
}
