import {
  OFFICIAL_RECOMMENDATION_POLICY_VERSION,
  parseHandicapLine,
  recommendationLinesMatch,
  type OfficialRecommendationCandidate
} from './officialRecommendationEligibility';

export const LIVE_RECOMMENDATION_POLICY_VERSION = 'live-model-recommendation-v2';
export const LIVE_PUBLICATION_EVIDENCE_VERSION = 'live-recommendation-publication-v2';
export const LIVE_OFFICIAL_ODDS_MAX_AGE_MS = 20 * 60 * 1000;
const LIVE_OFFICIAL_ODDS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const LIVE_RECOMMENDATION_MIN_EVIDENCE_SCORE = 45;
export const LIVE_RECOMMENDATION_MIN_DATA_QUALITY = 0.5;
export const LIVE_RECOMMENDATION_MAX_SEVERE_MISSING = 1;
export const LIVE_MARKET_CORE_MIN_DATA_QUALITY = 0.2;
export const LIVE_MARKET_CORE_MAX_SEVERE_MISSING = 2;
export const LIVE_MARKET_CORE_MIN_EVIDENCE_SCORE = 60;
export const LIVE_HHAD_MAX_OFFICIAL_SP = 2.05;
export const LIVE_DEEP_HANDICAP_MIN_DATA_QUALITY = 0.6;
export const LIVE_DEEP_HANDICAP_MIN_EVIDENCE_SCORE = 64;

const RETAINED_LIVE_POLICY_VERSIONS = new Set([
  'live-model-recommendation-v1',
  LIVE_RECOMMENDATION_POLICY_VERSION
]);
const RETAINED_LIVE_PUBLICATION_VERSIONS = new Set([
  'live-recommendation-publication-v1',
  LIVE_PUBLICATION_EVIDENCE_VERSION
]);

const isRetainedLivePolicyVersion = (value: unknown) => RETAINED_LIVE_POLICY_VERSIONS.has(String(value || ''));
const isRetainedLivePublicationVersion = (value: unknown) => RETAINED_LIVE_PUBLICATION_VERSIONS.has(String(value || ''));

const LIVE_HARD_BLOCKERS = new Set([
  'unsupported-market', 'unsupported-direction', 'missing-handicap-line', 'had-line-not-zero',
  'missing-official-sp', 'missing-model-probability', 'missing-devigged-market-probability',
  'missing-model-separation', 'missing-data-quality', 'model-probability-too-low',
  'market-implied-probability-contradiction', 'negative-expected-value', 'score-matrix-not-aligned',
  'had-hhad-conflict', 'candidate-risk-too-high', 'official-sp-movement-contradiction',
  'external-market-contradiction', 'low-sp-without-model-edge', 'low-sp-without-value',
  'long-price-probability-too-low', 'long-price-edge-too-thin', 'long-price-value-too-thin',
  'insufficient-independent-support', 'official-market-direction-contradiction',
  'model-risk-not-promotable', 'upstream-multi-factor-gate-not-passed',
  'insufficient-data-quality', 'too-many-severe-data-gaps'
]);

type LiveRecommendationCandidate = OfficialRecommendationCandidate & {
  odds?: number;
  liveRecommendationAction?: 'recommend' | 'withhold';
  liveRecommendation?: {
    version?: string;
    eligible?: boolean;
    statisticsTrack?: string;
  };
  livePublicationEvidence?: {
    version?: string;
    policyVersion?: string;
    statisticsTrack?: string;
    matchId?: string;
    sourceMatchId?: string;
    market?: string;
    code?: string;
    handicapLine?: string | number;
    officialSp?: number;
    officialSource?: string;
    officialSourceUrl?: string;
    officialOddsObservedAt?: string | null;
    officialOddsReceivedAt?: string | null;
    officialOddsClockSource?: string | null;
    officialOddsMaxAgeSeconds?: number;
    publishedAt?: string;
    cutoffAt?: string;
  };
  multiFactorEvidence?: OfficialRecommendationCandidate['multiFactorEvidence'] & {
    evidenceScore?: number;
    probabilityEdge?: number | null;
    expectedValue?: number | null;
    dataQuality?: number | null;
    supportingFactors?: string[];
    diagnostics?: { severeMissingCount?: number | null };
  };
};

type LiveRecommendationMatch = {
  id?: string;
  sourceMatchId?: string;
  status?: string;
  kickoffTime?: string;
  buyEndTime?: string;
  predictionMeta?: { cutoffTime?: string | null } | null;
  oddsObservedAt?: string | null;
  oddsReceivedAt?: string | null;
  handicapOddsObservedAt?: string | null;
  handicapOddsReceivedAt?: string | null;
};

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

const retainedPublicationMatchIdentityMatches = (
  match: LiveRecommendationMatch | null | undefined,
  publicationMatchId: unknown,
  publicationSourceMatchId: unknown
) => {
  const matchId = String(match?.id || '');
  const sourceMatchId = String(match?.sourceMatchId || '');
  const archivedMatchId = String(publicationMatchId || '');
  const archivedSourceMatchId = String(publicationSourceMatchId || '');
  if (!matchId || !sourceMatchId || !archivedMatchId || !archivedSourceMatchId) return false;
  if (sourceMatchId !== archivedSourceMatchId) return false;
  if (matchId === archivedMatchId) return true;

  // Settlement reconciliation may replace the canonical provider prefix while
  // preserving the same official Sporttery source id. This exception is only
  // used to retain an already immutable publication; creation validation above
  // continues to require the exact match id.
  const retainedIds = new Set([
    `sporttery_${sourceMatchId}`,
    `fivehundred_${sourceMatchId}`
  ]);
  return retainedIds.has(matchId) && retainedIds.has(archivedMatchId);
};

export const parseShanghaiDateTime = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    return Date.parse(`${raw.replace(/\s+/, 'T')}+08:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return Date.parse(`${raw}+08:00`);
  }
  return Date.parse(raw);
};

export const liveRecommendationCutoffMs = (match: LiveRecommendationMatch | null | undefined) => {
  const candidates = [
    match?.predictionMeta?.cutoffTime,
    match?.buyEndTime,
    match?.kickoffTime
  ].map(parseShanghaiDateTime).filter(Number.isFinite);
  return candidates.length ? Math.min(...candidates) : Number.NaN;
};

export const liveRecommendationCutoffIso = (
  match: LiveRecommendationMatch | null | undefined
) => {
  const cutoffMs = liveRecommendationCutoffMs(match);
  return Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString() : undefined;
};

export const isLiveRecommendationWindowOpen = (
  match: LiveRecommendationMatch | null | undefined,
  nowMs = Date.now()
) => {
  const kickoffMs = parseShanghaiDateTime(match?.kickoffTime || '');
  const cutoffMs = liveRecommendationCutoffMs(match);
  return Boolean(
    match?.status === 'SCHEDULED'
    && Number.isFinite(Number(nowMs))
    && Number.isFinite(kickoffMs)
    && Number.isFinite(cutoffMs)
    && Number(nowMs) < kickoffMs
    && Number(nowMs) < cutoffMs
  );
};

export const evaluateLiveRecommendation = (
  prediction: LiveRecommendationCandidate | null | undefined,
  officialOdds: number,
  currentOfficialHandicapLine?: string | number | null
) => {
  const evidence = prediction?.multiFactorEvidence;
  const odds = finiteNumber(officialOdds);
  const evidenceOdds = finiteNumber(evidence?.odds);
  const evidenceScore = finiteNumber(evidence?.evidenceScore);
  const probabilityEdge = finiteNumber(evidence?.probabilityEdge);
  const expectedValue = finiteNumber(evidence?.expectedValue);
  const dataQuality = finiteNumber(evidence?.dataQuality);
  const severeMissingCount = finiteNumber(evidence?.diagnostics?.severeMissingCount);
  const officialHandicapLine = parseHandicapLine(currentOfficialHandicapLine);
  const supportingFactors = Array.isArray(evidence?.supportingFactors)
    ? unique(evidence.supportingFactors.map((value) => String(value || '')))
    : [];
  const evidenceBlockers = Array.isArray(evidence?.blockers)
    ? unique(evidence.blockers.map((value) => String(value || '')))
    : [];
  const blockers: string[] = [];

  if (prediction?.marketType !== 'BEST') blockers.push('not-best-selection');
  if (prediction?.oddsPoolCode !== 'HAD' && prediction?.oddsPoolCode !== 'HHAD') blockers.push('unsupported-market');
  if (!['1', 'X', '2'].includes(String(prediction?.tipCode || ''))) blockers.push('unsupported-direction');
  if (odds === null || odds <= 1) blockers.push('missing-official-sp');
  if (evidence?.version !== OFFICIAL_RECOMMENDATION_POLICY_VERSION) blockers.push('missing-multi-factor-evidence');
  if (evidence?.market !== prediction?.oddsPoolCode) blockers.push('evidence-market-mismatch');
  if (evidence?.code !== prediction?.tipCode) blockers.push('evidence-direction-mismatch');
  if (!recommendationLinesMatch(prediction, evidence, currentOfficialHandicapLine)) blockers.push('handicap-line-mismatch');
  if (evidenceOdds === null || odds === null || Math.abs(evidenceOdds - odds) > 0.001) blockers.push('official-sp-mismatch');
  if (evidenceScore === null || evidenceScore < LIVE_RECOMMENDATION_MIN_EVIDENCE_SCORE) blockers.push('live-evidence-score-below-threshold');
  if (probabilityEdge === null || probabilityEdge < 0.015) blockers.push('live-model-edge-below-threshold');
  if (expectedValue === null || expectedValue < 0) blockers.push('live-expected-value-negative');
  const standardCoverage = dataQuality !== null
    && severeMissingCount !== null
    && dataQuality >= LIVE_RECOMMENDATION_MIN_DATA_QUALITY
    && severeMissingCount <= LIVE_RECOMMENDATION_MAX_SEVERE_MISSING;
  const marketCoreLimitedCoverage = !standardCoverage
    && dataQuality !== null
    && severeMissingCount !== null
    && dataQuality >= LIVE_MARKET_CORE_MIN_DATA_QUALITY
    && severeMissingCount <= LIVE_MARKET_CORE_MAX_SEVERE_MISSING
    && evidenceScore !== null
    && evidenceScore >= LIVE_MARKET_CORE_MIN_EVIDENCE_SCORE
    && probabilityEdge !== null
    && probabilityEdge >= 0.12
    && expectedValue !== null
    && expectedValue >= 0.1
    && supportingFactors.length >= 7;
  if (dataQuality === null) blockers.push('live-data-quality-missing');
  if (severeMissingCount === null) blockers.push('live-severe-missing-count-missing');
  if (dataQuality !== null && severeMissingCount !== null && !standardCoverage && !marketCoreLimitedCoverage) {
    blockers.push('live-data-coverage-below-executable-threshold');
  }
  if (marketCoreLimitedCoverage) blockers.push('live-market-core-limited-shadow-only');
  if (prediction?.oddsPoolCode === 'HHAD' && odds !== null && odds > LIVE_HHAD_MAX_OFFICIAL_SP) {
    blockers.push('live-hhad-high-sp-safety-hold');
  }
  if (prediction?.oddsPoolCode === 'HHAD' && officialHandicapLine !== null && Math.abs(officialHandicapLine) >= 2) {
    if (
      dataQuality === null
      || dataQuality < LIVE_DEEP_HANDICAP_MIN_DATA_QUALITY
      || severeMissingCount === null
      || severeMissingCount > 0
      || evidenceScore === null
      || evidenceScore < LIVE_DEEP_HANDICAP_MIN_EVIDENCE_SCORE
    ) blockers.push('live-deep-handicap-safety-hold');
  }
  if (supportingFactors.length < 4) blockers.push('live-supporting-factors-insufficient');
  blockers.push(...evidenceBlockers.filter((blocker) => LIVE_HARD_BLOCKERS.has(blocker)));

  const uniqueBlockers = unique(blockers);
  const eligible = uniqueBlockers.length === 0;
  const grade = eligible
    ? evidenceScore! >= 64 && expectedValue! >= 0.04 ? 'A'
      : evidenceScore! >= 52 && expectedValue! >= 0.015 ? 'B'
        : 'C'
    : 'WITHHOLD';

  return {
    version: LIVE_RECOMMENDATION_POLICY_VERSION,
    eligible,
    grade: grade as 'A' | 'B' | 'C' | 'WITHHOLD',
    statisticsTrack: 'live-model' as const,
    evidenceScore,
    minimumEvidenceScore: LIVE_RECOMMENDATION_MIN_EVIDENCE_SCORE,
    probabilityEdge,
    minimumProbabilityEdge: 0.015,
    expectedValue,
    minimumExpectedValue: 0,
    dataQuality,
    minimumDataQuality: LIVE_RECOMMENDATION_MIN_DATA_QUALITY,
    severeMissingCount,
    maximumSevereMissingCount: LIVE_RECOMMENDATION_MAX_SEVERE_MISSING,
    coverageMode: marketCoreLimitedCoverage ? 'market-core-limited' as const : standardCoverage ? 'standard' as const : 'withhold' as const,
    dataCoverageWarning: marketCoreLimitedCoverage,
    supportingFactorCount: supportingFactors.length,
    blockers: uniqueBlockers,
    warnings: unique(evidenceBlockers.filter((blocker) => !LIVE_HARD_BLOCKERS.has(blocker)))
  };
};

const isOfficialSportteryUrl = (value: unknown) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'webapi.sporttery.cn';
  } catch {
    return false;
  }
};

const evaluateOfficialOddsClockFreshness = (
  observedAt: unknown,
  receivedAt: unknown,
  evaluatedAt: number | string = Date.now(),
  maxAgeMs = LIVE_OFFICIAL_ODDS_MAX_AGE_MS
) => {
  const evaluatedAtMs = typeof evaluatedAt === 'number' ? evaluatedAt : parseShanghaiDateTime(evaluatedAt);
  const observedRaw = String(observedAt || '').trim();
  const receivedRaw = String(receivedAt || '').trim();
  const observedMs = observedRaw ? parseShanghaiDateTime(observedRaw) : Number.NaN;
  const receivedMs = receivedRaw ? parseShanghaiDateTime(receivedRaw) : Number.NaN;
  const referenceMs = receivedRaw ? receivedMs : observedMs;
  const ageMs = Number.isFinite(evaluatedAtMs) && Number.isFinite(referenceMs)
    ? evaluatedAtMs - referenceMs
    : null;
  const safeMaxAgeMs = Math.max(0, finiteNumber(maxAgeMs) ?? LIVE_OFFICIAL_ODDS_MAX_AGE_MS);
  return {
    eligible: Number.isFinite(evaluatedAtMs)
      && Number.isFinite(referenceMs)
      && ageMs! >= -LIVE_OFFICIAL_ODDS_MAX_FUTURE_SKEW_MS
      && ageMs! <= safeMaxAgeMs,
    observedAt: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : null,
    receivedAt: Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : null,
    clockSource: receivedRaw ? 'receivedAt' : observedRaw ? 'observedAt' : null,
  };
};

export const officialOddsFreshnessForLivePrediction = (
  match: LiveRecommendationMatch | null | undefined,
  prediction: LiveRecommendationCandidate | null | undefined,
  evaluatedAt: number | string = Date.now()
) => {
  const pool = String(prediction?.oddsPoolCode || '').toUpperCase();
  if (pool !== 'HAD' && pool !== 'HHAD') {
    return evaluateOfficialOddsClockFreshness(null, null, evaluatedAt);
  }
  return evaluateOfficialOddsClockFreshness(
    pool === 'HHAD' ? match?.handicapOddsObservedAt : match?.oddsObservedAt,
    pool === 'HHAD' ? match?.handicapOddsReceivedAt : match?.oddsReceivedAt,
    evaluatedAt
  );
};

export const isLivePublicationEvidenceValid = (
  match: LiveRecommendationMatch | null | undefined,
  prediction: LiveRecommendationCandidate | null | undefined,
  officialOdds: number,
  currentOfficialHandicapLine?: string | number | null
) => {
  const publication = prediction?.livePublicationEvidence;
  const odds = finiteNumber(officialOdds);
  const evidenceOdds = finiteNumber(publication?.officialSp);
  const publishedAtMs = parseShanghaiDateTime(publication?.publishedAt);
  const cutoffAtMs = parseShanghaiDateTime(publication?.cutoffAt);
  const matchCutoffMs = liveRecommendationCutoffMs(match);
  const publicationOddsFreshness = evaluateOfficialOddsClockFreshness(
    publication?.officialOddsObservedAt,
    publication?.officialOddsReceivedAt,
    publishedAtMs,
    Number(publication?.officialOddsMaxAgeSeconds) * 1000
  );
  const officialOddsMaxAgeSeconds = finiteNumber(publication?.officialOddsMaxAgeSeconds);
  const expectedSource = prediction?.oddsPoolCode === 'HHAD' ? 'sporttery:HHAD' : 'sporttery:HAD';
  return Boolean(
    publication
    && publication.version === LIVE_PUBLICATION_EVIDENCE_VERSION
    && publication.policyVersion === LIVE_RECOMMENDATION_POLICY_VERSION
    && publication.statisticsTrack === 'live-model'
    && String(publication.matchId || '') !== ''
    && publication.matchId === String(match?.id || '')
    && String(publication.sourceMatchId || '') !== ''
    && publication.sourceMatchId === String(match?.sourceMatchId || '')
    && publication.market === prediction?.oddsPoolCode
    && publication.code === prediction?.tipCode
    && recommendationLinesMatch(prediction, publication, currentOfficialHandicapLine)
    && odds !== null
    && evidenceOdds !== null
    && Math.abs(evidenceOdds - odds) <= 0.001
    && publication.officialSource === expectedSource
    && isOfficialSportteryUrl(publication.officialSourceUrl)
    && officialOddsMaxAgeSeconds !== null
    && officialOddsMaxAgeSeconds > 0
    && officialOddsMaxAgeSeconds <= LIVE_OFFICIAL_ODDS_MAX_AGE_MS / 1000
    && publicationOddsFreshness.eligible
    && publication.officialOddsClockSource === publicationOddsFreshness.clockSource
    && Number.isFinite(publishedAtMs)
    && Number.isFinite(cutoffAtMs)
    && publishedAtMs < cutoffAtMs
    && (!Number.isFinite(matchCutoffMs) || cutoffAtMs === matchCutoffMs)
  );
};

// A published record is deliberately validated against the immutable facts
// captured at publication time, rather than against a later market snapshot.
// The strict validator above remains the gate for creating a new executable
// live recommendation. This validator only keeps an existing, server-owned
// publication visible after SP/line movement or the sale window closing.
const isPublishedLivePublicationRecordValid = (
  match: LiveRecommendationMatch | null | undefined,
  prediction: LiveRecommendationCandidate | null | undefined
) => {
  const publication = prediction?.livePublicationEvidence;
  const evidenceOdds = finiteNumber(publication?.officialSp);
  const publishedAtMs = parseShanghaiDateTime(publication?.publishedAt);
  const cutoffAtMs = parseShanghaiDateTime(publication?.cutoffAt);
  const matchCutoffMs = liveRecommendationCutoffMs(match);
  const publicationOddsFreshness = evaluateOfficialOddsClockFreshness(
    publication?.officialOddsObservedAt,
    publication?.officialOddsReceivedAt,
    publishedAtMs,
    Number(publication?.officialOddsMaxAgeSeconds) * 1000
  );
  const publicationMarket = String(publication?.market || '').toUpperCase();
  const publicationCode = String(publication?.code || '');
  const predictionOdds = finiteNumber(prediction?.odds);
  const publicationLine = publicationMarket === 'HHAD' ? publication?.handicapLine : 0;
  const expectedSource = publicationMarket === 'HHAD' ? 'sporttery:HHAD' : 'sporttery:HAD';
  const isLegacyPublication = publication?.version === 'live-recommendation-publication-v1';
  const officialOddsMaxAgeSeconds = finiteNumber(publication?.officialOddsMaxAgeSeconds);
  const publicationClockValid = isLegacyPublication
    ? true
    : officialOddsMaxAgeSeconds !== null
      && officialOddsMaxAgeSeconds > 0
      && officialOddsMaxAgeSeconds <= LIVE_OFFICIAL_ODDS_MAX_AGE_MS / 1000
      && publicationOddsFreshness.eligible
      && publication?.officialOddsClockSource === publicationOddsFreshness.clockSource;

  return Boolean(
    publication
    && prediction?.marketType === 'BEST'
    && isRetainedLivePublicationVersion(publication.version)
    && isRetainedLivePolicyVersion(publication.policyVersion)
    && isRetainedLivePolicyVersion(prediction?.liveRecommendation?.version)
    && publication.statisticsTrack === 'live-model'
    && retainedPublicationMatchIdentityMatches(
      match,
      publication.matchId,
      publication.sourceMatchId
    )
    && (publicationMarket === 'HAD' || publicationMarket === 'HHAD')
    && (publicationCode === '1' || publicationCode === 'X' || publicationCode === '2')
    && publicationMarket === prediction?.oddsPoolCode
    && publicationCode === prediction?.tipCode
    && recommendationLinesMatch(prediction, publication, publicationLine)
    && evidenceOdds !== null
    && evidenceOdds > 1
    && predictionOdds !== null
    && Math.abs(evidenceOdds - predictionOdds) <= 0.001
    && publication.officialSource === expectedSource
    && isOfficialSportteryUrl(publication.officialSourceUrl)
    && publicationClockValid
    && Number.isFinite(publishedAtMs)
    && Number.isFinite(cutoffAtMs)
    && publishedAtMs < cutoffAtMs
    && (!Number.isFinite(matchCutoffMs) || cutoffAtMs === matchCutoffMs)
  );
};

export const isLiveRecommendationEligible = (
  prediction: LiveRecommendationCandidate | null | undefined,
  officialOdds: number,
  currentOfficialHandicapLine?: string | number | null,
  match?: LiveRecommendationMatch | null,
  nowMs = Date.now()
) => Boolean(
  prediction?.liveRecommendationAction === 'recommend'
  && prediction?.liveRecommendation?.version === LIVE_RECOMMENDATION_POLICY_VERSION
  && prediction?.liveRecommendation?.eligible === true
  && prediction?.liveRecommendation?.statisticsTrack === 'live-model'
  && evaluateLiveRecommendation(prediction, officialOdds, currentOfficialHandicapLine).eligible
  && officialOddsFreshnessForLivePrediction(match, prediction, nowMs).eligible
  && isLivePublicationEvidenceValid(match, prediction, officialOdds, currentOfficialHandicapLine)
);

// A recommendation already bound to immutable, cutoff-safe publication
// evidence must remain visible if a later refresh temporarily loses its
// fresh-odds clock or downgrades the global model risk state. This never
// creates a new recommendation: the exact published match, market, direction,
// line and official SP evidence are still mandatory. Do not re-run the full
// factor evaluation here: compact current-list rows intentionally omit private
// factor diagnostics, while the immutable publication already proves that the
// full row passed the live policy at publication time.
export const isPublishedLiveRecommendationEligible = (
  prediction: LiveRecommendationCandidate | null | undefined,
  _officialOdds: number,
  _currentOfficialHandicapLine?: string | number | null,
  match?: LiveRecommendationMatch | null
) => Boolean(
  isRetainedLivePolicyVersion(prediction?.liveRecommendation?.version)
  && prediction?.liveRecommendation?.statisticsTrack === 'live-model'
  && isPublishedLivePublicationRecordValid(match, prediction)
);
