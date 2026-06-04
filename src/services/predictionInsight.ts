import type { Match, MultiLangString, Odds, PredictionDetail } from './mockData';
import { getImpliedProbabilities, getPredictionTipDisplay } from './bettingDisplay';
import { getMatchSignal } from './matchSignal';

type ResultCode = '1' | 'X' | '2';
type InsightTone = 'success' | 'warning' | 'danger' | 'muted';

export interface MatchInsightMetric {
  label: MultiLangString;
  value: MultiLangString;
  tone: InsightTone;
}

export interface MatchInsightPoint {
  title: MultiLangString;
  body: MultiLangString;
  tone: InsightTone;
}

export interface MatchInsight {
  title: MultiLangString;
  summary: MultiLangString;
  action: MultiLangString;
  score: number | null;
  tone: InsightTone;
  metrics: MatchInsightMetric[];
  drivers: MatchInsightPoint[];
  watchpoints: MatchInsightPoint[];
}

export interface MatchInsightContext {
  homeSampleSize: number;
  awaySampleSize: number;
  h2hSampleSize: number;
  coverageLabel: string;
}

const resultLabels: Record<ResultCode, MultiLangString> = {
  '1': { zh: '主胜', en: 'Home win' },
  X: { zh: '平局', en: 'Draw' },
  '2': { zh: '客胜', en: 'Away win' }
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isResultCode = (code: string | undefined): code is ResultCode => code === '1' || code === 'X' || code === '2';

const pickProbability = (
  probabilities: { home: number; draw: number; away: number } | undefined,
  code: ResultCode | undefined
) => {
  if (!probabilities || !code) return null;
  if (code === '1') return probabilities.home;
  if (code === 'X') return probabilities.draw;
  return probabilities.away;
};

const oddsText = (odds: Odds | null | undefined) => {
  if (!odds) return '--';
  return `${odds.odds1.toFixed(2)} / ${odds.oddsX.toFixed(2)} / ${odds.odds2.toFixed(2)}`;
};

const percentText = (value: number | null) => (value === null ? '--' : `${value}%`);

const getPrimaryPrediction = (match: Match): PredictionDetail | undefined => {
  return match.predictions.find((prediction) => prediction.marketType === 'BEST')
    || match.predictions.find((prediction) => prediction.marketType === '1X2');
};

const trendLabel = (direction: Match['oddsTrend'] extends infer T ? T extends { direction: infer D } ? D : never : never): MultiLangString => {
  const labels = {
    home: { zh: '主胜方向降赔', en: 'home side shortening' },
    draw: { zh: '平局方向降赔', en: 'draw shortening' },
    away: { zh: '客胜方向降赔', en: 'away side shortening' },
    mixed: { zh: '多方向拉扯', en: 'mixed movement' },
    flat: { zh: '整体波动很小', en: 'mostly flat' }
  } as const;

  return labels[direction as keyof typeof labels] || labels.flat;
};

export function buildMatchInsight(match: Match, context: MatchInsightContext): MatchInsight {
  const primary = getPrimaryPrediction(match);
  const signal = getMatchSignal(match);
  const resultCode = isResultCode(primary?.tipCode) ? primary.tipCode : undefined;
  const hadProbabilities = getImpliedProbabilities(match.odds);
  const hhadProbabilities = getImpliedProbabilities(match.handicapOdds);
  const hadSupport = pickProbability(hadProbabilities, resultCode);
  const hhadSupport = pickProbability(hhadProbabilities, resultCode);
  const riskTags = primary?.riskTags || [];
  const riskTextZh = riskTags.length ? riskTags.map((tag) => tag.zh).join('、') : '暂无明显风险标签';
  const riskTextEn = riskTags.length ? riskTags.map((tag) => tag.en).join(', ') : 'no major risk tags';
  const sampleText = `${context.homeSampleSize}/${context.awaySampleSize}/${context.h2hSampleSize}`;
  const sampleEnough = context.homeSampleSize >= 3 && context.awaySampleSize >= 3;
  const trendText = match.oddsTrend ? trendLabel(match.oddsTrend.direction) : null;
  const actionByCategory: Record<typeof signal.category, MultiLangString> = {
    steady: { zh: '可列入候选', en: 'Candidate' },
    watch: { zh: '观察为主', en: 'Watch' },
    avoid: { zh: '降低优先级', en: 'Lower priority' },
    unavailable: { zh: '等待开售', en: 'Wait for sale' }
  };
  const toneByCategory: Record<typeof signal.category, InsightTone> = {
    steady: 'success',
    watch: 'warning',
    avoid: 'danger',
    unavailable: 'muted'
  };
  const trustScore = primary?.trustScore || 0;
  const insightScore = primary
    ? clamp(Math.round(trustScore - riskTags.length * 4 + (sampleEnough ? 3 : -4) + (match.oddsTrend?.direction === 'mixed' ? -3 : 0)), 0, 99)
    : null;
  const tipZh = primary ? getPredictionTipDisplay(primary, 'zh', true) : '--';
  const tipEn = primary ? getPredictionTipDisplay(primary, 'en', true) : '--';
  const action = actionByCategory[signal.category];
  const tone = toneByCategory[signal.category];

  if (!primary) {
    return {
      title: { zh: '待开售观察', en: 'Waiting for HAD' },
      summary: {
        zh: '普通胜平负暂未开售，当前只做盘面观察，不生成主推结论。',
        en: 'Standard HAD is not on sale yet. This match is kept as market observation only.'
      },
      action,
      score: null,
      tone,
      metrics: [
        { label: { zh: '主推', en: 'Pick' }, value: { zh: '--', en: '--' }, tone: 'muted' },
        { label: { zh: 'HAD支持', en: 'HAD support' }, value: { zh: '--', en: '--' }, tone: 'muted' },
        { label: { zh: '让球验证', en: 'Handicap check' }, value: { zh: hhadProbabilities ? '已开售' : '未开售', en: hhadProbabilities ? 'Open' : 'Closed' }, tone: hhadProbabilities ? 'warning' : 'muted' },
        { label: { zh: '历史样本', en: 'History sample' }, value: { zh: sampleText, en: sampleText }, tone: sampleEnough ? 'success' : 'warning' }
      ],
      drivers: [
        {
          title: { zh: '当前盘面', en: 'Market state' },
          body: {
            zh: `官方让球胜平负 SP 为 ${oddsText(match.handicapOdds)}，普通胜平负开售后再生成模型推荐。`,
            en: `Official handicap SP is ${oddsText(match.handicapOdds)}. Model pick will be generated after HAD opens.`
          },
          tone: hhadProbabilities ? 'warning' : 'muted'
        }
      ],
      watchpoints: [
        {
          title: { zh: '操作建议', en: 'Action' },
          body: {
            zh: '先记录盘面快照，等待普通胜平负开售或临场 SP 更新。',
            en: 'Record the market snapshot first, then wait for HAD or late SP updates.'
          },
          tone: 'muted'
        }
      ]
    };
  }

  const handicapBody = hhadSupport === null
    ? {
      zh: '让球胜平负暂未形成可用验证，当前以 HAD 主盘为准。',
      en: 'No usable handicap check yet, so HAD remains the anchor.'
    }
    : {
      zh: `让球盘同方向支持率约 ${hhadSupport}%，${hhadSupport >= 42 ? '与主线基本同向。' : '对主线支持偏弱，需要降温。'}`,
      en: `Handicap same-side support is about ${hhadSupport}%, ${hhadSupport >= 42 ? 'broadly aligned with the pick.' : 'weaker than the main direction.'}`
    };

  return {
    title: { zh: 'AI 综合判断', en: 'AI Decision Brief' },
    summary: {
      zh: `${action.zh}：当前主线为 ${tipZh}，HAD 去水支持率 ${percentText(hadSupport)}，模型可信度 ${trustScore || '--'}%。风险标签：${riskTextZh}。`,
      en: `${action.en}: main lean is ${tipEn}, HAD normalized support ${percentText(hadSupport)}, model confidence ${trustScore || '--'}%. Risk tags: ${riskTextEn}.`
    },
    action,
    score: insightScore,
    tone,
    metrics: [
      { label: { zh: '主推', en: 'Pick' }, value: { zh: tipZh, en: tipEn }, tone },
      { label: { zh: 'HAD支持', en: 'HAD support' }, value: { zh: percentText(hadSupport), en: percentText(hadSupport) }, tone: hadSupport !== null && hadSupport >= 50 ? 'success' : 'warning' },
      { label: { zh: '让球验证', en: 'Handicap check' }, value: { zh: hhadSupport === null ? '--' : `${hhadSupport}%`, en: hhadSupport === null ? '--' : `${hhadSupport}%` }, tone: hhadSupport !== null && hhadSupport >= 42 ? 'success' : 'warning' },
      { label: { zh: '历史样本', en: 'History sample' }, value: { zh: sampleText, en: sampleText }, tone: sampleEnough ? 'success' : 'warning' }
    ],
    drivers: [
      {
        title: { zh: '胜平负主线', en: '1X2 anchor' },
        body: {
          zh: `官方 HAD SP 为 ${oddsText(match.odds)}，${resultCode ? resultLabels[resultCode].zh : '首选方向'}去水支持率约 ${percentText(hadSupport)}。`,
          en: `Official HAD SP is ${oddsText(match.odds)}; ${resultCode ? resultLabels[resultCode].en : 'top direction'} normalized support is about ${percentText(hadSupport)}.`
        },
        tone: hadSupport !== null && hadSupport >= 50 ? 'success' : 'warning'
      },
      {
        title: { zh: '让球验证', en: 'Handicap validation' },
        body: handicapBody,
        tone: hhadSupport !== null && hhadSupport >= 42 ? 'success' : 'warning'
      },
      {
        title: { zh: 'SP走势', en: 'SP movement' },
        body: match.oddsTrend && trendText
          ? {
            zh: `已记录 ${match.oddsTrend.sampleSize} 次官方快照，当前表现为${trendText.zh}。${match.oddsTrend.summary.zh}`,
            en: `${match.oddsTrend.sampleSize} official snapshots recorded; movement is ${trendText.en}. ${match.oddsTrend.summary.en}`
          }
          : {
            zh: '当前快照数量不足，先以最新官方 SP 与后续定时快照对比。',
            en: 'Not enough snapshots yet; compare the latest official SP with later scheduled captures.'
          },
        tone: match.oddsTrend?.direction === 'mixed' ? 'warning' : 'success'
      }
    ],
    watchpoints: [
      {
        title: { zh: '风险标签', en: 'Risk tags' },
        body: {
          zh: riskTags.length ? `需要重点关注：${riskTextZh}。` : '暂未触发明显风险标签，但仍需看临场 SP 是否突变。',
          en: riskTags.length ? `Watch closely: ${riskTextEn}.` : 'No major risk tag triggered, but late SP movement still matters.'
        },
        tone: riskTags.length >= 2 ? 'danger' : riskTags.length === 1 ? 'warning' : 'muted'
      },
      {
        title: { zh: '历史样本质量', en: 'History quality' },
        body: {
          zh: sampleEnough
            ? `近一年样本为主队 ${context.homeSampleSize} 场、客队 ${context.awaySampleSize} 场、交锋 ${context.h2hSampleSize} 场；覆盖：${context.coverageLabel}。`
            : `近一年样本偏少，主队 ${context.homeSampleSize} 场、客队 ${context.awaySampleSize} 场、交锋 ${context.h2hSampleSize} 场；该部分仅作辅助。`,
          en: sampleEnough
            ? `Last-year samples: home ${context.homeSampleSize}, away ${context.awaySampleSize}, H2H ${context.h2hSampleSize}. Coverage: ${context.coverageLabel}.`
            : `Small last-year sample: home ${context.homeSampleSize}, away ${context.awaySampleSize}, H2H ${context.h2hSampleSize}; treat this as secondary context.`
        },
        tone: sampleEnough ? 'success' : 'warning'
      }
    ]
  };
}
