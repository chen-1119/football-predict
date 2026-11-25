'use strict';
// An explicit, single retry of the exact original publish bytes. The root
// broker checks its own immutable failure journal before launching the worker.
const {createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=()=>{throw Object.assign(Error('RESEARCH_PUBLICATION_RETRY_REFUSED'),{code:'RESEARCH_PUBLICATION_RETRY_REFUSED',retryWriteAutomatically:false});};
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
// This release's exact V4 publisher raises the wait-budget error before opening
// its publication transaction. Do not infer that guarantee for another release
// or admit arbitrary timeouts, unknown COMMIT outcomes, or nested retries.
const PREWRITE_WAIT_RELEASE='dafb150f5ee6ac18d79f56035688abb2a2ee717d6fd173dcfe99a83b9c645851';
// r936's sealed publisher retains the identical pre-transaction wait boundary.
const PREWRITE_WAIT_RELEASE_R936='e8fc23c56fa63f111995845f25e0a81f5de5d68cf9fe8d7ff7c5348feca78d69';
function recoverableFailure(input,receipt,error){
 if(error==='55P03')return true;
 if(error!=='REVIEWED_ANALYSIS_OFFICIAL_FRESH_WAIT_BUDGET'||![PREWRITE_WAIT_RELEASE,PREWRITE_WAIT_RELEASE_R936].includes(receipt.releaseSha))return false;
 try{const draft=JSON.parse(input.json);return draft?.version===4&&draft.eventAuthority==='signed-official-events-v1'
  &&typeof input.json==='string'&&hex(input.sha256)&&sha(input.json)===input.sha256
  &&hex(input.draftHash)&&require('../src/services/leagueBaselineModel.cjs').hash(draft)===input.draftHash;}catch{return false;}
}
function original(r){
 if(!r||Object.keys(r).sort().join(',')!=='action,failedReceiptSha256,originalRequestJson,originalRequestSha256,version'
  ||r.version!=='research-broker-request-v1'||r.action!=='publication-retry'||!hex(r.originalRequestSha256)||!hex(r.failedReceiptSha256)
  ||typeof r.originalRequestJson!=='string'||Buffer.byteLength(r.originalRequestJson)>1024*1024
  ||sha(r.originalRequestJson)!==r.originalRequestSha256)fail();
 let input;try{input=JSON.parse(r.originalRequestJson);}catch{fail();}
 if(!input||input.version!==r.version||input.action!=='publish'
  ||Object.keys(input).sort().join(',')!=='action,draftHash,json,sha256,version')fail();
 return input;
}
function journalId(r){original(r);return sha('research-publication-retry-v1:'+r.originalRequestSha256);}
function verifyFailure(r,readTrusted,now=new Date().toISOString()){
 const input=original(r);const base='/var/lib/football-research-broker/'+r.originalRequestSha256;
 const receiptBytes=readTrusted(base+'.receipt.json',3*1024*1024);
 if(sha(receiptBytes)!==r.failedReceiptSha256)fail();
 let receipt,intent,error;try{receipt=JSON.parse(receiptBytes);intent=JSON.parse(readTrusted(base+'.intent.json',4096));error=JSON.parse(receipt.stderr);}catch{fail();}
 const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
 if(!receipt||Object.keys(receipt).sort().join(',')!=='automaticWriteRetry,code,finishedAt,overflow,releaseSha,requestSha,stderr,stdout,version'
  ||receipt.version!=='research-broker-result-v1'||receipt.requestSha!==r.originalRequestSha256||!hex(receipt.releaseSha)
  ||receipt.code!==1||receipt.overflow!==false||receipt.automaticWriteRetry!==false||receipt.stdout!==''
  ||!error||Object.keys(error).sort().join(',')!=='error,ok,retryWriteAutomatically'
  ||error.ok!==false||!recoverableFailure(input,receipt,error.error)||error.retryWriteAutomatically!==false
  ||!intent||Object.keys(intent).sort().join(',')!=='admittedAt,automaticWriteRetry,releaseSha,requestSha,version'
  ||intent.version!=='research-broker-intent-v1'||intent.requestSha!==receipt.requestSha||intent.releaseSha!==receipt.releaseSha
  ||intent.automaticWriteRetry!==false||!iso(now)||!iso(intent.admittedAt)||!iso(receipt.finishedAt)
  ||Date.parse(intent.admittedAt)>Date.parse(receipt.finishedAt)||Date.parse(receipt.finishedAt)>Date.parse(now))fail();
 return {originalRequestSha256:r.originalRequestSha256,failedReceiptSha256:r.failedReceiptSha256,
  originalFinishedAt:receipt.finishedAt,originalReleaseSha:receipt.releaseSha};
}
module.exports={original,journalId,verifyFailure,PREWRITE_WAIT_RELEASE,PREWRITE_WAIT_RELEASE_R936};
