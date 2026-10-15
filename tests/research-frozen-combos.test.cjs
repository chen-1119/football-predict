'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),archive=require('../services/recommendation/comboArchive.cjs');
const {freezeOriginalGroups,anchorCommitted}=require('../server/researchFrozenCombos.cjs');
function fixture(){
 const day='2030-01-01',records=[1.8,3.2,5.2].map((sp,i)=>({eventId:String(100+i),eventVersion:day+'T20:00:00.000Z',businessDate:day,matchNum:'周二00'+(i+1),homeTeamId:'h'+i,awayTeamId:'a'+i,homeTeamName:'Home'+i,awayTeamName:'Away'+i,market:'HAD',selection:'h',sp,originalSp:sp,scores:[[2,0],[2,1]],confidence:'中',reason:'Synthetic original',analysisUrl:'https://example.com/preview',limitations:['首发未核实'],cutoffAt:day+'T19:00:00.000Z',quoteObservedAt:day+'T08:59:00.000Z',publicationMethod:'reviewed-editorial',formalEligible:false,modelProbability:null,modelVersion:null}));
 const view=p.seal({version:'reviewed-analysis-view-v1',businessDate:day,createdAt:day+'T09:00:00.000Z',commitObservedAt:day+'T09:00:01.000Z',updatedAt:day+'T10:00:00.000Z',publicationHash:'b'.repeat(64),draftHash:'c'.repeat(64),records,combos:p.combinations(records,2),threeCombos:p.combinations(records,3),formalEligible:false});
 const saved=archive.prepare(view,{generationId:'g-'+'a'.repeat(64),committedAt:day+'T08:00:00.000Z'},day+'T10:00:00.000Z'),json=JSON.stringify(saved.archive);
 const row={artifact_key:saved.key,artifact_version:archive.VERSION,generated_at:saved.archive.createdAt,updated_at:saved.archive.createdAt,payload_json:json,payload_sha256:p.sha(json),payload_bytes:Buffer.byteLength(json)};
 const matches=records.map(r=>({...r,sourceMatchId:r.eventId,status:'SCHEDULED'})),calls=[];
 const c={async query(sql,args){calls.push(sql);
  if(sql.startsWith('SELECT artifact_key,payload_bytes'))return {rows:[{artifact_key:row.artifact_key,payload_bytes:row.payload_bytes,bytes:row.payload_bytes}]};
  if(sql.includes("dataset='current'"))return {rows:matches.map(payload=>({payload}))};
  if(sql.includes('payload::text'))return {rows:args[0]===row.artifact_key?[row]:[]};
  return {rows:[]};
 }};
 return {day,view,records,row,matches,c,calls};
}
test('a started leg freezes the exact archived pair and triple; changed live prices do not reprice either group',async()=>{
 const f=fixture();f.matches[0].status='LIVE';f.matches[0].sp=99;
 const before=JSON.stringify(f.view),actual=await freezeOriginalGroups(f.c,f.view,f.day+'T11:00:00.000Z');
 a.deepEqual(actual.combos,f.view.combos);a.deepEqual(actual.threeCombos,f.view.threeCombos);a.equal(actual.comboFreeze[0].frozen,true);
 a.equal(JSON.stringify(f.view),before);a(!f.calls.some(s=>/INSERT|UPDATE|DELETE/.test(s)));
});
test('historical read-only replay verifies the frozen archive after a live status changes',async()=>{
 const f=fixture(),at=f.day+'T11:00:00.000Z',saved=await freezeOriginalGroups(f.c,f.view,at);
 f.matches[0].status='LIVE';f.matches[0].sp=99;f.calls.length=0;
 const replay=await freezeOriginalGroups(f.c,f.view,at,{replayFrozen:saved.comboFreeze});
 a.deepEqual(replay,saved);a(!f.calls.some(s=>s.includes("dataset='current'")||/INSERT|UPDATE|DELETE/.test(s)));
 const now=await freezeOriginalGroups(f.c,f.view,at);a(now.comboFreeze.some(v=>v.frozen));
});
test('historical metadata cannot claim open groups at or after their sale cutoff',async()=>{
 const f=fixture(),saved=await freezeOriginalGroups(f.c,f.view,f.day+'T11:00:00.000Z');
 await a.rejects(freezeOriginalGroups(f.c,f.view,f.day+'T19:00:00.000Z',{replayFrozen:saved.comboFreeze}),/REPLAY_OPEN_AFTER_START/);
});
test('historical replay cannot perform archival and issues only SELECT statements',async()=>{
 const f=fixture(),saved=await freezeOriginalGroups(f.c,f.view,f.day+'T11:00:00.000Z');
 await a.rejects(freezeOriginalGroups(f.c,f.view,f.day+'T11:00:00.000Z',{anchor:true,replayFrozen:saved.comboFreeze}),/REPLAY_READ_ONLY/);
 f.calls.length=0;await freezeOriginalGroups(f.c,f.view,f.day+'T11:00:00.000Z',{replayFrozen:saved.comboFreeze});
 a(f.calls.length>0&&f.calls.every(sql=>sql.trim().startsWith('SELECT')));
});
for(const [name,change]of [['archive hash',v=>v[0].sourceArchiveSha256='0'.repeat(64)],['group hash',v=>v[0].originalComboHash='0'.repeat(64)],['extra field',v=>v[0].permission=true],['nonboolean flag',v=>v[0].frozen=0],['missing group',v=>v.pop()]])
 test('historical replay rejects changed '+name,async()=>{const f=fixture(),at=f.day+'T11:00:00.000Z',saved=await freezeOriginalGroups(f.c,f.view,at),meta=structuredClone(saved.comboFreeze);change(meta);await a.rejects(freezeOriginalGroups(f.c,f.view,at,{replayFrozen:meta}),/REPLAY_/);});
test('after cutoff, persisted original groups remain available without selecting replacement legs',async()=>{
 const f=fixture(),at=f.day+'T19:30:00.000Z',input=p.seal({...f.view,updatedAt:at,combos:[],threeCombos:[]});
 const actual=await freezeOriginalGroups(f.c,input,at);a.deepEqual(actual.combos,f.view.combos);a(actual.comboFreeze.every(v=>v.frozen));
 a.deepEqual(await archive.retain(f.c,actual,{},at),{retained:false,reason:'original-groups-already-archived'});
});
test('corrupt original bytes stop projection instead of inventing a replacement',async()=>{const f=fixture();f.row.payload_sha256='0'.repeat(64);await a.rejects(freezeOriginalGroups(f.c,f.view,f.day+'T11:00:00.000Z'));});
test('a reused event with changed ordered teams cannot acquire an old group',async()=>{
 const f=fixture(),records=f.records.map(r=>({...r,homeTeamId:r.homeTeamId+'new'})),view=p.seal({...f.view,records,combos:[],threeCombos:[]});
 a.equal((await freezeOriginalGroups(f.c,view,f.day+'T11:00:00.000Z')).comboFreeze,undefined);
});
test('a busy global writer defers passive archival and makes no write or second worker',async()=>{
 let calls=0;await anchorCommitted({query:async sql=>{calls++;a.match(sql,/pg_try_advisory_xact_lock/);return {rows:[{locked:false}]};}},fixture().view,'2030-01-01T11:00:00.000Z');a.equal(calls,1);
});
test('an early live status cannot be recorded as a fresh pre-match combo archive',async()=>{
 const f=fixture();f.matches[0].status='LIVE';const seen=[];
 await anchorCommitted({query:async sql=>{seen.push(sql);
  if(sql.includes('pg_try_advisory'))return {rows:[{locked:true}]};
  if(sql.includes('AS bytes'))return {rows:[{bytes:Buffer.byteLength(JSON.stringify(f.view))}]};
  if(sql.includes(' AS view'))return {rows:[{view:f.view}]};
  if(sql.includes("dataset='current'"))return {rows:f.matches.map(payload=>({payload}))};
  throw Error('No archival or metadata mutation permitted after a live leg');
 }},f.view,f.day+'T11:00:00.000Z');
 a.equal(seen.length,4);a(!seen.some(s=>/INSERT|UPDATE|DELETE/.test(s)));
});
