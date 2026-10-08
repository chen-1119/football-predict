'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
const tests=['tests/sporttery-opening-policy.test.cjs','tests/sporttery-fast-opening.test.cjs',
  'tests/sync-worker-eleven-opening.test.cjs','tests/sporttery-opening-projection.test.cjs'];
function run(){
 const child=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{
  cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
 const count=name=>Number(child.stdout?.match(new RegExp('^# '+name+' (\\d+)$','m'))?.[1]??NaN);
 if(child.status!==0||count('tests')<20||count('pass')!==count('tests')||count('fail')!==0||count('skipped')!==0)
  throw Error('Sporttery daily opening contract failed: '+String(child.error?.message||child.stderr||child.stdout).slice(-4000));
 return {ok:true,tests:count('tests'),passed:count('pass'),skipped:0,files:tests,
  scope:'synthetic opening, original acquisition clocks, schedule projection and single-cycle wake; not live selling or model performance',productionWrites:0};
}
if(require.main===module)process.stdout.write(JSON.stringify(run()));
module.exports={run,tests};
