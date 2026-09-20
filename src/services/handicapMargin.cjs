'use strict';

// Integer three-way handicap (HHAD), never Asian quarter/half-goal settlement.
// Every probability is unconditional unless explicitly named conditionalOnPrimary.
const VERSION = 'net-margin-hhad-v1';
const CODES = Object.freeze(['1', 'X', '2']);
const finite = value => (typeof value === 'number' || (typeof value === 'string'
  && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) && Number.isFinite(Number(value)) ? Number(value) : null;
function integerLine(value) {
  const parsed = finite(typeof value === 'string'
    ? value.trim().replace(/＋/g, '+').replace(/[－−–—]/g, '-') : value);
  return Number.isSafeInteger(parsed) && Math.abs(parsed) <= 100 ? (parsed === 0 ? 0 : parsed) : null;
}
const outcome = margin => margin > 0 ? '1' : margin < 0 ? '2' : 'X';
function settledHandicap(home, away, line) {
  if (![home, away].every(n => Number.isSafeInteger(n) && n >= 0) || integerLine(line) === null) return null;
  return outcome(home - away + integerLine(line));
}
function vector(value) {
  if (!value || typeof value !== 'object') return null;
  const values = CODES.map(c => finite(value[c]));
  if (values.some(v => v === null || v < 0 || v > 1) || Math.abs(values.reduce((s, v) => s + v, 0) - 1) > 1e-8) return null;
  return Object.fromEntries(CODES.map((c, i) => [c, values[i]]));
}
function leader(p) {
  const sorted = CODES.slice().sort((a, b) => p[b] - p[a]);
  return p[sorted[0]] - p[sorted[1]] > 1e-9 ? sorted[0] : null;
}
function poisson(lambda) {
  if (finite(lambda) === null || Number(lambda) < 0 || Number(lambda) > 30) throw new RangeError('Invalid expected-goal parameter');
  lambda = Number(lambda);
  const values = [Math.exp(-lambda)];
  let tailBound = Infinity;
  for (let k = 0; k < 256; k++) {
    const next = values[k] * lambda / (k + 1), ratio = lambda / (k + 2);
    tailBound = ratio < 1 ? next / (1 - ratio) : Infinity;
    if (tailBound <= 1e-14) return { values, tailBound };
    values.push(next);
  }
  throw new RangeError('Goal distribution did not converge');
}
function poissonShape(homeLambda, awayLambda) {
  const home = poisson(homeLambda), away = poisson(awayLambda), rows = [];
  for (let h = 0; h < home.values.length; h++) for (let a = 0; a < away.values.length; a++) {
    rows.push({ home: h, away: a, probability: home.values[h] * away.values[a] });
  }
  return { rows, tailBound: home.tailBound + away.tailBound };
}
function completeShape(rows, tailBound = 0) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 66049 || !Number.isFinite(tailBound) || tailBound < 0 || tailBound > 1e-8) throw new Error('A complete score distribution is required');
  let total = 0; const seen = new Set();
  const checked = rows.map(row => {
    if (!row || ![row.home, row.away].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 256)
      || typeof row.probability !== 'number' || !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1) throw new Error('Invalid score cell');
    const key = `${row.home}:${row.away}`;
    if (seen.has(key)) throw new Error('Duplicate score cell');
    seen.add(key); total += row.probability;
    return { home: row.home, away: row.away, probability: row.probability };
  });
  // A top-3 / top-12 display list is not the full distribution and must not be renormalized.
  if (Math.abs(total - 1) > Math.max(1e-12, tailBound + 1e-12)) throw new Error('Incomplete score distribution');
  return checked;
}
function analyzeHandicap({ line, hadProbabilities, scoreRows, homeLambda, awayLambda }) {
  const h = integerLine(line), had = vector(hadProbabilities);
  if (h === null || !had) throw new Error('Integer handicap and a full HAD vector are required');
  const shape = scoreRows ? { rows: completeShape(scoreRows), tailBound: 0 }
    : poissonShape(homeLambda, awayLambda);
  const base = { '1': 0, X: 0, '2': 0 };
  for (const row of shape.rows) base[outcome(row.home - row.away)] += row.probability;
  const scale = {};
  for (const c of CODES) {
    if (!base[c] && had[c] > 0) throw new Error('Score model has no support for a published outcome');
    scale[c] = base[c] ? had[c] / base[c] : 0;
  }
  const projectedTailBound = shape.tailBound * Math.max(...Object.values(scale));
  if (projectedTailBound > 1e-8) throw new Error('Insufficient score-tail accuracy after outcome alignment');
  // Preserve the already-published HAD vector exactly. Within each HAD outcome,
  // use the score model's relative goal-margin shape, not another odds blend.
  const probabilities = { '1': 0, X: 0, '2': 0 }, margins = new Map();
  const primaryTipCode = leader(had), conditionedMass = { '1': 0, X: 0, '2': 0 };
  for (const row of shape.rows) {
    const margin = row.home - row.away, code = outcome(margin);
    const mass = row.probability * scale[code], adjusted = outcome(margin + h);
    probabilities[adjusted] += mass;
    margins.set(margin, (margins.get(margin) || 0) + mass);
    if (code === primaryTipCode) conditionedMass[adjusted] += mass;
  }
  const primaryProbability = primaryTipCode ? had[primaryTipCode] : null;
  const conditionalOnPrimary = primaryProbability > 0
    ? Object.fromEntries(CODES.map(c => [c, conditionedMass[c] / primaryProbability])) : null;
  const exactMargin = -h;
  const marginDistribution = [...margins].sort((a, b) => a[0] - b[0]).map(([margin, probability]) => ({ margin, probability }));
  const tipCode = leader(probabilities);
  return { version: VERSION, market: 'HHAD', period: 'REGULATION_90', line: h, tipCode,
    probabilities, hadProbabilities: had, primaryTipCode, primaryProbability, conditionalOnPrimary,
    conditionalTipCode: conditionalOnPrimary ? leader(conditionalOnPrimary) : null,
    marginDistribution, conditions: { homeWinMinimumMargin: exactMargin + 1, drawExactMargin: exactMargin, awayWinMaximumMargin: exactMargin - 1 },
    method: scoreRows ? 'complete-score-shape-aligned-to-published-had' : 'poisson-margin-shape-aligned-to-published-had',
    sourceTailBound: shape.tailBound, projectedTailBound, modelValidation: 'unvalidated',
    // Price and expected return are not inferred from a normal-HAD quote.
    odds: null, comboEligible: false };
}
module.exports = { VERSION, CODES, finite, integerLine, outcome, settledHandicap, vector, leader, poissonShape, analyzeHandicap };
