const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  attachArchivedPreMatchPredictions,
  attachPostMatchReviews,
  attachResultAuditTimestamps,
  isTrustedFinishedForSettlement,
  loadSportteryRelayFastSnapshotForAudit,
  matchesFromSportteryRelaySnapshot,
  postMatchReviewComparable,
  reconcileOfficialResultClock,
  settleTrustedPublishedPredictions,
} = require("./syncData.cjs");
const { acquireSyncMetaCommitLock } = require("./syncMetaCommitLock.cjs");
const {
  buildPublicationLedgerIndex,
  loadPublicationLedger,
} = require("../src/services/recommendationPublicationLedger.cjs");
const {
  createFastResultObservation,
  mergeFastResultObservations,
} = require("./fastResultObservations.cjs");
const {
  FAST_RESULT_PUBLISHER_MACHINE_ENV,
  encodeFastResultPublisherOutput,
} = require("./fastResultPublisherProtocol.cjs");
const {
  recoverResultEventClockFromSnapshots,
} = require("./resultEventClockRecovery.cjs");
const {
  canonicalSourceMatchId,
  eventVersionOf,
  isOfficialSportteryFinal,
  reconcileMatchLifecycle,
  resolveMatchLifecycle,
  sameEvent,
} = require("../src/services/matchLifecycle.cjs");
const {
  auditTrustedFastResultEndpoints,
} = require("../server/relayCollectorEvidence.cjs");
const {
  auditRelayFastResultEligibility,
} = require("../server/relayFastResultWatcher.cjs");
const {
  isExplicitSportteryTerminalRow,
} = require("../src/services/sportteryResultSemantics.cjs");
const {
  authorityHighWaterCandidate,
  authorityHighWaterRow,
  authorityIdentityKey,
  loadAuthorityHighWater,
  mergeAuthorityHighWater,
  persistAuthorityHighWater,
  sameAuthorityEvent,
} = require("./fastResultAuthorityHighWater.cjs");
const {
  stableStringify,
} = require("./sportteryFastResultLane.cjs");
const {
  fastResultReceiptRoot,
  readFastResultReceiptState,
} = require("./fastResultReceiptIntegrity.cjs");
const {
  resolveFastResultReceiptAuthorities,
} = require("./fastResultReceiptAuthority.cjs");
const { boundedRuntimeEnv } = require("./boundedRuntimeNumber.cjs");

const rootDir = path.resolve(__dirname, "..");
const defaultStoreDir = path.resolve(
  process.env.SERVER_STORE_DIR
  || process.env.DATA_STORE_DIR
  || path.join(rootDir, "server-data")
);
const defaultDbPath = path.resolve(
  process.env.DATASTORE_SQLITE_PATH || path.join(defaultStoreDir, "football.db")
);
const defaultSyncMetaPath = path.resolve(
  process.env.SYNC_META_PATH || path.join(rootDir, "public", "data", "sync-meta.json")
);
const defaultPublicationLedgerPath = path.resolve(
  process.env.RECOMMENDATION_PUBLICATION_LEDGER_PATH
  || path.join(defaultStoreDir, "recommendation-publication-ledger.json")
);
const trustedMaxFutureSkewMs = boundedRuntimeEnv(
  process.env,
  "TRUSTED_MAX_FUTURE_SKEW_SECONDS",
  { fallback: 300, min: 0, max: 3600 },
) * 1000;

const safeJsonParse = (text, fallback = null) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const validIso = (value, fallback = null) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
};

const latestIsoTime = (...values) => {
  const latestAllowed = Date.now() + trustedMaxFutureSkewMs;
  const times = values
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value) && value <= latestAllowed);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
};

const officialSportteryHttps = (value) => {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname.toLowerCase() === "webapi.sporttery.cn";
  } catch {
    return false;
  }
};

const normalizedSourceMatchId = (match) => canonicalSourceMatchId(match?.sourceMatchId || match?.id);

const exactScore = (match) => (
  Number.isInteger(match?.scoreHome)
  && Number.isInteger(match?.scoreAway)
  && match.scoreHome >= 0
  && match.scoreAway >= 0
);

const fastResultCandidate = (match) => Boolean(
  match
  && match.source === "sporttery"
  && match.status === "FINISHED"
  && normalizedSourceMatchId(match)
  && exactScore(match)
  && officialSportteryHttps(match.sourceUrl)
  && validIso(match.resultObservedAt)
  && String(match.resultObservationSource || match?.resultProvenance?.observationSource || "").trim()
  && match.resultObservationFallback !== true
  && match?.resultProvenance?.resultObservationFallback !== true
  && eventVersionOf(match)
  && Date.parse(match.resultObservedAt) >= Date.parse(match.kickoffTime || "")
);

// Correction authority is the selected, verified result probe. Runtime overlay
// cycles and current/calculator companion clocks are deliberately excluded.
const sourceCycleIdFor = (resultProbeRevision) => String(
  resultProbeRevision?.collectorCycleId || ""
).trim() || null;

const snapshotCopy = (value) => safeJsonParse(JSON.stringify(value), null);
const nonnegativeSafeInteger = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const explicitTerminalResultEntry = (entry) => {
  const payload = entry?.payload;
  const days = payload?.value?.matchInfoList;
  if (!Array.isArray(days)) return null;
  const matchInfoList = days.map((day) => ({
    ...day,
    subMatchList: (Array.isArray(day?.subMatchList) ? day.subMatchList : [])
      .filter(isExplicitSportteryTerminalRow),
  })).filter((day) => day.subMatchList.length > 0);
  if (!matchInfoList.length) return null;
  return {
    ...entry,
    payload: {
      ...payload,
      value: {
        ...payload.value,
        matchInfoList,
      },
    },
  };
};

const atomicWriteJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Cleanup cannot repair or invalidate an already committed SQLite row.
    }
  }
};

const readSyncMeta = (filePath) => {
  if (!fs.existsSync(filePath)) return {};
  return safeJsonParse(fs.readFileSync(filePath, "utf8"), {}) || {};
};

const publishSyncMetaRevision = ({
  filePath,
  publishedAt,
  sourceCycleId,
  datasetRevision,
  publishedRows,
  revision,
  observations = [],
}) => {
  const commitLock = acquireSyncMetaCommitLock({ filePath });
  try {
    // Re-read only after acquiring the shared commit lock. A full sync and the
    // fast publisher can now merge their latest state without a stale writer
    // replacing a newer receipt/revision.
    const existing = readSyncMeta(filePath);
    const existingRevision = nonnegativeSafeInteger(existing.fastResultRevision);
    const nextRevision = Math.max(existingRevision, nonnegativeSafeInteger(revision));
    const fastResultObservations = mergeFastResultObservations(
      existing.fastResultObservations,
      observations
    );
    const freshnessTime = latestIsoTime(
      existing.api?.freshnessTime,
      existing.updatedAt,
      existing.capturedAt,
      publishedAt
    );
    const currentFreshnessTime = latestIsoTime(
      existing.api?.currentFreshnessTime,
      existing.sourceHealth?.currentFreshnessTime,
      publishedAt
    );
    const resultFreshnessTime = latestIsoTime(
      existing.api?.resultFreshnessTime,
      existing.sourceHealth?.resultFreshnessTime,
      publishedAt
    );
    const historyFreshnessTime = latestIsoTime(
      existing.api?.historyFreshnessTime,
      existing.sourceHealth?.historyFreshnessTime,
      publishedAt
    );
    const next = {
      ...existing,
      lastAttemptAt: publishedAt,
      fastResultRevision: nextRevision,
      fastResultPublication: {
        version: "sqlite-fast-result-v1",
        publishedAt,
        sourceCycleId,
        datasetRevision,
        publishedRows,
      },
      fastResultObservations,
      sourceHealth: {
        ...(existing.sourceHealth || {}),
        ...(freshnessTime ? { sourceFreshnessTime: freshnessTime } : {}),
        ...(currentFreshnessTime ? { currentFreshnessTime } : {}),
        ...(resultFreshnessTime ? { resultFreshnessTime } : {}),
        ...(historyFreshnessTime ? { historyFreshnessTime } : {}),
      },
      api: {
        ...(existing.api || {}),
        ...(freshnessTime ? { freshnessTime } : {}),
        ...(currentFreshnessTime ? { currentFreshnessTime } : {}),
        ...(resultFreshnessTime ? { resultFreshnessTime } : {}),
        ...(historyFreshnessTime ? { historyFreshnessTime } : {}),
      },
    };
    atomicWriteJson(filePath, next);
    return {
      updated: true,
      revision: nextRevision,
      observationRows: fastResultObservations.rows.length,
    };
  } finally {
    commitLock.release();
  }
};

const recoverSyncMetaFromReceipt = ({ db, filePath, receiptState = null }) => {
  const state = receiptState || readFastResultReceiptState(db);
  const receipt = state?.valid && !state?.missing ? state.receipt : null;
  if (!receipt || receipt.version !== "sqlite-fast-result-receipt-v2") {
    return { updated: false, reason: "receipt-unavailable" };
  }
  const existing = readSyncMeta(filePath);
  const existingObservations = mergeFastResultObservations(existing.fastResultObservations, []);
  const receiptObservations = mergeFastResultObservations(null, receipt.observations || []);
  const existingKeys = new Set(existingObservations.rows.map((row) => row.key));
  const missingObservation = receiptObservations.rows.some((row) => !existingKeys.has(row.key));
  const existingRevision = nonnegativeSafeInteger(existing.fastResultRevision);
  const receiptRevision = nonnegativeSafeInteger(receipt.revision);
  const revisionBehind = existingRevision < receiptRevision;
  if (!revisionBehind && !missingObservation) {
    return { updated: false, reason: "already-visible", revision: existingRevision };
  }
  const result = publishSyncMetaRevision({
    filePath,
    publishedAt: receipt.publishedAt,
    sourceCycleId: receipt.sourceCycleId,
    datasetRevision: receipt.datasetRevision,
    publishedRows: Number(receipt.publishedRows || 0),
    revision: Number(receipt.revision || 0),
    observations: receiptObservations.rows,
  });
  return { ...result, recovered: true };
};

const tableExists = (db, name) => Boolean(db.prepare(
  "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
).get(name));

const metaValue = (db, key) => db.prepare(
  "SELECT value FROM schema_meta WHERE key = ?"
).get(key)?.value || null;

const upsertMeta = (db, key, value, updatedAt) => db.prepare(`
  INSERT INTO schema_meta (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`).run(key, String(value), updatedAt);

const parseMatchRows = (rows) => rows.map((row) => ({
  row,
  match: safeJsonParse(row.payload, null),
})).filter((entry) => entry.match && typeof entry.match === "object");

const predictionSnapshotRowsForSource = (db, sourceMatchId) => {
  if (!sourceMatchId || !tableExists(db, "prediction_snapshots")) return [];
  return db.prepare(`
    SELECT payload
    FROM prediction_snapshots
    WHERE source_match_id = ?
    ORDER BY captured_at ASC, id ASC
  `).all(sourceMatchId)
    .map((row) => safeJsonParse(row.payload, null))
    .filter((row) => row && typeof row === "object");
};

const attachStoredPreMatchArchive = ({
  db,
  match,
  publicationIndex = null,
  capturedAt,
}) => {
  if (!match || typeof match !== "object") return match;
  const sourceMatchId = normalizedSourceMatchId(match);
  const rows = predictionSnapshotRowsForSource(db, sourceMatchId);
  const clockRepairedMatch = recoverResultEventClockFromSnapshots(match, rows);
  return attachArchivedPreMatchPredictions(
    [clockRepairedMatch],
    { rows },
    publicationIndex,
    capturedAt
  )[0] || clockRepairedMatch;
};

const archiveComparable = (match) => JSON.stringify(
  match?.archivedPreMatchPrediction || null
);

const sameScore = (left, right) => (
  left?.scoreHome === right?.scoreHome && left?.scoreAway === right?.scoreAway
);

const officialResultMetadataComparable = (match) => JSON.stringify({
  officialResultIdentity: match?.officialResultIdentity || null,
  officialPayoutSp: match?.officialPayoutSp || null,
  resultSourceUpdatedAt: validIso(match?.resultSourceUpdatedAt, null),
});

const hasCompleteStoredReviewForScore = (match) => {
  const review = match?.postMatchReview;
  const settlement = review?.settlement;
  const predictionReview = review?.predictionReview;
  const expectedFinalScore = exactScore(match)
    ? `${match.scoreHome}-${match.scoreAway}`
    : null;
  return Boolean(
    expectedFinalScore
    && review?.version === "post-match-review-v2"
    && review.finalScore === expectedFinalScore
    && settlement?.version === "recommendation-settlement-v1"
    && Number(settlement.resultRevision || 0) >= 1
    && validIso(settlement.resultObservedAt, null)
    && String(settlement.resultObservationSource || "").trim()
    && settlement.resultObservationFallback !== true
    && predictionReview
    && typeof predictionReview === "object"
    && Array.isArray(predictionReview.rows)
  );
};

const officialAuthorityObservedAt = (match) => {
  const explicitAuthority = validIso(match?.resultAuthorityObservedAt, null);
  if (explicitAuthority) return explicitAuthority;
  const firstObservedAt = validIso(match?.resultObservedAt, null);
  const settlement = match?.postMatchReview?.settlement;
  const currentCycleId = String(match?.sourceCycleId || "").trim();
  const settlementCycleId = String(settlement?.sourceCycleId || "").trim();
  // Backward-compatible migration path for rows written before the dedicated
  // authority clock existed. The old fast publisher bound these review clocks
  // to the signed result receivedAt. Accept them only when the settlement is
  // atomically bound to the same persisted source cycle; otherwise fall back
  // to the immutable first observation and fail closed on ambiguous updates.
  const legacyBoundClocks = currentCycleId && settlementCycleId === currentCycleId
    ? [
        validIso(settlement?.reviewGeneratedAt, null),
        validIso(match?.postMatchReview?.generatedAt, null),
      ]
    : [];
  const times = [firstObservedAt, ...legacyBoundClocks]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
};

const officialAuthorityRevision = (match, authorityHighWater = null) => {
  const matchObservedAt = officialAuthorityObservedAt(match);
  const highWaterObservedAt = validIso(authorityHighWater?.observedAt, null);
  const matchMs = Date.parse(matchObservedAt || "");
  const highWaterMs = Date.parse(highWaterObservedAt || "");
  if (Number.isFinite(highWaterMs) && (!Number.isFinite(matchMs) || highWaterMs >= matchMs)) {
    return {
      observedAt: highWaterObservedAt,
      sourceCycleId: String(authorityHighWater?.sourceCycleId || "").trim(),
    };
  }
  return {
    observedAt: matchObservedAt,
    sourceCycleId: String(match?.sourceCycleId || "").trim(),
  };
};

const migrateLegacyFastResultIntegrity = (db, options = {}) => {
  const ownsTransaction = options.transactionOpen !== true;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  let transactionOpen = ownsTransaction;
  const rollbackOwned = () => {
    if (!ownsTransaction || !transactionOpen) return;
    db.exec("ROLLBACK");
    transactionOpen = false;
  };
  try {
    const receiptState = readFastResultReceiptState(db);
    if (!receiptState.legacy) {
      rollbackOwned();
      return { ok: false, reason: "legacy-receipt-no-longer-migratable" };
    }
    const authorityState = loadAuthorityHighWater(db);
    if (!authorityState.valid || !authorityState.missing) {
      rollbackOwned();
      return { ok: false, reason: "legacy-authority-state-not-empty" };
    }
    const historyRows = parseMatchRows(db.prepare(`
      SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload
      FROM match_snapshots
      WHERE dataset = 'history'
      ORDER BY id ASC
    `).all());
    const trustedHistory = historyRows.filter((entry) => (
      isOfficialSportteryFinal(entry.match)
      && isTrustedFinishedForSettlement(entry.match)
    ));
    // Resolve every legacy observation onto receipt-proven current authority.
    // A historical Beijing-midnight clock is retained in the receipt root as
    // audit evidence, but it cannot become authority by itself.  The resolved
    // event must also have one exact-event observation for its current score.
    const receiptAuthority = resolveFastResultReceiptAuthorities({
      observations: receiptState.observations,
      historyRows: trustedHistory,
    });
    if (!receiptAuthority.ok) {
      rollbackOwned();
      return receiptAuthority;
    }
    const authorityCandidates = [];
    for (const { authorityEntry } of receiptAuthority.groups) {
      const { match } = authorityEntry;
      const cycleId = String(
        match?.sourceCycleId
        || match?.postMatchReview?.settlement?.sourceCycleId
        || ""
      ).trim();
      const authorityObservedAt = officialAuthorityObservedAt(match);
      const authorityCandidate = authorityHighWaterCandidate({
        match,
        observedAt: authorityObservedAt,
        sourceCycleId: cycleId,
        resultProbeRevisionId: null,
      });
      if (!authorityCandidate) {
        rollbackOwned();
        return { ok: false, reason: "legacy-history-authority-incomplete" };
      }
      authorityCandidates.push(authorityCandidate);
    }
    // Do not manufacture receipt observations from unrelated history rows.
    // The v1 rows are already normalized and unique; preserving them verbatim
    // keeps corrections and legacy aliases auditable without trust expansion.
    const mergedObservations = receiptAuthority.observations;
    const authorityMerge = mergeAuthorityHighWater(authorityState, authorityCandidates);
    if (!authorityMerge.valid) {
      rollbackOwned();
      return { ok: false, reason: "legacy-authority-migration-invalid" };
    }
    const receipt = {
      ...receiptState.receipt,
      version: "sqlite-fast-result-receipt-v2",
      observations: mergedObservations,
      observationsRootHash: fastResultReceiptRoot(mergedObservations),
    };
    const updatedAt = validIso(receipt.publishedAt, null);
    upsertMeta(db, "fast_result_receipt", JSON.stringify(receipt), updatedAt);
    upsertMeta(db, "fast_result_source_cycle_id", receipt.sourceCycleId, updatedAt);
    upsertMeta(db, "fast_result_dataset_revision", receipt.datasetRevision, updatedAt);
    persistAuthorityHighWater(db, authorityMerge, updatedAt);
    if (ownsTransaction) {
      db.exec("COMMIT");
      transactionOpen = false;
    }
    return {
      ok: true,
      migrated: true,
      observations: mergedObservations.length,
      authorityRows: authorityMerge.rows.length,
      legacyAliasObservations: receiptAuthority.legacyAliasObservations,
      revision: receiptState.revision,
    };
  } catch (error) {
    if (ownsTransaction && transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the migration error.
      }
    }
    return { ok: false, reason: "legacy-receipt-migration-error", error: error.message };
  }
};

const canApplyOfficialCorrection = ({
  current,
  incomingObservedAt,
  sourceCycleId,
  authorityHighWater = null,
}) => {
  const incomingTime = Date.parse(incomingObservedAt || "");
  // Chronology belongs exclusively to the persisted official observation,
  // never to local review/generated clocks or wall time.
  const currentRevision = officialAuthorityRevision(current, authorityHighWater);
  const currentTime = Date.parse(currentRevision.observedAt || "");
  const priorCycleId = currentRevision.sourceCycleId;
  const incomingCycleId = String(sourceCycleId || "").trim();
  return Number.isFinite(incomingTime)
    && Number.isFinite(currentTime)
    && incomingTime > currentTime
    && Boolean(incomingCycleId)
    && (!priorCycleId || priorCycleId !== incomingCycleId);
};

const isPlainRecord = (value) => Boolean(
  value && typeof value === "object" && !Array.isArray(value)
);

const hasOfficialValue = (value) => (
  value !== undefined && value !== null && value !== ""
);

const cloneJsonValue = (value) => (
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))
);

// Preserve every existing official value, filling only fields that are absent.
// This permits recovery of an incomplete same-clock archive without turning a
// replay into authority to replace or erase payout/identity metadata.
const fillMissingOfficialValue = (current, incoming) => {
  if (!hasOfficialValue(current)) {
    return hasOfficialValue(incoming) ? cloneJsonValue(incoming) : current;
  }
  if (!isPlainRecord(current) || !isPlainRecord(incoming)) return cloneJsonValue(current);
  const merged = cloneJsonValue(current) || {};
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = fillMissingOfficialValue(current[key], value);
  }
  return merged;
};

// A strictly newer signed revision may replace explicit values, but omission
// is never deletion. Providers occasionally omit payout blocks on later polls;
// such a poll must retain the last official payout.
const overlayNewerOfficialValue = (current, incoming) => {
  if (!hasOfficialValue(incoming)) return cloneJsonValue(current);
  if (isPlainRecord(current) && isPlainRecord(incoming)) {
    const merged = cloneJsonValue(current) || {};
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = overlayNewerOfficialValue(current[key], value);
    }
    return merged;
  }
  return cloneJsonValue(incoming);
};

const officialValueConflicts = (current, incoming) => {
  if (!hasOfficialValue(incoming) || !hasOfficialValue(current)) return false;
  if (isPlainRecord(current) && isPlainRecord(incoming)) {
    return Object.entries(incoming).some(([key, value]) => (
      officialValueConflicts(current[key], value)
    ));
  }
  return JSON.stringify(current) !== JSON.stringify(incoming);
};

const officialMetadataUpdatePlan = ({
  current,
  incoming,
  incomingObservedAt,
  sourceCycleId,
  authorityHighWater = null,
}) => {
  const incomingTime = Date.parse(incomingObservedAt || "");
  const currentTime = Date.parse(
    officialAuthorityRevision(current, authorityHighWater).observedAt || ""
  );
  const strictAdvance = canApplyOfficialCorrection({
    current,
    incomingObservedAt,
    sourceCycleId,
    authorityHighWater,
  });
  const sameClock = Number.isFinite(incomingTime)
    && Number.isFinite(currentTime)
    && incomingTime === currentTime;
  const identityConflict = officialValueConflicts(
    current?.officialResultIdentity,
    incoming?.officialResultIdentity,
  );
  const payoutConflict = officialValueConflicts(
    current?.officialPayoutSp,
    incoming?.officialPayoutSp,
  );
  const providerClockConflict = officialValueConflicts(
    validIso(current?.resultSourceUpdatedAt, null),
    validIso(incoming?.resultSourceUpdatedAt, null),
  );
  const conflicts = identityConflict || payoutConflict || providerClockConflict;
  const fillOnly = {
    officialResultIdentity: fillMissingOfficialValue(
      current?.officialResultIdentity,
      incoming?.officialResultIdentity,
    ),
    officialPayoutSp: fillMissingOfficialValue(
      current?.officialPayoutSp,
      incoming?.officialPayoutSp,
    ),
    resultSourceUpdatedAt: fillMissingOfficialValue(
      validIso(current?.resultSourceUpdatedAt, null),
      validIso(incoming?.resultSourceUpdatedAt, null),
    ),
  };
  const newerOverlay = {
    officialResultIdentity: overlayNewerOfficialValue(
      current?.officialResultIdentity,
      incoming?.officialResultIdentity,
    ),
    officialPayoutSp: overlayNewerOfficialValue(
      current?.officialPayoutSp,
      incoming?.officialPayoutSp,
    ),
    resultSourceUpdatedAt: overlayNewerOfficialValue(
      validIso(current?.resultSourceUpdatedAt, null),
      validIso(incoming?.resultSourceUpdatedAt, null),
    ),
  };
  const resolved = strictAdvance
    ? newerOverlay
    : sameClock && !conflicts
      ? fillOnly
      : {
          officialResultIdentity: cloneJsonValue(current?.officialResultIdentity),
          officialPayoutSp: cloneJsonValue(current?.officialPayoutSp),
          resultSourceUpdatedAt: validIso(current?.resultSourceUpdatedAt, null),
        };
  const currentComparable = officialResultMetadataComparable(current);
  const resolvedComparable = officialResultMetadataComparable(resolved);
  const fillRequested = officialResultMetadataComparable(fillOnly) !== currentComparable;
  return {
    strictAdvance,
    sameClock,
    conflicts,
    resolved,
    acceptedMetadataChanged: resolvedComparable !== currentComparable,
    reject: !strictAdvance && (conflicts || (fillRequested && !sameClock)),
  };
};

const mergeDuplicateOfficialValue = (left, right) => {
  if (!hasOfficialValue(left)) return { ok: true, value: cloneJsonValue(right) };
  if (!hasOfficialValue(right)) return { ok: true, value: cloneJsonValue(left) };
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const merged = {};
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const nested = mergeDuplicateOfficialValue(left[key], right[key]);
      if (!nested.ok) return nested;
      if (nested.value !== undefined) merged[key] = nested.value;
    }
    return { ok: true, value: merged };
  }
  if (stableStringify(left) !== stableStringify(right)) return { ok: false, value: null };
  return { ok: true, value: cloneJsonValue(left) };
};

const DUPLICATE_OFFICIAL_RESULT_FIELDS = Object.freeze([
  "status",
  "sourceStatus",
  "effectiveStatus",
  "scoreHome",
  "scoreAway",
  "homeTeamCode",
  "awayTeamCode",
  "homeTeamId",
  "awayTeamId",
  "officialResultIdentity",
  "officialPayoutSp",
  "resultSourceUpdatedAt",
]);
const DUPLICATE_TEAM_ALIAS_FIELDS = Object.freeze([
  "homeTeam",
  "awayTeam",
  "homeTeamName",
  "awayTeamName",
]);

const mergeDuplicateOfficialResult = (left, right) => {
  if (!sameAuthorityEvent(left, right)) return { ok: false, row: null };
  const ordered = [left, right].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const merged = snapshotCopy(ordered[0]);
  for (const field of DUPLICATE_OFFICIAL_RESULT_FIELDS) {
    const value = mergeDuplicateOfficialValue(left?.[field], right?.[field]);
    if (!value.ok) return { ok: false, row: null };
    if (value.value === undefined) delete merged[field];
    else merged[field] = value.value;
  }
  for (const field of DUPLICATE_TEAM_ALIAS_FIELDS) {
    const candidates = [left?.[field], right?.[field]]
      .filter(hasOfficialValue)
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
    if (candidates.length > 0) merged[field] = cloneJsonValue(candidates[0]);
    else delete merged[field];
  }
  return { ok: true, row: merged };
};

const selectRelayCandidates = (normalizedRows) => {
  const groupsByEvent = new Map();
  const rejected = {
    untrusted: 0,
    duplicateConflict: 0,
  };
  for (const row of normalizedRows) {
    if (!fastResultCandidate(row)) {
      rejected.untrusted += 1;
      continue;
    }
    const eventIdentity = authorityIdentityKey({
      sourceMatchId: normalizedSourceMatchId(row),
      eventVersion: eventVersionOf(row),
    });
    if (!eventIdentity) {
      rejected.untrusted += 1;
      continue;
    }
    const group = groupsByEvent.get(eventIdentity.key);
    if (!group) {
      groupsByEvent.set(eventIdentity.key, { row, conflict: false });
      continue;
    }
    const merged = mergeDuplicateOfficialResult(group.row, row);
    if (!merged.ok) group.conflict = true;
    else group.row = merged.row;
  }

  const rows = [];
  for (const group of groupsByEvent.values()) {
    if (group.conflict) rejected.duplicateConflict += 1;
    else rows.push(group.row);
  }
  return { rows, rejected };
};

const loadLedgerIndex = (ledgerPath) => {
  const loaded = loadPublicationLedger(ledgerPath);
  return {
    loaded,
    index: buildPublicationLedgerIndex(loaded),
  };
};

const skippedResult = (startedAt, reason, extra = {}) => ({
  ok: true,
  phase: "official-result-fast-publication",
  skipped: true,
  reason,
  startedAt,
  finishedAt: new Date().toISOString(),
  publishedRows: 0,
  ...extra,
});

const authorityHighWaterFailureReason = (merge) => (
  merge?.identityConflict
    ? "authority-high-water-identity-conflict"
    : merge?.scoreConflict
      ? "authority-high-water-score-conflict"
      : "authority-high-water-overflow"
);

const publishOfficialResultsFast = (options = {}) => {
  const startedAt = new Date().toISOString();
  const dbPath = path.resolve(options.dbPath || defaultDbPath);
  const syncMetaPath = path.resolve(options.syncMetaPath || defaultSyncMetaPath);
  const publicationLedgerPath = path.resolve(options.publicationLedgerPath || defaultPublicationLedgerPath);
  if (!fs.existsSync(dbPath)) return skippedResult(startedAt, "sqlite-database-missing");

  // Capture the loader result once, then audit and consume this exact immutable
  // value. No validation/read-again window exists for a file replacement to
  // swap in a different payload after verification.
  const suppliedRelaySnapshot = Object.prototype.hasOwnProperty.call(options, "relaySnapshot");
  const relaySnapshot = snapshotCopy(
    suppliedRelaySnapshot
      ? options.relaySnapshot
      : loadSportteryRelayFastSnapshotForAudit()
  );
  if (!relaySnapshot) return skippedResult(startedAt, "trusted-relay-snapshot-unavailable");
  const contractSnapshot = suppliedRelaySnapshot ? relaySnapshot : relaySnapshot.payload;
  let endpointTrust = null;
  if (!suppliedRelaySnapshot) {
    const eligibility = auditRelayFastResultEligibility(contractSnapshot, {
      trustRegistry: options.trustRegistry,
    });
    if (!eligibility.eligible) {
      return skippedResult(startedAt, "trusted-fast-result-endpoints-unavailable", {
        trustBlockers: [eligibility.blocker || "relay-fast-eligibility-invalid"],
        verifiedFastEndpoints: 0,
      });
    }
    endpointTrust = eligibility.endpointTrust;
  }
  endpointTrust ||= auditTrustedFastResultEndpoints(contractSnapshot, {
      trustRegistry: options.trustRegistry,
      // Explicit in-process fixtures may model a composed archive envelope;
      // the production raw-file boundary above is always strict and rejects
      // every endpoint outside current/calculator/result:1.
      allowAdditionalEndpoints: suppliedRelaySnapshot,
      requireMarketLane: true,
    });
  if (!endpointTrust.eligible) {
    return skippedResult(startedAt, "trusted-fast-result-endpoints-unavailable", {
      trustBlockers: endpointTrust.blockers,
      verifiedFastEndpoints: 0,
    });
  }
  // The raw endpoint set must be audited before this availability check. This
  // ordering prevents duplicate/bad endpoints from being removed by freshness
  // filtering and then accepted as a clean publisher input. A future result
  // probe is handled by the signed result clock check below; only the companion
  // current lane must already be fresh here.
  if (!suppliedRelaySnapshot && relaySnapshot.summary?.currentFresh !== true) {
    return skippedResult(startedAt, "trusted-relay-snapshot-unavailable", {
      verifiedFastEndpoints: endpointTrust.entries.length,
      relaySummary: relaySnapshot.summary || null,
    });
  }
  const resultEntry = explicitTerminalResultEntry(endpointTrust.resultEndpoint);
  const resultProbeRevision = endpointTrust.resultProbeRevision;
  const sourceCycleId = sourceCycleIdFor(resultProbeRevision);
  const observedAt = validIso(resultProbeRevision?.receivedAt, null);
  if (!resultEntry) {
    return skippedResult(startedAt, "no-explicit-official-terminal-results", {
      sourceCycleId,
      verifiedFastEndpoints: endpointTrust.entries.length,
      resultProbeRevisionId: endpointTrust.resultProbeRevisionId,
    });
  }
  const verifiedResultSnapshot = {
    payload: {
      version: 1,
      source: "sporttery-verified-fast-result-probe",
      capturedAt: observedAt,
      sourceCycleId,
    },
    summary: { capturedAt: observedAt },
    entries: [resultEntry],
  };
  // Only result:1 can create settlement candidates. current/calculator remain
  // structural companions and cannot borrow result authority for their rows.
  const normalizedRows = matchesFromSportteryRelaySnapshot(verifiedResultSnapshot);
  const selected = selectRelayCandidates(normalizedRows);
  if (!selected.rows.length) {
    return skippedResult(startedAt, "no-trusted-finished-results", {
      sourceCycleId,
      scannedRows: normalizedRows.length,
      rejected: selected.rejected,
    });
  }

  if (!observedAt) {
    return skippedResult(startedAt, "trusted-result-probe-clock-unavailable", { sourceCycleId });
  }
  if (Date.parse(observedAt) > Date.now() + trustedMaxFutureSkewMs) {
    return skippedResult(startedAt, "trusted-result-probe-clock-in-future", {
      sourceCycleId,
      observedAt,
      maxFutureSkewSeconds: Math.round(trustedMaxFutureSkewMs / 1000),
    });
  }
  let ledger = null;
  let ledgerLoaded = false;
  let db = null;
  let transactionOpen = false;
  let writeTransactionStarted = false;
  const rejection = {
    alreadyPublished: 0,
    currentMissing: 0,
    eventMismatch: 0,
    historyConflict: 0,
    correctionRejected: 0,
    invalidFinal: 0,
    reviewMissing: 0,
  };
  const published = [];
  const observations = [];
  let receiptObservations = [];
  let revision = 0;
  let datasetRevision = null;
  let publishedAt = null;
  let committedAt = null;
  let metaRecovery = { updated: false, reason: "not-checked" };
  let integrityMigration = { migrated: false, reason: "not-required" };
  let authorityHighWaterUpdated = false;
  let authorityHighWaterRows = 0;

  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    if (!tableExists(db, "match_snapshots") || !tableExists(db, "schema_meta")) {
      return skippedResult(startedAt, "sqlite-schema-unavailable", { sourceCycleId });
    }
    let preflightReceiptState = readFastResultReceiptState(db);
    if (preflightReceiptState.legacy) {
      integrityMigration = migrateLegacyFastResultIntegrity(db);
      writeTransactionStarted = true;
      if (!integrityMigration.ok) {
        return skippedResult(startedAt, "fast-result-receipt-invalid", {
          sourceCycleId,
          receiptBlocker: integrityMigration.reason,
        });
      }
      preflightReceiptState = readFastResultReceiptState(db);
    }
    if (!preflightReceiptState.valid) {
      return skippedResult(startedAt, "fast-result-receipt-invalid", {
        sourceCycleId,
        receiptBlocker: preflightReceiptState.reason,
      });
    }
    metaRecovery = recoverSyncMetaFromReceipt({
      db,
      filePath: syncMetaPath,
      receiptState: preflightReceiptState,
    });
    const preflightAuthorityHighWater = loadAuthorityHighWater(db);
    if (!preflightAuthorityHighWater.valid) {
      return skippedResult(startedAt, "authority-high-water-invalid", {
        sourceCycleId,
        verifiedFastEndpoints: endpointTrust.entries.length,
      });
    }
    if (
      preflightAuthorityHighWater.missing
      && (
        preflightReceiptState.missing === false
      )
    ) {
      return skippedResult(startedAt, "authority-high-water-uninitialized", {
        sourceCycleId,
        verifiedFastEndpoints: endpointTrust.entries.length,
      });
    }
    const preflightAuthorityCandidates = [];
    let preflightAuthorityEventMissing = false;

    // The relay file receives a fresh capture clock even when every official
    // score is unchanged. Prove the whole batch is already present before
    // loading the publication ledger or taking SQLite's single-writer lock.
    // Any ambiguity, correction, missing review, or stale review schema falls
    // through to the existing atomic reconciliation path below.
    const preflightHistoryRowsForSource = db.prepare(`
      SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload
      FROM match_snapshots
      WHERE dataset = 'history' AND source_match_id = ?
    `);
    const fastNoopRows = selected.rows.map((result) => {
      const sourceMatchId = normalizedSourceMatchId(result);
      const exactTerminalHistory = parseMatchRows(
        preflightHistoryRowsForSource.all(sourceMatchId)
      )
        .map((entry) => ({
          ...entry,
          resolved: resolveMatchLifecycle(entry.match),
          incoming: reconcileOfficialResultClock(entry.match, result),
        }))
        .filter((entry) => (
          entry.resolved.status === "FINISHED"
          && sameAuthorityEvent(entry.match, entry.incoming)
        ));
      const entry = exactTerminalHistory.length === 1 ? exactTerminalHistory[0] : null;
      const archiveCandidate = entry
        ? attachStoredPreMatchArchive({
            db,
            match: entry.match,
            capturedAt: validIso(result?.resultObservedAt, new Date().toISOString()),
          })
        : null;
      const archiveRepairRequired = Boolean(
        entry
        && archiveComparable(entry.match) !== archiveComparable(archiveCandidate)
      );
      const authorityIdentityMatch = archiveCandidate || entry?.match || null;
      const recoveredAuthorityHighWater = entry
        ? authorityHighWaterRow(preflightAuthorityHighWater, authorityIdentityMatch)
        : null;
      const legacyAuthorityHighWater = entry
        ? authorityHighWaterRow(preflightAuthorityHighWater, entry.match)
        : null;
      const historyAuthorityHighWater = recoveredAuthorityHighWater || legacyAuthorityHighWater;
      const metadataPlan = entry
        ? officialMetadataUpdatePlan({
            current: entry.match,
            incoming: entry.incoming,
            incomingObservedAt: validIso(result?.resultObservedAt, null),
            sourceCycleId,
            authorityHighWater: historyAuthorityHighWater,
          })
        : null;
      if (
        entry
        && preflightAuthorityHighWater.initialized
        && !historyAuthorityHighWater
        && (
          !sameScore(entry.resolved, entry.incoming)
          || metadataPlan?.conflicts === true
        )
      ) {
        preflightAuthorityEventMissing = true;
      }
      if (entry) {
        preflightAuthorityCandidates.push(authorityHighWaterCandidate({
          match: authorityIdentityMatch,
          observedAt: officialAuthorityObservedAt(entry.match),
          sourceCycleId: entry.match?.sourceCycleId,
          resultProbeRevisionId: null,
        }));
        if (!recoveredAuthorityHighWater && legacyAuthorityHighWater) {
          preflightAuthorityCandidates.push(authorityHighWaterCandidate({
            match: authorityIdentityMatch,
            observedAt: legacyAuthorityHighWater.observedAt,
            sourceCycleId: legacyAuthorityHighWater.sourceCycleId,
            resultProbeRevisionId: legacyAuthorityHighWater.resultProbeRevisionId,
          }));
        }
        preflightAuthorityCandidates.push(authorityHighWaterCandidate({
          match: authorityIdentityMatch,
          observedAt: validIso(result?.resultObservedAt, null),
          sourceCycleId,
          resultProbeRevisionId: endpointTrust.resultProbeRevisionId,
        }));
      }
      return Boolean(
        entry
        && sameScore(entry.resolved, entry.incoming)
        && metadataPlan?.reject !== true
        && metadataPlan?.acceptedMetadataChanged !== true
        && isOfficialSportteryFinal(entry.resolved)
        && isTrustedFinishedForSettlement(entry.resolved)
        && hasCompleteStoredReviewForScore(entry.match)
        && !archiveRepairRequired
      );
    });
    if (preflightAuthorityEventMissing) {
      return skippedResult(startedAt, "authority-high-water-event-missing", {
        sourceCycleId,
        verifiedFastEndpoints: endpointTrust.entries.length,
      });
    }
    if (fastNoopRows.length > 0 && fastNoopRows.every(Boolean)) {
      const preflightHighWaterMerge = mergeAuthorityHighWater(
        preflightAuthorityHighWater,
        preflightAuthorityCandidates,
      );
      if (!preflightHighWaterMerge.valid) {
        return skippedResult(startedAt, authorityHighWaterFailureReason(preflightHighWaterMerge), {
          sourceCycleId,
          verifiedFastEndpoints: endpointTrust.entries.length,
        });
      }
      if (preflightHighWaterMerge.changed) {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        writeTransactionStarted = true;
        const lockedAuthorityHighWater = loadAuthorityHighWater(db);
        if (!lockedAuthorityHighWater.valid) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return skippedResult(startedAt, "authority-high-water-invalid", {
            sourceCycleId,
            verifiedFastEndpoints: endpointTrust.entries.length,
          });
        }
        const lockedHighWaterMerge = mergeAuthorityHighWater(
          lockedAuthorityHighWater,
          preflightAuthorityCandidates,
        );
        if (!lockedHighWaterMerge.valid) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return skippedResult(startedAt, authorityHighWaterFailureReason(lockedHighWaterMerge), {
            sourceCycleId,
            verifiedFastEndpoints: endpointTrust.entries.length,
          });
        }
        if (lockedHighWaterMerge.changed) {
          authorityHighWaterUpdated = persistAuthorityHighWater(
            db,
            lockedHighWaterMerge,
            observedAt,
          );
          authorityHighWaterRows = lockedHighWaterMerge.rows.length;
          db.exec("COMMIT");
        } else {
          db.exec("ROLLBACK");
        }
        transactionOpen = false;
      }
      const common = {
        sourceCycleId,
        scannedRows: normalizedRows.length,
        trustedFinishedRows: selected.rows.length,
        fastPath: true,
        ledgerLoaded: false,
        writeTransactionStarted,
        authorityHighWaterUpdated,
        authorityHighWaterRows,
        metaRecovery,
        integrityMigration,
        rejected: { ...selected.rejected, ...rejection },
      };
      if (metaRecovery.updated) {
        return {
          ok: true,
          phase: "official-result-fast-published",
          skipped: false,
          visibleStateChanged: true,
          reason: "sync-meta-recovered-from-sqlite-receipt",
          startedAt,
          finishedAt: new Date().toISOString(),
          publishedRows: 0,
          ...common,
        };
      }
      return skippedResult(startedAt, "no-result-state-change-fast-path", common);
    }

    ledger = loadLedgerIndex(publicationLedgerPath);
    ledgerLoaded = true;
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    writeTransactionStarted = true;
    const transactionAuthorityHighWater = loadAuthorityHighWater(db);
    if (!transactionAuthorityHighWater.valid) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return skippedResult(startedAt, "authority-high-water-invalid", {
        sourceCycleId,
        verifiedFastEndpoints: endpointTrust.entries.length,
      });
    }
    const transactionReceiptState = readFastResultReceiptState(db);
    if (!transactionReceiptState.valid) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return skippedResult(startedAt, "fast-result-receipt-invalid", {
        sourceCycleId,
        receiptBlocker: transactionReceiptState.reason,
      });
    }
    const transactionAuthorityCandidates = [];
    const priorReceiptObservations = transactionReceiptState.observations;
    revision = transactionReceiptState.revision + 1;
    datasetRevision = `sqlite-fast-result-r${revision}`;
    const currentRowsForSource = db.prepare(`
      SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload
      FROM match_snapshots
      WHERE dataset = 'current' AND source_match_id = ?
    `);
    const historyRowsForSource = db.prepare(`
      SELECT id, dataset, match_id, source_match_id, kickoff_time, status, payload
      FROM match_snapshots
      WHERE dataset = 'history' AND source_match_id = ?
    `);
    const rowById = db.prepare("SELECT id, dataset, payload FROM match_snapshots WHERE id = ?");
    const insertHistory = db.prepare(`
      INSERT INTO match_snapshots
        (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
      VALUES (?, 'history', ?, ?, ?, 'FINISHED', ?)
    `);
    const deleteCurrent = db.prepare(
      "DELETE FROM match_snapshots WHERE id = ? AND dataset = 'current'"
    );
    const updateHistory = db.prepare(`
      UPDATE match_snapshots
      SET match_id = ?, source_match_id = ?, kickoff_time = ?, status = 'FINISHED', payload = ?
      WHERE id = ? AND dataset = 'history'
    `);

    for (const sourceResult of selected.rows) {
      let result = sourceResult;
      const observedAtForResult = validIso(result.resultObservedAt, null);
      if (!observedAtForResult) {
        rejection.invalidFinal += 1;
        continue;
      }
      const sourceMatchId = normalizedSourceMatchId(result);
      const historyEntries = parseMatchRows(historyRowsForSource.all(sourceMatchId));
      const terminalHistory = historyEntries
        .map((entry) => ({
          ...entry,
          resolved: resolveMatchLifecycle(entry.match),
          incoming: reconcileOfficialResultClock(entry.match, result),
        }))
        .filter((entry) => entry.resolved.status === "FINISHED");
      const exactTerminalHistory = terminalHistory.filter((entry) => (
        sameAuthorityEvent(entry.match, entry.incoming)
      ));
      if (exactTerminalHistory.length > 1) {
        rejection.historyConflict += 1;
        continue;
      }
      const historyEntry = exactTerminalHistory[0] || null;
      let currentEntry = null;
      let audited = null;
      let changeType = "initial-result";
      let historyArchiveChanged = false;
      let historyResultMetadataChanged = false;
      let persistedResultObservedAt = observedAtForResult;
      let persistedAuthorityObservedAt = observedAtForResult;
      let persistedSourceCycleId = sourceCycleId;

      if (historyEntry) {
        const historyBase = attachStoredPreMatchArchive({
          db,
          match: historyEntry.match,
          publicationIndex: ledger.index,
          capturedAt: observedAtForResult,
        });
        historyArchiveChanged = archiveComparable(historyEntry.match) !== archiveComparable(historyBase);
        // Rebind from the original result-source row after archive recovery.
        // historyEntry.incoming may already have inherited the polluted 00:00
        // placeholder and would otherwise overwrite the uniquely recovered
        // pre-match eventVersion while leaving the archive internally split.
        result = reconcileOfficialResultClock(historyBase, sourceResult);
        const recoveredAuthorityHighWater = authorityHighWaterRow(
          transactionAuthorityHighWater,
          historyBase,
        );
        const legacyAuthorityHighWater = authorityHighWaterRow(
          transactionAuthorityHighWater,
          historyEntry.match,
        );
        const historyAuthorityHighWater = recoveredAuthorityHighWater || legacyAuthorityHighWater;
        const sameStoredScore = sameScore(historyEntry.resolved, result);
        const metadataPlan = sameStoredScore
          ? officialMetadataUpdatePlan({
              current: historyEntry.match,
              incoming: result,
              incomingObservedAt: observedAtForResult,
              sourceCycleId,
              authorityHighWater: historyAuthorityHighWater,
            })
          : null;
        if (
          transactionAuthorityHighWater.initialized
          && !historyAuthorityHighWater
          && (!sameStoredScore || metadataPlan?.conflicts === true)
        ) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return skippedResult(startedAt, "authority-high-water-event-missing", {
            sourceCycleId,
            verifiedFastEndpoints: endpointTrust.entries.length,
          });
        }
        transactionAuthorityCandidates.push(authorityHighWaterCandidate({
          match: historyBase,
          observedAt: officialAuthorityObservedAt(historyEntry.match),
          sourceCycleId: historyEntry.match?.sourceCycleId,
          resultProbeRevisionId: null,
        }));
        if (!recoveredAuthorityHighWater && legacyAuthorityHighWater) {
          transactionAuthorityCandidates.push(authorityHighWaterCandidate({
            match: historyBase,
            observedAt: legacyAuthorityHighWater.observedAt,
            sourceCycleId: legacyAuthorityHighWater.sourceCycleId,
            resultProbeRevisionId: legacyAuthorityHighWater.resultProbeRevisionId,
          }));
        }
        if (sameStoredScore) {
          if (metadataPlan.reject) {
            rejection.correctionRejected += 1;
            continue;
          }
          historyResultMetadataChanged = metadataPlan.acceptedMetadataChanged;
          const advancesOfficialRevision = metadataPlan.strictAdvance
            && historyResultMetadataChanged;
          persistedResultObservedAt = validIso(
            historyEntry.match?.resultObservedAt,
            observedAtForResult,
          );
          persistedAuthorityObservedAt = metadataPlan.strictAdvance
            ? observedAtForResult
            : validIso(
                historyEntry.match?.resultAuthorityObservedAt,
                persistedResultObservedAt,
              );
          persistedSourceCycleId = metadataPlan.strictAdvance
            ? sourceCycleId
            : String(historyEntry.match?.sourceCycleId || sourceCycleId);
          // An exact terminal row may still predate the review schema or may
          // have lost its embedded review during a partial rebuild. Recompute
          // it below and publish only when the compact review really changes.
          const observedHistory = resolveMatchLifecycle({
            ...historyBase,
            status: "FINISHED",
            sourceStatus: "FINISHED",
            scoreHome: result.scoreHome,
            scoreAway: result.scoreAway,
            source: result.source || historyEntry.match.source,
            sourceMethod: result.sourceMethod,
            sourceUrl: result.sourceUrl,
            sourceMatchId,
            resultSource: result.resultSource || "sporttery:official-api",
            resultUpdatedAt: advancesOfficialRevision
              ? (metadataPlan.resolved.resultSourceUpdatedAt || observedAtForResult)
              : (historyEntry.match?.resultUpdatedAt || persistedResultObservedAt),
            resultSourceUpdatedAt: metadataPlan.resolved.resultSourceUpdatedAt || null,
            resultObservedAt: persistedResultObservedAt,
            resultObservationSource: advancesOfficialRevision
              ? result.resultObservationSource
              : (historyEntry.match?.resultObservationSource || result.resultObservationSource),
            resultObservationFallback: false,
            officialResultIdentity: metadataPlan.resolved.officialResultIdentity,
            officialPayoutSp: metadataPlan.resolved.officialPayoutSp,
            eventVersion: result.eventVersion || eventVersionOf(result),
            resultProvenance: advancesOfficialRevision
              ? result.resultProvenance
              : historyBase.resultProvenance,
          }, { now: observedAtForResult });
          audited = attachResultAuditTimestamps(
            observedHistory,
            historyBase,
            persistedResultObservedAt
          );
          changeType = "review-refresh";
        } else {
          // Default lifecycle reconciliation keeps the first terminal score.
          // This narrow correction path is allowed only for one exact event,
          // one unambiguous official score, a distinct source cycle and a
          // strictly newer official observation clock.
          if (transactionAuthorityHighWater.missing || !canApplyOfficialCorrection({
            current: historyEntry.match,
            incomingObservedAt: observedAtForResult,
            sourceCycleId,
            authorityHighWater: historyAuthorityHighWater,
          })) {
            rejection.correctionRejected += 1;
            rejection.historyConflict += 1;
            continue;
          }
          const corrected = resolveMatchLifecycle({
            ...historyBase,
            status: "FINISHED",
            sourceStatus: "FINISHED",
            effectiveStatus: "FINISHED",
            scoreHome: result.scoreHome,
            scoreAway: result.scoreAway,
            officialResultIdentity: result.officialResultIdentity,
            officialPayoutSp: result.officialPayoutSp,
            sourceMethod: result.sourceMethod,
            sourceUrl: result.sourceUrl,
            resultSource: "sporttery:official-correction",
            resultUpdatedAt: result.resultSourceUpdatedAt || observedAtForResult,
            resultSourceUpdatedAt: result.resultSourceUpdatedAt || null,
            resultObservedAt: observedAtForResult,
            resultObservationSource: result.resultObservationSource,
            resultObservationFallback: false,
            eventVersion: result.eventVersion || eventVersionOf(result),
            resultProvenance: undefined,
            sourceCycleId,
            datasetRevision,
          }, { now: observedAtForResult });
          if (!isOfficialSportteryFinal(corrected) || !isTrustedFinishedForSettlement(corrected)) {
            rejection.invalidFinal += 1;
            continue;
          }
          audited = attachResultAuditTimestamps(corrected, historyBase, observedAtForResult);
          changeType = "official-score-correction";
        }
      } else {
        const currentEntries = parseMatchRows(currentRowsForSource.all(sourceMatchId));
        const matchingCurrent = currentEntries
          .map((entry) => ({
            ...entry,
            incoming: reconcileOfficialResultClock(entry.match, result),
          }))
          .filter((entry) => (
            normalizedSourceMatchId(entry.match) === sourceMatchId
            && sameAuthorityEvent(entry.match, entry.incoming)
          ));
        if (matchingCurrent.length === 0) {
          rejection[currentEntries.length > 0 ? "eventMismatch" : "currentMissing"] += 1;
          continue;
        }
        if (matchingCurrent.length !== 1) {
          rejection.eventMismatch += 1;
          continue;
        }

        currentEntry = matchingCurrent[0];
        const currentBase = attachStoredPreMatchArchive({
          db,
          match: currentEntry.match,
          publicationIndex: ledger.index,
          capturedAt: observedAtForResult,
        });
        // Reconcile again from the original omitted-clock result row. The
        // pre-filtered incoming copy may have inherited the old midnight
        // placeholder before SQLite snapshot recovery repaired currentBase.
        result = reconcileOfficialResultClock(currentBase, sourceResult);
        const reconciled = reconcileMatchLifecycle(currentBase, {
          ...result,
          resultUpdatedAt: result.resultSourceUpdatedAt || observedAtForResult,
          resultObservedAt: observedAtForResult,
          resultObservationSource: result.resultObservationSource,
          resultObservationFallback: false,
        });
        if (
          reconciled.status !== "FINISHED"
          || !isOfficialSportteryFinal(reconciled)
          || !isTrustedFinishedForSettlement(reconciled)
        ) {
          rejection.invalidFinal += 1;
          continue;
        }
        audited = attachResultAuditTimestamps({
          ...reconciled,
          sourceCycleId,
          datasetRevision,
        }, currentBase, observedAtForResult);
      }

      if (!isOfficialSportteryFinal(audited) || !isTrustedFinishedForSettlement(audited)) {
        rejection.invalidFinal += 1;
        continue;
      }
      audited = {
        ...audited,
        // resultObservedAt remains the immutable first trusted score
        // observation. Corrections and payout revisions advance this separate
        // signed-authority clock together with sourceCycleId.
        resultAuthorityObservedAt: persistedAuthorityObservedAt,
      };
      const settledAudited = settleTrustedPublishedPredictions(audited);
      const reviewedMatch = attachPostMatchReviews(
        [settledAudited],
        persistedResultObservedAt,
        null,
        ledger.index,
        { officialScoreCorrection: changeType === "official-score-correction" }
      ).matches[0];
      const candidateReview = reviewedMatch?.postMatchReview || null;
      if (!candidateReview) {
        rejection.reviewMissing += 1;
        continue;
      }
      if (changeType === "review-refresh") {
        const reviewUnchanged = postMatchReviewComparable(candidateReview)
          === postMatchReviewComparable(historyEntry.match?.postMatchReview || null);
        const resultMetadataChanged = historyResultMetadataChanged
          || officialResultMetadataComparable(historyEntry.match)
            !== officialResultMetadataComparable(settledAudited);
        if (reviewUnchanged && !historyArchiveChanged && !resultMetadataChanged) {
          transactionAuthorityCandidates.push(authorityHighWaterCandidate({
            match: settledAudited,
            observedAt: persistedAuthorityObservedAt,
            sourceCycleId: persistedSourceCycleId,
            resultProbeRevisionId: endpointTrust.resultProbeRevisionId,
          }));
          rejection.alreadyPublished += 1;
          continue;
        }
        if (reviewUnchanged && historyArchiveChanged) {
          changeType = "archive-repair";
        } else if (reviewUnchanged && resultMetadataChanged) {
          changeType = "official-result-metadata-refresh";
        }
      }
      // Only a semantic review change reaches this point. Bind its publication
      // metadata to the same atomic SQLite revision as the top-level match;
      // capture/source-cycle drift by itself was filtered above.
      const review = {
        ...candidateReview,
        generatedAt: persistedResultObservedAt,
        settlement: {
          ...(candidateReview.settlement || {}),
          reviewGeneratedAt: persistedResultObservedAt,
          sourceCycleId: persistedSourceCycleId,
          datasetRevision,
        },
      };
      const finalMatch = {
        ...settledAudited,
        sourceCycleId: persistedSourceCycleId,
        datasetRevision,
        postMatchReview: review,
      };
      const observation = createFastResultObservation(finalMatch, {
        publishedAt,
        sourceCycleId: persistedSourceCycleId,
        datasetRevision,
      });
      if (!observation) {
        rejection.reviewMissing += 1;
        continue;
      }
      transactionAuthorityCandidates.push(authorityHighWaterCandidate({
        match: finalMatch,
        observedAt: persistedAuthorityObservedAt,
        sourceCycleId: persistedSourceCycleId,
        resultProbeRevisionId: endpointTrust.resultProbeRevisionId,
      }));
      // The SQLite row key is storage identity and may need an event suffix when
      // an upstream source id is reused. The public match identity must remain
      // identical to the exact current row so the atomic browser refresh replaces
      // that row instead of rendering a second, apparently unrelated fixture.
      const persistedFinalMatch = finalMatch;
      if (historyEntry) {
        const updated = updateHistory.run(
          persistedFinalMatch.id || null,
          sourceMatchId,
          persistedFinalMatch.kickoffTime || null,
          JSON.stringify(persistedFinalMatch),
          historyEntry.row.id
        );
        if (Number(updated.changes || 0) !== 1) {
          throw new Error(`fast-result-history-update-race:${sourceMatchId}`);
        }
      } else {
        const baseHistoryId = `history:${finalMatch.id || sourceMatchId}`;
        let historyId = baseHistoryId;
        let occupied = rowById.get(historyId);
        if (occupied) {
          const occupiedMatch = safeJsonParse(occupied.payload, null);
          if (occupiedMatch && sameAuthorityEvent(occupiedMatch, finalMatch)) {
            if (sameScore(occupiedMatch, finalMatch)) rejection.alreadyPublished += 1;
            else rejection.historyConflict += 1;
            continue;
          }
          const eventVersion = eventVersionOf(finalMatch);
          if (!eventVersion) {
            rejection.historyConflict += 1;
            continue;
          }
          const eventSuffix = crypto.createHash("sha256")
            .update(JSON.stringify({ sourceMatchId, eventVersion }))
            .digest("hex")
            .slice(0, 16);
          historyId = `${baseHistoryId}:event:${eventSuffix}`;
          occupied = rowById.get(historyId);
          if (occupied) {
            const occupiedEventMatch = safeJsonParse(occupied.payload, null);
            if (
              occupiedEventMatch
              && sameAuthorityEvent(occupiedEventMatch, finalMatch)
              && sameScore(occupiedEventMatch, finalMatch)
            ) rejection.alreadyPublished += 1;
            else rejection.historyConflict += 1;
            continue;
          }
        }
        insertHistory.run(
          historyId,
          persistedFinalMatch.id || null,
          sourceMatchId,
          persistedFinalMatch.kickoffTime || null,
          JSON.stringify(persistedFinalMatch)
        );
        const deleted = deleteCurrent.run(currentEntry.row.id);
        if (Number(deleted.changes || 0) !== 1) {
          throw new Error(`fast-result-current-delete-race:${sourceMatchId}`);
        }
      }
      published.push({
        changeType,
        sourceMatchId,
        matchId: persistedFinalMatch.id || null,
        scoreHome: persistedFinalMatch.scoreHome,
        scoreAway: persistedFinalMatch.scoreAway,
        resultObservedAt: persistedFinalMatch.resultObservedAt || null,
        settledAt: persistedFinalMatch.settledAt || null,
        reviewRole: review.predictionReview?.bestRole || null,
        resultRevision: review.settlement?.resultRevision || null,
      });
      observations.push(observation);
    }

    if (published.length === 0) {
      const highWaterMerge = mergeAuthorityHighWater(
        transactionAuthorityHighWater,
        transactionAuthorityCandidates,
      );
      if (!highWaterMerge.valid) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return skippedResult(startedAt, authorityHighWaterFailureReason(highWaterMerge), {
          sourceCycleId,
          verifiedFastEndpoints: endpointTrust.entries.length,
        });
      }
      if (highWaterMerge.changed) {
        authorityHighWaterUpdated = persistAuthorityHighWater(
          db,
          highWaterMerge,
          observedAt,
        );
        authorityHighWaterRows = highWaterMerge.rows.length;
        db.exec("COMMIT");
      } else {
        db.exec("ROLLBACK");
      }
      transactionOpen = false;
      if (metaRecovery.updated) {
        return {
          ok: true,
          phase: "official-result-fast-published",
          skipped: false,
          visibleStateChanged: true,
          reason: "sync-meta-recovered-from-sqlite-receipt",
          startedAt,
          finishedAt: new Date().toISOString(),
          publishedRows: 0,
          sourceCycleId,
          metaRecovery,
          authorityHighWaterUpdated,
          authorityHighWaterRows,
          integrityMigration,
          rejected: { ...selected.rejected, ...rejection },
        };
      }
      return skippedResult(startedAt, "no-result-state-change", {
        sourceCycleId,
        scannedRows: normalizedRows.length,
        trustedFinishedRows: selected.rows.length,
        fastPath: false,
        ledgerLoaded,
        writeTransactionStarted,
        authorityHighWaterUpdated,
        authorityHighWaterRows,
        integrityMigration,
        rejected: { ...selected.rejected, ...rejection },
        ledger: {
          missing: ledger.loaded.missing,
          valid: ledger.index.valid,
          rows: ledger.index.rows,
        },
      });
    }

    publishedAt = new Date().toISOString();
    for (const observation of observations) observation.publishedAt = publishedAt;
    receiptObservations = mergeFastResultObservations(
      priorReceiptObservations,
      observations
    ).rows;
    upsertMeta(db, "fast_result_published_at", publishedAt, publishedAt);
    upsertMeta(db, "fast_result_source_cycle_id", sourceCycleId, publishedAt);
    upsertMeta(db, "fast_result_dataset_revision", datasetRevision, publishedAt);
    upsertMeta(db, "source_cycle_id", sourceCycleId, publishedAt);
    upsertMeta(db, "dataset_revision", datasetRevision, publishedAt);
    upsertMeta(db, "fast_result_revision", revision, publishedAt);
    upsertMeta(db, "fast_result_receipt", JSON.stringify({
      version: "sqlite-fast-result-receipt-v2",
      revision,
      publishedAt,
      sourceCycleId,
      datasetRevision,
      publishedRows: published.length,
      observations: receiptObservations,
      observationsRootHash: fastResultReceiptRoot(receiptObservations),
    }), publishedAt);
    const highWaterMerge = mergeAuthorityHighWater(
      transactionAuthorityHighWater,
      transactionAuthorityCandidates,
    );
    if (!highWaterMerge.valid) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return skippedResult(startedAt, authorityHighWaterFailureReason(highWaterMerge), {
        sourceCycleId,
        verifiedFastEndpoints: endpointTrust.entries.length,
      });
    }
    if (highWaterMerge.changed) {
      authorityHighWaterUpdated = persistAuthorityHighWater(
        db,
        highWaterMerge,
        observedAt,
      );
      authorityHighWaterRows = highWaterMerge.rows.length;
    }
    db.exec("COMMIT");
    transactionOpen = false;
    committedAt = new Date().toISOString();
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the publication error as the primary failure.
      }
    }
    throw error;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors after a committed or rolled-back transaction.
    }
  }

  const syncMeta = publishSyncMetaRevision({
    filePath: syncMetaPath,
    publishedAt,
    sourceCycleId,
    datasetRevision,
    publishedRows: published.length,
    revision,
    observations: receiptObservations,
  });
  const finishedAt = new Date().toISOString();
  const capturedAt = observedAt;
  const sourceToPublishedMs = capturedAt
    ? Math.max(0, Date.parse(finishedAt) - Date.parse(capturedAt))
    : null;
  return {
    ok: true,
    phase: "official-result-fast-published",
    skipped: false,
    startedAt,
    finishedAt,
    publishedAt,
    committedAt,
    metaVisibleAt: finishedAt,
    sourceCycleId,
    resultProbeRevisionId: endpointTrust.resultProbeRevisionId,
    verifiedFastEndpoints: endpointTrust.entries.length,
    datasetRevision,
    sourceCapturedAt: capturedAt,
    sourceToPublishedMs,
    scannedRows: normalizedRows.length,
    trustedFinishedRows: selected.rows.length,
    publishedRows: published.length,
    receiptObservationRows: receiptObservations.length,
    published,
    rejected: { ...selected.rejected, ...rejection },
    syncMeta,
    metaRecovery,
    fastPath: false,
    ledgerLoaded,
    writeTransactionStarted,
    authorityHighWaterUpdated,
    authorityHighWaterRows,
    integrityMigration,
    ledger: {
      missing: ledger.loaded.missing,
      valid: ledger.index.valid,
      rows: ledger.index.rows,
    },
  };
};

const main = async () => {
  const machineMode = process.env[FAST_RESULT_PUBLISHER_MACHINE_ENV] === "1";
  const originalConsole = machineMode
    ? { log: console.log, info: console.info, debug: console.debug }
    : null;
  if (machineMode) {
    const diagnostic = (...args) => console.error(...args);
    console.log = diagnostic;
    console.info = diagnostic;
    console.debug = diagnostic;
  }
  let result;
  try {
    result = publishOfficialResultsFast();
    const postgresMode = String(process.env.FOOTBALL_POSTGRES_MODE || "disabled").trim().toLowerCase();
    const postgresEnabled = ["shadow-write", "shadow-read", "primary"].includes(postgresMode);
    const shouldReplicate = postgresEnabled && result?.ok === true && (
      Number(result?.publishedRows || 0) > 0 || result?.visibleStateChanged === true
    );
    if (shouldReplicate) {
      try {
        const { syncPostgresProjectionFromSqlite } = require("./postgresProjectionSync.cjs");
        result = {
          ...result,
          postgresProjection: await syncPostgresProjectionFromSqlite({ mode: "fast-result" }),
        };
      } catch (error) {
        if (postgresMode === "primary") throw error;
        result = {
          ...result,
          postgresProjection: {
            ok: false,
            warning: true,
            code: error.code || null,
            error: error.message || String(error),
          },
        };
      }
    }
  } finally {
    if (originalConsole) {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
    }
  }
  process.stdout.write(machineMode
    ? encodeFastResultPublisherOutput(result)
    : `${JSON.stringify(result, null, 2)}\n`);
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      phase: "official-result-fast-publication",
      error: error.message || String(error),
      errorCode: error.code || null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  fastResultReceiptRoot,
  fastResultCandidate,
  migrateLegacyFastResultIntegrity,
  officialSportteryHttps,
  publishOfficialResultsFast,
  publishSyncMetaRevision,
  recoverSyncMetaFromReceipt,
  readFastResultReceiptState,
  selectRelayCandidates,
  sourceCycleIdFor,
};
