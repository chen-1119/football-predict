'use strict';
const check = (condition, code) => { if (!condition) throw Object.assign(Error(code), { code }); };
const text = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&#x([0-9a-f]+);/gi,(_,hex)=>String.fromCodePoint(parseInt(hex,16))).replace(/&#(\d+);/g,(_,number)=>String.fromCodePoint(Number(number))).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
function flightObjects(html) {
  const chunks = [];
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1]; if (!body.startsWith('self.__next_f.push(') || !body.endsWith(')')) continue;
    const value = JSON.parse(body.slice(19,-1)); if (value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1]);
  }
  check(chunks.length > 0 && chunks.length < 512,'JLEAGUE_FLIGHT');
  const objects = [];
  function visit(value, depth) { check(depth < 128,'JLEAGUE_DEPTH'); if (!value || typeof value !== 'object') return; objects.push(value); for (const [key,child] of Object.entries(value)) if (key !== 'messages') visit(child,depth+1); }
  for (const line of chunks.join('').split('\n')) { const body=line.slice(line.indexOf(':')+1); if (!['[','{'].includes(body[0])) continue; let value; try { value=JSON.parse(body); } catch { continue; } visit(value,0); }
  return objects;
}
function japanese(html,event,teamIds) {
  const objects=flightObjects(html), records=objects.filter(row=>row.date&&row.homeTeam?.teamId&&row.awayTeam?.teamId&&row.tournament==='j1');
  check(records.length===1,'JLEAGUE_IDENTITY');const record=records[0];
  check(record.date.slice(2)===event.kickoff&&record.homeTeam.teamId===teamIds[0]&&record.awayTeam.teamId===teamIds[1],'JLEAGUE_EVENT');
  const formations=objects.filter(row=>Array.isArray(row.formations)).flatMap(row=>row.formations).filter(row=>row.matchTime==='前半0分');
  if(formations.length!==1)return{status:'partial',reason:'已核对官方赛程，尚无可核验首发。'};
  const lineup=formations[0],teams=[lineup.homeTeam,lineup.awayTeam];
  check(teams[0].teamName===record.homeTeam.name&&teams[1].teamName===record.awayTeam.name,'JLEAGUE_LINEUP_TEAMS');
  check(teams.every(team=>Array.isArray(team.players)&&team.players.length===11&&new Set(team.players.map(player=>player.id)).size===11),'JLEAGUE_ELEVEN');
  return{status:'partial',reason:'官方首发已采集；积分、完整近五场及伤停仍待补充。',lineup:{status:'confirmed',teams:teams.map((team,index)=>({name:event.names[index],formation:team.formation,players:team.players.map(player=>({name:player.name,number:player.playerNumber}))}))}};
}
function korean(standings,schedules,event,teamIds,now) {
  check(String(standings.resultCode)==='200'&&Array.isArray(standings.data?.teamRank),'KLEAGUE_STANDINGS');
  check(String(standings.data.year)===event.businessDate.slice(0,4),'KLEAGUE_STANDINGS_YEAR');
  const rows=schedules.flatMap(schedule=>{check(String(schedule.resultCode)==='200'&&Array.isArray(schedule.data?.scheduleList),'KLEAGUE_SCHEDULE');return schedule.data.scheduleList;});
  check(rows.every(row=>String(row.gameDate).startsWith(event.businessDate.slice(0,4))&&String(row.year)===event.businessDate.slice(0,4)&&String(row.leagueId)==='1'),'KLEAGUE_SEASON');
  check(new Set(rows.map(row=>[row.gameDate,row.gameTime,row.homeTeam,row.awayTeam].join('|'))).size===rows.length,'KLEAGUE_DUPLICATE');
  const kickoff=row=>new Date(String(row.gameDate).replaceAll('.','-')+'T'+row.gameTime+(String(row.gameTime).length===5?':00':'')+'+09:00').toISOString();
  check(rows.filter(row=>row.homeTeam===teamIds[0]&&row.awayTeam===teamIds[1]&&kickoff(row)===event.kickoff).length===1,'KLEAGUE_EVENT');
  const names=new Map(rows.flatMap(row=>[[row.homeTeam,row.homeTeamName||row.homeTeam],[row.awayTeam,row.awayTeamName||row.awayTeam]]));
  for (const club of schedules.flatMap(schedule=>schedule.data.clubList||[])) names.set(club.teamId,club.teamNameFull||club.teamName);
  return{status:'partial',reason:'官方赛程、积分与近期联赛赛果已采集；伤停、停赛、首发未核实。',teams:teamIds.map((teamId,index)=>{
    const ranks=standings.data.teamRank.filter(row=>row.teamId===teamId);check(ranks.length===1,'KLEAGUE_TEAM_RANK');const rank=ranks[0];
    check([rank.rank,rank.gainPoint,rank.gameCount].every(Number.isInteger),'KLEAGUE_RANK_VALUES');
    const latest=rows.filter(row=>(row.homeTeam===teamId||row.awayTeam===teamId)&&Date.parse(kickoff(row))<Date.parse(event.kickoff)&&Date.parse(kickoff(row))+100*60000<now&&row.endYn==='Y'&&row.gameStatus==='FE').sort((left,right)=>Date.parse(kickoff(right))-Date.parse(kickoff(left))).slice(0,5);
    const lastFive=latest.map(row=>({kickoff:kickoff(row),home:names.get(row.homeTeam),away:names.get(row.awayTeam),...([row.homeGoal,row.awayGoal].every(value=>Number.isInteger(value)&&value>=0)?{score:[row.homeGoal,row.awayGoal]}:{missing:true})}));
    return{name:event.names[index],standing:{rank:rank.rank,points:rank.gainPoint,played:rank.gameCount},scope:'官方近三个月本联赛已结束场次；非跨赛事全量近况',lastFiveComplete:lastFive.length===5&&lastFive.every(row=>!row.missing),lastFive};
  })};
}
function norwegian(table,event,clubs=['Bodø/Glimt','Vålerenga']) {
  check(text(table).includes('Spilt')&&text(table).includes('Poeng'),'NORWAY_TABLE_HEADER');
  const rows=[...table.matchAll(/<tr\s+class="table__row"[^>]*>([\s\S]*?)<\/tr>/g)].map(match=>[...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell=>cell[1]));
  check(rows.length===16,'NORWAY_TABLE_COUNT');
  return{status:'partial',reason:'联赛官方积分已采集；赛果近况、伤停及首发未核实。',teams:clubs.map((name,index)=>{
    const matches=rows.filter(cells=>text(cells[1]).split(' ').join('')===name+name);check(matches.length===1,'NORWAY_TEAM');const cells=matches[0];
    const [rank,played,won,draw,lost,points]=[0,2,3,4,5,9].map(position=>Number(text(cells[position])));check([rank,played,won,draw,lost,points].every(Number.isInteger)&&played===won+draw+lost,'NORWAY_TABLE_VALUES');
    return{name:event.names[index],standing:{rank,points,played},scope:'联赛官方积分；近况未完整采集',lastFiveComplete:false,lastFive:[]};
  })};
}
function australian(html,event) {
  const records=[...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match=>JSON.parse(match[1])).filter(row=>row['@type']==='SportsEvent');
  check(records.length===1,'AUSTRALIA_EVENT_COUNT');const record=records[0];
  check(record.homeTeam?.name==='Melbourne Victory'&&record.awayTeam?.name==='Melbourne City FC'&&new Date(record.startDate).toISOString()===event.kickoff,'AUSTRALIA_EVENT_IDENTITY');
  return{status:'partial',reason:'A-Leagues 官方主客队、球场及开球已核对；积分和完整近况尚未取得。'};
}
function cityAvailability(html,now) {
  const body=text(html);check(body.includes('ALM Matchweek 2 Squad v Melbourne Victory'),'CITY_ARTICLE_SCOPE');
  const published=html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1];check(Number.isFinite(Date.parse(published))&&Date.parse(published)<=now&&now-Date.parse(published)<=72*3600000,'NEWS_PUBLICATION_CLOCK');
  const section=body.slice(body.indexOf('ALM Matchweek 2 Squad v Melbourne Victory'),body.indexOf('ALW Matchweek',body.indexOf('ALM Matchweek 2 Squad v Melbourne Victory'))>0?body.indexOf('ALW Matchweek',body.indexOf('ALM Matchweek 2 Squad v Melbourne Victory')):undefined);
  const players=[['Matheus ROSSETTO','calf','小腿'],['Ben MAZZEO','ankle','踝部'],['Alessandro LOPANE','hamstring','腿后肌'],['Ryan KALMS','knee','膝部']];
  return players.map(([name,reason,label])=>{check(section.includes(name+' ('+reason+')'),'CITY_UNAVAILABLE_PLAYER');return{team:'墨尔本城',name,status:'官方报道缺阵',reason:label+'伤情',publishedAt:new Date(published).toISOString(),sourceUrl:'https://melbournecityfc.com.au/news/20261022-team-news/'};});
}
function japaneseTable(html,event,clubs,league='j1') {
  check(['j1','j2'].includes(league),'JLEAGUE_TABLE_LEAGUE');
  const lists=flightObjects(html).filter(row=>row.leagueName===league&&Array.isArray(row.standingList));check(lists.length===1&&lists[0].standingList.length===20,'JLEAGUE_TABLE');
  const year=Number(event.businessDate.slice(0,4)),season=year+'_'+String(year+1).slice(2);
  check(lists[0].standingList.every(row=>row.club?.emblemVisual?.webp?.year===season),'JLEAGUE_TABLE_SEASON');
  return clubs.map((club,index)=>{const rows=lists[0].standingList.filter(row=>row.club.href==='/club/'+club);check(rows.length===1,'JLEAGUE_TABLE_TEAM');const row=rows[0];
    check([row.ranking.value,row.point,row.match,row.win,row.draw,row.loss].every(Number.isInteger)&&row.match===row.win+row.draw+row.loss&&row.point===row.win*3+row.draw,'JLEAGUE_TABLE_VALUES');
    return{name:event.names[index],standing:{rank:row.ranking.value,points:row.point,played:row.match},scope:league.toUpperCase()+' 官方积分；近五场逐场比分尚未完整采集',lastFiveComplete:false,lastFive:[]};});
}
function australianTable(html,event,clubs=['Melbourne Victory MVC','Melbourne City FC MCY']) {
  const year=Number(event.businessDate.slice(0,4));check(text(html).includes('A-League Men '+year+'/'+(year+1)),'AUSTRALIA_TABLE_SEASON');
  const tables=[...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)];check(tables.length===2,'AUSTRALIA_TABLE_COUNT');
  const rows=tables.map(table=>[...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(row=>[...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell=>text(cell[1]))).filter(row=>row.length));
  check(rows.every(table=>table.length===12)&&rows[0].every((row,index)=>Number(row[0])===index+1),'AUSTRALIA_TABLE_ROWS');
  return clubs.map((name,index)=>{const found=rows[0].map((row,position)=>({row,position})).filter(item=>item.row[1]===name);check(found.length===1,'AUSTRALIA_TABLE_TEAM');const position=found[0].position,values=rows[1][position];
    const [played,won,draw,lost]=values.slice(0,4).map(Number),points=Number(values[7]);check([played,won,draw,lost,points].every(Number.isInteger)&&played===won+draw+lost&&points===won*3+draw,'AUSTRALIA_TABLE_VALUES');
    return{name:event.names[index],standing:{rank:position+1,points,played},scope:'A-League Men 官方积分；完整跨赛季近况尚未采集',lastFiveComplete:false,lastFive:[]};});
}
function spursAvailability(html,now) {
  const body=text(html),published=html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1];
  check(Number.isFinite(Date.parse(published))&&Date.parse(published)<=now&&now-Date.parse(published)<=72*3600000,'NEWS_PUBLICATION_CLOCK');
  check(body.includes('four out of Chelsea clash')&&body.includes('Lucas Bergvall, Savio and Destiny Udogie remain sidelined')&&body.includes('Rodrigo Bentancur serves the second match of his ban'),'SPURS_NEWS_SCOPE');
  return ['Lucas Bergvall','Savio','Destiny Udogie','Rodrigo Bentancur'].map((name,index)=>({team:'托特纳姆热刺',name,status:index===3?'官方报道停赛':'官方报道缺阵',reason:index===3?'红牌停赛的第二场':'俱乐部确认仍无法出场；不推断具体伤情',publishedAt:new Date(published).toISOString(),sourceUrl:'https://www.tottenhamhotspur.com/news/1180250/team-news-porro-back-four-out-of-chelsea-clash'}));
}
function lensAvailability(html,now) {
  const body=text(html),publishedAt='2026-10-23';
  check(body.includes('RC Lens-Paris FC')&&/Publié le\s+23\/10\/2026\s+à\s+14:54/.test(body),'LENS_ARTICLE_SCOPE');
  check(now>=Date.parse(publishedAt+'T23:59:59Z')&&now-Date.parse(publishedAt+'T00:00:00Z')<=72*3600000,'NEWS_PUBLICATION_CLOCK');
  check(['Ismaelo Ganiou','Abdallah Sima','Maik Nawrocki','Jonathan Gradit','infirmerie','opération','absent quelques semaines','évaluer son état de forme'].every(value=>body.includes(value)),'LENS_AVAILABILITY_SCOPE');
  return ['Ismaelo Ganiou','Abdallah Sima','Maik Nawrocki','Jonathan Gradit'].map((name,index)=>({team:'朗斯',name,status:index===0?'官方报道缺阵':index===3?'恢复合练，出场待评估':'官方报道伤病',reason:index===0?'将接受手术，预计缺阵数周':index===3?'已恢复合练，仍需评估，不等于确认复出':'处于俱乐部伤病名单；未推断具体伤势',publishedAt,sourceUrl:'https://www.rclens.fr/fr/conference-de-presse-rclens-parisfc-ligue1-cahuzac-sotoca-20261023'}));
}
module.exports={flightObjects,japanese,korean,norwegian,australian,cityAvailability,japaneseTable,australianTable,spursAvailability,lensAvailability};
