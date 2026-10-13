'use strict';
// Engineering acceptance and a later natural data cycle are separate facts.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const APP = '/opt/football-predict';
function assertSamePublication(seed, current) {
  for (const field of ['generationId', 'manifestHash', 'sourceCycleId', 'committedAt']) {
    assert.equal(typeof seed?.[field], 'string'); assert(seed[field].length > 0);
    assert.equal(current?.[field], seed[field], 'code publication moved after candidate seed: ' + field);
  }
}
function read(file, max = 2 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= max);
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(bytes.length, before.size);
  return JSON.parse(bytes);
}
function assess(receipt, status, sha, now = Date.now()) {
  assert.match(sha, /^[a-f0-9]{64}$/); assert.equal(receipt.version, 'code-release-acceptance-v1');
  assert.equal(receipt.bundleSha256, sha); assert.equal(receipt.engineeringAccepted, true);
  assert.equal(receipt.businessAccepted, false); assert.equal(receipt.dataPlane, 'code-only');
  assert.equal(receipt.databaseCopies, 0); assert.equal(receipt.parameterPromotion, false);
  const start = Date.parse(receipt.workerStartedAt), accepted = Date.parse(receipt.acceptedAt);
  assert(Number.isFinite(start) && Number.isFinite(accepted) && start <= accepted && accepted <= now + 5000);
  const worker = require('./runSyncWorker.cjs');
  const official = worker.officialPublishEvidenceAfter(status, receipt.workerStartedAt);
  const complete = worker.readinessIdleEvidenceAfter(status, receipt.workerStartedAt);
  const clockValid = value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= start && Date.parse(value) <= now;
  const cycle = [status?.lastCycle, status?.lastCompleteCycle].find(row => row
    && row.startedAt === complete.startedAt && row.finishedAt === complete.finishedAt);
  const freshClocks = clockValid(complete.startedAt) && clockValid(complete.finishedAt)
    && clockValid(complete.officialPublishedAt) && clockValid(cycle?.officialPhase?.startedAt)
    && Date.parse(cycle?.officialPhase?.startedAt) <= Date.parse(complete.officialPublishedAt)
    && Date.parse(status?.checkedAt || status?.at) <= now + 5000;
  return { version: 'code-release-business-observation-v1', bundleSha256: sha,
    observedAt: new Date(now).toISOString(), engineeringAccepted: true,
    naturalCycleAccepted: official.state === 'published' && complete.state === 'idle' && freshClocks,
    official, complete, recommendationAdoptionAccepted: false, productionWrites: 0 };
}
function write(sha, workerStartedAt) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.match(sha, /^[a-f0-9]{64}$/); assert(Number.isFinite(Date.parse(workerStartedAt)));
  const directory = '/var/lib/football-release/native/' + sha;
  const state = read(path.join(directory, 'state.json'));
  assert.equal(state.sha, sha); assert.equal(state.dataPlane, 'code-only');
  assert.equal(state.candidateOid, state.oldDatabaseOid); assert.equal(state.candidateDatabase, 'football');
  const final = read(path.join(directory, 'data-finalized.json'));
  assert.equal(final.ok, true); assert.equal(final.sha, sha);
  assert.equal(fs.readFileSync(APP + '/.release-bundle-sha256', 'utf8').trim(), sha);
  const receipt = { version: 'code-release-acceptance-v1', bundleSha256: sha,
    acceptedAt: new Date().toISOString(), workerStartedAt, dataPlane: 'code-only',
    databaseOid: state.oldDatabaseOid, databaseCopies: 0, engineeringAccepted: true,
    businessAccepted: false, businessState: 'awaiting-natural-cycle', parameterPromotion: false };
  assert(Date.parse(workerStartedAt) <= Date.parse(receipt.acceptedAt));
  const file = APP + '/.release-code-acceptance.json', fd = fs.openSync(file, 'wx', 0o644);
  try { fs.writeFileSync(fd, JSON.stringify(receipt) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return receipt;
}
module.exports = { assess, write, assertSamePublication };
if (require.main === module) {
  try {
    const [action, sha, clock] = process.argv.slice(2);
    if (action === 'write') { assert.equal(process.argv.length, 5); console.log(JSON.stringify(write(sha, clock))); }
    else {
      assert.equal(action, 'observe'); assert.equal(process.argv.length, 4);
      for (const marker of ['.release-bundle-sha256', '.release-live-complete'])
        assert.equal(fs.readFileSync(APP + '/' + marker, 'utf8').trim(), sha);
      console.log(JSON.stringify(assess(read(APP + '/.release-code-acceptance.json'),
        read('/var/lib/football-predict/sync-worker-status.json'), sha)));
    }
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
