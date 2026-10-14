'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const {validate,revisionKey,createRevisionStore}=require('../server/researchReviewedRevision.cjs');
const {decodeRequest}=require('../server/researchWriteService.cjs');
const draft={version:3,businessDate:'2026-10-14',singles:[{eventId:'2041965'}]};
const request={version:'reviewed-single-request-v1',baseRecordKey:'reviewed-analysis-2026-10-14-batch-'+'a'.repeat(64),basePayloadSha256:'b'.repeat(64),eventId:'2041965',revision:1,previousRevisionHash:null,draft,draftHash:p.hash(draft)};
test('new review namespace binds one exact draft and preserves the original artifact key',()=>{
 a.equal(validate(request),'reviewed-single-2026-10-14-2041965-v01');
 const json=JSON.stringify(request),r={version:'research-broker-request-v1',action:'revision-publish',json,sha256:p.sha(json)};
 a.deepEqual(decodeRequest(Buffer.from(JSON.stringify(r))),r);
 a.equal(decodeRequest(Buffer.from(JSON.stringify({...r,action:'revision-read'}))).action,'revision-read');
});
for(const [label,change]of [['arbitrary fields',r=>{r.overwriteOriginal=true;}],['missing base hash',r=>{delete r.basePayloadSha256;}],['different day',r=>{r.baseRecordKey=r.baseRecordKey.replace('2026-10-14','2026-10-13');}],['wrong draft',r=>{r.draftHash='c'.repeat(64);}],['missing predecessor',r=>{r.revision=2;}],['first predecessor',r=>{r.previousRevisionHash='c'.repeat(64);}],['out of bound revision',r=>{r.revision=17;}],['different event',r=>{r.eventId='2041966';}]])
 test('review request refuses '+label,()=>{const r=structuredClone(request);change(r);a.throws(()=>validate(r));});
test('revision store has no direct write path without the root broker dependency',()=>{
 a.throws(()=>createRevisionStore({pool:{connect(){}}}),{code:'REVIEW_REVISION_BROKER_REQUIRED'});
 a.throws(()=>revisionKey('2026-10-14','../x',1),{code:'REVIEW_REVISION_IDENTITY'});
});
