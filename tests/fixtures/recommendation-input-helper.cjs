'use strict';
// Synthetic arithmetic fixture, never production provenance. Every stage uses
// the real receipt builder and verifier; no eligibility booleans are injected.
const {createHash}=require('node:crypto');
const {recordModelInputUsage}=require('../../src/services/modelInputUsage.cjs');
const {executeWithPredictionClock,predictionNowIso}=require('../../src/services/predictionExecutionClock.cjs');
const {buildInputEvidence}=require('../../src/services/recommendationInputEvidence.cjs');
function withVerifiedInputEvidence(match,options={}){
 const result=structuredClone(match),old=result.probabilityModel||{};
 const sourceMatchId=String(result.sourceMatchId||result.id||'').replace(/^sporttery_/,'');result.sourceMatchId=sourceMatchId;
 const at=Date.parse(old.generatedAt||options.generatedAt||'2026-09-22T07:00:00Z');
 const final=old.oneXTwo?.final||{home:50,draw:25,away:25},total=Object.values(final).reduce((a,b)=>a+b,0),p=Object.fromEntries(['home','draw','away'].map(k=>[k,final[k]/total]));
 const weights={market:.1,teamStrength:.15,elo:.3,poisson:.45,worldCupPrior:0,...options.weights};
 const formWeight=options.formWeight??0,homeLambda=1.2,awayLambda=1;
 const formCandidates=formWeight>0?[{source:'training-history',homeLambda,awayLambda,confidence:.8,fallbackMetrics:[]}]:[];
 const clockBody={version:'prediction-execution-clock-v1',events:[{operation:'iso',millis:at-2},{operation:'iso',millis:at-1},{operation:'iso',millis:at}],sourceVerified:false,scope:'local calculation clock reads; not provider observation, publication time or source attestation'};
 const replay={...clockBody,contentHash:createHash('sha256').update(JSON.stringify(clockBody)).digest('hex')};
 const output=executeWithPredictionClock(()=>{
  const form=recordModelInputUsage(result,'form-lambda-blend',{before:{home:homeLambda,away:awayLambda},candidates:formCandidates,weight:formWeight,output:{home:homeLambda,away:awayLambda}});
  const inputs={market:p,teamStrength:p,elo:p,poisson:p,worldCupPrior:weights.worldCupPrior?p:null};
  const raw=Object.fromEntries(['home','draw','away'].map(k=>[k,Object.keys(weights).reduce((n,key)=>n+(inputs[key]?.[k]||0)*weights[key],0)]));
  const sum=Object.values(raw).reduce((a,b)=>a+b,0),base=Object.fromEntries(['home','draw','away'].map(k=>[k,raw[k]/sum]));
  const blend=recordModelInputUsage(result,'base-outcome-blend',{weights,inputs,output:base,marketPool:result.odds?'HAD':null,marketSource:result.oddsSource||null});
  return {probabilityModel:{...old,version:old.version||'synthetic-input-evidence-test-v1',generatedAt:predictionNowIso(),sourceMatchId,eventVersion:result.eventVersion||result.kickoffTime,oneXTwo:{...old.oneXTwo,final:structuredClone(final)},elo:{...old.elo,homeMatches:options.eloHome??12,awayMatches:options.eloAway??12},form:{...old.form,home:{...old.form?.home,sampleSize:options.formHome??0},away:{...old.form?.away,sampleSize:options.formAway??0}},ensembleWeights:weights,lambdaBlend:{...old.lambdaBlend,formWeight:Number(formWeight.toFixed(3))},calibrationAdjustment:{oneXTwo:{before:Object.fromEntries(['home','draw','away'].map(k=>[k,Number((base[k]*100).toFixed(1))])),after:structuredClone(final)}},inputUsage:[form,blend]}};
 },replay);
 result.probabilityModel=output.probabilityModel;
 result.probabilityModel.inputEvidence=buildInputEvidence(result.probabilityModel,result);
 return result;
}
module.exports={withVerifiedInputEvidence};
