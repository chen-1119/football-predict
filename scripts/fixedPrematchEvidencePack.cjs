'use strict';
// Read-only research preparation. Never emits a direction or authorizes publication.
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {verifySignedCurrentEndpointIdentity}=require('./recommendationPlatform/liveOfficialHad.cjs');
const {normalizedImplied}=require('./marketFeatureLogic.cjs');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const instant=v=>{assert(typeof v==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(v),'timezone required');const t=Date.parse(v);assert(Number.isFinite(t),'invalid clock');return t;};
const odds=p=>{if(!p||[p.h,p.d,p.a].some(v=>!['number','string'].includes(typeof v)||!/^\d+(?:\.\d{1,4})?$/.test(String(v))))return null;const o={odds1:Number(p?.h),oddsX:Number(p?.d),odds2:Number(p?.a)};return Object.values(o).every(v=>Number.isFinite(v)&&v>1)?o:null;};
const unknown=()=>Object.fromEntries(['recentFive','rank','headToHead','injuries','confirmedLineup','xg','fatigue','weather','referee'].map(k=>[k,{status:'unverified',value:null}]));
function compareQuote(event, official, pool, candidates, asOf){
 const rows=candidates.filter(r=>String(r.quote?.sourceMatchId)===event.eventId&&r.quote?.pool===pool.toLowerCase());
 if(rows.length!==1)return {status:rows.length?'ambiguous':'missing',source:'500.com:jczq'};
 const r=rows[0],q=r.quote;
 const line=pool==='HHAD'?Number(official.goalLine):null;
 const exact=q.source==='500.com:jczq'&&q.homeTeamName===event.teams[0]&&q.awayTeamName===event.teams[1]
  &&Date.parse(q.kickoffTime)===Date.parse(event.kickoff)&&q.matchNo===event.matchNum
  &&(pool==='HAD'||(q.handicapLine!==null&&q.handicapLine!==undefined&&Number(q.handicapLine)===line));
 if(!exact)return {status:'identity-conflict',source:'500.com:jczq'};
 let t=NaN;try{t=instant(r.observed_at);}catch{/* Missing time zone is not a trusted observation. */}
 if(!Number.isFinite(t)||t>Date.parse(asOf)||Date.parse(asOf)-t>15*60000)return {status:'stale-or-invalid-clock',observedAt:r.observed_at};
 const other={odds1:q.odds1,oddsX:q.oddsX,odds2:q.odds2};
 if(!Object.values(other).every(v=>typeof v==='number'&&Number.isFinite(v)&&v>1))return {status:'invalid-price'};
 const current=odds(official);if(!current)return {status:'official-price-unavailable'};
 const delta=Object.fromEntries(Object.keys(current).map(k=>[k,Math.round((other[k]-current[k])*1e6)/1e6]));
 return {status:Object.values(delta).every(v=>v===0)?'agree':'price-difference',source:q.source,observedAt:r.observed_at,
  odds:other,delta,sourcePayloadHash:hash(q),officialTakesPrecedence:true,independentUpstreamProven:false,
  history:null,historyStatus:r.payload?'stored-feature-awaiting-raw-history-replay':'missing',storedFeatureHash:r.payload?hash(r.payload):null};
}
function buildPack(capture,{trustRegistry,asOf=capture.observedAt,businessDate}={}){
 const at=instant(asOf);assert(/^\d{4}-\d{2}-\d{2}$/.test(businessDate),'business date');
 assert(new Date(at+8*3600000).toISOString().slice(0,10)===businessDate,'day mismatch');
 assert(instant(capture.observedAt)<=at&&at-instant(capture.observedAt)<=15*60000,'capture expired');
 assert(Array.isArray(capture.markets)&&capture.markets.length<=256,'market bound');
 const endpoints=capture.snapshot?.endpoints?.filter(e=>e.method==='current');assert(endpoints?.length===1,'one current endpoint');
 const endpoint=endpoints[0];assert(verifySignedCurrentEndpointIdentity(endpoint,{asOf,trustRegistry}),'signed current endpoint');
 const all=endpoint.payload.value.matchInfoList.flatMap(g=>g.subMatchList.map(r=>({...r,businessDate:r.businessDate||g.businessDate})));
 const ids=new Set(),records=[];
 for(const r of all.filter(r=>r.businessDate===businessDate)){
  const id=String(r.matchId);assert(!ids.has(id),'duplicate event');ids.add(id);
  const kickoff=r.matchDate+'T'+r.matchTime+'+08:00';instant(kickoff);
  const event={eventId:id,matchNum:r.matchNumStr,teams:[r.homeTeamAllName,r.awayTeamAllName],orderedTeamIds:[r.homeTeamId,r.awayTeamId],businessDate,kickoff,league:r.leagueAllName};
  const midnight=Date.parse(businessDate+'T00:00:00+08:00'),weekday=new Date(midnight+8*3600000).getUTCDay();
  const deadlines=[Date.parse(kickoff),midnight+([0,6].includes(weekday)?23:22)*3600000];
  for(const key of ['buyEndTime','matchEndTime','sellEndTime','stopSaleTime','endTime'])if(r[key]!=null&&r[key]!==''){
   try{deadlines.push(instant(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r[key])?r[key].replace(' ','T')+'+08:00':r[key]));}catch{deadlines.push(NaN);}
  }
  const cutoff=Math.min(...deadlines),active=Number(r.sellStatus)===1&&r.matchStatus==='Selling'&&Number.isFinite(cutoff)&&at<cutoff;
  const markets={};for(const pool of ['HAD','HHAD']){
   const quotes=(r.oddsList||[]).filter(o=>o.poolCode===pool),sales=(r.poolList||[]).filter(o=>o.poolCode===pool);
   const q=quotes.length===1?quotes[0]:null,o=odds(q),line=pool==='HHAD'&&q?.goalLine!=null&&q.goalLine!==''?Number(q.goalLine):null;
   const available=active&&q&&o&&sales.length===1&&sales[0].poolStatus==='Selling'&&[sales[0].cbtValue,sales[0].cbtAllUp].every(v=>v===1||v==='1')
    &&(pool==='HAD'||(q.goalLine!==''&&q.goalLine!=null&&Number.isSafeInteger(line)&&line!==0&&Math.abs(line)<=12));
   markets[pool]={status:available?'available':'unavailable',handicapLine:line,odds:available?o:null,
    devig:available?normalizedImplied(o):null,probabilityKind:'market-implied-not-model',observedAt:endpoint.receivedAt,
    comparison:available?compareQuote(event,q,pool,capture.markets,asOf):null};
  }
  const published=(capture.reviewed?.records||[]).filter(p=>p.eventId===id&&p.businessDate===businessDate&&Date.parse(p.eventVersion)===Date.parse(kickoff)
   &&p.homeTeamName===event.teams[0]&&p.awayTeamName===event.teams[1]);
  assert(published.length<=1,'duplicate published event');
  records.push({...event,saleState:active?'selling':'not-selling',markets,fields:unknown(),
   recommendation:{status:published.length?'published-reviewed':active?'analysis-needed':'closed-no-backfill',record:published[0]||null},
   sourceRowHash:hash(r),formalEligible:false});
 }
 const body={version:'fixed-prematch-evidence-pack-v1',businessDate,asOf,captureHash:hash(capture),
  officialEndpointHash:hash(endpoint),sourceVerification:'collector-signature-not-provider-signature',
  snapshotStorage:'existing-PG-compressed-price-states;not-hourly-continuous-observations',records,
  productionWrites:0,modelProbabilityGenerated:false};return {...body,contentHash:hash(body)};
}
module.exports={buildPack,compareQuote,hash};
