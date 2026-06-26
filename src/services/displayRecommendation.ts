import {
  getImpliedProbabilities,
  getOfficialMatchOdds,
  getOfficialResultPoolAvailability,
  getPredictionValueLabel,
  isPredictionOfficialResultPoolAvailable
} from './bettingDisplay';
import { getTeamById } from './entities';
import type { Match, PredictionDetail, Team } from './mockData';

type Language = 'zh' | 'en';

type OutcomeCode = '1' | 'X' | '2';
type OutcomeProbabilityTriplet = {
  home?: number | null;
  draw?: number | null;
  away?: number | null;
} | null | undefined;

type DisplayRecommendationKind = 'prediction' | 'handicap' | 'outcome' | 'score';

export interface DisplayRecommendationCompanion {
  kind: 'handicap';
  prediction: PredictionDetail;
  tipCode: string;
  label: string;
  title: string;
  meta: string;
  probability: number | null;
  support: number | null;
  reason: string;
}

export interface DisplayRecommendation {
  kind: DisplayRecommendationKind;
  prediction?: PredictionDetail;
  tipCode?: string;
  label: string;
  meta: string;
  probability: number | null;
  support: number | null;
  reason: string;
  companion?: DisplayRecommendationCompanion;
}

type RankedOutcome = { code: OutcomeCode; probability: number };

const isOutcomeCode = (code: string | undefined): code is OutcomeCode => code === '1' || code === 'X' || code === '2';

const isReferenceOnlyPrediction = (prediction?: PredictionDetail) => (
  prediction?.recommendationAction === 'reference' || prediction?.recommendationTier === 'reference'
);

const getMatchDisplayTeam = (match: Match, side: 'home' | 'away'): Team => {
  const base = getTeamById(side === 'home' ? match.homeTeamId : match.awayTeamId);
  const teamName = side === 'home' ? match.homeTeamName : match.awayTeamName;
  const teamNameEn = side === 'home' ? match.homeTeamNameEn : match.awayTeamNameEn;
  const teamLogo = side === 'home' ? match.homeTeamLogo : match.awayTeamLogo;
  const teamLogoType = side === 'home' ? match.homeTeamLogoType : match.awayTeamLogoType;
  const teamCountryIso = side === 'home' ? match.homeTeamCountryIso : match.awayTeamCountryIso;
  const teamColor = side === 'home' ? match.homeTeamColor : match.awayTeamColor;
  const teamValue = side === 'home' ? match.homeTeamValue : match.awayTeamValue;
  const nameZh = teamName || base.name.zh;
  const nameEn = teamNameEn || teamName || base.name.en;

  return {
    ...base,
    name: { zh: nameZh, en: nameEn },
    shortName: { zh: nameZh, en: nameEn },
    logo: teamLogoType === 'flag' && teamCountryIso
      ? teamCountryIso
      : teamLogo || teamCountryIso || base.logo,
    logoType: teamLogoType || base.logoType || (teamCountryIso ? 'flag' : undefined),
    value: teamValue || base.value,
    color: teamColor || base.color
  };
};

const getRankedOutcomeProbabilities = (probabilities: OutcomeProbabilityTriplet): RankedOutcome[] => ([
  { code: '1' as OutcomeCode, probability: probabilities?.home },
  { code: 'X' as OutcomeCode, probability: probabilities?.draw },
  { code: '2' as OutcomeCode, probability: probabilities?.away }
])
  .map((item) => ({ ...item, probability: Number(item.probability) }))
  .filter((item): item is RankedOutcome => Number.isFinite(item.probability))
  .sort((a, b) => b.probability - a.probability);

const getOutcomeProbability = (match: Match, code: OutcomeCode, prediction?: PredictionDetail) => {
  const final = prediction?.oddsPoolCode === 'HHAD'
    ? getHandicapModelProbabilities(match)
    : match.probabilityModel?.oneXTwo?.unifiedPosterior
      || match.probabilityModel?.oneXTwo?.final
      || match.probabilityModel?.oneXTwo?.market;
  if (!final) return null;
  const value = code === '1' ? final.home : code === 'X' ? final.draw : final.away;
  return Number.isFinite(value) ? Number(value) : null;
};

const getTopOutcomeFromProbabilities = (probabilities: OutcomeProbabilityTriplet) => (
  getRankedOutcomeProbabilities(probabilities)[0] || null
);

const getHandicapModelProbabilities = (match: Match) => (
  match.probabilityModel?.handicap?.unifiedPosterior
    || match.probabilityModel?.handicap?.scoreImplied
    || match.probabilityModel?.handicap?.poisson
    || match.probabilityModel?.handicap?.market
);

const getHandicapRead = (match: Match) => {
  const modelRows = getRankedOutcomeProbabilities(
    getHandicapModelProbabilities(match)
  );
  const resolvedOdds = getOfficialMatchOdds(match);
  const marketRows = getRankedOutcomeProbabilities(
    match.probabilityModel?.handicap?.market
      || getImpliedProbabilities(resolvedOdds.hhad?.odds)
  );
  const modelTop = modelRows[0] || null;
  const modelSecond = modelRows[1] || null;
  const marketTop = marketRows[0] || null;
  const marketSecond = marketRows[1] || null;
  const marketSupport = modelTop
    ? marketRows.find((item) => item.code === modelTop.code)?.probability ?? null
    : null;

  return {
    modelTop,
    modelGap: modelTop && modelSecond ? modelTop.probability - modelSecond.probability : 0,
    marketTop,
    marketGap: marketTop && marketSecond ? marketTop.probability - marketSecond.probability : 0,
    marketSupport,
    modelMarketSpread: modelTop && marketSupport !== null ? Math.abs(modelTop.probability - marketSupport) : null
  };
};

const isCloseHandicapDecision = (read: ReturnType<typeof getHandicapRead> | null | undefined) => (
  Boolean(read?.modelTop && read?.marketTop && Number(read.marketGap) <= 1.5)
);

const getCloseHandicapReason = (language: Language) => (
  language === 'zh'
    ? '让球胜负差距很小，本场按赛前综合信息给出当前推荐。'
    : 'The handicap sides are close, so this pick uses the full pre-match read.'
);

const isHandicapMarketContradicted = (match: Match, prediction?: PredictionDetail) => {
  if (prediction?.oddsPoolCode !== 'HHAD' || !isOutcomeCode(prediction.tipCode)) return false;
  const read = getHandicapRead(match);
  const support = read.marketSupport;
  return Boolean(
    read.modelTop
    && read.marketTop
    && read.modelTop.code === prediction.tipCode
    && read.marketTop.code !== prediction.tipCode
    && support !== null
    && support < 38
  );
};

const getOutcomeOddsValue = (match: Match, poolCode: 'HAD' | 'HHAD', code: OutcomeCode) => {
  const resolvedOdds = getOfficialMatchOdds(match);
  const odds = poolCode === 'HHAD' ? resolvedOdds.hhad?.odds : resolvedOdds.had?.odds;
  const value = code === '1' ? odds?.odds1 : code === 'X' ? odds?.oddsX : odds?.odds2;
  return Number.isFinite(value) ? Number(value) : 0;
};

const getSimpleHandicapLabel = (code: OutcomeCode, language: Language) => {
  if (language === 'zh') {
    if (code === '1') return '让胜';
    if (code === 'X') return '让平';
    return '让负';
  }

  if (code === '1') return 'Handicap home';
  if (code === 'X') return 'Handicap draw';
  return 'Handicap away';
};

const getSimpleOutcomeLabel = (match: Match, code: OutcomeCode, language: Language) => {
  const homeTeam = getMatchDisplayTeam(match, 'home');
  const awayTeam = getMatchDisplayTeam(match, 'away');
  const homeName = homeTeam.shortName[language] || homeTeam.name[language];
  const awayName = awayTeam.shortName[language] || awayTeam.name[language];

  if (language === 'zh') {
    if (code === '1') return `主胜 ${homeName}`;
    if (code === 'X') return '平局';
    return `客胜 ${awayName}`;
  }

  if (code === '1') return `Home ${homeName}`;
  if (code === 'X') return 'Draw';
  return `Away ${awayName}`;
};

const formatHandicapLine = (line: string | undefined, language: Language) => {
  if (!line) return language === 'zh' ? '让球' : 'HHAD';
  return language === 'zh' ? `让球 ${line}` : `HHAD ${line}`;
};

const parseHandicapLine = (line: string | undefined) => {
  const value = Number(String(line || '').replace(/[^\d.+-]/g, ''));
  return Number.isFinite(value) ? value : null;
};

const doesPrimaryMatchMargin = (primaryCode: OutcomeCode, margin: number) => {
  if (primaryCode === '1') return margin > 0;
  if (primaryCode === 'X') return margin === 0;
  return margin < 0;
};

const getHandicapCodeForMargin = (margin: number, line: number): OutcomeCode => {
  const adjustedMargin = margin + line;
  if (adjustedMargin > 0) return '1';
  if (adjustedMargin < 0) return '2';
  return 'X';
};

const isHandicapCodeCompatible = (
  primaryCode: OutcomeCode,
  handicapCode: OutcomeCode,
  lineValue: number | null
) => {
  if (lineValue === null) return true;

  for (let margin = -20; margin <= 20; margin += 1) {
    if (doesPrimaryMatchMargin(primaryCode, margin) && getHandicapCodeForMargin(margin, lineValue) === handicapCode) {
      return true;
    }
  }

  return false;
};

const getCompanionReason = (
  match: Match,
  primaryPrediction: PredictionDetail,
  handicapCode: OutcomeCode,
  language: Language
) => {
  const homeTeam = getMatchDisplayTeam(match, 'home');
  const awayTeam = getMatchDisplayTeam(match, 'away');
  const homeName = homeTeam.shortName[language] || homeTeam.name[language];
  const awayName = awayTeam.shortName[language] || awayTeam.name[language];
  const line = formatHandicapLine(match.handicapLine, language);
  const handicapLabel = getSimpleHandicapLabel(handicapCode, language);

  if (language === 'zh') {
    if (primaryPrediction.tipCode === '1' && handicapCode === '2') {
      return `胜平负主线看${homeName}取胜，但${line}提示穿盘压力，附加看${handicapLabel}。`;
    }
    if (primaryPrediction.tipCode === '2' && handicapCode === '1') {
      return `胜平负主线看${awayName}取胜，但${line}提示受让一方更稳，附加看${handicapLabel}。`;
    }
    if (primaryPrediction.tipCode !== handicapCode) {
      return `胜平负和${line}指向不同，主推不变，附加看${handicapLabel}。`;
    }
    return `胜平负和${line}同向，附加看${handicapLabel}确认穿盘方向。`;
  }

  if (primaryPrediction.tipCode === '1' && handicapCode === '2') {
    return `The 1X2 pick stays with ${homeName}, while ${line} points to cover pressure; add ${handicapLabel}.`;
  }
  if (primaryPrediction.tipCode === '2' && handicapCode === '1') {
    return `The 1X2 pick stays with ${awayName}, while ${line} favours the receiving side; add ${handicapLabel}.`;
  }
  if (primaryPrediction.tipCode !== handicapCode) {
    return `1X2 and ${line} point to different reads; keep the main pick and add ${handicapLabel}.`;
  }
  return `1X2 and ${line} align; add ${handicapLabel} as the handicap read.`;
};

const buildHandicapCompanion = (
  match: Match,
  primaryPrediction: PredictionDetail | undefined,
  language: Language
): DisplayRecommendationCompanion | null => {
  if (!primaryPrediction || primaryPrediction.oddsPoolCode === 'HHAD' || !isOutcomeCode(primaryPrediction.tipCode)) {
    return null;
  }

  const read = getHandicapRead(match);
  if (!read.modelTop) return null;
  if (read.marketTop && read.marketTop.code !== read.modelTop.code) return null;

  const lineValue = parseHandicapLine(match.handicapLine);
  const hasMeaningfulLine = lineValue === null || Math.abs(lineValue) >= 0.5;
  if (!hasMeaningfulLine) return null;

  const support = read.marketSupport;
  const strongHandicapRead = read.modelTop.probability >= 48
    && read.modelGap >= 10
    && (support === null || support >= 35);
  const splitDeepFavorite = primaryPrediction.tipCode !== read.modelTop.code
    && read.modelTop.probability >= 45
    && read.modelGap >= 8
    && (support === null || support >= 35);

  if (!strongHandicapRead && !splitDeepFavorite) return null;

  const label = getSimpleHandicapLabel(read.modelTop.code, language);
  const prediction: PredictionDetail = {
    marketType: '1X2',
    oddsPoolCode: 'HHAD',
    handicapLine: match.handicapLine,
    tipCode: read.modelTop.code,
    tipLabel: { zh: getSimpleHandicapLabel(read.modelTop.code, 'zh'), en: getSimpleHandicapLabel(read.modelTop.code, 'en') },
    odds: getOutcomeOddsValue(match, 'HHAD', read.modelTop.code),
    trustScore: Math.round(read.modelTop.probability),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-companion',
    explanation: { zh: '', en: '' },
    visibilityStatus: 'FREE',
    resultStatus: 'PENDING'
  };

  const lineLabel = formatHandicapLine(match.handicapLine, language);

  return {
    kind: 'handicap',
    prediction,
    tipCode: read.modelTop.code,
    label,
    title: language === 'zh' ? `附加推荐 ${label}` : `Add-on ${label}`,
    meta: `${lineLabel} · ${formatDisplayMeta(prediction, read.modelTop.probability, language)}`,
    probability: read.modelTop.probability,
    support,
    reason: getCompanionReason(match, primaryPrediction, read.modelTop.code, language)
  };
};

const buildHandicapCompanionFromPrediction = (
  match: Match,
  handicapPrediction: PredictionDetail | undefined,
  primaryPrediction: PredictionDetail | undefined,
  language: Language
): DisplayRecommendationCompanion | null => {
  if (!handicapPrediction || handicapPrediction.oddsPoolCode !== 'HHAD' || !isOutcomeCode(handicapPrediction.tipCode)) {
    return null;
  }
  if (!primaryPrediction || !isOutcomeCode(primaryPrediction.tipCode)) return null;

  const probability = getOutcomeProbability(match, handicapPrediction.tipCode, handicapPrediction);
  const read = getHandicapRead(match);
  const support = read.modelTop?.code === handicapPrediction.tipCode
    ? read.marketSupport ?? null
    : getOneXTwoSupport(match, handicapPrediction.tipCode, handicapPrediction);
  const label = getSimpleHandicapLabel(handicapPrediction.tipCode, language);

  return {
    kind: 'handicap',
    prediction: handicapPrediction,
    tipCode: handicapPrediction.tipCode,
    label,
    title: language === 'zh' ? `附加推荐 ${label}` : `Add-on ${label}`,
    meta: `${formatHandicapLine(match.handicapLine, language)} · ${formatDisplayMeta(handicapPrediction, probability, language)}`,
    probability: Number.isFinite(probability) ? Number(probability) : null,
    support,
    reason: getCompanionReason(match, primaryPrediction, handicapPrediction.tipCode, language)
  };
};

export const getListHandicapSupplement = (
  match: Match,
  language: Language,
  primaryPrediction?: PredictionDetail
): DisplayRecommendationCompanion | null => {
  const { hasHhad } = getAvailableResultPools(match);
  if (!hasHhad || primaryPrediction?.oddsPoolCode === 'HHAD') return null;

  const predictions = match.predictions || [];
  const pairedOutcomePrediction = getPairedOutcomePrediction(match, primaryPrediction);
  const handicapPrediction = predictions.find((prediction) => (
    prediction.marketType === 'BEST'
    && prediction.oddsPoolCode === 'HHAD'
    && isPredictionPoolAvailable(match, prediction)
    && isOutcomeCode(prediction.tipCode)
  )) || predictions.find((prediction) => (
    prediction.oddsPoolCode === 'HHAD'
    && isPredictionPoolAvailable(match, prediction)
    && isOutcomeCode(prediction.tipCode)
  ));

  if (handicapPrediction) {
    return buildHandicapCompanionFromPrediction(match, handicapPrediction, pairedOutcomePrediction, language);
  }

  const read = getHandicapRead(match);
  const top = read.modelTop || read.marketTop;
  if (!top) return null;

  const label = getSimpleHandicapLabel(top.code, language);
  const probability = Number.isFinite(top.probability) ? Number(top.probability) : null;
  const prediction: PredictionDetail = {
    marketType: '1X2',
    oddsPoolCode: 'HHAD',
    handicapLine: match.handicapLine,
    tipCode: top.code,
    tipLabel: { zh: getSimpleHandicapLabel(top.code, 'zh'), en: getSimpleHandicapLabel(top.code, 'en') },
    odds: getOutcomeOddsValue(match, 'HHAD', top.code),
    trustScore: Math.round(probability || 0),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-companion',
    explanation: { zh: '', en: '' },
    visibilityStatus: 'FREE',
    resultStatus: 'PENDING'
  };

  return {
    kind: 'handicap',
    prediction,
    tipCode: top.code,
    label,
    title: language === 'zh' ? `附加推荐 ${label}` : `Add-on ${label}`,
    meta: `${formatHandicapLine(match.handicapLine, language)} · ${formatDisplayMeta(prediction, probability, language)}`,
    probability,
    support: read.marketSupport,
    reason: pairedOutcomePrediction && isOutcomeCode(pairedOutcomePrediction.tipCode)
      ? getCompanionReason(match, pairedOutcomePrediction, top.code, language)
      : getDisplayReasonForKind('handicap', language)
  };
};

const getHandicapOverride = (match: Match, promotedPrediction?: PredictionDetail) => {
  if (promotedPrediction?.oddsPoolCode === 'HHAD' && !isHandicapMarketContradicted(match, promotedPrediction)) {
    return null;
  }

  const read = getHandicapRead(match);
  if (!read.modelTop) return null;
  if (read.marketTop && read.marketTop.code !== read.modelTop.code) return null;
  if (read.marketSupport === null) return null;

  const promotedIsWeak = !promotedPrediction
    || promotedPrediction.tipCode === 'WATCH'
    || isReferenceOnlyPrediction(promotedPrediction)
    || Number(promotedPrediction.trustScore || 0) <= 45;
  if (!promotedIsWeak) return null;

  const modelAlignedWithMarket = read.marketTop?.code === read.modelTop.code;
  const spreadOk = read.modelMarketSpread === null
    || read.modelMarketSpread <= (read.modelTop.probability >= 64 ? 18 : 22);
  const strongModel = read.modelTop.probability >= 56
    && read.modelGap >= 15
    && modelAlignedWithMarket
    && read.marketSupport >= 38
    && spreadOk;
  const marketRescue = read.modelTop.probability >= 45
    && read.modelGap >= 14
    && modelAlignedWithMarket
    && read.marketSupport >= 48;

  if (!strongModel && !marketRescue) return null;

  const fauxPrediction: PredictionDetail = {
    marketType: '1X2',
    oddsPoolCode: 'HHAD',
    handicapLine: match.handicapLine,
    tipCode: read.modelTop.code,
    tipLabel: { zh: getSimpleHandicapLabel(read.modelTop.code, 'zh'), en: getSimpleHandicapLabel(read.modelTop.code, 'en') },
    odds: getOutcomeOddsValue(match, 'HHAD', read.modelTop.code),
    trustScore: Math.round(Math.max(read.modelTop.probability, read.marketSupport)),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-override-reference',
    explanation: { zh: '', en: '' },
    visibilityStatus: 'FREE',
    resultStatus: 'PENDING'
  };

  return { prediction: fauxPrediction, top: read.modelTop, support: read.marketSupport };
};

const getOneXTwoSupport = (match: Match, code: string | undefined, prediction?: PredictionDetail) => {
  if (!isOutcomeCode(code)) return null;
  const resolvedOdds = getOfficialMatchOdds(match);
  const probabilities = getImpliedProbabilities(
    prediction?.oddsPoolCode === 'HHAD'
      ? resolvedOdds.hhad?.odds
      : resolvedOdds.had?.odds
  );
  if (!probabilities) return null;
  return code === '1' ? probabilities.home : code === 'X' ? probabilities.draw : probabilities.away;
};

const isStoredOutcomePrediction = (prediction: PredictionDetail | undefined) => {
  return Boolean(prediction && isOutcomeCode(prediction.tipCode));
};

const hasPredictionDisplayOdds = (prediction: PredictionDetail | undefined) => (
  Number(prediction?.odds || 0) > 0
);

const isPredictionPoolAvailable = (match: Match, prediction: PredictionDetail | undefined) => {
  return Boolean(
    prediction
    && hasPredictionDisplayOdds(prediction)
    && (isPredictionOfficialResultPoolAvailable(match, prediction) || isStoredOutcomePrediction(prediction))
  );
};

const buildOutcomeReferencePrediction = (match: Match, code: OutcomeCode): PredictionDetail => ({
  marketType: '1X2',
  oddsPoolCode: 'HAD',
  tipCode: code,
  tipLabel: { zh: getSimpleOutcomeLabel(match, code, 'zh'), en: getSimpleOutcomeLabel(match, code, 'en') },
  odds: getOutcomeOddsValue(match, 'HAD', code),
  trustScore: Math.round(getOutcomeProbability(match, code) || 0),
  recommendationAction: 'reference',
  recommendationTier: 'reference',
  explanation: { zh: '', en: '' },
  visibilityStatus: 'FREE',
  resultStatus: 'PENDING'
});

const getPairedOutcomePrediction = (
  match: Match,
  primaryPrediction?: PredictionDetail
): PredictionDetail | undefined => {
  if (primaryPrediction && primaryPrediction.oddsPoolCode !== 'HHAD' && isOutcomeCode(primaryPrediction.tipCode)) {
    return primaryPrediction;
  }

  const storedOutcome = (match.predictions || []).find((prediction) => (
    prediction.marketType === '1X2'
    && prediction.oddsPoolCode !== 'HHAD'
    && isPredictionPoolAvailable(match, prediction)
    && isOutcomeCode(prediction.tipCode)
  ));
  if (storedOutcome) return storedOutcome;

  const unified = match.probabilityModel?.unifiedPosterior;
  if (
    unified
    && (unified.selectedMarket === 'HAD' || unified.selectedMarket === '1X2')
    && isOutcomeCode(unified.selectedCode)
  ) {
    return buildOutcomeReferencePrediction(match, unified.selectedCode);
  }

  const outcomeTop = getTopOutcomeFromProbabilities(
    match.probabilityModel?.oneXTwo?.unifiedPosterior
      || match.probabilityModel?.oneXTwo?.final
      || match.probabilityModel?.oneXTwo?.scoreImplied
      || match.probabilityModel?.oneXTwo?.poisson
      || match.probabilityModel?.oneXTwo?.market
  );
  return outcomeTop ? buildOutcomeReferencePrediction(match, outcomeTop.code) : undefined;
};

const formatDisplayMeta = (
  prediction: PredictionDetail | undefined,
  probability: number | null,
  language: Language
) => {
  if (prediction && Number.isFinite(prediction.odds) && prediction.odds > 0) {
    return `${getPredictionValueLabel(prediction, language)} ${prediction.odds.toFixed(2)}`;
  }
  if (probability !== null && Number.isFinite(probability)) {
    return `${language === 'zh' ? '参考概率' : 'Reference'} ${Math.round(probability)}%`;
  }
  if (prediction && Number.isFinite(prediction.trustScore)) {
    return `${language === 'zh' ? '推荐强度' : 'Pick strength'} ${Math.round(prediction.trustScore)}%`;
  }
  return '--';
};

const getDisplayReasonForKind = (
  kind: DisplayRecommendationKind,
  language: Language
) => {
  const reasons: Record<DisplayRecommendationKind, Record<Language, string>> = {
    prediction: {
      zh: '按已开售玩法给出推荐，临场赔率变化时再复核。',
      en: 'Recommendation uses an on-sale market and should be rechecked against late odds.'
    },
    handicap: {
      zh: '胜平负未开售或不适合主推，本场直接看让球胜平负。',
      en: '1X2 is unavailable or weak, so this fixture uses the handicap result.'
    },
    outcome: {
      zh: '让球未开售时，按胜平负已开售玩法给出方向。',
      en: 'HHAD is unavailable, so the recommendation uses the on-sale 1X2 market.'
    },
    score: {
      zh: '比分只做推演，不作为胜负推荐。',
      en: 'Score heat is analysis only, not a result recommendation.'
    }
  };

  return reasons[kind][language];
};

export const getAvailableResultPools = (match: Match) => (
  getOfficialResultPoolAvailability(match)
);

export const getDisplayRecommendation = (match: Match, language: Language): DisplayRecommendation | null => {
  const predictions = match.predictions || [];
  const { hasHad, hasHhad } = getAvailableResultPools(match);
  const rawPromotedPrediction = [
    predictions.find((prediction) => prediction.marketType === 'BEST' && isPredictionPoolAvailable(match, prediction)),
    predictions.find((prediction) => prediction.marketType === '1X2' && isPredictionPoolAvailable(match, prediction))
  ].find(Boolean);
  const pendingPromotedPrediction = [
    predictions.find((prediction) => prediction.marketType === 'BEST' && isStoredOutcomePrediction(prediction) && !hasPredictionDisplayOdds(prediction)),
    predictions.find((prediction) => prediction.marketType === '1X2' && isStoredOutcomePrediction(prediction) && !hasPredictionDisplayOdds(prediction))
  ].find(Boolean);
  const pairedOutcomePrediction = getPairedOutcomePrediction(match, rawPromotedPrediction || pendingPromotedPrediction);
  const shouldApplyLiveMarketFilter = match.status === 'SCHEDULED';
  const promotedPrediction = rawPromotedPrediction && (!shouldApplyLiveMarketFilter || !isHandicapMarketContradicted(match, rawPromotedPrediction))
    ? rawPromotedPrediction
    : undefined;
  const handicapRead = hasHhad ? getHandicapRead(match) : null;
  const closeHandicapDecision = isCloseHandicapDecision(handicapRead);
  const handicapOverride = hasHhad ? getHandicapOverride(match, promotedPrediction) : null;

  if (handicapOverride) {
    return {
      kind: 'handicap',
      prediction: handicapOverride.prediction,
      tipCode: handicapOverride.top.code,
      label: getSimpleHandicapLabel(handicapOverride.top.code, language),
      meta: formatDisplayMeta(handicapOverride.prediction, handicapOverride.top.probability, language),
      probability: handicapOverride.top.probability,
      support: handicapOverride.support,
      reason: closeHandicapDecision ? getCloseHandicapReason(language) : getDisplayReasonForKind('handicap', language)
    };
  }

  if (promotedPrediction) {
    const canPairPromotedHandicap = promotedPrediction.oddsPoolCode === 'HHAD'
      && pairedOutcomePrediction
      && isOutcomeCode(pairedOutcomePrediction.tipCode)
      && isOutcomeCode(promotedPrediction.tipCode)
      && isHandicapCodeCompatible(
        pairedOutcomePrediction.tipCode,
        promotedPrediction.tipCode,
        parseHandicapLine(match.handicapLine)
      );

    if (canPairPromotedHandicap && pairedOutcomePrediction) {
      const probability = getOutcomeProbability(match, pairedOutcomePrediction.tipCode as OutcomeCode, pairedOutcomePrediction);
      const cleanProbability = Number.isFinite(probability) ? Number(probability) : null;
      const companion = buildHandicapCompanionFromPrediction(match, promotedPrediction, pairedOutcomePrediction, language);

      return {
        kind: 'prediction',
        prediction: pairedOutcomePrediction,
        tipCode: pairedOutcomePrediction.tipCode,
        label: getSimpleOutcomeLabel(match, pairedOutcomePrediction.tipCode as OutcomeCode, language),
        meta: formatDisplayMeta(pairedOutcomePrediction, cleanProbability, language),
        probability: cleanProbability,
        support: getOneXTwoSupport(match, pairedOutcomePrediction.tipCode, pairedOutcomePrediction),
        reason: companion
          ? (language === 'zh'
            ? '胜平负和让球盘拆开看：先判断胜负方向，再判断是否穿盘。'
            : '1X2 and handicap are split: first the match result, then the cover.')
          : getDisplayReasonForKind('prediction', language),
        companion: companion || undefined
      };
    }

    const probability = getOutcomeProbability(match, promotedPrediction.tipCode as OutcomeCode, promotedPrediction);
    const cleanProbability = Number.isFinite(probability) ? Number(probability) : null;
    const label = promotedPrediction.oddsPoolCode === 'HHAD'
      ? getSimpleHandicapLabel(promotedPrediction.tipCode as OutcomeCode, language)
      : getSimpleOutcomeLabel(match, promotedPrediction.tipCode as OutcomeCode, language);

    return {
      kind: 'prediction',
      prediction: promotedPrediction,
      tipCode: promotedPrediction.tipCode,
      label,
      meta: formatDisplayMeta(promotedPrediction, cleanProbability, language),
      probability: cleanProbability,
      support: getOneXTwoSupport(match, promotedPrediction.tipCode, promotedPrediction),
      reason: promotedPrediction.oddsPoolCode === 'HHAD' && closeHandicapDecision
        ? getCloseHandicapReason(language)
        : getDisplayReasonForKind('prediction', language),
      companion: buildHandicapCompanion(match, promotedPrediction, language) || undefined
    };
  }

  const handicapTop = handicapRead?.modelTop || null;
  const handicapMarketTop = handicapRead?.marketTop || null;
  const handicapMarketFallback = !hasHad && hasHhad ? handicapMarketTop : null;
  const handicapFallbackAllowed = Boolean(
    handicapTop
    && (!handicapMarketTop || handicapMarketTop.code === handicapTop.code)
  );
  const handicapDisplayTop = handicapTop && handicapFallbackAllowed
    ? handicapTop
    : handicapMarketFallback;
  const handicapDisplaySupport = handicapDisplayTop?.code === handicapRead?.modelTop?.code
    ? handicapRead?.marketSupport ?? null
    : handicapDisplayTop?.probability ?? null;

  if (hasHhad && handicapDisplayTop) {
    const fauxPrediction: PredictionDetail = {
      marketType: '1X2',
      oddsPoolCode: 'HHAD',
      handicapLine: match.handicapLine,
      tipCode: handicapDisplayTop.code,
      tipLabel: { zh: getSimpleHandicapLabel(handicapDisplayTop.code, 'zh'), en: getSimpleHandicapLabel(handicapDisplayTop.code, 'en') },
      odds: getOutcomeOddsValue(match, 'HHAD', handicapDisplayTop.code),
      trustScore: Math.round(handicapDisplayTop.probability),
      recommendationAction: 'reference',
      recommendationTier: 'reference',
      explanation: { zh: '', en: '' },
      visibilityStatus: 'FREE',
      resultStatus: 'PENDING'
    };

    return {
      kind: 'handicap',
      prediction: fauxPrediction,
      tipCode: handicapDisplayTop.code,
      label: getSimpleHandicapLabel(handicapDisplayTop.code, language),
      meta: formatDisplayMeta(fauxPrediction, handicapDisplayTop.probability, language),
      probability: handicapDisplayTop.probability,
      support: handicapDisplaySupport,
      reason: !hasHad && hasHhad
        ? (language === 'zh'
          ? '普通胜平负未开售，本场直接按让球胜平负推荐。'
          : 'Standard 1X2 is not on sale, so this fixture is recommended through HHAD.')
        : getDisplayReasonForKind('handicap', language)
    };
  }

  const outcomeTop = hasHad ? getTopOutcomeFromProbabilities(
    match.probabilityModel?.oneXTwo?.final
      || match.probabilityModel?.oneXTwo?.scoreImplied
      || match.probabilityModel?.oneXTwo?.poisson
      || match.probabilityModel?.oneXTwo?.market
  ) : null;

  if (outcomeTop) {
    const fauxPrediction: PredictionDetail = {
      marketType: '1X2',
      oddsPoolCode: 'HAD',
      tipCode: outcomeTop.code,
      tipLabel: { zh: getSimpleOutcomeLabel(match, outcomeTop.code, 'zh'), en: getSimpleOutcomeLabel(match, outcomeTop.code, 'en') },
      odds: getOutcomeOddsValue(match, 'HAD', outcomeTop.code),
      trustScore: Math.round(outcomeTop.probability),
      recommendationAction: 'reference',
      recommendationTier: 'reference',
      explanation: { zh: '', en: '' },
      visibilityStatus: 'FREE',
      resultStatus: 'PENDING'
    };

    return {
      kind: 'outcome',
      prediction: fauxPrediction,
      tipCode: outcomeTop.code,
      label: getSimpleOutcomeLabel(match, outcomeTop.code, language),
      meta: formatDisplayMeta(fauxPrediction, outcomeTop.probability, language),
      probability: outcomeTop.probability,
      support: getOneXTwoSupport(match, outcomeTop.code),
      reason: getDisplayReasonForKind('outcome', language),
      companion: buildHandicapCompanion(match, fauxPrediction, language) || undefined
    };
  }

  if (pendingPromotedPrediction) {
    const probability = getOutcomeProbability(match, pendingPromotedPrediction.tipCode as OutcomeCode, pendingPromotedPrediction);
    const cleanProbability = Number.isFinite(probability) ? Number(probability) : null;
    const label = pendingPromotedPrediction.oddsPoolCode === 'HHAD'
      ? getSimpleHandicapLabel(pendingPromotedPrediction.tipCode as OutcomeCode, language)
      : getSimpleOutcomeLabel(match, pendingPromotedPrediction.tipCode as OutcomeCode, language);

    return {
      kind: pendingPromotedPrediction.oddsPoolCode === 'HHAD' ? 'handicap' : 'prediction',
      prediction: pendingPromotedPrediction,
      tipCode: pendingPromotedPrediction.tipCode,
      label,
      meta: formatDisplayMeta(pendingPromotedPrediction, cleanProbability, language),
      probability: cleanProbability,
      support: getOneXTwoSupport(match, pendingPromotedPrediction.tipCode, pendingPromotedPrediction),
      reason: language === 'zh'
        ? '当前方向先保留为赛前推荐；官方 SP 开售后会按胜平负/让球盘口重新确认。'
        : 'The pre-match direction is kept for now; once official SP opens, 1X2/HHAD markets will recheck it.',
      companion: buildHandicapCompanion(match, pendingPromotedPrediction, language) || undefined
    };
  }

  return null;
};
