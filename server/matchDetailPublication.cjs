'use strict';
// Display projection only. Original records and ACKs are verified by the
// shared adapter inside the caller's existing read-only RR snapshot.
const path = require('node:path');
const {seal} = require('../src/services/leagueBaselineModel.cjs');
const {epochNanoseconds:ns} = require('../src/services/prematchV3Clock.cjs');
const {loadVerifiedPublicationForIdentity} = require('../scripts/recommendationPlatform/publishedReviewCoverageRepository.cjs');
const check = (value,code) => {if(!value)throw Object.assign(Error(code),{code});};
function identityFor(match){
 const sourceMatchId=String(match?.sourceMatchId||'');
 check(/^[1-9][0-9]{0,19}$/.test(sourceMatchId)&&[sourceMatchId,`sporttery_${sourceMatchId}`,`fivehundred_${sourceMatchId}`].includes(match.id),'DETAIL_PUBLICATION_ID');
 check(ns(match.kickoffTime)!==null&&ns(match.eventVersion)===ns(match.kickoffTime)&&/^\d{4}-\d{2}-\d{2}$/.test(match.businessDate||'')
  &&typeof match.homeTeamId==='string'&&match.homeTeamId&&typeof match.awayTeamId==='string'&&match.awayTeamId
  &&match.homeTeamId!==match.awayTeamId&&match.homeTeamName&&match.awayTeamName,'DETAIL_PUBLICATION_EVENT');
 return {sourceMatchId,eventVersion:match.kickoffTime,businessDate:match.businessDate,homeTeamId:match.homeTeamId,awayTeamId:match.awayTeamId};
}
function sameIdentity(a,b){return a.sourceMatchId===b.sourceMatchId&&ns(a.eventVersion)!==null&&ns(a.eventVersion)===ns(b.eventVersion)
 &&['businessDate','homeTeamId','awayTeamId'].every(k=>a[k]===b[k]);}
function projectVerifiedPublication(match,loaded){
 const identity=identityFor(match),asOf=loaded.asOf;
 check(loaded.version==='verified-published-event-v1'&&sameIdentity(identity,loaded.identity)&&ns(asOf)!==null
  &&Array.isArray(loaded.publications)&&loaded.publications.length<=2,'DETAIL_PUBLICATION_BINDING');
 const tracks=new Set(),receipts=[];let reviewed=null,trained=null;
 for(const item of loaded.publications){
  const {track,record:r,publication:p}=item;
  check(['manual','trained'].includes(track)&&!tracks.has(track),'DETAIL_PUBLICATION_DUPLICATE');tracks.add(track);
  check(r.homeTeamName===match.homeTeamName&&r.awayTeamName===match.awayTeamName,'DETAIL_PUBLICATION_TEAMS');
  const event=track==='manual'?{...r,sourceMatchId:r.eventId}:r.forecast.event;
  check(sameIdentity(identity,event)&&ns(p.createdAt)!==null&&ns(p.createdAt)<ns(p.storedAt)
   &&ns(p.storedAt)<=ns(p.ackAt)&&ns(p.ackAt)<=ns(asOf),'DETAIL_PUBLICATION_CLOCK');
  check(ns(p.ackAt)<ns(track==='manual'?r.cutoffAt:r.forecast.cutoffAt),'DETAIL_PUBLICATION_CUTOFF');
  receipts.push({track,artifactKey:p.artifactKey,payloadSha256:p.payloadSha256,recordHash:p.recordHash,
   createdAt:p.createdAt,storedAt:p.storedAt,ackAt:p.ackAt,ackPayloadSha256:p.ackPayloadSha256});
  if(track==='manual'){
   // A single-event display view; original record bytes and publication hash
   // remain bound to the verified full batch. No combo or past-asOf replay.
   reviewed=seal({version:'reviewed-analysis-view-v1',businessDate:identity.businessDate,updatedAt:asOf,
    createdAt:p.createdAt,commitObservedAt:p.ackAt,publicationHash:p.recordHash,records:[r],combos:[],threeCombos:[],formalEligible:false});
  }else{
   const record=seal({version:'league-baseline-direction-view-v1',id:r.id,businessDate:r.businessDate,
    homeTeamName:r.homeTeamName,awayTeamName:r.awayTeamName,event:r.forecast.event,cutoffAt:r.forecast.cutoffAt,
    createdAt:r.createdAt,commitObservedAt:p.ackAt,modelVersion:r.modelVersion,modelHash:r.modelHash,
    parametersHash:r.parametersHash,recordHash:r.contentHash,forecastHash:r.forecastHash,
    direction:r.forecast.direction,grid:r.forecast.grid,comparisons:r.comparisons,formalEligible:false});
   trained={version:'league-baseline-directions-v1',businessDate:identity.businessDate,updatedAt:asOf,records:[record],blocked:0,formalEligible:false};
  }
 }
 return {version:'match-detail-publication-v1',status:receipts.length?'verified':'absent',identity,observedAt:asOf,receipts,reviewed,trained};
}
async function readMatchDetailPublication(client,match){
 // Always replace an untrusted persisted field. No raw snapshot can mint this
 // verified detail view merely by carrying a similarly named JSON member.
 try{
  const identity=identityFor(match);
  const asOf=(await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS observed_at")).rows[0]?.observed_at;
  const loaded=await loadVerifiedPublicationForIdentity(client,{asOf,targetIdentity:identity,
   trustRegistry:process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH||path.resolve(__dirname,'../deploy/light-server/collector-trust-registry.json')});
  return projectVerifiedPublication(match,loaded);
 }catch{return {version:'match-detail-publication-v1',status:'unavailable',reviewed:null,trained:null};}
}
module.exports={identityFor,sameIdentity,projectVerifiedPublication,readMatchDetailPublication};
