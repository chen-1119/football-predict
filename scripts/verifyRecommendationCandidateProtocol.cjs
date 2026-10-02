const assert = require('node:assert/strict');
const { auditCandidateProtocol } = require('./recommendationCandidateProtocol.cjs');
const { qualifyRecommendationOutput } = require('../src/services/recommendationOutputQualification.cjs');
const hash = 'a'.repeat(64);
const split = (start, end, block) => ({ startAt: `2026-08-${start}T00:00:00Z`, endAt: `2026-08-${end}T00:00:00Z`,
  latestResultObservedAt: `2026-08-${end}T00:00:00Z`, rows: 20, eventSetHash: hash, calendarBlocks: [block] });
const manifest = { protocolHash: hash, candidateHash: hash, calibratorHash: hash,
  registeredAt: '2026-07-31T00:00:00Z', candidateLockedAt: '2026-08-10T00:00:00Z',
  calibratorLockedAt: '2026-08-20T00:00:00Z', training: split('01', '10', 'day1'),
  calibration: split('11', '20', 'day2'), finalTest: { ...split('21', '30', 'day3'), usedForSelection: false },
  commonCohortVerified: true, frozenInputsVerified: true };
const original = JSON.stringify(manifest);
assert.equal(auditCandidateProtocol(manifest).status, 'ready-for-shadow-evaluation');
assert.equal(auditCandidateProtocol(manifest).promotionEligible, false);
for (const mutate of [m => m.calibration.calendarBlocks = ['day1'], m => m.finalTest.usedForSelection = true,
  m => m.training.latestResultObservedAt = '2026-08-12T00:00:00Z',
  m => m.calibration.latestResultObservedAt = '2026-08-22T00:00:00Z',
  m => m.candidateLockedAt = '2026-08-12T00:00:00Z', m => m.calibratorLockedAt = '2026-08-22T00:00:00Z',
  m => m.commonCohortVerified = false, m => m.frozenInputsVerified = false,
  m => m.finalTest.startAt = '2026-08-19T00:00:00Z', m => m.training.rows = 0]) {
  const copy = JSON.parse(original); mutate(copy); assert.equal(auditCandidateProtocol(copy).status, 'blocked');
}
assert.equal(JSON.stringify(manifest), original);
const impossibleDate = JSON.parse(original);
impossibleDate.training.startAt = '2026-02-30T00:00:00Z';
assert.ok(auditCandidateProtocol(impossibleDate).blockers.includes('training-window-invalid'));
const gates = { probabilitiesValid: true, sameDecisionMarketVerified: true, decisionClockVerified: true,
  cutoffOpen: true, inputEvidenceVerified: true, severeMissingCount: 0, existingPolicyEligible: true,
  riskEligible: true, modelPromotionEligible: true, dataFresh: true, sourceHealthOk: true, recommendationReliable: true };
assert.equal(qualifyRecommendationOutput(gates).status, 'publishable-recommendation');
for (const key of Object.keys(gates)) {
  const copy = { ...gates }; delete copy[key]; assert.equal(qualifyRecommendationOutput(copy).publishable, false);
}
assert.equal(qualifyRecommendationOutput({ ...gates, recommendationReliable: false }).status, 'analysis-reference');
assert.equal(qualifyRecommendationOutput({ ...gates, severeMissingCount: null }).status, 'waiting-for-data');
assert.equal(qualifyRecommendationOutput({ ...gates, severeMissingCount: 1 }).status, 'waiting-for-data');
assert.equal(qualifyRecommendationOutput({ ...gates, cutoffOpen: false }).publishable, false);
console.log(JSON.stringify({ ok: true, protocolMutationCases: 10, missingGateCases: Object.keys(gates).length,
  productionIntegration: false, inputsUnchanged: true }));
