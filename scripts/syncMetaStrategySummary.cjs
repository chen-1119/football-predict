"use strict";

// Full strategy evidence remains in model-strategy.json. Metadata carries only
// the fields used by health and public status readers, without coercing gates.
const pick = (value, keys) => Object.fromEntries(keys
  .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
  .map((key) => [key, value[key]]));
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function summarizeStrategyForSyncMeta(strategy) {
  if (!record(strategy)) return strategy;
  const summary = pick(strategy, ["version", "generatedAt", "activation", "sample", "activeGates"]);
  if (!record(summary.activation)) return summary;
  summary.activation = { ...summary.activation };
  const gate = summary.activation.promotionGate;
  if (!record(gate)) return summary;
  const nextGate = pick(gate, ["version", "status", "onlineEffect", "eligibleScope", "checkedAt",
    "sourceEvaluationVersion", "thresholds", "sample", "metrics", "modelSignal", "riskGuard", "reasons", "policy"]);
  if (record(gate.metrics)) nextGate.metrics = pick(gate.metrics, ["logLossImprovement", "brierImprovement",
    "accuracyDelta", "rollingPassRate", "rollingSource", "currentModelLogLossImprovement",
    "currentModelBrierImprovement", "bestModelLogLossImprovement", "bestModelBrierImprovement", "bestModelRollingPassRate"]);
  if (record(gate.modelSignal)) nextGate.modelSignal = pick(gate.modelSignal,
    ["status", "onlineEffect", "readyForGuardedUse", "rollingSource", "policy"]);
  summary.activation.promotionGate = nextGate;
  return summary;
}

module.exports = { summarizeStrategyForSyncMeta };
