'use strict';
const {Repository}=require('./repository.cjs');
const {buildDualResearchReport}=require('./dualChoiceResearch.cjs');

/** Private read-only report. It is intentionally absent from the public
 * recommendation view until a separate prospective validation passes. */
async function readDualResearchReport(pool,asOf=Date.now()){
  const client=await pool.connect();
  try{
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const repo=new Repository(client),records=await repo.dualResearch();
    const decisions=await repo.decisions([...new Set(records.map(r=>r.decisionId))]);
    const events=await repo.resultHeads();
    await client.query('COMMIT');
    return buildDualResearchReport(records,decisions,events,asOf);
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

if(require.main===module){
  (async()=>{
    const {createPostgresPool}=require('../../server/postgresStore.cjs');
    const pool=createPostgresPool({max:1,applicationName:'football-dual-research-report'});
    try{console.log(JSON.stringify(await readDualResearchReport(pool),null,2));}
    finally{await pool.end();}
  })().catch(error=>{console.error(JSON.stringify({ok:false,errorCode:error.code||'DUAL_RESEARCH_REPORT_FAILED'}));process.exitCode=1;});
}
module.exports={readDualResearchReport};
