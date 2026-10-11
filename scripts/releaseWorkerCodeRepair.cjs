'use strict';
// A signed, incident-bound preparation route. It never changes worker health,
// starts a worker, writes data, or grants the actual cutover lease.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { evaluateWorkerPreflight, collectWorkerPreflight, buildReadOnlyWorkerProbe } = require('./releaseWorkerPreflight.cjs');
const AUTH_ENTRY = 'deploy/light-server/worker-code-repair-authorization.json';
const TARGETS = ['server/publicReferenceArchive.cjs', 'src/services/publicReferenceEvidence.cjs'];
const DATA_FILES = ['server/postgresStore.cjs', 'server/storageMode.cjs',
  'deploy/light-server/candidate-revision-transition.json', 'deploy/light-server/native-release-policy.json',
  'deploy/light-server/recommendation-schema-bridge.cjs'];

function validateWorkerCodeRepairAuthorization(auth, now) {
  const assert = require('node:assert/strict');
  const sha = value => assert.match(value || '', /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(auth).sort(), ['version','reason','createdAt','expiresAt','baseRuntimeSha256','files','dataContract'].sort());
  assert.equal(auth.version, 'worker-code-repair-v1');
  assert.equal(auth.reason, 'reference-array-string-limit');
  sha(auth.baseRuntimeSha256);
  const start = Date.parse(auth.createdAt), end = Date.parse(auth.expiresAt);
  assert(Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end)
    && start <= now + 5000 && now < end && end > start && end - start <= 2 * 3600000, 'repair authorization clock');
  assert.deepEqual(auth.files.map(row => row.path), TARGETS);
  for (const row of auth.files) {
    assert.deepEqual(Object.keys(row).sort(), ['afterSha256','beforeSha256','path']);
    sha(row.beforeSha256); sha(row.afterSha256); assert.notEqual(row.beforeSha256, row.afterSha256);
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
    assert.equal(cycle?.error, 'node scripts/syncData.cjs exited with 1');
    assert(Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= now
      && now - end <= 3600000 && start >= Date.parse(worker.serviceAfter.ExecMainStartTimestamp), 'failed cycle clock');
    assert.equal(observed.runtimeSha256, auth.baseRuntimeSha256);
    assert.equal(observed.completeSha256, auth.baseRuntimeSha256);
    assert.equal(observed.recoveryPending, false);
    assert.deepEqual(observed.files, auth.files.map(row => ({path:row.path,sha256:row.beforeSha256})));
    assert.deepEqual(observed.dataContract, auth.dataContract);
    const migrations = auth.dataContract.filter(row => row.path.startsWith('server/postgres/migrations/')).map(row => row.path.split('/').at(-1));
    assert.deepEqual(observed.migrationNames, migrations);
    assert(Array.isArray(observed.journal) && observed.journal.length > 0 && observed.journal.length <= 4);
    assert(observed.journal.some(row => row.unit === 'football-sync-worker.service'
      && /^[1-9][0-9]*$/.test(row.pid || '') && row.message === 'Invalid string length'
      && row.timestampMs >= start && row.timestampMs <= end), 'exact failure absent from current failed-cycle journal');
    result.ok = true; result.repairPreparationAllowed = true;
  } catch { result.blockers.push('worker-code-repair-binding-rejected'); }
  return result;
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
  const migrationNames = fs.readdirSync(root+'/server/postgres/migrations').sort();
  const cycle = worker.status.lastCycle;
  const lines = cp.execFileSync('/usr/bin/journalctl', ['--unit=football-sync-worker.service',
    '--since='+cycle.startedAt, '--until='+cycle.finishedAt, '--grep=^Invalid string length$',
    '--lines=4','--output=json','--no-pager'], {encoding:'utf8',timeout:8000,maxBuffer:128*1024});
  const journal = lines.trim() ? lines.trim().split('\n').map(line => {
    const row=JSON.parse(line); return {unit:row._SYSTEMD_UNIT,pid:row._PID,message:row.MESSAGE,
      timestampMs:Number(row.__REALTIME_TIMESTAMP)/1000};
  }) : [];
  assert.deepEqual(identity(), before, 'runtime identity changed during incident read');
  const afterWorker=collectWorkerPreflight();
  assert.deepEqual(afterWorker.serviceBefore,worker.serviceAfter,'worker changed during incident read');
  assert.deepEqual(afterWorker.serviceAfter,worker.serviceAfter,'worker changed during incident read');
  assert.equal(afterWorker.processMatches,true);
  assert.deepEqual(afterWorker.status.lastCycle,worker.status.lastCycle,'failed cycle changed during incident read');
  return {...before,files,dataContract,migrationNames,journal};
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
  return "'use strict';\nconst TARGETS="+JSON.stringify(TARGETS)+",DATA_FILES="+JSON.stringify(DATA_FILES)+";\n"
    + [evaluateWorkerPreflight,collectWorkerPreflight,validateWorkerCodeRepairAuthorization,evaluateWorkerCodeRepair,collectWorkerCodeRepair].map(fn=>fn.toString()).join('\n')
    + '\ntry {const auth='+JSON.stringify(auth)+';const worker=collectWorkerPreflight();const base=evaluateWorkerPreflight(worker);'
    + 'const report=base.ok?base:evaluateWorkerCodeRepair(auth,worker,collectWorkerCodeRepair(auth,worker));console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}'
    + "catch {console.log(JSON.stringify({version:'worker-code-repair-preparation-v1',ok:false,workerHealthy:false,repairPreparationAllowed:false,blockers:['worker-code-repair-probe-unavailable'],readyToCutover:false,productionWrites:0}));process.exitCode=1;}";
}

module.exports={AUTH_ENTRY,TARGETS,DATA_FILES,validateWorkerCodeRepairAuthorization,evaluateWorkerCodeRepair,collectWorkerCodeRepair,candidateAuthorization,buildWorkerCodeRepairProbe};
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
