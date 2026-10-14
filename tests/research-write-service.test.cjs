'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {decodeRequest,createResearchWriteService,MAX_REQUEST_BYTES}=require('../server/researchWriteService.cjs');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const json=JSON.stringify({version:'cloud-research-report-v1',businessDate:'2026-10-14',reportKind:'weekday-2100-full',generatedAt:'2026-10-14T03:00:00.000Z',contents:{text:'来源缺项明确保留'}});
const archive={version:'research-broker-request-v1',action:'archive',json,sha256:p.sha(json)};
test('archive request retains original exact UTF8 JSON',()=>a.equal(decodeRequest(Buffer.from(JSON.stringify(archive))).json,json));
for(const [name,value,code]of [
 ['arbitrary action',{...archive,action:'exec'},'RESEARCH_REQUEST_ACTION'],
 ['database override',{...archive,database:'anything'},'RESEARCH_REQUEST_FIELDS'],
 ['program override',{...archive,program:'/bin/sh'},'RESEARCH_REQUEST_FIELDS'],
 ['hash mismatch',{...archive,sha256:'0'.repeat(64)},'RESEARCH_REQUEST_HASH'],
 ['invalid archive date',{...archive,json:json.replace('2026-10-14','2026-02-30'),sha256:p.sha(json.replace('2026-10-14','2026-02-30'))},'REPORT_DATE'],
])test(name+' refused before DB access',()=>a.throws(()=>decodeRequest(Buffer.from(JSON.stringify(value))),{code}));
test('oversize and malformed UTF8 refused',()=>{
 a.throws(()=>decodeRequest(Buffer.alloc(MAX_REQUEST_BYTES+1)),{code:'RESEARCH_REQUEST_BOUND'});
 a.throws(()=>decodeRequest(Buffer.from([123,255,125])),{code:'RESEARCH_REQUEST_UTF8'});
});
test('write service cannot be created without explicit broker dependency',()=>a.throws(()=>createResearchWriteService({pool:{connect(){}}}),{code:'RESEARCH_BROKER_REQUIRED'}));
test('publication read binds the requested original draft identity',()=>{
 const draftHash='a'.repeat(64),recordKey='reviewed-analysis-2026-10-14-batch-'+draftHash;
 const r={version:'research-broker-request-v1',action:'publication-read',recordKey,draftHash};
 a.deepEqual(decodeRequest(Buffer.from(JSON.stringify(r))),r);
 a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,draftHash:'b'.repeat(64)}))),{code:'RESEARCH_REQUEST_IDENTITY'});
});
test('already present record without ACK is read and cannot be republished',async()=>{
 let held=false,writes=0;
 const draft={version:3,businessDate:'2026-10-14',singles:[]},draftHash=p.hash(draft),key='reviewed-analysis-2026-10-14-batch-'+draftHash;
 const pool={async connect(){a.equal(held,true);return {release(){},async query(sql){
  if(sql.includes('INSERT')||sql.includes('UPDATE'))writes++;
  return {rows:sql.includes('artifact_key=ANY')?[{artifact_key:key,payload_sha256:'c'.repeat(64)}]:[]};
 }}}};
 const s=createResearchWriteService({pool,runExclusive:async action=>{held=true;try{return await action();}finally{held=false;}}});
 const body=JSON.stringify(draft),r={version:'research-broker-request-v1',action:'publish',json:body,sha256:p.sha(body),draftHash};
 const result=await s.execute(Buffer.from(JSON.stringify(r)));a.equal(result.state,'record-present-ack-missing');a.equal(result.submitted,false);a.equal(writes,0);
});
