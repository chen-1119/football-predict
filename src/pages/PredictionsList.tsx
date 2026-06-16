import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trophy
} from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import { formatBeijingDateString, getDateStringOffset, leagues } from '../services/mockData';
import type { Country, League, Match, PredictionDetail, Team } from '../services/mockData';
import {
  getImpliedProbabilities,
  getOfficialMatchOdds,
  getOfficialResultPoolAvailability,
  getPredictionTipDisplay,
  getPredictionValueLabel,
  getSportteryPoolRows,
  isPredictionOfficialResultPoolAvailable
} from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal, type MatchSignalCategory } from '../services/matchSignal';
import { buildPreMatchRisk } from '../services/preMatchRisk';
import { getVisiblePrediction, getVisiblePredictions } from '../services/predictionVisibility';
import { buildFiveHundredDisplay } from '../services/fiveHundredDisplay';
import { TeamBadge } from '../components/TeamBadge';
import { WorldCupSpotlight } from '../components/WorldCupSpotlight';

interface PredictionsListProps {
  onSelectMatch: (matchId: string) => void;
  onOpenWorldCup: () => void;
}

type SortBy = 'time' | 'odds';
type SignalFilter = 'recommended' | 'all' | MatchSignalCategory;

const SORT_OPTIONS: SortBy[] = ['time', 'odds'];
const SIGNAL_FILTERS: SignalFilter[] = ['recommended', 'all', 'finished'];

const getKickoffDay = (match: Match): string => (
  match.kickoffDate || String(match.kickoffTime || '').slice(0, 10) || match.matchDate || ''
);

const getSportteryDay = (match: Match): string => match.businessDate || getKickoffDay(match) || '';

const getMatchDateCandidates = (match: Match): string[] => {
  const kickoffDay = getKickoffDay(match);
  const sportteryDay = getSportteryDay(match);

  // Pre-match users think in both Sporttery issue day and actual kickoff day.
  // Cross-midnight fixtures should stay visible on the issue day even after settlement,
  // then remain findable by kickoff day for natural-date review.
  return Array.from(new Set([
    kickoffDay,
    sportteryDay
  ].filter(Boolean)));
};

const matchBelongsToDate = (match: Match, date: string) => getMatchDateCandidates(match).includes(date);

const compareDateKey = (a: string, b: string) => {
  if (!a || !b) return 0;
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

const getBestPrediction = (match: Match) => getVisiblePrediction(match, 'BEST');

const getBestTrust = (match: Match) => getBestPrediction(match)?.trustScore || 0;

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

const getMatchDisplayLeague = (match: Match): League => {
  const base = getLeagueById(match.leagueId);
  const nameZh = match.leagueName || match.leagueShortName || base.name.zh;
  const nameEn = match.leagueNameEn || match.leagueName || match.leagueShortNameEn || base.name.en;
  const shortZh = match.leagueShortName || match.leagueName || base.shortName.zh || nameZh;
  const shortEn = match.leagueShortNameEn || match.leagueNameEn || match.leagueName || base.shortName.en || nameEn;

  return {
    ...base,
    name: { zh: nameZh, en: nameEn },
    shortName: { zh: shortZh, en: shortEn },
    countryId: match.countryId || base.countryId
  };
};

const getBestOdds = (match: Match) => {
  const resolvedOdds = getOfficialMatchOdds(match);
  return getBestPrediction(match)?.odds || resolvedOdds.had?.odds.odds1 || resolvedOdds.hhad?.odds.odds1 || 0;
};

const isReferenceOnlyPrediction = (prediction?: PredictionDetail) => (
  prediction?.recommendationAction === 'reference' || prediction?.recommendationTier === 'reference'
);

const getRecommendationTipDisplay = (
  prediction: PredictionDetail,
  language: 'zh' | 'en',
  compact = true
) => {
  return getPredictionTipDisplay(prediction, language, compact);
};

const stripDirectionPrefix = (label: string, language: 'zh' | 'en') => (
  language === 'zh'
    ? label.replace(/^(推荐方向|参考倾向|参考推荐|模型首选|价值观察|高可信|主推)\s*/, '')
    : label.replace(/^(Pick|Reference lean|Reference pick|Model lean|Value watch|High confidence)[:：]?\s*/i, '')
);

const formatShortDate = (date: string, language: 'zh' | 'en') => {
  return new Date(`${date}T00:00:00+08:00`).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    timeZone: 'Asia/Shanghai'
  });
};

const getSportteryMeta = (match: Match, language: 'zh' | 'en') => {
  const sportteryDay = getSportteryDay(match);
  const kickoffDay = getKickoffDay(match);
  const isCrossDayIssue = Boolean(sportteryDay && kickoffDay && sportteryDay !== kickoffDay);
  const labels = [
    match.matchNo,
    sportteryDay
      ? `${language === 'zh' ? '竞彩日' : 'Sporttery day'} ${formatShortDate(sportteryDay, language)}`
      : '',
    isCrossDayIssue && kickoffDay
      ? `${language === 'zh' ? '开赛日' : 'Kickoff day'} ${formatShortDate(kickoffDay, language)}`
      : '',
    isCrossDayIssue && sportteryDay
      ? `${language === 'zh' ? '归档' : 'Review archive'} ${formatShortDate(sportteryDay, language)}`
      : ''
  ].filter(Boolean);

  return labels.join(' / ');
};

const formatKickoffTime = (kickoffTime: string, language: 'zh' | 'en') => {
  return new Date(kickoffTime).toLocaleTimeString(
    language === 'zh' ? 'zh-CN' : 'en-US',
    { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }
  );
};

const offsetDateString = (date: string, offsetDays: number) => {
  const time = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(time)) return getDateStringOffset(offsetDays);
  return formatBeijingDateString(new Date(time + offsetDays * 24 * 60 * 60 * 1000));
};

const formatSyncTime = (isoTime: string | undefined, language: 'zh' | 'en') => {
  if (!isoTime) return '--';

  return new Date(isoTime).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
};

const getNextCheckSeconds = (lastCheckedAt: string | undefined, refreshIntervalSeconds: number | undefined, nowMs: number) => {
  if (!lastCheckedAt) return null;
  const lastCheckedMs = Date.parse(lastCheckedAt);
  if (!Number.isFinite(lastCheckedMs)) return null;
  const intervalSeconds = refreshIntervalSeconds || 60;
  const intervalMs = intervalSeconds * 1000;
  return Math.min(intervalSeconds, Math.max(0, Math.ceil((lastCheckedMs + intervalMs - nowMs) / 1000)));
};

const getDataAgeMinutes = (isoTime: string | undefined, nowMs: number) => {
  if (!isoTime) return null;
  const sourceMs = Date.parse(isoTime);
  if (!Number.isFinite(sourceMs)) return null;
  return Math.max(0, Math.floor((nowMs - sourceMs) / 60000));
};

const formatAgeMinutes = (minutes: number | null, language: 'zh' | 'en') => {
  if (minutes === null) return '--';
  if (minutes < 60) return language === 'zh' ? `${minutes} 分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return language === 'zh'
    ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`
    : `${hours}h${rest ? ` ${rest}m` : ''}`;
};

const hasOfficialScore = (match: Match) => Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);

const minutesSinceKickoff = (match: Match) => {
  const kickoffAt = new Date(match.kickoffTime).getTime();
  if (!Number.isFinite(kickoffAt)) return 0;
  return Math.floor((Date.now() - kickoffAt) / 60000);
};

const outcomeLabels = {
  '1': { zh: '主胜', en: 'Home' },
  X: { zh: '平局', en: 'Draw' },
  '2': { zh: '客胜', en: 'Away' }
} as const;

type OutcomeCode = keyof typeof outcomeLabels;

const isOutcomeCode = (code: string | undefined): code is OutcomeCode => code === '1' || code === 'X' || code === '2';

type OutcomeProbabilityTriplet = {
  home?: number | null;
  draw?: number | null;
  away?: number | null;
} | null | undefined;

type DisplayRecommendationKind = 'prediction' | 'handicap' | 'outcome' | 'score';

interface DisplayRecommendation {
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

const getLeadingOutcome = (match: Match) => {
  const entries = (['1', 'X', '2'] as OutcomeCode[])
    .map((code) => ({ code, probability: getOutcomeProbability(match, code) }))
    .filter((item): item is { code: OutcomeCode; probability: number } => item.probability !== null)
    .sort((a, b) => b.probability - a.probability);

  if (entries.length >= 2 && entries[0].probability - entries[1].probability < 2) return null;

  return entries[0] || null;
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
  const marketSupport = modelTop
    ? marketRows.find((item) => item.code === modelTop.code)?.probability ?? null
    : null;

  return {
    modelTop,
    modelGap: modelTop && modelSecond ? modelTop.probability - modelSecond.probability : 0,
    marketTop,
    marketSupport,
    modelMarketSpread: modelTop && marketSupport !== null ? Math.abs(modelTop.probability - marketSupport) : null
  };
};

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

const getOutcomeOddsValue = (match: Match, poolCode: 'HAD' | 'HHAD', code: OutcomeCode) => {
  const resolvedOdds = getOfficialMatchOdds(match);
  const odds = poolCode === 'HHAD' ? resolvedOdds.hhad?.odds : resolvedOdds.had?.odds;
  const value = code === '1' ? odds?.odds1 : code === 'X' ? odds?.oddsX : odds?.odds2;
  return Number.isFinite(value) ? Number(value) : 0;
};

const getHomePageOddsRows = (match: Match, language: 'zh' | 'en') => (
  getSportteryPoolRows(match, language).filter((row) => row.odds)
);

const getAvailableResultPools = (match: Match) => {
  return getOfficialResultPoolAvailability(match);
};

const isPredictionPoolAvailable = (match: Match, prediction: PredictionDetail | undefined) => {
  return isPredictionOfficialResultPoolAvailable(match, prediction);
};

const getRiskTags = (match: Match, limit = 3) => {
  const seen = new Set<string>();
  return getVisiblePredictions(match)
    .flatMap((prediction) => prediction.riskTags || [])
    .filter((tag) => {
      const key = `${tag.zh}-${tag.en}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
};

const getHomePageRiskTags = (match: Match, limit = 3) => (
  getRiskTags(match, limit + 4)
    .filter((tag) => {
      const zh = tag.zh || '';
      const en = (tag.en || '').toLowerCase();
      return !zh.includes('让球')
        && !zh.includes('盘口')
        && !en.includes('handicap')
        && !en.includes('market disagreement');
    })
    .slice(0, limit)
);

const getSimpleOutcomeLabel = (match: Match, code: OutcomeCode, language: 'zh' | 'en') => {
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

const getSimpleHandicapLabel = (code: OutcomeCode, language: 'zh' | 'en') => {
  if (language === 'zh') {
    if (code === '1') return '让胜';
    if (code === 'X') return '让平';
    return '让负';
  }

  if (code === '1') return 'Handicap home';
  if (code === 'X') return 'Handicap draw';
  return 'Handicap away';
};

const formatDisplayMeta = (
  prediction: PredictionDetail | undefined,
  probability: number | null,
  language: 'zh' | 'en'
) => {
  if (prediction && Number.isFinite(prediction.odds) && prediction.odds > 0) {
    return `${getPredictionValueLabel(prediction, language)} ${prediction.odds.toFixed(2)}`;
  }
  if (probability !== null && Number.isFinite(probability)) {
    return `${language === 'zh' ? '模型' : 'Model'} ${Math.round(probability)}%`;
  }
  if (prediction && Number.isFinite(prediction.trustScore)) {
    return `${language === 'zh' ? '可信' : 'Trust'} ${Math.round(prediction.trustScore)}%`;
  }
  return '--';
};

const getDisplayReasonForKind = (
  kind: DisplayRecommendationKind,
  language: 'zh' | 'en'
) => {
  const reasons: Record<DisplayRecommendationKind, Record<'zh' | 'en', string>> = {
    prediction: {
      zh: '按已开售玩法给出推荐，临场 SP 变化时再复核。',
      en: 'Recommendation uses an on-sale market and should be rechecked against late SP.'
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

const getDisplayRecommendation = (match: Match, language: 'zh' | 'en'): DisplayRecommendation | null => {
  const predictions = match.predictions || [];
  const { hasHad, hasHhad } = getAvailableResultPools(match);
  const rawPromotedPrediction = [
    predictions.find((prediction) => prediction.marketType === 'BEST' && isPredictionPoolAvailable(match, prediction)),
    predictions.find((prediction) => prediction.marketType === '1X2' && isPredictionPoolAvailable(match, prediction))
  ].find(Boolean);
  const promotedPrediction = rawPromotedPrediction && !isHandicapMarketContradicted(match, rawPromotedPrediction)
    ? rawPromotedPrediction
    : undefined;
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
      reason: getDisplayReasonForKind('handicap', language)
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
      reason: getDisplayReasonForKind('prediction', language)
    };
  }

  const handicapRead = hasHhad ? getHandicapRead(match) : null;
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
    return {
      kind: 'outcome',
      tipCode: outcomeTop.code,
      label: getSimpleOutcomeLabel(match, outcomeTop.code, language),
      meta: formatDisplayMeta(undefined, outcomeTop.probability, language),
      probability: outcomeTop.probability,
      support: getOneXTwoSupport(match, outcomeTop.code),
      reason: getDisplayReasonForKind('outcome', language)
    };
  }

  return null;
};

const getDecisionReason = (category: MatchSignalCategory, language: 'zh' | 'en') => {
  const reasons: Record<MatchSignalCategory, Record<'zh' | 'en', string>> = {
    steady: { zh: '赔率、概率和风险基本同向', en: 'Odds, probability, and risk align' },
    lean: { zh: '已按开售玩法给出方向', en: 'Direction is based on an on-sale market' },
    value: { zh: '有冷门变量，临场再复核', en: 'Upset variables exist; recheck late' },
    watch: { zh: '等待官方 SP 开售或更新', en: 'Waiting for official SP sale or refresh' },
    avoid: { zh: '风险偏高，推荐需临场复核', en: 'Risk is elevated; recheck before kickoff' },
    unavailable: { zh: '待官方 SP 开售', en: 'Waiting for official SP' },
    finished: { zh: '按赛果复盘', en: 'Review by final result' }
  };

  return reasons[category][language];
};

export const PredictionsList: React.FC<PredictionsListProps> = ({ onSelectMatch, onOpenWorldCup }) => {
  const { language, matches, dataSync } = useApp();
  const [nowMs, setNowMs] = useState(() => Date.now());

  const systemTodayStr = getDateStringOffset(0);
  const todayStr = systemTodayStr;
  const yesterdayStr = offsetDateString(todayStr, -1);
  const tomorrowStr = offsetDateString(todayStr, 1);
  const dayAfterTomorrowStr = offsetDateString(todayStr, 2);

  const [selectedDate, setSelectedDate] = useState<string>(() => getDateStringOffset(0));
  const [selectedLeagues, setSelectedLeagues] = useState<string[]>([]);
  const [signalFilter, setSignalFilter] = useState<SignalFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('time');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const translations = {
    referenceNotice: {
      zh: '模型预测仅供赛前参考，不构成任何投注建议；请结合临场信息理性判断。',
      en: 'Forecasts are for pre-match reference only and are not betting advice. Use late information and your own judgment.'
    },
    filterTitle: { zh: '赛事筛选', en: 'Competition Filters' },
    allLeagues: { zh: '全部赛事', en: 'All Competitions' },
    signalTitle: { zh: '赛事范围', en: 'Scope' },
    recommended: { zh: '有推荐', en: 'Recommended' },
    allSignals: { zh: '全部赛事', en: 'All matches' },
    steady: { zh: '有推荐', en: 'Recommended' },
    lean: { zh: '有推荐', en: 'Recommended' },
    value: { zh: '有推荐', en: 'Recommended' },
    watch: { zh: '待开售', en: 'Pending sale' },
    avoid: { zh: '有推荐', en: 'Recommended' },
    unavailable: { zh: '待开售', en: 'Pending' },
    sortTitle: { zh: '排序', en: 'Sort' },
    time: { zh: '开赛时间', en: 'Time' },
    trust: { zh: '可信度', en: 'Trust' },
    odds: { zh: 'SP 值', en: 'Odds' },
    reset: { zh: '重置', en: 'Reset' },
    noMatches: { zh: '这个日期暂无可用比赛预测。', en: 'No scheduled matches found for this day.' },
    noQualifiedPicks: { zh: '当前没有已开售玩法可推荐的比赛。', en: 'No on-sale recommendation is available yet.' },
    yesterday: { zh: '昨天', en: 'Yesterday' },
    today: { zh: '今天', en: 'Today' },
    tomorrow: { zh: '明天', en: 'Tomorrow' },
    dayAfterTomorrow: { zh: '后天', en: 'Day +2' },
    finished: { zh: '已完场', en: 'Finished' },
    live: { zh: '进行中', en: 'Live' },
    pending: { zh: '待开赛', en: 'Scheduled' },
    details: { zh: '详情', en: 'Details' },
    hitRate: { zh: '已结算推荐命中率', en: 'Settled Recommendation Hit Rate' },
    selectedMatches: { zh: '当前筛选场次', en: 'Filtered Matches' },
    signalSummary: { zh: '推荐概览', en: 'Recommendation Summary' },
    avgTrust: { zh: '今日状态', en: 'Today Status' },
    riskPaused: { zh: '风控暂停', en: 'Risk paused' },
    riskPausedNote: { zh: '暂无已开售推荐，等待下一轮 SP', en: 'No on-sale pick yet; wait for next SP check' },
    hitCooling: { zh: '命中冷却', en: 'Cooling' },
    hitCoolingNote: { zh: '近期命中偏低，推荐门槛保持收紧', en: 'Recent hit rate is low; gates stay tight' },
    dataStatusTitle: { zh: '数据同步', en: 'Data Sync' },
    dataCurrent: { zh: '当前赛程', en: 'Current' },
    dataHistory: { zh: '历史库', en: 'History' },
    dataTotal: { zh: '总数据', en: 'Total' },
    dataStatus: { zh: '状态', en: 'Status' },
    dataLoading: { zh: '加载中', en: 'Loading' },
    dataSyncing: { zh: '同步中', en: 'Syncing' },
    dataReady: { zh: '已加载', en: 'Ready' },
    dataFallback: { zh: '加载失败', en: 'Unavailable' },
    dataUpdated: { zh: '数据源', en: 'Source' },
    dataChannel: { zh: '通道', en: 'Channel' },
    dataChannelApi: { zh: '实时接口', en: 'Live API' },
    dataChannelStatic: { zh: '静态快照', en: 'Static snapshot' },
    dataChannelMock: { zh: '开发样例', en: 'Dev sample' },
    dataRefresh: { zh: '页面自检', en: 'Page check' },
    dataNextCheck: { zh: '下次检查', en: 'Next check' },
    dataCurrentLoading: { zh: '正在加载中国竞彩网赛程', en: 'Loading Sporttery schedule' },
    dataHistoryLoading: { zh: '历史结果后台补齐中', en: 'History loading in background' },
    dataHistoryReady: { zh: '当前赛程与历史库已就绪', en: 'Current schedule and history are ready' },
    dataHistoryUnavailable: { zh: '当前赛程已就绪，历史库暂不可用', en: 'Current schedule ready, history unavailable' },
    dataFallbackNote: { zh: '官方数据暂不可用，已停止展示兜底样例，请稍后刷新', en: 'Official data unavailable; sample fallback is disabled. Please refresh later' },
    settledPicks: { zh: '条方向预测', en: 'scored picks' },
    matchUnit: { zh: '场', en: 'matches' },
    tipUnit: { zh: '条', en: 'tips' },
    statusTime: { zh: '时间 / 状态', en: 'Time / Status' },
    liveScorePending: { zh: '赛中待比分', en: 'Live, score pending' },
    awaitingResult: { zh: '等待官方赛果', en: 'Awaiting official result' },
    teams: { zh: '对阵双方', en: 'Teams' },
    oddsHeader: { zh: '胜平负/让球 SP', en: '1X2 / HHAD SP' },
    closed: { zh: '等待官方SP', en: 'SP pending' },
    archivedOdds: { zh: '胜平负归档', en: '1X2 archived' },
    hit: { zh: '命中', en: 'Hit' },
    miss: { zh: '未中', en: 'Miss' },
    leagueMatches: { zh: '场比赛', en: 'matches' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';
  const getSignalFilterLabel = (filter: SignalFilter) => {
    if (filter === 'recommended') return t('recommended');
    if (filter === 'all') return t('allSignals');
    return translations[filter][language];
  };

  const effectiveSelectedDate = selectedDate;

  const availableLeagues = useMemo(() => {
    const seen = new Set<string>();
    const matchesForDate = matches.filter((match) => matchBelongsToDate(match, effectiveSelectedDate));
    if (matchesForDate.length === 0) {
      return leagues
        .filter((league) => !seen.has(league.id) && seen.add(league.id))
        .sort((a, b) => a.name[language].localeCompare(b.name[language], language === 'zh' ? 'zh-CN' : 'en-US'));
    }

    return matchesForDate.reduce<League[]>((list, match) => {
      const leagueId = match.leagueId;
      if (seen.has(leagueId)) return list;
      seen.add(leagueId);
      list.push(getMatchDisplayLeague(match));
      return list;
    }, []).sort((a, b) => a.name[language].localeCompare(b.name[language], language === 'zh' ? 'zh-CN' : 'en-US'));
  }, [effectiveSelectedDate, language, matches]);

  const availableLeagueIds = new Set(availableLeagues.map((league) => league.id));
  const effectiveSelectedLeagues = selectedLeagues.filter((leagueId) => availableLeagueIds.has(leagueId));

  const baseFilteredMatches = useMemo(() => {
    return matches.filter((match) => {
      if (!matchBelongsToDate(match, effectiveSelectedDate)) return false;
      return effectiveSelectedLeagues.length === 0 || effectiveSelectedLeagues.includes(match.leagueId);
    });
  }, [effectiveSelectedDate, effectiveSelectedLeagues, matches]);

  const signalCounts = useMemo(() => {
    return baseFilteredMatches.reduce<Record<SignalFilter, number>>((counts, match) => {
      const signal = getMatchSignal(match);
      counts.all += 1;
      if (getDisplayRecommendation(match, language)) counts.recommended += 1;
      counts[signal.category] += 1;
      return counts;
    }, { recommended: 0, all: 0, steady: 0, lean: 0, value: 0, watch: 0, avoid: 0, unavailable: 0, finished: 0 });
  }, [baseFilteredMatches, language]);

  const recommendationCounts = useMemo(() => {
    return baseFilteredMatches.reduce((counts, match) => {
      const signal = getMatchSignal(match);
      const displayRecommendation = getDisplayRecommendation(match, language);
      const { hasHad, hasHhad } = getAvailableResultPools(match);
      if (signal.category === 'finished') {
        counts.finished += 1;
      } else {
        if (displayRecommendation) counts.recommended += 1;
        if (hasHad) counts.had += 1;
        if (hasHhad) counts.hhad += 1;
        if (!displayRecommendation) counts.unavailable += 1;
      }
      return counts;
    }, { recommended: 0, had: 0, hhad: 0, unavailable: 0, finished: 0 });
  }, [baseFilteredMatches, language]);

  const dateIdentityCounts = useMemo(() => {
    return baseFilteredMatches.reduce((counts, match) => {
      const sportteryDay = getSportteryDay(match);
      const kickoffDay = getKickoffDay(match);
      const sportteryVsSelected = compareDateKey(sportteryDay, effectiveSelectedDate);
      const sportteryVsKickoff = compareDateKey(sportteryDay, kickoffDay);

      counts.kickoff += 1;
      if (sportteryVsSelected < 0) counts.previousIssue += 1;
      else if (sportteryVsSelected === 0) counts.sameIssue += 1;
      else if (sportteryVsSelected > 0) counts.futureIssue += 1;
      if (sportteryVsKickoff !== 0) counts.crossDay += 1;

      return counts;
    }, { kickoff: 0, previousIssue: 0, sameIssue: 0, futureIssue: 0, crossDay: 0 });
  }, [baseFilteredMatches, effectiveSelectedDate]);

  const visibleSignalFilters = useMemo(() => {
    return SIGNAL_FILTERS.filter((filter) => filter === 'recommended' || filter === 'all' || signalCounts[filter] > 0 || signalFilter === filter);
  }, [signalCounts, signalFilter]);

  const filteredMatches = useMemo(() => {
    if (signalFilter === 'recommended') return baseFilteredMatches.filter((match) => getDisplayRecommendation(match, language));
    if (signalFilter === 'all') return baseFilteredMatches;
    return baseFilteredMatches.filter((match) => getMatchSignal(match).category === signalFilter);
  }, [baseFilteredMatches, language, signalFilter]);

  const sortedMatches = useMemo(() => {
    const sorted = [...filteredMatches];

    sorted.sort((a, b) => {
      let comparison: number;

      if (sortBy === 'time') {
        comparison = new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
      } else {
        comparison = getBestOdds(a) - getBestOdds(b);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [filteredMatches, sortBy, sortOrder]);

  const actionableMatches = useMemo(() => {
    return baseFilteredMatches
      .filter((match) => match.status !== 'FINISHED' && Boolean(getDisplayRecommendation(match, language)))
      .sort((a, b) => {
        const trustDiff = getBestTrust(b) - getBestTrust(a);
        if (Math.abs(trustDiff) > 0) return trustDiff;
        return Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime);
      });
  }, [baseFilteredMatches, language]);

  const hasQualifiedPicks = actionableMatches.length > 0;

  const groupedMatches = useMemo(() => {
    const groups: Record<string, { league: League; country: Country; matches: Match[] }> = {};

    sortedMatches.forEach((match) => {
      const key = `${match.countryId}_${match.leagueId}`;

      if (!groups[key]) {
        groups[key] = {
          league: getMatchDisplayLeague(match),
          country: getCountryById(match.countryId),
          matches: []
        };
      }

      groups[key].matches.push(match);
    });

    return Object.values(groups);
  }, [sortedMatches]);

  const handleLeagueToggle = (leagueId: string) => {
    setSelectedLeagues((current) => (
      current.includes(leagueId)
        ? current.filter((id) => id !== leagueId)
        : [...current, leagueId]
    ));
  };

  const handleResetFilters = () => {
    setSelectedLeagues([]);
    setSignalFilter('all');
    setSortBy('time');
    setSortOrder('asc');
  };

  const handleSortChange = (nextSort: SortBy) => {
    if (nextSort === sortBy) return;
    setSortBy(nextSort);
    setSortOrder(nextSort === 'time' ? 'asc' : 'desc');
  };

  const getCardRiskHint = (
    preMatchRisk: ReturnType<typeof buildPreMatchRisk>,
    isFinishedMatch: boolean
  ) => {
    if (isFinishedMatch) {
      return {
        tone: 'neutral' as const,
        label: language === 'zh' ? '已结算' : 'Settled'
      };
    }

    const hasReason = (code: string, minWeight = 0) => preMatchRisk.reasons.some((reason) => (
      reason.code === code && reason.weight >= minWeight
    ));
    const strongDraw = hasReason('draw-pressure', 18);
    const handicapMismatch = hasReason('handicap-mismatch');
    const mixedSp = hasReason('mixed-sp');
    const redCardRisk = hasReason('red-card-risk');
    const highUpset = preMatchRisk.score >= 60;

    if (!highUpset && !strongDraw && !handicapMismatch && !mixedSp && !redCardRisk) {
      return null;
    }

    const labels = language === 'zh'
      ? [
        highUpset ? '冷门提醒' : '防冷提醒',
        strongDraw ? '防平' : '',
        handicapMismatch ? '让球分歧' : '',
        mixedSp ? 'SP分歧' : '',
        redCardRisk ? '红牌变量' : ''
      ]
      : [
        highUpset ? 'Upset alert' : 'Risk watch',
        strongDraw ? 'draw cover' : '',
        handicapMismatch ? 'handicap split' : '',
        mixedSp ? 'SP split' : '',
        redCardRisk ? 'red-card swing' : ''
      ];

    return {
      tone: preMatchRisk.score >= 65 ? 'danger' as const : 'warning' as const,
      label: labels.filter(Boolean).slice(0, 3).join(language === 'zh' ? ' · ' : ' / ')
    };
  };

  const renderRecommendationCard = (match: Match, mode: 'pick' | 'watch' = 'pick') => {
    const homeTeam = getMatchDisplayTeam(match, 'home');
    const awayTeam = getMatchDisplayTeam(match, 'away');
    const signal = getMatchSignal(match);
    const preMatchRisk = buildPreMatchRisk(match);
    const cardRiskHint = getCardRiskHint(preMatchRisk, match.status === 'FINISHED');
    const fiveHundredDisplay = buildFiveHundredDisplay(match, language);
    const displayRecommendation = getDisplayRecommendation(match, language);
    const poolRows = getHomePageOddsRows(match, language).filter((row) => row.odds);
    const sportteryMeta = getSportteryMeta(match, language);
    const hasReferenceLean = Boolean(displayRecommendation);
    const directionLabel = displayRecommendation?.label || '';
    const cautionText = hasReferenceLean
      ? (language === 'zh' ? '按已开售玩法展示' : 'Based on an on-sale market')
      : (language === 'zh' ? '等待官方 SP 开售' : 'Await official SP sale');
    const pickText = hasReferenceLean && displayRecommendation
      ? language === 'zh'
        ? `推荐方向 ${directionLabel}`
        : `Pick ${directionLabel}`
      : signal.category === 'avoid'
        ? (language === 'zh' ? '推荐待临场复核' : 'Pick needs late recheck')
        : (language === 'zh' ? '待官方开售' : 'Pending official sale');
    const statusBadge = displayRecommendation?.prediction?.oddsPoolCode === 'HHAD' || displayRecommendation?.kind === 'handicap'
      ? (language === 'zh' ? '让球' : 'HHAD')
      : displayRecommendation
        ? (language === 'zh' ? '胜平负' : '1X2')
        : (language === 'zh' ? '待开售' : 'Pending');
    const oddsText = poolRows.length > 0
      ? poolRows.map((row) => {
        if (!row.odds) return '';
        const rowLabel = row.poolCode === 'HHAD' && row.handicap
          ? `${row.label}(${row.handicap})`
          : row.label;
        return `${rowLabel} ${row.odds.odds1.toFixed(2)}/${row.odds.oddsX.toFixed(2)}/${row.odds.odds2.toFixed(2)}`;
      }).filter(Boolean).join(' · ')
      : (language === 'zh' ? '胜平负/让球未开售' : '1X2/HHAD SP pending');
    const reason = displayRecommendation?.reason || getDecisionReason(signal.category, language);

    return (
      <button
        key={match.id}
        type="button"
        className={`recommendation-card is-${mode} is-${signal.category}`}
        onClick={() => onSelectMatch(match.id)}
      >
        <span className="recommendation-time">
          {formatKickoffTime(match.kickoffTime, language)}
        </span>
        {sportteryMeta && (
          <span className="recommendation-issue-meta">{sportteryMeta}</span>
        )}
        <span className="recommendation-teams">
          <span className="recommendation-team">
            <TeamBadge team={homeTeam} size="sm" />
            <span className="recommendation-team-name">{homeTeam.name[language]}</span>
          </span>
          <strong>VS</strong>
          <span className="recommendation-team">
            <TeamBadge team={awayTeam} size="sm" />
            <span className="recommendation-team-name">{awayTeam.name[language]}</span>
          </span>
        </span>
        <span className="recommendation-pick-row">
          <strong>{pickText}</strong>
          <span className={`signal-badge is-${signal.category}`}>{statusBadge}</span>
        </span>
        {mode === 'watch' && (
          <span className={`recommendation-caution is-${signal.category}`}>{cautionText}</span>
        )}
        {cardRiskHint && (
          <span className={`recommendation-diagnosis is-${cardRiskHint.tone}`}>
            {cardRiskHint.label}
          </span>
        )}
        {fiveHundredDisplay.cardHint && (
          <span className={`recommendation-500-hint is-${fiveHundredDisplay.cardHint.tone}`}>
            {fiveHundredDisplay.cardHint.label}
          </span>
        )}
        <span className="recommendation-odds">{oddsText}</span>
        <span className="recommendation-reason">{reason}</span>
      </button>
    );
  };

  const renderDecisionCell = (match: Match) => {
    const isFinished = match.status === 'FINISHED';
    const signal = getMatchSignal(match);
    const preMatchRisk = buildPreMatchRisk(match);
    const cardRiskHint = getCardRiskHint(preMatchRisk, isFinished);
    const fiveHundredDisplay = buildFiveHundredDisplay(match, language);
    const displayRecommendation = getDisplayRecommendation(match, language);
    const pickedPrediction = displayRecommendation?.prediction;
    const leadingOutcome = getLeadingOutcome(match);
    const leadProbability = displayRecommendation?.probability ?? (pickedPrediction && isOutcomeCode(pickedPrediction.tipCode)
      ? getOutcomeProbability(match, pickedPrediction.tipCode, pickedPrediction)
      : leadingOutcome?.probability ?? null);
    const leadCode = displayRecommendation?.tipCode && isOutcomeCode(displayRecommendation.tipCode)
      ? displayRecommendation.tipCode
      : pickedPrediction && isOutcomeCode(pickedPrediction.tipCode)
      ? pickedPrediction.tipCode
      : leadingOutcome?.code;
    const oneXTwoSupport = displayRecommendation?.support ?? getOneXTwoSupport(match, leadCode, pickedPrediction);
    const riskTags = getHomePageRiskTags(match);
    const showHit = isFinished && displayRecommendation?.prediction?.resultStatus === 'WON';
    const showMiss = isFinished && displayRecommendation?.prediction?.resultStatus === 'LOST';
    const isReferencePick = false;
    const poolStatus = displayRecommendation
      ? (displayRecommendation.prediction?.oddsPoolCode === 'HHAD' || displayRecommendation.kind === 'handicap'
        ? (language === 'zh' ? '让球' : 'HHAD')
        : (language === 'zh' ? '胜平负' : '1X2'))
      : isFinished
        ? (language === 'zh' ? '复盘' : 'Review')
        : (language === 'zh' ? '待开售' : 'Pending');
    const directionLabel = displayRecommendation?.label || (pickedPrediction
      ? stripDirectionPrefix(getRecommendationTipDisplay(pickedPrediction, language, true), language)
      : '');
    const primaryLabel = displayRecommendation
      ? language === 'zh'
        ? `推荐方向 ${directionLabel}`
        : `Pick ${directionLabel}`
      : pickedPrediction
        ? language === 'zh'
          ? `推荐方向 ${directionLabel}`
          : `Pick ${directionLabel}`
      : '';
    const fallbackPrimaryLabel = signal.category === 'finished'
        ? (language === 'zh' ? '赛后复盘' : 'Review')
        : (language === 'zh' ? '待官方开售' : 'Pending official sale');
    const primaryMeta = displayRecommendation?.meta || (pickedPrediction && pickedPrediction.odds > 0
      ? `${getPredictionValueLabel(pickedPrediction, language)} ${pickedPrediction.odds.toFixed(2)}`
      : leadCode && leadProbability !== null
        ? `${outcomeLabels[leadCode][language]} ${Math.round(leadProbability)}%`
        : '--');
    const shortReason = displayRecommendation?.reason || getDecisionReason(signal.category, language);

    return (
      <div className={`decision-card is-${signal.category} ${displayRecommendation || pickedPrediction ? 'has-pick' : 'is-watch-only'} ${isReferencePick ? 'is-reference' : ''} ${showHit ? 'is-hit' : ''} ${showMiss ? 'is-miss' : ''}`}>
        <div className="decision-main">
          <span className="decision-label">{primaryLabel || fallbackPrimaryLabel}</span>
          <span className="decision-meta">{primaryMeta}</span>
          {showHit && <span className="mini-hit">{t('hit')}</span>}
          {showMiss && <span className="mini-miss">{t('miss')}</span>}
        </div>

        <div className="decision-facts">
          <span>
            {language === 'zh' ? '模型' : 'Model'}
            <strong>{leadProbability === null ? '--' : `${Math.round(leadProbability)}%`}</strong>
          </span>
          <span>
            {language === 'zh' ? 'SP' : 'SP'}
            <strong>{oneXTwoSupport === null ? '--' : `${oneXTwoSupport}%`}</strong>
          </span>
          <span>
            {language === 'zh' ? '玩法' : 'Market'}
            <strong>{poolStatus}</strong>
          </span>
          {cardRiskHint && (
            <span className={`decision-risk-fact is-${cardRiskHint.tone}`}>
              {isFinished ? (language === 'zh' ? '复盘' : 'Review') : (language === 'zh' ? '防冷' : 'Risk')}
              <strong>{cardRiskHint.label}</strong>
            </span>
          )}
          {fiveHundredDisplay.cardHint && (
            <span className={`decision-500-fact is-${fiveHundredDisplay.cardHint.tone}`}>
              500
              <strong>{fiveHundredDisplay.cardHint.label.replace(/^500[:：]\s*/, '')}</strong>
            </span>
          )}
        </div>

        <div className="decision-reason">
          <span>{shortReason}</span>
        </div>

        {riskTags.length > 0 && (
          <div className="decision-risks">
            {riskTags.map((tag) => (
              <span key={`${tag.zh}-${tag.en}`}>{tag[language]}</span>
            ))}
          </div>
        )}

      </div>
    );
  };

  const quickDateOptions = [
    { label: t('yesterday'), date: yesterdayStr },
    { label: t('today'), date: todayStr },
    { label: t('tomorrow'), date: tomorrowStr },
    { label: t('dayAfterTomorrow'), date: dayAfterTomorrowStr }
  ];

  const historyDateOptions = (() => {
    const quickDates = new Set(quickDateOptions.map((option) => option.date));
    const matchDates = matches
      .flatMap(getMatchDateCandidates)
      .filter(Boolean);
    const historyDates = Array.from(new Set(matchDates))
      .filter((date) => !quickDates.has(date))
      .sort((a, b) => b.localeCompare(a));

    return historyDates.map((date) => {
      return {
        label: date < todayStr ? (language === 'zh' ? '历史' : 'History') : (language === 'zh' ? '赛事日' : 'Match day'),
        date
      };
    });
  })();

  const selectedHistoryDate = historyDateOptions.some((option) => option.date === effectiveSelectedDate) ? effectiveSelectedDate : '';

  const sourceFallback = dataSync.sourceFallback;
  const hasSourceFallback = Boolean(
    sourceFallback?.keptExisting ||
    ((sourceFallback?.sportteryPublishableMatches ?? null) === 0 && (sourceFallback?.fiveHundredFallbackMatches ?? 0) > 0)
  );
  const sourceFallbackLabel = language === 'zh'
    ? `后台已检查，官方竞彩本轮未返回新的开售数据；当前使用锁定快照 + 500 校验。`
    : `Backend checked successfully, but Sporttery returned no fresh on-sale data; using the locked snapshot plus 500.com checks.`;

  const isCurrentDataLoading = Boolean(
    dataSync.currentLoading ||
    (!dataSync.currentLoaded && !dataSync.error && !dataSync.lastCheckedAt)
  );

  const dataSyncSummary = isCurrentDataLoading
    ? t('dataCurrentLoading')
    : dataSync.error && !dataSync.currentLoaded
    ? t('dataFallbackNote')
    : (() => {
      const sourceAgeMinutes = typeof dataSync.sourceAgeSeconds === 'number'
        ? Math.max(0, Math.floor(dataSync.sourceAgeSeconds / 60))
        : getDataAgeMinutes(dataSync.sourceUpdatedAt || dataSync.updatedAt, nowMs);
      const staleThresholdMinutes = Math.max((dataSync.backendRefreshMinutes || 5) * 3, 10);
      const isDataStale = dataSync.currentLoaded && sourceAgeMinutes !== null && sourceAgeMinutes > staleThresholdMinutes;
      if (isDataStale) {
        const lastAttemptLabel = formatSyncTime(dataSync.lastAttemptAt || dataSync.lastCheckedAt, language);
        return language === 'zh'
          ? `数据源已 ${formatAgeMinutes(sourceAgeMinutes, language)} 未发布新快照；后台最近检查 ${lastAttemptLabel}。`
          : `Source data is ${formatAgeMinutes(sourceAgeMinutes, language)} old; last background check ${lastAttemptLabel}.`;
      }
      if (hasSourceFallback) return sourceFallbackLabel;
      if (dataSync.dataChannel === 'static') {
        return language === 'zh'
          ? '当前使用静态快照展示；实时接口恢复后会自动切回。'
          : 'Using the static snapshot now; it will switch back to the live API automatically.';
      }
      if (dataSync.error && dataSync.currentLoaded && !dataSync.historyLoaded) return t('dataHistoryUnavailable');
      if (dataSync.historyLoading) return t('dataHistoryLoading');
      if (dataSync.historyLoaded) return t('dataHistoryReady');
      return t('dataCurrentLoading');
    })();

  const sourceAgeMinutes = typeof dataSync.sourceAgeSeconds === 'number'
    ? Math.max(0, Math.floor(dataSync.sourceAgeSeconds / 60))
    : getDataAgeMinutes(dataSync.sourceUpdatedAt || dataSync.updatedAt, nowMs);
  const staleThresholdMinutes = Math.max((dataSync.backendRefreshMinutes || 5) * 3, 10);
  const isDataStale = dataSync.currentLoaded && sourceAgeMinutes !== null && sourceAgeMinutes > staleThresholdMinutes;

  const dataSyncTone = isCurrentDataLoading
    ? 'is-loading'
    : dataSync.error || isDataStale || hasSourceFallback
    ? 'is-warning'
    : dataSync.historyLoading
      ? 'is-loading'
      : dataSync.historyLoaded
        ? 'is-ready'
        : '';

  const dataSyncItems = [
    {
      label: t('dataChannel'),
      value: dataSync.dataChannel === 'api'
        ? t('dataChannelApi')
        : dataSync.dataChannel === 'static'
          ? t('dataChannelStatic')
          : dataSync.dataChannel === 'mock'
            ? t('dataChannelMock')
            : '--'
    },
    {
      label: t('dataCurrent'),
      value: isCurrentDataLoading
        ? t('dataLoading')
        : dataSync.currentLoaded
        ? `${dataSync.currentCount} ${t('matchUnit')}`
        : dataSync.error
          ? t('dataFallback')
          : t('dataLoading')
    },
    {
      label: t('dataHistory'),
      value: dataSync.historyLoaded || dataSync.historyCount > 0
        ? `${dataSync.historyCount} ${t('matchUnit')}`
        : dataSync.historyLoading
          ? t('dataSyncing')
          : '--'
    },
    {
      label: t('dataTotal'),
      value: `${dataSync.totalCount || matches.length} ${t('matchUnit')}`
    },
    {
      label: t('dataStatus'),
      value: language === 'zh'
        ? `完 ${dataSync.byStatus?.FINISHED || 0} / 赛 ${dataSync.byStatus?.LIVE || 0} / 待果 ${dataSync.byStatus?.PENDING_RESULT || 0} / 待 ${dataSync.byStatus?.SCHEDULED || 0}`
        : `F ${dataSync.byStatus?.FINISHED || 0} / L ${dataSync.byStatus?.LIVE || 0} / R ${dataSync.byStatus?.PENDING_RESULT || 0} / S ${dataSync.byStatus?.SCHEDULED || 0}`
    },
    {
      label: hasSourceFallback
        ? (language === 'zh' ? '后台检查' : 'Backend check')
        : t('dataUpdated'),
      value: sourceAgeMinutes !== null
        ? `${formatSyncTime(dataSync.sourceUpdatedAt || dataSync.updatedAt, language)} / ${formatAgeMinutes(sourceAgeMinutes, language)}`
        : formatSyncTime(dataSync.sourceUpdatedAt || dataSync.updatedAt, language)
    },
    {
      label: t('dataRefresh'),
      value: language === 'zh'
        ? `页面 ${formatSyncTime(dataSync.lastCheckedAt, language)} / 后台 ${formatSyncTime(dataSync.lastAttemptAt || dataSync.sourceUpdatedAt || dataSync.updatedAt, language)} / 每 ${dataSync.refreshIntervalSeconds || 30} 秒`
        : `Page ${formatSyncTime(dataSync.lastCheckedAt, language)} / Backend ${formatSyncTime(dataSync.lastAttemptAt || dataSync.sourceUpdatedAt || dataSync.updatedAt, language)} / Every ${dataSync.refreshIntervalSeconds || 30}s`
    },
    {
      label: t('dataNextCheck'),
      value: (() => {
        const seconds = getNextCheckSeconds(dataSync.lastCheckedAt, dataSync.refreshIntervalSeconds, nowMs);
        if (seconds === null) return '--';
        if (seconds === 0) return language === 'zh' ? '检查中' : 'Checking';
        return `${seconds}s`;
      })()
    }
  ];

  const activeSourceMatches = matches.filter((match) => match.status !== 'FINISHED');
  const sourceHealth = dataSync.sourceHealth;
  const sourceCurrentCount = sourceHealth?.currentMatches?.count || activeSourceMatches.length || dataSync.currentCount || 0;
  const sourceExternalCount = sourceHealth?.currentMatches?.withExternalSignals
    ?? activeSourceMatches.filter((match) => match.externalSignals && Object.keys(match.externalSignals).length > 0).length;
  const sourceCoverage = typeof sourceHealth?.currentMatches?.externalCoverage === 'number'
    ? Math.round(sourceHealth.currentMatches.externalCoverage * 100)
    : sourceCurrentCount > 0
      ? Math.round((sourceExternalCount / sourceCurrentCount) * 100)
      : 0;
  const officialOddsCount = activeSourceMatches.filter((match) => getOfficialResultPoolAvailability(match).hasHad).length;
  const fiveHundredDetailsCount = Math.max(
    sourceHealth?.externalSignals?.fiveHundredDetailsCachedMerged ?? 0,
    activeSourceMatches.filter((match) => match.externalSignals?.fiveHundred).length
  );
  const fiveHundredErrors = sourceHealth?.externalSignals?.fiveHundredDetailsErrors || 0;
  const apiFootballMapped = Math.max(
    sourceHealth?.externalSignals?.apiFootballMappedSignals ?? 0,
    activeSourceMatches.filter((match) => match.externalSignals?.apiFootball).length
  );
  const apiFootballCallsThisSync = sourceHealth?.externalSignals?.apiFootballCallsThisSync ?? 0;
  const apiFootballCallsToday = sourceHealth?.externalSignals?.apiFootballCallsTodayEstimate ?? 0;
  const sourceHealthItems = [
    ...(hasSourceFallback ? [{
      label: language === 'zh' ? '官方源状态' : 'Official source',
      value: language === 'zh' ? '锁定快照' : 'Locked',
      note: language === 'zh'
        ? `本轮官方 ${sourceFallback?.sportteryPublishableMatches ?? 0} 场，500补充 ${sourceFallback?.fiveHundredFallbackMatches ?? 0} 场`
        : `${sourceFallback?.sportteryPublishableMatches ?? 0} official this run, ${sourceFallback?.fiveHundredFallbackMatches ?? 0} from 500.com`
    }] : []),
    {
      label: language === 'zh' ? '官方竞彩' : 'Sporttery',
      value: `${officialOddsCount}/${sourceCurrentCount}`,
      note: language === 'zh' ? '胜平负官方SP' : '1X2 official SP'
    },
    {
      label: language === 'zh' ? '500详情' : '500 detail',
      value: `${fiveHundredDetailsCount}/${sourceCurrentCount}`,
      note: fiveHundredErrors > 0
        ? (language === 'zh' ? `限频保护 ${fiveHundredErrors} 条` : `${fiveHundredErrors} throttled`)
        : (language === 'zh' ? '缓存合并可用' : 'cache merged')
    },
    {
      label: 'API-Football',
      value: `${apiFootballMapped}`,
      note: language === 'zh'
        ? `本轮 ${apiFootballCallsThisSync} 次 / 今日约 ${apiFootballCallsToday} 次`
        : `${apiFootballCallsThisSync} this sync / ${apiFootballCallsToday} today`
    },
    {
      label: language === 'zh' ? '外部覆盖' : 'Coverage',
      value: `${sourceCoverage}%`,
      note: `${sourceExternalCount}/${sourceCurrentCount}`
    }
  ];

  const dashboardUpdatedAt = formatSyncTime(
    dataSync.sourceUpdatedAt || dataSync.updatedAt || dataSync.lastCheckedAt,
    language
  );
  const dashboardSourceStatus = isCurrentDataLoading
    ? (language === 'zh' ? '数据同步中' : 'Syncing')
    : dataSync.error && !dataSync.currentLoaded
      ? (language === 'zh' ? '校验状态异常' : 'Validation issue')
      : sourceHealth?.ok === false || hasSourceFallback
        ? (language === 'zh' ? '快照保护' : 'Snapshot guard')
        : dataSync.currentLoaded
          ? (language === 'zh' ? '竞彩源正常' : 'Source ready')
          : (language === 'zh' ? '等待同步' : 'Waiting');
  const selectedDateIsToday = effectiveSelectedDate === todayStr;
  const kickoffDayLabel = selectedDateIsToday
    ? (language === 'zh' ? '今日相关' : 'Today slate')
    : (language === 'zh' ? '本日相关' : 'Selected slate');
  const previousIssueLabel = selectedDateIsToday
    ? (language === 'zh' ? '昨日延续' : 'prior issue')
    : (language === 'zh' ? '前期延续' : 'prior issue');
  const sameIssueLabel = selectedDateIsToday
    ? (language === 'zh' ? '今日竞彩' : 'today issue')
    : (language === 'zh' ? '本日竞彩' : 'same issue');
  const issueSplitText = language === 'zh'
    ? `${previousIssueLabel} ${dateIdentityCounts.previousIssue} / ${sameIssueLabel} ${dateIdentityCounts.sameIssue}`
    : `${previousIssueLabel} ${dateIdentityCounts.previousIssue} / ${sameIssueLabel} ${dateIdentityCounts.sameIssue}`;
  const kickoffMetricNote = language === 'zh'
    ? `${formatShortDate(effectiveSelectedDate, language)} · 含跨夜竞彩日 · 按开赛时间排序`
    : `${formatShortDate(effectiveSelectedDate, language)} · includes cross-midnight issue day · sorted by kickoff`;
  const dashboardStatusItems = [
    {
      label: language === 'zh' ? '数据更新' : 'Updated',
      value: dashboardUpdatedAt
    },
    {
      label: language === 'zh' ? '数据源状态' : 'Source',
      value: dashboardSourceStatus
    },
    {
      label: kickoffDayLabel,
      value: `${baseFilteredMatches.length} ${t('matchUnit')}`
    },
    {
      label: language === 'zh' ? '竞彩归属' : 'Issue split',
      value: issueSplitText
    },
    {
      label: language === 'zh' ? '预测锁定' : 'Lock',
      value: language === 'zh' ? '按竞彩截止' : 'By cutoff'
    }
  ];

  const metrics = [
    {
      label: kickoffDayLabel,
      value: String(baseFilteredMatches.length),
      note: kickoffMetricNote,
      icon: CalendarDays,
      tone: 'accent'
    },
    {
      label: language === 'zh' ? '有推荐' : 'Recommended',
      value: String(recommendationCounts.recommended),
      note: language === 'zh' ? '只统计官方已开售玩法' : 'Only on-sale official markets count',
      icon: ShieldCheck,
      tone: 'success'
    },
    {
      label: language === 'zh' ? '胜平负开售' : '1X2 on sale',
      value: String(recommendationCounts.had),
      note: language === 'zh' ? '可显示主胜/平/客胜' : 'Can show home/draw/away',
      icon: Sparkles,
      tone: 'premium'
    },
    {
      label: language === 'zh' ? '让球开售' : 'HHAD on sale',
      value: String(recommendationCounts.hhad),
      note: recommendationCounts.unavailable > 0
        ? (language === 'zh' ? `${recommendationCounts.unavailable} 场仍待开售` : `${recommendationCounts.unavailable} still pending sale`)
        : (language === 'zh' ? '当前赛事都有可用玩法' : 'All current fixtures have a market'),
      icon: Activity,
      tone: recommendationCounts.unavailable > 0 ? 'premium' : ''
    }
  ];

  const emptyStateText = isCurrentDataLoading
    ? (language === 'zh'
      ? '数据同步中，正在读取今日赛程与官方胜平负 SP。'
      : 'Data is syncing: loading today schedule, official SP, and market snapshots.')
    : (!dataSync.currentLoaded && dataSync.error) || sourceHealth?.ok === false
      ? (language === 'zh'
        ? '校验状态异常：当前数据源未通过完整性检查，请稍后刷新。'
        : 'Validation issue: the current source did not pass completeness checks. Try again shortly.')
      : baseFilteredMatches.length === 0
        ? (effectiveSelectedDate === todayStr
          ? (language === 'zh' ? '今日暂无开售赛事，数据会继续自动同步。' : 'No on-sale fixtures today. Sync will keep checking.')
          : (language === 'zh' ? '当前日期暂无开售赛事。' : 'No on-sale fixtures for this date.'))
        : signalFilter === 'recommended'
          ? t('noQualifiedPicks')
          : t('noMatches');

  return (
    <div className="dashboard-stack">
      <section className="dashboard-hero" aria-label={language === 'zh' ? '足球数据看板' : 'Football data dashboard'}>
        <div className="dashboard-hero-copy">
          <span>{language === 'zh' ? '竞彩赛程 / 胜平负 SP / AI 决策' : 'Schedule / 1X2 SP / AI Decision'}</span>
          <h1>{language === 'zh' ? '足球数据看板' : 'Football Data Board'}</h1>
          <p>
            {language === 'zh'
              ? '核心是赛前决策校验：展示今日比赛、模型方向与官方胜平负 SP；截止后预测不回改，只做赛果复盘。'
              : 'A pre-match decision board: today fixtures, model lean, and official 1X2 SP. After cutoff, predictions are locked for review only.'}
          </p>
        </div>
        <div className="dashboard-hero-status">
          {dashboardStatusItems.map((item) => (
            <span key={item.label}>
              {item.label}
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
      </section>

      <section className="notice-banner" aria-label="reference notice">
          <div className="notice-copy">
            <span className="notice-icon">
              <Sparkles size={20} />
            </span>
            <p className="notice-text">{t('referenceNotice')}</p>
          </div>
      </section>

      <WorldCupSpotlight
        matches={matches}
        language={language}
        onOpenWorldCup={onOpenWorldCup}
        onSelectMatch={onSelectMatch}
      />

      <section className="metrics-grid" aria-label="Dashboard summary">
        {metrics.map((metric) => {
          const Icon = metric.icon;

          return (
            <article key={metric.label} className="metric-card">
              <div className="metric-head">
                <span className="metric-label">{metric.label}</span>
                <span className={`metric-icon ${metric.tone}`}>
                  <Icon size={20} />
                </span>
              </div>
              <div>
                <div className="metric-value">{metric.value}</div>
                <div className="metric-note">{metric.note}</div>
              </div>
            </article>
          );
        })}
      </section>

      <section className={`data-sync-strip ${dataSyncTone}`} aria-label={t('dataStatusTitle')}>
        <div className="data-sync-copy">
          <span className="data-sync-dot" />
          <strong>{t('dataStatusTitle')}</strong>
          <span>{dataSyncSummary}</span>
        </div>
        <div className="data-sync-items">
          {dataSyncItems.slice(0, 3).map((item) => (
            <span key={item.label}>
              {item.label}
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
      </section>

      <details className={`source-health-panel source-health-details ${sourceHealth?.ok === false || hasSourceFallback ? 'is-warning' : 'is-ready'}`} aria-label={language === 'zh' ? '数据源状态' : 'Data source status'}>
        <summary className="source-health-head">
          <div>
            <strong>{language === 'zh' ? '数据源状态' : 'Data source status'}</strong>
            <span>
              {hasSourceFallback
                ? (language === 'zh'
                  ? `官方源保留快照 · 500补充 ${sourceFallback?.fiveHundredFallbackMatches ?? 0} 场`
                  : `Official source locked · ${sourceFallback?.fiveHundredFallbackMatches ?? 0} from 500.com`)
                : language === 'zh'
                ? `官方 SP ${officialOddsCount}/${sourceCurrentCount} · 外部覆盖 ${sourceCoverage}%`
                : `Official SP ${officialOddsCount}/${sourceCurrentCount} · Coverage ${sourceCoverage}%`}
            </span>
          </div>
          <span className="source-health-time">
            {sourceHealth?.checkedAt
              ? `${language === 'zh' ? '检查' : 'Checked'} ${formatSyncTime(sourceHealth.checkedAt, language)}`
              : '--'}
          </span>
        </summary>
        <div className="source-health-grid">
          {sourceHealthItems.map((item) => (
            <article key={item.label} className="source-health-item">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.note}</small>
            </article>
          ))}
        </div>
        {sourceHealth?.errors && sourceHealth.errors.length > 0 && (
          <div className="source-health-errors">
            {sourceHealth.errors.slice(0, 3).map((error) => (
              <span key={error}>{error}</span>
            ))}
          </div>
        )}
      </details>

      <section className="date-toolbar" aria-label="Date filters">
        <div className="date-quick-row">
          {quickDateOptions.map((option) => (
            <button
              key={option.date}
              type="button"
              onClick={() => setSelectedDate(option.date)}
              className={`date-chip ${effectiveSelectedDate === option.date ? 'active' : ''}`}
            >
              <span className="date-label">{option.label}</span>
              <span className="date-value">{formatShortDate(option.date, language)}</span>
            </button>
          ))}
        </div>
        {historyDateOptions.length > 0 && (
          <label className={`history-date-select ${selectedHistoryDate ? 'active' : ''}`}>
            <CalendarDays size={15} />
            <select
              aria-label={language === 'zh' ? '历史日期' : 'History dates'}
              value={selectedHistoryDate}
              onChange={(event) => {
                if (event.target.value) {
                  setSelectedDate(event.target.value);
                }
              }}
            >
              <option value="">{language === 'zh' ? '历史日期' : 'History'}</option>
              {historyDateOptions.map((option) => (
                <option key={option.date} value={option.date}>
                  {option.label} · {formatShortDate(option.date, language)}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className={`recommendation-panel ${!hasQualifiedPicks ? 'is-empty' : ''}`} aria-label={t('recommended')}>
        <div className="recommendation-panel-head">
          <div>
            <span className="panel-kicker">{formatShortDate(effectiveSelectedDate, language)}</span>
            <strong>{language === 'zh' ? '今日推荐' : 'Today Recommendations'}</strong>
          </div>
          <span className="recommendation-count">
            {hasQualifiedPicks
              ? `${actionableMatches.length} ${language === 'zh' ? '场' : 'matches'}`
              : (language === 'zh' ? '待开售' : 'Pending sale')}
          </span>
        </div>

        {hasQualifiedPicks ? (
          <div className="recommendation-grid">
            {actionableMatches.slice(0, 6).map((match) => renderRecommendationCard(match))}
          </div>
        ) : (
          <div className="recommendation-empty-copy">
            <strong>{language === 'zh' ? '等待官方开售' : 'Waiting for official sale'}</strong>
            <span>
              {language === 'zh'
                ? '当前没有已开售的胜平负或让球胜平负可推荐，等下一轮 SP 更新。'
                : 'No on-sale 1X2 or HHAD recommendation is available yet. Wait for the next SP refresh.'}
            </span>
          </div>
        )}
      </section>

      <section className="panel filters-panel" aria-label="Filters">
        <div className="panel-row is-stacked">
          <span className="panel-label">
            <Trophy size={16} />
            {t('filterTitle')}
          </span>
          <div className="chip-row">
            <button
              type="button"
              onClick={() => setSelectedLeagues([])}
              className={`filter-chip ${effectiveSelectedLeagues.length === 0 ? 'active' : ''}`}
            >
              {t('allLeagues')}
            </button>
            {availableLeagues.map((league) => {
              const isSelected = effectiveSelectedLeagues.includes(league.id);
              const country = getCountryById(league.countryId);
              const leagueLabel = league.shortName[language] || league.name[language];

              return (
                <button
                  key={league.id}
                  type="button"
                  onClick={() => handleLeagueToggle(league.id)}
                  className={`filter-chip ${isSelected ? 'active' : ''}`}
                >
                  <span>{country.flag}</span>
                  <span>{leagueLabel}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel-row is-stacked">
          <span className="panel-label">
            <ShieldCheck size={16} />
            {t('signalTitle')}
          </span>
          <div className="chip-row">
            {visibleSignalFilters.map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setSignalFilter(filter)}
                className={`filter-chip signal-chip is-${filter} ${signalFilter === filter ? 'active' : ''}`}
              >
                <span>{getSignalFilterLabel(filter)}</span>
                <strong>{signalCounts[filter]}</strong>
              </button>
            ))}
          </div>
        </div>

        <div className="panel-row">
          <div className="sort-controls">
            <span className="panel-label">
              <SlidersHorizontal size={16} />
              {t('sortTitle')}
            </span>
            <div className="segmented">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => handleSortChange(option)}
                  className={`segment-btn ${sortBy === option ? 'active' : ''}`}
                >
                  {t(option)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'))}
              className="sort-order-btn"
              aria-label={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
            >
              {sortOrder === 'asc' ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              {sortOrder === 'asc' ? 'ASC' : 'DESC'}
            </button>
          </div>

          <button type="button" onClick={handleResetFilters} className="reset-btn">
            <RotateCcw size={14} />
            {t('reset')}
          </button>
        </div>
      </section>

      {groupedMatches.length === 0 ? (
        <section className="empty-state">
          <div>
            <CalendarDays size={40} />
            <p>{emptyStateText}</p>
          </div>
        </section>
      ) : (
        <section className="league-stack" aria-label="Match predictions">
          {groupedMatches.map((group) => (
            <article key={`${group.country.id}_${group.league.id}`} className="league-card">
              <header className="league-header">
                <div className="league-title">
                  <span>{group.country.flag}</span>
                  <strong>{group.league.name[language]}</strong>
                  <span className="league-meta">{group.country.name[language]}</span>
                </div>
                <span className="league-count">
                  {group.matches.length} {t('leagueMatches')}
                </span>
              </header>

              <div className="table-scroll">
                <table className="responsive-table">
                  <thead>
                    <tr>
                      <th style={{ width: '132px' }}>{t('statusTime')}</th>
                      <th>{t('teams')}</th>
                      <th style={{ width: '260px', textAlign: 'center' }}>{t('oddsHeader')}</th>
                      <th style={{ width: '380px', textAlign: 'left' }}>{language === 'zh' ? 'AI决策' : 'AI Decision'}</th>
                      <th style={{ width: '84px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {group.matches.map((match) => {
                      const homeTeam = getMatchDisplayTeam(match, 'home');
                      const awayTeam = getMatchDisplayTeam(match, 'away');
                      const isLive = match.status === 'LIVE';
                      const isFinished = match.status === 'FINISHED';
                      const isPendingResult = match.status === 'PENDING_RESULT';
                      const hasScore = hasOfficialScore(match);
                      const score = hasScore ? `${match.scoreHome}:${match.scoreAway}` : '--:--';
                      const liveText = hasScore
                        ? `${t('live')} ${score}`
                        : minutesSinceKickoff(match) >= 130
                          ? t('awaitingResult')
                          : t('liveScorePending');
                      const formattedTime = formatKickoffTime(match.kickoffTime, language);
                      const poolRows = getHomePageOddsRows(match, language);
                      const signal = getMatchSignal(match);
                      const rowRecommendation = getDisplayRecommendation(match, language);
                      const sportteryMeta = getSportteryMeta(match, language);

                      return (
                        <tr
                          key={match.id}
                          className="match-row"
                          onClick={() => onSelectMatch(match.id)}
                        >
                          <td className="match-time-cell" data-label={t('statusTime')}>
                            <div className="time-stack">
                              {isPendingResult ? (
                                <span className="badge">{t('awaitingResult')}</span>
                              ) : isLive ? (
                                <span className={hasScore ? 'badge badge-live' : 'badge'}>{liveText}</span>
                              ) : isFinished ? (
                                <span className="badge">{t('finished')} {score}</span>
                              ) : (
                                <>
                                  <span className="kickoff-time">{formattedTime}</span>
                                  <span className="status-note">{t('pending')}</span>
                                </>
                              )}
                              {sportteryMeta && (
                                <span className="status-note is-muted">{sportteryMeta}</span>
                              )}
                            </div>
                          </td>

                          <td className="match-teams-cell" data-label={t('teams')}>
                            <div className="team-stack">
                              <div className="team-line">
                                <TeamBadge team={homeTeam} size="sm" />
                                <span className="team-name">{homeTeam.name[language]}</span>
                              </div>
                              <div className="team-line">
                                <TeamBadge team={awayTeam} size="sm" />
                                <span className="team-name">{awayTeam.name[language]}</span>
                              </div>
                              <div className="match-signal-line">
                                <span className={`signal-badge ${isFinished ? 'is-finished' : rowRecommendation ? 'is-lean' : 'is-unavailable'}`}>
                                  {isFinished
                                    ? t('finished')
                                    : isPendingResult
                                      ? t('awaitingResult')
                                      : rowRecommendation
                                        ? (language === 'zh' ? '有推荐' : 'Recommended')
                                        : (language === 'zh' ? '待开售' : 'Pending sale')}
                                </span>
                                {!isFinished && rowRecommendation && signal.riskCount > 0 && (
                                  <span className="signal-risk-count">
                                    {language === 'zh' ? `风险 ${signal.riskCount}` : `${signal.riskCount} risks`}
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>

                          <td className="match-odds-cell" data-label={t('oddsHeader')} style={{ textAlign: 'center' }}>
                            {poolRows.length > 0 ? (
                              <div className="sporttery-pool-stack">
                                <div className="sporttery-pool-head">
                                  <span>{language === 'zh' ? '玩法' : 'Market'}</span>
                                  <span>{language === 'zh' ? '胜' : 'H'}</span>
                                  <span>{language === 'zh' ? '平' : 'D'}</span>
                                  <span>{language === 'zh' ? '负' : 'A'}</span>
                                  <span>{language === 'zh' ? '支持率' : 'Prob.'}</span>
                                </div>
                                {poolRows.map((row) => {
                                  const rowMarketLabel = row.poolCode === 'HHAD' && row.handicap
                                    ? `${row.label} ${row.handicap}`
                                    : row.label;

                                  return (
                                    <div key={row.poolCode} className={`sporttery-pool-row ${row.odds ? '' : 'is-closed'}`}>
                                      <span className="pool-line">{rowMarketLabel}</span>
                                    {row.odds ? (
                                      <>
                                        <strong>{row.odds.odds1.toFixed(2)}</strong>
                                        <strong>{row.odds.oddsX.toFixed(2)}</strong>
                                        <strong>{row.odds.odds2.toFixed(2)}</strong>
                                        <span className="pool-prob">
                                          {row.probabilities
                                            ? `${row.probabilities.home}/${row.probabilities.draw}/${row.probabilities.away}%`
                                            : '--'}
                                        </span>
                                      </>
                                    ) : (
                                      <>
                                        <span className="pool-closed">{isFinished ? t('archivedOdds') : t('closed')}</span>
                                        <span>--</span>
                                        <span>--</span>
                                        <span>--</span>
                                      </>
                                    )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <span className="status-note">--</span>
                            )}
                          </td>

                          <td className="match-decision-cell" data-label={language === 'zh' ? 'AI决策' : 'AI Decision'}>
                            {renderDecisionCell(match)}
                          </td>

                          <td className="match-action-cell" style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              className="details-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                onSelectMatch(match.id);
                              }}
                            >
                              {t('details')}
                              <ArrowRight size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
};
