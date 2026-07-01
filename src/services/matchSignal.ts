import type { Match, MultiLangString } from './mockData';
import { buildPreMatchRisk } from './preMatchRisk';
import { isPredictionOfficialResultPoolAvailable } from './bettingDisplay';

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
  value: { zh: '有冷门变量', en: 'Upset variables' },
  watch: { zh: '待开售', en: 'Pending sale' },
  avoid: { zh: '临场复核', en: 'Late recheck' },
  unavailable: { zh: '待开售', en: 'Pending' },
  finished: { zh: '已完场', en: 'Finished' }
};

const hasRisk = (riskNames: string[], keyword: string) => {
  return riskNames.some((name) => name.includes(keyword));
};

const getProbabilitySource = (match: Match, prediction?: Match['predictions'][number]) => {
  if (prediction?.oddsPoolCode === 'HHAD') {
    return match.probabilityModel?.handicap?.scoreImplied
      || match.probabilityModel?.handicap?.poisson
      || match.probabilityModel?.handicap?.market
      || null;
  }

  return match.probabilityModel?.oneXTwo.final || null;
};

const pickProbability = (match: Match, predictionOrTip: Match['predictions'][number] | string | undefined) => {
  const prediction = typeof predictionOrTip === 'string' ? undefined : predictionOrTip;
  const tipCode = typeof predictionOrTip === 'string' ? predictionOrTip : predictionOrTip?.tipCode;
  const final = getProbabilitySource(match, prediction);
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

const finalProbabilityGap = (match: Match, prediction?: Match['predictions'][number]) => {
  const final = getProbabilitySource(match, prediction);
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

export function isActionableRecommendation(match: Match): boolean {
  if (match.status !== 'SCHEDULED') return false;

  const best = match.predictions.find((prediction) => prediction.marketType === 'BEST');
  if (!best || best.tipCode === 'WATCH' || !isOutcomeTip(best.tipCode)) return false;
  if (isReferencePrediction(best)) return false;
  if (!isPredictionOfficialResultPoolAvailable(match, best)) return false;

  const signal = getMatchSignal(match);
  if (signal.category !== 'steady' && signal.category !== 'lean') return false;

  const preMatchRisk = buildPreMatchRisk(match);
  if (preMatchRisk.score >= 55 || (preMatchRisk.shouldDowngrade && best.trustScore < 78)) return false;

  const riskCount = best.riskTags?.length || 0;
  const probability = pickProbability(match, best);
  const gap = finalProbabilityGap(match, best);
  const bestIsHandicap = best.oddsPoolCode === 'HHAD';
  const hasHardRisk = (best.riskTags || []).some((tag) => {
    const zh = tag.zh || '';
    const en = (tag.en || '').toLowerCase();
    return (!bestIsHandicap && zh.includes('盘口分歧'))
      || (!bestIsHandicap && zh.includes('让球支持不足'))
      || zh.includes('热门过热')
      || (!bestIsHandicap && en.includes('market disagreement'))
      || (!bestIsHandicap && en.includes('handicap support weak'))
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
  const preMatchRisk = buildPreMatchRisk(match);

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
    const shouldAvoid = riskTags.length >= 4
      || (hasHardRisk && trustScore < 58)
      || trustScore < 42
      || preMatchRisk.score >= 55;

    if (shouldAvoid) {
      return {
        category: 'avoid',
        label: labels.avoid,
        note: {
          zh: bestIsReference
            ? (preMatchRisk.score >= 55
              ? `本场冷门风险 ${preMatchRisk.score}，推荐方向需要临场复核；重点看${preMatchRisk.primaryReason.zh}。`
              : '本场有推荐方向，但风险项偏多，需要结合临场 SP 和让球盘复核。')
            : '这场风险点偏多，保留盘口和快照，等临场再复核。',
          en: bestIsReference
            ? (preMatchRisk.score >= 55
              ? `Upset risk is ${preMatchRisk.score}. Recheck ${preMatchRisk.primaryReason.en} before kickoff.`
              : 'A direction is shown, but risk tags are stacked. Use late SP and handicap movement for judgement.')
            : 'Risk tags are stacked. Keep the data for monitoring and recheck late.'
        },
        tone: 'warning',
        trustScore,
        riskCount: riskTags.length + (preMatchRisk.score >= 42 ? 1 : 0)
      };
    }

    return {
      category: 'watch',
      label: labels.watch,
      note: {
        zh: bestIsReference
          ? '已给出参考方向，但赔率优势不厚；重点看临场赔率和让球盘是否继续同向。'
          : '等待官方赔率或让球盘补强后再给出方向。',
        en: bestIsReference
          ? 'A reference direction is shown, but the edge is thin; watch late odds and handicap alignment.'
          : 'Wait for official odds or handicap movement before publishing a direction.'
      },
      tone: 'warning',
      trustScore,
      riskCount: riskTags.length + (preMatchRisk.score >= 42 ? 1 : 0)
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
        zh: '当前推荐强度不足，等待下一轮赔率快照确认。',
        en: 'Pick strength is thin; wait for the next odds snapshot.'
      },
      tone: 'warning',
      trustScore,
      riskCount: riskTags.length
    };
  }

  if (isGoalsTip(best.tipCode)) {
    return {
      category: preMatchRisk.score >= 55 ? 'avoid' : 'watch',
      label: preMatchRisk.score >= 55 ? labels.avoid : labels.watch,
      note: {
        zh: '进球数只保留为模型校验，不作为页面推荐；当前等待胜平负或让球方向达到门槛。',
        en: 'Goal totals are kept as model validation only, not as page recommendations; wait for a qualified 1X2 or HHAD direction.'
      },
      tone: 'warning',
      trustScore,
      riskCount: riskTags.length + (preMatchRisk.score >= 42 ? 1 : 0)
    };
  }

  const trendIsMixed = match.oddsTrend?.direction === 'mixed';
  const hasDrawRisk = hasRisk(riskNames, '防平');
  const hasWeakHandicap = best.oddsPoolCode !== 'HHAD' && hasRisk(riskNames, '让球支持不足');
  const hasOverheated = hasRisk(riskNames, '热门过热');
  const selectedProbability = pickProbability(match, best);
  const final = getProbabilitySource(match, best);
  const topProbability = final
    ? Math.max(final.home ?? 0, final.draw ?? 0, final.away ?? 0)
    : null;
  const probabilityGap = finalProbabilityGap(match, best);
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
        zh: '这是赔率意见不一致下的价值观察，不按稳胆处理；重点复核临场赔率、让球盘和风险提示是否继续同向。',
        en: 'This is a value direction under market disagreement, not a banker. Recheck late odds, handicap and risk notes.'
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
    || (preMatchRisk.score >= 55 && trustScore < 78)
  ) {
    return {
      category: 'avoid',
      label: labels.avoid,
      note: {
        zh: selectedIsNotModelLeader
          ? '当前方向与综合判断首选不一致，等待下一次赔率快照确认。'
          : preMatchRisk.score >= 55
            ? `冷门风险 ${preMatchRisk.score} 偏高，先降级为参考；重点复核${preMatchRisk.primaryReason.zh}。`
          : '条件没有完全同向，推荐方向需要临场赔率复核。',
        en: selectedIsNotModelLeader
          ? 'The selected pick is not aligned with the main read. Downgrade and wait for the next odds snapshot.'
          : preMatchRisk.score >= 55
            ? `Upset risk ${preMatchRisk.score} is elevated. Downgrade to reference and recheck ${preMatchRisk.primaryReason.en}.`
          : 'Multiple risk notes overlap. Lower priority or wait for late odds.'
      },
      tone: 'warning',
      trustScore,
      riskCount: riskTags.length + (preMatchRisk.score >= 42 ? 1 : 0)
    };
  }

  if (probabilityTooLow || (probabilityEdgeWeak && trustScore < 66)) {
    return {
      category: 'lean',
      label: labels.lean,
      note: {
        zh: probabilityTooLow
          ? '已有主方向，但推荐强度未到稳胆标准，不包装成稳胆。'
          : '已有主方向，但第一方向与第二方向差距偏小，需要保留防平或防冷。',
        en: probabilityTooLow
          ? 'A lean is published, but final probability is below the steady threshold.'
          : 'A lean is published, but the top two outcomes are close.'
      },
      tone: 'success',
      trustScore,
      riskCount: riskTags.length + (preMatchRisk.score >= 42 ? 1 : 0)
    };
  }

  if (
    trustScore >= 76
    && riskTags.length <= 2
    && !trendIsMixed
    && !(hasOverheated && trustScore < 84)
    && preMatchRisk.score < 42
    && selectedProbability !== null
    && selectedProbability >= 54
  ) {
    return {
      category: 'steady',
      label: labels.steady,
      note: {
        zh: '官方赔率、综合判断、推荐强度和风险提示相对一致，可列入高信心候选。',
        en: 'Official odds, main read, pick strength, and risk notes are aligned.'
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
      zh: '已给主方向，但仍存在风险提示或赔率走势待复核。',
      en: 'A main lean is published, while risk notes or odds movement still need checking.'
    },
    tone: 'success',
    trustScore,
    riskCount: riskTags.length + (preMatchRisk.score >= 42 ? 1 : 0)
  };
}
