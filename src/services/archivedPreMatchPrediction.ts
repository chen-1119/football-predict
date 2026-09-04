import type { Match, PredictionDetail } from './mockData';
import { parseHandicapLine } from './officialRecommendationEligibility';
import { getVisiblePrediction } from './predictionVisibility';

const isOutcomeCode = (value: unknown): value is '1' | 'X' | '2' => (
  value === '1' || value === 'X' || value === '2'
);

const isResultPool = (value: unknown): value is 'HAD' | 'HHAD' => (
  value === 'HAD' || value === 'HHAD'
);

const firstFiniteTime = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    const parsed = Date.parse(value || '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const earliestFiniteTime = (...values: Array<string | null | undefined>) => {
  const parsed = values
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return parsed.length > 0 ? Math.min(...parsed) : null;
};

/**
 * Returns only a stored BEST direction that can be proven to have existed
 * before kickoff. It never derives a new direction from post-match odds.
 */
export const getArchivedPreMatchPrediction = (
  match: Match,
  now = Date.now()
): PredictionDetail | undefined => {
  if (match.resultDisposition === 'VOID') return undefined;

  const kickoffAt = Date.parse(match.kickoffTime || '');
  // LIVE is intentionally readable here: the sync layer freezes the same
  // immutable pre-kickoff BEST as soon as a fixture starts. Keeping it hidden
  // until PENDING_RESULT/FINISHED makes the original direction disappear from
  // an in-play card even though the archive is already valid. Daily result
  // statistics still decide their own result-phase denominator separately.
  const archiveReadablePhase = match.status === 'LIVE'
    || match.status === 'FINISHED'
    || match.status === 'PENDING_RESULT'
    || (
      match.status === 'SCHEDULED'
      && Number.isFinite(kickoffAt)
      && kickoffAt <= now
  );
  if (!archiveReadablePhase || !Number.isFinite(kickoffAt)) return undefined;

  const archive = match.archivedPreMatchPrediction;
  const archivedPrediction = archive?.prediction;
  const marketEvidenceScope = archive?.marketEvidenceScope || 'result-pool';
  const validArchivedHhadLine = archivedPrediction?.oddsPoolCode !== 'HHAD'
    || parseHandicapLine(archivedPrediction?.handicapLine) !== null;
  const archivedAt = Date.parse(archive?.capturedAt || '');
  const archiveDeadlineAt = earliestFiniteTime(
    archive?.cutoffTime,
    match.predictionMeta?.cutoffTime,
    match.buyEndTime,
    match.kickoffTime
  );
  const archivedEventAt = Date.parse(archive?.eventVersion || archive?.kickoffTime || '');
  const matchEventAt = Date.parse(match.eventVersion || match.kickoffTime || '');
  const archivedSourceMatchId = String(archive?.sourceMatchId || '').replace(/^sporttery_/, '');
  const matchSourceMatchId = String(match.sourceMatchId || match.id || '').replace(/^sporttery_/, '');
  if (
    archive?.version === 'archived-pre-match-prediction-v1'
    && archive.source === 'immutable-pre-match-prediction-snapshot'
    && archivedSourceMatchId
    && archivedSourceMatchId === matchSourceMatchId
    && Number.isFinite(archivedAt)
    && archivedAt < kickoffAt
    && archiveDeadlineAt !== null
    && archivedAt <= archiveDeadlineAt
    && Number.isFinite(archivedEventAt)
    && archivedEventAt === matchEventAt
    && archivedPrediction?.marketType === 'BEST'
    && isResultPool(archivedPrediction.oddsPoolCode)
    && isOutcomeCode(archivedPrediction.tipCode)
    && (
      marketEvidenceScope === 'result-pool'
      || (
        marketEvidenceScope === 'model-only-reference'
        && validArchivedHhadLine
        && archivedPrediction.recommendationAction === 'reference'
        && Number(archivedPrediction.odds) === 0
      )
    )
  ) {
    return {
      ...archivedPrediction,
      explanation: archivedPrediction.explanation || { zh: '', en: '' },
      visibilityStatus: archivedPrediction.visibilityStatus || 'FREE',
      resultStatus: 'PENDING'
    };
  }

  // Legacy payload fallback. New publications always carry the immutable
  // archive object above; this branch keeps older retained snapshots readable
  // during a rolling deployment without treating them as the new audit source.
  const prediction = getVisiblePrediction(match, 'BEST');
  if (!prediction || !isResultPool(prediction.oddsPoolCode) || !isOutcomeCode(prediction.tipCode)) {
    return undefined;
  }

  const generatedAt = firstFiniteTime(
    match.predictionMeta?.generatedAt,
    match.predictionMeta?.snapshot?.latestAt
  );
  const legacyDeadlineAt = earliestFiniteTime(
    match.predictionMeta?.cutoffTime,
    match.buyEndTime,
    match.kickoffTime
  );
  if (
    generatedAt === null
    || generatedAt >= kickoffAt
    || legacyDeadlineAt === null
    || generatedAt > legacyDeadlineAt
  ) return undefined;

  return prediction;
};
