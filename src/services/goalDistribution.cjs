'use strict';

// Numerical support is determined by remaining mass, not by a football score
// quota. The upper bound protects against malformed rates; it is not a prior.
const MAX_LAMBDA = 12;
const TAIL_TOLERANCE = 1e-12;
function poissonSupport(lambda) {
  if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0 || lambda > MAX_LAMBDA) return null;
  const values = [Math.exp(-lambda)];
  let mass = values[0];
  for (let k = 1; k <= 80 && (k <= lambda || 1 - mass > TAIL_TOLERANCE); k++) {
    values.push(values[k - 1] * lambda / k);
    mass += values[k];
  }
  return { values, mass, tailMass: Math.max(0, 1 - mass) };
}
function scoreMatrix(homeLambda, awayLambda) {
  const home = poissonSupport(homeLambda), away = poissonSupport(awayLambda);
  if (!home || !away) return [];
  return home.values.flatMap((h, i) => away.values.map((a, j) => ({home:i, away:j, probability:h*a})));
}
module.exports = { MAX_LAMBDA, TAIL_TOLERANCE, poissonSupport, scoreMatrix };
