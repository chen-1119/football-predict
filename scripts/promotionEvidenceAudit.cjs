const {
  buildPromotionEvidenceManifest,
  buildPromotionEvidenceRecord,
} = require("../src/services/promotionEvidenceManifest.cjs");
const {
  isDecisionClockAuditEligible,
} = require("../src/services/decisionSnapshot.cjs");
const {
  buildResultProvenance,
} = require("../src/services/matchLifecycle.cjs");
const {
  normalizeMarketSourceProvenance,
} = require("../src/services/marketSourceProvenance.cjs");

const PROMOTION_EVIDENCE_AUDIT_VERSION = "promotion-evidence-audit-v2";
const DECISION_SNAPSHOT_VERSION = "candidate-decision-snapshot-v2";
const MARKETS = Object.freeze(["HAD", "HHAD"]);

const rowsFrom = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
};

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const text = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const firstPresent = (...values) => values.find((value) => (
  value !== null && value !== undefined && String(value).trim() !== ""
));

const canonicalInstant = (value) => {
  const explicit = firstPresent(value);
  if (explicit === undefined) return null;
  const millis = Date.parse(String(explicit).trim());
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const canonicalEventVersion = (value) => {
  const explicit = text(value);
  if (!explicit) return null;
  const instant = canonicalInstant(explicit);
  return instant || explicit;
};

const integerScore = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const finishedMatch = (match) => (
  String(match?.status || match?.effectiveStatus || "").toUpperCase() === "FINISHED"
  && integerScore(match?.scoreHome) !== null
  && integerScore(match?.scoreAway) !== null
);

const identityFor = (value) => ({
  matchId: text(value?.decisionSnapshot?.matchId || value?.matchId || value?.id),
  sourceMatchId: text(value?.decisionSnapshot?.sourceMatchId || value?.sourceMatchId),
});

const identitiesMatch = (match, snapshot) => {
  const left = identityFor(match);
  const right = identityFor(snapshot);
  const matchIdComparable = Boolean(left.matchId && right.matchId);
  const sourceIdComparable = Boolean(left.sourceMatchId && right.sourceMatchId);
  if (!matchIdComparable && !sourceIdComparable) return false;
  if (matchIdComparable && left.matchId !== right.matchId) return false;
  if (sourceIdComparable && left.sourceMatchId !== right.sourceMatchId) return false;
  return (matchIdComparable && left.matchId === right.matchId)
    || (sourceIdComparable && left.sourceMatchId === right.sourceMatchId);
};

const isReviewSnapshot = (snapshot) => (
  String(snapshot?.phase || "").toLowerCase() === "review"
  || String(snapshot?.decisionSnapshot?.phase || "").toLowerCase() === "review"
);

const isDecisionSnapshotV2 = (snapshot) => (
  isObject(snapshot?.decisionSnapshot)
  && snapshot.decisionSnapshot.version === DECISION_SNAPSHOT_VERSION
);

const selectionTimes = (_match, snapshot) => {
  const decision = snapshot?.decisionSnapshot || {};
  // Selection must use the same immutable object that will be content-committed
  // into the evidence record. Mutable outer snapshot/match clocks are never an
  // admissible replacement for missing decision-snapshot lineage.
  const capturedAt = canonicalInstant(decision.capturedAt);
  const decisionAt = canonicalInstant(decision.decisionAt);
  const cutoffTime = canonicalInstant(decision.cutoffTime);
  const kickoffTime = canonicalInstant(decision.kickoffTime);
  return {
    capturedAt,
    capturedMs: capturedAt ? Date.parse(capturedAt) : null,
    decisionAt,
    decisionMs: decisionAt ? Date.parse(decisionAt) : null,
    cutoffTime,
    cutoffMs: cutoffTime ? Date.parse(cutoffTime) : null,
    kickoffTime,
    kickoffMs: kickoffTime ? Date.parse(kickoffTime) : null,
  };
};

const selectionState = (match, snapshot) => {
  if (!isDecisionSnapshotV2(snapshot)) return { eligible: false, reason: "not-candidate-decision-snapshot-v2" };
  if (isReviewSnapshot(snapshot)) return { eligible: false, reason: "review-snapshot" };
  const times = selectionTimes(match, snapshot);
  if (![times.capturedMs, times.cutoffMs, times.kickoffMs].every(Number.isFinite)) {
    return { eligible: false, reason: "snapshot-selection-time-unorderable", times };
  }
  const deadlineMs = Math.min(times.cutoffMs, times.kickoffMs);
  if (times.capturedMs > deadlineMs
      || (Number.isFinite(times.decisionMs) && times.decisionMs > deadlineMs)) {
    return { eligible: false, reason: "post-cutoff-snapshot", times };
  }
  return { eligible: true, reason: null, times };
};

const sourceCycleIdFor = (snapshot) => text(firstPresent(
  snapshot?.decisionSnapshot?.sourceCycleId,
  snapshot?.decisionSnapshot?.provenance?.sourceCycleId,
));

const marketPayloadFor = (snapshot, market) => {
  const decision = snapshot?.decisionSnapshot || {};
  const decisionMarket = decision?.markets?.[market] || null;
  const probabilityPayload = decision?.probabilities?.[market] || null;
  const odds = decisionMarket?.odds || null;
  const probabilities = market === "HHAD"
    ? (probabilityPayload?.outcomes || null)
    : probabilityPayload;
  const handicapLine = market === "HAD"
    ? 0
    : firstPresent(decisionMarket?.line);
  return { decisionMarket, probabilityPayload, odds, probabilities, handicapLine };
};

const oddsTimesFor = (marketPayload) => {
  const observedAt = canonicalInstant(marketPayload.decisionMarket?.observedAt);
  const receivedAt = canonicalInstant(marketPayload.decisionMarket?.receivedAt);
  return { observedAt, receivedAt };
};

const resultPayloadFor = (match) => {
  const declared = isObject(match?.resultProvenance) ? match.resultProvenance : {};
  const declaredProvider = text(firstPresent(declared.provider, declared.source));
  const declaredTrustedSporttery = declared.official === true
    && declared.trusted === true
    && String(declaredProvider || "").toLowerCase() === "sporttery";
  // Rebuild the provenance with the lifecycle authority. This rechecks the
  // trusted provider, observation attribution/order and exact event revision.
  const provenance = buildResultProvenance(match);
  const scoreHome = integerScore(match?.scoreHome);
  const scoreAway = integerScore(match?.scoreAway);
  const provenanceHome = provenance?.scoreHome === null || provenance?.scoreHome === undefined
    ? scoreHome
    : integerScore(provenance?.scoreHome);
  const provenanceAway = provenance?.scoreAway === null || provenance?.scoreAway === undefined
    ? scoreAway
    : integerScore(provenance?.scoreAway);
  const provenanceScoresMatch = scoreHome !== null
    && scoreAway !== null
    && provenanceHome === scoreHome
    && provenanceAway === scoreAway;
  const outcomeCode = scoreHome === null || scoreAway === null
    ? null
    : scoreHome > scoreAway ? "1" : scoreHome < scoreAway ? "2" : "X";
  const source = text(firstPresent(provenance?.source, provenance?.provider));
  const resultObservedAt = canonicalInstant(provenance?.observedAt);
  const observationSource = text(provenance?.observationSource);
  const eventVersion = canonicalEventVersion(firstPresent(
    provenance?.eventVersion,
    declared.eventVersion,
    match?.eventVersion,
  ));
  const eventVersionConsistent = provenance?.eventVersionConsistent === true;
  const provenanceValidated = declaredTrustedSporttery
    && provenance?.promotionEligible === true;
  const fallback = provenance?.resultObservationFallback !== false;
  return {
    result: {
      official: provenance?.official === true && provenanceScoresMatch,
      trusted: declaredTrustedSporttery && provenance?.trusted === true,
      provider: text(provenance?.provider),
      provenanceValidated,
      eventVersion,
      eventVersionConsistent,
      status: "FINISHED",
      scoreHome,
      scoreAway,
      outcomeCode,
      source,
    },
    resultObservedAt,
    resultObservationSource: observationSource,
    resultObservationFallback: fallback,
    eventVersion,
  };
};

const evidenceInputFor = (match, snapshot, market, selectedTimes, options = {}) => {
  const decision = snapshot.decisionSnapshot;
  const marketPayload = marketPayloadFor(snapshot, market);
  const oddsTimes = oddsTimesFor(marketPayload);
  const resultPayload = resultPayloadFor(match);
  const marketProvenance = normalizeMarketSourceProvenance(
    marketPayload.decisionMarket?.provenance,
    { trustRegistry: options.collectorTrustRegistry || null },
  );
  return {
    identity: {
      matchId: text(decision.matchId),
      sourceMatchId: text(decision.sourceMatchId),
      eventVersion: resultPayload.eventVersion,
      market,
      handicapLine: marketPayload.handicapLine,
    },
    clocks: {
      capturedAt: selectedTimes.capturedAt,
      decisionAt: canonicalInstant(decision.decisionAt),
      cutoffTime: selectedTimes.cutoffTime,
      kickoffTime: selectedTimes.kickoffTime,
      modelGeneratedAt: canonicalInstant(decision?.sourceTimestamps?.modelGeneratedAt),
      oddsObservedAt: oddsTimes.observedAt,
      oddsReceivedAt: oddsTimes.receivedAt,
      resultObservedAt: resultPayload.resultObservedAt,
      resultObservationSource: resultPayload.resultObservationSource,
      resultObservationFallback: resultPayload.resultObservationFallback,
    },
    provenance: {
      snapshotVersion: text(decision.version),
      policyVersion: text(decision.policyVersion),
      modelVersion: text(decision.modelVersion),
      calibrationVersion: text(decision.calibrationVersion),
      sourceCycleId: sourceCycleIdFor(snapshot),
      phase: text(snapshot?.phase),
      marketProvenanceVersion: marketProvenance?.version || null,
      marketProvenanceHash: marketProvenance?.hash || null,
      collectorAttestationKeyId: marketProvenance?.strict?.collectorAttestationKeyId || null,
      collectorAttestationKeyFingerprint: marketProvenance?.strict?.collectorAttestationKeyFingerprint || null,
      collectorAttestationCommitmentHash: marketProvenance?.strict?.collectorAttestationCommitmentHash || null,
      marketExtractionHash: marketProvenance?.extraction?.hash || null,
      collectorTrustBoundary: marketProvenance?.strict?.trustBoundary || null,
    },
    phase: text(snapshot?.phase),
    decisionClockAuditEligible: isDecisionClockAuditEligible(decision, {
      collectorTrustRegistry: options.collectorTrustRegistry || null,
    }),
    featureSnapshot: snapshot?.featureSnapshot || null,
    decisionSnapshot: decision,
    odds: marketPayload.odds,
    probabilities: marketPayload.probabilities,
    result: resultPayload.result,
  };
};

const countByMarket = (records) => Object.fromEntries(MARKETS.map((market) => {
  const rows = records.filter((record) => record.identity.market === market);
  return [market, {
    rows: rows.length,
    eligible: rows.filter((record) => record.promotionEligible).length,
    rejected: rows.filter((record) => !record.promotionEligible).length,
  }];
}));

function buildPromotionEvidenceAudit({
  matches,
  snapshots,
  generatedAt,
  previousManifestHash = null,
  collectorTrustRegistry = null,
} = {}) {
  const matchRows = rowsFrom(matches);
  const snapshotRows = rowsFrom(snapshots);
  const finishedMatches = matchRows.filter(finishedMatch);
  const selection = {
    snapshotsSeen: snapshotRows.length,
    candidateV2Snapshots: snapshotRows.filter(isDecisionSnapshotV2).length,
    identityCandidateRows: 0,
    reviewRejected: 0,
    postCutoffRejected: 0,
    unorderableRejected: 0,
    nonV2Rejected: 0,
    eligibleCandidateRows: 0,
    selectedLatestRows: 0,
    latestTieGroups: 0,
  };
  const records = [];
  let matchedFinishedMatches = 0;

  for (const match of finishedMatches) {
    const matching = snapshotRows.filter((snapshot) => identitiesMatch(match, snapshot));
    selection.identityCandidateRows += matching.length;
    const eligible = [];
    for (const snapshot of matching) {
      const state = selectionState(match, snapshot);
      if (state.eligible) {
        eligible.push({ snapshot, times: state.times });
        selection.eligibleCandidateRows += 1;
      } else if (state.reason === "review-snapshot") {
        selection.reviewRejected += 1;
      } else if (state.reason === "post-cutoff-snapshot") {
        selection.postCutoffRejected += 1;
      } else if (state.reason === "snapshot-selection-time-unorderable") {
        selection.unorderableRejected += 1;
      } else {
        selection.nonV2Rejected += 1;
      }
    }
    if (!eligible.length) continue;
    matchedFinishedMatches += 1;
    const latestCapturedMs = Math.max(...eligible.map((entry) => entry.times.capturedMs));
    const selected = eligible.filter((entry) => entry.times.capturedMs === latestCapturedMs);
    selection.selectedLatestRows += selected.length;
    if (selected.length > 1) selection.latestTieGroups += 1;
    for (const entry of selected) {
      for (const market of MARKETS) {
        records.push(buildPromotionEvidenceRecord(
          evidenceInputFor(match, entry.snapshot, market, entry.times, { collectorTrustRegistry }),
          { collectorTrustRegistry },
        ));
      }
    }
  }

  const manifest = buildPromotionEvidenceManifest(records, {
    generatedAt,
    previousManifestHash,
    collectorTrustRegistry,
  });
  const officialFinishedMatches = finishedMatches.filter((match) => (
    resultPayloadFor(match).result.provenanceValidated === true
  )).length;
  return {
    version: PROMOTION_EVIDENCE_AUDIT_VERSION,
    generatedAt: manifest.generatedAt,
    records,
    manifest,
    summary: {
      matchesSeen: matchRows.length,
      finishedMatches: finishedMatches.length,
      officialFinishedMatches,
      matchedFinishedMatches,
      unmatchedFinishedMatches: finishedMatches.length - matchedFinishedMatches,
      selection,
      recordRows: records.length,
      eligibleRows: records.filter((record) => record.promotionEligible).length,
      rejectedRows: records.filter((record) => !record.promotionEligible).length,
      byMarket: countByMarket(records),
      blockerCounts: manifest.rejectedByReason,
      conflictingDuplicateKeys: manifest.conflictingDuplicateKeys,
      manifestPromotionEligible: manifest.promotionEligible,
    },
  };
}

module.exports = {
  DECISION_SNAPSHOT_VERSION,
  PROMOTION_EVIDENCE_AUDIT_VERSION,
  buildPromotionEvidenceAudit,
};
