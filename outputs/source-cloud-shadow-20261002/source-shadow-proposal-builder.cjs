'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const target = 'scripts/runSyncWorker.cjs';
const dir = 'outputs/source-cloud-shadow-20261002';
const temp = dir + '/.source-worker-proposal.cjs';
const original = fs.readFileSync(target, 'utf8');
const replaceOnce = (input, needle, replacement) => {
  if (input.split(needle).length !== 2) throw new Error('Worker proposal anchor must occur exactly once');
  return input.replace(needle, replacement);
};
let proposed = replaceOnce(original, 'const fs = require("node:fs");',
  'const fs = require("node:fs");\nconst { readSourceCollectorShadowFiles } = require("./sourceCollectorShadowAdapter.cjs");');
const anchor = '      relayWakeEligible = nextCadence.mode === "hot" && !postDeadlineCooldown && !currentSourceCooldown;';
proposed = replaceOnce(proposed, anchor, [
  '      let sourceCollectionShadow = null;',
  '      if (process.env.SYNC_WORKER_SOURCE_SHADOW === "1") {',
  '        try {',
  '          const shadowFiles = [relaySnapshotPath];',
  '          if (fs.existsSync(`${relaySnapshotPath}.last-failed.json`)) shadowFiles.push(`${relaySnapshotPath}.last-failed.json`);',
  '          sourceCollectionShadow = readSourceCollectorShadowFiles(shadowFiles, {',
  '            asOf: failedAt, previous: workerStatusState?.sourceCollectionShadow,',
  '            closure: readJson(path.join(storeDir, "sporttery-sales-closure-verified.json"), null),',
  '            sourceDataUpdatedAt: null,',
  '          });',
  '        } catch {',
  '          sourceCollectionShadow = { state: "unknown-evidence", reason: "shadow-adapter-unavailable",',
  '            shadowOnly: true, publicationAction: "none", schedulingApplied: false };',
  '        }',
  '      }',
  anchor,
].join('\n'));
const status = '        ...(currentSourceCooldown ? { failureCooldown: { ...currentSourceCooldown, delayMs: loopDelayMs } } : {}),';
proposed = replaceOnce(proposed, status, status + '\n        ...(sourceCollectionShadow ? { sourceCollectionShadow } : {}),');
fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(temp, proposed);
try {
  if (spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' }).status !== 0) throw new Error('Proposed worker syntax check failed');
  const diff = spawnSync('git', ['diff', '--no-index', '--', target, temp], { encoding: 'utf8' });
  if (diff.status !== 1) throw new Error('Unable to produce worker diff');
  const patch = diff.stdout.split('b/' + temp).join('b/' + target);
  fs.writeFileSync(dir + '/worker-shadow-integration.patch', patch);
  const check = spawnSync('git', ['apply', '--check', dir + '/worker-shadow-integration.patch'], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error('Worker patch check failed: ' + check.stderr);
  const sha = value => createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(dir + '/worker-patch-check.json', JSON.stringify({
    target, originalSha256: sha(original), proposedSha256: sha(proposed), patchSha256: sha(patch),
    syntaxChecked: true, gitApplyCheckExitCode: check.status, applied: false,
    scope: 'Optional shadow output only; no scheduling or publication changes',
  }, null, 2) + '\n');
  console.log('Worker shadow patch syntax and git apply --check passed; shared file unchanged');
} finally {
  if (path.dirname(path.resolve(temp)) !== path.resolve(dir)) throw new Error('Unsafe temporary path');
  fs.unlinkSync(temp);
}
