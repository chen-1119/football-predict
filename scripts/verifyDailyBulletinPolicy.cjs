'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
function run(){
const result=spawnSync(process.execPath,['--test','tests/daily-bulletin-policy.test.cjs'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:2*1024*1024});
const count=n=>Number(result.stdout?.match(new RegExp('^# '+n+' (\\d+)$','m'))?.[1]);
if(result.status!==0||count('tests')<29||count('pass')!==count('tests')||count('skipped')!==0)throw Error('Daily bulletin contract failed: '+String(result.stdout||result.stderr).slice(-4000));
return {ok:true,tests:count('tests'),skipped:0,scope:'synthetic policy/storage/source rules; not live recommendation acceptance'};}
if(require.main===module)console.log(JSON.stringify(run()));
module.exports={run};
