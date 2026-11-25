'use strict';
const fs=require('node:fs');
const MAX_FILES=4096,MAX_TOTAL_BYTES=256*1024*1024,MIN_FREE_BYTES=64*1024*1024;
const fail=code=>{throw Object.assign(Error(code),{code,retryWriteAutomatically:false});};
function checkBudget(entries,availableBytes,reserveBytes){
 if(!Array.isArray(entries)||entries.length+2>MAX_FILES||!Number.isSafeInteger(availableBytes)||availableBytes<MIN_FREE_BYTES+reserveBytes
  ||!Number.isSafeInteger(reserveBytes)||reserveBytes<1||reserveBytes>5*1024*1024)fail('RESEARCH_JOURNAL_CAPACITY');
 let total=0;
 for(const entry of entries){
  if(!entry||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>4*1024*1024)fail('RESEARCH_JOURNAL_FILE_BOUND');
  total+=entry.bytes;if(total+reserveBytes>MAX_TOTAL_BYTES)fail('RESEARCH_JOURNAL_CAPACITY');
 }
 return {files:entries.length,bytes:total,reserveBytes};
}
function isJournalFileName(name){
 if(typeof name!=='string')return false;
 if(/^[a-f0-9]{64}(?:-read-[a-f0-9]{24})?\.(?:intent|receipt)\.json$/.test(name))return true;
 // The series publisher claims one immutable journal per business day. Count
 // these original files too; their presence grants no retry or write authority.
 const match=/^combo-series-day-(\d{4}-\d{2}-\d{2})\.(?:intent|receipt)\.json$/.exec(name);
 if(!match)return false;
 const at=Date.parse(match[1]+'T00:00:00.000Z');
 return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===match[1];
}
function journalBudget(directory,reserveBytes){
 const names=fs.readdirSync(directory);if(names.length+2>MAX_FILES)fail('RESEARCH_JOURNAL_CAPACITY');
 const entries=names.map(name=>{
  if(!isJournalFileName(name))fail('RESEARCH_JOURNAL_FILE_IDENTITY');
  const s=fs.lstatSync(directory+'/'+name);
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||(s.mode&0o077))fail('RESEARCH_JOURNAL_FILE_IDENTITY');
  return {bytes:s.size};
 });
 const s=fs.statfsSync(directory);return checkBudget(entries,s.bavail*s.bsize,reserveBytes);
}
module.exports={MAX_FILES,MAX_TOTAL_BYTES,MIN_FREE_BYTES,checkBudget,isJournalFileName,journalBudget};
