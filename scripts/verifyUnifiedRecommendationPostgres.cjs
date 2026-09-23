'use strict';
// All writes use a unique temporary schema in an explicit disposable local DB.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRuntime}=require('./recommendationPlatform/runtime.cjs');
const {postgresPorts}=require('./recommendationPlatform/repository.cjs');
const {readDualResearchReport}=require('./recommendationPlatform/dualResearchReport.cjs');
const {withVerifiedInputEvidence}=require('../tests/fixtures/recommendation-input-helper.cjs');
async function verify(pool){
  const schema=`recommendation_verify_${process.pid}_${Date.now()}`;
  const q=(sql,args)=>pool.query(sql.replaceAll('football.',`${schema}.`),args);
  const mappedPool={async connect(){const c=await pool.connect();return {query:(sql,args)=>c.query(sql.replaceAll('football.',`${schema}.`),args),release:()=>c.release()};}};
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const dow=new Date(`${tomorrow}T12:00:00Z`).getUTCDay();
  let now=Date.parse(`${tomorrow}T${[0,6].includes(dow)?'14':'13'}:00:00Z`);
  const rawFixture=id=>({id:`sporttery_${id}`,sourceMatchId:String(id),businessDate:tomorrow,status:'SCHEDULED',homeTeamId:`h${id}`,awayTeamId:`a${id}`,homeTeamName:`Home ${id}`,awayTeamName:`Away ${id}`,kickoffTime:`${tomorrow}T16:00:00Z`,eventVersion:`${tomorrow}T16:00:00Z`,probabilityModel:{generatedAt:new Date(now).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}},odds:{odds1:1.8,oddsX:3.5,odds2:4.5},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(now).toISOString(),predictions:[]});
  const fixture=id=>withVerifiedInputEvidence(rawFixture(id));
  let checks=0;const check=(fn)=>{fn();checks++;};
  const write=async(m,dataset='current')=>q(`INSERT INTO football.match_snapshots(id,dataset,source_match_id,kickoff_time,payload)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id,dataset) DO UPDATE
    SET source_match_id=EXCLUDED.source_match_id,kickoff_time=EXCLUDED.kickoff_time,payload=EXCLUDED.payload`,
    [m.id,dataset,m.sourceMatchId,m.kickoffTime,JSON.stringify(m)]);
  try{
    await pool.query(`CREATE SCHEMA ${schema}`);
    await q(`CREATE TABLE football.projection_meta(key text PRIMARY KEY,value text,updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE football.match_snapshots(id text,dataset text,source_match_id text,kickoff_time timestamptz,payload jsonb,PRIMARY KEY(id,dataset));
      CREATE TABLE football.daily_featured_combo_state(id integer PRIMARY KEY,payload jsonb);`);
    for(const migration of ['007_market_collector_runtime.sql','011_unified_recommendation_runtime.sql','013_dual_choice_research.sql'])
      await q(fs.readFileSync(path.join(__dirname,'../server/postgres/migrations/',migration),'utf8'));
    for(const [key,value] of Object.entries({data_publication_mode:'generation',data_generation_id:'test-generation',manifest_hash:'a'.repeat(64),data_generation_source_cycle_id:'test-source',committed_at:new Date(now).toISOString()}))await q('INSERT INTO football.projection_meta(key,value) VALUES($1,$2)',[key,value]);
    await Promise.all([1,2,3].map(id=>write(fixture(id))));
    const runtime=createRuntime(postgresPorts(mappedPool,()=>now),{dualResearchEnabled:true,validators:{isFinal:r=>r.testOfficial===true&&r.status==='FINISHED',isVoid:r=>r.testOfficial===true&&r.resultDisposition==='VOID'}});
    const first=await runtime.publishingCycle();check(()=>assert.equal(first.publication.ok,true));check(()=>assert.equal(first.dualResearch.ok,true));check(()=>assert.equal(first.combinations.ok,true));check(()=>assert.equal(first.projection.ok,true));
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
    // Reproduce the empty-combo race on a fresh business day, using real
    // independently committed PostgreSQL transactions rather than mock rows.
    const nextDate=new Date(Date.parse(`${tomorrow}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    now=Date.parse(`${nextDate}T10:00:00Z`);
    const nextFixture=id=>withVerifiedInputEvidence({...rawFixture(id),businessDate:nextDate,kickoffTime:`${nextDate}T16:00:00Z`,eventVersion:`${nextDate}T16:00:00Z`});
    const sourceVersion=async label=>{
      await q("UPDATE football.projection_meta SET value=$1 WHERE key='committed_at'",[new Date(now).toISOString()]);
      await q("UPDATE football.projection_meta SET value=$1 WHERE key='data_generation_id'",[label]);
    };
    await q("DELETE FROM football.match_snapshots WHERE dataset='current'");
    for(const id of [101,102,103])await write(nextFixture(id));
    await sourceVersion('race-before-publish');
    const firstRacePublish=await runtime.publish();check(()=>assert.equal(firstRacePublish.ok,true));
    now+=60000;
    for(const id of [101,102,103])await write(nextFixture(id));
    await sourceVersion('race-after-publish');
    const raceCombos=await runtime.combos();check(()=>assert.equal(raceCombos.ok,true));
    check(()=>assert.deepEqual(raceCombos.value.previews.map(c=>c.size),[2,3]));
    const raceDecisions=(await q('SELECT payload FROM football.recommendation_decisions WHERE business_date=$1',[nextDate])).rows.map(r=>r.payload);
    check(()=>assert.equal(raceDecisions.length,6));
    check(()=>assert.ok(raceCombos.value.previews.every(c=>c.legs.every(d=>d.modelGeneratedAt===new Date(now).toISOString()&&raceDecisions.some(p=>p.decisionId===d.decisionId&&p.recordHash===d.recordHash)))));
    await Promise.all([runtime.publish(),runtime.combos()]);
    check(()=>assert.equal((raceCombos.value.previews[0].rawTotalOdds),3.24));
    const repeated=(await q('SELECT count(*)::int AS n FROM football.recommendation_decisions WHERE business_date=$1',[nextDate])).rows[0].n;
    check(()=>assert.equal(repeated,6));

    // A failure isolated to the single lane must not create a hidden single
    // prerequisite in either combo persistence or the frontend projection.
    await q(`CREATE FUNCTION football.fail_single_lane_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.lane='publish' THEN RAISE EXCEPTION 'injected single lane failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER injected_single_lane BEFORE INSERT OR UPDATE ON football.recommendation_lanes
        FOR EACH ROW EXECUTE FUNCTION football.fail_single_lane_test();`);
    now+=60000;
    await q("DELETE FROM football.match_snapshots WHERE dataset='current'");
    for(const id of [201,202,203])await write(nextFixture(id));
    await sourceVersion('combo-without-single');
    const failedSingle=await runtime.publish();check(()=>assert.equal(failedSingle.ok,false));
    const independentCombos=await runtime.combos();check(()=>assert.equal(independentCombos.ok,true));
    check(()=>assert.deepEqual(independentCombos.value.previews.map(c=>c.size),[2,3]));
    check(()=>assert.ok(independentCombos.value.previews.every(c=>c.legs.every(d=>['201','202','203'].includes(d.sourceMatchId)))));
    check(()=>assert.equal(independentCombos.value.inputAsOf,new Date(now).toISOString()));
    await runtime.view();
    const newView=(await q('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows[0].payload.recommendationCenter;
    check(()=>assert.equal(newView.previews.length,2));
    check(()=>assert.equal(newView.lanes.combos.status,'ok'));
    await q('DROP TRIGGER injected_single_lane ON football.recommendation_lanes');
    const oldFrozen=(await q('SELECT payload FROM football.recommendation_combo_records WHERE business_date=$1 ORDER BY size',[tomorrow])).rows;
    check(()=>assert.deepEqual(oldFrozen,frozen));
    // Actual PostgreSQL round-trip for mixed markets. The saved HAD decision
    // stays immutable; only the bound combo selection can be HHAD.
    const mixedDate=new Date(Date.parse(`${nextDate}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    const mixedDow=new Date(`${mixedDate}T12:00:00Z`).getUTCDay();
    now=Date.parse(`${mixedDate}T${[0,6].includes(mixedDow)?'14':'13'}:00:00Z`);
    const mixedFixture=id=>withVerifiedInputEvidence({ ...rawFixture(id),businessDate:mixedDate,kickoffTime:`${mixedDate}T16:00:00Z`,eventVersion:`${mixedDate}T16:00:00Z`,
      probabilityModel:{version:'mixed-integration',generatedAt:new Date(now).toISOString(),oneXTwo:{final:id===303?{home:80,draw:12,away:8}:{home:45,draw:30,away:25}},calculationTrace:{poisson:{lambdas:{home:1.4,away:1.1}}}},
      ...(id===303?{}:{handicapLine:1,handicapOdds:{odds1:1.8,oddsX:3.8,odds2:4.5},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(now).toISOString()}) });
    await q("DELETE FROM football.match_snapshots WHERE dataset='current'");
    for(const id of [301,302,303])await write(mixedFixture(id));
    await sourceVersion('mixed-markets');
    const mixedRun=await runtime.publishingCycle();check(()=>assert.equal(mixedRun.dualResearch.ok,true));check(()=>assert.equal(mixedRun.combinations.ok,true));
    const researchBefore=(await q('SELECT payload FROM football.recommendation_dual_research_records WHERE business_date=$1 ORDER BY source_match_id',[mixedDate])).rows.map(x=>x.payload);
    check(()=>assert.equal(researchBefore.length,2));
    check(()=>assert.ok(researchBefore.every(r=>r.cohort==='independent-research-only'&&r.totalStake===2&&r.formalPromotion===false)));
    await runtime.publishingCycle();
    const researchRepeated=(await q('SELECT payload FROM football.recommendation_dual_research_records WHERE business_date=$1 ORDER BY source_match_id',[mixedDate])).rows.map(x=>x.payload);
    check(()=>assert.deepEqual(researchRepeated,researchBefore));
    await assert.rejects(q('UPDATE football.recommendation_dual_research_records SET payload=payload'),{code:'23000'});checks++;
    const mixedRecords=(await q('SELECT payload FROM football.recommendation_combo_records WHERE business_date=$1 ORDER BY size',[mixedDate])).rows.map(x=>x.payload);
    check(()=>assert.equal(mixedRecords.length,2));
    check(()=>assert.ok(mixedRecords.every(c=>c.selections.some(s=>s.market==='HHAD'))));
    check(()=>assert.ok(mixedRecords.find(c=>c.size===3).selections.some(s=>s.market==='HAD')));
    const mixedBindings=(await q('SELECT payload FROM football.recommendation_decisions WHERE business_date=$1',[mixedDate])).rows.map(x=>x.payload);
    check(()=>assert.ok(mixedRecords.every(c=>c.legs.every(d=>d.market==='HAD'&&mixedBindings.some(s=>s.decisionId===d.decisionId&&s.recordHash===d.recordHash)))));
    check(()=>assert.ok(mixedRecords.every(c=>Math.abs(c.rawTotalOdds-c.selections.reduce((p,s)=>p*s.odds,1))<1e-8)));
    now=Date.parse(`${mixedDate}T19:00:00Z`);
    for(const id of [301,302,303])await write({...mixedFixture(id),status:'FINISHED',testOfficial:true,scoreHome:id===303?2:0,scoreAway:0},'history');
    await runtime.settlementCycle();
    const privateReport=await readDualResearchReport(mappedPool,now);
    check(()=>assert.equal(privateReport.all.settled,2));
    check(()=>assert.equal(privateReport.all.settledStake,4));
    check(()=>assert.equal(privateReport.validation.formalPromotion,false));
    const mixedView=(await q('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows[0].payload.recommendationCenter;
    const mixedSettled=mixedView.review.combos.filter(r=>r.combo.businessDate===mixedDate);
    check(()=>assert.equal(mixedSettled.length,2));
    check(()=>assert.ok(mixedSettled.every(r=>r.settlement.state==='WON')));
    check(()=>assert.equal(mixedView.review.singles.find(r=>r.decision.sourceMatchId==='301').settlement.state,'LOST'));
    check(()=>assert.ok(mixedSettled.every(r=>r.settlement.legs.filter(l=>['301','302'].includes(l.sourceMatchId)).every(l=>l.state==='WON'))));
    const mixedAfterSettlement=(await q('SELECT payload FROM football.recommendation_combo_records WHERE business_date=$1 ORDER BY size',[mixedDate])).rows.map(x=>x.payload);
    check(()=>assert.deepEqual(mixedAfterSettlement,mixedRecords));
    return {ok:true,checks,schema,scope:'disposable-test-schema',productionRowsWritten:0};
  }finally{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
}
if(require.main===module){const url=process.env.UNIFIED_TEST_DATABASE_URL;if(!url)throw new Error('Explicit UNIFIED_TEST_DATABASE_URL is required; production defaults are never used');const parsed=new URL(url);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/recommendation_test')throw new Error('Use local disposable database recommendation_test only');const {Pool}=require('pg');const pool=new Pool({connectionString:url,ssl:false,max:6});verify(pool).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify};
