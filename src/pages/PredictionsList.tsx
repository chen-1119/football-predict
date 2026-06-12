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
import { getImpliedProbabilities, getPredictionTipDisplay, getPredictionValueLabel, getResolvedMatchOdds, getSportteryPoolRows } from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal, isActionableRecommendation, type MatchSignalCategory } from '../services/matchSignal';
import { getVisiblePrediction, getVisiblePredictions } from '../services/predictionVisibility';
import { TeamBadge } from '../components/TeamBadge';
import { WorldCupSpotlight } from '../components/WorldCupSpotlight';

interface PredictionsListProps {
  onSelectMatch: (matchId: string) => void;
  onOpenWorldCup: () => void;
}

type SortBy = 'time' | 'odds';
type SignalFilter = 'recommended' | 'all' | MatchSignalCategory;

const SORT_OPTIONS: SortBy[] = ['time', 'odds'];
const SIGNAL_FILTERS: SignalFilter[] = ['recommended', 'all', 'steady', 'lean', 'value', 'watch', 'avoid', 'unavailable', 'finished'];

const getKickoffDay = (match: Match): string => match.kickoffDate || match.kickoffTime.slice(0, 10) || match.matchDate || '';

const getSportteryDay = (match: Match): string => match.businessDate || getKickoffDay(match) || '';

const getMatchDateCandidates = (match: Match): string[] => {
  const sportteryDay = getSportteryDay(match);
  const kickoffDay = getKickoffDay(match);
  // Sporttery issue day is the sale/listing day; late-night matches can kick off on the next calendar day.
  return Array.from(new Set([sportteryDay, kickoffDay].filter(Boolean)));
};

const matchBelongsToDate = (match: Match, date: string) => getMatchDateCandidates(match).includes(date);

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
  const resolvedOdds = getResolvedMatchOdds(match);
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
  const label = getPredictionTipDisplay(prediction, language, compact);
  if (!isReferenceOnlyPrediction(prediction)) return label;

  if (language === 'zh') {
    const normalized = label.replace(/^参考推荐/, '参考倾向');
    if (normalized.startsWith('参考倾向')) return normalized;
    return `参考倾向 ${normalized.replace(/^(模型首选|价值观察|高可信)\s*/, '')}`;
  }

  return label.startsWith('Reference lean')
    ? label
    : `Reference lean ${label.replace(/^Reference pick\s*/i, '')}`;
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
  const labels = [
    match.matchNo,
    match.businessDate
      ? `${language === 'zh' ? '竞彩日' : 'Sporttery'} ${formatShortDate(match.businessDate, language)}`
      : ''
  ].filter(Boolean);

  return labels.join(' · ');
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

const getOutcomeProbability = (match: Match, code: OutcomeCode) => {
  const final = match.probabilityModel?.oneXTwo?.final || match.probabilityModel?.oneXTwo?.market;
  if (!final) return null;
  const value = code === '1' ? final.home : code === 'X' ? final.draw : final.away;
  return Number.isFinite(value) ? Number(value) : null;
};

const getLeadingOutcome = (match: Match) => {
  const entries = (['1', 'X', '2'] as OutcomeCode[])
    .map((code) => ({ code, probability: getOutcomeProbability(match, code) }))
    .filter((item): item is { code: OutcomeCode; probability: number } => item.probability !== null)
    .sort((a, b) => b.probability - a.probability);

  return entries[0] || null;
};

const getHandicapSupport = (match: Match, code: string | undefined) => {
  if (!isOutcomeCode(code)) return null;
  const probabilities = getImpliedProbabilities(getResolvedMatchOdds(match).hhad?.odds);
  if (!probabilities) return null;
  return code === '1' ? probabilities.home : code === 'X' ? probabilities.draw : probabilities.away;
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

const getDecisionReason = (category: MatchSignalCategory, language: 'zh' | 'en') => {
  const reasons: Record<MatchSignalCategory, Record<'zh' | 'en', string>> = {
    steady: { zh: '赔率、概率和风险基本同向', en: 'Odds, probability, and risk align' },
    lean: { zh: '有主方向，但不当稳胆', en: 'Main lean, not a banker' },
    value: { zh: '盘口分歧下的价值方向', en: 'Value direction under market disagreement' },
    watch: { zh: '条件未齐，等临场SP/让球确认', en: 'Conditions not aligned; wait for late SP/handicap' },
    avoid: { zh: '风险叠加，暂不入选', en: 'Risk stacked; skip for now' },
    unavailable: { zh: '待官方SP更新', en: 'Waiting for official SP' },
    finished: { zh: '保留赛前预测，按赛果复盘', en: 'Pre-match pick kept for review' }
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
    signalTitle: { zh: '推荐分组', en: 'Signal' },
    recommended: { zh: '精选推荐', en: 'Qualified picks' },
    allSignals: { zh: '全部分组', en: 'All Signals' },
    steady: { zh: '高可信候选', en: 'High confidence' },
    lean: { zh: '主推候选', en: 'Model lean' },
    value: { zh: '价值观察', en: 'Value watch' },
    watch: { zh: '观察', en: 'Watch' },
    avoid: { zh: '避坑', en: 'Avoid' },
    unavailable: { zh: '待开售', en: 'Pending' },
    sortTitle: { zh: '排序', en: 'Sort' },
    time: { zh: '开赛时间', en: 'Time' },
    trust: { zh: '可信度', en: 'Trust' },
    odds: { zh: 'SP 值', en: 'Odds' },
    reset: { zh: '重置', en: 'Reset' },
    noMatches: { zh: '这个日期暂无可用比赛预测。', en: 'No scheduled matches found for this day.' },
    noQualifiedPicks: { zh: '本期没有达到精选门槛的推荐，先不硬推。可切到全部分组查看观察名单。', en: 'No pick passes the quality gate for this issue. Switch to all signals for the watchlist.' },
    yesterday: { zh: '昨天', en: 'Yesterday' },
    today: { zh: '今天', en: 'Today' },
    tomorrow: { zh: '明天', en: 'Tomorrow' },
    dayAfterTomorrow: { zh: '后天', en: 'Day +2' },
    finished: { zh: '已完场', en: 'Finished' },
    live: { zh: '进行中', en: 'Live' },
    pending: { zh: '待开赛', en: 'Scheduled' },
    details: { zh: '详情', en: 'Details' },
    hitRate: { zh: '已结算精选命中率', en: 'Settled Best Hit Rate' },
    selectedMatches: { zh: '当前筛选场次', en: 'Filtered Matches' },
    signalSummary: { zh: '推荐分组', en: 'Signal Split' },
    avgTrust: { zh: '今日状态', en: 'Today Status' },
    riskPaused: { zh: '风控暂停', en: 'Risk paused' },
    riskPausedNote: { zh: '无达标方向，等待下一轮 SP/盘口', en: 'No qualified pick; wait for next SP/handicap check' },
    hitCooling: { zh: '命中冷却', en: 'Cooling' },
    hitCoolingNote: { zh: '精选命中偏低，暂不放宽筛选', en: 'Best-tip hit rate is low; filters stay tight' },
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
    oddsHeader: { zh: '胜平负 / 让球', en: '1X2 / Handicap' },
    closed: { zh: '未开售', en: 'Closed' },
    archivedOdds: { zh: '赛果归档', en: 'Archived' },
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
      if (isActionableRecommendation(match)) counts.recommended += 1;
      counts[signal.category] += 1;
      return counts;
    }, { recommended: 0, all: 0, steady: 0, lean: 0, value: 0, watch: 0, avoid: 0, unavailable: 0, finished: 0 });
  }, [baseFilteredMatches]);

  const recommendationCounts = useMemo(() => {
    return baseFilteredMatches.reduce((counts, match) => {
      const signal = getMatchSignal(match);
      const best = getBestPrediction(match);
      if (signal.category === 'finished') {
        counts.finished += 1;
      } else if (isActionableRecommendation(match) && best && best.tipCode !== 'WATCH') {
        counts.pick += 1;
      } else if (signal.category === 'avoid') {
        counts.avoid += 1;
      } else if (best && best.tipCode !== 'WATCH') {
        counts.reference += 1;
      } else {
        counts.unavailable += 1;
      }
      return counts;
    }, { pick: 0, reference: 0, avoid: 0, unavailable: 0, finished: 0 });
  }, [baseFilteredMatches]);

  const visibleSignalFilters = useMemo(() => {
    return SIGNAL_FILTERS.filter((filter) => filter === 'recommended' || filter === 'all' || signalCounts[filter] > 0 || signalFilter === filter);
  }, [signalCounts, signalFilter]);

  const filteredMatches = useMemo(() => {
    if (signalFilter === 'recommended') return baseFilteredMatches.filter(isActionableRecommendation);
    if (signalFilter === 'all') return baseFilteredMatches;
    return baseFilteredMatches.filter((match) => getMatchSignal(match).category === signalFilter);
  }, [baseFilteredMatches, signalFilter]);

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
      .filter(isActionableRecommendation)
      .sort((a, b) => {
        const trustDiff = getBestTrust(b) - getBestTrust(a);
        if (Math.abs(trustDiff) > 0) return trustDiff;
        return Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime);
      });
  }, [baseFilteredMatches]);

  const watchlistMatches = useMemo(() => {
    return baseFilteredMatches
      .filter((match) => !isActionableRecommendation(match) && match.status === 'SCHEDULED')
      .sort((a, b) => {
        const score = (match: Match) => {
          const signal = getMatchSignal(match);
          const categoryScore: Record<MatchSignalCategory, number> = {
            steady: 90,
            lean: 80,
            value: 70,
            watch: 50,
            avoid: 20,
            unavailable: 10,
            finished: 0
          };
          const hasOdds = match.odds || match.handicapOdds ? 8 : 0;
          return (categoryScore[signal.category] || 0) + getBestTrust(match) + hasOdds - signal.riskCount * 3;
        };
        const scoreDiff = score(b) - score(a);
        if (Math.abs(scoreDiff) > 0) return scoreDiff;
        return Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime);
      })
      .slice(0, 3);
  }, [baseFilteredMatches]);

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

  const renderRecommendationCard = (match: Match, mode: 'pick' | 'watch') => {
    const homeTeam = getMatchDisplayTeam(match, 'home');
    const awayTeam = getMatchDisplayTeam(match, 'away');
    const signal = getMatchSignal(match);
    const best = getBestPrediction(match);
    const leadingOutcome = getLeadingOutcome(match);
    const poolRows = getSportteryPoolRows(match, language).filter((row) => row.odds);
    const fallbackDirectionLabel = leadingOutcome ? outcomeLabels[leadingOutcome.code][language] : '';
    const hasReferenceLean = Boolean((best && best.tipCode !== 'WATCH') || fallbackDirectionLabel);
    const isPromotedPick = mode === 'pick' && hasReferenceLean && isActionableRecommendation(match);
    const isReferenceOnly = isReferenceOnlyPrediction(best);
    const directionLabel = best
      ? stripDirectionPrefix(getRecommendationTipDisplay(best, language, true), language)
      : fallbackDirectionLabel;
    const referenceLeanText = hasReferenceLean && !isPromotedPick && best
      ? language === 'zh'
        ? `状态：${signal.category === 'avoid' ? '避开观察' : '不进精选池'}`
        : `Status: ${signal.category === 'avoid' ? 'avoid watch' : 'not in top pool'}`
      : '';
    const cautionText = signal.category === 'avoid'
      ? (language === 'zh' ? '风险偏高，降低优先级' : 'Higher risk; lower priority')
      : (language === 'zh' ? '等待临场 SP/让球确认' : 'Await late SP/handicap check');
    const pickText = hasReferenceLean && best
      ? language === 'zh'
        ? `${isPromotedPick ? '推荐方向' : '参考倾向'} ${directionLabel}`
        : `${isPromotedPick ? 'Pick' : 'Reference lean'} ${directionLabel}`
      : signal.category === 'avoid'
        ? (language === 'zh' ? '参考倾向待确认' : 'Reference lean pending')
        : (language === 'zh' ? '等待确认，暂不精选' : 'Await confirmation');
    const statusBadge = isPromotedPick
      ? (language === 'zh' ? '进精选池' : 'Top pool')
      : signal.category === 'avoid'
        ? (language === 'zh' ? '避开观察' : 'Avoid watch')
        : (language === 'zh' ? '不进精选池' : 'Not in top pool');
    const oddsText = poolRows.length > 0
      ? poolRows.slice(0, 2).map((row) => {
        const label = row.poolCode === 'HHAD'
          ? (language === 'zh' ? '让球' : 'HHAD')
          : (language === 'zh' ? '胜平负' : '1X2');
        return row.odds
          ? `${label} ${row.odds.odds1.toFixed(2)}/${row.odds.oddsX.toFixed(2)}/${row.odds.odds2.toFixed(2)}`
          : '';
      }).filter(Boolean).join(' · ')
      : (language === 'zh' ? '未开售' : 'Closed');
    const reason = isPromotedPick
      ? signal.note[language]
      : isReferenceOnly
        ? (language === 'zh'
          ? '主方向保留，但风控未通过精选门槛，仅作参考。'
          : 'The main direction is kept, but the risk gate did not pass, so it remains reference only.')
        : getDecisionReason(signal.category, language);

    return (
      <button
        key={match.id}
        type="button"
        className={`recommendation-card is-${mode} is-${signal.category}`}
        onClick={() => onSelectMatch(match.id)}
      >
        <span className="recommendation-time">
          {formatKickoffTime(match.kickoffTime, language)}
          {match.matchNo ? ` · ${match.matchNo}` : ''}
        </span>
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
        {referenceLeanText && (
          <span className="recommendation-reference-lean">{referenceLeanText}</span>
        )}
        {mode === 'watch' && (
          <span className={`recommendation-caution is-${signal.category}`}>{cautionText}</span>
        )}
        <span className="recommendation-odds">{oddsText}</span>
        <span className="recommendation-reason">{reason}</span>
      </button>
    );
  };

  const renderDecisionCell = (match: Match) => {
    const isFinished = match.status === 'FINISHED';
    const signal = getMatchSignal(match);
    const best = getVisiblePrediction(match, 'BEST');
    const oneXTwo = getVisiblePrediction(match, '1X2');
    const pickedPrediction = [best, oneXTwo].find((prediction) => prediction && prediction.tipCode !== 'WATCH');
    const leadingOutcome = getLeadingOutcome(match);
    const leadProbability = pickedPrediction && isOutcomeCode(pickedPrediction.tipCode)
      ? getOutcomeProbability(match, pickedPrediction.tipCode)
      : leadingOutcome?.probability ?? null;
    const leadCode = pickedPrediction && isOutcomeCode(pickedPrediction.tipCode)
      ? pickedPrediction.tipCode
      : leadingOutcome?.code;
    const handicapSupport = getHandicapSupport(match, leadCode);
    const riskTags = getRiskTags(match);
    const showHit = isFinished && pickedPrediction?.resultStatus === 'WON';
    const showMiss = isFinished && pickedPrediction?.resultStatus === 'LOST';
    const isReferencePick = isReferenceOnlyPrediction(pickedPrediction);
    const isPromotedPick = !isFinished && isActionableRecommendation(match);
    const poolStatus = isPromotedPick
      ? (language === 'zh' ? '进精选池' : 'Top pool')
      : signal.category === 'avoid'
        ? (language === 'zh' ? '避开观察' : 'Avoid watch')
        : (language === 'zh' ? '不进精选池' : 'Not in top pool');
    const directionLabel = pickedPrediction
      ? stripDirectionPrefix(getRecommendationTipDisplay(pickedPrediction, language, true), language)
      : '';
    const primaryLabel = pickedPrediction
      ? language === 'zh'
        ? `${isPromotedPick ? '推荐方向' : '参考倾向'} ${directionLabel}`
        : `${isPromotedPick ? 'Pick' : 'Reference lean'} ${directionLabel}`
      : leadingOutcome
        ? language === 'zh'
          ? `参考倾向 ${outcomeLabels[leadingOutcome.code][language]}`
          : `Reference lean ${outcomeLabels[leadingOutcome.code][language]}`
      : signal.category === 'finished'
        ? (language === 'zh' ? '赛后复盘' : 'Review')
        : signal.category === 'avoid'
          ? (language === 'zh' ? '普通参考，暂不精选' : 'Reference only')
          : (language === 'zh' ? '等待确认，暂不精选' : 'Await confirmation');
    const primaryMeta = pickedPrediction && pickedPrediction.odds > 0
      ? `${getPredictionValueLabel(pickedPrediction, language)} ${pickedPrediction.odds.toFixed(2)}`
      : leadCode && leadProbability !== null
        ? `${outcomeLabels[leadCode][language]} ${Math.round(leadProbability)}%`
        : '--';
    const shortReason = pickedPrediction
      ? isReferencePick
        ? signal.category === 'avoid'
          ? (language === 'zh' ? '不进精选池：风险项偏多，但保留模型参考方向' : 'Not in top pool: risk is high, but keep the model direction')
          : (language === 'zh' ? '不进精选池：普通推荐，等临场SP/让球确认' : 'Not in top pool: reference pick, await late SP/handicap')
        : signal.category === 'steady'
          ? (language === 'zh' ? '主线、概率和风险基本同向' : 'Main line, probability, and risk are aligned')
          : signal.category === 'value'
            ? (language === 'zh' ? '价值方向，不当稳胆；看临场SP/让球' : 'Value direction, not a banker; track late SP/handicap')
            : (language === 'zh' ? '有主方向，但不当稳胆；看临场SP/让球' : 'Main lean, not a banker; track late SP/handicap')
      : getDecisionReason(signal.category, language);

    return (
      <div className={`decision-card is-${signal.category} ${pickedPrediction ? 'has-pick' : 'is-watch-only'} ${isReferencePick ? 'is-reference' : ''} ${showHit ? 'is-hit' : ''} ${showMiss ? 'is-miss' : ''}`}>
        <div className="decision-main">
          <span className="decision-label">{primaryLabel}</span>
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
            {language === 'zh' ? '让球' : 'HHAD'}
            <strong>{handicapSupport === null ? '--' : `${handicapSupport}%`}</strong>
          </span>
          <span>
            {language === 'zh' ? '状态' : 'Status'}
            <strong>{poolStatus}</strong>
          </span>
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
    ? `官方源本轮不可用，当前为锁定快照 + 500 校验；不展示 mock 样例。`
    : `Official source is unavailable this run; showing a locked snapshot plus 500.com checks, with no mock samples.`;

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
      label: t('dataUpdated'),
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
  const officialOddsCount = activeSourceMatches.filter((match) => match.odds || match.handicapOdds).length;
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
      note: language === 'zh' ? 'HAD / HHAD 官方SP' : 'HAD / HHAD official SP'
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
      label: language === 'zh' ? '今日比赛' : 'Today',
      value: `${baseFilteredMatches.length} ${t('matchUnit')}`
    },
    {
      label: language === 'zh' ? '预测锁定' : 'Lock',
      value: language === 'zh' ? '按竞彩截止' : 'By cutoff'
    }
  ];

  const metrics = [
    {
      label: language === 'zh' ? '今日比赛' : 'Today Matches',
      value: String(baseFilteredMatches.length),
      note: language === 'zh'
        ? `${formatShortDate(effectiveSelectedDate, language)} · 按开赛时间排序`
        : `${formatShortDate(effectiveSelectedDate, language)} · sorted by kickoff`,
      icon: CalendarDays,
      tone: 'accent'
    },
    {
      label: language === 'zh' ? '精选推荐' : 'Qualified Picks',
      value: String(recommendationCounts.pick),
      note: language === 'zh' ? '模型、SP、让球与风险同时通过' : 'Model, SP, handicap, and risk all pass',
      icon: ShieldCheck,
      tone: 'success'
    },
    {
      label: language === 'zh' ? '参考推荐' : 'Reference Picks',
      value: String(recommendationCounts.reference),
      note: language === 'zh' ? '有方向，但不进精选池' : 'Has a lean, outside top pool',
      icon: Sparkles,
      tone: 'premium'
    },
    {
      label: language === 'zh' ? '避开观察' : 'Avoid Watch',
      value: String(recommendationCounts.avoid),
      note: recommendationCounts.unavailable > 0
        ? (language === 'zh' ? `另有 ${recommendationCounts.unavailable} 场待开售/待确认` : `${recommendationCounts.unavailable} pending sale/confirmation`)
        : (language === 'zh' ? '风险标签触发，降低优先级' : 'Risk tags triggered, lower priority'),
      icon: Activity,
      tone: recommendationCounts.avoid > 0 ? 'danger' : ''
    }
  ];

  const emptyStateText = isCurrentDataLoading
    ? (language === 'zh'
      ? '数据同步中，正在读取今日赛程、官方 SP 与盘口快照。'
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
          <span>{language === 'zh' ? '竞彩赛程 / SP / 盘口 / AI 决策' : 'Schedule / SP / Handicap / AI Decision'}</span>
          <h1>{language === 'zh' ? '足球数据看板' : 'Football Data Board'}</h1>
          <p>
            {language === 'zh'
              ? '核心是赛前决策校验：展示今日比赛、模型方向、官方 SP 与让球验证；截止后预测不回改，只做赛果复盘。'
              : 'A pre-match decision board: today fixtures, model lean, official SP, and handicap validation. After cutoff, predictions are locked for review only.'}
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

      <section className={`recommendation-panel ${actionableMatches.length === 0 ? 'is-empty' : ''}`} aria-label={t('recommended')}>
        <div className="recommendation-panel-head">
          <div>
            <span className="panel-kicker">{formatShortDate(effectiveSelectedDate, language)}</span>
            <strong>{language === 'zh' ? '精选推荐池' : 'Qualified Pick Pool'}</strong>
          </div>
          <span className="recommendation-count">
            {actionableMatches.length} {language === 'zh' ? '场达标' : 'qualified'}
          </span>
        </div>

        {actionableMatches.length > 0 ? (
          <div className="recommendation-grid">
            {actionableMatches.slice(0, 3).map((match) => renderRecommendationCard(match, 'pick'))}
          </div>
        ) : (
          <div className="recommendation-empty-copy">
            <strong>{language === 'zh' ? '本期不硬推' : 'No forced pick'}</strong>
            <span>
              {language === 'zh'
                ? '官方 SP、概率优势、让球验证或近期命中冷却未同时过线，先保留观察。'
                : 'Official SP, probability edge, handicap check, or hit-rate cooling did not pass together.'}
            </span>
          </div>
        )}

        {watchlistMatches.length > 0 && (
          <div className="watchlist-strip">
            <span>{language === 'zh' ? '普通参考（不进精选池）' : 'Reference picks outside top pool'}</span>
            <div className="watchlist-row">
              {watchlistMatches.map((match) => renderRecommendationCard(match, 'watch'))}
            </div>
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
                      const poolRows = getSportteryPoolRows(match, language);
                      const signal = getMatchSignal(match);
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
                                <span className={`signal-badge ${isFinished ? 'is-finished' : `is-${signal.category}`}`}>
                                  {isFinished ? t('finished') : isPendingResult ? t('awaitingResult') : signal.label[language]}
                                </span>
                                {!isFinished && signal.riskCount > 0 && (
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
                                  <span>{language === 'zh' ? '让球' : 'Line'}</span>
                                  <span>{language === 'zh' ? '胜' : 'H'}</span>
                                  <span>{language === 'zh' ? '平' : 'D'}</span>
                                  <span>{language === 'zh' ? '负' : 'A'}</span>
                                  <span>{language === 'zh' ? '支持率' : 'Prob.'}</span>
                                </div>
                                {poolRows.map((row) => (
                                  <div key={row.poolCode} className={`sporttery-pool-row ${row.odds ? '' : 'is-closed'}`}>
                                    <span className="pool-line">{row.handicap || '--'}</span>
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
                                ))}
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
