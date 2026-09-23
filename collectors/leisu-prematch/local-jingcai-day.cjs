'use strict';
// Pure official betting-day selection; the server does not load the browser collector.
const {windowFor}=require('./scope.cjs');
const beijingDay=now=>new Date(Number(now)+8*3600000).toISOString().slice(0,10);
const validDay=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function selectDay(matches,businessDate,now=Date.now()){
 if(!validDay(businessDate)||!Array.isArray(matches))throw Error('Invalid official business date or roster');
 const groups=new Map();
 for(const row of matches){if(row?.businessDate!==businessDate)continue;const id=row.id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);}
 if(groups.size>500)throw Error('Unexpected official roster size');
 return [...groups].map(([id,rows])=>{
  const row=rows[0],sourceMatchId=String(row.sourceMatchId||'');let kickoffMs=NaN;
  try{kickoffMs=Date.parse(windowFor(row.kickoffTime).nowUtc);}catch{}
  let reason=null;
  if(!/^sporttery_[1-9][0-9]*$/.test(id||'')||id!==`sporttery_${sourceMatchId}`)reason='invalid-official-identity';
  else if(new Set(rows.map(r=>JSON.stringify(r))).size>1)reason='conflicting-official-identity';
  else if(!row.homeTeamName||!row.awayTeamName||row.homeTeamName===row.awayTeamName)reason='invalid-official-teams';
  else if(!/(?:Z|[+-]\d\d:\d\d)$/.test(row.kickoffTime||'')||!Number.isFinite(kickoffMs)||row.eventVersion&&Date.parse(row.eventVersion)!==kickoffMs)reason='invalid-official-kickoff';
  else if([row.status,row.effectiveStatus,row.sourceStatus].filter(Boolean).some(s=>s!=='SCHEDULED')||!row.status)reason='not-scheduled';
  else if(kickoffMs<=now)reason='already-started';
  return {siteMatchId:id,sourceMatchId,businessDate,matchNo:row.matchNo||null,league:row.leagueName||null,
   homeName:row.homeTeamName,awayName:row.awayTeamName,kickoffUtc:Number.isFinite(kickoffMs)?new Date(kickoffMs).toISOString():null,
   eventVersion:Number.isFinite(kickoffMs)?new Date(kickoffMs).toISOString():null,eligible:!reason,reason};
 }).sort((a,b)=>String(a.kickoffUtc).localeCompare(String(b.kickoffUtc))||String(a.siteMatchId).localeCompare(String(b.siteMatchId)));
}
module.exports={beijingDay,validDay,selectDay};
