'use strict';
const {evaluateCurrent,validDecision,chooseCombo,freezeCombo,VERSION}=require('./decision.cjs');
const {key,collectResults,settleDecision,settleHandicapDecision,settleCombo,summary,handicapSummary,handicapBreakdown,marketBaseline,dailySummary,validResultEvent}=require('./results.cjs');
const {validCombo}=require('./comboSelections.cjs');
const {day,time,hash}=require('../../src/services/publishedForecastPolicy.cjs');
const {buildHandicapCalibration}=require('../../src/services/handicapCalibration.cjs');
const {selectionQuality,isQualifiedSelection}=require('../../src/services/recommendationSelectionQuality.cjs');
const {buildPublishedScoreDistribution}=require('../../src/services/publishedScoreDistribution.cjs');
const {buildQualityReport}=require('./qualityReport.cjs');
const {buildDataCoverage}=require('../dataCoverage.cjs');
const {createDualResearchRecord}=require('./dualChoiceResearch.cjs');
const {createDualResearchV2Record,validDualResearchV2Record,settleDualResearchV2}=require('./dualChoiceResearchV2.cjs');

function freshPublication(p,now){return p && /^[a-f0-9]{64}$/.test(p.manifestHash||'') && typeof p.generationId==='string' && p.generationId.length>0 && Number.isFinite(time(p.committedAt)) && now>=time(p.committedAt) && now-time(p.committedAt)<=15*60000;}
function requireBeforeCutoff(records,now){if(records.some(d=>now>=time(d.cutoffTime)))throw Object.assign(new Error('Cutoff crossed'),{code:'DEADLINE_CROSSED'});}
async function assessInputs(repo,publication,now){
  const committed=time(publication?.committedAt);
  if(!publication || !/^[a-f0-9]{64}$/.test(publication.manifestHash||'') || !publication.generationId
    || !Number.isFinite(committed) || committed>now)throw Object.assign(new Error('Valid committed input required'),{code:'SOURCE_STALE'});
  const inputs=repo.currentInputs?await repo.currentInputs(now):{current:await repo.current(),receiptHashes:new Set()};
  const [historical,rawHeads]=await Promise.all([repo.latest(),repo.resultHeads()]);
  const calibrationHeads=new Map(rawHeads.filter(validResultEvent).map(e=>[e.eventKey,e]));
  const handicapCalibration=buildHandicapCalibration(historical.filter(validDecision),calibrationHeads,day(now),{asOf:now});
  const assessed=evaluateCurrent(inputs.current,{now,publication,handicapCalibration});
  // A full model publication is not a quote clock. An older generation may
  // supply a still-valid prospective model ONLY with a fresh, independently
  // acquired exact-event receipt in this transaction. Model/cutoff policy is
  // unchanged. No receipt means the original 15-minute source gate still holds.
  if(!freshPublication(publication,now)){
    const fresh=assessed.decisions.filter(d=>inputs.receiptHashes.has(d.quoteProvenance?.receiptHash));
    if(!fresh.length)throw Object.assign(new Error('Fresh input required'),{code:'SOURCE_STALE'});
    for(const d of assessed.decisions)if(!fresh.includes(d))assessed.issues.push({sourceMatchId:d.sourceMatchId,reason:'source-stale'});
    assessed.decisions=fresh;
  }
  const quoteTimes=assessed.decisions.map(d=>time(d.quoteObservedAt));
  return {...assessed,handicapCalibration,attempted:inputs.current.length,inputAsOf:quoteTimes.length?new Date(Math.min(...quoteTimes)).toISOString():publication.committedAt};
}
/** Bind the exact current inputs inside the caller's transaction. The source
 * may have advanced since the separate single-publication transaction ended.
 * Missing rows are persisted with the SAME decision policy, not discarded or
 * replaced by stale decisions. Existing immutable publication times are kept. */
async function bindCurrentDecisions(repo, decisions, clock) {
  const byId=new Map((await repo.decisions(decisions.map(d=>d.decisionId))).map(d=>[d.decisionId,d]));
  const accepted=[],issues=[];
  for(const d of decisions){
    const item=await repo.savepoint(async()=>{
      requireBeforeCutoff([d],clock());
      const stored=byId.get(d.decisionId)||await repo.insertDecision(d);
      if(!validDecision(stored)||stored.decisionId!==d.decisionId||stored.inputHash!==d.inputHash)
        throw Object.assign(new Error('Decision read-back mismatch'),{code:'DECISION_BINDING_INVALID'});
      return stored;
    });
    if(item.error)issues.push({sourceMatchId:d.sourceMatchId,reason:'decision-binding-failed'});
    else accepted.push(item.value);
  }
  return {accepted,issues};
}
/** Each action commits independently. Never call all lanes inside one outer DB transaction. */
function createRuntime(ports,{validators,dualResearchEnabled=process.env.ENABLE_DUAL_RESEARCH==='1',dualResearchV2Enabled=process.env.ENABLE_DUAL_RESEARCH_V2!=='0'}={}){
  const clock=ports.clock || Date.now;
  async function stage(lane,action){
    const attemptAt=clock();
    try{return await ports.transaction(lane,async repo=>{
      const value=await action(repo);
      const now=clock();await repo.saveLane(lane,{...value,status:'ok',lastSuccessAt:new Date(now).toISOString(),lastAttemptAt:new Date(attemptAt).toISOString(),errorCode:null});
      return {ok:true,value};
    });}catch(error){
      const errorCode=String(error.code||'LANE_FAILED').slice(0,64);
      try{await ports.transaction(lane,async repo=>{
        const old=await repo.lane(lane);if(old?.lastAttemptAt && time(old.lastAttemptAt)>attemptAt)return;await repo.saveLane(lane,{...(old||{}),status:'error',errorCode,lastAttemptAt:new Date(attemptAt).toISOString()});
      });}catch{/* Do not mask the original failure, and never fabricate a success state. */}
      return {ok:false,errorCode};
    }
  }
  async function publish(){return stage('publish',async repo=>{
    const publication=await repo.publication(),now=clock();
    const {decisions,issues,attempted,inputAsOf,handicapCalibration}=await assessInputs(repo,publication,now);
    const bound=await bindCurrentDecisions(repo,decisions,clock);
    const accepted=bound.accepted;issues.push(...bound.issues);
    for(const issue of issues)await repo.issue('publish',issue);
    requireBeforeCutoff(accepted,clock());
    return {publication,decisionIds:accepted.map(d=>d.decisionId),inputAsOf,basePublicationAsOf:publication.committedAt,issues:issues.length,attempted,handicapCalibration:{profileHash:handicapCalibration.profileHash,sampleRows:handicapCalibration.sampleRows,activeGroups:Object.values(handicapCalibration.groups).filter(g=>g.active).length}};
  });}
  // Research has its own transaction. A missing migration, late cutoff, or
  // invalid research row cannot roll back the published single lane.
  async function research(decisionIds=[]){
    if(!dualResearchEnabled)return {ok:true,enabled:false,created:0,eligible:0,issues:0};
    if(!decisionIds.length)return {ok:true,enabled:true,created:0,eligible:0,issues:0};
    try{return await ports.transaction('dual-research',async repo=>{
      if(typeof repo.insertDualResearch!=='function')return {ok:true,created:0,eligible:0,issues:0,enabled:false};
      let created=0,eligible=0,issues=0;
      for(const decision of await repo.decisions(decisionIds)){
        const record=createDualResearchRecord(decision,clock());
        if(!record)continue;
        eligible++;
        const result=await repo.savepoint(async()=>repo.insertDualResearch(record));
        if(result.error){
          if(['42P01','42703','42883'].includes(result.error.code))throw result.error;
          issues++;await repo.issue('dual-research',{sourceMatchId:decision.sourceMatchId,reason:'research-record-insert-failed'});
        }
        else if(result.value)created++;
      }
      return {ok:true,enabled:true,created,eligible,issues};
    });}catch(error){return {ok:false,enabled:true,errorCode:String(error.code||'DUAL_RESEARCH_FAILED').slice(0,64)};}
  }
  // The new cohort binds directly to the current pre-match input. In
  // particular, a missing HAD quote must not prevent two HHAD outcomes from
  // being studied. It never writes a recommendation decision or combo.
  async function researchV2(){
    if(!dualResearchV2Enabled||!ports.supportsResearchV2)return {ok:true,enabled:false,created:0,eligible:0,issues:0};
    try{return await ports.transaction('dual-research-v2',async repo=>{
      if(typeof repo.insertDualResearchV2!=='function'||typeof repo.currentInputs!=='function')
        return {ok:true,enabled:false,created:0,eligible:0,issues:0};
      const now=clock(),publication=await repo.publication();
      const inputs=await repo.currentInputs(now);
      let created=0,eligible=0,issues=0;
      // The warehouse can contain more than one row for a source match. Do not
      // freeze whichever row an unordered query happened to return first.
      const grouped=new Map();
      for(const match of inputs.current){
        const source=String(match?.sourceMatchId||match?.id||'').replace(/^sporttery_/,'');
        if(!source)continue;
        const rows=grouped.get(source)||[];rows.push(match);grouped.set(source,rows);
      }
      for(const [source,rows] of grouped){
        if(new Set(rows.map(hash)).size!==1){
          issues++;await repo.issue('dual-research-v2',{sourceMatchId:source,reason:'conflicting-current-input'});
          continue;
        }
        const match=rows[0];
        const record=createDualResearchV2Record(match,{now:clock(),publication});
        if(!record)continue;
        eligible++;
        const result=await repo.savepoint(async()=>repo.insertDualResearchV2(record,match));
        if(result.error){
          if(['42P01','42703','42883'].includes(result.error.code))throw result.error;
          issues++;await repo.issue('dual-research-v2',{sourceMatchId:record.sourceMatchId,reason:'research-record-insert-failed'});
        }else if(result.value)created++;
      }
      return {ok:true,enabled:true,created,eligible,issues};
    });}catch(error){return {ok:false,enabled:true,errorCode:String(error.code||'DUAL_RESEARCH_V2_FAILED').slice(0,64)};}
  }
  async function combos(){return stage('combos',async repo=>{
    const publication=await repo.publication(),now=clock();
    // Recheck actual sale state and exact current input before freezing. A
    // retained preview alone is never authority to publish after suspension.
    const assessed=await assessInputs(repo,publication,now);
    const bound=await bindCurrentDecisions(repo,assessed.decisions,clock);
    const candidates=bound.accepted;
    const issues=[...assessed.issues,...bound.issues];
    for(const issue of issues)await repo.issue('combos',issue);
    if(assessed.decisions.length>0 && candidates.length===0 && bound.issues.length>0)
      throw Object.assign(new Error('No current decision could be bound'),{code:'DECISION_BINDING_FAILED'});
    const frozen=await repo.frozenCombos(day(now)),previews=[],created=[];
    for(const size of [2,3]){
      if(frozen.some(c=>c.size===size))continue;
      const selection=chooseCombo(candidates,size,now,{admit:isQualifiedSelection});if(!selection)continue;
      const record=freezeCombo(selection,clock());
      if(record){await repo.insertCombo(record);created.push(...record.legs);}
      else previews.push(selection);
    }
    requireBeforeCutoff(created,clock());
    return {publication,previews,inputAsOf:assessed.inputAsOf,basePublicationAsOf:publication.committedAt,candidateCount:candidates.filter(d=>selectionQuality(d).qualified).length,referenceCount:candidates.length,watchCount:candidates.filter(d=>!selectionQuality(d).qualified).length,eligibleCount:assessed.decisions.length,bindingFailures:bound.issues.length,handicapCalibration:{profileHash:assessed.handicapCalibration.profileHash,sampleRows:assessed.handicapCalibration.sampleRows,activeGroups:Object.values(assessed.handicapCalibration.groups).filter(g=>g.active).length}};
  });}
  async function settle(){return stage('settlement',async repo=>{
    const verify=validators || (()=>{const m=require('../../src/services/matchLifecycle.cjs');return {isFinal:m.isOfficialSportteryFinal,isVoid:m.isOfficialSportteryVoid};})();
    const old=await repo.resultHeads();const previous=new Map(old.filter(validResultEvent).map(e=>[e.eventKey,e]));
    const {updates,issues}=collectResults(await repo.history(),previous,verify,clock());
    for(const event of updates)await repo.appendResult(event);
    for(const issue of issues)await repo.issue('settlement',issue);
    return {applied:updates.length,issues:issues.length};
  });}
  async function view(){return stage('view',async repo=>{
    const now=clock(),lanes=await repo.lanes();
    const all=await repo.latest(),decisions=[],quarantined=[];
    for(const d of all){if(validDecision(d))decisions.push(d);else quarantined.push({reason:'invalid-decision-record',id:String(d?.decisionId||'unknown')});}
    const rawHeads=await repo.resultHeads();
    for(const e of rawHeads)if(!validResultEvent(e))quarantined.push({reason:'invalid-result-record',id:String(e?.eventId||'unknown')});
    const heads=new Map(rawHeads.filter(validResultEvent).map(e=>[e.eventKey,e]));
    const dualV2Records=typeof repo.dualResearchV2==='function'?await repo.dualResearchV2(day(now)):[];
    const todayDualResearch=[];
    for(const record of dualV2Records){
      if(record?.businessDate!==day(now)||!validDualResearchV2Record(record,record?.inputSnapshot)){
        quarantined.push({reason:'invalid-dual-research-v2-record',id:String(record?.id||'unknown')});
        continue;
      }
      const settlement=settleDualResearchV2(record,heads.get(key(record)));
      todayDualResearch.push({
        version:record.version,id:record.id,sourceMatchId:record.sourceMatchId,
        matchId:record.inputSnapshot.id,eventVersion:record.eventVersion,businessDate:record.businessDate,
        homeTeamName:record.inputSnapshot.homeTeamName,awayTeamName:record.inputSnapshot.awayTeamName,
        recordedAt:record.recordedAt,cutoffAt:record.cutoffAt,recordHash:record.recordHash,
        researchOnly:true,formalPromotion:false,totalStake:record.totalStake,
        unionProbability:record.unionProbability,
        selections:record.selections.map(selection=>({market:selection.market,tipCode:selection.tipCode,
          handicapLine:selection.handicapLine,odds:selection.odds,modelProbability:selection.modelProbability,
          quoteObservedAt:selection.quoteObservedAt})),
        settlement:{state:settlement.state,grossReturn:settlement.grossReturn,
          netProfit:settlement.netProfit,resultEventId:settlement.resultEventId},
      });
    }
    const singles=decisions.map(d=>{const event=heads.get(key(d));return {decision:d,selectionQuality:selectionQuality(d),scoreDistribution:buildPublishedScoreDistribution(d),settlement:settleDecision(d,event),handicapSettlement:settleHandicapDecision(d,event)};});
    const handicapCalibration=buildHandicapCalibration(decisions,heads,day(now),{asOf:now});
    const records=await repo.frozenCombos();const ids=[...new Set(records.flatMap(c=>Array.isArray(c?.decisionIds)?c.decisionIds:[]))];
    const bindings=new Map((await repo.decisions(ids)).map(d=>[d.decisionId,d]));
    const combos=[];
    for(const c of records){
      try{
        if(!validCombo(c,{frozen:true}) || c.legs.some(d=>!validDecision(bindings.get(d.decisionId))||bindings.get(d.decisionId)?.recordHash!==d.recordHash))throw new Error('Broken decision binding');
        combos.push({combo:c,settlement:settleCombo(c,heads)});
      }catch{quarantined.push({reason:'invalid-combo-binding',id:String(c?.id||'unknown')});}
    }
    for(const issue of quarantined)await repo.issue('view',issue);
    singles.sort((a,b)=>time(b.decision.publishedAt)-time(a.decision.publishedAt));
    const previews=lanes.combos?.status==='ok' ? (lanes.combos.previews||[]).filter(c=>c.businessDate===day(now)&&validCombo(c,{now})) : [];
    const selected=singles.filter(r=>r.decision.businessDate===day(now));
    const today=combos.filter(r=>r.combo.businessDate===day(now));
    const overlap=previews.length===2?previews[0].decisionIds.filter(id=>previews[1].decisionIds.includes(id)):[];
    const targetRows=repo.todayTargets?await repo.todayTargets(day(now)):await repo.current();
    const coverage=buildDataCoverage({targetRows,singles,now,lanes});
    const center={version:'recommendation-center-v1',policyVersion:VERSION,updatedAt:new Date(now).toISOString(),businessDate:day(now),
      inputAsOf:[lanes.publish?.inputAsOf,lanes.combos?.inputAsOf].filter(v=>Number.isFinite(time(v))).sort((a,b)=>time(b)-time(a))[0]||null,resultAsOf:lanes.settlement?.lastSuccessAt||null,lanes,
      current:selected,previews,todayCombos:today,todayDualResearch,overlapDecisionIds:overlap,coverage,
      review:{singles:singles.slice(0,100),combos:combos.slice(0,100),limit:100,qualityReport:buildQualityReport(singles,{asOf:now}),
        statistics:{single:summary(singles,true),qualifiedSingle:summary(singles.filter(r=>r.selectionQuality.qualified),true),handicap:handicapSummary(singles),handicapBreakdown:handicapBreakdown(singles),marketBaseline:marketBaseline(singles),daily:dailySummary(singles,combos),two:summary(combos.filter(r=>r.combo.size===2)),three:summary(combos.filter(r=>r.combo.size===3))},handicapCalibration,
        definition:'latest-published-decision-before-cutoff-per-event; combos-use-exact-bound-versions'},
      excludedCorruptRecords:quarantined.length,modelValidation:'unvalidated',legacyRecordsReclassified:0};
    await repo.saveView(center);
    return {centerUpdatedAt:center.updatedAt,quarantined:quarantined.length};
  });}
  return {publish,research,researchV2,combos,settle,view,
    async publishingCycle(){const publication=await publish();const dualResearch=publication.ok?await research(publication.value.decisionIds):{ok:false,skipped:'publication-failed'};const dualResearchV2=await researchV2();const combinations=await combos();const projection=await view();return {publication,dualResearch,dualResearchV2,combinations,projection};},
    async settlementCycle(){const settlement=await settle();const projection=await view();return {settlement,projection};}
  };
}
module.exports={createRuntime,freshPublication,requireBeforeCutoff};
