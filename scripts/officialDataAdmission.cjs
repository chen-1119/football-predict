"use strict";
const officialDataSteps=new Set(["sync:data","sync:free-football","sync:prematch",
  "reconcile:fast-results-generation:official","datastore:generation:official",
  "postgres:sync:official","datastore:sqlite:official"]);
async function admitOfficialDataStep(step,heartbeat){
  if(!officialDataSteps.has(step))return {admitted:false};
  // Drain the current bounded capture to limit memory contention. Its model
  // readiness cannot gate the data publication needed to repair its inputs.
  const attempt=await heartbeat?.waitForIdle();
  return {admitted:true,step,candidateCaptureOk:attempt?.ok===true,
    candidateCaptureReason:attempt?.reason||null,formalRecommendationAdmitted:false};
}
module.exports={admitOfficialDataStep};
