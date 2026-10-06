'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const history=require('../scripts/readPrematchV3TeamHistory.cjs');
const reader=require('../scripts/readPrematchV3OnlineInputs.cjs');
const {fingerprintSshKeyBlob}=require('../scripts/releaseSshHostKeyPin.cjs');
const {collectResults,validResultEvent}=require('../scripts/recommendationPlatform/results.cjs');
const {stableHash}=require('../src/services/webConsensusEvidence.cjs');
const {epochNanoseconds:clock}=require('../src/services/prematchV3Clock.cjs');
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const targets=[{teamId:'synthetic-home',teamName:'Synthetic Home'},{teamId:'synthetic-away',teamName:'Synthetic Away'}];
const identities=()=>({id:'sporttery_123',sourceMatchId:'123',businessDate:'2026-10-06',
 homeTeamId:targets[0].teamId,homeTeamName:targets[0].teamName,awayTeamId:targets[1].teamId,awayTeamName:targets[1].teamName,
 kickoffTime:'2026-10-06T14:00:00Z',buyEndTime:'2026-10-06 22:00:00',predictionMeta:{cutoffTime:'2026-10-06 22:00:00'}});
function row(changes={}){
 return {teamId:targets[0].teamId,teamName:targets[0].teamName,sourceMatchId:'122',kickoffTime:'2026-10-01T14:00:00.000000Z',
  homeTeamId:targets[0].teamId,homeTeamName:targets[0].teamName,awayTeamId:targets[1].teamId,awayTeamName:targets[1].teamName,
  historySnapshotBound:true,historySnapshotBinding:'single',historySourceMatchId:'122',historyKickoffTime:'2026-10-01T14:00:00.000000Z',historyEventVersion:null,
  historyHomeTeamId:targets[0].teamId,historyAwayTeamId:targets[1].teamId,
  scoreHome:2,scoreAway:1,resultObservedAt:null,resultSource:null,resultFinal:null,sourceResultPeriod:null,resultHead:null,...changes};
}
function payload(changes={}){
 const end='2026-10-06T07:00:00.000001Z',start='2026-06-08T07:00:00.000001Z';
 return {version:history.VERSION,readOnly:'on',productionWrites:0,observedAt:'2026-10-06T07:00:00.000002Z',
  windowStartAt:start,windowEndAt:end,generation:{data_generation_id:'synthetic-generation',manifest_hash:'a'.repeat(64)},rows:[row()],...changes};
}
function head(changes={}){
 const m={...row(),eventVersion:'2026-10-01T14:00:00Z',resultSource:'synthetic-ledger-source',...changes};
 const out=collectResults([m],new Map(),{isFinal:()=>true,isVoid:()=>false},Date.parse('2026-10-01T16:00:00Z')).updates[0];
 assert(out);assert.equal(validResultEvent(out),true);return out;
}
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'prematch-v3-history-test-'));
 t.after(()=>{for(const name of fs.readdirSync(directory))fs.unlinkSync(path.join(directory,name));fs.rmdirSync(directory);});
 const blob=Buffer.from('synthetic-history-host-key-only').toString('base64'),knownHosts=path.join(directory,'synthetic.known_hosts');
 fs.writeFileSync(knownHosts,`synthetic.invalid ssh-ed25519 ${blob}\n`);
 const env={RELEASE_DEPLOY_HOST:'synthetic.invalid',RELEASE_DEPLOY_USER:'synthetic_user',RELEASE_DEPLOY_KEY:path.join(directory,'fake-private-key'),
  RELEASE_DEPLOY_KNOWN_HOSTS:knownHosts,RELEASE_DEPLOY_HOST_KEY_SHA256:fingerprintSshKeyBlob(blob)};
 const input=path.join(directory,'target.json'),output=path.join(directory,'history.json');
 reader.readInputs({date:'2026-10-06',output:input},env,()=>Buffer.from(JSON.stringify({version:reader.VERSION,readOnly:'on',productionWrites:0,
  businessDate:'2026-10-06',observedAt:new Date().toISOString(),generation:{data_generation_id:'synthetic-target',manifest_hash:'b'.repeat(64)},
  matches:[identities()],modelArtifactInventory:[],modelArtifacts:[]})));
 return {directory,env,input,output};
}
function freshPayload(changes={}){
 const end=new Date(),start=new Date(end.getTime()-history.LOOKBACK_DAYS*86400000);
 return payload({observedAt:end.toISOString(),windowStartAt:start.toISOString(),windowEndAt:end.toISOString(),...changes});
}

test('target identity requires exact IDs and names, rejects conflicts and enforces 32 matches / 64 teams',()=>{
 assert.deepEqual(history.targetsFor({matches:[identities()]}),targets);
 for(const patch of [{homeTeamId:''},{homeTeamId:'unsafe\nID'},{homeTeamId:null},{awayTeamName:''},{awayTeamName:'x'.repeat(129)}]){
  assert.throws(()=>history.targetsFor({matches:[{...identities(),...patch}]}),/V3_HISTORY_TARGET_IDENTITY/);
 }
 assert.throws(()=>history.targetsFor({matches:[identities(),{...identities(),homeTeamName:'Different Home'}]}),/V3_HISTORY_TARGET_CONFLICT/);
 for(const matches of [[],Array(33).fill(identities()),null])assert.throws(()=>history.targetsFor({matches}),/V3_HISTORY_TARGET_BOUND/);
});

test('SQL is readonly, fixed 120-day lookback, per-team 12 rows, safe base64 parameters and exact result-head index joins',()=>{
 const sql=history.query(targets);assert.match(sql,/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
 assert.match(sql,/statement_timeout='15000'/);assert.match(sql,/lock_timeout='2000'/);assert.match(sql,/LIMIT 12/);
 assert.match(sql,/h\.event_version>=statement_timestamp\(\)-interval '120 days'/);assert.match(sql,/ROLLBACK;\n$/);
 assert.match(sql,/recent_heads AS MATERIALIZED/);assert.match(sql,/e\.payload->>'state'='FINAL'/);
 assert.match(sql,/e\.id=h\.event_id AND e\.source_match_id=h\.source_match_id AND e\.event_version=h\.event_version/);
 assert.match(sql,/source_match_id=m\.source_match_id AND kickoff_time=m\.event_version AND status='FINISHED'/);
 assert.match(sql,/ORDER BY id LIMIT 2/);assert.match(sql,/CASE WHEN snap\.n=1 THEN snap\.payloads->0 ELSE NULL END/);
 const historyLookup=sql.slice(sql.indexOf('SELECT payload FROM football.match_snapshots'),sql.indexOf(') snapshot'));
 assert.doesNotMatch(historyLookup,/payload->>|targets\.team_id/,'large history payload scans must not reappear');
 assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COPY|CREATE|ALTER|DROP|COMMIT|CALL|DO)\b/i);
 const injection=[{teamId:"';DROP TABLE x;--",teamName:"';COMMIT;--"}],quoted=history.query(injection);
 assert(!quoted.includes(injection[0].teamId));assert(!quoted.includes(injection[0].teamName));
 const encoded=quoted.match(/decode\('([A-Za-z0-9+/=]+)','base64'\)/)[1];assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64')),injection);
 for(const bad of [[],Array(65).fill(targets[0]),null])assert.throws(()=>history.query(bad),/V3_HISTORY_TARGET_BOUND/);
});

test('history response has exact window and team/event binding, keeps unknown result/source fields unknown',()=>{
 const value=payload(),before=JSON.stringify(value);assert.equal(history.validate(value,targets),value);
 assert.equal(JSON.stringify(value),before);assert.equal(value.rows[0].resultObservedAt,null);assert.equal(value.rows[0].sourceResultPeriod,null);
 for(const patch of [{readOnly:'off'},{productionWrites:1},{windowStartAt:'2026-06-08T07:00:00Z'},
  {windowEndAt:'2026-10-06T07:00:00.000003Z'},{generation:{data_generation_id:'x',manifest_hash:123}},{rows:Array(25).fill(row())}]){
  assert.throws(()=>history.validate(payload(patch),targets),/V3_HISTORY_/);
 }
 for(const patch of [{teamName:'Other'},{homeTeamId:'other'},{sourceMatchId:'not-numeric'},
  {kickoffTime:'2026-10-06T07:00:00.000001Z'},{kickoffTime:'2026-06-08T07:00:00Z'},
  {kickoffTime:'2026-10-01T14:00:00'}])assert.throws(()=>history.validate(payload({rows:[row(patch)]}),targets),/V3_HISTORY_/);
 assert.throws(()=>history.validate(payload({rows:[row(),row()]}),targets),/V3_HISTORY_DUPLICATE/);
 const rows=Array.from({length:13},(_,i)=>row({sourceMatchId:String(100+i)}));
 assert.throws(()=>history.validate(payload({rows}),targets),/V3_HISTORY_TEAM_BOUND/);
});

test('ledger counts require exact source event, both team IDs, original score and observed-before-read boundaries',()=>{
 const valid=row({resultHead:head()}),at=payload().observedAt;assert.equal(history.validLedgerResultForRow(valid,{observedAt:at}),true);
 for(const badHead of [head({sourceMatchId:'999'}),head({homeTeamId:'other'}),head({awayTeamId:'other'}),head({scoreHome:3}),
  {...head(),eventVersion:'2026-10-01T14:00:00.000000001Z'},
  {...head(),observedAt:'2026-10-06T07:00:00.000003Z'},
  {...head(),observedAt:'2026-10-01T13:59:59.999999999Z'},
  {...head(),observedAt:'2026-10-01T16:00:00'},
  {...head(),sourceResultObservedAt:'2026-10-01T16:00:00.000000001Z'},
  {...head(),settlementOnly:true}])assert.equal(history.validLedgerResultForRow({...valid,resultHead:badHead},{observedAt:at}),false);
 for(const patch of [{scoreHome:null},{scoreAway:null},{scoreHome:'2'},{homeTeamId:null},{awayTeamId:null},{resultHead:null},
  {historySnapshotBound:false},{historySnapshotBound:null},{historySourceMatchId:'999'},{historyKickoffTime:null},
  {historyKickoffTime:'2026-10-01T14:00:00.000000001Z'},{historyEventVersion:'2026-10-01T14:00:00.000000001Z'},
  {historyHomeTeamId:'foreign'},{historyAwayTeamId:'foreign'},{homeTeamName:null},{homeTeamName:'Renamed'},
  {resultHeadObservedAt:null},{resultHeadObservedAt:'2026-10-01T16:00:00.000000001Z'}]){
  assert.equal(history.validLedgerResultForRow({...valid,...patch},{observedAt:at}),false);
 }
 assert.equal(history.validLedgerResultForRow(valid,{observedAt:'2026-10-01T16:00:00Z'}),true);
 assert.equal(history.validLedgerResultForRow(valid,{observedAt:'2026-10-01T15:59:59.999999999Z'}),false);
});

test('two target-team rows can reference one valid event without inflating independent match count or asserting 90-minute source admission',()=>{
 const first=row({resultHead:head()}),second={...first,teamId:targets[1].teamId,teamName:targets[1].teamName};
 assert.deepEqual(history.ledgerSummary(payload({rows:[first,second]})),{validLedgerTeamRows:2,distinctValidLedgerEvents:1});
 assert.equal(first.sourceResultPeriod,null);assert.equal(first.resultSource,null);
 assert.deepEqual(history.ledgerSummary(payload({rows:[row()]})),{validLedgerTeamRows:0,distinctValidLedgerEvents:0});
 const lacking=row({historySnapshotBound:false,historySnapshotBinding:'missing',homeTeamName:null,awayTeamName:null,
  historySourceMatchId:null,historyKickoffTime:null,historyHomeTeamId:null,historyAwayTeamId:null,scoreHome:null,scoreAway:null,resultHead:head()});
 assert.equal(history.validate(payload({rows:[lacking]}),targets).rows.length,1);
 assert.deepEqual(history.ledgerSummary(payload({rows:[lacking]})),{validLedgerTeamRows:0,distinctValidLedgerEvents:0});
});

test('pinned mock read preserves target and raw bytes, append-only history, clock provenance and stored-reference qualification',t=>{
 const f=fixture(t),targetBytes=fs.readFileSync(f.input),targetRaw=fs.readFileSync(f.input+'.remote-response.json');let calls=0,raw;
 const out=history.readHistory({input:f.input,output:f.output},{env:f.env,execute:(binary,args,options)=>{
  calls++;assert.equal(binary,'ssh');assert(args.includes('StrictHostKeyChecking=yes'));assert(args.includes('IdentitiesOnly=yes'));
  assert.match(args.at(-1),/sudo -n env -i PATH=\/usr\/bin:\/bin/);assert.equal(options.maxBuffer,history.MAX_BYTES);
  assert.equal(options.timeout,45000);assert.equal(options.windowsHide,true);assert.match(options.input,/--set=VERBOSITY=sqlstate/);
  raw=Buffer.from(JSON.stringify(freshPayload()));return raw;
 }});
 assert.equal(out.productionWrites,0);assert.equal(calls,1);assert.equal(out.validLedgerTeamRows,0);assert.equal(out.distinctValidLedgerEvents,0);
 const saved=JSON.parse(fs.readFileSync(f.output,'utf8')),{contentHash,...body}=saved;
 assert.equal(contentHash,stableHash(body));assert.equal(saved.transport.remoteResponseSha256,digest(raw));
 assert.equal(saved.transport.bytes,raw.length);assert.equal(saved.formalEligible,false);
 assert.match(saved.sourceAdmission,/stored-reference-only/);assert.equal(saved.transport.providerClockVerification,'not-established-by-transport-clock');
 assert.equal(saved.targetReadSha256,digest(targetBytes));assert.equal(fs.readFileSync(f.input).equals(targetBytes),true);
 assert.equal(fs.readFileSync(f.input+'.remote-response.json').equals(targetRaw),true);
 assert.equal(fs.readFileSync(f.output+'.remote-response.json').equals(raw),true);
 assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>assert.fail('must not execute')}),/V3_HISTORY_NEW_OUTPUT_REQUIRED/);
});

test('changed target payload, pre-target history clock, invalid pin and raced output fail without overwriting evidence',t=>{
 const f=fixture(t),base=JSON.parse(fs.readFileSync(f.input,'utf8'));
 const changed={...base,matches:[]};fs.writeFileSync(f.input,JSON.stringify(changed));
 assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>assert.fail('must not execute')}),/V3_HISTORY_INPUT_BINDING/);
 fs.writeFileSync(f.input,JSON.stringify(base));
 assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:{...f.env,RELEASE_DEPLOY_HOST_KEY_SHA256:'secret'},execute:()=>assert.fail('must not execute')}),/V3_HISTORY_SSH_PIN_INVALID/);
 const earlier=Number(clock(base.observedAt)/1000000n)-1;
 assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>Buffer.from(JSON.stringify(freshPayload({observedAt:new Date(earlier).toISOString(),windowEndAt:new Date(earlier).toISOString(),windowStartAt:new Date(earlier-history.LOOKBACK_DAYS*86400000).toISOString()})))}),/V3_HISTORY_HISTORY_BEFORE_TARGET_READ/);
 const marker='synthetic-existing-output';
 assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>{
  fs.writeFileSync(f.output,marker);return Buffer.from(JSON.stringify(freshPayload()));
 }}),/V3_HISTORY_OUTPUT_COMMIT_FAILED/);
 assert.equal(fs.readFileSync(f.output,'utf8'),marker);assert.equal(fs.existsSync(f.output+'.remote-response.json'),true);
});

test('only exact five-character SQLSTATE markers escape diagnostics, never raw SQL, stderr or secret strings',t=>{
 assert.equal(history.pgSqlState(Buffer.from('ERROR:  57014\n')), '57014');
 assert.equal(history.pgSqlState(Buffer.from('psql:<stdin>:18: ERROR:  42703\n')), '42703');
 for(const stderr of [Buffer.from('ERROR: relation secret does not exist\n'),Buffer.from('ERROR: 123456\n'),Buffer.from('secret 57014'),Buffer.alloc(65537),'ERROR: 57014'])assert.equal(history.pgSqlState(stderr),null);
 assert.equal(history.remoteSqlState(Buffer.from('V3_HISTORY_REMOTE_SQLSTATE_57014\n')),'57014');
 assert.equal(history.remoteSqlState(Buffer.from('secret V3_HISTORY_REMOTE_SQLSTATE_57014\n')),null);
 const f=fixture(t),secret='SYNTHETIC_SECRET_SHOULD_NOT_ESCAPE';
 assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>{const error=Error(secret);error.stderr=Buffer.from(secret+'\nV3_HISTORY_REMOTE_SQLSTATE_57014\n');throw error;}}),error=>error.message==='V3_HISTORY_REMOTE_SQLSTATE_57014');
 assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>{const error=Error(secret);error.stderr=Buffer.from(secret);throw error;}}),error=>error.message==='V3_HISTORY_PINNED_READ_FAILED');
 // Execute the actual generated remote program in a synthetic process: its
 // psql error is sanitized before crossing SSH, rather than trusting a stub.
 let code;
 history.readHistory({input:f.input,output:f.output},{env:f.env,execute:(_binary,_args,options)=>{code=options.input;return Buffer.from(JSON.stringify(freshPayload()));}});
 let safe='';const sandbox={Buffer,require:()=>({execFileSync:(_binary,args,options)=>{
  assert(args.includes('--set=VERBOSITY=sqlstate'));assert.equal(options.timeout,22000);
  const error=Error(secret);error.stderr=Buffer.from(`ERROR:  57014\n${secret}\n`);throw error;
 }}),process:{stderr:{write:text=>{safe+=text;}},exitCode:0}};
 vm.runInNewContext(code,sandbox);assert.equal(safe,'V3_HISTORY_REMOTE_SQLSTATE_57014\n');assert.equal(sandbox.process.exitCode,1);
});

test('raw response size/type and JSON errors fail before writes; input bytes cannot change during the read',t=>{
 const f=fixture(t),before=fs.readFileSync(f.input),rawBefore=fs.readFileSync(f.input+'.remote-response.json');
 for(const raw of ['',Buffer.alloc(0),Buffer.alloc(history.MAX_BYTES+1)]){
  assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>raw}),/V3_HISTORY_RESPONSE_BOUND/);
 }
 assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>Buffer.from('secret-invalid-json')}),error=>error.message==='V3_HISTORY_RESPONSE_JSON');
 for(const target of [f.input,f.input+'.remote-response.json']){
  assert.throws(()=>history.readHistory({input:f.input,output:f.output},{env:f.env,execute:()=>{
   fs.appendFileSync(target,'\n');return Buffer.from(JSON.stringify(freshPayload()));
  }}),/V3_HISTORY_INPUT_CHANGED/);
  fs.writeFileSync(f.input,before);fs.writeFileSync(f.input+'.remote-response.json',rawBefore);
 }
 assert.equal(fs.existsSync(f.output),false);assert.equal(fs.existsSync(f.output+'.remote-response.json'),false);
});
