'use strict';
// An explicit disposable local DB only: no production URL defaults.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {normalizeRows}=require('../collectors/market/policy.cjs');
const {startRun,persistRun}=require('../collectors/market/store.cjs');
const {readMarketSignalRows}=require('../collectors/market/signalBridge.cjs');
const {attachProspectiveForecastInputs}=require('../src/services/prospectiveForecastInput.cjs');
const {createRuntime}=require('./recommendationPlatform/runtime.cjs');
const {postgresPorts}=require('./recommendationPlatform/repository.cjs');
const {withVerifiedInputEvidence}=require('../tests/fixtures/recommendation-input-helper.cjs');
async function verify(pool){
  const schema=`warehouse_sp_verify_${process.pid}_${Date.now()}`;
  const q=(sql,args)=>pool.query(sql.replaceAll('football.',`${schema}.`),args);
  const mappedPool={async connect(){const c=await pool.connect();return {query:(sql,args)=>c.query(sql.replaceAll('football.',`${schema}.`),args),release:()=>c.release()};}};
  const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
  let now=Date.parse(`${date}T10:00:00Z`),checks=0;
  const check=fn=>{fn();checks++;};
  const fixture=id=>withVerifiedInputEvidence({id:`sporttery_${id}`,sourceMatchId:String(id),businessDate:date,status:'SCHEDULED',
    homeTeamId:`h${id}`,awayTeamId:`a${id}`,homeTeamName:`Home ${id}`,awayTeamName:`Away ${id}`,
    kickoffTime:`${date}T16:00:00Z`,eventVersion:`${date}T16:00:00Z`,
    probabilityModel:{generatedAt:new Date(now).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}},
    odds:{odds1:1.8,oddsX:3.5,odds2:4.5},oddsSource:'500.com:HAD',oddsUpdatedAt:new Date(now).toISOString(),predictions:[]});
  const acquired=[301,302,303].map(id=>{const m=fixture(id);return {keys:[String(id)],signal:{source:'500.com:jczq',sourceMatchId:String(id),
    homeTeamName:m.homeTeamName,awayTeamName:m.awayTeamName,kickoffTime:m.kickoffTime,
    buyEndTime:`${date}T22:00:00+08:00`,bookmakerOdds:{had:m.odds}}};});
  async function collect(runId,failed=false){
    const client=await mappedPool.connect();
    try{
      await startRun(client,runId,new Date(now-1000).toISOString());
      return await persistRun(client,{runId,status:failed?'failed':'completed',
        markets:failed?[]:normalizeRows(acquired,new Date(now).toISOString()).markets,
        finishedAt:new Date(now+1000).toISOString(),sourceSha256:failed?null:'b'.repeat(64),sourceBytes:failed?null:1024,
        nextPollSeconds:60,httpStatus:failed?503:200,payload:{url:'https://trade.500.com/jczq/?playid=312&g=2',predictionEligible:false}},async()=>{});
    }finally{client.release();}
  }
  try{
    await pool.query(`CREATE SCHEMA ${schema}`);
    await q(`CREATE TABLE football.projection_meta(key text PRIMARY KEY,value text,updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE football.match_snapshots(id text,dataset text,source_match_id text,kickoff_time timestamptz,payload jsonb,PRIMARY KEY(id,dataset));
      CREATE TABLE football.daily_featured_combo_state(id integer PRIMARY KEY,payload jsonb);`);
    for(const migration of ['007_market_collector_runtime.sql','011_unified_recommendation_runtime.sql'])
      await q(fs.readFileSync(path.join(__dirname,'../server/postgres/migrations/',migration),'utf8'));
    for(const [key,value] of Object.entries({data_publication_mode:'generation',data_generation_id:'test-copy-generation',
      manifest_hash:'a'.repeat(64),data_generation_source_cycle_id:'test-copy-source',committed_at:new Date(now).toISOString()}))
      await q('INSERT INTO football.projection_meta(key,value) VALUES($1,$2)',[key,value]);
    const captured=await collect('jczq-copy-initial');check(()=>assert.equal(captured.changed,3));
    const signals=await readMarketSignalRows({query:q});check(()=>assert.equal(signals.length,3));
    check(()=>assert.ok(signals.every(r=>r.signal.bookmakerOdds.had.lotterySpReceipt?.officialDirect===false)));
    for(const row of signals){
      const fresh={...fixture(Number(row.signal.sourceMatchId)),externalSignals:row.signal};
      const parent={...fresh,probabilityModel:{...fresh.probabilityModel,generatedAt:new Date(now-86400000).toISOString()}};
      const [attached]=attachProspectiveForecastInputs([parent],[fresh],now);
      await q('INSERT INTO football.match_snapshots(id,dataset,source_match_id,kickoff_time,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
        [fresh.id,'current',fresh.sourceMatchId,fresh.kickoffTime,JSON.stringify(attached)]);
    }
    const runtime=createRuntime(postgresPorts(mappedPool,()=>now),{validators:{isFinal:()=>false,isVoid:()=>false}});
    const copied=await runtime.combos();check(()=>assert.equal(copied.ok,true));
    check(()=>assert.equal(copied.value.candidateCount,3));
    check(()=>assert.deepEqual(copied.value.previews.map(c=>c.size),[2,3]));
    check(()=>assert.ok(copied.value.previews.every(c=>c.legs.every(d=>d.quoteSource==='500.com:jczq:HAD'&&d.quoteProvenance.officialDirect===false))));
    check(()=>assert.ok(copied.value.previews.every(c=>c.rawTotalOdds>=(c.size===2?2.5:5))));
    const projection=await runtime.view();check(()=>assert.equal(projection.ok,true));
    const view=(await q('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows[0].payload.recommendationCenter;
    check(()=>assert.equal(view.previews.length,2));
    const first=signals[0].signal.bookmakerOdds.had.lotterySpReceipt;
    const originalProjection=(await q("SELECT payload FROM football.match_snapshots WHERE dataset='current' ORDER BY id")).rows;
    const originalDecisions=(await q('SELECT payload FROM football.recommendation_decisions ORDER BY id')).rows;
    const readAgain=(await readMarketSignalRows({query:q}))[0].signal.bookmakerOdds.had.lotterySpReceipt;
    check(()=>assert.deepEqual(readAgain,first));
    now+=20*60000;const repeated=await collect('jczq-copy-confirmed');check(()=>assert.equal(repeated.unchanged,3));
    const confirmed=(await readMarketSignalRows({query:q}))[0].signal.bookmakerOdds.had.lotterySpReceipt;
    check(()=>assert.equal(confirmed.observationId,first.observationId));
    check(()=>assert.equal(confirmed.observedAt,new Date(now).toISOString()));
    check(()=>assert.equal(confirmed.firstObservedAt,first.firstObservedAt));
    const refreshed=await runtime.publishingCycle();check(()=>assert.equal(refreshed.publication.ok,true));check(()=>assert.equal(refreshed.combinations.ok,true));
    check(()=>assert.deepEqual(refreshed.combinations.value.previews.map(c=>c.size),[2,3]));
    check(()=>assert.equal(refreshed.combinations.value.inputAsOf,new Date(now).toISOString()));
    check(()=>assert.ok(refreshed.combinations.value.previews.every(c=>c.legs.every(d=>d.quoteObservedAt===new Date(now).toISOString()&&d.modelGeneratedAt===first.observedAt))));
    const unchangedProjection=(await q("SELECT payload FROM football.match_snapshots WHERE dataset='current' ORDER BY id")).rows;
    check(()=>assert.deepEqual(unchangedProjection,originalProjection));
    const versions=(await q('SELECT payload FROM football.recommendation_decisions ORDER BY id')).rows;
    check(()=>assert.equal(versions.length,6));check(()=>assert.ok(originalDecisions.every(d=>versions.some(v=>JSON.stringify(v)===JSON.stringify(d)))));
    now+=60000;await collect('jczq-copy-failed',true);
    const afterFailure=(await readMarketSignalRows({query:q}))[0].signal.bookmakerOdds.had.lotterySpReceipt;
    check(()=>assert.deepEqual(afterFailure,confirmed));
    await runtime.publishingCycle();const unchangedCount=(await q('SELECT count(*)::int AS n FROM football.recommendation_decisions')).rows[0].n;
    check(()=>assert.equal(unchangedCount,6));
    now+=16*60000;await runtime.publishingCycle();
    const expired=(await q('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows[0].payload.recommendationCenter;
    check(()=>assert.equal(expired.previews.length,0));check(()=>assert.equal(expired.lanes.combos.status,'error'));
    await q("UPDATE football.market_latest SET content_hash=$1 WHERE source_match_id='301'",['c'.repeat(64)]);
    const corrupt=(await readMarketSignalRows({query:q})).find(r=>r.signal.sourceMatchId==='301');
    check(()=>assert.equal(corrupt.signal.bookmakerOdds.had.lotterySpReceipt,undefined));
    return {ok:true,checks,schema,scope:'disposable-test-schema',productionRowsWritten:0};
  }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
}
if(require.main===module){
  const url=process.env.UNIFIED_TEST_DATABASE_URL;
  if(!url)throw new Error('Explicit UNIFIED_TEST_DATABASE_URL required; production defaults are forbidden');
  const parsed=new URL(url);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/recommendation_test')throw new Error('Use local disposable recommendation_test only');
  const {Pool}=require('pg');const pool=new Pool({connectionString:url,ssl:false,max:6});
  verify(pool).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());
}
module.exports={verify};
