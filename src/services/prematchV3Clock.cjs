'use strict';
const {strictInstant} = require('./strictInstant.cjs');
// Preserve submillisecond knowledge boundaries; Date.parse alone loses them.
function epochNanoseconds(value) {
  if (!strictInstant(value)) return null;
  const fraction = /\.(\d{1,9})(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || '';
  const whole = value.replace(/\.\d{1,9}(?=Z|[+-]\d{2}:\d{2}$)/, '');
  return BigInt(Date.parse(whole)) * 1000000n + BigInt(fraction.padEnd(9, '0') || '0');
}
module.exports = {epochNanoseconds};
