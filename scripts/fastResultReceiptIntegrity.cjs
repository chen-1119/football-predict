"use strict";

const crypto = require("node:crypto");
const { observationRows } = require("./fastResultObservations.cjs");
const { stableStringify } = require("./sportteryFastResultLane.cjs");

const safeJsonParse = (value) => {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return null;
  }
};
const validIso = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const metaRow = (db, key) => db.prepare(
  "SELECT value, updated_at FROM schema_meta WHERE key = ?"
).get(key) || null;
const fastResultReceiptRoot = (rows) => crypto.createHash("sha256")
  .update(stableStringify([...rows].sort((left, right) => String(left.key).localeCompare(String(right.key)))))
  .digest("hex");

const readFastResultReceiptState = (db) => {
  const receiptRow = metaRow(db, "fast_result_receipt");
  const revisionRow = metaRow(db, "fast_result_revision");
  const sourceCycleRow = metaRow(db, "fast_result_source_cycle_id");
  const datasetRevisionRow = metaRow(db, "fast_result_dataset_revision");
  if (!receiptRow && !revisionRow) {
    const previouslyInitialized = [
      "fast_result_published_at",
      "fast_result_source_cycle_id",
      "fast_result_dataset_revision",
      "fast_result_authority_high_water",
      "fast_result_authority_high_water:initialized",
    ].some((key) => Boolean(metaRow(db, key))) || Boolean(db.prepare(`
      SELECT 1 AS present
      FROM schema_meta
      WHERE key LIKE 'fast_result_authority_high_water:event:%'
      LIMIT 1
    `).get());
    return previouslyInitialized
      ? { valid: false, missing: false, reason: "receipt-revision-pair-uninitialized" }
      : { valid: true, missing: true, revision: 0, receipt: null, observations: [] };
  }
  if (!receiptRow || !revisionRow) {
    return { valid: false, missing: false, reason: "receipt-revision-pair-incomplete" };
  }
  const receipt = safeJsonParse(receiptRow.value);
  const revisionText = String(revisionRow.value ?? "").trim();
  const revision = Number(revisionText);
  const rawObservations = Array.isArray(receipt?.observations) ? receipt.observations : null;
  const observations = rawObservations ? observationRows(rawObservations) : [];
  const observationKeys = observations.map((row) => row.key);
  const publishedRows = Number(receipt?.publishedRows);
  const datasetRevision = String(receipt?.datasetRevision || "").trim();
  const sourceCycleId = String(receipt?.sourceCycleId || "").trim();
  const publishedAt = validIso(receipt?.publishedAt);
  const commonValid = Boolean(
    Number.isSafeInteger(revision)
    && revision >= 1
    && revisionText === String(revision)
    && Number(receipt?.revision) === revision
    && Number.isSafeInteger(Number(receipt?.revision))
    && datasetRevision === `sqlite-fast-result-r${revision}`
    && sourceCycleId
    && publishedAt
    && validIso(receiptRow.updated_at) === publishedAt
    && validIso(revisionRow.updated_at) === publishedAt
    && Number.isSafeInteger(publishedRows)
    && publishedRows >= 1
    && rawObservations
    && observations.length === rawObservations.length
    && observations.length >= publishedRows
    && new Set(observationKeys).size === observationKeys.length
  );
  if (receipt?.version === "sqlite-fast-result-receipt-v1" && commonValid) {
    return {
      valid: false,
      legacy: true,
      missing: false,
      reason: "legacy-receipt-migration-required",
      receipt,
      receiptRow,
      revision,
      observations,
    };
  }
  const valid = Boolean(
    receipt?.version === "sqlite-fast-result-receipt-v2"
    && commonValid
    && datasetRevisionRow?.value === datasetRevision
    && sourceCycleRow?.value === sourceCycleId
    && validIso(datasetRevisionRow?.updated_at) === publishedAt
    && validIso(sourceCycleRow?.updated_at) === publishedAt
    && receipt?.observationsRootHash === fastResultReceiptRoot(observations)
  );
  return {
    valid,
    missing: false,
    reason: valid ? null : "receipt-or-revision-invalid",
    receipt: valid ? receipt : null,
    receiptRow,
    revision: valid ? revision : null,
    observations: valid ? observations : [],
  };
};

module.exports = {
  fastResultReceiptRoot,
  readFastResultReceiptState,
};
