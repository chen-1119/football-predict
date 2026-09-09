"use strict";
const { resolveFastResultReceiptAuthorities } = require("./fastResultReceiptAuthority.cjs");
const { findFastResultObservation, applyFastResultObservation } = require("./fastResultObservations.cjs");
const { authorityHighWaterRow, authorityHighWaterBindsResult, authorityIdentityKey } = require("./fastResultAuthorityHighWater.cjs");
const { eventVersionOf } = require("../src/services/matchLifecycle.cjs");
const { asText } = require("./sqliteWarehouse.cjs");
const { fastResultGenerationReconciliationStamp } = require("./generationProjectionRows.cjs");
const buildFastResultProjectionGuard = ({ receiptState, authorityState, receiptHistory }) => {
  if (!receiptState.valid) throw new Error("fast_result_receipt integrity failure: " + receiptState.reason);
  if (!authorityState.valid) throw new Error("fast_result_authority_high_water integrity failure");
  if (!receiptState.missing && authorityState.missing) throw new Error("fast-result authority missing for initialized receipt");
  if (authorityState.missing) return { receiptRow: null, receipt: null, receiptState, authorityState, authoritySnapshot: null, rows: [] };
  const receiptAuthority = resolveFastResultReceiptAuthorities({
    observations: receiptState.observations,
    historyRows: receiptHistory,
  });
  if (!receiptAuthority.ok) {
    throw new Error(`fast_result_receipt history resolution mismatch: ${JSON.stringify({
      mismatchKind: receiptAuthority.mismatchKind || null,
      authorityEventKey: receiptAuthority.authorityEventKey || null,
      observationKey: receiptAuthority.observationKey || null,
      sourceHistoryRows: receiptAuthority.sourceHistoryRows ?? null,
      exactHistoryRows: receiptAuthority.exactHistoryRows ?? null,
      legacyAliasHistoryRows: receiptAuthority.legacyAliasHistoryRows ?? null,
      eventHistoryRows: receiptAuthority.eventHistoryRows ?? null,
      observationRows: receiptAuthority.observationRows ?? null,
      exactObservationRows: receiptAuthority.exactObservationRows ?? null,
      currentScoreObservationRows: receiptAuthority.currentScoreObservationRows ?? null,
      legacyAliasObservationRows: receiptAuthority.legacyAliasObservationRows ?? null,
    })}`);
  }
  const authorityByKey = new Map(authorityState.rows.map((row) => [row.key, row]));
  const rowsById = new Map();
  for (const group of receiptAuthority.groups) {
    const eventKey = group.authorityIdentity.key;
    const authorityRow = authorityByKey.get(eventKey) || null;
    const observation = group.activeObservation;
    const guardedRow = group.authorityEntry;
    const matchedAuthorityRow = authorityHighWaterRow(
      { rows: authorityRow ? [authorityRow] : [] },
      guardedRow.match,
    );
    if (
      !authorityRow
      || !authorityHighWaterBindsResult(authorityRow, observation)
      || !matchedAuthorityRow
      || !authorityHighWaterBindsResult(matchedAuthorityRow, guardedRow.match)
      || !findFastResultObservation(guardedRow.match, [observation])
    ) {
      throw new Error(`fast_result_receipt authority mismatch: ${eventKey}`);
    }
    rowsById.set(guardedRow.id, {
      ...guardedRow,
      match: guardedRow.match,
      authorityKey: eventKey,
    });
  }
  return {
    receiptRow: receiptState.receiptRow || null,
    receipt: receiptState.receipt || null,
    receiptState,
    authorityState,
    authoritySnapshot: JSON.stringify({
      manifest: authorityState.manifestRow,
      initialized: authorityState.initializedRow,
      rows: authorityState.rows,
    }),
    rows: Array.from(rowsById.values()),
  };
};

const guardedFastFinalFor = (guard, match) => {
  const identity = authorityIdentityKey({
    sourceMatchId: match?.sourceMatchId || match?.id,
    eventVersion: eventVersionOf(match) || match?.kickoffTime,
  });
  if (!identity) return null;
  return guard.rows.find((row) => row.authorityKey === identity.key) || null;
};

const generationReconciliationBindsGuard = (guard, inputSyncMeta) => {
  const inputFastResultGenerationReconciliationStamp = fastResultGenerationReconciliationStamp(inputSyncMeta);
  if (!guard?.receipt) return false;
  const reconciliation = inputSyncMeta?.fastResultGenerationReconciliation;
  const receiptRevision = Number(guard.receipt.revision || 0);
  return Boolean(
    inputFastResultGenerationReconciliationStamp
    && Number.isSafeInteger(receiptRevision)
    && receiptRevision > 0
    && Number(inputSyncMeta?.fastResultGenerationRevision || 0) === receiptRevision
    && Number(reconciliation?.receiptRevision || 0) === receiptRevision
    && asText(reconciliation?.publishedAt) === asText(guard.receipt.publishedAt)
    && asText(reconciliation?.sourceCycleId) === asText(guard.receipt.sourceCycleId)
    && asText(reconciliation?.datasetRevision) === asText(guard.receipt.datasetRevision)
  );
};

// A receipt guard protects a fast official result from an older static base.
// Once an immutable generation explicitly acknowledges that exact receipt,
// however, the generation is the reconciled public surface: retaining a
// legacy SQLite alias would detach the PostgreSQL/API row from its standalone
// review. Only allow that canonical rebase when the incoming final is bound to
// the same receipt observation and authority score. Every mismatch keeps the
// original byte-exact guard behavior.
const reconciledGenerationFastFinal = (guard, guardedRow, match, syncMeta) => {
  if (!guardedRow || !generationReconciliationBindsGuard(guard, syncMeta)) return null;
  const observation = findFastResultObservation(match, guard.receiptState.observations);
  const authorityRow = authorityHighWaterRow(guard.authorityState, match);
  if (
    !observation
    || !authorityRow
    || !authorityHighWaterBindsResult(authorityRow, match)
  ) return null;
  const observedFinal = applyFastResultObservation(match, [observation]);
  // The reconciler already proved embedded/standalone review parity before it
  // stamped sync-meta. Keep that embedded review byte-equivalent to the
  // immutable generation while still restoring receipt-authoritative root
  // observation clocks and provenance.
  return match?.postMatchReview
    ? { ...observedFinal, postMatchReview: match.postMatchReview }
    : observedFinal;
};

module.exports = { buildFastResultProjectionGuard, guardedFastFinalFor, reconciledGenerationFastFinal };
