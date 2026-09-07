'use strict';

// Operational scheduling only. Never write the content-addressed snapshot or its
// successful checkedAt. A skipped failed source must remain visibly degraded.
const VERSION = 'football-data-fixture-retry-v1';
const SCRIPT = 'sync:football-data-fixtures';
const BASE_RETRY_MS = 30 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const canonicalMs = value => {
  if (typeof value !== 'string') return null;
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString() === value ? n : null;
};
function validAttempt(value, nowMs) {
  if (!value || value.version !== VERSION || value.script !== SCRIPT
      || !['running','failed','succeeded'].includes(value.state)
      || !Number.isSafeInteger(value.failures) || value.failures < 0 || value.failures > 1000) return false;
  const started = canonicalMs(value.startedAt), completed = canonicalMs(value.completedAt);
  if (started === null || started > nowMs) return false;
  if (value.state === 'running') return value.completedAt === null && value.nextAttemptAt === new Date(started + BASE_RETRY_MS).toISOString();
  if (completed === null || completed < started || completed > nowMs) return false;
  if (value.state === 'succeeded') return value.failures === 0 && value.nextAttemptAt === null;
  if (value.failures < 1) return false;
  const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(10,value.failures - 1));
  return value.nextAttemptAt === new Date(completed + delay).toISOString();
}
const failureResult = (reason, nextAttemptAt, errorCode = null) => ({
  ok:false, skipped:true, fatal:false, script:SCRIPT, reason,
  error:`Supplementary fixtures unavailable (${reason}); last valid snapshot preserved${nextAttemptAt ? `; next attempt ${nextAttemptAt}` : ''}`,
  retry:{ version:VERSION, nextAttemptAt:nextAttemptAt || null, errorCode, sourceRecovered:false },
});

async function runFootballDataFixtureRetry({ enabled, checkedAt, minIntervalMs, attemptFile, read, write, run, clock = Date.now }) {
  const nowMs = clock();
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < BASE_RETRY_MS) throw new TypeError('invalid fixtures scheduling clock/interval');
  if (!enabled) return {ok:true, skipped:true, script:SCRIPT, reason:'disabled'};
  const prior = read(attemptFile, null);
  const valid = validAttempt(prior,nowMs);
  // Malformed state never becomes a future indefinite cooldown. It remains
  // diagnostic metadata, not source evidence; retry is allowed after repair.
  const lastSuccessMs = canonicalMs(checkedAt);
  const successfulSinceFailure = lastSuccessMs !== null && lastSuccessMs <= nowMs
    && valid && lastSuccessMs > (canonicalMs(prior.completedAt) ?? canonicalMs(prior.startedAt));
  if (valid && prior.state !== 'succeeded' && !successfulSinceFailure && Date.parse(prior.nextAttemptAt) > nowMs) {
    return failureResult(prior.state === 'running' ? 'previous-attempt-incomplete-cooldown' : 'failed-source-cooldown', prior.nextAttemptAt, prior.errorCode || null);
  }
  if (lastSuccessMs !== null && lastSuccessMs <= nowMs && nowMs - lastSuccessMs < minIntervalMs
      && (!valid || prior.state === 'succeeded' || successfulSinceFailure)) {
    return {ok:true, skipped:true, script:SCRIPT, reason:'successful-snapshot-min-interval'};
  }
  const startedAt = new Date(nowMs).toISOString();
  const previousFailures = valid && !successfulSinceFailure ? prior.failures : 0;
  const running = {version:VERSION, script:SCRIPT, state:'running', failures:previousFailures,
    startedAt, completedAt:null, nextAttemptAt:new Date(nowMs + BASE_RETRY_MS).toISOString(), errorCode:null};
  try { write(attemptFile,running); }
  catch { return failureResult('retry-state-write-failed',null,'RETRY_STATE_WRITE_FAILED'); }
  // Stop/interruption ownership remains with the worker. On a thrown error keep
  // the running lease for restart protection; never convert cancellation to ok.
  let result = await run();
  if (!result || typeof result.ok !== 'boolean') result = {ok:false, fatal:false,
    error:'Supplementary fixtures command returned no valid result', errorCode:'SOURCE_RESULT_INVALID'};
  if (result?.skipped || result?.reused) {
    // Signed release reuse did not perform a new source request. Restore the
    // original operational state and never advance success/failure clocks.
    try { write(attemptFile, valid ? prior : null); }
    catch { return failureResult('retry-state-write-failed',null,'RETRY_STATE_WRITE_FAILED'); }
    return valid && prior.state !== 'succeeded' && !successfulSinceFailure
      ? failureResult('source-not-rechecked',prior.nextAttemptAt,prior.errorCode || null)
      : result;
  }
  const finishedMs = clock();
  if (!Number.isSafeInteger(finishedMs) || finishedMs < nowMs) return failureResult('retry-clock-invalid',running.nextAttemptAt,'RETRY_CLOCK_INVALID');
  const succeeded = result?.ok === true;
  const failures = succeeded ? 0 : Math.min(1000,previousFailures + 1);
  const nextAttemptAt = succeeded ? null : new Date(finishedMs + Math.min(MAX_RETRY_MS,BASE_RETRY_MS * 2 ** Math.min(10,failures-1))).toISOString();
  const errorCode = typeof result?.errorCode === 'string' && /^[A-Z0-9_]{1,100}$/.test(result.errorCode) ? result.errorCode : succeeded ? null : 'SOURCE_ATTEMPT_FAILED';
  try { write(attemptFile,{...running,state:succeeded?'succeeded':'failed',failures,completedAt:new Date(finishedMs).toISOString(),nextAttemptAt,errorCode}); }
  catch { return {...failureResult('retry-state-write-failed',null,'RETRY_STATE_WRITE_FAILED'),skipped:false}; }
  return {...result,script:SCRIPT,retry:{version:VERSION,nextAttemptAt,errorCode,sourceRecovered:succeeded,failures,priorStateInvalid:prior !== null && !valid}};
}
module.exports = {VERSION,SCRIPT,BASE_RETRY_MS,MAX_RETRY_MS,validAttempt,runFootballDataFixtureRetry};
