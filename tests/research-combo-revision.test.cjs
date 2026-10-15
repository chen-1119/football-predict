'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),combo=require('../server/researchComboRevision.cjs');
const {decodeRequest}=require('../server/researchWriteService.cjs');
function request(){const draft={version:3,businessDate:'2026-10-15',singles:[{eventId:'10001'},{eventId:'10002'}]};return {version:'reviewed-combo-request-v1',size:2,band:2.5,baseArchiveKey:'reviewed-combo-view-2026-10-15-'+'a'.repeat(64),baseArchiveSha256:'b'.repeat(64),bases:draft.singles.map(r=>({eventId:r.eventId,baseRecordKey:'reviewed-analysis-2026-10-15-batch-'+'c'.repeat(64),basePayloadSha256:'d'.repeat(64)})),revision:1,previousRevisionHash:null,draft,draftHash:p.hash(draft)};}
test('combo versions have a distinct fixed request purpose and immutable group key',()=>{
 const r=request(),key=combo.validate(r),json=JSON.stringify(r);
 a.match(key,/^reviewed-combo-2026-10-15-[a-f0-9]{64}-v01$/);
 for(const action of ['combo-revision-publish','combo-revision-read'])a.equal(decodeRequest(Buffer.from(JSON.stringify({version:'research-broker-request-v1',action,json,sha256:p.sha(json)}))).action,action);
 a.throws(()=>combo.createComboRevisionStore({pool:{connect(){}}}),{code:'REVIEW_REVISION_BROKER_REQUIRED'});
});
for(const [name,change]of [['swap legs',r=>r.bases.reverse()],['duplicate event',r=>r.bases[1]=r.bases[0]],['missing original',r=>delete r.baseArchiveSha256],['arbitrary destination',r=>{r.file='/tmp/x';}],['fake chain',r=>{r.revision=2;}],['too many legs',r=>{r.size=4;}],['wrong date',r=>{r.baseArchiveKey=r.baseArchiveKey.replace('2026-10-15','2026-10-14');}],['override identity',r=>{r.bases[0].program='anything';}]])test('combo review rejects '+name,()=>{const r=request();change(r);a.throws(()=>combo.validate(r));});
test('group identity does not depend on a new direction or price, so conflicting retries collide',()=>{
 const r=request(),before=combo.validate(r);r.draft.singles[0].selection='a';r.draftHash=p.hash(r.draft);a.equal(combo.validate(r),before);
});
test('a missing original confirmation is never mistaken for an unused combo',async()=>{
 const r=request(),key=combo.validate(r),payload=p.seal({version:combo.VERSION,createdAt:'2026-10-15T03:00:00.000Z',storedAt:'2026-10-15T03:00:00.001Z',request:r,record:{createdAt:'2026-10-15T03:00:00.000Z'}}),json=JSON.stringify(payload);
 const pool={async connect(){return {release(){},async query(sql,args){
  if(sql==='SELECT clock_timestamp() AS now')return {rows:[{now:'2026-10-15T03:00:00.100Z'}]};
  if(sql.startsWith('SELECT payload_bytes'))return {rows:args[0]===key?[{payload_bytes:Buffer.byteLength(json),bytes:Buffer.byteLength(json)}]:[]};
  if(sql.includes('payload::text'))return {rows:args[0]===key?[{artifact_key:key,artifact_version:combo.VERSION,generated_at:payload.createdAt,updated_at:payload.storedAt,payload_json:json,payload_sha256:p.sha(json),payload_bytes:Buffer.byteLength(json)}]:[]};
  return {rows:[]};
 }}}};
 await a.rejects(combo.createComboRevisionStore({pool,runExclusive:f=>f()}).publish(r),{code:'REVIEW_REVISION_COMBO_ARCHIVE'});
});
