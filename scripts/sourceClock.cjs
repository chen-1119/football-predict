'use strict';
const { instant } = require('../collectors/market/policy.cjs');
// Python export receipts contain microseconds. Compare at JS millisecond precision
// while preserving the original string in evidence; keep the existing strict date checks.
function sourceInstant(value) {
  const normalized = typeof value === 'string'
    ? value.replace(/\.(\d{4,9})(Z|[+-]\d{2}:\d{2})$/, (_, fraction, zone) => '.' + fraction.slice(0, 3) + zone)
    : value;
  return instant(normalized);
}
module.exports = { sourceInstant };
