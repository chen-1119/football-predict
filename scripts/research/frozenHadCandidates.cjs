'use strict';

// Fixed, retrospective comparison only: no parameter fitting, winner nomination,
// production writes, double-choice outcomes or rewritten frozen selections.
const {hash}=require('../../src/services/publishedForecastPolicy.cjs');
const {validDecision}=require('../recommendationPlatform/decision.cjs');
const {key,validResultEvent,settleDecision}=require('../recommendationPlatform/results.cjs');
const {wilson}=require('../recommendationPlatform/qualityReport.cjs');
const {pairedCalendarBlockResearch}=require('../pairedCalendarBlockResearch.cjs');
const CODES=['1','X','2'];
const CANDIDATES=Object.freeze([
  {id:'frozen-model',modelWeight:1}, {id:'frozen-market',modelWeight:0},
  {id:'model75-market25',modelWeight:.75}, {id:'model50-market50',modelWeight:.5},
  {id:'model25-market75',modelWeight:.25},
]);
const leader=p=>CODES.find(c=>CODES.every(other=>other===c||p[c]>p[other]+1e-12))||null;
const triplet=p=>p&&CODES.every(c=>Number.isFinite(p[c])&&p[c]>=0&&p[c]<=1)&&Math.abs(CODES.reduce((n,c)=>n+p[c],0)-1)<1e-6;
const loss=(p,actual)=>({brier:CODES.reduce((n,c)=>n+(p[c]-Number(c===actual))**2,0),logLoss:-Math.log(Math.max(1e-15,p[actual]))});
const mixed=(d,w)=>Object.fromEntries(CODES.map(c=>[c,w*d.probabilities[c]+(1-w)*d.marketProbabilities[c]]));
const spBand=n=>n<=1.45?'sp_le_1_45':n<=1.7?'sp_gt_1_45_le_1_70':n<=2.05?'sp_gt_1_70_le_2_05':n<=2.6?'sp_gt_2_05_le_2_60':'sp_gt_2_60';
const countBy=(rows,select)=>rows.reduce((out,row)=>{const name=String(select(row));out[name]=(out[name]||0)+1;return out;},{});
const groupBy=(rows,select)=>{const groups=new Map();for(const row of rows){const name=String(select(row));if(!groups.has(name))groups.set(name,[]);groups.get(name).push(row);}return [...groups].sort(([a],[b])=>a.localeCompare(b));};
function auditInputAdmission(decision){
  const evidence=decision.inputEvidence?.model?.inputEvidence;
  if(!evidence)return {group:'evidence-unavailable',elo:'unknown',form:'unknown'};
  const inspect=(name,minimum)=>{
    const sample=evidence.samples?.[name],weight=evidence.weights?.[name];
    if(!sample||!['home','away'].every(k=>Number.isSafeInteger(sample[k])&&sample[k]>=0)||!Number.isFinite(weight)||weight<0)return 'unknown';
    return weight>0&&(sample.home<minimum||sample.away<minimum)?'positive-weight-below-both-team-sample-floor':'no-sample-floor-violation';
  };
  const elo=inspect('elo',6),form=inspect('form',8);
  return {group:[elo,form].includes('positive-weight-below-both-team-sample-floor')?'sample-floor-violation':[elo,form].includes('unknown')?'evidence-incomplete':'no-sample-floor-violation',elo,form,
    samples:evidence.samples,weights:evidence.weights};
}

function buildFrozenHadCandidateDiagnostic(input){
  if(!input||!Array.isArray(input.decisions)||!Array.isArray(input.resultHeads)||!Number.isFinite(Date.parse(input.observedAt)))throw new Error('Frozen decisions, result heads and observedAt are required');
  const asOf=Date.parse(input.observedAt),asOfBusinessDate=new Date(asOf+8*3600000).toISOString().slice(0,10),exclusions={},bump=reason=>{exclusions[reason]=(exclusions[reason]||0)+1;},latest=new Map();
  for(const d of input.decisions){
    if(!validDecision(d)){bump('invalid-decision');continue;}
    if(d.market!=='HAD'||d.publicationStatus!=='PUBLISHED'||d.statisticsTrack!=='unified-decision'){bump('not-published-HAD-single');continue;}
    const businessDate=d.businessDate,dateMs=typeof businessDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(businessDate)?Date.parse(businessDate+'T00:00:00.000Z'):NaN;
    if(!Number.isFinite(dateMs)||new Date(dateMs).toISOString().slice(0,10)!==businessDate){bump('invalid-business-date');continue;}
    if(businessDate>asOfBusinessDate){bump('future-business-date');continue;}
    const at=Date.parse(d.publishedAt),end=Math.min(Date.parse(d.cutoffTime),Date.parse(d.kickoffTime));
    if(!Number.isFinite(at)||!Number.isFinite(end)||at>=end||at>asOf){bump('publication-clock-invalid');continue;}
    if(!triplet(d.probabilities)||!triplet(d.marketProbabilities)){bump('invalid-probability-triplet');continue;}
    const eventKey=key(d),old=latest.get(eventKey);
    if(!old||at>old.at){if(old)bump('superseded-publication');latest.set(eventKey,{decision:d,at,ambiguous:false});}
    else if(at<old.at)bump('superseded-publication');
    else if(d.recordHash!==old.decision.recordHash){old.ambiguous=true;bump('conflicting-publication');}
    else bump('duplicate-publication');
  }
  const heads=new Map(),blockedHeads=new Map();
  for(const event of input.resultHeads){
    let eventKey;try{eventKey=key(event);}catch{bump('invalid-result-identity');continue;}
    if(!validResultEvent(event)){bump('invalid-result-evidence');blockedHeads.set(eventKey,'DISPUTED');continue;}
    const observed=Date.parse(event.observedAt),kickoff=Date.parse(event.eventVersion);
    if(!Number.isFinite(observed)||observed>asOf||(event.state==='FINAL'&&observed<kickoff)){bump('result-clock-unavailable');blockedHeads.set(eventKey,'PENDING');continue;}
    const old=heads.get(eventKey);
    if(old&&hash(old)!==hash(event)){bump('conflicting-result-heads');blockedHeads.set(eventKey,'DISPUTED');}
    else if(old)bump('duplicate-result-head');else heads.set(eventKey,event);
  }
  const publications=[],paired=[];
  for(const [eventKey,item] of [...latest].sort(([a],[b])=>a.localeCompare(b))){
    if(item.ambiguous){bump('ambiguous-latest-publication');continue;}
    const d=item.decision,event=heads.get(eventKey);
    const blocked=blockedHeads.get(eventKey),settlement=blocked?{state:blocked}:settleDecision(d,event);
    const row={decision:d,event,settlement,eventKey};publications.push(row);
    if(!['WON','LOST'].includes(settlement.state))continue;
    if(!event||Date.parse(event.observedAt)<=item.at||Date.parse(d.kickoffTime)>asOf){bump('settlement-clock-invalid');continue;}
    paired.push(row);
  }
  const uniqueDirections=rows=>rows.filter(row=>CANDIDATES.every(c=>leader(mixed(row.decision,c.modelWeight))!==null));
  function compareRows(rows){
    const common=uniqueDirections(rows),marketCode=row=>leader(row.decision.marketProbabilities);
    const marketHits=common.filter(row=>marketCode(row)===row.settlement.actual).length;
    const result={probabilityRows:rows.length,commonDirectionRows:common.length,tieExcludedRows:rows.length-common.length,independentMatchDays:new Set(rows.map(r=>r.decision.businessDate)).size,candidates:{}};
    for(const c of CANDIDATES){
      const predictions=rows.map(row=>({row,p:mixed(row.decision,c.modelWeight)})),scored=predictions.map(({row,p})=>loss(p,row.settlement.actual));
      const own=predictions.filter(({p})=>leader(p)!==null),won=common.filter(row=>leader(mixed(row.decision,c.modelWeight))===row.settlement.actual).length;
      const ownWon=own.filter(({row,p})=>leader(p)===row.settlement.actual).length;
      let candidateOnlyWins=0,marketOnlyWins=0,bothWin=0,bothMiss=0;
      for(const row of common){const a=leader(mixed(row.decision,c.modelWeight))===row.settlement.actual,b=marketCode(row)===row.settlement.actual;if(a&&b)bothWin++;else if(a)candidateOnlyWins++;else if(b)marketOnlyWins++;else bothMiss++;}
      result.candidates[c.id]={modelWeight:c.modelWeight,rows:rows.length,brier:rows.length?scored.reduce((n,v)=>n+v.brier,0)/rows.length:null,logLoss:rows.length?scored.reduce((n,v)=>n+v.logLoss,0)/rows.length:null,
        commonDirection:{settled:common.length,won,hitRate:common.length?won/common.length:null,wilson95:wilson(won,common.length)},
        ownDirection:{settled:own.length,won:ownWon,hitRate:own.length?ownWon/own.length:null,abstainedTies:rows.length-own.length},
        directionCounts:countBy(own,({p})=>leader(p)),sameRowsMarket:{settled:common.length,won:marketHits,hitRate:common.length?marketHits/common.length:null},
        pairedOutcomes:{candidateOnlyWins,marketOnlyWins,bothWin,bothMiss,netWins:candidateOnlyWins-marketOnlyWins},
        candidateDirectionsDifferFromOriginal:own.filter(({row,p})=>leader(p)!==row.decision.tipCode).length};
    }
    return result;
  }
  const grouped=select=>Object.fromEntries(groupBy(paired,select).map(([name,rows])=>[name,compareRows(rows)]));
  const overall=compareRows(paired),uncertainty={};
  for(const candidate of CANDIDATES.filter(c=>c.id!=='frozen-market')){
    // Calendar grouping is explicitly the official business day, including gaps;
    // this synthetic midnight is a block label, never a forecast/feature clock.
    uncertainty[candidate.id]=pairedCalendarBlockResearch(paired.map(row=>({eventId:row.eventKey,forecastAt:row.decision.businessDate+'T00:00:00.000Z',baseline:loss(row.decision.marketProbabilities,row.settlement.actual),candidate:loss(mixed(row.decision,candidate.modelWeight),row.settlement.actual)})));
  }
  const body={version:'frozen-had-candidate-diagnostic-v1',observedAt:new Date(asOf).toISOString(),inputHash:hash(input),researchOnly:true,productionWrites:0,productionEligible:false,trainingPerformed:false,holdoutClaim:false,selectedCandidate:null,
    policy:{candidates:CANDIDATES,selection:'fixed before this run; no retrospective winner promoted',eventSelection:'latest valid published pre-cutoff HAD single per event, conflicts excluded',resultBinding:'production validResultEvent and settleDecision; result observed after publication and no later than observedAt',denominator:'same paired settled events; common unique-direction denominator for accuracy, all paired vectors for probability loss',grouping:'modelVersion, frozen original tip/SP and original model-market agreement; never candidate-specific winning subsets',coverage:'published-ledger coverage only; total historical fixture universe unavailable',uncertainty:'Wilson intervals are descriptive, not independent-match-day proof; paired seven-calendar-day intervals require 28 calendar and 14 occupied business days; subgroup intervals are not multiplicity-adjusted',knownPendingOfficialResult:'ignored here; only accepted resultHeads settle frozen evidence'},
    sample:{inputDecisions:input.decisions.length,inputResultHeads:input.resultHeads.length,publishedEvents:publications.length,settlementStates:countBy(publications,r=>r.settlement.state),pairedSettledEvents:paired.length,pairedShareOfPublished:publications.length?paired.length/publications.length:null,fixtureCoverage:null,settledBusinessDates:[...new Set(paired.map(r=>r.decision.businessDate))].sort(),knownPendingOfficialResult:input.knownPendingOfficialResult?.length||0},
    exclusions,overall,byModelVersion:grouped(r=>r.decision.upstreamModelVersion||'unknown'),byOriginalDirection:grouped(r=>r.decision.tipCode),byOriginalSpBand:grouped(r=>spBand(r.decision.odds)),byOriginalMarketAgreement:grouped(r=>{const a=leader(r.decision.probabilities),b=leader(r.decision.marketProbabilities);return a===null||b===null?'tied':a===b?'agree':'disagree';}),pairedCalendarUncertainty:uncertainty,
    sampleAdmission:{scope:'frozen input evidence only; Elo weight requires at least 6 per team, form weight at least 8 per team; missing evidence is unknown; available evidence does not establish provider truth, form confidence or causal accuracy gain',publishedCounts:countBy(publications,r=>auditInputAdmission(r.decision).group),settledCounts:countBy(paired,r=>auditInputAdmission(r.decision).group),byGroup:grouped(r=>auditInputAdmission(r.decision).group),violations:publications.filter(r=>auditInputAdmission(r.decision).group==='sample-floor-violation').map(r=>({sourceMatchId:r.decision.sourceMatchId,businessDate:r.decision.businessDate,modelVersion:r.decision.upstreamModelVersion,settlement:r.settlement.state,actual:r.settlement.actual||null,originalTip:r.decision.tipCode,...auditInputAdmission(r.decision)}))},
    changedEvents:paired.filter(r=>CANDIDATES.some(c=>leader(mixed(r.decision,c.modelWeight))!==r.decision.tipCode)).map(r=>({sourceMatchId:r.decision.sourceMatchId,businessDate:r.decision.businessDate,modelVersion:r.decision.upstreamModelVersion,originalTip:r.decision.tipCode,originalSp:r.decision.odds,actual:r.settlement.actual,probabilities:r.decision.probabilities,marketProbabilities:r.decision.marketProbabilities,resultObservedAt:r.event.observedAt,candidateDirections:Object.fromEntries(CANDIDATES.map(c=>[c.id,leader(mixed(r.decision,c.modelWeight))]))}))};
  return {...body,reportHash:hash(body)};
}
function buildOfflineOfficialResultReplay(input){
  const baseline=buildFrozenHadCandidateDiagnostic(input),now=Date.parse(input.observedAt);
  const {collectResults}=require('../recommendationPlatform/results.cjs');
  const {officialResultValidators}=require('../recommendationPlatform/officialResults.cjs');
  const previous=new Map(input.resultHeads.map(event=>[key(event),event]));
  const collected=collectResults(input.knownPendingOfficialResult||[],previous,officialResultValidators(now),now),next=new Map(previous);
  for(const event of collected.updates)next.set(key(event),event);
  const replay=collectResults(input.knownPendingOfficialResult||[],next,officialResultValidators(now),now);
  if(replay.updates.length)throw new Error('Offline official-result replay was not idempotent');
  const retained=[...previous].filter(([eventKey,event])=>hash(next.get(eventKey))===hash(event)).length;
  const after=buildFrozenHadCandidateDiagnostic({...input,resultHeads:[...next.values()]});
  const body={version:'offline-official-result-candidate-replay-v1',scope:'local in-memory result-adapter acceptance only; not deployed results',productionWrites:0,originalInputHash:hash(input),applied:collected.updates.length,issues:collected.issues,existingResultHeads:previous.size,retainedUnchangedResultHeads:retained,
    noChangeReplay:{applied:replay.updates.length,issues:replay.issues},frozenDecisionsUnchanged:true,baseline,afterLocalSupplement:after};
  return {...body,reportHash:hash(body)};
}
if(require.main===module){
  const fs=require('node:fs'),path=require('node:path'),[inputPath,outputPath,mode]=process.argv.slice(2);
  if(!inputPath||!outputPath||(mode&&mode!=='--replay-known-official-result'))throw new Error('Usage: node scripts/research/frozenHadCandidates.cjs <frozen-input.json> <outputs/new-report.json> [--replay-known-official-result]');
  const outputRoot=path.resolve(__dirname,'../../outputs'),target=path.resolve(outputPath);
  if(!target.startsWith(outputRoot+path.sep)||fs.existsSync(target))throw new Error('Use a new output file under this workspace outputs directory');
  if(fs.statSync(inputPath).size>64*1024*1024)throw new Error('Input exceeds 64 MiB diagnostic limit');
  const input=JSON.parse(fs.readFileSync(inputPath,'utf8')),report=mode?buildOfflineOfficialResultReplay(input):buildFrozenHadCandidateDiagnostic(input);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const scored=report.afterLocalSupplement||report;
  console.log(JSON.stringify({ok:true,output:target,reportHash:report.reportHash,...(mode?{scope:report.scope,applied:report.applied,noChangeReplay:report.noChangeReplay}:{}),sample:scored.sample,exclusions:scored.exclusions,overall:scored.overall,uncertainty:Object.fromEntries(Object.entries(scored.pairedCalendarUncertainty).map(([id,r])=>[id,r.status]))},null,2));
}
module.exports={CANDIDATES,buildFrozenHadCandidateDiagnostic,buildOfflineOfficialResultReplay,auditInputAdmission};
