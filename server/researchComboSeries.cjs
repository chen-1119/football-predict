'use strict';
// Independent immutable combination publications. Never writes original groups,
// single decisions, current/history rows or their settlement identities.
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const original=require('../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs');
const single=require('./researchReviewedRevision.cjs');
const official=require('../scripts/recommendationPlatform/reviewedOfficialEvent.cjs');
const {epochNanoseconds:ns}=require('../src/services/prematchV3Clock.cjs');
const {exactProduct}=require('../scripts/recommendationPlatform/reviewedComboHistory.cjs');
const VERSION='reviewed-combo-series-v1',ACK_VERSION='reviewed-combo-series-ack-v1',MAX_SERIES=1;
const fail=code=>{throw Object.assign(Error('RESEARCH_COMBO_SERIES_'+code),{code:'RESEARCH_COMBO_SERIES_'+code,retryWriteAutomatically:false});};
const need=(v,c)=>{if(!v)fail(c);},hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fields=(v,s)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===s;
const validDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
function groupIdentity(g){return {size:g.size,band:g.band,eventIds:[...g.eventIds].sort()};}
function keyFor(r){return 'reviewed-combo-series-'+r.businessDate+'-'+p.hash(r.groups.map(groupIdentity).sort((a,b)=>a.size-b.size||a.band-b.band));}
// One create-only new-series batch per business day. The durable broker claim
// deliberately excludes group membership, band, prices, label and JSON bytes.
// A failed/unknown attempt cannot be retried by altering any of these fields.
function journalId(r){validate(r);return 'combo-series-day-'+r.businessDate;}
function validate(r){
 need(fields(r,'bases,businessDate,draft,draftHash,groups,label,version')&&r.version==='reviewed-combo-series-request-v1','REQUEST');
 need(validDay(r.businessDate)&&r.draft?.version===4&&r.draft.eventAuthority===official.VERSION&&r.draft.businessDate===r.businessDate&&hex(r.draftHash)&&p.hash(r.draft)===r.draftHash,'DRAFT');
 need(typeof r.label==='string'&&r.label.length>=1&&r.label.length<=40&&!/[\x00-\x1f\x7f\ufffd]/.test(r.label),'LABEL');
 need(Array.isArray(r.groups)&&r.groups.length>=1&&r.groups.length<=6&&Array.isArray(r.bases)&&r.bases.length>=2&&r.bases.length<=18,'BOUND');
 p.validateDraft(r.draft,r.draft.frozenAt);
 need(r.draft.singles.length===r.bases.length,'BASES');
 const ids=new Set(),slots=new Set(),groups=new Set(),used=new Set();
 for(const [i,b]of r.bases.entries()){
  need(fields(b,'basePayloadSha256,baseRecordKey,eventId')&&/^[1-9]\d{0,19}$/.test(b.eventId||'')&&hex(b.basePayloadSha256)
   &&new RegExp('^reviewed-analysis-'+r.businessDate+'-batch-[a-f0-9]{64}$').test(b.baseRecordKey||'')&&r.draft.singles[i].eventId===b.eventId&&!ids.has(b.eventId),'BASE');ids.add(b.eventId);
 }
 for(const g of r.groups){
  need(fields(g,'band,eventIds,size')&&[2,3].includes(g.size)&&[2.5,5,10].includes(g.band)&&Array.isArray(g.eventIds)&&g.eventIds.length===g.size
   &&new Set(g.eventIds).size===g.size&&g.eventIds.every(id=>ids.has(id)),'GROUP');
  const slot=g.size+'/'+g.band,identity=[...g.eventIds].sort().join('/');need(!slots.has(slot)&&!groups.has(identity),'DUPLICATE_GROUP');slots.add(slot);groups.add(identity);g.eventIds.forEach(id=>used.add(id));
 }
 need(used.size===ids.size,'UNUSED_LEG');return keyFor(r);
}
async function bases(c,r,at){
 const cache=new Map(),decisions=[];
 for(const [i,b]of r.bases.entries()){
  if(!cache.has(b.baseRecordKey)){
   const row=await single.row(c,b.baseRecordKey);need(row&&row.payloadSha256===b.basePayloadSha256,'BASE_CHANGED');
   const verified=await original.readPublication(c,b.baseRecordKey,at);cache.set(b.baseRecordKey,{row,verified});
  }
  const {row,verified}=cache.get(b.baseRecordKey);need(row.payloadSha256===b.basePayloadSha256,'BASE_CHANGED');
  const found=verified.v.record.records.filter(d=>d.eventId===b.eventId),drafts=verified.v.draft.singles.filter(d=>d.eventId===b.eventId);
  need(found.length===1&&drafts.length===1&&verified.v.draft.version===4&&p.hash(drafts[0])===p.hash(r.draft.singles[i]),'ORIGINAL_DIRECTION');
  need(ns(verified.ack.createdAt)!==null&&ns(verified.ack.createdAt)<ns(at),'BASE_ACK_CLOCK');decisions.push(found[0]);
 }
 return decisions;
}
function checkIdentity(record,first){
 need(record.records.length===first.length,'RECORD_COUNT');
 for(const [i,d]of record.records.entries()){
  const b=first[i];need(['eventId','eventVersion','businessDate','matchNum','homeTeamId','awayTeamId','homeTeamName','awayTeamName','market','handicap','selection','scores','confidence','reason','analysisUrl'].every(k=>p.hash(d[k]??null)===p.hash(b[k]??null))&&official.sameOfficialEventIdentity(b,d),'EVENT_CHANGED');
 }
}
function buildGroups(r,record){
 return r.groups.map(g=>{
  const decisions=g.eventIds.map(id=>record.records.find(d=>d.eventId===id));need(decisions.every(Boolean),'GROUP_RECORD');
  const legs=decisions.map(d=>({eventId:d.eventId,matchNum:d.matchNum,market:d.market,...(d.market==='HHAD'?{handicap:d.handicap}:{}),selection:d.selection,sp:d.sp}));
  const product=exactProduct(legs);need(product>=g.band,'BAND_UNFILLED');
  return {...g,legs,product,confidence:decisions.some(d=>d.confidence==='低')?'低':decisions.some(d=>d.confidence==='中')?'中':'高',cutoffAt:new Date(Math.min(...decisions.map(d=>Date.parse(d.cutoffAt)))).toISOString()};
 });
}
function deadline(v,at){
 const clock=ns(at);need(clock!==null&&ns(v.record.createdAt)!==null&&clock>ns(v.record.createdAt),'CLOCK');
 for(const d of [...v.record.records,...v.originalDecisions])need(ns(d.eventVersion)!==null&&ns(d.cutoffAt)!==null&&clock<ns(d.eventVersion)&&clock<ns(d.cutoffAt),'CLOSED_LEG');
 const lanes=v.inputs.snapshot.endpoints.filter(e=>['current','calculator'].includes(e.method));need(lanes.length===2,'LANES');
 for(const e of lanes)for(const t of [e.requestedAt,e.receivedAt])need(ns(t)!==null&&clock>=ns(t)&&clock-ns(t)<=30000000000n,'QUOTE_CLOCK');
}
async function rows(c,day){
 need(validDay(day),'DAY');
 const result=(await c.query('SELECT artifact_key FROM football.private_model_artifacts WHERE artifact_version=$1 AND artifact_key LIKE $2 ORDER BY generated_at,artifact_key LIMIT 2',[VERSION,'reviewed-combo-series-'+day+'-%'])).rows;
 need(result.length<=MAX_SERIES,'DAY_BOUND');return result;
}
async function verifyCommitted(c,key,at){
 const saved=await single.row(c,key);
 if(!saved){need(!await single.row(c,key+'-ack'),'ORPHAN_ACK');return {state:'not-observed',key,verified:false,retryWriteAutomatically:false};}
 const v=saved.payload;single.checkSeal(v);
 need(saved.artifactVersion===VERSION&&v.version===VERSION&&validate(v.request)===key&&v.createdAt===v.record.createdAt&&saved.generatedAt===v.createdAt&&saved.updatedAt===v.storedAt,'STORED_IDENTITY');
 const first=await bases(c,v.request,v.createdAt);need(p.hash(first)===p.hash(v.originalDecisions),'ORIGINAL_CHANGED');
 const record=p.make(v.request.draft,{...v.inputs,trustRegistry:single.trust(),asOf:v.createdAt});checkIdentity(record,first);
 need(p.hash(record)===p.hash(v.record)&&p.hash(buildGroups(v.request,record))===p.hash(v.groups),'REPLAY');deadline(v,v.storedAt);
 const ack=await single.row(c,key+'-ack');if(!ack)return {state:'record-present-ack-missing',key,verified:false,retryWriteAutomatically:false};
 const a=ack.payload;single.checkSeal(a);
 need(ack.artifactVersion===ACK_VERSION&&a.version===ACK_VERSION&&ack.generatedAt===a.createdAt&&ack.updatedAt===a.createdAt&&a.recordKey===key&&a.storedSha256===saved.payloadSha256&&a.recordHash===v.contentHash&&ns(a.createdAt)!==null&&ns(a.createdAt)>=ns(v.storedAt)&&ns(a.createdAt)<=ns(at),'ACK');deadline(v,a.createdAt);
 return {state:'committed-and-acknowledged',key,verified:true,payloadSha256:saved.payloadSha256,ackSha256:ack.payloadSha256,recordHash:v.contentHash,businessDate:v.request.businessDate,label:v.request.label,publishedAt:v.createdAt,commitObservedAt:a.createdAt,groups:v.groups,records:v.record.records,originalDecisions:first,originalSettlementPreserved:true,formalEligible:false,modelAdoption:false,retryWriteAutomatically:false};
}
function createStore({pool,runExclusive}={}){
 need(pool?.connect&&typeof runExclusive==='function','BROKER_REQUIRED');
 async function read(r){const key=validate(r);return single.transaction(pool,true,async c=>{const result=await verifyCommitted(c,key,await single.now(c)),saved=await single.row(c,key);if(saved)need(p.hash(saved.payload.request)===p.hash(r),'IMMUTABLE_CONFLICT');return result;});}
 async function publish(r){const key=validate(r);return runExclusive(async()=>{
  const before=await read(r);if(before.state!=='not-observed')return {...before,submitted:false};
  const stored=await single.transaction(pool,false,async c=>{
   await require('./researchAppendLock.cjs').acquireResearchAppendLock(c,{independentOfficial:r.draft.version===4});
   need(!await single.row(c,key)&&!await single.row(c,key+'-ack'),'EXISTS_READ_FIRST');
   const prior=await rows(c,r.businessDate);need(prior.length<MAX_SERIES,'DAY_BOUND');
   const groupIds=new Set(r.groups.map(g=>[...g.eventIds].sort().join('/')));
   for(const row of prior){const old=await single.row(c,row.artifact_key);single.checkSeal(old.payload);validate(old.payload.request);need(old.payload.request.groups.every(g=>!groupIds.has([...g.eventIds].sort().join('/'))),'GROUP_ALREADY_RECORDED');}
   const at=await single.now(c),first=await bases(c,r,at),snapshot=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs').readLiveOfficialSnapshot();
   const inputs={matches:[],snapshot},record=p.make(r.draft,{...inputs,trustRegistry:single.trust(),asOf:at});checkIdentity(record,first);
   const storedAt=await single.now(c),value=p.seal({version:VERSION,createdAt:at,storedAt,request:r,record,inputs,originalDecisions:first,groups:buildGroups(r,record)});deadline(value,storedAt);
   const saved=await single.insert(c,key,value,storedAt);deadline(value,await single.now(c));return saved;
  });
  await single.transaction(pool,false,async c=>{
   const saved=await single.row(c,key);need(saved?.payloadSha256===stored.payloadSha256,'COMMITTED_READBACK');const at=await single.now(c);deadline(saved.payload,at);
   await single.insert(c,key+'-ack',p.seal({version:ACK_VERSION,createdAt:at,recordKey:key,storedSha256:saved.payloadSha256,recordHash:saved.payload.contentHash}),at);deadline(saved.payload,await single.now(c));
  });
  const result=await read(r);need(result.verified,'READBACK_UNVERIFIED');return {...result,submitted:true};
 });}
 return {read,publish};
}
async function readDay(pool,day){
 return single.transaction(pool,true,async c=>{const at=await single.now(c),all=await rows(c,day),series=[];
  const observe=official.createOfficialEventObserver(at,{includeValidity:true});
  for(const row of all){const verified=await verifyCommitted(c,row.artifact_key,at);if(verified.verified){
   const open=observe(verified.records);series.push({...verified,openEventIds:[...open.keys()],saleValidUntil:Object.fromEntries([...open].map(([id,d])=>[id,d.saleValidUntil]))});
  }}
  const view={version:'reviewed-combo-series-view-v1',businessDate:day,updatedAt:at,series,formalEligible:false,modelAdoption:false};need(Buffer.byteLength(JSON.stringify(view))<=512*1024,'VIEW_BOUND');return view;
 });
}
function validateResponse(r,v,at){
 const key=validate(r);need(v&&v.key===key&&['not-observed','record-present-ack-missing','committed-and-acknowledged'].includes(v.state)&&v.retryWriteAutomatically===false,'RESPONSE');
 need(v.verified===(v.state==='committed-and-acknowledged'),'RESPONSE_STATE');if(!v.verified)return true;
 need(['payloadSha256','ackSha256','recordHash'].every(k=>hex(v[k]))&&v.businessDate===r.businessDate&&v.label===r.label&&v.originalSettlementPreserved===true&&v.formalEligible===false&&v.modelAdoption===false,'RESPONSE_IDENTITY');
 need(ns(v.publishedAt)!==null&&ns(v.commitObservedAt)!==null&&ns(at)!==null&&ns(v.publishedAt)<ns(v.commitObservedAt)&&ns(v.commitObservedAt)<=ns(at)&&ns(v.commitObservedAt)-ns(v.publishedAt)<=30000000000n,'RESPONSE_CLOCK');
 need(Array.isArray(v.records)&&Array.isArray(v.originalDecisions)&&v.records.length===r.bases.length&&v.originalDecisions.length===r.bases.length,'RESPONSE_ROWS');
 checkIdentity({records:v.records},v.originalDecisions);
 for(const [i,d]of v.records.entries()){
  const pick=r.draft.singles[i];need(d.eventId===pick.eventId&&d.market===pick.market&&(d.handicap??null)===pick.handicap&&d.selection===pick.selection&&p.hash(d.scores)===p.hash(pick.scores)
   &&d.homeTeamName===pick.teams[0]&&d.awayTeamName===pick.teams[1]&&d.modelProbability===null&&d.modelVersion===null&&d.formalEligible===false
   &&ns(d.cutoffAt)>ns(v.commitObservedAt)&&ns(d.eventVersion)>ns(v.commitObservedAt)&&ns(d.quoteObservedAt)!==null&&ns(d.quoteObservedAt)<=ns(v.publishedAt)&&ns(v.commitObservedAt)-ns(d.quoteObservedAt)<=30000000000n,'RESPONSE_LEG');
 }
 need(p.hash(buildGroups(r,{records:v.records}))===p.hash(v.groups),'RESPONSE_GROUPS');return true;
}
module.exports={VERSION,ACK_VERSION,validate,keyFor,journalId,groupIdentity,buildGroups,deadline,checkIdentity,createStore,verifyCommitted,readDay,validateResponse};
