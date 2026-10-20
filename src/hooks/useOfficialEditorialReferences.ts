import { useMemo, useSyncExternalStore } from 'react';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl } from '../services/runtimeUrls';
import { parseOfficialEditorialReferences, type OfficialEditorialReferences } from '../services/officialEditorialReferences';
import { createPollingController } from '../services/pollingController';
interface State {data:OfficialEditorialReferences|null;loading:boolean;failed:boolean}
const empty:State=Object.freeze({data:null,loading:true,failed:false});
export function createOfficialEditorialReferenceStore(businessDate:string){
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
    const response=await fetch(buildApiUrl('/api/research/official-event-references?businessDate='+encodeURIComponent(businessDate)),
     {headers:getAccessAuthHeaders(),credentials:'include',cache:'no-store',signal});
    if(!response.ok)throw Error('Official reference unavailable');
    const text=await response.text();if(new TextEncoder().encode(text).length>512*1024)throw Error('Official reference bound');
    return parseOfficialEditorialReferences(JSON.parse(text),businessDate);
   },
   onData:data=>{const at=Date.parse(data.updatedAt);if(!Number.isFinite(at)||at<newest||at>Date.now()+300000)throw Error('Official reference clock');newest=at;emit({data,loading:false,failed:false});},
   onError:()=>emit({data:null,loading:false,failed:true}),
   isVisible:()=>document.visibilityState==='visible',
  });
  const wake=()=>controller.visibilityChanged();document.addEventListener('visibilitychange',wake);window.addEventListener('focus',wake);controller.start();
  dispose=()=>{controller.stop();document.removeEventListener('visibilitychange',wake);window.removeEventListener('focus',wake);};
 }
 return {
  getSnapshot:()=>snapshot,getServerSnapshot:()=>empty,
  subscribe(listener:()=>void){listeners.add(listener);if(listeners.size===1)start();return()=>{listeners.delete(listener);if(!listeners.size){dispose?.();dispose=undefined;snapshot=valid?empty:Object.freeze({data:null,loading:false,failed:true});}};},
 };
}
export function useOfficialEditorialReferences(businessDate:string){
 const store=useMemo(()=>createOfficialEditorialReferenceStore(businessDate),[businessDate]);
 return useSyncExternalStore(store.subscribe,store.getSnapshot,store.getServerSnapshot);
}
