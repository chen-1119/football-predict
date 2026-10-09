'use strict';
// Reviewed editorial directions have no learned probability or calibration claim.
const {hash,sha,seal}=require('../../src/services/leagueBaselineModel.cjs');
const had=require('./liveOfficialHad.cjs');
const {quoteInput}=require('../../src/services/prdPaperRecommendation.cjs');
const {day}=require('../../src/services/publishedForecastPolicy.cjs');
const check=(v,c)=>{if(!v)throw Object.assign(Error('REVIEWED_ANALYSIS_'+c),{code:'REVIEWED_ANALYSIS_'+c});};
const text=(v,n=500)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x08\ufffd]/.test(v);
const safeUrl=v=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
function validateDraft(d,asOf){
 check(d?.version===1&&d.reportKind==='weekday-2000-selected-two'&&d.predictionScope==='chat-only research','DRAFT_KIND');
 check(d.businessDate===day(Date.parse(asOf))&&Date.parse(d.frozenAt)<=Date.parse(asOf)&&Number.isFinite(Date.parse(d.frozenAt)),'DRAFT_CLOCK');
 check(Array.isArray(d.singles)&&d.singles.length>0&&d.singles.length<=32,'ROWS');
 const seen=new Set();
 for(const r of d.singles){
  check(/^\d{1,20}$/.test(r.eventId)&&!seen.has(r.eventId),'EVENT');seen.add(r.eventId);
  check(r.businessDate===d.businessDate&&['h','d','a'].includes(r.selection)&&r.market==='HAD'&&r.handicap===null,'MARKET');
  check(r.formalEligible===false&&r.modelVersion===null&&r.modelProbability===null&&r.classification==='manual-prematch-research','HONEST_SOURCE');
  check(text(r.reason)&&safeUrl(r.analysisUrl)&&['高','中','低'].includes(r.confidence),'EVIDENCE');
  check(Array.isArray(r.teams)&&r.teams.length===2&&r.teams.every(v=>text(v,100))&&Array.isArray(r.orderedTeamIds)&&r.orderedTeamIds.length===2&&r.orderedTeamIds.every(v=>Number.isSafeInteger(v)&&v>0),'TEAMS');
  check(Array.isArray(r.scores)&&r.scores.length===2&&new Set(r.scores.map(v=>JSON.stringify(v))).size===2,'SCORES');
  for(const s of r.scores)check(Array.isArray(s)&&s.length===2&&s.every(v=>Number.isInteger(v)&&v>=0&&v<=15)&&(s[0]===s[1]?'d':s[0]>s[1]?'h':'a')===r.selection,'SCORE_DIRECTION');
  check(Number.isFinite(r.sp)&&r.sp>1&&r.sp<1000&&Date.parse(d.frozenAt)<Date.parse(r.kickoff),'ORIGINAL_PRICE_CLOCK');
 }
 return true;
}
function make(draft,{matches,snapshot,trustRegistry,asOf}){
 validateDraft(draft,asOf);check(Buffer.byteLength(JSON.stringify({draft,matches,snapshot}))<=8*1024*1024,'BOUND');
 const endpoints=snapshot?.endpoints?.filter(e=>e.method==='current');check(endpoints?.length===1,'ENDPOINT');
 const records=draft.singles.map(r=>{
  const candidates=matches.filter(m=>String(m.sourceMatchId||'').replace(/^sporttery_/,'')===r.eventId&&Date.parse(m.eventVersion||m.kickoffTime)===Date.parse(r.kickoff));
  check(candidates.length===1,'CANONICAL_EVENT');const input=quoteInput(candidates[0]);check(input,'PROSPECTIVE');
  input.sourceMatchId=String(input.sourceMatchId).replace(/^sporttery_/,'');input.eventVersion=input.eventVersion||input.kickoffTime;
  const identity=had.verifySignedCurrentEventIdentity(input,endpoints[0],{asOf,trustRegistry});check(identity,'SIGNED_IDENTITY');
  const raw=endpoints[0].payload.value.matchInfoList.flatMap(g=>g.subMatchList).filter(m=>String(m.matchId)===r.eventId);
  check(raw.length===1&&[raw[0].homeTeamId,raw[0].awayTeamId].every((v,i)=>String(v)===String(r.orderedTeamIds[i]))
   &&[input.homeTeamName,input.awayTeamName].every((v,i)=>v===r.teams[i])&&identity.identity.matchNo===r.matchNum,'ORDERED_TEAMS');
  const joined=had.joinOfficialHad([input],snapshot,{now:Date.parse(asOf),trustRegistry}).current[0];
  const quote=had.signedLiveHadQuoteForMatch(joined,Date.parse(asOf),Date.parse(identity.saleCutoff),{trustRegistry});check(quote,'SIGNED_PRICE');
  const sp=quote.odds[{h:'odds1',d:'oddsX',a:'odds2'}[r.selection]];
  return {eventId:r.eventId,eventVersion:identity.identity.eventVersion,businessDate:r.businessDate,matchNum:r.matchNum,
   homeTeamId:input.homeTeamId,awayTeamId:input.awayTeamId,homeTeamName:r.teams[0],awayTeamName:r.teams[1],
   market:'HAD',selection:r.selection,sp,originalSp:r.sp,scores:r.scores,confidence:r.confidence,reason:r.reason,
   analysisUrl:r.analysisUrl,limitations:['完整近5场双源未核实','首发未确认','500 SP未核实；采用官方报价'],
   cutoffAt:identity.saleCutoff,quoteObservedAt:quote.at,quoteHash:quote.receipt.receiptHash,
   publicationMethod:'reviewed-editorial',modelVersion:null,modelProbability:null,formalEligible:false};
 });
 return seal({version:'reviewed-analysis-publication-v1',createdAt:asOf,businessDate:draft.businessDate,
  draftHash:hash(draft),originalFrozenAt:draft.frozenAt,records,modelProbability:null,formalEligible:false});
}
function combinations(records){
 const options=[];
 for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
  const legs=[records[i],records[j]],product=Math.round(legs[0].sp*1000)*Math.round(legs[1].sp*1000)/1e6;
  options.push({legs:legs.map(r=>({eventId:r.eventId,matchNum:r.matchNum,market:r.market,selection:r.selection,sp:r.sp})),product,
   confidence:legs.some(r=>r.confidence==='低')?'低':legs.some(r=>r.confidence==='中')?'中':'高'});
 }
 // Same two legs may occupy one band only; never alter an original direction.
 const used=new Set();return [2.5,5,10].map(band=>{
  const v=options.filter(o=>o.product>=band&&!used.has(o)).sort((a,b)=>({高:0,中:1,低:2}[a.confidence]-{高:0,中:1,低:2}[b.confidence])||a.product-b.product)[0];
  if(v)used.add(v);return v?{band,...v}:{band,legs:[],product:null,confidence:null};
 });
}
module.exports={check,hash,sha,seal,validateDraft,make,combinations};
