'use strict';
const test=require('node:test'),a=require('node:assert/strict'),{Readable}=require('node:stream');
const {createResearchHttp}=require('../server/researchHttp.cjs'),{createHash}=require('node:crypto');
test('real read/write handlers coexist: authenticated POST reaches broker and GET remains readonly',async()=>{
 let submits=0,reads=0,mutations=0;
 const auth={user:{id:'synthetic-operator',role:'operator'}};
 const handler=createResearchHttp({accounts:{authenticate:async()=>auth,authorizeMutation:async()=>{mutations++;return auth;}},
  reader:{day:async()=>{reads++;return {existingBatchCount:0};}},submit:async()=>{submits++;return {retryWriteAutomatically:false};}});
 const json=JSON.stringify({version:'cloud-research-report-v1',businessDate:'2026-10-14',reportKind:'weekday-2100-full',generatedAt:'2026-10-14T13:00:00.000Z',contents:{text:'Synthetic routing request'}});
 const request=Buffer.from(JSON.stringify({version:'research-broker-request-v1',action:'archive',json,sha256:createHash('sha256').update(json).digest('hex')}));
 const response=()=>({writeHead(code){this.code=code;},end(body){this.body=JSON.parse(body);}});
 const post=Readable.from([request]);Object.assign(post,{method:'POST',headers:{'content-type':'application/json','content-length':String(request.length)}});
 const sent=response();a.equal(await handler(post,sent,new URL('https://example.com/api/operator/research/report')),true);a.equal(sent.code,200);a.equal(submits,1);a.equal(mutations,2);a.equal(reads,0);
 const read=response();await handler({method:'GET',headers:{}},read,new URL('https://example.com/api/operator/research/day?date=2026-10-14'));a.equal(read.code,200);a.equal(reads,1);a.equal(submits,1);
 const refused=response();await handler({method:'POST',headers:{}},refused,new URL('https://example.com/api/operator/research/day?date=2026-10-14'));a.equal(refused.code,405);a.equal(submits,1);
});
