'use strict';

const { hash } = require('./publishedForecastPolicy.cjs');
const VERSION = 'handicap-calibration-v2';
const CODES = Object.freeze(['1','X','2']);
const MIN_ROWS = 18;
const MIN_HOLDOUT = 6;
const MIN_SAMPLE_DAYS = 4;
const PRIOR_STRENGTH = 24;
const MAX_ABS_ADJUSTMENT = 0.12;
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const round=(v,d=6)=>Number(v.toFixed(d));
const lineGroup=line=>{
  if(!Number.isSafeInteger(line)||line===0)return null;
  const magnitude=Math.abs(line),size=magnitude===1?'1':magnitude===2?'2':'3plus';
  return line<0?'home-give-'+size:'home-receive-'+size;
};
const actualCode=(line,home,away)=>{
  if(!Number.isSafeInteger(line)||line===0||!Number.isSafeInteger(home)||!Number.isSafeInteger(away))return null;
  const adjusted=home+line-away;return adjusted>0?'1':adjusted<0?'2':'X';
};
const normalized=p=>{
  if(!p||typeof p!=='object')return null;
  const values=CODES.map(c=>typeof p[c]==='number'?p[c]:NaN);
  if(values.some(v=>!Number.isFinite(v)||v<0||v>1))return null;
  const total=values.reduce((a,b)=>a+b,0);if(total<.98||total>1.02)return null;
  return Object.fromEntries(CODES.map((c,i)=>[c,values[i]/total]));
};
const top=p=>CODES.map((c,i)=>({c,i,p:p[c]})).sort((a,b)=>b.p-a.p||a.i-b.i)[0].c;
const brier=(p,a)=>CODES.reduce((s,c)=>s+(p[c]-Number(c===a))**2,0);
const logLoss=(p,a)=>-Math.log(Math.max(1e-12,p[a]));
function applyResidual(raw,residual,weight,preserveStructuralZero=false){
  const p={};for(const c of CODES)p[c]=preserveStructuralZero&&raw[c]===0?0:Math.max(.01,raw[c]+clamp(residual[c]*weight,-MAX_ABS_ADJUSTMENT,MAX_ABS_ADJUSTMENT));
  const total=CODES.reduce((s,c)=>s+p[c],0);if(total<=0)return raw;
  return Object.fromEntries(CODES.map(c=>[c,round(p[c]/total)]));
}
function fit(rows,key){
  const ordered=rows.slice().sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt)||a.id.localeCompare(b.id));
  const days=[...new Set(ordered.map(r=>r.businessDate).filter(Boolean))].sort();
  const outcomeCounts={'1':0,X:0,'2':0},rawTopCounts={'1':0,X:0,'2':0},meanRaw={'1':0,X:0,'2':0};
  for(const r of ordered){outcomeCounts[r.actual]++;rawTopCounts[top(r.raw)]++;for(const c of CODES)meanRaw[c]+=r.raw[c];}
  for(const c of CODES)meanRaw[c]=ordered.length?meanRaw[c]/ordered.length:0;
  const actualShare=Object.fromEntries(CODES.map(c=>[c,ordered.length?outcomeCounts[c]/ordered.length:0]));
  const bias=Object.fromEntries(CODES.map(c=>[c,round(meanRaw[c]-actualShare[c])]));
  if(ordered.length<MIN_ROWS)return {key,rows:ordered.length,sampleDays:days.length,active:false,reason:'insufficient-samples',outcomeCounts,rawTopCounts,meanRaw,actualShare,bias};
  if(days.length<MIN_SAMPLE_DAYS)return {key,rows:ordered.length,sampleDays:days.length,active:false,reason:'insufficient-sample-days',outcomeCounts,rawTopCounts,meanRaw,actualShare,bias};
  const holdoutDayCount=Math.max(2,Math.ceil(days.length*.25)),holdoutDays=new Set(days.slice(-holdoutDayCount));
  const test=ordered.filter(r=>holdoutDays.has(r.businessDate));
  const holdoutStart=Math.min(...test.map(r=>Date.parse(r.publishedAt)));
  const train=ordered.filter(r=>!holdoutDays.has(r.businessDate)&&Date.parse(r.resultObservedAt)<holdoutStart);
  if(train.length<MIN_ROWS-MIN_HOLDOUT||test.length<MIN_HOLDOUT)return {key,rows:ordered.length,sampleDays:days.length,active:false,reason:'insufficient-time-forward-window',outcomeCounts,rawTopCounts,meanRaw,actualShare,bias};
  const residual={'1':0,X:0,'2':0};
  for(const r of train)for(const c of CODES)residual[c]+=Number(c===r.actual)-r.raw[c];
  for(const c of CODES)residual[c]=clamp(residual[c]/train.length,-MAX_ABS_ADJUSTMENT,MAX_ABS_ADJUSTMENT);
  const weight=clamp(train.length/(train.length+PRIOR_STRENGTH),.15,.65);
  let rawB=0,calB=0,rawL=0,calL=0,rawHit=0,calHit=0;
  for(const r of test){const adjusted=applyResidual(r.raw,residual,weight,true);rawB+=brier(r.raw,r.actual);calB+=brier(adjusted,r.actual);rawL+=logLoss(r.raw,r.actual);calL+=logLoss(adjusted,r.actual);rawHit+=Number(top(r.raw)===r.actual);calHit+=Number(top(adjusted)===r.actual);}
  const metrics={sampleDays:days.length,holdoutDays:holdoutDays.size,holdout:test.length,rawBrier:rawB/test.length,calibratedBrier:calB/test.length,rawLogLoss:rawL/test.length,calibratedLogLoss:calL/test.length,rawHitRate:rawHit/test.length,calibratedHitRate:calHit/test.length};
  const active=metrics.calibratedBrier<=metrics.rawBrier-.002&&metrics.calibratedLogLoss<=metrics.rawLogLoss+.01&&metrics.calibratedHitRate>=metrics.rawHitRate-.02;
  return {key,rows:ordered.length,sampleDays:days.length,trainRows:train.length,active,reason:active?'holdout-improved':'holdout-not-improved',weight:round(weight),residual:Object.fromEntries(CODES.map(c=>[c,round(residual[c])])),metrics:Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,typeof v==='number'?round(v):v])),outcomeCounts,rawTopCounts,meanRaw:Object.fromEntries(CODES.map(c=>[c,round(meanRaw[c])])),actualShare:Object.fromEntries(CODES.map(c=>[c,round(actualShare[c])])),bias};
}
function sampleRows(decisions,heads,currentBusinessDate,asOf){
  const latest=new Map(),rows=[];
  for(const d of decisions||[]){
    try{
      const {recordHash,...body}=d||{};
      if(typeof recordHash!=='string'||hash(body)!==recordHash)continue;
      const h=d?.handicapAnalysis;
      // v2 learns the margin split only among matches where the frozen HAD
      // thesis was actually correct. This matches the product meaning of the
      // companion handicap pick and prevents contradictory outcomes from
      // contaminating calibration.
      if(h?.companionPolicyVersion!=='straight-conditioned-margin-v1'||h.straightTipCode!==d.tipCode)continue;
      const raw=normalized(h.companionRawProbabilities);
      if(!raw||!Number.isSafeInteger(h.handicapLine)||h.handicapLine===0)continue;
      if(typeof d.businessDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d.businessDate)||d.businessDate>=currentBusinessDate||!Number.isFinite(Date.parse(d.publishedAt)))continue;
      const eventMs=Date.parse(d.eventVersion||d.kickoffTime);if(!Number.isFinite(eventMs))continue;
      const published=Date.parse(d.publishedAt),cutoff=d.cutoffTime?Date.parse(d.cutoffTime):eventMs;
      if(!Number.isFinite(cutoff)||published>=Math.min(eventMs,cutoff)||published>asOf)continue;
      const eventKey=JSON.stringify([String(d.sourceMatchId||'').replace(/^sporttery_/,''),new Date(eventMs).toISOString()]);
      const prior=latest.get(eventKey);
      if(!prior||published>Date.parse(prior.publishedAt)||(published===Date.parse(prior.publishedAt)&&String(d.decisionId).localeCompare(String(prior.decisionId))<0))latest.set(eventKey,d);
    }catch{/* Corrupt input cannot alter the sample set. */}
  }
  for(const [eventKey,d] of latest){
    try{
      const h=d.handicapAnalysis,raw=normalized(h.companionRawProbabilities),eventMs=Date.parse(d.eventVersion||d.kickoffTime);
      const e=heads instanceof Map?heads.get(eventKey):null;
      if(!e||e.state!=='FINAL'||!Number.isSafeInteger(e.scoreHome)||!Number.isSafeInteger(e.scoreAway))continue;
      const observed=typeof e.observedAt==='string'?Date.parse(e.observedAt):NaN;
      if(!Number.isFinite(observed)||observed<eventMs||observed>asOf||e.scoreHome<0||e.scoreAway<0)continue;
      if((e.homeTeamId&&e.homeTeamId!==d.homeTeamId)||(e.awayTeamId&&e.awayTeamId!==d.awayTeamId))continue;
      const actualHad=e.scoreHome>e.scoreAway?'1':e.scoreHome<e.scoreAway?'2':'X';
      if(actualHad!==d.tipCode)continue;
      const actual=actualCode(h.handicapLine,e.scoreHome,e.scoreAway);if(!actual)continue;
      rows.push({id:String(d.decisionId||eventKey),decisionRecordHash:d.recordHash,resultEvidenceHash:hash(e),businessDate:d.businessDate,publishedAt:d.publishedAt,resultObservedAt:e.observedAt,line:h.handicapLine,group:lineGroup(h.handicapLine),straightTipCode:d.tipCode,raw,actual});
    }catch{/* A corrupt historical row is excluded; it cannot block current publication. */}
  }
  return rows;
}
function buildHandicapCalibration(decisions,heads,currentBusinessDate,{asOf=Date.parse(`${currentBusinessDate}T00:00:00+08:00`)}={}){
  const samples=Number.isFinite(asOf)?sampleRows(decisions,heads,currentBusinessDate,asOf):[],groups={};
  const keys=new Set();
  for(const r of samples){keys.add(r.group);keys.add(r.group+'|straight:'+r.straightTipCode);}
  for(const key of keys){const scoped=samples.filter(r=>key.includes('|straight:')?(r.group+'|straight:'+r.straightTipCode===key):r.group===key);groups[key]=fit(scoped,key);}
  const evidence=samples.map(r=>[r.id,r.decisionRecordHash,r.resultEvidenceHash]).sort((a,b)=>a[0].localeCompare(b[0]));
  const payload={version:VERSION,currentBusinessDate,sampleRows:samples.length,sampleDefinition:'latest-companion-margin-given-frozen-had-hit',sampleEvidenceHash:hash(evidence),sampleLatestObservedAt:samples.length?new Date(Math.max(...samples.map(r=>Date.parse(r.resultObservedAt)))).toISOString():null,groups};
  // The observation clock is audit metadata, not a new model input. Identical
  // frozen decisions and result revisions must retain the same profile identity.
  return {...payload,asOf:Number.isFinite(asOf)?new Date(asOf).toISOString():null,profileHash:hash(payload)};
}
function calibrateHandicapProbabilities(raw,line,straightTipCode,profile){
  const base=normalized(raw);if(!base)return null;
  if(profile){const {profileHash,asOf,...body}=profile;if(profileHash!==hash(body)||!Number.isFinite(Date.parse(asOf))||(profile.sampleLatestObservedAt&&Date.parse(profile.sampleLatestObservedAt)>Date.parse(asOf)))profile=null;}
  const group=lineGroup(line),specific=group&&CODES.includes(straightTipCode)?groupsafe(profile,group+'|straight:'+straightTipCode):null,broad=group?groupsafe(profile,group):null;
  const chosen=specific?.active?specific:broad?.active?broad:null;
  if(!chosen)return {probabilities:base,applied:false,key:specific?.key||broad?.key||group,profileHash:profile?.profileHash||null,reason:specific?.reason||broad?.reason||'no-profile'};
  const probabilities=applyResidual(base,chosen.residual,chosen.weight,true);
  return {probabilities,applied:true,key:chosen.key,profileHash:profile.profileHash,reason:chosen.reason,weight:chosen.weight,residual:chosen.residual,metrics:chosen.metrics};
}
function groupsafe(profile,key){const value=profile?.version===VERSION?profile.groups?.[key]:null;return value&&typeof value==='object'?value:null;}
module.exports={VERSION,MIN_ROWS,MIN_HOLDOUT,MIN_SAMPLE_DAYS,lineGroup,actualCode,applyResidual,buildHandicapCalibration,calibrateHandicapProbabilities};
