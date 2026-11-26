'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const history=require('../scripts/neutralOfficialHistory.cjs'),parser=require('../scripts/neutralOfficialSportsParser.cjs');
const now=Date.parse('2026-10-25T01:00:00Z');
const auEvent={leagueName:'澳大利亚超级联赛',homeTeamId:753,awayTeamId:1096,homeTeamName:'悉尼FC',awayTeamName:'阿德莱德联',kickoff:'2026-10-25T04:00:00.000Z'};
const homeId='38ui5tfi8anjuh533emny2tz1',awayId='6lezh5aazy0xca1800e5dqxwl';
const auRow=offset=>({id:'match'+offset,startDate:Date.parse(auEvent.kickoff)-offset*86400000,lastUpdated:now-1000,matchStatus:offset?'Played':'Fixture',competition:{id:'xwnjb1az11zffwty3m6vn8y6',code:'ALM'},tournament:{startDate:now-365*86400000,endDate:now+365*86400000},homeTeam:{id:homeId,officialName:'Sydney FC',position:'home'},awayTeam:{id:awayId,officialName:'Adelaide United FC',position:'away'},homeScore:9,awayScore:8,liveData:{matchDetails:{scores:{ft:{home:2,away:1},total:{home:9,away:8}}}}});
test('Australia uses 90-minute ft, not total or future placeholders',()=>{
 const rows=Array.from({length:7},(_,index)=>auRow(index));
 const result=history.australian(JSON.stringify(rows),auEvent,homeId,now);
 assert.equal(result.lastFiveComplete,true);assert.equal(result.lastFive.length,5);
 assert(result.lastFive.every(row=>row.score[0]===2&&row.score[1]===1));assert.match(result.scope,/跨赛季/);
});
test('missing FT stays missing and cannot be replaced by total',()=>{
 const rows=Array.from({length:6},(_,index)=>auRow(index));delete rows[1].liveData.matchDetails.scores.ft;
 const result=history.australian(JSON.stringify(rows),auEvent,homeId,now);assert.equal(result.lastFiveComplete,false);assert.equal(result.lastFive[0].missing,true);
});
test('Australia rejects wrong event, reversed team positions, future update and duplicate',()=>{
 const original=Array.from({length:6},(_,index)=>auRow(index));
 for(const mutate of [rows=>{rows[0].startDate+=60000;},rows=>{rows[1].homeTeam.position='away';},rows=>{rows[1].lastUpdated=now+1;},rows=>rows.push(rows[1])]){
  const rows=structuredClone(original);mutate(rows);assert.throws(()=>history.australian(JSON.stringify(rows),auEvent,homeId,now));
 }
});
const jpEvent={businessDate:'2026-10-25',leagueName:'日本职业联赛',homeTeamId:548,awayTeamId:1016,homeTeamName:'东京FC',awayTeamName:'水户蜀葵',kickoff:'2026-10-25T07:00:00.000Z'};
const jpRow=day=>({id:'202610'+day+'05',detailHref:'/match/j1/2026/10'+day+'05',time:'16:00',state:day==='25'?'ticket':'game-over',homeTeam:{fullName:'ＦＣ東京',score:2},awayTeam:{fullName:'水戸ホーリーホック',score:0}});
const flight=value=>'<script>self.__next_f.push('+JSON.stringify([1,'1:'+JSON.stringify(value)+'\n'])+')</script>';
test('Japan requires exact event and preserves unfinished recent slots',()=>{
 const rows=['25','21','17','10','03','01'].map(jpRow);rows[1].state='live';
 const result=history.japanese(flight(rows),jpEvent,'j1','ＦＣ東京',now);
 assert.equal(result.lastFive.length,5);assert.equal(result.lastFive[0].missing,true);assert.equal(result.lastFiveComplete,false);
 assert.throws(()=>history.japanese(flight(rows),{...jpEvent,kickoff:'2026-10-25T07:01:00.000Z'},'j1','ＦＣ東京',now),/EVENT/);
});
test('Japan does not convert a three-match page into complete five-match history',()=>{
 const result=history.japanese(flight(['25','21','17','10'].map(jpRow)),jpEvent,'j1','ＦＣ東京',now);assert.equal(result.lastFive.length,3);assert.equal(result.lastFiveComplete,false);
});
test('J2 standings require current season and exact league',()=>{
 const value={leagueName:'j2',standingList:Array.from({length:20},(_,index)=>({club:{href:'/club/'+index,emblemVisual:{webp:{year:'2026_27'}}},ranking:{value:index+1},point:3,match:1,win:1,draw:0,loss:0}))};
 const event={businessDate:'2026-10-25',names:['主队','客队']};assert.equal(parser.japaneseTable(flight(value),event,['0','1'],'j2')[0].standing.rank,1);
 assert.throws(()=>parser.japaneseTable(flight(value),event,['0','1'],'j1'),/TABLE/);value.standingList[0].club.emblemVisual.webp.year='2025_26';assert.throws(()=>parser.japaneseTable(flight(value),event,['0','1'],'j2'),/SEASON/);
});
