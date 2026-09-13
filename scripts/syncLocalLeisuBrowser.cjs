'use strict';
// Browser collection stays in Browser Use. This CLI transports data only;
// database credentials stay in the dedicated server EnvironmentFile.
const fs=require('node:fs'),path=require('node:path');
const {remote}=require('./repairRemoteTransport.cjs');
function dispatch(action,input){
  const cp=require('node:child_process');
  if(!['migrate','ingest','status','fixtures'].includes(action))throw Error('Unexpected action');
  const result=cp.spawnSync('systemd-run',['--quiet','--wait','--pipe','--collect',
    '--uid=leisu-collector','--gid=leisu-collector',
    '--property=EnvironmentFile=/etc/football-leisu-collector/collector.env',
    '--property=RuntimeMaxSec=60s','--property=NoNewPrivileges=yes',
    '/opt/node-v22.22.1/bin/node','/opt/football-leisu-collector/local-browser-ingest.cjs',action],
    {input,encoding:'utf8',timeout:65000,maxBuffer:1024*1024});
  if(result.status!==0)throw Error('Server database operation failed: '+String(result.stderr||'').slice(0,500));
  console.log(result.stdout.trim());
}
function main(){
  const action=process.argv[2],inputFile=process.argv[3],outputFile=process.argv[4];
  if(action==='plan'){
    const source=JSON.parse(fs.readFileSync(path.resolve(inputFile),'utf8').replace(/^\uFEFF/,''));
    const plan=require('../collectors/leisu-prematch/local-jingcai-scope.cjs').makePlan(source);
    if(outputFile)fs.writeFileSync(path.resolve(outputFile),JSON.stringify(plan,null,2)+'\n');console.log(JSON.stringify(plan,null,2));return;
  }
  if(!['migrate','ingest','status','fixtures'].includes(action)||(action==='ingest'&&!inputFile)||(['migrate','status'].includes(action)&&inputFile))throw Error('Usage: fixtures [roster.json], plan <input.json> <plan.json>, ingest <batch.json> [receipt.json], or status');
  const input=action==='ingest'?fs.readFileSync(path.resolve(inputFile),'utf8').replace(/^\uFEFF/,''):'';
  if(Buffer.byteLength(input)>4*1024*1024)throw Error('Batch exceeds 4 MiB');
  if(input)JSON.parse(input); // Server validates; exact retries remain valid after the observation window.
  const result=remote('('+dispatch.toString()+')('+JSON.stringify(action)+','+JSON.stringify(input)+');',{timeout:70000,prefix:'local-leisu-'+action,maxBuffer:1024*1024});
  if(result.exitCode!==0)throw Error('Pinned SSH operation failed; inspect '+result.output);
  const receipt=JSON.parse(result.stdout),destination=action==='fixtures'?inputFile:outputFile;if(destination)fs.writeFileSync(path.resolve(destination),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt,null,2));
}
if(require.main===module)try{main();}catch(error){console.error(error.message);process.exitCode=1;}
