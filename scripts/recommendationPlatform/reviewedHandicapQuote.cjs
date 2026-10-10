'use strict';
const {verifySignedCurrentEventIdentity}=require('./liveOfficialHad.cjs');
const {extractionFromSportteryPool,verifyCollectorAttestation,sha256CollectorJson}=require('../../src/services/collectorAttestation.cjs');
const {expectedCollectorCommitment}=require('../../server/relayCollectorEvidence.cjs');
const {epochNanoseconds}=require('../../src/services/prematchV3Clock.cjs');
// Use the actual HHAD pool in the signed current endpoint. HAD availability
// does not grant HHAD permission, and neither market supplies the other's SP.
function reviewedHandicapQuote(input,endpoint,{asOf,trustRegistry,line}={}){
 const identity=verifySignedCurrentEventIdentity(input,endpoint,{asOf,trustRegistry});
 if(!identity||input.status!=='SCHEDULED'||input.isOnSale===false||input.predictionMeta?.lockedAt||input.predictionMeta?.lockedReason)return null;
 const rows=endpoint.payload.value.matchInfoList.flatMap(g=>g.subMatchList).filter(r=>String(r.matchId)===identity.identity.sourceMatchId);
 if(rows.length!==1)return null;
 const row=rows[0],sales=(row.poolList||[]).filter(p=>p.poolCode==='HHAD'),pools=(row.oddsList||[]).filter(p=>p.poolCode==='HHAD');
 const one=v=>v===1||v==='1';
 if(row.matchStatus!=='Selling'||!one(row.sellStatus)||sales.length!==1||pools.length!==1
  ||sales[0].poolStatus!=='Selling'||!one(sales[0].cbtValue)||!one(sales[0].cbtAllUp))return null;
 const pool=pools[0];
 if(!Number.isSafeInteger(line)||line===0||Math.abs(line)>12||pool.goalLine==null||pool.goalLine===''||typeof pool.goalLine==='boolean'||Number(pool.goalLine)!==line)return null;
 const values=[pool.h,pool.d,pool.a];
 if(values.some(v=>!(typeof v==='string'||typeof v==='number')||!/^\d+(?:\.\d{1,4})?$/.test(String(v))||!Number.isFinite(Number(v))||Number(v)<=1||Number(v)>=1000))return null;
 const present=[pool.updateDate,pool.updateTime].some(v=>v!=null&&v!=='');
 const provider=present?epochNanoseconds(`${pool.updateDate}T${pool.updateTime}+08:00`):null;
 if(present&&(provider===null||provider>epochNanoseconds(endpoint.receivedAt)))return null;
 const extraction=extractionFromSportteryPool({row,poolRow:pool,poolCode:'HHAD',fallbackProviderObservedAt:endpoint.providerObservedAt});
 const proof=verifyCollectorAttestation(endpoint.collectorAttestation,{trustRegistry,payload:endpoint.payload,
  expected:{...expectedCollectorCommitment(endpoint),marketExtractionHash:extraction.hash}});
 if(!proof.eligible)return null;
 const receipt={version:'reviewed-signed-current-hhad-v1',identityHash:identity.contentHash,market:'HHAD',handicap:line,
  odds:{h:Number(pool.h),d:Number(pool.d),a:Number(pool.a)},observedAt:endpoint.receivedAt,
  cutoffAt:identity.saleCutoff,extractionHash:extraction.hash,rowHash:sha256CollectorJson(row)};
 return {...receipt,receiptHash:sha256CollectorJson(receipt)};
}
module.exports={reviewedHandicapQuote};
