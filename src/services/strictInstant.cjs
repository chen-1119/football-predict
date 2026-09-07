"use strict";

// Exact zoned source clocks only. Validate calendar fields before Date.parse
// can silently normalize an impossible day or 24:00 into a different instant.
function strictInstant(value) {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = [parts[1], parts[2], parts[3], parts[4], parts[5], parts[6] || "0"].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  if (parts[8] !== "Z" && (Number(parts[8].slice(1, 3)) > 23 || Number(parts[8].slice(4, 6)) > 59)) return null;
  // Keep original valid bytes: changing signed clock representation breaks
  // content receipts. Consumers needing canonical UTC do that explicitly.
  return Number.isFinite(Date.parse(value)) ? value : null;
}

module.exports = { strictInstant };
