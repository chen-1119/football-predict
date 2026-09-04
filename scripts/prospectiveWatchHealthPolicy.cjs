"use strict";

const nonNegativeInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
};

const instant = (value, fallback = null) => {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
};

const blockersOf = (value) => [...new Set(
  (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean),
)].sort();

const cleanWatchHealthState = (value = {}) => ({
  version: "candidate-prospective-watch-health-v1",
  polls: nonNegativeInteger(value.polls),
  healthyPolls: nonNegativeInteger(value.healthyPolls),
  unhealthyPolls: nonNegativeInteger(value.unhealthyPolls),
  consecutiveUnhealthyPolls: nonNegativeInteger(
    value.consecutiveUnhealthyPolls,
  ),
  recoveries: nonNegativeInteger(value.recoveries),
  unhealthySince: instant(value.unhealthySince),
  lastHealthyAt: instant(value.lastHealthyAt),
  lastUnhealthyAt: instant(value.lastUnhealthyAt),
  lastSeverity: [
    "healthy",
    "transient",
    "critical",
    "fatal",
  ].includes(value.lastSeverity)
    ? value.lastSeverity
    : null,
  lastBlockers: blockersOf(value.lastBlockers),
  lastCandidateState: String(value.lastCandidateState || "").trim() || null,
  lastChainValid: typeof value.lastChainValid === "boolean"
    ? value.lastChainValid
    : null,
  shouldExit: value.shouldExit === true,
});

const advanceWatchHealthState = (previous, observation = {}) => {
  const state = cleanWatchHealthState(previous);
  const checkedAt = instant(observation.checkedAt, new Date().toISOString());
  const blockers = blockersOf(observation.operationalBlockers);
  const candidateState = String(observation.candidateState || "").trim() || null;
  const chainValid = observation.chainValid === true;
  const continuityViolation = String(
    observation.continuityViolation || "",
  ).trim() || null;
  const healthy = observation.healthy === true && blockers.length === 0;
  const staleHeartbeatOnly = (
    !healthy
    && blockers.length === 1
    && blockers[0] === "candidate-capture-heartbeat-unhealthy"
    && candidateState === "ACTIVE"
    && chainValid
    && observation.heartbeatSkipped !== true
  );
  const severity = continuityViolation
    ? "fatal"
    : healthy
      ? "healthy"
      : staleHeartbeatOnly
        ? "transient"
        : "critical";
  const consecutiveUnhealthyPolls = healthy
    ? 0
    : state.consecutiveUnhealthyPolls + 1;
  const recovered = healthy && state.consecutiveUnhealthyPolls > 0;

  return {
    version: "candidate-prospective-watch-health-v1",
    polls: state.polls + 1,
    healthyPolls: state.healthyPolls + (healthy ? 1 : 0),
    unhealthyPolls: state.unhealthyPolls + (healthy ? 0 : 1),
    consecutiveUnhealthyPolls,
    recoveries: state.recoveries + (recovered ? 1 : 0),
    unhealthySince: healthy
      ? null
      : state.consecutiveUnhealthyPolls > 0
        ? state.unhealthySince || checkedAt
        : checkedAt,
    lastHealthyAt: healthy ? checkedAt : state.lastHealthyAt,
    lastUnhealthyAt: healthy ? state.lastUnhealthyAt : checkedAt,
    lastSeverity: severity,
    lastBlockers: blockers,
    lastCandidateState: candidateState,
    lastChainValid: observation.chainValid === true
      ? true
      : observation.chainValid === false
        ? false
        : null,
    shouldExit: Boolean(continuityViolation),
    keepRunning: !continuityViolation,
    continuityViolation,
    classification: healthy
      ? "healthy"
      : staleHeartbeatOnly
        ? "release-or-freshness-transient"
        : continuityViolation
          ? "ledger-continuity-failure"
          : "operational-unhealthy",
  };
};

module.exports = {
  advanceWatchHealthState,
  cleanWatchHealthState,
};
