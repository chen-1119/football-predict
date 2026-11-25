'use strict';
const check=(condition,code)=>{if(!condition)throw Error(code);};
const url='https://gql.sportomedia.se/graphql';
const query='query NeutralLeague($configLeagueName:String!,$configSeasonStartYear:Int!,$type:String!,$startDate:String,$endDate:String){standingsForLeague(configLeagueName:$configLeagueName,configSeasonStartYear:$configSeasonStartYear,type:$type){standings{teamName teamId position stats{name value}}} matchesForLeague(configLeagueName:$configLeagueName,configSeasonStartYear:$configSeasonStartYear,startDate:$startDate,endDate:$endDate){matches{id startDate homeTeamName visitingTeamName homeTeamScore visitingTeamScore status configLeagueName homeTeamEverySportId visitingTeamEverySportId}}}';
const teams=new Map([[789,{name:'GAIS',tableId:25530,matchId:9382}],[600,{name:'IFK Göteborg',tableId:25508,matchId:9370}]]);
function requestBody(year){
 check(Number.isInteger(year)&&year>=2026&&year<2100,'SE_YEAR');
 return JSON.stringify({query,variables:{configLeagueName:'allsvenskan',configSeasonStartYear:year,type:'total',startDate:year+'-01-01',endDate:year+'-12-31'}});
}
function parse(body,event,year,now){
 check(event.leagueName==='瑞典超级联赛'&&event.businessDate.slice(0,4)===String(year),'SE_LEAGUE_SEASON');
 const mapped=[teams.get(Number(event.homeTeamId)),teams.get(Number(event.awayTeamId))];
 check(mapped.every(Boolean)&&mapped[0].matchId!==mapped[1].matchId,'SE_TEAM_MAPPING');
 const data=JSON.parse(body);check(!data.errors?.length,'SE_GRAPHQL_ERROR');
 const rows=data.data?.matchesForLeague?.matches,table=data.data?.standingsForLeague?.standings;
 check(Array.isArray(rows)&&Array.isArray(table)&&table.length===16,'SE_RESPONSE');
 check(new Set(rows.map(row=>row.id)).size===rows.length&&rows.every(row=>Number.isSafeInteger(row.id)&&row.configLeagueName==='allsvenskan'&&row.startDate?.startsWith(year+'-')&&Number.isFinite(Date.parse(row.startDate))),'SE_MATCH_IDENTITY');
 const exact=rows.filter(row=>row.homeTeamEverySportId===mapped[0].matchId&&row.visitingTeamEverySportId===mapped[1].matchId&&row.homeTeamName===mapped[0].name&&row.visitingTeamName===mapped[1].name&&Date.parse(row.startDate)===Date.parse(event.kickoff));
 check(exact.length===1,'SE_FIXTURE_BINDING');
 check(new Set(table.map(row=>row.teamId)).size===16&&new Set(table.map(row=>row.position)).size===16&&table.every(row=>Number.isInteger(row.position)&&row.position>=1&&row.position<=16),'SE_TABLE_IDENTITY');
 const result=mapped.map(team=>{
  const entries=table.filter(row=>row.teamId===team.tableId&&row.teamName===team.name);check(entries.length===1,'SE_STANDING_TEAM');
  const entry=entries[0],stats=Object.fromEntries(entry.stats.map(row=>[row.name,Number(row.value)]));
  check(['gp','w','t','l','pts'].every(key=>Number.isSafeInteger(stats[key])&&stats[key]>=0)&&stats.gp===stats.w+stats.t+stats.l,'SE_STANDING_NUMBERS');
  const lastFive=rows.filter(row=>[row.homeTeamEverySportId,row.visitingTeamEverySportId].includes(team.matchId)&&Date.parse(row.startDate)<Math.min(now,Date.parse(event.kickoff))&&!['CANCELLED','POSTPONED'].includes(row.status)).sort((left,right)=>Date.parse(right.startDate)-Date.parse(left.startDate)).slice(0,5).map(row=>{
   check((row.homeTeamEverySportId===team.matchId?row.homeTeamName:row.visitingTeamName)===team.name&&row.homeTeamName&&row.visitingTeamName&&row.homeTeamEverySportId!==row.visitingTeamEverySportId,'SE_HISTORY_TEAM');
   const score=[row.homeTeamScore,row.visitingTeamScore];
   return {kickoff:row.startDate,home:row.homeTeamName,away:row.visitingTeamName,...(row.status==='FINISHED'&&score.every(value=>Number.isSafeInteger(value)&&value>=0&&value<100)?{score}:{missing:true})};
  });
  return {standing:{rank:entry.position,played:stats.gp,win:stats.w,draw:stats.t,loss:stats.l,points:stats.pts},history:{scope:'瑞典超官方当季联赛近五场，非全赛事；单一官方来源',lastFive,lastFiveComplete:lastFive.length===5&&lastFive.every(row=>!row.missing)}};
 });
 return {providerId:exact[0].id,teams:result};
}
module.exports={url,requestBody,parse};
