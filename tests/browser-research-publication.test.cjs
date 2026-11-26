'use strict';
const test=require('node:test'),a=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{webcrypto}=require('node:crypto');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),f=require('./fixtures/reviewed-official-event.cjs');
async function run({mode='success',readyDelay=0,sourceAge=1000}={}){
 const v=f.setup(),json=JSON.stringify(v.draft),raw=JSON.stringify({version:'research-broker-request-v1',action:'publish',json,sha256:p.sha(json),draftHash:p.hash(v.draft)}),hash=p.sha(raw),key='reviewed-analysis-'+v.draft.businessDate+'-batch-'+p.hash(v.draft);
 let time=0,writes=0,reads=0,ready=0;const calls=[],m={exports:{}};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[f.NOW+time]));}static now(){return f.NOW+time;}}
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../scripts/browserResearchPublication.cjs'),'utf8'),{module:m,exports:m.exports,TextEncoder,AbortController,clearTimeout,crypto:webcrypto,Date:Clock,performance:{now:()=>time},setTimeout:(fn,ms)=>{if(ms===3500){time+=ms;fn();return;}return setTimeout(fn,mode==='hung-post'&&ms===90000||mode==='hung-readiness'?5:ms);},fetch:async(url,opts)=>{
  calls.push(url);let value={ok:true},status=200;
  if(url==='/api/account/me')value={ok:true,user:{role:'admin'},csrfToken:'local-synthetic'};
  else if(url.endsWith('/publication-read')){reads++;value={ok:true,state:mode==='complete'?'committed-and-acknowledged':mode==='partial'?'record-present-ack-missing':writes&&mode==='success'?'committed-and-acknowledged':'not-observed',verified:mode==='complete'||Boolean(writes&&mode==='success')};}
  else if(url.endsWith('/publish-readiness')){ready++;time+=readyDelay;if(mode==='hung-readiness')return{status:200,json:()=>new Promise(()=>{})};value={ok:true,version:'research-publish-readiness-v1',state:mode==='waiting'?'waiting':'ready',requestSha256:mode==='drift'?'f'.repeat(64):hash,draftHash:p.hash(v.draft),recordKey:key,submitAllowed:false,submitted:false,retryWriteAutomatically:false,sourceAgeMs:sourceAge};}
  else{writes++;a.equal(opts.body,raw);if(mode==='network')throw Error('lost response');if(mode==='hung-post')return{status:200,json:()=>new Promise(()=>{})};value={ok:false,error:'TERMINAL_FAILURE'};status=503;}
  return {ok:status===200,status,json:async()=>value};
 }});
 const result=await m.exports.dispatchPreparedPublication(raw);return{result,writes,reads,ready,calls,time};
}
test('ready is immediately followed by one exact-byte POST and independent read',async()=>{const x=await run();a.equal(x.writes,1);a.equal(x.reads,2);a.equal(x.result.state,'committed-and-acknowledged');a.deepEqual(x.calls.slice(-3),['/api/operator/research/publish-readiness','/api/operator/research/publish','/api/operator/research/publication-read']);});
for(const mode of ['network','failure'])test('unknown or failed dispatch never retries: '+mode,async()=>{const x=await run({mode});a.equal(x.writes,1);a.equal(x.result.sent,true);a.equal(x.result.state,'read-first');a.equal(x.reads,2);});
for(const mode of ['complete','partial','drift'])test('no dispatch on '+mode,async()=>{const x=await run({mode});a.equal(x.writes,0);a.equal(x.result.sent,false);});
test('passive wait ends without dispatch at bounded client deadline',async()=>{const x=await run({mode:'waiting'});a.equal(x.writes,0);a(x.time<=180000);a(x.ready<=55);});
test('an old readiness round-trip never dispatches',async()=>{const x=await run({readyDelay:5000});a.equal(x.writes,0);a.equal(x.result.sent,false);});
test('handoff reserves margin under the original root fifteen-second preparation gate',async()=>{const old=await run({sourceAge:14900,readyDelay:100});a.equal(old.writes,0);const fresh=await run({sourceAge:5000,readyDelay:2000});a.equal(fresh.writes,1);});
test('a hung publish body times out as unknown and only reads afterward',async()=>{const x=await run({mode:'hung-post'});a.equal(x.writes,1);a.equal(x.reads,2);a.equal(x.result.state,'read-first');a(x.result.events.some(e=>e.kind==='unknown-response'));});
test('a hung readiness body stops without reaching dispatch',async()=>{await a.rejects(run({mode:'hung-readiness'}),/PUBLICATION_CLIENT_RESPONSE_UNKNOWN/);});
