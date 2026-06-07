import type { Match, MultiLangString } from './mockData';

export type MatchSignalCategory = 'steady' | 'lean' | 'watch' | 'avoid' | 'unavailable' | 'finished';

export interface MatchSignal {
  category: MatchSignalCategory;
  label: MultiLangString;
  note: MultiLangString;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  trustScore: number;
  riskCount: number;
}

const labels: Record<MatchSignalCategory, MultiLangString> = {
  steady: { zh: '高可信候选', en: 'High confidence' },
  lean: { zh: '主推候选', en: 'Model lean' },
  watch: { zh: '观察', en: 'Watch' },
  avoid: { zh: '避坑', en: 'Avoid' },
  unavailable: { zh: '待开售', en: 'Pending' },
  finished: { zh: '已完场', en: 'Finished' }
};

const hasRisk = (riskNames: string[], keyword: string) => {
  return riskNames.some((name) => name.includes(keyword));
};

const pickProbability = (match: Match, tipCode: string) => {
  const final = match.probabilityModel?.oneXTwo.final;
  if (!final) return null;
  const value = tipCode === '1'
    ? final.home
    : tipCode === 'X'
      ? final.draw
      : tipCode === '2'
        ? final.away
        : null;
  return Number.isFinite(value) ? Number(value) : null;
};

const finalProbabilityGap = (match: Match) => {
  const final = match.probabilityModel?.oneXTwo.final;
  if (!final) return null;
  const values = [final.home, final.draw, final.away].filter(Number.isFinite).map(Number).sort((a, b) => b - a);
  if (values.length < 2) return null;
  return values[0] - values[1];
};

export function getMatchSignal(match: Match): MatchSignal {
  if (match.status === 'FINISHED') {
    return {
      category: 'finished',
      label: labels.finished,
      note: {
        zh: '本场已完场，当前只保留赛果、历史复盘与已生成的赛前预测记录。',
        en: 'This match is finished. Keep the result, review data, and any pre-match prediction record.'
      },
      tone: 'muted',
      trustScore: 0,
      riskCount: 0
    };
  }

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

  if (best.tipCode === 'WATCH') {
    const riskTags = best.riskTags || [];
    const riskNamesEn = riskTags.map((tag) => tag.en.toLowerCase());
    const trustScore = best.trustScore || 0;
    const hasHardRisk = riskNamesEn.some((name) => (
      name.includes('market disagreement')
      || name.includes('handicap support weak')
      || name.includes('heavy favorite')
      || name.includes('tight 1x2')
    ));
    const shouldAvoid = riskTags.length >= 4 || (hasHardRisk && trustScore < 58) || trustScore < 42;

    if (shouldAvoid) {
      return {
        category: 'avoid',
        label: labels.avoid,
        note: {
          zh: '该场未通过推荐门槛且风险标签偏多，保留数据观察，但不进入推荐池。',
          en: 'The gate was not met and risk tags are stacked. Keep the data for monitoring, but do not promote it.'
        },
        tone: 'danger',
        trustScore,
        riskCount: riskTags.length
      };
    }

    return {
      category: 'watch',
      label: labels.watch,
      note: {
        zh: 'AI精选触发价值门槛：当前不输出单一胜平负方向，先观察盘口与临场 SP。',
        en: 'The value gate was triggered. No single 1X2 pick is promoted yet; watch late SP and handicap movement.'
      },
      tone: 'warning',
      trustScore,
      riskCount: riskTags.length
    };
  }

  const riskTags = best.riskTags || [];
  const riskNames = riskTags.map((tag) => tag.zh);
  const trustScore = best.trustScore || 0;
  const trendIsMixed = match.oddsTrend?.direction === 'mixed';
  const hasDrawRisk = hasRisk(riskNames, '防平');
  const hasWeakHandicap = hasRisk(riskNames, '让球支持不足');
  const hasOverheated = hasRisk(riskNames, '热门过热');
  const selectedProbability = pickProbability(match, best.tipCode);
  const final = match.probabilityModel?.oneXTwo.final;
  const topProbability = final
    ? Math.max(final.home ?? 0, final.draw ?? 0, final.away ?? 0)
    : null;
  const probabilityGap = finalProbabilityGap(match);
  const selectedIsNotModelLeader = selectedProbability !== null
    && topProbability !== null
    && selectedProbability + 0.5 < topProbability;
  const probabilityTooLow = topProbability !== null && topProbability < 50;
  const probabilityEdgeWeak = probabilityGap !== null && probabilityGap < 5;

  if (
    selectedIsNotModelLeader
    || (probabilityTooLow && (hasDrawRisk || hasWeakHandicap || riskTags.length >= 3))
    || (hasDrawRisk && hasWeakHandicap)
    || (trendIsMixed && trustScore < 60)
    || (riskTags.length >= 4 && trustScore < 64)
  ) {
    return {
      category: 'avoid',
      label: labels.avoid,
      note: {
        zh: selectedIsNotModelLeader
          ? '精选方向与最终概率首选不一致，先降级避坑，等待下一次 SP 快照确认。'
          : '风险标签叠加，建议降低优先级或等待临场 SP。',
        en: selectedIsNotModelLeader
          ? 'The selected pick is not aligned with the final probability leader. Downgrade and wait for the next SP snapshot.'
          : 'Multiple risk tags overlap. Lower priority or wait for late SP.'
      },
      tone: 'danger',
      trustScore,
      riskCount: riskTags.length
    };
  }

  if (probabilityTooLow || (probabilityEdgeWeak && trustScore < 66)) {
    return {
      category: 'lean',
      label: labels.lean,
      note: {
        zh: probabilityTooLow
          ? '已有主方向，但最终概率未到高可信门槛，不包装成稳胆。'
          : '已有主方向，但第一方向与第二方向差距偏小，需要保留防平或防冷。',
        en: probabilityTooLow
          ? 'A lean is published, but final probability is below the steady threshold.'
          : 'A lean is published, but the top two outcomes are close.'
      },
      tone: 'success',
      trustScore,
      riskCount: riskTags.length
    };
  }

  if (
    trustScore >= 76
    && riskTags.length <= 2
    && !trendIsMixed
    && !(hasOverheated && trustScore < 84)
    && selectedProbability !== null
    && selectedProbability >= 54
  ) {
    return {
      category: 'steady',
      label: labels.steady,
      note: {
        zh: '官方 SP、最终概率、模型可信度和风险标签相对一致，可列入高可信候选。',
        en: 'Official SP, final probability, model confidence, and risk tags are aligned.'
      },
      tone: 'success',
      trustScore,
      riskCount: riskTags.length
    };
  }

  return {
    category: 'lean',
    label: labels.lean,
    note: {
      zh: '已给主方向，但仍存在风险标签或 SP 走势待复核。',
      en: 'A main lean is published, while risk tags or SP movement still need checking.'
    },
    tone: 'success',
    trustScore,
    riskCount: riskTags.length
  };
}
