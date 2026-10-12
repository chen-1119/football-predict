'use strict';
// Synthetic signed acquisition fixture, never provider or production evidence.
const {match,NOW}=require('../recommendationFixture.cjs');
const {derivedTeamId}=require('../../scripts/storedResultTeamIdentity.cjs');
const {createCollectorKeyPair,buildCollectorCommitment,signCollectorCommitment,sha256CollectorJson}=require('../../src/services/collectorAttestation.cjs');
const {SPORTTERY_CURRENT_URL}=require('../../scripts/sportteryEndpointContract.cjs');
const stamp=n=>new Date(n).toISOString();
function source(id=1,modelAt=NOW-30*60000){
  const m=match(id,modelAt,{eventVersion:'2026-09-17T15:00:00.000Z',matchNo:'周四00'+id,
    oddsReceivedAt:stamp(NOW-30*60000),oddsUpdatedAt:stamp(NOW-30*60000)});
  return {...m,homeTeamId:derivedTeamId(m.homeTeamName),awayTeamId:derivedTeamId(m.awayTeamName)};
}
function snapshot(rows,{receivedAt=NOW-1000,requestedAt=receivedAt-500,mutate=()=>{},pair=createCollectorKeyPair({keyId:'integration-had',independenceDomain:'synthetic-integration'})}={}){
  const payload={success:true,value:{matchInfoList:[{businessDate:'2026-09-17',subMatchList:rows.map(m=>({matchId:Number(m.sourceMatchId),businessDate:m.businessDate,
    matchDate:'2026-09-17',matchTime:'23:00:00',matchNumStr:m.matchNo,homeTeamAllName:m.homeTeamName,awayTeamAllName:m.awayTeamName,
    matchStatus:'Selling',sellStatus:1,oddsList:[{poolCode:'HAD',h:1.8,d:3.5,a:4.5,goalLine:''}],
    poolList:[{poolCode:'HAD',poolStatus:'Selling',cbtValue:1,cbtAllUp:1,cbtSingle:0,intValue:2,intAllUp:0,intSingle:0}]}))}]} };
  const entry={method:'current',page:null,ok:true,url:SPORTTERY_CURRENT_URL,requestedAt:stamp(requestedAt),receivedAt:stamp(receivedAt),sourceCycleId:'synthetic-current-cycle',payload,
    sourceRequest:{method:'GET',url:SPORTTERY_CURRENT_URL,page:null,role:'current'},httpStatus:200,contentType:'application/json',rawSha256:'b'.repeat(64),rawBytes:500,headersSha256:'a'.repeat(64)};
  mutate(entry);entry.canonicalPayloadSha256=sha256CollectorJson(entry.payload);
  const commitment=buildCollectorCommitment({endpoint:entry.sourceRequest,collectorCycleId:entry.sourceCycleId,requestedAt:entry.requestedAt,receivedAt:entry.receivedAt,
    response:{httpStatus:entry.httpStatus,contentType:entry.contentType,rawSha256:entry.rawSha256,rawBytes:entry.rawBytes,headersSha256:entry.headersSha256},
    payload:entry.payload,canonicalPayloadSha256:entry.canonicalPayloadSha256});
  entry.collectorAttestation=signCollectorCommitment(commitment,{keyId:pair.keyId,privateKeyPem:pair.privateKeyPem});
  return {snapshot:{endpoints:[entry]},registry:pair.registry,pair};
}
module.exports={source,snapshot,stamp,NOW};
