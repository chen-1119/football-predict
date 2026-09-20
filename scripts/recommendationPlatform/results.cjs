'use strict';
const { hash, time } = require('../../src/services/publishedForecastPolicy.cjs');
const { validDecision } = require('./decision.cjs');
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
function settleCombo(combo, heads) {
  if (!Array.isArray(combo?.legs) || ![2,3].includes(combo.size) || combo.legs.length!==combo.size) throw new Error('Invalid frozen combo');
  const legs=combo.legs.map(leg=>({decisionId:leg.decisionId,sourceMatchId:leg.sourceMatchId,...settleDecision(leg,heads.get(key(leg)))}));
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
function validResultEvent(e){
  try{return Boolean(e && ['FINAL','VOID','DISPUTED'].includes(e.state) && Number.isSafeInteger(e.revision) && e.revision>=0
    && e.eventKey===key(e) && e.stateHash===fingerprint(e) && e.eventId===`result_${hash([e.eventKey,e.stateHash,e.previousEventId])}`
    && (e.state!=='FINAL'||[e.scoreHome,e.scoreAway].every(n=>Number.isSafeInteger(n)&&n>=0)));}catch{return false;}
}
module.exports={key,collectResults,settleDecision,settleHandicapDecision,settleCombo,summary,handicapSummary,validResultEvent};
