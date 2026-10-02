'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const specs = [
  ['targeted-tests', ['--test', 'tests/model-input-usage-clock.test.cjs', 'tests/frozen-model-disagreement.test.cjs', 'tests/recommendation-readiness-presentation.test.cjs', 'tests/published-evidence-snapshot.test.cjs', 'tests/prematch-collection-panel.test.cjs', 'tests/frontend-evidence-shared-helper-gate.test.cjs']],
  ['official-closed-schedule', ['tests/official-closed-schedule-evidence.test.cjs']],
  ['data-validation-scopes', ['scripts/verifyDataValidationScopes.cjs']],
  ['frontend-evidence-semantics', ['scripts/verifyFrontendEvidenceSemantics.cjs']],
  ['form-recency-shadow', ['scripts/verifyFormRecencyShadow.cjs']],
  ['legacy-reference-conflict', ['scripts/verifyLegacyReferenceConflict.cjs']],
];
const report = { version: 'football-four-step-integration-verification-v1', startedAt: new Date().toISOString(), runtime: process.version, productionWrites: false, deployed: false, modelTrained: false, jobs: [], evidence: [] };
for (const [name, args] of specs) {
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(__dirname, name + '.log'), String(run.stdout || '') + String(run.stderr || ''));
  let passed = null, failed = null;
  if (args[0] === '--test') {
    passed = Number(/^# pass (\d+)$/m.exec(run.stdout || '')?.[1] ?? NaN);
    failed = Number(/^# fail (\d+)$/m.exec(run.stdout || '')?.[1] ?? NaN);
  } else {
    try { const parsed = JSON.parse(run.stdout); passed = Array.isArray(parsed.checks) ? parsed.checks.filter(row => row.ok !== false).length : parsed.checks; failed = Array.isArray(parsed.checks) ? parsed.checks.filter(row => row.ok === false).length : parsed.ok ? 0 : null; } catch { /* log retains diagnostic */ }
  }
  report.jobs.push({ name, args, exitCode: run.status, passed, failed, error: run.error?.message || null });
  console.log(JSON.stringify(report.jobs.at(-1)));
}
for (const receiptPath of ['outputs/implementation-20261003/model/receipt.json', 'outputs/implementation-20261003/ui/delivery-receipt.json']) {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, receiptPath), 'utf8'));
  for (const file of receipt.files) {
    const source = file.file || file.path;
    report.evidence.push({ path: source, ok: hash(source) === file.sha256 });
  }
}
report.totalPassed = report.jobs.reduce((sum, job) => sum + (job.passed || 0), 0);
report.ok = report.jobs.every(job => job.exitCode === 0 && job.failed === 0) && report.evidence.every(row => row.ok);
report.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(__dirname, 'integration-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ok:report.ok,totalPassed:report.totalPassed,evidenceChecks:report.evidence.length}));
process.exitCode = report.ok ? 0 : 1;
