"use strict";

const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.resolve(
  process.env.DATA_GENERATION_PUBLIC_DATA_DIR || path.join(rootDir, "public", "data")
);

const readJson = (filePath, fallback) => {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
};
const atomicWriteJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temp, filePath);
  } finally {
    try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
};
const iso = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const ageSeconds = (value, nowMs) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round((nowMs - parsed) / 1000)) : null;
};

const buildRealtimePublicationHealth = ({ nowMs = Date.now(), syncMeta = {}, matches = [], projectionCompletedAt = null } = {}) => {
  const sourceObservedAt = iso(
    syncMeta?.api?.currentFreshnessTime
    || syncMeta?.api?.freshnessTime
    || syncMeta?.capturedAt
  );
  const publicationCommittedAt = iso(
    projectionCompletedAt
    || syncMeta?.committedAt
    || syncMeta?.dataGenerationCommittedAt
    || syncMeta?.updatedAt
  );
  const sourceAgeSeconds = ageSeconds(sourceObservedAt, nowMs);
  const publicationAgeSeconds = ageSeconds(publicationCommittedAt, nowMs);
  const sourceFreshLimit = Number(process.env.REALTIME_SOURCE_FRESH_SECONDS || 20 * 60);
  const publicationFreshLimit = Number(process.env.REALTIME_PUBLICATION_FRESH_SECONDS || 20 * 60);
  const sourceFresh = sourceAgeSeconds !== null && sourceAgeSeconds <= sourceFreshLimit;
  const publicationFresh = publicationAgeSeconds !== null && publicationAgeSeconds <= publicationFreshLimit;
  const status = !sourceFresh
    ? "source-stale"
    : !publicationFresh
      ? "publication-delayed"
      : "live";
  const businessDates = [...new Set((Array.isArray(matches) ? matches : [])
    .map((match) => String(match?.businessDate || "").trim())
    .filter(Boolean))].sort();

  return {
    version: "realtime-publication-health-v1",
    checkedAt: new Date(nowMs).toISOString(),
    status,
    source: {
      observedAt: sourceObservedAt,
      ageSeconds: sourceAgeSeconds,
      fresh: sourceFresh,
      freshAfterSeconds: sourceFreshLimit,
      staleFlag: syncMeta?.api?.currentStale ?? syncMeta?.api?.stale ?? null,
    },
    publication: {
      committedAt: publicationCommittedAt,
      ageSeconds: publicationAgeSeconds,
      fresh: publicationFresh,
      freshAfterSeconds: publicationFreshLimit,
      generationId: syncMeta?.dataGenerationId || syncMeta?.generationId || null,
      sourceCycleId: syncMeta?.sourceCycleId || syncMeta?.dataGenerationSourceCycleId || null,
    },
    current: {
      count: Array.isArray(matches) ? matches.length : 0,
      businessDates,
    },
    message: status === "live"
      ? { zh: "源数据与页面发布均为最新", en: "Source and publication are current" }
      : status === "publication-delayed"
        ? { zh: "源数据已更新，页面发布仍在等待", en: "Source updated; publication is delayed" }
        : { zh: "源数据更新滞后", en: "Source data is stale" },
  };
};

const writeRealtimePublicationHealth = ({ nowMs = Date.now(), projectionCompletedAt = process.env.REALTIME_PROJECTION_COMPLETED_AT || null } = {}) => {
  const syncMeta = readJson(path.join(publicDir, "sync-meta.json"), {});
  const matches = readJson(path.join(publicDir, "matches-current.json"), []);
  const payload = buildRealtimePublicationHealth({ nowMs, syncMeta, matches, projectionCompletedAt });
  atomicWriteJson(path.join(publicDir, "realtime-health.json"), payload);
  return payload;
};

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(writeRealtimePublicationHealth(), null, 2)}\n`);
}

module.exports = { buildRealtimePublicationHealth, writeRealtimePublicationHealth };
