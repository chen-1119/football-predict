import React, { useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronUp, RotateCcw, Search, SlidersHorizontal, Trophy, X } from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import { formatBeijingDateString, getDateStringOffset } from '../services/mockData';
import type { Country, League, Match, PredictionDetail } from '../services/mockData';
import { getOfficialMatchOdds, getPredictionMarketLabel, getPredictionTipDisplay, getResolvedMatchOdds, isPredictionOfficialResultPoolAvailable } from '../services/bettingDisplay';
import { getCountryById, getLeagueById } from '../services/entities';
import { type MatchSignalCategory } from '../services/matchSignal';
import { getVisiblePrediction } from '../services/predictionVisibility';
import { buildPublicRecommendationCopy } from '../services/recommendationCopy';
import { getDisplayRecommendation, getLiveDisplayRecommendation, getMatchDisplayTeam } from '../services/displayRecommendation';
import type { DisplayRecommendation } from '../services/displayRecommendation';
import { isOfficialRecommendationEligible } from '../services/officialRecommendationEligibility';
import { selectOnSaleAnalysisReference } from '../services/analysisReferenceSelection';
import {
  buildFiveHundredMarketReferencePresentation,
  isFiveHundredMarketReferencePrediction
} from '../services/externalOddsReferencePresentation';
import { isBeforeMatchSaleCutoff } from '../services/matchLifecycle';
import { getMatchEventKey } from '../services/atomicMatchRefresh';
import { getArchivedPreMatchPrediction } from '../services/archivedPreMatchPrediction';
import { getProvisionalArchivedOutcome } from '../services/provisionalResultPresentation';
import { buildLiveScorePresentation } from '../services/liveScorePresentation';
import { TeamBadge } from '../components/TeamBadge';
import { DateScopeBar } from '../components/predictions/DateScopeBar';
import { MatchSummaryRow } from '../components/predictions/MatchSummaryRow';
import { MatchMarketOdds } from '../components/predictions/MatchMarketOdds';
import type { SavedMatchCapture } from '../components/predictions/CapturedMatchData';
import { buildCapturedReferenceAnalysis } from '../services/capturedReferenceAnalysis';
import { PredictionsPageHeader } from '../components/predictions/PredictionsPageHeader';
import '../styles/predictions.css';
import '../styles/predictions-refresh.css';

interface PredictionsListProps {
  onSelectMatch: (matchId: string) => void;
  viewMode: 'analysis' | 'fixtures';
  capturedDataByMatchId?: Record<string, SavedMatchCapture>;
}

type SortBy = 'time' | 'odds';

const SORT_OPTIONS: SortBy[] = ['time', 'odds'];
const LIST_VIEW_STATE_TTL_MS = 30 * 60 * 1000;
const LIST_RETURN_SCROLL_TTL_MS = 10 * 60 * 1000;

type StoredListViewState = {
  savedAt: number;
  selectedDate: string;
  selectedLeagues: string[];
  searchQuery: string;
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
      searchQuery: typeof parsed.searchQuery === 'string' ? parsed.searchQuery.slice(0, 100) : '',
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
    // A later void decision supersedes every previously settled review row.
    if (isVoid) return acc;
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

const getCrossDayKickoffLabel = (match: Match, language: 'zh' | 'en') => {
  const sportteryDay = getSportteryDay(match);
  const kickoffDay = getKickoffDay(match);
  if (!sportteryDay || !kickoffDay || sportteryDay === kickoffDay) return '';
  return `${formatShortDate(kickoffDay, language)} ${formatKickoffTime(match.kickoffTime, language)}`;
};

const getRowKickoffLabel = (match: Match, language: 'zh' | 'en') => {
  return getCrossDayKickoffLabel(match, language) || formatKickoffTime(match.kickoffTime, language);
};

const hasOfficialScore = (match: Match) => (
  match.status === 'FINISHED'
  && Number.isFinite(match.scoreHome)
  && Number.isFinite(match.scoreAway)
);

const isReferenceOddsSource = (source: string | undefined) => {
  const normalized = String(source || '').trim().toLowerCase();
  return Boolean(normalized && !normalized.startsWith('sporttery:'));
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
  prediction: PredictionDetail | undefined
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
  if (!isReferenceOddsSource(pool?.source)) return null;
  return { odds: Number(value) };
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

export const PredictionsList: React.FC<PredictionsListProps> = ({ onSelectMatch, viewMode, capturedDataByMatchId }) => {
  const { language, matches, dataSync } = useApp();
  const isAnalysisView = viewMode === 'analysis';
  const [clockNow, setClockNow] = useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // Cutoff and kickoff decisions must use the browser clock only. Source
  // timestamps are evidence metadata and may be ahead because of upstream
  // clock skew; treating them as "now" can hide still-open recommendations.
  const nowMs = clockNow;
  const capturedAnalyses = useMemo(() => new Map(matches
    .filter(match => capturedDataByMatchId?.[match.id] && !match.predictions?.length && !match.probabilityModel && !match.gptPrediction)
    .map(match => [match.id, buildCapturedReferenceAnalysis(match, capturedDataByMatchId?.[match.id], nowMs)])),
  [matches, capturedDataByMatchId, nowMs]);

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
  const [searchQuery, setSearchQuery] = useState(() => restoreReturnView ? restoredViewState?.searchQuery || '' : '');
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
  const [automaticInitialDateResolved, setAutomaticInitialDateResolved] = useState(restoreReturnView);

  React.useEffect(() => {
    const previousToday = previousTodayRef.current;
    if (previousToday !== todayStr) {
      setSelectedDate((current) => current === previousToday ? todayStr : current);
      previousTodayRef.current = todayStr;
    }
  }, [todayStr]);

  // Resolve the initial date once before painting; a user's explicit date is
  // never replaced when a later background refresh changes the match list.
  if (!automaticInitialDateResolved && dataSync.currentLoaded) {
    const availableDates = Array.from(new Set(matches.flatMap(getMatchDateCandidates).filter(Boolean))).sort();
    if (availableDates.length > 0) {
      setAutomaticInitialDateResolved(true);
      if (!availableDates.includes(todayStr)) {
        const nearestUpcomingDate = availableDates.find((date) => date >= todayStr);
        const nearestRecentDate = [...availableDates].reverse().find((date) => date < todayStr);
        const nearestAvailableDate = nearestUpcomingDate || nearestRecentDate;
        if (nearestAvailableDate) setSelectedDate(nearestAvailableDate);
      }
    }
  }

  const handleDateSelect = React.useCallback((date: string) => {
    setAutomaticInitialDateResolved(true);
    setSelectedDate(date);
  }, []);

  React.useEffect(() => {
    try {
      window.sessionStorage.setItem(listViewStorageKey(viewMode), JSON.stringify({
        savedAt: Date.now(),
        selectedDate,
        selectedLeagues,
        searchQuery,
        sortBy,
        sortOrder
      } satisfies StoredListViewState));
    } catch {
      // Filters remain fully usable when storage is disabled.
    }
  }, [selectedDate, selectedLeagues, searchQuery, sortBy, sortOrder, viewMode]);

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
    filterTitle: { zh: '联赛', en: 'Leagues' },
    allLeagues: { zh: '全部联赛', en: 'All leagues' },
    sortTitle: { zh: '排序', en: 'Sort' },
    time: { zh: '开赛时间', en: 'Time' },
    odds: { zh: 'SP', en: 'SP' },
    reset: { zh: '清除筛选', en: 'Clear filters' },
    yesterday: { zh: '昨天', en: 'Yesterday' },
    today: { zh: '今天', en: 'Today' },
    tomorrow: { zh: '明天', en: 'Tomorrow' },
    dayAfterTomorrow: { zh: '后天', en: 'Day +2' },
    details: { zh: '查看详情', en: 'View match' },
    leagueMatches: { zh: '场比赛', en: 'matches' }
  };
  const t = (key: keyof typeof translations) => translations[key][language];

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

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredMatches = useMemo(() => {
    if (!normalizedSearch) return baseFilteredMatches;
    return baseFilteredMatches.filter((match) => {
      const home = getMatchDisplayTeam(match, 'home');
      const away = getMatchDisplayTeam(match, 'away');
      const league = getMatchDisplayLeague(match);
      return [home.name.zh, home.name.en, away.name.zh, away.name.en, league.name.zh, league.name.en,
        league.shortName.zh, league.shortName.en, getSportteryMeta(match)]
        .some((value) => String(value || '').toLocaleLowerCase().includes(normalizedSearch));
    });
  }, [baseFilteredMatches, normalizedSearch]);
  const hasActiveFilters = Boolean(normalizedSearch || effectiveSelectedLeagues.length || sortBy !== 'time' || sortOrder !== 'asc');

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
    setSearchQuery('');
    setSortBy('time');
    setSortOrder('asc');
  };

  const handleSortChange = (nextSort: SortBy) => {
    if (nextSort === sortBy) return;
    setSortBy(nextSort);
    setSortOrder(nextSort === 'time' ? 'asc' : 'desc');
  };

  const renderMatchRow = (match: Match) => {
    const isVoid = match.resultDisposition === 'VOID';
    const hasSettledReview = Boolean(match.postMatchReview?.predictionReview?.rows?.some((row) => isSettledReviewStatus(row.resultStatus)));
    const kickoffAt = Date.parse(match.kickoffTime || '');
    const isPastScheduled = match.status === 'SCHEDULED' && Number.isFinite(kickoffAt) && kickoffAt <= nowMs;
    const isFinished = match.status === 'FINISHED' || match.status === 'PENDING_RESULT' || hasSettledReview || isPastScheduled;
    const publishedRecommendation = isVoid ? null
      : getOnSaleDisplayRecommendation(match, language, nowMs) || getLiveDisplayRecommendation(match, language);
    const rawDisplayRecommendation = getDisplayRecommendation(match, language);
    const livePublishedRecommendation = publishedRecommendation?.publicationTrack === 'live' ? publishedRecommendation : null;
    const displayRecommendation = isFinished ? livePublishedRecommendation : publishedRecommendation;
    const analysisReferenceSelection = !isFinished && !displayRecommendation
      ? selectOnSaleAnalysisReference(match, { allowModelOnly: true, candidate: rawDisplayRecommendation?.prediction, now: nowMs })
      : undefined;
    const analysisReference = analysisReferenceSelection?.prediction;
    const reviewRow = getSettledPostReviewRow(match, livePublishedRecommendation?.prediction || rawDisplayRecommendation?.prediction);
    const reviewPrediction = predictionFromReviewRow(reviewRow);
    const reviewIsFormal = isFormalReviewRow(reviewRow);
    const reviewIsLive = isLiveReviewRow(reviewRow);
    const archivedPreMatchPrediction = getArchivedPreMatchPrediction(match, nowMs);
    const isInPlayArchiveFallback = match.status === 'LIVE' && !displayRecommendation && Boolean(archivedPreMatchPrediction);
    // Keep the established settlement/publication/archive/reference priority.
    const pickedPrediction = reviewPrediction || displayRecommendation?.prediction || archivedPreMatchPrediction || analysisReference;
    const isReferencePick = Boolean(
      (!isFinished && !displayRecommendation && analysisReference)
      || (isInPlayArchiveFallback && archivedPreMatchPrediction?.recommendationAction !== 'recommend')
      || (isFinished && reviewRow && !reviewIsFormal && !reviewIsLive)
      || (isFinished && !reviewRow && !livePublishedRecommendation && archivedPreMatchPrediction)
    );
    const isFormal = isFinished ? reviewIsFormal
      : isInPlayArchiveFallback ? archivedPreMatchPrediction?.recommendationAction === 'recommend'
      : Boolean(displayRecommendation && displayRecommendation.publicationTrack !== 'live');
    const isPublishedReferenceSpUnavailable = analysisReferenceSelection?.source === 'published-reference'
      && (pickedPrediction?.oddsPoolCode === undefined
        || (pickedPrediction.oddsPoolCode === 'HHAD' && !sameHandicapLine(pickedPrediction.handicapLine, getOfficialMatchOdds(match).hhad?.handicap)));
    const isFiveHundredReference = !isFinished && (
      analysisReferenceSelection?.source === 'five-hundred-market'
      || analysisReferenceSelection?.source === 'five-hundred-low-evidence-market'
      || isFiveHundredMarketReferencePrediction(pickedPrediction)
    );
    const fiveHundredPresentation = isFiveHundredReference ? buildFiveHundredMarketReferencePresentation(match, nowMs) : null;
    const fiveHundredDisplayOdds = fiveHundredPresentation?.reference.selectedSourceOdds
      || (analysisReferenceSelection?.source === 'five-hundred-low-evidence-market' ? analysisReferenceSelection.displayOdds : null);
    const referenceOfficialOdds = isReferencePick ? getOfficialPredictionOdds(match, pickedPrediction) : 0;
    const referenceOdds = isReferencePick && referenceOfficialOdds <= 1 ? getReferencePredictionOdds(match, pickedPrediction) : null;
    const directionLabel = reviewRow?.tipLabel?.[language]
      ? stripDirectionPrefix(reviewRow.tipLabel[language], language)
      : displayRecommendation?.label || (pickedPrediction ? stripDirectionPrefix(getPredictionTipDisplay(pickedPrediction, language, true), language) : '');
    const publicCopy = buildPublicRecommendationCopy(match, pickedPrediction, language, { pickLabel: directionLabel, forceReference: isReferencePick });
    const recordedOdds = Number(pickedPrediction?.odds || 0);
    // Archived and settled rows show the selected record's SP, never a new quote.
    const sp = isVoid || !pickedPrediction || isPublishedReferenceSpUnavailable ? '--'
      : isFinished || isInPlayArchiveFallback ? (recordedOdds > 1 ? recordedOdds.toFixed(2) : '--')
      : referenceOdds ? referenceOdds.odds.toFixed(2)
      : fiveHundredDisplayOdds && fiveHundredDisplayOdds > 1 ? fiveHundredDisplayOdds.toFixed(2)
      : publicCopy.oddsLabel.replace(/^(赔率|Odds|SP)\s*/, '').replace(/^(待开售|pending)$/, '--');
    // Only settled review rows can produce Hit/Miss; live/external scores cannot.
    const settledStatus = isFinished && reviewRow && isSettledReviewStatus(reviewRow.resultStatus) ? reviewRow.resultStatus : undefined;
    const resultLabel = isVoid ? (language === 'zh' ? '已作废' : 'Void')
      : settledStatus === 'WON' ? (language === 'zh' ? '命中' : 'Hit')
      : settledStatus === 'LOST' ? (language === 'zh' ? '未命中' : 'Miss')
      : !isFinished && match.status !== 'LIVE' ? (language === 'zh' ? '未开赛' : 'Upcoming')
      : match.status === 'LIVE' ? (language === 'zh' ? '进行中' : 'Live')
      : (language === 'zh' ? '待赛果' : 'Pending result');
    const homeTeam = getMatchDisplayTeam(match, 'home');
    const awayTeam = getMatchDisplayTeam(match, 'away');
    const liveScore = match.status === 'LIVE' ? buildLiveScorePresentation(match, language, nowMs) : null;
    const statusLabel = isVoid ? (language === 'zh' ? '已取消' : 'Canceled')
      : match.status === 'LIVE' ? (language === 'zh' ? '进行中' : 'Live')
      : match.status === 'FINISHED' ? (language === 'zh' ? '已完场' : 'Finished')
      : isFinished ? (language === 'zh' ? '待赛果' : 'Pending result')
      : (language === 'zh' ? '待开赛' : 'Scheduled');
    const scoreText = match.status === 'FINISHED' && hasOfficialScore(match) ? match.scoreHome + ':' + match.scoreAway
      : liveScore?.hasScore ? liveScore.scoreText : '';
    const hasPick = !isVoid && Boolean(pickedPrediction && directionLabel);
    const savedAnalysis = !hasPick && !isVoid && !isFinished ? capturedAnalyses.get(match.id) : undefined;
    const capturedReference = savedAnalysis?.status === 'available' ? savedAnalysis : undefined;
    const capturedDirection = capturedReference ? (language === 'zh'
      ? { home: '主胜', draw: '平局', away: '客胜' }
      : { home: 'Home win', draw: 'Draw', away: 'Away win' })[capturedReference.outcome.code] : '';
    const tone = isFinished || isVoid ? 'archive' : isFormal ? 'formal' : hasPick || capturedReference ? 'analysis' : 'fixture';
    return (
      <MatchSummaryRow key={getMatchEventKey(match)} eventKey={getMatchEventKey(match)} tone={tone}
        timeLabel={language === 'zh' ? '时间' : 'Time'} teamsLabel={language === 'zh' ? '比赛' : 'Match'}
        marketOddsLabel={language === 'zh' ? (match.status === 'SCHEDULED' ? '比赛赔率' : '比赛赔率快照') : 'Match odds snapshot'}
        pickLabel={language === 'zh' ? '推荐方向' : 'Pick'} oddsLabel="SP" resultLabel={language === 'zh' ? '结果' : 'Result'}
        detailsLabel={t('details')}
        detailsAriaLabel={language === 'zh' ? '查看' + homeTeam.name[language] + '对阵' + awayTeam.name[language] + '的详情' : 'View ' + homeTeam.name[language] + ' vs ' + awayTeam.name[language]}
        onOpen={() => onSelectMatch(match.id)}
        follow={<FollowButton matchId={match.id} compact />}
        time={<div className="time-stack"><strong className="kickoff-time">{getRowKickoffLabel(match, language)}</strong><span className="status-note">{statusLabel}</span>{getSportteryMeta(match) && <span className="status-note is-muted">{getSportteryMeta(match)}</span>}</div>}
        teams={<div className="team-stack"><div className="team-line"><TeamBadge team={homeTeam} size="sm" /><span className="team-name">{homeTeam.name[language]}</span></div><div className="team-line"><TeamBadge team={awayTeam} size="sm" /><span className="team-name">{awayTeam.name[language]}</span></div>{scoreText && <span className="match-score-summary">{scoreText}</span>}</div>}
        pick={<div className="compact-pick"><strong>{hasPick ? directionLabel : capturedReference ? capturedDirection : (language === 'zh' ? '暂无推荐' : 'No pick')}</strong>{hasPick && pickedPrediction && <><span className={'compact-pick__tier ' + (isFormal ? 'is-formal' : 'is-reference')}>{isFormal ? (language === 'zh' ? '正式' : 'Formal') : (language === 'zh' ? '参考' : 'Reference')}</span><small>{getPredictionMarketLabel(pickedPrediction, language)}</small></>}{capturedReference && <><span className="compact-pick__tier is-reference">{language === 'zh' ? '参考' : 'Reference'}</span><small>{(capturedReference.outcome.probability * 100).toFixed(1)}% · {language === 'zh' ? '胜平负推导' : '1X2 estimate'}</small><small>{capturedReference.scores[0].home}-{capturedReference.scores[0].away} · {capturedReference.goalsPick.label}{language === 'zh' ? '球' : ' goals'}</small></>}</div>}
        marketOdds={<MatchMarketOdds match={match} language={language} capturedData={capturedDataByMatchId?.[match.id]} />}
        odds={<><strong className="compact-sp">{sp}</strong><small className="compact-sp-note">{language === 'zh' ? '推荐方向' : 'Selected pick'}</small></>}
        result={<span className={'compact-result ' + (settledStatus === 'WON' ? 'is-hit' : settledStatus === 'LOST' ? 'is-miss' : 'is-pending')}>{resultLabel}</span>}
      />
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

  const isLoading = Boolean(dataSync.currentLoading || (!dataSync.currentLoaded && !dataSync.error) || (effectiveSelectedDate < todayStr && dataSync.historyLoading && !dataSync.historyLoaded));
  const emptyStateText = isLoading ? (language === 'zh' ? '比赛加载中…' : 'Loading matches…')
    : !dataSync.currentLoaded && dataSync.error ? (language === 'zh' ? '暂时无法加载比赛，请稍后重试。' : 'Matches could not be loaded. Please try again shortly.')
    : normalizedSearch ? (language === 'zh' ? `没有找到“${searchQuery.trim()}”相关的比赛` : `No matches for “${searchQuery.trim()}”`)
    : (language === 'zh' ? '这个竞彩日暂无比赛' : 'No matches for this match day');
  const filterLeagueSummary = effectiveSelectedLeagues.length === 0 ? (language === 'zh' ? '全部联赛' : 'All leagues')
    : effectiveSelectedLeagues.length + (language === 'zh' ? ' 个联赛' : ' leagues');

  return (
    <div className="predictions-v4 dashboard-stack predictions-compact" data-view-mode={viewMode}>
      <section className="dashboard-hero is-compact">
        <PredictionsPageHeader title={isAnalysisView ? (language === 'zh' ? '赛前推荐' : 'Match picks') : (language === 'zh' ? '赛程' : 'Fixtures')}
          description={language === 'zh' ? '按竞彩日查看赛程、SP 与赛后结果' : 'Fixtures, SP and results by match day'}
          matchSummary={!dataSync.currentLoaded && baseFilteredMatches.length === 0 ? (language === 'zh' ? '加载中' : 'Loading') : baseFilteredMatches.length + (language === 'zh' ? ' 场比赛' : ' matches')} />
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
            ? '按竞彩日查看，跨午夜比赛仍归属原竞彩日。'
            : 'Grouped by Sporttery business day; after-midnight fixtures remain on their original issue day.'}
        </p>
      </section>

      {(dataSync.currentLoaded || matches.length > 0) && (
        <section
          className="filter-workbench"
          aria-label={language === 'zh' ? '赛事范围、筛选与排序' : 'Fixture scope, filters and sorting'}
        >
        <div className="matchday-searchbar">
          <label className="matchday-search">
            <Search size={18} aria-hidden="true" />
            <input type="search" value={searchQuery} maxLength={100}
              aria-label={language === 'zh' ? '搜索球队、联赛或赛事编号' : 'Search teams, leagues or match number'}
              placeholder={language === 'zh' ? '搜索球队、联赛或赛事编号' : 'Search teams, leagues or match number'}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setSearchQuery(''); }} />
            {searchQuery && <button type="button" className="matchday-search-clear" onClick={() => setSearchQuery('')}
              aria-label={language === 'zh' ? '清除搜索' : 'Clear search'}><X size={16} aria-hidden="true" /></button>}
          </label>
          <button type="button" onClick={handleResetFilters} className="reset-btn" disabled={!hasActiveFilters}>
            <RotateCcw size={14} aria-hidden="true" />{t('reset')}
          </button>
        </div>
        <div className="matchday-search-results" role="status" aria-live="polite" aria-atomic="true">
          <span>{normalizedSearch ? (language === 'zh' ? '搜索结果' : 'Search results') : (language === 'zh' ? '当前显示' : 'Showing')}
            {' '}<strong>{filteredMatches.length}</strong>{language === 'zh' ? ' 场比赛' : ' matches'}</span>
          <span>{formatShortDate(effectiveSelectedDate, language)} · {filterLeagueSummary}</span>
        </div>
        <details className="panel filters-panel filters-details" aria-label={language === 'zh' ? '赛事筛选与排序' : 'Fixture filters and sorting'}>
          <summary className="filters-summary">
            <span>
              <SlidersHorizontal size={16} aria-hidden="true" />
              <strong>{language === 'zh' ? '筛选与排序' : 'Filter and sort'}</strong>
            </span>
            <span>
              {effectiveSelectedLeagues.length > 0 ? filterLeagueSummary : (language === 'zh' ? '全部联赛' : 'All leagues')}
              <ChevronDown size={15} className="filters-summary-chevron" aria-hidden="true" />
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
              {language === 'zh' ? (sortBy === 'time' ? (sortOrder === 'asc' ? '较早优先' : '较晚优先') : (sortOrder === 'asc' ? '从低到高' : '从高到低')) : (sortOrder === 'asc' ? 'Ascending' : 'Descending')}
            </button>
          </div>

        </div>
          </div>
        </details>
        </section>
      )}

      {baseFilteredMatches.length > 0 && (
        <section className="compact-record" aria-label={language === 'zh' ? '当前日期已结算统计' : 'Settled record for this date'} data-formal-settled={dailyReviewStats.formalSettled}>
          <span>{language === 'zh' ? '正式命中 / 已结算' : 'Formal hits / settled'} <strong>{dailyReviewStats.formalWon}/{dailyReviewStats.formalSettled}</strong> <b>{formatDailyRate(dailyReviewStats.formalHitRate, language)}</b></span>
          {dailyReviewStats.referenceBestSettled > 0 && <span>{language === 'zh' ? '参考命中 / 已结算' : 'Reference hits / settled'} <strong>{dailyReviewStats.referenceBestWon}/{dailyReviewStats.referenceBestSettled}</strong></span>}
          {dailyReviewStats.liveSettled > 0 && <span>{language === 'zh' ? '实时参考命中 / 已结算' : 'Live reference hits / settled'} <strong>{dailyReviewStats.liveWon}/{dailyReviewStats.liveSettled}</strong></span>}
          {dailyReviewStats.awaitingOfficial > 0 && <span>{language === 'zh' ? '待赛果' : 'Pending result'} <strong>{dailyReviewStats.awaitingOfficial}</strong></span>}
          <small>{language === 'zh' ? '参考、待赛果与作废场次不计入正式命中率。' : 'Reference, pending and void picks are excluded from the formal hit rate.'}</small>
        </section>
      )}
      {groupedMatches.length === 0 ? (
        <section className="empty-state" role="status" aria-live="polite"><div><CalendarDays size={32} aria-hidden="true" /><p>{emptyStateText}</p>
          {!isLoading && hasActiveFilters && <button type="button" className="reset-btn" onClick={handleResetFilters}><RotateCcw size={15} aria-hidden="true" />{t('reset')}</button>}
          {!isLoading && !hasActiveFilters && <small>{language === 'zh' ? '可选择其他日期查看比赛。' : 'Choose another date to browse matches.'}</small>}
        </div></section>
      ) : (
        <section ref={matchListRef} className="league-stack" aria-label={language === 'zh' ? '比赛列表' : 'Matches'}>
          {groupedMatches.map((group) => (
            <section key={group.country.id + '_' + group.league.id} className="league-card">
              <header className="league-header"><div className="league-title"><span>{group.country.flag}</span><h2>{group.league.name[language]}</h2></div><span className="league-count">{group.matches.length} {t('leagueMatches')}</span></header>
              <div className={'predictions-v4__match-list is-' + viewMode + '-view'}>{group.matches.map(renderMatchRow)}</div>
            </section>
          ))}
        </section>
      )}
    </div>
  );
};
import { FollowButton } from '../components/FollowButton';
