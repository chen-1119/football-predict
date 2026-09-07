"use strict";
const fs = require("node:fs"), path = require("node:path");
const { collectSeasonObservations, auditObservationStore } = require("./openFootballObservationStore.cjs");
const { acquirePointerCommitLock } = require("../server/dataGenerationStore.cjs");
const { STATUS_VERSION, observationDirectory, seasonAt, usableStatus } = require("./openFootballObservationSchedule.cjs");
const { strictInstant } = require("../src/services/strictInstant.cjs");
function writeStatus(file, value) {
  const temporary = `${file}.${process.pid}.${require("node:crypto").randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
async function syncObservations({ storeDir, season, fetchImpl, requestId = require("node:crypto").randomUUID(), clock = () => new Date().toISOString() }) {
  if (typeof storeDir !== "string" || !path.isAbsolute(storeDir)) throw new Error("Explicit absolute observation directory required");
  if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("Invalid collection request identity");
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(storeDir) !== storeDir || fs.lstatSync(storeDir).isSymbolicLink()) throw new Error("Unsafe community receipt directory");
  const lock = acquirePointerCommitLock({ lockDir: path.join(storeDir, ".collection.lock"), timeoutMs: 0 });
  try {
    const statusFile = path.join(storeDir, "sync-status.json");
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    const result = await collectSeasonObservations({ storeDir, season, fetchImpl, clock });
    const completedAt = clock(), nowMs = Date.parse(completedAt);
    const audit = fs.existsSync(path.join(storeDir, "observations.sqlite")) ? auditObservationStore(storeDir) : null;
    if (!strictInstant(completedAt) || (audit?.latestReceivedAt && Date.parse(audit.latestReceivedAt) > nowMs)) throw new Error("Invalid collection completion clock");
    const status = { version: STATUS_VERSION, requestId, season, completedAt, ok: result.ok && audit?.ok === true,
      lastSuccessfulCollectionAt: result.ok && audit?.ok === true ? completedAt
        : usableStatus(prior, nowMs, season) ? prior.lastSuccessfulCollectionAt : null,
      requestedSources: result.providerRequests, successfulSources: result.sources.filter(s => s.ok).length,
      failedSources: result.sources.filter(s => !s.ok).length, lastReceiptHash: audit?.lastReceiptHash || null,
      sources: result.sources.map(s => ({ league: s.league, ok: s.ok, candidates: s.receipt?.candidateRows ?? null,
        latestResultDate: s.receipt?.latestResultDate || null })),
      sourceVerified: false, productionAdmittedRows: 0, officialResultWrites: 0, predictionWrites: 0 };
    writeStatus(statusFile, status);
    return status;
  } finally { lock.release(); }
}
if (require.main === module) {
  const storeDir = process.env.OPENFOOTBALL_OBSERVATION_STORE_DIR
    ? path.resolve(process.env.OPENFOOTBALL_OBSERVATION_STORE_DIR)
    : observationDirectory(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(__dirname, "..", "server-data"));
  const season = process.env.OPENFOOTBALL_OBSERVATION_SEASON || seasonAt(Date.now());
  syncObservations({ storeDir, season, requestId: process.env.OPENFOOTBALL_OBSERVATION_REQUEST_ID }).then(status => {
    console.log(JSON.stringify(status, null, 2)); if (!status.ok) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { syncObservations, writeStatus };
