import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trophy
} from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import { formatBeijingDateString, getDateStringOffset } from '../services/mockData';
import type { Country, League, Match, PredictionDetail, Team } from '../services/mockData';
import {
  getImpliedProbabilities,
  getOfficialMatchOdds,
  getOfficialResultPoolAvailability,
  getPredictionMarketLabel,
  getPredictionTipDisplay,
  getResolvedMatchOdds,
  getSportteryPoolRows,
  isPredictionOfficialResultPoolAvailable
} from '../services/bettingDisplay';
import type { SportteryOddsPoolDisplay } from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal, type MatchSignalCategory } from '../services/matchSignal';
import { getVisiblePrediction } from '../services/predictionVisibility';
import { buildPublicRecommendationCopy } from '../services/recommendationCopy';
import { getAnalysisReferenceHandicapSupplement, getAvailableResultPools, getDisplayRecommendation, getHandicapCompanionHeading, getLiveDisplayRecommendation } from '../services/displayRecommendation';
import type { DisplayRecommendation } from '../services/displayRecommendation';
import { isOfficialRecommendationEligible } from '../services/officialRecommendationEligibility';
import {
  getOnSaleAnalysisReference as selectAnalysisReferencePrediction,
  selectOnSaleAnalysisReference,
  type AnalysisReferenceSource
} from '../services/analysisReferenceSelection';
import {
  buildFiveHundredMarketReferencePresentation,
  isFiveHundredMarketReferencePrediction
} from '../services/externalOddsReferencePresentation';
import { isBeforeMatchSaleCutoff } from '../services/matchLifecycle';
import { getMatchEventKey } from '../services/atomicMatchRefresh';
import { getArchivedPreMatchPrediction } from '../services/archivedPreMatchPrediction';
import { getProvisionalArchivedOutcome } from '../services/provisionalResultPresentation';
import { liveRecommendationCutoffIso } from '../services/liveRecommendationEligibility';
import { buildLiveScorePresentation } from '../services/liveScorePresentation';
import { TeamBadge } from '../components/TeamBadge';
import { DateScopeBar } from '../components/predictions/DateScopeBar';
import { MatchSummaryRow } from '../components/predictions/MatchSummaryRow';
import { PredictionsPageHeader } from '../components/predictions/PredictionsPageHeader';
import { RecommendationEvidenceFacts } from '../components/predictions/RecommendationEvidenceFacts';
import '../styles/predictions.css';

interface PredictionsListProps {
  onSelectMatch: (matchId: string) => void;
  viewMode: 'analysis' | 'fixtures';
}

type SortBy = 'time' | 'odds';

const SORT_OPTIONS: SortBy[] = ['time', 'odds'];
const LIST_VIEW_STATE_TTL_MS = 30 * 60 * 1000;
const LIST_RETURN_SCROLL_TTL_MS = 10 * 60 * 1000;

type StoredListViewState = {
  savedAt: number;
  selectedDate: string;
  selectedLeagues: string[];
  sortBy: SortBy;
  sortOrder: 'asc' | 'desc';
};

type StoredReturnScroll = {
  savedAt: number;
  scrollY: number;
};

const listViewStorageKey = (viewMode: PredictionsListProps['viewMode']) => `football.listView.${viewMode}`;
const listReturnScrollKey = (viewMode: PredictionsListProps['viewMode']) => (
  `football.listReturnScroll.${viewMode === 'fixtures' ? '/fixtures' : '/predictions'}`
);

const readStoredListViewState = (viewMode: PredictionsListProps['viewMode']): StoredListViewState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(listViewStorageKey(viewMode)) || 'null') as Partial<StoredListViewState> | null;
    if (!parsed || !Number.isFinite(parsed.savedAt) || Date.now() - Number(parsed.savedAt) > LIST_VIEW_STATE_TTL_MS) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.selectedDate || ''))) return null;
    return {
      savedAt: Number(parsed.savedAt),
      selectedDate: String(parsed.selectedDate),
      selectedLeagues: Array.isArray(parsed.selectedLeagues)
        ? parsed.selectedLeagues.filter((item): item is string => typeof item === 'string')
        : [],
      sortBy: SORT_OPTIONS.includes(parsed.sortBy as SortBy) ? parsed.sortBy as SortBy : 'time',
      sortOrder: parsed.sortOrder === 'desc' ? 'desc' : 'asc'
    };
  } catch {
    return null;
  }
};

const hasFreshListReturnScroll = (viewMode: PredictionsListProps['viewMode']): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(listReturnScrollKey(viewMode)) || 'null') as Partial<StoredReturnScroll> | null;
    return Boolean(
      parsed
      && Number.isFinite(parsed.savedAt)
      && Date.now() - Number(parsed.savedAt) <= LIST_RETURN_SCROLL_TTL_MS
    );
  } catch {
    return false;
  }
};

const getKickoffDay = (match: Match): string => (
  match.kickoffDate || String(match.kickoffTime || '').slice(0, 10) || match.matchDate || ''
);

const getSportteryDay = (match: Match): string => match.businessDate || getKickoffDay(match) || '';

const getMatchDateCandidates = (match: Match): string[] => {
  const sportteryDay = getSportteryDay(match);

  // The date chips represent one unambiguous Sporttery business day. A fixture
  // with a midnight kickoff must not also leak into its kickoff-calendar day.
  return sportteryDay ? [sportteryDay] : [];
};

const matchBelongsToDate = (match: Match, date: string) => getMatchDateCandidates(match).includes(date);

const getBestPrediction = (match: Match) => getVisiblePrediction(match, 'BEST');

type PostReviewRow = NonNullable<Match['postMatchReview']>['predictionReview']['rows'][number];
type SettledStatus = 'WON' | 'LOST';

const isSettledReviewStatus = (status: string | undefined): status is SettledStatus => (
  status === 'WON' || status === 'LOST'
);

const isFormalReviewRow = (row: PostReviewRow | undefined) => Boolean(
  row
  && row.performanceTrack === 'formal'
  && row.recommendationAction === 'recommend'
  && row.reviewRole === 'main'
  && isSettledReviewStatus(row.resultStatus)
);

const isLiveReviewRow = (row: PostReviewRow | undefined) => Boolean(
  row?.performanceTrack === 'live-model'
);

const reviewRowMatchesPrediction = (row: PostReviewRow, prediction: PredictionDetail | undefined) => {
  if (!prediction) return false;
  const sameTip = row.tipCode === prediction.tipCode;
  const samePool = (row.oddsPoolCode || '') === (prediction.oddsPoolCode || '');
  const sameMarket = row.marketType === prediction.marketType
    || (prediction.marketType === '1X2' && row.marketType === 'BEST');
  return sameTip && samePool && sameMarket;
};

const getSettledPostReviewRow = (
  match: Match,
  prediction: PredictionDetail | undefined
): PostReviewRow | undefined => {
  const rows = match.postMatchReview?.predictionReview?.rows || [];
  const settledRows = rows.filter((row) => isSettledReviewStatus(row.resultStatus));
  if (!settledRows.length) return undefined;
  return settledRows.find((row) => reviewRowMatchesPrediction(row, prediction))
    || settledRows.find((row) => isFormalReviewRow(row) && row.marketType === 'BEST')
    || settledRows.find((row) => isFormalReviewRow(row))
    || settledRows.find((row) => row.marketType === 'BEST')
    || settledRows[0];
};

const predictionFromReviewRow = (row: PostReviewRow | undefined): PredictionDetail | undefined => {
  if (!row) return undefined;
  return {
    marketType: row.marketType,
    oddsPoolCode: row.oddsPoolCode,
    handicapLine: row.handicapLine,
    tipCode: row.tipCode,
    tipLabel: row.tipLabel,
    odds: Number(row.odds || 0),
    trustScore: Number(row.trustScore || 0),
    recommendationAction: row.recommendationAction || (row.reviewRole === 'main' ? 'recommend' : 'reference'),
    recommendationTier: row.recommendationTier || (row.reviewRole === 'main' ? 'main' : 'reference'),
    explanation: { zh: '', en: '' },
    visibilityStatus: 'FREE',
    resultStatus: row.resultStatus
  };
};

interface DailyReviewStats {
  totalFixtures: number;
  resultPhaseFixtures: number;
  notYetResultPhase: number;
  finished: number;
  awaitingOfficial: number;
  archivedDirections: number;
  formalSettled: number;
  formalWon: number;
  formalHitRate: number | null;
  liveSettled: number;
  liveWon: number;
  liveHitRate: number | null;
  referenceBestSettled: number;
  referenceBestWon: number;
  referenceBestHitRate: number | null;
  analysisSettled: number;
  analysisWon: number;
  analysisHitRate: number | null;
  provisionalReferenceSettled: number;
  provisionalReferenceWon: number;
  provisionalReferenceHitRate: number | null;
}

interface HomePageOddsFallback {
  label: string;
  marketLabel: string;
  tipLabel: string;
  odds: number;
}

const getDailyReviewStats = (matches: Match[], now = Date.now()): DailyReviewStats => {
  const stats = matches.reduce((acc, match) => {
    const review = match.postMatchReview?.predictionReview;
    const hasSettledReview = Boolean(review?.rows?.some((row) => isSettledReviewStatus(row.resultStatus)));
    const kickoffAt = Date.parse(match.kickoffTime || '');
    const isPastScheduled = match.status === 'SCHEDULED'
      && Number.isFinite(kickoffAt)
      && kickoffAt <= now;
    const isVoid = match.resultDisposition === 'VOID';
    const isResultPhase = isVoid
      || match.status === 'FINISHED'
      || match.status === 'PENDING_RESULT'
      || hasSettledReview
      || isPastScheduled;
    const archivedDirection = isResultPhase
      ? getArchivedPreMatchPrediction(match, now)
      : undefined;
    const provisionalOutcome = !hasSettledReview ? getProvisionalArchivedOutcome(match, now) : null;
    acc.totalFixtures += 1;
    if (isResultPhase) acc.resultPhaseFixtures += 1;
    else acc.notYetResultPhase += 1;
    if (archivedDirection) acc.archivedDirections += 1;
    if (match.status === 'FINISHED' || hasSettledReview || isVoid) {
      acc.finished += 1;
    } else if (isResultPhase) {
      acc.awaitingOfficial += 1;
    }
    if (provisionalOutcome) {
      acc.provisionalReferenceSettled += 1;
      if (provisionalOutcome.resultStatus === 'WON') acc.provisionalReferenceWon += 1;
    }
    if (!review) return acc;

    const settledRows = (review.rows || []).filter((row) => isSettledReviewStatus(row.resultStatus));
    const formalBestRow = settledRows.find((row) => isFormalReviewRow(row) && row.marketType === 'BEST');
    const liveBestRow = settledRows.find((row) => isLiveReviewRow(row) && row.marketType === 'BEST');
    const analysisRows = settledRows.filter((row) => (
      !isFormalReviewRow(row)
      && !isLiveReviewRow(row)
      && (row.recommendationAction === 'reference' || row.reviewRole === 'reference')
    ));
    const referenceBestRow = analysisRows.find((row) => row.marketType === 'BEST');

    // BEST is one main direction per match. Supporting 1X2/GOALS rows remain
    // visible in the all-analysis track, but never inflate a main-pick rate.
    if (formalBestRow) {
      acc.formalSettled += 1;
      if (formalBestRow.resultStatus === 'WON') acc.formalWon += 1;
    }
    if (liveBestRow) {
      acc.liveSettled += 1;
      if (liveBestRow.resultStatus === 'WON') acc.liveWon += 1;
    }
    if (referenceBestRow) {
      acc.referenceBestSettled += 1;
      if (referenceBestRow.resultStatus === 'WON') acc.referenceBestWon += 1;
    }
    acc.analysisSettled += analysisRows.length;
    acc.analysisWon += analysisRows.filter((row) => row.resultStatus === 'WON').length;
    return acc;
  }, {
    totalFixtures: 0,
    resultPhaseFixtures: 0,
    notYetResultPhase: 0,
    finished: 0,
    awaitingOfficial: 0,
    archivedDirections: 0,
    formalSettled: 0,
    formalWon: 0,
    liveSettled: 0,
    liveWon: 0,
    referenceBestSettled: 0,
    referenceBestWon: 0,
    analysisSettled: 0,
    analysisWon: 0,
    provisionalReferenceSettled: 0,
    provisionalReferenceWon: 0
  });

  return {
    ...stats,
    formalHitRate: stats.formalSettled > 0
      ? Math.round((stats.formalWon / stats.formalSettled) * 100)
      : null,
    liveHitRate: stats.liveSettled > 0 ? Math.round((stats.liveWon / stats.liveSettled) * 100) : null,
    referenceBestHitRate: stats.referenceBestSettled > 0
      ? Math.round((stats.referenceBestWon / stats.referenceBestSettled) * 100)
      : null,
    analysisHitRate: stats.analysisSettled > 0
      ? Math.round((stats.analysisWon / stats.analysisSettled) * 100)
      : null,
    provisionalReferenceHitRate: stats.provisionalReferenceSettled > 0
      ? Math.round((stats.provisionalReferenceWon / stats.provisionalReferenceSettled) * 100)
      : null
  };
};

const formatDailyRate = (value: number | null, language: 'zh' | 'en') => (
  value === null ? (language === 'zh' ? '无样本' : 'N/A') : `${value}%`
);

type OptionalNumericMetric = number | string | null | undefined;

const isMissingNumericMetric = (value: OptionalNumericMetric) => (
  value === null
  || value === undefined
  || (typeof value === 'string' && value.trim() === '')
);

const toFiniteNumericMetric = (value: OptionalNumericMetric): number | null => {
  if (isMissingNumericMetric(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const formatModelPercent = (value: OptionalNumericMetric) => {
  if (isMissingNumericMetric(value)) return '--';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  const percent = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
  return `${percent.toFixed(0)}%`;
};

const formatModelSignedDecimal = (value: OptionalNumericMetric) => {
  if (isMissingNumericMetric(value)) return '--';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  const prefix = numeric > 0 ? '+' : '';
  return `${prefix}${numeric.toFixed(3)}`;
};

const pickLargestSettledBucket = <T extends { metrics?: { settled?: number } | null }>(rows: T[] | undefined): T | undefined => {
  return [...(rows || [])].sort((a, b) => Number(b.metrics?.settled || 0) - Number(a.metrics?.settled || 0))[0];
};

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

const stripDirectionPrefix = (label: string, language: 'zh' | 'en') => (
  language === 'zh'
    ? label.replace(/^(推荐方向|参考倾向|参考推荐|模型首选|价值观察|高可信|主推|观察)\s*/, '')
    : label.replace(/^(Pick|Reference lean|Reference pick|Model lean|Value watch|High confidence|Watch)[:：]?\s*/i, '')
);

const formatShortDate = (date: string, language: 'zh' | 'en') => {
  return new Date(`${date}T00:00:00+08:00`).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    timeZone: 'Asia/Shanghai'
  });
};

const getSportteryMeta = (match: Match) => match.matchNo || '';

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

const formatReferenceTime = (value: string | undefined, language: 'zh' | 'en') => {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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

const getCrossDayKickoffLabel = (match: Match, language: 'zh' | 'en') => {
  const sportteryDay = getSportteryDay(match);
  const kickoffDay = getKickoffDay(match);
  if (!sportteryDay || !kickoffDay || sportteryDay === kickoffDay) return '';
  return `${formatShortDate(kickoffDay, language)} ${formatKickoffTime(match.kickoffTime, language)}`;
};

const getRowKickoffLabel = (match: Match, language: 'zh' | 'en') => {
  return getCrossDayKickoffLabel(match, language) || formatKickoffTime(match.kickoffTime, language);
};

const formatCoveragePercent = (value: OptionalNumericMetric) => {
  if (isMissingNumericMetric(value)) return '--';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return `${Math.round(numeric * 1000) / 10}%`;
};

const hasOfficialScore = (match: Match) => (
  match.status === 'FINISHED'
  && Number.isFinite(match.scoreHome)
  && Number.isFinite(match.scoreAway)
);

const minutesSinceKickoff = (match: Match, now = Date.now()) => {
  const kickoffAt = new Date(match.kickoffTime).getTime();
  if (!Number.isFinite(kickoffAt)) return 0;
  return Math.floor((now - kickoffAt) / 60000);
};

const getHomePageOddsRows = (match: Match, language: 'zh' | 'en'): SportteryOddsPoolDisplay[] => {
  const officialRows = getSportteryPoolRows(match, language).filter((row) => row.odds);
  if (officialRows.length > 0) return officialRows;

  const resolved = getResolvedMatchOdds(match);
  const fallbackRows: SportteryOddsPoolDisplay[] = [];

  if (resolved.had?.odds) {
    fallbackRows.push({
      poolCode: 'HAD',
      label: language === 'zh' ? '胜平负参考' : '1X2 ref',
      handicap: '0',
      odds: resolved.had.odds,
      source: resolved.had.source,
      updatedAt: resolved.had.updatedAt,
      probabilities: getImpliedProbabilities(resolved.had.odds)
    });
  }

  if (resolved.hhad?.odds) {
    fallbackRows.push({
      poolCode: 'HHAD',
      label: language === 'zh' ? '让球参考' : 'Handicap ref',
      handicap: resolved.hhad.handicap || match.handicapLine || '',
      odds: resolved.hhad.odds,
      source: resolved.hhad.source,
      updatedAt: resolved.hhad.updatedAt,
      probabilities: getImpliedProbabilities(resolved.hhad.odds)
    });
  }

  return fallbackRows;
};

const getReferenceOddsSourceLabel = (source: string | undefined, language: 'zh' | 'en') => {
  const normalized = String(source || '').trim().toLowerCase();
  if (!normalized || normalized.startsWith('sporttery:')) return '';
  if (normalized.includes('500') || normalized.includes('five-hundred')) {
    return language === 'zh' ? '500参考' : '500.com ref';
  }
  if (normalized.includes('api-football')) {
    return language === 'zh' ? 'API参考' : 'API ref';
  }
  return language === 'zh' ? '外部参考' : 'External ref';
};

const sameHandicapLine = (left: unknown, right: unknown) => {
  const leftText = String(left ?? '').trim();
  const rightText = String(right ?? '').trim();
  if (!leftText || !rightText) return false;
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    ? leftNumber === rightNumber
    : leftText === rightText;
};

const getReferencePredictionOdds = (
  match: Match,
  prediction: PredictionDetail | undefined,
  language: 'zh' | 'en'
) => {
  if (
    !prediction
    || !['HAD', 'HHAD'].includes(String(prediction.oddsPoolCode || ''))
    || !['1', 'X', '2'].includes(prediction.tipCode)
  ) return null;
  const resolved = getResolvedMatchOdds(match);
  const pool = prediction.oddsPoolCode === 'HHAD' ? resolved.hhad : resolved.had;
  if (
    prediction.oddsPoolCode === 'HHAD'
    && !sameHandicapLine(prediction.handicapLine, resolved.hhad?.handicap)
  ) return null;
  const value = prediction.tipCode === '1'
    ? pool?.odds.odds1
    : prediction.tipCode === 'X'
      ? pool?.odds.oddsX
      : pool?.odds.odds2;
  if (!Number.isFinite(value) || Number(value) <= 1) return null;
  const sourceLabel = getReferenceOddsSourceLabel(pool?.source, language);
  if (!sourceLabel) return null;
  return { odds: Number(value), sourceLabel };
};

const getAlignedSportteryPoolRows = (
  rows: SportteryOddsPoolDisplay[],
  match: Match,
  language: 'zh' | 'en'
): SportteryOddsPoolDisplay[] => (
  (['HAD', 'HHAD'] as const).map((poolCode) => rows.find((row) => row.poolCode === poolCode) || ({
    poolCode,
    label: poolCode === 'HAD'
      ? (language === 'zh' ? '胜平负' : '1X2')
      : (language === 'zh' ? '让球胜平负' : 'Handicap Result'),
    handicap: poolCode === 'HAD' ? '0' : (match.handicapLine || ''),
    odds: null,
    probabilities: undefined,
    unavailableReason: match.status === 'FINISHED' ? 'archived' : 'closed'
  }))
);

const getHomePageOddsFallback = (match: Match, language: 'zh' | 'en'): HomePageOddsFallback | null => {
  const displayRecommendation = getDisplayRecommendation(match, language);
  const reviewRow = getSettledPostReviewRow(match, displayRecommendation?.prediction);
  const isReview = match.status === 'FINISHED' || match.status === 'PENDING_RESULT' || Boolean(reviewRow);
  if (!isReview) return null;
  const reviewPrediction = predictionFromReviewRow(reviewRow);
  const archivedPrediction = getArchivedPreMatchPrediction(match);
  const prediction = reviewPrediction || displayRecommendation?.prediction || archivedPrediction;
  const odds = Number(prediction?.odds || 0);
  if (!prediction || !Number.isFinite(odds) || odds <= 0) return null;

  return {
    label: reviewRow
      ? (language === 'zh' ? '赛后SP' : 'Review SP')
      : (language === 'zh' ? '赛前归档SP' : 'Archived pre-match SP'),
    marketLabel: getPredictionMarketLabel(prediction, language),
    tipLabel: getPredictionTipDisplay(prediction, language, true),
    odds
  };
};

const getDecisionReason = (category: MatchSignalCategory, language: 'zh' | 'en') => {
  const reasons: Record<MatchSignalCategory, Record<'zh' | 'en', string>> = {
    steady: { zh: '赔率、推荐和风险基本同向', en: 'Odds, pick, and risk align' },
    lean: { zh: '已按开售玩法给出方向', en: 'Direction is based on an on-sale market' },
    value: { zh: '有冷门变量，临场再复核', en: 'Upset variables exist; recheck late' },
    watch: { zh: '等待官方赔率开售或更新', en: 'Waiting for official odds sale or refresh' },
    avoid: { zh: '风险偏高，推荐需临场复核', en: 'Risk is elevated; recheck before kickoff' },
    unavailable: { zh: '待官方赔率开售', en: 'Waiting for official odds' },
    finished: { zh: '按赛果复盘', en: 'Review by final result' }
  };

  return reasons[category][language];
};

const getOfficialPredictionOdds = (match: Match, prediction: PredictionDetail | undefined) => {
  if (
    !prediction
    || (prediction.oddsPoolCode !== 'HAD' && prediction.oddsPoolCode !== 'HHAD')
    || !['1', 'X', '2'].includes(prediction.tipCode)
  ) return 0;
  const official = getOfficialMatchOdds(match);
  if (
    prediction.oddsPoolCode === 'HHAD'
    && !sameHandicapLine(prediction.handicapLine, official.hhad?.handicap)
  ) return 0;
  const odds = prediction.oddsPoolCode === 'HHAD' ? official.hhad?.odds : official.had?.odds;
  const value = prediction.tipCode === '1' ? odds?.odds1 : prediction.tipCode === 'X' ? odds?.oddsX : odds?.odds2;
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
};

const getOfficialPredictionHandicapLine = (match: Match, prediction: PredictionDetail | undefined) => (
  prediction?.oddsPoolCode === 'HHAD' ? getOfficialMatchOdds(match).hhad?.handicap : 0
);

const getOnSaleDisplayRecommendation = (
  match: Match,
  language: 'zh' | 'en',
  now = Date.now()
) => {
  if (
    match.resultDisposition === 'VOID'
    || match.status !== 'SCHEDULED'
    || !isBeforeMatchSaleCutoff(match, now)
  ) return null;
  const storedBest = getBestPrediction(match);
  if (!storedBest || !isPredictionOfficialResultPoolAvailable(match, storedBest)) return null;
  const officialOdds = getOfficialPredictionOdds(match, storedBest);
  if (!isOfficialRecommendationEligible(
    storedBest,
    officialOdds,
    getOfficialPredictionHandicapLine(match, storedBest)
  )) return null;
  const eligiblePrediction = { ...storedBest, odds: officialOdds };
  const recommendation = getDisplayRecommendation(match, language);
  const baseRecommendation: DisplayRecommendation = recommendation || {
    kind: 'prediction',
    label: getPredictionTipDisplay(eligiblePrediction, language, true),
    meta: `SP ${officialOdds.toFixed(2)}`,
    probability: null,
    support: null,
    reason: getDecisionReason('lean', language)
  };
  return {
    ...baseRecommendation,
    prediction: eligiblePrediction,
    tipCode: eligiblePrediction.tipCode,
    label: stripDirectionPrefix(getPredictionTipDisplay(eligiblePrediction, language, true), language),
    meta: `SP ${officialOdds.toFixed(2)}`,
    companion: undefined
  };
};

type AnalysisReferenceOptions = {
  allowModelOnly?: boolean;
  candidate?: PredictionDetail;
  now?: number;
};

const getOnSaleAnalysisReference = (
  match: Match,
  options: AnalysisReferenceOptions = {}
) => selectAnalysisReferencePrediction(match, options);

type ResultPoolCode = SportteryOddsPoolDisplay['poolCode'];
type ListMarketCode = ResultPoolCode | 'MODEL_ONLY_1X2';
type ResultTipCode = '1' | 'X' | '2';
type ListSelectionTone = 'recommendation' | 'live' | 'analysis' | 'review' | 'archive';

interface ListMarketSelection {
  poolCode: ListMarketCode;
  tipCode: ResultTipCode;
  tone: ListSelectionTone;
  prediction?: PredictionDetail;
  referenceSource?: AnalysisReferenceSource;
}

type UnifiedPosteriorUiMeta = {
  selectionPolicy?: unknown;
  outcomeConflict?: unknown;
  multiFactorEvidence?: {
    blockers?: unknown;
    diagnostics?: {
      crossMarketCompatible?: unknown;
    };
  };
};

const isResultPoolCode = (value: string | undefined): value is ResultPoolCode => (
  value === 'HAD' || value === 'HHAD'
);

const isResultTipCode = (value: string | undefined): value is ResultTipCode => (
  value === '1' || value === 'X' || value === '2'
);

const getWatchDirectionPrediction = (
  match: Match,
  now = Date.now()
): PredictionDetail | undefined => {
  if (match.status !== 'SCHEDULED' || !isBeforeMatchSaleCutoff(match, now)) return undefined;
  const prediction = getBestPrediction(match);
  return isResultPoolCode(prediction?.oddsPoolCode) && isResultTipCode(prediction?.tipCode)
    ? prediction
    : undefined;
};

const hasConflictBlocker = (blockers: unknown) => (
  Array.isArray(blockers) && blockers.some((blocker) => blocker === 'had-hhad-conflict')
);

const hasCrossMarketDirectionConflict = (
  match: Match,
  prediction?: PredictionDetail
) => {
  if (hasConflictBlocker(prediction?.multiFactorEvidence?.blockers)) return true;

  const unified = match.probabilityModel?.unifiedPosterior as UnifiedPosteriorUiMeta | null | undefined;
  const selectionPolicy = typeof unified?.selectionPolicy === 'string' ? unified.selectionPolicy : '';
  return Boolean(
    unified?.outcomeConflict
    || selectionPolicy.includes('conflict')
    || hasConflictBlocker(unified?.multiFactorEvidence?.blockers)
    || unified?.multiFactorEvidence?.diagnostics?.crossMarketCompatible === false
  );
};

const getListMarketSelection = (
  match: Match,
  language: 'zh' | 'en',
  publishedRecommendation: DisplayRecommendation | null,
  now = Date.now(),
  allowModelOnly = false
): ListMarketSelection | null => {
  const archivedPrediction = getArchivedPreMatchPrediction(match, now);
  const hasSettledReview = Boolean(match.postMatchReview?.predictionReview?.rows?.some((row) => (
    isSettledReviewStatus(row.resultStatus)
  )));
  const isFinished = match.status === 'FINISHED'
    || match.status === 'PENDING_RESULT'
    || hasSettledReview
    || Boolean(archivedPrediction);
  let prediction: PredictionDetail | undefined;
  let tone: ListSelectionTone = 'analysis';
  let referenceSource: AnalysisReferenceSource | undefined;

  if (isFinished) {
    const rawDisplayRecommendation = getDisplayRecommendation(match, language);
    const reviewRow = getSettledPostReviewRow(match, rawDisplayRecommendation?.prediction);
    prediction = predictionFromReviewRow(reviewRow) || archivedPrediction;
    tone = isLiveReviewRow(reviewRow)
      ? 'live'
      : isFormalReviewRow(reviewRow)
        ? 'review'
        : reviewRow
          ? 'analysis'
          : 'archive';
    if (!prediction && publishedRecommendation?.publicationTrack === 'live') {
      prediction = publishedRecommendation.prediction;
      tone = 'live';
    }
  } else {
    const displayRecommendation = publishedRecommendation;
    if (displayRecommendation?.prediction) {
      prediction = displayRecommendation.prediction;
      tone = displayRecommendation.publicationTrack === 'live' ? 'live' : 'recommendation';
    } else {
      // The selector already enforces SCHEDULED state, kickoff, cutoff, and
      // source-clock rules. Calling it directly keeps the row consistent with
      // the header count and lets a verified pre-cutoff direction remain
      // visible after sales close without deriving a new post-cutoff pick.
      const referenceSelection = selectOnSaleAnalysisReference(match, { now, allowModelOnly });
      prediction = referenceSelection?.prediction;
      referenceSource = referenceSelection?.source;
    }
  }

  if (!isResultTipCode(prediction?.tipCode)) return null;
  const poolCode: ListMarketCode | null = isResultPoolCode(prediction.oddsPoolCode)
    ? prediction.oddsPoolCode
    : referenceSource === 'published-reference' && prediction.oddsPoolCode === undefined
      ? 'MODEL_ONLY_1X2'
      : null;
  if (!poolCode) return null;

  return {
    poolCode,
    tipCode: prediction.tipCode,
    tone,
    prediction,
    referenceSource
  };
};

const getPoolOutcomeLabel = (
  poolCode: ListMarketCode,
  tipCode: ResultTipCode,
  language: 'zh' | 'en'
) => {
  if (language === 'zh') {
    if (poolCode === 'HHAD') return tipCode === '1' ? '让胜' : tipCode === 'X' ? '让平' : '让负';
    return tipCode === '1' ? '主胜' : tipCode === 'X' ? '平局' : '客胜';
  }

  if (poolCode === 'HHAD') return tipCode === '1' ? 'HHAD H' : tipCode === 'X' ? 'HHAD D' : 'HHAD A';
  return tipCode === '1' ? 'Home' : tipCode === 'X' ? 'Draw' : 'Away';
};

const getSelectionToneLabel = (tone: ListSelectionTone, language: 'zh' | 'en') => {
  if (tone === 'live') return language === 'zh' ? '实时推荐' : 'Live pick';
  if (tone === 'recommendation') return language === 'zh' ? '正式结论' : 'Official pick';
  if (tone === 'review') return language === 'zh' ? '赛后记录' : 'Review record';
  if (tone === 'archive') return language === 'zh' ? '赛前归档' : 'Pre-match archive';
  return language === 'zh' ? '数据推荐' : 'Data pick';
};

const getSelectionTierLabel = (tone: ListSelectionTone, language: 'zh' | 'en') => {
  if (tone === 'recommendation') return language === 'zh' ? '正式推荐' : 'Formal pick';
  if (tone === 'live') return language === 'zh' ? '参考推荐 · 实时' : 'Reference pick · Live';
  if (tone === 'analysis') return language === 'zh' ? '参考推荐' : 'Reference pick';
  return getSelectionToneLabel(tone, language);
};

const getSelectionMarkerLabel = (tone: ListSelectionTone, language: 'zh' | 'en') => {
  if (tone === 'live') return language === 'zh' ? '推荐' : 'Pick';
  if (tone === 'recommendation') return language === 'zh' ? '结论' : 'Pick';
  if (tone === 'review') return language === 'zh' ? '记录' : 'Review';
  if (tone === 'archive') return language === 'zh' ? '原荐' : 'Archived';
  return language === 'zh' ? '荐' : 'Ref';
};

const getSelectionTierMarkerLabel = (tone: ListSelectionTone, language: 'zh' | 'en') => {
  if (tone === 'recommendation') return language === 'zh' ? '正式' : 'Formal';
  if (tone === 'live' || tone === 'analysis') return language === 'zh' ? '参考' : 'Reference';
  return getSelectionMarkerLabel(tone, language);
};

export const PredictionsList: React.FC<PredictionsListProps> = ({ onSelectMatch, viewMode }) => {
  const { language, matches, dataSync } = useApp();
  const isAnalysisView = viewMode === 'analysis';
  const isFixturesView = viewMode === 'fixtures';
  const [clockNow, setClockNow] = useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // Cutoff and kickoff decisions must use the browser clock only. Source
  // timestamps are evidence metadata and may be ahead because of upstream
  // clock skew; treating them as "now" can hide still-open recommendations.
  const nowMs = clockNow;

  const systemTodayStr = getDateStringOffset(0);
  const todayStr = systemTodayStr;
  const yesterdayStr = offsetDateString(todayStr, -1);
  const tomorrowStr = offsetDateString(todayStr, 1);
  const dayAfterTomorrowStr = offsetDateString(todayStr, 2);

  const restoredViewState = React.useMemo(() => readStoredListViewState(viewMode), [viewMode]);
  const restoreReturnView = React.useMemo(() => hasFreshListReturnScroll(viewMode), [viewMode]);
  const [selectedDate, setSelectedDate] = useState<string>(() => (
    restoreReturnView ? restoredViewState?.selectedDate || getDateStringOffset(0) : getDateStringOffset(0)
  ));
  const [selectedLeagues, setSelectedLeagues] = useState<string[]>(() => (
    restoreReturnView ? restoredViewState?.selectedLeagues || [] : []
  ));
  const [sortBy, setSortBy] = useState<SortBy>(() => (
    restoreReturnView ? restoredViewState?.sortBy || 'time' : 'time'
  ));
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(() => (
    restoreReturnView ? restoredViewState?.sortOrder || 'asc' : 'asc'
  ));
  const previousTodayRef = React.useRef(todayStr);
  const matchListRef = React.useRef<HTMLElement | null>(null);
  const refreshScrollAnchorRef = React.useRef<{ eventKey: string; top: number } | null>(null);
  const returnScrollRestoredRef = React.useRef(false);
  const automaticInitialDateResolvedRef = React.useRef(restoreReturnView);

  React.useEffect(() => {
    const previousToday = previousTodayRef.current;
    if (previousToday !== todayStr) {
      setSelectedDate((current) => current === previousToday ? todayStr : current);
      previousTodayRef.current = todayStr;
    }
  }, [todayStr]);

  React.useEffect(() => {
    if (automaticInitialDateResolvedRef.current || !dataSync.currentLoaded) return;
    const availableDates = Array.from(new Set(matches.flatMap(getMatchDateCandidates).filter(Boolean))).sort();
    if (availableDates.length === 0) return;
    automaticInitialDateResolvedRef.current = true;
    if (availableDates.includes(todayStr)) return;
    const nearestUpcomingDate = availableDates.find((date) => date >= todayStr);
    const nearestRecentDate = [...availableDates].reverse().find((date) => date < todayStr);
    const nearestAvailableDate = nearestUpcomingDate || nearestRecentDate;
    if (nearestAvailableDate) setSelectedDate(nearestAvailableDate);
  }, [dataSync.currentLoaded, matches, todayStr]);

  const handleDateSelect = React.useCallback((date: string) => {
    automaticInitialDateResolvedRef.current = true;
    setSelectedDate(date);
  }, []);

  React.useEffect(() => {
    try {
      window.sessionStorage.setItem(listViewStorageKey(viewMode), JSON.stringify({
        savedAt: Date.now(),
        selectedDate,
        selectedLeagues,
        sortBy,
        sortOrder
      } satisfies StoredListViewState));
    } catch {
      // Filters remain fully usable when storage is disabled.
    }
  }, [selectedDate, selectedLeagues, sortBy, sortOrder, viewMode]);

  // A current/history refresh can remove one storage row and add another row
  // for the same fixture. Keep the first visible fixture at the same viewport
  // position so a background result update never feels like a page jump.
  React.useLayoutEffect(() => {
    const list = matchListRef.current;
    const pendingAnchor = refreshScrollAnchorRef.current;
    refreshScrollAnchorRef.current = null;
    if (list && pendingAnchor) {
      const anchorRow = Array.from(list.querySelectorAll<HTMLElement>('[data-match-event-key]'))
        .find((row) => row.dataset.matchEventKey === pendingAnchor.eventKey);
      if (anchorRow) {
        const delta = anchorRow.getBoundingClientRect().top - pendingAnchor.top;
        if (Math.abs(delta) >= 1) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
      }
    }

    return () => {
      const currentList = list;
      if (!currentList || currentList.getBoundingClientRect().top >= 0) return;
      const anchorRow = Array.from(currentList.querySelectorAll<HTMLElement>('[data-match-event-key]'))
        .find((row) => row.getBoundingClientRect().bottom > 0);
      const eventKey = anchorRow?.dataset.matchEventKey;
      if (anchorRow && eventKey) {
        refreshScrollAnchorRef.current = {
          eventKey,
          top: anchorRow.getBoundingClientRect().top
        };
      }
    };
  }, [matches]);

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
    trust: { zh: '证据评分', en: 'Evidence Score' },
    odds: { zh: '赔率', en: 'Odds' },
    reset: { zh: '重置', en: 'Reset' },
    noMatches: { zh: '这个日期暂无可用比赛预测。', en: 'No scheduled matches found for this day.' },
    noQualifiedPicks: { zh: '当前数据还没有形成可展示的推荐方向。', en: 'The current data has not produced a displayable pick yet.' },
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
    riskPausedNote: { zh: '暂无已开售推荐，等待下一轮赔率更新', en: 'No on-sale pick yet; wait for next odds check' },
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
    dataChannelRetained: { zh: '会话保留快照', en: 'Retained session snapshot' },
    dataReleaseContinuity: { zh: '服务切换中，继续显示本会话上次已验证赛程；接口恢复后会自动更新。', en: 'Service cutover in progress. The last verified schedule from this session remains visible and will refresh automatically.' },
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
    statusSyncPending: { zh: '比赛状态待同步', en: 'Match status syncing' },
    teams: { zh: '对阵双方', en: 'Teams' },
    oddsHeader: { zh: 'HAD 胜平负 / HHAD 让球赔率', en: 'HAD 1X2 / HHAD Odds' },
    closed: { zh: '未开售', en: 'Not on sale' },
    archivedOdds: { zh: '胜平负归档', en: '1X2 archived' },
    hit: { zh: '命中', en: 'Hit' },
    miss: { zh: '未中', en: 'Miss' },
    leagueMatches: { zh: '场比赛', en: 'matches' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';

  const effectiveSelectedDate = selectedDate;

  const availableLeagues = useMemo(() => {
    const seen = new Set<string>();
    const matchesForDate = matches.filter((match) => matchBelongsToDate(match, effectiveSelectedDate));
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

  const recommendationCounts = useMemo(() => {
    return baseFilteredMatches.reduce((counts, match) => {
      const signal = getMatchSignal(match);
      const isVoid = match.resultDisposition === 'VOID';
      const formalRecommendation = match.resultDisposition !== 'VOID'
        ? getOnSaleDisplayRecommendation(match, language, nowMs)
        : null;
      const liveRecommendation = getLiveDisplayRecommendation(match, language);
      const displayRecommendation = isVoid ? null : formalRecommendation || liveRecommendation;
      const analysisReference = displayRecommendation ? undefined : getOnSaleAnalysisReference(match, {
        allowModelOnly: true,
        now: nowMs
      });
      const archivedPrediction = getArchivedPreMatchPrediction(match, nowMs);
      const watchDirection = !displayRecommendation && !analysisReference && !archivedPrediction
        ? getWatchDirectionPrediction(match, nowMs)
        : undefined;
      const visibleDirection = displayRecommendation?.prediction
        || analysisReference
        || archivedPrediction
        || watchDirection;
      const { hasHad, hasHhad } = getAvailableResultPools(match);
      if (isVoid || signal.category === 'finished' || archivedPrediction) {
        if (signal.category === 'finished' || isVoid) counts.finished += 1;
        if (!isVoid && archivedPrediction) {
          counts.recommended += 1;
          counts.reference += 1;
        }
      } else {
        if (displayRecommendation || analysisReference) counts.recommended += 1;
        if (formalRecommendation) counts.formal += 1;
        else if (liveRecommendation) counts.live += 1;
        else if (analysisReference) counts.reference += 1;
        if (hasHad) counts.had += 1;
        if (hasHhad) counts.hhad += 1;
        if (!displayRecommendation && !analysisReference) counts.unavailable += 1;
      }
      if (!isVoid && isResultTipCode(visibleDirection?.tipCode)) {
        if (visibleDirection.tipCode === '1') counts.home += 1;
        else if (visibleDirection.tipCode === 'X') counts.draw += 1;
        else counts.away += 1;
      }
      return counts;
    }, {
      recommended: 0,
      formal: 0,
      live: 0,
      reference: 0,
      had: 0,
      hhad: 0,
      unavailable: 0,
      finished: 0,
      home: 0,
      draw: 0,
      away: 0
    });
  }, [baseFilteredMatches, language, nowMs]);

  const fixtureMarketCounts = useMemo(() => baseFilteredMatches.reduce((counts, match) => {
    const availability = getOfficialResultPoolAvailability(match);
    if (availability.hasHad) counts.had += 1;
    if (availability.hasHhad) counts.hhad += 1;
    if (availability.hasHad || availability.hasHhad) counts.covered += 1;
    return counts;
  }, { had: 0, hhad: 0, covered: 0 }), [baseFilteredMatches]);

  const evidenceGapSummary = useMemo(() => {
    const gapCounts = new Map<string, { label: string; count: number }>();
    let auditedMatches = 0;

    baseFilteredMatches.forEach((match) => {
      const quality = match.externalSignals?.preMatch?.quality;
      const contextGaps = match.probabilityModel?.contextSignals?.dataGaps || match.stats?.dataGaps;
      if (quality || contextGaps) auditedMatches += 1;

      const seenForMatch = new Set<string>();
      const addGap = (keyValue?: string, zh?: string, en?: string) => {
        const key = String(keyValue || zh || en || '').trim();
        if (!key || seenForMatch.has(key)) return;
        seenForMatch.add(key);
        const fallbackZh: Record<string, string> = {
          referee: '裁判',
          lineup: '首发',
          injuries: '伤停',
          xg: 'xG',
          officialOdds: '官方SP'
        };
        const label = language === 'zh'
          ? (zh || fallbackZh[key] || key)
          : (en || key);
        const current = gapCounts.get(key);
        gapCounts.set(key, { label, count: (current?.count || 0) + 1 });
      };

      quality?.missing?.forEach((item) => addGap(item.key, item.zh, item.en));
      quality?.notYetPublishable?.forEach((item) => addGap(item.key, item.zh, item.en));
      Object.entries(quality?.components || {}).forEach(([key, component]) => {
        if (component.status === 'missing') {
          addGap(key, component.label?.zh, component.label?.en);
        }
      });
      contextGaps?.missing?.forEach((item) => addGap(item.key, item.zh, item.en));
      contextGaps?.preMatchQuality?.missing?.forEach((item) => addGap(item.key, item.zh, item.en));
    });

    return {
      auditedMatches,
      items: [...gapCounts.values()]
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, language === 'zh' ? 'zh-CN' : 'en-US'))
        .slice(0, 3)
    };
  }, [baseFilteredMatches, language]);

  const filteredMatches = baseFilteredMatches;

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

  const dailyReviewStats = useMemo(
    () => getDailyReviewStats(baseFilteredMatches, nowMs),
    [baseFilteredMatches, nowMs]
  );
  const officialSettlementNotDue = dailyReviewStats.resultPhaseFixtures === 0;
  const reviewDirectionCount = recommendationCounts.recommended;
  const reviewDirectionDenominator = dailyReviewStats.totalFixtures;

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

  React.useLayoutEffect(() => {
    if (returnScrollRestoredRef.current || groupedMatches.length === 0) return undefined;
    returnScrollRestoredRef.current = true;
    let saved: Partial<StoredReturnScroll> | null = null;
    try {
      const storageKey = listReturnScrollKey(viewMode);
      saved = JSON.parse(window.sessionStorage.getItem(storageKey) || 'null') as Partial<StoredReturnScroll> | null;
      window.sessionStorage.removeItem(storageKey);
    } catch {
      saved = null;
    }
    if (
      !saved
      || !Number.isFinite(saved.savedAt)
      || !Number.isFinite(saved.scrollY)
      || Date.now() - Number(saved.savedAt) > LIST_RETURN_SCROLL_TTL_MS
    ) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, Number(saved?.scrollY || 0)), left: 0, behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [groupedMatches.length, viewMode]);

  const handleLeagueToggle = (leagueId: string) => {
    setSelectedLeagues((current) => (
      current.includes(leagueId)
        ? current.filter((id) => id !== leagueId)
        : [...current, leagueId]
    ));
  };

  const handleResetFilters = () => {
    setSelectedLeagues([]);
    setSortBy('time');
    setSortOrder('asc');
  };

  const handleSortChange = (nextSort: SortBy) => {
    if (nextSort === sortBy) return;
    setSortBy(nextSort);
    setSortOrder(nextSort === 'time' ? 'asc' : 'desc');
  };

  const renderDecisionCell = (
    match: Match,
    publishedRecommendation: DisplayRecommendation | null
  ) => {
    const isVoid = match.resultDisposition === 'VOID';
    const hasSettledReview = Boolean(match.postMatchReview?.predictionReview?.rows?.some((row) => isSettledReviewStatus(row.resultStatus)));
    const kickoffAt = Date.parse(match.kickoffTime || '');
    const isPastScheduled = match.status === 'SCHEDULED'
      && Number.isFinite(kickoffAt)
      && kickoffAt <= nowMs;
    const isFinished = match.status === 'FINISHED'
      || match.status === 'PENDING_RESULT'
      || hasSettledReview
      || isPastScheduled;
    const signal = getMatchSignal(match);
    const displayedPoolRows = getHomePageOddsRows(match, language);
    const hasDisplayedPoolOdds = displayedPoolRows.some((row) => Boolean(row.odds));
    const hasReferencePoolOdds = displayedPoolRows.some((row) => (
      Boolean(row.odds) && Boolean(getReferenceOddsSourceLabel(row.source, language))
    ));
    const rawDisplayRecommendation = getDisplayRecommendation(match, language);
    const livePublishedRecommendation = publishedRecommendation?.publicationTrack === 'live'
      ? publishedRecommendation
      : null;
    const displayRecommendation = isFinished
      ? livePublishedRecommendation
      : publishedRecommendation;
    const analysisReferenceSelection = !isFinished && !displayRecommendation
      ? selectOnSaleAnalysisReference(match, {
        allowModelOnly: true,
        candidate: rawDisplayRecommendation?.prediction,
        now: nowMs
      })
      : undefined;
    const analysisReference = analysisReferenceSelection?.prediction;
    const reviewRow = getSettledPostReviewRow(
      match,
      livePublishedRecommendation?.prediction || rawDisplayRecommendation?.prediction
    );
    const reviewPrediction = predictionFromReviewRow(reviewRow);
    const reviewIsFormal = isFormalReviewRow(reviewRow);
    const reviewIsLive = isLiveReviewRow(reviewRow);
    const archivedPreMatchPrediction = getArchivedPreMatchPrediction(match, nowMs);
    const isInPlayArchiveFallback = match.status === 'LIVE'
      && !displayRecommendation
      && Boolean(archivedPreMatchPrediction);
    const provisionalArchivedOutcome = getProvisionalArchivedOutcome(match, nowMs);

    if (isVoid) {
      return (
        <div className="decision-card is-finished is-watch-only is-reference">
          <div className="decision-main">
            <span className="decision-selection-kind is-analysis">
              {language === 'zh' ? '已取消 / 退款' : 'Void / refunded'}
            </span>
            <span className="decision-label">
              {language === 'zh' ? '本场推荐作废' : 'Pick voided'}
            </span>
          </div>
          <p className="decision-reason">
            <span>
              {language === 'zh'
                ? `官方取消竞猜${match.voidReason ? `：${match.voidReason}` : ''}；收益按 0 处理，不计入命中率分母。`
                : `The official market was cancelled${match.voidReason ? `: ${match.voidReason}` : ''}; profit is zero and this row is excluded from hit-rate denominators.`}
            </span>
          </p>
        </div>
      );
    }

    if (isFinished && !reviewRow && !livePublishedRecommendation && !archivedPreMatchPrediction) {
      return (
        <div className="decision-card is-finished is-watch-only is-reference">
          <div className="decision-main">
            <span className="decision-selection-kind is-analysis">
              {language === 'zh' ? '结算中' : 'Settling'}
            </span>
            <span className="decision-label">
              {isPastScheduled
                ? (language === 'zh' ? '比赛状态同步中' : 'Match status syncing')
                : (language === 'zh' ? '赛前记录结算中' : 'Pre-match record settling')}
            </span>
            <span className="decision-meta">
              {isPastScheduled
                ? (language === 'zh' ? '等待官方赛果通道更新' : 'Waiting for the official result lane')
                : (language === 'zh' ? '等待不可变赛前归档' : 'Waiting for the immutable pre-match archive')}
            </span>
          </div>
          <p className="decision-reason">
            <span>
              {isPastScheduled
                ? (language === 'zh'
                  ? '当前没有可验证的赛前方向快照；这里只等待官方状态与赛果。'
                  : 'No verifiable pre-match direction snapshot is available; only official status and result are awaited.')
                : (language === 'zh'
                  ? '只等待已锁定的赛前记录完成结算，不生成临时方向。'
                  : 'Waiting only for the locked pre-match record; no temporary direction is generated.')}
            </span>
          </p>
        </div>
      );
    }

    const companionCandidate = !isFinished
      ? displayRecommendation?.companion
        || getAnalysisReferenceHandicapSupplement(
          match,
          language,
          displayRecommendation?.prediction || analysisReference,
          analysisReferenceSelection?.source
        )
      : undefined;
    const companionOfficialOdds = getOfficialPredictionOdds(match, companionCandidate?.prediction);
    const companionRecommendation = companionCandidate
      && isPredictionOfficialResultPoolAvailable(match, companionCandidate.prediction)
      && companionOfficialOdds > 1
      ? {
          ...companionCandidate,
          prediction: { ...companionCandidate.prediction, odds: companionOfficialOdds },
          meta: `SP ${companionOfficialOdds.toFixed(2)}`,
          formalEligible: isOfficialRecommendationEligible(
            companionCandidate.prediction,
            companionOfficialOdds,
            getOfficialPredictionHandicapLine(match, companionCandidate.prediction)
          )
        }
      : undefined;
    const watchDirectionPrediction = !isFinished
      && !displayRecommendation
      && !archivedPreMatchPrediction
      && !analysisReference
      ? getWatchDirectionPrediction(match, nowMs)
      : undefined;
    const pickedPrediction = reviewPrediction
      || displayRecommendation?.prediction
      || archivedPreMatchPrediction
      || analysisReference;
    const isPublishedModelOnlyReference = analysisReferenceSelection?.source === 'published-reference'
      && pickedPrediction?.oddsPoolCode === undefined;
    const isPublishedHhadLineMismatch = analysisReferenceSelection?.source === 'published-reference'
      && pickedPrediction?.oddsPoolCode === 'HHAD'
      && !sameHandicapLine(
        pickedPrediction.handicapLine,
        getOfficialMatchOdds(match).hhad?.handicap
      );
    const isPublishedReferenceSpUnavailable = isPublishedModelOnlyReference
      || isPublishedHhadLineMismatch;
    const settledStatus = reviewRow?.resultStatus || pickedPrediction?.resultStatus;
    const showFormalHit = isFinished && reviewIsFormal && settledStatus === 'WON';
    const showFormalMiss = isFinished && reviewIsFormal && settledStatus === 'LOST';
    const showLiveHit = isFinished && reviewIsLive && settledStatus === 'WON';
    const showLiveMiss = isFinished && reviewIsLive && settledStatus === 'LOST';
    const showReferenceOutcome = Boolean(
      isFinished
      && reviewRow
      && !reviewIsFormal
      && !reviewIsLive
      && isSettledReviewStatus(reviewRow.resultStatus)
    );
    const isReferencePick = Boolean(
      (!isFinished && !displayRecommendation && analysisReference)
      || (isInPlayArchiveFallback && archivedPreMatchPrediction?.recommendationAction !== 'recommend')
      || (isFinished && reviewRow && !reviewIsFormal && !reviewIsLive)
      || (isFinished && !reviewRow && !livePublishedRecommendation && archivedPreMatchPrediction)
    );
    const isLowEvidenceReference = Boolean(
      !isFinished
      && (
        analysisReferenceSelection?.source === 'official-low-evidence-market'
        || analysisReferenceSelection?.source === 'five-hundred-low-evidence-market'
        || analysisReferenceSelection?.source === 'model-low-evidence'
      )
    );
    const isFiveHundredReference = !isFinished
      && (
        analysisReferenceSelection?.source === 'five-hundred-market'
        || analysisReferenceSelection?.source === 'five-hundred-low-evidence-market'
        || isFiveHundredMarketReferencePrediction(pickedPrediction)
      );
    const isModelLowEvidenceReference = Boolean(
      !isFinished && analysisReferenceSelection?.source === 'model-low-evidence'
    );
    const fiveHundredPresentation = isFiveHundredReference
      ? buildFiveHundredMarketReferencePresentation(match, nowMs)
      : null;
    const hasMarketConflict = Boolean(
      !isFinished
      && !displayRecommendation
      && hasCrossMarketDirectionConflict(match, pickedPrediction || watchDirectionPrediction)
    );
    const selectionTone: ListSelectionTone = isFinished
      ? (reviewIsLive || (!reviewRow && livePublishedRecommendation)
        ? 'live'
        : reviewIsFormal ? 'review' : 'analysis')
      : isInPlayArchiveFallback && archivedPreMatchPrediction?.recommendationAction === 'recommend'
        ? 'recommendation'
      : displayRecommendation
        ? (displayRecommendation.publicationTrack === 'live' ? 'live' : 'recommendation')
        : 'analysis';
    const selectionKindLabel = isFinished
      ? reviewIsLive || (!reviewRow && livePublishedRecommendation)
        ? (language === 'zh' ? '实时推荐归档' : 'Published live pick')
        : reviewIsFormal
        ? (language === 'zh' ? '正式推荐归档' : 'Formal pick archive')
        : !reviewRow && archivedPreMatchPrediction
          ? (match.status === 'PENDING_RESULT'
            ? (language === 'zh' ? '赛前数据推荐归档 · 待官方赛果' : 'Archived pre-match data pick · awaiting official result')
            : (language === 'zh' ? '赛前数据推荐归档' : 'Archived pre-match data pick'))
        : (language === 'zh' ? '数据推荐归档' : 'Data-pick archive')
      : isInPlayArchiveFallback
        ? (language === 'zh' ? '原赛前推荐归档 · 进行中' : 'Original pre-match pick · live')
      : isFiveHundredReference
        ? (language === 'zh' ? '参考推荐 · 500数据推荐' : 'Reference pick · 500.com')
        : isLowEvidenceReference
          ? (language === 'zh' ? '参考推荐 · 低置信' : 'Reference pick · Low confidence')
        : getSelectionTierLabel(selectionTone, language);
    const directionLabel = reviewRow?.tipLabel?.[language]
      ? stripDirectionPrefix(reviewRow.tipLabel[language], language)
      : displayRecommendation?.label || (pickedPrediction
      ? stripDirectionPrefix(getPredictionTipDisplay(pickedPrediction, language, true), language)
      : '');
    const publicCopy = buildPublicRecommendationCopy(match, pickedPrediction, language, {
      pickLabel: directionLabel,
      fallbackReason: fiveHundredPresentation?.prediction.explanation[language]
        || displayRecommendation?.reason
        || getDecisionReason(signal.category, language),
      forceReference: isReferencePick
    });
    const poolStatus = publicCopy.marketLabel;
    const primaryLabel = displayRecommendation
      ? publicCopy.title
      : pickedPrediction
        ? (isReferencePick ? directionLabel : publicCopy.title)
      : '';
    const fallbackPrimaryLabel = signal.category === 'finished'
        ? (language === 'zh' ? '赛后复盘' : 'Review')
        : publicCopy.title;
    const lowEvidenceLeaderPercent = Number(pickedPrediction?.trustScore || 0).toFixed(0);
    const primaryMeta = fiveHundredPresentation
      ? (language === 'zh'
        ? `去水首位 ${Math.round(fiveHundredPresentation.reference.leaderProbability * 1000) / 10}%`
        : `De-vigged leader ${Math.round(fiveHundredPresentation.reference.leaderProbability * 1000) / 10}%`)
      : isModelLowEvidenceReference
        ? (language === 'zh'
          ? '模型方向 · 低置信度'
          : 'Model direction · Low confidence')
      : isLowEvidenceReference
        ? (language === 'zh'
          ? `去水首位 ${lowEvidenceLeaderPercent}% · 风险较高`
          : `De-vigged leader ${lowEvidenceLeaderPercent}% · Higher risk`)
      : publicCopy.strengthLabel;
    const fiveHundredDisplayOdds = fiveHundredPresentation?.reference.selectedSourceOdds
      || (
        analysisReferenceSelection?.source === 'five-hundred-low-evidence-market'
          ? analysisReferenceSelection.displayOdds
          : null
      );
    const oddsValue = language === 'zh'
      ? publicCopy.oddsLabel.replace(/^赔率\s*/, '')
      : publicCopy.oddsLabel.replace(/^Odds\s*/, '');
    const selectedMarketFact = isPublishedModelOnlyReference
      ? (language === 'zh' ? '模型 1X2（无官方 SP）' : 'Model 1X2 (no official SP)')
      : pickedPrediction?.oddsPoolCode === 'HHAD'
      ? `HHAD ${language === 'zh' ? '让球胜平负' : 'Handicap Result'}${pickedPrediction.handicapLine || match.handicapLine ? ` (${pickedPrediction.handicapLine || match.handicapLine})` : ''}`
      : pickedPrediction?.oddsPoolCode === 'HAD'
        ? `HAD ${language === 'zh' ? '胜平负' : '1X2'}`
        : poolStatus;
    const referenceOfficialOdds = isReferencePick
      ? getOfficialPredictionOdds(match, pickedPrediction)
      : 0;
    const referenceOdds = isReferencePick && referenceOfficialOdds <= 1
      ? getReferencePredictionOdds(match, pickedPrediction, language)
      : null;
    const referenceSnapshotTime = isReferencePick
      ? formatReferenceTime(
        fiveHundredPresentation?.reference.sourceUpdatedAt || match.predictionMeta?.generatedAt,
        language
      )
      : '';
    const archivedDecisionTime = isFinished || isInPlayArchiveFallback
      ? match.archivedPreMatchPrediction?.capturedAt
      : undefined;
    const archivedCutoffTime = isFinished || isInPlayArchiveFallback
      ? match.archivedPreMatchPrediction?.cutoffTime
      : undefined;
    const decisionDataTime = formatReferenceTime(
      archivedDecisionTime
        || analysisReferenceSelection?.sourceUpdatedAt
        || match.predictionMeta?.lockedAt
        || match.predictionMeta?.generatedAt
        || match.oddsUpdatedAt,
      language
    );
    const decisionCutoffTime = formatReferenceTime(
      archivedCutoffTime || liveRecommendationCutoffIso(match),
      language
    );
    const countsInFormalHitRate = Boolean(
      isFinished ? reviewIsFormal : displayRecommendation?.publicationTrack === 'formal'
    );
    const fixtureReview = match.postMatchReview;
    const fixtureReviewDiagnosis = fixtureReview?.modelDiagnosis || [];
    const fixtureReviewAdjustments = fixtureReview?.nextAdjustment || [];
    const fixtureReviewDataGaps = fixtureReview?.dataGaps || [];
    const fixtureReviewTip = reviewRow?.tipLabel?.[language] || reviewRow?.tipCode || primaryLabel || '--';
    const fixtureReviewActual = reviewRow?.actualLabel?.[language]
      || reviewRow?.actualCode
      || fixtureReview?.actual?.had?.label?.[language]
      || '--';
    const fixtureReviewTrack = reviewIsFormal
      ? (language === 'zh' ? '正式推荐' : 'Formal pick')
      : reviewIsLive
        ? (language === 'zh' ? '实时推荐' : 'Live pick')
        : (language === 'zh' ? '数据参考' : 'Data reference');
    const fixtureReviewOutcome = settledStatus === 'WON'
      ? (language === 'zh' ? '命中' : 'Hit')
      : settledStatus === 'LOST'
        ? (language === 'zh' ? '未命中' : 'Miss')
        : (language === 'zh' ? '待结算' : 'Pending');
    const fixtureMistakeSummary = settledStatus === 'LOST'
      ? (language === 'zh'
        ? `赛前冻结“${fixtureReviewTip}”，实际结算“${fixtureReviewActual}”；可确认的直接失误是主方向判断错误。其余归因只采用已接入证据。`
        : `The frozen direction was “${fixtureReviewTip}”, while settlement was “${fixtureReviewActual}”. The confirmed direct error was the primary direction call; other causes use available evidence only.`)
      : '';
    const usageLabel = isFinished
      ? (!reviewRow && archivedPreMatchPrediction
        ? (match.status === 'PENDING_RESULT'
          ? (language === 'zh' ? '赛前归档 · 等待官方赛果' : 'Pre-match archive · awaiting official result')
          : (language === 'zh' ? '赛前归档' : 'Pre-match archive'))
        : (language === 'zh' ? '赛后复盘' : 'Post-match review'))
      : isInPlayArchiveFallback
        ? (language === 'zh' ? '原赛前归档 · 比赛进行中' : 'Original pre-match archive · live')
      : isReferencePick
        ? (language === 'zh' ? '仅数据参考' : 'Data reference only')
        : (language === 'zh' ? '赛前推荐' : 'Pre-match pick');
    const lowEvidenceReason = isLowEvidenceReference
      ? pickedPrediction?.explanation?.[language]
      : '';
    const referenceReason = lowEvidenceReason
      || (referenceOfficialOdds > 1
      ? (language === 'zh'
        ? '该方向作为数据推荐展示并单独复盘；不并入正式战绩或串关。'
        : 'This direction is shown as a separately reviewed data pick and is excluded from the formal record and parlays.')
      : fiveHundredPresentation
        ? (language === 'zh'
          ? `${fiveHundredPresentation.prediction.explanation.zh}${referenceSnapshotTime ? ` 赔率快照 ${referenceSnapshotTime}` : ''}`
          : `${fiveHundredPresentation.prediction.explanation.en}${referenceSnapshotTime ? ` Odds snapshot ${referenceSnapshotTime}` : ''}`)
        : (language === 'zh'
          ? `模型已给出赛前数据推荐，暂无官方在售 SP；${referenceOdds ? `当前采用${referenceOdds.sourceLabel} SP ${referenceOdds.odds.toFixed(2)} 作赔率对照，` : ''}单独复盘且不并入正式战绩或串关。${referenceSnapshotTime ? ` 模型快照 ${referenceSnapshotTime}` : ''}`
          : `The model has produced a pre-match data pick, but no official SP is on sale.${referenceOdds ? ` ${referenceOdds.sourceLabel} SP ${referenceOdds.odds.toFixed(2)} is shown for price comparison.` : ''} Reviewed separately and excluded from the formal record and parlays.${referenceSnapshotTime ? ` Model snapshot ${referenceSnapshotTime}` : ''}`));
    const decisionReason = isInPlayArchiveFallback
      ? (language === 'zh'
        ? '展示截止前已冻结的原赛前方向；比赛进行中不根据即时比分或赛后盘口改写推荐。'
        : 'This is the original direction frozen before cutoff; live score and post-kickoff prices cannot rewrite it.')
      : isFinished && !reviewRow && archivedPreMatchPrediction
      ? (language === 'zh'
        ? '这是截止前已冻结的原赛前方向；当前只等待官方赛果结算，方向、盘口和 SP 均不会在赛后改写。'
        : 'This is the original pre-match direction frozen before cutoff. It only awaits official settlement; its direction, line, and SP cannot be rewritten after kickoff.')
      : fiveHundredPresentation || isLowEvidenceReference
      ? referenceReason
      : hasMarketConflict
      ? (language === 'zh' ? '胜平负与让球盘方向冲突，未进入正式推荐。' : 'HAD and HHAD conflict, so this is excluded from formal picks.')
      : isReferencePick
        ? referenceReason
        : publicCopy.reasons[0] || displayRecommendation?.reason || '';

    if (
      !isFinished
      && !displayRecommendation
      && !archivedPreMatchPrediction
      && !analysisReference
    ) {
      const watchDirectionLabel = watchDirectionPrediction
        ? stripDirectionPrefix(getPredictionTipDisplay(watchDirectionPrediction, language, true), language)
        : '';
      return (
        <div className={`decision-card is-watch is-watch-only ${watchDirectionPrediction ? 'has-pick has-watch-direction' : ''} ${hasMarketConflict ? 'is-cross-market-conflict' : ''}`}>
          <div className="decision-main">
            <span className="decision-selection-kind is-analysis">WATCH</span>
            <span className="decision-label">
              {watchDirectionLabel || (language === 'zh' ? '暂无推荐' : 'No pick')}
            </span>
          </div>
          <RecommendationEvidenceFacts
            match={match}
            prediction={watchDirectionPrediction}
            language={language}
            className="is-watch"
          />
          <p className="decision-reason">
            <span>
              {watchDirectionPrediction
                ? (language === 'zh'
                  ? `已有模型方向“${watchDirectionLabel}”，但证据完整度、官方 SP 或跨盘口一致性尚未达到参考推荐门槛；仅列为 WATCH，不计正式战绩。`
                  : `The model direction “${watchDirectionLabel}” exists, but evidence coverage, official SP, or cross-market consistency has not reached the reference-pick gate. It remains WATCH and is excluded from the formal record.`)
                : hasMarketConflict
                ? (language === 'zh' ? '跨盘口方向冲突，暂不推荐' : 'Cross-market directions conflict; no pick is issued')
                : hasDisplayedPoolOdds
                  ? (language === 'zh'
                    ? `模型证据仍不足，本场暂不强行给方向；仅展示${hasReferencePoolOdds ? '500/外部参考赔率' : '官方赔率'}。`
                    : `Model evidence is still insufficient, so no direction is forced; ${hasReferencePoolOdds ? '500/external reference prices' : 'official odds'} are shown for comparison.`)
                  : (language === 'zh' ? '赔率与可审计输入不足，暂不能形成可靠推荐。' : 'Odds and audited inputs are insufficient for a reliable pick.')}
            </span>
          </p>
        </div>
      );
    }

    return (
      <div className={`decision-card is-${signal.category} ${displayRecommendation || pickedPrediction ? 'has-pick' : 'is-watch-only'} ${isReferencePick ? 'is-reference' : ''} ${hasMarketConflict ? 'is-cross-market-conflict' : ''} ${showFormalHit ? 'is-hit' : ''} ${showFormalMiss ? 'is-miss' : ''}`}>
        <div className="decision-main">
          <span className={`decision-selection-kind is-${selectionTone}`}>
            {selectionKindLabel}
          </span>
          {selectionTone === 'live' && displayRecommendation?.prediction?.liveRecommendation?.dataCoverageWarning && (
            <span className="decision-coverage-warning">
              {language === 'zh' ? '辅助数据覆盖偏低' : 'Low auxiliary-data coverage'}
            </span>
          )}
          <span className="decision-label">{primaryLabel || fallbackPrimaryLabel}</span>
          <span className="decision-meta">{primaryMeta}</span>
          {companionRecommendation && (
            <span className="decision-companion-line">
              <span>{getHandicapCompanionHeading(companionRecommendation, language)}</span>
              <strong>{companionRecommendation.label}</strong>
              <em>{companionRecommendation.meta}</em>
            </span>
          )}
          {showFormalHit && (
            <span className="mini-hit">{language === 'zh' ? '推荐命中' : 'Formal pick hit'}</span>
          )}
          {showFormalMiss && (
            <span className="mini-miss">{language === 'zh' ? '推荐未中' : 'Formal pick miss'}</span>
          )}
          {showLiveHit && (
            <span className="mini-hit">{language === 'zh' ? '实时推荐命中' : 'Live pick hit'}</span>
          )}
          {showLiveMiss && (
            <span className="mini-miss">{language === 'zh' ? '实时推荐未中' : 'Live pick miss'}</span>
          )}
          {showReferenceOutcome && (
            <span
              className="mini-watch"
              title={reviewRow?.resultStatus === 'WON'
                ? (language === 'zh' ? '分析参考符合赛果' : 'Analysis reference matched result')
                : (language === 'zh' ? '分析参考不符合赛果' : 'Analysis reference did not match result')}
            >
              {reviewRow?.resultStatus === 'WON'
                ? (language === 'zh' ? '参考命中 · 不计正式战绩' : 'Reference hit · excluded from formal record')
                : (language === 'zh' ? '参考未命中 · 不计正式战绩' : 'Reference miss · excluded from formal record')}
            </span>
          )}
          {provisionalArchivedOutcome && (
            <span className="mini-watch">
              {language === 'zh'
                ? `外部赛果 ${provisionalArchivedOutcome.scoreText} · 赛前方向${provisionalArchivedOutcome.resultStatus === 'WON' ? '符合' : '不符合'}`
                : `External result ${provisionalArchivedOutcome.scoreText} · pre-match direction ${provisionalArchivedOutcome.resultStatus === 'WON' ? 'matched' : 'missed'}`}
            </span>
          )}
        </div>

        <RecommendationEvidenceFacts
          match={match}
          prediction={pickedPrediction}
          language={language}
          className={isReferencePick ? 'is-reference' : undefined}
        />

        <div className="decision-facts">
          <span>
            {referenceOdds
              ? referenceOdds.sourceLabel
              : fiveHundredDisplayOdds && fiveHundredDisplayOdds > 1
                ? (language === 'zh' ? '500参考赔率' : '500.com reference odds')
                : (language === 'zh' ? '赔率' : 'Odds')}
            <strong>{isPublishedReferenceSpUnavailable
              ? 'SP --'
              : referenceOdds
                ? `SP ${referenceOdds.odds.toFixed(2)}`
                : fiveHundredDisplayOdds && fiveHundredDisplayOdds > 1
                  ? `SP ${fiveHundredDisplayOdds.toFixed(2)}`
                  : oddsValue}</strong>
          </span>
          <span className="decision-market-fact">
            {language === 'zh' ? '结论玩法' : 'Selected market'}
            <strong title={selectedMarketFact}>{selectedMarketFact}</strong>
          </span>
          {fiveHundredPresentation && (
            <span>
              {language === 'zh' ? '500去水概率' : '500.com de-vigged'}
              <strong>{`${Math.round(fiveHundredPresentation.reference.leaderProbability * 1000) / 10}%`}</strong>
            </span>
          )}
          <span className="decision-accounting-fact">
            {language === 'zh' ? '正式统计' : 'Formal record'}
            <strong>{countsInFormalHitRate
              ? (language === 'zh' ? '计入正式命中率' : 'Included')
              : (language === 'zh' ? '不计入正式命中率' : 'Excluded')}</strong>
          </span>
          <span className="decision-usage-fact">
            {language === 'zh' ? '用途' : 'Use'}
            <strong>{usageLabel}</strong>
          </span>
          <span className="decision-data-time-fact">
            {language === 'zh' ? '数据时间' : 'Data as of'}
            <strong>{decisionDataTime || (language === 'zh' ? '时间缺失' : 'Unavailable')}</strong>
          </span>
          <span className="decision-cutoff-time-fact">
            {language === 'zh' ? '截止时间' : 'Cutoff'}
            <strong>{decisionCutoffTime || '--'}</strong>
          </span>
        </div>
        {decisionReason && (
          <p className="decision-reason">
            <span>{decisionReason}</span>
          </p>
        )}
        {isFixturesView && isFinished && reviewRow && (
          <details className="fixture-review-disclosure" data-review-track={reviewRow.performanceTrack || 'reference'}>
            <summary>
              <span>{language === 'zh' ? '本场赛后复盘' : 'Post-match review'}</span>
              <strong className={settledStatus === 'WON' ? 'is-hit' : settledStatus === 'LOST' ? 'is-miss' : ''}>
                {fixtureReviewTrack} · {fixtureReviewOutcome}
              </strong>
            </summary>
            <div className="fixture-review-disclosure__body">
              <div className="fixture-review-disclosure__facts">
                <span>{language === 'zh' ? '冻结方向' : 'Frozen direction'}<strong>{fixtureReviewTip}</strong></span>
                <span>{language === 'zh' ? '实际赛果' : 'Actual result'}<strong>{fixtureReviewActual}</strong></span>
                <span>{language === 'zh' ? '比分复盘' : 'Score review'}<strong>{fixtureReview?.scoreReview?.projectedScore || '--'} → {fixtureReview?.finalScore || '--'}</strong></span>
              </div>
              {fixtureMistakeSummary && (
                <p className="fixture-review-disclosure__mistake"><strong>{language === 'zh' ? '未命中与失误定位：' : 'Miss and error diagnosis: '}</strong>{fixtureMistakeSummary}</p>
              )}
              {fixtureReviewDiagnosis.length > 0 && (
                <section>
                  <strong>{language === 'zh' ? '原因复盘' : 'Reason review'}</strong>
                  {fixtureReviewDiagnosis.map((item) => <p key={`fixture-diagnosis-${item.code}`}>{item[language]}</p>)}
                </section>
              )}
              {fixtureReviewAdjustments.length > 0 && (
                <section>
                  <strong>{language === 'zh' ? '后续调整' : 'Next adjustment'}</strong>
                  {fixtureReviewAdjustments.map((item) => <p key={`fixture-adjustment-${item.code}`}>{item[language]}</p>)}
                </section>
              )}
              {fixtureReviewDataGaps.length > 0 && (
                <section className="is-muted">
                  <strong>{language === 'zh' ? '复盘证据缺口' : 'Review evidence gaps'}</strong>
                  <p>{fixtureReviewDataGaps.map((item) => item[language]).join(language === 'zh' ? '、' : ', ')}</p>
                </section>
              )}
              <p className="fixture-review-disclosure__hint">
                {language === 'zh' ? '点击本行“详情”可查看全部市场结算、历史样本与证据。' : 'Use Details on this row for all market settlements, history samples, and evidence.'}
              </p>
            </div>
          </details>
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

  const sourceHealth = dataSync.sourceHealth;
  const sourceFallback = dataSync.sourceFallback;
  const sourceFallbackCoverage = sourceHealth?.fallbackCoverage || dataSync.sourceFallbackCoverage;
  const sourceServingMode = sourceFallbackCoverage?.servingMode || '';
  const sportterySource = sourceHealth?.sources?.find((source) => source.id === 'sporttery');
  const fiveHundredSource = sourceHealth?.sources?.find((source) => source.id === 'five-hundred');
  const sportteryMetrics = sportterySource?.metrics || {};
  const fiveHundredMetrics = fiveHundredSource?.metrics || {};
  const metricBoolean = (value: unknown) => value === true || value === 'true';
  const metricNumber = (value: unknown) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  const metricString = (value: unknown) => (typeof value === 'string' ? value : null);
  const relayCurrentFresh = Boolean(
    sourceFallbackCoverage?.relayCurrentFresh
    ?? metricBoolean(sportteryMetrics.relayCurrentFresh)
  );
  const relayCurrentRows = metricNumber(
    sourceFallbackCoverage?.relayCurrentRows
    ?? sportteryMetrics.relayCurrentRows
  );
  const relayCurrentFreshnessTime = sourceFallbackCoverage?.relayCurrentFreshnessTime
    || metricString(sportteryMetrics.relayCurrentFreshnessTime);
  const relayResultFreshRaw = sourceFallbackCoverage?.relayResultFresh
    ?? sportteryMetrics.relayResultFresh;
  const relayResultKnown = relayResultFreshRaw !== undefined && relayResultFreshRaw !== null;
  const relayResultFresh = relayResultKnown && metricBoolean(relayResultFreshRaw);
  const relayResultRows = metricNumber(
    sourceFallbackCoverage?.relayResultRows
    ?? sportteryMetrics.relayResultRows
  );
  const relayResultFreshnessTime = sourceFallbackCoverage?.relayResultFreshnessTime
    || metricString(sportteryMetrics.relayResultFreshnessTime);
  const syncMetaCurrentStale = Boolean(
    sourceFallbackCoverage?.syncMetaCurrentStale
    ?? metricBoolean(sportteryMetrics.syncMetaCurrentStale)
  );
  const relayCurrentServiceable = relayCurrentFresh && relayCurrentRows > 0;
  const relayPagedDegraded = relayCurrentServiceable && syncMetaCurrentStale;
  const relayResultDegraded = relayResultKnown && !relayResultFresh;
  const relayPartialDegraded = relayPagedDegraded || relayResultDegraded;
  const sportteryEgress = sourceHealth?.sportteryEgress;
  const sportteryEgressSummary = sportteryEgress?.summary;
  const sportteryEgressBlocked = Boolean(
    sportteryEgress?.exists
    && sportteryEgress?.ok === false
    && (
      String(sportteryEgress?.status || '').toLowerCase() === 'blocked'
      || Boolean(sportteryEgressSummary?.wafBlocked)
      || Number(sportteryEgressSummary?.jsonEndpoints || 0) === 0
    )
  );
  const sportteryEgressDisabled = Boolean(
    sportteryEgress?.exists
    && (
      String(sportteryEgress?.status || '').toLowerCase() === 'disabled'
      || sportteryEgress?.transport === 'direct-disabled'
    )
  );
  const sourceFallbackCoverageActive = sourceServingMode === 'fallback-degraded'
    || Boolean(sourceFallbackCoverage?.primaryStale && sourceFallbackCoverage?.usable);
  const fallbackCoverageNote = sourceFallbackCoverage
    ? `500 ${sourceFallbackCoverage.coveredByFiveHundredDetails ?? 0}/${sourceFallbackCoverage.currentMatches ?? 0} (${sourceFallbackCoverage.fiveHundredCoveragePercent ?? 0}%) / ref odds ${sourceFallbackCoverage.referenceOddsMatches ?? 0}`
    : '';
  const hasSourceFallback = Boolean(
    sourceFallback?.keptExisting ||
    ((sourceFallback?.sportteryPublishableMatches ?? null) === 0 && (sourceFallback?.fiveHundredFallbackMatches ?? 0) > 0) ||
    sourceFallbackCoverageActive
  );
  const hasSourceTransportIssue = sportteryEgressBlocked;
  const recommendationReliable = dataSync.recommendationReliable !== false;
  const fallbackAgeSeconds = typeof dataSync.fallbackAgeSeconds === 'number' ? dataSync.fallbackAgeSeconds : null;
  const fallbackMaxAgeSeconds = typeof dataSync.fallbackMaxAgeSeconds === 'number' ? dataSync.fallbackMaxAgeSeconds : null;
  const fallbackAgeMinutes = fallbackAgeSeconds !== null ? Math.max(0, Math.floor(fallbackAgeSeconds / 60)) : null;
  const fallbackMaxMinutes = fallbackMaxAgeSeconds !== null ? Math.max(1, Math.floor(fallbackMaxAgeSeconds / 60)) : null;
  const fallbackRemainingSeconds = fallbackAgeSeconds !== null && fallbackMaxAgeSeconds !== null
    ? Math.max(0, fallbackMaxAgeSeconds - fallbackAgeSeconds)
    : null;
  const fallbackRemainingMinutes = fallbackRemainingSeconds !== null ? Math.max(0, Math.ceil(fallbackRemainingSeconds / 60)) : null;
  const fallbackWindowExpired = hasSourceFallback && dataSync.fallbackWithinReliableWindow === false;
  const fallbackWindowLabel = fallbackWindowExpired
    ? (language === 'zh' ? '\u5df2\u8d85\u8fc7\u53ef\u9760\u7a97\u53e3' : 'Window expired')
    : hasSourceFallback && dataSync.fallbackWithinReliableWindow === true
      ? (language === 'zh' ? '\u53ef\u9760\u7a97\u53e3\u5185' : 'In reliability window')
      : '--';
  const fallbackWindowNote = hasSourceFallback && fallbackAgeMinutes !== null && fallbackMaxMinutes !== null
    ? (fallbackWindowExpired
      ? (language === 'zh'
        ? `${fallbackAgeMinutes}/${fallbackMaxMinutes}\u5206\u949f\uff0c\u63a8\u8350\u5df2\u964d\u7ea7`
        : `${fallbackAgeMinutes}/${fallbackMaxMinutes}m, picks downgraded`)
      : (language === 'zh'
        ? `\u5269\u4f59\u7ea6 ${fallbackRemainingMinutes ?? '--'} \u5206\u949f`
        : `about ${fallbackRemainingMinutes ?? '--'}m left`))
    : '';
  const sportteryEgressStatusLabel = !sportteryEgress?.exists
    ? (language === 'zh' ? '\u5f85\u68c0\u6d4b' : 'Pending')
    : sportteryEgressDisabled
      ? (language === 'zh' ? 'Relay \u63a5\u7ba1' : 'Relay mode')
    : sportteryEgress?.ok
      ? (language === 'zh' ? '\u4e3b\u6e90\u6b63\u5e38' : 'Primary ok')
      : sportteryEgressBlocked
        ? (language === 'zh' ? '\u4e3b\u6e90\u53d7\u9650' : 'Primary limited')
        : (language === 'zh' ? '\u4e3b\u6e90\u89c2\u5bdf' : 'Watch');
  const sportteryEgressNote = !sportteryEgress?.exists
    ? (language === 'zh' ? '\u7b49\u5f85\u540e\u53f0\u51fa\u53e3\u68c0\u6d4b' : 'Waiting for egress check')
    : sportteryEgressDisabled
      ? (language === 'zh'
        ? '\u670d\u52a1\u5668\u4e0d\u76f4\u8fde\uff0c\u4f7f\u7528 relay \u5feb\u7167'
        : 'Direct fetch disabled; relay snapshots are serving')
    : sportteryEgressBlocked
      ? (hasSourceFallback
        ? (language === 'zh' ? '\u5df2\u4fdd\u7559\u5feb\u7167\uff0c500 \u7ee7\u7eed\u6821\u9a8c' : 'Snapshot kept; 500.com still checks')
        : (language === 'zh' ? '\u7b49\u5f85\u4e0b\u4e00\u8f6e\u540c\u6b65\u6062\u590d' : 'Waiting for the next sync to recover'))
      : (language === 'zh'
        ? `${sportteryEgress.transport === 'proxy' ? '\u4ee3\u7406' : '\u76f4\u8fde'} / JSON ${sportteryEgressSummary?.jsonEndpoints ?? 0}`
        : `${sportteryEgress.transport === 'proxy' ? 'proxy' : 'direct'} / JSON ${sportteryEgressSummary?.jsonEndpoints ?? 0}`);
  const sourceFallbackLabel = language === 'zh'
    ? `后台已检查，官方竞彩本轮未返回新的开售数据；当前使用锁定快照 + 500 校验。`
    : `Backend checked successfully, but Sporttery returned no fresh on-sale data; using the locked snapshot plus 500.com checks.`;

  const isCurrentDataLoading = Boolean(
    dataSync.currentLoading ||
    (!dataSync.currentLoaded && !dataSync.error && !dataSync.lastCheckedAt)
  );
  const isHistoryDateLoading = Boolean(
    effectiveSelectedDate < todayStr
    && dataSync.historyLoading
    && !dataSync.historyLoaded
    && baseFilteredMatches.length === 0
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
      if (dataSync.serviceTransitioning) return t('dataReleaseContinuity');
      if (!recommendationReliable) {
        return language === 'zh'
          ? '\u6570\u636e\u6e90\u5f53\u524d\u6709\u98ce\u9669\u8b66\u793a\uff1a\u5df2\u53d1\u5e03\u4e14\u5df2\u9501\u5b9a\u7684\u6b63\u5f0f\u63a8\u8350\u7ee7\u7eed\u5c55\u793a\uff0c\u65b0\u65b9\u5411\u4ecd\u9700\u901a\u8fc7\u5b8c\u6574\u53d1\u5e03\u95e8\u69db\u3002'
          : 'The data source is under a risk warning. Published and locked formal picks remain visible; new directions still need to pass the full publication gate.';
      }
      if (isDataStale) {
        const lastAttemptLabel = formatSyncTime(dataSync.lastAttemptAt || dataSync.lastCheckedAt, language);
        return language === 'zh'
          ? `数据源已 ${formatAgeMinutes(sourceAgeMinutes, language)} 未发布新快照；后台最近检查 ${lastAttemptLabel}。`
          : `Source data is ${formatAgeMinutes(sourceAgeMinutes, language)} old; last background check ${lastAttemptLabel}.`;
      }
      if (hasSourceFallback) return sourceFallbackLabel;
      if (hasSourceTransportIssue) {
        return language === 'zh'
          ? '\u5b98\u65b9\u6e90\u51fa\u53e3\u53d7\u9650\uff0c\u540e\u53f0\u4fdd\u7559\u4e0a\u4e00\u7248\u53ef\u4fe1\u6570\u636e\u5e76\u7ee7\u7eed\u68c0\u6d4b\u3002'
          : 'Official-source egress is limited; the backend keeps the last trusted snapshot and keeps checking.';
      }
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
    : dataSync.error || isDataStale || hasSourceFallback || hasSourceTransportIssue || relayPartialDegraded || !recommendationReliable
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
            : dataSync.dataChannel === 'retained'
              ? t('dataChannelRetained')
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
    sourceHealth?.externalSignals?.fiveHundredDetailsCachedMerged ?? metricNumber(fiveHundredMetrics.detailsCachedMerged),
    activeSourceMatches.filter((match) => match.externalSignals?.fiveHundred).length
  );
  const fiveHundredErrors = sourceHealth?.externalSignals?.fiveHundredDetailsErrors
    ?? metricNumber(fiveHundredMetrics.errors);
  const fiveHundredCurrentCount = sourceHealth?.currentMatches?.withFiveHundredDetails
    ?? Math.min(fiveHundredDetailsCount, sourceCurrentCount);
  const fiveHundredCoverageRatio = sourceCurrentCount > 0 ? fiveHundredCurrentCount / sourceCurrentCount : 0;
  const fiveHundredCoveragePercent = typeof sourceFallbackCoverage?.fiveHundredCoveragePercent === 'number'
    ? sourceFallbackCoverage.fiveHundredCoveragePercent
    : Math.round(fiveHundredCoverageRatio * 1000) / 10;
  const fiveHundredFresh = fiveHundredSource?.stale === false;
  const apiFootballMapped = Math.max(
    sourceHealth?.externalSignals?.apiFootballMappedSignals ?? 0,
    activeSourceMatches.filter((match) => match.externalSignals?.apiFootball).length
  );
  const apiFootballCallsThisSync = sourceHealth?.externalSignals?.apiFootballCallsThisSync ?? 0;
  const apiFootballCallsToday = sourceHealth?.externalSignals?.apiFootballCallsTodayEstimate ?? 0;
  const sourceHealthItems = [
    ...(sportteryEgress ? [{
      label: language === 'zh' ? '\u5b98\u65b9\u51fa\u53e3' : 'Official egress',
      value: sportteryEgressStatusLabel,
      note: sportteryEgressNote
    }] : []),
    ...(relayCurrentServiceable ? [{
      label: language === 'zh' ? '\u5f53\u524d\u901a\u9053' : 'Current lane',
      value: language === 'zh' ? '\u5b9e\u65f6\u53ef\u7528' : 'Live fresh',
      note: relayCurrentFreshnessTime
        ? `${relayCurrentRows} rows / ${formatSyncTime(relayCurrentFreshnessTime, language)}`
        : `${relayCurrentRows} rows`
    }] : []),
    ...(relayResultKnown ? [{
      label: language === 'zh' ? '赛果通道' : 'Result lane',
      value: relayResultFresh
        ? (language === 'zh' ? '实时可用' : 'Fresh')
        : (language === 'zh' ? '同步延迟' : 'Delayed'),
      note: relayResultFreshnessTime
        ? `${relayResultRows} rows / ${formatReferenceTime(relayResultFreshnessTime, language)}${!relayResultFresh ? ` · ${language === 'zh' ? '已延迟' : 'delayed'} ${formatAgeMinutes(getDataAgeMinutes(relayResultFreshnessTime, nowMs), language)}` : ''}`
        : `${relayResultRows} rows`
    }] : []),
    ...(relayPagedDegraded ? [{
      label: language === 'zh' ? '\u5206\u9875\u91c7\u96c6' : 'Paged crawl',
      value: language === 'zh' ? '\u964d\u7ea7\u89c2\u5bdf' : 'Degraded',
      note: language === 'zh'
        ? '\u5f53\u524d\u8d5b\u7a0b\u4e0d\u53d7\u5f71\u54cd'
        : 'Current matches are not blocked'
    }] : []),
    ...(sourceFallbackCoverage ? [{
      label: language === 'zh' ? '降级模式' : 'Fallback mode',
      value: sourceServingMode || 'unknown',
      note: fallbackCoverageNote
    }] : []),
    ...(hasSourceFallback ? [{
      label: language === 'zh' ? '\u53ef\u9760\u7a97\u53e3' : 'Reliability window',
      value: fallbackWindowLabel,
      note: fallbackWindowNote
    }] : []),
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
      note: language === 'zh' ? '胜平负官方赔率' : '1X2 official odds'
    },
    {
      label: language === 'zh' ? '500详情' : '500 detail',
      value: `${fiveHundredCurrentCount}/${sourceCurrentCount}`,
      note: fiveHundredErrors > 0
        ? (language === 'zh' ? `缓存 ${fiveHundredDetailsCount} / 错误 ${fiveHundredErrors}` : `${fiveHundredDetailsCount} cached / ${fiveHundredErrors} errors`)
        : (language === 'zh' ? `缓存 ${fiveHundredDetailsCount} 条` : `${fiveHundredDetailsCount} cached`)
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

  const modelEvaluation = dataSync.modelEvaluation;
  const modelStrategy = modelEvaluation?.strategy;
  const modelGate = modelStrategy?.activation?.promotionGate;
  const modelOnlineEffect = modelStrategy?.activation?.onlineEffect || 'shadow';
  const modelGateStatus = modelGate?.status || modelOnlineEffect || '--';
  const modelGateReasons = modelGate?.reasons || [];
  const modelBaselineRows = modelGate?.sample?.marketBaselineRows
    ?? modelEvaluation?.backtest?.sample?.marketBaselineRows
    ?? 0;
  const configuredModelRequiredRows = Number(modelGate?.thresholds?.minMarketBaselineRows);
  const modelRequiredRows = Number.isFinite(configuredModelRequiredRows) && configuredModelRequiredRows > 0
    ? configuredModelRequiredRows
    : 500;
  const modelInputAudit = modelEvaluation?.backtest?.inputAudit;
  const modelInputAuditViolationCount = Number(modelInputAudit?.violationCount ?? 0);
  const modelInputAuditOk = modelInputAudit?.ok !== false && modelInputAuditViolationCount === 0;
  const modelRiskTiers = modelEvaluation?.backtest?.riskTiers;
  const modelRiskTier = modelRiskTiers?.overall?.tier || 'watch';
  const modelRiskFallbackLabel = modelRiskTier === 'stable'
    ? (language === 'zh' ? '稳定' : 'Stable')
    : modelRiskTier === 'degraded'
      ? (language === 'zh' ? '降级' : 'Degraded')
      : (language === 'zh' ? '待验证' : 'Needs validation');
  const modelRiskLabel = modelRiskTiers?.overall?.label?.[language] || modelRiskFallbackLabel;
  const modelRiskReasons = modelRiskTiers?.overall?.reasons || [];
  const modelRiskWarningCount = modelRiskReasons.filter((reason) => reason.tier && reason.tier !== 'stable').length;
  const modelRiskMaxCalibrationError = modelRiskTiers?.confidenceBuckets?.maxCalibrationError;
  const modelRiskNote = Number.isFinite(Number(modelRiskMaxCalibrationError))
    ? (language === 'zh'
      ? `校准误差 ${Number(modelRiskMaxCalibrationError).toFixed(3)}`
      : `calibration ${Number(modelRiskMaxCalibrationError).toFixed(3)}`)
    : (language === 'zh'
      ? `${modelRiskWarningCount} 个风险信号`
      : `${modelRiskWarningCount} risk signals`);
  const modelScorecard = modelEvaluation?.publicScorecard;
  const formalReviewPerformance = modelScorecard?.formalReviewPerformance;
  const cumulativeFormalRecord = formalReviewPerformance?.cumulative;
  const formalReviewDailyRows = formalReviewPerformance?.daily || [];
  const latestFormalDailyRecord = formalReviewDailyRows.length > 0
    ? formalReviewDailyRows[formalReviewDailyRows.length - 1]
    : null;
  const hhadCompanion = modelScorecard?.shadowTracks?.HHAD_COMPANION
    || modelEvaluation?.backtest?.hhadCompanionEvaluation;
  const hhadCompanionRawRows = hhadCompanion?.counts?.pairedNonVoidRows;
  const hhadCompanionAvailable = hhadCompanion?.publicView === true
    && typeof hhadCompanion?.candidateReady === 'boolean'
    && typeof hhadCompanionRawRows === 'number'
    && Number.isInteger(hhadCompanionRawRows)
    && hhadCompanionRawRows >= 0;
  const hhadCompanionRows = hhadCompanionAvailable ? Number(hhadCompanionRawRows) : null;
  const hhadCompanionRequiredRows = Number(hhadCompanion?.gate?.thresholds?.minimumPairedNonVoidRows ?? 500);
  const hhadCompanionReady = hhadCompanionAvailable && hhadCompanion?.candidateReady === true;
  const hhadCompanionSampleReady = hhadCompanionAvailable
    && hhadCompanionRows !== null
    && hhadCompanionRows >= hhadCompanionRequiredRows;
  const hhadCompanionUiStatus = !hhadCompanionAvailable
    ? 'unavailable'
    : hhadCompanionReady
      ? 'manual-review'
      : hhadCompanionSampleReady
        ? 'gate-not-passed'
        : 'shadow-collecting';
  const hhadCompanionStatusLabel = !hhadCompanionAvailable
    ? (language === 'zh' ? '评估数据不可用' : 'Evaluation unavailable')
    : hhadCompanionReady
      ? (language === 'zh' ? '待人工评估' : 'Manual review')
      : hhadCompanionSampleReady
        ? (language === 'zh' ? '门槛未通过' : 'Gate not passed')
        : (language === 'zh' ? '影子采集中' : 'Shadow collecting');
  const hhadBrierImprovement = hhadCompanion?.pairedThreeWay?.improvement?.brier;
  const hhadLogLossImprovement = hhadCompanion?.pairedThreeWay?.improvement?.logLoss;
  const hhadCompanionMetricNote = !hhadCompanionAvailable
    ? (language === 'zh' ? '评估接口缺失或版本不匹配' : 'evaluation payload missing or incompatible')
    : Number(hhadCompanionRows) > 0
    ? `Brier ${formatModelSignedDecimal(hhadBrierImprovement)} / LL ${formatModelSignedDecimal(hhadLogLossImprovement)}`
    : (language === 'zh' ? '只统计原生赛前冻结样本' : 'native frozen pre-match rows only');
  const scorecardSample = modelScorecard?.sample;
  const scorecardBuckets = modelScorecard?.buckets;
  const topMarketBucket = pickLargestSettledBucket(scorecardBuckets?.markets);
  const topLeagueBucket = pickLargestSettledBucket(scorecardBuckets?.leagues);
  const topOddsBucket = pickLargestSettledBucket(scorecardBuckets?.odds);
  const scorecardMarketCount = scorecardBuckets?.markets?.length || 0;
  const scorecardLeagueCount = scorecardBuckets?.leagues?.length || 0;
  const scorecardOddsCount = scorecardBuckets?.odds?.length || 0;
  const scorecardPublicAvailable = modelScorecard?.publicView === true;
  const rawScorecardFormalRows = Number(
    scorecardSample?.formalRecommendationRows ?? scorecardSample?.predictionRows
  );
  const scorecardFormalRows = Number.isInteger(rawScorecardFormalRows) && rawScorecardFormalRows >= 0
    ? rawScorecardFormalRows
    : null;
  const hitRateAudit = modelScorecard?.hitRateAudit;
  const hitRateAuditObserved = hitRateAudit?.observed;
  const hitRateAuditSettled = Number(hitRateAuditObserved?.settled ?? scorecardFormalRows ?? 0);
  const hitRateAuditRequiredRows = Number(hitRateAudit?.minimumSettledRows ?? 500);
  const hitRateAuditTarget = Number(hitRateAudit?.targetRate ?? 0.8);
  const hitRateAuditSampleReady = hitRateAudit?.sampleReady === true;
  const hitRateAuditInterval = hitRateAuditObserved?.interval95;
  const hitRateAuditStatusLabel = hitRateAudit?.status === 'credible-near-target'
    ? (language === 'zh' ? '已形成可信对标证据' : 'Credible benchmark evidence')
    : hitRateAudit?.status === 'verified-below-target'
      ? (language === 'zh' ? '样本已足，尚未达到对标' : 'Sample ready, below benchmark')
      : (language === 'zh' ? '正式样本采集中' : 'Collecting formal samples');
  const hitRateAuditRateLabel = formatModelPercent(hitRateAuditObserved?.hitRate);
  const hitRateAuditIntervalLower = toFiniteNumericMetric(hitRateAuditInterval?.lower);
  const hitRateAuditIntervalUpper = toFiniteNumericMetric(hitRateAuditInterval?.upper);
  const hitRateAuditIntervalLabel = hitRateAuditIntervalLower !== null
    && hitRateAuditIntervalUpper !== null
    ? `${formatModelPercent(hitRateAuditIntervalLower)}–${formatModelPercent(hitRateAuditIntervalUpper)}`
    : '--';
  const hitRateClvAudit = hitRateAudit?.closingLineValue;
  const hitRateClvRows = Number(hitRateClvAudit?.rows ?? 0);
  const hitRateClvCandidateRows = Number(hitRateClvAudit?.candidateRows ?? 0);
  const hitRateClvCoverage = Number(hitRateClvAudit?.timingCoverage);
  const hitRateClvCoverageLabel = Number.isFinite(hitRateClvCoverage)
    ? formatModelPercent(hitRateClvCoverage)
    : '--';
  const hitRateClvSampleLabel = hitRateClvCandidateRows > 0
    ? `${hitRateClvRows}/${hitRateClvCandidateRows} · ${hitRateClvCoverageLabel}`
    : '--';
  const benchmarkShadow = modelScorecard?.shadowTracks?.GOODWIN_BENCHMARK;
  const benchmarkResearchMetrics = benchmarkShadow?.research?.metrics;
  const benchmarkResearchSettled = Number(benchmarkResearchMetrics?.settled || 0);
  const benchmarkResearchWon = Number(benchmarkResearchMetrics?.won || 0);
  const benchmarkProspective = benchmarkShadow?.prospective;
  const benchmarkCaptureHeartbeat = benchmarkShadow?.captureHeartbeat;
  const benchmarkCaptureHeartbeatLabel = benchmarkCaptureHeartbeat?.fresh
    && benchmarkCaptureHeartbeat?.ok
    ? (language === 'zh' ? '在线' : 'Online')
    : (language === 'zh' ? '等待恢复' : 'Awaiting recovery');
  const benchmarkShadowWalkForward = benchmarkShadow?.walkForward;
  const benchmarkShadowMetrics = benchmarkShadowWalkForward?.metrics;
  const benchmarkShadowSettled = Number(benchmarkShadowMetrics?.settled || 0);
  const benchmarkShadowRequired = Number(
    benchmarkShadow?.minimumSettledRowsForPromotionReview || 200
  );
  const benchmarkShadowRateLabel = formatModelPercent(benchmarkShadowMetrics?.hitRate);
  const benchmarkShadowInterval = benchmarkShadowMetrics?.confidence95Percent;
  const benchmarkShadowIntervalLabel = Array.isArray(benchmarkShadowInterval)
    && benchmarkShadowInterval.length >= 2
    && benchmarkShadowInterval.every((value) => toFiniteNumericMetric(value) !== null)
    ? `${Number(benchmarkShadowInterval[0]).toFixed(1)}%–${Number(benchmarkShadowInterval[1]).toFixed(1)}%`
    : '--';
  const benchmarkShadowRoi = toFiniteNumericMetric(benchmarkShadowMetrics?.roiPercent);
  const benchmarkShadowRoiLabel = benchmarkShadowRoi !== null
    ? `${benchmarkShadowRoi.toFixed(1)}%`
    : '--';
  const benchmarkTimeIntegrityRows = Number(
    benchmarkProspective?.metrics?.timeIntegrityEvidenceRows || 0
  );
  const benchmarkTimeIntegrityCoverage = Number(
    benchmarkProspective?.metrics?.timeIntegrityEvidenceCoverage || 0
  );
  const benchmarkTimeIntegrityLabel = Number(benchmarkProspective?.cohort?.settled || 0) > 0
    ? `${(benchmarkTimeIntegrityCoverage * 100).toFixed(1)}%`
    : '--';
  const candidateProspective = modelScorecard?.shadowTracks?.CANDIDATE_PROSPECTIVE;
  const candidateProspectiveMetrics = candidateProspective?.metrics;
  const candidateFormal = candidateProspective?.cohort?.formal;
  const candidateShadow = candidateProspective?.cohort?.shadow;
  const candidateCaptureHeartbeat = candidateProspective?.captureHeartbeat;
  const candidateAdmission = candidateCaptureHeartbeat?.readiness?.admission;
  const candidateFormalFinalized = Number(candidateFormal?.finalized || 0);
  const candidateFormalSettled = Number(candidateFormal?.settled || 0);
  const candidateFormalRequired = 500;
  const candidateCaptureHeartbeatLabel = candidateCaptureHeartbeat?.fresh
    && candidateCaptureHeartbeat?.ok
    && candidateAdmission?.captureGap !== true
    ? (language === 'zh' ? '在线' : 'Online')
    : (language === 'zh' ? '等待恢复' : 'Awaiting recovery');
  const candidateStateLabel = ({
    SHADOW: language === 'zh' ? '已冻结 · 影子采样' : 'Frozen · shadow',
    ACTIVE: language === 'zh' ? '正式前瞻验证中' : 'Formal prospective',
    PROMOTED: language === 'zh' ? '已通过前瞻复核' : 'Prospective review passed',
    RETIRED: language === 'zh' ? '已封存' : 'Retired',
  } as Record<string, string>)[candidateProspective?.state || 'SHADOW']
    || (language === 'zh' ? '影子采样' : 'Shadow');
  const candidateLogLossLabel = formatModelSignedDecimal(
    candidateProspectiveMetrics?.logLossImprovement
  );
  const candidateBrierLabel = formatModelSignedDecimal(
    candidateProspectiveMetrics?.brierImprovement
  );
  const scorecardHasFormalSample = scorecardPublicAvailable
    && scorecardFormalRows !== null
    && scorecardFormalRows > 0;
  const scorecardComparison = modelScorecard?.marketComparison?.bestShadowCandidate;
  const modelArchitecture = modelEvaluation?.probabilityArchitecture;
  const modelSourcePolicy = modelEvaluation?.sourcePolicy;
  const currentModelComparison = modelScorecard?.marketComparison?.currentModel;
  const modelArchitectureSample = modelArchitecture?.sample;
  const modelHistoricalRows = modelArchitectureSample?.historicalModelRows
    || modelEvaluation?.backtest?.sample?.historicalModelRows;
  const modelArchitectureComparison = modelArchitecture?.comparison;
  const modelEligibleScope = modelGate?.eligibleScope || 'none';
  const modelSignalOnlineEffect = modelGate?.modelSignal?.onlineEffect || 'shadow';
  const modelSignalReady = modelGate?.modelSignal?.readyForGuardedUse === true
    && modelSignalOnlineEffect === 'guarded-active'
    && modelEligibleScope === 'model-signal';
  const modelSignalComparison = modelGate?.modelSignalCandidate?.comparison;
  const modelLooseningAllowed = modelStrategy?.activation?.riskGuard?.looseningAllowed === true;
  const modelCutoverCoverageTarget = modelSourcePolicy?.fullFiveHundredCutover?.minimumCurrentCoverage ?? 0.95;
  const fiveHundredCutoverAllowed = Boolean(
    modelSourcePolicy?.fullFiveHundredCutover?.allowed === true
    && fiveHundredCoverageRatio >= modelCutoverCoverageTarget
    && fiveHundredErrors <= (modelSourcePolicy?.fullFiveHundredCutover?.maxDetailsErrors ?? 0)
  );
  const fiveHundredCutoverLabel = fiveHundredCutoverAllowed
    ? (language === 'zh' ? '可试运行' : 'Pilot ready')
    : (language === 'zh' ? '不建议全切' : 'Hybrid only');
  const topMarketLabel = topMarketBucket?.label?.[language] || topMarketBucket?.id || '--';
  const topLeagueLabel = topLeagueBucket?.label?.[language] || topLeagueBucket?.id || '--';
  const topOddsLabel = topOddsBucket?.label?.[language] || topOddsBucket?.id || '--';
  const modelVersionLabel = modelStrategy?.version
    || modelEvaluation?.backtest?.version
    || modelEvaluation?.calibration?.version
    || '--';
  const modelGeneratedAt = modelStrategy?.generatedAt
    || modelEvaluation?.generatedAt
    || modelEvaluation?.backtest?.generatedAt
    || undefined;
  const modelHealthEvaluation = dataSync.modelHealth?.evaluation;
  const modelCoverageKnown = Boolean(modelHealthEvaluation);
  const modelCoverageOk = modelHealthEvaluation?.ok !== false && modelHealthEvaluation?.coverageOk !== false;
  const modelOddsCoverageText = formatCoveragePercent(modelHealthEvaluation?.odds?.coverageRatio);
  const modelPredictionCoverageText = formatCoveragePercent(modelHealthEvaluation?.predictionSnapshots?.coverageRatio);
  const modelGateTone = (modelCoverageKnown && !modelCoverageOk) || modelRiskTier !== 'stable'
    ? 'is-warning'
    : modelOnlineEffect === 'guarded-active'
    ? 'is-ready'
    : modelGateStatus === 'shadow'
      ? 'is-warning'
      : 'is-neutral';
  const modelGateLabel = modelOnlineEffect === 'guarded-active' && !modelLooseningAllowed
    ? (language === 'zh' ? '仅收紧保护' : 'Tightening only')
    : modelOnlineEffect === 'guarded-active' && modelEligibleScope === 'market-calibration-only'
      ? (language === 'zh' ? '仅市场校准' : 'Market calibration only')
      : modelOnlineEffect === 'guarded-active'
        ? (language === 'zh' ? '灰度生效' : 'Guarded active')
    : modelGateStatus === 'shadow'
      ? (language === 'zh' ? '影子评估' : 'Shadow only')
      : modelGateStatus;
  const modelGateNote = modelGateReasons.length
    ? modelGateReasons.join('; ')
    : !modelLooseningAllowed
      ? (language === 'zh'
        ? '风险档未稳定，线上策略只允许收紧；模型信号继续影子评估'
        : 'Risk is not stable: online rules may only tighten; model signals remain shadowed')
      : modelEligibleScope === 'market-calibration-only'
        ? (language === 'zh'
          ? '当前仅市场校准通过门禁，模型信号尚未上线'
          : 'Only market calibration passed; model signals are not online')
    : (language === 'zh'
      ? '达到 baseline 门槛后才允许影响线上推荐'
      : 'Only promoted after the baseline gate passes');
  const modelGovernanceItems = [
    {
      label: language === 'zh' ? '线上状态' : 'Online mode',
      value: modelGateLabel,
      note: modelGateNote
    },
    {
      label: language === 'zh' ? '基准样本' : 'Baseline rows',
      value: `${modelBaselineRows}/${modelRequiredRows}`,
      note: language === 'zh' ? '按时间窗回测' : 'time-window backtest'
    },
    {
      label: language === 'zh' ? 'HHAD 影子样本' : 'HHAD shadow rows',
      value: `${hhadCompanionRows ?? '--'}/${hhadCompanionRequiredRows}`,
      note: `${hhadCompanionStatusLabel} · ${hhadCompanionMetricNote}`
    },
    {
      label: language === 'zh' ? '仓库覆盖' : 'Warehouse',
      value: modelCoverageKnown
        ? (modelCoverageOk
          ? (language === 'zh' ? '通过' : 'Covered')
          : (language === 'zh' ? '复核' : 'Review'))
        : '--',
      note: modelCoverageKnown
        ? `odds ${modelOddsCoverageText} / snapshots ${modelPredictionCoverageText}`
        : (language === 'zh' ? '等待 health' : 'waiting for health')
    },
    {
      label: language === 'zh' ? '公开评分卡' : 'Scorecard',
      value: scorecardHasFormalSample
        ? (language === 'zh' ? '正式样本可用' : 'Formal sample ready')
        : scorecardPublicAvailable
          ? (language === 'zh' ? '暂无正式样本' : 'No formal sample')
        : '--',
      note: `${scorecardSample?.marketBaselineRows ?? modelBaselineRows} baseline / ${scorecardFormalRows ?? '--'} formal tips`
    },
    {
      label: language === 'zh' ? '玩法表现' : 'Markets',
      value: topMarketBucket ? `${topMarketLabel} ${formatModelPercent(topMarketBucket.metrics?.hitRate)}` : '--',
      note: `${scorecardMarketCount} buckets / ${topMarketBucket?.metrics?.settled ?? 0} settled`
    },
    {
      label: language === 'zh' ? '联赛样本' : 'Leagues',
      value: topLeagueBucket ? `${topLeagueLabel} ${formatModelPercent(topLeagueBucket.metrics?.hitRate)}` : '--',
      note: `${scorecardLeagueCount} groups / ${topLeagueBucket?.metrics?.settled ?? 0} settled`
    },
    {
      label: language === 'zh' ? '赔率区间' : 'Odds bands',
      value: topOddsBucket ? `${topOddsLabel} ${formatModelPercent(topOddsBucket.metrics?.hitRate)}` : '--',
      note: scorecardHasFormalSample
        ? `${scorecardOddsCount} bands / ${scorecardFormalRows} formal tips`
        : (language === 'zh'
          ? '暂无正式推荐样本；影子 LL/Brier 不计入赔率区间表现'
          : 'No formal picks; shadow LL/Brier is excluded from odds-band performance')
    },
    {
      label: language === 'zh' ? '赛前审计' : 'Input audit',
      value: modelInputAuditOk
        ? (language === 'zh' ? '通过' : 'Passed')
        : (language === 'zh' ? '复核' : 'Review'),
      note: `${modelInputAuditViolationCount} violations`
    },
    {
      label: language === 'zh' ? '风险档' : 'Risk tier',
      value: modelRiskLabel,
      note: modelRiskNote
    },
    {
      label: language === 'zh' ? '校准版本' : 'Calibration',
      value: modelEvaluation?.calibration?.version || '--',
      note: modelGeneratedAt ? formatSyncTime(modelGeneratedAt, language) : '--'
    }
  ];

  const probabilityStackItems = [
    {
      label: language === 'zh' ? '市场基准' : 'Market baseline',
      value: `${modelArchitectureSample?.marketBaselineRows ?? scorecardSample?.marketBaselineRows ?? modelBaselineRows} rows`,
      note: language === 'zh' ? '赔率去水后作为最低基准' : 'de-vigged odds benchmark'
    },
    {
      label: 'Elo',
      value: `${modelHistoricalRows?.elo ?? 0} rows`,
      note: language === 'zh' ? '长期强度与主场优势' : 'team strength and home edge'
    },
    {
      label: 'Poisson',
      value: `${modelHistoricalRows?.poisson ?? 0} rows`,
      note: language === 'zh' ? '比分矩阵 / 大小球 / BTTS' : 'score matrix / totals / BTTS'
    },
    {
      label: language === 'zh' ? '集成候选' : 'Ensemble',
      value: modelSignalReady
        ? (language === 'zh' ? '可灰度' : 'guarded')
        : (language === 'zh' ? '影子' : 'shadow'),
      note: `LL ${formatModelSignedDecimal(modelSignalComparison?.logLossImprovement ?? modelGate?.metrics?.bestModelLogLossImprovement)} / Brier ${formatModelSignedDecimal(modelSignalComparison?.brierImprovement ?? modelGate?.metrics?.bestModelBrierImprovement)}`
    },
    {
      label: language === 'zh' ? '当前主模型' : 'Current model',
      value: currentModelComparison
        ? `LL ${formatModelSignedDecimal(currentModelComparison.logLossImprovement)}`
        : '--',
      note: currentModelComparison
        ? `Brier ${formatModelSignedDecimal(currentModelComparison.brierImprovement)} vs market`
        : (language === 'zh' ? '等待 market 对比' : 'waiting for market comparison')
    },
    {
      label: language === 'zh' ? 'LLM 边界' : 'LLM boundary',
      value: language === 'zh' ? '只复核' : 'review only',
      note: language === 'zh' ? '不覆盖概率，不赛后改写' : 'no probability override or post-cutoff rewrite'
    }
  ];
  const sourcePolicyItems = [
    {
      label: language === 'zh' ? '主源' : 'Primary',
      value: modelSourcePolicy?.primary || 'sporttery-relay-snapshot',
      note: language === 'zh' ? '赛程身份 / 官方赔率 / 锁定时间' : 'identity / official odds / cutoff'
    },
    {
      label: '500.com',
      value: fiveHundredFresh ? (language === 'zh' ? '新鲜' : 'fresh') : (language === 'zh' ? '需更新' : 'refresh needed'),
      note: `${fiveHundredCurrentCount}/${sourceCurrentCount} (${fiveHundredCoveragePercent}%) / errors ${fiveHundredErrors}`
    },
    {
      label: language === 'zh' ? '切换结论' : 'Cutover',
      value: fiveHundredCutoverLabel,
      note: modelSourcePolicy?.fullFiveHundredCutover?.reason
        || (language === 'zh' ? '500 暂作补充信号' : '500 remains supplemental')
    },
    {
      label: language === 'zh' ? '发布规则' : 'Publish rule',
      value: language === 'zh' ? '保留可信快照' : 'keep trusted',
      note: language === 'zh' ? '主源异常不发布空数据' : 'never publish empty data on source failure'
    }
  ];

  const dashboardUpdatedAt = formatSyncTime(
    dataSync.sourceUpdatedAt || dataSync.updatedAt || dataSync.lastCheckedAt,
    language
  );
  const publicationTransition = [
    'generation-sqlite-mismatch',
    'generation-pair-refresh',
    'generation-sqlite-replacement',
    'sqlite-previous-pair',
    'previous-generation',
    'generation-previous'
  ].includes(dataSync.healthCurrentReadSource || '')
    && dataSync.currentLoaded
    && dataSync.currentCount > 0;
  const systemRecommendationTone = !recommendationReliable || sourceHealth?.ok === false
    ? 'cautious'
    : dataSync.error || isDataStale || hasSourceFallback || hasSourceTransportIssue
      ? 'cautious'
      : 'reliable';
  const systemRecommendationLabel = systemRecommendationTone === 'cautious'
      ? (publicationTransition
        ? (language === 'zh' ? '数据发布更新中 · 已发推荐保留' : 'Data publication updating · Published picks kept')
        : !recommendationReliable || sourceHealth?.ok === false
        ? (language === 'zh' ? '数据链路警示 · 已发推荐保留' : 'Data pipeline warning · Published picks kept')
        : (language === 'zh' ? '数据链路警示' : 'Data pipeline warning'))
      : (language === 'zh' ? '数据链路正常' : 'Data pipeline healthy');
  const filterLeagueSummary = effectiveSelectedLeagues.length === 0
    ? (language === 'zh' ? '全部联赛' : 'All leagues')
    : effectiveSelectedLeagues.length === 1
      ? (() => {
          const league = availableLeagues.find((item) => item.id === effectiveSelectedLeagues[0]);
          return league ? (league.shortName[language] || league.name[language]) : (language === 'zh' ? '当前联赛' : 'Current league');
        })()
      : (language === 'zh' ? `${effectiveSelectedLeagues.length} 个联赛` : `${effectiveSelectedLeagues.length} leagues`);

  const emptyStateText = isCurrentDataLoading
    ? (language === 'zh'
        ? '数据同步中，正在读取今日赛程与官方赔率。'
        : 'Data is syncing: loading today schedule, official odds, and market snapshots.')
    : isHistoryDateLoading
      ? (language === 'zh'
        ? '历史赛果后台补齐中，完成后将显示该日期的比赛与赛后复盘。'
        : 'Historical results are loading; matches and post-match reviews for this date will appear when ready.')
    : (!dataSync.currentLoaded && dataSync.error) || sourceHealth?.ok === false
      ? (language === 'zh'
        ? '校验状态异常：当前数据源未通过完整性检查，请稍后刷新。'
        : 'Validation issue: the current source did not pass completeness checks. Try again shortly.')
      : baseFilteredMatches.length === 0
        ? (effectiveSelectedDate === todayStr
          ? (language === 'zh' ? '今日暂无开售赛事，数据会继续自动同步。' : 'No on-sale fixtures today. Sync will keep checking.')
          : (language === 'zh' ? '当前日期暂无开售赛事。' : 'No on-sale fixtures for this date.'))
        : isFixturesView
            ? (language === 'zh' ? '当前筛选暂无赛程或官方赔率。' : 'No fixtures or official odds match the current filters.')
            : t('noMatches');

  const pageTitle = isAnalysisView
    ? (language === 'zh' ? '赛前分析' : 'Pre-match Analysis')
    : (language === 'zh' ? '赛程与官方赔率' : 'Fixtures and Official Odds');
  const pageEyebrow = isAnalysisView
    ? (language === 'zh' ? '赛前模型 / 盘口验证' : 'Pre-match model / Market checks')
    : (language === 'zh' ? '竞彩赛程 / 官方赔率' : 'Schedule / Official odds');
  const pageDescription = isAnalysisView
    ? (language === 'zh'
      ? '每场统一标为正式推荐、参考推荐或 WATCH；已有方向直接展示，证据缺口只决定分层，不会清空内容。'
      : 'Every match is labelled Formal, Reference, or WATCH. Existing directions stay visible while evidence gaps determine the tier.')
    : (language === 'zh'
      ? '按日期核对赛程和 HAD/HHAD；所有可用推荐直接标记方向，500数据补充单独注明来源。'
      : 'Review dated fixtures and HAD/HHAD prices. Every available pick shows its direction, with 500.com supplements clearly sourced.');
  const referenceTierCount = recommendationCounts.reference + recommendationCounts.live;
  const directionShownCount = recommendationCounts.home + recommendationCounts.draw + recommendationCounts.away;
  const officialSpCoveragePercent = baseFilteredMatches.length > 0
    ? Math.round((fixtureMarketCounts.covered / baseFilteredMatches.length) * 100)
    : 0;
  const primaryGapText = evidenceGapSummary.items.length > 0
    ? evidenceGapSummary.items.map((item) => `${item.label} ${item.count}`).join(' · ')
    : evidenceGapSummary.auditedMatches > 0
      ? (language === 'zh' ? '未见集中缺口' : 'No concentrated gap')
      : (language === 'zh' ? '缺口诊断待同步' : 'Gap audit pending');
  const headerDataPending = !dataSync.currentLoaded && baseFilteredMatches.length === 0;
  const headerDataRecovering = headerDataPending && Boolean(
    dataSync.error || dataSync.serviceTransitioning || dataSync.lastCheckedAt
  );
  const headerMatchSummary = headerDataPending
    ? (headerDataRecovering
      ? (language === 'zh' ? '赛程恢复中' : 'Schedule recovering')
      : (language === 'zh' ? '赛程加载中' : 'Loading schedule'))
    : `${baseFilteredMatches.length} ${language === 'zh' ? '场赛事' : 'matches'}`;
  const headerSecondarySummary = headerDataPending
    ? (headerDataRecovering
      ? (language === 'zh'
        ? '正在自动重试赛程与推荐数据，不以 0 场作为结论'
        : 'Automatically retrying schedule and recommendation data; zero is not treated as the result')
      : (language === 'zh'
        ? '正在读取赛程、赔率与推荐数据'
        : 'Loading fixtures, odds, and recommendation data'))
    : isAnalysisView
      ? (language === 'zh'
        ? `正式 ${recommendationCounts.formal} / 参考 ${referenceTierCount} / WATCH ${recommendationCounts.unavailable}`
        : `Formal ${recommendationCounts.formal} / Reference ${referenceTierCount} / WATCH ${recommendationCounts.unavailable}`)
      : (language === 'zh'
        ? `官方 SP ${fixtureMarketCounts.covered}/${baseFilteredMatches.length} / 已显示方向 ${directionShownCount}`
        : `Official SP ${fixtureMarketCounts.covered}/${baseFilteredMatches.length} / ${directionShownCount} directions shown`);
  const sourcePanelTone = sourceHealth?.ok === false || Boolean(dataSync.error && !dataSync.currentLoaded)
    ? 'is-warning'
    : 'is-neutral';
  const modelPanelTone = (modelCoverageKnown && !modelCoverageOk)
    || !modelInputAuditOk
    || modelRiskTier === 'degraded'
    ? 'is-warning'
    : 'is-neutral';

  return (
    <div className="predictions-v4 dashboard-stack" data-view-mode={viewMode}>
      <section
        className="dashboard-hero is-compact"
        data-view-mode={viewMode}
        aria-label={isAnalysisView
          ? (language === 'zh' ? '赛前分析' : 'Pre-match analysis')
          : (language === 'zh' ? '赛程与官方赔率' : 'Fixtures and official odds')}
      >
        <PredictionsPageHeader
          eyebrow={pageEyebrow}
          title={pageTitle}
          description={pageDescription}
          updatedLabel={language === 'zh' ? '更新' : 'Updated'}
          updatedAt={dashboardUpdatedAt}
          matchSummary={headerMatchSummary}
          secondarySummary={headerSecondarySummary}
          status={isAnalysisView ? (
            <strong className={`predictions-v4__system-status is-${systemRecommendationTone}`}>
              {systemRecommendationLabel}
            </strong>
          ) : recommendationCounts.formal > 0 ? (
            <strong className="predictions-v4__system-status is-reliable">
              {language === 'zh'
                ? `正式 ${recommendationCounts.formal} · 参考 ${referenceTierCount} · WATCH ${recommendationCounts.unavailable}`
                : `Formal ${recommendationCounts.formal} · Reference ${referenceTierCount} · WATCH ${recommendationCounts.unavailable}`}
            </strong>
          ) : referenceTierCount > 0 ? (
            <strong className="predictions-v4__system-status is-cautious">
              {language === 'zh'
                ? `参考 ${referenceTierCount} · 不计正式战绩`
                : `Reference ${referenceTierCount} · excluded from formal record`}
            </strong>
          ) : recommendationCounts.unavailable > 0 ? (
            <strong className="predictions-v4__system-status is-cautious">
              {language === 'zh'
                ? `WATCH ${recommendationCounts.unavailable} · 等待更多证据`
                : `WATCH ${recommendationCounts.unavailable} · awaiting more evidence`}
            </strong>
          ) : undefined}
          action={!isAnalysisView ? (
            <Link
              className="worldcup-compact-entry"
              to="/predictions"
              aria-label={language === 'zh' ? '前往赛前分析查看结论' : 'Open Pre-match Analysis for conclusions'}
            >
              <ShieldCheck size={17} aria-hidden="true" />
              <span>{language === 'zh' ? '去赛前分析看结论' : 'Open Pre-match Analysis'}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          ) : undefined}
        />
        {!headerDataPending && baseFilteredMatches.length > 0 && (
          <dl
            className="predictions-v4__evidence-snapshot"
            aria-label={language === 'zh' ? '本日推荐与证据摘要' : 'Daily recommendation and evidence summary'}
          >
            <div className="predictions-v4__snapshot-item is-tiers">
              <dt>{language === 'zh' ? '推荐分层' : 'Recommendation tiers'}</dt>
              <dd>
                <span className="is-formal">{language === 'zh' ? '正式' : 'Formal'} {recommendationCounts.formal}</span>
                <span className="is-reference">{language === 'zh' ? '参考' : 'Reference'} {referenceTierCount}</span>
                <span className="is-watch">WATCH {recommendationCounts.unavailable}</span>
              </dd>
              {recommendationCounts.live > 0 && (
                <small>{language === 'zh' ? `参考中含实时 ${recommendationCounts.live}` : `Includes ${recommendationCounts.live} live references`}</small>
              )}
            </div>
            <div className="predictions-v4__snapshot-item is-directions">
              <dt>{language === 'zh' ? '已显示方向' : 'Visible directions'}</dt>
              <dd>
                <span>{language === 'zh' ? '主' : 'H'} {recommendationCounts.home}</span>
                <span>{language === 'zh' ? '平' : 'D'} {recommendationCounts.draw}</span>
                <span>{language === 'zh' ? '客' : 'A'} {recommendationCounts.away}</span>
              </dd>
              <small>{language === 'zh' ? `共 ${directionShownCount} 场` : `${directionShownCount} matches`}</small>
            </div>
            <div className="predictions-v4__snapshot-item is-sp">
              <dt>{language === 'zh' ? '官方 SP 覆盖' : 'Official SP coverage'}</dt>
              <dd><strong>{fixtureMarketCounts.covered}/{baseFilteredMatches.length}</strong></dd>
              <small>{officialSpCoveragePercent}% · HAD {fixtureMarketCounts.had} / HHAD {fixtureMarketCounts.hhad}</small>
            </div>
            <div className="predictions-v4__snapshot-item is-gaps" title={primaryGapText}>
              <dt>{language === 'zh' ? '主要证据缺口' : 'Main evidence gaps'}</dt>
              <dd>{primaryGapText}</dd>
              <small>
                {language === 'zh'
                  ? `已审计 ${evidenceGapSummary.auditedMatches}/${baseFilteredMatches.length} 场`
                  : `Audited ${evidenceGapSummary.auditedMatches}/${baseFilteredMatches.length}`}
              </small>
            </div>
          </dl>
        )}
      </section>

      <section
        className="date-toolbar"
        data-date-scope="sporttery-business-date"
        aria-label={language === 'zh' ? '竞彩业务日筛选' : 'Sporttery business-day filters'}
      >
        <DateScopeBar
          selectedDate={effectiveSelectedDate}
          quickOptions={quickDateOptions.map((option) => ({
            ...option,
            displayDate: formatShortDate(option.date, language)
          }))}
          historyOptions={historyDateOptions.map((option) => ({
            ...option,
            displayDate: formatShortDate(option.date, language)
          }))}
          selectedHistoryDate={selectedHistoryDate}
          historyLabel={language === 'zh' ? '竞彩历史日' : 'Sporttery history days'}
          onSelectDate={handleDateSelect}
        />
        <p className="date-scope-note">
          {language === 'zh'
            ? '按竞彩业务日归档；跨午夜比赛只计入原竞彩日。'
            : 'Grouped by Sporttery business day; after-midnight fixtures remain on their original issue day.'}
        </p>
      </section>

      {baseFilteredMatches.length > 0 && (
        <section
          className="filter-workbench"
          aria-label={language === 'zh' ? '赛事范围、筛选与排序' : 'Fixture scope, filters and sorting'}
        >
        <details className="panel filters-panel filters-details" aria-label={language === 'zh' ? '赛事筛选与排序' : 'Fixture filters and sorting'}>
          <summary className="filters-summary">
            <span>
              <SlidersHorizontal size={16} aria-hidden="true" />
              <strong>{language === 'zh' ? '筛选与排序' : 'Filter and sort'}</strong>
            </span>
            <span>
              {filteredMatches.length} {language === 'zh' ? '场' : 'matches'} · {filterLeagueSummary}
            </span>
          </summary>
          <div className="filters-details-body">
        {availableLeagues.length > 0 && (
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
              aria-pressed={effectiveSelectedLeagues.length === 0}
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
                  aria-pressed={isSelected}
                >
                  <span>{country.flag}</span>
                  <span>{leagueLabel}</span>
                </button>
              );
            })}
          </div>
          </div>
        )}

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
                  aria-pressed={sortBy === option}
                >
                  {t(option)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'))}
              className="sort-order-btn"
              aria-label={sortOrder === 'asc'
                ? (language === 'zh' ? '当前升序，点击切换为降序' : 'Ascending; switch to descending')
                : (language === 'zh' ? '当前降序，点击切换为升序' : 'Descending; switch to ascending')}
              aria-pressed={sortOrder === 'desc'}
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
          </div>
        </details>
        </section>
      )}

      {isAnalysisView && (
        <section
          className="daily-review-panel is-compact is-priority"
          data-formal-performance-version={formalReviewPerformance?.version || ''}
          data-formal-performance-start-date={formalReviewPerformance?.startDate || '2026-08-16'}
          data-formal-cumulative-settled={Number(cumulativeFormalRecord?.settled || 0)}
          data-formal-cumulative-hit-rate={cumulativeFormalRecord?.hitRate ?? ''}
          aria-label={language === 'zh' ? '正式推荐累计命中率' : 'Cumulative formal recommendation hit rate'}
        >
          <div className="daily-review-copy">
            <span className="panel-kicker">{language === 'zh' ? '每日自动更新' : 'Updated daily'}</span>
            <strong>{language === 'zh' ? '正式推荐战绩' : 'Formal Recommendation Record'}</strong>
            <p>
              {language === 'zh'
                ? `自 ${formalReviewPerformance?.startDate || '2026-08-16'} 起，只统计赛前已冻结、赛后由官方赛果结算的正式 BEST 推荐。参考方向、实时方向、待定与作废场次不进入命中率。`
                : `Since ${formalReviewPerformance?.startDate || '2026-08-16'}, this record counts only frozen pre-match formal BEST picks settled by official results. Reference, live, pending, and void rows are excluded.`}
            </p>
          </div>
          <div className="daily-review-stats">
            <span>
              {language === 'zh' ? '累计命中率' : 'Cumulative hit rate'}
              <strong>{formatModelPercent(cumulativeFormalRecord?.hitRate)}</strong>
            </span>
            <span>
              {language === 'zh' ? '累计命中/已结算' : 'Won / settled'}
              <strong>{Number(cumulativeFormalRecord?.won || 0)}/{Number(cumulativeFormalRecord?.settled || 0)}</strong>
            </span>
            <span>
              {language === 'zh' ? `最近更新 ${latestFormalDailyRecord?.date || '--'}` : `Latest ${latestFormalDailyRecord?.date || '--'}`}
              <strong>{formatModelPercent(latestFormalDailyRecord?.hitRate)} ({Number(latestFormalDailyRecord?.won || 0)}/{Number(latestFormalDailyRecord?.settled || 0)})</strong>
            </span>
          </div>
        </section>
      )}

      {(
        effectiveSelectedDate < todayStr
        || dailyReviewStats.finished > 0
        || dailyReviewStats.awaitingOfficial > 0
        || dailyReviewStats.archivedDirections > 0
        || dailyReviewStats.provisionalReferenceSettled > 0
      ) && (
        <section
          className="daily-review-panel is-compact is-priority"
          data-date-scope="sporttery-business-date"
          data-formal-settled={dailyReviewStats.formalSettled}
          data-live-settled={dailyReviewStats.liveSettled}
          data-reference-best-settled={dailyReviewStats.referenceBestSettled}
          data-analysis-settled={dailyReviewStats.analysisSettled}
          data-provisional-reference-settled={dailyReviewStats.provisionalReferenceSettled}
          data-result-phase-fixtures={dailyReviewStats.resultPhaseFixtures}
          data-not-yet-result-phase={dailyReviewStats.notYetResultPhase}
          data-awaiting-official={dailyReviewStats.awaitingOfficial}
          data-archived-directions={dailyReviewStats.archivedDirections}
          data-recorded-directions={reviewDirectionCount}
          data-settlement-phase={officialSettlementNotDue ? 'not-due' : 'result-phase'}
          aria-label={language === 'zh' ? '赛果统计' : 'Result summary'}
        >
          <div className="daily-review-copy">
            <span className="panel-kicker">{formatShortDate(effectiveSelectedDate, language)}</span>
            <strong>{language === 'zh' ? '赛果统计' : 'Result Summary'}</strong>
            <p>
              {officialSettlementNotDue
                ? (language === 'zh'
                  ? `本业务日 ${dailyReviewStats.totalFixtures} 场比赛尚未进入官方完场阶段；赛前方向已记录 ${reviewDirectionCount}/${reviewDirectionDenominator}。跨午夜比赛仍归属原竞彩日，终场后自动结算。`
                  : `${dailyReviewStats.totalFixtures} fixtures have not reached official full time yet; ${reviewDirectionCount}/${reviewDirectionDenominator} pre-match directions are recorded. Cross-midnight fixtures remain on their original Sporttery business date and settle automatically after full time.`)
                : dailyReviewStats.awaitingOfficial > 0
                ? (language === 'zh'
                  ? `本日 ${dailyReviewStats.totalFixtures} 场，已有 ${dailyReviewStats.resultPhaseFixtures} 场进入赛果阶段，原赛前方向归档 ${dailyReviewStats.archivedDirections}/${dailyReviewStats.resultPhaseFixtures}；官方已结算 ${dailyReviewStats.finished} 场，仍有 ${dailyReviewStats.awaitingOfficial} 场等待官方赛果，另有 ${dailyReviewStats.notYetResultPhase} 场尚未到终场。`
                  : `${dailyReviewStats.totalFixtures} fixtures: ${dailyReviewStats.resultPhaseFixtures} have entered the result phase and ${dailyReviewStats.archivedDirections}/${dailyReviewStats.resultPhaseFixtures} original picks are archived; ${dailyReviewStats.finished} are officially settled, ${dailyReviewStats.awaitingOfficial} await official results, and ${dailyReviewStats.notYetResultPhase} have not reached full time.`)
                : (language === 'zh'
                  ? '原赛前方向保持不变；官方竞彩结算与外部赛果参考分开统计，外部比分不会写入正式命中率。'
                  : 'Original pre-match directions remain unchanged. Official settlement and external-result references use separate denominators.')}
            </p>
          </div>
          <div className="daily-review-stats">
            <span>
              {officialSettlementNotDue
                ? (language === 'zh' ? '赛前方向已记录' : 'Pre-match directions recorded')
                : (language === 'zh' ? '全部赛前方向记录' : 'All pre-match directions recorded')}
              <strong>{reviewDirectionCount}/{reviewDirectionDenominator}</strong>
            </span>
            <span>
              {officialSettlementNotDue
                ? (language === 'zh' ? '官方结算状态' : 'Official settlement')
                : (language === 'zh' ? '原赛前方向归档' : 'Original picks archived')}
              <strong>
                {officialSettlementNotDue
                  ? (language === 'zh' ? '未到终场' : 'Not due')
                  : `${dailyReviewStats.archivedDirections}/${dailyReviewStats.resultPhaseFixtures}`}
              </strong>
            </span>
            {!officialSettlementNotDue && (
              <span>
                {language === 'zh' ? '待官方赛果' : 'Awaiting official result'}
                <strong>{dailyReviewStats.awaitingOfficial}</strong>
              </span>
            )}
            <span>
              {language === 'zh'
                ? `正式推荐（${dailyReviewStats.formalWon}/${dailyReviewStats.formalSettled}）`
                : `Formal picks (${dailyReviewStats.formalWon}/${dailyReviewStats.formalSettled})`}
              <strong>{formatDailyRate(dailyReviewStats.formalHitRate, language)}</strong>
            </span>
            <span>
              {language === 'zh'
                ? `实时推荐（${dailyReviewStats.liveWon}/${dailyReviewStats.liveSettled}）`
                : `Live picks (${dailyReviewStats.liveWon}/${dailyReviewStats.liveSettled})`}
              <strong>{formatDailyRate(dailyReviewStats.liveHitRate, language)}</strong>
            </span>
            <span>
              {language === 'zh'
                ? `数据推荐 BEST（${dailyReviewStats.referenceBestWon}/${dailyReviewStats.referenceBestSettled}）`
                : `Data-pick BEST (${dailyReviewStats.referenceBestWon}/${dailyReviewStats.referenceBestSettled})`}
              <strong>{formatDailyRate(dailyReviewStats.referenceBestHitRate, language)}</strong>
            </span>
            <span>
              {language === 'zh'
                ? `全部分析项（${dailyReviewStats.analysisWon}/${dailyReviewStats.analysisSettled}）`
                : `All analysis rows (${dailyReviewStats.analysisWon}/${dailyReviewStats.analysisSettled})`}
              <strong>{formatDailyRate(dailyReviewStats.analysisHitRate, language)}</strong>
            </span>
            <span>
              {language === 'zh'
                ? `外部赛果影子参考（${dailyReviewStats.provisionalReferenceWon}/${dailyReviewStats.provisionalReferenceSettled}）`
                : `External-result shadow reference (${dailyReviewStats.provisionalReferenceWon}/${dailyReviewStats.provisionalReferenceSettled})`}
              <strong>{formatDailyRate(dailyReviewStats.provisionalReferenceHitRate, language)}</strong>
            </span>
            <span>
              {language === 'zh' ? '官方已完场' : 'Officially finished'}
              <strong>{dailyReviewStats.finished}</strong>
            </span>
          </div>
        </section>
      )}

      {groupedMatches.length === 0 ? (
        <section className="empty-state" role="status" aria-live="polite" aria-atomic="true">
          <div>
            <CalendarDays size={40} />
            <p>{emptyStateText}</p>
          </div>
        </section>
      ) : (
        <section
          ref={matchListRef}
          className="league-stack"
          aria-label={isAnalysisView ? 'Match analysis' : 'Fixture schedule and official odds'}
        >
          {groupedMatches.map((group) => (
            <section key={`${group.country.id}_${group.league.id}`} className="league-card">
              <header className="league-header">
                <div className="league-title">
                  <span>{group.country.flag}</span>
                  <h2>{group.league.name[language]}</h2>
                  <span className="league-meta">{group.country.name[language]}</span>
                </div>
                <span className="league-count">
                  {group.matches.length} {t('leagueMatches')}
                </span>
              </header>

              <div className={`predictions-v4__match-list is-${viewMode}-view`}>
                {group.matches.map((match) => {
                  const homeTeam = getMatchDisplayTeam(match, 'home');
                  const awayTeam = getMatchDisplayTeam(match, 'away');
                  const isLive = match.status === 'LIVE';
                  const isFinished = match.status === 'FINISHED';
                  const isPendingResult = match.status === 'PENDING_RESULT';
                  const provisionalArchivedOutcome = getProvisionalArchivedOutcome(match, nowMs);
                  const isVoid = match.resultDisposition === 'VOID';
                  const kickoffAt = Date.parse(match.kickoffTime || '');
                  const isPastScheduled = match.status === 'SCHEDULED'
                    && Number.isFinite(kickoffAt)
                    && kickoffAt <= nowMs;
                  const hasScore = hasOfficialScore(match);
                  const score = hasScore ? `${match.scoreHome}:${match.scoreAway}` : '--:--';
                  const liveScore = buildLiveScorePresentation(match, language, nowMs);
                  const formattedTime = getRowKickoffLabel(match, language);
                  const crossDayKickoffLabel = getCrossDayKickoffLabel(match, language);
                  const poolRows = isFixturesView
                    ? getSportteryPoolRows(match, language).filter((row) => row.odds)
                    : getHomePageOddsRows(match, language);
                  const alignedPoolRows = getAlignedSportteryPoolRows(poolRows, match, language);
                  const oddsFallback = isAnalysisView && poolRows.length === 0
                    ? getHomePageOddsFallback(match, language)
                    : null;
                  const publishedRecommendation = isVoid
                    ? null
                    : getOnSaleDisplayRecommendation(match, language, nowMs) || getLiveDisplayRecommendation(match, language);
                  const marketSelection = getListMarketSelection(
                    match,
                    language,
                    publishedRecommendation,
                    nowMs,
                    true
                  );
                  // Keep the compact fixture table on the same dual-market
                  // projection as the detail page. The primary HAD direction
                  // and the independently bound HHAD companion are different
                  // markets, so both must be labelled instead of leaving the
                  // HHAD row looking like an unrelated odds-only opinion.
                  const handicapSupplement = !isVoid
                    && !isFinished
                    && !isPendingResult
                    && !isPastScheduled
                    && Boolean(publishedRecommendation || marketSelection)
                    && marketSelection?.poolCode !== 'HHAD'
                    ? publishedRecommendation?.companion
                      || getAnalysisReferenceHandicapSupplement(
                        match,
                        language,
                        publishedRecommendation?.prediction || marketSelection?.prediction,
                        marketSelection?.referenceSource
                      )
                    : null;
                  const handicapMarketSelection: ListMarketSelection | null = handicapSupplement
                    && isResultTipCode(handicapSupplement.tipCode)
                    ? {
                        poolCode: 'HHAD',
                        tipCode: handicapSupplement.tipCode,
                        // HHAD is still a separately tracked companion/reference
                        // lane; displaying it must not upgrade it to a formal pick.
                        tone: 'analysis'
                      }
                    : null;
                  const currentSelectedPoolRow = marketSelection && isResultPoolCode(marketSelection.poolCode)
                    ? alignedPoolRows.find((row) => row.poolCode === marketSelection.poolCode)
                    : undefined;
                  const publishedHhadLineMatches = marketSelection?.referenceSource !== 'published-reference'
                    || marketSelection.poolCode !== 'HHAD'
                    || sameHandicapLine(
                      marketSelection.prediction?.handicapLine,
                      getOfficialMatchOdds(match).hhad?.handicap
                    );
                  const selectedOutcomeLabel = marketSelection
                    ? getPoolOutcomeLabel(marketSelection.poolCode, marketSelection.tipCode, language)
                    : '';
                  const selectedLineLabel = marketSelection?.poolCode === 'HHAD'
                    ? (marketSelection.referenceSource === 'published-reference'
                      && String(marketSelection.prediction?.handicapLine ?? '').trim()
                      ? `${language === 'zh' ? '主队' : 'Home'} ${String(marketSelection.prediction?.handicapLine).trim()}`
                      : currentSelectedPoolRow?.handicap
                        ? `${language === 'zh' ? '主队' : 'Home'} ${currentSelectedPoolRow.handicap}`
                      : '')
                    : '';
                  const selectedMarketCodeLabel = marketSelection?.poolCode === 'MODEL_ONLY_1X2'
                    ? (language === 'zh' ? '模型 1X2' : 'Model 1X2')
                    : marketSelection?.poolCode;
                  const marketSelectionSummary = marketSelection
                    ? [selectedMarketCodeLabel, selectedLineLabel, selectedOutcomeLabel].filter(Boolean).join(' ')
                    : '';
                  const publishedIdentityNotice = marketSelection?.referenceSource === 'published-reference'
                    ? marketSelection.poolCode === 'MODEL_ONLY_1X2'
                      ? `${language === 'zh' ? '模型 1X2' : 'Model 1X2'} · ${selectedOutcomeLabel} · SP --`
                      : marketSelection.poolCode === 'HHAD' && !publishedHhadLineMatches
                        ? `${marketSelectionSummary} · SP --`
                        : ''
                    : '';
                  const handicapPoolRow = handicapMarketSelection
                    ? alignedPoolRows.find((row) => row.poolCode === 'HHAD')
                    : undefined;
                  const handicapSelectionSummary = handicapMarketSelection
                    ? [
                        'HHAD',
                        handicapPoolRow?.handicap
                          ? `${language === 'zh' ? '主队' : 'Home'} ${handicapPoolRow.handicap}`
                          : '',
                        getPoolOutcomeLabel('HHAD', handicapMarketSelection.tipCode, language)
                      ].filter(Boolean).join(' ')
                    : '';
                  const dualMarketSelectionSummary = [marketSelectionSummary, handicapSelectionSummary]
                    .filter(Boolean)
                    .join(language === 'zh' ? '；' : '; ');
                  const fiveHundredMarketPresentation = isAnalysisView
                    ? buildFiveHundredMarketReferencePresentation(match, nowMs)
                    : null;
                  const matchEventKey = getMatchEventKey(match);
                  const hasMarketConflict = Boolean(
                    isAnalysisView
                    && !isFinished
                    && marketSelection?.tone !== 'recommendation'
                    && hasCrossMarketDirectionConflict(match)
                  );
                  const sportteryMeta = getSportteryMeta(match);
                  const isArchived = isFinished || isPendingResult || isPastScheduled;
                  const rowTone: 'formal' | 'analysis' | 'archive' | 'fixture' = isArchived
                    ? 'archive'
                    : marketSelection?.tone === 'recommendation'
                      ? 'formal'
                      : isAnalysisView ? 'analysis' : 'fixture';

                  return (
                    <MatchSummaryRow
                      key={matchEventKey}
                      eventKey={matchEventKey}
                      tone={rowTone}
                      isAnalysisView={isAnalysisView}
                      timeLabel={t('statusTime')}
                      teamsLabel={t('teams')}
                      oddsLabel={t('oddsHeader')}
                      decisionLabel={language === 'zh' ? '推荐结论' : 'Recommendation'}
                      detailsLabel={t('details')}
                      detailsAriaLabel={language === 'zh'
                        ? `查看${homeTeam.name[language]}对阵${awayTeam.name[language]}的分析详情`
                        : `View analysis for ${homeTeam.name[language]} vs ${awayTeam.name[language]}`}
                      onOpen={() => onSelectMatch(match.id)}
                      time={(
                        <div className="time-stack">
                          {isVoid ? (
                            <span className="badge">
                              {language === 'zh' ? '已取消 / 退款' : 'Void / refunded'}
                            </span>
                          ) : isPendingResult ? (
                            <span className="badge">
                              {provisionalArchivedOutcome
                                ? (language === 'zh'
                                  ? `外部赛果 ${provisionalArchivedOutcome.scoreText} · 待官方确认`
                                  : `External ${provisionalArchivedOutcome.scoreText} · awaiting official`)
                                : t('awaitingResult')}
                            </span>
                          ) : isPastScheduled ? (
                            <span className="badge">
                              {minutesSinceKickoff(match, nowMs) >= 130 ? t('awaitingResult') : t('statusSyncPending')}
                            </span>
                          ) : isLive ? (
                            <div
                              className={`live-score-card is-${liveScore.freshness}`}
                              data-live-score-settlement-eligible="false"
                              aria-label={language === 'zh'
                                ? `${liveScore.phaseLabel}，比分 ${liveScore.scoreText}，${liveScore.updatedLabel}`
                                : `${liveScore.phaseLabel}, score ${liveScore.scoreText}, ${liveScore.updatedLabel}`}
                            >
                              <span className="live-score-card__state">
                                <i aria-hidden="true" />
                                {liveScore.clockLabel || liveScore.phaseLabel}
                              </span>
                              <strong>{liveScore.scoreText}</strong>
                              <small>{liveScore.hasScore ? liveScore.updatedLabel : t('liveScorePending')}</small>
                              <small>{language === 'zh' ? `来源：${liveScore.sourceLabel}` : `Source: ${liveScore.sourceLabel}`}</small>
                            </div>
                          ) : isFinished ? (
                            <span className="badge">{t('finished')} {score}</span>
                          ) : (
                            <>
                              <span className="kickoff-time">{formattedTime}</span>
                              <span className="status-note">{t('pending')}</span>
                            </>
                          )}
                          {crossDayKickoffLabel && (isPendingResult || isPastScheduled || isLive || isFinished) && (
                            <span className="status-note is-muted">{crossDayKickoffLabel}</span>
                          )}
                          {sportteryMeta && (
                            <span className="status-note is-muted">{sportteryMeta}</span>
                          )}
                        </div>
                      )}
                      teams={(
                        <div className="team-stack">
                          <div className="team-line">
                            <TeamBadge team={homeTeam} size="sm" />
                            <span className="team-name">{homeTeam.name[language]}</span>
                          </div>
                          <div className="team-line">
                            <TeamBadge team={awayTeam} size="sm" />
                            <span className="team-name">{awayTeam.name[language]}</span>
                          </div>
                        </div>
                      )}
                      odds={(
                        <div
                          className={`sporttery-pool-stack ${hasMarketConflict ? 'has-market-conflict' : ''}`}
                          data-selection-tone={marketSelection?.tone || 'none'}
                          data-hhad-selection-tone={handicapMarketSelection?.tone || 'none'}
                        >
                          <div
                            className="sporttery-pool-table"
                            role="table"
                            aria-label={language === 'zh'
                              ? (isFixturesView ? 'HAD 与 HHAD 官方赔率对照' : 'HAD 与 HHAD 赔率对照')
                              : (isFixturesView ? 'Official HAD and HHAD odds comparison' : 'HAD and HHAD odds comparison')}
                          >
                            <div className="sporttery-pool-head" role="row">
                              <span role="columnheader">{language === 'zh' ? '玩法 / 盘口' : 'Market / line'}</span>
                              <span role="columnheader">{language === 'zh' ? '主队' : 'Home'}</span>
                              <span role="columnheader">{language === 'zh' ? '平局' : 'Draw'}</span>
                              <span role="columnheader">{language === 'zh' ? '客队' : 'Away'}</span>
                              <span role="columnheader">{language === 'zh' ? '市场隐含概率（去水）' : 'Market implied (de-vigged)'}</span>
                            </div>
                            {alignedPoolRows.map((row) => {
                              const rowSelection = marketSelection?.poolCode === row.poolCode
                                && (
                                  marketSelection.referenceSource !== 'published-reference'
                                  || row.poolCode !== 'HHAD'
                                  || (
                                    publishedHhadLineMatches
                                    && sameHandicapLine(
                                      marketSelection.prediction?.handicapLine,
                                      row.handicap
                                    )
                                  )
                                )
                                ? marketSelection
                                : handicapMarketSelection?.poolCode === row.poolCode
                                  ? handicapMarketSelection
                                  : null;
                              const isSelectedMarket = Boolean(rowSelection);
                              const selectionTone = rowSelection?.tone || null;
                              const rowOutcomeLabel = rowSelection
                                ? getPoolOutcomeLabel(row.poolCode, rowSelection.tipCode, language)
                                : '';
                              const marketName = row.poolCode === 'HAD'
                                ? (language === 'zh' ? '胜平负' : '1X2')
                                : (language === 'zh' ? '让球胜平负' : 'Handicap Result');
                              const lineLabel = row.poolCode === 'HHAD'
                                ? (row.handicap
                                  ? `${language === 'zh' ? '主队' : 'Home'} ${row.handicap}`
                                  : (language === 'zh' ? '让球数待定' : 'Line pending'))
                                : (language === 'zh' ? '不让球' : 'No handicap');
                              const outcomeOdds = row.odds ? [
                                { code: '1' as ResultTipCode, value: row.odds.odds1 },
                                { code: 'X' as ResultTipCode, value: row.odds.oddsX },
                                { code: '2' as ResultTipCode, value: row.odds.odds2 }
                              ] : [];
                              const rowStateLabel = isSelectedMarket && selectionTone
                                ? `${row.poolCode === 'HHAD'
                                  ? (language === 'zh' ? '让球参考推荐' : 'HHAD reference pick')
                                  : getSelectionTierLabel(selectionTone, language)} · ${rowOutcomeLabel}`
                                : isFixturesView
                                  ? (language === 'zh' ? '官方赔率对照' : 'Official odds comparison')
                                  : (language === 'zh' ? '赔率对照，非当前结论玩法' : 'Odds comparison, not the selected market');
                              const referenceSourceLabel = getReferenceOddsSourceLabel(row.source, language);

                              return (
                                <div
                                  key={row.poolCode}
                                  role="row"
                                  aria-label={`${row.poolCode} ${marketName}，${lineLabel}，${rowStateLabel}`}
                                  className={`sporttery-pool-row ${row.odds ? '' : 'is-closed'} ${isSelectedMarket ? 'is-selected-market' : 'is-unselected-market'}`}
                                >
                                  <span className="pool-line" role="rowheader">
                                    <b className="pool-code">{row.poolCode}</b>
                                    <span className="pool-name">{marketName}</span>
                                    {referenceSourceLabel && (
                                      <em className="pool-source-tag">{referenceSourceLabel}</em>
                                    )}
                                    <small>{lineLabel}</small>
                                    {selectionTone && (
                                      <em className={`pool-market-state is-${selectionTone}`}>
                                        {rowStateLabel}
                                      </em>
                                    )}
                                  </span>
                                  {row.odds ? (
                                    <>
                                      {outcomeOdds.map((outcome) => {
                                        const outcomeLabel = getPoolOutcomeLabel(row.poolCode, outcome.code, language);
                                        const isSelectedOutcome = isSelectedMarket && rowSelection?.tipCode === outcome.code;
                                        const selectedLabel = selectionTone
                                          ? (row.poolCode === 'HHAD'
                                            ? (language === 'zh' ? '让球参考推荐' : 'HHAD reference pick')
                                            : getSelectionTierLabel(selectionTone, language))
                                          : '';

                                        return (
                                          <span
                                            key={outcome.code}
                                            role="cell"
                                            className={`pool-odd ${isSelectedOutcome ? `is-selected is-${selectionTone}` : ''}`}
                                            aria-label={`${outcomeLabel}，SP ${outcome.value.toFixed(2)}${isSelectedOutcome ? `，${selectedLabel}` : ''}`}
                                          >
                                            <small>{outcomeLabel}</small>
                                            <strong>{outcome.value.toFixed(2)}</strong>
                                            {isSelectedOutcome && selectionTone && (
                                              <em>{getSelectionTierMarkerLabel(selectionTone, language)}</em>
                                            )}
                                          </span>
                                        );
                                      })}
                                      <span
                                        className="pool-prob"
                                        role="cell"
                                        title={row.probabilities
                                          ? `${language === 'zh' ? '市场隐含概率（去水）' : 'Market implied probability (de-vigged)'}: ${row.probabilities.home}% / ${row.probabilities.draw}% / ${row.probabilities.away}%`
                                          : undefined}
                                      >
                                        {row.probabilities
                                          ? `${language === 'zh' ? '市场隐含 · 主' : 'Market implied · H'}${row.probabilities.home}% / ${language === 'zh' ? '平' : 'D'}${row.probabilities.draw}% / ${language === 'zh' ? '客' : 'A'}${row.probabilities.away}%`
                                          : '--'}
                                      </span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="pool-closed" role="cell">{isFinished ? t('archivedOdds') : t('closed')}</span>
                                      <span role="cell">--</span>
                                      <span role="cell">--</span>
                                      <span role="cell">--</span>
                                    </>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {oddsFallback && (
                            <div className="odds-sp-fallback">
                              <span>{oddsFallback.label}</span>
                              <strong>{oddsFallback.odds.toFixed(2)}</strong>
                              <em>{oddsFallback.marketLabel} · {oddsFallback.tipLabel}</em>
                            </div>
                          )}
                          {publishedIdentityNotice && (
                            <p className="sporttery-pool-note is-published-identity">
                              {publishedIdentityNotice}
                            </p>
                          )}
                          <p className="sporttery-pool-note">
                            {isFixturesView
                              ? (language === 'zh'
                                ? (publishedRecommendation
                                  ? `正式推荐：${dualMarketSelectionSummary || '方向已发布'}；完整证据请进入赛前分析`
                                  : marketSelection?.tone === 'archive'
                                    ? `原赛前归档推荐：${marketSelectionSummary}；方向、盘口和 SP 不会在赛后改写`
                                  : marketSelection?.tone === 'analysis'
                                    ? `数据推荐：${dualMarketSelectionSummary || marketSelectionSummary}；来源与正式战绩分轨，完整证据请进入赛前分析`
                                    : '本场暂未形成可靠推荐，仅对照 HAD/HHAD 与让球线')
                                : (publishedRecommendation
                                  ? `Official pick: ${dualMarketSelectionSummary || 'direction published'}; open Pre-match Analysis for full evidence`
                                  : marketSelection?.tone === 'archive'
                                    ? `Original pre-match archive: ${marketSelectionSummary}; direction, line and SP cannot be rewritten after kickoff`
                                  : marketSelection?.tone === 'analysis'
                                    ? `Data pick: ${dualMarketSelectionSummary || marketSelectionSummary}; tracked separately from the formal hit rate and parlays`
                                    : 'No reliable pick yet; HAD/HHAD prices and lines are shown for reference'))
                              : (language === 'zh'
                                ? (fiveHundredMarketPresentation
                                  ? '当前方向按500 HAD去水后市场首位生成；属于500数据补充推荐，与正式模型推荐分轨统计'
                                  : poolRows.some((row) => getReferenceOddsSourceLabel(row.source, language))
                                  ? '500/外部 SP 仅作赔率对照；模型方向不按最低 SP 自动选择'
                                  : 'SP 仅为赔率；不按最低 SP 选择方向')
                                : (fiveHundredMarketPresentation
                                  ? 'This direction is the de-vigged 500.com HAD market leader; it is a non-official market reference, not a model or formal pick'
                                  : poolRows.some((row) => getReferenceOddsSourceLabel(row.source, language))
                                  ? '500/external SP is for price comparison only; model directions never auto-pick the lowest price'
                                  : 'SP is price only; the lowest SP is not auto-selected'))}
                          </p>
                        </div>
                      )}
                      decision={isAnalysisView || isFixturesView || isArchived
                        ? renderDecisionCell(match, publishedRecommendation)
                        : undefined}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </section>
      )}
      {isAnalysisView && (
        <section
          className={`benchmark-audit-panel ${hitRateAuditSampleReady ? 'is-ready' : 'is-collecting'}`}
          data-testid="benchmark-hit-rate-audit"
          data-sample-track="publication-ledger"
          data-audit-version={hitRateAudit?.version || ''}
          data-audit-status={hitRateAudit?.status || 'collecting'}
          data-audit-settled={hitRateAuditSettled}
          data-audit-required={hitRateAuditRequiredRows}
          data-audit-target={hitRateAuditTarget}
          data-audit-external-claim={hitRateAudit?.externalBenchmark?.verificationStatus || 'unverified-external-claim'}
          data-clv-version={hitRateClvAudit?.version || ''}
          data-clv-timing-version={hitRateClvAudit?.timingAudit?.version || ''}
          data-clv-eligible-rows={hitRateClvRows}
          data-clv-candidate-rows={hitRateClvCandidateRows}
          data-clv-timing-coverage={Number.isFinite(hitRateClvCoverage) ? hitRateClvCoverage : ''}
          aria-label={language === 'zh' ? '80% 对标命中率审计' : '80% benchmark hit-rate audit'}
        >
          <div className="benchmark-audit-panel__intro">
            <span className="panel-kicker">{language === 'zh' ? '可信对标' : 'Trust benchmark'}</span>
            <strong>{language === 'zh' ? '80% 只作为待验证目标，不作为当前成绩' : '80% is a target to verify, not a current result'}</strong>
            <p>
              {language === 'zh'
                ? '只统计赛前冻结、写入不可变发布账本且已结算的正式推荐；实时推荐、500 数据推荐和普通分析方向全部排除。'
                : 'Only pre-match frozen, immutable-ledger formal picks with settled results count. Live, 500.com data picks and analysis directions are excluded.'}
            </p>
          </div>
          <div className="benchmark-audit-panel__metrics">
            <span>
              {language === 'zh' ? '客户正式发布结算' : 'Customer-published settlements'}
              <strong>{hitRateAuditSettled}/{hitRateAuditRequiredRows}</strong>
            </span>
            <span>
              {language === 'zh' ? '已验证命中率' : 'Verified hit rate'}
              <strong>{hitRateAuditRateLabel}</strong>
            </span>
            <span>
              {language === 'zh' ? '95% 置信区间' : '95% interval'}
              <strong>{hitRateAuditIntervalLabel}</strong>
            </span>
            <span>
              {language === 'zh' ? '审计状态' : 'Audit status'}
              <strong>{hitRateAuditStatusLabel}</strong>
            </span>
            <span>
              {language === 'zh' ? '收盘时点有效覆盖' : 'Valid closing-time coverage'}
              <strong>{hitRateClvSampleLabel}</strong>
            </span>
          </div>
          <p
            className="benchmark-audit-panel__ledger-note"
            data-testid="benchmark-ledger-separation-note"
          >
            {language === 'zh'
              ? `独立账本说明：客户正式发布结算（${hitRateAuditSettled}）只统计已发布给客户的正式推荐；候选前瞻对标结算（${candidateFormalSettled}）仅用于候选 Brier / Log Loss 复核，不计入正式命中率。`
              : `Independent ledgers: customer-published settlements (${hitRateAuditSettled}) count only formal picks published to customers; candidate prospective benchmark settlements (${candidateFormalSettled}) are used only for candidate Brier / Log Loss review and never enter the formal hit rate.`}
          </p>
          <div
            className="benchmark-audit-panel__shadow"
            data-testid="benchmark-shadow-track"
            data-policy-version={benchmarkShadow?.version || ''}
            data-policy-status={benchmarkShadow?.status || 'collecting'}
            data-selected-rows={benchmarkShadowSettled}
            data-required-rows={benchmarkShadowRequired}
            data-activated-at={benchmarkShadow?.activatedAt || ''}
            data-research-rows={benchmarkResearchSettled}
            data-research-source={benchmarkShadow?.research?.source || ''}
            data-research-snapshot-version={benchmarkShadow?.research?.snapshotVersion || ''}
            data-research-snapshot-hash={benchmarkShadow?.research?.snapshotRowsSha256 || ''}
            data-prospective-events={benchmarkProspective?.eventCount || 0}
            data-ledger-root={benchmarkProspective?.rootHash || ''}
            data-ledger-chain-valid={benchmarkProspective?.chainValid === true ? 'true' : 'false'}
            data-heartbeat-fresh={benchmarkCaptureHeartbeat?.fresh === true ? 'true' : 'false'}
            data-time-integrity-coverage={benchmarkTimeIntegrityCoverage}
          >
            <div>
              <span className="panel-kicker">
                {language === 'zh' ? '对标精选 · 前瞻影子账本' : 'Benchmark Selective · Prospective ledger'}
              </span>
              <strong>
                {language === 'zh'
                  ? 'HAD主推 · 证据分≥60 · SP 1.20–1.85'
                  : 'HAD main picks · evidence ≥60 · SP 1.20–1.85'}
              </strong>
              <p>
                {language === 'zh'
                  ? `全部比赛仍保留推荐；本账本只接收 ${benchmarkShadow?.activatedAt ? new Date(benchmarkShadow.activatedAt).toLocaleString('zh-CN') : '策略上线'} 后首次观察到的严格赛前快照，回溯样本与前瞻成绩分开。`
                  : `All matches keep a pick. This ledger accepts only strictly pre-match snapshots first observed after ${benchmarkShadow?.activatedAt || 'policy activation'}; retrospective and prospective records stay separate.`}
              </p>
              <small className="candidate-ledger-heartbeat">
                {language === 'zh'
                  ? `前瞻截止心跳：${benchmarkCaptureHeartbeatLabel} · 每 ${Number(benchmarkCaptureHeartbeat?.intervalSeconds || 30)} 秒 · 最近检查 ${benchmarkCaptureHeartbeat?.evaluatedAt ? formatSyncTime(benchmarkCaptureHeartbeat.evaluatedAt, language) : '--'}`
                  : `Prospective cutoff heartbeat: ${benchmarkCaptureHeartbeatLabel} · every ${Number(benchmarkCaptureHeartbeat?.intervalSeconds || 30)}s · checked ${benchmarkCaptureHeartbeat?.evaluatedAt ? formatSyncTime(benchmarkCaptureHeartbeat.evaluatedAt, language) : '--'}`}
              </small>
            </div>
            <div className="benchmark-audit-panel__shadow-metrics">
              <span>
                {language === 'zh' ? '回溯留出' : 'Research holdout'}
                <strong>{benchmarkResearchWon}/{benchmarkResearchSettled}</strong>
                <small>{language === 'zh' ? '回溯研究，仅作研究证据' : 'Retrospective research only'}</small>
              </span>
              <span>
                {language === 'zh' ? '前瞻命中率' : 'Prospective hit rate'}
                <strong>{benchmarkShadowRateLabel}</strong>
                <small>
                  {benchmarkShadowSettled}/{benchmarkShadowRequired}
                  {language === 'zh' ? ' 前瞻已结算，不计正式成绩' : ' prospective settled; excluded from formal record'}
                </small>
              </span>
              <span>
                {language === 'zh' ? '95%区间' : '95% interval'}
                <strong>{benchmarkShadowIntervalLabel}</strong>
                <small>{benchmarkShadowWalkForward?.foldCount || 0}/{benchmarkShadow?.minimumChronologicalFolds || 6} 时间窗口</small>
              </span>
              <span>
                {language === 'zh' ? '平注ROI' : 'Flat ROI'}
                <strong>{benchmarkShadowRoiLabel}</strong>
                <small>{benchmarkShadow?.promotionReviewReady ? '已进入晋级复核' : '继续采集'}</small>
              </span>
              <span>
                {language === 'zh' ? '开球时钟证据' : 'Kickoff clock evidence'}
                <strong>{benchmarkTimeIntegrityLabel}</strong>
                <small>
                  {benchmarkTimeIntegrityRows}/{Number(benchmarkProspective?.cohort?.settled || 0)}
                  {language === 'zh' ? ' 场；低于95%禁止晋级' : ' rows; below 95% blocks review'}
                </small>
              </span>
            </div>
          </div>
          {candidateProspective && (
            <div
              className="benchmark-audit-panel__shadow"
              data-testid="candidate-prospective-ledger"
              data-sample-track="candidate-prospective-ledger"
              data-state={candidateProspective.state || 'SHADOW'}
              data-chain-valid={candidateProspective.chainValid === true ? 'true' : 'false'}
              data-formal-finalized={candidateFormalFinalized}
              data-formal-settled={candidateFormalSettled}
              data-formal-required={candidateFormalRequired}
              data-shadow-universe={Number(candidateShadow?.universe || 0)}
              data-ledger-root={candidateProspective.rootHash || ''}
              data-gate-spec-hash={candidateProspective.gateSpecHash || ''}
              data-heartbeat-fresh={candidateCaptureHeartbeat?.fresh === true ? 'true' : 'false'}
              data-admitted={Number(candidateAdmission?.admitted || 0)}
              data-pending-deadline={Number(candidateAdmission?.pendingDeadline || 0)}
              data-due-unrecorded={Number(candidateAdmission?.dueUnrecorded || 0)}
            >
              <div>
                <span className="panel-kicker">
                  {language === 'zh' ? '候选冻结 · 前瞻确认账本' : 'Frozen candidate · Prospective confirmation'}
                </span>
                <strong>{candidateStateLabel}</strong>
                <p>
                  {language === 'zh'
                    ? '候选参数、实现代码和依赖锁已绑定哈希。冻结前与激活前样本只作观察；只有激活后的官方同场赔率样本进入晋级分母，500补充推荐继续展示但不混入。'
                    : 'Parameters, implementation code and dependency lock are hash-bound. Pre-freeze and pre-activation rows are observational only; only post-activation official same-decision odds enter promotion.'}
                </p>
                <small className="candidate-ledger-heartbeat">
                  {language === 'zh'
                    ? `截止点心跳：${candidateCaptureHeartbeatLabel} · 每 ${Number(candidateCaptureHeartbeat?.intervalSeconds || 30)} 秒 · 已入账 ${Number(candidateAdmission?.admitted || 0)} · 等截止 ${Number(candidateAdmission?.pendingDeadline || 0)} · 到点漏账 ${Number(candidateAdmission?.dueUnrecorded || 0)} · 最近检查 ${candidateCaptureHeartbeat?.evaluatedAt ? formatSyncTime(candidateCaptureHeartbeat.evaluatedAt, language) : '--'}`
                    : `Cutoff heartbeat: ${candidateCaptureHeartbeatLabel} · every ${Number(candidateCaptureHeartbeat?.intervalSeconds || 30)}s · admitted ${Number(candidateAdmission?.admitted || 0)} · awaiting cutoff ${Number(candidateAdmission?.pendingDeadline || 0)} · due unrecorded ${Number(candidateAdmission?.dueUnrecorded || 0)} · checked ${candidateCaptureHeartbeat?.evaluatedAt ? formatSyncTime(candidateCaptureHeartbeat.evaluatedAt, language) : '--'}`}
                </small>
              </div>
              <div className="benchmark-audit-panel__shadow-metrics">
                <span>
                  {language === 'zh' ? '影子样本' : 'Shadow universe'}
                  <strong>{Number(candidateShadow?.universe || 0)}</strong>
                  <small>{language === 'zh' ? '永不计入正式晋级分母' : 'never enters formal promotion'}</small>
                </span>
                <span>
                  {language === 'zh' ? '候选前瞻对标结算' : 'Candidate prospective benchmark settlements'}
                  <strong>{candidateFormalSettled}/{candidateFormalRequired}</strong>
                  <small>
                    {language === 'zh'
                      ? `${Number(candidateFormal?.pending || 0)} 待结算 / ${Number(candidateFormal?.invalid || 0)} 无效 / ${candidateFormalFinalized} 已定案`
                      : `${Number(candidateFormal?.pending || 0)} pending / ${Number(candidateFormal?.invalid || 0)} invalid / ${candidateFormalFinalized} finalized`}
                  </small>
                </span>
                <span>
                  Log Loss Δ
                  <strong>{candidateLogLossLabel}</strong>
                  <small>{language === 'zh' ? '相对同场去水市场，正值更好' : 'vs same-decision devigged market'}</small>
                </span>
                <span>
                  Brier Δ
                  <strong>{candidateBrierLabel}</strong>
                  <small>
                    {language === 'zh'
                      ? `${Number(candidateProspective.metrics?.calendarWindows || 0)}/6 固定窗口 · 双指标胜窗 ${Number(candidateProspective.metrics?.winningCalendarWindows || 0)}/${Number(candidateProspective.metrics?.requiredWinningCalendarWindows || 5)}`
                      : `${Number(candidateProspective.metrics?.calendarWindows || 0)}/6 fixed windows · dual-metric wins ${Number(candidateProspective.metrics?.winningCalendarWindows || 0)}/${Number(candidateProspective.metrics?.requiredWinningCalendarWindows || 5)}`}
                  </small>
                </span>
              </div>
            </div>
          )}
          <div className="benchmark-audit-panel__rules">
            <span>{language === 'zh' ? '✓ 胜负完整公开，不删除失误样本' : '✓ Wins and losses stay visible'}</span>
            <span>{language === 'zh' ? '✓ 截止后不可改方向、赔率或证据' : '✓ No post-cutoff edits'}</span>
            <span>{language === 'zh' ? '✓ 同时报 ROI、CLV、Brier 与 Log Loss' : '✓ Report ROI, CLV, Brier and Log Loss'}</span>
            <span>{language === 'zh' ? '外部 80% 声称：未核验，不进入训练标签' : 'External 80% claim: unverified, never a training label'}</span>
          </div>
        </section>
      )}

      <section
        className="notice-banner is-compact"
        aria-label={isAnalysisView
          ? (language === 'zh' ? '参考提示' : 'Reference notice')
          : (language === 'zh' ? '赛程页说明' : 'Fixtures page note')}
      >
        <p className="notice-text">
          {isAnalysisView ? t('referenceNotice') : (
            <>
              {language === 'zh'
                ? '有已发布推荐的比赛已在赔率表中直接标记；需要查看完整分析证据与命中复盘，请前往'
                : 'Published picks are marked directly in the odds table. For full evidence and settled-pick review, open '}
              {' '}
              <Link to="/predictions">{language === 'zh' ? '赛前分析' : 'Pre-match Analysis'}</Link>
              {language === 'zh' ? '。' : '.'}
            </>
          )}
        </p>
      </section>

      <details
        className={`source-health-panel source-health-details ${sourcePanelTone}`}
        data-testid="source-health-panel"
        data-source-health-ok={String(sourceHealth?.ok !== false)}
        data-source-health-checked-at={sourceHealth?.checkedAt || ''}
        data-source-health-fallback={String(hasSourceFallback)}
        data-source-serving-mode={sourceServingMode || 'unknown'}
        data-recommendation-reliable={String(recommendationReliable)}
        data-fallback-within-window={String(dataSync.fallbackWithinReliableWindow ?? '')}
        data-fallback-age-seconds={dataSync.fallbackAgeSeconds ?? ''}
        data-fallback-max-age-seconds={dataSync.fallbackMaxAgeSeconds ?? ''}
        data-sporttery-egress-status={sportteryEgress?.status || 'unknown'}
        data-sporttery-egress-ok={String(sportteryEgress?.ok === true)}
        data-sporttery-egress-waf={String(Boolean(sportteryEgressSummary?.wafBlocked))}
        data-sporttery-egress-json={sportteryEgressSummary?.jsonEndpoints ?? ''}
        data-sporttery-relay-current-fresh={String(relayCurrentFresh)}
        data-sporttery-relay-current-rows={relayCurrentRows}
        data-sporttery-relay-result-fresh={relayResultKnown ? String(relayResultFresh) : ''}
        data-sporttery-relay-result-rows={relayResultRows}
        data-sporttery-relay-result-freshness={relayResultFreshnessTime || ''}
        data-sporttery-sync-meta-current-stale={String(syncMetaCurrentStale)}
        data-sporttery-relay-partial={String(relayPartialDegraded)}
        aria-label={language === 'zh' ? '数据源状态' : 'Data source status'}
      >
        <summary className="source-health-head">
          <div>
            <strong>{language === 'zh' ? '数据源状态' : 'Data source status'}</strong>
            <span>
              {hasSourceTransportIssue
                ? (language === 'zh'
                  ? `${sportteryEgressStatusLabel} / ${hasSourceFallback ? '\u515c\u5e95\u670d\u52a1\u4e2d' : '\u7b49\u5f85\u540e\u53f0\u6062\u590d'}`
                  : `${sportteryEgressStatusLabel} / ${hasSourceFallback ? 'fallback serving' : 'waiting for recovery'}`)
                : hasSourceFallback
                ? (language === 'zh'
                  ? `官方源保留快照 · 500补充 ${sourceFallback?.fiveHundredFallbackMatches ?? 0} 场`
                  : `Official source locked · ${sourceFallback?.fiveHundredFallbackMatches ?? 0} from 500.com`)
                : relayResultDegraded
                ? (language === 'zh'
                  ? '当前赛程实时 / 赛果通道延迟'
                  : 'Current lane live / result lane delayed')
                : relayPagedDegraded
                ? (language === 'zh'
                  ? '\u5f53\u524d\u901a\u9053\u5b9e\u65f6 / \u5206\u9875\u91c7\u96c6\u89c2\u5bdf'
                  : 'Current lane live / paged crawl watch')
                : language === 'zh'
                ? `官方赔率 ${officialOddsCount}/${sourceCurrentCount} · 外部覆盖 ${sourceCoverage}%`
                : `Official odds ${officialOddsCount}/${sourceCurrentCount} · Coverage ${sourceCoverage}%`}
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

      {isAnalysisView && (
      <details
        className={`model-governance-panel system-model-details ${modelPanelTone}`}
        data-testid="model-governance-panel"
        data-model-version={modelVersionLabel}
        data-model-online-effect={modelOnlineEffect}
        data-model-eligible-scope={modelEligibleScope}
        data-model-signal-online-effect={modelSignalOnlineEffect}
        data-model-gate-status={modelGateStatus}
        data-model-gate-tone={modelGateTone}
        data-model-evaluation-ok={String(modelHealthEvaluation?.ok ?? '')}
        data-model-evaluation-coverage-ok={String(modelHealthEvaluation?.coverageOk ?? '')}
        data-model-odds-coverage={modelHealthEvaluation?.odds?.coverageRatio ?? ''}
        data-model-prediction-coverage={modelHealthEvaluation?.predictionSnapshots?.coverageRatio ?? ''}
        data-model-baseline-rows={modelBaselineRows}
        data-model-input-audit-ok={String(modelInputAuditOk)}
        data-model-input-audit-violations={modelInputAuditViolationCount}
        data-model-risk-tier={modelRiskTier}
        data-model-risk-reasons={modelRiskWarningCount}
        data-model-scorecard-version={modelScorecard?.version || ''}
        data-model-public-scorecard={String(scorecardPublicAvailable)}
        data-model-scorecard-has-formal-sample={String(scorecardHasFormalSample)}
        data-model-formal-recommendation-rows={scorecardFormalRows ?? ''}
        data-model-market-buckets={scorecardMarketCount}
        data-model-league-buckets={scorecardLeagueCount}
        data-model-odds-buckets={scorecardOddsCount}
        data-model-probability-architecture={modelArchitecture?.version || ''}
        data-model-source-policy={modelSourcePolicy?.version || ''}
        data-model-current-vs-market-logloss={currentModelComparison?.logLossImprovement ?? ''}
        data-model-shadow-vs-market-logloss={modelArchitectureComparison?.bestShadowLogLossImprovement ?? scorecardComparison?.logLossImprovement ?? ''}
        data-hhad-companion-status={hhadCompanionUiStatus}
        data-hhad-companion-paired-rows={hhadCompanionRows ?? ''}
        data-hhad-companion-candidate-ready={hhadCompanionAvailable ? String(hhadCompanionReady) : ''}
        data-hhad-companion-online-effect={hhadCompanionAvailable ? (hhadCompanion?.onlineEffect || 'shadow') : ''}
        data-five-hundred-cutover-allowed={String(fiveHundredCutoverAllowed)}
        data-five-hundred-coverage={fiveHundredCoverageRatio}
        data-five-hundred-errors={fiveHundredErrors}
        aria-label={language === 'zh' ? '模型治理状态' : 'Model governance status'}
      >
        <summary className="system-model-summary">
          <span>{language === 'zh' ? '系统与模型说明' : 'System and model notes'}</span>
          <strong className={`is-${systemRecommendationTone}`}>{systemRecommendationLabel}</strong>
          <span>{dashboardUpdatedAt}</span>
        </summary>
        <div className="system-model-body">
      <section
        className={`data-sync-strip ${dataSyncTone}`}
        data-testid="data-sync-strip"
        data-data-channel={dataSync.dataChannel || ''}
        data-service-transitioning={String(Boolean(dataSync.serviceTransitioning))}
        data-retained-data-at={dataSync.retainedDataAt || ''}
        data-source-version={dataSync.sourceUpdatedAt || dataSync.updatedAt || ''}
        data-source-stale={String(Boolean(dataSync.sourceStale || hasSourceFallback || hasSourceTransportIssue))}
        data-source-partial-stale={String(relayPartialDegraded)}
        data-source-health-ok={String(sourceHealth?.ok !== false)}
        data-recommendation-reliable={String(recommendationReliable)}
        data-fallback-within-window={String(dataSync.fallbackWithinReliableWindow ?? '')}
        data-fallback-age-seconds={dataSync.fallbackAgeSeconds ?? ''}
        data-fallback-max-age-seconds={dataSync.fallbackMaxAgeSeconds ?? ''}
        data-model-version={modelVersionLabel}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={t('dataStatusTitle')}
      >
        <div className="data-sync-copy">
          <span className="data-sync-dot" aria-hidden="true" />
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
        <div className="model-governance-head">
          <div>
            <strong>{language === 'zh' ? '模型治理状态' : 'Model governance'}</strong>
            <span>
              {language === 'zh'
                ? `策略版本 ${modelVersionLabel} / LLM 只做风险复核`
                : `Strategy ${modelVersionLabel} / LLM risk review only`}
            </span>
          </div>
          <em>{modelGateLabel}</em>
        </div>
        <div className="model-governance-grid">
          {modelGovernanceItems.map((item) => (
            <article key={item.label} className="model-governance-item">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.note}</small>
            </article>
          ))}
        </div>
        <div className="model-probability-stack" data-testid="model-probability-stack">
          <div className="model-subsection-head">
            <strong>{language === 'zh' ? '概率模型栈' : 'Probability stack'}</strong>
            <span>
              {language === 'zh'
                ? '先概率、后推荐；先回测、后上线'
                : 'probability first, recommendation second; backtest before promotion'}
            </span>
          </div>
          <div className="model-probability-grid">
            {probabilityStackItems.map((item) => (
              <article key={item.label} className="model-probability-item">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.note}</small>
              </article>
            ))}
          </div>
        </div>
        <div className="model-source-policy" data-testid="model-source-policy">
          <div className="model-subsection-head">
            <strong>{language === 'zh' ? '采集切换策略' : 'Source cutover policy'}</strong>
            <span>
              {language === 'zh'
                ? '500 网做补充，不替代官方赛程与锁定规则'
                : '500.com supplements the official schedule and cutoff rules'}
            </span>
          </div>
          <div className="model-source-policy-grid">
            {sourcePolicyItems.map((item) => (
              <article key={item.label} className="model-source-policy-item">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.note}</small>
              </article>
            ))}
          </div>
        </div>
        </div>
      </details>
      )}

    </div>
  );
};
