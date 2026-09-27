'use strict';
const {text,number,integer,id,instant,norm,identity,leagueFor,hash} = require('./core.cjs');
const requireArray=(v,max=2500)=>{if(!Array.isArray(v)||v.length>max)throw new Error('invalid-source-array');return v;};
function team(v,kind) {
  const key=id(kind==='olg'?v?.teamId:v?.id),name=text(kind==='olg'?v?.teamName:v?.name);
  if(!key||!name)throw new Error('invalid-team');
  return {id:key,name,names:[name,text(kind==='olg'?v?.shortName:v?.shortName)].filter(Boolean)};
}
function footballData(body,job) {
  if(body?.errorCode||body?.message&& !body?.matches&&!body?.standings)throw new Error('source-api-error');
  if(body?.competition?.code!==job.competition)throw new Error('competition-mismatch');
  if(job.kind==='standings'){
    const rows=requireArray(body.standings).filter(s=>s.type==='TOTAL').flatMap(s=>requireArray(s.table).map(r=>({team:team(r.team),position:integer(r.position),played:integer(r.playedGames),points:integer(r.points),won:integer(r.won),drawn:integer(r.draw),lost:integer(r.lost)})));
    if(rows.some(r=>r.position===null||r.played===null||r.points===null))throw new Error('invalid-standings');
    return {kind:'standings',competition:job.competition,rows};
  }
  let rejected=0;
  const rows=requireArray(body.matches).flatMap(r=>{
    try{
      const home=team(r.homeTeam),away=team(r.awayTeam),kickoff=instant(r.utcDate);
      if(!id(r.id)||kickoff===null||home.id===away.id||r.competition?.code!==job.competition)throw new Error('identity');
      const score=r.score?.duration==='REGULAR'?r.score.fullTime:r.score?.regularTime;
      const validScore=r.status==='FINISHED'&&integer(score?.home)!==null&&integer(score?.away)!==null;
      return [{id:id(r.id),home,away,kickoff:new Date(kickoff).toISOString(),status:r.status,score:validScore?{home:score.home,away:score.away}:null,regulation:validScore,sourceUpdatedAt:instant(r.lastUpdated)===null?null:r.lastUpdated}];
    }catch{rejected++;return [];}
  });
  if(body.matches.length&&!rows.length)throw new Error('no-valid-fixtures');
  return {kind:'matches',competition:job.competition,rows,rejected};
}
function openLiga(body,job) {
  let rejected=0;
  const rows=requireArray(body).flatMap(r=>{
    try{
      const home=team(r.team1,'olg'),away=team(r.team2,'olg');
      const utc=typeof r.matchDateTimeUTC==='string'&&!/(Z|[+-]\d{2}:\d{2})$/.test(r.matchDateTimeUTC)?r.matchDateTimeUTC+'Z':r.matchDateTimeUTC;
      const kickoff=instant(utc);
      if(!id(r.matchID)||home.id===away.id||kickoff===null||r.leagueShortcut!==job.competition||String(r.leagueSeason)!==String(job.season))throw new Error('identity');
      const end=requireArray(r.matchResults||[],20).filter(s=>s.resultTypeID===2);
      const validScore=r.matchIsFinished===true&&end.length===1&&integer(end[0].pointsTeam1)!==null&&integer(end[0].pointsTeam2)!==null;
      return [{id:id(r.matchID),home,away,kickoff:new Date(kickoff).toISOString(),status:r.matchIsFinished?'FINISHED':'SCHEDULED',score:validScore?{home:end[0].pointsTeam1,away:end[0].pointsTeam2}:null,regulation:validScore,sourceUpdatedAt:null}];
    }catch{rejected++;return [];}
  });
  if(body.length&&!rows.length)throw new Error('no-valid-fixtures');
  return {kind:'matches',competition:job.competition,rows,rejected};
}
function metNorway(body,job,receivedAt) {
  const coords=body?.geometry?.coordinates,meta=body?.properties?.meta,units=meta?.units,updated=instant(meta?.updated_at);
  if(body?.type!=='Feature'||!Array.isArray(coords)||Math.abs(coords[0]-job.lon)>.001||Math.abs(coords[1]-job.lat)>.001||updated===null||updated>receivedAt)throw new Error('weather-identity-or-clock');
  if(units?.air_temperature!=='celsius'||units?.wind_speed!=='m/s')throw new Error('unsupported-weather-units');
  const rows=requireArray(body.properties.timeseries,400).flatMap(r=>{
    const ms=instant(r.time),v=r.data?.instant?.details;
    if(ms===null||number(v?.air_temperature)===null||number(v?.wind_speed)===null||v.wind_speed<0)return [];
    const hour=r.data?.next_1_hours;
    return [{forecastAt:r.time,temperatureC:v.air_temperature,windKph:v.wind_speed*3.6,
      precipitationMm:units.precipitation_amount==='mm'?number(hour?.details?.precipitation_amount):null,
      condition:text(hour?.summary?.symbol_code)||null}];
  });
  if(!rows.length)throw new Error('weather-timeseries-empty');
  return {kind:'weather',lat:job.lat,lon:job.lon,sourceUpdatedAt:meta.updated_at,rows};
}
function parse(body,job,now){
  if(job.provider==='football-data.org')return footballData(body,job);
  if(job.provider==='openligadb')return openLiga(body,job);
  if(job.provider==='met-norway')return metNorway(body,job,now);
  throw new Error('unsupported-provider');
}
// Only exact full-name aliases are accepted. No suffix stripping or fuzzy
// matching that could confuse senior, reserve, women's or youth teams.
function sameTeam(m,side,providerTeam,provider,aliases={}) {
  const siteNames=[m[side+'TeamName'],m[side+'TeamNameEn']].filter(v=>text(v));
  const approved=aliases[provider]||{};
  const keys=siteNames.flatMap(n=>[n,...(Array.isArray(approved[n])?approved[n]:[])]).map(norm);
  return providerTeam.names.some(n=>keys.includes(norm(n)));
}
function bindFixture(m,doc,provider,aliases) {
  if(!identity(m))return null;
  const found=doc.rows.filter(r=>instant(r.kickoff)===instant(m.kickoffTime)&&sameTeam(m,'home',r.home,provider,aliases)&&sameTeam(m,'away',r.away,provider,aliases));
  return found.length===1?found[0]:null;
}
function recentForm(rows,teamId,before) {
  const unique=new Map();
  for(const r of rows){
    if(!r.regulation||!r.score||instant(r.kickoff)>=before||![r.home.id,r.away.id].includes(teamId))continue;
    if(unique.has(r.id)&&hash(unique.get(r.id))!==hash(r)){unique.set(r.id,null);continue;}
    if(!unique.has(r.id))unique.set(r.id,r);
  }
  const matches=[...unique.values()].filter(Boolean).sort((a,b)=>instant(b.kickoff)-instant(a.kickoff)).slice(0,10);
  const results=matches.map(r=>{const home=r.home.id===teamId,gf=home?r.score.home:r.score.away,ga=home?r.score.away:r.score.home;return {date:r.kickoff,home,opponent:home?r.away.name:r.home.name,goalsFor:gf,goalsAgainst:ga,result:gf>ga?'W':gf<ga?'L':'D'};});
  const n=results.length;
  return {sampleSize:n,goalsForAvg:n?results.reduce((s,r)=>s+r.goalsFor,0)/n:null,goalsAgainstAvg:n?results.reduce((s,r)=>s+r.goalsAgainst,0)/n:null,rows:results};
}
function resolveFacts(match,caches,now,{aliases={},venueBindings=[]}={}) {
  const ident=identity(match);if(!ident)return {status:'identity-conflict',fields:{}};
  const league=leagueFor(match),fields={},gaps=[];
  const fresh=c=>instant(c.receivedAt)!==null&&instant(c.receivedAt)<=now&&instant(c.expiresAt)>now;
  const put=(key,data,c)=>{fields[key]={status:'available',provider:c.provider,observedAt:c.receivedAt,checkedAt:c.checkedAt||c.receivedAt,expiresAt:c.expiresAt,rawHash:c.rawHash,attribution:c.attribution,predictionEligible:false,data};};
  const sources=caches.filter(c=>c.value?.kind==='matches'&&((c.provider==='football-data.org'&&c.value.competition===league?.code)||(c.provider==='openligadb'&&c.value.competition===league?.olg)))
    .sort((a,b)=>Number(b.provider==='football-data.org')-Number(a.provider==='football-data.org'));
  const matches=[];
  for(const c of sources){
    if(!fresh(c))continue;
    const bound=bindFixture(match,c.value,c.provider,aliases);if(!bound)continue;
    matches.push({bound,c});
    if(!fields.fixture)put('fixture',{providerMatchId:bound.id,home:bound.home.name,away:bound.away.name,kickoff:bound.kickoff,status:bound.status,referenceOnly:true},c);
    if(!fields.form){const home=recentForm(c.value.rows,bound.home.id,instant(match.kickoffTime)),away=recentForm(c.value.rows,bound.away.id,instant(match.kickoffTime));if(home.sampleSize||away.sampleSize)put('form',{home,away},c);}
    if(!fields.standings){
      const table=caches.find(t=>t.provider===c.provider&&t.value?.kind==='standings'&&t.value.competition===c.value.competition&&fresh(t));
      if(table){const h=table.value.rows.filter(r=>r.team.id===bound.home.id),a=table.value.rows.filter(r=>r.team.id===bound.away.id);if(h.length===1&&a.length===1)put('standings',{home:h[0],away:a[0]},table);}
    }
  }
  if(matches.length>1&&matches.some(v=>v.bound.status==='FINISHED'&&v.bound.score)&&new Set(matches.filter(v=>v.bound.score).map(v=>JSON.stringify(v.bound.score))).size>1)gaps.push('reference-result-conflict');
  const venues=venueBindings.filter(v=>v.matchId===match.id&&instant(v.eventVersion)===instant(ident.eventVersion)&&v.verified===true);
  if(venues.length===1){const v=venues[0],weather=caches.filter(c=>c.provider==='met-norway'&&c.value?.kind==='weather'&&Math.abs(c.value.lat-v.lat)<.0001&&Math.abs(c.value.lon-v.lon)<.0001&&fresh(c)).sort((a,b)=>instant(b.receivedAt)-instant(a.receivedAt))[0];
    if(weather){const row=weather.value.rows.filter(r=>Math.abs(instant(r.forecastAt)-instant(match.kickoffTime))<=3600000).sort((a,b)=>Math.abs(instant(a.forecastAt)-instant(match.kickoffTime))-Math.abs(instant(b.forecastAt)-instant(match.kickoffTime)))[0];if(row)put('weather',{...row,sourceUpdatedAt:weather.value.sourceUpdatedAt,venueLabel:text(v.label)||null},weather);}}
  for(const key of ['fixture','form','standings','weather'])if(!fields[key])fields[key]={status:key==='weather'&&venues.length!==1?'venue-unverified':!league&&key!=='weather'?'unsupported-league':sources.length&&!sources.some(fresh)?'stale':'awaiting-source-or-mapping',data:null,predictionEligible:false};
  return {version:'football-source-evidence-v1',identity:ident,status:Object.values(fields).some(f=>f.data)?'partial-or-available':'missing',generatedAt:new Date(now).toISOString(),predictionEligible:false,fields,gaps};
}
module.exports={parse,footballData,openLiga,metNorway,sameTeam,bindFixture,recentForm,resolveFacts};
