import { useSyncExternalStore } from 'react';
import { getAccessAuthHeaders } from '../services/accessControl';
import { buildApiUrl } from '../services/runtimeUrls';
import { createPollingController } from '../services/pollingController';
import { parseRecommendationCenter, type RecommendationCenterData } from '../services/recommendationCenterView';

interface Snapshot {data:RecommendationCenterData|null;loading:boolean;failed:boolean;authorizationRequired:boolean}
const empty:Snapshot=Object.freeze({data:null,loading:true,failed:false,authorizationRequired:false});
let snapshot=empty;
const listeners=new Set<()=>void>();
let dispose:(()=>void)|undefined;
let refreshRequest=()=>undefined;
const emit=(next:Snapshot)=>{snapshot=Object.freeze(next);listeners.forEach(fn=>fn());};
function start(){
  let newest=Number.NEGATIVE_INFINITY;
  const controller=createPollingController<RecommendationCenterData>({
    intervalMs:15000,timeoutMs:10000,maxRetryMs:120000,
    request:async signal=>{
      const response=await fetch(buildApiUrl('/api/v1/daily-featured-combos'),{headers:getAccessAuthHeaders(),cache:'no-store',credentials:'include',signal});
      if(!response.ok)throw Object.assign(new Error('Recommendation request failed'),{status:response.status});
      return parseRecommendationCenter(await response.json());
    },
    onData:data=>{const stamp=Date.parse(data.updatedAt);if(stamp<newest||stamp>Date.now()+300000)throw new Error('Regressed product snapshot');newest=stamp;emit({data,loading:false,failed:false,authorizationRequired:false});},
    onError:error=>{const status=typeof error==='object'&&error!==null&&'status' in error?error.status:null;const authorizationRequired=status===401||status===403;emit({...snapshot,data:authorizationRequired?null:snapshot.data,loading:false,failed:true,authorizationRequired});},
    isVisible:()=>document.visibilityState==='visible',
  });
  refreshRequest=()=>{controller.refresh();return undefined;};
  const wake=()=>controller.visibilityChanged();
  document.addEventListener('visibilitychange',wake);window.addEventListener('focus',wake);controller.start();
  dispose=()=>{controller.stop();document.removeEventListener('visibilitychange',wake);window.removeEventListener('focus',wake);refreshRequest=()=>undefined;};
}
function subscribe(listener:()=>void){listeners.add(listener);if(listeners.size===1)start();return ()=>{listeners.delete(listener);if(!listeners.size){dispose?.();dispose=undefined;snapshot=empty;}};}
const getSnapshot=()=>snapshot;
const getServerSnapshot=()=>empty;
export function useRecommendationCenter(){const value=useSyncExternalStore(subscribe,getSnapshot,getServerSnapshot);return {...value,refresh:()=>refreshRequest()};}
