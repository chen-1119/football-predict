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
  getPredictionMarketLabel,
  getPredictionTipDisplay,
  getResolvedMatchOdds,
  getSportteryPoolRows
} from '../services/bettingDisplay';
import type { SportteryOddsPoolDisplay } from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal, type MatchSignalCategory } from '../services/matchSignal';
import { getVisiblePrediction } from '../services/predictionVisibility';
import { buildPublicRecommendationCopy } from '../services/recommendationCopy';
import { getAvailableResultPools, getDisplayRecommendation, getHandicapCompanionHeading, getListHandicapSupplement } from '../services/displayRecommendation';
import { generateBetSlip, type SelectionResult } from '../services/generator';
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

type PostReviewRow = NonNullable<Match['postMatchReview']>['predictionReview']['rows'][number];
type SettledStatus = 'WON' | 'LOST';

const isSettledReviewStatus = (status: string | undefined): status is SettledStatus => (
  status === 'WON' || status === 'LOST'
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
    || settledRows.find((row) => row.reviewRole === 'main')
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
  finished: number;
  settled: number;
  won: number;
  hitRate: number | null;
  handicapHit: number;
  missedHandicapLane: number;
}

interface ParlayPreview {
  key: string;
  title: string;
  subtitle: string;
  selections: SelectionResult[];
  totalOdds: number;
  averageTrust: number;
  source: 'sp';
}

interface HomePageOddsFallback {
  label: string;
  marketLabel: string;
  tipLabel: string;
  odds: number;
}

const getDailyReviewStats = (matches: Match[]): DailyReviewStats => {
  const stats = matches.reduce((acc, match) => {
    const review = match.postMatchReview?.predictionReview;
    if (match.status === 'FINISHED' || review?.rows?.some((row) => isSettledReviewStatus(row.resultStatus))) {
      acc.finished += 1;
    }
    if (!review) return acc;

    if (isSettledReviewStatus(review.bestStatus || undefined)) {
      acc.settled += 1;
      if (review.bestStatus === 'WON') acc.won += 1;
    } else {
      const mainRows = (review.rows || []).filter((row) => row.reviewRole === 'main' || row.marketType === 'BEST');
      const settledMainRows = mainRows.filter((row) => isSettledReviewStatus(row.resultStatus));
      if (settledMainRows.length > 0) {
        acc.settled += settledMainRows.length;
        acc.won += settledMainRows.filter((row) => row.resultStatus === 'WON').length;
      } else if (Number(review.settled || 0) > 0) {
        acc.settled += Number(review.settled || 0);
        acc.won += Number(review.won || 0);
      }
    }

    if (review.handicapHit) acc.handicapHit += 1;
    if (review.missedHandicapLane) acc.missedHandicapLane += 1;
    return acc;
  }, {
    finished: 0,
    settled: 0,
    won: 0,
    handicapHit: 0,
    missedHandicapLane: 0
  });

  return {
    ...stats,
    hitRate: stats.settled > 0 ? Math.round((stats.won / stats.settled) * 100) : null
  };
};

const formatDailyRate = (value: number | null, language: 'zh' | 'en') => (
  value === null ? (language === 'zh' ? '待结算' : 'Pending') : `${value}%`
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

const getHomePageOddsFallback = (match: Match, language: 'zh' | 'en'): HomePageOddsFallback | null => {
  const displayRecommendation = getDisplayRecommendation(match, language);
  const reviewRow = getSettledPostReviewRow(match, displayRecommendation?.prediction);
  const reviewPrediction = predictionFromReviewRow(reviewRow);
  const prediction = reviewPrediction || displayRecommendation?.prediction || getBestPrediction(match);
  const odds = Number(prediction?.odds || 0);
  if (!prediction || !Number.isFinite(odds) || odds <= 0) return null;

  const isReview = match.status === 'FINISHED' || Boolean(reviewRow);
  return {
    label: language === 'zh'
      ? (isReview ? '赛后SP' : '推荐SP')
      : (isReview ? 'Review SP' : 'Pick SP'),
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
    trust: { zh: '推荐强度', en: 'Pick Strength' },
    odds: { zh: '赔率', en: 'Odds' },
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
    oddsHeader: { zh: '胜平负/让球赔率', en: '1X2 / HHAD Odds' },
    closed: { zh: '等待官方赔率', en: 'Official odds pending' },
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

  const dailyReviewStats = useMemo(() => getDailyReviewStats(baseFilteredMatches), [baseFilteredMatches]);

  const parlayRecommendations = useMemo<ParlayPreview[]>(() => {
    const buildCombo = (
      key: string,
      titleZh: string,
      titleEn: string,
      matchCount: 2 | 3,
      targetOdds: number,
      minTrust: number
    ): ParlayPreview | null => {
      const result = generateBetSlip({
        targetOdds,
        matchCount,
        marketTypes: ['1X2', 'HHAD'],
        minOdds: 1.12,
        maxOdds: 3.35,
        timeWindow: '3',
        minTrust,
        onlyImportantLeagues: false,
        onlyOddsDropping: false
      }, baseFilteredMatches);

      const title = language === 'zh' ? titleZh : titleEn;
      const subtitle = language === 'zh'
        ? `${matchCount} 串 · 目标组合值 ${targetOdds.toFixed(1)}`
        : `${matchCount}-leg · target ${targetOdds.toFixed(1)}`;

      if (
        !result.isSuccess
        || result.selections.length < matchCount
        || result.selections.some((selection) => Number(selection.prediction.odds || 0) <= 0)
      ) return null;

      return {
        key,
        title,
        subtitle,
        selections: result.selections,
        totalOdds: result.totalOdds,
        averageTrust: result.averageTrust,
        source: 'sp'
      };
    };

    return [
      buildCombo('steady-2', '稳健 2 串', 'Steady 2-leg', 2, 3.2, 38),
      buildCombo('value-3', '进取 3 串', 'Value 3-leg', 3, 6.0, 36)
    ].filter((combo): combo is ParlayPreview => Boolean(combo));
  }, [baseFilteredMatches, language]);

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

  const renderRecommendationCard = (match: Match, mode: 'pick' | 'watch' = 'pick') => {
    const homeTeam = getMatchDisplayTeam(match, 'home');
    const awayTeam = getMatchDisplayTeam(match, 'away');
    const signal = getMatchSignal(match);
    const displayRecommendation = getDisplayRecommendation(match, language);
    const companionRecommendation = displayRecommendation?.companion
      || getListHandicapSupplement(match, language, displayRecommendation?.prediction);
    const sportteryMeta = getSportteryMeta(match, language);
    const hasReferenceLean = Boolean(displayRecommendation);
    const directionLabel = displayRecommendation?.label || '';
    const publicCopy = buildPublicRecommendationCopy(match, displayRecommendation?.prediction, language, {
      pickLabel: directionLabel,
      fallbackReason: displayRecommendation?.reason || getDecisionReason(signal.category, language)
    });
    const cautionText = hasReferenceLean
      ? publicCopy.updateRule
      : (language === 'zh' ? '等待官方赔率开售' : 'Await official odds');
    const pickText = hasReferenceLean && displayRecommendation
      ? publicCopy.title
      : signal.category === 'avoid'
        ? (language === 'zh' ? '推荐待临场复核' : 'Pick needs late recheck')
        : publicCopy.title;
    const statusBadge = publicCopy.marketLabel;

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
        <span className="recommendation-odds">{publicCopy.strengthLabel} · {publicCopy.oddsLabel}</span>
        {publicCopy.reasons[0] && (
          <span className="recommendation-reason">{publicCopy.reasons[0]}</span>
        )}
        {companionRecommendation && (
          <span className="recommendation-companion-line">
            <span>{getHandicapCompanionHeading(companionRecommendation, language)}</span>
            <strong>{companionRecommendation.label}</strong>
            <em>{companionRecommendation.meta}</em>
          </span>
        )}
      </button>
    );
  };

  const renderParlayCard = (combo: ParlayPreview) => (
    <article key={combo.key} className="parlay-card">
      <header className="parlay-card-head">
        <div>
          <span>{combo.subtitle}</span>
          <strong>{combo.title}</strong>
        </div>
        <div className="parlay-total">
          <span>{language === 'zh' ? '组合值' : 'Total'}</span>
          <strong>{`@${combo.totalOdds.toFixed(2)}`}</strong>
        </div>
      </header>
      <div className="parlay-leg-list">
        {combo.selections.map((selection) => {
          const homeTeam = getMatchDisplayTeam(selection.match, 'home');
          const awayTeam = getMatchDisplayTeam(selection.match, 'away');
          const odds = Number(selection.prediction.odds || 0);
          return (
            <button
              key={`${combo.key}-${selection.match.id}-${selection.prediction.marketType}-${selection.prediction.tipCode}`}
              type="button"
              className="parlay-leg"
              onClick={() => onSelectMatch(selection.match.id)}
            >
              <span className="parlay-leg-time">{formatKickoffTime(selection.match.kickoffTime, language)}</span>
              <strong>{homeTeam.name[language]} vs {awayTeam.name[language]}</strong>
              <span>
                {getPredictionMarketLabel(selection.prediction, language)}
                <b>{getPredictionTipDisplay(selection.prediction, language, true)}</b>
                <em>{`@${odds.toFixed(2)}`}</em>
              </span>
            </button>
          );
        })}
      </div>
      <footer className="parlay-card-foot">
        <span>{language === 'zh' ? '平均强度' : 'Avg strength'} {combo.averageTrust}</span>
        <span>
          {language === 'zh' ? '只收录已开售 SP 的方向' : 'Only opened SP legs are included'}
        </span>
      </footer>
    </article>
  );

  const renderDecisionCell = (match: Match) => {
    const hasSettledReview = Boolean(match.postMatchReview?.predictionReview?.rows?.some((row) => isSettledReviewStatus(row.resultStatus)));
    const isFinished = match.status === 'FINISHED' || hasSettledReview;
    const signal = getMatchSignal(match);
    const displayRecommendation = getDisplayRecommendation(match, language);
    const reviewRow = getSettledPostReviewRow(match, displayRecommendation?.prediction);
    const reviewPrediction = predictionFromReviewRow(reviewRow);
    const companionRecommendation = displayRecommendation?.companion
      || getListHandicapSupplement(match, language, reviewPrediction || displayRecommendation?.prediction);
    const pickedPrediction = reviewPrediction || displayRecommendation?.prediction;
    const settledStatus = reviewRow?.resultStatus || pickedPrediction?.resultStatus;
    const showHit = isFinished && settledStatus === 'WON';
    const showMiss = isFinished && settledStatus === 'LOST';
    const isReferencePick = false;
    const directionLabel = reviewRow?.tipLabel?.[language]
      ? stripDirectionPrefix(reviewRow.tipLabel[language], language)
      : displayRecommendation?.label || (pickedPrediction
      ? stripDirectionPrefix(getPredictionTipDisplay(pickedPrediction, language, true), language)
      : '');
    const publicCopy = buildPublicRecommendationCopy(match, pickedPrediction, language, {
      pickLabel: directionLabel,
      fallbackReason: displayRecommendation?.reason || getDecisionReason(signal.category, language)
    });
    const poolStatus = publicCopy.marketLabel;
    const primaryLabel = displayRecommendation
      ? publicCopy.title
      : pickedPrediction
        ? publicCopy.title
      : '';
    const fallbackPrimaryLabel = signal.category === 'finished'
        ? (language === 'zh' ? '赛后复盘' : 'Review')
        : publicCopy.title;
    const primaryMeta = publicCopy.strengthLabel;
    const strengthValue = language === 'zh'
      ? publicCopy.strengthLabel.replace(/^推荐强度\s*/, '')
      : publicCopy.strengthLabel.replace(/^Strength\s*/, '');
    const oddsValue = language === 'zh'
      ? publicCopy.oddsLabel.replace(/^赔率\s*/, '')
      : publicCopy.oddsLabel.replace(/^Odds\s*/, '');

    return (
      <div className={`decision-card is-${signal.category} ${displayRecommendation || pickedPrediction ? 'has-pick' : 'is-watch-only'} ${isReferencePick ? 'is-reference' : ''} ${showHit ? 'is-hit' : ''} ${showMiss ? 'is-miss' : ''}`}>
        <div className="decision-main">
          <span className="decision-label">{primaryLabel || fallbackPrimaryLabel}</span>
          <span className="decision-meta">{primaryMeta}</span>
          {companionRecommendation && (
            <span className="decision-companion-line">
              <span>{getHandicapCompanionHeading(companionRecommendation, language)}</span>
              <strong>{companionRecommendation.label}</strong>
              <em>{companionRecommendation.meta}</em>
            </span>
          )}
          {showHit && <span className="mini-hit">{t('hit')}</span>}
          {showMiss && <span className="mini-miss">{t('miss')}</span>}
        </div>

        <div className="decision-facts">
          <span>
            {language === 'zh' ? '强度' : 'Strength'}
            <strong>{strengthValue}</strong>
          </span>
          <span>
            {language === 'zh' ? '赔率' : 'Odds'}
            <strong>{oddsValue}</strong>
          </span>
          <span>
            {language === 'zh' ? '玩法' : 'Market'}
            <strong>{poolStatus}</strong>
          </span>
        </div>
        {(publicCopy.reasons[0] || displayRecommendation?.reason) && (
          <p className="decision-reason">
            <span>{publicCopy.reasons[0] || displayRecommendation?.reason}</span>
          </p>
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
      note: language === 'zh' ? '胜平负官方赔率' : '1X2 official odds'
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

  const modelEvaluation = dataSync.modelEvaluation;
  const modelStrategy = modelEvaluation?.strategy;
  const modelGate = modelStrategy?.activation?.promotionGate;
  const modelOnlineEffect = modelStrategy?.activation?.onlineEffect || 'shadow';
  const modelGateStatus = modelGate?.status || modelOnlineEffect || '--';
  const modelGateReasons = modelGate?.reasons || [];
  const modelBaselineRows = modelGate?.sample?.marketBaselineRows
    ?? modelEvaluation?.backtest?.sample?.marketBaselineRows
    ?? 0;
  const modelRequiredRows = modelGate?.thresholds?.minMarketBaselineRows ?? 100;
  const shadowCandidateId = modelEvaluation?.backtest?.shadowCandidates?.bestCandidateId || '--';
  const modelVersionLabel = modelStrategy?.version
    || modelEvaluation?.backtest?.version
    || modelEvaluation?.calibration?.version
    || '--';
  const modelGeneratedAt = modelStrategy?.generatedAt
    || modelEvaluation?.generatedAt
    || modelEvaluation?.backtest?.generatedAt
    || undefined;
  const modelGateTone = modelOnlineEffect === 'guarded-active'
    ? 'is-ready'
    : modelGateStatus === 'shadow'
      ? 'is-warning'
      : 'is-neutral';
  const modelGateLabel = modelOnlineEffect === 'guarded-active'
    ? (language === 'zh' ? '灰度生效' : 'Guarded active')
    : modelGateStatus === 'shadow'
      ? (language === 'zh' ? '影子评估' : 'Shadow only')
      : modelGateStatus;
  const modelGateNote = modelGateReasons.length
    ? modelGateReasons.join('; ')
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
      label: language === 'zh' ? '候选模型' : 'Candidate',
      value: shadowCandidateId,
      note: modelEvaluation?.backtest?.shadowCandidates?.version || '--'
    },
    {
      label: language === 'zh' ? '校准版本' : 'Calibration',
      value: modelEvaluation?.calibration?.version || '--',
      note: modelGeneratedAt ? formatSyncTime(modelGeneratedAt, language) : '--'
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
        ? '数据同步中，正在读取今日赛程与官方赔率。'
        : 'Data is syncing: loading today schedule, official odds, and market snapshots.')
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
          <span>{language === 'zh' ? '竞彩赛程 / 赔率 / 推荐' : 'Schedule / Odds / Picks'}</span>
          <h1>{language === 'zh' ? '足球数据看板' : 'Football Data Board'}</h1>
          <p>
            {language === 'zh'
              ? '核心是赛前推荐校验：展示今日比赛、推荐方向与官方赔率；截止后方向不回改，只做赛果复盘。'
              : 'A pre-match pick board: today fixtures, recommendation direction, and official odds. After cutoff, picks are locked for review only.'}
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

      <section className="daily-review-panel" aria-label={language === 'zh' ? '每日复盘' : 'Daily review'}>
        <div className="daily-review-copy">
          <span className="panel-kicker">{formatShortDate(effectiveSelectedDate, language)}</span>
          <strong>{language === 'zh' ? '每日复盘' : 'Daily Review'}</strong>
          <p>
            {dailyReviewStats.settled > 0
              ? (language === 'zh'
                ? `主推已结算 ${dailyReviewStats.settled} 条，命中 ${dailyReviewStats.won} 条。`
                : `${dailyReviewStats.settled} main picks settled, ${dailyReviewStats.won} won.`)
              : (language === 'zh' ? '等待赛果结算后自动回写命中情况。' : 'Hit results will update automatically after settlement.')}
          </p>
        </div>
        <div className="daily-review-stats">
          <span>
            {language === 'zh' ? '主推命中' : 'Main hit'}
            <strong>{formatDailyRate(dailyReviewStats.hitRate, language)}</strong>
          </span>
          <span>
            {language === 'zh' ? '赛果' : 'Finished'}
            <strong>{dailyReviewStats.finished}</strong>
          </span>
          <span>
            {language === 'zh' ? '让球命中' : 'HHAD hit'}
            <strong>{dailyReviewStats.handicapHit}</strong>
          </span>
          <span>
            {language === 'zh' ? '漏让球' : 'Missed HHAD'}
            <strong>{dailyReviewStats.missedHandicapLane}</strong>
          </span>
        </div>
      </section>

      <section
        className={`data-sync-strip ${dataSyncTone}`}
        data-testid="data-sync-strip"
        data-source-version={dataSync.sourceUpdatedAt || dataSync.updatedAt || ''}
        data-source-stale={String(Boolean(dataSync.sourceStale || hasSourceFallback))}
        data-source-health-ok={String(sourceHealth?.ok !== false)}
        data-model-version={modelVersionLabel}
        aria-label={t('dataStatusTitle')}
      >
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

      <details
        className={`source-health-panel source-health-details ${sourceHealth?.ok === false || hasSourceFallback ? 'is-warning' : 'is-ready'}`}
        data-testid="source-health-panel"
        data-source-health-ok={String(sourceHealth?.ok !== false)}
        data-source-health-checked-at={sourceHealth?.checkedAt || ''}
        data-source-health-fallback={String(hasSourceFallback)}
        aria-label={language === 'zh' ? '数据源状态' : 'Data source status'}
      >
        <summary className="source-health-head">
          <div>
            <strong>{language === 'zh' ? '数据源状态' : 'Data source status'}</strong>
            <span>
              {hasSourceFallback
                ? (language === 'zh'
                  ? `官方源保留快照 · 500补充 ${sourceFallback?.fiveHundredFallbackMatches ?? 0} 场`
                  : `Official source locked · ${sourceFallback?.fiveHundredFallbackMatches ?? 0} from 500.com`)
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

      <section
        className={`model-governance-panel ${modelGateTone}`}
        data-testid="model-governance-panel"
        data-model-version={modelVersionLabel}
        data-model-online-effect={modelOnlineEffect}
        data-model-gate-status={modelGateStatus}
        data-model-baseline-rows={modelBaselineRows}
        aria-label={language === 'zh' ? '模型治理状态' : 'Model governance status'}
      >
        <div className="model-governance-head">
          <div>
            <strong>{language === 'zh' ? '模型治理状态' : 'Model governance'}</strong>
            <span>
              {language === 'zh'
                ? `当前版本 ${modelVersionLabel} / LLM 只做风险复核`
                : `Current version ${modelVersionLabel} / LLM risk review only`}
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
      </section>

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

      {parlayRecommendations.length > 0 && (
        <section className="parlay-panel" aria-label={language === 'zh' ? '自动多串推荐' : 'Auto accumulator picks'}>
          <div className="recommendation-panel-head">
            <div>
              <span className="panel-kicker">{formatShortDate(effectiveSelectedDate, language)}</span>
              <strong>{language === 'zh' ? '多串推荐' : 'Accumulator Picks'}</strong>
            </div>
            <span className="recommendation-count">
              {parlayRecommendations.length} {language === 'zh' ? '组' : 'combos'}
            </span>
          </div>
          <div className="parlay-grid">
            {parlayRecommendations.map(renderParlayCard)}
          </div>
        </section>
      )}

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
                      const oddsFallback = poolRows.length > 0 ? null : getHomePageOddsFallback(match, language);
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
                            ) : oddsFallback ? (
                              <div className="odds-sp-fallback">
                                <span>{oddsFallback.label}</span>
                                <strong>{oddsFallback.odds.toFixed(2)}</strong>
                                <em>{oddsFallback.marketLabel} · {oddsFallback.tipLabel}</em>
                              </div>
                            ) : (
                              <span className="status-note">{language === 'zh' ? '赔率待开售' : 'Odds pending'}</span>
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
