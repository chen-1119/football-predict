import type { Match } from './mockData';

export function legacyArchiveGap(match: Match) {
  const record = match.predictionMeta?.publicReferenceDecision;
  const sourceId = String(match.sourceMatchId || match.id.replace(/^sporttery_/, ''));
  const kickoff = Date.parse(match.kickoffTime);
  const cutoff = Math.min(...[match.kickoffTime, match.buyEndTime, match.predictionMeta?.cutoffTime].map(value => Date.parse(value || '')).filter(Number.isFinite));
  const prediction = record?.prediction;
  const valid = record?.integrityVerified === true
    && ['public-reference-decision-v1', 'public-reference-decision-v2'].includes(record.version)
    && /^[a-f0-9]{64}$/.test(record.contentHash)
    && record.sourceMatchId === sourceId
    && Date.parse(record.kickoffTime) === kickoff
    && (!record.eventVersion || Date.parse(record.eventVersion) === Date.parse(match.eventVersion || match.kickoffTime))
    && Date.parse(record.recordedAt) < Math.min(cutoff, Date.parse(record.cutoffTime))
    && Date.parse(record.cutoffTime) <= kickoff
    && Date.parse(record.decisionAt) <= Date.parse(record.recordedAt)
    && prediction?.recommendationAction === 'reference'
    && prediction.marketType === 'BEST'
    && ['1', 'X', '2'].includes(prediction.tipCode || '')
    && ['HAD', 'HHAD'].includes(prediction.oddsPoolCode || '')
    && (prediction.oddsPoolCode !== 'HHAD' || (typeof prediction.handicapLine === 'string' && prediction.handicapLine.trim() !== '' && Number.isInteger(Number(prediction.handicapLine))))
    && Number.isFinite(prediction.odds) && prediction.odds >= 0;
  return { state: valid ? 'reference-only' : record ? 'unverified' : 'missing', record: valid ? record : null } as const;
}
