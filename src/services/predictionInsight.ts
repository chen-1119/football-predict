import type { Match, MultiLangString, Odds, PredictionDetail } from './mockData';
import { getImpliedProbabilities, getPredictionTipDisplay, getResolvedMatchOdds } from './bettingDisplay';
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
  framework: MatchInsightPoint[];
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

const percentText = (value: number | null | undefined) => (Number.isFinite(value) ? `${Math.round(Number(value))}%` : '--');
const decimalText = (value: number | null | undefined, digits = 2) => (Number.isFinite(value) ? Number(value).toFixed(digits) : '--');
const rateText = (value: number | null | undefined) => (Number.isFinite(value) ? `${Math.round(Number(value) * 100)}%` : '--');
const signedText = (value: number | null | undefined) => {
  if (!Number.isFinite(value)) return '--';
  return Number(value) > 0 ? `+${Math.round(Number(value))}` : `${Math.round(Number(value))}`;
};

const dataCoverage = {
  zh: '赛前信息层覆盖伤停、首发、天气、裁判、xG/xGA 与外部赔率，按可信程度辅助风险修正。',
  en: 'The pre-match signal layer covers injuries, projected XI, weather, referee profile, xG/xGA, and external odds as verified risk modifiers.'
};

const multiText = (value: MultiLangString | undefined | null, language: 'zh' | 'en') => {
  if (!value) return '';
  return value[language] || value.zh || value.en || '';
};

const externalNames = (
  items: MultiLangString[] | undefined,
  language: 'zh' | 'en',
  limit = 3
) => (items || [])
  .map((item) => multiText(item, language))
  .filter(Boolean)
  .slice(0, limit)
  .join(language === 'zh' ? '、' : ', ');

const lineupsSignalText = (match: Match): MultiLangString => {
  const signals = match.externalSignals;
  const injuries = signals?.injuries;
  const lineups = signals?.lineups;
  const homeInjuriesZh = externalNames(injuries?.home, 'zh');
  const awayInjuriesZh = externalNames(injuries?.away, 'zh');
  const homeInjuriesEn = externalNames(injuries?.home, 'en');
  const awayInjuriesEn = externalNames(injuries?.away, 'en');
  const injurySummaryZh = multiText(injuries?.summary, 'zh');
  const injurySummaryEn = multiText(injuries?.summary, 'en');
  const lineupSummaryZh = multiText(lineups?.summary, 'zh');
  const lineupSummaryEn = multiText(lineups?.summary, 'en');
  const formationZh = lineups?.homeFormation || lineups?.awayFormation
    ? `预计阵型 ${lineups.homeFormation || '--'} / ${lineups.awayFormation || '--'}。`
    : '';
  const formationEn = lineups?.homeFormation || lineups?.awayFormation
    ? `Projected shapes ${lineups.homeFormation || '--'} / ${lineups.awayFormation || '--'}.`
    : '';

  return {
    zh: [
      lineupSummaryZh,
      injurySummaryZh,
      homeInjuriesZh ? `${match.homeTeamName || '主队'}关注：${homeInjuriesZh}` : '',
      awayInjuriesZh ? `${match.awayTeamName || '客队'}关注：${awayInjuriesZh}` : '',
      formationZh
    ].filter(Boolean).join(' '),
    en: [
      lineupSummaryEn,
      injurySummaryEn,
      homeInjuriesEn ? `${match.homeTeamNameEn || match.homeTeamName || 'Home'} watch: ${homeInjuriesEn}` : '',
      awayInjuriesEn ? `${match.awayTeamNameEn || match.awayTeamName || 'Away'} watch: ${awayInjuriesEn}` : '',
      formationEn
    ].filter(Boolean).join(' ')
  };
};

const environmentSignalText = (match: Match): MultiLangString => {
  const signals = match.externalSignals;
  const weather = signals?.weather;
  const referee = signals?.referee;
  const weatherPartsZh = [
    weather?.condition ? multiText(weather.condition, 'zh') : '',
    Number.isFinite(weather?.temperatureC) ? `${weather?.temperatureC}°C` : '',
    Number.isFinite(weather?.windKph) ? `风速 ${weather?.windKph}km/h` : ''
  ].filter(Boolean).join('，');
  const weatherPartsEn = [
    weather?.condition ? multiText(weather.condition, 'en') : '',
    Number.isFinite(weather?.temperatureC) ? `${weather?.temperatureC}°C` : '',
    Number.isFinite(weather?.windKph) ? `wind ${weather?.windKph}km/h` : ''
  ].filter(Boolean).join(', ');
  const refereeZh = referee?.name
    ? `${referee.name}，场均牌 ${decimalText(referee.cardsPerMatch, 1)}，点球 ${decimalText(referee.penaltiesPerMatch, 2)}。`
    : '';
  const refereeEn = referee?.name
    ? `${referee.name}, cards ${decimalText(referee.cardsPerMatch, 1)}, penalties ${decimalText(referee.penaltiesPerMatch, 2)}.`
    : '';

  return {
    zh: [
      multiText(weather?.summary, 'zh'),
      weatherPartsZh ? `天气：${weatherPartsZh}。` : '',
      multiText(referee?.summary, 'zh'),
      refereeZh
    ].filter(Boolean).join(' '),
    en: [
      multiText(weather?.summary, 'en'),
      weatherPartsEn ? `Weather: ${weatherPartsEn}.` : '',
      multiText(referee?.summary, 'en'),
      refereeEn
    ].filter(Boolean).join(' ')
  };
};

const xgAndExternalOddsText = (match: Match): MultiLangString => {
  const signals = match.externalSignals;
  const xg = signals?.expectedGoals;
  const externalOdds = signals?.externalOdds;
  const xgZh = xg
    ? [
      multiText(xg.summary, 'zh'),
      Number.isFinite(xg.homeXg) || Number.isFinite(xg.awayXg)
        ? `xG ${decimalText(xg.homeXg)} / ${decimalText(xg.awayXg)}`
        : '',
      Number.isFinite(xg.homeXga) || Number.isFinite(xg.awayXga)
        ? `xGA ${decimalText(xg.homeXga)} / ${decimalText(xg.awayXga)}`
        : ''
    ].filter(Boolean).join('，')
    : '';
  const xgEn = xg
    ? [
      multiText(xg.summary, 'en'),
      Number.isFinite(xg.homeXg) || Number.isFinite(xg.awayXg)
        ? `xG ${decimalText(xg.homeXg)} / ${decimalText(xg.awayXg)}`
        : '',
      Number.isFinite(xg.homeXga) || Number.isFinite(xg.awayXga)
        ? `xGA ${decimalText(xg.homeXga)} / ${decimalText(xg.awayXga)}`
        : ''
    ].filter(Boolean).join(', ')
    : '';
  const oddsZh = externalOdds?.odds1 && externalOdds?.oddsX && externalOdds?.odds2
    ? `${externalOdds.source || '外部'}参考：${externalOdds.odds1.toFixed(2)} / ${externalOdds.oddsX.toFixed(2)} / ${externalOdds.odds2.toFixed(2)}。${multiText(externalOdds.summary, 'zh')}`
    : multiText(externalOdds?.summary, 'zh');
  const oddsEn = externalOdds?.odds1 && externalOdds?.oddsX && externalOdds?.odds2
    ? `${externalOdds.source || 'External'} reference: ${externalOdds.odds1.toFixed(2)} / ${externalOdds.oddsX.toFixed(2)} / ${externalOdds.odds2.toFixed(2)}. ${multiText(externalOdds.summary, 'en')}`
    : multiText(externalOdds?.summary, 'en');

  return {
    zh: [xgZh, oddsZh].filter(Boolean).join(' '),
    en: [xgEn, oddsEn].filter(Boolean).join(' ')
  };
};

const percentageFromRatio = (value: number | null | undefined) => {
  if (!Number.isFinite(value)) return '--';
  const numeric = Number(value);
  return `${Math.round(Math.abs(numeric) <= 1 ? numeric * 100 : numeric)}%`;
};

const fiveHundredBasicsText = (match: Match): MultiLangString => {
  const signal = match.externalSignals?.fiveHundred;
  if (!signal) return { zh: '', en: '' };

  const homeRank = signal.rank?.home?.fifaRank;
  const awayRank = signal.rank?.away?.fifaRank;
  const homeForm = signal.recentForm?.home;
  const awayForm = signal.recentForm?.away;
  const homeGap = signal.futureSchedule?.home?.nextGapDays;
  const awayGap = signal.futureSchedule?.away?.nextGapDays;
  const zhParts = [
    Number.isFinite(homeRank) || Number.isFinite(awayRank)
      ? `500补充排名：${match.homeTeamName || '主队'} ${homeRank ?? '--'}，${match.awayTeamName || '客队'} ${awayRank ?? '--'}。`
      : '',
    homeForm?.sampleSize || awayForm?.sampleSize
      ? `500近况：${match.homeTeamName || '主队'} ${homeForm?.sampleSize ?? 0}场${homeForm?.record || '--'}，${match.awayTeamName || '客队'} ${awayForm?.sampleSize ?? 0}场${awayForm?.record || '--'}。`
      : '',
    Number.isFinite(homeGap) || Number.isFinite(awayGap)
      ? `后续赛程间隔：主${homeGap ?? '--'}天 / 客${awayGap ?? '--'}天。`
      : ''
  ].filter(Boolean);
  const enParts = [
    Number.isFinite(homeRank) || Number.isFinite(awayRank)
      ? `500 rank supplement: ${match.homeTeamNameEn || match.homeTeamName || 'Home'} ${homeRank ?? '--'}, ${match.awayTeamNameEn || match.awayTeamName || 'Away'} ${awayRank ?? '--'}.`
      : '',
    homeForm?.sampleSize || awayForm?.sampleSize
      ? `500 recent form: ${match.homeTeamNameEn || match.homeTeamName || 'Home'} ${homeForm?.sampleSize ?? 0} matches ${homeForm?.record || '--'}, ${match.awayTeamNameEn || match.awayTeamName || 'Away'} ${awayForm?.sampleSize ?? 0} matches ${awayForm?.record || '--'}.`
      : '',
    Number.isFinite(homeGap) || Number.isFinite(awayGap)
      ? `Next fixture gap: home ${homeGap ?? '--'}d / away ${awayGap ?? '--'}d.`
      : ''
  ].filter(Boolean);

  return {
    zh: zhParts.join(' '),
    en: enParts.join(' ')
  };
};

const fiveHundredMarketText = (match: Match): MultiLangString => {
  const signal = match.externalSignals?.fiveHundred;
  if (!signal) return { zh: '', en: '' };

  const europe = signal.europeOdds;
  const asian = signal.asianHandicap;
  const consensus = signal.marketConsensus;
  const europeAverage = europe?.currentAverage;
  const europeProbability = europe?.currentProbabilityAverage;
  const notes = consensus?.notes || [];
  const risk = consensus?.riskLevel || 'low';
  const zhParts = [
    europeAverage
      ? `500欧赔均值(${europe?.companies || 0}家)：${oddsText(europeAverage)}，折算 ${percentageFromRatio(europeProbability?.home)} / ${percentageFromRatio(europeProbability?.draw)} / ${percentageFromRatio(europeProbability?.away)}。`
      : '',
    Number.isFinite(asian?.currentAverageLine)
      ? `500亚盘均线(${asian?.companies || 0}家)：${decimalText(asian?.currentAverageLine, 2)}，变化 ${decimalText(asian?.lineMovement, 2)}。`
      : '',
    notes.length ? `盘口备注：${notes.join('；')}。` : '',
    `500风险层级：${risk}。`
  ].filter(Boolean);
  const enParts = [
    europeAverage
      ? `500 Europe average (${europe?.companies || 0} books): ${oddsText(europeAverage)}, implied ${percentageFromRatio(europeProbability?.home)} / ${percentageFromRatio(europeProbability?.draw)} / ${percentageFromRatio(europeProbability?.away)}.`
      : '',
    Number.isFinite(asian?.currentAverageLine)
      ? `500 Asian line average (${asian?.companies || 0} books): ${decimalText(asian?.currentAverageLine, 2)}, movement ${decimalText(asian?.lineMovement, 2)}.`
      : '',
    notes.length ? `Market notes: ${notes.join('; ')}.` : '',
    `500 risk layer: ${risk}.`
  ].filter(Boolean);

  return {
    zh: zhParts.join(' '),
    en: enParts.join(' ')
  };
};

const probabilityText = (probabilities: { home: number; draw: number; away: number } | null | undefined) => {
  if (!probabilities) return { zh: '--', en: '--' };
  return {
    zh: `主 ${percentText(probabilities.home)} / 平 ${percentText(probabilities.draw)} / 客 ${percentText(probabilities.away)}`,
    en: `H ${percentText(probabilities.home)} / D ${percentText(probabilities.draw)} / A ${percentText(probabilities.away)}`
  };
};

const dateText = (iso: string | null | undefined) => {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
};

type FormSide = NonNullable<NonNullable<Match['probabilityModel']>['form']>['home'];

const recordText = (form: FormSide | undefined | null) => {
  if (!form || !form.sampleSize) return '0-0-0';
  return `${form.wins}-${form.draws}-${form.losses}`;
};

const formLineZh = (name: string | undefined, form: FormSide | undefined | null) => {
  const team = name || '球队';
  if (!form || !form.sampleSize) {
    return `${team}暂无近一年同源完场样本`;
  }

  return `${team}${form.sampleSize}场 ${recordText(form)}，场均${decimalText(form.goalsForAvg)}进/${decimalText(form.goalsAgainstAvg)}失，PPG ${decimalText(form.pointsPerMatch)}，大2.5 ${rateText(form.over25Rate)}，双方进球 ${rateText(form.bttsRate)}`;
};

const formLineEn = (name: string | undefined, form: FormSide | undefined | null) => {
  const team = name || 'Team';
  if (!form || !form.sampleSize) {
    return `${team}: no last-year same-source finished sample`;
  }

  return `${team}: ${form.sampleSize} matches ${recordText(form)}, ${decimalText(form.goalsForAvg)} GF/${decimalText(form.goalsAgainstAvg)} GA per match, PPG ${decimalText(form.pointsPerMatch)}, over 2.5 ${rateText(form.over25Rate)}, BTTS ${rateText(form.bttsRate)}`;
};

const restLineZh = (name: string | undefined, form: FormSide | undefined | null) => {
  const team = name || '球队';
  const rest = Number.isFinite(form?.restDays)
    ? `距离上一场约 ${form?.restDays} 天`
    : '暂无上一场时间';
  return `${team}：${rest}，近14天 ${form?.matchesLast14 ?? 0} 场，近30天 ${form?.matchesLast30 ?? 0} 场，上一场 ${dateText(form?.lastMatchAt)}`;
};

const restLineEn = (name: string | undefined, form: FormSide | undefined | null) => {
  const team = name || 'Team';
  const rest = Number.isFinite(form?.restDays)
    ? `about ${form?.restDays} days since last match`
    : 'no comparable previous match time';
  return `${team}: ${rest}, ${form?.matchesLast14 ?? 0} match(es) in 14 days, ${form?.matchesLast30 ?? 0} in 30 days, previous ${dateText(form?.lastMatchAt)}`;
};

const rankOrStrengthLine = (match: Match) => {
  const model = match.probabilityModel;
  const hasRank = Boolean(match.homeRank || match.awayRank);
  if (hasRank) {
    return {
      zh: `官网排名：${match.homeTeamName || '主队'} ${match.homeRank || '--'}，${match.awayTeamName || '客队'} ${match.awayRank || '--'}；最终概率 ${probabilityText(model?.oneXTwo?.final).zh}。`,
      en: `Official rank: ${match.homeTeamNameEn || 'Home'} ${match.homeRank || '--'}, ${match.awayTeamNameEn || 'Away'} ${match.awayRank || '--'}; final probability ${probabilityText(model?.oneXTwo?.final).en}.`
    };
  }

  if (model?.elo) {
    return {
      zh: `本场官网没有返回积分排名，改用 Elo 强度：${model.elo.homeRating} vs ${model.elo.awayRating}，主场修正后差值 ${signedText(model.elo.diff)}；最终概率 ${probabilityText(model.oneXTwo?.final).zh}。`,
      en: `No official table rank returned for this fixture, so Elo strength is used: ${model.elo.homeRating} vs ${model.elo.awayRating}, home-adjusted diff ${signedText(model.elo.diff)}; final probability ${probabilityText(model.oneXTwo?.final).en}.`
    };
  }

  return {
    zh: `以官方 HAD 去水概率做基础强弱：${probabilityText(model?.oneXTwo?.market).zh}。`,
    en: `Baseline strength uses normalized official HAD: ${probabilityText(model?.oneXTwo?.market).en}.`
  };
};

const goalModelLine = (match: Match) => {
  const model = match.probabilityModel;
  const lambda = model?.lambdaBlend;
  const scoreTop = model?.scoreDistribution?.slice(0, 3).map((score) => `${score.label} ${percentText(score.probability)}`).join('、') || '--';
  return {
    zh: `预期进球：主 ${decimalText(lambda?.marketHomeLambda)} / 客 ${decimalText(lambda?.marketAwayLambda)}，历史修正权重 ${percentText(lambda ? lambda.formWeight * 100 : null)}；大2.5 ${percentText(model?.goalLines?.over25)}，双方进球 ${percentText(model?.bothTeamsToScore?.yes)}，高频比分 ${scoreTop}。`,
    en: `Expected goals: home ${decimalText(lambda?.marketHomeLambda)} / away ${decimalText(lambda?.marketAwayLambda)}, form weight ${percentText(lambda ? lambda.formWeight * 100 : null)}; over 2.5 ${percentText(model?.goalLines?.over25)}, BTTS ${percentText(model?.bothTeamsToScore?.yes)}, top scores ${scoreTop}.`
  };
};

const contextSignalLines = (match: Match) => {
  const contextSignals = match.probabilityModel?.contextSignals;
  const attack = contextSignals?.attackIntent;
  const ranking = contextSignals?.rankingPressure;
  const discipline = contextSignals?.discipline;
  const dataGaps = contextSignals?.dataGaps;
  const attackZh = attack
    ? `进攻欲望：主 ${attack.home ?? '--'} / 客 ${attack.away ?? '--'} / 总 ${attack.total ?? '--'}，lambda 微调 ${decimalText(attack.lambdaTotalAdjustment, 3)}。`
    : '进攻欲望：暂无可用结构化信号。';
  const attackEn = attack
    ? `Attack intent: home ${attack.home ?? '--'} / away ${attack.away ?? '--'} / total ${attack.total ?? '--'}, lambda adjustment ${decimalText(attack.lambdaTotalAdjustment, 3)}.`
    : 'Attack intent: no structured signal available.';
  const rankingZh = ranking
    ? `排名/战意压力：主 ${ranking.home ?? '--'} / 客 ${ranking.away ?? '--'}，最高压力 ${ranking.maxPressure ?? '--'}，轮换风险 ${percentText(Number(ranking.rotationRisk ?? 0) * 100)}。`
    : '排名/战意压力：暂无可用结构化信号。';
  const rankingEn = ranking
    ? `Ranking/motivation pressure: home ${ranking.home ?? '--'} / away ${ranking.away ?? '--'}, max pressure ${ranking.maxPressure ?? '--'}, rotation risk ${percentText(Number(ranking.rotationRisk ?? 0) * 100)}.`
    : 'Ranking/motivation pressure: no structured signal available.';
  const disciplineZh = discipline
    ? `纪律风险：预计黄牌 ${decimalText(discipline.expectedYellowCards?.total, 1)}，红牌风险 ${percentText(Number(discipline.redCardRisk?.total ?? 0) * 100)}，犯规压力 ${discipline.foulPressure ?? '--'}。`
    : '纪律风险：暂无裁判/牌数结构化信号。';
  const disciplineEn = discipline
    ? `Discipline risk: expected yellows ${decimalText(discipline.expectedYellowCards?.total, 1)}, red-card risk ${percentText(Number(discipline.redCardRisk?.total ?? 0) * 100)}, foul pressure ${discipline.foulPressure ?? '--'}.`
    : 'Discipline risk: no structured card/referee signal available.';
  const missingZh = (dataGaps?.missing || []).slice(0, 4).map((item) => item.zh || item.key).filter(Boolean).join('、');
  const missingEn = (dataGaps?.missing || []).slice(0, 4).map((item) => item.en || item.key).filter(Boolean).join(', ');
  const gapZh = dataGaps
    ? `数据完整度 ${dataGaps.coverageScore ?? '--'}，质量 ${dataGaps.sourceQuality || '--'}；主要缺口：${missingZh || '暂无关键缺口'}。缺口会降低信心分，不会用估算数据冒充真实源。`
    : '数据缺口：暂无结构化缺口画像。';
  const gapEn = dataGaps
    ? `Data coverage ${dataGaps.coverageScore ?? '--'}, quality ${dataGaps.sourceQuality || '--'}; main gaps: ${missingEn || 'no major gap'}. Gaps reduce confidence and estimated data is not treated as verified source.`
    : 'Data gaps: no structured gap profile available.';

  return {
    attack: { zh: attackZh, en: attackEn },
    ranking: { zh: rankingZh, en: rankingEn },
    discipline: { zh: disciplineZh, en: disciplineEn },
    dataGaps: { zh: gapZh, en: gapEn }
  };
};

const h2hLine = (match: Match, context: MatchInsightContext) => {
  const h2h = match.probabilityModel?.form?.h2h;
  if (!h2h || !h2h.sampleSize) {
    return {
      zh: `近一年同源历史库未匹配到直接交锋，当前更看重双方各自 ${context.homeSampleSize}/${context.awaySampleSize} 场样本和盘口快照。`,
      en: `No direct H2H matched in the last-year same-source history set, so the model weights each side's ${context.homeSampleSize}/${context.awaySampleSize} samples and SP snapshots more.`
    };
  }

  return {
    zh: `近一年直接交锋 ${h2h.sampleSize} 场，最近一次 ${dateText(h2h.lastMeetingAt)}；大2.5 ${rateText(h2h.over25Rate)}，双方进球 ${rateText(h2h.bttsRate)}，平局率 ${rateText(h2h.drawRate)}。`,
    en: `${h2h.sampleSize} direct H2H records in the last year, latest ${dateText(h2h.lastMeetingAt)}; over 2.5 ${rateText(h2h.over25Rate)}, BTTS ${rateText(h2h.bttsRate)}, draw rate ${rateText(h2h.drawRate)}.`
  };
};

const buildProfessionalFramework = ({
  match,
  context,
  primary,
  tipZh,
  tipEn,
  action,
  trustScore,
  hadSupport,
  hhadSupport,
  sampleText,
  sampleEnough,
  trendText,
  riskTextZh,
  riskTextEn
}: {
  match: Match;
  context: MatchInsightContext;
  primary?: PredictionDetail;
  tipZh: string;
  tipEn: string;
  action: MultiLangString;
  trustScore: number;
  hadSupport: number | null;
  hhadSupport: number | null;
  sampleText: string;
  sampleEnough: boolean;
  trendText: MultiLangString | null;
  riskTextZh: string;
  riskTextEn: string;
}): MatchInsightPoint[] => {
  const model = match.probabilityModel;
  const form = model?.form;
  const hasPrimary = Boolean(primary);
  const isReferenceOnly = primary?.recommendationAction === 'reference' || primary?.recommendationTier === 'reference';
  const isWatchOnly = primary?.tipCode === 'WATCH';
  const hasActionablePrimary = Boolean(primary && !isWatchOnly && !isReferenceOnly);
  const resolvedOdds = getResolvedMatchOdds(match);
  const latestOdds = oddsText(resolvedOdds.had?.odds);
  const latestHandicapOdds = oddsText(resolvedOdds.hhad?.odds);
  const rankLine = rankOrStrengthLine(match);
  const goalLine = goalModelLine(match);
  const contextLines = contextSignalLines(match);
  const directH2h = h2hLine(match, context);
  const finalProbabilities = probabilityText(model?.oneXTwo?.final);
  const marketProbabilities = probabilityText(model?.oneXTwo?.market);
  const handicapProbabilities = probabilityText(model?.handicap?.market);
  const hhadLine = match.handicapLine ? `${match.handicapLine}` : '--';
  const primaryUsesHhad = primary?.oddsPoolCode === 'HHAD';
  const hadReferenceZh = latestOdds === '--' ? '普通胜平负未开售' : `普通胜平负 SP ${latestOdds} 用于校验`;
  const hadReferenceEn = latestOdds === '--' ? 'HAD is not on sale' : `HAD SP ${latestOdds} is reference only`;
  const marketAnchorNote = primaryUsesHhad
    ? {
      zh: `${hadReferenceZh}；官方 HHAD(${hhadLine})：${latestHandicapOdds}，去水 ${handicapProbabilities.zh}，当前让球主线支持 ${percentText(hadSupport)}。`,
      en: `${hadReferenceEn}; official HHAD(${hhadLine}): ${latestHandicapOdds}, normalized ${handicapProbabilities.en}, handicap anchor support ${percentText(hadSupport)}.`
    }
    : {
      zh: `官方 HAD：${latestOdds}，去水 ${marketProbabilities.zh}，当前主线支持 ${percentText(hadSupport)}；官方 HHAD(${hhadLine})：${latestHandicapOdds}，去水 ${handicapProbabilities.zh}；让球同向支持约 ${hhadSupport === null ? '--' : `${hhadSupport}%`}。`,
      en: `Official HAD: ${latestOdds}, normalized ${marketProbabilities.en}, main-line support ${percentText(hadSupport)}; official HHAD(${hhadLine}): ${latestHandicapOdds}, normalized ${handicapProbabilities.en}; same-side handicap support ${hhadSupport === null ? '--' : `${hhadSupport}%`}.`
    };
  const marketToneSupport = primaryUsesHhad ? hadSupport : hhadSupport;
  const trendZh = match.oddsTrend && trendText
    ? `${match.oddsTrend.summary.zh}`
    : '官方赔率快照样本仍在积累，先以最新胜平负/让球为准。';
  const trendEn = match.oddsTrend && trendText
    ? `${match.oddsTrend.summary.en}`
    : 'Official odds snapshots are still accumulating; use latest 1X2 / handicap first.';
  const lineupSignals = lineupsSignalText(match);
  const environmentSignals = environmentSignalText(match);
  const xgOddsSignals = xgAndExternalOddsText(match);
  const fiveHundredBasics = fiveHundredBasicsText(match);
  const fiveHundredMarket = fiveHundredMarketText(match);
  const unavailableTone: InsightTone = 'muted';
  const sampleTone: InsightTone = sampleEnough ? 'success' : 'warning';
  const goalTone: InsightTone = (model?.goalLines?.over25 ?? 0) >= 58 || (model?.bothTeamsToScore?.yes ?? 0) >= 58 ? 'success' : 'warning';

  return [
    {
      title: { zh: '一、比赛基本面', en: '1. Fixture Baseline' },
      body: {
        zh: `${match.leagueName || '赛事'}：${match.homeTeamName || '主队'} vs ${match.awayTeamName || '客队'}。${rankLine.zh}${fiveHundredBasics.zh ? ` ${fiveHundredBasics.zh}` : ''}`,
        en: `${match.leagueNameEn || match.leagueName || 'Fixture'}: ${match.homeTeamName || 'Home'} vs ${match.awayTeamName || 'Away'}. ${rankLine.en}${fiveHundredBasics.en ? ` ${fiveHundredBasics.en}` : ''}`
      },
      tone: model?.elo || match.homeRank || match.awayRank || fiveHundredBasics.zh ? 'success' : 'warning'
    },
    {
      title: { zh: '二、近期状态', en: '2. Recent Form' },
      body: {
        zh: `${formLineZh(match.homeTeamName, form?.home)}；${formLineZh(match.awayTeamName, form?.away)}。样本 ${sampleText}，${sampleEnough ? '可进入辅助评分' : '样本权重较轻'}。`,
        en: `${formLineEn(match.homeTeamNameEn || match.homeTeamName, form?.home)}; ${formLineEn(match.awayTeamNameEn || match.awayTeamName, form?.away)}. Sample ${sampleText}; ${sampleEnough ? 'usable as secondary scoring input' : 'lighter sample weight'}.`
      },
      tone: sampleTone
    },
    {
      title: { zh: '三、主客场表现', en: '3. Home/Away' },
      body: {
        zh: `结合近一年官方完场样本、主客场位置和赛程节奏评估主客表现。覆盖：${context.coverageLabel}；样本分布主队 ${context.homeSampleSize} 场、客队 ${context.awaySampleSize} 场。`,
        en: `Home/away read combines last-year official finished samples, fixture venue, and schedule rhythm. Coverage: ${context.coverageLabel}; samples home ${context.homeSampleSize}, away ${context.awaySampleSize}.`
      },
      tone: sampleTone
    },
    {
      title: { zh: '四、进攻能力', en: '4. Attack' },
      body: {
        zh: `${goalLine.zh} 近况进攻：${match.homeTeamName || '主队'}场均 ${decimalText(form?.home?.goalsForAvg)}，${match.awayTeamName || '客队'}场均 ${decimalText(form?.away?.goalsForAvg)}。`,
        en: `${goalLine.en} Recent attack: ${match.homeTeamNameEn || 'Home'} ${decimalText(form?.home?.goalsForAvg)} per match, ${match.awayTeamNameEn || 'Away'} ${decimalText(form?.away?.goalsForAvg)} per match.`
      },
      tone: goalTone
    },
    {
      title: { zh: '四补、进攻欲望', en: '4b. Attack Intent' },
      body: contextLines.attack,
      tone: (model?.contextSignals?.attackIntent?.total ?? 50) >= 62
        ? 'success'
        : (model?.contextSignals?.attackIntent?.total ?? 50) <= 42
          ? 'warning'
          : 'muted'
    },
    {
      title: { zh: '五、防守能力', en: '5. Defense' },
      body: {
        zh: `${match.homeTeamName || '主队'}场均失 ${decimalText(form?.home?.goalsAgainstAvg)}，零封 ${rateText(form?.home?.cleanSheetRate)}，被零封 ${rateText(form?.home?.failedScoreRate)}；${match.awayTeamName || '客队'}场均失 ${decimalText(form?.away?.goalsAgainstAvg)}，零封 ${rateText(form?.away?.cleanSheetRate)}，被零封 ${rateText(form?.away?.failedScoreRate)}。`,
        en: `${match.homeTeamNameEn || 'Home'} concedes ${decimalText(form?.home?.goalsAgainstAvg)}, clean sheets ${rateText(form?.home?.cleanSheetRate)}, failed to score ${rateText(form?.home?.failedScoreRate)}; ${match.awayTeamNameEn || 'Away'} concedes ${decimalText(form?.away?.goalsAgainstAvg)}, clean sheets ${rateText(form?.away?.cleanSheetRate)}, failed to score ${rateText(form?.away?.failedScoreRate)}.`
      },
      tone: form?.home?.sampleSize || form?.away?.sampleSize ? 'success' : 'warning'
    },
    {
      title: { zh: '六、伤停与首发', en: '6. Injuries / XI' },
      body: {
        zh: lineupSignals.zh
          ? `阵容信息纳入赛前信息层：${lineupSignals.zh} 结合官方赔率与让球盘变化校验阵容影响。`
          : `阵容信息纳入赛前信息层，重点关注主力前锋、核心中场、中卫、后腰与门将可用性；并结合官方赔率与让球盘变化校验阵容影响。${dataCoverage.zh}`,
        en: lineupSignals.en
          ? `Team-news signals are folded into the pre-match layer: ${lineupSignals.en} Official odds and handicap movement validate lineup impact.`
          : `Team-news signals are folded into the pre-match layer, especially striker, core midfield, centre-back, holding midfield, and goalkeeper availability. Official odds and handicap movement validate lineup impact. ${dataCoverage.en}`
      },
      tone: 'warning'
    },
    {
      title: { zh: '六补、数据缺口校验', en: '6b. Data Gap Check' },
      body: contextLines.dataGaps,
      tone: model?.contextSignals?.dataGaps?.sourceQuality === 'low'
        ? 'danger'
        : model?.contextSignals?.dataGaps?.sourceQuality === 'medium'
          ? 'warning'
          : 'success'
    },
    {
      title: { zh: '七、战术克制', en: '7. Tactics' },
      body: {
        zh: `用进球分布替代空泛战术判断：大2.5 ${percentText(model?.goalLines?.over25)}、双方进球 ${percentText(model?.bothTeamsToScore?.yes)}、最终平局概率 ${percentText(model?.oneXTwo?.final?.draw)}。${(model?.goalLines?.over25 ?? 0) >= 55 ? '节奏倾向开放。' : '节奏不宜高估。'}`,
        en: `Goal distribution is used instead of vague tactical claims: over 2.5 ${percentText(model?.goalLines?.over25)}, BTTS ${percentText(model?.bothTeamsToScore?.yes)}, final draw probability ${percentText(model?.oneXTwo?.final?.draw)}. ${(model?.goalLines?.over25 ?? 0) >= 55 ? 'Tempo leans open.' : 'Tempo should not be overestimated.'}`
      },
      tone: goalTone
    },
    {
      title: { zh: '八、赛程体能与战意', en: '8. Schedule / Motivation' },
      body: {
        zh: `${restLineZh(match.homeTeamName, form?.home)}；${restLineZh(match.awayTeamName, form?.away)}。杯赛/争冠/保级动机仅在可验证赛程阶段明确时才加权。`,
        en: `${restLineEn(match.homeTeamNameEn || match.homeTeamName, form?.home)}; ${restLineEn(match.awayTeamNameEn || match.awayTeamName, form?.away)}. Cup/title/relegation motivation is weighted only when the fixture stage is verifiable.`
      },
      tone: sampleTone
    },
    {
      title: { zh: '八补、排名战意压力', en: '8b. Ranking Pressure' },
      body: contextLines.ranking,
      tone: (model?.contextSignals?.rankingPressure?.maxPressure ?? 0) >= 70 ? 'warning' : 'muted'
    },
    {
      title: { zh: '九、历史交锋', en: '9. H2H' },
      body: directH2h,
      tone: context.h2hSampleSize > 0 ? 'success' : 'warning'
    },
    {
      title: { zh: '十、天气场地裁判', en: '10. Weather / Referee' },
      body: {
        zh: environmentSignals.zh
          ? `环境风险层：${environmentSignals.zh} 结合盘口变化判断比赛波动。`
          : '天气、场地与裁判进入环境风险层：重点观察极端天气、场地速度、长途客场、出牌尺度、点球与红牌倾向，并结合盘口变化判断比赛波动。',
        en: environmentSignals.en
          ? `Environment-risk layer: ${environmentSignals.en} Market movement is used to judge volatility.`
          : 'Weather, pitch, and referee profile sit in the environment-risk layer: extreme weather, pitch speed, travel, cards, penalties, and red-card tendency are checked against market movement for volatility.'
      },
      tone: 'warning'
    },
    {
      title: { zh: '十补、纪律与红牌风险', en: '10b. Cards / Red-Card Risk' },
      body: contextLines.discipline,
      tone: (model?.contextSignals?.discipline?.redCardRisk?.total ?? 0) >= 0.17
        ? 'danger'
        : (model?.contextSignals?.discipline?.expectedYellowCards?.total ?? 0) >= 5.2
          ? 'warning'
          : 'muted'
    },
    {
      title: { zh: '十一、赔率盘口', en: '11. Odds / Market' },
      body: {
        zh: `${marketAnchorNote.zh}${trendZh}${xgOddsSignals.zh ? ` ${xgOddsSignals.zh}` : ''}${fiveHundredMarket.zh ? ` ${fiveHundredMarket.zh}` : ''}`,
        en: `${marketAnchorNote.en} ${trendEn}${xgOddsSignals.en ? ` ${xgOddsSignals.en}` : ''}${fiveHundredMarket.en ? ` ${fiveHundredMarket.en}` : ''}`
      },
      tone: marketToneSupport !== null && marketToneSupport >= 42 ? 'success' : 'warning'
    },
    {
      title: { zh: '十二、综合结论', en: '12. Verdict' },
      body: {
        zh: hasActionablePrimary
          ? `稳妥方向：${action.zh}；主线 ${tipZh}，推荐强度 ${trustScore || '--'}%，当前判断 ${finalProbabilities.zh}。风险点：${riskTextZh}。`
          : `稳妥方向：先观察，不输出单一胜平负；当前判断 ${finalProbabilities.zh}，等待赔率、让球盘和历史表现进一步同向。风险点：${riskTextZh}。`,
        en: hasActionablePrimary
          ? `Conservative: ${action.en}; main line ${tipEn}, pick strength ${trustScore || '--'}%, current read ${finalProbabilities.en}. Risks: ${riskTextEn}.`
          : `Conservative: ${action.en}, no single 1X2 pick; current read ${finalProbabilities.en}, wait for odds/handicap/history buckets to align. Risks: ${riskTextEn}.`
      },
      tone: hasPrimary ? (isWatchOnly || isReferenceOnly ? 'warning' : 'success') : unavailableTone
    }
  ];
};

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
  const isReferenceOnly = primary?.recommendationAction === 'reference' || primary?.recommendationTier === 'reference';
  const isWatchOnly = primary?.tipCode === 'WATCH';
  const signal = getMatchSignal(match);
  const resultCode = isResultCode(primary?.tipCode) ? primary.tipCode : undefined;
  const resolvedOdds = getResolvedMatchOdds(match);
  const latestHadOdds = oddsText(resolvedOdds.had?.odds);
  const latestHhadOdds = oddsText(resolvedOdds.hhad?.odds);
  const hadProbabilities = getImpliedProbabilities(resolvedOdds.had?.odds);
  const hhadProbabilities = getImpliedProbabilities(resolvedOdds.hhad?.odds);
  const hadSupport = pickProbability(hadProbabilities, resultCode);
  const hhadSupport = pickProbability(hhadProbabilities, resultCode);
  const primaryUsesHhad = primary?.oddsPoolCode === 'HHAD';
  const mainSupport = primaryUsesHhad ? hhadSupport : hadSupport;
  const mainOddsText = primaryUsesHhad ? latestHhadOdds : latestHadOdds;
  const mainSupportLabel = primaryUsesHhad
    ? { zh: '让球支持', en: 'HHAD support' }
    : { zh: 'HAD支持', en: 'HAD support' };
  const mainAnchorLabel = primaryUsesHhad
    ? { zh: '让球胜平负主线', en: 'Handicap 1X2 anchor' }
    : { zh: '胜平负主线', en: '1X2 anchor' };
  const mainOddsLabel = primaryUsesHhad
    ? { zh: `官方让球(${match.handicapLine || '--'})赔率`, en: `Official handicap(${match.handicapLine || '--'}) odds` }
    : { zh: '官方胜平负赔率', en: 'Official 1X2 odds' };
  const riskTags = primary?.riskTags || [];
  const riskTextZh = riskTags.length ? riskTags.map((tag) => tag.zh).join('、') : '暂无明显风险提示';
  const riskTextEn = riskTags.length ? riskTags.map((tag) => tag.en).join(', ') : 'no major risk notes';
  const sampleText = `${context.homeSampleSize}/${context.awaySampleSize}/${context.h2hSampleSize}`;
  const sampleEnough = context.homeSampleSize >= 3 && context.awaySampleSize >= 3;
  const trendText = match.oddsTrend ? trendLabel(match.oddsTrend.direction) : null;
  const actionByCategory: Record<typeof signal.category, MultiLangString> = {
    steady: { zh: '推荐', en: 'Pick' },
    lean: { zh: '推荐', en: 'Pick' },
    value: { zh: '冷门复核', en: 'Upset recheck' },
    watch: { zh: '待开售', en: 'Pending sale' },
    avoid: { zh: '临场复核', en: 'Late recheck' },
    unavailable: { zh: '等待开售', en: 'Wait for sale' },
    finished: { zh: '赛后复盘', en: 'Post-match review' }
  };
  const toneByCategory: Record<typeof signal.category, InsightTone> = {
    steady: 'success',
    lean: 'success',
    value: 'warning',
    watch: 'warning',
    avoid: 'warning',
    unavailable: 'muted',
    finished: 'muted'
  };
  const trustScore = primary?.trustScore || 0;
  const insightScore = primary
    ? clamp(Math.round(trustScore - riskTags.length * 4 + (sampleEnough ? 3 : -4) + (match.oddsTrend?.direction === 'mixed' ? -3 : 0)), 0, 99)
    : null;
  const tipZh = primary ? getPredictionTipDisplay(primary, 'zh', true) : '--';
  const tipEn = primary ? getPredictionTipDisplay(primary, 'en', true) : '--';
  const action = actionByCategory[signal.category];
  const tone = toneByCategory[signal.category];
  const framework = buildProfessionalFramework({
    match,
    context,
    primary,
    tipZh,
    tipEn,
    action,
    trustScore,
    hadSupport: mainSupport,
    hhadSupport,
    sampleText,
    sampleEnough,
    trendText,
    riskTextZh,
    riskTextEn
  });

  if (!primary && match.status === 'FINISHED') {
    return {
      title: { zh: '赛果归档', en: 'Result archived' },
      summary: {
        zh: '本场已完场，历史库仅保留官方赛果与可用赔率快照，不再按未开售比赛生成推荐。',
        en: 'This match is finished. The history store keeps official result and available SP snapshots without generating a pending-sale pick.'
      },
      action,
      score: null,
      tone,
      metrics: [
        { label: { zh: '主推', en: 'Pick' }, value: { zh: '--', en: '--' }, tone: 'muted' },
        { label: { zh: '官方赔率', en: 'Official odds' }, value: { zh: hadProbabilities ? '已归档' : '无快照', en: hadProbabilities ? 'Archived' : 'No snapshot' }, tone: hadProbabilities ? 'success' : 'muted' },
        { label: { zh: '让球赔率', en: 'Handicap odds' }, value: { zh: hhadProbabilities ? '已归档' : '无快照', en: hhadProbabilities ? 'Archived' : 'No snapshot' }, tone: hhadProbabilities ? 'success' : 'muted' },
        { label: { zh: '历史样本', en: 'History sample' }, value: { zh: sampleText, en: sampleText }, tone: sampleEnough ? 'success' : 'warning' }
      ],
      drivers: [
        {
          title: { zh: '归档状态', en: 'Archive state' },
          body: {
            zh: '完场比赛不显示“待开售”。若历史记录没有官方赔率快照，页面只展示赛果与复盘样本。',
            en: 'Finished matches are not shown as pending sale. If no official odds snapshot exists, only result and review samples are shown.'
          },
          tone: 'muted'
        }
      ],
      watchpoints: [
        {
          title: { zh: '复盘建议', en: 'Review note' },
          body: {
            zh: '后续回测只使用开赛前已保存的推荐与赔率快照，避免赛后补赔率造成数据泄漏。',
            en: 'Backtesting should only use pre-kickoff picks and odds snapshots to avoid post-match data leakage.'
          },
          tone: 'muted'
        }
      ],
      framework
    };
  }

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
            zh: `官方让球胜平负 SP 为 ${latestHhadOdds}，普通胜平负开售后再生成模型推荐。`,
            en: `Official handicap SP is ${latestHhadOdds}. Model pick will be generated after HAD opens.`
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
      ],
      framework
    };
  }

  if (isWatchOnly || isReferenceOnly) {
    return {
      title: isReferenceOnly
        ? { zh: '推荐方向', en: 'Pick Direction' }
        : { zh: '赛前分析模式', en: 'Pre-Match Analysis Mode' },
      summary: {
        zh: isReferenceOnly
          ? `${action.zh}：推荐方向为 ${tipZh}，推荐强度 ${trustScore || '--'}%。重点跟踪官方赔率、让球盘和近期命中冷却。风险提示：${riskTextZh}。`
          : `${action.zh}：当前等待官方赔率或临场信号补强；如果临场信号没有变，刷新页面也不会硬改原结论。风险提示：${riskTextZh}。`,
        en: isReferenceOnly
          ? `${action.en}: pick direction is ${tipEn}, pick strength ${trustScore || '--'}%. Track official odds, handicap confirmation, and hit-rate cooldown. Risk notes: ${riskTextEn}.`
          : `${action.en}: wait for official odds or late signals before forcing a single side. Risk notes: ${riskTextEn}.`
      },
      action,
      score: insightScore,
      tone,
      metrics: [
        { label: { zh: '决策状态', en: 'Decision' }, value: { zh: '需复核', en: 'Recheck' }, tone: 'warning' },
        { label: { zh: '主线输出', en: 'Main line' }, value: isReferenceOnly ? { zh: tipZh, en: tipEn } : { zh: '不硬推', en: 'No force' }, tone: isReferenceOnly ? 'warning' : 'muted' },
        { label: { zh: '让球校验', en: 'Handicap check' }, value: { zh: hhadProbabilities ? '已记录' : '未开售', en: hhadProbabilities ? 'Tracked' : 'Closed' }, tone: hhadProbabilities ? 'warning' : 'muted' },
        { label: { zh: '历史样本', en: 'History sample' }, value: { zh: sampleText, en: sampleText }, tone: sampleEnough ? 'success' : 'warning' }
      ],
      drivers: [
        {
          title: isReferenceOnly ? { zh: '为什么需要复核', en: 'Why recheck' } : { zh: '为什么不直接推荐', en: 'Why no pick' },
          body: primary.explanation || {
            zh: '当前低赔率、平局压力、让球确认或近期命中表现存在分歧，推荐方向需要临场复核。',
            en: 'Low odds, draw pressure, handicap confirmation, or recent hit-rate buckets are not aligned, so the pick needs a late recheck.'
          },
          tone: 'warning'
        },
        {
          title: { zh: '盘口验证', en: 'Market validation' },
          body: {
            zh: isReferenceOnly
              ? `官方胜平负：${latestHadOdds}；官方让球：${latestHhadOdds}。参考态只展示推荐倾向，不把条件未齐的方向包装成强推。`
              : `官方胜平负：${latestHadOdds}；官方让球：${latestHhadOdds}。参考态只展示赔率结构和风险，不展示“主线支持率”，避免把条件未齐的方向当推荐。`,
            en: isReferenceOnly
              ? `Official 1X2: ${latestHadOdds}; official handicap: ${latestHhadOdds}. Reference mode shows the pick lean without packaging an unqualified direction as a strong pick.`
              : `Official 1X2: ${latestHadOdds}; official handicap: ${latestHhadOdds}. Reference mode does not show a main-line support rate, so an unqualified direction is not packaged as a pick.`
          },
          tone: 'muted'
        },
        {
          title: { zh: '赔率走势', en: 'Odds movement' },
          body: match.oddsTrend && trendText
            ? {
              zh: `${match.oddsTrend.summary.zh}`,
              en: `${match.oddsTrend.summary.en}`
            }
            : {
              zh: '当前快照数量不足，先等待下一次官方赔率快照。',
              en: 'Not enough snapshots yet; wait for the next official odds capture.'
            },
          tone: match.oddsTrend?.direction === 'mixed' ? 'warning' : 'muted'
        }
      ],
      watchpoints: [
        {
          title: { zh: '临场触发条件', en: 'Late trigger' },
          body: {
            zh: '只有官方赔率、让球盘、方向优势和历史表现同时改善，才允许从观察升为推荐；否则页面刷新也只保留原观察结论。',
            en: 'If late odds and handicap remain split, keep watching. Upgrade only when edge, market confirmation, and historical buckets all improve.'
          },
          tone: 'warning'
        },
        {
          title: { zh: '赛前信息层', en: 'Pre-match signals' },
          body: dataCoverage,
          tone: 'warning'
        }
      ],
      framework
    };
  }

  const handicapBody = hhadSupport === null
    ? {
      zh: primaryUsesHhad ? '普通胜平负暂未开售，本场直接以让球胜平负作为预测锚点。' : '让球胜平负暂未形成可用验证，当前以 HAD 主盘为准。',
      en: primaryUsesHhad ? 'Standard 1X2 is not open, so HHAD is used as the prediction anchor.' : 'No usable handicap check yet, so HAD remains the anchor.'
    }
    : {
      zh: `让球盘同方向支持率约 ${hhadSupport}%，${hhadSupport >= 42 ? '与主线基本同向。' : '对主线支持偏弱，需要降温。'}`,
      en: `Handicap same-side support is about ${hhadSupport}%, ${hhadSupport >= 42 ? 'broadly aligned with the pick.' : 'weaker than the main direction.'}`
    };

  return {
    title: { zh: '综合推荐判断', en: 'Pick Decision Brief' },
    summary: {
      zh: `${action.zh}：当前主线为 ${tipZh}，${mainSupportLabel.zh} ${percentText(mainSupport)}，推荐强度 ${trustScore || '--'}%。风险提示：${riskTextZh}。`,
      en: `${action.en}: main lean is ${tipEn}, ${mainSupportLabel.en} ${percentText(mainSupport)}, pick strength ${trustScore || '--'}%. Risk notes: ${riskTextEn}.`
    },
    action,
    score: insightScore,
    tone,
    metrics: [
      { label: { zh: '主推', en: 'Pick' }, value: { zh: tipZh, en: tipEn }, tone },
      { label: mainSupportLabel, value: { zh: percentText(mainSupport), en: percentText(mainSupport) }, tone: mainSupport !== null && mainSupport >= 50 ? 'success' : 'warning' },
      { label: { zh: '让球验证', en: 'Handicap check' }, value: { zh: hhadSupport === null ? '--' : `${hhadSupport}%`, en: hhadSupport === null ? '--' : `${hhadSupport}%` }, tone: hhadSupport !== null && hhadSupport >= 42 ? 'success' : 'warning' },
      { label: { zh: '历史样本', en: 'History sample' }, value: { zh: sampleText, en: sampleText }, tone: sampleEnough ? 'success' : 'warning' }
    ],
    drivers: [
      {
        title: mainAnchorLabel,
        body: {
          zh: `${mainOddsLabel.zh} 为 ${mainOddsText}，${resultCode ? resultLabels[resultCode].zh : '首选方向'}去水支持率约 ${percentText(mainSupport)}。`,
          en: `${mainOddsLabel.en} is ${mainOddsText}; ${resultCode ? resultLabels[resultCode].en : 'top direction'} normalized support is about ${percentText(mainSupport)}.`
        },
        tone: mainSupport !== null && mainSupport >= 50 ? 'success' : 'warning'
      },
      {
        title: { zh: '让球验证', en: 'Handicap validation' },
        body: handicapBody,
        tone: hhadSupport !== null && hhadSupport >= 42 ? 'success' : 'warning'
      },
      {
        title: { zh: '赔率走势', en: 'Odds movement' },
        body: match.oddsTrend && trendText
          ? {
            zh: `已记录 ${match.oddsTrend.sampleSize} 次官方快照，当前表现为${trendText.zh}。${match.oddsTrend.summary.zh}`,
            en: `${match.oddsTrend.sampleSize} official snapshots recorded; movement is ${trendText.en}. ${match.oddsTrend.summary.en}`
          }
          : {
            zh: '当前快照数量不足，先以最新官方赔率与后续定时快照对比。',
            en: 'Not enough snapshots yet; compare the latest official odds with later scheduled captures.'
          },
        tone: match.oddsTrend?.direction === 'mixed' ? 'warning' : 'success'
      }
    ],
    watchpoints: [
      {
        title: { zh: '风险提示', en: 'Risk notes' },
        body: {
          zh: riskTags.length ? `需要重点关注：${riskTextZh}。` : '暂未触发明显风险提示，但仍需看临场赔率是否突变。',
          en: riskTags.length ? `Watch closely: ${riskTextEn}.` : 'No major risk note triggered, but late odds movement still matters.'
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
    ],
    framework
  };
}
