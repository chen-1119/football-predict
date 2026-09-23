'use strict';
// Public day coverage is a view of the complete Sporttery target pool. It
// never creates a decision, changes qualification or counts a missing target
// as a successful empty recommendation day.
const {day,time,evaluateForecast}=require('../src/services/publishedForecastPolicy.cjs');
const {parseLine}=require('../src/services/handicapMarginDecision.cjs');

const VERSION='recommendation-day-coverage-v1';
const MISSING_LIMIT=100;
const TEXT=Object.freeze({
  'after-cutoff':'已过赛前截止时间，未形成可用推荐',
  'not-pregame':'比赛已开赛或结束，未形成赛前推荐',
  'not-on-sale':'当前不在销售状态，暂未入选',
  'team-identity-invalid':'球队信息未核实，暂未入选',
  'identity-missing':'比赛编号缺失，暂未入选',
  'event-version-conflict':'比赛时间变更待核对，暂未入选',
  'conflicting-event-identity':'比赛身份或时间存在冲突，暂未入选',
  'cutoff-invalid':'赛前截止时间未核实，暂未入选',
  'model-data-invalid-or-stale':'模型数据不足或已过期，暂未入选',
  'model-event-conflict':'模型与当前比赛时间不一致，暂未入选',
  'model-match-conflict':'模型与当前比赛身份不一致，暂未入选',
  'no-unique-first-direction':'方向没有明确领先，暂未入选',
  'official-had-quote-unavailable':'赛前 SP 尚未取得或已过期，暂未入选',
  'publication-identity-missing':'本轮数据发布尚未完成，暂未入选',
  'input-evidence-unavailable':'模型输入证据不足，仅供参考',
  'input-arithmetic-unverified':'模型输入计算尚未核验，仅供参考',
  'team-samples-insufficient':'球队历史样本不足，仅供参考',
  'awaiting-publication':'正在等待赛前推荐发布',
  'input-invalid':'比赛输入未通过核验，暂未入选',
});
const sourceId=value=>String(value??'').trim().replace(/^sporttery_/,'');
const rawDate=row=>String(row?.businessDate||row?.matchDate||row?.kickoffDate||'').slice(0,10)
  ||(Number.isFinite(time(row?.kickoffTime))?day(time(row.kickoffTime)):null);
const eventMs=row=>time(row?.eventVersion||row?.kickoffTime);
const hasCollectedHhadQuote=(row,now)=>{
  // Preserve the source observation: a later relay receipt is not a new quote.
  const odds=row?.handicapOdds,observed=time(row?.handicapOddsObservedAt||row?.handicapOddsUpdatedAt||row?.handicapOddsReceivedAt);
  const deadline=Math.min(...[row?.kickoffTime,row?.buyEndTime,row?.predictionMeta?.cutoffTime].map(time).filter(Number.isFinite));
  return ['sporttery:HHAD','500.com:HHAD'].includes(row?.handicapOddsSource)
    && (!row?.handicapOddsPoolCode||row.handicapOddsPoolCode==='HHAD')
    && parseLine(row?.handicapLine)!==null
    && ['odds1','oddsX','odds2'].every(key=>typeof odds?.[key]==='number'&&Number.isFinite(odds[key])&&odds[key]>1)
    && Number.isFinite(deadline)&&Number.isFinite(observed)&&observed<=now&&observed<deadline;
};

function uniqueTargets(targetRows,businessDate){
  const groups=new Map();let index=0;
  for(const entry of targetRows||[]){
    const row=entry?.payload||entry;
    if(!row||typeof row!=='object'||rawDate(row)!==businessDate)continue;
    const id=sourceId(row.sourceMatchId||row.id),key=id||`missing-id:${index}`;
    const group=groups.get(key)||[];group.push({row,dataset:entry?.dataset||'current',index});groups.set(key,group);index++;
  }
  return [...groups].map(([sourceMatchId,group])=>{
    const current=group.filter(item=>item.dataset==='current');
    const preferred=current.length?current:group;
    const identities=new Set(preferred.map(({row})=>JSON.stringify([eventMs(row),row.homeTeamId,row.awayTeamId])));
    return {sourceMatchId,row:preferred[0].row,conflict:identities.size>1};
  }).sort((a,b)=>(eventMs(a.row)||Infinity)-(eventMs(b.row)||Infinity)||a.sourceMatchId.localeCompare(b.sourceMatchId));
}

function reasonForUnpublished(row,{now,publication,conflict}){
  if(conflict)return 'conflicting-event-identity';
  try{
    const assessment=evaluateForecast(row,{now,publication});
    return assessment.eligible?'awaiting-publication':(TEXT[assessment.reason]?assessment.reason:'input-invalid');
  }catch{return 'input-invalid';}
}

function buildDataCoverage({targetRows,singles=[],now,lanes={}}={}){
  if(!Number.isFinite(now)||!Array.isArray(targetRows)||!Array.isArray(singles))throw new TypeError('Current targets, decisions and finite clock required');
  const businessDate=day(now),targets=uniqueTargets(targetRows,businessDate),published=new Map();
  for(const record of singles){
    const d=record?.decision;
    if(d?.businessDate!==businessDate)continue;
    const id=sourceId(d.sourceMatchId),at=eventMs(d);if(!id||!Number.isFinite(at))continue;
    const key=JSON.stringify([id,at]),old=published.get(key);
    if(!old||time(d.publishedAt)>time(old.decision.publishedAt))published.set(key,record);
  }
  let publishableCount=0,qualifiedCount=0;
  const missing=[];
  for(const target of targets){
    const row=target.row,at=eventMs(row),key=JSON.stringify([target.sourceMatchId,at]);
    const record=!target.conflict&&Number.isFinite(at)?published.get(key):null;
    if(record)publishableCount++;
    if(record?.selectionQuality?.qualified===true){qualifiedCount++;continue;}
    const reasonCode=record
      ? record.selectionQuality?.reasons?.find(code=>TEXT[code])||'input-evidence-unavailable'
      : reasonForUnpublished(row,{now,publication:lanes.publish?.publication,conflict:target.conflict});
    const stableSourceId=sourceId(row.sourceMatchId||row.id);
    const storedMatchId=String(row.id??'').trim();
    const reasonText=reasonCode==='official-had-quote-unavailable' && hasCollectedHhadQuote(row,now)
      ? '普通胜平负 SP 缺失；让球盘有采集记录，但当前没有可发布的独立让球推荐'
      : TEXT[reasonCode];
    missing.push({matchId:storedMatchId&&sourceId(storedMatchId)?storedMatchId:(stableSourceId?`sporttery_${stableSourceId}`:null),sourceMatchId:stableSourceId||null,
      homeTeamName:String(row.homeTeamName||''),awayTeamName:String(row.awayTeamName||''),reasonCode,reasonText});
  }
  const targetCount=targets.length,unqualifiedCount=targetCount-qualifiedCount;
  return {version:VERSION,businessDate,targetCount,publishableCount,qualifiedCount,unqualifiedCount,
    coverageRatio:targetCount?qualifiedCount/targetCount:null,updatedAt:new Date(now).toISOString(),
    missingTotal:missing.length,hasMore:missing.length>MISSING_LIMIT,missing:missing.slice(0,MISSING_LIMIT)};
}
module.exports={VERSION,MISSING_LIMIT,buildDataCoverage,uniqueTargets};
