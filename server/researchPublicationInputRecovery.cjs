'use strict';
// One reviewed recovery after the original lock failure and its sole explicit
// retry both ended without output. Neither historical journal is reopened.
const {createHash}=require('node:crypto');
const retry=require('./researchPublicationRetry.cjs');
const sha=x=>createHash('sha256').update(x).digest('hex');
const REPAIR_SOURCE_SHA256='c0ddc1bd225801c3899ec8b25fc5999e45c0eb41049bd6408e39db2538078c15';
const fail=()=>{throw Object.assign(Error('RESEARCH_PUBLICATION_INPUT_RECOVERY_REFUSED'),{code:'RESEARCH_PUBLICATION_INPUT_RECOVERY_REFUSED',retryWriteAutomatically:false});};
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function prior(r){
 if(!r||Object.keys(r).sort().join(',')!=='action,failedRetryReceiptSha256,priorRetryRequestJson,priorRetryRequestSha256,version'
  ||r.version!=='research-broker-request-v1'||r.action!=='publication-input-recovery'
  ||!hex(r.failedRetryReceiptSha256)||!hex(r.priorRetryRequestSha256)
  ||typeof r.priorRetryRequestJson!=='string'||Buffer.byteLength(r.priorRetryRequestJson)>1024*1024
  ||sha(r.priorRetryRequestJson)!==r.priorRetryRequestSha256)fail();
 let input;try{input=JSON.parse(r.priorRetryRequestJson);}catch{fail();}
 retry.original(input);return input;
}
function journalId(r){return sha('research-publication-input-recovery-v1:'+prior(r).originalRequestSha256);}
function verifyFailures(r,readTrusted,installed,now=new Date().toISOString()){
 const input=prior(r),original=retry.verifyFailure(input,readTrusted,now);
 if(!installed||!hex(installed.releaseSha)||installed.releaseSha===original.originalReleaseSha
  ||installed.repairSourceSha256!==REPAIR_SOURCE_SHA256)fail();
 const base='/var/lib/football-research-broker/'+retry.journalId(input);
 const bytes=readTrusted(base+'.receipt.json',3*1024*1024);
 if(sha(bytes)!==r.failedRetryReceiptSha256)fail();
 let receipt,intent,error;try{receipt=JSON.parse(bytes);intent=JSON.parse(readTrusted(base+'.intent.json',4096));error=JSON.parse(receipt.stderr);}catch{fail();}
 const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
 if(!receipt||Object.keys(receipt).sort().join(',')!=='automaticWriteRetry,code,finishedAt,overflow,releaseSha,requestSha,stderr,stdout,version'
  ||receipt.version!=='research-broker-result-v1'||receipt.requestSha!==r.priorRetryRequestSha256
  ||receipt.releaseSha!==original.originalReleaseSha||receipt.code!==1||receipt.overflow!==false
  ||receipt.automaticWriteRetry!==false||receipt.stdout!==''
  ||!error||Object.keys(error).sort().join(',')!=='error,ok,retryWriteAutomatically'
  ||error.ok!==false||error.error!=='REVIEWED_ANALYSIS_PROSPECTIVE'||error.retryWriteAutomatically!==false
  ||!intent||Object.keys(intent).sort().join(',')!=='admittedAt,automaticWriteRetry,releaseSha,requestSha,version'
  ||intent.version!=='research-broker-intent-v1'||intent.requestSha!==receipt.requestSha||intent.releaseSha!==receipt.releaseSha
  ||intent.automaticWriteRetry!==false||!iso(now)||!iso(intent.admittedAt)||!iso(receipt.finishedAt)
  ||Date.parse(original.originalFinishedAt)>Date.parse(intent.admittedAt)
  ||Date.parse(intent.admittedAt)>Date.parse(receipt.finishedAt)||Date.parse(receipt.finishedAt)>Date.parse(now))fail();
 return {...original,priorRetryRequestSha256:r.priorRetryRequestSha256,failedRetryReceiptSha256:r.failedRetryReceiptSha256,priorRetryFinishedAt:receipt.finishedAt};
}
module.exports={REPAIR_SOURCE_SHA256,prior,journalId,verifyFailures};
