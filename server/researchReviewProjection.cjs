'use strict';
// Read-only version projection. The original records and aggregate denominator
// are kept separate; only committed, replayed, second-ACK versions are visible.
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const single=require('./researchReviewedRevision.cjs'),combo=require('./researchComboRevision.cjs');
const results=require('../scripts/recommendationPlatform/results.cjs');
const {epochNanoseconds:ns}=require('../src/services/prematchV3Clock.cjs');
const fail=code=>{throw Object.assign(Error(code),{code});};
const VERSION='reviewed-revisions-view-v1',MAX_ROWS=2*16*(32+6),MAX_BYTES=32*1024*1024;
function settlement(decision,heads,at){
 const d={...decision,sourceMatchId:decision.eventId,tipCode:({h:'1',d:'X',a:'2'})[decision.selection],handicapLine:decision.market==='HHAD'?decision.handicap:0};
 const found=heads.filter(e=>results.key(e)===results.key(d));
 if(!found.length)return {state:'PENDING'};
 if(found.length!==1||!results.validResultEvent(found[0])||ns(found[0].observedAt)===null||ns(found[0].observedAt)>ns(at)
  ||!found[0].homeTeamId||!found[0].awayTeamId)return {state:'DISPUTED'};
 const s=results.settleDecision(d,found[0]);
 if(['WON','LOST'].includes(s.state))return {...s,scoreTop1:decision.scores[0][0]===found[0].scoreHome&&decision.scores[0][1]===found[0].scoreAway,
  scoreTop2:decision.scores.some(v=>v[0]===found[0].scoreHome&&v[1]===found[0].scoreAway)};
 return s;
}
function groupSettlement(legs){
 const states=legs.map(s=>s.state);
 return {state:states.includes('DISPUTED')?'DISPUTED':states.includes('VOID')?'VOID':states.includes('LOST')?'LOST':states.every(s=>s==='WON')?'WON':'PENDING'};
}
async function projection(c,original,at,heads=[],{eventId=null}={}){
 if(!original?.records?.length||ns(at)===null||!Array.isArray(heads))fail('REVIEW_REVISION_VIEW_IDENTITY');
 if(eventId!==null&&(!/^[1-9]\d{0,19}$/.test(eventId)||original.records.length!==1||original.records[0].eventId!==eventId))fail('REVIEW_REVISION_VIEW_IDENTITY');
 const day=original.businessDate,limit=eventId===null?MAX_ROWS:32,rows=(await c.query(`SELECT artifact_key,artifact_version,payload_bytes,octet_length(payload::text) AS actual_bytes
 FROM football.private_model_artifacts WHERE ${eventId===null?'artifact_key LIKE $1 OR artifact_key LIKE $2':'artifact_key LIKE $1'} ORDER BY artifact_key LIMIT ${limit+1}`,
 eventId===null?['reviewed-single-'+day+'-%','reviewed-combo-'+day+'-%']:['reviewed-single-'+day+'-'+eventId+'-v%'])).rows;
 let total=0;
 if(rows.length>limit)fail('REVIEW_REVISION_VIEW_BOUND');
 const all=new Set(rows.map(r=>r.artifact_key));
 for(const r of rows){
  const type=r.artifact_key.startsWith('reviewed-single-')?single:combo,ack=r.artifact_key.endsWith('-ack'),bytes=Number(r.payload_bytes);
  if(eventId!==null&&!r.artifact_key.startsWith('reviewed-single-'+day+'-'+eventId+'-v'))fail('REVIEW_REVISION_VIEW_IDENTITY');
  if(!Number.isSafeInteger(bytes)||bytes<2||bytes>8*1024*1024||Number(r.actual_bytes)!==bytes||(total+=bytes)>MAX_BYTES
   ||r.artifact_version!==(ack?type.ACK_VERSION:type.VERSION)||!new RegExp('^reviewed-(?:single|combo)-'+day+'-(?:[1-9]\\d{0,19}|[a-f0-9]{64})-v(?:0[1-9]|1[0-6])(?:-ack)?$').test(r.artifact_key))fail('REVIEW_REVISION_VIEW_BOUND');
  if(ack&&!all.has(r.artifact_key.slice(0,-4)))fail('REVIEW_REVISION_VIEW_ORPHAN_ACK');
 }
 const singles=[],combos=[],pending=[];
 let current=[];
 if(rows.some(r=>r.artifact_version===combo.VERSION)){
  current=(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513")).rows.map(r=>r.payload);
  if(current.length>512)fail('REVIEW_REVISION_MATCH_BOUND');
 }
 for(const r of rows.filter(r=>!r.artifact_key.endsWith('-ack'))){
  const isSingle=r.artifact_version===single.VERSION;
  const v=await(isSingle?single:combo).verifyCommitted(c,r.artifact_key,at);
  if(!v.verified){pending.push({key:r.artifact_key,state:v.state});continue;}
  const originals=isSingle?[v.originalDecision]:v.originalDecisions;
  for(const first of originals){const match=original.records.find(d=>d.eventId===first.eventId);
   const {publicationCreatedAt,publicationCommitObservedAt,...core}=match||{};void publicationCreatedAt;void publicationCommitObservedAt;
   if(!match||p.hash(core)!==p.hash(first))fail('REVIEW_REVISION_VIEW_BASE_CHANGED');}
  const common={key:v.key,revision:v.revision,payloadSha256:v.payloadSha256,ackSha256:v.ackSha256,previousRevisionHash:v.previousRevisionHash,
   publishedAt:v.publishedAt,commitObservedAt:v.commitObservedAt,originalSettlementPreserved:true,independentEventIncrement:0};
  if(isSingle)singles.push({...common,eventId:v.latestDecision.eventId,originalDecisionHash:v.originalDecisionHash,decision:v.latestDecision,
   settlement:settlement(v.latestDecision,heads,at)});
  else {const legSettlements=v.latestDecisions.map(d=>settlement(d,heads,at));
   combos.push({...common,baseArchiveKey:v.baseArchiveKey,baseArchiveSha256:v.baseArchiveSha256,originalCombo:v.originalCombo,
    decisions:v.latestDecisions,combo:v.combo,frozen:originals.some(d=>{
      const observed=current.filter(m=>String(m.sourceMatchId||'').replace(/^sporttery_/,'')===d.eventId&&ns(m.eventVersion||m.kickoffTime)===ns(d.eventVersion));
      return ns(at)>=ns(d.eventVersion)||ns(at)>=ns(d.cutoffAt)||observed.length!==1||observed[0].status!=='SCHEDULED';
    }),settlement:groupSettlement(legSettlements),legSettlements});}
 }
 const value=p.seal({version:VERSION,state:'verified',businessDate:day,updatedAt:at,originalPublicationHash:original.publicationHash,singles,combos,pending,
  originalSettlementPreserved:true,independentEventIncrement:0,formalEligible:false,modelAdoption:false});
 if(Buffer.byteLength(JSON.stringify(value))>512*1024)fail('REVIEW_REVISION_VIEW_BOUND');
 return value;
}
module.exports={VERSION,projection,settlement,groupSettlement};
