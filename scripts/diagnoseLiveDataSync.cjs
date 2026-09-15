"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { storedResultTeamIdentity } = require("./storedResultTeamIdentity.cjs");
const { sameEvent, eventVersionOf, canonicalSourceMatchId } = require("../src/services/matchLifecycle.cjs");

const rootDir = path.resolve(__dirname, "..");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data"));
const publicDataDir = path.join(rootDir, "public", "data");

const readJson = (filePath, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
};

const statIso = (filePath) => {
  try { return new Date(fs.statSync(filePath).mtimeMs).toISOString(); } catch { return null; }
};

const shanghaiDay = (value = Date.now()) => {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const businessDayOf = (match) => String(
  match?.businessDate || match?.matchDate || match?.kickoffDate || match?.kickoffTime || ""
).slice(0, 10);

const sourceMatchIdFor = (match) => canonicalSourceMatchId(match?.sourceMatchId || match?.matchId || match?.id);

const groupIdentityConflicts = (rows) => {
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sourceId = sourceMatchIdFor(row);
    const eventVersion = eventVersionOf(row);
    if (!sourceId || !eventVersion) continue;
    const key = `${sourceId}|${eventVersion}`;
    const bucket = buckets.get(key) || [];
    bucket.push(row);
    buckets.set(key, bucket);
  }

  const conflicts = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length < 2) continue;
    const reference = storedResultTeamIdentity(bucket[0]);
    const incompatible = bucket.slice(1).filter((row) => !sameEvent(reference, storedResultTeamIdentity(row)));
    if (!incompatible.length) continue;
    conflicts.push({
      key,
      rows: bucket.map((row) => ({
        id: row.id || null,
        sourceMatchId: row.sourceMatchId || null,
        eventVersion: eventVersionOf(row),
        homeTeamId: row.homeTeamId || null,
        homeTeamName: row.homeTeamName || null,
        awayTeamId: row.awayTeamId || null,
        awayTeamName: row.awayTeamName || null,
        score: Number.isInteger(row.scoreHome) && Number.isInteger(row.scoreAway)
          ? `${row.scoreHome}-${row.scoreAway}`
          : null,
      })),
    });
  }
  return conflicts;
};

const syncMetaPath = path.join(publicDataDir, "sync-meta.json");
const currentPath = path.join(publicDataDir, "matches-current.json");
const historyPath = path.join(publicDataDir, "matches-history.json");
const workerStatusPath = path.join(storeDir, "sync-worker-status.json");
const quarantinePath = path.join(storeDir, "post-match-review-quarantine.json");
const currentPointerPath = path.join(storeDir, "generations", "current.json");

const syncMeta = readJson(syncMetaPath, {});
const current = readJson(currentPath, []);
const history = readJson(historyPath, []);
const worker = readJson(workerStatusPath, {});
const quarantine = readJson(quarantinePath, { rows: [] });
const publicationPointer = readJson(currentPointerPath, null);
const today = shanghaiDay();

const todayRows = (Array.isArray(current) ? current : []).filter((match) => businessDayOf(match) === today);
const futureRows = (Array.isArray(current) ? current : []).filter((match) => {
  const kickoff = Date.parse(match?.kickoffTime || "");
  return Number.isFinite(kickoff) && kickoff > Date.now();
});
const identityConflicts = groupIdentityConflicts(history);
const workerError = worker?.lastError || (worker?.ok === false ? {
  message: worker.error || null,
  code: worker.errorCode || null,
  at: worker.at || null,
} : null);

const sourceUpdatedAt = syncMeta?.api?.currentFreshnessTime
  || syncMeta?.api?.freshnessTime
  || syncMeta?.updatedAt
  || null;
const publicationCommittedAt = publicationPointer?.committedAt
  || syncMeta?.generation?.committedAt
  || syncMeta?.committedAt
  || null;
const sourceAgeMinutes = sourceUpdatedAt && Number.isFinite(Date.parse(sourceUpdatedAt))
  ? Math.round((Date.now() - Date.parse(sourceUpdatedAt)) / 60000)
  : null;
const publicationAgeMinutes = publicationCommittedAt && Number.isFinite(Date.parse(publicationCommittedAt))
  ? Math.round((Date.now() - Date.parse(publicationCommittedAt)) / 60000)
  : null;

const blockers = [];
if (!Array.isArray(current) || current.length === 0) blockers.push("current-publication-empty");
if (todayRows.length === 0 && futureRows.length === 0) blockers.push("no-today-or-future-fixtures");
if (sourceAgeMinutes !== null && sourceAgeMinutes > 20) blockers.push("current-source-stale");
if (publicationAgeMinutes !== null && publicationAgeMinutes > 20) blockers.push("publication-stale");
if (workerError) blockers.push(`worker-error:${workerError.code || "unknown"}`);
if (identityConflicts.length) blockers.push(`history-event-identity-conflicts:${identityConflicts.length}`);

const report = {
  version: "live-data-diagnostics-v1",
  checkedAt: new Date().toISOString(),
  shanghaiBusinessDate: today,
  ok: blockers.length === 0,
  blockers,
  source: {
    updatedAt: sourceUpdatedAt,
    ageMinutes: sourceAgeMinutes,
    stale: syncMeta?.api?.currentStale ?? syncMeta?.api?.stale ?? null,
    lastAttemptAt: syncMeta?.lastAttemptAt || null,
  },
  publication: {
    generationId: publicationPointer?.generationId || syncMeta?.generationId || null,
    sourceCycleId: publicationPointer?.sourceCycleId || syncMeta?.sourceCycleId || null,
    committedAt: publicationCommittedAt,
    ageMinutes: publicationAgeMinutes,
    currentFileUpdatedAt: statIso(currentPath),
  },
  current: {
    total: Array.isArray(current) ? current.length : 0,
    today: todayRows.length,
    future: futureRows.length,
    scheduled: (Array.isArray(current) ? current : []).filter((row) => row.status === "SCHEDULED").length,
    live: (Array.isArray(current) ? current : []).filter((row) => row.status === "LIVE").length,
    pendingResult: (Array.isArray(current) ? current : []).filter((row) => row.status === "PENDING_RESULT").length,
  },
  history: {
    total: Array.isArray(history) ? history.length : 0,
    eventIdentityConflicts: identityConflicts,
    quarantinedReviews: Array.isArray(quarantine?.rows) ? quarantine.rows.length : 0,
  },
  worker: {
    lastSuccessAt: worker?.lastSuccessAt || null,
    lastError: workerError,
    lastCycleFinishedAt: worker?.lastCycle?.finishedAt || null,
    lastCycleOk: worker?.lastCycle?.ok ?? null,
    backgroundSlowPhase: worker?.backgroundSlowPhase || null,
  },
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 2;
