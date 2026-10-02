'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {plan,identity,hash,instant}=require('./core.cjs');
const {resolveFacts}=require('./adapters.cjs');
const {collect}=require('./client.cjs');
const {repository}=require('./store.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function config(env=process.env){
  const file=env.FOOTBALL_SOURCE_BINDINGS_FILE;
  const bindings=file?JSON.parse(fs.readFileSync(file,'utf8')):{};
  // Reuse exact existing bilingual aliases; never remove youth/women/reserve suffixes.
  let inherited={};
  try { const known=require('../../scripts/freeFootballTeamAliases.cjs').FREE_FOOTBALL_TEAM_ALIASES||{}; inherited=Object.fromEntries(Object.entries(known).map(([k,v])=>[k,[v]])); } catch {}
  if(!bindings||typeof bindings!=='object'||Array.isArray(bindings))throw new Error('invalid-bindings');
  if(bindings.venueBindings&&!Array.isArray(bindings.venueBindings))throw new Error('invalid-venue-bindings');
  return {footballDataKey:env.FOOTBALL_DATA_ORG_TOKEN||'',aliases:{'football-data.org':{...inherited,...bindings.aliases?.['football-data.org']},openligadb:{...inherited,...bindings.aliases?.openligadb}},venueBindings:bindings.venueBindings||[],
    userAgent:env.FOOTBALL_SOURCE_USER_AGENT||'football-predict/1.0 (https://github.com/chen-1119/football-predict)'};
}
async function runCycle(repo,options={}){
  const now=options.now||Date.now,started=now(),matches=await repo.current(),inputs=plan(matches,started,options),cached=await repo.caches();
  const cacheMap=new Map(cached.map(c=>[c.key,c]));
  const jobs=inputs.jobs.sort((a,b)=>(instant(cacheMap.get(a.key)?.checkedAt)||0)-(instant(cacheMap.get(b.key)?.checkedAt)||0));
  const groups=Object.groupBy(jobs,j=>j.provider),attempts=[];
  // Independent provider loops: one source's access failure cannot gate another.
  await Promise.all(Object.values(groups).map(async list=>{
    let requests=0;
    for(const job of list){
      if(requests>=8||now()-started>150000)break;
      let result;try{result=await collect(job,repo,options);}catch{attempts.push({provider:job.provider,state:'source-store-error',requested:false});break;}attempts.push({provider:result.provider,state:result.state,requested:result.requested});
      if(result.requested){requests++;if(['rate-limited','access-restricted','credentials-rejected','request-timeout','source-or-schema-error'].includes(result.state))break;await (options.sleep||sleep)(8000);}
    }
  }));
  const finalCache=await repo.caches();let published=0;
  for(const m of matches){if(!identity(m)||!['SCHEDULED','LIVE','FINISHED','PENDING_RESULT'].includes(m.status))continue;
    const view=resolveFacts(m,finalCache,now(),options);view.collection={states:inputs.states.find(s=>s.matchId===m.id)||null,providers:attempts};
    try{if(await repo.saveView(m,view))published++;}catch{attempts.push({provider:'local-store',state:'view-write-failed',requested:false});}
  }
  return {ok:!attempts.some(a=>a.state==='view-write-failed'),startedAt:new Date(started).toISOString(),completedAt:new Date(now()).toISOString(),requests:attempts.filter(a=>a.requested).length,published,attempts,unmapped:inputs.states.filter(s=>s.base==='unsupported-league').length};
}
async function main(argv=process.argv.slice(2),env=process.env){
  const {createPostgresPool}=require('../../server/postgresStore.cjs');
  const pool=createPostgresPool({max:4,min:0,applicationName:'football-free-sources'});
  let lock;
  try{
    if(argv.includes('--migrate')){await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));return {schema:'football_sources',migrated:true};}
    lock=await pool.connect();
    const ok=(await lock.query("SELECT pg_try_advisory_lock(hashtext('football-sources-cycle-v1')) AS ok")).rows[0].ok;
    if(!ok)return {ok:true,state:'already-running'};
    const result=await runCycle(repository(pool),config(env));
    return result;
  }finally{if(lock){await lock.query("SELECT pg_advisory_unlock(hashtext('football-sources-cycle-v1'))").catch(()=>{});lock.release();}await pool.end();}
}
if(require.main===module)main().then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('football-source-worker-failed; check local configuration and database permissions');process.exitCode=1;});
module.exports={main,runCycle,config};
