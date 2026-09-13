'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {classifyRenderedView}=require('./browser.cjs');
const {createPool}=require('./store.cjs');
const {VERSION,leagueUrl,beijingDay,selectDay,coverage}=require('./local-jingcai-scope.cjs');
const MAX_BYTES=4*1024*1024;
const iso=value=>typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
function prepareBatch(batch,now=Date.now(),roster) {
  if(!batch||batch.version!==VERSION||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(batch.runId||''))throw Error('Invalid batch identity; current official-day scope is required');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(batch.cycleId||'')||!iso(batch.cycleStartedAt)||Date.parse(batch.cycleStartedAt)>now+60000||now-Date.parse(batch.cycleStartedAt)>24*3600000||batch.businessDate!==beijingDay(Date.parse(batch.cycleStartedAt)))throw Error('Invalid collection cycle or business date');
  if(roster?.version!==VERSION||roster.businessDate!==batch.businessDate)throw Error('Official roster is required');
  const fixtures=selectDay(roster.matches,batch.businessDate,Date.parse(batch.cycleStartedAt));
  if(!Array.isArray(batch.entries)||batch.entries.length>12)throw Error('Maximum 12 detail pages per batch; continue with another batch');
  if(!Array.isArray(batch.leaguePages)||batch.leaguePages.length>500||batch.leaguePages.some(url=>!leagueUrl(url)))throw Error('Unexpected league page');
  if(!iso(batch.startedAt)||Date.parse(batch.startedAt)>now+60000||now-Date.parse(batch.startedAt)>30*60000)throw Error('Batch time is stale or in the future');
  if(Date.parse(batch.startedAt)<Date.parse(batch.cycleStartedAt))throw Error('Batch precedes collection cycle');
  if(!['running','partial','completed','no-due-matches','blocked','login-required','browser-unavailable'].includes(batch.outcome))throw Error('Invalid browser outcome');
  const seen=new Set(),rows=[];
  for(const entry of batch.entries){
    const f=entry?.fixture,id=String(f?.providerMatchId||'');
    if(!/^[1-9][0-9]*$/.test(id)||!['injuries','lineup'].includes(entry.kind)||!leagueUrl(f?.sourceUrl))throw Error('Invalid match or source identity');
    const official=fixtures.find(row=>row.siteMatchId===f.siteMatchId);
    if(!official||f.businessDate!==batch.businessDate||f.homeName!==official.homeName||f.awayName!==official.awayName||f.kickoffUtc!==official.kickoffUtc)throw Error('Match does not belong to the official business-day roster');
    const translate=name=>Object.hasOwn(roster.aliases||{},name)?roster.aliases[name]:name;
    if(translate(f.providerHomeName||f.homeName)!==official.homeName||translate(f.providerAwayName||f.awayName)!==official.awayName)throw Error('Provider teams do not match official teams');
    if(!batch.leaguePages.includes(f.sourceUrl)||!iso(f.kickoffUtc)||!iso(entry.observedAt))throw Error('Invalid source timestamp or discovery page');
    if(Date.parse(entry.observedAt)<Date.parse(batch.startedAt)||Date.parse(entry.observedAt)>now+60000||now-Date.parse(entry.observedAt)>20*60000)throw Error('Observation receipt is stale or in the future');
    if(typeof f.homeName!=='string'||!f.homeName.trim()||f.homeName.length>150||typeof f.awayName!=='string'||!f.awayName.trim()||f.awayName.length>150||f.homeName===f.awayName)throw Error('Invalid team identity');
    if(seen.has(id+':'+entry.kind))throw Error('Duplicate match/kind in batch');seen.add(id+':'+entry.kind);
    const sourceUrl=`https://live.leisu.com/${entry.kind==='injuries'?'shujufenxi':'detail'}-${id}`;
    let result=classifyRenderedView(entry.view,{fixture:f,providerMatchId:id,providerHomeName:f.providerHomeName,providerAwayName:f.providerAwayName,kind:entry.kind,sourceUrl});
    if(!official.eligible||Date.parse(f.kickoffUtc)<=now||Date.parse(f.kickoffUtc)<=Date.parse(entry.observedAt))result={status:'ineligible',data:null,reason:official.reason||'already-started'};
    if(result.data)result.data={...result.data,siteMatchId:f.siteMatchId,businessDate:batch.businessDate,matchNo:official.matchNo};
    rows.push({siteMatchId:f.siteMatchId,businessDate:batch.businessDate,providerMatchId:id,kind:entry.kind,kickoffUtc:f.kickoffUtc,observedAt:entry.observedAt,sourceUrl,...result});
  }
  const hash=crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex');
  const missing=Array.isArray(batch.missing)?batch.missing:[];
  if(missing.length>fixtures.length||missing.some(m=>!fixtures.some(f=>f.siteMatchId===m?.siteMatchId)||!['unmapped','blocked','login-required','browser-unavailable'].includes(m.reason)))throw Error('Invalid missing-match report');
  const summary={version:batch.version,runId:batch.runId,cycleId:batch.cycleId,cycleStartedAt:batch.cycleStartedAt,businessDate:batch.businessDate,fixtures,fixtureInput:roster.fixtureInput,startedAt:batch.startedAt,storedAt:new Date(now).toISOString(),
    outcome:batch.outcome,observations:rows.length,available:rows.filter(row=>row.status==='available').length,
    injuries:rows.filter(row=>row.kind==='injuries'&&row.status==='available').reduce((n,row)=>n+row.data.injuries.length,0),
    lineupTeams:rows.filter(row=>row.kind==='lineup'&&row.status==='available').reduce((n,row)=>n+row.data.teams.length,0),
    states:[...missing.flatMap(m=>['injuries','lineup'].map(kind=>({siteMatchId:m.siteMatchId,kind,status:m.reason,reason:m.reason}))),...rows.map(row=>({siteMatchId:row.siteMatchId,providerMatchId:row.providerMatchId,kind:row.kind,status:row.status,reason:row.reason||null}))],
    leaguePages:batch.leaguePages.length,httpStatus:null,predictionEligible:false};
  return {runId:batch.runId,hash,summary,rows};
}
async function ingest(pool,batch,loadRoster=()=>require('./local-jingcai-server.cjs').readRoster(batch.businessDate)){
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
    if(batch.version!==VERSION)throw Error('New observations require an official business-day batch');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['leisu-local-cycle:'+batch.cycleId]);
    const previous=await client.query("SELECT summary FROM leisu_prematch.local_browser_runs WHERE summary->>'cycleId'=$1 LIMIT 1",[batch.cycleId]);
    if(previous.rows.length&&(previous.rows[0].summary.businessDate!==batch.businessDate||previous.rows[0].summary.cycleStartedAt!==batch.cycleStartedAt))throw Error('Collection cycle identity changed');
    const prepared=prepareBatch(batch,Date.now(),await loadRoster());
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
  if(action==='fixtures')return require('./local-jingcai-server.cjs').readRoster();
  const pool=createPool(process.env.LEISU_DATABASE_URL);
  try{
    if(action==='migrate'){
      const client=await pool.connect();try{await client.query('BEGIN');await client.query(fs.readFileSync(path.join(__dirname,'local-browser-schema.sql'),'utf8'));await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      return {ok:true,schema:'leisu_prematch',newDatabase:false};
    }
    if(action==='status'){
      const result=await pool.query('SELECT received_at,summary FROM leisu_prematch.local_browser_runs ORDER BY received_at DESC LIMIT 1');
      const latest=result.rows[0]||null;
      if(!latest?.summary?.cycleId)return {latest};
      const cycle=await pool.query("SELECT summary FROM leisu_prematch.local_browser_runs WHERE summary->>'cycleId'=$1 ORDER BY received_at,run_id",[latest.summary.cycleId]);
      return {latest,coverage:coverage(latest.summary.fixtures,cycle.rows.flatMap(r=>r.summary.states),latest.summary.fixtureInput)};
    }
    if(action!=='ingest')throw Error('Expected migrate, ingest or status');
    const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>MAX_BYTES)throw Error('Batch exceeds 4 MiB');chunks.push(chunk);}
    return await ingest(pool,JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }finally{await pool.end();}
}
module.exports={prepareBatch,ingest,main};
if(require.main===module)main().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify({ok:false,error:error.code||'local-browser-ingest-failed'}));process.exitCode=1;});
