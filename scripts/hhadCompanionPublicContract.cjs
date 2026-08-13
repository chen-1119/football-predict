const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasOnlyKeys = (value, allowed) => isObject(value)
  && Object.keys(value).every((key) => allowed.has(key));
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const isNullableFinite = (value) => value === null || (typeof value === "number" && Number.isFinite(value));

const countKeys = new Set([
  "snapshotRows",
  "trackRows",
  "currentStrategyRows",
  "finalRevisions",
  "finalEvaluate",
  "finalSkip",
  "exactReplayFinals",
  "nonExactReplayFinals",
  "missingOfficialResults",
  "resultConflicts",
  "settledWon",
  "settledLost",
  "settledVoid",
  "pairedNonVoidRows",
  "pairedMatchDays",
  "promotionTimeEligibleSettlements",
  "promotionTimeIneligibleSettlements",
  "ambiguousFinalRevisionGroups",
  "resultEventMismatches",
  "resultTimeRejected"
]);

const metricPairValid = (value) => value === null || (
  hasOnlyKeys(value, new Set(["brier", "logLoss"]))
  && isNullableFinite(value.brier)
  && isNullableFinite(value.logLoss)
);

const publicHhadCompanionSchemaValid = (value) => {
  if (!hasOnlyKeys(value, new Set([
    "version",
    "strategyVersion",
    "evaluatedAt",
    "onlineEffect",
    "candidateReady",
    "candidateStatus",
    "promotionAllowed",
    "counts",
    "exactReplay",
    "pairedThreeWay",
    "descriptive",
    "windows",
    "bootstrap",
    "gate",
    "policy",
    "publicView",
    "hiddenFields"
  ]))) return false;
  if (typeof value.version !== "string"
    || value.publicView !== true
    || value.onlineEffect !== "shadow"
    || value.promotionAllowed !== false
    || typeof value.candidateReady !== "boolean"
    || !["shadow-collecting", "gate-not-passed", "manual-review"].includes(value.candidateStatus)) return false;

  if (!hasOnlyKeys(value.counts, countKeys)
    || !Object.prototype.hasOwnProperty.call(value.counts, "pairedNonVoidRows")
    || !Object.values(value.counts).every(isNonNegativeInteger)
    || !isNonNegativeInteger(value.counts.pairedNonVoidRows)) return false;

  if (value.exactReplay !== null && (!hasOnlyKeys(value.exactReplay, new Set(["finals", "exact", "rate", "requiredRate"]))
    || !isNonNegativeInteger(value.exactReplay.finals)
    || !isNonNegativeInteger(value.exactReplay.exact)
    || !isNullableFinite(value.exactReplay.rate)
    || !isNullableFinite(value.exactReplay.requiredRate))) return false;

  if (value.pairedThreeWay !== null && (!hasOnlyKeys(value.pairedThreeWay, new Set([
    "rows", "model", "deviggedMarket", "improvement", "interpretation"
  ]))
    || !isNonNegativeInteger(value.pairedThreeWay.rows)
    || !metricPairValid(value.pairedThreeWay.model)
    || !metricPairValid(value.pairedThreeWay.deviggedMarket)
    || !metricPairValid(value.pairedThreeWay.improvement)
    || (value.pairedThreeWay.interpretation !== null && typeof value.pairedThreeWay.interpretation !== "string"))) return false;

  if (value.descriptive !== null && (!hasOnlyKeys(value.descriptive, new Set([
    "settled", "won", "lost", "hitRate", "profitUnits", "roi", "averageOdds", "gateUsage"
  ]))
    || !isNonNegativeInteger(value.descriptive.settled)
    || !isNonNegativeInteger(value.descriptive.won)
    || !isNonNegativeInteger(value.descriptive.lost)
    || ![value.descriptive.hitRate, value.descriptive.profitUnits, value.descriptive.roi, value.descriptive.averageOdds].every(isNullableFinite)
    || (value.descriptive.gateUsage !== null && typeof value.descriptive.gateUsage !== "string"))) return false;

  if (!hasOnlyKeys(value.windows, new Set(["type", "count", "improvingBothMetrics", "recentTwoNonNegative", "rows"]))
    || !isNonNegativeInteger(value.windows.count)
    || !isNonNegativeInteger(value.windows.improvingBothMetrics)
    || typeof value.windows.recentTwoNonNegative !== "boolean"
    || !Array.isArray(value.windows.rows)
    || !value.windows.rows.every((row) => hasOnlyKeys(row, new Set([
      "index", "startMatchDay", "endMatchDay", "matchDays", "rows", "improvement"
    ]))
      && isNonNegativeInteger(row.index)
      && isNonNegativeInteger(row.matchDays)
      && isNonNegativeInteger(row.rows)
      && metricPairValid(row.improvement))) return false;

  if (value.bootstrap !== null && (!hasOnlyKeys(value.bootstrap, new Set([
    "method", "confidence", "percentileLowerProbability", "iterations", "matchDays", "rows", "lowerBounds"
  ]))
    || !isNonNegativeInteger(value.bootstrap.iterations)
    || !isNonNegativeInteger(value.bootstrap.matchDays)
    || !isNonNegativeInteger(value.bootstrap.rows)
    || !isNullableFinite(value.bootstrap.confidence)
    || !isNullableFinite(value.bootstrap.percentileLowerProbability)
    || (value.bootstrap.lowerBounds !== null && (!hasOnlyKeys(value.bootstrap.lowerBounds, new Set([
      "brierImprovement", "logLossImprovement"
    ]))
      || !isNullableFinite(value.bootstrap.lowerBounds.brierImprovement)
      || !isNullableFinite(value.bootstrap.lowerBounds.logLossImprovement))))) return false;

  const thresholdKeys = new Set([
    "minimumPairedNonVoidRows",
    "windows",
    "minimumRowsPerWindow",
    "minimumImprovingWindows",
    "recentNonNegativeWindows",
    "minimumMatchDays",
    "bootstrapConfidence",
    "exactReplayRate",
    "requiredGlobalRiskTier",
    "onlineEffect"
  ]);
  if (!hasOnlyKeys(value.gate, new Set(["version", "candidateReady", "thresholds", "failedChecks", "interpretation"]))
    || typeof value.gate.candidateReady !== "boolean"
    || !hasOnlyKeys(value.gate.thresholds, thresholdKeys)
    || value.gate.thresholds.onlineEffect !== "shadow"
    || !isNonNegativeInteger(value.gate.thresholds.minimumPairedNonVoidRows)
    || !Array.isArray(value.gate.failedChecks)
    || !value.gate.failedChecks.every((item) => typeof item === "string")) return false;

  if (!hasOnlyKeys(value.policy, new Set(["scoring", "descriptiveOnly", "onlineEffect"]))
    || value.policy.onlineEffect !== "shadow"
    || !Array.isArray(value.policy.descriptiveOnly)
    || !value.policy.descriptiveOnly.every((item) => typeof item === "string")
    || !Array.isArray(value.hiddenFields)
    || !value.hiddenFields.every((item) => typeof item === "string")) return false;

  return true;
};

const findHhadCompanionSensitiveKeyLeaks = (value, location = "$", leaks = []) => {
  if (leaks.length >= 24) return leaks;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findHhadCompanionSensitiveKeyLeaks(item, `${location}[${index}]`, leaks));
    return leaks;
  }
  if (!isObject(value)) return leaks;
  Object.entries(value).forEach(([key, nested]) => {
    const nextLocation = `${location}.${key}`;
    if (/hash/i.test(key) || new Set([
      "finalExposureRows",
      "settlementRows",
      "rowLevelDirections",
      "finalBlockerCounts",
      "promotionTimeBlockerCounts"
    ]).has(key)) {
      leaks.push(nextLocation);
    }
    findHhadCompanionSensitiveKeyLeaks(nested, nextLocation, leaks);
  });
  return leaks;
};

module.exports = {
  publicHhadCompanionSchemaValid,
  findHhadCompanionSensitiveKeyLeaks,
  isNonNegativeInteger
};
