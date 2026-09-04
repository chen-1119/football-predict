import { getImpliedProbabilities, getResolvedMatchOdds } from './bettingDisplay';
import type { Match, MultiLangString, OutcomeProbability, PredictionDetail } from './mockData';

export type PreMatchRiskTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface PreMatchRiskReason {
  code: string;
  label: MultiLangString;
  weight: number;
}

export interface PreMatchRiskSummary {
  score: number;
  level: MultiLangString;
  tone: PreMatchRiskTone;
  reasons: PreMatchRiskReason[];
  primaryReason: MultiLangString;
  dataGapLabels: MultiLangString[];
  shouldDowngrade: boolean;
}

const outcomeKeys: Array<keyof OutcomeProbability> = ['home', 'draw', 'away'];

const toOutcomeKey = (tipCode?: string): keyof OutcomeProbability | null => {
  if (tipCode === '1') return 'home';
  if (tipCode === 'X') return 'draw';
  if (tipCode === '2') return 'away';
  return null;
};

const normalizePercent = (value: number | null | undefined) => {
  if (!Number.isFinite(value)) return null;
  return Number(value) <= 1 ? Number(value) * 100 : Number(value);
};

const formatPercent = (value: number | null | undefined) => {
  if (!Number.isFinite(value)) return '--';
  return `${Number(value).toFixed(1).replace(/\.0$/, '')}%`;
};

const probabilityForKey = (probabilities: OutcomeProbability | null | undefined, key: keyof OutcomeProbability | null) => (
  key && Number.isFinite(probabilities?.[key]) ? Number(probabilities?.[key]) : null
);

const getContextSignals = (match: Match) => (
  match.probabilityModel?.contextSignals
  || match.probabilityModel?.calculationTrace?.contextSignals
  || null
);

const getBestOutcomePrediction = (match: Match): PredictionDetail | undefined => (
  match.predictions.find((prediction) => (
    prediction.marketType === 'BEST'
    && prediction.tipCode !== 'WATCH'
    && toOutcomeKey(prediction.tipCode)
  ))
  || match.predictions.find((prediction) => (
    prediction.marketType === '1X2'
    && prediction.tipCode !== 'WATCH'
    && toOutcomeKey(prediction.tipCode)
  ))
);

const getHandicapLeader = (match: Match): keyof OutcomeProbability | null => {
  const resolved = getResolvedMatchOdds(match);
  const official = getImpliedProbabilities(resolved.hhad?.odds);
  const model = match.probabilityModel?.handicap?.market;
  const probabilities = official || model;
  if (!probabilities) return null;

  return outcomeKeys
    .map((key) => ({ key, value: probabilities[key] }))
    .filter((item) => Number.isFinite(item.value))
    .sort((a, b) => Number(b.value) - Number(a.value))[0]?.key || null;
};

const getDataGapLabels = (match: Match): MultiLangString[] => {
  const contextSignals = getContextSignals(match);
  const preMatchQuality = match.externalSignals?.preMatch?.quality || null;
  const dataGaps = contextSignals?.dataGaps || match.stats?.dataGaps;
  return ((preMatchQuality?.missing?.length ? preMatchQuality.missing : dataGaps?.missing) || [])
    .slice(0, 3)
    .map((item) => ({
      zh: item.zh || item.key || '数据缺口',
      en: item.en || item.key || 'data gap'
    }));
};

export function buildPreMatchRisk(match: Match): PreMatchRiskSummary {
  if (match.status === 'FINISHED') {
    return {
      score: 0,
      level: { zh: '赛后', en: 'Finished' },
      tone: 'neutral',
      reasons: [],
      primaryReason: { zh: '本场已完场，只做复盘。', en: 'Finished match, review only.' },
      dataGapLabels: [],
      shouldDowngrade: false
    };
  }

  const contextSignals = getContextSignals(match);
  const preMatchQuality = match.externalSignals?.preMatch?.quality || null;
  const rankingPressure = contextSignals?.rankingPressure || match.stats?.rankingPressure;
  const discipline = contextSignals?.discipline || match.stats?.discipline;
  const dataGaps = contextSignals?.dataGaps || match.stats?.dataGaps;
  const best = getBestOutcomePrediction(match);
  const bestKey = toOutcomeKey(best?.tipCode);
  const finalProbabilities = match.probabilityModel?.oneXTwo?.final
    || match.probabilityModel?.calculationTrace?.outcome?.final
    || match.probabilityModel?.oneXTwo?.market
    || null;
  const drawProbability = probabilityForKey(finalProbabilities, 'draw');
  const handicapLeader = getHandicapLeader(match);
  const redCardRisk = normalizePercent(discipline?.redCardRisk?.total);
  const rotationRisk = normalizePercent(rankingPressure?.rotationRisk);
  const externalSignals = match.externalSignals;
  const bestAny = match.predictions.find((prediction) => prediction.marketType === 'BEST');
  const trustSource = best || bestAny;
  const connectedSignalCount = [
    externalSignals?.confirmedLineup || externalSignals?.projectedRoster || externalSignals?.lineups,
    externalSignals?.injuries,
    externalSignals?.referee,
    externalSignals?.expectedGoals
  ].filter(Boolean).length;

  const reasons: PreMatchRiskReason[] = [];
  const addReason = (code: string, weight: number, label: MultiLangString) => {
    reasons.push({ code, weight, label });
  };

  if (drawProbability !== null && drawProbability >= 28) {
    addReason('draw-pressure', drawProbability >= 32 ? 18 : 12, {
      zh: `平局压力 ${formatPercent(drawProbability)}`,
      en: `draw pressure ${formatPercent(drawProbability)}`
    });
  }

  if (best?.oddsPoolCode !== 'HHAD' && bestKey && handicapLeader && handicapLeader !== bestKey) {
    addReason('handicap-mismatch', 18, {
      zh: '让球盘与主方向不同向',
      en: 'handicap line differs from main lean'
    });
  }

  if (trustSource?.trustScore && trustSource.trustScore < 45) {
    addReason('low-trust', 14, {
      zh: `证据评分 ${trustSource.trustScore}/100 偏低`,
      en: `evidence score ${trustSource.trustScore}/100 is low`
    });
  }

  if (match.oddsTrend?.direction === 'mixed') {
    addReason('mixed-sp', 14, {
      zh: '赔率走势分歧',
      en: 'mixed odds movement'
    });
  } else if (!match.oddsTrend || match.oddsTrend.sampleSize < 2) {
    addReason('few-sp-snapshots', 6, {
      zh: '赔率快照不足',
      en: 'few odds snapshots'
    });
  }

  const qualityScore = Number.isFinite(Number(preMatchQuality?.score)) ? Number(preMatchQuality?.score) : null;
  const qualityIsLow = preMatchQuality?.sourceQuality === 'low'
    || dataGaps?.sourceQuality === 'low'
    || Number(preMatchQuality?.severeMissingCount ?? dataGaps?.severeMissingCount ?? 0) >= 2;
  if (qualityIsLow) {
    addReason('data-gap', qualityScore !== null && qualityScore < 45 ? 18 : 14, {
      zh: qualityScore !== null ? `赛前数据质量 ${qualityScore}/100 偏低` : '关键数据缺口偏多',
      en: qualityScore !== null ? `pre-match data quality ${qualityScore}/100 is low` : 'key data gaps'
    });
  }

  if (rotationRisk !== null && rotationRisk >= 60) {
    addReason('rotation-risk', 10, {
      zh: '排名/出线压力带来轮换风险',
      en: 'table pressure creates rotation risk'
    });
  }

  if (redCardRisk !== null && redCardRisk >= 18) {
    addReason('red-card-risk', 8, {
      zh: `红牌风险 ${formatPercent(redCardRisk)}`,
      en: `red-card risk ${formatPercent(redCardRisk)}`
    });
  }

  if (connectedSignalCount <= 1) {
    addReason('thin-prematch-signals', 8, {
      zh: '首发/伤停/裁判/xG待补',
      en: 'lineup/injury/referee/attacking-quality signals are thin'
    });
  }

  const riskTagCount = trustSource?.riskTags?.length || 0;
  if (riskTagCount >= 4) {
    addReason('stacked-risk-tags', 8, {
      zh: `风险提示 ${riskTagCount} 个`,
      en: `${riskTagCount} risk notes`
    });
  }

  const score = Math.min(100, reasons.reduce((total, reason) => total + reason.weight, 0));
  const tone: PreMatchRiskTone = score >= 65
    ? 'danger'
    : score >= 42
      ? 'warning'
      : score >= 24
        ? 'neutral'
        : 'success';
  const level = score >= 65
    ? { zh: '高', en: 'High' }
    : score >= 42
      ? { zh: '中', en: 'Medium' }
      : score >= 24
        ? { zh: '轻微', en: 'Mild' }
        : { zh: '低', en: 'Low' };

  return {
    score,
    level,
    tone,
    reasons,
    primaryReason: reasons[0]?.label || { zh: '暂无明显冷门触发', en: 'No major upset trigger' },
    dataGapLabels: getDataGapLabels(match),
    shouldDowngrade: score >= 55 || reasons.some((reason) => reason.code === 'handicap-mismatch' || reason.code === 'data-gap')
  };
}
