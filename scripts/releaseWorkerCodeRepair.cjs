'use strict';
// A signed, incident-bound preparation route. It never changes worker health,
// starts a worker, writes data, or grants the actual cutover lease.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { evaluateWorkerPreflight, collectWorkerPreflight, buildReadOnlyWorkerProbe } = require('./releaseWorkerPreflight.cjs');
const AUTH_ENTRY = 'deploy/light-server/worker-code-repair-authorization.json';
const TARGETS = ['server/publicReferenceArchive.cjs', 'src/services/publicReferenceEvidence.cjs'];
const PAIR_TARGETS = ['scripts/postgresRuntimeReadSession.cjs', 'scripts/postgresModelInput.cjs',
  'server/dataGenerationBundle.cjs', 'server/publicationResolverWorker.cjs', 'server/index.cjs', ...TARGETS];
const WRITER_TARGETS = ['scripts/runSyncWorker.cjs', 'scripts/postgresProjectionSync.cjs',
  'scripts/releaseWorkerCodeRepair.cjs', 'scripts/nativeCodeReleaseDataPlane.cjs',
  'scripts/frontendRuntimeBoundary.cjs'];
const SNAPSHOT_TARGETS = [...WRITER_TARGETS];
// The producer repair must not change the projection's canonical-rebase guard.
const RESULT_IDENTITY_TARGETS = ['scripts/syncData.cjs', 'scripts/releaseWorkerCodeRepair.cjs',
  'scripts/nativeCodeReleaseDataPlane.cjs', 'scripts/postgresProjectionSync.cjs'];
const DATA_FILES = ['server/postgresStore.cjs', 'server/storageMode.cjs',
  'deploy/light-server/candidate-revision-transition.json', 'deploy/light-server/native-release-policy.json',
  'deploy/light-server/recommendation-schema-bridge.cjs'];

function validateRepairPublication(value, allowAligned = false) {
  const assert = require('node:assert/strict');
  assert.deepEqual(Object.keys(value).sort(), ['committed','databaseOid','rawCurrent','rawPrevious']);
  assert.match(value.databaseOid || '', /^[1-9][0-9]*$/);
  const keys = ['mode','generationId','manifestHash','sourceCycleId','committedAt'];
  for (const name of ['committed','rawCurrent','rawPrevious']) {
    const row=value[name]; assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
    assert.equal(row.mode,'active-generation'); assert.match(row.manifestHash||'',/^[a-f0-9]{64}$/);
    assert.equal(row.generationId,'g-'+row.manifestHash);
    assert.equal(typeof row.sourceCycleId,'string'); assert(row.sourceCycleId.length>0&&row.sourceCycleId.length<=256);
    assert(Number.isFinite(Date.parse(row.committedAt)) && new Date(row.committedAt).toISOString()===row.committedAt);
  }
  assert.notEqual(value.rawCurrent.generationId,value.rawPrevious.generationId);
  const aligned = [value.rawCurrent,value.rawPrevious].find(r=>r.generationId===value.committed.generationId);
  assert(Date.parse(value.rawPrevious.committedAt)<Date.parse(value.rawCurrent.committedAt));
  if(allowAligned && aligned) assert.deepEqual(value.committed,aligned);
  else {
    assert.notEqual(value.committed.generationId,value.rawCurrent.generationId);
    assert.notEqual(value.committed.generationId,value.rawPrevious.generationId);
    assert(Date.parse(value.committed.committedAt)<Date.parse(value.rawPrevious.committedAt));
  }
  return value;
}
function validateWorkerCodeRepairAuthorization(auth, now) {
  const assert = require('node:assert/strict');
  const sha = value => assert.match(value || '', /^[a-f0-9]{64}$/);
  const writer = auth.version === 'worker-code-repair-v3';
  const snapshot = auth.version === 'worker-code-repair-v4';
  const freshCapture = auth.version === 'worker-code-repair-v6';
  const resultIdentity = auth.version === 'worker-code-repair-v5' || freshCapture;
  const pair = auth.version === 'worker-code-repair-v2' || writer || snapshot || resultIdentity;
  assert.deepEqual(Object.keys(auth).sort(), ['version','reason','createdAt','expiresAt','baseRuntimeSha256','files','dataContract',...(pair?['publication']:[]),...(resultIdentity?['incident']:[]),...(freshCapture?['bindingPolicy']:[])].sort());
  assert.equal(auth.version, freshCapture ? 'worker-code-repair-v6' : resultIdentity ? 'worker-code-repair-v5' : snapshot ? 'worker-code-repair-v4' : writer ? 'worker-code-repair-v3' : pair ? 'worker-code-repair-v2' : 'worker-code-repair-v1');
  if(freshCapture) assert.equal(auth.bindingPolicy,'fresh-raw-and-repeated-exact-failure-before-lease-v1');
  assert.equal(auth.reason, resultIdentity ? 'official-result-canonical-identity-regression' : snapshot ? 'model-artifact-generation-snapshot-race' : writer ? 'postgres-source-file-assembly-timeout' : pair ? 'postgres-committed-generation-pairing' : 'reference-array-string-limit');
  if(pair) validateRepairPublication(auth.publication,snapshot || writer || resultIdentity);
  if(resultIdentity) validateResultIdentityIncident(auth.incident);
  sha(auth.baseRuntimeSha256);
  const start = Date.parse(auth.createdAt), end = Date.parse(auth.expiresAt);
  assert(Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end)
    && start <= now + 5000 && now < end && end > start && end - start <= 2 * 3600000, 'repair authorization clock');
  assert.deepEqual(auth.files.map(row => row.path), resultIdentity ? RESULT_IDENTITY_TARGETS : snapshot ? SNAPSHOT_TARGETS : writer ? WRITER_TARGETS : pair ? PAIR_TARGETS : TARGETS);
  for (const row of auth.files) {
    assert.deepEqual(Object.keys(row).sort(), ['afterSha256','beforeSha256','path']);
    sha(row.beforeSha256); sha(row.afterSha256);
    if(resultIdentity && row.path === 'scripts/postgresProjectionSync.cjs') assert.equal(row.beforeSha256,row.afterSha256);
    else assert.notEqual(row.beforeSha256, row.afterSha256);
  }
  assert(Array.isArray(auth.dataContract) && auth.dataContract.length > DATA_FILES.length && auth.dataContract.length <= 256);
  let prior = '';
  for (const row of auth.dataContract) {
    assert.deepEqual(Object.keys(row).sort(), ['path','sha256']); sha(row.sha256);
    assert(row.path > prior && (DATA_FILES.includes(row.path) || /^server\/postgres\/migrations\/\d+_[a-z0-9_-]+\.sql$/.test(row.path)));
    prior = row.path;
  }
  for (const name of DATA_FILES) assert(auth.dataContract.some(row => row.path === name));
  return auth;
}

function validateResultIdentityIncident(incident) {
  const assert=require('node:assert/strict'), crypto=require('node:crypto');
  const {Buffer}=require('node:buffer');
  assert.deepEqual(Object.keys(incident).sort(),['cycleFinishedAt','cycleStartedAt','failure','journalMessageSha256','journalPid','journalTimestampUs','workerMainPid','workerStartedAt']);
  for(const key of ['workerMainPid','journalPid'])assert.match(incident[key]||'',/^[1-9][0-9]*$/);
  assert.notEqual(incident.workerMainPid,incident.journalPid);
  for(const key of ['workerStartedAt','cycleStartedAt','cycleFinishedAt'])assert.equal(new Date(incident[key]).toISOString(),incident[key]);
  assert(Date.parse(incident.workerStartedAt)<=Date.parse(incident.cycleStartedAt));
  assert(Date.parse(incident.cycleStartedAt)<=Date.parse(incident.cycleFinishedAt));
  assert.match(incident.journalTimestampUs||'',/^[1-9][0-9]{15}$/);
  const timestamp=Number(incident.journalTimestampUs)/1000;
  assert(timestamp>=Date.parse(incident.cycleStartedAt)&&timestamp<=Date.parse(incident.cycleFinishedAt));
  const failure=incident.failure;
  assert.deepEqual(Object.keys(failure),['ok','code','error','reviewId','existingMatchId','incomingMatchId','existingObservationId','incomingObservationId','existingIdentity','incomingIdentity']);
  assert.equal(failure.ok,false);assert.equal(failure.code,'POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE');
  assert.equal(failure.error,'Existing stable review id is not a safe result-only canonical rebase');
  assert.match(failure.reviewId||'',/^review:[a-f0-9]{64}$/);
  for(const key of ['existingObservationId','incomingObservationId'])assert.match(failure[key]||'',/^result:[a-f0-9]{64}$/);
  assert.notEqual(failure.existingObservationId,failure.incomingObservationId);
  const identity=failure.existingIdentity;
  assert.deepEqual(Object.keys(identity),['sourceMatchId','eventVersion','resultIdentity','observedAt','settledAt']);
  assert.match(identity.sourceMatchId||'',/^[1-9][0-9]{0,15}$/);
  assert.equal(failure.existingMatchId,'sporttery_'+identity.sourceMatchId);
  assert.equal(failure.incomingMatchId,'fivehundred_'+identity.sourceMatchId);
  assert.match(identity.resultIdentity||'',/^\d{1,2}:\d{1,2}\|sporttery:official-api$/);
  for(const key of ['eventVersion','observedAt','settledAt'])assert.equal(new Date(identity[key]).toISOString(),identity[key]);
  assert(Date.parse(identity.eventVersion)<=Date.parse(identity.observedAt));
  assert.equal(identity.observedAt,identity.settledAt);
  assert(Date.parse(identity.settledAt)<=timestamp);
  assert.deepEqual(failure.incomingIdentity,identity);
  const message=JSON.stringify(failure,null,2);
  assert.equal(message.split('\n').length,24);assert(Buffer.byteLength(message)<=4096);
  assert.equal(incident.journalMessageSha256,crypto.createHash('sha256').update(message).digest('hex'));
  return incident;
}

function assertResultIdentityJournal(incident,journal) {
  const assert=require('node:assert/strict');
  const {Buffer}=require('node:buffer');
  assert(Array.isArray(journal)&&journal.length===24);
  for(const row of journal) {
    assert.equal(row.unit,'football-sync-worker.service');assert.equal(row.pid,incident.journalPid);
    assert.equal(row.timestampUs,incident.journalTimestampUs);
    assert.equal(row.timestampMs,Number(incident.journalTimestampUs)/1000);
    assert.equal(typeof row.message,'string');assert(Buffer.byteLength(row.message)<=1024);
  }
  // Exact pretty-printed bytes reject missing/duplicated fields and spliced
  // records even when JSON.parse alone would accept the last duplicate key.
  assert.equal(journal.map(row=>row.message).join('\n'),JSON.stringify(incident.failure,null,2));
}

// v6 authorizes only another occurrence of the complete signed failure on the
// same worker incarnation. The actual child PID and microsecond clock must be
// obtained from journal records belonging to the latest completed failed cycle.
function repeatedResultIdentityIncident(signed,worker,journal) {
  const assert=require('node:assert/strict');
  validateResultIdentityIncident(signed);
  const cycle=worker.status.lastCycle;
  assert.equal(worker.serviceAfter.MainPID,signed.workerMainPid);
  assert.equal(new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),signed.workerStartedAt);
  assert(Array.isArray(journal)&&journal.length===24);
  const actual={...signed,cycleStartedAt:cycle.startedAt,cycleFinishedAt:cycle.finishedAt,
    journalPid:journal[0].pid,journalTimestampUs:journal[0].timestampUs};
  validateResultIdentityIncident(actual);assertResultIdentityJournal(actual,journal);
  if(cycle.startedAt===signed.cycleStartedAt && cycle.finishedAt===signed.cycleFinishedAt) {
    assert.equal(actual.journalPid,signed.journalPid);assert.equal(actual.journalTimestampUs,signed.journalTimestampUs);
  } else {
    assert(Date.parse(cycle.startedAt)>=Date.parse(signed.cycleFinishedAt),'repeated incident cycle overlaps signed cycle');
    assert(Date.parse(cycle.finishedAt)>Date.parse(signed.cycleFinishedAt),'repeated incident cycle regressed');
    assert(BigInt(actual.journalTimestampUs)>BigInt(signed.journalTimestampUs),'repeated incident journal regressed');
  }
  return actual;
}

function evaluateWorkerCodeRepair(auth, worker, observed) {
  const assert = require('node:assert/strict');
  const report = evaluateWorkerPreflight(worker);
  // A healthy worker follows the original route; the incident authorization
  // cannot hide an unrelated process/clock/status failure.
  const result = { version:'worker-code-repair-preparation-v1', checkedAt:worker.checkedAt,
    workerHealthy:report.ok, workerReport:report, ok:false, repairPreparationAllowed:false,
    readyToCutover:false, productionWrites:0, blockers:[],
    scope:'preparation only; worker failure retained; signed code-only classification, root lock, PG/catalog, capacity, source, cutover lease and final acceptance remain required' };
  try {
    const now = Date.parse(worker.checkedAt);
    validateWorkerCodeRepairAuthorization(auth, now);
    assert.equal(report.blockers.length, 1);
    assert(['worker-latest-official-cycle-failed','worker-official-recovery-unproven'].includes(report.blockers[0]));
    assert(report.statusAgeSeconds <= 600, 'worker observation stale');
    const cycle = worker.status.lastCycle;
    const start = Date.parse(cycle?.startedAt), end = Date.parse(cycle?.finishedAt);
    assert.equal(cycle?.ok, false); assert.equal(cycle?.phase, 'official-result-failed');
    assert.equal(cycle?.errorCode, 'SYNC_WORKER_COMMAND_FAILED');
    const writer = auth.version === 'worker-code-repair-v3';
    const snapshot = auth.version === 'worker-code-repair-v4';
    const freshCapture = auth.version === 'worker-code-repair-v6';
    const resultIdentity = auth.version === 'worker-code-repair-v5' || freshCapture;
    assert.equal(cycle?.error, snapshot ? 'npm run datastore:generation exited with 1' : writer || resultIdentity ? 'npm run postgres:sync exited with 1' : 'node scripts/syncData.cjs exited with 1');
    assert(Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= now
      && now - end <= 3600000 && start >= Date.parse(worker.serviceAfter.ExecMainStartTimestamp), 'failed cycle clock');
    assert.equal(observed.runtimeSha256, auth.baseRuntimeSha256);
    assert.equal(observed.completeSha256, auth.baseRuntimeSha256);
    assert.equal(observed.recoveryPending, false);
    assert.deepEqual(observed.files, auth.files.map(row => ({path:row.path,sha256:row.beforeSha256})));
    assert.deepEqual(observed.dataContract, auth.dataContract);
    const migrations = auth.dataContract.filter(row => row.path.startsWith('server/postgres/migrations/')).map(row => row.path.split('/').at(-1));
    assert.deepEqual(observed.migrationNames, migrations);
    if(['worker-code-repair-v2','worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5'].includes(auth.version)) assert.deepEqual(observed.publication,auth.publication);
    if(freshCapture) {
      validateRepairPublication(observed.publication,true);
      assert.equal(observed.publication.databaseOid,auth.publication.databaseOid);
      assert.deepEqual(observed.publication.committed,auth.publication.committed,'signed PostgreSQL commit changed');
      // Only natural forward movement may be freshly captured. A rollback of
      // either pointer does not qualify as this signed preparation scope.
      for(const name of ['rawCurrent','rawPrevious']) {
        const before=auth.publication[name],after=observed.publication[name];
        assert(Date.parse(after.committedAt)>=Date.parse(before.committedAt),'raw publication clock regressed');
        if(after.committedAt===before.committedAt) assert.deepEqual(after,before);
      }
      repeatedResultIdentityIncident(auth.incident,worker,observed.journal);
    } else if(resultIdentity) {
      const incident=auth.incident;
      assert.equal(worker.serviceAfter.MainPID,incident.workerMainPid);
      assert.equal(new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),incident.workerStartedAt);
      assert.equal(cycle.startedAt,incident.cycleStartedAt);assert.equal(cycle.finishedAt,incident.cycleFinishedAt);
      assertResultIdentityJournal(incident,observed.journal);
    } else {
      assert(Array.isArray(observed.journal) && observed.journal.length > 0 && observed.journal.length <= 4);
      assert(observed.journal.some(row => row.unit === 'football-sync-worker.service'
      && /^[1-9][0-9]*$/.test(row.pid || '') && row.message === (snapshot ? '  "error": "source file size changed before staging: model-evaluation.json",' : writer ? '  "error": "Query read timeout",' : auth.version==='worker-code-repair-v2'
        ? 'SQLite publication identity matches neither the serving generation nor its immutable previous generation' : 'Invalid string length')
        && row.timestampMs >= start && row.timestampMs <= end), 'exact failure absent from current failed-cycle journal');
    }
    result.ok = true; result.repairPreparationAllowed = true;
  } catch { result.blockers.push('worker-code-repair-binding-rejected'); }
  return result;
}

function selectWorkerCodeRepairPreparation(auth, worker, readIncident) {
  const base = evaluateWorkerPreflight(worker);
  // Once a genuine publication has recovered, use the unchanged ordinary
  // affinity route. An inactive incident must not pin its earlier PG batch.
  if (base.ok) return { useRepair: false, report: base };
  if (typeof readIncident !== 'function') throw new Error('incident observation reader required');
  const report = evaluateWorkerCodeRepair(auth, worker, readIncident(auth, worker));
  return { useRepair: report.ok && report.repairPreparationAllowed === true, report };
}

function collectWorkerCodeRepair(auth, worker) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const assert = require('node:assert/strict'), cp = require('node:child_process');
  const root = '/opt/football-predict';
  assert.equal(fs.realpathSync(root), root);
  const plain = (relative, limit = 4 * 1024 * 1024) => {
    const file = path.join(root, relative);
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const st = fs.lstatSync(dir); assert(st.isDirectory() && !st.isSymbolicLink());
      if (dir === root) break; assert(dir !== path.dirname(dir));
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd); assert(before.isFile() && before.nlink === 1 && before.size <= limit);
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
      assert(before.ino === after.ino && before.size === bytes.length && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
      return bytes;
    } finally { fs.closeSync(fd); }
  };
  const present = file => {try {fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const identity = () => ({runtimeSha256:plain('.release-bundle-sha256',128).toString().trim(),
    completeSha256:plain('.release-live-complete',128).toString().trim(),
    recoveryPending:present('/var/lib/football-release/recovery/current')
      || present('/var/lib/football-release/reference-repairs/current')});
  const before = identity(), hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const files = auth.files.map(row => ({path:row.path,sha256:hash(plain(row.path))}));
  const dataContract = auth.dataContract.map(row => ({path:row.path,sha256:hash(plain(row.path).toString('utf8').replace(/\r\n/g,'\n'))}));
  // Native runs this reader in a VM realm. Copy the host fs array into the
  // reader's realm before the exact array comparison; names still must match.
  const migrationNames = Array.from(fs.readdirSync(root+'/server/postgres/migrations')).sort();
  const cycle = worker.status.lastCycle;
  const freshCapture=auth.version==='worker-code-repair-v6';
  const resultIdentity=auth.version==='worker-code-repair-v5'||freshCapture;
  const message = auth.version==='worker-code-repair-v4' ? '  "error": "source file size changed before staging: model-evaluation.json",' : auth.version==='worker-code-repair-v3' ? '  "error": "Query read timeout",' : auth.version==='worker-code-repair-v2'
    ? 'SQLite publication identity matches neither the serving generation nor its immutable previous generation' : 'Invalid string length';
  // Locate, rather than invent, the exact microsecond of a repeated fault.
  // A bounded grep only locates the record; admission still requires all 24
  // original lines without grep, including both complete identity objects.
  let journalTimestampUs=resultIdentity?auth.incident.journalTimestampUs:null;
  let journalPid=resultIdentity?auth.incident.journalPid:null;
  if(freshCapture) {
    const codeLine='  "code": "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE",';
    const located=cp.execFileSync('/usr/bin/journalctl',['--unit=football-sync-worker.service','--since='+cycle.startedAt,
      '--until='+cycle.finishedAt,'--grep=^'+codeLine+'$','--lines=64','--output=json','--no-pager'],
    {encoding:'utf8',timeout:8000,maxBuffer:128*1024});
    const rows=located.trim()?located.trim().split('\n').map(line=>JSON.parse(line)):[];
    assert.equal(rows.length,1,'latest failed cycle must contain one unambiguous result identity incident');
    const row=rows[0];assert.equal(row._SYSTEMD_UNIT,'football-sync-worker.service');assert.equal(row.MESSAGE,codeLine);
    assert.match(row._PID||'',/^[1-9][0-9]*$/);assert.match(row.__REALTIME_TIMESTAMP||'',/^[1-9][0-9]{15}$/);
    const time=Number(row.__REALTIME_TIMESTAMP)/1000;
    assert(time>=Date.parse(cycle.startedAt)&&time<=Date.parse(cycle.finishedAt),'located journal outside failed cycle');
    journalTimestampUs=row.__REALTIME_TIMESTAMP;journalPid=row._PID;
  }
  const journalSecond=resultIdentity?Math.floor(Number(journalTimestampUs)/1000000):null;
  const journalArgs=resultIdentity
    ? ['--unit=football-sync-worker.service','--since=@'+journalSecond,'--until=@'+(journalSecond+1),'--lines=64','--output=json','--no-pager']
    : ['--unit=football-sync-worker.service','--since='+cycle.startedAt, '--until='+cycle.finishedAt, '--grep=^'+message+'$','--lines=4','--output=json','--no-pager'];
  const lines = cp.execFileSync('/usr/bin/journalctl', journalArgs, {encoding:'utf8',timeout:8000,maxBuffer:128*1024});
  let journal = lines.trim() ? lines.trim().split('\n').map(line => {
    const row=JSON.parse(line); return {unit:row._SYSTEMD_UNIT,pid:row._PID,message:row.MESSAGE,
      timestampMs:Number(row.__REALTIME_TIMESTAMP)/1000,...(resultIdentity?{timestampUs:row.__REALTIME_TIMESTAMP}:{})};
  }) : [];
  if(resultIdentity) {
    assert(journal.length<64,'incident journal window truncated');
    journal=journal.filter(row=>row.timestampUs===journalTimestampUs);
    assert.equal(journal[0]?.pid,journalPid);
    if(freshCapture) repeatedResultIdentityIncident(auth.incident,worker,journal);
    else assertResultIdentityJournal(auth.incident,journal);
  }
  let publication;
  if(['worker-code-repair-v2','worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5','worker-code-repair-v6'].includes(auth.version)) {
    const keys=['data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at'];
    const sql="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'readOnly',current_setting('transaction_read_only'),'meta',(SELECT json_object_agg(key,value) FROM football.projection_meta WHERE key IN ('data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at'))); ROLLBACK;";
    const output=cp.execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-qAt','-v','ON_ERROR_STOP=1','-d','football','-c',sql],
      {encoding:'utf8',timeout:10000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',PGHOST:'/var/run/postgresql',PGUSER:'postgres',PGCONNECT_TIMEOUT:'5'}});
    const pg=JSON.parse(output.trim()); assert.equal(pg.readOnly,'on');
    const committed=Object.fromEntries(['mode','generationId','manifestHash','sourceCycleId','committedAt'].map((k,i)=>[k,pg.meta[keys[i]]]));
    const pointer=name=>{const file='/var/lib/football-predict/data-generations/'+name+'.json';
      assert.equal(fs.realpathSync(path.dirname(file)),path.dirname(file));const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {const s=fs.fstatSync(fd);assert(s.isFile()&&s.nlink===1&&s.size<8192);const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);assert(s.ino===after.ino&&s.size===bytes.length&&s.mtimeMs===after.mtimeMs);const row=JSON.parse(bytes);assert.equal(row.schemaVersion,1);return {mode:'active-generation',...Object.fromEntries(['generationId','manifestHash','sourceCycleId','committedAt'].map(k=>[k,row[k]]))};}finally{fs.closeSync(fd);}};
    publication=validateRepairPublication({databaseOid:pg.databaseOid,committed,rawCurrent:pointer('current'),rawPrevious:pointer('previous')},['worker-code-repair-v3','worker-code-repair-v4','worker-code-repair-v5','worker-code-repair-v6'].includes(auth.version));
  }
  assert.deepEqual(identity(), before, 'runtime identity changed during incident read');
  const afterWorker=collectWorkerPreflight();
  assert.deepEqual(afterWorker.serviceBefore,worker.serviceAfter,'worker changed during incident read');
  assert.deepEqual(afterWorker.serviceAfter,worker.serviceAfter,'worker changed during incident read');
  assert.equal(afterWorker.processMatches,true);
  assert.deepEqual(afterWorker.status.lastCycle,worker.status.lastCycle,'failed cycle changed during incident read');
  return {...before,files,dataContract,migrationNames,journal,...(publication?{publication}:{})};
}

function candidateAuthorization(root, auth) {
  validateWorkerCodeRepairAuthorization(auth, Date.now());
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  for (const row of auth.files) {
    if (sha(fs.readFileSync(path.join(root,row.path))) !== row.afterSha256) throw Error('candidate repair file differs');
  }
  const contract = require('./releaseDataPlanePolicy.cjs').capture(root);
  if (JSON.stringify(contract.entries) !== JSON.stringify(auth.dataContract)) throw Error('repair candidate changes data contract');
  return auth;
}

function buildWorkerCodeRepairProbe(auth) {
  validateWorkerCodeRepairAuthorization(auth, Date.now());
  return "'use strict';\nconst TARGETS="+JSON.stringify(TARGETS)+",PAIR_TARGETS="+JSON.stringify(PAIR_TARGETS)+",WRITER_TARGETS="+JSON.stringify(WRITER_TARGETS)+",SNAPSHOT_TARGETS="+JSON.stringify(SNAPSHOT_TARGETS)+",RESULT_IDENTITY_TARGETS="+JSON.stringify(RESULT_IDENTITY_TARGETS)+",DATA_FILES="+JSON.stringify(DATA_FILES)+";\n"
    + [evaluateWorkerPreflight,collectWorkerPreflight,validateRepairPublication,validateResultIdentityIncident,assertResultIdentityJournal,repeatedResultIdentityIncident,validateWorkerCodeRepairAuthorization,evaluateWorkerCodeRepair,collectWorkerCodeRepair,selectWorkerCodeRepairPreparation].map(fn=>fn.toString()).join('\n')
    + '\ntry {const auth='+JSON.stringify(auth)+';const worker=collectWorkerPreflight();'
    + 'const {report}=selectWorkerCodeRepairPreparation(auth,worker,collectWorkerCodeRepair);console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}'
    + "catch {console.log(JSON.stringify({version:'worker-code-repair-preparation-v1',ok:false,workerHealthy:false,repairPreparationAllowed:false,blockers:['worker-code-repair-probe-unavailable'],readyToCutover:false,productionWrites:0}));process.exitCode=1;}";
}

module.exports={AUTH_ENTRY,TARGETS,PAIR_TARGETS,WRITER_TARGETS,SNAPSHOT_TARGETS,RESULT_IDENTITY_TARGETS,DATA_FILES,validateRepairPublication,validateResultIdentityIncident,assertResultIdentityJournal,repeatedResultIdentityIncident,validateWorkerCodeRepairAuthorization,evaluateWorkerCodeRepair,selectWorkerCodeRepairPreparation,collectWorkerCodeRepair,candidateAuthorization,buildWorkerCodeRepairProbe};
if(require.main===module) {
  try {
    if(process.argv.length!==3)throw Error('exact signed source root required');
    const root=path.resolve(process.argv[2]), file=path.join(root,AUTH_ENTRY);
    let source=buildReadOnlyWorkerProbe();
    if(fs.existsSync(file)) {
      const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>16384)throw Error('repair authorization unsafe');
      source=buildWorkerCodeRepairProbe(candidateAuthorization(root,JSON.parse(fs.readFileSync(file))));
    }
    new (require('node:vm').Script)(source).runInNewContext({require,process,console,Date});
  } catch {console.log(JSON.stringify({ok:false,repairPreparationAllowed:false,readyToCutover:false,productionWrites:0,blockers:['worker-code-repair-entry-rejected']}));process.exitCode=1;}
}
