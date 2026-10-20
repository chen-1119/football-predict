'use strict';
// Explicit V4 editorial source authority. This module reads complete signed
// official endpoints; it never claims these inputs came from native/model rows.
const p=require('./reviewedAnalysis.cjs');
const had=require('./liveOfficialHad.cjs');
const {derivedTeamId}=require('../storedResultTeamIdentity.cjs');
const {epochNanoseconds}=require('../../src/services/prematchV3Clock.cjs');
const {verifyCollectorAttestation,sha256CollectorJson}=require('../../src/services/collectorAttestation.cjs');
const {expectedCollectorCommitment,officialFastEndpointUrl}=require('../../server/relayCollectorEvidence.cjs');
const VERSION='signed-official-events-v1',MAX_BYTES=4*1024*1024,MAX_ROWS=512,FRESH_MS=30000;
const check=(v,c)=>p.check(v,'OFFICIAL_EVENT_'+c);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=100&&v===v.trim()&&[...v].every(c=>c.codePointAt(0)>=32&&c.codePointAt(0)!==127&&c!=='\ufffd');
const ns=v=>epochNanoseconds(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const one=v=>v===1||v==='1';
const numberId=v=>(typeof v==='number'||typeof v==='string')&&/^[1-9]\d*$/.test(String(v))&&Number.isSafeInteger(Number(v));
function endpoint(snapshot,method,asOf,registry){
 const endpoints=snapshot.endpoints.filter(e=>e?.method===method);check(endpoints.length===1,'ENDPOINT');
 const e=endpoints[0],now=ns(asOf),requested=ns(e.requestedAt),received=ns(e.receivedAt);
 check(now!==null&&requested!==null&&received!==null&&requested<=received&&received<=now
  &&now-requested<=BigInt(FRESH_MS)*1000000n&&now-received<=BigInt(FRESH_MS)*1000000n,'FRESH_CLOCK');
 check(e.ok===true&&e.method===method&&e.page===null&&officialFastEndpointUrl(method,e.url)
  &&e.sourceRequest?.method==='GET'&&e.sourceRequest.role===method&&e.sourceRequest.page===null
  &&e.sourceRequest.url===e.url&&e.httpStatus===200&&/^application\/json(?:\s*;|$)/i.test(e.contentType||'')
  &&hex(e.rawSha256)&&hex(e.headersSha256)&&hex(e.canonicalPayloadSha256)
  &&Number.isSafeInteger(e.rawBytes)&&e.rawBytes>0&&e.rawBytes<=MAX_BYTES
  &&typeof e.sourceCycleId==='string'&&e.sourceCycleId.length>0&&e.sourceCycleId.length<=256,'ENDPOINT_CONTRACT');
 if(e.providerObservedAt!=null)check(ns(e.providerObservedAt)!==null&&ns(e.providerObservedAt)<=received,'PROVIDER_CLOCK');
 const proof=verifyCollectorAttestation(e.collectorAttestation,{trustRegistry:registry,payload:e.payload,expected:expectedCollectorCommitment(e)});
 check(proof.eligible&&e.collectorAttestation.commitment.collectorCycleId===e.sourceCycleId,'SIGNATURE');
 check(e.payload?.success===true&&Array.isArray(e.payload.value?.matchInfoList),'PAYLOAD');
 const rows=[],seen=new Set();
 for(const group of e.payload.value.matchInfoList){
  check(group&&Array.isArray(group.subMatchList),'PAYLOAD');
  for(const row of group.subMatchList){
   check(row&&typeof row==='object'&&!Array.isArray(row)&&numberId(row.matchId)&&!seen.has(String(row.matchId)),'ROW_ID');
   seen.add(String(row.matchId));rows.push({row,group});check(rows.length<=MAX_ROWS,'ROW_BOUND');
  }
 }
 return {entry:e,rows};
}
function identity({row:r,group:g}){
 const businessDate=r.businessDate||g.businessDate;
 check(/^\d{4}-\d{2}-\d{2}$/.test(businessDate||'')&&(!r.businessDate||!g.businessDate||r.businessDate===g.businessDate),'BUSINESS_DAY');
 const home=r.homeTeamAllName||r.homeTeamAbbName,away=r.awayTeamAllName||r.awayTeamAbbName;
 check(text(home)&&text(away)&&home!==away&&numberId(r.homeTeamId)&&numberId(r.awayTeamId)&&Number(r.homeTeamId)!==Number(r.awayTeamId),'TEAMS');
 check(text(r.matchNumStr)&&/^\d{4}-\d{2}-\d{2}$/.test(r.matchDate||'')&&/^\d{2}:\d{2}(?::\d{2})?$/.test(r.matchTime||''),'IDENTITY');
 const time=ns(r.matchDate+'T'+r.matchTime+'+08:00');check(time!==null&&time%1000000n===0n,'KICKOFF');
 return {eventId:String(r.matchId),businessDate,home,away,orderedTeamIds:[Number(r.homeTeamId),Number(r.awayTeamId)],
  matchNum:r.matchNumStr,kickoff:new Date(Number(time/1000000n)).toISOString()};
}
function market(row,requested,receivedAt){
 check(row.matchStatus==='Selling'&&one(row.sellStatus),'SALE');
 check(Array.isArray(row.poolList)&&Array.isArray(row.oddsList),'MARKET');
 const sales=row.poolList.filter(x=>x?.poolCode===requested.market),pools=row.oddsList.filter(x=>x?.poolCode===requested.market);
 check(sales.length===1&&pools.length===1&&sales[0].poolStatus==='Selling'&&one(sales[0].cbtValue)&&one(sales[0].cbtAllUp),'POOL_SALE');
 const pool=pools[0],odds={};
 if([pool.updateDate,pool.updateTime].some(v=>v!=null&&v!=='')){
  const clock=ns(pool.updateDate+'T'+pool.updateTime+'+08:00');check(clock!==null&&clock<=ns(receivedAt),'POOL_CLOCK');
 }
 for(const k of ['h','d','a']){
  const value=pool[k];check((typeof value==='string'||typeof value==='number')&&/^\d+(?:\.\d{1,4})?$/.test(String(value))
   &&Number(value)>1&&Number(value)<1000,'PRICE');odds[k]=Number(value);
 }
 if(requested.market==='HHAD')check(pool.goalLine!==null&&pool.goalLine!==''&&typeof pool.goalLine!=='boolean'
  &&Number.isSafeInteger(Number(pool.goalLine))&&Number(pool.goalLine)===requested.handicap,'LINE');
 return {market:requested.market,handicap:requested.market==='HHAD'?Number(pool.goalLine):null,odds};
}
function make(draft,{matches,snapshot,trustRegistry,asOf,evidenceByEvent={}}){
 p.validateDraft(draft,asOf);
 check(draft.version===4&&draft.eventAuthority===VERSION,'VERSION');
 check(Array.isArray(matches)&&matches.length===0&&evidenceByEvent&&Object.keys(evidenceByEvent).length===0,'NO_NATIVE_OR_MODEL_INPUT');
 check(snapshot&&Array.isArray(snapshot.endpoints)&&snapshot.endpoints.length<=16
  &&Buffer.byteLength(JSON.stringify(snapshot))<=MAX_BYTES,'BOUND');
 const current=endpoint(snapshot,'current',asOf,trustRegistry),calculator=endpoint(snapshot,'calculator',asOf,trustRegistry);
 check(current.entry.sourceCycleId===calculator.entry.sourceCycleId,'CYCLE');
 check(had.verifySignedCurrentEndpointIdentity(current.entry,{asOf,trustRegistry}),'CURRENT_IDENTITY');
 const inputs=[],authorities=new Map();
 for(const r of draft.singles){
  const a=current.rows.filter(x=>String(x.row.matchId)===r.eventId),b=calculator.rows.filter(x=>String(x.row.matchId)===r.eventId);
  check(a.length===1&&b.length===1,'EVENT');
  const first=identity(a[0]),second=identity(b[0]);check(p.hash(first)===p.hash(second),'LANE_IDENTITY');
  check(first.eventId===r.eventId&&first.businessDate===draft.businessDate&&first.matchNum===r.matchNum
   &&ns(first.kickoff)===ns(r.kickoff)&&p.hash(first.orderedTeamIds)===p.hash(r.orderedTeamIds)&&p.hash([first.home,first.away])===p.hash(r.teams),'DRAFT_IDENTITY');
  check(p.hash(market(a[0].row,r,current.entry.receivedAt))===p.hash(market(b[0].row,r,calculator.entry.receivedAt)),'LANE_MARKET');
  const input={id:'sporttery_'+first.eventId,sourceMatchId:first.eventId,businessDate:first.businessDate,
   homeTeamId:derivedTeamId(first.home),awayTeamId:derivedTeamId(first.away),homeTeamName:first.home,awayTeamName:first.away,
   matchNo:first.matchNum,matchNumStr:first.matchNum,kickoffTime:first.kickoff,eventVersion:first.kickoff,
   status:'SCHEDULED',isOnSale:true,saleStatus:'SELLING'};
  // Preserve every explicit signed deadline. The existing reviewed deadline
  // policy remains the pricing gate; no draft clock can extend that policy.
  const deadlines=[];
  for(const row of [a[0].row,b[0].row])for(const k of ['buyEndTime','matchEndTime','sellEndTime','stopSaleTime','endTime']){
   if(row[k]==null||row[k]==='')continue;
   const clock=typeof row[k]==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row[k])?row[k].replace(' ','T')+'+08:00':row[k];
   const value=ns(clock);check(value!==null&&value%1000000n===0n,'DEADLINE');deadlines.push(value);
  }
  if(deadlines.length)input.buyEndTime=new Date(Number(deadlines.reduce((x,y)=>x<y?x:y)/1000000n)).toISOString();
  inputs.push(input);
  authorities.set(r.eventId,{version:VERSION,sourceCycleId:current.entry.sourceCycleId,officialOrderedTeamIds:first.orderedTeamIds,
   currentRowHash:sha256CollectorJson(a[0].row),calculatorRowHash:sha256CollectorJson(b[0].row),
   currentCommitmentHash:sha256CollectorJson(current.entry.collectorAttestation.commitment),
   calculatorCommitmentHash:sha256CollectorJson(calculator.entry.collectorAttestation.commitment)});
 }
 // Price directly from verified official events. V1-V3 make remains a native
 // canonical-row policy; this new version never supplies invented rows to it.
 const records=draft.singles.map((r,i)=>{
  const input=inputs[i],identityProof=had.verifySignedCurrentEventIdentity(input,current.entry,{asOf,trustRegistry});
  check(identityProof,'SIGNED_IDENTITY');
  let sp,quoteObservedAt,quoteHash;
  if(r.market==='HHAD'){
   const quote=require('./reviewedHandicapQuote.cjs').reviewedHandicapQuote(input,current.entry,{asOf,trustRegistry,line:r.handicap});
   check(quote,'SIGNED_HHAD_PRICE');sp=quote.odds[r.selection];quoteObservedAt=quote.observedAt;quoteHash=quote.receiptHash;
  }else{
   const joined=had.joinOfficialHad([input],snapshot,{now:Date.parse(asOf),trustRegistry}).current[0];
   const quote=had.signedLiveHadQuoteForMatch(joined,Date.parse(asOf),Date.parse(identityProof.saleCutoff),{trustRegistry});
   check(quote,'SIGNED_HAD_PRICE');sp=quote.odds[{h:'odds1',d:'oddsX',a:'odds2'}[r.selection]];quoteObservedAt=quote.at;quoteHash=quote.receipt.receiptHash;
  }
  return {eventId:r.eventId,eventVersion:identityProof.identity.eventVersion,businessDate:r.businessDate,matchNum:r.matchNum,
   homeTeamId:input.homeTeamId,awayTeamId:input.awayTeamId,homeTeamName:r.teams[0],awayTeamName:r.teams[1],
   market:r.market,...(r.market==='HHAD'?{handicap:r.handicap}:{}),selection:r.selection,sp,originalSp:r.sp,scores:r.scores,
   confidence:r.confidence,reason:r.reason,analysisUrl:r.analysisUrl,
   limitations:['完整近5场双源未核实','首发未确认','500 SP未核实；采用官方报价'],
   cutoffAt:identityProof.saleCutoff,quoteObservedAt,quoteHash,eventAuthority:authorities.get(r.eventId),
   publicationMethod:'reviewed-editorial',modelVersion:null,modelProbability:null,formalEligible:false};
 });
 return p.seal({version:'reviewed-analysis-publication-v1',createdAt:asOf,businessDate:draft.businessDate,
  draftHash:p.hash(draft),originalFrozenAt:draft.frozenAt,records,eventAuthority:VERSION,modelProbability:null,formalEligible:false});
}
function sameOfficialEventIdentity(first,next){
 if(first.eventAuthority===undefined&&next.eventAuthority===undefined)return true;
 return first.eventAuthority?.version===VERSION&&next.eventAuthority?.version===VERSION
  &&p.hash(first.eventAuthority.officialOrderedTeamIds)===p.hash(next.eventAuthority.officialOrderedTeamIds);
}
// A fresh sale observation for display/archive flags, never a publication or
// a replacement of a frozen decision. Invalid/missing inputs mean closed.
function createOfficialEventObserver(asOf){
 let context=null;
 return records=>{
 const observed=new Map(),eligible=records.filter(r=>r.eventAuthority?.version===VERSION
  &&ns(asOf)!==null&&ns(asOf)<ns(r.cutoffAt)&&ns(asOf)<ns(r.eventVersion));
 if(!eligible.length)return observed;
 try{
  if(context===null){
   const snapshot=require('./liveOfficialHandicap.cjs').readLiveOfficialSnapshot();
   check(snapshot&&Array.isArray(snapshot.endpoints)&&snapshot.endpoints.length<=16&&Buffer.byteLength(JSON.stringify(snapshot))<=MAX_BYTES,'BOUND');
   const registry=require('../../src/services/collectorAttestation.cjs').loadCollectorTrustRegistry(process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH||require('node:path').resolve(__dirname,'../../deploy/light-server/collector-trust-registry.json'));
   const current=endpoint(snapshot,'current',asOf,registry),calculator=endpoint(snapshot,'calculator',asOf,registry);
   check(current.entry.sourceCycleId===calculator.entry.sourceCycleId,'CYCLE');
   check(had.verifySignedCurrentEndpointIdentity(current.entry,{asOf,trustRegistry:registry}),'CURRENT_IDENTITY');
   context={current,calculator};
  }
  const {current,calculator}=context;
  for(const record of eligible)try{
   const a=current.rows.filter(v=>String(v.row.matchId)===record.eventId),b=calculator.rows.filter(v=>String(v.row.matchId)===record.eventId);check(a.length===1&&b.length===1,'EVENT');
   const first=identity(a[0]),second=identity(b[0]);check(p.hash(first)===p.hash(second),'LANE_IDENTITY');
   check(first.businessDate===record.businessDate&&first.matchNum===record.matchNum&&ns(first.kickoff)===ns(record.eventVersion)
    &&first.home===record.homeTeamName&&first.away===record.awayTeamName
    &&p.hash(first.orderedTeamIds)===p.hash(record.eventAuthority.officialOrderedTeamIds),'FROZEN_IDENTITY');
   check(p.hash(market(a[0].row,record,current.entry.receivedAt))===p.hash(market(b[0].row,record,calculator.entry.receivedAt)),'LANE_MARKET');
   // Explicit newly observed cutoffs can close a group earlier, never later.
   for(const row of [a[0].row,b[0].row])for(const key of ['buyEndTime','matchEndTime','sellEndTime','stopSaleTime','endTime']){
    if(row[key]==null||row[key]==='')continue;
    const clock=typeof row[key]==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row[key])?row[key].replace(' ','T')+'+08:00':row[key];
    check(ns(clock)!==null&&ns(asOf)<ns(clock),'DEADLINE');
   }
   observed.set(record.eventId,{...record,status:'SCHEDULED',isOnSale:true,observedAt:current.entry.receivedAt});
  }catch{/* A closed, changed or unverified event can only freeze its group. */}
 }catch{/* Whole-source failure cannot confer eligibility. */}
 return observed;
 };
}
function observeOfficialEvents(records,asOf){return createOfficialEventObserver(asOf)(records);}
module.exports={VERSION,FRESH_MS,MAX_BYTES,MAX_ROWS,make,sameOfficialEventIdentity,observeOfficialEvents,createOfficialEventObserver};
