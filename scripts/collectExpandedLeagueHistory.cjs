'use strict';
// Local research warehouse only. Does not register parameters or write production.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const REPO='https://github.com/openfootball/football.json.git';
const PIN='e6744429ee395bc86f247348c6184bb08d4eb361';
const LEAGUES=Object.freeze({
 'en.1':'英格兰超级联赛','en.2':'英格兰冠军联赛','de.1':'德国甲级联赛','de.2':'德国乙级联赛',
 'es.1':'西班牙甲级联赛','it.1':'意大利甲级联赛','fr.1':'法国甲级联赛','fr.2':'法国乙级联赛',
 'nl.1':'荷兰甲级联赛','nl.2':'荷兰乙级联赛','pt.1':'葡萄牙超级联赛','br.1':'巴西甲级联赛',
 'jp.1':'日本职业联赛','kr.1':'韩国职业联赛','se.1':'瑞典超级联赛','no.1':'挪威超级联赛','sa.1':'沙特职业联赛',
});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const instant=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const date=v=>typeof v==='string'&&/^20\d\d-\d\d-\d\d$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
function parse(raw,{league,season,knownAt}){
 assert(Object.hasOwn(LEAGUES,league)&&/^20\d\d(?:-\d\d)?$/.test(season)&&instant(knownAt),'identity/clock');
 assert(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=2*1024*1024,'file size');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);assert(!text.includes('\ufffd'),'replacement character');
 const doc=JSON.parse(text);assert(typeof doc.name==='string'&&doc.name.includes(season.replace('-','/')),'season title');
 assert(Array.isArray(doc.matches)&&doc.matches.length<=2000,'match bound');
 const rows=[],excluded=[],seen=new Set(),firstYear=Number(season.slice(0,4));
 for(const [index,m]of doc.matches.entries()){
  assert(date(m.date),'invalid date');assert([m.team1,m.team2].every(t=>typeof t==='string'&&t.trim()===t&&t.length>0&&t.length<=120&&!/[\x00-\x1f]/.test(t))&&m.team1!==m.team2,'team identity');
  assert(Number(m.date.slice(0,4))>=firstYear&&Number(m.date.slice(0,4))<=firstYear+(season.includes('-')?1:0),'season range');
  const key=JSON.stringify([league,m.date,m.team1,m.team2]);assert(!seen.has(key),'duplicate event');seen.add(key);
  const ft=m.score?.ft;
  let reason=null;
  if(m.date>=knownAt.slice(0,10))reason='same-day-or-future';
  else if(Array.isArray(m.score))reason='ambiguous-score-array';
  else if(!Array.isArray(ft))reason='missing-explicit-ft';
  else if(ft.length!==2||!ft.every(x=>Number.isInteger(x)&&x>=0&&x<=20))throw Error('invalid ft');
  else if(m.score.et||m.score.pen||/play.?off|relegation|final/i.test(m.round||''))reason='nonordinary-stage';
  if(reason){excluded.push({index,date:m.date,reason});continue;}
  rows.push({id:hash(key),league,season,date:m.date,home:m.team1,away:m.team2,homeGoals:ft[0],awayGoals:ft[1],
   sourceIndex:index,knownAt,historicalKnownAt:null,actualEndedAt:null,neutral:null,scoreScope:'community-explicit-ft-not-official-settlement'});
 }
 return {title:doc.name,rows,excluded};
}
function writeNew(file,body){fs.writeFileSync(file,body,{flag:'wx'});}
const TEXT_PIN='0bf83f88e8feb22904c5f9d93c6407574c1347e0';
const TEXT_LEAGUES={'sweden':['se.1','Sweden Allsvenskan','se1'],'norway':['no.1','Norway Eliteserien','no1'],'netherlands':['nl.2','Netherlands Eerste Divisie','nl2']};
function parseText(raw,{league,season,knownAt}){
 const spec=Object.values(TEXT_LEAGUES).find(s=>s[0]===league);assert(spec,'text league');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);assert(text.split(/\r?\n/)[0].trim()===`= ${spec[1]} ${season.replace('-','/')}`,'text title');
 const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 let current=null,year=Number(season.slice(0,4)),lastMonth=null,stage='regular';const matches=[],unparsed=[];
 for(const [index,original]of text.split(/\r?\n/).entries()){
  const line=original.trim();if(!line||line.startsWith('#')||line.startsWith('='))continue;
  if(/^[▪•]/u.test(line)){stage=/matchday/i.test(line)?'regular':'excluded-stage';continue;}
  const day=/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?: (20\d{2}))?$/.exec(line);
  if(day){const month=months.indexOf(day[1])+1;if(day[3])year=Number(day[3]);else if(season.includes('-')&&year===Number(season.slice(0,4))&&lastMonth===12&&month===1)year++;lastMonth=month;current=`${year}-${String(month).padStart(2,'0')}-${day[2].padStart(2,'0')}`;assert(date(current),'text date');continue;}
  if(!/\s+v\s+/.test(line)){assert(!/\d+\s*-\s*\d+/.test(line),'unknown score syntax');continue;}
  assert(current,'text date missing');const m=/^(?:(?:\d{1,2}:\d{2})\s+)?(.+?)\s+v\s+(.+?)\s{2,}(\d{1,2})-(\d{1,2})(?:\s+\((\d{1,2})-(\d{1,2})\))?$/.exec(line);
  if(!m){unparsed.push({sourceLine:index+1,date:current,reason:'unplayed-or-nonordinary-score'});continue;}
  if(m[5]!==undefined)assert(+m[5]<=+m[3]&&+m[6]<=+m[4],'invalid half score');
  matches.push({date:current,team1:m[1],team2:m[2],round:stage==='regular'?'Matchday':'Playoff',score:{ft:[+m[3],+m[4]]},sourceLine:index+1});
 }
 const parsed=parse(Buffer.from(JSON.stringify({name:`${spec[1]} ${season.replace('-','/')}`,matches})),{league,season,knownAt});
 parsed.rows=parsed.rows.map(r=>({...r,sourceLine:matches[r.sourceIndex].sourceLine,scoreScope:'community-ordinary-text-score-not-official-settlement'}));parsed.excluded.push(...unparsed);return parsed;
}
function collectText(repo,output,knownAt){
 assert(path.isAbsolute(repo)&&path.isAbsolute(output)&&!fs.existsSync(output)&&instant(knownAt),'new absolute output/clock');
 const git=(...args)=>cp.execFileSync('git',['-C',repo,...args],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,windowsHide:true}).trim();
 assert.equal(git('remote','get-url','origin'),'https://github.com/openfootball/europe.git');assert.equal(git('rev-parse','HEAD'),TEXT_PIN);assert.equal(git('status','--porcelain'),'');
 const blob=file=>cp.execFileSync('git',['-C',repo,'show',`${TEXT_PIN}:${file}`],{maxBuffer:2*1024*1024,windowsHide:true});
 const license=blob('LICENSE.md');assert(license.toString().startsWith('CC0 1.0 Universal'));fs.mkdirSync(output,{recursive:true});fs.mkdirSync(path.join(output,'raw'));writeNew(path.join(output,'raw','LICENSE.md'),license);
 const files=[],rows=[],excluded=[],ids=new Set();
 for(const file of git('ls-tree','-r','--name-only',TEXT_PIN).split('\n')){
  const [dir,base]=file.split('/'),spec=TEXT_LEAGUES[dir];if(!spec||!base)continue;
  const match=new RegExp(`^(202[1-6](?:-\\d\\d)?)_${spec[2]}\\.txt$`).exec(base);if(!match)continue;
  const raw=blob(file),sourceSha256=hash(raw),sourceUrl=`https://raw.githubusercontent.com/openfootball/europe/${TEXT_PIN}/${file}`;
  const p=parseText(raw,{league:spec[0],season:match[1],knownAt});writeNew(path.join(output,'raw',file.replace('/','-')),raw);
  files.push({file,sha256:sourceSha256,sourceUrl,rows:p.rows.length,excluded:p.excluded.length});
  for(const r of p.rows){assert(!ids.has(r.id),'duplicate text event');ids.add(r.id);rows.push({...r,sourceSha256,sourceUrl});}excluded.push(...p.excluded.map(e=>({...e,file})));
 }
 const coverage=Object.values(TEXT_LEAGUES).map(([league])=>({league,name:LEAGUES[league],rows:rows.filter(r=>r.league===league).length,lastDate:rows.filter(r=>r.league===league).map(r=>r.date).sort().at(-1)||null}));
 const body={version:'expanded-text-history-v1',knownAt,commit:TEXT_PIN,license:'CC0-1.0',files,rows,excluded,coverage,productionWrites:0,formalEligible:false,historicalAsOfVerified:false,secondIndependentSourceVerified:false};writeNew(path.join(output,'history.json'),JSON.stringify({...body,contentHash:hash(JSON.stringify(body))},null,2));return {output,files:files.length,rows:rows.length,excluded:excluded.length,coverage};
}
function collect(repo,output,knownAt){
 assert(path.isAbsolute(repo)&&path.isAbsolute(output)&&!fs.existsSync(output)&&instant(knownAt),'new absolute output and acquisition clock required');
 const git=(...args)=>cp.execFileSync('git',['-C',repo,...args],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,windowsHide:true}).trim();
 assert.equal(git('remote','get-url','origin'),REPO);assert.equal(git('rev-parse','HEAD'),PIN);assert.equal(git('status','--porcelain'),'');
 const blob=file=>cp.execFileSync('git',['-C',repo,'show',`${PIN}:${file}`],{maxBuffer:2*1024*1024,windowsHide:true});
 const license=blob('LICENSE.md');assert(license.toString().startsWith('CC0 1.0 Universal'),'license');
 const tracked=git('ls-tree','-r','--name-only',PIN).split('\n');
 const selected=tracked.filter(p=>/^202[1-6](?:-\d\d)?\/[a-z]+\.\d\.json$/.test(p)&&Object.hasOwn(LEAGUES,path.basename(p,'.json')));
 assert(selected.length>0&&selected.length<=120,'file selection');fs.mkdirSync(output,{recursive:true});fs.mkdirSync(path.join(output,'raw'));
 writeNew(path.join(output,'raw','LICENSE.md'),license);
 const rows=[],files=[],excluded=[],ids=new Set();
 for(const file of selected){
  // Read canonical Git bytes; Windows checkout newline conversion is not source content.
  const raw=blob(file);
  const [season]=file.split('/'),league=path.basename(file,'.json'),p=parse(raw,{league,season,knownAt});
  const sourceSha256=hash(raw),sourceUrl=`https://raw.githubusercontent.com/openfootball/football.json/${PIN}/${file}`;
  writeNew(path.join(output,'raw',file.replace('/','-')),raw);
  files.push({file,league,season,title:p.title,sha256:sourceSha256,bytes:raw.length,sourceUrl,knownAt,rows:p.rows.length,excluded:p.excluded.length});
  for(const r of p.rows){assert(!ids.has(r.id),'duplicate across files');ids.add(r.id);rows.push({...r,sourceSha256,sourceUrl});}
  excluded.push(...p.excluded.map(r=>({...r,file})));
 }
 const coverage=Object.entries(LEAGUES).map(([league,name])=>{const lr=rows.filter(r=>r.league===league),dates=lr.map(r=>r.date).sort();return {league,name,files:files.filter(f=>f.league===league).length,rows:lr.length,teams:new Set(lr.flatMap(r=>[r.home,r.away])).size,firstDate:dates[0]||null,lastDate:dates.at(-1)||null,seasons:[...new Set(lr.map(r=>r.season))],status:lr.length?'research-history-only':'source-missing',registered:false,canonicalMappingApproved:false};});
 const body={version:'expanded-league-history-v1',createdAt:new Date().toISOString(),knownAt,source:{repo:REPO,commit:PIN,commitTime:git('show','-s','--format=%cI',PIN),license:'CC0-1.0',licenseHash:hash(license)},files,rows,excluded,coverage,productionWrites:0,modelTrained:false,formalEligible:false,historicalAsOfVerified:false,secondIndependentSourceVerified:false};
 writeNew(path.join(output,'history.json'),JSON.stringify({...body,contentHash:hash(JSON.stringify(body))},null,2));
 return {output,files:files.length,rows:rows.length,excluded:excluded.length,coverage};
}
if(require.main===module){try{const args=process.argv.slice(2),fn=args[0]==='--text'?(args.shift(),collectText):collect;console.log(JSON.stringify(fn(...args),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={parse,parseText,collect,collectText,LEAGUES,PIN};
