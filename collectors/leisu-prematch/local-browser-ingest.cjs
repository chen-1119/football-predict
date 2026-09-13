'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {classifyRenderedView}=require('./browser.cjs');
const {windowFor}=require('./scope.cjs');
const {createPool}=require('./store.cjs');
const LEAGUES=[82,129,120,108,142].map(id=>`https://www.leisu.com/data/zuqiu/comp-${id}`);
const MAX_BYTES=4*1024*1024;
const iso=value=>typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
function prepareBatch(batch,now=Date.now()) {
  if(!batch||batch.version!=='leisu-local-browser-v1'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(batch.runId||''))throw Error('Invalid batch identity');
  if(!Array.isArray(batch.entries)||batch.entries.length>12)throw Error('Maximum 12 detail pages per run');
  if(!Array.isArray(batch.leaguePages)||batch.leaguePages.length>5||batch.leaguePages.some(url=>!LEAGUES.includes(url)))throw Error('Unexpected league page');
  if(!iso(batch.startedAt)||Date.parse(batch.startedAt)>now+60000||now-Date.parse(batch.startedAt)>30*60000)throw Error('Batch time is stale or in the future');
  if(!['completed','no-due-matches','blocked','login-required','browser-unavailable'].includes(batch.outcome))throw Error('Invalid browser outcome');
  const seen=new Set(),window=windowFor(now),rows=[];
  for(const entry of batch.entries){
    const f=entry?.fixture,id=String(f?.providerMatchId||'');
    if(!/^[1-9][0-9]*$/.test(id)||!['injuries','lineup'].includes(entry.kind)||!LEAGUES.includes(f?.sourceUrl))throw Error('Invalid match or source identity');
    if(!batch.leaguePages.includes(f.sourceUrl)||!iso(f.kickoffUtc)||!iso(entry.observedAt))throw Error('Invalid source timestamp or discovery page');
    if(Date.parse(entry.observedAt)<Date.parse(batch.startedAt)||Date.parse(entry.observedAt)>now+60000||now-Date.parse(entry.observedAt)>20*60000)throw Error('Observation receipt is stale or in the future');
    if(typeof f.homeName!=='string'||!f.homeName.trim()||f.homeName.length>150||typeof f.awayName!=='string'||!f.awayName.trim()||f.awayName.length>150||f.homeName===f.awayName)throw Error('Invalid team identity');
    if(seen.has(id+':'+entry.kind))throw Error('Duplicate match/kind in batch');seen.add(id+':'+entry.kind);
    const sourceUrl=`https://live.leisu.com/${entry.kind==='injuries'?'shujufenxi':'detail'}-${id}`;
    let result=classifyRenderedView(entry.view,{fixture:f,providerMatchId:id,kind:entry.kind,sourceUrl});
    if(Date.parse(f.kickoffUtc)<=now||Date.parse(f.kickoffUtc)<=Date.parse(entry.observedAt)||Date.parse(f.kickoffUtc)>=Date.parse(window.endUtc))result={status:'ineligible',data:null,reason:'outside-current-prematch-window'};
    rows.push({providerMatchId:id,kind:entry.kind,kickoffUtc:f.kickoffUtc,observedAt:entry.observedAt,sourceUrl,...result});
  }
  const hash=crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex');
  const summary={version:batch.version,runId:batch.runId,startedAt:batch.startedAt,storedAt:new Date(now).toISOString(),
    outcome:batch.outcome,observations:rows.length,available:rows.filter(row=>row.status==='available').length,
    injuries:rows.filter(row=>row.kind==='injuries'&&row.status==='available').reduce((n,row)=>n+row.data.injuries.length,0),
    lineupTeams:rows.filter(row=>row.kind==='lineup'&&row.status==='available').reduce((n,row)=>n+row.data.teams.length,0),
    states:rows.map(row=>({providerMatchId:row.providerMatchId,kind:row.kind,status:row.status,reason:row.reason||null})),
    leaguePages:batch.leaguePages.length,httpStatus:null,predictionEligible:false};
  return {runId:batch.runId,hash,summary,rows};
}
async function ingest(pool,batch){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(batch?.runId||''))throw Error('Invalid batch identity');
  const runId=batch.runId,hash=crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex'),client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['leisu-local-browser:'+runId]);
    const existing=await client.query('SELECT content_hash,summary FROM leisu_prematch.local_browser_runs WHERE run_id=$1',[runId]);
    if(existing.rows.length){
      if(existing.rows[0].content_hash!==hash)throw Error('Conflicting replay of browser run');
      await client.query('COMMIT');return {...existing.rows[0].summary,replayed:true};
    }
    const prepared=prepareBatch(batch);
    await client.query('INSERT INTO leisu_prematch.local_browser_runs(run_id,content_hash,summary) VALUES($1,$2,$3::jsonb)',[prepared.runId,prepared.hash,JSON.stringify(prepared.summary)]);
    for(const row of prepared.rows)await client.query(`INSERT INTO leisu_prematch.local_browser_observations
      (observation_id,run_id,provider_match_id,kind,kickoff_at,observed_at,source_url,status,payload,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,[crypto.randomUUID(),prepared.runId,row.providerMatchId,row.kind,row.kickoffUtc,row.observedAt,row.sourceUrl,row.status,row.data?JSON.stringify(row.data):null,row.reason||null]);
    const stored=await client.query('SELECT count(*)::int AS count FROM leisu_prematch.local_browser_observations WHERE run_id=$1',[prepared.runId]);
    if(stored.rows[0].count!==prepared.rows.length)throw Error('Stored row count mismatch');
    await client.query('COMMIT');return {...prepared.summary,verifiedRows:stored.rows[0].count,replayed:false};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function main(action=process.argv[2]){
  const pool=createPool(process.env.LEISU_DATABASE_URL);
  try{
    if(action==='migrate'){
      const client=await pool.connect();try{await client.query('BEGIN');await client.query(fs.readFileSync(path.join(__dirname,'local-browser-schema.sql'),'utf8'));await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      return {ok:true,schema:'leisu_prematch',newDatabase:false};
    }
    if(action==='status'){
      const result=await pool.query('SELECT received_at,summary FROM leisu_prematch.local_browser_runs ORDER BY received_at DESC LIMIT 1');return {latest:result.rows[0]||null};
    }
    if(action!=='ingest')throw Error('Expected migrate, ingest or status');
    const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>MAX_BYTES)throw Error('Batch exceeds 4 MiB');chunks.push(chunk);}
    return await ingest(pool,JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }finally{await pool.end();}
}
module.exports={LEAGUES,prepareBatch,ingest,main};
if(require.main===module)main().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify({ok:false,error:error.code||'local-browser-ingest-failed'}));process.exitCode=1;});
