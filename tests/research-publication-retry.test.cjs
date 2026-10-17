'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const retry=require('../server/researchPublicationRetry.cjs'),p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const {decodeRequest,createResearchWriteService}=require('../server/researchWriteService.cjs');
const {requestJournalIdentity}=require('../scripts/researchReleaseBroker.cjs');
function fixture(){
 const draft={version:3,businessDate:'2026-10-17',singles:[]},json=JSON.stringify(draft),input={version:'research-broker-request-v1',action:'publish',draftHash:p.hash(draft),json,sha256:p.sha(json)};
 const originalRequestJson=JSON.stringify(input),originalRequestSha256=p.sha(originalRequestJson),releaseSha='a'.repeat(64);
 const intent={version:'research-broker-intent-v1',requestSha:originalRequestSha256,releaseSha,admittedAt:'2026-10-17T04:24:09.942Z',automaticWriteRetry:false};
 const receipt={version:'research-broker-result-v1',requestSha:originalRequestSha256,releaseSha,finishedAt:'2026-10-17T04:24:12.153Z',code:1,overflow:false,stdout:'',stderr:JSON.stringify({ok:false,error:'55P03',retryWriteAutomatically:false})+'\n',automaticWriteRetry:false};
 const make=()=>({version:input.version,action:'publication-retry',originalRequestJson,originalRequestSha256,failedReceiptSha256:p.sha(JSON.stringify(receipt))});
 const read=(file)=>Buffer.from(JSON.stringify(file.endsWith('.receipt.json')?receipt:intent));
 return{input,draft,intent,receipt,make,read};
}
test('explicit retry preserves exact original publish bytes and binds completed 55P03 receipt',()=>{
 const f=fixture(),r=f.make();a.deepEqual(decodeRequest(Buffer.from(JSON.stringify(r))),r);a.deepEqual(retry.original(r),f.input);
 a.equal(retry.verifyFailure(r,f.read).originalRequestSha256,r.originalRequestSha256);
 a.equal(r.originalRequestJson,JSON.stringify(f.input));
});
for(const [name,change]of [
 ['successful child',f=>{f.receipt.code=0;}],['unknown child',f=>{f.receipt.code=null;}],['overflow',f=>{f.receipt.overflow=true;}],
 ['unknown commit',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:'LEAGUE_MODEL_COMMIT_UNKNOWN',retryWriteAutomatically:false});}],
 ['other failure',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:'42P01',retryWriteAutomatically:false});}],
 ['partial stdout',f=>{f.receipt.stdout='{}';}],['auto retry',f=>{f.receipt.automaticWriteRetry=true;}],
 ['wrong original',f=>{f.receipt.requestSha='b'.repeat(64);}],['wrong intent release',f=>{f.intent.releaseSha='b'.repeat(64);}],
 ['future finish',f=>{f.receipt.finishedAt='2099-01-01T00:00:00.000Z';}],['finish before admission',f=>{f.receipt.finishedAt='2026-10-17T04:24:08.000Z';}],
 ['unknown receipt fields',f=>{f.receipt.retryAllowed=true;}],
])test('retry refuses '+name,()=>{const f=fixture();change(f);a.throws(()=>retry.verifyFailure(f.make(),f.read),{code:'RESEARCH_PUBLICATION_RETRY_REFUSED'});});
test('missing intent or receipt cannot authorize a retry',()=>{const f=fixture();a.throws(()=>retry.verifyFailure(f.make(),()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}));});
test('parent bytes and request hash cannot be changed, nested retries and archive retries refused',()=>{
 const f=fixture(),r=f.make();a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,originalRequestJson:r.originalRequestJson+' '}))));
 a.throws(()=>retry.verifyFailure({...r,failedReceiptSha256:'0'.repeat(64)},f.read));
 for(const action of ['archive','publication-read','publication-retry']){const inner=JSON.stringify({...f.input,action});a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,originalRequestJson:inner,originalRequestSha256:p.sha(inner)}))));}
 a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,attempt:2}))));
});
test('outer whitespace or changed receipt hash cannot allocate another retry attempt',()=>{
 const f=fixture(),r=f.make(),first=requestJournalIdentity(Buffer.from(JSON.stringify(r))),second=requestJournalIdentity(Buffer.from(JSON.stringify(r,null,2)));
 a.equal(first.journalId,second.journalId);a.notEqual(first.requestSha,second.requestSha);a.equal(first.readOnly,false);
 a.equal(requestJournalIdentity(Buffer.from(JSON.stringify({...r,failedReceiptSha256:'f'.repeat(64)}))).journalId,first.journalId);
});
test('authenticated retry route checks session twice and forwards the exact retry envelope',async()=>{
 const {Readable}=require('node:stream'),f=fixture(),request=Buffer.from(JSON.stringify(f.make()));let auth=0,submissions=0;
 const handler=require('../server/researchWriteHttp.cjs').createResearchWriteHandler({accounts:{async authorizeMutation(){auth++;return{user:{id:'synthetic-operator',role:'operator'}};}},submit:async raw=>{submissions++;a.deepEqual(raw,request);return{retryWriteAutomatically:false};}});
 const req=Readable.from([request]);Object.assign(req,{method:'POST',headers:{'content-type':'application/json'}});const res={writeHead(s){this.status=s;},end(b){this.body=JSON.parse(b);}};
 await handler(req,res,new URL('https://example.com/api/operator/research/publication-retry'));a.equal(res.status,200);a.equal(auth,2);a.equal(submissions,1);
});
test('retry response must identify the original request and the explicit retry operation',()=>{
 const f=fixture(),input=f.make(),raw=Buffer.from(JSON.stringify(input)),releaseSha='b'.repeat(64),now=new Date().toISOString();
 const value={ok:true,state:'not-observed',recordKey:'reviewed-analysis-2026-10-17-batch-'+f.input.draftHash,verified:false,retryWriteAutomatically:false,explicitRetry:true,originalRequestSha256:input.originalRequestSha256};
 const envelope=()=>Buffer.from(JSON.stringify({version:'research-broker-result-v1',requestSha:p.sha(raw),releaseSha,finishedAt:now,code:0,overflow:false,stdout:JSON.stringify(value),stderr:'',automaticWriteRetry:false}));
 const decode=()=>require('../server/researchBrokerClient.cjs').decodeBrokerResponse(envelope(),raw,{releaseSha},Date.parse(now)-1000,Date.parse(now)+1000);
 a.equal(decode().explicitRetry,true);delete value.explicitRetry;a.throws(decode);value.explicitRetry=true;value.originalRequestSha256='c'.repeat(64);a.throws(decode);
});
test('a fresh database read sees a partial record or orphan ACK and never republishes or manufactures an ACK',async()=>{
 for(const orphan of [false,true]){const f=fixture(),key='reviewed-analysis-2026-10-17-batch-'+f.input.draftHash;let writes=0;
 const pool={async connect(){return{release(){},async query(sql){if(/INSERT|UPDATE|DELETE/.test(sql))writes++;return{rows:sql.includes('artifact_key=ANY')?[{artifact_key:key+(orphan?'-ack':''),payload_sha256:'c'.repeat(64)}]:[]};}};}};
 const service=createResearchWriteService({pool,runExclusive:fn=>fn()}),out=await service.execute(Buffer.from(JSON.stringify(f.make())));
 a.equal(out.state,orphan?'orphan-ack-unverified':'record-present-ack-missing');a.equal(out.submitted,false);a.equal(out.explicitRetry,true);a.equal(writes,0);
 }
});
