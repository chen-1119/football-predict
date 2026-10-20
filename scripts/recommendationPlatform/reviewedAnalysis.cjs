'use strict';
// Reviewed editorial directions have no learned probability or calibration claim.
const {hash,sha,seal}=require('../../src/services/leagueBaselineModel.cjs');
const had=require('./liveOfficialHad.cjs');
const {quoteInput}=require('../../src/services/prdPaperRecommendation.cjs');
const {day}=require('../../src/services/publishedForecastPolicy.cjs');
const check=(v,c)=>{if(!v)throw Object.assign(Error('REVIEWED_ANALYSIS_'+c),{code:'REVIEWED_ANALYSIS_'+c});};
const text=(v,n=500)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x08\ufffd]/.test(v);
const safeUrl=v=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const draftSupportsHandicap=d=>d.version===3||d.version===4;
const scoreDirection=(s,line)=>s[0]+line===s[1]?'d':s[0]+line>s[1]?'h':'a';
function validateDraft(d,asOf){
 check((d?.version===1&&d.reportKind==='weekday-2000-selected-two'&&d.predictionScope==='chat-only research')
  ||(d?.version===2&&d.reportKind==='evidence-backed-prematch'&&d.predictionScope==='reviewed-online-reference')
  ||([3,4].includes(d?.version)&&d.reportKind==='manual-prematch-batch'&&d.predictionScope==='reviewed-online-reference'),'DRAFT_KIND');
 if(d.version===4)check(d.eventAuthority==='signed-official-events-v1','OFFICIAL_EVENT_VERSION');
 if(d.version===3||d.version===4){
  check(typeof d.originalArchive==='string'&&Buffer.byteLength(d.originalArchive)<=384*1024
   &&sha(d.originalArchive)===d.originalArchiveSha256,'ORIGINAL_ARCHIVE');
  let original;try{original=JSON.parse(d.originalArchive);}catch{check(false,'ORIGINAL_ARCHIVE');}
  check(original?.version===1&&['morning-1100-review-and-early','weekday-2000-selected-two','weekday-2100-full',
   'weekend-2100-selected-two','weekend-2200-full','on-demand-prematch-supplement'].includes(original.reportKind)
   &&['chat-only research','chat-only manual research'].includes(original.predictionScope)
   &&original.businessDate===d.businessDate&&original.frozenAt===d.frozenAt
   &&Array.isArray(original.singles)&&hash(original.singles.map(r=>({...r,classification:'manual-prematch-research'})))===hash(d.singles),'ORIGINAL_BINDING');
 }
 check(d.businessDate===day(Date.parse(asOf))&&Date.parse(d.frozenAt)<=Date.parse(asOf)&&Number.isFinite(Date.parse(d.frozenAt)),'DRAFT_CLOCK');
 check(Array.isArray(d.singles)&&d.singles.length>0&&d.singles.length<=32,'ROWS');
 const seen=new Set();
 for(const r of d.singles){
  check(/^\d{1,20}$/.test(r.eventId)&&!seen.has(r.eventId),'EVENT');seen.add(r.eventId);
  check(r.businessDate===d.businessDate&&['h','d','a'].includes(r.selection)&&((r.market==='HAD'&&r.handicap===null)||(draftSupportsHandicap(d)&&r.market==='HHAD'&&Number.isSafeInteger(r.handicap)&&r.handicap!==0&&Math.abs(r.handicap)<=12)),'MARKET');
  check(r.formalEligible===false&&r.modelVersion===null&&r.modelProbability===null&&r.classification==='manual-prematch-research','HONEST_SOURCE');
  check(text(r.reason)&&safeUrl(r.analysisUrl)&&['高','中','低'].includes(r.confidence),'EVIDENCE');
  if(d.version===2)check(Array.isArray(r.evidenceKeys)&&r.evidenceKeys.length>0&&r.evidenceKeys.length<=4
   &&new Set(r.evidenceKeys).size===r.evidenceKeys.length&&r.evidenceKeys.every(k=>/^team-evidence-[a-f0-9]{64}$/.test(k))&&r.confidence==='低','EVIDENCE_KEYS');
  check(Array.isArray(r.teams)&&r.teams.length===2&&r.teams.every(v=>text(v,100))&&Array.isArray(r.orderedTeamIds)&&r.orderedTeamIds.length===2&&r.orderedTeamIds.every(v=>Number.isSafeInteger(v)&&v>0),'TEAMS');
  check(Array.isArray(r.scores)&&r.scores.length===2&&new Set(r.scores.map(v=>JSON.stringify(v))).size===2,'SCORES');
  for(const s of r.scores)check(Array.isArray(s)&&s.length===2&&s.every(v=>Number.isInteger(v)&&v>=0&&v<=15)&&scoreDirection(s,r.market==='HHAD'?r.handicap:0)===r.selection,'SCORE_DIRECTION');
  check(Number.isFinite(r.sp)&&r.sp>1&&r.sp<1000&&Date.parse(d.frozenAt)<Date.parse(r.kickoff),'ORIGINAL_PRICE_CLOCK');
 }
 return true;
}
function make(draft,{matches,snapshot,trustRegistry,asOf,evidenceByEvent={}}){
 if(draft?.version===4)return require('./reviewedOfficialEvent.cjs').make(draft,{matches,snapshot,trustRegistry,asOf,evidenceByEvent});
 validateDraft(draft,asOf);check(Buffer.byteLength(JSON.stringify({draft,matches,snapshot,evidenceByEvent}))<=8*1024*1024,'BOUND');
 const endpoints=snapshot?.endpoints?.filter(e=>e.method==='current');check(endpoints?.length===1,'ENDPOINT');
 const records=draft.singles.map(r=>{
  const candidates=matches.filter(m=>String(m.sourceMatchId||'').replace(/^sporttery_/,'')===r.eventId&&Date.parse(m.eventVersion||m.kickoffTime)===Date.parse(r.kickoff));
  check(candidates.length===1,'CANONICAL_EVENT');const input=quoteInput(candidates[0]);check(input,'PROSPECTIVE');
  input.sourceMatchId=String(input.sourceMatchId).replace(/^sporttery_/,'');input.eventVersion=input.eventVersion||input.kickoffTime;
  const identity=had.verifySignedCurrentEventIdentity(input,endpoints[0],{asOf,trustRegistry});check(identity,'SIGNED_IDENTITY');
  const raw=endpoints[0].payload.value.matchInfoList.flatMap(g=>g.subMatchList).filter(m=>String(m.matchId)===r.eventId);
  check(raw.length===1&&[raw[0].homeTeamId,raw[0].awayTeamId].every((v,i)=>String(v)===String(r.orderedTeamIds[i]))
   &&[input.homeTeamName,input.awayTeamName].every((v,i)=>v===r.teams[i])&&identity.identity.matchNo===r.matchNum,'ORDERED_TEAMS');
  let quote,sp,quoteObservedAt,quoteHash;
  if(r.market==='HHAD'){
   quote=require('./reviewedHandicapQuote.cjs').reviewedHandicapQuote(input,endpoints[0],{asOf,trustRegistry,line:r.handicap});
   check(quote,'SIGNED_HHAD_PRICE');sp=quote.odds[r.selection];quoteObservedAt=quote.observedAt;quoteHash=quote.receiptHash;
  }else{
   const joined=had.joinOfficialHad([input],snapshot,{now:Date.parse(asOf),trustRegistry}).current[0];
   quote=had.signedLiveHadQuoteForMatch(joined,Date.parse(asOf),Date.parse(identity.saleCutoff),{trustRegistry});check(quote,'SIGNED_PRICE');
   sp=quote.odds[{h:'odds1',d:'oddsX',a:'odds2'}[r.selection]];quoteObservedAt=quote.at;quoteHash=quote.receipt.receiptHash;
  }
  let evidenceAdoption;
  if(draft.version===2){
   const packets=evidenceByEvent[r.eventId];check(Array.isArray(packets)&&packets.length===r.evidenceKeys.length
    &&packets.every((p,i)=>'team-evidence-'+p.contentHash===r.evidenceKeys[i]),'EVIDENCE_BINDING');
   const adopted=require('../teamEvidenceSources.cjs').adopt(packets,{sourceMatchId:r.eventId,eventVersion:identity.identity.eventVersion,
    businessDate:r.businessDate,homeTeamId:input.homeTeamId,awayTeamId:input.awayTeamId,homeTeamName:r.teams[0],awayTeamName:r.teams[1],leagueName:raw[0].leagueAllName},asOf);
   // Full official facts remain in the frozen inputs and deterministic replay.
   // Keep the public view inside its existing node/depth/byte budget.
   const {teams,contentHash:adoptionHash,...compact}=adopted;void teams;
   evidenceAdoption=seal({...compact,version:'team-evidence-adoption-view-v1',adoptionHash});
  }
  return {eventId:r.eventId,eventVersion:identity.identity.eventVersion,businessDate:r.businessDate,matchNum:r.matchNum,
   homeTeamId:input.homeTeamId,awayTeamId:input.awayTeamId,homeTeamName:r.teams[0],awayTeamName:r.teams[1],
   market:r.market,...(r.market==='HHAD'?{handicap:r.handicap}:{}),selection:r.selection,sp,originalSp:r.sp,scores:r.scores,confidence:r.confidence,reason:r.reason,
   analysisUrl:r.analysisUrl,limitations:['完整近5场双源未核实','首发未确认','500 SP未核实；采用官方报价'],
   ...(evidenceAdoption?{evidenceAdoption,evidenceHashes:evidenceAdoption.evidenceHashes}:{}),
   cutoffAt:identity.saleCutoff,quoteObservedAt,quoteHash,
   publicationMethod:'reviewed-editorial',modelVersion:null,modelProbability:null,formalEligible:false};
 });
 return seal({version:'reviewed-analysis-publication-v1',createdAt:asOf,businessDate:draft.businessDate,
  draftHash:hash(draft),originalFrozenAt:draft.frozenAt,records,modelProbability:null,formalEligible:false});
}
function combinations(records,size=2){
 check((size===2||size===3)&&Array.isArray(records)&&records.length<=32,'COMBO_BOUND');
 check(new Set(records.map(r=>r.eventId)).size===records.length&&records.every(r=>Number.isFinite(r.sp)&&r.sp>1&&r.sp<1000&&['高','中','低'].includes(r.confidence)),'COMBO_INPUT');
 const options=[];
 function add(legs){
  // Preserve every decimal in the frozen SP, including supported 4-place
  // quotes. Convert the exact decimal product to Number only once.
  let scaled=1n,places=0;
  for(const r of legs){const [whole,fraction='']=String(r.sp).split('.');
   scaled*=BigInt(whole+fraction);places+=fraction.length;}
  const digits=String(scaled).padStart(places+1,'0');
  const product=Number(places?digits.slice(0,-places)+'.'+digits.slice(-places):digits);
  options.push({legs:legs.map(r=>({eventId:r.eventId,matchNum:r.matchNum,market:r.market,...(r.market==='HHAD'?{handicap:r.handicap}:{}),selection:r.selection,sp:r.sp})),product,
   confidence:legs.some(r=>r.confidence==='低')?'低':legs.some(r=>r.confidence==='中')?'中':'高'});
 }
 for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
  if(size===2)add([records[i],records[j]]);
  else for(let k=j+1;k<records.length;k++)add([records[i],records[j],records[k]]);
 }
 // The same set of legs may occupy one band only; never alter a frozen direction.
 const used=new Set();return [2.5,5,10].map(band=>{
  const v=options.filter(o=>o.product>=band&&!used.has(o)).sort((a,b)=>({高:0,中:1,低:2}[a.confidence]-{高:0,中:1,低:2}[b.confidence])||a.product-b.product)[0];
  if(v)used.add(v);return v?{band,...v}:{band,legs:[],product:null,confidence:null};
 });
}
module.exports={check,hash,sha,seal,validateDraft,make,combinations};
