'use strict';
// Fresh online PostgreSQL history facts, never local cached matches or a writer.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {verifyOnlineRead,validateTransport,MAX_BYTES:MAX_INPUT_RAW_BYTES}=require('./readPrematchV3OnlineInputs.cjs');
const {validateReleaseSshHostKeyPin,buildPinnedSshBaseOptions}=require('./releaseSshHostKeyPin.cjs');
const {epochNanoseconds:clock}=require('../src/services/prematchV3Clock.cjs');
const {stableHash}=require('../src/services/webConsensusEvidence.cjs');
const {validResultEvent}=require('./recommendationPlatform/results.cjs');
const VERSION='prematch-v3-online-team-history-v1',MAX_BYTES=6*1024*1024,PER_TEAM=12,MAX_TEAMS=64,LOOKBACK_DAYS=120;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function check(v,code){if(!v)throw Error('V3_HISTORY_'+code);}
function targetsFor(input){
 check(Array.isArray(input.matches)&&input.matches.length<=32,'TARGET_BOUND');
 const targets=new Map();
 for(const m of input.matches) for(const side of ['home','away']) {
  const teamId=m[side+'TeamId'],teamName=m[side+'TeamName'];
  check(typeof teamId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(teamId)&&typeof teamName==='string'&&teamName.length>0&&teamName.length<=128,'TARGET_IDENTITY');
  if(targets.has(teamId))check(targets.get(teamId).teamName===teamName,'TARGET_CONFLICT');
  targets.set(teamId,{teamId,teamName});
 }
 check(targets.size>0&&targets.size<=MAX_TEAMS,'TARGET_BOUND');return [...targets.values()];
}
function query(targets){
 check(Array.isArray(targets)&&targets.length>0&&targets.length<=MAX_TEAMS,'TARGET_BOUND');
 const encoded=Buffer.from(JSON.stringify(targets)).toString('base64');
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15000';
SET LOCAL lock_timeout='2000';
WITH targets AS (SELECT "teamId" AS team_id,"teamName" AS team_name FROM jsonb_to_recordset(convert_from(decode('${encoded}','base64'),'UTF8')::jsonb) AS t("teamId" text,"teamName" text)),
recent_heads AS MATERIALIZED (
 SELECT h.source_match_id,h.event_version,e.observed_at,e.payload AS result_head
 FROM football.recommendation_result_heads h JOIN football.recommendation_result_events e
 ON e.id=h.event_id AND e.source_match_id=h.source_match_id AND e.event_version=h.event_version
 WHERE h.event_version>=statement_timestamp()-interval '${LOOKBACK_DAYS} days'
 AND h.event_version<statement_timestamp() AND e.payload->>'state'='FINAL'
 AND (e.payload->>'homeTeamId' IN (SELECT team_id FROM targets) OR e.payload->>'awayTeamId' IN (SELECT team_id FROM targets))
),
selected AS (SELECT targets.team_id,targets.team_name,h.* FROM targets CROSS JOIN LATERAL (
 SELECT * FROM recent_heads h WHERE h.result_head->>'homeTeamId'=targets.team_id OR h.result_head->>'awayTeamId'=targets.team_id
 ORDER BY h.event_version DESC,h.source_match_id LIMIT ${PER_TEAM}
) h),
bound AS (SELECT m.*,snap.n AS snapshot_count,CASE WHEN snap.n=1 THEN snap.payloads->0 ELSE NULL END AS history_payload
 FROM selected m CROSS JOIN LATERAL (
  SELECT count(*) AS n,jsonb_agg(snapshot.payload) AS payloads FROM (
   SELECT payload FROM football.match_snapshots
   WHERE dataset='history' AND source_match_id=m.source_match_id AND kickoff_time=m.event_version AND status='FINISHED'
   ORDER BY id LIMIT 2
  ) snapshot
 ) snap)
SELECT jsonb_build_object('version','${VERSION}','observedAt',clock_timestamp(),
 'readOnly',current_setting('transaction_read_only'),'productionWrites',0,
 'windowStartAt',statement_timestamp()-interval '${LOOKBACK_DAYS} days','windowEndAt',statement_timestamp(),
 'generation',(SELECT jsonb_object_agg(key,value) FROM football.projection_meta WHERE key IN ('data_generation_id','manifest_hash','committed_at')),
 'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('teamId',m.team_id,'teamName',m.team_name,
 'sourceMatchId',m.source_match_id,'kickoffTime',m.event_version,'homeTeamId',m.result_head->'homeTeamId','awayTeamId',m.result_head->'awayTeamId',
 'homeTeamName',m.history_payload->'homeTeamName','awayTeamName',m.history_payload->'awayTeamName',
 'historySnapshotBound',m.snapshot_count=1,'historySnapshotBinding',CASE WHEN m.snapshot_count=0 THEN 'missing' WHEN m.snapshot_count=1 THEN 'single' ELSE 'ambiguous' END,
 'historySourceMatchId',m.history_payload->'sourceMatchId','historyKickoffTime',m.history_payload->'kickoffTime','historyEventVersion',m.history_payload->'eventVersion',
 'historyHomeTeamId',m.history_payload->'homeTeamId','historyAwayTeamId',m.history_payload->'awayTeamId',
 'scoreHome',m.history_payload->'scoreHome','scoreAway',m.history_payload->'scoreAway',
 'resultObservedAt',m.history_payload->'resultObservedAt','resultSource',m.history_payload->'resultSource','resultFinal',m.history_payload->'resultFinal',
 'sourceResultPeriod',m.history_payload->'scorePeriod','resultHead',m.result_head,'resultHeadObservedAt',m.observed_at) ORDER BY m.team_id,m.event_version DESC)
 FROM bound m),'[]'::jsonb));
ROLLBACK;
`;
}
function validate(value,targets){
 check(value?.version===VERSION&&value.readOnly==='on'&&value.productionWrites===0&&clock(value.observedAt)!==null,'RESPONSE');
 check(clock(value.windowStartAt)!==null&&clock(value.windowEndAt)!==null
   &&clock(value.windowEndAt)<=clock(value.observedAt)
   &&clock(value.windowEndAt)-clock(value.windowStartAt)===BigInt(LOOKBACK_DAYS)*86400000000000n,'WINDOW');
 check(value.generation&&/^[a-f0-9]{64}$/.test(value.generation.manifest_hash||'')&&typeof value.generation.data_generation_id==='string','GENERATION');
 check(Array.isArray(value.rows)&&value.rows.length<=targets.length*PER_TEAM,'ROWS_BOUND');
 const expected=new Map(targets.map(t=>[t.teamId,t.teamName])),seen=new Set(),counts=new Map();
 for(const row of value.rows){
  check(expected.get(row.teamId)===row.teamName&&typeof row.sourceMatchId==='string'&&/^\d{1,20}$/.test(row.sourceMatchId)
    &&clock(row.kickoffTime)!==null&&clock(row.kickoffTime)<clock(value.windowEndAt)
    &&clock(row.kickoffTime)>=clock(value.windowStartAt),'ROW_IDENTITY');
  check(row.homeTeamId===row.teamId||row.awayTeamId===row.teamId,'TEAM_IDENTITY');
  const key=[row.teamId,row.sourceMatchId,clock(row.kickoffTime)].join('|');check(!seen.has(key),'DUPLICATE');seen.add(key);
  counts.set(row.teamId,(counts.get(row.teamId)||0)+1);check(counts.get(row.teamId)<=PER_TEAM,'TEAM_BOUND');
 }
 return value;
}
// Ledger integrity is a separate check from provider/90-minute admission.
// Unknown history scores are not filled from a result head, and both teams'
// rows may reference one event without making it two independent matches.
function validLedgerResultForRow(row,{observedAt}={}){
 try{
  const head=row?.resultHead,kickoff=clock(row?.kickoffTime),readAt=clock(observedAt),resultAt=clock(head?.observedAt);
  if(!validResultEvent(head)||head.state!=='FINAL'||head.settlementOnly===true
    ||kickoff===null||readAt===null||resultAt===null||resultAt<kickoff||resultAt>readAt
    ||head.sourceMatchId!==row.sourceMatchId||clock(head.eventVersion)!==kickoff
    ||typeof row.homeTeamId!=='string'||!row.homeTeamId||typeof row.awayTeamId!=='string'||!row.awayTeamId
    ||head.homeTeamId!==row.homeTeamId||head.awayTeamId!==row.awayTeamId
    ||![row.scoreHome,row.scoreAway].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||head.scoreHome!==row.scoreHome||head.scoreAway!==row.scoreAway)return false;
  if(row.historySnapshotBound!==true||row.historySourceMatchId!==row.sourceMatchId
    ||clock(row.historyKickoffTime)!==kickoff
    ||(row.historyEventVersion!==null&&row.historyEventVersion!==undefined&&clock(row.historyEventVersion)!==kickoff)
    ||row.historyHomeTeamId!==row.homeTeamId||row.historyAwayTeamId!==row.awayTeamId
    ||!((row.homeTeamId===row.teamId&&row.homeTeamName===row.teamName)||(row.awayTeamId===row.teamId&&row.awayTeamName===row.teamName)))return false;
  if(row.resultHeadObservedAt!==undefined&&clock(row.resultHeadObservedAt)!==resultAt)return false;
  if(head.sourceResultObservedAt!==undefined){
   const sourceAt=clock(head.sourceResultObservedAt);
   if(sourceAt===null||sourceAt<kickoff||sourceAt>resultAt)return false;
  }
  return true;
 }catch{return false;}
}
function ledgerSummary(value){
 const validRows=value.rows.filter(row=>validLedgerResultForRow(row,{observedAt:value.observedAt}));
 return {validLedgerTeamRows:validRows.length,distinctValidLedgerEvents:new Set(validRows.map(row=>
  JSON.stringify([row.sourceMatchId,String(clock(row.kickoffTime))]))).size};
}
function pgSqlState(stderr){
 if(!Buffer.isBuffer(stderr)||stderr.length>65536)return null;
 const match=stderr.toString('utf8').match(/^(?:psql:[^\r\n]*:\s*)?(?:ERROR|FATAL):\s+([0-9A-Z]{5})\s*$/m);
 return match?.[1]??null;
}
function remoteSqlState(stderr){
 if(!Buffer.isBuffer(stderr)||stderr.length>65536)return null;
 const match=stderr.toString('utf8').match(/^V3_HISTORY_REMOTE_SQLSTATE_([0-9A-Z]{5})\r?$/m);
 return match?.[1]??null;
}
function readHistory({input,output},{env=process.env,execute=cp.execFileSync}={}){
 check(Number(process.versions.node.split('.')[0])===22,'NODE22_REQUIRED');
 const inputPath=path.resolve(input),destination=path.resolve(output),rawPath=destination+'.remote-response.json';
 check(fs.statSync(inputPath).size<=24*1024*1024,'INPUT_BOUND');
 const bytes=fs.readFileSync(inputPath);let online;
 try{online=JSON.parse(bytes);}catch{throw Error('V3_HISTORY_INPUT_JSON');}
 const companion=online.transport?.remoteResponseFile;
 check(typeof companion==='string'&&path.basename(companion)===companion,'INPUT_BINDING');
 const rawInputPath=path.join(path.dirname(inputPath),companion);
 check(fs.statSync(rawInputPath).size<=MAX_INPUT_RAW_BYTES,'INPUT_RAW_BOUND');
 const rawInput=fs.readFileSync(rawInputPath);
 check(verifyOnlineRead(online,{date:online.businessDate,rawResponse:rawInput}),'INPUT_BINDING');
 const targets=targetsFor(online);
 check(!fs.existsSync(destination)&&!fs.existsSync(rawPath)&&fs.statSync(path.dirname(destination)).isDirectory(),'NEW_OUTPUT_REQUIRED');
 const host=env.RELEASE_DEPLOY_HOST,user=env.RELEASE_DEPLOY_USER;
 check(typeof host==='string'&&/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)&&typeof user==='string'&&/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(user)
  &&typeof env.RELEASE_DEPLOY_KEY==='string'&&env.RELEASE_DEPLOY_KEY.length>0&&env.RELEASE_DEPLOY_KEY.length<=4096&&!/[\x00-\x1f\x7f]/.test(env.RELEASE_DEPLOY_KEY),'SSH_CONFIG');
 let pin;try{pin=validateReleaseSshHostKeyPin({knownHostsPath:env.RELEASE_DEPLOY_KNOWN_HOSTS,host,port:22,expectedFingerprint:env.RELEASE_DEPLOY_HOST_KEY_SHA256});}catch{throw Error('V3_HISTORY_SSH_PIN_INVALID');}
 const sql=query(targets),remote=`'use strict';const cp=require('node:child_process');const pgSqlState=${pgSqlState.toString()};try{const out=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','--set=VERBOSITY=sqlstate','--dbname=football'],{input:${JSON.stringify(sql)},timeout:22000,maxBuffer:${MAX_BYTES},stdio:['pipe','pipe','pipe']});const v=JSON.parse(out);if(v.readOnly!=='on'||v.productionWrites!==0)throw Error();process.stdout.write(out);}catch(error){const state=pgSqlState(error.stderr);process.stderr.write(state?'V3_HISTORY_REMOTE_SQLSTATE_'+state+'\\n':'V3_HISTORY_REMOTE_FAILED\\n');process.exitCode=1;}`;
 const startedAt=new Date().toISOString();let raw;
 try{raw=execute('ssh',[...buildPinnedSshBaseOptions({keyPath:env.RELEASE_DEPLOY_KEY,pin}),'-p','22',user+'@'+host,'sudo -n env -i PATH=/usr/bin:/bin /opt/node-v22.22.1/bin/node -'],{input:remote,timeout:45000,maxBuffer:MAX_BYTES,windowsHide:true,stdio:['pipe','pipe','pipe']});}catch(error){const state=remoteSqlState(error.stderr);throw Error(state?'V3_HISTORY_REMOTE_SQLSTATE_'+state:'V3_HISTORY_PINNED_READ_FAILED');}
 const finishedAt=new Date().toISOString();check(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=MAX_BYTES,'RESPONSE_BOUND');
 let parsed;try{parsed=JSON.parse(raw);}catch{throw Error('V3_HISTORY_RESPONSE_JSON');}
 const value=validate(parsed,targets),transport={hostKeyPinVerified:true,hostKeyFingerprint:pin.fingerprint,startedAt,finishedAt,
  remoteResponseSha256:sha(raw),remoteResponseFile:path.basename(rawPath),bytes:raw.length};
 Object.assign(transport,validateTransport(transport,value.observedAt));
 check(clock(value.observedAt)>=clock(online.observedAt),'HISTORY_BEFORE_TARGET_READ');
 check(sha(fs.readFileSync(inputPath))===sha(bytes)&&sha(fs.readFileSync(path.join(path.dirname(inputPath),companion)))===sha(rawInput),'INPUT_CHANGED');
 const body={...value,targets,transport,targetReadSha256:sha(bytes),targetReadRemoteSha256:online.transport.remoteResponseSha256,
  formalEligible:false,sourceAdmission:'stored-reference-only; PG presence does not authenticate provider data'};
 try{fs.writeFileSync(rawPath,raw,{flag:'wx',mode:0o600});fs.writeFileSync(destination,JSON.stringify({...body,contentHash:stableHash(body)},null,2)+'\n',{flag:'wx',mode:0o600});}catch{throw Error('V3_HISTORY_OUTPUT_COMMIT_FAILED');}
 return {output:destination,observedAt:value.observedAt,teams:targets.length,rows:value.rows.length,
  ...ledgerSummary(value),productionWrites:0};
}
if(require.main===module){try{const args=process.argv.slice(2),values={};check(args.length===4,'ARGS');for(let i=0;i<args.length;i+=2){check(['--input','--output'].includes(args[i])&&!values[args[i]]&&args[i+1]&&!args[i+1].startsWith('--'),'ARGS');values[args[i]]=args[i+1];}check(values['--input']&&values['--output'],'ARGS');console.log(JSON.stringify(readHistory({input:values['--input'],output:values['--output']})));}catch(e){console.error(/^V3_HISTORY_[A-Z0-9_]+$/.test(e.message)?e.message:'V3_HISTORY_FAILED');process.exitCode=1;}}
module.exports={VERSION,MAX_BYTES,PER_TEAM,MAX_TEAMS,LOOKBACK_DAYS,targetsFor,query,validate,validLedgerResultForRow,ledgerSummary,pgSqlState,remoteSqlState,readHistory};
