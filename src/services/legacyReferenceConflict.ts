import type { Match } from './mockData';

/** Diagnostic only: never adjudicates publication, rewrites a pick or settles it. */
export function hasUnboundLegacyReferenceConflict(match: Match): boolean {
  // Independent public records have their own integrity/visibility path. A
  // private candidate differing from such a record is not a public conflict.
  if (match.predictionMeta?.publicReferenceDecision) return false;
  const legacy = match.predictionMeta?.immutableAnalysisReferenceDecision;
  if (!legacy || legacy.version !== 'immutable-analysis-reference-decision-v1') return false;
  const eventId = String(match.sourceMatchId || match.id.replace(/^[^_]+_/, '')).trim();
  const kickoff = Date.parse(match.kickoffTime);
  if (!eventId || legacy.sourceMatchId !== eventId || !Number.isFinite(kickoff)
    || Date.parse(legacy.kickoffTime || '') !== kickoff
    || (legacy.eventVersion && match.eventVersion && legacy.eventVersion !== match.eventVersion)
    || legacy.market !== 'HAD' || !['1', 'X', '2'].includes(legacy.code || '')
    || legacy.source?.provider !== '500.com' || legacy.statisticsTrack !== 'analysis-only') return false;
  // This checks conflicting retained declarations, not their cryptographic
  // validity. Never call either declaration an independently published pick.
  return (match.predictions || []).some(prediction => prediction.marketType === 'BEST'
    && prediction.recommendationAction === 'reference'
    && prediction.oddsPoolCode === 'HAD'
    && ['1', 'X', '2'].includes(prediction.tipCode)
    && prediction.tipCode !== legacy.code);
}
