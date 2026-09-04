const VERSION = "current-list-detail-recommendation-parity-v1";
const {
  parseHandicapLine,
} = require("../src/services/officialRecommendationEligibility.cjs");

const text = (value) => String(value ?? "").trim();
const upper = (value) => text(value).toUpperCase();
const canonicalInstant = (value) => {
  const time = Date.parse(text(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const finiteInstant = (value) => {
  const time = Date.parse(text(value));
  return Number.isFinite(time) ? time : null;
};
const earliestFiniteInstant = (...values) => {
  const times = values.map(finiteInstant).filter((value) => value !== null);
  return times.length > 0 ? Math.min(...times) : null;
};
// Keep archive identity normalization byte-for-byte aligned with the frontend
// immutable archive contract; broader route-id aliases are intentionally not
// accepted for the frozen sourceMatchId field.
const canonicalArchiveSourceId = (value) => text(value).replace(/^sporttery_/i, "");
const canonicalId = (match) => text(match?.sourceMatchId || match?.id)
  .replace(/^sporttery[_:-]/i, "");
const storedStatusOf = (match) => upper(match?.sourceStatus ?? match?.status);
const isResultPhase = (match, nowMs = Date.now()) => (
  ["FINISHED", "PENDING_RESULT"].includes(storedStatusOf(match))
  || (
    storedStatusOf(match) === "SCHEDULED"
    && Number.isFinite(Date.parse(match?.kickoffTime || ""))
    && Date.parse(match.kickoffTime) <= nowMs
  )
);
const validDirection = (prediction) => {
  const pool = upper(prediction?.oddsPoolCode);
  return (!pool || ["HAD", "HHAD"].includes(pool))
    && (pool !== "HHAD" || parseHandicapLine(prediction?.handicapLine) !== null)
    && ["1", "X", "2"].includes(upper(prediction?.tipCode));
};
const canonicalPool = (prediction) => (
  upper(prediction?.oddsPoolCode) || "MODEL_1X2"
);
const isModelOnlyReferencePrediction = (prediction) => (
  text(prediction?.recommendationAction).toLowerCase() === "reference"
  && Number(prediction?.odds) === 0
);
const canonicalModelOnlyPool = (prediction) => (
  canonicalPool(prediction) === "HHAD" ? "MODEL_HHAD" : "MODEL_1X2"
);
const canonicalLine = (pool, value) => {
  if (pool !== "HHAD" && pool !== "MODEL_HHAD") return "0";
  const number = parseHandicapLine(value);
  if (number === null) return null;
  return number > 0 ? `+${number}` : String(number);
};
const canonicalOdds = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 1 ? Number(number.toFixed(6)) : null;
};
const hasOfficialHadSp = (match) => {
  const source = text(match?.oddsSource).toLowerCase();
  const odds = match?.odds;
  return (source === "sporttery:had" || source.startsWith("sporttery:had:"))
    && ["odds1", "oddsX", "odds2"].every((key) => {
      const value = Number(odds?.[key]);
      return Number.isFinite(value) && value > 1;
    });
};
const hasDirectionalEvidence = (match) => {
  if (validDirection(match?.archivedPreMatchPrediction?.prediction)) return true;
  return (Array.isArray(match?.predictions) ? match.predictions : []).some(validDirection);
};
const requiresPreMatchPublicDecision = (match, nowMs = Date.now()) => (
  !isResultPhase(match, nowMs)
  && hasOfficialHadSp(match)
  && Boolean(publishedBestDecision(match))
);
const requiresResultPhasePublicDecision = (match, nowMs = Date.now()) => (
  isResultPhase(match, nowMs) && hasDirectionalEvidence(match)
);
const requiresPublicDecision = (match, nowMs = Date.now()) => (
  requiresPreMatchPublicDecision(match, nowMs)
  || requiresResultPhasePublicDecision(match, nowMs)
);

/**
 * Server parity must apply the same immutable archive boundary as the UI.
 * A merely well-formed direction is not enough: identity, event version and
 * capture deadline are part of the decision being compared.
 */
const validateArchivedDecision = (match) => {
  const archive = match?.archivedPreMatchPrediction;
  const prediction = archive?.prediction;
  const blockers = [];
  const kickoffAt = finiteInstant(match?.kickoffTime);
  const capturedAt = finiteInstant(archive?.capturedAt);
  const deadlineAt = earliestFiniteInstant(
    archive?.cutoffTime,
    match?.predictionMeta?.cutoffTime,
    match?.buyEndTime,
    match?.kickoffTime,
  );
  const archiveEventAt = finiteInstant(archive?.eventVersion || archive?.kickoffTime);
  const matchEventAt = finiteInstant(match?.eventVersion || match?.kickoffTime);
  const archiveSourceId = canonicalArchiveSourceId(archive?.sourceMatchId);
  const matchSourceId = canonicalArchiveSourceId(match?.sourceMatchId || match?.id);
  const evidenceScope = text(archive?.marketEvidenceScope) || "result-pool";
  const archivedPool = upper(prediction?.oddsPoolCode);
  const validModelOnlyHhadLine = archivedPool !== "HHAD"
    || canonicalLine("HHAD", prediction?.handicapLine) !== null;

  if (match?.resultDisposition === "VOID") blockers.push("void-match-has-no-archived-decision");
  if (archive?.version !== "archived-pre-match-prediction-v1") blockers.push("archive-version-invalid");
  if (archive?.source !== "immutable-pre-match-prediction-snapshot") blockers.push("archive-source-invalid");
  if (!archiveSourceId || !matchSourceId || archiveSourceId !== matchSourceId) {
    blockers.push("archive-match-identity-mismatch");
  }
  if (capturedAt === null) blockers.push("archive-captured-at-invalid");
  if (kickoffAt === null) blockers.push("match-kickoff-invalid");
  if (capturedAt !== null && kickoffAt !== null && capturedAt >= kickoffAt) {
    blockers.push("archive-not-captured-before-kickoff");
  }
  if (deadlineAt === null) blockers.push("archive-deadline-unavailable");
  if (capturedAt !== null && deadlineAt !== null && capturedAt > deadlineAt) {
    blockers.push("archive-captured-after-deadline");
  }
  if (archiveEventAt === null || matchEventAt === null) blockers.push("archive-event-version-invalid");
  else if (archiveEventAt !== matchEventAt) blockers.push("archive-event-version-mismatch");
  if (prediction?.marketType !== "BEST") blockers.push("archive-market-type-invalid");
  if (!["HAD", "HHAD"].includes(prediction?.oddsPoolCode)) blockers.push("archive-result-pool-invalid");
  if (!["1", "X", "2"].includes(prediction?.tipCode)) blockers.push("archive-direction-invalid");
  if (
    evidenceScope !== "result-pool"
    && !(
      evidenceScope === "model-only-reference"
      && validModelOnlyHhadLine
      && isModelOnlyReferencePrediction(prediction)
    )
  ) blockers.push("archive-market-evidence-scope-invalid");

  return {
    valid: blockers.length === 0,
    blockers: Array.from(new Set(blockers)),
    archive,
    prediction,
    evidenceScope,
  };
};

const archivedDecision = (match) => {
  const validation = validateArchivedDecision(match);
  if (!validation.valid) return null;
  const { archive, prediction, evidenceScope } = validation;
  return {
    source: "archive",
    prediction,
    marketEvidenceScope: evidenceScope,
    capturedAt: canonicalInstant(archive?.capturedAt),
    signature: text(archive?.signature || archive?.predictionSignature) || null,
  };
};

const publishedBestDecision = (match) => {
  const prediction = Array.isArray(match?.predictions)
    ? match.predictions.find((row) => row?.marketType === "BEST" && validDirection(row))
    : null;
  return prediction ? {
    source: "published-best",
    prediction,
    marketEvidenceScope: isModelOnlyReferencePrediction(prediction)
      ? "model-only-reference"
      : "result-pool",
    capturedAt: null,
    signature: null,
  } : null;
};

const hasPublishedWatchDisposition = (match) => (
  (Array.isArray(match?.predictions) ? match.predictions : []).some((prediction) => (
    upper(prediction?.marketType) === "BEST"
    && upper(prediction?.tipCode) === "WATCH"
    && text(prediction?.recommendationAction).toLowerCase() === "withhold"
  ))
);

/**
 * The generator intentionally retains its pre-selection 1X2 analysis row for
 * private audit/replay. Once the unified selector publishes a HAD BEST row,
 * however, exposing a different HAD 1X2 tip beside it creates two public
 * directions for the same Sporttery pool. HHAD is a separate pool (and line),
 * so it must never be compared with or removed by this HAD-only boundary.
 */
const publicHadSupportingDirectionConflicts = (match, nowMs = Date.now()) => {
  if (isResultPhase(match, nowMs) || !hasOfficialHadSp(match)) return [];
  const rows = Array.isArray(match?.predictions) ? match.predictions : [];
  const best = publishedBestDecision(match)?.prediction;
  if (canonicalPool(best) !== "HAD") return [];
  const bestTip = upper(best?.tipCode);
  if (!["1", "X", "2"].includes(bestTip)) return [];
  return rows.filter((row) => (
    upper(row?.marketType) === "1X2"
    && canonicalPool(row) === "HAD"
    && validDirection(row)
    && upper(row?.tipCode) !== bestTip
  ));
};

const isExplicitlyWithheldBest = (prediction) => {
  const recommendationAction = text(prediction?.recommendationAction).toLowerCase();
  return (
    upper(prediction?.marketType) === "BEST"
    && validDirection(prediction)
    // REFERENCE is an intentional low-confidence public direction. It is
    // excluded from formal statistics, but it must not be collapsed back into
    // a directionless WATCH merely because its promotion evidence is WATCH.
    // Only an explicit WITHHOLD (or a legacy non-reference/non-recommend
    // disposition) authorizes the public boundary to remove the direction.
    && recommendationAction !== "recommend"
    && recommendationAction !== "reference"
    && (
    (
      upper(prediction?.multiFactorEvidence?.grade) === "WATCH"
      && prediction?.multiFactorEvidence?.eligible !== true
    )
    || (
      upper(prediction?.liveRecommendationAction) === "WITHHOLD"
      && prediction?.liveRecommendation?.eligible !== true
    )
    )
  );
};

const neutralPublicWatchRow = (prediction) => ({
  ...prediction,
  tipCode: "WATCH",
  tipLabel: {
    zh: "观察：证据不足，暂无可靠方向",
    en: "Watch: insufficient evidence, no reliable direction",
  },
  odds: 0,
  trustScore: 0,
  recommendationAction: "withhold",
  recommendationTier: "public-watch",
  liveRecommendationAction: "withhold",
  liveRecommendationTier: "live-withhold",
  multiFactorEvidence: prediction?.multiFactorEvidence
    ? {
        ...prediction.multiFactorEvidence,
        eligible: false,
        grade: "WATCH",
        code: "WATCH",
      }
    : prediction?.multiFactorEvidence,
});

const projectPublicPredictionRows = (match, {
  nowMs = Date.now(),
} = {}) => {
  const rows = Array.isArray(match?.predictions) ? match.predictions : [];
  const conflicts = publicHadSupportingDirectionConflicts(match, nowMs);
  const hidden = new Set(conflicts);
  const conflictSafeRows = conflicts.length === 0
    ? rows.slice()
    : rows.filter((row) => !hidden.has(row));

  // A recommendation can already be frozen before kickoff while the mutable
  // current row no longer carries its BEST copy. The immutable archive is the
  // canonical decision in that case; projecting a copy back into the public
  // row restores continuity without rewriting the stored match or bypassing a
  // deliberate WATCH/WITHHOLD disposition.
  if (!isResultPhase(match, nowMs)) {
    const hasAnyBestDisposition = conflictSafeRows.some((row) => upper(row?.marketType) === "BEST");
    const frozen = hasAnyBestDisposition ? null : archivedDecision(match);
    if (frozen?.prediction && validDirection(frozen.prediction)) {
      conflictSafeRows.push({
        ...frozen.prediction,
        marketType: "BEST",
        recommendationAction: text(frozen.prediction?.recommendationAction) || "reference",
        recommendationTier: text(frozen.prediction?.recommendationTier) || "immutable-pre-match-reference",
        immutableArchiveReference: true,
      });
    }
  }

  // A WATCH/WITHHOLD BEST row keeps its internal direction for audit and
  // replay, but that direction is not a public recommendation. Publishing the
  // raw code made a low-evidence batch look like ten confident home wins. At
  // the public boundary expose one neutral WATCH disposition and suppress the
  // supporting result-pool directions; the private stored rows stay intact.
  if (isResultPhase(match, nowMs)) return conflictSafeRows;
  const withheldBest = conflictSafeRows.find(isExplicitlyWithheldBest);
  if (!withheldBest) return conflictSafeRows;

  return conflictSafeRows.flatMap((row) => {
    if (row === withheldBest) return [neutralPublicWatchRow(row)];
    if (validDirection(row)) return [];
    return [row];
  });
};

const scheduledWithoutBestIds = (rows, nowMs = Date.now()) => (
  (Array.isArray(rows) ? rows : [])
    .filter((row) => (
      storedStatusOf(row) === "SCHEDULED"
      && !isResultPhase(row, nowMs)
      && hasOfficialHadSp(row)
      && hasDirectionalEvidence(row)
      && !publishedBestDecision(row)
      && !hasPublishedWatchDisposition(row)
    ))
    .map((row) => canonicalId(row) || text(row?.id) || "unknown")
);

const canonicalRecommendationDecision = (match, nowMs = Date.now()) => {
  const selected = isResultPhase(match, nowMs)
    ? archivedDecision(match)
    : (hasOfficialHadSp(match) ? publishedBestDecision(match) : null);
  if (!selected) return null;
  const pool = selected.marketEvidenceScope === "model-only-reference"
    ? canonicalModelOnlyPool(selected.prediction)
    : canonicalPool(selected.prediction);
  return {
    id: canonicalId(match),
    eventVersion: canonicalInstant(match?.eventVersion || match?.kickoffTime),
    source: selected.source,
    oddsPoolCode: pool,
    tipCode: upper(selected.prediction.tipCode),
    handicapLine: canonicalLine(pool, selected.prediction.handicapLine ?? match?.handicapLine),
    odds: canonicalOdds(selected.prediction.odds),
    capturedAt: selected.capturedAt,
    signature: selected.signature,
  };
};

const comparablePoolRows = (match) => {
  const rows = Array.isArray(match?.predictions) ? match.predictions : [];
  return rows
    .filter(validDirection)
    .map((row) => {
      const pool = canonicalPool(row);
      return {
        marketType: upper(row.marketType),
        oddsPoolCode: pool,
        tipCode: upper(row.tipCode),
        handicapLine: canonicalLine(pool, row.handicapLine ?? match?.handicapLine),
        odds: canonicalOdds(row.odds),
        recommendationAction: text(row.recommendationAction) || null,
      };
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
};

const canonicalJson = (value) => JSON.stringify(value);
const compareRecommendationProjectionPair = (listMatch, detailMatch, nowMs = Date.now()) => {
  const listDecision = canonicalRecommendationDecision(listMatch, nowMs);
  const detailDecision = canonicalRecommendationDecision(detailMatch, nowMs);
  const listRequiresDecision = requiresPublicDecision(listMatch, nowMs);
  const detailRequiresDecision = requiresPublicDecision(detailMatch, nowMs);
  const listHadSupportingDirectionConflicts = publicHadSupportingDirectionConflicts(listMatch, nowMs).length;
  const detailHadSupportingDirectionConflicts = publicHadSupportingDirectionConflicts(detailMatch, nowMs).length;
  const reasons = [];
  if (listRequiresDecision !== detailRequiresDecision) reasons.push("official-sp-availability-mismatch");
  if (!listDecision && (listRequiresDecision || Boolean(detailDecision))) reasons.push("list-canonical-decision-missing");
  if (!detailDecision && (detailRequiresDecision || Boolean(listDecision))) reasons.push("detail-canonical-decision-missing");
  if (listDecision && detailDecision && canonicalJson(listDecision) !== canonicalJson(detailDecision)) {
    reasons.push("canonical-decision-mismatch");
  }
  const listPoolRows = comparablePoolRows(listMatch);
  const detailPoolRows = comparablePoolRows(detailMatch);
  if (canonicalJson(listPoolRows) !== canonicalJson(detailPoolRows)) {
    reasons.push("had-hhad-projection-mismatch");
  }
  if (listHadSupportingDirectionConflicts > 0) reasons.push("list-had-supporting-direction-conflict");
  if (detailHadSupportingDirectionConflicts > 0) reasons.push("detail-had-supporting-direction-conflict");
  if (canonicalId(listMatch) !== canonicalId(detailMatch)) reasons.push("match-identity-mismatch");
  return {
    ok: reasons.length === 0,
    id: canonicalId(listMatch) || canonicalId(detailMatch) || "unknown",
    reasons,
    listDecision,
    detailDecision,
    listPoolRows,
    detailPoolRows,
    listHadSupportingDirectionConflicts,
    detailHadSupportingDirectionConflicts,
  };
};

const buildRecommendationProjectionParityAudit = (pairs, {
  nowMs = Date.now(),
} = {}) => {
  const rows = Array.isArray(pairs) ? pairs : [];
  let preMatchRows = 0;
  let resultPhaseRows = 0;
  let comparableRows = 0;
  let listCanonicalMissingRows = 0;
  let detailCanonicalMissingRows = 0;
  let canonicalDecisionMismatchRows = 0;
  let hadHhadProjectionMismatchRows = 0;
  let listHadSupportingDirectionConflictRows = 0;
  let detailHadSupportingDirectionConflictRows = 0;
  let identityMismatchRows = 0;
  let mismatchRows = 0;

  for (const pair of rows) {
    const listMatch = pair?.listMatch ?? pair?.list ?? null;
    const detailMatch = pair?.detailMatch ?? pair?.detail ?? null;
    const phaseMatch = detailMatch || listMatch;
    if (isResultPhase(phaseMatch, nowMs)) resultPhaseRows += 1;
    else preMatchRows += 1;
    const comparison = compareRecommendationProjectionPair(listMatch, detailMatch, nowMs);
    if (comparison.listDecision && comparison.detailDecision) comparableRows += 1;
    if (!comparison.listDecision && requiresPublicDecision(listMatch, nowMs)) {
      listCanonicalMissingRows += 1;
    }
    if (!comparison.detailDecision && requiresPublicDecision(detailMatch, nowMs)) {
      detailCanonicalMissingRows += 1;
    }
    if (comparison.reasons.includes("canonical-decision-mismatch")) canonicalDecisionMismatchRows += 1;
    if (comparison.reasons.includes("had-hhad-projection-mismatch")) hadHhadProjectionMismatchRows += 1;
    if (comparison.reasons.includes("list-had-supporting-direction-conflict")) {
      listHadSupportingDirectionConflictRows += 1;
    }
    if (comparison.reasons.includes("detail-had-supporting-direction-conflict")) {
      detailHadSupportingDirectionConflictRows += 1;
    }
    if (comparison.reasons.includes("match-identity-mismatch")) identityMismatchRows += 1;
    if (!comparison.ok) mismatchRows += 1;
  }

  return {
    version: VERSION,
    scope: "same-current-read-model-list-detail-projection",
    disclosure: "aggregate-counts-only",
    checkedRows: rows.length,
    preMatchRows,
    resultPhaseRows,
    comparableRows,
    listCanonicalMissingRows,
    detailCanonicalMissingRows,
    canonicalDecisionMismatchRows,
    hadHhadProjectionMismatchRows,
    listHadSupportingDirectionConflictRows,
    detailHadSupportingDirectionConflictRows,
    identityMismatchRows,
    mismatchRows,
    ok: mismatchRows === 0,
  };
};

module.exports = {
  VERSION,
  archivedDecision,
  buildRecommendationProjectionParityAudit,
  canonicalId,
  canonicalRecommendationDecision,
  comparablePoolRows,
  compareRecommendationProjectionPair,
  hasOfficialHadSp,
  hasDirectionalEvidence,
  isResultPhase,
  isExplicitlyWithheldBest,
  projectPublicPredictionRows,
  publicHadSupportingDirectionConflicts,
  publishedBestDecision,
  scheduledWithoutBestIds,
  storedStatusOf,
  text,
  upper,
  validateArchivedDecision,
};
