'use strict';
const lifecycle=require('../../src/services/matchLifecycle.cjs');
const {strictInstant}=require('../../src/services/strictInstant.cjs');
const {hash}=require('../../src/services/publishedForecastPolicy.cjs');
const SOURCES=new Set(['uefa:official-match-api','official-club:result-page','k-league:official-schedule-api']);
const epoch=value=>{const exact=strictInstant(value);return exact===null?NaN:Date.parse(exact);};

// Reuse the existing provider-specific identity, regular-time score and
// evidence-hash checks. This adapter admits customer-facing settlement only;
// organizer/club supplements must not become model-promotion evidence.
function supplementaryOfficialEvidence(row,now){
  try{
    const p=row?.resultProvenance;
    if(!Number.isFinite(now)||!p||!SOURCES.has(p.source)||!lifecycle.isTrustedOfficialFinal(row)
      ||lifecycle.isOfficialSportteryFinal(row)||String(row.resultDisposition||'').toUpperCase()==='VOID'
      ||typeof p.providerMatchId!=='string'||!p.providerMatchId.trim()
      ||row.resultObservationFallback===true||p.resultObservationFallback!==false)return null;
    const kickoff=epoch(row.kickoffTime),version=epoch(row.eventVersion),observed=epoch(row.resultObservedAt);
    if(!Number.isFinite(kickoff)||version!==kickoff||epoch(p.eventVersion)!==version
      ||epoch(p.providerKickoffTime)!==kickoff||!Number.isFinite(observed)||epoch(p.observedAt)!==observed
      ||observed<kickoff||observed>now)return null;
    const evidence={settlementOnly:true,promotionEligible:false,sourceResultObservedAt:new Date(observed).toISOString(),
      officialResultEvidence:{scoreHome:row.scoreHome,scoreAway:row.scoreAway,provenance:structuredClone(p)}};
    return {...evidence,officialResultEvidenceHash:hash({source:p.source,...evidence})};
  }catch{return null;}
}
function officialResultValidators(now){
  return {isFinal:row=>lifecycle.isOfficialSportteryFinal(row)||Boolean(supplementaryOfficialEvidence(row,now)),
    isVoid:lifecycle.isOfficialSportteryVoid,evidenceFor:row=>supplementaryOfficialEvidence(row,now)};
}
function validSupplementaryEventEvidence(event){
  if(!SOURCES.has(event?.source))return event?.settlementOnly===undefined&&event?.officialResultEvidence===undefined
    &&event?.officialResultEvidenceHash===undefined;
  if(event.settlementOnly!==true||event.promotionEligible!==false)return false;
  const proof=event.officialResultEvidence,p=proof?.provenance;
  if(!proof||p?.source!==event.source||!['FINAL','DISPUTED'].includes(event.state))return false;
  if(event.state==='FINAL'&&(proof.scoreHome!==event.scoreHome||proof.scoreAway!==event.scoreAway))return false;
  const expected=supplementaryOfficialEvidence({sourceMatchId:event.sourceMatchId,eventVersion:event.eventVersion,
    kickoffTime:event.eventVersion,status:'FINISHED',scoreHome:proof.scoreHome,scoreAway:proof.scoreAway,
    resultObservedAt:event.sourceResultObservedAt,resultProvenance:p},epoch(event.observedAt));
  return Boolean(expected&&expected.officialResultEvidenceHash===event.officialResultEvidenceHash);
}
function resultAllowsCalibration(event){return event?.settlementOnly!==true&&!SOURCES.has(event?.source);}
module.exports={supplementaryOfficialEvidence,officialResultValidators,validSupplementaryEventEvidence,resultAllowsCalibration};
