'use strict';
const { hash, time } = require('../../src/services/publishedForecastPolicy.cjs');
const { validDecision } = require('./decision.cjs');
const { validCombo,comboSelections,hasSelections } = require('./comboSelections.cjs');
const key = row => JSON.stringify([String(row?.sourceMatchId || row?.id || '').replace(/^sporttery_/, ''), new Date(time(row.eventVersion || row.kickoffTime)).toISOString()]);
const revision = row => {
  const value = row?.resultRevision ?? row?.postMatchReview?.settlement?.resultRevision ?? 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
function fingerprint(value) {
  return hash({ state:value.state, scoreHome:value.scoreHome, scoreAway:value.scoreAway,
    homeTeamId:value.homeTeamId, awayTeamId:value.awayTeamId, revision:value.revision });
}
function collectResults(history, previous, { isFinal, isVoid }, now) {
  const grouped = new Map(), issues = [];
  for (const row of history) {
    try {
      const final = isFinal(row), voided = isVoid(row), rev = revision(row);
      if (!final && !voided) continue;
      const eventMs = time(row.eventVersion || row.kickoffTime);
      if (!Number.isFinite(eventMs) || (!voided && now < eventMs) || rev === null) continue;
      if (!voided && (![row.scoreHome,row.scoreAway].every(n => Number.isSafeInteger(n) && n >= 0))) continue;
      const at = row.resultObservedAt || row.resultUpdatedAt;
      if (at && (!Number.isFinite(time(at)) || time(at)>now)) continue;
      const eventKey = key(row), values = grouped.get(eventKey) || [];
      values.push({ sourceMatchId:String(row.sourceMatchId || row.id).replace(/^sporttery_/,''), eventVersion:new Date(eventMs).toISOString(),
        revision:rev, homeTeamId:row.homeTeamId || null, awayTeamId:row.awayTeamId || null,
        state:voided?'VOID':'FINAL', scoreHome:voided?null:row.scoreHome, scoreAway:voided?null:row.scoreAway,
        source:row.resultSource || row.voidSource || 'validated-result-adapter' });
      grouped.set(eventKey,values);
    } catch { issues.push({ reason:'malformed-result',sourceMatchId:String(row?.sourceMatchId || '') }); }
  }
  const updates=[];
  for (const [eventKey, rows] of grouped) {
    const old = previous.get(eventKey) || null;
    const rev = Math.max(...rows.map(r=>r.revision));
    if (old && rev < old.revision) continue;
    const latest = rows.filter(r=>r.revision===rev);
    const states = new Set(latest.map(fingerprint));
    if (old && old.revision===rev) states.add(fingerprint(old));
    let next = latest[0];
    if (states.size>1 || (old?.revision===rev && old.state==='DISPUTED')) next={...next,state:'DISPUTED',scoreHome:null,scoreAway:null};
    const stateHash=fingerprint(next);
    if (old && stateHash === old.stateHash) continue;
    const body = { ...next, stateHash, eventKey, previousEventId:old?.eventId || null,
      observedAt:new Date(now).toISOString(), evidenceHash:hash([...new Set(latest.map(fingerprint))].sort()) };
    const eventId = `result_${hash([eventKey,stateHash,body.previousEventId])}`;
    updates.push({...body,eventId});
  }
  return { updates, issues };
}
function identityGuard(decision,event){
  if (!event) return { state:'PENDING',score:null,resultEventId:null };
  if(key(decision)!==key(event)) return {state:'DISPUTED',score:null,resultEventId:event.eventId,reason:'event-identity-conflict'};
  if ((event.homeTeamId && event.homeTeamId!==decision.homeTeamId) || (event.awayTeamId && event.awayTeamId!==decision.awayTeamId))
    return {state:'DISPUTED',score:null,resultEventId:event.eventId,reason:'team-identity-conflict'};
  if (event.state==='VOID' || event.state==='DISPUTED') return {state:event.state,score:null,resultEventId:event.eventId};
  if (event.state!=='FINAL') return {state:'PENDING',score:null,resultEventId:null};
  return null;
}
function settleDecision(decision, event) {
  const guarded=identityGuard(decision,event); if(guarded)return guarded;
  const line = decision.market === 'HHAD' ? Number(decision.handicapLine) : 0;
  if (!Number.isInteger(line) || ![event.scoreHome,event.scoreAway].every(Number.isSafeInteger)) return {state:'DISPUTED',score:null,resultEventId:event.eventId};
  const adjusted=event.scoreHome+line;
  const actual=adjusted>event.scoreAway?'1':adjusted<event.scoreAway?'2':'X';
  return {state:actual===decision.tipCode?'WON':'LOST',actual,score:`${event.scoreHome}-${event.scoreAway}`,resultEventId:event.eventId,revision:event.revision};
}
function settleHandicapDecision(decision,event){
  if(!decision?.handicapAnalysis?.tipCode)return null;
  const guarded=identityGuard(decision,event);if(guarded)return guarded;
  const line=Number(decision.handicapAnalysis.handicapLine);
  if(!Number.isSafeInteger(line)||line===0||![event.scoreHome,event.scoreAway].every(Number.isSafeInteger))
    return {state:'DISPUTED',score:null,resultEventId:event.eventId,reason:'handicap-line-invalid'};
  const adjusted=event.scoreHome+line;
  const actual=adjusted>event.scoreAway?'1':adjusted<event.scoreAway?'2':'X';
  return {state:actual===decision.handicapAnalysis.tipCode?'WON':'LOST',actual,score:`${event.scoreHome}-${event.scoreAway}`,
    resultEventId:event.eventId,revision:event.revision,handicapLine:line};
}
function settleSupplementaryResearch(decision, event) {
  if (!validDecision(decision) || !decision.supplementaryResearch) return null;
  const research = decision.supplementaryResearch;
  const guarded = event && !validResultEvent(event)
    ? { state:'DISPUTED', score:null, resultEventId:event.eventId || null, reason:'invalid-result-event' }
    : identityGuard(decision, event);
  if (guarded) return { exactScore:{...guarded}, totalGoals:{...guarded} };
  const score = `${event.scoreHome}-${event.scoreAway}`;
  const total = event.scoreHome + event.scoreAway >= 7 ? '7+' : String(event.scoreHome + event.scoreAway);
  const result = (actual, selected) => ({ state:actual === selected ? 'WON' : 'LOST', actual, score,
    resultEventId:event.eventId, revision:event.revision });
  return { exactScore:result(score, research.exactScore.label), totalGoals:result(total, research.totalGoals.label) };
}
function supplementarySummary(rows) {
  // Only genuinely frozen selections enter this denominator. Never backfill
  // a historical pick from today's projection of an older decision.
  const eligible = rows.filter(row => row.decision?.supplementaryResearch && validDecision(row.decision));
  return { version:'supplementary-research-v1', researchOnly:true, modelValidation:'unvalidated', roi:null,
    excludedWithoutFrozenPicks: rows.length - eligible.length,
    exactScore:summary(eligible.map(row => ({settlement:row.supplementarySettlement?.exactScore}))),
    totalGoals:summary(eligible.map(row => ({settlement:row.supplementarySettlement?.totalGoals}))) };
}
function settleCombo(combo, heads) {
  if (!validCombo(combo,{frozen:Boolean(combo?.frozenAt)})) throw new Error('Invalid frozen combo');
  const selections=comboSelections(combo);
  const legs=combo.legs.map((leg,i)=>{
    const selection=selections[i];
    const snapshot=hasSelections(combo)?{...leg,market:selection.market,handicapLine:selection.handicapLine,tipCode:selection.tipCode}:leg;
    return {decisionId:leg.decisionId,sourceMatchId:leg.sourceMatchId,
      ...(hasSelections(combo)?{selectionId:selection.selectionId,market:selection.market,handicapLine:selection.handicapLine,tipCode:selection.tipCode,odds:selection.odds}:{}),
      ...settleDecision(snapshot,heads.get(key(leg)))};
  });
  const state=legs.some(l=>l.state==='DISPUTED')?'DISPUTED':legs.some(l=>l.state==='VOID')?'VOID':legs.some(l=>l.state==='PENDING')?'PENDING':legs.every(l=>l.state==='WON')?'WON':'LOST';
  return {state,legs,revisionHash:hash(legs.map(l=>[l.decisionId,l.resultEventId,l.state]))};
}
function summary(rows, modelMetrics=false) {
  const counts={published:rows.length,settled:0,won:0,lost:0,pending:0,void:0,disputed:0,hitRate:null};
  let scored=0,brier=0,logLoss=0,marketBrier=0;
  for(const row of rows){
    const s=row.settlement?.state || 'PENDING';
    if(s==='WON'||s==='LOST'){counts.settled++;counts[s==='WON'?'won':'lost']++;}
    else counts[s==='VOID'?'void':s==='DISPUTED'?'disputed':'pending']++;
    const d=row.decision;
    if(modelMetrics && ['WON','LOST'].includes(s) && d && validDecision(d)){
      const actual=row.settlement.actual;
      if(!['1','X','2'].includes(actual))continue;
      brier+=['1','X','2'].reduce((sum,c)=>sum+(d.probabilities[c]-Number(c===actual))**2,0);
      marketBrier+=['1','X','2'].reduce((sum,c)=>sum+(d.marketProbabilities[c]-Number(c===actual))**2,0);
      logLoss-=Math.log(Math.max(1e-15,d.probabilities[actual]));scored++;
    }
  }
  counts.hitRate=counts.settled?counts.won/counts.settled:null;
  return {...counts,...(modelMetrics?{scored,brier:scored?brier/scored:null,logLoss:scored?logLoss/scored:null,marketBrier:scored?marketBrier/scored:null}:{} )};
}
function handicapSummary(rows){
  const eligible=rows.filter(row=>row.decision?.handicapAnalysis?.tipCode);
  return summary(eligible.map(row=>({decision:row.decision,settlement:row.handicapSettlement||{state:'PENDING'}})),false);
}
function handicapBreakdown(rows){
  const result={standaloneV1:handicapSummary(rows.filter(r=>r.decision?.handicapAnalysis?.version==='handicap-margin-v1'))};
  for(const version of [2,3]){
    const group=rows.filter(r=>r.decision?.handicapAnalysis?.version===`handicap-margin-v${version}`);
    result[`companionV${version}All`]=handicapSummary(group);
    result[`companionV${version}WhenHadWon`]=handicapSummary(group.filter(r=>r.settlement?.state==='WON'));
    result[`companionV${version}BothWon`]=summary(group.map(r=>{
      const a=r.settlement?.state||'PENDING',b=r.handicapSettlement?.state||'PENDING';
      const state=[a,b].includes('DISPUTED')?'DISPUTED':[a,b].includes('VOID')?'VOID':[a,b].includes('PENDING')?'PENDING':a==='WON'&&b==='WON'?'WON':'LOST';
      return {settlement:{state}};
    }));
  }
  return result;
}
function marketBaseline(rows){
  let tied=0;
  const scored=[];
  for(const row of rows){
    const p=row.decision?.marketProbabilities;
    if(!p||!['1','X','2'].every(c=>Number.isFinite(p[c])))continue;
    const top=['1','X','2'].find(c=>['1','X','2'].every(other=>other===c||p[c]>p[other]+1e-12));
    if(!top){tied++;continue;}
    const s=row.settlement||{state:'PENDING'};
    scored.push({settlement:['WON','LOST'].includes(s.state)?{...s,state:s.actual===top?'WON':'LOST'}:s});
  }
  return {...summary(scored),tied,definition:'unique-top-of-frozen-HAD-market-probabilities'};
}
function dailySummary(singles,combos){
  const dates=[...new Set([...singles.map(r=>r.decision.businessDate),...combos.map(r=>r.combo.businessDate)])].sort().reverse();
  return dates.map(businessDate=>{
    const rows=singles.filter(r=>r.decision.businessDate===businessDate),groups=combos.filter(r=>r.combo.businessDate===businessDate);
    return {businessDate,single:summary(rows,true),marketBaseline:marketBaseline(rows),handicapBreakdown:handicapBreakdown(rows),
      two:summary(groups.filter(r=>r.combo.size===2)),three:summary(groups.filter(r=>r.combo.size===3))};
  });
}
function validResultEvent(e){
  try{return Boolean(e && ['FINAL','VOID','DISPUTED'].includes(e.state) && Number.isSafeInteger(e.revision) && e.revision>=0
    && e.eventKey===key(e) && e.stateHash===fingerprint(e) && e.eventId===`result_${hash([e.eventKey,e.stateHash,e.previousEventId])}`
    && (e.state!=='FINAL'||[e.scoreHome,e.scoreAway].every(n=>Number.isSafeInteger(n)&&n>=0)));}catch{return false;}
}
module.exports={key,collectResults,settleDecision,settleHandicapDecision,settleSupplementaryResearch,supplementarySummary,settleCombo,summary,handicapSummary,handicapBreakdown,marketBaseline,dailySummary,validResultEvent};
