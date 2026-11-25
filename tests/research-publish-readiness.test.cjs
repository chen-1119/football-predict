'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
const p=require('../scripts/recommendationPlatform/reviewedAnalysis.cjs'),f=require('./fixtures/reviewed-official-event.cjs');
function fixture({age=1000,rows=[],prior=[],mutate=()=>{},dbAdvance=0}={}){
 const v=f.setup();for(const e of v.snapshot.endpoints){e.requestedAt=e.receivedAt=f.stamp(f.NOW-age);f.resign(e,v.pair);}mutate(v);
 const json=JSON.stringify(v.draft),raw=Buffer.from(JSON.stringify({version:'research-broker-request-v1',action:'publish',json,sha256:p.sha(json),draftHash:p.hash(v.draft)}));
 const sql=[],released=[],filename=path.resolve(__dirname,'../server/researchPublishReadiness.cjs'),native=Module.createRequire(filename),m={exports:{}};let ticks=0;
 const pool={async connect(){return{async query(s){sql.push(s);a(!/\b(INSERT|UPDATE|DELETE|CREATE|DROP|pg_advisory.*lock)\b/i.test(s));return{rows:s.includes('artifact_key=ANY')?rows:s==='SELECT clock_timestamp() AS now'?[{now:f.stamp(f.NOW+(ticks++?dbAdvance:0))}]:[]};},release(e){released.push(e);}};}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{Buffer,Date,setTimeout,clearTimeout,module:m,exports:m.exports,__dirname:path.dirname(filename),require:id=>id.includes('liveOfficialHandicap')?{readLiveOfficialSnapshot:()=>v.snapshot}:id.includes('collectorAttestation')?{loadCollectorTrustRegistry:()=>v.trustRegistry}:id.includes('reviewedAnalysisRuntime')?{projection:async()=>({records:prior}),readPublication:async()=>({v:{draft:v.draft}})}:native(id),process:{env:{}}});
 return{raw,v,sql,released,observe:m.exports.createReadiness({pool}),handler:m.exports.createReadinessHandler,pool};
}
test('signed V4 readiness binds exact bytes and uses only RR READ ONLY without write or advisory locks',async()=>{
 const x=fixture(),r=await x.observe(x.raw);a.equal(r.state,'ready');a.equal(r.requestSha256,p.sha(x.raw));a.equal(r.submitAllowed,false);a.equal(r.submitted,false);a.equal(r.sourceAgeMs,1000);a.equal(x.sql[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');a.equal(x.sql.at(-1),'ROLLBACK');a.equal(x.released.length,1);
});
test('stale or insufficient-margin sources only wait with no publication authority',async()=>{for(const age of [16000,31000]){const x=fixture({age}),r=await x.observe(x.raw);a.equal(r.state,'waiting');a.equal(r.verified,false);a.equal(r.submitAllowed,false);}});
for(const [name,change]of [
 ['signature',v=>v.snapshot.endpoints[0].collectorAttestation.signature='invalid'],
 ['ordered identity',v=>{v.snapshot.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].homeTeamId=999;f.resign(v.snapshot.endpoints[0],v.pair);}],
 ['closed sale',v=>{for(const e of v.snapshot.endpoints){e.payload.value.matchInfoList[0].subMatchList[0].sellStatus=2;f.resign(e,v.pair);}}],
 ['future clock',v=>{const e=v.snapshot.endpoints[0];e.requestedAt=e.receivedAt=f.stamp(f.NOW+1000);f.resign(e,v.pair);}],
 ['reversed clock',v=>{const e=v.snapshot.endpoints[0];e.requestedAt=f.stamp(f.NOW);f.resign(e,v.pair);}]
])test('readiness refuses '+name,async()=>{const x=fixture({mutate:change});await a.rejects(x.observe(x.raw));a.equal(x.released.length,1);});
test('final database clock cannot reuse a source that aged while checking',async()=>{const x=fixture({dbAdvance:20000});a.equal((await x.observe(x.raw)).state,'waiting');});
test('partial record or orphan ACK is read-first; full originals resolve complete without new publish',async()=>{for(const ack of [false,true]){const x=fixture(),k='reviewed-analysis-'+x.v.draft.businessDate+'-batch-'+p.hash(x.v.draft),y=fixture({rows:[{artifact_key:k+(ack?'-ack':'')}]});a.equal((await y.observe(y.raw)).state,'read-first');}const x=fixture(),k='reviewed-analysis-'+x.v.draft.businessDate+'-batch-'+p.hash(x.v.draft),y=fixture({rows:[{artifact_key:k},{artifact_key:k+'-ack'}]});a.equal((await y.observe(y.raw)).state,'complete');});
test('duplicate event and daily capacity refuse before source readiness',async()=>{const x=fixture();for(const prior of [[{eventId:x.v.draft.singles[0].eventId}],Array.from({length:32},(_,i)=>({eventId:String(900+i)}))]){const y=fixture({prior});await a.rejects(y.observe(y.raw));}});
test('readiness polls cannot spend mutation quota and role is checked twice',async()=>{
 const {Readable}=require('node:stream'),x=fixture();let auth=0,posts=0;
 const accounts={authorizeMutation:async()=>{auth++;return{user:{id:'operator',role:'operator'}};},authenticate:async()=>null};
 const handler=require('../server/researchHttp.cjs').createResearchHttp({accounts,readiness:async()=>({state:'waiting'}),submit:async()=>{posts++;return{retryWriteAutomatically:false};}});
 for(let i=0;i<12;i++){const req=Readable.from([x.raw]);Object.assign(req,{method:'POST',headers:{'content-type':'application/json'}});const res={writeHead(s){this.status=s;},end(){}};await handler(req,res,new URL('https://example.com/api/operator/research/publish-readiness'));a.equal(res.status,200);}
 const req=Readable.from([x.raw]);Object.assign(req,{method:'POST',headers:{'content-type':'application/json'}});const res={writeHead(s){this.status=s;},end(){}};await handler(req,res,new URL('https://example.com/api/operator/research/publish'));a.equal(res.status,200);a.equal(posts,1);a.equal(auth,26);
});
