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
function publicOverview(current,payload,now=Date.now()){
 const center=payload?.recommendationCenter||payload;
 const examples=(center?.review?.singles||[]).map(publicExample).filter(Boolean).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||a.decisionId.localeCompare(b.decisionId));
 return {ok:true,version:'public-product-v1',businessDate:new Date(now+8*3600000).toISOString().slice(0,10),sourceUpdatedAt:iso(current?.sourceUpdatedAt),stale:current?.stale!==false,matches:(current?.rows||[]).map(match=>publicFixture(match,now)).filter(Boolean),review:{updatedAt:iso(center?.resultAsOf),summary:publicSummary(center?.review?.statistics?.single),example:examples[0]||null},referenceOnly:true};
}
module.exports={publicFixture,publicSummary,publicExample,publicOverview};
