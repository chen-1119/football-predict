'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {checkBudget,MAX_FILES,MAX_TOTAL_BYTES,MIN_FREE_BYTES}=require('../server/researchBrokerJournal.cjs');
test('journal accounts for receipt reservation before executing a database request',()=>{
 a.equal(checkBudget([{bytes:100}],MIN_FREE_BYTES+5*1024*1024,4*1024*1024).bytes,100);
});
for(const [name,entries,free,reserve] of [
 ['entry limit',Array.from({length:MAX_FILES-1},()=>({bytes:1})),MIN_FREE_BYTES+9e6,4e6],
 ['byte limit',Array.from({length:64},()=>({bytes:4*1024*1024})),MIN_FREE_BYTES+9e6,4e6],
 ['free space',[],MIN_FREE_BYTES+1,4e6],['unknown size',[{bytes:NaN}],MIN_FREE_BYTES+9e6,4e6],
 ['oversized file',[{bytes:MAX_TOTAL_BYTES}],MIN_FREE_BYTES+9e6,4e6],
])test('journal rejects '+name+' without deleting previous evidence',()=>a.throws(()=>checkBudget(entries,free,reserve)));

const {isJournalFileName}=require('../server/researchBrokerJournal.cjs');
test('journal accepts only the producer day namespace and existing hash namespaces',()=>{
 for(const name of ['combo-series-day-2026-10-25.intent.json','combo-series-day-2026-10-25.receipt.json','combo-series-day-2024-02-29.intent.json','a'.repeat(64)+'.receipt.json','b'.repeat(64)+'-read-'+'c'.repeat(24)+'.intent.json'])a.equal(isJournalFileName(name),true,name);
 for(const name of ['combo-series-day-2026-02-29.intent.json','combo-series-day-2026-13-01.receipt.json','combo-series-day-2026-04-31.intent.json','combo-series-day-2026-1-01.intent.json','combo-series-day-2026-10-25-read-abc.receipt.json','combo-series-day-2026-10-25.intent.json.old','../combo-series-day-2026-10-25.intent.json','combo-series-day-2026-10-25.pending.json',null])a.equal(isJournalFileName(name),false,String(name));
});
test('a completed series journal permits later report capacity checks without changing or retrying originals',()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'research-journal-series-'));
 const modulePath=require.resolve('../server/researchBrokerJournal.cjs'),source=fs.readFileSync(modulePath,'utf8'),m={exports:{}};
 // Windows cannot represent the installed POSIX modes. Only that metadata is
 // adapted in this local fixture; Linux exercises the real root-owned files.
 let statOverride=null;
 const fixtureFs={...fs,lstatSync(p){const s=fs.lstatSync(p);if(process.platform==='win32'){Object.defineProperties(s,{uid:{value:0,writable:true,configurable:true},mode:{value:(s.mode&~511)|384,writable:true,configurable:true}});}else if(typeof process.getuid==='function'&&process.getuid()!==0&&s.uid===process.getuid()){Object.defineProperty(s,'uid',{value:0,writable:true,configurable:true});}return statOverride?statOverride(s):s;}};
 vm.runInNewContext(source,{require:id=>id==='node:fs'?fixtureFs:require(id),module:m,Date});
 const budget=m.exports.journalBudget,files={'combo-series-day-2026-10-25.intent.json':'original series claim','combo-series-day-2026-10-25.receipt.json':'original committed receipt',['d'.repeat(64)+'.intent.json']:'older archive claim'};
 try{
  for(const [name,body]of Object.entries(files))fs.writeFileSync(path.join(dir,name),body,{flag:'wx',mode:384});
  const first=budget(dir,4*1024*1024);a.equal(first.files,3);a.equal(first.bytes,Object.values(files).reduce((n,s)=>n+Buffer.byteLength(s),0));
  for(const [label,alter]of [['symlink',s=>({...s,isFile:()=>true,isSymbolicLink:()=>true})],['foreign owner',s=>Object.assign(s,{uid:1})],['hard link',s=>Object.assign(s,{nlink:2})],['writable file',s=>Object.assign(s,{mode:s.mode|2})]]){
   statOverride=alter;a.throws(()=>budget(dir,4*1024*1024),{code:'RESEARCH_JOURNAL_FILE_IDENTITY'},label);
  }
  statOverride=null;fs.writeFileSync(path.join(dir,'unexpected.receipt.json'),'x',{mode:384});a.throws(()=>budget(dir,4*1024*1024),{code:'RESEARCH_JOURNAL_FILE_IDENTITY'});fs.unlinkSync(path.join(dir,'unexpected.receipt.json'));
  for(const [name,body]of Object.entries(files))a.equal(fs.readFileSync(path.join(dir,name),'utf8'),body);
  a.equal(budget(dir,4*1024*1024).files,3);
 }finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});
