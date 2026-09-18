'use strict';
const {evaluateCurrent,validDecision,chooseCombo,freezeCombo,VERSION}=require('./decision.cjs');
const {key,collectResults,settleDecision,settleCombo,summary,validResultEvent}=require('./results.cjs');
const {day,time,hash}=require('../../src/services/publishedForecastPolicy.cjs');

function freshPublication(p,now){return p && /^[a-f0-9]{64}$/.test(p.manifestHash||'') && typeof p.generationId==='string' && p.generationId.length>0 && Number.isFinite(time(p.committedAt)) && now>=time(p.committedAt) && now-time(p.committedAt)<=15*60000;}
function requireBeforeCutoff(records,now){if(records.some(d=>now>=time(d.cutoffTime)))throw Object.assign(new Error('Cutoff crossed'),{code:'DEADLINE_CROSSED'});}
/** Each action commits independently. Never call all lanes inside one outer DB transaction. */
function createRuntime(ports,{validators}={}){
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
    if(!freshPublication(publication,now))throw Object.assign(new Error('Fresh input required'),{code:'SOURCE_STALE'});
    const current=await repo.current();const {decisions,issues}=evaluateCurrent(current,{now,publication});
    const accepted=[];
    for(const d of decisions){
      const item=await repo.savepoint(async()=>{
        requireBeforeCutoff([d],clock());
        const stored=await repo.insertDecision(d);
        if(!validDecision(stored)||stored.inputHash!==d.inputHash)throw new Error('Decision read-back mismatch');
        return stored;
      });
      if(item.error)issues.push({sourceMatchId:d.sourceMatchId,reason:'publication-write-failed'});
      else accepted.push(item.value);
    }
    for(const issue of issues)await repo.issue('publish',issue);
    requireBeforeCutoff(accepted,clock());
    return {publication,decisionIds:accepted.map(d=>d.decisionId),inputAsOf:publication.committedAt,issues:issues.length,attempted:current.length};
  });}
  async function combos(){return stage('combos',async repo=>{
    const publication=await repo.publication(),now=clock();
    if(!freshPublication(publication,now))throw Object.assign(new Error('Fresh input required'),{code:'SOURCE_STALE'});
    // Recheck actual sale state and exact current input before freezing. A
    // retained preview alone is never authority to publish after suspension.
    const {decisions}=evaluateCurrent(await repo.current(),{now,publication});
    const stored=await repo.decisions(decisions.map(d=>d.decisionId));
    const candidates=stored.filter(d=>validDecision(d) && decisions.some(f=>f.decisionId===d.decisionId && f.inputHash===d.inputHash));
    const frozen=await repo.frozenCombos(day(now)),previews=[],created=[];
    for(const size of [2,3]){
      if(frozen.some(c=>c.size===size))continue;
      const selection=chooseCombo(candidates,size,now);if(!selection)continue;
      const record=freezeCombo(selection,clock());
      if(record){await repo.insertCombo(record);created.push(...record.legs);}
      else previews.push(selection);
    }
    requireBeforeCutoff(created,clock());
    return {publication,previews,inputAsOf:publication.committedAt,candidateCount:candidates.length};
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
    const singles=decisions.map(d=>({decision:d,settlement:settleDecision(d,heads.get(key(d)))}));
    const records=await repo.frozenCombos();const ids=[...new Set(records.flatMap(c=>Array.isArray(c?.decisionIds)?c.decisionIds:[]))];
    const bindings=new Map((await repo.decisions(ids)).map(d=>[d.decisionId,d]));
    const combos=[];
    for(const c of records){
      try{
        const {recordHash,...body}=c;
        if(hash(body)!==recordHash || c.legs.length!==c.size || c.legs.some(d=>!validDecision(d)||bindings.get(d.decisionId)?.recordHash!==d.recordHash))throw new Error('Broken decision binding');
        combos.push({combo:c,settlement:settleCombo(c,heads)});
      }catch{quarantined.push({reason:'invalid-combo-binding',id:String(c?.id||'unknown')});}
    }
    for(const issue of quarantined)await repo.issue('view',issue);
    singles.sort((a,b)=>time(b.decision.publishedAt)-time(a.decision.publishedAt));
    const previews=lanes.combos?.status==='ok' ? (lanes.combos.previews||[]).filter(c=>c.businessDate===day(now)&&c.legs.every(l=>now<time(l.cutoffTime)&&now-time(l.quoteObservedAt)<=15*60000)) : [];
    const selected=singles.filter(r=>r.decision.businessDate===day(now));
    const today=combos.filter(r=>r.combo.businessDate===day(now));
    const overlap=previews.length===2?previews[0].decisionIds.filter(id=>previews[1].decisionIds.includes(id)):[];
    const center={version:'recommendation-center-v1',policyVersion:VERSION,updatedAt:new Date(now).toISOString(),businessDate:day(now),
      inputAsOf:lanes.publish?.inputAsOf||null,resultAsOf:lanes.settlement?.lastSuccessAt||null,lanes,
      current:selected,previews,todayCombos:today,overlapDecisionIds:overlap,
      review:{singles:singles.slice(0,100),combos:combos.slice(0,100),limit:100,
        statistics:{single:summary(singles,true),two:summary(combos.filter(r=>r.combo.size===2)),three:summary(combos.filter(r=>r.combo.size===3))},
        definition:'latest-published-decision-before-cutoff-per-event; combos-use-exact-bound-versions'},
      excludedCorruptRecords:quarantined.length,modelValidation:'unvalidated',legacyRecordsReclassified:0};
    await repo.saveView(center);
    return {centerUpdatedAt:center.updatedAt,quarantined:quarantined.length};
  });}
  return {publish,combos,settle,view,
    async publishingCycle(){const publication=await publish();const combinations=await combos();const projection=await view();return {publication,combinations,projection};},
    async settlementCycle(){const settlement=await settle();const projection=await view();return {settlement,projection};}
  };
}
module.exports={createRuntime,freshPublication,requireBeforeCutoff};
