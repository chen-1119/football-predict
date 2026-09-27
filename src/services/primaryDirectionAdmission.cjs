'use strict';

// A new, explicitly frozen admission policy, not a change to model probabilities.
// Legacy decisions without this field retain their original quality rules.
const VERSION = 'verified-unique-primary-v1';
const EPSILON = 1e-9;
const CODES = Object.freeze(['1', 'X', '2']);

function validTriplet(p) {
  return Boolean(p && typeof p === 'object' && !Array.isArray(p)
    && CODES.every(code => typeof p[code] === 'number' && Number.isFinite(p[code]) && p[code] >= 0 && p[code] <= 1)
    && Math.abs(CODES.reduce((sum, code) => sum + p[code], 0) - 1) <= 1e-6);
}
function uniquePrimary(p) {
  if (!validTriplet(p)) return null;
  return CODES.find(code => CODES.every(other => code === other || p[code] - p[other] > EPSILON)) || null;
}
function leaderReasons({probabilityLead, primaryAdmissionVersion} = {}) {
  if (primaryAdmissionVersion !== VERSION) return null; // Delegate legacy policy.
  return typeof probabilityLead === 'number' && Number.isFinite(probabilityLead) && probabilityLead > EPSILON
    ? [] : ['no-unique-model-leader'];
}
module.exports = {VERSION, EPSILON, CODES, validTriplet, uniquePrimary, leaderReasons};
