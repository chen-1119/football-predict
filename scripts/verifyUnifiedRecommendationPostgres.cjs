'use strict';
// All writes use a unique temporary schema in an explicit disposable local DB.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRuntime}=require('./recommendationPlatform/runtime.cjs');
const {postgresPorts}=require('./recommendationPlatform/repository.cjs');
async function verify(pool){
  const schema=`recommendation_verify_${process.pid}_${Date.now()}`;
  const q=(sql,args)=>pool.query(sql.replaceAll('football.',`${schema}.`),args);
  const mappedPool={async connect(){const c=await pool.connect();return {query:(sql,args)=>c.query(sql.replaceAll('football.',`${schema}.`),args),release:()=>c.release()};}};
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const dow=new Date(`${tomorrow}T12:00:00Z`).getUTCDay();
  let now=Date.parse(`${tomorrow}T${[0,6].includes(dow)?'14':'13'}:00:00Z`);
  const fixture=id=>({id:`sporttery_${id}`,sourceMatchId:String(id),businessDate:tomorrow,status:'SCHEDULED',homeTeamId:`h${id}`,awayTeamId:`a${id}`,homeTeamName:`Home ${id}`,awayTeamName:`Away ${id}`,kickoffTime:`${tomorrow}T16:00:00Z`,eventVersion:`${tomorrow}T16:00:00Z`,probabilityModel:{generatedAt:new Date(now).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}},odds:{odds1:1.8,oddsX:3.5,odds2:4.5},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(now).toISOString(),predictions:[]});
  let checks=0;const check=(fn)=>{fn();checks++;};
  const write=async(m,dataset='current')=>q('INSERT INTO football.match_snapshots(id,dataset,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(id,dataset) DO UPDATE SET payload=EXCLUDED.payload',[m.id,dataset,JSON.stringify(m)]);
  try{
    await pool.query(`CREATE SCHEMA ${schema}`);
    await q(`CREATE TABLE football.projection_meta(key text PRIMARY KEY,value text,updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE football.match_snapshots(id text,dataset text,payload jsonb,PRIMARY KEY(id,dataset));
      CREATE TABLE football.daily_featured_combo_state(id integer PRIMARY KEY,payload jsonb);`);
    await q(fs.readFileSync(path.join(__dirname,'../server/postgres/migrations/011_unified_recommendation_runtime.sql'),'utf8'));
    for(const [key,value] of Object.entries({data_publication_mode:'generation',data_generation_id:'test-generation',manifest_hash:'a'.repeat(64),data_generation_source_cycle_id:'test-source',committed_at:new Date(now).toISOString()}))await q('INSERT INTO football.projection_meta(key,value) VALUES($1,$2)',[key,value]);
    await Promise.all([1,2,3].map(id=>write(fixture(id))));
    const runtime=createRuntime(postgresPorts(mappedPool,()=>now),{validators:{isFinal:r=>r.testOfficial===true&&r.status==='FINISHED',isVoid:r=>r.testOfficial===true&&r.resultDisposition==='VOID'}});
    const first=await runtime.publishingCycle();check(()=>assert.equal(first.publication.ok,true));check(()=>assert.equal(first.combinations.ok,true));check(()=>assert.equal(first.projection.ok,true));
    check(()=>assert.equal((first.publication.value.decisionIds).length,3));
    const frozen=(await q('SELECT payload FROM football.recommendation_combo_records ORDER BY size')).rows;
    check(()=>assert.equal(frozen.length,2));
    check(()=>assert.equal(frozen[1].payload.legs.length,3));
    const before=(await q('SELECT payload FROM football.recommendation_decisions ORDER BY id')).rows;
    await Promise.all([runtime.publishingCycle(),runtime.publishingCycle()]);
    check(()=>assert.equal(before.length,3));
    const concurrentCombos=(await q('SELECT payload FROM football.recommendation_combo_records ORDER BY size')).rows;check(()=>assert.deepEqual(concurrentCombos,frozen));
    const after=(await q('SELECT payload FROM football.recommendation_decisions ORDER BY id')).rows;check(()=>assert.deepEqual(after,before));
    await assert.rejects(q('UPDATE football.recommendation_decisions SET payload=payload'),{code:'23000'});checks++;
    await assert.rejects(q('DELETE FROM football.recommendation_combo_records'),{code:'23000'});checks++;
    // Force a settlement storage error. A separate publication must still commit.
    await q(`CREATE FUNCTION football.fail_settlement_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END; $$;
      CREATE TRIGGER injected_failure BEFORE INSERT ON football.recommendation_result_events FOR EACH ROW EXECUTE FUNCTION football.fail_settlement_test();`);
    now+=1000;await write(fixture(4));await runtime.publish();
    now=Date.parse(`${tomorrow}T19:00:00Z`);for(const id of [1,2,3])await write({...fixture(id),status:'FINISHED',testOfficial:true,scoreHome:2,scoreAway:0},'history');
    const failed=await runtime.settlementCycle();check(()=>assert.equal(failed.settlement.ok,false));
    const retained=(await q('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows[0].payload.recommendationCenter;check(()=>assert.equal(retained.lanes.settlement.status,'error'));
    const count=await q('SELECT count(*)::int AS n FROM football.recommendation_decisions');check(()=>assert.equal(count.rows[0].n,4));
    await q('DROP TRIGGER injected_failure ON football.recommendation_result_events');await runtime.settlementCycle();
    await write({...fixture(1),status:'FINISHED',testOfficial:true,scoreHome:0,scoreAway:2,resultRevision:2},'history');await runtime.settlementCycle();
    const center=(await q('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows[0].payload.recommendationCenter;
    check(()=>assert.equal(center.review.statistics.single.lost,1));check(()=>assert.equal(center.review.statistics.three.lost,1));
    const afterFrozen=(await q('SELECT payload FROM football.recommendation_combo_records ORDER BY size')).rows;check(()=>assert.deepEqual(afterFrozen,frozen));
    const revisions=(await q('SELECT count(*)::int AS n FROM football.recommendation_result_events')).rows[0].n;await runtime.settlementCycle();check(()=>assert.ok(revisions>=4));
    const afterRevisions=(await q('SELECT count(*)::int AS n FROM football.recommendation_result_events')).rows[0].n;check(()=>assert.equal(afterRevisions,revisions));
    return {ok:true,checks,schema,scope:'disposable-test-schema',productionRowsWritten:0};
  }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
}
if(require.main===module){const url=process.env.UNIFIED_TEST_DATABASE_URL;if(!url)throw new Error('Explicit UNIFIED_TEST_DATABASE_URL is required; production defaults are never used');const parsed=new URL(url);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/recommendation_test')throw new Error('Use local disposable database recommendation_test only');const {Pool}=require('pg');const pool=new Pool({connectionString:url,ssl:false,max:6});verify(pool).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
