'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const sessions=require('../scripts/postgresRuntimeReadSession.cjs');
const {reconcileFastResultGenerationPostgres}=require('../scripts/reconcileFastResultGeneration.cjs');

test('old-result reconciliation queues before reading and always closes without replaying writes',async context=>{
 const failure=Error('stop before local writes'),calls=[];
 context.mock.method(sessions,'openPostgresRuntimeReadSession',async options=>{
  calls.push(options);
  return {guardedFinals:async()=>{calls.push('guard');throw failure;},close:async()=>calls.push('close')};
 });
 await assert.rejects(reconcileFastResultGenerationPostgres({dataDir:'isolated-data'}),error=>error===failure);
 assert.equal(calls[0].receiptWaitMs,20000);
 assert.equal(calls[0].protectReceipt,true);
 assert.equal(calls[0].publicDataDir,'isolated-data');
 assert.deepEqual(calls.slice(1),['guard','close']);
});

test('known contention fails closed before any reconciliation without an unbounded retry',async context=>{
 let attempts=0;
 context.mock.method(sessions,'openPostgresRuntimeReadSession',async options=>{
  attempts++;assert.equal(options.receiptWaitMs,20000);throw Error('native receipt read barrier busy; retry after projection completes');
 });
 await assert.rejects(reconcileFastResultGenerationPostgres(),/barrier busy/);
 assert.equal(attempts,1);
});

test('explicit nonblocking admission remains available to controlled callers',async context=>{
 context.mock.method(sessions,'openPostgresRuntimeReadSession',async options=>{
  assert.equal(options.receiptWaitMs,0);throw Error('checked');
 });
 await assert.rejects(reconcileFastResultGenerationPostgres({receiptWaitMs:0}),/checked/);
});
