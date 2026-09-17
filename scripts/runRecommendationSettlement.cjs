'use strict';
const {run}=require('./recommendationPlatform/worker.cjs');
if(require.main===module)run({lane:'settlement',watch:process.argv.includes('--watch')}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
module.exports={run:options=>run({lane:'settlement',...options})};
