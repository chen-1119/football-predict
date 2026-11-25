'use strict';
const parser=require('./neutralOfficialSportsParser.cjs');
function japanese(html,league){
 const candidates=parser.flightObjects(html).filter(row=>row.detailHref&&row.homeTeam?.fullName&&row.awayTeam?.fullName),rows=new Map();
 for(const row of candidates){
  if(!new RegExp('^/match/'+league+'/\\d{4}/\\d{6}/?$').test(row.detailHref)||!/^\d{10}$/.test(row.id)||!/^\d{2}:\d{2}$/.test(row.time))continue;
  const day=row.id.slice(0,4)+'-'+row.id.slice(4,6)+'-'+row.id.slice(6,8),kickoff=new Date(day+'T'+row.time+':00+09:00').toISOString();
  const value={provider:'jleague',league,providerId:row.id,names:[row.homeTeam.fullName,row.awayTeam.fullName],kickoff,url:'https://www.jleague.jp'+row.detailHref.replace(/\/$/,'')+'/'};
  if(rows.has(row.id)&&JSON.stringify(rows.get(row.id))!==JSON.stringify(value))throw Error('DISCOVERY_DUPLICATE');rows.set(row.id,value);
 }
 if(!rows.size)throw Error('DISCOVERY_EMPTY');return[...rows.values()];
}
function zonedInstant(value,zone){
 if(!/^\d{8}T\d{6}$/.test(value))throw Error('CALENDAR_TIME');
 const numbers=[Number(value.slice(0,4)),Number(value.slice(4,6)),Number(value.slice(6,8)),Number(value.slice(9,11)),Number(value.slice(11,13)),Number(value.slice(13,15))],base=Date.UTC(numbers[0],numbers[1]-1,...numbers.slice(2));
 const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const match=stamp=>{const parts=Object.fromEntries(formatter.formatToParts(new Date(stamp)).map(row=>[row.type,row.value]));return [parts.year,parts.month,parts.day,parts.hour,parts.minute,parts.second].map(Number).every((part,index)=>part===numbers[index]);};
 const candidates=[];for(let offset=-14;offset<=14;offset++)if(match(base+offset*3600000))candidates.push(base+offset*3600000);
 if(candidates.length!==1)throw Error('CALENDAR_AMBIGUOUS_TIME');return new Date(candidates[0]).toISOString();
}
function norwegian(calendar){
 if(!calendar.startsWith('BEGIN:VCALENDAR'))throw Error('CALENDAR_FORMAT');
 const records=[...calendar.replace(/\r?\n[ \t]/g,'').matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)],rows=[];
 for(const record of records){const lines=record[1].split(/\r?\n/),summary=lines.find(line=>line.startsWith('SUMMARY:'))?.slice(8),id=lines.find(line=>line.startsWith('UID:'))?.slice(4),time=lines.find(line=>line.startsWith('DTSTART'));
  if(!id||!summary||!time)throw Error('CALENDAR_IDENTITY');const names=summary.split(' - ');if(names.length!==2)throw Error('CALENDAR_TEAMS');
  let kickoff;if(/^DTSTART:\d{8}T\d{6}Z$/.test(time))kickoff=zonedInstant(time.slice(8,-1),'UTC');else if(/^DTSTART;TZID=Europe\/Oslo:\d{8}T\d{6}$/.test(time))kickoff=zonedInstant(time.split(':')[1],'Europe/Oslo');else throw Error('CALENDAR_ZONE');
  rows.push({provider:'eliteserien',league:'NO1',providerId:id,names,kickoff,url:'https://www.eliteserien.no/terminliste'});
 }
 if(!rows.length||new Set(rows.map(row=>row.providerId)).size!==rows.length)throw Error('CALENDAR_DUPLICATE');return rows;
}
function windowRows(rows,now,horizonDays=7){return rows.filter(row=>Date.parse(row.kickoff)>now&&Date.parse(row.kickoff)<=now+horizonDays*86400000);}
function australian(body,now=Date.now(),horizonDays=7){
 const rows=JSON.parse(body);if(!Array.isArray(rows)||!rows.length||rows.length>4000)throw Error('AU_DISCOVERY_SHAPE');const found=new Map();
 for(const row of rows){
  if(!Number.isSafeInteger(row.startDate))throw Error('AU_DISCOVERY_DATE');
  if(row.startDate<=now||row.startDate>now+horizonDays*86400000)continue;
  if(row.competition?.id!=='xwnjb1az11zffwty3m6vn8y6'||row.competition.code!=='ALM')throw Error('AU_DISCOVERY_COMPETITION');
  if(!Number.isSafeInteger(row.startDate)||!row.homeTeam?.id||!row.awayTeam?.id||!row.homeTeam.officialName||!row.awayTeam.officialName||row.homeTeam.position!=='home'||row.awayTeam.position!=='away')throw Error('AU_DISCOVERY_IDENTITY');
  if(!row.id||row.homeTeam.id===row.awayTeam.id)throw Error('AU_DISCOVERY_IDENTITY');
  if(!Number.isSafeInteger(row.tournament?.startDate)||!Number.isSafeInteger(row.tournament?.endDate)||row.startDate<row.tournament.startDate||row.startDate>row.tournament.endDate)throw Error('AU_DISCOVERY_SEASON');
  const value={provider:'aleagues',league:'ALM',providerId:row.id,providerTeamIds:[row.homeTeam.id,row.awayTeam.id],names:[row.homeTeam.officialName,row.awayTeam.officialName],kickoff:new Date(row.startDate).toISOString(),url:'https://aleagues.com.au/matches/a-league-men/'};
  if(found.has(row.id))throw Error('AU_DISCOVERY_DUPLICATE');found.set(row.id,value);
 }return [...found.values()];
}
const clubs={
 '日本职业联赛':[[548,'东京FC','ＦＣ東京','ftokyo'],[1016,'水户蜀葵','水戸ホーリーホック','mito'],[553,'川崎前锋','川崎フロンターレ','kawasakif'],[1194,'冈山绿雉','ファジアーノ岡山','okayama']],
 '日本乙级联赛':[[546,'新潟天鹅','アルビレックス新潟','niigata'],[1078,'仙台七夕','ベガルタ仙台','sendai']],
 '挪威超级联赛':[[613,'维京','Viking'],[617,'特罗姆瑟','Tromsø']],
 '澳大利亚超级联赛':[[753,'悉尼FC','Sydney FC','Sydney FC SYD','38ui5tfi8anjuh533emny2tz1'],[1096,'阿德莱德联','Adelaide United FC','Adelaide United FC ADE','6lezh5aazy0xca1800e5dqxwl']],
};
function officialNames(event){const registry=clubs[event.leagueName]||[];const teams=[event.homeTeamId,event.awayTeamId].map((id,index)=>registry.find(row=>row[0]===id&&row[1]===(index?event.awayTeamName:event.homeTeamName)));return teams.every(Boolean)?teams:null;}
function match(event,rows){const teams=officialNames(event);if(!teams)return{status:'unmapped'};const league={'日本职业联赛':'j1','日本乙级联赛':'j2','挪威超级联赛':'NO1','澳大利亚超级联赛':'ALM'}[event.leagueName];const candidates=rows.filter(row=>row.league===league&&row.names[0]===teams[0][2]&&row.names[1]===teams[1][2]&&(league!=='ALM'||row.providerTeamIds?.[0]===teams[0][4]&&row.providerTeamIds?.[1]===teams[1][4]));const exact=candidates.filter(row=>row.kickoff===event.kickoff);return exact.length===1?{status:'matched',row:exact[0],teams}:{status:candidates.length?'conflict':'missing'};}
module.exports={japanese,norwegian,australian,zonedInstant,windowRows,officialNames,match};
