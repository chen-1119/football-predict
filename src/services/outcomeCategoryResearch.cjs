'use strict';

const { selectionQuality } = require('./recommendationSelectionQuality.cjs');

const VERSION = 'outcome-category-research-v1';
const CODES = Object.freeze(['1', 'X', '2']);
const EPSILON = 1e-10;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const rank = (codes, values) => codes.slice().sort((a, b) => values[b] - values[a] || CODES.indexOf(a) - CODES.indexOf(b));

function validTriplets(decision) {
  const probabilities = decision?.probabilities;
  const odds = decision?.quoteOdds;
  if (!probabilities || !odds || !CODES.every(code =>
    finite(probabilities[code]) && probabilities[code] >= 0 && probabilities[code] <= 1
    && finite(odds[code]) && odds[code] > 1)) return false;
  return Math.abs(CODES.reduce((sum, code) => sum + probabilities[code], 0) - 1) <= 1e-6;
}

function inputReasons(quality) {
  const reasons = [];
  if (!quality?.inputEvidenceHash) reasons.push('input-evidence-unavailable');
  else if (quality.arithmeticStatus !== 'verified') reasons.push('input-arithmetic-unverified');
  const elo = quality?.samples?.elo;
  const form = quality?.samples?.form;
  const weights = quality?.weights;
  const eloReady = weights?.elo > 0 && elo?.home >= 6 && elo?.away >= 6;
  const formReady = weights?.form > 0 && weights?.poisson > 0 && form?.home >= 8 && form?.away >= 8;
  if (reasons.length === 0 && !eloReady && !formReady) reasons.push('team-samples-insufficient');
  return reasons;
}

/**
 * Describe possible 1/X/2 patterns from one immutable published decision.
 * This is research only: it cannot change the decision, create a selection,
 * certify model calibration, or promote a formal betting recommendation.
 */
function classifyOutcomeResearch(row) {
  const decision = row?.decision || row;
  const suppliedQuality = row?.decision ? row.selectionQuality : null;
  const base = { version: VERSION, researchOnly: true, formalPromotionEligible: false,
    decisionId: decision?.decisionId || null, recordHash: decision?.recordHash || null };
  if (decision?.market !== 'HAD' || !validTriplets(decision)) {
    return { ...base, category: 'watch', candidateCode: null, researchQualified: false,
      reasons: ['published-had-triplet-invalid'], evidenceCodes: [], outcomes: [] };
  }

  const p = decision.probabilities;
  const odds = decision.quoteOdds;
  const inverseTotal = CODES.reduce((sum, code) => sum + 1 / odds[code], 0);
  const fair = Object.fromEntries(CODES.map(code => [code, (1 / odds[code]) / inverseTotal]));
  const modelOrder = rank(CODES, p);
  const marketOrder = rank(CODES, fair);
  const outcomes = CODES.map(code => ({
    code,
    modelProbability: p[code],
    fairMarketProbability: fair[code],
    odds: odds[code],
    probabilityEdge: p[code] - fair[code],
    expectedValue: p[code] * odds[code] - 1,
    modelRank: modelOrder.indexOf(code) + 1,
    marketRank: marketOrder.indexOf(code) + 1,
  }));
  const byCode = Object.fromEntries(outcomes.map(item => [item.code, item]));
  const top = byCode[modelOrder[0]];
  const draw = byCode.X;
  const favorite = byCode[marketOrder[0]];
  const quality = selectionQuality(decision);
  const reasons = inputReasons(quality);
  if (suppliedQuality && (suppliedQuality.inputEvidenceHash !== quality.inputEvidenceHash
    || suppliedQuality.arithmeticStatus !== quality.arithmeticStatus
    || suppliedQuality.qualified !== quality.qualified)) reasons.push('selection-quality-mismatch');
  const officialQuoteBound = decision.quoteSource === '500.com:jczq:HAD'
    ? decision.sourceVerification === 'warehouse-jczq-extraction'
    : /^sporttery:had(?:$|:)/i.test(String(decision.quoteSource || ''))
      && decision.sourceVerification === 'source-label-and-publication-binding';
  if (!officialQuoteBound) {
    reasons.push('official-had-quote-unverified');
  }

  let category = 'watch';
  let candidate = null;
  let evidenceCodes = [];
  if (top.code === favorite.code && top.modelProbability >= 0.48
    && top.modelProbability - byCode[modelOrder[1]].modelProbability >= 0.08) {
    category = 'strong-favorite';
    candidate = top;
    evidenceCodes = ['model-market-favorite-aligned', 'model-lead-strong'];
  } else if (draw.modelProbability >= 0.28
    && top.modelProbability <= 0.45
    && top.modelProbability - draw.modelProbability <= 0.10 + EPSILON
    && favorite.fairMarketProbability <= 0.50) {
    category = 'balanced-draw';
    candidate = draw;
    evidenceCodes = ['balanced-model-probabilities', 'draw-near-model-leader'];
  } else {
    const upset = outcomes.filter(item => item.code !== 'X' && item.marketRank > 1
      && item.modelProbability >= 0.30
      && top.modelProbability - item.modelProbability <= 0.08 + EPSILON
      && item.probabilityEdge >= 0.025
      && item.expectedValue >= 0.03)
      .sort((a, b) => b.expectedValue - a.expectedValue || b.modelProbability - a.modelProbability
        || CODES.indexOf(a.code) - CODES.indexOf(b.code))[0];
    if (upset) {
      category = 'upset-signal';
      candidate = upset;
      evidenceCodes = ['nonfavorite-near-model-leader', 'nonfavorite-positive-price-edge'];
    }
  }

  if (!candidate) reasons.push('no-category-signal');
  else {
    if (candidate.probabilityEdge < 0.015) reasons.push('price-edge-insufficient');
    if (candidate.expectedValue < 0.025) reasons.push('expected-value-insufficient');
  }
  // Direction-changing categories remain observations until an independent,
  // source-timed cohort establishes that they outperform the same-event
  // market. Input completeness and a positive arithmetic EV cannot do that.
  if (category === 'balanced-draw' || category === 'upset-signal')
    reasons.push('category-holdout-unvalidated');
  return { ...base, category, candidateCode: candidate?.code || null,
    modelLeaderCode: top.code, marketFavoriteCode: favorite.code,
    researchQualified: Boolean(candidate && reasons.length === 0), reasons, evidenceCodes,
    outcomes };
}

module.exports = { VERSION, CODES, classifyOutcomeResearch };
