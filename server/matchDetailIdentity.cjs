'use strict';
const crypto = require('node:crypto');
const {validDecision} = require('../scripts/recommendationPlatform/decision.cjs');
const {DETAIL_IDENTITY_VERSION,detailAliasSource,detailEventIdentity,sameDetailEvent,exactDetailClock,
  detailBindingBody,validateDetailBindingFields} = require('../src/services/matchDetailIdentity.js');
const DETAIL_ALIAS_DECISION_HEADS_SQL = `SELECT DISTINCT ON (d.event_version,d.business_date,d.cutoff_at,
  d.payload->>'sourceMatchId',d.payload->>'eventVersion',d.payload->>'kickoffTime',d.payload->>'homeTeamId',d.payload->>'awayTeamId',
  d.payload->>'businessDate',d.payload->>'matchNo',d.payload->>'cutoffTime')
  d.id,d.source_match_id,d.event_version::text AS event_version,d.business_date::text AS business_date,
  d.published_at::text AS published_at,d.cutoff_at::text AS cutoff_at,d.input_hash,d.payload
  FROM football.recommendation_decisions d WHERE d.source_match_id=$1 AND d.payload->>'matchId'=$2
  ORDER BY d.event_version,d.business_date,d.cutoff_at,d.payload->>'sourceMatchId',d.payload->>'eventVersion',d.payload->>'kickoffTime',
  d.payload->>'homeTeamId',d.payload->>'awayTeamId',d.payload->>'businessDate',d.payload->>'matchNo',d.payload->>'cutoffTime',d.sequence DESC LIMIT 17`;
const postgresClock = value => typeof value === 'string' ? value.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00') : null;
function decisionRowMatchesPayload(row) {
  const d = row?.payload;
  return Boolean(d && row.id === d.decisionId && row.source_match_id === d.sourceMatchId && row.business_date === d.businessDate
    && row.input_hash === d.inputHash && ['event_version','published_at','cutoff_at'].every((k,i) => {
      const a=exactDetailClock(postgresClock(row[k])),b=exactDetailClock(d[['eventVersion','publishedAt','cutoffTime'][i]]);
      return a !== null && a === b;
    }));
}

function bindMatchDetailAlias({requestedId,candidates,decisions,publication,observedAt}) {
  const sourceId = detailAliasSource(requestedId);
  if (!sourceId || !Array.isArray(candidates) || !candidates.length || candidates.length > 17
    || !Array.isArray(decisions) || !decisions.length || decisions.length > 16
    || publication?.mode !== 'active-generation') return null;
  const anchors = [];
  for (const d of decisions) {
    if (!validDecision(d) || d.matchId !== requestedId || d.sourceMatchId !== sourceId) return null;
    const clocks = [d.publishedAt,d.quoteObservedAt,d.modelGeneratedAt].map(exactDetailClock);
    if (clocks.some(v => v === null) || clocks.slice(1).some(v => v > clocks[0])) return null;
    const anchor = detailEventIdentity({...d,id:d.matchId},false);
    if (!anchor) return null;
    anchors.push({decision:d,identity:anchor});
  }
  // Different cutoff versions may exist for one frozen event; a changed event,
  // team order, official number or business date makes a bare route ambiguous.
  const key = a => JSON.stringify([a.sourceMatchId,String(exactDetailClock(a.eventVersion)),a.homeTeamId,a.awayTeamId,a.matchNo,a.businessDate]);
  if (new Set(anchors.map(a => key(a.identity))).size !== 1) return null;
  anchors.sort((a,b) => exactDetailClock(a.decision.publishedAt) > exactDetailClock(b.decision.publishedAt) ? -1 : 1);
  const anchor = anchors[0], identities = candidates.map(m => detailEventIdentity(m,true));
  if (identities.some(a => !a || key(a) !== key(anchor.identity))
    || identities.some(a => !sameDetailEvent(a,identities[0]))
    || anchors.some(a => exactDetailClock(a.decision.cutoffTime) > BigInt(identities[0].saleCutoffEpochNanoseconds))) return null;
  const match = candidates[0];
  if (match.id === requestedId) return null;
  const rawLocal = [match.cutoffAt,match.cutoffTime,match.predictionMeta?.cutoffTime,match.buyEndTime]
    .some(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v));
  const body = {version:DETAIL_IDENTITY_VERSION,requestedId,canonicalId:match.id,...identities[0],
    deadlineBasis:rawLocal?'sporttery-buyEndTime-frozen-identity':'explicit-zoned-fields',
    decisionId:anchor.decision.decisionId,decisionRecordHash:anchor.decision.recordHash,
    decisionPublishedAt:anchor.decision.publishedAt,decisionCutoffTime:anchor.decision.cutoffTime,
    sourceObservedAt:match.sourceObservedAt,sourceReceivedAt:match.sourceReceivedAt,
    generationId:publication.generationId,manifestHash:publication.manifestHash,sourceCycleId:publication.sourceCycleId,
    committedAt:publication.committedAt,observedAt};
  const binding = {...body,contentHash:crypto.createHash('sha256').update(JSON.stringify(detailBindingBody(body))).digest('hex')};
  const observedNs = exactDetailClock(observedAt);
  if (observedNs === null || !validateDetailBindingFields(requestedId,match,binding,{now:Number(observedNs/1000000n)+1})) return null;
  return {...match,detailIdentity:binding};
}
module.exports = {bindMatchDetailAlias,DETAIL_ALIAS_DECISION_HEADS_SQL,decisionRowMatchesPayload,postgresClock};
