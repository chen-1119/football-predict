const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { auditExport, pairedSummary, wilsonInterval } = require('./auditOnlineCalibrationExport.cjs');

const source = process.argv[2];
if (!source) throw new Error('verified export directory required');
const before = new Map(fs.readdirSync(source).filter(n => n.endsWith('.json')).map(n => [n, fs.readFileSync(path.join(source, n))]));
const report = auditExport(source);
assert.equal(report.strictSameDecision.rows, 145);
assert.equal(report.strictSameDecision.improvement.brier, -0.074);
assert.equal(report.strictSameDecision.improvement.logLoss, -0.1096);
assert.equal(report.promotionEligible, false);
const perfectSmall = wilsonInterval(7, 1);
assert.ok(perfectSmall[0] < 0.65 && perfectSmall[1] === 1);
assert.throws(() => wilsonInterval(0, 1));
assert.throws(() => wilsonInterval(7, null));
assert.throws(() => pairedSummary({ metrics: { rows: 2 }, modelOnSameRows: { rows: 3 }, comparison: { rows: 2 } }), /cohort/);
assert.throws(() => pairedSummary({ metrics: { rows: 2 }, modelOnSameRows: { rows: 2 }, comparison: { rows: 2 } }), /missing/);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'football-calibration-audit-'));
try {
  for (const name of ['online-validation-inputs-receipt.json', 'model-evaluation.json', 'model-strategy.json', 'matches-current.json']) {
    fs.copyFileSync(path.join(source, name), path.join(temporary, name));
  }
  fs.appendFileSync(path.join(temporary, 'model-evaluation.json'), ' ');
  assert.throws(() => auditExport(temporary), /hash\/size\/publication mismatch/);
  fs.copyFileSync(path.join(source, 'model-evaluation.json'), path.join(temporary, 'model-evaluation.json'));
  const receiptPath = path.join(temporary, 'online-validation-inputs-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  receipt.files[0].provenance.generationId = 'different-generation';
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => auditExport(temporary), /hash\/size\/publication mismatch/);
} finally {
  // Only this process-created temporary fixture is removed.
  fs.rmSync(temporary, { recursive: true });
}
for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(source, name)), bytes);
console.log(JSON.stringify({ ok: true, checks: 12, sourceUnchanged: true, strictRows: report.strictSameDecision.rows }));
