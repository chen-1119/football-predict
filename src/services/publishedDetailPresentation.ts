import type { Decision, Outcome } from './recommendationCenterView';
import type { ScoreProbability } from './mockData';

/** Supplemental scores are read from an existing model distribution. They are
 * never reconstructed from lambdas or allowed to replace a published outcome. */
export function publishedDetailPresentation(decision: Decision | null, distribution: readonly ScoreProbability[] = []) {
  if (!decision) return null;
  const seen = new Set<string>();
  const scores = distribution.filter(row => Number.isSafeInteger(row.home) && row.home >= 0
    && Number.isSafeInteger(row.away) && row.away >= 0
    && Number.isFinite(row.probability) && row.probability > 0 && row.probability <= 100)
    .map(row => ({ ...row, label: `${row.home}-${row.away}` }))
    .sort((a, b) => b.probability - a.probability || a.home - b.home || a.away - b.away)
    .filter(row => { if (seen.has(row.label)) return false; seen.add(row.label); return true; });
  const outcome = (row: ScoreProbability): Outcome => row.home > row.away ? '1' : row.home < row.away ? '2' : 'X';
  const primaryScore = scores.find(row => outcome(row) === decision.tipCode) || null;
  // Without an aligned primary, an alternate must not visually take its place.
  const alternativeScore = primaryScore ? scores.find(row => row.label !== primaryScore.label) || null : null;
  return {
    decisionId: decision.decisionId, recordHash: decision.recordHash,
    tipCode: decision.tipCode, modelProbability: decision.modelProbability,
    probabilities: { home: decision.probabilities['1'] * 100, draw: decision.probabilities.X * 100, away: decision.probabilities['2'] * 100 },
    modelGeneratedAt: decision.modelGeneratedAt, publishedAt: decision.publishedAt,
    quoteObservedAt: decision.quoteObservedAt, cutoffTime: decision.cutoffTime,
    primaryScore, alternativeScore,
  };
}
