import type { Match, MultiLangString, Odds } from './mockData';

export type FiveHundredDisplayTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface FiveHundredDisplayPanel {
  key: string;
  title: string;
  value: string;
  tone: FiveHundredDisplayTone;
  body: string;
  tags: string[];
}

export interface FiveHundredDisplay {
  visible: boolean;
  tone: FiveHundredDisplayTone;
  badge: string;
  summaryLabel: string;
  summaryBody: string;
  cardHint?: {
    label: string;
    tone: FiveHundredDisplayTone;
  };
  chips: string[];
  panels: FiveHundredDisplayPanel[];
}

type Language = 'zh' | 'en';
type FiveHundredSignal = NonNullable<NonNullable<Match['externalSignals']>['fiveHundred']>;

const isFiniteNumber = (value: unknown): value is number => (
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
);

const compactNumber = (value: unknown, digits = 2) => (
  isFiniteNumber(value) ? Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1') : '--'
);

const multiText = (value: MultiLangString | undefined | null, language: Language) => {
  if (!value) return '';
  return value[language] || value.zh || value.en || '';
};

const truncate = (value: string, max = 128) => (
  value.length > max ? `${value.slice(0, max - 1)}...` : value
);

const oddsText = (odds: Odds | null | undefined) => {
  if (!odds) return '';
  return `${compactNumber(odds.odds1)} / ${compactNumber(odds.oddsX)} / ${compactNumber(odds.odds2)}`;
};

const marketTone = (riskLevel: string | undefined): FiveHundredDisplayTone => {
  if (riskLevel === 'high') return 'danger';
  if (riskLevel === 'medium') return 'warning';
  if (riskLevel === 'low') return 'success';
  return 'neutral';
};

const marketLabel = (riskLevel: string | undefined, language: Language) => {
  if (language === 'zh') {
    if (riskLevel === 'high') return '盘口分歧明显';
    if (riskLevel === 'medium') return '盘口有分歧';
    if (riskLevel === 'low') return '盘口基本一致';
    return '盘口已接入';
  }

  if (riskLevel === 'high') return 'Market split';
  if (riskLevel === 'medium') return 'Some disagreement';
  if (riskLevel === 'low') return 'Market aligned';
  return 'Market loaded';
};

const movementLabel = (movement: number | null | undefined, language: Language) => {
  if (!isFiniteNumber(movement)) return '';
  const value = Number(movement);
  if (Math.abs(value) < 0.08) return language === 'zh' ? '盘口基本稳定' : 'line stable';
  return value < 0
    ? (language === 'zh' ? '盘口向主队加深' : 'line deepened to home side')
    : (language === 'zh' ? '盘口向客队回落' : 'line eased toward away side');
};

const formLine = (
  teamName: string | undefined,
  form: NonNullable<FiveHundredSignal['recentForm']>['home'] | undefined | null,
  language: Language
) => {
  const name = teamName || (language === 'zh' ? '球队' : 'Team');
  if (!form?.sampleSize) return language === 'zh' ? `${name}近况待补` : `${name} form pending`;
  const attack = isFiniteNumber(form.goalsForAvg) ? compactNumber(form.goalsForAvg, 1) : '--';
  const defense = isFiniteNumber(form.goalsAgainstAvg) ? compactNumber(form.goalsAgainstAvg, 1) : '--';
  return language === 'zh'
    ? `${name}${form.sampleSize}场${form.record || '--'}，进${attack}/失${defense}`
    : `${name}: ${form.sampleSize} matches ${form.record || '--'}, GF ${attack}/GA ${defense}`;
};

const attackTag = (
  form: NonNullable<FiveHundredSignal['recentForm']>['home'] | undefined | null,
  language: Language
) => {
  if (!isFiniteNumber(form?.goalsForAvg)) return '';
  const value = Number(form?.goalsForAvg);
  if (value >= 2) return language === 'zh' ? '进攻偏强' : 'strong attack';
  if (value <= 0.8) return language === 'zh' ? '进攻偏弱' : 'low attack';
  return language === 'zh' ? '进攻中性' : 'balanced attack';
};

const dataReadyLabel = (ready: boolean, language: Language) => (
  ready ? (language === 'zh' ? '已接入' : 'Loaded') : (language === 'zh' ? '待补' : 'Pending')
);

export const buildFiveHundredDisplay = (match: Match, language: Language): FiveHundredDisplay => {
  const signal = match.externalSignals?.fiveHundred;
  const lineups = match.externalSignals?.lineups;
  const lineupSummary = multiText(lineups?.summary, language);

  if (!signal) {
    return {
      visible: false,
      tone: 'neutral',
      badge: language === 'zh' ? '500待补' : '500 pending',
      summaryLabel: '--',
      summaryBody: '',
      chips: [],
      panels: []
    };
  }

  const europe = signal.europeOdds;
  const asian = signal.asianHandicap;
  const consensus = signal.marketConsensus;
  const riskLevel = consensus?.riskLevel;
  const tone = marketTone(riskLevel);
  const hasEurope = Boolean(europe?.currentAverage);
  const hasAsian = isFiniteNumber(asian?.currentAverageLine);
  const hasMarket = hasEurope || hasAsian || Boolean(signal.sale?.availability);
  const hasRank = Boolean(signal.rank?.home?.fifaRank || signal.rank?.away?.fifaRank);
  const hasForm = Boolean(signal.recentForm?.home?.sampleSize || signal.recentForm?.away?.sampleSize);
  const hasLineup = Boolean(lineupSummary || lineups?.homeFormation || lineups?.awayFormation);
  const hasSchedule = Boolean(
    isFiniteNumber(signal.futureSchedule?.home?.nextGapDays)
    || isFiniteNumber(signal.futureSchedule?.away?.nextGapDays)
    || signal.sale?.buyEndTime
  );
  const activeSaleCount = Object.values(signal.sale?.availability || {}).filter(Boolean).length;
  const movement = movementLabel(asian?.lineMovement, language);
  const marketValue = marketLabel(riskLevel, language);
  const riskNotes = (consensus?.notes || []).filter(Boolean);
  const showUpset = riskLevel === 'high' || riskNotes.some((note) => /冷|爆|分歧|upset|split/i.test(note));

  const chips = [
    hasEurope ? (language === 'zh' ? `欧赔${europe?.companies || '--'}家` : `${europe?.companies || '--'} Europe books`) : '',
    hasAsian ? (language === 'zh' ? `亚盘${asian?.companies || '--'}家` : `${asian?.companies || '--'} Asian books`) : '',
    activeSaleCount ? (language === 'zh' ? `${activeSaleCount}项开售` : `${activeSaleCount} markets`) : '',
    hasRank ? (language === 'zh' ? '排名' : 'rank') : '',
    hasForm ? (language === 'zh' ? '近况' : 'form') : '',
    hasLineup ? (language === 'zh' ? '预计阵容' : 'projected XI') : '',
    showUpset ? (language === 'zh' ? '冷门提醒' : 'upset alert') : ''
  ].filter(Boolean);

  const marketBodyParts = [
    hasEurope
      ? (language === 'zh'
        ? `欧赔均值 ${oddsText(europe?.currentAverage)}`
        : `Europe average ${oddsText(europe?.currentAverage)}`)
      : '',
    hasAsian
      ? (language === 'zh'
        ? `亚盘均线 ${compactNumber(asian?.currentAverageLine, 2)}`
        : `Asian average line ${compactNumber(asian?.currentAverageLine, 2)}`)
      : '',
    movement,
    riskNotes.length ? truncate(riskNotes.slice(0, 2).join(language === 'zh' ? '；' : '; '), 92) : ''
  ].filter(Boolean);

  const formBodyParts = [
    formLine(match.homeTeamName || match.homeTeamNameEn, signal.recentForm?.home, language),
    formLine(match.awayTeamName || match.awayTeamNameEn, signal.recentForm?.away, language),
    hasRank
      ? (language === 'zh'
        ? `排名 ${match.homeTeamName || '主队'} ${signal.rank?.home?.fifaRank ?? '--'} / ${match.awayTeamName || '客队'} ${signal.rank?.away?.fifaRank ?? '--'}`
        : `Rank ${match.homeTeamNameEn || match.homeTeamName || 'Home'} ${signal.rank?.home?.fifaRank ?? '--'} / ${match.awayTeamNameEn || match.awayTeamName || 'Away'} ${signal.rank?.away?.fifaRank ?? '--'}`)
      : ''
  ].filter(Boolean);

  const lineupBodyParts = [
    lineupSummary ? truncate(lineupSummary, 136) : '',
    hasSchedule
      ? (language === 'zh'
        ? `赛程间隔 主${signal.futureSchedule?.home?.nextGapDays ?? '--'}天 / 客${signal.futureSchedule?.away?.nextGapDays ?? '--'}天`
        : `Next gap home ${signal.futureSchedule?.home?.nextGapDays ?? '--'}d / away ${signal.futureSchedule?.away?.nextGapDays ?? '--'}d`)
      : '',
    signal.sale?.buyEndTime
      ? (language === 'zh' ? `截止 ${signal.sale.buyEndTime}` : `Cutoff ${signal.sale.buyEndTime}`)
      : ''
  ].filter(Boolean);

  const panels: FiveHundredDisplayPanel[] = [
    {
      key: 'market',
      title: language === 'zh' ? '盘口校验' : 'Market check',
      value: hasMarket ? marketValue : dataReadyLabel(false, language),
      tone: hasMarket ? tone : 'neutral',
      body: marketBodyParts.length
        ? marketBodyParts.join(language === 'zh' ? '；' : '; ')
        : (language === 'zh' ? '500暂未返回欧赔/亚盘详情。' : 'No 500 market details returned yet.'),
      tags: [
        hasEurope ? (language === 'zh' ? '欧赔' : 'Europe') : '',
        hasAsian ? (language === 'zh' ? '亚盘' : 'Asian') : '',
        showUpset ? (language === 'zh' ? '冷门提醒' : 'upset alert') : ''
      ].filter(Boolean)
    },
    {
      key: 'form',
      title: language === 'zh' ? '近况与排名' : 'Form and rank',
      value: hasForm || hasRank ? dataReadyLabel(true, language) : dataReadyLabel(false, language),
      tone: hasForm || hasRank ? 'success' : 'neutral',
      body: formBodyParts.length
        ? formBodyParts.join(language === 'zh' ? '；' : '; ')
        : (language === 'zh' ? '500暂未返回近况或排名字段。' : 'No 500 form or rank field yet.'),
      tags: [
        attackTag(signal.recentForm?.home, language),
        attackTag(signal.recentForm?.away, language),
        hasRank ? (language === 'zh' ? '排名已接入' : 'rank loaded') : ''
      ].filter(Boolean)
    },
    {
      key: 'lineup',
      title: language === 'zh' ? '阵容与赛程' : 'Lineup and schedule',
      value: hasLineup ? (language === 'zh' ? '预计名单' : 'Projected XI') : hasSchedule ? dataReadyLabel(true, language) : dataReadyLabel(false, language),
      tone: hasLineup ? 'success' : hasSchedule ? 'warning' : 'neutral',
      body: lineupBodyParts.length
        ? lineupBodyParts.join(language === 'zh' ? '；' : '; ')
        : (language === 'zh' ? '预计阵容、伤停和赛程压力仍需后续数据源补强。' : 'Projected XI, injuries, and schedule pressure still need more sources.'),
      tags: [
        hasLineup ? (language === 'zh' ? '预计' : 'projected') : '',
        hasSchedule ? (language === 'zh' ? '赛程' : 'schedule') : '',
        signal.sale?.buyEndTime ? (language === 'zh' ? '开售信息' : 'sale info') : ''
      ].filter(Boolean)
    }
  ];

  const hintParts = [
    hasMarket ? marketValue : '',
    hasForm ? (language === 'zh' ? '近况已接入' : 'form loaded') : '',
    hasLineup ? (language === 'zh' ? '预计阵容' : 'projected XI') : '',
    showUpset ? (language === 'zh' ? '冷门提醒' : 'upset alert') : ''
  ].filter(Boolean);

  return {
    visible: true,
    tone,
    badge: language === 'zh' ? '500网' : '500.com',
    summaryLabel: hasMarket ? marketValue : (language === 'zh' ? '500数据已接入' : '500 data loaded'),
    summaryBody: panels
      .map((panel) => panel.body)
      .filter(Boolean)
      .slice(0, 2)
      .join(language === 'zh' ? '；' : '; '),
    cardHint: hintParts.length
      ? {
        label: `${language === 'zh' ? '500' : '500'}: ${hintParts.slice(0, 3).join(language === 'zh' ? ' · ' : ' / ')}`,
        tone: showUpset ? 'warning' : tone
      }
      : undefined,
    chips,
    panels
  };
};
