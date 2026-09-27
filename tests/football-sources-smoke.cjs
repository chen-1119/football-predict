'use strict';
// One bounded GET per no-key provider. Never uses production DB or API tokens.
const fs=require('node:fs');
const {urlFor}=require('../collectors/football-sources/core.cjs');
const {parse}=require('../collectors/football-sources/adapters.cjs');
const {readBody}=require('../collectors/football-sources/client.cjs');
async function probe(job){const c=new AbortController(),timer=setTimeout(()=>c.abort(),15000),start=Date.now();try{
  const r=await fetch(urlFor(job),{signal:c.signal,redirect:'error',headers:{accept:'application/json','user-agent':'football-predict-source-validation/1.0 (https://github.com/chen-1119/football-predict)'}});
  if(!r.ok)return {provider:job.provider,state:'http-'+r.status};
  const raw=await readBody(r,c.signal),parsed=parse(JSON.parse(raw),job,Date.now());
  return {provider:job.provider,state:'parsed',records:parsed.rows.length,rejected:parsed.rejected||0,latencyMs:Date.now()-start};
}catch(e){return {provider:job.provider,state:c.signal.aborted?'timeout':'network-or-schema-failure',diagnostic:e instanceof Error?e.message.split('\n')[0].slice(0,100):'unknown'};}finally{clearTimeout(timer);}}
async function main(){const date=new Date(),season=date.getUTCFullYear()-(date.getUTCMonth()<6?1:0);
  const results=[];
  results.push(await probe({provider:'openligadb',kind:'matches',competition:'bl1',season}));
  // Fixed test coordinate, not a user's location and not a verified match venue.
  results.push(await probe({provider:'met-norway',kind:'weather',lat:51.5549,lon:-0.1084}));
  results.push({provider:'football-data.org',state:'not-tested-token-required'});
  results.push({provider:'api-football',state:'existing-adapter-not-called-no-extra-quota'});
  const report={checkedAt:new Date().toISOString(),liveProbe:true,productionWrites:0,paidRequests:0,results};
  console.log(JSON.stringify(report,null,2));if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));
}
if(require.main===module)main();
