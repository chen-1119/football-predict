'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildPinnedSshBaseOptions, resolveReleaseSshHostKeyPin } = require('./releaseSshHostKeyPin.cjs');
const { buildReadOnlyWorkerProbe } = require('./releaseWorkerPreflight.cjs');

// Reject known broken foundations before downloading archive observations,
// reserving a sequence, running verifiers or building. No runtime is modified.
function runLiveWorkerPreflight() {
  const rootDir = path.resolve(__dirname, '..'), tmpDir = path.join(rootDir, '.codex-tmp');
  const host = process.env.RELEASE_DEPLOY_HOST || '134.175.132.183';
  const user = process.env.RELEASE_DEPLOY_USER || 'ubuntu';
  assert.match(user, /^[a-z_][a-z0-9_-]*$/i);
  const port = Number(process.env.RELEASE_DEPLOY_PORT || 22);
  const keyPath = path.resolve(process.env.RELEASE_DEPLOY_KEY || path.join(tmpDir, 'football.pem'));
  assert.ok(fs.statSync(keyPath).isFile());
  const pin = resolveReleaseSshHostKeyPin({ rootDir, tmpDir, host, port });
  const args = ['-p', String(port), ...buildPinnedSshBaseOptions({ keyPath, pin }), `${user}@${host}`,
    'sudo', '-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/opt/node-v22.22.1/bin/node', '-'];
  const manual=require('./manualOfficialReleaseRecovery.cjs'),file=path.join(rootDir,manual.AUTH_ENTRY);
  let source=buildReadOnlyWorkerProbe();
  if(fs.existsSync(file)){
    const st=fs.lstatSync(file);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=65536);
    source=manual.buildProbe(manual.candidateAuthorization(rootDir,JSON.parse(fs.readFileSync(file))));
  }
  const child = spawnSync('ssh', args, { input: source, encoding: 'utf8',
    windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.ok(!child.error && !child.signal && [0, 1].includes(child.status), 'read-only worker transport unavailable');
  const report = JSON.parse(child.stdout);
  if(report.version===manual.ENVELOPE){
    const base=report.workerReport,age=Date.now()-Date.parse(report.checkedAt);
    assert(report.preparationAllowed===true&&child.status===0&&report.workerHealthy===false&&report.readyToCutover===false&&report.productionWrites===0
      &&Array.isArray(report.blockers)&&report.blockers.length===0&&base?.version==='release-worker-preflight-v1'&&base.ok===false
      &&base.readyToCutover===false&&base.productionWrites===0&&Array.isArray(base.blockers)&&base.blockers.length>0
      &&base.checkedAt===report.checkedAt&&Number.isFinite(age)&&age>=-5000&&age<=60000,'manual preparation envelope rejected');
    return report;
  }
  const age = Date.now() - Date.parse(report.checkedAt);
  assert.ok(report.version === 'release-worker-preflight-v1' && report.productionWrites === 0
    && report.readyToCutover === false && typeof report.ok === 'boolean' && Array.isArray(report.blockers)
    && report.blockers.every(value => typeof value === 'string')
    && report.ok === (report.blockers.length === 0) && child.status === (report.ok ? 0 : 1)
    && Number.isFinite(age) && age >= -5000 && age <= 60000, 'invalid or stale worker preparation observation');
  return report;
}
module.exports = { runLiveWorkerPreflight };
if (require.main === module) {
  try { const report = runLiveWorkerPreflight(); console.log(JSON.stringify(report)); if (!report.ok&&!report.preparationAllowed) process.exitCode = 1; }
  catch { console.log(JSON.stringify({ ok: false, blockers: ['worker-preparation-observation-unavailable'],
    productionWrites: 0, readyToCutover: false })); process.exitCode = 1; }
}
