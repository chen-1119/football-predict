'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
const tests=[
  'tests/recommendation-live-official-had.test.cjs',
  'tests/recommendation-signed-had-publication.test.cjs',
  'tests/recommendation-quote-publication-latency.test.cjs',
  'tests/recommendation-repository-input-capture.test.cjs',
  'tests/recommendation-input-capture-clock.test.cjs',
  'tests/recommendation-warehouse-sp.test.cjs',
  'tests/recommendation-unified.test.cjs',
];
function run(){
  const r=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{
    cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
  const count=label=>Number(r.stdout?.match(new RegExp('^# '+label+' (\\d+)$','m'))?.[1] ?? NaN);
  if(r.status!==0 || count('tests')<100 || count('pass')!==count('tests') || count('fail')!==0 || count('skipped')!==0)
    throw new Error('Signed HAD publication contract failed: '+String(r.error?.message||r.stderr||r.stdout).slice(-4000));
  return {ok:true,tests:count('tests'),passed:count('pass'),skipped:0,files:tests,
    scope:'synthetic signed acquisition and legacy replay contracts; not live publication or model performance',productionWrites:0};
}
if(require.main===module)process.stdout.write(JSON.stringify(run()));
module.exports={run,tests};
