const REQUIRED_LATENCY_RECOVERY_RUNS = 2;
const MAX_LATENCY_RECOVERY_ATTEMPTS = 3;

const failureReasonsOf = (run) => (
  Array.isArray(run?.body?.failureReasons)
    ? run.body.failureReasons.map((reason) => String(reason))
    : []
);

const performanceRunPassed = (run) => (
  Number(run?.status) === 0
  && run?.body?.ok === true
);

const isLatencyOnlyPerformanceFailure = (run) => {
  if (performanceRunPassed(run)) return false;
  const reasons = failureReasonsOf(run);
  return reasons.length > 0
    && reasons.every((reason) => /^measured:[^:]+:p95:[^>]+>[^>]+$/.test(reason));
};

const evaluatePerformanceRecovery = ({
  initialRun,
  recoveryRuns = [],
  requiredRuns = REQUIRED_LATENCY_RECOVERY_RUNS,
  maxAttempts = MAX_LATENCY_RECOVERY_ATTEMPTS
} = {}) => {
  const required = Math.max(REQUIRED_LATENCY_RECOVERY_RUNS, Number(requiredRuns) || 0);
  const maximum = Math.max(required, Number(maxAttempts) || 0);
  const initialPassed = performanceRunPassed(initialRun);
  const latencyOnly = isLatencyOnlyPerformanceFailure(initialRun);
  const consideredRuns = Array.isArray(recoveryRuns)
    ? recoveryRuns.slice(0, maximum)
    : [];
  const nonLatencyRecoveryFailure = consideredRuns.some((run) => (
    !performanceRunPassed(run) && !isLatencyOnlyPerformanceFailure(run)
  ));
  let consecutivePassingRuns = 0;
  let maximumConsecutivePassingRuns = 0;
  for (const run of consideredRuns) {
    consecutivePassingRuns = performanceRunPassed(run)
      ? consecutivePassingRuns + 1
      : 0;
    maximumConsecutivePassingRuns = Math.max(
      maximumConsecutivePassingRuns,
      consecutivePassingRuns,
    );
  }
  const recoveryPassed = !nonLatencyRecoveryFailure
    && maximumConsecutivePassingRuns >= required;
  const recoveryComplete = recoveryPassed || consideredRuns.length >= maximum;

  return {
    ok: initialPassed || (latencyOnly && recoveryPassed),
    initialPassed,
    latencyOnly,
    recovered: !initialPassed && latencyOnly && recoveryPassed,
    requiredRuns: required,
    maxAttempts: maximum,
    completedRuns: consideredRuns.length,
    maximumConsecutivePassingRuns,
    nonLatencyRecoveryFailure,
    recoveryComplete,
    recoveryPassed,
    initialFailureReasons: failureReasonsOf(initialRun),
    recoveryFailureReasons: consideredRuns.map((run) => failureReasonsOf(run))
  };
};

module.exports = {
  MAX_LATENCY_RECOVERY_ATTEMPTS,
  REQUIRED_LATENCY_RECOVERY_RUNS,
  evaluatePerformanceRecovery,
  failureReasonsOf,
  isLatencyOnlyPerformanceFailure,
  performanceRunPassed
};
