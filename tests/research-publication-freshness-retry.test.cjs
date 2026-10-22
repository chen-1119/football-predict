'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const retry=require('../server/researchPublicationFreshnessRetry.cjs'),p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const {decodeRequest,createResearchWriteService}=require('../server/researchWriteService.cjs');
const {requestJournalIdentity}=require('../scripts/researchReleaseBroker.cjs');
function fixture(){
 const draft={version:4,eventAuthority:'signed-official-events-v1',businessDate:'2026-10-22',singles:[]},json=JSON.stringify(draft);
 const input={version:'research-broker-request-v1',action:'publish',draftHash:p.hash(draft),json,sha256:p.sha(json)};
 const originalRequestJson=JSON.stringify(input),originalRequestSha256=p.sha(originalRequestJson),releaseSha='a'.repeat(64);
 const intent={version:'research-broker-intent-v1',requestSha:originalRequestSha256,releaseSha,admittedAt:'2026-10-22T07:19:38.879Z',automaticWriteRetry:false};
 const receipt={version:'research-broker-result-v1',requestSha:originalRequestSha256,releaseSha,finishedAt:'2026-10-22T07:19:39.070Z',code:1,overflow:false,stdout:'',stderr:JSON.stringify({ok:false,error:retry.ERROR,retryWriteAutomatically:false})+'\n',automaticWriteRetry:false};
 const installed={releaseSha:'b'.repeat(64),freshInputSourceSha256:retry.REQUIRED_FRESH_INPUT_SHA256};
 const make=()=>({version:input.version,action:retry.ACTION,originalRequestJson,originalRequestSha256,failedReceiptSha256:p.sha(JSON.stringify(receipt)+'\n')});
 const read=(file,max)=>{const base='/var/lib/football-research-broker/'+originalRequestSha256;
  a.ok([base+'.intent.json',base+'.receipt.json'].includes(file),'fixed trusted original path');
  a.equal(max,file.endsWith('.receipt.json')?3*1024*1024:4096);
  return Buffer.from(JSON.stringify(file.endsWith('.receipt.json')?receipt:intent)+(file.endsWith('.receipt.json')?'\n':''));};
 return{input,draft,intent,receipt,installed,make,read};
}
test('freshness retry binds exact V4 bytes, completed failure and reviewed installed repair',()=>{
 const f=fixture(),r=f.make();a.deepEqual(decodeRequest(Buffer.from(JSON.stringify(r))),r);a.deepEqual(retry.original(r),f.input);
 a.match(retry.REQUIRED_FRESH_INPUT_SHA256,/^[a-f0-9]{64}$/);
 const proof=retry.verifyFailure(r,f.read,f.installed);a.equal(proof.originalRequestSha256,r.originalRequestSha256);
 a.equal(proof.originalReleaseSha,f.receipt.releaseSha);a.equal(proof.installedReleaseSha,f.installed.releaseSha);
 a.equal(r.originalRequestJson,JSON.stringify(f.input));
});
for(const [name,change]of [
 ['successful child',f=>{f.receipt.code=0;}],['unknown child',f=>{f.receipt.code=null;}],['overflow',f=>{f.receipt.overflow=true;}],
 ['unknown commit',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:'LEAGUE_MODEL_COMMIT_UNKNOWN',retryWriteAutomatically:false});}],
 ['old lock retry error',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:'55P03',retryWriteAutomatically:false});}],
 ['other prospective error',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:'REVIEWED_ANALYSIS_PROSPECTIVE',retryWriteAutomatically:false});}],
 ['partial stdout',f=>{f.receipt.stdout='{}';}],['auto retry',f=>{f.receipt.automaticWriteRetry=true;}],
 ['stderr extra fields',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:retry.ERROR,retryWriteAutomatically:false,allow:true});}],
 ['stderr auto retry',f=>{f.receipt.stderr=JSON.stringify({ok:false,error:retry.ERROR,retryWriteAutomatically:true});}],
 ['wrong original',f=>{f.receipt.requestSha='c'.repeat(64);}],['wrong intent original',f=>{f.intent.requestSha='c'.repeat(64);}],
 ['wrong intent release',f=>{f.intent.releaseSha='c'.repeat(64);}],['invalid release',f=>{f.receipt.releaseSha='unverified';}],
 ['same installed release',f=>{f.installed.releaseSha=f.receipt.releaseSha;}],['wrong repair bytes',f=>{f.installed.freshInputSourceSha256='0'.repeat(64);}],
 ['unknown installed fields',f=>{f.installed.allow=true;}],['unknown receipt fields',f=>{f.receipt.retryAllowed=true;}],
 ['future finish',f=>{f.receipt.finishedAt='2099-01-01T00:00:00.000Z';}],['finish before admission',f=>{f.receipt.finishedAt='2026-10-22T07:19:38.000Z';}],
 ['ambiguous admission clock',f=>{f.intent.admittedAt='2026-10-22 07:19:38';}],['automatic intent',f=>{f.intent.automaticWriteRetry=true;}],
])test('freshness retry refuses '+name,()=>{const f=fixture();change(f);a.throws(()=>retry.verifyFailure(f.make(),f.read,f.installed),{code:'RESEARCH_PUBLICATION_FRESHNESS_RETRY_REFUSED'});});
test('missing or non-UTF8 original journal cannot authorize retry',()=>{
 const f=fixture();a.throws(()=>retry.verifyFailure(f.make(),()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});},f.installed));
 a.throws(()=>retry.verifyFailure(f.make(),()=>Buffer.from([0xff]),f.installed));
});
test('only unchanged V4 publish is accepted; no nested retry, archive, new draft or extra authority',()=>{
 const f=fixture(),r=f.make();a.throws(()=>retry.original({...r,originalRequestJson:r.originalRequestJson+' '}));
 a.throws(()=>retry.verifyFailure({...r,failedReceiptSha256:'0'.repeat(64)},f.read,f.installed));
 for(const action of ['archive','publication-read','publication-retry',retry.ACTION]){
  const inner=JSON.stringify({...f.input,action});a.throws(()=>retry.original({...r,originalRequestJson:inner,originalRequestSha256:p.sha(inner)}));
 }
 for(const draft of [{...f.draft,version:3},{...f.draft,eventAuthority:'native'},null]){
  const json=JSON.stringify(draft),inner=JSON.stringify({...f.input,json,sha256:p.sha(json),draftHash:p.hash(draft)});
  a.throws(()=>retry.original({...r,originalRequestJson:inner,originalRequestSha256:p.sha(inner)}));
 }
 a.throws(()=>retry.original({...r,attempt:2}));a.throws(()=>retry.original({...r,originalRequestJson:'x'.repeat(1024*1024+1)}));
 const changedJson=f.input.json+' ',changed=JSON.stringify({...f.input,json:changedJson,sha256:p.sha(changedJson)});
 const changedRequest={...r,originalRequestJson:changed,originalRequestSha256:p.sha(changed)};
 a.throws(()=>retry.verifyFailure(changedRequest,f.read,f.installed));
});
test('one stable journal regardless of outer whitespace or claimed receipt and distinct from 55P03 journal',()=>{
 const f=fixture(),r=f.make(),first=requestJournalIdentity(Buffer.from(JSON.stringify(r))),next=requestJournalIdentity(Buffer.from(JSON.stringify(r,null,2)));
 a.equal(first.journalId,retry.journalId(r));a.equal(first.journalId,next.journalId);a.notEqual(first.requestSha,next.requestSha);a.equal(first.readOnly,false);
 a.equal(requestJournalIdentity(Buffer.from(JSON.stringify({...r,failedReceiptSha256:'f'.repeat(64)}))).journalId,first.journalId);
 a.notEqual(first.journalId,require('../server/researchPublicationRetry.cjs').journalId({...r,action:'publication-retry'}));
});
test('normal authenticated freshness route forwards exact envelope after both session checks',async()=>{
 const {Readable}=require('node:stream'),f=fixture(),raw=Buffer.from(JSON.stringify(f.make()));let auth=0,sent=0;
 const handler=require('../server/researchWriteHttp.cjs').createResearchWriteHandler({accounts:{async authorizeMutation(){auth++;return{user:{id:'synthetic-operator',role:'operator'}};}},submit:async b=>{a.deepEqual(b,raw);sent++;return{retryWriteAutomatically:false};}});
 const req=Readable.from([raw]);Object.assign(req,{method:'POST',headers:{'content-type':'application/json'}});const res={writeHead(s){this.status=s;},end(b){this.body=JSON.parse(b);}};
 a.equal(await handler(req,res,new URL('https://example.com/api/operator/research/publication-freshness-retry')),true);a.equal(res.status,200);a.equal(auth,2);a.equal(sent,1);
});
test('freshness response binds original request and explicit fresh retry',()=>{
 const f=fixture(),r=f.make(),raw=Buffer.from(JSON.stringify(r)),releaseSha=f.installed.releaseSha,now=new Date().toISOString();
 const value={ok:true,state:'not-observed',recordKey:'reviewed-analysis-2026-10-22-batch-'+f.input.draftHash,verified:false,submitted:false,retryWriteAutomatically:false,explicitFreshnessRetry:true,originalRequestSha256:r.originalRequestSha256};
 const envelope=()=>Buffer.from(JSON.stringify({version:'research-broker-result-v1',requestSha:p.sha(raw),releaseSha,finishedAt:now,code:0,overflow:false,stdout:JSON.stringify(value),stderr:'',automaticWriteRetry:false}));
 const decode=()=>require('../server/researchBrokerClient.cjs').decodeBrokerResponse(envelope(),raw,{releaseSha},Date.parse(now)-1000,Date.parse(now)+1000);
 a.equal(decode().explicitFreshnessRetry,true);delete value.explicitFreshnessRetry;a.throws(decode);value.explicitFreshnessRetry=true;value.originalRequestSha256='c'.repeat(64);a.throws(decode);
});
test('fresh DB read preserves partial record and orphan ACK without invoking publication',async()=>{
 for(const orphan of [false,true]){const f=fixture(),key='reviewed-analysis-2026-10-22-batch-'+f.input.draftHash;let writes=0;
 const pool={async connect(){return{release(){},async query(sql){if(/INSERT|UPDATE|DELETE/.test(sql))writes++;return{rows:sql.includes('artifact_key=ANY')?[{artifact_key:key+(orphan?'-ack':''),payload_sha256:'c'.repeat(64)}]:[]};}};}};
 const service=createResearchWriteService({pool,runExclusive:fn=>fn()}),out=await service.execute(Buffer.from(JSON.stringify(f.make())));
 a.equal(out.state,orphan?'orphan-ack-unverified':'record-present-ack-missing');a.equal(out.submitted,false);a.equal(out.explicitFreshnessRetry,true);a.equal(writes,0);
 }
});
