'use strict';

const { hash } = require('./publishedForecastPolicy.cjs');
const { projectFrozenScoreDistribution } = require('./publishedScoreDistribution.cjs');
const VERSION = 'supplementary-research-v2';
const LEGACY_VERSION = 'supplementary-research-v1';

/** Freeze the displayed score and total-goals picks at publication. These are
 * unpriced research selections, never official CRS/TTG bets or combo legs.
 * Old decisions without this field must not acquire retrospective picks. */
function buildSupplementaryResearch(decision) {
  const distribution = projectFrozenScoreDistribution(decision);
  const version = decision.supplementaryPolicyVersion || VERSION;
  const exact = version === LEGACY_VERSION ? distribution.alignedScores[0] : distribution.topScores[0];
  if (distribution.status !== 'available' || !exact) return null;
  const total = [...distribution.totalGoals].sort((a, b) => b.probability - a.probability
    || distribution.totalGoals.indexOf(a) - distribution.totalGoals.indexOf(b))[0];
  const body = {
    version, researchOnly: true, formalPromotionEligible: false, modelValidation: 'unvalidated',
    priceStatus: 'official-sp-unavailable', odds: null,
    sourceMatchId: decision.sourceMatchId, eventVersion: decision.eventVersion,
    modelGeneratedAt: decision.modelGeneratedAt,
    hadInputHash: decision.hadInputHash, handicapInputHash: decision.handicapAnalysis?.inputHash || null,
    probabilityBasis: 'unconditional-score-matrix',
    exactScore: { rule: version === LEGACY_VERSION ? 'highest-probability-aligned-HAD-HHAD' : 'highest-probability-full-score-matrix', home: exact.home, away: exact.away,
      label: exact.label, probability: exact.probability },
    totalGoals: { rule: 'highest-probability-total-bucket-lowest-tie', label: total.label,
      probability: total.probability, distribution: distribution.totalGoals },
  };
  return { ...body, contentHash: hash(body) };
}

function validSupplementaryResearch(decision) {
  if (decision.supplementaryPolicyVersion === undefined) return decision.supplementaryResearch === undefined;
  if (![VERSION, LEGACY_VERSION].includes(decision.supplementaryPolicyVersion)) return false;
  if (decision.supplementaryResearch === undefined) return false;
  return hash(decision.supplementaryResearch) === hash(buildSupplementaryResearch(decision));
}

module.exports = { VERSION, LEGACY_VERSION, buildSupplementaryResearch, validSupplementaryResearch };
