'use strict';
const {parse,LEAGUES}=require('./collectExpandedLeagueHistory.cjs');
const {hash,sha,seal}=require('../src/services/leagueBaselineModel.cjs');
const k=require('./syncKLeagueOfficialStandings.cjs');
const {day}=require('../src/services/publishedForecastPolicy.cjs');
const check=(ok,code)=>{if(!ok)throw Object.assign(Error('TEAM_EVIDENCE_'+code),{code:'TEAM_EVIDENCE_'+code});};
const VERSION='team-evidence-snapshot-v1';
const JSON_LEAGUES=['en.1','en.2','de.1','de.2','es.1','it.1','fr.1','fr.2','nl.1','pt.1','br.1','jp.1'];
const KR_URL='https://www.kleague.com/getScheduleList.do';
function plans(matches,asOf){
 check(Array.isArray(matches)&&matches.length<=512&&Number.isFinite(Date.parse(asOf)),'INPUT');
 const date=day(Date.parse(asOf)),year=+date.slice(0,4),month=+date.slice(5,7),result=[];
 const names=new Set(matches.filter(m=>m.businessDate===date).map(m=>m.leagueName||m.leagueAllName));
 for(const league of JSON_LEAGUES.filter(l=>names.has(LEAGUES[l]))){
  const calendar=['br.1','jp.1'].includes(league),start=calendar?year:year-(month<7?1:0);
  for(const y of [start-1,start]){const season=calendar?String(y):`${y}-${String((y+1)%100).padStart(2,'0')}`;
   result.push({id:`history-${league}-${season}`,kind:'history',league,season,intervalMs:86400000,method:'GET',
    url:`https://raw.githubusercontent.com/openfootball/football.json/master/${season}/${league}.json`});}
 }
 if(names.has(LEAGUES['kr.1'])){
  result.push({id:`kleague-standings-${year}`,kind:'standings',year,intervalMs:21600000,method:'POST',url:`https://www.kleague.com/record/teamRank.do?leagueId=1&year=${year}&stadium=all&recordType=rank`});
  for(let ago=2;ago>=0;ago--){const d=new Date(Date.UTC(year,month-1-ago,1)),y=d.getUTCFullYear(),m=String(d.getUTCMonth()+1).padStart(2,'0');
   result.push({id:`kleague-schedule-${y}-${m}`,kind:'schedule',year:y,month:m,intervalMs:21600000,method:'POST',url:KR_URL,
    body:JSON.stringify({leagueId:1,teamId:'',ticketStatus:'',year:y,month:m,ticketYn:''})});}
 }
 check(result.length<=32,'REQUEST_BOUND');return result;
}
function validPlan(plan){
 const y=plan.year||2026,synthetic=[{businessDate:`${y}-10-10`,leagueName:LEAGUES['kr.1']}];
 if(plan.kind==='history')return JSON_LEAGUES.includes(plan.league)&&/^20\d\d(?:-\d\d)?$/.test(plan.season||'')
  &&plan.method==='GET'&&!plan.body&&plan.id===`history-${plan.league}-${plan.season}`
  &&plan.url===`https://raw.githubusercontent.com/openfootball/football.json/master/${plan.season}/${plan.league}.json`;
 if(!Number.isSafeInteger(y)||y<2020||y>2100)return false;
 if(plan.kind==='standings')return plans(synthetic,`${y}-10-10T00:00:00Z`).some(p=>hash(p)===hash(plan));
 if(plan.kind==='schedule')return /^\d\d$/.test(plan.month||'')&&+plan.month>=1&&+plan.month<=12&&plan.method==='POST'
  &&plan.url===KR_URL&&plan.id===`kleague-schedule-${y}-${plan.month}`&&plan.body===JSON.stringify({leagueId:1,teamId:'',ticketStatus:'',year:y,month:plan.month,ticketYn:''});
 return false;
}
async function capture(plan,{fetchImpl=fetch,clock=()=>new Date().toISOString()}={}){
 check(validPlan(plan),'SOURCE_ALLOWLIST');const requestedAt=clock();
 const response=await fetchImpl(plan.url,{method:plan.method,body:plan.body,redirect:'error',signal:AbortSignal.timeout(12000),
  headers:{accept:'application/json','user-agent':'football-predict/team-evidence-v1',...(plan.body?{'content-type':'application/json;charset=UTF-8',referer:'https://www.kleague.com/schedule.do?leagueId=1'}:{})}});
 check(response.ok,'HTTP_'+response.status);check(Number(response.headers.get('content-length')||0)<=2*1024*1024,'RESPONSE_BOUND');
 const parts=[];let size=0;const reader=response.body.getReader();try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;check(size<=2*1024*1024,'RESPONSE_BOUND');parts.push(Buffer.from(r.value));}}finally{await reader.cancel().catch(()=>{});}
 const raw=Buffer.concat(parts),receivedAt=clock(),text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
 check(Date.parse(requestedAt)<=Date.parse(receivedAt)&&Date.parse(receivedAt)-Date.parse(requestedAt)<=20000,'HTTP_CLOCK');
 return pack(plan,{requestedAt,receivedAt,status:response.status,raw:text,rawSha256:sha(raw),bytes:raw.length});
}
function pack(plan,response){
 check(validPlan(plan)&&response.status===200&&typeof response.raw==='string'&&Buffer.byteLength(response.raw)===response.bytes
  &&response.bytes<=2*1024*1024&&sha(Buffer.from(response.raw))===response.rawSha256,'RAW_BINDING');
 check(Number.isFinite(Date.parse(response.requestedAt))&&Number.isFinite(Date.parse(response.receivedAt))&&Date.parse(response.requestedAt)<=Date.parse(response.receivedAt),'CLOCK');
 let summary;
 if(plan.kind==='history'){const p=parse(Buffer.from(response.raw),{league:plan.league,season:plan.season,knownAt:response.receivedAt});summary={rows:p.rows.length,excluded:p.excluded.length,lastResultDate:p.rows.map(r=>r.date).sort().at(-1)||null,license:'CC0-1.0',historicalKnownAt:null};}
 else{const p=JSON.parse(response.raw);check(String(p.resultCode)==='200','PROVIDER_STATUS');const rows=p.data?.[plan.kind==='standings'?'teamRank':'scheduleList'];
  check(Array.isArray(rows)&&rows.length>0&&rows.length<250,'PROVIDER_ROWS');
  check(rows.every(r=>r.year===plan.year&&(plan.kind==='standings'?typeof r.teamId==='string':r.leagueId===1&&String(r.gameDate).startsWith(`${plan.year}.${plan.month}.`))),'PROVIDER_SCOPE');
  if(plan.kind==='standings')check(new Set(rows.map(r=>r.teamId)).size===rows.length&&rows.every(r=>/^K\d+$/.test(r.teamId)
   &&Number.isInteger(r.rank)&&r.rank>=1&&r.rank<=32&&Number.isInteger(r.gainPoint)&&r.gainPoint>=-30&&r.gainPoint<=240
   &&Number.isInteger(r.gameCount)&&r.gameCount>=0&&r.gameCount<=80),'STANDING_VALUES');
  else check(new Set(rows.map(r=>r.gameId)).size===rows.length&&rows.every(r=>Number.isSafeInteger(r.gameId)&&r.gameId>0
   &&/^K\d+$/.test(r.homeTeam)&&/^K\d+$/.test(r.awayTeam)&&r.homeTeam!==r.awayTeam&&k.officialKickoffInstant(r)),'SCHEDULE_VALUES');
  summary={rows:rows.length,provider:'kleague',independentlyCorroborated:false};}
 return seal({version:VERSION,createdAt:response.receivedAt,sourceId:plan.id,plan,response,summary,formalEligible:false,probabilityUseApproved:false});
}
function verify(p){try{
 const {contentHash,licenseReceipt,...body}=p;
 if(p.plan.kind==='history')check(licenseReceipt?.url==='https://raw.githubusercontent.com/openfootball/football.json/master/LICENSE.md'
  &&licenseReceipt.sha256==='36ffd9dc085d529a7e60e1276d73ae5a030b020313e6c5408593a6ae2af39673'
  &&Date.parse(licenseReceipt.receivedAt)<=Date.parse(p.createdAt),'LICENSE_RECEIPT');
 else check(licenseReceipt===undefined,'UNEXPECTED_LICENSE');
 const reconstructed=pack(p.plan,p.response);delete reconstructed.contentHash;
 return contentHash===hash({...body,...(licenseReceipt?{licenseReceipt}:{})})&&hash(reconstructed)===hash(body);
}catch{return false;}}
function adopt(packets,event,asOf){
 check(packets.length>0&&packets.length<=4,'ADOPTION_BOUND');const at=Date.parse(asOf),kickoff=Date.parse(event.eventVersion);
 check(Number.isFinite(at)&&at<kickoff&&event.businessDate===day(at)&&event.leagueName===LEAGUES['kr.1'],'ADOPTION_CLOCK');
 for(const p of packets)check(verify(p)&&Date.parse(p.createdAt)<=at&&at-Date.parse(p.createdAt)<=21600000,'ADOPTION_FRESHNESS');
 const schedule=packets.filter(p=>p.plan.kind==='schedule'),standings=packets.filter(p=>p.plan.kind==='standings');
 const home=k.resolveTeamId(event.homeTeamName),away=k.resolveTeamId(event.awayTeamName);check(home&&away&&home!==away,'TEAM_MAPPING');
 const rows=schedule.flatMap(p=>JSON.parse(p.response.raw).data.scheduleList);
 check(new Set(rows.map(r=>`${r.year}/${r.gameId}`)).size===rows.length,'SCHEDULE_DUPLICATE');
 const fixtures=rows.filter(r=>r.homeTeam===home&&r.awayTeam===away&&Date.parse(k.officialKickoffInstant(r))===kickoff);
 check(fixtures.length===1,'EXACT_EVENT');check(standings.length===1,'STANDINGS');
 const rank=JSON.parse(standings[0].response.raw).data.teamRank;
 const teams=[home,away].map(teamId=>{const r=rank.filter(r=>r.teamId===teamId);check(r.length===1,'STANDING_TEAM');
  const finals=rows.filter(r=>r.endYn==='Y'&&r.gameStatus==='FE'&&(r.homeTeam===teamId||r.awayTeam===teamId)
   &&[r.homeGoal,r.awayGoal].every(v=>Number.isInteger(v)&&v>=0)&&Date.parse(k.officialKickoffInstant(r))+100*60000<at)
   .sort((a,b)=>Date.parse(k.officialKickoffInstant(b))-Date.parse(k.officialKickoffInstant(a))).slice(0,5);
  return {teamId,rank:r[0].rank,points:r[0].gainPoint,played:r[0].gameCount,lastFive:finals.map(r=>({gameId:r.gameId,kickoff:k.officialKickoffInstant(r),home:r.homeTeam,away:r.awayTeam,score:[r.homeGoal,r.awayGoal]}))};});
 return seal({version:'team-evidence-adoption-v1',asOf,event,providerGameId:fixtures[0].gameId,evidenceHashes:packets.map(p=>p.contentHash),teams,
  verification:'official-single-source',secondIndependentSourceVerified:false,probabilityFactorsUsed:[],
  missing:['独立第二来源','伤停/停赛','首发','xG','完整体能','天气'],formalEligible:false});
}
module.exports={VERSION,plans,validPlan,capture,pack,verify,adopt,check,hash,sha,seal};
