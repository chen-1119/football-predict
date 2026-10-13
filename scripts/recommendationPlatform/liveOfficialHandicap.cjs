'use strict';
const fs=require('node:fs'),path=require('node:path');
const {forecastInputFor}=require('../../src/services/prospectiveForecastInput.cjs');
const {verifyCollectorAttestation,loadCollectorTrustRegistry,sha256CollectorJson}=require('../../src/services/collectorAttestation.cjs');
const {expectedCollectorCommitment,officialFastEndpointUrl}=require('../../server/relayCollectorEvidence.cjs');
const MAX_AGE=15*60000,MAX_BYTES=4*1024*1024;
const at=v=>Date.parse(v||''),id=v=>String(v||'').replace(/^sporttery_/,'');
const names=r=>[String(r.homeTeamAllName||r.homeTeamAbbName||'').trim(),String(r.awayTeamAllName||r.awayTeamAbbName||'').trim()];
const kickoff=r=>at(`${r.matchDate}T${r.matchTime}+08:00`);
const boundedText=v=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v,'utf8')<=255&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v)?v:null;
const displayClock=v=>Number.isFinite(at(v))?new Date(at(v)).toISOString():null;
function signedMarket(snapshot,method,now,registry,audit){
 const fail=reason=>{if(audit)audit.reason=reason;return null;};
 const rows=(Array.isArray(snapshot?.endpoints)?snapshot.endpoints:[]).filter(e=>e?.method===method);
 if(rows.length!==1)return fail('endpoint-missing-or-ambiguous');
 const e=rows[0],received=at(e.receivedAt),requested=at(e.requestedAt);
 if(audit)Object.assign(audit,{receivedAt:displayClock(e.receivedAt),requestedAt:displayClock(e.requestedAt),sourceCycleId:boundedText(e.sourceCycleId)});
 if(e.ok!==true||e.page!=null||!officialFastEndpointUrl(method,e.url))return fail('endpoint-contract-invalid');
 if(!boundedText(e.sourceCycleId))return fail('endpoint-cycle-invalid');
 if(!Number.isFinite(received)||!Number.isFinite(requested)||requested>received)return fail('endpoint-clock-invalid');
 if(received>now)return fail('endpoint-acquired-after-asof');
 if(now-received>MAX_AGE||now-requested>MAX_AGE)return fail('endpoint-expired');
 const proof=verifyCollectorAttestation(e.collectorAttestation,{trustRegistry:registry,payload:e.payload,expected:expectedCollectorCommitment(e)});
 if(!proof.eligible)return fail('collector-attestation-invalid');
 if(e.sourceCycleId!==e.collectorAttestation.commitment.collectorCycleId)return fail('endpoint-cycle-invalid');
 if(audit)Object.assign(audit,{collectorSignatureVerified:true,payloadHash:sha256CollectorJson(e.payload),commitmentHash:sha256CollectorJson(e.collectorAttestation.commitment)});
 const groups=e.payload?.value?.matchInfoList;
 if(!Array.isArray(groups))return fail('endpoint-payload-invalid');
 const matches=groups.flatMap(g=>Array.isArray(g.subMatchList)?g.subMatchList:[]);
 if(matches.length>512)return fail('endpoint-row-limit');
 if(audit)Object.assign(audit,{reason:'verified',rows:matches.length});
 return {entry:e,matches,proof};
}
/** Only ephemeral inputs change: source acquisition clocks and model clocks
 * stay separate. Signature, event identity and actual sale state precede use. */
function joinOfficialHandicap(current,snapshot,{now,trustRegistry,audit=null}={}){
 if(audit)Object.assign(audit,{version:'official-handicap-input-audit-v1',asOf:Number.isFinite(now)?new Date(now).toISOString():null,
  snapshotHash:snapshot?sha256CollectorJson(snapshot):null,endpoints:{calculator:{},current:{}},reasonCounts:{},samples:[]});
 const note=(reason,row)=>{if(audit){audit.reasonCounts[reason]=(audit.reasonCounts[reason]||0)+1;
  if(audit.samples.length<32)audit.samples.push({sourceMatchId:boundedText(id(row?.sourceMatchId||row?.id))||'',reason});}return row;};
 if(!Number.isFinite(now)){if(audit)audit.status='clock-invalid';return current;}
 const registry=loadCollectorTrustRegistry(trustRegistry),calculator=signedMarket(snapshot,'calculator',now,registry,audit?.endpoints.calculator),schedule=signedMarket(snapshot,'current',now,registry,audit?.endpoints.current);
 if(!calculator||!schedule){if(audit)audit.status='source-unavailable';return current;}
 if(!calculator.entry.sourceCycleId||calculator.entry.sourceCycleId!==schedule.entry.sourceCycleId){if(audit)audit.status='source-cycle-conflict';return current;}
 if(audit)audit.status='source-verified';
 const byId=list=>{const map=new Map();for(const r of list){const key=id(r.matchId),all=map.get(key)||[];all.push(r);map.set(key,all);}return map;};
 const markets=byId(calculator.matches),events=byId(schedule.matches);
 return current.map(row=>{
  const input=forecastInputFor(row);
  if(!input||row.status!=='SCHEDULED'||input.status!=='SCHEDULED'||input.predictionMeta?.lockedAt||input.predictionMeta?.lockedReason)return note('not-open-prospective-input',row);
  const key=id(input.sourceMatchId||input.id),quotes=markets.get(key),fixtures=events.get(key);
  if(quotes?.length!==1||fixtures?.length!==1)return note('event-missing-or-ambiguous',row);
  const q=quotes[0],fixture=fixtures[0],event=at(input.eventVersion||input.kickoffTime),expectedNames=[input.homeTeamName?.trim(),input.awayTeamName?.trim()];
  if([q,fixture].some(r=>kickoff(r)!==event||names(r).some((n,i)=>!n||n!==expectedNames[i])
   ||(input.businessDate&&r.businessDate!==input.businessDate)))return note('event-identity-conflict',row);
  const wrap=next=>row.prospectiveForecastInput?{...row,prospectiveForecastInput:structuredClone(next)}:structuredClone(next);
  if([q,fixture].some(r=>r.matchStatus!=='Selling'||Number(r.sellStatus)!==1)){note('event-not-selling',row);return wrap({...input,isOnSale:false,saleStatus:'SUSPENDED'});}
  const pools=(q.oddsList||[]).filter(p=>p.poolCode==='HHAD'),sales=(q.poolList||[]).filter(p=>p.poolCode==='HHAD');
  if(pools.length!==1||sales.length!==1||sales[0].poolStatus!=='Selling'||Number(sales[0].bettingAllup??sales[0].allUp)!==1)return note('hhad-pool-unavailable',row);
  const pool=pools[0],line=Number(pool.goalLine),odds={odds1:Number(pool.h),oddsX:Number(pool.d),odds2:Number(pool.a)};
  if(pool.goalLine==null||pool.goalLine===''||!Number.isSafeInteger(line)||line===0||Math.abs(line)>12||Object.values(odds).some(v=>!Number.isFinite(v)||v<=1))return note('hhad-market-invalid',row);
  const cutoff=Math.min(...[input.kickoffTime,input.buyEndTime,input.predictionMeta?.cutoffTime].filter(Boolean).map(at));
  if(!Number.isFinite(cutoff)||now>=cutoff||at(calculator.entry.receivedAt)>=cutoff)return note('cutoff-crossed-or-invalid',row);
  const old=at(input.handicapOddsReceivedAt||input.handicapOddsObservedAt);
  if(Number.isFinite(old)&&old>at(calculator.entry.receivedAt))return note('input-quote-newer-than-snapshot',row);
  const next={...input,handicapLine:String(line),handicapOdds:odds,handicapOddsSource:'sporttery:HHAD',handicapOddsPoolCode:'HHAD',
   handicapOddsReceivedAt:calculator.entry.receivedAt,handicapOddsSourceUrl:calculator.entry.url,
   handicapQuoteProvenance:{version:'signed-live-handicap-v1',sourceMatchId:key,eventVersion:input.eventVersion||input.kickoffTime,
    receivedAt:calculator.entry.receivedAt,sourceCycleId:calculator.entry.sourceCycleId,
    attestation:structuredClone(calculator.entry.collectorAttestation),
    commitmentHash:sha256CollectorJson(calculator.entry.collectorAttestation.commitment),payloadHash:sha256CollectorJson(calculator.entry.payload),rowHash:sha256CollectorJson(q)}};
  note('hhad-applied',row);return wrap(next);
 });
}
function readLiveOfficialSnapshot(env=process.env){
 const file=path.resolve(env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT||env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH||path.join(env.SERVER_STORE_DIR||env.DATA_STORE_DIR||path.resolve(__dirname,'../../server-data'),'sporttery-relay-fast-lane.json'));
 let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.size>MAX_BYTES)return null;return JSON.parse(fs.readFileSync(fd,'utf8'));}catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={joinOfficialHandicap,readLiveOfficialSnapshot};
