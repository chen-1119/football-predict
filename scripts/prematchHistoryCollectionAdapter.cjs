'use strict';
const {stableHash}=require('../src/services/webConsensusEvidence.cjs');
const {epochNanoseconds:clock}=require('../src/services/prematchV3Clock.cjs');
const {validate,targetsFor,validLedgerResultForRow}=require('./readPrematchV3TeamHistory.cjs');
const {validateTransport}=require('./readPrematchV3OnlineInputs.cjs');
const {eventFromMatch}=require('../src/services/prematchV3Assessment.cjs');
const VERSION='prematch-v3-ledger-history-facts-v1';
// Callers must bind this receipt to its original pinned raw bytes before use.
// This adapter cannot authenticate the external provider from a PG JSON hash.
function adaptLedgerTeamHistory({history,input,event,side,asOf}={}){
 const blocked=reason=>({status:'blocked',reason,teamObservations:[],formalEligible:false});
 try{
  if(!history||!input||!event||!['home','away'].includes(side))return blocked('history-binding-incomplete');
  const {contentHash,...body}=history;
  if(stableHash(body)!==contentHash||history.formalEligible!==false||history.productionWrites!==0)return blocked('history-content-binding-invalid');
  validate(history,targetsFor(input));validateTransport(history.transport,history.observedAt);
  if(history.targetReadRemoteSha256!==input.transport?.remoteResponseSha256)return blocked('history-target-read-mismatch');
  const now=clock(asOf),read=clock(history.observedAt),received=clock(history.transport.finishedAt),cutoff=clock(event.cutoffAt),kickoff=clock(event.eventVersion);
  if([now,read,received,cutoff,kickoff].some(v=>v===null)||(event.kickoffTime!=null&&clock(event.kickoffTime)!==kickoff)||read>received||read>now||received>now||now>=cutoff||cutoff>kickoff
   ||!event.sourceMatchId||event.homeTeamId===event.awayTeamId)return blocked('history-event-clock-ineligible');
  const target=input.matches.find(m=>m.sourceMatchId===event.sourceMatchId);
  if(!target||clock(target.eventVersion)!==kickoff||target.homeTeamId!==event.homeTeamId||target.awayTeamId!==event.awayTeamId)return blocked('history-target-event-mismatch');
  const targetEvent=eventFromMatch(target);
  if(clock(targetEvent.cutoffAt)!==cutoff||clock(targetEvent.kickoffTime)!==kickoff||targetEvent.status!=='SCHEDULED'
    ||targetEvent.isOnSale===false||['CLOSED','STOPPED','SUSPENDED'].includes(String(targetEvent.saleStatus||'').toUpperCase())
    ||target.resultDisposition==='VOID')return blocked('history-target-sale-or-cutoff-ineligible');
  const teamId=event[side+'TeamId'],teamName=target[side+'TeamName'];
  const rows=history.rows.filter(r=>r.teamId===teamId&&r.teamName===teamName&&r.resultHead?.source==='sporttery:official-api'
    &&validLedgerResultForRow(r,{observedAt:history.observedAt})&&clock(r.resultHead.observedAt)<=received
    &&clock(r.resultHead.eventVersion)<kickoff&&r.sourceMatchId!==event.sourceMatchId
    &&r.scoreHome<=30&&r.scoreAway<=30);
  if(!rows.length)return blocked('no-bound-official-ledger-history');
  const facts=rows.map(row=>({sourceMatchId:row.sourceMatchId,eventVersion:row.resultHead.eventVersion,teamId,status:'FINISHED',
   providerObservedAt:row.resultHead.observedAt,receivedAt:history.transport.finishedAt,
   clockBasis:'production-ledger-result-observed',sourcePublishedAt:null,
   source:{provider:'production-pg:sporttery-official-result-ledger',endpoint:'football.recommendation_result_heads',
    receiptHash:history.contentHash,rawPayloadHash:history.transport.remoteResponseSha256,rowHash:stableHash(row)},
   goalsFor:row.homeTeamId===teamId?row.scoreHome:row.scoreAway,
   goalsAgainst:row.homeTeamId===teamId?row.scoreAway:row.scoreHome}));
  return {version:VERSION,status:'captured',formalEligible:false,sourceVerification:'unverified-external-source; bound-admitted-PG-result-facts',
   historyRows:facts.length,completeTeamHistory:false,restDays:null,reason:'bounded-ledger-sample; not-proof-of-the-most-recent-match-or-actual-end-time',
   teamObservations:[{family:'history',side,sourceMatchId:event.sourceMatchId,eventVersion:event.eventVersion,teamId,
    providerObservedAt:history.observedAt,receivedAt:history.transport.finishedAt,
    clockBasis:'postgres-read-snapshot-observation',sourcePublishedAt:null,
    source:{provider:'production-pg:bound-team-history',endpoint:'football.recommendation_result_heads',
     receiptHash:history.contentHash,rawPayloadHash:history.transport.remoteResponseSha256},data:{rows:facts}}]};
 }catch{return blocked('history-validation-failed');}
}
module.exports={VERSION,adaptLedgerTeamHistory};
