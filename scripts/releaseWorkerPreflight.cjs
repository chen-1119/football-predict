'use strict';

// A fresh, read-only early rejection check, never a cutover/publication receipt.
// Keep these two functions self-contained: the client sends exactly this code
// over its pinned SSH connection; the signed server entry runs the same probe.
function evaluateWorkerPreflight(observation) {
  const { checkedAt, serviceBefore, serviceAfter, status, processMatches } = observation;
  const now = Date.parse(checkedAt);
  const stamp = status?.checkedAt || status?.at || null;
  const statusAt = Date.parse(stamp || '');
  const startedAt = Date.parse(serviceAfter?.ExecMainStartTimestamp || '');
  const mainPid = Number(serviceAfter?.MainPID);
  const blockers = [], warnings = [];
  if (!Number.isFinite(now)) blockers.push('invalid-probe-clock');
  if (serviceBefore?.ActiveState !== 'active' || serviceAfter?.ActiveState !== 'active') blockers.push('worker-service-inactive');
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0 || Number(serviceBefore?.MainPID) !== mainPid
    || serviceBefore?.ExecMainStartTimestamp !== serviceAfter?.ExecMainStartTimestamp) blockers.push('worker-process-changed');
  if (processMatches !== true) blockers.push('worker-process-not-confirmed');
  if (!status || typeof status !== 'object' || Array.isArray(status)) blockers.push('worker-status-missing');
  if (!Number.isSafeInteger(status?.pid) || status.pid !== mainPid) blockers.push('worker-status-pid-mismatch');
  if (!Number.isFinite(statusAt) || !Number.isFinite(startedAt) || statusAt < startedAt || statusAt > now + 5000) blockers.push('worker-status-clock-unbound');
  if (status?.ok === false && status?.phase === 'failed') {
    const failedPhase = status.lastCycle?.phase || status.eventCycle?.phase;
    if (failedPhase === 'slow-enrichment-failed' && status.eventCycle?.phase === 'official-result-published'
      && status.eventCycle?.ok === true) warnings.push('worker-slow-enrichment-failed-official-phase-published');
    else blockers.push('worker-latest-official-cycle-failed');
  } else if (status?.ok !== true) blockers.push('worker-status-not-understood');
  // A retry changes phase/ok before it has fixed anything. Do not spend an
  // upload and candidate build merely because the probe landed in that window.
  if (status?.ok === true && status.lastCycle?.ok === false
    && status.lastCycle?.phase === 'official-result-failed') {
    const failedAt = Date.parse(status.lastCycle.finishedAt || '');
    const published = status.eventCycle;
    const publishStart = Date.parse(published?.startedAt || '');
    const publishEnd = Date.parse(published?.finishedAt || '');
    if (!(published?.ok === true && published.phase === 'official-result-published'
      && Number.isFinite(failedAt) && failedAt >= startedAt
      && publishStart >= failedAt && publishEnd >= publishStart && publishEnd <= statusAt))
      blockers.push('worker-official-recovery-unproven');
  }
  return {
    version: 'release-worker-preflight-v1', checkedAt, ok: blockers.length === 0,
    state: blockers.length ? 'prepare-rejected' : 'prepare-may-continue',
    mainPid, phase: typeof status?.phase === 'string' ? status.phase : null,
    statusAt: stamp, statusAgeSeconds: Number.isFinite(statusAt) ? Math.max(0, (now - statusAt) / 1000) : null,
    errorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(status?.errorCode || '') ? status.errorCode : null,
    blockers, warnings, readyToCutover: false, productionWrites: 0,
    scope: 'early rejection only; running is not success; fresh official publication and all final gates remain mandatory',
  };
}

function collectWorkerPreflight() {
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const service = () => Object.fromEntries(execFileSync('systemctl', ['show', 'football-sync-worker.service',
    '--property=ActiveState,MainPID,ExecMainStartTimestamp', '--no-pager'], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  }).trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  const serviceBefore = service();
  const statusPath = '/var/lib/football-predict/sync-worker-status.json';
  const fd = fs.openSync(statusPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let status;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 4 * 1024 * 1024) throw new Error('worker-status-file-unsafe');
    status = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('worker-status-changed-during-read');
  } finally { fs.closeSync(fd); }
  const pid = Number(serviceBefore.MainPID);
  let processMatches = false;
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean);
      const cwd = fs.readlinkSync('/proc/' + pid + '/cwd');
      processMatches = args.includes('/opt/football-predict/scripts/runSyncWorker.cjs')
        || (cwd === '/opt/football-predict' && args.includes('scripts/runSyncWorker.cjs'));
    } catch { /* process disappeared: reject this observation, never restart it */ }
  }
  return { checkedAt: new Date().toISOString(), serviceBefore, serviceAfter: service(), status, processMatches };
}

function buildReadOnlyWorkerProbe() {
  return `'use strict';\n${evaluateWorkerPreflight.toString()}\n${collectWorkerPreflight.toString()}\n`
    + `try { const report=evaluateWorkerPreflight(collectWorkerPreflight()); console.log(JSON.stringify(report)); if(!report.ok)process.exitCode=1; }
catch { console.log(JSON.stringify({version:'release-worker-preflight-v1',ok:false,state:'prepare-rejected',blockers:['worker-probe-unavailable'],readyToCutover:false,productionWrites:0})); process.exitCode=1; }`;
}

module.exports = { evaluateWorkerPreflight, collectWorkerPreflight, buildReadOnlyWorkerProbe };
if (require.main === module) {
  try {
    const report = evaluateWorkerPreflight(collectWorkerPreflight());
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ version: 'release-worker-preflight-v1', ok: false, state: 'prepare-rejected',
      blockers: ['worker-probe-unavailable'], readyToCutover: false, productionWrites: 0 }));
    process.exitCode = 1;
  }
}
