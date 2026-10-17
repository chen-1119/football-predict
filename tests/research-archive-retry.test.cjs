'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const retry=require('../server/researchArchiveRetry.cjs'),{createHash}=require('node:crypto');
const {decodeRequest,createResearchWriteService}=require('../server/researchWriteService.cjs');
const {requestJournalIdentity}=require('../scripts/researchReleaseBroker.cjs');
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const report={version:'cloud-research-report-v1',businessDate:'2026-10-17',reportKind:'weekend-2200-full',generatedAt:'2026-10-17T14:05:35.808Z',contents:{text:'原文、空格与中文保持。',unverified:null}},json=JSON.stringify(report,null,2)+'\n';
 const input={version:'research-broker-request-v1',action:'archive',json,sha256:sha(json)},originalRequestJson=JSON.stringify(input),originalRequestSha256=sha(originalRequestJson),releaseSha='a'.repeat(64);
 const intent={version:'research-broker-intent-v1',requestSha:originalRequestSha256,releaseSha,admittedAt:'2026-10-17T14:06:30.807Z',automaticWriteRetry:false};
 const receipt={version:'research-broker-result-v1',requestSha:originalRequestSha256,releaseSha,finishedAt:'2026-10-17T14:06:33.011Z',code:1,overflow:false,stdout:'',stderr:JSON.stringify({ok:false,error:'55P03',retryWriteAutomatically:false})+'\n',automaticWriteRetry:false};
 const make=()=>({version:input.version,action:'archive-retry',originalRequestJson,originalRequestSha256,failedReceiptSha256:sha(JSON.stringify(receipt))});
 const read=file=>Buffer.from(JSON.stringify(file.endsWith('.receipt.json')?receipt:intent));
 return{report,json,input,intent,receipt,make,read};
}
test('archive retry binds exact original UTF-8 request and completed failure clocks',()=>{
 const f=fixture(),r=f.make();a.deepEqual(decodeRequest(Buffer.from(JSON.stringify(r))),r);a.deepEqual(retry.original(r),f.input);
 a.equal(retry.verifyFailure(r,f.read,'2026-10-17T14:07:00.000Z').originalReleaseSha,f.receipt.releaseSha);
 a.equal(r.originalRequestJson,JSON.stringify(f.input));
});
for(const [name,change]of [
 ['successful child',f=>{f.receipt.code=0;}],['unknown child',f=>{f.receipt.code=null;}],['overflow',f=>{f.receipt.overflow=true;}],
 ['unknown commit',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:'REPORT_COMMIT_UNKNOWN_READ_BEFORE_RETRY',retryWriteAutomatically:false});}],
 ['committed unverified readback',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:'REPORT_COMMITTED_READBACK_UNVERIFIED',retryWriteAutomatically:false});}],
 ['other failure',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:'42P01',retryWriteAutomatically:false});}],
 ['partial stdout',f=>{f.receipt.stdout='{}';}],['auto retry',f=>{f.receipt.automaticWriteRetry=true;}],
 ['wrong original',f=>{f.receipt.requestSha='b'.repeat(64);}],['wrong intent release',f=>{f.intent.releaseSha='b'.repeat(64);}],
 ['future finish',f=>{f.receipt.finishedAt='2099-01-01T00:00:00.000Z';}],['finish before admission',f=>{f.receipt.finishedAt='2026-10-17T14:06:29.000Z';}],
 ['unknown receipt fields',f=>{f.receipt.retryAllowed=true;}],['unknown intent fields',f=>{f.intent.retryAllowed=true;}],
])test('archive retry refuses '+name,()=>{const f=fixture();change(f);a.throws(()=>retry.verifyFailure(f.make(),f.read,'2026-10-17T14:07:00.000Z'),{code:'RESEARCH_ARCHIVE_RETRY_REFUSED'});});
test('missing receipt, changed hash, nested or other-purpose requests never authorize archive retry',()=>{
 const f=fixture(),r=f.make();a.throws(()=>retry.verifyFailure(r,()=>{throw Error('missing');}));
 a.throws(()=>retry.verifyFailure({...r,failedReceiptSha256:'0'.repeat(64)},f.read));
 a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,originalRequestJson:r.originalRequestJson+' '}))));
 for(const action of ['publish','archive-read','archive-retry','publication-retry']){
  const originalRequestJson=JSON.stringify({...f.input,action});
  a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,originalRequestJson,originalRequestSha256:sha(originalRequestJson)}))));
 }
 a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,attempt:2}))));
 const altered=JSON.stringify({...f.input,json:f.json+' '});
 a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,originalRequestJson:altered,originalRequestSha256:sha(altered)}))));
});
test('outer whitespace or changed receipt cannot allocate a second archive retry journal',()=>{
 const r=fixture().make(),first=requestJournalIdentity(Buffer.from(JSON.stringify(r))),other=requestJournalIdentity(Buffer.from(JSON.stringify(r,null,2)));
 a.equal(first.journalId,other.journalId);a.notEqual(first.requestSha,other.requestSha);a.equal(first.readOnly,false);
 a.equal(requestJournalIdentity(Buffer.from(JSON.stringify({...r,failedReceiptSha256:'f'.repeat(64)}))).journalId,first.journalId);
 a.notEqual(first.journalId,r.originalRequestSha256);
});
test('report retry uses the normal authenticated mutation handler and exact body',async()=>{
 const {Readable}=require('node:stream'),request=Buffer.from(JSON.stringify(fixture().make()));let auth=0,submissions=0;
 const handler=require('../server/researchWriteHttp.cjs').createResearchWriteHandler({accounts:{async authorizeMutation(){auth++;return{user:{id:'synthetic',role:'operator'}};}},submit:async raw=>{submissions++;a.deepEqual(raw,request);return{retryWriteAutomatically:false};}});
 const req=Readable.from([request]);Object.assign(req,{method:'POST',headers:{'content-type':'application/json'}});const res={writeHead(s){this.status=s;},end(b){this.body=JSON.parse(b);}};
 await handler(req,res,new URL('https://example.com/api/operator/research/report-retry'));a.equal(res.status,200);a.equal(auth,2);a.equal(submissions,1);
});
test('archive retry response validates original identity, full report bytes and commit or existing-read distinction',()=>{
 const f=fixture(),input=f.make(),raw=Buffer.from(JSON.stringify(input)),releaseSha='b'.repeat(64),now='2026-10-17T14:07:00.000Z';
 const value={ok:true,state:'report-archived',key:'research-report-2026-10-17-weekend-2200-full',sha256:f.input.sha256,bytes:Buffer.byteLength(f.json),originalJson:f.json,generatedAt:f.report.generatedAt,receivedAt:'2026-10-17T14:06:59.000Z',verificationScope:'archive-byte-integrity-only',published:false,recommendationEligibilityVerified:false,readbackVerified:true,retryWriteAutomatically:false,explicitRetry:true,originalRequestSha256:input.originalRequestSha256,submitted:true,inserted:true,commitAcknowledged:true};
 const envelope=()=>Buffer.from(JSON.stringify({version:'research-broker-result-v1',requestSha:sha(raw),releaseSha,finishedAt:now,code:0,overflow:false,stdout:JSON.stringify(value),stderr:'',automaticWriteRetry:false}));
 const decode=()=>require('../server/researchBrokerClient.cjs').decodeBrokerResponse(envelope(),raw,{releaseSha},Date.parse(now)-1000,Date.parse(now)+1000);
 a.equal(decode().inserted,true);delete value.commitAcknowledged;a.throws(decode);value.submitted=false;value.inserted=false;a.equal(decode().submitted,false);
 for(const [key,bad]of [['explicitRetry',false],['originalRequestSha256','c'.repeat(64)],['originalJson',f.json+' '],['published',true],['submitted',undefined],['inserted',true]]){
  const old=value[key];value[key]=bad;a.throws(decode,key);value[key]=old;
 }
});
test('exact archived report is read first and never takes the write path; conflict refuses',async()=>{
 const f=fixture(),row={artifact_key:'research-report-2026-10-17-weekend-2200-full',artifact_version:f.report.version,generated_at:f.report.generatedAt,updated_at:'2026-10-17T14:06:59.000Z',payload_json:f.json,payload_sha256:f.input.sha256,payload_bytes:Buffer.byteLength(f.json)};let writes=0;
 const pool={async connect(){return{release(){},async query(sql){if(/INSERT|UPDATE|DELETE/.test(sql))writes++;return{rows:sql.includes('octet_length')?[{payload_bytes:row.payload_bytes,actual_bytes:row.payload_bytes}]:sql.includes('payload::text')?[row]:[]};}};}};
 const service=createResearchWriteService({pool,runExclusive:fn=>fn()}),raw=Buffer.from(JSON.stringify(f.make())),out=await service.execute(raw);
 a.equal(out.originalJson,f.json);a.equal(out.submitted,false);a.equal(out.inserted,false);a.equal(out.commitAcknowledged,undefined);a.equal(writes,0);
 row.payload_json=f.json.replace('原文','改文');row.payload_sha256=sha(row.payload_json);
 await a.rejects(service.execute(raw),{code:'REPORT_IMMUTABLE_CONFLICT'});a.equal(writes,0);
});
test('a duplicate retry replays the original receipt clock and bytes without a new commit claim',()=>{
 const f=fixture(),input=f.make(),raw=Buffer.from(JSON.stringify(input)),releaseSha='b'.repeat(64),finishedAt='2026-10-17T14:07:00.000Z',deliveredAt='2026-10-17T14:08:00.000Z';
 const value={ok:true,state:'report-archived',key:'research-report-2026-10-17-weekend-2200-full',sha256:f.input.sha256,bytes:Buffer.byteLength(f.json),originalJson:f.json,generatedAt:f.report.generatedAt,receivedAt:'2026-10-17T14:06:59.000Z',verificationScope:'archive-byte-integrity-only',published:false,recommendationEligibilityVerified:false,readbackVerified:true,retryWriteAutomatically:false,explicitRetry:true,originalRequestSha256:input.originalRequestSha256,submitted:true,inserted:true,commitAcknowledged:true};
 const saved=Buffer.from(JSON.stringify({version:'research-broker-result-v1',requestSha:sha(raw),releaseSha,finishedAt,code:0,overflow:false,stdout:JSON.stringify(value),stderr:'',automaticWriteRetry:false}));
 const replay=require('../scripts/researchReleaseBroker.cjs').replayEnvelope(saved,sha(raw),releaseSha,deliveredAt);
 const decoded=require('../server/researchBrokerClient.cjs').decodeBrokerResponse(Buffer.from(JSON.stringify(replay)),raw,{releaseSha},Date.parse(deliveredAt)-1000,Date.parse(deliveredAt)+1000);
 a.equal(decoded.originalJson,f.json);a.equal(decoded.receivedAt,value.receivedAt);a.deepEqual(Buffer.from(replay.originalReceiptBase64,'base64'),saved);
 a.equal(replay.deliveredAt,deliveredAt);a.equal(JSON.parse(saved).finishedAt,finishedAt);
});
