'use strict';
const mapping=require('./neutralSportsTeamMap.cjs'),discovery=require('./neutralFutureDiscovery.cjs'),parser=require('./neutralOfficialSportsParser.cjs');
const bootstrapUrl='https://fantasy.premierleague.com/api/bootstrap-static/',fixturesUrl='https://fantasy.premierleague.com/api/fixtures/';
const names={58:'Aston Villa',65:'Man City',57:'Arsenal',62:'Everton',1076:'Coventry City',63:'Fulham',61:'Chelsea',73:'Spurs',322:'Hull City',402:'Brentford',354:'Crystal Palace',67:'Newcastle',66:'Man Utd',1044:'Bournemouth',71:'Sunderland',341:'Leeds'};
const check=(condition,code)=>{if(!condition)throw Error(code);};
function premierLeague(bootstrap,fixtures,event,now){
 const mapped=mapping.resolve(event);check(mapped?.code==='PL','FPL_MAPPING');
 check(Array.isArray(bootstrap.teams)&&bootstrap.teams.length===20&&Array.isArray(bootstrap.elements)&&bootstrap.elements.length<2000&&Array.isArray(fixtures)&&fixtures.length<=500,'FPL_SHAPE');
 const teams=mapped.teams.map(team=>{const found=bootstrap.teams.filter(row=>row.name===names[team[2]]);check(found.length===1&&Number.isSafeInteger(found[0].id),'FPL_TEAM');return found[0];});
 check(teams[0].id!==teams[1].id,'FPL_ORDER');
 const matches=fixtures.filter(row=>row.team_h===teams[0].id&&row.team_a===teams[1].id&&Date.parse(row.kickoff_time)===Date.parse(event.kickoff));
 check(matches.length===1&&Number.isSafeInteger(matches[0].id),'FPL_FIXTURE');
 const reports=[],skipped=[];
 for(const [side,team]of teams.entries()){
  const players=bootstrap.elements.filter(row=>row.team===team.id);check(players.length>=11&&new Set(players.map(row=>row.id)).size===players.length,'FPL_PLAYERS');
  for(const player of players){
   if(!['i','d','s','u'].includes(player.status))continue;
   const published=Date.parse(player.news_added);if(!Number.isFinite(published)||published>now||now-published>3*86400000||typeof player.news!=='string'||!player.news.trim()){skipped.push(player.id);continue;}
   check(Number.isSafeInteger(player.id)&&typeof player.first_name==='string'&&typeof player.second_name==='string'&&player.news.length<=1500,'FPL_REPORT');
   reports.push({team:side?event.awayTeamName:event.homeTeamName,name:(player.first_name+' '+player.second_name).trim(),status:{i:'伤病（官方FPL状态）',d:'出场存疑，未确认缺阵',s:'停赛（官方FPL状态，待纪律公告复核）',u:'不可用，原因见原文'}[player.status],reason:player.news,publishedAt:player.news_added,eventTime:null,sourceUrl:bootstrapUrl,providerPlayerId:player.id});
  }
 }
 return{providerId:String(matches[0].id),availability:reports,reason:`官方 FPL 球员状态，已绑定有序主客队及精确开球；不是俱乐部完整医学或纪律名单。${skipped.length} 条无有效近三天消息的状态未采用；报道时间不是伤病发生时间。`};
}
function japaneseLineup(html,event,fixture){
 check(discovery.match(event,[fixture]).status==='matched','JP_LINEUP_FIXTURE');
 const clubs=discovery.officialNames(event),league=fixture.league;
 check(['j1','j2'].includes(league)&&new RegExp('^https://www\\.jleague\\.jp/match/'+league+'/\\d{4}/\\d{6}/$').test(fixture.url),'JP_LINEUP_URL');
 check(fixture.providerId===fixture.url.match(/\/(\d{4})\/(\d{6})\/$/).slice(1).join(''),'JP_LINEUP_PROVIDER');
 const objects=parser.flightObjects(html),records=objects.filter(row=>row.date&&row.tournament===league&&row.homeTeam?.teamId&&row.awayTeam?.teamId);
 check(records.length===1,'JP_LINEUP_RECORD');const record=records[0];
 check([record.homeTeam,record.awayTeam].every((team,side)=>team.code===clubs[side][3]&&team.name===clubs[side][2]),'JP_LINEUP_TEAMS');
 const actual=Date.parse(record.date.replace(/^\$D/,'')),scheduled=Date.parse(event.kickoff);
 check(actual===scheduled||(record.type==='post-game'&&actual>=scheduled&&actual-scheduled<=30*60000),'JP_LINEUP_CLOCK');
 const groups=objects.filter(row=>Array.isArray(row.formations)&&row.isExpected===false);
 check(groups.length===1,'JP_LINEUP_UNCONFIRMED');const starts=groups[0].formations.filter(row=>row.matchTime==='前半0分');check(starts.length===1,'JP_LINEUP_START');
 const teams=[starts[0].homeTeam,starts[0].awayTeam];
 check(teams.every((team,side)=>team.teamName===clubs[side][2]&&Array.isArray(team.players)&&team.players.length===11&&new Set(team.players.map(player=>player.id)).size===11&&team.players.every(player=>Number.isSafeInteger(player.id)&&typeof player.name==='string'&&player.name.trim())),'JP_LINEUP_ELEVEN');
 check(new Set(teams.flatMap(team=>team.players.map(player=>player.id))).size===22,'JP_LINEUP_CROSS_TEAM');
 return{status:'confirmed',scheduledKickoff:event.kickoff,actualKickoff:new Date(actual).toISOString(),teams:teams.map((team,side)=>({name:side?event.awayTeamName:event.homeTeamName,formation:team.formation,players:team.players.map(player=>({name:player.name,number:player.playerNumber}))}))};
}
module.exports={premierLeague,japaneseLineup,bootstrapUrl,fixturesUrl};
