'use strict';
const {stableHash}=require('./webConsensusEvidence.cjs');
const {epochNanoseconds:clock}=require('./prematchV3Clock.cjs');
const {verifyPrematchV3Assessment}=require('./prematchV3Assessment.cjs');
const {RECORD_VERSION,predictionRecordHash}=require('./prematchV3Learning.cjs');
function seal(body) {return {...body,contentHash:stableHash(body)};}
function freezePrematchV3Record(assessment,originalInputs) {
  if (!verifyPrematchV3Assessment(assessment,originalInputs) || assessment.baseline.status!=='shadow-ready'
    || !assessment.comparisons.marketOnly.available || assessment.teamSnapshot.observations.length===0) return null;
  const {event,asOf,teamSnapshot:snapshot,baseline,comparisons}=assessment;
  if (clock(asOf)===null || clock(event.cutoffAt)===null || clock(asOf)>=clock(event.cutoffAt)
    || clock(baseline.baseRatesEvidence?.availableAt)===null || clock(baseline.baseRatesEvidence.availableAt)>=clock(asOf)) return null;
  const latest = snapshot.observations.reduce((a,row)=>clock(row.receivedAt)>clock(a)?row.receivedAt:a,snapshot.observations[0].receivedAt);
  const body={version:RECORD_VERSION,frozen:true,formalEligible:false,productionEligible:false,
    event:{sourceMatchId:event.sourceMatchId,eventVersion:event.eventVersion,cutoffAt:event.cutoffAt,homeTeamId:event.homeTeamId,awayTeamId:event.awayTeamId},
    asOf,frozenAt:asOf,featureKnownAt:latest,featureSchemaHash:snapshot.featureSchemaHash,featureSnapshotHash:snapshot.contentHash,
    featureVector:structuredClone(snapshot.features),baseRates:structuredClone(baseline.baseRates),baseRatesEvidence:structuredClone(baseline.baseRatesEvidence),
    market:{source:comparisons.marketOnly.source,sourceHash:comparisons.marketOnly.sourceHash,
      observedAt:comparisons.marketOnly.observedAt,receivedAt:comparisons.marketOnly.receivedAt,asOf,
      probabilities:structuredClone(comparisons.marketOnly.probabilities)},result:null,
    evidenceScope:'new-V3-shadow-freeze;source-admission-and-formal-accuracy-not-established'};
  // The result is excluded from predictionHash so a later result observation
  // can form a new research join without modifying the original prediction.
  body.predictionHash=predictionRecordHash(body);
  return seal(body);
}
function joinPrematchV3ResearchResult(record,result) {
  if (!record || record.version!==RECORD_VERSION || record.frozen!==true) throw Error('V3_FREEZE_RECORD_REQUIRED');
  const {contentHash,...body}=record;
  if(stableHash(body)!==contentHash || predictionRecordHash(record)!==record.predictionHash) throw Error('V3_FREEZE_RECORD_HASH_INVALID');
  const match=result?.match;
  const eventClock=clock(record.event?.eventVersion), resultClock=clock(match?.eventVersion||match?.kickoffTime);
  if(!match || match.sourceMatchId!==record.event.sourceMatchId || match.homeTeamId!==record.event.homeTeamId
    || match.awayTeamId!==record.event.awayTeamId || eventClock===null || resultClock!==eventClock
    || (match.eventVersion!==undefined && clock(match.eventVersion)!==eventClock)
    || (match.kickoffTime!==undefined && clock(match.kickoffTime)!==eventClock)) throw Error('V3_FREEZE_RESULT_EVENT_MISMATCH');
  const joined=seal({...body,result:structuredClone(result)});
  if(predictionRecordHash(joined)!==record.predictionHash) throw Error('V3_FREEZE_PREDICTION_CHANGED');
  // Confidence, 90-minute trust and result clocks are still checked by the
  // learner. A join alone is never a settled/qualified recommendation.
  return joined;
}
module.exports={freezePrematchV3Record,joinPrematchV3ResearchResult};
