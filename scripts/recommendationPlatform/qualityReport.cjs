'use strict';

// Offline evaluation of immutable, genuinely published predictions. It never
// trains on its evaluation rows, writes production data or promotes a model.
const {validDecision}=require('./decision.cjs');
const {hash,day}=require('../../src/services/publishedForecastPolicy.cjs');
const CODES=['1','X','2'];
const POLICY=Object.freeze({version:'frozen-quality-review-v1',minimumSettled:100,minimumMatchDays:7});
// An observational target only; these thresholds never replace model-promotion
// or publication policy. A point estimate of 65% is not proof of 65% accuracy.
const TARGET_POLICY=Object.freeze({version:'had-hit-rate-target-v1',targetHitRate:.65,minimumSettled:100,minimumMatchDays:7});
const SP_BUCKETS=Object.freeze(['sp_le_1_45','sp_gt_1_45_le_1_70','sp_gt_1_70_le_2_05','sp_gt_2_05_le_2_60','sp_gt_2_60']);
const marketLeader=probabilities=>CODES.find(c=>CODES.every(other=>other===c||probabilities[c]>probabilities[other]+1e-12))||null;
function spBucket(odds){
 if(odds<=1.45)return SP_BUCKETS[0];
 if(odds<=1.70)return SP_BUCKETS[1];
 if(odds<=2.05)return SP_BUCKETS[2];
 if(odds<=2.60)return SP_BUCKETS[3];
 return SP_BUCKETS[4];
}
function wilson(won,total){
  if(!total)return null;const z=1.959963984540054,p=won/total,den=1+z*z/total;
  const center=(p+z*z/(2*total))/den,spread=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/den;
  return {lower:Math.max(0,center-spread),upper:Math.min(1,center+spread)};
}
function measure(rows){
  let won=0,brier=0,marketBrier=0,logLoss=0,marketLogLoss=0,marketWon=0,marketTied=0,flatStakeNetUnits=0,pricedRows=0;
  for(const {decision:d,settlement:s} of rows){
    won+=Number(d.tipCode===s.actual);const marketTop=marketLeader(d.marketProbabilities);if(marketTop)marketWon+=Number(marketTop===s.actual);else marketTied++;
    if(Number.isFinite(d.odds)&&d.odds>1){pricedRows++;flatStakeNetUnits+=d.tipCode===s.actual?d.odds-1:-1;}
    for(const c of CODES){brier+=(d.probabilities[c]-Number(c===s.actual))**2;marketBrier+=(d.marketProbabilities[c]-Number(c===s.actual))**2;}
    logLoss-=Math.log(Math.max(1e-15,d.probabilities[s.actual]));marketLogLoss-=Math.log(Math.max(1e-15,d.marketProbabilities[s.actual]));
  }
  const marketUnique=rows.length-marketTied;
  return {settled:rows.length,won,hitRate:rows.length?won/rows.length:null,hitRateInterval95:wilson(won,rows.length),marketTopWins:marketWon,marketUniqueTopSettled:marketUnique,marketTied,marketTopHitRate:marketUnique?marketWon/marketUnique:null,brier:rows.length?brier/rows.length:null,marketBrier:rows.length?marketBrier/rows.length:null,logLoss:rows.length?logLoss/rows.length:null,marketLogLoss:rows.length?marketLogLoss/rows.length:null,pricedRows,flatStakeNetUnits:pricedRows?flatStakeNetUnits:null,flatStakeRoi:pricedRows?flatStakeNetUnits/pricedRows:null};
}
function cohort(rows,allSettled){
  return {...measure(rows),independentMatchDays:new Set(rows.map(r=>r.decision.businessDate)).size,
    coverage:{settledEvents:rows.length,evaluatedSettledEvents:allSettled,share:allSettled?rows.length/allSettled:null}};
}
function leaderAgreement(decision){
  const leader=marketLeader(decision.marketProbabilities);
  return leader===null?'market-tied':leader===decision.tipCode?'agree':'disagree';
}
function directionMode(decision){return decision?.directionSelection?.mode==='market-edge-override'?'market-edge-override':'model-leader';}
function marketRoleForDecision(decision){
  const stored=decision?.directionSelection?.marketRole;
  if(['favorite','draw','nonfavorite'].includes(stored))return stored;
  const leader=marketLeader(decision.marketProbabilities);
  if(leader===decision.tipCode)return 'favorite';
  return decision.tipCode==='X'?'draw':'nonfavorite';
}
function rememberPublication(latest,row){
  const d=row.decision,key=JSON.stringify([d.sourceMatchId,d.eventVersion]),publishedAt=Date.parse(d.publishedAt),old=latest.get(key);
  const signature=hash({decisionId:d.decisionId,decisionRecordHash:d.recordHash,settlement:row.settlement??null});
  if(!old||publishedAt>old.publishedAt)latest.set(key,{row,publishedAt,signature,ambiguous:false});
  else if(publishedAt===old.publishedAt&&signature!==old.signature)old.ambiguous=true;
}
const validBusinessDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function targetCohort(rows,through,asOf){
  const settled=[],states={published:rows.length,pending:0,void:0,disputed:0,excludedSettlements:0,pendingFromPastBusinessDays:0};
  const pendingDays=new Set();
  for(const row of rows){
    const d=row.decision,s=row.settlement;
    if(!s||s.state==='PENDING'){
      states.pending++;
      if(d.businessDate<through){states.pendingFromPastBusinessDays++;pendingDays.add(d.businessDate);}
    }else if(s.state==='VOID')states.void++;
    else if(s.state==='DISPUTED')states.disputed++;
    else if(['WON','LOST'].includes(s.state)&&Date.parse(d.kickoffTime)<=asOf
      && CODES.includes(s.actual)&&s.resultEventId&&(d.tipCode===s.actual)===(s.state==='WON')
      && d.marketProbabilities&&CODES.every(c=>Number.isFinite(d.marketProbabilities[c])&&d.marketProbabilities[c]>=0&&d.marketProbabilities[c]<=1)
      && Math.abs(CODES.reduce((n,c)=>n+d.marketProbabilities[c],0)-1)<=1e-6)settled.push(row);
    else states.excludedSettlements++;
  }
  const metrics=measure(settled),independentMatchDays=new Set(settled.map(row=>row.decision.businessDate)).size;
  const paired=measure(settled.filter(row=>marketLeader(row.decision.marketProbabilities)!==null));
  const sampleSufficient=metrics.settled>=TARGET_POLICY.minimumSettled&&independentMatchDays>=TARGET_POLICY.minimumMatchDays;
  const blockers=[];
  if(metrics.settled<TARGET_POLICY.minimumSettled)blockers.push('insufficient-settled-events');
  if(independentMatchDays<TARGET_POLICY.minimumMatchDays)blockers.push('insufficient-independent-match-days');
  if(metrics.hitRateInterval95===null||metrics.hitRateInterval95.lower<TARGET_POLICY.targetHitRate)blockers.push('confidence-lower-bound-below-target');
  return {...states,...metrics,independentMatchDays,pendingPastBusinessDays:pendingDays.size,
    numericTargetReached:metrics.hitRate===null?null:metrics.hitRate>=TARGET_POLICY.targetHitRate,
    sampleSufficient,evidenceSufficient:blockers.length===0,blockers,
    marketComparison:{settled:paired.settled,modelWins:paired.won,modelHitRate:paired.hitRate,
      marketWins:paired.marketTopWins,marketHitRate:paired.marketTopHitRate,
      hitRateDifference:paired.hitRate===null?null:paired.hitRate-paired.marketTopHitRate,
      excludedMarketTies:metrics.marketTied}};
}
function buildHitRateTarget(latest,asOf,invalidRecords,futurePublications){
  const through=day(asOf),groups=new Map(),exclusions={invalidRecords,futurePublications,ambiguous:0,notPublishedHadSingle:0,invalidBusinessDate:0,futureBusinessDate:0,missingModelVersion:0};
  for(const {row,ambiguous} of latest.values()){
    if(ambiguous){exclusions.ambiguous++;continue;}
    const d=row.decision;
    if(d.market!=='HAD'||d.publicationStatus!=='PUBLISHED'||d.statisticsTrack!=='unified-decision'){exclusions.notPublishedHadSingle++;continue;}
    if(!validBusinessDate(d.businessDate)){exclusions.invalidBusinessDate++;continue;}
    if(d.businessDate>through){exclusions.futureBusinessDate++;continue;}
    if(typeof d.upstreamModelVersion!=='string'||!d.upstreamModelVersion.trim()||d.upstreamModelVersion==='unknown'){exclusions.missingModelVersion++;continue;}
    const group=groups.get(d.upstreamModelVersion)||[];group.push(row);groups.set(d.upstreamModelVersion,group);
  }
  const byModelVersion=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([modelVersion,rows])=>{
    const window=days=>{const from=new Date(Date.parse(through+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
      return {from,through,...targetCohort(rows.filter(row=>row.decision.businessDate>=from&&row.decision.businessDate<=through),through,asOf)};};
    return {modelVersion,overall:targetCohort(rows,through,asOf),windows:{last7:window(7),last30:window(30)}};
  });
  return {...TARGET_POLICY,market:'HAD',scope:'per-model-version-final-precutoff-published-single',asOfBusinessDate:through,
    thresholdScope:'observational-target-only-not-formal-promotion',evidenceRule:'minimum-samples-and-days-and-95pct-wilson-lower-bound-at-target',
    byModelVersion,exclusions,formalPromotion:false};
}
function buildQualityReport(input,{asOf=Date.now()}={}){
  if(!Array.isArray(input)||!Number.isFinite(asOf))throw new Error('Published rows and finite asOf are required');
  const latest=new Map(),targetLatest=new Map(),exclusions={invalid:0,future:0,unsettled:0,marketMissing:0,resultMismatch:0,ambiguous:0};
  let targetFuturePublications=0;
  for(const row of input){
    const d=row?.decision;if(!validDecision(d)){exclusions.invalid++;continue;}
    if(Date.parse(d.publishedAt)<=asOf)rememberPublication(targetLatest,row);else targetFuturePublications++;
    if(Date.parse(d.publishedAt)>asOf||Date.parse(d.kickoffTime)>asOf){exclusions.future++;continue;}
    // A timestamp alone cannot order two different published records or
    // conflicting result snapshots. Retain the ambiguity until a genuinely
    // later publication replaces it; an identical retry is just one sample.
    rememberPublication(latest,row);
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
  const byTipCode=Object.fromEntries(CODES.map(code=>[code,cohort(settled.filter(r=>r.decision.tipCode===code),settled.length)]));
  const byLeaderAgreement=Object.fromEntries(['agree','disagree','market-tied'].map(group=>[
    group,cohort(settled.filter(r=>leaderAgreement(r.decision)===group),settled.length),
  ]));
  const bySpBucket=Object.fromEntries(SP_BUCKETS.map(bucket=>[
    bucket,cohort(settled.filter(r=>spBucket(r.decision.odds)===bucket),settled.length),
  ]));
  const byModelPriceSignal=Object.fromEntries(['negative','nonnegative'].map(group=>[
    group,cohort(settled.filter(r=>(r.decision.modelProbability*r.decision.odds-1<0?'negative':'nonnegative')===group),settled.length),
  ]));
  const byDirectionSelectionMode=Object.fromEntries(['model-leader','market-edge-override'].map(group=>[
    group,cohort(settled.filter(r=>directionMode(r.decision)===group),settled.length),
  ]));
  const byMarketRole=Object.fromEntries(['favorite','draw','nonfavorite'].map(group=>[
    group,cohort(settled.filter(r=>marketRoleForDecision(r.decision)===group),settled.length),
  ]));
  const evaluationCoverage={inputRows:input.length,distinctPublishedEvents:latest.size,settledEvents:settled.length,
    settledShareOfPublishedEvents:latest.size?settled.length/latest.size:null,fixtureCoverage:null,
    scope:'supplied-frozen-publication-ledger-only'};
  return {version:POLICY.version,asOf:new Date(asOf).toISOString(),policy:POLICY,scope:'published-final-precutoff-per-event',interpretation:'observational-frozen-prediction-evaluation-not-a-trained-backtest',independentMatchDays:days.length,overall,daily,confidenceBands:bands,
    evaluationCoverage,byTipCode,byLeaderAgreement,bySpBucket,byModelPriceSignal,byDirectionSelectionMode,byMarketRole,
    hitRateTarget:buildHitRateTarget(targetLatest,asOf,exclusions.invalid,targetFuturePublications),
    spBucketPolicy:'frozen selected SP; exact upper bounds 1.45, 1.70, 2.05 and 2.60; diagnostic only',
    modelPriceSignalPolicy:'sign of frozen model probability times frozen selected SP minus one; descriptive only, not calibrated value or promotion',
    flatStakePolicy:'one unit per settled frozen pick at its published SP; diagnostic only, no fees or correlated-bet claim',
    leaderAgreementPolicy:'frozen-selected-tip-versus-unique-frozen-market-probability-leader;ties-reported-separately',
    directionSelectionPolicy:'model-leader-versus-guarded-market-edge-override;diagnostic cohorts only',
    marketRolePolicy:'favorite/draw/nonfavorite classification at the same frozen de-vigged HAD quote;no quota enforcement',
    exclusions,preliminaryEvidenceSufficient:blockers.length===0,blockers,formalPromotion:false};
}
if(require.main===module){
 const fs=require('fs'),args=process.argv.slice(2),at=args.indexOf('--input'),out=args.indexOf('--output');if(at<0||!args[at+1])throw new Error('Use --input <saved-audit.json> [--output <report.json>]');
 const input=JSON.parse(fs.readFileSync(args[at+1],'utf8')),report=buildQualityReport(input.singles||input.recommendationCenter?.review?.singles||[],{asOf:input.at?Date.parse(input.at):Date.now()});
 const json=JSON.stringify(report,null,2);if(out>=0&&args[out+1])fs.writeFileSync(args[out+1],json);console.log(json);
}
module.exports={POLICY,wilson,measure,buildQualityReport};
