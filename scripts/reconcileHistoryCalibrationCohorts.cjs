'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { auditExport } = require('./auditOnlineCalibrationExport.cjs');
const { strictInstant } = require('../src/services/strictInstant.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const eventKey = (id, time) => {
  const source = typeof id === 'string' || typeof id === 'number' ? String(id).replace(/^(sporttery_|fivehundred_)/, '') : '';
  const at = Date.parse(time);
  if (!source || !strictInstant(time) || !Number.isFinite(at)) throw new Error('invalid event identity');
  return JSON.stringify([source, new Date(at).toISOString(), 'HAD']);
};
function reconcile(oldDirectory, historyRoot) {
  const oldProof = auditExport(oldDirectory);
  const root = path.join(historyRoot, 'outputs/history-regression-20261002');
  const receiptBytes = fs.readFileSync(path.join(root, 'delivery-receipt.json'));
  const receipt = JSON.parse(receiptBytes);
  const verified = {};
  for (const name of ['report/summary.json', 'report/per-match-evidence.jsonl']) {
    const relative = `outputs/history-regression-20261002/${name}`;
    const entry = receipt.files.find(file => file.path === relative);
    const bytes = fs.readFileSync(path.join(root, name));
    if (!entry || entry.bytes !== bytes.length || entry.sha256 !== digest(bytes)) throw new Error(`history hash mismatch: ${name}`);
    verified[name] = { bytes: bytes.length, sha256: digest(bytes) };
  }
  const summary = JSON.parse(fs.readFileSync(path.join(root, 'report/summary.json')));
  for (const key of ['generationId', 'manifestHash', 'committedAt', 'sourceCycleId']) {
    if (summary.publication[key] !== oldProof.publication[key]) throw new Error('publication mismatch');
  }
  const rows = fs.readFileSync(path.join(root, 'report/per-match-evidence.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const current = new Map();
  for (const row of rows) {
    const key = eventKey(row.record.matchId, row.record.kickoffAt);
    if (current.has(key)) throw new Error('duplicate new event');
    current.set(key, row);
  }
  const paired = rows.filter(row => row.pairedEligible === true);
  if (paired.length !== summary.funnel.sameDecisionPaired || rows.length !== summary.funnel.selected) throw new Error('new cohort count mismatch');
  const old = JSON.parse(fs.readFileSync(path.join(oldDirectory, 'model-evaluation.json')));
  const oldRecords = old.promotionEvidenceAudit.records.filter(row => row.identity.market === 'HAD');
  const oldKeys = new Set();
  const dispositions = {}, eligibleDispositions = {}, comparisons = [];
  for (const row of oldRecords) {
    const key = eventKey(row.identity.sourceMatchId, row.identity.eventVersion);
    if (oldKeys.has(key)) throw new Error('duplicate old evidence event');
    oldKeys.add(key);
    const match = current.get(key);
    const status = match ? match.primaryReason : 'absent-from-new-window';
    dispositions[status] = (dispositions[status] || 0) + 1;
    if (row.promotionEligible) eligibleDispositions[status] = (eligibleDispositions[status] || 0) + 1;
    comparisons.push({ eventKey: key, oldEvidenceEligible: row.promotionEligible, newDisposition: status,
      oldDecisionAt: row.clocks.decisionAt, newDecisionAt: match?.record.decision?.at ?? null,
      sameDecisionClock: match?.record.decision?.at ? Date.parse(row.clocks.decisionAt) === Date.parse(match.record.decision.at) : null });
  }
  const metrics = summary.recomputedFrozenPair.metrics.publishedModel;
  const classBias = Object.fromEntries(['home', 'draw', 'away'].map(code => {
    const bins = metrics.reliability[code];
    const predicted = bins.reduce((sum, bin) => sum + bin.n * (bin.meanProbability ?? 0), 0) / metrics.n;
    const actual = bins.reduce((sum, bin) => sum + bin.positive, 0) / metrics.n;
    return [code, { rows: metrics.n, meanProbability: predicted, actualShare: actual, bias: predicted - actual }];
  }));
  return { version: 'history-calibration-cohort-reconciliation-v1', productionEligible: false,
    publication: summary.publication, historyReceiptSha256: digest(receiptBytes), verified,
    oldAggregateStrictRows: old.promotionMarketBaseline.metrics.rows,
    oldSeparateEvidenceHadRows: oldRecords.length,
    oldSeparateEvidenceEligibleHadRows: oldRecords.filter(row => row.promotionEligible).length,
    newPairedRows: paired.length, oldEvidenceDispositions: dispositions, oldEligibleEvidenceDispositions: eligibleDispositions,
    newPairedAbsentFromOldEvidence: paired.filter(row => !oldKeys.has(eventKey(row.record.matchId, row.record.kickoffAt))).length,
    comparisons, classBias, candidateReplay: summary.candidateReplay.folds,
    limitation: 'Old 145 aggregate has no event membership list. Separate evidence HAD rows are not its membership; this cannot prove that 154 is 145 plus nine. Byte hashes are checked against local trusted receipts; remote signatures are not revalidated by this utility.' };
}
if (require.main === module) process.stdout.write(`${JSON.stringify(reconcile(process.argv[2], process.argv[3]), null, 2)}\n`);
module.exports = { reconcile, eventKey };
