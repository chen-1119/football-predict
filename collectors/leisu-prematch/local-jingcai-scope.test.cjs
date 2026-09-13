'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {VERSION,selectDay,makePlan,coverage}=require('./local-jingcai-scope.cjs');
const now=Date.parse('2026-09-14T09:00:00Z');
const row=(id,extra={})=>({id:`sporttery_${id}`,sourceMatchId:String(id),businessDate:'2026-09-14',homeTeamName:`主${id}`,awayTeamName:`客${id}`,kickoffTime:'2026-09-15T03:00:00+08:00',status:'SCHEDULED',leagueName:'挪超',...extra});
function input(count=20){return {roster:{version:VERSION,businessDate:'2026-09-14',readAt:new Date(now).toISOString(),fixtureInput:{state:'fresh'},matches:Array.from({length:count},(_,i)=>row(i+1))},leaguePages:[{sourceUrl:'https://www.leisu.com/data/zuqiu/comp-777',rows:Array.from({length:count},(_,i)=>({href:`https://live.leisu.com/shujufenxi-${i+1}`,text:`26/09/15\n03:00\n主${i+1}\nvs\n客${i+1}\n-\n分析\n直播\n历史`}))}]};}
test('official business date owns overnight games; other days and non-official matches are excluded',()=>{
 const rows=[row(1),row(2,{businessDate:'2026-09-15'}),row(3,{businessDate:'2026-09-13',kickoffTime:'2026-09-14T18:00:00+08:00'}),row(4,{businessDate:null}),row(5,{id:'vendor_5'})];
 const result=selectDay(rows,'2026-09-14',now);assert.deepEqual(result.filter(r=>r.eligible).map(r=>r.siteMatchId),['sporttery_1']);assert.equal(result[0].kickoffUtc,'2026-09-14T19:00:00.000Z');
});
test('all 20 official fixtures outside the five leagues produce 40 targets without truncation',()=>{
 const p=makePlan(input(),now);assert.equal(p.totalMatches,20);assert.equal(p.targets.length,40);assert.equal(new Set(p.targets.map(t=>t.fixture.siteMatchId)).size,20);assert.equal(p.batchSize,12);assert.equal(p.unmatched.length,0);
});
test('unmatched official fixtures remain explicit while unrelated provider games add no tasks',()=>{
 const doc=input(3);doc.leaguePages[0].rows.splice(1,1);doc.leaguePages[0].rows.push({href:'https://live.leisu.com/shujufenxi-999',text:'26/09/15\n03:00\n非竞彩主队\nvs\n非竞彩客队\n-\n分析\n直播\n历史'});
 const p=makePlan(doc,now);assert.equal(p.totalMatches,3);assert.equal(p.targets.length,4);assert.equal(p.unmatched[0].siteMatchId,'sporttery_2');
});
test('explicit team aliases match both sides and kickoff; ambiguous identities remain missing',()=>{
 const doc=input(1);doc.roster.matches[0].homeTeamName='正式主队';doc.roster.aliases={'主1':'正式主队'};assert.equal(makePlan(doc,now).targets.length,2);
 doc.leaguePages[0].rows.push({...doc.leaguePages[0].rows[0],href:'https://live.leisu.com/shujufenxi-888'});const p=makePlan(doc,now);assert.equal(p.targets.length,0);assert.equal(p.unmatched[0].reason,'multiple_exact_candidates');
});
test('already started or cancelled fixtures stay in the daily accounting without prematch tasks',()=>{
 const doc=input(3);doc.roster.matches[0].kickoffTime='2026-09-14T16:00:00+08:00';doc.roster.matches[1].status='CANCELLED';const p=makePlan(doc,now);assert.equal(p.totalMatches,3);assert.equal(p.eligibleMatches,1);assert.equal(p.targets.length,2);assert.deepEqual(p.fixtures.filter(f=>!f.eligible).map(f=>f.reason).sort(),['already-started','not-scheduled']);
});
test('freshness and missing lineup prevent a false complete-data claim across batches',()=>{
 const p=makePlan(input(2),now),states=p.targets.map(t=>({siteMatchId:t.fixture.siteMatchId,kind:t.kind,status:'available'}));
 const partial=coverage(p.fixtures,states.slice(0,2),{state:'fresh'});assert.equal(partial.requiredTasks,4);assert.equal(partial.attemptedTasks,2);assert.equal(partial.collectionComplete,false);
 assert.equal(coverage(p.fixtures,states,{state:'stale'}).dataComplete,false);
 states[3].status='source_empty';assert.equal(coverage(p.fixtures,states,{state:'fresh'}).collectionComplete,true);assert.equal(coverage(p.fixtures,states,{state:'fresh'}).dataComplete,false);
});
test('the day is fixed from the cycle start and not silently replaced with nearest available day',()=>{
 const doc=input(1);doc.roster.businessDate='2026-09-13';assert.throws(()=>makePlan(doc,now),/current official roster/);
 const empty=input(0);const p=makePlan(empty,now);assert.equal(p.totalMatches,0);assert.equal(p.businessDate,'2026-09-14');
});
