'use strict';
// Browser collection stays in Browser Use. This CLI transports data only;
// database credentials stay in the dedicated server EnvironmentFile.
const fs=require('node:fs'),path=require('node:path');
const {remote}=require('./repairRemoteTransport.cjs');
function dispatch(action,input){
  const cp=require('node:child_process');
  if(!['migrate','ingest','status'].includes(action))throw Error('Unexpected action');
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
    const source=JSON.parse(fs.readFileSync(path.resolve(inputFile),'utf8'));
    const {normalizeLeagueRows}=require('../collectors/leisu-prematch/browser.cjs');
    const {LEAGUES}=require('../collectors/leisu-prematch/local-browser-ingest.cjs');
    const now=Date.now(),window=require('../collectors/leisu-prematch/scope.cjs').windowFor(now);
    if(!Array.isArray(source)||source.length>5||source.some(x=>!LEAGUES.includes(x.sourceUrl)||!Array.isArray(x.rows)))throw Error('Invalid rendered league rows');
    const candidates=source.flatMap(x=>normalizeLeagueRows(x.rows,x.sourceUrl)).filter(x=>Date.parse(x.kickoffUtc)>now&&Date.parse(x.kickoffUtc)<Date.parse(window.endUtc));
    const seen=new Set(),fixtures=candidates.sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)).filter(x=>{if(seen.has(x.providerMatchId))return false;seen.add(x.providerMatchId);return true;});
    const targets=[];for(const fixture of fixtures.slice(0,8)){
      targets.push({fixture,kind:'injuries',sourceUrl:`https://live.leisu.com/shujufenxi-${fixture.providerMatchId}`});
      if(Date.parse(fixture.kickoffUtc)-now<=90*60000&&targets.length<12)targets.push({fixture,kind:'lineup',sourceUrl:`https://live.leisu.com/detail-${fixture.providerMatchId}`});
      if(targets.length>=12)break;
    }
    const plan={version:'leisu-local-browser-v1',runId:require('node:crypto').randomUUID(),startedAt:new Date(now).toISOString(),window,
      leaguePages:source.map(x=>x.sourceUrl),eligibleMatches:fixtures.length,targets};
    if(outputFile)fs.writeFileSync(path.resolve(outputFile),JSON.stringify(plan,null,2)+'\n');console.log(JSON.stringify(plan,null,2));return;
  }
  if(!['migrate','ingest','status'].includes(action)||((action==='ingest')!==Boolean(inputFile)))throw Error('Usage: node scripts/syncLocalLeisuBrowser.cjs ingest <batch.json> [receipt.json], or migrate/status');
  const input=inputFile?fs.readFileSync(path.resolve(inputFile),'utf8'):'';
  if(Buffer.byteLength(input)>4*1024*1024)throw Error('Batch exceeds 4 MiB');
  if(input)JSON.parse(input); // Server validates; exact retries remain valid after the observation window.
  const result=remote('('+dispatch.toString()+')('+JSON.stringify(action)+','+JSON.stringify(input)+');',{timeout:70000,prefix:'local-leisu-'+action,maxBuffer:1024*1024});
  if(result.exitCode!==0)throw Error('Pinned SSH operation failed; inspect '+result.output);
  const receipt=JSON.parse(result.stdout);if(outputFile)fs.writeFileSync(path.resolve(outputFile),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt,null,2));
}
if(require.main===module)try{main();}catch(error){console.error(error.message);process.exitCode=1;}
