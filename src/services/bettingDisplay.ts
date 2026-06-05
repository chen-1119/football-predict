import type { Odds, PredictionDetail } from './mockData';

type Language = 'zh' | 'en';
export type SportteryOddsPoolCode = 'HAD' | 'HHAD';

export interface SportteryOddsPoolDisplay {
  poolCode: SportteryOddsPoolCode;
  label: string;
  handicap: string;
  odds?: Odds | null;
  source?: string;
  updatedAt?: string;
  probabilities?: { home: number; draw: number; away: number };
}

const BEST_VALUE_PREFIX_ZH = '\u4ef7\u503c\u89c2\u5bdf';
const BEST_STEADY_PREFIX_ZH = '\u7a33\u80c6';

const sportteryResultLabels = {
  '1': {
    zhCompact: '主胜',
    zhFull: '主胜',
    zhCodeHint: '竞彩代码 3',
    enCompact: 'Home',
    enFull: 'Home Win'
  },
  X: {
    zhCompact: '平局',
    zhFull: '平局',
    zhCodeHint: '竞彩代码 1',
    enCompact: 'Draw',
    enFull: 'Draw'
  },
  '2': {
    zhCompact: '客胜',
    zhFull: '客胜',
    zhCodeHint: '竞彩代码 0',
    enCompact: 'Away',
    enFull: 'Away Win'
  }
} as const;

export function getMarketLabel(marketType: PredictionDetail['marketType'], language: Language): string {
  const labels: Record<PredictionDetail['marketType'], Record<Language, string>> = {
    '1X2': { zh: '胜平负', en: '1X2' },
    GOALS: { zh: '总进球数', en: 'Total Goals' },
    GG_NG: { zh: '双方进球参考', en: 'BTTS Reference' },
    BEST: { zh: 'AI精选', en: 'Best Tip' }
  };

  return labels[marketType][language];
}

export function getPredictionTipDisplay(
  prediction: PredictionDetail,
  language: Language,
  compact = false
): string {
  const sportteryLabel = sportteryResultLabels[prediction.tipCode as keyof typeof sportteryResultLabels];

  if ((prediction.marketType === '1X2' || prediction.marketType === 'BEST') && sportteryLabel) {
    if (language === 'zh') {
      const bestPrefix = prediction.tipLabel.zh.includes(BEST_VALUE_PREFIX_ZH)
        ? BEST_VALUE_PREFIX_ZH
        : BEST_STEADY_PREFIX_ZH;

      return prediction.marketType === 'BEST' && !compact
        ? `${bestPrefix} ${sportteryLabel.zhCompact}`
        : compact
          ? sportteryLabel.zhCompact
          : sportteryLabel.zhFull;
    }

    return compact ? sportteryLabel.enCompact : sportteryLabel.enFull;
  }

  if (prediction.marketType === 'GOALS') {
    if (prediction.tipCode === 'O2.5') return language === 'zh' ? '总进球 3+' : 'Total Goals 3+';
    if (prediction.tipCode === 'U2.5') return language === 'zh' ? '总进球 0-2' : 'Total Goals 0-2';
    if (/^[0-6]$/.test(prediction.tipCode)) {
      return language === 'zh' ? `总进球 ${prediction.tipCode}球` : `${prediction.tipCode} goals`;
    }
    if (prediction.tipCode === '7+') return language === 'zh' ? '总进球 7+' : '7+ goals';
  }

  if (prediction.marketType === 'GG_NG') {
    if (prediction.tipCode === 'GG') return language === 'zh' ? '双方进球 是' : 'Both teams score';
    if (prediction.tipCode === 'NG') return language === 'zh' ? '双方进球 否' : 'No both teams score';
  }

  const label = prediction.tipLabel[language];
  return prediction.marketType === 'BEST' && language === 'zh'
    ? label.replace(/^稳胆[:：]\s*/, '')
    : label;
}

export function getPredictionCodeHint(prediction: PredictionDetail, language: Language): string {
  const sportteryLabel = sportteryResultLabels[prediction.tipCode as keyof typeof sportteryResultLabels];

  if (!sportteryLabel || (prediction.marketType !== '1X2' && prediction.marketType !== 'BEST')) return '';
  return language === 'zh' ? sportteryLabel.zhCodeHint : '';
}

export function getPredictionValueLabel(prediction: PredictionDetail, language: Language): string {
  if (prediction.marketType === '1X2' || prediction.marketType === 'BEST') {
    return 'SP';
  }

  return language === 'zh' ? '指数' : 'Index';
}

export function getPredictionExplanationDisplay(prediction: PredictionDetail, language: Language): string {
  const text = prediction.explanation[language];

  if (language !== 'zh') return text;

  return text
    .replace(/胜\(3\)\s*/g, '主胜')
    .replace(/平\(1\)\s*/g, '平局')
    .replace(/负\(0\)\s*/g, '客胜');
}

export function getSportteryOddsRows(odds: Odds | null | undefined, language: Language) {
  if (!odds) return [];

  if (language === 'zh') {
    return [
      { label: '主胜', hint: '代码3', value: odds.odds1 },
      { label: '平局', hint: '代码1', value: odds.oddsX },
      { label: '客胜', hint: '代码0', value: odds.odds2 }
    ];
  }

  return [
    { label: 'Home', hint: 'Home Win', value: odds.odds1 },
    { label: 'Draw', hint: 'Draw', value: odds.oddsX },
    { label: 'Away', hint: 'Away Win', value: odds.odds2 }
  ];
}

export function getImpliedProbabilities(odds: Odds | null | undefined) {
  if (!odds) return undefined;

  const home = 1 / odds.odds1;
  const draw = 1 / odds.oddsX;
  const away = 1 / odds.odds2;
  const total = home + draw + away || 1;

  return {
    home: Math.round((home / total) * 100),
    draw: Math.round((draw / total) * 100),
    away: Math.round((away / total) * 100)
  };
}

export function getSportteryPoolRows(match: {
  odds?: Odds | null;
  oddsSource?: string;
  oddsUpdatedAt?: string;
  handicapOdds?: Odds | null;
  handicapLine?: string;
  handicapOddsSource?: string;
  handicapOddsUpdatedAt?: string;
}, language: Language): SportteryOddsPoolDisplay[] {
  const rows: SportteryOddsPoolDisplay[] = [
    {
      poolCode: 'HAD',
      label: language === 'zh' ? '胜平负' : '1X2',
      handicap: '0',
      odds: match.odds,
      source: match.oddsSource,
      updatedAt: match.oddsUpdatedAt,
      probabilities: getImpliedProbabilities(match.odds)
    },
    {
      poolCode: 'HHAD',
      label: language === 'zh' ? '让球胜平负' : 'Handicap 1X2',
      handicap: match.handicapLine || '',
      odds: match.handicapOdds,
      source: match.handicapOddsSource,
      updatedAt: match.handicapOddsUpdatedAt,
      probabilities: getImpliedProbabilities(match.handicapOdds)
    }
  ];
  const hasAnyOdds = rows.some((row) => row.odds);
  return hasAnyOdds ? rows.filter((row) => row.odds || row.poolCode === 'HAD') : [];
}
