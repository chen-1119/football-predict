"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function verifyNativeWorkerRuntime({ storeDir, publicDataDir, sourceMatchId }) {
  const code = `const assert=require('node:assert/strict'),Module=require('node:module');
    const original=Module._load;let sqliteAttempts=0;
    Module._load=function(name,...args){if(name==='node:sqlite'){sqliteAttempts++;throw new Error('forbidden SQLite');}return original.call(this,name,...args);};
    (async()=>{
      const worker=require('./scripts/runSyncWorker.cjs');
      const calls=[],run=async(enabled,script)=>{calls.push({enabled,script});return {ok:true,skipped:!enabled,script};};
      const projected=await worker.runRuntimeProjectionOrReuse({enabled:true,generationStep:{ok:true},run});
      assert.equal(projected.storage,'postgres');assert.deepEqual(calls,[{enabled:true,script:'postgres:sync'}]);
      await worker.runRuntimeProjectionOrReuse({enabled:true,generationStep:{ok:false},run});
      assert.deepEqual(calls[1],{enabled:false,script:'postgres:sync'});
      assert.equal(worker.describeCycleStages().flatMap(s=>s.operations).some(s=>s.includes('sqlite')),false);
      const input=await require('./scripts/runtimeFastResultInput.cjs').readRuntimeFastResultInput({storeDir:process.env.SERVER_STORE_DIR,publicDataDir:process.env.DATA_GENERATION_PUBLIC_DATA_DIR});
      assert.equal(input.storage,'postgres');assert.ok(input.receipt.observations.some(row=>row.sourceMatchId===process.env.QA_SOURCE_ID&&row.scoreHome===3));
      assert.equal(input.finals.find(row=>row.sourceMatchId===process.env.QA_SOURCE_ID).scoreHome,3);
      assert.equal(sqliteAttempts,0);console.log(JSON.stringify({ok:true,sqliteAttempts,projectionCalls:calls.length}));
    })().catch(error=>{console.error(error.stack);process.exitCode=1;});`;
  const result = spawnSync(process.execPath, ["-e", code], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 30000,
    env: { ...process.env, FOOTBALL_STORAGE_MODE: "postgres-only", FOOTBALL_POSTGRES_MODE: "primary",
      DATASTORE_READ_SOURCE: "postgres", CURRENT_MATCH_SOURCE: "postgres", ENABLE_SQLITE_EXPORT: "0",
      PRIVATE_MODEL_ARTIFACT_STORAGE: "postgres", POSTGRES_PROJECTION_SOURCE: "native-generation",
      FOOTBALL_POSTGRES_URL: process.env.EVIDENCE_TEST_POSTGRES_URL, FOOTBALL_POSTGRES_SSL_MODE: "disable",
      SERVER_STORE_DIR: storeDir, DATA_GENERATION_PUBLIC_DATA_DIR: publicDataDir, QA_SOURCE_ID: sourceMatchId,
      DATASTORE_SQLITE_PATH: path.join(storeDir, "never-created.db") },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout.trim()).sqliteAttempts, 0);
}
module.exports = { verifyNativeWorkerRuntime };
