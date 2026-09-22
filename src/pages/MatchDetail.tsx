import { PrematchCollectionPanel } from '../components/predictions/PrematchCollectionPanel';
import { useRecommendationCenter } from '../hooks/useRecommendationCenter';
import { publishedMatchRecommendation, usesPublishedRecommendation } from '../services/publishedMatchRecommendation';
import { PublishedMatchPick } from '../components/recommendations/PublishedMatchPick';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContextCore';
import type { FiveHundredRecentFormRow, League, Match, MatchProbabilityModel, MultiLangString, OutcomeProbability, PredictionDetail, ScoreProbability } from '../services/mockData';
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
import { getAnalysisReferenceHandicapSupplement, getDisplayRecommendation, getHandicapCompanionHeading, getLiveDisplayRecommendation, getMatchDisplayTeam as getDisplayTeam, isFormalRecommendationPrediction } from '../services/displayRecommendation';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl } from '../services/runtimeUrls';
import { buildFiveHundredDisplay } from '../services/fiveHundredDisplay';
import {
  buildFiveHundredMarketReferencePresentation,
  isFiveHundredMarketReferencePrediction
} from '../services/externalOddsReferencePresentation';
import { selectOnSaleAnalysisReference } from '../services/analysisReferenceSelection';
import {
  reconcileMatchLifecycle,
  resolveMatchLifecycle,
  sameMatchEvent
} from '../services/matchLifecycle';
import { TeamBadge } from '../components/TeamBadge';
import { RecommendationEvidenceFacts } from '../components/predictions/RecommendationEvidenceFacts';
import { CapturedMatchData, matchesSavedCaptureIdentity } from '../components/predictions/CapturedMatchData';
import { CapturedReferenceAnalysisPanel } from '../components/predictions/CapturedReferenceAnalysisPanel';
import type { SavedMatchCapture } from '../components/predictions/CapturedMatchData';
import { formatSourceNeutralText } from '../components/predictions/sourceNeutralText';
import { ArrowLeft, Trophy } from 'lucide-react';
import {
  formatCalibratedModelProbability,
  formatEvidenceScore,
  isFormalPresentationAllowed
} from '../services/predictionPresentation';
import { getArchivedPreMatchPrediction } from '../services/archivedPreMatchPrediction';
import { getProvisionalArchivedOutcome } from '../services/provisionalResultPresentation';
import { liveRecommendationCutoffIso } from '../services/liveRecommendationEligibility';
import '../styles/match-detail.css';

interface MatchDetailProps {
  matchId: string;
  onBack: () => void;
  initialTab?: DetailTab;
  capturedData?: SavedMatchCapture;
}

type MatchDetailCacheEntry = {
  etag: string;
  match: Match;
};

type DetailRequestStatus = 'loading' | 'ready' | 'failed';

const matchDetailResponseCache = new Map<string, MatchDetailCacheEntry>();
const detailFetchRetryDelaysMs = [350];
const PRIMARY_DETAIL_FETCH_TIMEOUT_MS = 4_500;
const FALLBACK_DETAIL_FETCH_TIMEOUT_MS = 3_500;

class DetailFetchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Match detail request timed out after ${timeoutMs}ms`);
    this.name = 'DetailFetchTimeoutError';
  }
}

const fetchDetailWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal
) => {
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromParent = () => requestController.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: requestController.signal });
  } catch (error) {
    if (timedOut) throw new DetailFetchTimeoutError(timeoutMs);
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
};

type DetailNavigationStage = 'shell' | 'data' | 'interactive';

const clearDetailNavigationMetrics = (matchId?: string) => {
  if (typeof document === 'undefined') return;
  const dataset = document.documentElement.dataset;
  if (matchId && dataset.detailNavigationMatchId !== matchId) return;
  delete dataset.detailNavigationMatchId;
  delete dataset.detailNavigationMs;
  delete dataset.detailNavigationDataMs;
  delete dataset.detailNavigationDataStatus;
  delete dataset.detailNavigationDataSource;
  delete dataset.detailNavigationInteractiveMs;
  delete dataset.detailNavigationInteractiveStatus;
};

const markDetailNavigation = (
  matchId: string,
  startedAt: number,
  stage: DetailNavigationStage,
  status: string,
  source?: string
) => {
  if (typeof document === 'undefined' || !Number.isFinite(startedAt) || startedAt <= 0) return;
  const dataset = document.documentElement.dataset;
  if (dataset.detailNavigationMatchId !== matchId) return;
  const elapsedMs = String(Math.max(0, Date.now() - startedAt));
  if (stage === 'shell') {
    dataset.detailNavigationMs = elapsedMs;
    return;
  }
  if (stage === 'data') {
    dataset.detailNavigationDataMs = elapsedMs;
    dataset.detailNavigationDataStatus = status;
    if (source) dataset.detailNavigationDataSource = source;
    else delete dataset.detailNavigationDataSource;
    return;
  }
  dataset.detailNavigationInteractiveMs = elapsedMs;
  dataset.detailNavigationInteractiveStatus = status;
};

const waitForDetailRetry = (delayMs: number) => new Promise((resolve) => {
  window.setTimeout(resolve, delayMs);
});

const isTransientDetailStatus = (status: number) => (
  status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
);

const isTransientDetailError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  if (error.name === 'DetailFetchTimeoutError') return true;
  if (error.name === 'AbortError') return true;
  return /Failed to fetch|NetworkError|Load failed/i.test(error.message);
};

const emptyBasis = { zh: '--', en: '--' };

const finiteProbabilityOrNaN = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
};

const normalizeOutcomeProbability = (
  probabilities: OutcomeProbability | null | undefined
): OutcomeProbability | null => {
  if (!probabilities) return null;
  return {
    home: finiteProbabilityOrNaN(probabilities.home),
    draw: finiteProbabilityOrNaN(probabilities.draw),
    away: finiteProbabilityOrNaN(probabilities.away)
  };
};

const normalizeProbabilityModel = (
  model: MatchProbabilityModel | null | undefined
): MatchProbabilityModel | undefined => {
  if (!model) return undefined;
  const oneXTwo = model.oneXTwo || {
    market: null,
    poisson: null,
    final: null
  };

  return {
    ...model,
    basis: model.basis || emptyBasis,
    oneXTwo: {
      ...oneXTwo,
      market: normalizeOutcomeProbability(oneXTwo.market),
      teamStrength: normalizeOutcomeProbability(oneXTwo.teamStrength),
      elo: normalizeOutcomeProbability(oneXTwo.elo),
      poisson: normalizeOutcomeProbability(oneXTwo.poisson),
      scoreImplied: normalizeOutcomeProbability(oneXTwo.scoreImplied),
      worldCupPrior: normalizeOutcomeProbability(oneXTwo.worldCupPrior),
      final: normalizeOutcomeProbability(oneXTwo.final),
      unifiedPosterior: normalizeOutcomeProbability(oneXTwo.unifiedPosterior)
    },
    scoreDistribution: Array.isArray(model.scoreDistribution) ? model.scoreDistribution : [],
    goalLines: {
      over25: finiteProbabilityOrNaN(model.goalLines?.over25),
      under25: finiteProbabilityOrNaN(model.goalLines?.under25)
    },
    bothTeamsToScore: {
      yes: finiteProbabilityOrNaN(model.bothTeamsToScore?.yes),
      no: finiteProbabilityOrNaN(model.bothTeamsToScore?.no)
    },
    handicap: model.handicap
      ? {
        ...model.handicap,
        market: normalizeOutcomeProbability(model.handicap.market),
        poisson: normalizeOutcomeProbability(model.handicap.poisson),
        scoreImplied: normalizeOutcomeProbability(model.handicap.scoreImplied),
        unifiedPosterior: normalizeOutcomeProbability(model.handicap.unifiedPosterior)
      }
      : model.handicap
  };
};

type Language = 'zh' | 'en';
type DetailTab = 'overview' | 'probability' | 'evidence' | 'history';
type PostReviewRow = NonNullable<Match['postMatchReview']>['predictionReview']['rows'][number];

const detailTabOrder: readonly DetailTab[] = ['overview', 'probability', 'evidence', 'history'];
const detailTabId = (tab: DetailTab) => `match-detail-tab-${tab}`;
const detailPanelId = 'match-detail-panel';

const publicRecommendationBlockerLabels: Record<string, MultiLangString> = {
  'upstream-multi-factor-gate-not-passed': { zh: '上游多因素门槛未通过', en: 'Upstream multi-factor gate did not pass' },
  'model-risk-not-promotable': { zh: '模型风险状态暂不可发布', en: 'Model risk state is not publishable' },
  'insufficient-data-quality': { zh: '赛前数据质量不足', en: 'Pre-match data quality is insufficient' },
  'too-many-severe-data-gaps': { zh: '关键数据缺口过多', en: 'Too many critical data gaps' },
  'had-hhad-conflict': { zh: '胜平负与让球盘方向冲突', en: 'HAD and HHAD directions conflict' },
  'candidate-risk-too-high': { zh: '候选方向风险过高', en: 'Candidate risk is too high' },
  'evidence-score-below-threshold': { zh: '多因素证据分未达门槛', en: 'Evidence score is below threshold' },
  'negative-expected-value': { zh: '期望价值未通过', en: 'Expected value did not pass' },
  'too-many-risk-tags': { zh: '风险标签过多', en: 'Too many risk flags' },
  'market-implied-probability-contradiction': { zh: '模型方向与市场概率矛盾', en: 'Model direction conflicts with market probability' },
  'low-sp-without-model-edge': { zh: '低 SP 方向缺少模型优势', en: 'Low-SP side lacks model edge' },
  'low-sp-without-value': { zh: '低 SP 方向缺少价值', en: 'Low-SP side lacks value' },
  'model-probability-too-low': { zh: '模型概率未达门槛', en: 'Model probability is below threshold' }
};

const handleRovingTabKeyDown = <T extends string,>(
  event: React.KeyboardEvent<HTMLButtonElement>,
  order: readonly T[],
  current: T,
  activate: (next: T) => void,
  getId: (next: T) => string
) => {
  let nextIndex: number | null = null;
  const currentIndex = Math.max(0, order.indexOf(current));

  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % order.length;
  if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + order.length) % order.length;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = order.length - 1;
  if (nextIndex === null) return;

  event.preventDefault();
  const next = order[nextIndex];
  activate(next);
  window.requestAnimationFrame(() => document.getElementById(getId(next))?.focus());
};

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

type ModelEstimateRow = {
  key: string;
  label: string;
  home: number;
  away: number;
  unit: string;
  source: string;
  quality: string;
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
  goalsFor: number;
  goalsAgainst: number;
  cleanSheets: number;
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

const isSettledReviewStatus = (status: string | undefined) => (
  status === 'WON' || status === 'LOST'
);

const isFormalPostReviewRow = (row: PostReviewRow | undefined) => Boolean(
  row
  && row.performanceTrack === 'formal'
  && row.recommendationAction === 'recommend'
  && row.reviewRole === 'main'
  && isSettledReviewStatus(row.resultStatus)
);

const isLivePostReviewRow = (row: PostReviewRow | undefined) => Boolean(
  row?.performanceTrack === 'live-model'
);

const getPostReviewOutcomeLabel = (row: PostReviewRow | undefined, language: Language) => {
  if (!row || !isSettledReviewStatus(row.resultStatus)) {
    return language === 'zh' ? '待结算' : 'Pending';
  }
  if (isFormalPostReviewRow(row)) {
    return row.resultStatus === 'WON'
      ? (language === 'zh' ? '推荐命中' : 'Formal pick hit')
      : (language === 'zh' ? '推荐未中' : 'Formal pick miss');
  }
  if (isLivePostReviewRow(row)) {
    return row.resultStatus === 'WON'
      ? (language === 'zh' ? '实时推荐命中' : 'Live pick hit')
      : (language === 'zh' ? '实时推荐未中' : 'Live pick miss');
  }
  return row.resultStatus === 'WON'
    ? (language === 'zh' ? '分析参考符合赛果' : 'Analysis reference matched result')
    : (language === 'zh' ? '分析参考不符合赛果' : 'Analysis reference did not match result');
};

const getPrimaryPostReviewRow = (rows: PostReviewRow[]): PostReviewRow | undefined => {
  const settledRows = rows.filter((row) => isSettledReviewStatus(row.resultStatus));
  if (!settledRows.length) return undefined;
  return settledRows.find((row) => isFormalPostReviewRow(row) && row.marketType === 'BEST')
    || settledRows.find((row) => isFormalPostReviewRow(row))
    || settledRows.find((row) => isLivePostReviewRow(row) && row.marketType === 'BEST')
    || settledRows.find((row) => isLivePostReviewRow(row))
    || settledRows.find((row) => row.marketType === 'BEST')
    || settledRows[0];
};

const predictionFromPostReviewRow = (row: PostReviewRow | undefined): PredictionDetail | undefined => {
  if (!row) return undefined;
  const tipCodeLabel = String(row.tipCode || '--');
  const tipLabel = {
    zh: row.tipLabel?.zh || row.tipLabel?.en || tipCodeLabel,
    en: row.tipLabel?.en || row.tipLabel?.zh || tipCodeLabel
  };
  return {
    marketType: row.marketType,
    oddsPoolCode: row.oddsPoolCode,
    handicapLine: row.handicapLine,
    tipCode: row.tipCode,
    tipLabel,
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

const parseHandicapLine = (line: unknown): number | null => {
  if (typeof line === 'number') return Number.isFinite(line) ? line : null;
  if (typeof line !== 'string') return null;
  const normalized = line
    .trim()
    .replace(/\uFF0B/g, '+')
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, '-');
  const matched = normalized.match(/^(?:(?:\u8BA9\u7403|HHAD|handicap)\s*[:\uFF1A]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\u7403)?$/i);
  if (!matched) return null;
  const value = Number(matched[1]);
  return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
};

const hasExplicitHhadMarker = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return [
    record.poolCode,
    record.oddsPoolCode,
    record.market,
    record.marketType,
    record.externalOddsPoolCode,
    record.handicapOddsPoolCode
  ].some((marker) => String(marker || '').trim().toUpperCase() === 'HHAD');
};

const resolveHandicapLine = (match: Match, prediction?: PredictionDetail): number | null => {
  const bookmakerHhad = match.externalSignals?.bookmakerOdds?.hhad;
  const bookmakerLine = parseHandicapLine(bookmakerHhad?.handicapLine);
  const externalLine = parseHandicapLine(match.externalSignals?.handicapLine);
  const hasBookmakerHhadOdds = Boolean(
    bookmakerHhad
    && [bookmakerHhad.odds1, bookmakerHhad.oddsX, bookmakerHhad.odds2]
      .every((odd) => Number.isFinite(Number(odd)) && Number(odd) > 1)
  );
  const allowExternalLine = bookmakerLine === null
    && externalLine !== null
    && (hasBookmakerHhadOdds || hasExplicitHhadMarker(bookmakerHhad) || hasExplicitHhadMarker(match.externalSignals));
  const predictionLines = [
    prediction?.oddsPoolCode === 'HHAD' ? prediction.handicapLine : undefined,
    ...(match.predictions || [])
      .filter((item) => item !== prediction && item.oddsPoolCode === 'HHAD')
      .map((item) => item.handicapLine)
  ];
  const candidates: unknown[] = [
    ...predictionLines,
    match.handicapLine,
    bookmakerLine !== null ? bookmakerHhad?.handicapLine : undefined,
    allowExternalLine ? match.externalSignals?.handicapLine : undefined
  ];
  for (const candidate of candidates) {
    const parsed = parseHandicapLine(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
};

const serializeHandicapLine = (line: number): string => {
  if (line === 0) return '0';
  const absolute = Math.abs(line);
  const value = Number.isInteger(absolute)
    ? String(absolute)
    : absolute.toFixed(2).replace(/\.?0+$/, '');
  return `${line > 0 ? '+' : '-'}${value}`;
};

const handicapResultStatus = (match: Match, code: OutcomeCode): PredictionDetail['resultStatus'] => {
  if (!Number.isFinite(match.scoreHome) || !Number.isFinite(match.scoreAway)) return 'PENDING';
  const line = resolveHandicapLine(match);
  if (line === null) return 'PENDING';
  const adjustedHome = Number(match.scoreHome) + line;
  const away = Number(match.scoreAway);
  const actual = adjustedHome > away ? '1' : adjustedHome === away ? 'X' : '2';
  return actual === code ? 'WON' : 'LOST';
};

const getHandicapRead = (match: Match) => {
  const hasHandicapLine = resolveHandicapLine(match) !== null;
  const modelRows = rankOutcomeProbabilities(
    hasHandicapLine ? (match.probabilityModel?.handicap?.scoreImplied
      || match.probabilityModel?.handicap?.poisson
      || match.probabilityModel?.handicap?.market) : null
  );
  const marketRows = rankOutcomeProbabilities(hasHandicapLine ? match.probabilityModel?.handicap?.market : null);
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
  if (resolveHandicapLine(match, prediction) === null) return false;
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
  const handicapLine = resolveHandicapLine(match, promotedPrediction);
  if (handicapLine === null) return undefined;
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
    handicapLine: serializeHandicapLine(handicapLine),
    tipCode: read.modelTop.code,
    tipLabel: label,
    odds: getOutcomeOddsValue(match, 'HHAD', read.modelTop.code),
    trustScore: Math.round(Math.max(read.modelTop.probability, read.marketSupport)),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-override-reference',
    explanation: {
      zh: `普通胜平负未通过正式推荐门槛；让球模型和官方让球盘同向，因此把${label.zh}保留为分析参考。`,
      en: `The raw 1X2 lane did not pass the formal gate; model and official HHAD align, so ${label.en} is retained as an analysis reference.`
    },
    analysisItems: [],
    riskTags: [{ zh: '让球分析参考', en: 'HHAD analysis reference' }],
    visibilityStatus: 'FREE',
    resultStatus: handicapResultStatus(match, read.modelTop.code)
  };
};

const getHandicapMarketReferencePrediction = (match: Match): PredictionDetail | undefined => {
  const handicapLine = resolveHandicapLine(match);
  if (handicapLine === null) return undefined;
  const read = getHandicapRead(match);
  if (!read.marketTop) return undefined;

  const label = handicapTipLabel(read.marketTop.code);
  return {
    marketType: '1X2',
    oddsPoolCode: 'HHAD',
    handicapLine: serializeHandicapLine(handicapLine),
    tipCode: read.marketTop.code,
    tipLabel: label,
    odds: getOutcomeOddsValue(match, 'HHAD', read.marketTop.code),
    trustScore: Math.round(read.marketTop.probability),
    recommendationAction: 'reference',
    recommendationTier: 'handicap-market-reference',
    explanation: {
      zh: `普通胜平负未开售，让球胜平负的${label.zh}仅作盘口分析参考。`,
      en: `Standard 1X2 is not on sale; ${label.en} is shown only as a handicap-market analysis reference.`
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

const dedupeScoreCandidates = <T extends Pick<ScoreProbability, 'home' | 'away'> & { label?: string }>(scores: T[]) => {
  const seen = new Set<string>();
  return scores.filter((score) => {
    const key = scoreCandidateKey(score);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const minutesSinceKickoff = (match: Match, now = Date.now()) => {
  const kickoffAt = new Date(match.kickoffTime).getTime();
  if (!Number.isFinite(kickoffAt)) return 0;
  return Math.floor((now - kickoffAt) / 60000);
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
    goalsFor: allRows.reduce((sum, row) => sum + row.ourScore, 0),
    goalsAgainst: allRows.reduce((sum, row) => sum + row.oppScore, 0),
    cleanSheets: allRows.filter(row => row.oppScore === 0).length,
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
    goalsFor: rows.reduce((sum, row) => sum + row.ourScore, 0),
    goalsAgainst: rows.reduce((sum, row) => sum + row.oppScore, 0),
    cleanSheets: rows.filter(row => row.oppScore === 0).length,
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

const parseFreshnessTime = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const getMatchFreshnessTime = (match: Match | null | undefined) => {
  if (!match) return 0;
  const matchEnvelope = match as Match & {
    updatedAt?: string | null;
    capturedAt?: string | null;
  };

  return Math.max(
    parseFreshnessTime(matchEnvelope.updatedAt),
    parseFreshnessTime(matchEnvelope.capturedAt),
    parseFreshnessTime(match.eventVersion),
    parseFreshnessTime(match.kickoffTime),
    parseFreshnessTime(match.predictionMeta?.updatedAt),
    parseFreshnessTime(match.predictionMeta?.generatedAt),
    parseFreshnessTime(match.predictionMeta?.lockedAt),
    parseFreshnessTime(match.gptPrediction?.generatedAt),
    parseFreshnessTime(match.gptPrediction?.llmReview?.generatedAt),
    parseFreshnessTime(match.probabilityModel?.generatedAt),
    parseFreshnessTime(match.externalSignals?.updatedAt),
    parseFreshnessTime(match.externalSignals?.preMatch?.updatedAt),
    parseFreshnessTime(match.externalSignals?.fiveHundred?.updatedAt),
    parseFreshnessTime(match.oddsUpdatedAt),
    parseFreshnessTime(match.handicapOddsUpdatedAt),
    parseFreshnessTime(match.oddsTrend?.firstCapturedAt),
    parseFreshnessTime(match.oddsTrend?.lastCapturedAt),
    parseFreshnessTime(match.resultUpdatedAt),
    parseFreshnessTime(match.resultProvenance?.kickoffTime),
    parseFreshnessTime(match.resultProvenance?.eventVersion),
    parseFreshnessTime(match.resultProvenance?.observedAt),
    parseFreshnessTime(match.postMatchReview?.generatedAt)
  );
};

const selectFreshestMatch = (
  detailMatch: Match | null,
  contextMatch: Match | undefined,
  seededMatch: Match | null | undefined,
  now: number
) => {
  const resolvedDetail = detailMatch ? resolveMatchLifecycle(detailMatch, now) : null;
  const resolvedContext = contextMatch ? resolveMatchLifecycle(contextMatch, now) : null;
  const resolvedSeed = seededMatch ? resolveMatchLifecycle(seededMatch, now) : null;

  if (!resolvedDetail) return resolvedContext || resolvedSeed;
  if (!resolvedContext) return resolvedDetail;

  if (sameMatchEvent(detailMatch, contextMatch)) {
    return reconcileMatchLifecycle(resolvedDetail, resolvedContext, now);
  }

  const detailFreshness = getMatchFreshnessTime(resolvedDetail);
  const contextFreshness = getMatchFreshnessTime(resolvedContext);
  return contextFreshness > detailFreshness ? resolvedContext : resolvedDetail;
};

export const MatchDetail: React.FC<MatchDetailProps> = ({ matchId, onBack, initialTab = 'overview', capturedData }) => {
  const { language, matches, dataSync } = useApp();
  const published = useRecommendationCenter();
  const displayText = (value: string | null | undefined, fallback = '') => formatSourceNeutralText(value, language, fallback);
  const [activeTab, setActiveTab] = useState<DetailTab>(initialTab);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [fullMatch, setFullMatch] = useState<Match | null>(null);
  const [detailRequestState, setDetailRequestState] = useState<{
    matchId: string;
    status: DetailRequestStatus;
  }>({
    matchId,
    status: 'loading'
  });
  const detailRequestStatus = detailRequestState.matchId === matchId
    ? detailRequestState.status
    : 'loading';
  const [detailShellState, setDetailShellState] = useState<{ matchId: string; ready: boolean }>(() => ({
    matchId,
    ready: typeof window === 'undefined'
  }));
  const hasContextShellMatch = matches.some((item) => item.id === matchId);
  const detailShellReady = hasContextShellMatch
    || (detailShellState.matchId === matchId && detailShellState.ready);
  const [worldCupSeedState, setWorldCupSeedState] = useState<{ matchId: string; match: Match | null }>({
    matchId: '',
    match: null
  });
  const worldCupSeededMatch = worldCupSeedState.matchId === matchId ? worldCupSeedState.match : null;
  const detailRefreshKey = [
    dataSync.sourceUpdatedAt,
    dataSync.sourceHealthSummary?.resultFreshnessTime,
    dataSync.sourceHealthSummary?.historyFreshnessTime,
    dataSync.updatedAt
  ].filter(Boolean).join('|');
  const detailNavigationStartedAtRef = useRef(0);

  useEffect(() => {
    const refreshClock = () => setNowMs(Date.now());
    const intervalId = window.setInterval(refreshClock, 30_000);
    const refreshClockWhenVisible = () => {
      if (!document.hidden) refreshClock();
    };
    document.addEventListener('visibilitychange', refreshClockWhenVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refreshClockWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const timerId = window.setTimeout(() => {
      setDetailShellState({ matchId, ready: true });
    }, 160);
    return () => window.clearTimeout(timerId);
  }, [matchId]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    clearDetailNavigationMetrics();
    let startedAt: number;
    try {
      startedAt = Number(window.sessionStorage.getItem('football.detailNavigationStartedAt') || 0);
      window.sessionStorage.removeItem('football.detailNavigationStartedAt');
    } catch {
      startedAt = 0;
    }
    detailNavigationStartedAtRef.current = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0;
    document.documentElement.dataset.detailNavigationMatchId = matchId;
    markDetailNavigation(matchId, detailNavigationStartedAtRef.current, 'shell', 'ready');
    return () => {
      detailNavigationStartedAtRef.current = 0;
      clearDetailNavigationMetrics(matchId);
    };
  }, [matchId]);

  useEffect(() => {
    if (!matchId.startsWith('wc2026_')) return undefined;
    let cancelled = false;
    import('../services/worldCupData').then(({ getWorldCupSeededFixtures }) => {
      if (cancelled) return;
      setWorldCupSeedState({
        matchId,
        match: getWorldCupSeededFixtures(104).find((item) => item.id === matchId) || null
      });
    }).catch(() => {
      if (!cancelled) setWorldCupSeedState({ matchId, match: null });
    });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const version = encodeURIComponent(detailRefreshKey || String(Date.now()));
    const versionedUrl = (url: string) => `${url}${url.includes('?') ? '&' : '?'}v=${version}`;
    const loadDetail = async () => {
      setDetailRequestState({ matchId, status: 'loading' });
      const accessHeaders = getAccessAuthHeaders();
      const detailRequests = [
        {
          url: buildApiUrl(`/api/v1/matches/${encodeURIComponent(matchId)}`),
          source: 'v1',
          maxAttempts: 2,
          timeoutMs: PRIMARY_DETAIL_FETCH_TIMEOUT_MS
        },
        {
          url: buildApiUrl(`/api/matches/${encodeURIComponent(matchId)}`),
          source: 'legacy-fallback',
          maxAttempts: 1,
          timeoutMs: FALLBACK_DETAIL_FETCH_TIMEOUT_MS
        }
      ];
      let lastFailure = 'unavailable';

      if (typeof document !== 'undefined'
        && document.documentElement.dataset.detailNavigationMatchId === matchId
        && detailNavigationStartedAtRef.current > 0) {
        document.documentElement.dataset.detailNavigationDataStatus = 'loading';
      }

      for (const detailRequest of detailRequests) {
        if (cancelled || controller.signal.aborted) return;
        const requestUrl = versionedUrl(detailRequest.url);
        try {
          const cached = matchDetailResponseCache.get(requestUrl);
          const headers = {
            ...accessHeaders,
            ...(cached?.etag ? { 'if-none-match': cached.etag } : {})
          };
          let response: Response | null = null;
          for (let attempt = 0; attempt < detailRequest.maxAttempts; attempt += 1) {
            try {
              response = await fetchDetailWithTimeout(requestUrl, {
                credentials: 'include',
                cache: 'no-cache',
                headers: Object.keys(headers).length ? headers : undefined
              }, detailRequest.timeoutMs, controller.signal);
              lastFailure = `http-${response.status}`;
              if (!isTransientDetailStatus(response.status) || attempt + 1 >= detailRequest.maxAttempts) break;
            } catch (error) {
              if (controller.signal.aborted || cancelled) return;
              lastFailure = error instanceof Error ? error.name || 'request-error' : 'request-error';
              response = null;
              if (!isTransientDetailError(error) || attempt + 1 >= detailRequest.maxAttempts) break;
            }
            await waitForDetailRetry(detailFetchRetryDelaysMs[attempt] || detailFetchRetryDelaysMs.at(-1) || 350);
          }
          if (!response) continue;
          if (response.status === 304 && cached) {
            if (!cancelled) {
              setFullMatch(cached.match);
              setDetailRequestState({ matchId, status: 'ready' });
              markDetailNavigation(matchId, detailNavigationStartedAtRef.current, 'data', 'ready', `${detailRequest.source}-cache`);
            }
            return;
          }
          let data = null;
          if (response.ok) {
            try {
              data = await response.json();
            } catch {
              lastFailure = 'invalid-json';
              continue;
            }
          }
          const matchPayload = data?.match || data;
          if (!cancelled && matchPayload?.id === matchId) {
            const resolvedMatch = matchPayload as Match;
            const etag = response.headers.get('etag');
            if (etag) {
              matchDetailResponseCache.set(requestUrl, { etag, match: resolvedMatch });
              if (matchDetailResponseCache.size > 30) {
                const oldestKey = matchDetailResponseCache.keys().next().value;
                if (oldestKey) matchDetailResponseCache.delete(oldestKey);
              }
            }
            setFullMatch(resolvedMatch);
            setDetailRequestState({ matchId, status: 'ready' });
            markDetailNavigation(matchId, detailNavigationStartedAtRef.current, 'data', 'ready', detailRequest.source);
            return;
          }
        } catch (error) {
          if (controller.signal.aborted || cancelled) return;
          lastFailure = error instanceof Error ? error.name || 'request-error' : 'request-error';
        }
      }

      if (!cancelled) setDetailRequestState({ matchId, status: 'failed' });
      markDetailNavigation(matchId, detailNavigationStartedAtRef.current, 'data', 'failed', lastFailure);
      // Context data remains the final UI fallback when both protected endpoints are unavailable.
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
    return selectFreshestMatch(detailMatch, contextMatch, worldCupSeededMatch, nowMs);
  }, [fullMatch, matchId, matches, nowMs, worldCupSeededMatch]);
  const hasAuthoritativeDetailMatch = fullMatch?.id === matchId;
  const shellKickoffAt = Date.parse(match?.kickoffTime || '');
  const isPastKickoffAwaitingAuthoritativeDetail = Boolean(
    match
    && !hasAuthoritativeDetailMatch
    && detailRequestStatus === 'loading'
    && Number.isFinite(shellKickoffAt)
    && shellKickoffAt <= nowMs
    && match.status !== 'FINISHED'
    && match.status !== 'PENDING_RESULT'
  );

  useEffect(() => {
    if (!detailShellReady || isPastKickoffAwaitingAuthoritativeDetail) return undefined;
    if (!match) {
      if (dataSync.currentLoaded) {
        markDetailNavigation(matchId, detailNavigationStartedAtRef.current, 'interactive', 'failed');
      }
      return undefined;
    }
    const frameId = window.requestAnimationFrame(() => {
      const dataset = document.documentElement.dataset;
      if (dataset.detailNavigationInteractiveStatus !== 'ready') {
        markDetailNavigation(matchId, detailNavigationStartedAtRef.current, 'interactive', 'ready');
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [dataSync.currentLoaded, detailShellReady, isPastKickoffAwaitingAuthoritativeDetail, match, matchId]);

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

  // Saved-capture reference calculations remain separate from the published model.
  // Keep this branch after every hook and before the normal analytical presentation.
  if (matchesSavedCaptureIdentity(capturedData, match)
    && !match.predictions?.length && !match.probabilityModel && !match.gptPrediction) {
    const capturedKickoff = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23', timeZone: 'Asia/Shanghai'
    }).format(new Date(match.kickoffTime));
    return (
      <div className="match-detail-shell captured-only-detail" data-section="captured-record-only">
        <div className="detail-topbar">
          <span>{displayText(match.leagueName || match.leagueShortName, language === 'zh' ? '赛事详情' : 'Fixture detail')}</span>
          <button onClick={onBack} className="btn btn-secondary" type="button">
            <ArrowLeft size={16} /> {language === 'zh' ? '返回列表' : 'Back'}
          </button>
        </div>
        <header className="card captured-only-detail__summary">
          <h1>{displayText(match.homeTeamName)} <span>{language === 'zh' ? '对阵' : 'vs'}</span> {displayText(match.awayTeamName)}</h1>
          <p>{language === 'zh' ? '开赛时间：' : 'Kickoff: '}{displayText(capturedKickoff)}{language === 'zh' ? '（北京时间）' : ' (Beijing time)'}</p>
          <strong>{language === 'zh' ? '赛前推荐与比赛参数' : 'Pre-match picks and match parameters'}</strong>
        </header>
        <CapturedReferenceAnalysisPanel match={match} capture={capturedData} language={language} now={nowMs} />
        <CapturedMatchData capture={capturedData} language={language} />
      </div>
    );
  }

  if (!detailShellReady || isPastKickoffAwaitingAuthoritativeDetail) {
    const scoreReady = Number.isInteger(match.scoreHome) && Number.isInteger(match.scoreAway);
    const statusText = match.resultDisposition === 'VOID'
      ? (language === 'zh' ? '已取消 / 退款' : 'Void / refunded')
      : scoreReady
      ? `${match.scoreHome} - ${match.scoreAway}`
      : (match.status === 'PENDING_RESULT'
        ? (language === 'zh' ? '等待官方赛果' : 'Awaiting official result')
        : isPastKickoffAwaitingAuthoritativeDetail
          ? (language === 'zh' ? '比赛状态同步中' : 'Match status syncing')
          : (language === 'zh' ? '比赛详情' : 'Match detail'));
    return (
      <div className="match-detail-shell match-detail-shell-loading">
        <h1 className="sr-only">
          {match.homeTeamName || match.homeTeamId} {language === 'zh' ? '对阵' : 'versus'} {match.awayTeamName || match.awayTeamId}
        </h1>
        <div className="detail-topbar">
          <span>{match.leagueShortName || match.leagueName || (language === 'zh' ? '赛事详情' : 'Fixture detail')}</span>
          <button onClick={onBack} className="btn btn-secondary" type="button">
            <ArrowLeft size={16} /> {language === 'zh' ? '返回列表' : 'Back'}
          </button>
        </div>
        <div className="card match-detail-fast-shell" aria-busy="true">
          <div>
            <span>{match.homeTeamName || match.homeTeamId}</span>
            <strong>{statusText}</strong>
            <span>{match.awayTeamName || match.awayTeamId}</span>
          </div>
          <p>{language === 'zh' ? '比赛页面已打开，正在整理盘口、赛前记录与复盘数据…' : 'Match page opened; preparing market, pre-match record, and review data…'}</p>
        </div>
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
  const isVoid = match.resultDisposition === 'VOID';
  const kickoffAt = Date.parse(match.kickoffTime || '');
  const isPastScheduled = match.status === 'SCHEDULED'
    && Number.isFinite(kickoffAt)
    && kickoffAt <= nowMs;
  const isScheduledStatusSyncing = match.status === 'SCHEDULED'
    && detailRequestStatus === 'loading';
  const isResultPhase = isFinished || isPendingResult;
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
    overviewTab: { zh: '概览', en: 'Overview' },
    probabilityTab: { zh: '概率与赔率', en: 'Probability & Odds' },
    evidenceTab: { zh: '数据与分析', en: 'Data & Analysis' },
    historyTab: { zh: '历史与复盘', en: 'History & Review' },
    market: { zh: '分析市场', en: 'Market' },
    tip: { zh: '分析方向', en: 'Direction' },
    odds: { zh: '赔率', en: 'Odds' },
    trust: { zh: '证据评分', en: 'Evidence Score' },
    analysis: { zh: '分析说明', en: 'Analysis Notes' },
    scorePrediction: { zh: '比分热区', en: 'Score Heat Zone' },
    teamValue: { zh: '阵容估值', en: 'Squad Value' },
    kickoff: { zh: '开赛时间', en: 'Kickoff' },
    referenceText: { zh: '预测内容仅供赛前参考，请结合临场信息理性判断。', en: 'Forecasts are for pre-match reference only; use late information and your own judgment.' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };
  const detailTabItems: Array<{ key: DetailTab; label: string }> = [
    { key: 'overview', label: t('overviewTab') },
    { key: 'probability', label: t('probabilityTab') },
    { key: 'evidence', label: t('evidenceTab') },
    { key: 'history', label: t('historyTab') }
  ];
  const storedHhadPrediction = (match.predictions || []).find((prediction) => prediction.oddsPoolCode === 'HHAD');
  const hasResolvableHandicapLine = resolveHandicapLine(match, storedHhadPrediction) !== null;
  const poolRows = getSportteryPoolRows(match, language)
    .filter((row) => row.poolCode !== 'HHAD' || hasResolvableHandicapLine);
  const resultPoolAvailability = getOfficialResultPoolAvailability(match);
  const hasHadResultPool = resultPoolAvailability.hasHad;
  const hasHhadResultPool = resultPoolAvailability.hasHhad && hasResolvableHandicapLine;
  const isPredictionResultPoolAvailable = (prediction: PredictionDetail | undefined) => {
    if (!prediction || !isOutcomeTipCode(prediction.tipCode)) return false;
    if (prediction.oddsPoolCode === 'HHAD') {
      return resolveHandicapLine(match, prediction) !== null
        && (isPredictionOfficialResultPoolAvailable(match, prediction) || match.status !== 'SCHEDULED');
    }
    return isPredictionOfficialResultPoolAvailable(match, prediction) || match.status !== 'SCHEDULED';
  };
  const shouldApplyLiveMarketFilter = match.status === 'SCHEDULED';
  const visiblePredictions = getVisiblePredictions(match);
  const hasPredictions = visiblePredictions.length > 0;
  const postMatchReview = match.postMatchReview;
  const postReviewRows = postMatchReview?.predictionReview?.rows || [];
  const primaryPostReviewRow = getPrimaryPostReviewRow(postReviewRows);
  const primaryPostReviewPrediction = predictionFromPostReviewRow(primaryPostReviewRow);
  const settledPostReviewRows = postReviewRows.filter((row) => isSettledReviewStatus(row.resultStatus));
  const hasReviewPredictions = settledPostReviewRows.length > 0;
  const hasPredictionContent = hasPredictions || hasReviewPredictions;
  const postReviewDiagnosis = postMatchReview?.modelDiagnosis || [];
  const postReviewAdjustments = postMatchReview?.nextAdjustment || [];
  const postReviewDataGaps = postMatchReview?.dataGaps || [];
  const primaryPostReviewMistakeSummary = primaryPostReviewRow?.resultStatus === 'LOST'
    ? (language === 'zh'
      ? `赛前冻结方向为“${primaryPostReviewRow.tipLabel?.zh || primaryPostReviewRow.tipCode || '--'}”，实际结算为“${primaryPostReviewRow.actualLabel?.zh || primaryPostReviewRow.actualCode || '--'}”。本场可确认的直接失误是主方向判断错误；其他原因只按已接入证据说明，不使用缺失数据倒推。`
      : `The frozen direction was “${primaryPostReviewRow.tipLabel?.en || primaryPostReviewRow.tipCode || '--'}”, while settlement was “${primaryPostReviewRow.actualLabel?.en || primaryPostReviewRow.actualCode || '--'}”. The confirmed direct error is the primary direction call; other causes are stated only when supported by available evidence.`)
    : '';
  const formalPresentationAllowed = isFormalPresentationAllowed(
    dataSync.modelEvaluation?.backtest?.riskTiers?.overall?.tier,
    dataSync.sourceHealth?.fallbackCoverage?.servingMode || dataSync.sourceFallbackCoverage?.servingMode
  );
  const rawDisplayRecommendation = getDisplayRecommendation(match, language);
  const liveDisplayRecommendation = getLiveDisplayRecommendation(match, language);
  // getLiveDisplayRecommendation only returns a server-owned publication that
  // passed immutable publication validation. Keep that frozen record visible
  // through LIVE and the result-settlement gap; it is replaced by review data
  // as soon as a settled review row exists.
  const hasImmutableLivePublication = Boolean(
    liveDisplayRecommendation?.publicationTrack === 'live'
    && liveDisplayRecommendation.prediction?.livePublicationEvidence
  );
  const isPublishedLiveAwaitingSettlement = Boolean(
    hasImmutableLivePublication
    && isResultPhase
    && !isVoid
    && !hasReviewPredictions
  );
  const archivedPreMatchPrediction = getArchivedPreMatchPrediction(match, nowMs);
  const provisionalArchivedOutcome = getProvisionalArchivedOutcome(match, nowMs);
  const isPreMatchRecordSettling = isResultPhase
    && !isVoid
    && !hasReviewPredictions
    && !isPublishedLiveAwaitingSettlement
    && !archivedPreMatchPrediction;
  const isPredictionArchiveOnly = isResultPhase && !isPreMatchRecordSettling && !hasPredictionContent;
  const unifiedRow = publishedMatchRecommendation(published.data, match);
  const useUnified = published.loading || published.failed || usesPublishedRecommendation(match, unifiedRow, nowMs);
  // Publication risk may downgrade how a direction is labelled, but it must not
  // cause the detail page to choose a different direction from the list card.
  const detailAnalysisCandidate = rawDisplayRecommendation?.prediction;
  const canonicalPublishedRecommendation = rawDisplayRecommendation
    || liveDisplayRecommendation;
  const displayRecommendation = (formalPresentationAllowed ? rawDisplayRecommendation : null)
    || liveDisplayRecommendation;
  const detailAnalysisReferenceSelection = !isResultPhase && !canonicalPublishedRecommendation
    ? selectOnSaleAnalysisReference(match, {
        allowModelOnly: true,
        candidate: detailAnalysisCandidate,
        now: nowMs
      })
    : undefined;
  const analysisReferencePrediction = detailAnalysisReferenceSelection?.prediction;
  const fiveHundredMarketReference = !isResultPhase
    ? buildFiveHundredMarketReferencePresentation(match, nowMs)
    : null;
  const companionRecommendation = isResultPhase || primaryPostReviewPrediction
    ? undefined
    : displayRecommendation?.companion
      || getAnalysisReferenceHandicapSupplement(
        match,
        language,
        canonicalPublishedRecommendation?.prediction || analysisReferencePrediction,
        detailAnalysisReferenceSelection?.source
      );
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
  const rawPrimaryOutcomePrediction = bestOutcomePrediction && isOutcomeTipCode(bestOutcomePrediction.tipCode)
    ? bestOutcomePrediction
    : isOutcomeTipCode(oneXTwoPrediction?.tipCode)
      ? oneXTwoPrediction
      : undefined;
  const handicapOverridePrediction = hasHhadResultPool
    ? getHandicapOverridePrediction(match, rawPrimaryOutcomePrediction)
    : undefined;
  // The list card and detail overview must use one canonical pre-match decision.
  // HAD/HHAD rows below remain independent market analysis and must never replace it.
  const canonicalPreMatchPrediction = canonicalPublishedRecommendation?.prediction
    || archivedPreMatchPrediction
    || analysisReferencePrediction;
  const archivedOutcomeFallback = isResultPhase
    ? handicapOverridePrediction
      || rawPrimaryOutcomePrediction
      || (!hasHadResultPool && hasHhadResultPool ? getHandicapMarketReferencePrediction(match) : undefined)
    : undefined;
  const primaryOutcomePrediction = isPreMatchRecordSettling
    ? undefined
    : primaryPostReviewPrediction
      || canonicalPreMatchPrediction
      || archivedOutcomeFallback;
  const isFormalPrimaryRecommendation = Boolean(
    !isFinished
    && formalPresentationAllowed
    && displayRecommendation?.prediction
    && primaryOutcomePrediction === displayRecommendation.prediction
    && isFormalRecommendationPrediction(match, displayRecommendation.prediction)
  );
  const isLivePrimaryRecommendation = Boolean(
    !hasReviewPredictions
    && hasImmutableLivePublication
    && displayRecommendation?.publicationTrack === 'live'
    && displayRecommendation.prediction
    && primaryOutcomePrediction === displayRecommendation.prediction
  );
  const isInPlayArchivedPrimaryDirection = Boolean(
    isLive
    && archivedPreMatchPrediction
    && primaryOutcomePrediction === archivedPreMatchPrediction
    && !isLivePrimaryRecommendation
  );
  const isArchivedPrimaryDirection = Boolean(
    (isResultPhase || isInPlayArchivedPrimaryDirection)
    && primaryOutcomePrediction
    && !isLivePrimaryRecommendation
  );
  const isArchivedFormalRecommendation = Boolean(
    isArchivedPrimaryDirection && (
      isFormalPostReviewRow(primaryPostReviewRow)
      || (
        isInPlayArchivedPrimaryDirection
        && archivedPreMatchPrediction?.recommendationAction === 'recommend'
      )
    )
  );
  const isArchivedLiveRecommendation = Boolean(
    isArchivedPrimaryDirection && isLivePostReviewRow(primaryPostReviewRow)
  );
  const isArchivedReferenceDirection = Boolean(
    isArchivedPrimaryDirection
    && primaryPostReviewRow
    && !isFormalPostReviewRow(primaryPostReviewRow)
    && !isLivePostReviewRow(primaryPostReviewRow)
  );
  const isAnalysisReferenceDirection = Boolean(
    primaryOutcomePrediction
    && !isFormalPrimaryRecommendation
    && !isLivePrimaryRecommendation
    && !isArchivedPrimaryDirection
    && primaryOutcomePrediction.tipCode !== 'WATCH'
  );
  const isFiveHundredReferenceDirection = Boolean(
    isAnalysisReferenceDirection
    && isFiveHundredMarketReferencePrediction(primaryOutcomePrediction)
  );
  const blockerPrediction = [primaryOutcomePrediction, rawBestOutcomePrediction, rawOneXTwoPrediction]
    .find((prediction) => (prediction?.multiFactorEvidence?.blockers || []).length > 0);
  const publicRecommendationBlockers = [
    ...(!formalPresentationAllowed && match.status === 'SCHEDULED'
      ? [language === 'zh' ? '模型或数据源风险状态暂不可发布' : 'Model or source risk state is not publishable']
      : []),
    ...(blockerPrediction?.multiFactorEvidence?.blockers || [])
      .map((blocker) => publicRecommendationBlockerLabels[blocker]?.[language] || blocker)
  ].slice(0, 4);
  const formalPostReviewRows = postReviewRows.filter((row) => isFormalPostReviewRow(row));
  const formalPostReviewWon = formalPostReviewRows.filter((row) => row.resultStatus === 'WON').length;
  const reviewHitRate = formalPostReviewRows.length > 0
    ? Math.round((formalPostReviewWon / formalPostReviewRows.length) * 100)
    : null;
  const handicapReviewRows = settledPostReviewRows.filter((row) => row.oddsPoolCode === 'HHAD');
  const formalHandicapReviewRow = handicapReviewRows.find((row) => isFormalPostReviewRow(row));
  const referenceHandicapReviewRow = handicapReviewRows.find((row) => !isFormalPostReviewRow(row) && row.resultStatus === 'WON')
    || handicapReviewRows.find((row) => !isFormalPostReviewRow(row));
  const handicapReviewOutcomeLabel = formalHandicapReviewRow
    ? getPostReviewOutcomeLabel(formalHandicapReviewRow, language)
    : referenceHandicapReviewRow
      ? getPostReviewOutcomeLabel(referenceHandicapReviewRow, language)
      : '--';
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
      ? (language === 'zh' ? '近期赛果记录' : 'recent result records')
      : (language === 'zh' ? '已同步赛果记录' : 'synced result records');
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
  const probabilityModel = normalizeProbabilityModel(match.probabilityModel);
  const calculationTrace = probabilityModel?.calculationTrace;
  const probabilityModelForm = probabilityModel?.form;
  const modelHealth = probabilityModel?.modelHealth;
  const modelHealthByMarket = modelHealth?.byMarket || {};
  const calibrationAdjustment = probabilityModel?.calibrationAdjustment;
  const oneXTwoCalibrationAdjustments = calibrationAdjustment?.oneXTwo?.adjustments || [];
  // Keep raw probability diagnostics available in code, but hidden from the public match page.
  const showInternalDiagnostics = false;
  const probabilityModelIsModelOnly = Boolean(
    probabilityModel?.version?.includes('model-only') ||
    (!match.odds && !match.handicapOdds)
  );
  const topModelScore = probabilityModel?.scoreDistribution?.find((score) => (
    Number.isFinite(score.home) && Number.isFinite(score.away)
  ));
  const independentHomeLambda = probabilityModel?.lambdaBlend?.independentHomeLambda;
  const independentAwayLambda = probabilityModel?.lambdaBlend?.independentAwayLambda;
  const modelGoalHome = Number.isFinite(independentHomeLambda)
    ? Number(independentHomeLambda)
    : Number.isFinite(probabilityModel?.lambdaBlend?.marketHomeLambda)
      ? Number(probabilityModel?.lambdaBlend?.marketHomeLambda)
      : null;
  const modelGoalAway = Number.isFinite(independentAwayLambda)
    ? Number(independentAwayLambda)
    : Number.isFinite(probabilityModel?.lambdaBlend?.marketAwayLambda)
      ? Number(probabilityModel?.lambdaBlend?.marketAwayLambda)
      : null;
  const hasModelGoalEstimate = modelGoalHome !== null && modelGoalAway !== null;
  const modelProjectedScoreLabel = topModelScore
    ? `${topModelScore.home}-${topModelScore.away}`
    : hasModelGoalEstimate
      ? `${Math.round(modelGoalHome)}-${Math.round(modelGoalAway)}`
      : '';
  const reviewProjectedScore = parseScoreLabel(postMatchReview?.scoreReview?.projectedScore);
  const hasProjectedScore = Number.isFinite(match.projectedScoreHome) && Number.isFinite(match.projectedScoreAway);
  const archivedScoreFallbackText = isFinished && postMatchReview
    ? (language === 'zh' ? '赛前比分未存档' : 'Score not archived')
    : '--';
  const projectedScoreLabel = hasProjectedScore
    ? `${match.projectedScoreHome}-${match.projectedScoreAway}`
    : reviewProjectedScore
      ? scoreCandidateLabel(reviewProjectedScore)
    : modelProjectedScoreLabel
      ? modelProjectedScoreLabel
      : archivedScoreFallbackText;
  const projectedScoreText = hasProjectedScore
    ? projectedScoreLabel
    : reviewProjectedScore
      ? projectedScoreLabel
    : modelProjectedScoreLabel
      ? projectedScoreLabel
      : archivedScoreFallbackText;
  const actualScoreText = hasScore
    ? (language === 'zh' ? `实际赛果：${officialScoreText}` : `Final score: ${officialScoreText}`)
    : provisionalArchivedOutcome
      ? (language === 'zh'
        ? `外部赛果：${provisionalArchivedOutcome.scoreText}（等待竞彩确认）`
        : `External result: ${provisionalArchivedOutcome.scoreText} (awaiting Sporttery confirmation)`)
      : '';

  const formatProbabilityValue = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return '--';
    return `${Number(value).toFixed(1).replace(/\.0$/, '')}%`;
  };

  const formatGptEvidenceScore = (value: number | null | undefined) => {
    if (!Number.isFinite(value)) return '--';
    const normalized = Number(value) <= 1 ? Number(value) * 100 : Number(value);
    if (normalized < 0 || normalized > 100) return '--';
    return `${normalized.toFixed(0)}/100`;
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
              <span>{displayText(item[language])}</span>
              <strong>{formatProbabilityValue(value)}</strong>
            </div>
            <em style={{ width: `${width}%` }} />
          </div>
        );
      })}
    </div>
  );

  const recommendationActionLabel = (prediction: PredictionDetail | undefined) => {
    if (isPreMatchRecordSettling) return language === 'zh' ? '结算中' : 'Settling';
    if (isPublishedLiveAwaitingSettlement) return language === 'zh' ? '已发布 · 待结算' : 'Published · awaiting settlement';
    if (isArchivedFormalRecommendation) return language === 'zh' ? '正式推荐归档' : 'Formal pick archive';
    if (isArchivedLiveRecommendation) return language === 'zh' ? '实时推荐归档' : 'Live pick archive';
    if (isArchivedReferenceDirection) return language === 'zh' ? '分析参考归档' : 'Analysis reference archive';
    if (isArchivedPrimaryDirection) {
      return isPendingResult && !primaryPostReviewRow
        ? (language === 'zh' ? '赛前推荐归档 · 待官方赛果' : 'Pre-match pick archive · awaiting official result')
        : (language === 'zh' ? '赛前推荐归档' : 'Pre-match pick archive');
    }
    if (!prediction || prediction.tipCode === 'WATCH') return language === 'zh' ? '观察' : 'Watch';
    if (isFormalPrimaryRecommendation) return language === 'zh' ? '正式推荐' : 'Formal pick';
    if (isLivePrimaryRecommendation) {
      return isLive
        ? (language === 'zh' ? '已发布' : 'Published')
        : (language === 'zh' ? '实时推荐' : 'Live pick');
    }
    if (isFiveHundredReferenceDirection) {
      return language === 'zh' ? '市场参考' : 'Market reference';
    }
    return language === 'zh' ? '分析参考' : 'Analysis reference';
  };

  const archiveOutcomeTitle = language === 'zh' ? '赛果归档' : 'Result archive';
  const archiveOutcomeReason = language === 'zh'
    ? `本场已完场，最终比分 ${postMatchReview?.finalScore || officialScoreText}。系统没有保存到可用的赛前方向快照，所以只展示赛果归档，不在赛后补造方向。`
    : `This match is finished with final score ${postMatchReview?.finalScore || officialScoreText}. No usable pre-match direction snapshot was archived, so only the result archive is shown.`;
  const settlingOutcomeReason = language === 'zh'
    ? '赛前记录已经锁定，当前只等待不可变归档完成结算；不会使用赛后盘口生成临时方向。'
    : 'The pre-match record is locked and waiting for immutable archive settlement; no post-match market data is used to generate a temporary direction.';
  const publishedLiveSettlementReason = language === 'zh'
    ? '这条实时推荐已在赛前发布并锁定，当前按原方向与发布时 SP 等待官方赛果结算；不会使用赛中或赛后盘口改写。'
    : 'This live pick was published and locked before kickoff. It awaits settlement using the original direction and published SP; in-play or post-match markets cannot rewrite it.';
  const archivedPreMatchSettlementReason = language === 'zh'
    ? '这是截止前已冻结的原赛前方向；当前只等待官方赛果结算，方向、盘口和 SP 均不会在赛后改写，也不在官方确认前计入正式命中率。'
    : 'This is the original pre-match direction frozen before cutoff. It only awaits official settlement; direction, line, and SP cannot be rewritten after kickoff and it stays outside the formal hit rate until official confirmation.';
  const primaryOutcomeTitle = isPreMatchRecordSettling
    ? (language === 'zh' ? '赛前记录结算中' : 'Pre-match record settling')
    : isPredictionArchiveOnly
    ? archiveOutcomeTitle
    : primaryPostReviewRow?.tipLabel?.[language]
    || displayRecommendation?.label || (primaryOutcomePrediction
    ? getPredictionTipDisplay(primaryOutcomePrediction, language)
    : '--');
  const primaryOutcomeCode = isOutcomeTipCode(primaryOutcomePrediction?.tipCode) ? primaryOutcomePrediction.tipCode : undefined;
  // Status is already visible in its own badge; keep the recorded direction intact.
  const primaryOutcomeDisplayTitle = language === 'zh'
    ? primaryOutcomeTitle.replace(/^(?:(?:参考推荐|动态证据参考|分析参考)\s+)+/, '')
    : primaryOutcomeTitle;
  const primaryOutcomeIsHandicap = primaryOutcomePrediction?.oddsPoolCode === 'HHAD';
  const scoreBindingOutcomeCode = useUnified ? unifiedRow?.decision.tipCode : primaryOutcomeIsHandicap ? undefined : primaryOutcomeCode;
  const scoreDistributionRows = Array.isArray(probabilityModel?.scoreDistribution)
    ? probabilityModel.scoreDistribution
    : [];
  const scoreDistributionCandidates: ScoreRecommendationCandidate[] = scoreDistributionRows.map((score) => ({
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
  const predictionVersionText = predictionMeta?.strategyVersion
    || predictionMeta?.policyVersion
    || predictionMeta?.promptVersion
    || probabilityModel?.version
    || postMatchReview?.version
    || '--';
  const navEvidenceDetail = isFiveHundredReferenceDirection
    ? '--'
    : formatEvidenceScore(primaryOutcomePrediction || primaryPostReviewPrediction);
  const calibratedModelProbability = isFiveHundredReferenceDirection
    ? ''
    : formatCalibratedModelProbability(match, primaryOutcomePrediction);
  const predictionGeneratedAt = (
    isFinished || isPredictionArchiveOnly || isPreMatchRecordSettling || isInPlayArchivedPrimaryDirection
  )
    ? match.archivedPreMatchPrediction?.capturedAt
      || predictionMeta?.generatedAt
      || probabilityModel?.generatedAt
      || gptPrediction?.generatedAt
      || predictionMeta?.updatedAt
    : predictionMeta?.generatedAt
    || probabilityModel?.generatedAt
    || gptPrediction?.generatedAt
    || predictionMeta?.updatedAt;
  const predictionCutoffRaw = (
    isFinished || isPredictionArchiveOnly || isPreMatchRecordSettling || isInPlayArchivedPrimaryDirection
  )
    ? match.archivedPreMatchPrediction?.cutoffTime
      || liveRecommendationCutoffIso(match)
    : liveRecommendationCutoffIso(match);
  const predictionCutoffMs = parsePolicyTimestamp(predictionCutoffRaw);
  const predictionCutoffPassed = predictionCutoffMs !== null && nowMs >= predictionCutoffMs;
  const predictionIsLocked = Boolean(predictionMeta?.lockedAt)
    || predictionLockedByCutoff
    || match.status !== 'SCHEDULED'
    || predictionCutoffPassed;
  const publicRecommendationCopy = buildPublicRecommendationCopy(match, primaryOutcomePrediction, language, {
    pickLabel: primaryOutcomeTitle,
    fallbackReason: isPublishedLiveAwaitingSettlement
      ? publishedLiveSettlementReason
      : isPreMatchRecordSettling
      ? settlingOutcomeReason
      : isPredictionArchiveOnly
      ? archiveOutcomeReason
      : primaryPostReviewRow
      ? (language === 'zh'
        ? `本场赛前归档已按最终赛果 ${postMatchReview?.finalScore || officialScoreText} 自动结算：${getPostReviewOutcomeLabel(primaryPostReviewRow, language)}。`
        : `Settled against final score ${postMatchReview?.finalScore || officialScoreText}: ${getPostReviewOutcomeLabel(primaryPostReviewRow, language)}.`)
      : fiveHundredMarketReference?.prediction.explanation[language]
        || displayRecommendation?.reason,
    isLocked: predictionIsLocked,
    forceReference: !isFormalPrimaryRecommendation
      && !isLivePrimaryRecommendation
      && !isArchivedFormalRecommendation
      && !isArchivedLiveRecommendation
  });
  const primaryOddsLabel = isFiveHundredReferenceDirection && fiveHundredMarketReference
    ? (language === 'zh'
      ? `参考价 ${fiveHundredMarketReference.reference.selectedSourceOdds.toFixed(2)}`
      : `Reference ${fiveHundredMarketReference.reference.selectedSourceOdds.toFixed(2)}`)
    : publicRecommendationCopy.oddsLabel;
  const publicScoreNote = isPreMatchRecordSettling
    ? settlingOutcomeReason
    : language === 'zh'
      ? `比分只作为赛果范围参考，不改变上面的${isFormalPrimaryRecommendation ? '正式推荐' : isLivePrimaryRecommendation || isArchivedLiveRecommendation ? '实时推荐记录' : '分析方向'}。`
      : `Scores are only a result-range reference and do not change the ${isFormalPrimaryRecommendation ? 'formal pick' : isLivePrimaryRecommendation || isArchivedLiveRecommendation ? 'live-pick record' : 'analysis direction'} above.`;

  // 渲染预测详细行
  const externalSignals = match.externalSignals as (Match['externalSignals'] & {
    weather?: WeatherSignal;
    venue?: { name?: string; city?: string; summary?: string | { zh?: string; en?: string } };
  }) | undefined;
  const weatherSignal = externalSignals?.weather;
  const fiveHundredSignal = externalSignals?.fiveHundred;
  const fiveHundredDisplay = buildFiveHundredDisplay(match, language);
  const hasFiniteFiveHundredValue = (value: unknown) => (
    value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  );
  const hasFiveHundredEuropeDetails = [
    fiveHundredSignal?.europeOdds?.currentAverage?.odds1,
    fiveHundredSignal?.europeOdds?.currentAverage?.oddsX,
    fiveHundredSignal?.europeOdds?.currentAverage?.odds2
  ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  const hasFiveHundredAsianDetails = hasFiniteFiveHundredValue(fiveHundredSignal?.asianHandicap?.currentAverageLine);
  const hasFiveHundredFormDetails = Boolean(
    Number(fiveHundredSignal?.recentForm?.home?.sampleSize || 0) > 0
    || Number(fiveHundredSignal?.recentForm?.away?.sampleSize || 0) > 0
  );
  const hasFiveHundredRankDetails = Boolean(
    hasFiniteFiveHundredValue(fiveHundredSignal?.rank?.home?.fifaRank)
    || hasFiniteFiveHundredValue(fiveHundredSignal?.rank?.away?.fifaRank)
  );
  const hasFiveHundredScheduleDetails = Boolean(
    hasFiniteFiveHundredValue(fiveHundredSignal?.futureSchedule?.home?.nextGapDays)
    || hasFiniteFiveHundredValue(fiveHundredSignal?.futureSchedule?.away?.nextGapDays)
  );
  const fiveHundredSourceText = `${fiveHundredSignal?.source || ''} ${externalSignals?.source || ''}`;
  const hasFiveHundredLineupDetails = /500/i.test(fiveHundredSourceText) && Boolean(
    externalSignals?.projectedRoster?.summary?.[language]
    || externalSignals?.projectedRoster?.homeFormation
    || externalSignals?.projectedRoster?.awayFormation
    || externalSignals?.lineups?.summary?.[language]
  );
  const usableFiveHundredPanelKeys = new Set<string>([
    hasFiveHundredEuropeDetails || hasFiveHundredAsianDetails ? 'market' : '',
    hasFiveHundredFormDetails || hasFiveHundredRankDetails ? 'form' : '',
    hasFiveHundredScheduleDetails || hasFiveHundredLineupDetails ? 'lineup' : ''
  ].filter(Boolean));
  const fiveHundredUsablePanels = fiveHundredDisplay.panels.filter((panel) => usableFiveHundredPanelKeys.has(panel.key));
  const hasUsableFiveHundredDetails = fiveHundredDisplay.visible && fiveHundredUsablePanels.length > 0;
  const localizedSignalText = (
    value: string | { zh?: string; en?: string } | undefined | null,
    fallback = ''
  ) => displayText(typeof value === 'string' ? value : value?.[language] || value?.zh || value?.en || fallback);
  const oddsTrendSummaryText = localizedSignalText(match.oddsTrend?.summary);
  const weatherSummary = localizedSignalText(weatherSignal?.summary);
  const weatherImpactText = localizedSignalText(weatherSignal?.impact);
  const venueSummary = localizedSignalText(externalSignals?.venue?.summary);
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
  const worldCupPriorEnabled = Boolean(
    probabilityModel?.oneXTwo?.worldCupPrior
    && Number.isFinite(worldCupPriorWeight)
    && Number(worldCupPriorWeight) > 0
  );
  const predictionDataPolicyCopy = language === 'zh'
    ? `赛前独立模型使用 Elo、长期历史、近期状态、赛程密度和比分分布${worldCupPriorEnabled ? '，并使用已通过安全校验的世界杯先验' : '；世界杯先验仅在安全校验通过时启用，本场未启用'}。官方 HAD/HHAD SP 只用于市场与价值风险校验；截止后只结算赛果，不回写赛前方向。`
    : `The pre-match model uses Elo, long-run history, recent form, schedule density, and score distributions${worldCupPriorEnabled ? ', plus a safety-validated World Cup prior' : '; World Cup priors are enabled only after safety validation and are disabled for this match'}. Official HAD/HHAD SP only validates market and value risk; after cutoff, settlement is added without rewriting the pre-match direction.`;
  const worldCupPriorStrengthDiff = Number(worldCupPrior?.strengthDiff);
  const worldCupPriorHomeName = language === 'zh'
    ? worldCupPrior?.home?.nameZh || worldCupPrior?.home?.nameEn
    : worldCupPrior?.home?.nameEn || worldCupPrior?.home?.nameZh;
  const worldCupPriorAwayName = language === 'zh'
    ? worldCupPrior?.away?.nameZh || worldCupPrior?.away?.nameEn
    : worldCupPrior?.away?.nameEn || worldCupPrior?.away?.nameZh;
  const weatherSourceLabel = weatherStatusDetail;
  const weatherImpactLabel = weatherVerified
    ? (weatherVenueConfirmed
      ? (language === 'zh' ? '已进入赛前信息层' : 'Included in pre-match signal layer')
      : (language === 'zh' ? '已接入，场地待确认' : 'Loaded, venue needs confirmation'))
    : (language === 'zh' ? '未验证，不参与概率加权' : 'Unverified, not weighted in probabilities');
  const weatherMetrics = [
    {
      label: language === 'zh' ? '数据状态' : 'Data status',
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
  const disciplineSignal = contextSignals?.discipline
    || (match.stats?.discipline?.source ? match.stats.discipline : undefined);
  const dataGapSignal = contextSignals?.dataGaps || match.stats?.dataGaps;
  const preMatchQuality = externalSignals?.preMatch?.quality || dataGapSignal?.preMatchQuality || null;
  const modelEstimateQualityLabel = language === 'zh' ? '模型估计' : 'Model estimate';
  const modelEstimateRows: ModelEstimateRow[] = hasModelGoalEstimate && probabilityModel?.version
    ? [{
      key: 'goal-lambda',
      label: language === 'zh' ? '模型进球期望（λ）' : 'Model goal expectation (λ)',
      home: Number(modelGoalHome),
      away: Number(modelGoalAway),
      unit: '',
      source: probabilityModel.version,
      quality: modelEstimateQualityLabel
    }]
    : [];
  const modelEstimateGeneratedAt = probabilityModel?.generatedAt || predictionMeta?.generatedAt || predictionMeta?.updatedAt;
  const modelEstimateAsOf = modelEstimateGeneratedAt && Number.isFinite(Date.parse(modelEstimateGeneratedAt))
    ? new Date(modelEstimateGeneratedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Shanghai'
    })
    : '--';
  const verifiedTeamStatLabels = language === 'zh'
    ? ['控球率', '射门', '射正', '角球', '越位', '犯规', '黄牌', '红牌']
    : ['Possession', 'Shots', 'Shots on target', 'Corners', 'Offsides', 'Fouls', 'Yellow cards', 'Red cards'];
  const observedStatsNotStarted = !isVoid && match.status === 'SCHEDULED'
    && Number.isFinite(Date.parse(match.kickoffTime)) && nowMs < Date.parse(match.kickoffTime);
  const dataGapLabels = ((preMatchQuality?.missing?.length ? preMatchQuality.missing : dataGapSignal?.missing) || [])
    .slice(0, 3)
    .map((item) => localizedSignalText(item))
    .filter(Boolean);
  const notYetPublishableLabels = (preMatchQuality?.notYetPublishable || [])
    .slice(0, 3)
    .map((item) => localizedSignalText(item))
    .filter(Boolean);
  const oddsChangeText = match.oddsTrend
    ? [
      Number.isFinite(match.oddsTrend.odds1Change) ? `${language === 'zh' ? '主' : 'H'} ${Number(match.oddsTrend.odds1Change) > 0 ? '+' : ''}${formatDecimal(match.oddsTrend.odds1Change)}` : '',
      Number.isFinite(match.oddsTrend.oddsXChange) ? `${language === 'zh' ? '平' : 'D'} ${Number(match.oddsTrend.oddsXChange) > 0 ? '+' : ''}${formatDecimal(match.oddsTrend.oddsXChange)}` : '',
      Number.isFinite(match.oddsTrend.odds2Change) ? `${language === 'zh' ? '客' : 'A'} ${Number(match.oddsTrend.odds2Change) > 0 ? '+' : ''}${formatDecimal(match.oddsTrend.odds2Change)}` : ''
    ].filter(Boolean).join(' / ')
    : '';
  const injuryCount = Number(externalSignals?.injuries?.home?.length || 0) + Number(externalSignals?.injuries?.away?.length || 0);
  const lineupQuality = preMatchQuality?.components?.lineup;
  const legacyLineupIsConfirmed = lineupQuality?.confirmed === true
    || ['confirmed-lineup', 'official-starting-xi'].includes(String(lineupQuality?.evidenceType || '').toLowerCase());
  const confirmedLineupSignal = externalSignals?.confirmedLineup
    || (legacyLineupIsConfirmed ? externalSignals?.lineups : undefined);
  const projectedRosterSignal = externalSignals?.projectedRoster
    || (!legacyLineupIsConfirmed ? externalSignals?.lineups : undefined);
  const confirmedLineupSummaryText = localizedSignalText(confirmedLineupSignal?.summary);
  const projectedRosterSummaryText = localizedSignalText(projectedRosterSignal?.summary);
  const injurySummaryText = localizedSignalText(externalSignals?.injuries?.summary);
  const hasAuditableSource = (signal: {
    source?: string;
    sourceObservedAt?: string;
    verified?: boolean;
    usableForPreMatch?: boolean;
  } | null | undefined) => Boolean(
    signal?.verified === true
    && String(signal.source || '').trim()
    && Number.isFinite(Date.parse(String(signal.sourceObservedAt || '')))
    && signal.usableForPreMatch !== false
  );
  const lineupSignalReady = Boolean(
    hasAuditableSource(confirmedLineupSignal)
    && (
      confirmedLineupSummaryText
      || confirmedLineupSignal?.homeFormation
      || confirmedLineupSignal?.awayFormation
    )
  );
  const projectedRosterReady = Boolean(
    String(projectedRosterSignal?.source || '').trim()
    && Number.isFinite(Date.parse(String(projectedRosterSignal?.sourceObservedAt || '')))
    && projectedRosterSignal?.usableForPreMatch !== false
    && (
      projectedRosterSummaryText
      || projectedRosterSignal?.homeFormation
      || projectedRosterSignal?.awayFormation
    )
  );
  const injurySignalReady = Boolean(
    hasAuditableSource(externalSignals?.injuries)
    && (injuryCount > 0 || injurySummaryText)
  );
  const refereeSignalReady = Boolean(
    hasAuditableSource(externalSignals?.referee)
    && (
      Number.isFinite(externalSignals?.referee?.cardsPerMatch)
      || Number.isFinite(externalSignals?.referee?.penaltiesPerMatch)
    )
  );
  const disciplineSignalReady = Boolean(
    disciplineSignal?.source
    && !/model|estimated/i.test(`${disciplineSignal.source} ${disciplineSignal.dataQuality || ''}`)
  );
  const lineupRefereeReadyCount = [lineupSignalReady, injurySignalReady, refereeSignalReady, disciplineSignalReady].filter(Boolean).length;
  const yellowCardsTotal = disciplineSignalReady ? disciplineSignal?.expectedYellowCards?.total : null;
  const refereeText = externalSignals?.referee?.summary?.[language]
    || externalSignals?.referee?.name
    || (language === 'zh' ? '裁判未接入' : 'referee missing');
  const lineupRefereeSummary = [
    lineupSignalReady
      ? confirmedLineupSummaryText || (language === 'zh' ? '官方首发已确认' : 'Official XI confirmed')
      : projectedRosterReady
        ? `${language === 'zh' ? '预计阵容（非首发）' : 'Projected roster (not confirmed)'}：${projectedRosterSummaryText}`
        : lineupQuality?.status === 'not_yet_publishable'
          ? (language === 'zh' ? '正式首发尚未到发布时间，不扣分' : 'Confirmed XI is not published yet; no penalty')
          : '',
    injurySignalReady
      ? (injuryCount > 0
        ? (language === 'zh' ? `伤停 ${injuryCount} 条` : `${injuryCount} injury notes`)
        : injurySummaryText)
      : '',
    refereeText,
    Number.isFinite(yellowCardsTotal)
      ? (language === 'zh' ? `预计黄牌 ${formatDecimal(yellowCardsTotal)}` : `expected yellows ${formatDecimal(yellowCardsTotal)}`)
      : ''
  ].filter(Boolean).slice(0, 3).join('；');
  const xgSignal = externalSignals?.expectedGoals;
  const xgHome = Number.isFinite(xgSignal?.homeXg)
    ? Number(xgSignal?.homeXg)
    : modelGoalHome ?? calculationTrace?.expectedGoals?.values?.finalHome ?? null;
  const xgAway = Number.isFinite(xgSignal?.awayXg)
    ? Number(xgSignal?.awayXg)
    : modelGoalAway ?? calculationTrace?.expectedGoals?.values?.finalAway ?? null;
  const xgaHome = Number.isFinite(xgSignal?.homeXga) ? Number(xgSignal?.homeXga) : null;
  const xgaAway = Number.isFinite(xgSignal?.awayXga) ? Number(xgSignal?.awayXga) : null;
  const xgHasValue = Number.isFinite(xgHome) && Number.isFinite(xgAway);
  const verifiedXgReady = Boolean(
    hasAuditableSource(xgSignal)
    && Number.isFinite(xgSignal?.homeXg)
    && Number.isFinite(xgSignal?.awayXg)
  );
  const xgBody = verifiedXgReady && xgSignal?.summary?.[language]
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
  const publicPreMatchFactCards = [
    {
      title: language === 'zh' ? '盘口变化' : 'Market movement',
      value: match.oddsTrend ? `${match.oddsTrend.sampleSize}次快照` : (language === 'zh' ? '待观察' : 'Pending'),
      tone: match.oddsTrend?.direction === 'mixed' ? 'warning' : match.oddsTrend ? 'success' : 'neutral',
      body: match.oddsTrend
        ? `${oddsTrendSummaryText || (language === 'zh' ? '已记录赔率快照，走势摘要待生成。' : 'Odds snapshots recorded; movement summary pending.')}${oddsChangeText ? `（${oddsChangeText}）` : ''}`
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
        lineupSignalReady ? (language === 'zh' ? '确认首发' : 'confirmed XI') : '',
        projectedRosterReady && !lineupSignalReady ? (language === 'zh' ? '预计阵容' : 'projected roster') : '',
        injurySignalReady ? (language === 'zh' ? '伤停' : 'injuries') : '',
        refereeSignalReady ? (language === 'zh' ? '裁判' : 'referee') : '',
        disciplineSignalReady ? (language === 'zh' ? '牌数' : 'cards') : ''
      ].filter(Boolean)
    },
    {
      title: language === 'zh' ? '进球质量' : 'Goal quality',
      value: xgHasValue ? `${formatDecimal(xgHome)} : ${formatDecimal(xgAway)}` : '--',
      tone: verifiedXgReady ? 'success' : xgHasValue ? 'warning' : 'neutral',
      body: xgBody,
      tags: [
        verifiedXgReady
          ? (language === 'zh' ? '已验证外部数据' : 'verified external data')
          : (language === 'zh' ? '赛前估计' : 'pre-match estimate'),
        probabilityModel?.lambdaBlend ? (language === 'zh' ? '进球区间' : 'goal range') : ''
      ].filter(Boolean)
    },
    {
      title: language === 'zh' ? '数据缺口' : 'Data gaps',
      value: dataGapLabels.length
        ? (language === 'zh' ? `${dataGapLabels.length} 项主要缺口` : `${dataGapLabels.length} primary gaps`)
        : (language === 'zh' ? '无明确高权重缺口' : 'No high-weight gap'),
      tone: (preMatchQuality?.sourceQuality || dataGapSignal?.sourceQuality) === 'low' ? 'danger' : (preMatchQuality || dataGapSignal) ? 'warning' : 'neutral',
      body: dataGapLabels.length
        ? (language === 'zh'
          ? `质量${preMatchQuality?.sourceQuality || dataGapSignal?.sourceQuality || '--'}；主要缺口：${dataGapLabels.join('、')}。缺口越多，方向越难通过正式推荐门槛。`
          : `Quality ${preMatchQuality?.sourceQuality || dataGapSignal?.sourceQuality || '--'}; main gaps: ${dataGapLabels.join(', ')}. More gaps make downgrade more likely.`)
        : notYetPublishableLabels.length
          ? (language === 'zh'
            ? `暂无明确高权重缺口；${notYetPublishableLabels.join('、')}，这些项目尚未到正常发布时间，不降低当前置信度。`
            : `No high-weight gap; ${notYetPublishableLabels.join(', ')} are not normally published yet and do not reduce confidence.`)
          : (preMatchQuality?.summary?.[language] || (language === 'zh' ? '暂无明确高权重缺口。' : 'No high-weight gap detected.')),
      tags: dataGapLabels.length ? dataGapLabels.slice(0, 3) : notYetPublishableLabels.slice(0, 3)
    }
  ];
  const factorCards = [
    {
      title: language === 'zh' ? '官方赔率 / 让球' : 'Official odds / handicap',
      value: poolRows.filter((row) => row.odds).length ? `${poolRows.filter((row) => row.odds).length}/${poolRows.length}` : '--',
      tone: poolRows.some((row) => row.odds) ? 'success' : 'warning',
      body: language === 'zh'
        ? '胜平负与让球赔率用于确认方向是否合理，任何单一赔率都不能直接生成正式推荐。'
        : '1X2 and handicap odds validate the direction; no single price can create a formal pick by itself.'
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
      value: probabilityModelForm ? `${formatDecimal(probabilityModelForm.home?.goalsForAvg)} / ${formatDecimal(probabilityModelForm.away?.goalsForAvg)}` : '--',
      tone: probabilityModelForm ? 'success' : 'neutral',
      body: language === 'zh'
        ? '近一年攻防表现用于修正进球倾向，帮助判断比分区间是否支持当前分析方向。'
        : 'Last-year attacking and defensive form adjusts the goal range and checks whether the score profile supports the analysis direction.'
    },
    {
      title: language === 'zh' ? '阵容信息' : 'Lineups',
      value: lineupSignalReady
        ? (language === 'zh' ? '官方确认' : 'Confirmed')
        : projectedRosterReady
          ? (language === 'zh' ? '预计阵容' : 'Projected')
          : lineupQuality?.status === 'not_yet_publishable'
            ? (language === 'zh' ? '尚未发布' : 'Not published yet')
            : '--',
      tone: lineupSignalReady ? 'success' : projectedRosterReady ? 'warning' : 'neutral',
      body: confirmedLineupSummaryText
        || projectedRosterSummaryText
        || localizedSignalText(lineupQuality?.note)
        || (language === 'zh' ? '正式首发尚未到发布时间时不算数据缺口；截止后首发只展示，不修改正式推荐。' : 'A confirmed XI is not a data gap before its publication window; post-cutoff lineups are display-only and cannot change the formal pick.')
    },
    ...(hasUsableFiveHundredDetails ? [{
      title: language === 'zh' ? '赛前资料' : 'Pre-match data',
      value: fiveHundredDisplay.summaryLabel,
      tone: fiveHundredDisplay.tone,
      body: fiveHundredDisplay.summaryBody
        || (language === 'zh' ? '参考赔率、亚洲盘、近况和阵容用于赛前校验，不单独生成正式推荐。' : 'Reference odds, Asian lines, form, and projected XI validate the pre-match read; they do not create formal picks alone.')
    }] : []),
    {
      title: language === 'zh' ? '外部均赔' : 'External odds',
      value: fiveHundredSignal?.europeOdds?.companies ? `${fiveHundredSignal.europeOdds.companies}` : '--',
      tone: fiveHundredSignal?.europeOdds?.companies ? 'success' : 'neutral',
      body: fiveHundredSignal?.europeOdds?.summary
        || externalSignals?.externalOdds?.summary?.[language]
        || (language === 'zh' ? '外部均赔用于交叉验证官方赔率是否异常，不单独生成正式推荐。' : 'External average odds cross-check official odds; they do not create formal picks alone.')
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
              {displayText(trace.policy?.[language] || (language === 'zh'
                ? '先计算独立模型概率，再做风险校准；SP 只做市场校验。'
                : 'Compute independent model probabilities first, then calibrate risk; SP is validation only.'))}
            </p>
          </div>
          <span>{displayText(trace.version)}</span>
        </div>

        <div className="formula-card-grid">
          <article className="formula-card is-primary">
            <span>{language === 'zh' ? '胜平负总公式' : '1X2 formula'}</span>
            <code>{displayText(trace.outcome?.formula?.[language] || 'P_final=calibrate(normalize(sum(w_i*P_i)))')}</code>
            <p>
              {language === 'zh'
                ? '主胜、平局、客胜分别套用同一条公式，最后归一化并应用冷却/风险校准。'
                : 'Home, draw, and away use the same formula, then normalization and risk calibration are applied.'}
            </p>
          </article>

          <article className="formula-card">
            <span>{language === 'zh' ? '本场代入' : 'This match'}</span>
            <ul className="formula-expression-list">
              <li>{language === 'zh' ? '主胜' : 'Home'}: <strong>{displayText(expressions?.home || '--')}</strong></li>
              <li>{language === 'zh' ? '平局' : 'Draw'}: <strong>{displayText(expressions?.draw || '--')}</strong></li>
              <li>{language === 'zh' ? '客胜' : 'Away'}: <strong>{displayText(expressions?.away || '--')}</strong></li>
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
                  <b>{displayText(component.label?.[language] || component.key)}</b>
                  <strong>{formatModelWeight(component.weight)}</strong>
                  <em>{renderOutcomeLine(component.probabilities)}</em>
                </div>
              ))}
            </div>
          </article>

          <article className="formula-card">
            <span>{language === 'zh' ? '进球期望 lambda' : 'Expected goals lambda'}</span>
            <code>{displayText(trace.expectedGoals?.formula?.[language] || '--')}</code>
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
            <code>{displayText(trace.poisson?.formula?.[language] || '--')}</code>
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
            <code>{displayText(trace.goals?.formula?.[language] || '--')}</code>
            <p>
              {language === 'zh' ? '大2.5' : 'Over2.5'} <strong>{formatProbabilityValue(goalValues?.over25)}</strong>
              {' · BTTS '}
              <strong>{formatProbabilityValue(goalValues?.bttsYes)}</strong>
            </p>
            <p>
              <strong>{displayText(trace.marketUse?.formula || 'marketWeight=0')}</strong>
              {' · '}
              {displayText(trace.marketUse?.[language] || (language === 'zh' ? 'SP 只做校验。' : 'SP is validation only.'))}
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
    <div className="form-summary-card" data-testid="historical-score-summary">
      <h4>
        <span style={{ backgroundColor: teamColor }} />
        {teamName} {language === 'zh' ? '历史赛果统计' : 'Historical result statistics'}
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
        <div className="form-stat-tile" data-stat="goals-for">
          <span>{language === 'zh' ? '场均进球' : 'Goals scored / match'}</span>
          <strong>{summary.sampleSize ? (summary.goalsFor / summary.sampleSize).toFixed(2) : '--'}</strong>
          <em>{summary.sampleSize ? (language === 'zh' ? `${summary.goalsFor} 球 / ${summary.sampleSize} 场` : `${summary.goalsFor} goals / ${summary.sampleSize} matches`) : (language === 'zh' ? '暂无已完场样本' : 'No finished-match sample')}</em>
        </div>
        <div className="form-stat-tile" data-stat="goals-against">
          <span>{language === 'zh' ? '场均失球' : 'Goals conceded / match'}</span>
          <strong>{summary.sampleSize ? (summary.goalsAgainst / summary.sampleSize).toFixed(2) : '--'}</strong>
          <em>{summary.sampleSize ? (language === 'zh' ? `${summary.goalsAgainst} 球 / ${summary.sampleSize} 场` : `${summary.goalsAgainst} goals / ${summary.sampleSize} matches`) : (language === 'zh' ? '暂无已完场样本' : 'No finished-match sample')}</em>
        </div>
        <div className="form-stat-tile" data-stat="clean-sheets">
          <span>{language === 'zh' ? '零封场次' : 'Clean sheets'}</span>
          <strong>{summary.sampleSize ? summary.cleanSheets : '--'}</strong>
          <em>{summary.sampleSize ? (language === 'zh' ? `${summary.cleanSheets}/${summary.sampleSize} 场未失球` : `${summary.cleanSheets}/${summary.sampleSize} matches without conceding`) : (language === 'zh' ? '暂无已完场样本' : 'No finished-match sample')}</em>
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
    <div className="match-detail-shell match-detail-v4">
      <h1 className="sr-only">
        {homeTeam.name[language]} {language === 'zh' ? '对阵' : 'versus'} {awayTeam.name[language]}
      </h1>
      
      {/* 1. 面包屑与返回 */}
      <div className="detail-topbar match-detail-v4__topbar">
        <FollowButton matchId={match.id} decisionId={unifiedRow?.decision.decisionId} />
        <div className="match-detail-v4__breadcrumb">
          {language === 'zh' ? '首页' : 'Home'} / {country.name[language]} / {league.name[language]} / {homeTeam.shortName[language]} vs {awayTeam.shortName[language]}
        </div>
        <button onClick={onBack} className="btn btn-secondary match-detail-v4__back">
          <ArrowLeft size={16} />
          <span>{t('backBtn')}</span>
        </button>
      </div>

      {/* 2. 比赛详情头部看板 */}
      <div className="card match-hero-card match-detail-v4__hero">
        
        {/* 联赛与时间 */}
        <div className="match-detail-v4__hero-meta">
          <span className="match-detail-v4__competition">
            {league.name[language]}
          </span>
          <div className="match-detail-v4__kickoff">
            {formattedDate}
          </div>
          {(match.matchNo || businessDateLabel) && (
            <div className="match-detail-v4__match-meta">
              {match.matchNo ? `${match.matchNo}` : ''}
              {match.matchNo && businessDateLabel ? ' · ' : ''}
              {businessDateLabel ? (language === 'zh' ? `竞彩日 ${businessDateLabel}` : `Match day ${businessDateLabel}`) : ''}
            </div>
          )}
        </div>

        {/* 球队比分对阵大面板 */}
        <div className="matchup-board match-detail-v4__matchup">
          {/* 主队 */}
          <div className="matchup-team match-detail-v4__team">
            <TeamBadge team={homeTeam} size="lg" />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', fontFamily: 'var(--font-title)' }}>
              {homeTeam.name[language]}
            </h3>
            {homeValueText && <span className="match-team-value">{homeValueText}</span>}
          </div>

          {/* 比分 / 状态 */}
          <div className="matchup-status match-detail-v4__status">
            {isVoid ? (
              <div>
                <div style={{ fontSize: '2.25rem', fontWeight: '800', color: 'hsl(var(--text-secondary))', fontFamily: 'var(--font-title)' }}>
                  VOID
                </div>
                <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                  {language === 'zh' ? '已取消 / 退款' : 'Void / refunded'}
                </span>
              </div>
            ) : isFinished ? (
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
                  {provisionalArchivedOutcome?.scoreText || 'VS'}
                </div>
                <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                  {provisionalArchivedOutcome
                    ? (language === 'zh' ? '外部赛果 · 待竞彩确认' : 'External result · awaiting Sporttery')
                    : (language === 'zh' ? '等待官方赛果' : 'Awaiting official result')}
                </span>
              </div>
            ) : isScheduledStatusSyncing ? (
              <div data-detail-status="syncing">
                <div style={{ fontSize: '2.25rem', fontWeight: '800', color: 'hsl(var(--text-secondary))', fontFamily: 'var(--font-title)' }}>
                  VS
                </div>
                <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                  {language === 'zh' ? '比赛状态同步中' : 'Match status syncing'}
                </span>
              </div>
            ) : isPastScheduled ? (
              <div>
                <div style={{ fontSize: '2.25rem', fontWeight: '800', color: 'hsl(var(--text-secondary))', fontFamily: 'var(--font-title)' }}>
                  VS
                </div>
                <span className="badge" style={{ backgroundColor: 'hsl(var(--border))', color: 'hsl(var(--text-secondary))' }}>
                  {minutesSinceKickoff(match, nowMs) >= 130
                    ? (language === 'zh' ? '等待官方赛果' : 'Awaiting official result')
                    : (language === 'zh' ? '比赛状态待同步' : 'Match status syncing')}
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
                    : minutesSinceKickoff(match, nowMs) >= 130
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
          <div className="matchup-team match-detail-v4__team">
            <TeamBadge team={awayTeam} size="lg" />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', fontFamily: 'var(--font-title)' }}>
              {awayTeam.name[language]}
            </h3>
            {awayValueText && <span className="match-team-value">{awayValueText}</span>}
          </div>

        </div>

      </div>

      {/* 3. 首屏决策驾驶舱：结论先于赔率与证据。兼容短视频导出脚本的既有类名。 */}
      <section className="prediction-view-stack match-detail-v4__cockpit" data-view="summary" data-recommendation-track={useUnified ? 'published-reference' : isPredictionArchiveOnly || isArchivedPrimaryDirection || isArchivedLiveRecommendation ? 'archive' : isFormalPrimaryRecommendation ? 'formal' : isLivePrimaryRecommendation ? 'live' : isAnalysisReferenceDirection || isFiveHundredReferenceDirection ? 'reference' : 'watch'} aria-labelledby="match-detail-decision-heading">
            <h2 id="match-detail-decision-heading" className="sr-only">
              {language === 'zh' ? '本场决策结论' : 'Match decision'}
            </h2>
            {isVoid ? (
              <div className="match-detail-v4__settlement-status" role="status">
                <strong>{language === 'zh' ? '本场推荐作废' : 'Pick voided'}</strong>
                <span>
                  {displayText(language === 'zh'
                    ? `官方取消竞猜${match.voidReason ? `：${match.voidReason}` : ''}；收益按 0 处理，不计入命中率分母。`
                    : `The official market was cancelled${match.voidReason ? `: ${match.voidReason}` : ''}; profit is zero and the row is excluded from hit-rate denominators.`)}
                </span>
              </div>
            ) : !useUnified && isPendingResult && (
              <div className="match-detail-v4__settlement-status" role="status">
                <strong>
                  {provisionalArchivedOutcome
                    ? (language === 'zh'
                      ? `外部赛果 ${provisionalArchivedOutcome.scoreText} · 等待竞彩确认`
                      : `External result ${provisionalArchivedOutcome.scoreText} · awaiting Sporttery`)
                    : (language === 'zh' ? '等待官方赛果' : 'Awaiting Official Result')}
                </strong>
                <span>
                  {provisionalArchivedOutcome
                    ? (language === 'zh'
                      ? `仅进入影子参考统计；当前赛前方向${provisionalArchivedOutcome.resultStatus === 'WON' ? '符合' : '不符合'}该外部赛果，不计入正式命中率。`
                      : `Shadow reference only. The pre-match direction ${provisionalArchivedOutcome.resultStatus === 'WON' ? 'matched' : 'missed'} this external result and remains outside the formal hit rate.`)
                    : (language === 'zh' ? '赛果待确认，赛前记录保持锁定。' : 'Result pending; the pre-match record remains locked.')}
                </span>
              </div>
            )}
            {useUnified ? <div className="card recommendation-overview-card recommendation-outcome-card"><section className="recommendation-overview-panel is-outcome"><PublishedMatchPick row={unifiedRow} language={language} loading={published.loading} failed={published.failed} now={nowMs} /></section></div> : <div className="card recommendation-overview-card recommendation-outcome-card">
              <section className="recommendation-overview-panel is-outcome">
                <small>{language === 'zh' ? '旧版赛前归档' : 'Legacy pre-match archive'}</small>
                <div className="recommendation-overview-head">
                  <span>{isPublishedLiveAwaitingSettlement
                    ? primaryOutcomeIsHandicap
                      ? (language === 'zh' ? '让球已发布推荐 · 待结算' : 'Published Live HHAD Pick · Awaiting Settlement')
                      : (language === 'zh' ? '胜平负已发布推荐 · 待结算' : 'Published Live 1X2 Pick · Awaiting Settlement')
                    : isPreMatchRecordSettling
                    ? (language === 'zh' ? '赛前记录结算中' : 'Pre-match record settling')
                    : isArchivedLiveRecommendation
                    ? (language === 'zh' ? '实时推荐结算归档' : 'Live Pick Settlement Archive')
                    : isArchivedPrimaryDirection || isPredictionArchiveOnly
                    ? (language === 'zh' ? '赛前方向归档' : 'Pre-match Archive')
                    : isFormalPrimaryRecommendation
                      ? primaryOutcomeIsHandicap
                        ? (language === 'zh' ? '让球正式推荐' : 'Formal HHAD Pick')
                        : (language === 'zh' ? '胜平负正式推荐' : 'Formal 1X2 Pick')
                      : isLivePrimaryRecommendation
                        ? primaryOutcomeIsHandicap
                          ? (isLive
                            ? (language === 'zh' ? '让球已发布推荐' : 'Published Live HHAD Pick')
                            : (language === 'zh' ? '让球实时推荐' : 'Live HHAD Pick'))
                          : (isLive
                            ? (language === 'zh' ? '胜平负已发布推荐' : 'Published Live 1X2 Pick')
                            : (language === 'zh' ? '胜平负实时推荐' : 'Live 1X2 Pick'))
                      : isFiveHundredReferenceDirection
                        ? (language === 'zh' ? '市场参考' : 'Market Reference')
                      : isAnalysisReferenceDirection
                        ? primaryOutcomeIsHandicap
                          ? (language === 'zh' ? '让球分析参考' : 'HHAD Analysis Reference')
                          : (language === 'zh' ? '胜平负分析参考' : '1X2 Analysis Reference')
                        : (language === 'zh' ? '赛前观察' : 'Pre-match Watch')}</span>
                  <b>{isPredictionArchiveOnly ? (language === 'zh' ? '归档' : 'Archive') : recommendationActionLabel(primaryOutcomePrediction)}</b>
                </div>
                <strong className="recommendation-overview-main">{primaryOutcomeDisplayTitle}</strong>
                <div className="match-detail-v4__pick-facts" aria-label={language === 'zh' ? '方向与价格' : 'Market and price'}>
                  <div><span>{language === 'zh' ? '分析玩法' : 'Market'}</span><strong>{displayText(publicRecommendationCopy.marketLabel)}</strong></div>
                  <div><span>{language === 'zh' ? '本方向 SP' : 'Direction SP'}</span><strong>{displayText(primaryOddsLabel)}</strong></div>
                </div>
                <p>{displayText(isPublishedLiveAwaitingSettlement
                  ? publishedLiveSettlementReason
                  : isPreMatchRecordSettling
                  ? settlingOutcomeReason
                  : isArchivedPrimaryDirection && !primaryPostReviewRow
                    ? archivedPreMatchSettlementReason
                  : isPredictionArchiveOnly
                    ? archiveOutcomeReason
                    : isFiveHundredReferenceDirection && fiveHundredMarketReference
                      ? fiveHundredMarketReference.prediction.explanation[language]
                    : publicRecommendationCopy.reasons[0] || matchSignal.note[language])}</p>
                {isLivePrimaryRecommendation && primaryOutcomePrediction?.liveRecommendation?.dataCoverageWarning && (
                  <div className="recommendation-mini-tags" aria-label={language === 'zh' ? '数据覆盖提示' : 'Data coverage notice'}>
                    <span>{language === 'zh' ? '辅助数据覆盖偏低' : 'Low auxiliary-data coverage'}</span>
                    <span>{language === 'zh' ? '仅按强市场核心证据发布' : 'Strong market-core evidence only'}</span>
                  </div>
                )}
                {isLivePrimaryRecommendation && (isLive || isPublishedLiveAwaitingSettlement) && (
                  <div className="recommendation-mini-tags" aria-label={language === 'zh' ? '已发布实时推荐状态' : 'Published live-pick status'}>
                    <span>{language === 'zh' ? '不可变发布记录' : 'Immutable publication record'}</span>
                    <span>{isPublishedLiveAwaitingSettlement
                      ? (language === 'zh' ? '等待官方赛果结算' : 'Awaiting official settlement')
                      : (language === 'zh' ? '赛中保持原记录' : 'Original record retained in play')}</span>
                    <span>{language === 'zh' ? '不计入正式推荐命中率' : 'Excluded from formal hit rate'}</span>
                  </div>
                )}
                {isFiveHundredReferenceDirection && fiveHundredMarketReference && (
                  <div className="recommendation-mini-tags" aria-label={language === 'zh' ? '市场参考状态' : 'Market-reference status'}>
                    <span>{language === 'zh' ? '非正式推荐 · 市场参考' : 'Market reference · not a formal pick'}</span>
                    <span>{language === 'zh'
                      ? `去水首位 ${Math.round(fiveHundredMarketReference.reference.leaderProbability * 1000) / 10}%`
                      : `De-vigged leader ${Math.round(fiveHundredMarketReference.reference.leaderProbability * 1000) / 10}%`}</span>
                    <span>{language === 'zh' ? '不计命中率/不进串关' : 'Excluded from hit rate / bet slips'}</span>
                    {fiveHundredMarketReference.reference.handicapRisk && (
                      <span>{displayText(fiveHundredMarketReference.reference.handicapRisk.label[language])}</span>
                    )}
                  </div>
                )}
                {!isPreMatchRecordSettling && !isFormalPrimaryRecommendation && !isLivePrimaryRecommendation && !isArchivedPrimaryDirection && publicRecommendationBlockers.length > 0 && (
                  <div className="recommendation-mini-tags" aria-label={language === 'zh' ? '未通过正式推荐原因' : 'Formal-pick blockers'}>
                    <span>{language === 'zh' ? '未通过正式推荐' : 'Not a formal pick'}</span>
                    {publicRecommendationBlockers.slice(0, 3).map((blocker) => <span key={blocker}>{displayText(blocker)}</span>)}
                  </div>
                )}
                <div className="recommendation-mini-tags">
                  {isPreMatchRecordSettling ? (
                    <>
                      <span>{language === 'zh' ? '赛前记录已锁定' : 'Pre-match record locked'}</span>
                      <span>{language === 'zh' ? '等待归档结算' : 'Awaiting archive settlement'}</span>
                      <span>{language === 'zh' ? '不生成临时方向' : 'No temporary direction'}</span>
                    </>
                  ) : isArchivedPrimaryDirection && !primaryPostReviewRow ? (
                    <>
                      <span>{language === 'zh' ? '赛前原方向已锁定' : 'Original pre-match direction locked'}</span>
                      <span>{language === 'zh' ? '等待官方赛果' : 'Awaiting official result'}</span>
                      <span>{language === 'zh' ? '不计入正式命中率' : 'Excluded from formal hit rate'}</span>
                    </>
                  ) : isPredictionArchiveOnly ? (
                    <>
                      <span>{language === 'zh' ? '赛果归档' : 'Result archive'}</span>
                      <span>{language === 'zh' ? '无赛前快照' : 'No pre-match snapshot'}</span>
                      <span>{officialScoreText}</span>
                    </>
                  ) : (
                    <>
                      <span>{displayText(publicRecommendationCopy.marketLabel)}</span>
                      <span>{displayText(publicRecommendationCopy.strengthLabel)}</span>
                      <span>{displayText(primaryOddsLabel)}</span>
                      <span>{displayText(publicRecommendationCopy.statusLabel)}</span>
                    </>
                  )}
                </div>
                {companionRecommendation && (
                  <div className="recommendation-companion-panel">
                    <span>{displayText(companionRecommendation.title)}</span>
                    <strong>{displayText(companionRecommendation.label)}</strong>
                    <p>{displayText(companionRecommendation.reason)}</p>
                    <em>{displayText(companionRecommendation.meta)}</em>
                  </div>
                )}
              </section>
            </div>

            }
            <div className="card recommendation-score-card">
              <section className="recommendation-overview-panel is-score">
                <div className="recommendation-overview-head">
                  <span>{language === 'zh' ? '比分推演' : 'Score Projection'}</span>
                  <b>{lockedTagText}</b>
                </div>
                <div className="recommendation-score-list">
                  {isPreMatchRecordSettling ? (
                    <div className="recommendation-score-option is-empty">
                      <span>{language === 'zh' ? '赛前记录' : 'Pre-match record'}</span>
                      <strong>--</strong>
                      <em>{language === 'zh' ? '结算完成后展示归档' : 'Archive appears after settlement'}</em>
                    </div>
                  ) : scoreRecommendations.length ? scoreRecommendations.map((score, index) => (
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
                  {isPreMatchRecordSettling ? (
                    <>
                      <span>{language === 'zh' ? '赛前记录结算中' : 'Pre-match record settling'}</span>
                      <span>{language === 'zh' ? '不展示临时方向' : 'No temporary direction shown'}</span>
                    </>
                  ) : (
                    <>
                      <span>{language === 'zh' ? '比分参考' : 'Score reference'}</span>
                      <span>{isFormalPrimaryRecommendation
                        ? (language === 'zh' ? '不改正式推荐' : 'Formal pick unchanged')
                        : (language === 'zh' ? '不改分析方向' : 'Analysis direction unchanged')}</span>
                    </>
                  )}
                </div>
              </section>
            </div>

      </section>

      {/* 4. 单层详情导航 */}
      <div className="tabs-container detail-tabs-nav match-detail-v4__tabs" role="tablist" aria-label={language === 'zh' ? '详情导航' : 'Detail sections'}>
        {detailTabItems.map((item) => (
          <button
            key={item.key}
            id={detailTabId(item.key)}
            type="button"
            role="tab"
            aria-selected={activeTab === item.key}
            aria-controls={detailPanelId}
            tabIndex={activeTab === item.key ? 0 : -1}
            className={`tab-btn ${activeTab === item.key ? 'active' : ''}`}
            onClick={() => setActiveTab(item.key)}
            onKeyDown={(event) => handleRovingTabKeyDown(
              event,
              detailTabOrder,
              item.key,
              setActiveTab,
              detailTabId
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* 5. 当前分区；未激活内容不进入 DOM。 */}
      <div
        id={detailPanelId}
        className="detail-tab-panel match-detail-v4__panel"
        role="tabpanel"
        aria-labelledby={detailTabId(activeTab)}
        tabIndex={0}
      >
        {(activeTab === 'overview' || activeTab === 'evidence') && (
          <PrematchCollectionPanel matchId={match.id} language={language} homeName={homeTeam.name[language]} awayName={awayTeam.name[language]} kickoffTime={match.kickoffTime} />
        )}
        {activeTab === 'overview' && (
          <div className="match-detail-v4__section-stack" data-section="overview">

            {!useUnified && isPredictionArchiveOnly && (
              <div className="card prediction-empty-card">
                <h3>{language === 'zh' ? '本场仅保留赛果归档' : 'Result archive only'}</h3>
                <p>{archiveOutcomeReason}</p>
                <div className="recommendation-mini-tags">
                  <span>{language === 'zh' ? '最终比分' : 'Final score'} {officialScoreText}</span>
                  <span>{language === 'zh' ? '无赛前方向快照' : 'No pre-match direction snapshot'}</span>
                  <span>{language === 'zh' ? '不赛后补推' : 'No post-match backfill'}</span>
                </div>
              </div>
            )}

            {!useUnified && !isPreMatchRecordSettling && (
            <div className="card decision-transparent-card">
              <div className="decision-transparent-head">
                <div>
                  <span className="review-kicker">{isFormalPrimaryRecommendation
                    ? (language === 'zh' ? '正式推荐说明' : 'Formal Pick Notes')
                    : isLivePrimaryRecommendation
                      ? (language === 'zh' ? '实时推荐说明' : 'Live Pick Notes')
                    : isArchivedLiveRecommendation
                      ? (language === 'zh' ? '实时推荐结算说明' : 'Live Pick Settlement Notes')
                    : isArchivedPrimaryDirection
                      ? (language === 'zh' ? '赛前归档说明' : 'Archive Notes')
                      : (language === 'zh' ? '分析参考说明' : 'Analysis Reference Notes')}</span>
                  <h3>{language === 'zh' ? '推荐依据与风险' : 'Recommendation basis & risks'}</h3>
                  {publicRecommendationCopy.reasons.map((reason) => (
                    <p key={reason}>{displayText(reason)}</p>
                  ))}
                  {companionRecommendation && (
                    <p>{displayText(companionRecommendation.reason)}</p>
                  )}
                </div>
                <span className={`decision-pool-pill is-${publicRecommendationCopy.strengthTone}`}>
                  {displayText(publicRecommendationCopy.strengthLabel)}
                </span>
              </div>

              <div className="decision-transparent-grid">
                <section className="decision-transparent-panel">
                  <h4>{language === 'zh' ? (isFormalPrimaryRecommendation || isLivePrimaryRecommendation || isArchivedLiveRecommendation ? '推荐玩法' : '分析玩法') : 'Market'}</h4>
                  <strong>{displayText(publicRecommendationCopy.marketLabel)}</strong>
                  <p>{displayText(primaryOddsLabel)}</p>
                </section>

                <section className="decision-transparent-panel">
                  <h4>{language === 'zh' ? '风险提醒' : 'Risk Notes'}</h4>
                  <strong>{publicRecommendationCopy.risks.join(language === 'zh' ? '、' : ', ')}</strong>
                  <p>{publicRecommendationCopy.updateRule}</p>
                </section>

                {companionRecommendation && (
                  <section className="decision-transparent-panel is-companion">
                    <h4>{getHandicapCompanionHeading(companionRecommendation, language)}</h4>
                    <strong>{displayText(companionRecommendation.title)}</strong>
                    <p>{displayText(companionRecommendation.meta)}</p>
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
            )}

          </div>
        )}

        {activeTab === 'evidence' && (
          <div className="match-detail-v4__section-stack" data-section="evidence">
            {matchesSavedCaptureIdentity(capturedData, match)
              && <CapturedMatchData capture={capturedData} language={language} />}

            <section className="card match-detail-v4__data-analysis" aria-labelledby="match-detail-data-analysis-heading">
              <div className="match-detail-v4__section-head">
                <div>
                  <span className="review-kicker">{language === 'zh' ? '数据与分析' : 'Data & analysis'}</span>
                  <h3 id="match-detail-data-analysis-heading">{useUnified ? (language === 'zh' ? '模型快照与补充资料' : 'Model snapshot and supporting data') : (language === 'zh' ? '推荐生成时的数据与依据' : 'Evidence at the recommendation decision')}</h3>
                </div>
                <span>{useUnified ? (language === 'zh' ? '已发布方向与SP以上方统一记录为准' : 'Published direction and SP follow the record above') : (language === 'zh' ? '保留决策时点，最新补采资料见上方' : 'Decision-time record; latest collected data is shown above')}</span>
              </div>
              <RecommendationEvidenceFacts
                match={match}
                prediction={primaryOutcomePrediction || primaryPostReviewPrediction}
                language={language}
                className="is-detail"
              />
              <p className="match-detail-v4__data-analysis-note">
                {language === 'zh'
                  ? '下面的缺项与分析对应推荐生成时点；后续补到的伤停、阵容在上方单独展示，不会自动改写这里的历史依据。'
                  : 'Gaps and analysis below reflect the decision time. Subsequently collected injuries and lineups are shown above and do not automatically rewrite this record.'}
              </p>
            </section>

            {hasUsableFiveHundredDetails && (
              <div className={`card five-hundred-signal-card is-${fiveHundredDisplay.tone}`}>
                <div className="five-hundred-signal-head">
                  <div>
                    <span className="review-kicker">
                      {language === 'zh' ? '赛前资料' : 'Pre-match data'}
                    </span>
                    <h3>{displayText(fiveHundredDisplay.summaryLabel)}</h3>
                    <p>
                      {language === 'zh'
                        ? '已取得的盘口、参考赔率、近期战绩、排名和预计名单用于赛前校验与风险判断，不会单独覆盖当前分析方向。'
                        : 'Available markets, reference odds, form, ranking, and projected XI support validation and risk assessment without overriding the analysis direction alone.'}
                    </p>
                  </div>
                  <span className={`five-hundred-source-badge is-${fiveHundredDisplay.tone}`}>
                    {displayText(fiveHundredDisplay.badge)}
                  </span>
                </div>

                <div className="five-hundred-signal-grid">
                  {fiveHundredUsablePanels.map((panel) => (
                    <section key={panel.key} className={`five-hundred-signal-panel is-${panel.tone}`}>
                      <span>{displayText(panel.title)}</span>
                      <strong>{displayText(panel.value)}</strong>
                      <p>{displayText(panel.body)}</p>
                      {panel.tags.length > 0 && (
                        <div className="five-hundred-chip-row">
                          {panel.tags.map((tag) => (
                            <b key={`${panel.key}-${tag}`}>{displayText(tag)}</b>
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </div>

                {fiveHundredDisplay.chips.length > 0 && (
                  <div className="five-hundred-chip-row is-summary">
                    {fiveHundredDisplay.chips.slice(0, 8).map((chip) => (
                      <b key={chip}>{displayText(chip)}</b>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="card pre-match-risk-card is-neutral">
              <div className="pre-match-risk-head">
                <div>
                  <span className="review-kicker">
                    {language === 'zh' ? '公开事实' : 'Public facts'}
                  </span>
                  <h3>{language === 'zh' ? '盘口、真实数据与明确模型估计' : 'Markets, verified data, and explicit model estimates'}</h3>
                  <p>
                    {language === 'zh'
                      ? '这里只展示官方赔率走势、已接入的阵容/裁判事实、真实数据缺口和明确标注的进球模型估计；不公开聚合冷门分或战意启发式分数。'
                      : 'Only official odds movement, connected lineup/referee facts, real data gaps, and clearly labeled goal-model estimates are shown. Aggregate upset or motivation heuristic scores stay hidden.'}
                  </p>
                </div>
              </div>

              <div className="pre-match-risk-grid">
                {publicPreMatchFactCards.map((item) => (
                  <section key={item.title} className={`pre-match-risk-panel is-${item.tone}`}>
                    <span>{displayText(item.title)}</span>
                    <strong>{displayText(item.value)}</strong>
                    <p>{displayText(item.body)}</p>
                    {item.tags.length > 0 && (
                      <div className="pre-match-risk-tags">
                        {item.tags.map((tag) => (
                          <b key={tag}>{displayText(tag)}</b>
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </div>

          </div>
        )}

        {activeTab === 'history' && (
          <div className="match-detail-v4__section-stack" data-section="history">
            {useUnified && <div className="card review-card"><h3>{language === 'zh' ? '已发布推荐复盘' : 'Published recommendation review'}</h3><PublishedMatchPick row={unifiedRow} language={language} loading={published.loading} failed={published.failed} now={nowMs} /></div>}
            {!useUnified && isResultPhase && hasReviewPredictions && (
              <div className="card review-card">
                <div className="review-head">
                  <div>
                    <span className="review-kicker">{language === 'zh' ? '赛后复盘' : 'Post-match Review'}</span>
                    <h3>{language === 'zh' ? '赛前方向归档与原因复盘' : 'Pre-match Direction Archive And Review'}</h3>
                    <p>
                      {language === 'zh'
                        ? `基于赛前官方赔率快照保存的方向已按最终比分 ${postMatchReview?.finalScore || officialScoreText} 自动结算，并进入后续优化；归档内容不等同于当前正式推荐。`
                        : `Directions saved from pre-match official odds snapshots have been settled against ${postMatchReview?.finalScore || officialScoreText} and fed into later tuning; archived rows are not current formal picks.`}
                    </p>
                  </div>
                  <div className="review-score">
                    <span>{language === 'zh' ? '正式推荐命中率' : 'Formal-pick hit rate'}</span>
                    <strong>{reviewHitRate === null
                      ? (language === 'zh' ? '无正式推荐' : 'No formal pick')
                      : `${reviewHitRate}%`}</strong>
                  </div>
                </div>
                <div className="review-grid">
                  <div>
                    <span>{language === 'zh' ? '正式推荐结算' : 'Formal picks settled'}</span>
                    <strong>{`${formalPostReviewWon}/${formalPostReviewRows.length}`}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '归档主方向结果' : 'Archived primary direction'}</span>
                    <strong>{primaryPostReviewRow
                      ? getPostReviewOutcomeLabel(primaryPostReviewRow, language)
                      : '--'}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '让球复盘' : 'Handicap review'}</span>
                    <strong>{handicapReviewOutcomeLabel}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '实际赛果' : 'Actual result'}</span>
                    <strong>{localizedSignalText(postMatchReview?.actual?.had?.label, officialScoreText)}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '让球结果' : 'Handicap result'}</span>
                    <strong>{localizedSignalText(postMatchReview?.actual?.hhad?.label, '--')}</strong>
                  </div>
                  <div>
                    <span>{language === 'zh' ? '比分复盘' : 'Score review'}</span>
                    <strong>{postMatchReview?.scoreReview?.exactTop3 ? (language === 'zh' ? 'Top3覆盖' : 'Top3 covered') : postMatchReview?.scoreReview?.projectedScore || '--'}</strong>
                  </div>
                </div>
                {postMatchReview && (
                  <div className="post-review-detail-grid">
                    <section className="post-review-panel">
                      <h4>{language === 'zh' ? '市场结算' : 'Market settlement'}</h4>
                      <div className="post-review-row-list">
                        {settledPostReviewRows.map((row) => (
                          <div
                            key={`${row.marketType}-${row.tipCode}-${row.oddsPoolCode || 'pool'}`}
                            className={`post-review-row${isFormalPostReviewRow(row) ? ` is-${row.resultStatus.toLowerCase()}` : ''}`}
                          >
                            <span>
                              {getPredictionMarketLabel(row as PredictionDetail, language)} · {isFormalPostReviewRow(row)
                                ? (language === 'zh' ? '正式推荐' : 'Formal pick')
                                : isLivePostReviewRow(row)
                                  ? (language === 'zh' ? '实时推荐归档' : 'Live pick archive')
                                  : (language === 'zh' ? '分析参考' : 'Analysis reference')}
                            </span>
                            <strong>{localizedSignalText(row.tipLabel, row.tipCode || '--')}</strong>
                            <em>{getPostReviewOutcomeLabel(row, language)} · {displayText(row.actualLabel?.[language] || row.actualCode || '--')}</em>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section className="post-review-panel">
                      <h4>{language === 'zh' ? '原因复盘' : 'Reason check'}</h4>
                      <div className="post-review-chip-list">
                        {primaryPostReviewMistakeSummary && (
                          <span className="is-mistake-summary">{language === 'zh' ? '未命中与失误定位：' : 'Miss and error diagnosis: '}{displayText(primaryPostReviewMistakeSummary)}</span>
                        )}
                        {postReviewDiagnosis.map((item) => (
                          <span key={item.code}>{displayText(isLivePostReviewRow(primaryPostReviewRow) && item.code === 'best-hit'
                            ? (language === 'zh' ? '实时推荐命中，已进入独立实时推荐样本复盘。' : 'The live pick hit and enters the separate live-pick review track.')
                            : isLivePostReviewRow(primaryPostReviewRow) && item.code === 'best-miss'
                              ? (language === 'zh' ? '实时推荐未中，已进入独立实时推荐样本复盘。' : 'The live pick missed and enters the separate live-pick review track.')
                            : !isFormalPostReviewRow(primaryPostReviewRow) && item.code === 'best-hit'
                            ? (language === 'zh' ? '分析参考主方向符合赛果，作为观察样本进入复盘。' : 'The archived analysis reference matched the result and enters review as an observation sample.')
                            : !isFormalPostReviewRow(primaryPostReviewRow) && item.code === 'best-miss'
                              ? (language === 'zh' ? '分析参考主方向不符合赛果，作为观察样本进入复盘。' : 'The archived analysis reference did not match the result and enters review as an observation sample.')
                              : item[language])}</span>
                        ))}
                      </div>
                    </section>
                    <section className="post-review-panel">
                      <h4>{language === 'zh' ? '下次调整' : 'Next adjustment'}</h4>
                      <div className="post-review-chip-list">
                        {postReviewAdjustments.map((item) => (
                          <span key={item.code}>{displayText(item[language])}</span>
                        ))}
                      </div>
                    </section>
                    <section className="post-review-panel">
                      <h4>{language === 'zh' ? '事件数据' : 'Event data'}</h4>
                      <p>{displayText(postMatchReview.eventFactors?.goals?.summary?.[language] || '--')}</p>
                      <div className="post-review-chip-list is-muted">
                        {postReviewDataGaps.map((item) => (
                          <span key={item.key}>{displayText(item[language])}</span>
                        ))}
                      </div>
                    </section>
                  </div>
                )}
                {oddsTrendSummaryText && (
                  <p className="review-trend">{oddsTrendSummaryText}</p>
                )}
              </div>
            )}

          </div>
        )}

        {activeTab === 'overview' && (
          <div className="match-detail-v4__section-stack" data-section="overview-summary">
            {isResultPhase && (
              <div className="card match-detail-v4__review-bridge">
                <div>
                  <span className="review-kicker">{language === 'zh' ? '赛后复盘' : 'Post-match Review'}</span>
                  <strong>{language === 'zh' ? '赛前结论已锁定，完整结算与历史样本集中在复盘区。' : 'The pre-match conclusion is locked; settlement and historical samples are grouped in the review section.'}</strong>
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => setActiveTab('history')}>
                  {language === 'zh' ? '查看历史与复盘' : 'Open history & review'}
                </button>
              </div>
            )}

            <div className={`card signal-summary-card is-${matchSignal.category} ${isFormalPrimaryRecommendation || isLivePrimaryRecommendation || isArchivedLiveRecommendation ? '' : 'is-reference'}`}>
              <div>
                <span className={`signal-badge is-${matchSignal.category}`}>{displayText(matchSignal.label[language])}</span>
                <h3>{language === 'zh' ? '赛前判断' : 'Pre-Match Read'}</h3>
                <p>{displayText(matchSignal.note[language])}</p>
              </div>
              <div className="signal-summary-meta">
                <span>{language === 'zh' ? '证据评分' : 'Evidence score'} <strong>{navEvidenceDetail}</strong></span>
                {calibratedModelProbability && (
                  <span>{language === 'zh' ? '模型概率' : 'Model probability'} <strong>{calibratedModelProbability}</strong></span>
                )}
                <span>{language === 'zh' ? '风险项' : 'Risks'} <strong>{matchSignal.riskCount}</strong></span>
                {match.oddsTrend && (
                  <span>{language === 'zh' ? '赔率快照' : 'Odds snapshots'} <strong>{match.oddsTrend.sampleSize}</strong></span>
                )}
              </div>
              {oddsTrendSummaryText && (
                <p className="signal-summary-trend">{oddsTrendSummaryText}</p>
              )}
            </div>

            <div className="prediction-policy-note">
              <div>
                <strong>{isFormalPrimaryRecommendation
                  ? predictionIsLocked
                    ? (language === 'zh' ? '正式推荐：已锁定' : 'Formal pick: locked')
                    : (language === 'zh' ? '正式推荐：赛前监控中' : 'Formal pick: monitoring')
                  : isLivePrimaryRecommendation
                    ? isPublishedLiveAwaitingSettlement
                      ? (language === 'zh' ? '已发布实时推荐：待结算' : 'Published live pick: awaiting settlement')
                      : predictionIsLocked
                        ? (language === 'zh' ? '实时推荐：已锁定' : 'Live pick: locked')
                        : (language === 'zh' ? '实时推荐：赛前监控中' : 'Live pick: monitoring')
                  : isArchivedLiveRecommendation
                    ? (language === 'zh' ? '实时推荐：已完成独立结算' : 'Live pick: settled on its separate track')
                  : isArchivedPrimaryDirection
                    ? (language === 'zh' ? '赛前方向：已归档' : 'Pre-match direction: archived')
                    : (language === 'zh' ? '分析状态：仅供观察' : 'Analysis status: observation only')}</strong>
                <span>
                  {displayText(language === 'zh'
                    ? `当前版本：${predictionVersionText} / 生成时间：${formatPolicyTimestamp(predictionGeneratedAt, language)} / 竞彩截止：${formatPolicyTimestamp(predictionCutoffRaw, language)}`
                    : `Version: ${predictionVersionText} / Generated: ${formatPolicyTimestamp(predictionGeneratedAt, language)} / Cutoff: ${formatPolicyTimestamp(predictionCutoffRaw, language)}`)}
                </span>
              </div>
              <p>
                {predictionDataPolicyCopy}
                {predictionMeta?.updateReason && (
                  <em>{displayText(predictionMeta.updateReason[language])}</em>
                )}
              </p>
            </div>

          </div>
        )}

        {activeTab === 'probability' && (
          <div className="match-detail-v4__section-stack" data-section="probability">

            <section className="card match-detail-v4__odds-card" aria-labelledby="match-detail-odds-heading">
              <div className="match-detail-v4__section-head">
                <div>
                  <span className="review-kicker">{language === 'zh' ? '官方市场' : 'Official market'}</span>
                  <h3 id="match-detail-odds-heading">{language === 'zh' ? '胜平负与让球赔率' : '1X2 and handicap odds'}</h3>
                </div>
                <span>{language === 'zh' ? '去水支持率仅用于市场校验' : 'De-vig support is market validation only'}</span>
              </div>
              {poolRows.length > 0 ? (
                <div className="detail-pool-table match-detail-v4__pool-table">
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
                    {language === 'zh' ? '竞彩 SP · HAD / HHAD' : 'Jingcai SP · HAD / HHAD'}
                  </div>
                  {match.oddsTrend && (
                    <div className={`sp-trend-box is-${match.oddsTrend.direction}`}>
                      <strong>{language === 'zh' ? '官方赔率走势' : 'Official Odds Trend'}</strong>
                      <span>{oddsTrendSummaryText || (language === 'zh' ? '已记录赔率快照，走势摘要待生成。' : 'Odds snapshots recorded; movement summary pending.')}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="data-quality-note">
                  {language === 'zh' ? '暂无可用的官方竞彩赔率。' : 'No official Sporttery odds are available.'}
                </div>
              )}
            </section>

            {showInternalDiagnostics && gptParsed && (
              <div className="card probability-model-card">
                <div className="probability-model-head">
                  <div>
                    <span className="review-kicker">
                      {language === 'zh' ? 'AI 增强分析' : 'AI Enhanced Read'}
                    </span>
                    <h3>{language === 'zh' ? '赛前文字研判' : 'Pre-Match Analyst Note'}</h3>
                    <p>{displayText(gptParsed.summary || (language === 'zh' ? '已生成赛前分析。' : 'Pre-match analysis generated.'))}</p>
                  </div>
                  <span>{displayText(gptPrediction?.relay?.model || 'GPT')}</span>
                </div>

                <div className="probability-model-grid">
                  <section className="probability-panel">
                    <h4>{language === 'zh' ? '分析方向' : 'Analysis direction'}</h4>
                    <div className="probability-pair-grid">
                      <span>
                        {language === 'zh' ? '市场' : 'Market'}
                        <strong>{gptRecommendation?.market || '--'}</strong>
                      </span>
                      <span>
                        {language === 'zh' ? '方向' : 'Direction'}
                        <strong>{displayText(gptRecommendation?.pick || '--')}</strong>
                      </span>
                      <span>
                        {language === 'zh' ? 'AI 自评证据分' : 'AI self-rated evidence'}
                        <strong>{formatGptEvidenceScore(gptRecommendation?.confidence)}</strong>
                      </span>
                      <span>
                        {language === 'zh' ? '风险' : 'Risk'}
                        <strong>{displayText(gptRecommendation?.risk || '--')}</strong>
                      </span>
                    </div>
                  </section>

                  <section className="probability-panel is-wide">
                    <h4>{language === 'zh' ? '分析依据' : 'Reasons'}</h4>
                    <ul className="prediction-analysis-list">
                      {(gptParsed.reasons || []).slice(0, 6).map((reason, index) => (
                        <li key={`gpt-reason-${index}`}>{displayText(reason)}</li>
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
                          <li key={`gpt-missing-${index}`}>{displayText(item)}</li>
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
                    <p>{displayText(probabilityModel.basis[language])}</p>
                  </div>
                  <span>{displayText(probabilityModel.version)}</span>
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
                      {worldCupPriorEnabled && probabilityModel.oneXTwo.worldCupPrior && (
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
                            ? `独立强度 ${formatModelWeight(probabilityModel.ensembleWeights.teamStrength)} / Elo ${formatModelWeight(probabilityModel.ensembleWeights.elo)} / Poisson ${formatModelWeight(probabilityModel.ensembleWeights.poisson)}${worldCupPriorEnabled ? ` / 世界杯先验 ${formatModelWeight(probabilityModel.ensembleWeights.worldCupPrior)}` : ''} / SP校验 ${formatModelWeight(probabilityModel.ensembleWeights.market)}`
                            : `team strength ${formatModelWeight(probabilityModel.ensembleWeights.teamStrength)} / Elo ${formatModelWeight(probabilityModel.ensembleWeights.elo)} / Poisson ${formatModelWeight(probabilityModel.ensembleWeights.poisson)}${worldCupPriorEnabled ? ` / World Cup prior ${formatModelWeight(probabilityModel.ensembleWeights.worldCupPrior)}` : ''} / SP validation ${formatModelWeight(probabilityModel.ensembleWeights.market)}`}
                        </span>
                      )}
                      {probabilityModel.dynamicCalibration && (
                        <span className="probability-weight-line">
                          {language === 'zh' ? '动态校准' : 'Dynamic calibration'}：
                          {displayText(calibrationReasonLabels[probabilityModel.dynamicCalibration.gate?.reason || 'neutral-profile']?.[language] || probabilityModel.dynamicCalibration.gate?.reason || '--')}
                        </span>
                      )}
                    </div>
                  </section>

                  {renderCalculationFormulaPanel()}

                  <section className="probability-panel">
                    <h4>{language === 'zh' ? '比分分布' : 'Score Distribution'}</h4>
                    <div className="score-probability-list">
                      {scoreDistributionRows.slice(0, 5).map((scoreItem) => (
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
                      <span>{language === 'zh' ? '大 2.5' : 'Over 2.5'} <strong>{formatProbabilityValue(probabilityModel.goalLines?.over25)}</strong></span>
                      <span>{language === 'zh' ? '小 2.5' : 'Under 2.5'} <strong>{formatProbabilityValue(probabilityModel.goalLines?.under25)}</strong></span>
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
                          <strong>{probabilityModel.form?.home?.sampleSize || 0} / {probabilityModel.form?.away?.sampleSize || 0}</strong>
                        </span>
                      </div>
                    )}
                    {modelHealth && (
                      <div className="probability-pair-grid" style={{ marginBottom: '0.75rem' }}>
                        {(['1X2', 'GOALS', 'BEST'] as const).map((marketKey) => {
                          const bucket = modelHealthByMarket[marketKey];
                          return (
                            <span key={marketKey}>
                              {marketKey}
                              <strong>{formatHealthRate(bucket?.hitRate)}</strong>
                              <em>{bucket?.settled || 0} {language === 'zh' ? '条' : 'settled'}</em>
                            </span>
                          );
                        })}
                        {modelHealth.homeFavorite && (
                          <span>
                            {language === 'zh' ? '主胜桶' : 'Home bucket'}
                            <strong>{formatHealthRate(modelHealth.homeFavorite.hitRate)}</strong>
                            <em>{modelHealth.homeFavorite.settled || 0} {language === 'zh' ? '条' : 'settled'}</em>
                          </span>
                        )}
                        {modelHealth.lowSpSide && (
                          <span>
                            {language === 'zh' ? '低赔边' : 'Low-SP side'}
                            <strong>{formatHealthRate(modelHealth.lowSpSide.hitRate)}</strong>
                            <em>{modelHealth.lowSpSide.settled || 0} {language === 'zh' ? '条' : 'settled'}</em>
                          </span>
                        )}
                        {(modelHealthByMarket['1X2']?.cooldown || modelHealthByMarket.GOALS?.cooldown) && (
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
                          <em>{displayText(probabilityModel.dynamicCalibration.version)}</em>
                        </span>
                        <span>
                          {language === 'zh' ? '胜平负命中' : '1X2 hit'}
                          <strong>{formatHealthRate(probabilityModel.dynamicCalibration.metrics?.oneXTwoHitRate)}</strong>
                          <em>Brier {probabilityModel.dynamicCalibration.metrics?.oneXTwoBrier ?? '--'}</em>
                        </span>
                        <span>
                          {language === 'zh' ? '证据分调整' : 'Evidence-score brake'}
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
                    {(calibrationAdjustment?.oneXTwo?.applied || calibrationAdjustment?.goals?.applied) && (
                      <div className="probability-pair-grid" style={{ marginBottom: '0.75rem' }}>
                        {calibrationAdjustment?.oneXTwo?.applied && (
                          <span>
                            {language === 'zh' ? '胜平负校准' : '1X2 calibration'}
                            <strong>{language === 'zh' ? '已降温' : 'Active'}</strong>
                            <em>{oneXTwoCalibrationAdjustments.length} {language === 'zh' ? '项' : 'rules'}</em>
                          </span>
                        )}
                        {calibrationAdjustment?.goals?.applied && (
                          <span>
                            {language === 'zh' ? '进球校准' : 'Goals calibration'}
                            <strong>{formatModelWeight(calibrationAdjustment.goals?.shrinkFactor)}</strong>
                            <em>{calibrationAdjustment.goals?.before?.over25 ?? '--'}% {'to'} {calibrationAdjustment.goals?.after?.over25 ?? '--'}%</em>
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
                  {language === 'zh'
                    ? `概率先由独立强度、Elo、Poisson${worldCupPriorEnabled ? '和已通过安全校验的世界杯先验' : ''}生成，再按滚动表现做风险校准；SP 只参与市场分歧校验。`
                    : `Probabilities are generated from independent strength, Elo, Poisson${worldCupPriorEnabled ? ', and a safety-validated World Cup prior' : ''}, then risk-calibrated on rolling results; SP is market-divergence validation only.`}
                </p>
              </div>
            )}

          </div>
        )}

        {activeTab === 'evidence' && (
          <div className="match-detail-v4__section-stack" data-section="evidence-analysis">

            <div className="card factor-analysis-card">
              <div className="factor-analysis-head">
                <div>
                  <span className="review-kicker">
                    {language === 'zh' ? '影响因素拆解' : 'Factor breakdown'}
                  </span>
                  <h3>{language === 'zh'
                    ? (isFormalPrimaryRecommendation ? '这场正式推荐主要看什么' : isLivePrimaryRecommendation || isArchivedLiveRecommendation ? '这场实时推荐主要看什么' : '这场分析方向主要看什么')
                    : (isFormalPrimaryRecommendation ? 'What this formal pick is based on' : isLivePrimaryRecommendation || isArchivedLiveRecommendation ? 'What this live pick is based on' : 'What this analysis direction is based on')}</h3>
                  <p>
                    {language === 'zh'
                      ? '方向判断不是单点结论，会综合长期强弱、近况、进球区间、世界杯背景和可验证赛前信息，再用官方赔率与外部均赔做交叉确认；只有完整通过门槛才会标为正式推荐。'
                      : 'The direction is not based on a single signal: it combines long-run strength, form, goal range, World Cup context, and verified pre-match information, then checks official and external odds; only the full gate can promote it to a formal pick.'}
                  </p>
                </div>
              </div>
              <div className="factor-card-grid">
                {factorCards.map((item) => (
                  <div key={item.title} className={`factor-card is-${item.tone}`}>
                    <span>{displayText(item.title)}</span>
                    <strong>{displayText(item.value)}</strong>
                    <p>{displayText(item.body)}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className={`card insight-card is-${matchInsight.tone}`}>
              <div className="insight-head">
                <div>
                  <span className={`insight-action is-${matchInsight.tone}`}>{localizedSignalText(matchInsight.action, '--')}</span>
                  <h3>{localizedSignalText(matchInsight.title, '--')}</h3>
                  <p>{localizedSignalText(matchInsight.summary, '--')}</p>
                </div>
                <div className="insight-score">
                  <span>{language === 'zh' ? '综合评分' : 'Score'}</span>
                  <strong>{matchInsight.score === null ? '--' : matchInsight.score}</strong>
                </div>
              </div>

              <div className="insight-metric-grid">
                {matchInsight.metrics.map((metric, metricIndex) => (
                  <div key={`${localizedSignalText(metric?.label, 'metric')}-${metricIndex}`} className={`insight-metric is-${metric.tone}`}>
                    <span>{localizedSignalText(metric?.label, '--')}</span>
                    <strong>{localizedSignalText(metric?.value, '--')}</strong>
                  </div>
                ))}
              </div>

              <div className="insight-section-grid">
                <div>
                  <h4>{language === 'zh' ? '支撑因素' : 'Drivers'}</h4>
                  <div className="insight-point-list">
                    {matchInsight.drivers.map((point, pointIndex) => (
                      <div key={`${localizedSignalText(point?.title, 'driver')}-${pointIndex}`} className={`insight-point is-${point.tone}`}>
                        <strong>{localizedSignalText(point?.title, '--')}</strong>
                        <p>{localizedSignalText(point?.body, '--')}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h4>{language === 'zh' ? '观察风险' : 'Watchpoints'}</h4>
                  <div className="insight-point-list">
                    {matchInsight.watchpoints.map((point, pointIndex) => (
                      <div key={`${localizedSignalText(point?.title, 'watchpoint')}-${pointIndex}`} className={`insight-point is-${point.tone}`}>
                        <strong>{localizedSignalText(point?.title, '--')}</strong>
                        <p>{localizedSignalText(point?.body, '--')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <details className="match-detail-v4__framework-details">
              <summary>{language === 'zh' ? '展开 12 项专业分析框架' : 'Open the 12-point analysis framework'}</summary>
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
                <span>{displayText(predictionMeta?.promptVersion || 'professional-football-analyst-v1')}</span>
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
                {matchInsight.framework.map((point, pointIndex) => (
                  <div key={`${localizedSignalText(point?.title, 'framework')}-${pointIndex}`} className={`professional-framework-item is-${point.tone}`}>
                    <strong>{localizedSignalText(point?.title, '--')}</strong>
                    <p>{localizedSignalText(point?.body, '--')}</p>
                  </div>
                ))}
              </div>
              </div>
            </details>

            {weatherVerified && (
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
                        ? '当前赛程没有可验证的实时天气/场地字段，所以天气不会单独改动分析方向。页面保留这个模块，是为了明确哪些因素暂未进入判断。'
                        : 'No verified live weather or pitch field is available for this fixture, so weather does not change the analysis direction by itself. This module makes missing factors explicit.')}
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
                    <strong>{displayText(item.value)}</strong>
                  </div>
                ))}
              </div>

              <div className="weather-rule-grid">
                <section>
                  <h4>{language === 'zh' ? '当前处理' : 'Current handling'}</h4>
                  <p>
                    {weatherVerified
                      ? (language === 'zh'
                        ? '天气只进入风险层：恶劣天气会压低进球信心、提高让球不确定性；不会单独推翻当前分析方向。'
                        : 'Weather only enters the risk layer: severe weather lowers goal confidence and increases handicap uncertainty, but does not override the current analysis direction by itself.')
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
                    {displayText(venueSummary
                      || externalSignals?.venue?.name
                      || (language === 'zh'
                        ? '暂无可验证场地/草皮信息，暂不参与加权。'
                        : 'No verified venue or pitch data yet, so no pitch weighting is applied.'))}
                  </p>
                </section>
              </div>
            </div>
            )}

          </div>
        )}

        {activeTab === 'probability' && (
          <div className="match-detail-v4__section-stack" data-section="score-projection">

            {hasPredictionContent && !isPreMatchRecordSettling && (
              <div className="card score-projection-card match-detail-v4__score-projection">
                <h4 className="match-detail-v4__score-heading">
                  <Trophy size={16} />
                  {t('scorePrediction')}
                </h4>
                <div className="match-detail-v4__score-value">
                  {projectedScoreText}
                </div>
                {actualScoreText && (
                  <p className="match-detail-v4__score-final">
                    {actualScoreText}
                    {' · '}
                    {language === 'zh' ? '预测比分不回写' : 'forecast score is not rewritten'}
                  </p>
                )}
                <p className="match-detail-v4__score-note">
                  {hasModelGoalEstimate
                    ? (language === 'zh'
                      ? `比分热区来自赛前模型分布；模型进球期望为 ${formatDecimal(modelGoalHome)} : ${formatDecimal(modelGoalAway)}，不是实际球队统计。`
                      : `The score zone comes from the pre-match model distribution. Model goal expectation is ${formatDecimal(modelGoalHome)} : ${formatDecimal(modelGoalAway)}, not observed team statistics.`)
                    : (language === 'zh'
                      ? '当前没有可追溯的模型进球期望，不展示模拟数值。'
                      : 'No traceable model goal expectation is available, so no simulated value is shown.')}
                </p>
                <p className="match-detail-v4__score-disclaimer">
                  {t('referenceText')}
                </p>
              </div>
            )}
            </div>
        )}

        {/* 历史与复盘：赛前模型估计 */}
        {activeTab === 'history' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: '700', fontFamily: 'var(--font-title)' }}>
                  {language === 'zh' ? '赛前模型估计' : 'Pre-match Model Estimates'}
                </h3>
                <p style={{ marginTop: '0.3rem', color: 'hsl(var(--text-muted))', fontSize: '0.78rem' }}>
                  {language === 'zh'
                    ? `生成时间 ${modelEstimateAsOf} · 每项均标注模型来源`
                    : `Generated ${modelEstimateAsOf} · every value includes model provenance`}
                </p>
              </div>
              <span style={{ padding: '0.25rem 0.55rem', borderRadius: '999px', background: 'hsl(var(--accent) / 0.1)', color: 'hsl(var(--accent))', fontSize: '0.72rem', fontWeight: 800 }}>
                {language === 'zh' ? '非真实比赛统计' : 'Not observed match stats'}
              </span>
            </div>

            <div style={{ padding: '0.85rem', borderRadius: '8px', border: '1px solid hsl(var(--accent) / 0.28)', background: 'hsl(var(--accent) / 0.06)', color: 'hsl(var(--text-secondary))', fontSize: '0.82rem', lineHeight: 1.55 }}>
              {language === 'zh'
                ? '模型进球期望用于描述赛前预测。两队已经发生的比赛表现，请查看下方带样本数量的历史赛果统计。'
                : 'Expected goals here describe a pre-match prediction. See the historical result statistics below for past performance and sample counts.'}
            </div>

            {modelEstimateRows.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {modelEstimateRows.map((stat) => {
                  const total = Math.max(0, stat.home) + Math.max(0, stat.away);
                  const homePct = total === 0 ? 50 : Math.round((Math.max(0, stat.home) / total) * 100);
                  const awayPct = 100 - homePct;

                  return (
                    <div key={stat.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(64px, 1fr) minmax(150px, 2fr) minmax(64px, 1fr)', alignItems: 'center', gap: '0.6rem', fontSize: '0.85rem', fontWeight: 650 }}>
                        <span>{formatDecimal(stat.home)}{stat.unit}</span>
                        <span style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.8rem', textAlign: 'center' }}>{displayText(stat.label)}</span>
                        <span style={{ textAlign: 'right' }}>{formatDecimal(stat.away)}{stat.unit}</span>
                      </div>
                      <div style={{ display: 'flex', width: '100%', height: '8px', backgroundColor: 'hsl(var(--border))', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${homePct}%`, backgroundColor: homeTeam.color }} />
                        <div style={{ width: `${awayPct}%`, backgroundColor: awayTeam.color }} />
                      </div>
                      <small style={{ color: 'hsl(var(--text-muted))', fontSize: '0.68rem', lineHeight: 1.4 }}>
                        {language === 'zh'
                          ? `类型：模型估计 · 质量：${displayText(stat.quality)}`
                          : `Type: model estimate · Quality: ${displayText(stat.quality)}`}
                      </small>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="data-quality-note">
                {language === 'zh'
                  ? '当前没有带明确来源的赛前模型估计，因此不展示数值。'
                  : 'No pre-match estimate with explicit provenance is available, so no value is shown.'}
              </div>
            )}

            <section className="match-stat-availability" data-testid="match-stat-availability" data-state={isVoid ? 'void' : observedStatsNotStarted ? 'not-started' : 'not-collected'} aria-labelledby="match-stat-availability-heading">
              <header><h4 id="match-stat-availability-heading">{language === 'zh' ? '本场实况统计' : 'Statistics from this match'}</h4><span>{isVoid ? (language === 'zh' ? '赛事已取消' : 'Match cancelled') : observedStatsNotStarted ? (language === 'zh' ? '未开赛 · 尚未产生' : 'Not started · not yet generated') : (language === 'zh' ? '数据通道尚未接入' : 'Statistics feed not connected')}</span></header>
              <p>{isVoid ? (language === 'zh' ? '本场已取消，不等待产生实况统计。可继续查看两队过往比赛记录。' : 'This fixture is cancelled. Historical team records remain available below.') : observedStatsNotStarted
                ? (language === 'zh' ? '这场比赛尚未开始，控球、射门、角球和牌数等本场统计尚未产生，不属于数据丢失。赛前请参考下方两队已完场比赛的统计。' : 'This match has not started, so possession, shots, corners and cards have not been generated. Use the historical team statistics below for pre-match analysis.')
                : (language === 'zh' ? '当前采集通道提供赛程、赔率、赛果及部分赛前资料，尚未接入本场主客队实况统计。这里没有可核验数值，不能按 0 解读。' : 'The current feeds provide fixtures, odds, results and some pre-match data. No verified home/away statistics from this match have been connected; absence does not mean zero.')}</p>
              <div className="match-stat-availability__fields" aria-label={language === 'zh' ? '本场统计字段范围' : 'Match statistics fields'}>{verifiedTeamStatLabels.map(stat => <span key={stat}>{stat}</span>)}</div>
              <a href="#historical-score-statistics">{language === 'zh' ? '查看已有历史赛果统计 ↓' : 'View available historical statistics ↓'}</a>
            </section>
            {dataGapSignal && (
              <div style={{ padding: '0.85rem', borderRadius: '8px', border: '1px solid hsl(var(--border))', background: 'hsl(var(--border) / 0.22)', color: 'hsl(var(--text-secondary))', fontSize: '0.82rem', lineHeight: 1.55 }}>
                <strong style={{ color: 'hsl(var(--text-primary))' }}>
                  {language === 'zh' ? '数据缺口校验' : 'Data Gap Check'}
                </strong>
                <div>
                  {displayText(language === 'zh'
                    ? `来源质量 ${dataGapSignal.sourceQuality || '--'}；主要缺口：${(dataGapSignal.missing || []).slice(0, 3).map((item) => item.zh || item.key).filter(Boolean).join('、') || '暂无关键缺口'}。`
                    : `Source quality ${dataGapSignal.sourceQuality || '--'}; gaps: ${(dataGapSignal.missing || []).slice(0, 3).map((item) => item.en || item.key).filter(Boolean).join(', ') || 'no major gap'}.`)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 历史与复盘：近期战绩 */}
        {activeTab === 'history' && (
          <div className="form-history-stack" id="historical-score-statistics">
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

        {/* 历史与复盘：交锋历史 */}
        {activeTab === 'history' && (
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

        {/* 历史与复盘：积分榜 */}
        {activeTab === 'history' && (
          match.standings && match.standings.length > 0 ? (
            <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
              <div style={{ padding: '1rem', backgroundColor: 'hsl(var(--bg-card-hover))', borderBottom: '1px solid hsl(var(--border))', fontWeight: '700' }}>
                {league.name[language]} - {language === 'zh' ? '最新排名' : 'Standings Table'}
              </div>

              <table className="responsive-table">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: '60px', textAlign: 'center' }}>{language === 'zh' ? '排名' : 'Rank'}</th>
                    <th scope="col">{language === 'zh' ? '球队' : 'Team'}</th>
                    <th scope="col" style={{ textAlign: 'center' }}>{language === 'zh' ? '已赛' : 'Played'}</th>
                    <th scope="col" style={{ textAlign: 'center' }}>{language === 'zh' ? '胜' : 'Won'}</th>
                    <th scope="col" style={{ textAlign: 'center' }}>{language === 'zh' ? '平' : 'Drawn'}</th>
                    <th scope="col" style={{ textAlign: 'center' }}>{language === 'zh' ? '负' : 'Lost'}</th>
                    <th scope="col" style={{ textAlign: 'center' }}>{language === 'zh' ? '进/失球' : 'GF/GA'}</th>
                    <th scope="col" style={{ textAlign: 'center', fontWeight: '700' }}>{language === 'zh' ? '积分' : 'Points'}</th>
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
import { FollowButton } from '../components/FollowButton';
