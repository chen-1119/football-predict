'use strict';
const {attestPublicReferenceDecision}=require('./publicReferenceDecision.cjs');
const {time}=require('./publishedForecastPolicy.cjs');
const VERSION='recommendation-cross-track-conflict-v1';
const sourceId=value=>String(value||'').replace(/^sporttery_/,'');

// The reference must already have been recorded when this comparison is made.
// A result-phase archive is never admissible evidence for a pre-match gate.
function crossTrackConflict(match,decision,asOf){
 if(!match||!decision||!Number.isFinite(asOf)||sourceId(match.sourceMatchId||match.id)!==sourceId(decision.sourceMatchId)
   ||time(match.eventVersion||match.kickoffTime)!==time(decision.eventVersion)
   ||match.homeTeamId!==decision.homeTeamId||match.awayTeamId!==decision.awayTeamId)return null;
 const reference=attestPublicReferenceDecision(match.predictionMeta?.publicReferenceDecision,match);
 if(reference?.version!=='public-reference-decision-v2'||!reference.evidenceBinding
   ||reference.prediction?.oddsPoolCode!=='HAD')return null;
 const recordedAt=time(reference.recordedAt),cutoff=time(decision.cutoffTime);
 if(!Number.isFinite(recordedAt)||recordedAt>asOf||!Number.isFinite(cutoff)||recordedAt>=cutoff
   ||reference.prediction.tipCode===decision.tipCode)return null;
 return {version:VERSION,reason:'cross-track-direction-conflict',sourceMatchId:decision.sourceMatchId,
  eventVersion:decision.eventVersion,market:'HAD',publishedTipCode:decision.tipCode,
  referenceTipCode:reference.prediction.tipCode,referenceRecordedAt:reference.recordedAt,
  referenceHash:reference.contentHash,knownAtPublication:recordedAt<=time(decision.publishedAt)};
}
function conflictForDecision(matches,decision,asOf){
 const found=(matches||[]).map(match=>crossTrackConflict(match,decision,asOf)).filter(Boolean);
 if(!found.length)return null;
 // Multiple valid records with different identities or directions are not a
 // license to choose whichever one fits a result. Conservatively abstain.
 return found.sort((a,b)=>time(b.referenceRecordedAt)-time(a.referenceRecordedAt))[0];
}
module.exports={VERSION,crossTrackConflict,conflictForDecision};
