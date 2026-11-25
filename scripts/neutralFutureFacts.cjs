'use strict';
const path=require('node:path'),storage=require('./neutralCollectionStore.cjs'),mapping=require('./neutralSportsTeamMap.cjs'),collector=require('./collectFootballDataOrgResearch.cjs'),history=require('./footballDataOrgNeutralView.cjs').teamHistory;
const ttl={standing:86400000,history:86400000,availability:21600000,lineup:7200000,fixture:7200000};
function orgFields(event,index,store,now){
 const mapped=mapping.resolve(event);if(!mapped)return{fields:{},gaps:['免费统计接口尚无精确球队映射或不覆盖该联赛。']};
 const league=index?.leagues?.[mapped.code],fields={},gaps=[];let matches,matchReference;
 const read=reference=>{if(!reference||!/^\d+-[a-f0-9]{24}$/.test(reference.observation)||!/^\d{3}\.body$/.test(reference.receipt?.rawName))throw Error('STATISTIC_REFERENCE');if(Date.parse(reference.receipt.receivedAt)>now)throw Error('STATISTIC_CLOCK');return storage.verified(path.join(store,'research/football-data-org/observations',reference.observation,reference.receipt.rawName),reference.receipt.sha256);};
 try{
  matchReference=league?.fields.matches;matches=collector.inspectMatches(read(matchReference),mapped.code,matchReference.season,Date.parse(matchReference.receipt.receivedAt),event.businessDate);
  const exact=matches.rows.filter(row=>row.homeTeam.id===mapped.teams[0][2]&&row.awayTeam.id===mapped.teams[1][2]&&row.homeTeam.name===mapped.teams[0][3]&&row.awayTeam.name===mapped.teams[1][3]&&Date.parse(row.utcDate)===Date.parse(event.kickoff));
  if(exact.length!==1)throw Error('STATISTIC_FIXTURE_CONFLICT');
  const names=new Map(matches.rows.flatMap(row=>[[row.homeTeam.id,row.homeTeam.name],[row.awayTeam.id,row.awayTeam.name]]));
  for(const [side,team] of mapped.teams.entries()){
   const value=history(matches,team[2],event.kickoff);fields['history'+side]={value:{scope:value.scope,lastFiveComplete:value.complete,lastFive:value.slots.map(row=>row.missing?{missing:true,kickoff:row.kickoff}:{kickoff:row.kickoff,home:names.get(row.orderedProviderTeamIds[0]),away:names.get(row.orderedProviderTeamIds[1]),score:row.score})},complete:value.complete,observedAt:matchReference.receipt.receivedAt,sources:[matchReference.receipt],retained:league.lastAttemptStatus==='blocked',failure:league.reason||undefined};
  }
 }catch(error){return{fields:{},gaps:[error.message==='STATISTIC_FIXTURE_CONFLICT'?'免费接口主客队或开球冲突，未合并。':'免费接口赛程与近况暂不可核验。']};}
 try{
  const reference=league.fields.standing;if(reference.season.id!==matchReference.season.id)throw Error('SEASON_CONFLICT');
  const standings=collector.inspectStandings(read(reference),mapped.code,reference.season);
  for(const [side,team] of mapped.teams.entries()){const row=standings.find(item=>item.providerTeamId===team[2]&&item.name===team[3]);if(!row)throw Error('STANDING_TEAM');fields['standing'+side]={value:row,complete:true,observedAt:reference.receipt.receivedAt,sources:[reference.receipt],retained:league.lastAttemptStatus==='blocked',failure:league.reason||undefined};}
 }catch{gaps.push('积分本轮未取得或赛季不一致，保留已核验字段及原时间。');}
 return{fields,gaps};
}
function project(row,now){
 const evidence=[],sources=[],teams=[row.event.homeTeamName,row.event.awayTeamName].map(name=>({name,standing:null,lastFive:[],lastFiveComplete:false,scope:'尚未取得完整近况'}));
 const official={status:'partial',reason:row.gaps.join('；'),sources:[],availability:[]};
 for(const [key,field] of Object.entries(row.fields)){
  const category=key.replace(/[01]$/,''),age=now-Date.parse(field.observedAt);if(age<0||!Number.isFinite(age))continue;
  const archived=Date.parse(row.event.kickoff)<=now&&Date.parse(field.observedAt)<=Date.parse(row.event.kickoff),state=archived?'archived':age>(ttl[category]||7200000)?'stale':field.retained?'retained':field.complete===false?'partial':'available';
  evidence.push({field:key,state,observedAt:field.observedAt,lastAttemptStatus:field.lastAttemptStatus||'available'});sources.push(...field.sources);
  if(category==='standing')teams[Number(key.at(-1))].standing=field.value;
  if(category==='history')Object.assign(teams[Number(key.at(-1))],field.value);
  if(category==='availability')official.availability=field.value;
  if(category==='lineup')official.lineup=field.value;
 }
 return{version:'neutral-match-sports-v1',eventId:row.event.eventId,businessDate:row.event.businessDate,kickoff:row.event.kickoff,names:[row.event.homeTeamName,row.event.awayTeamName],checkedAt:new Date(now).toISOString(),predictionEligible:false,identitySource:'signed-discovery',identityObservedAt:row.identityObservedAt,statistics:{status:evidence.length?'partial':'missing',teams,sources:[...new Map(sources.map(source=>[source.url+'|'+source.sha256,source])).values()]},official,collection:{discoveredAt:row.discoveredAt,lastAttemptAt:row.lastAttemptAt,evidence,gaps:row.gaps},limitations:['字段标为留存或过期时，不代表当前资料；原采集时间不刷新。','联赛近五场不等于全赛事近五场；单一来源不是双源验证。','本模块不生成、修改或发布推荐。']};
}
function read(event,{store='/var/lib/football-data-org',now=Date.now()}={}){
 const value=storage.load(store,'future-facts'),row=value?.events?.find(item=>storage.identity(item.event)===storage.identity(event));return row?project(row,now):null;
}
module.exports={orgFields,project,read,ttl};
