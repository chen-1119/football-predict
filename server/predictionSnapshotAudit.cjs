const compactPredictionSnapshotAudit = (row) => {
  const decision = row?.decisionSnapshot && typeof row.decisionSnapshot === "object"
    ? row.decisionSnapshot
    : null;
  const compactMarket = (market) => {
    const value = decision?.markets?.[market];
    if (!value || typeof value !== "object") return null;
    const provenance = value.provenance && typeof value.provenance === "object"
      ? value.provenance
      : null;
    const marketClock = decision?.clockAudit?.markets?.[market];
    const provenanceEligible = marketClock?.provenanceEligible === true
      || provenance?.strict?.eligible === true;
    return {
      odds: value.odds || null,
      observedAt: value.observedAt || provenance?.observedAt || null,
      receivedAt: value.receivedAt || provenance?.receivedAt || null,
      sourceCycleId: provenance?.sourceCycleId || decision?.sourceCycleId || null,
      provenanceHash: value.provenanceHash || provenance?.hash || null,
      verificationStatus: provenance?.verificationStatus || null,
      provenanceEligible,
      decisionEligible: decision?.clockAudit?.eligible === true && provenanceEligible,
    };
  };
  const had = compactMarket("HAD");
  const hhad = compactMarket("HHAD");
  return {
    matchId: row?.matchId || decision?.matchId || null,
    sourceMatchId: row?.sourceMatchId || decision?.sourceMatchId || null,
    eventVersion: row?.eventVersion || null,
    decisionId: row?.decisionId || null,
    publicReferenceHash: row?.publicReferenceHash || null,
    publicReferenceEvidenceHash: row?.publicReferenceEvidenceHash || null,
    phase: row?.phase || decision?.phase || null,
    capturedAt: row?.capturedAt || decision?.capturedAt || null,
    firstSeenAt: row?.firstSeenAt || null,
    lastSeenAt: row?.lastSeenAt || null,
    decisionSnapshotVersion: row?.decisionSnapshotVersion || decision?.version || null,
    decisionAt: decision?.decisionAt || row?.decisionAt || null,
    cutoffTime: decision?.cutoffTime || row?.cutoffTime || null,
    kickoffTime: decision?.kickoffTime || row?.kickoffTime || null,
    sourceCycleId: decision?.sourceCycleId || row?.sourceCycleId || null,
    policyVersion: decision?.policyVersion || row?.policyVersion || null,
    policyHash: decision?.policyHash || null,
    modelVersion: decision?.modelVersion || row?.modelVersion || null,
    calibrationVersion: decision?.calibrationVersion || row?.calibrationVersion || null,
    featureSnapshotHash: decision?.featureSnapshotHash
      || row?.featureSnapshotHash
      || row?.featureSnapshot?.hash
      || null,
    selectedCandidateKey: decision?.selectedCandidateKey || null,
    probabilities: decision?.probabilities || null,
    markets: { HAD: had, HHAD: hhad },
    clockAudit: decision?.clockAudit || null,
    atomicEvidencePresent: Boolean(
      decision?.version
      && decision?.decisionAt
      && decision?.sourceCycleId
      && (decision?.featureSnapshotHash || row?.featureSnapshotHash || row?.featureSnapshot?.hash)
      && decision?.policyVersion
      && decision?.probabilities
      && (had || hhad)
    ),
  };
};

module.exports = {
  compactPredictionSnapshotAudit,
};
