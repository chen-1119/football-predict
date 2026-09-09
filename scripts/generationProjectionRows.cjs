"use strict";
const { asText, hashPayload, readJsonPayload, sourceMatchIdFor } = require("./sqliteWarehouse.cjs");
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const fastResultGenerationReconciliationStamp = (syncMeta) => {
  const reconciliation = syncMeta?.fastResultGenerationReconciliation;
  const revision = Number(syncMeta?.fastResultGenerationRevision || 0);
  if (
    reconciliation?.version !== "fast-result-generation-reconciliation-v1"
    || !Number.isSafeInteger(revision)
    || revision <= 0
    || Number(reconciliation.receiptRevision || 0) !== revision
  ) return "";
  return JSON.stringify({
    version: reconciliation.version,
    receiptRevision: revision,
    publishedAt: asText(reconciliation.publishedAt) || null,
    sourceCycleId: asText(reconciliation.sourceCycleId) || null,
    datasetRevision: asText(reconciliation.datasetRevision) || null,
  });
};

const normalizeLegacyReviewClock = (match) => {
  const review = match?.postMatchReview;
  if (!review || typeof review !== "object" || Array.isArray(review)) return match;

  const generatedAt = String(review.generatedAt || "").trim();
  if (!Number.isFinite(Date.parse(generatedAt))) return match;

  if (hasOwn(review, "settlement") && (
    !review.settlement
    || typeof review.settlement !== "object"
    || Array.isArray(review.settlement)
  )) return match;

  const settlement = review.settlement || {};
  const revisionMissing = !hasOwn(settlement, "resultRevision");
  const generatedAtMissing = !hasOwn(settlement, "reviewGeneratedAt");
  if (!revisionMissing && !generatedAtMissing) return match;

  return {
    ...match,
    postMatchReview: {
      ...review,
      settlement: {
        ...settlement,
        ...(revisionMissing ? { resultRevision: 1 } : {}),
        ...(generatedAtMissing ? { reviewGeneratedAt: generatedAt } : {}),
      },
    },
  };
};

const capturedAtFor = (row) => row?.capturedAt
  || row?.captureBucket
  || row?.oddsUpdatedAt
  || row?.updatedAt
  || row?.lastSeenAt
  || row?.finishedAt
  || row?.at
  || null;

const syncMetaDataVersion = (meta) => {
  for (const value of [
    meta?.api?.currentFreshnessTime,
    meta?.api?.historyFreshnessTime,
    meta?.api?.freshnessTime,
    meta?.updatedAt,
    meta?.capturedAt,
    meta?.lastAttemptAt,
  ]) {
    const time = Date.parse(value || "");
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return "";
};

const rawOddsRecord = (row, namespace = "raw") => {
  const payload = readJsonPayload(row?.payload) || row || {};
  const capturedAt = capturedAtFor(payload) || row?.captured_at || null;
  const legacyId = asText(row?.id) || hashPayload(payload);
  return {
    id: `odds-raw-v2:${hashPayload(`${namespace}|${legacyId}`)}`,
    stateKey: null,
    matchId: row?.match_id || payload.matchId || null,
    sourceMatchId: row?.source_match_id || payload.sourceMatchId || sourceMatchIdFor(payload.matchId) || null,
    pool: row?.pool || payload.pool || payload.poolCode || payload.oddsPoolCode || null,
    bookmaker: row?.bookmaker || payload.bookmaker || null,
    handicapLine: row?.handicap_line ?? payload.handicapLine ?? payload.handicap ?? null,
    capturedAt,
    firstSeenAt: capturedAt,
    lastSeenAt: payload.lastSeenAt || capturedAt,
    seenCount: Math.max(1, Number(payload.seenCount || 1)),
    payload,
  };
};

const rawPredictionRecord = (row, namespace = "raw") => {
  const payload = readJsonPayload(row?.payload) || row || {};
  const capturedAt = capturedAtFor(payload) || row?.captured_at || null;
  const legacyId = asText(row?.id) || hashPayload(payload);
  return {
    id: `prediction-raw-v2:${hashPayload(`${namespace}|${legacyId}`)}`,
    stateKey: null,
    matchId: row?.match_id || payload.matchId || null,
    sourceMatchId: row?.source_match_id || payload.sourceMatchId || null,
    phase: row?.phase || payload.phase || null,
    capturedAt,
    firstSeenAt: payload.firstSeenAt || capturedAt,
    lastSeenAt: payload.lastSeenAt || capturedAt,
    seenCount: Math.max(1, Number(payload.seenCount || 1)),
    payload,
  };
};

module.exports = { fastResultGenerationReconciliationStamp, normalizeLegacyReviewClock, capturedAtFor, syncMetaDataVersion, rawOddsRecord, rawPredictionRecord };
