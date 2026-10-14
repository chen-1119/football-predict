'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {reviewDisposition,comboDisposition}=require('../server/researchRevisionPolicy.cjs');
const now='2026-10-14T13:00:00.000Z',cutoffAt='2026-10-14T14:00:00.000Z',kickoff='2026-10-14T16:45:00.000Z';
const first={eventId:'2041965',eventVersion:kickoff,cutoffAt,sp:1.75,selection:'a',scores:[[1,2],[0,1]]};
const second={...first,eventId:'2041966'};
const observe=(r,changes={})=>({...r,status:'SCHEDULED',isOnSale:true,observedAt:'2026-10-14T12:59:00.000Z',...changes});
test('open single allows a new review version and preserves the original settlement decision',()=>{
 const copy=structuredClone(first),r=reviewDisposition(first,observe(first),now);
 a.equal(r.canRevisePrematch,true);a.equal(r.overwriteOriginal,false);a.equal(r.canAppendFacts,true);a.deepEqual(first,copy);
});
for(const state of ['LIVE','IN_PLAY','HALFTIME','FINISHED'])test('single '+state+' only accepts appended facts',()=>{
 const r=reviewDisposition(first,observe(first,{status:state}),now);a.equal(r.canRevisePrematch,false);a.equal(r.canAppendFacts,true);
});
test('kickoff clock freezes even an incorrectly lingering scheduled status',()=>{
 const r=reviewDisposition(first,observe(first),kickoff);a.equal(r.reason,'event-started-append-facts-only');
});
for(const [label,changes] of [['cutoff', {cutoffAt:now}],['suspended',{status:'SUSPENDED'}],['no sale',{isOnSale:false}],['unknown sale',{isOnSale:undefined}],['stale',{observedAt:'2026-10-14T12:44:00.000Z'}],['future',{observedAt:'2026-10-14T13:01:00.000Z'}],['different event',{eventVersion:'2026-10-14T16:46:00.000Z'}]])
 test('single refuses '+label,()=>a.equal(reviewDisposition(first,observe(first,changes),now).canRevisePrematch,false));
test('all-open two-leg combo may append a new version',()=>{
 a.equal(comboDisposition({legs:[first,second]},[observe(first),observe(second)],now).canRefresh,true);
});
test('one live leg freezes the whole combo without modifying the other leg or SP',()=>{
 const combo={legs:[first,second],sp:2.52},saved=structuredClone(combo);
 const r=comboDisposition(combo,[observe(first,{status:'LIVE'}),observe(second)],now);
 a.equal(r.canRefresh,false);a.equal(r.reason,'combo-has-started-leg');a.equal(r.preserveLegsAndSp,true);a.deepEqual(combo,saved);
});
test('finished leg, duplicate or missing event observations cannot refresh a combo',()=>{
 for(const observations of [[observe(first,{status:'FINAL'}),observe(second)],[observe(first),observe(first),observe(second)],[observe(second)]])
  a.equal(comboDisposition({legs:[first,second]},observations,now).canRefresh,false);
});
