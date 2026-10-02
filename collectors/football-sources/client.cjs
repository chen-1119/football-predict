'use strict';
const {PROVIDERS,urlFor,hash,retryAt,instant}=require('./core.cjs');
const {parse}=require('./adapters.cjs');
const MAX_BYTES=4*1024*1024;
async function readBody(response,signal,maxBytes=MAX_BYTES){
  const declared=response.headers.get('content-length');
  if(declared&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))throw new Error('response-too-large');
  const chunks=[];let count=0;
  if(!response.body)throw new Error('empty-response');
  const reader=response.body.getReader();
  try { while(true){ if(signal.aborted)throw new Error('request-timeout');const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>maxBytes)throw new Error('response-too-large');chunks.push(Buffer.from(value)); } }
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}
async function collect(job,repo,{now=Date.now,fetchImpl=globalThis.fetch,footballDataKey='',userAgent='football-predict/1.0 (https://github.com/chen-1119/football-predict)',timeoutMs=12000}={}){
  const url=urlFor(job),key=hash(url),provider=job.provider,started=now(),old=await repo.getCache(key);
  if(old&&instant(old.expiresAt)>started&&instant(old.receivedAt)<=started)return {state:'cached',provider,cache:old,requested:false};
  if(provider==='football-data.org'&&!footballDataKey)return {state:'credentials-missing',provider,requested:false};
  const reserved=await repo.reserve(provider,started,PROVIDERS[provider]);
  if(!reserved.allowed)return {state:reserved.reason,provider,requested:false};
  const headers={'accept':'application/json','user-agent':userAgent};
  if(provider==='football-data.org')headers['X-Auth-Token']=footballDataKey;
  if(old?.etag)headers['if-none-match']=old.etag;
  if(old?.lastModified)headers['if-modified-since']=old.lastModified;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(url,{headers,signal:controller.signal,redirect:'error'}),received=now();
    const status=response.status;
    if([401,403].includes(status)){await repo.failure(provider,started,received,status===401?'credentials-rejected':'access-restricted',received+6*3600000);return {state:status===401?'credentials-rejected':'access-restricted',provider,requested:true};}
    if(status===429){await repo.failure(provider,started,received,'rate-limited',retryAt(response.headers,received,60000));return {state:'rate-limited',provider,requested:true};}
    if(status!==200&&status!==304)throw new Error('source-http-error');
    const expires=Date.parse(response.headers.get('expires')||'');
    const ttl=Number.isFinite(job.ttlMs)&&job.ttlMs>=60000?Math.min(job.ttlMs,6*3600000):1800000;
    const expiresAt=new Date(Math.max(received+ttl,Number.isFinite(expires)?expires:0)).toISOString();
    if(status===304){
      if(!old)throw new Error('not-modified-without-cache');
      const cache={...old,checkedAt:new Date(received).toISOString(),expiresAt};
      await repo.save(cache,null,{provider,started,finished:received,state:'not-modified'});
      return {state:'not-modified',provider,cache,requested:true};
    }
    const raw=await readBody(response,controller.signal),finished=now();
    if(controller.signal.aborted)throw new Error('request-timeout');
    const body=JSON.parse(raw),value=parse(body,job,finished);
    if(value.rows?.some(r=>r.sourceUpdatedAt&&instant(r.sourceUpdatedAt)>finished))throw new Error('source-clock-in-future');
    const cache={key,provider,kind:job.kind,url,receivedAt:new Date(finished).toISOString(),checkedAt:new Date(finished).toISOString(),expiresAt,
      etag:response.headers.get('etag'),lastModified:response.headers.get('last-modified'),rawHash:hash(raw),value,
      attribution:PROVIDERS[provider].attribution,referenceOnly:true};
    await repo.save(cache,raw,{provider,started,finished,state:value.rejected?'partial':'available'});
    return {state:value.rejected?'partial':'available',provider,cache,requested:true};
  }catch(error){
    const allowed=['response-too-large','empty-response','source-http-error','not-modified-without-cache','source-clock-in-future'];
    const state=controller.signal.aborted?'request-timeout':allowed.includes(error?.message)?error.message:'source-or-schema-error';
    await repo.failure(provider,started,now(),state,now()+5*60000);
    return {state,provider,requested:true};
  }finally{clearTimeout(timer);}
}
module.exports={collect,readBody,MAX_BYTES};
