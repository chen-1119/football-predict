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
