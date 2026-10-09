'use strict';
const {hash}=require('../../src/services/publishedForecastPolicy.cjs');
const FIELDS=['伤停/停赛','近5场','历史交锋','积分排名与战意','盘口与赔率变化','500交叉核对'];
const PROVIDERS={'500.com':'500','sporttery.cn':'sporttery','dongqiudi.com':'dongqiudi','cbf.com.br':'cbf',
 'veikkausliiga.com':'veikkausliiga','uefa.com':'uefa','fifa.com':'fifa','jleague.jp':'jleague','kleague.com':'kleague',
 'premierleague.com':'premierleague','laliga.com':'laliga','bundesliga.com':'bundesliga','legaseriea.it':'seriea','ligue1.com':'ligue1'};
function provider(url){try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
 return Object.entries(PROVIDERS).find(([host])=>u.hostname===host||u.hostname.endsWith('.'+host))?.[1]||null;}catch{return null;}}
const seal=body=>({...body,contentHash:hash(body)});
function valid(record,event,now){try{
 const {contentHash,...body}=record;
 if(contentHash!==hash(body)||record.version!=='daily-source-evidence-v1'||typeof record.reviewedBy!=='string'||!record.reviewedBy||record.reviewedBy.length>120
  ||['sourceMatchId','eventVersion','homeTeamId','awayTeamId','businessDate'].some(k=>typeof record[k]!=='string'||!record[k]||record[k].length>160)
  ||record.homeTeamId===record.awayTeamId||!Number.isFinite(Date.parse(event.cutoffTime))||record.cutoffTime!==event.cutoffTime
  ||!record.identityVerified||record.sourceMatchId!==event.sourceMatchId||record.eventVersion!==event.eventVersion
  ||record.homeTeamId!==event.homeTeamId||record.awayTeamId!==event.awayTeamId||record.businessDate!==event.businessDate
  ||!Number.isFinite(Date.parse(record.createdAt))||Date.parse(record.createdAt)>now||Date.parse(record.createdAt)>=Date.parse(event.cutoffTime)
  ||!Array.isArray(record.facts)||record.facts.length!==FIELDS.length||record.facts.some((f,i)=>f.name!==FIELDS[i]))return false;
 return record.facts.every(f=>['unverified','verified'].includes(f.status)&&typeof f.text==='string'&&f.text.length<=1000
  &&Array.isArray(f.sources)&&f.sources.length<=5&&f.sources.every(s=>provider(s.url)===s.provider&&s.provider
   &&/^[a-f0-9]{64}$/.test(s.bodyHash)&&Number.isFinite(Date.parse(s.fetchedAt))&&Date.parse(s.fetchedAt)<=Date.parse(record.createdAt)
   &&Date.parse(record.createdAt)-Date.parse(s.fetchedAt)<=3600000&&s.excerptMatched===true&&s.value===f.text
   &&s.modelGenerated===false&&s.independent===true&&typeof s.origin==='string'&&s.origin.length>0&&s.origin.length<=120)
  &&(f.status!=='verified'||(f.sources.length>=2&&new Set(f.sources.map(s=>s.provider)).size>=2&&new Set(f.sources.map(s=>s.origin)).size>=2
   &&(f.name!=='伤停/停赛'||f.sources.every(s=>Number.isFinite(Date.parse(s.publishedAt))&&Date.parse(s.publishedAt)<=now&&now-Date.parse(s.publishedAt)<=3*86400000))
   &&(f.name!=='500交叉核对'||f.sources.some(s=>s.provider==='500')&&f.sources.some(s=>s.provider==='sporttery'))
   &&(f.name!=='盘口与赔率变化'||f.timeSeriesVerified===true))));
 }catch{return false;}}
function facts(record,event,now){return valid(record,event,now)?record.facts:FIELDS.map(name=>({name,status:'unverified',text:'未核实',sources:[]}));}
module.exports={FIELDS,PROVIDERS,provider,seal,valid,facts};
