'use strict';
// Evidence validation only. This module never grants release preparation,
// writes production data, or changes the worker preflight decision.
const { evaluateWorkerPreflight } = require('./releaseWorkerPreflight.cjs');

const MESSAGE = 'sync-meta.json should stay below 1MB and only expose freshness summaries.';
// The caller must fix root to the installed release path and hold the original
// release read lock. This reader neither locks nor authorizes an operation.
function readStableMeta(root) {
  const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  assert.equal(path.resolve(root), root);
  assert.equal(fs.realpathSync(root), root);
  const directories = [];
  const holdDirectory = directory => {
    const st = fs.lstatSync(directory, { bigint: true });
    assert(st.isDirectory() && !st.isSymbolicLink());
    assert.equal(fs.realpathSync(directory), directory);
    directories.push({ directory, dev: st.dev, ino: st.ino });
  };
  holdDirectory(root);
  for (const component of ['public', 'data']) {
    root = path.join(root, component);
    holdDirectory(root);
  }
  const file = path.join(root, 'sync-meta.json');
  const entry = fs.lstatSync(file, { bigint: true });
  assert(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
      a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
    assert(same(entry, before));
    assert(before.isFile() && before.nlink === 1n && before.size > 1000000n && before.size < 8388608n);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(file, { bigint: true });
    assert(pathAfter.isFile() && !pathAfter.isSymbolicLink());
    assert(same(before, after) && same(before, pathAfter) && BigInt(bytes.length) === before.size);
    for (const original of directories) {
      const current = fs.lstatSync(original.directory, { bigint: true });
      assert(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(fs.realpathSync(original.directory), original.directory);
      assert(current.dev === original.dev && current.ino === original.ino);
    }
    const value = JSON.parse(new (require('node:util').TextDecoder)('utf-8', { fatal: true }).decode(bytes));
    assert(value && typeof value === 'object' && !Array.isArray(value));
    return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), stableIdentity: true };
  } finally { fs.closeSync(fd); }
}
function verifySyncMetaFailure({ worker, journal, meta }) {
  const assert = require('node:assert/strict');
  const MESSAGE = 'sync-meta.json should stay below 1MB and only expose freshness summaries.';
  const report = evaluateWorkerPreflight(worker);
  assert.equal(report.ok, false);
  assert(report.blockers.length > 0 && report.blockers.every(x =>
    ['worker-latest-official-cycle-failed', 'worker-official-recovery-unproven'].includes(x)));
  assert(report.statusAgeSeconds !== null && report.statusAgeSeconds <= 600);
  assert.equal(worker.serviceBefore.ActiveState, 'active');
  assert.equal(worker.serviceAfter.ActiveState, 'active');
  assert.equal(worker.serviceBefore.MainPID, worker.serviceAfter.MainPID);
  assert.equal(worker.serviceBefore.ExecMainStartTimestamp, worker.serviceAfter.ExecMainStartTimestamp);
  assert.equal(worker.processMatches, true);
  const c = worker.status.lastCycle, now = Date.parse(worker.checkedAt);
  const start = Date.parse(c.startedAt), end = Date.parse(c.finishedAt);
  assert.equal(c.ok, false);
  assert.equal(c.phase, 'official-result-failed');
  assert.equal(c.errorCode, 'SYNC_WORKER_COMMAND_FAILED');
  assert.equal(c.error, 'npm run validate:data exited with 1');
  assert(Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(now));
  assert(start >= Date.parse(worker.serviceAfter.ExecMainStartTimestamp) && start <= end && end <= now && now - end <= 3600000);
  assert(Array.isArray(journal) && journal.length === 1);
  const line = journal[0];
  assert.equal(line.unit, 'football-sync-worker.service');
  assert.match(line.pid, /^[1-9][0-9]*$/);
  assert.notEqual(line.pid, worker.serviceAfter.MainPID);
  assert.equal(line.message, MESSAGE);
  assert(Number.isFinite(line.timestampMs) && line.timestampMs >= start && line.timestampMs <= end);
  assert.equal(meta.path, '/opt/football-predict/public/data/sync-meta.json');
  assert(Number.isSafeInteger(meta.bytes) && meta.bytes > 1000000 && meta.bytes < 8 * 1024 * 1024);
  assert.match(meta.sha256, /^[a-f0-9]{64}$/);
  assert.equal(meta.stableIdentity, true);
  return { version: 'sync-meta-incident-evidence-v1', verified: true, workerHealthy: false,
    preparationAllowed: false, readyToCutover: false, productionWrites: 0 };
}

// This describes the original observed incident for a future signed scope.
// It is not itself an authorization and must only be created from a trusted,
// root-locked reader; callers supplying arbitrary objects are not authorities.
function incidentAnchor(observation) {
  const assert = require('node:assert/strict'), crypto = require('node:crypto');
  const MESSAGE = 'sync-meta.json should stay below 1MB and only expose freshness summaries.';
  verifySyncMetaFailure(observation);
  const { worker, journal, meta } = observation, line = journal[0], c = worker.status.lastCycle;
  assert.match(line.timestampUs || '', /^[1-9][0-9]{15}$/);
  assert.equal(line.timestampMs, Number(line.timestampUs) / 1000);
  const workerStartedAt = new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString();
  for (const value of [c.startedAt, c.finishedAt]) assert.equal(new Date(value).toISOString(), value);
  return { version: 'sync-meta-incident-anchor-v1', workerMainPid: worker.serviceAfter.MainPID,
    workerStartedAt, cycleStartedAt: c.startedAt, cycleFinishedAt: c.finishedAt,
    journalPid: line.pid, journalTimestampUs: line.timestampUs,
    journalMessageSha256: crypto.createHash('sha256').update(MESSAGE).digest('hex'),
    metaBytes: meta.bytes, metaSha256: meta.sha256 };
}
function verifyRepeatedIncident(anchor, observation) {
  const assert = require('node:assert/strict');
  const actual = incidentAnchor(observation);
  assert.deepEqual(Object.keys(anchor).sort(), Object.keys(actual).sort());
  assert.equal(anchor.version, actual.version);
  assert.match(anchor.workerMainPid || '', /^[1-9][0-9]*$/);
  assert.match(anchor.journalPid || '', /^[1-9][0-9]*$/);
  assert.notEqual(anchor.workerMainPid, anchor.journalPid);
  assert.match(anchor.journalTimestampUs || '', /^[1-9][0-9]{15}$/);
  assert.match(anchor.metaSha256 || '', /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(anchor.metaBytes) && anchor.metaBytes > 1000000 && anchor.metaBytes < 8 * 1024 * 1024);
  for (const key of ['workerStartedAt', 'cycleStartedAt', 'cycleFinishedAt'])
    assert.equal(new Date(anchor[key]).toISOString(), anchor[key]);
  assert(Date.parse(anchor.workerStartedAt) <= Date.parse(anchor.cycleStartedAt));
  assert(Date.parse(anchor.cycleStartedAt) <= Date.parse(anchor.cycleFinishedAt));
  const initialStamp = Number(anchor.journalTimestampUs) / 1000;
  assert(initialStamp >= Date.parse(anchor.cycleStartedAt) && initialStamp <= Date.parse(anchor.cycleFinishedAt));
  for (const key of ['workerMainPid', 'workerStartedAt', 'journalMessageSha256']) assert.equal(actual[key], anchor[key]);
  if (actual.cycleStartedAt === anchor.cycleStartedAt && actual.cycleFinishedAt === anchor.cycleFinishedAt) {
    assert.deepEqual(actual, anchor);
  } else {
    assert(Date.parse(actual.cycleStartedAt) >= Date.parse(anchor.cycleFinishedAt), 'incident cycle overlaps');
    assert(Date.parse(actual.cycleFinishedAt) > Date.parse(anchor.cycleFinishedAt), 'incident cycle regressed');
    assert(BigInt(actual.journalTimestampUs) > BigInt(anchor.journalTimestampUs), 'incident journal regressed');
  }
  return { ...actual, preparationAllowed: false, workerHealthy: false, readyToCutover: false, productionWrites: 0 };
}
module.exports = { MESSAGE, readStableMeta, verifySyncMetaFailure, incidentAnchor, verifyRepeatedIncident };
