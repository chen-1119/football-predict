// Shared, synchronous identity rules. No provider suffix or display-name join
// can grant an alias: the server must also verify the frozen decision record.
export const DETAIL_IDENTITY_VERSION = 'match-detail-identity-v1';
const text = v => typeof v === 'string' && v === v.trim() && v.length > 0 && v.length <= 160 ? v : null;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function exactDetailClock(value) {
  if (typeof value !== 'string') return null;
  const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!p) return null;
  const [y,m,d,h,n,s] = [p[1],p[2],p[3],p[4],p[5],p[6] || '0'].map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > [31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1]
    || h > 23 || n > 59 || s > 59 || (p[8] !== 'Z' && (Number(p[8].slice(1,3)) > 23 || Number(p[8].slice(4)) > 59))) return null;
  const whole = value.replace(/\.\d{1,9}(?=Z|[+-]\d{2}:\d{2}$)/, '');
  return Number.isFinite(Date.parse(whole)) ? BigInt(Date.parse(whole))*1000000n + BigInt((p[7] || '').padEnd(9,'0') || '0') : null;
}
const clockEqual = (a,b) => exactDetailClock(a) !== null && exactDetailClock(a) === exactDetailClock(b);
const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && exactDetailClock(`${v}T00:00:00Z`) !== null;
const source = v => typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null;
const team = v => text(v) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v) ? v : null;
export function detailAliasSource(id) {
  return typeof id === 'string' ? /^(?:sporttery|fivehundred)_(\d{1,20})$/.exec(id)?.[1] || null : null;
}
function saleDeadline(match, allowOfficialLocal) {
  const values = [match.cutoffAt,match.cutoffTime,match.predictionMeta?.cutoffTime,match.buyEndTime].filter(v => v != null && v !== '');
  if (!values.length) return null;
  const clocks = values.map(v => exactDetailClock(v) ?? (allowOfficialLocal && v === match.buyEndTime
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? exactDetailClock(v.replace(' ','T')+'+08:00') : null));
  if (clocks.some(v => v === null) || clocks.some(v => v !== clocks[0])) return null;
  return { clock: clocks[0], raw: values[0] };
}
// Missing business date, official number or team IDs cannot be repaired from
// the route string. Local buyEndTime is interpreted only after a valid frozen
// Sporttery event has independently bound these same identity fields.
export function detailEventIdentity(match, allowOfficialLocal = false) {
  if (!object(match) || !source(match.sourceMatchId) || detailAliasSource(match.id) !== match.sourceMatchId
    || !team(match.homeTeamId) || !team(match.awayTeamId) || match.homeTeamId === match.awayTeamId
    || !day(match.businessDate) || !text(match.matchNo) || !clockEqual(match.eventVersion,match.kickoffTime)) return null;
  if (match.matchNumStr != null && match.matchNumStr !== '' && match.matchNumStr !== match.matchNo) return null;
  const deadline = saleDeadline(match,allowOfficialLocal);
  if (!deadline || deadline.clock > exactDetailClock(match.kickoffTime)) return null;
  return {sourceMatchId:match.sourceMatchId,eventVersion:match.eventVersion,kickoffTime:match.kickoffTime,
    homeTeamId:match.homeTeamId,awayTeamId:match.awayTeamId,matchNo:match.matchNo,businessDate:match.businessDate,
    saleCutoffTime:deadline.raw,saleCutoffEpochNanoseconds:String(deadline.clock)};
}
export function sameDetailEvent(a,b) {
  return Boolean(a && b && ['sourceMatchId','homeTeamId','awayTeamId','matchNo','businessDate','saleCutoffEpochNanoseconds'].every(k => a[k] === b[k])
    && clockEqual(a.eventVersion,b.eventVersion) && clockEqual(a.kickoffTime,b.kickoffTime));
}
export function detailBindingBody(binding) {
  if (!object(binding)) return null;
  const keys = ['version','requestedId','canonicalId','sourceMatchId','eventVersion','kickoffTime','homeTeamId','awayTeamId',
    'matchNo','businessDate','saleCutoffTime','saleCutoffEpochNanoseconds','deadlineBasis','decisionId','decisionRecordHash',
    'decisionPublishedAt','decisionCutoffTime','sourceObservedAt','sourceReceivedAt','generationId','manifestHash','sourceCycleId','committedAt','observedAt'];
  if (Object.keys(binding).some(k => ![...keys,'contentHash'].includes(k)) || keys.some(k => !Object.hasOwn(binding,k))) return null;
  return Object.fromEntries(keys.map(k => [k,binding[k]]));
}
export function validateDetailBindingFields(requestedId,match,binding,{now=Date.now(),expectedGenerationId=null}={}) {
  const body = detailBindingBody(binding), at = Number.isSafeInteger(now) ? BigInt(now)*1000000n : null;
  if (!body || body.version !== DETAIL_IDENTITY_VERSION || body.requestedId !== requestedId || body.canonicalId !== match?.id
    || body.requestedId === body.canonicalId || detailAliasSource(body.requestedId) !== body.sourceMatchId
    || detailAliasSource(body.canonicalId) !== body.sourceMatchId || !/^[a-f0-9]{64}$/.test(binding.contentHash || '')
    || !/^decision_[a-f0-9]{64}$/.test(body.decisionId || '') || !/^[a-f0-9]{64}$/.test(body.decisionRecordHash || '')
    || !text(body.generationId) || !/^[a-f0-9]{64}$/.test(body.manifestHash || '') || !text(body.sourceCycleId)
    || (expectedGenerationId !== null && expectedGenerationId !== body.generationId)
    || !['explicit-zoned-fields','sporttery-buyEndTime-frozen-identity'].includes(body.deadlineBasis)) return false;
  const event = detailEventIdentity(match,body.deadlineBasis === 'sporttery-buyEndTime-frozen-identity');
  const published = exactDetailClock(body.decisionPublishedAt), cutoff = exactDetailClock(body.decisionCutoffTime);
  const observed = exactDetailClock(body.observedAt), committed = exactDetailClock(body.committedAt);
  const sourceObserved = exactDetailClock(body.sourceObservedAt), sourceReceived = exactDetailClock(body.sourceReceivedAt);
  if (!sameDetailEvent(event,body) || !event || at === null || [published,cutoff,observed,committed,sourceObserved,sourceReceived].some(v => v === null)
    || published >= cutoff || cutoff > BigInt(event.saleCutoffEpochNanoseconds) || published >= exactDetailClock(event.kickoffTime)
    || published > observed || committed > observed || observed > at || sourceObserved > sourceReceived || sourceReceived > observed
    || body.sourceObservedAt !== match.sourceObservedAt || body.sourceReceivedAt !== match.sourceReceivedAt) return false;
  return true;
}
// Async hashing also runs on 304 reuse; a cache entry is never exempt from
// request/event/clock validation merely because it had a matching ETag.
export async function acceptMatchDetail(requestedId,match,options={}) {
  if (!object(match) || !text(requestedId)) return false;
  const binding = match.detailIdentity;
  if (match.id === requestedId) return binding == null;
  if (!validateDetailBindingFields(requestedId,match,binding,options)) return false;
  const subtle = options.subtle || globalThis.crypto?.subtle;
  if (!subtle) return false;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(detailBindingBody(binding)));
    const digest = await subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2,'0')).join('') === binding.contentHash;
  } catch { return false; }
}
export function detailResponseMatchesFields(requestedId,match,now=Date.now()) {
  return Boolean(object(match) && (match.id === requestedId ? match.detailIdentity == null
    : validateDetailBindingFields(requestedId,match,match.detailIdentity,{now})));
}
