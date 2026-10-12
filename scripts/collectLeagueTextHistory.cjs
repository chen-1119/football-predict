'use strict';
// Explicit CC0 community history. Never an official settlement or a historical
// knowledge-clock receipt. No SQL, production publisher or runtime imports.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const VERSION = 'league-text-history-v1';
const SOURCES = Object.freeze({
  br1: { repo: 'south-america', commit: '119fa1724b2079a1072a0cb0ca0ccac26d92fd34', directory: 'brazil', title: 'Brasileiro Série A', seasons: [2023, 2024, 2025, 2026] },
  fi1: { repo: 'europe', commit: '0bf83f88e8feb22904c5f9d93c6407574c1347e0', directory: 'finland', title: 'Finland Veikkausliiga', seasons: [2023, 2024, 2025] },
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const assert = (value, message) => { if (!value) throw Error(message); };
function date(year, month, day) {
  const value = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  assert(Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value, 'invalid source date');
  return value;
}
function parseHistory(raw, { league, season, receivedAt }) {
  const source = SOURCES[league];
  assert(source && source.seasons.includes(season), 'unsupported league/season');
  assert(typeof receivedAt === 'string' && new Date(receivedAt).toISOString() === receivedAt, 'invalid receipt clock');
  assert(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 2*1024*1024, 'source size');
  const text = new TextDecoder('utf-8', {fatal:true}).decode(raw);
  assert(!text.includes('\uFFFD') && text.split(/\r?\n/)[0].trim() === `= ${source.title} ${season}`, 'wrong source identity');
  let currentDate = null, stage = 'regular', lineNo = 0;
  const rows = [], excluded = [], tuples = new Set();
  for (const original of text.split(/\r?\n/)) {
    lineNo++; const line = original.trim();
    if (!line || line.startsWith('#') || line.startsWith('=')) continue;
    // Playoffs may include extra time, penalties or teams from another tier.
    if (/^[▪•]/u.test(line)) { if (!/matchday/i.test(line)) stage = /play.?off/i.test(line) ? 'excluded-playoff' : 'regular'; continue; }
    const day = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?: (20\d{2}))?$/.exec(line);
    if (day) { currentDate = date(Number(day[3] || season), months.indexOf(day[1])+1, Number(day[2])); continue; }
    if (!/\s+v\s+/.test(line)) {
      assert(!/\d+\s*-\s*\d+/.test(line), `unrecognized scored line ${lineNo}`);
      continue;
    }
    assert(currentDate, `missing date at ${lineNo}`);
    const match = /^(?:(?:\d{1,2}:\d{2})\s+)?(.+?)\s+v\s+(.+?)\s{2,}(\d{1,2})-(\d{1,2})(?:\s+\((\d{1,2})-(\d{1,2})\))?$/.exec(line);
    if (!match) { excluded.push({line:lineNo,date:currentDate,reason:'unplayed-or-nonordinary-score'}); continue; }
    const [,home,away,hg,ag,hh,ah] = match;
    assert(home !== away && home.length <= 120 && away.length <= 120, 'invalid teams');
    assert(+hg <= 20 && +ag <= 20 && (hh === undefined || (+hh <= +hg && +ah <= +ag)), 'invalid full/half score');
    const key = JSON.stringify([league,currentDate,home,away]);
    assert(!tuples.has(key), 'duplicate source event'); tuples.add(key);
    if (stage === 'excluded-playoff' || currentDate >= receivedAt.slice(0,10)) {
      excluded.push({line:lineNo,date:currentDate,reason:stage === 'excluded-playoff' ? stage : 'same-day-or-future-score'}); continue;
    }
    assert(currentDate.slice(0,4) === String(season), 'cross-year season requires explicit adapter');
    rows.push({id:hash(key),league,season,date:currentDate,home,away,homeGoals:+hg,awayGoals:+ag,
      sourceLine:lineNo,knownAt:receivedAt,historicalKnownAt:null,actualEndedAt:null,neutral:null,
      scoreScope:'community-ordinary-score-not-official-settlement'});
  }
  assert(rows.length > 0 && rows.length <= 1000, 'no usable or oversized source');
  return {rows,excluded};
}
function url(repo, commit, file) {
  const source = Object.values(SOURCES).find(s=>s.repo===repo && s.commit===commit);
  assert(source && (['LICENSE.md','README.md'].includes(file) || source.seasons.some(y=>file===`${source.directory}/${y}_${Object.keys(SOURCES).find(k=>SOURCES[k]===source)}.txt`)), 'source not allowlisted');
  return `https://raw.githubusercontent.com/openfootball/${repo}/${commit}/${file}`;
}
function download(sourceUrl) {
  assert(Object.values(SOURCES).some(s=>sourceUrl.startsWith(`https://raw.githubusercontent.com/openfootball/${s.repo}/${s.commit}/`)), 'fixed source required');
  const requestedAt = new Date().toISOString();
  return new Promise((resolve,reject)=>{
    let done=false; const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const req=https.get(sourceUrl,{headers:{'User-Agent':VERSION},timeout:20000},res=>{
      if(res.statusCode!==200){res.resume();finish(Error(`source HTTP ${res.statusCode}`));return;}
      const chunks=[];let size=0;
      res.on('data',b=>{size+=b.length;if(size>2*1024*1024)res.destroy(Error('source too large'));else chunks.push(b);});
      res.on('error',e=>finish(e));res.on('end',()=>finish(null,{raw:Buffer.concat(chunks),requestedAt,receivedAt:new Date().toISOString(),httpStatus:200}));
    });
    const timer=setTimeout(()=>req.destroy(Error('source deadline')),25000);
    req.on('timeout',()=>req.destroy(Error('source timeout')));req.on('error',e=>finish(e));
  });
}
async function collect(output) {
  assert(path.isAbsolute(output) && !fs.existsSync(output), 'new absolute output directory required');
  fs.mkdirSync(output,{recursive:true});
  const files=[], rows=[], excluded=[];
  for(const [league,source] of Object.entries(SOURCES)) {
    for(const file of ['LICENSE.md','README.md',...source.seasons.map(y=>`${source.directory}/${y}_${league}.txt`)]) {
      const sourceUrl=url(source.repo,source.commit,file), result=await download(sourceUrl);
      const saved=`${league}-${file.replaceAll('/','-')}`;
      fs.writeFileSync(path.join(output,saved),result.raw,{flag:'wx'});
      const receipt={league,file,saved,url:sourceUrl,commit:source.commit,sha256:hash(result.raw),bytes:result.raw.length,
        requestedAt:result.requestedAt,receivedAt:result.receivedAt,httpStatus:result.httpStatus};
      if(file==='LICENSE.md') assert(result.raw.toString('utf8').startsWith('CC0 1.0 Universal'), 'license changed');
      if(file.endsWith('.txt')) {
        const parsed=parseHistory(result.raw,{league,season:Number(path.basename(file).slice(0,4)),receivedAt:result.receivedAt});
        rows.push(...parsed.rows.map(row=>({...row,sourceSha256:receipt.sha256,sourceUrl})));excluded.push(...parsed.excluded.map(e=>({...e,file:saved})));
        receipt.rows=parsed.rows.length;receipt.excluded=parsed.excluded.length;
      }
      files.push(receipt);
    }
  }
  const body={version:VERSION,createdAt:new Date().toISOString(),license:'CC0-1.0',files,rows,excluded,
    sourceVerified:false,canonicalTeamMapping:false,historicalAsOfVerified:false,officialSettlementAllowed:false,
    formalEligible:false,productionWrites:0};
  const document={...body,contentHash:hash(JSON.stringify(body))};
  fs.writeFileSync(path.join(output,'history.json'),JSON.stringify(document,null,2),{flag:'wx'});
  return {output,contentHash:document.contentHash,rows:rows.length,excluded:excluded.length,
    coverage:Object.fromEntries(Object.keys(SOURCES).map(l=>[l,{rows:rows.filter(r=>r.league===l).length,lastDate:rows.filter(r=>r.league===l).map(r=>r.date).sort().at(-1)}]))};
}
if(require.main===module) collect(process.argv[2]).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={VERSION,SOURCES,hash,parseHistory,url,collect};
