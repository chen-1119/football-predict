import type { Decision, Outcome, PublishedScores, PublishedScore } from './recommendationCenterView';
import type { ScoreProbability } from './mockData';

/** Prefer the read-only score projection bound to this exact publication.
 * Legacy supplemental rows are used only when no projection field was sent. */
export function publishedDetailPresentation(decision: Decision | null, distribution: readonly ScoreProbability[] = [], boundDistribution?: PublishedScores | null) {
  if (!decision) return null;
  const outcome = (row: Pick<ScoreProbability, 'home' | 'away'>): Outcome => row.home > row.away ? '1' : row.home < row.away ? '2' : 'X';
  let scoreSource: 'published-matrix' | 'legacy-supplemental' | 'unavailable' = boundDistribution === undefined ? 'legacy-supplemental' : 'unavailable';
  let scores: ScoreProbability[] = [], alignedScores: ScoreProbability[] = [];
  if (boundDistribution !== undefined) {
    const h = decision.handicapAnalysis;
    const validRow = (row: PublishedScore) => row && Number.isSafeInteger(row.home) && row.home >= 0
      && Number.isSafeInteger(row.away) && row.away >= 0 && row.label === `${row.home}-${row.away}`
      && Number.isFinite(row.probability) && row.probability > 0 && row.probability <= 1
      && row.hadCode === outcome(row) && row.probability <= decision.probabilities[row.hadCode] + 1e-6
      && row.hhadCode === outcome({ home: row.home + (h?.handicapLine ?? NaN), away: row.away });
    const validRows = (rows: PublishedScore[]) => Array.isArray(rows) && rows.every(validRow)
      && new Set(rows.map(row => row.label)).size === rows.length
      && rows.every((row, index) => index === 0 || rows[index - 1].probability >= row.probability)
      && rows.reduce((sum, row) => sum + row.probability, 0) <= 1 + 1e-6;
    if (boundDistribution?.status === 'available' && boundDistribution.version === 'published-score-distribution-v1'
      && boundDistribution.decisionId === decision.decisionId && boundDistribution.recordHash === decision.recordHash
      && h?.version === 'handicap-margin-v3' && Number.isSafeInteger(h.handicapLine) && h.handicapLine !== 0
      && validRows(boundDistribution.topScores) && validRows(boundDistribution.alignedScores)
      && boundDistribution.alignedScores.every(row => row.hadCode === decision.tipCode && row.hhadCode === h.tipCode
        && boundDistribution.topScores.every(top => top.label !== row.label || top.probability === row.probability))) {
      const percentScore = (row: PublishedScore): ScoreProbability => ({ home: row.home, away: row.away, label: row.label, probability: row.probability * 100 });
      scores = boundDistribution.topScores.map(percentScore);
      alignedScores = boundDistribution.alignedScores.map(percentScore);
      scoreSource = 'published-matrix';
    }
  } else {
    const seen = new Set<string>();
    scores = distribution.filter(row => Number.isSafeInteger(row.home) && row.home >= 0
      && Number.isSafeInteger(row.away) && row.away >= 0
      && Number.isFinite(row.probability) && row.probability > 0 && row.probability <= 100)
      .map(row => ({ ...row, label: `${row.home}-${row.away}` }))
      .sort((a, b) => b.probability - a.probability || a.home - b.home || a.away - b.away)
      .filter(row => { if (seen.has(row.label)) return false; seen.add(row.label); return true; });
    alignedScores = scores.filter(row => outcome(row) === decision.tipCode);
  }
  const primaryScore = alignedScores[0] || null;
  // Without an aligned primary, an alternate must not visually take its place.
  const alternativeScore = primaryScore ? scores.find(row => row.label !== primaryScore.label) || null : null;
  return {
    decisionId: decision.decisionId, recordHash: decision.recordHash,
    tipCode: decision.tipCode, modelProbability: decision.modelProbability,
    probabilities: { home: decision.probabilities['1'] * 100, draw: decision.probabilities.X * 100, away: decision.probabilities['2'] * 100 },
    modelGeneratedAt: decision.modelGeneratedAt, publishedAt: decision.publishedAt,
    quoteObservedAt: decision.quoteObservedAt, cutoffTime: decision.cutoffTime,
    primaryScore, alternativeScore, scoreSource, globalScores: scores, alignedScores,
  };
}
