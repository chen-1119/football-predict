'use strict';

const { coherentHandicapDistribution, CODES, DISTRIBUTION_BASIS } = require('./handicapMarginDecision.cjs');
const VERSION = 'published-score-distribution-v1';
const MAX_SCORES = 37 * 37;
const codeFor = margin => margin > 0 ? '1' : margin < 0 ? '2' : 'X';
const emptyVector = () => Object.fromEntries(CODES.map(code => [code, 0]));
const emptyJoint = () => Object.fromEntries(CODES.map(code => [code, emptyVector()]));

// Keep the v1 projection's support identical to handicap-margin-v3's Poisson
// enumeration. Only within-bucket ratios are used; its marginal probabilities
// always come from coherentHandicapDistribution, including frozen calibration.
function poissonWeights(lambda) {
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 12) return null;
  const target = 1 - 1e-12;
  const max = Math.min(36, Math.max(12, Math.ceil(lambda + 10 * Math.sqrt(lambda + 1))));
  const values = [Math.exp(-lambda)];
  let sum = values[0];
  for (let k = 1; k <= max; k++) {
    values.push(values[k - 1] * lambda / k);
    sum += values[k];
    if (k >= 10 && sum >= target) break;
  }
  return values;
}

/** Read-only projection of a complete frozen publication, never a live model.
 * Every score probability is unconditional. Filtering aligned candidates or
 * displaying only a few scores does not renormalize their probabilities. */
function buildPublishedScoreDistribution(decision, options = {}) {
  const unavailable = reason => ({ status: 'unavailable', version: VERSION, reason,
    decisionId: typeof decision?.decisionId === 'string' ? decision.decisionId : null,
    recordHash: typeof decision?.recordHash === 'string' ? decision.recordHash : null,
    topScores: [], alignedScores: [] });
  if (!decision) return unavailable('decision-missing');
  try {
    const { validDecision } = require('../../scripts/recommendationPlatform/decision.cjs');
    if (!validDecision(decision)) return unavailable('invalid-decision-record');
    const h = decision.handicapAnalysis;
    if (h?.version !== 'handicap-margin-v3' || h.distributionBasis !== DISTRIBUTION_BASIS) {
      return unavailable('unsupported-distribution-version');
    }
    const matrix = coherentHandicapDistribution(h.lambdas.home, h.lambdas.away, h.handicapLine,
      h.straightProbabilities, h.straightTipCode, h.historicalCalibration?.applied ? h.probabilities : null);
    const homeWeights = poissonWeights(h.lambdas.home), awayWeights = poissonWeights(h.lambdas.away);
    if (!matrix || !homeWeights || !awayWeights) return unavailable('score-matrix-unavailable');

    const rawJoint = emptyJoint(), rawScores = [];
    let captured = 0;
    for (let home = 0; home < homeWeights.length; home++) {
      for (let away = 0; away < awayWeights.length; away++) {
        const weight = homeWeights[home] * awayWeights[away];
        const hadCode = codeFor(home - away), hhadCode = codeFor(home - away + h.handicapLine);
        rawJoint[hadCode][hhadCode] += weight;
        captured += weight;
        rawScores.push({ home, away, hadCode, hhadCode, weight });
      }
    }
    const targetJoint = matrix.jointProbabilities;
    if (Math.abs(captured - matrix.capturedMass) > 1e-12
      || CODES.some(had => CODES.some(hhad => targetJoint[had][hhad] > 0 && rawJoint[had][hhad] === 0))) {
      return unavailable('score-matrix-inconsistent');
    }
    const scores = [];
    const hadProbabilities = emptyVector(), hhadProbabilities = emptyVector(), reproducedJoint = emptyJoint();
    for (const row of rawScores) {
      const bucket = rawJoint[row.hadCode][row.hhadCode];
      const probability = bucket > 0 ? row.weight / bucket * targetJoint[row.hadCode][row.hhadCode] : 0;
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) return unavailable('score-matrix-inconsistent');
      if (!probability) continue;
      const { weight, ...score } = row;
      scores.push({ ...score, label: `${row.home}-${row.away}`, probability });
      hadProbabilities[row.hadCode] += probability;
      hhadProbabilities[row.hhadCode] += probability;
      reproducedJoint[row.hadCode][row.hhadCode] += probability;
    }
    // Existing HHAD evidence is rounded to six decimals. Do not alter that
    // evidence to make the newly derived, full-precision scores look identical.
    if (Math.abs(CODES.reduce((sum, c) => sum + hadProbabilities[c], 0) - 1) > 1e-9
      || CODES.some(c => Math.abs(hadProbabilities[c] - decision.probabilities[c]) > 1e-9
        || Math.abs(hhadProbabilities[c] - h.overallProbabilities[c]) > 1e-6 + 1e-12
        || Math.abs(reproducedJoint[h.straightTipCode][c] / h.straightConditionedMass - h.probabilities[c]) > 1e-6 + 1e-12)) {
      return unavailable('score-matrix-inconsistent');
    }
    scores.sort((a, b) => b.probability - a.probability || a.home - b.home || a.away - b.away);
    const limit = Number.isSafeInteger(options?.limit) && options.limit > 0 ? Math.min(options.limit, MAX_SCORES) : 5;
    const aligned = scores.filter(row => row.hadCode === decision.tipCode && row.hhadCode === h.tipCode);
    const topScores = scores.slice(0, limit);
    const topScoresProbability = topScores.reduce((sum, row) => sum + row.probability, 0);
    return {
      status: 'available', version: VERSION, decisionId: decision.decisionId, recordHash: decision.recordHash,
      handicapInputHash: h.inputHash, distributionBasis: h.distributionBasis,
      probabilityBasis: 'unconditional-score-matrix', modelValidation: decision.modelValidation,
      modelGeneratedAt: decision.modelGeneratedAt, publishedAt: decision.publishedAt,
      handicapLine: h.handicapLine, straightTipCode: decision.tipCode, handicapTipCode: h.tipCode,
      topScores, alignedScores: aligned.slice(0, limit), topScoresProbability,
      omittedProbability: Math.max(0, 1 - topScoresProbability),
      alignedProbability: aligned.reduce((sum, row) => sum + row.probability, 0),
      hadProbabilities, hhadProbabilities, capturedMass: matrix.capturedMass, tailMass: matrix.tailMass,
    };
  } catch {
    return unavailable('invalid-decision-record');
  }
}

module.exports = { VERSION, buildPublishedScoreDistribution };
