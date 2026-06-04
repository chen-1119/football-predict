import type { Odds, PredictionDetail } from './mockData';

type Language = 'zh' | 'en';

const sportteryResultLabels = {
  '1': {
    zhCompact: '胜(3)',
    zhFull: '胜(3) 主队胜',
    enCompact: 'Home',
    enFull: 'Home Win'
  },
  X: {
    zhCompact: '平(1)',
    zhFull: '平(1) 平局',
    enCompact: 'Draw',
    enFull: 'Draw'
  },
  '2': {
    zhCompact: '负(0)',
    zhFull: '负(0) 主队负',
    enCompact: 'Away',
    enFull: 'Away Win'
  }
} as const;

export function getMarketLabel(marketType: PredictionDetail['marketType'], language: Language): string {
  const labels: Record<PredictionDetail['marketType'], Record<Language, string>> = {
    '1X2': { zh: '胜平负', en: '1X2' },
    GOALS: { zh: '总进球数', en: 'Total Goals' },
    GG_NG: { zh: '双方进球参考', en: 'BTTS Reference' },
    BEST: { zh: '精选稳胆', en: 'Best Tip' }
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
      return prediction.marketType === 'BEST' && !compact
        ? `稳胆 ${sportteryLabel.zhCompact}`
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

export function getSportteryOddsRows(odds: Odds | null | undefined, language: Language) {
  if (!odds) return [];

  if (language === 'zh') {
    return [
      { label: '胜(3)', hint: '主队胜', value: odds.odds1 },
      { label: '平(1)', hint: '平局', value: odds.oddsX },
      { label: '负(0)', hint: '主队负', value: odds.odds2 }
    ];
  }

  return [
    { label: 'Home', hint: 'Home Win', value: odds.odds1 },
    { label: 'Draw', hint: 'Draw', value: odds.oddsX },
    { label: 'Away', hint: 'Away Win', value: odds.odds2 }
  ];
}
