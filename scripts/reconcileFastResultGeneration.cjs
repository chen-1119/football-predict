"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
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
  postMatchReviewComparable,
  stripOfficialResultOnlyPredictionContent,
  validArchivedPreMatchPrediction,
} = require("./syncData.cjs");
const { acquireSyncMetaCommitLock } = require("./syncMetaCommitLock.cjs");
const { buildFormalReviewPerformance } = require("../server/reviewPerformanceSummary.cjs");
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
  if (existingRevision === incomingRevision && observedAtMs(existing) >= observedAtMs(incoming)) {
    return existing;
  }
  return incoming;
};

const preserveExistingPublicIdentity = (existing, selected) => {
  if (!existing || !selected || !sameStoredEvent(existing, selected)) return selected;
  const existingId = asText(existing.id);
  const existingMatchId = asText(existing.matchId);
  return {
    ...selected,
    ...(existingId ? { id: existing.id } : {}),
    ...(existingMatchId ? { matchId: existing.matchId } : {}),
  };
};

const replaceOrAppend = (rows, match) => {
  let replaced = false;
  const next = rows.map((row) => {
    if (!sameStoredEvent(row, match)) return row;
    replaced = true;
    // The winning payload was selected before sanitization. Re-running the
    // revision comparison here could restore an older, unsanitized review.
    return match;
  });
  if (!replaced) next.push(match);
  return next;
};

const reviewBaseIdentityMatches = (review, match) => {
  const reviewSourceId = asText(review?.sourceMatchId || review?.matchId).replace(/^sporttery_/, "");
  const matchSourceId = sourceMatchIdFor(match);
  if (!reviewSourceId || reviewSourceId !== matchSourceId) return false;
  const reviewMatchId = asText(review?.matchId);
  const matchId = asText(match?.id);
  return !reviewMatchId || !matchId || reviewMatchId === matchId;
};

const reviewScoreMatches = (review, match) => (
  Number.isInteger(match?.scoreHome)
  && Number.isInteger(match?.scoreAway)
  && asText(review?.finalScore) === `${match.scoreHome}-${match.scoreAway}`
);

const legacyReviewHasFormalClaim = (review) => {
  const settlement = review?.settlement || {};
  const predictionReview = review?.predictionReview || {};
  const rows = Array.isArray(predictionReview.rows) ? predictionReview.rows : [];
  return Boolean(
    asText(settlement.publicationId)
    || settlement.publicationVerified === true
    || ["WON", "LOST"].includes(asText(predictionReview.bestStatus).toUpperCase())
    || ["WON", "LOST"].includes(asText(predictionReview.formalBestStatus).toUpperCase())
    || asText(predictionReview.bestRole).toLowerCase() === "main"
    || asText(predictionReview.bestTrack).toLowerCase() === "formal"
    || Number(predictionReview.settled || 0) > 0
    || Number(predictionReview.won || 0) > 0
    || Number(predictionReview.mainSettled || 0) > 0
    || Number(predictionReview.mainWon || 0) > 0
    || rows.some((row) => (
      asText(row?.publicationId)
      || (row?.publicationEvidence && typeof row.publicationEvidence === "object")
      || row?.recommendationAction === "recommend"
      || row?.reviewRole === "main"
      || asText(row?.performanceTrack).toLowerCase() === "formal"
    ))
  );
};

const rejectUnverifiedFormalReview = (match) => {
  throw receiptRecoveryError(
    `fast result generation found an unverified formal review: ${sourceMatchIdFor(match)}`,
    "FAST_RESULT_GENERATION_REVIEW_FORMAL_UNVERIFIED",
  );
};

const safeExistingHistoricalReview = (existingHistory, selectedFinal) => {
  const review = existingHistory?.postMatchReview;
  if (!review) return null;
  if (
    !sameStoredEvent(existingHistory, selectedFinal)
    || !reviewBaseIdentityMatches(review, existingHistory)
    || !reviewScoreMatches(review, existingHistory)
  ) {
    if (legacyReviewHasFormalClaim(review)) rejectUnverifiedFormalReview(existingHistory);
    return null;
  }
  const matchEventVersion = eventVersionOf(existingHistory);
  const explicitReviewEventVersion = eventVersionOf(review);
  if (explicitReviewEventVersion && explicitReviewEventVersion !== matchEventVersion) {
    if (legacyReviewHasFormalClaim(review)) rejectUnverifiedFormalReview(existingHistory);
    return null;
  }

  const reviewAt = review.generatedAt
    || review?.settlement?.reviewGeneratedAt
    || existingHistory.resultObservedAt
    || selectedFinal.resultObservedAt;
  if (!Number.isFinite(Date.parse(reviewAt || ""))) {
    if (legacyReviewHasFormalClaim(review)) rejectUnverifiedFormalReview(existingHistory);
    return null;
  }
  const validArchive = validArchivedPreMatchPrediction(existingHistory);
  const candidate = validArchive
    ? { ...existingHistory, archivedPreMatchPrediction: validArchive }
    : existingHistory;
  const sanitized = stripOfficialResultOnlyPredictionContent(candidate);
  const { postMatchReview: ignoredEmbeddedReview, ...withoutEmbeddedReview } = sanitized;
  void ignoredEmbeddedReview;
  const rebuilt = attachPostMatchReviews(
    [withoutEmbeddedReview],
    reviewAt,
    null,
    null,
  ).matches[0]?.postMatchReview;
  const reproducible = Boolean(
    rebuilt
    && postMatchReviewComparable(rebuilt) === postMatchReviewComparable(
      explicitReviewEventVersion
        ? review
        : { ...review, eventVersion: matchEventVersion }
    )
  );
  if (!reproducible) {
    if (legacyReviewHasFormalClaim(review)) rejectUnverifiedFormalReview(existingHistory);
    return null;
  }
  return explicitReviewEventVersion
    ? review
    : { ...review, eventVersion: matchEventVersion };
};

const rebuildReceiptSafeReview = (match) => {
  const reviewAt = match.resultObservedAt
    || match.resultUpdatedAt
    || match.settledAt;
  if (!Number.isFinite(Date.parse(reviewAt || ""))) {
    throw receiptRecoveryError(
      `fast result generation cannot rebuild an audited review clock: ${sourceMatchIdFor(match)}`,
      "FAST_RESULT_GENERATION_REVIEW_CLOCK_INVALID",
    );
  }
  const { postMatchReview: ignoredReceiptReview, ...withoutReceiptReview } = match;
  void ignoredReceiptReview;
  const rebuilt = attachPostMatchReviews(
    [withoutReceiptReview],
    reviewAt,
    null,
    null,
  ).matches[0]?.postMatchReview;
  if (!rebuilt || !reviewScoreMatches(rebuilt, match)) {
    throw receiptRecoveryError(
      `fast result generation could not rebuild a result-only review: ${sourceMatchIdFor(match)}`,
      "FAST_RESULT_GENERATION_REVIEW_REBUILD_INVALID",
    );
  }
  return rebuilt;
};

const reviewWithEventIdentity = (review, match) => ({
  ...review,
  eventVersion: eventVersionOf(match),
});

const reproducibleLegacyReviewForMatch = (review, match) => {
  const matchEventVersion = eventVersionOf(match);
  if (
    !reviewBaseIdentityMatches(review, match)
    || !reviewScoreMatches(review, match)
    || !matchEventVersion
    || (eventVersionOf(review) && eventVersionOf(review) !== matchEventVersion)
  ) return false;
  const reviewAt = review?.generatedAt
    || review?.settlement?.reviewGeneratedAt
    || match?.resultObservedAt
    || match?.resultUpdatedAt
    || match?.settledAt;
  if (!Number.isFinite(Date.parse(reviewAt || ""))) return false;

  const validArchive = validArchivedPreMatchPrediction(match);
  const candidate = validArchive
    ? { ...match, archivedPreMatchPrediction: validArchive }
    : match;
  const sanitized = stripOfficialResultOnlyPredictionContent(candidate);
  const { postMatchReview: ignoredEmbeddedReview, ...withoutEmbeddedReview } = sanitized;
  void ignoredEmbeddedReview;
  const rebuilt = attachPostMatchReviews(
    [withoutEmbeddedReview],
    reviewAt,
    null,
    null,
  ).matches[0]?.postMatchReview;
  return Boolean(
    rebuilt
    && postMatchReviewComparable(rebuilt) === postMatchReviewComparable({
      ...review,
      eventVersion: matchEventVersion,
    })
  );
};

const rebuildLegacyReferenceReviewForMatch = (review, match) => {
  const matchEventVersion = eventVersionOf(match);
  const reviewAt = review?.generatedAt
    || review?.settlement?.reviewGeneratedAt
    || match?.resultObservedAt
    || match?.resultUpdatedAt
    || match?.settledAt;
  if (!matchEventVersion || !Number.isFinite(Date.parse(reviewAt || ""))) return null;
  const validArchive = validArchivedPreMatchPrediction(match);
  const candidate = validArchive
    ? { ...match, archivedPreMatchPrediction: validArchive }
    : match;
  const sanitized = stripOfficialResultOnlyPredictionContent(candidate);
  const { postMatchReview: ignoredEmbeddedReview, ...withoutEmbeddedReview } = sanitized;
  void ignoredEmbeddedReview;
  const rebuilt = attachPostMatchReviews(
    [withoutEmbeddedReview],
    reviewAt,
    null,
    null,
  ).matches[0]?.postMatchReview;
  return rebuilt
    && eventVersionOf(rebuilt) === matchEventVersion
    && reviewScoreMatches(rebuilt, match)
    && !legacyReviewHasFormalClaim(rebuilt)
    ? rebuilt
    : null;
};

const uniqueLegacyReviewEvent = (review, historyRows) => {
  const candidates = historyRows.filter((match) => (
    eventVersionOf(match)
    && reviewBaseIdentityMatches(review, match)
    && reviewScoreMatches(review, match)
  ));
  return candidates.length === 1 ? candidates[0] : null;
};

const migrateLegacyReviewSurfaces = ({
  historyRows,
  authorityHistoryRows,
  reviewRows,
  migratedAt,
}) => {
  const quarantineRows = [];
  let boundHistoryRows = 0;
  let rebuiltHistoryRows = 0;
  let boundStandaloneRows = 0;
  let rebuiltStandaloneRows = 0;

  const migratedHistoryRows = historyRows.map((match) => {
    const review = match?.postMatchReview;
    if (!review || eventVersionOf(review)) return match;
    const candidate = uniqueLegacyReviewEvent(review, authorityHistoryRows);
    if (!candidate || !sameStoredEvent(candidate, match)) {
      throw receiptRecoveryError(
        `fast result generation found an ambiguous embedded review event: ${sourceMatchIdFor(match)}`,
        "FAST_RESULT_GENERATION_REVIEW_EVENT_AMBIGUOUS",
      );
    }
    if (reproducibleLegacyReviewForMatch(review, candidate)) {
      boundHistoryRows += 1;
      return {
        ...match,
        postMatchReview: reviewWithEventIdentity(review, candidate),
      };
    }
    if (legacyReviewHasFormalClaim(review)) rejectUnverifiedFormalReview(match);
    const rebuilt = rebuildLegacyReferenceReviewForMatch(review, candidate);
    if (!rebuilt) {
      throw receiptRecoveryError(
        `fast result generation could not rebuild a quarantined embedded review: ${sourceMatchIdFor(match)}`,
        "FAST_RESULT_GENERATION_REVIEW_REBUILD_INVALID",
      );
    }
    quarantineRows.push(quarantinedLegacyReview(review, candidate, migratedAt, "history"));
    rebuiltHistoryRows += 1;
    return { ...match, postMatchReview: rebuilt };
  });

  const migratedAuthorityRows = authorityHistoryRows.map((match) => (
    migratedHistoryRows.find((row) => sameStoredEvent(row, match)) || match
  ));
  const migratedReviewRows = reviewRows.map((review) => {
    if (eventVersionOf(review)) return review;
    const candidate = uniqueLegacyReviewEvent(review, migratedAuthorityRows);
    if (!candidate) {
      throw receiptRecoveryError(
        `fast result generation found an ambiguous standalone review event: ${asText(review?.sourceMatchId || review?.matchId)}`,
        "FAST_RESULT_GENERATION_REVIEW_EVENT_AMBIGUOUS",
      );
    }
    if (reproducibleLegacyReviewForMatch(review, candidate)) {
      boundStandaloneRows += 1;
      return reviewWithEventIdentity(review, candidate);
    }
    if (legacyReviewHasFormalClaim(review)) rejectUnverifiedFormalReview(candidate);
    const rebuilt = rebuildLegacyReferenceReviewForMatch(review, candidate);
    if (!rebuilt) {
      throw receiptRecoveryError(
        `fast result generation could not rebuild a quarantined standalone review: ${sourceMatchIdFor(candidate)}`,
        "FAST_RESULT_GENERATION_REVIEW_REBUILD_INVALID",
      );
    }
    quarantineRows.push(quarantinedLegacyReview(review, candidate, migratedAt, "standalone"));
    rebuiltStandaloneRows += 1;
    return rebuilt;
  });

  const seenStandaloneEvents = new Set();
  for (const review of migratedReviewRows) {
    const eventVersion = eventVersionOf(review);
    const sourceMatchId = asText(review?.sourceMatchId || review?.matchId).replace(/^sporttery_/, "");
    if (!eventVersion || !sourceMatchId) {
      throw receiptRecoveryError(
        "fast result generation left a standalone review without canonical event identity",
        "FAST_RESULT_GENERATION_REVIEW_EVENT_MISSING",
      );
    }
    const key = `${sourceMatchId}:${eventVersion}`;
    if (seenStandaloneEvents.has(key)) {
      throw receiptRecoveryError(
        `fast result generation found duplicate review events: ${key}`,
        "FAST_RESULT_GENERATION_REVIEW_DUPLICATE",
      );
    }
    seenStandaloneEvents.add(key);
  }

  return {
    historyRows: migratedHistoryRows,
    reviewRows: migratedReviewRows,
    quarantineRows,
    boundHistoryRows,
    rebuiltHistoryRows,
    boundStandaloneRows,
    rebuiltStandaloneRows,
  };
};

const legacyReviewEventResolution = ({
  review,
  selectedFinal,
  historyRows,
  reviewRows,
}) => {
  if (eventVersionOf(review) || !reviewScoreMatches(review, selectedFinal)) {
    return { action: "reject" };
  }

  const unboundIdentityRows = reviewRows.filter((row) => (
    !eventVersionOf(row)
    && reviewBaseIdentityMatches(row, selectedFinal)
  ));
  if (unboundIdentityRows.length !== 1 || unboundIdentityRows[0] !== review) {
    return { action: "reject" };
  }

  const identityScoreEvents = historyRows.filter((match) => (
    eventVersionOf(match)
    && reviewBaseIdentityMatches(review, match)
    && reviewScoreMatches(review, match)
  ));
  if (
    identityScoreEvents.length !== 1
    || !sameStoredEvent(identityScoreEvents[0], selectedFinal)
  ) {
    return { action: "reject" };
  }
  if (reproducibleLegacyReviewForMatch(review, identityScoreEvents[0])) {
    return { action: "bind", match: identityScoreEvents[0] };
  }
  return legacyReviewHasFormalClaim(review)
    ? { action: "reject-formal", match: identityScoreEvents[0] }
    : { action: "quarantine", match: identityScoreEvents[0] };
};

function quarantinedLegacyReview(review, match, quarantinedAt, surface = "standalone") {
  const reviewHash = crypto.createHash("sha256").update(JSON.stringify(review)).digest("hex");
  return {
    version: "legacy-post-match-review-quarantine-v1",
    reason: "non-reproducible-after-canonical-event-binding",
    quarantinedAt,
    surfaces: [surface],
    matchId: asText(review?.matchId || match?.id) || null,
    sourceMatchId: sourceMatchIdFor(match) || null,
    canonicalEventVersion: eventVersionOf(match),
    finalScore: asText(review?.finalScore) || null,
    legacyGeneratedAt: review?.generatedAt || review?.settlement?.reviewGeneratedAt || null,
    artifacts: [{ surface, reviewHash, review }],
  };
}

const quarantineValidationError = (message) => receiptRecoveryError(
  `fast result generation quarantine invalid: ${message}`,
  "FAST_RESULT_GENERATION_QUARANTINE_INVALID",
);

const readValidatedQuarantine = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return {
      version: "legacy-post-match-review-quarantine-v1",
      count: 0,
      artifactCount: 0,
      rows: [],
    };
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw quarantineValidationError(`unreadable JSON (${error?.code || error?.message || "parse-error"})`);
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || payload.version !== "legacy-post-match-review-quarantine-v1"
    || !Array.isArray(payload.rows)
    || !Number.isInteger(payload.count)
    || payload.count !== payload.rows.length
    || !Number.isInteger(payload.artifactCount)
  ) {
    throw quarantineValidationError("ledger schema or count mismatch");
  }

  const eventKeys = new Set();
  let artifactCount = 0;
  for (const row of payload.rows) {
    if (
      !row
      || typeof row !== "object"
      || Array.isArray(row)
      || row.version !== "legacy-post-match-review-quarantine-v1"
      || !asText(row.sourceMatchId)
      || !asText(row.canonicalEventVersion)
      || !asText(row.finalScore)
      || !Array.isArray(row.surfaces)
      || row.surfaces.length === 0
      || !Array.isArray(row.artifacts)
      || row.artifacts.length === 0
    ) {
      throw quarantineValidationError("row schema incomplete");
    }
    const eventKey = `${row.sourceMatchId}:${row.canonicalEventVersion}:${row.finalScore}`;
    if (eventKeys.has(eventKey)) throw quarantineValidationError(`duplicate event ${eventKey}`);
    eventKeys.add(eventKey);

    const declaredSurfaces = row.surfaces.map(asText);
    const uniqueDeclaredSurfaces = new Set(declaredSurfaces);
    if (
      uniqueDeclaredSurfaces.size !== declaredSurfaces.length
      || declaredSurfaces.some((surface) => !["history", "standalone"].includes(surface))
    ) {
      throw quarantineValidationError(`invalid surfaces for ${eventKey}`);
    }
    const artifactKeys = new Set();
    const artifactSurfaces = new Set();
    for (const artifact of row.artifacts) {
      const surface = asText(artifact?.surface);
      const reviewHash = asText(artifact?.reviewHash).toLowerCase();
      if (
        !["history", "standalone"].includes(surface)
        || !artifact?.review
        || typeof artifact.review !== "object"
        || Array.isArray(artifact.review)
        || !/^[a-f0-9]{64}$/.test(reviewHash)
      ) {
        throw quarantineValidationError(`artifact schema invalid for ${eventKey}`);
      }
      const calculatedHash = crypto.createHash("sha256")
        .update(JSON.stringify(artifact.review))
        .digest("hex");
      if (reviewHash !== calculatedHash) {
        throw quarantineValidationError(`artifact hash mismatch for ${eventKey}:${surface}`);
      }
      const artifactKey = `${surface}:${reviewHash}`;
      if (artifactKeys.has(artifactKey)) {
        throw quarantineValidationError(`duplicate artifact for ${eventKey}:${artifactKey}`);
      }
      artifactKeys.add(artifactKey);
      artifactSurfaces.add(surface);
    }
    if (
      artifactSurfaces.size !== uniqueDeclaredSurfaces.size
      || [...artifactSurfaces].some((surface) => !uniqueDeclaredSurfaces.has(surface))
    ) {
      throw quarantineValidationError(`surface/artifact mismatch for ${eventKey}`);
    }
    artifactCount += row.artifacts.length;
  }
  if (payload.artifactCount !== artifactCount) {
    throw quarantineValidationError("artifact count mismatch");
  }
  return payload;
};

const reviewSurfaceIdentity = (review) => {
  const sourceMatchId = asText(review?.sourceMatchId || review?.matchId).replace(/^sporttery_/, "");
  const eventVersion = eventVersionOf(review);
  const finalScore = asText(review?.finalScore);
  return sourceMatchId && eventVersion && finalScore
    ? `${sourceMatchId}:${eventVersion}:${finalScore}`
    : "";
};

const assertPostMatchReviewSurfaceParity = ({ historyRows, reviewRows }) => {
  const embedded = new Map();
  for (const match of historyRows) {
    const review = match?.postMatchReview;
    if (!review) continue;
    const key = reviewSurfaceIdentity(review);
    if (
      !key
      || !reviewBaseIdentityMatches(review, match)
      || !reviewScoreMatches(review, match)
      || eventVersionOf(review) !== eventVersionOf(match)
      || embedded.has(key)
    ) {
      throw receiptRecoveryError(
        `fast result generation embedded review surface invalid: ${key || sourceMatchIdFor(match)}`,
        "FAST_RESULT_GENERATION_REVIEW_SURFACE_MISMATCH",
      );
    }
    embedded.set(key, postMatchReviewComparable(review));
  }

  const standalone = new Map();
  for (const review of reviewRows) {
    const key = reviewSurfaceIdentity(review);
    if (!key || standalone.has(key)) {
      throw receiptRecoveryError(
        `fast result generation standalone review surface invalid: ${key || asText(review?.sourceMatchId || review?.matchId)}`,
        "FAST_RESULT_GENERATION_REVIEW_SURFACE_MISMATCH",
      );
    }
    standalone.set(key, postMatchReviewComparable(review));
  }
  if (embedded.size !== standalone.size) {
    throw receiptRecoveryError(
      `fast result generation review surface cardinality mismatch: ${embedded.size} != ${standalone.size}`,
      "FAST_RESULT_GENERATION_REVIEW_SURFACE_MISMATCH",
    );
  }
  for (const [key, comparable] of embedded) {
    if (!standalone.has(key) || standalone.get(key) !== comparable) {
      throw receiptRecoveryError(
        `fast result generation review surface content mismatch: ${key}`,
        "FAST_RESULT_GENERATION_REVIEW_SURFACE_MISMATCH",
      );
    }
  }
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
  quarantinePath = null,
} = {}) => {
  const startedAt = new Date().toISOString();
  const resolvedQuarantinePath = path.resolve(
    quarantinePath
    || path.join(
      process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.dirname(dbPath),
      "post-match-review-quarantine.json",
    )
  );
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
  if (
    !Array.isArray(current)
    || !Array.isArray(history)
    || !reviews
    || typeof reviews !== "object"
    || Array.isArray(reviews)
    || !Array.isArray(reviews.rows)
  ) {
    const error = new Error(
      "fast result generation requires readable current/history arrays and a review object with rows",
    );
    error.code = "FAST_RESULT_GENERATION_INPUT_INVALID";
    throw error;
  }
  const existingQuarantine = readValidatedQuarantine(resolvedQuarantinePath);
  const receiptDb = new DatabaseSync(dbPath, { readOnly: true });
  let receiptResolution;
  try {
    receiptResolution = readReceiptFinals(receiptDb, receipt, { current, history });
  } finally {
    receiptDb.close();
  }
  const finals = receiptResolution.finals;

  const authorityHistoryRows = [...history];
  for (const finalMatch of finals) {
    if (!authorityHistoryRows.some((row) => sameStoredEvent(row, finalMatch))) {
      authorityHistoryRows.push(finalMatch);
    }
  }
  const legacyMigration = migrateLegacyReviewSurfaces({
    historyRows: history,
    authorityHistoryRows,
    reviewRows: reviews.rows,
    migratedAt: startedAt,
  });

  let nextCurrent = current;
  let nextHistory = legacyMigration.historyRows;
  let nextReviewRows = legacyMigration.reviewRows;
  let removedCurrentRows = 0;
  let upsertedHistoryRows = 0;
  let upsertedReviewRows = 0;
  const quarantinedLegacyReviews = [...legacyMigration.quarantineRows];
  for (const finalMatch of finals) {
    const beforeCurrent = nextCurrent.length;
    nextCurrent = nextCurrent.filter((row) => !sameStoredEvent(row, finalMatch));
    removedCurrentRows += beforeCurrent - nextCurrent.length;

    const existingHistory = nextHistory.find((row) => sameStoredEvent(row, finalMatch));
    // SQLite can retain a legacy provider-prefixed presentation id for the
    // same immutable source event (for example fivehundred_* after the public
    // row has converged to sporttery_*). Result freshness may select that
    // payload, but it must not rename the already-published match identity or
    // detach its audited review from the history row.
    const selectedPayload = preserveExistingPublicIdentity(
      existingHistory,
      chooseFinalPayload(existingHistory, finalMatch),
    );
    const existingArchive = validArchivedPreMatchPrediction(existingHistory);
    const selectedWithArchive = existingArchive
      ? { ...selectedPayload, archivedPreMatchPrediction: existingArchive }
      : selectedPayload;
    const sanitizedFinal = stripOfficialResultOnlyPredictionContent(
      selectedWithArchive,
    );
    const preservedReview = safeExistingHistoricalReview(existingHistory, sanitizedFinal);
    const { postMatchReview: ignoredReceiptReview, ...withoutReceiptReview } = sanitizedFinal;
    void ignoredReceiptReview;
    const selectedFinal = {
      ...withoutReceiptReview,
      postMatchReview: preservedReview || rebuildReceiptSafeReview(withoutReceiptReview),
    };
    nextHistory = replaceOrAppend(nextHistory, selectedFinal);
    upsertedHistoryRows += 1;

    const review = selectedFinal.postMatchReview;
    if (review && typeof review === "object") {
      const selectedEventVersion = eventVersionOf(selectedFinal);
      if (!selectedEventVersion) {
        throw receiptRecoveryError(
          `fast result generation review event version missing: ${sourceMatchIdFor(selectedFinal)}`,
          "FAST_RESULT_GENERATION_REVIEW_EVENT_MISSING",
        );
      }
      const reviewRowsBeforeUpsert = nextReviewRows;
      let reviewReplaced = false;
      let reviewMatches = 0;
      nextReviewRows = reviewRowsBeforeUpsert.flatMap((row) => {
        if (!reviewBaseIdentityMatches(row, selectedFinal)) return [row];
        const rowEventVersion = eventVersionOf(row);
        const legacyResolution = !rowEventVersion
          ? legacyReviewEventResolution({
              review: row,
              selectedFinal,
              historyRows: nextHistory,
              reviewRows: reviewRowsBeforeUpsert,
            })
          : null;
        if (rowEventVersion && rowEventVersion !== selectedEventVersion) return [row];
        if (!rowEventVersion && legacyResolution?.action === "reject") {
          throw receiptRecoveryError(
            `fast result generation found an unbound review event: ${sourceMatchIdFor(selectedFinal)}`,
            "FAST_RESULT_GENERATION_REVIEW_EVENT_AMBIGUOUS",
          );
        }
        if (!rowEventVersion && legacyResolution?.action === "reject-formal") {
          rejectUnverifiedFormalReview(selectedFinal);
        }
        if (!rowEventVersion && legacyResolution?.action === "quarantine") {
          quarantinedLegacyReviews.push(
            quarantinedLegacyReview(row, legacyResolution.match, startedAt),
          );
          return [];
        }
        reviewMatches += 1;
        if (reviewMatches > 1) {
          throw receiptRecoveryError(
            `fast result generation found duplicate review events: ${sourceMatchIdFor(selectedFinal)}:${selectedEventVersion}`,
            "FAST_RESULT_GENERATION_REVIEW_DUPLICATE",
          );
        }
        reviewReplaced = true;
        return [reviewWithEventIdentity(review, selectedFinal)];
      });
      if (!reviewReplaced) nextReviewRows.push(reviewWithEventIdentity(review, selectedFinal));
      upsertedReviewRows += 1;
    }
  }
  assertPostMatchReviewSurfaceParity({ historyRows: nextHistory, reviewRows: nextReviewRows });
  const quarantinedLegacyReviewIdentities = new Set(
    quarantinedLegacyReviews.map((row) => (
      `${row?.sourceMatchId || ""}:${row?.canonicalEventVersion || ""}:${row?.finalScore || ""}`
    ))
  ).size;

  if (quarantinedLegacyReviews.length) {
    const existingRows = existingQuarantine.rows;
    const quarantineByIdentity = new Map();
    for (const row of [...existingRows, ...quarantinedLegacyReviews]) {
      const key = `${row?.sourceMatchId || ""}:${row?.canonicalEventVersion || ""}:${row?.finalScore || ""}`;
      const existing = quarantineByIdentity.get(key);
      const existingArtifacts = Array.isArray(existing?.artifacts)
        ? existing.artifacts
        : (existing?.reviewHash && existing?.review ? [{
            surface: existing?.surfaces?.[0] || "standalone",
            reviewHash: existing.reviewHash,
            review: existing.review,
          }] : []);
      const rowArtifacts = Array.isArray(row?.artifacts)
        ? row.artifacts
        : (row?.reviewHash && row?.review ? [{
            surface: row?.surfaces?.[0] || "standalone",
            reviewHash: row.reviewHash,
            review: row.review,
          }] : []);
      const artifacts = Array.from(new Map(
        [...existingArtifacts, ...rowArtifacts]
          .map((artifact) => [`${artifact?.surface || ""}:${artifact?.reviewHash || ""}`, artifact])
      ).values());
      quarantineByIdentity.set(key, {
        ...(existing || row),
        surfaces: Array.from(new Set([
          ...(Array.isArray(existing?.surfaces) ? existing.surfaces : []),
          ...(Array.isArray(row?.surfaces) ? row.surfaces : []),
        ])).sort(),
        artifacts,
      });
    }
    const quarantineRows = Array.from(quarantineByIdentity.values());
    atomicWriteJson(resolvedQuarantinePath, {
      version: "legacy-post-match-review-quarantine-v1",
      generatedAt: existingQuarantine?.generatedAt || startedAt,
      updatedAt: startedAt,
      count: quarantineRows.length,
      artifactCount: quarantineRows.reduce(
        (total, row) => total + (Array.isArray(row?.artifacts) ? row.artifacts.length : 0),
        0,
      ),
      rows: quarantineRows,
    });
  }

  atomicWriteJson(currentPath, nextCurrent);
  atomicWriteJson(historyPath, nextHistory);
  if (reviews && typeof reviews === "object" && !Array.isArray(reviews)) {
    atomicWriteJson(reviewsPath, {
      ...reviews,
      rows: nextReviewRows,
      summary: reviewSummary(nextReviewRows),
      formalPerformance: buildFormalReviewPerformance({
        matches: nextHistory,
        generatedAt: startedAt,
      }),
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
        quarantinedLegacyReviewRows: quarantinedLegacyReviewIdentities,
        quarantinedLegacyReviewSurfaceRows: quarantinedLegacyReviews.length,
        legacyReviewMigration: {
          boundHistoryRows: legacyMigration.boundHistoryRows,
          rebuiltHistoryRows: legacyMigration.rebuiltHistoryRows,
          boundStandaloneRows: legacyMigration.boundStandaloneRows,
          rebuiltStandaloneRows: legacyMigration.rebuiltStandaloneRows,
        },
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
    quarantinedLegacyReviewRows: quarantinedLegacyReviewIdentities,
    quarantinedLegacyReviewSurfaceRows: quarantinedLegacyReviews.length,
    legacyReviewMigration: {
      boundHistoryRows: legacyMigration.boundHistoryRows,
      rebuiltHistoryRows: legacyMigration.rebuiltHistoryRows,
      boundStandaloneRows: legacyMigration.boundStandaloneRows,
      rebuiltStandaloneRows: legacyMigration.rebuiltStandaloneRows,
    },
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
