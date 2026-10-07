'use strict';
// Pure event/PG admission sidecar. Original match and endpoint bytes stay intact.
const {strictInstant}=require('./strictInstant.cjs');
const {epochNanoseconds:clock}=require('./prematchV3Clock.cjs');
const {sha256CollectorJson:hash}=require('./collectorAttestation.cjs');
const VERSION='prematch-v3-input-identity-v1';
const CURRENT_SNAPSHOT_NAMESPACE='/var/lib/football-predict/sporttery-relay-fast-lane.json';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=256
  &&![...v].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127||c.charCodeAt(0)===65533);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(v,names)=>object(v)&&Object.keys(v).sort().join(',')===[...names].sort().join(',');
const pgClock=v=>typeof v==='string'?v.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00'):null;
const exact=(a,b)=>clock(a)!==null&&clock(a)===clock(b);
function publicationFromMeta(meta) {
  if(!object(meta))return null;
  return {mode:meta.data_publication_mode,generationId:meta.data_generation_id,manifestHash:meta.manifest_hash,
    sourceCycleId:meta.data_generation_source_cycle_id,committedAt:meta.committed_at};
}
function validPublication(p,observedAt) {
  return keys(p,['mode','generationId','manifestHash','sourceCycleId','committedAt'])&&p.mode==='active-generation'
    &&text(p.generationId)&&hex(p.manifestHash)&&text(p.sourceCycleId)&&clock(p.committedAt)!==null
    &&clock(observedAt)!==null&&clock(p.committedAt)<=clock(observedAt);
}
function createPrematchV3InputIdentity({match,row,publication,endpoint,pgObservedAt,inputCapturedAt,trustRegistry}={}) {
  try {
    if(!object(match)||!keys(row,['dataset','match_id','source_match_id','kickoff_time'])||row.dataset!=='current'
      ||row.match_id!==match.id||row.source_match_id!==match.sourceMatchId
      ||!exact(pgClock(row.kickoff_time),match.kickoffTime)||!exact(match.eventVersion,match.kickoffTime)
      ||!validPublication(publication,pgObservedAt)||clock(inputCapturedAt)===null
      ||clock(pgObservedAt)>clock(inputCapturedAt)||match.sourceCycleId!==publication.sourceCycleId
      ||clock(match.sourceObservedAt)===null||clock(match.sourceReceivedAt)===null
      ||clock(match.sourceObservedAt)>clock(match.sourceReceivedAt)||clock(match.sourceReceivedAt)>clock(pgObservedAt))return null;
    // Lazy loading avoids liveOfficialHad -> prospectiveInput -> assessment's
    // module cycle. The identity function requires an external trusted registry.
    const current=require('../../scripts/recommendationPlatform/liveOfficialHad.cjs')
      .verifySignedCurrentEventIdentity(match,endpoint,{asOf:inputCapturedAt,trustRegistry});
    if(!current)return null;
    const body={version:VERSION,canonicalId:match.id,sourceMatchId:match.sourceMatchId,
      matchHash:hash(match),row:structuredClone(row),publication:structuredClone(publication),pgObservedAt,inputCapturedAt,
      currentEventIdentity:current,collectorTrustRegistryHash:hash(trustRegistry),
      cutoffAt:current.saleCutoff,formalEligible:false,productionEligible:false,
      authority:'exact-PG-row-and-current-collector-signature;not-route-alias-source-license-or-model-admission'};
    return {...body,contentHash:hash(body)};
  }catch{return null;}
}
function verifyPrematchV3InputIdentity(proof,context={}) {
  try {
    const expected=createPrematchV3InputIdentity(context);
    return Boolean(expected&&keys(proof,Object.keys(expected))&&hash(proof)===hash(expected));
  }catch{return false;}
}
// Collection may attach newly captured, still unverified research facts to a
// detached match. Replay the original PG match first; only that one fact slot
// may differ. The original sidecar is never re-stamped for the derived object.
function verifyPrematchV3AssessmentIdentity(proof,context={}) {
  try {
    const {match,originalMatch}=context,base=originalMatch??match;
    if(!object(match)||!object(base)||!verifyPrematchV3InputIdentity(proof,{...context,match:base}))return false;
    if(hash(match)===hash(base))return true;
    if(!object(match.externalSignals)||!Object.hasOwn(match.externalSignals,'prematchV3')
      ||(base.externalSignals!=null&&!object(base.externalSignals)))return false;
    const expected={...base,externalSignals:{...(base.externalSignals||{}),prematchV3:match.externalSignals.prematchV3}};
    return hash(expected)===hash(match);
  }catch{return false;}
}
function resolveIdentityDeadline(match,value,{field='buyEndTime',identityAdmission,identityContext}={}) {
  const zoned=strictInstant(value);
  if(zoned)return {instant:zoned,normalization:null};
  if(!verifyPrematchV3AssessmentIdentity(identityAdmission,{...identityContext,match})
    ||typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ||(field!=='buyEndTime'&&value!==match.buyEndTime))return {instant:null,normalization:null};
  const instant=strictInstant(value.replace(' ','T')+'+08:00');
  return {instant,normalization:instant?{field,raw:value,instant,timeZone:'Asia/Shanghai',
    basis:'collector-signed-current-event-and-exact-PG-row',copiedFrom:field==='buyEndTime'?null:'buyEndTime'}:null};
}
module.exports={VERSION,CURRENT_SNAPSHOT_NAMESPACE,publicationFromMeta,validPublication,createPrematchV3InputIdentity,verifyPrematchV3InputIdentity,verifyPrematchV3AssessmentIdentity,resolveIdentityDeadline};
