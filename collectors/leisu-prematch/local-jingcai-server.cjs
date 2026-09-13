'use strict';
const fs=require('node:fs');
const {VERSION,beijingDay,validDay}=require('./local-jingcai-scope.cjs');
const {createPool}=require('./store.cjs');
async function readRoster(businessDate=beijingDay(Date.now())){
 if(!validDay(businessDate))throw Error('Invalid official business date');
 const cfg=require('./cli.cjs').config(),pool=createPool(cfg.fixtureUrl),client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const metadata=await client.query("SELECT key,value FROM football.projection_meta WHERE key IN ('sync_meta_updated_at','data_generation_id')");
  const result=await client.query(`SELECT jsonb_build_object('id',payload->>'id','sourceMatchId',payload->>'sourceMatchId',
   'businessDate',payload->>'businessDate','matchNo',payload->>'matchNo','leagueName',payload->>'leagueName',
   'homeTeamName',payload->>'homeTeamName','awayTeamName',payload->>'awayTeamName','kickoffTime',payload->>'kickoffTime',
   'eventVersion',payload->>'eventVersion','status',payload->>'status','sourceStatus',payload->>'sourceStatus',
   'effectiveStatus',payload->>'effectiveStatus') AS match
   FROM football.match_snapshots WHERE dataset='current' AND payload->>'businessDate'=$1 ORDER BY kickoff_time,match_id`,[businessDate]);
  await client.query('COMMIT');
  const meta=Object.fromEntries(metadata.rows.map(r=>[r.key,r.value])),at=Date.now(),age=at-Date.parse(meta.sync_meta_updated_at);
  // This read defines the source-collection roster only. A stale projection is
  // exposed explicitly and can never support a complete/fresh coverage claim.
  return {version:VERSION,businessDate,readAt:new Date(at).toISOString(),matches:result.rows.map(r=>r.match),
   aliases:cfg.aliasesFile?JSON.parse(fs.readFileSync(cfg.aliasesFile,'utf8')):{},
   fixtureInput:{state:Number.isFinite(age)&&age>=-60000&&age<=cfg.maxAge*60000?'fresh':'stale',generatedAt:meta.sync_meta_updated_at||null,generationId:meta.data_generation_id||null}};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();await pool.end();}
}
module.exports={readRoster};
