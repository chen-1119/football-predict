const { buildResultProvenance } = require("../src/services/matchLifecycle.cjs");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const { createHash } = require("node:crypto");

const timeMs = (value) => {
  const parsed = Date.parse(strictInstant(value) || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const matchIdentity = (match) => String(
  match?.sourceMatchId
  || match?.id
  || `${match?.kickoffTime || "missing-kickoff"}:${match?.homeTeamName || match?.homeTeam || ""}:${match?.awayTeamName || match?.awayTeam || ""}`
);

const forecastTimeForMatch = (match) => {
  const kickoffMs = timeMs(match?.kickoffTime || match?.matchDate);
  if (kickoffMs === null) return null;
  for (const value of [
    match?.predictionMeta?.generatedAt,
    match?.predictionMeta?.lockedAt,
    match?.predictionMeta?.cutoffTime,
    match?.buyEndTime,
  ]) {
    const candidate = timeMs(value);
    // A declared malformed decision clock cannot fall through to a later
    // deadline/kickoff and thereby learn results not known at the decision.
    if (value !== undefined && value !== null && value !== "" && candidate === null) return null;
    if (candidate !== null && candidate <= kickoffMs) return candidate;
  }
  return kickoffMs;
};

const resultObservationForMatch = (match) => {
  const kickoffMs = timeMs(match?.kickoffTime || match?.matchDate);
  if (kickoffMs === null) return null;
  const provenance = buildResultProvenance(match);
  const declaredFallback = match?.resultObservationFallback === true
    || match?.resultProvenance?.resultObservationFallback === true
    || match?.resultMeta?.observationFallback === true;
  const observedMs = timeMs(provenance?.observedAt);
  if (provenance?.promotionEligible === true && observedMs !== null) {
    return {
      observedMs,
      observedAt: new Date(observedMs).toISOString(),
      source: provenance.observationSource,
      sourceInferred: provenance.observationSourceInferred === true,
      fallback: false,
      promotionEligible: true,
    };
  }
  const failureSource = !provenance
    ? "official-result-invalid"
    : declaredFallback
      ? "declared-result-observation-fallback"
      : !provenance.eventVersionConsistent
        ? "result-event-version-mismatch-or-missing"
        : !provenance.observedAt
          ? "missing-result-observation-time"
          : !provenance.observationSource
            ? "missing-result-observation-source"
            : !provenance.observationAfterKickoff
              ? "result-observation-before-kickoff"
              : "result-observation-not-promotion-eligible";
  return {
    observedMs: null,
    observedAt: null,
    source: failureSource,
    fallback: true,
    promotionEligible: false,
  };
};

const hasSettledScore = (match) => (
  String(match?.status || "").toUpperCase() === "FINISHED"
  && Number.isFinite(Number(match?.scoreHome))
  && Number.isFinite(Number(match?.scoreAway))
);

/**
 * Visit forecasts in chronological as-of order. A result is delivered to the
 * model state only after its official observation time is no later than the
 * next forecast. This prevents an earlier kickoff whose result arrived later
 * (or a simultaneous kickoff) from leaking into another pre-match forecast.
 */
const forEachForecastAsOf = (matches, {
  onResult,
  onForecast,
  forecastTimeFor = forecastTimeForMatch,
  resultObservationFor = resultObservationForMatch,
} = {}) => {
  if (typeof onForecast !== "function") throw new TypeError("onForecast callback is required");
  if (typeof onResult !== "function") throw new TypeError("onResult callback is required");

  const forecasts = (Array.isArray(matches) ? matches : [])
    .map((match) => ({ match, atMs: forecastTimeFor(match) }))
    .filter((event) => event.atMs !== null)
    .sort((a, b) => a.atMs - b.atMs || matchIdentity(a.match).localeCompare(matchIdentity(b.match)));
  const settledResults = (Array.isArray(matches) ? matches : []).filter(hasSettledScore);
  const observedResults = settledResults
    .map((match) => ({ match, observation: resultObservationFor(match) }));
  const results = observedResults
    .filter((event) => Number.isFinite(event.observation?.observedMs) && event.observation?.fallback !== true)
    .sort((a, b) => (
      a.observation.observedMs - b.observation.observedMs
      || matchIdentity(a.match).localeCompare(matchIdentity(b.match))
    ));

  let resultIndex = 0;
  let appliedResults = 0;
  let fallbackResults = 0;
  for (const forecast of forecasts) {
    while (
      resultIndex < results.length
      && results[resultIndex].observation.observedMs <= forecast.atMs
    ) {
      const event = results[resultIndex];
      onResult(event.match, {
        forecastAt: new Date(forecast.atMs).toISOString(),
        ...event.observation,
      });
      appliedResults += 1;
      if (event.observation.fallback) fallbackResults += 1;
      resultIndex += 1;
    }
    onForecast(forecast.match, {
      forecastMs: forecast.atMs,
      forecastAt: new Date(forecast.atMs).toISOString(),
      appliedResults,
    });
  }

  return {
    version: "as-of-result-timeline-v2",
    forecasts: forecasts.length,
    resultEvents: results.length,
    settledResults: settledResults.length,
    unobservedResults: observedResults.filter((event) => !Number.isFinite(event.observation?.observedMs)).length,
    appliedResults,
    unappliedResults: results.length - resultIndex,
    fallbackResults,
    policy: "results enter model state only when an attributed non-fallback resultObservedAt <= forecastAt; missing or fallback observation times are excluded",
  };
};

// Bind this input-admission policy independently of probability arithmetic.
// A changed timeline must start a new candidate revision, not mix cohorts.
const resultTimelineSemanticHash = () => createHash("sha256").update(JSON.stringify({
  version: "result-input-timeline-commitment-v1",
  functions: [strictInstant, timeMs, forecastTimeForMatch, resultObservationForMatch, forEachForecastAsOf, buildResultProvenance]
    .map(fn => fn.toString().replace(/\r\n?/gu, "\n")),
})).digest("hex");

module.exports = {
  resultTimelineSemanticHash,
  forEachForecastAsOf,
  forecastTimeForMatch,
  hasSettledScore,
  matchIdentity,
  resultObservationForMatch,
  timeMs,
};
