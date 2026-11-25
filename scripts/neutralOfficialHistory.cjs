'use strict';
const parser=require('./neutralOfficialSportsParser.cjs');
const discovery=require('./neutralFutureDiscovery.cjs');
const check=(condition,code)=>{if(!condition)throw Error(code);};
const scores=values=>values.every(value=>Number.isSafeInteger(value)&&value>=0&&value<100);

function japanese(html,event,league,teamName,now){
 check(['j1','j2'].includes(league),'JP_HISTORY_LEAGUE');
 const discovered=discovery.japanese(html,league);
 check(discovery.match(event,discovered).status==='matched','JP_HISTORY_EVENT');
 const raw=parser.flightObjects(html).filter(row=>row.detailHref&&row.homeTeam?.fullName&&row.awayTeam?.fullName);
 const firstDay=Date.parse(event.businessDate.slice(0,4)+'-08-01T00:00:00+09:00'),records=new Map();
 for(const match of discovered){
  if(!match.names.includes(teamName)||Date.parse(match.kickoff)<firstDay||Date.parse(match.kickoff)>=Math.min(now,Date.parse(event.kickoff)))continue;
  const candidates=raw.filter(row=>row.id===match.providerId);
  check(candidates.length===1,'JP_HISTORY_DUPLICATE');
  const row=candidates[0],score=[row.homeTeam.score,row.awayTeam.score];
  records.set(match.providerId,{kickoff:match.kickoff,home:match.names[0],away:match.names[1],...(row.state==='game-over'&&scores(score)?{score}:{missing:true})});
 }
 const lastFive=[...records.values()].sort((left,right)=>Date.parse(right.kickoff)-Date.parse(left.kickoff)).slice(0,5);
 return {scope:league.toUpperCase()+' 官方当季联赛近五场；非全赛事，未完赛或比分缺失保留空位',lastFive,lastFiveComplete:lastFive.length===5&&lastFive.every(row=>!row.missing)};
}

function australian(body,event,teamId,now){
 check(discovery.match(event,discovery.australian(body,now)).status==='matched','AU_HISTORY_EVENT');
 const rows=JSON.parse(body),records=new Map();
 for(const row of rows){
  if(![row.homeTeam?.id,row.awayTeam?.id].includes(teamId)||row.startDate>=Math.min(now,Date.parse(event.kickoff))||row.startDate<now-365*86400000||row.matchStatus!=='Played')continue;
  check(row.competition?.id==='xwnjb1az11zffwty3m6vn8y6'&&row.competition.code==='ALM','AU_HISTORY_COMPETITION');
  check(Number.isSafeInteger(row.startDate)&&row.homeTeam.position==='home'&&row.awayTeam.position==='away'&&row.homeTeam.id!==row.awayTeam.id&&row.homeTeam.officialName&&row.awayTeam.officialName,'AU_HISTORY_IDENTITY');
  check(Number.isSafeInteger(row.lastUpdated)&&row.lastUpdated<=now,'AU_HISTORY_CLOCK');
  const fullTime=row.liveData?.matchDetails?.scores?.ft,score=[fullTime?.home,fullTime?.away];
  check(row.id&&!records.has(row.id),'AU_HISTORY_DUPLICATE');
  records.set(row.id,{kickoff:new Date(row.startDate).toISOString(),home:row.homeTeam.officialName,away:row.awayTeam.officialName,...(scores(score)?{score}:{missing:true})});
 }
 const lastFive=[...records.values()].sort((left,right)=>Date.parse(right.kickoff)-Date.parse(left.kickoff)).slice(0,5);
 return {scope:'A-League Men 官方近一年已结束联赛近五场，含跨赛季；仅90分钟含补时比分，非全赛事',lastFive,lastFiveComplete:lastFive.length===5&&lastFive.every(row=>!row.missing)};
}
module.exports={japanese,australian};
