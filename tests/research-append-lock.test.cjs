'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {acquireResearchAppendLock,PROJECTION_KEY,APPEND_KEY}=require('../server/researchAppendLock.cjs');
test('independent immutable append retains shared projection exclusion then exclusive append order',async()=>{
 const calls=[];await acquireResearchAppendLock({query:async(...v)=>calls.push(v)},{independentOfficial:true});
 a.deepEqual(calls,[['SELECT pg_advisory_xact_lock_shared(hashtext($1))',[PROJECTION_KEY]],['SELECT pg_advisory_xact_lock(hashtext($1))',[APPEND_KEY]]]);
});
test('legacy/default keeps global exclusive and no caller timeout override',async()=>{
 const calls=[];await acquireResearchAppendLock({query:async(...v)=>calls.push(v)});
 a.equal(calls[0][0],'SELECT pg_advisory_xact_lock(hashtext($1))');a.equal(calls.length,2);
 await a.rejects(acquireResearchAppendLock({query:async()=>{}},{independentOfficial:'true'}));
});
test('global refusal never starts append lock and no SQL is retried',async()=>{
 let n=0;await a.rejects(acquireResearchAppendLock({query:async()=>{n++;throw Object.assign(Error('busy'),{code:'55P03'});}},{independentOfficial:true}),{code:'55P03'});a.equal(n,1);
});
