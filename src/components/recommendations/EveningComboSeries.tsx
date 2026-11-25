import { useEffect, useState } from 'react';
import { buildApiUrl } from '../../services/runtimeUrls';
import { getAccessAuthHeaders } from '../../services/accessControl';
import { createPollingController } from '../../services/pollingController';
import { parseComboSeriesView, type ComboSeriesView } from '../../services/comboSeriesView';
import { officialReferenceRoute } from '../../services/officialEditorialReferences';

const clock=(at:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(at));
export function EveningComboSeries({businessDate,size,now,onSelect}:{businessDate:string;size:2|3;now:number;onSelect:(id:string)=>void}){
 const [state,setState]=useState<{data:ComboSeriesView|null;failed:boolean}>({data:null,failed:false});
 useEffect(()=>{
  setState({data:null,failed:false});let newest=0;
  const controller=createPollingController({intervalMs:15000,isVisible:()=>document.visibilityState==='visible',
   request:async(signal:AbortSignal)=>{const r=await fetch(buildApiUrl('/api/research/combo-series?businessDate='+encodeURIComponent(businessDate)),{headers:getAccessAuthHeaders(),credentials:'include',cache:'no-store',signal});
    if(!r.ok)throw Error('Combination records unavailable');const text=await r.text();if(new TextEncoder().encode(text).length>512*1024)throw Error('Combination records bound');return parseComboSeriesView(JSON.parse(text),businessDate);},
   onData:data=>{const stamp=Date.parse(data.updatedAt);if(stamp<newest||stamp>Date.now()+300000)throw Error('Combination clock');newest=stamp;setState({data,failed:false});},
   onError:()=>setState({data:null,failed:true}),
  });
  const wake=()=>controller.visibilityChanged();document.addEventListener('visibilitychange',wake);window.addEventListener('focus',wake);controller.start();
  return()=>{controller.stop();document.removeEventListener('visibilitychange',wake);window.removeEventListener('focus',wake);};
 },[businessDate]);
 if(state.failed)return <p role="status">晚场组合暂时无法核验，请稍后重试。</p>;
 const series=state.data?.series.filter(s=>s.groups.some(g=>g.size===size));if(!series?.length)return null;
 return <section aria-label="晚场组合" data-evening-combo-series className="league-stack" style={{marginBottom:'1.5rem'}}>
  <header><h2>晚场组合 · {size}串1</h2><p>新增组合单独保留，原冻结串关不变。均为低把握人工参考，共用场次的组合并不独立。</p></header>
  {series.map(s=><section key={s.key} data-combo-series-key={s.key}>
   <p>{s.label} · {businessDate} · 发布 {clock(s.publishedAt)} 北京时间</p>
   {s.groups.filter(g=>g.size===size).map(g=>{
    const closed=now>=Date.parse(g.cutoffAt)||g.eventIds.some(id=>now>=Date.parse(s.records.find(d=>d.eventId===id)!.eventVersion));
    const fresh=state.data&&now-Date.parse(state.data.updatedAt)<30000;
    const open=!closed&&fresh&&g.eventIds.every(id=>s.openEventIds.includes(id)&&now<Date.parse(s.saleValidUntil[id]));
    return <article key={g.size+'/'+g.band} className="card" style={{padding:'1.25rem',marginBottom:'1rem'}} data-evening-combo={g.size+'/'+g.band}>
     <h3>{g.size}串1 · {g.band}档 · 组合 SP {g.product}</h3>
     <p>{closed?'已截止，原组合已冻结':open?'当前核验仍在售、未开赛':'当前售期未核实，暂停使用；原记录保留'} · 最早截止 {clock(g.cutoffAt)} 北京时间</p>
     <ol>{g.legs.map(l=>{const d=s.records.find(d=>d.eventId===l.eventId)!;const direction=l.market==='HAD'?{h:'主胜',d:'平局',a:'客胜'}[l.selection]:{h:'让胜',d:'让平',a:'让负'}[l.selection]+'('+(l.handicap!>0?'+':'')+l.handicap+')';
      return <li key={l.eventId} style={{marginBottom:'.75rem'}}><strong>{d.matchNum} {d.homeTeamName} — {d.awayTeamName}</strong><p>{direction} · 冻结 SP {l.sp.toFixed(2)} · 比分 {d.scores.map(s=>s.join(':')).join(' / ')}</p>
       <button type="button" className="btn btn-secondary" onClick={()=>onSelect(officialReferenceRoute({businessDate,eventId:l.eventId}))}>查看单场分析</button></li>;
     })}</ol>
     <p>组合价格冻结于 {clock(s.records[0].quoteObservedAt)}，并非即时价；单场首版与旧串关均保留。</p>
    </article>;
   })}
  </section>)}
 </section>;
}
