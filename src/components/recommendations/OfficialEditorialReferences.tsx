import type { ReviewedAnalysisRecord } from '../../services/recommendationCenterView';
import './OfficialSchedule.css';
import { useEffect, useState } from 'react';
import { ReviewedMatchPick, ReviewedMatchStatus } from './ReviewedAnalysis';
import { reviewedLatestRecord } from '../../services/publishedMatchRecommendation';
import { officialReferenceRoute, parseOfficialReferenceRoute } from '../../services/officialEditorialReferences';
import { useOfficialEditorialReferences } from '../../hooks/useOfficialEditorialReferences';
const beijing=(at:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at));
export function OfficialReferenceCard({record,onSelect,now}:{record:ReviewedAnalysisRecord;onSelect:(id:string)=>void;now:number}){
 return <article className="card official-schedule-card official-reference-card" data-official-event-reference={record.eventId}>
  <header><h3>{record.homeTeamName}<span aria-label="对阵">vs</span>{record.awayTeamName}</h3><span className="official-schedule-analysis-state">分析已发布</span></header>
  <p className="official-schedule-meta">{record.matchNum} · {beijing(record.eventVersion)} 北京时间 · <ReviewedMatchStatus record={record} now={now} language="zh"/></p>
  <ReviewedMatchPick record={record} now={now}/>
  <footer><span>保留发布时官方 SP</span><button type="button" className="official-schedule-link" onClick={()=>onSelect(officialReferenceRoute(record))}>查看完整分析 <span aria-hidden="true">→</span></button></footer>
 </article>;
}
export function OfficialEditorialReferenceDetail({referenceId,onBack}:{referenceId:string;onBack:()=>void}){
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{const id=window.setInterval(()=>setNow(Date.now()),30000);return()=>window.clearInterval(id);},[]);
 const identity=parseOfficialReferenceRoute(referenceId);
 const state=useOfficialEditorialReferences(identity?.businessDate??'invalid');
 const first=identity&&state.data?.records.find(r=>r.eventId===identity.eventId);
 const record=first?reviewedLatestRecord(first,state.data?.revisions):null;
 return <section className="match-detail-shell official-schedule-detail official-reference-card" data-official-event-detail={identity?.eventId??'invalid'}>
  <button type="button" className="btn btn-secondary" onClick={onBack}>返回列表</button>
  {record?<><header className="card" style={{padding:'1.25rem'}}>
   <h1>{record.homeTeamName} — {record.awayTeamName}</h1>
   <p>{record.matchNum} · {record.businessDate} 竞彩日 · {beijing(record.eventVersion)} 北京时间开球</p>
   <p>人工审核参考 · 保留发布时官方 SP 与原推荐记录</p>
  </header><section className="card" style={{padding:'1.25rem'}}><ReviewedMatchPick record={record} now={now}/>
   <p>伤停、首发及资料缺项以已保存的分析依据为准；未标注确认的阵容仍为未确认。</p>
  </section></>:<p role="status">{state.loading?'正在核对已发布参考…':state.failed?'参考记录暂时无法核验，请稍后重试。':'未找到已完整确认的人工参考记录。'}</p>}
 </section>;
}
