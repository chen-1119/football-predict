"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { strictInstant } = require("../src/services/strictInstant.cjs");
const { acquirePointerCommitLock } = require("../server/dataGenerationStore.cjs");
const { createSupplementarySourceRetry } = require("./footballDataFixtureRetry.cjs");
const SCRIPT = "sync:openfootball-observations";
const VERSION = "openfootball-observation-schedule-v1";
const STATUS_VERSION = "openfootball-observation-sync-status-v1";
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const retry = createSupplementarySourceRetry({ script: SCRIPT, version: VERSION, label: "Community research receipts" });
const ms = value => strictInstant(value) ? Date.parse(value) : null;
const observationDirectory = storeDir => path.join(path.resolve(storeDir), "research", "openfootball-current-observations-v1");
function seasonAt(nowMs) {
  if (!Number.isSafeInteger(nowMs)) throw new TypeError("Invalid season clock");
  const date = new Date(nowMs), year = date.getUTCFullYear() - (date.getUTCMonth() < 6 ? 1 : 0);
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}
function usableStatus(status, nowMs, season) {
  const completed = ms(status?.completedAt), success = ms(status?.lastSuccessfulCollectionAt);
  return status?.version === STATUS_VERSION && status.season === season
    && typeof status.requestId === "string" && /^[a-f0-9-]{36}$/.test(status.requestId)
    && status.productionAdmittedRows === 0 && status.predictionWrites === 0 && status.officialResultWrites === 0
    && completed !== null && completed <= nowMs
    && (success === null || success <= completed);
}
function statusSummary(status, attempt, nowMs, season) {
  const valid = usableStatus(status, nowMs, season);
  const attemptValid = retry.validAttempt(attempt, nowMs);
  const incompleteOrFailed = attemptValid && attempt.state !== "succeeded";
  const lastSuccess = valid ? status.lastSuccessfulCollectionAt || null : null;
  return { scope: "community-research-receipts-only", season, statusAvailable: valid,
    collectionOk: incompleteOrFailed ? false : valid ? status.ok === true : null,
    latestAttemptState: attemptValid ? attempt.state : "unknown",
    lastCompletedCollectionOk: valid ? status.ok === true : null,
    lastSuccessfulCollectionAt: lastSuccess,
    nextScheduledAt: attemptValid && attempt.nextAttemptAt
      ? attempt.nextAttemptAt : lastSuccess ? new Date(ms(lastSuccess) + INTERVAL_MS).toISOString() : null,
    sourceResults: valid && Array.isArray(status.sources) ? status.sources.map(source => ({
      league: source.league, ok: source.ok === true, candidates: source.candidates ?? null,
      latestResultDate: source.latestResultDate || null,
    })) : [],
    adoptedByModel: false, entityMappingStatus: "unverified", officialSettlementAllowed: false,
  };
}
async function runOpenFootballObservationSchedule({ enabled, storeDir, read, write, run, clock = Date.now }) {
  if (!enabled) return { ok: true, skipped: true, script: SCRIPT, reason: "disabled", researchReceiptStoreOnly: true };
  const nowMs = clock(), season = seasonAt(nowMs), directory = observationDirectory(storeDir);
  let lock, result, commandError;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe community receipt directory");
    lock = acquirePointerCommitLock({ lockDir: path.join(directory, ".schedule.lock"), timeoutMs: 0 });
    const statusFile = path.join(directory, "sync-status.json"), attemptFile = path.join(directory, `schedule-attempt-${season}.json`);
    const before = read(statusFile, null);
    result = await retry.run({ enabled: true,
      checkedAt: usableStatus(before, nowMs, season) ? before.lastSuccessfulCollectionAt : null,
      minIntervalMs: INTERVAL_MS, attemptFile, read, write, clock,
      run: async () => {
        const invokedAt = clock();
        const requestId = randomUUID();
        let command;
        try {
          command = await run({ OPENFOOTBALL_OBSERVATION_STORE_DIR: directory,
            OPENFOOTBALL_OBSERVATION_SEASON: season, OPENFOOTBALL_OBSERVATION_REQUEST_ID: requestId });
        } catch (error) { commandError = error; throw error; }
        if (command?.ok !== true || command.skipped || command.reused) return command;
        const after = read(statusFile, null), endedAt = clock();
        if (!usableStatus(after, endedAt, season) || after.requestId !== requestId || after.ok !== true || ms(after.completedAt) < invokedAt
          || after.requestedSources !== 5 || after.successfulSources !== 5 || after.failedSources !== 0
          || typeof after.lastReceiptHash !== "string" || !/^[a-f0-9]{64}$/.test(after.lastReceiptHash)) {
          return { ok: false, fatal: false, error: "Community command did not produce a complete current receipt status", errorCode: "COMMUNITY_STATUS_NOT_ADVANCED" };
        }
        return command;
      },
    });
    result = { ...result, fatal: false, script: SCRIPT, researchReceiptStoreOnly: true,
      communityReceipts: statusSummary(read(statusFile, null), read(attemptFile, null), clock(), season) };
    return result;
  } catch (error) {
    // Cancellation must still propagate to the worker, whose lease state is
    // retained. Storage/lock failures are supplementary source warnings only.
    if (error === commandError || error?.code === "SYNC_WORKER_INTERRUPTED") throw error;
    result = { ok: false, skipped: true, fatal: false, script: SCRIPT, researchReceiptStoreOnly: true,
      reason: error?.code === "POINTER_LOCK_TIMEOUT" ? "community-schedule-busy" : "community-schedule-storage-failed",
      error: error.message || String(error) };
    return result;
  } finally {
    if (lock) {
      try { lock.release(); }
      catch { if (result) { result.ok = false; result.lockReleaseFailed = true; result.error = "Community schedule lock release failed"; } }
    }
  }
}
module.exports = { SCRIPT, VERSION, STATUS_VERSION, INTERVAL_MS, observationDirectory, seasonAt, usableStatus, statusSummary, runOpenFootballObservationSchedule };
