"use strict";

// Validate the deployable plan. This is not a readback of live cloud settings.
const validateCostPolicy = (config) => {
  const fail = (message) => { throw new Error(`Huawei collector cost policy: ${message}`); };
  if (!Number.isInteger(config.memoryMb) || config.memoryMb < 128 || config.memoryMb > 256) fail("memory must be 128-256 MB");
  if (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 40 || config.timeoutSeconds > 60) fail("timeout must be 40-60 seconds");
  if (config.timer?.rule !== "@every 5m" || config.timer?.enabled !== true) fail("requires one five-minute timer");
  if (config.maxInstances !== 1 || config.reservedInstances !== 0) fail("requires one on-demand instance, no reserved instances");
  if (config.async?.maxRetries !== 0 || config.async?.maxEventAgeSeconds !== 60) fail("automatic retries must be disabled and event age limited to 60 seconds");
  const policy = config.costPolicy;
  if (policy?.planningDays !== 31 || policy?.extraInvocationsAllowance !== 100
    || policy?.singleTimerOnly !== true || policy?.paidServicesEnabled !== false) fail("unexpected monthly planning assumptions");
  if (policy?.monthlyFreeGbSeconds !== 400000 || policy?.monthlyFreeRequests !== 1000000
    || policy?.plannedGbSecondsLimit !== 150000) fail("unexpected free quota or planning limit");
  const scheduledInvocations = 31 * 24 * 12;
  const plannedInvocations = scheduledInvocations + policy.extraInvocationsAllowance;
  const executionGbSeconds = plannedInvocations * config.memoryMb / 1024 * config.timeoutSeconds;
  if (executionGbSeconds > policy.plannedGbSecondsLimit) fail("worst-case execution exceeds planning limit");
  return {
    verifiedScope: "local-deployment-plan-only",
    scheduledInvocations,
    extraInvocationsAllowance: policy.extraInvocationsAllowance,
    worstCaseExecutionGbSeconds: executionGbSeconds,
    freeQuotaGbSeconds: policy.monthlyFreeGbSeconds,
    freeQuotaRemainingGbSeconds: policy.monthlyFreeGbSeconds - executionGbSeconds,
    estimatedExecutionCnyWithFullFreeQuota: 0,
    assumptions: ["one timer only", "no retries", "no reserved instances", "no other functions consuming shared free quota", "no additional paid services", "live settings must be read back after deployment"],
  };
};

module.exports = { validateCostPolicy };
if (require.main === module) {
  console.log(JSON.stringify(validateCostPolicy(require("../deploy/huawei-functiongraph/function-config.json")), null, 2));
}
