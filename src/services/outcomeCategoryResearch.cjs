'use strict';

const { selectionQuality } = require('./recommendationSelectionQuality.cjs');
const { uniquePrimary } = require('./primaryDirectionAdmission.cjs');
const VERSION = 'outcome-category-research-v1';
const CODES = Object.freeze(['1', 'X', '2']);
const EPSILON = 1e-10;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rank = (codes, values) => codes.slice().sort((a, b) => values[b] - values[a] || CODES.indexOf(a) - CODES.indexOf(b));
function validTriplets(decision) {
  const p = decision?.probabilities, odds = decision?.quoteOdds;
  return Boolean(p && odds && CODES.every(code => finite(p[code]) && p[code] >= 0 && p[code] <= 1
    && finite(odds[code]) && odds[code] > 1) && Math.abs(CODES.reduce((sum, code) => sum + p[code], 0) - 1) <= 1e-6);
}
function inputReasons(quality) {
  const reasons = [];
  if (!quality?.inputEvidenceHash) reasons.push('input-evidence-unavailable');
  else if (quality.arithmeticStatus !== 'verified') reasons.push('input-arithmetic-unverified');
  const elo = quality?.samples?.elo, form = quality?.samples?.form, weights = quality?.weights;
  const eloReady = weights?.elo > 0 && elo?.home >= 6 && elo?.away >= 6;
  const formReady = weights?.form > 0 && weights?.poisson > 0 && form?.home >= 8 && form?.away >= 8;
  if (reasons.length === 0 && !eloReady && !formReady) reasons.push('team-samples-insufficient');
  return reasons;
}
/** Describe candidates without rewriting a frozen pick or inventing a profit claim.
 * The existing primary takes display precedence; category research is separate. */
function classifyOutcomeResearch(row) {
  const decision = row?.decision || row;
  const suppliedQuality = row?.decision ? row.selectionQuality : null;
  const base = { version: VERSION, researchOnly: true, formalPromotionEligible: false,
    decisionId: decision?.decisionId || null, recordHash: decision?.recordHash || null };
  if (decision?.market !== 'HAD' || !validTriplets(decision)) {
    return { ...base, category: 'watch', candidateCode: null, researchQualified: false,
      reasons: ['published-had-triplet-invalid'], evidenceCodes: [], outcomes: [] };
  }
  const p = decision.probabilities, odds = decision.quoteOdds;
  const inverseTotal = CODES.reduce((sum, code) => sum + 1 / odds[code], 0);
  const fair = Object.fromEntries(CODES.map(code => [code, (1 / odds[code]) / inverseTotal]));
  const modelOrder = rank(CODES, p), marketOrder = rank(CODES, fair);
  const favorites = CODES.filter(code => fair[code] >= fair[marketOrder[0]] - EPSILON);
  const outcomes = CODES.map(code => ({ code, modelProbability: p[code], fairMarketProbability: fair[code], odds: odds[code],
    probabilityEdge: p[code] - fair[code], expectedValue: p[code] * odds[code] - 1,
    modelRank: modelOrder.indexOf(code) + 1, marketRank: marketOrder.indexOf(code) + 1 }));
  const byCode = Object.fromEntries(outcomes.map(item => [item.code, item]));
  const top = byCode[modelOrder[0]], draw = byCode.X, favorite = byCode[marketOrder[0]];
  const quality = selectionQuality(decision), reasons = inputReasons(quality);
  if (suppliedQuality && (suppliedQuality.inputEvidenceHash !== quality.inputEvidenceHash
    || suppliedQuality.arithmeticStatus !== quality.arithmeticStatus
    || suppliedQuality.qualified !== quality.qualified)) reasons.push('selection-quality-mismatch');
  const officialQuoteBound = decision.quoteSource === '500.com:jczq:HAD'
    ? decision.sourceVerification === 'warehouse-jczq-extraction'
    : /^sporttery:had(?:$|:)/i.test(String(decision.quoteSource || ''))
      && decision.sourceVerification === 'source-label-and-publication-binding';
  if (!officialQuoteBound) reasons.push('official-had-quote-unverified');
  const primary = uniquePrimary(p);
  let category = 'watch', candidate = null, evidenceCodes = [];
  // Prioritize the existing unique primary. A near-draw second choice must
  // never hide a genuinely published nonfavorite or replace its label.
  if (primary === decision.tipCode && primary === 'X') {
    category = 'balanced-draw'; candidate = top;
    evidenceCodes = ['unchanged-published-primary', 'draw-is-model-leader'];
  } else if (primary === decision.tipCode && primary && !favorites.includes(primary)) {
    category = 'upset-signal'; candidate = top;
    evidenceCodes = ['unchanged-published-primary', 'model-leader-differs-from-market'];
  } else if (top.code === favorite.code && top.modelProbability >= 0.48
    && top.modelProbability - byCode[modelOrder[1]].modelProbability >= 0.08) {
    category = 'strong-favorite'; candidate = top;
    evidenceCodes = ['model-market-favorite-aligned', 'model-lead-strong'];
  } else if (draw.modelProbability >= 0.28 && top.modelProbability <= 0.45
    && top.modelProbability - draw.modelProbability <= 0.10 + EPSILON && favorite.fairMarketProbability <= 0.50) {
    category = 'balanced-draw'; candidate = draw;
    evidenceCodes = ['balanced-model-probabilities', 'draw-near-model-leader'];
  } else {
    const upset = outcomes.filter(item => item.code !== 'X' && !favorites.includes(item.code)
      && item.modelProbability >= 0.30 && top.modelProbability - item.modelProbability <= 0.08 + EPSILON
      && item.probabilityEdge >= 0.025 && item.expectedValue >= 0.03)
      .sort((a, b) => b.expectedValue - a.expectedValue || b.modelProbability - a.modelProbability
        || CODES.indexOf(a.code) - CODES.indexOf(b.code))[0];
    if (upset) { category = 'upset-signal'; candidate = upset; evidenceCodes = ['nonfavorite-near-model-leader', 'nonfavorite-positive-price-edge']; }
  }
  const unchangedPrimary = Boolean(candidate && candidate.code === decision.tipCode && primary === decision.tipCode);
  if (!candidate) reasons.push('no-category-signal');
  else {
    if (candidate.probabilityEdge < 0.015) reasons.push('price-edge-insufficient');
    if (candidate.expectedValue < 0.025) reasons.push('expected-value-insufficient');
  }
  if (unchangedPrimary) reasons.push(...quality.reasons);
  // Category research remains a separate unvalidated track. This label does
  // not revoke the unchanged primary's independently verified admission.
  if (category === 'balanced-draw' || category === 'upset-signal') reasons.push('category-holdout-unvalidated');
  return { ...base, category, candidateCode: candidate?.code || null, modelLeaderCode: top.code,
    marketFavoriteCode: favorite.code, marketFavoriteCodes: favorites, unchangedPrimary,
    researchQualified: Boolean(candidate && reasons.length === 0), reasons: [...new Set(reasons)], evidenceCodes, outcomes };
}
module.exports = { VERSION, CODES, classifyOutcomeResearch };
