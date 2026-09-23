'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {streamJsonObjectArrays}=require('../server/streamedJsonObjectArrays.cjs');
const {buildReferencePerformanceWithPairs:build,buildReferencePerformanceFromSnapshotFile:streamed,readReferenceSnapshotFile}=require('../server/referencePairedBaseline.cjs');
const {fixture,trust,auditAt}=require('../scripts/verifyPublicReferencePairs.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-reconcile-admission-'));let counter=0;
const file=content=>{const name=path.join(dir,`${counter++}.json`);fs.writeFileSync(name,typeof content==='string'?content:JSON.stringify(content));return name;};
const snapshot=fixtures=>({publicReferenceDecisions:fixtures.map(f=>f.record),publicReferenceEvidence:fixtures.map(f=>f.entry)});
const args=(matches,extra={})=>({matches,trustRegistry:trust.registry,generatedAt:auditAt,...extra});
after(()=>{trust.cleanup();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('football-reconcile-admission-'));fs.rmSync(dir,{recursive:true,force:true});});
test('streaming reader matches exact JSON values across one-byte Unicode/escape boundaries',()=>{
 const values=[{name:'中文🎯',quote:'a"\\\n',number:-1.25e9,nested:[true,false,null,{__proto__:null,x:1}]},[],0,'终点'];
 const bytes=JSON.stringify({discard:{huge:'x'.repeat(10000)},keep:values,tail:42}),p=file(bytes),seen=[];
 const evidence=streamJsonObjectArrays(p,{keys:['keep'],chunkBytes:1,onItem:(key,value,index)=>{assert.equal(key,'keep');assert.equal(index,seen.length);seen.push(value);}});
 assert.deepEqual(seen,JSON.parse(bytes).keep);assert.equal(evidence.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(evidence.counts.keep,4);
});
test('streamed skipped fields still require valid JSON and UTF-8; each retained item stays bounded',()=>{
 for(const source of ['{"keep":[],"ignored":[1,]}','{"keep":[],"ignored":"\\q"}','{"keep":[]}true','{"keep":[],"ignored":{"a":1,}}','{"keep":[1,]}','{"keep":[],"keep":[]}'])assert.throws(()=>streamJsonObjectArrays(file(source),{keys:['keep'],onItem(){}}),{code:'FILE_JSON_INVALID'});
 const p=file(Buffer.from('{}'));fs.writeFileSync(p,Buffer.from([123,34,120,34,58,34,255,34,125]));assert.throws(()=>streamJsonObjectArrays(p,{keys:['keep'],onItem(){}}),{code:'FILE_JSON_INVALID'});
 assert.throws(()=>streamJsonObjectArrays(file({keep:[{padding:'x'.repeat(2000)}]}),{keys:['keep'],maxItemChars:1000,onItem(){}}),{code:'STREAM_JSON_ITEM_LIMIT'});
});
test('between-pass size/hash drift and during-read mutation are rejected',()=>{
 const p=file({keep:[1]});const first=streamJsonObjectArrays(p,{keys:['keep'],onItem(){}});fs.writeFileSync(p,'{"keep":[2]}');assert.throws(()=>streamJsonObjectArrays(p,{keys:['keep'],expectedBytes:first.bytes,expectedSha256:first.sha256,onItem(){}}),{code:'FILE_HASH_MISMATCH'});
 assert.throws(()=>streamJsonObjectArrays(p,{keys:['keep'],onItem(){fs.appendFileSync(p,' ');}}),{code:'GENERATION_FILE_CHANGED'});
});
test('duplicate selected top-level fields fail even when a legacy value is not an array',()=>{
 for(const source of ['{"keep":null,"keep":[]}','{"keep":[],"keep":null}','{"keep":{},"keep":[]}','{"keep":false,"keep":{}}'])assert.throws(()=>streamJsonObjectArrays(file(source),{keys:['keep'],allowNonArrays:true,onItem(){}}),{code:'FILE_JSON_INVALID'});
});
test('full paired summary is identical for HAD/HHAD, duplicate copies, exclusions, and trust revocation',()=>{
 const fixtures=[fixture({id:'88701'}),fixture({id:'88702',pool:'HHAD',scores:[2,1]}),fixture({id:'88703',quote:{odds1:3.4,oddsX:3.4,odds2:3.4}})],payload=snapshot(fixtures),p=file(payload);
 const normal=fixtures.map(f=>f.match),conflict=structuredClone(normal[0]);conflict.scoreHome=8;const untraced=structuredClone(normal[1]);delete untraced.postMatchReview.predictionReview.rows.find(row=>row.marketType==='BEST').frozenVersion;
 for(const matches of [normal,[...normal,structuredClone(normal[0])],[...normal,conflict],[normal[0],untraced],[]])for(const registry of [trust.registry,null])assert.deepEqual(streamed(args(matches,{filePath:p,trustRegistry:registry})),build(args(matches,{snapshotPayload:payload,trustRegistry:registry})));
});
test('raw orphan evidence and exact duplicate entries preserve the original retention semantics',()=>{
 const f=fixture(),payload=snapshot([f]);payload.publicReferenceEvidence.push(structuredClone(f.entry),{referenceHash:'f'.repeat(64),evidence:{notAnAttestedRecord:true}});const p=file(payload);assert.deepEqual(streamed(args([f.match],{filePath:p})),build(args([f.match],{snapshotPayload:payload})));
});
test('irrelevant invalid decisions, corrupt evidence, conflicting duplicates and missing bound entries abort',()=>{
 const a=fixture({id:'88704'}),b=fixture({id:'88705'}),valid=snapshot([a,b]);
 const cases=[];let p=structuredClone(valid);p.publicReferenceDecisions[1].decisionId='corrupt';cases.push(p);p=structuredClone(valid);p.publicReferenceEvidence[1].evidence.probabilityModel.version='corrupt';cases.push(p);p=structuredClone(valid);p.publicReferenceEvidence.pop();cases.push(p);p=structuredClone(valid);p.publicReferenceDecisions.push(structuredClone(b.record));cases.push(p);p=structuredClone(valid);p.publicReferenceEvidence.push({...structuredClone(b.entry),extra:'different-entry-digest'});cases.push(p);
 for(const payload of cases){assert.throws(()=>build(args([a.match],{snapshotPayload:payload})));assert.throws(()=>streamed(args([a.match],{filePath:file(payload)})));}
});
test('absent or legacy non-array optional ledgers remain excluded, preserving original denominator',()=>{
 const f=fixture();for(const payload of [{},{publicReferenceDecisions:null,publicReferenceEvidence:[f.entry]},{publicReferenceDecisions:{old:true}},{publicReferenceDecisions:[],publicReferenceEvidence:{old:true}}])assert.deepEqual(streamed(args([f.match],{filePath:file(payload)})),build(args([f.match],{snapshotPayload:payload})));
 assert.deepEqual(streamed(args([f.match],{filePath:path.join(dir,'absent.json')})),build(args([f.match],{snapshotPayload:{}})));
});
test('more than 128 MiB of fully validated bound evidence succeeds under a 96 MiB heap without changing source bytes',()=>{
 const f=fixture({id:'88706',mutateSource:source=>{source.probabilityModel.padding='x'.repeat(2*1024*1024);}}),p=path.join(dir,'large.json'),entry=JSON.stringify(f.entry),fd=fs.openSync(p,'w');
 try{fs.writeSync(fd,'{"publicReferenceDecisions":'+JSON.stringify([f.record])+',"candidateRows":[{"ignored":"'+ 'y'.repeat(1024*1024)+'"}],"publicReferenceEvidence":[');for(let i=0;i<65;i++)fs.writeSync(fd,(i?',':'')+entry);fs.writeSync(fd,']}');}finally{fs.closeSync(fd);}
 assert.ok(fs.statSync(p).size>128*1024*1024);assert.throws(()=>readReferenceSnapshotFile(p),{code:'SELECTED_JSON_VALUE_LIMIT'});
 const input=file({matches:[f.match],trustRegistry:trust.registry,generatedAt:auditAt}),expected=build(args([f.match],{snapshotPayload:snapshot([f])}));
 const program=`const fs=require('node:fs'),crypto=require('node:crypto');const {buildReferencePerformanceFromSnapshotFile:run}=require(${JSON.stringify(require.resolve('../server/referencePairedBaseline.cjs'))});const args=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify(run({...args,filePath:process.argv[2]})));`;
 const before=fs.statSync(p);const child=spawnSync(process.execPath,['--max-old-space-size=96','-e',program,input,p],{encoding:'utf8',timeout:60000,windowsHide:true,maxBuffer:1024*1024});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),expected);const after=fs.statSync(p);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);
});
