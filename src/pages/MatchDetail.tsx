import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContextCore';
import type { FiveHundredRecentFormRow, League, Match, OutcomeProbability, PredictionDetail, ScoreProbability, Team } from '../services/mockData';
import {
  getOfficialMatchOdds,
  getOfficialResultPoolAvailability,
  getPredictionMarketLabel,
  getPredictionTipDisplay,
  getSportteryPoolRows,
  isPredictionOfficialResultPoolAvailable
} from '../services/bettingDisplay';
import { getCountryById, getLeagueById, getTeamById } from '../services/entities';
import { getMatchSignal } from '../services/matchSignal';
import { buildMatchInsight } from '../services/predictionInsight';
import { getVisiblePrediction, getVisiblePredictions } from '../services/predictionVisibility';
import { buildPublicRecommendationCopy } from '../services/recommendationCopy';
import { getDisplayRecommendation } from '../services/displayRecommendation';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl, buildStaticUrl } from '../services/runtimeUrls';
import { buildFiveHundredDisplay } from '../services/fiveHundredDisplay';
import { TeamBadge } from '../components/TeamBadge';
import { ArrowLeft, Trophy } from 'lucide-react';
import { getWorldCupSeededFixtures } from '../services/worldCupData';

interface MatchDetailProps {
  matchId: string;
  onBack: () => void;
}

type Language = 'zh' | 'en';
type PredictionView = 'summary' | 'tips' | 'model' | 'factors' | 'weather';
type PostReviewRow = NonNullable<Match['postMatchReview']>['predictionReview']['rows'][number];

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
  source: 'model' | 'locked' | 'review';
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

const isSettledReviewStatus = (status: string | undefined) => (
  status === 'WON' || status === 'LOST'
);

const getPrimaryPostReviewRow = (rows: PostReviewRow[]): PostReviewRow | undefined => {
  const settledRows = rows.filter((row) => isSettledReviewStatus(row.resultStatus));
  if (!settledRows.length) return undefined;
  return settledRows.find((row) => row.reviewRole === 'main')
    || settledRows.find((row) => row.marketType === 'BEST')
    || settledRows[0];
};

const predictionFromPostReviewRow = (row: PostReviewRow | undefined): PredictionDetail | undefined => {
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

const isFinishedWithScore = (match: Match): match is FinishedMatch => {
  return match.status === 'FINISHED' && Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);
};

const hasOfficialScore = (match: Match) => Number.isFinite(match.scoreHome) && Number.isFinite(match.scoreAway);

const isOutcomeTipCode = (tipCode: string | undefined): tipCode is '1' | 'X' | '2' => (
  tipCode === '1' || tipCode === 'X' || tipCode === '2'
);

type OutcomeCode = '1' | 'X' | '2';
type RankedOutcome = { code: OutcomeCode; probability: number };

const rankOutcomeProbabilities = (probabilities?: OutcomeProbability | null): RankedOutcome[] => ([
  { code: '1' as OutcomeCode, probability: probabilities?.home },
  { code: 'X' as OutcomeCode, probability: probabilities?.draw },
  { code: '2' as OutcomeCode, probability: probabilities?.away }
])
  .map((item) => ({ ...item, probability: Number(item.probability) }))
  .filter((item): item is RankedOutcome => Number.isFinite(item.probability))
  .sort((a, b) => b.probability - a.probability);

const handicapTipLabel = (code: OutcomeCode) => {
  if (code === '1') return { zh: '让胜', en: 'Handicap home' };
  if (code === 'X') return { zh: '让平', en: 'Handicap draw' };
  return { zh: '让负', en: 'Handicap away' };
};

const getOutcomeOddsValue = (match: Match, poolCode: 'HAD' | 'HHAD', code: OutcomeCode) => {
  const resolvedOdds = getOfficialMatchOdds(match);
  const odds = poolCode === 'HHAD' ? resolvedOdds.hhad?.odds : resolvedOdds.had?.odds;
  const value = code === '1' ? odds?.odds1 : code === 'X' ? odds?.oddsX : odds?.odds2;
  return Number.isFinite(value) ? Number(value) : 0;
};

const handicapResultStatus = (match: Match, code: OutcomeCode): PredictionDetail['resultStatus'] => {
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return 'PENDING';
  const line = Number(String(match.handicapLine || '').replace(/[^\d.+-]/g, ''));
  if (!Number.isFinite(line)) return 'PENDING';
  const adjustedHome = Number(match.scoreHome) + line;
  const away = Number(match.scoreAway);
  const actual = adjustedHome > away ? '1' : adjustedHome === away ? 'X' : '2';
  return actual === code ? 'WON' : 'LOST';
};

const getHandicapRead = (match: Match) => {
  const modelRows = rankOutcomeProbabilities(
    match.probabilityModel?.handicap?.scoreImplied
      || match.probabilityModel?.handicap?.poisson
      || match.probabilityModel?.handicap?.market
  );
  const marketRows = rankOutcomeProbabilities(match.probabilityModel?.handicap?.market);
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

const isReferencePrediction = (prediction?: PredictionDetail) => (
  prediction?.recommendationAction === 'reference' || prediction?.recommendationTier === 'reference'
);

const isHandicapMarketContradicted = (match: Match, prediction?: PredictionDetail) => {
  if (prediction?.oddsPoolCode !== 'HHAD' || !isOutcomeTipCode(prediction.tipCode)) return false;
  const read = getHandicapRead(match);
  return Boolean(
    read.modelTop
    && read.marketTop
    && read.modelTop.code === prediction.tipCode
    && read.marketTop.code !== prediction.tipCode
    && read.marketSupport !== null
    && read.marketSupport < 38
  );
};

const getHandicapOverridePrediction = (match: Match, promotedPrediction?: PredictionDetail): PredictionDetail | undefined => {
  if (promotedPrediction?.oddsPoolCode === 'HHAD' && !isHandicapMarketContradicted(match, promotedPrediction)) return undefined;

  const read = getHandicapRead(match);
  if (!read.modelTop || !read.marketTop || read.marketTop.code !== read.modelTop.code || read.marketSupport === null) return undefined;

  const promotedIsWeak = !promotedPrediction
    || promotedPrediction.tipCode === 'WATCH'
    || isReferencePrediction(promotedPrediction)
    || Number(promotedPrediction.trustScore || 0) <= 45;
  if (!promotedIsWeak) return undefined;

  const spreadOk = read.modelMarketSpread === null
    || read.modelMarketSpread <= (read.modelTop.probability >= 64 ? 18 : 22);
  const strongModel = read.modelTop.probability >= 56
    && read.modelGap >= 15
    && read.marketSupport >= 38
    && spreadOk;
  const marketRescue = read.modelTop.probability >= 45
    && read.modelGap >= 14
    && read.marketSupport >= 48;
  if (!strongModel && !marketRescue) return undefined;

  const label = handicapTipLabel(read.modelTop.code);
  return {
    marketType: '1X2',
    oddsPoolCode: 'HHAD',
    handicapLine: match.handicapLine,
    tipCode: read.modelTop.code,
    tipLabel: label,
    odds: getOutcomeOddsValue(match, 'HHAD', read.modelTop.code),
    trustScore: Math.round(Math.max(read.modelTop.probability, read.marketSupport)),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-override-reference',
    explanation: {
      zh: `普通胜平负不作为本场主推荐，让球模型和官方让球盘同向，推荐切换为${label.zh}。`,
      en: `The raw 1X2 lane is not used as the main pick; model and official HHAD align, so the pick switches to ${label.en}.`
    },
    analysisItems: [],
    riskTags: [{ zh: '让球接管推荐', en: 'HHAD override pick' }],
    visibilityStatus: 'FREE',
    resultStatus: handicapResultStatus(match, read.modelTop.code)
  };
};

const getHandicapMarketReferencePrediction = (match: Match): PredictionDetail | undefined => {
  const read = getHandicapRead(match);
  if (!read.marketTop) return undefined;

  const label = handicapTipLabel(read.marketTop.code);
  return {
    marketType: '1X2',
    oddsPoolCode: 'HHAD',
    handicapLine: match.handicapLine,
    tipCode: read.marketTop.code,
    tipLabel: label,
    odds: getOutcomeOddsValue(match, 'HHAD', read.marketTop.code),
    trustScore: Math.round(read.marketTop.probability),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-market-reference',
    explanation: {
      zh: `普通胜平负未开售，本场只按让球胜平负推荐：${label.zh}。`,
      en: `Standard 1X2 is not on sale, so this fixture is recommended through HHAD: ${label.en}.`
    },
    analysisItems: [],
    riskTags: [{ zh: '仅让球开售', en: 'HHAD only' }],
    visibilityStatus: 'FREE',
    resultStatus: handicapResultStatus(match, read.marketTop.code)
  };
};

const getScoreOutcomeCode = (score: Pick<ScoreProbability, 'home' | 'away'>): '1' | 'X' | '2' => {
  if (score.home > score.away) return '1';
  if (score.home < score.away) return '2';
  return 'X';
};

const scoreCandidateKey = (score: Pick<ScoreProbability, 'home' | 'away'> & { label?: string }) => (
  Number.isFinite(score.home) && Number.isFinite(score.away)
    ? `${score.home}-${score.away}`
    : String(score.label || '').replace(/\s+/g, '')
);

const scoreCandidateLabel = (score: Pick<ScoreProbability, 'home' | 'away'>) => `${score.home}-${score.away}`;

const parseScoreLabel = (value: string | null | undefined): Pick<ScoreProbability, 'home' | 'away'> | null => {
  const matched = String(value || '').match(/(\d+)\s*[-:：]\s*(\d+)/);
  if (!matched) return null;
  return {
    home: Number(matched[1]),
    away: Number(matched[2])
  };
};

const compactPickLabel = (value: string | null | undefined) => {
  return String(value || '')
    .replace(/^推荐\s+/, '')
    .replace(/^参考倾向\s+/, '参考')
    .replace(/\s+/g, '');
};

const compactVersionLabel = (value: string | null | undefined, language: 'zh' | 'en') => {
  const text = String(value || '').trim();
  if (!text) return '--';
  const version = text.match(/v\d+/i);
  if (version) return version[0].toUpperCase();
  if (/unified-poisson/i.test(text)) return language === 'zh' ? '统一模型' : 'Unified';
  if (/post-match-review/i.test(text)) return language === 'zh' ? '复盘v1' : 'Review v1';
  return text.split('-').slice(0, 2).join('-') || text;
};

const dedupeScoreCandidates = <T extends Pick<ScoreProbability, 'home' | 'away'> & { label?: string }>(scores: T[]) => {
  const seen = new Set<string>();
  return scores.filter((score) => {
    const key = scoreCandidateKey(score);
    if (seen.has(key)) return false;
    seen.add(key);
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

const normalizeHistoryTeamName = (value: string | undefined) => (
  String(value || '').replace(/\s+/g, '').toLowerCase()
);

const parseFiveHundredScore = (scoreText: string | undefined) => {
  const matched = String(scoreText || '').match(/(\d+)\s*[:：]\s*(\d+)/);
  if (!matched) return null;

  const home = Number(matched[1]);
  const away = Number(matched[2]);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;

  return { home, away };
};

const normalizeFiveHundredHistoryDate = (date: string | undefined) => {
  const raw = String(date || '').trim();
  const shortDate = raw.match(/^(\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (shortDate) {
    return `20${shortDate[1]}-${shortDate[2].padStart(2, '0')}-${shortDate[3].padStart(2, '0')}`;
  }

  const fullDate = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (fullDate) {
    return `${fullDate[1]}-${fullDate[2].padStart(2, '0')}-${fullDate[3].padStart(2, '0')}`;
  }

  return '';
};

const buildTeamHistoryFromFiveHundred = (
  rows: FiveHundredRecentFormRow[] | undefined,
  teamName: string | undefined,
  language: Language
): TeamHistorySummary | null => {
  const normalizedTeam = normalizeHistoryTeamName(teamName);
  if (!rows?.length || !normalizedTeam) return null;

  const mappedRows = rows
    .map<TeamHistoryResult | null>((row, index) => {
      const score = parseFiveHundredScore(row.scoreText);
      if (!score) return null;

      const homeName = row.homeTeamName || '';
      const awayName = row.awayTeamName || '';
      const isHomeSide = normalizeHistoryTeamName(homeName) === normalizedTeam;
      const isAwaySide = normalizeHistoryTeamName(awayName) === normalizedTeam;
      if (!isHomeSide && !isAwaySide) return null;

      const ourScore = isHomeSide ? score.home : score.away;
      const oppScore = isHomeSide ? score.away : score.home;
      const normalizedDate = normalizeFiveHundredHistoryDate(row.date);
      const result = ourScore > oppScore ? 'win' : ourScore === oppScore ? 'draw' : 'loss';

      return {
        id: `500-form-${normalizedTeam}-${normalizedDate || index}-${index}`,
        dateLabel: normalizedDate ? formatHistoryDateValue(normalizedDate, language) : '--',
        competition: row.competition || (language === 'zh' ? '近期战绩' : 'Recent form'),
        opponentName: isHomeSide ? awayName : homeName,
        venueLabel: isHomeSide ? (language === 'zh' ? '主' : 'H') : (language === 'zh' ? '客' : 'A'),
        ourScore,
        oppScore,
        result
      };
    })
    .filter((row): row is TeamHistoryResult => Boolean(row));

  return mappedRows.length ? summarizeHistoryRows(mappedRows) : null;
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

const parseFreshnessTime = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const getMatchFreshnessTime = (match: Match | null | undefined) => {
  if (!match) return 0;

  return Math.max(
    parseFreshnessTime(match.predictionMeta?.updatedAt),
    parseFreshnessTime(match.predictionMeta?.generatedAt),
    parseFreshnessTime(match.predictionMeta?.lockedAt),
    parseFreshnessTime(match.externalSignals?.updatedAt),
    parseFreshnessTime(match.oddsUpdatedAt),
    parseFreshnessTime(match.handicapOddsUpdatedAt),
    parseFreshnessTime(match.oddsTrend?.lastCapturedAt)
  );
};

const selectFreshestMatch = (
  detailMatch: Match | null,
  contextMatch: Match | undefined,
  seededMatch: Match | undefined
) => {
  if (!detailMatch) return contextMatch || seededMatch;
  if (!contextMatch) return detailMatch;

  const detailFreshness = getMatchFreshnessTime(detailMatch);
  const contextFreshness = getMatchFreshnessTime(contextMatch);
  return contextFreshness > detailFreshness + 1000 ? contextMatch : detailMatch;
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
  const detailRefreshKey = dataSync.sourceUpdatedAt || dataSync.updatedAt || '';

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const version = encodeURIComponent(detailRefreshKey || String(Date.now()));
    const versionedUrl = (url: string) => `${url}${url.includes('?') ? '&' : '?'}v=${version}`;
    const loadDetail = async () => {
      try {
        const accessHeaders = getAccessAuthHeaders();
        const response = await fetch(versionedUrl(buildApiUrl(`/api/matches/${encodeURIComponent(matchId)}`)), {
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
        const response = await fetch(versionedUrl(buildStaticUrl('data/matches-current.json')), {
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
  }, [detailRefreshKey, matchId]);


  // 获取比赛详情
  const match = useMemo(() => {
    const detailMatch = fullMatch?.id === matchId ? fullMatch : null;
    const contextMatch = matches.find((item) => item.id === matchId);
    const seededMatch = getWorldCupSeededFixtures(104).find((item) => item.id === matchId);
    return selectFreshestMatch(detailMatch, contextMatch, seededMatch);
  }, [fullMatch, matchId, matches]);

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
    predictionsTab: { zh: '推荐详情', en: 'Predictions' },
    statsTab: { zh: '数据统计', en: 'Match Stats' },
    formTab: { zh: '近期战绩', en: 'Form & Streaks' },
    h2hTab: { zh: '交锋历史', en: 'Head-to-Head' },
    standingsTab: { zh: '联赛积分榜', en: 'Standings' },
    market: { zh: '推荐市场', en: 'Market' },
    tip: { zh: '推荐选项', en: 'Tip' },
    odds: { zh: '赔率', en: 'Odds' },
    trust: { zh: '推荐强度', en: 'Pick Strength' },
    analysis: { zh: '推荐说明', en: 'Pick Notes' },
    scorePrediction: { zh: '比分热区', en: 'Score Heat Zone' },
    teamValue: { zh: '阵容估值', en: 'Squad Value' },
    kickoff: { zh: '开赛时间', en: 'Kickoff' },
    referenceText: { zh: '预测内容仅供赛前参考，请结合临场信息理性判断。', en: 'Forecasts are for pre-match reference only; use late information and your own judgment.' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };
  const poolRows = getSportteryPoolRows(match, language);
  const { hasHad: hasHadResultPool, hasHhad: hasHhadResultPool } = getOfficialResultPoolAvailability(match);
  const isPredictionResultPoolAvailable = (prediction: PredictionDetail | undefined) => {
    return isPredictionOfficialResultPoolAvailable(match, prediction) || isOutcomeTipCode(prediction?.tipCode);
  };
  const shouldApplyLiveMarketFilter = match.status === 'SCHEDULED';
  const visiblePredictions = getVisiblePredictions(match);
  const hasPredictions = visiblePredictions.length > 0;
  const settledPredictions = visiblePredictions.filter(isScoredPrediction);
  const wonPredictions = settledPredictions.filter((prediction) => prediction.resultStatus === 'WON');
  const bestReviewPrediction = visiblePredictions.find((prediction) => prediction.marketType === 'BEST' && prediction.tipCode !== 'WATCH')
    || getVisiblePrediction(match, '1X2');
  const postMatchReview = match.postMatchReview;
  const postReviewRows = postMatchReview?.predictionReview?.rows || [];
  const primaryPostReviewRow = getPrimaryPostReviewRow(postReviewRows);
  const primaryPostReviewPrediction = predictionFromPostReviewRow(primaryPostReviewRow);
  const hasReviewPredictions = postReviewRows.length > 0;
  const hasPredictionContent = hasPredictions || hasReviewPredictions;
  const isPredictionArchiveOnly = isFinished && !hasPredictionContent;
  const postReviewDiagnosis = postMatchReview?.modelDiagnosis || [];
  const postReviewAdjustments = postMatchReview?.nextAdjustment || [];
  const postReviewDataGaps = postMatchReview?.dataGaps || [];
  const displayRecommendation = getDisplayRecommendation(match, language);
  const companionRecommendation = primaryPostReviewPrediction ? undefined : displayRecommendation?.companion;
  const rawBestOutcomePrediction = visiblePredictions.find((prediction) => (
    prediction.marketType === 'BEST'
    && isPredictionResultPoolAvailable(prediction)
  ));
  const bestOutcomePrediction = rawBestOutcomePrediction && (!shouldApplyLiveMarketFilter || !isHandicapMarketContradicted(match, rawBestOutcomePrediction))
    ? rawBestOutcomePrediction
    : undefined;
  const rawOneXTwoPrediction = visiblePredictions.find((prediction) => (
    prediction.marketType === '1X2'
    && isPredictionResultPoolAvailable(prediction)
  )) || (
    isPredictionResultPoolAvailable(getVisiblePrediction(match, '1X2'))
      ? getVisiblePrediction(match, '1X2')
      : undefined
  );
  const oneXTwoPrediction = rawOneXTwoPrediction && (!shouldApplyLiveMarketFilter || !isHandicapMarketContradicted(match, rawOneXTwoPrediction))
    ? rawOneXTwoPrediction
    : undefined;
  const rawPrimaryOutcomePrediction = bestOutcomePrediction?.oddsPoolCode === 'HHAD'
    ? bestOutcomePrediction
    : isOutcomeTipCode(oneXTwoPrediction?.tipCode)
    ? oneXTwoPrediction
    : bestOutcomePrediction && isOutcomeTipCode(bestOutcomePrediction.tipCode)
      ? bestOutcomePrediction
      : undefined;
  const handicapOverridePrediction = hasHhadResultPool
    ? getHandicapOverridePrediction(match, rawPrimaryOutcomePrediction)
    : undefined;
  const primaryOutcomePrediction = primaryPostReviewPrediction
    || displayRecommendation?.prediction
    || handicapOverridePrediction
    || rawPrimaryOutcomePrediction
    || (!hasHadResultPool && hasHhadResultPool ? getHandicapMarketReferencePrediction(match) : undefined);
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
  const fiveHundredRecentForm = match.externalSignals?.fiveHundred?.recentForm;
  const fiveHundredHomeHistory = buildTeamHistoryFromFiveHundred(
    fiveHundredRecentForm?.home?.rows,
    match.homeTeamName || homeTeam.shortName.zh || homeTeam.shortName[language],
    language
  );
  const fiveHundredAwayHistory = buildTeamHistoryFromFiveHundred(
    fiveHundredRecentForm?.away?.rows,
    match.awayTeamName || awayTeam.shortName.zh || awayTeam.shortName[language],
    language
  );
  const fallbackHomeHistory = buildTeamHistory(matches, homeTeam.id, match, language);
  const fallbackAwayHistory = buildTeamHistory(matches, awayTeam.id, match, language);
  const fallbackHeadToHead = buildHeadToHead(matches, homeTeam.id, awayTeam.id, match, language);
  const homeHistory = trainingHomeHistory?.sampleSize
    ? trainingHomeHistory
    : fiveHundredHomeHistory?.sampleSize
      ? fiveHundredHomeHistory
      : fallbackHomeHistory;
  const awayHistory = trainingAwayHistory?.sampleSize
    ? trainingAwayHistory
    : fiveHundredAwayHistory?.sampleSize
      ? fiveHundredAwayHistory
      : fallbackAwayHistory;
  const headToHead = trainingHeadToHead || fallbackHeadToHead;
  const historyCoverageLabel = getOneYearWindowLabel(match, language);
  const historySource = trainingHomeHistory?.sampleSize || trainingAwayHistory?.sampleSize || trainingHeadToHead?.sampleSize
    ? 'training'
    : fiveHundredHomeHistory?.sampleSize || fiveHundredAwayHistory?.sampleSize
      ? 'five-hundred'
      : 'synced';
  const historyDataSourceLabel = historySource === 'training'
    ? (language === 'zh' ? '长期历史训练库' : 'long-run training history')
    : historySource === 'five-hundred'
      ? (language === 'zh' ? '500 近期战绩' : '500.com recent form')
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
  // Keep raw probability diagnostics available in code, but hidden from the public match page.
  const showInternalDiagnostics = false;
  const probabilityModelIsModelOnly = Boolean(
    probabilityModel?.version?.includes('model-only') ||
    (!match.odds && !match.handicapOdds)
  );
  const reviewProjectedScore = parseScoreLabel(postMatchReview?.scoreReview?.projectedScore);
  const hasProjectedScore = Number.isFinite(match.projectedScoreHome) && Number.isFinite(match.projectedScoreAway);
  const archivedScoreFallbackText = isFinished && postMatchReview
    ? (language === 'zh' ? '赛前比分未存档' : 'Score not archived')
    : '--';
  const projectedScoreLabel = hasProjectedScore
    ? `${match.projectedScoreHome}-${match.projectedScoreAway}`
    : reviewProjectedScore
      ? scoreCandidateLabel(reviewProjectedScore)
    : probabilityModel
      ? `${Math.round(match.stats?.xG.home ?? 1)}-${Math.round(match.stats?.xG.away ?? 1)}`
      : archivedScoreFallbackText;
  const projectedScoreText = hasProjectedScore
    ? projectedScoreLabel
    : reviewProjectedScore
      ? projectedScoreLabel
    : probabilityModel
      ? projectedScoreLabel
      : archivedScoreFallbackText;
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
    { key: 'home', zh: '让胜', en: 'HHAD Home' },
    { key: 'draw', zh: '让平', en: 'HHAD Draw' },
    { key: 'away', zh: '让负', en: 'HHAD Away' }
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

  const recommendationActionLabel = (prediction: PredictionDetail | undefined) => {
    if (!prediction || prediction.tipCode === 'WATCH') return language === 'zh' ? '待开售' : 'Pending';
    return language === 'zh' ? '推荐' : 'Pick';
  };

  const archiveOutcomeTitle = language === 'zh' ? '赛果归档' : 'Result archive';
  const archiveOutcomeReason = language === 'zh'
    ? `本场已完场，最终比分 ${postMatchReview?.finalScore || officialScoreText}。系统没有保存到可用的赛前推荐快照，所以只展示赛果归档，不在赛后补造推荐。`
    : `This match is finished with final score ${postMatchReview?.finalScore || officialScoreText}. No usable pre-match pick snapshot was archived, so only the result archive is shown.`;
  const primaryOutcomeTitle = isPredictionArchiveOnly
    ? archiveOutcomeTitle
    : primaryPostReviewRow?.tipLabel?.[language]
    || displayRecommendation?.label || (primaryOutcomePrediction
    ? getPredictionTipDisplay(primaryOutcomePrediction, language)
    : '--');
  const primaryOutcomeCode = isOutcomeTipCode(primaryOutcomePrediction?.tipCode) ? primaryOutcomePrediction.tipCode : undefined;
  const primaryOutcomeIsHandicap = primaryOutcomePrediction?.oddsPoolCode === 'HHAD';
  const scoreBindingOutcomeCode = primaryOutcomeIsHandicap ? undefined : primaryOutcomeCode;
  const scoreDistributionCandidates: ScoreRecommendationCandidate[] = (probabilityModel?.scoreDistribution || []).map((score) => ({
    home: score.home,
    away: score.away,
    label: scoreCandidateLabel(score),
    probability: Number.isFinite(score.probability) ? score.probability : null,
    source: 'model'
  }));
  const reviewScoreCandidates: ScoreRecommendationCandidate[] = (postMatchReview?.scoreReview?.top3 || [])
    .map((label): ScoreRecommendationCandidate | null => {
      const score = parseScoreLabel(label);
      return score
        ? {
          home: score.home,
          away: score.away,
          label: scoreCandidateLabel(score),
          probability: null,
          source: 'review' as const
        }
        : null;
    })
    .filter((score): score is ScoreRecommendationCandidate => Boolean(score));
  const projectedScoreDistributionMatch = scoreDistributionCandidates.find((score) => (
    score.home === Number(match.projectedScoreHome) && score.away === Number(match.projectedScoreAway)
  ));
  const projectedScoreCandidate: ScoreRecommendationCandidate | null = hasProjectedScore || reviewProjectedScore
    ? {
      home: hasProjectedScore ? Number(match.projectedScoreHome) : Number(reviewProjectedScore?.home),
      away: hasProjectedScore ? Number(match.projectedScoreAway) : Number(reviewProjectedScore?.away),
      label: projectedScoreLabel,
      probability: projectedScoreDistributionMatch?.probability ?? null,
      source: hasProjectedScore ? 'locked' : 'review'
    }
    : null;
  const alignedScoreCandidate = scoreBindingOutcomeCode
    ? scoreDistributionCandidates.find((score) => getScoreOutcomeCode(score) === scoreBindingOutcomeCode)
      || (projectedScoreCandidate && getScoreOutcomeCode(projectedScoreCandidate) === scoreBindingOutcomeCode ? projectedScoreCandidate : null)
      || reviewScoreCandidates.find((score) => getScoreOutcomeCode(score) === scoreBindingOutcomeCode)
    : null;
  const firstScoreCandidate = projectedScoreCandidate
    || alignedScoreCandidate
    || reviewScoreCandidates[0]
    || scoreDistributionCandidates[0]
    || null;
  const firstScoreKey = firstScoreCandidate ? scoreCandidateKey(firstScoreCandidate) : '';
  const secondScoreCandidate = reviewScoreCandidates.find((score) => scoreCandidateKey(score) !== firstScoreKey)
    || scoreDistributionCandidates.find((score) => scoreCandidateKey(score) !== firstScoreKey)
    || (projectedScoreCandidate && scoreCandidateKey(projectedScoreCandidate) !== firstScoreKey ? projectedScoreCandidate : null);
  const scoreRecommendations = dedupeScoreCandidates(
    [firstScoreCandidate, secondScoreCandidate].filter((score): score is ScoreRecommendationCandidate => Boolean(score))
  ).slice(0, 2).map((score, index) => {
    const alignsWithOutcome = scoreBindingOutcomeCode ? getScoreOutcomeCode(score) === scoreBindingOutcomeCode : false;
    return {
      ...score,
      tone: alignsWithOutcome ? 'aligned' : 'alternate',
      tag: alignsWithOutcome
        ? (language === 'zh' ? '同向参考' : 'Aligned reference')
        : score.source === 'review'
          ? (language === 'zh' ? '赛前复盘' : 'Pre-match review')
        : index === 0
          ? (language === 'zh' ? '比分参考' : 'Score reference')
          : (language === 'zh' ? '备选比分' : 'Alt score')
    };
  });
  const lockedTagText = predictionMeta?.lockedAt
    ? (language === 'zh' ? '已锁定' : 'Locked')
    : (language === 'zh' ? '赛前监控' : 'Monitoring');
  const hhadPoolRow = poolRows.find((row) => row.poolCode === 'HHAD');
  const primaryOutcomeKey = primaryOutcomeCode === '1'
    ? 'home'
    : primaryOutcomeCode === 'X'
      ? 'draw'
      : primaryOutcomeCode === '2'
        ? 'away'
        : undefined;
  const handicapProbabilityRows = hhadPoolRow?.probabilities
    ? handicapOutcomeLabels
      .map((item) => ({
        ...item,
        probability: hhadPoolRow.probabilities?.[item.key] ?? null
      }))
      .filter((item): item is typeof handicapOutcomeLabels[number] & { probability: number } => Number.isFinite(item.probability))
      .sort((a, b) => b.probability - a.probability)
    : [];
  const handicapProbabilityLeader = handicapProbabilityRows[0] || null;
  const predictionVersionText = predictionMeta?.strategyVersion
    || predictionMeta?.policyVersion
    || predictionMeta?.promptVersion
    || probabilityModel?.version
    || postMatchReview?.version
    || '--';
  const predictionNavVersionBase = predictionMeta?.policyVersion
    || probabilityModel?.version
    || predictionMeta?.promptVersion
    || postMatchReview?.version;
  const predictionNavVersionText = [
    compactVersionLabel(predictionNavVersionBase, language),
    isPredictionArchiveOnly
      ? (language === 'zh' ? '赛果归档' : 'archive')
      : postMatchReview
      ? (language === 'zh' ? '赛后复盘' : 'review')
      : (predictionMeta?.lockedAt || predictionLockedByCutoff || match.status !== 'SCHEDULED')
        ? (language === 'zh' ? '已锁定' : 'locked')
        : (language === 'zh' ? '监控中' : 'live')
  ].filter(Boolean).join(' · ');
  const navTrustScore = Number(primaryOutcomePrediction?.trustScore ?? primaryPostReviewRow?.trustScore ?? matchSignal.trustScore);
  const navSummaryDetail = isPredictionArchiveOnly
    ? officialScoreText.replace(/\s+/g, '')
    : Number.isFinite(navTrustScore) && navTrustScore > 0
    ? `${Math.round(navTrustScore)}%`
    : postMatchReview?.predictionReview?.bestStatus
      ? getResultLabel(postMatchReview.predictionReview.bestStatus, language)
      : '--';
  const navPickBase = compactPickLabel(primaryOutcomeTitle || displayRecommendation?.label);
  const navPickOddsValue = Number(primaryOutcomePrediction?.odds ?? primaryPostReviewRow?.odds);
  const navPickDetail = isPredictionArchiveOnly
    ? (language === 'zh' ? '无赛前快照 · 只归档赛果' : 'No snapshot · result only')
    : [
    navPickBase || (language === 'zh' ? '暂无主推' : 'No pick'),
    primaryPostReviewRow?.resultStatus ? getResultLabel(primaryPostReviewRow.resultStatus, language) : '',
    Number.isFinite(navPickOddsValue) && navPickOddsValue > 0 ? `SP${formatDecimal(navPickOddsValue)}` : ''
  ].filter(Boolean).join(' · ');
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
  const publicRecommendationCopy = buildPublicRecommendationCopy(match, primaryOutcomePrediction, language, {
    pickLabel: primaryOutcomeTitle,
    fallbackReason: isPredictionArchiveOnly
      ? archiveOutcomeReason
      : primaryPostReviewRow
      ? (language === 'zh'
        ? `本场已按最终赛果 ${postMatchReview?.finalScore || officialScoreText} 自动结算，推荐状态为 ${getResultLabel(primaryPostReviewRow.resultStatus, language)}。`
        : `Settled against final score ${postMatchReview?.finalScore || officialScoreText}; result: ${getResultLabel(primaryPostReviewRow.resultStatus, language)}.`)
      : displayRecommendation?.reason,
    isLocked: predictionIsLocked
  });
  const publicScoreNote = language === 'zh'
    ? '比分只作为赛果范围参考，不改变上面的主推方向。'
    : 'Scores are only a result-range reference and do not change the main pick.';

  // 渲染预测详细行
  const externalSignals = match.externalSignals as (Match['externalSignals'] & {
    weather?: WeatherSignal;
    venue?: { name?: string; city?: string; summary?: string | { zh?: string; en?: string } };
  }) | undefined;
  const weatherSignal = externalSignals?.weather;
  const fiveHundredSignal = externalSignals?.fiveHundred;
  const fiveHundredDisplay = buildFiveHundredDisplay(match, language);
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
  const contextSignals = probabilityModel?.contextSignals || calculationTrace?.contextSignals || null;
  const rankingPressureSignal = contextSignals?.rankingPressure || match.stats?.rankingPressure;
  const attackIntentSignal = contextSignals?.attackIntent || match.stats?.attackIntent;
  const disciplineSignal = contextSignals?.discipline || match.stats?.discipline;
  const dataGapSignal = contextSignals?.dataGaps || match.stats?.dataGaps;
  const preMatchQuality = externalSignals?.preMatch?.quality || dataGapSignal?.preMatchQuality || null;
  const probabilityForOutcomeKey = (
    probabilities: OutcomeProbability | null | undefined,
    key: keyof OutcomeProbability | undefined
  ) => (key && Number.isFinite(probabilities?.[key]) ? Number(probabilities?.[key]) : null);
  const normalizeRiskPercent = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return null;
    return Number(value) <= 1 ? Number(value) * 100 : Number(value);
  };
  const formatSignalScale = (value: number | null | undefined) => {
    const normalized = normalizeRiskPercent(value);
    return normalized === null ? '--' : formatDecimal(normalized);
  };
  const oneXTwoRiskBase = probabilityModel?.oneXTwo?.final
    || calculationTrace?.outcome?.final
    || probabilityModel?.oneXTwo?.market
    || null;
  const drawRiskProbability = probabilityForOutcomeKey(oneXTwoRiskBase, 'draw');
  const redCardRiskPercent = normalizeRiskPercent(disciplineSignal?.redCardRisk?.total);
  const rotationRiskScore = normalizeRiskPercent(rankingPressureSignal?.rotationRisk);
  const missingSignalCount = [
    externalSignals?.lineups,
    externalSignals?.injuries,
    externalSignals?.referee,
    externalSignals?.expectedGoals
  ].filter(Boolean).length;
  const dataGapLabels = ((preMatchQuality?.missing?.length ? preMatchQuality.missing : dataGapSignal?.missing) || [])
    .slice(0, 3)
    .map((item) => item[language] || item.zh || item.en || item.key)
    .filter(Boolean);
  const upsetRiskReasons: string[] = [];
  let upsetRiskScore = 0;
  if (drawRiskProbability !== null && drawRiskProbability >= 28) {
    upsetRiskScore += drawRiskProbability >= 32 ? 18 : 12;
    upsetRiskReasons.push(language === 'zh' ? `平局压力 ${formatProbabilityValue(drawRiskProbability)}` : `draw pressure ${formatProbabilityValue(drawRiskProbability)}`);
  }
  if (!primaryOutcomeIsHandicap && primaryOutcomeKey && handicapProbabilityLeader && handicapProbabilityLeader.key !== primaryOutcomeKey) {
    upsetRiskScore += 18;
    upsetRiskReasons.push(language === 'zh' ? '让球盘与胜平负主线不同向' : 'handicap line does not align with the 1X2 lean');
  }
  if (matchSignal.trustScore && matchSignal.trustScore < 45) {
    upsetRiskScore += 14;
    upsetRiskReasons.push(language === 'zh' ? `推荐强度 ${matchSignal.trustScore}% 偏低` : `pick strength ${matchSignal.trustScore}% is low`);
  }
  if (match.oddsTrend?.direction === 'mixed') {
    upsetRiskScore += 14;
    upsetRiskReasons.push(language === 'zh' ? '赔率走势分歧' : 'mixed odds movement');
  } else if (!match.oddsTrend || match.oddsTrend.sampleSize < 2) {
    upsetRiskScore += 6;
    upsetRiskReasons.push(language === 'zh' ? '赔率快照不足' : 'few odds snapshots');
  }
  if (preMatchQuality?.sourceQuality === 'low' || dataGapSignal?.sourceQuality === 'low' || Number(preMatchQuality?.severeMissingCount ?? dataGapSignal?.severeMissingCount ?? 0) >= 2) {
    upsetRiskScore += 14;
    upsetRiskReasons.push(preMatchQuality?.score !== undefined
      ? (language === 'zh' ? `赛前数据质量 ${preMatchQuality.score}/100` : `pre-match quality ${preMatchQuality.score}/100`)
      : (language === 'zh' ? '关键赛前数据缺口偏多' : 'key pre-match data gaps'));
  }
  if (rotationRiskScore !== null && rotationRiskScore >= 60) {
    upsetRiskScore += 10;
    upsetRiskReasons.push(language === 'zh' ? '排名/出线压力带来轮换风险' : 'table pressure creates rotation risk');
  }
  if (redCardRiskPercent !== null && redCardRiskPercent >= 18) {
    upsetRiskScore += 8;
    upsetRiskReasons.push(language === 'zh' ? `红牌风险 ${formatProbabilityValue(redCardRiskPercent)}` : `red-card risk ${formatProbabilityValue(redCardRiskPercent)}`);
  }
  if (missingSignalCount <= 1) {
    upsetRiskScore += 8;
    upsetRiskReasons.push(language === 'zh' ? '首发/伤停/裁判/攻防质量待补' : 'lineup/injury/referee/attacking-quality signals are thin');
  }
  upsetRiskScore = Math.min(100, upsetRiskScore);
  const upsetRiskTone = upsetRiskScore >= 65
    ? 'danger'
    : upsetRiskScore >= 42
      ? 'warning'
      : upsetRiskScore >= 24
        ? 'neutral'
        : 'success';
  const upsetRiskLabel = upsetRiskScore >= 65
    ? (language === 'zh' ? '高' : 'High')
    : upsetRiskScore >= 42
      ? (language === 'zh' ? '中' : 'Medium')
      : upsetRiskScore >= 24
        ? (language === 'zh' ? '轻微' : 'Mild')
        : (language === 'zh' ? '低' : 'Low');
  const oddsChangeText = match.oddsTrend
    ? [
      Number.isFinite(match.oddsTrend.odds1Change) ? `${language === 'zh' ? '主' : 'H'} ${Number(match.oddsTrend.odds1Change) > 0 ? '+' : ''}${formatDecimal(match.oddsTrend.odds1Change)}` : '',
      Number.isFinite(match.oddsTrend.oddsXChange) ? `${language === 'zh' ? '平' : 'D'} ${Number(match.oddsTrend.oddsXChange) > 0 ? '+' : ''}${formatDecimal(match.oddsTrend.oddsXChange)}` : '',
      Number.isFinite(match.oddsTrend.odds2Change) ? `${language === 'zh' ? '客' : 'A'} ${Number(match.oddsTrend.odds2Change) > 0 ? '+' : ''}${formatDecimal(match.oddsTrend.odds2Change)}` : ''
    ].filter(Boolean).join(' / ')
    : '';
  const lineupSignalReady = Boolean(externalSignals?.lineups);
  const injurySignalReady = Boolean(externalSignals?.injuries);
  const refereeSignalReady = Boolean(externalSignals?.referee);
  const disciplineSignalReady = Boolean(disciplineSignal);
  const lineupRefereeReadyCount = [lineupSignalReady, injurySignalReady, refereeSignalReady, disciplineSignalReady].filter(Boolean).length;
  const injuryCount = Number(externalSignals?.injuries?.home?.length || 0) + Number(externalSignals?.injuries?.away?.length || 0);
  const yellowCardsTotal = disciplineSignal?.expectedYellowCards?.total;
  const refereeText = externalSignals?.referee?.summary?.[language]
    || externalSignals?.referee?.name
    || (language === 'zh' ? '裁判未接入' : 'referee missing');
  const lineupRefereeSummary = [
    localizedSignalText(externalSignals?.lineups?.summary),
    injurySignalReady
      ? (language === 'zh' ? `伤停 ${injuryCount} 条` : `${injuryCount} injury notes`)
      : '',
    refereeText,
    Number.isFinite(yellowCardsTotal)
      ? (language === 'zh' ? `预计黄牌 ${formatDecimal(yellowCardsTotal)}` : `expected yellows ${formatDecimal(yellowCardsTotal)}`)
      : ''
  ].filter(Boolean).slice(0, 3).join('；');
  const xgSignal = externalSignals?.expectedGoals;
  const xgHome = Number.isFinite(xgSignal?.homeXg)
    ? Number(xgSignal?.homeXg)
    : Number.isFinite(match.stats?.xG?.home)
      ? Number(match.stats?.xG?.home)
      : probabilityModel?.lambdaBlend?.independentHomeLambda ?? calculationTrace?.expectedGoals?.values?.finalHome ?? null;
  const xgAway = Number.isFinite(xgSignal?.awayXg)
    ? Number(xgSignal?.awayXg)
    : Number.isFinite(match.stats?.xG?.away)
      ? Number(match.stats?.xG?.away)
      : probabilityModel?.lambdaBlend?.independentAwayLambda ?? calculationTrace?.expectedGoals?.values?.finalAway ?? null;
  const xgaHome = Number.isFinite(xgSignal?.homeXga) ? Number(xgSignal?.homeXga) : null;
  const xgaAway = Number.isFinite(xgSignal?.awayXga) ? Number(xgSignal?.awayXga) : null;
  const xgHasValue = Number.isFinite(xgHome) && Number.isFinite(xgAway);
  const xgBody = xgSignal?.summary?.[language]
    || (xgHasValue
      ? (xgaHome !== null && xgaAway !== null
        ? (language === 'zh'
          ? `进球质量 ${formatDecimal(xgHome)}:${formatDecimal(xgAway)}，防守压力 ${formatDecimal(xgaHome)}:${formatDecimal(xgaAway)}，用于校验比分和进球区间。`
          : `Goal quality ${formatDecimal(xgHome)}:${formatDecimal(xgAway)}, defensive pressure ${formatDecimal(xgaHome)}:${formatDecimal(xgaAway)}; used to validate score and goals range.`)
        : (language === 'zh'
          ? `当前使用赛前进球估计 ${formatDecimal(xgHome)}:${formatDecimal(xgAway)}，真实外部进球质量数据缺失时只做弱校验。`
          : `Using pre-match goal estimates ${formatDecimal(xgHome)}:${formatDecimal(xgAway)}; without verified goal-quality data it stays a weak validation.`))
      : (language === 'zh'
        ? '暂无可验证进球质量数据，比分和进球判断只按近期攻防处理。'
        : 'No verified goal-quality data yet; score and goals rely on recent attacking and defensive form.'));
  const motivationBody = rankingPressureSignal || attackIntentSignal
    ? [
      rankingPressureSignal
        ? (language === 'zh'
          ? `排名压力 ${formatSignalScale(rankingPressureSignal.maxPressure)}，轮换风险 ${formatSignalScale(rankingPressureSignal.rotationRisk)}`
          : `table pressure ${formatSignalScale(rankingPressureSignal.maxPressure)}, rotation risk ${formatSignalScale(rankingPressureSignal.rotationRisk)}`)
        : '',
      attackIntentSignal
        ? (language === 'zh'
          ? `进攻欲望 ${formatSignalScale(attackIntentSignal.total)}，主客差 ${formatSignalScale(attackIntentSignal.edge)}`
          : `attack intent ${formatSignalScale(attackIntentSignal.total)}, edge ${formatSignalScale(attackIntentSignal.edge)}`)
        : ''
    ].filter(Boolean).join('；')
    : (language === 'zh'
      ? '暂无排名/出线压力与进攻欲望量化字段，暂不把战意写进推荐强度。'
      : 'No quantified table pressure or attack-intent field yet, so motivation is not weighted.');
  const preMatchRiskCards = [
    {
      title: language === 'zh' ? '冷门触发' : 'Upset trigger',
      value: `${upsetRiskLabel} ${upsetRiskScore}`,
      tone: upsetRiskTone,
      body: upsetRiskReasons.length
        ? (language === 'zh'
          ? `当前触发：${upsetRiskReasons.slice(0, 4).join('、')}。分数越高，越应该降级为参考或优先看让球/防冷。`
          : `Triggered: ${upsetRiskReasons.slice(0, 4).join(', ')}. Higher score means reference-only or handicap/upset protection is preferred.`)
        : (language === 'zh' ? '暂未触发明显冷门条件，仍需跟踪临场赔率。' : 'No strong upset trigger yet; still monitor late odds.'),
      tags: upsetRiskReasons.slice(0, 3)
    },
    {
      title: language === 'zh' ? '盘口变化' : 'Market movement',
      value: match.oddsTrend ? `${match.oddsTrend.sampleSize}次快照` : (language === 'zh' ? '待观察' : 'Pending'),
      tone: match.oddsTrend?.direction === 'mixed' ? 'warning' : match.oddsTrend ? 'success' : 'neutral',
      body: match.oddsTrend
        ? `${match.oddsTrend.summary[language]}${oddsChangeText ? `（${oddsChangeText}）` : ''}`
        : (language === 'zh'
          ? '暂无足够官方赔率快照，当前只看最新开售盘，不把变盘写成强信号。'
          : 'Not enough official odds snapshots; use latest market only and avoid strong movement claims.'),
      tags: match.oddsTrend ? [language === 'zh' ? '赔率快照' : 'odds snapshots', match.oddsTrend.direction] : [language === 'zh' ? '待补' : 'missing']
    },
    {
      title: language === 'zh' ? '阵容/裁判/牌数' : 'Lineups/referee/cards',
      value: language === 'zh' ? `${lineupRefereeReadyCount}/4项` : `${lineupRefereeReadyCount}/4`,
      tone: lineupRefereeReadyCount >= 3 ? 'success' : lineupRefereeReadyCount >= 1 ? 'warning' : 'neutral',
      body: lineupRefereeSummary || (language === 'zh'
        ? '首发、伤停、裁判与球队牌数未完全接入，只保留风险提醒，不直接改写胜平负。'
        : 'Lineups, injuries, referee, and card history are not fully connected, so they remain risk tags rather than rewriting 1X2.'),
      tags: [
        lineupSignalReady ? (language === 'zh' ? '首发' : 'lineup') : '',
        injurySignalReady ? (language === 'zh' ? '伤停' : 'injuries') : '',
        refereeSignalReady ? (language === 'zh' ? '裁判' : 'referee') : '',
        disciplineSignalReady ? (language === 'zh' ? '牌数' : 'cards') : ''
      ].filter(Boolean)
    },
    {
      title: language === 'zh' ? '进球质量' : 'Goal quality',
      value: xgHasValue ? `${formatDecimal(xgHome)} : ${formatDecimal(xgAway)}` : '--',
      tone: xgSignal ? 'success' : xgHasValue ? 'warning' : 'neutral',
      body: xgBody,
      tags: [
        xgSignal ? (language === 'zh' ? '外部数据' : 'external data') : (language === 'zh' ? '赛前估计' : 'pre-match estimate'),
        probabilityModel?.lambdaBlend ? (language === 'zh' ? '进球区间' : 'goal range') : ''
      ].filter(Boolean)
    },
    {
      title: language === 'zh' ? '排名与进攻欲望' : 'Table and intent',
      value: rankingPressureSignal || attackIntentSignal
        ? `${formatSignalScale(rankingPressureSignal?.maxPressure)} / ${formatSignalScale(attackIntentSignal?.total)}`
        : '--',
      tone: rankingPressureSignal || attackIntentSignal ? 'success' : 'neutral',
      body: motivationBody,
      tags: [
        rankingPressureSignal ? (language === 'zh' ? '排名压力' : 'table') : '',
        attackIntentSignal ? (language === 'zh' ? '进攻欲望' : 'intent') : '',
        rotationRiskScore !== null && rotationRiskScore >= 60 ? (language === 'zh' ? '轮换风险' : 'rotation') : ''
      ].filter(Boolean)
    },
    {
      title: language === 'zh' ? '数据缺口' : 'Data gaps',
      value: preMatchQuality?.score !== undefined
        ? `${preMatchQuality.score}/100`
        : dataGapSignal?.coverageScore !== undefined
          ? `${dataGapSignal.coverageScore}`
          : '--',
      tone: (preMatchQuality?.sourceQuality || dataGapSignal?.sourceQuality) === 'low' ? 'danger' : (preMatchQuality || dataGapSignal) ? 'warning' : 'neutral',
      body: dataGapLabels.length
        ? (language === 'zh'
          ? `质量${preMatchQuality?.sourceQuality || dataGapSignal?.sourceQuality || '--'}；主要缺口：${dataGapLabels.join('、')}。缺口越多，推荐越容易降级为参考。`
          : `Quality ${preMatchQuality?.sourceQuality || dataGapSignal?.sourceQuality || '--'}; main gaps: ${dataGapLabels.join(', ')}. More gaps make downgrade more likely.`)
        : (preMatchQuality?.summary?.[language] || (language === 'zh' ? '暂无明确高权重缺口。' : 'No high-weight gap detected.')),
      tags: dataGapLabels.slice(0, 3)
    }
  ];
  const predictionNavItems: Array<{ key: PredictionView; label: string; detail: string }> = [
    {
      key: 'summary',
      label: language === 'zh' ? '概览' : 'Summary',
      detail: navSummaryDetail
    },
    {
      key: 'tips',
      label: language === 'zh' ? '推荐' : 'Tips',
      detail: navPickDetail
    },
    {
      key: 'model',
      label: language === 'zh' ? '版本' : 'Version',
      detail: predictionNavVersionText
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
      title: language === 'zh' ? '官方赔率 / 让球' : 'Official odds / handicap',
      value: poolRows.filter((row) => row.odds).length ? `${poolRows.filter((row) => row.odds).length}/${poolRows.length}` : '--',
      tone: poolRows.some((row) => row.odds) ? 'success' : 'warning',
      body: language === 'zh'
        ? '胜平负与让球赔率用于确认方向是否合理，不单独决定推荐。'
        : '1X2 and handicap odds are used to check whether the pick is reasonable; they do not decide the pick alone.'
    },
    {
      title: language === 'zh' ? '长期强弱' : 'Long-run strength',
      value: probabilityModel?.elo ? `${probabilityModel.elo.homeRating}/${probabilityModel.elo.awayRating}` : '--',
      tone: probabilityModel?.elo ? 'success' : 'neutral',
      body: language === 'zh'
        ? `已参考长期比赛样本 ${probabilityModel?.elo?.historicalSource?.rows || probabilityModel?.form?.historicalSource?.rows || '--'} 行，主要看两队稳定强弱和状态基础。`
        : `Uses ${probabilityModel?.elo?.historicalSource?.rows || probabilityModel?.form?.historicalSource?.rows || '--'} long-run match samples for stable team strength and form.`
    },
    ...(worldCupPrior ? [{
      title: language === 'zh' ? '世界杯背景' : 'World Cup context',
      value: Number.isFinite(worldCupPriorWeight) ? formatModelWeight(worldCupPriorWeight) : (language === 'zh' ? '已接入' : 'Loaded'),
      tone: 'success',
      body: language === 'zh'
        ? `已匹配 ${worldCupPriorHomeName || '主队'} vs ${worldCupPriorAwayName || '客队'} 的世界杯背景，只作为赛前补充，不覆盖近期表现和赔率判断。`
        : `World Cup context is matched for ${worldCupPriorHomeName || 'home'} vs ${worldCupPriorAwayName || 'away'} and used only as a pre-match supplement.`
    }] : []),
    {
      title: language === 'zh' ? '近况攻防' : 'Recent form',
      value: probabilityModel?.form ? `${formatDecimal(probabilityModel.form.home.goalsForAvg)} / ${formatDecimal(probabilityModel.form.away.goalsForAvg)}` : '--',
      tone: probabilityModel?.form ? 'success' : 'neutral',
      body: language === 'zh'
        ? '近一年攻防表现用于修正进球倾向，帮助判断比分区间是否支持当前推荐。'
        : 'Last-year attacking and defensive form adjusts the goal range and checks whether the score profile supports the pick.'
    },
    {
      title: language === 'zh' ? '阵容信息' : 'Lineups',
      value: externalSignals?.lineups ? (language === 'zh' ? '已接入' : 'Loaded') : '--',
      tone: externalSignals?.lineups ? 'success' : 'neutral',
      body: externalSignals?.lineups?.summary?.[language]
        || (language === 'zh' ? '未拿到可验证首发/伤停时，只作为待补信息，不强行改推荐。' : 'Without verified lineups or injuries, this stays as missing data and does not force a pick change.')
    },
    {
      title: language === 'zh' ? '500网数据' : '500.com data',
      value: fiveHundredDisplay.visible ? fiveHundredDisplay.summaryLabel : '--',
      tone: fiveHundredDisplay.visible ? fiveHundredDisplay.tone : 'neutral',
      body: fiveHundredDisplay.summaryBody
        || (language === 'zh' ? '500网赔率、亚洲盘、近况和阵容用于赛前校验，不单独生成推荐。' : '500.com odds, Asian lines, form, and projected XI validate the pre-match read; they do not create picks alone.')
    },
    {
      title: language === 'zh' ? '外部均赔' : 'External odds',
      value: fiveHundredSignal?.europeOdds?.companies ? `${fiveHundredSignal.europeOdds.companies}` : '--',
      tone: fiveHundredSignal?.europeOdds?.companies ? 'success' : 'neutral',
      body: fiveHundredSignal?.europeOdds?.summary
        || externalSignals?.externalOdds?.summary?.[language]
        || (language === 'zh' ? '外部均赔用于交叉验证官方赔率是否异常，不单独生成推荐。' : 'External average odds cross-check official odds; they do not create picks alone.')
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
                  <strong>{language === 'zh' ? '官方赔率走势' : 'Official Odds Trend'}</strong>
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
                  title={`${item.label} ${item.detail}`}
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
                  <span>{isPredictionArchiveOnly
                    ? (language === 'zh' ? '赛果归档' : 'Result Archive')
                    : primaryOutcomeIsHandicap
                    ? (language === 'zh' ? '让球推荐' : 'Handicap Pick')
                    : (language === 'zh' ? '胜平负推荐' : '1X2 Recommendation')}</span>
                  <b>{isPredictionArchiveOnly ? (language === 'zh' ? '归档' : 'Archive') : recommendationActionLabel(primaryOutcomePrediction)}</b>
                </div>
                <strong className="recommendation-overview-main">{primaryOutcomeTitle}</strong>
                <p>{isPredictionArchiveOnly ? archiveOutcomeReason : publicRecommendationCopy.reasons[0] || matchSignal.note[language]}</p>
                <div className="recommendation-mini-tags">
                  {isPredictionArchiveOnly ? (
                    <>
                      <span>{language === 'zh' ? '赛果归档' : 'Result archive'}</span>
                      <span>{language === 'zh' ? '无赛前快照' : 'No pre-match snapshot'}</span>
                      <span>{officialScoreText}</span>
                    </>
                  ) : (
                    <>
                      <span>{publicRecommendationCopy.marketLabel}</span>
                      <span>{publicRecommendationCopy.strengthLabel}</span>
                      <span>{publicRecommendationCopy.oddsLabel}</span>
                      <span>{publicRecommendationCopy.statusLabel}</span>
                    </>
                  )}
                </div>
                {companionRecommendation && (
                  <div className="recommendation-companion-panel">
                    <span>{companionRecommendation.title}</span>
                    <strong>{companionRecommendation.label}</strong>
                    <p>{companionRecommendation.reason}</p>
                    <em>{companionRecommendation.meta}</em>
                  </div>
                )}
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
                      <em>{score.tag}</em>
                    </div>
                  )) : (
                    <div className="recommendation-score-option is-empty">
                      <span>{language === 'zh' ? '比分' : 'Score'}</span>
                      <strong>{projectedScoreText}</strong>
                      <em>{postMatchReview
                        ? (language === 'zh' ? '比分快照缺失' : 'Score snapshot missing')
                        : (language === 'zh' ? '等待模型分布' : 'Waiting for distribution')}</em>
                    </div>
                  )}
                </div>
                {actualScoreText && (
                  <p className="recommendation-score-final">
                    {actualScoreText} · {language === 'zh' ? '预测不回写' : 'not rewritten'}
                  </p>
                )}
                <p>{publicScoreNote}</p>
                <div className="recommendation-mini-tags">
                  <span>{language === 'zh' ? '比分参考' : 'Score reference'}</span>
                  <span>{language === 'zh' ? '不改主推' : 'Pick unchanged'}</span>
                </div>
              </section>
            </div>

            {isPredictionArchiveOnly && (
              <div className="card prediction-empty-card">
                <h3>{language === 'zh' ? '本场仅保留赛果归档' : 'Result archive only'}</h3>
                <p>{archiveOutcomeReason}</p>
                <div className="recommendation-mini-tags">
                  <span>{language === 'zh' ? '最终比分' : 'Final score'} {officialScoreText}</span>
                  <span>{language === 'zh' ? '无赛前推荐快照' : 'No pre-match snapshot'}</span>
                  <span>{language === 'zh' ? '不赛后补推' : 'No post-match backfill'}</span>
                </div>
              </div>
            )}

            <div className="card decision-transparent-card">
              <div className="decision-transparent-head">
                <div>
                  <span className="review-kicker">{language === 'zh' ? '推荐说明' : 'Pick Notes'}</span>
                  <h3>{publicRecommendationCopy.title}</h3>
                  {publicRecommendationCopy.reasons.map((reason) => (
                    <p key={reason}>{reason}</p>
                  ))}
                  {companionRecommendation && (
                    <p>{companionRecommendation.reason}</p>
                  )}
                </div>
                <span className={`decision-pool-pill is-${publicRecommendationCopy.strengthTone}`}>
                  {publicRecommendationCopy.strengthLabel}
                </span>
              </div>

              <div className="decision-transparent-grid">
                <section className="decision-transparent-panel">
                  <h4>{language === 'zh' ? '推荐玩法' : 'Market'}</h4>
                  <strong>{publicRecommendationCopy.marketLabel}</strong>
                  <p>{publicRecommendationCopy.oddsLabel}</p>
                </section>

                <section className="decision-transparent-panel">
                  <h4>{language === 'zh' ? '风险提醒' : 'Risk Notes'}</h4>
                  <strong>{publicRecommendationCopy.risks.join(language === 'zh' ? '、' : ', ')}</strong>
                  <p>{publicRecommendationCopy.updateRule}</p>
                </section>

                {companionRecommendation && (
                  <section className="decision-transparent-panel is-companion">
                    <h4>{language === 'zh' ? '让球补充' : 'HHAD Add-on'}</h4>
                    <strong>{companionRecommendation.title}</strong>
                    <p>{companionRecommendation.meta}</p>
                  </section>
                )}
              </div>

              <div className="decision-risk-row">
                <span>{language === 'zh' ? '更新规则' : 'Update rule'}</span>
                <div>
                  <b>{publicRecommendationCopy.updateRule}</b>
                </div>
              </div>
            </div>

            {fiveHundredDisplay.visible && (
              <div className={`card five-hundred-signal-card is-${fiveHundredDisplay.tone}`}>
                <div className="five-hundred-signal-head">
                  <div>
                    <span className="review-kicker">
                      {language === 'zh' ? '500网赛前数据' : '500.com pre-match data'}
                    </span>
                    <h3>{fiveHundredDisplay.summaryLabel}</h3>
                    <p>
                      {language === 'zh'
                        ? '先把500网能拿到的盘口、欧赔、近期战绩、排名和预计名单放到页面上；这些信号参与校验和降级，不直接覆盖主推方向。'
                        : '500.com market, odds, form, ranking, and projected XI are surfaced here first. They validate and downgrade confidence without overriding the main pick alone.'}
                    </p>
                  </div>
                  <span className={`five-hundred-source-badge is-${fiveHundredDisplay.tone}`}>
                    {fiveHundredDisplay.badge}
                  </span>
                </div>

                <div className="five-hundred-signal-grid">
                  {fiveHundredDisplay.panels.map((panel) => (
                    <section key={panel.key} className={`five-hundred-signal-panel is-${panel.tone}`}>
                      <span>{panel.title}</span>
                      <strong>{panel.value}</strong>
                      <p>{panel.body}</p>
                      {panel.tags.length > 0 && (
                        <div className="five-hundred-chip-row">
                          {panel.tags.map((tag) => (
                            <b key={`${panel.key}-${tag}`}>{tag}</b>
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </div>

                {fiveHundredDisplay.chips.length > 0 && (
                  <div className="five-hundred-chip-row is-summary">
                    {fiveHundredDisplay.chips.slice(0, 8).map((chip) => (
                      <b key={chip}>{chip}</b>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className={`card pre-match-risk-card is-${upsetRiskTone}`}>
              <div className="pre-match-risk-head">
                <div>
                  <span className="review-kicker">
                    {language === 'zh' ? '赛前诊断' : 'Pre-match diagnosis'}
                  </span>
                  <h3>{language === 'zh' ? '推荐前先看这几个风险点' : 'Risk checks before trusting the pick'}</h3>
                  <p>
                    {language === 'zh'
                      ? '这里把赔率、阵容裁判、牌数、排名战意和攻防质量拆开看；缺数据不会硬猜，只进入降级和风险提示。'
                      : 'This checks odds, lineups, referee, cards, table pressure, and attacking quality. Missing data is not guessed; it only downgrades confidence.'}
                  </p>
                </div>
                <span className={`pre-match-risk-score is-${upsetRiskTone}`}>
                  {language === 'zh' ? '冷门指数' : 'Upset'} {upsetRiskScore}
                </span>
              </div>

              <div className="pre-match-risk-grid">
                {preMatchRiskCards.map((item) => (
                  <section key={item.title} className={`pre-match-risk-panel is-${item.tone}`}>
                    <span>{item.title}</span>
                    <strong>{item.value}</strong>
                    <p>{item.body}</p>
                    {item.tags.length > 0 && (
                      <div className="pre-match-risk-tags">
                        {item.tags.map((tag) => (
                          <b key={tag}>{tag}</b>
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </div>
            {isFinished && hasPredictionContent && (
              <div className="card review-card">
                <div className="review-head">
                  <div>
                    <span className="review-kicker">{language === 'zh' ? '赛后复盘' : 'Post-match Review'}</span>
                    <h3>{language === 'zh' ? '推荐结果回看与原因复盘' : 'Pick Review And Reason Check'}</h3>
                    <p>
                      {language === 'zh'
                        ? `基于赛前官方赔率快照生成的推荐已按最终比分 ${postMatchReview?.finalScore || officialScoreText} 自动结算，并进入后续优化。`
                        : `Tips generated from pre-match official odds snapshots have been settled against ${postMatchReview?.finalScore || officialScoreText} and fed into later tuning.`}
                    </p>
                  </div>
                  <div className="review-score">
                    <span>{language === 'zh' ? '本场命中率' : 'Hit rate'}</span>
                    <strong>{postMatchReview?.predictionReview.hitRate ?? reviewHitRate ?? '--'}{(postMatchReview?.predictionReview.hitRate ?? reviewHitRate) !== null ? '%' : ''}</strong>
                  </div>
                </div>
                <div className="review-grid">
                  <div>
                    <span>{language === 'zh' ? '已结算推荐' : 'Settled tips'}</span>
                    <strong>{postMatchReview?.predictionReview ? `${postMatchReview.predictionReview.won ?? 0}/${postMatchReview.predictionReview.settled ?? 0}` : `${wonPredictions.length}/${settledPredictions.length}`}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '主推结果' : 'Main pick'}</span>
                    <strong>{postMatchReview?.predictionReview?.bestStatus ? getResultLabel(postMatchReview.predictionReview.bestStatus, language) : bestReviewPrediction ? getResultLabel(bestReviewPrediction.resultStatus, language) : '--'}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '让球复盘' : 'Handicap review'}</span>
                    <strong>
                      {postMatchReview?.predictionReview.missedHandicapLane
                        ? (language === 'zh' ? '错过盘口方向' : 'Missed lane')
                        : postMatchReview?.predictionReview.handicapHit
                          ? (language === 'zh' ? '让球命中' : 'HHAD hit')
                          : '--'}
                    </strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '实际赛果' : 'Actual result'}</span>
                    <strong>{postMatchReview?.actual.had.label[language] || officialScoreText}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '让球结果' : 'Handicap result'}</span>
                    <strong>{postMatchReview?.actual.hhad?.label[language] || '--'}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '比分复盘' : 'Score review'}</span>
                    <strong>{postMatchReview?.scoreReview.exactTop3 ? (language === 'zh' ? 'Top3覆盖' : 'Top3 covered') : postMatchReview?.scoreReview.projectedScore || '--'}</strong>
                  </div>
                </div>
                {postMatchReview && (
                  <div className="post-review-detail-grid">
                    <section className="post-review-panel">
                      <h4>{language === 'zh' ? '市场结算' : 'Market settlement'}</h4>
                      <div className="post-review-row-list">
                        {postReviewRows.slice(0, 4).map((row) => (
                          <div key={`${row.marketType}-${row.tipCode}-${row.oddsPoolCode || 'pool'}`} className={`post-review-row is-${row.resultStatus.toLowerCase()}`}>
                            <span>{getPredictionMarketLabel(row as PredictionDetail, language)}</span>
                            <strong>{row.tipLabel[language]}</strong>
                            <em>{getResultLabel(row.resultStatus, language)} · {row.actualLabel?.[language] || row.actualCode || '--'}</em>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section className="post-review-panel">
                      <h4>{language === 'zh' ? '原因复盘' : 'Reason check'}</h4>
                      <div className="post-review-chip-list">
                        {postReviewDiagnosis.slice(0, 4).map((item) => (
                          <span key={item.code}>{item[language]}</span>
                        ))}
                      </div>
                    </section>
                    <section className="post-review-panel">
                      <h4>{language === 'zh' ? '下次调整' : 'Next adjustment'}</h4>
                      <div className="post-review-chip-list">
                        {postReviewAdjustments.slice(0, 4).map((item) => (
                          <span key={item.code}>{item[language]}</span>
                        ))}
                      </div>
                    </section>
                    <section className="post-review-panel">
                      <h4>{language === 'zh' ? '事件数据' : 'Event data'}</h4>
                      <p>{postMatchReview.eventFactors?.goals?.summary?.[language] || '--'}</p>
                      <div className="post-review-chip-list is-muted">
                        {postReviewDataGaps.slice(0, 4).map((item) => (
                          <span key={item.key}>{item[language]}</span>
                        ))}
                      </div>
                    </section>
                  </div>
                )}
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
                <span>{language === 'zh' ? '推荐强度' : 'Pick strength'} <strong>{navSummaryDetail}</strong></span>
                <span>{language === 'zh' ? '风险项' : 'Risks'} <strong>{matchSignal.riskCount}</strong></span>
                {match.oddsTrend && (
                  <span>{language === 'zh' ? '赔率快照' : 'Odds snapshots'} <strong>{match.oddsTrend.sampleSize}</strong></span>
                )}
              </div>
              {match.oddsTrend && (
                <p className="signal-summary-trend">{match.oddsTrend.summary[language]}</p>
              )}
            </div>

            <div className="prediction-policy-note">
              <div>
                <strong>{predictionIsLocked
                  ? (language === 'zh' ? '推荐状态：已锁定' : 'Pick status: locked')
                  : (language === 'zh' ? '推荐状态：赛前监控中' : 'Pick status: monitoring')}</strong>
                <span>
                  {language === 'zh'
                    ? `当前版本：${predictionVersionText} / 生成时间：${formatPolicyTimestamp(predictionGeneratedAt, language)} / 竞彩截止：${formatPolicyTimestamp(predictionCutoffRaw, language)}`
                    : `Version: ${predictionVersionText} / Generated: ${formatPolicyTimestamp(predictionGeneratedAt, language)} / Cutoff: ${formatPolicyTimestamp(predictionCutoffRaw, language)}`}
                </span>
              </div>
              <p>
                {predictionMeta?.dataPolicy?.[language] || (language === 'zh'
                  ? '竞彩截止前允许临场赔率校验；截止后本场推荐方向不再修改，只更新赛果与命中状态。'
                  : 'Before cutoff, late odds changes may be checked; after cutoff, the pick direction is not modified, only result settlement is updated.')}
                {predictionMeta?.updateReason && (
                  <em>{predictionMeta.updateReason[language]}</em>
                )}
              </p>
            </div>

            {showInternalDiagnostics && gptParsed && (
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

            {showInternalDiagnostics && probabilityModel && (
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
                    {probabilityModel.scoreCalibration?.sample && (
                      <div className="probability-pair-grid" style={{ marginTop: '0.75rem' }}>
                        <span>
                          {language === 'zh' ? '比分样本' : 'Score sample'}
                          <strong>{probabilityModel.scoreCalibration.sample.rows || 0}</strong>
                          <em>{probabilityModel.scoreCalibration.sample.sampleDays || '--'} {language === 'zh' ? '天' : 'days'}</em>
                        </span>
                        <span>
                          {language === 'zh' ? '主比分命中' : 'Primary exact'}
                          <strong>{formatHealthRate(probabilityModel.scoreCalibration.sample.exactHitRate)}</strong>
                          <em>Top3 {formatHealthRate(probabilityModel.scoreCalibration.sample.top3ExactHitRate)}</em>
                        </span>
                        <span>
                          {language === 'zh' ? 'Top3赛果覆盖' : 'Top3 outcome'}
                          <strong>{formatHealthRate(probabilityModel.scoreCalibration.sample.top3OutcomeHitRate)}</strong>
                          <em>{language === 'zh' ? '胜平负反馈' : '1X2 feedback'}</em>
                        </span>
                        <span>
                          {language === 'zh' ? 'Top3进球档' : 'Top3 band'}
                          <strong>{formatHealthRate(probabilityModel.scoreCalibration.sample.top3TotalBandHitRate)}</strong>
                          <em>{language === 'zh' ? `λ ${formatDecimal(probabilityModel.scoreCalibration.adjustments?.totalLambdaAdjustment)}` : `lambda ${formatDecimal(probabilityModel.scoreCalibration.adjustments?.totalLambdaAdjustment)}`}</em>
                        </span>
                      </div>
                    )}
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
                        {(probabilityModel.modelHealth.byMarket?.['1X2']?.cooldown || probabilityModel.modelHealth.byMarket?.GOALS?.cooldown) && (
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
                            <strong>{formatModelWeight(probabilityModel.calibrationAdjustment.goals?.shrinkFactor)}</strong>
                            <em>{probabilityModel.calibrationAdjustment.goals?.before?.over25 ?? '--'}% {'to'} {probabilityModel.calibrationAdjustment.goals?.after?.over25 ?? '--'}%</em>
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
                  <h3>{language === 'zh' ? '这场推荐主要看什么' : 'What this pick is based on'}</h3>
                  <p>
                    {language === 'zh'
                      ? '推荐不是单点判断，会综合长期强弱、近况、进球区间、世界杯背景和可验证赛前信息，再用官方赔率与外部均赔做交叉确认。'
                      : 'The pick is not based on a single signal: it combines long-run strength, form, goal range, World Cup context, and verified pre-match information, then checks official and external odds.'}
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
                      ? '综合长期强弱、近一年攻防、赛程密度、比分区间、世界杯背景与赛前信息生成判断；官方赔率、让球和走势只做校验与风险标记。'
                      : 'Combines long-run strength, last-year form, schedule density, score range, World Cup context, and pre-match signals; official odds, handicap, and movement are validation and risk markers only.'}
                  </p>
                </div>
                <span>{predictionMeta?.promptVersion || 'professional-football-analyst-v1'}</span>
              </div>
              <div className="prompt-upgrade-strip">
                <strong>{language === 'zh' ? '数据覆盖' : 'Data coverage'}</strong>
                <span>
                  {language === 'zh'
                    ? '官方胜平负/让球赔率、赔率快照走势、赛果归档、长期强弱、近一年攻防样本、赛程密度与进球区间。'
                    : 'Official 1X2/handicap odds, odds movement, result archive, long-run strength, last-year form, schedule density, and goal range.'}
                </span>
                <span>
                  {language === 'zh'
                    ? '伤停、首发、天气、裁判、攻防质量与外部赔率进入赛前信息层，随可验证信号辅助修正风险判断。'
                    : 'Injuries, lineups, weather, referees, attacking quality, and external odds feed the pre-match signal layer when verified.'}
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
                      ? (weatherSummary || (language === 'zh' ? '已读取天气信号，当前仅作为赛前风险修正。' : 'Weather signal is loaded and used as a pre-match risk modifier.'))
                      : (language === 'zh'
                        ? '当前赛程没有可验证的实时天气/场地字段，所以不会因为天气改动推荐方向。页面保留这个模块，是为了明确哪些因素暂未进入判断。'
                        : 'No verified live weather or pitch field is available for this fixture, so the pick is not changed by weather. This module makes missing factors explicit.')}
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
                        ? '天气只进入风险层：恶劣天气会压低进球信心、提高让球不确定性；不会单独推翻主推方向。'
                        : 'Weather only enters the risk layer: severe weather lowers goal confidence and increases handicap uncertainty, but does not override the main pick.')
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

            {hasPredictionContent && (
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
                    ? `根据近期攻防质量和比分分布推演，当前比分参考区间约 ${match.stats?.xG.home?.toFixed(2) ?? '--'} : ${match.stats?.xG.away?.toFixed(2) ?? '--'}。`
                    : `Derived from recent attacking quality and score distribution. Current score range is about ${match.stats?.xG.home?.toFixed(2) ?? '--'} : ${match.stats?.xG.away?.toFixed(2) ?? '--'}.`}
                </p>
                <p style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', marginTop: '0.5rem' }}>
                  {t('referenceText')}
                </p>
              </div>
            )}

          </div>
        )}

        {/* Tab 2: 统计数据 */}
        {activeTab === 'stats' && (
          match.stats ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '700', fontFamily: 'var(--font-title)' }}>
              {language === 'zh' ? '球队数据参考' : 'Team Data Reference'}
            </h3>
            
            {/* 进度条统计 */}
            {[
              { label: '进球质量参考', home: match.stats.xG.home, away: match.stats.xG.away, unit: '' },
              { label: '控球率 (Possession)', home: match.stats.possession.home, away: match.stats.possession.away, unit: '%' },
              { label: '射门数 (Shots)', home: match.stats.shots.home, away: match.stats.shots.away, unit: '' },
              { label: '射正数 (Shots on Target)', home: match.stats.shotsOnTarget.home, away: match.stats.shotsOnTarget.away, unit: '' },
              { label: '角球 (Corners)', home: match.stats.corners.home, away: match.stats.corners.away, unit: '' },
              { label: '犯规 (Fouls)', home: match.stats.fouls.home, away: match.stats.fouls.away, unit: '' },
              { label: '黄牌 (Yellow Cards)', home: match.stats.yellowCards.home, away: match.stats.yellowCards.away, unit: '' },
              {
                label: '红牌风险 (Red Card Risk)',
                home: Number((((match.stats.discipline?.redCardRisk?.home ?? match.stats.redCards.home) || 0) * 100).toFixed(1)),
                away: Number((((match.stats.discipline?.redCardRisk?.away ?? match.stats.redCards.away) || 0) * 100).toFixed(1)),
                unit: '%'
              },
              {
                label: '进攻欲望 (Attack Intent)',
                home: match.stats.attackIntent?.home ?? 50,
                away: match.stats.attackIntent?.away ?? 50,
                unit: ''
              },
              {
                label: '排名战意压力 (Ranking Pressure)',
                home: match.stats.rankingPressure?.home ?? 50,
                away: match.stats.rankingPressure?.away ?? 50,
                unit: ''
              },
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
            {match.stats.dataGaps && (
              <div style={{
                padding: '0.85rem',
                borderRadius: '8px',
                border: '1px solid hsl(var(--border))',
                background: 'hsl(var(--border) / 0.22)',
                color: 'hsl(var(--text-secondary))',
                fontSize: '0.82rem',
                lineHeight: 1.55
              }}>
                <strong style={{ color: 'hsl(var(--text-primary))' }}>
                  {language === 'zh' ? '数据缺口校验' : 'Data Gap Check'}
                </strong>
                <div>
                  {language === 'zh'
                    ? `完整度 ${match.stats.dataGaps.coverageScore ?? '--'}，质量 ${match.stats.dataGaps.sourceQuality || '--'}；主要缺口：${(match.stats.dataGaps.missing || []).slice(0, 3).map((item) => item.zh || item.key).filter(Boolean).join('、') || '暂无关键缺口'}。`
                    : `Coverage ${match.stats.dataGaps.coverageScore ?? '--'}, quality ${match.stats.dataGaps.sourceQuality || '--'}; gaps: ${(match.stats.dataGaps.missing || []).slice(0, 3).map((item) => item.en || item.key).filter(Boolean).join(', ') || 'no major gap'}.`}
                </div>
              </div>
            )}
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
