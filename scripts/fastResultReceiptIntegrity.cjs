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
const FAST_RESULT_RECEIPT_META_KEYS = Object.freeze([
  "fast_result_receipt", "fast_result_revision", "fast_result_source_cycle_id", "fast_result_dataset_revision",
  "fast_result_published_at", "fast_result_authority_high_water", "fast_result_authority_high_water:initialized",
]);
const fastResultReceiptRoot = (rows) => crypto.createHash("sha256")
  .update(stableStringify([...rows].sort((left, right) => String(left.key).localeCompare(String(right.key)))))
  .digest("hex");

// Storage-independent validation: PostgreSQL and the legacy SQLite reader
// validate the very same persisted bytes and clocks, without a SQL facade.
const validateFastResultReceiptMetadata = (rows) => {
  const byKey = new Map(rows.map(row => [row.key, row]));
  if (byKey.size !== rows.length) throw new Error("duplicate fast-result metadata key");
  const receiptRow = byKey.get("fast_result_receipt") || null;
  const revisionRow = byKey.get("fast_result_revision") || null;
  const sourceCycleRow = byKey.get("fast_result_source_cycle_id") || null;
  const datasetRevisionRow = byKey.get("fast_result_dataset_revision") || null;
  if (!receiptRow && !revisionRow) {
    const previouslyInitialized = [
      "fast_result_published_at",
      "fast_result_source_cycle_id",
      "fast_result_dataset_revision",
      "fast_result_authority_high_water",
      "fast_result_authority_high_water:initialized",
    ].some((key) => byKey.has(key)) || rows.some(row => row.key.startsWith("fast_result_authority_high_water:event:"));
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

const readFastResultReceiptState = (db) => {
  // Receipt validation needs seven scalar keys, not every high-water event
  // payload. Only test event existence when both receipt heads are absent.
  const rows = db.prepare(`SELECT key,value,updated_at FROM schema_meta WHERE key IN (${FAST_RESULT_RECEIPT_META_KEYS.map(() => "?").join(",")})`)
    .all(...FAST_RESULT_RECEIPT_META_KEYS);
  if (!rows.some(row => ["fast_result_receipt", "fast_result_revision"].includes(row.key))) {
    const event = db.prepare("SELECT key FROM schema_meta WHERE key LIKE 'fast_result_authority_high_water:event:%' LIMIT 1").get();
    if (event) rows.push(event);
  }
  return validateFastResultReceiptMetadata(rows);
};

module.exports = {
  fastResultReceiptRoot,
  FAST_RESULT_RECEIPT_META_KEYS,
  readFastResultReceiptState,
  validateFastResultReceiptMetadata,
};
