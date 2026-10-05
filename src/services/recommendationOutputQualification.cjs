'use strict';

// Adapter proposal only. Callers must supply existing validator results; this
// function adds no alternative admission thresholds and never rewrites a pick.
function qualifyRecommendationOutput(evidence = {}) {
  const inputGates = ['probabilitiesValid', 'sameDecisionMarketVerified', 'decisionClockVerified',
    'inputEvidenceVerified'];
  const blockers = inputGates.filter(key => evidence[key] !== true);
  if (!Number.isSafeInteger(evidence.severeMissingCount) || evidence.severeMissingCount < 0) {
    blockers.push('severeMissingCountUnknown');
  } else if (evidence.severeMissingCount > 0) blockers.push('severeMissingInputs');
  if (blockers.length) return { status: 'waiting-for-data', labelZh: '等待资料', publishable: false, blockers };
  const publicationGates = ['existingPolicyEligible', 'riskEligible', 'modelPromotionEligible',
    'dataFresh', 'sourceHealthOk', 'recommendationReliable', 'cutoffOpen'];
  const publicationBlockers = publicationGates.filter(key => evidence[key] !== true);
  return publicationBlockers.length
    ? { status: 'analysis-reference', labelZh: '分析参考', publishable: false, blockers: publicationBlockers }
    : { status: 'publishable-recommendation', labelZh: '可发布推荐', publishable: true, blockers: [] };
}
module.exports = { qualifyRecommendationOutput };
