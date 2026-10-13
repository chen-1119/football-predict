import type { Match } from './mockData';
import { parseReviewedAnalysis, parseLeagueBaseline } from './recommendationCenterView';
import type { ReviewedAnalysisRecord, LeagueBaselineDirection } from './recommendationCenterView';
import { exactDetailClock } from './matchDetailIdentity.js';

type Receipt = {track:'manual'|'trained';artifactKey:string;payloadSha256:string;recordHash:string;createdAt:string;storedAt:string;ackAt:string;ackPayloadSha256:string};
type PostMatch = {track:'manual'|'trained';state:'WON'|'LOST'|'PENDING'|'UNKNOWN'|'VOID'|'DISPUTED';score:string|null;resultEventId:string|null;revision:number|null;resultObservedAt:string|null;source:string|null};
export type DetailPublication = {reviewed:ReviewedAnalysisRecord|null;trained:LeagueBaselineDirection|null;receipts:Receipt[];observedAt:string;businessDate:string;postMatch?:PostMatch[]};
type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Detail publication object');return v as Obj;};
const clock=(v:unknown)=>{const n=exactDetailClock(v);if(n===null)throw Error('Detail publication clock');return n;};
const hex=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw Error('Detail publication hash');return v;};
// Public shape validation supplements the server's raw record/signature/ACK
// replay; a JSON hash itself never proves a database acknowledgement.
export function detailPublishedRecommendation(value:unknown,match:Match,now=Date.now()):DetailPublication|null{
 try{
  const v=obj(value),i=obj(v.identity),source=String(match.sourceMatchId||'');
  if(v.version!=='match-detail-publication-v1'||v.status!=='verified'||!/^\d+$/.test(source)
   ||i.sourceMatchId!==source||i.businessDate!==match.businessDate||clock(i.eventVersion)!==clock(match.kickoffTime)||clock(match.eventVersion)!==clock(match.kickoffTime)
   ||i.homeTeamId!==match.homeTeamId||i.awayTeamId!==match.awayTeamId||!Array.isArray(v.receipts)||v.receipts.length<1||v.receipts.length>2
   ||typeof v.observedAt!=='string'||clock(v.observedAt)>BigInt(Math.floor(now+30000))*1000000n)throw Error('Detail publication identity');
  const tracks=new Set<string>(),receipts=v.receipts.map(x=>{
   const p=obj(x),track=String(p.track);
   if(!['manual','trained'].includes(track)||tracks.has(track)||typeof p.artifactKey!=='string'||p.artifactKey.length>160
    ||(track==='manual'?!p.artifactKey.startsWith(`reviewed-analysis-${String(i.businessDate)}-`):!/^league-forecast-[a-f0-9]{64}$/.test(p.artifactKey))
    ||clock(p.createdAt)>=clock(p.storedAt)||clock(p.storedAt)>clock(p.ackAt)||clock(p.ackAt)>clock(v.observedAt))throw Error('Detail publication receipt');
   tracks.add(track);hex(p.payloadSha256);hex(p.recordHash);hex(p.ackPayloadSha256);return p as unknown as Receipt;
  });
  const businessDate=String(i.businessDate),reviewed=v.reviewed===null?null:parseReviewedAnalysis(v.reviewed,businessDate,v.observedAt).records;
  const trained=v.trained===null?null:parseLeagueBaseline(v.trained,businessDate,v.observedAt).records;
  if(Boolean(reviewed)!==tracks.has('manual')||Boolean(trained)!==tracks.has('trained')||reviewed&&reviewed.length!==1||trained&&trained.length!==1)throw Error('Detail publication tracks');
  const manual=reviewed?.[0]??null,model=trained?.[0]??null;
  for(const [track,r] of [['manual',manual],['trained',model]] as const){
   if(!r)continue;
   const p=receipts.find(p=>p.track===track)!;
   if(('eventId' in r?r.eventId:r.sourceMatchId)!==source||clock(r.eventVersion)!==clock(match.kickoffTime)
    ||r.homeTeamId!==match.homeTeamId||r.awayTeamId!==match.awayTeamId||r.homeTeamName!==match.homeTeamName||r.awayTeamName!==match.awayTeamName
    ||clock(p.ackAt)>=clock(r.cutoffAt))throw Error('Detail publication record identity');
   const raw=track==='manual'?obj(v.reviewed):obj((obj(v.trained).records as unknown[])[0]);
   if(clock(raw.createdAt)!==clock(p.createdAt)||clock(raw.commitObservedAt)!==clock(p.ackAt)
    ||(track==='manual'?raw.publicationHash:raw.recordHash)!==p.recordHash)throw Error('Detail publication original binding');
  }
  const postMatch:PostMatch[]=[],seen=new Set<string>();
  if(v.postMatch!==undefined){
   if(!Array.isArray(v.postMatch)||v.postMatch.length>receipts.length)throw Error('Detail result count');
   for(const value of v.postMatch){
    const e=obj(value),track=String(e.track);
    if(!tracks.has(track)||seen.has(track)||!['WON','LOST','PENDING','UNKNOWN','VOID','DISPUTED'].includes(String(e.state)))throw Error('Detail result track');
    seen.add(track);
    if(e.state==='WON'||e.state==='LOST'){
     if(typeof e.score!=='string'||!/^\d+-\d+$/.test(e.score)||typeof e.resultEventId!=='string'||!/^result_[a-f0-9]{64}$/.test(e.resultEventId)
      ||!Number.isSafeInteger(e.revision)||Number(e.revision)<0||typeof e.source!=='string'||!e.source||e.source.length>300
      ||clock(e.resultObservedAt)<clock(match.kickoffTime)||clock(e.resultObservedAt)>clock(v.observedAt))throw Error('Detail result evidence');
    }else if(['score','resultEventId','revision','resultObservedAt','source'].some(k=>e[k]!==null))throw Error('Detail unsettled result');
    postMatch.push(e as unknown as PostMatch);
   }
  }
  return {reviewed:manual,trained:model,receipts,observedAt:v.observedAt,businessDate,postMatch};
 }catch{return null;}
}

export function detailLineupAvailability({status,kickoffTime,now,ready,projected,notYetPublishable}:{status:string; kickoffTime:string;now:number;ready:boolean;projected:boolean;notYetPublishable:boolean}){
 const kickoff=Date.parse(kickoffTime),beforeWindow=status==='SCHEDULED'&&Number.isFinite(kickoff)&&now<kickoff-3600000;
 const stopped=['FINISHED','LIVE','PENDING_RESULT','CANCELLED'].includes(status)||(Number.isFinite(kickoff)&&now>=kickoff);
 return {beforeWindow,stopped,notYetPublishable:beforeWindow&&notYetPublishable,
  missing:!ready&&!projected&&!beforeWindow};
}
