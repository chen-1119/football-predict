'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),projection=require('../server/researchReviewProjection.cjs');
const at='2030-01-01T10:00:00.000Z',original={businessDate:'2030-01-01',publicationHash:'a'.repeat(64),records:[{eventId:'100'}]};
test('no review means an empty distinct lane, never a fabricated direction or extra sample',async()=>{
 const before=JSON.stringify(original),value=await projection.projection({query:async()=>({rows:[]})},original,at);
 a.equal(value.state,'verified');a.deepEqual(value.singles,[]);a.deepEqual(value.combos,[]);a.equal(value.independentEventIncrement,0);a.equal(JSON.stringify(original),before);
 const {contentHash,...body}=value;a.equal(contentHash,p.hash(body));
});
for(const [label,row]of [
 ['bad byte count',{payload_bytes:100,actual_bytes:101}],['oversize',{payload_bytes:8*1024*1024+1,actual_bytes:8*1024*1024+1}],
 ['wrong version',{artifact_version:'arbitrary'}],['unknown artifact',{artifact_key:'reviewed-single-2030-01-01-100-v99'}],
 ['orphan ACK',{artifact_key:'reviewed-single-2030-01-01-100-v01-ack',artifact_version:'reviewed-single-revision-ack-v1'}],
])test('version discovery refuses '+label+' instead of showing an empty result',async()=>{
 const base={artifact_key:'reviewed-single-2030-01-01-100-v01',artifact_version:'reviewed-single-revision-v1',payload_bytes:100,actual_bytes:100,...row};
 await a.rejects(projection.projection({query:async()=>({rows:[base]})},original,at));
});
test('unknown match result is pending, ambiguous or unverified result is excluded',()=>{
 const d={eventId:'100',eventVersion:at,scores:[[1,0],[2,0]],selection:'h',market:'HAD'};
 a.equal(projection.settlement(d,[],at).state,'PENDING');
 const bad={sourceMatchId:'100',eventVersion:at};a.equal(projection.settlement(d,[bad],at).state,'DISPUTED');
 a.equal(projection.groupSettlement([{state:'WON'},{state:'PENDING'}]).state,'PENDING');
 a.equal(projection.groupSettlement([{state:'WON'},{state:'DISPUTED'}]).state,'DISPUTED');
});
