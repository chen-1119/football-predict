import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContextCore';
import type { League, Match, OutcomeProbability, PredictionDetail, ScoreProbability, Team } from '../services/mockData';
import {
  getPredictionCodeHint,
  getPredictionExplanationDisplay,
  getPredictionMarketLabel,
  getPredictionValueLabel,
  getPredictionTipDisplay,
  getSportteryPoolRows
} from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal, isActionableRecommendation } from '../services/matchSignal';
import { buildMatchInsight } from '../services/predictionInsight';
import { getVisiblePrediction, getVisiblePredictions } from '../services/predictionVisibility';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl, buildStaticUrl } from '../services/runtimeUrls';
import { TeamBadge } from '../components/TeamBadge';
import { ArrowLeft, Trophy } from 'lucide-react';
import { getWorldCupSeededFixtures } from '../services/worldCupData';

interface MatchDetailProps {
  matchId: string;
  onBack: () => void;
}

type Language = 'zh' | 'en';
type PredictionView = 'summary' | 'tips' | 'model' | 'factors' | 'weather';

type WeatherSignal = {
  source?: string;
  updatedAt?: string;
  verified?: boolean;
  confidence?: string;
  condition?: string | { zh?: string; en?: string };
  temperatureC?: number | null;
  windKph?: number | null;
  windGustKph?: number | null;
  humidity?: number | null;
  precipitationMm?: number | null;
  riskLevel?: 'low' | 'medium' | 'high' | string;
  summary?: string | { zh?: string; en?: string };
  impact?: string | { zh?: string; en?: string };
};

type ScoreRecommendationCandidate = {
  home: number;
  away: number;
  label: string;
  probability: number | null;
  source: 'model' | 'locked';
};

type HistoricalTrainingRow = {
  id: string;
  source?: string;
  division?: string;
  tournament?: string;
  neutral?: boolean;
  kickoffTime: string;
  date?: string;
  homeKey: string;
  awayKey: string;
  homeName?: string;
  awayName?: string;
  homeNameZh?: string;
  awayNameZh?: string;
  scoreHome: number;
  scoreAway: number;
};

type HistoricalTrainingDetail = {
  version?: string;
  source?: string;
  rows?: number;
  lastMatchDate?: string;
  windowDays?: number;
  windowEnd?: string;
  homeKey?: string;
  awayKey?: string;
  home?: {
    key?: string;
    name?: string;
    nameZh?: string;
    rows?: HistoricalTrainingRow[];
  };
  away?: {
    key?: string;
    name?: string;
    nameZh?: string;
    rows?: HistoricalTrainingRow[];
  };
  h2h?: {
    rows?: HistoricalTrainingRow[];
  };
};

type MatchWithHistoricalTraining = Match & {
  historicalTrainingDetail?: HistoricalTrainingDetail;
};

type FinishedMatch = Match & {
  scoreHome: number;
  scoreAway: number;
};

const HISTORY_LOOKBACK_DAYS = 365;
const TEAM_HISTORY_DISPLAY_LIMIT = 12;
const H2H_DISPLAY_LIMIT = 10;
const MIN_RATE_SAMPLE_SIZE = 3;
const fallbackColor = '#64748b';

interface TeamHistoryResult {
  id: string;
  dateLabel: string;
  competition: string;
  opponentName: string;
  venueLabel: string;
  ourScore: number;
  oppScore: number;
  result: 'win' | 'draw' | 'loss';
}

interface TeamHistorySummary {
  rows: TeamHistoryResult[];
  sampleSize: number;
  wins: number;
  draws: number;
  losses: number;
  over25Count: number;
  bothScoreCount: number;
  over25Rate: number | null;
  bothScoreRate: number | null;
}

interface HeadToHeadSummary {
  rows: HeadToHeadResult[];
  sampleSize: number;
}

interface HeadToHeadResult {
  id: string;
  dateLabel: string;
  competition: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
}

const formatNumber = (value: number) => {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
};

const formatSquadValue = (value: string | undefined, language: Language) => {
  const rawValue = value?.trim();

  if (!rawValue || rawValue === '-' || rawValue.startsWith('#')) {
    return '';
  }

  const matchedValue = rawValue.match(/^([\d.]+)\s*([BM])\s*€$/i);

  if (!matchedValue) {
    return language === 'zh' ? `阵容估值：${rawValue}` : `Squad value: ${rawValue}`;
  }

  const amount = Number(matchedValue[1]);
  const unit = matchedValue[2].toUpperCase();

  if (!Number.isFinite(amount)) {
    return '';
  }

  if (language === 'zh') {
    const cnAmount = unit === 'B'
      ? `${formatNumber(amount * 10)}亿`
      : `${formatNumber(amount * 100)}万`;

    return `阵容估值：约 ${cnAmount}欧元`;
  }

  return `Squad value: ${rawValue}`;
};

const getResultLabel = (resultStatus: PredictionDetail['resultStatus'], language: Language) => {
  if (resultStatus === 'WON') return language === 'zh' ? '命中' : 'Hit';
  if (resultStatus === 'LOST') return language === 'zh' ? '未中' : 'Miss';
  return language === 'zh' ? '待结算' : 'Pending';
};

const isScoredPrediction = (prediction: PredictionDetail) => (
  prediction.resultStatus !== 'PENDING' && prediction.tipCode !== 'WATCH'
  && prediction.recommendationAction !== 'reference'
);

const isFinishedWithScore = (match: Match): match is FinishedMatch => {
  return match.status === 'FINISHED' && Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);
};

const hasOfficialScore = (match: Match) => Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);

const isOutcomeTipCode = (tipCode: string | undefined): tipCode is '1' | 'X' | '2' => (
  tipCode === '1' || tipCode === 'X' || tipCode === '2'
);

const getScoreOutcomeCode = (score: Pick<ScoreProbability, 'home' | 'away'>): '1' | 'X' | '2' => {
  if (score.home > score.away) return '1';
  if (score.home < score.away) return '2';
  return 'X';
};

const dedupeScoreCandidates = <T extends { label: string }>(scores: T[]) => {
  const seen = new Set<string>();
  return scores.filter((score) => {
    if (seen.has(score.label)) return false;
    seen.add(score.label);
    return true;
  });
};

const minutesSinceKickoff = (match: Match) => {
  const kickoffAt = new Date(match.kickoffTime).getTime();
  if (!Number.isFinite(kickoffAt)) return 0;
  return Math.floor((Date.now() - kickoffAt) / 60000);
};

const getMatchSortTime = (match: Match) => new Date(match.kickoffTime).getTime();

const getHistoryStartTime = (match: Match) => {
  return getMatchSortTime(match) - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
};

const getMatchDateValue = (match: Match) => {
  return match.kickoffDate || match.kickoffTime.slice(0, 10) || match.matchDate || match.businessDate || '';
};

const formatHistoryDateValue = (date: string, language: Language) => {
  return new Date(`${date}T00:00:00+08:00`).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    timeZone: 'Asia/Shanghai'
  });
};

const formatHistoryDate = (match: Match, language: Language) => {
  const date = getMatchDateValue(match);

  return formatHistoryDateValue(date, language);
};

const formatCoverageTime = (time: number, language: Language) => {
  return new Date(time).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai'
  });
};

const getOneYearWindowLabel = (match: Match, language: Language) => {
  const kickoff = getMatchSortTime(match);
  if (!Number.isFinite(kickoff)) return language === 'zh' ? '\u8fd1\u4e00\u5e74' : 'last year';
  const start = kickoff - HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return `${formatCoverageTime(start, language)} - ${formatCoverageTime(kickoff, language)}`;
};

const normalizePolicyTimestamp = (value: string | undefined) => (
  value && /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(value)
    ? `${value.replace(/\s+/, 'T')}+08:00`
    : value
);

const parsePolicyTimestamp = (value: string | undefined) => {
  const normalized = normalizePolicyTimestamp(value);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatPolicyTimestamp = (value: string | undefined, language: Language) => {
  const normalized = normalizePolicyTimestamp(value);
  if (!normalized || Number.isNaN(Date.parse(normalized))) return '--';

  return new Date(normalized).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
};

const getTeamNameInMatch = (match: Match, teamId: string, language: Language) => {
  const team = getTeamById(teamId);
  const fallback = teamId === match.homeTeamId
    ? (language === 'zh' ? match.homeTeamName : match.homeTeamNameEn) || match.homeTeamName
    : (language === 'zh' ? match.awayTeamName : match.awayTeamNameEn) || match.awayTeamName;

  return fallback || team.shortName[language] || team.name[language];
};

const getDisplayTeam = (match: Match, side: 'home' | 'away'): Team => {
  const isHome = side === 'home';
  const teamId = isHome ? match.homeTeamId : match.awayTeamId;
  const registered = getTeamById(teamId);
  const syncedName = isHome ? match.homeTeamName : match.awayTeamName;
  const syncedNameEn = isHome ? match.homeTeamNameEn : match.awayTeamNameEn;
  const syncedLogo = isHome ? match.homeTeamLogo : match.awayTeamLogo;
  const syncedLogoType = isHome ? match.homeTeamLogoType : match.awayTeamLogoType;
  const syncedCountryIso = isHome ? match.homeTeamCountryIso : match.awayTeamCountryIso;
  const syncedColor = isHome ? match.homeTeamColor : match.awayTeamColor;
  const isUnknown = registered.shortName.en === 'Unknown';

  if (!isUnknown || !syncedName) return registered;

  return {
    id: teamId,
    name: { zh: syncedName, en: syncedNameEn || syncedName },
    shortName: { zh: syncedName, en: syncedNameEn || syncedName },
    logo: syncedLogoType === 'flag' && syncedCountryIso
      ? syncedCountryIso
      : syncedLogo || syncedCountryIso || syncedName.slice(0, 2),
    logoType: syncedLogoType,
    value: '',
    color: syncedColor || fallbackColor
  };
};

const getCompetitionName = (match: Match, language: Language) => {
  const league = getLeagueById(match.leagueId);
  return (language === 'zh' ? match.leagueShortName || match.leagueName : match.leagueShortNameEn || match.leagueNameEn) || league.shortName[language] || league.name[language];
};

const getDisplayLeague = (match: Match): League => {
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

const buildTeamHistory = (
  allMatches: Match[],
  teamId: string,
  currentMatch: Match,
  language: Language
): TeamHistorySummary => {
  const cutoffTime = getMatchSortTime(currentMatch);
  const startTime = getHistoryStartTime(currentMatch);
  const allRows = allMatches
    .filter(isFinishedWithScore)
    .filter((item) => item.id !== currentMatch.id)
    .filter((item) => item.homeTeamId === teamId || item.awayTeamId === teamId)
    .filter((item) => {
      const matchTime = getMatchSortTime(item);
      return matchTime <= cutoffTime && matchTime >= startTime;
    })
    .sort((a, b) => getMatchSortTime(b) - getMatchSortTime(a))
    .map<TeamHistoryResult>((item) => {
      const isHomeSide = item.homeTeamId === teamId;
      const ourScore = isHomeSide ? item.scoreHome : item.scoreAway;
      const oppScore = isHomeSide ? item.scoreAway : item.scoreHome;
      const result = ourScore > oppScore ? 'win' : ourScore === oppScore ? 'draw' : 'loss';
      const opponentId = isHomeSide ? item.awayTeamId : item.homeTeamId;

      return {
        id: item.id,
        dateLabel: formatHistoryDate(item, language),
        competition: getCompetitionName(item, language),
        opponentName: getTeamNameInMatch(item, opponentId, language),
        venueLabel: isHomeSide ? (language === 'zh' ? '主' : 'H') : (language === 'zh' ? '客' : 'A'),
        ourScore,
        oppScore,
        result
      };
    });

  const rows = allRows.slice(0, TEAM_HISTORY_DISPLAY_LIMIT);
  const wins = allRows.filter((item) => item.result === 'win').length;
  const draws = allRows.filter((item) => item.result === 'draw').length;
  const losses = allRows.length - wins - draws;
  const over25 = allRows.filter((item) => item.ourScore + item.oppScore >= 3).length;
  const bothScore = allRows.filter((item) => item.ourScore > 0 && item.oppScore > 0).length;
  const hasRateSample = allRows.length >= MIN_RATE_SAMPLE_SIZE;

  return {
    rows,
    sampleSize: allRows.length,
    wins,
    draws,
    losses,
    over25Count: over25,
    bothScoreCount: bothScore,
    over25Rate: hasRateSample ? Math.round((over25 / allRows.length) * 100) : null,
    bothScoreRate: hasRateSample ? Math.round((bothScore / allRows.length) * 100) : null
  };
};

const buildHeadToHead = (
  allMatches: Match[],
  homeTeamId: string,
  awayTeamId: string,
  currentMatch: Match,
  language: Language
): HeadToHeadSummary => {
  const cutoffTime = getMatchSortTime(currentMatch);
  const startTime = getHistoryStartTime(currentMatch);

  const rows = allMatches
    .filter(isFinishedWithScore)
    .filter((item) => item.id !== currentMatch.id)
    .filter((item) => {
      const teamIds = new Set([item.homeTeamId, item.awayTeamId]);
      return teamIds.has(homeTeamId) && teamIds.has(awayTeamId);
    })
    .filter((item) => {
      const matchTime = getMatchSortTime(item);
      return matchTime <= cutoffTime && matchTime >= startTime;
    })
    .sort((a, b) => getMatchSortTime(b) - getMatchSortTime(a))
    .map<HeadToHeadResult>((item) => ({
      id: item.id,
      dateLabel: formatHistoryDate(item, language),
      competition: getCompetitionName(item, language),
      homeName: getTeamNameInMatch(item, item.homeTeamId, language),
      awayName: getTeamNameInMatch(item, item.awayTeamId, language),
      homeScore: item.scoreHome,
      awayScore: item.scoreAway
    }));

  return {
    rows: rows.slice(0, H2H_DISPLAY_LIMIT),
    sampleSize: rows.length
  };
};

const getHistoricalTrainingDate = (row: HistoricalTrainingRow) => (
  row.date || String(row.kickoffTime || '').slice(0, 10)
);

const getHistoricalTrainingName = (
  row: HistoricalTrainingRow,
  side: 'home' | 'away',
  language: Language
) => {
  if (side === 'home') {
    return language === 'zh' ? row.homeNameZh || row.homeName || row.homeKey : row.homeName || row.homeNameZh || row.homeKey;
  }
  return language === 'zh' ? row.awayNameZh || row.awayName || row.awayKey : row.awayName || row.awayNameZh || row.awayKey;
};

const getHistoricalCompetition = (row: HistoricalTrainingRow) => {
  return row.tournament || row.division || 'Historical';
};

const summarizeHistoryRows = (rows: TeamHistoryResult[]): TeamHistorySummary => {
  const wins = rows.filter((item) => item.result === 'win').length;
  const draws = rows.filter((item) => item.result === 'draw').length;
  const losses = rows.length - wins - draws;
  const over25 = rows.filter((item) => item.ourScore + item.oppScore >= 3).length;
  const bothScore = rows.filter((item) => item.ourScore > 0 && item.oppScore > 0).length;
  const hasRateSample = rows.length >= MIN_RATE_SAMPLE_SIZE;

  return {
    rows: rows.slice(0, TEAM_HISTORY_DISPLAY_LIMIT),
    sampleSize: rows.length,
    wins,
    draws,
    losses,
    over25Count: over25,
    bothScoreCount: bothScore,
    over25Rate: hasRateSample ? Math.round((over25 / rows.length) * 100) : null,
    bothScoreRate: hasRateSample ? Math.round((bothScore / rows.length) * 100) : null
  };
};

const buildTeamHistoryFromTraining = (
  rows: HistoricalTrainingRow[] | undefined,
  teamKey: string | undefined,
  language: Language
): TeamHistorySummary | null => {
  if (!teamKey || !rows?.length) return null;

  const mappedRows = rows
    .filter((row) => Number.isFinite(row.scoreHome) && Number.isFinite(row.scoreAway))
    .filter((row) => row.homeKey === teamKey || row.awayKey === teamKey)
    .sort((a, b) => Date.parse(b.kickoffTime) - Date.parse(a.kickoffTime))
    .map<TeamHistoryResult>((row) => {
      const isHomeSide = row.homeKey === teamKey;
      const ourScore = isHomeSide ? row.scoreHome : row.scoreAway;
      const oppScore = isHomeSide ? row.scoreAway : row.scoreHome;
      const result = ourScore > oppScore ? 'win' : ourScore === oppScore ? 'draw' : 'loss';

      return {
        id: row.id,
        dateLabel: formatHistoryDateValue(getHistoricalTrainingDate(row), language),
        competition: getHistoricalCompetition(row),
        opponentName: getHistoricalTrainingName(row, isHomeSide ? 'away' : 'home', language),
        venueLabel: row.neutral
          ? (language === 'zh' ? '中' : 'N')
          : isHomeSide ? (language === 'zh' ? '主' : 'H') : (language === 'zh' ? '客' : 'A'),
        ourScore,
        oppScore,
        result
      };
    });

  return summarizeHistoryRows(mappedRows);
};

const buildHeadToHeadFromTraining = (
  rows: HistoricalTrainingRow[] | undefined,
  language: Language
): HeadToHeadSummary | null => {
  if (!rows?.length) return null;

  const mappedRows = rows
    .filter((row) => Number.isFinite(row.scoreHome) && Number.isFinite(row.scoreAway))
    .sort((a, b) => Date.parse(b.kickoffTime) - Date.parse(a.kickoffTime))
    .map<HeadToHeadResult>((row) => ({
      id: row.id,
      dateLabel: formatHistoryDateValue(getHistoricalTrainingDate(row), language),
      competition: getHistoricalCompetition(row),
      homeName: getHistoricalTrainingName(row, 'home', language),
      awayName: getHistoricalTrainingName(row, 'away', language),
      homeScore: row.scoreHome,
      awayScore: row.scoreAway
    }));

  return {
    rows: mappedRows.slice(0, H2H_DISPLAY_LIMIT),
    sampleSize: mappedRows.length
  };
};

export const MatchDetail: React.FC<MatchDetailProps> = ({ matchId, onBack }) => {
  const { language, matches, dataSync } = useApp();
  const [activeTab, setActiveTab] = useState<'predictions' | 'stats' | 'form' | 'h2h' | 'standings'>('predictions');
  const [nowMs] = useState(() => Date.now());
  const [predictionViewState, setPredictionViewState] = useState<{ matchId: string; view: PredictionView }>(() => ({
    matchId,
    view: 'summary'
  }));
  const predictionView = predictionViewState.matchId === matchId ? predictionViewState.view : 'summary';
  const setPredictionView = (view: PredictionView) => {
    setPredictionViewState({ matchId, view });
  };
  const [fullMatch, setFullMatch] = useState<Match | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const loadDetail = async () => {
      try {
        const accessHeaders = getAccessAuthHeaders();
        const response = await fetch(buildApiUrl(`/api/matches/${encodeURIComponent(matchId)}`), {
          cache: 'no-store',
          headers: Object.keys(accessHeaders).length ? accessHeaders : undefined,
          signal: controller.signal
        });
        const data = response.ok ? await response.json() : null;
        if (!cancelled && data?.id === matchId) {
          setFullMatch(data as Match);
          return;
        }
      } catch {
        // Static deployments may not expose the detail API; fall back to the public snapshot.
      }

      try {
        const accessHeaders = getAccessAuthHeaders();
        const response = await fetch(buildStaticUrl('data/matches-current.json'), {
          cache: 'no-store',
          headers: Object.keys(accessHeaders).length ? accessHeaders : undefined,
          signal: controller.signal
        });
        const data = response.ok ? await response.json() : [];
        const rows = Array.isArray(data) ? data : [];
        const snapshotMatch = rows.find((item) => item?.id === matchId);
        if (!cancelled && snapshotMatch) setFullMatch(snapshotMatch as Match);
      } catch {
        // Context data remains the final fallback.
      }
    };

    loadDetail();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [matchId]);


  // 获取比赛详情
  const match = useMemo(
    () => (fullMatch?.id === matchId ? fullMatch : null)
      || matches.find((item) => item.id === matchId)
      || getWorldCupSeededFixtures(104).find((item) => item.id === matchId),
    [fullMatch, matchId, matches]
  );

  if (!match) {
    return (
      <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
        <p>{!dataSync.currentLoaded ? (language === 'zh' ? '正在加载比赛详情...' : 'Loading match detail...') : (language === 'zh' ? '比赛不存在' : 'Match not found')}</p>
        <button onClick={onBack} className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ArrowLeft size={16} /> {language === 'zh' ? '返回列表' : 'Back'}
        </button>
      </div>
    );
  }

  const homeTeam = getDisplayTeam(match, 'home');
  const awayTeam = getDisplayTeam(match, 'away');
  const league = getDisplayLeague(match);
  const country = getCountryById(match.countryId);
  
  const isFinished = match.status === 'FINISHED';
  const isLive = match.status === 'LIVE';
  const isPendingResult = match.status === 'PENDING_RESULT';
  const hasScore = hasOfficialScore(match);
  const officialScoreText = hasScore ? `${match.scoreHome} - ${match.scoreAway}` : '-- : --';
  
  const formattedDate = new Date(match.kickoffTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
  const businessDateValue = match.businessDate || match.matchDate;
  const businessDateLabel = businessDateValue
    ? new Date(`${businessDateValue}T00:00:00+08:00`).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      timeZone: 'Asia/Shanghai'
    })
    : '';

  const translations = {
    backBtn: { zh: '返回列表', en: 'Back' },
    predictionsTab: { zh: 'AI 预测推荐', en: 'Predictions' },
    statsTab: { zh: '数据统计', en: 'Match Stats' },
    formTab: { zh: '近期战绩', en: 'Form & Streaks' },
    h2hTab: { zh: '交锋历史', en: 'Head-to-Head' },
    standingsTab: { zh: '联赛积分榜', en: 'Standings' },
    market: { zh: '推荐市场', en: 'Market' },
    tip: { zh: '推荐选项', en: 'Tip' },
    odds: { zh: 'SP', en: 'Odds' },
    trust: { zh: '可信度', en: 'Confidence' },
    analysis: { zh: '模型深度解析', en: 'AI Analysis' },
    scorePrediction: { zh: 'AI 比分推演', en: 'AI Score Prediction' },
    teamValue: { zh: '阵容估值', en: 'Squad Value' },
    kickoff: { zh: '开赛时间', en: 'Kickoff' },
    referenceText: { zh: '预测内容仅供赛前参考，请结合临场信息理性判断。', en: 'Forecasts are for pre-match reference only; use late information and your own judgment.' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };
  const poolRows = getSportteryPoolRows(match, language);
  const visiblePredictions = getVisiblePredictions(match);
  const hasPredictions = visiblePredictions.length > 0;
  const settledPredictions = visiblePredictions.filter(isScoredPrediction);
  const wonPredictions = settledPredictions.filter((prediction) => prediction.resultStatus === 'WON');
  const bestReviewPrediction = visiblePredictions.find((prediction) => prediction.marketType === 'BEST' && prediction.tipCode !== 'WATCH')
    || getVisiblePrediction(match, '1X2');
  const oneXTwoPrediction = visiblePredictions.find((prediction) => prediction.marketType === '1X2' && isOutcomeTipCode(prediction.tipCode))
    || getVisiblePrediction(match, '1X2');
  const primaryOutcomePrediction = isOutcomeTipCode(oneXTwoPrediction?.tipCode)
    ? oneXTwoPrediction
    : bestReviewPrediction && isOutcomeTipCode(bestReviewPrediction.tipCode)
      ? bestReviewPrediction
      : undefined;
  const goalsPrediction = visiblePredictions.find((prediction) => prediction.marketType === 'GOALS');
  const reviewHitRate = settledPredictions.length > 0 ? Math.round((wonPredictions.length / settledPredictions.length) * 100) : null;
  const homeValueText = formatSquadValue(homeTeam.value, language);
  const awayValueText = formatSquadValue(awayTeam.value, language);
  const historicalTrainingDetail = (match as MatchWithHistoricalTraining).historicalTrainingDetail;
  const trainingHomeHistory = buildTeamHistoryFromTraining(
    historicalTrainingDetail?.home?.rows,
    historicalTrainingDetail?.home?.key || historicalTrainingDetail?.homeKey,
    language
  );
  const trainingAwayHistory = buildTeamHistoryFromTraining(
    historicalTrainingDetail?.away?.rows,
    historicalTrainingDetail?.away?.key || historicalTrainingDetail?.awayKey,
    language
  );
  const trainingHeadToHead = buildHeadToHeadFromTraining(historicalTrainingDetail?.h2h?.rows, language);
  const fallbackHomeHistory = buildTeamHistory(matches, homeTeam.id, match, language);
  const fallbackAwayHistory = buildTeamHistory(matches, awayTeam.id, match, language);
  const fallbackHeadToHead = buildHeadToHead(matches, homeTeam.id, awayTeam.id, match, language);
  const homeHistory = trainingHomeHistory?.sampleSize ? trainingHomeHistory : fallbackHomeHistory;
  const awayHistory = trainingAwayHistory?.sampleSize ? trainingAwayHistory : fallbackAwayHistory;
  const headToHead = trainingHeadToHead || fallbackHeadToHead;
  const historyCoverageLabel = getOneYearWindowLabel(match, language);
  const historyDataSourceLabel = historicalTrainingDetail
    ? (language === 'zh' ? '长期历史训练库' : 'long-run training history')
    : (language === 'zh' ? '已同步竞彩历史库' : 'synced Sporttery history');
  const matchSignal = getMatchSignal(match);
  const matchInsight = buildMatchInsight(match, {
    homeSampleSize: homeHistory.sampleSize,
    awaySampleSize: awayHistory.sampleSize,
    h2hSampleSize: headToHead.sampleSize,
    coverageLabel: historyCoverageLabel
  });
  const predictionMeta = match.predictionMeta;
  const predictionLockedByCutoff = predictionMeta?.lockedReason === 'cutoff';
  const gptPrediction = match.gptPrediction;
  const gptParsed = gptPrediction?.relay?.parsed;
  const gptRecommendation = gptParsed?.recommendation;
  const gptProbabilities = gptParsed?.probabilities;
  const probabilityModel = match.probabilityModel;
  const calculationTrace = probabilityModel?.calculationTrace;
  const probabilityModelIsModelOnly = Boolean(
    probabilityModel?.version?.includes('model-only') ||
    (!match.odds && !match.handicapOdds)
  );
  const hasProjectedScore = Number.isFinite(match.projectedScoreHome) && Number.isFinite(match.projectedScoreAway);
  const projectedScoreText = hasProjectedScore
    ? `${match.projectedScoreHome} - ${match.projectedScoreAway}`
    : probabilityModel
      ? `${Math.round(match.stats?.xG.home ?? 1)} - ${Math.round(match.stats?.xG.away ?? 1)}`
      : '--';
  const actualScoreText = hasScore
    ? (language === 'zh' ? `实际赛果：${officialScoreText}` : `Final score: ${officialScoreText}`)
    : '';

  const formatProbabilityValue = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return '--';
    return `${Number(value).toFixed(1).replace(/\.0$/, '')}%`;
  };

  const formatGptProbability = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return '--';
    const normalized = Number(value) <= 1 ? Number(value) * 100 : Number(value);
    return `${normalized.toFixed(1).replace(/\.0$/, '')}%`;
  };

  const outcomeLabels: { key: keyof OutcomeProbability; zh: string; en: string }[] = [
    { key: 'home', zh: '主胜', en: 'Home' },
    { key: 'draw', zh: '平局', en: 'Draw' },
    { key: 'away', zh: '客胜', en: 'Away' }
  ];
  const handicapOutcomeLabels: { key: keyof OutcomeProbability; zh: string; en: string }[] = [
    { key: 'home', zh: '让球主胜', en: 'HHAD Home' },
    { key: 'draw', zh: '让球平', en: 'HHAD Draw' },
    { key: 'away', zh: '让球客胜', en: 'HHAD Away' }
  ];

  const formatModelWeight = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return '--';
    return `${Math.round(Number(value) * 100)}%`;
  };

  const formatDecimal = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return '--';
    return Number(value).toFixed(2).replace(/\.00$/, '');
  };

  const formatHealthRate = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return '--';
    return `${(Number(value) * 100).toFixed(1).replace(/\.0$/, '')}%`;
  };

  const formatSignedPercentBoost = (value: number | null | undefined) => {
    if (!Number.isFinite(value) || Number(value) === 0) return '0';
    const pct = Math.round(Number(value) * 100);
    return `${pct > 0 ? '+' : ''}${pct}%`;
  };

  const calibrationReasonLabels: Record<string, { zh: string; en: string }> = {
    'very-cold-profile': { zh: '同类比赛近期很冷，推荐门槛明显收紧', en: 'Very cold profile: gates tightened' },
    'cold-profile': { zh: '同类比赛命中偏低，推荐门槛已收紧', en: 'Cold profile: gates tightened' },
    'hot-profile': { zh: '同类比赛表现较好，允许小幅放宽', en: 'Hot profile: gates slightly relaxed' },
    'neutral-profile': { zh: '同类表现中性，使用常规门槛', en: 'Neutral profile: normal gates' }
  };

  const renderOutcomeLine = (
    probabilities: OutcomeProbability | null | undefined,
    labels = outcomeLabels
  ) => {
    return labels
      .map((item) => `${item[language]} ${formatProbabilityValue(probabilities?.[item.key])}`)
      .join(' / ');
  };

  const renderOutcomeTriplet = (
    probabilities: OutcomeProbability | null | undefined,
    labels = outcomeLabels
  ) => (
    <div className="probability-triplet">
      {labels.map((item) => {
        const value = probabilities?.[item.key];
        const width = Number.isFinite(value) ? Math.max(4, Number(value)) : 0;

        return (
          <div key={item.key} className="probability-outcome">
            <div>
              <span>{item[language]}</span>
              <strong>{formatProbabilityValue(value)}</strong>
            </div>
            <em style={{ width: `${width}%` }} />
          </div>
        );
      })}
    </div>
  );

  const probabilityForPredictionTip = (prediction: PredictionDetail | undefined) => {
    if (!prediction || !['1', 'X', '2'].includes(prediction.tipCode)) return null;
    const source = prediction.oddsPoolCode === 'HHAD'
      ? (probabilityModel?.handicap?.poisson || probabilityModel?.handicap?.market)
      : probabilityModel?.oneXTwo?.final;
    const key = prediction.tipCode === '1' ? 'home' : prediction.tipCode === 'X' ? 'draw' : 'away';
    return source?.[key] ?? null;
  };

  const recommendationActionLabel = (prediction: PredictionDetail | undefined) => {
    const action = prediction?.recommendationAction;
    if (prediction?.tipCode === 'WATCH') return language === 'zh' ? '参考' : 'Reference';
    if (action === 'recommend') return language === 'zh' ? '主推' : 'Main';
    return language === 'zh' ? '参考' : 'Reference';
  };

  const primaryOutcomeProbability = probabilityForPredictionTip(primaryOutcomePrediction);
  const primaryOutcomeTitle = primaryOutcomePrediction
    ? getPredictionTipDisplay(primaryOutcomePrediction, language)
    : '--';
  const primaryOutcomeMarket = primaryOutcomePrediction
    ? getPredictionMarketLabel(primaryOutcomePrediction, language)
    : (language === 'zh' ? '胜平负' : '1X2');
  const primaryOutcomeOdds = Number.isFinite(primaryOutcomePrediction?.odds) && Number(primaryOutcomePrediction?.odds) > 0
    ? Number(primaryOutcomePrediction?.odds).toFixed(2)
    : '--';
  const primaryOutcomeRiskCount = primaryOutcomePrediction?.riskTags?.length ?? matchSignal.riskCount;
  const primaryOutcomeTrust = primaryOutcomePrediction?.trustScore ?? matchSignal.trustScore ?? null;
  const primaryOutcomeCode = isOutcomeTipCode(primaryOutcomePrediction?.tipCode) ? primaryOutcomePrediction.tipCode : undefined;
  const scoreDistributionCandidates: ScoreRecommendationCandidate[] = (probabilityModel?.scoreDistribution || []).map((score) => ({
    home: score.home,
    away: score.away,
    label: score.label,
    probability: Number.isFinite(score.probability) ? score.probability : null,
    source: 'model'
  }));
  const projectedScoreDistributionMatch = scoreDistributionCandidates.find((score) => score.label === projectedScoreText);
  const projectedScoreCandidate: ScoreRecommendationCandidate | null = hasProjectedScore
    ? {
      home: Number(match.projectedScoreHome),
      away: Number(match.projectedScoreAway),
      label: projectedScoreText,
      probability: projectedScoreDistributionMatch?.probability ?? null,
      source: 'locked'
    }
    : null;
  const alignedScoreCandidate = primaryOutcomeCode
    ? scoreDistributionCandidates.find((score) => getScoreOutcomeCode(score) === primaryOutcomeCode)
      || (projectedScoreCandidate && getScoreOutcomeCode(projectedScoreCandidate) === primaryOutcomeCode ? projectedScoreCandidate : null)
    : null;
  const firstScoreCandidate = alignedScoreCandidate
    || projectedScoreCandidate
    || scoreDistributionCandidates[0]
    || null;
  const secondScoreCandidate = scoreDistributionCandidates.find((score) => score.label !== firstScoreCandidate?.label)
    || (projectedScoreCandidate && projectedScoreCandidate.label !== firstScoreCandidate?.label ? projectedScoreCandidate : null);
  const scoreRecommendations = dedupeScoreCandidates(
    [firstScoreCandidate, secondScoreCandidate].filter((score): score is ScoreRecommendationCandidate => Boolean(score))
  ).slice(0, 2).map((score, index) => {
    const alignsWithOutcome = primaryOutcomeCode ? getScoreOutcomeCode(score) === primaryOutcomeCode : false;
    return {
      ...score,
      tone: alignsWithOutcome ? 'aligned' : 'alternate',
      tag: alignsWithOutcome
        ? (language === 'zh' ? '方向一致' : 'Aligned')
        : index === 0
          ? (language === 'zh' ? '模型首选' : 'Model top')
          : (language === 'zh' ? '备选热区' : 'Alt zone')
    };
  });
  const scoreAlignmentNote = primaryOutcomeCode && scoreRecommendations.some((score) => score.tone === 'aligned')
    ? (language === 'zh'
      ? `比分一按「${primaryOutcomeTitle}」方向优先筛选，比分二保留模型热区参考。`
      : `Score one is aligned with ${primaryOutcomeTitle}; score two keeps the model heat-zone reference.`)
    : (language === 'zh'
      ? '当前胜平负方向不足以绑定比分，展示模型热区前两位。'
      : 'The 1X2 direction is not strong enough to bind scores, so the top model zones are shown.');
  const over25Probability = probabilityModel?.goalLines?.over25;
  const under25Probability = probabilityModel?.goalLines?.under25;
  const inferredGoalsTipCode = Number.isFinite(over25Probability) && Number.isFinite(under25Probability)
    ? Number(over25Probability) >= Number(under25Probability)
      ? 'O2.5'
      : 'U2.5'
    : '';
  const inferredGoalsLeanText = inferredGoalsTipCode === 'O2.5'
    ? (language === 'zh' ? '大2.5球' : 'Over 2.5 goals')
    : inferredGoalsTipCode === 'U2.5'
      ? (language === 'zh' ? '小2.5球' : 'Under 2.5 goals')
      : (language === 'zh' ? '进球参考' : 'Goals lean');
  const goalsLeanText = goalsPrediction
    ? getPredictionTipDisplay(goalsPrediction, language, true)
    : inferredGoalsLeanText;
  const goalsDisplayCode = goalsPrediction?.tipCode || inferredGoalsTipCode || '--';
  const goalsLeanProbability = goalsPrediction?.tipCode === 'O2.5'
    ? over25Probability
    : goalsPrediction?.tipCode === 'U2.5'
      ? under25Probability
      : inferredGoalsTipCode === 'O2.5'
        ? over25Probability
        : inferredGoalsTipCode === 'U2.5'
          ? under25Probability
          : null;
  const goalsPredictionOdds = Number.isFinite(goalsPrediction?.odds) && Number(goalsPrediction?.odds) > 0
    ? Number(goalsPrediction?.odds).toFixed(2)
    : '--';
  const goalsPredictionTrust = goalsPrediction?.trustScore ?? null;
  const recommendationTipPredictions = visiblePredictions.filter((prediction) => (
    prediction.tipCode !== 'WATCH'
    && (prediction.marketType === 'GOALS' || prediction.marketType === 'GG_NG')
  ));
  const lockedTagText = predictionMeta?.lockedAt
    ? (language === 'zh' ? '已锁定' : 'Locked')
    : (language === 'zh' ? '赛前监控' : 'Monitoring');
  const isQualifiedPick = match.status === 'SCHEDULED' && isActionableRecommendation(match);
  const decisionPoolStatus = isQualifiedPick
    ? (language === 'zh' ? '进精选池' : 'Top pool')
    : matchSignal.category === 'avoid'
      ? (language === 'zh' ? '保留推荐' : 'Kept recommendation')
      : match.status === 'FINISHED'
        ? (language === 'zh' ? '已锁定复盘' : 'Locked review')
        : (language === 'zh' ? '不进精选池' : 'Not in top pool');
  const decisionDirectionText = primaryOutcomePrediction
    ? `${isQualifiedPick
      ? (language === 'zh' ? '推荐方向' : 'Pick')
      : (language === 'zh' ? '参考倾向' : 'Reference lean')} ${primaryOutcomeTitle}`
    : matchSignal.category === 'avoid'
      ? (language === 'zh' ? '保留推荐' : 'Kept recommendation')
      : (language === 'zh' ? '等待确认' : 'Await confirmation');
  const hadPoolRow = poolRows.find((row) => row.poolCode === 'HAD');
  const hhadPoolRow = poolRows.find((row) => row.poolCode === 'HHAD');
  const independentOutcomeProbabilities = calculationTrace?.outcome?.raw
    || probabilityModel?.oneXTwo.teamStrength
    || probabilityModel?.oneXTwo.poisson
    || probabilityModel?.oneXTwo.final;
  const officialSpProbabilities = hadPoolRow?.probabilities
    ? {
      home: hadPoolRow.probabilities.home,
      draw: hadPoolRow.probabilities.draw,
      away: hadPoolRow.probabilities.away
    }
    : probabilityModel?.oneXTwo.market;
  const supportForPrimaryOutcome = primaryOutcomeCode && hhadPoolRow?.probabilities
    ? primaryOutcomeCode === '1'
      ? hhadPoolRow.probabilities.home
      : primaryOutcomeCode === 'X'
        ? hhadPoolRow.probabilities.draw
        : hhadPoolRow.probabilities.away
    : null;
  const primaryOutcomeKey = primaryOutcomeCode === '1'
    ? 'home'
    : primaryOutcomeCode === 'X'
      ? 'draw'
      : primaryOutcomeCode === '2'
        ? 'away'
        : undefined;
  const handicapProbabilityLeader = hhadPoolRow?.probabilities
    ? handicapOutcomeLabels
      .map((item) => ({
        ...item,
        probability: hhadPoolRow.probabilities?.[item.key] ?? null
      }))
      .filter((item): item is typeof handicapOutcomeLabels[number] & { probability: number } => Number.isFinite(item.probability))
      .sort((a, b) => b.probability - a.probability)[0]
    : null;
  const handicapValidationText = hhadPoolRow?.odds
    ? supportForPrimaryOutcome !== null
      ? (language === 'zh'
        ? `${primaryOutcomeTitle} · 让球 ${hhadPoolRow.handicap || '--'} · ${supportForPrimaryOutcome >= 42 ? '有支持' : '支持不足'} ${supportForPrimaryOutcome}%`
        : `${primaryOutcomeTitle} · line ${hhadPoolRow.handicap || '--'} · ${supportForPrimaryOutcome >= 42 ? 'supported' : 'weak support'} ${supportForPrimaryOutcome}%`)
      : `${language === 'zh' ? '让球' : 'Line'} ${hhadPoolRow.handicap || '--'} · ${hhadPoolRow.probabilities ? `${hhadPoolRow.probabilities.home}/${hhadPoolRow.probabilities.draw}/${hhadPoolRow.probabilities.away}%` : '--'}`
    : (language === 'zh' ? '暂无官方让球盘，先不作为精选验证。' : 'No official handicap pool yet, so it cannot validate a top pick.');
  const handicapValidationNote = hhadPoolRow?.odds
    ? handicapProbabilityLeader && primaryOutcomeKey && handicapProbabilityLeader.key !== primaryOutcomeKey
      ? (language === 'zh'
        ? `让球盘最高为${handicapProbabilityLeader.zh} ${handicapProbabilityLeader.probability}%，说明盘口没有同向支持胜平负主方向；这里只做验证，不改成推荐方向。`
        : `${handicapProbabilityLeader.en} leads the handicap pool at ${handicapProbabilityLeader.probability}%. That means the line does not support the 1X2 lean, and it is validation only, not a rewritten pick.`)
      : (language === 'zh'
        ? '让球盘只做精选校验，不会强行改掉胜平负推荐方向。'
        : 'Handicap is used as top-pool validation and does not forcibly rewrite the 1X2 lean.')
    : (language === 'zh'
      ? '暂无官方让球盘，先不作为精选验证。'
      : 'No official handicap pool yet, so it cannot validate a top pick.');
  const transparentRiskTags = (
    primaryOutcomePrediction?.riskTags?.length
      ? primaryOutcomePrediction.riskTags
      : visiblePredictions.flatMap((prediction) => prediction.riskTags || [])
  ).filter((tag, index, list) => (
    list.findIndex((item) => item.zh === tag.zh && item.en === tag.en) === index
  )).slice(0, 6);
  const transparentDecisionReason = isQualifiedPick
    ? (language === 'zh'
      ? '模型概率、官方 SP、让球盘和风险标签同时通过，本场进入精选池。'
      : 'Model probability, official SP, handicap validation, and risk tags passed together, so this fixture enters the top pool.')
    : matchSignal.category === 'avoid'
      ? (language === 'zh'
        ? '模型方向保留，暂不进入精选池，作为赛前参考推荐展示。'
        : 'The model direction is kept out of the top pool and shown as a pre-match reference recommendation.')
      : primaryOutcomePrediction
        ? (language === 'zh'
          ? '模型主线仍有方向，但低赔、让球或风险校验未同时通过，仅作参考。'
          : 'The model has a main lean, but SP, handicap, or risk validation did not pass together, so it stays reference only.')
        : matchSignal.note[language];
  const predictionVersionText = predictionMeta?.strategyVersion
    || predictionMeta?.policyVersion
    || predictionMeta?.promptVersion
    || probabilityModel?.version
    || '--';
  const predictionGeneratedAt = predictionMeta?.generatedAt
    || probabilityModel?.generatedAt
    || gptPrediction?.generatedAt
    || predictionMeta?.updatedAt;
  const predictionCutoffRaw = predictionMeta?.cutoffTime || match.buyEndTime;
  const predictionCutoffMs = parsePolicyTimestamp(predictionCutoffRaw);
  const predictionCutoffPassed = predictionCutoffMs !== null && nowMs >= predictionCutoffMs;
  const predictionIsLocked = Boolean(predictionMeta?.lockedAt)
    || predictionLockedByCutoff
    || match.status !== 'SCHEDULED'
    || predictionCutoffPassed;

  // 渲染预测详细行
  const externalSignals = match.externalSignals as (Match['externalSignals'] & {
    weather?: WeatherSignal;
    venue?: { name?: string; city?: string; summary?: string | { zh?: string; en?: string } };
  }) | undefined;
  const weatherSignal = externalSignals?.weather;
  const fiveHundredSignal = externalSignals?.fiveHundred;
  const localizedSignalText = (
    value: string | { zh?: string; en?: string } | undefined,
    fallback = ''
  ) => (typeof value === 'string' ? value : value?.[language] || value?.zh || value?.en || fallback);
  const weatherSummary = localizedSignalText(weatherSignal?.summary);
  const weatherImpactText = localizedSignalText(weatherSignal?.impact);
  const venueSummary = typeof externalSignals?.venue?.summary === 'string'
    ? externalSignals.venue.summary
    : externalSignals?.venue?.summary?.[language];
  const weatherVerified = Boolean(
    weatherSignal &&
    (weatherSummary || weatherSignal.condition || Number.isFinite(weatherSignal.temperatureC) || Number.isFinite(weatherSignal.windKph))
  );
  const weatherVenueConfirmed = weatherSignal?.verified !== false && weatherSignal?.confidence !== 'estimated-location';
  const weatherSourceStatus = !weatherVerified
    ? 'missing'
    : weatherSignal?.source && weatherVenueConfirmed
      ? 'live'
      : 'estimated';
  const weatherStatusLabel = weatherSourceStatus === 'live'
    ? (language === 'zh' ? '实时' : 'Live')
    : weatherSourceStatus === 'estimated'
      ? (language === 'zh' ? '估算' : 'Estimated')
      : (language === 'zh' ? '缺失' : 'Missing');
  const weatherStatusDetail = weatherSourceStatus === 'live'
    ? (language === 'zh' ? '实时天气源 + 球场定位' : 'Live source + venue located')
    : weatherSourceStatus === 'estimated'
      ? (language === 'zh' ? '天气字段已接入，场地/定位为估算' : 'Weather fields loaded; venue/location estimated')
      : (language === 'zh' ? '暂无可验证实时天气' : 'No verified live weather');
  const weatherStatusDescription = weatherSourceStatus === 'live'
    ? (language === 'zh'
      ? '本场有可追溯天气来源和球场定位，天气只作为风险层修正，不单独推翻胜平负方向。'
      : 'This fixture has a traceable weather source and venue location. Weather is used as a risk modifier only.')
    : weatherSourceStatus === 'estimated'
      ? (language === 'zh'
        ? '本场天气来自估算位置或待确认场地，只做弱提示，不直接加权改动主预测。'
        : 'Weather is based on an estimated location or unconfirmed venue, so it is treated as a weak signal.')
      : (language === 'zh'
        ? '本场没有可验证天气字段，系统按中性天气处理，避免把猜测写进概率。'
        : 'No verified weather field is available, so the model treats weather as neutral.');
  const weatherConditionLabel = localizedSignalText(
    weatherSignal?.condition,
    weatherVerified ? '--' : (language === 'zh' ? '未接入' : 'Not connected')
  );
  const weatherRiskTone = weatherSignal?.riskLevel === 'high'
    ? 'danger'
    : weatherSignal?.riskLevel === 'medium'
      ? 'warning'
      : weatherVerified
        ? 'success'
        : 'neutral';
  const worldCupPrior = probabilityModel?.worldCupPrior
    || match.worldCupPrior
    || externalSignals?.worldCupPrior
    || null;
  const worldCupPriorWeight = probabilityModel?.ensembleWeights?.worldCupPrior;
  const worldCupPriorStrengthDiff = Number(worldCupPrior?.strengthDiff);
  const worldCupPriorHomeName = language === 'zh'
    ? worldCupPrior?.home?.nameZh || worldCupPrior?.home?.nameEn
    : worldCupPrior?.home?.nameEn || worldCupPrior?.home?.nameZh;
  const worldCupPriorAwayName = language === 'zh'
    ? worldCupPrior?.away?.nameZh || worldCupPrior?.away?.nameEn
    : worldCupPrior?.away?.nameEn || worldCupPrior?.away?.nameZh;
  const worldCupPriorSignature = worldCupPrior?.signature
    ? worldCupPrior.signature.split('|').slice(-1)[0]
    : '';
  const weatherSourceLabel = weatherSignal?.source
    ? `${weatherSignal.source} · ${weatherStatusDetail}`
    : weatherStatusDetail;
  const weatherImpactLabel = weatherVerified
    ? (weatherVenueConfirmed
      ? (language === 'zh' ? '已进入赛前信息层' : 'Included in pre-match signal layer')
      : (language === 'zh' ? '已接入，场地待确认' : 'Loaded, venue needs confirmation'))
    : (language === 'zh' ? '未验证，不参与概率加权' : 'Unverified, not weighted in probabilities');
  const weatherMetrics = [
    {
      label: language === 'zh' ? '来源状态' : 'Source',
      value: weatherStatusLabel
    },
    {
      label: language === 'zh' ? '天气' : 'Condition',
      value: weatherConditionLabel
    },
    {
      label: language === 'zh' ? '温度' : 'Temp',
      value: Number.isFinite(weatherSignal?.temperatureC) ? `${weatherSignal?.temperatureC}℃` : '--'
    },
    {
      label: language === 'zh' ? '风速' : 'Wind',
      value: Number.isFinite(weatherSignal?.windKph) ? `${weatherSignal?.windKph} km/h` : '--'
    },
    {
      label: language === 'zh' ? '降水' : 'Rain',
      value: Number.isFinite(weatherSignal?.precipitationMm) ? `${weatherSignal?.precipitationMm} mm` : '--'
    }
  ];
  const predictionNavItems: Array<{ key: PredictionView; label: string; detail: string }> = [
    {
      key: 'summary',
      label: language === 'zh' ? '概览' : 'Summary',
      detail: matchSignal.trustScore ? `${matchSignal.trustScore}%` : '--'
    },
    {
      key: 'tips',
      label: language === 'zh' ? '推荐' : 'Tips',
      detail: language === 'zh' ? '比分/进球' : 'Score/Goals'
    },
    {
      key: 'model',
      label: language === 'zh' ? '模型' : 'Model',
      detail: probabilityModel?.version?.split('-').slice(0, 2).join('-') || '--'
    },
    {
      key: 'factors',
      label: language === 'zh' ? '因素' : 'Factors',
      detail: `${matchInsight.drivers.length}/${matchInsight.watchpoints.length}`
    },
    {
      key: 'weather',
      label: language === 'zh' ? '天气' : 'Weather',
      detail: weatherStatusLabel
    }
  ];
  const factorCards = [
    {
      title: language === 'zh' ? '官方 SP / 让球' : 'Official SP / handicap',
      value: poolRows.filter((row) => row.odds).length ? `${poolRows.filter((row) => row.odds).length}/${poolRows.length}` : '--',
      tone: poolRows.some((row) => row.odds) ? 'success' : 'warning',
      body: language === 'zh'
        ? '胜平负与让球 SP 只做市场校验；模型先用强度、Elo、近况和 Poisson 生成独立概率，再比较 SP 是否偏离。'
        : 'HAD and HHAD SP are market validation only; the model first builds independent probabilities from strength, Elo, form, and Poisson, then checks SP divergence.'
    },
    {
      title: language === 'zh' ? 'Elo / 长期样本' : 'Elo / long sample',
      value: probabilityModel?.elo ? `${probabilityModel.elo.homeRating}/${probabilityModel.elo.awayRating}` : '--',
      tone: probabilityModel?.elo ? 'success' : 'neutral',
      body: language === 'zh'
        ? `当前长期训练库样本 ${probabilityModel?.elo?.historicalSource?.rows || probabilityModel?.form?.historicalSource?.rows || '--'} 行，主要用于强弱差与状态先验。`
        : `Historical training rows: ${probabilityModel?.elo?.historicalSource?.rows || probabilityModel?.form?.historicalSource?.rows || '--'}, used for strength and form priors.`
    },
    ...(worldCupPrior ? [{
      title: language === 'zh' ? '世界杯先验' : 'World Cup prior',
      value: Number.isFinite(worldCupPriorWeight) ? formatModelWeight(worldCupPriorWeight) : (language === 'zh' ? '已接入' : 'Loaded'),
      tone: 'success',
      body: language === 'zh'
        ? `Kimi 数据集已匹配 ${worldCupPriorHomeName || '主队'} vs ${worldCupPriorAwayName || '客队'}，强度差 ${Number.isFinite(worldCupPriorStrengthDiff) ? worldCupPriorStrengthDiff.toFixed(3) : '--'}，签名 ${worldCupPriorSignature || '--'}；只作为世界杯赛前先验，不覆盖 Elo、近况和 Poisson。`
        : `Kimi dataset matched ${worldCupPriorHomeName || 'home'} vs ${worldCupPriorAwayName || 'away'}, strength diff ${Number.isFinite(worldCupPriorStrengthDiff) ? worldCupPriorStrengthDiff.toFixed(3) : '--'}, signature ${worldCupPriorSignature || '--'}; used as a World Cup pre-match prior without replacing Elo, form, or Poisson.`
    }] : []),
    {
      title: language === 'zh' ? '近况攻防' : 'Recent form',
      value: probabilityModel?.form ? `${formatDecimal(probabilityModel.form.home.goalsForAvg)} / ${formatDecimal(probabilityModel.form.away.goalsForAvg)}` : '--',
      tone: probabilityModel?.form ? 'success' : 'neutral',
      body: language === 'zh'
        ? '近一年滚动样本修正预期进球，与 Elo、长期样本一起改变 Poisson 热区。'
        : 'Rolling form adjusts expected goals and score heat zones together with Elo and long-run samples.'
    },
    {
      title: language === 'zh' ? '阵容信息' : 'Lineups',
      value: externalSignals?.lineups ? (language === 'zh' ? '已接入' : 'Loaded') : '--',
      tone: externalSignals?.lineups ? 'success' : 'neutral',
      body: externalSignals?.lineups?.summary?.[language]
        || (language === 'zh' ? '未拿到可验证首发/伤停时，只作为待补信息，不调整概率。' : 'Without verified lineups or injuries, this remains missing data and does not adjust probabilities.')
    },
    {
      title: language === 'zh' ? '外部均赔' : 'External odds',
      value: fiveHundredSignal?.europeOdds?.companies ? `${fiveHundredSignal.europeOdds.companies}` : '--',
      tone: fiveHundredSignal?.europeOdds?.companies ? 'success' : 'neutral',
      body: fiveHundredSignal?.europeOdds?.summary
        || externalSignals?.externalOdds?.summary?.[language]
        || (language === 'zh' ? '外部均赔用于交叉验证官方 SP 是否偏离，不单独生成推荐。' : 'External average odds cross-check official SP divergence; they do not create picks alone.')
    },
    {
      title: language === 'zh' ? '天气 / 场地' : 'Weather / pitch',
      value: weatherVerified ? `${weatherStatusLabel} · ${weatherConditionLabel}` : weatherStatusLabel,
      tone: weatherRiskTone,
      body: weatherVerified
        ? (weatherSummary || weatherImpactText || weatherStatusDescription)
        : weatherStatusDescription
    }
  ];

  const renderCalculationFormulaPanel = () => {
    const trace = calculationTrace;
    if (!trace) return null;

    const components = trace.outcome?.components || [];
    const modelComponents = components.filter((component) => component.role === 'model' && Number(component.weight) > 0);
    const marketComponent = components.find((component) => component.key === 'market');
    const lambdaValues = trace.expectedGoals?.values;
    const goalValues = trace.goals?.values;
    const expressions = trace.outcome?.expressions;
    const topScores = trace.poisson?.topScores?.slice(0, 3) || [];

    return (
      <section className="probability-panel is-full formula-panel">
        <div className="formula-panel-head">
          <div>
            <h4>{language === 'zh' ? '计算公式' : 'Calculation Formula'}</h4>
            <p>
              {trace.policy?.[language] || (language === 'zh'
                ? '先计算独立模型概率，再做风险校准；SP 只做市场校验。'
                : 'Compute independent model probabilities first, then calibrate risk; SP is validation only.')}
            </p>
          </div>
          <span>{trace.version}</span>
        </div>

        <div className="formula-card-grid">
          <article className="formula-card is-primary">
            <span>{language === 'zh' ? '胜平负总公式' : '1X2 formula'}</span>
            <code>{trace.outcome?.formula?.[language] || 'P_final=calibrate(normalize(sum(w_i*P_i)))'}</code>
            <p>
              {language === 'zh'
                ? '主胜、平局、客胜分别套用同一条公式，最后归一化并应用冷却/风险校准。'
                : 'Home, draw, and away use the same formula, then normalization and risk calibration are applied.'}
            </p>
          </article>

          <article className="formula-card">
            <span>{language === 'zh' ? '本场代入' : 'This match'}</span>
            <ul className="formula-expression-list">
              <li>{language === 'zh' ? '主胜' : 'Home'}: <strong>{expressions?.home || '--'}</strong></li>
              <li>{language === 'zh' ? '平局' : 'Draw'}: <strong>{expressions?.draw || '--'}</strong></li>
              <li>{language === 'zh' ? '客胜' : 'Away'}: <strong>{expressions?.away || '--'}</strong></li>
            </ul>
            {trace.outcome?.calibration?.applied && (
              <p>
                {language === 'zh'
                  ? `已触发 ${trace.outcome.calibration.adjustments?.length || 0} 条风险校准。`
                  : `${trace.outcome.calibration.adjustments?.length || 0} risk calibration rules applied.`}
              </p>
            )}
          </article>

          <article className="formula-card">
            <span>{language === 'zh' ? '组件权重' : 'Component weights'}</span>
            <div className="formula-component-list">
              {modelComponents.map((component) => (
                <div key={component.key}>
                  <b>{component.label?.[language] || component.key}</b>
                  <strong>{formatModelWeight(component.weight)}</strong>
                  <em>{renderOutcomeLine(component.probabilities)}</em>
                </div>
              ))}
            </div>
          </article>

          <article className="formula-card">
            <span>{language === 'zh' ? '进球期望 lambda' : 'Expected goals lambda'}</span>
            <code>{trace.expectedGoals?.formula?.[language] || '--'}</code>
            <p>
              {language === 'zh' ? '独立初值' : 'Independent seed'}:
              {' '}
              <strong>{formatDecimal(lambdaValues?.independentHome)} / {formatDecimal(lambdaValues?.independentAway)}</strong>
              {' · '}
              {language === 'zh' ? '最终' : 'Final'}:
              {' '}
              <strong>{formatDecimal(lambdaValues?.finalHome)} / {formatDecimal(lambdaValues?.finalAway)}</strong>
            </p>
            <p>
              {language === 'zh' ? '联赛权重' : 'League weight'} {formatModelWeight(lambdaValues?.leagueWeight)}
              {' · '}
              {language === 'zh' ? '近况权重' : 'Form weight'} {formatModelWeight(lambdaValues?.formWeight)}
            </p>
          </article>

          <article className="formula-card">
            <span>{language === 'zh' ? 'Poisson 比分' : 'Poisson score'}</span>
            <code>{trace.poisson?.formula?.[language] || '--'}</code>
            <p>
              lambda H/A:
              {' '}
              <strong>{formatDecimal(trace.poisson?.lambdas?.home)} / {formatDecimal(trace.poisson?.lambdas?.away)}</strong>
            </p>
            <div className="formula-score-list">
              {topScores.map((score) => (
                <b key={score.label}>{score.label} {formatProbabilityValue(score.probability)}</b>
              ))}
            </div>
          </article>

          <article className="formula-card">
            <span>{language === 'zh' ? '大小球 / SP 规则' : 'Goals / SP rule'}</span>
            <code>{trace.goals?.formula?.[language] || '--'}</code>
            <p>
              {language === 'zh' ? '大2.5' : 'Over2.5'} <strong>{formatProbabilityValue(goalValues?.over25)}</strong>
              {' · BTTS '}
              <strong>{formatProbabilityValue(goalValues?.bttsYes)}</strong>
            </p>
            <p>
              <strong>{trace.marketUse?.formula || 'marketWeight=0'}</strong>
              {' · '}
              {trace.marketUse?.[language] || (language === 'zh' ? 'SP 只做校验。' : 'SP is validation only.')}
            </p>
            {marketComponent && (
              <p>
                {language === 'zh' ? '市场概率' : 'Market'}:
                {' '}
                {renderOutcomeLine(marketComponent.probabilities)}
              </p>
            )}
          </article>
        </div>
      </section>
    );
  };

  const renderPredictionBlock = (pred: PredictionDetail) => {
    const codeHint = getPredictionCodeHint(pred, language);
    const valueLabel = getPredictionValueLabel(pred, language);
    const hasDisplayOdds = Number.isFinite(pred.odds) && pred.odds > 0;

    return (
      <div 
        key={pred.marketType}
        className="card prediction-tip-card"
        style={{
          position: 'relative',
          backgroundColor: 'hsl(var(--bg))', 
          borderColor: 'hsl(var(--border))',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          overflow: 'hidden'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <span style={{ 
              fontSize: '0.75rem', 
              color: 'hsl(var(--text-secondary))', 
              textTransform: 'uppercase', 
              fontWeight: '700', 
              letterSpacing: '0.5px' 
            }}>
              {getPredictionMarketLabel(pred, language)}
            </span>
            <h4 style={{ fontSize: '1.1rem', fontWeight: '800', color: pred.marketType === 'BEST' ? 'hsl(var(--primary))' : 'hsl(var(--text-primary))', marginTop: '0.2rem' }}>
              {getPredictionTipDisplay(pred, language)}
            </h4>
            {codeHint && <span className="prediction-code-hint">{codeHint}</span>}
            {pred.riskTags && pred.riskTags.length > 0 && (
              <div className="risk-tag-row">
                {pred.riskTags.slice(0, 2).map((tag) => (
                  <span key={`${pred.marketType}-${tag.zh}`} className="risk-tag">{tag[language]}</span>
                ))}
              </div>
            )}
          </div>
          
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            {isFinished && (
              <span className={`prediction-result-pill is-${pred.resultStatus.toLowerCase()}`}>
                {getResultLabel(pred.resultStatus, language)}
              </span>
            )}
            {hasDisplayOdds && (
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{valueLabel}</span>
                <span style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--accent))' }}>{pred.odds.toFixed(2)}</span>
              </div>
            )}
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('trust')}</span>
              <span style={{ fontSize: '1.1rem', fontWeight: '800', color: 'hsl(var(--primary))' }}>{pred.trustScore}%</span>
            </div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: '0.75rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block', marginBottom: '0.25rem', fontWeight: '600' }}>
            {t('analysis')}
          </span>
          <p style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', lineHeight: '1.6' }}>
            {getPredictionExplanationDisplay(pred, language)}
          </p>
          {pred.analysisItems && pred.analysisItems.length > 0 && (
            <ul className="prediction-analysis-list">
              {pred.analysisItems.slice(0, 2).map((item, index) => (
                <li key={`${pred.marketType}-${index}`}>{item[language]}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  };

  const formatRate = (value: number | null) => (value === null ? '--' : `${value}%`);
  const formatRateNote = (count: number, sampleSize: number) => {
    if (sampleSize === 0) return language === 'zh' ? '近一年无样本' : 'No yearly sample';
    if (sampleSize < MIN_RATE_SAMPLE_SIZE) return language === 'zh' ? `样本不足 · ${count}/${sampleSize}` : `Small sample · ${count}/${sampleSize}`;
    return language === 'zh' ? `${count}/${sampleSize} 场` : `${count}/${sampleSize} matches`;
  };

  const renderFormSummaryCard = (teamName: string, teamColor: string, summary: TeamHistorySummary) => (
    <div className="form-summary-card">
      <h4>
        <span style={{ backgroundColor: teamColor }} />
        {teamName} {language === 'zh' ? '近一年官方赛果' : 'Last-Year Official Results'}
      </h4>
      <div className="form-stat-grid">
        <div className="form-stat-tile">
          <span>{language === 'zh' ? '胜 - 平 - 负' : 'W - D - L'}</span>
          <strong>{summary.wins} - {summary.draws} - {summary.losses}</strong>
          <em>{language === 'zh' ? `样本 ${summary.sampleSize} 场` : `${summary.sampleSize} samples`}</em>
        </div>
        <div className="form-stat-tile">
          <span>{language === 'zh' ? '大 2.5 球率' : 'Over 2.5'}</span>
          <strong>{formatRate(summary.over25Rate)}</strong>
          <em>{formatRateNote(summary.over25Count, summary.sampleSize)}</em>
        </div>
        <div className="form-stat-tile">
          <span>{language === 'zh' ? '双方进球率' : 'BTTS'}</span>
          <strong>{formatRate(summary.bothScoreRate)}</strong>
          <em>{formatRateNote(summary.bothScoreCount, summary.sampleSize)}</em>
        </div>
      </div>
      <p>
        {summary.sampleSize
          ? (language === 'zh'
            ? `近一年窗口已匹配 ${summary.sampleSize} 场已完场记录，列表展示最近 ${summary.rows.length} 场。统计窗口：${historyCoverageLabel}，来源：${historyDataSourceLabel}。`
            : `${summary.sampleSize} finished records found in the last-year window. Showing latest ${summary.rows.length}. Window: ${historyCoverageLabel}; source: ${historyDataSourceLabel}.`)
          : (language === 'zh'
            ? `近一年窗口暂无该队已完场记录。统计窗口：${historyCoverageLabel}，来源：${historyDataSourceLabel}。`
            : `No finished records in the last-year window. Window: ${historyCoverageLabel}; source: ${historyDataSourceLabel}.`)}
      </p>
    </div>
  );

  const renderHistoryColumn = (teamName: string, summary: TeamHistorySummary) => (
    <div className="team-history-column">
      <h5>{teamName}</h5>
      {summary.rows.length > 0 ? (
        <div className="team-history-list">
          {summary.rows.map((item) => (
            <div key={item.id} className="team-history-row">
              <div className="history-row-copy">
                <div className="history-row-meta">
                  <span>{item.dateLabel}</span>
                  <span>{item.competition}</span>
                </div>
                <strong>{item.venueLabel} vs {item.opponentName}</strong>
              </div>
              <span className={`history-score is-${item.result}`}>
                {item.ourScore} - {item.oppScore}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="history-empty">
          {language === 'zh' ? '暂无可匹配的官方历史赛果' : 'No matching official results yet'}
        </div>
      )}
    </div>
  );

  return (
    <div className="match-detail-shell" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* 1. 面包屑与返回 */}
      <div className="detail-topbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))' }}>
          {language === 'zh' ? '首页' : 'Home'} / {country.name[language]} / {league.name[language]} / {homeTeam.shortName[language]} vs {awayTeam.shortName[language]}
        </div>
        <button onClick={onBack} className="btn btn-secondary" style={{ padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <ArrowLeft size={16} />
          <span>{t('backBtn')}</span>
        </button>
      </div>

      {/* 2. 比赛详情头部看板 */}
      <div className="card match-hero-card" style={{
        background: 'linear-gradient(135deg, hsl(var(--bg-card)) 0%, hsl(var(--bg-card-hover)) 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2.5rem 1.5rem',
        textAlign: 'center',
        gap: '1.5rem'
      }}>
        
        {/* 联赛与时间 */}
        <div>
          <span style={{ fontSize: '0.8rem', color: 'hsl(var(--primary))', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '1px' }}>
            {league.name[language]}
          </span>
          <div style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))', marginTop: '0.25rem' }}>
            {formattedDate}
          </div>
          {(match.matchNo || businessDateLabel) && (
            <div style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', marginTop: '0.35rem' }}>
              {match.matchNo ? `${match.matchNo}` : ''}
              {match.matchNo && businessDateLabel ? ' · ' : ''}
              {businessDateLabel ? (language === 'zh' ? `竞彩日 ${businessDateLabel}` : `Match day ${businessDateLabel}`) : ''}
            </div>
          )}
        </div>

        {/* 球队比分对阵大面板 */}
        <div className="matchup-board" style={{
          display: 'flex',
          justifyContent: 'space-around',
          alignItems: 'center',
          width: '100%',
          maxWidth: '700px',
          flexWrap: 'wrap',
          gap: '1.5rem'
        }}>
          {/* 主队 */}
          <div className="matchup-team" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', minWidth: '150px' }}>
            <TeamBadge team={homeTeam} size="lg" />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', fontFamily: 'var(--font-title)' }}>
              {homeTeam.name[language]}
            </h3>
            {homeValueText && <span className="match-team-value">{homeValueText}</span>}
          </div>

          {/* 比分 / 状态 */}
          <div className="matchup-status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            {isFinished ? (
              <div>
                <div style={{ fontSize: '3rem', fontWeight: '900', letterSpacing: '4px', fontFamily: 'var(--font-title)', color: 'hsl(var(--primary))' }}>
                  {officialScoreText}
                </div>
                <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                  {hasScore
                    ? (language === 'zh' ? '已结束' : 'Finished')
                    : (language === 'zh' ? '官方赛果待更新' : 'Official result pending')}
                </span>
              </div>
            ) : isPendingResult ? (
              <div>
                <div style={{ fontSize: '2.25rem', fontWeight: '800', color: 'hsl(var(--text-secondary))', fontFamily: 'var(--font-title)' }}>
                  VS
                </div>
                <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                  {language === 'zh' ? '等待官方赛果' : 'Awaiting official result'}
                </span>
              </div>
            ) : isLive ? (
              <div>
                <div style={{ fontSize: '3rem', fontWeight: '900', letterSpacing: '4px', fontFamily: 'var(--font-title)', color: 'hsl(var(--danger))' }}>
                  {officialScoreText}
                </div>
                <span className={hasScore ? 'badge badge-live' : 'badge'}>
                  {hasScore
                    ? (language === 'zh' ? '进行中' : 'Live')
                    : minutesSinceKickoff(match) >= 130
                      ? (language === 'zh' ? '等待官方赛果' : 'Awaiting official result')
                      : (language === 'zh' ? '赛中待比分' : 'Live, score pending')}
                </span>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: '2.25rem', fontWeight: '800', color: 'hsl(var(--text-secondary))', fontFamily: 'var(--font-title)' }}>
                  VS
                </div>
                <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                  {language === 'zh' ? '未开赛' : 'Scheduled'}
                </span>
              </div>
            )}
          </div>

          {/* 客队 */}
          <div className="matchup-team" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', minWidth: '150px' }}>
            <TeamBadge team={awayTeam} size="lg" />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', fontFamily: 'var(--font-title)' }}>
              {awayTeam.name[language]}
            </h3>
            {awayValueText && <span className="match-team-value">{awayValueText}</span>}
          </div>

        </div>

        {/* 底部 SP 展示 */}
        {poolRows.length > 0 && (
          <div style={{
            borderTop: '1px solid hsl(var(--border))',
            width: '100%',
            paddingTop: '1rem',
            display: 'flex',
            justifyContent: 'center',
            fontSize: '0.875rem'
          }}>
            <div className="detail-pool-table">
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
                      <span>{isFinished ? (language === 'zh' ? '赛果归档' : 'Archived') : (language === 'zh' ? '未开售' : 'Closed')}</span>
                      <span>--</span>
                      <span>--</span>
                      <span>--</span>
                    </>
                  )}
                </div>
              ))}
              <div className="odds-source detail-odds-source">
                {language === 'zh' ? '官方竞彩 HAD / HHAD' : 'Official Sporttery HAD / HHAD'}
              </div>
              {match.oddsTrend && (
                <div className={`sp-trend-box is-${match.oddsTrend.direction}`}>
                  <strong>{language === 'zh' ? '官方 SP 走势' : 'Official SP Trend'}</strong>
                  <span>{match.oddsTrend.summary[language]}</span>
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      {/* 3. 导航 Tabs */}
      <div className="tabs-container detail-tabs-nav" role="tablist" aria-label={language === 'zh' ? '详情导航' : 'Detail sections'}>
        <button type="button" role="tab" aria-selected={activeTab === 'predictions'} className={`tab-btn ${activeTab === 'predictions' ? 'active' : ''}`} onClick={() => setActiveTab('predictions')}>{t('predictionsTab')}</button>
        <button type="button" role="tab" aria-selected={activeTab === 'stats'} className={`tab-btn ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => setActiveTab('stats')}>{t('statsTab')}</button>
        <button type="button" role="tab" aria-selected={activeTab === 'form'} className={`tab-btn ${activeTab === 'form' ? 'active' : ''}`} onClick={() => setActiveTab('form')}>{t('formTab')}</button>
        <button type="button" role="tab" aria-selected={activeTab === 'h2h'} className={`tab-btn ${activeTab === 'h2h' ? 'active' : ''}`} onClick={() => setActiveTab('h2h')}>{t('h2hTab')}</button>
        <button type="button" role="tab" aria-selected={activeTab === 'standings'} className={`tab-btn ${activeTab === 'standings' ? 'active' : ''}`} onClick={() => setActiveTab('standings')}>{t('standingsTab')}</button>
      </div>

      {/* 4. Tab 内容区域 */}
      <div className="detail-tab-panel" role="tabpanel">
        
        {/* Tab 1: AI 推荐 */}
        {activeTab === 'predictions' && (
          <div className="prediction-view-stack" data-view={predictionView} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div className="prediction-view-nav" role="tablist" aria-label={language === 'zh' ? '预测数据导航' : 'Prediction data navigation'}>
              {predictionNavItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={predictionView === item.key}
                  className={`prediction-view-tab ${predictionView === item.key ? 'active' : ''}`}
                  onClick={() => setPredictionView(item.key)}
                >
                  <span>{item.label}</span>
                  <strong>{item.detail}</strong>
                </button>
              ))}
            </div>
            <div className="card recommendation-overview-card recommendation-outcome-card">
              <section className="recommendation-overview-panel is-outcome">
                <div className="recommendation-overview-head">
                  <span>{language === 'zh' ? '胜平负推荐' : '1X2 Recommendation'}</span>
                  <b>{recommendationActionLabel(primaryOutcomePrediction)}</b>
                </div>
                <strong className="recommendation-overview-main">{primaryOutcomeTitle}</strong>
                <p>{primaryOutcomePrediction?.explanation?.[language] || matchSignal.note[language]}</p>
                <div className="recommendation-mini-tags">
                  <span>{primaryOutcomeMarket}</span>
                  <span>{language === 'zh' ? '模型' : 'Model'} {formatProbabilityValue(primaryOutcomeProbability)}</span>
                  <span>SP {primaryOutcomeOdds}</span>
                  <span>{language === 'zh' ? '可信' : 'Trust'} {primaryOutcomeTrust === null ? '--' : `${primaryOutcomeTrust}%`}</span>
                  <span>{language === 'zh' ? '风险' : 'Risk'} {primaryOutcomeRiskCount}</span>
                </div>
              </section>
            </div>

            <div className="card recommendation-score-card">
              <section className="recommendation-overview-panel is-score">
                <div className="recommendation-overview-head">
                  <span>{language === 'zh' ? '比分推演' : 'Score Projection'}</span>
                  <b>{lockedTagText}</b>
                </div>
                <div className="recommendation-score-list">
                  {scoreRecommendations.length ? scoreRecommendations.map((score, index) => (
                    <div key={score.label} className={`recommendation-score-option is-${score.tone}`}>
                      <span>{index === 0 ? (language === 'zh' ? '比分一' : 'Score 1') : (language === 'zh' ? '比分二' : 'Score 2')}</span>
                      <strong>{score.label}</strong>
                      <em>{score.tag} · {formatProbabilityValue(score.probability)}</em>
                    </div>
                  )) : (
                    <div className="recommendation-score-option is-empty">
                      <span>{language === 'zh' ? '比分' : 'Score'}</span>
                      <strong>{projectedScoreText}</strong>
                      <em>{language === 'zh' ? '等待模型分布' : 'Waiting for distribution'}</em>
                    </div>
                  )}
                </div>
                {actualScoreText && (
                  <p className="recommendation-score-final">
                    {actualScoreText} · {language === 'zh' ? '预测不回写' : 'not rewritten'}
                  </p>
                )}
                <p>{scoreAlignmentNote}</p>
                <div className="recommendation-mini-tags">
                  <span>{language === 'zh' ? '方向' : 'Direction'} {primaryOutcomeTitle}</span>
                  <span>{language === 'zh' ? '热区' : 'xG'} {formatDecimal(match.stats?.xG.home)} : {formatDecimal(match.stats?.xG.away)}</span>
                  <span>{language === 'zh' ? '大2.5' : 'Over2.5'} {formatProbabilityValue(probabilityModel?.goalLines?.over25)}</span>
                  <span>BTTS {formatProbabilityValue(probabilityModel?.bothTeamsToScore?.yes)}</span>
                  <span>{goalsLeanText}</span>
                </div>
              </section>

              <section className="recommendation-overview-panel is-goals">
                <div className="recommendation-overview-head">
                  <span>{language === 'zh' ? '进球数推荐' : 'Goals Recommendation'}</span>
                  <b>{goalsPrediction ? recommendationActionLabel(goalsPrediction) : (language === 'zh' ? '参考' : 'Reference')}</b>
                </div>
                <strong className="recommendation-goals-main">{goalsLeanText}</strong>
                <p>
                  {language === 'zh'
                    ? '进球数单独放在推荐页，结合大/小球、双方进球和 xG 热区判断，不和胜平负方向混在一起。'
                    : 'Goals are separated in the tips view, combining totals, BTTS, and xG heat zones without mixing into the 1X2 direction.'}
                </p>
                <div className="recommendation-mini-tags">
                  <span>{language === 'zh' ? '进球数' : 'Goals'} {goalsDisplayCode}</span>
                  <span>{language === 'zh' ? '模型' : 'Model'} {formatProbabilityValue(goalsLeanProbability)}</span>
                  <span>SP {goalsPredictionOdds}</span>
                  <span>{language === 'zh' ? '可信' : 'Trust'} {goalsPredictionTrust === null ? '--' : `${goalsPredictionTrust}%`}</span>
                  <span>{language === 'zh' ? '大2.5' : 'Over2.5'} {formatProbabilityValue(probabilityModel?.goalLines?.over25)}</span>
                  <span>{language === 'zh' ? '小2.5' : 'Under2.5'} {formatProbabilityValue(probabilityModel?.goalLines?.under25)}</span>
                  <span>BTTS {formatProbabilityValue(probabilityModel?.bothTeamsToScore?.yes)}</span>
                </div>
              </section>
            </div>

            <div className="card decision-transparent-card">
              <div className="decision-transparent-head">
                <div>
                  <span className="review-kicker">{language === 'zh' ? '模型分析' : 'Model Analysis'}</span>
                  <h3>{decisionDirectionText}</h3>
                  <p>{transparentDecisionReason}</p>
                </div>
                <span className={`decision-pool-pill is-${isQualifiedPick ? 'qualified' : matchSignal.category}`}>
                  {decisionPoolStatus}
                </span>
              </div>

              <div className="decision-transparent-grid">
                <section className="decision-transparent-panel">
                  <h4>{language === 'zh' ? '独立模型概率' : 'Independent model'}</h4>
                  {renderOutcomeTriplet(independentOutcomeProbabilities)}
                </section>

                <section className="decision-transparent-panel">
                  <h4>{language === 'zh' ? '官方 SP 隐含概率' : 'Official SP implied'}</h4>
                  {renderOutcomeTriplet(officialSpProbabilities)}
                  <p>
                    {hadPoolRow?.odds
                      ? `${language === 'zh' ? '胜平负' : '1X2'} ${hadPoolRow.odds.odds1.toFixed(2)} / ${hadPoolRow.odds.oddsX.toFixed(2)} / ${hadPoolRow.odds.odds2.toFixed(2)}`
                      : (language === 'zh' ? '普通胜平负暂未开售。' : 'Standard 1X2 is not on sale yet.')}
                  </p>
                </section>

                <section className="decision-transparent-panel">
                  <h4>{language === 'zh' ? '让球盘支持' : 'Handicap validation'}</h4>
                  <strong>{handicapValidationText}</strong>
                  <p>{handicapValidationNote}</p>
                </section>

                <section className="decision-transparent-panel">
                  <h4>{language === 'zh' ? '进球模型' : 'Goals model'}</h4>
                  <strong>{goalsLeanText}</strong>
                  <p>
                    {language === 'zh'
                      ? `大2.5 ${formatProbabilityValue(over25Probability)} / 小2.5 ${formatProbabilityValue(under25Probability)} / BTTS ${formatProbabilityValue(probabilityModel?.bothTeamsToScore?.yes)}`
                      : `Over2.5 ${formatProbabilityValue(over25Probability)} / Under2.5 ${formatProbabilityValue(under25Probability)} / BTTS ${formatProbabilityValue(probabilityModel?.bothTeamsToScore?.yes)}`}
                  </p>
                </section>
              </div>

              <div className="decision-risk-row">
                <span>{language === 'zh' ? '风险标签' : 'Risk tags'}</span>
                <div>
                  {transparentRiskTags.length > 0 ? transparentRiskTags.map((tag) => (
                    <b key={`${tag.zh}-${tag.en}`}>{tag[language]}</b>
                  )) : (
                    <b>{language === 'zh' ? '暂无硬风险标签' : 'No hard risk tag'}</b>
                  )}
                </div>
              </div>
            </div>
            {isFinished && hasPredictions && (
              <div className="card review-card">
                <div className="review-head">
                  <div>
                    <span className="review-kicker">{language === 'zh' ? '赛后复盘' : 'Post-match Review'}</span>
                    <h3>{language === 'zh' ? 'AI 推荐结果回看' : 'AI Prediction Review'}</h3>
                    <p>
                      {language === 'zh'
                        ? `基于赛前官方 SP 快照生成的推荐已按最终比分 ${officialScoreText} 自动结算。`
                        : `Tips generated from pre-match official SP snapshots have been settled against the final score ${officialScoreText}.`}
                    </p>
                  </div>
                  <div className="review-score">
                    <span>{language === 'zh' ? '本场命中率' : 'Hit rate'}</span>
                    <strong>{reviewHitRate === null ? '--' : `${reviewHitRate}%`}</strong>
                  </div>
                </div>
                <div className="review-grid">
                  <div>
                    <span>{language === 'zh' ? '已结算推荐' : 'Settled tips'}</span>
                    <strong>{wonPredictions.length}/{settledPredictions.length}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '主推结果' : 'Main pick'}</span>
                    <strong>{bestReviewPrediction ? getResultLabel(bestReviewPrediction.resultStatus, language) : '--'}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '赛前快照' : 'SP snapshots'}</span>
                    <strong>{match.oddsTrend?.sampleSize || '--'}</strong>
                  </div>
                </div>
                {match.oddsTrend && (
                  <p className="review-trend">{match.oddsTrend.summary[language]}</p>
                )}
              </div>
            )}

            <div className={`card signal-summary-card is-${matchSignal.category}`}>
              <div>
                <span className={`signal-badge is-${matchSignal.category}`}>{matchSignal.label[language]}</span>
                <h3>{language === 'zh' ? '赛前判断' : 'Pre-Match Read'}</h3>
                <p>{matchSignal.note[language]}</p>
              </div>
              <div className="signal-summary-meta">
                <span>{language === 'zh' ? '可信度' : 'Trust'} <strong>{matchSignal.trustScore ? `${matchSignal.trustScore}%` : '--'}</strong></span>
                <span>{language === 'zh' ? '风险项' : 'Risks'} <strong>{matchSignal.riskCount}</strong></span>
                {match.oddsTrend && (
                  <span>{language === 'zh' ? 'SP快照' : 'SP snapshots'} <strong>{match.oddsTrend.sampleSize}</strong></span>
                )}
              </div>
              {match.oddsTrend && (
                <p className="signal-summary-trend">{match.oddsTrend.summary[language]}</p>
              )}
            </div>

            <div className="prediction-policy-note">
              <div>
                <strong>{predictionIsLocked
                  ? (language === 'zh' ? '预测状态：已锁定' : 'Prediction status: locked')
                  : (language === 'zh' ? '预测状态：赛前监控中' : 'Prediction status: monitoring')}</strong>
                <span>
                  {language === 'zh'
                    ? `当前版本：${predictionVersionText} / 生成时间：${formatPolicyTimestamp(predictionGeneratedAt, language)} / 竞彩截止：${formatPolicyTimestamp(predictionCutoffRaw, language)}`
                    : `Version: ${predictionVersionText} / Generated: ${formatPolicyTimestamp(predictionGeneratedAt, language)} / Cutoff: ${formatPolicyTimestamp(predictionCutoffRaw, language)}`}
                </span>
              </div>
              <p>
                {predictionMeta?.dataPolicy?.[language] || (language === 'zh'
                  ? '竞彩截止前允许临场变盘校验；截止后本场预测方向不再修改，只更新赛果与命中状态。'
                  : 'Before cutoff, late market changes may be validated; after cutoff, the prediction direction is not modified, only result settlement is updated.')}
                {predictionMeta?.updateReason && (
                  <em>{predictionMeta.updateReason[language]}</em>
                )}
              </p>
            </div>

            {gptParsed && (
              <div className="card probability-model-card">
                <div className="probability-model-head">
                  <div>
                    <span className="review-kicker">
                      {language === 'zh' ? 'AI 增强分析' : 'AI Enhanced Read'}
                    </span>
                    <h3>{language === 'zh' ? '赛前文字研判' : 'Pre-Match Analyst Note'}</h3>
                    <p>{gptParsed.summary || (language === 'zh' ? '已生成赛前分析。' : 'Pre-match analysis generated.')}</p>
                  </div>
                  <span>{gptPrediction?.relay?.model || 'GPT'}</span>
                </div>

                <div className="probability-model-grid">
                  <section className="probability-panel">
                    <h4>{language === 'zh' ? '方向' : 'Pick'}</h4>
                    <div className="probability-pair-grid">
                      <span>
                        {language === 'zh' ? '市场' : 'Market'}
                        <strong>{gptRecommendation?.market || '--'}</strong>
                      </span>
                      <span>
                        {language === 'zh' ? '选择' : 'Pick'}
                        <strong>{gptRecommendation?.pick || '--'}</strong>
                      </span>
                      <span>
                        {language === 'zh' ? '置信度' : 'Confidence'}
                        <strong>{formatGptProbability(gptRecommendation?.confidence)}</strong>
                      </span>
                      <span>
                        {language === 'zh' ? '风险' : 'Risk'}
                        <strong>{gptRecommendation?.risk || '--'}</strong>
                      </span>
                    </div>
                  </section>

                  <section className="probability-panel">
                    <h4>{language === 'zh' ? '概率' : 'Probabilities'}</h4>
                    <div className="probability-pair-grid">
                      <span>{language === 'zh' ? '主胜' : 'Home'} <strong>{formatGptProbability(gptProbabilities?.home)}</strong></span>
                      <span>{language === 'zh' ? '平局' : 'Draw'} <strong>{formatGptProbability(gptProbabilities?.draw)}</strong></span>
                      <span>{language === 'zh' ? '客胜' : 'Away'} <strong>{formatGptProbability(gptProbabilities?.away)}</strong></span>
                      <span>{language === 'zh' ? '大2.5' : 'Over 2.5'} <strong>{formatGptProbability(gptProbabilities?.over25)}</strong></span>
                    </div>
                  </section>

                  <section className="probability-panel is-wide">
                    <h4>{language === 'zh' ? '分析依据' : 'Reasons'}</h4>
                    <ul className="prediction-analysis-list">
                      {(gptParsed.reasons || []).slice(0, 6).map((reason, index) => (
                        <li key={`gpt-reason-${index}`}>{reason}</li>
                      ))}
                      {(gptParsed.reasons || []).length === 0 && (
                        <li>{language === 'zh' ? '暂无额外文字依据。' : 'No extra analyst reasons yet.'}</li>
                      )}
                    </ul>
                  </section>

                  {gptParsed.missingData && gptParsed.missingData.length > 0 && (
                    <section className="probability-panel">
                      <h4>{language === 'zh' ? '待补数据' : 'Missing Data'}</h4>
                      <ul className="prediction-analysis-list">
                        {gptParsed.missingData.slice(0, 5).map((item, index) => (
                          <li key={`gpt-missing-${index}`}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>

                <p className="probability-calibration-note">
                  {language === 'zh'
                    ? `生成时间：${formatPolicyTimestamp(gptPrediction?.generatedAt, language)}。仅供赛前参考，不构成投注建议。`
                    : `Generated at ${formatPolicyTimestamp(gptPrediction?.generatedAt, language)}. For pre-match reference only.`}
                </p>
              </div>
            )}

            {probabilityModel && (
              <div className="card probability-model-card">
                <div className="probability-model-head">
                  <div>
                    <span className="review-kicker">
                      {language === 'zh' ? '概率预测系统' : 'Probability Forecast'}
                    </span>
                    <h3>{language === 'zh' ? '赛前概率分布' : 'Pre-Match Probability Distribution'}</h3>
                    <p>{probabilityModel.basis[language]}</p>
                  </div>
                  <span>{probabilityModel.version}</span>
                </div>

                <div className="probability-model-grid">
                  <section className="probability-panel is-wide">
                    <h4>{language === 'zh' ? '胜平负概率' : '1X2 Probability'}</h4>
                    {renderOutcomeTriplet(probabilityModel.oneXTwo.final)}
                    <div className="probability-subline">
                      <span>
                        {probabilityModelIsModelOnly
                          ? (language === 'zh' ? '模型基准' : 'Model baseline')
                          : (language === 'zh' ? '市场去水' : 'Market')}：
                        {renderOutcomeLine(probabilityModel.oneXTwo.market)}
                      </span>
                      {probabilityModel.oneXTwo.teamStrength && (
                        <span>
                          {language === 'zh' ? '独立强度：' : 'Team strength: '}
                          {renderOutcomeLine(probabilityModel.oneXTwo.teamStrength)}
                        </span>
                      )}
                      {probabilityModel.oneXTwo.elo && (
                        <span>
                          Elo：
                          {renderOutcomeLine(probabilityModel.oneXTwo.elo)}
                          {probabilityModel.elo && (
                            <>
                              {' '}
                              {language === 'zh'
                                ? `评级 ${probabilityModel.elo.homeRating}/${probabilityModel.elo.awayRating}，样本 ${probabilityModel.elo.homeMatches}/${probabilityModel.elo.awayMatches}`
                                : `rating ${probabilityModel.elo.homeRating}/${probabilityModel.elo.awayRating}, sample ${probabilityModel.elo.homeMatches}/${probabilityModel.elo.awayMatches}`}
                            </>
                          )}
                      </span>
                      )}
                      <span>
                        Poisson：
                        {renderOutcomeLine(probabilityModel.oneXTwo.poisson)}
                      </span>
                      {probabilityModel.oneXTwo.worldCupPrior && (
                        <span>
                          {language === 'zh' ? 'Kimi 世界杯先验：' : 'Kimi World Cup prior: '}
                          {renderOutcomeLine(probabilityModel.oneXTwo.worldCupPrior)}
                          {Number.isFinite(worldCupPriorStrengthDiff) && (
                            <>
                              {' '}
                              {language === 'zh'
                                ? `强度差 ${worldCupPriorStrengthDiff.toFixed(3)}`
                                : `strength diff ${worldCupPriorStrengthDiff.toFixed(3)}`}
                            </>
                          )}
                        </span>
                      )}
                      {probabilityModel.ensembleWeights && (
                        <span className="probability-weight-line">
                          {language === 'zh' ? '集成权重' : 'Ensemble weights'}：
                          {language === 'zh'
                            ? `独立强度 ${formatModelWeight(probabilityModel.ensembleWeights.teamStrength)} / Elo ${formatModelWeight(probabilityModel.ensembleWeights.elo)} / Poisson ${formatModelWeight(probabilityModel.ensembleWeights.poisson)}${Number.isFinite(probabilityModel.ensembleWeights.worldCupPrior) ? ` / 世界杯先验 ${formatModelWeight(probabilityModel.ensembleWeights.worldCupPrior)}` : ''} / SP校验 ${formatModelWeight(probabilityModel.ensembleWeights.market)}`
                            : `team strength ${formatModelWeight(probabilityModel.ensembleWeights.teamStrength)} / Elo ${formatModelWeight(probabilityModel.ensembleWeights.elo)} / Poisson ${formatModelWeight(probabilityModel.ensembleWeights.poisson)}${Number.isFinite(probabilityModel.ensembleWeights.worldCupPrior) ? ` / World Cup prior ${formatModelWeight(probabilityModel.ensembleWeights.worldCupPrior)}` : ''} / SP validation ${formatModelWeight(probabilityModel.ensembleWeights.market)}`}
                        </span>
                      )}
                      {probabilityModel.dynamicCalibration && (
                        <span className="probability-weight-line">
                          {language === 'zh' ? '动态校准' : 'Dynamic calibration'}：
                          {calibrationReasonLabels[probabilityModel.dynamicCalibration.gate?.reason || 'neutral-profile']?.[language] || probabilityModel.dynamicCalibration.gate?.reason || '--'}
                        </span>
                      )}
                    </div>
                  </section>

                  {renderCalculationFormulaPanel()}

                  <section className="probability-panel">
                    <h4>{language === 'zh' ? '比分分布' : 'Score Distribution'}</h4>
                    <div className="score-probability-list">
                      {probabilityModel.scoreDistribution.slice(0, 5).map((scoreItem) => (
                        <span key={scoreItem.label}>
                          <strong>{scoreItem.label}</strong>
                          {formatProbabilityValue(scoreItem.probability)}
                        </span>
                      ))}
                    </div>
                  </section>

                  <section className="probability-panel">
                    <h4>{language === 'zh' ? '进球概率' : 'Goal Probability'}</h4>
                    <div className="probability-pair-grid">
                      <span>{language === 'zh' ? '大 2.5' : 'Over 2.5'} <strong>{formatProbabilityValue(probabilityModel.goalLines.over25)}</strong></span>
                      <span>{language === 'zh' ? '小 2.5' : 'Under 2.5'} <strong>{formatProbabilityValue(probabilityModel.goalLines.under25)}</strong></span>
                    </div>
                  </section>

                  <section className="probability-panel is-full">
                    <h4>{language === 'zh' ? '让球概率' : 'Handicap Probability'}</h4>
                    {probabilityModel.lambdaBlend && (
                      <div className="probability-pair-grid" style={{ marginBottom: '0.75rem' }}>
                        <span>
                          {probabilityModelIsModelOnly
                            ? (language === 'zh' ? '模型期望' : 'Model xG')
                            : (language === 'zh' ? '市场期望' : 'Market xG')}
                          <strong>{formatDecimal(probabilityModel.lambdaBlend.marketHomeLambda)} / {formatDecimal(probabilityModel.lambdaBlend.marketAwayLambda)}</strong>
                        </span>
                        <span>
                          {language === 'zh' ? '近况期望' : 'Form xG'}
                          <strong>{formatDecimal(probabilityModel.lambdaBlend.formHomeLambda)} / {formatDecimal(probabilityModel.lambdaBlend.formAwayLambda)}</strong>
                        </span>
                        <span>
                          {language === 'zh' ? '修正权重' : 'Form weight'}
                          <strong>{formatModelWeight(probabilityModel.lambdaBlend.formWeight)}</strong>
                        </span>
                        <span>
                          {language === 'zh' ? '样本' : 'Samples'}
                          <strong>{probabilityModel.form?.home.sampleSize || 0} / {probabilityModel.form?.away.sampleSize || 0}</strong>
                        </span>
                      </div>
                    )}
                    {probabilityModel.modelHealth && (
                      <div className="probability-pair-grid" style={{ marginBottom: '0.75rem' }}>
                        {(['1X2', 'GOALS', 'BEST'] as const).map((marketKey) => {
                          const bucket = probabilityModel.modelHealth?.byMarket?.[marketKey];
                          return (
                            <span key={marketKey}>
                              {marketKey}
                              <strong>{formatHealthRate(bucket?.hitRate)}</strong>
                              <em>{bucket?.settled || 0} {language === 'zh' ? '条' : 'settled'}</em>
                            </span>
                          );
                        })}
                        {probabilityModel.modelHealth.homeFavorite && (
                          <span>
                            {language === 'zh' ? '主胜桶' : 'Home bucket'}
                            <strong>{formatHealthRate(probabilityModel.modelHealth.homeFavorite.hitRate)}</strong>
                            <em>{probabilityModel.modelHealth.homeFavorite.settled || 0} {language === 'zh' ? '条' : 'settled'}</em>
                          </span>
                        )}
                        {probabilityModel.modelHealth.lowSpSide && (
                          <span>
                            {language === 'zh' ? '低赔边' : 'Low-SP side'}
                            <strong>{formatHealthRate(probabilityModel.modelHealth.lowSpSide.hitRate)}</strong>
                            <em>{probabilityModel.modelHealth.lowSpSide.settled || 0} {language === 'zh' ? '条' : 'settled'}</em>
                          </span>
                        )}
                        {(probabilityModel.modelHealth.byMarket['1X2']?.cooldown || probabilityModel.modelHealth.byMarket.GOALS?.cooldown) && (
                          <span>
                            {language === 'zh' ? '冷却' : 'Cooldown'}
                            <strong>{language === 'zh' ? '开启' : 'On'}</strong>
                          </span>
                        )}
                      </div>
                    )}
                    {probabilityModel.dynamicCalibration && (
                      <div className="probability-pair-grid" style={{ marginBottom: '0.75rem' }}>
                        <span>
                          {language === 'zh' ? '场景' : 'Profile'}
                          <strong>{probabilityModel.dynamicCalibration.profileKey}</strong>
                          <em>{probabilityModel.dynamicCalibration.version}</em>
                        </span>
                        <span>
                          {language === 'zh' ? '胜平负命中' : '1X2 hit'}
                          <strong>{formatHealthRate(probabilityModel.dynamicCalibration.metrics?.oneXTwoHitRate)}</strong>
                          <em>Brier {probabilityModel.dynamicCalibration.metrics?.oneXTwoBrier ?? '--'}</em>
                        </span>
                        <span>
                          {language === 'zh' ? '推荐惩罚' : 'Trust brake'}
                          <strong>{probabilityModel.dynamicCalibration.gate?.trustPenalty || 0}</strong>
                          <em>{language === 'zh' ? '分' : 'pts'}</em>
                        </span>
                        <span>
                          {language === 'zh' ? '门槛变化' : 'Gate shift'}
                          <strong>{formatSignedPercentBoost(probabilityModel.dynamicCalibration.gate?.minProbabilityBoost)}</strong>
                          <em>{language === 'zh' ? `让球 ${formatSignedPercentBoost(probabilityModel.dynamicCalibration.gate?.minHandicapSupportBoost)}` : `HHAD ${formatSignedPercentBoost(probabilityModel.dynamicCalibration.gate?.minHandicapSupportBoost)}`}</em>
                        </span>
                      </div>
                    )}
                    {(probabilityModel.calibrationAdjustment?.oneXTwo?.applied || probabilityModel.calibrationAdjustment?.goals?.applied) && (
                      <div className="probability-pair-grid" style={{ marginBottom: '0.75rem' }}>
                        {probabilityModel.calibrationAdjustment?.oneXTwo?.applied && (
                          <span>
                            {language === 'zh' ? '胜平负校准' : '1X2 calibration'}
                            <strong>{language === 'zh' ? '已降温' : 'Active'}</strong>
                            <em>{probabilityModel.calibrationAdjustment.oneXTwo.adjustments.length} {language === 'zh' ? '项' : 'rules'}</em>
                          </span>
                        )}
                        {probabilityModel.calibrationAdjustment?.goals?.applied && (
                          <span>
                            {language === 'zh' ? '进球校准' : 'Goals calibration'}
                            <strong>{formatModelWeight(probabilityModel.calibrationAdjustment.goals.shrinkFactor)}</strong>
                            <em>{probabilityModel.calibrationAdjustment.goals.before.over25}% {'to'} {probabilityModel.calibrationAdjustment.goals.after.over25}%</em>
                          </span>
                        )}
                      </div>
                    )}
                    {probabilityModel.handicap ? (
                      <>
                        <div className="handicap-probability-line">
                          {language === 'zh' ? '让球' : 'Line'} <strong>{probabilityModel.handicap.line}</strong>
                        </div>
                        {renderOutcomeTriplet(probabilityModel.handicap.market || probabilityModel.handicap.poisson, handicapOutcomeLabels)}
                      </>
                    ) : (
                      <p className="probability-empty">
                        {language === 'zh' ? '暂无官方让球盘，先以 HAD 与比分分布观察。' : 'No official handicap pool yet; use HAD and score distribution first.'}
                      </p>
                    )}
                  </section>
                </div>

                <p className="probability-calibration-note">
                  {probabilityModel.calibration?.[language] || (language === 'zh'
                    ? '概率先由独立强度、Elo、Poisson、世界杯先验生成，再按滚动命中表现做风险校准；SP 只参与市场分歧校验。'
                    : 'Probabilities are generated from independent strength, Elo, Poisson, and World Cup priors, then risk-calibrated by rolling results; SP is market-divergence validation only.')}
                </p>
              </div>
            )}

            <div className="card factor-analysis-card">
              <div className="factor-analysis-head">
                <div>
                  <span className="review-kicker">
                    {language === 'zh' ? '影响因素拆解' : 'Factor breakdown'}
                  </span>
                  <h3>{language === 'zh' ? '模型如何分析这场比赛' : 'How this match is analyzed'}</h3>
                  <p>
                    {language === 'zh'
                      ? '推荐不是单点判断，而是先用长期强弱、近况、进球分布、世界杯先验和可验证赛前信息生成独立概率，再用官方 SP 与外部均赔做分歧校验。'
                      : 'The pick is not a single signal: independent probability is built from long-run strength, form, goal distribution, World Cup priors, and verified pre-match information; official SP and external odds validate divergence.'}
                  </p>
                </div>
              </div>
              <div className="factor-card-grid">
                {factorCards.map((item) => (
                  <div key={item.title} className={`factor-card is-${item.tone}`}>
                    <span>{item.title}</span>
                    <strong>{item.value}</strong>
                    <p>{item.body}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className={`card insight-card is-${matchInsight.tone}`}>
              <div className="insight-head">
                <div>
                  <span className={`insight-action is-${matchInsight.tone}`}>{matchInsight.action[language]}</span>
                  <h3>{matchInsight.title[language]}</h3>
                  <p>{matchInsight.summary[language]}</p>
                </div>
                <div className="insight-score">
                  <span>{language === 'zh' ? '综合评分' : 'Score'}</span>
                  <strong>{matchInsight.score === null ? '--' : matchInsight.score}</strong>
                </div>
              </div>

              <div className="insight-metric-grid">
                {matchInsight.metrics.map((metric) => (
                  <div key={`${metric.label.zh}-${metric.value.zh}`} className={`insight-metric is-${metric.tone}`}>
                    <span>{metric.label[language]}</span>
                    <strong>{metric.value[language]}</strong>
                  </div>
                ))}
              </div>

              <div className="insight-section-grid">
                <div>
                  <h4>{language === 'zh' ? '支撑因素' : 'Drivers'}</h4>
                  <div className="insight-point-list">
                    {matchInsight.drivers.map((point) => (
                      <div key={point.title.zh} className={`insight-point is-${point.tone}`}>
                        <strong>{point.title[language]}</strong>
                        <p>{point.body[language]}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h4>{language === 'zh' ? '观察风险' : 'Watchpoints'}</h4>
                  <div className="insight-point-list">
                    {matchInsight.watchpoints.map((point) => (
                      <div key={point.title.zh} className={`insight-point is-${point.tone}`}>
                        <strong>{point.title[language]}</strong>
                        <p>{point.body[language]}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="card professional-framework-card">
              <div className="professional-framework-head">
                <div>
                  <span className="review-kicker">
                    {language === 'zh' ? '专业分析框架' : 'Professional framework'}
                  </span>
                  <h3>{language === 'zh' ? '12项赛前分析框架' : '12-Point Pre-Match Framework'}</h3>
                  <p>
                    {language === 'zh'
                      ? '综合 Elo 强度、近一年攻防、赛程密度、比分分布、世界杯先验与赛前信息层生成判断；官方 SP、让球和走势只做校验与风险标记。'
                      : 'Combines Elo strength, last-year form, schedule density, score distribution, World Cup priors, and pre-match signals; official SP, handicap, and movement are validation and risk markers only.'}
                  </p>
                </div>
                <span>{predictionMeta?.promptVersion || 'professional-football-analyst-v1'}</span>
              </div>
              <div className="prompt-upgrade-strip">
                <strong>{language === 'zh' ? '数据覆盖' : 'Data coverage'}</strong>
                <span>
                  {language === 'zh'
                    ? '官方 HAD / HHAD SP、SP 快照走势、赛果归档、Elo 强度、近一年攻防样本、赛程密度与进球模型。'
                    : 'Official HAD / HHAD SP, SP movement, result archive, Elo strength, last-year form, schedule density, and goal model.'}
                </span>
                <span>
                  {language === 'zh'
                    ? '伤停、首发、天气、裁判、xG/xGA 与外部赔率进入赛前信息层，随可验证信号辅助修正风险判断。'
                    : 'Injuries, lineups, weather, referees, xG/xGA, and external odds feed the pre-match signal layer when verified.'}
                </span>
              </div>
              <div className="professional-framework-grid">
                {matchInsight.framework.map((point) => (
                  <div key={point.title.zh} className={`professional-framework-item is-${point.tone}`}>
                    <strong>{point.title[language]}</strong>
                    <p>{point.body[language]}</p>
                  </div>
                ))}
              </div>
            </div>
            
            {/* 比分推演卡片 */}
            <div className={`card weather-analysis-card is-${weatherRiskTone}`}>
              <div className="weather-analysis-head">
                <div>
                  <span className="review-kicker">
                    {language === 'zh' ? '天气与场地因素' : 'Weather and pitch factors'}
                  </span>
                  <h3>{weatherImpactLabel}</h3>
                  <p>
                    {weatherVerified
                      ? (weatherSummary || (language === 'zh' ? '已读取天气信号，当前仅作为赛前风险层修正。' : 'Weather signal is loaded and used as a pre-match risk modifier.'))
                      : (language === 'zh'
                        ? '当前赛程没有可验证的实时天气/场地字段，所以模型不会因为天气改动胜平负或进球概率。页面保留这个模块，是为了明确哪些因素暂未进入计算。'
                        : 'No verified live weather or pitch field is available for this fixture, so probabilities are not changed by weather. This module is shown to make missing factors explicit.')}
                  </p>
                </div>
                <div className="weather-source-stack">
                  <span className={`weather-source-badge is-${weatherSourceStatus}`}>{weatherStatusLabel}</span>
                  <span>{weatherSourceLabel}</span>
                </div>
              </div>

              <p className={`weather-status-note is-${weatherSourceStatus}`}>{weatherStatusDescription}</p>

              <div className="weather-metric-grid">
                {weatherMetrics.map((item) => (
                  <div key={item.label} className="weather-metric">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>

              <div className="weather-rule-grid">
                <section>
                  <h4>{language === 'zh' ? '当前处理' : 'Current handling'}</h4>
                  <p>
                    {weatherVerified
                      ? (language === 'zh'
                        ? '天气只进入风险层：恶劣天气会压低进球信心、提高让球不确定性；不会单独推翻独立模型主线。'
                        : 'Weather only enters the risk layer: severe weather lowers goal confidence and increases handicap uncertainty, but does not override the independent model.')
                      : (language === 'zh'
                        ? '无验证天气时，系统按“中性天气”处理，避免把猜测写进概率。'
                        : 'Without verified weather, the system treats weather as neutral to avoid injecting guesses into probabilities.')}
                  </p>
                </section>
                <section>
                  <h4>{language === 'zh' ? '后续接入规则' : 'Planned rules'}</h4>
                  <p>
                    {language === 'zh'
                      ? '大雨/积水：下调大球与强让球；大风：降低传中和远射稳定性；高温高湿：提高后程体能风险；低温雪地：提高冷门和失误风险。'
                      : 'Heavy rain lowers over-goals and strong handicap confidence; wind reduces crossing/shot stability; heat and humidity raise late fatigue risk; cold or snow raises upset/error risk.'}
                  </p>
                </section>
                <section>
                  <h4>{language === 'zh' ? '场地信息' : 'Venue info'}</h4>
                  <p>
                    {venueSummary
                      || externalSignals?.venue?.name
                      || (language === 'zh'
                        ? '暂无可验证场地/草皮信息，暂不参与加权。'
                        : 'No verified venue or pitch data yet, so no pitch weighting is applied.')}
                  </p>
                </section>
              </div>
            </div>

            {hasPredictions && (
              <div className="card score-projection-card" style={{
                background: 'linear-gradient(135deg, hsl(var(--primary) / 0.05) 0%, transparent 100%)',
                borderColor: 'hsl(var(--primary) / 0.2)',
                position: 'relative',
                overflow: 'hidden'
              }}>
                <h4 style={{ fontSize: '0.9rem', color: 'hsl(var(--primary))', textTransform: 'uppercase', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Trophy size={16} />
                  {t('scorePrediction')}
                </h4>
                <div style={{ fontSize: '2.5rem', fontWeight: '900', fontFamily: 'var(--font-title)', margin: '0.75rem 0' }}>
                  {projectedScoreText}
                </div>
                {actualScoreText && (
                  <p style={{ fontSize: '0.78rem', color: 'hsl(var(--primary))', fontWeight: 850, marginBottom: '0.45rem' }}>
                    {actualScoreText}
                    {' · '}
                    {language === 'zh' ? '预测比分不回写' : 'forecast score is not rewritten'}
                  </p>
                )}
                <p style={{ fontSize: '0.825rem', color: 'hsl(var(--text-secondary))' }}>
                  {language === 'zh'
                    ? `模型基于独立 lambda 与 Poisson 比分分布推演，当前热区约 ${match.stats?.xG.home?.toFixed(2) ?? '--'} : ${match.stats?.xG.away?.toFixed(2) ?? '--'}。`
                    : `Derived from independent lambdas and the Poisson score distribution. Current heat zone is about ${match.stats?.xG.home?.toFixed(2) ?? '--'} : ${match.stats?.xG.away?.toFixed(2) ?? '--'}.`}
                </p>
                <p style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', marginTop: '0.5rem' }}>
                  {t('referenceText')}
                </p>
              </div>
            )}

            {/* 预测列表 */}
            {recommendationTipPredictions.length ? (
              recommendationTipPredictions.map(pred => renderPredictionBlock(pred))
            ) : (
              <div className="card prediction-empty-card" style={{ color: 'hsl(var(--text-secondary))', lineHeight: 1.6 }}>
                {language === 'zh'
                  ? isFinished
                    ? '这场是官方历史赛果记录，只展示比分与赛程信息。'
                    : '这场暂时没有可展示的比分或进球数推荐。'
                  : isFinished
                    ? 'This is an official historical result record with score and schedule information only.'
                    : 'No score or goals recommendation is currently available for this fixture.'}
              </div>
            )}

          </div>
        )}

        {/* Tab 2: 统计数据 */}
        {activeTab === 'stats' && (
          match.stats ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '700', fontFamily: 'var(--font-title)' }}>
              {language === 'zh' ? 'AI 模型参数预测' : 'AI Model Parameters'}
            </h3>
            
            {/* 进度条统计 */}
            {[
              { label: 'xG (期望进球)', home: match.stats.xG.home, away: match.stats.xG.away, unit: '' },
              { label: '控球率 (Possession)', home: match.stats.possession.home, away: match.stats.possession.away, unit: '%' },
              { label: '射门数 (Shots)', home: match.stats.shots.home, away: match.stats.shots.away, unit: '' },
              { label: '射正数 (Shots on Target)', home: match.stats.shotsOnTarget.home, away: match.stats.shotsOnTarget.away, unit: '' },
              { label: '角球 (Corners)', home: match.stats.corners.home, away: match.stats.corners.away, unit: '' },
              { label: '黄牌 (Yellow Cards)', home: match.stats.yellowCards.home, away: match.stats.yellowCards.away, unit: '' },
            ].map((stat, idx) => {
              const total = stat.home + stat.away;
              const homePct = total === 0 ? 50 : Math.round((stat.home / total) * 100);
              const awayPct = 100 - homePct;

              return (
                <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: '500' }}>
                    <span>{stat.home}{stat.unit}</span>
                    <span style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.8rem' }}>{stat.label}</span>
                    <span>{stat.away}{stat.unit}</span>
                  </div>
                  {/* 双向进度条 */}
                  <div style={{ display: 'flex', width: '100%', height: '8px', backgroundColor: 'hsl(var(--border))', borderRadius: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${homePct}%`, backgroundColor: homeTeam.color, transition: 'width 0.3s' }} />
                    <div style={{ width: `${awayPct}%`, backgroundColor: awayTeam.color, transition: 'width 0.3s' }} />
                  </div>
                </div>
              );
            })}
            </div>
          ) : (
            <div className="card data-quality-note">
              {language === 'zh'
                ? '这场比赛当前只有官方赛果记录，没有可验证的赛前模型参数，因此不展示模拟统计。'
                : 'This match only has an official result record, so no simulated model stats are shown.'}
            </div>
          )
        )}

        {/* Tab 3: 近期战绩 */}
        {activeTab === 'form' && (
          <div className="form-history-stack">
            <div className="form-summary-grid">
              {renderFormSummaryCard(homeTeam.shortName[language], homeTeam.color, homeHistory)}
              {renderFormSummaryCard(awayTeam.shortName[language], awayTeam.color, awayHistory)}
            </div>

            <div className="card team-history-card">
              <div className="history-card-head">
                <div>
                  <h4>{language === 'zh' ? '双方近一年官方赛果' : 'Last-Year Official Team Results'}</h4>
                  <p>
                    {language === 'zh'
                      ? `按开赛时间往前 365 天追溯同队比赛，单队最多展示最近 ${TEAM_HISTORY_DISPLAY_LIMIT} 场。统计窗口：${historyCoverageLabel}，来源：${historyDataSourceLabel}。`
                      : `Matched by the 365-day window before kickoff. Showing up to ${TEAM_HISTORY_DISPLAY_LIMIT} recent matches per team. Window: ${historyCoverageLabel}; source: ${historyDataSourceLabel}.`}
                  </p>
                </div>
              </div>
              <div className="team-history-grid">
                {renderHistoryColumn(homeTeam.shortName[language], homeHistory)}
                {renderHistoryColumn(awayTeam.shortName[language], awayHistory)}
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: 交锋历史 */}
        {activeTab === 'h2h' && (
          <div className="card h2h-card">
            <div className="history-card-head">
              <div>
                <h3>{language === 'zh' ? '近一年直接交锋' : 'Last-Year Head-to-Head'}</h3>
                <p>
                  {language === 'zh'
                    ? `仅展示开赛前 365 天窗口内的双方直接交锋，最多展示 ${H2H_DISPLAY_LIMIT} 场。统计窗口：${historyCoverageLabel}，来源：${historyDataSourceLabel}。`
                    : `Only direct head-to-head results inside the 365-day pre-kickoff window are shown, up to ${H2H_DISPLAY_LIMIT} matches. Window: ${historyCoverageLabel}; source: ${historyDataSourceLabel}.`}
                </p>
              </div>
            </div>

            {headToHead.rows.length > 0 ? (
              <div className="h2h-list">
                {headToHead.rows.map((item) => (
                  <div key={item.id} className="h2h-row">
                    <div className="history-row-meta">
                      <span>{item.dateLabel}</span>
                      <span>{item.competition}</span>
                    </div>
                    <div className="h2h-match-line">
                      <span>{item.homeName}</span>
                      <strong>{item.homeScore} - {item.awayScore}</strong>
                      <span>{item.awayName}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="history-empty">
                {language === 'zh'
                  ? '近一年窗口暂未匹配到这两队的直接交锋。'
                  : 'No direct head-to-head result found in the last-year window.'}
              </div>
            )}
            {headToHead.sampleSize > headToHead.rows.length && (
              <p className="history-overflow-note">
                {language === 'zh'
                  ? `已匹配 ${headToHead.sampleSize} 场，当前仅展示最近 ${headToHead.rows.length} 场。`
                  : `${headToHead.sampleSize} matches found. Showing latest ${headToHead.rows.length}.`}
              </p>
            )}
          </div>
        )}

        {/* Tab 5: 积分榜 */}
        {activeTab === 'standings' && (
          match.standings && match.standings.length > 0 ? (
            <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
              <div style={{ padding: '1rem', backgroundColor: 'hsl(var(--bg-card-hover))', borderBottom: '1px solid hsl(var(--border))', fontWeight: '700' }}>
                {league.name[language]} - {language === 'zh' ? '最新排名' : 'Standings Table'}
              </div>

              <table className="responsive-table">
                <thead>
                  <tr>
                    <th style={{ width: '60px', textAlign: 'center' }}>排名</th>
                    <th>球队</th>
                    <th style={{ textAlign: 'center' }}>已赛</th>
                    <th style={{ textAlign: 'center' }}>胜</th>
                    <th style={{ textAlign: 'center' }}>平</th>
                    <th style={{ textAlign: 'center' }}>负</th>
                    <th style={{ textAlign: 'center' }}>进/失球</th>
                    <th style={{ textAlign: 'center', fontWeight: '700' }}>积分</th>
                  </tr>
                </thead>
                <tbody>
                  {match.standings.map((row) => {
                    const teamObj = getTeamById(row.teamId);
                    const isCurrentMatchTeam = teamObj.id === homeTeam.id || teamObj.id === awayTeam.id;

                    return (
                      <tr
                        key={row.position}
                        style={{
                          backgroundColor: isCurrentMatchTeam ? 'hsl(var(--primary) / 0.08)' : 'transparent',
                          fontWeight: isCurrentMatchTeam ? '700' : 'normal'
                        }}
                      >
                        <td data-label="排名" style={{ textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-flex', width: '22px', height: '22px', borderRadius: '50%',
                            backgroundColor: row.position <= 3 ? 'hsl(var(--primary) / 0.15)' : 'transparent',
                            color: row.position <= 3 ? 'hsl(var(--primary))' : 'hsl(var(--text-secondary))',
                            alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: '700'
                          }}>
                            {row.position}
                          </span>
                        </td>
                        <td data-label="球队">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: teamObj.color }} />
                            <span>{teamObj.name[language]}</span>
                          </div>
                        </td>
                        <td data-label="已赛" style={{ textAlign: 'center' }}>{row.played}</td>
                        <td data-label="胜" style={{ textAlign: 'center', color: 'hsl(var(--primary))' }}>{row.wins}</td>
                        <td data-label="平" style={{ textAlign: 'center' }}>{row.draws}</td>
                        <td data-label="负" style={{ textAlign: 'center', color: 'hsl(var(--danger))' }}>{row.losses}</td>
                        <td data-label="得失球" style={{ textAlign: 'center', color: 'hsl(var(--text-secondary))', fontSize: '0.8rem' }}>
                          {row.goalsFor}:{row.goalsAgainst}
                        </td>
                        <td data-label="积分" style={{ textAlign: 'center', fontWeight: '800', color: 'hsl(var(--primary))' }}>{row.points}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card data-quality-note">
              {language === 'zh'
                ? '本场官网没有返回可用积分榜，页面改用 Elo 强度、长期样本和近一年赛果做强弱参考，不展示模拟排名。'
                : 'No usable official table was returned for this fixture, so the page uses Elo strength, long-run samples, and last-year results instead of a simulated table.'}
            </div>
          )
        )}

      </div>

    </div>
  );
};
