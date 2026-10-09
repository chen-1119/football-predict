'use strict';
// Pure parser shared by local research and the installed evidence collector.
const crypto=require('node:crypto'),assert=require('node:assert/strict');
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
module.exports={parse,LEAGUES,hash,instant,date};
