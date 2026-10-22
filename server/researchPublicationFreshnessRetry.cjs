'use strict';
// One explicit retry of unchanged V4 publish bytes after a completed freshness
// refusal. Root verifies its retained journal and the installed source repair.
const {createHash}=require('node:crypto');
const {hash}=require('../src/services/leagueBaselineModel.cjs');
const REQUIRED_FRESH_INPUT_SHA256='be7a0ab324d86b967321b432f3c39e6b2062dbe74f7c892af4fc1bf4612682e9';
const ACTION='publication-freshness-retry';
const ERROR='REVIEWED_ANALYSIS_OFFICIAL_EVENT_FRESH_CLOCK';
const sha=x=>createHash('sha256').update(x).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const utf8=x=>typeof x==='string'&&Buffer.from(x,'utf8').toString('utf8')===x;
const fail=()=>{throw Object.assign(Error('RESEARCH_PUBLICATION_FRESHNESS_RETRY_REFUSED'),{code:'RESEARCH_PUBLICATION_FRESHNESS_RETRY_REFUSED',retryWriteAutomatically:false});};
function original(r){
 if(!r||Object.keys(r).sort().join(',')!=='action,failedReceiptSha256,originalRequestJson,originalRequestSha256,version'
  ||r.version!=='research-broker-request-v1'||r.action!==ACTION||!hex(r.originalRequestSha256)||!hex(r.failedReceiptSha256)
  ||!utf8(r.originalRequestJson)||Buffer.byteLength(r.originalRequestJson)>1024*1024
  ||sha(r.originalRequestJson)!==r.originalRequestSha256)fail();
 let input,draft;try{input=JSON.parse(r.originalRequestJson);draft=JSON.parse(input.json);}catch{fail();}
 if(!input||Object.keys(input).sort().join(',')!=='action,draftHash,json,sha256,version'
  ||input.version!==r.version||input.action!=='publish'||!utf8(input.json)||Buffer.byteLength(input.json)>1024*1024
  ||!hex(input.sha256)||sha(input.json)!==input.sha256||!hex(input.draftHash)||hash(draft)!==input.draftHash
  ||draft?.version!==4||draft.eventAuthority!=='signed-official-events-v1')fail();
 return input;
}
function journalId(r){original(r);return sha('research-publication-freshness-retry-v1:'+r.originalRequestSha256);}
function verifyFailure(r,readTrusted,installed,now=new Date().toISOString()){
 original(r);
 if(!installed||Object.keys(installed).sort().join(',')!=='freshInputSourceSha256,releaseSha'
  ||!hex(installed.releaseSha)||!hex(REQUIRED_FRESH_INPUT_SHA256)
  ||installed.freshInputSourceSha256!==REQUIRED_FRESH_INPUT_SHA256)fail();
 const base='/var/lib/football-research-broker/'+r.originalRequestSha256;
 const receiptBytes=readTrusted(base+'.receipt.json',3*1024*1024);
 if(!Buffer.isBuffer(receiptBytes)||!Buffer.from(receiptBytes.toString('utf8'),'utf8').equals(receiptBytes)
  ||sha(receiptBytes)!==r.failedReceiptSha256)fail();
 let receipt,intent,error;
 try{
  receipt=JSON.parse(receiptBytes);const intentBytes=readTrusted(base+'.intent.json',4096);
  if(!Buffer.isBuffer(intentBytes)||!Buffer.from(intentBytes.toString('utf8'),'utf8').equals(intentBytes))fail();
  intent=JSON.parse(intentBytes);error=JSON.parse(receipt.stderr);
 }catch{fail();}
 const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
 if(!receipt||Object.keys(receipt).sort().join(',')!=='automaticWriteRetry,code,finishedAt,overflow,releaseSha,requestSha,stderr,stdout,version'
  ||receipt.version!=='research-broker-result-v1'||receipt.requestSha!==r.originalRequestSha256||!hex(receipt.releaseSha)
  ||receipt.releaseSha===installed.releaseSha||receipt.code!==1||receipt.overflow!==false||receipt.automaticWriteRetry!==false||receipt.stdout!==''
  ||!error||Object.keys(error).sort().join(',')!=='error,ok,retryWriteAutomatically'
  ||error.ok!==false||error.error!==ERROR||error.retryWriteAutomatically!==false
  ||!intent||Object.keys(intent).sort().join(',')!=='admittedAt,automaticWriteRetry,releaseSha,requestSha,version'
  ||intent.version!=='research-broker-intent-v1'||intent.requestSha!==receipt.requestSha||intent.releaseSha!==receipt.releaseSha
  ||intent.automaticWriteRetry!==false||!iso(now)||!iso(intent.admittedAt)||!iso(receipt.finishedAt)
  ||Date.parse(intent.admittedAt)>Date.parse(receipt.finishedAt)||Date.parse(receipt.finishedAt)>Date.parse(now))fail();
 return {originalRequestSha256:r.originalRequestSha256,failedReceiptSha256:r.failedReceiptSha256,
  originalFinishedAt:receipt.finishedAt,originalReleaseSha:receipt.releaseSha,installedReleaseSha:installed.releaseSha,
  freshInputSourceSha256:installed.freshInputSourceSha256};
}
module.exports={ACTION,ERROR,REQUIRED_FRESH_INPUT_SHA256,original,journalId,verifyFailure};
