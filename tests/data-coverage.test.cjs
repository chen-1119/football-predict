'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildDataCoverage}=require('../scripts/dataCoverage.cjs');
const {Repository}=require('../scripts/recommendationPlatform/repository.cjs');
const {makeDecision}=require('../scripts/recommendationPlatform/decision.cjs');
const {selectionQuality}=require('../src/services/recommendationSelectionQuality.cjs');
const {NOW,match,publication}=require('./recommendationFixture.cjs');

test('daily denominator includes unpublished fixtures and history moves without double counting',()=>{
 const first=match(1),second=match(2),third={...match(3),status:'FINISHED'};
 const {decision}=makeDecision(first,{now:NOW,publication:publication(NOW)});assert(decision);
 const before=JSON.stringify([first,second,third,decision]);
 const coverage=buildDataCoverage({targetRows:[{dataset:'history',payload:first},{dataset:'current',payload:first},{dataset:'current',payload:second},{dataset:'history',payload:third}],
   singles:[{decision,selectionQuality:selectionQuality(decision)}],now:NOW,lanes:{publish:{publication:publication(NOW)}}});
 assert.equal(coverage.businessDate,'2026-09-17');assert.equal(coverage.targetCount,3);
 assert.equal(coverage.publishableCount,1);assert.equal(coverage.qualifiedCount,1);
 assert.equal(coverage.unqualifiedCount,2);assert.equal(coverage.missingTotal,2);
 assert.deepEqual(coverage.missing.map(row=>row.sourceMatchId),['2','3']);
 assert.equal(coverage.missing[1].reasonCode,'not-pregame');
 assert.equal(JSON.stringify([first,second,third,decision]),before);
});

test('business date, not kickoff calendar date, controls the full target pool',()=>{
 const overnight={...match(4),businessDate:'2026-09-17',kickoffTime:'2026-09-18T01:00:00Z',eventVersion:'2026-09-18T01:00:00Z'};
 const next={...match(5),businessDate:'2026-09-18'};
 const x=buildDataCoverage({targetRows:[overnight,next],singles:[],now:NOW});
 assert.equal(x.targetCount,1);assert.equal(x.missing[0].sourceMatchId,'4');
});

test('published watch stays visible as unqualified and never becomes a formal pick',()=>{
 const fixture=match(6),{decision}=makeDecision(fixture,{now:NOW,publication:publication(NOW)});assert(decision);
 const x=buildDataCoverage({targetRows:[fixture],singles:[{decision,selectionQuality:{qualified:false,reasons:['team-samples-insufficient']}}],now:NOW});
 assert.equal(x.publishableCount,1);assert.equal(x.qualifiedCount,0);assert.equal(x.unqualifiedCount,1);
 assert.equal(x.missing[0].reasonCode,'team-samples-insufficient');assert.match(x.missing[0].reasonText,/历史样本不足/);
});

test('HAD missing with a complete HHAD collection record explains the separate market without publishing it',()=>{
 const fixture=match(8,NOW,{odds:null,oddsSource:null,handicapLine:-1,
   handicapOdds:{odds1:3.2,oddsX:3.5,odds2:1.8},handicapOddsSource:'sporttery:HHAD',
   handicapOddsObservedAt:new Date(NOW).toISOString(),handicapOddsUpdatedAt:new Date(NOW).toISOString()});
 const before=JSON.stringify(fixture);
 const x=buildDataCoverage({targetRows:[fixture],singles:[],now:NOW,lanes:{publish:{publication:publication(NOW)}}});
 assert.equal(x.publishableCount,0);assert.equal(x.qualifiedCount,0);
 assert.equal(x.missing[0].reasonCode,'official-had-quote-unavailable');
 assert.equal(x.missing[0].reasonText,'普通胜平负 SP 缺失；让球盘有采集记录，但当前没有可发布的独立让球推荐');
 assert.equal(JSON.stringify(fixture),before);
});

test('an old HHAD observation and recent relay receipt use the same source-neutral collection wording',()=>{
 const fixture=match(10,NOW,{odds:null,oddsSource:null,handicapLine:-2,
   handicapOdds:{odds1:4.2,oddsX:3.5,odds2:1.6},handicapOddsSource:'sporttery:HHAD',
   handicapOddsObservedAt:new Date(NOW-2*86400000).toISOString(),
   handicapOddsReceivedAt:new Date(NOW).toISOString(),handicapOddsUpdatedAt:new Date(NOW).toISOString()});
 const x=buildDataCoverage({targetRows:[fixture],singles:[],now:NOW,lanes:{publish:{publication:publication(NOW)}}});
 assert.equal(x.missing[0].reasonCode,'official-had-quote-unavailable');
 assert.equal(x.missing[0].reasonText,'普通胜平负 SP 缺失；让球盘有采集记录，但当前没有可发布的独立让球推荐');
 assert.equal(x.publishableCount,0);
});

test('a complete 500 HHAD collection record gets the same source-neutral wording',()=>{
 const fixture=match(11,NOW,{odds:null,oddsSource:null,handicapLine:-2,
   handicapOdds:{odds1:4.2,oddsX:3.5,odds2:1.6},handicapOddsSource:'500.com:HHAD',
   handicapOddsPoolCode:'HHAD',handicapOddsObservedAt:new Date(NOW).toISOString()});
 const x=buildDataCoverage({targetRows:[fixture],singles:[],now:NOW,lanes:{publish:{publication:publication(NOW)}}});
 assert.equal(x.missing[0].reasonCode,'official-had-quote-unavailable');
 assert.equal(x.missing[0].reasonText,'普通胜平负 SP 缺失；让球盘有采集记录，但当前没有可发布的独立让球推荐');
 assert.equal(x.publishableCount,0);
});

test('incomplete or mislabeled HHAD never claims a collected handicap quote',()=>{
 const base={odds:null,oddsSource:null,handicapLine:-1,
   handicapOdds:{odds1:3.2,oddsX:3.5,odds2:1.8},handicapOddsSource:'sporttery:HHAD',
   handicapOddsUpdatedAt:new Date(NOW).toISOString()};
 for(const patch of [
   {handicapOdds:{odds1:3.2,oddsX:null,odds2:1.8}},
   {handicapLine:'-0.5'},
   {handicapOddsSource:'api-football'},
   {handicapOddsPoolCode:'HAD'},
   {handicapOddsUpdatedAt:new Date(NOW+60000).toISOString()},
 ]){
   const fixture=match(9,NOW,{...base,...patch});
   const x=buildDataCoverage({targetRows:[fixture],singles:[],now:NOW,lanes:{publish:{publication:publication(NOW)}}});
   assert.equal(x.missing[0].reasonCode,'official-had-quote-unavailable');
   assert.equal(x.missing[0].reasonText,'赛前 SP 尚未取得或已过期，暂未入选');
 }
});

test('all omitted targets are counted and the bounded list announces truncation',()=>{
 const rows=Array.from({length:103},(_,i)=>({...match(i+10),businessDate:'2026-09-17'}));
 const x=buildDataCoverage({targetRows:rows,singles:[],now:NOW});
 assert.equal(x.targetCount,103);assert.equal(x.unqualifiedCount,103);assert.equal(x.missingTotal,103);
 assert.equal(x.missing.length,100);assert.equal(x.hasMore,true);
});

test('missing match identity keeps the coverage reason without linking a fictitious detail page',()=>{
 const fixture={...match(7),id:null,sourceMatchId:null};
 const x=buildDataCoverage({targetRows:[fixture],singles:[],now:NOW});
 assert.equal(x.targetCount,1);assert.equal(x.missingTotal,1);
 assert.equal(x.missing[0].matchId,null);assert.equal(x.missing[0].sourceMatchId,null);
});

test('repository reads current and history by explicit Sporttery business day, with a hard bound',async()=>{
 const calls=[],client={query:async(sql,args)=>{calls.push({sql,args});return{rows:[{dataset:'history',payload:match(1)}]};}};
 const rows=await new Repository(client).todayTargets('2026-09-17');assert.equal(rows.length,1);
 assert.match(calls[0].sql,/dataset IN \('current','history'\)/);assert.deepEqual(calls[0].args,['2026-09-17']);
 await assert.rejects(new Repository(client).todayTargets('2026-02-30'));
 client.query=async()=>({rows:Array(513).fill({dataset:'current',payload:match(1)})});
 await assert.rejects(new Repository(client).todayTargets('2026-09-17'),{code:'TARGET_POOL_LIMIT'});
});
