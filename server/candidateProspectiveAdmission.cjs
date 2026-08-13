const normalizeMatchId = (value) => String(value || "")
  .trim()
  .replace(/^sporttery_/, "");

const kickoffMsFor = (value) => {
  const parsed = Date.parse(
    value?.kickoffTime
    || value?.matchDate
    || value?.kickoffAt
    || "",
  );
  return Number.isFinite(parsed) ? parsed : null;
};

const ledgerMatchKey = (value) => {
  const source = normalizeMatchId(value?.sourceMatchId);
  const id = normalizeMatchId(value?.matchId || value?.id);
  const kickoffMs = kickoffMsFor(value);
  const kickoff = Number.isFinite(kickoffMs)
    ? new Date(kickoffMs).toISOString()
    : "unknown";
  return `${source || id}|HAD|${kickoff}`;
};

const activeLedgerFor = (registry) => {
  if (!registry || typeof registry !== "object") return null;
  const ledgers = Array.isArray(registry.ledgers) ? registry.ledgers : [];
  const activeLedgerId = String(registry.activeLedgerId || "");
  return ledgers.find((ledger) => String(ledger?.ledgerId || "") === activeLedgerId)
    || null;
};

const summarizeCandidateProspectiveExclusions = ({
  registry,
  limit = 100,
} = {}) => {
  const ledger = activeLedgerFor(registry);
  if (!ledger) {
    return {
      version: "candidate-prospective-exclusion-audit-v1",
      registryAvailable: false,
      activeLedgerId: null,
      total: 0,
      formal: 0,
      shadow: 0,
      phaseCounts: {},
      blockerCounts: {},
      reasonCounts: {},
      rows: [],
      rowsTruncated: 0,
    };
  }
  const exclusions = (Array.isArray(ledger.events) ? ledger.events : [])
    .filter((event) => event?.type === "exclusion");
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const phaseCounts = {};
  const blockerCounts = {};
  const reasonCounts = {};
  for (const event of exclusions) {
    const phase = String(event?.phase || "unknown");
    phaseCounts[phase] = Number(phaseCounts[phase] || 0) + 1;
    const blockers = Array.isArray(event?.blockers) && event.blockers.length
      ? event.blockers
      : ["exclusion-reason-missing"];
    for (const blocker of [...new Set(blockers.map((value) => String(value || "")))]) {
      const reason = blocker || "exclusion-reason-missing";
      blockerCounts[reason] = Number(blockerCounts[reason] || 0) + 1;
    }
    const primaryReason = String(
      event?.primaryExclusionReason || "exclusion-reason-unclassified",
    );
    reasonCounts[primaryReason] = Number(reasonCounts[primaryReason] || 0) + 1;
  }
  const rows = exclusions
    .slice()
    .sort((left, right) => (
      Date.parse(right?.recordedAt || "") - Date.parse(left?.recordedAt || "")
      || Number(right?.sequence || 0) - Number(left?.sequence || 0)
    ))
    .slice(0, safeLimit)
    .map((event) => ({
      sequence: Number(event?.sequence || 0),
      phase: String(event?.phase || "unknown"),
      matchId: String(event?.matchId || ""),
      sourceMatchId: String(event?.sourceMatchId || ""),
      kickoffAt: event?.kickoffAt || null,
      decisionDeadlineAt: event?.decisionDeadlineAt || null,
      captureFinalizationAt: event?.captureFinalizationAt || null,
      recordedAt: event?.recordedAt || null,
      primaryExclusionReason: event?.primaryExclusionReason || null,
      marketState: event?.marketState || null,
      officialHadMarketPresent:
        typeof event?.officialHadMarketPresent === "boolean"
          ? event.officialHadMarketPresent
          : null,
      strictOfficialMarketEvidenceComplete:
        typeof event?.strictOfficialMarketEvidenceComplete === "boolean"
          ? event.strictOfficialMarketEvidenceComplete
          : null,
      hhadCompanionEvidenceComplete:
        typeof event?.hhadCompanionEvidenceComplete === "boolean"
          ? event.hhadCompanionEvidenceComplete
          : null,
      blockers: Array.isArray(event?.blockers)
        ? [...new Set(event.blockers.map((value) => String(value || "")))]
          .filter(Boolean)
          .slice(0, 32)
        : [],
    }));
  return {
    version: "candidate-prospective-exclusion-audit-v1",
    registryAvailable: true,
    activeLedgerId: String(ledger.ledgerId || ""),
    total: exclusions.length,
    formal: Number(phaseCounts.formal || 0),
    shadow: Number(phaseCounts["pre-gate-shadow"] || 0),
    phaseCounts: Object.fromEntries(
      Object.entries(phaseCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    blockerCounts: Object.fromEntries(
      Object.entries(blockerCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    reasonCounts: Object.fromEntries(
      Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    rows,
    rowsTruncated: Math.max(0, exclusions.length - rows.length),
  };
};

const emptySummary = ({
  evaluatedAt = null,
  registryAvailable = false,
  expectedRows = 0,
} = {}) => ({
  version: "candidate-prospective-admission-summary-v1",
  evaluatedAt,
  registryAvailable,
  expectedRows,
  auditMode: "none",
  auditedRows: 0,
  admitted: 0,
  excluded: 0,
  pendingDeadline: 0,
  dueUnrecorded: 0,
  readyAlreadyAdmitted: 0,
  readyPendingDeadline: 0,
  readyDueUnrecorded: 0,
  unreconciled: expectedRows,
  captureGap: false,
  reconciled: registryAvailable && expectedRows === 0,
});

const nonNegativeInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};

const summarizeTruncatedReadinessFromBatches = ({
  readiness,
  expectedRows,
  evaluatedAt,
}) => {
  const batches = Array.isArray(readiness?.deadlineBatches)
    ? readiness.deadlineBatches
    : [];
  if (!batches.length) return null;
  const counts = {
    admitted: 0,
    excluded: 0,
    pendingDeadline: 0,
    dueUnrecorded: 0,
    readyAlreadyAdmitted: 0,
    readyPendingDeadline: 0,
    readyDueUnrecorded: 0,
    unreconciled: 0,
  };
  let auditedRows = 0;
  for (const batch of batches) {
    const total = nonNegativeInteger(batch?.totalMatches);
    const ready = nonNegativeInteger(batch?.readyNow);
    const terminalDecisions = nonNegativeInteger(batch?.terminalDecisions);
    const terminalExclusions = nonNegativeInteger(batch?.terminalExclusions);
    const dueUnrecorded = nonNegativeInteger(batch?.dueUnrecorded);
    const readyDueUnrecorded = nonNegativeInteger(
      batch?.readyDueUnrecorded,
    );
    const duplicateTerminalEvents = nonNegativeInteger(
      batch?.duplicateTerminalEvents,
    );
    const terminalKeysWithDuplicates = nonNegativeInteger(
      batch?.terminalKeysWithDuplicates,
    );
    const phaseValid = [
      "upcoming",
      "finalization-grace",
      "post-finalization",
      "deadline-missing",
    ].includes(batch?.phase);
    if (
      total === null
      || ready === null
      || terminalDecisions === null
      || terminalExclusions === null
      || dueUnrecorded === null
      || readyDueUnrecorded === null
      || duplicateTerminalEvents !== 0
      || terminalKeysWithDuplicates !== 0
      || batch?.invariantOk !== true
      || !phaseValid
      || terminalDecisions + terminalExclusions + dueUnrecorded > total
      || readyDueUnrecorded > dueUnrecorded
      || terminalDecisions + readyDueUnrecorded > ready
    ) {
      return null;
    }
    const pendingDeadline =
      total - terminalDecisions - terminalExclusions - dueUnrecorded;
    const readyPendingDeadline =
      ready - terminalDecisions - readyDueUnrecorded;
    auditedRows += total;
    counts.admitted += terminalDecisions;
    counts.excluded += terminalExclusions;
    counts.pendingDeadline += pendingDeadline;
    counts.dueUnrecorded += dueUnrecorded;
    counts.readyAlreadyAdmitted += terminalDecisions;
    counts.readyPendingDeadline += readyPendingDeadline;
    counts.readyDueUnrecorded += readyDueUnrecorded;
  }
  if (auditedRows !== expectedRows) return null;
  return {
    version: "candidate-prospective-admission-summary-v1",
    evaluatedAt,
    registryAvailable: true,
    expectedRows,
    auditMode: "deadline-batch-aggregate",
    auditedRows,
    ...counts,
    captureGap: counts.dueUnrecorded > 0,
    reconciled: counts.unreconciled === 0,
  };
};

const summarizeCandidateProspectiveAdmission = ({
  readiness,
  registry,
} = {}) => {
  const rows = Array.isArray(readiness?.rows) ? readiness.rows : [];
  const expectedRows = Math.max(0, Number(readiness?.upcomingMatches || rows.length));
  const evaluatedAt = readiness?.evaluatedAt || null;
  const evaluatedAtMs = Date.parse(evaluatedAt || "");
  const ledger = activeLedgerFor(registry);
  if (!ledger) {
    return emptySummary({
      evaluatedAt,
      registryAvailable: false,
      expectedRows,
    });
  }
  if (rows.length < expectedRows) {
    const aggregate = summarizeTruncatedReadinessFromBatches({
      readiness,
      expectedRows,
      evaluatedAt,
    });
    if (aggregate) return aggregate;
  }

  const terminalEvents = new Map(
    (Array.isArray(ledger.events) ? ledger.events : [])
      .filter((event) => event?.type === "decision" || event?.type === "exclusion")
      .map((event) => [ledgerMatchKey(event), event]),
  );
  const counts = {
    admitted: 0,
    excluded: 0,
    pendingDeadline: 0,
    dueUnrecorded: 0,
    readyAlreadyAdmitted: 0,
    readyPendingDeadline: 0,
    readyDueUnrecorded: 0,
    unreconciled: 0,
  };

  for (const row of rows) {
    const event = terminalEvents.get(ledgerMatchKey(row));
    const ready = row?.status === "ready-now";
    if (event?.type === "decision") {
      counts.admitted += 1;
      if (ready) counts.readyAlreadyAdmitted += 1;
      continue;
    }
    if (event?.type === "exclusion") {
      counts.excluded += 1;
      continue;
    }

    const deadlineMs = Date.parse(row?.decisionDeadlineAt || "");
    const finalizationMs = Date.parse(
      row?.captureFinalizationAt
      || row?.decisionDeadlineAt
      || "",
    );
    if (
      !Number.isFinite(evaluatedAtMs)
      || !Number.isFinite(deadlineMs)
      || !Number.isFinite(finalizationMs)
    ) {
      counts.unreconciled += 1;
      continue;
    }
    if (evaluatedAtMs < finalizationMs) {
      counts.pendingDeadline += 1;
      if (ready) counts.readyPendingDeadline += 1;
      continue;
    }
    counts.dueUnrecorded += 1;
    if (ready) counts.readyDueUnrecorded += 1;
  }

  const auditedRows = rows.length;
  const classifiedRows = counts.admitted
    + counts.excluded
    + counts.pendingDeadline
    + counts.dueUnrecorded
    + counts.unreconciled;
  return {
    version: "candidate-prospective-admission-summary-v1",
    evaluatedAt,
    registryAvailable: true,
    expectedRows,
    auditMode: "detailed-rows",
    auditedRows,
    ...counts,
    captureGap: counts.dueUnrecorded > 0,
    reconciled: auditedRows === expectedRows
      && classifiedRows === auditedRows
      && counts.unreconciled === 0,
  };
};

module.exports = {
  activeLedgerFor,
  ledgerMatchKey,
  summarizeCandidateProspectiveAdmission,
  summarizeCandidateProspectiveExclusions,
};
