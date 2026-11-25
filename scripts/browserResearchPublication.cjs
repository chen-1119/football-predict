'use strict';
// Run once in the authenticated same-origin page. The function is self-contained
// so automation can execute the reviewed body without exporting session secrets.
async function dispatchPreparedPublication(requestJson){
 const events=[],start=performance.now(),utc=Date.now();let sent=false,lastMono=start,lastUtc=utc;
 const error=message=>{throw Error(message);};
 const clock=()=>{const m=performance.now(),u=Date.now();if(m<lastMono||u<lastUtc)error('PUBLICATION_CLIENT_CLOCK');lastMono=m;lastUtc=u;return Math.max(m-start,u-utc);};
 const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
 const parse=JSON.parse(requestJson),retry=parse.action==='publication-retry',originalJson=retry?parse.originalRequestJson:requestJson,original=JSON.parse(originalJson);
 if(original.action!=='publish'||(!retry&&parse.action!=='publish')||original.version!=='research-broker-request-v1')error('PUBLICATION_CLIENT_INPUT');
 const hash=await digest(originalJson),dispatchHash=await digest(requestJson),draft=JSON.parse(original.json),key='reviewed-analysis-'+draft.businessDate+'-batch-'+original.draftHash;
 if(retry&&parse.originalRequestSha256!==hash)error('PUBLICATION_CLIENT_INPUT');
 const request=async(url,options,limit)=>{
  const controller=new AbortController();let timer;
  try{return await Promise.race([(async()=>{const r=await fetch(url,{...options,signal:controller.signal});const value=await r.json();return {status:r.status,value};})(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('PUBLICATION_CLIENT_RESPONSE_UNKNOWN'));},limit);})]);}
  finally{clearTimeout(timer);}
 };
 const readBudget=()=>{const left=180000-clock();if(left<=0)error('PUBLICATION_CLIENT_WAIT_BUDGET');return Math.min(15000,left);};
 const me=await request('/api/account/me',{credentials:'same-origin',cache:'no-store'},readBudget()),account=me.value;
 if(me.status!==200||account.ok!==true||!['operator','admin'].includes(account.user?.role)||typeof account.csrfToken!=='string')error('PUBLICATION_CLIENT_LOGIN');
 const post=(url,body,write=false)=>request(url,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','x-csrf-token':account.csrfToken},body},write?90000:sent?15000:readBudget());
 const readBody=JSON.stringify({version:original.version,action:'publication-read',recordKey:key,draftHash:original.draftHash});
 const read=await post('/api/operator/research/publication-read',readBody);events.push({kind:'before',at:new Date().toISOString(),...read});
 if(read.status!==200||read.value.ok!==true) return {state:'read-first',sent,events};
 if(read.value.state!=='not-observed')return {state:read.value.verified===true?'complete':'read-first',sent,events};
 for(let n=0;n<55&&clock()<180000;n++){
  const requestStart=performance.now(),observation=await post('/api/operator/research/publish-readiness',originalJson),elapsed=performance.now()-requestStart,v=observation.value;
  events.push({kind:'readiness',at:new Date().toISOString(),...observation});
  if(observation.status!==200||v.ok!==true||v.version!=='research-publish-readiness-v1'||v.requestSha256!==hash||v.draftHash!==original.draftHash||v.recordKey!==key||v.submitAllowed!==false||v.submitted!==false||v.retryWriteAutomatically!==false)return {state:'read-first',sent,events};
  if(v.state==='complete')return {state:v.verified===true?'complete':'read-first',sent,events};
  if(v.state!=='waiting'&&v.state!=='ready')return {state:'read-first',sent,events};
  if(v.state==='ready'&&elapsed>=0&&elapsed<=4000&&Number.isFinite(v.sourceAgeMs)&&v.sourceAgeMs>=0&&v.sourceAgeMs+elapsed<=10000&&clock()<180000){
   // No file download, tool round-trip or user interaction between this check
   // and dispatch. Even fetch throwing after this point consumes this attempt.
   sent=true;events.push({kind:'dispatch',at:new Date().toISOString(),requestSha256:dispatchHash});
   try{const result=await post(retry?'/api/operator/research/publication-retry':'/api/operator/research/publish',requestJson,true);events.push({kind:'response',at:new Date().toISOString(),...result});}
   catch(e){events.push({kind:'unknown-response',at:new Date().toISOString(),error:String(e.message)});}
   // Independent read only. A missing response or ACK never causes another POST.
   try{const after=await post('/api/operator/research/publication-read',readBody);events.push({kind:'after',at:new Date().toISOString(),...after});return {state:after.status===200&&after.value.ok===true&&after.value.verified===true?'committed-and-acknowledged':'read-first',sent,events};}
   catch(e){return {state:'read-first',sent,events,error:String(e.message)};}
  }
  if(clock()+3500>=180000)break;await new Promise(resolve=>setTimeout(resolve,3500));
 }
 return {state:'waiting-budget-exhausted',sent,events};
}
module.exports={dispatchPreparedPublication};
