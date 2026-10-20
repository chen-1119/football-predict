'use strict';
// Each group has its own immutable chain. A single review never rewrites a leg.
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const original=require('../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs');
const archive=require('../services/recommendation/comboArchive.cjs');
const single=require('./researchReviewedRevision.cjs');
const {comboDisposition}=require('./researchRevisionPolicy.cjs');
const {epochNanoseconds:ns}=require('../src/services/prematchV3Clock.cjs');
const fail=code=>{throw Object.assign(Error(code),{code,retryWriteAutomatically:false});};
const VERSION='reviewed-combo-revision-v1',ACK_VERSION='reviewed-combo-revision-ack-v1';
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function validate(r){
 if(!r||Object.keys(r).sort().join(',')!=='band,baseArchiveKey,baseArchiveSha256,bases,draft,draftHash,previousRevisionHash,revision,size,version'
  ||r.version!=='reviewed-combo-request-v1'||![2,3].includes(r.size)||![2.5,5,10].includes(r.band)
  ||!/^reviewed-combo-view-\d{4}-\d{2}-\d{2}-[a-f0-9]{64}$/.test(r.baseArchiveKey||'')||!hex(r.baseArchiveSha256)
  ||!Array.isArray(r.bases)||r.bases.length!==r.size||![3,4].includes(r.draft?.version)||r.draft.singles?.length!==r.size
  ||!hex(r.draftHash)||p.hash(r.draft)!==r.draftHash||!Number.isSafeInteger(r.revision)||r.revision<1||r.revision>single.MAX_REVISIONS
  ||(r.revision===1?r.previousRevisionHash!==null:!hex(r.previousRevisionHash)))fail('REVIEW_REVISION_COMBO_REQUEST');
 const day=r.draft.businessDate;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!r.baseArchiveKey.startsWith('reviewed-combo-view-'+day+'-'))fail('REVIEW_REVISION_COMBO_DAY');
 for(const [i,b]of r.bases.entries())if(!b||Object.keys(b).sort().join(',')!=='basePayloadSha256,baseRecordKey,eventId'
  ||!/^[1-9]\d{0,19}$/.test(b.eventId||'')||b.eventId!==r.draft.singles[i].eventId||!hex(b.basePayloadSha256)
  ||!new RegExp('^reviewed-analysis-'+day+'-batch-[a-f0-9]{64}$').test(b.baseRecordKey||''))fail('REVIEW_REVISION_COMBO_BASE');
 const ids=r.bases.map(b=>b.eventId);if(new Set(ids).size!==r.size)fail('REVIEW_REVISION_COMBO_DUPLICATE');
 return 'reviewed-combo-'+day+'-'+p.hash({size:r.size,band:r.band,eventIds:[...ids].sort()})+'-v'+String(r.revision).padStart(2,'0');
}
function previousKey(r){return validate({...r,revision:r.revision-1,previousRevisionHash:r.revision===2?null:r.previousRevisionHash});}
function identity(r){return p.hash({baseArchiveKey:r.baseArchiveKey,baseArchiveSha256:r.baseArchiveSha256,bases:r.bases,size:r.size,band:r.band});}
function deadline(record,at){original.deadline(record,at);if(record.records.some(r=>ns(at)>=ns(r.eventVersion)))fail('REVIEW_REVISION_COMBO_ALREADY_STARTED');}
function group(record,band){
 const legs=record.records.map(r=>({eventId:r.eventId,matchNum:r.matchNum,market:r.market,...(r.market==='HHAD'?{handicap:r.handicap}:{}),selection:r.selection,sp:r.sp}));
 const product=require('../scripts/recommendationPlatform/reviewedComboHistory.cjs').exactProduct(legs);
 if(product<band)fail('REVIEW_REVISION_COMBO_BAND_UNFILLED');
 return {band,legs,product,confidence:record.records.some(r=>r.confidence==='低')?'低':record.records.some(r=>r.confidence==='中')?'中':'高'};
}
async function base(c,r,at){
 const saved=await single.row(c,r.baseArchiveKey);
 if(!saved||saved.artifactVersion!==archive.VERSION||saved.payloadSha256!==r.baseArchiveSha256)fail('REVIEW_REVISION_COMBO_ARCHIVE');
 const v=saved.payload;single.checkSeal(v);
 if(v.businessDate!==r.draft.businessDate||v.source?.artifactKey!==r.baseArchiveKey||ns(v.createdAt)===null||ns(v.createdAt)>ns(at)
  ||p.hash(archive.prepare(v.view,{generationId:v.source.generationId,committedAt:v.source.committedAt},v.source.observedAt).archive)!==p.hash(v))fail('REVIEW_REVISION_COMBO_ARCHIVE');
 const found=(r.size===2?v.view.combos:v.view.threeCombos).filter(g=>g.band===r.band);
 if(found.length!==1||p.hash(found[0].legs.map(l=>l.eventId))!==p.hash(r.bases.map(b=>b.eventId)))fail('REVIEW_REVISION_COMBO_ORIGINAL_LEGS');
 const decisions=[];
 for(const b of r.bases){
  const stored=await single.row(c,b.baseRecordKey);if(!stored||stored.payloadSha256!==b.basePayloadSha256)fail('REVIEW_REVISION_BASE_CHANGED');
  const old=await original.readPublication(c,b.baseRecordKey,at),rows=old.v.record.records.filter(d=>d.eventId===b.eventId);
  const archived=v.view.records.find(d=>d.eventId===b.eventId);if(rows.length!==1||!archived)fail('REVIEW_REVISION_BASE_EVENT');
  const {publicationCreatedAt,publicationCommitObservedAt,...core}=archived;void publicationCreatedAt;void publicationCommitObservedAt;
  if(p.hash(rows[0])!==p.hash(core))fail('REVIEW_REVISION_COMBO_BASE_CHANGED');decisions.push(rows[0]);
 }
 return {combo:found[0],decisions};
}
async function verifyCommitted(c,key,at,depth=0){
 if(depth>=single.MAX_REVISIONS)fail('REVIEW_REVISION_CHAIN_BOUND');
 const saved=await single.row(c,key);if(!saved){if(await single.row(c,key+'-ack'))fail('REVIEW_REVISION_ORPHAN_ACK');return {state:'not-observed',key,verified:false,retryWriteAutomatically:false};}
 const v=saved.payload;single.checkSeal(v);
 if(saved.artifactVersion!==VERSION||v.version!==VERSION||validate(v.request)!==key||v.createdAt!==v.record.createdAt||saved.generatedAt!==v.createdAt||saved.updatedAt!==v.storedAt
  ||ns(v.storedAt)===null||ns(v.createdAt)===null||ns(v.storedAt)<=ns(v.createdAt))fail('REVIEW_REVISION_COMBO_IDENTITY');
 const first=await base(c,v.request,at);
 if(p.hash(first)!==v.originalHash)fail('REVIEW_REVISION_COMBO_BASE_CHANGED');
 if(v.request.revision>1){const prior=await verifyCommitted(c,previousKey(v.request),at,depth+1);
  if(!prior.verified||prior.payloadSha256!==v.request.previousRevisionHash||prior.baseIdentity!==identity(v.request)||ns(prior.commitObservedAt)>=ns(v.createdAt))fail('REVIEW_REVISION_CHAIN');}
 const replay=p.make(v.request.draft,{...v.inputs,trustRegistry:single.trust(),asOf:v.createdAt});
 if(p.hash(replay)!==p.hash(v.record)||p.hash(group(replay,v.request.band))!==p.hash(v.combo))fail('REVIEW_REVISION_COMBO_REPLAY');
 if(v.record.records.some((r,i)=>['eventId','eventVersion','businessDate','homeTeamId','awayTeamId','homeTeamName','awayTeamName'].some(k=>r[k]!==first.decisions[i][k])||!require('../scripts/recommendationPlatform/reviewedOfficialEvent.cjs').sameOfficialEventIdentity(first.decisions[i],r)))fail('REVIEW_REVISION_EVENT_CHANGED');
 deadline(v.record,v.storedAt);
 const ack=await single.row(c,key+'-ack');if(!ack)return {state:'record-present-ack-missing',key,verified:false,retryWriteAutomatically:false};
 const a=ack.payload;single.checkSeal(a);
 if(ack.artifactVersion!==ACK_VERSION||a.version!==ACK_VERSION||ack.generatedAt!==a.createdAt||ack.updatedAt!==a.createdAt||a.recordKey!==key||a.storedSha256!==saved.payloadSha256
  ||a.recordHash!==v.record.contentHash||ns(a.createdAt)===null||ns(a.createdAt)<ns(v.storedAt)||ns(a.createdAt)>ns(at)||ns(a.createdAt)-ns(v.storedAt)>30000000000n)fail('REVIEW_REVISION_ACK');
 deadline(v.record,a.createdAt);
 return {state:'committed-and-acknowledged',key,verified:true,payloadSha256:saved.payloadSha256,ackSha256:ack.payloadSha256,baseIdentity:identity(v.request),
  baseArchiveKey:v.request.baseArchiveKey,baseArchiveSha256:v.request.baseArchiveSha256,previousRevisionHash:v.request.previousRevisionHash,revision:v.request.revision,
  originalCombo:first.combo,originalDecisions:first.decisions,latestDecisions:v.record.records,combo:v.combo,publishedAt:v.createdAt,commitObservedAt:a.createdAt,
  originalSettlementPreserved:true,independentEventIncrement:0,formalEligible:false,modelAdoption:false,retryWriteAutomatically:false};
}
function createComboRevisionStore({pool,runExclusive}={}){
 if(!pool?.connect||typeof runExclusive!=='function')fail('REVIEW_REVISION_BROKER_REQUIRED');
 async function read(r){const key=validate(r);return single.transaction(pool,true,async c=>{
  const result=await verifyCommitted(c,key,await single.now(c)),existing=await single.row(c,key);
  if(existing&&p.hash(existing.payload.request)!==p.hash(r))fail('REVIEW_REVISION_IMMUTABLE_CONFLICT');return result;
 });}
 async function publish(r){const key=validate(r);return runExclusive(async()=>{
  const before=await read(r);if(before.state!=='not-observed')return {...before,submitted:false};
  const stored=await single.transaction(pool,false,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['football-postgres-projection-sync-v1']);
   if(await single.row(c,key)||await single.row(c,key+'-ack'))fail('REVIEW_REVISION_EXISTS_READ_FIRST');
   const at=await single.now(c),first=await base(c,r,at);
   if(r.revision>1){const prior=await verifyCommitted(c,previousKey(r),at);
    if(!prior.verified||prior.payloadSha256!==r.previousRevisionHash||prior.baseIdentity!==identity(r)||ns(prior.commitObservedAt)>=ns(at))fail('REVIEW_REVISION_PREDECESSOR');}
   const all=r.draft.version===4?[]:(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513")).rows.map(x=>x.payload);
   if(all.length>512)fail('REVIEW_REVISION_MATCH_BOUND');
   const matches=all.filter(m=>r.bases.some(b=>b.eventId===String(m.sourceMatchId||'').replace(/^sporttery_/,'')));
   const snapshot=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs').readLiveOfficialSnapshot();
   const record=p.make(r.draft,{matches,snapshot,trustRegistry:single.trust(),asOf:at});
   const observed=record.records.map(d=>({...d,status:r.draft.version===4?'SCHEDULED':matches.find(m=>String(m.sourceMatchId||'').replace(/^sporttery_/,'')===d.eventId)?.status,isOnSale:true,observedAt:d.quoteObservedAt}));
   if(!comboDisposition({legs:first.decisions},observed,at).canRefresh)fail('REVIEW_REVISION_COMBO_FROZEN');
   if(record.records.some((d,i)=>['eventVersion','homeTeamId','awayTeamId','homeTeamName','awayTeamName'].some(k=>d[k]!==first.decisions[i][k])||!require('../scripts/recommendationPlatform/reviewedOfficialEvent.cjs').sameOfficialEventIdentity(first.decisions[i],d)))fail('REVIEW_REVISION_EVENT_CHANGED');
   const storedAt=await single.now(c);deadline(record,storedAt);
   const value=p.seal({version:VERSION,createdAt:at,storedAt,request:r,record,combo:group(record,r.band),inputs:{matches,snapshot},originalHash:p.hash(first)});
   const saved=await single.insert(c,key,value,storedAt);deadline(record,await single.now(c));return saved;
  });
  await single.transaction(pool,false,async c=>{
   const saved=await single.row(c,key);if(saved?.payloadSha256!==stored.payloadSha256)fail('REVIEW_REVISION_COMMITTED_READBACK');
   const at=await single.now(c);deadline(saved.payload.record,at);if(ns(at)-ns(saved.payload.storedAt)>30000000000n)fail('REVIEW_REVISION_ACK_CLOCK');
   await single.insert(c,key+'-ack',p.seal({version:ACK_VERSION,createdAt:at,recordKey:key,storedSha256:saved.payloadSha256,recordHash:saved.payload.record.contentHash}),at);
   deadline(saved.payload.record,await single.now(c));
  });
  const result=await read(r);if(!result.verified)fail('REVIEW_REVISION_READBACK_UNVERIFIED');return {...result,submitted:true};
 });}
 return {read,publish};
}
module.exports={VERSION,ACK_VERSION,validate,createComboRevisionStore,verifyCommitted};
