'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),storage=require('./neutralCollectionStore.cjs'),discovery=require('./neutralFutureDiscovery.cjs'),facts=require('./neutralFutureFacts.cjs'),parser=require('./neutralOfficialSportsParser.cjs');
const STORE='/var/lib/football-data-org',APP='/opt/football-predict';
const officialHistory=require('./neutralOfficialHistory.cjs');
const swedish=require('./neutralSwedishOfficial.cjs');
const availability=require('./neutralOfficialAvailability.cjs');
function discoverIdentities({store=STORE,now=Date.now(),app=APP,snapshot,registry,project}={}){
 process.env.SERVER_STORE_DIR='/var/lib/football-predict';
 snapshot=snapshot||require(app+'/scripts/recommendationPlatform/liveOfficialHandicap.cjs').readLiveOfficialSnapshot();
 registry=registry||require(app+'/src/services/collectorAttestation.cjs').loadCollectorTrustRegistry(app+'/deploy/light-server/collector-trust-registry.json');
 project=project||require(app+'/server/officialScheduleRead.cjs').project;
 const start=new Date(now+8*3600000).toISOString().slice(0,10),days=Array.from({length:8},(_,offset)=>new Date(Date.parse(start+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10));
 const protectedThrough=process.env.NEUTRAL_PROTECTED_THROUGH||'2026-10-24',events=[];
 for(const day of days){
  const view=project(snapshot,day,{now,trustRegistry:registry});if(day<=protectedThrough||!view.events.length)continue;
  storage.save(store,'identity-'+day.replaceAll('-',''),{version:'neutral-signed-identity-archive-v1',businessDate:day,snapshot,snapshotSha256:storage.sha(JSON.stringify(snapshot))});
  for(const item of view.events){if(Date.parse(item.kickoff)<=now||Date.parse(item.kickoff)>now+7*86400000)continue;const {eventId,businessDate,kickoff,homeTeamId,awayTeamId,homeTeamName,awayTeamName,leagueName,matchNum}=item;events.push({eventId,businessDate,kickoff,homeTeamId,awayTeamId,homeTeamName,awayTeamName,leagueName,matchNum,identityObservedAt:view.sourceReceivedAt});}
 }
 return events;
}
function createRequester(directory,{fetcher=fetch,now=Date.now,sleep=duration=>new Promise(resolve=>setTimeout(resolve,duration)),blobDirectory,backoff={},persistBackoff=()=>{}}={}){
 const hosts=new Map(),deadline=now()+240000;let requests=0;
 return async function request(id,url,options={}){
  const parsed=new URL(url),allowed=['www.jleague.jp','www.eliteserien.no','www.kleague.com','aleagues.com.au','match.api.aleagues.football','gql.sportomedia.se','fantasy.premierleague.com'];if(parsed.protocol!=='https:'||!allowed.includes(parsed.hostname)||parsed.username||parsed.password)throw Error('SOURCE_ALLOWLIST');
  if(hosts.get(parsed.hostname)?.blocked||Number(backoff[parsed.hostname]?.until)>now())throw Error('SOURCE_HOST_BLOCKED');
  for(let attempt=0;attempt<2;attempt++){
   if(++requests>28)throw Error('REQUEST_BUDGET');const wait=Math.max(0,(hosts.get(parsed.hostname)?.next||0)-now());if(wait)await sleep(wait);if(now()>=deadline)throw Error('COLLECTION_TIME_BUDGET');
   const requestedAt=new Date(now()).toISOString();let receipt,body,retryAfter;
   try{const response=await fetcher(url,{...options,redirect:'manual',signal:AbortSignal.timeout(20000)});retryAfter=response.headers.get('retry-after');const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024)throw Error('BODY_LIMIT');chunks.push(chunk);}body=Buffer.concat(chunks);const hash=storage.sha(body),rawName=blobDirectory?hash+'.body':id+'-'+attempt+'.body',file=path.join(blobDirectory||directory,rawName);try{fs.writeFileSync(file,body,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST'||storage.sha(storage.bytes(file))!==hash)throw error;}receipt={url,requestedAt,receivedAt:new Date(now()).toISOString(),status:response.status,sha256:hash,rawName,contentAddressed:Boolean(blobDirectory)};
   }catch(error){receipt={url,requestedAt,receivedAt:new Date(now()).toISOString(),status:'transport-failed',reason:error.message==='BODY_LIMIT'?'BODY_LIMIT':'TRANSPORT_FAILURE'};}
   if(options.body)receipt.requestBodySha256=storage.sha(options.body);
   fs.writeFileSync(path.join(directory,id+'-'+attempt+'.receipt.json'),JSON.stringify(receipt),{flag:'wx',mode:0o600});
   const blocked=[401,403,429].includes(receipt.status);hosts.set(parsed.hostname,{next:now()+1500,blocked});
   if(blocked){const requested=/^\d+$/.test(retryAfter||'')?now()+Number(retryAfter)*1000:Date.parse(retryAfter);backoff[parsed.hostname]={status:receipt.status,until:Math.max(now()+3600000,Number.isFinite(requested)?requested:0)};persistBackoff(backoff);}
   if(receipt.status===200)return{text:body.toString('utf8'),receipt};
   if(blocked||!(receipt.status==='transport-failed'||Number(receipt.status)>=500)||receipt.reason==='BODY_LIMIT')throw Error('SOURCE_HTTP_'+receipt.status);
   if(attempt===0)await sleep(3000);
  }
  throw Error('SOURCE_RETRY_EXHAUSTED');
 };
}
async function collect({store=STORE,now=Date.now,requestDependencies={},identityOptions={}}={}){
 const disk=fs.statfsSync(store);if(disk.bavail*disk.bsize<2*1024**3)throw Error('DISK_RESERVE');
 {
  const startedAt=new Date(now()).toISOString(),previous=storage.load(store,'future-facts'),sourceFailures=[];let events,identityRetained=false;
  try{events=discoverIdentities({store,now:now(),...identityOptions});}catch(error){
   sourceFailures.push({source:'official-identity',reason:error.message});identityRetained=true;
   const protectedThrough=process.env.NEUTRAL_PROTECTED_THROUGH||'2026-10-24';events=(previous?.events||[]).map(row=>row.event).filter(event=>event.businessDate>protectedThrough&&Date.parse(event.kickoff)>now()&&Date.parse(event.kickoff)<=now()+7*86400000);
  }
  for(const row of previous?.events||[])if(row.event.businessDate>(process.env.NEUTRAL_PROTECTED_THROUGH||'2026-10-24')&&['日本职业联赛','日本乙级联赛'].includes(row.event.leagueName)&&Date.parse(row.event.kickoff)<=now()&&Date.parse(row.event.kickoff)>now()-12*3600000&&!events.some(event=>storage.identity(event)===storage.identity(row.event)))events.push(row.event);
  const id=crypto.randomUUID(),directory=path.join(store,'future-originals',id),blobDirectory=path.join(store,'future-blobs');fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.mkdirSync(blobDirectory,{recursive:true,mode:0o700});const request=createRequester(directory,{now,...requestDependencies,blobDirectory,backoff:storage.load(store,'source-backoff')||{},persistBackoff:value=>storage.save(store,'source-backoff',value)}),sources={},discovered=[];
  if(events.some(event=>event.leagueName==='英格兰超级联赛'))for(const [key,url]of [['fpl',availability.bootstrapUrl],['fpl-fixtures',availability.fixturesUrl]])try{sources[key]=await request(key,url);}catch(error){sourceFailures.push({source:key,reason:error.message});}
  const tasks=[['jp1','https://www.jleague.jp/j1/match/',body=>discovery.japanese(body,'j1')],['jp2','https://www.jleague.jp/j2/match/',body=>discovery.japanese(body,'j2')],['no','https://www.eliteserien.no/terminliste/subscribe',discovery.norwegian],['au','https://match.api.aleagues.football/middleware/v2/fixturesAndResultsV2?competitionId=xwnjb1az11zffwty3m6vn8y6&includeTicketAndStreamInfo=true',body=>discovery.australian(body,now())]];
  for(const [key,url,parse] of tasks){try{const result=await request(key,url);sources[key]=result;discovered.push(...parse(result.text).filter(row=>Date.parse(row.kickoff)>now()-12*3600000&&Date.parse(row.kickoff)<=now()+7*86400000).map(row=>({...row,receipt:result.receipt})));}catch(error){sourceFailures.push({source:key,reason:error.message});}}
  for(const [key,url] of [['jp-table','https://www.jleague.jp/j1/standings/'],['jp2-table','https://www.jleague.jp/j2/standings/'],['no-table','https://www.eliteserien.no/tabell'],['au-table','https://aleagues.com.au/ladders/a-league-men/']]){try{sources[key]=await request(key,url);}catch(error){sourceFailures.push({source:key,reason:error.message});}}
  if(events.some(event=>event.leagueName==='挪威超级联赛'))try{sources['no-history']=await request('no-history','https://www.eliteserien.no/resultater');}catch(error){sourceFailures.push({source:'no-history',reason:error.message});}
  const japaneseClubs=new Set(events.filter(event=>['日本职业联赛','日本乙级联赛'].includes(event.leagueName)).flatMap(event=>(discovery.officialNames(event)||[]).map(team=>team[3])));
  for(const club of japaneseClubs){try{sources['jp-history-'+club]=await request('jp-history-'+club,'https://www.jleague.jp/club/'+club+'/day/');}catch(error){sourceFailures.push({source:'jp-history-'+club,reason:error.message});}}
  const koreaEvents=events.filter(event=>event.leagueName==='韩国职业联赛');
  if(koreaEvents.length){
   const months=new Map();for(const event of koreaEvents){const date=new Date(event.kickoff);for(let ago=2;ago>=0;ago--){const month=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()-ago,1));months.set(month.toISOString().slice(0,7),month);}}
   try{const year=new Date(now()+8*3600000).getUTCFullYear();sources['kr-table']=await request('kr-table',`https://www.kleague.com/record/teamRank.do?leagueId=1&year=${year}&stadium=all&recordType=rank`,{method:'POST'});for(const [key,date]of months){sources['kr-'+key]=await request('kr-'+key,'https://www.kleague.com/getScheduleList.do',{method:'POST',headers:{'content-type':'application/json;charset=UTF-8'},body:JSON.stringify({leagueId:1,teamId:'',ticketStatus:'',year:date.getUTCFullYear(),month:String(date.getUTCMonth()+1).padStart(2,'0'),ticketYn:''})});}}catch(error){sourceFailures.push({source:'kr',reason:error.message});}
  }
  const swedishYears=new Set(events.filter(event=>event.leagueName==='瑞典超级联赛').map(event=>Number(event.businessDate.slice(0,4))));
  for(const year of swedishYears)try{
   const body=swedish.requestBody(year);fs.writeFileSync(path.join(directory,'se-'+year+'.request.json'),body,{flag:'wx',mode:0o600});
   sources['se-'+year]=await request('se-'+year,swedish.url,{method:'POST',headers:{'content-type':'application/json'},body});
  }catch(error){sourceFailures.push({source:'se-'+year,reason:error.message});}
  const org=storage.load(store,'org-fields'),rows=[];
  for(const event of events){
   const original=previous?.events?.find(row=>storage.identity(row.event)===storage.identity(event)),result=facts.orgFields(event,org,store,now()),fields=result.fields,gaps=[...result.gaps];
   if(identityRetained)gaps.push('本轮官方赛程身份更新不可用；仅续采已核验留存身份，不确认当前开售或SP。');
   if(event.leagueName==='英格兰超级联赛')try{
    const source=sources.fpl,fixture=sources['fpl-fixtures'];if(!source||!fixture)throw Error('FPL_SOURCE_MISSING');
    const value=availability.premierLeague(JSON.parse(source.text),JSON.parse(fixture.text),event,now());
    fields.availability={value:value.availability,complete:false,observedAt:source.receipt.receivedAt,sources:[source.receipt,fixture.receipt]};gaps.push(value.reason);
   }catch(error){gaps.push('英超官方球员状态未通过：'+error.message);}
   if(event.leagueName==='瑞典超级联赛')try{
    const year=Number(event.businessDate.slice(0,4)),source=sources['se-'+year];if(!source)throw Error('SE_SOURCE_MISSING');
    const value=swedish.parse(source.text,event,year,now()),evidence={complete:true,observedAt:source.receipt.receivedAt,sources:[source.receipt]};
    fields.fixture={...evidence,value:{providerId:value.providerId,url:'https://allsvenskan.se/matcher'}};
    for(const [side,team]of value.teams.entries()){fields['standing'+side]={...evidence,value:team.standing};fields['history'+side]={...evidence,value:team.history,complete:team.history.lastFiveComplete};}
   }catch(error){gaps.push('瑞典官方资料未通过：'+error.message);}
   if(event.leagueName==='韩国职业联赛')try{
    const resolve=require(APP+'/scripts/syncKLeagueOfficialStandings.cjs').resolveTeamId,ids=[event.homeTeamName,event.awayTeamName].map(resolve);if(!ids.every(Boolean))throw Error('KLEAGUE_MAPPING');
    const schedules=Object.entries(sources).filter(([key])=>key.startsWith('kr-')&&key!=='kr-table').map(([,value])=>value),table=sources['kr-table'];
    const result=parser.korean(JSON.parse(table.text),schedules.map(value=>JSON.parse(value.text)),{businessDate:event.businessDate,kickoff:event.kickoff,names:[event.homeTeamName,event.awayTeamName]},ids,now()),receipts=[table.receipt,...schedules.map(value=>value.receipt)];
    for(const [side,team]of result.teams.entries()){fields['standing'+side]={value:team.standing,complete:true,observedAt:table.receipt.receivedAt,sources:receipts};fields['history'+side]={value:{scope:team.scope,lastFive:team.lastFive,lastFiveComplete:team.lastFiveComplete},complete:team.lastFiveComplete,observedAt:table.receipt.receivedAt,sources:receipts};}
   }catch{gaps.push('韩国官方积分或近况未能通过完整校验。');}
   const match=discovery.match(event,discovered);
   if(match.status==='matched'){
    fields.fixture={value:{providerId:match.row.providerId,url:match.row.url},complete:true,observedAt:match.row.receipt.receivedAt,sources:[match.row.receipt]};
    if(['j1','j2'].includes(match.row.league))try{
     const source=await request('lineup-'+event.eventId,match.row.url),value=availability.japaneseLineup(source.text,event,match.row);
     fields.lineup={value,complete:true,observedAt:source.receipt.receivedAt,sources:[match.row.receipt,source.receipt]};
     if(Date.parse(event.kickoff)<=now())gaps.push('确认首发为开赛后补采，仅供事实核对，不能补作原推荐赛前依据。');
    }catch(error){gaps.push('日本官方确认首发未通过：'+error.message);}
    try{
     let teams,receipt;
     if(match.row.league==='j1'&&sources['jp-table']){teams=parser.japaneseTable(sources['jp-table'].text,{businessDate:event.businessDate,names:[event.homeTeamName,event.awayTeamName]},match.teams.map(team=>team[3]));receipt=sources['jp-table'].receipt;}
     if(match.row.league==='j2'&&sources['jp2-table']){teams=parser.japaneseTable(sources['jp2-table'].text,{businessDate:event.businessDate,names:[event.homeTeamName,event.awayTeamName]},match.teams.map(team=>team[3]),'j2');receipt=sources['jp2-table'].receipt;}
     if(match.row.league==='NO1'&&sources['no-table']){teams=parser.norwegian(sources['no-table'].text,{names:[event.homeTeamName,event.awayTeamName]},match.teams.map(team=>team[2])).teams;receipt=sources['no-table'].receipt;}
     if(match.row.league==='ALM'&&sources['au-table']){teams=parser.australianTable(sources['au-table'].text,{businessDate:event.businessDate,names:[event.homeTeamName,event.awayTeamName]},match.teams.map(team=>team[3]));receipt=sources['au-table'].receipt;}
     if(teams)for(const [side,team]of teams.entries())fields['standing'+side]={value:team.standing,complete:true,observedAt:receipt.receivedAt,sources:[receipt,match.row.receipt]};
    }catch(error){gaps.push('官方积分解析未通过：'+error.message);}
    if(['j1','j2','ALM','NO1'].includes(match.row.league))for(const [side,team]of match.teams.entries())try{
     const source=match.row.league==='NO1'?sources['no-history']:match.row.league==='ALM'?sources.au:sources['jp-history-'+team[3]];
     if(!source)throw Error('HISTORY_SOURCE_MISSING');
     const value=match.row.league==='NO1'?officialHistory.norwegian(source.text,sources.no.text,event,team[2],now()):match.row.league==='ALM'?officialHistory.australian(source.text,event,team[4],now()):officialHistory.japanese(source.text,event,match.row.league,team[2],now());
     fields['history'+side]={value,complete:value.lastFiveComplete,observedAt:source.receipt.receivedAt,sources:[source.receipt,match.row.receipt]};
    }catch(error){gaps.push((side?'客队':'主队')+'官方近况未通过：'+error.message);}
   }else if(['日本职业联赛','日本乙级联赛','挪威超级联赛','澳大利亚超级联赛'].includes(event.leagueName))gaps.push('官方补充赛程匹配：'+match.status+'；未按近似名称或时间合并。');
   gaps.push('双方完整伤停、停赛与确认首发渠道未齐；未查到不等于无人缺阵。');
   rows.push({event,identityObservedAt:event.identityObservedAt,discoveredAt:original?.discoveredAt||startedAt,lastAttemptAt:new Date(now()).toISOString(),fields:storage.mergeFields(original?.fields,fields,now()),gaps});
  }
  for(const row of previous?.events||[])if(!rows.some(item=>item.event.eventId===row.event.eventId&&item.event.businessDate===row.event.businessDate)&&Date.parse(row.event.kickoff)>now()-7*86400000)rows.push(row);
  const value={version:1,startedAt,completedAt:new Date(now()).toISOString(),events:rows,discovered,sourceFailures,requestsDirectory:id,publicationWrites:0,availableDiskBytes:disk.bavail*disk.bsize,diskWarning:disk.bavail*disk.bsize<8*1024**3,protectedThrough:process.env.NEUTRAL_PROTECTED_THROUGH||'2026-10-24'};const receipt=storage.save(store,'future-facts',value);
  return{ok:sourceFailures.length===0,receipt,discoveredOfficialIdentities:events.length,discoveredSupplementalFixtures:discovered.length,sourceFailures,coverage:rows.map(row=>({day:row.event.businessDate,id:row.event.eventId,fields:Object.keys(row.fields),gaps:row.gaps})),publicationWrites:0};
 }
}
if(require.main===module){
 if(process.argv[2]==='--locked')collect().then(result=>{console.log(JSON.stringify(result));if(!result.ok)process.exitCode=2;}).catch(error=>{console.error(JSON.stringify({ok:false,reason:error.message,publicationWrites:0}));process.exitCode=1;});
 else{const child=require('node:child_process').spawn('/usr/bin/flock',['--exclusive','--nonblock',path.join(STORE,'future-process.lock'),process.execPath,__filename,'--locked'],{stdio:'inherit'});child.on('error',()=>{console.error('COLLECTION_LOCK_UNAVAILABLE');process.exitCode=1;});child.on('exit',(code,signal)=>{process.exitCode=signal?1:code??1;});}
}
module.exports={discoverIdentities,createRequester,collect};
