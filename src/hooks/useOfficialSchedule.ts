import { useMemo, useSyncExternalStore } from 'react';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl } from '../services/runtimeUrls';
import { validateOfficialSchedule, type OfficialScheduleView } from '../services/officialSchedule.cjs';
import { createPollingController } from '../services/pollingController';
interface State {data:OfficialScheduleView|null;loading:boolean;failed:boolean}
const empty:State=Object.freeze({data:null,loading:true,failed:false});
export function createOfficialScheduleStore(businessDate:string){
 let snapshot=empty,dispose:(()=>void)|undefined;
 const listeners=new Set<()=>void>(),valid=/^\d{4}-\d{2}-\d{2}$/.test(businessDate);
 const emit=(next:State)=>{if(!listeners.size)return;snapshot=Object.freeze(next);listeners.forEach(fn=>fn());};
 if(!valid)snapshot=Object.freeze({data:null,loading:false,failed:true});
 function start(){
  if(!valid)return;
  let newest=Number.NEGATIVE_INFINITY;
  const controller=createPollingController({
   intervalMs:15000,
   request:async(signal:AbortSignal)=>{
    const response=await fetch(buildApiUrl('/api/research/official-schedule?businessDate='+encodeURIComponent(businessDate)),
     {headers:getAccessAuthHeaders(),credentials:'include',cache:'no-store',signal});
    if(!response.ok)throw Error('Official schedule unavailable');
    const text=await response.text();if(new TextEncoder().encode(text).length>512*1024)throw Error('Official schedule bound');
    return validateOfficialSchedule(JSON.parse(text),businessDate,Date.now());
   },
   onData:data=>{validateOfficialSchedule(data,businessDate,Date.now());const at=Date.parse(data.updatedAt);if(at<newest)throw Error('Official schedule clock');newest=at;emit({data,loading:false,failed:false});},
   onError:()=>emit({data:null,loading:false,failed:true}),
   isVisible:()=>document.visibilityState==='visible',
  });
  const wake=()=>controller.visibilityChanged();document.addEventListener('visibilitychange',wake);window.addEventListener('focus',wake);controller.start();
  dispose=()=>{controller.stop();document.removeEventListener('visibilitychange',wake);window.removeEventListener('focus',wake);};
 }
 return {getSnapshot:()=>snapshot,getServerSnapshot:()=>empty,
  subscribe(listener:()=>void){listeners.add(listener);if(listeners.size===1)start();return()=>{listeners.delete(listener);if(!listeners.size){dispose?.();dispose=undefined;snapshot=valid?empty:Object.freeze({data:null,loading:false,failed:true});}};},
 };
}
export function useOfficialSchedule(businessDate:string){
 const store=useMemo(()=>createOfficialScheduleStore(businessDate),[businessDate]);
 return useSyncExternalStore(store.subscribe,store.getSnapshot,store.getServerSnapshot);
}
