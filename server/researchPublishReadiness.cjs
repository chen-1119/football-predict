'use strict';
// Advisory only: a fresh observation never replaces the root publisher's gates.
const {performance}=require('node:perf_hooks');
const {createHash}=require('node:crypto');
const {decodeRequest}=require('./researchWriteService.cjs');
const {readResearchRequestBody}=require('./researchRequestBody.cjs');
const policy=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs');
const runtime=require('../scripts/recommendationPlatform/reviewedAnalysisRuntime.cjs');
const {readLiveOfficialSnapshot}=require('../scripts/recommendationPlatform/liveOfficialHandicap.cjs');
const {loadCollectorTrustRegistry}=require('../src/services/collectorAttestation.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
function createReadiness({pool}={}){
 return async raw=>{
  const r=decodeRequest(raw);if(r.action!=='publish')fail('RESEARCH_READINESS_ACTION');
  const draft=JSON.parse(r.json);if(draft.version!==4||draft.eventAuthority!=='signed-official-events-v1')fail('RESEARCH_READINESS_VERSION');
  if(!pool?.connect)fail('RESEARCH_READINESS_UNAVAILABLE');
  const start=Date.now(),mono=performance.now(),key='reviewed-analysis-'+draft.businessDate+'-batch-'+r.draftHash;let c,broken,lastUtc=start,lastMono=mono;
  const remaining=()=>{const now=Date.now(),m=performance.now();if(now<lastUtc||m<lastMono)fail('RESEARCH_READINESS_CLOCK');lastUtc=now;lastMono=m;const left=8000-Math.max(now-start,m-mono);if(left<=0)fail('RESEARCH_READINESS_OBSERVATION_AGED');return left;};
  const bounded=(work,late=()=>{})=>new Promise((resolve,reject)=>{let done=false;const timer=setTimeout(()=>{done=true;reject(Object.assign(Error('RESEARCH_READINESS_OBSERVATION_AGED'),{code:'RESEARCH_READINESS_OBSERVATION_AGED'}));},Math.ceil(remaining()));Promise.resolve().then(work).then(value=>{if(done){late(value);return;}done=true;clearTimeout(timer);try{remaining();resolve(value);}catch(e){late(value);reject(e);}},e=>{if(!done){done=true;clearTimeout(timer);reject(e);}});});
  const base={version:'research-publish-readiness-v1',requestSha256:sha(raw),draftHash:r.draftHash,
   recordKey:key,submitAllowed:false,submitted:false,retryWriteAutomatically:false};
  try{
   const owned=await bounded(()=>pool.connect(),late=>late.release(Error('READINESS_CONNECTION_LATE')));
   c={query:(...args)=>bounded(()=>owned.query(...args)),release:e=>owned.release(e)};
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await c.query("SET LOCAL statement_timeout='8000ms'");await c.query("SET LOCAL lock_timeout='2000ms'");
   await c.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
   const rows=(await c.query('SELECT artifact_key FROM football.private_model_artifacts WHERE artifact_key=ANY($1) LIMIT 3',[[key,key+'-ack']])).rows;
   const at=async()=>{const v=(await c.query('SELECT clock_timestamp() AS now')).rows[0]?.now;return v instanceof Date?v.toISOString():v;};
   let asOf=await at(),result;
   if(rows.length){
    const record=rows.some(x=>x.artifact_key===key),ack=rows.some(x=>x.artifact_key===key+'-ack');
    if(record&&ack){const saved=await runtime.readPublication(c,key,asOf);if(policy.hash(saved.v.draft)!==r.draftHash)fail('RESEARCH_PUBLICATION_BINDING');result={state:'complete',verified:true};}
    else result={state:'read-first',verified:false};
   }else{
    const prior=await runtime.projection(c,draft.businessDate,asOf);
    policy.check(prior.records.length+draft.singles.length<=32,'DAILY_RECORD_BOUND');
    policy.check(draft.singles.every(s=>!prior.records.some(p=>p.eventId===s.eventId)),'EVENT_ALREADY_FROZEN');
    const snapshot=readLiveOfficialSnapshot(),trustRegistry=loadCollectorTrustRegistry(process.env.SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH||require('node:path').resolve(__dirname,'../deploy/light-server/collector-trust-registry.json')),evidenceByEvent={};
    const snapshotClock=await at();if(Date.parse(snapshotClock)<Date.parse(asOf))fail('RESEARCH_READINESS_CLOCK');asOf=snapshotClock;
    // Terminal sale/identity/signature errors are never converted to waiting.
    try{
     policy.make(draft,{matches:[],snapshot,trustRegistry,asOf,evidenceByEvent});
     const next=await at();if(Date.parse(next)<Date.parse(asOf))fail('RESEARCH_READINESS_CLOCK');asOf=next;
     policy.make(draft,{matches:[],snapshot,trustRegistry,asOf,evidenceByEvent});
     const age=Math.max(...snapshot.endpoints.filter(e=>['current','calculator'].includes(e.method)).flatMap(e=>[Date.parse(asOf)-Date.parse(e.requestedAt),Date.parse(asOf)-Date.parse(e.receivedAt)]));
     result={state:age<=15000?'ready':'waiting',verified:false,sourceAgeMs:age};
    }catch(error){
     if(error.code!=='REVIEWED_ANALYSIS_OFFICIAL_EVENT_FRESH_CLOCK')throw error;
     // Stale data permits passive waiting only. Future/reversed clocks refuse.
     const entries=['current','calculator'].map(m=>snapshot?.endpoints?.filter(e=>e.method===m));
     if(entries.some(es=>es?.length!==1))throw error;
     const age=entries.flat().flatMap(e=>[Date.parse(asOf)-Date.parse(e.requestedAt),Date.parse(asOf)-Date.parse(e.receivedAt)]);
     if(age.some(v=>!Number.isFinite(v)||v<0)||entries.flat().some(e=>Date.parse(e.requestedAt)>Date.parse(e.receivedAt))||Math.max(...age)<=30000)throw error;
     result={state:'waiting',verified:false,sourceAgeMs:Math.max(...age)};
    }
   }
   await c.query('ROLLBACK');
   remaining();
   return {...base,...result,observedAt:asOf};
  }catch(error){broken=error;if(c)try{await c.query('ROLLBACK');}catch(e){broken=e;}throw error;}
  finally{if(c)c.release(broken);}
 };
}
function createReadinessHandler({accounts,observe}={}){
 const rates=new Map();let active=false;
 return async(req,res,url)=>{
  if(url.pathname!=='/api/operator/research/publish-readiness')return false;
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Vary':'Cookie','Connection':'close'});res.end(JSON.stringify({...value,submitAllowed:false,submitted:false,retryWriteAutomatically:false}));return true;};
  if(req.method!=='POST'||url.search)return send(405,{ok:false,error:'POST_REQUIRED'});
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')||![undefined,'identity'].includes(req.headers['content-encoding']))return send(415,{ok:false,error:'JSON_UTF8_REQUIRED'});
  if(active)return send(503,{ok:false,error:'RESEARCH_READINESS_BUSY'});active=true;
  try{
   const auth=await accounts.authorizeMutation(req,{role:['operator','admin']});
   if(!auth?.user?.id||!['operator','admin'].includes(auth.user.role))return send(403,{ok:false,error:'OPERATOR_REQUIRED'});
   const now=Date.now();for(const [k,v]of rates)if(now-v.at>=300000)rates.delete(k);
   if(!rates.has(auth.user.id)){if(rates.size>=256)return send(503,{ok:false,error:'RESEARCH_READINESS_BUSY'});rates.set(auth.user.id,{at:now,n:0});}
   if(++rates.get(auth.user.id).n>60)return send(429,{ok:false,error:'RESEARCH_READINESS_RATE_LIMITED'});
   const raw=await readResearchRequestBody(req,{timeoutMs:8000});
   const current=await accounts.authorizeMutation(req,{role:['operator','admin']});
   if(current?.user?.id!==auth.user.id||!['operator','admin'].includes(current.user.role))return send(403,{ok:false,error:'OPERATOR_REQUIRED'});
   if(typeof observe!=='function')return send(503,{ok:false,error:'RESEARCH_READINESS_UNAVAILABLE'});
   return send(200,{ok:true,...await observe(raw)});
  }catch(error){const code=error.code||'';return send(['authentication_required','insufficient_role','origin_rejected','csrf_rejected'].includes(code)?error.status||403:503,{ok:false,error:/^(RESEARCH|REVIEWED_ANALYSIS)_[A-Z0-9_]+$/.test(code)||['authentication_required','insufficient_role','origin_rejected','csrf_rejected'].includes(code)?code:'RESEARCH_READINESS_UNAVAILABLE'});}
  finally{active=false;}
 };
}
module.exports={createReadiness,createReadinessHandler};
