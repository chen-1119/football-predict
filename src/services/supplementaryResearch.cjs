'use strict';

const { hash } = require('./publishedForecastPolicy.cjs');
const { projectFrozenScoreDistribution } = require('./publishedScoreDistribution.cjs');
const VERSION = 'supplementary-research-v1';

/** Freeze the displayed score and total-goals picks at publication. These are
 * unpriced research selections, never official CRS/TTG bets or combo legs.
 * Old decisions without this field must not acquire retrospective picks. */
function buildSupplementaryResearch(decision) {
  const distribution = projectFrozenScoreDistribution(decision);
  if (distribution.status !== 'available' || !distribution.alignedScores[0]) return null;
  const exact = distribution.alignedScores[0];
  const total = [...distribution.totalGoals].sort((a, b) => b.probability - a.probability
    || distribution.totalGoals.indexOf(a) - distribution.totalGoals.indexOf(b))[0];
  const body = {
    version: VERSION, researchOnly: true, formalPromotionEligible: false, modelValidation: 'unvalidated',
    priceStatus: 'official-sp-unavailable', odds: null,
    sourceMatchId: decision.sourceMatchId, eventVersion: decision.eventVersion,
    modelGeneratedAt: decision.modelGeneratedAt,
    hadInputHash: decision.hadInputHash, handicapInputHash: decision.handicapAnalysis.inputHash,
    probabilityBasis: 'unconditional-score-matrix',
    exactScore: { rule: 'highest-probability-aligned-HAD-HHAD', home: exact.home, away: exact.away,
      label: exact.label, probability: exact.probability },
    totalGoals: { rule: 'highest-probability-total-bucket-lowest-tie', label: total.label,
      probability: total.probability, distribution: distribution.totalGoals },
  };
  return { ...body, contentHash: hash(body) };
}

function validSupplementaryResearch(decision) {
  if (decision.supplementaryPolicyVersion === undefined) return decision.supplementaryResearch === undefined;
  if (decision.supplementaryPolicyVersion !== VERSION) return false;
  if (decision.supplementaryResearch === undefined) return false;
  return hash(decision.supplementaryResearch) === hash(buildSupplementaryResearch(decision));
}

module.exports = { VERSION, buildSupplementaryResearch, validSupplementaryResearch };
