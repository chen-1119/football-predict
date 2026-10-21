import { useEffect, useState } from 'react';
import type { OfficialScheduleEvent, OfficialScheduleView } from '../../services/officialSchedule.cjs';
import { useOfficialSchedule } from '../../hooks/useOfficialSchedule';
import { useOfficialEditorialReferences } from '../../hooks/useOfficialEditorialReferences';
import { parseOfficialReferenceRoute } from '../../services/officialEditorialReferences';
import { reviewedLatestRecord } from '../../services/publishedMatchRecommendation';
import { ReviewedMatchPick } from './ReviewedAnalysis';
import type { Match } from '../../services/mockData';
import { getMatchDisplayTeam } from '../../services/displayRecommendation';
import type { ReviewedAnalysisRecord } from '../../services/recommendationCenterView';
const clock=(at:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at));
export const officialScheduleRoute=(event:OfficialScheduleEvent)=>'schedule_'+event.businessDate.replaceAll('-','')+'_'+event.eventId;
export function scheduleMatchesReference(event:OfficialScheduleEvent,record:ReviewedAnalysisRecord & {officialOrderedTeamIds?:[number,number]}){
 return record.officialOrderedTeamIds?.[0]===event.homeTeamId && record.officialOrderedTeamIds?.[1]===event.awayTeamId
  && event.eventId===record.eventId && event.businessDate===record.businessDate && event.kickoff===record.eventVersion
  && event.homeTeamName===record.homeTeamName && event.awayTeamName===record.awayTeamName;
}
export function scheduleNeedsSeparateCard(event:OfficialScheduleEvent,matches:Match[],records:ReviewedAnalysisRecord[]){
 if(records.some(record=>scheduleMatchesReference(event,record)))return false;
 return !matches.some(match=>String(match.sourceMatchId||match.id).replace(/^(?:sporttery|fivehundred)_/,'')===event.eventId
  && match.businessDate===event.businessDate && Date.parse(match.kickoffTime)===Date.parse(event.kickoff)
  && getMatchDisplayTeam(match,'home').name.zh===event.homeTeamName && getMatchDisplayTeam(match,'away').name.zh===event.awayTeamName);
}
export function OfficialScheduleFacts({event,view,now}:{event:OfficialScheduleEvent;view:OfficialScheduleView;now:number}){
 const closed=event.saleState==='closed'||now>=Date.parse(event.saleCutoffAt),selling=event.saleState==='open'&&!closed;
 return <><p>{event.matchNum} · {event.leagueName} · {clock(event.kickoff)} 北京时间开球</p>
  <p>{selling?'官方在售':closed?'官方当前停售':event.saleState==='awaiting'?'待开售':'售卖状态待确认'} · 赛程更新 {clock(view.sourceReceivedAt)}</p>
  <div className="official-schedule-markets">{event.markets.map(m=><p key={m.poolCode}>
   <strong>{m.poolCode==='HAD'?'胜平负':`让球胜平负（主队${Number(m.handicap)>0?'+':''}${m.handicap}）`}</strong>
   {' '}{m.poolCode==='HAD'?'主胜':'让胜'} {m.h.toFixed(2)} · {m.poolCode==='HAD'?'平':'让平'} {m.d.toFixed(2)} · {m.poolCode==='HAD'?'客胜':'让负'} {m.a.toFixed(2)}
  </p>)}</div>
  {event.markets.length>0?<small>官方 SP 观察于 {clock(view.quoteReceivedAt)}；停售时仅供查看。</small>
   :<p>{event.quoteStatus==='conflict'?'官方报价暂不一致，待核实。':'官方暂未提供可核对的 SP。'}</p>}
 </>;
}
export function OfficialScheduleCard({event,view,onSelect,now}:{event:OfficialScheduleEvent;view:OfficialScheduleView;onSelect:(id:string)=>void;now:number}){
 return <article className="card rc-paper__record" data-official-schedule-event={event.eventId} style={{padding:'1.25rem'}}>
  <h3><button type="button" className="btn btn-secondary" onClick={()=>onSelect(officialScheduleRoute(event))}>{event.homeTeamName} — {event.awayTeamName}</button></h3>
  <OfficialScheduleFacts event={event} view={view} now={now}/><p>查看比赛详情与已发布分析</p>
 </article>;
}
export function OfficialScheduleDetail({referenceId,onBack}:{referenceId:string;onBack:()=>void}){
 const [now,setNow]=useState(()=>Date.now());useEffect(()=>{const id=window.setInterval(()=>setNow(Date.now()),15000);return()=>window.clearInterval(id);},[]);
 const identity=parseOfficialReferenceRoute(referenceId.replace(/^schedule_/,'official_'));
 const state=useOfficialSchedule(identity?.businessDate??'invalid'),references=useOfficialEditorialReferences(identity?.businessDate??'invalid');
 const view=state.data&&now-Date.parse(state.data.sourceReceivedAt)<=900000&&now-Date.parse(state.data.quoteReceivedAt)<=900000?state.data:null;
 const event=view?.events.find(e=>e.eventId===identity?.eventId);
 const first=event&&references.data?.records.find(r=>scheduleMatchesReference(event,r));
 const record=first?reviewedLatestRecord(first,references.data?.revisions):null;
 return <section className="match-detail-shell" data-official-schedule-detail={identity?.eventId??'invalid'}>
  <button type="button" className="btn btn-secondary" onClick={onBack}>返回列表</button>
  {event&&view?<><header className="card" style={{padding:'1.25rem'}}><h1>{event.homeTeamName} — {event.awayTeamName}</h1><p>{event.businessDate} 竞彩日</p>
   <OfficialScheduleFacts event={event} view={view} now={now}/></header>
   <section className="card" style={{padding:'1.25rem'}}><h2>赛前分析</h2>
    {record?<ReviewedMatchPick record={record} now={now}/>:<p>{references.failed?'已发布分析暂时无法核验。':references.loading?'正在读取已发布分析…':'本场尚未发布赛前推荐及参考比分。'}</p>}
    {!record&&<p>伤停、首发、近况及交锋尚未完成本场核实。</p>}
   </section></>:<p role="status">{state.loading?'正在读取官方赛程…':'官方赛程暂时无法核验，请稍后重试。'}</p>}
 </section>;
}
