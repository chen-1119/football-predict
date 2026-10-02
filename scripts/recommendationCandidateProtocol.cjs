'use strict';

const HASH = /^[a-f0-9]{64}$/;
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// Validates evaluation manifests supplied by the history task. No dataset
// selection, training, replay, threshold tuning, or publication occurs here.
function auditCandidateProtocol(manifest = {}) {
  const blockers = [];
  const stamp = key => instant(manifest[key]);
  const registered = stamp('registeredAt');
  const locked = stamp('candidateLockedAt');
  const fitted = stamp('calibratorLockedAt');
  if (!HASH.test(manifest.protocolHash || '') || !HASH.test(manifest.candidateHash || '')
      || !HASH.test(manifest.calibratorHash || '')) blockers.push('implementation-hash-missing');
  if (![registered, locked, fitted].every(v => v !== null)) blockers.push('registration-or-lock-clock-missing');
  const stages = ['training', 'calibration', 'finalTest'];
  const seen = new Set();
  let previousEnd = null;
  for (const stage of stages) {
    const split = manifest[stage] || {};
    const start = instant(split.startAt), end = instant(split.endAt);
    const results = instant(split.latestResultObservedAt);
    if (start === null || end === null || start >= end) blockers.push(`${stage}-window-invalid`);
    if (previousEnd !== null && start !== null && start < previousEnd) blockers.push(`${stage}-time-overlap`);
    previousEnd = end;
    if (!Number.isSafeInteger(split.rows) || split.rows <= 0 || !HASH.test(split.eventSetHash || '')) {
      blockers.push(`${stage}-cohort-evidence-missing`);
    }
    if (!Array.isArray(split.calendarBlocks) || !split.calendarBlocks.length
        || split.calendarBlocks.some(block => typeof block !== 'string' || !block.trim())) {
      blockers.push(`${stage}-calendar-blocks-missing`);
    } else for (const block of split.calendarBlocks) {
      if (seen.has(block)) blockers.push(`${stage}-calendar-block-reused`);
      seen.add(block);
    }
    if (results === null) blockers.push(`${stage}-result-clock-missing`);
    if (stage === 'training' && results !== null && locked !== null && results > locked) blockers.push('training-label-after-candidate-lock');
    if (stage === 'calibration' && results !== null && fitted !== null && results > fitted) blockers.push('calibration-label-after-calibrator-lock');
  }
  const calibrationStart = instant(manifest.calibration?.startAt);
  const testStart = instant(manifest.finalTest?.startAt);
  const trainingEnd = instant(manifest.training?.endAt);
  const calibrationEnd = instant(manifest.calibration?.endAt);
  if (trainingEnd !== null && locked !== null && locked < trainingEnd) blockers.push('candidate-lock-before-training-end');
  if (calibrationEnd !== null && fitted !== null && fitted < calibrationEnd) blockers.push('calibrator-lock-before-calibration-end');
  if (registered !== null && instant(manifest.training?.startAt) !== null
      && registered > instant(manifest.training.startAt)) blockers.push('protocol-not-preregistered');
  if (locked !== null && calibrationStart !== null && locked > calibrationStart) blockers.push('candidate-lock-after-calibration-start');
  if (fitted !== null && testStart !== null && fitted > testStart) blockers.push('calibrator-lock-after-test-start');
  if (manifest.finalTest?.usedForSelection !== false) blockers.push('final-test-selection-contamination');
  if (manifest.commonCohortVerified !== true) blockers.push('common-event-set-not-verified');
  if (manifest.frozenInputsVerified !== true) blockers.push('frozen-inputs-not-verified');
  return { version: 'recommendation-candidate-protocol-v1', status: blockers.length ? 'blocked' : 'ready-for-shadow-evaluation',
    blockers: [...new Set(blockers)].sort(), promotionEligible: false,
    scope: 'manifest validation only; hashes and verifier flags require independently trusted export receipts' };
}
module.exports = { auditCandidateProtocol };
