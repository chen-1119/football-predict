'use strict';

// Missing observations are unknown, not zero days/points/goals.
function observedNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formNeedPressureFromSnapshot(form) {
  const samples = observedNumber(form?.sampleSize);
  if (!Number.isSafeInteger(samples) || samples < 3) return 0;
  const ppg = observedNumber(form.pointsPerMatch);
  const goalDiff = observedNumber(form.goalDiffAvg);
  const restDays = observedNumber(form.restDays);
  let pressure = 0;
  if (ppg !== null && ppg >= 0 && ppg <= 3) {
    if (ppg < 0.95) pressure += 5;
    else if (ppg < 1.25) pressure += 3;
    else if (ppg > 2.05) pressure -= 2;
  }
  if (goalDiff !== null) {
    if (goalDiff < -0.55) pressure += 3;
    else if (goalDiff > 0.85) pressure -= 1;
  }
  if (restDays !== null && restDays >= 0 && restDays <= 3) pressure += 2;
  return Math.max(-4, Math.min(10, pressure));
}

module.exports = { observedNumber, formNeedPressureFromSnapshot };
