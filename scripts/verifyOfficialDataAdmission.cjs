"use strict";
const assert=require("node:assert/strict");
const {admitOfficialDataStep}=require("./officialDataAdmission.cjs");
(async()=>{
  let drained=0;
  const heartbeat={waitForIdle:async()=>{drained++;return {ok:false,reason:"publication-identity-not-ready"};},
    waitForHealthy:()=>{throw Error("data must not await model readiness");},waitForStartupAdmission:()=>new Promise(()=>{})};
  for(const step of ["sync:data","sync:free-football","sync:prematch","reconcile:fast-results-generation:official","datastore:generation:official","postgres:sync:official","datastore:sqlite:official"]){
    const result=await admitOfficialDataStep(step,heartbeat);assert.equal(result.admitted,true);assert.equal(result.candidateCaptureOk,false);assert.equal(result.formalRecommendationAdmitted,false);
  }
  assert.equal(drained,7);
  for(const step of ["model:backtest","model:learn","optimize:strategy","unknown"]){assert.equal((await admitOfficialDataStep(step,heartbeat)).admitted,false);}
  assert.equal(drained,7);assert.equal((await admitOfficialDataStep("sync:data",null)).admitted,true);
  console.log(JSON.stringify({ok:true,officialSteps:7,modelStagesStillRequireReadiness:true,failedCapturePreserved:true}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
