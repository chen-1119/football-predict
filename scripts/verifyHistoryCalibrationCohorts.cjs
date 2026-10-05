const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { reconcile, eventKey } = require('./reconcileHistoryCalibrationCohorts.cjs');
const [oldDirectory, historyRoot] = process.argv.slice(2);
const result = reconcile(oldDirectory, historyRoot);
assert.equal(result.oldAggregateStrictRows, 145);
assert.equal(result.oldSeparateEvidenceEligibleHadRows, 60);
assert.equal(result.newPairedRows, 154);
assert.equal(result.newPairedAbsentFromOldEvidence, 85);
assert.equal(result.oldEvidenceDispositions['paired-accepted'], 69);
assert.equal(result.oldEligibleEvidenceDispositions['paired-accepted'], 50);
assert.ok(result.classBias.home.bias < 0);
assert.equal(result.productionEligible, false);
assert.equal(eventKey('sporttery_1', '2026-09-01T08:00:00+08:00'), eventKey('1', '2026-09-01T00:00:00Z'));
assert.notEqual(eventKey('1', '2026-09-01T00:00:00Z'), eventKey('1', '2026-09-02T00:00:00Z'));
assert.throws(() => eventKey(null, '2026-09-01T00:00:00Z'));
assert.throws(() => eventKey('1', '2026-02-30T00:00:00Z'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'football-cohort-check-'));
try {
  const directory = path.join(temporary, 'outputs/history-regression-20261002');
  fs.mkdirSync(path.join(directory, 'report'), { recursive: true });
  for (const name of ['delivery-receipt.json', 'report/summary.json', 'report/per-match-evidence.jsonl']) {
    fs.copyFileSync(path.join(historyRoot, 'outputs/history-regression-20261002', name), path.join(directory, name));
  }
  fs.appendFileSync(path.join(directory, 'report/summary.json'), ' ');
  assert.throws(() => reconcile(oldDirectory, temporary), /history hash mismatch/);
} finally { fs.rmSync(temporary, { recursive: true }); }
console.log(JSON.stringify({ ok: true, realNewPairedRows: result.newPairedRows, old145MembershipReconstructed: false,
  hashTamperRejected: true, invalidCalendarRejected: true, productionWrites: false }));
