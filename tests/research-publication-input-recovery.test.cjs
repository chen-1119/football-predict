'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const recovery=require('../server/researchPublicationInputRecovery.cjs'),retry=require('../server/researchPublicationRetry.cjs');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const {decodeRequest,createResearchWriteService}=require('../server/researchWriteService.cjs');
const {requestJournalIdentity}=require('../scripts/researchReleaseBroker.cjs');
function fixture(){
 const draft={version:3,businessDate:'2026-10-18',singles:[]},json=JSON.stringify(draft);
 const original={version:'research-broker-request-v1',action:'publish',draftHash:p.hash(draft),json,sha256:p.sha(json)};
 const originalRequestJson=JSON.stringify(original),originalRequestSha256=p.sha(originalRequestJson),releaseSha='a'.repeat(64);
 const intent=(requestSha,at)=>({version:'research-broker-intent-v1',requestSha,releaseSha,admittedAt:at,automaticWriteRetry:false});
 const receipt=(requestSha,at,error)=>({version:'research-broker-result-v1',requestSha,releaseSha,finishedAt:at,code:1,overflow:false,stdout:'',stderr:JSON.stringify({ok:false,error,retryWriteAutomatically:false})+'\n',automaticWriteRetry:false});
 const first=receipt(originalRequestSha256,'2026-10-18T03:12:23.378Z','55P03'),firstIntent=intent(originalRequestSha256,'2026-10-18T03:12:21.199Z');
 const prior={version:original.version,action:'publication-retry',originalRequestJson,originalRequestSha256,failedReceiptSha256:p.sha(JSON.stringify(first))};
 const priorRetryRequestJson=JSON.stringify(prior),priorRetryRequestSha256=p.sha(priorRetryRequestJson);
 const last=receipt(priorRetryRequestSha256,'2026-10-18T03:19:24.795Z','REVIEWED_ANALYSIS_PROSPECTIVE'),lastIntent=intent(priorRetryRequestSha256,'2026-10-18T03:19:24.512Z');
 const make=()=>({version:original.version,action:'publication-input-recovery',priorRetryRequestJson,priorRetryRequestSha256,failedRetryReceiptSha256:p.sha(JSON.stringify(last))});
 const read=file=>{const b='/var/lib/football-research-broker/';const files={[b+originalRequestSha256+'.receipt.json']:first,[b+originalRequestSha256+'.intent.json']:firstIntent,[b+retry.journalId(prior)+'.receipt.json']:last,[b+retry.journalId(prior)+'.intent.json']:lastIntent};a.ok(files[file],'exact fixed journal path');return Buffer.from(JSON.stringify(files[file]));};
 return{original,prior,first,firstIntent,last,lastIntent,make,read,installed:{releaseSha:'b'.repeat(64),repairSourceSha256:recovery.REPAIR_SOURCE_SHA256}};
}
test('input recovery binds both original terminal failures and the installed reviewed repair',()=>{
 const f=fixture(),r=f.make();a.deepEqual(decodeRequest(Buffer.from(JSON.stringify(r))),r);a.deepEqual(recovery.prior(r),f.prior);
 a.equal(recovery.verifyFailures(r,f.read,f.installed).originalRequestSha256,f.prior.originalRequestSha256);
 // This one-release recovery remains pinned to its historical r903 source.
 // New sync code must not silently expand or reactivate the consumed scope.
 a.equal(recovery.REPAIR_SOURCE_SHA256,'c0ddc1bd225801c3899ec8b25fc5999e45c0eb41049bd6408e39db2538078c15');
 const candidateSourceSha=p.sha(require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../scripts/syncData.cjs')));
 a.notEqual(candidateSourceSha,recovery.REPAIR_SOURCE_SHA256);
 a.throws(()=>recovery.verifyFailures(r,f.read,{...f.installed,repairSourceSha256:candidateSourceSha}),/INPUT_RECOVERY_REFUSED/);
});
for(const [name,change]of [
 ['success',f=>{f.last.code=0;}],['unknown exit',f=>{f.last.code=null;}],['partial stdout',f=>{f.last.stdout='{}';}],
 ['overflow',f=>{f.last.overflow=true;}],['automatic retry',f=>{f.last.automaticWriteRetry=true;}],
 ['other lock failure',f=>{f.last.stderr=JSON.stringify({ok:false,error:'55P03',retryWriteAutomatically:false});}],
 ['unknown commit',f=>{f.last.stderr=JSON.stringify({ok:false,error:'COMMIT_UNKNOWN',retryWriteAutomatically:false});}],
 ['wrong prior request',f=>{f.last.requestSha='c'.repeat(64);}],['wrong release',f=>{f.last.releaseSha='c'.repeat(64);}],
 ['wrong intent release',f=>{f.lastIntent.releaseSha='c'.repeat(64);}],['extra receipt field',f=>{f.last.allowed=true;}],
 ['extra child field',f=>{f.last.stderr=JSON.stringify({ok:false,error:'REVIEWED_ANALYSIS_PROSPECTIVE',retryWriteAutomatically:false,allowed:true});}],
 ['future finish',f=>{f.last.finishedAt='2099-01-01T00:00:00.000Z';}],
 ['finish before intent',f=>{f.last.finishedAt='2026-10-18T03:19:20.000Z';}],
 ['retry before first finish',f=>{f.lastIntent.admittedAt='2026-10-18T03:12:22.000Z';}],
 ['old installed release',f=>{f.installed.releaseSha='a'.repeat(64);}],['different repair source',f=>{f.installed.repairSourceSha256='c'.repeat(64);}],
 ['changed original receipt',f=>{f.first.stdout='{}';}],['changed original intent',f=>{f.firstIntent.releaseSha='c'.repeat(64);}],
])test('input recovery refuses '+name,()=>{const f=fixture();change(f);a.throws(()=>recovery.verifyFailures(f.make(),f.read,f.installed));});
test('missing either journal or altered exact parent bytes cannot authorize recovery',()=>{
 const f=fixture(),r=f.make();a.throws(()=>recovery.verifyFailures(r,()=>{throw Error('missing');},f.installed));
 a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,priorRetryRequestJson:r.priorRetryRequestJson+' '}))));
 a.throws(()=>recovery.verifyFailures({...r,failedRetryReceiptSha256:'c'.repeat(64)},f.read,f.installed));
 const recursive=JSON.stringify(r);a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,priorRetryRequestJson:recursive,priorRetryRequestSha256:p.sha(recursive)}))));
 a.throws(()=>decodeRequest(Buffer.from(JSON.stringify({...r,attempt:2}))));
});
test('one stable original identity prevents whitespace, receipt and parent-envelope changes allocating attempts',()=>{
 const f=fixture(),r=f.make(),first=requestJournalIdentity(Buffer.from(JSON.stringify(r)));
 a.equal(first.readOnly,false);
 for(const variant of [JSON.stringify(r,null,2),JSON.stringify({...r,failedRetryReceiptSha256:'d'.repeat(64)})])a.equal(requestJournalIdentity(Buffer.from(variant)).journalId,first.journalId);
 const priorRetryRequestJson=JSON.stringify(f.prior,null,2);
 a.equal(requestJournalIdentity(Buffer.from(JSON.stringify({...r,priorRetryRequestJson,priorRetryRequestSha256:p.sha(priorRetryRequestJson)}))).journalId,first.journalId);
 a.notEqual(first.journalId,retry.journalId(f.prior));
});
test('normal authorized endpoint checks the session twice and preserves exact request bytes',async()=>{
 const {Readable}=require('node:stream'),f=fixture(),raw=Buffer.from(JSON.stringify(f.make()));let auth=0,submissions=0;
 const handler=require('../server/researchWriteHttp.cjs').createResearchWriteHandler({accounts:{async authorizeMutation(){auth++;return{user:{id:'synthetic-operator',role:'operator'}};}},submit:async bytes=>{submissions++;a.deepEqual(bytes,raw);return{retryWriteAutomatically:false};}});
 const req=Readable.from([raw]);Object.assign(req,{method:'POST',headers:{'content-type':'application/json'}});const res={writeHead(s){this.status=s;},end(b){this.body=JSON.parse(b);}};
 await handler(req,res,new URL('https://example.com/api/operator/research/publication-input-recovery'));a.equal(res.status,200);a.equal(auth,2);a.equal(submissions,1);
});
test('client requires the explicit input recovery marker and exact original identity',()=>{
 const f=fixture(),raw=Buffer.from(JSON.stringify(f.make())),releaseSha='b'.repeat(64),now=new Date().toISOString();
 const value={ok:true,state:'not-observed',recordKey:'reviewed-analysis-2026-10-18-batch-'+f.original.draftHash,verified:false,submitted:false,retryWriteAutomatically:false,explicitInputRecovery:true,originalRequestSha256:f.prior.originalRequestSha256};
 const envelope=()=>Buffer.from(JSON.stringify({version:'research-broker-result-v1',requestSha:p.sha(raw),releaseSha,finishedAt:now,code:0,overflow:false,stdout:JSON.stringify(value),stderr:'',automaticWriteRetry:false}));
 const decode=()=>require('../server/researchBrokerClient.cjs').decodeBrokerResponse(envelope(),raw,{releaseSha},Date.parse(now)-1000,Date.parse(now)+1000);
 a.equal(decode().explicitInputRecovery,true);delete value.explicitInputRecovery;a.throws(decode);value.explicitInputRecovery=true;value.originalRequestSha256='c'.repeat(64);a.throws(decode);
});
test('partial record and orphan ACK remain read-only and never produce a replacement ACK',async()=>{
 for(const orphan of [false,true]){const f=fixture(),key='reviewed-analysis-2026-10-18-batch-'+f.original.draftHash;let writes=0;
 const pool={async connect(){return{release(){},async query(sql){if(/INSERT|UPDATE|DELETE/.test(sql))writes++;return{rows:sql.includes('artifact_key=ANY')?[{artifact_key:key+(orphan?'-ack':''),payload_sha256:'c'.repeat(64)}]:[]};}};}};
 const out=await createResearchWriteService({pool,runExclusive:fn=>fn()}).execute(Buffer.from(JSON.stringify(f.make())));
 a.equal(out.state,orphan?'orphan-ack-unverified':'record-present-ack-missing');a.equal(out.submitted,false);a.equal(out.explicitInputRecovery,true);a.equal(writes,0);
 }
});
