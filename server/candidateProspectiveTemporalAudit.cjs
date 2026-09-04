"use strict";

const {
  buildResultProvenance,
  canonicalSourceMatchId,
  eventVersionOf,
  isOfficialSportteryFinal,
  isOfficialSportteryVoid,
} = require("../src/services/matchLifecycle.cjs");

const VERSION = "candidate-prospective-temporal-audit-v1";

const parseTime = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const isoTime = (value) => {
  const parsed = parseTime(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};

const identityValues = (value) => new Set([
  value?.id,
  value?.matchId,
  value?.sourceMatchId,
  String(value?.id || "").replace(/^sporttery_/, ""),
  String(value?.matchId || "").replace(/^sporttery_/, ""),
  String(value?.sourceMatchId || "").replace(/^sporttery_/, ""),
].map((item) => String(item || "").trim()).filter(Boolean));

const identitiesMatch = (left, right) => {
  const leftValues = identityValues(left);
  const rightValues = identityValues(right);
  return [...leftValues].some((value) => rightValues.has(value));
};

const kickoffFor = (value) => isoTime(
  value?.kickoffAt
  || value?.kickoffTime
  || value?.matchDate
  || value?.kickoff,
);

const resultEvidenceBlockersForDecision = (match, decision) => {
  const blockers = [];
  if (!isOfficialSportteryFinal(match)) {
    blockers.push("not-official-sporttery-final");
  }
  const provenance = buildResultProvenance(match);
  const provider = String(provenance?.provider || "").toLowerCase();
  const observedAt = isoTime(provenance?.observedAt);
  const kickoffAt = kickoffFor(match);
  const matchSourceId = canonicalSourceMatchId(
    match?.sourceMatchId ?? match?.matchId ?? match?.id,
  );
  const decisionSourceId = canonicalSourceMatchId(
    decision?.sourceMatchId ?? decision?.matchId,
  );
  const resultSourceId = canonicalSourceMatchId(provenance?.sourceMatchId);
  const matchEventVersion = eventVersionOf(match);
  const resultEventVersion = eventVersionOf({
    eventVersion: provenance?.eventVersion,
    kickoffTime: provenance?.kickoffTime,
  });
  if (!provenance) blockers.push("result-provenance-missing");
  if (provider !== "sporttery") blockers.push("result-provider-not-sporttery");
  if (provenance?.official !== true) blockers.push("result-not-official");
  if (provenance?.trusted !== true) blockers.push("result-not-trusted");
  if (provenance?.promotionEligible !== true) {
    blockers.push("result-promotion-ineligible");
  }
  if (provenance?.resultObservationFallback !== false) {
    blockers.push("result-observation-fallback");
  }
  if (provenance?.eventVersionConsistent !== true) {
    blockers.push("result-event-version-inconsistent");
  }
  if (!matchSourceId) blockers.push("match-source-id-missing");
  if (decisionSourceId !== matchSourceId) {
    blockers.push("decision-source-id-mismatch");
  }
  if (resultSourceId !== matchSourceId) {
    blockers.push("result-source-id-mismatch");
  }
  if (!matchEventVersion) blockers.push("match-event-version-missing");
  if (resultEventVersion !== matchEventVersion) {
    blockers.push("result-event-version-mismatch");
  }
  if (kickoffAt !== kickoffFor(decision)) {
    blockers.push("result-kickoff-mismatch");
  }
  if (!observedAt) {
    blockers.push("result-observed-at-missing");
  } else if (parseTime(observedAt) < parseTime(kickoffAt)) {
    blockers.push("result-observed-before-kickoff");
  }
  if (
    !Number.isInteger(match?.scoreHome)
    || !Number.isInteger(match?.scoreAway)
  ) {
    blockers.push("result-score-invalid");
  }
  if (
    provenance?.scoreHome !== match?.scoreHome
    || provenance?.scoreAway !== match?.scoreAway
  ) {
    blockers.push("result-provenance-score-mismatch");
  }
  return [...new Set(blockers)];
};

const resultEvidenceEligibleForDecision = (match, decision) => (
  resultEvidenceBlockersForDecision(match, decision).length === 0
);

const matchRank = (match, decision) => {
  const status = String(match?.effectiveStatus || match?.status || "").toUpperCase();
  const statusRank = resultEvidenceEligibleForDecision(match, decision)
    ? 5
    : isOfficialSportteryFinal(match)
      ? 4
      : status === "FINISHED"
        ? 3
        : status === "PENDING_RESULT"
          ? 2
          : status === "LIVE"
            ? 1
            : 0;
  const observedAt = Math.max(
    parseTime(match?.resultProvenance?.observedAt) || 0,
    parseTime(match?.resultObservedAt) || 0,
    parseTime(match?.updatedAt) || 0,
  );
  return statusRank * 10 ** 15 + observedAt;
};

const matchingReadModelRow = (matches, decision) => (Array.isArray(matches) ? matches : [])
  .filter((match) => (
    identitiesMatch(match, decision)
    && kickoffFor(match) === kickoffFor(decision)
  ))
  .sort((left, right) => (
    matchRank(right, decision) - matchRank(left, decision)
  ))[0]
  || null;

const extrema = (values) => {
  const parsed = values
    .map((value) => isoTime(value))
    .filter(Boolean)
    .sort();
  return {
    earliest: parsed[0] || null,
    latest: parsed.at(-1) || null,
  };
};

const diagnosticLimitFor = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0
    ? Math.min(number, 200)
    : 50;
};

const buildCandidateProspectiveTemporalAudit = ({
  registry = null,
  matches = [],
  evaluatedAt = new Date().toISOString(),
  includeDiagnostics = false,
  diagnosticLimit = 50,
} = {}) => {
  const checkedAt = isoTime(evaluatedAt) || new Date().toISOString();
  const checkedAtMs = parseTime(checkedAt);
  const diagnostics = [];
  const diagnosticsLimit = diagnosticLimitFor(diagnosticLimit);
  let diagnosticsTruncated = 0;
  const appendDiagnostic = ({
    decision,
    match = null,
    classification,
    blockers = [],
  }) => {
    if (!includeDiagnostics) return;
    if (diagnostics.length >= diagnosticsLimit) {
      diagnosticsTruncated += 1;
      return;
    }
    const provenance = match ? buildResultProvenance(match) : null;
    diagnostics.push({
      decisionEventHash: decision?.eventHash || null,
      matchId: decision?.matchId || null,
      sourceMatchId: decision?.sourceMatchId || null,
      kickoffAt: kickoffFor(decision),
      classification,
      status: match
        ? String(match?.effectiveStatus || match?.status || "").toUpperCase()
        : null,
      scoreHome: Number.isInteger(match?.scoreHome) ? match.scoreHome : null,
      scoreAway: Number.isInteger(match?.scoreAway) ? match.scoreAway : null,
      resultProvider: provenance?.provider || null,
      resultObservedAt: isoTime(provenance?.observedAt),
      resultPromotionEligible: provenance?.promotionEligible === true,
      blockers: [...new Set(blockers)].sort(),
    });
  };
  const ledger = registry?.ledgers?.find(
    (entry) => entry?.ledgerId === registry?.activeLedgerId,
  ) || null;
  if (!ledger || !Array.isArray(ledger.events)) {
    return {
      version: VERSION,
      evaluatedAt: checkedAt,
      activeLedgerPresent: false,
      admittedRows: 0,
      settledRows: 0,
      pendingRows: 0,
      futureKickoffRows: 0,
      kickoffPassedRows: 0,
      awaitingOfficialFinalRows: 0,
      officialVoidRows: 0,
      officialResultRecordMissingRows: 0,
      officialFinishedIneligibleRows: 0,
      officialFinishedIneligibleReasonCounts: {},
      officialFinishedIneligiblePrimaryReasonCounts: {},
      officialFinishedEligibleUnsettledRows: 0,
      invalidKickoffRows: 0,
      settlementWorkerAttentionRequired: false,
      denominatorReconciled: true,
      pendingKickoffRange: { earliest: null, latest: null },
      ...(includeDiagnostics ? {
        diagnosticRows: diagnostics,
        diagnosticRowsTruncated: diagnosticsTruncated,
      } : {}),
    };
  }

  const decisions = ledger.events.filter(
    (event) => event?.type === "decision" && event?.phase === "formal",
  );
  const settledDecisionHashes = new Set(
    ledger.events
      .filter((event) => event?.type === "settlement" && event?.phase === "formal")
      .map((event) => event?.decisionEventHash)
      .filter(Boolean),
  );
  const pending = decisions.filter((decision) => (
    !settledDecisionHashes.has(decision.eventHash)
  ));
  const counts = {
    futureKickoffRows: 0,
    kickoffPassedRows: 0,
    awaitingOfficialFinalRows: 0,
    officialVoidRows: 0,
    officialResultRecordMissingRows: 0,
    officialFinishedIneligibleRows: 0,
    officialFinishedEligibleUnsettledRows: 0,
    invalidKickoffRows: 0,
  };
  const officialFinishedIneligibleReasonCounts = {};
  const officialFinishedIneligiblePrimaryReasonCounts = {};

  for (const decision of pending) {
    const kickoffAt = kickoffFor(decision);
    const kickoffAtMs = parseTime(kickoffAt);
    if (kickoffAtMs === null) {
      counts.invalidKickoffRows += 1;
      appendDiagnostic({
        decision,
        classification: "invalid-kickoff",
        blockers: ["decision-kickoff-invalid"],
      });
      continue;
    }
    if (kickoffAtMs > checkedAtMs) {
      counts.futureKickoffRows += 1;
      appendDiagnostic({
        decision,
        classification: "future-kickoff",
      });
      continue;
    }
    counts.kickoffPassedRows += 1;
    const match = matchingReadModelRow(matches, decision);
    if (!match) {
      counts.officialResultRecordMissingRows += 1;
      appendDiagnostic({
        decision,
        classification: "read-model-row-missing",
        blockers: ["candidate-settlement-read-model-row-missing"],
      });
      continue;
    }
    if (isOfficialSportteryVoid(match)) {
      counts.officialVoidRows += 1;
      appendDiagnostic({
        decision,
        match,
        classification: "official-void",
      });
      continue;
    }
    const status = String(
      match?.effectiveStatus || match?.status || "",
    ).toUpperCase();
    if (status !== "FINISHED") {
      counts.awaitingOfficialFinalRows += 1;
      appendDiagnostic({
        decision,
        match,
        classification: "awaiting-official-final",
      });
      continue;
    }
    const evidenceBlockers = resultEvidenceBlockersForDecision(match, decision);
    if (evidenceBlockers.length === 0) {
      counts.officialFinishedEligibleUnsettledRows += 1;
      appendDiagnostic({
        decision,
        match,
        classification: "official-finished-eligible-unsettled",
      });
    } else {
      counts.officialFinishedIneligibleRows += 1;
      appendDiagnostic({
        decision,
        match,
        classification: "official-finished-ineligible",
        blockers: evidenceBlockers,
      });
      for (const blocker of evidenceBlockers) {
        officialFinishedIneligibleReasonCounts[blocker] =
          Number(officialFinishedIneligibleReasonCounts[blocker] || 0) + 1;
      }
      const primaryReason = evidenceBlockers[0];
      officialFinishedIneligiblePrimaryReasonCounts[primaryReason] =
        Number(
          officialFinishedIneligiblePrimaryReasonCounts[primaryReason] || 0,
        ) + 1;
    }
  }

  const settledRows = decisions.filter((decision) => (
    settledDecisionHashes.has(decision.eventHash)
  )).length;
  return {
    version: VERSION,
    evaluatedAt: checkedAt,
    activeLedgerPresent: true,
    admittedRows: decisions.length,
    settledRows,
    pendingRows: pending.length,
    ...counts,
    officialFinishedIneligibleReasonCounts:
      officialFinishedIneligibleReasonCounts,
    officialFinishedIneligiblePrimaryReasonCounts:
      officialFinishedIneligiblePrimaryReasonCounts,
    settlementWorkerAttentionRequired:
      counts.officialFinishedEligibleUnsettledRows > 0,
    denominatorReconciled: decisions.length === settledRows + pending.length,
    pendingKickoffRange: extrema(pending.map((decision) => decision.kickoffAt)),
    ...(includeDiagnostics ? {
      diagnosticRows: diagnostics,
      diagnosticRowsTruncated: diagnosticsTruncated,
    } : {}),
  };
};

module.exports = {
  VERSION,
  buildCandidateProspectiveTemporalAudit,
  resultEvidenceBlockersForDecision,
  resultEvidenceEligibleForDecision,
};
