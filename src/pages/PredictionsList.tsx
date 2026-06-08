import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BarChart3,
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
import type { Country, League, Match, PredictionDetail } from '../services/mockData';
import { getImpliedProbabilities, getPredictionTipDisplay, getPredictionValueLabel, getSportteryPoolRows } from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal, type MatchSignalCategory } from '../services/matchSignal';
import { getVisiblePrediction, getVisiblePredictions } from '../services/predictionVisibility';
import { TeamBadge } from '../components/TeamBadge';
import { WorldCupSpotlight } from '../components/WorldCupSpotlight';

interface PredictionsListProps {
  onSelectMatch: (matchId: string) => void;
  onOpenWorldCup: () => void;
}

type SortBy = 'time' | 'trust' | 'odds';
type SignalFilter = 'all' | MatchSignalCategory;

const SORT_OPTIONS: SortBy[] = ['time', 'trust', 'odds'];
const SIGNAL_FILTERS: SignalFilter[] = ['all', 'steady', 'lean', 'value', 'watch', 'avoid', 'unavailable', 'finished'];

const getKickoffDay = (match: Match): string => match.kickoffDate || match.kickoffTime.slice(0, 10) || match.matchDate || '';

const getSportteryDay = (match: Match): string => match.businessDate || getKickoffDay(match) || '';

const getMatchDay = (match: Match): string => getSportteryDay(match);

const isActiveResultStatus = (match: Match) => match.status === 'LIVE' || match.status === 'PENDING_RESULT';

const matchBelongsToDate = (match: Match, date: string) => (
  getMatchDay(match) === date ||
  (isActiveResultStatus(match) && getKickoffDay(match) === date)
);

const getBestPrediction = (match: Match) => getVisiblePrediction(match, 'BEST');

const getBestTrust = (match: Match) => getBestPrediction(match)?.trustScore || 0;

const getBestOdds = (match: Match) => getBestPrediction(match)?.odds || match.odds?.odds1 || match.handicapOdds?.odds1 || 0;

const isScoredPrediction = (prediction: PredictionDetail) => (
  prediction.resultStatus !== 'PENDING' && prediction.tipCode !== 'WATCH'
);

const getTrustColor = (score: number) => {
  if (score >= 80) return '156 70% 44%';
  if (score >= 68) return '41 88% 56%';
  return '196 76% 48%';
};

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
  const probabilities = getImpliedProbabilities(match.handicapOdds);
  if (!probabilities) return null;
  return code === '1' ? probabilities.home : code === 'X' ? probabilities.draw : probabilities.away;
};

const getGoalsLean = (match: Match, language: 'zh' | 'en') => {
  const over25 = match.probabilityModel?.goalLines?.over25;
  const under25 = match.probabilityModel?.goalLines?.under25;
  if (!Number.isFinite(over25) || !Number.isFinite(under25)) {
    return language === 'zh' ? '进球待观察' : 'Goals watch';
  }

  const isOver = Number(over25) >= Number(under25);
  const probability = Math.round(isOver ? Number(over25) : Number(under25));
  const label = language === 'zh'
    ? (isOver ? '≥3球' : '≤2球')
    : (isOver ? 'Over 2.5' : 'Under 2.5');

  if (probability < 60) {
    return language === 'zh'
      ? `观察 ${label} ${probability}%`
      : `Watch ${label} ${probability}%`;
  }

  return `${label} ${probability}%`;
};

const getBttsLean = (match: Match, language: 'zh' | 'en') => {
  const yes = match.probabilityModel?.bothTeamsToScore?.yes;
  const no = match.probabilityModel?.bothTeamsToScore?.no;
  if (!Number.isFinite(yes) || !Number.isFinite(no)) return '';
  const isYes = Number(yes) >= Number(no);
  const probability = Math.round(isYes ? Number(yes) : Number(no));
  if (probability < 58) return '';
  return language === 'zh'
    ? `双方进球${isYes ? '是' : '否'} ${probability}%`
    : `BTTS ${isYes ? 'Yes' : 'No'} ${probability}%`;
};

const getRiskTags = (match: Match, limit = 2) => {
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
  const activeOfficialDate = useMemo(() => {
    const activeByKickoffDay = matches
      .filter((match) => isActiveResultStatus(match))
      .map(getKickoffDay)
      .filter(Boolean)
      .sort()[0];

    if (activeByKickoffDay) return activeByKickoffDay;

    return matches
      .filter((match) => match.status !== 'FINISHED')
      .map(getMatchDay)
      .filter(Boolean)
      .sort()[0] || '';
  }, [matches]);
  const todayStr = systemTodayStr;
  const yesterdayStr = offsetDateString(todayStr, -1);
  const tomorrowStr = offsetDateString(todayStr, 1);
  const dayAfterTomorrowStr = offsetDateString(todayStr, 2);

  const [selectedDate, setSelectedDate] = useState<string>(() => getDateStringOffset(0));
  const [hasManualDateSelection, setHasManualDateSelection] = useState(false);
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
    avgTrust: { zh: '推荐池健康', en: 'Pick Pool Health' },
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
    dataFallback: { zh: '本地兜底', en: 'Fallback' },
    dataUpdated: { zh: '数据源', en: 'Source' },
    dataRefresh: { zh: '页面自检', en: 'Page check' },
    dataNextCheck: { zh: '下次检查', en: 'Next check' },
    dataCurrentLoading: { zh: '正在加载中国竞彩网赛程', en: 'Loading Sporttery schedule' },
    dataHistoryLoading: { zh: '历史结果后台补齐中', en: 'History loading in background' },
    dataHistoryReady: { zh: '当前赛程与历史库已就绪', en: 'Current schedule and history are ready' },
    dataHistoryUnavailable: { zh: '当前赛程已就绪，历史库暂不可用', en: 'Current schedule ready, history unavailable' },
    dataFallbackNote: { zh: '官方数据暂不可用，已启用兜底数据', en: 'Official data unavailable, using fallback' },
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
    trustHeader: { zh: '可用度', en: 'Usability' },
    hit: { zh: '命中', en: 'Hit' },
    miss: { zh: '未中', en: 'Miss' },
    leagueMatches: { zh: '场比赛', en: 'matches' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';
  const getSignalFilterLabel = (filter: SignalFilter) => {
    if (filter === 'all') return t('allSignals');
    return translations[filter][language];
  };

  const selectedDateHasMatches = matches.some((match) => matchBelongsToDate(match, selectedDate));
  const nextAvailableDate = matches
    .map(getMatchDay)
    .filter((date) => date >= todayStr)
    .sort()[0] || selectedDate;
  const effectiveSelectedDate = !hasManualDateSelection && activeOfficialDate
    ? activeOfficialDate
    : selectedDateHasMatches || selectedDate !== todayStr
      ? selectedDate
      : nextAvailableDate;

  const availableLeagues = useMemo(() => {
    const seen = new Set<string>();
    const matchesForDate = matches.filter((match) => matchBelongsToDate(match, effectiveSelectedDate));
    const source = matchesForDate.length > 0
      ? matchesForDate.map((match) => match.leagueId)
      : leagues.map((league) => league.id);

    return source.reduce<League[]>((list, leagueId) => {
      if (seen.has(leagueId)) return list;
      seen.add(leagueId);
      list.push(getLeagueById(leagueId));
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
      counts[signal.category] += 1;
      return counts;
    }, { all: 0, steady: 0, lean: 0, value: 0, watch: 0, avoid: 0, unavailable: 0, finished: 0 });
  }, [baseFilteredMatches]);

  const recommendationCounts = useMemo(() => {
    return baseFilteredMatches.reduce((counts, match) => {
      const signal = getMatchSignal(match);
      const best = getBestPrediction(match);
      if (signal.category === 'finished') {
        counts.finished += 1;
      } else if (signal.category === 'avoid') {
        counts.avoid += 1;
      } else if ((signal.category === 'steady' || signal.category === 'lean' || signal.category === 'value') && best && best.tipCode !== 'WATCH') {
        counts.pick += 1;
      } else {
        counts.watch += 1;
      }
      return counts;
    }, { pick: 0, watch: 0, avoid: 0, finished: 0 });
  }, [baseFilteredMatches]);

  const visibleSignalFilters = useMemo(() => {
    return SIGNAL_FILTERS.filter((filter) => filter === 'all' || signalCounts[filter] > 0 || signalFilter === filter);
  }, [signalCounts, signalFilter]);

  const filteredMatches = useMemo(() => {
    if (signalFilter === 'all') return baseFilteredMatches;
    return baseFilteredMatches.filter((match) => getMatchSignal(match).category === signalFilter);
  }, [baseFilteredMatches, signalFilter]);

  const sortedMatches = useMemo(() => {
    const sorted = [...filteredMatches];

    sorted.sort((a, b) => {
      let comparison: number;

      if (sortBy === 'time') {
        comparison = new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime();
      } else if (sortBy === 'trust') {
        comparison = getBestTrust(a) - getBestTrust(b);
      } else {
        comparison = getBestOdds(a) - getBestOdds(b);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [filteredMatches, sortBy, sortOrder]);

  const groupedMatches = useMemo(() => {
    const groups: Record<string, { league: League; country: Country; matches: Match[] }> = {};

    sortedMatches.forEach((match) => {
      const key = `${match.countryId}_${match.leagueId}`;

      if (!groups[key]) {
        groups[key] = {
          league: getLeagueById(match.leagueId),
          country: getCountryById(match.countryId),
          matches: []
        };
      }

      groups[key].matches.push(match);
    });

    return Object.values(groups);
  }, [sortedMatches]);

  const settledBestPredictions = useMemo(() => {
    return matches
      .flatMap((match) => getVisiblePredictions(match))
      .filter((prediction) => prediction.marketType === 'BEST')
      .filter(isScoredPrediction);
  }, [matches]);

  const settledBestStats = useMemo(() => {
    if (settledBestPredictions.length === 0) {
      return { total: 0, won: 0, lost: 0, hitRate: null as number | null };
    }
    const won = settledBestPredictions.filter((prediction) => prediction.resultStatus === 'WON').length;
    const lost = settledBestPredictions.length - won;
    return {
      total: settledBestPredictions.length,
      won,
      lost,
      hitRate: (won / settledBestPredictions.length) * 100
    };
  }, [settledBestPredictions]);
  const settledBestLoading = dataSync.historyLoading && !dataSync.historyLoaded && settledBestPredictions.length === 0;
  const bestHitCooling = settledBestStats.total >= 5 && settledBestStats.hitRate !== null && settledBestStats.hitRate < 45;

  const avgTrust = useMemo(() => {
    const trustScores = sortedMatches.map(getBestTrust).filter((score) => score > 0);
    if (trustScores.length === 0) return null;
    const total = trustScores.reduce((sum, score) => sum + score, 0);
    return Math.round(total / trustScores.length);
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

  const renderDecisionCell = (match: Match) => {
    const isFinished = match.status === 'FINISHED';
    const signal = getMatchSignal(match);
    const best = getVisiblePrediction(match, 'BEST');
    const oneXTwo = getVisiblePrediction(match, '1X2');
    const goals = getVisiblePrediction(match, 'GOALS');
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
    const goalsText = goals && goals.tipCode !== 'WATCH'
      ? getPredictionTipDisplay(goals, language, true)
      : getGoalsLean(match, language);
    const bttsText = getBttsLean(match, language);
    const primaryLabel = pickedPrediction
      ? getPredictionTipDisplay(pickedPrediction, language, true)
      : signal.category === 'finished'
        ? (language === 'zh' ? '赛后复盘' : 'Review')
        : signal.category === 'avoid'
          ? (language === 'zh' ? '避开，不硬上' : 'Avoid')
          : (language === 'zh' ? '观察，不下手' : 'Watch, no bet');
    const primaryMeta = pickedPrediction && pickedPrediction.odds > 0
      ? `${getPredictionValueLabel(pickedPrediction, language)} ${pickedPrediction.odds.toFixed(2)}`
      : leadCode && leadProbability !== null
        ? `${outcomeLabels[leadCode][language]} ${Math.round(leadProbability)}%`
        : '--';
    const shortReason = pickedPrediction
      ? signal.category === 'steady'
        ? (language === 'zh' ? '主线、概率和风险基本同向' : 'Main line, probability, and risk are aligned')
        : signal.category === 'value'
          ? (language === 'zh' ? '价值方向，不当稳胆；看临场SP/让球' : 'Value direction, not a banker; track late SP/handicap')
          : (language === 'zh' ? '有主方向，但不当稳胆；看临场SP/让球' : 'Main lean, not a banker; track late SP/handicap')
      : getDecisionReason(signal.category, language);

    return (
      <div className={`decision-card is-${signal.category} ${pickedPrediction ? 'has-pick' : 'is-watch-only'} ${showHit ? 'is-hit' : ''} ${showMiss ? 'is-miss' : ''}`}>
        <div className="decision-main">
          <span className="decision-label">{primaryLabel}</span>
          <span className="decision-meta">{primaryMeta}</span>
          {showHit && <span className="mini-hit">{t('hit')}</span>}
          {showMiss && <span className="mini-miss">{t('miss')}</span>}
        </div>

        <div className="decision-facts">
          <span>
            {language === 'zh' ? '让球' : 'HHAD'}
            <strong>{handicapSupport === null ? '--' : `${handicapSupport}%`}</strong>
          </span>
          <span>
            {language === 'zh' ? '进球' : 'Goals'}
            <strong>{goalsText}</strong>
          </span>
          {bttsText && (
            <span>
              {language === 'zh' ? '双方' : 'BTTS'}
              <strong>{bttsText.replace(/^双方进球/, '').replace(/^BTTS\s/, '')}</strong>
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
      .flatMap((match) => [getMatchDay(match), isActiveResultStatus(match) ? getKickoffDay(match) : ''])
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

  const metrics = [
    {
      label: t('hitRate'),
      value: settledBestLoading
        ? '...'
        : settledBestStats.hitRate !== null ? `${settledBestStats.hitRate.toFixed(1)}%` : '--',
      note: settledBestLoading
        ? (language === 'zh' ? '历史复盘加载中' : 'Loading review history')
        : settledBestStats.total > 0
          ? `${settledBestStats.won}/${settledBestStats.total} ${language === 'zh' ? '命中' : 'won'} · ${settledBestStats.total} ${t('settledPicks')}`
          : `0 ${t('settledPicks')}`,
      icon: BarChart3,
      tone: bestHitCooling ? 'danger' : 'success'
    },
    {
      label: t('selectedMatches'),
      value: String(sortedMatches.length),
      note: formatShortDate(effectiveSelectedDate, language),
      icon: CalendarDays,
      tone: 'accent'
    },
    {
      label: t('signalSummary'),
      value: `${recommendationCounts.pick}/${recommendationCounts.watch}/${recommendationCounts.avoid}`,
      note: recommendationCounts.finished > 0
        ? (language === 'zh' ? `方向 / 观察 / 避坑 · 完 ${recommendationCounts.finished}` : `Pick / Watch / Avoid · F ${recommendationCounts.finished}`)
        : (language === 'zh' ? '方向 / 观察 / 避坑' : 'Pick / Watch / Avoid'),
      icon: ShieldCheck,
      tone: 'premium'
    },
    {
      label: t('avgTrust'),
      value: bestHitCooling
        ? t('hitCooling')
        : recommendationCounts.pick === 0
        ? t('riskPaused')
        : avgTrust === null ? '--' : `${avgTrust}%`,
      note: bestHitCooling
        ? t('hitCoolingNote')
        : recommendationCounts.pick === 0
        ? t('riskPausedNote')
        : language === 'zh' ? `按${t(sortBy)}排序` : `Sorted by ${t(sortBy)}`,
      icon: Activity,
      tone: bestHitCooling ? 'danger' : ''
    }
  ];

  const dataSyncSummary = dataSync.error && !dataSync.currentLoaded
    ? t('dataFallbackNote')
    : (() => {
      const sourceAgeMinutes = getDataAgeMinutes(dataSync.sourceUpdatedAt || dataSync.updatedAt, nowMs);
      const staleThresholdMinutes = Math.max((dataSync.backendRefreshMinutes || 5) * 4, 20);
      const isDataStale = dataSync.currentLoaded && sourceAgeMinutes !== null && sourceAgeMinutes > staleThresholdMinutes;
      if (isDataStale) {
        const lastAttemptLabel = formatSyncTime(dataSync.lastAttemptAt || dataSync.lastCheckedAt, language);
        return language === 'zh'
          ? `数据源已 ${formatAgeMinutes(sourceAgeMinutes, language)} 未发布新快照；后台最近检查 ${lastAttemptLabel}。`
          : `Source data is ${formatAgeMinutes(sourceAgeMinutes, language)} old; last background check ${lastAttemptLabel}.`;
      }
      if (dataSync.error && dataSync.currentLoaded && !dataSync.historyLoaded) return t('dataHistoryUnavailable');
      if (dataSync.historyLoading) return t('dataHistoryLoading');
      if (dataSync.historyLoaded) return t('dataHistoryReady');
      return t('dataCurrentLoading');
    })();

  const sourceAgeMinutes = getDataAgeMinutes(dataSync.sourceUpdatedAt || dataSync.updatedAt, nowMs);
  const staleThresholdMinutes = Math.max((dataSync.backendRefreshMinutes || 5) * 4, 20);
  const isDataStale = dataSync.currentLoaded && sourceAgeMinutes !== null && sourceAgeMinutes > staleThresholdMinutes;

  const dataSyncTone = dataSync.error || isDataStale
    ? 'is-warning'
    : dataSync.historyLoading
      ? 'is-loading'
      : dataSync.historyLoaded
        ? 'is-ready'
        : '';

  const dataSyncItems = [
    {
      label: t('dataCurrent'),
      value: dataSync.currentLoaded
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

  return (
    <div className="dashboard-stack">
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
          {dataSyncItems.map((item) => (
            <span key={item.label}>
              {item.label}
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
      </section>

      <section className="date-toolbar" aria-label="Date filters">
        <div className="date-quick-row">
          {quickDateOptions.map((option) => (
            <button
              key={option.date}
              type="button"
              onClick={() => {
                setHasManualDateSelection(true);
                setSelectedDate(option.date);
              }}
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
                  setHasManualDateSelection(true);
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
            <p>{!dataSync.currentLoaded && !dataSync.error ? t('dataCurrentLoading') : t('noMatches')}</p>
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
                      <th style={{ width: '330px', textAlign: 'left' }}>{language === 'zh' ? 'AI决策' : 'AI Decision'}</th>
                      <th style={{ width: '92px', textAlign: 'center' }}>{t('trustHeader')}</th>
                      <th style={{ width: '84px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {group.matches.map((match) => {
                      const homeTeam = getTeamById(match.homeTeamId);
                      const awayTeam = getTeamById(match.awayTeamId);
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
                      const bestTrust = getBestTrust(match);
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

                          <td className="match-trust-cell" data-label={t('trustHeader')} style={{ textAlign: 'center' }}>
                            {bestTrust > 0 ? (
                              <div
                                className="trust-meter"
                                style={{
                                  '--trust': `${bestTrust}%`,
                                  '--trust-color': getTrustColor(bestTrust)
                                } as React.CSSProperties}
                              >
                                <span className="trust-value">{bestTrust}%</span>
                                <span className="trust-bar">
                                  <span />
                                </span>
                              </div>
                            ) : (
                              <span className="status-note">--</span>
                            )}
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
