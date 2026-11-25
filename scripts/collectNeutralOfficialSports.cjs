'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const parser=require('./neutralOfficialSportsParser.cjs');
const STORE='/var/lib/football-data-org';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const jsonNew=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
function plans(day) {
  const year=Number(day.slice(0,4)),month=Number(day.slice(5,7)),result=[{id:'kr-table',url:`https://www.kleague.com/record/teamRank.do?leagueId=1&year=${year}&stadium=all&recordType=rank`,method:'POST'}];
  for(let ago=2;ago>=0;ago--){const date=new Date(Date.UTC(year,month-1-ago,1));result.push({id:'kr-'+ago,url:'https://www.kleague.com/getScheduleList.do',method:'POST',body:JSON.stringify({leagueId:1,teamId:'',ticketStatus:'',year:date.getUTCFullYear(),month:String(date.getUTCMonth()+1).padStart(2,'0'),ticketYn:''})});}
  if(day==='2026-10-24') result.push(
    {id:'jp-003',url:'https://www.jleague.jp/match/j1/2026/102410/'},
    {id:'jp-004',url:'https://www.jleague.jp/match/j1/2026/102407/'},
    {id:'jp-table',url:'https://www.jleague.jp/j1/standings/'},
    {id:'au-table',url:'https://aleagues.com.au/ladders/a-league-men/'},
    {id:'spurs-news',url:'https://www.tottenhamhotspur.com/news/1180250/team-news-porro-back-four-out-of-chelsea-clash'},
    {id:'lens-news',url:'https://www.rclens.fr/fr/conference-de-presse-rclens-parisfc-ligue1-cahuzac-sotoca-20261023'},
    {id:'au-005',url:'https://aleagues.com.au/match/a-league-men/melbourne-victory-vs-melbourne-city-24-10-2026/'},
    {id:'city-news',url:'https://melbournecityfc.com.au/news/20261022-team-news/'},
    {id:'no-match',url:'https://www.fotball.no/fotballdata/kamp/?fiksId=8986217'},
    {id:'no-table',url:'https://www.eliteserien.no/tabell'}
  );
  return result;
}
async function collect({store=STORE,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),eventReader}={}) {
  const startedAt=new Date(now()).toISOString(),day=new Date(now()+8*3600000).toISOString().slice(0,10);
  process.env.SERVER_STORE_DIR='/var/lib/football-predict';
  const config=(eventReader||require('/opt/football-predict/server/officialScheduleRead.cjs').read)(day);
  if(config.businessDate!==day||!Array.isArray(config.events)||config.events.length>100)throw Error('FIXTURE_CONFIG');
  const disk=fs.statfsSync(store);if(disk.bavail*disk.bsize<2*1024**3)throw Error('DISK_RESERVE');
  const lock=path.join(store,'official-collector.lock');
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt}),{flag:'wx',mode:0o600});
  try {
    const observation=crypto.randomUUID(),directory=path.join(store,'official-observations',observation);fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const responses=new Map();let rateLimited=false;
    for(const plan of plans(day)) {
      if(rateLimited)break; await sleep(1000);
      const requestedAt=new Date(now()).toISOString();let receipt;
      try {
        const response=await fetcher(plan.url,{method:plan.method||'GET',body:plan.body,headers:plan.method==='POST'?{'content-type':'application/json;charset=UTF-8'}:{accept:'text/html,application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)});
        const parts=[];let size=0;for await(const part of response.body){size+=part.length;if(size>4*1024*1024)throw Error('BODY_LIMIT');parts.push(part);}
        const bytes=Buffer.concat(parts);fs.writeFileSync(path.join(directory,plan.id+'.body'),bytes,{flag:'wx',mode:0o600});
        receipt={id:plan.id,url:plan.url,requestedAt,receivedAt:new Date(now()).toISOString(),status:response.status,sha256:sha(bytes),bytes:bytes.length};
        if(response.status===200)responses.set(plan.id,{receipt,text:bytes.toString('utf8')});
        if(response.status===429)rateLimited=true;
      }catch{receipt={id:plan.id,url:plan.url,requestedAt,receivedAt:new Date(now()).toISOString(),status:'request-failed-no-retry'};}
      jsonNew(path.join(directory,plan.id+'.receipt.json'),receipt);
    }
    const json=id=>JSON.parse(responses.get(id).text),body=id=>responses.get(id).text;
    const use=(ids,read)=>{const result=read();return{...result,sources:ids.map(id=>responses.get(id).receipt)};};
    const events=config.events.map(row=>{
      const event={eventId:row.eventId,businessDate:day,kickoff:row.kickoff,names:[row.homeTeamName,row.awayTeamName]};
      try {
        if(row.leagueName==='韩国职业联赛'){
          const resolve=require('/opt/football-predict/scripts/syncKLeagueOfficialStandings.cjs').resolveTeamId;
          const teamIds=event.names.map(resolve);if(!teamIds.every(Boolean))throw Error('KLEAGUE_MAPPING');
          return{...event,...use(['kr-table','kr-2','kr-1','kr-0'],()=>parser.korean(json('kr-table'),[json('kr-2'),json('kr-1'),json('kr-0')],event,teamIds,now()))};
        }
        if(['2042185','2042186'].includes(row.eventId)){const id=row.eventId==='2042185'?'jp-003':'jp-004';return{...event,...use([id,'jp-table'],()=>({...parser.japanese(body(id),event,id==='jp-003'?['136','30532']:['120','132']),teams:parser.japaneseTable(body('jp-table'),event,id==='jp-003'?['kobe','machida']:['kashima','kashiwa']),reason:'官方积分及首发已核对；完整近况、伤停和停赛名单仍未核实。'}))};}
        if(row.eventId==='2042187')return{...event,...use(['au-005','au-table','city-news'],()=>({...parser.australian(body('au-005'),event),teams:parser.australianTable(body('au-table'),event),availability:parser.cityAvailability(body('city-news'),now()),reason:'官方赛程、积分和墨尔本城部分缺阵信息已核对；墨尔本胜利伤停、完整近况与首发仍待核实。'}))};
        if(day==='2026-10-24'&&event.names[0]==='切尔西'&&event.names[1]==='托特纳姆热刺')return{...event,...use(['spurs-news'],()=>({status:'partial',reason:'仅核对热刺俱乐部缺阵报道，非双方完整名单。',availability:parser.spursAvailability(body('spurs-news'),now())}))};
        if(day==='2026-10-24'&&event.names[0]==='朗斯'&&event.names[1]==='巴黎FC')return{...event,...use(['lens-news'],()=>({status:'partial',reason:'朗斯俱乐部伤病与恢复合练报道已核对；巴黎FC伤停、双方停赛及首发仍未完整核实。报道仅展示核实到的日期。',availability:parser.lensAvailability(body('lens-news'),now())}))};
        if(row.eventId==='2042200'){
          if(day!=='2026-10-24'||event.names[0]!=='博德闪耀'||event.names[1]!=='瓦勒伦加'||row.leagueName!=='挪威超级联赛')throw Error('NORWAY_EVENT_IDENTITY');
          const raw=responses.get('no-match')?.text,matched=Boolean(raw&&raw.includes('24.10.2026')&&raw.includes('16:00')&&raw.includes('Bod&#xF8;/Glimt')&&raw.includes('V&#xE5;lerenga')&&event.kickoff==='2026-10-24T14:00:00.000Z');
          return{...event,...use(matched?['no-match','no-table']:['no-table'],()=>({...parser.norwegian(body('no-table'),event),reason:matched?'联赛官方积分已采集；完整近况、伤停与首发未核实。':'联赛官方积分已采集；挪威足协赛程源未能核验，未声称完成第二来源赛程核对。完整近况、伤停与首发仍缺。'}))};
        }
        return{...event,status:'missing',reason:'本轮未配置该球队的官方伤停、停赛及首发来源。'};
      }catch(error){return{...event,status:'unavailable',reason:'官方原文未能通过解析或身份校验，未补造数据。',failureCode:/^[A-Z_]+$/.test(error.code||'')?error.code:'SOURCE_UNAVAILABLE'};}
    });
    const facts={version:'neutral-official-sports-v1',startedAt,completedAt:new Date(now()).toISOString(),businessDate:day,events,rateLimited,originalsRetained:true};
    jsonNew(path.join(directory,'facts.json'),facts);
    const pointer={observation,sha256:sha(fs.readFileSync(path.join(directory,'facts.json')))};
    const temporary=path.join(store,observation+'.official.tmp');jsonNew(temporary,pointer);fs.renameSync(temporary,path.join(store,'official-latest.json'));
    return{ok:!rateLimited,observation,completedAt:facts.completedAt,events:events.map(event=>({eventId:event.eventId,status:event.status,teams:event.teams?.length||0,lineup:event.lineup?.status||null,availability:event.availability?.length||0,failureCode:event.failureCode})),publicationWrites:0};
  } finally { fs.unlinkSync(lock); }
}
if(require.main===module)collect().then(result=>{console.log(JSON.stringify(result));if(!result.ok)process.exitCode=2;}).catch(()=>{console.log(JSON.stringify({ok:false,reason:'OFFICIAL_COLLECTION_FAILED_NO_RETRY'}));process.exitCode=1;});
module.exports={plans,collect};
