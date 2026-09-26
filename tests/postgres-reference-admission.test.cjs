'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {createPostgresGenerationSource,readPostgresReferenceSnapshot:read}=require('../scripts/postgresGenerationSource.cjs');
const {readGenerationSelectedObject}=require('../server/dataGenerationStore.cjs');
const {commitCurrentDataGeneration}=require('../server/dataGenerationBundle.cjs');
const {buildPublicReferenceArchive,buildPublicReferenceIndex,SOURCE_ID,INDEX_ID,INDEX_PREFIX}=require('../server/publicReferenceArchive.cjs');
const {fixture,trust,auditAt}=require('../scripts/verifyPublicReferencePairs.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'football-pg-reference-'));let count=0;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const payload=fixtures=>({updatedAt:auditAt,retentionDays:31,rows:[{unrelated:'never retained'}],publicReferenceDecisions:fixtures.map(f=>f.record),publicReferenceEvidence:fixtures.map(f=>f.entry)});
const contextFor=(text,name=String(count++))=>{const base=path.join(dir,name);fs.mkdirSync(base);const bytes=typeof text==='string'?text:JSON.stringify(text);fs.writeFileSync(path.join(base,'prediction-snapshots.json'),bytes);return{generationDir:base,manifest:{files:[{path:'prediction-snapshots.json',bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}]}};};
after(()=>{trust.cleanup();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('football-pg-reference-'));fs.rmSync(dir,{recursive:true,force:true});});
test('complete arrays retain order, metadata and exact archive/index hashes including odd leaf proofs',()=>{
 const cases=[[],[fixture({id:'88601'})],[fixture({id:'88602'}),fixture({id:'88603'}),fixture({id:'88604'})]];
 for(const fixtures of cases){const p=payload(fixtures);if(fixtures.length){p.publicReferenceEvidence.push(structuredClone(fixtures[0].entry));p.publicReferenceEvidence.push({referenceHash:'f'.repeat(64),evidence:{orphan:true}});}const actual=read(contextFor(p));assert.deepEqual(actual,{updatedAt:p.updatedAt,retentionDays:p.retentionDays,publicReferenceDecisions:p.publicReferenceDecisions,publicReferenceEvidence:p.publicReferenceEvidence});const expectedArchive=buildPublicReferenceArchive(p),archive=buildPublicReferenceArchive(actual);assert.deepEqual(archive,expectedArchive);assert.deepEqual(buildPublicReferenceIndex(archive),buildPublicReferenceIndex(expectedArchive));}
});
test('manifest admission rejects missing membership, wrong size/hash and malformed skipped candidates',()=>{
 assert.throws(()=>read({}),{code:'INVALID_CONTEXT'});const c=contextFor(payload([]));assert.throws(()=>read({...c,manifest:{files:[]}}),{code:'FILE_NOT_IN_MANIFEST'});
 const wrongHash=structuredClone(c);wrongHash.manifest.files[0].sha256='0'.repeat(64);assert.throws(()=>read(wrongHash),{code:'FILE_HASH_MISMATCH'});
 const wrongSize=structuredClone(c);wrongSize.manifest.files[0].bytes++;assert.throws(()=>read(wrongSize),{code:'FILE_SIZE_MISMATCH'});
 assert.throws(()=>read(contextFor('{"publicReferenceDecisions":[],"publicReferenceEvidence":[],"rows":[1,]}')),{code:'FILE_JSON_INVALID'});
 assert.throws(()=>read(contextFor('{"publicReferenceEvidence":[],"publicReferenceEvidence":null}')),{code:'FILE_JSON_INVALID'});
});
test('explicit aggregate/item bounds fail instead of returning partial or silently empty arrays',()=>{
 const p=payload([fixture()]),c=contextFor(p);assert.throws(()=>read(c,{maxRetainedChars:10}),{code:'POSTGRES_REFERENCE_ADMISSION_LIMIT'});assert.throws(()=>read(c,{maxItems:1}),{code:'POSTGRES_REFERENCE_ADMISSION_LIMIT'});assert.throws(()=>read(c,{maxRetainedChars:321*1024*1024}),/invalid native reference admission bound/);assert.equal(read(c).publicReferenceEvidence.length,1);
});
test('unrelated corrupt evidence cannot produce a partial valid projected archive',()=>{
 const fixtures=[fixture({id:'88605'}),fixture({id:'88606'})],p=payload(fixtures);p.publicReferenceEvidence[1].evidence.probabilityModel.version='corrupt';assert.throws(()=>buildPublicReferenceArchive(read(contextFor(p))),/PUBLIC_REFERENCE_EVIDENCE_BINDING_INVALID/);
});
test('actual native source iterator emits exactly the original row bytes and preserves unmanaged inventory',async()=>{
 const base=path.join(dir,'native');fs.mkdirSync(base);const publicDataDir=path.join(base,'public');fs.mkdirSync(publicDataDir);const storeDir=path.join(base,'store'),p=payload([fixture({id:'88607'}),fixture({id:'88608'})]);
 const meta={sourceCycleId:'qa-pg-reference',updatedAt:auditAt,source:'sporttery'},external={updatedAt:auditAt,source:'external',matches:{}};
 const files={'matches-current.json':[],'matches-history.json':[],'sync-meta.json':meta,'external-signals.json':external,'odds-history.json':{rows:[]},'prediction-snapshots.json':p,'model-calibration.json':{version:'qa',generatedAt:auditAt}};
 for(const [name,value]of Object.entries(files))fs.writeFileSync(path.join(publicDataDir,name),JSON.stringify(value));commitCurrentDataGeneration({storeDir,publicDataDir,sourceCycleId:meta.sourceCycleId,committedAt:auditAt});
 const source=createPostgresGenerationSource({storeDir,publicDataDir});
 try{await source.prepare({query:async sql=>({rows:sql.includes('SELECT id FROM football.source_snapshots')?[{id:'independent:keep'},{id:INDEX_PREFIX+'stale'}]:[]})},{mode:'backfill'});const actual=[];for await(const row of source.tableRows('source_snapshots'))actual.push(row);
  const archive=buildPublicReferenceArchive(p),index=buildPublicReferenceIndex(archive),expected=[{id:'sync-meta:current',source:'sporttery',captured_at:auditAt,payload:JSON.stringify(meta)},{id:'external-signals:current',source:'external',captured_at:auditAt,payload:JSON.stringify(external)},{id:SOURCE_ID,source:archive.source,captured_at:archive.lastRecordedAt,payload:JSON.stringify(archive)},...([{id:INDEX_ID,payload:index.manifest},...index.shards].map(row=>({id:row.id,source:'sporttery:public-reference-index',captured_at:archive.lastRecordedAt,payload:JSON.stringify(row.payload)})))].sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
  assert.deepEqual(actual,expected);assert.deepEqual(new Set(source.activeIds('source_snapshots')),new Set(['independent:keep',...expected.map(row=>row.id)]));source.beforeCommit();
 }finally{source.close();}
});
test('unique bound evidence over 256 MiB materializes and validates with bounded 1536 MiB heap',()=>{
 const base=path.join(dir,'large');fs.mkdirSync(base);const filePath=path.join(base,'prediction-snapshots.json'),records=[],evidenceHash=crypto.createHash('sha256'),fd=fs.openSync(filePath,'w');evidenceHash.update('[');
 try{fs.writeSync(fd,'{"updatedAt":'+JSON.stringify(auditAt)+',"retentionDays":31,"publicReferenceEvidence":[');for(let i=0;i<130;i++){const f=fixture({id:String(885000+i),mutateSource:source=>{source.probabilityModel.padding='x'.repeat(2*1024*1024);}}),entry=JSON.stringify(f.entry);records.push(f.record);fs.writeSync(fd,(i?',':'')+entry);evidenceHash.update((i?',':'')+entry);}evidenceHash.update(']');fs.writeSync(fd,'],"publicReferenceDecisions":'+JSON.stringify(records)+',"rows":[]}');}finally{fs.closeSync(fd);}
 const bytes=fs.statSync(filePath).size,fileHash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024),hashFd=fs.openSync(filePath,'r');try{let n;while((n=fs.readSync(hashFd,buffer,0,buffer.length,null)))fileHash.update(buffer.subarray(0,n));}finally{fs.closeSync(hashFd);}
 const c={generationDir:base,manifest:{files:[{path:'prediction-snapshots.json',bytes,sha256:fileHash.digest('hex')}]}},contextPath=path.join(base,'context.json');fs.writeFileSync(contextPath,JSON.stringify(c));assert.ok(bytes>256*1024*1024&&bytes<320*1024*1024);assert.throws(()=>readGenerationSelectedObject(c,'prediction-snapshots.json',{keys:['publicReferenceDecisions','publicReferenceEvidence']}),{code:'SELECTED_JSON_VALUE_LIMIT'});
 const program=`const fs=require('node:fs');const {readPostgresReferenceSnapshot:read}=require(${JSON.stringify(require.resolve('../scripts/postgresGenerationSource.cjs'))});const {buildPublicReferenceArchive:archive,buildPublicReferenceIndex:index}=require(${JSON.stringify(require.resolve('../server/publicReferenceArchive.cjs'))});const value=read(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))),a=archive(value),i=index(a);process.stdout.write(JSON.stringify({records:value.publicReferenceDecisions.length,evidence:value.publicReferenceEvidence.length,archiveHash:a.contentHash,evidenceHash:a.evidenceContentHash,indexRows:i.manifest.rowCount,archiveVersion:i.manifest.archiveContentHash,evidenceVersion:i.manifest.evidenceContentHash}));`;
 const child=spawnSync(process.execPath,['--max-old-space-size=1536','-e',program,contextPath],{encoding:'utf8',timeout:180000,windowsHide:true,maxBuffer:1024*1024});assert.equal(child.status,0,child.stderr);const expectedHash=sha(JSON.stringify(records)),expectedEvidence=evidenceHash.digest('hex');assert.deepEqual(JSON.parse(child.stdout),{records:130,evidence:130,archiveHash:expectedHash,evidenceHash:expectedEvidence,indexRows:130,archiveVersion:expectedHash,evidenceVersion:expectedEvidence});
});
