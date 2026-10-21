import { useApp } from '../context/AppContextCore';
import { useSearchParams } from 'react-router-dom';
import { RecommendationCenter } from '../components/recommendations/RecommendationCenter';
import { useEffect, useState } from 'react';
import { useOfficialSchedule } from '../hooks/useOfficialSchedule';
import { OfficialScheduleCard } from '../components/recommendations/OfficialSchedule';
interface BestTipsProps {onSelectMatch:(matchId:string)=>void}
export function BestTips({onSelectMatch}:BestTipsProps){
 const {language}=useApp(),[params,setParams]=useSearchParams();
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{const id=window.setInterval(()=>setNow(Date.now()),15000);return()=>window.clearInterval(id);},[]);
 const day=new Date(now+8*3600000).toISOString().slice(0,10),schedule=useOfficialSchedule(day);
 const view=schedule.data&&now-Date.parse(schedule.data.sourceReceivedAt)<=900000&&now-Date.parse(schedule.data.quoteReceivedAt)<=900000?schedule.data:null;
 const requested=params.get('tab'),tab=requested==='two'||requested==='three'?requested:'single';
 return <><RecommendationCenter language={language} onSelectMatch={onSelectMatch} selectedTab={tab} onTabChange={next=>{const query=new URLSearchParams(params);if(next==='single')query.delete('tab');else query.set('tab',next);setParams(query);}}/>
  {tab==='single'&&view&&view.events.length>0&&<section className="league-stack" aria-label="今日官方赛程" data-today-official-schedule>
   <header><h2>今日官方赛程 · {view.events.length} 场</h2><p>选择比赛查看官方 SP、售卖状态和已发布分析。</p></header>
   {view.events.map(event=><OfficialScheduleCard key={event.eventId} event={event} view={view} now={now} onSelect={onSelectMatch}/>)}
  </section>}
  {tab==='single'&&!view&&<p role="status">{schedule.loading?'正在读取今日官方赛程…':'今日官方赛程暂时无法核验，请稍后重试。'}</p>}
  {tab==='single'&&view&&view.events.length===0&&<p role="status">今日官方赛程暂无比赛。</p>}
 </>;
}
