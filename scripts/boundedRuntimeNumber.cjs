"use strict";

const finiteNumber = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const boundedRuntimeNumber = (value, options = {}) => {
  const fallback = finiteNumber(options.fallback);
  if (fallback === null) throw new TypeError("bounded runtime number requires a finite fallback");
  const min = finiteNumber(options.min);
  const max = finiteNumber(options.max);
  if (min !== null && max !== null && min > max) {
    throw new RangeError("bounded runtime number min exceeds max");
  }
  let resolved = finiteNumber(value);
  if (resolved === null) resolved = fallback;
  if (min !== null) resolved = Math.max(min, resolved);
  if (max !== null) resolved = Math.min(max, resolved);
  return options.integer === true ? Math.floor(resolved) : resolved;
};

const boundedRuntimeEnv = (env, names, options = {}) => {
  const keys = Array.isArray(names) ? names : [names];
  let value = null;
  for (const key of keys) {
    const candidate = finiteNumber(env?.[key]);
    if (candidate !== null) {
      value = candidate;
      break;
    }
  }
  return boundedRuntimeNumber(value, options);
};

module.exports = {
  boundedRuntimeEnv,
  boundedRuntimeNumber,
  finiteNumber,
};
