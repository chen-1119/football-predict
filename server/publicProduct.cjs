'use strict';
// Public DTOs are allowlists. Never send full recommendation/collector payloads
// and rely on the browser to hide privileged fields.
const text=(value,max=160)=>typeof value==='string'?value.slice(0,max):null;
const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const completeOdds=odds=>odds&&[odds.home,odds.draw,odds.away].every(value=>value!==null&&value>1);
function publicFixture(match,now=Date.now()){
 if(!match||typeof match.id!=='string')return null;
 const fields=['id','sourceMatchId','matchNo','businessDate','homeTeamId','awayTeamId','homeTeamName','homeTeamNameEn','awayTeamName','awayTeamNameEn','homeTeamLogo','awayTeamLogo','homeTeamLogoType','awayTeamLogoType','leagueName','leagueNameEn','leagueId','status','effectiveStatus','kickoffTime','buyEndTime'];
 const row=Object.fromEntries(fields.map(key=>[key,text(match[key],key.endsWith('Logo')?500:160)]));
 row.homeTeamName=row.homeTeamName||'主队待更新';row.awayTeamName=row.awayTeamName||'客队待更新';
 if(['open','closed','awaiting','unknown'].includes(match.saleState))row.saleState=match.saleState;
 row.odds={home:finite(match.odds?.odds1)??finite(match.odds?.home),draw:finite(match.odds?.oddsX)??finite(match.odds?.draw),away:finite(match.odds?.odds2)??finite(match.odds?.away)};
 // Fixture observation clocks do not prove when the odds themselves changed.
 row.sourceUpdatedAt=iso(match.oddsUpdatedAt);
 const cutoff=Date.parse(match.buyEndTime||match.kickoffTime||'');
 row.quoteStatus=!completeOdds(row.odds)?'missing':!row.sourceUpdatedAt?'unverified':Number.isFinite(cutoff)&&now>=cutoff?'archived':now-Date.parse(row.sourceUpdatedAt)>15*60000?'expired':'recent';
 // Settlement is attached by the established result pipeline, not inferred here.
 return row;
}
function publicSummary(value){
 if(!value||!Number.isSafeInteger(value.settled)||value.settled<0||!Number.isSafeInteger(value.won)||value.won<0||value.won>value.settled)return null;
 return {published:Number.isSafeInteger(value.published)?value.published:null,settled:value.settled,won:value.won,lost:Number.isSafeInteger(value.lost)?value.lost:null,pending:Number.isSafeInteger(value.pending)?value.pending:null,void:Number.isSafeInteger(value.void)?value.void:null,disputed:Number.isSafeInteger(value.disputed)?value.disputed:null,hitRate:value.settled?value.won/value.settled:null};
}
function publicExample(row){
 const d=row?.decision,s=row?.settlement;
 if(!d||!['WON','LOST'].includes(s?.state)||!iso(d.publishedAt)||!iso(d.cutoffTime)||Date.parse(d.publishedAt)>=Date.parse(d.cutoffTime))return null;
 if(!text(d.decisionId)||!text(d.matchId))return null;
 return {decisionId:d.decisionId,matchId:d.matchId,homeTeamName:text(d.homeTeamName),awayTeamName:text(d.awayTeamName),matchNo:text(d.matchNo),publishedAt:d.publishedAt,cutoffTime:d.cutoffTime,kickoffTime:iso(d.kickoffTime),tipCode:['1','X','2'].includes(d.tipCode)?d.tipCode:null,odds:finite(d.odds),probabilities:{'1':finite(d.probabilities?.['1']),'X':finite(d.probabilities?.X),'2':finite(d.probabilities?.['2'])},quoteSource:text(d.quoteSource),quoteObservedAt:iso(d.quoteObservedAt),state:s.state,score:text(s.score),resultEventId:text(s.resultEventId),referenceOnly:true};
}
function publicOverview(current,payload,now=Date.now(),maxSourceAgeMs=20*60000){
 const center=payload?.recommendationCenter||payload;
 const examples=(center?.review?.singles||[]).map(publicExample).filter(Boolean).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||a.decisionId.localeCompare(b.decisionId));
 // A persisted healthy flag cannot keep an old fixture snapshot fresh forever.
 // Result/review clocks and odds clocks do not establish fixture freshness.
 const sourceUpdatedAt=iso(current?.sourceUpdatedAt);
 const sourceAgeMs=sourceUpdatedAt===null?NaN:now-Date.parse(sourceUpdatedAt);
 const sourceFresh=Number.isFinite(sourceAgeMs)&&sourceAgeMs>=0&&Number.isFinite(maxSourceAgeMs)&&maxSourceAgeMs>0&&sourceAgeMs<=maxSourceAgeMs;
 return {ok:true,version:'public-product-v1',businessDate:new Date(now+8*3600000).toISOString().slice(0,10),sourceUpdatedAt,stale:current?.stale!==false||!sourceFresh,matches:(current?.rows||[]).map(match=>publicFixture(match,now)).filter(Boolean),review:{updatedAt:iso(center?.resultAsOf),summary:publicSummary(center?.review?.statistics?.single),example:examples[0]||null},referenceOnly:true};
}
// Consume only the installed reader's verified display view, never raw collector
// payloads or editorial records. Schedule IDs use the existing detail route.
function publicOfficialCurrent(view,now=Date.now(),day=new Date(now+8*3600000).toISOString().slice(0,10)){
 require('../src/services/officialSchedule.cjs').validateOfficialSchedule(view,day,now);
 const rows=view.events.map(event=>{
  const had=event.markets.find(m=>m.poolCode==='HAD');
  return {id:`schedule_${day.replaceAll('-','')}_${event.eventId}`,sourceMatchId:event.eventId,
   businessDate:day,matchNo:event.matchNum,homeTeamId:String(event.homeTeamId),awayTeamId:String(event.awayTeamId),
   homeTeamName:event.homeTeamName,awayTeamName:event.awayTeamName,leagueName:event.leagueName,
   kickoffTime:event.kickoff,buyEndTime:event.saleCutoffAt,saleState:event.saleState,
   status:now<Date.parse(event.kickoff)?'SCHEDULED':'PENDING_RESULT',
   odds:had?{home:had.h,draw:had.d,away:had.a}:{home:null,draw:null,away:null},
   oddsUpdatedAt:had?view.quoteReceivedAt:null};
 });
 return {rows,sourceUpdatedAt:view.sourceReceivedAt,stale:false};
}
async function resolvePublicScheduleIdentity(id,{readNative,readOfficial,now=Date.now()}){
 if(!/^schedule_\d{8}_[1-9]\d{0,19}$/.test(id))return null;
 const [,stamp,eventId]=id.split('_');
 const day=require('./researchArchiveRead.cjs').day(`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}`);
 let signedMatch=null;
 try{signedMatch=publicOfficialCurrent(await readOfficial(day),now,day).rows.find(row=>row.id===id)||null;}
 catch{ /* Unavailable signed facts cannot establish a new identity. */ }
 const native=await readNative(`sporttery_${eventId}`);
 return native&&native.businessDate===day&&String(native.sourceMatchId)===eventId
  &&Number.isFinite(Date.parse(native.kickoffTime))
  &&(!native.eventVersion||Date.parse(native.eventVersion)===Date.parse(native.kickoffTime))
  &&(!signedMatch||(Date.parse(native.kickoffTime)===Date.parse(signedMatch.kickoffTime)
    &&native.homeTeamName===signedMatch.homeTeamName&&native.awayTeamName===signedMatch.awayTeamName))?{...native,id}:signedMatch;
}
module.exports={publicFixture,publicSummary,publicExample,publicOverview,publicOfficialCurrent,resolvePublicScheduleIdentity};
