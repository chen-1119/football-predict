import type { ExternalMatchSignals, Odds, PredictionDetail } from './mockData';

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
  unavailableReason?: 'closed' | 'archived';
}

export interface MatchOddsInput {
  odds?: Odds | null;
  oddsSource?: string;
  oddsUpdatedAt?: string;
  handicapOdds?: Odds | null;
  handicapLine?: string;
  handicapOddsSource?: string;
  handicapOddsUpdatedAt?: string;
  externalSignals?: ExternalMatchSignals;
}

export interface ResolvedMatchOdds {
  had?: {
    odds: Odds;
    source?: string;
    updatedAt?: string;
  };
  hhad?: {
    odds: Odds;
    handicap?: string;
    source?: string;
    updatedAt?: string;
  };
}

const isFiniteOdd = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 1;

export const normalizeOdds = (value?: Partial<Odds> | null): Odds | null => {
  if (!value || !isFiniteOdd(value.odds1) || !isFiniteOdd(value.oddsX) || !isFiniteOdd(value.odds2)) {
    return null;
  }

  return {
    odds1: Number(value.odds1),
    oddsX: Number(value.oddsX),
    odds2: Number(value.odds2)
  };
};

export function getResolvedMatchOdds(match: MatchOddsInput): ResolvedMatchOdds {
  const signals = match.externalSignals;
  const bookmakerOdds = signals?.bookmakerOdds;
  const officialHad = normalizeOdds(match.odds);
  const officialHhad = normalizeOdds(match.handicapOdds);
  const externalHad = normalizeOdds(bookmakerOdds?.had || bookmakerOdds?.apiFootball?.had);
  const externalHhad = normalizeOdds(bookmakerOdds?.hhad);
  const externalOdds = normalizeOdds(signals?.externalOdds);
  const externalOddsLooksLikeHad = Boolean(externalOdds && !externalHhad && !signals?.handicapLine);
  const had = officialHad || externalHad || (externalOddsLooksLikeHad ? externalOdds : null);
  const hhad = officialHhad || externalHhad || (!officialHad && !externalHad && signals?.handicapLine ? externalOdds : null);

  return {
    had: had
      ? {
          odds: had,
          source: match.oddsSource || bookmakerOdds?.had?.source || bookmakerOdds?.apiFootball?.source || signals?.externalOdds?.source || signals?.source,
          updatedAt: match.oddsUpdatedAt || bookmakerOdds?.had?.updatedAt || bookmakerOdds?.apiFootball?.updatedAt || signals?.updatedAt
        }
      : undefined,
    hhad: hhad
      ? {
          odds: hhad,
          handicap: match.handicapLine || bookmakerOdds?.hhad?.handicapLine || signals?.handicapLine,
          source: match.handicapOddsSource || bookmakerOdds?.hhad?.source || signals?.source,
          updatedAt: match.handicapOddsUpdatedAt || bookmakerOdds?.hhad?.updatedAt || signals?.updatedAt
        }
      : undefined
  };
}

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

const sportteryHandicapResultLabels = {
  '1': {
    zhCompact: '让球主胜',
    zhFull: '让球主胜',
    zhCodeHint: '让球代码 3',
    enCompact: 'HHAD Home',
    enFull: 'Handicap Home Win'
  },
  X: {
    zhCompact: '让球平',
    zhFull: '让球平',
    zhCodeHint: '让球代码 1',
    enCompact: 'HHAD Draw',
    enFull: 'Handicap Draw'
  },
  '2': {
    zhCompact: '让球客胜',
    zhFull: '让球客胜',
    zhCodeHint: '让球代码 0',
    enCompact: 'HHAD Away',
    enFull: 'Handicap Away Win'
  }
} as const;

export function getMarketLabel(marketType: PredictionDetail['marketType'], language: Language): string {
  const labels: Record<PredictionDetail['marketType'], Record<Language, string>> = {
    '1X2': { zh: '胜平负', en: '1X2' },
    GOALS: { zh: '进球参考', en: 'Goals' },
    GG_NG: { zh: '双方进球参考', en: 'BTTS Reference' },
    BEST: { zh: 'AI精选', en: 'Best Tip' }
  };

  return labels[marketType][language];
}

export function getPredictionMarketLabel(prediction: PredictionDetail, language: Language): string {
  if (
    prediction.oddsPoolCode === 'HHAD' &&
    (prediction.marketType === '1X2' || prediction.marketType === 'BEST') &&
    sportteryResultLabels[prediction.tipCode as keyof typeof sportteryResultLabels]
  ) {
    return prediction.marketType === 'BEST'
      ? (language === 'zh' ? 'AI精选 · 让球' : 'Best Tip · HHAD')
      : (language === 'zh' ? '让球胜平负' : 'Handicap 1X2');
  }

  return getMarketLabel(prediction.marketType, language);
}

export function getPredictionTipDisplay(
  prediction: PredictionDetail,
  language: Language,
  compact = false
): string {
  const handicapLabel = prediction.oddsPoolCode === 'HHAD'
    ? sportteryHandicapResultLabels[prediction.tipCode as keyof typeof sportteryHandicapResultLabels]
    : undefined;
  if ((prediction.marketType === '1X2' || prediction.marketType === 'BEST') && handicapLabel) {
    if (language === 'zh') {
      return compact ? handicapLabel.zhCompact : handicapLabel.zhFull;
    }

    return compact ? handicapLabel.enCompact : handicapLabel.enFull;
  }

  if (prediction.marketType === 'BEST') {
    if (language === 'zh') {
      const label = prediction.tipLabel.zh
        .replace(/^稳胆[:：]?\s*/, '高可信 ')
        .replace(/^稳妥方向\s+/, '高可信 ');

      if (!compact) return label;

      return label
        .replace(/^(模型首选|价值观察|高可信)\s+(主胜|平局|客胜).*/, '$1 $2')
        .replace(/^观察为主\s+.*/, '观察为主');
    }

    return compact
      ? prediction.tipLabel.en.replace(/:.*/, '')
      : prediction.tipLabel.en;
  }

  const sportteryLabel = sportteryResultLabels[prediction.tipCode as keyof typeof sportteryResultLabels];

  if (prediction.marketType === '1X2' && sportteryLabel) {
    if (language === 'zh') {
      return compact ? sportteryLabel.zhCompact : sportteryLabel.zhFull;
    }

    return compact ? sportteryLabel.enCompact : sportteryLabel.enFull;
  }

  if (prediction.marketType === 'GOALS') {
    if (prediction.tipCode === 'O2.5') return language === 'zh' ? '大2.5球（≥3球）' : 'Over 2.5 goals';
    if (prediction.tipCode === 'U2.5') return language === 'zh' ? '小2.5球（≤2球）' : 'Under 2.5 goals';
    if (/^[0-6]$/.test(prediction.tipCode)) {
      return language === 'zh' ? `总进球 ${prediction.tipCode}球` : `${prediction.tipCode} goals`;
    }
    if (prediction.tipCode === '7+') return language === 'zh' ? '总进球 7+' : '7+ goals';
  }

  if (prediction.marketType === 'GG_NG') {
    if (prediction.tipCode === 'GG') return language === 'zh' ? '双方进球 是' : 'Both teams score';
    if (prediction.tipCode === 'NG') return language === 'zh' ? '双方进球 否' : 'No both teams score';
  }

  return prediction.tipLabel[language];
}

export function getPredictionCodeHint(prediction: PredictionDetail, language: Language): string {
  const sportteryLabel = prediction.oddsPoolCode === 'HHAD'
    ? sportteryHandicapResultLabels[prediction.tipCode as keyof typeof sportteryHandicapResultLabels]
    : sportteryResultLabels[prediction.tipCode as keyof typeof sportteryResultLabels];

  if (!sportteryLabel || (prediction.marketType !== '1X2' && prediction.marketType !== 'BEST')) return '';
  return language === 'zh' ? sportteryLabel.zhCodeHint : '';
}

export function getPredictionValueLabel(prediction: PredictionDetail, language: Language): string {
  if (prediction.marketType === 'BEST' && (!Number.isFinite(prediction.odds) || prediction.odds <= 0)) {
    return language === 'zh' ? '建议' : 'Advice';
  }

  if (prediction.marketType === 'BEST' && !sportteryResultLabels[prediction.tipCode as keyof typeof sportteryResultLabels]) {
    return language === 'zh' ? '模型值' : 'Model';
  }

  if (prediction.marketType === '1X2' || prediction.marketType === 'BEST') {
    return prediction.oddsPoolCode === 'HHAD'
      ? (language === 'zh' ? '让球SP' : 'HHAD SP')
      : 'SP';
  }

  return language === 'zh' ? '模型值' : 'Model';
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
  const normalized = normalizeOdds(odds);
  if (!normalized) return undefined;

  const home = 1 / normalized.odds1;
  const draw = 1 / normalized.oddsX;
  const away = 1 / normalized.odds2;
  const total = home + draw + away || 1;

  return {
    home: Math.round((home / total) * 100),
    draw: Math.round((draw / total) * 100),
    away: Math.round((away / total) * 100)
  };
}

export function getSportteryPoolRows(match: MatchOddsInput, language: Language): SportteryOddsPoolDisplay[] {
  const resolved = getResolvedMatchOdds(match);
  const isArchived = (match as MatchOddsInput & { status?: string }).status === 'FINISHED';
  const rows: SportteryOddsPoolDisplay[] = [
    {
      poolCode: 'HAD',
      label: language === 'zh' ? '胜平负' : '1X2',
      handicap: '0',
      odds: resolved.had?.odds || null,
      source: resolved.had?.source,
      updatedAt: resolved.had?.updatedAt,
      probabilities: getImpliedProbabilities(resolved.had?.odds),
      unavailableReason: resolved.had?.odds ? undefined : (isArchived ? 'archived' : 'closed')
    },
    {
      poolCode: 'HHAD',
      label: language === 'zh' ? '让球胜平负' : 'Handicap 1X2',
      handicap: resolved.hhad?.handicap || '',
      odds: resolved.hhad?.odds || null,
      source: resolved.hhad?.source,
      updatedAt: resolved.hhad?.updatedAt,
      probabilities: getImpliedProbabilities(resolved.hhad?.odds),
      unavailableReason: resolved.hhad?.odds ? undefined : (isArchived ? 'archived' : 'closed')
    }
  ];
  return rows;
}
