import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Lock,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trophy
} from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import { getDateStringOffset, leagues } from '../services/mockData';
import type { Country, League, Match, PredictionDetail } from '../services/mockData';
import { getMarketLabel, getPredictionTipDisplay, getPredictionValueLabel, getSportteryPoolRows } from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal, type MatchSignalCategory } from '../services/matchSignal';
import { TeamBadge } from '../components/TeamBadge';

interface PredictionsListProps {
  onSelectMatch: (matchId: string) => void;
}

type SortBy = 'time' | 'trust' | 'odds';
type SignalFilter = 'all' | MatchSignalCategory;

const SORT_OPTIONS: SortBy[] = ['time', 'trust', 'odds'];
const SIGNAL_FILTERS: SignalFilter[] = ['all', 'steady', 'watch', 'avoid', 'unavailable'];

const getMatchDay = (match: Match): string => match.matchDate || match.businessDate || match.kickoffDate || match.kickoffTime.slice(0, 10) || '';

const getKickoffDay = (match: Match): string => match.kickoffDate || match.kickoffTime.slice(0, 10) || '';

const matchBelongsToDate = (match: Match, date: string) => getMatchDay(match) === date || getKickoffDay(match) === date;

const getBestPrediction = (match: Match) => match.predictions.find((p) => p.marketType === 'BEST');

const getBestTrust = (match: Match) => getBestPrediction(match)?.trustScore || 0;

const getBestOdds = (match: Match) => getBestPrediction(match)?.odds || match.odds?.odds1 || match.handicapOdds?.odds1 || 0;

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

const formatKickoffTime = (kickoffTime: string, language: 'zh' | 'en') => {
  return new Date(kickoffTime).toLocaleTimeString(
    language === 'zh' ? 'zh-CN' : 'en-US',
    { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }
  );
};

const formatSyncTime = (isoTime: string | undefined, language: 'zh' | 'en') => {
  if (!isoTime) return '--';

  return new Date(isoTime).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
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

const hasOfficialScore = (match: Match) => Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);

const minutesSinceKickoff = (match: Match) => {
  const kickoffAt = new Date(match.kickoffTime).getTime();
  if (!Number.isFinite(kickoffAt)) return 0;
  return Math.floor((Date.now() - kickoffAt) / 60000);
};

export const PredictionsList: React.FC<PredictionsListProps> = ({ onSelectMatch }) => {
  const { language, isPremium, togglePremium, matches, dataSync } = useApp();
  const [nowMs, setNowMs] = useState(() => Date.now());

  const yesterdayStr = getDateStringOffset(-1);
  const todayStr = getDateStringOffset(0);
  const tomorrowStr = getDateStringOffset(1);
  const dayAfterTomorrowStr = getDateStringOffset(2);

  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
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
    premiumNotice: {
      zh: '当前为免费模式，部分精选稳胆、总进球数和双方进球参考已锁定。升级 PRO 可查看完整模型数据。',
      en: 'Free mode is active. Some best tips, total goals, and BTTS references are locked. Upgrade to PRO for full model data.'
    },
    upgradeBtn: { zh: '解锁 PRO', en: 'Unlock PRO' },
    filterTitle: { zh: '赛事筛选', en: 'Competition Filters' },
    allLeagues: { zh: '全部赛事', en: 'All Competitions' },
    signalTitle: { zh: '推荐分组', en: 'Signal' },
    allSignals: { zh: '全部分组', en: 'All Signals' },
    steady: { zh: '稳胆候选', en: 'Steady' },
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
    hitRate: { zh: '已赛命中率', en: 'Settled Hit Rate' },
    selectedMatches: { zh: '当前筛选场次', en: 'Filtered Matches' },
    signalSummary: { zh: '推荐分组', en: 'Signal Split' },
    avgTrust: { zh: '平均可信度', en: 'Average Trust' },
    dataStatusTitle: { zh: '数据同步', en: 'Data Sync' },
    dataCurrent: { zh: '当前赛程', en: 'Current' },
    dataHistory: { zh: '历史库', en: 'History' },
    dataTotal: { zh: '总数据', en: 'Total' },
    dataStatus: { zh: '状态', en: 'Status' },
    dataLoading: { zh: '加载中', en: 'Loading' },
    dataSyncing: { zh: '同步中', en: 'Syncing' },
    dataReady: { zh: '已加载', en: 'Ready' },
    dataFallback: { zh: '本地兜底', en: 'Fallback' },
    dataUpdated: { zh: '更新', en: 'Updated' },
    dataRefresh: { zh: '刷新', en: 'Refresh' },
    dataNextCheck: { zh: '下次检查', en: 'Next check' },
    dataCurrentLoading: { zh: '正在加载中国竞彩网赛程', en: 'Loading Sporttery schedule' },
    dataHistoryLoading: { zh: '历史结果后台补齐中', en: 'History loading in background' },
    dataHistoryReady: { zh: '当前赛程与历史库已就绪', en: 'Current schedule and history are ready' },
    dataHistoryUnavailable: { zh: '当前赛程已就绪，历史库暂不可用', en: 'Current schedule ready, history unavailable' },
    dataFallbackNote: { zh: '官方数据暂不可用，已启用兜底数据', en: 'Official data unavailable, using fallback' },
    settledPicks: { zh: '条已结算预测', en: 'settled picks' },
    matchUnit: { zh: '场', en: 'matches' },
    tipUnit: { zh: '条', en: 'tips' },
    statusTime: { zh: '时间 / 状态', en: 'Time / Status' },
    liveScorePending: { zh: '赛中待比分', en: 'Live, score pending' },
    awaitingResult: { zh: '等待官方赛果', en: 'Awaiting official result' },
    teams: { zh: '对阵双方', en: 'Teams' },
    oddsHeader: { zh: '胜平负 / 让球', en: '1X2 / Handicap' },
    closed: { zh: '未开售', en: 'Closed' },
    trustHeader: { zh: '可信度', en: 'Trust' },
    unlockTitle: { zh: '点击模拟升级解锁', en: 'Click to unlock' },
    hit: { zh: '命中', en: 'Hit' },
    leagueMatches: { zh: '场比赛', en: 'matches' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';
  const getSignalFilterLabel = (filter: SignalFilter) => {
    if (filter === 'all') return t('allSignals');
    return translations[filter][language];
  };

  const effectiveSelectedDate = useMemo(() => {
    const selectedDateHasMatches = matches.some((match) => matchBelongsToDate(match, selectedDate));
    if (selectedDateHasMatches || selectedDate !== todayStr) return selectedDate;

    const activeOfficialDate = matches
      .filter((match) => match.status !== 'FINISHED')
      .map(getMatchDay)
      .filter(Boolean)
      .sort()
      .at(-1);
    if (activeOfficialDate) return activeOfficialDate;

    return matches
      .map(getMatchDay)
      .filter((date) => date >= todayStr)
      .sort()[0] || selectedDate;
  }, [matches, selectedDate, todayStr]);

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
    }, { all: 0, steady: 0, watch: 0, avoid: 0, unavailable: 0 });
  }, [baseFilteredMatches]);

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

  const settledPredictions = useMemo(() => {
    return matches
      .flatMap((match) => match.predictions)
      .filter((prediction) => prediction.resultStatus !== 'PENDING');
  }, [matches]);

  const hitRate = useMemo(() => {
    if (settledPredictions.length === 0) return null;
    const won = settledPredictions.filter((prediction) => prediction.resultStatus === 'WON').length;
    return ((won / settledPredictions.length) * 100).toFixed(1);
  }, [settledPredictions]);

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

  const renderPredictionCell = (match: Match, marketType: PredictionDetail['marketType']) => {
    const isFinished = match.status === 'FINISHED';
    const pred = match.predictions.find((prediction) => prediction.marketType === marketType);

    if (!pred) return <span className="prediction-tip">-</span>;

    const isLocked = !isFinished && pred.visibilityStatus === 'PREMIUM' && !isPremium;

    if (isLocked) {
      return (
        <button
          type="button"
          className="locked-tip"
          onClick={(event) => {
            event.stopPropagation();
            togglePremium();
          }}
          title={t('unlockTitle')}
        >
          <Lock size={12} />
          PRO
        </button>
      );
    }

    const showResult = isFinished && pred.resultStatus === 'WON';

    return (
      <div className={`prediction-cell ${showResult ? 'is-hit' : ''}`}>
        <span className="prediction-tip">
          {getPredictionTipDisplay(pred, language, true)}
        </span>
        <span className="prediction-odds">{getPredictionValueLabel(pred, language)} {pred.odds.toFixed(2)}</span>
        {showResult && <span className="mini-hit">{t('hit')}</span>}
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
    const matchDates = matches.map(getMatchDay).filter(Boolean);
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
      value: hitRate ? `${hitRate}%` : '--',
      note: `${settledPredictions.length} ${t('settledPicks')}`,
      icon: BarChart3,
      tone: 'success'
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
      value: `${signalCounts.steady}/${signalCounts.watch}/${signalCounts.avoid}`,
      note: language === 'zh' ? '稳 / 观 / 避' : 'Steady / Watch / Avoid',
      icon: ShieldCheck,
      tone: 'premium'
    },
    {
      label: t('avgTrust'),
      value: avgTrust === null ? '--' : `${avgTrust}%`,
      note: language === 'zh' ? `按${t(sortBy)}排序` : `Sorted by ${t(sortBy)}`,
      icon: Activity,
      tone: ''
    }
  ];

  const dataSyncSummary = dataSync.error && !dataSync.currentLoaded
    ? t('dataFallbackNote')
    : dataSync.error && dataSync.currentLoaded && !dataSync.historyLoaded
      ? t('dataHistoryUnavailable')
      : dataSync.historyLoading
      ? t('dataHistoryLoading')
      : dataSync.historyLoaded
        ? t('dataHistoryReady')
        : t('dataCurrentLoading');

  const dataSyncTone = dataSync.error
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
      value: dataSync.historyLoaded
        ? `${dataSync.historyCount} ${t('matchUnit')}`
        : dataSync.historyLoading
          ? t('dataSyncing')
          : '--'
    },
    {
      label: t('dataTotal'),
      value: `${matches.length || dataSync.totalCount} ${t('matchUnit')}`
    },
    {
      label: t('dataStatus'),
      value: language === 'zh'
        ? `完 ${dataSync.byStatus?.FINISHED || 0} / 赛 ${dataSync.byStatus?.LIVE || 0} / 待 ${dataSync.byStatus?.SCHEDULED || 0}`
        : `F ${dataSync.byStatus?.FINISHED || 0} / L ${dataSync.byStatus?.LIVE || 0} / S ${dataSync.byStatus?.SCHEDULED || 0}`
    },
    {
      label: t('dataUpdated'),
      value: formatSyncTime(dataSync.sourceUpdatedAt || dataSync.updatedAt, language)
    },
    {
      label: t('dataRefresh'),
      value: language === 'zh'
        ? `页面检查 ${formatSyncTime(dataSync.lastCheckedAt, language)} / 每 ${dataSync.refreshIntervalSeconds || 60} 秒 / 后台约 ${dataSync.backendRefreshMinutes || 5} 分钟`
        : `Checked ${formatSyncTime(dataSync.lastCheckedAt, language)} / Every ${dataSync.refreshIntervalSeconds || 60}s / Backend ~${dataSync.backendRefreshMinutes || 5}m`
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
      {!isPremium && (
        <section className="notice-banner" aria-label="PRO notice">
          <div className="notice-copy">
            <span className="notice-icon">
              <Sparkles size={20} />
            </span>
            <p className="notice-text">{t('premiumNotice')}</p>
          </div>
          <button type="button" onClick={togglePremium} className="btn btn-premium">
            {t('upgradeBtn')}
          </button>
        </section>
      )}

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
                if (event.target.value) setSelectedDate(event.target.value);
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
            {SIGNAL_FILTERS.map((filter) => (
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
                      <th style={{ width: '92px', textAlign: 'center' }}>{getMarketLabel('1X2', language)}</th>
                      <th style={{ width: '100px', textAlign: 'center' }}>{getMarketLabel('GOALS', language)}</th>
                      <th style={{ width: '110px', textAlign: 'center' }}>{getMarketLabel('GG_NG', language)}</th>
                      <th style={{ width: '98px', textAlign: 'center' }}>{getMarketLabel('BEST', language)}</th>
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

                      return (
                        <tr
                          key={match.id}
                          className="match-row"
                          onClick={() => onSelectMatch(match.id)}
                        >
                          <td className="match-time-cell" data-label={t('statusTime')}>
                            <div className="time-stack">
                              {isLive ? (
                                <span className={hasScore ? 'badge badge-live' : 'badge'}>{liveText}</span>
                              ) : isFinished ? (
                                <span className="badge">{t('finished')} {score}</span>
                              ) : (
                                <>
                                  <span className="kickoff-time">{formattedTime}</span>
                                  <span className="status-note">{t('pending')}</span>
                                </>
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
                                  {isFinished ? t('finished') : signal.label[language]}
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
                                        <span className="pool-closed">{t('closed')}</span>
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

                          <td className="match-market-cell" data-label={getMarketLabel('1X2', language)} style={{ textAlign: 'center' }}>
                            {renderPredictionCell(match, '1X2')}
                          </td>

                          <td className="match-market-cell" data-label={getMarketLabel('GOALS', language)} style={{ textAlign: 'center' }}>
                            {renderPredictionCell(match, 'GOALS')}
                          </td>

                          <td className="match-market-cell" data-label={getMarketLabel('GG_NG', language)} style={{ textAlign: 'center' }}>
                            {renderPredictionCell(match, 'GG_NG')}
                          </td>

                          <td className="match-market-cell" data-label={getMarketLabel('BEST', language)} style={{ textAlign: 'center' }}>
                            {renderPredictionCell(match, 'BEST')}
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
