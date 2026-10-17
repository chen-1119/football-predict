'use strict';
// An explicit, single retry of the exact original publish bytes. The root
// broker checks its own immutable failure journal before launching the worker.
const {createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=()=>{throw Object.assign(Error('RESEARCH_PUBLICATION_RETRY_REFUSED'),{code:'RESEARCH_PUBLICATION_RETRY_REFUSED',retryWriteAutomatically:false});};
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
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
 original(r);const base='/var/lib/football-research-broker/'+r.originalRequestSha256;
 const receiptBytes=readTrusted(base+'.receipt.json',3*1024*1024);
 if(sha(receiptBytes)!==r.failedReceiptSha256)fail();
 let receipt,intent,error;try{receipt=JSON.parse(receiptBytes);intent=JSON.parse(readTrusted(base+'.intent.json',4096));error=JSON.parse(receipt.stderr);}catch{fail();}
 const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
 if(!receipt||Object.keys(receipt).sort().join(',')!=='automaticWriteRetry,code,finishedAt,overflow,releaseSha,requestSha,stderr,stdout,version'
  ||receipt.version!=='research-broker-result-v1'||receipt.requestSha!==r.originalRequestSha256||!hex(receipt.releaseSha)
  ||receipt.code!==1||receipt.overflow!==false||receipt.automaticWriteRetry!==false||receipt.stdout!==''
  ||!error||Object.keys(error).sort().join(',')!=='error,ok,retryWriteAutomatically'
  ||error.ok!==false||error.error!=='55P03'||error.retryWriteAutomatically!==false
  ||!intent||Object.keys(intent).sort().join(',')!=='admittedAt,automaticWriteRetry,releaseSha,requestSha,version'
  ||intent.version!=='research-broker-intent-v1'||intent.requestSha!==receipt.requestSha||intent.releaseSha!==receipt.releaseSha
  ||intent.automaticWriteRetry!==false||!iso(now)||!iso(intent.admittedAt)||!iso(receipt.finishedAt)
  ||Date.parse(intent.admittedAt)>Date.parse(receipt.finishedAt)||Date.parse(receipt.finishedAt)>Date.parse(now))fail();
 return {originalRequestSha256:r.originalRequestSha256,failedReceiptSha256:r.failedReceiptSha256,
  originalFinishedAt:receipt.finishedAt,originalReleaseSha:receipt.releaseSha};
}
module.exports={original,journalId,verifyFailure};
