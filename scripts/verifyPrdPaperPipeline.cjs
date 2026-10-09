'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
const tests=['tests/league-model-adoption.test.cjs','tests/prd-paper-recommendation.test.cjs','tests/prd-paper-repository.test.cjs',
  'tests/prd-paper-runtime.test.cjs','tests/prd-paper-directions-view.test.cjs',
  'tests/zero-market-research-baseline.test.cjs','tests/market-separated-direction-research.test.cjs',
  'tests/team-evidence-pipeline.test.cjs','tests/expanded-league-history.test.cjs','tests/reviewed-analysis.test.cjs'];
function run(){
 const child=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{
  cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:2*1024*1024});
 const count=name=>Number(child.stdout?.match(new RegExp('^# '+name+' (\\d+)$','m'))?.[1]??NaN);
 if(child.status!==0||count('tests')<129||count('pass')!==count('tests')||count('fail')!==0||count('skipped')!==0)
  throw new Error('PRD paper pipeline contract failed: '+String(child.error?.message||child.stderr||child.stdout).slice(-4000));
 return{ok:true,verifier:'prd-paper-pipeline-contract-v1',tests:count('tests'),passed:count('pass'),skipped:0,files:tests,
  scope:'synthetic signature, mathematical replay, SQL protocol, runtime and public projection; not live input admission, PostgreSQL deployment or model performance',
  productionWrites:0,modelPromotionAllowed:false};
}
if(require.main===module)process.stdout.write(JSON.stringify(run()));
module.exports={run,tests};
