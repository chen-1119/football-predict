'use strict';
const p=require('./teamEvidenceSources.cjs'),store=require('./teamEvidenceStore.cjs');
const {transaction}=require('./recommendationPlatform/leagueBaselineRuntime.cjs');
const LICENSE_SHA='36ffd9dc085d529a7e60e1276d73ae5a030b020313e6c5408593a6ae2af39673';
async function run({pool,fetchImpl=fetch,clock=()=>new Date().toISOString(),delay=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const owner=await pool.connect(),started=Date.parse(clock());let locked=false;
 const report={version:'team-evidence-sync-report-v1',startedAt:clock(),sources:[],productionRecommendationWrites:0,modelParameterWrites:0};
 try{
  locked=(await owner.query("SELECT pg_try_advisory_lock(hashtext('football-team-evidence-sync-v1')) AS locked")).rows[0]?.locked===true;
  if(!locked)return {...report,ok:true,skipped:true,reason:'collector-running'};
  const matches=await transaction(pool,true,async c=>{const rows=(await c.query("SELECT payload FROM football.match_snapshots WHERE dataset='current' LIMIT 513")).rows;p.check(rows.length<=512,'MATCH_BOUND');return rows.map(r=>r.payload);});
  const plans=p.plans(matches,clock());let license=null;
  for(const plan of plans){
   if(Date.parse(clock())-started>120000){report.sources.push({id:plan.id,status:'budget-deferred'});continue;}
   const prior=await transaction(pool,true,c=>store.read(c,'team-evidence-attempt-'+plan.id));
   if(prior&&Date.parse(prior.payload.nextAttemptAt)>Date.parse(clock())){report.sources.push({id:plan.id,status:'not-due',lastAttemptState:prior.payload.status,nextAttemptAt:prior.payload.nextAttemptAt});continue;}
   // Commit retry timing before networking; a process crash cannot spin retries.
   await store.write(pool,(c,at)=>store.insert(c,'team-evidence-attempt-'+plan.id,p.seal({version:'team-evidence-attempt-v1',createdAt:at,sourceId:plan.id,status:'started',nextAttemptAt:new Date(Date.parse(at)+1800000).toISOString()}),at,{replace:true}));
   try{
    if(plan.kind==='history'&&!license){
     const url='https://raw.githubusercontent.com/openfootball/football.json/master/LICENSE.md',r=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
     p.check(r.ok&&Number(r.headers.get('content-length')||0)<=32768,'LICENSE_RESPONSE');
     const reader=r.body.getReader(),chunks=[];let size=0;try{while(true){const q=await reader.read();if(q.done)break;size+=q.value.length;p.check(size<=32768,'LICENSE_BOUND');chunks.push(Buffer.from(q.value));}}finally{await reader.cancel().catch(()=>{});}
     const raw=Buffer.concat(chunks);p.check(p.sha(raw)===LICENSE_SHA,'LICENSE_CHANGED');license={url,sha256:LICENSE_SHA,receivedAt:clock()};await delay(1000);
    }
    const packet=await p.capture(plan,{fetchImpl,clock});
    if(plan.kind==='history'){packet.licenseReceipt=license;const {contentHash,...body}=packet;void contentHash;packet.contentHash=p.hash(body);}
    const saved=await store.save(pool,packet);
    await store.write(pool,(c,at)=>store.insert(c,'team-evidence-attempt-'+plan.id,p.seal({version:'team-evidence-attempt-v1',createdAt:at,sourceId:plan.id,status:'succeeded',nextAttemptAt:new Date(Date.parse(at)+plan.intervalMs).toISOString(),...saved}),at,{replace:true}));
    report.sources.push({id:plan.id,status:'stored',...saved,summary:packet.summary});
   }catch(e){if(/COMMIT_UNKNOWN/.test(e.code||''))throw e;const code=/^TEAM_EVIDENCE_/.test(e.code||'')?e.code:'TEAM_EVIDENCE_SOURCE_FAILED';
    await store.write(pool,(c,at)=>store.insert(c,'team-evidence-attempt-'+plan.id,p.seal({version:'team-evidence-attempt-v1',createdAt:at,sourceId:plan.id,status:'failed',code,nextAttemptAt:new Date(Date.parse(at)+1800000).toISOString()}),at,{replace:true}));
    report.sources.push({id:plan.id,status:'failed',code});}
   await delay(1000);
  }
  return {...report,completedAt:clock(),ok:!report.sources.some(s=>s.status==='failed'||s.status==='budget-deferred')};
 }finally{let releaseError;try{if(locked)await owner.query("SELECT pg_advisory_unlock(hashtext('football-team-evidence-sync-v1'))");}catch(e){releaseError=e;throw e;}finally{owner.release(releaseError);}}
}
async function main(){const pool=require('../server/postgresStore.cjs').createPostgresPool({applicationName:'football-team-evidence-sync',max:2});
 try{const report=await run({pool});console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}finally{await pool.end();}}
if(require.main===module)main().catch(e=>{console.error(e.code||'TEAM_EVIDENCE_SYNC_FAILED_READ_BEFORE_RETRY');process.exitCode=1;});
module.exports={run};
