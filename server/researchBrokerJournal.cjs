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
function journalBudget(directory,reserveBytes){
 const names=fs.readdirSync(directory);if(names.length+2>MAX_FILES)fail('RESEARCH_JOURNAL_CAPACITY');
 const entries=names.map(name=>{
  if(!/^[a-f0-9]{64}(?:-read-[a-f0-9]{24})?\.(?:intent|receipt)\.json$/.test(name))fail('RESEARCH_JOURNAL_FILE_IDENTITY');
  const s=fs.lstatSync(directory+'/'+name);
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||(s.mode&0o077))fail('RESEARCH_JOURNAL_FILE_IDENTITY');
  return {bytes:s.size};
 });
 const s=fs.statfsSync(directory);return checkBudget(entries,s.bavail*s.bsize,reserveBytes);
}
module.exports={MAX_FILES,MAX_TOTAL_BYTES,MIN_FREE_BYTES,checkBudget,journalBudget};
