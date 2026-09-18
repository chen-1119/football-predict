'use strict';
// The deployed entry point now publishes without executing historical review.
// Old exported helpers remain available only for legacy replay/regression tools.
const {run:runWorker}=require('./recommendationPlatform/worker.cjs');
const run=options=>runWorker({lane:'publish',...options});
if(require.main===module)run({watch:process.argv.includes('--watch')}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
module.exports={run};
for(const name of ['buildLedger','persistLedger','settleEntry','summarize','shanghaiParts','previewStillAuditable']){
  Object.defineProperty(module.exports,name,{enumerable:true,get(){return require('./legacyDailyFeaturedComboLedger.cjs')[name];}});
}
