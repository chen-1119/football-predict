'use strict';
// All writes use a unique temporary schema in an explicit disposable local DB.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRuntime}=require('./recommendationPlatform/runtime.cjs');
const {Repository,postgresPorts}=require('./recommendationPlatform/repository.cjs');
const {readDualResearchReport}=require('./recommendationPlatform/dualResearchReport.cjs');
const {createDualResearchV2Record}=require('./recommendationPlatform/dualChoiceResearchV2.cjs');
const {withVerifiedInputEvidence}=require('../tests/fixtures/recommendation-input-helper.cjs');
// Synthetic signatures exercise the real source admission contract. They are
// scoped to this verifier's private temporary directory, never live evidence.
function signedFixtureContext(){
  const context=require('./collectorAttestationTestFixture.cjs').createCollectorAttestationTestContext({keyId:'disposable-postgres-fixture',independenceDomain:'synthetic-postgres'});
  const file=path.join(path.dirname(context.registryPath),'official-current.json');
  const previous=process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;
  process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=file;
  fs.writeFileSync(file,'null\n');
  const normalize=match=>({...match,
    homeTeamId:require('./storedResultTeamIdentity.cjs').derivedTeamId(match.homeTeamName),
    awayTeamId:require('./storedResultTeamIdentity.cjs').derivedTeamId(match.awayTeamName),
    eventVersion:new Date(match.eventVersion||match.kickoffTime).toISOString(),
    matchNo:match.matchNo||`周${'日一二三四五六'[new Date(match.businessDate+'T12:00:00Z').getUTCDay()]}${String(match.sourceMatchId).padStart(3,'0')}`});
  const observationAt=row=>{
    const m=row.prospectiveForecastInput||row;
    const clocks=[...(m.odds?[m.oddsReceivedAt,m.oddsObservedAt,m.oddsUpdatedAt]:[]),
      ...(m.handicapOdds?[m.handicapOddsReceivedAt,m.handicapOddsObservedAt,m.handicapOddsUpdatedAt]:[])]
      .filter(value=>typeof value==='string'&&value.length>0).map(Date.parse).filter(Number.isFinite);
    if(!clocks.length)throw new Error('Signed test fixture requires a valid observation clock for an available market');
    return Math.max(...clocks);
  };
  const writeSnapshot=(rows,receivedAt)=>{
    if(!Number.isSafeInteger(receivedAt))throw new Error('Signed test fixture acquisition clock must be finite');
    const inputs=rows.map(row=>row.prospectiveForecastInput||row),groups=new Map();
    for(const m of inputs){
      const kickoff=new Date(Date.parse(m.kickoffTime)+8*3600000).toISOString();
      const row={matchId:Number(m.sourceMatchId),businessDate:m.businessDate,matchDate:kickoff.slice(0,10),matchTime:kickoff.slice(11,19),matchNumStr:m.matchNo,
        homeTeamAllName:m.homeTeamName,awayTeamAllName:m.awayTeamName,matchStatus:'Selling',sellStatus:1,
        oddsList:[...(m.odds?[{poolCode:'HAD',h:m.odds.odds1,d:m.odds.oddsX,a:m.odds.odds2,goalLine:''}]:[]),
          ...(m.handicapOdds?[{poolCode:'HHAD',h:m.handicapOdds.odds1,d:m.handicapOdds.oddsX,a:m.handicapOdds.odds2,goalLine:m.handicapLine}]:[])],
        poolList:['HAD','HHAD'].map(poolCode=>({poolCode,poolStatus:'Selling',cbtValue:1,cbtAllUp:1,cbtSingle:0,intValue:2,intAllUp:0,intSingle:0,bettingAllup:1}))};
      const group=groups.get(m.businessDate)||[];group.push(row);groups.set(m.businessDate,group);
    }
    const payload={success:true,value:{matchInfoList:[...groups].map(([businessDate,subMatchList])=>({businessDate,subMatchList}))}};
    const endpoints=['current','calculator'].map(method=>require('../tests/fixtures/signed-live-had.cjs').snapshot([],{receivedAt,requestedAt:receivedAt-500,pair:context.keyPair,
      mutate(entry){entry.method=method;entry.payload=payload;entry.sourceCycleId='synthetic-postgres-'+receivedAt;
        entry.url=require('./sportteryEndpointContract.cjs')[method==='current'?'SPORTTERY_CURRENT_URL':'SPORTTERY_CALCULATOR_URL'];
        entry.sourceRequest={method:'GET',url:entry.url,page:null,role:method};}}).snapshot.endpoints[0]);
    fs.writeFileSync(file,JSON.stringify({endpoints}));
    return {endpoints};
  };
  return {normalize,observationAt,writeSnapshot,registry:context.registry,cleanup(){
    if(previous===undefined)delete process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT;else process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT=previous;
    context.cleanup();
  }};
}
async function verify(pool){
  const schema=`recommendation_verify_${process.pid}_${Date.now()}`;
  const q=(sql,args)=>pool.query(sql.replaceAll('football.',`${schema}.`),args);
  const mappedPool={async connect(){const c=await pool.connect();return {query:(sql,args)=>c.query(sql.replaceAll('football.',`${schema}.`),args),release:()=>c.release()};}};
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const dow=new Date(`${tomorrow}T12:00:00Z`).getUTCDay();
  let now=Date.parse(`${tomorrow}T${[0,6].includes(dow)?'14':'13'}:00:00Z`);
  const signed=signedFixtureContext();
  const rawFixture=id=>signed.normalize({id:`sporttery_${id}`,sourceMatchId:String(id),businessDate:tomorrow,status:'SCHEDULED',homeTeamName:`Home ${id}`,awayTeamName:`Away ${id}`,kickoffTime:`${tomorrow}T16:00:00Z`,eventVersion:`${tomorrow}T16:00:00Z`,probabilityModel:{generatedAt:new Date(now).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}}},odds:{odds1:1.8,oddsX:3.5,odds2:4.5},oddsSource:'sporttery:had',oddsUpdatedAt:new Date(now).toISOString(),predictions:[]});
  const fixture=id=>withVerifiedInputEvidence(rawFixture(id));
  let checks=0;const check=(fn)=>{fn();checks++;};
  const write=async(m,dataset='current')=>{
    await q(`INSERT INTO football.match_snapshots(id,dataset,source_match_id,kickoff_time,payload)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id,dataset) DO UPDATE
    SET source_match_id=EXCLUDED.source_match_id,kickoff_time=EXCLUDED.kickoff_time,payload=EXCLUDED.payload`,
    [m.id,dataset,m.sourceMatchId,m.kickoffTime,JSON.stringify(m)]);
    if(dataset==='current'){
      const rows=(await q("SELECT payload FROM football.match_snapshots WHERE dataset='current' ORDER BY id")).rows.map(r=>r.payload);
      const clocks=rows.map(signed.observationAt),newest=Math.max(...clocks);
      // Adding one later fixture must not manufacture a refreshed observation
      // for the previously frozen events exercised by the immutability test.
      signed.writeSnapshot(rows.filter((_,index)=>clocks[index]===newest),newest);
    }
  };
  try{
    await pool.query(`CREATE SCHEMA ${schema}`);
    await q(`CREATE TABLE football.projection_meta(key text PRIMARY KEY,value text,updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE football.match_snapshots(id text,dataset text,source_match_id text,kickoff_time timestamptz,payload jsonb,PRIMARY KEY(id,dataset));
      CREATE TABLE football.private_model_artifacts(artifact_key text PRIMARY KEY,artifact_version text NOT NULL,
        generated_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload json NOT NULL,
        payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),payload_bytes integer NOT NULL CHECK(payload_bytes>0));
      CREATE TABLE football.daily_featured_combo_state(id integer PRIMARY KEY,payload jsonb);`);
    for(const migration of ['007_market_collector_runtime.sql','011_unified_recommendation_runtime.sql','013_dual_choice_research.sql','014_dual_choice_market_neutral.sql'])
      await q(fs.readFileSync(path.join(__dirname,'../server/postgres/migrations/',migration),'utf8'));
    for(const [key,value] of Object.entries({data_publication_mode:'generation',data_generation_id:'test-generation',manifest_hash:'a'.repeat(64),data_generation_source_cycle_id:'test-source',committed_at:new Date(now).toISOString()}))await q('INSERT INTO football.projection_meta(key,value) VALUES($1,$2)',[key,value]);
    // Snapshot publication follows each committed insert. Seed sequentially so
    // an earlier SELECT cannot overwrite the final three-event test snapshot.
    for(const id of [1,2,3])await write(fixture(id));
    // Explicit historical compatibility exercise; the production default is trained-only.
    const runtime=createRuntime({...postgresPorts(mappedPool,()=>now),trainedOnly:false,prdPaperPool:null},{dualResearchEnabled:true,validators:{isFinal:r=>r.testOfficial===true&&r.status==='FINISHED',isVoid:r=>r.testOfficial===true&&r.resultDisposition==='VOID'}});
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
    await q('DROP TRIGGER injected_failure ON football.recommendation_result_events');
    const recoveredSettlement=await runtime.settlementCycle();check(()=>assert.equal(recoveredSettlement.settlement.ok,true,JSON.stringify(recoveredSettlement)));
    await write({...fixture(1),status:'FINISHED',testOfficial:true,scoreHome:0,scoreAway:2,resultRevision:2},'history');
    const revisedSettlement=await runtime.settlementCycle();check(()=>assert.equal(revisedSettlement.settlement.ok,true,JSON.stringify(revisedSettlement)));
    const center=(await q('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows[0].payload.recommendationCenter;
    check(()=>assert.equal(center.review.statistics.single.lost,1));check(()=>assert.equal(center.review.statistics.three.lost,1));
    const afterFrozen=(await q('SELECT payload FROM football.recommendation_combo_records ORDER BY size')).rows;check(()=>assert.deepEqual(afterFrozen,frozen));
    const revisions=(await q('SELECT count(*)::int AS n FROM football.recommendation_result_events')).rows[0].n;await runtime.settlementCycle();check(()=>assert.ok(revisions>=4));
    const afterRevisions=(await q('SELECT count(*)::int AS n FROM football.recommendation_result_events')).rows[0].n;check(()=>assert.equal(afterRevisions,revisions));
    // Reproduce the empty-combo race on a fresh business day, using real
    // independently committed PostgreSQL transactions rather than mock rows.
    const nextDate=new Date(Date.parse(`${tomorrow}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    now=Date.parse(`${nextDate}T10:00:00Z`);
    const nextFixture=id=>withVerifiedInputEvidence(signed.normalize({...rawFixture(id),businessDate:nextDate,matchNo:undefined,kickoffTime:`${nextDate}T16:00:00Z`,eventVersion:`${nextDate}T16:00:00Z`}));
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
    const mixedFixture=id=>withVerifiedInputEvidence(signed.normalize({ ...rawFixture(id),businessDate:mixedDate,matchNo:undefined,kickoffTime:`${mixedDate}T16:00:00Z`,eventVersion:`${mixedDate}T16:00:00Z`,
      probabilityModel:{version:'mixed-integration',generatedAt:new Date(now).toISOString(),oneXTwo:{final:id===303?{home:80,draw:12,away:8}:{home:45,draw:30,away:25}},calculationTrace:{poisson:{lambdas:{home:1.4,away:1.1}}}},
      ...(id===303?{}:{handicapLine:1,handicapOdds:{odds1:1.8,oddsX:3.8,odds2:4.5},handicapOddsSource:'sporttery:HHAD',handicapOddsUpdatedAt:new Date(now).toISOString()}) }));
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

    // A HHAD-only event has no published HAD decision. Its frozen V2 research
    // pair is stored once, remains immutable, and still receives official
    // history for settlement under the exact event version.
    const researchDate=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
    const researchNow=Date.parse(`${researchDate}T13:00:00Z`);
    const researchFixture=withVerifiedInputEvidence(signed.normalize({...rawFixture(901),businessDate:researchDate,matchNo:undefined,
      kickoffTime:`${researchDate}T16:00:00Z`,eventVersion:`${researchDate}T16:00:00Z`,
      odds:null,oddsSource:null,oddsUpdatedAt:null,handicapLine:-1,
      handicapOdds:{odds1:2.2,oddsX:3.5,odds2:3.1},handicapOddsSource:'sporttery:HHAD',
      handicapOddsUpdatedAt:new Date(researchNow).toISOString(),
      probabilityModel:{generatedAt:new Date(researchNow).toISOString(),oneXTwo:{final:{home:55,draw:25,away:20}},
        calculationTrace:{poisson:{lambdas:{home:1.4,away:1.1}}}}}));
    const researchRecord=createDualResearchV2Record(researchFixture,{now:researchNow,
      publication:{generationId:'test-generation',manifestHash:'a'.repeat(64),committedAt:new Date(researchNow).toISOString()}});
    check(()=>assert.ok(researchRecord));
    check(()=>assert.deepEqual(researchRecord.selections.map(s=>s.market),['HHAD','HHAD']));
    await write(researchFixture);
    const researchClient=await mappedPool.connect();
    try{
      const researchRepo=new Repository(researchClient);
      check(()=>assert.equal(researchRepo instanceof Repository,true));
      // Each history read owns a consistent snapshot. Writes below use other
      // connections, so end this snapshot before observing their next version.
      const readResearchHistory=async()=>{
        await researchClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try{return await researchRepo.history();}
        finally{await researchClient.query('ROLLBACK');}
      };
      const beforeResearchHistory=await readResearchHistory();
      check(()=>assert.equal(beforeResearchHistory.some(m=>m.sourceMatchId==='901'),false));
      const createdResearch=await researchRepo.insertDualResearchV2(researchRecord,researchFixture);
      check(()=>assert.equal(createdResearch,true));
      const duplicatedResearch=await researchRepo.insertDualResearchV2(researchRecord,researchFixture);
      check(()=>assert.equal(duplicatedResearch,false));
      const researchRows=await researchRepo.dualResearchV2(researchDate);
      check(()=>assert.equal(researchRows.length,1));
      check(()=>assert.equal(researchRows[0].recordHash,researchRecord.recordHash));
      await assert.rejects(researchRepo.insertDualResearchV2({...researchRecord,version:'dual-choice-research-v1'},researchFixture),
        {code:'DUAL_RESEARCH_V2_INVALID'});checks++;
      await write({...researchFixture,id:'sporttery_901_rescheduled',
        kickoffTime:`${researchDate}T17:00:00Z`,eventVersion:`${researchDate}T17:00:00Z`},'history');
      const afterResearchHistory=await readResearchHistory();
      check(()=>assert.equal(afterResearchHistory.some(m=>m.sourceMatchId==='901'),true));
      check(()=>assert.equal(afterResearchHistory.some(m=>m.id==='sporttery_901_rescheduled'),false));
      await assert.rejects(q('UPDATE football.recommendation_dual_research_v2_records SET payload=payload'),{code:'23000'});checks++;
      await assert.rejects(q('DELETE FROM football.recommendation_dual_research_v2_records'),{code:'23000'});checks++;
    }finally{researchClient.release();}
    const beforeCutover=(await q('SELECT id,payload FROM football.recommendation_decisions ORDER BY id')).rows;
    const beforeCombos=(await q('SELECT payload FROM football.recommendation_combo_records ORDER BY id')).rows;
    // This legacy fixture deliberately lacks independent model artifact tables.
    // Exercise its real SQL publication constraint without invoking their views.
    const switchedPorts={...postgresPorts(mappedPool,()=>now),prdPaperPool:null};
    const switched=createRuntime(switchedPorts);
    check(()=>assert.equal(postgresPorts(mappedPool).trainedOnly,true));
    const newPublish=await switched.publish(),newCombos=await switched.combos(),switchedView=await switched.view();
    check(()=>assert.equal(newPublish.ok,true));check(()=>assert.equal(newCombos.ok,true));check(()=>assert.equal(switchedView.ok,true));
    check(()=>assert.deepEqual(newPublish.value.decisionIds,[]));
    // Missing registry schema is a real blocked model cycle, recorded in the
    // installed publish lane, never an unsupported league-baseline lane.
    switchedPorts.prdPaperPool=mappedPool;
    const blockedModel=await switched.leagueBaseline();check(()=>assert.equal(blockedModel.ok,false));
    const modelLane=(await q("SELECT payload FROM football.recommendation_lanes WHERE lane='publish'")).rows[0].payload;
    check(()=>assert.equal(modelLane.status,'error'));check(()=>assert.equal(modelLane.legacyRetired,true));
    check(()=>assert.equal(modelLane.errorCode,'LEAGUE_MODEL_CYCLE_FAILED'));
    const afterCutover=(await q('SELECT id,payload FROM football.recommendation_decisions ORDER BY id')).rows;
    const afterCombos=(await q('SELECT payload FROM football.recommendation_combo_records ORDER BY id')).rows;
    check(()=>assert.deepEqual(afterCutover,beforeCutover));check(()=>assert.deepEqual(afterCombos,beforeCombos));
    const cutoverView=(await q('SELECT payload FROM football.daily_featured_combo_state WHERE id=1')).rows[0].payload.recommendationCenter;
    check(()=>assert.equal(cutoverView.strategySwitch.legacyFallbackEnabled,false));
    check(()=>assert.deepEqual(cutoverView.current,[]));check(()=>assert.deepEqual(cutoverView.previews,[]));
    return {ok:true,checks,schema,scope:'disposable-test-schema',productionRowsWritten:0};
  }finally{try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{signed.cleanup();}}
}
if(require.main===module){const url=process.env.UNIFIED_TEST_DATABASE_URL;if(!url)throw new Error('Explicit UNIFIED_TEST_DATABASE_URL is required; production defaults are never used');const parsed=new URL(url);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/recommendation_test')throw new Error('Use local disposable database recommendation_test only');const {Pool}=require('pg');const pool=new Pool({connectionString:url,ssl:false,max:6});verify(pool).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={verify,signedFixtureContext};
