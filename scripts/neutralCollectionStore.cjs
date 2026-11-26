'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function bytes(file,maximum=8*1024*1024){
 const descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=fs.fstatSync(descriptor);if(!before.isFile()||before.nlink!==1||before.size>maximum)throw Error('SOURCE_BOUND');const value=fs.readFileSync(descriptor),after=fs.fstatSync(descriptor);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('SOURCE_CHANGED');return value;}finally{fs.closeSync(descriptor);}
}
function verified(file,hash){const value=bytes(file);if(!/^[a-f0-9]{64}$/.test(hash||'')||sha(value)!==hash)throw Error('SOURCE_HASH');return JSON.parse(value);}
function folder(directory){fs.mkdirSync(directory,{recursive:true,mode:0o700});if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())throw Error('DIRECTORY_BOUND');}
function load(store,kind){
 if(!/^[a-z][a-z0-9-]{0,50}$/.test(kind))throw Error('INDEX_KIND');
 try{const pointer=JSON.parse(bytes(path.join(store,kind+'-latest.json'),4096));if(!/^[a-f0-9-]{36}$/.test(pointer.id))throw Error('INDEX_ID');return verified(path.join(store,kind,pointer.id+'.json'),pointer.sha256);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function save(store,kind,value){
 if(!/^[a-z][a-z0-9-]{0,50}$/.test(kind))throw Error('INDEX_KIND');
 folder(path.join(store,kind));const id=crypto.randomUUID(),content=Buffer.from(JSON.stringify(value)+'\n');if(content.length>8*1024*1024)throw Error('INDEX_SIZE');
 const file=path.join(store,kind,id+'.json');fs.writeFileSync(file,content,{flag:'wx',mode:0o600});
 const pointer=path.join(store,kind+'-latest.json'),temporary=pointer+'.'+id;
 fs.writeFileSync(temporary,JSON.stringify({id,sha256:sha(content)})+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,pointer);return{id,sha256:sha(content)};
}
function indexOrg(store,report,directory){
 const previous=load(store,'org-fields')||{version:1,leagues:{}},leagues={...previous.leagues};
 for(const row of report.competitions){
  const source=row.sourceReceipts||row.partialSources||[],prior=leagues[row.code]||{fields:{}};
  const fields={...prior.fields};
  for(const receipt of source){
   const pathname=new URL(receipt.url).pathname,field=pathname.endsWith('/matches')?'matches':pathname.endsWith('/standings')?'standing':'metadata';
   if(!row.season||!/^\d{3}\.body$/.test(receipt.rawName)||!receipt.ok)continue;
   verified(path.join(directory,receipt.rawName),receipt.sha256);
   if(!fields[field]||Date.parse(receipt.receivedAt)>Date.parse(fields[field].receipt.receivedAt))fields[field]={observation:path.basename(directory),receipt,season:row.season};
  }
  leagues[row.code]={fields,lastAttemptAt:report.finishedAt,lastAttemptStatus:row.status,reason:row.reason||null};
 }
 return save(store,'org-fields',{version:1,updatedAt:report.finishedAt,leagues});
}
const identity=event=>JSON.stringify([event.eventId,event.businessDate,event.kickoff,event.homeTeamId,event.awayTeamId,event.homeTeamName,event.awayTeamName,event.leagueName]);
function mergeFields(previous,incoming,now){
 const fields={};
 for(const key of new Set([...Object.keys(previous||{}),...Object.keys(incoming||{})])){
  const old=previous?.[key],next=incoming?.[key];
  const usable=next&&next.value!==null&&next.value!==undefined&&Number.isFinite(Date.parse(next.observedAt))&&Date.parse(next.observedAt)<=now&&Array.isArray(next.sources)&&next.sources.length>0;
  const take=usable&&(!old||Date.parse(next.observedAt)>=Date.parse(old.observedAt))&&!(old?.complete===true&&next.complete===false);
  const chosen=take?next:old;
  if(chosen)fields[key]={...chosen,retained:!take||Boolean(next?.retained),lastAttemptStatus:next?.failure||(!usable?'missing':next.complete===false?'partial':'available')};
 }
 return fields;
}
module.exports={sha,bytes,verified,load,save,indexOrg,identity,mergeFields};
