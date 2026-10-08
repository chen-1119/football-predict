'use strict';
const m=require('./leagueBaselineModel.cjs');
const {quoteInput,pricesFor}=require('./prdPaperRecommendation.cjs');
const {verifySignedCurrentEventIdentity}=require('../../scripts/recommendationPlatform/liveOfficialHad.cjs');
const opening=require('./sportteryOpeningPolicy.cjs');
const VERSION='league-baseline-recommendation-v1';
function make({packet,match,snapshot,trustRegistry,asOf}){
  m.check(Buffer.byteLength(JSON.stringify({packet,match,snapshot}))<=8*1024*1024,'INPUT_BOUND');
  m.check(m.verifyPacket(packet,asOf).valid,'PACKET_INVALID');
  const input=quoteInput(match);m.check(input,'PROSPECTIVE_IDENTITY');
  input.sourceMatchId=String(input.sourceMatchId||'').replace(/^sporttery_/,'');
  input.eventVersion=input.eventVersion||input.kickoffTime;
  const endpoints=snapshot?.endpoints?.filter(e=>e.method==='current');m.check(endpoints?.length===1,'CURRENT_ENDPOINT');
  const identity=verifySignedCurrentEventIdentity(input,endpoints[0],{asOf,trustRegistry});m.check(identity,'SIGNED_EVENT');
  const rows=endpoints[0].payload.value.matchInfoList.flatMap(g=>g.subMatchList).filter(r=>String(r.matchId)===input.sourceMatchId);
  const leagueName=String(rows[0]?.leagueAllName||rows[0]?.leagueAbbName||'').trim();
  const leagueId=require('../../scripts/storedResultTeamIdentity.cjs').derivedTeamId(leagueName).replace(/^team_/,'league_');
  m.check(rows.length===1&&leagueName&&leagueId===match.leagueId,'SIGNED_LEAGUE');
  input.leagueId=leagueId;input.neutral=match.neutral;
  m.check(opening.assessOpening({businessDate:input.businessDate,asOf}).eligible,'BEFORE_OPENING');
  // Obtain the line only from the signed join. A display/frozen line is not a
  // current price observation. An unavailable HHAD leaves that market absent.
  const audit={};
  const joined=require('../../scripts/recommendationPlatform/liveOfficialHandicap.cjs').joinOfficialHandicap([input],snapshot,
    {now:Date.parse(asOf),trustRegistry,audit});
  input.handicapLine=audit.reasonCounts?.['hhad-applied']===1?Number(joined[0].handicapLine):null;
  const forecast=m.forecast(packet,input,{asOf,cutoffAt:identity.saleCutoff,inputHash:m.hash({input,identity:identity.contentHash})});
  const codes=p=>({H:p['1'],D:p.X,A:p['2']});
  const grid={had:codes(forecast.grid.had),hhad:{probabilities:codes(forecast.grid.hhad?.probabilities||forecast.grid.had)},tailMass:forecast.grid.tailMass};
  const bound={input,cutoffTime:identity.saleCutoff,event:{sourceMatchId:input.sourceMatchId,businessDate:input.businessDate}};
  const markets=pricesFor({forecast:{grid,asOf,event:{integerHandicap:input.handicapLine||0}},quoteSnapshot:snapshot,
    openingProjection:{version:opening.VERSION,businessDate:input.businessDate,openingAt:opening.openingAtForBusinessDate(input.businessDate)}},bound,asOf,trustRegistry);
  m.check(Object.values(markets).some(v=>v.quote),'NO_SIGNED_PRICE');
  const comparisons=Object.values(markets).map(v=>({market:v.market,handicapLine:v.handicapLine,quote:v.quote,options:v.options,reasons:v.reasons}));
  // Each market is evaluated separately. HAD model tendency is never replaced
  // by a larger HHAD marginal probability; the price screen remains research.
  const body={version:VERSION,createdAt:asOf,businessDate:input.businessDate,
    id:'league-forecast-'+m.hash([forecast.event,packet.contentHash]),modelVersion:packet.version,
    modelHash:packet.contentHash,parametersHash:packet.parametersHash,forecastHash:forecast.contentHash,
    homeTeamName:input.homeTeamName,awayTeamName:input.awayTeamName,forecast,comparisons,
    scope:'trained-baseline-reference',formalEligible:false,optionalFactorsUsed:[],
    registryKey:m.KEY(packet.league),identityHash:identity.contentHash};
  return m.seal(body);
}
function verify(record,inputs){try{return m.hash(make({...inputs,asOf:record.createdAt}))===m.hash(record);}catch{return false;}}
module.exports={VERSION,make,verify};
