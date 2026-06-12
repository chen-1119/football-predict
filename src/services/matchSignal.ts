import type { Match, MultiLangString } from './mockData';

export type MatchSignalCategory = 'steady' | 'lean' | 'value' | 'watch' | 'avoid' | 'unavailable' | 'finished';

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
  value: { zh: '价值观察', en: 'Value watch' },
  watch: { zh: '观察', en: 'Watch' },
  avoid: { zh: '先避开', en: 'Avoid for now' },
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

const isGoalsTip = (tipCode: string) => (
  tipCode === 'O2.5' || tipCode === 'U2.5' || tipCode === '7+' || /^[0-6]$/.test(tipCode)
);

const isOutcomeTip = (tipCode: string | undefined) => tipCode === '1' || tipCode === 'X' || tipCode === '2';

const isReferencePrediction = (prediction: Match['predictions'][number] | undefined) => (
  prediction?.recommendationAction === 'reference' || prediction?.recommendationTier === 'reference'
);

const hasOfficialOddsForPrediction = (match: Match, prediction: Match['predictions'][number]) => {
  const poolCode = prediction.oddsPoolCode || 'HAD';
  if (poolCode === 'HHAD') return String(match.handicapOddsSource || '').startsWith('sporttery:');
  return String(match.oddsSource || '').startsWith('sporttery:');
};

export function isActionableRecommendation(match: Match): boolean {
  if (match.status !== 'SCHEDULED') return false;

  const best = match.predictions.find((prediction) => prediction.marketType === 'BEST');
  if (!best || best.tipCode === 'WATCH' || !isOutcomeTip(best.tipCode)) return false;
  if (isReferencePrediction(best)) return false;
  if (!hasOfficialOddsForPrediction(match, best)) return false;

  const signal = getMatchSignal(match);
  if (signal.category !== 'steady' && signal.category !== 'lean') return false;

  const riskCount = best.riskTags?.length || 0;
  const probability = pickProbability(match, best.tipCode);
  const gap = finalProbabilityGap(match);
  const hasHardRisk = (best.riskTags || []).some((tag) => {
    const zh = tag.zh || '';
    const en = (tag.en || '').toLowerCase();
    return zh.includes('盘口分歧')
      || zh.includes('让球支持不足')
      || zh.includes('热门过热')
      || en.includes('market disagreement')
      || en.includes('handicap support weak')
      || en.includes('heavy favorite');
  });

  return best.trustScore >= 64
    && riskCount <= 2
    && !hasHardRisk
    && probability !== null
    && probability >= 50
    && (gap === null || gap >= 5);
}

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

  const bestIsReference = isReferencePrediction(best);

  if (best.tipCode === 'WATCH' || bestIsReference) {
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
          zh: bestIsReference
            ? '本场给出参考倾向，但风险项偏多；不放进强推池，用户可结合临场 SP 和让球盘自行取舍。'
            : '这场风险点偏多，先不放进推荐池；保留盘口和快照，等临场再复核。',
          en: bestIsReference
            ? 'A reference lean is shown, but risk tags are stacked. It stays out of the strong-pick pool; use late SP and handicap movement for judgement.'
            : 'The gate was not met and risk tags are stacked. Keep the data for monitoring, but do not promote it.'
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
        zh: bestIsReference
          ? '已给出模型参考倾向，但价值边际未达到强推门槛；重点看临场 SP 和让球盘是否继续同向。'
          : '目前只适合观察，不硬给单一胜平负方向；重点看临场 SP 和让球盘是否补强。',
        en: bestIsReference
          ? 'A model reference lean is shown, but value edge is below the strong-pick gate; watch late SP and handicap alignment.'
          : 'The value gate was triggered. No single 1X2 pick is promoted yet; watch late SP and handicap movement.'
      },
      tone: 'warning',
      trustScore,
      riskCount: riskTags.length
    };
  }

  const riskTags = best.riskTags || [];
  const riskNames = riskTags.map((tag) => tag.zh);
  const riskNamesEn = riskTags.map((tag) => tag.en.toLowerCase());
  const trustScore = best.trustScore || 0;

  if (trustScore < 56) {
    return {
      category: 'watch',
      label: labels.watch,
      note: {
        zh: '当前可信度没有达到推荐池门槛，只保留盘口观察，等待下一轮 SP 快照确认。',
        en: 'Confidence is below the recommendation gate; keep it as a market watch until the next SP snapshot.'
      },
      tone: 'warning',
      trustScore,
      riskCount: riskTags.length
    };
  }

  if (isGoalsTip(best.tipCode)) {
    if (riskTags.length >= 3 || trustScore < 58) {
      return {
        category: 'watch',
        label: labels.watch,
        note: {
          zh: '进球数有参考价值，但边际不够硬，等下一次 SP 快照确认后再决定是否提升优先级。',
          en: 'The best tip has switched to totals, but edge or risk still needs the next SP snapshot.'
        },
        tone: 'warning',
        trustScore,
        riskCount: riskTags.length
      };
    }

    return {
      category: trustScore >= 72 ? 'steady' : 'lean',
      label: trustScore >= 72 ? labels.steady : labels.lean,
      note: {
        zh: '胜平负冷却时，模型优先选择回测更稳的进球数方向，不强行追正路。',
        en: 'When 1X2 is under cooldown, the model promotes the better-tested totals lane instead of forcing the favourite.'
      },
      tone: 'success',
      trustScore,
      riskCount: riskTags.length
    };
  }

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
  const isValuePick = best.tipLabel.zh.includes('价值观察') || best.tipLabel.en.toLowerCase().includes('value watch') || riskNamesEn.some((name) => name.includes('market disagreement'));

  if (isValuePick && trustScore >= 50 && riskTags.length <= 4) {
    return {
      category: 'value',
      label: labels.value,
      note: {
        zh: '这是盘口分歧下的价值观察，不按稳胆处理；重点复核临场 SP、让球盘和风险标签是否继续同向。',
        en: 'This is a value direction under market disagreement, not a banker. Recheck late SP, handicap and risk tags.'
      },
      tone: 'warning',
      trustScore,
      riskCount: riskTags.length
    };
  }

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
          ? '精选方向与最终概率首选不一致，先降级观察，等待下一次 SP 快照确认。'
          : '风险标签叠加，先降低优先级，等临场 SP 复核。',
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
          ? '已有主方向，但最终概率未到高可信标准，不包装成稳胆。'
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
