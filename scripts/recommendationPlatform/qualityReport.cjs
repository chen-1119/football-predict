'use strict';

// Offline evaluation of immutable, genuinely published predictions. It never
// trains on its evaluation rows, writes production data or promotes a model.
const {validDecision}=require('./decision.cjs');
const {hash}=require('../../src/services/publishedForecastPolicy.cjs');
const CODES=['1','X','2'];
const POLICY=Object.freeze({version:'frozen-quality-review-v1',minimumSettled:100,minimumMatchDays:7});
function wilson(won,total){
  if(!total)return null;const z=1.959963984540054,p=won/total,den=1+z*z/total;
  const center=(p+z*z/(2*total))/den,spread=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/den;
  return {lower:Math.max(0,center-spread),upper:Math.min(1,center+spread)};
}
function measure(rows){
  let won=0,brier=0,marketBrier=0,logLoss=0,marketLogLoss=0,marketWon=0,marketTied=0;
  for(const {decision:d,settlement:s} of rows){
    won+=Number(d.tipCode===s.actual);const marketTop=CODES.find(c=>CODES.every(other=>other===c||d.marketProbabilities[c]>d.marketProbabilities[other]+1e-12));if(marketTop)marketWon+=Number(marketTop===s.actual);else marketTied++;
    for(const c of CODES){brier+=(d.probabilities[c]-Number(c===s.actual))**2;marketBrier+=(d.marketProbabilities[c]-Number(c===s.actual))**2;}
    logLoss-=Math.log(Math.max(1e-15,d.probabilities[s.actual]));marketLogLoss-=Math.log(Math.max(1e-15,d.marketProbabilities[s.actual]));
  }
  const marketUnique=rows.length-marketTied;
  return {settled:rows.length,won,hitRate:rows.length?won/rows.length:null,hitRateInterval95:wilson(won,rows.length),marketTopWins:marketWon,marketUniqueTopSettled:marketUnique,marketTied,marketTopHitRate:marketUnique?marketWon/marketUnique:null,brier:rows.length?brier/rows.length:null,marketBrier:rows.length?marketBrier/rows.length:null,logLoss:rows.length?logLoss/rows.length:null,marketLogLoss:rows.length?marketLogLoss/rows.length:null};
}
function buildQualityReport(input,{asOf=Date.now()}={}){
  if(!Array.isArray(input)||!Number.isFinite(asOf))throw new Error('Published rows and finite asOf are required');
  const latest=new Map(),exclusions={invalid:0,future:0,unsettled:0,marketMissing:0,resultMismatch:0,ambiguous:0};
  for(const row of input){
    const d=row?.decision;if(!validDecision(d)){exclusions.invalid++;continue;}
    if(Date.parse(d.publishedAt)>asOf||Date.parse(d.kickoffTime)>asOf){exclusions.future++;continue;}
    const key=JSON.stringify([d.sourceMatchId,d.eventVersion]),publishedAt=Date.parse(d.publishedAt),old=latest.get(key);
    const signature=hash({decisionId:d.decisionId,decisionRecordHash:d.recordHash,settlement:row.settlement??null});
    // A timestamp alone cannot order two different published records or
    // conflicting result snapshots. Retain the ambiguity until a genuinely
    // later publication replaces it; an identical retry is just one sample.
    if(!old||publishedAt>old.publishedAt)latest.set(key,{row,publishedAt,signature,ambiguous:false});
    else if(publishedAt===old.publishedAt&&signature!==old.signature)old.ambiguous=true;
  }
  const settled=[];
  for(const item of latest.values()){
    if(item.ambiguous){exclusions.ambiguous++;continue;}
    const row=item.row;
    const d=row.decision,s=row.settlement;
    if(!s||!['WON','LOST'].includes(s.state)){exclusions.unsettled++;continue;}
    if(!CODES.includes(s.actual)||!s.resultEventId||(d.tipCode===s.actual)!==(s.state==='WON')){exclusions.resultMismatch++;continue;}
    if(!d.marketProbabilities||!CODES.every(c=>Number.isFinite(d.marketProbabilities[c])&&d.marketProbabilities[c]>=0&&d.marketProbabilities[c]<=1)||Math.abs(CODES.reduce((n,c)=>n+d.marketProbabilities[c],0)-1)>1e-6){exclusions.marketMissing++;continue;}
    settled.push(row);
  }
  const days=[...new Set(settled.map(r=>r.decision.businessDate))].sort(),overall=measure(settled),blockers=[];
  if(settled.length<POLICY.minimumSettled)blockers.push('insufficient-settled-events');
  if(days.length<POLICY.minimumMatchDays)blockers.push('insufficient-independent-match-days');
  if(overall.brier===null||overall.brier>=overall.marketBrier)blockers.push('no-brier-advantage-over-same-event-market');
  if(overall.logLoss===null||overall.logLoss>=overall.marketLogLoss)blockers.push('no-logloss-advantage-over-same-event-market');
  const daily=days.map(date=>({date,priorMatchDays:days.filter(d=>d<date).length,priorSettled:settled.filter(r=>r.decision.businessDate<date).length,...measure(settled.filter(r=>r.decision.businessDate===date))}));
  const bands=[[0,.4],[.4,.5],[.5,.6],[.6,1.000001]].map(([min,max])=>{const rows=settled.filter(r=>r.decision.modelProbability>=min&&r.decision.modelProbability<max);return{minimum:min,maximum:Math.min(1,max),meanPredicted:rows.length?rows.reduce((n,r)=>n+r.decision.modelProbability,0)/rows.length:null,...measure(rows)};});
  return {version:POLICY.version,asOf:new Date(asOf).toISOString(),policy:POLICY,scope:'published-final-precutoff-per-event',interpretation:'observational-frozen-prediction-evaluation-not-a-trained-backtest',independentMatchDays:days.length,overall,daily,confidenceBands:bands,exclusions,preliminaryEvidenceSufficient:blockers.length===0,blockers,formalPromotion:false};
}
if(require.main===module){
 const fs=require('fs'),args=process.argv.slice(2),at=args.indexOf('--input'),out=args.indexOf('--output');if(at<0||!args[at+1])throw new Error('Use --input <saved-audit.json> [--output <report.json>]');
 const input=JSON.parse(fs.readFileSync(args[at+1],'utf8')),report=buildQualityReport(input.singles||input.recommendationCenter?.review?.singles||[],{asOf:input.at?Date.parse(input.at):Date.now()});
 const json=JSON.stringify(report,null,2);if(out>=0&&args[out+1])fs.writeFileSync(args[out+1],json);console.log(json);
}
module.exports={POLICY,wilson,measure,buildQualityReport};
