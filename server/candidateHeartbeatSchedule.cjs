const finiteNonNegative = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const candidateHeartbeatPreemptivePolicy = ({
  freshnessLimitMs = 120_000,
  attemptTimeoutMs = 45_000,
  retryMs = 5_000,
  recoveryCaptureMs = attemptTimeoutMs,
  safetyMarginMs = 10_000,
  minimumRefreshAgeMs = 1_000,
} = {}) => {
  const freshness = Math.max(1_000, finiteNonNegative(freshnessLimitMs, 120_000));
  const attempt = Math.max(1, finiteNonNegative(attemptTimeoutMs, 45_000));
  const retry = Math.max(0, finiteNonNegative(retryMs, 5_000));
  const recovery = Math.max(1, finiteNonNegative(recoveryCaptureMs, attempt));
  const safety = Math.max(0, finiteNonNegative(safetyMarginMs, 10_000));
  const minimumAge = Math.max(0, finiteNonNegative(minimumRefreshAgeMs, 1_000));
  const requiredReserveMs = attempt + retry + recovery + safety;
  const refreshAgeMs = Math.max(minimumAge, freshness - requiredReserveMs);
  const projectedWorstCaseCompletionAgeMs = refreshAgeMs + attempt + retry + recovery;
  return {
    version: "candidate-heartbeat-preemptive-schedule-v1",
    freshnessLimitMs: freshness,
    attemptTimeoutMs: attempt,
    retryMs: retry,
    recoveryCaptureMs: recovery,
    safetyMarginMs: safety,
    requiredReserveMs,
    refreshAgeMs,
    projectedWorstCaseCompletionAgeMs,
    budgetFits: projectedWorstCaseCompletionAgeMs <= freshness - safety,
  };
};

const candidateHeartbeatPreemptiveSchedule = ({
  evaluatedAt = null,
  nowMs = Date.now(),
  ...policyOptions
} = {}) => {
  const policy = candidateHeartbeatPreemptivePolicy(policyOptions);
  const observedNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const evaluatedAtMs = Date.parse(evaluatedAt || "");
  const dueAtMs = Number.isFinite(evaluatedAtMs)
    ? evaluatedAtMs + policy.refreshAgeMs
    : observedNowMs;
  return {
    ...policy,
    evaluatedAt: Number.isFinite(evaluatedAtMs)
      ? new Date(evaluatedAtMs).toISOString()
      : null,
    dueAt: new Date(dueAtMs).toISOString(),
    delayMs: Math.max(0, dueAtMs - observedNowMs),
    due: dueAtMs <= observedNowMs,
  };
};

const candidateHeartbeatAttemptBudget = ({
  evaluatedAt = null,
  nowMs = Date.now(),
  recoveryAttempt = false,
  minimumAttemptMs = 1_000,
  ...policyOptions
} = {}) => {
  const schedule = candidateHeartbeatPreemptiveSchedule({
    evaluatedAt,
    nowMs,
    ...policyOptions,
  });
  const observedNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const evaluatedAtMs = Date.parse(evaluatedAt || "");
  const heartbeatAgeMs = Number.isFinite(evaluatedAtMs)
    ? Math.max(0, observedNowMs - evaluatedAtMs)
    : 0;
  const minimum = Math.max(1, finiteNonNegative(minimumAttemptMs, 1_000));
  const primaryBudgetMs = Math.max(
    minimum,
    schedule.freshnessLimitMs
      - heartbeatAgeMs
      - schedule.retryMs
      - schedule.recoveryCaptureMs
      - schedule.safetyMarginMs,
  );
  const timeoutMs = recoveryAttempt
    ? schedule.recoveryCaptureMs
    : Math.min(schedule.attemptTimeoutMs, primaryBudgetMs);
  const projectedCompletionAgeMs = recoveryAttempt
    ? heartbeatAgeMs + timeoutMs
    : heartbeatAgeMs + timeoutMs + schedule.retryMs + schedule.recoveryCaptureMs;
  return {
    version: "candidate-heartbeat-attempt-budget-v1",
    recoveryAttempt: recoveryAttempt === true,
    heartbeatAgeMs,
    timeoutMs,
    projectedCompletionAgeMs,
    budgetFits:
      projectedCompletionAgeMs
      <= schedule.freshnessLimitMs - schedule.safetyMarginMs,
    schedule,
  };
};

const candidateHeartbeatNextAttempt = ({
  evaluatedAt = null,
  attempt = null,
  nowMs = Date.now(),
  ...policyOptions
} = {}) => {
  const evaluatedAtMs = Date.parse(evaluatedAt || "");
  const attemptFinishedAtMs = Date.parse(
    attempt?.finishedAt || attempt?.startedAt || "",
  );
  const attemptAppliesToHeartbeat = Number.isFinite(attemptFinishedAtMs)
    && (
      !Number.isFinite(evaluatedAtMs)
      || attemptFinishedAtMs >= evaluatedAtMs
    );
  const recoveryAttempt = Boolean(
    attemptAppliesToHeartbeat
    && attempt?.statusAdvanced === false,
  );
  const budget = candidateHeartbeatAttemptBudget({
    evaluatedAt,
    nowMs,
    recoveryAttempt,
    ...policyOptions,
  });
  return {
    ...budget,
    attemptType: recoveryAttempt
      ? "preemptive-recovery"
      : "preemptive-primary",
  };
};

module.exports = {
  candidateHeartbeatAttemptBudget,
  candidateHeartbeatNextAttempt,
  candidateHeartbeatPreemptivePolicy,
  candidateHeartbeatPreemptiveSchedule,
};
