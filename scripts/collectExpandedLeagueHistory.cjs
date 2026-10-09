'use strict';
// Local research warehouse only. Does not register parameters or write production.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const REPO='https://github.com/openfootball/football.json.git';
const PIN='e6744429ee395bc86f247348c6184bb08d4eb361';
const {parse,LEAGUES,hash,instant,date}=require('./expandedLeagueHistoryParser.cjs');
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
