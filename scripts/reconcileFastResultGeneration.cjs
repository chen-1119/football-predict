"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  FAST_RESULT_IDENTITY_RESOLUTION_VERSION,
  findFastResultObservation,
  observationRows,
  trustedOfficialFinal,
} = require("./fastResultObservations.cjs");
const {
  attachPostMatchReviews,
  attachResultAuditTimestamps,
} = require("./syncData.cjs");
const { acquireSyncMetaCommitLock } = require("./syncMetaCommitLock.cjs");
const {
  eventVersionOf,
  reconcileMatchLifecycle,
  sameEvent,
} = require("../src/services/matchLifecycle.cjs");

const rootDir = path.resolve(__dirname, "..");

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const atomicWriteJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    } catch {
      // A failed cleanup cannot change an already-committed target file.
    }
  }
};

const asText = (value) => String(value || "").trim();
const sourceMatchIdFor = (match) => asText(match?.sourceMatchId || match?.id).replace(/^sporttery_/, "");
const scoreKey = (match) => (
  Number.isInteger(match?.scoreHome) && Number.isInteger(match?.scoreAway)
    ? `${match.scoreHome}:${match.scoreAway}`
    : ""
);
const observedAtMs = (match) => {
  const value = Date.parse(
    match?.resultObservedAt
    || match?.postMatchReview?.settlement?.resultObservedAt
    || ""
  );
  return Number.isFinite(value) ? value : 0;
};
const resultRevision = (match) => Math.max(
  0,
  Number(match?.postMatchReview?.settlement?.resultRevision || 0),
);

const sameStoredEvent = (left, right) => (
  sourceMatchIdFor(left) === sourceMatchIdFor(right)
  && sameEvent(left, right)
);

const sameReceiptScore = (match, observation) => (
  Number.isInteger(match?.scoreHome)
  && Number.isInteger(match?.scoreAway)
  && match.scoreHome === observation?.scoreHome
  && match.scoreAway === observation?.scoreAway
);

const eventClock = (value) => {
  const instant = Date.parse(eventVersionOf(value) || value?.eventVersion || value?.kickoffTime || "");
  if (!Number.isFinite(instant)) return null;
  const beijing = new Date(instant + (8 * 60 * 60 * 1000)).toISOString();
  return {
    instant,
    date: beijing.slice(0, 10),
    clock: beijing.slice(11, 16),
  };
};

const immutableArchiveBindsEvent = (match) => {
  const archive = match?.archivedPreMatchPrediction;
  const matchInstant = Date.parse(eventVersionOf(match) || "");
  const archiveInstant = Date.parse(archive?.eventVersion || archive?.kickoffTime || "");
  const capturedAt = Date.parse(archive?.capturedAt || "");
  return Boolean(
    archive?.version === "archived-pre-match-prediction-v1"
    && archive?.source === "immutable-pre-match-prediction-snapshot"
    && sourceMatchIdFor(archive) === sourceMatchIdFor(match)
    && Number.isFinite(matchInstant)
    && Number.isFinite(archiveInstant)
    && matchInstant === archiveInstant
    && Number.isFinite(capturedAt)
    && capturedAt < matchInstant
  );
};

const legacyMidnightReceiptAlias = (observation, match) => {
  if (
    sourceMatchIdFor(observation) !== sourceMatchIdFor(match)
    || !immutableArchiveBindsEvent(match)
  ) return false;
  const receiptClock = eventClock(observation);
  const matchClock = eventClock(match);
  const observedAt = Date.parse(observation?.resultObservedAt || "");
  return Boolean(
    receiptClock
    && matchClock
    && receiptClock.date === matchClock.date
    && receiptClock.clock === "00:00"
    && matchClock.clock !== "00:00"
    && Number.isFinite(observedAt)
    && observedAt >= matchClock.instant
  );
};

const receiptRecoveryError = (message, code = "FAST_RESULT_GENERATION_RECEIPT_MISSING") => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const buildReceiptRecoveredFinal = (match, observation, mode) => {
  const eventVersion = eventVersionOf(match);
  const resultObservedAt = observation.resultObservedAt;
  const sourceUpdatedAt = observation.sourceUpdatedAt || null;
  const reconciled = reconcileMatchLifecycle(match, {
    ...match,
    status: "FINISHED",
    sourceStatus: "FINISHED",
    effectiveStatus: "FINISHED",
    scoreHome: observation.scoreHome,
    scoreAway: observation.scoreAway,
    resultSource: "sporttery:sqlite-fast-result-receipt",
    resultUpdatedAt: sourceUpdatedAt || resultObservedAt,
    resultSourceUpdatedAt: sourceUpdatedAt,
    resultObservedAt,
    resultObservationSource: observation.observationSource,
    resultObservationFallback: false,
    settledAt: observation.settledAt,
    eventVersion,
    kickoffTime: match.kickoffTime,
    official: true,
    sourceCycleId: observation.sourceCycleId,
    datasetRevision: observation.datasetRevision,
    resultProvenance: undefined,
    postMatchReview: undefined,
  }, { now: resultObservedAt });
  if (
    !trustedOfficialFinal(reconciled)
    || !sameReceiptScore(reconciled, observation)
    || sourceMatchIdFor(reconciled) !== sourceMatchIdFor(observation)
  ) {
    throw receiptRecoveryError(
      `fast result receipt could not produce a trusted final: ${observation.key}`,
      "FAST_RESULT_GENERATION_RECEIPT_RECOVERY_INVALID"
    );
  }

  const audited = attachResultAuditTimestamps(reconciled, match);
  const reviewed = attachPostMatchReviews(
    [audited],
    resultObservedAt,
    null,
    null
  ).matches[0];
  if (!reviewed?.postMatchReview) {
    throw receiptRecoveryError(
      `fast result receipt recovery review missing: ${observation.key}`,
      "FAST_RESULT_GENERATION_RECEIPT_REVIEW_MISSING"
    );
  }
  const review = {
    ...reviewed.postMatchReview,
    generatedAt: resultObservedAt,
    settlement: {
      ...(reviewed.postMatchReview.settlement || {}),
      reviewGeneratedAt: resultObservedAt,
      sourceCycleId: observation.sourceCycleId,
      datasetRevision: observation.datasetRevision,
    },
  };
  return {
    ...reviewed,
    sourceCycleId: observation.sourceCycleId,
    datasetRevision: observation.datasetRevision,
    postMatchReview: review,
    fastResultIdentityResolution: {
      version: FAST_RESULT_IDENTITY_RESOLUTION_VERSION,
      policy: mode === "legacy-midnight-alias"
        ? "sqlite-receipt-legacy-midnight-rebound-to-immutable-prematch-event"
        : "sqlite-receipt-exact-event-recovery",
      receiptObservationKey: observation.key,
      canonicalSourceMatchId: sourceMatchIdFor(match),
      previousEventVersion: observation.eventVersion,
      reboundEventVersion: eventVersion,
      immutableArchiveValidated: immutableArchiveBindsEvent(match),
      inheritedMismatchedPreMatchEvidence: mode === "legacy-midnight-alias",
    },
  };
};

const chooseFinalPayload = (existing, incoming) => {
  if (!existing) return incoming;
  if (scoreKey(existing) !== scoreKey(incoming)) {
    const error = new Error(
      `fast result generation score conflict ${sourceMatchIdFor(incoming)}: ${scoreKey(existing)} != ${scoreKey(incoming)}`
    );
    error.code = "FAST_RESULT_GENERATION_CONFLICT";
    throw error;
  }
  const existingRevision = resultRevision(existing);
  const incomingRevision = resultRevision(incoming);
  if (existingRevision > incomingRevision) return existing;
  if (existingRevision === incomingRevision && observedAtMs(existing) > observedAtMs(incoming)) {
    return existing;
  }
  return incoming;
};

const replaceOrAppend = (rows, match) => {
  let replaced = false;
  const next = rows.map((row) => {
    if (!sameStoredEvent(row, match)) return row;
    replaced = true;
    return chooseFinalPayload(row, match);
  });
  if (!replaced) next.push(match);
  return next;
};

const reviewIdentityMatches = (review, match) => {
  const reviewSourceId = asText(review?.sourceMatchId || review?.matchId).replace(/^sporttery_/, "");
  const matchSourceId = sourceMatchIdFor(match);
  if (!reviewSourceId || reviewSourceId !== matchSourceId) return false;
  const reviewMatchId = asText(review?.matchId);
  const matchId = asText(match?.id);
  return !reviewMatchId || !matchId || reviewMatchId === matchId;
};

const reviewSummary = (rows) => rows.reduce((summary, review) => {
  summary.total += 1;
  if (review?.predictionReview?.bestStatus === "WON") summary.bestWon += 1;
  if (review?.predictionReview?.bestStatus === "LOST") summary.bestLost += 1;
  if (review?.predictionReview?.referenceBestStatus === "WON") summary.referenceBestWon += 1;
  if (review?.predictionReview?.referenceBestStatus === "LOST") summary.referenceBestLost += 1;
  if (review?.predictionReview?.handicapHit === true) summary.handicapHit += 1;
  if (review?.predictionReview?.missedHandicapLane === true) summary.missedHandicapLane += 1;
  for (const item of review?.modelDiagnosis || []) {
    const code = asText(item?.code);
    if (code) summary.diagnosis[code] = (summary.diagnosis[code] || 0) + 1;
  }
  return summary;
}, {
  total: 0,
  bestWon: 0,
  bestLost: 0,
  referenceBestWon: 0,
  referenceBestLost: 0,
  handicapHit: 0,
  missedHandicapLane: 0,
  diagnosis: {},
});

const readFastReceipt = (db) => {
  const value = db.prepare(
    "SELECT value FROM schema_meta WHERE key = 'fast_result_receipt'"
  ).get()?.value;
  const receipt = readJsonPayload(value);
  return ["sqlite-fast-result-receipt-v1", "sqlite-fast-result-receipt-v2"]
    .includes(receipt?.version) ? receipt : null;
};

const readJsonPayload = (value) => {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
};

const readReceiptFinals = (db, receipt, { current = [], history = [] } = {}) => {
  const observations = observationRows(receipt?.observations);
  const sourceIds = [...new Set(observations
    .map((row) => asText(row.sourceMatchId).toLowerCase())
    .filter(Boolean))];
  if (!sourceIds.length) return [];
  const statement = db.prepare(`
    SELECT payload
    FROM match_snapshots
    WHERE dataset = 'history' AND LOWER(source_match_id) = ?
  `);
  const byEvent = new Map();
  for (const sourceId of sourceIds) {
    for (const row of statement.all(sourceId)) {
      const match = readJsonPayload(row.payload);
      const observation = match && findFastResultObservation(match, observations);
      if (!match || !observation || !trustedOfficialFinal(match)) continue;
      byEvent.set(observation.key, chooseFinalPayload(byEvent.get(observation.key), match));
    }
  }
  const recoveryRows = [];
  const missing = observations.filter((row) => !byEvent.has(row.key));
  for (const observation of missing) {
    const sourceMatchId = sourceMatchIdFor(observation);
    const exactHistory = history.filter((match) => (
      sourceMatchIdFor(match) === sourceMatchId
      && sameEvent(match, observation)
      && sameReceiptScore(match, observation)
      && trustedOfficialFinal(match)
    ));
    const aliasHistory = history.filter((match) => (
      sourceMatchIdFor(match) === sourceMatchId
      && legacyMidnightReceiptAlias(observation, match)
      && sameReceiptScore(match, observation)
      && trustedOfficialFinal(match)
    ));
    const historyCandidates = [...exactHistory, ...aliasHistory]
      .filter((match, index, rows) => rows.indexOf(match) === index);
    if (historyCandidates.length > 1) {
      throw receiptRecoveryError(
        `fast result receipt maps to multiple public history rows: ${observation.key}`,
        "FAST_RESULT_GENERATION_RECEIPT_AMBIGUOUS"
      );
    }
    if (historyCandidates.length === 1) {
      byEvent.set(observation.key, historyCandidates[0]);
      recoveryRows.push({
        key: observation.key,
        sourceMatchId,
        mode: exactHistory.includes(historyCandidates[0])
          ? "public-history-exact"
          : "public-history-legacy-midnight-alias",
      });
      continue;
    }

    const exactCurrent = current.filter((match) => (
      sourceMatchIdFor(match) === sourceMatchId
      && sameEvent(match, observation)
    ));
    const aliasCurrent = current.filter((match) => (
      sourceMatchIdFor(match) === sourceMatchId
      && legacyMidnightReceiptAlias(observation, match)
    ));
    const currentCandidates = [...exactCurrent, ...aliasCurrent]
      .filter((match, index, rows) => rows.indexOf(match) === index);
    if (currentCandidates.length !== 1) continue;
    const mode = exactCurrent.includes(currentCandidates[0])
      ? "exact-event"
      : "legacy-midnight-alias";
    const recovered = buildReceiptRecoveredFinal(
      currentCandidates[0],
      observation,
      mode
    );
    byEvent.set(observation.key, recovered);
    recoveryRows.push({
      key: observation.key,
      sourceMatchId,
      mode,
    });
  }
  const unresolved = observations.filter((row) => !byEvent.has(row.key));
  if (unresolved.length) {
    throw receiptRecoveryError(
      `fast result generation receipt rows missing from SQLite/public generation: ${unresolved.map((row) => row.key).join(",")}`
    );
  }
  return {
    finals: Array.from(byEvent.values()),
    recoveryRows,
  };
};

const reconcileFastResultGeneration = ({
  dbPath = path.resolve(
    process.env.DATASTORE_SQLITE_PATH
    || path.join(
      process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data"),
      "football.db"
    )
  ),
  dataDir = path.resolve(
    process.env.DATA_GENERATION_PUBLIC_DATA_DIR
    || process.env.SQLITE_EXPORT_PUBLIC_DATA_DIR
    || path.join(rootDir, "public", "data")
  ),
  syncMetaPath = path.join(dataDir, "sync-meta.json"),
} = {}) => {
  const startedAt = new Date().toISOString();
  if (!fs.existsSync(dbPath)) {
    return {
      ok: true,
      skipped: true,
      reason: "sqlite-database-missing",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let receipt;
  try {
    receipt = readFastReceipt(db);
    if (!receipt) {
      return {
        ok: true,
        skipped: true,
        reason: "fast-result-receipt-missing",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  } finally {
    db.close();
  }

  const receiptRevision = Math.max(0, Number(receipt.revision || 0));
  const initialSyncMeta = readJson(syncMetaPath, {});
  const reconciledRevision = Math.max(
    0,
    Number(initialSyncMeta.fastResultGenerationRevision || 0),
  );
  if (receiptRevision <= reconciledRevision) {
    return {
      ok: true,
      skipped: true,
      reason: "fast-result-generation-current",
      receiptRevision,
      reconciledRevision,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const currentPath = path.join(dataDir, "matches-current.json");
  const historyPath = path.join(dataDir, "matches-history.json");
  const reviewsPath = path.join(dataDir, "post-match-reviews.json");
  const current = readJson(currentPath, null);
  const history = readJson(historyPath, null);
  const reviews = readJson(reviewsPath, null);
  if (!Array.isArray(current) || !Array.isArray(history)) {
    const error = new Error("fast result generation requires readable current and history arrays");
    error.code = "FAST_RESULT_GENERATION_INPUT_INVALID";
    throw error;
  }
  const receiptDb = new DatabaseSync(dbPath, { readOnly: true });
  let receiptResolution;
  try {
    receiptResolution = readReceiptFinals(receiptDb, receipt, { current, history });
  } finally {
    receiptDb.close();
  }
  const finals = receiptResolution.finals;

  let nextCurrent = current;
  let nextHistory = history;
  let nextReviewRows = Array.isArray(reviews?.rows) ? reviews.rows : [];
  let removedCurrentRows = 0;
  let upsertedHistoryRows = 0;
  let upsertedReviewRows = 0;
  for (const finalMatch of finals) {
    const beforeCurrent = nextCurrent.length;
    nextCurrent = nextCurrent.filter((row) => !sameStoredEvent(row, finalMatch));
    removedCurrentRows += beforeCurrent - nextCurrent.length;

    const existingHistory = nextHistory.find((row) => sameStoredEvent(row, finalMatch));
    const selectedFinal = chooseFinalPayload(existingHistory, finalMatch);
    nextHistory = replaceOrAppend(nextHistory, selectedFinal);
    upsertedHistoryRows += 1;

    const review = selectedFinal.postMatchReview;
    if (review && typeof review === "object") {
      let reviewReplaced = false;
      nextReviewRows = nextReviewRows.map((row) => {
        if (!reviewIdentityMatches(row, selectedFinal)) return row;
        reviewReplaced = true;
        return {
          ...row,
          ...review,
          eventFactors: row.eventFactors || review.eventFactors,
        };
      });
      if (!reviewReplaced) nextReviewRows.push(review);
      upsertedReviewRows += 1;
    }
  }

  atomicWriteJson(currentPath, nextCurrent);
  atomicWriteJson(historyPath, nextHistory);
  if (reviews && typeof reviews === "object" && !Array.isArray(reviews)) {
    atomicWriteJson(reviewsPath, {
      ...reviews,
      rows: nextReviewRows,
      summary: reviewSummary(nextReviewRows),
    });
  }

  const metaLock = acquireSyncMetaCommitLock({ filePath: syncMetaPath });
  let committedSyncMeta;
  try {
    const latestSyncMeta = readJson(syncMetaPath, {});
    const latestFastRevision = Math.max(0, Number(latestSyncMeta.fastResultRevision || 0));
    if (latestFastRevision > receiptRevision) {
      const error = new Error(
        `fast result receipt advanced during generation reconciliation: ${receiptRevision} < ${latestFastRevision}`
      );
      error.code = "FAST_RESULT_GENERATION_RECEIPT_ADVANCED";
      throw error;
    }
    const finishedAt = new Date().toISOString();
    committedSyncMeta = {
      ...latestSyncMeta,
      files: {
        ...(latestSyncMeta.files || {}),
        current: nextCurrent.length,
        history: nextHistory.length,
        ...(reviews && typeof reviews === "object" && !Array.isArray(reviews)
          ? { postMatchReviews: nextReviewRows.length }
          : {}),
      },
      fastResultGenerationRevision: receiptRevision,
      fastResultGenerationReconciledAt: finishedAt,
      fastResultGenerationReconciliation: {
        version: "fast-result-generation-reconciliation-v1",
        receiptRevision,
        publishedAt: receipt.publishedAt || null,
        sourceCycleId: receipt.sourceCycleId || null,
        datasetRevision: receipt.datasetRevision || null,
        rows: finals.length,
        recoveredRows: receiptResolution.recoveryRows.length,
        recoveredLegacyMidnightAliases: receiptResolution.recoveryRows
          .filter((row) => /legacy-midnight-alias/.test(row.mode))
          .length,
      },
    };
    atomicWriteJson(syncMetaPath, committedSyncMeta);
  } finally {
    metaLock.release();
  }

  return {
    ok: true,
    skipped: false,
    version: "fast-result-generation-reconciliation-v1",
    startedAt,
    finishedAt: committedSyncMeta.fastResultGenerationReconciledAt,
    receiptRevision,
    reconciledRevision,
    finalRows: finals.length,
    removedCurrentRows,
    upsertedHistoryRows,
    upsertedReviewRows,
    recoveredReceiptRows: receiptResolution.recoveryRows.length,
    recoveredLegacyMidnightAliases: receiptResolution.recoveryRows
      .filter((row) => /legacy-midnight-alias/.test(row.mode))
      .length,
  };
};

const main = () => {
  const result = reconcileFastResultGeneration();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error.message || String(error),
      errorCode: error.code || null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  reconcileFastResultGeneration,
  reviewSummary,
};
