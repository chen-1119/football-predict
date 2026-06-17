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

const outcomeLabels = {
  '1': { zh: '主胜', en: 'Home' },
  X: { zh: '平局', en: 'Draw' },
  '2': { zh: '客胜', en: 'Away' }
} as const;

type OutcomeCode = keyof typeof outcomeLabels;
type OutcomeProbabilityTriplet = {
  home?: number | null;
  draw?: number | null;
  away?: number | null;
} | null | undefined;

type DisplayRecommendationKind = 'prediction' | 'handicap' | 'outcome' | 'score';

export interface DisplayRecommendation {
  kind: DisplayRecommendationKind;
  prediction?: PredictionDetail;
  tipCode?: string;
  label: string;
  meta: string;
  probability: number | null;
  support: number | null;
  reason: string;
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
    ? match.probabilityModel?.handicap?.scoreImplied
      || match.probabilityModel?.handicap?.poisson
      || match.probabilityModel?.handicap?.market
    : match.probabilityModel?.oneXTwo?.final || match.probabilityModel?.oneXTwo?.market;
  if (!final) return null;
  const value = code === '1' ? final.home : code === 'X' ? final.draw : final.away;
  return Number.isFinite(value) ? Number(value) : null;
};

const getTopOutcomeFromProbabilities = (probabilities: OutcomeProbabilityTriplet) => (
  getRankedOutcomeProbabilities(probabilities)[0] || null
);

const getHandicapRead = (match: Match) => {
  const modelRows = getRankedOutcomeProbabilities(
    match.probabilityModel?.handicap?.scoreImplied
      || match.probabilityModel?.handicap?.poisson
      || match.probabilityModel?.handicap?.market
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

const isPredictionPoolAvailable = (match: Match, prediction: PredictionDetail | undefined) => {
  return isPredictionOfficialResultPoolAvailable(match, prediction) || isStoredOutcomePrediction(prediction);
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
        : getDisplayReasonForKind('prediction', language)
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
      reason: getDisplayReasonForKind('outcome', language)
    };
  }

  return null;
};
