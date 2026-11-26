'use strict';
const {streamInlineObjectEntries}=require('./streamedInlineObjectEntries.cjs');
// Read-only evidence for the r938 external-signals inline-row incident.
// This does not change worker health or grant a cutover lease.
function inlineFailure() {
  return {ok:false,code:'POSTGRES_INLINE_ROW_LIMIT',error:'Projection row exceeds the inline byte limit; use an admitted source JSON file',
    reviewId:null,existingMatchId:null,incomingMatchId:null,existingObservationId:null,incomingObservationId:null,existingIdentity:null,incomingIdentity:null};
}
function validateInlineAnchor(x) {
  const a=require('node:assert/strict'),c=require('node:crypto');
  a.deepEqual(Object.keys(x).sort(),['version','workerMainPid','workerStartedAt','cycleStartedAt','cycleFinishedAt','journalPid','journalTimestampUs','journalMessageSha256'].sort());
  a.equal(x.version,'external-inline-incident-v1');
  for(const k of ['workerMainPid','journalPid'])a.match(x[k]||'',/^[1-9][0-9]*$/);
  a.notEqual(x.workerMainPid,x.journalPid);
  for(const k of ['workerStartedAt','cycleStartedAt','cycleFinishedAt'])a.equal(new Date(x[k]).toISOString(),x[k]);
  a(Date.parse(x.workerStartedAt)<=Date.parse(x.cycleStartedAt)&&Date.parse(x.cycleStartedAt)<=Date.parse(x.cycleFinishedAt));
  a.match(x.journalTimestampUs||'',/^[1-9][0-9]{15}$/);
  const t=Number(x.journalTimestampUs)/1000;a(t>=Date.parse(x.cycleStartedAt)&&t<=Date.parse(x.cycleFinishedAt));
  a.equal(x.journalMessageSha256,c.createHash('sha256').update(JSON.stringify(inlineFailure(),null,2)).digest('hex'));
  return x;
}
function inlineIncidentAnchor(worker,journal) {
  const a=require('node:assert/strict'),c=require('node:crypto');
  const frame=JSON.stringify(inlineFailure(),null,2),cycle=worker.status.lastCycle;
  a.equal(journal.length,frame.split('\n').length);
  const first=journal[0];
  for(const row of journal){a.equal(row.unit,'football-sync-worker.service');a.equal(row.pid,first.pid);a.equal(row.timestampUs,first.timestampUs);a.equal(row.timestampMs,Number(row.timestampUs)/1000);}
  a.equal(journal.map(r=>r.message).join('\n'),frame);
  return validateInlineAnchor({version:'external-inline-incident-v1',workerMainPid:worker.serviceAfter.MainPID,
    workerStartedAt:new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),cycleStartedAt:cycle.startedAt,cycleFinishedAt:cycle.finishedAt,
    journalPid:first.pid,journalTimestampUs:first.timestampUs,journalMessageSha256:c.createHash('sha256').update(frame).digest('hex')});
}
function repeatedInlineIncident(anchor,worker,journal) {
  const a=require('node:assert/strict');validateInlineAnchor(anchor);const current=inlineIncidentAnchor(worker,journal);
  for(const k of ['workerMainPid','workerStartedAt','journalMessageSha256'])a.equal(current[k],anchor[k]);
  if(current.cycleStartedAt===anchor.cycleStartedAt&&current.cycleFinishedAt===anchor.cycleFinishedAt)a.deepEqual(current,anchor);
  else {a(Date.parse(current.cycleStartedAt)>=Date.parse(anchor.cycleFinishedAt));a(Date.parse(current.cycleFinishedAt)>Date.parse(anchor.cycleFinishedAt));a(BigInt(current.journalTimestampUs)>BigInt(anchor.journalTimestampUs));}
  return current;
}
function validateInlineSource(p) {
  const a=require('node:assert/strict');
  a.deepEqual(Object.keys(p).sort(),['version','table','id','column','inlineLimit','rawBytes','rawSha256','canonicalMapValuesBytesLowerBound','generationId','manifestHash','sourceCycleId','committedAt','stableIdentity'].sort());
  a.equal(p.version,'external-inline-source-v1');a.equal(p.table,'source_snapshots');a.equal(p.id,'external-signals:current');a.equal(p.column,'payload');
  a.equal(p.inlineLimit,134217728);a.equal(p.stableIdentity,true);
  for(const k of ['rawBytes','canonicalMapValuesBytesLowerBound'])a(Number.isSafeInteger(p[k])&&p[k]>p.inlineLimit&&p[k]<=768*1024*1024);
  for(const k of ['rawSha256','manifestHash'])a.match(p[k]||'',/^[a-f0-9]{64}$/);
  a.equal(p.generationId,'g-'+p.manifestHash);a.equal(new Date(p.committedAt).toISOString(),p.committedAt);
  a.equal(typeof p.sourceCycleId,'string');a(p.sourceCycleId.length>0&&p.sourceCycleId.length<=256);return p;
}
function assertInlineSourceContinuity(before,after,publication) {
  const a=require('node:assert/strict');validateInlineSource(before);validateInlineSource(after);
  for(const k of ['generationId','manifestHash','sourceCycleId','committedAt'])a.equal(after[k],publication.rawCurrent[k]);
  a(Date.parse(after.committedAt)>=Date.parse(before.committedAt));
  if(after.committedAt===before.committedAt)a.deepEqual(after,before);
}
function canonicalMapValuesLowerBound(file,entry) {
  const a=require('node:assert/strict'),{Buffer}=require('node:buffer');let total=2;
  const result=streamInlineObjectEntries(file,{keys:['matches'],inventoryFields:true,expectedBytes:entry.bytes,expectedSha256:entry.sha256,maxBytes:768*1024*1024,maxItemChars:16*1024*1024,onItem:(key,item,index)=>{
    a.equal(key,'matches');total+=Buffer.byteLength(JSON.stringify(item))+(index>0?1:0);a(Number.isSafeInteger(total)&&total<=768*1024*1024);
  }});
  a.equal(result.fields.length,1);a.equal(result.fields[0],'matches');a(result.counts.matches>0);return total;
}
function readInlineSource(root) {
  const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
  a.equal(root,'/opt/football-predict');a.equal(fs.realpathSync(root),root);
  const store='/var/lib/football-predict/data-generations',dirs=[];
  const stable=(x,y)=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(k=>x[k]===y[k]);
  function directory(p){const s=fs.lstatSync(p,{bigint:true});a(s.isDirectory()&&!s.isSymbolicLink());a.equal(fs.realpathSync(p),p);dirs.push({p,dev:s.dev,ino:s.ino});}
  function open(p,max){const entry=fs.lstatSync(p,{bigint:true});a(entry.isFile()&&!entry.isSymbolicLink()&&entry.nlink===1n&&entry.size<=BigInt(max));const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd,{bigint:true});try{a(stable(entry,s));}catch(e){fs.closeSync(fd);throw e;}return {p,fd,s};}
  function end(h){const s=fs.lstatSync(h.p,{bigint:true});a(s.isFile()&&!s.isSymbolicLink()&&stable(h.s,s)&&stable(h.s,fs.fstatSync(h.fd,{bigint:true})));}
  function small(p,max){const h=open(p,max);try{const b=fs.readFileSync(h.fd);end(h);return b;}finally{fs.closeSync(h.fd);}}
  directory('/var/lib/football-predict');directory(store);directory(store+'/generations');
  const pointerBytes=small(store+'/current.json',8192),pointer=JSON.parse(pointerBytes);a.equal(pointer.schemaVersion,1);a.match(pointer.generationId||'',/^g-[a-f0-9]{64}$/);
  const dir=store+'/generations/'+pointer.generationId;directory(dir);
  const manifestBytes=small(dir+'/manifest.json',4*1024*1024),manifest=JSON.parse(manifestBytes);
  const canonical=v=>{
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'){a(Number.isFinite(v));return v;}
    if(Array.isArray(v))return v.map(canonical);
    a(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype);
    const out={};for(const k of Object.keys(v).sort()){a(v[k]!==undefined);out[k]=canonical(v[k]);}return out;
  };
  const projection={schemaVersion:manifest.schemaVersion,sourceCycleId:manifest.sourceCycleId,coreFiles:manifest.coreFiles,files:manifest.files};
  a([1,2].includes(manifest.schemaVersion));a.equal(crypto.createHash('sha256').update(JSON.stringify(canonical(projection))).digest('hex'),pointer.manifestHash);
  a.equal(manifest.manifestHash,pointer.manifestHash);a.equal(manifest.generationId,pointer.generationId);a.equal(manifest.sourceCycleId,pointer.sourceCycleId);
  const entries=manifest.files.filter(x=>x.path==='external-signals.json');a.equal(entries.length,1);const entry=entries[0];
  a(Number.isSafeInteger(entry.bytes)&&entry.bytes>134217728&&entry.bytes<=768*1024*1024);a.match(entry.sha256,/^[a-f0-9]{64}$/);a.equal(entry.core,true);a(manifest.coreFiles.includes(entry.path));
  const file=dir+'/external-signals.json',h=open(file,768*1024*1024);let lowerBound;
  try {
    a.equal(h.s.size,BigInt(entry.bytes));
    lowerBound=canonicalMapValuesLowerBound(file,entry);end(h);
  }finally{fs.closeSync(h.fd);}
  a.deepEqual(small(store+'/current.json',8192),pointerBytes);a.deepEqual(small(dir+'/manifest.json',4*1024*1024),manifestBytes);
  for(const d of dirs){const s=fs.lstatSync(d.p,{bigint:true});a(s.isDirectory()&&!s.isSymbolicLink());a.equal(fs.realpathSync(d.p),d.p);a.equal(s.dev,d.dev);a.equal(s.ino,d.ino);}
  return validateInlineSource({version:'external-inline-source-v1',table:'source_snapshots',id:'external-signals:current',column:'payload',inlineLimit:134217728,
    rawBytes:entry.bytes,rawSha256:entry.sha256,canonicalMapValuesBytesLowerBound:lowerBound,generationId:pointer.generationId,manifestHash:pointer.manifestHash,sourceCycleId:pointer.sourceCycleId,committedAt:pointer.committedAt,stableIdentity:true});
}
module.exports={streamInlineObjectEntries,inlineFailure,validateInlineAnchor,inlineIncidentAnchor,repeatedInlineIncident,validateInlineSource,assertInlineSourceContinuity,canonicalMapValuesLowerBound,readInlineSource};
