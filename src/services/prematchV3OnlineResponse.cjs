'use strict';
// Shared pure response contract: no filesystem, subprocess, SSH or database access.
const crypto=require('node:crypto');
const {strictInstant}=require('./strictInstant.cjs');
const {epochNanoseconds}=require('./prematchV3Clock.cjs');
const {sportteryDeadlineClock}=require('./sportteryDeadlineClock.cjs');
const VERSION='prematch-v3-online-readonly-v2';
const IDENTITY_VERSION='prematch-v3-online-readonly-v3';
const MAX_MODEL_ARTIFACT_BYTES=4*1024*1024;
const MODEL_ARTIFACT_KEYS=Object.freeze(['prematch-v3-baseline','prematch-v3-parameters']);
const MAX_MATCHES=128, MAX_INVENTORY=24;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function check(value,code){if(!value)throw Error('V3_READER_'+code);}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,maximum)=>typeof value==='string'&&value.length>0&&value.length<=maximum&&value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value);
const instant=epochNanoseconds;
function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Boolean(strictInstant(`${date}T00:00:00Z`));
}

function identityContextFor(value,index,trustRegistry) {
  return {row:value.matchRows[index],publication:require('./prematchV3InputIdentity.cjs').publicationFromMeta(value.generation),
    endpoint:value.identitySource.endpoint,pgObservedAt:value.observedAt,inputCapturedAt:value.identitySource.inputCapturedAt,trustRegistry};
}
function validateResponse(value, date, {trustRegistry}={}) {
  check(validDate(date), 'DATE');
  check(object(value) && [VERSION,IDENTITY_VERSION].includes(value.version) && value.readOnly === 'on' && value.productionWrites === 0
    && value.businessDate === date && instant(value.observedAt) !== null
    && Array.isArray(value.matches) && value.matches.length <= MAX_MATCHES
    && Array.isArray(value.modelArtifactInventory) && value.modelArtifactInventory.length <= MAX_INVENTORY
    && Array.isArray(value.modelArtifacts) && value.modelArtifacts.length <= MODEL_ARTIFACT_KEYS.length
    && object(value.generation), 'RESPONSE');
  check(text(value.generation.data_generation_id, 256) && typeof value.generation.manifest_hash === 'string'
    && /^[a-f0-9]{64}$/.test(value.generation.manifest_hash)
    && (value.generation.committed_at == null || instant(value.generation.committed_at) !== null), 'GENERATION_METADATA');
  const missingFields = [], clockNormalizations = [];
  const withIdentity=value.version===IDENTITY_VERSION;
  const identity=withIdentity?require('./prematchV3InputIdentity.cjs'):null;
  if(withIdentity) {
    check(object(trustRegistry)&&!Array.isArray(trustRegistry)&&object(value.identitySource)
      &&value.identitySource.version==='prematch-v3-online-identity-source-v1'
      &&value.identitySource.sourcePath===identity.CURRENT_SNAPSHOT_NAMESPACE
      &&object(value.identitySource.endpoint)&&instant(value.identitySource.inputCapturedAt)!==null
      &&instant(value.observedAt)<=instant(value.identitySource.inputCapturedAt)
      &&value.identitySource.collectorTrustRegistryHash===require('./collectorAttestation.cjs').sha256CollectorJson(trustRegistry)
      &&Array.isArray(value.matchRows)&&value.matchRows.length===value.matches.length
      &&Array.isArray(value.identityAdmissions)&&value.identityAdmissions.length===value.matches.length,'IDENTITY_SIDECARS');
    check(require('../../scripts/recommendationPlatform/liveOfficialHad.cjs').verifySignedCurrentEndpointIdentity(
      value.identitySource.endpoint,{asOf:value.identitySource.inputCapturedAt,trustRegistry}),'IDENTITY_SOURCE_SIGNATURE');
    const eventKeys=value.matches.map(m=>`${m?.sourceMatchId}|${String(instant(m?.eventVersion))}`);
    check(new Set(eventKeys).size===eventKeys.length&&new Set(value.matches.map(m=>m?.id)).size===value.matches.length,'MATCH_EVENT_AMBIGUOUS');
  }
  value.matches.forEach((match, index) => {
    check(object(match) && match.businessDate === date, 'MATCH_BUSINESS_DATE');
    const id = match.id, sourceId = match.sourceMatchId;
    check((text(id, 256) || text(sourceId, 256)) && (id == null || text(id, 256))
      && (sourceId == null || text(sourceId, 256)), 'MATCH_IDENTITY');
    const identityContext=withIdentity?identityContextFor(value,index,trustRegistry):null;
    if(withIdentity)check(identity.verifyPrematchV3InputIdentity(value.identityAdmissions[index],{...identityContext,match}),'MATCH_IDENTITY');
    else {
      const normalize = id => id.replace(/^sporttery_/, '');
      check((id == null || text(normalize(id), 256)) && (sourceId == null || text(normalize(sourceId), 256)), 'MATCH_IDENTITY');
      check(id == null || sourceId == null || normalize(id) === normalize(sourceId), 'MATCH_IDENTITY');
    }
    const resolve=(raw,field)=>withIdentity?identity.resolveIdentityDeadline(match,raw,{field,
      identityAdmission:value.identityAdmissions[index],identityContext}):sportteryDeadlineClock(match,raw,{field});
    for (const field of ['kickoffTime', 'eventVersion', 'buyEndTime']) {
      if (match[field] != null) {
        const resolved=field==='buyEndTime'?resolve(match[field],field):{instant:match[field]};
        check(instant(resolved.instant) !== null, 'MATCH_CLOCK');
        if(resolved.normalization) clockNormalizations.push({index,...resolved.normalization});
      }
    }
    if (match.eventVersion != null && match.kickoffTime != null)
      check(instant(match.eventVersion) === instant(match.kickoffTime), 'MATCH_EVENT_CONFLICT');
    for (const field of ['matchDate', 'kickoffDate']) {
      if (match[field] != null) check(validDate(match[field]), 'MATCH_CALENDAR');
    }
    check(match.predictionMeta == null || object(match.predictionMeta), 'MATCH_CUTOFF');
    const cutoffs = [['cutoffAt',match.cutoffAt],['cutoffTime',match.cutoffTime],['predictionMeta.cutoffTime',match.predictionMeta?.cutoffTime]]
      .filter(([,value])=>value!=null).map(([field,value])=>{
        const resolved=resolve(value,field);
        if(resolved.normalization) clockNormalizations.push({index,...resolved.normalization});
        return resolved.instant;
      });
    check(cutoffs.every(value => instant(value) !== null), 'MATCH_CUTOFF');
    if (match.cutoffAt != null && match.cutoffTime != null)
      check(instant(resolve(match.cutoffAt,'cutoffAt').instant)
        === instant(resolve(match.cutoffTime,'cutoffTime').instant), 'MATCH_CUTOFF');
    const missing = [];
    if (sourceId == null) missing.push('sourceMatchId');
    if (match.kickoffTime == null) missing.push('kickoffTime');
    if (!cutoffs.length && match.buyEndTime == null) missing.push('cutoff');
    if (missing.length) missingFields.push({ index, fields: missing });
  });
  const artifactKeys = new Set();
  for (const artifact of value.modelArtifactInventory) {
    check(object(artifact) && text(artifact.key, 256) && text(artifact.version, 128)
      && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256)
      && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && instant(artifact.generatedAt) !== null
      && !artifactKeys.has(artifact.key), 'ARTIFACT_METADATA');
    artifactKeys.add(artifact.key);
  }
  const modelKeys = new Set();
  for (const packet of value.modelArtifacts) {
    check(object(packet) && MODEL_ARTIFACT_KEYS.includes(packet.artifactKey) && !modelKeys.has(packet.artifactKey)
      && text(packet.artifactVersion, 128) && typeof packet.payloadSha256 === 'string' && /^[a-f0-9]{64}$/.test(packet.payloadSha256)
      && Number.isSafeInteger(packet.payloadBytes) && packet.payloadBytes > 0
      && instant(packet.generatedAt) !== null && instant(packet.updatedAt) !== null
      && instant(packet.generatedAt) <= instant(packet.updatedAt) && typeof packet.oversized === 'boolean', 'MODEL_ARTIFACT_PACKET');
    if (packet.oversized) check(packet.payloadJson === null && packet.payloadBytes > MAX_MODEL_ARTIFACT_BYTES, 'MODEL_ARTIFACT_OVERSIZED');
    else check(typeof packet.payloadJson === 'string' && packet.payloadBytes <= MAX_MODEL_ARTIFACT_BYTES
      && Buffer.byteLength(packet.payloadJson) === packet.payloadBytes && hash(packet.payloadJson) === packet.payloadSha256,
      'MODEL_ARTIFACT_PAYLOAD');
    modelKeys.add(packet.artifactKey);
  }
  return { matches: value.matches.length, inventory: value.modelArtifactInventory.length, modelArtifacts: value.modelArtifacts.length, missingFields, clockNormalizations };
}

module.exports={VERSION,IDENTITY_VERSION,MAX_MODEL_ARTIFACT_BYTES,MODEL_ARTIFACT_KEYS,MAX_MATCHES,MAX_INVENTORY,validDate,identityContextFor,validateResponse};
