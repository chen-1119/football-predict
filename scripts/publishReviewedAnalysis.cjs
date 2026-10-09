'use strict';
const fs=require('node:fs'),path=require('node:path'),p=require('./recommendationPlatform/reviewedAnalysis.cjs');
async function main(args){
 const [mode,input,expected]=args;p.check(args.length===3&&['--check','--publish'].includes(mode)&&path.isAbsolute(input)&&/^[a-f0-9]{64}$/.test(expected),'ARGS');
 p.check(process.versions.node.split('.')[0]==='22'&&fs.statSync(input).size<=512*1024,'RUNTIME_BOUND');
 const draft=JSON.parse(fs.readFileSync(input,'utf8'));p.check(p.hash(draft)===expected,'INPUT_HASH');p.validateDraft(draft,new Date().toISOString());
 if(mode==='--check'){console.log(JSON.stringify({ok:true,draftHash:expected,productionWrites:0}));return;}
 const pool=require('../server/postgresStore.cjs').createPostgresPool({applicationName:'football-reviewed-analysis-publication',max:1});
 try{console.log(JSON.stringify(await require('./recommendationPlatform/reviewedAnalysisRuntime.cjs').publish(draft,{pool,expectedDraftHash:expected})));}finally{await pool.end();}
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.code||'REVIEWED_ANALYSIS_FAILED_READ_BEFORE_RETRY');process.exitCode=1;});
module.exports={main};
