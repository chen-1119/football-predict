'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {VERSION,BASE_RETRY_MS,MAX_RETRY_MS,validAttempt,runFootballDataFixtureRetry:execute} = require('./footballDataFixtureRetry.cjs');
const {collectFootballDataFixtures} = require('./footballDataFixturesSnapshot.cjs');
const {writeJsonAtomic} = require('./runSyncWorker.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'football-fixtures-retry-'));
const checks = [];
const read = (file,fallback) => {try {return JSON.parse(fs.readFileSync(file,'utf8'));} catch {return fallback;}};
let now = Date.parse('2026-09-07T10:00:00.000Z');
let invocations = 0;
const attemptFile = path.join(temp,'attempt.json');
const defaults = { enabled:true, checkedAt:null, minIntervalMs:MAX_RETRY_MS, attemptFile, read, write:writeJsonAtomic,
  clock:()=>now,run:async()=>{invocations++; return {ok:false,errorCode:'SYNC_WORKER_COMMAND_FAILED'};} };
async function check(name,fn) {await fn(); checks.push({name,ok:true});}
async function main() {
  try {
    await check('disabled never invokes source or writes state',async()=>{
      const result=await execute({...defaults,enabled:false}); assert.equal(result.reason,'disabled'); assert.equal(invocations,0); assert.equal(fs.existsSync(attemptFile),false);
    });
    await check('failed source records independent bounded cooldown',async()=>{
      const result=await execute(defaults); assert.equal(result.ok,false); assert.equal(invocations,1);
      assert.equal(result.retry.nextAttemptAt,new Date(now+BASE_RETRY_MS).toISOString()); assert.equal(validAttempt(read(attemptFile),now),true);
    });
    await check('failed cooldown survives reread and remains degraded',async()=>{
      now+=300000; const before=fs.readFileSync(attemptFile); const result=await execute(defaults);
      assert.equal(result.ok,false); assert.equal(result.skipped,true); assert.equal(result.retry.sourceRecovered,false); assert.equal(invocations,1); assert.deepEqual(fs.readFileSync(attemptFile),before);
    });
    await check('retry at boundary doubles failure backoff',async()=>{
      now=Date.parse(read(attemptFile).nextAttemptAt); const result=await execute(defaults);
      assert.equal(invocations,2); assert.equal(result.retry.failures,2); assert.equal(Date.parse(result.retry.nextAttemptAt)-now,2*BASE_RETRY_MS);
    });
    await check('persistent failure backoff is capped at six hours',async()=>{
      for(let i=0;i<8;i++){now=Date.parse(read(attemptFile).nextAttemptAt); await execute(defaults);}
      assert.equal(Date.parse(read(attemptFile).nextAttemptAt)-now,MAX_RETRY_MS);
    });
    await check('successful attempt resets failure streak without creating source clocks',async()=>{
      now=Date.parse(read(attemptFile).nextAttemptAt); const result=await execute({...defaults,run:async()=>({ok:true})});
      assert.equal(result.retry.failures,0); assert.equal(result.retry.nextAttemptAt,null); assert.equal(read(attemptFile).checkedAt,undefined);
    });
    await check('successful fresh snapshot obeys original minimum interval',async()=>{
      const before=fs.readFileSync(attemptFile); const result=await execute({...defaults,checkedAt:new Date(now).toISOString()});
      assert.equal(result.reason,'successful-snapshot-min-interval'); assert.deepEqual(fs.readFileSync(attemptFile),before);
    });
    await check('future snapshot clock cannot indefinitely suppress requests',async()=>{
      const before=invocations; await execute({...defaults,checkedAt:new Date(now+86400000).toISOString()}); assert.equal(invocations,before+1);
    });
    await check('new independently successful snapshot supersedes failed attempt',async()=>{
      now+=1000; const result=await execute({...defaults,checkedAt:new Date(now).toISOString()}); assert.equal(result.reason,'successful-snapshot-min-interval');
    });
    await check('reused release enrichment cannot clear unresolved failure',async()=>{
      now=Date.parse(read(attemptFile).nextAttemptAt); const before=fs.readFileSync(attemptFile);
      const result=await execute({...defaults,run:async()=>({ok:true,skipped:true,reused:true})});
      assert.equal(result.ok,false); assert.equal(result.reason,'source-not-rechecked'); assert.deepEqual(fs.readFileSync(attemptFile),before);
    });
    await check('interrupted attempt persists lease and preserves interruption',async()=>{
      const error=new Error('stop requested'); await assert.rejects(execute({...defaults,run:async()=>{throw error;}}),e=>e===error);
      assert.equal(read(attemptFile).state,'running'); const result=await execute(defaults); assert.equal(result.reason,'previous-attempt-incomplete-cooldown');
    });
    await check('incomplete attempt is retryable after bounded lease',async()=>{
      now=Date.parse(read(attemptFile).nextAttemptAt); const before=invocations; await execute(defaults); assert.equal(invocations,before+1);
    });
    await check('invalid and wrong-version state cannot create unbounded cooldown',async()=>{
      for(const mutate of [row=>({...row,version:'other'}),row=>({...row,nextAttemptAt:'2099-01-01T00:00:00.000Z'}),row=>({...row,startedAt:'2099-01-01T00:00:00.000Z'}),row=>({...row,failures:-1})]) {
        writeJsonAtomic(attemptFile,mutate(read(attemptFile))); const before=invocations;
        const result=await execute(defaults); assert.equal(invocations,before+1); assert.equal(result.retry.priorStateInvalid,true);
      }
    });
    await check('failed attempt-state write stops request without hiding degradation',async()=>{
      now=Date.parse(read(attemptFile).nextAttemptAt); const before=invocations;
      const result=await execute({...defaults,write:()=>{throw new Error('readonly');}}); assert.equal(result.ok,false); assert.equal(invocations,before);
    });
    await check('failed final state write remains degraded even after request success',async()=>{
      let writes=0; const result=await execute({...defaults,run:async()=>({ok:true}),write:(...args)=>{if(++writes===2)throw new Error('disk full');writeJsonAtomic(...args);}});
      assert.equal(result.ok,false); assert.equal(result.skipped,false); assert.equal(result.retry.sourceRecovered,false);
    });
    await check('actual collector 503 preserves original snapshot and successful checkedAt',async()=>{
      const fixtureDir=path.join(temp,'fixture-source');
      const csv=Buffer.from('Div,Date,Time,HomeTeam,AwayTeam,B365H,B365D,B365A\nE0,06/09/2026,15:00,Arsenal,Chelsea,2.1,3.2,3.4\n');
      await collectFootballDataFixtures({storeDir:fixtureDir,clock:()=>new Date(now),transport:async()=>({statusCode:200,headers:{'content-length':String(csv.length),'content-type':'text/csv'},body:csv})});
      const statusFile=path.join(fixtureDir,'status.json'); const before=fs.readFileSync(statusFile);
      const localAttempt=path.join(fixtureDir,'attempt.json');
      const failed=await execute({...defaults,attemptFile:localAttempt,run:async()=>{
        try {return await collectFootballDataFixtures({storeDir:fixtureDir,clock:()=>new Date(now),transport:async()=>({statusCode:503,headers:{},body:Buffer.from('temporarily unavailable')})});}
        catch(e){assert.equal(e.code,'HTTP_STATUS');return {ok:false,errorCode:e.code};}
      }});
      assert.equal(failed.ok,false); assert.deepEqual(fs.readFileSync(statusFile),before); assert.equal(read(localAttempt).state,'failed');
    });
    await check('actual worker orchestration uses retry wrapper and separate operational file',async()=>{
      const source=fs.readFileSync(path.join(__dirname,'runSyncWorker.cjs'),'utf8');
      const start=source.indexOf('    const footballDataFixturesStatus = readJson(');
      const end=source.indexOf('    const footballDataResultsStatus = ',start);
      assert.ok(start>0 && end>start);
      const fn=new (Object.getPrototypeOf(async function(){}).constructor)('readJson','footballDataFixturesStatusFile','enrichmentSteps','runFootballDataFixtureRetry','footballDataFixturesMinIntervalMs','path','writeJsonAtomic','runEnrichment','process',source.slice(start,end));
      const result=[]; let called; let calls=0;
      const statusFile=path.join(temp,'worker-wiring','status.json');
      const invoke=enabled=>fn(read,statusFile,result,async options=>{called=options; return execute({...options,clock:()=>now});},MAX_RETRY_MS,path,writeJsonAtomic,async(active,script)=>{calls++;assert.equal(active,true);assert.equal(script,'sync:football-data-fixtures');return {ok:false,error:'upstream unavailable'};},{env:{ENABLE_FOOTBALL_DATA_FIXTURES_SYNC:enabled}});
      await invoke('0');
      assert.equal(called.attemptFile,path.join(temp,'worker-wiring','attempt.json')); assert.equal(called.enabled,false); assert.equal(result.at(-1).reason,'disabled');
      writeJsonAtomic(statusFile,{checkedAt:new Date(now).toISOString()});
      await invoke('1'); assert.equal(result.at(-1).reason,'successful-snapshot-min-interval'); assert.equal(calls,0);
      now+=MAX_RETRY_MS; await invoke('1'); assert.equal(calls,1); assert.equal(result.at(-1).ok,false);
      await invoke('1'); assert.equal(calls,1); assert.equal(result.at(-1).reason,'failed-source-cooldown'); assert.equal(result.at(-1).ok,false);
    });
    await check('invalid command result remains failed and cannot report recovery',async()=>{
      const result=await execute({...defaults,attemptFile:path.join(temp,'invalid-result.json'),run:async()=>undefined});
      assert.equal(result.ok,false); assert.equal(result.errorCode,'SOURCE_RESULT_INVALID'); assert.equal(result.retry.sourceRecovered,false);
    });
    console.log(JSON.stringify({ok:true,verifier:VERSION,productionDataTouched:false,checks},null,2));
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
